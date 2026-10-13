/**
 * Storage-free checks of the restored performance intake route family
 * (routes/performance-telemetry.mjs) and its refusal recorder
 * (src/postgres-performance-refusal-counts.ts).
 *
 * The admission steps are the REAL src/admission.ts helpers behind the
 * origin's EP-6 edge-admission replay bindings
 * (postgres-edge-admission-limiters.mjs), so a limiter called at the wrong
 * point, with the wrong purpose or twice fails closed exactly as it would in
 * production. The bounded body reader, the performance envelope validator,
 * the envelope decryption and sha256 are the real Worker modules, driven with
 * a freshly generated RSA pair. Only storage is synthetic: the policy and
 * report adapters (SPD-G2, SPD-G3) are recording fakes, and the recorder runs
 * against a synthetic pool. postgres-test/postgres-performance-telemetry-host.spec.mjs
 * (SPD-X1b) runs the composed family against PostgreSQL 17.
 *
 * Oracle for every order and answer: d43c8f92 / D (22d9d90f5) src/index.ts
 * handleAccountlessTelemetryPerformanceAuthorization (804-838),
 * deviceSyncPrincipal and handleTelemetryPerformanceCapabilities/Reports
 * (3019-3044, 3094-3199). Every fixture value is synthetic.
 */

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { dirname, resolve } from "node:path";
import { after, before, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import {
  createPerformanceTelemetryDispatch,
  PERFORMANCE_TELEMETRY_PATHNAMES,
  PERFORMANCE_TELEMETRY_REFUSAL_BOUND_MILLISECONDS,
  PERFORMANCE_TELEMETRY_ROUTE_IDS,
} from "./performance-telemetry.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORIGIN = "http://127.0.0.1:8787";
const GRANT = PERFORMANCE_TELEMETRY_PATHNAMES.accountless_telemetry_performance_authorization;
const CAPABILITIES = PERFORMANCE_TELEMETRY_PATHNAMES.telemetry_performance_capabilities;
const REPORTS = PERFORMANCE_TELEMETRY_PATHNAMES.telemetry_performance_reports;
const VALID_BEARER = "Device synthetic-device.synthetic-secret";
const KEY_ID = "key:performance-route-check";
const SCHEMA = Object.freeze({ primarySchema: "synthetic_primary" });
const IDENTITY_LINK_SECRET = "synthetic-origin-identity-link-secret-0000000000";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const PRINCIPAL = Object.freeze({ participantId: "participant:synthetic-0001", deviceId: "device-synthetic-0001" });
const GRANT_V1 = Object.freeze({
  schemaVersion: "accountless-performance-owner-v1",
  policyVersion: "accountless-telemetry-performance-policy-v1",
  authorizationBasis: "accountless-performance-policy-v1",
});
const GRANT_V2 = Object.freeze({
  schemaVersion: "accountless-performance-owner-v2",
  policyVersion: "accountless-telemetry-performance-policy-v1",
  authorizationBasis: "accountless-performance-policy-v1",
  fieldDictionaryVersion: "telemetry-performance-registry-2026-10-10.1",
});
const CAPABILITY = Object.freeze({
  schemaVersion: "telemetry-performance-capabilities-v1",
  requiredConsent: Object.freeze({ fieldDictionaryVersion: "telemetry-performance-registry-2026-10-10.1" }),
});
const PLAINTEXT = Object.freeze({ schemaVersion: "synthetic-performance-report", day: "2026-10-09", records: [] });
const CONSOLE_METHODS = Object.freeze(["log", "info", "warn", "error", "debug", "trace"]);

let vite;
let limiters;
let admission;
let workerCrypto;
let envelopeModule;
let boundedBody;
let constants;
let routeRegistry;
let recorder;
let ApiError;
let keys;
const consoleSpies = [];

before(async () => {
  for (const method of CONSOLE_METHODS) consoleSpies.push(mock.method(console, method));
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true, ws: false },
    appType: "custom",
    logLevel: "silent",
  });
  let errors;
  [limiters, admission, workerCrypto, envelopeModule, boundedBody, constants, routeRegistry, recorder, errors] =
    await Promise.all([
      vite.ssrLoadModule("/cloud-run/postgres-edge-admission-limiters.mjs"),
      vite.ssrLoadModule("/src/admission.ts"),
      vite.ssrLoadModule("/src/crypto.ts"),
      vite.ssrLoadModule("/src/telemetry-performance-envelope.ts"),
      vite.ssrLoadModule("/src/bounded-body.ts"),
      vite.ssrLoadModule("/src/constants.ts"),
      vite.ssrLoadModule("/src/route-registry.ts"),
      vite.ssrLoadModule("/src/postgres-performance-refusal-counts.ts"),
      vite.ssrLoadModule("/src/errors.ts"),
    ]);
  ApiError = errors.ApiError;
  // One replay instance for the process, as the origin root holds it.
  limiters = limiters.createEdgeAdmissionLimiters();
  keys = await envelopeKeys();
});

after(async () => {
  await vite?.close();
  // Nothing in the family logs: no ids, bearers, bodies or plaintext can
  // reach a log line because no line is ever written.
  for (const spy of consoleSpies) assert.equal(spy.mock.callCount(), 0, "the route family never logs");
});

