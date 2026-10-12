import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import pg from "pg";
import { createServer, transformWithOxc } from "vite";
import { renderPostgresSearchPath } from "../scripts/postgres-migrations.mjs";
import { applyMigrationsBefore } from "./promoted-migration-prefix.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(WORKER_ROOT, "postgres-test", "fixtures");
// 0054 is promoted (claude/gcp-fastpath-base): schemas receive the promoted
// chain below 0054, then the promoted 0054 file itself.
const STAGED_MIGRATION_NAME = "0054_signin_handoff_claim_shape.sql";
const STAGED_MIGRATION = join(WORKER_ROOT, "postgres", "migrations", "primary", STAGED_MIGRATION_NAME);
const SECRET = "synthetic-identity-link-secret-never-real-0001";
const OTHER_SECRET = "synthetic-identity-link-secret-never-real-0002";
const SECRET_VERSION = "synthetic-v1";
// HMAC-SHA256(SECRET, "app-usagemonitor/identity-link-secret-fingerprint/v1\0"),
// computed independently of the Worker helper.
const SECRET_FINGERPRINT = "05f0f43f93992a9c6391902bcbee03dfa08a9bf679c0fe7bbdcf85d9397301d6";
// 2026-09-26T12:00:17.250Z: 42.75 s remain in the minute window.
const NOW = Date.UTC(2026, 8, 26, 12, 0, 17, 250);
const DRIVER_MARKER = "synthetic-driver-detail-must-not-surface";
const MUTATING_SQL = /\b(?:INSERT|UPDATE|DELETE|MERGE|UPSERT|TRUNCATE|CREATE|ALTER|DROP)\b/iu;

const vite = await createServer({
  root: WORKER_ROOT,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const primitives = await vite.ssrLoadModule("/src/postgres-signin-primitives.ts");
const callbackPage = await vite.ssrLoadModule("/src/postgres-signin-callback-page.ts");
const errors = await vite.ssrLoadModule("/src/errors.ts");
const identityLink = await vite.ssrLoadModule("/src/identity-link-configuration.ts");
const postgresClient = await vite.ssrLoadModule("/src/postgres-client.ts");

after(async () => vite.close());

function qschema(schema) {
  return `"${schema}"`;
}

function q(schema, name) {
  return `${qschema(schema)}."${name}"`;
}

function claimId(length = 64) {
  return randomBytes(64).toString("base64url").slice(0, length);
}

function hostedEnv(overrides = {}) {
  return {
    ENVIRONMENT: "production",
    ENROLLMENT_MODE: "open",
    IDENTITY_LINK_SECRET: SECRET,
    IDENTITY_LINK_SECRET_VERSION: SECRET_VERSION,
    SIGN_IN_START_MAX_PER_MINUTE: "2",
    ...overrides,
  };
}

async function rejectsApi(promise, status, code, responseHeaders = null) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof errors.ApiError, `expected ApiError ${code}, got ${error?.name}`);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.deepEqual(error.responseHeaders, responseHeaders);
    assert.equal(String(error.message).includes(DRIVER_MARKER), false);
    return true;
  });
}

/** A pool that must never be reached: it records any connection attempt. */
function untouchablePool() {
  const pool = {
    connects: 0,
    async connect() {
      pool.connects += 1;
      throw new Error(`unexpected connection ${DRIVER_MARKER}`);
    },
  };
  return pool;
}

/** A pool whose connection fails, like an unreachable primary. */
function faultingPool() {
  return {
    async connect() {
      throw Object.assign(new Error(`connection refused ${DRIVER_MARKER}`), { code: "08006" });
    },
  };
}

/** Record every statement; optionally fail the statements matching failOn. */
function recordingPool(pool, statements, failOn = null) {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query(text, values) {
          statements.push(text);
          if (failOn !== null && failOn.test(text)) {
            throw Object.assign(new Error(`statement failed ${DRIVER_MARKER}`), { code: "08006" });
          }
          return client.query(text, values);
        },
        release(discard) {
          return client.release(discard);
        },
      };
    },
  };
}

/** Extract the Worker's own signInCallbackPage from index.ts and run it. */
async function workerSignInCallbackPages() {
  const source = await readFile(join(WORKER_ROOT, "src", "index.ts"), "utf8");
  const literal = (name) => {
    const match = new RegExp(`\\nconst ${name} =\\s*("(?:[^"\\\\\\n]|\\\\.)*");\\n`, "u")
      .exec(source);
    assert.ok(match, `Worker constant ${name} not found`);
    return JSON.parse(match[1]);
  };
  const marker = "\nfunction signInCallbackPage(";
  const start = source.indexOf(marker);
  assert.ok(start >= 0, "Worker signInCallbackPage not found");
  assert.equal(source.indexOf(marker, start + 1), -1, "Worker signInCallbackPage is ambiguous");
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, "Worker signInCallbackPage end not found");
  const { code } = await transformWithOxc(
    source.slice(start + 1, end + 3),
    "worker-signin-callback-page.ts",
    {},
  );
  const page = new Function(
    "SIGNIN_CALLBACK_APP_OPEN_URL",
    `${code}\nreturn signInCallbackPage;`,
  )(literal("SIGNIN_CALLBACK_APP_OPEN_URL"));
  return {
    success: page(literal("SIGNIN_COMPLETED_MESSAGE"), { completed: true }),
    failure: page(literal("SIGNIN_NOT_COMPLETED_MESSAGE")),
  };
}

const EXPECTED_PAGE_HEADERS = [
  ["cache-control", "no-store"],
  ["content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"],
  ["content-type", "text/html; charset=utf-8"],
  ["permissions-policy", "camera=(), microphone=(), geolocation=()"],
  ["referrer-policy", "no-referrer"],
  ["x-content-type-options", "nosniff"],
];

