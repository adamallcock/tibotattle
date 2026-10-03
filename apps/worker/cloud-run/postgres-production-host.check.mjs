import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { after, before, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// CR-7 production composition (D-CRB) without a database: HOST_MODE
// production and staging compose from the CR-3 configuration alone, with
// the plane's origin-tier limits; the bind address is 0.0.0.0 only for a
// validated Cloud Run service; refusals happen before any pool and close
// what opened; the registry ports the production list (plus the six admin
// routes only when the composition root opens the admin host); requests
// that need no storage (unported routes, the refused or chokepointed admin
// host, EP-6 refusals) answer through the real EP-6 boundary and the CR-6
// handler; startup refuses a drift between the edge-tier binding lists and
// between the health flags and the registry; and run_maintenance answers a
// refused or failed lifecycle pass with an error and a failure audit. The
// storage paths (RD-2, RD-3, the families, the lifecycle pass, the admin
// action over it and the ingress lease) run against PostgreSQL 17 in
// postgres-test/postgres-production-host.spec.mjs. Every value is synthetic.

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const INVOKER = "edge-invoker@synthetic-project.iam.gserviceaccount.com";
const VERIFIER = "edge-verifier@synthetic-project.iam.gserviceaccount.com";
const AUDIENCE = "tibotattle-origin-audience";
const RUN_APP_ORIGIN = "https://tibotattle-origin-abc123def4-ue.a.run.app";
const REQUEST_ID = "4f2c8a7e-1b3d-4e5f-9a6b-7c8d9e0f1a2b";

let vite;
let host;
let configuration;
let composition;
let dispatchModule;
let errors;
let routeRegistry;
let runtimeSchema;
let registry;

before(async () => {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  [host, configuration, composition, dispatchModule, errors, routeRegistry, runtimeSchema, registry] = await Promise.all([
    vite.ssrLoadModule("/cloud-run/postgres-production-host.mjs"),
    vite.ssrLoadModule("/cloud-run/postgres-production-configuration.mjs"),
    vite.ssrLoadModule("/src/backend-composition.ts"),
    vite.ssrLoadModule("/cloud-run/postgres-test-dispatch.mjs"),
    vite.ssrLoadModule("/src/errors.ts"),
    vite.ssrLoadModule("/src/route-registry.ts"),
    vite.ssrLoadModule("/src/postgres-runtime-schema.ts"),
    vite.ssrLoadModule("/cloud-run/postgres-production-registry.mjs"),
  ]);
});

after(async () => {
  await vite?.close();
});

function proof(bucket) {
  return JSON.stringify({ bucket, bucketGeneration: "1700000000000001", bucketMetageneration: "1",
    softDeleteRetentionDurationSeconds: "0" });
}

function envelopeKeys(kid) {
  return {
    ENVELOPE_PUBLIC_JWK: JSON.stringify({ kty: "RSA", kid, n: "synthetic-modulus", e: "AQAB" }),
    ENVELOPE_PRIVATE_JWK: JSON.stringify({ kty: "RSA", kid, n: "synthetic-modulus", e: "AQAB", d: "synthetic-d" }),
  };
}

const SECRETS = Object.freeze({
  IDENTITY_LINK_SECRET: "synthetic-identity-link-secret-value-0000000001",
  POSTGRES_RATE_LIMIT_SECRET: "synthetic-rate-limit-secret-value-00000000002",
});

function productionEnv(overrides = {}) {
  return {
    HOST_MODE: "production",
    HOST: "0.0.0.0",
    PORT: "8080",
    K_SERVICE: "tibotattle-origin",
    HOST_ORIGIN: RUN_APP_ORIGIN,
    PUBLIC_ORIGIN: "https://tibotattle.com",
    EDGE_ORIGIN_MODE: "cloudflare-worker-iam",
    EDGE_ORIGIN_AUDIENCE: AUDIENCE,
    EDGE_INVOKER_SERVICE_ACCOUNT: INVOKER,
    EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: VERIFIER,
    DEPLOYMENT_SOURCE_COMMIT: COMMIT,
    TELEMETRY_STORAGE_NAMESPACE: "synthetic-namespace",
    PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-primary",
    PRIMARY_DATABASE: "origin_primary",
    PRIMARY_SCHEMA: "origin_primary",
    POSTGRES_IAM_USER: "origin-runtime@synthetic-project.iam",
    GCS_BUCKET_NAME: "synthetic-origin-quarantine",
    GCS_QUARANTINE_BUCKET_HISTORY_PROOF: proof("synthetic-origin-quarantine"),
    ...envelopeKeys("key:synthetic-production-host"),
    ...SECRETS,
    ...overrides,
  };
}

function stagingEnv(overrides = {}) {
  return productionEnv({
    HOST_MODE: "staging",
    K_SERVICE: "tibotattle-staging-origin",
    HOST_ORIGIN: "https://tibotattle-staging-origin-abc123def4-ue.a.run.app",
    PUBLIC_ORIGIN: "https://staging.synthetic.example",
    ADMIN_HOST_ORIGIN: "https://admin.staging.synthetic.example",
    TELEMETRY_STORAGE_NAMESPACE: "synthetic-staging-namespace",
    PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-staging-primary",
    GCS_BUCKET_NAME: "synthetic-staging-quarantine",
    GCS_QUARANTINE_BUCKET_HISTORY_PROOF: proof("synthetic-staging-quarantine"),
    ACCESS_TEAM_DOMAIN: "synthetic.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64),
    ACCESS_ADMIN_EMAIL: "owner@synthetic.example",
    IDENTITY_LINK_SECRET_VERSION: "staging-v1",
    GOOGLE_OIDC_CLIENT_ID: "123456789012-syntheticstaging.apps.googleusercontent.com",
    ...envelopeKeys("key:synthetic-staging-host"),
    ...overrides,
  });
}

/** Injected seams that record every construction and never reach a network. */
function dependencies({ factory } = {}) {
  const calls = [];
  const pools = [];
  return {
    calls,
    pools,
    dependencies: {
      createConnector() {
        calls.push("connector");
        return { close() { calls.push("connector-closed"); } };
      },
      async createIamPool(options) {
        calls.push(`pool:${options.applicationName}:${options.max}`);
        const pool = {
          options,
          async connect() { throw new Error("no connection in the offline check"); },
          async end() { calls.push(`pool-end:${options.applicationName}`); },
        };
        pools.push(pool);
        return pool;
      },
      async createGoogleAccessTokenProvider() {
        calls.push("token-provider");
        return async () => "synthetic-access-token";
      },
      createGcsQuarantineObjectStore(bucket, _token, _fetch, _timeout, historyProof) {
        calls.push(`object-store:${bucket}:${historyProof?.bucket}`);
        return { async head() { return null; }, async put() {}, async delete() {} };
      },
      ...(factory === undefined ? {} : { createAnalyticsV2CommunityDailyRoute: factory }),
      logger: () => {},
    },
  };
}

async function refusedBefore(work, code, label) {
  await assert.rejects(work, (error) => {
    assert.equal(error?.code, code, label);
    return true;
  }, label);
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: AUDIENCE, email: INVOKER, email_verified: true, exp: now + 3_000, iat: now - 60,
    iss: "https://accounts.google.com", sub: "100000000000000000000", ...overrides };
  return `Bearer ${base64UrlJson({ alg: "RS256", kid: "0".repeat(40), typ: "JWT" })}.${base64UrlJson(payload)}`
    + ".SIGNATURE_REMOVED_BY_GOOGLE";
}

