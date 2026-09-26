import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
  renderPostgresSearchPath,
} from "../scripts/postgres-migrations.mjs";

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const SKIP_POSTGRES = !PG_TEST_HOST && !PG_TEST_SOCKET;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Staged primary SQL for this item. Until the wave integrator promotes a file
// into postgres/migrations it is applied inline after the stock migrations;
// once promoted, the stock runner applies it and it is not re-applied here.
const STAGED_PRIMARY_DIRECTORY = "postgres/staged-migrations/primary";
const STAGED_PRIMARY_MIGRATIONS = Object.freeze([
  "0048_rate_limit_buckets_unlogged.sql",
]);
const SYNTHETIC_ENV = Object.freeze({ ENVIRONMENT: "test" });
const PERIOD_SECONDS = 60;

let vite;
let rateLimit;
let admission;
let errors;

before(async () => {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  [rateLimit, admission, errors] = await Promise.all([
    vite.ssrLoadModule("/src/postgres-rate-limiter.ts"),
    vite.ssrLoadModule("/src/admission.ts"),
    vite.ssrLoadModule("/src/errors.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "admission tests require a loopback host or a private Unix socket");
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65535);
  if (PG_TEST_SOCKET) {
    assert.match(PG_TEST_SOCKET, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
    const link = await lstat(PG_TEST_SOCKET);
    const host = await realpath(PG_TEST_SOCKET);
    const metadata = await stat(host);
    assert.equal(link.isSymbolicLink(), false);
    assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.mode & 0o077, 0);
    assert.equal(metadata.uid, process.getuid());
    return { host, port: PG_TEST_PORT, socket: true };
  }
  return { host: PG_TEST_HOST, port: PG_TEST_PORT, socket: false };
}

function createPool(endpoint, max) {
  return new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max,
    connectionTimeoutMillis: 5_000,
  });
}

/** Staged files not yet promoted; a missing staged file fails loudly on read. */
async function pendingStagedPrimaryMigrations() {
  const stock = new Set((await readPostgresMigrations({ role: "primary" }))
    .map((migration) => migration.name));
  return STAGED_PRIMARY_MIGRATIONS.filter((name) => !stock.has(name));
}

async function applyStagedPrimaryMigrations(pool, schema, files) {
  if (files.length === 0) return;
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    await client.query(renderPostgresSearchPath(schema));
    for (const file of files) {
      await client.query(await readFile(resolve(WORKER_ROOT, STAGED_PRIMARY_DIRECTORY, file), "utf8"));
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

/**
 * Create an isolated primary schema with the stock migrations, then hand the
 * caller a hook to apply the staged SQL, a separate admission pool and a
 * helper pool for fixtures and lock holders.
 */
async function withLimiterSchema(operation, { staged = true } = {}) {
  const endpoint = await localEndpoint();
  const pool = createPool(endpoint, 4);
  const admissionPool = createPool(endpoint, 4);
  const suffix = randomBytes(6).toString("hex");
  const primarySchema = `admission_isolation_primary_${suffix}`;
  const ledgerSchema = `admission_isolation_ledger_${suffix}`;
  let created = false;
  try {
    const server = await pool.query(
      "SELECT current_setting('server_version_num')::integer AS version, host(inet_server_addr()) AS address",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "this qualification requires PostgreSQL 17");
    if (endpoint.socket) assert.equal(server.rows[0].address, null);
    else assert.ok(["127.0.0.1", "::1"].includes(server.rows[0].address));
    await pool.query(`CREATE SCHEMA "${primarySchema}"`);
    created = true;
    await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool });
    const pendingStaged = await pendingStagedPrimaryMigrations();
    const applyStaged = () => applyStagedPrimaryMigrations(pool, primarySchema, pendingStaged);
    if (staged) await applyStaged();
    return await operation({
      pool,
      admissionPool,
      primarySchema,
      schema: { primarySchema, ledgerSchema },
      table: `"${primarySchema}"."postgres_rate_limit_buckets"`,
      applyStaged,
      unloggedIsStaged: pendingStaged.includes("0048_rate_limit_buckets_unlogged.sql"),
    });
  } finally {
    await admissionPool.end();
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${primarySchema}" CASCADE`);
    await pool.end();
  }
}

function limiterOptions(schema, name, limit = 20) {
  return {
    ...schema,
    name,
    limit,
    periodSeconds: PERIOD_SECONDS,
    keyHashSecret: randomBytes(32),
  };
}

function syntheticRequest() {
  return new Request("https://synthetic.invalid/api/v1/enroll", { method: "POST" });
}

/** Hold FOR UPDATE on every bucket of one limiter until release() is awaited. */
async function holdLimiterRows(pool, table, limiterName) {
  const client = await pool.connect();
  await client.query("BEGIN");
  const locked = await client.query(
    `SELECT key_digest FROM ${table} WHERE limiter_name=$1 FOR UPDATE`,
    [limiterName],
  );
  let released = false;
  return {
    rows: locked.rowCount,
    async release() {
      if (released) return;
      released = true;
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    },
  };
}

function assertApiError(error, status, code) {
  assert.equal(error?.name, "ApiError");
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  assert.equal(new Headers(error.responseHeaders ?? undefined).get("retry-after"), "60");
  const response = errors.errorResponse(error, "00000000-0000-4000-8000-000000000000");
  assert.equal(response.status, status);
  assert.equal(response.headers.get("retry-after"), "60");
  return true;
}

/** Scripted structural pool that records the exact statements a limiter issues. */
function recordingPool() {
  const statements = [];
  const pool = {
    statements,
    releases: [],
    async connect() {
      return {
        async query(text, values) {
          statements.push(values === undefined ? { text } : { text, values: [...values] });
          if (/FOR UPDATE$/u.test(text.trim())) {
            return { rows: [{ window_started_at_ms: "1000", used_count: 0 }], rowCount: 1 };
          }
          if (/AS now_ms/u.test(text)) return { rows: [{ now_ms: "2000" }], rowCount: 1 };
          if (/SET used_count=used_count\+1/u.test(text)) return { rows: [], rowCount: 1 };
          if (/count\(\*\)::integer AS purged/u.test(text)) return { rows: [{ purged: 3 }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        release(discard) {
          pool.releases.push(discard);
        },
      };
    },
  };
  return pool;
}

test("limiter transaction bounds default to the shared helper and pass through when configured", async () => {
  const schema = { primarySchema: "synthetic_primary", ledgerSchema: "synthetic_ledger" };
  const secret = randomBytes(32);
  const options = { ...schema, name: "UPLOAD_AUTHORIZATION", limit: 3, periodSeconds: 60, keyHashSecret: secret };

  const defaultPool = recordingPool();
  const defaults = new rateLimit.PostgresRateLimiter(defaultPool, options);
  assert.deepEqual(await defaults.limit({ key: "synthetic-key" }), { success: true });
  const emptyPool = recordingPool();
  const empty = rateLimit.createPostgresRateLimiter(emptyPool, options, {});
  assert.deepEqual(await empty.limit({ key: "synthetic-key" }), { success: true });
  assert.deepEqual(emptyPool.statements, defaultPool.statements,
    "an options object without timeouts issues the identical statement sequence");
  assert.deepEqual(defaultPool.statements.slice(0, 3), [
    { text: "BEGIN" },
    { text: "SET LOCAL statement_timeout='10000ms'" },
    { text: "SET LOCAL lock_timeout='5000ms'" },
  ]);
  assert.equal(defaultPool.statements.at(-1)?.text, "COMMIT");
  assert.deepEqual(defaultPool.releases, [false]);

  const boundedPool = recordingPool();
  const bounded = rateLimit.createPostgresRateLimiter(
    boundedPool,
    options,
    rateLimit.POSTGRES_ADMISSION_LIMITER_TRANSACTION_OPTIONS,
  );
  assert.deepEqual(await bounded.limit({ key: "synthetic-key" }), { success: true });
  assert.deepEqual({ ...rateLimit.POSTGRES_ADMISSION_LIMITER_TRANSACTION_OPTIONS }, {
    statementTimeoutMilliseconds: 2_000,
    lockTimeoutMilliseconds: 1_000,
  });
  assert.equal(Object.isFrozen(rateLimit.POSTGRES_ADMISSION_LIMITER_TRANSACTION_OPTIONS), true);
  assert.deepEqual(boundedPool.statements.slice(0, 3), [
    { text: "BEGIN" },
    { text: "SET LOCAL statement_timeout='2000ms'" },
    { text: "SET LOCAL lock_timeout='1000ms'" },
  ]);
  assert.deepEqual(boundedPool.statements.slice(3), defaultPool.statements.slice(3),
    "only the transaction bounds differ; the limiter SQL and bind values are unchanged");

  const lockOnlyPool = recordingPool();
  await new rateLimit.PostgresRateLimiter(lockOnlyPool, options, { lockTimeoutMilliseconds: 750 })
    .limit({ key: "synthetic-key" });
  assert.deepEqual(lockOnlyPool.statements.slice(1, 3), [
    { text: "SET LOCAL statement_timeout='10000ms'" },
    { text: "SET LOCAL lock_timeout='750ms'" },
  ]);

  for (const invalid of [
    null,
    "1000",
    { lockTimeoutMilliseconds: 0 },
    { lockTimeoutMilliseconds: 600_001 },
    { lockTimeoutMilliseconds: 1.5 },
    { lockTimeoutMilliseconds: "1000" },
    { statementTimeoutMilliseconds: -1 },
    { statementTimeoutMilliseconds: Number.NaN },
  ]) {
    assert.throws(() => rateLimit.createPostgresRateLimiter(recordingPool(), options, invalid),
      /Invalid PostgreSQL rate limiter configuration/u);
  }
});

test("bucket purge validates its bounds before any database work and binds only closed values", async () => {
  const pool = recordingPool();
  const schema = { primarySchema: "synthetic_primary", ledgerSchema: "synthetic_ledger" };
  const periods = { UPLOAD_AUTHORIZATION: 60, UPLOAD_PRINCIPAL: 60 };
  for (const options of [
    null,
    { periodSecondsByLimiterName: {} },
    { periodSecondsByLimiterName: null },
    { periodSecondsByLimiterName: { lowercase: 60 } },
    { periodSecondsByLimiterName: { UPLOAD_AUTHORIZATION: 0 } },
    { periodSecondsByLimiterName: { UPLOAD_AUTHORIZATION: 86_401 } },
    { periodSecondsByLimiterName: periods, maxRows: 0 },
    { periodSecondsByLimiterName: periods, maxRows: 10_001 },
    { periodSecondsByLimiterName: periods, maxRows: 2.5 },
    { periodSecondsByLimiterName: periods, nowEpoch: -1 },
    { periodSecondsByLimiterName: periods, nowEpoch: Number.NaN },
  ]) {
    await assert.rejects(
      rateLimit.purgeExpiredPostgresRateLimitBuckets(pool, schema, options),
      /Invalid PostgreSQL rate limiter configuration/u,
    );
  }
  await assert.rejects(
    rateLimit.purgeExpiredPostgresRateLimitBuckets(pool, { primarySchema: "pg_catalog" }, {
      periodSecondsByLimiterName: periods,
    }),
    TypeError,
  );
  assert.equal(pool.statements.length, 0);

  assert.equal(await rateLimit.purgeExpiredPostgresRateLimitBuckets(pool, schema, {
    nowEpoch: 1_800_000_000_000,
    periodSecondsByLimiterName: periods,
  }), 3);
  const purge = pool.statements.find((statement) => /AS purged/u.test(statement.text));
  assert.match(purge.text, /"synthetic_primary"\."postgres_rate_limit_buckets"/u);
  assert.match(purge.text, /FOR UPDATE OF bucket SKIP LOCKED/u);
  assert.deepEqual(purge.values, [
    ["UPLOAD_AUTHORIZATION", "UPLOAD_PRINCIPAL"],
    [60, 60],
    1_800_000_000_000,
    86_400,
    rateLimit.POSTGRES_RATE_LIMIT_PURGE_DEFAULT_MAX_ROWS,
  ]);
  assert.equal(rateLimit.POSTGRES_RATE_LIMIT_PURGE_DEFAULT_MAX_ROWS, 5_000);
});

test("PostgreSQL 17 migration 0048 makes the limiter buckets unlogged without changing limiter outcomes", {
  skip: SKIP_POSTGRES,
  timeout: 120_000,
}, async () => {
  await withLimiterSchema(async ({
    pool, admissionPool, primarySchema, schema, table, applyStaged, unloggedIsStaged,
  }) => {
    const persistence = async () => (await pool.query(
      `SELECT relation.relname, relation.relpersistence
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        WHERE namespace.nspname=$1
          AND relation.relname IN ('postgres_rate_limit_buckets',
                                   'postgres_rate_limit_buckets_pkey',
                                   'postgres_rate_limit_buckets_expiry')
        ORDER BY relation.relname`,
      [primarySchema],
    )).rows.map((row) => `${row.relname}:${row.relpersistence}`);
    if (unloggedIsStaged) {
      assert.deepEqual(await persistence(), [
        "postgres_rate_limit_buckets:p",
        "postgres_rate_limit_buckets_expiry:p",
        "postgres_rate_limit_buckets_pkey:p",
      ], "before 0048 the stock migrations leave the table logged");
    }

    const limiter = rateLimit.createPostgresRateLimiter(admissionPool, limiterOptions(schema, "UPLOAD_PRINCIPAL", 2));
    assert.deepEqual(await limiter.limit({ key: "synthetic-principal" }), { success: true });
    await applyStaged();
    assert.deepEqual(await persistence(), [
      "postgres_rate_limit_buckets:u",
      "postgres_rate_limit_buckets_expiry:u",
      "postgres_rate_limit_buckets_pkey:u",
    ]);
    const columns = await pool.query(
      `SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) AS shape
         FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='postgres_rate_limit_buckets'`,
      [primarySchema],
    );
    assert.equal(columns.rows[0].shape,
      "limiter_name:text,key_digest:text,window_started_at:timestamp with time zone,used_count:integer");

    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count, 1,
      "SET UNLOGGED preserves existing bucket rows");
    assert.deepEqual(await limiter.limit({ key: "synthetic-principal" }), { success: true });
    assert.deepEqual(await limiter.limit({ key: "synthetic-principal" }), { success: false });
    assert.deepEqual(await limiter.limit({ key: "synthetic-other-principal" }), { success: true });
  }, { staged: false });
});

test("PostgreSQL 17 a locked coarse bucket fails a 1000 ms-lock limiter fast as the existing 503 outcome", {
  skip: SKIP_POSTGRES,
  timeout: 120_000,
}, async () => {
  await withLimiterSchema(async ({ pool, admissionPool, schema, table }) => {
    const bounds = rateLimit.POSTGRES_ADMISSION_LIMITER_TRANSACTION_OPTIONS;
    const coarse = rateLimit.createPostgresRateLimiter(admissionPool, limiterOptions(schema, "ENROLLMENT"), bounds);
    const client = rateLimit.createPostgresRateLimiter(admissionPool, limiterOptions(schema, "CLIENT_ATTEMPT"), bounds);
    await admission.assertAttemptAllowed(coarse, client, syntheticRequest(), SYNTHETIC_ENV, "enrollment");

    const holder = await holdLimiterRows(pool, table, "ENROLLMENT");
    try {
      assert.equal(holder.rows, 1, "the enrollment coarse key is one global bucket");
      const started = performance.now();
      await assert.rejects(
        admission.assertAttemptAllowed(coarse, client, syntheticRequest(), SYNTHETIC_ENV, "enrollment"),
        (error) => assertApiError(error, 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE"),
      );
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 900, `the limiter waited for its lock timeout (${Math.round(elapsed)} ms)`);
      assert.ok(elapsed < 1_500, `the limiter failed within about 1.5 s (${Math.round(elapsed)} ms)`);

      // The mechanism is the bounded lock wait, surfaced as a sanitized timeout.
      await assert.rejects(
        coarse.limit({ key: "usage-monitor:enrollment:global" }),
        (error) => error?.name === "PostgresStorageError" && error.code === "timeout"
          && error.message === "POSTGRES_TIMEOUT:rate_limit.limit",
      );
    } finally {
      await holder.release();
    }
    const counts = await pool.query(
      `SELECT limiter_name, used_count FROM ${table} ORDER BY limiter_name`,
    );
    assert.deepEqual(counts.rows.map((row) => `${row.limiter_name}:${row.used_count}`), [
      "CLIENT_ATTEMPT:1",
      "ENROLLMENT:1",
    ], "timed-out attempts roll back and never consume the client bucket");

    // After topology (a) the identity-keyed origin-tier buckets stay in
    // PostgreSQL; their coarse key fails the same way through the upload path.
    const uploadCoarse = rateLimit.createPostgresRateLimiter(
      admissionPool, limiterOptions(schema, "UPLOAD_AUTHORIZATION"), bounds);
    const uploadPrincipal = rateLimit.createPostgresRateLimiter(
      admissionPool, limiterOptions(schema, "UPLOAD_PRINCIPAL"), bounds);
    await admission.assertUploadAuthorizationAllowed(
      uploadCoarse, uploadPrincipal, "synthetic-principal", SYNTHETIC_ENV);
    const uploadHolder = await holdLimiterRows(pool, table, "UPLOAD_AUTHORIZATION");
    try {
      assert.equal(uploadHolder.rows, 1);
      const started = performance.now();
      await assert.rejects(
        admission.assertUploadAuthorizationAllowed(
          uploadCoarse, uploadPrincipal, "synthetic-principal", SYNTHETIC_ENV),
        (error) => assertApiError(error, 503, "UPLOAD_INGRESS_UNAVAILABLE"),
      );
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 900 && elapsed < 1_500, `upload limiter failed in ${Math.round(elapsed)} ms`);
    } finally {
      await uploadHolder.release();
    }
    await admission.assertUploadAuthorizationAllowed(
      uploadCoarse, uploadPrincipal, "synthetic-principal", SYNTHETIC_ENV);
  });
});

test("PostgreSQL 17 a limiter without options keeps waiting on the shared default lock timeout", {
  skip: SKIP_POSTGRES,
  timeout: 120_000,
}, async () => {
  await withLimiterSchema(async ({ pool, admissionPool, schema, table }) => {
    const coarse = rateLimit.createPostgresRateLimiter(admissionPool, limiterOptions(schema, "RECOVERY"));
    const client = rateLimit.createPostgresRateLimiter(admissionPool, limiterOptions(schema, "CLIENT_ATTEMPT"));
    await admission.assertAttemptAllowed(coarse, client, syntheticRequest(), SYNTHETIC_ENV, "recovery");
    const holder = await holdLimiterRows(pool, table, "RECOVERY");
    let settled = false;
    let pending;
    try {
      pending = admission.assertAttemptAllowed(coarse, client, syntheticRequest(), SYNTHETIC_ENV, "recovery")
        .finally(() => { settled = true; });
      await delay(1_700);
      assert.equal(settled, false, "without bounds the limiter is still queued behind the lock");
    } finally {
      await holder.release();
    }
    await pending;
    const counts = await pool.query(`SELECT limiter_name, used_count FROM ${table} ORDER BY limiter_name`);
    assert.deepEqual(counts.rows.map((row) => `${row.limiter_name}:${row.used_count}`), [
      "CLIENT_ATTEMPT:2",
      "RECOVERY:2",
    ]);
  });
});

test("PostgreSQL 17 bucket purge removes rows past twice their window, is bounded, idempotent and skips locked rows", {
  skip: SKIP_POSTGRES,
  timeout: 120_000,
}, async () => {
  await withLimiterSchema(async ({ pool, schema, table }) => {
    const nowEpoch = Date.UTC(2026, 8, 26, 12);
    const seconds = (value) => nowEpoch - value * 1_000;
    let sequence = 0;
    const digest = () => createHash("sha256").update(`synthetic-bucket-${sequence += 1}`).digest("hex");
    const fixtures = [
      // [limiter name, window start, expected to be purged]
      ["UPLOAD_AUTHORIZATION", seconds(121), true],
      ["UPLOAD_AUTHORIZATION", seconds(600), true],
      ["UPLOAD_AUTHORIZATION", seconds(120), false],
      ["UPLOAD_AUTHORIZATION", seconds(61), false],
      ["UPLOAD_PRINCIPAL", seconds(7_201), true],
      ["UPLOAD_PRINCIPAL", seconds(7_200), false],
      ["UPLOAD_PRINCIPAL", seconds(3_601), false],
      // Unknown limiters fall back to the largest allowed period (86400 s).
      ["RETIRED_LIMITER", seconds(172_801), true],
      ["RETIRED_LIMITER", seconds(172_800), false],
      ["RETIRED_LIMITER", seconds(7_201), false],
    ];
    const keys = fixtures.map(() => digest());
    for (const [index, [name, started]] of fixtures.entries()) {
      await pool.query(
        `INSERT INTO ${table}(limiter_name,key_digest,window_started_at,used_count)
         VALUES ($1,$2,to_timestamp($3::double precision/1000.0),1)`,
        [name, keys[index], started],
      );
    }
    const extraExpired = Array.from({ length: 4 }, () => digest());
    for (const key of extraExpired) {
      await pool.query(
        `INSERT INTO ${table}(limiter_name,key_digest,window_started_at,used_count)
         VALUES ('UPLOAD_AUTHORIZATION',$1,to_timestamp($2::double precision/1000.0),1)`,
        [key, seconds(3_600)],
      );
    }
    const periodSecondsByLimiterName = { UPLOAD_AUTHORIZATION: 60, UPLOAD_PRINCIPAL: 3_600 };
    const purge = (options = {}) => rateLimit.purgeExpiredPostgresRateLimitBuckets(pool, schema, {
      nowEpoch,
      periodSecondsByLimiterName,
      ...options,
    });

    // Hold one expired bucket as an in-flight admission would.
    const lockedKey = extraExpired[0];
    const holderClient = await pool.connect();
    let heldReleased = false;
    const releaseHeld = async () => {
      if (heldReleased) return;
      heldReleased = true;
      try {
        await holderClient.query("ROLLBACK");
      } finally {
        holderClient.release();
      }
    };
    try {
      await holderClient.query("BEGIN");
      await holderClient.query(`SELECT 1 FROM ${table} WHERE key_digest=$1 FOR UPDATE`, [lockedKey]);

      const started = performance.now();
      assert.equal(await purge({ maxRows: 3 }), 3, "one call deletes at most maxRows");
      assert.equal(await purge({ maxRows: 3 }), 3);
      assert.equal(await purge({ maxRows: 3 }), 1);
      assert.equal(await purge({ maxRows: 3 }), 0, "a locked expired bucket is skipped, not waited for");
      assert.ok(performance.now() - started < 1_000, "SKIP LOCKED never queues behind an admission");
    } finally {
      await releaseHeld();
    }
    assert.equal(await purge(), 1, "the skipped bucket is purged by a later pass");
    assert.equal(await purge(), 0, "a repeated purge is a no-op");

    const remaining = new Set((await pool.query(`SELECT key_digest FROM ${table}`)).rows
      .map((row) => row.key_digest));
    for (const [index, [name, , purged]] of fixtures.entries()) {
      assert.equal(remaining.has(keys[index]), !purged, `${name} fixture ${index}`);
    }
    for (const key of extraExpired) assert.equal(remaining.has(key), false);
    assert.equal(remaining.size, 6);
  });
});