test("callback page bytes equal the golden fixtures, the Worker template, and carry exactly the Worker headers", async () => {
  const golden = {
    success: await readFile(join(FIXTURES, "signin-callback-page-success.golden.html")),
    failure: await readFile(join(FIXTURES, "signin-callback-page-failure.golden.html")),
  };
  const worker = await workerSignInCallbackPages();
  const rendered = {
    success: callbackPage.renderSignInCallbackPage(true),
    failure: callbackPage.renderSignInCallbackPage(false),
  };
  for (const outcome of ["success", "failure"]) {
    const response = rendered[outcome];
    assert.equal(response.status, 200);
    assert.deepEqual([...response.headers], EXPECTED_PAGE_HEADERS);
    assert.deepEqual([...worker[outcome].headers], EXPECTED_PAGE_HEADERS);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(Buffer.compare(bytes, golden[outcome]), 0, `${outcome} page differs from golden`);
    const workerBytes = Buffer.from(await worker[outcome].arrayBuffer());
    assert.equal(Buffer.compare(workerBytes, golden[outcome]), 0,
      `Worker ${outcome} page differs from golden`);
  }
  const success = golden.success.toString("utf8");
  const failure = golden.failure.toString("utf8");
  for (const html of [success, failure]) {
    assert.equal((html.match(/<title>TiboTattle sign-in<\/title>/gu) ?? []).length, 1);
    assert.equal((html.match(/<a class="action" href="usagemonitor:\/\/open">Open TiboTattle<\/a>/gu) ?? []).length, 1);
    assert.equal(/<script|https?:|\bsrc=/iu.test(html), false);
  }
  assert.ok(success.includes("<h1>You're signed in</h1>"));
  assert.ok(success.includes("<p>Signed in — return to TiboTattle.</p>"));
  assert.ok(success.includes(
    '<p class="hint">TiboTattle is opening now. You can close this browser tab.</p>'));
  assert.ok(success.includes('<meta http-equiv="refresh" content="0; url=usagemonitor://open">'));
  assert.ok(failure.includes("<h1>Sign-in was not completed</h1>"));
  assert.ok(failure.includes(
    "<p>Sign-in was not completed. Return to TiboTattle and start the sign-in again.</p>"));
  assert.ok(failure.includes(
    '<p class="hint">No data was uploaded. TiboTattle is reopening so you can try again.</p>'));
  assert.ok(failure.includes('<meta http-equiv="refresh" content="2; url=usagemonitor://open">'));

  // Only a literal true renders the completed page.
  for (const value of ["true", 1, {}, undefined, null]) {
    const bytes = Buffer.from(await callbackPage.renderSignInCallbackPage(value).arrayBuffer());
    assert.equal(Buffer.compare(bytes, golden.failure), 0);
  }
  // Each response owns its headers; mutating one never leaks into the next.
  const first = callbackPage.renderSignInCallbackPage(true);
  first.headers.set("x-extra", "1");
  assert.deepEqual([...callbackPage.renderSignInCallbackPage(true).headers], EXPECTED_PAGE_HEADERS);
  assert.ok(Object.isFrozen(callbackPage.SIGN_IN_CALLBACK_PAGE_HEADERS));
});

test("pin fingerprint uses the Worker helper and matches the independent golden vector", async () => {
  const independent = createHmac("sha256", SECRET)
    .update("app-usagemonitor/identity-link-secret-fingerprint/v1\0")
    .digest("hex");
  assert.equal(independent, SECRET_FINGERPRINT);
  assert.equal(await identityLink.identityLinkSecretFingerprint(SECRET), SECRET_FINGERPRINT);
});

test("pin, admission and preconditions refuse bad configuration before any storage access", async () => {
  const pool = untouchablePool();
  for (const env of [
    hostedEnv({ IDENTITY_LINK_SECRET: undefined }),
    hostedEnv({ IDENTITY_LINK_SECRET: "x".repeat(31) }),
    hostedEnv({ IDENTITY_LINK_SECRET: 42 }),
    hostedEnv({ IDENTITY_LINK_SECRET_VERSION: undefined }),
    hostedEnv({ IDENTITY_LINK_SECRET_VERSION: "" }),
    hostedEnv({ IDENTITY_LINK_SECRET_VERSION: "-leading-dash" }),
    hostedEnv({ IDENTITY_LINK_SECRET_VERSION: "v".repeat(65) }),
    hostedEnv({ IDENTITY_LINK_SECRET_VERSION: "bad version" }),
  ]) {
    await rejectsApi(
      primitives.assertExistingPostgresIdentityLinkPin(pool, "tibotattle", env),
      503,
      "IDENTITY_CONFIGURATION_INVALID",
    );
  }
  for (const value of ["0", "1201", "abc", "", " 2", "2.0", "+2", "-1", "1e3", 2, undefined]) {
    await rejectsApi(
      primitives.admitPostgresSignInStart(
        pool,
        "tibotattle",
        hostedEnv({ SIGN_IN_START_MAX_PER_MINUTE: value }),
        NOW,
      ),
      503,
      "ADMISSION_CONFIGURATION_INVALID",
    );
  }
  let controlReads = 0;
  const readControl = async () => {
    controlReads += 1;
  };
  for (const env of [
    hostedEnv({ ENROLLMENT_MODE: undefined }),
    hostedEnv({ ENROLLMENT_MODE: "wide_open" }),
    hostedEnv({ ENROLLMENT_MODE: "local_open" }),
    hostedEnv({ ENROLLMENT_MODE: "local_open", ENVIRONMENT: undefined }),
  ]) {
    await rejectsApi(
      primitives.assertPostgresHostedSignInStartAllowed(pool, "tibotattle", env, { readControl }),
      503,
      "ADMISSION_CONFIGURATION_INVALID",
    );
  }
  assert.equal(controlReads, 0);
  assert.equal(pool.connects, 0);

  await assert.rejects(
    primitives.admitPostgresSignInStart(pool, "tibotattle", hostedEnv(), 1.5),
    { name: "TypeError", message: "POSTGRES_SIGNIN_CLOCK_INVALID" },
  );
  await assert.rejects(
    primitives.purgeExpiredHandoffs(pool, "tibotattle", "participants", NOW),
    { name: "TypeError", message: "POSTGRES_SIGNIN_HANDOFF_TABLE_INVALID" },
  );
  await assert.rejects(
    primitives.assertPostgresHostedSignInStartAllowed(pool, "tibotattle", hostedEnv(), {}),
    { name: "TypeError", message: "POSTGRES_SIGNIN_CONTROL_READER_INVALID" },
  );
  await assert.rejects(
    primitives.assertExistingPostgresIdentityLinkPin(null, "tibotattle", hostedEnv()),
    { name: "TypeError", message: "POSTGRES_SIGNIN_STORAGE_INVALID" },
  );
  await assert.rejects(
    primitives.assertExistingPostgresIdentityLinkPin(pool, "bad schema", hostedEnv()),
    { name: "TypeError" },
  );
  assert.equal(pool.connects, 0);
});

