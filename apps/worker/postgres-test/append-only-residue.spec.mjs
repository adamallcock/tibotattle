/**
 * PG17 qualification of the primary append-only residue migration (LEAD-SIMP).
 *
 * The file is found by its OPS-10 suffix, and its name and number are final
 * (owner decision OD-1, 2026-10-02). Every case runs in its own database, so
 * the database-scoped PT-1 control schema (tibotattle_transfer) of the shared
 * test cluster is never altered. A template database holds the promoted chain
 * below the residue migration once; each upgrade case clones it.
 */

import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import {
  applyPostgresMigrations,
  migrationHistoryTable,
  readPostgresMigrations,
  renderPostgresSearchPath,
} from "../cloud-run/postgres-migrations.mjs";
import { applyMigrationsBefore } from "./promoted-migration-prefix.mjs";

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIMARY_DIRECTORY = join(WORKER_ROOT, "postgres", "migrations", "primary");
const RESIDUE_SUFFIX = "_append_only_residue.sql";
const RUN = randomBytes(4).toString("hex");
const SCHEMA = "w3_simp_app";
const SECOND_SCHEMA = "w3_simp_app_second";
const SOURCE = "w3-simp-source";
const NAMESPACE = "w3-simp-namespace";
const DROPPED_TABLES = Object.freeze([
  "analytics_storage_erasure_fences",
  "analytics_storage_erasure_receipts",
  "community_terminal_watermarks",
  "identity_reenrollment_cooldowns",
  "postgres_readiness_sweeps",
]);
const DROPPED_INDEXES = Object.freeze([
  "storage_ingestion_terminal_epoch",
  "analytics_applied_terminal_epoch",
  "admin_action_audit_started_participant",
  "analytics_storage_erasure_public_epoch",
]);
const DROPPED_FUNCTIONS = Object.freeze([
  "community_publication_erasure_floor(text)",
  "analytics_storage_erasure_fence_guard()",
  "analytics_storage_erasure_receipt_guard()",
  "community_terminal_watermark_fenced()",
  "community_terminal_watermark_guard()",
]);
const LEDGER_CONTRACT_COLUMNS = Object.freeze([
  "ledger_instance_connection_name", "ledger_database_name", "ledger_schema_name",
]);

const residueNames = (await readdir(PRIMARY_DIRECTORY)).filter((name) => name.endsWith(RESIDUE_SUFFIX));
assert.equal(residueNames.length, 1, "exactly one primary append-only residue migration");
const RESIDUE_NAME = residueNames[0];
const RESIDUE_SQL = await readFile(join(PRIMARY_DIRECTORY, RESIDUE_NAME), "utf8");
const PRIMARY = await readPostgresMigrations({ role: "primary" });
const RESIDUE_VERSION = PRIMARY.find((migration) => migration.name === RESIDUE_NAME).version;

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "residue tests require a loopback host or a private Unix socket");
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
    return { host, port: PG_TEST_PORT };
  }
  return { host: PG_TEST_HOST, port: PG_TEST_PORT };
}

function q(identifier) {
  assert.match(identifier, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${identifier}"`;
}

function t(schema, name) {
  return `${q(schema)}.${q(name)}`;
}

let endpoint;
let admin;
const createdDatabases = [];
const createdRoles = [];
let template;

function poolFor(database, max = 3) {
  return new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database,
    ssl: false,
    max,
    connectionTimeoutMillis: 5_000,
  });
}

async function createDatabase(label, templateName = "template0") {
  const name = `w3_simp_residue_${label}_${RUN}`;
  await admin.query(`CREATE DATABASE ${q(name)} TEMPLATE ${q(templateName)} ENCODING 'UTF8'`);
  createdDatabases.push(name);
  return name;
}

async function dropDatabase(name) {
  await admin.query(`DROP DATABASE IF EXISTS ${q(name)} WITH (FORCE)`);
  const index = createdDatabases.indexOf(name);
  if (index >= 0) createdDatabases.splice(index, 1);
}

/** Run one case in a clone of the pre-residue template, then drop it. */
async function withUpgradeDatabase(label, run) {
  const name = await createDatabase(label, template);
  const pool = poolFor(name);
  try {
    await run(pool);
  } finally {
    await pool.end();
    await dropDatabase(name);
  }
}

