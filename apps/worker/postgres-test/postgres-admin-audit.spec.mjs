import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { renderPostgresSearchPath } from "../scripts/postgres-migrations.mjs";
import { applyMigrationsBefore } from "./promoted-migration-prefix.mjs";

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 0050 is promoted (claude/gcp-fastpath-base): each schema receives the
// promoted chain below 0050, then the promoted 0050 file itself.
const STAGED_NAME = "0050_admin_audit_and_collection_controls.sql";
const STAGED_PATH = resolve(WORKER_ROOT, "postgres/migrations/primary", STAGED_NAME);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// Computed by the unmodified Worker (admin-operations.ts beginAdminOperationWithId
// binding actor_identity_digest) and re-derived from it in the first test.
const WORKER_ACTOR_DIGEST_VECTORS = Object.freeze([
  Object.freeze({
    identityKey: "owner@example.invalid",
    digest: "d61c38cda6b7c1ab723161695272ed8cdcbfbd0c8cd0cbb0d4cddf2324f2b976",
  }),
  Object.freeze({
    identityKey: "ówner.synthetic@example.invalid",
    digest: "c272b934a7de72099a1654711cb87e01695509a8e462117633bfe4acd4922ce6",
  }),
  Object.freeze({
    identityKey: "0123456789abcdef".repeat(4),
    digest: "7a36eacc0eb2a2f4388132dae90c43cbce1595b31084583c2b4dcf5ad23c3935",
  }),
]);

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "admin audit tests require a loopback host or a private Unix socket");
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
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
  if (PG_TEST_HOST) return { host: PG_TEST_HOST, port: PG_TEST_PORT, socket: false };
  return null;
}

function q(schema, name) {
  assert.match(schema, /^[a-z_][a-z0-9_]{0,62}$/u);
  assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${schema}"."${name}"`;
}

async function withWorkerModules(operation) {
  const vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  try {
    return await operation({
      worker: await vite.ssrLoadModule("/src/admin-operations.ts"),
      audit: await vite.ssrLoadModule("/src/postgres-admin-audit.ts"),
    });
  } finally {
    await vite.close();
  }
}

/** A D1 stand-in that records the Worker's bound values. */
function recordingD1(changes = 1) {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      return {
        bind(...values) {
          statements.push({ sql, values });
          return { async run() { return { meta: { changes } }; } };
        },
      };
    },
  };
}

async function apiError(promise) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error?.name, "ApiError");
    return { status: error.status, code: error.code };
  }
  assert.fail("expected an ApiError");
}

function refusingPool() {
  return { async connect() { throw new Error("a refused request must not reach the database"); } };
}

function refusingClient() {
  return { async query() { throw new Error("a refused request must not reach the database"); } };
}

/** A plain TypeError with this exact message (never an ApiError). */
function typeErrorWith(message) {
  return (error) => {
    assert.equal(error?.name, "TypeError");
    assert.equal(error.message, message);
    assert.equal(error.status, undefined);
    return true;
  };
}

function isBodyInvalid(error) {
  return error?.name === "ApiError" && error.status === 400 && error.code === "BODY_INVALID";
}