test("storage faults map to the Worker codes without driver text", async () => {
  const pool = faultingPool();
  await rejectsApi(
    primitives.assertExistingPostgresIdentityLinkPin(pool, "tibotattle", hostedEnv()),
    503,
    "BACKEND_STORAGE_UNAVAILABLE",
  );
  // As in the named PostgreSQL reference (postgres-google-handoff.ts), the
  // coordinated-window storage fault carries no retry-after header.
  await rejectsApi(
    primitives.admitPostgresSignInStart(pool, "tibotattle", hostedEnv(), NOW),
    503,
    "ADMISSION_RATE_LIMIT_UNAVAILABLE",
  );
  const failingClient = {
    async query() {
      throw Object.assign(new Error(`statement failed ${DRIVER_MARKER}`), { code: "08006" });
    },
    release() {},
  };
  await rejectsApi(
    primitives.assertExistingPostgresIdentityLinkPin(failingClient, "tibotattle", hostedEnv()),
    503,
    "BACKEND_STORAGE_UNAVAILABLE",
  );
  for (const target of [pool, failingClient]) {
    await assert.rejects(
      primitives.purgeExpiredHandoffs(target, "tibotattle", "google_signin_handoffs", NOW),
      (error) => {
        assert.ok(error instanceof postgresClient.PostgresStorageError);
        assert.equal(error instanceof errors.ApiError, false);
        assert.equal(error.message.includes(DRIVER_MARKER), false);
        return true;
      },
    );
  }
});

test("hosted start preconditions keep Worker order and fail closed on the control reader", async () => {
  const calls = [];
  const pool = untouchablePool();
  const run = (readControl, env = hostedEnv()) => primitives.assertPostgresHostedSignInStartAllowed(
    pool,
    "tibotattle",
    env,
    { readControl: async (...args) => {
      calls.push(args);
      return readControl();
    } },
  );
  await rejectsApi(
    run(() => { throw new errors.ApiError(503, "COLLECTION_ENROLLMENT_DISABLED"); }),
    503,
    "COLLECTION_ENROLLMENT_DISABLED",
  );
  await rejectsApi(
    run(() => { throw new errors.ApiError(503, "COLLECTION_CONTROL_UNAVAILABLE"); }),
    503,
    "COLLECTION_CONTROL_UNAVAILABLE",
  );
  for (const thrown of [
    new Error(`reader crashed ${DRIVER_MARKER}`),
    new errors.ApiError(503, "BACKEND_STORAGE_UNAVAILABLE"),
    new errors.ApiError(500, "INTERNAL_ERROR"),
    new errors.ApiError(400, "COLLECTION_ENROLLMENT_DISABLED"),
  ]) {
    await rejectsApi(run(() => { throw thrown; }), 503, "COLLECTION_CONTROL_UNAVAILABLE");
  }
  await rejectsApi(run(() => ({ enrollment: false })), 503, "COLLECTION_ENROLLMENT_DISABLED");
  // The reader must resolve with the controls snapshot: a void result (a
  // reader that neither asserts nor returns) is never taken as permission.
  for (const value of [undefined, null, "enabled", { enrollment: "true" }, { state: "operational" }]) {
    await rejectsApi(run(() => value), 503, "COLLECTION_CONTROL_UNAVAILABLE");
  }
  // The control is read with the pool, the schema and exactly 'enrollment'.
  assert.ok(calls.length > 0);
  for (const args of calls) assert.deepEqual(args, [pool, "tibotattle", "enrollment"]);
  // Nothing reached the pin while the control refused.
  assert.equal(pool.connects, 0);

  // An enabled control snapshot moves on to the pin, including in 'disabled'
  // enrollment mode and when ENVIRONMENT is absent (identity is then required).
  for (const env of [
    hostedEnv(),
    hostedEnv({ ENROLLMENT_MODE: "disabled" }),
    hostedEnv({ ENVIRONMENT: undefined }),
    hostedEnv({ ENVIRONMENT: "staging" }),
  ]) {
    await rejectsApi(
      primitives.assertPostgresHostedSignInStartAllowed(
        faultingPool(),
        "tibotattle",
        env,
        { readControl: async () => ({ enrollment: true }) },
      ),
      503,
      "BACKEND_STORAGE_UNAVAILABLE",
    );
  }

  // Worker parity (index.ts assertHostedSignInStartAllowed): the pin is only
  // required when identityRequired(env). A development environment, which
  // deliberately carries no identity secret, passes without touching storage,
  // but still runs the enrollment-mode and control checks first.
  const developmentEnvs = ["synthetic-development", "development", "local-development", "test"]
    .flatMap((environment) => ["local_open", "open", "disabled"].map((mode) => ({
      ENVIRONMENT: environment,
      ENROLLMENT_MODE: mode,
    })));
  for (const env of developmentEnvs) {
    const developmentPool = untouchablePool();
    await primitives.assertPostgresHostedSignInStartAllowed(
      developmentPool,
      "tibotattle",
      env,
      { readControl: async () => ({ enrollment: true }) },
    );
    assert.equal(developmentPool.connects, 0);
    await rejectsApi(
      primitives.assertPostgresHostedSignInStartAllowed(
        developmentPool,
        "tibotattle",
        env,
        { readControl: async () => ({ enrollment: false }) },
      ),
      503,
      "COLLECTION_ENROLLMENT_DISABLED",
    );
    await rejectsApi(
      primitives.assertPostgresHostedSignInStartAllowed(
        developmentPool,
        "tibotattle",
        env,
        { readControl: async () => undefined },
      ),
      503,
      "COLLECTION_CONTROL_UNAVAILABLE",
    );
    assert.equal(developmentPool.connects, 0);
  }
  await rejectsApi(
    primitives.assertPostgresHostedSignInStartAllowed(
      untouchablePool(),
      "tibotattle",
      { ENVIRONMENT: "synthetic-development", ENROLLMENT_MODE: "wide_open" },
      { readControl: async () => ({ enrollment: true }) },
    ),
    503,
    "ADMISSION_CONFIGURATION_INVALID",
  );
});

