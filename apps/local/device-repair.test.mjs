import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_COMPANION_SCHEMA_VERSION } from "../../src/local-companion-data.js";
import { ensureContributionDeviceCapability } from "../../src/contribution-device-capability.js";
import { writeContributionDeviceRenewalState } from "../../src/contribution-device-renewal.js";
import { startLocalCompanionServer } from "./server.js";

const ORIGIN = "https://usage.example";
const PAIRING_CODE = `um_pair_11111111-1111-4111-8111-111111111111.${"A".repeat(43)}`;
const PAIRED = { status: "paired", scope: "upload_registration", expiresAt: "2026-10-01T00:00:00.000Z" };
const RUN = { schemaVersion: "incremental-contribution-sync-run-v1.0", status: "complete",
  daysTotal: 1, daysSynced: 1, daysPending: 0, chunksUploaded: 1, chunksSkipped: 0,
  recordsUploaded: 1, acknowledgedThroughDay: "2026-08-01", orphanChunkIds: [], failure: null, networkActivity: true };

function initialSettings() {
  return { schemaVersion: "incremental-contribution-sync-settings-v1.0",
    consent: { consentedAt: "2026-08-03T00:00:00.000Z", destinationOrigin: ORIGIN,
      telemetrySchemaVersion: "telemetry-contribution-v1.0", fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0" },
    paused: true, pausedReason: "device_unavailable", retryCount: 2, lastAttemptAt: "2026-08-03T01:00:00.000Z",
    lastOutcome: { at: "2026-08-03T01:00:01.000Z", code: "partial_progress", status: "partial" },
    nextAttemptAt: null, progress: { daysTotal: 5, daysSynced: 2, daysPending: 3, chunksUploaded: 4,
      acknowledgedThroughDay: "2026-08-02" } };
}

async function fixture(t, { bindingPresent = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "companion-repair-"));
  const resourceRoot = join(root, "resources");
  const stateRoot = join(root, "state");
  const staticRoot = join(resourceRoot, "public");
  const codexHome = join(root, "codex");
  const settingsFile = join(stateRoot, "private", "incremental-contribution-sync-v1.json");
  const apps = new Set();
  await mkdir(staticRoot, { recursive: true });
  await mkdir(join(codexHome, "sessions"), { recursive: true, mode: 0o700 });
  await mkdir(join(stateRoot, "private"), { recursive: true, mode: 0o700 });
  await writeFile(settingsFile, JSON.stringify(initialSettings()), { mode: 0o600 });
  if (bindingPresent) await writeFile(join(stateRoot, "contribution-device-binding-v1.json"), "{}", { mode: 0o600 });
  t.after(async () => { await Promise.all([...apps].map((app) => app.close())); await rm(root, { recursive: true }); });
  return { settingsFile, stateRoot,
    async settings() { return JSON.parse(await readFile(settingsFile, "utf8")); },
    async start(overrides = {}) {
      const app = await startLocalCompanionServer({ resourceRoot, stateRoot, staticRoot, codexHome, port: 0,
        dataStore: { async initialize() {}, async reload() {},
          getOverview() { return { schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION }; },
          getGradient() { return {}; }, getWeekly() { return {}; }, getQuality() { return {}; }, getReports() { return { reports: [] }; } },
        refreshRunner: async () => ({}), contributionServiceOrigin: ORIGIN,
        contributionDeviceKeychainPromptProvider: () => "none", contributionDeviceBackendFactory: () => ({}),
        incrementalContributionRunner: async () => RUN,
        incrementalAttributionCapabilitiesProvider: async () => null,
        incrementalAttributionReviewProvider: async () => null,
        ...overrides });
      apps.add(app);
      await app.snapshotReady;
      return { ...app, base: `http://127.0.0.1:${app.port}`,
        async close() { apps.delete(app); await app.close(); } };
    } };
}