test("PostgreSQL admin actor digest and bounded details are byte-identical to the Worker", async () => {
  await withWorkerModules(async ({ worker, audit }) => {
    assert.equal(audit.ADMIN_ACTOR_DOMAIN, "app-usagemonitor/admin-actor/v1\0");
    assert.deepEqual([...audit.POSTGRES_ADMIN_ACTIONS],
      ["set_collection_controls", "run_maintenance", "sync_distribution"]);
    for (const { identityKey, digest } of WORKER_ACTOR_DIGEST_VECTORS) {
      const d1 = recordingD1();
      const operationId = randomUUID();
      await worker.beginAdminOperationWithId(d1, operationId, identityKey, "run_maintenance",
        { task: "synthetic" }, 0);
      const [bound] = d1.statements;
      assert.deepEqual(bound.values, [
        operationId, "run_maintenance", digest, "{\"task\":\"synthetic\"}", "1970-01-01T00:00:00.000Z",
      ]);
      assert.equal(await audit.postgresAdminActorDigest(identityKey), digest);
    }

    // Details: the same serialization, the same 2000-character bound and the
    // same 400 BODY_INVALID on overflow or a non-serializable value.
    const atLimit = { note: "x".repeat(2000 - "{\"note\":\"\"}".length) };
    const overLimit = { note: "x".repeat(2001 - "{\"note\":\"\"}".length) };
    assert.equal(audit.boundedAuditDetails(atLimit).length, 2000);
    const d1 = recordingD1();
    await worker.beginAdminOperationWithId(d1, randomUUID(), "owner@example.invalid",
      "sync_distribution", atLimit, 0);
    assert.equal(d1.statements[0].values[3], audit.boundedAuditDetails(atLimit));
    for (const details of [overLimit, undefined, () => undefined]) {
      assert.deepEqual(await apiError(worker.beginAdminOperationWithId(recordingD1(), randomUUID(),
        "owner@example.invalid", "run_maintenance", details, 0)), { status: 400, code: "BODY_INVALID" });
      assert.throws(() => audit.boundedAuditDetails(details),
        (error) => error?.name === "ApiError" && error.status === 400 && error.code === "BODY_INVALID");
      assert.deepEqual(await apiError(audit.beginPostgresAdminOperation(refusingPool(), "synthetic_schema", {
        action: "run_maintenance", identityKey: "owner@example.invalid", details,
      })), { status: 400, code: "BODY_INVALID" });
    }

    // Caller-supplied operation ids follow the Worker's v4 UUID rule.
    for (const operationId of ["not-a-uuid", randomUUID().toUpperCase(), "00000000-0000-1000-8000-000000000000"]) {
      assert.deepEqual(await apiError(worker.beginAdminOperationWithId(recordingD1(), operationId,
        "owner@example.invalid", "run_maintenance", {}, 0)), { status: 400, code: "BODY_INVALID" });
      assert.deepEqual(await apiError(audit.beginPostgresAdminOperation(refusingPool(), "synthetic_schema", {
        operationId, action: "run_maintenance", identityKey: "owner@example.invalid", details: {},
      })), { status: 400, code: "BODY_INVALID" });
    }

    // The Worker's finish reports an unchanged row as storage unavailable.
    assert.deepEqual(await apiError(worker.finishAdminOperation(recordingD1(0), randomUUID(), "success", {})),
      { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });

    // Details that jsonb cannot represent (U+0000, an unpaired surrogate):
    // the Worker stores them, but 0050's participantDigest index cannot cast
    // them, so the PostgreSQL helpers refuse them for every action, in begin
    // and finish, before any database work. Escaped backslashes that only
    // look like such an escape, paired surrogates and other control
    // characters are ordinary details.
    for (const details of [
      { note: "a\u0000b" },
      { ["k\u0000"]: 1 },
      { note: "a\ud800b" },
      { note: "a\udbff" },
      { note: "\udc00a" },
      { note: "\\\u0000" },
      { nested: [{ note: "\\\\\ud800" }] },
    ]) {
      const d1 = recordingD1();
      await worker.beginAdminOperationWithId(d1, randomUUID(), "owner@example.invalid",
        "sync_distribution", details, 0);
      assert.equal(d1.statements[0].values[3], JSON.stringify(details), "the Worker stores these details");
      assert.throws(() => audit.boundedAuditDetails(details), isBodyInvalid);
      for (const action of audit.POSTGRES_ADMIN_ACTIONS) {
        assert.deepEqual(await apiError(audit.beginPostgresAdminOperation(refusingPool(), "synthetic_schema", {
          action, identityKey: "owner@example.invalid", details,
        })), { status: 400, code: "BODY_INVALID" });
        assert.deepEqual(await apiError(audit.beginPostgresAdminOperationInTransaction(refusingClient(),
          "synthetic_schema", { action, identityKey: "owner@example.invalid", details })),
        { status: 400, code: "BODY_INVALID" });
      }
      assert.deepEqual(await apiError(audit.finishPostgresAdminOperation(refusingPool(), "synthetic_schema", {
        operationId: randomUUID(), outcome: "success", details,
      })), { status: 400, code: "BODY_INVALID" });
      assert.deepEqual(await apiError(audit.finishPostgresAdminOperationInTransaction(refusingClient(),
        "synthetic_schema", { operationId: randomUUID(), outcome: "failure", details })),
      { status: 400, code: "BODY_INVALID" });
    }
    for (const details of [
      { note: "\\u0000" },
      { note: "\\\\u0000" },
      { note: "\\ud800" },
      { note: "😀" },
      { note: "\u0001\u001f\b\t" },
      { participantDigest: "d".repeat(64) },
    ]) {
      assert.equal(audit.boundedAuditDetails(details), JSON.stringify(details));
    }

    // Invalid inputs are refused before any database work with a plain
    // TypeError, from the pool and in-transaction variants alike: an action
    // outside the closed set, a non-string identity key, a non-canonical
    // instant, a non-object input, and a finish outcome that is not terminal.
    const validBegin = { action: "run_maintenance", identityKey: "owner@example.invalid", details: {} };
    for (const [input, message] of [
      [{ ...validBegin, action: "erase_everything" }, "invalid admin action"],
      [{ ...validBegin, action: undefined }, "invalid admin action"],
      [{ ...validBegin, identityKey: 42 }, "invalid admin identity key"],
      [{ ...validBegin, identityKey: undefined }, "invalid admin identity key"],
      [{ ...validBegin, nowIso: "2026-09-26T12:00:00Z" }, "invalid admin operation time"],
      [{ ...validBegin, nowIso: "2026-09-26" }, "invalid admin operation time"],
      [{ ...validBegin, nowIso: "2026-09-26T12:00:00.000+00:00" }, "invalid admin operation time"],
      [{ ...validBegin, nowIso: "not-a-time" }, "invalid admin operation time"],
      [{ ...validBegin, nowIso: Date.parse("2026-09-26T12:00:00.000Z") }, "invalid admin operation time"],
      [null, "invalid admin operation"],
    ]) {
      await assert.rejects(audit.beginPostgresAdminOperation(refusingPool(), "synthetic_schema", input),
        typeErrorWith(message));
      await assert.rejects(audit.beginPostgresAdminOperationInTransaction(refusingClient(), "synthetic_schema",
        input), typeErrorWith(message));
    }
    for (const [input, message] of [
      [{ operationId: randomUUID(), outcome: "started", details: {} }, "invalid admin operation outcome"],
      [{ operationId: randomUUID(), outcome: "SUCCESS", details: {} }, "invalid admin operation outcome"],
      [{ operationId: randomUUID(), outcome: undefined, details: {} }, "invalid admin operation outcome"],
      [null, "invalid admin operation"],
    ]) {
      await assert.rejects(audit.finishPostgresAdminOperation(refusingPool(), "synthetic_schema", input),
        typeErrorWith(message));
      await assert.rejects(audit.finishPostgresAdminOperationInTransaction(refusingClient(), "synthetic_schema",
        input), typeErrorWith(message));
    }
  });
});

