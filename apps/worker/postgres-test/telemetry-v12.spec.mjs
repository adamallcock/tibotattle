import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import pg from "pg";
import {
  canonicalTelemetryV12Json,
  telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput,
  telemetryV12RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { createPostgresTelemetryAuthorityBackend } from "../src/postgres-telemetry-authority-backend.ts";
import { createPostgresTelemetryV12Backend } from "../src/postgres-telemetry-v12-backend.ts";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const hash = (value) => Buffer.alloc(32, value);
const baseEpoch = Date.now();
const now = new Date(baseEpoch).toISOString();
const expires = new Date(baseEpoch + 2 * 60 * 60 * 1000).toISOString();
const lease = new Date(baseEpoch + 60 * 60 * 1000).toISOString();
const day = "2026-09-21";
const participantId = "v12-transport-participant";
const deviceId = "v12-transport-device";
const secondDeviceId = "v12-transport-device-2";
const sessionId = "v12-transport-session";
const pairingId = "v12-transport-pairing";
const secondPairingId = "v12-transport-pairing-2";

let admin;
let pool;
let database;
let primarySchema;
let ledgerSchema;
let authority;
let backend;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function usageRecord() {
  return {
    schemaVersion: "usage-event-v1.2",
    eventId: "event:v12:00000001",
    eventTime: `${day}T12:05:00.000Z`,
    sessionUuid: "session:v12:00000001",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "standard",
    apiServiceTier: "default",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "high",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: 1_000,
    components: {
      inputUncachedTokens: 100,
      inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0,
      outputTextTokens: 50,
      outputReasoningTokens: 25,
      outputCombinedTokens: null,
    },
    accountPlanAttribution: {
      accountBasis: "unavailable",
      accountTrackId: null,
      planBasis: "same_source_occurrence",
      planType: "pro",
      planEraId: null,
    },
    boundaryFlags: null,
    tieOrder: null,
    cacheWriteTtl: null,
  };
}

function preparedDay() {
  const consent = telemetryV12RequiredConsent();
  const record = usageRecord();
  const chunk = {
    schemaVersion: "telemetry-contribution-v1.2",
    manifestDigest: "0".repeat(64),
    chunkId: `usage:${day}:0`,
    chunkRevision: 1,
    chunkDigest: digest(canonicalTelemetryV12Json([record])),
    parserVersion: "synthetic-v12",
    consent,
    records: [record],
  };
  const manifest = {
    schemaVersion: "telemetry-day-manifest-v1.2",
    day,
    parserVersion: "synthetic-v12",
    consent,
    chunks: [{ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: 1 }],
    excluded: { quota: 0, session: 0, usage: 0 },
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = digest(telemetryV12DayManifestDigestInput(manifest));
  chunk.manifestDigest = manifest.manifestDigest;
  return { manifest, chunk };
}

function preparedDayFor(targetDay) {
  const prepared = preparedDay();
  if (targetDay === day) return prepared;
  prepared.manifest.day = targetDay;
  prepared.chunk.chunkId = `usage:${targetDay}:0`;
  prepared.chunk.records[0].eventTime = `${targetDay}T12:05:00.000Z`;
  prepared.chunk.chunkDigest = digest(canonicalTelemetryV12Json(prepared.chunk.records));
  prepared.manifest.chunks[0].chunkId = prepared.chunk.chunkId;
  prepared.manifest.chunks[0].chunkDigest = prepared.chunk.chunkDigest;
  prepared.manifest.manifestDigest = digest(telemetryV12DayManifestDigestInput(prepared.manifest));
  prepared.chunk.manifestDigest = prepared.manifest.manifestDigest;
  return prepared;
}

function domainFor(predecessor, days, fromDay, throughDay = fromDay) {
  const domain = {
    schemaVersion: "telemetry-domain-manifest-v1.2",
    fromDay,
    throughDay,
    predecessor: {
      token: predecessor.token,
      previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint,
    },
    days,
    manifestDigest: "0".repeat(64),
  };
  domain.manifestDigest = digest(telemetryV12DomainManifestDigestInput(domain));
  return domain;
}

async function waitForLockWait(tableName, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND pid <> pg_backend_pid()
        AND wait_event_type='Lock' AND state='active' AND query LIKE $1`, [`%${tableName}%`]);
    if (result.rows[0]?.count > 0) return;
    await sleep(20);
  }
  throw new Error(`expected a PostgreSQL lock wait for ${tableName}`);
}

async function seedAuthority() {
  await pool.query(`INSERT INTO "${primarySchema}".participants
    (id, owner_kind, state, consent_version, consented_at, created_at)
    VALUES ($1, 'social', 'active', $2, $3, $3)`,
  [participantId, "ongoing-privacy-safe-telemetry-v1.0", now]);
  await pool.query(`INSERT INTO "${primarySchema}".web_sessions
    (id, participant_id, secret_hash, csrf_hash, scope, state, issued_at, expires_at, last_used_at)
    VALUES ($1, $2, $3, $4, 'personal', 'active', $5, $6, $5)`,
  [sessionId, participantId, hash(1), hash(2), now, expires]);
  await pool.query(`INSERT INTO "${primarySchema}".device_pairings
    (id, participant_id, issued_by_session_id, secret_hash, consent_version,
     transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id)
    VALUES ($1, $2, $3, $4, $5, $6, 'consumed', $7, $8, $7, $9)`,
  [pairingId, participantId, sessionId, hash(3), "ongoing-privacy-safe-telemetry-v1.0",
    "ongoing-privacy-safe-telemetry-v1.0", now, expires, deviceId]);
  await pool.query(`INSERT INTO "${primarySchema}".device_credentials
    (id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
     state, issued_at, expires_at, last_used_at, social_verified_at)
    VALUES ($1, $2, 'social', $3, $4, 'active', $5, $6, $5, $5)`,
  [deviceId, participantId, pairingId, hash(4), now, expires]);
  await pool.query(`INSERT INTO "${primarySchema}".telemetry_transport_participant_floors
    (participant_id, minimum_rank, revision, changed_at) VALUES ($1, 1, 0, $2)`,
  [participantId, now]);
  await pool.query(`UPDATE "${primarySchema}".telemetry_transport_formats
    SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.2'`);
  await pool.query(`UPDATE "${primarySchema}".telemetry_v12_runtime
    SET state='active', revision=1, changed_at=$1 WHERE id=1`, [now]);
}

async function claimUpload(id, envelopeDigest, targetDeviceId = deviceId) {
  await authority.devices.insertUpload({
    id,
    participantId,
    issuedByDeviceId: targetDeviceId,
    secretHash: new Uint8Array(hash(20)),
    envelopeDigest,
    bodyBytes: 512,
    contentType: "application/json",
    issuedAt: now,
    expiresAt: expires,
  });
  const claimed = await authority.devices.claimUpload({
    authorizationId: id,
    participantId,
    deviceId: targetDeviceId,
    envelopeDigest,
    bodyBytes: 512,
    contentType: "application/json",
    leaseExpiresAt: lease,
    now,
  });
  expect(claimed).toBe(lease);
  return { id, lease };
}

async function seedSecondDevice() {
  await pool.query(`INSERT INTO "${primarySchema}".device_pairings
    (id, participant_id, issued_by_session_id, secret_hash, consent_version,
     transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id)
    VALUES ($1, $2, $3, $4, $5, $6, 'consumed', $7, $8, $7, $9)`,
  [secondPairingId, participantId, sessionId, hash(5), "ongoing-privacy-safe-telemetry-v1.0",
    "ongoing-privacy-safe-telemetry-v1.0", now, expires, secondDeviceId]);
  await pool.query(`INSERT INTO "${primarySchema}".device_credentials
    (id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
     state, issued_at, expires_at, last_used_at, social_verified_at)
    VALUES ($1, $2, 'social', $3, $4, 'active', $5, $6, $5, $5)`,
  [secondDeviceId, participantId, secondPairingId, hash(6), now, expires]);
  await authority.transport.upsertConsent({
    schemaVersion: "telemetry-contribution-v1.2",
    fieldDictionaryVersion: "telemetry-v1.2-registry-2026-09-20.1",
    privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.2",
    principal: { participantId, deviceId: secondDeviceId }, sessionId, now,
  });
}

beforeAll(async () => {
  const socket = process.env.PG_TEST_SOCKET;
  if (!socket || !isAbsolute(socket) || !socket.startsWith("/private/tmp/tibotattle-pg-")) {
    throw new Error("PG_TEST_SOCKET must identify the provisioned local PostgreSQL socket");
  }
  const stat = await lstat(socket);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(socket) !== socket
      || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()) {
    throw new Error("PG_TEST_SOCKET must be a canonical owner-only directory");
  }
  const port = Number(process.env.PG_TEST_PORT ?? "5432");
  const options = {
    host: socket, port, user: "postgres", password: "synthetic-local-only", database: "postgres",
    ssl: false, options: "", connectionTimeoutMillis: 3_000, idleTimeoutMillis: 1_000, max: 1,
  };
  admin = new pg.Pool(options);
  database = `tibotattle_v12_${randomBytes(8).toString("hex")}`;
  primarySchema = `tibotattle_${randomBytes(5).toString("hex")}`;
  ledgerSchema = `tibotattle_ledger_${randomBytes(5).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${database}"`);
  pool = new pg.Pool({ ...options, database, max: 3 });
  await pool.query(`CREATE SCHEMA "${primarySchema}"`);
  await pool.query(`CREATE SCHEMA "${ledgerSchema}"`);
  await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool });
  await applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool });
  await seedAuthority();
  authority = createPostgresTelemetryAuthorityBackend(pool, { primarySchema, ledgerSchema });
  await authority.transport.upsertConsent({
    schemaVersion: "telemetry-contribution-v1.2",
    fieldDictionaryVersion: "telemetry-v1.2-registry-2026-09-20.1",
    privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.2",
    principal: { participantId, deviceId }, sessionId, now,
  });
  backend = createPostgresTelemetryV12Backend(pool, { primarySchema, ledgerSchema });
});

