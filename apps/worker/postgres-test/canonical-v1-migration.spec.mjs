import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import pg from "pg";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { canonicalJson } from "../src/canonical-json.ts";
import { parseTelemetryV1Chunk } from "../src/telemetry-v1.ts";
import { createExperimentalPostgresTelemetryV1Backend } from "../src/postgres-telemetry-v1-backend.ts";

const primarySchema = "tibotattle";
const ledgerSchema = "tibotattle_ledger";
const participantId = "synthetic-canonical-participant";
const deviceId = "synthetic-canonical-device";
const day = "2026-09-21";
const consent = {
  telemetrySchemaVersion: "telemetry-contribution-v1.0",
  fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
  privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
};

const digest = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const at = (hour) => `2026-09-21T${String(hour).padStart(2, "0")}:00:00.000Z`;
const future = (milliseconds) => new Date(Date.now() + milliseconds).toISOString();

let admin;
let primary;
let ledger;
let primaryDatabase;
let ledgerDatabase;
let primaryCreated = false;
let ledgerCreated = false;

async function queryRows(pool, sql, values = []) {
  return (await pool.query(sql, values)).rows;
}

async function insertAuthorityRows() {
  const sessionId = "synthetic-canonical-session";
  const pairingId = "synthetic-canonical-pairing";
  const issuedAt = at(10);
  const expiresAt = future(30 * 24 * 60 * 60 * 1000);
  await primary.query(`INSERT INTO ${primarySchema}.participants
    (id, owner_kind, state, consent_version, consented_at, created_at)
    VALUES ($1, 'social', 'active', $2, $3, $3)`,
  [participantId, consent.privacyContractVersion, issuedAt]);
  await primary.query(`INSERT INTO ${primarySchema}.web_sessions
    (id, participant_id, secret_hash, csrf_hash, scope, state, issued_at, expires_at, last_used_at)
    VALUES ($1, $2, $3, $4, 'personal', 'active', $5, $6, $5)`,
  [sessionId, participantId, Buffer.alloc(32, 1), Buffer.alloc(32, 2), issuedAt, expiresAt]);
  await primary.query(`INSERT INTO ${primarySchema}.device_pairings
    (id, participant_id, issued_by_session_id, secret_hash, consent_version,
      transport_consent_version, state, issued_at, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, 'consumed', $7, $8)`,
  [pairingId, participantId, sessionId, Buffer.alloc(32, 3), consent.privacyContractVersion,
    consent.telemetrySchemaVersion, issuedAt, expiresAt]);
  await primary.query(`INSERT INTO ${primarySchema}.device_credentials
    (id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
      state, issued_at, expires_at, last_used_at, social_verified_at)
    VALUES ($1, $2, 'social', $3, $4, 'active', $5, $6, $5, $5)`,
  [deviceId, participantId, pairingId, Buffer.alloc(32, 4), issuedAt, expiresAt]);
  await primary.query(`UPDATE ${primarySchema}.device_pairings
    SET claimed_device_id = $1 WHERE id = $2`, [deviceId, pairingId]);
  await primary.query(`INSERT INTO ${primarySchema}.telemetry_v1_device_consents
    (participant_id, device_id, telemetry_schema_version, field_dictionary_version,
      privacy_contract_version, consented_at)
    VALUES ($1, $2, $3, $4, $5, $6)`,
  [participantId, deviceId, consent.telemetrySchemaVersion,
    consent.fieldDictionaryVersion, consent.privacyContractVersion, issuedAt]);
}

