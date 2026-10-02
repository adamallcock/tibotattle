// PostgreSQL 17 spec for the six admin console routes on the PostgreSQL origin
// (GCP, C-ADMIN), with parity against the d43c8f92 Worker's own DTO code.
//
// Parity method: the same synthetic, content-free fixture is written to
// PostgreSQL (the promoted primary and ledger chains) and to SQLite files that
// carry the Worker's D1 schemas (the production primary directories, the
// analytics database and the deletion ledger), opened through the reviewed
// D1 adapter (cloud-run/sealed-sqlite-d1-adapter.mjs). The expected body is
// computed by the Worker's code: the vendored d43c8f92 readAdminOverview and
// setCollectionControls (vendor/analytics-d43c8f92, byte copies), and this
// checkout's readGithubDistributionSnapshot, readDistributionAnalytics and
// readAdminDatabaseHealth, which are unchanged since d43c8f92 or, for the
// distribution reader, identical in behaviour for an unconfigured Cloudflare
// section. handleAdminOverview itself is not exported, so the spec composes
// it the way index.ts does: {...overview, ingress, distribution,
// reconstruction}.
//
// Fixture rows are seeded with foreign keys and triggers disabled on both
// sides (session_replication_role = replica; a SQLite connection without
// foreign keys), because the admin reads only count and order them.
//
// Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-.../socket PG_TEST_PORT=55433 \
//   node --test --test-concurrency=1 postgres-test/postgres-admin-console.spec.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { openSealedSqliteD1, sealedSqliteD1RuntimeSupported } from "../cloud-run/sealed-sqlite-d1-adapter.mjs";
import { postgresTestEndpoint } from "./staged-migrations-harness.mjs";
import { VENDORED_PACKAGE_ENTRIES, usesVendoredPackages } from "../vitest.analytics-v2.config.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STREAM_PREFIX = "c_admin";
const NOW_MS = Date.parse("2026-10-02T12:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();
const NAMESPACE = "00000000-0000-4000-8000-0000000000ad";
const SOURCE_ID = "synthetic-source-c-admin";
const OWNER = "owner@example.invalid";
const ORIGIN = "https://admin.example.invalid";
const REQUEST_ID = "4f2c8a7e-1b3d-4e5f-9a6b-7c8d9e0f1a2b";
const RUN_ID = "00000000-0000-4000-8000-0000000000c1";
const D1_PRIMARY_DIRECTORIES = Object.freeze([
  "migrations", "typed-ingestion-migrations", "ingestion-bridge-migrations",
  "typed-v11-admission-migrations", "typed-v1-admission-migrations", "ingestion-isolation-migrations",
]);
const ENV = Object.freeze({
  ENVIRONMENT: "production",
  ENROLLMENT_MODE: "open",
  ACCOUNT_SCOPED_INGEST_MODE: "disabled",
  TELEMETRY_STORAGE_MODE: "typed",
  TELEMETRY_STORAGE_NAMESPACE: NAMESPACE,
});

const endpoint = await postgresTestEndpoint();
const skip = endpoint === null ? "set PG_TEST_SOCKET or PG_TEST_HOST to a local PostgreSQL 17"
  : !sealedSqliteD1RuntimeSupported() ? "the D1 adapter needs Node.js 24.10 or newer" : false;

let vite;
let m;
let pool;
let schema;
let ledgerSchema;
let scratch;
let d1;
let d1Handles = [];

// ---------------------------------------------------------------------------
// Modules

async function loadModules() {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
    plugins: [{
      name: "c-admin-vendored-packages",
      enforce: "pre",
      resolveId(source, importer) {
        const entry = VENDORED_PACKAGE_ENTRIES[source];
        return entry && usesVendoredPackages(importer) ? entry : null;
      },
    }],
    resolve: { mainFields: ["module", "main"] },
    ssr: { noExternal: ["jsonc-parser"] },
  });
  const load = (path) => vite.ssrLoadModule(path);
  return {
    overview: await load("/src/postgres-admin-overview.ts"),
    preview: await load("/src/postgres-admin-allowance-preview.ts"),
    health: await load("/src/postgres-admin-database-health.ts"),
    distribution: await load("/src/postgres-admin-distribution.ts"),
    controls: await load("/src/postgres-admin-collection-controls.ts"),
    ingress: await load("/src/postgres-ingress-budget.ts"),
    adminConsole: await load("/cloud-run/routes/admin-console.mjs"),
    requestContext: await load("/cloud-run/postgres-request-context.mjs"),
    canonical: await load("/src/canonical-json.ts"),
    workerOperations: await load("/vendor/analytics-d43c8f92/apps/worker/src/admin-operations.ts"),
    workerGithub: await load("/src/github-distribution-history.ts"),
    workerDistribution: await load("/src/distribution-analytics.ts"),
    workerDatabaseHealth: await load("/src/admin-database-health.ts"),
    workerMetricsHistory: await load("/src/admin-metrics-history.ts"),
    kernels: await load("/vendor/analytics-d43c8f92/entry.ts"),
    contract: await load("/vendor/analytics-d43c8f92/packages/telemetry-contract/index.js"),
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL

function q(name, target = schema) {
  assert.match(target, /^c_admin_[a-z0-9_]{1,40}$/u);
  assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${target}"."${name}"`;
}

const pgColumns = new Map();

async function columnsOf(target, table) {
  const key = `${target}.${table}`;
  if (!pgColumns.has(key)) {
    const result = await pool.query(`SELECT column_name, data_type, is_nullable, column_default, is_identity
        FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`, [target, table]);
    assert.ok(result.rows.length > 0, `${table} exists in PostgreSQL`);
    pgColumns.set(key, new Map(result.rows.map((row) => [row.column_name, row])));
  }
  return pgColumns.get(key);
}

/** Insert the row's columns that exist in PostgreSQL; every required column must be supplied. */
async function pgInsert(client, table, row, target = schema) {
  const columns = await columnsOf(target, table);
  for (const [name, column] of columns) {
    if (column.is_nullable === "NO" && column.column_default === null && column.is_identity !== "YES") {
      assert.ok(Object.hasOwn(row, name), `fixture ${table}.${name} is required in PostgreSQL`);
    }
  }
  const names = Object.keys(row).filter((name) => columns.has(name));
  const values = names.map((name) => {
    const value = row[name];
    return columns.get(name).data_type === "boolean" && typeof value === "number" ? value === 1 : value;
  });
  await client.query(`INSERT INTO ${q(table, target)} (${names.map((name) => `"${name}"`).join(", ")})
    VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")})`, values);
}

async function withReplicaClient(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await work(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// D1 (SQLite)

async function buildSqlite(name, directories) {
  const path = join(scratch, `${name}.sqlite`);
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  try {
    for (const directory of directories) {
      const files = (await readdir(join(WORKER_ROOT, directory))).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files) database.exec(await readFile(join(WORKER_ROOT, directory, file), "utf8"));
    }
  } finally {
    database.close();
  }
  return path;
}

function sqliteInsert(database, table, row) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  assert.ok(columns.length > 0, `${table} exists in D1`);
  const names = new Set(columns.map((column) => column.name));
  for (const column of columns) {
    if (column.notnull && column.dflt_value === null && !column.pk) {
      assert.ok(Object.hasOwn(row, column.name), `fixture ${table}.${column.name} is required in D1`);
    }
  }
  const keys = Object.keys(row).filter((name) => names.has(name));
  const values = keys.map((name) => (typeof row[name] === "boolean" ? Number(row[name]) : row[name]));
  database.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
    .run(...values);
}

/**
 * Seed one SQLite file with its triggers and foreign keys off (the D1
 * counterpart of PostgreSQL's replica role), then restore every trigger.
 */
function withSqliteSeeding(path, work) {
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  try {
    const triggers = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all();
    for (const trigger of triggers) database.exec(`DROP TRIGGER "${trigger.name}"`);
    work(database);
    for (const trigger of triggers) database.exec(trigger.sql);
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Fixture (synthetic, content-free)

const hex = (seed) => seed.repeat(64).slice(0, 64);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const participant = (n) => `participant:00000000-0000-4000-8000-00000000000${n}`;
const P1 = participant(1);
const P2 = participant(2);
const P3 = participant(3);

function contribution(id, participantId, status, createdAt, r2Key) {
  return {
    id, participant_id: participantId, plaintext_digest: digest(`${id}:plaintext`), envelope_digest: digest(`${id}:envelope`),
    r2_key: r2Key, status, schema_version: "telemetry-contribution-v0.1",
    transport_schema_version: "telemetry-contribution-v0.1", range_start: "2026-09-01T00:00:00.000Z",
    range_end: "2026-09-02T00:00:00.000Z", client_platform: "synthetic", provider_policy_epoch: "synthetic",
    priced_event_coverage_percent: 100, unknown_model_event_count: 0, unknown_billable_units: 0,
    price_basis: "synthetic", declared_record_count: 1, accepted_record_count: 1, created_at: createdAt,
  };
}

function chunk(table, id, participantId, day, createdAt, records, extra = {}) {
  return {
    id, participant_id: participantId, device_id: "device:00000000-0000-4000-8000-0000000000d1",
    stream: "usage", chunk_day: day, chunk_seq: 0, chunk_digest: digest(`${id}:chunk`), envelope_digest: digest(`${id}:envelope`),
    parser_version: "synthetic-parser", record_count: records, r2_key: `telemetry/${table}/${id}`,
    device_upload_authorization_id: `authorization-${id}`, created_at: createdAt, ...extra,
  };
}

const FIXTURE = Object.freeze({
  participants: [
    { id: P1, owner_kind: "accountless", state: "active", created_at: "2026-10-02T06:00:00.000Z" },
    { id: P2, owner_kind: "accountless", state: "active", created_at: "2026-09-28T00:00:00.000Z" },
    { id: P3, owner_kind: "accountless", state: "deleting", deletion_session_id: "session-synthetic-3",
      created_at: "2026-08-01T00:00:00.000Z" },
  ],
  telemetry_contributions: [
    contribution("tc-1", P1, "accepted", "2026-10-02T08:00:00.000Z", "telemetry/tc-1"),
    contribution("tc-2", P2, "deleting", "2026-09-20T00:00:00.000Z", "telemetry/tc-2"),
    contribution("tc-3", P2, "accepted", "2026-09-01T00:00:00.000Z", "telemetry/tc-3"),
  ],
  telemetry_v1_chunks: [
    chunk("telemetry_v1_chunks", "chunk:00000000-0000-4000-8000-0000000001a1", P1, "2026-10-02", "2026-10-02T09:00:00.000Z", 5,
      { revision: 1, accepted_record_count: 5 }),
    chunk("telemetry_v1_chunks", "chunk:00000000-0000-4000-8000-0000000001a2", P2, "2026-09-15", "2026-09-15T00:00:00.000Z", 3,
      { revision: 1, accepted_record_count: 3, superseded_at: "2026-09-16T00:00:00.000Z" }),
    chunk("telemetry_v1_chunks", "chunk:00000000-0000-4000-8000-0000000001a3", P3, "2026-07-01", "2026-07-01T00:00:00.000Z", 4,
      { revision: 1, accepted_record_count: 2 }),
  ],
  telemetry_v11_domains: [{
    id: "00000000-0000-4000-8000-0000000011a1", participant_id: P2,
    device_id: "device:00000000-0000-4000-8000-0000000000d1", predecessor_token_hash: hex("e"),
    manifest_digest: hex("f"), legacy_fingerprint: hex("a"), input_revision: 1,
    from_day: "2026-09-29", through_day: "2026-09-29", days_json: "[\"2026-09-29\"]",
    created_at: "2026-09-29T00:00:00.000Z",
  }],
  telemetry_v11_domain_heads: [{ participant_id: P2, generation_id: "00000000-0000-4000-8000-0000000011a1",
    revision: 1, updated_at: "2026-09-29T00:00:00.000Z" }],
  telemetry_v11_domain_days: [{ generation_id: "00000000-0000-4000-8000-0000000011a1",
    observed_day: "2026-09-29", manifest_id: "manifest-v11-1" }],
  telemetry_v11_chunks: [
    chunk("telemetry_v11_chunks", "chunk:00000000-0000-4000-8000-0000000011a1", P2, "2026-09-29", "2026-09-29T00:00:00.000Z", 7,
      { manifest_id: "manifest-v11-1", chunk_id: "v11-chunk-1" }),
  ],
  telemetry_v12_domain_heads: [{ participant_id: P1, generation_id: "generation-v12-current",
    revision: 2, updated_at: "2026-10-01T10:00:00.000Z" }],
  telemetry_v12_domain_days: [{ generation_id: "generation-v12-current", observed_day: "2026-10-01",
    manifest_id: "manifest-v12-current", manifest_digest: hex("9") }],
  telemetry_v12_chunks: [
    chunk("telemetry_v12_chunks", "chunk:00000000-0000-4000-8000-0000000012a1", P1, "2026-10-01", "2026-10-01T10:00:00.000Z", 4,
      { manifest_id: "manifest-v12-current", chunk_id: "v12-chunk-1" }),
    chunk("telemetry_v12_chunks", "chunk:00000000-0000-4000-8000-0000000012a2", P1, "2026-09-01", "2026-09-01T00:00:00.000Z", 2,
      { manifest_id: "manifest-v12-superseded", chunk_id: "v12-chunk-2" }),
  ],
  pending_quarantine_objects: [
    { r2_key: "telemetry/telemetry_v1_chunks/chunk:00000000-0000-4000-8000-0000000001a1", contribution_id: "chunk:00000000-0000-4000-8000-0000000001a1", object_kind: "telemetry",
      registered_at: "2026-10-02T10:00:00.000Z", reconciliation_state: "registered" },
    { r2_key: "telemetry/orphan-1", contribution_id: "orphan-1", object_kind: "telemetry",
      registered_at: "2026-10-01T00:00:00.000Z", reconciliation_state: "registered" },
    { r2_key: "telemetry/fresh-1", contribution_id: "fresh-1", object_kind: "telemetry",
      registered_at: "2026-10-02T11:30:00.000Z", reconciliation_state: "registered" },
    { r2_key: "telemetry/telemetry_v12_chunks/chunk:00000000-0000-4000-8000-0000000012a1", contribution_id: "chunk:00000000-0000-4000-8000-0000000012a1", object_kind: "telemetry",
      registered_at: "2026-10-01T12:00:00.000Z", reconciliation_state: "registered" },
  ],
  diagnostic_error_events: [
    { id: 1, request_id: "10000000-0000-4000-8000-000000000001", route_class: "contributions",
      error_code: "BACKEND_STORAGE_UNAVAILABLE", status: 503, occurred_at: "2026-10-01T00:00:00.000Z" },
    { id: 2, request_id: "10000000-0000-4000-8000-000000000002", route_class: "contributions",
      error_code: "BACKEND_STORAGE_UNAVAILABLE", status: 503, occurred_at: "2026-10-02T01:00:00.000Z" },
    { id: 3, request_id: REQUEST_ID, route_class: "ready",
      error_code: "INTERNAL_ERROR", status: 500, occurred_at: "2026-09-30T00:00:00.000Z" },
    { id: 4, request_id: "10000000-0000-4000-8000-000000000004", route_class: "health",
      error_code: "INTERNAL_ERROR", status: 500, occurred_at: "2026-08-01T00:00:00.000Z" },
  ],
  admin_action_audit: [
    { id: 1, operation_id: "20000000-0000-4000-8000-000000000001", action: "set_collection_controls",
      actor_identity_digest: hex("d"), outcome: "success", details_json: "{\"revision\":5}",
      created_at: "2026-09-30T00:00:00.000Z" },
    { id: 2, operation_id: null, action: "run_maintenance", actor_identity_digest: hex("d"),
      outcome: "failure", details_json: "{\"code\":\"INTERNAL_ERROR\"}", created_at: "2026-10-01T00:00:00.000Z" },
    { id: 3, operation_id: "20000000-0000-4000-8000-000000000003", action: "sync_distribution",
      actor_identity_digest: hex("d"), outcome: "started", details_json: "{\"phase\":\"started\"}",
      created_at: "2026-10-01T00:00:00.000Z" },
  ],
  github_distribution_snapshots: [
    { observed_at: "2026-09-25T00:00:00.000Z", completed_at: "2026-09-25T00:00:01.000Z" },
    { observed_at: "2026-10-02T00:00:00.000Z", completed_at: "2026-10-02T00:00:01.000Z" },
  ],
  github_release_snapshots: [
    { observed_at: "2026-09-25T00:00:00.000Z", release_id: 11, release_tag: "v0.1.30",
      release_published_at: "2026-09-20T10:00:00Z", release_prerelease: 0 },
    { observed_at: "2026-10-02T00:00:00.000Z", release_id: 11, release_tag: "v0.1.30",
      release_published_at: "2026-09-20T10:00:00Z", release_prerelease: 0 },
    { observed_at: "2026-10-02T00:00:00.000Z", release_id: 12, release_tag: "v0.1.31-beta",
      release_published_at: "2026-10-01T09:30:00Z", release_prerelease: 1 },
  ],
  github_release_asset_snapshots: [
    { observed_at: "2026-09-25T00:00:00.000Z", release_id: 11, release_tag: "v0.1.30",
      release_published_at: "2026-09-20T10:00:00Z", release_prerelease: 0, asset_id: 101,
      asset_name: "TiboTattle-0.1.30-arm64.dmg", asset_digest: null, asset_download_count: 40, is_dmg: 1 },
    { observed_at: "2026-09-25T00:00:00.000Z", release_id: 11, release_tag: "v0.1.30",
      release_published_at: "2026-09-20T10:00:00Z", release_prerelease: 0, asset_id: 102,
      asset_name: "TiboTattle-0.1.30-x64.dmg", asset_digest: null, asset_download_count: 9, is_dmg: 1 },
    { observed_at: "2026-10-02T00:00:00.000Z", release_id: 11, release_tag: "v0.1.30",
      release_published_at: "2026-09-20T10:00:00Z", release_prerelease: 0, asset_id: 101,
      asset_name: "TiboTattle-0.1.30-arm64.dmg", asset_digest: `sha256:${hex("4")}`,
      asset_download_count: 55, is_dmg: 1 },
    { observed_at: "2026-10-02T00:00:00.000Z", release_id: 11, release_tag: "v0.1.30",
      release_published_at: "2026-09-20T10:00:00Z", release_prerelease: 0, asset_id: 102,
      asset_name: "TiboTattle-0.1.30-x64.dmg", asset_digest: null, asset_download_count: 8, is_dmg: 1 },
    { observed_at: "2026-10-02T00:00:00.000Z", release_id: 12, release_tag: "v0.1.31-beta",
      release_published_at: "2026-10-01T09:30:00Z", release_prerelease: 1, asset_id: 201,
      asset_name: "TiboTattle-0.1.31-beta-x64.exe", asset_digest: null, asset_download_count: 3, is_dmg: 0 },
  ],
  deletion_tombstones: [
    { participant_digest: hex("5"), schema_version: "participant-deletion-tombstone-v0.1",
      deleted_at: "2026-09-01T00:00:00.000Z", retain_until: "2027-09-01T00:00:00.000Z" },
    { participant_digest: hex("6"), schema_version: "participant-deletion-tombstone-v0.1",
      deleted_at: "2026-08-01T00:00:00.000Z", retain_until: "2027-08-01T00:00:00.000Z" },
  ],
});

const SINGLETONS = Object.freeze({
  collection_controls: {
    singleton: 1, schema_version: "collection-controls-v0.1", revision: 5, control_state: "degraded",
    enrollment_enabled: 1, upload_registration_enabled: 1, processing_enabled: 1, publication_enabled: 0,
    reason_code: "maintenance", updated_at: "2026-09-30T00:00:00.000Z",
  },
  retention_state: {
    singleton: 1, schema_version: "backend-retention-v0.1", state: "completed",
    last_started_at: "2026-10-02T11:00:00.000Z", last_completed_at: "2026-10-02T11:00:05.000Z",
    maintenance_run_at: "2026-10-02T11:00:00.000Z", quarantine_cutoff_at: "2026-10-02T10:00:00.000Z",
    quarantine_objects_deleted: 2, quarantine_retention_complete: 1, restored_participants_suppressed: 1,
    restore_replay_complete: 1, failure_code: null,
  },
  quarantine_reconciliation_state: {
    singleton: 1, schema_version: "quarantine-reconciliation-v0.1", state: "completed",
    last_started_at: "2026-10-02T11:00:01.000Z", last_completed_at: "2026-10-02T11:00:04.000Z",
    maintenance_run_at: "2026-10-02T11:00:00.000Z", cutoff_at: "2026-10-02T10:00:00.000Z",
    registrations_examined: 6, orphan_objects_deleted: 1, referenced_objects_preserved: 3,
    reconciliation_complete: 1, failure_code: null,
  },
  github_distribution_sync_state: {
    singleton: 1, last_attempted_at: "2026-10-02T00:00:00.000Z", last_success_at: "2026-10-02T00:00:00.000Z",
    last_failure_code: null, last_observed_at: "2026-10-02T00:00:00.000Z", lease_token: null,
    lease_expires_at: null,
  },
});

const LATEST_DAILY = Object.freeze({ day: "2026-10-01", releasedAt: "2026-10-02T00:05:00.000Z" });

function dailyPayload() {
  return {
    aggregateId: `community-daily:${LATEST_DAILY.day}:r1`, day: LATEST_DAILY.day, revision: 1,
    releasedAt: LATEST_DAILY.releasedAt, synthetic: true,
  };
}

async function seedPostgres() {
  await withReplicaClient(async (client) => {
    for (const [table, row] of Object.entries(SINGLETONS)) {
      await client.query(`DELETE FROM ${q(table)}`);
      await pgInsert(client, table, row);
    }
    for (const [table, rows] of Object.entries(FIXTURE)) {
      if (table === "deletion_tombstones") continue;
      for (const row of rows) await pgInsert(client, table, row);
    }
    for (const row of FIXTURE.deletion_tombstones) await pgInsert(client, "deletion_tombstones", row, ledgerSchema);
    // Explicit fixture ids: move the identity sequences past them, as D1's AUTOINCREMENT does.
    for (const table of ["admin_action_audit", "diagnostic_error_events"]) {
      await client.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), (SELECT max(id) FROM ${q(table)}))`,
        [`"${schema}"."${table}"`]);
    }
    await client.query(`DELETE FROM ${q("storage_source_state")}`);
    await pgInsert(client, "storage_source_state", { singleton: 1, source_id: SOURCE_ID, authority_epoch: 0 });
    for (const table of ["typed_v1_admission_state", "typed_v11_admission_state"]) {
      await client.query(`DELETE FROM ${q(table)}`);
      await pgInsert(client, table, { id: 1, source_namespace: NAMESPACE, namespace_id: 1,
        runtime_contract_version: 1, next_source_row_id: 1 });
    }
    await pgInsert(client, "analytics_v2_published_daily", {
      day: LATEST_DAILY.day, revision: 1, released_at: LATEST_DAILY.releasedAt,
      payload: JSON.stringify(dailyPayload()), payload_sha256: hex("7"), run_id: RUN_ID,
    });
  });
}

async function seedD1() {
  const primary = await buildSqlite("primary", D1_PRIMARY_DIRECTORIES);
  const analytics = await buildSqlite("analytics", ["analytics-migrations"]);
  const ledger = await buildSqlite("ledger", ["deletion-ledger-migrations"]);
  withSqliteSeeding(primary, (database) => {
    for (const [table, row] of Object.entries(SINGLETONS)) sqliteInsert(database, table, row);
    for (const [table, rows] of Object.entries(FIXTURE)) {
      if (table === "deletion_tombstones") continue;
      for (const row of rows) sqliteInsert(database, table, row);
    }
    sqliteInsert(database, "storage_source_state", { singleton: 1, source_id: SOURCE_ID });
    for (const table of ["typed_v1_admission_state", "typed_v11_admission_state"]) {
      sqliteInsert(database, table, { id: 1, source_namespace: NAMESPACE, namespace_id: 1,
        runtime_contract_version: 1, next_source_row_id: 1 });
    }
  });
  withSqliteSeeding(ledger, (database) => {
    for (const row of FIXTURE.deletion_tombstones) sqliteInsert(database, "deletion_tombstones", row);
  });
  withSqliteSeeding(analytics, (database) => {
    sqliteInsert(database, "analytics_runtime_sources", { source_id: SOURCE_ID, source_namespace: NAMESPACE,
      contract_version: 1 });
    sqliteInsert(database, "analytics_community_daily_publications", {
      source_id: SOURCE_ID, day: LATEST_DAILY.day, revision: 1, cohort_digest: hex("8"), authority_json: "{}",
      payload_json: JSON.stringify(dailyPayload()), payload_sha256: hex("7"), released_at: LATEST_DAILY.releasedAt,
    });
    sqliteInsert(database, "analytics_community_daily_heads", {
      source_id: SOURCE_ID, day: LATEST_DAILY.day, revision: 1, cohort_digest: hex("8"),
    });
  });
  const handles = {
    primary: openSealedSqliteD1(primary, { pinnedNowMs: NOW_MS }),
    analytics: openSealedSqliteD1(analytics, { pinnedNowMs: NOW_MS }),
    ledger: openSealedSqliteD1(ledger, { pinnedNowMs: NOW_MS }),
  };
  d1Handles = Object.values(handles);
  return Object.fromEntries(Object.entries(handles).map(([name, handle]) => [name, handle.database]));
}

// ---------------------------------------------------------------------------
// The Worker's composition (d43c8f92 handleAdminOverview, typed storage mode)

async function workerOverview({ diagnosticReference } = {}) {
  const storage = { source: d1.primary, target: d1.analytics, sourceId: SOURCE_ID, sourceNamespace: NAMESPACE };
  const [overview, githubSnapshot] = await Promise.all([
    m.workerOperations.readAdminOverview(d1.primary, d1.ledger, {
      environment: ENV.ENVIRONMENT,
      enrollmentMode: ENV.ENROLLMENT_MODE,
      accountScopedIngestMode: ENV.ACCOUNT_SCOPED_INGEST_MODE,
      diagnosticReference,
      nowEpoch: NOW_MS,
      storage,
    }),
    m.workerGithub.readGithubDistributionSnapshot(d1.primary, NOW_MS)
      .catch(() => m.workerGithub.githubUnavailable("unavailable", "GITHUB_SNAPSHOT_UNAVAILABLE")),
  ]);
  const distribution = await m.workerDistribution.readDistributionAnalytics({
    enabled: true, cloudflareZoneId: undefined, cloudflareApiToken: undefined,
    githubApiToken: undefined, githubSnapshot,
  }, NOW_MS, () => Promise.reject(new Error("no network in the parity spec")));
  const reconstruction = { schemaVersion: "admin-reconstruction-progress-v0.1", observedAt: NOW_ISO,
    mode: "resumable", status: "unavailable" };
  // readUploadIngressStatus is null without an ingress binding, on both sides.
  return { ...overview, ingress: null, distribution, reconstruction };
}

function sourcesFrom(expected) {
  return {
    syntheticContributions: async () => expected.counts.contributions.synthetic,
    historicalPublication: async () => expected.historicalPublication,
    deletionLedger: () => m.overview.readPostgresAdminDeletionLedger(pool, ledgerSchema),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle

before(async () => {
  if (skip) return;
  m = await loadModules();
  pool = new pg.Pool({ ...endpoint, ssl: false, max: 6, application_name: "c-admin-console-test",
    connectionTimeoutMillis: 5_000 });
  const version = await pool.query("SELECT version() AS version");
  assert.match(version.rows[0]?.version ?? "", /^PostgreSQL 17\./u);
  const suffix = randomBytes(5).toString("hex");
  schema = `${STREAM_PREFIX}_p_${suffix}`;
  ledgerSchema = `${STREAM_PREFIX}_l_${suffix}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`CREATE SCHEMA "${ledgerSchema}"`);
  await applyPostgresMigrations({ role: "primary", schema, pool });
  await applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool });
  scratch = await realpath(await mkdtemp(join(tmpdir(), "c-admin-d1-")));
  await seedPostgres();
  d1 = await seedD1();
});

