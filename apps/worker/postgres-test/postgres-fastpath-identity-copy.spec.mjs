import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import {
  compareFastpathOwnerRevisions,
  compareFastpathOwnerRoster,
  compareFastpathPublicSourceOwners,
  fastpathIdentityAllowlistSha256,
  fastpathTransportAllowlistSha256,
  openSealedFastpathIdentitySource,
  POSTGRES_FASTPATH_IDENTITY_ALLOWLIST,
  POSTGRES_FASTPATH_IDENTITY_SOURCE_COMMIT,
  POSTGRES_FASTPATH_IDENTITY_TARGET_SCHEMA_PREFIX,
  POSTGRES_FASTPATH_TRANSPORT_ALLOWLIST,
  POSTGRES_FASTPATH_TRANSPORT_PARTS,
  runPostgresFastpathIdentityCopy,
  runPostgresFastpathTransportCopy,
} from "../scripts/postgres-fastpath-identity-copy.mjs";

// PG17 acceptance for the GCP fast-path identity/authority copy (T-1). The
// source is a SQLite file built here by applying this checkout's
// USAGE_MONITOR_DB D1 migrations with node:sqlite and inserting synthetic,
// content-free rows. A shallow CI checkout (fetch-depth 1) has those files
// but not d43c8f92, which is not an ancestor of this line. For every object
// the copy reads they are byte-identical to d43c8f92's: the checkout only adds
// the accountless-history-transfer objects and one v1.2 trigger, and lacks two
// typed-ingestion indexes. D43C8F92_COPIED_LAYOUT_SHA256 pins that layout;
// every fixture build asserts it, and the layout test re-derives it from
// d43c8f92 itself whenever that commit is in the local object store. Every
// PostgreSQL schema is created by this spec under a random name and dropped
// at the end.

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "5432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD ?? "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const WORKER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The reviewed allowlist. A change to the table set, column mapping,
// selection, omissions or source row rules changes this digest and must be
// re-reviewed here.
const ALLOWLIST_SHA256 = "303facb9a9decbd6dd50dcf04044bfea21838c22a7a7e910e8bf02238c956d28";
const TRANSPORT_ALLOWLIST_SHA256 = "a71d5d30f55b3187acd09cc02cc91499d3f2ae68423661bd9d1c3f2759c2326e";

// sha256 of the sqlite_master rows (type, name, tbl_name, sql) of every
// allowlisted table, storage_owner_revisions, storage_source_state and the
// community_public_source_owners view, as the d43c8f92 chain creates them.
const D43C8F92_COPIED_LAYOUT_SHA256 = "0d9f5dee9fda6c40f75ed45579f7cedc65403f7a57f9d0b127d3b8968cecbc9c";

// The USAGE_MONITOR_DB chain, in the order the d43c8f92 oracle specs apply it
// to env.USAGE_MONITOR_DB. legacy-migrations is retired staging evidence and
// is never applied.
const D1_MIGRATION_DIRECTORIES = Object.freeze([
  "migrations",
  "typed-ingestion-migrations",
  "ingestion-bridge-migrations",
  "typed-v11-admission-migrations",
  "typed-v1-admission-migrations",
  "ingestion-isolation-migrations",
]);

const SOCIAL_CONSENT = "privacy-safe-telemetry-v0.1";
const PAIRING_CONSENT = "ongoing-privacy-safe-telemetry-v1.0";
const SOURCE_ID = "synthetic-fastpath-identity-source";

const cleanup = [];
after(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => {});
});

// ---------------------------------------------------------------------------
// The d43c8f92 source fixture.

