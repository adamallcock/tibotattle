import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, readFile, realpath, rename, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  POSTGRES_IDENTITY_AUTHORITY_CONTROL_SCHEMA_PREFIX,
  POSTGRES_IDENTITY_AUTHORITY_TARGET_SCHEMA_PREFIX,
  POSTGRES_IDENTITY_AUTHORITY_TRANSFER_LAYOUT,
  POSTGRES_IDENTITY_AUTHORITY_TRANSFER_TABLES,
  PostgresIdentityAuthorityTransferError,
  createSealedSqliteIdentityAuthoritySource,
  runPostgresIdentityAuthorityTransfer,
} from "./postgres-identity-authority-transfer.mjs";
import { applyPostgresMigrations } from "./postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const pg = PG_TEST_SOCKET ? (await import("pg")).default : null;

function quote(value) {
  assert.match(value, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${value}"`;
}

function syntheticSqlite({ nonDefaultIssuance = false, omitIssuance = false, extraParticipantColumn = false,
  omitSessionParticipantForeignKey = false, omitCooldownTable = false, duplicateCooldownMarker = false,
  wrongCooldownVersion = false, deletingParticipant = false, emptyIdentityAuthority = false,
  missingIdentityPin = false, extraIdentityPinColumn = false,
  identityLinkPin = { keyVersion: "synthetic-key-v1", fingerprint: "f".repeat(64), recordedAt: "2031-09-27T12:34:56.789Z" } } = {}) {
  const directory = `/private/tmp/tibotattle-identity-transfer-${randomBytes(5).toString("hex")}`;
  const path = join(directory, "source.sqlite");
  mkdirSync(directory, { mode: 0o700 });
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON");
  const ddl = [
    `CREATE TABLE participants (
      id TEXT PRIMARY KEY NOT NULL, owner_kind TEXT NOT NULL DEFAULT 'social',
      access_token_id TEXT UNIQUE, access_token_hash BLOB, recovery_token_id TEXT UNIQUE,
      recovery_token_hash BLOB, state TEXT NOT NULL DEFAULT 'active', consent_version TEXT,
      consented_at TEXT, created_at TEXT NOT NULL, deletion_session_id TEXT,
      identity_link_key TEXT, identity_cooldown_digest TEXT${extraParticipantColumn ? ", test_extra TEXT" : ""}
    ) STRICT`,
    ...(omitCooldownTable ? [] : [`CREATE TABLE identity_reenrollment_cooldowns (
      identity_cooldown_digest TEXT${duplicateCooldownMarker ? "" : " PRIMARY KEY NOT NULL"},
      schema_version TEXT NOT NULL, deleted_at TEXT NOT NULL, retain_until TEXT NOT NULL
    ) STRICT`]),
    `CREATE TABLE identity_link_secret_configuration (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
      key_version TEXT NOT NULL CHECK(length(key_version) BETWEEN 1 AND 64 AND key_version NOT GLOB '*[^A-Za-z0-9._-]*'),
      secret_fingerprint TEXT NOT NULL CHECK(length(secret_fingerprint)=64 AND secret_fingerprint NOT GLOB '*[^0-9a-f]*'),
      recorded_at TEXT NOT NULL${extraIdentityPinColumn ? ", test_extra TEXT" : ""}
    ) STRICT`,
    `CREATE TABLE enrollment_grants (
      id TEXT PRIMARY KEY NOT NULL, secret_hash BLOB NOT NULL, state TEXT NOT NULL DEFAULT 'issued',
      issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, redeemed_at TEXT,
      redeemed_participant_id TEXT UNIQUE REFERENCES participants(id) ON DELETE SET NULL
    ) STRICT`,
    `CREATE TABLE web_sessions (
      id TEXT PRIMARY KEY NOT NULL, participant_id TEXT NOT NULL${omitSessionParticipantForeignKey ? "" : " REFERENCES participants(id) ON DELETE CASCADE"},
      secret_hash BLOB NOT NULL CHECK(length(secret_hash)=32), csrf_hash BLOB NOT NULL CHECK(length(csrf_hash)=32),
      scope TEXT NOT NULL DEFAULT 'personal', state TEXT NOT NULL DEFAULT 'active', issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, last_used_at TEXT NOT NULL, revoked_at TEXT
    ) STRICT`,
    `CREATE TABLE participant_community_eligibility (
      id TEXT PRIMARY KEY NOT NULL, participant_id TEXT NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
      grant_id TEXT NOT NULL UNIQUE REFERENCES enrollment_grants(id), created_at TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE device_pairings (
      id TEXT PRIMARY KEY NOT NULL, participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      issued_by_session_id TEXT NOT NULL REFERENCES web_sessions(id) ON DELETE CASCADE,
      secret_hash BLOB NOT NULL CHECK(length(secret_hash)=32), consent_version TEXT NOT NULL
        CHECK(consent_version IN ('ongoing-privacy-safe-telemetry-v0.1','ongoing-privacy-safe-telemetry-v1.0')),
      transport_consent_version TEXT NOT NULL
        CHECK(transport_consent_version IN ('ongoing-privacy-safe-telemetry-v0.1','ongoing-privacy-safe-telemetry-v0.2','ongoing-privacy-safe-telemetry-v1.0')),
      state TEXT NOT NULL DEFAULT 'unused', issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, consumed_at TEXT, revoked_at TEXT, claimed_device_id TEXT
    ) STRICT`,
    `CREATE TABLE device_credentials (
      id TEXT PRIMARY KEY NOT NULL, participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      authority_kind TEXT NOT NULL DEFAULT 'social', paired_via_pairing_id TEXT UNIQUE REFERENCES device_pairings(id) ON DELETE CASCADE,
      accountless_enrollment_device_id TEXT UNIQUE REFERENCES accountless_enrollment_ledger(device_id) ON DELETE RESTRICT,
      secret_hash BLOB NOT NULL CHECK(length(secret_hash)=32), state TEXT NOT NULL DEFAULT 'active',
      issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_used_at TEXT NOT NULL, revoked_at TEXT,
      social_verified_at TEXT, credential_generation INTEGER NOT NULL DEFAULT 1
    ) STRICT`,
    `CREATE TABLE upload_authorizations (
      id TEXT PRIMARY KEY NOT NULL, participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      issued_by_session_id TEXT NOT NULL REFERENCES web_sessions(id) ON DELETE CASCADE,
      secret_hash BLOB NOT NULL CHECK(length(secret_hash)=32), envelope_digest TEXT NOT NULL,
      body_bytes INTEGER NOT NULL, content_type TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'unused',
      issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, revoked_at TEXT,
      consume_lease_expires_at TEXT, consumed_contribution_id TEXT
    ) STRICT`,
    `CREATE TABLE device_upload_authorizations (
      id TEXT PRIMARY KEY NOT NULL, participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      issued_by_device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
      secret_hash BLOB NOT NULL CHECK(length(secret_hash)=32), envelope_digest TEXT NOT NULL,
      body_bytes INTEGER NOT NULL, content_type TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'unused',
      issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, revoked_at TEXT,
      consume_lease_expires_at TEXT, consumed_contribution_id TEXT
    ) STRICT`,
    `CREATE TABLE recovery_retry_receipts (
      old_recovery_token_id TEXT PRIMARY KEY NOT NULL, old_recovery_token_hash BLOB NOT NULL,
      recovery_attempt_hash BLOB NOT NULL, participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      derivation_nonce TEXT NOT NULL, replacement_recovery_token_id TEXT NOT NULL,
      replacement_session_id TEXT NOT NULL UNIQUE REFERENCES web_sessions(id) ON DELETE CASCADE,
      issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, replay_count INTEGER NOT NULL DEFAULT 0
    ) STRICT`,
    `CREATE TABLE device_credential_rotations (
      id TEXT PRIMARY KEY NOT NULL, device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      prior_secret_hash BLOB NOT NULL, replacement_secret_hash BLOB NOT NULL, attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL, rotated_at TEXT NOT NULL, retire_at TEXT NOT NULL, recovery_proof_hash BLOB
    ) STRICT`,
    `CREATE TABLE device_pairing_events (
      id TEXT PRIMARY KEY NOT NULL, pairing_id TEXT NOT NULL REFERENCES device_pairings(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, occurred_at TEXT NOT NULL, UNIQUE(pairing_id,kind)
    ) STRICT`,
    "CREATE TABLE accountless_enrollment_ledger (device_id TEXT PRIMARY KEY NOT NULL) STRICT",
    "CREATE TABLE accountless_upload_owners (enrollment_device_id TEXT PRIMARY KEY NOT NULL) STRICT",
    "CREATE TABLE accountless_v11_device_authorizations (enrollment_device_id TEXT PRIMARY KEY NOT NULL) STRICT",
  ];
  if (!omitIssuance) {
    ddl.push(`CREATE TABLE accountless_enrollment_issuance (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), budget_day TEXT NOT NULL,
      daily_issued INTEGER NOT NULL, lifetime_issued INTEGER NOT NULL,
      last_issue_token TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT`);
  }
  database.exec(ddl.join(";\n"));
  if (!missingIdentityPin) {
    database.prepare(`INSERT INTO identity_link_secret_configuration
      (singleton,key_version,secret_fingerprint,recorded_at) VALUES (1,?,?,?)`).run(
      identityLinkPin.keyVersion, identityLinkPin.fingerprint, identityLinkPin.recordedAt,
    );
  }
  if (!omitIssuance) {
    database.prepare(`INSERT INTO accountless_enrollment_issuance
      (singleton,budget_day,daily_issued,lifetime_issued,last_issue_token,updated_at)
      VALUES(1,'1970-01-01',?,?, '', '1970-01-01T00:00:00.000Z')`).run(
      nonDefaultIssuance ? 1 : 0, nonDefaultIssuance ? 1 : 0,
    );
  }
  if ((!omitCooldownTable || duplicateCooldownMarker) && !emptyIdentityAuthority) {
    const insertCooldown = database.prepare(`INSERT INTO identity_reenrollment_cooldowns
      (identity_cooldown_digest,schema_version,deleted_at,retain_until) VALUES(?,?,?,?)`);
    insertCooldown.run("c".repeat(64), wrongCooldownVersion ? "synthetic-wrong-version" : "identity-reenrollment-cooldown-v0.1", "2031-09-25T00:00:00.000Z", "2031-10-02T00:00:00.000Z");
    if (duplicateCooldownMarker) {
      insertCooldown.run("c".repeat(64), "identity-reenrollment-cooldown-v0.1", "2031-09-25T00:00:00.000Z", "2031-10-02T00:00:00.000Z");
    }
  }
  if (!emptyIdentityAuthority) insertSocialFixture(database);
  if (deletingParticipant) {
    database.prepare("UPDATE participants SET state='deleting' WHERE id='synthetic-social-01'").run();
  }
  database.close();
  return { directory, path };
}

function insertSocialFixture(database) {
  const timestamp = "2031-09-27T12:34:56.789Z";
  const later = "2031-09-28T12:34:56.789Z";
  const participantColumns = [
    "id", "owner_kind", "access_token_id", "access_token_hash", "recovery_token_id",
    "recovery_token_hash", "state", "consent_version", "consented_at", "created_at",
    "deletion_session_id", "identity_link_key", "identity_cooldown_digest",
  ];
  const insert = (table, columns, rows) => {
    const statement = database.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
    for (const row of rows) statement.run(...row);
  };
  insert("participants", participantColumns, [
    ["synthetic-social-01", "social", "synthetic-access-01", Buffer.alloc(32, 1), "synthetic-recovery-01", Buffer.alloc(32, 2), "active", "synthetic-consent-v1.2-exact", timestamp, timestamp, null, null, null],
    ["synthetic-social-02", "social", null, null, null, null, "active", null, null, later, null, null, null],
  ]);
  insert("enrollment_grants", ["id", "secret_hash", "state", "issued_at", "expires_at", "redeemed_at", "redeemed_participant_id"], [
    ["synthetic-grant-01", Buffer.alloc(32, 3), "redeemed", timestamp, later, timestamp, "synthetic-social-01"],
    ["synthetic-grant-02", Buffer.alloc(32, 4), "issued", timestamp, later, null, null],
  ]);
  insert("web_sessions", ["id", "participant_id", "secret_hash", "csrf_hash", "scope", "state", "issued_at", "expires_at", "last_used_at", "revoked_at"], [
    ["synthetic-session-01", "synthetic-social-01", Buffer.alloc(32, 5), Buffer.alloc(32, 6), "personal", "active", timestamp, later, timestamp, null],
    ["synthetic-session-02", "synthetic-social-02", Buffer.alloc(32, 7), Buffer.alloc(32, 8), "personal", "active", timestamp, later, timestamp, null],
    ["synthetic-session-recovery", "synthetic-social-01", Buffer.alloc(32, 9), Buffer.alloc(32, 10), "personal", "active", timestamp, later, timestamp, null],
  ]);
  insert("participant_community_eligibility", ["id", "participant_id", "grant_id", "created_at"], [
    ["synthetic-eligibility-01", "synthetic-social-01", "synthetic-grant-01", timestamp],
  ]);
  insert("device_pairings", ["id", "participant_id", "issued_by_session_id", "secret_hash", "consent_version", "transport_consent_version", "state", "issued_at", "expires_at", "consumed_at", "revoked_at", "claimed_device_id"], [
    ["synthetic-pairing-01", "synthetic-social-01", "synthetic-session-01", Buffer.alloc(32, 11), "ongoing-privacy-safe-telemetry-v1.0", "ongoing-privacy-safe-telemetry-v1.0", "consumed", timestamp, later, timestamp, null, "synthetic-device-01"],
    ["synthetic-pairing-02", "synthetic-social-02", "synthetic-session-02", Buffer.alloc(32, 12), "ongoing-privacy-safe-telemetry-v1.0", "ongoing-privacy-safe-telemetry-v1.0", "unused", timestamp, later, null, null, null],
  ]);
  insert("device_credentials", ["id", "participant_id", "authority_kind", "paired_via_pairing_id", "accountless_enrollment_device_id", "secret_hash", "state", "issued_at", "expires_at", "last_used_at", "revoked_at", "social_verified_at", "credential_generation"], [
    ["synthetic-device-01", "synthetic-social-01", "social", "synthetic-pairing-01", null, Buffer.alloc(32, 13), "active", timestamp, later, timestamp, null, timestamp, 2],
    ["synthetic-device-02", "synthetic-social-02", "social", "synthetic-pairing-02", null, Buffer.alloc(32, 14), "active", timestamp, later, timestamp, null, timestamp, 1],
  ]);
  insert("upload_authorizations", ["id", "participant_id", "issued_by_session_id", "secret_hash", "envelope_digest", "body_bytes", "content_type", "state", "issued_at", "expires_at", "consumed_at", "revoked_at", "consume_lease_expires_at", "consumed_contribution_id"], [
    ["synthetic-upload-01", "synthetic-social-01", "synthetic-session-01", Buffer.alloc(32, 15), "a".repeat(64), 128, "application/json", "unused", timestamp, later, null, null, null, null],
  ]);
  insert("device_upload_authorizations", ["id", "participant_id", "issued_by_device_id", "secret_hash", "envelope_digest", "body_bytes", "content_type", "state", "issued_at", "expires_at", "consumed_at", "revoked_at", "consume_lease_expires_at", "consumed_contribution_id"], [
    ["synthetic-device-upload-01", "synthetic-social-01", "synthetic-device-01", Buffer.alloc(32, 16), "b".repeat(64), 256, "application/json", "unused", timestamp, later, null, null, null, null],
  ]);
  insert("recovery_retry_receipts", ["old_recovery_token_id", "old_recovery_token_hash", "recovery_attempt_hash", "participant_id", "derivation_nonce", "replacement_recovery_token_id", "replacement_session_id", "issued_at", "expires_at", "replay_count"], [
    ["synthetic-old-recovery-id", Buffer.alloc(32, 17), Buffer.alloc(32, 18), "synthetic-social-01", "A".repeat(43), "synthetic-new-recovery-id", "synthetic-session-recovery", timestamp, later, 1],
  ]);
  insert("device_credential_rotations", ["id", "device_id", "participant_id", "prior_secret_hash", "replacement_secret_hash", "attempt_id", "generation", "rotated_at", "retire_at", "recovery_proof_hash"], [
    ["synthetic-rotation-01", "synthetic-device-01", "synthetic-social-01", Buffer.alloc(32, 19), Buffer.alloc(32, 20), "synthetic-attempt-01", 2, timestamp, later, Buffer.alloc(32, 21)],
  ]);
  insert("device_pairing_events", ["id", "pairing_id", "participant_id", "kind", "occurred_at"], [
    ["synthetic-pairing-event-issued-01", "synthetic-pairing-01", "synthetic-social-01", "issued", timestamp],
    ["synthetic-pairing-event-claimed-01", "synthetic-pairing-01", "synthetic-social-01", "claimed", timestamp],
  ]);
}

async function seal(path) {
  await chmod(path, 0o400);
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function closeSource(source) {
  await source?.close();
}

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65535);
  const resolved = await realpath(PG_TEST_SOCKET);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  return { host: resolved, port: PG_TEST_PORT };
}

