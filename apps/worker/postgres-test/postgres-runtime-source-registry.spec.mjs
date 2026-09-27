import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import {
  applyStockAndStagedMigrations,
  postgresTestEndpoint,
} from "./staged-migrations-harness.mjs";

const ENDPOINT = await postgresTestEndpoint();
const PG_TEST_PASSWORD = ENDPOINT?.password ?? process.env.PG_TEST_PASSWORD ?? "synthetic-local-only";
const STAGED_FILE = "0092_runtime_source_registry.sql";
const SOURCES = Object.freeze([
  Object.freeze({ id: "synthetic-runtime-source-a", namespace: "synthetic-runtime-namespace-a" }),
  Object.freeze({ id: "synthetic-runtime-source-b", namespace: "synthetic-runtime-namespace-b" }),
]);
const CAPTURED_AT = "2026-09-27T01:02:03.456Z";

function table(schema, name) {
  assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
  return '"' + schema + '"."' + name + '"';
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

test("0092 registers exact immutable runtime sources and constrains direct D1 cache analogues on local PG17", async (t) => {
  assert.ok(ENDPOINT, "set PG_TEST_SOCKET for this zero-skip PostgreSQL qualification");
  assert.match(process.env.PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.match(ENDPOINT.host, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);

  const schema = "runtime_source_registry_" + randomBytes(6).toString("hex");
  const quotedSchema = '"' + schema + '"';
  const pool = new pg.Pool({
    ...ENDPOINT,
    password: PG_TEST_PASSWORD,
    ssl: false,
    max: 3,
    connectionTimeoutMillis: 5_000,
    application_name: "runtime-source-registry-pg17-test",
    options: "-c search_path=" + schema + ",pg_catalog",
  });
  const q = (name) => table(schema, name);

  try {
    const server = await pool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr() IS NULL AS unix_socket",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "the staged migration is qualified on PostgreSQL 17");
    assert.equal(server.rows[0].unix_socket, true,
      "the staged migration uses a private local Unix socket");

    await pool.query("CREATE SCHEMA " + quotedSchema);
    const applied = await applyStockAndStagedMigrations({
      role: "primary",
      schema,
      pool,
      stagedFiles: [STAGED_FILE],
    });
    assert.equal(applied.stockApplied, 46, "the fixture starts from the complete primary chain through 0046");
    assert.deepEqual(applied.staged.map(({ version, name }) => [version, name]), [
      [92, STAGED_FILE],
    ]);
    assert.deepEqual(applied.promoted, []);

    await t.test("retains the exact three-field, version-1 registration shape", async () => {
      const columns = await pool.query(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns " +
        "WHERE table_schema=$1 AND table_name='analytics_runtime_sources' ORDER BY ordinal_position",
        [schema],
      );
      assert.deepEqual(columns.rows, [
        { column_name: "source_id", data_type: "text", is_nullable: "NO" },
        { column_name: "source_namespace", data_type: "text", is_nullable: "NO" },
        { column_name: "contract_version", data_type: "integer", is_nullable: "NO" },
      ]);

      const register = (sourceId, namespace, version = 1) => pool.query(
        "INSERT INTO " + q("analytics_runtime_sources") +
        " (source_id,source_namespace,contract_version) VALUES ($1,$2,$3)",
        [sourceId, namespace, version],
      );
      await expectCode(register("", "synthetic-namespace"), "23514");
      await expectCode(register("s".repeat(201), "synthetic-namespace"), "23514");
      await expectCode(register("source-" + String.fromCharCode(1), "synthetic-namespace"), "23514");
      await expectCode(register("synthetic-source", ""), "23514");
      await expectCode(register("synthetic-source", "n".repeat(201)), "23514");
      await expectCode(register("synthetic-source", "namespace-" + String.fromCharCode(1)), "23514");
      await expectCode(register("synthetic-source", "synthetic-namespace", 0), "23514");
      await expectCode(register("synthetic-source", "synthetic-namespace", 2), "23514");

      await register(SOURCES[0].id, SOURCES[0].namespace);
      await expectCode(register(SOURCES[0].id, SOURCES[0].namespace), "23505");
      await expectCode(register(SOURCES[0].id, "synthetic-conflicting-namespace"), "23505");
      await register(SOURCES[1].id, SOURCES[1].namespace);

      const rows = await pool.query(
        "SELECT source_id,source_namespace,contract_version FROM " +
        q("analytics_runtime_sources") + " ORDER BY source_id",
      );
      assert.deepEqual(rows.rows, [
        { source_id: SOURCES[0].id, source_namespace: SOURCES[0].namespace, contract_version: 1 },
        { source_id: SOURCES[1].id, source_namespace: SOURCES[1].namespace, contract_version: 1 },
      ]);
    });

    await t.test("validates source FKs for both current direct D1 cache analogues", async () => {
      const constraints = await pool.query(
        "SELECT child.relname AS table_name, constraint_row.convalidated, " +
        "pg_get_constraintdef(constraint_row.oid) AS definition " +
        "FROM pg_constraint constraint_row " +
        "JOIN pg_class child ON child.oid=constraint_row.conrelid " +
        "JOIN pg_namespace child_schema ON child_schema.oid=child.relnamespace " +
        "JOIN pg_class parent ON parent.oid=constraint_row.confrelid " +
        "JOIN pg_namespace parent_schema ON parent_schema.oid=parent.relnamespace " +
        "WHERE constraint_row.contype='f' AND child_schema.nspname=$1 " +
        "AND parent_schema.nspname=$1 AND parent.relname='analytics_runtime_sources' " +
        "ORDER BY child.relname",
        [schema],
      );
      assert.deepEqual(constraints.rows.map(({ table_name, convalidated }) => [table_name, convalidated]), [
        ["analytics_admin_metric_snapshots", true],
        ["analytics_admin_metrics_history_cache", true],
      ]);
      assert.ok(constraints.rows.every(({ definition }) =>
        definition === "FOREIGN KEY (source_id) REFERENCES analytics_runtime_sources(source_id)"));

      await expectCode(
        pool.query(
          "INSERT INTO " + q("analytics_admin_metric_snapshots") +
          " (source_id,captured_at,metrics_json) VALUES ($1,$2,'{}')",
          ["synthetic-unregistered-source", CAPTURED_AT],
        ),
        "23503",
      );
      await expectCode(
        pool.query(
          "INSERT INTO " + q("analytics_admin_metrics_history_cache") +
          " (source_id,source_epoch,generated_at,payload_json) VALUES ($1,1,$2,'{}')",
          ["synthetic-unregistered-source", CAPTURED_AT],
        ),
        "23503",
      );

      for (const source of SOURCES) {
        await pool.query(
          "INSERT INTO " + q("analytics_admin_metric_snapshots") +
          " (source_id,captured_at,metrics_json) VALUES ($1,$2,'{}')",
          [source.id, CAPTURED_AT],
        );
        await pool.query(
          "INSERT INTO " + q("analytics_admin_metrics_history_cache") +
          " (source_id,source_epoch,generated_at,payload_json) VALUES ($1,1,$2,'{}')",
          [source.id, CAPTURED_AT],
        );
      }
      const counts = await pool.query(
        "SELECT (SELECT count(*) FROM " + q("analytics_admin_metric_snapshots") +
        ")::integer AS snapshots, (SELECT count(*) FROM " +
        q("analytics_admin_metrics_history_cache") + ")::integer AS history",
      );
      assert.deepEqual(counts.rows[0], { snapshots: 2, history: 2 });
    });

    await t.test("refuses UPDATE, DELETE, and TRUNCATE even when no value changes", async () => {
      await expectCode(
        pool.query(
          "UPDATE " + q("analytics_runtime_sources") +
          " SET source_namespace=source_namespace WHERE source_id=$1",
          [SOURCES[0].id],
        ),
        "55000",
      );
      await expectCode(
        pool.query(
          "UPDATE " + q("analytics_runtime_sources") +
          " SET source_namespace=$2 WHERE source_id=$1",
          [SOURCES[0].id, "synthetic-replacement-namespace"],
        ),
        "55000",
      );
      await expectCode(
        pool.query(
          "DELETE FROM " + q("analytics_runtime_sources") + " WHERE source_id=$1",
          [SOURCES[0].id],
        ),
        "55000",
      );
      await expectCode(
        pool.query("TRUNCATE TABLE " + q("analytics_runtime_sources") + " CASCADE"),
        "55000",
      );

      const remaining = await pool.query(
        "SELECT count(*)::integer AS registrations FROM " + q("analytics_runtime_sources"),
      );
      assert.equal(remaining.rows[0].registrations, 2);
    });
  } finally {
    await pool.query("DROP SCHEMA IF EXISTS " + quotedSchema + " CASCADE").catch(() => {});
    await pool.end();
  }
});

test("0092 fails atomically when an existing admin-history row lacks a source registration", async () => {
  assert.ok(ENDPOINT, "set PG_TEST_SOCKET for this zero-skip PostgreSQL qualification");
  assert.match(process.env.PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  const schema = "runtime_source_registry_orphan_" + randomBytes(6).toString("hex");
  const quotedSchema = '"' + schema + '"';
  const pool = new pg.Pool({
    ...ENDPOINT,
    password: PG_TEST_PASSWORD,
    ssl: false,
    max: 3,
    connectionTimeoutMillis: 5_000,
    application_name: "runtime-source-registry-preflight-pg17-test",
    options: "-c search_path=" + schema + ",pg_catalog",
  });

  try {
    const server = await pool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr() IS NULL AS unix_socket",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17);
    assert.equal(server.rows[0].unix_socket, true);

    await pool.query("CREATE SCHEMA " + quotedSchema);
    const stock = await applyStockAndStagedMigrations({
      role: "primary",
      schema,
      pool,
      stagedFiles: [],
    });
    assert.equal(stock.stockApplied, 46);

    await pool.query(
      "INSERT INTO " + table(schema, "analytics_admin_metrics_history_cache") +
      " (source_id,source_epoch,generated_at,payload_json) VALUES ($1,1,$2,'{}')",
      ["synthetic-unregistered-legacy-source", CAPTURED_AT],
    );

    await assert.rejects(
      applyStockAndStagedMigrations({
        role: "primary",
        schema,
        pool,
        stagedFiles: [STAGED_FILE],
      }),
      (error) => {
        assert.equal(error?.code, "STAGED_MIGRATION_APPLY_FAILED");
        assert.equal(error?.migration, STAGED_FILE);
        assert.equal(error?.cause?.code, "23503",
          "validated FK creation must refuse the preexisting orphan");
        return true;
      },
    );

    const registry = await pool.query(
      "SELECT to_regclass($1) AS relation",
      [schema + ".analytics_runtime_sources"],
    );
    assert.equal(registry.rows[0].relation, null,
      "the failed staged transaction must not leave its registry table behind");
    const constraints = await pool.query(
      "SELECT count(*)::integer AS count FROM pg_constraint " +
      "WHERE connamespace=$1::regnamespace AND conname=ANY($2::text[])",
      [schema, [
        "analytics_admin_metric_snapshots_runtime_source_fk",
        "analytics_admin_metrics_history_cache_runtime_source_fk",
      ]],
    );
    assert.equal(constraints.rows[0].count, 0,
      "the failed staged transaction must not leave a partial FK");
    const legacy = await pool.query(
      "SELECT count(*)::integer AS count FROM " +
      table(schema, "analytics_admin_metrics_history_cache") +
      " WHERE source_id=$1",
      ["synthetic-unregistered-legacy-source"],
    );
    assert.equal(legacy.rows[0].count, 1,
      "the failed migration must preserve the existing row");
  } finally {
    await pool.query("DROP SCHEMA IF EXISTS " + quotedSchema + " CASCADE").catch(() => {});
    await pool.end();
  }
});