after(async () => {
  for (const handle of d1Handles) handle.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  if (pool) {
    if (schema) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (ledgerSchema) await pool.query(`DROP SCHEMA IF EXISTS "${ledgerSchema}" CASCADE`);
    await pool.end();
  }
  await vite?.close();
});

async function apiError(promise) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error?.name, "ApiError", String(error));
    return `${error.status} ${error.code}`;
  }
  return assert.fail("expected an ApiError");
}

// ---------------------------------------------------------------------------
// Overview

test("overview deep-equals the d43c8f92 Worker's typed overview over the same evidence", { skip }, async () => {
  const expected = await workerOverview({ diagnosticReference: REQUEST_ID });
  const actual = await m.overview.readPostgresAdminOverview({
    pool, schema, env: ENV, nowEpoch: NOW_MS, diagnosticReference: REQUEST_ID, sources: sourcesFrom(expected),
  });
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), "byte-identical JSON, key order included");
  // The fixture exercises every count it claims to.
  const contributions = actual.counts.contributions;
  assert.deepEqual(contributions.incrementalChunks,
    { total: 6, bounded: false, current: 4, acceptedLast24Hours: 1, acceptedLast7Days: 3 });
  assert.deepEqual(contributions.contributingAccounts,
    { total: 3, bounded: false, acceptedLast24Hours: 1, acceptedLast7Days: 2, acceptedLast30Days: 2 });
  assert.equal(contributions.storedTelemetryRecords, 5 + 3 + 2 + 7 + 4 + 2);
  assert.deepEqual([actual.quarantine.withinGrace, actual.quarantine.dueReferenced,
    actual.quarantine.dueUnreferenced], [1, 2, 1]);
  assert.equal(actual.errors.groups[0].occurrences, 2);
  assert.equal(actual.errors.lookup.requestId, REQUEST_ID);
  assert.deepEqual(actual.deletionLedger, { total: 2, bounded: false, earliestRetainUntil: "2027-08-01T00:00:00.000Z" });
  assert.equal(actual.distribution.github.status, "available");
  assert.equal(actual.distribution.github.history.counterRegressions, 1);
  assert.equal(actual.distribution.cloudflare.status, "not_configured");
  assert.deepEqual(actual.dailyPublication, { latestEvidenceDay: "2026-10-01",
    latestReleasedAt: "2026-10-02T00:05:00.000Z", pendingRebuilds: 0, pendingRebuildsBounded: false });
});