async function envelopeKeys() {
  const pair = await webcrypto.subtle.generateKey({
    name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["encrypt", "decrypt"]);
  const publicJwk = { ...await webcrypto.subtle.exportKey("jwk", pair.publicKey), kid: KEY_ID };
  const privateJwk = { ...await webcrypto.subtle.exportKey("jwk", pair.privateKey), kid: KEY_ID };
  return { publicJwk, publicJwkRaw: JSON.stringify(publicJwk), privateJwkRaw: JSON.stringify(privateJwk) };
}

/** The shipped client's performance envelope: RSA-OAEP wrapped AES-GCM over the report JSON. */
async function encryptPerformanceEnvelope(plaintext, keyId = KEY_ID) {
  const rsaJwk = { ...keys.publicJwk };
  delete rsaJwk.kid;
  const rsa = await webcrypto.subtle.importKey("jwk", rsaJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const aes = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const rawKey = await webcrypto.subtle.exportKey("raw", aes);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const wrappedKey = await webcrypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, rawKey);
  const ciphertext = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, aes,
    new TextEncoder().encode(JSON.stringify(plaintext)));
  return {
    schemaVersion: "telemetry-performance-envelope-v1", synthetic: false, keyId,
    wrappedKey: Buffer.from(wrappedKey).toString("base64url"),
    iv: Buffer.from(iv).toString("base64url"),
    ciphertext: Buffer.from(ciphertext).toString("base64url"),
  };
}

function closed(status, code, extra = {}) {
  return Object.assign(new ApiError(status, code), extra);
}

function admissionEnv(overrides = {}) {
  return Object.freeze({
    ...limiters.bindings,
    ENVIRONMENT: "production",
    IDENTITY_LINK_SECRET,
    ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
    PERFORMANCE_TELEMETRY_STORAGE_MODE: "enabled",
    ...overrides,
  });
}

/**
 * A recording harness: every adapter appends its step to `log` before acting.
 * `overrides` is an object, or a function of { log, defaults } so a
 * replacement adapter can record into the same log and reuse the defaults.
 */
function harness(overrides = {}, { env = admissionEnv() } = {}) {
  const log = [];
  const calls = {};
  const refusals = [];
  const record = (step, args) => { log.push(step); (calls[step] ??= []).push(args); };
  const authenticate = (step) => async (pool, header, options) => {
    record(`${step}:${options?.accountlessAuthorizationVersion ?? "default"}`, { header, options });
    if (header !== VALID_BEARER) throw closed(401, "DEVICE_AUTH_INVALID");
    return { ...PRINCIPAL, authorityKind: "accountless" };
  };
  const defaults = {
    primaryPool: { connect() { throw new Error("storage is not used by the route family check"); } },
    schema: SCHEMA,
    admissionEnv: env,
    maxRequestBytes: MAX_REQUEST_BYTES,
    envelopePublicJwk: keys.publicJwkRaw,
    envelopePrivateJwk: keys.privateJwkRaw,
    clock: () => Date.parse("2026-10-10T12:00:00.000Z"),
    async assertStorageCurrent() { record("storage_gate"); },
    assertAdmissionBindings(value) { record("bindings"); admission.assertAdmissionBindings(value); },
    async assertAttemptAllowed(coarse, client, request, value, purpose) {
      record(`attempt:${purpose}`);
      await admission.assertAttemptAllowed(coarse, client, request, value, purpose);
    },
    async assertCollectionControl(pool, primarySchema, name) { record(`control:${name}`, { primarySchema }); },
    authenticateGrantDevice: authenticate("authenticate_grant"),
    authenticateDevice: authenticate("authenticate_device"),
    async readBoundedRequestBody(request, maxBytes, timing) {
      record("body", { maxBytes, timing });
      return boundedBody.readBoundedRequestBody(request, maxBytes, timing);
    },
    validateTelemetryPerformanceEnvelope(value) {
      record("envelope");
      return envelopeModule.validateTelemetryPerformanceEnvelope(value);
    },
    async decryptSyntheticEnvelope(envelope, publicJwk, privateJwk) {
      record("decrypt");
      return workerCrypto.decryptSyntheticEnvelope(envelope, publicJwk, privateJwk);
    },
    async sha256Hex(bytes) { return workerCrypto.sha256Hex(bytes); },
    policy: {
      async assertStorage(pool, options) { record(`policy.assertStorage:${options.mode}`, options); },
      parseGrantRequest(value) {
        record("policy.parseGrantRequest", value);
        const expected = value?.schemaVersion === GRANT_V2.schemaVersion ? GRANT_V2 : GRANT_V1;
        if (value === null || typeof value !== "object" || Array.isArray(value)
            || Object.keys(value).sort().join() !== Object.keys(expected).sort().join()) {
          throw closed(400, "BODY_INVALID");
        }
        if (Object.keys(expected).some((key) => value[key] !== expected[key])) {
          throw closed(403, "TELEMETRY_CONSENT_INVALID");
        }
        return {
          echo: value,
          schemaVersion: value.schemaVersion,
          declaredFieldDictionaryVersion: value.fieldDictionaryVersion ?? null,
        };
      },
      async grant(pool, options) { record("policy.grant", options); return { status: "granted" }; },
      async readCapability(pool, options) { record("policy.readCapability", options); return CAPABILITY; },
    },
    reports: {
      async admit(pool, options) {
        record("reports.admit", options);
        return { status: "accepted", reportId: "report-synthetic-0001", day: "2026-10-09", reportRevision: "1".repeat(64) };
      },
      async read(pool, options) { record("reports.read", options); return { reports: [], bounded: false }; },
    },
    recordRefusal(refusal) { refusals.push(refusal); },
  };
  const dependencies = { ...defaults, ...(typeof overrides === "function" ? overrides({ log, defaults }) : overrides) };
  const family = createPerformanceTelemetryDispatch(dependencies);
  return { family, log, calls, refusals, dependencies };
}

