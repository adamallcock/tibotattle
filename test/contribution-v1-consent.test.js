import test from "node:test";
import assert from "node:assert/strict";

import {
  createLocalIncrementalContributionSyncContext,
} from "../src/application/local-incremental-contribution-sync.js";

const ORIGIN = "https://usage.example";
const SETTINGS_FILE = "/state/private/incremental-contribution-sync-v1.json";

function fakeStorage(files = new Map()) {
  return {
    files,
    readSettingsText: async ({ settingsFile }) => files.get(settingsFile) ?? null,
    writeSettingsText: async ({ settingsFile, text }) => {
      files.set(settingsFile, text);
    },
  };
}

function runOutcome(overrides = {}) {
  return {
    schemaVersion: "incremental-contribution-sync-run-v1.0",
    status: "complete",
    daysTotal: 2,
    daysSynced: 2,
    daysPending: 0,
    chunksUploaded: 2,
    chunksSkipped: 0,
    recordsUploaded: 3,
    acknowledgedThroughDay: "2026-08-02",
    orphanChunkIds: [],
    failure: null,
    networkActivity: true,
    ...overrides,
  };
}

function harness({
  destinationOrigin = ORIGIN,
  storage = fakeStorage(),
  outcomes = [],
} = {}) {
  let clock = Date.parse("2026-08-03T00:00:00.000Z");
  const runs = [];
  const context = createLocalIncrementalContributionSyncContext({ storage });
  const controller = context.createIncrementalContributionSyncController({
    settingsFile: SETTINGS_FILE,
    destinationOrigin,
    runner: async ({ signal }) => {
      assert.equal(signal instanceof AbortSignal, true);
      runs.push(clock);
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return next ?? runOutcome();
    },
    now: () => new Date(clock),
    ditherRandom: () => 0,
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  });
  return {
    controller,
    storage,
    runs,
    advance(milliseconds) {
      clock += milliseconds;
    },
    nowIso() {
      return new Date(clock).toISOString();
    },
  };
}

test("nothing syncs before the approve-once consent is recorded", async () => {
  const { controller, runs } = harness();
  await controller.start();
  await controller.runDue();
  assert.equal(runs.length, 0);
  const status = await controller.inspect();
  assert.equal(status.consent.approved, false);
  assert.equal(status.consent.current, false);
  assert.equal(status.nextAttemptAt, null);
  assert.equal(status.progress, null);
});

test("approval records the exact v1.0 consent once and syncing runs without further action", async () => {
  const { controller, storage, runs, advance, nowIso } = harness();
  await controller.start();
  const approvedAt = nowIso();
  const approved = await controller.approve();
  assert.equal(approved.consent.approved, true);
  assert.equal(approved.consent.current, true);
  assert.equal(approved.consent.consentedAt, approvedAt);
  assert.equal(approved.nextAttemptAt, approvedAt);
  const persisted = JSON.parse(storage.files.get(SETTINGS_FILE));
  assert.deepEqual(persisted.consent, {
    consentedAt: approvedAt,
    destinationOrigin: ORIGIN,
    telemetrySchemaVersion: "telemetry-contribution-v1.0",
    fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
    privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
  });

  const afterRun = await controller.runDue();
  assert.equal(runs.length, 1);
  assert.equal(afterRun.lastOutcome.code, "synced");
  assert.equal(afterRun.lastOutcome.status, "succeeded");
  assert.deepEqual(afterRun.progress, {
    daysTotal: 2,
    daysSynced: 2,
    daysPending: 0,
    chunksUploaded: 2,
    acknowledgedThroughDay: "2026-08-02",
  });
  // Daily-or-finer: the next pass is one six-hour interval away.
  assert.equal(
    Date.parse(afterRun.nextAttemptAt) - Date.parse(afterRun.lastAttemptAt),
    6 * 60 * 60 * 1_000,
  );

  // Batches never re-prompt: the second due run needs no further approval.
  advance(6 * 60 * 60 * 1_000);
  await controller.runDue();
  assert.equal(runs.length, 2);
});

test("a bounded partial pass continues within a minute instead of waiting a cycle", async () => {
  const { controller, advance } = harness({
    outcomes: [runOutcome({
      status: "partial",
      daysSynced: 1,
      daysPending: 1,
      chunksUploaded: 60,
    })],
  });
  await controller.start();
  await controller.approve();
  const status = await controller.runDue();
  assert.equal(status.lastOutcome.code, "partial_progress");
  assert.equal(status.lastOutcome.status, "partial");
  assert.equal(
    Date.parse(status.nextAttemptAt) - Date.parse(status.lastAttemptAt),
    60_000,
  );
  assert.equal(status.progress.daysPending, 1);
  advance(60_000);
});

