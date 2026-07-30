import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS,
  AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS,
  AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION,
  AUTOMATIC_CONTRIBUTION_STATUS_SCHEMA_VERSION,
  acquireAutomaticContributionInstanceLock,
  automaticContributionRequiredConsent,
  createAutomaticContributionController,
} from "../src/automatic-contribution.js";

const CENTRAL_ORIGIN = "https://usage.example.test";
const SECOND_CENTRAL_ORIGIN = "https://other.example.test";
const START = Date.parse("2026-07-29T12:00:00.000Z");
const FIRST_PREPARED_SET_ID = "a".repeat(64);
const AUTOMATIC_PREPARED_SET_ID = "b".repeat(64);
const FIRST_COVERAGE = Object.freeze({
  startAt: "2026-07-29T11:00:00.000Z",
  endAt: "2026-07-29T12:00:00.000Z",
});
const AUTOMATIC_COVERAGE = Object.freeze({
  startAt: "2026-07-29T11:00:00.000Z",
  endAt: "2026-07-29T18:00:00.000Z",
});

function fakeTimers() {
  let nextId = 1;
  const scheduled = new Map();
  return {
    setTimeoutImpl(callback, delay) {
      const id = nextId;
      nextId += 1;
      scheduled.set(id, { callback, delay });
      return id;
    },
    clearTimeoutImpl(id) {
      scheduled.delete(id);
    },
    delays() {
      return [...scheduled.values()].map(({ delay }) => delay);
    },
    fireFirst(delay) {
      const entry = [...scheduled.entries()]
        .find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `expected a ${delay} ms timer`);
      scheduled.delete(entry[0]);
      entry[1].callback();
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "automatic-contribution-"));
  return {
    root,
    settingsFile: join(root, "private", "automatic-contribution-v0.1.json"),
  };
}

async function successfulPreparation(request = {}) {
  if (typeof request.beforePreparedPublish === "function") {
    await request.beforePreparedPublish({
      preparedSetId: AUTOMATIC_PREPARED_SET_ID,
      coveredAt: { ...AUTOMATIC_COVERAGE },
    });
  }
  return {
    schemaVersion: "local-contribution-preparation-result-v0.1",
    status: "prepared",
    prepared: {
      preparedSetId: AUTOMATIC_PREPARED_SET_ID,
    },
    coveredAt: { ...AUTOMATIC_COVERAGE },
    networkActivity: false,
  };
}

async function recordSuccessfulManualReview(controller) {
  return controller.recordReviewedManualAcceptance({
    status: "completed",
    accepted: 1,
    preparedSet: preparedSetStatus({
      preparedSetId: FIRST_PREPARED_SET_ID,
      coveredAt: FIRST_COVERAGE,
    }),
  });
}

function preparedSetStatus({
  preparedSetId = AUTOMATIC_PREPARED_SET_ID,
  coveredAt = AUTOMATIC_COVERAGE,
  acceptedJobs = 1,
  pendingJobs = 0,
  retryableJobs = 0,
  inFlightJobs = 0,
  rejectedJobs = 0,
} = {}) {
  const totalJobs = acceptedJobs
    + pendingJobs
    + retryableJobs
    + inFlightJobs
    + rejectedJobs;
  return {
    preparedSetId,
    coveredAt: { ...coveredAt },
    totalJobs,
    acceptedJobs,
    pendingJobs,
    retryableJobs,
    inFlightJobs,
    rejectedJobs,
    completeAccepted: acceptedJobs === totalJobs,
  };
}

function completedUpload({
  accepted = 1,
  processed = 1,
  retryable = 0,
  rejected = 0,
  paused = false,
  preparedSet = preparedSetStatus({
    acceptedJobs: accepted,
    pendingJobs: processed === 0 && accepted === 0
      && retryable === 0 && rejected === 0
      ? 1
      : 0,
    retryableJobs: retryable,
    rejectedJobs: rejected,
  }),
} = {}) {
  return {
    status: paused ? "paused" : "completed",
    accepted,
    processed,
    retryable,
    rejected,
    queue: { paused },
    preparedSet,
  };
}

async function waitFor(predicate, timeoutMilliseconds = 1_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMilliseconds) {
    if (predicate()) return;
    await new Promise((resolveWait) => setImmediate(resolveWait));
  }
  throw new Error("automatic contribution condition was not reached");
}

