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

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForLockWait(tableName) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await pool.query(`
      SELECT 1 FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
         AND state = 'active'
         AND wait_event_type = 'Lock'
         AND query LIKE $1
       LIMIT 1`, [`%${tableName}%`]);
    if (result.rows.length === 1) return;
    await sleep(50);
  }
  throw new Error(`did not observe PostgreSQL lock wait for ${tableName}`);
}

async function runLockExpiryCase(index, selectedDay, tableName, lockSql, seedPending) {
  const principal = { participantId, deviceId };
  const prepared = makeChunk(index, selectedDay);
  const manifest = await backend.registerDayManifest(principal, prepared.manifest);
  const envelopeDigest = digest(`v11-envelope-lock-expiry-${index}`);
  const upload = await claimUpload(index, envelopeDigest);
  // Replace the claimed lease in the same form the writer receives from the
  // authority. The test must fence the replacement lease, not the old claim.
  const replacementLease = new Date(Date.now() + 1_500).toISOString();
  await pool.query(`UPDATE "${primarySchema}".device_upload_authorizations
    SET consume_lease_expires_at=$1 WHERE id=$2`, [replacementLease, upload.id]);
  const metadata = {
    chunkRowId: `chunk:${randomBytes(16).toString("hex")}`,
    objectKey: `telemetry/v11/lock-expiry-${index}`,
    envelopeDigest,
    deviceUploadAuthorizationId: upload.id,
    uploadAuthorizationLeaseExpiresAt: replacementLease,
  };
  if (seedPending) {
    await pool.query(`INSERT INTO "${primarySchema}".pending_objects(contribution_id, object_key)
      VALUES ($1,$2)`, [metadata.chunkRowId, metadata.objectKey]);
  }

  const blocker = await pool.connect();
  let blocked;
  try {
    await blocker.query("BEGIN");
    await blocker.query(typeof lockSql === "function" ? lockSql({ metadata, manifest, upload }) : lockSql);
    blocked = backend.persistChunk(principal, prepared.chunk, metadata);
    await waitForLockWait(tableName);
    const leaseState = await pool.query(`SELECT consume_lease_expires_at > clock_timestamp() AS future
      FROM "${primarySchema}".device_upload_authorizations WHERE id=$1`, [upload.id]);
    expect(leaseState.rows[0]?.future).toBe(true);
    await sleep(1_700);
    await blocker.query("COMMIT");
    await expect(blocked).rejects.toMatchObject({ code: "UPLOAD_AUTH_INVALID" });
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    blocker.release();
  }
  expect((await pool.query(`SELECT count(*)::int AS n FROM "${primarySchema}".telemetry_v11_chunks WHERE id=$1`, [metadata.chunkRowId])).rows[0].n).toBe(0);
  expect((await pool.query(`SELECT count(*)::int AS n FROM "${primarySchema}".pending_objects WHERE contribution_id=$1`, [metadata.chunkRowId])).rows[0].n)
    .toBe(seedPending ? 1 : 0);
  expect((await pool.query(`SELECT state FROM "${primarySchema}".device_upload_authorizations WHERE id=$1`, [upload.id])).rows[0].state)
    .toBe("consuming");
  return { manifest, metadata };
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

it("replays an exact chunk without creating a fresh journal or admission row", async () => {
  const principal = { participantId, deviceId };
  const prepared = makeChunk(1);
  const before = (await pool.query(`SELECT accepted_count FROM "${primarySchema}".telemetry_v1_chunk_admission_windows
    WHERE participant_id=$1 AND device_id=$2 AND window_day=clock_timestamp()::date`, [participantId, deviceId])).rows[0]?.accepted_count;
  const envelopeDigest = digest("v11-envelope-fresh-replay");
  const upload = await claimUpload(9, envelopeDigest);
  const metadata = {
    chunkRowId: `chunk:${randomBytes(16).toString("hex")}`,
    objectKey: "telemetry/v11/fresh-replay",
    envelopeDigest,
    deviceUploadAuthorizationId: upload.id,
    uploadAuthorizationLeaseExpiresAt: upload.lease,
  };
  await expect(backend.persistChunk(principal, prepared.chunk, metadata)).resolves.toMatchObject({ replay: true });
  expect((await pool.query(`SELECT count(*)::int AS n FROM "${primarySchema}".pending_objects WHERE contribution_id=$1`, [metadata.chunkRowId])).rows[0].n).toBe(0);
  expect((await pool.query(`SELECT accepted_count FROM "${primarySchema}".telemetry_v1_chunk_admission_windows
    WHERE participant_id=$1 AND device_id=$2 AND window_day=clock_timestamp()::date`, [participantId, deviceId])).rows[0]?.accepted_count)
    .toBe(before);
  expect((await pool.query(`SELECT state FROM "${primarySchema}".device_upload_authorizations WHERE id=$1`, [upload.id])).rows[0].state)
    .toBe("consuming");
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

it("rechecks the exact replacement lease after a manifest lock wait", async () => {
  await runLockExpiryCase(
    4,
    "2026-09-18",
    "telemetry_v11_day_manifests",
    `SELECT id FROM "${primarySchema}".telemetry_v11_day_manifests
      WHERE chunk_day='2026-09-18'::date FOR UPDATE`,
    false,
  );
});

it("rechecks the exact replacement lease after an upload-row lock wait", async () => {
  const uploadId = `v11-transport-upload-5`;
  await runLockExpiryCase(
    5,
    "2026-09-17",
    "device_upload_authorizations",
    `SELECT id FROM "${primarySchema}".device_upload_authorizations WHERE id='${uploadId}' FOR UPDATE`,
    false,
  );
});

it("rechecks the exact replacement lease after a pending-journal lock wait", async () => {
  await runLockExpiryCase(
    6,
    "2026-09-16",
    "pending_objects",
    ({ metadata }) => `SELECT contribution_id FROM "${primarySchema}".pending_objects
      WHERE contribution_id='${metadata.chunkRowId}' FOR UPDATE`,
    true,
  );
});

it("applies the device floor and bounded manifest admission before publication", async () => {
  const principal = { participantId, deviceId };
  const floorDay = "2026-09-14";
  const floorChunk = makeChunk(7, floorDay);
  await pool.query(`INSERT INTO "${primarySchema}".telemetry_transport_device_floors
    (participant_id, device_id, minimum_rank, revision, changed_at)
    VALUES ($1,$2,12,1,clock_timestamp())`, [participantId, deviceId]);
  await expect(backend.registerDayManifest(principal, floorChunk.manifest)).rejects
    .toMatchObject({ code: "TELEMETRY_TRANSPORT_BLOCKED" });
  await pool.query(`DELETE FROM "${primarySchema}".telemetry_transport_device_floors
    WHERE participant_id=$1 AND device_id=$2`, [participantId, deviceId]);

  await pool.query(`INSERT INTO "${primarySchema}".telemetry_v11_day_manifests
    (id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
     manifest_json, expected_chunk_count, state, created_at, ready_at)
    SELECT '00000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'),
           $1, $2, $3::date, lpad(to_hex(g), 64, '0'), 'admission-fixture',
           '{"chunks":[]}', 0, 'ready', $4::timestamptz, $4::timestamptz
      FROM generate_series(1,8192) AS sequence(g)`,
  [participantId, deviceId, floorDay, `${floorDay}T10:00:00.000Z`]);
  await expect(backend.registerDayManifest(
    principal,
    floorChunk.manifest,
    Date.parse(`${floorDay}T12:00:00.000Z`),
  )).rejects.toMatchObject({ code: "CHUNK_ADMISSION_LIMIT_REACHED" });
  expect((await pool.query(`SELECT count(*)::int AS n FROM "${primarySchema}".telemetry_v11_day_manifests
    WHERE parser_version='admission-fixture'`)).rows[0].n).toBe(8192);
});

it("applies the shared chunk admission window atomically before publication", async () => {
  const principal = { participantId, deviceId };
  const prepared = makeChunk(8, "2026-09-13");
  await backend.registerDayManifest(principal, prepared.manifest);
  const envelopeDigest = digest("v11-envelope-admission-limit");
  const upload = await claimUpload(8, envelopeDigest);
  const createdAt = new Date().toISOString();
  const createdDay = createdAt.slice(0, 10);
  await pool.query(`INSERT INTO "${primarySchema}".telemetry_v1_chunk_admission_windows
    (participant_id, device_id, window_day, accepted_count, last_accepted_at)
    VALUES ($1,$2,$3::date,20000,$4)
    ON CONFLICT (participant_id, device_id, window_day)
    DO UPDATE SET accepted_count=20000,last_accepted_at=EXCLUDED.last_accepted_at`,
  [participantId, deviceId, createdDay, createdAt]);
  const metadata = {
    chunkRowId: `chunk:${randomBytes(16).toString("hex")}`,
    objectKey: "telemetry/v11/admission-limit",
    envelopeDigest,
    deviceUploadAuthorizationId: upload.id,
    uploadAuthorizationLeaseExpiresAt: upload.lease,
  };
  await expect(backend.persistChunk(
    principal,
    prepared.chunk,
    metadata,
    Date.parse(createdAt),
  )).rejects.toMatchObject({ code: "CHUNK_ADMISSION_LIMIT_REACHED" });
  expect((await pool.query(`SELECT count(*)::int AS n FROM "${primarySchema}".telemetry_v11_chunks WHERE id=$1`, [metadata.chunkRowId])).rows[0].n).toBe(0);
  expect((await pool.query(`SELECT count(*)::int AS n FROM "${primarySchema}".pending_objects WHERE contribution_id=$1`, [metadata.chunkRowId])).rows[0].n).toBe(0);
  expect((await pool.query(`SELECT state FROM "${primarySchema}".device_upload_authorizations WHERE id=$1`, [upload.id])).rows[0].state)
    .toBe("consuming");
});