test("overview blocks without a GCP source are the Worker's 503, never zeros", { skip }, async () => {
  const expected = await workerOverview();
  const full = sourcesFrom(expected);
  for (const missing of ["syntheticContributions", "historicalPublication", "deletionLedger"]) {
    const sources = { ...full };
    delete sources[missing];
    assert.equal(await apiError(m.overview.readPostgresAdminOverview({
      pool, schema, env: ENV, nowEpoch: NOW_MS, sources,
    })), "503 BACKEND_STORAGE_UNAVAILABLE", missing);
  }
  assert.equal(await apiError(m.overview.readPostgresAdminOverview({
    pool, schema, env: ENV, nowEpoch: NOW_MS,
  })), "503 BACKEND_STORAGE_UNAVAILABLE");
  // A json-mode or mismatched namespace env is refused, not served from typed rows.
  for (const env of [
    Object.freeze({ ...ENV, TELEMETRY_STORAGE_MODE: "json" }),
    Object.freeze({ ...ENV, TELEMETRY_STORAGE_NAMESPACE: "00000000-0000-4000-8000-0000000000ae" }),
    Object.freeze({ ...ENV, TELEMETRY_STORAGE_NAMESPACE: "not a namespace" }),
  ]) {
    assert.equal(await apiError(m.overview.readPostgresAdminOverview({
      pool, schema, env, nowEpoch: NOW_MS, sources: full,
    })), "503 BACKEND_STORAGE_UNAVAILABLE");
  }
  // An unknown schema fails closed with the controls reader's own code, as
  // the Worker's overview does when its controls row cannot be read.
  assert.equal(await apiError(m.overview.readPostgresAdminOverview({
    pool, schema: "c_admin_absent", env: ENV, nowEpoch: NOW_MS, sources: full,
  })), "503 COLLECTION_CONTROL_UNAVAILABLE");
  assert.equal(await apiError(m.overview.readPostgresAdminOverview({
    pool, schema, env: ENV, nowEpoch: NOW_MS, sources: full, diagnosticReference: "x",
  })), "400 BODY_INVALID");
});

