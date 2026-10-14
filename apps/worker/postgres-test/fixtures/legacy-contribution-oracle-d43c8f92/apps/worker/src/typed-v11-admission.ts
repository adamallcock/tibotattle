import { assertTypedStorageAdmissionCapacity } from './typed-storage-capacity';
import {
  canonicalTelemetryV11Json, parseTelemetryV11ChunkId, telemetryV11RecordAnchor,
  TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION, type TelemetryV11Chunk,
} from "@app-usagemonitor/telemetry-contract";
import { sha256 } from "./crypto";
import { ApiError } from "./errors";
import { MAX_STORAGE_TRANSACTION_STATEMENTS } from "./storage-routing-batch-budget";
import { encodeTypedTelemetryId, TypedTelemetryError } from "./typed-telemetry-codec";
import { prepareTypedTelemetryInsert, MAX_TYPED_TELEMETRY_BATCH_BYTES, type TypedTelemetrySourceRecord } from "./typed-telemetry-repository";
import { telemetryV11LegacyProjection } from "./telemetry-v11-compatibility";
import { existingTelemetryV11StagedChunk, validateTelemetryV11StagedChunk,
  type TelemetryV11StagedChunkRow } from "./telemetry-v11-repository";
import { assertTelemetryTransportWriteAllowed, type TelemetryTransportPrincipal } from "./telemetry-transport-policy";

export interface TypedV11ChunkMetadata {
  /** Stable original source namespace, never a destination shard or request ID. */
  sourceNamespace: string;
  chunkRowId: string;
  r2Key: string;
  envelopeDigest: string;
  deviceUploadAuthorizationId: string;
}
export interface TypedV11StagedChunkResult {
  contributionId: string; manifestId: string; chunkId: string; replay: boolean;
}
interface AdmissionState { source_namespace: string; namespace_id: number; next_source_row_id: number }
const binary = (value: Uint8Array): ArrayBuffer => Uint8Array.from(value).buffer;
const encoded = (value: string): ArrayBuffer => binary(encodeTypedTelemetryId(value));
const unavailable = (): ApiError => new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");

/** Only a fresh target may enter this mode. Existing v11 evidence requires a
 * separately qualified importer; this operation never imports, deletes or drops it.
 * The baseline, typed layout, delivery bridge, and typed-admission migrations
 * must all be present, including the runtime contract, in this SAME database.
 * Repeating the same pin is harmless; the original allocator is never reset.
 */
export async function initializeTypedV11Admission(db: D1Database, sourceNamespace: string): Promise<void> {
  const source = encoded(sourceNamespace);
  const legacyState = await db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='typed_v1_admission_state'").first();
  if (legacyState) {
    const pin = await db.prepare("SELECT source_namespace FROM typed_v1_admission_state WHERE id=1")
      .first<{ source_namespace: string }>();
    if (pin && pin.source_namespace !== sourceNamespace) throw new TypedTelemetryError("TYPED_TELEMETRY_CONFLICT");
  }
  try {
    await db.batch([
      db.prepare("INSERT INTO typed_telemetry_namespaces(original_id) VALUES (?) ON CONFLICT DO NOTHING").bind(source),
      db.prepare(`INSERT INTO typed_v11_admission_state(id,source_namespace,namespace_id,next_source_row_id)
        VALUES (1,?,(SELECT id FROM typed_telemetry_namespaces WHERE original_id=?),1)
        ON CONFLICT(id) DO UPDATE SET source_namespace=excluded.source_namespace,namespace_id=excluded.namespace_id`)
        .bind(sourceNamespace, source),
      db.prepare(`UPDATE typed_v11_admission_state SET runtime_contract_version=1
        WHERE id=1 AND source_namespace=? AND runtime_contract_version=0`).bind(sourceNamespace),
    ]);
  } catch (error) {
    if (String(error).includes("typed_v11_unqualified_history") || String(error).includes("typed_v11_namespace_or_allocator_conflict")
        || String(error).includes("typed_v11_runtime_contract_unqualified")) {
      throw new TypedTelemetryError("TYPED_TELEMETRY_CONFLICT");
    }
    throw unavailable();
  }
}