async function localPostgresEndpoint() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  const link = await lstat(PG_TEST_SOCKET);
  const host = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(host);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host, port: PG_TEST_PORT };
}

/**
 * Apply the 0054 fragment (after the promoted chain below 0054) in one
 * transaction with the migration runner's search_path guard and timeouts.
 */
async function applyStagedClaimShape(pool, schema) {
  const sql = await readFile(STAGED_MIGRATION, "utf8");
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL statement_timeout='30000ms'");
      await client.query("SET LOCAL lock_timeout='5000ms'");
      await client.query(renderPostgresSearchPath(schema));
      await client.query(sql);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        discard = true;
      });
      throw error;
    }
  } finally {
    client.release(discard);
  }
}

async function insertGoogleHandoff(pool, schema, { state, expiresAt, claim = null }) {
  await pool.query(
    `INSERT INTO ${q(schema, "google_signin_handoffs")}
       (state, code_verifier, binding_hash, claim_id, claimed_at, created_at, expires_at)
     VALUES ($1, NULL, NULL, $2, $3::timestamptz, $4::timestamptz, $5::timestamptz)`,
    [
      state,
      claim,
      claim === null ? null : new Date(NOW).toISOString(),
      new Date(NOW - 600_000).toISOString(),
      new Date(expiresAt).toISOString(),
    ],
  );
}

async function insertAppleHandoff(pool, schema, { state, expiresAt, claim = null }) {
  await pool.query(
    `INSERT INTO ${q(schema, "apple_signin_handoffs")}
       (state, nonce_hash, binding_hash, claim_id, claimed_at, created_at, expires_at)
     VALUES ($1, $2, NULL, $3, $4::timestamptz, $5::timestamptz, $6::timestamptz)`,
    [
      state,
      "a".repeat(64),
      claim,
      claim === null ? null : new Date(NOW).toISOString(),
      new Date(NOW - 600_000).toISOString(),
      new Date(expiresAt).toISOString(),
    ],
  );
}

async function pinRows(pool, schema) {
  const result = await pool.query(
    `SELECT key_version, secret_fingerprint, recorded_at
       FROM ${q(schema, "identity_link_secret_configuration")}`,
  );
  return result.rows;
}