test("pending daily rebuilds are the days the journal names after the refresh cursor", { skip }, async () => {
  const expected = await workerOverview();
  const read = () => m.overview.readPostgresAdminOverview({
    pool, schema, env: ENV, nowEpoch: NOW_MS, sources: sourcesFrom(expected),
  });
  await withReplicaClient(async (client) => {
    await pgInsert(client, "typed_v1_event_sources", { event_digest: hex("a"), owner_digest: hex("b"),
      participant_id: P1, chunk_id: "chunk:00000000-0000-4000-8000-0000000001a1", source_namespace: NAMESPACE });
    await pgInsert(client, "storage_ingestion_changes", { source_id: SOURCE_ID, sequence: 1,
      event_digest: hex("a"), owner_digest: hex("b"), owner_revision: 1, authority_epoch: 0,
      kind: "source-updated", recorded_ms: NOW_MS - 1_000 });
    // A terminal event names no day, exactly as the refresh job reads it.
    await pgInsert(client, "storage_ingestion_changes", { source_id: SOURCE_ID, sequence: 2,
      event_digest: hex("c"), owner_digest: hex("d"), owner_revision: 1, authority_epoch: 0,
      kind: "owner-withdrawn", recorded_ms: NOW_MS - 500 });
  });
  try {
    assert.deepEqual((await read()).dailyPublication.pendingRebuilds, 1);
    await withReplicaClient((client) => pgInsert(client, "analytics_v2_journal_cursor",
      { id: 1, last_sequence: 2, run_id: RUN_ID }));
    assert.deepEqual((await read()).dailyPublication.pendingRebuilds, 0);
  } finally {
    await withReplicaClient(async (client) => {
      for (const table of ["analytics_v2_journal_cursor", "storage_ingestion_changes", "typed_v1_event_sources"]) {
        await client.query(`DELETE FROM ${q(table)}`);
      }
    });
  }
});