function git(...args) {
  return execFileSync("git", ["-C", WORKER_ROOT, ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
}

const D1_MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/u;

let checkoutMigrations;
/** This checkout's D1 chain: present in any checkout, shallow or not. */
async function readCheckoutD1Migrations() {
  if (checkoutMigrations) return checkoutMigrations;
  const migrations = [];
  for (const directory of D1_MIGRATION_DIRECTORIES) {
    const names = (await readdir(join(WORKER_ROOT, directory))).filter(name => D1_MIGRATION_NAME.test(name)).sort();
    assert.ok(names.length > 0, `no D1 migrations in ${directory}`);
    for (const name of names) {
      migrations.push({ directory, name, sql: await readFile(join(WORKER_ROOT, directory, name), "utf8") });
    }
  }
  checkoutMigrations = Object.freeze(migrations);
  return checkoutMigrations;
}

/** The d43c8f92 chain from git, or null when the commit is not in the object store. */
function readSourceCommitD1Migrations() {
  try {
    git("cat-file", "-e", `${POSTGRES_FASTPATH_IDENTITY_SOURCE_COMMIT}^{commit}`);
  } catch {
    return null;
  }
  const migrations = [];
  for (const directory of D1_MIGRATION_DIRECTORIES) {
    const names = git("ls-tree", "--full-tree", "--name-only", `${POSTGRES_FASTPATH_IDENTITY_SOURCE_COMMIT}:apps/worker/${directory}/`)
      .split("\n").filter(name => D1_MIGRATION_NAME.test(name)).sort();
    assert.ok(names.length > 0, `no d43c8f92 D1 migrations in ${directory}`);
    for (const name of names) {
      migrations.push({ directory, name,
        sql: git("show", `${POSTGRES_FASTPATH_IDENTITY_SOURCE_COMMIT}:apps/worker/${directory}/${name}`) });
    }
  }
  return Object.freeze(migrations);
}

/** Apply a D1 chain after the ledger vitest-pool-workers' applyD1Migrations creates (some triggers read it). */
function applyD1Chain(database, migrations) {
  database.exec(`CREATE TABLE "d1_migrations" (
\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,
\t\tname       TEXT UNIQUE,
\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
\t)`);
  const record = database.prepare("INSERT INTO d1_migrations (name) VALUES (?)");
  for (const migration of migrations) {
    database.exec(migration.sql);
    record.run(migration.name);
  }
}

function copiedLayoutDigest(database) {
  const objects = [...POSTGRES_FASTPATH_IDENTITY_ALLOWLIST.map(entry => entry.table),
    "storage_owner_revisions", "storage_source_state", "community_public_source_owners"].sort();
  const rows = objects.map(name => {
    const row = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name = ?").get(name);
    assert.ok(row, `${name} is missing from the D1 chain`);
    return [row.type, row.name, row.tbl_name, row.sql];
  });
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

const at = minutes => new Date(Date.UTC(2026, 8, 1, 12, 0, 0) + minutes * 60_000).toISOString();
const hex = () => randomBytes(32).toString("hex");
const bytes = () => randomBytes(32);

function schemaDigest(database) {
  const rows = database.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
  return createHash("sha256").update(JSON.stringify(rows.map(row => [row.type, row.name, row.tbl_name, row.sql])))
    .digest("hex");
}

/**
 * Synthetic owners. Eligible in D1: two active social owners, one active
 * accountless v1.1 owner, one accountless v1.1 opt-out with a retention
 * marker. Ineligible: a 'deleting' social participant, an accountless v1.2
 * successor without a v1.2 head, and an accountless opt-out without a marker.
 */
function seedSyntheticRows(database) {
  const insert = (table, row) => {
    const columns = Object.keys(row);
    database.prepare(`INSERT INTO "${table}" (${columns.map(column => `"${column}"`).join(",")})
      VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(column => row[column]));
  };
  const ids = {};
  const social = (key, { state = "active", identityLinked = false } = {}) => {
    const participantId = `participant:${randomUUID()}`;
    insert("participants", {
      id: participantId, owner_kind: "social", access_token_id: randomUUID(), access_token_hash: bytes(),
      recovery_token_id: randomUUID(), recovery_token_hash: bytes(), state, consent_version: SOCIAL_CONSENT,
      consented_at: at(0), created_at: at(0), deletion_session_id: state === "deleting" ? randomUUID() : null,
      identity_link_key: identityLinked ? hex() : null, identity_cooldown_digest: null,
    });
    const sessionId = randomUUID();
    insert("web_sessions", {
      id: sessionId, participant_id: participantId, secret_hash: bytes(), csrf_hash: bytes(), scope: "personal",
      state: "active", issued_at: at(1), expires_at: at(31), last_used_at: at(2), revoked_at: null,
    });
    const pairingId = randomUUID();
    const deviceId = randomUUID();
    insert("device_pairings", {
      id: pairingId, participant_id: participantId, issued_by_session_id: sessionId, secret_hash: bytes(),
      consent_version: PAIRING_CONSENT, state: "consumed", issued_at: at(2), expires_at: at(12), consumed_at: at(3),
      revoked_at: null, claimed_device_id: deviceId, transport_consent_version: PAIRING_CONSENT,
    });
    insert("device_credentials", {
      id: deviceId, participant_id: participantId, authority_kind: "social", paired_via_pairing_id: pairingId,
      accountless_enrollment_device_id: null, secret_hash: bytes(), state: "active", issued_at: at(3),
      expires_at: at(60 * 24 * 180), last_used_at: at(4), revoked_at: null, social_verified_at: at(3),
      credential_generation: 1,
    });
    ids[key] = { participantId, deviceId, sessionId, pairingId, ownerDigest: hex() };
    return ids[key];
  };
  const accountless = (key, { revokedAt = null } = {}) => {
    const participantId = `participant:${randomUUID()}`;
    const deviceId = randomUUID();
    const secretHash = bytes();
    const expiresAt = at(5 + 60 * 24 * 30);
    const revoked = revokedAt === null
      ? { state: "active", revoked_at: null, revocation_reason: null }
      : { state: "revoked", revoked_at: revokedAt, revocation_reason: "user_opt_out" };
    insert("participants", {
      id: participantId, owner_kind: "accountless", access_token_id: null, access_token_hash: null,
      recovery_token_id: null, recovery_token_hash: null, state: "active", consent_version: null,
      consented_at: null, created_at: at(5), deletion_session_id: null, identity_link_key: null,
      identity_cooldown_digest: null,
    });
    insert("accountless_enrollment_ledger", {
      device_id: deviceId, device_secret_hash: secretHash, installation_principal_id: `accountless:${randomUUID()}`,
      schema_version: "accountless-enrollment-v0.1", policy_version: "accountless-opt-out-v1",
      authorization_basis: "accountless-policy-v1", issued_at: at(5), expires_at: expiresAt,
      renewal_generation: 0, renewed_at: null, ...revoked,
    });
    insert("device_credentials", {
      id: deviceId, participant_id: participantId, authority_kind: "accountless", paired_via_pairing_id: null,
      accountless_enrollment_device_id: deviceId, secret_hash: secretHash, state: revoked.state, issued_at: at(5),
      expires_at: expiresAt, last_used_at: at(6), revoked_at: revoked.revoked_at, social_verified_at: null,
      credential_generation: 1,
    });
    insert("accountless_upload_owners", {
      enrollment_device_id: deviceId, participant_id: participantId, device_credential_id: deviceId,
      policy_version: "accountless-opt-out-v1", authorization_basis: "accountless-policy-v1", authorized_at: at(6),
      expires_at: expiresAt, ...revoked,
    });
    ids[key] = { participantId, deviceId, ownerDigest: hex(), revoked, expiresAt };
    return ids[key];
  };
  const v11Grant = owner => insert("accountless_v11_device_authorizations", {
    enrollment_device_id: owner.deviceId, participant_id: owner.participantId, device_credential_id: owner.deviceId,
    telemetry_schema_version: "telemetry-contribution-v1.1", field_dictionary_version: "telemetry-v1.1-registry-2026-08-31.1",
    privacy_contract_version: "ongoing-privacy-safe-telemetry-v1.1", authorized_at: at(6), expires_at: owner.expiresAt,
    ...owner.revoked,
  });
  const v11Domain = (owner, previousGenerationId = null) => {
    const tokenHash = hex();
    const fingerprint = hex();
    insert("telemetry_v11_domain_predecessors", {
      token_hash: tokenHash, participant_id: owner.participantId, device_id: owner.deviceId,
      previous_generation_id: previousGenerationId, legacy_fingerprint: fingerprint, input_revision: 0,
      from_day: "2026-09-01", through_day: "2026-09-02", winners_json: "[]", created_at: at(7), expires_at: at(60 * 24),
      consumed_at: at(8),
    });
    const generationId = randomUUID();
    insert("telemetry_v11_domains", {
      id: generationId, participant_id: owner.participantId, device_id: owner.deviceId,
      predecessor_token_hash: tokenHash, previous_generation_id: previousGenerationId, manifest_digest: hex(),
      legacy_fingerprint: fingerprint, input_revision: 0, from_day: "2026-09-01", through_day: "2026-09-02",
      days_json: "[]", created_at: at(8),
    });
    return generationId;
  };
  const v11Head = (owner, generationId) => {
    insert("telemetry_v11_domain_heads", {
      participant_id: owner.participantId, generation_id: generationId, revision: 1, updated_at: at(8),
    });
    owner.generationId = generationId;
  };
  const link = (owner, state = "active") => insert("storage_v11_owner_links", {
    participant_id: owner.participantId, owner_digest: owner.ownerDigest, state,
    generation_id: owner.generationId ?? null, head_revision: owner.generationId ? 1 : null,
    object_digest: owner.generationId ? hex() : null, manifest_digest: owner.generationId ? hex() : null,
  });

  // Social owners.
  const s1 = social("s1", { identityLinked: true });
  const s2 = social("s2");
  const s3 = social("s3", { state: "deleting" });
  // An older s1 generation that no head names: not copied.
  const retired = v11Domain(s1);
  v11Head(s1, v11Domain(s1, retired));
  link(s1);
  link(s2);
  link(s3, "withdrawn");
  insert("telemetry_v1_device_consents", {
    participant_id: s1.participantId, device_id: s1.deviceId, telemetry_schema_version: "telemetry-contribution-v1.0",
    field_dictionary_version: "telemetry-v1.0-registry-2026-08-07.1",
    privacy_contract_version: "ongoing-privacy-safe-telemetry-v1.0", consented_at: at(4),
  });
  insert("telemetry_v11_device_consents", {
    participant_id: s1.participantId, device_id: s1.deviceId, telemetry_schema_version: "telemetry-contribution-v1.1",
    field_dictionary_version: "telemetry-v1.1-registry-2026-08-31.1",
    privacy_contract_version: "ongoing-privacy-safe-telemetry-v1.1", consented_at: at(4),
  });
  insert("telemetry_v12_device_capabilities", {
    participant_id: s2.participantId, device_id: s2.deviceId, telemetry_schema_version: "telemetry-contribution-v1.2",
    field_dictionary_version: "telemetry-v1.2-registry-2026-09-20.1",
    privacy_contract_version: "ongoing-privacy-safe-telemetry-v1.2", state: "accepted", consented_at: at(4),
    revoked_at: null,
  });
  // A session and an unclaimed pairing that no copied device references.
  const strayed = randomUUID();
  insert("web_sessions", {
    id: strayed, participant_id: s2.participantId, secret_hash: bytes(), csrf_hash: bytes(), scope: "personal",
    state: "active", issued_at: at(20), expires_at: at(50), last_used_at: at(21), revoked_at: null,
  });
  insert("device_pairings", {
    id: randomUUID(), participant_id: s2.participantId, issued_by_session_id: strayed, secret_hash: bytes(),
    consent_version: PAIRING_CONSENT, state: "unused", issued_at: at(21), expires_at: at(31), consumed_at: null,
    revoked_at: null, claimed_device_id: null, transport_consent_version: PAIRING_CONSENT,
  });

  // Accountless owners.
  const a1 = accountless("a1");
  v11Grant(a1);
  v11Head(a1, v11Domain(a1));
  link(a1);
  const retainedAt = at(600);
  const a2 = accountless("a2", { revokedAt: retainedAt });
  v11Grant(a2);
  v11Head(a2, v11Domain(a2));
  link(a2);
  insert("accountless_public_history_retention", {
    participant_id: a2.participantId, enrollment_device_id: a2.deviceId, device_credential_id: a2.deviceId,
    generation_id: a2.generationId, head_revision: 1, retained_at: retainedAt,
  });
  const a3 = accountless("a3");
  insert("accountless_v12_device_authorizations", {
    enrollment_device_id: a3.deviceId, participant_id: a3.participantId, device_credential_id: a3.deviceId,
    schema_version: "accountless-upload-owner-v1.2", policy_version: "accountless-telemetry-v1.2-policy-v1",
    authorization_basis: "accountless-policy-v1.2", telemetry_schema_version: "telemetry-contribution-v1.2",
    field_dictionary_version: "telemetry-v1.2-registry-2026-09-20.1",
    privacy_contract_version: "ongoing-privacy-safe-telemetry-v1.2", authorized_at: at(6), expires_at: a3.expiresAt,
    state: "active", revoked_at: null, revocation_reason: null,
  });
  link(a3);
  const a4 = accountless("a4", { revokedAt: at(700) });
  v11Grant(a4);

  const participants = [s1, s2, s3, a1, a2, a3, a4];
  participants.forEach((owner, index) => insert("community_analytical_input_versions", {
    participant_id: owner.participantId, revision: index + 2,
  }));

  // Singletons (the migrations may seed some of them).
  database.exec("DELETE FROM collection_controls; DELETE FROM community_public_source_bootstrap; DELETE FROM telemetry_usage_correction_runtime; DELETE FROM storage_source_state; DELETE FROM storage_owner_revisions");
  insert("collection_controls", {
    singleton: 1, schema_version: "collection-controls-v0.1", enrollment_enabled: 1, upload_registration_enabled: 1,
    processing_enabled: 1, publication_enabled: 1, control_state: "operational", revision: 3, reason_code: "initial",
    updated_at: at(30),
  });
  // A finished d43c8f92 walk: completed = 1 still carries the last page's
  // cursors (community-daily-aggregates.ts never resets them).
  insert("community_public_source_bootstrap", {
    singleton: 1, policy_version: "community-public-sources-v1",
    participant_cursor: [a1.participantId, a2.participantId].sort().at(-1), source_day_cursor: "2026-10-01",
    completed: 1,
  });
  insert("telemetry_usage_correction_runtime", {
    id: 1, schema_version: "telemetry-usage-correction-v1", method_version: "usage-total-correction-v1",
    state: "active", max_capture_rows: 200, max_history_page: 200,
  });
  // D1 owner revision heads, compared after a simulated journal import.
  insert("storage_source_state", { singleton: 1, source_id: SOURCE_ID, authority_epoch: 2 });
  insert("storage_owner_revisions", { owner_digest: s1.ownerDigest, revision: 1, authority_epoch: 1, state: "active" });
  insert("storage_owner_revisions", { owner_digest: a1.ownerDigest, revision: 1, authority_epoch: 1, state: "active" });
  return ids;
}

/**
 * Build the sealed fixture: apply every D1 migration of this checkout (whose
 * copied layout must be d43c8f92's), then insert the synthetic rows with the
 * D1 triggers held aside (as Q-1's dump rebuild does) and restore them, so
 * the sealed schema is exactly the migrated one.
 */
async function sealedFixture({ mutate = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-fastpath-identity-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "usage-monitor-db.sqlite");
  const migrations = await readCheckoutD1Migrations();
  const database = new DatabaseSync(path);
  let ids;
  let schemaSha256;
  try {
    database.exec("PRAGMA journal_mode=DELETE");
    applyD1Chain(database, migrations);
    assert.equal(copiedLayoutDigest(database), D43C8F92_COPIED_LAYOUT_SHA256,
      "the checkout's D1 layout of a copied object differs from d43c8f92's");
    schemaSha256 = schemaDigest(database);
    const triggers = database.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY rowid").all();
    database.exec("BEGIN");
    for (const trigger of triggers) database.exec(`DROP TRIGGER "${trigger.name}"`);
    ids = seedSyntheticRows(database);
    for (const trigger of triggers) database.exec(trigger.sql);
    database.exec("COMMIT");
    assert.equal(schemaDigest(database), schemaSha256, "seeding must leave the migrated schema unchanged");
    if (mutate) mutate(database);
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally {
    database.close();
  }
  await chmod(path, 0o400);
  const expectedSha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  const resolved = await realpath(path);
  const source = await openSealedFastpathIdentitySource({ path: resolved, expectedSha256 });
  cleanup.push(async () => source.close());
  return { source, ids, path: resolved, schemaSha256, expectedSha256 };
}

function sqliteRows(path, sql) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL.

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  const [link, resolved] = await Promise.all([lstat(PG_TEST_SOCKET), realpath(PG_TEST_SOCKET)]);
  const metadata = await stat(resolved);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: resolved, port: PG_TEST_PORT };
}

let sharedPool;
async function pool() {
  if (sharedPool) return sharedPool;
  sharedPool = new pg.Pool({ ...await localSocket(), user: PG_TEST_USER, password: PG_TEST_PASSWORD,
    database: PG_TEST_DATABASE, ssl: false, max: 4, connectionTimeoutMillis: 5_000 });
  cleanup.unshift(() => sharedPool.end());
  const locality = await sharedPool.query("SELECT inet_server_addr() AS address, current_setting('server_version_num') AS version");
  assert.equal(locality.rows[0]?.address, null, "test database must use the local Unix socket");
  assert.match(locality.rows[0]?.version ?? "", /^17\d+$/u, "test must run on PostgreSQL 17");
  return sharedPool;
}

async function createSchema(prefix, { migrate = true } = {}) {
  const database = await pool();
  const schema = `${prefix}${randomBytes(6).toString("hex")}`;
  await database.query(`CREATE SCHEMA "${schema}"`);
  cleanup.push(() => database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`));
  if (migrate) {
    const applied = await applyPostgresMigrations({ role: "primary", schema, pool: database });
    assert.equal(applied.applied, applied.migrations.length);
  }
  return schema;
}

const rehearsalSchema = options => createSchema(`${POSTGRES_FASTPATH_IDENTITY_TARGET_SCHEMA_PREFIX}t1_`, options);

async function tableCounts(schema, tables) {
  const database = await pool();
  const counts = {};
  for (const table of tables) {
    counts[table] = Number((await database.query(`SELECT count(*)::int AS n FROM "${schema}"."${table}"`)).rows[0].n);
  }
  return counts;
}

function ownerSet(rows) {
  return rows.map(row => JSON.stringify([row.participant_id, row.owner_kind, row.device_id ?? null])).sort();
}

const COPIED_TABLES = POSTGRES_FASTPATH_IDENTITY_ALLOWLIST.map(entry => entry.table);

async function assertUntouched(schema) {
  const counts = await tableCounts(schema, COPIED_TABLES);
  for (const [table, count] of Object.entries(counts)) {
    const seeded = POSTGRES_FASTPATH_IDENTITY_ALLOWLIST.find(entry => entry.table === table).seeded;
    assert.equal(count, seeded ? 1 : 0, `${table} must be unchanged after a refused copy`);
  }
  const controls = await (await pool()).query(`SELECT control_state FROM "${schema}".collection_controls`);
  assert.equal(controls.rows[0].control_state, "contained", "the migration seed must survive a refused copy");
}

// ---------------------------------------------------------------------------
// Specs.

test("T-1 copies the identity allowlist from a d43c8f92 fixture with equal counts, digests and eligibility", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const fixture = await sealedFixture();
  const schema = await rehearsalSchema();
  const database = await pool();
  const receipt = await runPostgresFastpathIdentityCopy({ source: fixture.source, pool: database, targetSchema: schema });

  assert.equal(receipt.status, "rehearsal_identity_copy_complete");
  assert.equal(receipt.sourceCommit, POSTGRES_FASTPATH_IDENTITY_SOURCE_COMMIT);
  assert.equal(receipt.target.postgresMajor, 17);
  assert.equal(receipt.allowlistSha256, fastpathIdentityAllowlistSha256());
  assert.equal(receipt.allowlistSha256, ALLOWLIST_SHA256, "allowlist changed: review it and update the pin");
  assert.deepEqual(Object.keys(receipt.tables), COPIED_TABLES);
  assert.equal(receipt.rowTriggersSuppressed, true);
  assert.ok(receipt.foreignKeysChecked > 20);
  assert.deepEqual(receipt.unknownNullableColumnsOmitted, {});

  // Per-table counts: receipt, independent PostgreSQL counts and the source.
  const targetCounts = await tableCounts(schema, COPIED_TABLES);
  const expectedSelected = { web_sessions: 3, device_pairings: 3, telemetry_v11_domain_predecessors: 3, telemetry_v11_domains: 3 };
  for (const entry of POSTGRES_FASTPATH_IDENTITY_ALLOWLIST) {
    const [{ n: sourceTotal }] = sqliteRows(fixture.path, `SELECT count(*) AS n FROM "${entry.table}"`);
    const table = receipt.tables[entry.table];
    assert.equal(table.sourceTableRows, sourceTotal, entry.table);
    assert.equal(table.targetRows, table.sourceRows, entry.table);
    assert.equal(targetCounts[entry.table], table.sourceRows, entry.table);
    assert.match(table.sha256, /^[0-9a-f]{64}$/u);
    if (entry.selection === "all") {
      assert.equal(table.sourceRows, sourceTotal, `${entry.table} copies every source row`);
    } else {
      assert.equal(table.sourceRows, expectedSelected[entry.table], `${entry.table} copies only its closure`);
      assert.ok(table.sourceRows < sourceTotal, `${entry.table} fixture includes an unreferenced row`);
    }
  }
  assert.equal(targetCounts.participants, 7);
  assert.equal(targetCounts.device_credentials, 7);
  assert.equal(targetCounts.collection_controls, 1);

  // Values survive exactly (checked here independently of the copier's own
  // canonical digests): digests as bytes, instants to the millisecond.
  const sourceDevices = sqliteRows(fixture.path, `SELECT id, participant_id, lower(hex(secret_hash)) AS secret_hash,
      state, expires_at, credential_generation FROM device_credentials ORDER BY id`)
    .map(row => ({ ...row, credential_generation: Number(row.credential_generation) }));
  const targetDevices = (await database.query(`SELECT id, participant_id, encode(secret_hash, 'hex') AS secret_hash,
      state, to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
      credential_generation FROM "${schema}".device_credentials ORDER BY id COLLATE "C"`)).rows;
  assert.deepEqual(targetDevices, sourceDevices.map(row => ({ ...row })));
  const sourceLedger = sqliteRows(fixture.path, `SELECT device_id, lower(hex(device_secret_hash)) AS hash, state,
      revoked_at, revocation_reason FROM accountless_enrollment_ledger ORDER BY device_id`).map(row => ({ ...row }));
  const targetLedger = (await database.query(`SELECT device_id, encode(device_secret_hash, 'hex') AS hash, state,
      to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS revoked_at, revocation_reason
      FROM "${schema}".accountless_enrollment_ledger ORDER BY device_id COLLATE "C"`)).rows;
  assert.deepEqual(targetLedger, sourceLedger);

  // Seeded singletons carry the source rows, not the migration seeds.
  const controls = await database.query(`SELECT revision::int, control_state, publication_enabled
    FROM "${schema}".collection_controls`);
  assert.deepEqual(controls.rows, [{ revision: 3, control_state: "operational", publication_enabled: true }]);
  const runtime = await database.query(`SELECT state, source_state FROM "${schema}".telemetry_usage_correction_runtime`);
  assert.deepEqual(runtime.rows, [{ state: "staged", source_state: "active" }]);

  // The finished D1 walk keeps its last cursors; PostgreSQL stores the row
  // complete with both cursors empty (0053), and only that table is ruled.
  const [sourceBootstrap] = sqliteRows(fixture.path, `SELECT participant_cursor, source_day_cursor, completed
    FROM community_public_source_bootstrap`);
  assert.deepEqual([sourceBootstrap.participant_cursor === "", sourceBootstrap.source_day_cursor, sourceBootstrap.completed],
    [false, "2026-10-01", 1]);
  const bootstrap = await database.query(`SELECT participant_cursor, source_day_cursor, completed
    FROM "${schema}".community_public_source_bootstrap`);
  assert.deepEqual(bootstrap.rows, [{ participant_cursor: "", source_day_cursor: "", completed: 1 }]);
  assert.deepEqual(receipt.tables.community_public_source_bootstrap.sourceRowRule,
    { id: "d1-completed-walk-cursors-cleared", rowsRewritten: 1 });
  for (const [table, entry] of Object.entries(receipt.tables)) {
    if (table !== "community_public_source_bootstrap") assert.equal(Object.hasOwn(entry, "sourceRowRule"), false, table);
  }

  // community_public_source_owners: PostgreSQL equals the source view.
  const sourceOwners = ownerSet(sqliteRows(fixture.path,
    "SELECT participant_id, owner_kind, device_id FROM community_public_source_owners"));
  const targetOwners = ownerSet((await database.query(`SELECT participant_id, owner_kind, device_id
    FROM "${schema}".community_public_source_owners`)).rows);
  const { s1, s2, a1, a2 } = fixture.ids;
  assert.deepEqual(sourceOwners, ownerSet([
    { participant_id: s1.participantId, owner_kind: "social" },
    { participant_id: s2.participantId, owner_kind: "social" },
    { participant_id: a1.participantId, owner_kind: "accountless", device_id: a1.deviceId },
    { participant_id: a2.participantId, owner_kind: "accountless", device_id: a2.deviceId },
  ]));
  assert.deepEqual(targetOwners, sourceOwners);
  assert.equal(receipt.publicSourceOwners.equal, true);
  assert.equal(receipt.publicSourceOwners.targetParticipants, 4);
  const recheck = await compareFastpathPublicSourceOwners({ source: fixture.source, pool: database, targetSchema: schema });
  assert.deepEqual([recheck.equal, recheck.sourceRows, recheck.targetSha256],
    [true, 4, receipt.publicSourceOwners.targetSha256]);

  // The eligible roster: matched by participant id or by owner digest.
  const roster = await compareFastpathOwnerRoster({ pool: database, targetSchema: schema, roster: [
    { participantId: s1.participantId }, { ownerDigest: s2.ownerDigest },
    { participantId: a1.participantId, ownerDigest: a1.ownerDigest }, { ownerDigest: a2.ownerDigest },
  ] });
  assert.equal(roster.equal, true);
  const short = await compareFastpathOwnerRoster({ pool: database, targetSchema: schema, roster: [
    { participantId: s1.participantId }, { ownerDigest: s2.ownerDigest }, { ownerDigest: a1.ownerDigest },
  ] });
  assert.deepEqual([short.equal, short.extraInTarget], [false, 1]);
  const stranger = await compareFastpathOwnerRoster({ pool: database, targetSchema: schema, roster: [
    { participantId: s1.participantId }, { ownerDigest: s2.ownerDigest }, { ownerDigest: a1.ownerDigest },
    { ownerDigest: a2.ownerDigest }, { participantId: fixture.ids.s3.participantId },
  ] });
  assert.deepEqual([stranger.equal, stranger.unresolved], [false, 1]);

  // Privacy: credential material beyond hashes is not in the allowlist, the
  // omitted participant columns stay NULL, and the receipt carries no ids.
  const plaintext = /(?:^|_)(?:token|password|passphrase|secret|csrf|cookie|key|bearer|pairing_code|email|prompt|path)(?:_|$)/u;
  for (const entry of POSTGRES_FASTPATH_IDENTITY_ALLOWLIST) {
    for (const [sourceColumn, targetColumn, type] of entry.columns) {
      for (const name of [sourceColumn, targetColumn]) {
        if (!plaintext.test(name)) continue;
        assert.match(name, /_hash$/u, `${entry.table}.${name} is credential-like and must be a hash`);
        assert.ok(type === "bytes" || ["token_hash", "predecessor_token_hash"].includes(name),
          `${entry.table}.${name} must be a binary digest or a reviewed hex token digest`);
      }
    }
  }
  const participantsEntry = POSTGRES_FASTPATH_IDENTITY_ALLOWLIST.find(entry => entry.table === "participants");
  assert.deepEqual(participantsEntry.omittedSourceColumns, [
    "access_token_hash", "access_token_id", "deletion_session_id", "identity_cooldown_digest", "identity_link_key",
    "recovery_token_hash", "recovery_token_id",
  ]);
  const omitted = await database.query(`SELECT count(*)::int AS n FROM "${schema}".participants
    WHERE access_token_id IS NOT NULL OR access_token_hash IS NOT NULL OR recovery_token_id IS NOT NULL
       OR recovery_token_hash IS NOT NULL OR deletion_session_id IS NOT NULL OR identity_link_key IS NOT NULL
       OR identity_cooldown_digest IS NOT NULL`);
  assert.equal(omitted.rows[0].n, 0);
  const receiptText = JSON.stringify(receipt);
  for (const owner of Object.values(fixture.ids)) {
    for (const value of [owner.participantId, owner.deviceId, owner.ownerDigest]) {
      assert.equal(receiptText.includes(value), false, "the receipt must stay content-free");
    }
  }

  // A second copy into the populated schema is refused and changes nothing.
  const before = await tableCounts(schema, COPIED_TABLES);
  await assert.rejects(runPostgresFastpathIdentityCopy({ source: fixture.source, pool: database, targetSchema: schema }),
    error => error?.code === "FASTPATH_IDENTITY_TARGET_NOT_EMPTY");
  assert.deepEqual(await tableCounts(schema, COPIED_TABLES), before);

  // After the ingestion-journal importer, derived owner heads equal D1's.
  // Simulate that importer's exact rows for the two D1 heads.
  await database.query(`INSERT INTO "${schema}".storage_source_state (singleton, source_id, authority_epoch)
    VALUES (1, $1, 2)`, [SOURCE_ID]);
  const journal = async (sequence, ownerDigest) => database.query(`INSERT INTO "${schema}".storage_ingestion_changes
      (source_id, sequence, event_digest, owner_digest, owner_revision, authority_epoch, kind, recorded_ms,
       event_tuple_version, revision, object_digest, content_digest, public_authority_epoch)
    VALUES ($1, $2, $3, $4, 0, 1, 'owner-active', 1790000000000, 1, 1, $5, $6, $2)`,
  [SOURCE_ID, sequence, hex(), ownerDigest, hex(), hex()]);
  await journal(1, s1.ownerDigest);
  const partial = await compareFastpathOwnerRevisions({ source: fixture.source, pool: database, targetSchema: schema });
  assert.deepEqual([partial.equal, partial.sourceIdMatches, partial.sourceRows, partial.targetRows], [false, true, 2, 1]);
  await journal(2, a1.ownerDigest);
  const revisions = await compareFastpathOwnerRevisions({ source: fixture.source, pool: database, targetSchema: schema });
  assert.deepEqual([revisions.equal, revisions.sourceRows, revisions.targetRows], [true, 2, 2]);

  // The live triggers are back after COMMIT: a new participant derives its rows.
  const fresh = `participant:${randomUUID()}`;
  await database.query(`INSERT INTO "${schema}".participants (id, created_at) VALUES ($1, now())`, [fresh]);
  const derived = await database.query(`SELECT count(*)::int AS n FROM "${schema}".community_analytical_input_versions
    WHERE participant_id = $1`, [fresh]);
  assert.equal(derived.rows[0].n, 1);
});

test("T-1 refuses a non-prefixed, short-suffixed or unmigrated target schema", { skip: !PG_TEST_SOCKET }, async () => {
  const fixture = await sealedFixture();
  const database = await pool();
  const migratedElsewhere = await createSchema("fastpath_identity_other_");
  for (const targetSchema of [migratedElsewhere, "public", `${POSTGRES_FASTPATH_IDENTITY_TARGET_SCHEMA_PREFIX}x`,
    `${POSTGRES_FASTPATH_IDENTITY_TARGET_SCHEMA_PREFIX}Upper_case_suffix`, undefined]) {
    await assert.rejects(runPostgresFastpathIdentityCopy({ source: fixture.source, pool: database, targetSchema }),
      error => error?.code === "FASTPATH_IDENTITY_TARGET_SCHEMA_REFUSED");
  }
  const participants = await database.query(`SELECT count(*)::int AS n FROM "${migratedElsewhere}".participants`);
  assert.equal(participants.rows[0].n, 0);

  const unmigrated = await rehearsalSchema({ migrate: false });
  await assert.rejects(runPostgresFastpathIdentityCopy({ source: fixture.source, pool: database, targetSchema: unmigrated }),
    error => error?.code === "FASTPATH_IDENTITY_TARGET_MIGRATION_LEVEL_INVALID");

  // A schema migrated only up to 0046 is below the promoted level.
  const migrationsRoot = await mkdtemp(join(tmpdir(), "tibotattle-fastpath-identity-migrations-"));
  cleanup.push(() => rm(migrationsRoot, { recursive: true, force: true }));
  await mkdir(join(migrationsRoot, "primary"));
  const promoted = (await readdir(join(WORKER_ROOT, "postgres/migrations/primary"))).filter(name => name.endsWith(".sql")).sort();
  assert.ok(promoted.length > 46);
  for (const name of promoted.slice(0, 46)) {
    await copyFile(join(WORKER_ROOT, "postgres/migrations/primary", name), join(migrationsRoot, "primary", name));
  }
  const partial = await rehearsalSchema({ migrate: false });
  await applyPostgresMigrations({ role: "primary", schema: partial, pool: database, rootDirectory: migrationsRoot });
  await assert.rejects(runPostgresFastpathIdentityCopy({ source: fixture.source, pool: database, targetSchema: partial }),
    error => error?.code === "FASTPATH_IDENTITY_TARGET_MIGRATION_LEVEL_INVALID");
  const partialParticipants = await database.query(`SELECT count(*)::int AS n FROM "${partial}".participants`);
  assert.equal(partialParticipants.rows[0].n, 0);

  // A source that is not an opened sealed source is refused before any read.
  await assert.rejects(runPostgresFastpathIdentityCopy({ source: { database: () => null }, pool: database,
    targetSchema: partial }), error => error?.code === "FASTPATH_IDENTITY_SOURCE_REQUIRED");
});

test("T-1 refuses a non-empty target atomically", { skip: !PG_TEST_SOCKET }, async () => {
  const fixture = await sealedFixture();
  const database = await pool();
  const schema = await rehearsalSchema();
  // One pre-existing row in a late, non-seeded copied table refuses the whole
  // copy before any write. The orphan row is written with row triggers and
  // foreign keys suppressed on a dedicated connection, then removed.
  const client = await database.connect();
  try {
    await client.query("SET session_replication_role = replica");
    await client.query(`INSERT INTO "${schema}".telemetry_v11_device_consents
        (participant_id, device_id, telemetry_schema_version, field_dictionary_version, privacy_contract_version, consented_at)
      VALUES ('participant:synthetic-prior', 'synthetic-prior-device', 'telemetry-contribution-v1.1',
        'telemetry-v1.1-registry-2026-08-31.1', 'ongoing-privacy-safe-telemetry-v1.1', now())`);
    await assert.rejects(runPostgresFastpathIdentityCopy({ source: fixture.source, pool: database, targetSchema: schema }),
      error => error?.code === "FASTPATH_IDENTITY_TARGET_NOT_EMPTY" && error.table === "telemetry_v11_device_consents");
    await client.query(`DELETE FROM "${schema}".telemetry_v11_device_consents`);
  } finally {
    await client.query("RESET session_replication_role").catch(() => {});
    client.release();
  }
  await assertUntouched(schema);

  // A second row in a seeded singleton is beyond SEEDED_SINGLETONS and refused.
  const seeded = await rehearsalSchema();
  for (const constraint of ["community_public_source_bootstrap_pkey", "community_public_source_bootstrap_singleton_check"]) {
    await database.query(`ALTER TABLE "${seeded}".community_public_source_bootstrap DROP CONSTRAINT "${constraint}"`);
  }
  await database.query(`INSERT INTO "${seeded}".community_public_source_bootstrap (singleton, policy_version, completed)
    VALUES (2, 'community-public-sources-v1', 0)`);
  await assert.rejects(runPostgresFastpathIdentityCopy({ source: fixture.source, pool: database, targetSchema: seeded }),
    error => error?.code === "FASTPATH_IDENTITY_TARGET_NOT_EMPTY" && error.table === "community_public_source_bootstrap");
  const bootstrap = await database.query(`SELECT count(*)::int AS n FROM "${seeded}".community_public_source_bootstrap`);
  assert.equal(bootstrap.rows[0].n, 2);
  const seededParticipants = await database.query(`SELECT count(*)::int AS n FROM "${seeded}".participants`);
  assert.equal(seededParticipants.rows[0].n, 0);
});

test("the rehearsal transport parts copy the checkout's D1 layout, refuse unknown parts and non-empty targets", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const fixture = await sealedFixture();
  const database = await pool();
  assert.deepEqual([...POSTGRES_FASTPATH_TRANSPORT_PARTS], ["legacy-transport", "v12-event-sources"]);
  assert.equal(fastpathTransportAllowlistSha256(), TRANSPORT_ALLOWLIST_SHA256,
    "transport allowlist changed: review it and update the pin");
  const schema = await rehearsalSchema();
  for (const part of [undefined, "", "identity", "legacy-transport ", "LEGACY-TRANSPORT"]) {
    await assert.rejects(runPostgresFastpathTransportCopy({ source: fixture.source, pool: database, targetSchema: schema, part }),
      { code: "FASTPATH_TRANSPORT_PART_INVALID" }, String(part));
  }
  await assert.rejects(runPostgresFastpathTransportCopy({ source: fixture.source, pool: database,
    targetSchema: "tibotattle_fastpath_spec", part: "legacy-transport" }), { code: "FASTPATH_IDENTITY_TARGET_SCHEMA_REFUSED" });

  // The checkout's D1 chain and the promoted PostgreSQL chain agree on every
  // transport column; the fixture holds no transport rows, so both parts
  // commit empty after the identity copy (the rehearsal copies the oracle's).
  await runPostgresFastpathIdentityCopy({ source: fixture.source, pool: database, targetSchema: schema });
  for (const part of POSTGRES_FASTPATH_TRANSPORT_PARTS) {
    const receipt = await runPostgresFastpathTransportCopy({ source: fixture.source, pool: database, targetSchema: schema, part });
    assert.equal(receipt.status, "rehearsal_transport_copy_complete");
    assert.equal(receipt.part, part);
    assert.equal(receipt.allowlistSha256, TRANSPORT_ALLOWLIST_SHA256);
    assert.deepEqual(Object.keys(receipt.tables), POSTGRES_FASTPATH_TRANSPORT_ALLOWLIST[part].map(entry => entry.table));
    assert.ok(Object.values(receipt.tables).every(table => table.targetRows === table.sourceRows));
    assert.ok(receipt.foreignKeysChecked > 0);
    assert.equal(receipt.rowTriggersSuppressed, true);
  }

  // One pre-existing transport row refuses the part before any write.
  const client = await database.connect();
  try {
    await client.query("SET session_replication_role = replica");
    await client.query(`INSERT INTO "${schema}".telemetry_v11_domain_days (generation_id, observed_day, manifest_id)
      VALUES ('synthetic-prior-generation', DATE '2026-09-30', 'synthetic-prior-manifest')`);
    await assert.rejects(runPostgresFastpathTransportCopy({ source: fixture.source, pool: database, targetSchema: schema,
      part: "legacy-transport" }), error => error?.code === "FASTPATH_IDENTITY_TARGET_NOT_EMPTY");
    await client.query(`DELETE FROM "${schema}".telemetry_v11_domain_days`);
  } finally {
    await client.query("RESET session_replication_role").catch(() => {});
    client.release();
  }
});

test("T-1 refuses an unknown NOT NULL source or target column", { skip: !PG_TEST_SOCKET }, async () => {
  const database = await pool();

  const required = await sealedFixture({ mutate: db => db.exec(
    "ALTER TABLE device_credentials ADD COLUMN synthetic_unmapped TEXT NOT NULL DEFAULT 'synthetic'") });
  const schema = await rehearsalSchema();
  await assert.rejects(runPostgresFastpathIdentityCopy({ source: required.source, pool: database, targetSchema: schema }),
    error => error?.code === "FASTPATH_IDENTITY_SOURCE_COLUMN_UNKNOWN" && error.table === "device_credentials"
      && error.column === "synthetic_unmapped");
  await assertUntouched(schema);

  // A nullable unknown source column is omitted and named in the receipt.
  const optional = await sealedFixture({ mutate: db => db.exec(
    "ALTER TABLE device_credentials ADD COLUMN synthetic_optional TEXT") });
  const optionalReceipt = await runPostgresFastpathIdentityCopy({ source: optional.source, pool: database,
    targetSchema: await rehearsalSchema() });
  assert.deepEqual(optionalReceipt.unknownNullableColumnsOmitted, { device_credentials: ["synthetic_optional"] });
  assert.equal(optionalReceipt.allowlistSha256, ALLOWLIST_SHA256);

  // A target NOT NULL column without a default that the allowlist does not map.
  const fixture = await sealedFixture();
  const target = await rehearsalSchema();
  await database.query(`ALTER TABLE "${target}".accountless_upload_owners ADD COLUMN synthetic_required text NOT NULL`);
  await assert.rejects(runPostgresFastpathIdentityCopy({ source: fixture.source, pool: database, targetSchema: target }),
    error => error?.code === "FASTPATH_IDENTITY_TARGET_COLUMN_UNMAPPED" && error.table === "accountless_upload_owners"
      && error.column === "synthetic_required");
  await assertUntouched(target);

  // A source missing an allowlisted column.
  const missing = await sealedFixture({ mutate: db => db.exec(
    "ALTER TABLE telemetry_v1_device_consents RENAME COLUMN consented_at TO synthetic_consented_at") });
  await assert.rejects(runPostgresFastpathIdentityCopy({ source: missing.source, pool: database,
    targetSchema: await rehearsalSchema() }),
  error => error?.code === "FASTPATH_IDENTITY_SOURCE_COLUMN_MISSING" && error.table === "telemetry_v1_device_consents" && error.column === "consented_at");
});

test("T-1 rolls back when eligibility parity fails, and records it in defer mode", { skip: !PG_TEST_SOCKET }, async () => {
  const fixture = await sealedFixture();
  const database = await pool();
  const { a1, a2 } = fixture.ids;

  // Without the v1.1 head chain both accountless v1.1 owners lose eligibility.
  const schema = await rehearsalSchema();
  await assert.rejects(runPostgresFastpathIdentityCopy({ source: fixture.source, pool: database, targetSchema: schema,
    omitFamilies: ["v11-domain-heads"] }), error => error?.code === "FASTPATH_IDENTITY_PUBLIC_SOURCE_OWNERS_MISMATCH");
  await assertUntouched(schema);

  const deferred = await runPostgresFastpathIdentityCopy({ source: fixture.source, pool: database, targetSchema: schema,
    omitFamilies: ["v11-domain-heads"], publicSourceOwnerParity: "defer" });
  assert.equal(deferred.publicSourceOwners.mode, "defer");
  assert.deepEqual([deferred.publicSourceOwners.equal, deferred.publicSourceOwners.missingInTarget,
    deferred.publicSourceOwners.extraInTarget], [false, 2, 0]);
  assert.deepEqual(deferred.omittedFamilies, ["v11-domain-heads"]);
  assert.equal(Object.hasOwn(deferred.tables, "telemetry_v11_domain_heads"), false);
  const eligible = await database.query(`SELECT participant_id FROM "${schema}".community_public_source_owners
    WHERE participant_id = ANY($1::text[])`, [[a1.participantId, a2.participantId]]);
  assert.equal(eligible.rows.length, 0);

  await assert.rejects(runPostgresFastpathIdentityCopy({ source: fixture.source, pool: database,
    targetSchema: await rehearsalSchema(), omitFamilies: ["identity"] }),
  error => error?.code === "FASTPATH_IDENTITY_OMIT_FAMILY_INVALID");
});

test("T-1 refuses a source that is not sealed or changes after opening", { skip: !PG_TEST_SOCKET }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-fastpath-identity-unsealed-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "writable.sqlite");
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE participants (id TEXT PRIMARY KEY)");
  database.close();
  const resolved = await realpath(path);
  const sha256 = createHash("sha256").update(await readFile(resolved)).digest("hex");
  await assert.rejects(openSealedFastpathIdentitySource({ path: resolved, expectedSha256: sha256 }),
    error => error?.code === "FASTPATH_IDENTITY_SOURCE_UNSAFE");
  await chmod(resolved, 0o400);
  await assert.rejects(openSealedFastpathIdentitySource({ path: resolved, expectedSha256: "0".repeat(64) }),
    error => error?.code === "FASTPATH_IDENTITY_SOURCE_SHA256_MISMATCH");
  await assert.rejects(openSealedFastpathIdentitySource({ path: "relative.sqlite", expectedSha256: sha256 }),
    error => error?.code === "FASTPATH_IDENTITY_SOURCE_PATH_INVALID");

  const fixture = await sealedFixture();
  await chmod(fixture.path, 0o600);
  await assert.rejects(runPostgresFastpathIdentityCopy({ source: fixture.source, pool: await pool(),
    targetSchema: await rehearsalSchema() }), error => error?.code === "FASTPATH_IDENTITY_SOURCE_UNSAFE"
      || error?.code === "FASTPATH_IDENTITY_SOURCE_CHANGED");
});