function snapshotMetadata(value: TypedV11ChunkMetadata): TypedV11ChunkMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "chunkRowId,deviceUploadAuthorizationId,envelopeDigest,r2Key,sourceNamespace"
      || typeof value.r2Key !== "string" || value.r2Key.length < 1 || value.r2Key.length > 1024 || value.r2Key.includes("\0")
      || !/^[a-f0-9]{64}$/u.test(value.envelopeDigest)
      || typeof value.deviceUploadAuthorizationId !== "string" || value.deviceUploadAuthorizationId.length < 1
      || value.deviceUploadAuthorizationId.length > 256) throw new ApiError(400, "CHUNK_INVALID");
  encoded(value.sourceNamespace); encoded(value.chunkRowId);
  return { ...value };
}
function mapError(error: unknown): Error {
  const message = String(error);
  if (error instanceof ApiError || error instanceof TypedTelemetryError) return error;
  if (message.includes("typed_v11_allocator_race")) {
    // The transaction rolled back. A new ordinary attempt must reread the
    // allocator; never reuse the stale range or silently split the chunk.
    return new ApiError(409, "UPLOAD_IN_PROGRESS", { responseHeaders: { "retry-after": "1" } });
  }
  if (message.includes("chunk admission window exhausted") || message.includes("telemetry_manifest_admission_exhausted")) {
    return new ApiError(429, "CHUNK_ADMISSION_LIMIT_REACHED", { responseHeaders: { "retry-after": "60" } });
  }
  if (message.includes("telemetry_transport_blocked")) return new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  if (message.includes("telemetry_manifest_incomplete")) return new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  if (message.includes("UNIQUE constraint failed: typed_v11_record_admissions")) return new ApiError(409, "TELEMETRY_OCCURRENCE_CONFLICT");
  if (message.includes("telemetry_chunk_staging_denied") || message.includes("typed_v11_record_staging_denied")
      || message.includes("typed_v11_unallocated_record") || message.includes("typed_telemetry_identity_conflict")
      || message.includes("typed_telemetry_membership_conflict") || message.includes("UNIQUE constraint failed: telemetry_v11")) {
    return new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  }
  return unavailable();
}
async function replayResult(db: D1Database, row: TelemetryV11StagedChunkRow, chunk: TelemetryV11Chunk,
  namespaceId: number): Promise<TypedV11StagedChunkResult> {
  if (row.chunk_digest !== chunk.chunkDigest || row.record_count !== chunk.records.length) {
    throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  }
  const complete = await db.prepare(`SELECT count(*) AS total FROM typed_v11_record_admissions p
    JOIN typed_telemetry_records r ON r.id=p.typed_record_id
    JOIN typed_v11_chunk_allocations a ON a.chunk_id=p.chunk_id
    WHERE p.chunk_id=? AND p.manifest_id=? AND a.namespace_id=? AND r.namespace_id=a.namespace_id
      AND r.format=11 AND r.source_row_id>=a.first_source_row_id AND r.source_row_id<a.first_source_row_id+a.record_count`)
    .bind(row.id, row.manifest_id, namespaceId).first<{ total: number }>();
  if (complete?.total !== row.record_count) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  return { contributionId: row.id, manifestId: row.manifest_id, chunkId: chunk.chunkId, replay: true };
}

/** Typed-only staged admission using the original authority tables and triggers.
 * Chunk/header, authorization consumption, numeric source range, typed records,
 * proof mappings and readiness commit in ONE bounded D1 transaction. There is
 * no analytics database access, queue requirement or automatic domain activation.
 */