// The production origin's ingress policy (postgres-production-configuration.mjs).
const INGRESS_POLICY_ENV = Object.freeze({
  UPLOAD_INGRESS_MAX_CONCURRENT: "8",
  UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE: "120",
  UPLOAD_INGRESS_BURST: "16",
  UPLOAD_INGRESS_LEASE_SECONDS: "90",
});

test("overview ingress is the Worker's readUploadIngressStatus over the PostgreSQL budget binding", { skip }, async () => {
  const expected = await workerOverview();
  const budget = m.ingress.createPostgresUploadIngressBudget(pool, { primarySchema: schema });
  const requestedNames = [];
  // The binding shape cloud-run/server.mjs composes.
  const binding = (stub) => Object.freeze({ getByName: (name) => { requestedNames.push(name); return stub; } });
  const read = (env) => m.overview.readPostgresAdminOverview({
    pool, schema, env, nowEpoch: NOW_MS, sources: sourcesFrom(expected),
  });
  const budgetState = q("upload_ingress_budget_states");
  try {
    const fresh = await read(Object.freeze({ ...ENV, ...INGRESS_POLICY_ENV, UPLOAD_INGRESS_BUDGET: binding(budget) }));
    assert.deepEqual(requestedNames, ["upload-ingress-budget-v0.1"]);
    assert.deepEqual(fresh.ingress, { activeLeases: 0, maximumConcurrent: 8, availableStartTokens: 16, burst: 16,
      concurrencyDenials: 0, startRateDenials: 0, lastDeniedAt: null });
    // Only the ingress block differs from the Worker's body over the same evidence.
    assert.equal(JSON.stringify(fresh), JSON.stringify({ ...expected, ingress: fresh.ingress }));

    // Recorded denials are served from the PostgreSQL budget row.
    await pool.query(`UPDATE ${budgetState} SET concurrency_denials = 3, start_rate_denials = 2,
        last_denied_at = '2026-10-02T11:59:00Z' WHERE budget_name = 'upload-ingress-budget-v0.1'`);
    const denied = await read(Object.freeze({ ...ENV, ...INGRESS_POLICY_ENV, UPLOAD_INGRESS_BUDGET: binding(budget) }));
    assert.deepEqual([denied.ingress.concurrencyDenials, denied.ingress.startRateDenials, denied.ingress.lastDeniedAt],
      [3, 2, "2026-10-02T11:59:00.000Z"]);

    // Every malformed or failing status degrades the block to null; the rest
    // of the overview is still served.
    const validStatus = { activeLeases: 0, maximumConcurrent: 8, availableStartTokens: 16, burst: 16,
      concurrencyDenials: 0, startRateDenials: 0, lastDeniedAtEpoch: null };
    for (const env of [
      Object.freeze({ ...ENV, ...INGRESS_POLICY_ENV,
        UPLOAD_INGRESS_BUDGET: binding({ status: async () => ({ ...validStatus, activeLeases: -1 }) }) }),
      Object.freeze({ ...ENV, ...INGRESS_POLICY_ENV,
        UPLOAD_INGRESS_BUDGET: binding({ status: async () => ({ ...validStatus, burst: 1_201 }) }) }),
      Object.freeze({ ...ENV, ...INGRESS_POLICY_ENV,
        UPLOAD_INGRESS_BUDGET: binding({ status: async () => ({ ...validStatus, lastDeniedAtEpoch: "x" }) }) }),
      Object.freeze({ ...ENV, ...INGRESS_POLICY_ENV, UPLOAD_INGRESS_BUDGET: binding({ status: async () => null }) }),
      Object.freeze({ ...ENV, ...INGRESS_POLICY_ENV,
        UPLOAD_INGRESS_BUDGET: binding({ status: async () => { throw new Error("synthetic"); } }) }),
      Object.freeze({ ...ENV, ...INGRESS_POLICY_ENV, UPLOAD_INGRESS_BUDGET: Object.freeze({}) }),
      Object.freeze({ ...ENV, ...INGRESS_POLICY_ENV, UPLOAD_INGRESS_BURST: "0",
        UPLOAD_INGRESS_BUDGET: binding(budget) }),
    ]) {
      const body = await read(env);
      assert.equal(body.ingress, null);
      assert.equal(JSON.stringify(body), JSON.stringify(expected));
    }
  } finally {
    await pool.query(`DELETE FROM ${budgetState}`);
  }
});

