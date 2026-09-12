import { sha256 } from './crypto';
import { decodeTypedTelemetryId, encodeTypedTelemetryRecord, typedTelemetryCanonicalRecords,
  typedTelemetryDayNumber, TypedTelemetryError } from './typed-telemetry-codec';
import type { TypedTelemetrySourceRecord } from './typed-telemetry-repository';

export const MAX_TYPED_V1_PRESERVATION_PROOFS = 200;
const MAX_PROOF_BYTES = 4 * 1024 * 1024;
const invalid = (): never => { throw new TypedTelemetryError('TYPED_TELEMETRY_INVALID'); };
const conflict = (): never => { throw new TypedTelemetryError('TYPED_TELEMETRY_CONFLICT'); };
type Binding = string | number | null | ArrayBuffer;

/** Bounded, privileged compatibility preparation, not upload admission. Callers
 * may obtain snapshots from readLegacyTelemetryCopyPage. They need no write
 * fence: each proof compares all original values inside the INSERT, and later
 * source mutations invalidate it. The closure must still require every proof.
 */
export async function prepareTypedV1PreservationProofs(db: D1Database, input: readonly TypedTelemetrySourceRecord[]): Promise<{
  statements: D1PreparedStatement[]; recordCount: number;
}> {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_TYPED_V1_PRESERVATION_PROOFS) {
    throw new TypedTelemetryError('TYPED_TELEMETRY_LIMIT');
  }
  const seen = new Set<number>(); let totalBytes = 0;
  // Finish synchronous validation/snapshotting before the first digest await.
  const rows = input.map(row => {
    if (!row || row.format !== 'v1' || row.manifestId !== null || !Number.isSafeInteger(row.sourceRowId)
        || row.sourceRowId < 1 || seen.has(row.sourceRowId)) invalid();
    seen.add(row.sourceRowId);
    for (const value of [row.participantId, row.deviceId, row.chunkRowId]) {
      if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) invalid();
    }
    typedTelemetryDayNumber(row.chunkDay); typedTelemetryDayNumber(row.observedDay);
    const fields = encodeTypedTelemetryRecord('v1', row.record);
    const canonical = typedTelemetryCanonicalRecords(fields).canonicalRecord;
    const bytes = new TextEncoder().encode(canonical).byteLength; totalBytes += bytes;
    if (bytes > 100_000 || totalBytes > MAX_PROOF_BYTES) throw new TypedTelemetryError('TYPED_TELEMETRY_LIMIT');
    const u = fields.usage, q = fields.quota;
    const occurrence = decodeTypedTelemetryId(fields.occurrenceId);
    const values: Record<string, Binding> = {
      id: row.sourceRowId, chunk_row_id: row.chunkRowId, participant_id: row.participantId, device_id: row.deviceId,
      stream: fields.stream, occurrence_id: occurrence, observed_at: new Date(fields.observedAtMs).toISOString(),
      observed_day: row.observedDay, provider: fields.provider, model_id: u?.modelId ?? null,
      session_uuid: fields.stream === 'session' ? occurrence : u ? decodeTypedTelemetryId(u.sessionId) : null,
      plan_type: q?.planType ?? null, plan_variant: q?.planVariant ?? null, limit_id: q?.limitId ?? null,
      slot: q?.slot ?? null, used_percent: q?.usedPercent ?? null, window_duration_minutes: q?.windowDurationMinutes ?? null,
      resets_at: q?.resetsAtMs == null ? null : new Date(q.resetsAtMs).toISOString(),
      input_uncached_tokens: u?.components.inputUncachedTokens ?? null,
      input_cache_read_tokens: u?.components.inputCacheReadTokens ?? null,
      input_cache_write_tokens: u?.components.inputCacheWriteTokens ?? null,
      output_text_tokens: u?.components.outputTextTokens ?? null,
      output_reasoning_tokens: u?.components.outputReasoningTokens ?? null,
      output_combined_tokens: u?.components.outputCombinedTokens ?? null, record_json: canonical,
    };
    return { values, canonical, chunkDay: row.chunkDay };
  });
  const statements: D1PreparedStatement[] = [];
  for (const row of rows) {
    const digest = Uint8Array.from(await sha256(row.canonical)).buffer;
    statements.push(db.prepare(`INSERT INTO typed_v1_preservation_proofs(source_row_id,canonical_digest)
      SELECT r.id,? FROM telemetry_v1_records r JOIN telemetry_v1_chunks c ON c.id=r.chunk_row_id
      WHERE ${Object.keys(row.values).map(key => `r.${key} IS ?`).join(' AND ')}
        AND c.participant_id=r.participant_id AND c.device_id=r.device_id AND c.stream=r.stream AND c.chunk_day=?
      ON CONFLICT(source_row_id) DO UPDATE SET canonical_digest=excluded.canonical_digest
        WHERE canonical_digest=excluded.canonical_digest RETURNING source_row_id`)
      .bind(digest, ...Object.values(row.values), row.chunkDay));
  }
  return { statements, recordCount: rows.length };
}

/** Failed comparisons refuse qualification; successfully prepared other rows
 * may remain as individually valid proofs. This is not an all-row cutover. */
export async function persistTypedV1PreservationProofs(db: D1Database, input: readonly TypedTelemetrySourceRecord[]): Promise<number> {
  const prepared = await prepareTypedV1PreservationProofs(db, input);
  const results = await db.batch<{ source_row_id: number }>(prepared.statements);
  if (results.length !== prepared.recordCount || results.some(result => !result.success || result.results.length !== 1)) conflict();
  return prepared.recordCount;
}