function request(path, init = {}) {
  const headers = { authorization: VALID_BEARER, ...init.headers };
  if (init.body !== undefined && !Object.hasOwn(init.headers ?? {}, "content-type")) {
    headers["content-type"] = "application/json";
  }
  for (const [name, value] of Object.entries(headers)) if (value === null) delete headers[name];
  return new Request(`${ORIGIN}${path}`, {
    method: init.method ?? "POST",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

/** Dispatch under one replayed edge outcome, exactly as the origin root scopes it. */
function send(subject, req, { purpose, outcome = "allowed" } = {}) {
  const decoded = purpose === undefined ? null : { purpose, outcome };
  return limiters.run(decoded, () => subject.family.dispatch(req));
}

async function expectError(response, status, code) {
  assert.ok(response instanceof Response, "the family answers its own paths");
  assert.equal(response.status, status, `expected ${status} ${code}`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error), ["code", "requestId"]);
  assert.equal(body.error.code, code);
  assert.match(body.error.requestId, /^[0-9a-f-]{36}$/u);
  return response;
}

const GRANT_STEPS = Object.freeze([
  "storage_gate", "bindings", "control:uploadRegistration", "attempt:accountless_ownership",
  "authenticate_grant:v1.1", "policy.assertStorage:enabled", "body", "policy.parseGrantRequest", "policy.grant",
]);
const DEVICE_STEPS = Object.freeze([
  "storage_gate", "bindings", "attempt:device_sync", "authenticate_device:v1.1", "policy.assertStorage:enabled",
]);
const OWNERSHIP = Object.freeze({ purpose: "accountless_ownership" });
const DEVICE_SYNC = Object.freeze({ purpose: "device_sync" });

test("the family refuses incomplete composition at startup", () => {
  const base = harness().dependencies;
  for (const name of ["assertStorageCurrent", "assertAdmissionBindings", "assertAttemptAllowed",
    "assertCollectionControl", "authenticateGrantDevice", "authenticateDevice", "readBoundedRequestBody",
    "validateTelemetryPerformanceEnvelope", "decryptSyntheticEnvelope", "sha256Hex", "recordRefusal"]) {
    assert.throws(() => createPerformanceTelemetryDispatch({ ...base, [name]: undefined }),
      { code: "TELEMETRY_V11_ROUTE_CONFIGURATION_INVALID" }, name);
  }
  for (const name of ["assertStorage", "parseGrantRequest", "grant", "readCapability"]) {
    assert.throws(() => createPerformanceTelemetryDispatch({ ...base, policy: { ...base.policy, [name]: 1 } }),
      { code: "TELEMETRY_V11_ROUTE_CONFIGURATION_INVALID" }, name);
  }
  for (const name of ["admit", "read"]) {
    assert.throws(() => createPerformanceTelemetryDispatch({ ...base, reports: { ...base.reports, [name]: null } }),
      { code: "TELEMETRY_V11_ROUTE_CONFIGURATION_INVALID" }, name);
  }
  for (const broken of [
    { admissionEnv: { ...base.admissionEnv } },
    { maxRequestBytes: 0 },
    { schema: {} },
    { primaryPool: {} },
    { envelopePublicJwk: "" },
    { envelopePrivateJwk: undefined },
    { requestContext: "x" },
    { clock: 1 },
    { performanceStorageMode: 1 },
  ]) {
    assert.throws(() => createPerformanceTelemetryDispatch({ ...base, ...broken }),
      { code: "TELEMETRY_V11_ROUTE_CONFIGURATION_INVALID" }, Object.keys(broken)[0]);
  }
});

test("route ids, pathnames and methods are the Worker registry's, and other paths are not claimed", async () => {
  assert.deepEqual(PERFORMANCE_TELEMETRY_ROUTE_IDS, [
    "accountless_telemetry_performance_authorization",
    "telemetry_performance_capabilities",
    "telemetry_performance_reports",
  ]);
  const { family } = harness();
  assert.deepEqual(family.pathnames, [GRANT, CAPABILITIES, REPORTS]);
  for (const id of PERFORMANCE_TELEMETRY_ROUTE_IDS) {
    const entry = routeRegistry.WORKER_ROUTE_POLICY.find((route) => route.id === id);
    assert.ok(entry, id);
    assert.equal(entry.pathname, PERFORMANCE_TELEMETRY_PATHNAMES[id]);
  }
  // The consent route stays retired: this family never claims it.
  const consent = routeRegistry.WORKER_ROUTE_POLICY.find((route) => route.id === "telemetry_performance_consent");
  assert.ok(consent);
  assert.equal(await family.dispatch(request(consent.pathname, { body: "{}" })), null);
  assert.equal(await family.dispatch(request(`${REPORTS}/extra`, { method: "GET" })), null);
  assert.equal(await family.dispatch(request("/api/v1/device/sync-capabilities-v1.2", { method: "GET" })), null);
});

test("every wrong method answers 405 with the registry's Allow value before any other step", async () => {
  for (const id of PERFORMANCE_TELEMETRY_ROUTE_IDS) {
    const entry = routeRegistry.WORKER_ROUTE_POLICY.find((route) => route.id === id);
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      if (entry.methods.includes(method)) continue;
      const subject = harness();
      const response = await expectError(await send(subject, request(entry.pathname, { method })),
        405, "METHOD_NOT_ALLOWED");
      assert.equal(response.headers.get("allow"), entry.methods.join(", "), `${method} ${entry.pathname}`);
      assert.deepEqual(subject.log, [], "a 405 precedes the storage gate, admission and authentication");
      assert.deepEqual(subject.refusals, [], "an unauthenticated refusal is never counted");
    }
  }
});

test("grant: the Worker's order end to end, a v1.1 bearer request and the exact body echoed with 201", async () => {
  for (const body of [GRANT_V1, GRANT_V2]) {
    const subject = harness();
    const raw = JSON.stringify(body);
    const response = await send(subject, request(GRANT, {
      body: raw, headers: { cookie: "unrelated=1; theme=dark" },
    }), OWNERSHIP);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), raw, "the exact request body is echoed");
    assert.deepEqual(subject.log, GRANT_STEPS);
    const auth = subject.calls["authenticate_grant:v1.1"][0];
    assert.equal(auth.header, VALID_BEARER);
    assert.deepEqual(auth.options, { schema: SCHEMA, accountlessAuthorizationVersion: "v1.1" });
    assert.deepEqual(subject.calls.body[0], {
      maxBytes: MAX_REQUEST_BYTES, timing: { maximumTotalMilliseconds: 15_000, maximumIdleMilliseconds: 5_000 },
    });
    const granted = subject.calls["policy.grant"][0];
    assert.deepEqual(granted.principal, PRINCIPAL);
    assert.equal(granted.schema, SCHEMA);
    assert.equal(granted.nowEpoch, Date.parse("2026-10-10T12:00:00.000Z"));
    assert.deepEqual(granted.request.echo, body);
    assert.equal(granted.request.declaredFieldDictionaryVersion, body.fieldDictionaryVersion ?? null);
    assert.deepEqual(subject.refusals, []);
  }
  // An explicit performanceStorageMode wins over the admission env's value.
  const pinned = harness({ performanceStorageMode: "disabled" });
  await send(pinned, request(GRANT, { body: JSON.stringify(GRANT_V1) }), OWNERSHIP);
  assert.ok(pinned.log.includes("policy.assertStorage:disabled"));
});

