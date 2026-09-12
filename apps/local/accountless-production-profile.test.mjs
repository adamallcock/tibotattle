import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachAccountlessParentChannel } from "../../src/platform/index.js";
import {
  createLocalAccountlessContribution,
  selectLocalAccountlessProductionProfile,
} from "./accountless-contribution.js";
import { createLocalCompanionServer, startLocalCompanionServer } from "./server.js";

const ORIGIN = "https://tibotattle.com";

function profileEnvironment(extra = {}) {
  return {
    USAGE_MONITOR_ACCOUNTLESS_MODE: "production-v1",
    USAGE_MONITOR_ACCOUNTLESS_ORIGIN: ORIGIN,
    ...extra,
  };
}

function privateChannel({ readPreference, backend }) {
  const parent = new EventEmitter();
  const child = new EventEmitter();
  for (const [from, to] of [[parent, child], [child, parent]]) {
    from.connected = true;
    from.send = (value, callback) => queueMicrotask(() => {
      to.emit("message", structuredClone(value));
      callback?.();
    });
  }
  return {
    child,
    host: attachAccountlessParentChannel({ channel: parent, readPreference, backend }),
  };
}

async function until(predicate, timeoutMilliseconds = 3_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for accountless companion");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function dataStore() {
  return {
    async initialize() {},
    async reload() {},
    getOverview() { return {}; },
    getGradient() { return {}; },
    getWeekly() { return {}; },
    getWeeklyPaceOutlook() { return {}; },
    getQuality() { return {}; },
    getReports() { return { reports: [] }; },
  };
}

test("production-v1 profile refuses malformed ambient configuration before legacy paths are normalized", () => {
  const valid = profileEnvironment();
  assert.equal(selectLocalAccountlessProductionProfile({
    environment: valid,
    channel: { connected: true, send() {} },
  }), true);
  for (const environment of [
    { ...valid, USAGE_MONITOR_ACCOUNTLESS_ORIGIN: "https://unreviewed.example" },
    { ...valid, USAGE_MONITOR_TEST_LANE: "accountless-local-lab-v1" },
    { ...valid, USAGE_MONITOR_CENTRAL_ORIGIN: "https://tibotattle.com" },
    { ...valid, USAGE_MONITOR_ACCOUNTLESS_MODE: "other" },
  ]) {
    assert.throws(() => selectLocalAccountlessProductionProfile({
      environment,
      channel: { connected: true, send() {} },
    }), /Invalid accountless contribution configuration/u);
  }
  assert.throws(() => createLocalCompanionServer({
    environment: profileEnvironment({
      USAGE_MONITOR_CONTRIBUTION_QUEUE_FILE: "relative-legacy-queue",
      USAGE_MONITOR_PREPARED_DIRECTORY: "relative-legacy-prepared",
    }),
    accountlessChannel: {},
    contributionQueueFile: "also-relative",
    preparedContributionDirectory: "also-relative",
    legacyContributionDeviceStateFile: "also-relative",
    contributionPreparationOptions: { activityFile: "also-relative" },
  }), /Invalid accountless contribution configuration/u);
  assert.throws(() => createLocalAccountlessContribution({
    environment: profileEnvironment(),
    channel: {},
  }), /Invalid accountless contribution configuration/u);
});