test("a failed GitHub snapshot read is the Worker's own unavailable block", { skip }, async () => {
  await pool.query(`ALTER TABLE ${q("github_release_asset_snapshots")} RENAME TO c_admin_hidden_assets`);
  try {
    const block = await m.distribution.readPostgresGithubDistributionSnapshot(pool, schema, NOW_MS);
    assert.deepEqual(block, m.workerGithub.githubUnavailable("unavailable", "GITHUB_SNAPSHOT_UNAVAILABLE"));
  } finally {
    await pool.query(`ALTER TABLE ${q("c_admin_hidden_assets")} RENAME TO github_release_asset_snapshots`);
  }
  assert.equal(m.distribution.POSTGRES_ADMIN_DISTRIBUTION_STATEMENT_COUNT, 6);
  // Outside production the block is the Worker's disabled one and reads nothing.
  const refusing = { connect: async () => { throw new Error("no read outside production"); } };
  const disabled = await m.distribution.readPostgresAdminDistribution(refusing, schema,
    Object.freeze({ ENVIRONMENT: "staging" }), NOW_MS);
  assert.equal(disabled.github.reasonCode, "DISTRIBUTION_DISABLED");
  assert.equal(disabled.cloudflare.reasonCode, "DISTRIBUTION_DISABLED");
});

// ---------------------------------------------------------------------------
// Database health

function d1Binding({ fail = false, size = 4096 } = {}) {
  return {
    prepare() {
      return {
        async all() {
          if (fail) throw new Error("synthetic failure");
          return { success: true, results: [{ reachable: 1 }], meta: { size_after: size } };
        },
      };
    },
  };
}

function shape(body) {
  return JSON.parse(JSON.stringify(body, (key, value) => (
    (key === "responseMs" || key === "databaseBytes") && typeof value === "number" ? "<n>"
      : key === "observedAt" ? "<t>" : value)));
}

test("database health keeps the Worker's closed DTO, role order and statuses", { skip }, async () => {
  const failing = { connect: async () => { throw new Error("synthetic"); } };
  const hanging = { connect: () => new Promise(() => {}) };
  const cases = [
    // [env, pools, Worker bindings]
    [ENV, { primary: pool, analytics: pool }, { USAGE_MONITOR_DB: d1Binding(), ANALYTICS_DB: d1Binding() }],
    [ENV, { primary: pool, deletionLedger: pool, analytics: pool },
      { USAGE_MONITOR_DB: d1Binding(), DELETION_LEDGER: d1Binding(), ANALYTICS_DB: d1Binding() }],
    [Object.freeze({ TELEMETRY_STORAGE_MODE: "json" }), { primary: pool, deletionLedger: failing },
      { USAGE_MONITOR_DB: d1Binding(), DELETION_LEDGER: d1Binding({ fail: true }) }],
    [Object.freeze({ TELEMETRY_STORAGE_MODE: "bogus" }), { primary: pool },
      { USAGE_MONITOR_DB: d1Binding() }],
  ];
  for (const [env, pools, bindings] of cases) {
    const actual = await m.health.readPostgresAdminDatabaseHealth({ env, pools, clock: Date.now });
    const expected = await m.workerDatabaseHealth.readAdminDatabaseHealth({ ...env, ...bindings });
    assert.deepEqual(shape(actual), shape(expected));
    assert.equal(JSON.stringify(Object.keys(actual)), JSON.stringify(Object.keys(expected)));
    const primary = actual.databases[0];
    assert.equal(primary.status, "reachable");
    assert.ok(Number.isSafeInteger(primary.databaseBytes) && primary.databaseBytes > 0);
  }
  const slow = await m.health.readPostgresAdminDatabaseHealth({
    env: ENV, pools: { primary: pool, deletionLedger: hanging, analytics: pool }, probeTimeoutMs: 50,
  });
  assert.deepEqual(slow.databases[1], { role: "deletion_ledger", status: "timeout", responseMs: null,
    databaseBytes: null });
  assert.equal(slow.status, "degraded");
});

// ---------------------------------------------------------------------------
// Allowance preview

function modelDay(day, values) {
  const value = m.contract.projectAdminModelHistoryDay({
    day, catalogVersion: m.contract.ADMIN_MODEL_HISTORY_CATALOG_VERSION, values,
    fittedParticipantCount: 1, unstableParticipantCount: 0, staleParticipantCount: 0,
    refusedParticipantCount: 0, v1ParticipantCount: 1, unsupportedSourceParticipantCount: 0,
  });
  assert.notEqual(value, null);
  return value;
}

const DAY_MS = 86_400_000;