afterAll(async () => {
  await pool?.end();
  if (database) await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin?.end();
});

it("runs v1.2 manifest, exact lease chunk, journal, ready vector, and domain activation", async () => {
  const principal = { participantId, deviceId };
  const prepared = preparedDay();
  await expect(backend.registerDayManifest(principal, prepared.manifest)).resolves.toMatchObject({
    day, state: "staged", expectedChunks: 1,
  });
  const envelopeDigest = digest("v12-envelope-1");
  const upload = await claimUpload("v12-upload-1", envelopeDigest);
  const metadata = {
    chunkRowId: `chunk:${randomBytes(16).toString("hex")}`,
    objectKey: "telemetry/v12/transport-1",
    envelopeDigest,
    deviceUploadAuthorizationId: upload.id,
    uploadAuthorizationLeaseExpiresAt: upload.lease,
  };
  await expect(backend.persistChunk(principal, prepared.chunk, metadata)).resolves.toMatchObject({ replay: false });
  await expect(backend.persistChunk(principal, prepared.chunk, metadata)).resolves.toMatchObject({ replay: true });
  const candidates = await backend.readDayCandidates(principal, { fromDay: day, toDay: day });
  expect(candidates).toMatchObject({ bounded: false, candidates: [{ day, state: "ready", expectedChunks: 1 }] });
  const manifestId = candidates.candidates[0].manifestId;
  await expect(backend.readDayChunkVector(principal, manifestId)).resolves.toMatchObject([
    { chunkId: prepared.chunk.chunkId, chunkDigest: prepared.chunk.chunkDigest, recordCount: 1 },
  ]);
  await expect(backend.loadReadyDayVector(principal, [{
    day, manifestId, manifestDigest: prepared.manifest.manifestDigest,
  }])).resolves.toHaveLength(1);
  const predecessor = await backend.createDomainPredecessor(principal);
  const predecessorRow = (await pool.query(`SELECT token_hash, previous_generation_id, legacy_fingerprint, input_revision, expires_at
    FROM "${primarySchema}".telemetry_v12_domain_predecessors WHERE participant_id=$1`, [participantId])).rows[0];
  expect(predecessorRow).toMatchObject({
    token_hash: digest(predecessor.token),
    previous_generation_id: predecessor.previousGenerationId,
    legacy_fingerprint: predecessor.legacyFingerprint,
    input_revision: 1,
  });
  const domain = {
    schemaVersion: "telemetry-domain-manifest-v1.2",
    fromDay: day,
    throughDay: day,
    predecessor: {
      token: predecessor.token,
      previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint,
    },
    days: [{ day, manifestId, manifestDigest: prepared.manifest.manifestDigest }],
    manifestDigest: "0".repeat(64),
  };
  domain.manifestDigest = digest(telemetryV12DomainManifestDigestInput(domain));
  const matchingPredecessor = await pool.query(`SELECT count(*)::int AS count
    FROM "${primarySchema}".telemetry_v12_domain_predecessors
    WHERE token_hash=$1 AND participant_id=$2 AND device_id=$3
      AND consumed_at IS NULL AND expires_at > clock_timestamp()
      AND previous_generation_id IS NOT DISTINCT FROM $4
      AND legacy_fingerprint=$5`,
  [digest(predecessor.token), participantId, deviceId, predecessor.previousGenerationId, predecessor.legacyFingerprint]);
  expect(matchingPredecessor.rows[0].count).toBe(1);
  await expect(backend.activateDomain(principal, domain)).resolves.toMatchObject({ replay: false, fromDay: day, throughDay: day });
  await expect(backend.activateDomain(principal, domain)).resolves.toMatchObject({ replay: true });
  expect((await pool.query(`SELECT state, consumed_contribution_id FROM "${primarySchema}".device_upload_authorizations WHERE id=$1`, [upload.id])).rows[0])
    .toMatchObject({ state: "consumed", consumed_contribution_id: metadata.chunkRowId });
  expect((await pool.query(`SELECT contribution_id, object_key FROM "${primarySchema}".pending_objects WHERE contribution_id=$1`, [metadata.chunkRowId])).rows)
    .toEqual([{ contribution_id: metadata.chunkRowId, object_key: metadata.objectKey }]);
  expect((await pool.query(`SELECT revision FROM "${primarySchema}".input_versions WHERE participant_id=$1`, [participantId])).rows[0].revision)
    .toBe("2");
});

