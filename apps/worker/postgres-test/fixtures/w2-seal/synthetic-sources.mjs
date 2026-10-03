// W2-SEAL fixtures: synthetic, content-free D1 sources for the PT-2-lite seal
// and the PT-3 identity importer. Test-only; never imported by product code.
//
// * The ingestion D1 is the Q-1 oracle corpus (analytics-v2-test/golden/dump/
//   usage-monitor-db.json) rebuilt with rebuildOracleSqlite (read-only import
//   of scripts/gcp-fastpath-oracle-sqlite.mjs), copied, then given synthetic
//   rows for the identity tables the corpus leaves empty, through the D1
//   triggers themselves. Every secret below is a fixture-only constant; ids
//   are fresh UUIDs; nothing is a real id, path or prompt.
// * The deletion-ledger D1 applies deletion-ledger-migrations 0001-0003 and
//   holds synthetic digests only.
// * The migration ledgers are rewritten to the bare-name ledgers the seal
//   expects at the given commit (buildExpectedLedger), so the fixture carries
//   exactly what a clean deployment at that commit would.
// * createFakeWranglerSpawn and createFakeCutoverTransport stand in for the
//   Cloudflare provider: the export is produced from the synthetic file and
//   the remote reads run the seal's own SELECT statements on it.

import { createHash, createHmac, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, openSync, statSync, writeSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { rebuildOracleSqlite } from "../../../scripts/gcp-fastpath-oracle-sqlite.mjs";
import { buildExpectedLedger } from "../../../scripts/cutover-source-seal.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const Q1_INGESTION_DUMP = join(WORKER_ROOT, "analytics-v2-test", "golden", "dump", "usage-monitor-db.json");
export const SYNTHETIC_SIGNED_URL = "https://synthetic-account.r2.cloudflarestorage.com/export.sql?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=SYNTHETIC&X-Amz-Signature=0000000000000000";
export const SYNTHETIC_IDENTITY_LINK_SECRET = "w2-seal-fixture-identity-link-secret-not-real-0001";
export const SYNTHETIC_IDENTITY_LINK_VERSION = "w2-seal-synthetic-v1";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

function hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

/** A deterministic fixture-only 32-byte secret in the Worker's base64url form. */
export function fixtureSecret(label) {
  return base64url(sha256(`w2-seal-fixture-secret:${label}`));
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/** The Worker's identityLinkSecretFingerprint (HMAC-SHA256 over a fixed domain). */
export function identityLinkFingerprint(secret) {
  return createHmac("sha256", secret).update("app-usagemonitor/identity-link-secret-fingerprint/v1\0").digest("hex");
}

export function capabilityHash(capability, tokenId, secret) {
  return sha256(`app-usagemonitor/${capability}/v1\0${tokenId}\0${secret}`);
}

export function deviceSecretHash(deviceId, secret) {
  return createHash("sha256").update(`app-usagemonitor/device/v1\0${deviceId}\0`)
    .update(Buffer.from(secret, "base64url")).digest();
}

export function pairingSecretHash(pairingId, secret) {
  return sha256(`app-usagemonitor/device-pairing/v1\0${pairingId}\0${secret}`);
}

const CREATED_DIRECTORIES = new Set();

/** An owner-only 0700 directory under the OS temp root (outside the repository and any scratchpad). */
export async function privateDirectory(prefix = "w2-seal-") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await chmod(directory, 0o700);
  CREATED_DIRECTORIES.add(directory);
  return directory;
}

/** Remove every directory privateDirectory created in this process. */
export async function removePrivateDirectories() {
  for (const directory of [...CREATED_DIRECTORIES]) {
    await rm(directory, { recursive: true, force: true });
    CREATED_DIRECTORIES.delete(directory);
  }
}

// ---------------------------------------------------------------------------
// Migration ledgers.

/** The production-shaped default layout: Wrangler for migrations/, the storage tool for the rest. */
export const DEFAULT_INGESTION_LEDGERS = Object.freeze({
  d1_migrations: ["migrations"],
  d1_storage_migrations: ["typed-ingestion-migrations", "ingestion-bridge-migrations",
    "typed-v11-admission-migrations", "typed-v1-admission-migrations", "ingestion-isolation-migrations"],
});
export const DEFAULT_LEDGER_LEDGERS = Object.freeze({ d1_migrations: ["deletion-ledger-migrations"] });

const WRANGLER_LEDGER_SQL = `CREATE TABLE d1_migrations(
\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,
\t\tname       TEXT UNIQUE,
\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;
const STORAGE_LEDGER_SQL = "CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT";

/**
 * Replace the source's migration ledgers with the expected ledgers at commit
 * (bare names). `nameStyle: "canonical"` writes directory-prefixed names
 * instead, which the seal must refuse.
 */
export function writeExpectedLedgers(database, { role, ledgers, commit, nameStyle = "bare" }) {
  const expected = buildExpectedLedger({ source: { role, ledgers }, commit });
  const directoryOf = (name, table) => {
    for (const directory of ledgers[table]) {
      if (expected.ledgers[table].some(row => row.name === name)) return directory;
    }
    return "";
  };
  database.exec("DROP TABLE IF EXISTS d1_migrations; DROP TABLE IF EXISTS d1_storage_migrations;");
  if (expected.ledgers.d1_migrations) {
    database.exec(WRANGLER_LEDGER_SQL);
    const insert = database.prepare("INSERT INTO d1_migrations(name, applied_at) VALUES (?, '2026-10-01 07:26:31')");
    for (const row of expected.ledgers.d1_migrations) insert.run(row.name);
  }
  if (expected.ledgers.d1_storage_migrations) {
    database.exec(STORAGE_LEDGER_SQL);
    const insert = database.prepare("INSERT INTO d1_storage_migrations(name, sha256) VALUES (?, ?)");
    for (const row of expected.ledgers.d1_storage_migrations) {
      const name = nameStyle === "canonical" ? `${directoryOf(row.name, "d1_storage_migrations")}/${row.name}` : row.name;
      insert.run(name, row.sha256);
    }
  }
  return expected;
}

// ---------------------------------------------------------------------------
// The synthetic ingestion D1.

/**
 * Plant the identity rows the Q-1 corpus leaves empty, through the D1
 * triggers. Returns the fixture handles (ids and fixture secrets) the specs
 * authenticate with; none of them is ever written to a receipt. The pin row
 * carries `identityLinkVersion` (a spec of the production rotation seals the
 * retired production label; the secret is always the synthetic one).
 */
function plantIdentityRows(database, nowMs, identityLinkVersion) {
  const now = iso(nowMs);
  const ids = {};
  const secrets = {};
  const run = (sql, ...values) => database.prepare(sql).run(...values);

  run(`INSERT INTO identity_link_secret_configuration(singleton, key_version, secret_fingerprint, recorded_at)
    VALUES (1, ?, ?, ?)`, identityLinkVersion, identityLinkFingerprint(SYNTHETIC_IDENTITY_LINK_SECRET), now);

  // A social participant whose session, pairings and device authenticate
  // with fixture secrets after the import.
  ids.participant = `participant:${randomUUID()}`;
  secrets.access = fixtureSecret("access");
  secrets.recovery = fixtureSecret("recovery");
  ids.accessToken = randomUUID();
  ids.recoveryToken = randomUUID();
  run(`INSERT INTO participants(id, owner_kind, access_token_id, access_token_hash, recovery_token_id,
      recovery_token_hash, state, consent_version, consented_at, created_at)
    VALUES (?, 'social', ?, ?, ?, ?, 'active', 'privacy-safe-telemetry-v0.1', ?, ?)`,
  ids.participant, ids.accessToken, capabilityHash("access", ids.accessToken, secrets.access),
  ids.recoveryToken, capabilityHash("recovery", ids.recoveryToken, secrets.recovery), now, now);

  ids.session = randomUUID();
  secrets.session = fixtureSecret("session");
  const csrfToken = `um_csrf_${base64url(capabilityHash("csrf", ids.session, secrets.session))}`;
  run(`INSERT INTO web_sessions(id, participant_id, secret_hash, csrf_hash, scope, state, issued_at, expires_at,
      last_used_at) VALUES (?, ?, ?, ?, 'personal', 'active', ?, ?, ?)`,
  ids.session, ids.participant, capabilityHash("session", ids.session, secrets.session),
  capabilityHash("csrf-binding", ids.session, csrfToken), now, iso(nowMs + 30 * DAY), now);
  ids.recoverySession = randomUUID();
  run(`INSERT INTO web_sessions(id, participant_id, secret_hash, csrf_hash, scope, state, issued_at, expires_at,
      last_used_at) VALUES (?, ?, ?, ?, 'personal', 'active', ?, ?, ?)`,
  ids.recoverySession, ids.participant, sha256("w2-seal-recovery-session"), sha256("w2-seal-recovery-csrf"),
  now, iso(nowMs + DAY), now);

  ids.devicePairing = randomUUID();
  secrets.devicePairing = fixtureSecret("device-pairing");
  run(`INSERT INTO device_pairings(id, participant_id, issued_by_session_id, secret_hash, consent_version, state,
      issued_at, expires_at, transport_consent_version)
    VALUES (?, ?, ?, ?, 'ongoing-privacy-safe-telemetry-v1.0', 'unused', ?, ?, 'ongoing-privacy-safe-telemetry-v1.0')`,
  ids.devicePairing, ids.participant, ids.session, pairingSecretHash(ids.devicePairing, secrets.devicePairing),
  now, iso(nowMs + HOUR));
  ids.device = randomUUID();
  secrets.devicePrior = fixtureSecret("device-prior");
  secrets.device = fixtureSecret("device");
  run(`INSERT INTO device_credentials(id, participant_id, authority_kind, paired_via_pairing_id, secret_hash, state,
      issued_at, expires_at, last_used_at, social_verified_at, credential_generation)
    VALUES (?, ?, 'social', ?, ?, 'active', ?, ?, ?, ?, 1)`,
  ids.device, ids.participant, ids.devicePairing, deviceSecretHash(ids.device, secrets.devicePrior),
  now, iso(nowMs + 30 * DAY), now, now);
  run(`UPDATE device_pairings SET state = 'consumed', consumed_at = ?, claimed_device_id = ? WHERE id = ?`,
    now, ids.device, ids.devicePairing);
  // A completed rotation: the device now holds generation 2 and the
  // rotation row keeps both hashes (credential hashes are imported).
  run(`UPDATE device_credentials SET secret_hash = ?, credential_generation = 2 WHERE id = ?`,
    deviceSecretHash(ids.device, secrets.device), ids.device);
  ids.rotation = randomUUID();
  run(`INSERT INTO device_credential_rotations(id, device_id, participant_id, prior_secret_hash,
      replacement_secret_hash, attempt_id, generation, rotated_at, retire_at, recovery_proof_hash)
    VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?, NULL)`, ids.rotation, ids.device, ids.participant,
  deviceSecretHash(ids.device, secrets.devicePrior), deviceSecretHash(ids.device, secrets.device), randomUUID(),
  now, iso(nowMs + 7 * DAY));
  run(`INSERT INTO device_pairing_events(id, pairing_id, participant_id, kind, occurred_at) VALUES (?, ?, ?, 'issued', ?)`,
    randomUUID(), ids.devicePairing, ids.participant, now);
  run(`INSERT INTO device_pairing_events(id, pairing_id, participant_id, kind, occurred_at) VALUES (?, ?, ?, 'claimed', ?)`,
    randomUUID(), ids.devicePairing, ids.participant, now);

  // An unused pairing a new device claims after the import.
  ids.openPairing = randomUUID();
  secrets.openPairing = fixtureSecret("open-pairing");
  run(`INSERT INTO device_pairings(id, participant_id, issued_by_session_id, secret_hash, consent_version, state,
      issued_at, expires_at, transport_consent_version)
    VALUES (?, ?, ?, ?, 'ongoing-privacy-safe-telemetry-v1.0', 'unused', ?, ?, 'ongoing-privacy-safe-telemetry-v1.0')`,
  ids.openPairing, ids.participant, ids.session, pairingSecretHash(ids.openPairing, secrets.openPairing),
  now, iso(nowMs + HOUR));
  run(`INSERT INTO device_pairing_events(id, pairing_id, participant_id, kind, occurred_at) VALUES (?, ?, ?, 'issued', ?)`,
    randomUUID(), ids.openPairing, ids.participant, now);

  // A session-issued upload authorization (v0.x).
  ids.upload = randomUUID();
  run(`INSERT INTO upload_authorizations(id, participant_id, issued_by_session_id, secret_hash, envelope_digest,
      body_bytes, content_type, state, issued_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 512, 'application/json', 'unused', ?, ?)`, ids.upload, ids.participant, ids.session,
  capabilityHash("upload", ids.upload, fixtureSecret("upload")), hex("w2-seal-envelope"), now, iso(nowMs + HOUR));

  // Enrollment grants: issued, redeemed with eligibility, and one whose
  // redeemer was erased on Cloudflare (redeemed, NULL redeemer, D1 0003).
  run(`INSERT INTO enrollment_grants(id, secret_hash, state, issued_at, expires_at) VALUES (?, ?, 'issued', ?, ?)`,
    randomUUID(), sha256("w2-seal-grant-issued"), now, iso(nowMs + 7 * DAY));
  ids.redeemedGrant = randomUUID();
  run(`INSERT INTO enrollment_grants(id, secret_hash, state, issued_at, expires_at, redeemed_at, redeemed_participant_id)
    VALUES (?, ?, 'redeemed', ?, ?, ?, ?)`, ids.redeemedGrant, sha256("w2-seal-grant-redeemed"), now,
  iso(nowMs + 7 * DAY), now, ids.participant);
  run(`INSERT INTO participant_community_eligibility(id, participant_id, grant_id, created_at) VALUES (?, ?, ?, ?)`,
    randomUUID(), ids.participant, ids.redeemedGrant, now);
  ids.erasedRedeemerGrant = randomUUID();
  run(`INSERT INTO enrollment_grants(id, secret_hash, state, issued_at, expires_at, redeemed_at, redeemed_participant_id)
    VALUES (?, ?, 'redeemed', ?, ?, ?, NULL)`, ids.erasedRedeemerGrant, sha256("w2-seal-grant-erased"), now,
  iso(nowMs + 7 * DAY), now);
  ids.erasedParticipant = `participant:${randomUUID()}`;

  run(`INSERT INTO recovery_retry_receipts(old_recovery_token_id, old_recovery_token_hash, recovery_attempt_hash,
      participant_id, derivation_nonce, replacement_recovery_token_id, replacement_session_id, issued_at, expires_at,
      replay_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`, randomUUID(), sha256("w2-seal-old-recovery"),
  sha256("w2-seal-recovery-attempt"), ids.participant, fixtureSecret("derivation-nonce"), randomUUID(),
  ids.recoverySession, now, iso(nowMs + HOUR));

  // Sign-in handoffs and the start admission window.
  run(`INSERT INTO apple_signin_handoffs(state, nonce_hash, identity_link_key, proof, created_at, expires_at,
      delivered_at, binding_hash, claim_id, claimed_at) VALUES (?, ?, NULL, NULL, ?, ?, NULL, ?, NULL, NULL)`,
  fixtureSecret("apple-state"), hex("w2-seal-apple-nonce"), now, iso(nowMs + 10 * 60 * 1000), hex("w2-seal-apple-binding"));
  run(`INSERT INTO google_signin_handoffs(state, code_verifier, identity_link_key, proof, created_at, expires_at,
      delivered_at, binding_hash, claim_id, claimed_at) VALUES (?, ?, NULL, NULL, ?, ?, NULL, ?, NULL, NULL)`,
  fixtureSecret("google-state"), fixtureSecret("google-verifier"), now, iso(nowMs + 10 * 60 * 1000),
  hex("w2-seal-google-binding"));
  run(`INSERT INTO sign_in_start_admission_windows(window_started_at, accepted_count, last_accepted_at) VALUES (?, 2, ?)`,
    iso(Math.floor(nowMs / 60_000) * 60_000), now);

  // GitHub distribution snapshot tables.
  const observed = iso(nowMs - HOUR);
  run("INSERT INTO github_distribution_snapshots(observed_at, completed_at) VALUES (?, ?)", observed, iso(nowMs - HOUR + 1000));
  run(`INSERT INTO github_release_snapshots(observed_at, release_id, release_tag, release_published_at, release_prerelease)
    VALUES (?, 1001, 'v0.0.1-synthetic', ?, 0)`, observed, iso(nowMs - 2 * DAY));
  run(`INSERT INTO github_release_asset_snapshots(observed_at, release_id, release_tag, release_published_at,
      release_prerelease, asset_id, asset_name, asset_digest, asset_download_count, is_dmg)
    VALUES (?, 1001, 'v0.0.1-synthetic', ?, 0, 2001, 'synthetic-asset.dmg', ?, 3, 1)`, observed, iso(nowMs - 2 * DAY),
  `sha256:${hex("w2-seal-asset")}`);

  // Admin audit: a controls change, then an owner-run floor rollback whose
  // audit row is written before the rollback row (and completed after it).
  run(`INSERT INTO admin_action_audit(operation_id, action, actor_identity_digest, outcome, details_json, created_at)
    VALUES (?, 'set_collection_controls', ?, 'success', '{}', ?)`, randomUUID(), hex("w2-seal-actor"), now);
  const floor = database.prepare("SELECT minimum_rank, revision FROM telemetry_transport_participant_floors WHERE participant_id = ?")
    .get(ids.participant);
  run("UPDATE telemetry_transport_participant_floors SET minimum_rank = 10, revision = ?, changed_at = ? WHERE participant_id = ?",
    Number(floor.revision) + 1, now, ids.participant);
  const raised = Number(floor.revision) + 1;
  ids.rollbackOperation = randomUUID();
  const participantDigest = hex(`w2-seal-participant-digest:${ids.participant}`);
  run(`INSERT INTO admin_action_audit(operation_id, action, actor_identity_digest, outcome, details_json, created_at)
    VALUES (?, 'run_maintenance', ?, 'started', ?, ?)`, ids.rollbackOperation, hex("w2-seal-actor"),
  JSON.stringify({ operation: "telemetry_transport_rollback", participantDigest, expectedRevision: raised,
    fromRank: 10, toRank: 1 }), now);
  run(`INSERT INTO telemetry_transport_floor_rollbacks(operation_id, participant_id, participant_digest,
      expected_revision, from_rank, to_rank, created_at) VALUES (?, ?, ?, ?, 10, 1, ?)`,
  ids.rollbackOperation, ids.participant, participantDigest, raised, now);
  run("UPDATE telemetry_transport_participant_floors SET minimum_rank = 1, revision = ?, changed_at = ? WHERE participant_id = ?",
    raised + 1, now, ids.participant);
  run("UPDATE admin_action_audit SET outcome = 'success' WHERE operation_id = ?", ids.rollbackOperation);

  // A revoked accountless installation (ledger, device, owner, v1.1 and
  // v1.2 grants): the upload block that must carry over verbatim.
  ids.revokedParticipant = `participant:${randomUUID()}`;
  ids.revokedDevice = randomUUID();
  const revokedHash = deviceSecretHash(ids.revokedDevice, fixtureSecret("revoked-device"));
  const leaseExpires = iso(nowMs + 30 * DAY);
  run(`INSERT INTO participants(id, owner_kind, state, created_at) VALUES (?, 'accountless', 'active', ?)`,
    ids.revokedParticipant, now);
  run(`INSERT INTO accountless_enrollment_ledger(device_id, device_secret_hash, installation_principal_id,
      schema_version, policy_version, authorization_basis, state, issued_at, expires_at, renewal_generation)
    VALUES (?, ?, ?, 'accountless-enrollment-v0.1', 'accountless-opt-out-v1', 'accountless-policy-v1', 'active', ?, ?, 0)`,
  ids.revokedDevice, revokedHash, `accountless:${randomUUID()}`, now, leaseExpires);
  run(`INSERT INTO device_credentials(id, participant_id, authority_kind, accountless_enrollment_device_id, secret_hash,
      state, issued_at, expires_at, last_used_at, credential_generation)
    VALUES (?, ?, 'accountless', ?, ?, 'active', ?, ?, ?, 1)`, ids.revokedDevice, ids.revokedParticipant,
  ids.revokedDevice, revokedHash, now, leaseExpires, now);
  run(`INSERT INTO accountless_upload_owners(enrollment_device_id, participant_id, device_credential_id, policy_version,
      authorization_basis, authorized_at, expires_at, state)
    VALUES (?, ?, ?, 'accountless-opt-out-v1', 'accountless-policy-v1', ?, ?, 'active')`, ids.revokedDevice,
  ids.revokedParticipant, ids.revokedDevice, now, leaseExpires);
  run(`INSERT INTO accountless_v11_device_authorizations(enrollment_device_id, participant_id, device_credential_id,
      telemetry_schema_version, field_dictionary_version, privacy_contract_version, authorized_at, expires_at, state)
    VALUES (?, ?, ?, 'telemetry-contribution-v1.1', 'telemetry-v1.1-registry-2026-08-31.1',
      'ongoing-privacy-safe-telemetry-v1.1', ?, ?, 'active')`, ids.revokedDevice, ids.revokedParticipant,
  ids.revokedDevice, now, leaseExpires);
  run(`INSERT INTO accountless_v12_device_authorizations(enrollment_device_id, participant_id, device_credential_id,
      schema_version, policy_version, authorization_basis, telemetry_schema_version, field_dictionary_version,
      privacy_contract_version, authorized_at, expires_at, state)
    VALUES (?, ?, ?, 'accountless-upload-owner-v1.2', 'accountless-telemetry-v1.2-policy-v1', 'accountless-policy-v1.2',
      'telemetry-contribution-v1.2', 'telemetry-v1.2-registry-2026-09-20.1', 'ongoing-privacy-safe-telemetry-v1.2',
      ?, ?, 'active')`, ids.revokedDevice, ids.revokedParticipant, ids.revokedDevice, now, leaseExpires);
  const revokedAt = iso(nowMs + 1000);
  run(`UPDATE accountless_enrollment_ledger SET state = 'revoked', revoked_at = ?, revocation_reason = 'user_opt_out'
    WHERE device_id = ?`, revokedAt, ids.revokedDevice);
  run(`UPDATE accountless_upload_owners SET state = 'revoked', revoked_at = ?, revocation_reason = 'user_opt_out'
    WHERE enrollment_device_id = ?`, revokedAt, ids.revokedDevice);
  run(`UPDATE accountless_v11_device_authorizations SET state = 'revoked', revoked_at = ?, revocation_reason = 'user_opt_out'
    WHERE enrollment_device_id = ?`, revokedAt, ids.revokedDevice);
  run(`UPDATE accountless_v12_device_authorizations SET state = 'revoked', revoked_at = ?, revocation_reason = 'user_opt_out'
    WHERE enrollment_device_id = ?`, revokedAt, ids.revokedDevice);
  run("UPDATE device_credentials SET state = 'revoked', revoked_at = ? WHERE id = ?", revokedAt, ids.revokedDevice);
  return { ids: Object.freeze(ids), secrets: Object.freeze(secrets), nowMs };
}

/**
 * Build the synthetic ingestion D1 (writable; the seal treats it as the
 * remote). Options: ledgers (inventory layout), commit (expected-ledger
 * commit), ledgerNames ('bare' or 'canonical'), plant (identity rows),
 * provider (add a D1 provider table), mutate(database) for drift cases.
 */
export async function buildSyntheticIngestionD1({
  directory, commit, ledgers = DEFAULT_INGESTION_LEDGERS, ledgerNames = "bare", plant = true, nowMs = Date.now(),
  identityLinkVersion = SYNTHETIC_IDENTITY_LINK_VERSION,
} = {}) {
  const work = join(directory, "q1-oracle.sqlite");
  rebuildOracleSqlite(Q1_INGESTION_DUMP, work, { seal: false });
  const database = new DatabaseSync(work);
  let fixture = null;
  try {
    database.exec("PRAGMA foreign_keys=ON");
    database.exec("BEGIN");
    writeExpectedLedgers(database, { role: "ingestion", ledgers, commit, nameStyle: ledgerNames });
    if (plant) fixture = plantIdentityRows(database, nowMs, identityLinkVersion);
    database.exec("COMMIT");
    const violations = database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length !== 0) throw new Error("W2_SEAL_FIXTURE_FOREIGN_KEYS");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* not open */ }
    throw error;
  } finally {
    database.close();
  }
  return { path: work, fixture };
}

/** The synthetic deletion-ledger D1 (deletion-ledger-migrations 0001-0003, synthetic digests). */
export async function buildSyntheticDeletionLedgerD1({
  directory, commit, digests, ledgers = DEFAULT_LEDGER_LEDGERS, nowMs = Date.now(),
} = {}) {
  const path = join(directory, "deletion-ledger.sqlite");
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON");
    const migrations = (await readdir(join(WORKER_ROOT, "deletion-ledger-migrations"))).filter(name => name.endsWith(".sql")).sort();
    for (const name of migrations) database.exec(await readFile(join(WORKER_ROOT, "deletion-ledger-migrations", name), "utf8"));
    database.exec("BEGIN");
    writeExpectedLedgers(database, { role: "deletion-ledger", ledgers, commit });
    const insert = database.prepare(`INSERT INTO deletion_tombstones(participant_digest, schema_version, deleted_at, retain_until)
      VALUES (?, 'participant-deletion-tombstone-v0.1', ?, ?)`);
    for (const digest of digests) insert.run(digest, iso(nowMs - DAY), iso(nowMs + 365 * DAY));
    database.prepare(`INSERT INTO identity_reenrollment_cooldowns(identity_cooldown_digest, schema_version, deleted_at, retain_until)
      VALUES (?, 'identity-reenrollment-cooldown-v0.1', ?, ?)`).run(hex("w2-seal-cooldown"), iso(nowMs - DAY), iso(nowMs + DAY));
    database.prepare(`INSERT INTO storage_erasure_jobs(participant_digest, source_id, owner_digest, source_namespace, state,
        terminal_json, completed_at, attempted_ms) VALUES (?, 'synthetic-source', ?, 'synthetic-namespace', 'complete', '{}', ?, 1)`)
      .run(digests[0], hex("w2-seal-owner"), iso(nowMs - DAY));
    database.exec("COMMIT");
  } finally {
    database.close();
  }
  return { path };
}

/** Synthetic tombstone digests: none matches a sealed active participant. */
export function syntheticTombstoneDigests({ erasedParticipantId = null, plantActiveParticipantId = null } = {}) {
  const digests = [hex("w2-seal-tombstone-1"), hex("w2-seal-tombstone-2"), hex("w2-seal-tombstone-3")];
  const domain = "app-usagemonitor/deletion-tombstone/v1\0";
  if (erasedParticipantId !== null) digests.push(hex(`${domain}${erasedParticipantId}`));
  if (plantActiveParticipantId !== null) digests.push(hex(`${domain}${plantActiveParticipantId}`));
  return digests;
}

// ---------------------------------------------------------------------------
// The fake export: a D1-shaped SQL dump of a synthetic file.

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    // With setReadBigInts every INTEGER cell is a bigint, so a number is a
    // REAL cell: keep its storage class with a decimal point or exponent.
    if (!Number.isFinite(value)) throw new Error("W2_SEAL_FIXTURE_NUMBER");
    const text = Object.is(value, -0) ? "-0.0" : String(value);
    return /[.eE]/u.test(text) ? text : `${text}.0`;
  }
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Write the export: tables in creation order with their rows, then the
 * sqlite_sequence rows, then indexes, triggers and views. `extra` statements
 * are appended verbatim (for refusal cases).
 */
export function writeD1Export(sourcePath, outputPath, { extra = [] } = {}) {
  const database = new DatabaseSync(sourcePath, { readOnly: true });
  const descriptor = openSync(outputPath, "w");
  const write = (text) => writeSync(descriptor, text);
  try {
    write("PRAGMA defer_foreign_keys=TRUE;\n");
    const objects = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid").all();
    for (const object of objects.filter(item => item.type === "table" && !item.name.startsWith("sqlite_"))) {
      write(`${object.sql};\n`);
      const columns = database.prepare(`PRAGMA table_xinfo("${object.name}")`).all().filter(column => Number(column.hidden) === 0)
        .map(column => column.name);
      const withoutRowid = Number(database.prepare("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?")
        .get(object.name)?.wr ?? 0) === 1;
      const select = database.prepare(`SELECT ${columns.map(column => `"${column}"`).join(",")} FROM "${object.name}"${
        withoutRowid ? "" : " ORDER BY rowid"}`);
      select.setReadBigInts(true);
      const list = columns.map(column => `"${column}"`).join(",");
      for (const row of select.iterate()) {
        write(`INSERT INTO "${object.name}" (${list}) VALUES(${columns.map(column => literal(row[column])).join(",")});\n`);
      }
    }
    const sequence = database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").all();
    if (sequence.length === 1) {
      write("DELETE FROM sqlite_sequence;\n");
      const sequenceRows = database.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name");
      sequenceRows.setReadBigInts(true);
      for (const row of sequenceRows.all()) {
        write(`INSERT INTO "sqlite_sequence" VALUES(${literal(row.name)},${literal(row.seq)});\n`);
      }
    }
    for (const type of ["index", "trigger", "view"]) {
      for (const object of objects.filter(item => item.type === type)) write(`${object.sql};\n`);
    }
    for (const statement of extra) write(`${statement}\n`);
  } finally {
    closeSync(descriptor);
    database.close();
  }
}

/**
 * The injected export spawn: answers `<cli> d1 export <name> --remote
 * --output <path> --config <path>` from the synthetic file for that
 * database name, printing a signed URL on stdout, stderr and into
 * WRANGLER_LOG_PATH as the provider transport might. `echoSignedUrl`
 * additionally writes it into the export (the case the scan must trip on).
 */
export function createFakeWranglerSpawn({ sources, echoSignedUrl = false, exitStatus = 0, extra = [], observations = [] } = {}) {
  return (command, args, options) => {
    const exportIndex = args.indexOf("export");
    const output = args[args.indexOf("--output") + 1];
    const name = args[exportIndex + 1];
    observations.push({ command, remote: args.includes("--remote"), stdio: options?.stdio, outputMode: statSync(output).mode & 0o777,
      logPath: options?.env?.WRANGLER_LOG_PATH ?? null });
    if (options?.env?.WRANGLER_LOG_PATH) appendFileSync(options.env.WRANGLER_LOG_PATH, `debug ${SYNTHETIC_SIGNED_URL}\n`);
    const source = sources[name];
    if (exportIndex < 0 || source === undefined) return { status: 1, stdout: Buffer.from(SYNTHETIC_SIGNED_URL), stderr: Buffer.alloc(0) };
    writeD1Export(source, output, { extra: echoSignedUrl ? [...extra, `-- ${SYNTHETIC_SIGNED_URL}`] : extra });
    observations.at(-1).writtenMode = statSync(output).mode & 0o777;
    return {
      status: exitStatus,
      signal: null,
      stdout: Buffer.from(`Downloading from ${SYNTHETIC_SIGNED_URL}\n`),
      stderr: Buffer.from(`fetch ${SYNTHETIC_SIGNED_URL}\n`),
    };
  };
}

/**
 * The injected read-only transport: bookmarks come from `bookmarks` (a value
 * or a function of the call number) and queries run on the synthetic file.
 * `tamper(role, sql, rows)` may rewrite a response for drift cases; every
 * call is recorded.
 */
export function createFakeCutoverTransport({ sources, bookmarks, tamper = null, calls = [] } = {}) {
  let bookmarkCalls = 0;
  return {
    calls,
    async bookmark(source) {
      calls.push({ kind: "bookmark", role: source.role });
      bookmarkCalls += 1;
      const value = bookmarks[source.role];
      return typeof value === "function" ? value(bookmarkCalls) : value;
    },
    async query(source, sql) {
      calls.push({ kind: "query", role: source.role });
      const database = new DatabaseSync(sources[source.role], { readOnly: true });
      try {
        const rows = database.prepare(sql).all().map(row => ({ ...row }));
        return tamper === null ? rows : tamper(source.role, sql, rows);
      } finally {
        database.close();
      }
    },
  };
}

export async function ensureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}