/** A preview built at nowMs; its evidence dates sit two and three days earlier. */
function syntheticPreview(nowMs) {
  const at = (days) => new Date(nowMs - days * DAY_MS).toISOString();
  return m.kernels.buildAdminCommunityAllowancePreview([
    { participantId: "synthetic-participant-pro", planType: "pro",
      capacityNanousd: 1_200_000_000_000, lastObservedAt: at(2) },
    { participantId: "synthetic-participant-plus", planType: "plus",
      capacityNanousd: 60_000_000_000, lastObservedAt: at(3) },
  ], nowMs, undefined, {
    modelConfig: m.kernels.ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
    basis: m.kernels.ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
    gate: m.kernels.ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
    days: [modelDay(at(2).slice(0, 10), [["gpt-6-sol", 1_000, 1]])],
  });
}

async function setPreview(value) {
  await pool.query(`DELETE FROM ${q("analytics_v2_preview")}`);
  if (value === undefined) return;
  await withReplicaClient((client) => pgInsert(client, "analytics_v2_preview", {
    id: 1, preview: value === null ? null : JSON.stringify(value), computed_at: NOW_ISO, run_id: RUN_ID,
  }));
}

test("allowance preview serves the stored preview exactly as the Worker stores and serves it", { skip }, async () => {
  const preview = syntheticPreview(NOW_MS);
  assert.ok(m.kernels.validCachedAdminCommunityAllowancePreview(preview, preview.generatedAt, NOW_MS));
  await setPreview(preview);
  const served = await m.preview.readPostgresAdminAllowancePreview(pool, schema, NOW_MS);
  // The Worker stores canonicalJson(preview) and serves JSON.parse of it.
  assert.equal(JSON.stringify(served), JSON.stringify(JSON.parse(m.canonical.canonicalJson(preview))));
  // The vendored validator bounds only future skew, not age (production keeps
  // a publication until a replacement is ready): a valid preview generated
  // 120 days before the request is still served unchanged.
  const old = syntheticPreview(NOW_MS - 120 * DAY_MS);
  assert.ok(Date.parse(old.generatedAt) <= NOW_MS - 120 * DAY_MS);
  await setPreview(old);
  assert.equal(JSON.stringify(await m.preview.readPostgresAdminAllowancePreview(pool, schema, NOW_MS)),
    JSON.stringify(JSON.parse(m.canonical.canonicalJson(old))));
  // A preview generated beyond the future skew is the one time bound.
  for (const value of [syntheticPreview(NOW_MS + 2 * DAY_MS), undefined, null,
    { ...preview, generatedAt: "2026-10-02T12:10:00.000Z" },
    { ...preview, schemaVersion: "admin-community-allowance-preview-v0.0" }, { generatedAt: NOW_ISO }]) {
    await setPreview(value);
    assert.equal(await m.preview.readPostgresAdminAllowancePreview(pool, schema, NOW_MS), null);
  }
  await pool.query(`ALTER TABLE ${q("analytics_v2_preview")} RENAME TO c_admin_hidden_preview`);
  try {
    assert.equal(await apiError(m.preview.readPostgresAdminAllowancePreview(pool, schema, NOW_MS)),
      "503 BACKEND_STORAGE_UNAVAILABLE");
  } finally {
    await pool.query(`ALTER TABLE ${q("c_admin_hidden_preview")} RENAME TO analytics_v2_preview`);
  }
});

// ---------------------------------------------------------------------------
// set_collection_controls

async function pgAudit() {
  const result = await pool.query(`SELECT action, actor_identity_digest, outcome, details_json,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
    FROM ${q("admin_action_audit")} WHERE id > 3 ORDER BY id`);
  return result.rows;
}

async function d1Audit() {
  const result = await d1.primary.prepare(`SELECT action, actor_identity_digest, outcome, details_json, created_at
    FROM admin_action_audit WHERE id > 3 ORDER BY id`).all();
  return result.results;
}

async function pgControls() {
  const result = await pool.query(`SELECT revision::int AS revision, control_state, enrollment_enabled,
      upload_registration_enabled, processing_enabled, publication_enabled, reason_code,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM ${q("collection_controls")}`);
  return result.rows.map((row) => ({ ...row, enrollment_enabled: Number(row.enrollment_enabled),
    upload_registration_enabled: Number(row.upload_registration_enabled),
    processing_enabled: Number(row.processing_enabled), publication_enabled: Number(row.publication_enabled) }));
}

async function d1Controls() {
  const result = await d1.primary.prepare(`SELECT revision, control_state, enrollment_enabled,
      upload_registration_enabled, processing_enabled, publication_enabled, reason_code, updated_at
    FROM collection_controls`).all();
  return result.results;
}

test("set_collection_controls matches the Worker's CAS, result and audit trail", { skip }, async () => {
  const flags = { enrollment: false, uploadRegistration: true, processing: true, publication: true };
  const at = NOW_MS + 60_000;
  const actual = await m.controls.setPostgresCollectionControls(pool, schema, {
    identityKey: OWNER, flags, reasonCode: "drill_restore", expectedRevision: 5, nowEpoch: at,
  });
  const expected = await m.workerOperations.setCollectionControls(d1.primary, OWNER, flags, "drill_restore", 5, at);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.deepEqual(await pgControls(), await d1Controls());
  // Stale revision: 409 with one failure row, controls unchanged.
  assert.equal(await apiError(m.controls.setPostgresCollectionControls(pool, schema, {
    identityKey: OWNER, flags, reasonCode: "maintenance", expectedRevision: 5, nowEpoch: at + 1,
  })), "409 ADMIN_ACTION_CONFLICT");
  assert.equal(await apiError(m.workerOperations.setCollectionControls(
    d1.primary, OWNER, flags, "maintenance", 5, at + 1)), "409 ADMIN_ACTION_CONFLICT");
  assert.deepEqual(await pgControls(), await d1Controls());
  assert.deepEqual(await pgAudit(), await d1Audit());
  assert.deepEqual((await pgAudit()).map((row) => row.outcome), ["success", "failure"]);
});

test("set_collection_controls maps a controls guard to 409 with its own failure audit", { skip }, async () => {
  const before = await pgControls();
  const auditBefore = (await pgAudit()).length;
  await pool.query(`CREATE FUNCTION ${q("c_admin_guard")}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'c_admin_synthetic_guard' USING ERRCODE = 'P1005'; END; $$`);
  await pool.query(`CREATE TRIGGER c_admin_guard BEFORE UPDATE ON ${q("collection_controls")}
    FOR EACH ROW EXECUTE FUNCTION ${q("c_admin_guard")}()`);
  try {
    assert.equal(await apiError(m.controls.setPostgresCollectionControls(pool, schema, {
      identityKey: OWNER, flags: { enrollment: true, uploadRegistration: true, processing: true, publication: true },
      reasonCode: "maintenance", expectedRevision: 6, nowEpoch: NOW_MS + 120_000,
    })), "409 LIFECYCLE_STATE_CONFLICT");
  } finally {
    await pool.query(`DROP TRIGGER c_admin_guard ON ${q("collection_controls")}`);
    await pool.query(`DROP FUNCTION ${q("c_admin_guard")}()`);
  }
  assert.deepEqual(await pgControls(), before);
  const added = (await pgAudit()).slice(auditBefore);
  assert.deepEqual(added.map((row) => [row.outcome, JSON.parse(row.details_json).code ?? null]),
    [["failure", "LIFECYCLE_STATE_CONFLICT"]]);
  // Invalid input never reaches storage.
  for (const input of [
    { expectedRevision: 0 }, { reasonCode: "initial" }, { flags: { enrollment: "yes" } },
  ]) {
    assert.equal(await apiError(m.controls.setPostgresCollectionControls({ connect() { throw new Error("x"); } },
      schema, { identityKey: OWNER, flags: { enrollment: true, uploadRegistration: true, processing: true,
        publication: true }, reasonCode: "maintenance", expectedRevision: 6, nowEpoch: NOW_MS, ...input })),
    "400 BODY_INVALID");
  }
});

