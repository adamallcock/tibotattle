import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
  "0047_host_diagnostic_errors.sql",
]);
const DAY = 24 * 60 * 60 * 1_000;

let vite;
let diagnostics;

before(async () => {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  diagnostics = await vite.ssrLoadModule("/src/postgres-host-diagnostics.ts");
});

after(async () => {
  await vite?.close();
});

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "diagnostic tests require a loopback host or a private Unix socket");
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

/** Create an isolated primary schema with the stock and staged migrations. */
async function withDiagnosticsSchema(operation) {
  const endpoint = await localEndpoint();
  const pool = new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 10,
    connectionTimeoutMillis: 5_000,
  });
  const suffix = randomBytes(6).toString("hex");
  const primarySchema = `host_diagnostics_primary_${suffix}`;
  const ledgerSchema = `host_diagnostics_ledger_${suffix}`;
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
    await applyStagedPrimaryMigrations(pool, primarySchema, await pendingStagedPrimaryMigrations());
    return await operation({
      pool,
      primarySchema,
      schema: { primarySchema, ledgerSchema },
      table: `"${primarySchema}"."diagnostic_error_events"`,
    });
  } finally {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${primarySchema}" CASCADE`);
    await pool.end();
  }
}

function sampledRequestId() {
  return `${randomUUID().slice(0, -2)}00`;
}

function unsampledRequestId() {
  return `${randomUUID().slice(0, -2)}01`;
}

function refusingPool() {
  const pool = {
    connects: 0,
    async connect() {
      pool.connects += 1;
      throw new Error("synthetic connection refusal");
    },
  };
  return pool;
}

