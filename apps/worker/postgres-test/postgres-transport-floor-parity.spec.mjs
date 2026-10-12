import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
  renderPostgresSearchPath,
} from "../scripts/postgres-migrations.mjs";

/*
 * PostgreSQL 17 qualification for primary migration 0051 (transport floor
 * parity) against a D1 oracle. The oracle is an in-memory SQLite database
 * built from the unmodified D1 migration directories the live ingestion D1
 * applies (the same list scripts/postgres-cutover-rehearsal.mjs uses), so
 * every D1 trigger runs exactly as written. Each operation is executed with
 * the same SQL and bound values on both stores, and the outcomes (success
 * with its row count, or the refusal) and the resulting floors are compared.
 *
 * Until the staged-migration harness lands, each PostgreSQL schema receives
 * the stock primary migrations and then 0051 in one transaction under the
 * runner's search path; once 0051 is promoted the runner applies it. Every
 * row is synthetic and content-free. The transfer-role test is cluster-global
 * and serializes on the advisory lock the owner-journal spec uses.
 */

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const SKIP = !PG_TEST_HOST && !PG_TEST_SOCKET;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION = "0051_transport_floor_parity.sql";
const MIGRATION_VERSION = 51;
const MIGRATION_LOCATIONS = Object.freeze([
  join(WORKER_ROOT, "postgres", "staged-migrations", "primary", MIGRATION),
  join(WORKER_ROOT, "postgres", "migrations", "primary", MIGRATION),
]);
// The live ingestion D1: the Wrangler baseline, then the storage streams.
const D1_DIRECTORIES = Object.freeze([
  "migrations", "typed-ingestion-migrations", "ingestion-bridge-migrations",
  "typed-v11-admission-migrations", "typed-v1-admission-migrations",
  "ingestion-isolation-migrations",
]);
const TRANSFER_ROLE = "tibotattle_source_transfer";
// Held by every test that creates, grants or drops the cluster-global
// transfer role (the owner-journal spec uses the same key).
const TRANSFER_ROLE_LOCK = 460_046;
const PARTICIPANT_CONSENT = "privacy-safe-telemetry-v0.1";
const PAIRING_CONSENT = "ongoing-privacy-safe-telemetry-v1.0";
const V11 = "telemetry-contribution-v1.1";
const DAY_MS = 24 * 60 * 60 * 1000;

// Every constant 0051 raises, with its SQLSTATE; each is D1's message except
// the migration-time backfill refusal, which D1 never needed.
const RAISED = Object.freeze({
  telemetry_transport_floor_backfill_unavailable: "P1005",
  telemetry_transport_blocked: "P1007",
  attribution_enrollment_immutable: "P1005",
  telemetry_transport_identity_immutable: "P1005",
  telemetry_transport_floor_revision_conflict: "P1005",
  telemetry_transport_rollback_required: "P1005",
  telemetry_transport_device_floor_rollback_required: "P1005",
  telemetry_transport_device_floor_revision_conflict: "P1005",
  telemetry_consent_immutable: "P1005",
  telemetry_transport_rollback_denied: "P1005",
});

// Every effective D1 trigger or view that is on, writes or reads a transport
// floor, format, enrollment, v1.1 consent or rollback table, and its
// PostgreSQL port (null: deliberately ported by the named owner instead).
const D1_TRIGGER_PORTS = Object.freeze({
  "attribution_enrollments/attribution_enrollment_immutable": "attribution_enrollments/attribution_enrollment_immutable",
  "device_credentials/telemetry_transport_device_floor_created": "device_credentials/telemetry_transport_device_floor_created",
  "participants/attribution_enrollment_created": "participants/attribution_enrollment_created",
  "participants/telemetry_transport_floor_created": "participants/telemetry_transport_floor_created",
  // The v0.x legacy insert floor belongs to the legacy contribution family.
  "telemetry_contributions/telemetry_transport_legacy_insert": null,
  "telemetry_transport_device_floors/telemetry_transport_device_floor_no_implicit_downgrade": "telemetry_transport_device_floors/telemetry_transport_device_floor_guard",
  "telemetry_transport_device_floors/telemetry_transport_device_floor_revision": "telemetry_transport_device_floors/telemetry_transport_device_floor_guard",
  "telemetry_transport_floor_rollbacks/telemetry_transport_rollback_owner_only": "telemetry_transport_floor_rollbacks/telemetry_transport_rollback_owner_only",
  "telemetry_transport_formats/telemetry_transport_format_identity_immutable": "telemetry_transport_formats/telemetry_transport_format_identity_immutable",
  "telemetry_transport_participant_floors/telemetry_transport_floor_no_implicit_downgrade": "telemetry_transport_participant_floors/telemetry_transport_participant_floor_guard",
  "telemetry_transport_participant_floors/telemetry_transport_floor_revision": "telemetry_transport_participant_floors/telemetry_transport_participant_floor_guard",
  "telemetry_transport_participant_floors/telemetry_transport_floor_successor_history_guard": "telemetry_transport_participant_floors/telemetry_transport_participant_floor_guard",
  "telemetry_v11_device_consents/telemetry_transport_device_floor_v11_consent": "telemetry_v11_device_consents/telemetry_v11_consent_floor",
  "telemetry_v11_device_consents/telemetry_v11_consent_admission": "telemetry_v11_device_consents/telemetry_v11_consent_admission",
  "telemetry_v11_device_consents/telemetry_v11_consent_floor": "telemetry_v11_device_consents/telemetry_v11_consent_floor",
  "telemetry_v11_device_consents/telemetry_v11_consent_immutable": "telemetry_v11_device_consents/telemetry_v11_consent_immutable",
  "telemetry_v1_chunks/telemetry_transport_v12_v1_insert": "telemetry_v1_chunks/telemetry_v1_transport_floor_guard",
  // v1.1 admission reads the participant floor: V11-A's 0059 ports the
  // manifest and chunk staging admission, V11-C's 0066 the predecessor
  // authority and the current-predecessor view.
  "telemetry_v11_chunks/telemetry_v11_chunk_admission": null,
  "telemetry_v11_day_manifests/telemetry_v11_manifest_admission": null,
  "telemetry_v11_domain_predecessors/telemetry_v11_predecessor_authority": null,
  "view:telemetry_v11_current_predecessors": null,
});
// Any reference to one of these tables puts a D1 trigger or view in scope.
const FLOOR_REFERENCE =
  /\b(?:attribution_enrollments|telemetry_transport_(?:participant_floors|device_floors|formats|floor_rollbacks)|telemetry_v11_device_consents)\b/u;
const FLOOR_TABLES = Object.freeze([
  "attribution_enrollments", "telemetry_transport_formats", "telemetry_transport_participant_floors",
  "telemetry_transport_device_floors", "telemetry_transport_floor_rollbacks", "telemetry_v11_device_consents",
]);

let migration;
/** 0051 from staged-migrations/ or, after promotion, migrations/: exactly one. */
async function readMigration() {
  if (migration === undefined) {
    const found = [];
    for (const [index, path] of MIGRATION_LOCATIONS.entries()) {
      try {
        found.push({ sql: await readFile(path, "utf8"), staged: index === 0 });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    assert.equal(found.length, 1, "0051 is either staged or promoted, never both or neither");
    migration = found[0];
  }
  return migration;
}

let d1Sources;
/** A fresh D1 oracle: every D1 migration file, unmodified, in stream order. */
async function d1Oracle() {
  d1Sources ??= (async () => {
    const sources = [];
    for (const directory of D1_DIRECTORIES) {
      const names = (await readdir(join(WORKER_ROOT, directory)))
        .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/u.test(name)).sort();
      for (const name of names) sources.push(await readFile(join(WORKER_ROOT, directory, name), "utf8"));
    }
    return sources;
  })();
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const sql of await d1Sources) {
    database.exec("BEGIN");
    database.exec(sql);
    database.exec("COMMIT");
  }
  return database;
}

/**
 * Retained accepted v0.2 contributions predate the floors; the oracle seeds
 * them directly by removing telemetry_contributions' own admission triggers.
 * No trigger under comparison is on that table; they only read its rows.
 */
function allowRetainedHistorySeeding(d1) {
  const triggers = d1.prepare(
    "SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='telemetry_contributions'",
  ).all();
  for (const { name } of triggers) d1.exec(`DROP TRIGGER "${name}"`);
}

async function endpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "transport-floor tests require loopback or a private Unix socket");
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
  return { host: PG_TEST_HOST, port: PG_TEST_PORT, socket: false };
}

function connectionSettings(local, schema, user = PG_TEST_USER) {
  return {
    host: local.host, port: local.port, user, password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE,
    ssl: false, connectionTimeoutMillis: 5_000, application_name: "pg-transport-floor-parity-test",
    options: `-c search_path=${schema},pg_catalog`,
  };
}

