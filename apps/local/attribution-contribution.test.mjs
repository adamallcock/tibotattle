import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telemetryV11RequiredConsent } from "@app-usagemonitor/telemetry-contract";
import { incrementalContributionRequiredConsent } from "../../src/incremental-contribution.js";
import { runIncrementalContributionSyncOnce } from "../../src/contribution-incremental-sync.js";
import { buildTelemetryContributionsFromBundle } from "../../src/contribution/index.js";
import { localCompanionStatePaths } from "../../src/local-installation-diagnostics.js";
import { beginUnifiedIndexGeneration, openLocalUnifiedIndex } from "../../src/local-unified-index.js";
import { CommunityClient, LocalCompanionClient } from "../web/public/data-client.js";
import { startLocalCompanionServer } from "./server.js";
import {
  ATTRIBUTION_FIXTURE_BINDING as binding, ATTRIBUTION_FIXTURE_START as start,
  writeAttributionFixture,
} from "../../test/helpers/local-attribution-fixture.js";
import { createAttributionFixtureDevice, createAttributionFixtureService } from "../../test/helpers/attribution-transport-fixture.js";

function legacyReview() {
  const payload = buildTelemetryContributionsFromBundle({
    schemaVersion: "usage-metadata-bundle-v0.1", createdAt: "2026-08-01T12:01:00.000Z",
    coveredAt: { startAt: "2026-08-01T12:00:00.000Z", endAt: "2026-08-01T12:01:00.000Z" },
    clientPlatform: "macos", records: { quotaSnapshots: [], activityMarkers: [], usageEvents: [{
      schemaVersion: "usage-event-v0.1", eventTime: "2026-08-01T12:00:00.000Z", provider: "openai_codex",
      modelId: "gpt-5.6-sol", modelRecognition: "recognized", modelFingerprint: null,
      billingSurface: "chatgpt_subscription", speedMode: "standard", apiServiceTier: "unknown",
      reasoningEffort: "unknown", components: { inputUncachedTokens: 10, inputCacheReadTokens: 20,
        inputCacheWriteTokens: 0, outputTextTokens: 1, outputReasoningTokens: 0 },
      totalInputContextTokens: 30, surface: "extension_or_ide", agentScope: "root",
      lineageDisposition: "standalone", toolClassCounts: { webSearch: 0, fileSearch: 0,
        codeInterpreter: 0, hostedShell: 0, computerUse: 0, mcp: 0, applyPatch: 0,
        localShell: 0, subagent: 0, toolGateway: 0, other: 0, unknown: 0 },
      outcome: "unknown", eventId: `event:v2:${"a".repeat(64)}`,
      sessionScopeId: `session:v1:${"b".repeat(64)}`, accountScopeId: "unattributed",
    }] },
  })[0];
  return { schemaVersion: "contribution-sync-exact-review-v0.1", state: "ready", networkActivity: false,
    discoveredSets: 1, enqueued: 0, payloadBytes: Buffer.byteLength(JSON.stringify(payload)), payload,
    reviewBinding: { jobId: "11111111-1111-4111-8111-111111111111", contributionSha256: "a".repeat(64) } };
}