export async function persistTypedV11StagedChunk(db: D1Database, principalValue: TelemetryTransportPrincipal,
  value: unknown, metadataValue: TypedV11ChunkMetadata, nowEpoch = Date.now()): Promise<TypedV11StagedChunkResult> {
  const metadata = snapshotMetadata(metadataValue);
  const principal = { participantId: principalValue.participantId, deviceId: principalValue.deviceId };
  encoded(principal.participantId); encoded(principal.deviceId);
  if (!Number.isFinite(nowEpoch) || !Number.isFinite(new Date(nowEpoch).getTime())) throw new ApiError(400, "CHUNK_INVALID");
  const now = new Date(nowEpoch).toISOString();
  const chunk = await validateTelemetryV11StagedChunk(value);
  const { stream, day, seq } = parseTelemetryV11ChunkId(chunk.chunkId);
  await assertTelemetryTransportWriteAllowed(db, principal, TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION);
  const state = await db.prepare("SELECT source_namespace,namespace_id,next_source_row_id FROM typed_v11_admission_state WHERE id=1")
    .first<AdmissionState>();
  if (!state || state.source_namespace !== metadata.sourceNamespace || !Number.isSafeInteger(state.next_source_row_id)
      || state.next_source_row_id < 1 || !Number.isSafeInteger(state.next_source_row_id + chunk.records.length)) {
    throw new TypedTelemetryError("TYPED_TELEMETRY_CONFLICT");
  }
  const manifest = await db.prepare(`SELECT id FROM telemetry_v11_day_manifests
    WHERE participant_id=? AND device_id=? AND chunk_day=? AND manifest_digest=?`)
    .bind(principal.participantId, principal.deviceId, day, chunk.manifestDigest).first<{ id: string }>();
  if (!manifest) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  const existing = await existingTelemetryV11StagedChunk(db, principal, chunk);
  if (existing) return replayResult(db, existing, chunk, state.namespace_id);
  await assertTypedStorageAdmissionCapacity(db);
  const rows: TypedTelemetrySourceRecord[] = chunk.records.map((record, index) => ({
    sourceNamespace: metadata.sourceNamespace, format: "v11", sourceRowId: state.next_source_row_id + index,
    participantId: principal.participantId, deviceId: principal.deviceId, chunkRowId: metadata.chunkRowId,
    manifestId: manifest.id, chunkDay: day, observedDay: day, record,
  }));
  let transactionBytes = 0;
  const encoder = new TextEncoder();
  const prepare = (sql: string) => ({ bind: (...values: (string | number | null | ArrayBuffer)[]) => {
    transactionBytes += encoder.encode(sql).byteLength + values.reduce<number>((total, value) => total
      + (typeof value === "string" ? encoder.encode(value).byteLength : value instanceof ArrayBuffer ? value.byteLength : 8), 0);
    if (values.length > 100 || transactionBytes > MAX_TYPED_TELEMETRY_BATCH_BYTES) throw new TypedTelemetryError("TYPED_TELEMETRY_LIMIT");
    return db.prepare(sql).bind(...values);
  } });
  const statements: D1PreparedStatement[] = [prepare(`INSERT INTO telemetry_v11_chunks (
    id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,chunk_digest,envelope_digest,
    parser_version,record_count,r2_key,device_upload_authorization_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(metadata.chunkRowId, manifest.id, principal.participantId, principal.deviceId, stream, day, seq, chunk.chunkId,
      chunk.chunkDigest, metadata.envelopeDigest, chunk.parserVersion, chunk.records.length, metadata.r2Key,
      metadata.deviceUploadAuthorizationId, now),
    prepare(`INSERT INTO typed_v11_chunk_allocations(chunk_id,namespace_id,chunk_original,first_source_row_id,record_count)
      VALUES (?,?,?,?,?)`).bind(metadata.chunkRowId, state.namespace_id, encoded(metadata.chunkRowId), state.next_source_row_id, chunk.records.length),
  ];
  // Keep the copy owner's per-page 800-statement contract. The final admitted
  // chunk is still indivisible, and the complete combined batch is capped below.
  for (let offset = 0; offset < rows.length; offset += 100) {
    const page = await prepareTypedTelemetryInsert(db, rows.slice(offset, offset + 100));
    transactionBytes += page.byteLength;
    if (transactionBytes > MAX_TYPED_TELEMETRY_BATCH_BYTES) throw new TypedTelemetryError("TYPED_TELEMETRY_LIMIT");
    statements.push(...page.statements);
  }
  statements.push(prepare(`INSERT INTO typed_v11_owner_memberships(participant_id,typed_owner_id)
    SELECT ?,owner_id FROM typed_telemetry_records WHERE namespace_id=? AND format=11 AND source_row_id=?
    ON CONFLICT(participant_id) DO UPDATE SET typed_owner_id=excluded.typed_owner_id`)
    .bind(principal.participantId, state.namespace_id, state.next_source_row_id));
  statements.push(prepare(`INSERT INTO typed_v11_manifest_memberships(manifest_id,typed_manifest_id)
    SELECT ?,manifest_id FROM typed_telemetry_records WHERE namespace_id=? AND format=11 AND source_row_id=?
    ON CONFLICT DO NOTHING`).bind(manifest.id,state.namespace_id,state.next_source_row_id));
  const proofs = await Promise.all(chunk.records.map(async (record, index) => {
    const anchor = telemetryV11RecordAnchor(stream, record);
    const legacy = telemetryV11LegacyProjection(stream, record);
    const base = { ...record } as Record<string, unknown>;
    delete base.accountPlanAttribution;
    return [state.next_source_row_id + index, encoded(anchor.occurrenceId), binary(await sha256(canonicalTelemetryV11Json(base))),
      legacy ? encoded(legacy.occurrenceId) : null, legacy ? binary(await sha256(legacy.canonicalRecord)) : null];
  }));
  // Five values per proof, plus one shared binding: <=96 bindings/statement.
  for (let offset = 0; offset < proofs.length; offset += 19) {
    const group = proofs.slice(offset, offset + 19);
    statements.push(prepare(`WITH proof(source_row_id,occurrence_id,base_digest,legacy_occurrence_id,legacy_digest) AS
      (VALUES ${group.map(() => "(?,?,?,?,?)").join(",")})
      INSERT INTO typed_v11_record_proofs(typed_record_id,chunk_key,manifest_key,stream_code,occurrence_blob,base_digest,legacy_occurrence_blob,legacy_digest,observed_at_ms)
      SELECT r.id,r.chunk_id,r.manifest_id,r.stream,r.occurrence_id,p.base_digest,p.legacy_occurrence_id,p.legacy_digest,r.observed_at_ms
      FROM proof p JOIN typed_telemetry_records r ON r.namespace_id=? AND r.format=11 AND r.source_row_id=p.source_row_id AND r.occurrence_id=p.occurrence_id`)
      .bind(...group.flat(), state.namespace_id));
  }
  statements.push(prepare(`UPDATE telemetry_v11_day_manifests SET state='ready',ready_at=?
    WHERE id=? AND state='staged' AND expected_chunk_count=(SELECT count(*) FROM telemetry_v11_chunks WHERE manifest_id=?)
      AND NOT EXISTS (SELECT 1 FROM telemetry_v11_chunks c WHERE c.manifest_id=?
        AND c.record_count!=(SELECT count(*) FROM typed_v11_record_admissions p WHERE p.chunk_id=c.id))`)
    .bind(now, manifest.id, manifest.id, manifest.id));
  if (statements.length > MAX_STORAGE_TRANSACTION_STATEMENTS) throw new TypedTelemetryError("TYPED_TELEMETRY_LIMIT");
  try {
    const results = await db.batch(statements);
    if (results.some(result => !result.success)) throw unavailable();
  } catch (error) {
    // A response can be lost after commit. Reconcile only this authenticated,
    // exact chunk and its complete typed membership; never blindly resend it.
    const replay = await existingTelemetryV11StagedChunk(db, principal, chunk);
    if (replay) return replayResult(db, replay, chunk, state.namespace_id);
    throw mapError(error);
  }
  return { contributionId: metadata.chunkRowId, manifestId: manifest.id, chunkId: chunk.chunkId, replay: false };
}