test("source binding is pinned and wrong-binding labels fail before the source path is opened", async () => {
  await assert.rejects(
    createSealedSqliteIdentityAuthoritySource({ path: "/private/tmp/does-not-exist.sqlite", expectedSha256: "0".repeat(64), binding: "ANALYTICS_DB" }),
    error => error instanceof PostgresIdentityAuthorityTransferError
      && error.code === "IDENTITY_TRANSFER_SOURCE_BINDING_INVALID",
  );
});

test("sealed source rejects missing or non-default accountless authority and column drift", async t => {
  for (const [options, expectedCode] of [
    [{ omitIssuance: true }, "IDENTITY_TRANSFER_SOURCE_LAYOUT_INVALID"],
    [{ nonDefaultIssuance: true }, "IDENTITY_TRANSFER_ACCOUNTLESS_AUTHORITY_OUT_OF_SCOPE"],
    [{ extraParticipantColumn: true }, "IDENTITY_TRANSFER_SOURCE_LAYOUT_INVALID"],
    [{ omitSessionParticipantForeignKey: true }, "IDENTITY_TRANSFER_SOURCE_LAYOUT_INVALID"],
    [{ omitCooldownTable: true }, "IDENTITY_TRANSFER_SOURCE_LAYOUT_INVALID"],
    [{ duplicateCooldownMarker: true }, "IDENTITY_TRANSFER_SOURCE_LAYOUT_INVALID"],
    [{ missingIdentityPin: true }, "IDENTITY_TRANSFER_SOURCE_IDENTITY_PIN_MISSING"],
    [{ extraIdentityPinColumn: true }, "IDENTITY_TRANSFER_SOURCE_LAYOUT_INVALID"],
  ]) {
    const fixture = syntheticSqlite(options);
    await t.test(JSON.stringify(options), async () => {
      try {
        const sha256 = await seal(fixture.path);
        await assert.rejects(
          createSealedSqliteIdentityAuthoritySource({ path: fixture.path, expectedSha256: sha256 }),
          error => error instanceof PostgresIdentityAuthorityTransferError && error.code === expectedCode,
        );
      } finally {
        await rm(fixture.directory, { recursive: true, force: true });
      }
    });
  }
});