test("automatic contribution is off by default and unconfigured builds never run", async () => {
  const files = await fixture();
  let preparations = 0;
  let uploads = 0;
  const timers = fakeTimers();
  const controller = createAutomaticContributionController({
    settingsFile: files.settingsFile,
    destinationOrigin: null,
    prepareRunner: async (request) => {
      preparations += 1;
      return successfulPreparation(request);
    },
    uploadRunner: async () => {
      uploads += 1;
      return completedUpload();
    },
    now: () => new Date(START),
    ...timers,
  });
  try {
    await controller.start();
    const status = await controller.inspect();
    assert.deepEqual(status, {
      schemaVersion: AUTOMATIC_CONTRIBUTION_STATUS_SCHEMA_VERSION,
      status: "not_configured",
      enabled: false,
      intervalHours: AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS,
      consentCurrent: false,
      firstReviewComplete: false,
      firstReviewedAcceptedAt: null,
      requiredConsent: {
        telemetrySchemaVersion: "telemetry-contribution-v0.1",
        fieldDictionaryVersion:
          "telemetry-v0.1-registry-2026-07-25.3",
        privacyContractVersion:
          "ongoing-privacy-safe-telemetry-v0.1",
        destinationOrigin: null,
      },
      consentedAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextAttemptAt: null,
      lastOutcome: null,
      foregroundOnly: true,
      daemonInstalled: false,
      networkActivity: false,
      includesContent: false,
      includesPaths: false,
      includesIdentifiers: false,
      includesCredentials: false,
    });
    assert.deepEqual(timers.delays(), []);
    assert.equal(preparations, 0);
    assert.equal(uploads, 0);
    await assert.rejects(
      controller.enable({
        intervalHours: 6,
        consent: automaticContributionRequiredConsent({
          destinationOrigin: CENTRAL_ORIGIN,
        }),
      }),
      (error) => error?.code === "automatic_contribution_not_configured",
    );
  } finally {
    await controller.stop();
    await rm(files.root, { recursive: true });
  }
});

test("automatic contribution requires one accepted exact-reviewed manual send", async () => {
  const files = await fixture();
  const timers = fakeTimers();
  const controller = createAutomaticContributionController({
    settingsFile: files.settingsFile,
    destinationOrigin: CENTRAL_ORIGIN,
    prepareRunner: async (request) => successfulPreparation(request),
    uploadRunner: async () => completedUpload(),
    now: () => new Date(START),
    ...timers,
  });
  try {
    await controller.start();
    const consent = automaticContributionRequiredConsent({
      destinationOrigin: CENTRAL_ORIGIN,
    });
    await assert.rejects(
      controller.enable({ intervalHours: 6, consent }),
      (error) => (
        error?.code === "automatic_contribution_first_review_required"
      ),
    );
    assert.deepEqual(timers.delays(), []);
    await assert.rejects(
      controller.recordReviewedManualAcceptance({
        status: "completed",
        accepted: 0,
      }),
      (error) => (
        error?.code === "automatic_contribution_review_acceptance_invalid"
      ),
    );
    assert.equal((await controller.inspect()).status, "first_review_required");
    const reviewed = await recordSuccessfulManualReview(controller);
    assert.equal(reviewed.status, "disabled");
    assert.equal(reviewed.firstReviewComplete, true);
    assert.equal(
      reviewed.firstReviewedAcceptedAt,
      "2026-07-29T12:00:00.000Z",
    );
    assert.deepEqual(timers.delays(), []);
  } finally {
    await controller.stop();
    await rm(files.root, { recursive: true });
  }
});

test("owner-only lifetime lock blocks a second process and recovers stale state", async () => {
  const files = await fixture();
  const lockFile = join(files.root, "private", "automatic.lock");
  let first;
  let recovered;
  try {
    first = await acquireAutomaticContributionInstanceLock({
      lockFile,
      now: () => new Date(START),
    });
    await assert.rejects(
      acquireAutomaticContributionInstanceLock({ lockFile }),
      (error) => error?.code === "automatic_contribution_instance_active",
    );
    await first.release();
    first = null;
    await writeFile(lockFile, `${JSON.stringify({
      schemaVersion: "automatic-contribution-instance-lock-v0.1",
      pid: 2_147_483_646,
      createdAt: "2026-07-29T11:00:00.000Z",
      nonce: "00000000-0000-4000-8000-000000000000",
    })}\n`, { mode: 0o600 });
    recovered = await acquireAutomaticContributionInstanceLock({
      lockFile,
      now: () => new Date(START),
      processIsAlive: async (pid) => {
        assert.equal(pid, 2_147_483_646);
        return false;
      },
    });
    assert.equal(recovered.pid, process.pid);
  } finally {
    await recovered?.release();
    await first?.release();
    await rm(files.root, { recursive: true });
  }
});

