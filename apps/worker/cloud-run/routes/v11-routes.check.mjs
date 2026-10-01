/**
 * Storage-free checks of the v1.1 origin route modules and the
 * telemetry-envelope-v1.1 registration (GCP fast path, IN-2): configuration
 * refusals, the Worker's request preamble answers (method, cookie, tombstone,
 * collection control, content type, size, JSON), error-body masking, and the
 * envelope's closed key set and pre-storage refusals. Storage adapters are
 * synthetic stubs; postgres-test/postgres-telemetry-v11-live.spec.mjs runs
 * the same modules against PostgreSQL 17.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createContributionEnvelopeRegistry } from "../contribution-envelope-registry.mjs";
import { createTelemetryV11ContributionEnvelope, hasExactV11EnvelopeKeyOccurrences } from "../envelopes/v11.mjs";
import { createTelemetryV11ConsentRouteModule } from "./v11-device-telemetry-consents.mjs";
import { createTelemetryV11DayManifestRouteModules } from "./v11-day-manifests.mjs";
import { createTelemetryV11DomainActivateRouteModule } from "./v11-domain-activate.mjs";
import { createTelemetryV11DomainPredecessorRouteModule } from "./v11-domain-predecessor.mjs";

const ORIGIN = "http://127.0.0.1:8787";
const pool = { connect() { throw new Error("storage is not used by this check"); } };
const schema = Object.freeze({ primarySchema: "synthetic_primary", ledgerSchema: "synthetic_ledger" });
const readBoundedRequestBody = async (request) => new Uint8Array(await request.arrayBuffer());

function deviceDependencies(overrides = {}) {
  return {
    primaryPool: pool, ledgerPool: { connect: pool.connect }, schema, admissionEnv: {},
    assertAdmissionBindings() {},
    async assertAttemptAllowed() {},
    async authenticateDevice() { return { participantId: "participant:synthetic", deviceId: "device-synthetic" }; },
    async hasDeletionTombstone() { return false; },
    async assertCollectionControl() {},
    readBoundedRequestBody,
    maxRequestBytes: 64,
    createDomain() {
      return {
        async createPredecessor() { return { schemaVersion: "telemetry-domain-predecessor-v1.1" }; },
        async activate() { return { schemaVersion: "telemetry-domain-activation-v1.1" }; },
      };
    },
    ...overrides,
  };
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(body.error.code, code);
  assert.match(body.error.requestId, /^[0-9a-f-]{36}$/u);
  return response;
}

const request = (path, init = {}) => new Request(`${ORIGIN}${path}`, {
  method: init.method ?? "POST",
  headers: { authorization: "Device synthetic", "content-type": "application/json", ...init.headers },
  ...(init.body === undefined ? {} : { body: init.body }),
});

test("v1.1 route modules refuse incomplete composition at startup", () => {
  for (const factory of [createTelemetryV11DomainPredecessorRouteModule, createTelemetryV11DomainActivateRouteModule]) {
    assert.throws(() => factory({ ...deviceDependencies(), createDomain: undefined }),
      { code: "TELEMETRY_V11_ROUTE_CONFIGURATION_INVALID" });
    assert.throws(() => factory({ ...deviceDependencies(), maxRequestBytes: 0 }),
      { code: "TELEMETRY_V11_ROUTE_CONFIGURATION_INVALID" });
  }
  assert.throws(() => createTelemetryV11DayManifestRouteModules(deviceDependencies()),
    { code: "TELEMETRY_V11_ROUTE_CONFIGURATION_INVALID" });
  assert.throws(() => createTelemetryV11ConsentRouteModule({ primaryPool: pool }),
    { code: "TELEMETRY_V11_ROUTE_CONFIGURATION_INVALID" });
  const modules = createTelemetryV11DayManifestRouteModules({
    ...deviceDependencies(),
    async registerDayManifest() { return {}; },
    async readDayChunkVector() { return []; },
    async readDayCandidates() { return { candidates: [], bounded: false }; },
  });
  assert.deepEqual(modules.map((entry) => [entry.method, entry.pathname, entry.overridesBuiltIn]), [
    ["GET", "/api/v1/device/telemetry/v1.1/day-manifests", false],
    ["POST", "/api/v1/device/telemetry/v1.1/day-manifests", false],
  ]);
});

test("v1.1 device routes answer the Worker's preamble codes before storage", async () => {
  const path = "/api/v1/me/telemetry-v11/domain-predecessor";
  const route = createTelemetryV11DomainPredecessorRouteModule(deviceDependencies());
  const notAllowed = await expectError(await route.handler(request(path, { method: "GET" })), 405, "METHOD_NOT_ALLOWED");
  assert.equal(notAllowed.headers.get("allow"), "POST");
  await expectError(await route.handler(request(path, { headers: { cookie: "session=x" }, body: "{}" })),
    401, "DEVICE_AUTH_INVALID");
  const tombstoned = createTelemetryV11DomainPredecessorRouteModule(deviceDependencies({
    async hasDeletionTombstone() { return true; },
  }));
  await expectError(await tombstoned.handler(request(path, { body: "{}" })), 401, "DEVICE_AUTH_INVALID");
  const contained = createTelemetryV11DomainPredecessorRouteModule(deviceDependencies({
    async assertCollectionControl() {
      throw Object.assign(new Error("PROCESSING_DISABLED"), { status: 503, code: "PROCESSING_DISABLED" });
    },
  }));
  await expectError(await contained.handler(request(path, { body: "{}" })), 503, "PROCESSING_DISABLED");
  await expectError(await route.handler(request(path, { headers: { "content-type": "text/plain" }, body: "{}" })),
    415, "CONTENT_TYPE_INVALID");
  const oversized = JSON.stringify({ padding: "x".repeat(80) });
  await expectError(await route.handler(request(path, {
    headers: { "content-length": String(oversized.length) }, body: oversized,
  })), 413, "BODY_TOO_LARGE");
  await expectError(await route.handler(request(path, { headers: { "content-length": "-1" }, body: "{}" })),
    400, "BODY_INVALID");
  await expectError(await route.handler(request(path, { body: "{" })), 400, "BODY_INVALID");
  await expectError(await route.handler(request(path, { body: "{\"previousGenerationId\":null}" })), 400, "BODY_INVALID");
  const created = await route.handler(request(path, { body: "{}" }));
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { schemaVersion: "telemetry-domain-predecessor-v1.1" });

  const manifests = createTelemetryV11DayManifestRouteModules({
    ...deviceDependencies(),
    async registerDayManifest() { return {}; },
    async readDayChunkVector() { return []; },
    async readDayCandidates() { return { candidates: [], bounded: false }; },
  });
  const manifestPath = "/api/v1/device/telemetry/v1.1/day-manifests";
  const wrongMethod = await expectError(await manifests[1].handler(request(manifestPath, { method: "DELETE" })),
    405, "METHOD_NOT_ALLOWED");
  assert.equal(wrongMethod.headers.get("allow"), "GET, POST");
  await expectError(await manifests[0].handler(request(`${manifestPath}?fromDay=2026-09-30`, { method: "GET" })),
    400, "BODY_INVALID");
  await expectError(await manifests[0].handler(request(
    `${manifestPath}?fromDay=2026-09-30&toDay=2026-09-30&toDay=2026-10-01`, { method: "GET" },
  )), 400, "BODY_INVALID");
});

test("a failure that is not a closed error is the Worker's 500 without its text", async () => {
  const route = createTelemetryV11DomainActivateRouteModule(deviceDependencies({
    createDomain() {
      return { async activate() { throw new TypeError("relation \"secret_table\" does not exist"); } };
    },
  }));
  const response = await route.handler(request("/api/v1/me/telemetry-v11/domain-activate", { body: "{}" }));
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.match(text, /"code":"INTERNAL_ERROR"/u);
  assert.doesNotMatch(text, /secret_table|relation/u);
});

test("the consent route needs a session without a bearer and the Worker's three body keys", async () => {
  const granted = [];
  const route = createTelemetryV11ConsentRouteModule({
    primaryPool: pool, ledgerPool: { connect: pool.connect }, schema,
    async authenticatePersonalSession() {
      return { participantId: "participant:synthetic", sessionId: "session-synthetic", csrfToken: "csrf", consentVersion: "privacy-safe-telemetry-v0.1" };
    },
    assertPersonalSessionCsrf() {},
    async hasDeletionTombstone() { return false; },
    async assertCollectionControl() {},
    async grantConsent(...args) { granted.push(args); return { consent: {}, minimumWriteRank: 11 }; },
    readBoundedRequestBody,
    maxRequestBytes: 4096,
    socialConsentVersion: "privacy-safe-telemetry-v0.1",
  });
  const path = "/api/v1/me/device-telemetry-consents";
  await expectError(await route.handler(request(path, { body: "{}" })), 401, "AUTH_INVALID");
  const sessionRequest = (body) => new Request(`${ORIGIN}${path}`, {
    method: "POST", headers: { "content-type": "application/json", cookie: "session=x" }, body,
  });
  await expectError(await route.handler(sessionRequest(JSON.stringify({ deviceId: "d", consent: {}, ongoingUpload: true, extra: 1 }))),
    400, "BODY_INVALID");
  await expectError(await route.handler(sessionRequest(JSON.stringify({ deviceId: "d", consent: {} }))), 400, "BODY_INVALID");
  const ok = await route.handler(sessionRequest(JSON.stringify({ deviceId: "d", consent: {}, ongoingUpload: true })));
  assert.equal(ok.status, 201);
  assert.equal(ok.headers.get("vary"), "Cookie");
  assert.equal(granted.length, 1);
  assert.deepEqual(granted[0][1], { participantId: "participant:synthetic", sessionId: "session-synthetic", deviceId: "d" });
});

test("the v1.1 envelope registration keeps the Worker's closed keys and pre-storage refusals", async () => {
  const envelope = {
    schemaVersion: "telemetry-envelope-v1.1", synthetic: false, keyId: "key:synthetic",
    wrappedKey: "A".repeat(342), iv: "B".repeat(16), ciphertext: "C".repeat(32),
  };
  const raw = JSON.stringify(envelope);
  assert.equal(hasExactV11EnvelopeKeyOccurrences(raw), true);
  assert.equal(hasExactV11EnvelopeKeyOccurrences(JSON.stringify({ ...envelope, extra: 1 })), false);
  assert.equal(hasExactV11EnvelopeKeyOccurrences(raw.replace("\"iv\"", "\"IV\"")), false);
  assert.equal(hasExactV11EnvelopeKeyOccurrences(null), false);

  const calls = [];
  const dependency = (name) => async () => { calls.push(name); throw new Error("storage is not used by this check"); };
  const dependencies = Object.fromEntries([
    "readStorageReplay", "persistStagedChunk", "readUploadOutcome", "recordUploadReceipt",
    "registerPendingObject", "retirePendingObject", "abandonUploadAuthorization", "validateStagedChunk",
    "decryptSyntheticEnvelope", "sha256Hex",
  ].map((name) => [name, dependency(name)]));
  const configuration = {
    ...dependencies, socialConsentVersion: "privacy-safe-telemetry-v0.1", sourceNamespace: "synthetic-namespace",
    envelopePublicJwk: "{}", envelopePrivateJwk: "{}",
  };
  assert.throws(() => createTelemetryV11ContributionEnvelope({ ...configuration, sha256Hex: undefined }),
    { code: "TELEMETRY_V11_ENVELOPE_CONFIGURATION_INVALID" });
  assert.throws(() => createTelemetryV11ContributionEnvelope({ ...configuration, sourceNamespace: "" }),
    { code: "TELEMETRY_V11_ENVELOPE_CONFIGURATION_INVALID" });
  const registry = createContributionEnvelopeRegistry([createTelemetryV11ContributionEnvelope(configuration)]);
  assert.deepEqual(registry.schemaVersions, ["telemetry-envelope-v1.1"]);
  const handler = registry.resolve("telemetry-envelope-v1.1");
  const context = { primaryPool: pool, schema, objectStore: { async put() {}, async delete() {} } };
  const social = { id: "participant:synthetic", consentVersion: "privacy-safe-telemetry-v0.1", ownerKind: "social" };
  const refusal = async (promise) => {
    try { await promise; } catch (error) { return { status: error.status, code: error.code }; }
    assert.fail("expected a refusal");
  };
  const extra = JSON.stringify({ ...envelope, extra: 1 });
  assert.deepEqual(await refusal(handler({ raw: extra, value: JSON.parse(extra) }, social, "device", { authorizationId: "a" }, context)),
    { status: 400, code: "ENVELOPE_INVALID" });
  assert.deepEqual(await refusal(handler({ raw, value: envelope }, { ...social, consentVersion: null }, "device",
    { authorizationId: "a" }, context)), { status: 400, code: "TELEMETRY_REQUIRED" });
  assert.deepEqual(await refusal(handler({ raw, value: envelope }, { ...social, ownerKind: "accountless" }, "device",
    { authorizationId: "a" }, context)), { status: 400, code: "TELEMETRY_REQUIRED" });
  const syntheticEnvelope = JSON.stringify({ ...envelope, synthetic: true });
  assert.deepEqual(await refusal(handler({ raw: syntheticEnvelope, value: JSON.parse(syntheticEnvelope) }, social, "device",
    { authorizationId: "a" }, context)), { status: 500, code: "INTERNAL_ERROR" });
  assert.deepEqual(calls, [], "every refusal above precedes decryption and storage");
});