test("PostgreSQL sign-in primitives: SELECT-only pin, global start admission, purge and claim shape", {
  skip: !PG_TEST_SOCKET,
  timeout: 240_000,
}, async (t) => {
  const endpoint = await localPostgresEndpoint();
  const pool = new pg.Pool({
    ...endpoint,
    user: process.env.PG_TEST_USER || "postgres",
    password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
    database: process.env.PG_TEST_DATABASE || "postgres",
    application_name: "pg-signin-primitives-test",
    ssl: false,
    max: 12,
    connectionTimeoutMillis: 5_000,
  });
  const suffix = randomBytes(5).toString("hex");
  const schema = `signin_primitives_${suffix}`;
  const legacySchema = `signin_claim_legacy_${suffix}`;
  const created = [];
  try {
    const locality = await pool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr() AS address",
    );
    assert.equal(Math.floor(locality.rows[0].version / 10_000), 17,
      "sign-in primitive qualification requires PostgreSQL 17");
    assert.equal(locality.rows[0].address, null,
      "sign-in primitive qualification requires a local Unix socket");
    await pool.query(`CREATE SCHEMA ${qschema(schema)}`);
    created.push(schema);
    await applyMigrationsBefore({ role: "primary", schema, pool, name: STAGED_MIGRATION_NAME });
    await applyStagedClaimShape(pool, schema);
    await pool.query(
      `UPDATE ${q(schema, "collection_controls")}
          SET control_state = 'operational', enrollment_enabled = true,
              upload_registration_enabled = true, processing_enabled = true,
              publication_enabled = true, revision = 1, updated_at = clock_timestamp()
        WHERE singleton = 1`,
    );

    await t.test("SELECT-only identity-link pin never establishes or rewrites a pin", async () => {
      const statements = [];
      const recording = recordingPool(pool, statements);
      await rejectsApi(
        primitives.assertExistingPostgresIdentityLinkPin(recording, schema, hostedEnv()),
        503,
        "IDENTITY_CONFIGURATION_INVALID",
      );
      assert.deepEqual(await pinRows(pool, schema), []);
      assert.ok(statements.some((text) => /^BEGIN\b.*\bREAD ONLY$/u.test(text)),
        "pool pin lookup must run in a read-only transaction");
      assert.equal(statements.some((text) => MUTATING_SQL.test(text)), false);

      // A caller's read-only transaction proves the client path writes nothing.
      const readOnlyClient = await pool.connect();
      try {
        await readOnlyClient.query("BEGIN READ ONLY");
        await rejectsApi(
          primitives.assertExistingPostgresIdentityLinkPin(readOnlyClient, schema, hostedEnv()),
          503,
          "IDENTITY_CONFIGURATION_INVALID",
        );
        await readOnlyClient.query("COMMIT");
      } finally {
        readOnlyClient.release();
      }
      assert.deepEqual(await pinRows(pool, schema), []);

      // The client path reads inside the caller's transaction: it sees the
      // caller's uncommitted pin row, commits nothing, and the caller's
      // ROLLBACK still discards that row.
      const callerTransaction = await pool.connect();
      try {
        await callerTransaction.query("BEGIN");
        await callerTransaction.query(
          `INSERT INTO ${q(schema, "identity_link_secret_configuration")}
             (singleton, key_version, secret_fingerprint, recorded_at)
           VALUES (1, $1, $2, '2026-01-01T00:00:00.000Z')`,
          [SECRET_VERSION, SECRET_FINGERPRINT],
        );
        await primitives.assertExistingPostgresIdentityLinkPin(callerTransaction, schema, hostedEnv());
        const status = await callerTransaction.query(
          "SELECT txid_current_if_assigned() IS NOT NULL AS open",
        );
        assert.deepEqual(status.rows, [{ open: true }],
          "the pin check must not end the caller's transaction");
        // Outside the caller's transaction the row is still invisible.
        await rejectsApi(
          primitives.assertExistingPostgresIdentityLinkPin(pool, schema, hostedEnv()),
          503,
          "IDENTITY_CONFIGURATION_INVALID",
        );
        await callerTransaction.query("ROLLBACK");
      } finally {
        callerTransaction.release();
      }
      assert.deepEqual(await pinRows(pool, schema), []);

      // The hosted start preconditions surface the same refusal with no pin
      // row. The injected reader resolves with the controls snapshot.
      const readControl = async (controlPool, controlSchema, name) => {
        assert.equal(controlPool, pool);
        assert.equal(controlSchema, schema);
        assert.equal(name, "enrollment");
        const result = await controlPool.query(
          `SELECT enrollment_enabled FROM ${q(controlSchema, "collection_controls")}
            WHERE singleton = 1`,
        );
        if (result.rows[0]?.enrollment_enabled !== true) {
          throw new errors.ApiError(503, "COLLECTION_ENROLLMENT_DISABLED");
        }
        return { enrollment: result.rows[0].enrollment_enabled };
      };
      await rejectsApi(
        primitives.assertPostgresHostedSignInStartAllowed(pool, schema, hostedEnv(), { readControl }),
        503,
        "IDENTITY_CONFIGURATION_INVALID",
      );
      assert.deepEqual(await pinRows(pool, schema), []);
      // A development environment (no identity secret, Worker dev parity)
      // starts without a pin row and still founds none.
      await primitives.assertPostgresHostedSignInStartAllowed(
        pool,
        schema,
        { ENVIRONMENT: "synthetic-development", ENROLLMENT_MODE: "local_open" },
        { readControl },
      );
      assert.deepEqual(await pinRows(pool, schema), []);

      // Import the pin as D1 holds it; the golden fingerprint now matches.
      await pool.query(
        `INSERT INTO ${q(schema, "identity_link_secret_configuration")}
           (singleton, key_version, secret_fingerprint, recorded_at)
         VALUES (1, $1, $2, '2026-01-01T00:00:00.000Z')`,
        [SECRET_VERSION, SECRET_FINGERPRINT],
      );
      const imported = await pinRows(pool, schema);
      statements.length = 0;
      await primitives.assertExistingPostgresIdentityLinkPin(recording, schema, hostedEnv());
      assert.equal(statements.some((text) => MUTATING_SQL.test(text)), false);
      const inTransaction = await pool.connect();
      try {
        await inTransaction.query("BEGIN READ ONLY");
        await primitives.assertExistingPostgresIdentityLinkPin(inTransaction, schema, hostedEnv());
        await inTransaction.query("COMMIT");
      } finally {
        inTransaction.release();
      }
      await primitives.assertPostgresHostedSignInStartAllowed(
        pool,
        schema,
        hostedEnv({ ENROLLMENT_MODE: "disabled" }),
        { readControl },
      );
      for (const env of [
        hostedEnv({ IDENTITY_LINK_SECRET: OTHER_SECRET }),
        hostedEnv({ IDENTITY_LINK_SECRET_VERSION: "synthetic-v2" }),
      ]) {
        await rejectsApi(
          primitives.assertExistingPostgresIdentityLinkPin(pool, schema, env),
          503,
          "IDENTITY_CONFIGURATION_INVALID",
        );
        await rejectsApi(
          primitives.assertPostgresHostedSignInStartAllowed(pool, schema, env, { readControl }),
          503,
          "IDENTITY_CONFIGURATION_INVALID",
        );
      }
      assert.deepEqual(await pinRows(pool, schema), imported);
      await rejectsApi(
        primitives.assertExistingPostgresIdentityLinkPin(
          recordingPool(pool, [], /identity_link_secret_configuration/u),
          schema,
          hostedEnv(),
        ),
        503,
        "BACKEND_STORAGE_UNAVAILABLE",
      );

      // A contained service refuses before the pin is consulted.
      await pool.query(
        `UPDATE ${q(schema, "collection_controls")}
            SET control_state = 'contained', enrollment_enabled = false,
                upload_registration_enabled = false, processing_enabled = false,
                publication_enabled = false, revision = 2, updated_at = clock_timestamp()
          WHERE singleton = 1`,
      );
      await rejectsApi(
        primitives.assertPostgresHostedSignInStartAllowed(
          pool,
          schema,
          hostedEnv({ IDENTITY_LINK_SECRET: OTHER_SECRET }),
          { readControl },
        ),
        503,
        "COLLECTION_ENROLLMENT_DISABLED",
      );
    });

    await t.test("global origin-tier start admission admits up to the limit with exact retry-after", async () => {
      const windows = async () => (await pool.query(
        `SELECT window_started_at, accepted_count, last_accepted_at
           FROM ${q(schema, "sign_in_start_admission_windows")}
          ORDER BY window_started_at`,
      )).rows.map((row) => ({
        windowStartedAt: row.window_started_at.toISOString(),
        acceptedCount: row.accepted_count,
        lastAcceptedAt: row.last_accepted_at.toISOString(),
      }));
      await rejectsApi(
        primitives.admitPostgresSignInStart(
          pool,
          schema,
          hostedEnv({ SIGN_IN_START_MAX_PER_MINUTE: "0" }),
          NOW,
        ),
        503,
        "ADMISSION_CONFIGURATION_INVALID",
      );
      assert.deepEqual(await windows(), []);
      assert.deepEqual(
        await primitives.admitPostgresSignInStart(pool, schema, hostedEnv(), NOW),
        { acceptedCount: 1, windowStartedAt: "2026-09-26T12:00:00.000Z" },
      );
      assert.deepEqual(
        await primitives.admitPostgresSignInStart(pool, schema, hostedEnv(), NOW + 1_000),
        { acceptedCount: 2, windowStartedAt: "2026-09-26T12:00:00.000Z" },
      );
      await rejectsApi(
        primitives.admitPostgresSignInStart(pool, schema, hostedEnv(), NOW),
        429,
        "SIGN_IN_START_LIMIT_REACHED",
        { "retry-after": "43" },
      );
      // retry-after is a ceiling, never a rounding or a floor: 42.4 s and
      // 59.999 s remaining must both round up.
      for (const [at, retryAfter] of [
        [Date.UTC(2026, 8, 26, 12, 0, 17, 600), "43"],
        [Date.UTC(2026, 8, 26, 12, 0, 0, 1), "60"],
        [Date.UTC(2026, 8, 26, 12, 0, 59, 999), "1"],
      ]) {
        await rejectsApi(
          primitives.admitPostgresSignInStart(pool, schema, hostedEnv(), at),
          429,
          "SIGN_IN_START_LIMIT_REACHED",
          { "retry-after": retryAfter },
        );
      }
      await rejectsApi(
        primitives.admitPostgresSignInStart(
          pool,
          schema,
          hostedEnv(),
          Date.UTC(2026, 8, 26, 12, 0, 59, 900),
        ),
        429,
        "SIGN_IN_START_LIMIT_REACHED",
        { "retry-after": "1" },
      );
      await rejectsApi(
        primitives.admitPostgresSignInStart(
          pool,
          schema,
          hostedEnv(),
          Date.UTC(2026, 8, 26, 12, 0, 0, 0),
        ),
        429,
        "SIGN_IN_START_LIMIT_REACHED",
        { "retry-after": "60" },
      );
      // A refusal never increments or refreshes the exhausted window.
      assert.deepEqual(await windows(), [{
        windowStartedAt: "2026-09-26T12:00:00.000Z",
        acceptedCount: 2,
        lastAcceptedAt: "2026-09-26T12:00:18.250Z",
      }]);
      // The next minute is a fresh window.
      assert.deepEqual(
        await primitives.admitPostgresSignInStart(
          pool,
          schema,
          hostedEnv(),
          Date.UTC(2026, 8, 26, 12, 1, 0, 0),
        ),
        { acceptedCount: 1, windowStartedAt: "2026-09-26T12:01:00.000Z" },
      );
      // A storage fault is a 503 and leaves the window untouched.
      await rejectsApi(
        primitives.admitPostgresSignInStart(
          recordingPool(pool, [], /sign_in_start_admission_windows/u),
          schema,
          hostedEnv(),
          Date.UTC(2026, 8, 26, 12, 1, 5, 0),
        ),
        503,
        "ADMISSION_RATE_LIMIT_UNAVAILABLE",
      );
      // Concurrent starts are admitted exactly up to the limit.
      const burstAt = Date.UTC(2026, 8, 26, 12, 2, 30, 0);
      const burst = await Promise.allSettled(Array.from({ length: 10 }, () =>
        primitives.admitPostgresSignInStart(
          pool,
          schema,
          hostedEnv({ SIGN_IN_START_MAX_PER_MINUTE: "3" }),
          burstAt,
        )));
      assert.equal(burst.filter((result) => result.status === "fulfilled").length, 3);
      assert.deepEqual(
        burst.filter((result) => result.status === "fulfilled")
          .map((result) => result.value.acceptedCount).sort(),
        [1, 2, 3],
      );
      for (const result of burst.filter((entry) => entry.status === "rejected")) {
        assert.equal(result.reason.code, "SIGN_IN_START_LIMIT_REACHED");
        assert.deepEqual(result.reason.responseHeaders, { "retry-after": "30" });
      }
      assert.deepEqual((await windows()).map((row) => row.acceptedCount), [2, 1, 3]);
    });

    await t.test("expired handoff purge deletes at most 100 rows, oldest first by (expires_at, state)", async () => {
      const googleTable = q(schema, "google_signin_handoffs");
      // Only ORDER BY expires_at, state selects the expected 100 rows: state
      // order runs opposite to expiry order, the rows are inserted in an order
      // that is neither, and two rows share the boundary expiry so the state
      // tie-break decides which of them is purged.
      const expired = [];
      for (let rank = 0; rank < 99; rank += 1) {
        expired.push({
          state: `old-${String(98 - rank).padStart(3, "0")}`,
          expiresAt: NOW - 1_000 * (200 - rank),
        });
      }
      expired.push({ state: "tie-b", expiresAt: NOW - 50_000 });
      expired.push({ state: "tie-a", expiresAt: NOW - 50_000 });
      for (let rank = 0; rank < 4; rank += 1) {
        expired.push({ state: `new-${3 - rank}`, expiresAt: NOW - 1_000 * (4 - rank) });
      }
      expired.push({ state: "expired-at-now", expiresAt: NOW });
      const insertionOrder = Array.from(
        { length: expired.length },
        (_, index) => (index * 37) % expired.length,
      );
      assert.equal(expired.length, 106);
      assert.equal(new Set(insertionOrder).size, expired.length);
      for (const index of insertionOrder) await insertGoogleHandoff(pool, schema, expired[index]);
      await insertGoogleHandoff(pool, schema, { state: "live-one", expiresAt: NOW + 1 });
      await insertGoogleHandoff(pool, schema, { state: "live-two", expiresAt: NOW + 60_000 });
      const rolledBack = await pool.connect();
      try {
        await rolledBack.query("BEGIN");
        assert.equal(
          await primitives.purgeExpiredHandoffs(rolledBack, schema, "google_signin_handoffs", NOW),
          100,
        );
        await rolledBack.query("ROLLBACK");
      } finally {
        rolledBack.release();
      }
      assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${googleTable}`)).rows[0].n, 108);
      assert.equal(
        await primitives.purgeExpiredHandoffs(pool, schema, "google_signin_handoffs", NOW),
        100,
      );
      // Exactly the 99 oldest rows and tie-a (the smaller state at the
      // boundary expiry) are gone.
      assert.deepEqual(
        (await pool.query(`SELECT state FROM ${googleTable} ORDER BY expires_at, state`)).rows
          .map((row) => row.state),
        ["tie-b", "new-3", "new-2", "new-1", "new-0", "expired-at-now", "live-one", "live-two"],
      );
      assert.equal(
        await primitives.purgeExpiredHandoffs(pool, schema, "google_signin_handoffs", NOW),
        6,
      );
      assert.equal(
        await primitives.purgeExpiredHandoffs(pool, schema, "google_signin_handoffs", NOW),
        0,
      );
      assert.deepEqual(
        (await pool.query(`SELECT state FROM ${googleTable} ORDER BY state`)).rows
          .map((row) => row.state),
        ["live-one", "live-two"],
      );
      await insertAppleHandoff(pool, schema, { state: "apple-expired", expiresAt: NOW - 1 });
      await insertAppleHandoff(pool, schema, { state: "apple-live", expiresAt: NOW + 1 });
      assert.equal(
        await primitives.purgeExpiredHandoffs(pool, schema, "apple_signin_handoffs", NOW),
        1,
      );
      assert.deepEqual(
        (await pool.query(`SELECT state FROM ${q(schema, "apple_signin_handoffs")}`)).rows,
        [{ state: "apple-live" }],
      );
      assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${googleTable}`)).rows[0].n, 2);
    });

    await t.test("purge skips, and never waits on, a handoff a concurrent callback is completing", async () => {
      const googleTable = q(schema, "google_signin_handoffs");
      const completedExpiry = new Date(NOW + 300_000).toISOString();
      const proof = claimId(64);
      // Start from an empty table in this test's own schema, so the purge
      // count covers only the two rows below.
      await pool.query(`DELETE FROM ${googleTable}`);
      // The completing row expires at NOW; an unrelated row expired earlier.
      await insertGoogleHandoff(pool, schema, {
        state: "race-completing",
        expiresAt: NOW,
        claim: claimId(64),
      });
      await insertGoogleHandoff(pool, schema, { state: "race-expired", expiresAt: NOW - 1_000 });
      const callback = await pool.connect();
      let callbackOpen = false;
      let blocked = false;
      let purged;
      try {
        await callback.query("BEGIN");
        callbackOpen = true;
        // A callback fills the proof at NOW - 50 ms (still unexpired) and moves
        // the expiry five minutes out, holding the row lock uncommitted.
        const completion = await callback.query(
          `UPDATE ${googleTable}
              SET proof = $1, claim_id = NULL, claimed_at = NULL, expires_at = $2::timestamptz
            WHERE state = 'race-completing' AND proof IS NULL AND expires_at > $3::timestamptz`,
          [proof, completedExpiry, new Date(NOW - 50).toISOString()],
        );
        assert.equal(completion.rowCount, 1);
        const callbackPid = (await callback.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        // A sign-in start purges at NOW + 100 ms, while the completion is open:
        // its snapshot still sees the old expiry.
        const purge = primitives.purgeExpiredHandoffs(
          pool,
          schema,
          "google_signin_handoffs",
          NOW + 100,
        );
        let settled = false;
        purge.then(() => { settled = true; }, () => { settled = true; });
        const deadline = Date.now() + 10_000;
        while (!settled && !blocked && Date.now() < deadline) {
          const waiting = await pool.query(
            `SELECT count(*)::integer AS n
               FROM pg_stat_activity
              WHERE $1::integer = ANY(pg_blocking_pids(pid))`,
            [callbackPid],
          );
          blocked = waiting.rows[0].n > 0;
          if (!blocked && !settled) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(settled || blocked, "purge neither settled nor blocked within 10 s");
        // Commit the completion before any assertion so no lock is stranded.
        await callback.query("COMMIT");
        callbackOpen = false;
        purged = await purge;
      } finally {
        if (callbackOpen) await callback.query("ROLLBACK").catch(() => {});
        callback.release();
      }
      assert.equal(blocked, false, "the purge must skip a locked handoff, not wait on its lock");
      assert.equal(purged, 1);
      const rows = await pool.query(
        `SELECT state, proof, expires_at FROM ${googleTable}
          WHERE state LIKE 'race-%' ORDER BY state`,
      );
      assert.deepEqual(
        rows.rows.map((row) => ({
          state: row.state,
          proof: row.proof,
          expiresAt: row.expires_at.toISOString(),
        })),
        [{ state: "race-completing", proof, expiresAt: completedExpiry }],
      );
      await pool.query(`DELETE FROM ${googleTable} WHERE state LIKE 'race-%'`);
    });

    await t.test("0054 enforces the claim_id shape on both handoff tables", async () => {
      const constraints = await pool.query(
        `SELECT rel.relname, con.conname, con.convalidated
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = rel.relnamespace
          WHERE ns.nspname = $1 AND con.conname LIKE '%claim_id_shape'
          ORDER BY rel.relname`,
        [schema],
      );
      assert.deepEqual(constraints.rows, [
        { relname: "apple_signin_handoffs", conname: "apple_signin_handoffs_claim_id_shape", convalidated: true },
        { relname: "google_signin_handoffs", conname: "google_signin_handoffs_claim_id_shape", convalidated: true },
      ]);
      // Length probes, then character-class probes that are exactly 64
      // characters, so only the base64url allowlist (D1 0033: length 64 and
      // no character outside A-Za-z0-9_-) can reject them.
      const classProbes = ["=", "+", ".", "/", "*", " ", "\t", "\n", "~", "é"]
        .map((character) => `${claimId(63)}${character}`);
      for (const probe of classProbes) assert.equal([...probe].length, 64);
      const shapeRejections = [
        claimId(63),
        claimId(65),
        "",
        `${claimId(64)}\n`,
        `\n${claimId(64)}`,
        ...classProbes,
        `é${claimId(63)}`,
      ];
      const shapeAcceptances = [
        claimId(64),
        `${"A".repeat(31)}-${"z".repeat(31)}_`,
        "-_".repeat(32),
        "0123456789".repeat(6).concat("abcd"),
      ];
      for (const probe of shapeAcceptances) assert.equal(probe.length, 64);
      // The server agrees every class probe is 64 characters long.
      const serverLengths = await pool.query(
        "SELECT char_length(probe)::integer AS length FROM unnest($1::text[]) AS probe",
        [classProbes],
      );
      assert.deepEqual(serverLengths.rows.map((row) => row.length), classProbes.map(() => 64));
      for (const [insert, table] of [
        [insertGoogleHandoff, "google_signin_handoffs"],
        [insertAppleHandoff, "apple_signin_handoffs"],
      ]) {
        for (const [index, claim] of shapeRejections.entries()) {
          await assert.rejects(
            insert(pool, schema, { state: `${table}-bad-${index}`, expiresAt: NOW + 60_000, claim }),
            { code: "23514", constraint: `${table}_claim_id_shape` },
          );
        }
        await insert(pool, schema, { state: `${table}-null`, expiresAt: NOW + 60_000, claim: null });
        for (const [index, claim] of shapeAcceptances.entries()) {
          await insert(pool, schema, { state: `${table}-accepted-${index}`, expiresAt: NOW + 60_000, claim });
        }
        await insert(pool, schema, {
          state: `${table}-valid`,
          expiresAt: NOW + 60_000,
          claim: claimId(64),
        });
        await assert.rejects(
          pool.query(
            `UPDATE ${q(schema, table)} SET claim_id = $1 WHERE state = $2`,
            [claimId(63), `${table}-null`],
          ),
          { code: "23514", constraint: `${table}_claim_id_shape` },
        );
        await pool.query(
          `UPDATE ${q(schema, table)} SET claim_id = NULL WHERE state = $1`,
          [`${table}-valid`],
        );
      }

      // Before 0054 a 63-character claim was accepted; the migration
      // validates existing rows and refuses (all-or-nothing) instead of
      // rewriting them.
      await pool.query(`CREATE SCHEMA ${qschema(legacySchema)}`);
      created.push(legacySchema);
      await applyMigrationsBefore({ role: "primary", schema: legacySchema, pool, name: STAGED_MIGRATION_NAME });
      await insertAppleHandoff(pool, legacySchema, {
        state: "legacy-apple-valid",
        expiresAt: NOW + 60_000,
        claim: claimId(64),
      });
      await insertGoogleHandoff(pool, legacySchema, {
        state: "legacy-google-short",
        expiresAt: NOW + 60_000,
        claim: claimId(63),
      });
      await assert.rejects(applyStagedClaimShape(pool, legacySchema), {
        code: "23514",
        constraint: "google_signin_handoffs_claim_id_shape",
      });
      const legacyConstraints = await pool.query(
        `SELECT count(*)::integer AS n
           FROM pg_constraint con
           JOIN pg_namespace ns ON ns.oid = con.connamespace
          WHERE ns.nspname = $1 AND con.conname LIKE '%claim_id_shape'`,
        [legacySchema],
      );
      assert.equal(legacyConstraints.rows[0].n, 0);
      assert.equal(
        (await pool.query(
          `SELECT char_length(claim_id) AS length FROM ${q(legacySchema, "google_signin_handoffs")}`,
        )).rows[0].length,
        63,
      );
      await pool.query(
        `UPDATE ${q(legacySchema, "google_signin_handoffs")} SET claim_id = NULL, claimed_at = NULL`,
      );
      await applyStagedClaimShape(pool, legacySchema);
    });
  } finally {
    for (const name of created.reverse()) {
      await pool.query(`DROP SCHEMA IF EXISTS ${qschema(name)} CASCADE`);
    }
    await pool.end();
  }
});