test("explicit exact consent persists owner-only and schedules a bounded six-hour pass", async () => {
  const files = await fixture();
  let now = START;
  const timers = fakeTimers();
  const preparationRequests = [];
  const uploadRequests = [];
  const controller = createAutomaticContributionController({
    settingsFile: files.settingsFile,
    destinationOrigin: CENTRAL_ORIGIN,
    prepareRunner: async (request) => {
      preparationRequests.push(request);
      return successfulPreparation(request);
    },
    uploadRunner: async (request) => {
      uploadRequests.push(request);
      return completedUpload();
    },
    now: () => new Date(now),
    ...timers,
  });
  try {
    await controller.start();
    assert.equal(
      (await controller.inspect()).status,
      "first_review_required",
    );
    await recordSuccessfulManualReview(controller);
    assert.equal((await controller.inspect()).status, "disabled");
    const requiredConsent = automaticContributionRequiredConsent({
      destinationOrigin: CENTRAL_ORIGIN,
    });
    const enabled = await controller.enable({
      intervalHours: AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS,
      consent: requiredConsent,
    });
    assert.equal(enabled.status, "scheduled");
    assert.equal(enabled.consentedAt, "2026-07-29T12:00:00.000Z");
    assert.equal(enabled.nextAttemptAt, "2026-07-29T18:00:00.000Z");
    assert.deepEqual(timers.delays(), [6 * 60 * 60 * 1_000]);
    assert.equal(preparationRequests.length, 0);
    assert.equal(uploadRequests.length, 0);

    const stats = await lstat(files.settingsFile);
    assert.equal(stats.isFile(), true);
    if (process.platform !== "win32") {
      assert.equal(stats.mode & 0o7777, 0o600);
    }
    const stored = JSON.parse(await readFile(files.settingsFile, "utf8"));
    assert.equal(
      stored.schemaVersion,
      AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION,
    );
    assert.deepEqual(stored.consent, {
      ...requiredConsent,
      consentedAt: "2026-07-29T12:00:00.000Z",
    });
    assert.deepEqual(stored.reviewBootstrap, {
      ...requiredConsent,
      preparedSetId: FIRST_PREPARED_SET_ID,
      acceptedAt: "2026-07-29T12:00:00.000Z",
    });

    now += 6 * 60 * 60 * 1_000;
    timers.fireFirst(6 * 60 * 60 * 1_000);
    await waitFor(() => uploadRequests.length === 1);
    const completed = await controller.inspect();
    assert.equal(preparationRequests.length, 1);
    assert.equal(
      preparationRequests[0].lookbackHours,
      AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS,
    );
    assert.equal(
      preparationRequests[0].acceptedThroughAt,
      FIRST_COVERAGE.endAt,
    );
    assert.ok(preparationRequests[0].signal instanceof AbortSignal);
    assert.equal(uploadRequests.length, 1);
    assert.ok(uploadRequests[0].signal instanceof AbortSignal);
    assert.equal(
      uploadRequests[0].preparedSetId,
      AUTOMATIC_PREPARED_SET_ID,
    );
    assert.equal(completed.status, "scheduled");
    assert.equal(completed.lastAttemptAt, "2026-07-29T18:00:00.000Z");
    assert.equal(completed.lastSuccessAt, "2026-07-29T18:00:00.000Z");
    assert.deepEqual(completed.lastOutcome, {
      status: "succeeded",
      code: "accepted",
      at: "2026-07-29T18:00:00.000Z",
    });
    assert.equal(completed.nextAttemptAt, "2026-07-30T00:00:00.000Z");
  } finally {
    await controller.stop();
    await rm(files.root, { recursive: true });
  }
});

test("same-destination relaunch preserves consent, due time, and runs overdue work", async () => {
  const files = await fixture();
  const firstTimers = fakeTimers();
  const first = createAutomaticContributionController({
    settingsFile: files.settingsFile,
    destinationOrigin: CENTRAL_ORIGIN,
    prepareRunner: async (request) => successfulPreparation(request),
    uploadRunner: async () => completedUpload(),
    now: () => new Date(START),
    ...firstTimers,
  });
  let second;
  let third;
  try {
    await first.start();
    await recordSuccessfulManualReview(first);
    await first.enable({
      intervalHours: AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS,
      consent: automaticContributionRequiredConsent({
        destinationOrigin: CENTRAL_ORIGIN,
      }),
    });
    await first.stop();

    const secondTimers = fakeTimers();
    second = createAutomaticContributionController({
      settingsFile: files.settingsFile,
      destinationOrigin: CENTRAL_ORIGIN,
      prepareRunner: async (request) => successfulPreparation(request),
      uploadRunner: async () => completedUpload(),
      now: () => new Date(START + 3 * 60 * 60 * 1_000),
      ...secondTimers,
    });
    const resumed = await second.start();
    assert.equal(resumed.status, "scheduled");
    assert.equal(resumed.enabled, true);
    assert.equal(resumed.consentCurrent, true);
    assert.equal(resumed.consentedAt, "2026-07-29T12:00:00.000Z");
    assert.equal(resumed.lastAttemptAt, null);
    assert.equal(resumed.nextAttemptAt, "2026-07-29T18:00:00.000Z");
    assert.deepEqual(secondTimers.delays(), [3 * 60 * 60 * 1_000]);
    await second.stop();

    const thirdTimers = fakeTimers();
    const preparationRequests = [];
    const uploadRequests = [];
    third = createAutomaticContributionController({
      settingsFile: files.settingsFile,
      destinationOrigin: CENTRAL_ORIGIN,
      prepareRunner: async (request) => {
        preparationRequests.push(request);
        return successfulPreparation(request);
      },
      uploadRunner: async (request) => {
        uploadRequests.push(request);
        return completedUpload();
      },
      now: () => new Date(START + 7 * 60 * 60 * 1_000),
      ...thirdTimers,
    });
    const overdue = await third.start();
    assert.equal(overdue.status, "scheduled");
    assert.equal(overdue.nextAttemptAt, "2026-07-29T18:00:00.000Z");
    assert.deepEqual(thirdTimers.delays(), [0]);
    thirdTimers.fireFirst(0);
    await waitFor(() => uploadRequests.length === 1);
    const completed = await third.inspect();
    assert.equal(preparationRequests.length, 1);
    assert.equal(uploadRequests.length, 1);
    assert.equal(completed.status, "scheduled");
    assert.equal(completed.lastAttemptAt, "2026-07-29T19:00:00.000Z");
    assert.equal(completed.lastSuccessAt, "2026-07-29T19:00:00.000Z");
    assert.equal(completed.nextAttemptAt, "2026-07-30T01:00:00.000Z");
  } finally {
    await first.stop();
    await second?.stop();
    await third?.stop();
    await rm(files.root, { recursive: true });
  }
});