function post(base, operation, body = {}) {
  return fetch(`${base}/api/local/contribution/${operation}`, { method: "POST",
    headers: { Origin: base, "Content-Type": "application/json", "X-Usage-Monitor-Local": "1" }, body: JSON.stringify(body) });
}
async function settles() { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); }
async function status(base) { return fetch(`${base}/api/local/contribution/incremental-status`).then((response) => response.json()); }
async function error(response, code) { assert.equal(response.status, 409); assert.equal((await response.json()).error.code, code); }
async function waitForSignal(promise, readState) {
  let timer;
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(async () => {
        const state = await readState();
        reject(new Error(`Expected synthetic signal; state=${JSON.stringify({ pausedReason: state.pausedReason,
          lastOutcome: state.lastOutcome, nextAttemptAt: state.nextAttemptAt })}`));
      }, 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

test("pair-first holds old-credential work until durable repair and resumes only after releasing the repair guard", async (t) => {
  const files = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const ran = Promise.withResolvers();
  let pairingPending = false;
  let runs = 0;
  let reads = 0;
  const app = await files.start({
    contributionDevicePairingProvider: async () => { pairingPending = true; entered.resolve(); await release.promise; pairingPending = false; return PAIRED; },
    incrementalContributionRunner: async () => { assert.equal(pairingPending, false); runs += 1; ran.resolve(); return RUN; },
    incrementalAttributionCapabilitiesProvider: async () => { reads += 1; return null; },
    incrementalAttributionReviewProvider: async () => { reads += 1; return null; },
  });
  const pending = post(app.base, "device-pair", { pairingCode: PAIRING_CODE });
  try {
    await entered.promise;
    await error(await post(app.base, "incremental-run"), "sync_in_progress");
    await error(await post(app.base, "incremental-approve", { reviewToken: "A".repeat(43) }), "sync_in_progress");
    await error(await post(app.base, "incremental-review-v11"), "sync_in_progress");
    await error(await post(app.base, "device-pair", { pairingCode: PAIRING_CODE }), "sync_in_progress");
    const paused = await status(app.base);
    assert.equal(paused.pausedReason, "device_repair_required");
    assert.equal((await files.settings()).pausedReason, "device_repair_required");
    assert.equal(paused.attributionUpgrade, undefined);
    assert.equal(reads, 0);
    assert.equal(runs, 0);
  } finally { release.resolve(); await pending; }
  await ran.promise;
  await settles();
  assert.equal(runs, 1);
  assert.equal((await files.settings()).pausedReason, null);
});

test("sync-first prevents a concurrent pairing from rotating its leased credential", async (t) => {
  const files = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let pairs = 0;
  let reads = 0;
  const app = await files.start({
    contributionDevicePairingProvider: async () => { pairs += 1; return PAIRED; },
    incrementalContributionRunner: async () => { entered.resolve(); await release.promise; return RUN; },
    incrementalAttributionCapabilitiesProvider: async () => { reads += 1; return null; },
  });
  try {
    assert.equal((await post(app.base, "incremental-run")).status, 200);
    await entered.promise;
    await error(await post(app.base, "device-pair", { pairingCode: PAIRING_CODE }), "sync_in_progress");
    await status(app.base);
    assert.equal(pairs, 0);
    assert.equal(reads, 0);
  } finally { release.resolve(); await settles(); }
});

for (const failure of ["lost_ack", "local_cas_failed"]) test(`pairing ${failure} preserves repair pause across restart and manual/background actions`, async (t) => {
  const files = await fixture(t);
  const before = await files.settings();
  let fail = true;
  let pairs = 0;
  let reads = 0;
  let runs = 0;
  const ran = Promise.withResolvers();
  const overrides = {
    contributionDevicePairingProvider: async () => {
      pairs += 1;
      const paused = await files.settings();
      assert.deepEqual(paused, { ...before, paused: true, pausedReason: "device_repair_required", nextAttemptAt: null });
      if (fail) {
        const error = new Error("synthetic post-commit failure");
        error.code = failure === "lost_ack" ? "contribution_device_client_service_unavailable" : "contribution_device_credential_conflict";
        throw error;
      }
      return PAIRED;
    },
    incrementalContributionRunner: async () => { runs += 1; ran.resolve(); return RUN; },
    incrementalAttributionCapabilitiesProvider: async () => { reads += 1; return null; },
    incrementalAttributionReviewProvider: async () => { reads += 1; return null; },
  };
  let app = await files.start(overrides);
  const paired = await post(app.base, "device-pair", { pairingCode: PAIRING_CODE });
  assert.equal(paired.status, failure === "lost_ack" ? 502 : 409);
  for (let restart = 0; restart < 2; restart += 1) {
    await error(await post(app.base, "incremental-run"), "device_repair_required");
    await error(await post(app.base, "incremental-approve", { reviewToken: "A".repeat(43) }), "device_repair_required");
    await error(await post(app.base, "incremental-review-v11"), "device_repair_required");
    await error(await post(app.base, "device-disconnect", { confirm: "disconnect_this_mac" }), "device_repair_required");
    const paused = await status(app.base);
    assert.equal(paused.pausedReason, "device_repair_required");
    assert.equal(paused.attributionUpgrade, undefined);
    assert.equal(paused.nextAttemptAt, null);
    assert.deepEqual(paused.progress, before.progress);
    assert.equal(reads, 0);
    assert.equal(runs, 0);
    assert.equal(pairs, 1);
    if (restart === 0) { await app.close(); app = await files.start(overrides); }
  }
  fail = false;
  assert.equal((await post(app.base, "device-pair", { pairingCode: PAIRING_CODE })).status, 200);
  await ran.promise;
  await settles();
  assert.equal(pairs, 2);
  assert.equal(runs, 1);
  assert.equal((await files.settings()).pausedReason, null);
  assert.deepEqual((await files.settings()).consent, before.consent);
});

for (const operation of ["capabilities", "review"]) test(`an existing ${operation} credential read excludes pairing and sync`, async (t) => {
  const files = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let pairs = 0;
  let runs = 0;
  const provider = async () => { entered.resolve(); await release.promise; return null; };
  const app = await files.start({
    contributionDevicePairingProvider: async () => { pairs += 1; return PAIRED; },
    incrementalContributionRunner: async () => { runs += 1; return RUN; },
    ...(operation === "capabilities" ? { incrementalAttributionCapabilitiesProvider: provider }
      : { incrementalAttributionReviewProvider: provider }),
  });
  const pending = operation === "capabilities" ? status(app.base) : post(app.base, "incremental-review-v11");
  try {
    await entered.promise;
    await error(await post(app.base, "device-pair", { pairingCode: PAIRING_CODE }), "sync_in_progress");
    await error(await post(app.base, "incremental-run"), "sync_in_progress");
    assert.equal(pairs, 0);
    assert.equal(runs, 0);
  } finally { release.resolve(); await pending; }
});

test("unavailable settings cannot begin a remote pairing or erase the unreadable pause", async (t) => {
  const files = await fixture(t);
  await writeFile(files.settingsFile, "synthetic unreadable settings", { mode: 0o600 });
  let pairs = 0;
  let reads = 0;
  const app = await files.start({
    contributionDevicePairingProvider: async () => { pairs += 1; return PAIRED; },
    incrementalAttributionCapabilitiesProvider: async () => { reads += 1; return null; },
  });
  assert.equal((await post(app.base, "device-pair", { pairingCode: PAIRING_CODE })).status, 500);
  assert.equal(pairs, 0);
  await status(app.base);
  assert.equal(reads, 0);
  assert.equal(await readFile(files.settingsFile, "utf8"), "synthetic unreadable settings");
});

for (const completion of ["success", "lost_ack", "local_cas_failed", "tracker_write_failed"]) test(`monthly renewal ${completion} fences old-secret delivery and persists uncertainty`, async (t) => {
  const files = await fixture(t, { bindingPresent: false });
  const deviceId = "11111111-1111-4111-8111-111111111111";
  let secret = null;
  let committed = false;
  let replaced = false;
  const remote = Promise.withResolvers();
  const release = Promise.withResolvers();
  const ran = Promise.withResolvers();
  const backend = {
    async read() { return secret === null ? null : Buffer.from(secret); },
    async createIfMissing(_capability, value) { secret = Buffer.from(value); return "created"; },
    async replaceExact(_capability, oldValue, newValue) {
      assert.equal(committed, true);
      assert.deepEqual(oldValue, secret);
      if (completion === "local_cas_failed") return "conflict";
      secret.fill(0); secret = Buffer.from(newValue); replaced = true; return "replaced";
    },
    async deleteExact() { throw new Error("Unexpected synthetic deletion"); },
  };
  t.after(() => secret?.fill(0));
  await ensureContributionDeviceCapability({ backend, origin: ORIGIN,
    stateFile: join(files.stateRoot, "contribution-device-binding-v1.json"),
    generateDeviceId: () => deviceId, generateSecret: () => Buffer.alloc(32, 21) });
  const renewalFile = join(files.stateRoot, "contribution-device-renewal-v1.json");
  await writeContributionDeviceRenewalState(renewalFile, {
    deviceId, expiresAt: "2026-08-01T00:00:00.000Z",
  });
  let requests = 0;
  let runs = 0;
  const overrides = {
    contributionDeviceBackendFactory: () => backend,
    centralFetch: async (url, request) => {
      assert.equal(new URL(url).pathname, "/api/v1/device/credential/renew");
      assert.equal(request.signal?.aborted ?? false, false, "pausing uploads must not abort the rotation/CAS operation");
      assert.equal((await files.settings()).pausedReason, "device_repair_required");
      requests += 1;
      committed = true;
      remote.resolve();
      await release.promise;
      if (completion === "lost_ack") throw new Error("synthetic response lost after commit");
      if (completion === "tracker_write_failed") {
        await rename(renewalFile, `${renewalFile}.retained`);
        await mkdir(renewalFile, { mode: 0o700 });
      }
      return new Response(JSON.stringify({ schemaVersion: "device-credential-renewal-v1.0", deviceId,
        state: "active", scope: "upload_registration", commit: true, credentialGeneration: 2,
        expiresAt: "2099-10-01T00:00:00.000Z" }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    },
    incrementalContributionRunner: async ({ signal }) => {
      assert.equal(replaced, true); assert.equal(signal.aborted, false);
      assert.equal((await files.settings()).pausedReason, null);
      runs += 1; ran.resolve(); return RUN;
    },
  };
  let app = await files.start(overrides);
  try {
    assert.equal((await post(app.base, "incremental-run")).status, 200);
    await waitForSignal(remote.promise, files.settings);
    await error(await post(app.base, "incremental-run"), "sync_in_progress");
    assert.equal(runs, 0);
  } finally { release.resolve(); }
  if (completion === "success") {
    await waitForSignal(ran.promise, files.settings);
    await settles();
    assert.equal(runs, 1);
    assert.equal(requests, 1);
  } else {
    await app.close();
    app = await files.start(overrides);
    assert.equal((await status(app.base)).pausedReason, "device_repair_required");
    await error(await post(app.base, "incremental-run"), "device_repair_required");
    assert.equal(requests, 1);
    assert.equal(runs, 0);
    assert.equal(replaced, completion === "tracker_write_failed");
  }
});

test("credential reset holds the same exclusion and never clears a repair-required pause", async (t) => {
  const files = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let pairs = 0;
  let reads = 0;
  const app = await files.start({
    contributionDeviceCredentialResetRunner: async () => {
      assert.equal((await files.settings()).pausedReason, "device_repair_required");
      entered.resolve(); await release.promise;
      return { status: "reset", credential: "deleted", binding: "removed" };
    },
    contributionDevicePairingProvider: async () => { pairs += 1; return PAIRED; },
    incrementalAttributionCapabilitiesProvider: async () => { reads += 1; return null; },
  });
  const pending = post(app.base, "device-credential-reset", { confirm: "reset_device_credential" });
  try {
    await entered.promise;
    await error(await post(app.base, "device-pair", { pairingCode: PAIRING_CODE }), "sync_in_progress");
    await error(await post(app.base, "incremental-run"), "sync_in_progress");
    await status(app.base);
    assert.equal(pairs, 0); assert.equal(reads, 0);
  } finally { release.resolve(); }
  assert.equal((await pending).status, 200);
  assert.equal((await files.settings()).pausedReason, "device_repair_required");
  await error(await post(app.base, "incremental-run"), "device_repair_required");
});