/** Stock primary migrations, then staged 0051 in one transaction. */
async function prepareSchema(pool, schema) {
  const { sql, staged } = await readMigration();
  const stock = await readPostgresMigrations({ role: "primary" });
  assert.equal(stock.some((entry) => entry.name === MIGRATION), !staged,
    "the runner applies 0051 exactly when it is promoted");
  await applyPostgresMigrations({ role: "primary", schema, pool });
  if (!staged) return;
  assert.ok(stock.every((entry) => entry.version < MIGRATION_VERSION),
    "a staged 0051 applies directly after the stock chain");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='60000ms'");
    await client.query("SET LOCAL lock_timeout='10000ms'");
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

/** One PostgreSQL 17 schema and one D1 oracle per test; both are discarded. */
async function withTwin(operation) {
  const local = await endpoint();
  const schema = `ta1_floor_${randomBytes(6).toString("hex")}`;
  const pool = new pg.Pool({ ...connectionSettings(local, schema), max: 4 });
  let created = false;
  const d1 = await d1Oracle();
  try {
    const server = await pool.query(
      "SELECT current_setting('server_version_num')::integer AS version, host(inet_server_addr()) AS address",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "0051 is qualified on PostgreSQL 17");
    if (local.socket) assert.equal(server.rows[0].address, null);
    else assert.ok(["127.0.0.1", "::1"].includes(server.rows[0].address));
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await prepareSchema(pool, schema);
    return await operation(new Twin(d1, pool), { local, schema, pool });
  } finally {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
    d1.close();
  }
}

const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();
const bytes32 = () => randomBytes(32);
const hex = (seed) => createHash("sha256").update(String(seed)).digest("hex");
const toPostgres = (sql) => {
  let index = 0;
  return sql.replace(/\?/gu, () => `$${++index}`);
};
const plain = (rows) => rows.map((row) => ({ ...row }));

function d1Refusal(error) {
  const message = String(error?.message ?? "");
  if (message.startsWith("CHECK constraint failed")) return "check";
  if (message.startsWith("FOREIGN KEY constraint failed")) return "foreign_key";
  if (message.startsWith("UNIQUE constraint failed")) return "unique";
  return message;
}

function pgRefusal(error) {
  switch (error?.code) {
    case "23514": return "check";
    case "23503": return "foreign_key";
    case "23505": return "unique";
    case "P1005":
    case "P1007":
      assert.equal(RAISED[error.message], error.code, `${error.message} is raised with its SQLSTATE`);
      return error.message;
    default:
      return `sqlstate:${error?.code}`;
  }
}

class Twin {
  constructor(d1, pool) {
    this.d1 = d1;
    this.pool = pool;
  }

  /** Seed both stores; either refusing is a fixture error. */
  async run(sql, values = []) {
    this.d1.prepare(sql).run(...values);
    await this.pool.query(toPostgres(sql), values);
  }

  d1Only(sql, values = []) {
    this.d1.prepare(sql).run(...values);
  }

  async pgOnly(sql, values = []) {
    return this.pool.query(toPostgres(sql), values);
  }

  async outcomes(sql, values = []) {
    let d1;
    try {
      d1 = { changes: Number(this.d1.prepare(sql).run(...values).changes) };
    } catch (error) {
      d1 = { refused: d1Refusal(error) };
    }
    let postgres;
    try {
      postgres = { changes: (await this.pool.query(toPostgres(sql), values)).rowCount };
    } catch (error) {
      postgres = { refused: pgRefusal(error) };
    }
    return { d1, postgres };
  }

  /** The same statement on both stores must end the same way. */
  async same(sql, values, label) {
    const { d1, postgres } = await this.outcomes(sql, values);
    assert.deepEqual(postgres, d1, label);
    return d1;
  }

  async rows(sql, values = []) {
    const d1 = plain(this.d1.prepare(sql).all(...values));
    const postgres = plain((await this.pool.query(toPostgres(sql), values)).rows);
    assert.deepEqual(postgres, d1, sql);
    return d1;
  }
}

async function socialParticipant(twin, participantId) {
  const now = iso();
  await twin.run(
    `INSERT INTO participants (id, owner_kind, access_token_id, access_token_hash, recovery_token_id,
       recovery_token_hash, state, consent_version, consented_at, created_at)
     VALUES (?, 'social', ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [participantId, `access-${participantId}`, bytes32(), `recovery-${participantId}`, bytes32(),
      PARTICIPANT_CONSENT, now, now],
  );
  await twin.run(
    `INSERT INTO web_sessions (id, participant_id, secret_hash, csrf_hash, scope, state, issued_at, expires_at, last_used_at)
     VALUES (?, ?, ?, ?, 'personal', 'active', ?, ?, ?)`,
    [`session-${participantId}`, participantId, bytes32(), bytes32(), now, iso(DAY_MS), now],
  );
}

async function socialDevice(twin, participantId, deviceId) {
  const now = iso();
  const pairing = `pairing-${deviceId}`;
  await twin.run(
    `INSERT INTO device_pairings (id, participant_id, issued_by_session_id, secret_hash, consent_version,
       transport_consent_version, state, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'unused', ?, ?)`,
    [pairing, participantId, `session-${participantId}`, bytes32(), PAIRING_CONSENT, PAIRING_CONSENT, now, iso(DAY_MS)],
  );
  await twin.run(
    `INSERT INTO device_credentials (id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
       state, issued_at, expires_at, last_used_at, social_verified_at)
     VALUES (?, ?, 'social', ?, ?, 'active', ?, ?, ?, ?)`,
    [deviceId, participantId, pairing, bytes32(), now, iso(30 * DAY_MS), now, now],
  );
  await twin.run(
    "UPDATE device_pairings SET state = 'consumed', consumed_at = ?, claimed_device_id = ? WHERE id = ?",
    [now, deviceId, pairing],
  );
}

/**
 * An accountless owner as each store creates one: D1's participant triggers
 * write the enrollment and a rank-11 floor; PostgreSQL's enrollment writer
 * (src/postgres-accountless-enrollment.ts) inserts both rows itself.
 */
async function accountlessOwner(twin, participantId, deviceId) {
  const issued = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  const expires = new Date(Date.parse(issued) + 30 * DAY_MS).toISOString();
  const secret = bytes32();
  await twin.run(
    `INSERT INTO accountless_enrollment_ledger (device_id, device_secret_hash, installation_principal_id,
       schema_version, policy_version, authorization_basis, state, issued_at, expires_at)
     VALUES (?, ?, ?, 'accountless-enrollment-v0.1', 'accountless-opt-out-v1', 'accountless-policy-v1', 'active', ?, ?)`,
    [deviceId, secret, `install-${deviceId}`, issued, expires],
  );
  const participant = "INSERT INTO participants (id, owner_kind, state, created_at) VALUES (?, 'accountless', 'active', ?)";
  twin.d1Only(participant, [participantId, issued]);
  await twin.pgOnly(participant, [participantId, issued]);
  await twin.pgOnly("INSERT INTO attribution_enrollments (participant_id, namespace, created_at) VALUES (?, ?, ?)",
    [participantId, hex(`namespace-${participantId}`), issued]);
  await twin.pgOnly(
    "INSERT INTO telemetry_transport_participant_floors (participant_id, minimum_rank, revision, changed_at) VALUES (?, 11, 0, ?)",
    [participantId, issued]);
  await twin.run(
    `INSERT INTO device_credentials (id, participant_id, authority_kind, accountless_enrollment_device_id,
       secret_hash, state, issued_at, expires_at, last_used_at)
     VALUES (?, ?, 'accountless', ?, ?, 'active', ?, ?, ?)`,
    [deviceId, participantId, deviceId, secret, issued, expires, issued],
  );
  await twin.run(
    `INSERT INTO accountless_upload_owners (enrollment_device_id, participant_id, device_credential_id,
       policy_version, authorization_basis, authorized_at, expires_at, state)
     VALUES (?, ?, ?, 'accountless-opt-out-v1', 'accountless-policy-v1', ?, ?, 'active')`,
    [deviceId, participantId, deviceId, issued, expires],
  );
}

const PARTICIPANT_FLOOR = "SELECT minimum_rank, revision FROM telemetry_transport_participant_floors WHERE participant_id = ?";
const DEVICE_FLOORS = `SELECT device_id, minimum_rank, revision FROM telemetry_transport_device_floors
  WHERE participant_id = ? ORDER BY device_id`;

async function floors(twin, participantId) {
  return {
    participant: await twin.rows(PARTICIPANT_FLOOR, [participantId]),
    devices: await twin.rows(DEVICE_FLOORS, [participantId]),
  };
}

const RAISE_PARTICIPANT = `UPDATE telemetry_transport_participant_floors
  SET minimum_rank = ?, revision = revision + 1, changed_at = ? WHERE participant_id = ?`;
const RAISE_DEVICE = `UPDATE telemetry_transport_device_floors
  SET minimum_rank = ?, revision = revision + 1, changed_at = ? WHERE device_id = ?`;
const CONSENT = `INSERT INTO telemetry_v11_device_consents (participant_id, device_id, telemetry_schema_version,
  field_dictionary_version, privacy_contract_version, consented_at)
  VALUES (?, ?, 'telemetry-contribution-v1.1', 'telemetry-v1.1-registry-2026-08-31.1',
    'ongoing-privacy-safe-telemetry-v1.1', ?)`;
const ACCEPT_V11 = "UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE schema_version = 'telemetry-contribution-v1.1'";
const V02_HISTORY = `INSERT INTO telemetry_contributions (id, participant_id, plaintext_digest, envelope_digest, r2_key,
  status, schema_version, transport_schema_version, range_start, range_end, client_platform, provider_policy_epoch,
  priced_event_coverage_percent, unknown_model_event_count, unknown_billable_units, price_basis,
  declared_record_count, created_at)
  VALUES (?, ?, ?, ?, ?, 'accepted', 'telemetry-contribution-v0.1', 'telemetry-contribution-v0.2', ?, ?,
    'synthetic', 'synthetic-policy', 0, 0, 0, 'synthetic', 0, ?)`;
const AUDIT = `INSERT INTO admin_action_audit (operation_id, action, actor_identity_digest, outcome, details_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?)`;
const ROLLBACK = `INSERT INTO telemetry_transport_floor_rollbacks (operation_id, participant_id, participant_digest,
  expected_revision, from_rank, to_rank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;

async function v02History(twin, participantId) {
  const id = `synthetic-v02-${randomBytes(5).toString("hex")}`;
  const now = iso();
  await twin.run(V02_HISTORY, [id, participantId, hex(`${id}-plain`), hex(`${id}-envelope`), `synthetic/${id}`, now, now, now]);
}

/** The Worker's rollback participant digest (telemetry-transport-policy.ts). */
const rollbackDigest = (participantId) =>
  createHash("sha256").update(`app-usagemonitor/transport-rollback/v1\0${participantId}`).digest("hex");

async function audit(twin, operationId, details, { action = "run_maintenance", outcome = "started" } = {}) {
  await twin.run(AUDIT, [operationId, action, "a".repeat(64), outcome,
    typeof details === "string" ? details : JSON.stringify(details), iso()]);
}

// ---------------------------------------------------------------------------

test("0051 is staged or promoted once, uses OJ-1's transfer predicate, and raises only constant D1 messages", async () => {
  const { sql } = await readMigration();
  const code = sql.replace(/--[^\n]*/gu, " ");
  assert.doesNotMatch(code, /pg_has_role|pg_roles|rolsuper/u,
    "the bypass never inlines a role predicate (pg_has_role is true for superusers)");
  assert.equal(code.match(/IF storage_journal_transfer_session\(\) THEN\s+RETURN NULL;/gu)?.length, 3,
    "exactly the enrollment, participant-floor and device-floor creators consult the bypass");
  assert.doesNotMatch(code, /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+storage_journal_transfer_session/u);
  assert.doesNotMatch(code, /CREATE\s+ROLE|GRANT\s/u, "0051 creates no role and grants nothing");
  const raises = [...code.matchAll(/RAISE\s+EXCEPTION\s+([^;]*);/gu)].map((match) => match[1].replace(/\s+/gu, " ").trim());
  assert.equal(raises.length, 15, "every RAISE in 0051 is accounted for");
  const messages = new Set();
  for (const raise of raises) {
    const match = /^'([a-z_]+)' USING ERRCODE = '(P100[57])'$/u.exec(raise);
    assert.ok(match, `constant message and explicit ERRCODE: ${raise}`);
    assert.equal(RAISED[match[1]], match[2], `${match[1]} uses its SQLSTATE`);
    messages.add(match[1]);
  }
  assert.deepEqual([...messages].sort(), Object.keys(RAISED).sort());
  assert.doesNotMatch(code, /RAISE\s+(?:EXCEPTION|NOTICE|WARNING)\s+'[^']*%/u, "no message interpolates a value");
  // Writers keep running during a PostgreSQL migration: the source tables
  // are locked against writes before the backfill reads them, so no row
  // lands between the backfill and the trigger that would have covered it;
  // and before any floor table, in the writers' order, so none deadlocks.
  const lockAt = code.search(/LOCK TABLE participants, device_credentials, telemetry_v11_device_consents\s+IN SHARE ROW EXCLUSIVE MODE;/u);
  assert.ok(lockAt >= 0, "0051 locks the backfill's source tables");
  for (const later of [/ALTER TABLE/u, /CREATE UNIQUE INDEX/u, /INSERT INTO attribution_enrollments/u, /CREATE TRIGGER/u,
    /telemetry_transport_floor_backfill_unavailable/u]) {
    assert.ok(code.search(later) > lockAt, `the lock precedes ${later.source}`);
  }
});

test("every effective D1 trigger or view on or reading a transport floor table has a named PostgreSQL decision", async () => {
  const d1 = await d1Oracle();
  try {
    const found = d1.prepare(
      "SELECT type, tbl_name, name, sql FROM sqlite_schema WHERE type IN ('trigger', 'view') ORDER BY tbl_name, name",
    ).all().filter((row) => FLOOR_TABLES.includes(row.tbl_name) || FLOOR_REFERENCE.test(row.sql))
      .map((row) => (row.type === "view" ? `view:${row.name}` : `${row.tbl_name}/${row.name}`)).sort();
    assert.deepEqual(found, Object.keys(D1_TRIGGER_PORTS).sort(),
      "a new or removed D1 transport-floor trigger or view needs a PostgreSQL decision here");
  } finally {
    d1.close();
  }
});

test("PG17 0051 installs each port on its table, and the device floor is unique per device", {
  skip: SKIP, timeout: 120_000,
}, () => withTwin(async (_twin, { pool, schema }) => {
  const installed = (await pool.query(
    `SELECT c.relname || '/' || t.tgname AS name
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT t.tgisinternal`, [schema],
  )).rows.map((row) => row.name);
  for (const port of new Set(Object.values(D1_TRIGGER_PORTS).filter(Boolean))) {
    assert.ok(installed.includes(port), `${port} is installed`);
  }
  const indexes = (await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'telemetry_transport_device_floors_device'`,
    [schema],
  )).rows;
  assert.equal(indexes.length, 1);
  assert.match(indexes[0].indexdef, /CREATE UNIQUE INDEX .* \(device_id\)$/u);
  const constraints = (await pool.query(
    `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = $1::regclass ORDER BY conname`,
    [`"${schema}".telemetry_transport_floor_rollbacks`],
  )).rows;
  const byName = Object.fromEntries(constraints.map((row) => [row.conname, row.definition]));
  assert.equal(byName.telemetry_transport_floor_rollbacks_operation_fkey,
    "FOREIGN KEY (operation_id) REFERENCES admin_action_audit(operation_id)");
  assert.equal(byName.telemetry_transport_floor_rollbacks_from_rank_check,
    "CHECK ((from_rank = ANY (ARRAY[1, 2, 10, 11])))");
  assert.equal(byName.telemetry_transport_floor_rollbacks_to_rank_check,
    "CHECK (((to_rank = ANY (ARRAY[1, 2, 10, 11])) AND (to_rank < from_rank)))");
  for (const [floorTable, name] of [
    ["telemetry_transport_participant_floors", "telemetry_transport_participant_floors_ranked_check"],
    ["telemetry_transport_device_floors", "telemetry_transport_device_floors_ranked_check"],
  ]) {
    const ranked = (await pool.query(
      `SELECT pg_get_constraintdef(oid) AS definition, convalidated FROM pg_constraint
        WHERE conrelid = $1::regclass AND conname = $2`, [`"${schema}".${floorTable}`, name],
    )).rows;
    assert.deepEqual(ranked, [{ definition: "CHECK ((minimum_rank = ANY (ARRAY[1, 2, 10, 11])))", convalidated: true }],
      `${floorTable} holds D1's four ranks`);
  }
}));

test("PG17 enrollment, participant-floor and device-floor creation match D1", {
  skip: SKIP, timeout: 120_000,
}, () => withTwin(async (twin) => {
  // A social participant: enrollment plus a rank-1, revision-0 floor.
  await socialParticipant(twin, "participant-social-a");
  await twin.rows("SELECT participant_id, length(namespace) AS length FROM attribution_enrollments ORDER BY participant_id");
  assert.deepEqual(await floors(twin, "participant-social-a"),
    { participant: [{ minimum_rank: 1, revision: 0 }], devices: [] });
  const namespace = (await twin.pgOnly("SELECT namespace FROM attribution_enrollments WHERE participant_id = ?",
    ["participant-social-a"])).rows[0].namespace;
  assert.match(namespace, /^[0-9a-f]{64}$/u);

  // A device copies the floor; once the floor is 11 a new social device gets 10.
  await socialDevice(twin, "participant-social-a", "device-a1");
  await twin.same(RAISE_PARTICIPANT, [10, iso(), "participant-social-a"], "raise to 10");
  await socialDevice(twin, "participant-social-a", "device-a2");
  await twin.same(RAISE_PARTICIPANT, [11, iso(), "participant-social-a"], "raise to 11");
  await socialDevice(twin, "participant-social-a", "device-a3");
  assert.deepEqual(await floors(twin, "participant-social-a"), {
    participant: [{ minimum_rank: 11, revision: 2 }],
    devices: [
      { device_id: "device-a1", minimum_rank: 1, revision: 0 },
      { device_id: "device-a2", minimum_rank: 10, revision: 0 },
      { device_id: "device-a3", minimum_rank: 10, revision: 0 },
    ],
  });

  // A second participant gets its own random namespace.
  await socialParticipant(twin, "participant-social-b");
  const namespaces = (await twin.pgOnly("SELECT DISTINCT namespace FROM attribution_enrollments")).rows;
  assert.equal(namespaces.length, 2);

  // No participant floor, no device floor.
  await twin.same("DELETE FROM telemetry_transport_participant_floors WHERE participant_id = ?",
    ["participant-social-b"], "remove the floor");
  await socialDevice(twin, "participant-social-b", "device-b1");
  assert.deepEqual(await floors(twin, "participant-social-b"), { participant: [], devices: [] });

  // Accountless copies its floor (11) onto the device.
  const enrollmentDevice = randomUUID();
  await accountlessOwner(twin, "participant-accountless-c", enrollmentDevice);
  assert.deepEqual(await floors(twin, "participant-accountless-c"), {
    participant: [{ minimum_rank: 11, revision: 0 }],
    devices: [{ device_id: enrollmentDevice, minimum_rank: 11, revision: 0 }],
  });
  await twin.rows("SELECT CAST(count(*) AS INTEGER) AS enrollments FROM attribution_enrollments WHERE participant_id = ?",
    ["participant-accountless-c"]);

  // Deliberate difference: PostgreSQL leaves accountless enrollment and floor
  // rows to the accountless enrollment writer, which inserts both itself.
  const bare = "INSERT INTO participants (id, owner_kind, state, created_at) VALUES (?, 'accountless', 'active', ?)";
  twin.d1Only(bare, ["participant-accountless-bare", iso()]);
  await twin.pgOnly(bare, ["participant-accountless-bare", iso()]);
  const d1Rows = twin.d1.prepare(PARTICIPANT_FLOOR).all("participant-accountless-bare").map((row) => ({ ...row }));
  assert.deepEqual(d1Rows, [{ minimum_rank: 11, revision: 0 }]);
  assert.equal((await twin.pgOnly(PARTICIPANT_FLOOR, ["participant-accountless-bare"])).rowCount, 0);
  assert.equal((await twin.pgOnly("SELECT 1 FROM attribution_enrollments WHERE participant_id = ?",
    ["participant-accountless-bare"])).rowCount, 0);
}));

test("PG17 floor, enrollment and format guards refuse exactly as D1 does, rule order included", {
  skip: SKIP, timeout: 120_000,
}, () => withTwin(async (twin) => {
  allowRetainedHistorySeeding(twin.d1);
  const participant = "participant:00000000-0000-4000-8000-000000000001";
  await socialParticipant(twin, participant);
  await socialDevice(twin, participant, "device-guard-1");
  await twin.same(RAISE_PARTICIPANT, [10, iso(), participant], "raise the participant floor to 10");
  await twin.same(RAISE_DEVICE, [10, iso(), "device-guard-1"], "raise the device floor to 10");

  const cases = [
    ["participant revision skip", `UPDATE telemetry_transport_participant_floors SET revision = revision + 2 WHERE participant_id = ?`, [participant]],
    ["participant revision unchanged", `UPDATE telemetry_transport_participant_floors SET changed_at = ? WHERE participant_id = ?`, [iso(), participant]],
    ["participant identity change", `UPDATE telemetry_transport_participant_floors SET participant_id = ?, revision = revision + 1 WHERE participant_id = ?`, ["participant-missing", participant]],
    ["participant downgrade without rollback", `UPDATE telemetry_transport_participant_floors SET minimum_rank = 1, revision = revision + 1 WHERE participant_id = ?`, [participant]],
    ["participant downgrade and revision skip", `UPDATE telemetry_transport_participant_floors SET minimum_rank = 1, revision = revision + 2 WHERE participant_id = ?`, [participant]],
    ["device revision skip", `UPDATE telemetry_transport_device_floors SET revision = revision + 2 WHERE device_id = ?`, ["device-guard-1"]],
    ["device identity change", `UPDATE telemetry_transport_device_floors SET device_id = ?, revision = revision + 1 WHERE device_id = ?`, ["device-missing", "device-guard-1"]],
    ["device participant change", `UPDATE telemetry_transport_device_floors SET participant_id = ?, revision = revision + 1 WHERE device_id = ?`, ["participant-missing", "device-guard-1"]],
    ["device downgrade without rollback", `UPDATE telemetry_transport_device_floors SET minimum_rank = 1, revision = revision + 1 WHERE device_id = ?`, ["device-guard-1"]],
    ["device downgrade and revision skip", `UPDATE telemetry_transport_device_floors SET minimum_rank = 1, revision = revision + 2 WHERE device_id = ?`, ["device-guard-1"]],
    ["enrollment update", `UPDATE attribution_enrollments SET created_at = ? WHERE participant_id = ?`, [iso(), participant]],
    ["format rank update", `UPDATE telemetry_transport_formats SET format_rank = format_rank WHERE schema_version = 'telemetry-contribution-v1.0'`, []],
    ["format identity update", `UPDATE telemetry_transport_formats SET schema_version = schema_version WHERE schema_version = 'telemetry-contribution-v1.0'`, []],
  ];
  const refusals = {};
  for (const [label, sql, values] of cases) refusals[label] = (await twin.same(sql, values, label)).refused;
  assert.deepEqual(refusals, {
    "participant revision skip": "telemetry_transport_floor_revision_conflict",
    "participant revision unchanged": "telemetry_transport_floor_revision_conflict",
    "participant identity change": "telemetry_transport_floor_revision_conflict",
    "participant downgrade without rollback": "telemetry_transport_rollback_required",
    "participant downgrade and revision skip": "telemetry_transport_floor_revision_conflict",
    "device revision skip": "telemetry_transport_device_floor_revision_conflict",
    "device identity change": "telemetry_transport_device_floor_revision_conflict",
    "device participant change": "telemetry_transport_device_floor_revision_conflict",
    "device downgrade without rollback": "telemetry_transport_device_floor_rollback_required",
    "device downgrade and revision skip": "telemetry_transport_device_floor_rollback_required",
    "enrollment update": "attribution_enrollment_immutable",
    "format rank update": "telemetry_transport_identity_immutable",
    "format identity update": "telemetry_transport_identity_immutable",
  });
  assert.deepEqual(await twin.same(
    "UPDATE telemetry_transport_formats SET lifecycle = 'staged' WHERE schema_version = 'telemetry-contribution-v0.2'",
    [], "a format lifecycle stays owner-mutable"), { changes: 1 });

  // Accepted v0.2 history: only a raise to exactly 11 is refused, and that
  // rule fires before the revision rule.
  await v02History(twin, participant);
  assert.deepEqual(await twin.same(RAISE_PARTICIPANT, [11, iso(), participant], "raise to 11 over v0.2 history"),
    { refused: "telemetry_transport_blocked" });
  assert.deepEqual(await twin.same(
    `UPDATE telemetry_transport_participant_floors SET minimum_rank = 11, revision = revision + 2 WHERE participant_id = ?`,
    [participant], "raise to 11 with a revision skip over history"), { refused: "telemetry_transport_blocked" });
  assert.deepEqual(await twin.same(RAISE_DEVICE, [11, iso(), "device-guard-1"], "a device floor has no history guard"),
    { changes: 1 });
  // D1's closed rank domain: 12 names no ranked format (primary 0005 alone
  // admits it), so the raise is refused by the CHECK after every guard passes.
  assert.deepEqual(await twin.same(RAISE_PARTICIPANT, [12, iso(), participant], "participant raise to 12 over v0.2 history"),
    { refused: "check" });
  assert.deepEqual(await twin.same(RAISE_DEVICE, [12, iso(), "device-guard-1"], "device raise to 12"),
    { refused: "check" });
  assert.deepEqual(await floors(twin, participant), {
    participant: [{ minimum_rank: 10, revision: 1 }],
    devices: [{ device_id: "device-guard-1", minimum_rank: 11, revision: 2 }],
  });

  // An owner-audited rollback lowers both floors; the device floor accepts a
  // rollback for its participant and ranks at any revision, as in D1.
  const operation = "00000000-0000-4000-8000-00000000a001";
  const digest = rollbackDigest(participant);
  await audit(twin, operation, { operation: "telemetry_transport_rollback", participantDigest: digest,
    expectedRevision: 1, fromRank: 10, toRank: 1 });
  assert.deepEqual(await twin.same(ROLLBACK, [operation, participant, digest, 1, 10, 1, iso()], "record the rollback"),
    { changes: 1 });
  assert.deepEqual(await twin.same(
    "UPDATE telemetry_transport_participant_floors SET minimum_rank = 1, revision = revision + 1 WHERE participant_id = ? AND revision = 1 AND minimum_rank = 10",
    [participant], "audited participant downgrade"), { changes: 1 });
  assert.deepEqual(await twin.same(RAISE_DEVICE, [1, iso(), "device-guard-1"],
    "a device at 11 is not covered by a 10 -> 1 rollback"), { refused: "telemetry_transport_device_floor_rollback_required" });
  await twin.same(RAISE_DEVICE, [10, iso(), "device-guard-1"], "a rollback-free device lowering is refused")
    .then((outcome) => assert.deepEqual(outcome, { refused: "telemetry_transport_device_floor_rollback_required" }));
  await socialDevice(twin, participant, "device-guard-2");
  await twin.same(RAISE_DEVICE, [10, iso(), "device-guard-2"], "raise the second device to 10");
  await twin.same(RAISE_DEVICE, [10, iso(), "device-guard-2"], "revision 2");
  assert.deepEqual(await twin.same(
    "UPDATE telemetry_transport_device_floors SET minimum_rank = 1, revision = revision + 1 WHERE participant_id = ? AND minimum_rank = 10",
    [participant], "audited device downgrade at another revision"), { changes: 1 });

  // A finished audit no longer authorizes the same lowering again.
  await twin.same("UPDATE admin_action_audit SET outcome = 'success' WHERE operation_id = ?", [operation], "finish the audit");
  await twin.same(RAISE_PARTICIPANT, [10, iso(), participant], "raise back to 10");
  assert.deepEqual(await twin.same(
    "UPDATE telemetry_transport_participant_floors SET minimum_rank = 1, revision = revision + 1 WHERE participant_id = ?",
    [participant], "a finished audit authorizes nothing"), { refused: "telemetry_transport_rollback_required" });
  assert.deepEqual(await floors(twin, participant), {
    participant: [{ minimum_rank: 10, revision: 3 }],
    devices: [
      { device_id: "device-guard-1", minimum_rank: 11, revision: 2 },
      { device_id: "device-guard-2", minimum_rank: 1, revision: 3 },
    ],
  });
}));

test("PG17 a rollback lowers only its own participant, at its expected revision, while its audit is started, as in D1", {
  skip: SKIP, timeout: 120_000,
}, () => withTwin(async (twin) => {
  const owners = {
    a: ["participant:00000000-0000-4000-8000-00000000b00a", "device-bind-a"],
    b: ["participant:00000000-0000-4000-8000-00000000b00b", "device-bind-b"],
  };
  for (const [participant, device] of Object.values(owners)) {
    await socialParticipant(twin, participant);
    await socialDevice(twin, participant, device);
    await twin.same(RAISE_PARTICIPANT, [10, iso(), participant], "participant floor to 10 (revision 1)");
    await twin.same(RAISE_DEVICE, [10, iso(), device], "device floor to 10 (revision 1)");
  }
  const [participantA, deviceA] = owners.a;
  const [participantB, deviceB] = owners.b;
  const lower = `UPDATE telemetry_transport_participant_floors
    SET minimum_rank = 1, revision = revision + 1 WHERE participant_id = ?`;
  const lowerDevice = `UPDATE telemetry_transport_device_floors
    SET minimum_rank = 1, revision = revision + 1 WHERE device_id = ?`;

  // Only A holds a started 10 -> 1 rollback, recorded at revision 1.
  const operation = "00000000-0000-4000-8000-00000000b001";
  const digest = rollbackDigest(participantA);
  await audit(twin, operation, { operation: "telemetry_transport_rollback", participantDigest: digest,
    expectedRevision: 1, fromRank: 10, toRank: 1 });
  assert.deepEqual(await twin.same(ROLLBACK, [operation, participantA, digest, 1, 10, 1, iso()], "A's rollback"),
    { changes: 1 });

  // B's floors sit at the same revision and ranks, but the rollback is A's.
  assert.deepEqual(await twin.same(lower, [participantB], "B's participant floor under A's rollback"),
    { refused: "telemetry_transport_rollback_required" });
  assert.deepEqual(await twin.same(lowerDevice, [deviceB], "B's device floor under A's rollback"),
    { refused: "telemetry_transport_device_floor_rollback_required" });

  // B's own rollback, exact in participant, revision and ranks, authorizes
  // nothing once its audit has finished.
  const operationB = "00000000-0000-4000-8000-00000000b002";
  const digestB = rollbackDigest(participantB);
  await audit(twin, operationB, { operation: "telemetry_transport_rollback", participantDigest: digestB,
    expectedRevision: 1, fromRank: 10, toRank: 1 });
  assert.deepEqual(await twin.same(ROLLBACK, [operationB, participantB, digestB, 1, 10, 1, iso()], "B's rollback"),
    { changes: 1 });
  await twin.same("UPDATE admin_action_audit SET outcome = 'success' WHERE operation_id = ?", [operationB],
    "finish B's audit");
  assert.deepEqual(await twin.same(lower, [participantB], "B's exact rollback after its audit finished"),
    { refused: "telemetry_transport_rollback_required" });

  // A lowers once; raised again, the still-started rollback cannot be
  // replayed, because it names revision 1 and the floor is now at 3.
  assert.deepEqual(await twin.same(lower, [participantA], "A's audited lowering"), { changes: 1 });
  await twin.same(RAISE_PARTICIPANT, [10, iso(), participantA], "raise A back to 10 (revision 3)");
  assert.deepEqual(await twin.same(lower, [participantA], "replay of a still-started rollback"),
    { refused: "telemetry_transport_rollback_required" });

  // D1 binds a device lowering to the participant and ranks at any revision,
  // but only while the audit is started.
  assert.deepEqual(await twin.same(lowerDevice, [deviceA], "A's device under the started rollback"), { changes: 1 });
  await twin.same(RAISE_DEVICE, [10, iso(), deviceA], "raise A's device back to 10");
  await twin.same("UPDATE admin_action_audit SET outcome = 'success' WHERE operation_id = ?", [operation], "finish the audit");
  assert.deepEqual(await twin.same(lowerDevice, [deviceA], "a device lowering after the audit finished"),
    { refused: "telemetry_transport_device_floor_rollback_required" });

  assert.deepEqual(await floors(twin, participantA), {
    participant: [{ minimum_rank: 10, revision: 3 }],
    devices: [{ device_id: deviceA, minimum_rank: 10, revision: 3 }],
  });
  assert.deepEqual(await floors(twin, participantB), {
    participant: [{ minimum_rank: 10, revision: 1 }],
    devices: [{ device_id: deviceB, minimum_rank: 10, revision: 1 }],
  });
}));

test("PG17 v1.1 consent admission and its floor raises match D1", {
  skip: SKIP, timeout: 120_000,
}, () => withTwin(async (twin) => {
  allowRetainedHistorySeeding(twin.d1);
  const participant = "participant-consent-a";
  await socialParticipant(twin, participant);
  await socialDevice(twin, participant, "device-consent-1");
  assert.deepEqual(await twin.same(CONSENT, [participant, "device-consent-1", iso()], "v1.1 still staged"),
    { refused: "telemetry_transport_blocked" });
  await twin.same(ACCEPT_V11, [], "accept v1.1");

  // Refusals: accountless owner, revoked device, missing enrollment, history.
  const enrollmentDevice = randomUUID();
  await accountlessOwner(twin, "participant-consent-accountless", enrollmentDevice);
  await socialParticipant(twin, "participant-consent-revoked");
  await socialDevice(twin, "participant-consent-revoked", "device-consent-revoked");
  await twin.same("UPDATE device_credentials SET state = 'revoked', revoked_at = ? WHERE id = ?",
    [iso(), "device-consent-revoked"], "revoke the device");
  await socialParticipant(twin, "participant-consent-unenrolled");
  await socialDevice(twin, "participant-consent-unenrolled", "device-consent-unenrolled");
  await twin.same("DELETE FROM attribution_enrollments WHERE participant_id = ?", ["participant-consent-unenrolled"],
    "remove the enrollment");
  await socialParticipant(twin, "participant-consent-history");
  await socialDevice(twin, "participant-consent-history", "device-consent-history");
  await v02History(twin, "participant-consent-history");
  await socialParticipant(twin, "participant-consent-deleting");
  await socialDevice(twin, "participant-consent-deleting", "device-consent-deleting");
  await twin.same("UPDATE participants SET state = 'deleting' WHERE id = ?", ["participant-consent-deleting"],
    "mark the participant deleting");
  // A social participant holding an accountless-authority device: D1 refuses
  // to store it, so the oracle drops that insert guard; PostgreSQL has no
  // such guard, and its consent admission is the only barrier.
  twin.d1.exec("DROP TRIGGER device_credentials_require_valid_authority");
  await socialParticipant(twin, "participant-consent-authority");
  const mismatchDevice = randomUUID();
  const mismatchIssued = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  const mismatchExpires = new Date(Date.parse(mismatchIssued) + 30 * DAY_MS).toISOString();
  const mismatchSecret = bytes32();
  await twin.run(
    `INSERT INTO accountless_enrollment_ledger (device_id, device_secret_hash, installation_principal_id,
       schema_version, policy_version, authorization_basis, state, issued_at, expires_at)
     VALUES (?, ?, ?, 'accountless-enrollment-v0.1', 'accountless-opt-out-v1', 'accountless-policy-v1', 'active', ?, ?)`,
    [mismatchDevice, mismatchSecret, `install-${mismatchDevice}`, mismatchIssued, mismatchExpires],
  );
  await twin.run(
    `INSERT INTO device_credentials (id, participant_id, authority_kind, accountless_enrollment_device_id,
       secret_hash, state, issued_at, expires_at, last_used_at)
     VALUES (?, ?, 'accountless', ?, ?, 'active', ?, ?, ?)`,
    [mismatchDevice, "participant-consent-authority", mismatchDevice, mismatchSecret, mismatchIssued,
      mismatchExpires, mismatchIssued],
  );
  for (const [owner, device, label] of [
    ["participant-consent-accountless", enrollmentDevice, "accountless owner"],
    ["participant-consent-revoked", "device-consent-revoked", "revoked device"],
    ["participant-consent-unenrolled", "device-consent-unenrolled", "no attribution enrollment"],
    ["participant-consent-history", "device-consent-history", "accepted v0.2 history"],
    ["participant-consent-deleting", "device-consent-deleting", "deleting participant"],
    ["participant-consent-authority", mismatchDevice, "accountless-authority device"],
    [participant, "device-consent-revoked", "device of another participant"],
  ]) {
    assert.deepEqual(await twin.same(CONSENT, [owner, device, iso()], label), { refused: "telemetry_transport_blocked" }, label);
  }

  // First consent: participant 1 -> 11 and the device 1 -> 11, each revision + 1.
  await twin.same(CONSENT, [participant, "device-consent-1", iso()], "first consent");
  assert.deepEqual(await floors(twin, participant), {
    participant: [{ minimum_rank: 11, revision: 1 }],
    devices: [{ device_id: "device-consent-1", minimum_rank: 11, revision: 1 }],
  });
  // A second device starts at 10; its consent still advances the participant
  // revision although the floor is already 11 (the unconditional D1 raise).
  await socialDevice(twin, participant, "device-consent-2");
  await twin.same(CONSENT, [participant, "device-consent-2", iso()], "second consent");
  // A device already at 11 keeps its revision; the participant still moves.
  await socialDevice(twin, participant, "device-consent-3");
  await twin.same(RAISE_DEVICE, [11, iso(), "device-consent-3"], "raise the third device to 11");
  await twin.same(CONSENT, [participant, "device-consent-3", iso()], "third consent");
  assert.deepEqual(await floors(twin, participant), {
    participant: [{ minimum_rank: 11, revision: 3 }],
    devices: [
      { device_id: "device-consent-1", minimum_rank: 11, revision: 1 },
      { device_id: "device-consent-2", minimum_rank: 11, revision: 1 },
      { device_id: "device-consent-3", minimum_rank: 11, revision: 1 },
    ],
  });

  // Consents are immutable, and a duplicate changes nothing.
  assert.deepEqual(await twin.same("UPDATE telemetry_v11_device_consents SET consented_at = ? WHERE device_id = ?",
    [iso(), "device-consent-1"], "consent update"), { refused: "telemetry_consent_immutable" });
  assert.deepEqual(await twin.same(CONSENT, [participant, "device-consent-1", iso()], "duplicate consent"),
    { refused: "unique" });
  await twin.rows(PARTICIPANT_FLOOR, [participant]);
}));

test("PG17 v1.0 chunk admission reads only the device floor and fails closed without one, as D1 does", {
  skip: SKIP, timeout: 120_000,
}, () => withTwin(async (twin) => {
  let sequence = 0;
  const insertChunk = async (participantId, deviceId) => {
    sequence += 1;
    const id = `synthetic-v1-chunk-${sequence}`;
    const key = `telemetry-v1/${participantId}/${id}`;
    // PostgreSQL's reconciliation guard fires first; register the object.
    await twin.pgOnly("INSERT INTO pending_objects (contribution_id, object_key) VALUES (?, ?)", [id, key]);
    const { d1, postgres } = await twin.outcomes(
      `INSERT INTO telemetry_v1_chunks (id, participant_id, device_id, stream, chunk_day, chunk_seq, revision,
         chunk_digest, envelope_digest, parser_version, record_count, accepted_record_count, r2_key,
         device_upload_authorization_id, created_at)
       VALUES (?, ?, ?, 'usage', ?, 0, 1, ?, ?, 'synthetic-floor-v1', 1, 1, ?, ?, ?)`,
      [id, participantId, deviceId, iso().slice(0, 10), hex(`${id}-chunk`), hex(`${id}-envelope`), key,
        `synthetic-missing-authorization-${sequence}`, iso()],
    );
    // Past the floor both stores refuse on a later rule (the upload
    // authorization does not exist); only the floor verdict is compared.
    const verdict = (outcome) => (outcome.refused === "telemetry_transport_blocked" ? "blocked" : "admitted");
    assert.equal(verdict(postgres), verdict(d1), `${participantId}/${deviceId}: ${JSON.stringify({ d1, postgres })}`);
    if (verdict(d1) === "admitted") {
      // Admitted by the floor, each store then refuses the missing upload
      // authorization: D1's consuming-upload trigger, PostgreSQL's foreign key.
      assert.deepEqual({ d1, postgres }, { d1: { refused: "upload unavailable" }, postgres: { refused: "foreign_key" } });
    }
    return verdict(d1);
  };

  await twin.same(ACCEPT_V11, [], "accept v1.1");
  await socialParticipant(twin, "participant-v1-a");
  await socialDevice(twin, "participant-v1-a", "device-v1-a1");
  assert.equal(await insertChunk("participant-v1-a", "device-v1-a1"), "admitted");
  await twin.same(CONSENT, ["participant-v1-a", "device-v1-a1", iso()], "upgrade device a1 to v1.1");
  assert.equal(await insertChunk("participant-v1-a", "device-v1-a1"), "blocked", "an upgraded device cannot return to v1");
  await socialDevice(twin, "participant-v1-a", "device-v1-a2");
  assert.equal(await insertChunk("participant-v1-a", "device-v1-a2"), "admitted",
    "a v1 device stays uploadable while the participant floor is 11");

  await socialParticipant(twin, "participant-v1-b");
  await socialDevice(twin, "participant-v1-b", "device-v1-b1");
  await twin.same("DELETE FROM telemetry_transport_device_floors WHERE device_id = ?", ["device-v1-b1"], "drop the device floor");
  assert.equal(await insertChunk("participant-v1-b", "device-v1-b1"), "blocked",
    "a missing device floor fails closed although the participant floor (1) would admit");

  await twin.same("UPDATE telemetry_transport_formats SET lifecycle = 'blocked' WHERE schema_version = 'telemetry-contribution-v1.0'",
    [], "block v1.0");
  assert.equal(await insertChunk("participant-v1-a", "device-v1-a2"), "blocked");
}));

test("PG17 floor rollbacks are admitted only for a matching started owner audit, as in D1", {
  skip: SKIP, timeout: 120_000,
}, () => withTwin(async (twin) => {
  const participant = "participant:00000000-0000-4000-8000-000000000002";
  const digest = rollbackDigest(participant);
  await socialParticipant(twin, participant);
  await twin.same(RAISE_PARTICIPANT, [10, iso(), participant], "raise to 10 (revision 1)");
  const details = { operation: "telemetry_transport_rollback", participantDigest: digest,
    expectedRevision: 1, fromRank: 10, toRank: 1 };
  let serial = 0;
  const operationId = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;
  const attempt = async (label, { auditDetails = details, action, outcome, row = {}, skipAudit = false } = {}) => {
    const operation = operationId();
    if (!skipAudit) await audit(twin, operation, auditDetails, { action, outcome });
    const values = { participant, digest, expectedRevision: 1, fromRank: 10, toRank: 1, ...row };
    return (await twin.same(ROLLBACK, [operation, values.participant, values.digest, values.expectedRevision,
      values.fromRank, values.toRank, iso()], label));
  };
  const denied = { refused: "telemetry_transport_rollback_denied" };
  assert.deepEqual(await attempt("no audit", { skipAudit: true }), denied);
  assert.deepEqual(await attempt("another action", { action: "sync_distribution" }), denied);
  assert.deepEqual(await attempt("finished audit", { outcome: "success" }), denied);
  for (const [key, value] of [["operation", "telemetry_transport_rollforward"], ["participantDigest", hex("other")],
    ["expectedRevision", 0], ["fromRank", 11], ["toRank", 2]]) {
    assert.deepEqual(await attempt(`details ${key}`, { auditDetails: { ...details, [key]: value } }), denied, key);
  }
  assert.deepEqual(await attempt("stale expected revision", {
    auditDetails: { ...details, expectedRevision: 0 }, row: { expectedRevision: 0 } }), denied);
  assert.deepEqual(await attempt("wrong from rank", {
    auditDetails: { ...details, fromRank: 11 }, row: { fromRank: 11 } }), denied);
  // json_extract semantics: a string never equals a number; 1.0 equals 1;
  // true equals 1; the first of duplicated keys wins; a non-object has none.
  assert.deepEqual(await attempt("string revision", { auditDetails: { ...details, expectedRevision: "1" } }), denied);
  assert.deepEqual(await attempt("array details", { auditDetails: [details] }), denied);
  const duplicateMismatch = JSON.stringify(details).replace("\"toRank\":1", "\"toRank\":2,\"toRank\":1");
  assert.deepEqual(await attempt("first duplicate mismatches", { auditDetails: duplicateMismatch }), denied);

  // An accountless participant has no rollback, whatever its audit says.
  const enrollmentDevice = randomUUID();
  await accountlessOwner(twin, "participant-rollback-accountless", enrollmentDevice);
  assert.deepEqual(await attempt("accountless participant", {
    auditDetails: { ...details, participantDigest: rollbackDigest("participant-rollback-accountless"),
      expectedRevision: 0, fromRank: 11 },
    row: { participant: "participant-rollback-accountless", digest: rollbackDigest("participant-rollback-accountless"),
      expectedRevision: 0, fromRank: 11 } }), denied);

  // Nor has a social participant that is being deleted.
  const deleting = "participant:00000000-0000-4000-8000-0000000000de";
  await socialParticipant(twin, deleting);
  await twin.same(RAISE_PARTICIPANT, [10, iso(), deleting], "raise the deleting participant to 10");
  await twin.same("UPDATE participants SET state = 'deleting' WHERE id = ?", [deleting], "mark it deleting");
  assert.deepEqual(await attempt("deleting participant", {
    auditDetails: { ...details, participantDigest: rollbackDigest(deleting) },
    row: { participant: deleting, digest: rollbackDigest(deleting) } }), denied);

  // Admitted shapes; each is a separate rollback of the same floor state, so
  // each uses its own expected revision slot on a fresh participant.
  const admitted = async (label, auditDetails, row = {}) => {
    const owner = `participant:00000000-0000-4000-8000-${String(100 + ++serial).padStart(12, "0")}`;
    await socialParticipant(twin, owner);
    await twin.same(RAISE_PARTICIPANT, [10, iso(), owner], `${label}: raise`);
    const ownerDigest = rollbackDigest(owner);
    const outcome = await attempt(label, {
      auditDetails: typeof auditDetails === "string" ? auditDetails.replaceAll(digest, ownerDigest)
        : { ...auditDetails, participantDigest: ownerDigest },
      row: { participant: owner, digest: ownerDigest, ...row },
    });
    assert.deepEqual(outcome, { changes: 1 }, label);
  };
  await admitted("exact details", details);
  await admitted("real-valued revision", JSON.stringify(details).replace("\"expectedRevision\":1", "\"expectedRevision\":1.0"));
  await admitted("boolean true as 1", { ...details, toRank: true });
  await admitted("first duplicate matches", JSON.stringify(details).replace("\"toRank\":1", "\"toRank\":1,\"toRank\":2"));

  // Malformed details: both refuse; D1 with json_extract's own error. Once
  // the admin-audit hardening (0050) is applied, PostgreSQL refuses to store
  // a started run_maintenance audit whose details are not JSON at all, which
  // closes the same door one step earlier.
  const operation = operationId();
  const malformedDetails = "{\"operation\":";
  twin.d1Only(AUDIT, [operation, "run_maintenance", "a".repeat(64), "started", malformedDetails, iso()]);
  let stored = true;
  try {
    await twin.pgOnly(AUDIT, [operation, "run_maintenance", "a".repeat(64), "started", malformedDetails, iso()]);
  } catch (error) {
    assert.equal(error?.code, "22P02", "only a JSON cast may refuse the malformed audit");
    stored = false;
  }
  const malformed = await twin.outcomes(ROLLBACK, [operation, participant, digest, 1, 10, 1, iso()]);
  assert.deepEqual(malformed, { d1: { refused: "malformed JSON" }, postgres: denied },
    stored ? "malformed details" : "no started audit exists for the operation");

  // Closed ranks and to_rank < from_rank hold even behind a matching audit.
  const equalRanks = operationId();
  await twin.same(RAISE_PARTICIPANT, [11, iso(), participant], "raise to 11 (revision 2)");
  await audit(twin, equalRanks, { ...details, expectedRevision: 2, fromRank: 11, toRank: 11 });
  assert.deepEqual(await twin.same(ROLLBACK, [equalRanks, participant, digest, 2, 11, 11, iso()], "to_rank = from_rank"),
    { refused: "check" });

  const pinned = operationId();
  await audit(twin, pinned, { ...details, expectedRevision: 2, fromRank: 11, toRank: 10 });
  assert.deepEqual(await twin.same(ROLLBACK, [pinned, participant, digest, 2, 11, 10, iso()], "rollback 11 -> 10"),
    { changes: 1 });

  // The foreign key itself, with the owner-only trigger set aside on both
  // stores (last step: the trigger stays disabled in this discarded schema):
  // a rollback must name an existing audit row.
  twin.d1.exec("DROP TRIGGER telemetry_transport_rollback_owner_only");
  await twin.pgOnly("ALTER TABLE telemetry_transport_floor_rollbacks DISABLE TRIGGER telemetry_transport_rollback_owner_only");
  assert.deepEqual(await twin.same(ROLLBACK, ["00000000-0000-4000-8000-00000000ffff", participant, digest, 3, 11, 10, iso()],
    "a rollback without its audit row"), { refused: "foreign_key" });
}));

test("PG17 only a non-superuser transfer-role member skips floor auto-creation", {
  skip: SKIP, timeout: 180_000,
}, () => withTwin(async (_twin, { local, schema, pool }) => {
  const suffix = randomBytes(4).toString("hex");
  const logins = { member: `synthetic_ta1_member_${suffix}`, runtime: `synthetic_ta1_runtime_${suffix}` };
  const loginNames = Object.values(logins).join(", ");
  const asLogin = async (role, body) => {
    const session = new pg.Client(connectionSettings(local, schema, role));
    await session.connect();
    try {
      return await body(session);
    } finally {
      await session.end();
    }
  };
  // `imported` writes the source's enrollment and participant floor before
  // the device, as an importer does, so a device-floor creator that ignored
  // the bypass would have a participant floor to copy.
  const insertSocial = async (runner, participantId, { imported = false } = {}) => {
    const now = iso();
    await runner.query(
      `INSERT INTO participants (id, owner_kind, state, consent_version, consented_at, created_at)
       VALUES ($1, 'social', 'active', $2, $3, $3)`, [participantId, PARTICIPANT_CONSENT, now]);
    if (imported) {
      await runner.query("INSERT INTO attribution_enrollments (participant_id, namespace, created_at) VALUES ($1, $2, $3)",
        [participantId, hex(`imported-namespace-${participantId}`), now]);
      await runner.query(
        `INSERT INTO telemetry_transport_participant_floors (participant_id, minimum_rank, revision, changed_at)
         VALUES ($1, 11, 4, $2)`, [participantId, now]);
    }
    await runner.query(
      `INSERT INTO web_sessions (id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at)
       VALUES ($1, $2, $3, $4, $5, $6, $5)`, [`session-${participantId}`, participantId, bytes32(), bytes32(), now, iso(DAY_MS)]);
    await runner.query(
      `INSERT INTO device_pairings (id, participant_id, issued_by_session_id, secret_hash, consent_version,
         transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id)
       VALUES ($1, $2, $3, $4, $5, $5, 'consumed', $6, $7, $6, $8)`,
      [`pairing-${participantId}`, participantId, `session-${participantId}`, bytes32(), PAIRING_CONSENT, now, iso(DAY_MS),
        `device-${participantId}`]);
    await runner.query(
      `INSERT INTO device_credentials (id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
         state, issued_at, expires_at, last_used_at, social_verified_at)
       VALUES ($1, $2, 'social', $3, $4, 'active', $5, $6, $5, $5)`,
      [`device-${participantId}`, participantId, `pairing-${participantId}`, bytes32(), now, iso(DAY_MS)]);
  };
  const created = async (participantId) => ({
    enrollment: (await pool.query("SELECT 1 FROM attribution_enrollments WHERE participant_id = $1", [participantId])).rowCount,
    participantFloor: (await pool.query(PARTICIPANT_FLOOR.replace("?", "$1"), [participantId])).rowCount,
    deviceFloor: (await pool.query("SELECT 1 FROM telemetry_transport_device_floors WHERE participant_id = $1", [participantId])).rowCount,
  });
  const all = { enrollment: 1, participantFloor: 1, deviceFloor: 1 };
  const importedOnly = { enrollment: 1, participantFloor: 1, deviceFloor: 0 };
  const predicate = async (runner) => (await runner.query("SELECT storage_journal_transfer_session() AS transfer")).rows[0].transfer;

  const lock = await pool.connect();
  let locked = false;
  let loginsCreated = false;
  let roleCreated = false;
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [TRANSFER_ROLE_LOCK]);
    locked = true;
    await pool.query(`CREATE ROLE ${logins.member} LOGIN NOSUPERUSER NOCREATEROLE`);
    await pool.query(`CREATE ROLE ${logins.runtime} LOGIN NOSUPERUSER NOCREATEROLE`);
    loginsCreated = true;
    await pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${loginNames}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${loginNames}`);
    await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO ${loginNames}`);

    const roleExisted = (await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [TRANSFER_ROLE])).rowCount === 1;
    if (!roleExisted) {
      await asLogin(logins.runtime, (session) => insertSocial(session, "participant-transfer-absent"));
      assert.deepEqual(await created("participant-transfer-absent"), all, "without the role the creators fire");
      await pool.query(`CREATE ROLE ${TRANSFER_ROLE} NOLOGIN`);
      roleCreated = true;
    }
    await pool.query(`GRANT ${TRANSFER_ROLE} TO ${logins.member}`);

    await asLogin(logins.member, async (session) => {
      assert.equal(await predicate(session), true, "a deliberate non-superuser member is a transfer session");
      await insertSocial(session, "participant-transfer-member", { imported: true });
    });
    assert.deepEqual(await created("participant-transfer-member"), importedOnly,
      "an import transfer session inserts the enrollment and floors itself; no device floor is derived");
    assert.deepEqual((await pool.query(PARTICIPANT_FLOOR.replace("?", "$1"), ["participant-transfer-member"])).rows,
      [{ minimum_rank: 11, revision: 4 }], "the imported participant floor is the only one");
    assert.equal((await pool.query("SELECT namespace FROM attribution_enrollments WHERE participant_id = $1",
      ["participant-transfer-member"])).rows[0].namespace, hex("imported-namespace-participant-transfer-member"));

    assert.equal((await pool.query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")).rows[0].rolsuper, true);
    assert.equal((await pool.query("SELECT pg_has_role(current_user, $1, 'MEMBER') AS member", [TRANSFER_ROLE])).rows[0].member,
      true, "pg_has_role counts a superuser as a member");
    assert.equal(await predicate(pool), false, "a superuser is never a transfer session");
    await insertSocial(pool, "participant-transfer-superuser");
    assert.deepEqual(await created("participant-transfer-superuser"), all, "a superuser session does not bypass");

    await asLogin(logins.runtime, async (session) => {
      assert.equal(await predicate(session), false);
      await insertSocial(session, "participant-transfer-runtime");
    });
    assert.deepEqual(await created("participant-transfer-runtime"), all, "a non-member session does not bypass");
  } finally {
    if (loginsCreated) {
      if (roleCreated) await pool.query(`DROP ROLE IF EXISTS ${TRANSFER_ROLE}`).catch(() => {});
      else await pool.query(`REVOKE ${TRANSFER_ROLE} FROM ${loginNames}`).catch(() => {});
      for (const login of Object.values(logins)) {
        await pool.query(`DROP OWNED BY ${login}`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${login}`).catch(() => {});
      }
    }
    if (locked) await lock.query("SELECT pg_advisory_unlock($1)", [TRANSFER_ROLE_LOCK]).catch(() => {});
    lock.release();
  }
}));

/** One migration's SQL in its own transaction, as the runner applies it. */
async function applySql(pool, schema, sql) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='60000ms'");
    await client.query("SET LOCAL lock_timeout='10000ms'");
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

/**
 * A PostgreSQL schema at the chain just before 0051 (whether 0051 is staged
 * or promoted), holding rows written there by the pre-0051 PostgreSQL code;
 * the operation then applies 0051 itself.
 */
async function withPre0051Schema(operation) {
  const local = await endpoint();
  const schema = `ta1_backfill_${randomBytes(6).toString("hex")}`;
  const pool = new pg.Pool({ ...connectionSettings(local, schema), max: 2 });
  let created = false;
  try {
    const server = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "0051 is qualified on PostgreSQL 17");
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    // The runner reads a contiguous chain from 0001. Staged, 0051 follows the
    // whole stock chain; promoted, it follows 0001-0050.
    const { sql, staged } = await readMigration();
    const stock = await readPostgresMigrations({ role: "primary" });
    const chain = stock.filter((entry) => entry.version < MIGRATION_VERSION);
    assert.equal(chain.length, staged ? stock.length : MIGRATION_VERSION - 1, "the whole chain before 0051");
    for (const entry of chain) await applySql(pool, schema, entry.sql);
    return await operation({ pool, schema, apply0051: () => applySql(pool, schema, sql) });
  } finally {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
}

/** Pre-0051 PostgreSQL rows: participant, optional session/pairing/device. */
async function pgSocial(pool, participantId, devices = []) {
  const now = iso();
  await pool.query(
    `INSERT INTO participants (id, owner_kind, access_token_id, access_token_hash, recovery_token_id,
       recovery_token_hash, state, consent_version, consented_at, created_at)
     VALUES ($1, 'social', $2, $3, $4, $5, 'active', $6, $7, $7)`,
    [participantId, `access-${participantId}`, bytes32(), `recovery-${participantId}`, bytes32(), PARTICIPANT_CONSENT, now]);
  if (devices.length === 0) return;
  await pool.query(
    `INSERT INTO web_sessions (id, participant_id, secret_hash, csrf_hash, scope, state, issued_at, expires_at, last_used_at)
     VALUES ($1, $2, $3, $4, 'personal', 'active', $5, $6, $5)`,
    [`session-${participantId}`, participantId, bytes32(), bytes32(), now, iso(DAY_MS)]);
  for (const deviceId of devices) {
    await pool.query(
      `INSERT INTO device_pairings (id, participant_id, issued_by_session_id, secret_hash, consent_version,
         transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id)
       VALUES ($1, $2, $3, $4, $5, $5, 'consumed', $6, $7, $6, $8)`,
      [`pairing-${deviceId}`, participantId, `session-${participantId}`, bytes32(), PAIRING_CONSENT, now, iso(DAY_MS), deviceId]);
    await pool.query(
      `INSERT INTO device_credentials (id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
         state, issued_at, expires_at, last_used_at, social_verified_at)
       VALUES ($1, $2, 'social', $3, $4, 'active', $5, $6, $5, $5)`,
      [deviceId, participantId, `pairing-${deviceId}`, bytes32(), now, iso(30 * DAY_MS)]);
  }
}

const PG_CONSENT = toPostgres(CONSENT);
const PG_FLOOR = `INSERT INTO telemetry_transport_participant_floors (participant_id, minimum_rank, revision, changed_at)
  VALUES ($1, $2, $3, $4)`;

/** The shared seeding helpers (socialParticipant, ...) writing to D1 alone. */
const d1Seeder = (d1) => ({
  d1,
  run: async (sql, values = []) => { d1.prepare(sql).run(...values); },
  d1Only: (sql, values = []) => { d1.prepare(sql).run(...values); },
  pgOnly: async () => {},
});

let d1DeviceFloorBackfill;
/** D1 isolation 0008's device-floor backfill (lines 47-63), verbatim. */
async function d1DeviceFloorBackfillSql() {
  d1DeviceFloorBackfill ??= (async () => {
    const source = await readFile(join(WORKER_ROOT, "ingestion-isolation-migrations", "0008_telemetry_v12.sql"), "utf8");
    const statements = [...source.matchAll(
      /^INSERT INTO telemetry_transport_device_floors \([^)]*\)\s*SELECT d\.participant_id[^;]*;/gmu)].map((match) => match[0]);
    assert.equal(statements.length, 1, "D1 isolation 0008 holds exactly one device-floor backfill");
    return statements[0];
  })();
  return d1DeviceFloorBackfill;
}

const byDevice = (left, right) => (left.device_id < right.device_id ? -1 : left.device_id > right.device_id ? 1 : 0);

test("PG17 0051 backfills D1's enrollment and floor rows for rows that predate it", {
  skip: SKIP, timeout: 120_000,
}, () => withPre0051Schema(async ({ pool, apply0051 }) => {
  const floorChanged = "2026-01-02T03:04:05.000Z";
  // A social participant and device as the pre-0051 PostgreSQL code wrote
  // them: no enrollment, no floor, no device floor.
  await pgSocial(pool, "backfill-social-new", ["backfill-device-new"]);
  // A social participant at 11 whose first device consented to v1.1 and
  // whose second did not (D1 isolation 0008: 11 and 10).
  await pgSocial(pool, "backfill-social-11", ["backfill-device-consented", "backfill-device-plain"]);
  await pool.query(PG_FLOOR, ["backfill-social-11", 11, 1, floorChanged]);
  await pool.query(PG_CONSENT, ["backfill-social-11", "backfill-device-consented", iso()]);
  // A social participant at 10 (a device copies it) whose device already has
  // a floor row and whose enrollment exists: both stay untouched.
  await pgSocial(pool, "backfill-social-10", ["backfill-device-kept", "backfill-device-copy"]);
  await pool.query(PG_FLOOR, ["backfill-social-10", 10, 2, floorChanged]);
  await pool.query("INSERT INTO attribution_enrollments (participant_id, namespace, created_at) VALUES ($1, $2, $3)",
    ["backfill-social-10", hex("kept-namespace"), floorChanged]);
  await pool.query(`INSERT INTO telemetry_transport_device_floors (participant_id, device_id, minimum_rank, revision, changed_at)
    VALUES ($1, $2, 11, 3, $3)`, ["backfill-social-10", "backfill-device-kept", floorChanged]);
  // Accountless participants: one as the enrollment writer creates it
  // (enrollment and rank-11 floor, device without a floor), one bare.
  const issued = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  const expires = new Date(Date.parse(issued) + 30 * DAY_MS).toISOString();
  const ledgerDevice = randomUUID();
  const secret = bytes32();
  await pool.query(
    `INSERT INTO accountless_enrollment_ledger (device_id, device_secret_hash, installation_principal_id,
       schema_version, policy_version, authorization_basis, state, issued_at, expires_at)
     VALUES ($1, $2, $3, 'accountless-enrollment-v0.1', 'accountless-opt-out-v1', 'accountless-policy-v1', 'active', $4, $5)`,
    [ledgerDevice, secret, `install-${ledgerDevice}`, issued, expires]);
  for (const id of ["backfill-accountless-written", "backfill-accountless-bare"]) {
    await pool.query("INSERT INTO participants (id, owner_kind, state, created_at) VALUES ($1, 'accountless', 'active', $2)",
      [id, issued]);
  }
  await pool.query("INSERT INTO attribution_enrollments (participant_id, namespace, created_at) VALUES ($1, $2, $3)",
    ["backfill-accountless-written", hex("accountless-namespace"), issued]);
  await pool.query(PG_FLOOR, ["backfill-accountless-written", 11, 0, floorChanged]);
  await pool.query(
    `INSERT INTO device_credentials (id, participant_id, authority_kind, accountless_enrollment_device_id,
       secret_hash, state, issued_at, expires_at, last_used_at)
     VALUES ($1, $2, 'accountless', $1, $3, 'active', $4, $5, $4)`,
    [ledgerDevice, "backfill-accountless-written", secret, issued, expires]);

  const participants = (await pool.query("SELECT id FROM participants ORDER BY id")).rows.map((row) => row.id);
  await apply0051();

  const enrollments = (await pool.query(
    "SELECT participant_id, namespace FROM attribution_enrollments ORDER BY participant_id")).rows;
  assert.deepEqual(enrollments.map((row) => row.participant_id), participants, "every participant is enrolled");
  for (const { namespace } of enrollments) assert.match(namespace, /^[0-9a-f]{64}$/u);
  assert.equal(new Set(enrollments.map((row) => row.namespace)).size, enrollments.length, "namespaces are distinct");
  const byParticipant = Object.fromEntries(enrollments.map((row) => [row.participant_id, row.namespace]));
  assert.equal(byParticipant["backfill-social-10"], hex("kept-namespace"));
  assert.equal(byParticipant["backfill-accountless-written"], hex("accountless-namespace"));

  assert.deepEqual((await pool.query(
    "SELECT participant_id, minimum_rank, revision FROM telemetry_transport_participant_floors ORDER BY participant_id",
  )).rows, [
    { participant_id: "backfill-accountless-bare", minimum_rank: 11, revision: 0 },
    { participant_id: "backfill-accountless-written", minimum_rank: 11, revision: 0 },
    { participant_id: "backfill-social-10", minimum_rank: 10, revision: 2 },
    { participant_id: "backfill-social-11", minimum_rank: 11, revision: 1 },
    { participant_id: "backfill-social-new", minimum_rank: 1, revision: 0 },
  ], "D1's creation floor (social 1, accountless 11) only where none existed");

  const devices = (await pool.query(
    `SELECT device.device_id, device.minimum_rank, device.revision,
            device.changed_at = participant.changed_at AS participant_time
       FROM telemetry_transport_device_floors device
       JOIN telemetry_transport_participant_floors participant ON participant.participant_id = device.participant_id
      ORDER BY device.device_id`,
  )).rows;
  assert.deepEqual(devices, [
    { device_id: "backfill-device-consented", minimum_rank: 11, revision: 0, participant_time: true },
    { device_id: "backfill-device-copy", minimum_rank: 10, revision: 0, participant_time: true },
    { device_id: "backfill-device-kept", minimum_rank: 11, revision: 3, participant_time: true },
    { device_id: "backfill-device-new", minimum_rank: 1, revision: 0, participant_time: true },
    { device_id: "backfill-device-plain", minimum_rank: 10, revision: 0, participant_time: true },
    { device_id: ledgerDevice, minimum_rank: 11, revision: 0, participant_time: true },
  ].sort((left, right) => left.device_id.localeCompare(right.device_id)),
  "D1 isolation 0008's device floor, stamped with the participant floor's time");

  // Against D1 itself: a D1 oracle holding the same participants, devices
  // and consent. D1's creation triggers give each participant the enrollment
  // and floor it would hold; for the device floors, D1's participant floors
  // are then set to the values PostgreSQL holds, its device floors cleared,
  // and D1 isolation 0008's own backfill statement run verbatim.
  const pgFloors = (await pool.query(
    "SELECT participant_id, minimum_rank, revision, changed_at FROM telemetry_transport_participant_floors",
  )).rows;
  const pgDevices = (await pool.query(
    "SELECT device_id, minimum_rank, revision, changed_at FROM telemetry_transport_device_floors",
  )).rows.map((entry) => ({ ...entry, changed_at: entry.changed_at.toISOString() }));
  const d1 = await d1Oracle();
  try {
    const seed = d1Seeder(d1);
    for (const [participantId, deviceIds] of [
      ["backfill-social-new", ["backfill-device-new"]],
      ["backfill-social-11", ["backfill-device-consented", "backfill-device-plain"]],
      ["backfill-social-10", ["backfill-device-kept", "backfill-device-copy"]],
    ]) {
      await socialParticipant(seed, participantId);
      for (const deviceId of deviceIds) await socialDevice(seed, participantId, deviceId);
    }
    await accountlessOwner(seed, "backfill-accountless-written", ledgerDevice);
    seed.d1Only("INSERT INTO participants (id, owner_kind, state, created_at) VALUES (?, 'accountless', 'active', ?)",
      ["backfill-accountless-bare", issued]);

    const created = ["backfill-accountless-bare", "backfill-social-new"];
    const d1Created = plain(d1.prepare(
      `SELECT floor_row.participant_id, floor_row.minimum_rank, floor_row.revision, length(enrollment.namespace) AS namespace
         FROM telemetry_transport_participant_floors floor_row
         JOIN attribution_enrollments enrollment ON enrollment.participant_id = floor_row.participant_id
        WHERE floor_row.participant_id IN (?, ?) ORDER BY floor_row.participant_id`).all(...created));
    const pgCreated = (await pool.query(
      `SELECT floor_row.participant_id, floor_row.minimum_rank, floor_row.revision, length(enrollment.namespace) AS namespace
         FROM telemetry_transport_participant_floors floor_row
         JOIN attribution_enrollments enrollment ON enrollment.participant_id = floor_row.participant_id
        WHERE floor_row.participant_id = ANY($1) ORDER BY floor_row.participant_id`, [created])).rows;
    assert.deepEqual(pgCreated, d1Created, "a backfilled enrollment and floor are the ones D1 creates");

    for (const name of ["telemetry_transport_floor_revision", "telemetry_transport_floor_no_implicit_downgrade",
      "telemetry_transport_floor_successor_history_guard", "telemetry_v11_consent_admission",
      "telemetry_v11_consent_floor", "telemetry_transport_device_floor_v11_consent"]) {
      d1.exec(`DROP TRIGGER "${name}"`);
    }
    for (const floor of pgFloors) {
      d1.prepare(`UPDATE telemetry_transport_participant_floors SET minimum_rank = ?, revision = ?, changed_at = ?
        WHERE participant_id = ?`).run(floor.minimum_rank, floor.revision, floor.changed_at.toISOString(), floor.participant_id);
    }
    d1.prepare(CONSENT).run("backfill-social-11", "backfill-device-consented", iso());
    d1.exec("DELETE FROM telemetry_transport_device_floors");
    d1.exec(await d1DeviceFloorBackfillSql());
    const d1Devices = plain(d1.prepare(
      "SELECT device_id, minimum_rank, revision, changed_at FROM telemetry_transport_device_floors").all());
    // A device floor PostgreSQL already held is kept, not recomputed.
    const kept = (entry) => entry.device_id !== "backfill-device-kept";
    assert.deepEqual(pgDevices.filter(kept).sort(byDevice), d1Devices.filter(kept).sort(byDevice),
      "each backfilled device floor is the row D1 isolation 0008's backfill writes");
    assert.equal(d1Devices.length, pgDevices.length);
  } finally {
    d1.close();
  }

  // The ported triggers take over from here.
  await pgSocial(pool, "backfill-social-after", ["backfill-device-after"]);
  assert.deepEqual((await pool.query(
    "SELECT minimum_rank, revision FROM telemetry_transport_device_floors WHERE device_id = $1",
    ["backfill-device-after"])).rows, [{ minimum_rank: 1, revision: 0 }]);

  // The owners that predate 0051 keep their upload authority: the
  // device-only v1.0 guard admits a backfilled v1 device (the chunk then
  // stops at the missing upload authorization's foreign key) and still bars
  // the consented one, and the backfilled enrollment admits a v1.1 consent.
  const v1Chunk = async (participantId, deviceId) => {
    const id = `synthetic-backfill-chunk-${deviceId}`;
    const key = `telemetry-v1/${participantId}/${id}`;
    await pool.query("INSERT INTO pending_objects (contribution_id, object_key) VALUES ($1, $2)", [id, key]);
    try {
      await pool.query(
        `INSERT INTO telemetry_v1_chunks (id, participant_id, device_id, stream, chunk_day, chunk_seq, revision,
           chunk_digest, envelope_digest, parser_version, record_count, accepted_record_count, r2_key,
           device_upload_authorization_id, created_at)
         VALUES ($1, $2, $3, 'usage', $4, 0, 1, $5, $6, 'synthetic-floor-v1', 1, 1, $7, $8, $9)`,
        [id, participantId, deviceId, iso().slice(0, 10), hex(`${id}-chunk`), hex(`${id}-envelope`), key,
          `synthetic-missing-authorization-${deviceId}`, iso()]);
      return "inserted";
    } catch (error) {
      return error?.code === "P1007" ? error.message : `sqlstate:${error?.code}`;
    }
  };
  assert.equal(await v1Chunk("backfill-social-new", "backfill-device-new"), "sqlstate:23503",
    "past the floor guard, refused only by the missing upload authorization");
  assert.equal(await v1Chunk("backfill-social-11", "backfill-device-plain"), "sqlstate:23503");
  assert.equal(await v1Chunk("backfill-social-11", "backfill-device-consented"), "telemetry_transport_blocked");
  await pool.query("UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE schema_version = $1", [V11]);
  assert.equal((await pool.query(PG_CONSENT, ["backfill-social-new", "backfill-device-new", iso()])).rowCount, 1);
  assert.deepEqual((await pool.query(
    "SELECT minimum_rank, revision FROM telemetry_transport_device_floors WHERE device_id = $1",
    ["backfill-device-new"])).rows, [{ minimum_rank: 11, revision: 1 }]);
}));

test("PG17 0051 refuses a store holding a v1.1 consent without a participant floor, and writes nothing", {
  skip: SKIP, timeout: 120_000,
}, () => withPre0051Schema(async ({ pool, apply0051 }) => {
  await pgSocial(pool, "backfill-consent-floorless", ["backfill-consent-device"]);
  await pool.query(PG_CONSENT, ["backfill-consent-floorless", "backfill-consent-device", iso()]);
  await pgSocial(pool, "backfill-bystander", ["backfill-bystander-device"]);
  await assert.rejects(apply0051(), (error) =>
    error?.code === "P1005" && error.message === "telemetry_transport_floor_backfill_unavailable");
  const counts = (await pool.query(
    `SELECT (SELECT count(*) FROM attribution_enrollments)::integer AS enrollments,
            (SELECT count(*) FROM telemetry_transport_participant_floors)::integer AS participant_floors,
            (SELECT count(*) FROM telemetry_transport_device_floors)::integer AS device_floors,
            (SELECT count(*) FROM pg_proc WHERE proname = 'telemetry_transport_device_floor_created'
               AND pronamespace = current_schema()::regnamespace)::integer AS functions`,
  )).rows[0];
  assert.deepEqual(counts, { enrollments: 0, participant_floors: 0, device_floors: 0, functions: 0 },
    "the refused migration rolled back as a whole");
}));

test("PG17 0051 refuses a store holding a rank-12 floor, which D1 cannot hold", {
  skip: SKIP, timeout: 120_000,
}, () => withPre0051Schema(async ({ pool, apply0051 }) => {
  // Primary 0005 admits rank 12 on both floor tables; D1's CHECK does not.
  await pgSocial(pool, "backfill-rank-12", ["backfill-rank-12-device"]);
  await pool.query(PG_FLOOR, ["backfill-rank-12", 12, 1, iso()]);
  await assert.rejects(apply0051(), (error) => error?.code === "23514"
    && error.constraint === "telemetry_transport_participant_floors_ranked_check");
  assert.equal((await pool.query("SELECT count(*)::integer AS floors FROM telemetry_transport_device_floors")).rows[0].floors, 0,
    "nothing was backfilled");
}));