test("destination drift invalidates persisted consent without running or rewriting it", async () => {
  const files = await fixture();
  const timers = fakeTimers();
  const first = createAutomaticContributionController({
    settingsFile: files.settingsFile,
    destinationOrigin: CENTRAL_ORIGIN,
    prepareRunner: async (request) => successfulPreparation(request),
    uploadRunner: async () => completedUpload(),
    now: () => new Date(START),
    ...timers,
  });
  let preparations = 0;
  let uploads = 0;
  let second;
  try {
    await first.start();
    await recordSuccessfulManualReview(first);
    await first.enable({
      intervalHours: 6,
      consent: automaticContributionRequiredConsent({
        destinationOrigin: CENTRAL_ORIGIN,
      }),
    });
    await first.stop();
    const before = await readFile(files.settingsFile, "utf8");

    second = createAutomaticContributionController({
      settingsFile: files.settingsFile,
      destinationOrigin: SECOND_CENTRAL_ORIGIN,
      prepareRunner: async (request) => {
        preparations += 1;
        return successfulPreparation(request);
      },
      uploadRunner: async () => {
        uploads += 1;
        return completedUpload();
      },
      now: () => new Date(START + 12 * 60 * 60 * 1_000),
      ...fakeTimers(),
    });
    await second.start();
    const status = await second.inspect();
    assert.equal(status.status, "first_review_required");
    assert.equal(status.firstReviewComplete, false);
    assert.equal(status.enabled, false);
    assert.equal(status.consentCurrent, false);
    assert.equal(status.nextAttemptAt, null);
    await second.runDue();
    assert.equal(preparations, 0);
    assert.equal(uploads, 0);
    assert.equal(await readFile(files.settingsFile, "utf8"), before);
    await assert.rejects(
      second.enable({
        intervalHours: 6,
        consent: automaticContributionRequiredConsent({
          destinationOrigin: CENTRAL_ORIGIN,
        }),
      }),
      (error) => (
        error?.code
          === "automatic_contribution_first_review_required"
      ),
    );
  } finally {
    await first.stop();
    await second?.stop();
    await rm(files.root, { recursive: true });
  }
});

test("version-two settings migrate to the write-ahead schema on the next legitimate write", async () => {
  const files = await fixture();
  await mkdir(join(files.root, "private"), { recursive: true, mode: 0o700 });
  await writeFile(files.settingsFile, `${JSON.stringify({
    schemaVersion: "automatic-contribution-settings-v0.2",
    enabled: false,
    paused: false,
    intervalHours: 6,
    consent: null,
    acceptedThrough: null,
    pendingContribution: null,
    reviewBootstrap: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastOutcome: null,
  })}\n`, { mode: 0o600 });
  const controller = createAutomaticContributionController({
    settingsFile: files.settingsFile,
    destinationOrigin: CENTRAL_ORIGIN,
    prepareRunner: async (request) => successfulPreparation(request),
    uploadRunner: async () => completedUpload(),
    now: () => new Date(START),
    ...fakeTimers(),
  });
  try {
    assert.equal((await controller.start()).status, "first_review_required");
    await recordSuccessfulManualReview(controller);
    const stored = JSON.parse(await readFile(files.settingsFile, "utf8"));
    assert.equal(
      stored.schemaVersion,
      AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION,
    );
    assert.equal(stored.preparationClaim, null);
  } finally {
    await controller.stop();
    await rm(files.root, { recursive: true });
  }
});

test("a mismatched write-ahead claim makes settings unavailable before any runner starts", async () => {
  const files = await fixture();
  const required = automaticContributionRequiredConsent({
    destinationOrigin: CENTRAL_ORIGIN,
  });
  await mkdir(join(files.root, "private"), { recursive: true, mode: 0o700 });
  await writeFile(files.settingsFile, `${JSON.stringify({
    schemaVersion: AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION,
    enabled: true,
    paused: false,
    intervalHours: 6,
    consent: {
      ...required,
      consentedAt: "2026-07-29T12:00:00.000Z",
    },
    acceptedThrough: {
      ...required,
      acceptedAt: "2026-07-29T12:00:00.000Z",
      coveredThroughAt: FIRST_COVERAGE.endAt,
    },
    pendingContribution: null,
    preparationClaim: {
      ...required,
      preparationId: "00000000-0000-4000-8000-000000000009",
      preparedSetId: null,
      claimedAt: "2026-07-29T12:00:00.000Z",
      acceptedThroughAt: "2026-07-29T11:59:59.000Z",
      lookbackHours: 24,
      replayOverlapHours: 1,
    },
    reviewBootstrap: {
      ...required,
      preparedSetId: FIRST_PREPARED_SET_ID,
      acceptedAt: "2026-07-29T12:00:00.000Z",
    },
    lastAttemptAt: "2026-07-29T12:00:00.000Z",
    lastSuccessAt: null,
    lastOutcome: null,
  })}\n`, { mode: 0o600 });
  let preparations = 0;
  let uploads = 0;
  const controller = createAutomaticContributionController({
    settingsFile: files.settingsFile,
    destinationOrigin: CENTRAL_ORIGIN,
    prepareRunner: async () => {
      preparations += 1;
    },
    uploadRunner: async () => {
      uploads += 1;
    },
    now: () => new Date(START),
    ...fakeTimers(),
  });
  try {
    const status = await controller.start();
    assert.equal(status.status, "failed");
    assert.equal(preparations, 0);
    assert.equal(uploads, 0);
  } finally {
    await controller.stop();
    await rm(files.root, { recursive: true });
  }
});

