import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createServer } from "vite";
import pg from "pg";
import { renderPostgresSearchPath } from "../scripts/postgres-migrations.mjs";
import { applyMigrationsBefore } from "./promoted-migration-prefix.mjs";
import {
  createSyntheticD1TypedLegacyFixtureSource,
  POSTGRES_TYPED_LEGACY_CONTROL_SCHEMA_PREFIX,
  POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX,
  runPostgresTypedLegacyTransfer,
} from "../scripts/postgres-typed-legacy-transfer.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "5432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD ?? "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 0052 is promoted (claude/gcp-fastpath-base): schemas receive the promoted
// chain below 0052, then the promoted 0052 file in one bounded transaction.
const STAGED_MIGRATION_NAME = "0052_typed_telemetry_live_allocators.sql";
const STAGED_MIGRATION = join(WORKER_ROOT, "postgres", "migrations", "primary", STAGED_MIGRATION_NAME);
const STAGED_TIMEOUT_MILLISECONDS = 30_000;
const STAGED_LOCK_TIMEOUT_MILLISECONDS = 5_000;
const MAX_TYPED_ID = 9_007_199_254_740_991n;
const TYPED_TABLES = Object.freeze([
  "typed_telemetry_namespaces",
  "typed_telemetry_owners",
  "typed_telemetry_devices",
  "typed_telemetry_manifests",
  "typed_telemetry_chunks",
  "typed_telemetry_identifiers",
  "typed_telemetry_attributions",
  "typed_telemetry_quota_dimensions",
  "typed_telemetry_records",
]);
// 2026-09-24 (UTC day 20720), midday.
const DAY = 20_720;
const OBSERVED_AT_MS = DAY * 86_400_000 + 43_200_000;

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65535);
  const [link, resolved] = await Promise.all([lstat(PG_TEST_SOCKET), realpath(PG_TEST_SOCKET)]);
  const metadata = await stat(resolved);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: resolved, port: PG_TEST_PORT };
}