async function fixture(t, { accepted = true, granted = false, staleSuccessorRepair = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "attribution-http-"));
  const resourceRoot = join(root, "resources");
  const staticRoot = join(resourceRoot, "public");
  const stateRoot = join(root, "state");
  const codexHome = join(root, "codex");
  await mkdir(staticRoot, { recursive: true });
  await mkdir(join(codexHome, "sessions"), { recursive: true, mode: 0o700 });
  await mkdir(join(stateRoot, "private"), { recursive: true, mode: 0o700 });
  const paths = localCompanionStatePaths(stateRoot);
  await writeAttributionFixture(paths.unifiedIndexFile);
  const backend = await createAttributionFixtureDevice(paths.contributionDeviceStateFile);
  const service = createAttributionFixtureService({ accepted, granted });
  await writeFile(paths.incrementalContributionSyncSettingsFile, JSON.stringify({
    schemaVersion: "incremental-contribution-sync-settings-v1.0",
    consent: { ...(staleSuccessorRepair
      ? { ...telemetryV11RequiredConsent(), destinationOrigin: "https://previous.telemetry.example" }
      : incrementalContributionRequiredConsent({ destinationOrigin: binding.destinationOrigin })),
      consentedAt: "2026-08-01T00:00:00.000Z" },
    paused: true, pausedReason: staleSuccessorRepair ? "device_repair_required" : "device_unavailable", retryCount: 0, lastAttemptAt: null,
    lastOutcome: null, nextAttemptAt: null, progress: null,
  }), { mode: 0o600 });
  const app = await startLocalCompanionServer({
    environment: {}, resourceRoot, staticRoot, stateRoot, codexHome, port: 0,
    centralOrigin: binding.destinationOrigin, centralFetch: service.fetchImpl,
    contributionDeviceBackendFactory: () => backend,
    contributionDeviceKeychainPromptProvider: () => "none",
    ...(staleSuccessorRepair ? { contributionDevicePairingProvider: async () => ({
      status: "paired", scope: "upload_registration",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }) } : {}),
    loadExistingAccountObservationSecret: async () => { assert.fail("Missing historical markers cannot load a root"); },
    readContributionAccountMarkers: async () => [],
    clock: () => start,
    incrementalContributionRunner: (options) => runIncrementalContributionSyncOnce({
      ...options, now: () => start, createV11Envelope: service.createEnvelope,
    }),
    contributionSyncExactReviewProvider: async () => legacyReview(),
    dataStore: {
      async initialize() {}, async reload() {}, getOverview() { return {}; },
      getGradient() { return {}; }, getWeekly() { return {}; }, getQuality() { return {}; },
      getReports() { return { reports: [] }; },
    },
    refreshRunner: async () => ({}),
  });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await app.snapshotReady;
  const base = `http://127.0.0.1:${app.port}`;
  const browserFetch = (path, options = {}) => fetch(new URL(path, base), {
    ...options, headers: { ...options.headers, Origin: base,
      ...(String(path).startsWith("/api/v1/") ? { Cookie: "__Host-usage_monitor_session=synthetic_session" } : {}) },
  });
  const local = new LocalCompanionClient({ fetchImpl: browserFetch });
  const hosted = new CommunityClient({ fetchImpl: browserFetch, getCsrfToken: () => "synthetic_csrf_0001" });
  const post = (operation, body, headers = {}) => browserFetch(`/api/local/contribution/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Usage-Monitor-Local": "1", ...headers },
    body: JSON.stringify(body),
  });
  return { paths, base, local, hosted, post, service };
}

test("loopback review -> hosted session grant -> exact local approval -> public runner activation", async (t) => {
  const { local, hosted, service, post } = await fixture(t);
  const before = await local.incrementalContributionSyncStatus();
  assert.equal(before.attributionUpgradeAvailable, true);
  assert.equal(before.contractVersion, undefined, "v1 remains the default until explicitly approved");
  const review = await local.reviewAttributionContribution();
  assert.ok(review.inventory.fields.accountPlanAttribution.includes("accountTrackId"));
  assert.deepEqual(review.sample.recordCounts, { usage: 2, quota: 2, session: 1 });
  assert.equal(review.hostedConsentCurrent, false);
  assert.equal(service.calls.some((call) => call.path.endsWith("day-manifests")), false);
  await hosted.grantAttributionContribution(review);
  assert.equal(service.capability.consentCurrent, true);
  const approved = await local.approveAttributionContribution(review);
  assert.equal(approved.contractVersion, "telemetry-contribution-v1.1");
  let status;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    status = await local.incrementalContributionSyncStatus();
    if (status.progress?.daysSynced === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(status.contractVersion, "telemetry-contribution-v1.1");
  assert.equal(status.consent.current, true);
  assert.equal(status.progress.daysSynced, 1);
  assert.ok(service.active());
  assert.equal((await post("incremental-approve", { reviewToken: review.reviewToken, consent: review.consent,
    fieldInventoryDigest: review.inventory.inventoryDigest })).status, 409);
});

test("a real repair-required pause blocks review until pairing; stale successor consent still requires fresh grant", async (t) => {
  const { local, hosted, service, post } = await fixture(t, { staleSuccessorRepair: true });
  const initial = await local.incrementalContributionSyncStatus();
  assert.equal(initial.contractVersion, "telemetry-contribution-v1.1");
  assert.equal(initial.pausedReason, "device_repair_required");
  assert.equal(initial.consent.approved, true);
  assert.equal(initial.consent.current, false);
  const blocked = await post("incremental-review-v11", {});
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, "device_repair_required");
  assert.equal(service.calls.length, 0, "the repair pause prevents credential-bearing capability/review calls");

  await local.pairContributionDevice(`um_pair_11111111-1111-4111-8111-111111111111.${"A".repeat(43)}`);
  const paired = await local.incrementalContributionSyncStatus();
  assert.equal(paired.paused, false);
  assert.equal(paired.consent.current, false, "repair cannot grant new destination/format consent");
  assert.equal(paired.running, false);
  assert.equal(service.active(), null);
  const review = await local.reviewAttributionContribution();
  assert.equal(review.hostedConsentCurrent, false);
  const ungranted = await post("incremental-approve", { reviewToken: review.reviewToken, consent: review.consent,
    fieldInventoryDigest: review.inventory.inventoryDigest });
  assert.equal(ungranted.status, 409);
  assert.equal((await ungranted.json()).error.code, "hosted_consent_required");
  assert.equal(service.active(), null);
  await hosted.grantAttributionContribution(review);
  const freshReview = await local.reviewAttributionContribution();
  const approved = await local.approveAttributionContribution(freshReview);
  assert.equal(approved.contractVersion, "telemetry-contribution-v1.1");
  let after;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    after = await local.incrementalContributionSyncStatus();
    if (after.progress?.daysSynced === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(after.consent.current, true);
  assert.equal(after.progress?.daysSynced, 1);
  assert.ok(service.active());
});

test("accepted capability alone cannot approve without the independent fresh hosted grant", async (t) => {
  const { local, post, service } = await fixture(t);
  const review = await local.reviewAttributionContribution();
  const response = await post("incremental-approve", { reviewToken: review.reviewToken, consent: review.consent,
    fieldInventoryDigest: review.inventory.inventoryDigest });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "hosted_consent_required");
  assert.equal((await local.incrementalContributionSyncStatus()).contractVersion, undefined);
  assert.equal(service.calls.some((call) => call.path.endsWith("device-telemetry-consents")), false);
  assert.equal(service.active(), null);
});

test("staged default stays hidden and cannot produce a review token", async (t) => {
  const { local, post, service } = await fixture(t, { accepted: false });
  assert.equal((await local.incrementalContributionSyncStatus()).attributionUpgradeAvailable, undefined);
  const response = await post("incremental-review-v11", {});
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "attribution_review_unavailable");
  assert.equal(service.calls.some((call) => call.path.endsWith("day-manifests")), false);
});

test("review capabilities are schema-specific and bind exact dictionary, destination, inventory and publication", async (t) => {
  const { local, post, paths } = await fixture(t, { granted: true });
  const legacy = await (await post("sync-inspect-exact", {})).json();
  assert.match(legacy.reviewToken, /^[A-Za-z0-9_-]{43}$/u);
  const initial = await local.reviewAttributionContribution();
  for (const alteration of [
    (review) => ({ reviewToken: review.reviewToken }),
    (review) => ({ reviewToken: legacy.reviewToken, consent: review.consent, fieldInventoryDigest: review.inventory.inventoryDigest }),
    (review) => ({ reviewToken: review.reviewToken, consent: { ...review.consent, destinationOrigin: "https://other.example" }, fieldInventoryDigest: review.inventory.inventoryDigest }),
    (review) => ({ reviewToken: review.reviewToken, consent: { ...review.consent, fieldDictionaryVersion: "older" }, fieldInventoryDigest: review.inventory.inventoryDigest }),
    (review) => ({ reviewToken: review.reviewToken, consent: review.consent, fieldInventoryDigest: "0".repeat(64) }),
  ]) {
    const review = await local.reviewAttributionContribution();
    assert.equal((await post("incremental-approve", alteration(review))).status, 409);
  }
  const database = openLocalUnifiedIndex(paths.unifiedIndexFile);
  beginUnifiedIndexGeneration(database, { contractVersion: "usage-event-v0.2", receivedAtMs: start + 1,
    discoveredSourceCount: 1, discoveredSourceBytes: 8192 });
  database.close();
  assert.equal((await post("incremental-approve", { reviewToken: initial.reviewToken, consent: initial.consent,
    fieldInventoryDigest: initial.inventory.inventoryDigest })).status, 409);
  assert.equal((await local.incrementalContributionSyncStatus()).contractVersion, undefined);
});

test("new review route retains method, origin, local capability, exact-body and relay authority fences", async (t) => {
  const { base, post, service } = await fixture(t);
  const endpoint = `${base}/api/local/contribution/incremental-review-v11`;
  assert.equal((await fetch(endpoint)).status, 405);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { Origin: "https://other.example", "Content-Type": "application/json", "X-Usage-Monitor-Local": "1" }, body: "{}" })).status, 403);
  assert.equal((await post("incremental-review-v11", { unreviewed: true })).status, 400);
  const response = await fetch(`${base}/api/v1/me/device-telemetry-consents`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json", Authorization: "Device synthetic" },
    body: JSON.stringify({ consent: telemetryV11RequiredConsent(), ongoingUpload: true }),
  });
  assert.equal(response.status, 400);
  assert.equal(service.calls.some((call) => call.path.endsWith("device-telemetry-consents")), false);
});
