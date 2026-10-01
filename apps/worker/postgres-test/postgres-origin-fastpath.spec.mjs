// GCP fast-path origin seam (IN-1): route-module overrides, the contribution
// envelope registry behind the shared preamble, upload-authorization formats
// and the local fastpath-test mode.
//
// The composition cases load cloud-run/server.mjs through vite and call
// createRuntime() with injected pools, connector, token provider and object
// store, exactly as host.check does; nothing listens on a port and nothing
// reaches Google. The preamble cases drive the real
// createPostgresTestV12DayManifestDispatch against disposable PostgreSQL 17
// schemas on the local socket. Every fixture is synthetic and content-free;
// each case creates its own primary and "<schema>_ledger" schemas and drops
// only those.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createServer } from "vite";
import { validateTelemetryV12Envelope } from "@app-usagemonitor/telemetry-contract";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { createPostgresTestV12DayManifestDispatch } from "../cloud-run/postgres-test-dispatch.mjs";
import { registerContributionEnvelope } from "../cloud-run/contribution-envelope-registry.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DISPATCH_ORIGIN = "http://127.0.0.1:43931";
const FASTPATH_PORT = 43932;
const FASTPATH_ORIGIN = `http://127.0.0.1:${FASTPATH_PORT}`;
const CONTRIBUTIONS_PATH = "/api/v1/contributions";
const UPLOAD_AUTHORIZATIONS_PATH = "/api/v1/device/upload-authorizations";
const COMMUNITY_DAILY_PATH = "/api/v1/community/daily";
const V11_ENVELOPE = "telemetry-envelope-v1.1";
const V11_TRANSPORT = "telemetry-contribution-v1.1";
const HOUR_MS = 3_600_000;

// The refusal POST /api/v1/contributions gave these bodies before the
// envelope registry existed: captured from postgres-test-dispatch.mjs at
// fc2102eb (the IN-1a seam commit, dispatch unchanged since 8b1dcc4f) with
// crypto.randomUUID pinned to PINNED_REQUEST_ID. The v1.2-only origin refused
// them inside its pre-claim v1.2 check; an exact six-key envelope reached the
// closed v1.2 contract, whose TelemetryContractError carries no HTTP status.
const PINNED_REQUEST_ID = "00000000-0000-4000-8000-0000000000c1";
const PRE_CHANGE_HEADERS = Object.freeze([
  ["cache-control", "no-store"],
  ["content-type", "application/json; charset=utf-8"],
  ["referrer-policy", "no-referrer"],
  ["x-content-type-options", "nosniff"],
]);
const PRE_CHANGE_ENVELOPE_INVALID_BODY =
  `{"error":{"code":"ENVELOPE_INVALID","requestId":"${PINNED_REQUEST_ID}"}}`;
const UNREGISTERED_ENVELOPES = Object.freeze([
  {
    label: "a v1.1 envelope with the six envelope keys",
    body: JSON.stringify({
      schemaVersion: V11_ENVELOPE,
      synthetic: false,
      keyId: "key:synthetic-golden",
      wrappedKey: "A".repeat(342),
      iv: "B".repeat(16),
      ciphertext: "C".repeat(64),
    }),
    status: 500,
  },
  {
    label: "a v1.1 envelope with other keys",
    body: JSON.stringify({ schemaVersion: V11_ENVELOPE, payload: "synthetic" }),
    status: 400,
  },
  {
    label: "an envelope without a schemaVersion",
    body: JSON.stringify({
      synthetic: false,
      keyId: "key:x",
      wrappedKey: "A".repeat(342),
      iv: "B".repeat(16),
      ciphertext: "C".repeat(64),
      extra: 1,
    }),
    status: 400,
  },
]);

let vite;
let modules;
let pool;

after(async () => {
  await pool?.end();
  await vite?.close();
});

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function loadModules() {
  if (modules) return modules;
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "silent",
  });
  const load = (path) => vite.ssrLoadModule(path);
  const [server, runtimeSchema, transport, uploadAuthorization, ledgerAuthority, workerAdmission,
    bodyReader, constants, workerCrypto] = await Promise.all([
    load("/cloud-run/server.mjs"),
    load("/src/postgres-runtime-schema.ts"),
    load("/src/postgres-typed-v12-transport.ts"),
    load("/src/postgres-upload-authorization.ts"),
    load("/src/postgres-ledger-authority.ts"),
    load("/src/admission.ts"),
    load("/src/bounded-body.ts"),
    load("/src/constants.ts"),
    load("/src/crypto.ts"),
  ]);
  modules = {
    server, runtimeSchema, transport, uploadAuthorization, ledgerAuthority, workerAdmission,
    bodyReader, constants, workerCrypto,
  };
  return modules;
}

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  const link = await lstat(PG_TEST_SOCKET);
  const host = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(host);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host, port: PG_TEST_PORT };
}

function localPoolOptions(socket, max, applicationName) {
  return {
    ...socket,
    user: process.env.PG_TEST_USER || "postgres",
    password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
    database: process.env.PG_TEST_DATABASE || "postgres",
    application_name: applicationName,
    ssl: false,
    max,
    connectionTimeoutMillis: 5_000,
  };
}

async function setupPool() {
  if (pool) return pool;
  pool = new pg.Pool(localPoolOptions(await localSocket(), 8, "pg-origin-fastpath-test"));
  const server = await pool.query(
    "SELECT inet_server_addr() AS address, current_setting('server_version_num')::integer AS version",
  );
  assert.equal(server.rows[0]?.address, null, "qualification requires the local Unix socket");
  assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the disposable socket must be PostgreSQL 17");
  return pool;
}

/** A disposable, fully migrated rehearsal schema and its "<schema>_ledger". */
async function withSchemas(prefix, run) {
  const base = await setupPool();
  const primarySchema = `${prefix}${randomBytes(6).toString("hex")}`;
  const ledgerSchema = `${primarySchema}_ledger`;
  const created = [];
  try {
    for (const schema of [primarySchema, ledgerSchema]) {
      await base.query(`CREATE SCHEMA "${schema}"`);
      created.push(schema);
    }
    await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: base });
    await applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool: base });
    const nowIso = new Date().toISOString();
    await base.query(`UPDATE "${primarySchema}"."collection_controls"
        SET revision=2, control_state='operational', enrollment_enabled=true,
            upload_registration_enabled=true, processing_enabled=true,
            publication_enabled=true, updated_at=$1
      WHERE singleton=1`, [nowIso]);
    return await run({ base, primarySchema, ledgerSchema });
  } finally {
    for (const schema of created.reverse()) await base.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
}

function allowAll() {
  return { async limit() { return { success: true }; } };
}

