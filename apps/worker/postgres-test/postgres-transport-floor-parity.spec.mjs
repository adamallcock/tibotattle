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

// Every constant 0051 raises, with its SQLSTATE; each is D1's message.
const RAISED = Object.freeze({
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

// Every effective D1 trigger that creates, guards or reads a transport floor
// or its enrollment, consent and rollback records, and its PostgreSQL port.
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
});
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
  assert.equal(raises.length, 14, "every RAISE in 0051 is accounted for");
  const messages = new Set();
  for (const raise of raises) {
    const match = /^'([a-z_]+)' USING ERRCODE = '(P100[57])'$/u.exec(raise);
    assert.ok(match, `constant message and explicit ERRCODE: ${raise}`);
    assert.equal(RAISED[match[1]], match[2], `${match[1]} uses its SQLSTATE`);
    messages.add(match[1]);
  }
  assert.deepEqual([...messages].sort(), Object.keys(RAISED).sort());
  assert.doesNotMatch(code, /RAISE\s+(?:EXCEPTION|NOTICE|WARNING)\s+'[^']*%/u, "no message interpolates a value");
});

test("every effective D1 transport-floor trigger has a named PostgreSQL port", async () => {
  const d1 = await d1Oracle();
  try {
    const found = d1.prepare(
      "SELECT tbl_name, name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY tbl_name, name",
    ).all().filter((row) =>
      /(?:INSERT INTO|UPDATE)\s+(?:attribution_enrollments|telemetry_transport_participant_floors|telemetry_transport_device_floors)\b/u.test(row.sql)
      || FLOOR_TABLES.includes(row.tbl_name)
      || (["telemetry_v1_chunks", "telemetry_contributions"].includes(row.tbl_name)
        && /telemetry_transport_(?:participant_floors|device_floors|formats)\b/u.test(row.sql)))
      .map((row) => `${row.tbl_name}/${row.name}`).sort();
    assert.deepEqual(found, Object.keys(D1_TRIGGER_PORTS).sort(),
      "a new or removed D1 transport-floor trigger needs a PostgreSQL decision here");
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
  for (const [owner, device, label] of [
    ["participant-consent-accountless", enrollmentDevice, "accountless owner"],
    ["participant-consent-revoked", "device-consent-revoked", "revoked device"],
    ["participant-consent-unenrolled", "device-consent-unenrolled", "no attribution enrollment"],
    ["participant-consent-history", "device-consent-history", "accepted v0.2 history"],
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
  const insertSocial = async (runner, participantId) => {
    const now = iso();
    await runner.query(
      `INSERT INTO participants (id, owner_kind, state, consent_version, consented_at, created_at)
       VALUES ($1, 'social', 'active', $2, $3, $3)`, [participantId, PARTICIPANT_CONSENT, now]);
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
  const none = { enrollment: 0, participantFloor: 0, deviceFloor: 0 };
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
      await insertSocial(session, "participant-transfer-member");
    });
    assert.deepEqual(await created("participant-transfer-member"), none,
      "an import transfer session inserts the enrollment and floors itself");

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