test("grant: each refusal answers at its own step, in order, and only post-authentication ones are counted", async () => {
  const body = JSON.stringify(GRANT_V1);
  const cases = [
    {
      label: "session cookie", status: 401, code: "AUTH_INVALID", steps: [],
      req: () => request(GRANT, { body, headers: { cookie: `theme=dark; ${constants.SESSION_COOKIE_NAME}=synthetic` } }),
    },
    {
      label: "storage gate", status: 503, code: "BACKEND_STORAGE_UNAVAILABLE", steps: ["storage_gate"],
      overrides: ({ log }) => ({ async assertStorageCurrent() { log.push("storage_gate"); throw new Error("schema receipt stale"); } }),
    },
    {
      label: "ownership mode absent", status: 503, code: "ACCOUNTLESS_OWNERSHIP_DISABLED", steps: ["storage_gate"],
      env: admissionEnv({ ACCOUNTLESS_OWNERSHIP_MODE: undefined }),
    },
    {
      label: "ownership mode disabled", status: 503, code: "ACCOUNTLESS_OWNERSHIP_DISABLED", steps: ["storage_gate"],
      env: admissionEnv({ ACCOUNTLESS_OWNERSHIP_MODE: "disabled" }),
    },
    {
      label: "ownership mode invalid", status: 503, code: "ACCOUNTLESS_OWNERSHIP_CONFIGURATION_INVALID",
      steps: ["storage_gate"], env: admissionEnv({ ACCOUNTLESS_OWNERSHIP_MODE: "sometimes" }),
    },
    {
      label: "admission bindings", status: 503, code: "ADMISSION_CONFIGURATION_INVALID",
      steps: ["storage_gate", "bindings"], env: admissionEnv({ PUBLIC_READ_RATE_LIMIT: undefined }),
    },
    {
      label: "upload registration", status: 503, code: "UPLOAD_REGISTRATION_DISABLED",
      steps: ["storage_gate", "bindings", "control:uploadRegistration"],
      overrides: ({ log }) => ({
        async assertCollectionControl(pool, schema, name) {
          log.push(`control:${name}`); throw closed(503, "UPLOAD_REGISTRATION_DISABLED");
        },
      }),
    },
    {
      label: "limiter limited", status: 429, code: "ATTEMPT_LIMIT_REACHED", retryAfter: "60",
      steps: ["storage_gate", "bindings", "control:uploadRegistration", "attempt:accountless_ownership"],
      admission: { purpose: "accountless_ownership", outcome: "limited" },
    },
    {
      label: "limiter replay of another purpose", status: 503, code: "ADMISSION_RATE_LIMIT_UNAVAILABLE", retryAfter: "60",
      steps: ["storage_gate", "bindings", "control:uploadRegistration", "attempt:accountless_ownership"],
      admission: DEVICE_SYNC,
    },
    {
      label: "no edge outcome", status: 503, code: "ADMISSION_RATE_LIMIT_UNAVAILABLE", retryAfter: "60",
      steps: ["storage_gate", "bindings", "control:uploadRegistration", "attempt:accountless_ownership"],
      admission: {},
    },
    {
      label: "missing bearer", status: 401, code: "DEVICE_AUTH_INVALID",
      steps: GRANT_STEPS.slice(0, 5), req: () => request(GRANT, { body, headers: { authorization: null } }),
    },
    {
      label: "unknown bearer", status: 401, code: "DEVICE_AUTH_INVALID",
      steps: GRANT_STEPS.slice(0, 5), req: () => request(GRANT, { body, headers: { authorization: "Device other.secret" } }),
    },
    {
      label: "social authority", status: 401, code: "DEVICE_AUTH_INVALID", steps: GRANT_STEPS.slice(0, 5),
      overrides: ({ log }) => ({
        async authenticateGrantDevice(pool, header, options) {
          log.push(`authenticate_grant:${options.accountlessAuthorizationVersion}`);
          return { ...PRINCIPAL, authorityKind: "social" };
        },
      }),
    },
    {
      // Defence in depth (SPD-X1a): an absent authority kind is not accountless.
      label: "no authority kind", status: 401, code: "DEVICE_AUTH_INVALID", steps: GRANT_STEPS.slice(0, 5),
      overrides: ({ log }) => ({
        async authenticateGrantDevice(pool, header, options) {
          log.push(`authenticate_grant:${options.accountlessAuthorizationVersion}`);
          return { ...PRINCIPAL };
        },
      }),
    },
    {
      label: "query string", status: 503, code: "POSTGRES_TEST_ROUTE_UNSUPPORTED", counted: true,
      steps: GRANT_STEPS.slice(0, 5), req: () => request(`${GRANT}?debug=1`, { body }),
    },
    {
      label: "performance storage", status: 503, code: "BACKEND_STORAGE_UNAVAILABLE", counted: true,
      steps: GRANT_STEPS.slice(0, 6), bodyUnread: true,
      overrides: ({ log, defaults }) => ({
        policy: {
          ...defaults.policy,
          async assertStorage(pool, options) {
            log.push(`policy.assertStorage:${options.mode}`); throw closed(503, "BACKEND_STORAGE_UNAVAILABLE");
          },
        },
      }),
    },
    {
      label: "content type", status: 415, code: "CONTENT_TYPE_INVALID", counted: true, steps: GRANT_STEPS.slice(0, 6),
      req: () => request(GRANT, { body, headers: { "content-type": "text/plain" } }),
    },
    {
      label: "declared length too large", status: 413, code: "BODY_TOO_LARGE", counted: true,
      steps: GRANT_STEPS.slice(0, 6),
      req: () => request(GRANT, { body, headers: { "content-length": String(MAX_REQUEST_BYTES + 1) } }),
    },
    {
      label: "declared length invalid", status: 400, code: "BODY_INVALID", counted: true, steps: GRANT_STEPS.slice(0, 6),
      req: () => request(GRANT, { body, headers: { "content-length": "-1" } }),
    },
    {
      label: "malformed JSON", status: 400, code: "BODY_INVALID", counted: true, steps: GRANT_STEPS.slice(0, 7),
      req: () => request(GRANT, { body: "{" }),
    },
    {
      label: "extra body key", status: 400, code: "BODY_INVALID", counted: true, steps: GRANT_STEPS.slice(0, 8),
      req: () => request(GRANT, { body: JSON.stringify({ ...GRANT_V1, extra: true }) }),
    },
    {
      label: "wrong policy version", status: 403, code: "TELEMETRY_CONSENT_INVALID", counted: true,
      steps: GRANT_STEPS.slice(0, 8),
      req: () => request(GRANT, { body: JSON.stringify({ ...GRANT_V1, policyVersion: "other" }) }),
    },
    {
      label: "grant refused", status: 403, code: "TELEMETRY_TRANSPORT_BLOCKED", counted: true, steps: GRANT_STEPS,
      overrides: ({ log, defaults }) => ({
        policy: {
          ...defaults.policy,
          async grant() { log.push("policy.grant"); throw closed(403, "TELEMETRY_TRANSPORT_BLOCKED"); },
        },
      }),
    },
  ];
  for (const entry of cases) {
    const subject = harness(entry.overrides ?? {}, { env: entry.env ?? admissionEnv() });
    const req = entry.req ? entry.req() : request(GRANT, { body });
    const response = await send(subject, req, entry.admission ?? OWNERSHIP);
    await expectError(response, entry.status, entry.code);
    if (entry.retryAfter) assert.equal(response.headers.get("retry-after"), entry.retryAfter, entry.label);
    assert.deepEqual(subject.log, entry.steps, entry.label);
    if (entry.bodyUnread) assert.equal(req.bodyUsed, false, `${entry.label}: the body is never read`);
    assert.deepEqual(subject.refusals, entry.counted
      ? [{ routeId: "accountless_telemetry_performance_authorization", code: entry.code, status: entry.status }]
      : [], entry.label);
  }
});