async function grantUpload(index, envelopeDigest) {
  const authorizationId = `synthetic-canonical-authorization-${index}`;
  const issuedAt = at(10 + index);
  const expiresAt = future(24 * 60 * 60 * 1000);
  const leaseExpiresAt = future(60 * 60 * 1000);
  await primary.query(`INSERT INTO ${primarySchema}.device_upload_authorizations
    (id, participant_id, issued_by_device_id, secret_hash, envelope_digest, body_bytes,
      content_type, state, issued_at, expires_at, consume_lease_expires_at)
    VALUES ($1, $2, $3, $4, $5, 1024, 'application/json', 'consuming', $6, $7, $8)`,
  [authorizationId, participantId, deviceId, Buffer.alloc(32, 10 + index), envelopeDigest,
    issuedAt, expiresAt, leaseExpiresAt]);
  return { authorizationId, leaseExpiresAt };
}

function contribution({
  index,
  revision,
  stream = "session",
  supersedes = null,
  occurrence = "synthetic-session-0001",
  leaseExpiresAt = future(60 * 60 * 1000),
}) {
  const record = stream === "usage"
    ? {
      schemaVersion: "usage-event-v1.0",
      eventId: `synthetic-usage-${index}`,
      eventTime: at(12 + index),
      sessionUuid: occurrence,
      provider: "synthetic",
      modelId: "synthetic-model",
      speedMode: "standard",
      apiServiceTier: "standard",
      surface: "synthetic",
      billingSurface: "synthetic",
      reasoningEffort: "none",
      agentScope: "synthetic",
      outcome: "success",
      totalInputContextTokens: 1,
      components: {
        inputUncachedTokens: 1,
        inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0,
        outputTextTokens: 1,
        outputReasoningTokens: 0,
        outputCombinedTokens: 1,
      },
    }
    : stream === "quota"
      ? {
        schemaVersion: "quota-observation-v1.0",
        observationId: `synthetic-quota-${index}`,
        observedTime: at(12 + index),
        provider: "synthetic",
        planType: "pro",
        planVariant: "unknown",
        limitId: "synthetic",
        slot: "primary",
        usedPercent: 20,
        windowDurationMinutes: 300,
        resetsAt: at(17),
      }
      : {
        schemaVersion: "session-dimension-v1.0",
        sessionUuid: occurrence,
        firstEventTime: at(12 + index),
        provider: "synthetic",
        toolClassCounts: { read: 1 },
      };
  const records = [record];
  const envelopeDigest = digest(`canonical-envelope-${index}`);
  const sequence = stream === "session" ? 0 : stream === "usage" ? 1 : 2;
  const chunk = parseTelemetryV1Chunk({
    schemaVersion: "telemetry-contribution-v1.0",
    chunkId: `${stream}:${day}:${sequence}`,
    chunkRevision: revision,
    chunkDigest: digest(records),
    parserVersion: "synthetic-canonical-v1",
    consent,
    records,
  });
  const chunkId = `synthetic-canonical-contribution-${index}`;
  return {
    participantId,
    deviceId,
    uploadAuthorizationId: `synthetic-canonical-authorization-${index}`,
    uploadAuthorizationLeaseExpiresAt: leaseExpiresAt,
    chunkId,
    objectKey: `synthetic/canonical/${chunkId}`,
    envelopeDigest,
    chunk,
    supersedes,
    createdAt: at(13 + index),
  };
}