test("partial exact-set delivery resumes without re-preparing and advances only after complete acceptance", async () => {
  const files = await fixture();
  let now = START;
  let preparations = 0;
  let uploads = 0;
  const controller = createAutomaticContributionController({
    settingsFile: files.settingsFile,
    destinationOrigin: CENTRAL_ORIGIN,
    prepareRunner: async (request) => {
      preparations += 1;
      return successfulPreparation(request);
    },
    uploadRunner: async () => {
      uploads += 1;
      return completedUpload({
        accepted: 1,
        processed: 1,
        preparedSet: uploads === 1
          ? preparedSetStatus({
            acceptedJobs: 1,
            pendingJobs: 1,
          })
          : preparedSetStatus({ acceptedJobs: 2 }),
      });
    },
    now: () => new Date(now),
    ...fakeTimers(),
  });
  try {
    await controller.start();
    await recordSuccessfulManualReview(controller);
    await controller.enable({
      intervalHours: 6,
      consent: automaticContributionRequiredConsent({
        destinationOrigin: CENTRAL_ORIGIN,
      }),
    });
    now += 6 * 60 * 60 * 1_000;
    const partial = await controller.runDue();
    assert.equal(partial.status, "scheduled");
    assert.equal(partial.lastSuccessAt, null);
    assert.deepEqual(partial.lastOutcome, {
      status: "failed",
      code: "retry_scheduled",
      at: "2026-07-29T18:00:00.000Z",
    });
    let stored = JSON.parse(await readFile(files.settingsFile, "utf8"));
    assert.equal(
      stored.acceptedThrough.coveredThroughAt,
      FIRST_COVERAGE.endAt,
    );
    assert.equal(
      stored.pendingContribution.preparedSetId,
      AUTOMATIC_PREPARED_SET_ID,
    );

    now += 6 * 60 * 60 * 1_000;
    const completed = await controller.runDue();
    assert.equal(completed.status, "scheduled");
    assert.equal(preparations, 1);
    assert.equal(uploads, 2);
    stored = JSON.parse(await readFile(files.settingsFile, "utf8"));
    assert.equal(stored.pendingContribution, null);
    assert.equal(
      stored.acceptedThrough.coveredThroughAt,
      AUTOMATIC_COVERAGE.endAt,
    );
  } finally {
    await controller.stop();
    await rm(files.root, { recursive: true });
  }
});

test("a durably accepted pending set is protected before zero-upload reconciliation advances the watermark", async () => {
  const files = await fixture();
  let now = START;
  let uploads = 0;
  const maintenanceProtections = [];
  const controller = createAutomaticContributionController({
    settingsFile: files.settingsFile,
    destinationOrigin: CENTRAL_ORIGIN,
    prepareRunner: async (request) => successfulPreparation(request),
    maintenanceRunner: async ({ protectedPreparedSetIds }) => {
      maintenanceProtections.push([...protectedPreparedSetIds]);
    },
    uploadRunner: async () => {
      uploads += 1;
      if (uploads === 1) {
        return completedUpload({
          accepted: 1,
          processed: 1,
          preparedSet: preparedSetStatus({
            acceptedJobs: 1,
            pendingJobs: 1,
          }),
        });
      }
      return completedUpload({
        accepted: 0,
        processed: 0,
        preparedSet: preparedSetStatus({ acceptedJobs: 2 }),
      });
    },
    now: () => new Date(now),
    ...fakeTimers(),
  });
  try {
    await controller.start();
    await recordSuccessfulManualReview(controller);
    await controller.enable({
      intervalHours: 6,
      consent: automaticContributionRequiredConsent({
        destinationOrigin: CENTRAL_ORIGIN,
      }),
    });
    now += 6 * 60 * 60 * 1_000;
    await controller.runDue();
    now += 6 * 60 * 60 * 1_000;
    const reconciled = await controller.runDue();
    assert.equal(reconciled.lastOutcome.code, "accepted");
    assert.equal(maintenanceProtections.length, 2);
    assert.equal(
      maintenanceProtections[1].includes(AUTOMATIC_PREPARED_SET_ID),
      true,
    );
    const stored = JSON.parse(await readFile(files.settingsFile, "utf8"));
    assert.equal(stored.pendingContribution, null);
    assert.equal(stored.preparationClaim, null);
    assert.equal(
      stored.acceptedThrough.coveredThroughAt,
      AUTOMATIC_COVERAGE.endAt,
    );
  } finally {
    await controller.stop();
    await rm(files.root, { recursive: true });
  }
});