test("sealed synthetic source preserves consent bytes, credential hashes, and canonical UTC timestamp strings", async () => {
  const fixture = syntheticSqlite();
  let source;
  try {
    const expectedSha256 = await seal(fixture.path);
    source = await createSealedSqliteIdentityAuthoritySource({ path: fixture.path, expectedSha256 });
    const participantPage = await source.listPage({ table: "participants", limit: 1 });
    assert.equal(participantPage.rows.length, 1);
    assert.equal(participantPage.rows[0].consent_version, "synthetic-consent-v1.2-exact");
    assert.deepEqual(Buffer.from(participantPage.rows[0].access_token_hash), Buffer.alloc(32, 1));
    assert.equal(participantPage.rows[0].created_at, "2031-09-27T12:34:56.789Z");
    const markerPage = await source.listPage({ table: "identity_reenrollment_cooldowns", limit: 1 });
    assert.equal(markerPage.rows[0].schema_version, "identity-reenrollment-cooldown-v0.1");
    assert.equal(markerPage.rows[0].deleted_at, "2031-09-25T00:00:00.000Z");
    assert.equal(markerPage.rows[0].retain_until, "2031-10-02T00:00:00.000Z");
    assert.equal((await source.listPage({ table: "device_credentials", limit: 1 })).rows[0].secret_hash.length, 32);
    const identityLinkPin = await source.readIdentityLinkSecretConfiguration();
    assert.equal(identityLinkPin.singleton, 1);
    assert.equal(identityLinkPin.key_version, "synthetic-key-v1");
    assert.equal(identityLinkPin.secret_fingerprint === "f".repeat(64), true,
      "the synthetic fingerprint should be read exactly without appearing in failure output");
    assert.equal(identityLinkPin.recorded_at, "2031-09-27T12:34:56.789Z");
    await assert.rejects(source.listPage({ table: "storage_owner_revisions", limit: 1 }), error =>
      error instanceof PostgresIdentityAuthorityTransferError && error.code === "IDENTITY_TRANSFER_TABLE_INVALID");
  } finally {
    await closeSource(source);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("sealed source reads from a private read-only snapshot after the caller path is replaced", async () => {
  const fixture = syntheticSqlite();
  const replacement = syntheticSqlite({
    emptyIdentityAuthority: true,
    identityLinkPin: { keyVersion: "synthetic-key-v2", fingerprint: "e".repeat(64), recordedAt: "2031-09-28T12:34:56.789Z" },
  });
  let source;
  try {
    source = await createSealedSqliteIdentityAuthoritySource({
      path: fixture.path,
      expectedSha256: await seal(fixture.path),
    });
    const movedPath = `${fixture.path}.sealed-origin`;
    await rename(fixture.path, movedPath);
    await copyFile(replacement.path, fixture.path);
    await chmod(fixture.path, 0o400);
    await source.verifySnapshot();
    assert.equal((await source.listPage({ table: "participants", limit: 1 })).rows[0].id, "synthetic-social-01");
    assert.equal((await source.readIdentityLinkSecretConfiguration()).key_version, "synthetic-key-v1");
  } finally {
    await closeSource(source);
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(replacement.directory, { recursive: true, force: true });
  }
});

test("fixed source layout names only the approved family and excludes owner links and derived revisions", () => {
  assert.deepEqual(POSTGRES_IDENTITY_AUTHORITY_TRANSFER_TABLES, [
    "participants", "identity_reenrollment_cooldowns", "enrollment_grants", "web_sessions", "participant_community_eligibility",
    "device_pairings", "device_credentials", "upload_authorizations", "device_upload_authorizations",
    "recovery_retry_receipts", "device_credential_rotations", "device_pairing_events",
  ]);
  assert.ok(POSTGRES_IDENTITY_AUTHORITY_TRANSFER_LAYOUT.every(spec => spec.columns.length > 0));
});

test("PG17 transfers synthetic social authority in FK order, resumes a failed page, preserves values, and retries idempotently", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const endpoint = await localSocket();
  const pool = new pg.Pool({
    ...endpoint,
    user: PG_TEST_USER,
    password: process.env.PG_TEST_PASSWORD ?? "synthetic-local-only",
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 5_000,
  });
  const suffix = randomBytes(5).toString("hex");
  const targetSchema = `${POSTGRES_IDENTITY_AUTHORITY_TARGET_SCHEMA_PREFIX}${suffix}`;
  const controlSchema = `${POSTGRES_IDENTITY_AUTHORITY_CONTROL_SCHEMA_PREFIX}${suffix}`;
  const fixture = syntheticSqlite();
  let source;
  let targetCreated = false;
  let controlCreated = false;
  try {
    const locality = await pool.query("SELECT inet_server_addr() AS address, current_setting('server_version_num')::int AS version_num");
    assert.equal(locality.rows[0]?.address, null);
    assert.equal(Math.floor(locality.rows[0]?.version_num / 10_000), 17);
    await pool.query(`CREATE SCHEMA ${quote(targetSchema)}`);
    targetCreated = true;
    await pool.query(`CREATE SCHEMA ${quote(controlSchema)}`);
    controlCreated = true;
    assert.equal((await applyPostgresMigrations({ role: "primary", schema: targetSchema, pool })).applied, 46);
    const deletingFixture = syntheticSqlite({ deletingParticipant: true });
    let deletingSource;
    try {
      deletingSource = await createSealedSqliteIdentityAuthoritySource({
        path: deletingFixture.path,
        expectedSha256: await seal(deletingFixture.path),
      });
      await assert.rejects(runPostgresIdentityAuthorityTransfer({
        source: deletingSource,
        destinationPool: pool,
        targetSchema,
        controlSchema,
        transferId: "synthetic-deleting-participant-refused",
        pageSize: 1,
      }), error => error instanceof PostgresIdentityAuthorityTransferError
        && error.code === "IDENTITY_TRANSFER_ERASURE_LEDGER_REQUIRED");
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${quote(targetSchema)}.participants`)).rows[0]?.n, 0);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${quote(targetSchema)}.identity_link_secret_configuration`)).rows[0]?.n, 0);
    } finally {
      await closeSource(deletingSource);
      await rm(deletingFixture.directory, { recursive: true, force: true });
    }
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2",
      [controlSchema, "_identity_authority_transfer_runs_v1"],
    )).rows[0]?.n, 0);
    const wrongMarkerFixture = syntheticSqlite({ wrongCooldownVersion: true });
    let wrongMarkerSource;
    try {
      wrongMarkerSource = await createSealedSqliteIdentityAuthoritySource({
        path: wrongMarkerFixture.path,
        expectedSha256: await seal(wrongMarkerFixture.path),
      });
      await assert.rejects(runPostgresIdentityAuthorityTransfer({
        source: wrongMarkerSource,
        destinationPool: pool,
        targetSchema,
        controlSchema,
        transferId: "synthetic-wrong-marker-version",
        pageSize: 1,
      }), error => error instanceof PostgresIdentityAuthorityTransferError
        && error.code === "IDENTITY_TRANSFER_SOURCE_AUTHORITY_INVALID");
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${quote(targetSchema)}.participants`)).rows[0]?.n, 0);
    } finally {
      await closeSource(wrongMarkerSource);
      await rm(wrongMarkerFixture.directory, { recursive: true, force: true });
    }
    const expectedSha256 = await seal(fixture.path);
    source = await createSealedSqliteIdentityAuthoritySource({ path: fixture.path, expectedSha256 });
    assert.equal((await source.listPage({ table: "participants", limit: 1 })).rows.length, 1);
    await assert.rejects(source.listPage({ table: "storage_owner_links", limit: 1 }), error =>
      error instanceof PostgresIdentityAuthorityTransferError && error.code === "IDENTITY_TRANSFER_TABLE_INVALID");

    await pool.query(`CREATE FUNCTION ${quote(targetSchema)}.fail_synthetic_identity_transfer()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'synthetic_identity_transfer_page_failure';
      END $$`);
    await pool.query(`CREATE TRIGGER fail_synthetic_identity_transfer BEFORE INSERT ON ${quote(targetSchema)}.device_credentials
      FOR EACH ROW EXECUTE FUNCTION ${quote(targetSchema)}.fail_synthetic_identity_transfer()`);
    const request = {
      source,
      destinationPool: pool,
      targetSchema,
      controlSchema,
      transferId: "synthetic-social-authority-run-01",
      pageSize: 1,
    };
    for (const [label, mismatch] of [
      ["version", { key_version: "synthetic-key-other", secret_fingerprint: "f".repeat(64), recorded_at: "2031-09-27T12:34:56.789Z" }],
      ["fingerprint", { key_version: "synthetic-key-v1", secret_fingerprint: "e".repeat(64), recorded_at: "2031-09-27T12:34:56.789Z" }],
      ["recorded-at", { key_version: "synthetic-key-v1", secret_fingerprint: "f".repeat(64), recorded_at: "2031-09-28T12:34:56.789Z" }],
    ]) {
      await pool.query(`INSERT INTO ${quote(targetSchema)}.identity_link_secret_configuration
        (singleton,key_version,secret_fingerprint,recorded_at) VALUES (1,$1,$2,$3)`,
      [mismatch.key_version, mismatch.secret_fingerprint, mismatch.recorded_at]);
      await assert.rejects(runPostgresIdentityAuthorityTransfer({ ...request, transferId: `synthetic-pin-mismatch-${label}` }), error =>
        error instanceof PostgresIdentityAuthorityTransferError
          && error.code === "IDENTITY_TRANSFER_TARGET_IDENTITY_PIN_MISMATCH");
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${quote(targetSchema)}.participants`)).rows[0]?.n, 0);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${quote(controlSchema)}._identity_authority_transfer_runs_v1`)).rows[0]?.n, 0);
      await pool.query(`DELETE FROM ${quote(targetSchema)}.identity_link_secret_configuration WHERE singleton=1`);
    }
    await pool.query(`INSERT INTO ${quote(targetSchema)}.identity_reenrollment_cooldowns
      (identity_cooldown_digest,participant_id,created_at,expires_at)
      VALUES ($1,NULL,'2031-09-20T00:00:00Z','2031-10-01T00:00:00Z')`, ["d".repeat(64)]);
    await assert.rejects(pool.query(`INSERT INTO ${quote(targetSchema)}.identity_reenrollment_cooldowns
      (identity_cooldown_digest,participant_id,created_at,expires_at)
      VALUES ($1,NULL,'2031-09-20T00:00:00Z','2031-10-01T00:00:00Z')`, ["d".repeat(64)]), error => error.code === "23505");
    await assert.rejects(runPostgresIdentityAuthorityTransfer(request), error =>
      error instanceof PostgresIdentityAuthorityTransferError && error.code === "IDENTITY_TRANSFER_TARGET_NOT_EMPTY");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${quote(controlSchema)}._identity_authority_transfer_runs_v1`)).rows[0]?.n, 0);
    await pool.query(`DELETE FROM ${quote(targetSchema)}.identity_reenrollment_cooldowns WHERE identity_cooldown_digest=$1`, ["d".repeat(64)]);

    await assert.rejects(runPostgresIdentityAuthorityTransfer(request), error =>
      error instanceof PostgresIdentityAuthorityTransferError && error.code === "IDENTITY_TRANSFER_PAGE_WRITE_FAILED");
    const checkpoint = await pool.query(`SELECT table_name,last_key,row_count::int,page_count::int,complete
      FROM ${quote(controlSchema)}._identity_authority_transfer_checkpoints_v1
      ORDER BY table_name`);
    assert.ok(checkpoint.rows.some(row => row.table_name === "device_pairings" && row.complete));
    assert.equal(checkpoint.rows.some(row => row.table_name === "device_credentials"), false);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${quote(targetSchema)}.device_credentials`)).rows[0]?.n, 0);

    await pool.query(`DROP TRIGGER fail_synthetic_identity_transfer ON ${quote(targetSchema)}.device_credentials`);
    await pool.query(`DROP FUNCTION ${quote(targetSchema)}.fail_synthetic_identity_transfer()`);
    const receipt = await runPostgresIdentityAuthorityTransfer(request);
    assert.equal(receipt.status, "staged_rehearsal_complete");
    assert.equal(receipt.destination.postgresMajor, 17);
    assert.ok(receipt.pagesCommittedThisRun > 0);
    assert.equal(receipt.source.rows, receipt.destination.rows);
    assert.equal(receipt.source.manifestSha256, receipt.destination.manifestSha256);
    assert.equal(receipt.capabilities.identityLinkSecretConfigurationTransferred, true);
    assert.equal(receipt.capabilities.destinationRuntimeSecretMatchVerified, false);
    assert.equal(JSON.stringify(receipt).includes("f".repeat(64)), false);
    assert.equal(receipt.source.tables.participants.rows, 2);
    assert.equal(receipt.source.tables.identity_reenrollment_cooldowns.rows, 1);
    assert.equal(receipt.source.tables.device_pairing_events.rows, 2);
    assert.equal(receipt.capabilities.accountlessAuthorityTransferred, false);
    assert.equal(receipt.capabilities.analyticsOwnerLinksTransferred, false);
    assert.equal(receipt.capabilities.productionCutoverAuthorized, false);
    const targetPin = await pool.query(`SELECT singleton,key_version,secret_fingerprint,recorded_at
      FROM ${quote(targetSchema)}.identity_link_secret_configuration`);
    assert.equal(targetPin.rows.length, 1);
    assert.equal(targetPin.rows[0].singleton, 1);
    assert.equal(targetPin.rows[0].key_version, "synthetic-key-v1");
    assert.equal(targetPin.rows[0].secret_fingerprint === "f".repeat(64), true,
      "the synthetic target pin should match without printing its fingerprint on failure");
    assert.equal(targetPin.rows[0].recorded_at.toISOString(), "2031-09-27T12:34:56.789Z");

    const values = await pool.query(`SELECT participant.id,participant.consent_version,
        encode(participant.access_token_hash,'hex') AS access_hash,
        participant.created_at,session.secret_hash AS session_hash,
        pairing.transport_consent_version,pairing.issued_at,
        device.secret_hash AS device_hash,rotation.recovery_proof_hash,
        marker.participant_id AS marker_participant_id,marker.created_at AS marker_created_at,
        marker.expires_at AS marker_expires_at
      FROM ${quote(targetSchema)}.participants participant
      JOIN ${quote(targetSchema)}.web_sessions session ON session.id='synthetic-session-01'
      JOIN ${quote(targetSchema)}.device_pairings pairing ON pairing.id='synthetic-pairing-01'
      JOIN ${quote(targetSchema)}.device_credentials device ON device.id='synthetic-device-01'
      JOIN ${quote(targetSchema)}.device_credential_rotations rotation ON rotation.id='synthetic-rotation-01'
      JOIN ${quote(targetSchema)}.identity_reenrollment_cooldowns marker
        ON marker.identity_cooldown_digest=$1
      WHERE participant.id='synthetic-social-01'`, ["c".repeat(64)]);
    assert.equal(values.rows.length, 1);
    assert.equal(values.rows[0].consent_version, "synthetic-consent-v1.2-exact");
    assert.equal(values.rows[0].access_hash, Buffer.alloc(32, 1).toString("hex"));
    assert.equal(values.rows[0].created_at.toISOString(), "2031-09-27T12:34:56.789Z");
    assert.deepEqual(values.rows[0].session_hash, Buffer.alloc(32, 5));
    assert.equal(values.rows[0].transport_consent_version, "ongoing-privacy-safe-telemetry-v1.0");
    assert.equal(values.rows[0].issued_at.toISOString(), "2031-09-27T12:34:56.789Z");
    assert.deepEqual(values.rows[0].device_hash, Buffer.alloc(32, 13));
    assert.deepEqual(values.rows[0].recovery_proof_hash, Buffer.alloc(32, 21));
    assert.equal(values.rows[0].marker_participant_id, null);
    assert.equal(values.rows[0].marker_created_at.toISOString(), "2031-09-25T00:00:00.000Z");
    assert.equal(values.rows[0].marker_expires_at.toISOString(), "2031-10-02T00:00:00.000Z");

    const repeated = await runPostgresIdentityAuthorityTransfer(request);
    assert.equal(repeated.idempotentRetry, true);
    assert.equal(repeated.pagesCommittedThisRun, 0);
    assert.equal(repeated.source.manifestSha256, receipt.source.manifestSha256);
    const concurrentRetries = await Promise.all([
      runPostgresIdentityAuthorityTransfer(request),
      runPostgresIdentityAuthorityTransfer(request),
    ]);
    assert.ok(concurrentRetries.every(value => value.idempotentRetry && value.pagesCommittedThisRun === 0));

    await chmod(fixture.path, 0o600);
    const writable = new DatabaseSync(fixture.path);
    writable.prepare("UPDATE participants SET consent_version='synthetic-mutated-source' WHERE id='synthetic-social-01'").run();
    writable.close();
    await chmod(fixture.path, 0o400);
    const afterOriginalPathMutation = await runPostgresIdentityAuthorityTransfer(request);
    assert.equal(afterOriginalPathMutation.idempotentRetry, true);
    assert.equal(afterOriginalPathMutation.source.manifestSha256, receipt.source.manifestSha256);
    assert.equal((await pool.query(`SELECT status FROM ${quote(controlSchema)}._identity_authority_transfer_runs_v1 WHERE transfer_id=$1`, [request.transferId])).rows[0]?.status, "complete");
  } finally {
    await closeSource(source);
    await pool.end();
    if (targetCreated) await new pg.Client({ ...endpoint, user: PG_TEST_USER, password: process.env.PG_TEST_PASSWORD ?? "synthetic-local-only", database: PG_TEST_DATABASE }).connect().then(async client => {
      try { await client.query(`DROP SCHEMA ${quote(targetSchema)} CASCADE`); } finally { await client.end(); }
    }).catch(() => {});
    if (controlCreated) await new pg.Client({ ...endpoint, user: PG_TEST_USER, password: process.env.PG_TEST_PASSWORD ?? "synthetic-local-only", database: PG_TEST_DATABASE }).connect().then(async client => {
      try { await client.query(`DROP SCHEMA ${quote(controlSchema)} CASCADE`); } finally { await client.end(); }
    }).catch(() => {});
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("PG17 reserves a zero-row target once across concurrent transfer IDs and rejects alternate control schemas", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const endpoint = await localSocket();
  const pool = new pg.Pool({
    ...endpoint,
    user: PG_TEST_USER,
    password: process.env.PG_TEST_PASSWORD ?? "synthetic-local-only",
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 5_000,
  });
  const suffix = randomBytes(5).toString("hex");
  const targetSchema = `${POSTGRES_IDENTITY_AUTHORITY_TARGET_SCHEMA_PREFIX}${suffix}`;
  const controlSchema = `${POSTGRES_IDENTITY_AUTHORITY_CONTROL_SCHEMA_PREFIX}${suffix}`;
  const firstFixture = syntheticSqlite({ emptyIdentityAuthority: true });
  const secondFixture = syntheticSqlite({
    emptyIdentityAuthority: true,
    identityLinkPin: { keyVersion: "synthetic-key-v2", fingerprint: "e".repeat(64), recordedAt: "2031-09-28T12:34:56.789Z" },
  });
  let firstSource;
  let secondSource;
  let targetCreated = false;
  let controlCreated = false;
  try {
    const locality = await pool.query("SELECT inet_server_addr() AS address, current_setting('server_version_num')::int AS version_num");
    assert.equal(locality.rows[0]?.address, null);
    assert.equal(Math.floor(locality.rows[0]?.version_num / 10_000), 17);
    await pool.query(`CREATE SCHEMA ${quote(targetSchema)}`);
    targetCreated = true;
    await pool.query(`CREATE SCHEMA ${quote(controlSchema)}`);
    controlCreated = true;
    assert.equal((await applyPostgresMigrations({ role: "primary", schema: targetSchema, pool })).applied, 46);
    firstSource = await createSealedSqliteIdentityAuthoritySource({
      path: firstFixture.path,
      expectedSha256: await seal(firstFixture.path),
    });
    secondSource = await createSealedSqliteIdentityAuthoritySource({
      path: secondFixture.path,
      expectedSha256: await seal(secondFixture.path),
    });
    const outcomes = await Promise.allSettled([
      runPostgresIdentityAuthorityTransfer({
        source: firstSource, destinationPool: pool, targetSchema, controlSchema,
        transferId: "synthetic-empty-target-claim-a", pageSize: 1,
      }),
      runPostgresIdentityAuthorityTransfer({
        source: secondSource, destinationPool: pool, targetSchema, controlSchema,
        transferId: "synthetic-empty-target-claim-b", pageSize: 1,
      }),
    ]);
    const succeeded = outcomes.filter(result => result.status === "fulfilled");
    const rejected = outcomes.filter(result => result.status === "rejected");
    assert.equal(succeeded.length, 1);
    assert.equal(succeeded[0].value.status, "staged_rehearsal_complete");
    assert.equal(succeeded[0].value.source.rows, 0);
    assert.equal(succeeded[0].value.destination.rows, 0);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof PostgresIdentityAuthorityTransferError);
    assert.equal(rejected[0].reason.code, "IDENTITY_TRANSFER_TARGET_ALREADY_CLAIMED");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${quote(controlSchema)}._identity_authority_transfer_runs_v1`)).rows[0]?.n, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${quote(targetSchema)}.identity_link_secret_configuration`)).rows[0]?.n, 1);

    const alternateControlSchema = `${POSTGRES_IDENTITY_AUTHORITY_CONTROL_SCHEMA_PREFIX}${randomBytes(5).toString("hex")}`;
    await assert.rejects(runPostgresIdentityAuthorityTransfer({
      source: secondSource,
      destinationPool: pool,
      targetSchema,
      controlSchema: alternateControlSchema,
      transferId: "synthetic-empty-target-alternate-control",
    }), error => error instanceof PostgresIdentityAuthorityTransferError
      && error.code === "IDENTITY_TRANSFER_DISPOSABLE_SCHEMA_REQUIRED");
  } finally {
    await closeSource(firstSource);
    await closeSource(secondSource);
    await pool.end();
    if (targetCreated) await new pg.Client({ ...endpoint, user: PG_TEST_USER, password: process.env.PG_TEST_PASSWORD ?? "synthetic-local-only", database: PG_TEST_DATABASE }).connect().then(async client => {
      try { await client.query(`DROP SCHEMA ${quote(targetSchema)} CASCADE`); } finally { await client.end(); }
    }).catch(() => {});
    if (controlCreated) await new pg.Client({ ...endpoint, user: PG_TEST_USER, password: process.env.PG_TEST_PASSWORD ?? "synthetic-local-only", database: PG_TEST_DATABASE }).connect().then(async client => {
      try { await client.query(`DROP SCHEMA ${quote(controlSchema)} CASCADE`); } finally { await client.end(); }
    }).catch(() => {});
    await rm(firstFixture.directory, { recursive: true, force: true });
    await rm(secondFixture.directory, { recursive: true, force: true });
  }
});