async function connectPool(endpoint) {
  const pool = new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 6,
    connectionTimeoutMillis: 3_000,
  });
  const server = await pool.query(
    "SELECT current_setting('server_version_num')::integer AS version, host(inet_server_addr()) AS address",
  );
  assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "this qualification requires PostgreSQL 17");
  if (endpoint.socket) assert.equal(server.rows[0].address, null);
  else assert.ok(["127.0.0.1", "::1"].includes(server.rows[0].address));
  return pool;
}

/**
 * Apply the promoted primary migrations below 0050, then the promoted 0050
 * file in one transaction under the runner's search_path guard.
 */
async function createSchema(pool, schema, created, { beforeStaged } = {}) {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  created.push(schema);
  const before = await applyMigrationsBefore({ role: "primary", schema, pool, name: STAGED_NAME });
  assert.equal(before.target.version, 50);
  assert.equal(before.applied, before.prefix.length);
  if (beforeStaged !== undefined) await beforeStaged(schema);
  const sql = await readFile(STAGED_PATH, "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='60000ms'");
    await client.query("SET LOCAL lock_timeout='10000ms'");
    await client.query(renderPostgresSearchPath(schema));
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function rejectsWith(promise, sqlState, detail) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, sqlState);
    if (typeof detail === "string") assert.equal(error.message, detail);
    if (detail?.constraint !== undefined) assert.equal(error.constraint, detail.constraint);
    return true;
  });
}

