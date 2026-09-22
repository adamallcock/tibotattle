import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import pg from "pg";
import {
  canonicalTelemetryV11Json,
  telemetryV11DayManifestDigestInput,
  telemetryV11RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { createPostgresTelemetryAuthorityBackend } from "../src/postgres-telemetry-authority-backend.ts";
import { createPostgresTelemetryV11Backend } from "../src/postgres-telemetry-v11-backend.ts";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const hash = (value) => Buffer.alloc(32, value);
const day = "2026-09-21";
const now = new Date(Date.now()).toISOString();
const expires = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
const participantId = "v11-transport-participant";
const deviceId = "v11-transport-device";
const sessionId = "v11-transport-session";
const pairingId = "v11-transport-pairing";

let admin;
let pool;
let database;
let primarySchema;
let ledgerSchema;
let authority;
let backend;

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
    SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'`);
  const consent = telemetryV11RequiredConsent();
  await pool.query(`INSERT INTO "${primarySchema}".telemetry_v11_device_consents
    (participant_id, device_id, telemetry_schema_version, field_dictionary_version,
     privacy_contract_version, consented_at)
    VALUES ($1, $2, $3, $4, $5, $6)`,
  [participantId, deviceId, consent.telemetrySchemaVersion, consent.fieldDictionaryVersion,
    consent.privacyContractVersion, now]);
}

function usageRecord(index, selectedDay = day) {
  return {
    schemaVersion: "usage-event-v1.1",
    eventId: `event:v2:${String(index).padStart(64, "0")}`,
    eventTime: `${selectedDay}T12:05:00.000Z`,
    sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "standard",
    apiServiceTier: "default",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "high",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: 1000,
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
  };
}

function makeChunk(index, selectedDay = day) {
  const record = usageRecord(index, selectedDay);
  const chunk = {
    schemaVersion: "telemetry-contribution-v1.1",
    manifestDigest: "0".repeat(64),
    chunkId: `usage:${selectedDay}:0`,
    chunkRevision: 1,
    chunkDigest: digest(canonicalTelemetryV11Json([record])),
    parserVersion: "synthetic-v11",
    consent: telemetryV11RequiredConsent(),
    records: [record],
  };
  const manifest = {
    schemaVersion: "telemetry-day-manifest-v1.1",
    day: selectedDay,
    parserVersion: "synthetic-v11",
    consent: telemetryV11RequiredConsent(),
    chunks: [{ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: 1 }],
    excluded: { quota: 0, session: 0, usage: 0 },
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = digest(telemetryV11DayManifestDigestInput(manifest));
  chunk.manifestDigest = manifest.manifestDigest;
  return { manifest, chunk };
}

async function claimUpload(index, envelopeDigest) {
  const id = `v11-transport-upload-${index}`;
  await authority.devices.insertUpload({
    id,
    participantId,
    issuedByDeviceId: deviceId,
    secretHash: new Uint8Array(hash(20 + index)),
    envelopeDigest,
    bodyBytes: 128,
    contentType: "application/json",
    issuedAt: now,
    expiresAt: expires,
  });
  const lease = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const claimed = await authority.devices.claimUpload({
    authorizationId: id,
    participantId,
    deviceId,
    envelopeDigest,
    bodyBytes: 128,
    contentType: "application/json",
    leaseExpiresAt: lease,
    now,
  });
  expect(claimed).toBe(lease);
  return { id, lease };
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
    host: socket,
    port,
    user: "postgres",
    password: "synthetic-local-only",
    database: "postgres",
    ssl: false,
    options: "",
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 1_000,
    max: 1,
  };
  admin = new pg.Pool(options);
  database = `tibotattle_v11_${randomBytes(8).toString("hex")}`;
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
  backend = createPostgresTelemetryV11Backend(pool, { primarySchema, ledgerSchema });
});

afterAll(async () => {
  await pool?.end();
  if (database) await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin?.end();
});

it("runs manifest, chunk, journal, ready-vector and replay through PostgreSQL", async () => {
  const prepared = makeChunk(1);
  const principal = { participantId, deviceId };
  await expect(backend.registerDayManifest(principal, prepared.manifest)).resolves.toMatchObject({
    day,
    state: "staged",
    expectedChunks: 1,
  });
  const envelopeDigest = digest("v11-envelope-1");
  const upload = await claimUpload(1, envelopeDigest);
  const metadata = {
    chunkRowId: `chunk:${randomBytes(16).toString("hex")}`,
    objectKey: "telemetry/v11/transport-1",
    envelopeDigest,
    deviceUploadAuthorizationId: upload.id,
    uploadAuthorizationLeaseExpiresAt: upload.lease,
  };
  await expect(backend.persistChunk(principal, prepared.chunk, metadata)).resolves.toMatchObject({ replay: false });
  await expect(backend.persistChunk(principal, prepared.chunk, metadata)).resolves.toMatchObject({ replay: true });
  await expect(backend.readDayChunkVector(principal, (await backend.registerDayManifest(principal, prepared.manifest)).manifestId))
    .resolves.toHaveLength(1);
  const candidates = await backend.readDayCandidates(principal, { fromDay: day, toDay: day });
  expect(candidates).toMatchObject({ bounded: false, candidates: [{ day, state: "ready", expectedChunks: 1 }] });
  const ready = await backend.loadReadyDayVector(principal, [{
    day,
    manifestId: candidates.candidates[0].manifestId,
    manifestDigest: prepared.manifest.manifestDigest,
  }]);
  expect(ready).toHaveLength(1);
  expect((await pool.query(`SELECT state, consumed_contribution_id FROM "${primarySchema}".device_upload_authorizations WHERE id=$1`, [upload.id])).rows[0])
    .toMatchObject({ state: "consumed", consumed_contribution_id: metadata.chunkRowId });
  expect((await pool.query(`SELECT contribution_id, object_key FROM "${primarySchema}".pending_objects`)).rows)
    .toEqual([{ contribution_id: metadata.chunkRowId, object_key: metadata.objectKey }]);
  expect((await pool.query(`SELECT legacy_occurrence_id FROM "${primarySchema}".telemetry_v11_records`)).rows[0].legacy_occurrence_id)
    .toBeTypeOf("string");
});

