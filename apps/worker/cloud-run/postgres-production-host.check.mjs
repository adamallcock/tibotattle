import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// CR-7 production composition (D-CRB) without a database: HOST_MODE
// production and staging compose from the CR-3 configuration alone, with
// the plane's origin-tier limits; the bind address is 0.0.0.0 only for a
// validated Cloud Run service; refusals happen before any pool and close
// what opened; the registry ports the production list (plus the six admin
// routes only when the composition root opens the admin host); and requests
// that need no storage (unported routes, the refused or chokepointed admin
// host, EP-6 refusals) answer through the real EP-6 boundary and the CR-6
// handler. The storage paths (RD-2, RD-3, the families, the lifecycle pass
// and the ingress lease) run against PostgreSQL 17 in
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

before(async () => {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  [host, configuration, composition] = await Promise.all([
    vite.ssrLoadModule("/cloud-run/postgres-production-host.mjs"),
    vite.ssrLoadModule("/cloud-run/postgres-production-configuration.mjs"),
    vite.ssrLoadModule("/src/backend-composition.ts"),
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
  GOOGLE_OIDC_CLIENT_SECRET: "synthetic-google-client-secret-value-3",
  APPLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nc3ludGhldGljLWFwcGxlLWtleQ==\\n-----END PRIVATE KEY-----",
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
    APPLE_SERVICES_ID: "example.synthetic.staging",
    APPLE_KEY_ID: "SYNTHKEY01",
    APPLE_TEAM_ID: "SYNTHTEAM1",
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
  // OWN-17 question 2 is open: the admin host stays refused (OD-CR-3).
  assert.equal(host.PRODUCTION_ADMIN_HOST_POLICY, "refuse");
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
    assert.deepEqual([...runtime.registry.portedRouteIds], [...composition.POSTGRES_PORTED_WORKER_ROUTE_IDS]);
    for (const id of composition.POSTGRES_ADMIN_HOST_ROUTE_IDS) {
      assert.equal(runtime.registry.resolve(id).disposition, "unported", id);
    }

    // An unported route: the closed 503 under the edge's request id, no
    // retry-after (OD-CR-6 iv), no-store, marked by EP-6. No storage is read.
    const unported = await runtime.productionDispatch(invokerRequest("/api/v1/me/export"));
    assert.equal(unported.status, 503);
    assert.deepEqual(await unported.json(), { error: { code: "POSTGRES_ROUTE_NOT_PORTED", requestId: REQUEST_ID } });
    assert.equal(unported.headers.get("retry-after"), null);
    assert.equal(unported.headers.get("cache-control"), "no-store");
    assert.equal(unported.headers.get("x-tibotattle-origin"), "1");
    // The admin host is refused before anything (OD-CR-3), even with an Access token.
    const admin = await runtime.productionDispatch(invokerRequest("/api/v1/admin/overview",
      { hostKind: "admin", headers: { "cf-access-jwt-assertion": "synthetic.access.jwt" } }));
    assert.equal(admin.status, 503);
    assert.equal((await admin.json()).error.code, "POSTGRES_ROUTE_NOT_PORTED");
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

test("OD-CR-3 'chokepoint' (the OWN-17 switch): six more routes, Access before any family", async () => {
  const seams = dependencies();
  const runtime = await host.createPostgresProductionRuntime({
    processEnv: productionEnv(), hostMode: "production", adminHostPolicy: "chokepoint",
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
    // both origin-tier limiters carry the staging values.
    assert.deepEqual([...runtime.registry.portedRouteIds], [...composition.POSTGRES_PORTED_WORKER_ROUTE_IDS]);
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

test("composeOriginFamilies refuses an incomplete dependency set", () => {
  assert.throws(() => host.composeOriginFamilies(null), { code: host.ORIGIN_COMPOSITION_INVALID });
  assert.throws(() => host.composeOriginFamilies({ dataPool: { connect() {} } }), { code: host.ORIGIN_COMPOSITION_INVALID });
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