beforeAll(async () => {
  const socket = process.env.PG_TEST_SOCKET;
  if (!socket || !isAbsolute(socket) || !socket.startsWith("/private/tmp/tibotattle-pg-")) {
    throw new Error("PG_TEST_SOCKET must name an explicitly provisioned temporary PostgreSQL socket directory");
  }
  const stat = await lstat(socket);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(socket) !== socket
      || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()) {
    throw new Error("PG_TEST_SOCKET must be a canonical owner-only directory");
  }
  const port = Number(process.env.PG_TEST_PORT ?? "5432");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid PG_TEST_PORT");
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PG") && !key.startsWith("PG_TEST_")) vi.stubEnv(key, undefined);
  }
  const options = {
    host: socket,
    port,
    user: "postgres",
    password: "synthetic-local-only",
    database: "postgres",
    ssl: false,
    options: "",
    application_name: "tibotattle-postgres-canonical-v1",
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 1000,
    max: 4,
  };
  admin = new pg.Pool(options);
  expect(Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num)).toBeGreaterThanOrEqual(160000);
  primaryDatabase = `tibotattle_canonical_${randomBytes(8).toString("hex")}`;
  ledgerDatabase = `tibotattle_canonical_ledger_${randomBytes(8).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${primaryDatabase}"`);
  primaryCreated = true;
  await admin.query(`CREATE DATABASE "${ledgerDatabase}"`);
  ledgerCreated = true;
  primary = new pg.Pool({ ...options, database: primaryDatabase });
  ledger = new pg.Pool({ ...options, database: ledgerDatabase });
  await primary.query(`CREATE SCHEMA ${primarySchema}`);
  await ledger.query(`CREATE SCHEMA ${ledgerSchema}`);
  const primaryResult = await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: primary });
  const ledgerResult = await applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool: ledger });
  expect(primaryResult.applied).toBe(primaryResult.migrations.length);
  expect(primaryResult.migrations.map(migration => migration.version))
    .toEqual(primaryResult.migrations.map((_, index) => index + 1));
  expect(primaryResult.migrations.slice(-3).map(migration => migration.name)).toEqual([
    "0008_pending_object_reconciliation.sql",
    "0009_owner_scoped_analytics.sql",
    "0010_v1_analytical_side_effects.sql",
  ]);
  expect(ledgerResult.applied).toBe(ledgerResult.migrations.length);
  expect(ledgerResult.migrations.map(migration => migration.version))
    .toEqual(ledgerResult.migrations.map((_, index) => index + 1));
  expect((await queryRows(primary, `SELECT version, name, checksum_sha256 FROM ${primarySchema}._tibotattle_migration_history ORDER BY version`)).length)
    .toBe(primaryResult.migrations.length);
  expect((await queryRows(ledger, `SELECT version, name, checksum_sha256 FROM ${ledgerSchema}._tibotattle_migration_history ORDER BY version`)).length)
    .toBe(ledgerResult.migrations.length);
  await insertAuthorityRows();
});

afterAll(async () => {
  try {
    await Promise.all([primary?.end(), ledger?.end()]);
    if (ledgerCreated) await admin.query(`DROP DATABASE "${ledgerDatabase}"`);
    if (primaryCreated) await admin.query(`DROP DATABASE "${primaryDatabase}"`);
  } finally {
    await admin?.end();
    vi.unstubAllEnvs();
  }
});