function invokerRequest(path, { method = "GET", hostKind = "apex", headers = {} } = {}) {
  return new Request(`${RUN_APP_ORIGIN}${path}`, {
    method,
    headers: {
      "x-serverless-authorization": token(),
      "x-tibotattle-edge-host": hostKind,
      "x-tibotattle-edge-request-id": REQUEST_ID,
      ...headers,
    },
  });
}

test("constants: the composition root's owner answers", () => {
  assert.deepEqual({ ...host.PRODUCTION_HOST_MODES }, { production: "production", staging: "staging" });
  // OWN-17 was answered in round 12 (open with what is ported): ADMIN-R12
  // opens the production and staging admin host (OD-CR-3). The edge-test
  // rehearsal composes no admin family, so its admin host stays refused.
  assert.equal(host.PRODUCTION_ADMIN_HOST_POLICY, "chokepoint");
  assert.equal(host.EDGE_TEST_ADMIN_HOST_POLICY, "refuse");
  assert.equal(host.PRODUCTION_UNPORTED_RETRY_AFTER_SECONDS, null, "OD-CR-6 (iv)");
  assert.equal(host.PRODUCTION_STORAGE_GATE_TTL_MILLISECONDS, 0, "OD-ROLL / OD-CR-10");
  assert.deepEqual(Object.keys(host.createUploadIngressAuthority()).sort(),
    ["acquireLease", "assertConfiguration", "bodyReadPolicy", "releaseLease", "startHeartbeat"]);
});

test("the bind address: 0.0.0.0 only for a validated Cloud Run service, else 127.0.0.1", () => {
  const cfg = configuration.readProductionConfiguration(productionEnv(), "production");
  const env = (overrides) => ({ K_SERVICE: "tibotattle-origin", ...overrides });
  assert.equal(host.productionListenHost(env({ HOST: "0.0.0.0" }), cfg), "0.0.0.0");
  assert.equal(host.productionListenHost(env({ HOST: "127.0.0.1" }), cfg), "127.0.0.1");
  assert.equal(host.productionListenHost(env({}), cfg), "127.0.0.1", "unset binds loopback");
  assert.equal(host.productionListenHost(env({ HOST: "" }), cfg), "127.0.0.1");
  for (const [label, processEnv, configurationValue] of [
    ["another K_SERVICE", { HOST: "0.0.0.0", K_SERVICE: "other-service" }, cfg],
    ["no K_SERVICE", { HOST: "0.0.0.0" }, cfg],
    ["a job configuration", env({ HOST: "0.0.0.0" }), { deployment: { workload: { kind: "job", name: "tibotattle-origin" } },
      origins: cfg.origins }],
    ["a non-run.app host origin", env({ HOST: "0.0.0.0" }), { ...cfg,
      origins: { ...cfg.origins, host: "https://tibotattle.com" } }],
    ["no configuration", env({ HOST: "0.0.0.0" }), null],
    ["another address", env({ HOST: "10.0.0.1" }), cfg],
    ["localhost by name", env({ HOST: "localhost" }), cfg],
  ]) {
    assert.throws(() => host.productionListenHost(processEnv, configurationValue), { code: "HOST_INVALID" }, label);
  }
});

test("HOST_MODE production composes from CR-3: three primary pools, the production list, EP-6 in front", async () => {
  const seams = dependencies();
  const runtime = await host.createPostgresProductionRuntime({
    processEnv: productionEnv(), hostMode: "production", dependencies: seams.dependencies,
  });
  try {
    assert.deepEqual(seams.calls, [
      "connector",
      "pool:tibotattle-origin-data:3",
      "pool:tibotattle-origin-admission:4",
      "pool:tibotattle-origin-readiness:1",
      "token-provider",
      "object-store:synthetic-origin-quarantine:synthetic-origin-quarantine",
    ], "every pool on the primary, the store with CR-3's bucket birth proof (OD-2)");
    for (const pool of seams.pools) {
      assert.equal(pool.options.instanceConnectionName, "synthetic-project:us-east1:origin-primary");
      assert.equal(pool.options.database, "origin_primary");
      assert.equal(pool.options.user, "origin-runtime@synthetic-project.iam");
    }
    assert.equal(runtime.hostMode, "production");
    assert.equal(runtime.hostOrigin, RUN_APP_ORIGIN);
    assert.equal(runtime.listenHost, "0.0.0.0");
    assert.equal(runtime.listenPort, 8080);
    assert.equal(configuration.isProductionConfiguration(runtime.configuration), true);
    // Round 12 (ADMIN-R12): the default composition opens the admin host,
    // so the six admin routes are ported beside the production list.
    assert.deepEqual([...runtime.registry.portedRouteIds].sort(), [
      ...composition.POSTGRES_PORTED_WORKER_ROUTE_IDS, ...composition.POSTGRES_ADMIN_HOST_ROUTE_IDS].sort());
    assert.deepEqual([...runtime.registry.unportedRouteIds], [...registry.RETIRED_ROUTE_IDS].sort());
    assert.deepEqual([...runtime.registry.definiteRouteIds], ["accountless_telemetry_performance_authorization"]);

    // A retired route: the closed 503 under the edge's request id, no
    // retry-after (OD-CR-6 iv), no-store, marked by EP-6. No storage is read.
    for (const [path, method] of [["/api/v1/me/export", "GET"], ["/api/v1/enroll", "POST"],
      ["/api/v1/identity/google/start", "POST"], ["/api/v1/identity/apple/start", "POST"],
      ["/api/v1/me/security-reset", "POST"], ["/api/v1/device/telemetry/performance/capabilities", "GET"],
      ["/api/v1/me/device-telemetry-performance-consents", "POST"],
      ["/api/v1/device/telemetry/performance/reports", "POST"]]) {
      const unported = await runtime.productionDispatch(invokerRequest(path, { method }));
      assert.equal(unported.status, 503, path);
      assert.deepEqual(await unported.json(), { error: { code: "POSTGRES_ROUTE_NOT_PORTED", requestId: REQUEST_ID } },
        path);
      assert.equal(unported.headers.get("retry-after"), null, path);
      assert.equal(unported.headers.get("cache-control"), "no-store", path);
      assert.equal(unported.headers.get("x-tibotattle-origin"), "1", path);
    }
    // The accountless performance authorization runs the composed round-19
    // preamble (production's earlier answers): a session cookie is its first
    // refusal, 401 AUTH_INVALID, before any read. The rest of the sequence
    // and the terminal 403 are proved by retired-performance-authorization
    // .check.mjs and, over PostgreSQL, postgres-production-host.spec.mjs.
    assert.equal(typeof runtime.registry.resolve("accountless_telemetry_performance_authorization").handler,
      "function");
    const performance = await runtime.productionDispatch(invokerRequest(
      "/api/v1/accountless/telemetry-performance-authorization",
      { method: "POST", headers: { cookie: "__Host-usage_monitor_session=synthetic" } }));
    assert.equal(performance.status, 401);
    assert.deepEqual(await performance.json(), { error: { code: "AUTH_INVALID", requestId: REQUEST_ID } });
    assert.equal(performance.headers.get("retry-after"), null);
    assert.equal(performance.headers.get("cache-control"), "no-store");
    assert.equal(performance.headers.get("x-tibotattle-origin"), "1");
    // The admin host now runs the Access chokepoint first: a forged assertion
    // is the Worker's 403, before any family or read.
    const admin = await runtime.productionDispatch(invokerRequest("/api/v1/admin/overview",
      { hostKind: "admin", headers: { "cf-access-jwt-assertion": "synthetic.access.jwt" } }));
    assert.equal(admin.status, 403);
    assert.equal((await admin.json()).error.code, "ACCESS_REQUIRED");
    // The six admin ids are 404 on the apex.
    const apexAdmin = await runtime.productionDispatch(invokerRequest("/api/v1/admin/overview"));
    assert.equal(apexAdmin.status, 404);
    // EP-6 refuses a stranger and a verifier off its read paths: the unmarked 421.
    const stranger = await runtime.productionDispatch(new Request(`${RUN_APP_ORIGIN}/api/health`, {
      headers: { "x-serverless-authorization": token({ email: "stranger@synthetic-project.iam.gserviceaccount.com" }) },
    }));
    assert.equal(stranger.status, 421);
    assert.equal(stranger.headers.get("x-tibotattle-origin"), null);
    const verifierWrite = await runtime.productionDispatch(new Request(`${RUN_APP_ORIGIN}/api/v1/contributions`, {
      method: "POST", body: "{}", headers: { "x-serverless-authorization": token({ email: VERIFIER }) },
    }));
    assert.equal(verifierWrite.status, 421);
  } finally {
    for (const pool of runtime.pools) await pool.end();
  }
});