function mustNotCall(name) {
  return async () => { throw new Error(`${name} must not be called`); };
}

async function withPinnedRequestId(work) {
  const webCrypto = globalThis.crypto;
  webCrypto.randomUUID = () => PINNED_REQUEST_ID;
  try {
    return await work();
  } finally {
    delete webCrypto.randomUUID;
  }
}

async function answer(response) {
  const text = await response.text();
  return { status: response.status, headers: [...response.headers], text };
}

// ---------------------------------------------------------------------------
// createRuntime in fastpath-test mode
// ---------------------------------------------------------------------------

const RUNTIME_ENVIRONMENT_NAMES = Object.freeze([
  "POSTGRES_TEST_HTTP_MODE", "HOST", "PORT", "HOST_ORIGIN", "PUBLIC_ORIGIN", "ADMIN_HOST_ORIGIN",
  "K_SERVICE", "PRIMARY_DATABASE", "PRIMARY_SCHEMA", "PRIMARY_INSTANCE_CONNECTION_NAME",
  "LEDGER_DATABASE", "LEDGER_SCHEMA", "LEDGER_INSTANCE_CONNECTION_NAME", "POSTGRES_IAM_USER",
  "POSTGRES_SOURCE_ID", "POSTGRES_SOURCE_NAMESPACE", "POSTGRES_RATE_LIMIT_SECRET",
  "ENVELOPE_PUBLIC_JWK", "ENVELOPE_PRIVATE_JWK", "GCS_BUCKET_NAME", "GCS_ERASURE_BUCKET_HISTORY_PROOF",
  "ENVIRONMENT", "ENROLLMENT_MODE", "IDENTITY_LINK_SECRET", "IDENTITY_LINK_SECRET_VERSION",
  "GOOGLE_OIDC_CLIENT_ID", "GOOGLE_OIDC_CLIENT_SECRET", "SIGN_IN_START_MAX_PER_MINUTE",
  "ACCOUNTLESS_ENROLLMENT_MODE", "ACCOUNTLESS_OWNERSHIP_MODE", "SOURCE_CONTENT_DIGEST",
  "ANALYTICS_V2_ENABLED",
]);

function fastpathEnvironment(primarySchema, overrides = {}) {
  const bucket = "synthetic-fastpath-bucket";
  return {
    POSTGRES_TEST_HTTP_MODE: "fastpath-test",
    HOST: "127.0.0.1",
    PORT: String(FASTPATH_PORT),
    HOST_ORIGIN: FASTPATH_ORIGIN,
    PRIMARY_SCHEMA: primarySchema,
    PRIMARY_DATABASE: process.env.PG_TEST_DATABASE || "postgres",
    PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:synthetic-fastpath-primary",
    POSTGRES_IAM_USER: "synthetic-fastpath-runtime@synthetic.iam",
    POSTGRES_RATE_LIMIT_SECRET: "synthetic-fastpath-rate-limit-secret-0123456789",
    ENVELOPE_PUBLIC_JWK: '{"synthetic":"unused-public-key"}',
    ENVELOPE_PRIVATE_JWK: "synthetic-unused-private-key",
    GCS_BUCKET_NAME: bucket,
    GCS_ERASURE_BUCKET_HISTORY_PROOF: JSON.stringify({
      bucket,
      bucketGeneration: "1",
      bucketMetageneration: "1",
      softDeleteRetentionDurationSeconds: "0",
    }),
    ...overrides,
  };
}