test("write-ahead preparation survives pre-publication failure and reuses one stable attempt", async () => {
  const files = await fixture();
  let now = START;
  let preparationCalls = 0;
  let uploadCalls = 0;
  const preparationIds = [];
  const maintenanceProtections = [];
  const controller = createAutomaticContributionController({
    settingsFile: files.settingsFile,
    destinationOrigin: CENTRAL_ORIGIN,
    prepareRunner: async (request) => {
      preparationCalls += 1;
      preparationIds.push(request.preparationId);
      if (preparationCalls === 1) {
        await request.beforePreparedPublish({
          preparedSetId: AUTOMATIC_PREPARED_SET_ID,
          coveredAt: { ...AUTOMATIC_COVERAGE },
        });
        throw new Error("simulated crash before atomic publication");
      }
      return successfulPreparation(request);
    },
    uploadRunner: async () => {
      uploadCalls += 1;
      if (uploadCalls === 1) {
        return {
          status: "completed",
          accepted: 0,
          processed: 0,
          retryable: 0,
          rejected: 0,
          preparedSet: null,
        };
      }
      return completedUpload();
    },
    maintenanceRunner: async ({ protectedPreparedSetIds }) => {
      maintenanceProtections.push([...protectedPreparedSetIds]);
    },
    now: () => new Date(now),
    ...fakeTimers(),
  });
  try {
    await controller.start();
    await recordSuccessfulManualReview(controller);
    const consent = automaticContributionRequiredConsent({
      destinationOrigin: CENTRAL_ORIGIN,
    });
    await controller.enable({ intervalHours: 6, consent });

    now += 6 * 60 * 60 * 1_000;
    let status = await controller.runDue();
    assert.equal(status.status, "paused");
    assert.equal(preparationCalls, 1);
    assert.equal(uploadCalls, 0);
    assert.match(preparationIds[0], /^[0-9a-f-]{36}$/u);
    let stored = JSON.parse(await readFile(files.settingsFile, "utf8"));
    assert.equal(
      stored.preparationClaim.preparationId,
      preparationIds[0],
    );
    assert.equal(
      stored.preparationClaim.preparedSetId,
      AUTOMATIC_PREPARED_SET_ID,
    );
    assert.equal(
      stored.pendingContribution.preparedSetId,
      AUTOMATIC_PREPARED_SET_ID,
    );

    await controller.enable({ intervalHours: 6, consent });
    now += 6 * 60 * 60 * 1_000;
    status = await controller.runDue();
    assert.equal(status.status, "scheduled");
    assert.deepEqual(status.lastOutcome, {
      status: "failed",
      code: "publication_incomplete",
      at: "2026-07-30T00:00:00.000Z",
    });
    stored = JSON.parse(await readFile(files.settingsFile, "utf8"));
    assert.equal(stored.pendingContribution, null);
    assert.equal(
      stored.preparationClaim.preparationId,
      preparationIds[0],
    );
    assert.equal(
      stored.preparationClaim.preparedSetId,
      AUTOMATIC_PREPARED_SET_ID,
    );

    now += 6 * 60 * 60 * 1_000;
    status = await controller.runDue();
    assert.equal(status.status, "scheduled");
    assert.equal(preparationCalls, 2);
    assert.equal(uploadCalls, 2);
    assert.equal(preparationIds[1], preparationIds[0]);
    assert.equal(
      maintenanceProtections[2].includes(AUTOMATIC_PREPARED_SET_ID),
      true,
    );
    assert.equal(status.lastOutcome.code, "accepted");
    stored = JSON.parse(await readFile(files.settingsFile, "utf8"));
    assert.equal(stored.pendingContribution, null);
    assert.equal(stored.preparationClaim, null);
    assert.equal(
      stored.acceptedThrough.coveredThroughAt,
      AUTOMATIC_COVERAGE.endAt,
    );
  } finally {
    await controller.stop();
    await rm(files.root, { recursive: true });
  }
});