test("OD-CR-3 'refuse' stays available to a caller that passes it: the admin host is the unported 503", async () => {
  const seams = dependencies();
  const runtime = await host.createPostgresProductionRuntime({
    processEnv: productionEnv(), hostMode: "production", adminHostPolicy: "refuse",
    dependencies: seams.dependencies,
  });
  try {
    assert.deepEqual([...runtime.registry.portedRouteIds], [...composition.POSTGRES_PORTED_WORKER_ROUTE_IDS]);
    for (const id of composition.POSTGRES_ADMIN_HOST_ROUTE_IDS) {
      assert.equal(runtime.registry.resolve(id).disposition, "unported", id);
    }
    const admin = await runtime.productionDispatch(invokerRequest("/api/v1/admin/overview",
      { hostKind: "admin", headers: { "cf-access-jwt-assertion": "synthetic.access.jwt" } }));
    assert.equal(admin.status, 503);
    assert.equal((await admin.json()).error.code, "POSTGRES_ROUTE_NOT_PORTED");
  } finally {
    for (const pool of runtime.pools) await pool.end();
  }
});

test("OD-CR-3 'chokepoint' (the OWN-17 switch, ADMIN-R12 default): six more routes, Access before any family", async () => {
  const seams = dependencies();
  const runtime = await host.createPostgresProductionRuntime({
    processEnv: productionEnv(), hostMode: "production",
    dependencies: seams.dependencies,
  });
  try {
    assert.deepEqual([...runtime.registry.portedRouteIds].sort(), [
      ...composition.POSTGRES_PORTED_WORKER_ROUTE_IDS, ...composition.POSTGRES_ADMIN_HOST_ROUTE_IDS].sort());
    // Without an Access token the chokepoint answers before any family or read.
    const missing = await runtime.productionDispatch(invokerRequest("/api/v1/admin/overview", { hostKind: "admin" }));
    assert.equal(missing.status, 403);
    assert.equal((await missing.json()).error.code, "ACCESS_REQUIRED");
    const action = await runtime.productionDispatch(invokerRequest("/api/v1/admin/action",
      { method: "POST", hostKind: "admin" }));
    assert.equal(action.status, 403);
  } finally {
    for (const pool of runtime.pools) await pool.end();
  }
});

test("HOST_MODE staging uses the staging plane's origin-tier limits (300/6), not production's", async () => {
  const seams = dependencies();
  const runtime = await host.createPostgresProductionRuntime({
    processEnv: stagingEnv(), hostMode: "staging", dependencies: seams.dependencies,
  });
  try {
    assert.equal(runtime.configuration.plane, "staging");
    assert.equal(runtime.configuration.rateLimits.originTier.UPLOAD_AUTHORIZATION.limit, 300);
    assert.equal(runtime.configuration.rateLimits.originTier.UPLOAD_PRINCIPAL.limit, 6);
    // createProductionWorkerEnv refuses a limiter whose limit is not the
    // plane's (<NAME>_BINDING_LIMIT_MISMATCH); the composition succeeded, so
    // both origin-tier limiters carry the staging values. Staging opens its
    // admin host as production does (round 12).
    assert.deepEqual([...runtime.registry.portedRouteIds].sort(), [
      ...composition.POSTGRES_PORTED_WORKER_ROUTE_IDS, ...composition.POSTGRES_ADMIN_HOST_ROUTE_IDS].sort());
  } finally {
    for (const pool of runtime.pools) await pool.end();
  }
});

test("refusals: closed codes before any pool, and a later refusal closes what opened", async () => {
  for (const [label, options, code] of [
    ["unknown mode", { processEnv: productionEnv(), hostMode: "preview" }, "HOST_MODE_INVALID"],
    ["no mode", { processEnv: productionEnv() }, "HOST_MODE_INVALID"],
    ["undecided admin host", { processEnv: productionEnv(), hostMode: "production", adminHostPolicy: "open" },
      "ADMIN_HOST_POLICY_INVALID"],
    // CR-3's own codes pass through, first refused setting first.
    ["no commit", { processEnv: productionEnv({ DEPLOYMENT_SOURCE_COMMIT: undefined }), hostMode: "production" },
      "DEPLOYMENT_SOURCE_COMMIT_MISSING"],
    ["a test mode", { processEnv: productionEnv({ POSTGRES_TEST_HTTP_MODE: "" }), hostMode: "production" },
      "POSTGRES_TEST_HTTP_MODE_FORBIDDEN"],
    ["a ledger setting", { processEnv: productionEnv({ LEDGER_DATABASE: "x" }), hostMode: "production" },
      "LEDGER_DATABASE_FORBIDDEN"],
    // Round 12: a pre-round-12 template that still mounts a sign-in secret fails closed.
    ["a retired Google secret", { processEnv: productionEnv({ GOOGLE_OIDC_CLIENT_SECRET: "x" }), hostMode: "production" },
      "GOOGLE_OIDC_CLIENT_SECRET_RETIRED"],
    ["a retired Apple key", { processEnv: productionEnv({ APPLE_PRIVATE_KEY: "" }), hostMode: "production" },
      "APPLE_PRIVATE_KEY_RETIRED"],
    ["a retired Apple id", { processEnv: stagingEnv({ APPLE_KEY_ID: "SYNTHKEY01" }), hostMode: "staging" },
      "APPLE_KEY_ID_RETIRED"],
    ["a test JWKS seam", { processEnv: productionEnv({ ACCESS_TEST_JWKS_JSON: "{}" }), hostMode: "production" },
      "ACCESS_TEST_JWKS_JSON_FORBIDDEN"],
    ["staging values under production", { processEnv: stagingEnv(), hostMode: "production" },
      "PUBLIC_ORIGIN_INVALID"],
    ["a public bind without the service", { processEnv: productionEnv({ K_SERVICE: undefined }), hostMode: "production" },
      "K_SERVICE_MISSING"],
    ["a non-run.app host origin", { processEnv: productionEnv({ HOST_ORIGIN: "https://tibotattle.com" }),
      hostMode: "production" }, "HOST_ORIGIN_INVALID"],
    ["a bad port", { processEnv: productionEnv({ PORT: "80800" }), hostMode: "production" }, "PORT_INVALID"],
  ]) {
    const seams = dependencies();
    const env = Object.fromEntries(Object.entries(options.processEnv).filter(([, value]) => value !== undefined));
    await refusedBefore(() => host.createPostgresProductionRuntime({ ...options, processEnv: env,
      dependencies: seams.dependencies }), code, label);
    assert.deepEqual(seams.calls, [], `${label}: no connector, pool or store`);
  }
  // The analytics module is mandatory: without a factory the composition
  // refuses after opening its pools, and closes every one.
  const seams = dependencies({ factory: false });
  await refusedBefore(() => host.createPostgresProductionRuntime({ processEnv: productionEnv(), hostMode: "production",
    dependencies: seams.dependencies }), "ANALYTICS_V2_COMMUNITY_DAILY_ROUTE_UNAVAILABLE", "no analytics factory");
  assert.deepEqual(seams.calls.filter((call) => call.startsWith("pool-end:")).sort(), [
    "pool-end:tibotattle-origin-admission", "pool-end:tibotattle-origin-data", "pool-end:tibotattle-origin-readiness",
  ]);
  assert.ok(seams.calls.includes("connector-closed"));
});

