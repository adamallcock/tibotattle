import {
  canonicalTelemetryV12Json,
  parseTelemetryV12Chunk,
  parseTelemetryV12ChunkId,
  parseTelemetryV12DayManifest,
  parseTelemetryV12DomainManifest,
  telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput,
  telemetryV12RecordAnchor,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  type TelemetryV12Chunk,
  type TelemetryV12DayManifest,
} from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import {
  assertTelemetryV12WriteAllowed,
  type TelemetryTransportPrincipal,
} from "./telemetry-transport-policy";
import type {
  TelemetryV12DayCandidate,
  TelemetryV12DomainActivation,
  TelemetryV12DomainPredecessor,
  TelemetryV12ReadyDayReference,
  TelemetryV12StagedChunkRow,
} from "./telemetry-v12-backend";

const MAX_DOMAIN_DAYS = 4_096;
const MAX_VECTOR = 4_096;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DOMAIN_METHOD = "v12-complete-domain-1";
const DOMAIN_TTL_MS = 24 * 60 * 60 * 1_000;

function text(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function validDay(value: unknown): string {
  if (typeof value !== "string" || !DAY.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  }
  return value;
}

function nowIso(epoch = Date.now()): string {
  const value = new Date(epoch);
  if (!Number.isFinite(value.getTime())) throw new ApiError(400, "CHUNK_INVALID");
  return value.toISOString();
}

function principalSnapshot(value: TelemetryTransportPrincipal): TelemetryTransportPrincipal {
  return Object.freeze({ participantId: value.participantId, deviceId: value.deviceId });
}

function metadataSnapshot(value: {
  chunkRowId: string; objectKey: string; envelopeDigest: string;
  deviceUploadAuthorizationId: string; uploadAuthorizationLeaseExpiresAt: string;
}) {
  const result = Object.freeze({ ...value });
  if (!result.chunkRowId || !result.objectKey || !DIGEST.test(result.envelopeDigest)
      || !result.deviceUploadAuthorizationId || !Number.isFinite(Date.parse(result.uploadAuthorizationLeaseExpiresAt))
      || new Date(result.uploadAuthorizationLeaseExpiresAt).toISOString() !== result.uploadAuthorizationLeaseExpiresAt) {
    throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  }
  return result;
}

function manifestSnapshot(value: unknown): { manifest: TelemetryV12DayManifest; canonical: string } {
  try {
    const manifest = JSON.parse(canonicalTelemetryV12Json(parseTelemetryV12DayManifest(value))) as TelemetryV12DayManifest;
    return { manifest, canonical: canonicalTelemetryV12Json(manifest) };
  } catch {
    throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
  }
}

export async function validateTelemetryV12StagedChunk(value: unknown): Promise<TelemetryV12Chunk> {
  let chunk: TelemetryV12Chunk;
  try {
    chunk = JSON.parse(canonicalTelemetryV12Json(parseTelemetryV12Chunk(value))) as TelemetryV12Chunk;
  } catch {
    throw new ApiError(400, "CHUNK_INVALID");
  }
  if (await sha256Hex(canonicalTelemetryV12Json(chunk.records)) !== chunk.chunkDigest) {
    throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
  }
  return chunk;
}

interface ManifestRow {
  id: string; chunk_day: string; manifest_digest: string;
  expected_chunk_count: number; state: "staged" | "ready"; manifest_json: string;
}

function summary(row: ManifestRow): TelemetryV12DayCandidate {
  return {
    manifestId: text(row.id), day: validDay(row.chunk_day), manifestDigest: text(row.manifest_digest),
    state: row.state, expectedChunks: row.expected_chunk_count,
  };
}

async function manifestByDigest(
  db: D1Database, principal: TelemetryTransportPrincipal, day: string, digest: string,
): Promise<ManifestRow | null> {
  return db.prepare(`SELECT id, chunk_day, manifest_digest, expected_chunk_count, state, manifest_json
    FROM telemetry_v12_day_manifests
    WHERE participant_id=? AND device_id=? AND chunk_day=? AND manifest_digest=?`)
    .bind(principal.participantId, principal.deviceId, day, digest).first<ManifestRow>();
}

export async function registerTelemetryV12DayManifest(
  db: D1Database, principal: TelemetryTransportPrincipal, value: unknown, nowEpoch = Date.now(),
): Promise<TelemetryV12DayCandidate> {
  const captured = principalSnapshot(principal);
  const { manifest, canonical } = manifestSnapshot(value);
  if (await sha256Hex(telemetryV12DayManifestDigestInput(manifest)) !== manifest.manifestDigest) {
    throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
  }
  await assertTelemetryV12WriteAllowed(db, captured);
  const existing = await manifestByDigest(db, captured, manifest.day, manifest.manifestDigest);
  if (existing) {
    if (existing.manifest_json !== canonical) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
    return summary(existing);
  }
  const id = crypto.randomUUID();
  const now = nowIso(nowEpoch);
  try {
    await db.prepare(`INSERT INTO telemetry_v12_day_manifests (
      id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
      manifest_json, expected_chunk_count, state, created_at, ready_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, NULL)
    ON CONFLICT(participant_id, device_id, chunk_day, manifest_digest) DO NOTHING`)
      .bind(id, captured.participantId, captured.deviceId, manifest.day, manifest.manifestDigest,
        manifest.parserVersion, canonical, manifest.chunks.length, now).run();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  const stored = await manifestByDigest(db, captured, manifest.day, manifest.manifestDigest);
  if (!stored || stored.manifest_json !== canonical) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  if (manifest.chunks.length === 0) {
    await db.prepare(`UPDATE telemetry_v12_day_manifests SET state='ready', ready_at=?
      WHERE id=? AND state='staged'`).bind(now, stored.id).run();
    return summary({ ...stored, state: "ready" });
  }
  return summary(stored);
}

export async function existingTelemetryV12StagedChunk(
  db: D1Database, principal: TelemetryTransportPrincipal, chunk: TelemetryV12Chunk,
): Promise<TelemetryV12StagedChunkRow | null> {
  const { day } = parseTelemetryV12ChunkId(chunk.chunkId);
  const row = await db.prepare(`SELECT c.id, c.manifest_id, c.participant_id, c.device_id,
      c.chunk_id, c.chunk_digest, c.record_count, c.r2_key, c.created_at
    FROM telemetry_v12_chunks c JOIN telemetry_v12_day_manifests m ON m.id=c.manifest_id
    WHERE m.participant_id=? AND m.device_id=? AND m.chunk_day=?
      AND m.manifest_digest=? AND c.chunk_id=?`)
    .bind(principal.participantId, principal.deviceId, day, chunk.manifestDigest, chunk.chunkId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: text(row.id), manifestId: text(row.manifest_id), participantId: text(row.participant_id),
    deviceId: text(row.device_id), chunkId: text(row.chunk_id), chunkDigest: text(row.chunk_digest),
    recordCount: Number(row.record_count), objectKey: text(row.r2_key), createdAt: text(row.created_at),
  };
}

function expectedChunk(manifest: TelemetryV12DayManifest, chunk: TelemetryV12Chunk): boolean {
  return manifest.chunks.some((item) => item.chunkId === chunk.chunkId
    && item.chunkDigest === chunk.chunkDigest && item.recordCount === chunk.records.length);
}

export async function persistTelemetryV12StagedChunk(
  db: D1Database,
  principal: TelemetryTransportPrincipal,
  value: unknown,
  metadata: {
    chunkRowId: string; objectKey: string; envelopeDigest: string;
    deviceUploadAuthorizationId: string; uploadAuthorizationLeaseExpiresAt: string;
  },
  nowEpoch = Date.now(),
): Promise<{ contributionId: string; manifestId: string; chunkId: string; replay: boolean }> {
  const captured = principalSnapshot(principal);
  const meta = metadataSnapshot(metadata);
  const chunk = await validateTelemetryV12StagedChunk(value);
  const { stream, day, seq } = parseTelemetryV12ChunkId(chunk.chunkId);
  await assertTelemetryV12WriteAllowed(db, captured);
  const manifest = await manifestByDigest(db, captured, day, chunk.manifestDigest);
  if (!manifest) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  if (!expectedChunk(JSON.parse(manifest.manifest_json) as TelemetryV12DayManifest, chunk)) {
    throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  }
  const existing = await existingTelemetryV12StagedChunk(db, captured, chunk);
  if (existing) {
    if (existing.chunkDigest !== chunk.chunkDigest || existing.recordCount !== chunk.records.length) {
      throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
    }
    return { contributionId: existing.id, manifestId: existing.manifestId, chunkId: chunk.chunkId, replay: true };
  }
  if (manifest.state !== "staged") throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  const now = nowIso(nowEpoch);
  const statements = [
    db.prepare(`UPDATE device_upload_authorizations
       SET consumed_contribution_id=?
       WHERE id=? AND participant_id=? AND issued_by_device_id=? AND state='consuming'
         AND envelope_digest=? AND consume_lease_expires_at=?
         AND consumed_contribution_id IS NULL
         AND consume_lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
         AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .bind(meta.chunkRowId, meta.deviceUploadAuthorizationId, captured.participantId, captured.deviceId,
        meta.envelopeDigest, meta.uploadAuthorizationLeaseExpiresAt),
    db.prepare(`INSERT INTO telemetry_v12_chunks (
      id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq, chunk_id,
      chunk_digest, envelope_digest, parser_version, record_count, r2_key,
      device_upload_authorization_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(meta.chunkRowId, manifest.id, captured.participantId, captured.deviceId, stream, day, seq,
        chunk.chunkId, chunk.chunkDigest, meta.envelopeDigest, chunk.parserVersion, chunk.records.length,
        meta.objectKey, meta.deviceUploadAuthorizationId, now),
  ];
  for (const record of chunk.records) {
    const anchor = telemetryV12RecordAnchor(stream, record);
    statements.push(db.prepare(`INSERT INTO telemetry_v12_records (
      chunk_id, manifest_id, stream, occurrence_id, observed_at, record_json
    ) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(meta.chunkRowId, manifest.id, stream, anchor.occurrenceId, anchor.observedAt,
        canonicalTelemetryV12Json(record)));
  }
  statements.push(db.prepare(`UPDATE telemetry_v12_day_manifests SET state='ready', ready_at=?
    WHERE id=? AND state='staged'
      AND expected_chunk_count=(SELECT count(*) FROM telemetry_v12_chunks WHERE manifest_id=? )
      AND NOT EXISTS (SELECT 1 FROM telemetry_v12_chunks c WHERE c.manifest_id=?
        AND c.record_count <> (SELECT count(*) FROM telemetry_v12_records r WHERE r.chunk_id=c.id))`)
    .bind(now, manifest.id, manifest.id, manifest.id));
  statements.push(db.prepare(`UPDATE device_upload_authorizations
      SET state='consumed', consumed_at=?, consumed_contribution_id=?, consume_lease_expires_at=NULL
      WHERE id=? AND participant_id=? AND issued_by_device_id=? AND state='consuming'
        AND envelope_digest=? AND consume_lease_expires_at=?
        AND consumed_contribution_id=?
        AND consume_lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .bind(now, meta.chunkRowId, meta.deviceUploadAuthorizationId, captured.participantId, captured.deviceId,
      meta.envelopeDigest, meta.uploadAuthorizationLeaseExpiresAt, meta.chunkRowId));
  try {
    const results = await db.batch(statements);
    if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results.at(-1)?.meta.changes ?? 0) !== 1) {
      throw new ApiError(401, "UPLOAD_AUTH_INVALID");
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const replay = await existingTelemetryV12StagedChunk(db, captured, chunk);
    if (replay && replay.chunkDigest === chunk.chunkDigest && replay.recordCount === chunk.records.length) {
      return { contributionId: replay.id, manifestId: replay.manifestId, chunkId: chunk.chunkId, replay: true };
    }
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  return { contributionId: meta.chunkRowId, manifestId: manifest.id, chunkId: chunk.chunkId, replay: false };
}

export async function readTelemetryV12DayCandidates(
  db: D1Database, principal: TelemetryTransportPrincipal, options: { fromDay: string; toDay: string; limit?: number },
): Promise<{ candidates: TelemetryV12DayCandidate[]; bounded: boolean }> {
  const fromDay = validDay(options.fromDay); const toDay = validDay(options.toDay);
  const limit = options.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || fromDay > toDay) {
    throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  }
  const rows = await db.prepare(`SELECT id, chunk_day, manifest_digest, expected_chunk_count, state
    FROM telemetry_v12_day_manifests WHERE participant_id=? AND device_id=?
      AND chunk_day >= ? AND chunk_day <= ? ORDER BY chunk_day, created_at, id LIMIT ?`)
    .bind(principal.participantId, principal.deviceId, fromDay, toDay, limit + 1).all<ManifestRow>();
  return { candidates: rows.results.slice(0, limit).map(summary), bounded: rows.results.length > limit };
}

export async function readTelemetryV12DayChunkVector(
  db: D1Database, principal: TelemetryTransportPrincipal, manifestId: string,
): Promise<Array<{ chunkId: string; chunkDigest: string; recordCount: number }>> {
  if (!UUID.test(manifestId)) throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
  const rows = await db.prepare(`SELECT c.chunk_id, c.chunk_digest, c.record_count
    FROM telemetry_v12_chunks c JOIN telemetry_v12_day_manifests m ON m.id=c.manifest_id
    WHERE m.id=? AND m.participant_id=? AND m.device_id=? ORDER BY c.stream, c.chunk_seq LIMIT ?`)
    .bind(manifestId, principal.participantId, principal.deviceId, MAX_VECTOR + 1)
    .all<{ chunk_id: string; chunk_digest: string; record_count: number }>();
  if (rows.results.length > MAX_VECTOR) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return rows.results.map((row) => ({ chunkId: row.chunk_id, chunkDigest: row.chunk_digest, recordCount: row.record_count }));
}

function vectorSnapshot(vector: readonly TelemetryV12ReadyDayReference[]): TelemetryV12ReadyDayReference[] {
  if (!Array.isArray(vector) || vector.length > MAX_VECTOR) throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
  const result = vector.map((item) => ({ day: validDay(item.day), manifestId: item.manifestId, manifestDigest: item.manifestDigest }));
  if (result.some((item) => !UUID.test(item.manifestId) || !DIGEST.test(item.manifestDigest))
      || new Set(result.map((item) => item.day)).size !== result.length) throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
  return result;
}

export async function loadTelemetryV12ReadyDayVector(
  db: D1Database, principal: TelemetryTransportPrincipal, vector: readonly TelemetryV12ReadyDayReference[],
): Promise<TelemetryV12DayCandidate[]> {
  const snapshot = vectorSnapshot(vector);
  const rows: TelemetryV12DayCandidate[] = [];
  for (const item of snapshot) {
    const row = await db.prepare(`SELECT id, chunk_day, manifest_digest, expected_chunk_count, state
      FROM telemetry_v12_day_manifests WHERE id=? AND participant_id=? AND device_id=?
        AND chunk_day=? AND manifest_digest=? AND state='ready'`)
      .bind(item.manifestId, principal.participantId, principal.deviceId, item.day, item.manifestDigest)
      .first<ManifestRow>();
    if (!row) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
    const count = await db.prepare(`SELECT count(*) AS count FROM telemetry_v12_chunks WHERE manifest_id=?`)
      .bind(row.id).first<{ count: number }>();
    if (!count || Number(count.count) !== row.expected_chunk_count) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
    rows.push(summary(row));
  }
  return rows;
}

interface SourceState { input_revision: number; generation_id: string | null; manifest_digest: string | null }

function domainError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

async function sourceState(db: D1Database, participantId: string): Promise<SourceState | null> {
  return db.prepare(`SELECT v.revision AS input_revision, h.generation_id, d.manifest_digest
    FROM participants p JOIN community_analytical_input_versions v ON v.participant_id=p.id
    LEFT JOIN telemetry_v12_domain_heads h ON h.participant_id=p.id
    LEFT JOIN telemetry_v12_domains d ON d.id=h.generation_id
    WHERE p.id=? AND p.state='active'`).bind(participantId).first<SourceState>();
}

export async function createTelemetryV12DomainPredecessor(
  db: D1Database, principal: TelemetryTransportPrincipal, nowEpoch = Date.now(),
): Promise<TelemetryV12DomainPredecessor> {
  const captured = principalSnapshot(principal);
  await assertTelemetryV12WriteAllowed(db, captured);
  const state = await sourceState(db, captured.participantId);
  if (!state) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  const result = await db.prepare(`SELECT id, chunk_day, manifest_digest
    FROM telemetry_v12_day_manifests WHERE participant_id=? AND device_id=? AND state='ready'
    ORDER BY chunk_day, created_at, id LIMIT ?`).bind(captured.participantId, captured.deviceId, MAX_DOMAIN_DAYS + 1)
    .all<{ id: string; chunk_day: string; manifest_digest: string }>();
  if (result.results.length > MAX_DOMAIN_DAYS) throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  const days = new Map<string, { id: string; chunk_day: string; manifest_digest: string }>();
  for (const row of result.results) if (!days.has(row.chunk_day)) days.set(row.chunk_day, row);
  const manifests = [...days.values()].sort((a, b) => a.chunk_day.localeCompare(b.chunk_day));
  if (manifests.length === 0) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  const fromDay = manifests[0]!.chunk_day; const throughDay = manifests.at(-1)!.chunk_day;
  const legacyFingerprint = await sha256Hex(JSON.stringify({ method: DOMAIN_METHOD,
    participantId: captured.participantId, inputRevision: state.input_revision,
    previousGenerationId: state.generation_id, previousManifestDigest: state.manifest_digest, manifests }));
  const token = crypto.randomUUID(); const tokenHash = await sha256Hex(token);
  const now = nowIso(nowEpoch); const expiresAt = nowIso(nowEpoch + DOMAIN_TTL_MS);
  const daysJson = canonicalTelemetryV12Json(manifests.map((row) => ({
    day: row.chunk_day, manifestId: row.id, manifestDigest: row.manifest_digest,
  })));
  try {
    await db.batch([
      db.prepare(`DELETE FROM telemetry_v12_domain_predecessors
        WHERE participant_id=? AND device_id=? AND consumed_at IS NULL AND expires_at <= ?`)
        .bind(captured.participantId, captured.deviceId, now),
      db.prepare(`INSERT INTO telemetry_v12_domain_predecessors (
        token_hash, participant_id, device_id, previous_generation_id, legacy_fingerprint,
        input_revision, from_day, through_day, winners_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(tokenHash, captured.participantId, captured.deviceId, state.generation_id, legacyFingerprint,
          state.input_revision, fromDay, throughDay, daysJson, now, expiresAt),
    ]);
  } catch (error) { throw domainError(error); }
  return { schemaVersion: "telemetry-domain-predecessor-v1.2", token,
    previousGenerationId: state.generation_id, legacyFingerprint, fromDay, throughDay, expiresAt };
}

export async function activateTelemetryV12Domain(
  db: D1Database, principal: TelemetryTransportPrincipal, value: unknown, nowEpoch = Date.now(),
): Promise<TelemetryV12DomainActivation> {
  let manifest: any;
  try { manifest = JSON.parse(canonicalTelemetryV12Json(parseTelemetryV12DomainManifest(value))); }
  catch { throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID"); }
  if (await sha256Hex(telemetryV12DomainManifestDigestInput(manifest)) !== manifest.manifestDigest) {
    throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
  }
  const captured = principalSnapshot(principal);
  await assertTelemetryV12WriteAllowed(db, captured);
  const now = nowIso(nowEpoch);
  const tokenHash = await sha256Hex(manifest.predecessor.token);
  const predecessor = await db.prepare(`SELECT input_revision, from_day, through_day, previous_generation_id, legacy_fingerprint
    FROM telemetry_v12_domain_predecessors WHERE token_hash=? AND participant_id=? AND device_id=?
      AND consumed_at IS NULL AND expires_at > ? AND previous_generation_id IS ? AND legacy_fingerprint=?`)
    .bind(tokenHash, captured.participantId, captured.deviceId, now,
      manifest.predecessor.previousGenerationId, manifest.predecessor.legacyFingerprint)
    .first<{ input_revision: number; from_day: string; through_day: string; previous_generation_id: string | null; legacy_fingerprint: string }>();
  if (!predecessor) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  const state = await sourceState(db, captured.participantId);
  if (!state || state.input_revision !== predecessor.input_revision || state.generation_id !== predecessor.previous_generation_id) {
    throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  }
  if (manifest.fromDay > predecessor.from_day || manifest.throughDay < predecessor.through_day) {
    throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  }
  for (const day of manifest.days) {
    const row = await db.prepare(`SELECT 1 FROM telemetry_v12_day_manifests
      WHERE id=? AND participant_id=? AND device_id=? AND chunk_day=? AND manifest_digest=? AND state='ready'`)
      .bind(day.manifestId, captured.participantId, captured.deviceId, day.day, day.manifestDigest).first();
    if (!row) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  }
  const generationId = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare(`INSERT INTO telemetry_v12_domains (
        id, participant_id, device_id, predecessor_token_hash, previous_generation_id,
        manifest_digest, legacy_fingerprint, input_revision, from_day, through_day, days_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(generationId, captured.participantId, captured.deviceId, tokenHash,
          manifest.predecessor.previousGenerationId, manifest.manifestDigest,
          manifest.predecessor.legacyFingerprint, predecessor.input_revision,
          manifest.fromDay, manifest.throughDay, canonicalTelemetryV12Json(manifest.days), now),
      ...manifest.days.map((day: { day: string; manifestId: string; manifestDigest: string }) => db.prepare(
        `INSERT INTO telemetry_v12_domain_days (generation_id, observed_day, manifest_id, manifest_digest)
         VALUES (?, ?, ?, ?)`).bind(generationId, day.day, day.manifestId, day.manifestDigest)),
      db.prepare(`INSERT INTO telemetry_v12_domain_heads (participant_id, generation_id, revision, updated_at)
        VALUES (?, ?, 1, ?) ON CONFLICT(participant_id) DO UPDATE SET
          generation_id=excluded.generation_id, revision=telemetry_v12_domain_heads.revision+1,
          updated_at=excluded.updated_at`).bind(captured.participantId, generationId, now),
      db.prepare(`UPDATE telemetry_v12_domain_predecessors SET consumed_at=?
        WHERE token_hash=? AND participant_id=? AND device_id=? AND consumed_at IS NULL`)
        .bind(now, tokenHash, captured.participantId, captured.deviceId),
    ]);
  } catch (error) {
    const replay = await db.prepare(`SELECT d.id, d.manifest_digest, d.from_day, d.through_day
      FROM telemetry_v12_domain_heads h JOIN telemetry_v12_domains d ON d.id=h.generation_id
      WHERE h.participant_id=? AND d.device_id=? AND d.manifest_digest=?`)
      .bind(captured.participantId, captured.deviceId, manifest.manifestDigest).first<{id: string; manifest_digest: string; from_day: string; through_day: string}>();
    if (replay) return { schemaVersion: "telemetry-domain-activation-v1.2", generationId: replay.id,
      manifestDigest: replay.manifest_digest, fromDay: replay.from_day, throughDay: replay.through_day, replay: true };
    throw domainError(error);
  }
  return { schemaVersion: "telemetry-domain-activation-v1.2", generationId,
    manifestDigest: manifest.manifestDigest, fromDay: manifest.fromDay, throughDay: manifest.throughDay, replay: false };
}