test("rejected exact-set delivery pauses without advancing or deleting pending state", async () => {
  const files = await fixture();
  let now = START;
  const controller = createAutomaticContributionController({
    settingsFile: files.settingsFile,
    destinationOrigin: CENTRAL_ORIGIN,
    prepareRunner: async (request) => successfulPreparation(request),
    uploadRunner: async () => completedUpload({
      accepted: 0,
      processed: 1,
      rejected: 1,
      preparedSet: preparedSetStatus({
        acceptedJobs: 0,
        rejectedJobs: 1,
      }),
    }),
    now: () => new Date(now),
    ...fakeTimers(),
  });
  try {
    await controller.start();
    await recordSuccessfulManualReview(controller);
    await controller.enable({
      intervalHours: 6,
      consent: automaticContributionRequiredConsent({
        destinationOrigin: CENTRAL_ORIGIN,
      }),
    });
    now += 6 * 60 * 60 * 1_000;
    const rejected = await controller.runDue();
    assert.equal(rejected.status, "paused");
    assert.deepEqual(rejected.lastOutcome, {
      status: "failed",
      code: "delivery_rejected",
      at: "2026-07-29T18:00:00.000Z",
    });
    const stored = JSON.parse(await readFile(files.settingsFile, "utf8"));
    assert.equal(
      stored.acceptedThrough.coveredThroughAt,
      FIRST_COVERAGE.endAt,
    );
    assert.equal(
      stored.pendingContribution.preparedSetId,
      AUTOMATIC_PREPARED_SET_ID,
    );
  } finally {
    await controller.stop();
    await rm(files.root, { recursive: true });
  }
});

test("a paused delivery fails closed until fresh explicit enablement", async () => {
  const files = await fixture();
  let now = START;
  const controller = createAutomaticContributionController({
    settingsFile: files.settingsFile,
    destinationOrigin: CENTRAL_ORIGIN,
    prepareRunner: async (request) => successfulPreparation(request),
    uploadRunner: async () => completedUpload({
      accepted: 0,
      processed: 0,
      paused: true,
    }),
    now: () => new Date(now),
    ...fakeTimers(),
  });
  try {
    await controller.start();
    await recordSuccessfulManualReview(controller);
    const consent = automaticContributionRequiredConsent({
      destinationOrigin: CENTRAL_ORIGIN,
    });
    await controller.enable({ intervalHours: 6, consent });
    now += 6 * 60 * 60 * 1_000;
    const paused = await controller.runDue();
    assert.equal(paused.status, "paused");
    assert.equal(paused.enabled, true);
    assert.equal(paused.nextAttemptAt, null);
    assert.deepEqual(paused.lastOutcome, {
      status: "paused",
      code: "queue_paused",
      at: "2026-07-29T18:00:00.000Z",
    });

    const disabled = await controller.disable();
    assert.equal(disabled.status, "disabled");
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.consentedAt, null);
    const renewed = await controller.enable({ intervalHours: 6, consent });
    assert.equal(renewed.status, "scheduled");
    assert.equal(renewed.nextAttemptAt, "2026-07-30T00:00:00.000Z");
  } finally {
    await controller.stop();
    await rm(files.root, { recursive: true });
  }
});

test("missing new safe records is a scheduled skip rather than a network attempt", async () => {
  const files = await fixture();
  let now = START;
  let uploads = 0;
  const controller = createAutomaticContributionController({
    settingsFile: files.settingsFile,
    destinationOrigin: CENTRAL_ORIGIN,
    prepareRunner: async () => {
      const error = new Error("none");
      error.code = "no_safe_records";
      throw error;
    },
    uploadRunner: async () => {
      uploads += 1;
      return completedUpload();
    },
    now: () => new Date(now),
    ...fakeTimers(),
  });
  try {
    await controller.start();
    await recordSuccessfulManualReview(controller);
    await controller.enable({
      intervalHours: 6,
      consent: automaticContributionRequiredConsent({
        destinationOrigin: CENTRAL_ORIGIN,
      }),
    });
    now += 6 * 60 * 60 * 1_000;
    const status = await controller.runDue();
    assert.equal(uploads, 0);
    assert.equal(status.status, "scheduled");
    assert.deepEqual(status.lastOutcome, {
      status: "skipped",
      code: "no_new_evidence",
      at: "2026-07-29T18:00:00.000Z",
    });
    assert.equal(status.lastSuccessAt, null);
  } finally {
    await controller.stop();
    await rm(files.root, { recursive: true });
  }
});

test("an unexpected upload failure pauses while an explicitly retryable collision reschedules", async (t) => {
  for (const scenario of [
    {
      name: "unexpected failure",
      retryable: false,
      expectedStatus: "paused",
      expectedNextAttemptAt: null,
    },
    {
      name: "retryable collision",
      retryable: true,
      expectedStatus: "scheduled",
      expectedNextAttemptAt: "2026-07-30T00:00:00.000Z",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const files = await fixture();
      let now = START;
      const controller = createAutomaticContributionController({
        settingsFile: files.settingsFile,
        destinationOrigin: CENTRAL_ORIGIN,
        prepareRunner: async (request) => successfulPreparation(request),
        uploadRunner: async () => {
          const error = new Error("fixed test failure");
          error.retryable = scenario.retryable;
          throw error;
        },
        now: () => new Date(now),
        ...fakeTimers(),
      });
      try {
        await controller.start();
        await recordSuccessfulManualReview(controller);
        await controller.enable({
          intervalHours: 6,
          consent: automaticContributionRequiredConsent({
            destinationOrigin: CENTRAL_ORIGIN,
          }),
        });
        now += 6 * 60 * 60 * 1_000;
        const status = await controller.runDue();
        assert.equal(status.status, scenario.expectedStatus);
        assert.equal(status.nextAttemptAt, scenario.expectedNextAttemptAt);
        assert.deepEqual(status.lastOutcome, {
          status: "failed",
          code: "upload_failed",
          at: "2026-07-29T18:00:00.000Z",
        });
      } finally {
        await controller.stop();
        await rm(files.root, { recursive: true });
      }
    });
  }
});

