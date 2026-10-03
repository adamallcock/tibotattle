/**
 * Storage-free checks of the legacy intake composition (GCP fast path, the
 * IN-2 and IN-3 hand-offs): what it registers and mounts, and the order of
 * its v1.1 route gate (a wrong method is the route's 405 before any storage
 * read; an allowed method is refused 503 against stale migration receipts
 * before its handler). Every adapter is a synthetic stub;
 * postgres-test/postgres-origin-intake.spec.mjs drives the composed origin
 * against PostgreSQL 17 with the shipped clients.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertContributionEnvelopeFormats,
  createContributionEnvelopeRegistry,
  createUploadAuthorizationFormats,
  registerContributionEnvelope,
} from "./contribution-envelope-registry.mjs";
import {
  ORIGIN_INTAKE_HOST_MODES,
  ORIGIN_INTAKE_RETIRED_ENVELOPE_SCHEMA_VERSIONS,
  ORIGIN_INTAKE_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS,
  createOriginIntakeComposition,
  originIntakeServedInMode,
} from "./origin-intake-composition.mjs";
import { createOriginRouteModuleRegistry } from "./origin-route-modules.mjs";

const ORIGIN = "http://127.0.0.1:8787";
const unreachable = (name) => () => { throw new Error(`${name} must not be reached by this check`); };
const pool = { connect: unreachable("primary pool") };
const ROUTE_POLICY = Object.freeze([
  { pathname: "/api/v1/device/upload-authorizations", methods: ["POST"] },
  { pathname: "/api/v1/community/daily", methods: ["GET"] },
  { pathname: "/api/v1/me/device-telemetry-consents", methods: ["POST"] },
  { pathname: "/api/v1/device/telemetry/v1.1/day-manifests", methods: ["GET", "POST"] },
  { pathname: "/api/v1/me/telemetry-v11/domain-predecessor", methods: ["POST"] },
  { pathname: "/api/v1/me/telemetry-v11/domain-activate", methods: ["POST"] },
  { pathname: "/api/v1/contributions", methods: ["POST"] },
]);
const V11_PATHNAMES = Object.freeze([
  "/api/v1/me/device-telemetry-consents",
  "/api/v1/device/telemetry/v1.1/day-manifests",
  "/api/v1/me/telemetry-v11/domain-predecessor",
  "/api/v1/me/telemetry-v11/domain-activate",
]);
const SHARED_LEGACY_PATHNAMES = Object.freeze(["/api/v1/device/upload-authorizations", "/api/v1/contributions"]);

function stubs(names) {
  return Object.fromEntries(names.map((name) => [name, unreachable(name)]));
}

function options(overrides = {}) {
  return {
    adapters: {
      live: stubs([
        "grantPostgresTelemetryV11Consent", "registerPostgresTelemetryV11DayManifest",
        "readPostgresTelemetryV11DayChunkVector", "readPostgresTelemetryV11DayCandidates",
        "createPostgresTelemetryV11Domain", "readPostgresTelemetryV11StorageReplay",
        "persistPostgresTypedV11StagedChunk", "readPostgresTelemetryV11UploadOutcome",
        "recordPostgresTelemetryV11UploadReceipt", "registerPostgresTelemetryV11PendingObject",
        "retirePostgresTelemetryV11PendingObject", "validatePostgresTelemetryV11StagedChunk",
      ]),
      bearer: stubs(["authenticatePostgresDeviceBearer"]),
      transport: stubs(["abandonPostgresDeviceUploadAuthorization", "authenticatePostgresDevice"]),
      personalDevices: stubs(["authenticatePostgresPersonalSession", "assertPostgresPersonalSessionCsrf"]),
      controls: stubs(["assertPostgresCollectionControlFromPool"]),
      crypto: stubs(["decryptSyntheticEnvelope", "sha256Hex"]),
      boundedBody: stubs(["readBoundedRequestBody"]),
      legacyAdmission: stubs([
        "admitPostgresTelemetryV1Contribution", "recordPostgresDeviceUploadReceipt",
      ]),
      transportWriteAuthority: stubs(["assertPostgresTelemetryTransportWriteAllowed"]),
      uploadAuthorization: stubs(["createPostgresDeviceUploadAuthorization"]),
    },
    primaryPool: pool,
    schemaOptions: Object.freeze({ primarySchema: "synthetic_primary" }),
    admissionEnv: Object.freeze({}),
    assertAdmissionBindings: unreachable("assertAdmissionBindings"),
    assertAttemptAllowed: unreachable("assertAttemptAllowed"),
    assertUploadAuthorizationBindings: unreachable("assertUploadAuthorizationBindings"),
    assertUploadAuthorizationAllowed: unreachable("assertUploadAuthorizationAllowed"),
    assertV12UploadAllowed: unreachable("assertV12UploadAllowed"),
    assertStorageCurrent: unreachable("assertStorageCurrent"),
    routePolicy: ROUTE_POLICY,
    maxRequestBytes: 2 * 1024 * 1024,
    socialConsentVersion: "privacy-safe-telemetry-v0.1",
    sourceNamespace: "synthetic-namespace",
    envelopePublicJwk: "{\"synthetic\":\"public\"}",
    envelopePrivateJwk: "{\"synthetic\":\"private\"}",
    ...overrides,
  };
}

test("the composition registers v1.1 and v1.0 live, the retired v0.x pair, the receipt recorder and one route module", () => {
  const configured = options();
  const intake = createOriginIntakeComposition(configured);
  assert.deepEqual(intake.contributionEnvelopes.map(({ schemaVersion, ownsReceipt }) => [schemaVersion, ownsReceipt]), [
    ["telemetry-envelope-v1.1", true],
    ["telemetry-envelope-v1.0", false],
    ["telemetry-envelope-v0.1", false],
    ["telemetry-envelope-v0.2", false],
  ]);
  assert.deepEqual([...ORIGIN_INTAKE_RETIRED_ENVELOPE_SCHEMA_VERSIONS],
    ["telemetry-envelope-v0.1", "telemetry-envelope-v0.2"]);
  assert.deepEqual([...ORIGIN_INTAKE_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS],
    ["telemetry-contribution-v1.0", "telemetry-contribution-v1.1"]);
  assert.deepEqual(Object.keys(intake.uploadAuthorizationFormats).sort(), [
    "telemetry-contribution-v0.1", "telemetry-contribution-v0.2", "telemetry-contribution-v1.0",
    "telemetry-contribution-v1.1",
  ]);
  // Beside the dispatch's own v1.2 entries, the two tables pair exactly.
  const formats = createUploadAuthorizationFormats(new Map([
    ["telemetry-contribution-v1.2", { assertUploadAllowed: unreachable("v1.2") }],
    ...Object.entries(intake.uploadAuthorizationFormats),
  ]));
  assert.doesNotThrow(() => assertContributionEnvelopeFormats(createContributionEnvelopeRegistry([
    registerContributionEnvelope("telemetry-envelope-v1.2", unreachable("v1.2 handler"), { ownsReceipt: true }),
    ...intake.contributionEnvelopes,
  ]), formats));
  assert.equal(intake.recordPostgresDeviceUploadReceipt,
    configured.adapters.legacyAdmission.recordPostgresDeviceUploadReceipt);
  assert.deepEqual(intake.routeModules.map(({ method, pathname, overridesBuiltIn }) => [method, pathname, overridesBuiltIn]),
    [["POST", "/api/v1/device/upload-authorizations", true]]);
  const mounted = createOriginRouteModuleRegistry({ modules: [...intake.routeModules], routePolicy: ROUTE_POLICY });
  assert.deepEqual(mounted.pathnames, ["/api/v1/device/upload-authorizations"]);
  assert.deepEqual([...intake.pathnames], [...V11_PATHNAMES, ...SHARED_LEGACY_PATHNAMES]);
});

test("the v1.0 envelope reaches its admitter; no v0.x admitter is composed (round 12)", async () => {
  const calls = [];
  const admitter = (name) => async (input) => {
    calls.push([name, input.body.value.schemaVersion]);
    return new Response(JSON.stringify({ contributionId: name }), { status: 202 });
  };
  const configured = options();
  const intake = createOriginIntakeComposition({
    ...configured,
    adapters: {
      ...configured.adapters,
      legacyAdmission: {
        ...configured.adapters.legacyAdmission,
        admitPostgresTelemetryV1Contribution: admitter("v1.0 admitter"),
        // A v0.1 admitter the root still passes is never wired to a route.
        admitPostgresTelemetryV01Contribution: admitter("v0.1 admitter"),
      },
    },
  });
  const context = Object.freeze({
    primaryPool: pool, schema: configured.schemaOptions, objectStore: {}, sourceNamespace: "synthetic-namespace",
    envelopePublicJwk: configured.envelopePublicJwk, envelopePrivateJwk: configured.envelopePrivateJwk,
  });
  const participant = Object.freeze({ id: "synthetic-participant", consentVersion: "privacy-safe-telemetry-v0.1" });
  const claimed = Object.freeze({ authorizationId: "synthetic-authorization", authorizationKind: "device" });
  for (const schemaVersion of ["telemetry-envelope-v1.0", "telemetry-envelope-v0.1", "telemetry-envelope-v0.2"]) {
    const value = { schemaVersion, synthetic: false, keyId: "k", wrappedKey: "w", iv: "i", ciphertext: "c" };
    const registration = intake.contributionEnvelopes.find((entry) => entry.schemaVersion === schemaVersion);
    const body = Object.freeze({ raw: JSON.stringify(value), value });
    if (schemaVersion === "telemetry-envelope-v1.0") {
      const response = await registration.handler(body, participant, "synthetic-device", claimed, context);
      assert.equal(response.status, 202, schemaVersion);
      continue;
    }
    // Retired: the pre-claim check answers the uniform 503 (no retry-after),
    // and the handler behind it answers the same refusal.
    assert.throws(() => registration.validateEnvelope(value, body.raw), (error) => {
      assert.deepEqual([error.status, error.code, error.responseHeaders], [503, "POSTGRES_ROUTE_NOT_PORTED", undefined]);
      return true;
    }, schemaVersion);
    assert.throws(() => registration.handler(body, participant, "synthetic-device", claimed, context),
      { code: "POSTGRES_ROUTE_NOT_PORTED", status: 503 }, schemaVersion);
  }
  assert.deepEqual(calls, [["v1.0 admitter", "telemetry-envelope-v1.0"]]);
});

test("the retired v0.x formats never authorize: the write authority answers the uniform 503", async () => {
  const intake = createOriginIntakeComposition(options());
  for (const version of ["telemetry-contribution-v0.1", "telemetry-contribution-v0.2"]) {
    const format = intake.uploadAuthorizationFormats[version];
    assert.throws(() => format.assertUploadAllowed(pool, { participantId: "p", deviceId: "d" }, Date.now(),
      { schema: { primarySchema: "synthetic_primary" } }), (error) => {
      assert.deepEqual([error.status, error.code, error.responseHeaders], [503, "POSTGRES_ROUTE_NOT_PORTED", undefined]);
      return true;
    }, version);
  }
  // The live v1.x formats still reach the transport write authority.
  assert.throws(() => intake.uploadAuthorizationFormats["telemetry-contribution-v1.0"].assertUploadAllowed(
    pool, {}, 0, { schema: {} }), /assertPostgresTelemetryTransportWriteAllowed must not be reached/u);
});

test("only the host modes whose clients reach the intake compose it; the retired cloud-run-iam does not", () => {
  assert.deepEqual([...ORIGIN_INTAKE_HOST_MODES], ["health-and-v12-day-manifest", "fastpath-test"]);
  for (const mode of ORIGIN_INTAKE_HOST_MODES) assert.equal(originIntakeServedInMode(mode), true, mode);
  for (const mode of ["cloud-run-iam", "health-only", undefined, null, ""]) {
    assert.equal(originIntakeServedInMode(mode), false, String(mode));
  }
});

test("a wrong method on the shared legacy routes is the registry's 405 before storage; POST is the built-in's", async () => {
  let storageChecks = 0;
  const intake = createOriginIntakeComposition(options({
    async assertStorageCurrent() { storageChecks += 1; },
  }));
  for (const pathname of SHARED_LEGACY_PATHNAMES) {
    for (const method of ["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
      const wrong = await intake.dispatch(new Request(`${ORIGIN}${pathname}`, { method }));
      assert.equal(wrong.status, 405, `${method} ${pathname}`);
      assert.equal(wrong.headers.get("allow"), "POST", `${method} ${pathname}`);
      assert.equal(wrong.headers.get("cache-control"), "no-store");
      const body = await wrong.json();
      assert.deepEqual(Object.keys(body.error).sort(), ["code", "requestId"]);
      assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
    }
    assert.equal(await intake.dispatch(new Request(`${ORIGIN}${pathname}`, {
      method: "POST", body: "{}", headers: { "content-type": "application/json" },
    })), null, `POST ${pathname} is served by the built-in or its route module`);
  }
  assert.equal(storageChecks, 0, "the shared routes keep their own storage gates");
});

test("the v1.1 routes answer a wrong method before storage and refuse a stale schema before their handler", async () => {
  let storageChecks = 0;
  const stale = createOriginIntakeComposition(options({
    async assertStorageCurrent() {
      storageChecks += 1;
      throw Object.assign(new Error("BACKEND_STORAGE_UNAVAILABLE"), { code: "BACKEND_STORAGE_UNAVAILABLE", status: 503 });
    },
  }));
  for (const pathname of V11_PATHNAMES) {
    const allowed = ROUTE_POLICY.find((entry) => entry.pathname === pathname).methods;
    const before = storageChecks;
    const wrong = await stale.dispatch(new Request(`${ORIGIN}${pathname}`, { method: "DELETE" }));
    assert.equal(wrong.status, 405, pathname);
    assert.equal(wrong.headers.get("allow"), allowed.join(", "), pathname);
    assert.equal(storageChecks, before, "a wrong method never reads storage");
    for (const method of allowed) {
      const refused = await stale.dispatch(new Request(`${ORIGIN}${pathname}`, {
        method, ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}),
      }));
      assert.equal(refused.status, 503, `${method} ${pathname}`);
      assert.equal(refused.headers.get("cache-control"), "no-store");
      const body = await refused.json();
      assert.deepEqual(Object.keys(body.error).sort(), ["code", "requestId"]);
      assert.equal(body.error.code, "BACKEND_STORAGE_UNAVAILABLE");
    }
  }
  assert.equal(storageChecks, 5, "every allowed method checked the receipts once");
  assert.equal(await stale.dispatch(new Request(`${ORIGIN}/api/v1/me/telemetry-v12/domain-activate`,
    { method: "POST" })), null, "another path is not the intake's");
});

test("the composition refuses missing adapters and a route policy without its paths at startup", () => {
  const base = options();
  for (const [moduleName, name] of [
    ["legacyAdmission", "recordPostgresDeviceUploadReceipt"],
    ["transportWriteAuthority", "assertPostgresTelemetryTransportWriteAllowed"],
    ["transport", "authenticatePostgresDevice"],
    ["uploadAuthorization", "createPostgresDeviceUploadAuthorization"],
  ]) {
    const adapters = { ...base.adapters, [moduleName]: { ...base.adapters[moduleName], [name]: undefined } };
    assert.throws(() => createOriginIntakeComposition({ ...base, adapters }),
      (error) => error.code === "ORIGIN_INTAKE_COMPOSITION_INVALID", `${moduleName}.${name}`);
  }
  assert.throws(() => createOriginIntakeComposition({ ...base, assertStorageCurrent: undefined }),
    (error) => error.code === "ORIGIN_INTAKE_COMPOSITION_INVALID");
  // One schema, no deletion-ledger pool or adapter (LEAD-SIMP).
  for (const schemaOptions of [
    { primarySchema: "synthetic_primary", ledgerSchema: "synthetic_primary_ledger" },
    {},
    null,
    { primarySchema: 1 },
  ]) {
    assert.throws(() => createOriginIntakeComposition({ ...base, schemaOptions }),
      (error) => error.code === "ORIGIN_INTAKE_COMPOSITION_INVALID", JSON.stringify(schemaOptions));
  }
  assert.equal("ledgerAuthority" in base.adapters, false);
  assert.doesNotThrow(() => createOriginIntakeComposition(base));
  assert.throws(() => createOriginIntakeComposition({
    ...base, routePolicy: ROUTE_POLICY.filter((entry) => !entry.pathname.includes("domain-activate")),
  }), (error) => error.code === "ORIGIN_INTAKE_COMPOSITION_INVALID");
});
