import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
  renderPostgresSearchPath,
} from "../scripts/postgres-migrations.mjs";

/*
 * The PostgreSQL transport write authority
 * (src/postgres-transport-write-authority.ts) against the unmodified Worker
 * assertion (src/telemetry-transport-policy.ts assertTelemetryTransportWriteAllowed)
 * running on a D1 oracle: an in-memory SQLite database built from the D1
 * migration directories the live ingestion D1 applies. Every scenario is
 * written with the same SQL to both stores, and for each of the five formats
 * the Worker's outcome on D1 must equal the PostgreSQL port's outcome through
 * a pool, a transaction client, and a locking transaction client. The only
 * exceptions are the v1.2 cells pinned in KNOWN_V12_DIVERGENCES, which the
 * delegated PostgreSQL v1.2 authority decides differently.
 *
 * PostgreSQL schemas receive the stock primary migrations and then the staged
 * 0051 in one transaction under the runner's search path (0051 supplies the
 * floor triggers both stores rely on). All rows are synthetic and content-free.
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
const D1_DIRECTORIES = Object.freeze([
  "migrations", "typed-ingestion-migrations", "ingestion-bridge-migrations",
  "typed-v11-admission-migrations", "typed-v1-admission-migrations",
  "ingestion-isolation-migrations",
]);
const FORMATS = Object.freeze([
  "telemetry-contribution-v0.1", "telemetry-contribution-v0.2", "telemetry-contribution-v1.0",
  "telemetry-contribution-v1.1", "telemetry-contribution-v1.2",
]);
const PARTICIPANT_CONSENT = "privacy-safe-telemetry-v0.1";
const PAIRING_CONSENT = "ongoing-privacy-safe-telemetry-v1.0";
const DAY_MS = 24 * 60 * 60 * 1000;

let vite;
const modules = new Map();
async function workerModule(path) {
  vite ??= await createServer({
    root: WORKER_ROOT, configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent",
  });
  if (!modules.has(path)) modules.set(path, await vite.ssrLoadModule(path));
  return modules.get(path);
}
after(async () => {
  if (vite) await vite.close();
});

let d1Sources;
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

/** The D1Database surface the Worker assertion uses, over node:sqlite. */
function d1Database(database) {
  const statement = (sql, values = []) => ({
    bind: (...next) => statement(sql, next),
    async first(column) {
      const row = database.prepare(sql).get(...values);
      if (row === undefined) return null;
      const copy = { ...row };
      return column === undefined ? copy : copy[column];
    },
    async all() {
      return { results: database.prepare(sql).all(...values).map((row) => ({ ...row })), success: true, meta: {} };
    },
    async run() {
      return { success: true, meta: { changes: Number(database.prepare(sql).run(...values).changes) } };
    },
  });
  return { prepare: (sql) => statement(sql) };
}