it("rejects stale consent and exact stale lease without publishing a chunk", async () => {
  const principal = { participantId, deviceId };
  const prepared = preparedDay();
  prepared.manifest.day = "2026-09-20";
  prepared.chunk.chunkId = "usage:2026-09-20:0";
  prepared.chunk.records[0].eventTime = "2026-09-20T12:05:00.000Z";
  prepared.chunk.chunkDigest = digest(canonicalTelemetryV12Json(prepared.chunk.records));
  prepared.manifest.chunks[0].chunkId = prepared.chunk.chunkId;
  prepared.manifest.chunks[0].chunkDigest = prepared.chunk.chunkDigest;
  prepared.manifest.manifestDigest = digest(telemetryV12DayManifestDigestInput(prepared.manifest));
  prepared.chunk.manifestDigest = prepared.manifest.manifestDigest;
  await pool.query(`DELETE FROM "${primarySchema}".telemetry_v12_device_capabilities WHERE participant_id=$1 AND device_id=$2`, [participantId, deviceId]);
  await expect(backend.registerDayManifest(principal, prepared.manifest)).rejects.toMatchObject({ code: "TELEMETRY_CONSENT_INVALID" });
  await authority.transport.upsertConsent({
    schemaVersion: "telemetry-contribution-v1.2",
    fieldDictionaryVersion: "telemetry-v1.2-registry-2026-09-20.1",
    privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.2",
    principal, sessionId, now,
  });
  await pool.query(`UPDATE "${primarySchema}".telemetry_transport_formats
    SET lifecycle='staged' WHERE schema_version='telemetry-contribution-v1.2'`);
  const staged = preparedDay();
  staged.manifest.day = "2026-09-19";
  staged.chunk.chunkId = "usage:2026-09-19:0";
  staged.chunk.records[0].eventTime = "2026-09-19T12:05:00.000Z";
  staged.chunk.chunkDigest = digest(canonicalTelemetryV12Json(staged.chunk.records));
  staged.manifest.chunks[0].chunkId = staged.chunk.chunkId;
  staged.manifest.chunks[0].chunkDigest = staged.chunk.chunkDigest;
  staged.manifest.manifestDigest = digest(telemetryV12DayManifestDigestInput(staged.manifest));
  staged.chunk.manifestDigest = staged.manifest.manifestDigest;
  await expect(backend.registerDayManifest(principal, staged.manifest)).rejects.toMatchObject({ code: "TELEMETRY_TRANSPORT_BLOCKED" });
  await pool.query(`UPDATE "${primarySchema}".telemetry_transport_formats
    SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.2'`);
  await backend.registerDayManifest(principal, prepared.manifest);
  const envelopeDigest = digest("v12-envelope-stale");
  const upload = await claimUpload("v12-upload-stale", envelopeDigest);
  const metadata = {
    chunkRowId: `chunk:${randomBytes(16).toString("hex")}`,
    objectKey: "telemetry/v12/stale",
    envelopeDigest,
    deviceUploadAuthorizationId: upload.id,
    uploadAuthorizationLeaseExpiresAt: new Date(Date.parse(upload.lease) - 1).toISOString(),
  };
  await expect(backend.persistChunk(principal, prepared.chunk, metadata)).rejects.toMatchObject({ code: "UPLOAD_AUTH_INVALID" });
  expect((await pool.query(`SELECT count(*)::int AS count FROM "${primarySchema}".telemetry_v12_chunks WHERE id=$1`, [metadata.chunkRowId])).rows[0].count).toBe(0);
  expect((await pool.query(`SELECT count(*)::int AS count FROM "${primarySchema}".pending_objects WHERE contribution_id=$1`, [metadata.chunkRowId])).rows[0].count).toBe(0);
  expect((await pool.query(`SELECT state FROM "${primarySchema}".device_upload_authorizations WHERE id=$1`, [upload.id])).rows[0].state).toBe("consuming");
});

