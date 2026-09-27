import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { readPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import {
  applyStockAndStagedMigrations,
  listStagedMigrations,
  postgresTestEndpoint,
} from "./staged-migrations-harness.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_HOST = process.env.PG_TEST_HOST;
const SLICE = Object.freeze([
  Object.freeze({ version: 47, name: "0047_host_diagnostic_errors.sql" }),
  Object.freeze({ version: 48, name: "0048_rate_limit_buckets_unlogged.sql" }),
  Object.freeze({ version: 49, name: "0049_lifecycle_readiness_state.sql" }),
  Object.freeze({ version: 50, name: "0050_admin_audit_and_collection_controls.sql" }),
]);
const STAGED_FILES = Object.freeze(SLICE.map(migration => migration.name));

function table(schema, name) {
  assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
  return '"' + schema + '"."' + name + '"';
}

async function localPostgresPool() {
  assert.equal(PG_TEST_HOST, undefined,
    "Wave-1 migration qualification requires a private Unix socket, not TCP or a GCP test instance");
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  const endpoint = await postgresTestEndpoint();
  assert.ok(endpoint, "set PG_TEST_SOCKET for this zero-skip PG17 qualification");
  const pool = new pg.Pool({
    ...endpoint,
    password: process.env.PG_TEST_PASSWORD ?? "synthetic-local-only",
    ssl: false,
    max: 3,
    connectionTimeoutMillis: 5_000,
    application_name: "wave1-primary-migrations-pg17-test",
  });
  try {
    const result = await pool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr() IS NULL AS unix_socket",
    );
    assert.equal(Math.floor(result.rows[0].version / 10_000), 17,
      "the migration slice is qualified on PostgreSQL 17");
    assert.equal(result.rows[0].unix_socket, true,
      "the migration slice must use a local Unix socket");
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error?.code, code);
    return true;
  });
}

async function applySlice(pool, schema) {
  const applied = await applyStockAndStagedMigrations({
    role: "primary",
    schema,
    pool,
    stagedFiles: STAGED_FILES,
  });
  assert.deepEqual(
    [...applied.promoted, ...applied.staged.map(migration => migration.name)].sort(),
    [...STAGED_FILES].sort(),
  );
}

async function temporaryPrestateMigrationRoots() {
  const [stock, staged] = await Promise.all([
    readPostgresMigrations({ role: "primary" }),
    listStagedMigrations("primary"),
  ]);
  const stockThrough0046 = stock.filter(migration => migration.version <= 46);
  assert.equal(stockThrough0046.at(-1)?.version, 46);
  assert.equal(stockThrough0046.length, 46);
  const allByName = new Map();
  for (const migration of [...stock, ...staged]) {
    if (allByName.has(migration.name)) assert.fail("migration is both staged and promoted: " + migration.name);
    allByName.set(migration.name, migration);
  }
  const waveOne = SLICE.map(({ name }) => {
    const migration = allByName.get(name);
    assert.ok(migration, "missing Wave-1 migration source: " + name);
    return migration;
  });

  const stockRoot = await mkdtemp(join(tmpdir(), "tibotattle-wave1-stock-"));
  const stagedRoot = await mkdtemp(join(tmpdir(), "tibotattle-wave1-staged-"));
  try {
    await mkdir(join(stockRoot, "primary"));
    await mkdir(join(stagedRoot, "primary"));
    for (const migration of stockThrough0046) {
      await writeFile(join(stockRoot, "primary", migration.name), migration.sql, { flag: "wx" });
    }
    for (const migration of waveOne) {
      await writeFile(join(stagedRoot, "primary", migration.name), migration.sql, { flag: "wx" });
    }
    return { stockRoot, stagedRoot };
  } catch (error) {
    await Promise.all([
      rm(stockRoot, { recursive: true, force: true }),
      rm(stagedRoot, { recursive: true, force: true }),
    ]);
    throw error;
  }
}