it("applies operational migrations and exercises canonical v1 write, replay and sync", async () => {
  const backend = createExperimentalPostgresTelemetryV1Backend(primary, {
    primarySchema,
    ledgerSchema,
  });
  const first = contribution({ index: 1, revision: 1 });
  const firstGrant = await grantUpload(1, first.envelopeDigest);
  first.uploadAuthorizationLeaseExpiresAt = firstGrant.leaseExpiresAt;
  const authDebug = await queryRows(primary, `SELECT id, participant_id, issued_by_device_id, envelope_digest,
    state, consume_lease_expires_at, expires_at FROM ${primarySchema}.device_upload_authorizations`);
  expect(authDebug).toMatchObject([{
    id: first.uploadAuthorizationId,
    participant_id: participantId,
    issued_by_device_id: deviceId,
    envelope_digest: first.envelopeDigest,
    state: "consuming",
  }]);
  await expect(backend.contributions.insert(first)).resolves.toEqual({ acceptedRecords: 1 });
  await expect(backend.reader.current({
    participantId,
    deviceId,
    stream: "session",
    chunkDay: day,
    chunkSeq: 0,
  })).resolves.toMatchObject({
    id: first.chunkId,
    revision: 1,
    recordCount: 1,
    acceptedRecords: 1,
  });
  await expect(backend.reader.byEnvelope(participantId, first.envelopeDigest)).resolves.toMatchObject({
    id: first.chunkId,
    revision: 1,
  });
  await expect(backend.sync.state(participantId, deviceId)).resolves.toMatchObject({
    acknowledgedThroughDay: day,
    dayCount: 1,
    chunkCount: 1,
  });
  await expect(queryRows(primary, `SELECT contribution_id, object_key FROM ${primarySchema}.pending_objects`)).resolves.toHaveLength(1);

  const second = contribution({ index: 2, revision: 2, supersedes: { id: first.chunkId } });
  const secondGrant = await grantUpload(2, second.envelopeDigest);
  second.uploadAuthorizationLeaseExpiresAt = secondGrant.leaseExpiresAt;
  await expect(backend.contributions.insert(second)).resolves.toEqual({ acceptedRecords: 1 });
  await expect(backend.reader.current({
    participantId,
    deviceId,
    stream: "session",
    chunkDay: day,
    chunkSeq: 0,
  })).resolves.toMatchObject({ id: second.chunkId, revision: 2 });
  await expect(backend.reader.byEnvelope(participantId, first.envelopeDigest)).resolves.toMatchObject({
    id: first.chunkId,
    revision: 1,
    supersededAt: expect.any(String),
  });
  expect((await queryRows(primary, `SELECT id FROM ${primarySchema}.telemetry_v1_chunks WHERE superseded_at IS NULL`)).length).toBe(1);
  expect((await queryRows(primary, `SELECT chunk_row_id FROM ${primarySchema}.telemetry_v1_records`)).map(({ chunk_row_id: id }) => id)).toEqual([second.chunkId]);
  expect((await queryRows(primary, `SELECT contribution_id FROM ${primarySchema}.pending_objects ORDER BY contribution_id`)).length).toBe(2);

  // A delayed writer must not consume a renewed lease for the same
  // authorization and digest. The row remains consuming while its fencing
  // lease is reclaimed, so the old attempt must fail before any chunk,
  // record, or pending-object insert; the renewed claim then succeeds.
  const raced = contribution({ index: 3, revision: 1, stream: "usage" });
  const raceGrant = await grantUpload(3, raced.envelopeDigest);
  raced.uploadAuthorizationLeaseExpiresAt = raceGrant.leaseExpiresAt;
  const renewedLease = future(2 * 60 * 60 * 1000);
  await primary.query(`UPDATE ${primarySchema}.device_upload_authorizations
    SET consume_lease_expires_at = $1 WHERE id = $2`, [renewedLease, raced.uploadAuthorizationId]);
  await expect(backend.contributions.insert(raced)).rejects.toMatchObject({ code: "UPLOAD_AUTH_INVALID" });
  expect((await queryRows(primary, `SELECT id FROM ${primarySchema}.telemetry_v1_chunks`)).length).toBe(2);
  expect((await queryRows(primary, `SELECT contribution_id FROM ${primarySchema}.pending_objects`)).length).toBe(2);
  raced.uploadAuthorizationLeaseExpiresAt = renewedLease;
  await expect(backend.contributions.insert(raced)).resolves.toEqual({ acceptedRecords: 1 });

  const quota = contribution({ index: 4, revision: 1, stream: "quota" });
  const quotaGrant = await grantUpload(4, quota.envelopeDigest);
  quota.uploadAuthorizationLeaseExpiresAt = quotaGrant.leaseExpiresAt;
  await expect(backend.contributions.insert(quota)).resolves.toEqual({ acceptedRecords: 1 });
  expect((await queryRows(primary, `SELECT stream FROM ${primarySchema}.telemetry_v1_records ORDER BY stream`)).map(({ stream }) => stream)).toEqual([
    "quota", "session", "usage",
  ]);
  await expect(backend.sync.state(participantId, deviceId)).resolves.toMatchObject({ chunkCount: 3, dayCount: 1 });
  expect((await queryRows(primary, `SELECT contribution_id FROM ${primarySchema}.pending_objects`)).length).toBe(4);
});