it("rejects a missing or substituted day against a two-day predecessor snapshot", async () => {
  const principal = { participantId, deviceId };
  const second = preparedDayFor("2026-09-22");
  await backend.registerDayManifest(principal, second.manifest);
  const secondUpload = await claimUpload("v12-upload-partial-second-day", digest("v12-envelope-partial-second-day"));
  await expect(backend.persistChunk(principal, second.chunk, {
    chunkRowId: `chunk:${randomBytes(16).toString("hex")}`,
    objectKey: "telemetry/v12/partial-second-day",
    envelopeDigest: digest("v12-envelope-partial-second-day"),
    deviceUploadAuthorizationId: secondUpload.id,
    uploadAuthorizationLeaseExpiresAt: secondUpload.lease,
  })).resolves.toMatchObject({ replay: false });
  const candidates = (await backend.readDayCandidates(principal, { fromDay: day, toDay: "2026-09-22" })).candidates;
  expect(candidates.map((candidate) => candidate.day)).toEqual([day, "2026-09-22"]);
  const predecessor = await backend.createDomainPredecessor(principal);
  const missingDay = domainFor(predecessor, [
    { day, manifestId: candidates[0].manifestId, manifestDigest: candidates[0].manifestDigest },
  ], day);
  await expect(backend.activateDomain(principal, missingDay)).rejects.toMatchObject({ code: "TELEMETRY_MANIFEST_CONFLICT" });
  const substituted = domainFor(predecessor, [
    { day, manifestId: candidates[0].manifestId, manifestDigest: candidates[0].manifestDigest },
    { day: "2026-09-22", manifestId: candidates[1].manifestId, manifestDigest: "1".repeat(64) },
  ], day, "2026-09-22");
  await expect(backend.activateDomain(principal, substituted)).rejects.toMatchObject({ code: "TELEMETRY_MANIFEST_CONFLICT" });
  expect((await pool.query(`SELECT count(*)::int AS count FROM "${primarySchema}".telemetry_v12_domains
    WHERE participant_id=$1`, [participantId])).rows[0].count).toBe(1);
});