async function testPool() {
  const socket = await localSocket();
  const pool = new pg.Pool({ ...socket, user: PG_TEST_USER, password: PG_TEST_PASSWORD,
    database: PG_TEST_DATABASE, ssl: false, max: 4, connectionTimeoutMillis: 5_000 });
  try {
    const locality = await pool.query(
      "SELECT inet_server_addr() AS address, current_setting('server_version_num') AS version",
    );
    assert.equal(locality.rows[0]?.address, null, "test database must use the local Unix socket");
    assert.match(locality.rows[0]?.version ?? "", /^17\d+$/u, "test must run on PostgreSQL 17");
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

async function stagedSql() {
  const [link, metadata] = await Promise.all([lstat(STAGED_MIGRATION), stat(STAGED_MIGRATION)]);
  assert.equal(link.isSymbolicLink(), false);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.nlink, 1);
  const sql = await readFile(STAGED_MIGRATION, "utf8");
  assert.ok(sql.trim().length > 0);
  return sql;
}

/**
 * The promoted migrations below 0052, so the spec can prove the pre-0052 state;
 * applyStagedMigration then applies the promoted 0052 file in one bounded
 * transaction (the CR-1 harness shape).
 */
async function applyStockMigrations(pool, schema) {
  const before = await applyMigrationsBefore({ role: "primary", schema, pool, name: STAGED_MIGRATION_NAME });
  assert.equal(before.target.version, 52);
  assert.equal(before.applied, before.prefix.length);
  assert.equal(before.prefix.some((migration) => migration.name.endsWith("_typed_telemetry_live_allocators.sql")), false,
    "the allocator migration is not part of the prefix");
}

async function applyStagedMigration(pool, schema) {
  const sql = await stagedSql();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout='${STAGED_TIMEOUT_MILLISECONDS}ms'`);
    await client.query(`SET LOCAL lock_timeout='${STAGED_LOCK_TIMEOUT_MILLISECONDS}ms'`);
    await client.query(renderPostgresSearchPath(schema));
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function withClient(pool, operation) {
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

function isUnavailable(error) {
  return error?.name === "ApiError" && error.status === 503
    && error.code === "BACKEND_STORAGE_UNAVAILABLE" && error.message === "BACKEND_STORAGE_UNAVAILABLE"
    && error.publicDetails === null && error.responseHeaders === null;
}

async function nextValues(pool, schema) {
  const values = {};
  for (const table of TYPED_TABLES) {
    const result = await pool.query(`SELECT last_value::text AS last_value, is_called
      FROM "${schema}"."${table}_id_seq"`);
    const lastValue = BigInt(result.rows[0].last_value);
    values[table] = String(result.rows[0].is_called ? lastValue + 1n : lastValue);
  }
  return values;
}

function everyTable(value) {
  return Object.fromEntries(TYPED_TABLES.map((table) => [table, String(value)]));
}

async function insertParticipant(pool, schema, tag) {
  const participantId = `synthetic-live-alloc-${tag}-${randomBytes(4).toString("hex")}`;
  await pool.query(`INSERT INTO "${schema}".participants(id, created_at) VALUES ($1, $2)`,
    [participantId, new Date().toISOString()]);
  return participantId;
}

/**
 * Insert one row into each of the nine id-keyed typed tables (plus the v1
 * membership the chunk and record need). With `id` null every insert omits
 * the id column and relies on the identity; otherwise every row gets that
 * explicit id, as an importer writes it.
 */
async function insertTypedChain(pool, schema, { id, tag }) {
  const table = (name) => `"${schema}"."${name}"`;
  const participantId = await insertParticipant(pool, schema, tag);
  const dictionary = async (value) => (await pool.query(
    `INSERT INTO ${table("typed_telemetry_dictionary")}(value) VALUES ($1) RETURNING id`, [value],
  )).rows[0].id;
  const provider = await dictionary(`synthetic-${tag}-provider`);
  const planType = await dictionary(`synthetic-${tag}-plan`);
  const planVariant = await dictionary(`synthetic-${tag}-variant`);
  const insert = async (name, columns, values) => {
    const allColumns = id === null ? columns : ["id", ...columns];
    const allValues = id === null ? values : [id, ...values];
    const markers = allValues.map((_, index) => `$${index + 1}`).join(",");
    const result = await pool.query(`INSERT INTO ${table(name)}(${allColumns.join(",")})
      VALUES (${markers}) RETURNING id::text AS id`, allValues);
    return result.rows[0].id;
  };
  const ids = {};
  ids.typed_telemetry_namespaces = await insert("typed_telemetry_namespaces", ["original_id"], [randomBytes(24)]);
  const namespaceId = ids.typed_telemetry_namespaces;
  ids.typed_telemetry_owners = await insert("typed_telemetry_owners", ["namespace_id", "original_id"],
    [namespaceId, randomBytes(24)]);
  const ownerId = ids.typed_telemetry_owners;
  await pool.query(`INSERT INTO ${table("typed_telemetry_owner_memberships")}(
      namespace_id, source_format, owner_id, participant_id, source_namespace
    ) VALUES ($1, 10, $2, $3, $4)`, [namespaceId, ownerId, participantId, `synthetic-${tag}-v1`]);
  ids.typed_telemetry_devices = await insert("typed_telemetry_devices",
    ["namespace_id", "owner_id", "original_id"], [namespaceId, ownerId, randomBytes(24)]);
  const deviceId = ids.typed_telemetry_devices;
  ids.typed_telemetry_manifests = await insert("typed_telemetry_manifests",
    ["namespace_id", "owner_id", "device_id", "original_id", "chunk_day"],
    [namespaceId, ownerId, deviceId, randomBytes(24), DAY]);
  ids.typed_telemetry_chunks = await insert("typed_telemetry_chunks",
    ["namespace_id", "format", "owner_id", "device_id", "manifest_id", "original_id", "stream", "chunk_day"],
    [namespaceId, 10, ownerId, deviceId, null, randomBytes(24), 1, DAY]);
  ids.typed_telemetry_identifiers = await insert("typed_telemetry_identifiers",
    ["namespace_id", "owner_id", "value"], [namespaceId, ownerId, randomBytes(24)]);
  ids.typed_telemetry_attributions = await insert("typed_telemetry_attributions",
    ["namespace_id", "owner_id", "account_basis", "account_track", "plan_basis", "plan_type_id", "plan_era"],
    [namespaceId, ownerId, 0, Buffer.alloc(0), 0, planType, Buffer.alloc(0)]);
  ids.typed_telemetry_quota_dimensions = await insert("typed_telemetry_quota_dimensions",
    ["namespace_id", "owner_id", "plan_type_id", "plan_variant_id", "attribution_id"],
    [namespaceId, ownerId, planType, planVariant, null]);
  ids.typed_telemetry_records = await insert("typed_telemetry_records",
    ["namespace_id", "format", "source_row_id", "owner_id", "device_id", "chunk_id", "manifest_id", "stream",
      "occurrence_id", "observed_at_ms", "observed_day", "provider_id", "canonical_digest"],
    [namespaceId, 10, 1, ownerId, deviceId, ids.typed_telemetry_chunks, null, 1,
      randomBytes(24), OBSERVED_AT_MS, DAY, provider, randomBytes(32)]);
  return ids;
}

async function loadAllocators() {
  const vite = await createServer({ root: WORKER_ROOT, configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "error" });
  const allocators = await vite.ssrLoadModule("/src/postgres-typed-live-allocators.ts");
  return { vite, allocators };
}

test("PG17 staged 0052 allocates live typed ids, restarts past imported ids and gates headroom", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const pool = await testPool();
  const schema = `typed_live_alloc_${randomBytes(6).toString("hex")}`;
  const runtimeRole = `${schema}_runtime`;
  const schemaOptions = { primarySchema: schema };
  const table = (name) => `"${schema}"."${name}"`;
  let vite;
  let schemaCreated = false;
  let roleCreated = false;
  try {
    const loaded = await loadAllocators();
    vite = loaded.vite;
    const { allocators } = loaded;
    assert.deepEqual([...allocators.POSTGRES_TYPED_IDENTITY_TABLES], TYPED_TABLES);
    const verify = (client) => allocators.verifyPostgresTypedIdentityHeadroom(client, schemaOptions);
    const restart = (client) => allocators.restartPostgresTypedIdentities(client, schemaOptions);

    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await applyStockMigrations(pool, schema);

    // Without 0052 the import-shape family cannot allocate, and both helpers
    // fail closed without exposing provider text.
    await assert.rejects(
      pool.query(`INSERT INTO ${table("typed_telemetry_namespaces")}(original_id) VALUES ($1)`, [randomBytes(24)]),
      (error) => error?.code === "23502",
    );
    await withClient(pool, async (client) => {
      await assert.rejects(verify(client), isUnavailable);
      await assert.rejects(restart(client), isUnavailable);
    });

    await applyStagedMigration(pool, schema);

    // Catalog shape: nine BY DEFAULT identities on the exact named sequences,
    // bounded to the retained id CHECK range; an owner-only invoker function.
    const catalog = await pool.query(`SELECT class.relname AS table_name, attribute.attidentity::text AS identity,
        pg_get_serial_sequence(format('%I.%I', $1::text, class.relname), 'id') AS sequence,
        sequence.seqstart::text AS start, sequence.seqincrement::text AS increment,
        sequence.seqmin::text AS minimum, sequence.seqmax::text AS maximum, sequence.seqcycle AS cycles
      FROM pg_class class
      JOIN pg_namespace namespace ON namespace.oid = class.relnamespace AND namespace.nspname = $1
      JOIN pg_attribute attribute ON attribute.attrelid = class.oid AND attribute.attname = 'id'
      JOIN pg_sequence sequence
        ON sequence.seqrelid = pg_get_serial_sequence(format('%I.%I', $1::text, class.relname), 'id')::regclass
     WHERE class.relname = ANY($2::text[])
     ORDER BY array_position($2::text[], class.relname::text)`, [schema, TYPED_TABLES]);
    assert.deepEqual(catalog.rows, TYPED_TABLES.map((name) => ({
      table_name: name, identity: "d", sequence: `${schema}.${name}_id_seq`, start: "1", increment: "1",
      minimum: "1", maximum: String(MAX_TYPED_ID), cycles: false,
    })));
    const restartFunction = await pool.query(`SELECT procedure.prosecdef AS definer, procedure.proacl IS NOT NULL AS has_acl,
        EXISTS (SELECT 1 FROM aclexplode(procedure.proacl) acl
                 WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc procedure WHERE procedure.oid = $1::regprocedure`,
    [`"${schema}".typed_telemetry_restart_identities()`]);
    assert.deepEqual(restartFunction.rows, [{ definer: false, has_acl: true, public_execute: false }]);
    // The retained 0030 id CHECKs still bound explicit importer ids.
    for (const invalidId of ["0", String(MAX_TYPED_ID + 1n)]) {
      await assert.rejects(
        pool.query(`INSERT INTO ${table("typed_telemetry_namespaces")}(id, original_id) VALUES ($1::bigint, $2)`,
          [invalidId, randomBytes(24)]),
        (error) => error?.code === "23514",
      );
    }

    // Empty tables: next is 1 everywhere and the headroom holds.
    assert.deepEqual(await nextValues(pool, schema), everyTable(1));
    await withClient(pool, verify);

    // An insert without an id is allocated; an explicit importer id still works.
    assert.deepEqual(await insertTypedChain(pool, schema, { id: null, tag: "implicit-a" }), everyTable(1));
    assert.deepEqual(await insertTypedChain(pool, schema, { id: 500, tag: "imported" }), everyTable(500));

    // Imported ids now sit above every identity: the next live insert would
    // collide, so the headroom check refuses service.
    assert.deepEqual(await nextValues(pool, schema), everyTable(2));
    await withClient(pool, async (client) => {
      await assert.rejects(verify(client), isUnavailable);
    });

    await withClient(pool, restart);
    assert.deepEqual(await nextValues(pool, schema), everyTable(501));
    await withClient(pool, verify);
    assert.deepEqual(await insertTypedChain(pool, schema, { id: null, tag: "implicit-b" }), everyTable(501));
    // A lower unused explicit id is still accepted and does not disturb the headroom.
    await pool.query(`INSERT INTO ${table("typed_telemetry_namespaces")}(id, original_id) VALUES (250, $1)`,
      [randomBytes(24)]);
    await withClient(pool, verify);
    // Restarting again is idempotent: nothing is lowered or skipped.
    await withClient(pool, restart);
    assert.deepEqual(await nextValues(pool, schema), everyTable(502));

    // Every table is checked on its own: a single lagging identity fails the
    // whole check, and the restart repairs exactly that table.
    for (const name of TYPED_TABLES) {
      await pool.query(`ALTER TABLE ${table(name)} ALTER COLUMN id RESTART WITH 501`);
      await withClient(pool, async (client) => {
        await assert.rejects(verify(client), isUnavailable, `${name} lag must fail the headroom check`);
        await restart(client);
        await verify(client);
      });
      assert.deepEqual(await nextValues(pool, schema), everyTable(502));
    }

    // The restart never lowers an identity that already allocated further.
    await pool.query(`SELECT setval($1::regclass, 1000, true)`, [`"${schema}".typed_telemetry_owners_id_seq`]);
    await withClient(pool, restart);
    assert.deepEqual(await nextValues(pool, schema), { ...everyTable(502), typed_telemetry_owners: "1001" });
    await withClient(pool, verify);

    // An id at the top of the range leaves no headroom; the restart refuses
    // and rolls back instead of wrapping or exceeding the CHECK.
    await withClient(pool, async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(`INSERT INTO ${table("typed_telemetry_namespaces")}(id, original_id) VALUES ($1::bigint, $2)`,
          [String(MAX_TYPED_ID), randomBytes(24)]);
        await assert.rejects(verify(client), isUnavailable);
        await client.query("SAVEPOINT exhausted");
        await assert.rejects(client.query(`SELECT "${schema}".typed_telemetry_restart_identities()`),
          (error) => error?.code === "2200H" && error.message === "typed_telemetry_identity_exhausted");
        await client.query("ROLLBACK TO SAVEPOINT exhausted");
        await assert.rejects(restart(client), isUnavailable);
      } finally {
        await client.query("ROLLBACK");
      }
    });
    await withClient(pool, verify);

    // The runtime role (USAGE, DML and sequence USAGE/SELECT/UPDATE, as the
    // deployment grants) can allocate and verify but cannot restart.
    await pool.query(`CREATE ROLE "${runtimeRole}" NOLOGIN`);
    roleCreated = true;
    await pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${runtimeRole}"`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${runtimeRole}"`);
    await pool.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${runtimeRole}"`);
    await withClient(pool, async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
        await verify(client);
        const allocated = await client.query(`INSERT INTO ${table("typed_telemetry_namespaces")}(original_id)
          VALUES ($1) RETURNING id::text AS id`, [randomBytes(24)]);
        assert.equal(allocated.rows[0]?.id, "502");
        await verify(client);
        await client.query("SAVEPOINT runtime_restart");
        await assert.rejects(client.query(`SELECT "${schema}".typed_telemetry_restart_identities()`),
          (error) => error?.code === "42501");
        await client.query("ROLLBACK TO SAVEPOINT runtime_restart");
        await assert.rejects(restart(client), isUnavailable);
      } finally {
        await client.query("ROLLBACK");
      }
    });
  } finally {
    if (vite) await vite.close();
    if (schemaCreated) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    if (roleCreated) await pool.query(`DROP ROLE "${runtimeRole}"`);
    await pool.end();
  }
});