async function history(pool, schema = SCHEMA) {
  return (await pool.query(
    `SELECT version, name FROM ${q(schema)}.${migrationHistoryTable()} ORDER BY version`,
  )).rows;
}

async function regclass(pool, schema, name) {
  return (await pool.query("SELECT to_regclass($1) IS NOT NULL AS present", [`${q(schema)}.${q(name)}`]))
    .rows[0].present;
}

async function contractColumns(pool) {
  return (await pool.query(
    `SELECT attname FROM pg_attribute
      WHERE attrelid = 'tibotattle_transfer.transfer_target_contract'::regclass
        AND attnum > 0 AND NOT attisdropped
      ORDER BY attnum`,
  )).rows.map((row) => row.attname);
}

/** The residue SQL alone, as the runner applies it, to pin the refusal. */
async function residueDirect(pool, schema = SCHEMA) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(renderPostgresSearchPath(schema));
    await client.query(RESIDUE_SQL);
    return "applied";
  } catch (error) {
    return { code: error.code, message: error.message };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

async function assertRefused(pool, expected, schema = SCHEMA) {
  assert.deepEqual(await residueDirect(pool, schema), expected);
  await assert.rejects(applyPostgresMigrations({ role: "primary", schema, pool }),
    { code: "POSTGRES_MIGRATION_APPLY_FAILED" });
  const rows = await history(pool, schema);
  assert.equal(rows.length, RESIDUE_VERSION - 1, "a refused residue leaves the history unchanged");
  for (const table of DROPPED_TABLES) {
    assert.equal(await regclass(pool, schema, table), true, `${table} survives a refusal`);
  }
  assert.deepEqual((await contractColumns(pool)).filter((name) => name.startsWith("ledger_")),
    LEDGER_CONTRACT_COLUMNS, "a refusal leaves the contract shape unchanged");
}

function authority({ epoch, policy = 1, collection = 1, graph = 0, sourceEpoch = 0, sequence = 0, method }) {
  return JSON.stringify({
    sourceId: SOURCE,
    sourceNamespace: NAMESPACE,
    publicAuthorityEpoch: epoch,
    policyRevision: policy,
    collectionRevision: collection,
    graphInvalidationEpoch: graph,
    sourceEpoch,
    sequence,
    ...(method === undefined ? {} : { dailyDeviceMethod: method }),
  });
}

const RELEASED_AT = "2026-09-30T12:00:00.000Z";

async function insertDaily(pool, { day, revision, epoch, provenance = "gcp", authorityText, schema = SCHEMA }) {
  const payload = JSON.stringify({ day, revision, synthetic: true });
  const digest = createHash("sha256").update(payload).digest("hex");
  if (provenance === null) {
    await pool.query(
      `INSERT INTO ${t(schema, "community_daily_aggregates")} (
         source_id, source_namespace, day, revision, payload_json, payload_sha256,
         source_authority_epoch, source_cursor_sequence, policy_revision, collection_revision,
         release_state, released_at
       ) VALUES ($1, $2, $3::date, $4, $5, $6, 0, 0, 1, 1, 'published', $7::timestamptz)`,
      [SOURCE, NAMESPACE, day, revision, payload, digest, RELEASED_AT],
    );
    return;
  }
  await pool.query(
    `INSERT INTO ${t(schema, "community_daily_aggregates")} (
       source_id, source_namespace, day, revision, payload_json, payload_sha256,
       source_authority_epoch, source_cursor_sequence, policy_revision, collection_revision,
       release_state, released_at, public_authority_epoch, source_mutation_epoch, journal_sequence,
       graph_invalidation_epoch, cohort_digest, provenance, released_at_iso, authority_json,
       daily_device_method
     ) VALUES ($1, $2, $3::date, $4, $5, $6, 0, 0, 1, 1, 'published', $7::timestamptz,
       $8, 0, 0, 0, $9, $10, $12, $11, 'w3-simp-method')`,
    [SOURCE, NAMESPACE, day, revision, payload, digest, RELEASED_AT, epoch,
      "c".repeat(64), provenance, authorityText ?? authority({ epoch, method: "w3-simp-method" }),
      RELEASED_AT],
  );
}

async function upsertPreview(pool, { epoch, authorityText, schema = SCHEMA }) {
  const payload = JSON.stringify({ synthetic: true, epoch });
  await pool.query(
    `INSERT INTO ${t(schema, "community_graph_previews")} (
       source_id, source_namespace, revision, method, cohort_digest, authority_json,
       public_authority_epoch, policy_revision, collection_revision, source_mutation_epoch,
       journal_sequence, graph_invalidation_epoch, model_revision, payload_json, payload_sha256,
       generated_at, snapshot_source_epoch, inputs_current, provenance
     ) VALUES ($1, $2, 1, 'w3-simp-preview', $3, $4, $5, 1, 1, 0, 0, 0, 0, $6, $7, $8, 0, 1, 'gcp')
     ON CONFLICT (source_id) DO UPDATE SET
       authority_json = EXCLUDED.authority_json,
       public_authority_epoch = EXCLUDED.public_authority_epoch,
       payload_json = EXCLUDED.payload_json,
       payload_sha256 = EXCLUDED.payload_sha256`,
    [SOURCE, NAMESPACE, "d".repeat(64), authorityText ?? authority({ epoch }), epoch, payload,
      createHash("sha256").update(payload).digest("hex"), RELEASED_AT],
  );
}

async function snapshot(pool, schema = SCHEMA) {
  const rows = {};
  for (const [table, order] of [
    ["community_daily_aggregates", "source_id, day, revision"],
    ["community_daily_heads", "source_id, day"],
    ["community_graph_previews", "source_id"],
    ["retention_state", "singleton"],
  ]) {
    rows[table] = (await pool.query(
      `SELECT to_jsonb(row_value)::text AS row FROM ${t(schema, table)} row_value ORDER BY ${order}`,
    )).rows.map((row) => row.row);
  }
  return rows;
}

async function catalogAfterResidue(pool, schema) {
  for (const table of DROPPED_TABLES) {
    assert.equal(await regclass(pool, schema, table), false, `${table} is dropped`);
  }
  for (const index of DROPPED_INDEXES) {
    assert.equal(await regclass(pool, schema, index), false, `${index} is dropped`);
  }
  for (const signature of DROPPED_FUNCTIONS) {
    const present = (await pool.query("SELECT to_regprocedure($1) IS NOT NULL AS present",
      [`${q(schema)}.${signature}`])).rows[0].present;
    assert.equal(present, false, `${signature} is dropped`);
  }
  // The pin checks stay, with their pinned search_path, on the same triggers;
  // neither fence reads a cursor or an erasure floor any more.
  for (const [fn, table] of [["community_daily_authority_fence", "community_daily_aggregates"],
    ["community_graph_preview_authority_fence", "community_graph_previews"]]) {
    const row = (await pool.query(
      `SELECT p.prosrc, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.proname = $2`, [schema, fn])).rows;
    assert.equal(row.length, 1, fn);
    assert.equal(row[0].prosrc.includes("community_authority_pin_matches"), true, fn);
    assert.equal(/erasure|analytics_source_cursors|watermark/u.test(row[0].prosrc), false, fn);
    assert.equal(row[0].proconfig?.length, 1, fn);
    assert.match(row[0].proconfig[0], new RegExp(`^search_path="?${schema}"?, pg_catalog$`, "u"), fn);
    const trigger = (await pool.query(
      `SELECT count(*)::int AS count FROM pg_trigger tg
         JOIN pg_proc p ON p.oid = tg.tgfoid
        WHERE tg.tgrelid = $1::regclass AND p.proname = $2 AND NOT tg.tgisinternal`,
      [`${q(schema)}.${q(table)}`, fn])).rows[0].count;
    assert.equal(trigger, 1, `${fn} still guards ${table}`);
  }
  const noTruncate = (await pool.query("SELECT to_regprocedure($1) IS NOT NULL AS present",
    [`${q(schema)}.community_publication_proof_no_truncate()`])).rows[0].present;
  assert.equal(noTruncate, true, "the daily heads keep their no-truncate guard");
  const constraints = Object.fromEntries((await pool.query(
    `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = $1::regclass AND conname = ANY($2)`,
    [`${q(schema)}.retention_state`, ["retention_state_restored_participants_suppressed_check",
      "retention_state_restore_replay_complete_check"]],
  )).rows.map((row) => [row.conname, row.definition]));
  assert.deepEqual(constraints, {
    retention_state_restored_participants_suppressed_check: "CHECK ((restored_participants_suppressed = 0))",
    retention_state_restore_replay_complete_check: "CHECK (restore_replay_complete)",
  });
  const cooldownDigest = (await pool.query(
    `SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'participants' AND column_name = 'identity_cooldown_digest'`,
    [schema])).rows[0].count;
  assert.equal(cooldownDigest, 1, "enrollment still writes participants.identity_cooldown_digest");
  const columns = await contractColumns(pool);
  for (const column of LEDGER_CONTRACT_COLUMNS) assert.equal(columns.includes(column), false, column);
  for (const column of ["contract_id", "instance_connection_name", "database_name", "schema_name",
    "iam_database_user", "schema_owner_role", "gcs_bucket", "gcs_bucket_generation"]) {
    assert.equal(columns.includes(column), true, column);
  }
}

before(async () => {
  if (!PG_TEST_HOST && !PG_TEST_SOCKET) return;
  endpoint = await localEndpoint();
  admin = poolFor(PG_TEST_DATABASE, 2);
  const server = await admin.query("SELECT current_setting('server_version_num')::integer AS version");
  assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the residue spec requires PostgreSQL 17");
  template = await createDatabase("template");
  const pool = poolFor(template);
  try {
    await pool.query(`CREATE SCHEMA ${q(SCHEMA)}`);
    const prefix = await applyMigrationsBefore({ role: "primary", schema: SCHEMA, pool, name: RESIDUE_NAME });
    assert.equal(prefix.applied, RESIDUE_VERSION - 1);
  } finally {
    await pool.end();
  }
});

after(async () => {
  if (!admin) return;
  for (const name of [...createdDatabases].reverse()) {
    await admin.query(`DROP DATABASE IF EXISTS ${q(name)} WITH (FORCE)`).catch(() => {});
  }
  for (const role of createdRoles) {
    await admin.query(`DROP ROLE IF EXISTS ${q(role)}`).catch(() => {});
  }
  await admin.end();
});

test("the residue migration follows 0053 and 0063, only the additive 0065 follows it, and it raises only constants", () => {
  assert.deepEqual(PRIMARY.filter(({ version }) => version > RESIDUE_VERSION).map(({ name }) => name),
    ["0065_interim_public_read.sql"]);
  assert.ok(RESIDUE_VERSION > 63, "the residue follows 0063");
  assert.equal(/\bEXECUTE\b/u.test(RESIDUE_SQL), false, "no dynamic SQL (OPS-10 expand classifier)");
  const raises = [...RESIDUE_SQL.matchAll(/RAISE EXCEPTION ('[^']*'|[^;]*);/gu)].map((match) => match[1]);
  assert.ok(raises.length >= 3);
  for (const raise of raises) assert.match(raise, /^'[A-Za-z_]+' USING ERRCODE = 'P1005'$/u);
  // OD-1 (2026-10-02): the name and number are final, with no provisional marker.
  assert.equal(RESIDUE_NAME, "0064_append_only_residue.sql");
  assert.equal(/provisional/iu.test(RESIDUE_SQL), false, "OD-1 is answered: no provisional marker remains");
});

test("PG17: a fresh database applies the whole chain with the residue's catalog", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET, timeout: 300_000,
}, async () => {
  const name = await createDatabase("fresh");
  const pool = poolFor(name);
  try {
    await pool.query(`CREATE SCHEMA ${q(SCHEMA)}`);
    const result = await applyPostgresMigrations({ role: "primary", schema: SCHEMA, pool });
    assert.equal(result.applied, PRIMARY.length);
    assert.deepEqual((await history(pool)).find(({ version }) => version === RESIDUE_VERSION),
      { version: RESIDUE_VERSION, name: RESIDUE_NAME });
    await catalogAfterResidue(pool, SCHEMA);
    // The pinned retention flags refuse any writer, by constraint name.
    await assert.rejects(pool.query(
      `UPDATE ${t(SCHEMA, "retention_state")} SET restored_participants_suppressed = 1`),
    { code: "23514", constraint: "retention_state_restored_participants_suppressed_check" });
    await assert.rejects(pool.query(
      `UPDATE ${t(SCHEMA, "retention_state")} SET restore_replay_complete = false`),
    { code: "23514", constraint: "retention_state_restore_replay_complete_check" });
    // A rerun applies nothing.
    assert.equal((await applyPostgresMigrations({ role: "primary", schema: SCHEMA, pool })).applied,
      PRIMARY.length);
  } finally {
    await pool.end();
    await dropDatabase(name);
  }
});

test("PG17: the upgrade keeps every published row byte-identical and keeps the authority pin", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET, timeout: 300_000,
}, async () => {
  await withUpgradeDatabase("upgrade", async (pool) => {
    await insertDaily(pool, { day: "2026-09-28", revision: 1, epoch: 3 });
    await insertDaily(pool, { day: "2026-09-29", revision: 1, epoch: undefined, provenance: null });
    await upsertPreview(pool, { epoch: 3 });
    // 0053's floor created the per-source lock row at zero: no evidence.
    assert.deepEqual((await pool.query(
      `SELECT terminal_public_authority_epoch::int AS epoch, terminal_sequence::int AS sequence,
              legacy_terminal_floor_epoch FROM ${t(SCHEMA, "community_terminal_watermarks")}`)).rows,
    [{ epoch: 0, sequence: 0, legacy_terminal_floor_epoch: null }]);
    // Before the residue, a pin below the cursor epoch is stale.
    await pool.query(
      `INSERT INTO ${t(SCHEMA, "analytics_source_cursors")} (source_id, sequence, authority_epoch)
       VALUES ($1, 0, 50)`, [SOURCE]);
    await assert.rejects(insertDaily(pool, { day: "2026-09-28", revision: 2, epoch: 5 }),
      { code: "P1005", message: "analytics_publication_authority_stale" });
    const before = await snapshot(pool);
    assert.equal(before.community_daily_aggregates.length, 2);

    const result = await applyPostgresMigrations({ role: "primary", schema: SCHEMA, pool });
    assert.equal(result.applied, PRIMARY.length);
    assert.equal((await history(pool)).length, PRIMARY.length);
    assert.deepEqual(await snapshot(pool), before, "published rows, heads, preview and retention are unchanged");
    await catalogAfterResidue(pool, SCHEMA);

    // After it, the authority pin still binds, and a pin below the cursor
    // epoch is accepted: append-only has no withdrawal for a floor to guard.
    await assert.rejects(insertDaily(pool, {
      day: "2026-09-28", revision: 2, epoch: 5,
      authorityText: authority({ epoch: 6, method: "w3-simp-method" }),
    }), { code: "P1005", message: "community_publication_authority_mismatch" });
    await assert.rejects(upsertPreview(pool, { epoch: 7, authorityText: authority({ epoch: 8 }) }),
      { code: "P1005", message: "community_publication_authority_mismatch" });
    await insertDaily(pool, { day: "2026-09-28", revision: 2, epoch: 5 });
    await upsertPreview(pool, { epoch: 4 });
    assert.deepEqual((await pool.query(
      `SELECT revision::int AS revision FROM ${t(SCHEMA, "community_daily_heads")}
        WHERE source_id = $1 AND day = '2026-09-28'`, [SOURCE])).rows, [{ revision: 2 }]);
    // The revision order still binds.
    await assert.rejects(insertDaily(pool, { day: "2026-09-28", revision: 4, epoch: 5 }),
      { code: "P1005", message: "community_daily_revision_conflict" });

    // A second application schema in the same database applies the whole
    // chain: 0056 leaves the installed control schema alone and the residue
    // finds the ledger columns already gone.
    await pool.query(`CREATE SCHEMA ${q(SECOND_SCHEMA)}`);
    const second = await applyPostgresMigrations({ role: "primary", schema: SECOND_SCHEMA, pool });
    assert.equal(second.applied, PRIMARY.length);
    await catalogAfterResidue(pool, SECOND_SCHEMA);
    assert.equal((await history(pool)).length, PRIMARY.length, "the first schema's history is unchanged");
  });
});

test("PG17: two application schemas held below the residue in one database each upgrade, one after the other", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET, timeout: 300_000,
}, async () => {
  // The shared test-database and fast-path layout: several application
  // schemas share one database and its database-scoped PT-1 control schema.
  await withUpgradeDatabase("twoschemas", async (pool) => {
    await pool.query(`CREATE SCHEMA ${q(SECOND_SCHEMA)}`);
    const prefix = await applyMigrationsBefore({
      role: "primary", schema: SECOND_SCHEMA, pool, name: RESIDUE_NAME,
    });
    assert.equal(prefix.applied, RESIDUE_VERSION - 1);
    for (const schema of [SCHEMA, SECOND_SCHEMA]) {
      await insertDaily(pool, { day: "2026-09-28", revision: 1, epoch: 3, schema });
      await upsertPreview(pool, { epoch: 3, schema });
    }
    const contractBefore = await contractColumns(pool);
    assert.deepEqual(contractBefore.filter((name) => name.startsWith("ledger_")), LEDGER_CONTRACT_COLUMNS);
    const contractAfter = contractBefore.filter((name) => !LEDGER_CONTRACT_COLUMNS.includes(name));
    const firstBefore = await snapshot(pool, SCHEMA);
    const secondBefore = await snapshot(pool, SECOND_SCHEMA);

    // The first upgrade drops the shared contract's ledger columns, and
    // leaves the second schema below the residue with every object in place.
    assert.equal((await applyPostgresMigrations({ role: "primary", schema: SCHEMA, pool })).applied,
      PRIMARY.length);
    assert.equal((await history(pool, SCHEMA)).length, PRIMARY.length);
    await catalogAfterResidue(pool, SCHEMA);
    assert.deepEqual(await contractColumns(pool), contractAfter);
    assert.equal((await history(pool, SECOND_SCHEMA)).length, RESIDUE_VERSION - 1);
    for (const table of DROPPED_TABLES) {
      assert.equal(await regclass(pool, SECOND_SCHEMA, table), true, `${table} waits for its own upgrade`);
    }
    assert.deepEqual(await snapshot(pool, SECOND_SCHEMA), secondBefore);

    // The second upgrade finds the ledger columns gone and changes the
    // contract shape no further.
    assert.equal((await applyPostgresMigrations({ role: "primary", schema: SECOND_SCHEMA, pool })).applied,
      PRIMARY.length);
    assert.equal((await history(pool, SECOND_SCHEMA)).length, PRIMARY.length);
    await catalogAfterResidue(pool, SECOND_SCHEMA);
    assert.deepEqual(await contractColumns(pool), contractAfter);
    assert.deepEqual(await snapshot(pool, SCHEMA), firstBefore);
    assert.deepEqual(await snapshot(pool, SECOND_SCHEMA), secondBefore);
    assert.deepEqual((await history(pool, SCHEMA)).find(({ version }) => version === RESIDUE_VERSION),
      { version: RESIDUE_VERSION, name: RESIDUE_NAME });
    assert.deepEqual((await history(pool, SECOND_SCHEMA)).find(({ version }) => version === RESIDUE_VERSION),
      { version: RESIDUE_VERSION, name: RESIDUE_NAME });
  });
});