it("enforces the established 2,000-chunk steady-state device window", async () => {
  const principal = { participantId, deviceId };
  const oldIssuedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
  await pool.query(`UPDATE "${primarySchema}".device_credentials SET issued_at=$1 WHERE id=$2`, [oldIssuedAt, deviceId]);
  const prepared = preparedDay();
  prepared.manifest.day = "2026-09-18";
  prepared.chunk.chunkId = "usage:2026-09-18:0";
  prepared.chunk.records[0].eventTime = "2026-09-18T12:05:00.000Z";
  prepared.chunk.chunkDigest = digest(canonicalTelemetryV12Json(prepared.chunk.records));
  prepared.manifest.chunks[0].chunkId = prepared.chunk.chunkId;
  prepared.manifest.chunks[0].chunkDigest = prepared.chunk.chunkDigest;
  prepared.manifest.manifestDigest = digest(telemetryV12DayManifestDigestInput(prepared.manifest));
  prepared.chunk.manifestDigest = prepared.manifest.manifestDigest;
  await backend.registerDayManifest(principal, prepared.manifest);
  const envelopeDigest = digest("v12-envelope-admission");
  const upload = await claimUpload("v12-upload-admission", envelopeDigest);
  const metadata = {
    chunkRowId: `chunk:${randomBytes(16).toString("hex")}`,
    objectKey: "telemetry/v12/admission",
    envelopeDigest,
    deviceUploadAuthorizationId: upload.id,
    uploadAuthorizationLeaseExpiresAt: upload.lease,
  };
  const createdAt = new Date().toISOString();
  await pool.query(`INSERT INTO "${primarySchema}".telemetry_v1_chunk_admission_windows
    (participant_id, device_id, window_day, accepted_count, last_accepted_at)
    VALUES ($1,$2,$3::date,2000,$4)
    ON CONFLICT (participant_id, device_id, window_day)
    DO UPDATE SET accepted_count=2000,last_accepted_at=EXCLUDED.last_accepted_at`,
  [participantId, deviceId, createdAt.slice(0, 10), createdAt]);
  await expect(backend.persistChunk(principal, prepared.chunk, metadata, Date.parse(createdAt)))
    .rejects.toMatchObject({ code: "CHUNK_ADMISSION_LIMIT_REACHED" });
  expect((await pool.query(`SELECT count(*)::int AS count FROM "${primarySchema}".telemetry_v12_chunks WHERE id=$1`, [metadata.chunkRowId])).rows[0].count).toBe(0);
  expect((await pool.query(`SELECT count(*)::int AS count FROM "${primarySchema}".pending_objects WHERE contribution_id=$1`, [metadata.chunkRowId])).rows[0].count).toBe(0);
  expect((await pool.query(`SELECT state FROM "${primarySchema}".device_upload_authorizations WHERE id=$1`, [upload.id])).rows[0].state).toBe("consuming");
});