// ---------------------------------------------------------------------------
// Composed routes over PostgreSQL

test("the composed console serves the routes over PostgreSQL with the root's identity", { skip }, async () => {
  const store = m.requestContext.createRequestContextStore();
  const expected = await workerOverview();
  const handlers = m.adminConsole.createAdminConsoleHandlers({
    requestContext: store.accessor,
    clock: () => NOW_MS,
    env: ENV,
    // No analytics pool: the composition binds the analytics role to the
    // primary pool, where 0059 places analytics_v2.
    pools: { primary: pool, ledger: pool },
    schemaOptions: { primarySchema: schema, ledgerSchema },
    overviewSources: {
      syntheticContributions: async () => expected.counts.contributions.synthetic,
      historicalPublication: async () => expected.historicalPublication,
    },
  });
  const dispatch = async (routeId, request, identity = OWNER) => store.dispatch(request, {
    requestId: REQUEST_ID, routeId, ...(identity === null ? {} : { adminIdentityKey: identity }),
  }, handlers.get(routeId));

  const overview = await dispatch("admin_overview", new Request(`${ORIGIN}/api/v1/admin/overview`));
  assert.equal(overview.status, 200);
  assert.equal(overview.headers.get("vary"), "Cookie");
  assert.equal(overview.headers.get("cache-control"), "no-store");
  // The PostgreSQL-only guard refusal recorded by the previous test has no D1
  // counterpart; everything else is the Worker's body byte for byte.
  const served = await overview.json();
  served.audit = served.audit.filter((row) => row.details?.code !== "LIFECYCLE_STATE_CONFLICT");
  assert.equal(JSON.stringify(served), JSON.stringify(expected));

  const health = await dispatch("admin_database_health", new Request(`${ORIGIN}/api/v1/admin/database-health`));
  const healthBody = await health.json();
  assert.equal(health.status, 200);
  assert.deepEqual(healthBody.databases.map((row) => [row.role, row.status]),
    [["primary", "reachable"], ["deletion_ledger", "reachable"], ["analytics", "reachable"]]);
  assert.equal(healthBody.status, "available");
  // One database holds both roles, so they report the same size.
  assert.equal(healthBody.databases[2].databaseBytes, healthBody.databases[0].databaseBytes);
  // Without a ledger pool (after LEAD-SIMP retires the ledger) the closed DTO
  // reports deletion_ledger not_configured, so the status stays degraded;
  // how a retired role is represented is an open owner question. An explicit
  // analytics pool that fails is reported as failing, never replaced by primary.
  const failing = { connect: async () => { throw new Error("synthetic"); } };
  for (const [pools, statuses] of [
    [{ primary: pool }, ["reachable", "not_configured", "reachable"]],
    [{ primary: pool, ledger: pool, analytics: failing }, ["reachable", "reachable", "unavailable"]],
  ]) {
    const body = await m.adminConsole.createAdminConsoleAdapters({
      requestContext: store.accessor, clock: () => NOW_MS, env: ENV, pools,
      schemaOptions: { primarySchema: schema, ledgerSchema },
    }).readDatabaseHealth();
    assert.deepEqual(body.databases.map((row) => row.status), statuses);
    assert.equal(body.status, "degraded");
  }

  await setPreview(null);
  const preview = await dispatch("admin_community_allowance_preview",
    new Request(`${ORIGIN}/api/v1/admin/community/allowance-preview`));
  assert.equal(preview.status, 503);
  assert.equal((await preview.json()).error.code, "ADMIN_ALLOWANCE_STORAGE_UNAVAILABLE");

  const controls = (await pgControls())[0];
  const action = await dispatch("admin_action", new Request(`${ORIGIN}/api/v1/admin/action`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "x-usage-monitor-admin": "1" },
    body: JSON.stringify({ action: "set_collection_controls", enrollment: true, uploadRegistration: true,
      processing: true, publication: true, reasonCode: "maintenance", expectedRevision: controls.revision }),
  }));
  assert.equal(action.status, 200);
  assert.deepEqual(await action.json(), { schemaVersion: "admin-action-v0.1", action: "set_collection_controls",
    collection: { schemaVersion: "collection-controls-v0.1", state: "operational", revision: controls.revision + 1,
      enrollment: true, uploadRegistration: true, processing: true, publication: true } });
  const audit = (await pgAudit()).at(-1);
  assert.equal(audit.outcome, "success");
  assert.equal(audit.actor_identity_digest, await (async () => {
    const digest = await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(`app-usagemonitor/admin-actor/v1\0${OWNER}`));
    return Buffer.from(digest).toString("hex");
  })());

  const refused = await dispatch("admin_action", new Request(`${ORIGIN}/api/v1/admin/action`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "x-usage-monitor-admin": "1" },
    body: JSON.stringify({ action: "run_maintenance", participantErasure: { participantId: "x" } }),
  }));
  assert.equal(refused.status, 400);
  const auditCount = (await pgAudit()).length;
  const unported = await dispatch("admin_action", new Request(`${ORIGIN}/api/v1/admin/action`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "x-usage-monitor-admin": "1" },
    body: JSON.stringify({ action: "run_maintenance" }),
  }));
  assert.equal(unported.status, 503);
  assert.equal((await unported.json()).error.code, "POSTGRES_ROUTE_NOT_PORTED");
  assert.equal((await pgAudit()).length, auditCount, "refusals write no audit row");

  const anonymous = await dispatch("admin_overview", new Request(`${ORIGIN}/api/v1/admin/overview`), null);
  assert.equal(anonymous.status, 403);

  // Metrics history: no GCP producer writes the cache, so the route answers
  // what the Worker answers over an analytics database with no cached history.
  const storage = { source: d1.primary, target: d1.analytics, sourceId: SOURCE_ID, sourceNamespace: NAMESPACE };
  const workerHistory = await apiError(m.workerMetricsHistory.readCachedStorageAdminMetricsHistory(storage, NOW_MS));
  const history = await dispatch("admin_metrics_history", new Request(`${ORIGIN}/api/v1/admin/metrics/history`));
  assert.equal(`${history.status} ${(await history.json()).error.code}`, workerHistory);
  assert.equal(workerHistory, "503 ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE");

  // Reconstruction progress has no GCP source: the Worker's typed-storage
  // unavailable status, after the Worker's own query validation.
  const progress = await dispatch("admin_reconstruction_progress",
    new Request(`${ORIGIN}/api/v1/admin/reconstruction-progress?detail=preparation`));
  assert.equal(progress.status, 503);
  assert.equal((await progress.json()).error.code, "BACKEND_STORAGE_UNAVAILABLE");
});