test("an exhausted admission budget backs off to the service's next window", async () => {
  const { controller } = harness({
    outcomes: [runOutcome({
      status: "failed",
      daysSynced: 1,
      daysPending: 1,
      chunksUploaded: 40,
      failure: {
        code: "admission_exhausted",
        retryable: true,
        deviceUnavailable: false,
        retryAfterMilliseconds: 12 * 60 * 60 * 1_000,
      },
    })],
  });
  await controller.start();
  await controller.approve();
  const status = await controller.runDue();
  assert.equal(status.paused, false);
  assert.equal(status.lastOutcome.code, "admission_exhausted");
  assert.equal(
    Date.parse(status.nextAttemptAt) - Date.parse(status.lastAttemptAt),
    12 * 60 * 60 * 1_000,
  );
});

test("device_unavailable auto-pauses exactly like the v0.1 queue, until resumed", async () => {
  const { controller, runs, advance } = harness({
    outcomes: [runOutcome({
      status: "failed",
      daysSynced: 0,
      daysPending: 2,
      chunksUploaded: 0,
      failure: {
        code: "device_unavailable",
        retryable: false,
        deviceUnavailable: true,
        retryAfterMilliseconds: null,
      },
    })],
  });
  await controller.start();
  await controller.approve();
  const paused = await controller.runDue();
  assert.equal(paused.paused, true);
  assert.equal(paused.pausedReason, "device_unavailable");
  assert.equal(paused.nextAttemptAt, null);

  // Paused means paused: nothing runs, however overdue.
  advance(24 * 60 * 60 * 1_000);
  await controller.runDue();
  assert.equal(runs.length, 1);

  // The pairing cure resumes the schedule; consent is NOT re-asked.
  const resumed = await controller.resume();
  assert.equal(resumed.paused, false);
  assert.equal(resumed.consent.current, true);
  await controller.runDue();
  assert.equal(runs.length, 2);
});

test("retryable failures back off exponentially and reset on success", async () => {
  const { controller, advance } = harness({
    outcomes: [
      runOutcome({
        status: "failed",
        daysSynced: 0,
        daysPending: 2,
        chunksUploaded: 0,
        failure: {
          code: "service_unavailable",
          retryable: true,
          deviceUnavailable: false,
          retryAfterMilliseconds: null,
        },
      }),
      runOutcome(),
    ],
  });
  await controller.start();
  await controller.approve();
  const failed = await controller.runDue();
  assert.equal(failed.paused, false);
  assert.equal(failed.lastOutcome.code, "service_unavailable");
  // First retry: initial 5 s backoff at the deterministic 0.75 jitter floor.
  assert.equal(
    Date.parse(failed.nextAttemptAt) - Date.parse(failed.lastAttemptAt),
    3_750,
  );
  advance(3_750);
  const recovered = await controller.runDue();
  assert.equal(recovered.lastOutcome.code, "synced");
});

test("consent recorded for another destination is not current here, and halts sync", async () => {
  const storage = fakeStorage();
  const other = harness({
    destinationOrigin: "https://other.example",
    storage,
  });
  await other.controller.start();
  await other.controller.approve();
  await other.controller.stop();

  const { controller, runs, advance } = harness({ storage });
  await controller.start();
  const status = await controller.inspect();
  assert.equal(status.consent.approved, true);
  assert.equal(status.consent.current, false);
  advance(24 * 60 * 60 * 1_000);
  await controller.runDue();
  assert.equal(runs.length, 0);
});

test("consent survives a restart: the schedule resumes with no user action", async () => {
  const storage = fakeStorage();
  const first = harness({ storage });
  await first.controller.start();
  await first.controller.approve();
  await first.controller.runDue();
  assert.equal(first.runs.length, 1);
  await first.controller.stop();

  const second = harness({ storage });
  await second.controller.start();
  const status = await second.controller.inspect();
  assert.equal(status.consent.current, true);
  assert.equal(status.progress.daysTotal, 2);
  second.advance(7 * 60 * 60 * 1_000);
  await second.controller.runDue();
  assert.equal(second.runs.length, 1);
});

test("approval without a configured destination fails closed", async () => {
  const { controller } = harness({ destinationOrigin: null });
  await controller.start();
  await assert.rejects(
    controller.approve(),
    (error) => error.code === "incremental_contribution_not_configured",
  );
});