function importerFixture({ linkedParticipant, linklessParticipant, ownerDigest }) {
  const byte = (value, size = 24) => Buffer.alloc(size, value);
  const dictionary = [
    "openai_codex", "model-x", "standard", "default-tier", "cli", "codex-billing",
    "medium", "core", "success", "plus", "standard-variant", "five-hour",
    "primary", "shell",
  ].map((value, index) => ({ id: index + 1, value }));
  const linked = { participantState: "active", ownerLink: { ownerDigest, state: "active" } };
  const chunk = (id, format, stream, manifestId) => ({
    id, namespace_id: 500, format, owner_id: 500, device_id: format === 10 ? 499 : 500,
    manifest_id: manifestId, original_id: byte(id % 251), stream, chunk_day: DAY,
  });
  const record = (id, format, stream, chunkId) => ({
    id, namespace_id: 500, format, source_row_id: id, owner_id: 500,
    device_id: format === 10 ? 499 : 500, chunk_id: chunkId,
    manifest_id: format === 11 ? 500 : null, stream,
    occurrence_id: Buffer.from(`synthetic-occurrence-${id}`), observed_at_ms: OBSERVED_AT_MS,
    observed_day: DAY, provider_id: 1, canonical_digest: byte(id % 251, 32),
  });
  const usage = (recordId) => ({
    record_id: recordId, stream: 1, session_id: 499, model_id: 2, speed_mode_id: 3,
    api_service_tier_id: 4, surface_id: 5, billing_surface_id: 6, reasoning_effort_id: 7,
    agent_scope_id: 8, outcome_id: 9, attribution_id: null, total_input_context_tokens: 1000,
    input_uncached_tokens: 100, input_cache_read_tokens: 900, input_cache_write_tokens: 0,
    output_text_tokens: 50, output_reasoning_tokens: 25, output_combined_tokens: 75,
  });
  return {
    typed_telemetry_dictionary: dictionary,
    typed_telemetry_namespaces: [{ id: 500, original_id: byte(1) }],
    typed_telemetry_owners: [
      { id: 499, namespace_id: 500, original_id: byte(8) },
      { id: 500, namespace_id: 500, original_id: byte(2) },
    ],
    typed_telemetry_owner_memberships: [
      { namespace_id: 500, source_format: 10, owner_id: 500, participant_id: linkedParticipant,
        source_namespace: "synthetic-live-alloc-v1", authority: linked },
      { namespace_id: 500, source_format: 11, owner_id: 500, participant_id: linkedParticipant,
        source_namespace: "synthetic-live-alloc-v11", authority: linked },
      { namespace_id: 500, source_format: 11, owner_id: 499, participant_id: linklessParticipant,
        source_namespace: "synthetic-live-alloc-v11", authority: { participantState: "active", ownerLink: null } },
    ],
    typed_telemetry_devices: [
      { id: 499, namespace_id: 500, owner_id: 500, original_id: byte(3) },
      { id: 500, namespace_id: 500, owner_id: 500, original_id: byte(4) },
    ],
    typed_telemetry_manifests: [
      { id: 500, namespace_id: 500, owner_id: 500, device_id: 500, original_id: byte(5), chunk_day: DAY },
    ],
    typed_telemetry_identifiers: [
      { id: 499, namespace_id: 500, owner_id: 500, value: byte(6) },
      { id: 500, namespace_id: 500, owner_id: 500, value: byte(7) },
    ],
    typed_telemetry_attributions: [{
      id: 500, namespace_id: 500, owner_id: 500, account_basis: 0, account_track: Buffer.alloc(0),
      plan_basis: 0, plan_type_id: 10, plan_era: Buffer.alloc(0),
    }],
    typed_telemetry_quota_dimensions: [
      { id: 499, namespace_id: 500, owner_id: 500, plan_type_id: 10, plan_variant_id: 11, attribution_id: null },
      { id: 500, namespace_id: 500, owner_id: 500, plan_type_id: 10, plan_variant_id: 11, attribution_id: 500 },
    ],
    typed_telemetry_chunks: [
      chunk(496, 11, 3, 500), chunk(497, 10, 1, null), chunk(498, 10, 2, null),
      chunk(499, 10, 3, null), chunk(500, 11, 2, 500),
    ],
    typed_telemetry_records: [
      record(491, 10, 1, 497), record(492, 10, 1, 497), record(493, 10, 1, 497), record(494, 10, 1, 497),
      record(495, 10, 2, 498), record(496, 10, 3, 499), record(499, 11, 2, 500), record(500, 11, 3, 496),
    ],
    typed_telemetry_usage: [491, 492, 493, 494].map(usage),
    typed_telemetry_quota: [
      { record_id: 495, stream: 2, dimensions_id: 499, limit_id: 12, slot_id: 13, used_percent: 75,
        window_duration_minutes: 300, resets_at_ms: OBSERVED_AT_MS + 86_400_000 },
      { record_id: 499, stream: 2, dimensions_id: 500, limit_id: 12, slot_id: 13, used_percent: 75,
        window_duration_minutes: 300, resets_at_ms: OBSERVED_AT_MS + 86_400_000 },
    ],
    typed_telemetry_session_tools: [
      { record_id: 496, stream: 3, tool_class_id: 14, count: 2 },
      { record_id: 500, stream: 3, tool_class_id: 14, count: 2 },
    ],
  };
}