for (const [label, seed, expected] of [
  ["fence", async (pool) => {
    await pool.query(
      `INSERT INTO ${t(SCHEMA, "analytics_storage_erasure_fences")} (
         source_id, owner_digest, terminal_event_digest, terminal_sequence, terminal_revision,
         authority_epoch, public_authority_epoch
       ) VALUES ($1, $2, $3, 1, 1, 1, 1)`, [SOURCE, "a".repeat(64), "b".repeat(64)]);
  }, { code: "P1005", message: "append_only_residue_retained_rows" }],
  ["watermark", async (pool) => {
    await pool.query(
      `INSERT INTO ${t(SCHEMA, "community_terminal_watermarks")}
         (source_id, terminal_public_authority_epoch, terminal_sequence) VALUES ($1, 3, 0)`, [SOURCE]);
  }, { code: "P1005", message: "append_only_residue_retained_rows" }],
  ["sequence", async (pool) => {
    await pool.query(
      `INSERT INTO ${t(SCHEMA, "community_terminal_watermarks")}
         (source_id, terminal_public_authority_epoch, terminal_sequence) VALUES ($1, 0, 2)`, [SOURCE]);
  }, { code: "P1005", message: "append_only_residue_retained_rows" }],
  ["legacyfloor", async (pool) => {
    await pool.query(
      `INSERT INTO ${t(SCHEMA, "community_terminal_watermarks")}
         (source_id, terminal_public_authority_epoch, terminal_sequence, legacy_terminal_floor_epoch)
       VALUES ($1, 0, 0, 0)`, [SOURCE]);
  }, { code: "P1005", message: "append_only_residue_retained_rows" }],
  ["cooldown", async (pool) => {
    await pool.query(
      `INSERT INTO ${t(SCHEMA, "identity_reenrollment_cooldowns")}
         (identity_cooldown_digest, participant_id, created_at, expires_at)
       VALUES ($1, NULL, now(), now() + interval '1 day')`, ["e".repeat(64)]);
  }, { code: "P1005", message: "append_only_residue_retained_rows" }],
  ["sweep", async (pool) => {
    await pool.query(
      `INSERT INTO ${t(SCHEMA, "postgres_readiness_sweeps")}
         (singleton, process_epoch, source_id, source_epoch, state, checked_at)
       VALUES (1, $1, $2, 0, 'pending', now())`, ["f".repeat(64), SOURCE]);
  }, { code: "P1005", message: "append_only_residue_retained_rows" }],
  ["suppressed", async (pool) => {
    await pool.query(`UPDATE ${t(SCHEMA, "retention_state")} SET restored_participants_suppressed = 2`);
  }, { code: "23514", message: 'check constraint "retention_state_restored_participants_suppressed_check" of relation "retention_state" is violated by some row' }],
  ["replay", async (pool) => {
    await pool.query(`UPDATE ${t(SCHEMA, "retention_state")} SET restore_replay_complete = false`);
  }, { code: "23514", message: 'check constraint "retention_state_restore_replay_complete_check" of relation "retention_state" is violated by some row' }],
  ["contract", async (pool) => {
    await pool.query(
      `INSERT INTO tibotattle_transfer.transfer_target_contract (
         contract_id, mode, project_id, project_number, instance_connection_name, database_name,
         schema_name, ledger_instance_connection_name, ledger_database_name, ledger_schema_name,
         iam_database_user, schema_owner_role, gcs_bucket, gcs_bucket_generation
       ) VALUES ('w3-simp-contract', 'staging_rehearsal', 'w3-simp-project', '1',
         'w3-simp-project:us-east1:primary', 'w3_simp_database', $1,
         'w3-simp-project:us-east1:ledger', 'w3_simp_ledger', 'w3_simp_ledger_schema',
         'w3-simp-runtime', 'w3-simp-owner', 'w3-simp-bucket', '1')`, [SCHEMA]);
  }, { code: "P1005", message: "transfer_target_contract_registered_with_ledger" }],
  ["foreign", async (pool) => {
    const role = `w3_simp_foreign_${RUN}`;
    await pool.query(`CREATE ROLE ${q(role)} NOLOGIN`);
    createdRoles.push(role);
    await pool.query(`ALTER SCHEMA tibotattle_transfer OWNER TO ${q(role)}`);
  }, { code: "P1005", message: "TRANSFER_CONTROL_SCHEMA_FOREIGN" }],
]) {
  test(`PG17: residue refuses (${label}) and leaves every object and the history unchanged`, {
    skip: !PG_TEST_HOST && !PG_TEST_SOCKET, timeout: 300_000,
  }, async () => {
    await withUpgradeDatabase(label, async (pool) => {
      await seed(pool);
      await assertRefused(pool, expected);
      if (label === "foreign") {
        await pool.query(`ALTER SCHEMA tibotattle_transfer OWNER TO CURRENT_USER`);
      }
    });
  });
}

test("PG17: a zero watermark alone is not residue", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET, timeout: 300_000,
}, async () => {
  await withUpgradeDatabase("zero", async (pool) => {
    await pool.query(
      `INSERT INTO ${t(SCHEMA, "community_terminal_watermarks")}
         (source_id, terminal_public_authority_epoch, terminal_sequence) VALUES ($1, 0, 0)`, [SOURCE]);
    assert.equal((await applyPostgresMigrations({ role: "primary", schema: SCHEMA, pool })).applied,
      PRIMARY.length);
    await catalogAfterResidue(pool, SCHEMA);
  });
});