test("production-v1 companion retains account-observation ports while closing legacy contribution authority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "accountless-production-profile-"));
  const resourceRoot = join(root, "resources");
  const staticRoot = join(resourceRoot, "public");
  const stateRoot = join(root, "state");
  const codexHome = join(root, "codex");
  await Promise.all([
    mkdir(staticRoot, { recursive: true }),
    mkdir(codexHome, { recursive: true, mode: 0o700 }),
  ]);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const calls = {
    automaticRetirement: 0,
    retirementLockAcquires: 0,
    retirementLockReleases: 0,
    centralFetch: 0,
    legacyBackend: 0,
    legacyController: 0,
    legacyExactReview: 0,
    legacyHostedSignIn: 0,
    legacyNext: 0,
    legacyPreparation: 0,
    legacyPrompt: 0,
    legacyStatus: 0,
    legacySuperseded: 0,
    privateReads: 0,
  };
  const observed = [];
  let phase = "matching";
  const marker = Object.freeze({ schemaVersion: "synthetic-retained-marker" });
  const { child, host } = privateChannel({
    readPreference: async () => ({
      available: true,
      current: true,
      enabled: true,
      policyVersion: "accountless-opt-out-v1",
      destinationOrigin: ORIGIN,
    }),
    backend: {
      async read() { calls.privateReads += 1; return null; },
      async createIfMissing() { assert.fail("synthetic runner must not mint a credential"); },
      async deleteExact() { assert.fail("synthetic runner must not delete a credential"); },
    },
  });
  const legacyController = Object.freeze({
    start: async () => { calls.legacyController += 1; },
    stop: async () => { calls.legacyController += 1; },
    inspect: async () => { calls.legacyController += 1; return null; },
    approve: async () => { calls.legacyController += 1; },
    resume: async () => { calls.legacyController += 1; },
    pauseForDeviceDisconnect: async () => { calls.legacyController += 1; },
    pauseForDeviceRepair: async () => { calls.legacyController += 1; },
    resumeAfterDeviceRepair: async () => { calls.legacyController += 1; },
  });
  const legacyHostedSignIn = Object.freeze({
    inspect: async () => { calls.legacyHostedSignIn += 1; },
    store: async () => { calls.legacyHostedSignIn += 1; },
    clear: async () => { calls.legacyHostedSignIn += 1; },
  });
  let app;
  try {
    app = await startLocalCompanionServer({
      environment: profileEnvironment({
        USAGE_MONITOR_CONTRIBUTION_QUEUE_FILE: "relative-legacy-queue",
        USAGE_MONITOR_PREPARED_DIRECTORY: "relative-legacy-prepared",
      }),
      accountlessChannel: child,
      resourceRoot,
      staticRoot,
      stateRoot,
      codexHome,
      port: 0,
      dataStore: dataStore(),
      refreshRunner: async () => ({}),
      centralOrigin: "https://must-not-be-selected.example",
      contributionServiceOrigin: "https://must-not-be-selected.example",
      centralFetch: async () => { calls.centralFetch += 1; throw new Error("legacy central fetch"); },
      contributionQueueFile: "also-relative",
      preparedContributionDirectory: "also-relative",
      legacyContributionDeviceStateFile: "also-relative",
      contributionPreparationOptions: { activityFile: "also-relative" },
      contributionDeviceBackendFactory: () => {
        calls.legacyBackend += 1;
        throw new Error("legacy backend");
      },
      contributionDeviceKeychainPromptProvider: () => { calls.legacyPrompt += 1; return "pairing"; },
      contributionPreparationCreateKeychainBackend: () => {
        calls.legacyPreparation += 1;
        throw new Error("legacy identity backend");
      },
      contributionPreparationRunner: async () => {
        calls.legacyPreparation += 1;
        throw new Error("legacy preparation");
      },
      contributionSyncStatusProvider: async () => {
        calls.legacyStatus += 1;
        throw new Error("legacy status");
      },
      contributionSyncNextProvider: async () => {
        calls.legacyNext += 1;
        throw new Error("legacy preview");
      },
      contributionSyncExactReviewProvider: async () => {
        calls.legacyExactReview += 1;
        throw new Error("legacy exact review");
      },
      supersededContributionRetirementRunner: async () => {
        calls.legacySuperseded += 1;
        throw new Error("legacy retirement");
      },
      hostedSignInHandoffController: legacyHostedSignIn,
      incrementalContributionController: legacyController,
      automaticContributionStateRetirementRunner: async () => {
        calls.automaticRetirement += 1;
        throw new Error("automatic retirement");
      },
      automaticContributionRetirementLockAcquirer: async () => {
        calls.retirementLockAcquires += 1;
        return {
          async release() { calls.retirementLockReleases += 1; },
        };
      },
      readContributionAccountMarkers: async () => (
        phase === "absent" ? [] : [marker]
      ),
      loadExistingAccountObservationSecret: async () => {
        if (phase === "failure") throw new Error("synthetic observation unavailable");
        return Buffer.alloc(32, 7);
      },
      accountlessContributionRunner: async (options) => {
        assert.equal(options.production, true);
        assert.equal(options.laboratory, false);
        assert.equal(options.origin, ORIGIN);
        assert.equal(options.stateFile, join(stateRoot, "accountless-device-binding-v1.json"));
        assert.equal(options.progressFile, join(stateRoot, "private", "accountless-upload-progress-v1.json"));
        assert.equal(await options.backend.read(), null);
        const markers = await options.readAccountMarkers();
        let observedRoot = null;
        if (markers.length > 0) {
          try { observedRoot = await options.loadExistingAccountObservationSecret(); }
          catch { observedRoot = null; }
        }
        observed.push({ phase, markerCount: markers.length, rootLoaded: Buffer.isBuffer(observedRoot) });
        observedRoot?.fill(0);
        return { status: "complete", chunksUploaded: 0 };
      },
    });
    await app.snapshotReady;
    await until(() => observed.length === 1);
    phase = "absent";
    await host.invalidate();
    await until(() => observed.length === 2);
    phase = "failure";
    await host.invalidate();
    await until(() => observed.length === 3);

    assert.deepEqual(observed, [
      { phase: "matching", markerCount: 1, rootLoaded: true },
      { phase: "absent", markerCount: 0, rootLoaded: false },
      { phase: "failure", markerCount: 1, rootLoaded: false },
    ]);
    const base = `http://127.0.0.1:${app.port}`;
    const health = await fetch(`${base}/api/local/health`).then((response) => response.json());
    assert.deepEqual(health.capabilities, {
      localDashboard: true,
      explicitRefresh: true,
      contributionPreparation: false,
      contributionPreparationIdentityMode: null,
      contributionSyncStatus: false,
      contributionSyncNext: false,
      contributionDevicePairing: false,
      contributionDeviceDisconnect: false,
      contributionSyncExactReview: false,
      incrementalContributionSync: false,
      centralServiceProxy: false,
      centralParticipantRelay: false,
      arbitraryPathAccess: false,
      remoteProxy: false,
    });
    const diagnostics = await fetch(`${base}/api/local/diagnostics/contribution`)
      .then((response) => response.json());
    assert.equal(diagnostics.journeyPhase, "not_configured");
    for (const path of [
      "/api/local/identity/hosted-signin-handoff",
      "/api/local/contribution/prepare",
      "/api/local/contribution/sync-status",
      "/api/local/contribution/sync-next",
      "/api/local/contribution/device-pair",
      "/api/local/contribution/device-disconnect",
      "/api/local/contribution/device-credential-reset",
      "/api/local/contribution/sync-inspect-exact",
      "/api/local/contribution/incremental-status",
      "/api/local/contribution/incremental-review-v11",
      "/api/local/contribution/incremental-approve",
      "/api/local/contribution/incremental-run",
    ]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 404, path);
      assert.equal((await response.json()).error.code, "not_found", path);
    }
  } finally {
    await app?.close();
    host.dispose();
  }
  assert.equal(calls.privateReads, 3, "the installation secret stays on FD3");
  assert.equal(calls.retirementLockAcquires, 1,
    "the closed profile retains the shared companion instance lock");
  assert.equal(calls.retirementLockReleases, 1,
    "normal companion shutdown releases the shared instance lock once");
  assert.deepEqual({
    automaticRetirement: calls.automaticRetirement,
    centralFetch: calls.centralFetch,
    legacyBackend: calls.legacyBackend,
    legacyController: calls.legacyController,
    legacyExactReview: calls.legacyExactReview,
    legacyHostedSignIn: calls.legacyHostedSignIn,
    legacyNext: calls.legacyNext,
    legacyPreparation: calls.legacyPreparation,
    legacyPrompt: calls.legacyPrompt,
    legacyStatus: calls.legacyStatus,
    legacySuperseded: calls.legacySuperseded,
  }, {
    automaticRetirement: 0,
    centralFetch: 0,
    legacyBackend: 0,
    legacyController: 0,
    legacyExactReview: 0,
    legacyHostedSignIn: 0,
    legacyNext: 0,
    legacyPreparation: 0,
    legacyPrompt: 0,
    legacyStatus: 0,
    legacySuperseded: 0,
  });
});