async function rowCount(pool, table) {
  return Number((await pool.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count);
}

async function assertCheckViolation(operation) {
  await assert.rejects(operation, (error) => error?.code === "23514");
}

test("the sampling rule refuses non-sampled and malformed events before any database work", async () => {
  const pool = refusingPool();
  const base = {
    requestId: sampledRequestId(),
    routeClass: "synthetic_route",
    code: "INTERNAL_ERROR",
    status: 500,
    occurredAt: Date.UTC(2026, 8, 1),
  };
  for (const event of [
    { ...base, status: 499 },
    { ...base, status: 404 },
    { ...base, status: 600 },
    { ...base, status: 500.5 },
    { ...base, status: "500" },
    { ...base, requestId: unsampledRequestId() },
    { ...base, requestId: base.requestId.toUpperCase() },
    { ...base, requestId: `${base.requestId.slice(0, 14)}1${base.requestId.slice(15)}` },
    { ...base, requestId: `${base.requestId.slice(0, 19)}c${base.requestId.slice(20)}` },
    { ...base, requestId: `${base.requestId}00` },
    { ...base, routeClass: "" },
    { ...base, routeClass: 7 },
    { ...base, code: "internal_error" },
    { ...base, code: "" },
    { ...base, occurredAt: Number.NaN },
    { ...base, occurredAt: -1 },
    null,
    undefined,
  ]) {
    assert.equal(await diagnostics.recordPostgresDiagnosticError(pool, undefined, event), false);
  }
  assert.equal(pool.connects, 0, "a refused event never opens a transaction");

  assert.equal(await diagnostics.recordPostgresDiagnosticError(pool, undefined, base), false,
    "an unavailable pool is swallowed and reported as not recorded");
  assert.equal(pool.connects, 1);
  assert.equal(await diagnostics.recordPostgresDiagnosticError(pool, { primarySchema: "pg_catalog" }, base), false,
    "an invalid schema is swallowed rather than thrown");
  assert.equal(await diagnostics.recordPostgresDiagnosticError(null, undefined, base), false);
  await assert.rejects(
    diagnostics.prunePostgresDiagnosticErrors(pool, undefined, Number.NaN),
    (error) => error?.name === "PostgresStorageError" && error.code === "invalid",
  );
});

test("PostgreSQL 17 diagnostic table enforces the closed Worker row contract", {
  skip: SKIP_POSTGRES,
  timeout: 120_000,
}, async () => {
  await withDiagnosticsSchema(async ({ pool, primarySchema, table }) => {
    const columns = await pool.query(
      `SELECT column_name, data_type, is_nullable, is_identity, identity_generation
         FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='diagnostic_error_events'
        ORDER BY ordinal_position`,
      [primarySchema],
    );
    assert.deepEqual(columns.rows.map((row) => ({ ...row })), [
      { column_name: "id", data_type: "bigint", is_nullable: "NO", is_identity: "YES", identity_generation: "BY DEFAULT" },
      { column_name: "request_id", data_type: "text", is_nullable: "NO", is_identity: "NO", identity_generation: null },
      { column_name: "route_class", data_type: "text", is_nullable: "NO", is_identity: "NO", identity_generation: null },
      { column_name: "error_code", data_type: "text", is_nullable: "NO", is_identity: "NO", identity_generation: null },
      { column_name: "status", data_type: "integer", is_nullable: "NO", is_identity: "NO", identity_generation: null },
      { column_name: "occurred_at", data_type: "timestamp with time zone", is_nullable: "NO", is_identity: "NO", identity_generation: null },
    ]);
    const indexes = await pool.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname=$1 AND tablename='diagnostic_error_events' ORDER BY indexname`,
      [primarySchema],
    );
    assert.deepEqual(indexes.rows.map((row) => row.indexname), [
      "diagnostic_error_events_pkey",
      "diagnostic_error_events_recent",
      "diagnostic_error_events_request",
    ]);
    assert.match(indexes.rows[1].indexdef, /\(occurred_at DESC, id DESC\)$/u);
    assert.match(indexes.rows[2].indexdef, /\(request_id, occurred_at DESC\)$/u);
    const grants = await pool.query(
      `SELECT count(*)::integer AS count FROM information_schema.role_table_grants
        WHERE table_schema=$1 AND table_name='diagnostic_error_events' AND grantee <> current_user`,
      [primarySchema],
    );
    assert.equal(grants.rows[0].count, 0, "the migration grants nothing");

    const valid = sampledRequestId();
    const insert = (requestId, routeClass, code, status) => pool.query(
      `INSERT INTO ${table}(request_id,route_class,error_code,status,occurred_at)
       VALUES ($1,$2,$3,$4,now())`,
      [requestId, routeClass, code, status],
    );
    await insert(valid, "r".repeat(80), "C".repeat(80), 599);
    await insert(unsampledRequestId(), "r", "INTERNAL_ERROR", 400);
    // The CHECK refuses what the writer refuses, independently of the writer.
    await assertCheckViolation(insert(valid.toUpperCase(), "r", "INTERNAL_ERROR", 500));
    await assertCheckViolation(insert(`${valid.slice(0, 14)}1${valid.slice(15)}`, "r", "INTERNAL_ERROR", 500));
    await assertCheckViolation(insert(`${valid.slice(0, 19)}c${valid.slice(20)}`, "r", "INTERNAL_ERROR", 500));
    await assertCheckViolation(insert("not-a-request-id", "r", "INTERNAL_ERROR", 500));
    await assertCheckViolation(insert(valid, "", "INTERNAL_ERROR", 500));
    await assertCheckViolation(insert(valid, "r".repeat(81), "INTERNAL_ERROR", 500));
    await assertCheckViolation(insert(valid, "r", "", 500));
    await assertCheckViolation(insert(valid, "r", "C".repeat(81), 500));
    await assertCheckViolation(insert(valid, "r", "internal_error", 500));
    await assertCheckViolation(insert(valid, "r", "INTERNAL ERROR", 500));
    await assertCheckViolation(insert(valid, "r", "INTERNAL_ERROR", 399));
    await assertCheckViolation(insert(valid, "r", "INTERNAL_ERROR", 600));

    // BY DEFAULT identity accepts an imported id, and generation continues.
    await pool.query(
      `INSERT INTO ${table}(id,request_id,route_class,error_code,status,occurred_at)
       VALUES (9001,$1,'imported','INTERNAL_ERROR',500,now())`,
      [sampledRequestId()],
    );
    assert.equal(await rowCount(pool, table), 3);
  });
});

test("PostgreSQL 17 concurrent sampled writers stop at exactly 256 rows and never write unsampled events", {
  skip: SKIP_POSTGRES,
  timeout: 120_000,
}, async () => {
  await withDiagnosticsSchema(async ({ pool, schema, table }) => {
    const occurredAt = Date.UTC(2026, 8, 20, 12);
    const results = await Promise.all(Array.from({ length: 300 }, (_, index) =>
      diagnostics.recordPostgresDiagnosticError(pool, schema, {
        requestId: sampledRequestId(),
        routeClass: `synthetic_route_${index % 3}`,
        code: "BACKEND_STORAGE_UNAVAILABLE",
        status: 503,
        occurredAt,
      })));
    assert.equal(results.filter((value) => value === true).length, 256);
    assert.equal(results.filter((value) => value === false).length, 44);
    assert.equal(await rowCount(pool, table), 256);
    assert.equal(diagnostics.POSTGRES_DIAGNOSTIC_MAX_EVENTS, 256);
    const stored = await pool.query(
      `SELECT count(DISTINCT request_id)::integer AS ids,
              bool_and(right(request_id, 2) = '00') AS sampled,
              bool_and(occurred_at = to_timestamp($1::double precision / 1000.0)) AS timed
         FROM ${table}`,
      [occurredAt],
    );
    assert.deepEqual({ ...stored.rows[0] }, { ids: 256, sampled: true, timed: true });

    // The cap is global: once full, even a valid sampled event is refused.
    assert.equal(await diagnostics.recordPostgresDiagnosticError(pool, schema, {
      requestId: sampledRequestId(), routeClass: "late", code: "INTERNAL_ERROR", status: 500, occurredAt,
    }), false);
    assert.equal(await rowCount(pool, table), 256);
  });

  await withDiagnosticsSchema(async ({ pool, schema, table }) => {
    const occurredAt = Date.UTC(2026, 8, 20, 12);
    const sampledId = sampledRequestId();
    for (const event of [
      { requestId: sampledId, routeClass: "r", code: "RATE_LIMITED", status: 499 },
      { requestId: sampledId, routeClass: "r", code: "NOT_FOUND", status: 404 },
      { requestId: unsampledRequestId(), routeClass: "r", code: "INTERNAL_ERROR", status: 500 },
      { requestId: sampledId.toUpperCase(), routeClass: "r", code: "INTERNAL_ERROR", status: 500 },
      { requestId: `${sampledId.slice(0, 14)}1${sampledId.slice(15)}`, routeClass: "r", code: "INTERNAL_ERROR", status: 500 },
      { requestId: "00000000-0000-0000-0000-000000000000", routeClass: "r", code: "INTERNAL_ERROR", status: 500 },
    ]) {
      assert.equal(await diagnostics.recordPostgresDiagnosticError(pool, schema, { ...event, occurredAt }), false);
    }
    assert.equal(await rowCount(pool, table), 0, "non-sampled statuses and ids write nothing");

    assert.equal(await diagnostics.recordPostgresDiagnosticError(pool, schema, {
      requestId: sampledId,
      routeClass: `route_${"x".repeat(100)}`,
      code: "E".repeat(100),
      status: 500,
      occurredAt,
    }), true);
    const row = (await pool.query(`SELECT request_id, route_class, error_code, status FROM ${table}`)).rows[0];
    assert.deepEqual({ ...row }, {
      request_id: sampledId,
      route_class: `route_${"x".repeat(74)}`,
      error_code: "E".repeat(80),
      status: 500,
    });
  });
});

test("PostgreSQL 17 recorder failure returns false and the prune is bounded to rows past 30 days", {
  skip: SKIP_POSTGRES,
  timeout: 120_000,
}, async () => {
  await withDiagnosticsSchema(async ({ pool, schema, table }) => {
    const nowEpoch = Date.UTC(2026, 8, 26, 12);
    const cutoff = nowEpoch - 30 * DAY;
    const old = cutoff - 1;
    await pool.query(
      `INSERT INTO ${table}(request_id,route_class,error_code,status,occurred_at)
       SELECT $1, 'old', 'INTERNAL_ERROR', 500,
              to_timestamp(($2::bigint - series)::double precision / 1000.0)
         FROM generate_series(0, 1004) AS series`,
      [sampledRequestId(), old],
    );
    await pool.query(
      `INSERT INTO ${table}(request_id,route_class,error_code,status,occurred_at)
       VALUES ($1,'boundary','INTERNAL_ERROR',500,to_timestamp($2::double precision / 1000.0)),
              ($1,'recent','INTERNAL_ERROR',500,to_timestamp($3::double precision / 1000.0))`,
      [sampledRequestId(), cutoff, nowEpoch - DAY],
    );
    assert.equal(await rowCount(pool, table), 1_007);

    assert.equal(await diagnostics.prunePostgresDiagnosticErrors(pool, schema, nowEpoch), 1_000,
      "one call deletes at most 1000 rows");
    assert.equal(await diagnostics.prunePostgresDiagnosticErrors(pool, schema, nowEpoch), 5);
    assert.equal(await diagnostics.prunePostgresDiagnosticErrors(pool, schema, nowEpoch), 0,
      "a repeated prune is a no-op");
    const kept = await pool.query(`SELECT route_class FROM ${table} ORDER BY route_class`);
    assert.deepEqual(kept.rows.map((row) => row.route_class), ["boundary", "recent"],
      "rows at or inside the 30-day boundary survive");

    await pool.query(`DROP TABLE ${table}`);
    let result;
    await assert.doesNotReject(async () => {
      result = await diagnostics.recordPostgresDiagnosticError(pool, schema, {
        requestId: sampledRequestId(),
        routeClass: "dropped",
        code: "INTERNAL_ERROR",
        status: 500,
        occurredAt: nowEpoch,
      });
    });
    assert.equal(result, false, "a failed insert is reported as not recorded");
    await assert.rejects(
      diagnostics.prunePostgresDiagnosticErrors(pool, schema, nowEpoch),
      (error) => error?.name === "PostgresStorageError" && !/diagnostic_error_events/u.test(error.message),
      "maintenance sees a sanitized prune failure",
    );
  });
});
