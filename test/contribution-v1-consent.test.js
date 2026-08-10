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

test("a no-run device_unavailable outcome pauses without clobbering the last honest progress (2026-08-10)", async () => {
  // The wiring shapes a pre-engine capability failure (Keychain credential
  // unreadable after a Sparkle update) into the engine's own
  // device_unavailable form, with networkActivity false and zeroed counts
  // because no pass ever ran. The pause and its reason must land; the zeros
  // must not overwrite progress a real pass measured.
  const { controller, runs, advance } = harness({
    outcomes: [
      runOutcome(),
      runOutcome({
        status: "failed",
        daysTotal: 0,
        daysSynced: 0,
        daysPending: 0,
        chunksUploaded: 0,
        chunksSkipped: 0,
        recordsUploaded: 0,
        acknowledgedThroughDay: null,
        failure: {
          code: "device_unavailable",
          retryable: false,
          deviceUnavailable: true,
          retryAfterMilliseconds: null,
        },
        networkActivity: false,
      }),
      runOutcome(),
    ],
  });
  await controller.start();
  await controller.approve();
  const synced = await controller.runDue();
  assert.equal(synced.lastOutcome.code, "synced");

  advance(6 * 60 * 60 * 1_000);
  const paused = await controller.runDue();
  assert.equal(paused.paused, true);
  assert.equal(paused.pausedReason, "device_unavailable");
  assert.equal(paused.lastOutcome.code, "device_unavailable");
  assert.equal(paused.nextAttemptAt, null);
  // The last measured truth survives the pause verbatim.
  assert.deepEqual(paused.progress, {
    daysTotal: 2,
    daysSynced: 2,
    daysPending: 0,
    chunksUploaded: 2,
    acknowledgedThroughDay: "2026-08-02",
  });

  // The same cure as every device_unavailable: re-pairing resumes it.
  const resumed = await controller.resume();
  assert.equal(resumed.paused, false);
  await controller.runDue();
  assert.equal(runs.length, 3);
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

test("re-pairing mid retry-backoff pulls the next attempt to the present (2026-08-08)", async () => {
  // Owner-directed immediate first pass: a successful device pairing is
  // fresh upload authority, not just the cure for an auto-pause. A
  // controller mid retry-backoff (for example after the service refused
  // uploads for a claim that carried the v0.1 consent) must not sit out the
  // remainder of a ladder it has already lost, so resume() on an unpaused
  // controller re-arms an immediate attempt.
  const { controller, runs, nowIso } = harness({
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
  assert.ok(Date.parse(failed.nextAttemptAt) > Date.parse(nowIso()));
  // No waiting out the backoff: the pairing cure re-arms the schedule now,
  // and the retry ladder starts over for the fresh authority.
  const resumed = await controller.resume();
  assert.equal(resumed.nextAttemptAt, nowIso());
  await controller.runDue();
  assert.equal(runs.length, 2);
});

test("a refused consent grant pauses with the exact consent_rejected reason (2026-08-08)", async () => {
  // The fixed-vocabulary code the dashboard's transparent re-pair keys on: a
  // 403 TELEMETRY_CONSENT_INVALID upload surfaces as consent_rejected, the
  // engine pauses, and the pairing cure (resume) reopens the schedule.
  const { controller, runs } = harness({
    outcomes: [
      runOutcome({
        status: "failed",
        daysSynced: 0,
        daysPending: 2,
        chunksUploaded: 0,
        failure: {
          code: "consent_rejected",
          retryable: false,
          deviceUnavailable: false,
          retryAfterMilliseconds: null,
        },
      }),
      runOutcome(),
    ],
  });
  await controller.start();
  await controller.approve();
  const paused = await controller.runDue();
  assert.equal(paused.paused, true);
  assert.equal(paused.pausedReason, "consent_rejected");
  assert.equal(paused.nextAttemptAt, null);
  const resumed = await controller.resume();
  assert.equal(resumed.paused, false);
  await controller.runDue();
  assert.equal(runs.length, 2);
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

function coordinationError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.retryable = true;
  return error;
}

test("a known coordination collision retries within the pending minute without touching the ladder (2026-08-10)", async () => {
  // The two expected local collisions: the legacy v0.1 pipeline holding the
  // shared sync mutex, and the foreground indexer writing the unified index.
  // Neither is service pressure, so neither may escalate the exponential
  // backoff that stretched the live 86-day backfill to ~48-minute gaps.
  const { controller, storage, runs, advance } = harness({
    outcomes: [
      coordinationError(
        "sync_in_progress",
        "legacy v0.1 sync holds the shared mutex",
      ),
      coordinationError(
        "index_busy",
        "unified index momentarily held by another local writer",
      ),
      runOutcome(),
    ],
  });
  await controller.start();
  await controller.approve();

  const collided = await controller.runDue();
  assert.equal(collided.paused, false);
  assert.equal(collided.lastOutcome.status, "failed");
  assert.equal(collided.lastOutcome.code, "sync_in_progress");
  assert.deepEqual(collided.lastOutcome.detail, {
    code: "sync_in_progress",
    message: "legacy v0.1 sync holds the shared mutex",
  });
  assert.equal(
    Date.parse(collided.nextAttemptAt) - Date.parse(collided.lastAttemptAt),
    60_000,
  );
  let persisted = JSON.parse(storage.files.get(SETTINGS_FILE));
  assert.equal(persisted.retryCount, 0);
  assert.equal(persisted.lastOutcome.detail.code, "sync_in_progress");

  // A second collision stays at the pending minute: no ladder, no doubling.
  advance(60_000);
  const busy = await controller.runDue();
  assert.equal(busy.lastOutcome.code, "index_busy");
  assert.deepEqual(busy.lastOutcome.detail, {
    code: "index_busy",
    message: "unified index momentarily held by another local writer",
  });
  assert.equal(
    Date.parse(busy.nextAttemptAt) - Date.parse(busy.lastAttemptAt),
    60_000,
  );
  persisted = JSON.parse(storage.files.get(SETTINGS_FILE));
  assert.equal(persisted.retryCount, 0);

  advance(60_000);
  const recovered = await controller.runDue();
  assert.equal(recovered.lastOutcome.code, "synced");
  assert.equal(runs.length, 3);
});

test("an unknown thrown runner error keeps today's ladder and records a bounded, path-free detail (2026-08-10)", async () => {
  const anonymous = new Error(
    "ENOENT: no such file, open '/Users/owner/Library/state.sqlite3'",
  );
  const coded = new Error("wire exploded");
  coded.code = "wire_exploded";
  // A coordination-shaped code WITHOUT retryable === true is not a
  // coordination collision: it keeps the ladder like any other throw.
  const notRetryable = new Error("looks coordinated but is not");
  notRetryable.code = "sync_in_progress";
  const storage = fakeStorage();
  const { controller, advance } = harness({
    storage,
    outcomes: [anonymous, coded, notRetryable],
  });
  await controller.start();
  await controller.approve();

  const first = await controller.runDue();
  assert.equal(first.lastOutcome.code, "run_failed");
  assert.equal(first.lastOutcome.status, "failed");
  assert.equal(first.lastOutcome.detail.code, null);
  assert.equal(first.lastOutcome.detail.message.includes("/Users"), false);
  assert.equal(first.lastOutcome.detail.message.includes("[path]"), true);
  // First rung, exactly as today: 5 s at the deterministic 0.75 jitter floor.
  assert.equal(
    Date.parse(first.nextAttemptAt) - Date.parse(first.lastAttemptAt),
    3_750,
  );
  assert.equal(JSON.parse(storage.files.get(SETTINGS_FILE)).retryCount, 1);

  advance(3_750);
  const second = await controller.runDue();
  assert.equal(second.lastOutcome.detail.code, "wire_exploded");
  assert.equal(second.lastOutcome.detail.message, "wire exploded");
  // Second rung doubles, exactly as today.
  assert.equal(
    Date.parse(second.nextAttemptAt) - Date.parse(second.lastAttemptAt),
    7_500,
  );
  assert.equal(JSON.parse(storage.files.get(SETTINGS_FILE)).retryCount, 2);

  advance(7_500);
  const third = await controller.runDue();
  assert.equal(third.lastOutcome.code, "run_failed");
  assert.equal(third.lastOutcome.detail.code, "sync_in_progress");
  assert.equal(
    Date.parse(third.nextAttemptAt) - Date.parse(third.lastAttemptAt),
    15_000,
  );
  assert.equal(JSON.parse(storage.files.get(SETTINGS_FILE)).retryCount, 3);
  await controller.stop();

  // The widened outcome shape round-trips: a restart loads the detail back.
  const revived = harness({ storage });
  await revived.controller.start();
  const status = await revived.controller.inspect();
  assert.deepEqual(status.lastOutcome.detail, {
    code: "sync_in_progress",
    message: "looks coordinated but is not",
  });
});

function persistedSettings(overrides = {}) {
  return {
    schemaVersion: "incremental-contribution-sync-settings-v1.0",
    consent: {
      consentedAt: "2026-08-01T00:00:00.000Z",
      destinationOrigin: ORIGIN,
      telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
    },
    paused: false,
    pausedReason: null,
    retryCount: 0,
    lastAttemptAt: "2026-08-02T23:59:00.000Z",
    lastOutcome: null,
    nextAttemptAt: null,
    progress: null,
    ...overrides,
  };
}

test("a restart with backlog clamps an inherited backoff to the pending minute and resets the ladder (2026-08-10)", async () => {
  // The live incident: eleven service_unavailable passes stretched the gap
  // to ~48 minutes, the file kept it, and the relaunched app sat idle for
  // most of an hour after the service had recovered. A fresh process is a
  // natural re-probe point; with backlog pending it must not inherit that.
  // The lastOutcome here is the pre-detail shape: an old file still loads.
  const settings = persistedSettings({
    retryCount: 11,
    lastOutcome: {
      at: "2026-08-02T23:59:03.000Z",
      code: "service_unavailable",
      status: "failed",
    },
    nextAttemptAt: "2026-08-03T00:48:00.000Z",
    progress: {
      daysTotal: 86,
      daysSynced: 7,
      daysPending: 79,
      chunksUploaded: 420,
      acknowledgedThroughDay: "2026-05-13",
    },
  });
  const storage = fakeStorage(
    new Map([[SETTINGS_FILE, `${JSON.stringify(settings)}\n`]]),
  );
  const { controller, storage: sameStorage, runs, advance } =
    harness({ storage });
  const started = await controller.start();
  // Clamped to now + PENDING_RETRY_MILLISECONDS (zero dither here), well
  // inside the ~2 minutes the operator can reasonably call "soon".
  assert.equal(started.nextAttemptAt, "2026-08-03T00:01:00.000Z");
  const persisted = JSON.parse(sameStorage.files.get(SETTINGS_FILE));
  assert.equal(persisted.retryCount, 0);
  assert.equal(persisted.nextAttemptAt, "2026-08-03T00:01:00.000Z");
  // The pre-detail outcome survived the load and the rewrite verbatim.
  assert.deepEqual(persisted.lastOutcome, settings.lastOutcome);
  // And the clamped schedule actually drains: the pass runs a minute in.
  await controller.runDue();
  assert.equal(runs.length, 0);
  advance(60_000);
  await controller.runDue();
  assert.equal(runs.length, 1);
});

test("steady state keeps its six-hour schedule across a restart (2026-08-10)", async () => {
  const text = `${JSON.stringify(persistedSettings({
    lastOutcome: {
      at: "2026-08-02T23:59:03.000Z",
      code: "synced",
      status: "succeeded",
    },
    nextAttemptAt: "2026-08-03T06:00:00.000Z",
    progress: {
      daysTotal: 86,
      daysSynced: 86,
      daysPending: 0,
      chunksUploaded: 499,
      acknowledgedThroughDay: "2026-08-02",
    },
  }))}\n`;
  const storage = fakeStorage(new Map([[SETTINGS_FILE, text]]));
  const { controller } = harness({ storage });
  const started = await controller.start();
  assert.equal(started.nextAttemptAt, "2026-08-03T06:00:00.000Z");
  // Nothing pending, last pass succeeded: the file is not even rewritten.
  assert.equal(storage.files.get(SETTINGS_FILE), text);
});