test("the bounded run timeout aborts and pauses even if a runner later reports acceptance", async () => {
  const files = await fixture();
  let now = START;
  const timers = fakeTimers();
  let uploadStarted = false;
  const controller = createAutomaticContributionController({
    settingsFile: files.settingsFile,
    destinationOrigin: CENTRAL_ORIGIN,
    prepareRunner: async (request) => successfulPreparation(request),
    uploadRunner: async ({ signal }) => {
      uploadStarted = true;
      await new Promise((resolveAbort) => {
        signal.addEventListener("abort", resolveAbort, { once: true });
      });
      return completedUpload();
    },
    now: () => new Date(now),
    ...timers,
  });
  try {
    await controller.start();
    await recordSuccessfulManualReview(controller);
    await controller.enable({
      intervalHours: 6,
      consent: automaticContributionRequiredConsent({
        destinationOrigin: CENTRAL_ORIGIN,
      }),
    });
    now += 6 * 60 * 60 * 1_000;
    const running = controller.runDue();
    await waitFor(() => uploadStarted);
    timers.fireFirst(5 * 60 * 1_000);
    const status = await running;
    assert.equal(status.status, "paused");
    assert.equal(status.lastSuccessAt, null);
    assert.deepEqual(status.lastOutcome, {
      status: "failed",
      code: "run_timeout",
      at: "2026-07-29T18:00:00.000Z",
    });
    const stored = JSON.parse(await readFile(files.settingsFile, "utf8"));
    assert.equal(
      stored.acceptedThrough.coveredThroughAt,
      FIRST_COVERAGE.endAt,
    );
    assert.equal(
      stored.pendingContribution.preparedSetId,
      AUTOMATIC_PREPARED_SET_ID,
    );
  } finally {
    await controller.stop();
    await rm(files.root, { recursive: true });
  }
});

test("the bounded run timeout cooperatively stops preparation before upload", async () => {
  const files = await fixture();
  let now = START;
  const timers = fakeTimers();
  let preparationStarted = false;
  let preparationStopped = false;
  let uploads = 0;
  const controller = createAutomaticContributionController({
    settingsFile: files.settingsFile,
    destinationOrigin: CENTRAL_ORIGIN,
    prepareRunner: async ({ signal }) => {
      preparationStarted = true;
      await new Promise((resolveAbort) => {
        signal.addEventListener("abort", resolveAbort, { once: true });
      });
      preparationStopped = true;
      signal.throwIfAborted();
    },
    uploadRunner: async () => {
      uploads += 1;
      return completedUpload();
    },
    now: () => new Date(now),
    ...timers,
  });
  try {
    await controller.start();
    await recordSuccessfulManualReview(controller);
    await controller.enable({
      intervalHours: 6,
      consent: automaticContributionRequiredConsent({
        destinationOrigin: CENTRAL_ORIGIN,
      }),
    });
    now += 6 * 60 * 60 * 1_000;
    const running = controller.runDue();
    await waitFor(() => preparationStarted);
    timers.fireFirst(5 * 60 * 1_000);
    const status = await running;
    assert.equal(preparationStopped, true);
    assert.equal(uploads, 0);
    assert.equal(status.status, "paused");
    assert.deepEqual(status.lastOutcome, {
      status: "failed",
      code: "run_timeout",
      at: "2026-07-29T18:00:00.000Z",
    });
  } finally {
    await controller.stop();
    await rm(files.root, { recursive: true });
  }
});

test("non-owner-only or malformed settings fail closed with no runner activity", async () => {
  const files = await fixture();
  let preparations = 0;
  let uploads = 0;
  await mkdir(join(files.root, "private"), { mode: 0o700 });
  await writeFile(files.settingsFile, "{\"enabled\":true}\n", {
    mode: 0o600,
  });
  if (process.platform !== "win32") await chmod(files.settingsFile, 0o644);
  const controller = createAutomaticContributionController({
    settingsFile: files.settingsFile,
    destinationOrigin: CENTRAL_ORIGIN,
    prepareRunner: async (request) => {
      preparations += 1;
      return successfulPreparation(request);
    },
    uploadRunner: async () => {
      uploads += 1;
      return completedUpload();
    },
    now: () => new Date(START),
    ...fakeTimers(),
  });
  try {
    await controller.start();
    const status = await controller.inspect();
    assert.equal(status.status, "failed");
    assert.equal(status.enabled, false);
    assert.equal(status.nextAttemptAt, null);
    assert.equal(preparations, 0);
    assert.equal(uploads, 0);
    await assert.rejects(
      controller.enable({
        intervalHours: 6,
        consent: automaticContributionRequiredConsent({
          destinationOrigin: CENTRAL_ORIGIN,
        }),
      }),
      (error) => (
        error?.code === "automatic_contribution_settings_unavailable"
      ),
    );
  } finally {
    await controller.stop();
    await rm(files.root, { recursive: true });
  }
});