test("the checkout's D1 chain has d43c8f92's layout for every object the copy reads", async t => {
  const checkout = new DatabaseSync(":memory:");
  try {
    applyD1Chain(checkout, await readCheckoutD1Migrations());
    assert.equal(copiedLayoutDigest(checkout), D43C8F92_COPIED_LAYOUT_SHA256);
  } finally {
    checkout.close();
  }
  // The pin is re-derived from d43c8f92 itself wherever the commit exists
  // (any local clone of this repository); a shallow CI checkout holds the pin.
  const sourceCommit = readSourceCommitD1Migrations();
  if (sourceCommit === null) {
    t.diagnostic("d43c8f92 is not in this object store; the checkout chain was checked against the reviewed pin");
    return;
  }
  const pinned = new DatabaseSync(":memory:");
  try {
    applyD1Chain(pinned, sourceCommit);
    assert.equal(copiedLayoutDigest(pinned), D43C8F92_COPIED_LAYOUT_SHA256);
  } finally {
    pinned.close();
  }
});

test("T-1 refuses a started, unfinished D1 bootstrap walk and copies one not yet started", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const database = await pool();

  // completed = 0 with a cursor: PostgreSQL has no representation for it.
  const inProgress = await sealedFixture({ mutate: db => db.exec(
    "UPDATE community_public_source_bootstrap SET completed = 0") });
  const refused = await rehearsalSchema();
  await assert.rejects(runPostgresFastpathIdentityCopy({ source: inProgress.source, pool: database, targetSchema: refused }),
    error => error?.code === "FASTPATH_IDENTITY_SOURCE_BOOTSTRAP_IN_PROGRESS"
      && error.table === "community_public_source_bootstrap"
      && !error.message.includes(inProgress.ids.a1.participantId) && !error.message.includes(inProgress.ids.a2.participantId));
  await assertUntouched(refused);

  // completed = 0 with empty cursors copies as is; PostgreSQL's own advance
  // completes it later.
  const notStarted = await sealedFixture({ mutate: db => db.exec(
    "UPDATE community_public_source_bootstrap SET completed = 0, participant_cursor = '', source_day_cursor = ''") });
  const schema = await rehearsalSchema();
  const receipt = await runPostgresFastpathIdentityCopy({ source: notStarted.source, pool: database, targetSchema: schema });
  assert.deepEqual(receipt.tables.community_public_source_bootstrap.sourceRowRule,
    { id: "d1-completed-walk-cursors-cleared", rowsRewritten: 0 });
  const bootstrap = await database.query(`SELECT participant_cursor, source_day_cursor, completed
    FROM "${schema}".community_public_source_bootstrap`);
  assert.deepEqual(bootstrap.rows, [{ participant_cursor: "", source_day_cursor: "", completed: 0 }]);
});