test("0050 re-keys admin_action_audit as an append-only identity table and the audit helpers keep Worker semantics", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const endpoint = await localEndpoint();
  const pool = await connectPool(endpoint);
  const suffix = randomBytes(6).toString("hex");
  const schema = `aa0_audit_${suffix}`;
  const planSchema = `aa0_audit_plan_${suffix}`;
  const created = [];
  const digest = WORKER_ACTOR_DIGEST_VECTORS[0].digest;
  const legacyIds = [
    "00000000-0000-4000-8000-00000000000c",
    "00000000-0000-4000-8000-00000000000a",
    "00000000-0000-4000-8000-00000000000b",
  ];
  try {
    await withWorkerModules(async ({ worker, audit }) => {
      await createSchema(pool, schema, created, {
        // Pre-0050 rows (operation_id primary key) receive ids in creation
        // order, and the identity continues above them.
        beforeStaged: async (target) => {
          await pool.query(
            `INSERT INTO ${q(target, "admin_action_audit")}
               (operation_id, action, actor_identity_digest, outcome, details_json, created_at)
             VALUES ($1, 'run_maintenance', $4, 'success', '{}', '2026-09-03T00:00:00.000Z'),
                    ($2, 'set_collection_controls', $4, 'failure', '{}', '2026-09-01T00:00:00.000Z'),
                    ($3, 'sync_distribution', $4, 'started', '{}', '2026-09-02T00:00:00.000Z')`,
            [...legacyIds, digest],
          );
        },
      });
      const table = q(schema, "admin_action_audit");
      const backfilled = await pool.query(`SELECT id::text AS id, operation_id FROM ${table} ORDER BY id`);
      assert.deepEqual(backfilled.rows, [
        { id: "1", operation_id: legacyIds[1] },
        { id: "2", operation_id: legacyIds[2] },
        { id: "3", operation_id: legacyIds[0] },
      ]);

      // Shape: identity primary key, nullable UNIQUE operation_id, indexes
      // and the lifecycle triggers.
      const identity = await pool.query(
        `SELECT attidentity, attnotnull FROM pg_attribute
          WHERE attrelid = to_regclass($1) AND attname = 'id'`,
        [table],
      );
      assert.deepEqual(identity.rows, [{ attidentity: "d", attnotnull: true }]);
      const keys = await pool.query(
        `SELECT conname, contype, pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid = to_regclass($1) AND contype IN ('p', 'u')
          ORDER BY conname`,
        [table],
      );
      assert.deepEqual(keys.rows, [
        { conname: "admin_action_audit_operation_id_key", contype: "u", definition: "UNIQUE (operation_id)" },
        { conname: "admin_action_audit_pkey", contype: "p", definition: "PRIMARY KEY (id)" },
      ]);
      const indexes = await pool.query(
        "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'admin_action_audit' ORDER BY indexname",
        [schema],
      );
      assert.deepEqual(indexes.rows.map((row) => row.indexname), [
        "admin_action_audit_operation_id_key",
        "admin_action_audit_pkey",
        "admin_action_audit_recent",
        "admin_action_audit_started_participant",
      ]);
      assert.match(indexes.rows[2].indexdef, /\(created_at DESC, id DESC\)$/u);
      assert.match(indexes.rows[3].indexdef,
        /USING btree \(\(\(\(details_json\)::jsonb ->> 'participantDigest'::text\)\)\) WHERE \(\(outcome = 'started'::text\) AND \(action = 'run_maintenance'::text\)\)$/u);
      const triggers = await pool.query(
        `SELECT tgname, tgenabled FROM pg_trigger
          WHERE tgrelid = to_regclass($1) AND NOT tgisinternal ORDER BY tgname`,
        [table],
      );
      assert.deepEqual(triggers.rows, [
        { tgname: "admin_action_audit_lifecycle_guard", tgenabled: "O" },
        { tgname: "admin_action_audit_no_truncate", tgenabled: "O" },
      ]);

      // Column constraints: NULL operation_id (the D1 legacy import path) is
      // accepted any number of times; malformed ids, unknown actions and
      // over-long details are refused.
      const insert = (values) => pool.query(
        `INSERT INTO ${table} (operation_id, action, actor_identity_digest, outcome, details_json, created_at)
         VALUES ($1, $2, $3, $4, $5, clock_timestamp()) RETURNING id::text AS id`,
        values,
      );
      const firstNull = await insert([null, "run_maintenance", digest, "success", "{}"]);
      const secondNull = await insert([null, "set_collection_controls", digest, "failure", "{}"]);
      assert.equal(firstNull.rows[0].id, "4");
      assert.equal(secondNull.rows[0].id, "5");
      await rejectsWith(insert(["0".repeat(35), "run_maintenance", digest, "success", "{}"]),
        "23514", { constraint: "admin_action_audit_operation_id_check" });
      await rejectsWith(insert(["0".repeat(37), "run_maintenance", digest, "success", "{}"]),
        "23514", { constraint: "admin_action_audit_operation_id_check" });
      await rejectsWith(insert([randomUUID(), "erase_everything", digest, "success", "{}"]),
        "23514", { constraint: "admin_action_audit_action_check" });
      await rejectsWith(insert([randomUUID(), "run_maintenance", digest, "success", "x".repeat(2001)]),
        "23514", { constraint: "admin_action_audit_details_json_check" });
      assert.equal((await insert([randomUUID(), "run_maintenance", digest, "success", "x".repeat(2000)])).rowCount, 1);
      await rejectsWith(insert([legacyIds[0], "run_maintenance", digest, "success", "{}"]),
        "23505", { constraint: "admin_action_audit_operation_id_key" });
      const imported = await pool.query(
        `INSERT INTO ${table} (id, operation_id, action, actor_identity_digest, outcome, details_json, created_at)
         VALUES (100, NULL, 'sync_distribution', $1, 'success', '{}', '2026-01-01T00:00:00.000Z')
         RETURNING id::text AS id`,
        [digest],
      );
      assert.equal(imported.rows[0].id, "100");

      // The participantDigest index casts started run_maintenance details to
      // jsonb, so details jsonb refuses cannot be stored in that shape (the
      // reason the helpers refuse them); other rows store them as text.
      const nulDetails = JSON.stringify({ note: "a\u0000b" });
      const surrogateDetails = JSON.stringify({ note: "a\ud800b" });
      await rejectsWith(insert([randomUUID(), "run_maintenance", digest, "started", nulDetails]), "22P05");
      await rejectsWith(insert([randomUUID(), "run_maintenance", digest, "started", surrogateDetails]), "22P02");
      assert.equal((await insert([randomUUID(), "run_maintenance", digest, "success", nulDetails])).rowCount, 1);
      assert.equal((await insert([randomUUID(), "sync_distribution", digest, "started", surrogateDetails])).rowCount, 1);

      // begin (pool): a durable 'started' row with the Worker's bound values.
      const nowIso = "2026-09-26T12:00:00.000Z";
      const d1 = recordingD1();
      const workerOperationId = randomUUID();
      await worker.beginAdminOperationWithId(d1, workerOperationId, WORKER_ACTOR_DIGEST_VECTORS[0].identityKey,
        "run_maintenance", { participantDigest: "d".repeat(64) }, Date.parse(nowIso));
      const operationId = await audit.beginPostgresAdminOperation(pool, schema, {
        operationId: workerOperationId,
        action: "run_maintenance",
        identityKey: WORKER_ACTOR_DIGEST_VECTORS[0].identityKey,
        details: { participantDigest: "d".repeat(64) },
        nowIso,
      });
      assert.equal(operationId, workerOperationId);
      const observer = await pool.connect();
      try {
        const started = await observer.query(
          `SELECT operation_id, action, actor_identity_digest, details_json,
                  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at, outcome
             FROM ${table} WHERE operation_id = $1`,
          [operationId],
        );
        assert.deepEqual(started.rows, [{
          operation_id: d1.statements[0].values[0],
          action: d1.statements[0].values[1],
          actor_identity_digest: d1.statements[0].values[2],
          details_json: d1.statements[0].values[3],
          created_at: d1.statements[0].values[4],
          outcome: "started",
        }]);
      } finally {
        observer.release();
      }
      const generated = await audit.beginPostgresAdminOperation(pool, schema, {
        action: "sync_distribution",
        identityKey: WORKER_ACTOR_DIGEST_VECTORS[1].identityKey,
        details: {},
      });
      assert.match(generated, UUID_V4);
      assert.equal((await pool.query(`SELECT actor_identity_digest FROM ${table} WHERE operation_id=$1`,
        [generated])).rows[0].actor_identity_digest, WORKER_ACTOR_DIGEST_VECTORS[1].digest);
      assert.deepEqual(await apiError(audit.beginPostgresAdminOperation(pool, schema, {
        operationId, action: "run_maintenance", identityKey: "owner@example.invalid", details: {},
      })), { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
      assert.deepEqual(await apiError(audit.beginPostgresAdminOperation(pool, "Bad-Schema", {
        action: "run_maintenance", identityKey: "owner@example.invalid", details: {},
      })), { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });

      // The participant-erasure lease probe and the recent-actions list can
      // use their indexes. The id backfill above leaves HOT chains, so the
      // indexes 0050 builds on a populated table carry indcheckxmin and stay
      // unusable while any older snapshot is open on this shared cluster.
      // The planner proof therefore runs on a schema migrated with an empty
      // table, where the indexes are usable at once.
      await createSchema(pool, planSchema, created);
      const planTable = q(planSchema, "admin_action_audit");
      const checkXmin = await pool.query(
        "SELECT bool_or(indcheckxmin) AS pending FROM pg_index WHERE indrelid = to_regclass($1)",
        [planTable],
      );
      assert.equal(checkXmin.rows[0].pending, false);
      const leaseClient = await pool.connect();
      try {
        await leaseClient.query("BEGIN");
        await leaseClient.query("SET LOCAL enable_seqscan = off");
        const plan = await leaseClient.query(
          `EXPLAIN (FORMAT JSON)
           SELECT 1 FROM ${planTable}
            WHERE outcome = 'started' AND action = 'run_maintenance'
              AND (details_json::jsonb) ->> 'participantDigest' = $1
              AND created_at > $2::timestamptz`,
          ["d".repeat(64), "2026-09-26T11:55:00.000Z"],
        );
        assert.match(JSON.stringify(plan.rows), /admin_action_audit_started_participant/u);
        const recent = await leaseClient.query(
          `EXPLAIN (FORMAT JSON)
           SELECT action, outcome FROM ${planTable} ORDER BY created_at DESC, id DESC LIMIT 20`,
        );
        assert.match(JSON.stringify(recent.rows), /admin_action_audit_recent/u);
      } finally {
        await leaseClient.query("ROLLBACK");
        leaseClient.release();
      }

      // finish (pool): exactly one started row changes; a repeated or unknown
      // finish is 503, as in the Worker.
      await audit.finishPostgresAdminOperation(pool, schema, {
        operationId, outcome: "success", details: { participantDigest: "d".repeat(64), result: "done" },
      });
      assert.deepEqual((await pool.query(`SELECT outcome, details_json FROM ${table} WHERE operation_id=$1`,
        [operationId])).rows, [{
        outcome: "success",
        details_json: JSON.stringify({ participantDigest: "d".repeat(64), result: "done" }),
      }]);
      for (const target of [operationId, randomUUID(), "not-an-operation"]) {
        assert.deepEqual(await apiError(audit.finishPostgresAdminOperation(pool, schema, {
          operationId: target, outcome: "failure", details: {},
        })), { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
      }
      assert.deepEqual(await apiError(audit.finishPostgresAdminOperation(pool, schema, {
        operationId: generated, outcome: "failure", details: { note: "x".repeat(2001) },
      })), { status: 400, code: "BODY_INVALID" });
      assert.equal((await pool.query(`SELECT outcome FROM ${table} WHERE operation_id=$1`,
        [generated])).rows[0].outcome, "started");
      await audit.finishPostgresAdminOperationBestEffort(pool, schema, {
        operationId, outcome: "failure", details: {},
      });
      await audit.finishPostgresAdminOperationBestEffort(refusingPool(), schema, {
        operationId: generated, outcome: "failure", details: {},
      });
      assert.equal((await pool.query(`SELECT outcome FROM ${table} WHERE operation_id=$1`,
        [operationId])).rows[0].outcome, "success");
      await audit.finishPostgresAdminOperationBestEffort(pool, schema, {
        operationId: generated, outcome: "failure", details: { code: "SYNTHETIC" },
      });
      assert.equal((await pool.query(`SELECT outcome FROM ${table} WHERE operation_id=$1`,
        [generated])).rows[0].outcome, "failure");

      // Client-scoped variants join the caller's transaction: nothing is
      // durable until the caller commits, and a rollback leaves no row.
      for (const commit of [false, true]) {
        const client = await pool.connect();
        let inTransaction;
        let settled = false;
        try {
          await client.query("BEGIN");
          inTransaction = await audit.beginPostgresAdminOperationInTransaction(client, schema, {
            action: "set_collection_controls",
            identityKey: "owner@example.invalid",
            details: { expectedRevision: 1 },
            nowIso,
          });
          await audit.finishPostgresAdminOperationInTransaction(client, schema, {
            operationId: inTransaction, outcome: "success", details: { expectedRevision: 1, revision: 2 },
          });
          assert.deepEqual(await apiError(audit.finishPostgresAdminOperationInTransaction(client, schema, {
            operationId: inTransaction, outcome: "failure", details: {},
          })), { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
          assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE operation_id=$1`,
            [inTransaction])).rowCount, 0);
          await client.query(commit ? "COMMIT" : "ROLLBACK");
          settled = true;
        } finally {
          // A failed assertion must not return an open transaction to the
          // pool, where the schema cleanup could reuse it and be rolled back.
          if (!settled) await client.query("ROLLBACK").catch(() => undefined);
          client.release(!settled);
        }
        assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE operation_id=$1 AND outcome='success'`,
          [inTransaction])).rowCount, commit ? 1 : 0);
      }

      // Append-only lifecycle: DELETE and TRUNCATE are refused, terminal rows
      // are immutable, and a started row may change only its outcome and
      // details, and only to a terminal outcome.
      await rejectsWith(pool.query(`DELETE FROM ${table} WHERE operation_id=$1`, [operationId]),
        "P1005", "admin_action_audit_delete_refused");
      await rejectsWith(pool.query(`DELETE FROM ${table} WHERE operation_id IS NULL`),
        "P1005", "admin_action_audit_delete_refused");
      await rejectsWith(pool.query(`TRUNCATE ${table}`), "P1005", "admin_action_audit_truncate_refused");
      await rejectsWith(pool.query(`UPDATE ${table} SET outcome='failure' WHERE operation_id=$1`, [operationId]),
        "P1005", "admin_action_audit_transition_refused");
      await rejectsWith(pool.query(`UPDATE ${table} SET details_json='{}' WHERE operation_id=$1`, [operationId]),
        "P1005", "admin_action_audit_transition_refused");
      const pending = await audit.beginPostgresAdminOperation(pool, schema, {
        action: "run_maintenance", identityKey: "owner@example.invalid", details: {},
      });
      for (const change of [
        "details_json='{\"late\":true}'",
        "outcome='started'",
        "outcome='success', action='sync_distribution'",
        "outcome='success', actor_identity_digest=repeat('e', 64)",
        "outcome='success', created_at=created_at + interval '1 second'",
        "outcome='success', id=id + 1000",
      ]) {
        await rejectsWith(pool.query(`UPDATE ${table} SET ${change} WHERE operation_id=$1`, [pending]),
          "P1005", "admin_action_audit_transition_refused");
      }
      await rejectsWith(pool.query(`UPDATE ${table} SET outcome='success', operation_id=$2 WHERE operation_id=$1`,
        [pending, randomUUID()]), "P1005", "admin_action_audit_transition_refused");
      assert.equal((await pool.query(`SELECT outcome FROM ${table} WHERE operation_id=$1`,
        [pending])).rows[0].outcome, "started");

      // ON CONFLICT (operation_id) still upserts through the UNIQUE key: a
      // replayed begin does nothing, and a terminal upsert moves the started
      // row to its outcome on the same id.
      const upsertStarted = await pool.query(
        `INSERT INTO ${table} (operation_id, action, actor_identity_digest, outcome, details_json, created_at)
         VALUES ($1, 'run_maintenance', $2, 'started', '{}', clock_timestamp())
         ON CONFLICT (operation_id) DO NOTHING RETURNING id`,
        [pending, digest],
      );
      assert.equal(upsertStarted.rowCount, 0);
      const pendingId = (await pool.query(`SELECT id::text AS id FROM ${table} WHERE operation_id=$1`,
        [pending])).rows[0].id;
      const upsert = (target) => pool.query(
        `INSERT INTO ${table} (operation_id, action, actor_identity_digest, outcome, details_json, created_at)
         VALUES ($1, 'run_maintenance', $2, 'success', '{"upserted":true}', clock_timestamp())
         ON CONFLICT (operation_id) DO UPDATE
           SET outcome = EXCLUDED.outcome, details_json = EXCLUDED.details_json
         WHERE admin_action_audit.outcome = 'started'
         RETURNING id::text AS id, outcome`,
        [target, digest],
      );
      assert.deepEqual((await upsert(pending)).rows, [{ id: pendingId, outcome: "success" }]);
      assert.equal((await upsert(pending)).rowCount, 0, "a terminal row is not upserted again");
      const fresh = randomUUID();
      const inserted = (await upsert(fresh)).rows;
      assert.equal(inserted.length, 1);
      assert.ok(Number(inserted[0].id) > Number(pendingId));
    });
  } finally {
    for (const name of created.reverse()) {
      await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    }
    await pool.end();
  }
});