test("capabilities: the device principal under the v1.1 graph, then the stored capability", async () => {
  const subject = harness();
  const response = await send(subject, request(`${CAPABILITIES}?ignored=1`, { method: "GET" }), DEVICE_SYNC);
  assert.equal(response.status, 200, "the Worker ignores a capabilities query string");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), CAPABILITY);
  assert.deepEqual(subject.log, [...DEVICE_STEPS, "policy.readCapability"]);
  assert.deepEqual(subject.calls["authenticate_device:v1.1"][0].options,
    { schema: SCHEMA, accountlessAuthorizationVersion: "v1.1" },
    "the device routes never authenticate with the v1.2 default");
  assert.deepEqual(subject.calls["policy.readCapability"][0], {
    schema: SCHEMA, principal: PRINCIPAL, nowEpoch: Date.parse("2026-10-10T12:00:00.000Z"),
  });

  const cases = [
    {
      label: "storage gate", status: 503, code: "BACKEND_STORAGE_UNAVAILABLE", steps: ["storage_gate"],
      overrides: ({ log }) => ({ async assertStorageCurrent() { log.push("storage_gate"); throw closed(500, "INTERNAL_ERROR"); } }),
    },
    {
      label: "bindings", status: 503, code: "ADMISSION_CONFIGURATION_INVALID", steps: ["storage_gate", "bindings"],
      env: admissionEnv({ ENROLLMENT_RATE_LIMIT: undefined }),
    },
    {
      label: "limiter replay of the grant purpose", status: 503, code: "ADMISSION_RATE_LIMIT_UNAVAILABLE",
      steps: DEVICE_STEPS.slice(0, 3), admission: OWNERSHIP,
    },
    {
      label: "limited", status: 429, code: "ATTEMPT_LIMIT_REACHED", steps: DEVICE_STEPS.slice(0, 3),
      admission: { purpose: "device_sync", outcome: "limited" },
    },
    {
      label: "any cookie", status: 401, code: "DEVICE_AUTH_INVALID", steps: DEVICE_STEPS.slice(0, 3),
      req: () => request(CAPABILITIES, { method: "GET", headers: { cookie: "theme=dark" } }),
    },
    {
      label: "bad bearer", status: 401, code: "DEVICE_AUTH_INVALID", steps: DEVICE_STEPS.slice(0, 4),
      req: () => request(CAPABILITIES, { method: "GET", headers: { authorization: "Bearer synthetic" } }),
    },
    {
      label: "staged runtime", status: 403, code: "TELEMETRY_TRANSPORT_BLOCKED", counted: true,
      steps: [...DEVICE_STEPS, "policy.readCapability"],
      overrides: ({ log, defaults }) => ({
        policy: {
          ...defaults.policy,
          async readCapability() { log.push("policy.readCapability"); throw closed(403, "TELEMETRY_TRANSPORT_BLOCKED"); },
        },
      }),
    },
  ];
  for (const entry of cases) {
    const refused = harness(entry.overrides ?? {}, { env: entry.env ?? admissionEnv() });
    const req = entry.req ? entry.req() : request(CAPABILITIES, { method: "GET" });
    await expectError(await send(refused, req, entry.admission ?? DEVICE_SYNC), entry.status, entry.code);
    assert.deepEqual(refused.log, entry.steps, entry.label);
    assert.deepEqual(refused.refusals, entry.counted
      ? [{ routeId: "telemetry_performance_capabilities", code: entry.code, status: entry.status }] : [], entry.label);
  }
});