test("round 16: under the rotated identity-link label no identity-link consumer may be composed", () => {
  // Production carries the rotated label; staging its own, unrotated one.
  assert.equal(configuration.readProductionConfiguration(productionEnv(), "production").vars.IDENTITY_LINK_SECRET_VERSION,
    "production-v2");
  const ported = [...composition.POSTGRES_PORTED_WORKER_ROUTE_IDS];
  const admin = [...composition.POSTGRES_ADMIN_HOST_ROUTE_IDS];
  assert.equal(host.assertIdentityLinkRotationComposable("production-v2", ported), true);
  assert.equal(host.assertIdentityLinkRotationComposable("production-v2", [...ported, ...admin]), true);
  assert.equal(host.assertIdentityLinkRotationComposable("staging-v1", [...ported, "enroll"]), false,
    "an unrotated label is left to the registry's own retired-route refusal");
  for (const id of ["enroll", "identity_google_callback", "identity_apple_result", "security_reset", "participant_export"]) {
    assert.throws(() => host.assertIdentityLinkRotationComposable("production-v2", [...ported, id]),
      (error) => error.code === "IDENTITY_LINK_ROTATION_CONSUMER_PORTED" && error.message === error.code, id);
  }
  // The production composition itself passes it (the composition test above runs under production-v2).
});

test("composeOriginFamilies refuses an incomplete dependency set", () => {
  assert.throws(() => host.composeOriginFamilies(null), { code: host.ORIGIN_COMPOSITION_INVALID });
  assert.throws(() => host.composeOriginFamilies({ dataPool: { connect() {} } }), { code: host.ORIGIN_COMPOSITION_INVALID });
});

/**
 * Pools whose connections answer from a script: the data pool can be held
 * (every connect waits until released, then fails), the admission pool
 * answers the ingress-budget probe as a fresh, full budget, and the
 * readiness pool answers every statement with no rows. Connects are counted
 * per pool name; no network is reached.
 */