test("Wave-1 PostgreSQL primary migrations 0047-0050 preserve their schema contracts on a local PG17 socket", async t => {
  const pool = await localPostgresPool();
  const schema = "wave1_primary_" + randomBytes(6).toString("hex");
  const quotedSchema = '"' + schema + '"';
  try {
    await pool.query("CREATE SCHEMA " + quotedSchema);
    await applySlice(pool, schema);

    await t.test("0047 stores only bounded, content-free diagnostic fields", async () => {
      const identity = await pool.query(
        "SELECT is_identity, identity_generation FROM information_schema.columns " +
        "WHERE table_schema = $1 AND table_name = 'diagnostic_error_events' AND column_name = 'id'",
        [schema],
      );
      assert.deepEqual(identity.rows[0], { is_identity: "YES", identity_generation: "BY DEFAULT" });

      const indexes = await pool.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'diagnostic_error_events' ORDER BY indexname",
        [schema],
      );
      assert.deepEqual(indexes.rows.map(row => row.indexname), [
        "diagnostic_error_events_pkey",
        "diagnostic_error_events_recent",
        "diagnostic_error_events_request",
      ]);

      const insert = (requestId, routeClass, errorCode, status) => pool.query(
        "INSERT INTO " + table(schema, "diagnostic_error_events") +
        " (request_id, route_class, error_code, status, occurred_at) VALUES ($1,$2,$3,$4,clock_timestamp())",
        [requestId, routeClass, errorCode, status],
      );
      await insert(randomUUID(), "public_read", "ORIGIN_UNAVAILABLE", 503);
      await expectCode(insert("not-a-v4-id", "public_read", "ORIGIN_UNAVAILABLE", 503), "23514");
      await expectCode(insert(randomUUID(), "", "ORIGIN_UNAVAILABLE", 503), "23514");
      await expectCode(insert(randomUUID(), "r".repeat(81), "ORIGIN_UNAVAILABLE", 503), "23514");
      await expectCode(insert(randomUUID(), "public_read", "origin_unavailable", 503), "23514");
      await expectCode(insert(randomUUID(), "public_read", "ORIGIN_UNAVAILABLE", 399), "23514");
      await expectCode(insert(randomUUID(), "public_read", "ORIGIN_UNAVAILABLE", 600), "23514");
    });

    await t.test("0048 makes limiter buckets and their indexes unlogged", async () => {
      const columns = await pool.query(
        "SELECT column_name FROM information_schema.columns " +
        "WHERE table_schema = $1 AND table_name = 'postgres_rate_limit_buckets' ORDER BY ordinal_position",
        [schema],
      );
      assert.deepEqual(columns.rows.map(row => row.column_name), [
        "limiter_name", "key_digest", "window_started_at", "used_count",
      ]);

      const persistence = await pool.query(
        "SELECT relation.relpersistence AS table_persistence, " +
        "bool_and(index_relation.relpersistence = 'u') AS indexes_unlogged, " +
        "count(index_relation.oid)::integer AS index_count " +
        "FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace " +
        "LEFT JOIN pg_index indexes ON indexes.indrelid = relation.oid " +
        "LEFT JOIN pg_class index_relation ON index_relation.oid = indexes.indexrelid " +
        "WHERE namespace.nspname = $1 AND relation.relname = 'postgres_rate_limit_buckets' " +
        "GROUP BY relation.relpersistence",
        [schema],
      );
      assert.deepEqual(persistence.rows[0], {
        table_persistence: "u",
        indexes_unlogged: true,
        index_count: 2,
      });
    });

    await t.test("0049 keeps restore replay values runtime-derived and seeds reconciliation", async () => {
      const retention = table(schema, "retention_state");
      const seed = await pool.query(
        "SELECT state, schema_version, quarantine_retention_complete, restore_replay_complete, " +
        "restored_participants_suppressed::integer AS suppressed " +
        "FROM " + retention + " WHERE singleton = 1",
      );
      assert.deepEqual(seed.rows[0], {
        state: "never_run",
        schema_version: "backend-retention-v0.1",
        quarantine_retention_complete: true,
        restore_replay_complete: true,
        suppressed: 0,
      });

      await pool.query(
        "UPDATE " + retention +
        " SET restore_replay_complete = false, restored_participants_suppressed = 3 WHERE singleton = 1",
      );
      const replay = await pool.query(
        "SELECT restore_replay_complete, restored_participants_suppressed::integer AS suppressed " +
        "FROM " + retention + " WHERE singleton = 1",
      );
      assert.deepEqual(replay.rows[0], { restore_replay_complete: false, suppressed: 3 });
      await expectCode(
        pool.query("UPDATE " + retention + " SET restored_participants_suppressed = -1 WHERE singleton = 1"),
        "23514",
      );
      await expectCode(
        pool.query("UPDATE " + retention + " SET failure_code = 'OTHER_FAILURE' WHERE singleton = 1"),
        "23514",
      );
      await expectCode(
        pool.query(
          "UPDATE " + retention +
          " SET state = 'failed', maintenance_run_at = '2026-09-27T12:34:56.123Z' WHERE singleton = 1",
        ),
        "23514",
      );
      await expectCode(
        pool.query(
          "UPDATE " + retention +
          " SET maintenance_run_at = '2026-09-27T12:34:56.123456Z' WHERE singleton = 1",
        ),
        "23514",
      );

      const reconciliation = await pool.query(
        "SELECT state, reconciliation_complete, registrations_examined::integer AS examined " +
        "FROM " + table(schema, "quarantine_reconciliation_state") + " WHERE singleton = 1",
      );
      assert.deepEqual(reconciliation.rows[0], {
        state: "never_run",
        reconciliation_complete: false,
        examined: 0,
      });
      const cursorColumns = await pool.query(
        "SELECT count(*)::integer AS count FROM information_schema.columns " +
        "WHERE table_schema = $1 AND table_name = 'quarantine_reconciliation_state' AND column_name LIKE '%cursor%'",
        [schema],
      );
      assert.equal(cursorColumns.rows[0].count, 0);
    });

    await t.test("0050 retains append-only audit and owner-erasure lease lookup", async () => {
      const controls = await pool.query(
        "SELECT revision::integer AS revision, control_state, enrollment_enabled, " +
        "upload_registration_enabled, processing_enabled, publication_enabled, reason_code " +
        "FROM " + table(schema, "collection_controls") + " WHERE singleton = 1",
      );
      assert.deepEqual(controls.rows[0], {
        revision: 1,
        control_state: "contained",
        enrollment_enabled: false,
        upload_registration_enabled: false,
        processing_enabled: false,
        publication_enabled: false,
        reason_code: "initial",
      });

      const audit = table(schema, "admin_action_audit");
      const columns = await pool.query(
        "SELECT column_name, is_nullable, is_identity, identity_generation " +
        "FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'admin_action_audit'",
        [schema],
      );
      const byName = new Map(columns.rows.map(row => [row.column_name, row]));
      assert.equal(byName.get("id")?.is_identity, "YES");
      assert.equal(byName.get("id")?.identity_generation, "BY DEFAULT");
      assert.equal(byName.get("operation_id")?.is_nullable, "YES");

      const leaseIndex = await pool.query(
        "SELECT indexdef FROM pg_indexes " +
        "WHERE schemaname = $1 AND tablename = 'admin_action_audit' " +
        "AND indexname = 'admin_action_audit_started_participant'",
        [schema],
      );
      assert.equal(leaseIndex.rowCount, 1);
      assert.match(leaseIndex.rows[0].indexdef, /details_json/u);
      assert.match(leaseIndex.rows[0].indexdef, /participantDigest/u);
      assert.match(leaseIndex.rows[0].indexdef, /run_maintenance/u);
      assert.match(leaseIndex.rows[0].indexdef, /started/u);

      const actor = "a".repeat(64);
      const participantDigest = "b".repeat(64);
      const operationId = "00000000-0000-4000-8000-000000000001";
      const started = await pool.query(
        "INSERT INTO " + audit +
        " (operation_id, action, actor_identity_digest, outcome, details_json, created_at) " +
        "VALUES ($1, 'run_maintenance', $2, 'started', $3, clock_timestamp()) " +
        "ON CONFLICT (operation_id) DO UPDATE SET outcome = EXCLUDED.outcome, details_json = EXCLUDED.details_json " +
        "RETURNING id::text AS id, outcome",
        [operationId, actor, JSON.stringify({ participantDigest })],
      );
      const leaseRow = await pool.query(
        "SELECT id::text AS id FROM " + audit +
        " WHERE outcome = 'started' AND action = 'run_maintenance' " +
        "AND details_json::jsonb ->> 'participantDigest' = $1",
        [participantDigest],
      );
      assert.equal(leaseRow.rowCount, 1);
      assert.equal(leaseRow.rows[0].id, started.rows[0].id);

      const finished = await pool.query(
        "INSERT INTO " + audit +
        " (operation_id, action, actor_identity_digest, outcome, details_json, created_at) " +
        "VALUES ($1, 'run_maintenance', $2, 'success', '{\"finished\":true}', clock_timestamp()) " +
        "ON CONFLICT (operation_id) DO UPDATE SET outcome = EXCLUDED.outcome, details_json = EXCLUDED.details_json " +
        "RETURNING id::text AS id, outcome",
        [operationId, actor],
      );
      assert.equal(finished.rows[0].id, started.rows[0].id);
      assert.equal(finished.rows[0].outcome, "success");

      const secondNullOperation = await pool.query(
        "INSERT INTO " + audit +
        " (operation_id, action, actor_identity_digest, outcome, details_json, created_at) " +
        "VALUES (NULL, 'sync_distribution', $1, 'success', '{}', clock_timestamp()) RETURNING id::text AS id",
        [actor],
      );
      const thirdNullOperation = await pool.query(
        "INSERT INTO " + audit +
        " (operation_id, action, actor_identity_digest, outcome, details_json, created_at) " +
        "VALUES (NULL, 'sync_distribution', $1, 'success', '{}', clock_timestamp()) RETURNING id::text AS id",
        [actor],
      );
      assert.notEqual(secondNullOperation.rows[0].id, thirdNullOperation.rows[0].id);

      const pending = await pool.query(
        "INSERT INTO " + audit +
        " (operation_id, action, actor_identity_digest, outcome, details_json, created_at) " +
        "VALUES ($1, 'run_maintenance', $2, 'started', '{}', clock_timestamp()) RETURNING id::text AS id",
        ["00000000-0000-4000-8000-000000000002", actor],
      );
      await expectCode(
        pool.query("UPDATE " + audit + " SET id = id + 1000 WHERE id::text = $1", [pending.rows[0].id]),
        "P1005",
      );
      await expectCode(
        pool.query("UPDATE " + audit + " SET outcome = 'failure' WHERE id::text = $1", [finished.rows[0].id]),
        "P1005",
      );
      await expectCode(pool.query("DELETE FROM " + audit + " WHERE id::text = $1", [finished.rows[0].id]), "P1005");
      await expectCode(pool.query("TRUNCATE " + audit), "P1005");

      const probe = table(schema, "collection_controls_contract_probe");
      await pool.query("CREATE TABLE " + probe + " (LIKE " + table(schema, "collection_controls") + " INCLUDING CONSTRAINTS)");
      const insertProbe = (state, flags, reason) => pool.query(
        "INSERT INTO " + probe +
        " (singleton, revision, control_state, enrollment_enabled, upload_registration_enabled, " +
        "processing_enabled, publication_enabled, reason_code, updated_at) " +
        "VALUES (1, 1, $1, $2, $3, $4, $5, $6, clock_timestamp())",
        [state, ...flags, reason],
      );
      await insertProbe("contained", [false, false, false, false], "initial");
      await expectCode(
        insertProbe("operational", [true, false, true, true], "maintenance"),
        "23514",
      );
      await expectCode(
        insertProbe("degraded", [true, false, true, true], "unknown_reason"),
        "23514",
      );
      await expectCode(
        insertProbe("contained", [false, false, false, false], null),
        "23502",
      );
    });

    await t.test("0050 refuses to relabel a changed controls row and rolls back", async () => {
      const failedSchema = "wave1_bad_controls_" + randomBytes(6).toString("hex");
      const failedQuotedSchema = '"' + failedSchema + '"';
      await pool.query("CREATE SCHEMA " + failedQuotedSchema);
      const migrationRoots = await temporaryPrestateMigrationRoots();
      try {
        const base = await applyStockAndStagedMigrations({
          role: "primary",
          schema: failedSchema,
          pool,
          stagedFiles: [],
          rootDirectory: migrationRoots.stockRoot,
          stagedRootDirectory: migrationRoots.stagedRoot,
        });
        await pool.query(
          "UPDATE " + table(failedSchema, "collection_controls") +
          " SET revision = 2 WHERE singleton = 1",
        );

        await assert.rejects(
          applyStockAndStagedMigrations({
            role: "primary",
            schema: failedSchema,
            pool,
            stagedFiles: STAGED_FILES,
            rootDirectory: migrationRoots.stockRoot,
            stagedRootDirectory: migrationRoots.stagedRoot,
          }),
          error => {
            assert.equal(error?.code, "STAGED_MIGRATION_APPLY_FAILED");
            assert.equal(error?.migration, SLICE[3].name);
            assert.equal(error?.cause?.code, "23502");
            return true;
          },
        );

        const auditId = await pool.query(
          "SELECT count(*)::integer AS count FROM information_schema.columns " +
          "WHERE table_schema = $1 AND table_name = 'admin_action_audit' AND column_name = 'id'",
          [failedSchema],
        );
        const controlsAfter = await pool.query(
          "SELECT revision::integer AS revision, reason_code FROM " +
          table(failedSchema, "collection_controls") + " WHERE singleton = 1",
        );
        assert.equal(auditId.rows[0].count, 0);
        assert.deepEqual(controlsAfter.rows[0], { revision: 2, reason_code: null });
        const receipts = await pool.query(
          "SELECT count(*)::integer AS count, max(version) AS tail FROM " +
          table(failedSchema, "_tibotattle_migration_history"),
        );
        assert.deepEqual(receipts.rows[0], { count: base.stockApplied, tail: base.stockApplied });
      } finally {
        await Promise.all([
          pool.query("DROP SCHEMA IF EXISTS " + failedQuotedSchema + " CASCADE").catch(() => {}),
          rm(migrationRoots.stockRoot, { recursive: true, force: true }),
          rm(migrationRoots.stagedRoot, { recursive: true, force: true }),
        ]);
      }
    });
  } finally {
    await pool.query("DROP SCHEMA IF EXISTS " + quotedSchema + " CASCADE").catch(() => {});
    await pool.end();
  }
});
