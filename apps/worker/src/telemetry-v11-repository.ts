import {
  canonicalTelemetryV11Json,
  parseTelemetryV11Chunk,
  parseTelemetryV11ChunkId,
  parseTelemetryV11DayManifest,
  parseTelemetryV11Record,
  telemetryV11DayManifestDigestInput,
  telemetryV11RecordAnchor,
  TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
  type TelemetryV11Chunk,
  type TelemetryV11DayManifest,
  type TelemetryV11Record,
  type TelemetryV11Stream,
  MAX_TELEMETRY_V11_DOMAIN_DAYS,
} from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import {
  assertTelemetryTransportWriteAllowed,
  type TelemetryTransportPrincipal,
} from "./telemetry-transport-policy";

export interface TelemetryV11DayCandidate {
  manifestId: string;
  day: string;
  manifestDigest: string;
  state: "staged" | "ready";
  expectedChunks: number;
}

interface ManifestRow {
  id: string; chunk_day: string; manifest_digest: string;
  expected_chunk_count: number; state: "staged" | "ready"; manifest_json: string;
}

export interface TelemetryV11StagedChunkRow {
  id: string; manifest_id: string; participant_id: string; device_id: string;
  chunk_id: string; chunk_digest: string; record_count: number;
  r2_key: string; created_at: string;
}

function summary(row: ManifestRow): TelemetryV11DayCandidate {
  return { manifestId: row.id, day: row.chunk_day, manifestDigest: row.manifest_digest,
    state: row.state, expectedChunks: row.expected_chunk_count };
}