test("reports GET: the Worker's query validation, then the bounded device-scoped read", async () => {
  const subject = harness();
  const response = await send(subject, request(`${REPORTS}?fromDay=2026-10-01&throughDay=2026-10-09&includeSuperseded=true`,
    { method: "GET" }), DEVICE_SYNC);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(subject.log, [...DEVICE_STEPS, "reports.read"]);
  assert.deepEqual(subject.calls["reports.read"][0], {
    schema: SCHEMA, participantId: PRINCIPAL.participantId, deviceId: PRINCIPAL.deviceId,
    fromDay: "2026-10-01", throughDay: "2026-10-09", includeSuperseded: true,
  });
  const bare = harness();
  assert.equal((await send(bare, request(REPORTS, { method: "GET" }), DEVICE_SYNC)).status, 200);
  assert.deepEqual(bare.calls["reports.read"][0], {
    schema: SCHEMA, participantId: PRINCIPAL.participantId, deviceId: PRINCIPAL.deviceId,
    fromDay: undefined, throughDay: undefined, includeSuperseded: undefined,
  });
  for (const query of [
    "?other=1", "?fromDay=2026-10-01&fromDay=2026-10-02", "?throughDay=a&throughDay=b",
    "?includeSuperseded=true&includeSuperseded=false", "?includeSuperseded=yes", "?includeSuperseded=",
  ]) {
    const refused = harness();
    await expectError(await send(refused, request(`${REPORTS}${query}`, { method: "GET" }), DEVICE_SYNC),
      400, "BODY_INVALID");
    assert.deepEqual(refused.log, DEVICE_STEPS, query);
    assert.deepEqual(refused.refusals, [{ routeId: "telemetry_performance_reports", code: "BODY_INVALID", status: 400 }]);
  }
});

test("reports POST: processing control, envelope, capability BEFORE decrypt, admission and the 202 receipt", async () => {
  const envelope = await encryptPerformanceEnvelope(PLAINTEXT);
  const raw = JSON.stringify(envelope);
  const subject = harness();
  const response = await send(subject, request(REPORTS, { body: raw }), DEVICE_SYNC);
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("idempotency-replayed"), null);
  assert.equal(await response.text(), JSON.stringify({
    schemaVersion: "telemetry-performance-receipt-v1", status: "accepted", reportId: "report-synthetic-0001",
    day: "2026-10-09", reportRevision: "1".repeat(64), replayed: false,
  }));
  assert.deepEqual(subject.log, [
    ...DEVICE_STEPS, "control:processing", "body", "envelope", "policy.readCapability", "decrypt", "reports.admit",
  ]);
  const admitted = subject.calls["reports.admit"][0];
  assert.deepEqual(admitted.principal, PRINCIPAL);
  assert.deepEqual(admitted.plaintext, PLAINTEXT);
  assert.equal(admitted.capability, CAPABILITY, "admission receives the capability read before decryption");
  assert.equal(admitted.envelopeDigest, await workerCrypto.sha256Hex(new TextEncoder().encode(raw)));
  assert.equal(admitted.schema, SCHEMA);

  for (const [status, replayed, header] of [["idempotent", true, "true"], ["replaced", false, null]]) {
    const replay = harness(({ defaults }) => ({
      reports: {
        ...defaults.reports,
        async admit() { return { status, reportId: "report-synthetic-0001", day: "2026-10-09", reportRevision: "2".repeat(64) }; },
      },
    }));
    const answered = await send(replay, request(REPORTS, { body: raw }), DEVICE_SYNC);
    assert.equal(answered.status, 202);
    assert.equal(answered.headers.get("idempotency-replayed"), header);
    const body = await answered.json();
    assert.equal(body.status, status);
    assert.equal(body.replayed, replayed);
  }
});