const COPIER = join(WORKER_ROOT, "scripts/postgres-fastpath-identity-copy.mjs");

async function runCopierCli(args, cwd) {
  const { host, port } = await localSocket();
  return new Promise((resolve, reject) => {
    // Node 22 prints an ExperimentalWarning for node:sqlite on stderr.
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", COPIER, ...args], {
      cwd,
      env: { PATH: process.env.PATH, PGHOST: host, PGPORT: String(port), PGUSER: PG_TEST_USER,
        PGPASSWORD: PG_TEST_PASSWORD, PGDATABASE: PG_TEST_DATABASE },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

async function exists(path) {
  return lstat(path).then(() => true, error => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}

test("T-1's CLI checks its receipt and roster before the copy and keeps a committed copy's receipt", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  // The source lacks storage_owner_revisions, so --verify-owner-revisions
  // fails only after the copy has committed.
  const fixture = await sealedFixture({ mutate: db => db.exec(
    "ALTER TABLE storage_owner_revisions RENAME TO synthetic_owner_revisions") });
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-fastpath-identity-cli-")));
  cleanup.push(() => rm(scratch, { recursive: true, force: true }));
  const { s1, s2, a1, a2 } = fixture.ids;
  const roster = join(scratch, "roster.json");
  await writeFile(roster, JSON.stringify({ owners: [s1, s2, a1, a2].map(owner => ({ participantId: owner.participantId })) }));
  const emptyRoster = join(scratch, "empty-roster.json");
  await writeFile(emptyRoster, "[]");
  const schema = await rehearsalSchema();
  const base = ["--sqlite", fixture.path, "--sha256", fixture.expectedSha256, "--schema", schema];

  // A relative receipt path is refused before anything is written.
  const relative = await runCopierCli([...base, "--receipt", "relative-receipt.json"], scratch);
  assert.deepEqual([relative.code, relative.stdout, relative.stderr], [2, "", "FASTPATH_IDENTITY_CLI_ARGUMENT_INVALID\n"]);
  assert.equal(await exists(join(scratch, "relative-receipt.json")), false);
  await assertUntouched(schema);

  // An existing receipt file is refused, and left unchanged.
  const prior = join(scratch, "prior-receipt.json");
  await writeFile(prior, "prior\n");
  const taken = await runCopierCli([...base, "--receipt", prior], scratch);
  assert.deepEqual([taken.code, taken.stdout, taken.stderr], [2, "", "FASTPATH_IDENTITY_RECEIPT_UNAVAILABLE\n"]);
  assert.equal(await readFile(prior, "utf8"), "prior\n");
  await assertUntouched(schema);

  // An invalid roster is refused before the copy.
  const badRoster = await runCopierCli([...base, "--expect-owner-roster", emptyRoster], scratch);
  assert.deepEqual([badRoster.code, badRoster.stdout, badRoster.stderr], [2, "", "FASTPATH_IDENTITY_ROSTER_INVALID\n"]);
  await assertUntouched(schema);

  // A refused copy releases the receipt file it reserved.
  const refusedReceipt = join(scratch, "refused-receipt.json");
  const refused = await runCopierCli(["--sqlite", fixture.path, "--sha256", fixture.expectedSha256,
    "--schema", "public", "--receipt", refusedReceipt], scratch);
  assert.deepEqual([refused.code, refused.stdout, refused.stderr], [2, "", "FASTPATH_IDENTITY_TARGET_SCHEMA_REFUSED\n"]);
  assert.equal(await exists(refusedReceipt), false);

  // A failure after COMMIT still emits the receipt (stdout and file), naming
  // the failure, so a caller can tell a populated target from a refused copy.
  const receiptPath = join(scratch, "receipt.json");
  const committed = await runCopierCli([...base, "--receipt", receiptPath, "--expect-owner-roster", roster,
    "--verify-owner-revisions"], scratch);
  assert.equal(committed.code, 2);
  assert.equal(committed.stderr, "FASTPATH_IDENTITY_SOURCE_TABLE_MISSING [table=storage_owner_revisions]\n");
  const emitted = JSON.parse(committed.stdout);
  assert.equal(emitted.copy.status, "rehearsal_identity_copy_complete");
  assert.equal(emitted.ownerRoster.equal, true);
  assert.equal(emitted.failedAfterCopy, "FASTPATH_IDENTITY_SOURCE_TABLE_MISSING");
  assert.equal(Object.hasOwn(emitted, "ownerRevisions"), false);
  assert.equal(await readFile(receiptPath, "utf8"), committed.stdout);
  assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);
  assert.equal((await tableCounts(schema, ["participants"])).participants, 7);
  for (const owner of Object.values(fixture.ids)) {
    assert.equal(committed.stdout.includes(owner.participantId), false, "the receipt must stay content-free");
  }

  // The verifications re-run read-only against the populated target.
  const verifiedPath = join(scratch, "verified-receipt.json");
  const verified = await runCopierCli([...base, "--verify-only", "--receipt", verifiedPath,
    "--expect-owner-roster", roster], scratch);
  assert.deepEqual([verified.code, verified.stderr], [0, ""]);
  const verifiedReceipt = JSON.parse(verified.stdout);
  assert.deepEqual([verifiedReceipt.publicSourceOwners.equal, verifiedReceipt.ownerRoster.equal], [true, true]);
  assert.equal(await readFile(verifiedPath, "utf8"), verified.stdout);
});