function scriptedPools() {
  const connects = new Map();
  const held = [];
  let hold = false;
  const client = (name) => ({
    async query(sql) {
      const text = String(sql);
      const now = String(Date.now());
      if (name === "tibotattle-origin-admission" && text.includes("SELECT tokens")) {
        return { rows: [{ tokens: "64", updated_at_ms: now, concurrency_denials: "0", start_rate_denials: "0",
          last_denied_at_ms: null }], rowCount: 1 };
      }
      if (text.includes("AS now_ms")) return { rows: [{ now_ms: now }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  });
  return {
    connects,
    hold() { hold = true; },
    release() {
      hold = false;
      for (const reject of held.splice(0)) reject(new Error("synthetic: released without a connection"));
    },
    heldCount: () => held.length,
    async createIamPool(options) {
      const name = options.applicationName;
      connects.set(name, 0);
      return {
        options,
        async connect() {
          connects.set(name, connects.get(name) + 1);
          if (name === "tibotattle-origin-data") {
            if (hold) return new Promise((_, reject) => { held.push(reject); });
            throw new Error("synthetic: no data connection");
          }
          return client(name);
        },
        async end() {},
      };
    },
  };
}

test("OD-CR-6 (i): every ported route's error answer is the Worker envelope under the edge's request id, query or not",
  async () => {
    const seams = dependencies();
    const runtime = await host.createPostgresProductionRuntime({
      processEnv: productionEnv(), hostMode: "production", dependencies: seams.dependencies,
    });
    try {
      const ported = new Set(composition.POSTGRES_PORTED_WORKER_ROUTE_IDS);
      const queryRefused = [];
      let answered = 0;
      for (const route of routeRegistry.WORKER_ROUTE_POLICY) {
        if (!ported.has(route.id)) continue;
        const methods = route.methods === "all" ? ["GET", "POST"] : route.methods;
        for (const method of methods) {
          for (const query of ["", "?synthetic=1"]) {
            const label = `${method} ${route.id}${query}`;
            const response = await runtime.productionDispatch(invokerRequest(`${route.pathname}${query}`, {
              method,
              headers: {
                "content-type": "application/json",
                authorization: `Upload um_device_upload_${crypto.randomUUID()}.${"A".repeat(43)}`,
              },
              ...(method === "GET" ? {} : { body: "{}" }),
            }));
            answered += 1;
            assert.equal(response.headers.get("x-tibotattle-origin"), "1", label);
            if (response.status < 400) continue;
            const body = await response.json();
            assert.deepEqual(Object.keys(body), ["error"], `${label}: the Worker envelope, never a flat body`);
            assert.equal(body.error.requestId, REQUEST_ID, `${label}: the edge's request id`);
            assert.match(body.error.code, /^[A-Z0-9_]+$/u, label);
            if (body.error.code === "POSTGRES_TEST_ROUTE_UNSUPPORTED") {
              assert.equal(response.status, 503, label);
              assert.equal(response.headers.get("retry-after"), null, label);
              assert.equal(query, "?synthetic=1", `${label}: only a query string reaches this refusal`);
              queryRefused.push(route.id);
            }
          }
        }
      }
      assert.ok(answered > 60, "every ported route and method was asked");
      // OD-CR-6 (ii), accepted: exactly the POST routes that serve no query.
      assert.deepEqual(queryRefused.sort(), [
        "accountless_enrollment", "accountless_ownership", "accountless_renewal",
        "accountless_telemetry_v12_authorization", "contributions", "device_credential_renew",
        "device_upload_authorization", "telemetry_v12_day_manifests", "telemetry_v12_domain_activate",
        "telemetry_v12_domain_predecessor",
      ]);
    } finally {
      for (const pool of runtime.pools) await pool.end();
    }
  });

test("the storage gate reads on the data pool: forty gated requests never queue /api/ready or /api/health", async () => {
  // TTL 0 (OD-ROLL / OD-CR-10) gives every gated request its own receipt
  // read. On the one readiness connection those reads would queue RD-2 and
  // RD-3 behind request traffic; on the data pool they wait where the
  // request's own reads wait, and the readiness pool stays the status
  // families' alone.
  const pools = scriptedPools();
  const seams = dependencies();
  const runtime = await host.createPostgresProductionRuntime({
    processEnv: productionEnv(), hostMode: "production",
    dependencies: { ...seams.dependencies, createIamPool: pools.createIamPool },
  });
  try {
    pools.hold();
    const gated = Array.from({ length: 40 }, () => runtime.productionDispatch(invokerRequest("/api/v1/community/daily")));
    for (let turn = 0; turn < 50 && pools.heldCount() < 40; turn += 1) await new Promise((done) => setImmediate(done));
    assert.equal(pools.heldCount(), 40, "each gated request makes its own read (no shared read, no reuse)");
    assert.equal(pools.connects.get("tibotattle-origin-data"), 40);
    assert.equal(pools.connects.get("tibotattle-origin-readiness"), 0, "no gate read touches the readiness pool");
    // While every data connection is held, readiness and health still answer
    // from the readiness pool (and the budget probe from the admission pool).
    for (const path of ["/api/ready", "/api/health"]) {
      const before = pools.connects.get("tibotattle-origin-readiness");
      const answer = await Promise.race([
        runtime.productionDispatch(invokerRequest(path)),
        new Promise((done) => { setTimeout(() => done(null), 5_000).unref(); }),
      ]);
      assert.notEqual(answer, null, `${path} answered while the gate's reads were held`);
      assert.equal(answer.headers.get("x-tibotattle-origin"), "1", path);
      assert.ok(pools.connects.get("tibotattle-origin-readiness") > before, `${path} read the readiness pool`);
    }
    assert.equal(pools.connects.get("tibotattle-origin-data"), 40, "readiness and health took no data connection");
    assert.equal(pools.heldCount(), 40, "the gated requests were still waiting");
    pools.release();
    for (const response of await Promise.all(gated)) {
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(),
        { error: { code: "BACKEND_STORAGE_UNAVAILABLE", requestId: REQUEST_ID } }, "a failed read refuses closed");
    }
  } finally {
    pools.release();
    for (const pool of runtime.pools) await pool.end();
  }
});

/** The community-daily family over a pool it never reaches. */
function communityDailyFamily(overrides) {
  return dispatchModule.createPostgresTestCommunityDailyDispatch({
    requestContext: () => ({ requestId: REQUEST_ID }),
    primaryPool: { async connect() { throw new Error("synthetic: the family must not read"); } },
    schemaOptions: { primarySchema: "origin_primary" },
    sourceIdentity: { sourceId: "synthetic-source", sourceNamespace: "synthetic-namespace" },
    readPostgresPublishedCommunityDaily: async () => { throw new Error("synthetic: the family must not read"); },
    healthDispatch: async () => new Response(null, { status: 503 }),
    ...overrides,
  });
}

const COMMUNITY_DAILY_READ = "/api/v1/community/daily?from=2026-09-01&to=2026-09-30";

async function assertAdmitted(family, origin, label) {
  const response = await family(new Request(`${origin}${COMMUNITY_DAILY_READ}`));
  assert.equal(response.status, 503, label);
  assert.deepEqual(await response.json(), { error: { code: "BACKEND_STORAGE_UNAVAILABLE", requestId: REQUEST_ID } },
    `${label}: admitted, so the storage gate answered`);
}

async function assertRefused(family, origin, label) {
  const response = await family(new Request(`${origin}${COMMUNITY_DAILY_READ}`));
  assert.equal(response.status, 503, label);
  assert.deepEqual(await response.json(), { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" },
    `${label}: refused before the gate`);
}

test("the families' origin admission: an issued configuration admits its public and admin origins, nothing else does",
  async () => {
    for (const [plane, env] of [["production", productionEnv()], ["staging", stagingEnv()]]) {
      const issued = configuration.readProductionConfiguration(env, plane);
      assert.equal(configuration.isProductionConfiguration(issued), true);
      const { public: publicOrigin, admin: adminOrigin } = issued.origins;
      assert.notEqual(publicOrigin, adminOrigin);
      const family = communityDailyFamily({ productionConfiguration: issued, privateOrigin: publicOrigin });
      await assertAdmitted(family, publicOrigin, `${plane} public origin`);
      // EP-6 rebuilds an admin-host request on the admin origin (critic hostGap 6).
      await assertAdmitted(family, adminOrigin, `${plane} admin origin`);
      for (const other of [issued.origins.host, "https://evil.tibotattle.com", "http://127.0.0.1:8080",
        "https://tibotattle.test", plane === "production" ? "https://admin.staging.synthetic.example"
          : "https://admin.tibotattle.com"]) {
        await assertRefused(family, other, `${plane} ${other}`);
      }
      // A lookalike (a copy CR-3 never issued, frozen or not) is refused at
      // construction; so is an issued configuration under another origin.
      for (const [label, lookalike] of [
        ["frozen copy", Object.freeze({ ...issued })],
        ["deep copy", JSON.parse(JSON.stringify(issued))],
        ["frozen deep copy", Object.freeze(JSON.parse(JSON.stringify(issued)))],
      ]) {
        assert.equal(configuration.isProductionConfiguration(lookalike), false, label);
        assert.throws(() => communityDailyFamily({ productionConfiguration: lookalike, privateOrigin: publicOrigin }),
          { code: "POSTGRES_TEST_PRIVATE_ORIGIN_INVALID" }, `${plane} ${label}`);
        assert.throws(() => host.composeOriginFamilies({
          dataPool: { async connect() { throw new Error("synthetic"); } },
          primarySchema: "origin_primary",
          sourceIdentity: { sourceId: "synthetic-source", sourceNamespace: "synthetic-namespace" },
          admissionEnv: Object.freeze({}),
          storageGate: { async assertCurrent() {}, async probe() { return new Response(null, { status: 200 }); } },
          dispatchOrigin: publicOrigin,
          productionConfiguration: lookalike,
          requestContext: () => undefined,
          routeModuleContext: () => Object.freeze({}),
          statusDispatchers: { health: async () => new Response(null), ready: async () => new Response(null) },
        }), { code: "POSTGRES_TEST_PRIVATE_ORIGIN_INVALID" }, `composeOriginFamilies: ${plane} ${label}`);
      }
      for (const privateOrigin of [adminOrigin, issued.origins.host, "http://127.0.0.1:8080"]) {
        assert.throws(() => communityDailyFamily({ productionConfiguration: issued, privateOrigin }),
          { code: "POSTGRES_TEST_PRIVATE_ORIGIN_INVALID" }, `${plane} private origin ${privateOrigin}`);
      }
    }
    // A test configuration admits its own private origin only: never an admin origin.
    const loopback = communityDailyFamily({ privateOrigin: "http://127.0.0.1:8080" });
    await assertAdmitted(loopback, "http://127.0.0.1:8080", "loopback test origin");
    for (const other of ["https://admin.tibotattle.com", "https://tibotattle.com", "https://tibotattle.test"]) {
      await assertRefused(loopback, other, `loopback test configuration: ${other}`);
    }
    const edgeTest = communityDailyFamily({ privateOrigin: "https://tibotattle.test" });
    await assertAdmitted(edgeTest, "https://tibotattle.test", "edge-test origin");
    await assertRefused(edgeTest, "https://admin.tibotattle.test", "edge-test configuration: an admin origin");
  });

const UPLOAD_ORIGIN = "http://127.0.0.1:8080";
const LEASE = Object.freeze({ leaseId: "synthetic-lease" });

/** A v1.2 dispatch whose contributions preamble runs on stubs (no pool is reached). */
function contributionsDispatch({ uploadIngress = null, claims = [] } = {}) {
  const unreachable = (name) => async () => { throw new Error(`synthetic: ${name} must not run`); };
  return dispatchModule.createPostgresTestV12DayManifestDispatch({
    requestContext: () => ({ requestId: REQUEST_ID }),
    primaryPool: { async connect() { throw new Error("synthetic: no pool"); } },
    expectedMigrations: runtimeSchema.POSTGRES_RUNTIME_MIGRATIONS,
    storageGate: { async assertCurrent() {}, async probe() { return new Response(null, { status: 200 }); } },
    privateOrigin: UPLOAD_ORIGIN,
    healthDispatch: async () => new Response(null, { status: 200 }),
    admissionEnv: Object.freeze({
      UPLOAD_INGRESS_REQUEST_RATE_LIMIT: { async limit() { return { success: true }; } },
      UPLOAD_INGRESS_CLIENT_RATE_LIMIT: { async limit() { return { success: true }; } },
    }),
    assertAdmissionBindings() {},
    assertAttemptAllowed: async () => {},
    assertUploadAuthorizationBindings() {},
    assertUploadAuthorizationAllowed: async () => {},
    assertUploadIngressRequestAllowed: async () => {},
    uploadIngress,
    authenticatePostgresDevice: unreachable("authenticatePostgresDevice"),
    disconnectPostgresAuthenticatedDevice: unreachable("disconnectPostgresAuthenticatedDevice"),
    readPostgresDeviceSyncState: unreachable("readPostgresDeviceSyncState"),
    readPostgresDeviceSyncCapabilities: unreachable("readPostgresDeviceSyncCapabilities"),
    readPostgresDeviceSyncV12Capabilities: unreachable("readPostgresDeviceSyncV12Capabilities"),
    readPostgresV12DayCandidates: unreachable("readPostgresV12DayCandidates"),
    createPostgresTypedV12Domain: () => ({ createPredecessor: unreachable("createPredecessor"),
      activate: unreachable("activate") }),
    readPostgresTelemetryV12EffectivePage: unreachable("readPostgresTelemetryV12EffectivePage"),
    publicEnvelopeKey: () => { throw new Error("synthetic: no envelope key"); },
    sourceNamespace: "synthetic-namespace",
    assertPostgresV12UploadAllowed: unreachable("assertPostgresV12UploadAllowed"),
    createPostgresDeviceUploadAuthorization: unreachable("createPostgresDeviceUploadAuthorization"),
    registerPostgresTypedV12DayManifest: unreachable("registerPostgresTypedV12DayManifest"),
    claimPostgresDeviceUploadAuthorization: async () => { claims.push("claim"); throw new Error("synthetic: no claim"); },
    abandonPostgresDeviceUploadAuthorization: async () => {},
    persistPostgresTypedV12StagedChunk: unreachable("persistPostgresTypedV12StagedChunk"),
    decryptSyntheticEnvelope: unreachable("decryptSyntheticEnvelope"),
    validateTelemetryV12Envelope() {},
    validateTelemetryV12StagedChunk: unreachable("validateTelemetryV12StagedChunk"),
    sha256Hex: async () => "0".repeat(64),
    objectStore: { async put() {}, async delete() {} },
    envelopePublicJwk: '{"synthetic":"public"}',
    envelopePrivateJwk: '{"synthetic":"private"}',
    readBoundedRequestBody: async () => new TextEncoder().encode("{}"),
    maxRequestBytes: 1_024,
  });
}

const UPLOAD_CREDENTIAL = `Upload um_device_upload_${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.${"A".repeat(43)}`;

function contribution() {
  return new Request(`${UPLOAD_ORIGIN}/api/v1/contributions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: UPLOAD_CREDENTIAL },
    body: "{}",
  });
}

/** An ingress authority that records every call; heartbeat and release behaviour are injected. */
function recordingAuthority({ assertActive = async () => {}, releaseLease = async () => {} } = {}) {
  const calls = [];
  return {
    calls,
    authority: Object.freeze({
      assertConfiguration() { calls.push("configuration"); },
      bodyReadPolicy() { calls.push("body-policy"); return { maximumTotalMilliseconds: 60_000, maximumIdleMilliseconds: 15_000 }; },
      async acquireLease() { calls.push("acquire"); return LEASE; },
      startHeartbeat(_env, lease) {
        calls.push(`heartbeat:${lease.leaseId}`);
        return {
          async assertActive() { calls.push("assert-active"); await assertActive(); },
          async stop() { calls.push("stop"); },
        };
      },
      async releaseLease(_env, lease) { calls.push(`release:${lease.leaseId}`); await releaseLease(); },
    }),
  };
}

test("contributions: no ingress authority fails closed, a lost heartbeat answers the Worker's code, the lease is always released",
  async (t) => {
    // Built without the authority, the route fails closed before any byte or claim.
    const claims = [];
    const bare = await contributionsDispatch({ claims })(contribution());
    assert.equal(bare.status, 503);
    assert.deepEqual(await bare.json(), { error: { code: "ADMISSION_CONFIGURATION_INVALID", requestId: REQUEST_ID } });
    assert.deepEqual(claims, []);
    // A malformed authority is refused when the dispatch is built.
    assert.throws(() => contributionsDispatch({ uploadIngress: { acquireLease() {} } }),
      { code: "POSTGRES_TEST_V12_DISPATCH_CONFIGURATION_INVALID" });

    // The heartbeat fails after the body: the Worker's 503
    // UPLOAD_INGRESS_UNAVAILABLE (with its retry-after), no claim, and the
    // heartbeat is stopped and the lease released.
    const lost = recordingAuthority({
      assertActive: async () => {
        throw new errors.ApiError(503, "UPLOAD_INGRESS_UNAVAILABLE", { responseHeaders: { "retry-after": "60" } });
      },
    });
    const lostClaims = [];
    const fenced = await contributionsDispatch({ uploadIngress: lost.authority, claims: lostClaims })(contribution());
    assert.equal(fenced.status, 503);
    assert.deepEqual(await fenced.json(), { error: { code: "UPLOAD_INGRESS_UNAVAILABLE", requestId: REQUEST_ID } });
    assert.equal(fenced.headers.get("retry-after"), "60");
    assert.deepEqual(lostClaims, [], "the claim is never reached once the lease is lost");
    assert.deepEqual(lost.calls, ["configuration", "body-policy", "acquire", "heartbeat:synthetic-lease",
      "assert-active", "stop", "release:synthetic-lease"]);

    // A failed release never changes the answer; it writes exactly one
    // content-free warn line.
    const warnings = [];
    const warn = mock.method(console, "warn", (...args) => { warnings.push(args.join(" ")); });
    t.after(() => warn.mock.restore());
    const failing = recordingAuthority({ releaseLease: async () => {
      throw new Error(`synthetic release failure ${UPLOAD_CREDENTIAL}`);
    } });
    const refused = await contributionsDispatch({ uploadIngress: failing.authority })(contribution());
    warn.mock.restore();
    assert.equal(refused.status, 400, "the body's own refusal stands");
    assert.deepEqual(await refused.json(), { error: { code: "ENVELOPE_INVALID", requestId: REQUEST_ID } });
    assert.deepEqual(failing.calls.slice(-2), ["stop", "release:synthetic-lease"]);
    assert.deepEqual(warnings, ['{"level":"warn","event":"upload_ingress_lease_release_failed"}']);
    assert.deepEqual(Object.keys(JSON.parse(warnings[0])), ["level", "event"]);
  });

test("the image runs every entry as the unprivileged node user, which owns none of its files", async () => {
  const dockerfile = await readFile(resolve(WORKER_ROOT, "cloud-run/Dockerfile"), "utf8");
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
  const lines = runtimeStage.split("\n").map((line) => line.trim()).filter(Boolean);
  // USER node is the last instruction before CMD, so every entry (the host,
  // the jobs and the migrator) runs without root.
  assert.deepEqual(lines.slice(-2), ["USER node", 'CMD ["node", "dist/server.mjs"]']);
  assert.equal(lines.filter((line) => line.startsWith("USER ")).length, 1);
  // The copied code stays root-owned (read-only to node): nothing chowns it.
  assert.doesNotMatch(dockerfile, /--chown|\bchown\b|\bchmod\b/u);
});

// ---------------------------------------------------------------------------
// Startup drift refusals (wave-3 host brief: the EDGE_TIER drift assertion,
// and the OD-CR-5 flags against the registry)

/**
 * The host loaded in its own Vite graph with one of its own imports replaced
 * by `code` (only where the host is the importer), so a startup assertion
 * meets the drift it must refuse without any seam in the production module.
 */
async function hostWithSubstitute(source, code) {
  const substituteId = "\0d-crb-drift-substitute.mjs";
  const server = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    plugins: [{
      name: "d-crb-drift-substitute",
      enforce: "pre",
      resolveId(requested, importer) {
        return requested === source && importer?.endsWith("/cloud-run/postgres-production-host.mjs")
          ? substituteId : null;
      },
      load(id) {
        return id === substituteId ? code : null;
      },
    }],
  });
  try {
    return { server, drifted: await server.ssrLoadModule("/cloud-run/postgres-production-host.mjs") };
  } catch (error) {
    await server.close();
    throw error;
  }
}

test("EDGE_TIER_BINDINGS_DRIFT: any of the three edge-tier lists drifting refuses, before any pool", async () => {
  const [limiters, edgePolicy] = await Promise.all([
    vite.ssrLoadModule("/cloud-run/postgres-edge-admission-limiters.mjs"),
    vite.ssrLoadModule("/src/edge-admission-policy.ts"),
  ]);
  const lists = {
    configuration: [...configuration.EDGE_TIER_RATE_LIMIT_BINDINGS],
    replay: [...limiters.EDGE_ADMISSION_REPLAY_BINDINGS],
    policy: [...edgePolicy.EDGE_ADMISSION_BINDINGS],
  };
  assert.ok(lists.configuration.length > 1);
  host.assertEdgeTierBindings();
  host.assertEdgeTierBindings(lists);
  host.assertEdgeTierBindings({ ...lists, replay: [...lists.replay].reverse() });
  for (const name of Object.keys(lists)) {
    for (const [label, drifted] of [
      ["one missing", lists[name].slice(1)],
      ["one extra", [...lists[name], "SYNTHETIC_EXTRA_RATE_LIMIT"]],
      ["one renamed", [`${lists[name][0]}_RENAMED`, ...lists[name].slice(1)]],
    ]) {
      assert.throws(() => host.assertEdgeTierBindings({ ...lists, [name]: drifted }),
        { code: "EDGE_TIER_BINDINGS_DRIFT" }, `${name}: ${label}`);
    }
  }
  // The composed runtime makes the check itself: EP-6's replay list missing
  // one binding refuses before a connector, pool or store exists.
  const { server, drifted } = await hostWithSubstitute("./postgres-edge-admission-limiters.mjs", [
    "import * as real from \"/cloud-run/postgres-edge-admission-limiters.mjs\";",
    "export const createEdgeAdmissionLimiters = real.createEdgeAdmissionLimiters;",
    "export const EDGE_ADMISSION_REPLAY_BINDINGS = Object.freeze(real.EDGE_ADMISSION_REPLAY_BINDINGS.slice(1));",
  ].join("\n"));
  try {
    const seams = dependencies();
    await refusedBefore(() => drifted.createPostgresProductionRuntime({ processEnv: productionEnv(),
      hostMode: "production", dependencies: seams.dependencies }), "EDGE_TIER_BINDINGS_DRIFT", "a drifted replay list");
    assert.deepEqual(seams.calls, [], "no connector, pool or store");
  } finally {
    await server.close();
  }
});

test("HEALTH_CAPABILITY_FLAGS_DRIFT: a registry that disagrees with the health flags refuses and closes what opened",
  async () => {
    // The registry the runtime builds, wrapped so that resolve() may claim one
    // more route ported than the list the flags came from.
    const claim = Symbol.for("d-crb.production-host.registry-claim");
    const { server, drifted } = await hostWithSubstitute("./postgres-production-registry.mjs", [
      "import * as real from \"/cloud-run/postgres-production-registry.mjs\";",
      "export const ADMIN_HOST_ROUTE_IDS = real.ADMIN_HOST_ROUTE_IDS;",
      // createOriginRouteRegistry hands the round-19 preambles over too.
      "export const RETIRED_DEFINITE_ROUTE_IDS = real.RETIRED_DEFINITE_ROUTE_IDS;",
      // The round-16 boot refusal (assertIdentityLinkRotationComposable) reads it too.
      "export const assertIdentityLinkConsumersRetired = real.assertIdentityLinkConsumersRetired;",
      "export function createProductionRouteRegistry(options) {",
      "  const registry = real.createProductionRouteRegistry(options);",
      "  return Object.freeze({ ...registry, resolve(id) {",
      `    return id === globalThis[Symbol.for(${JSON.stringify(claim.description)})]`,
      "      ? Object.freeze({ disposition: real.ORIGIN_ROUTE_DISPOSITIONS.PORTED, handler: async () => new Response(null) })",
      "      : registry.resolve(id);",
      "  } });",
      "}",
    ].join("\n"));
    try {
      // Control: with no claim the flags agree and the composition goes on to
      // the CR-6 handler, which refuses the wrapper as an unissued registry.
      const control = dependencies();
      await refusedBefore(() => drifted.createPostgresProductionRuntime({ processEnv: productionEnv(),
        hostMode: "production", dependencies: control.dependencies }), "PRODUCTION_HANDLER_REGISTRY_INVALID",
      "no claim: past the flags check");
      // Each OD-CR-5 flag's route claimed ported by the registry alone.
      for (const routeId of ["participant_export", "identity_google_start"]) {
        globalThis[claim] = routeId;
        const seams = dependencies();
        await refusedBefore(() => drifted.createPostgresProductionRuntime({ processEnv: productionEnv(),
          hostMode: "production", dependencies: seams.dependencies }), "HEALTH_CAPABILITY_FLAGS_DRIFT", routeId);
        assert.deepEqual(seams.calls.filter((call) => call.startsWith("pool-end:")).sort(), [
          "pool-end:tibotattle-origin-admission", "pool-end:tibotattle-origin-data",
          "pool-end:tibotattle-origin-readiness",
        ], `${routeId}: every opened pool is closed`);
        assert.ok(seams.calls.includes("connector-closed"), `${routeId}: the connector is closed`);
      }
    } finally {
      delete globalThis[claim];
      await server.close();
    }
  });

// ---------------------------------------------------------------------------
// run_maintenance over C-MAINT's lifecycle pass (the ADMIN-R12 path)

const ADMIN_ORIGIN = "https://admin.synthetic.example";
const ADMIN_OWNER = "owner@synthetic.example";
const MAINTENANCE_NOW = Date.parse("2026-10-02T12:00:30.000Z");

/**
 * A pool whose sessions answer the lifecycle pass from a script: the
 * maintenance lock (held or not), the migration fence, the transaction
 * statements and the one receipt probe, with `serverVersionNum`. Any other
 * statement fails the check. Statements are recorded by their first words.
 */
function scriptedPassPool({ maintenanceLock = true, serverVersionNum = 170_004 } = {}) {
  const statements = [];
  return {
    statements,
    pool: {
      async connect() {
        return {
          async query(text) {
            const sql = String(text).trim();
            statements.push(sql.split(/\s+/u).slice(0, 2).join(" "));
            if (sql.startsWith("SELECT pg_try_advisory_lock(")) return { rows: [{ acquired: maintenanceLock }] };
            if (sql.startsWith("SELECT pg_try_advisory_lock_shared(")) return { rows: [{ acquired: true }] };
            if (sql.startsWith("SELECT pg_advisory_unlock")) return { rows: [{ released: true }] };
            if (sql.includes("current_setting('server_version_num')")) {
              return { rows: [{ server_version_num: serverVersionNum, schema_exists: true, history: "synthetic" }] };
            }
            if (/^(?:BEGIN|SET LOCAL|COMMIT|ROLLBACK)\b/u.test(sql)) return { rows: [] };
            throw new Error("the scripted pass reached a statement it does not answer");
          },
          release() {},
        };
      },
    },
  };
}

/** C-ADMIN's admin_action family with recording audit adapters and the real lifecycle-pass task. */
async function maintenanceAction(pool) {
  const action = await vite.ssrLoadModule("/cloud-run/routes/admin-action.mjs");
  const calls = [];
  const audit = (name, value) => async (input) => {
    calls.push([name, input.outcome ?? null, JSON.parse(JSON.stringify(input.details))]);
    return value;
  };
  const contexts = new WeakMap();
  const dispatch = action.createAdminActionDispatch({
    requestContext: (request) => contexts.get(request),
    clock: () => MAINTENANCE_NOW,
    admin: {
      setCollectionControls: async () => { throw new Error("not reached"); },
      beginAudit: audit("beginAudit", "11111111-2222-4333-8444-555555555555"),
      finishAudit: audit("finishAudit", undefined),
      finishAuditBestEffort: audit("finishAuditBestEffort", undefined),
      maintenance: host.createLifecyclePassMaintenance({
        pool, objectStore: { async head() { return null; }, async delete() {} }, primarySchema: "origin_primary",
      }),
    },
  });
  return {
    calls,
    async run() {
      const request = new Request(`${ADMIN_ORIGIN}/api/v1/admin/action`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ADMIN_ORIGIN, "sec-fetch-site": "same-origin",
          "x-usage-monitor-admin": "1" },
        body: JSON.stringify({ action: "run_maintenance" }),
      });
      contexts.set(request, Object.freeze({ requestId: REQUEST_ID, routeId: "admin_action", adminIdentityKey: ADMIN_OWNER }));
      return dispatch(request);
    },
  };
}

test("run_maintenance over the lifecycle pass: a refused or failed pass is a failure audit and an error, never 200",
  async () => {
    const pass = await vite.ssrLoadModule("/src/postgres-lifecycle-pass.ts");
    // Every refused and failed pass code has exactly one of the three Worker answers.
    const { refused, failure } = pass.POSTGRES_LIFECYCLE_PASS_CODES;
    assert.deepEqual(Object.keys(host.LIFECYCLE_PASS_ADMIN_ERRORS).sort(), [...refused, ...failure].sort());
    const answers = Object.values(host.LIFECYCLE_PASS_ADMIN_ERRORS).map((answer) => `${answer.status} ${answer.code}`);
    assert.deepEqual([...new Set(answers)].sort(),
      ["500 INTERNAL_ERROR", "503 BACKEND_STORAGE_UNAVAILABLE", "503 LIFECYCLE_STATE_CONFLICT"]);
    for (const code of failure) {
      assert.equal(`${host.LIFECYCLE_PASS_ADMIN_ERRORS[code].status} ${host.LIFECYCLE_PASS_ADMIN_ERRORS[code].code}`,
        "500 INTERNAL_ERROR", code);
    }
    for (const code of ["POSTGRES_VERSION_UNSUPPORTED", "POSTGRES_SCHEMA_RECEIPT_MISMATCH", "LIFECYCLE_STATE_MISSING",
      "LIFECYCLE_STATE_SHAPE_INVALID"]) {
      assert.equal(host.LIFECYCLE_PASS_ADMIN_ERRORS[code].code, "BACKEND_STORAGE_UNAVAILABLE", code);
    }
    for (const code of ["LIFECYCLE_LEASE_CONFLICT", "LIFECYCLE_CYCLE_REGRESSED", "LIFECYCLE_STATE_CHECK_CONFLICT",
      "LIFECYCLE_RESTORE_PIN_CONFLICT"]) {
      assert.equal(host.LIFECYCLE_PASS_ADMIN_ERRORS[code].code, "LIFECYCLE_STATE_CONFLICT", code);
    }

    const expectFailure = async (pool, status, code, label) => {
      const action = await maintenanceAction(pool);
      const response = await action.run();
      assert.equal(response.status, status, label);
      assert.deepEqual(await response.json(), { error: { code, requestId: REQUEST_ID } }, label);
      assert.equal(response.headers.get("retry-after"), null, label);
      assert.deepEqual(action.calls, [
        ["beginAudit", null, { phase: "started" }],
        ["finishAuditBestEffort", "failure", { code }],
      ], `${label}: a started and a failure audit, no success`);
    };
    // A failed pass (no session): the Worker's raw-failure answer.
    await expectFailure({ async connect() { throw new Error("synthetic connect failure"); } },
      500, "INTERNAL_ERROR", "failure: POSTGRES_MAINTENANCE_UNAVAILABLE");
    // A refused pass: PostgreSQL 16 under the lock, read through the one
    // receipt reader inside the pass's transaction; nothing is written.
    const old = scriptedPassPool({ serverVersionNum: 160_004 });
    await expectFailure(old.pool, 503, "BACKEND_STORAGE_UNAVAILABLE", "refused: POSTGRES_VERSION_UNSUPPORTED");
    assert.ok(old.statements.includes("SELECT current_setting('server_version_num')::integer"), old.statements.join("; "));
    assert.ok(old.statements.includes("ROLLBACK"), "the refused transaction rolls back");
    assert.ok(!old.statements.some((statement) => /^(?:INSERT|UPDATE|DELETE)\b/u.test(statement)), "nothing written");
    assert.equal(old.statements.filter((statement) => statement.startsWith("SELECT pg_advisory_unlock")).length, 2,
      "the lock and the fence are released");
    // A skipped pass is still the Worker's 409 (C-ADMIN's mapping).
    const busy = scriptedPassPool({ maintenanceLock: false });
    await expectFailure(busy.pool, 409, "LIFECYCLE_STATE_CONFLICT", "skipped: MAINTENANCE_IN_PROGRESS");
  });