test("reports POST refusals: envelope, key id, capability before RSA work, and invalid records with their detail", async () => {
  const envelope = await encryptPerformanceEnvelope(PLAINTEXT);
  const raw = JSON.stringify(envelope);
  const reportsCode = (code, status) => [{ routeId: "telemetry_performance_reports", code, status }];

  const contained = harness(({ log }) => ({
    async assertCollectionControl(pool, schema, name) {
      log.push(`control:${name}`);
      throw closed(503, "PROCESSING_DISABLED");
    },
  }));
  await expectError(await send(contained, request(REPORTS, { body: raw }), DEVICE_SYNC), 503, "PROCESSING_DISABLED");
  assert.deepEqual(contained.log, [...DEVICE_STEPS, "control:processing"]);
  assert.deepEqual(contained.refusals, reportsCode("PROCESSING_DISABLED", 503));

  const wrongType = harness();
  await expectError(await send(wrongType, request(REPORTS, { body: raw, headers: { "content-type": "text/plain" } }),
    DEVICE_SYNC), 415, "CONTENT_TYPE_INVALID");
  assert.deepEqual(wrongType.refusals, reportsCode("CONTENT_TYPE_INVALID", 415));

  for (const bad of [{ ...envelope, extra: 1 }, { ...envelope, synthetic: true }, { ...envelope, iv: "short" }, []]) {
    const refused = harness();
    await expectError(await send(refused, request(REPORTS, { body: JSON.stringify(bad) }), DEVICE_SYNC),
      400, "ENVELOPE_INVALID");
    assert.deepEqual(refused.log, [...DEVICE_STEPS, "control:processing", "body", "envelope"]);
    assert.deepEqual(refused.refusals, reportsCode("ENVELOPE_INVALID", 400));
  }

  // The capability is read before decryption: a device without one is
  // refused 403 and no RSA work happens.
  const blocked = harness(({ log, defaults }) => ({
    policy: {
      ...defaults.policy,
      async readCapability() { log.push("policy.readCapability"); throw closed(403, "TELEMETRY_TRANSPORT_BLOCKED"); },
    },
  }));
  await expectError(await send(blocked, request(REPORTS, { body: raw }), DEVICE_SYNC), 403, "TELEMETRY_TRANSPORT_BLOCKED");
  assert.deepEqual(blocked.log, [...DEVICE_STEPS, "control:processing", "body", "envelope", "policy.readCapability"]);
  assert.equal(blocked.log.includes("decrypt"), false);
  assert.deepEqual(blocked.refusals, reportsCode("TELEMETRY_TRANSPORT_BLOCKED", 403));

  const otherKey = harness();
  const foreign = JSON.stringify(await encryptPerformanceEnvelope(PLAINTEXT, "key:another-key"));
  await expectError(await send(otherKey, request(REPORTS, { body: foreign }), DEVICE_SYNC), 400, "KEY_ID_INVALID");
  assert.equal(otherKey.log.at(-1), "decrypt");
  assert.equal(otherKey.calls["reports.admit"], undefined);
  assert.deepEqual(otherKey.refusals, reportsCode("KEY_ID_INVALID", 400));

  for (const [detail, counted] of [
    ["MODEL_UNREVIEWED", "TELEMETRY_RECORD_INVALID_MODEL_UNREVIEWED"],
    ["DICTIONARY_UNACCEPTED", "TELEMETRY_RECORD_INVALID_DICTIONARY_UNACCEPTED"],
    ["SHAPE", "TELEMETRY_RECORD_INVALID_SHAPE"],
    ["REPORT_DAY_OUT_OF_WINDOW", "TELEMETRY_RECORD_INVALID_REPORT_DAY_OUT_OF_WINDOW"],
    ["not-a-closed-detail", "TELEMETRY_RECORD_INVALID"],
    [undefined, "TELEMETRY_RECORD_INVALID"],
  ]) {
    const invalid = harness(({ defaults }) => ({
      reports: {
        ...defaults.reports,
        async admit() { throw closed(409, "TELEMETRY_RECORD_INVALID", detail === undefined ? {} : { detail }); },
      },
    }));
    const response = await send(invalid, request(REPORTS, { body: raw }), DEVICE_SYNC);
    const text = await response.clone().text();
    await expectError(response, 409, "TELEMETRY_RECORD_INVALID");
    if (detail !== undefined) assert.equal(text.includes(detail), false, "the detail never reaches the response");
    assert.deepEqual(invalid.refusals, reportsCode(counted, 409), String(detail));
  }
  const viaAlias = harness(({ defaults }) => ({
    reports: {
      ...defaults.reports,
      async admit() { throw closed(409, "TELEMETRY_RECORD_INVALID", { refusalDetail: "ORDER" }); },
    },
  }));
  await expectError(await send(viaAlias, request(REPORTS, { body: raw }), DEVICE_SYNC), 409, "TELEMETRY_RECORD_INVALID");
  // SPD-G3 names the detail `detail`; no other property is read (SPD-X1a).
  assert.deepEqual(viaAlias.refusals, reportsCode("TELEMETRY_RECORD_INVALID", 409));

  const conflict = harness(({ defaults }) => ({
    reports: { ...defaults.reports, async admit() { throw closed(409, "TELEMETRY_MANIFEST_CONFLICT", { detail: "SIZE" }); } },
  }));
  await expectError(await send(conflict, request(REPORTS, { body: raw }), DEVICE_SYNC), 409, "TELEMETRY_MANIFEST_CONFLICT");
  assert.deepEqual(conflict.refusals, reportsCode("TELEMETRY_MANIFEST_CONFLICT", 409),
    "only an invalid record carries a detail");

  const leaky = harness(({ defaults }) => ({
    reports: { ...defaults.reports, async admit() { throw new TypeError("relation \"secret_table\" does not exist"); } },
  }));
  const masked = await send(leaky, request(REPORTS, { body: raw }), DEVICE_SYNC);
  assert.equal(masked.status, 500);
  assert.doesNotMatch(await masked.clone().text(), /secret_table|relation/u);
  await expectError(masked, 500, "INTERNAL_ERROR");
  assert.deepEqual(leaky.refusals, reportsCode("INTERNAL_ERROR", 500));
});

test("a recorder that throws, rejects or hangs never changes or unboundedly delays an answer", {
  timeout: 60_000,
}, async () => {
  const envelope = JSON.stringify(await encryptPerformanceEnvelope(PLAINTEXT));
  const scenarios = [
    ["throws", () => { throw new Error("counter table unavailable"); }],
    ["rejects", async () => { throw new Error("counter table locked"); }],
    ["hangs", () => new Promise(() => {})],
  ];
  const reference = async (subject, req, admissionScope) => {
    const response = await send(subject, req, admissionScope);
    const body = await response.json();
    return { status: response.status, code: body.error?.code, cacheControl: response.headers.get("cache-control") };
  };
  for (const [label, recordRefusal] of scenarios) {
    for (const [makeRequest, admissionScope, overrides] of [
      [() => request(`${GRANT}?x=1`, { body: JSON.stringify(GRANT_V1) }), OWNERSHIP, () => ({})],
      [() => request(CAPABILITIES, { method: "GET" }), DEVICE_SYNC, ({ defaults }) => ({
        policy: { ...defaults.policy, async readCapability() { throw closed(403, "TELEMETRY_TRANSPORT_BLOCKED"); } },
      })],
      [() => request(REPORTS, { body: envelope, headers: { "content-type": "text/plain" } }), DEVICE_SYNC, () => ({})],
    ]) {
      const expected = await reference(harness(overrides), makeRequest(), admissionScope);
      const started = Date.now();
      const actual = await reference(harness((context) => ({ ...overrides(context), recordRefusal })),
        makeRequest(), admissionScope);
      const elapsed = Date.now() - started;
      assert.deepEqual(actual, expected, label);
      assert.ok(elapsed < PERFORMANCE_TELEMETRY_REFUSAL_BOUND_MILLISECONDS + 750, `${label}: answered in ${elapsed} ms`);
    }
  }
  // A successful answer never calls the recorder at all.
  let called = 0;
  const quiet = harness({ recordRefusal() { called += 1; } });
  assert.equal((await send(quiet, request(CAPABILITIES, { method: "GET" }), DEVICE_SYNC)).status, 200);
  assert.equal(called, 0);
});