it("rejects stale lease and stale consent without leaving a partial chunk or journal", async () => {
  const principal = { participantId, deviceId };
  const prepared = makeChunk(2, "2026-09-20");
  await backend.registerDayManifest(principal, prepared.manifest);
  const envelopeDigest = digest("v11-envelope-2");
  const upload = await claimUpload(2, envelopeDigest);
  const replacementLease = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  await pool.query(`UPDATE "${primarySchema}".device_upload_authorizations
    SET consume_lease_expires_at=$1 WHERE id=$2`, [replacementLease, upload.id]);
  const metadata = {
    chunkRowId: `chunk:${randomBytes(16).toString("hex")}`,
    objectKey: "telemetry/v11/stale",
    envelopeDigest,
    deviceUploadAuthorizationId: upload.id,
    uploadAuthorizationLeaseExpiresAt: upload.lease,
  };
  await expect(backend.persistChunk(principal, prepared.chunk, metadata)).rejects.toMatchObject({ code: "UPLOAD_AUTH_INVALID" });
  expect((await pool.query(`SELECT count(*)::int AS n FROM "${primarySchema}".telemetry_v11_chunks WHERE id=$1`, [metadata.chunkRowId])).rows[0].n).toBe(0);
  expect((await pool.query(`SELECT count(*)::int AS n FROM "${primarySchema}".pending_objects WHERE contribution_id=$1`, [metadata.chunkRowId])).rows[0].n).toBe(0);

  await pool.query(`DELETE FROM "${primarySchema}".telemetry_v11_device_consents WHERE participant_id=$1 AND device_id=$2`, [participantId, deviceId]);
  const denied = makeChunk(3, "2026-09-19");
  await expect(backend.registerDayManifest(principal, denied.manifest)).rejects.toMatchObject({ code: "TELEMETRY_CONSENT_INVALID" });
  const consent = telemetryV11RequiredConsent();
  await pool.query(`INSERT INTO "${primarySchema}".telemetry_v11_device_consents
    (participant_id, device_id, telemetry_schema_version, field_dictionary_version,
     privacy_contract_version, consented_at)
    VALUES ($1, $2, $3, $4, $5, clock_timestamp())`, [participantId, deviceId,
    consent.telemetrySchemaVersion, consent.fieldDictionaryVersion, consent.privacyContractVersion]);
});

it("rechecks the exact lease after a manifest lock wait", async () => {
  const principal = { participantId, deviceId };
  const prepared = makeChunk(4, "2026-09-18");
  const manifest = await backend.registerDayManifest(principal, prepared.manifest);
  const envelopeDigest = digest("v11-envelope-lock-expiry");
  const upload = await claimUpload(4, envelopeDigest);
  await pool.query(`UPDATE "${primarySchema}".device_upload_authorizations
    SET consume_lease_expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=$1`, [upload.id]);
  const blocker = await pool.connect();
  const metadata = {
    chunkRowId: `chunk:${randomBytes(16).toString("hex")}`,
    objectKey: "telemetry/v11/lock-expiry",
    envelopeDigest,
    deviceUploadAuthorizationId: upload.id,
    uploadAuthorizationLeaseExpiresAt: upload.lease,
  };
  let blocked;
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM "${primarySchema}".telemetry_v11_day_manifests WHERE id=$1 FOR UPDATE`, [manifest.manifestId]);
    blocked = backend.persistChunk(principal, prepared.chunk, metadata);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await blocker.query("COMMIT");
    await expect(blocked).rejects.toMatchObject({ code: "UPLOAD_AUTH_INVALID" });
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    blocker.release();
  }
  expect((await pool.query(`SELECT count(*)::int AS n FROM "${primarySchema}".telemetry_v11_chunks WHERE id=$1`, [metadata.chunkRowId])).rows[0].n).toBe(0);
  expect((await pool.query(`SELECT count(*)::int AS n FROM "${primarySchema}".pending_objects WHERE contribution_id=$1`, [metadata.chunkRowId])).rows[0].n).toBe(0);
});