async function readMigration() {
  const found = [];
  for (const [index, path] of MIGRATION_LOCATIONS.entries()) {
    try {
      found.push({ sql: await readFile(path, "utf8"), staged: index === 0 });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  assert.equal(found.length, 1, "0051 is either staged or promoted, never both or neither");
  return found[0];
}

async function endpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "transport authority tests require loopback or a private Unix socket");
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

async function prepareSchema(pool, schema) {
  const { sql, staged } = await readMigration();
  const stock = await readPostgresMigrations({ role: "primary" });
  assert.equal(stock.some((entry) => entry.name === MIGRATION), !staged);
  await applyPostgresMigrations({ role: "primary", schema, pool });
  if (!staged) return;
  assert.ok(stock.every((entry) => entry.version < MIGRATION_VERSION));
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

async function withTwin(operation) {
  const local = await endpoint();
  const schema = `ta1_authority_${randomBytes(6).toString("hex")}`;
  const pool = new pg.Pool({
    host: local.host, port: local.port, user: PG_TEST_USER, password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE,
    ssl: false, max: 6, connectionTimeoutMillis: 5_000, application_name: "pg-transport-write-authority-test",
    options: `-c search_path=${schema},pg_catalog`,
  });
  let created = false;
  const d1 = await d1Oracle();
  try {
    const server = await pool.query(
      "SELECT current_setting('server_version_num')::integer AS version, host(inet_server_addr()) AS address",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "qualified on PostgreSQL 17");
    if (local.socket) assert.equal(server.rows[0].address, null);
    else assert.ok(["127.0.0.1", "::1"].includes(server.rows[0].address));
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await prepareSchema(pool, schema);
    return await operation({ twin: new Twin(d1, pool), pool, schema, d1 });
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

class Twin {
  constructor(d1, pool) {
    this.d1 = d1;
    this.pool = pool;
  }

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

function lease() {
  const issued = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  return { issued, expires: new Date(Date.parse(issued) + 30 * DAY_MS).toISOString() };
}

async function ledgerRow(twin, deviceId, secret, { issued, expires }) {
  await twin.run(
    `INSERT INTO accountless_enrollment_ledger (device_id, device_secret_hash, installation_principal_id,
       schema_version, policy_version, authorization_basis, state, issued_at, expires_at)
     VALUES (?, ?, ?, 'accountless-enrollment-v0.1', 'accountless-opt-out-v1', 'accountless-policy-v1', 'active', ?, ?)`,
    [deviceId, secret, `install-${deviceId}`, issued, expires],
  );
}

/**
 * An accountless owner as each store creates one (D1: participant triggers;
 * PostgreSQL: the enrollment writer's explicit enrollment and rank-11 floor),
 * optionally with the shared v1.1 grant and the v1.2 authorization.
 */
async function accountlessOwner(twin, participantId, deviceId, { v11 = true, v12 = false } = {}) {
  const window = lease();
  const secret = bytes32();
  await ledgerRow(twin, deviceId, secret, window);
  const participant = "INSERT INTO participants (id, owner_kind, state, created_at) VALUES (?, 'accountless', 'active', ?)";
  twin.d1Only(participant, [participantId, window.issued]);
  await twin.pgOnly(participant, [participantId, window.issued]);
  await twin.pgOnly("INSERT INTO attribution_enrollments (participant_id, namespace, created_at) VALUES (?, ?, ?)",
    [participantId, hex(`namespace-${participantId}`), window.issued]);
  await twin.pgOnly(
    "INSERT INTO telemetry_transport_participant_floors (participant_id, minimum_rank, revision, changed_at) VALUES (?, 11, 0, ?)",
    [participantId, window.issued]);
  await twin.run(
    `INSERT INTO device_credentials (id, participant_id, authority_kind, accountless_enrollment_device_id,
       secret_hash, state, issued_at, expires_at, last_used_at)
     VALUES (?, ?, 'accountless', ?, ?, 'active', ?, ?, ?)`,
    [deviceId, participantId, deviceId, secret, window.issued, window.expires, window.issued],
  );
  await twin.run(
    `INSERT INTO accountless_upload_owners (enrollment_device_id, participant_id, device_credential_id,
       policy_version, authorization_basis, authorized_at, expires_at, state)
     VALUES (?, ?, ?, 'accountless-opt-out-v1', 'accountless-policy-v1', ?, ?, 'active')`,
    [deviceId, participantId, deviceId, window.issued, window.expires],
  );
  if (v11) {
    await twin.run(
      `INSERT INTO accountless_v11_device_authorizations (enrollment_device_id, participant_id, device_credential_id,
         telemetry_schema_version, field_dictionary_version, privacy_contract_version, authorized_at, expires_at, state)
       VALUES (?, ?, ?, 'telemetry-contribution-v1.1', 'telemetry-v1.1-registry-2026-08-31.1',
         'ongoing-privacy-safe-telemetry-v1.1', ?, ?, 'active')`,
      [deviceId, participantId, deviceId, window.issued, window.expires],
    );
  }
  if (v12) {
    await twin.run(
      `INSERT INTO accountless_v12_device_authorizations (enrollment_device_id, participant_id, device_credential_id,
         schema_version, policy_version, authorization_basis, telemetry_schema_version, field_dictionary_version,
         privacy_contract_version, authorized_at, expires_at, state)
       VALUES (?, ?, ?, 'accountless-upload-owner-v1.2', 'accountless-telemetry-v1.2-policy-v1', 'accountless-policy-v1.2',
         'telemetry-contribution-v1.2', 'telemetry-v1.2-registry-2026-09-20.1', 'ongoing-privacy-safe-telemetry-v1.2',
         ?, ?, 'active')`,
      [deviceId, participantId, deviceId, window.issued, window.expires],
    );
  }
  return window;
}

const CONSENT = `INSERT INTO telemetry_v11_device_consents (participant_id, device_id, telemetry_schema_version,
  field_dictionary_version, privacy_contract_version, consented_at)
  VALUES (?, ?, 'telemetry-contribution-v1.1', 'telemetry-v1.1-registry-2026-08-31.1',
    'ongoing-privacy-safe-telemetry-v1.1', ?)`;
const V12_CAPABILITY = `INSERT INTO telemetry_v12_device_capabilities (participant_id, device_id, telemetry_schema_version,
  field_dictionary_version, privacy_contract_version, state, consented_at)
  VALUES (?, ?, 'telemetry-contribution-v1.2', 'telemetry-v1.2-registry-2026-09-20.1',
    'ongoing-privacy-safe-telemetry-v1.2', 'accepted', ?)`;
const V02_HISTORY = `INSERT INTO telemetry_contributions (id, participant_id, plaintext_digest, envelope_digest, r2_key,
  status, schema_version, transport_schema_version, range_start, range_end, client_platform, provider_policy_epoch,
  priced_event_coverage_percent, unknown_model_event_count, unknown_billable_units, price_basis,
  declared_record_count, created_at)
  VALUES (?, ?, ?, ?, ?, 'accepted', 'telemetry-contribution-v0.1', 'telemetry-contribution-v0.2', ?, ?,
    'synthetic', 'synthetic-policy', 0, 0, 0, 'synthetic', 0, ?)`;

/** Drop named D1 insert guards so the oracle can hold a shape D1 refuses. */
function dropD1Triggers(d1, names) {
  for (const name of names) {
    assert.equal(d1.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='trigger' AND name=?").get(name)?.present, 1, name);
    d1.exec(`DROP TRIGGER "${name}"`);
  }
}

async function outcome(promise) {
  try {
    await promise;
    return "allowed";
  } catch (error) {
    if (error?.name === "ApiError") return `${error.status} ${error.code}`;
    throw error;
  }
}

/**
 * Cells where the PostgreSQL port does NOT reproduce the Worker, because v1.2
 * is delegated to the existing PostgreSQL v1.2 authority
 * (src/postgres-typed-v12-admission.ts), which TA-1 must not edit and which
 * the typed v1.2 staging path also uses. Each cell is pinned to its exact
 * pair of outcomes, so the fix (or any change) fails here and removes the
 * entry; every entry must be reached by the matrix. Until then the v1.2
 * parity acceptance is not met for these cells.
 */
const KNOWN_V12_DIVERGENCES = Object.freeze({
  "socialAccountScopedConsent telemetry-contribution-v1.2": Object.freeze({
    worker: "allowed",
    postgres: "403 TELEMETRY_TRANSPORT_BLOCKED",
    cause: "the typed v1.2 write gate refuses a social participant whose consent_version is not "
      + "TELEMETRY_CONSENT_VERSION (400 TELEMETRY_REQUIRED); the Worker's v1.2 assertion reads no consent_version, "
      + "and bearer authentication admits ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION",
  }),
});
const divergencesReached = new Set();

/**
 * For every scenario and format: the Worker on D1, then the PostgreSQL port
 * through a pool, a client, and a locking client (each in a transaction that
 * is rolled back). Returns the Worker's matrix.
 */
async function compareMatrix({ twin, pool, schemaOptions, worker, authority }, scenarios) {
  const d1 = d1Database(twin.d1);
  const matrix = {};
  for (const [name, principal] of Object.entries(scenarios)) {
    matrix[name] = {};
    for (const format of FORMATS) {
      const expected = await outcome(worker.assertTelemetryTransportWriteAllowed(d1, principal, format));
      const nowEpoch = Date.now();
      const viaPool = await outcome(authority.assertPostgresTelemetryTransportWriteAllowed(
        pool, principal, format, { ...schemaOptions, nowEpoch }));
      const client = await pool.connect();
      let viaClient;
      let viaLock;
      try {
        await client.query("BEGIN");
        viaClient = await outcome(authority.assertPostgresTelemetryTransportWriteAllowed(
          client, principal, format, { ...schemaOptions, nowEpoch }));
        viaLock = await outcome(authority.assertPostgresTelemetryTransportWriteAllowed(
          client, principal, format, { ...schemaOptions, nowEpoch, lock: true }));
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
      const divergence = KNOWN_V12_DIVERGENCES[`${name} ${format}`];
      if (divergence) {
        divergencesReached.add(`${name} ${format}`);
        const pinned = divergence.postgres;
        assert.deepEqual({ worker: expected, viaPool, viaClient, viaLock },
          { worker: divergence.worker, viaPool: pinned, viaClient: pinned, viaLock: pinned },
          `${name} ${format} is a known divergence (${divergence.cause}); if it changed or is fixed, update or `
          + "remove its KNOWN_V12_DIVERGENCES entry");
      } else {
        assert.deepEqual({ viaPool, viaClient, viaLock }, { viaPool: expected, viaClient: expected, viaLock: expected },
          `${name} ${format}`);
      }
      matrix[name][format] = expected;
    }
  }
  return matrix;
}

const ALLOWED = "allowed";
const AUTH = "401 DEVICE_AUTH_INVALID";
const BLOCKED = "403 TELEMETRY_TRANSPORT_BLOCKED";
const CONSENT_INVALID = "403 TELEMETRY_CONSENT_INVALID";
const row = (v01, v02, v10, v11, v12) => ({
  "telemetry-contribution-v0.1": v01, "telemetry-contribution-v0.2": v02, "telemetry-contribution-v1.0": v10,
  "telemetry-contribution-v1.1": v11, "telemetry-contribution-v1.2": v12,
});

// ---------------------------------------------------------------------------

test("the schema parsers are the Worker's own, and the rank table is the D1 format table", async () => {
  const authority = await workerModule("/src/postgres-transport-write-authority.ts");
  const worker = await workerModule("/src/telemetry-transport-policy.ts");
  assert.equal(authority.telemetryTransportSchemaVersion, worker.telemetryTransportSchemaVersion);
  assert.equal(authority.telemetryTransportSchemaForEnvelope, worker.telemetryTransportSchemaForEnvelope);
  const corpus = [
    ...FORMATS, ...FORMATS.map((format) => format.replace("contribution", "envelope")),
    "telemetry-contribution-v1.3", "telemetry-envelope-v1.3", "telemetry-contribution-v2.0", "telemetry-envelope-v0.3",
    "TELEMETRY-CONTRIBUTION-V1.0", " telemetry-contribution-v1.0", "telemetry-contribution-v1.0\n", "",
    null, undefined, 10, true, {}, ["telemetry-contribution-v1.0"],
  ];
  const parse = (parser, value) => {
    try {
      return parser(value);
    } catch (error) {
      return `${error.status} ${error.code}`;
    }
  };
  assert.deepEqual(
    corpus.map((value) => parse(authority.telemetryTransportSchemaVersion, value)),
    [...FORMATS, ...FORMATS.map(() => BLOCKED), ...Array(14).fill(BLOCKED)],
  );
  assert.deepEqual(
    corpus.map((value) => parse(authority.telemetryTransportSchemaForEnvelope, value)),
    [...FORMATS.map(() => BLOCKED), ...FORMATS, ...Array(14).fill(BLOCKED)],
  );

  const d1 = await d1Oracle();
  try {
    const table = Object.fromEntries(d1.prepare("SELECT schema_version, format_rank FROM telemetry_transport_formats")
      .all().map((entry) => [entry.schema_version, entry.format_rank]));
    assert.deepEqual(authority.TELEMETRY_TRANSPORT_FORMAT_RANKS, { ...table, "telemetry-contribution-v1.2": null },
      "four ranked legacy formats; v1.2 is an unranked successor, as in the Worker");
    assert.ok(Object.isFrozen(authority.TELEMETRY_TRANSPORT_FORMAT_RANKS));
  } finally {
    d1.close();
  }
});

test("argument refusals and storage failures resolve before or without any authority read", async () => {
  const { assertPostgresTelemetryTransportWriteAllowed: assertAllowed } =
    await workerModule("/src/postgres-transport-write-authority.ts");
  const principal = { participantId: "participant-a", deviceId: "device-a" };
  const refusingPool = { async connect() { throw new Error("a refused request must not reach the database"); } };
  const refusingClient = { async query() { throw new Error("a refused request must not reach the database"); }, release() {} };
  const code = async (promise) => outcome(promise);
  for (const connection of [refusingPool, refusingClient]) {
    for (const version of ["telemetry-contribution-v2.0", null, 11, "telemetry-envelope-v1.0"]) {
      assert.equal(await code(assertAllowed(connection, principal, version)), BLOCKED);
    }
    for (const bad of [null, {}, { participantId: "", deviceId: "d" }, { participantId: "p", deviceId: 5 }]) {
      assert.equal(await code(assertAllowed(connection, bad, "telemetry-contribution-v1.0")), AUTH);
    }
  }
  assert.equal(await code(assertAllowed(refusingPool, { participantId: "", deviceId: "" }, "telemetry-contribution-v1.2")),
    BLOCKED, "the Worker refuses every v1.2 condition with one 403");
  await assert.rejects(assertAllowed(refusingPool, principal, "telemetry-contribution-v1.0", { lock: true }),
    { name: "TypeError", message: "PostgreSQL transport authority locks require the caller's transaction client" });
  await assert.rejects(assertAllowed(refusingClient, principal, "telemetry-contribution-v1.0", { lock: "yes" }),
    { name: "TypeError" });
  for (const nowEpoch of [Number.NaN, -1, 1.5, 2 ** 60, "0"]) {
    await assert.rejects(assertAllowed(refusingClient, principal, "telemetry-contribution-v1.0", { nowEpoch }),
      { name: "TypeError", message: "invalid PostgreSQL transport authority time" });
  }
  await assert.rejects(assertAllowed({}, principal, "telemetry-contribution-v1.0"), { name: "TypeError" });
  await assert.rejects(assertAllowed(refusingClient, principal, "telemetry-contribution-v1.0",
    { schema: { primarySchema: "pg_catalog", ledgerSchema: "ledger" } }), { name: "TypeError" });

  // A storage failure is 503, never a refusal the client could act on.
  const failingPool = { async connect() { throw new Error("connection refused"); } };
  const failingClient = { async query() { throw Object.assign(new Error("server closed"), { code: "57P01" }); }, release() {} };
  for (const connection of [failingPool, failingClient]) {
    for (const version of ["telemetry-contribution-v1.0", "telemetry-contribution-v1.2"]) {
      assert.equal(await code(assertAllowed(connection, principal, version)), "503 BACKEND_STORAGE_UNAVAILABLE", version);
    }
  }
});

test("PG17 the write-authority matrix reproduces every Worker code for social and accountless, all five formats, but the pinned v1.2 divergences", {
  skip: SKIP, timeout: 240_000,
}, () => withTwin(async ({ twin, pool, schema, d1 }) => {
  const worker = await workerModule("/src/telemetry-transport-policy.ts");
  const authority = await workerModule("/src/postgres-transport-write-authority.ts");
  const context = {
    twin, pool, worker, authority,
    schemaOptions: { schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` } },
  };
  const principal = (participantId, deviceId) => Object.freeze({ participantId, deviceId });

  // Phase A: v1.1 staged and v1.2 runtime staged.
  await socialParticipant(twin, "social-fresh");
  await socialDevice(twin, "social-fresh", "social-fresh-device");
  await socialParticipant(twin, "social-floorless");
  await socialDevice(twin, "social-floorless", "social-floorless-device");
  await twin.run("DELETE FROM telemetry_transport_participant_floors WHERE participant_id = ?", ["social-floorless"]);
  await socialParticipant(twin, "social-revoked");
  await socialDevice(twin, "social-revoked", "social-revoked-device");
  await twin.run("UPDATE device_credentials SET state = 'revoked', revoked_at = ? WHERE id = ?", [iso(), "social-revoked-device"]);
  await socialParticipant(twin, "social-expired");
  await socialDevice(twin, "social-expired", "social-expired-device");
  await twin.run("UPDATE device_credentials SET expires_at = ? WHERE id = ?", [iso(-60_000), "social-expired-device"]);
  await socialParticipant(twin, "social-deleting");
  await socialDevice(twin, "social-deleting", "social-deleting-device");
  await twin.run("UPDATE participants SET state = 'deleting' WHERE id = ?", ["social-deleting"]);
  // Retained v0.2 history predates the floors; D1 admits it only through its
  // retired v0.2 path, so the oracle seeds it without that table's triggers.
  for (const { name } of twin.d1.prepare(
    "SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='telemetry_contributions'").all()) {
    twin.d1.exec(`DROP TRIGGER "${name}"`);
  }
  await socialParticipant(twin, "social-history");
  await socialDevice(twin, "social-history", "social-history-device");
  const historyId = "synthetic-v02-history";
  await twin.run(V02_HISTORY, [historyId, "social-history", hex("plain"), hex("envelope"), `synthetic/${historyId}`, iso(), iso(), iso()]);
  const accountlessDevice = randomUUID();
  await accountlessOwner(twin, "accountless-granted", accountlessDevice);
  const ungrantedDevice = randomUUID();
  await accountlessOwner(twin, "accountless-ungranted", ungrantedDevice, { v11: false });
  // An accountless owner whose floor was replaced by rank 1: a Worker branch
  // (accountless outside v1.1) that the rank check would otherwise mask.
  const lowDevice = randomUUID();
  await accountlessOwner(twin, "accountless-low-floor", lowDevice);
  await twin.run("DELETE FROM telemetry_transport_device_floors WHERE participant_id = ?", ["accountless-low-floor"]);
  await twin.run("DELETE FROM telemetry_transport_participant_floors WHERE participant_id = ?", ["accountless-low-floor"]);
  await twin.run("INSERT INTO telemetry_transport_participant_floors (participant_id, minimum_rank, revision, changed_at) VALUES (?, 1, 0, ?)",
    ["accountless-low-floor", iso()]);
  // Owner/authority mismatches D1 itself refuses to store; the oracle drops
  // those insert guards so the Worker's own read decides them.
  dropD1Triggers(d1, ["device_credentials_require_valid_authority", "device_pairings_require_social_owner",
    "web_sessions_require_social_owner"]);
  await socialParticipant(twin, "mismatch-social-owner");
  const mismatchLedger = randomUUID();
  const mismatchLease = lease();
  const mismatchSecret = bytes32();
  await ledgerRow(twin, mismatchLedger, mismatchSecret, mismatchLease);
  await twin.run(
    `INSERT INTO device_credentials (id, participant_id, authority_kind, accountless_enrollment_device_id,
       secret_hash, state, issued_at, expires_at, last_used_at)
     VALUES (?, ?, 'accountless', ?, ?, 'active', ?, ?, ?)`,
    [mismatchLedger, "mismatch-social-owner", mismatchLedger, mismatchSecret, mismatchLease.issued,
      mismatchLease.expires, mismatchLease.issued]);
  const mismatchAccountless = randomUUID();
  await accountlessOwner(twin, "mismatch-accountless-owner", mismatchAccountless);
  await twin.run(`INSERT INTO web_sessions (id, participant_id, secret_hash, csrf_hash, scope, state, issued_at, expires_at, last_used_at)
    VALUES (?, ?, ?, ?, 'personal', 'active', ?, ?, ?)`,
  ["session-mismatch-accountless-owner", "mismatch-accountless-owner", bytes32(), bytes32(), iso(), iso(DAY_MS), iso()]);
  await socialDevice(twin, "mismatch-accountless-owner", "mismatch-social-device");

  const phaseA = {
    socialFresh: principal("social-fresh", "social-fresh-device"),
    socialFloorless: principal("social-floorless", "social-floorless-device"),
    socialRevoked: principal("social-revoked", "social-revoked-device"),
    socialExpired: principal("social-expired", "social-expired-device"),
    socialDeleting: principal("social-deleting", "social-deleting-device"),
    socialHistory: principal("social-history", "social-history-device"),
    socialForeignDevice: principal("social-fresh", accountlessDevice),
    unknown: principal("participant-unknown", "device-unknown"),
    accountlessGranted: principal("accountless-granted", accountlessDevice),
    accountlessUngranted: principal("accountless-ungranted", ungrantedDevice),
    accountlessLowFloor: principal("accountless-low-floor", lowDevice),
    socialOwnerAccountlessDevice: principal("mismatch-social-owner", mismatchLedger),
    accountlessOwnerSocialDevice: principal("mismatch-accountless-owner", "mismatch-social-device"),
  };
  assert.deepEqual(await compareMatrix(context, phaseA), {
    socialFresh: row(ALLOWED, BLOCKED, ALLOWED, BLOCKED, BLOCKED),
    socialFloorless: row(AUTH, AUTH, AUTH, AUTH, BLOCKED),
    socialRevoked: row(AUTH, AUTH, AUTH, AUTH, BLOCKED),
    socialExpired: row(AUTH, AUTH, AUTH, AUTH, BLOCKED),
    socialDeleting: row(AUTH, AUTH, AUTH, AUTH, BLOCKED),
    socialHistory: row(ALLOWED, BLOCKED, ALLOWED, BLOCKED, BLOCKED),
    socialForeignDevice: row(AUTH, AUTH, AUTH, AUTH, BLOCKED),
    unknown: row(AUTH, AUTH, AUTH, AUTH, BLOCKED),
    accountlessGranted: row(BLOCKED, BLOCKED, BLOCKED, BLOCKED, BLOCKED),
    accountlessUngranted: row(BLOCKED, BLOCKED, BLOCKED, BLOCKED, BLOCKED),
    accountlessLowFloor: row(BLOCKED, BLOCKED, BLOCKED, BLOCKED, BLOCKED),
    socialOwnerAccountlessDevice: row(AUTH, AUTH, AUTH, AUTH, BLOCKED),
    accountlessOwnerSocialDevice: row(AUTH, AUTH, AUTH, AUTH, BLOCKED),
  });

  // Phase B: v1.1 accepted and the v1.2 runtime active.
  await twin.run("UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE schema_version = 'telemetry-contribution-v1.1'");
  twin.d1Only("UPDATE telemetry_v12_runtime SET state = 'active', policy_revision = policy_revision + 1, changed_at = ? WHERE id = 1", [iso()]);
  await twin.pgOnly("UPDATE telemetry_v12_runtime SET state = 'active', revision = revision + 1, changed_at = ? WHERE id = 1", [iso()]);
  await twin.pgOnly("UPDATE telemetry_v12_typed_runtime SET state = 'active', policy_revision = policy_revision + 1, changed_at = ? WHERE id = 1", [iso()]);

  await socialParticipant(twin, "social-consented");
  await socialDevice(twin, "social-consented", "social-consented-1");
  await twin.run(CONSENT, ["social-consented", "social-consented-1", iso()]);
  await socialDevice(twin, "social-consented", "social-consented-2");
  await socialDevice(twin, "social-consented", "social-consented-3");
  await twin.run("DELETE FROM telemetry_transport_device_floors WHERE device_id = ?", ["social-consented-3"]);
  await socialParticipant(twin, "social-v12");
  await socialDevice(twin, "social-v12", "social-v12-device");
  await twin.run(V12_CAPABILITY, ["social-v12", "social-v12-device", iso()]);
  await socialDevice(twin, "social-v12", "social-v12-revoked");
  await twin.run(V12_CAPABILITY, ["social-v12", "social-v12-revoked", iso()]);
  await twin.run("UPDATE telemetry_v12_device_capabilities SET state = 'revoked', revoked_at = ? WHERE device_id = ?",
    [iso(), "social-v12-revoked"]);
  const accountlessV12 = randomUUID();
  await accountlessOwner(twin, "accountless-v12", accountlessV12, { v12: true });
  const accountlessV12Only = randomUUID();
  await accountlessOwner(twin, "accountless-v12-only", accountlessV12Only, { v11: false, v12: true });
  const revokedLedger = randomUUID();
  await accountlessOwner(twin, "accountless-ledger-revoked", revokedLedger, { v12: true });
  await twin.run(`UPDATE accountless_enrollment_ledger SET state = 'revoked', revoked_at = ?, revocation_reason = 'user_opt_out'
    WHERE device_id = ?`, [iso(), revokedLedger]);
  // Accountless chains PostgreSQL can store although D1's immutability
  // triggers refuse the updates that make them (PostgreSQL has neither
  // trigger): the owner or the v1.1 grant revoked under an active ledger, or
  // one lease out of step with the others. The oracle drops those guards so
  // the Worker's own read decides each shape.
  dropD1Triggers(d1, ["accountless_upload_owner_immutable", "accountless_v11_authorization_immutable",
    "accountless_device_credential_nonrenewable"]);
  const dayEarlier = ({ expires }) => new Date(Date.parse(expires) - DAY_MS).toISOString();
  const ownerRevoked = randomUUID();
  await accountlessOwner(twin, "accountless-owner-revoked", ownerRevoked);
  await twin.run(`UPDATE accountless_upload_owners SET state = 'revoked', revoked_at = ?,
    revocation_reason = 'operator_containment' WHERE enrollment_device_id = ?`, [iso(), ownerRevoked]);
  const grantRevoked = randomUUID();
  await accountlessOwner(twin, "accountless-grant-revoked", grantRevoked);
  await twin.run(`UPDATE accountless_v11_device_authorizations SET state = 'revoked', revoked_at = ?,
    revocation_reason = 'operator_containment' WHERE enrollment_device_id = ?`, [iso(), grantRevoked]);
  const ownerSkew = randomUUID();
  const ownerSkewLease = await accountlessOwner(twin, "accountless-owner-skew", ownerSkew);
  await twin.run("UPDATE accountless_upload_owners SET expires_at = ? WHERE enrollment_device_id = ?",
    [dayEarlier(ownerSkewLease), ownerSkew]);
  const grantSkew = randomUUID();
  const grantSkewLease = await accountlessOwner(twin, "accountless-grant-skew", grantSkew);
  await twin.run("UPDATE accountless_v11_device_authorizations SET expires_at = ? WHERE enrollment_device_id = ?",
    [dayEarlier(grantSkewLease), grantSkew]);
  const deviceSkew = randomUUID();
  const deviceSkewLease = await accountlessOwner(twin, "accountless-device-skew", deviceSkew);
  await twin.run("UPDATE device_credentials SET expires_at = ? WHERE id = ?", [dayEarlier(deviceSkewLease), deviceSkew]);
  // A social owner enrolled under the account-scoped consent, which bearer
  // authentication admits on both runtimes, with an accepted v1.2 capability.
  await socialParticipant(twin, "social-account-scoped");
  await socialDevice(twin, "social-account-scoped", "social-account-scoped-device");
  await twin.run("UPDATE participants SET consent_version = ? WHERE id = ?",
    ["privacy-safe-telemetry-v0.2", "social-account-scoped"]);
  await twin.run(V12_CAPABILITY, ["social-account-scoped", "social-account-scoped-device", iso()]);

  const phaseB = {
    ...phaseA,
    socialConsented: principal("social-consented", "social-consented-1"),
    socialSecondDevice: principal("social-consented", "social-consented-2"),
    socialFloorFallback: principal("social-consented", "social-consented-3"),
    socialV12: principal("social-v12", "social-v12-device"),
    socialV12Revoked: principal("social-v12", "social-v12-revoked"),
    accountlessV12: principal("accountless-v12", accountlessV12),
    accountlessV12Only: principal("accountless-v12-only", accountlessV12Only),
    accountlessLedgerRevoked: principal("accountless-ledger-revoked", revokedLedger),
    accountlessOwnerRevoked: principal("accountless-owner-revoked", ownerRevoked),
    accountlessGrantRevoked: principal("accountless-grant-revoked", grantRevoked),
    accountlessOwnerExpirySkew: principal("accountless-owner-skew", ownerSkew),
    accountlessGrantExpirySkew: principal("accountless-grant-skew", grantSkew),
    accountlessDeviceExpirySkew: principal("accountless-device-skew", deviceSkew),
    socialAccountScopedConsent: principal("social-account-scoped", "social-account-scoped-device"),
  };
  assert.deepEqual(await compareMatrix(context, phaseB), {
    socialFresh: row(ALLOWED, BLOCKED, ALLOWED, CONSENT_INVALID, BLOCKED),
    socialFloorless: row(AUTH, AUTH, AUTH, AUTH, BLOCKED),
    socialRevoked: row(AUTH, AUTH, AUTH, AUTH, BLOCKED),
    socialExpired: row(AUTH, AUTH, AUTH, AUTH, BLOCKED),
    socialDeleting: row(AUTH, AUTH, AUTH, AUTH, BLOCKED),
    socialHistory: row(ALLOWED, BLOCKED, ALLOWED, BLOCKED, BLOCKED),
    socialForeignDevice: row(AUTH, AUTH, AUTH, AUTH, BLOCKED),
    unknown: row(AUTH, AUTH, AUTH, AUTH, BLOCKED),
    accountlessGranted: row(BLOCKED, BLOCKED, BLOCKED, ALLOWED, BLOCKED),
    accountlessUngranted: row(BLOCKED, BLOCKED, BLOCKED, CONSENT_INVALID, BLOCKED),
    accountlessLowFloor: row(BLOCKED, BLOCKED, BLOCKED, ALLOWED, BLOCKED),
    socialOwnerAccountlessDevice: row(AUTH, AUTH, AUTH, AUTH, BLOCKED),
    accountlessOwnerSocialDevice: row(AUTH, AUTH, AUTH, AUTH, BLOCKED),
    // Participant 11 and device 11 after consent.
    socialConsented: row(BLOCKED, BLOCKED, BLOCKED, ALLOWED, BLOCKED),
    // A later device gets 10: v1.0 stays open, v1.1 needs its own consent.
    socialSecondDevice: row(BLOCKED, BLOCKED, ALLOWED, CONSENT_INVALID, BLOCKED),
    // No device floor row: COALESCE falls back to the participant floor (11).
    socialFloorFallback: row(BLOCKED, BLOCKED, BLOCKED, CONSENT_INVALID, BLOCKED),
    socialV12: row(ALLOWED, BLOCKED, ALLOWED, CONSENT_INVALID, ALLOWED),
    socialV12Revoked: row(ALLOWED, BLOCKED, ALLOWED, CONSENT_INVALID, BLOCKED),
    accountlessV12: row(BLOCKED, BLOCKED, BLOCKED, ALLOWED, ALLOWED),
    accountlessV12Only: row(BLOCKED, BLOCKED, BLOCKED, CONSENT_INVALID, ALLOWED),
    accountlessLedgerRevoked: row(BLOCKED, BLOCKED, BLOCKED, CONSENT_INVALID, BLOCKED),
    // Every link of the ledger/owner/grant chain must be active with one
    // shared lease, the device's included.
    accountlessOwnerRevoked: row(BLOCKED, BLOCKED, BLOCKED, CONSENT_INVALID, BLOCKED),
    accountlessGrantRevoked: row(BLOCKED, BLOCKED, BLOCKED, CONSENT_INVALID, BLOCKED),
    accountlessOwnerExpirySkew: row(BLOCKED, BLOCKED, BLOCKED, CONSENT_INVALID, BLOCKED),
    accountlessGrantExpirySkew: row(BLOCKED, BLOCKED, BLOCKED, CONSENT_INVALID, BLOCKED),
    accountlessDeviceExpirySkew: row(BLOCKED, BLOCKED, BLOCKED, CONSENT_INVALID, BLOCKED),
    // The Worker's v1.2 cell; PostgreSQL's is pinned in KNOWN_V12_DIVERGENCES.
    socialAccountScopedConsent: row(ALLOWED, BLOCKED, ALLOWED, CONSENT_INVALID, ALLOWED),
  });
  assert.deepEqual([...divergencesReached].sort(), Object.keys(KNOWN_V12_DIVERGENCES).sort(),
    "every known divergence is exercised by the matrix");

  // A v1.2 format row is never consulted: blocking it changes nothing.
  await twin.pgOnly("UPDATE telemetry_transport_formats SET lifecycle = 'blocked' WHERE schema_version = 'telemetry-contribution-v1.2'");
  assert.equal(await outcome(authority.assertPostgresTelemetryTransportWriteAllowed(pool, phaseB.socialV12,
    "telemetry-contribution-v1.2", context.schemaOptions)), ALLOWED);
  const legacyRanks = Object.fromEntries((await pool.query(
    "SELECT schema_version, format_rank FROM telemetry_transport_formats WHERE schema_version <> 'telemetry-contribution-v1.2'",
  )).rows.map((entry) => [entry.schema_version, entry.format_rank]));
  assert.deepEqual({ ...legacyRanks, "telemetry-contribution-v1.2": null }, authority.TELEMETRY_TRANSPORT_FORMAT_RANKS);
}));

test("PG17 a locking client holds FOR SHARE on every row it decided on until its transaction ends", {
  skip: SKIP, timeout: 120_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { assertPostgresTelemetryTransportWriteAllowed: assertAllowed } =
    await workerModule("/src/postgres-transport-write-authority.ts");
  const options = { schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` } };
  await twin.pgOnly("UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE schema_version = 'telemetry-contribution-v1.1'");
  await socialParticipant(twin, "lock-social");
  await socialDevice(twin, "lock-social", "lock-social-device");
  await twin.pgOnly(CONSENT, ["lock-social", "lock-social-device", iso()]);
  const enrollment = randomUUID();
  await accountlessOwner(twin, "lock-accountless", enrollment);

  const probes = {
    social: [
      ["participants", "id = $1", ["lock-social"]],
      ["device_credentials", "id = $1", ["lock-social-device"]],
      ["telemetry_transport_participant_floors", "participant_id = $1", ["lock-social"]],
      ["telemetry_transport_device_floors", "device_id = $1", ["lock-social-device"]],
      ["telemetry_transport_formats", "schema_version = $1", ["telemetry-contribution-v1.1"]],
      ["telemetry_v11_device_consents", "device_id = $1", ["lock-social-device"]],
    ],
    accountless: [
      ["participants", "id = $1", ["lock-accountless"]],
      ["device_credentials", "id = $1", [enrollment]],
      ["telemetry_transport_participant_floors", "participant_id = $1", ["lock-accountless"]],
      ["telemetry_transport_device_floors", "device_id = $1", [enrollment]],
      ["telemetry_transport_formats", "schema_version = $1", ["telemetry-contribution-v1.1"]],
      ["accountless_enrollment_ledger", "device_id = $1", [enrollment]],
      ["accountless_upload_owners", "enrollment_device_id = $1", [enrollment]],
      ["accountless_v11_device_authorizations", "enrollment_device_id = $1", [enrollment]],
    ],
  };
  const principals = {
    social: { participantId: "lock-social", deviceId: "lock-social-device" },
    accountless: { participantId: "lock-accountless", deviceId: enrollment },
  };
  const rival = await pool.connect();
  try {
    for (const [kind, rows] of Object.entries(probes)) {
      for (const lock of [false, true]) {
        const holder = await pool.connect();
        try {
          await holder.query("BEGIN");
          assert.equal(await outcome(assertAllowed(holder, principals[kind], "telemetry-contribution-v1.1",
            { ...options, lock })), ALLOWED);
          for (const [table, where, values] of rows) {
            const probe = rival.query(`SELECT 1 FROM "${schema}".${table} WHERE ${where} FOR UPDATE NOWAIT`, values);
            if (lock) {
              await assert.rejects(probe, (error) => error?.code === "55P03", `${kind} ${table} is share-locked`);
            } else {
              assert.equal((await probe).rowCount, 1, `${kind} ${table} is not locked without lock`);
            }
          }
          await holder.query("ROLLBACK");
          for (const [table, where, values] of rows) {
            assert.equal((await rival.query(`SELECT 1 FROM "${schema}".${table} WHERE ${where} FOR UPDATE NOWAIT`, values)).rowCount,
              1, `${kind} ${table} is released with the transaction`);
          }
        } finally {
          await holder.query("ROLLBACK").catch(() => {});
          holder.release();
        }
      }
    }
  } finally {
    rival.release();
  }
}));