/** A synthetic pool that records every statement and fails or stalls on demand. */
function syntheticPool({ connect, query } = {}) {
  const statements = [];
  const released = [];
  let connects = 0;
  const pool = {
    async connect() {
      connects += 1;
      if (connect) await connect();
      return {
        async query(text, values) {
          statements.push({ text: text.replace(/\s+/gu, " ").trim(), values });
          if (query) return query(text, values);
          return { rows: [], rowCount: /^\s*INSERT/u.test(text) ? 1 : null };
        },
        release(discard) { released.push(discard === true); },
      };
    },
  };
  return { pool, statements, released, connects: () => connects };
}

test("recorder: one short transaction upserting (UTC day, route id, closed code, status) and nothing else", async () => {
  const { pool, statements, released } = syntheticPool();
  const recorded = await recorder.recordPostgresTelemetryPerformanceRefusal(pool, {
    schema: SCHEMA,
    routeId: "telemetry_performance_reports",
    code: "TELEMETRY_RECORD_INVALID_MODEL_UNREVIEWED",
    status: 409,
    nowEpoch: Date.parse("2026-10-10T23:59:59.999Z"),
  });
  assert.equal(recorded, true);
  assert.deepEqual(statements.map((statement) => statement.text.split(" ").slice(0, 3).join(" ")), [
    "BEGIN", "SET LOCAL statement_timeout='1000ms'", "SET LOCAL lock_timeout='1000ms'",
    "INSERT INTO \"synthetic_primary\".\"telemetry_performance_refusal_counts\"", "COMMIT",
  ].map((text) => text.split(" ").slice(0, 3).join(" ")));
  const insert = statements[3];
  assert.equal(insert.text,
    "INSERT INTO \"synthetic_primary\".\"telemetry_performance_refusal_counts\" (day, route_id, code, status, refusals)"
    + " VALUES ($1::date, $2, $3, $4, 1) ON CONFLICT (day, route_id, code, status)"
    + " DO UPDATE SET refusals = \"synthetic_primary\".\"telemetry_performance_refusal_counts\".refusals + 1");
  assert.deepEqual(insert.values, ["2026-10-10", "telemetry_performance_reports",
    "TELEMETRY_RECORD_INVALID_MODEL_UNREVIEWED", 409], "only day, route id, closed code and status are written");
  assert.deepEqual(released, [false]);
  assert.equal(recorder.POSTGRES_TELEMETRY_PERFORMANCE_REFUSAL_TIMEOUT_MILLISECONDS, 1_000);
  assert.deepEqual(recorder.POSTGRES_TELEMETRY_PERFORMANCE_REFUSAL_ROUTE_IDS, PERFORMANCE_TELEMETRY_ROUTE_IDS);
});

test("recorder: invalid input writes nothing, and every storage failure is swallowed within the bound", {
  timeout: 60_000,
}, async () => {
  const valid = {
    schema: SCHEMA, routeId: "telemetry_performance_capabilities", code: "TELEMETRY_TRANSPORT_BLOCKED",
    status: 403, nowEpoch: Date.parse("2026-10-10T00:00:00.000Z"),
  };
  for (const broken of [
    { routeId: "telemetry_performance_consent" },
    { code: "lowercase_code" },
    { code: "A" },
    { code: `A${"B".repeat(64)}` },
    { status: 399 },
    { status: 600 },
    { status: 403.5 },
    { nowEpoch: Number.NaN },
    { nowEpoch: -1 },
    { schema: { primarySchema: "bad schema\"" } },
  ]) {
    const synthetic = syntheticPool();
    assert.equal(await recorder.recordPostgresTelemetryPerformanceRefusal(synthetic.pool, { ...valid, ...broken }), false,
      JSON.stringify(broken));
    assert.equal(synthetic.connects(), 0, "nothing is sent for invalid input");
  }
  assert.equal(await recorder.recordPostgresTelemetryPerformanceRefusal(null, valid), false);
  assert.equal(await recorder.recordPostgresTelemetryPerformanceRefusal({ connect: "x" }, valid), false);

  const refusedConnect = syntheticPool({ connect: async () => { throw new Error("connection refused"); } });
  assert.equal(await recorder.recordPostgresTelemetryPerformanceRefusal(refusedConnect.pool, valid), false);

  const lockTimeout = syntheticPool({
    query: async (text) => {
      if (/^\s*INSERT/u.test(text)) throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
      return { rows: [], rowCount: null };
    },
  });
  assert.equal(await recorder.recordPostgresTelemetryPerformanceRefusal(lockTimeout.pool, valid), false);
  assert.ok(lockTimeout.statements.some((statement) => statement.text === "ROLLBACK"), "the failed increment rolls back");
  assert.equal(lockTimeout.statements.some((statement) => statement.text === "COMMIT"), false);

  for (const stalled of [
    syntheticPool({ connect: () => new Promise(() => {}) }),
    syntheticPool({ query: (text) => (/^\s*INSERT/u.test(text) ? new Promise(() => {}) : { rows: [], rowCount: null }) }),
  ]) {
    const started = Date.now();
    assert.equal(await recorder.recordPostgresTelemetryPerformanceRefusal(stalled.pool, valid), false);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 900 && elapsed < 1_750, `a stalled recorder resolves at its bound (${elapsed} ms)`);
  }
});