it("keeps the fresh 20,000 admission window scoped to a second device", async () => {
  await seedSecondDevice();
  const principal = { participantId, deviceId: secondDeviceId };
  const prepared = preparedDayFor("2026-09-23");
  await backend.registerDayManifest(principal, prepared.manifest);
  const envelopeDigest = digest("v12-envelope-fresh-device");
  const upload = await claimUpload("v12-upload-fresh-device", envelopeDigest, secondDeviceId);
  const metadata = {
    chunkRowId: `chunk:${randomBytes(16).toString("hex")}`,
    objectKey: "telemetry/v12/fresh-device",
    envelopeDigest,
    deviceUploadAuthorizationId: upload.id,
    uploadAuthorizationLeaseExpiresAt: upload.lease,
  };
  const createdAt = new Date().toISOString();
  await pool.query(`INSERT INTO "${primarySchema}".telemetry_v1_chunk_admission_windows
    (participant_id, device_id, window_day, accepted_count, last_accepted_at)
    VALUES ($1,$2,$3::date,19999,$4)
    ON CONFLICT (participant_id, device_id, window_day)
    DO UPDATE SET accepted_count=19999,last_accepted_at=EXCLUDED.last_accepted_at`,
  [participantId, secondDeviceId, createdAt.slice(0, 10), createdAt]);
  await expect(backend.persistChunk(principal, prepared.chunk, metadata, Date.parse(createdAt)))
    .resolves.toMatchObject({ replay: false });
  expect((await pool.query(`SELECT accepted_count FROM "${primarySchema}".telemetry_v1_chunk_admission_windows
    WHERE participant_id=$1 AND device_id=$2 AND window_day=$3::date`, [participantId, secondDeviceId, createdAt.slice(0, 10)])).rows[0].accepted_count)
    .toBe(20000);
  expect((await pool.query(`SELECT accepted_count FROM "${primarySchema}".telemetry_v1_chunk_admission_windows
    WHERE participant_id=$1 AND device_id=$2 AND window_day=$3::date`, [participantId, deviceId, createdAt.slice(0, 10)])).rows[0].accepted_count)
    .toBe(2000);
});