test("production-v1 startup failure releases the shared instance lock once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "accountless-production-lock-failure-"));
  const resourceRoot = join(root, "resources");
  const staticRoot = join(resourceRoot, "public");
  const stateRoot = join(root, "state");
  const codexHome = join(root, "codex");
  await Promise.all([
    mkdir(staticRoot, { recursive: true }),
    mkdir(codexHome, { recursive: true, mode: 0o700 }),
  ]);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const calls = { acquires: 0, releases: 0 };
  const { child, host } = privateChannel({
    readPreference: async () => ({
      available: true,
      current: true,
      enabled: true,
      policyVersion: "accountless-opt-out-v1",
      destinationOrigin: ORIGIN,
    }),
    backend: {
      async read() { return null; },
      async createIfMissing() { assert.fail("startup failure must not mint a credential"); },
      async deleteExact() { assert.fail("startup failure must not delete a credential"); },
    },
  });
  let app;
  try {
    app = await startLocalCompanionServer({
      environment: profileEnvironment(),
      accountlessChannel: child,
      resourceRoot,
      staticRoot,
      stateRoot,
      codexHome,
      port: 0,
      dataStore: {
        ...dataStore(),
        async initialize() {
          throw new Error("synthetic accountless startup failure");
        },
      },
      refreshRunner: async () => ({}),
      automaticContributionRetirementLockAcquirer: async () => {
        calls.acquires += 1;
        return {
          async release() { calls.releases += 1; },
        };
      },
    });
    await assert.rejects(app.snapshotReady, /synthetic accountless startup failure/u);
  } finally {
    await app?.close();
    host.dispose();
  }
  assert.deepEqual(calls, { acquires: 1, releases: 1 });
});