function manifestSnapshot(value: unknown): TelemetryV11DayManifest {
  try { return JSON.parse(canonicalTelemetryV11Json(parseTelemetryV11DayManifest(value))) as TelemetryV11DayManifest; }
  catch { throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID"); }
}

export async function validateTelemetryV11StagedChunk(value: unknown): Promise<TelemetryV11Chunk> {
  let chunk: TelemetryV11Chunk;
  try { chunk = JSON.parse(canonicalTelemetryV11Json(parseTelemetryV11Chunk(value))) as TelemetryV11Chunk; }
  catch { throw new ApiError(400, "CHUNK_INVALID"); }
  if (await sha256Hex(canonicalTelemetryV11Json(chunk.records)) !== chunk.chunkDigest) {
    throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
  }
  return chunk;
}

function mapStagingError(error: unknown): ApiError {
  const message = String(error);
  if (message.includes("chunk admission window exhausted") || message.includes("telemetry_manifest_admission_exhausted")) {
    return new ApiError(429, "CHUNK_ADMISSION_LIMIT_REACHED", { responseHeaders: { "retry-after": "60" } });
  }
  if (message.includes("telemetry_transport_blocked")) return new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  if (message.includes("telemetry_manifest_incomplete")) return new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  if (message.includes("UNIQUE constraint failed: telemetry_v11_records")) {
    return new ApiError(409, "TELEMETRY_OCCURRENCE_CONFLICT");
  }
  if (message.includes("telemetry_chunk_staging_denied") || message.includes("UNIQUE constraint failed: telemetry_v11")) {
    return new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  }
  return error instanceof ApiError ? error : new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

/** Server-derived compatibility evidence, never accepted from a client field. */
export function telemetryV11LegacyProjection(stream: TelemetryV11Stream, record: TelemetryV11Record): {
  occurrenceId: string; canonicalRecord: string;
} | null {
  const copy = { ...record } as Record<string, unknown>;
  delete copy.accountPlanAttribution;
  copy.schemaVersion = stream === "usage" ? "usage-event-v1.0"
    : stream === "quota" ? "quota-observation-v1.0" : "session-dimension-v1.0";
  const anchor = telemetryV11RecordAnchor(stream, record);
  const occurrenceId = stream === "quota"
    ? `q:${Date.parse(anchor.observedAt)}:${copy.limitId}:${copy.slot}` : anchor.occurrenceId;
  if (stream === "quota" && (copy.usedPercent === null || copy.windowDurationMinutes === null
      || copy.resetsAt === null || occurrenceId.length > 128)) return null;
  if (stream === "quota") copy.observationId = occurrenceId;
  return { occurrenceId, canonicalRecord: canonicalTelemetryV11Json(copy) };
}

async function manifestByDigest(
  db: D1Database, principal: TelemetryTransportPrincipal, day: string, digest: string,
): Promise<ManifestRow | null> {
  return db.prepare(
    `SELECT id, chunk_day, manifest_digest, expected_chunk_count, state, manifest_json
       FROM telemetry_v11_day_manifests
      WHERE participant_id = ? AND device_id = ? AND chunk_day = ? AND manifest_digest = ?`,
  ).bind(principal.participantId, principal.deviceId, day, digest).first<ManifestRow>();
}

export async function registerTelemetryV11DayManifest(
  db: D1Database, principal: TelemetryTransportPrincipal, value: unknown, nowEpoch = Date.now(),
): Promise<TelemetryV11DayCandidate> {
  const manifest = manifestSnapshot(value);
  const canonical = canonicalTelemetryV11Json(manifest);
  if (await sha256Hex(telemetryV11DayManifestDigestInput(manifest)) !== manifest.manifestDigest) {
    throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
  }
  await assertTelemetryTransportWriteAllowed(db, principal, TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION);
  const existing = await manifestByDigest(db, principal, manifest.day, manifest.manifestDigest);
  if (existing) {
    if (existing.manifest_json !== canonical) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
    return summary(existing);
  }
  const id = crypto.randomUUID();
  const now = new Date(nowEpoch).toISOString();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO telemetry_v11_day_manifests (
          id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
          manifest_json, expected_chunk_count, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?)
        ON CONFLICT(participant_id, device_id, chunk_day, manifest_digest) DO NOTHING`,
      ).bind(id, principal.participantId, principal.deviceId, manifest.day, manifest.manifestDigest,
        manifest.parserVersion, canonical, manifest.chunks.length, now),
      db.prepare(
        `UPDATE telemetry_v11_day_manifests SET state = 'ready', ready_at = ?
          WHERE id = ? AND state = 'staged' AND expected_chunk_count = 0`,
      ).bind(now, id),
    ]);
  } catch (error) { throw mapStagingError(error); }
  const stored = await manifestByDigest(db, principal, manifest.day, manifest.manifestDigest);
  if (!stored || stored.manifest_json !== canonical) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  return summary(stored);
}

export async function existingTelemetryV11StagedChunk(
  db: D1Database, principal: TelemetryTransportPrincipal, chunk: TelemetryV11Chunk,
): Promise<TelemetryV11StagedChunkRow | null> {
  const { day } = parseTelemetryV11ChunkId(chunk.chunkId);
  return db.prepare(
    `SELECT c.* FROM telemetry_v11_chunks c JOIN telemetry_v11_day_manifests m ON m.id = c.manifest_id
      WHERE m.participant_id = ? AND m.device_id = ? AND m.chunk_day = ?
        AND m.manifest_digest = ? AND c.chunk_id = ?`,
  ).bind(principal.participantId, principal.deviceId, day, chunk.manifestDigest, chunk.chunkId)
    .first<TelemetryV11StagedChunkRow>();
}

export async function persistTelemetryV11StagedChunk(
  db: D1Database, principal: TelemetryTransportPrincipal, value: unknown,
  metadata: { chunkRowId: string; r2Key: string; envelopeDigest: string; deviceUploadAuthorizationId: string },
  nowEpoch = Date.now(),
): Promise<{ contributionId: string; manifestId: string; chunkId: string; replay: boolean }> {
  const chunk = await validateTelemetryV11StagedChunk(value);
  const { stream, day, seq } = parseTelemetryV11ChunkId(chunk.chunkId);
  await assertTelemetryTransportWriteAllowed(db, principal, TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION);
  const manifest = await manifestByDigest(db, principal, day, chunk.manifestDigest);
  if (!manifest) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  const existing = await existingTelemetryV11StagedChunk(db, principal, chunk);
  if (existing) {
    if (existing.chunk_digest !== chunk.chunkDigest || existing.record_count !== chunk.records.length) {
      throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
    }
    return { contributionId: existing.id, manifestId: manifest.id, chunkId: chunk.chunkId, replay: true };
  }
  const now = new Date(nowEpoch).toISOString();
  const statements = [db.prepare(
    `INSERT INTO telemetry_v11_chunks (
      id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq, chunk_id,
      chunk_digest, envelope_digest, parser_version, record_count, r2_key,
      device_upload_authorization_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(metadata.chunkRowId, manifest.id, principal.participantId, principal.deviceId, stream,
    day, seq, chunk.chunkId, chunk.chunkDigest, metadata.envelopeDigest, chunk.parserVersion,
    chunk.records.length, metadata.r2Key, metadata.deviceUploadAuthorizationId, now)];
  for (const record of chunk.records) {
    const anchor = telemetryV11RecordAnchor(stream, record);
    const legacy = telemetryV11LegacyProjection(stream, record);
    statements.push(db.prepare(
      `INSERT INTO telemetry_v11_records (
        chunk_id, manifest_id, stream, occurrence_id, observed_at, record_json,
        legacy_occurrence_id, legacy_record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(metadata.chunkRowId, manifest.id, stream, anchor.occurrenceId,
      anchor.observedAt, canonicalTelemetryV11Json(record), legacy?.occurrenceId ?? null, legacy?.canonicalRecord ?? null));
  }
  statements.push(db.prepare(
    `UPDATE telemetry_v11_day_manifests SET state = 'ready', ready_at = ?
      WHERE id = ? AND state = 'staged'
        AND expected_chunk_count = (SELECT count(*) FROM telemetry_v11_chunks WHERE manifest_id = ?)
        AND NOT EXISTS (SELECT 1 FROM telemetry_v11_chunks c WHERE c.manifest_id = ?
          AND c.record_count != (SELECT count(*) FROM telemetry_v11_records r WHERE r.chunk_id = c.id))`,
  ).bind(now, manifest.id, manifest.id, manifest.id));
  try { await db.batch(statements); }
  catch (error) {
    const replay = await existingTelemetryV11StagedChunk(db, principal, chunk);
    if (replay?.chunk_digest === chunk.chunkDigest && replay.record_count === chunk.records.length) {
      return { contributionId: replay.id, manifestId: manifest.id, chunkId: chunk.chunkId, replay: true };
    }
    throw mapStagingError(error);
  }
  return { contributionId: metadata.chunkRowId, manifestId: manifest.id, chunkId: chunk.chunkId, replay: false };
}

export async function readTelemetryV11DayCandidates(
  db: D1Database, principal: TelemetryTransportPrincipal,
  options: { fromDay: string; toDay: string; limit?: number },
): Promise<{ candidates: TelemetryV11DayCandidate[]; bounded: boolean }> {
  const limit = options.limit ?? 200;
  const start = Date.parse(`${options.fromDay}T00:00:00.000Z`);
  const end = Date.parse(`${options.toDay}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(options.fromDay) || !/^\d{4}-\d{2}-\d{2}$/u.test(options.toDay)
      || !Number.isFinite(start) || !Number.isFinite(end) || end < start
      || new Date(start).toISOString().slice(0, 10) !== options.fromDay
      || new Date(end).toISOString().slice(0, 10) !== options.toDay
      || end - start > 30 * 86_400_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  }
  const rows = await db.prepare(
    `SELECT id, chunk_day, manifest_digest, expected_chunk_count, state
       FROM telemetry_v11_day_manifests
      WHERE participant_id = ? AND device_id = ? AND chunk_day >= ? AND chunk_day <= ?
      ORDER BY chunk_day, created_at, id LIMIT ?`,
  ).bind(principal.participantId, principal.deviceId, options.fromDay, options.toDay, limit + 1).all<ManifestRow>();
  return { candidates: rows.results.slice(0, limit).map(summary), bounded: rows.results.length > limit };
}

/** Authenticated exact candidate reconciliation, not a published acknowledgement. */
export async function readTelemetryV11DayChunkVector(
  db: D1Database, principal: TelemetryTransportPrincipal, manifestId: string,
): Promise<{ chunkId: string; chunkDigest: string; recordCount: number }[]> {
  const rows = await db.prepare(
    `SELECT c.chunk_id, c.chunk_digest, c.record_count FROM telemetry_v11_chunks c
       JOIN telemetry_v11_day_manifests m ON m.id = c.manifest_id
      WHERE m.id = ? AND m.participant_id = ? AND m.device_id = ?
      ORDER BY c.stream, c.chunk_seq LIMIT 4097`,
  ).bind(manifestId, principal.participantId, principal.deviceId)
    .all<{ chunk_id: string; chunk_digest: string; record_count: number }>();
  if (rows.results.length > 4096) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return rows.results.map((row) => ({ chunkId: row.chunk_id, chunkDigest: row.chunk_digest, recordCount: row.record_count }));
}

// Root's whole-domain activation repeats this SQL predicate inside its final
// transaction, never treating a preflight load as a durable activation proof.
// All uses alias telemetry_v11_day_manifests as m. The five positional values
// are manifest id, participant id, device id, day and digest (five bindings).
export const TELEMETRY_V11_READY_DAY_PREDICATE = `
  m.id = ? AND m.participant_id = ? AND m.device_id = ? AND m.chunk_day = ?
  AND m.manifest_digest = ? AND m.state = 'ready'
  AND m.expected_chunk_count = (SELECT count(*) FROM telemetry_v11_chunks c WHERE c.manifest_id = m.id)
  AND NOT EXISTS (SELECT 1 FROM telemetry_v11_chunks c WHERE c.manifest_id = m.id
    AND c.record_count != (SELECT count(*) FROM telemetry_v11_records r WHERE r.chunk_id = c.id))
`;

export async function loadTelemetryV11ReadyDayVector(
  db: D1Database, principal: TelemetryTransportPrincipal,
  vector: readonly { day: string; manifestId: string; manifestDigest: string }[],
): Promise<TelemetryV11DayCandidate[]> {
  if (!Array.isArray(vector) || vector.length > MAX_TELEMETRY_V11_DOMAIN_DAYS
      || new Set(vector.map((day) => day.day)).size !== vector.length) {
    throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
  }
  // One bounded preflight query, not a round-trip per historical day.
  // Activation still re-proves the vector inside the common domain arbiter.
  const rows = await db.prepare(
    `SELECT m.id, m.chunk_day, m.manifest_digest, m.expected_chunk_count, m.state
       FROM json_each(?) v JOIN telemetry_v11_day_manifests m
         ON m.id = json_extract(v.value, '$.manifestId')
        AND m.chunk_day = json_extract(v.value, '$.day')
        AND m.manifest_digest = json_extract(v.value, '$.manifestDigest')
      WHERE m.participant_id = ? AND m.device_id = ? AND m.state = 'ready'
        AND m.expected_chunk_count = (SELECT count(*) FROM telemetry_v11_chunks c WHERE c.manifest_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM telemetry_v11_chunks c WHERE c.manifest_id = m.id
          AND c.record_count != (SELECT count(*) FROM telemetry_v11_records r WHERE r.chunk_id = c.id))
      ORDER BY cast(v.key AS INTEGER)`,
  ).bind(JSON.stringify(vector), principal.participantId, principal.deviceId).all<ManifestRow>();
  if (rows.results.length !== vector.length) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  return rows.results.map(summary);
}

export async function telemetryV11ChunkCount(db: D1Database, participantId: string): Promise<number> {
  return (await db.prepare("SELECT count(*) AS total FROM telemetry_v11_chunks WHERE participant_id = ?")
    .bind(participantId).first<{total: number}>())?.total ?? 0;
}

export async function telemetryV11ChunkR2KeyPage(
  db: D1Database, participantId: string,
  cursor: {createdAt: string; chunkRowId: string} | null = null, limit = 100,
): Promise<{rows: {id: string; r2Key: string; createdAt: string}[]; nextCursor: {createdAt: string; chunkRowId: string} | null}> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ApiError(500, "INTERNAL_ERROR");
  const rows = await db.prepare(
    "SELECT id, r2_key, created_at FROM telemetry_v11_chunks WHERE participant_id = ? "
      + (cursor === null ? "" : "AND (created_at, id) > (?, ?) ")
      + "ORDER BY created_at, id LIMIT ?",
  ).bind(participantId, ...(cursor === null ? [] : [cursor.createdAt, cursor.chunkRowId]), limit)
    .all<{id: string; r2_key: string; created_at: string}>();
  const last = rows.results.at(-1);
  return {
    rows: rows.results.map((row) => ({id: row.id, r2Key: row.r2_key, createdAt: row.created_at})),
    nextCursor: last && rows.results.length === limit ? {createdAt: last.created_at, chunkRowId: last.id} : null,
  };
}

/**
 * Private participant export, streamed one bounded immutable entry at a time.
 * This is an inventory, not a new analytical merge: staging/ready/active labels
 * are observed per entry. Tokens, secrets, enrollment namespaces, R2 keys,
 * upload authorizations and internal compatibility counterparts stay private.
 */
export async function* telemetryV11ExportEntries(
  db: D1Database, participantId: string, createdThrough: string,
): AsyncGenerator<object> {
  if (!participantId || !Number.isFinite(Date.parse(createdThrough))
      || new Date(createdThrough).toISOString() !== createdThrough) throw new ApiError(500, "INTERNAL_ERROR");
  type Cursor = { createdAt: string; id: string } | null;
  type DayRow = { id: string; created_at: string; manifest_json: string; state: string; active_when_read: number };
  type ChunkRow = { id: string; created_at: string; manifest_id: string; chunk_id: string; chunk_digest: string;
    parser_version: string; record_count: number; stream: TelemetryV11Stream; manifest_digest: string; active_when_read: number };
  type DomainRow = { id: string; created_at: string; previous_generation_id: string | null; manifest_digest: string;
    from_day: string; through_day: string; days_json: string; active_when_read: number };
  // Distinct first/subsequent query shapes let SQLite seek into the composite
  // cursor index rather than repeatedly filtering the participant's prefix.
  const cursorBindings = (value: Cursor) => value === null ? [] : [value.createdAt, value.id];
  const cursorPredicate = (value: Cursor, alias: "m" | "c" | "d") => value === null
    ? "" : "AND (" + alias + ".created_at, " + alias + ".id) > (?, ?) ";
  let cursor: Cursor = null;
  while (true) {
    const row: DayRow | null = await db.prepare(
      "SELECT m.id, m.created_at, m.manifest_json, m.state, "
      + "EXISTS (SELECT 1 FROM telemetry_v11_domain_heads h JOIN telemetry_v11_domain_days d "
      + "ON d.generation_id = h.generation_id "
      + "WHERE h.participant_id = m.participant_id AND d.manifest_id = m.id) AS active_when_read "
      + "FROM telemetry_v11_day_manifests m WHERE m.participant_id = ? AND m.created_at <= ? "
      + cursorPredicate(cursor, "m") + "ORDER BY m.created_at, m.id LIMIT 1",
    ).bind(participantId, createdThrough, ...cursorBindings(cursor))
      .first<DayRow>();
    if (!row) break;
    let manifest: TelemetryV11DayManifest;
    try { manifest = parseTelemetryV11DayManifest(JSON.parse(row.manifest_json)); }
    catch { throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE"); }
    yield { kind: "day_manifest", manifestId: row.id, receivedAt: row.created_at,
      stagingState: row.state, activeWhenRead: row.active_when_read === 1, value: manifest };
    cursor = { createdAt: row.created_at, id: row.id };
  }
  cursor = null;
  while (true) {
    const row: ChunkRow | null = await db.prepare(
      "SELECT c.id, c.created_at, c.manifest_id, c.chunk_id, c.chunk_digest, "
      + "c.parser_version, c.record_count, c.stream, m.manifest_digest, "
      + "EXISTS (SELECT 1 FROM telemetry_v11_domain_heads h JOIN telemetry_v11_domain_days d "
      + "ON d.generation_id = h.generation_id "
      + "WHERE h.participant_id = c.participant_id AND d.manifest_id = c.manifest_id) AS active_when_read "
      + "FROM telemetry_v11_chunks c JOIN telemetry_v11_day_manifests m ON m.id = c.manifest_id "
      + "WHERE c.participant_id = ? AND c.created_at <= ? "
      + cursorPredicate(cursor, "c") + "ORDER BY c.created_at, c.id LIMIT 1",
    ).bind(participantId, createdThrough, ...cursorBindings(cursor))
      .first<ChunkRow>();
    if (!row) break;
    const stored = await db.prepare(
      "SELECT record_json FROM telemetry_v11_records WHERE chunk_id = ? ORDER BY observed_at, occurrence_id LIMIT 201",
    ).bind(row.id).all<{ record_json: string }>();
    if (stored.results.length > 200 || stored.results.length !== row.record_count) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    let records: TelemetryV11Record[];
    try { records = stored.results.map((record) => parseTelemetryV11Record(row.stream, JSON.parse(record.record_json))); }
    catch { throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE"); }
    yield { kind: "chunk", contributionId: row.id, schemaVersion: TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
      manifestId: row.manifest_id, manifestDigest: row.manifest_digest, chunkId: row.chunk_id, chunkDigest: row.chunk_digest,
      chunkRevision: 1, parserVersion: row.parser_version, recordCount: row.record_count,
      receivedAt: row.created_at, activeWhenRead: row.active_when_read === 1, records };
    cursor = { createdAt: row.created_at, id: row.id };
  }
  cursor = null;
  while (true) {
    const row: DomainRow | null = await db.prepare(
      "SELECT d.id, d.created_at, d.previous_generation_id, d.manifest_digest, d.from_day, d.through_day, d.days_json, "
      + "EXISTS (SELECT 1 FROM telemetry_v11_domain_heads h WHERE h.participant_id = d.participant_id "
      + "AND h.generation_id = d.id) AS active_when_read FROM telemetry_v11_domains d "
      + "WHERE d.participant_id = ? AND d.created_at <= ? "
      + cursorPredicate(cursor, "d") + "ORDER BY d.created_at, d.id LIMIT 1",
    ).bind(participantId, createdThrough, ...cursorBindings(cursor))
      .first<DomainRow>();
    if (!row) break;
    let days: { day: string; manifestId: string; manifestDigest: string }[];
    try {
      const value: unknown = JSON.parse(row.days_json);
      if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TELEMETRY_V11_DOMAIN_DAYS) throw new Error("invalid vector");
      days = value.map((entry: unknown) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)
            || Object.keys(entry).sort().join(",") !== "day,manifestDigest,manifestId") throw new Error("invalid entry");
        const day: unknown = Reflect.get(entry, "day");
        const manifestId: unknown = Reflect.get(entry, "manifestId");
        const manifestDigest: unknown = Reflect.get(entry, "manifestDigest");
        if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(day)
            || typeof manifestId !== "string" || !/^[0-9a-f-]{36}$/u.test(manifestId)
            || typeof manifestDigest !== "string" || !/^[0-9a-f]{64}$/u.test(manifestDigest)) throw new Error("invalid entry");
        return { day, manifestId, manifestDigest };
      });
    } catch { throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE"); }
    yield { kind: "domain", generationId: row.id, previousGenerationId: row.previous_generation_id,
      manifestDigest: row.manifest_digest, fromDay: row.from_day, throughDay: row.through_day,
      activatedAt: row.created_at, activeWhenRead: row.active_when_read === 1, days };
    cursor = { createdAt: row.created_at, id: row.id };
  }
}