test("PG17 the typed-legacy importer writes explicit ids into the 0052 identities; restart then allocates 501", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const pool = await testPool();
  const suffix = randomBytes(5).toString("hex");
  const targetSchema = `${POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX}${suffix}`;
  const controlSchema = `${POSTGRES_TYPED_LEGACY_CONTROL_SCHEMA_PREFIX}${suffix}`;
  const schemaOptions = { primarySchema: targetSchema };
  let vite;
  let targetCreated = false;
  let controlCreated = false;
  try {
    const loaded = await loadAllocators();
    vite = loaded.vite;
    const { allocators } = loaded;
    await pool.query(`CREATE SCHEMA "${targetSchema}"`);
    targetCreated = true;
    await pool.query(`CREATE SCHEMA "${controlSchema}"`);
    controlCreated = true;
    await applyStockMigrations(pool, targetSchema);
    await applyStagedMigration(pool, targetSchema);
    assert.deepEqual(await nextValues(pool, targetSchema), everyTable(1));

    const linkedParticipant = await insertParticipant(pool, targetSchema, "linked");
    const linklessParticipant = await insertParticipant(pool, targetSchema, "linkless");
    const ownerDigest = randomBytes(32).toString("hex");
    await pool.query(`INSERT INTO "${targetSchema}".storage_v11_owner_links(participant_id, owner_digest, state)
      VALUES ($1, $2, 'active')`, [linkedParticipant, ownerDigest]);
    const source = createSyntheticD1TypedLegacyFixtureSource({
      rows: importerFixture({ linkedParticipant, linklessParticipant, ownerDigest }),
      snapshotId: "synthetic-d1-typed-live-allocators-v1",
    });
    const result = await runPostgresTypedLegacyTransfer({
      source, destinationPool: pool, targetSchema, controlSchema,
      transferId: `synthetic-live-alloc-${suffix}`, pageSize: 3,
    });
    assert.equal(result.status, "staged_rehearsal_complete");
    for (const name of TYPED_TABLES) {
      const imported = await pool.query(`SELECT max(id)::text AS max FROM "${targetSchema}"."${name}"`);
      assert.equal(imported.rows[0]?.max, "500", name);
    }

    // The importer wrote exact source ids and left every identity at 1.
    assert.deepEqual(await nextValues(pool, targetSchema), everyTable(1));
    await withClient(pool, async (client) => {
      await assert.rejects(allocators.verifyPostgresTypedIdentityHeadroom(client, schemaOptions), isUnavailable);
      await allocators.restartPostgresTypedIdentities(client, schemaOptions);
      await allocators.verifyPostgresTypedIdentityHeadroom(client, schemaOptions);
    });
    assert.deepEqual(await nextValues(pool, targetSchema), everyTable(501));
    assert.deepEqual(await insertTypedChain(pool, targetSchema, { id: null, tag: "after-import" }), everyTable(501));
    await withClient(pool, (client) => allocators.verifyPostgresTypedIdentityHeadroom(client, schemaOptions));
  } finally {
    if (vite) await vite.close();
    if (targetCreated) await pool.query(`DROP SCHEMA "${targetSchema}" CASCADE`);
    if (controlCreated) await pool.query(`DROP SCHEMA "${controlSchema}" CASCADE`);
    await pool.end();
  }
});