async function withEnvironment(environment, work) {
  const saved = new Map(RUNTIME_ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]));
  for (const name of RUNTIME_ENVIRONMENT_NAMES) delete process.env[name];
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) process.env[name] = value;
  }
  try {
    return await work();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * Runtime dependencies that record construction. With a socket, the IAM pool
 * factory returns a real local pool (primary and ledger on the same instance,
 * as fastpath-test allows); without one it returns an inert pool.
 */
function runtimeDependencies({ socket = null, extra = {} } = {}) {
  const calls = [];
  const pools = [];
  const dependencies = {
    createConnector() {
      calls.push("connector");
      return { close() { calls.push("connector-closed"); } };
    },
    async createIamPool(options) {
      calls.push(`pool:${options.role}`);
      const created = socket === null
        ? { connect: mustNotCall("inert pool connect"), async end() { calls.push(`pool-end:${options.role}`); } }
        : new pg.Pool(localPoolOptions(socket, options.max, `pg-origin-fastpath-${options.role}`));
      if (socket !== null) {
        const end = created.end.bind(created);
        created.end = async () => { calls.push(`pool-end:${options.role}`); await end(); };
      }
      pools.push({ options, pool: created });
      return created;
    },
    async createGoogleAccessTokenProvider() {
      calls.push("gcs-access-token");
      return async () => "synthetic-access-token";
    },
    createGcsQuarantineObjectStore() {
      calls.push("gcs-object-store");
      return { put: mustNotCall("objectStore.put"), delete: mustNotCall("objectStore.delete") };
    },
    ...extra,
  };
  return { calls, pools, dependencies };
}

async function closeRuntime(runtime) {
  for (const created of [...(runtime?.pools ?? [])].reverse()) await created.end();
}

test("(e) fastpath-test refuses a non-loopback host or origin and a non-rehearsal schema before any connection", async () => {
  const { server } = await loadModules();
  const goodSchema = "tibotattle_fastpath_spec_refusal";
  const refusals = [
    [{ HOST: "0.0.0.0" }, "POSTGRES_TEST_PRIVATE_HOST_CONFIGURATION_INVALID"],
    [{ HOST: "10.0.0.8" }, "POSTGRES_TEST_PRIVATE_HOST_CONFIGURATION_INVALID"],
    [{ HOST_ORIGIN: `http://localhost:${FASTPATH_PORT}` }, "POSTGRES_TEST_PRIVATE_HOST_CONFIGURATION_INVALID"],
    [{ HOST_ORIGIN: `https://127.0.0.1:${FASTPATH_PORT}` }, "POSTGRES_TEST_PRIVATE_HOST_CONFIGURATION_INVALID"],
    [{ HOST_ORIGIN: "https://tibotattle-test-app-5t5mehqi7a-ue.a.run.app" },
      "POSTGRES_TEST_PRIVATE_HOST_CONFIGURATION_INVALID"],
    [{ PUBLIC_ORIGIN: "https://tibotattle.example" }, "POSTGRES_TEST_PRIVATE_HOST_CONFIGURATION_INVALID"],
    [{ ADMIN_HOST_ORIGIN: "https://admin.tibotattle.example" },
      "POSTGRES_TEST_PRIVATE_HOST_CONFIGURATION_INVALID"],
    [{ PRIMARY_SCHEMA: undefined }, "POSTGRES_FASTPATH_TEST_SCHEMA_INVALID"],
    [{ PRIMARY_SCHEMA: "tibotattle" }, "POSTGRES_FASTPATH_TEST_SCHEMA_INVALID"],
    [{ PRIMARY_SCHEMA: "tibotattle_v12_a2_20260925" }, "POSTGRES_FASTPATH_TEST_SCHEMA_INVALID"],
    [{ PRIMARY_SCHEMA: "tibotattle_fastpath_" }, "POSTGRES_FASTPATH_TEST_SCHEMA_INVALID"],
    [{ PRIMARY_SCHEMA: "typed_legacy_transfer_rehearsal_target_" }, "POSTGRES_FASTPATH_TEST_SCHEMA_INVALID"],
    [{ PRIMARY_SCHEMA: "Tibotattle_fastpath_upper" }, "POSTGRES_FASTPATH_TEST_SCHEMA_INVALID"],
    [{ PRIMARY_SCHEMA: `tibotattle_fastpath_${"x".repeat(40)}` }, "POSTGRES_FASTPATH_TEST_SCHEMA_INVALID"],
    [{ LEDGER_SCHEMA: "tibotattle_ledger" }, "POSTGRES_FASTPATH_TEST_SCHEMA_INVALID"],
    [{ LEDGER_SCHEMA: "tibotattle_fastpath_other_ledger" }, "POSTGRES_FASTPATH_TEST_SCHEMA_INVALID"],
  ];
  for (const [overrides, expectedCode] of refusals) {
    const { calls, dependencies } = runtimeDependencies();
    await withEnvironment(fastpathEnvironment(goodSchema, overrides), async () => {
      await assert.rejects(
        server.createRuntime({ dependencies }),
        (error) => error?.code === expectedCode,
        `${JSON.stringify(overrides)} must stop with ${expectedCode}`,
      );
    });
    assert.deepEqual(calls, [], `${expectedCode} must fail before any connector, pool or GCS construction`);
  }

  // The accepted shapes reach construction: both rehearsal prefixes, and a
  // ledger that defaults to "<schema>_ledger" on the primary instance.
  for (const [schema, overrides] of [
    [goodSchema, {}],
    ["typed_legacy_transfer_rehearsal_target_spec", { LEDGER_SCHEMA: "typed_legacy_transfer_rehearsal_target_spec_ledger" }],
  ]) {
    const { calls, pools, dependencies } = runtimeDependencies();
    const runtime = await withEnvironment(fastpathEnvironment(schema, overrides),
      () => server.createRuntime({ dependencies }));
    try {
      assert.equal(runtime.postgresTestHostMode, "fastpath-test");
      assert.equal(runtime.listenHost, "127.0.0.1");
      assert.equal(runtime.listenPort, FASTPATH_PORT);
      assert.equal(runtime.hostOrigin, FASTPATH_ORIGIN);
      assert.equal(runtime.publicOrigin, undefined);
      assert.equal(typeof runtime.postgresTestDispatch, "function");
      assert.deepEqual(runtime.schemaOptions, { primarySchema: schema, ledgerSchema: `${schema}_ledger` });
      assert.deepEqual(pools.map(({ options }) => ({
        role: options.role,
        schema: options.schema,
        database: options.database,
        instanceConnectionName: options.instanceConnectionName,
        max: options.max,
      })), [
        {
          role: "primary", schema, database: "postgres",
          instanceConnectionName: "synthetic-project:us-east1:synthetic-fastpath-primary", max: 3,
        },
        {
          role: "ledger", schema: `${schema}_ledger`, database: "postgres",
          instanceConnectionName: "synthetic-project:us-east1:synthetic-fastpath-primary", max: 2,
        },
      ]);
      assert.deepEqual(calls.slice(0, 3), ["connector", "pool:primary", "pool:ledger"]);
    } finally {
      await closeRuntime(runtime);
    }
  }
});

test("(b) a route module for a non-overridable built-in stops fastpath-test startup and closes its pools", async () => {
  const { server } = await loadModules();
  const handler = mustNotCall("route module handler");
  for (const [module, expected] of [
    [{ method: "GET", pathname: "/api/v1/session", overridesBuiltIn: true, handler },
      /\/api\/v1\/session is a built-in route that modules may not replace/u],
    [{ method: "GET", pathname: "/api/v1/session", overridesBuiltIn: false, handler },
      /\/api\/v1\/session is a built-in route that modules may not replace/u],
    [{ method: "POST", pathname: CONTRIBUTIONS_PATH, overridesBuiltIn: true, handler },
      /built-in route that modules may not replace/u],
    [{ method: "GET", pathname: "/api/v1/community/daily-v2", overridesBuiltIn: true, handler },
      /not a route in the Worker route registry/u],
  ]) {
    const { calls, dependencies } = runtimeDependencies({
      extra: { createAnalyticsV2CommunityDailyRoute: () => module },
    });
    await withEnvironment(
      fastpathEnvironment("tibotattle_fastpath_spec_session", { ANALYTICS_V2_ENABLED: "1" }),
      async () => {
        await assert.rejects(server.createRuntime({ dependencies }), (error) =>
          error?.code === "ORIGIN_ROUTE_MODULE_INVALID" && expected.test(error.message));
      },
    );
    assert.deepEqual(calls.filter((call) => call.startsWith("pool-end:")).sort(),
      ["pool-end:ledger", "pool-end:primary"], "a refused registration closes both pools");
    assert.ok(calls.includes("connector-closed"));
  }

  // ANALYTICS_V2_ENABLED=1 without a factory, or with an invalid value, also
  // stops startup instead of silently serving the built-in.
  for (const [environment, extra, expectedCode] of [
    [{ ANALYTICS_V2_ENABLED: "1" }, {}, "ANALYTICS_V2_COMMUNITY_DAILY_ROUTE_UNAVAILABLE"],
    [{ ANALYTICS_V2_ENABLED: "true" }, { createAnalyticsV2CommunityDailyRoute: mustNotCall("factory") },
      "ANALYTICS_V2_ENABLED_INVALID"],
  ]) {
    const { calls, dependencies } = runtimeDependencies({ extra });
    await withEnvironment(fastpathEnvironment("tibotattle_fastpath_spec_session", environment), async () => {
      await assert.rejects(server.createRuntime({ dependencies }), (error) => error?.code === expectedCode);
    });
    assert.ok(calls.includes("pool-end:primary") && calls.includes("pool-end:ledger"));
  }
});

test("(f) the origin composition root injects the analytics-v2 route factory and only a fastpath-test clock", async () => {
  const { server } = await loadModules();
  const plain = server.originCompositionDependencies({ POSTGRES_TEST_HTTP_MODE: "fastpath-test" });
  assert.deepEqual(Object.keys(plain), ["createAnalyticsV2CommunityDailyRoute"]);
  assert.equal(typeof plain.createAnalyticsV2CommunityDailyRoute, "function");
  const pinned = server.originCompositionDependencies({
    POSTGRES_TEST_HTTP_MODE: "fastpath-test", ANALYTICS_V2_TEST_NOW_MS: "1790856000000",
  });
  assert.equal(pinned.analyticsV2Clock(), 1_790_856_000_000);
  for (const mode of [undefined, "", "health-only", "health-and-v12-day-manifest", "cloud-run-iam"]) {
    assert.throws(() => server.originCompositionDependencies({
      ...(mode === undefined ? {} : { POSTGRES_TEST_HTTP_MODE: mode }), ANALYTICS_V2_TEST_NOW_MS: "1790856000000",
    }), (error) => error?.code === "ANALYTICS_V2_TEST_CLOCK_REFUSED", String(mode));
  }
  // The real factory is the second fence: it refuses a clock outside fastpath-test.
  assert.throws(() => plain.createAnalyticsV2CommunityDailyRoute({
    pool: { connect: mustNotCall("pool.connect") }, schema: "tibotattle_fastpath_spec_clock",
    originMode: "cloud-run-iam", clock: () => 1,
  }), (error) => error?.message === "ANALYTICS_V2_COMMUNITY_DAILY_TEST_CLOCK_REFUSED");

  // fastpath-test with ANALYTICS_V2_ENABLED=1 mounts the real route from these
  // dependencies (construction opens no connection) and closes cleanly.
  const { calls, dependencies } = runtimeDependencies({ extra: pinned });
  await withEnvironment(
    fastpathEnvironment("tibotattle_fastpath_spec_compose", { ANALYTICS_V2_ENABLED: "1" }),
    async () => {
      const runtime = await server.createRuntime({ dependencies });
      try {
        assert.equal(runtime.postgresTestHostMode, "fastpath-test");
      } finally {
        await closeRuntime(runtime);
      }
    },
  );
  assert.ok(calls.includes("pool-end:primary") && calls.includes("pool-end:ledger"));
});

test("(a) in fastpath-test a stub community-daily module overrides the built-in, and only that route", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const { server } = await loadModules();
  const socket = await localSocket();
  await withSchemas("tibotattle_fastpath_spec_", async ({ primarySchema, ledgerSchema }) => {
    const factoryCalls = [];
    const handled = [];
    const clock = () => Date.parse("2026-10-01T06:00:00.000Z");
    const stubFactory = (options) => {
      factoryCalls.push(options);
      return {
        method: "GET",
        pathname: COMMUNITY_DAILY_PATH,
        overridesBuiltIn: true,
        async handler(request, context) {
          handled.push({ url: request.url, method: request.method, context });
          return new Response(JSON.stringify({ stub: "analytics-v2-community-daily" }), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8", "x-synthetic-module": "1" },
          });
        },
      };
    };
    const daily = `${FASTPATH_ORIGIN}${COMMUNITY_DAILY_PATH}?from=2026-09-30&to=2026-10-01`;

    // Mounted: the module answers GET community/daily on the private origin.
    const mounted = runtimeDependencies({
      socket,
      extra: { createAnalyticsV2CommunityDailyRoute: stubFactory, analyticsV2Clock: clock },
    });
    const runtime = await withEnvironment(
      fastpathEnvironment(primarySchema, { ANALYTICS_V2_ENABLED: "1" }),
      () => server.createRuntime({ dependencies: mounted.dependencies }),
    );
    try {
      assert.equal(factoryCalls.length, 1);
      assert.deepEqual(Object.keys(factoryCalls[0]).sort(), ["clock", "originMode", "pool", "schema"]);
      assert.equal(factoryCalls[0].pool, runtime.primaryPool);
      assert.equal(factoryCalls[0].schema, primarySchema);
      assert.equal(factoryCalls[0].originMode, "fastpath-test");
      assert.equal(factoryCalls[0].clock, clock);
      assert.deepEqual(runtime.schemaOptions, { primarySchema, ledgerSchema });

      const overridden = await runtime.postgresTestDispatch(new Request(daily));
      assert.equal(overridden.status, 200);
      assert.equal(overridden.headers.get("x-synthetic-module"), "1");
      assert.deepEqual(await overridden.json(), { stub: "analytics-v2-community-daily" });
      assert.equal(handled.length, 1);
      assert.equal(handled[0].url, daily);
      assert.deepEqual(handled[0].context, { origin: FASTPATH_ORIGIN, hostMode: "fastpath-test" });
      assert.ok(Object.isFrozen(handled[0].context));

      // A method the module does not claim keeps the built-in's refusal.
      const post = await runtime.postgresTestDispatch(new Request(daily, { method: "POST", body: "{}" }));
      assert.equal(post.status, 405);
      assert.equal((await post.json()).error.code, "METHOD_NOT_ALLOWED");
      // Another origin never reaches the module.
      const foreign = await runtime.postgresTestDispatch(
        new Request(`http://127.0.0.1:1${COMMUNITY_DAILY_PATH}?from=2026-09-30&to=2026-10-01`),
      );
      assert.equal(foreign.status, 503);
      assert.equal((await foreign.json()).error, "POSTGRES_TEST_ROUTE_UNSUPPORTED");
      // A non-overridable route keeps its built-in: the rehearsal schema pair
      // on one instance is migrated and ready.
      const health = await runtime.postgresTestDispatch(new Request(`${FASTPATH_ORIGIN}/api/health`));
      assert.equal(health.status, 200);
      assert.equal((await health.json()).status, "ready");
      assert.equal(handled.length, 1, "only GET community/daily on the private origin reached the module");
    } finally {
      await closeRuntime(runtime);
    }

    // Not mounted: the same request is served by the built-in reader, which
    // answers its closed storage refusal on this unseeded source fence.
    const builtIn = runtimeDependencies({
      socket,
      extra: { createAnalyticsV2CommunityDailyRoute: stubFactory },
    });
    const plain = await withEnvironment(fastpathEnvironment(primarySchema),
      () => server.createRuntime({ dependencies: builtIn.dependencies }));
    try {
      assert.equal(factoryCalls.length, 1, "without ANALYTICS_V2_ENABLED the factory is never called");
      const response = await plain.postgresTestDispatch(new Request(daily));
      const body = await response.json();
      assert.equal(response.headers.get("x-synthetic-module"), null);
      assert.equal(response.status, 503);
      assert.deepEqual(Object.keys(body.error).sort(), ["code", "requestId"]);
      assert.equal(body.error.code, "BACKEND_STORAGE_UNAVAILABLE");
      assert.equal(handled.length, 1);
    } finally {
      await closeRuntime(plain);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/contributions through the real dispatch
// ---------------------------------------------------------------------------

function deviceSecretHash(deviceId, secret) {
  return createHash("sha256")
    .update(`app-usagemonitor/device/v1\0${deviceId}\0`)
    .update(Buffer.from(secret, "base64url"))
    .digest();
}

/** One paired, active social device in a migrated schema pair. */
async function insertSocialDevice(base, primarySchema, consentVersion) {
  const table = (name) => `"${primarySchema}"."${name}"`;
  const nowIso = new Date().toISOString();
  const expiry = new Date(Date.now() + 30 * 24 * HOUR_MS).toISOString();
  const participantId = `synthetic-origin-fastpath-${randomBytes(6).toString("hex")}`;
  const sessionId = randomUUID();
  const pairingId = randomUUID();
  const deviceId = randomUUID();
  const deviceSecret = randomBytes(32).toString("base64url");
  await base.query(`INSERT INTO ${table("participants")}(id, owner_kind, state, consent_version, created_at)
    VALUES ($1,'social','active',$2,$3)`, [participantId, consentVersion, nowIso]);
  await base.query(`INSERT INTO ${table("web_sessions")}(
    id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$5)`, [sessionId, participantId, randomBytes(32), randomBytes(32), nowIso, expiry]);
  await base.query(`INSERT INTO ${table("device_pairings")}(
    id, participant_id, issued_by_session_id, secret_hash, consent_version,
    transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
  ) VALUES ($1,$2,$3,$4,$5,$5,'consumed',$6,$7,$6,$8)`, [
    pairingId, participantId, sessionId, randomBytes(32), consentVersion, nowIso, expiry, deviceId,
  ]);
  await base.query(`INSERT INTO ${table("device_credentials")}(
    id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
    state, issued_at, expires_at, last_used_at, social_verified_at
  ) VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`, [
    deviceId, participantId, pairingId, deviceSecretHash(deviceId, deviceSecret), nowIso, expiry,
  ]);
  return { participantId, deviceId, deviceAuthorization: `Device um_device_${deviceId}.${deviceSecret}` };
}

function contributionDispatch(m, { base, primarySchema, ledgerSchema }, overrides = {}) {
  return createPostgresTestV12DayManifestDispatch({
    primaryPool: base,
    ledgerPool: { connect: () => base.connect() },
    schemaOptions: { primarySchema, ledgerSchema },
    expectedMigrations: m.runtimeSchema.POSTGRES_RUNTIME_MIGRATIONS,
    privateOrigin: DISPATCH_ORIGIN,
    healthDispatch: mustNotCall("healthDispatch"),
    admissionEnv: Object.freeze({
      ENVIRONMENT: "test",
      ENROLLMENT_RATE_LIMIT: allowAll(),
      RECOVERY_RATE_LIMIT: allowAll(),
      CLIENT_ATTEMPT_RATE_LIMIT: allowAll(),
      PUBLIC_READ_RATE_LIMIT: allowAll(),
      UPLOAD_AUTHORIZATION_RATE_LIMIT: allowAll(),
      UPLOAD_PRINCIPAL_RATE_LIMIT: allowAll(),
    }),
    assertAdmissionBindings: m.workerAdmission.assertAdmissionBindings,
    assertAttemptAllowed: m.workerAdmission.assertAttemptAllowed,
    assertUploadAuthorizationBindings: m.workerAdmission.assertUploadAuthorizationBindings,
    assertUploadAuthorizationAllowed: m.workerAdmission.assertUploadAuthorizationAllowed,
    authenticatePostgresDevice: mustNotCall("authenticatePostgresDevice"),
    disconnectPostgresAuthenticatedDevice: mustNotCall("disconnectPostgresAuthenticatedDevice"),
    hasPostgresDeletionTombstone: mustNotCall("hasPostgresDeletionTombstone"),
    readPostgresDeviceSyncCapabilities: mustNotCall("readPostgresDeviceSyncCapabilities"),
    readPostgresV12DayCandidates: mustNotCall("readPostgresV12DayCandidates"),
    readPostgresTelemetryV12EffectivePage: mustNotCall("readPostgresTelemetryV12EffectivePage"),
    publicEnvelopeKey: m.workerCrypto.publicEnvelopeKey,
    sourceNamespace: "synthetic-origin-fastpath-source",
    createPostgresTypedV12Domain: mustNotCall("createPostgresTypedV12Domain"),
    assertPostgresV12UploadAllowed: mustNotCall("assertPostgresV12UploadAllowed"),
    createPostgresDeviceUploadAuthorization: mustNotCall("createPostgresDeviceUploadAuthorization"),
    registerPostgresTypedV12DayManifest: mustNotCall("registerPostgresTypedV12DayManifest"),
    claimPostgresDeviceUploadAuthorization: mustNotCall("claimPostgresDeviceUploadAuthorization"),
    abandonPostgresDeviceUploadAuthorization: mustNotCall("abandonPostgresDeviceUploadAuthorization"),
    recordPostgresDeviceUploadReceipt: mustNotCall("recordPostgresDeviceUploadReceipt"),
    persistPostgresTypedV12StagedChunk: mustNotCall("persistPostgresTypedV12StagedChunk"),
    decryptSyntheticEnvelope: mustNotCall("decryptSyntheticEnvelope"),
    validateTelemetryV12Envelope,
    validateTelemetryV12StagedChunk: mustNotCall("validateTelemetryV12StagedChunk"),
    sha256Hex: m.workerCrypto.sha256Hex,
    objectStore: { put: mustNotCall("objectStore.put"), delete: mustNotCall("objectStore.delete") },
    envelopePublicJwk: '{"synthetic":"unused-public-key"}',
    envelopePrivateJwk: "synthetic-unused-private-key",
    readBoundedRequestBody: m.bodyReader.readBoundedRequestBody,
    maxRequestBytes: m.constants.MAX_REQUEST_BYTES,
    ...overrides,
  });
}

function contributionRequest(body, authorization) {
  return new Request(`${DISPATCH_ORIGIN}${CONTRIBUTIONS_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body,
  });
}

test("(c) an unregistered envelope version gets the pre-change status and body byte-for-byte, before any claim", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const m = await loadModules();
  await withSchemas("tibotattle_fastpath_spec_", async (schemas) => {
    // The default origin registers v1.2 only; a v1.0 registration with its
    // format must not change how v1.1 is refused.
    const v10Handler = mustNotCall("v1.0 handler");
    const dispatches = [
      ["v1.2 only", contributionDispatch(m, schemas)],
      ["v1.2 plus a fake v1.0", contributionDispatch(m, schemas, {
        contributionEnvelopes: [registerContributionEnvelope("telemetry-envelope-v1.0", v10Handler)],
        uploadAuthorizationFormats: {
          "telemetry-contribution-v1.0": { assertUploadAllowed: mustNotCall("v1.0 floor") },
        },
      })],
    ];
    for (const [registryLabel, dispatch] of dispatches) {
      for (const envelope of UNREGISTERED_ENVELOPES) {
        for (const authorization of [undefined, `Upload um_device_upload_${randomUUID()}.${"A".repeat(43)}`]) {
          const observed = await withPinnedRequestId(async () => answer(
            await dispatch(contributionRequest(envelope.body, authorization)),
          ));
          const label = `${registryLabel}: ${envelope.label}`
            + (authorization === undefined ? " without a bearer" : " with a bearer");
          assert.equal(observed.status, envelope.status, label);
          assert.deepEqual(observed.headers, PRE_CHANGE_HEADERS, label);
          assert.equal(observed.text, PRE_CHANGE_ENVELOPE_INVALID_BODY, label);
        }
      }
    }
  });
});

test("(d) a registered envelope handler runs only after the shared preamble", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const m = await loadModules();
  await withSchemas("tibotattle_fastpath_spec_", async (schemas) => {
    const { base, primarySchema } = schemas;
    const consentVersion = m.constants.TELEMETRY_CONSENT_VERSION;
    const device = await insertSocialDevice(base, primarySchema, consentVersion);
    const events = [];
    let floorRefusal = null;
    let handlerBehaviour = "receipt";
    const validateEnvelope = (envelope, raw) => {
      events.push({ step: "validate", schemaVersion: envelope?.schemaVersion, rawLength: raw.length });
    };
    const handler = async (body, participant, sourceDeviceId, claimed, context) => {
      const grant = await base.query(
        `SELECT state FROM "${primarySchema}"."device_upload_authorizations" WHERE id=$1`,
        [claimed.authorizationId],
      );
      events.push({
        step: "handler", body, participant, sourceDeviceId, claimed, context,
        grantState: grant.rows[0]?.state,
      });
      if (handlerBehaviour === "throw-before-persist") {
        throw Object.assign(new Error("SYNTHETIC_HANDLER_REFUSAL"), {
          code: "SYNTHETIC_HANDLER_REFUSAL", status: 422,
        });
      }
      if (handlerBehaviour === "throw-after-persist") {
        context.markPersistStarted();
        throw Object.assign(new Error("BACKEND_STORAGE_UNAVAILABLE"), {
          code: "BACKEND_STORAGE_UNAVAILABLE", status: 503,
        });
      }
      if (handlerBehaviour === "no-contribution-id") {
        return new Response(JSON.stringify({ status: "staged" }), {
          status: 202, headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      if (handlerBehaviour === "consume-in-persist") {
        // A fresh admission consumes the grant in its own persist transaction.
        context.markPersistStarted();
        await consume(claimed.authorizationId, "synthetic-v11-receipt");
      }
      if (handlerBehaviour === "persist-then-receipt") context.markPersistStarted();
      return new Response(JSON.stringify({ contributionId: "synthetic-v11-receipt" }), {
        status: 202, headers: { "content-type": "application/json; charset=utf-8" },
      });
    };
    const floor = async (poolArgument, principal, nowEpoch, options) => {
      events.push({ step: "floor", poolArgument, principal, nowEpoch, options });
      if (floorRefusal) throw floorRefusal;
    };
    // The consume step of d43c8f92 recordDeviceUploadReceipt for a social
    // grant; the real PostgreSQL recorder is injected by the composition root.
    const consume = (authorizationId, contributionId) => base.query(
      `UPDATE "${primarySchema}"."device_upload_authorizations"
          SET state='consumed', consumed_at=now(), consumed_contribution_id=$2,
              consume_lease_expires_at=NULL
        WHERE id=$1 AND state='consuming'`,
      [authorizationId, contributionId],
    );
    let receiptFailure = null;
    const recordPostgresDeviceUploadReceipt = async (poolArgument, authorizationId, contributionId, options) => {
      events.push({ step: "receipt", poolArgument, authorizationId, contributionId, options });
      if (receiptFailure) throw receiptFailure;
      if ((await consume(authorizationId, contributionId)).rowCount === 1) return;
      const existing = (await base.query(
        `SELECT state, consumed_contribution_id FROM "${primarySchema}"."device_upload_authorizations"
          WHERE id=$1`,
        [authorizationId],
      )).rows[0];
      if (existing?.state !== "consumed" || existing.consumed_contribution_id !== contributionId) {
        throw Object.assign(new Error("INTERNAL_ERROR"), { code: "INTERNAL_ERROR", status: 500 });
      }
    };
    const tombstoneChecks = [];
    const dispatch = contributionDispatch(m, schemas, {
      authenticatePostgresDevice: m.transport.authenticatePostgresDevice,
      createPostgresDeviceUploadAuthorization: m.uploadAuthorization.createPostgresDeviceUploadAuthorization,
      claimPostgresDeviceUploadAuthorization: m.transport.claimPostgresDeviceUploadAuthorization,
      abandonPostgresDeviceUploadAuthorization: m.transport.abandonPostgresDeviceUploadAuthorization,
      hasPostgresDeletionTombstone: async (...args) => {
        tombstoneChecks.push(args[1]);
        return m.ledgerAuthority.hasPostgresDeletionTombstone(...args);
      },
      recordPostgresDeviceUploadReceipt,
      contributionEnvelopes: [registerContributionEnvelope(V11_ENVELOPE, handler, { validateEnvelope })],
      uploadAuthorizationFormats: { [V11_TRANSPORT]: { assertUploadAllowed: floor } },
    });
    const grant = async (authorizationId) => (await base.query(
      `SELECT state, consumed_contribution_id FROM "${primarySchema}"."device_upload_authorizations"
        WHERE id=$1`,
      [authorizationId],
    )).rows[0];
    const grantState = async (authorizationId) => (await grant(authorizationId))?.state;
    const issue = async (raw) => {
      const response = await dispatch(new Request(`${DISPATCH_ORIGIN}${UPLOAD_AUTHORIZATIONS_PATH}`, {
        method: "POST",
        headers: { authorization: device.deviceAuthorization, "content-type": "application/json" },
        body: JSON.stringify({
          envelopeDigest: sha256Hex(Buffer.from(raw)),
          contentLengthBytes: Buffer.byteLength(raw),
          contentType: "application/json",
          telemetrySchemaVersion: V11_TRANSPORT,
        }),
      }));
      assert.equal(response.status, 201, "the v1.1 format issues through the format table");
      const { uploadAuthorization } = await response.json();
      const authorizationId = uploadAuthorization.slice("um_device_upload_".length).split(".", 1)[0];
      return { header: `Upload ${uploadAuthorization}`, authorizationId };
    };
    const envelopeBody = (nonce) => JSON.stringify({ schemaVersion: V11_ENVELOPE, nonce });
    const handlerCalls = () => events.filter((event) => event.step === "handler").length;

    // Issuance ran the v1.1 format's floor with the authenticated device.
    const first = envelopeBody("first");
    const issued = await issue(first);
    assert.deepEqual(events.map((event) => event.step), ["floor"]);
    assert.equal(events[0].poolArgument, base);
    assert.equal(events[0].principal.participantId, device.participantId);
    assert.equal(events[0].principal.deviceId, device.deviceId);
    assert.deepEqual(events[0].options, { schema: { primarySchema, ledgerSchema: schemas.ledgerSchema } });
    // Every device route checks the tombstone; only contribution checks count below.
    events.length = 0;
    tombstoneChecks.length = 0;

    // Unauthenticated, wrong-bearer and wrong-body requests never reach the
    // floor or the handler, and leave the issued grant unused.
    for (const [authorization, body] of [
      [undefined, first],
      ["Upload not-an-upload-authorization", first],
      [`Upload um_device_upload_${randomUUID()}.${"A".repeat(43)}`, first],
      [device.deviceAuthorization, first],
      [issued.header, envelopeBody("a different body than the grant")],
    ]) {
      const response = await dispatch(contributionRequest(body, authorization));
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, "UPLOAD_AUTH_INVALID");
    }
    assert.deepEqual([...new Set(events.map((event) => event.step))], ["validate"],
      "only the pure pre-claim validator ran");
    assert.equal(handlerCalls(), 0);
    assert.deepEqual(tombstoneChecks, []);
    assert.equal(await grantState(issued.authorizationId), "unused");
    events.length = 0;

    // A refused transport floor stops before the handler and abandons the claim.
    floorRefusal = Object.assign(new Error("TELEMETRY_TRANSPORT_BLOCKED"), {
      code: "TELEMETRY_TRANSPORT_BLOCKED", status: 403,
    });
    const blocked = await dispatch(contributionRequest(first, issued.header));
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, "TELEMETRY_TRANSPORT_BLOCKED");
    assert.deepEqual(events.map((event) => event.step), ["validate", "floor"]);
    assert.deepEqual(tombstoneChecks, [device.participantId], "the tombstone check precedes the floor");
    assert.equal(handlerCalls(), 0);
    assert.equal(await grantState(issued.authorizationId), "revoked");
    floorRefusal = null;
    events.length = 0;
    tombstoneChecks.length = 0;

    // A tombstoned participant is refused after the claim and before the floor.
    const tombstoneBody = envelopeBody("tombstoned");
    const tombstoneGrant = await issue(tombstoneBody);
    events.length = 0;
    tombstoneChecks.length = 0;
    const tombstoneDispatch = contributionDispatch(m, schemas, {
      claimPostgresDeviceUploadAuthorization: m.transport.claimPostgresDeviceUploadAuthorization,
      abandonPostgresDeviceUploadAuthorization: m.transport.abandonPostgresDeviceUploadAuthorization,
      hasPostgresDeletionTombstone: async () => true,
      contributionEnvelopes: [registerContributionEnvelope(V11_ENVELOPE, handler, { validateEnvelope })],
      uploadAuthorizationFormats: { [V11_TRANSPORT]: { assertUploadAllowed: floor } },
    });
    const tombstoned = await tombstoneDispatch(contributionRequest(tombstoneBody, tombstoneGrant.header));
    assert.equal(tombstoned.status, 401);
    assert.equal((await tombstoned.json()).error.code, "UPLOAD_AUTH_INVALID");
    assert.deepEqual(events.map((event) => event.step), ["validate"]);
    assert.equal(await grantState(tombstoneGrant.authorizationId), "revoked");
    events.length = 0;

    // After the whole preamble the handler runs with the claimed context.
    const accepted = envelopeBody("accepted");
    const acceptedGrant = await issue(accepted);
    events.length = 0;
    tombstoneChecks.length = 0;
    const response = await dispatch(contributionRequest(accepted, acceptedGrant.header));
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { contributionId: "synthetic-v11-receipt" });
    assert.deepEqual(events.map((event) => event.step), ["validate", "floor", "handler", "receipt"]);
    assert.deepEqual(tombstoneChecks, [device.participantId]);
    const call = events[2];
    assert.equal(call.grantState, "consuming", "the handler runs on a claimed authorization");
    assert.equal(call.body.raw, accepted);
    assert.deepEqual(call.body.value, JSON.parse(accepted));
    assert.deepEqual(Buffer.from(call.body.bytes), Buffer.from(accepted));
    assert.ok(Object.isFrozen(call.body));
    assert.deepEqual(call.participant, { id: device.participantId, consentVersion, ownerKind: "social" });
    assert.equal(call.sourceDeviceId, device.deviceId);
    assert.deepEqual({ ...call.claimed }, {
      authorizationId: acceptedGrant.authorizationId,
      participantId: device.participantId,
      authorizationKind: "device",
    });
    assert.deepEqual({ ...call.context.principal }, {
      participantId: device.participantId, deviceId: device.deviceId,
    });
    assert.equal(call.context.envelopeDigest, sha256Hex(Buffer.from(accepted)));
    assert.equal(call.context.bodyBytes, Buffer.byteLength(accepted));
    assert.equal(call.context.contentType, "application/json");
    assert.equal(call.context.primaryPool, base);
    assert.equal(call.context.sourceNamespace, "synthetic-origin-fastpath-source");
    assert.equal(typeof call.context.markPersistStarted, "function");
    assert.ok(Object.isFrozen(call.context));
    assert.deepEqual(events[1].principal, call.context.principal, "the floor saw the claimed principal");
    // After the handler returns, the preamble records the receipt against
    // the response's contributionId, as d43c8f92 handleContribution does.
    assert.deepEqual({ ...events[3] }, {
      step: "receipt",
      poolArgument: base,
      authorizationId: acceptedGrant.authorizationId,
      contributionId: "synthetic-v11-receipt",
      options: { schema: { primarySchema, ledgerSchema: schemas.ledgerSchema } },
    });
    assert.deepEqual({ ...await grant(acceptedGrant.authorizationId) }, {
      state: "consumed", consumed_contribution_id: "synthetic-v11-receipt",
    });
    events.length = 0;

    // A handler that already consumed the grant against the same id in its
    // persist transaction gets the same idempotent receipt.
    handlerBehaviour = "consume-in-persist";
    const consumedBody = envelopeBody("consumed-in-persist");
    const consumedGrant = await issue(consumedBody);
    events.length = 0;
    const consumedInPersist = await dispatch(contributionRequest(consumedBody, consumedGrant.header));
    assert.equal(consumedInPersist.status, 202);
    assert.deepEqual(events.map((event) => event.step), ["validate", "floor", "handler", "receipt"]);
    assert.deepEqual({ ...await grant(consumedGrant.authorizationId) }, {
      state: "consumed", consumed_contribution_id: "synthetic-v11-receipt",
    });
    events.length = 0;

    // A handler failure before markPersistStarted() abandons the claim; after
    // it, the preamble leaves the claim for the handler to resolve. Once the
    // handler has returned, a receipt that cannot be read or recorded
    // abandons the still-consuming claim, as the Worker does.
    for (const [behaviour, failure, status, code, steps, finalState] of [
      ["throw-before-persist", null, 422, "SYNTHETIC_HANDLER_REFUSAL",
        ["validate", "floor", "handler"], "revoked"],
      ["throw-after-persist", null, 503, "BACKEND_STORAGE_UNAVAILABLE",
        ["validate", "floor", "handler"], "consuming"],
      ["no-contribution-id", null, 500, "INTERNAL_ERROR",
        ["validate", "floor", "handler"], "revoked"],
      ["persist-then-receipt", Object.assign(new Error("BACKEND_STORAGE_UNAVAILABLE"), {
        code: "BACKEND_STORAGE_UNAVAILABLE", status: 503,
      }), 503, "BACKEND_STORAGE_UNAVAILABLE", ["validate", "floor", "handler", "receipt"], "revoked"],
    ]) {
      handlerBehaviour = behaviour;
      receiptFailure = failure;
      const body = envelopeBody(behaviour);
      const issuedGrant = await issue(body);
      events.length = 0;
      const failed = await dispatch(contributionRequest(body, issuedGrant.header));
      assert.equal(failed.status, status, behaviour);
      assert.equal((await failed.json()).error.code, code, behaviour);
      assert.deepEqual(events.map((event) => event.step), steps, behaviour);
      assert.equal(await grantState(issuedGrant.authorizationId), finalState, behaviour);
    }
    receiptFailure = null;

    // A registration that owns its receipt resolves the claim itself; the
    // preamble records nothing after it.
    handlerBehaviour = "receipt";
    const ownedDispatch = contributionDispatch(m, schemas, {
      claimPostgresDeviceUploadAuthorization: m.transport.claimPostgresDeviceUploadAuthorization,
      abandonPostgresDeviceUploadAuthorization: m.transport.abandonPostgresDeviceUploadAuthorization,
      hasPostgresDeletionTombstone: m.ledgerAuthority.hasPostgresDeletionTombstone,
      recordPostgresDeviceUploadReceipt: null,
      contributionEnvelopes: [registerContributionEnvelope(V11_ENVELOPE, handler, {
        validateEnvelope, ownsReceipt: true,
      })],
      uploadAuthorizationFormats: { [V11_TRANSPORT]: { assertUploadAllowed: floor } },
    });
    const ownedBody = envelopeBody("owns-receipt");
    const ownedGrant = await issue(ownedBody);
    events.length = 0;
    const owned = await ownedDispatch(contributionRequest(ownedBody, ownedGrant.header));
    assert.equal(owned.status, 202);
    assert.deepEqual(events.map((event) => event.step), ["validate", "floor", "handler"]);
    assert.equal(await grantState(ownedGrant.authorizationId), "consuming");
  });
});

test("(c, d) envelope and format registrations must pair exactly and never replace v1.2", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const m = await loadModules();
  await withSchemas("tibotattle_fastpath_spec_", async (schemas) => {
    const handler = mustNotCall("handler");
    const floor = { assertUploadAllowed: mustNotCall("floor") };
    for (const [overrides, expected] of [
      [{ contributionEnvelopes: [registerContributionEnvelope(V11_ENVELOPE, handler)] },
        /telemetry-envelope-v1\.1 has no telemetry-contribution-v1\.1 upload-authorization format/u],
      [{ uploadAuthorizationFormats: { [V11_TRANSPORT]: floor } },
        /telemetry-contribution-v1\.1 has no telemetry-envelope-v1\.1 handler/u],
      [{ contributionEnvelopes: [registerContributionEnvelope("telemetry-envelope-v1.2", handler)] },
        /more than one handler claims telemetry-envelope-v1\.2/u],
      [{ uploadAuthorizationFormats: { "telemetry-contribution-v1.2": floor } },
        /POSTGRES_TEST_CONTRIBUTION_REGISTRY_CONFIGURATION_INVALID/u],
      [{ uploadAuthorizationFormats: new Map([["telemetry-contribution-v1.2", floor]]) },
        /POSTGRES_TEST_CONTRIBUTION_REGISTRY_CONFIGURATION_INVALID/u],
      [{ contributionEnvelopes: "telemetry-envelope-v1.1" },
        /POSTGRES_TEST_CONTRIBUTION_REGISTRY_CONFIGURATION_INVALID/u],
      [{ contributionEnvelopes: [{ schemaVersion: V11_ENVELOPE, handler, validateEnvelope: null }] },
        /only values returned by registerContributionEnvelope/u],
      // A registration that leaves its receipt to the preamble needs the recorder.
      [{
        contributionEnvelopes: [registerContributionEnvelope(V11_ENVELOPE, handler)],
        uploadAuthorizationFormats: { [V11_TRANSPORT]: floor },
        recordPostgresDeviceUploadReceipt: null,
      }, /POSTGRES_TEST_CONTRIBUTION_RECEIPT_CONFIGURATION_INVALID/u],
      [{ recordPostgresDeviceUploadReceipt: "recordPostgresDeviceUploadReceipt" },
        /POSTGRES_TEST_CONTRIBUTION_RECEIPT_CONFIGURATION_INVALID/u],
    ]) {
      assert.throws(() => contributionDispatch(m, schemas, overrides), expected);
    }
    // v1.2 owns its receipt: the v1.2-only origin, and one whose extra
    // registrations all own theirs, start without a recorder.
    for (const overrides of [
      { recordPostgresDeviceUploadReceipt: null },
      {
        contributionEnvelopes: [registerContributionEnvelope(V11_ENVELOPE, handler, { ownsReceipt: true })],
        uploadAuthorizationFormats: { [V11_TRANSPORT]: floor },
        recordPostgresDeviceUploadReceipt: null,
      },
    ]) {
      assert.equal(typeof contributionDispatch(m, schemas, overrides), "function");
    }
  });
});