it("rechecks predecessor expiry after a blocking activation lock", async () => {
  const principal = { participantId, deviceId };
  const candidates = (await backend.readDayCandidates(principal, { fromDay: day, toDay: "2026-09-22" })).candidates;
  const predecessor = await backend.createDomainPredecessor(principal);
  const domain = domainFor(predecessor, candidates.map((candidate) => ({
    day: candidate.day, manifestId: candidate.manifestId, manifestDigest: candidate.manifestDigest,
  })), day, "2026-09-22");
  const expiresSoon = new Date(Date.now() + 1_500).toISOString();
  await pool.query(`UPDATE "${primarySchema}".telemetry_v12_domain_predecessors SET expires_at=$1 WHERE token_hash=$2`,
    [expiresSoon, digest(predecessor.token)]);
  const blocker = await pool.connect();
  let activation;
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT token_hash FROM "${primarySchema}".telemetry_v12_domain_predecessors
      WHERE token_hash=$1 FOR UPDATE`, [digest(predecessor.token)]);
    activation = backend.activateDomain(principal, domain);
    await waitForLockWait("telemetry_v12_domain_predecessors");
    await sleep(1_650);
    await blocker.query("COMMIT");
    await expect(activation).rejects.toMatchObject({ code: "TELEMETRY_MANIFEST_CONFLICT" });
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    blocker.release();
  }
  expect((await pool.query(`SELECT count(*)::int AS count FROM "${primarySchema}".telemetry_v12_domains
    WHERE participant_id=$1 AND manifest_digest=$2`, [participantId, domain.manifestDigest])).rows[0].count).toBe(0);
});