/** Poll until `waitingPid` is blocked by `blockingPid`, bounded so a missing wait fails instead of hanging. */
async function waitUntilBlocked(pool, waitingPid, blockingPid) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = await pool.query(
      "SELECT $2::integer = ANY(pg_catalog.pg_blocking_pids($1::integer)) AS blocked", [waitingPid, blockingPid],
    );
    if (result.rows[0]?.blocked === true) return;
    assert.ok(Date.now() < deadline, "the restart never waited for the in-flight explicit-id import");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

test("PG17 staged 0052 restarts over already-imported rows, refuses drifted identities and waits for in-flight imports", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const pool = await testPool();
  const schema = `typed_live_alloc_${randomBytes(6).toString("hex")}`;
  const schemaOptions = { primarySchema: schema };
  const table = (name) => `"${schema}"."${name}"`;
  const sequence = (name) => `"${schema}"."${name}_id_seq"`;
  let vite;
  let schemaCreated = false;
  try {
    const loaded = await loadAllocators();
    vite = loaded.vite;
    const { allocators } = loaded;
    const verify = (client) => allocators.verifyPostgresTypedIdentityHeadroom(client, schemaOptions);
    const restart = (client) => allocators.restartPostgresTypedIdentities(client, schemaOptions);

    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await applyStockMigrations(pool, schema);

    // Rows imported before 0052 exists (ids to 500 everywhere, 700 on
    // namespaces). Applying the migration alone, with no restart call, leaves
    // every identity just above its own table's max(id).
    assert.deepEqual(await insertTypedChain(pool, schema, { id: 500, tag: "pre-migration" }), everyTable(500));
    await pool.query(`INSERT INTO ${table("typed_telemetry_namespaces")}(id, original_id) VALUES (700, $1)`,
      [randomBytes(24)]);
    await applyStagedMigration(pool, schema);
    const applied = { ...everyTable(501), typed_telemetry_namespaces: "701" };
    assert.deepEqual(await nextValues(pool, schema), applied);
    await withClient(pool, verify);
    assert.deepEqual(await insertTypedChain(pool, schema, { id: null, tag: "post-migration" }), applied);
    const healthy = { ...everyTable(502), typed_telemetry_namespaces: "702" };
    assert.deepEqual(await nextValues(pool, schema), healthy);

    // Each drift runs in a transaction that is rolled back, after which the
    // schema must be exactly as healthy as before (sequence state included).
    const withRolledBack = async (label, operation) => {
      await withClient(pool, async (client) => {
        await client.query("BEGIN");
        try {
          await operation(client);
        } finally {
          await client.query("ROLLBACK");
        }
      });
      assert.deepEqual(await nextValues(pool, schema), healthy, `${label} must roll back`);
      await withClient(pool, verify);
    };

    // Every guard is reached on its own: each drift leaves the next value
    // above max(id), so only the named property can fail the check.
    const drifts = [
      ["GENERATED ALWAYS rejects importer ids", async (client, name) => {
        await client.query(`ALTER TABLE ${table(name)} ALTER COLUMN id SET GENERATED ALWAYS`);
      }],
      ["INCREMENT BY 2", async (client, name) => {
        await client.query(`ALTER TABLE ${table(name)} ALTER COLUMN id SET INCREMENT BY 2`);
      }],
      ["CYCLE", async (client, name) => {
        await client.query(`ALTER TABLE ${table(name)} ALTER COLUMN id SET CYCLE`);
      }],
      ["a same-named sequence that is not the column identity", async (client, name) => {
        await client.query(`ALTER SEQUENCE ${sequence(name)} RENAME TO "${name}_id_seq_detached"`);
        await client.query(`CREATE SEQUENCE ${sequence(name)} MINVALUE 1 MAXVALUE ${MAX_TYPED_ID} START WITH 1000`);
      }],
      ["the sequence MAXVALUE already issued", async (client, name) => {
        await client.query(`ALTER TABLE ${table(name)} ALTER COLUMN id SET MAXVALUE 600 RESTART WITH 600`);
        await verify(client);
        await client.query(`SELECT pg_catalog.nextval('${sequence(name)}'::regclass)`);
      }],
      ["a next value above the retained id range", async (client, name) => {
        await client.query(`ALTER TABLE ${table(name)} ALTER COLUMN id
          SET MAXVALUE 9223372036854775807 RESTART WITH ${MAX_TYPED_ID + 1n}`);
      }],
      ["the last id in the range already issued", async (client, name) => {
        await client.query(`ALTER TABLE ${table(name)} ALTER COLUMN id RESTART WITH ${MAX_TYPED_ID}`);
        await verify(client);
        await client.query(`SELECT pg_catalog.nextval('${sequence(name)}'::regclass)`);
      }],
    ];
    for (const [index, [label, drift]] of drifts.entries()) {
      const name = TYPED_TABLES[index];
      await withRolledBack(`${name}: ${label}`, async (client) => {
        await drift(client, name);
        await assert.rejects(verify(client), isUnavailable, `${name}: ${label} must fail the headroom check`);
      });
    }

    // An import at 2^53-2 restarts to 2^53-1, which verifies and allocates;
    // after that the range is exhausted and the restart refuses.
    await withRolledBack("restart to the last id", async (client) => {
      await client.query(`INSERT INTO ${table("typed_telemetry_namespaces")}(id, original_id) VALUES ($1::bigint, $2)`,
        [String(MAX_TYPED_ID - 1n), randomBytes(24)]);
      await restart(client);
      await verify(client);
      const allocated = await client.query(`INSERT INTO ${table("typed_telemetry_namespaces")}(original_id)
        VALUES ($1) RETURNING id::text AS id`, [randomBytes(24)]);
      assert.equal(allocated.rows[0]?.id, String(MAX_TYPED_ID));
      await assert.rejects(verify(client), isUnavailable);
      await client.query("SAVEPOINT exhausted");
      await assert.rejects(client.query(`SELECT "${schema}".typed_telemetry_restart_identities()`),
        (error) => error?.code === "2200H" && error.message === "typed_telemetry_identity_exhausted");
      await client.query("ROLLBACK TO SAVEPOINT exhausted");
    });

    // An explicit-id import still open when the restart starts. The up-front
    // ACCESS EXCLUSIVE lock makes the restart wait for it and read max(id)
    // afterwards; restarting from a max(id) read before the commit would hand
    // out 702 while 900 exists.
    const importer = await pool.connect();
    const restarter = await pool.connect();
    let importerOpen = false;
    let restarted;
    try {
      await importer.query("BEGIN");
      importerOpen = true;
      await importer.query(`INSERT INTO ${table("typed_telemetry_namespaces")}(id, original_id) VALUES (900, $1)`,
        [randomBytes(24)]);
      const importerPid = (await importer.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid;
      const restarterPid = (await restarter.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid;
      await restarter.query("SET lock_timeout = '20s'");
      restarted = restart(restarter).then(() => null, (error) => error);
      await waitUntilBlocked(pool, restarterPid, importerPid);
      await importer.query("COMMIT");
      importerOpen = false;
      assert.equal(await restarted, null);
    } finally {
      if (importerOpen) await importer.query("ROLLBACK").catch(() => {});
      if (restarted) await restarted;
      await restarter.query("RESET lock_timeout").catch(() => {});
      importer.release();
      restarter.release();
    }
    assert.deepEqual(await nextValues(pool, schema), { ...healthy, typed_telemetry_namespaces: "901" });
    await withClient(pool, verify);
  } finally {
    if (vite) await vite.close();
    if (schemaCreated) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
