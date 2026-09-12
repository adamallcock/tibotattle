import { decodeTypedTelemetryUsageAnalysisRows, readTypedTelemetryRowsByStorageIds } from "./typed-telemetry-compatibility";
import type { V11SourcePin } from "./telemetry-v11-domain";

export const TYPED_V11_ANALYSIS_PAGE_SIZE = 5_000;
export const TYPED_V11_USAGE_PAGE_SQL = `WITH page AS MATERIALIZED (
  SELECT storage_row_id,observed_at_ms,occurrence_id
  FROM typed_v11_active_records
  WHERE participant_id=? AND generation_id=? AND stream='usage' AND observed_day=?
    AND observed_at_ms>=? AND observed_at_ms<?
    AND (observed_at_ms,occurrence_id)>(?,?)
  ORDER BY observed_at_ms,occurrence_id LIMIT ?
) SELECT r.* FROM page CROSS JOIN typed_telemetry_compatibility_records r
  ON r.storage_row_id=page.storage_row_id
  ORDER BY page.observed_at_ms,page.occurrence_id`;

export async function readTypedV11UsageAnalysisPage(db: D1Database, options: {
  sourceNamespace: string; pin: V11SourcePin; day: string; from: string; to: string;
  afterTime: string; afterOccurrence: string; pageSize?: number;
}): Promise<Array<{ occurrence_id: string; observed_at: string; provider: string; session_uuid: string | null; record_json: string }>> {
  const { sourceNamespace, day, from, to, afterTime, afterOccurrence } = options;
  const pin = { ...options.pin };
  const pageSize = options.pageSize ?? TYPED_V11_ANALYSIS_PAGE_SIZE;
  if (![from,to,afterTime].every(value => Number.isSafeInteger(Date.parse(value)))
      || Date.parse(from)>=Date.parse(to) || typeof afterOccurrence!=="string"
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > TYPED_V11_ANALYSIS_PAGE_SIZE) {
    throw new Error("TYPED_V11_ANALYSIS_CURSOR_INVALID");
  }
  // The query itself selects the initialized, authoritative domain. Analytical
  // entrypoints check the complete source pin before and after all pages; a
  // concurrent head change cannot become an accepted truncated result.
  const rows = (await db.prepare(TYPED_V11_USAGE_PAGE_SQL).bind(pin.participantId, pin.generationId,
    day, Date.parse(from), Date.parse(to), Date.parse(afterTime), afterOccurrence,
    pageSize).all<Record<string, unknown>>()).results;
  const records = await decodeTypedTelemetryUsageAnalysisRows(db, rows, {
    sourceNamespace, participantId: pin.participantId, format: "v11",
  });
  return records.map((record, index) => {
    const row = rows[index]!;
    if (record.format !== "v11" || record.stream !== "usage"
        || record.observed_day !== day || record.occurrence_id !== row.occurrence_id
        || record.observed_at !== row.observed_at) throw new Error("TYPED_V11_ANALYSIS_MEMBERSHIP_CONFLICT");
    return { occurrence_id: record.occurrence_id, observed_at: record.observed_at,
      provider: record.provider, session_uuid: record.session_uuid, record_json: record.record_json };
  });
}

/** Private exports include staging as well as active evidence, so they use the
 * authenticated chunk membership instead of the active-domain view. */
export async function readTypedV11ChunkRecords(db: D1Database, options: {
  sourceNamespace: string; participantId: string; chunkId: string; expectedCount: number;
}): Promise<Array<{ record_json: string }>> {
  const { sourceNamespace, participantId, chunkId, expectedCount } = options;
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 200) {
    throw new Error("TYPED_V11_EXPORT_MEMBERSHIP_CONFLICT");
  }
  const rows = (await db.prepare(`SELECT p.typed_record_id FROM typed_v11_record_admissions p
    JOIN telemetry_v11_chunks c ON c.id=p.chunk_id
    WHERE p.chunk_id=? AND c.participant_id=? ORDER BY p.occurrence_id LIMIT 201`)
    .bind(chunkId, participantId).all<{ typed_record_id: number }>()).results;
  if (rows.length !== expectedCount) throw new Error("TYPED_V11_EXPORT_MEMBERSHIP_CONFLICT");
  const records = await readTypedTelemetryRowsByStorageIds(db, { sourceNamespace, participantId,
    storageRowIds: rows.map(row => row.typed_record_id) });
  if (records.some(row => row.format !== "v11" || row.chunk_row_id !== chunkId)) throw new Error("TYPED_V11_EXPORT_MEMBERSHIP_CONFLICT");
  return records.sort((a,b) => a.observed_at < b.observed_at ? -1 : a.observed_at > b.observed_at ? 1
    : a.occurrence_id < b.occurrence_id ? -1 : a.occurrence_id > b.occurrence_id ? 1 : 0)
    .map(row => ({ record_json: row.record_json }));
}
