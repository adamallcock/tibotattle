import { readTypedTelemetryRowsByStorageIdPages } from "./typed-telemetry-compatibility";
import { encodeTypedTelemetryId } from "./typed-telemetry-codec";

export const TYPED_V11_MANIFEST_PAGE_SQL = `SELECT typed_record_id AS record_id,stream,occurrence_id
  FROM typed_v11_record_admissions
  WHERE manifest_id=? AND (stream,occurrence_id)>(?,?)
  ORDER BY stream,occurrence_id LIMIT ?`;

/** An internal, generation-pinned manifest read. Authority belongs to the
 * accepted domain/source journal; every decoded row must match the selected
 * original namespace, owner, device and manifest. Never silently read the JSON
 * lane if the typed evidence is absent or incomplete. */
export async function readTypedV11ManifestPage(db: D1Database, options: {
  sourceNamespace: string; participantId: string; deviceId: string; manifestId: string;
  afterStream: string; afterOccurrence: string; limit: number;
}): Promise<Array<{ stream: string; occurrence_id: string; record_json: string }>> {
  options = { ...options };
  for (const value of [options.sourceNamespace, options.participantId, options.deviceId, options.manifestId]) encodeTypedTelemetryId(value);
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200
      || !["", "quota", "session", "usage"].includes(options.afterStream)
      || typeof options.afterOccurrence !== "string" || options.afterOccurrence.length > 256
      || (options.afterStream === "") !== (options.afterOccurrence === "")) {
    throw new Error("TYPED_V11_READER_INVALID");
  }
  const results = await db.batch([
    db.prepare(`SELECT 1 AS present FROM typed_v11_admission_state s
      CROSS JOIN telemetry_v11_day_manifests m
      WHERE s.id=1 AND s.source_namespace=? AND m.id=? AND m.participant_id=? AND m.device_id=? AND m.state='ready'`)
      .bind(options.sourceNamespace, options.manifestId, options.participantId, options.deviceId),
    db.prepare(TYPED_V11_MANIFEST_PAGE_SQL)
      .bind(options.manifestId, options.afterStream, options.afterOccurrence, options.limit),
  ]);
  if (!Array.isArray(results) || results.length !== 2
      || results.some(result => result?.success !== true || !Array.isArray(result.results))) {
    throw new Error("TYPED_V11_READER_MEMBERSHIP_CONFLICT");
  }
  const [manifestResult, rowsResult] = results;
  const manifest = manifestResult?.results[0];
  if (!manifest) throw new Error("TYPED_V11_READER_MEMBERSHIP_CONFLICT");
  const rows = rowsResult!.results as unknown as Array<{ record_id: number; stream: string; occurrence_id: string }>;
  if (rows.length === 0) return [];
  const [decoded] = await readTypedTelemetryRowsByStorageIdPages(db, [{
    sourceNamespace: options.sourceNamespace, participantId: options.participantId,
    storageRowIds: rows.map(row => row.record_id),
  }]);
  if (!decoded) throw new Error("TYPED_V11_READER_MEMBERSHIP_CONFLICT");
  return decoded.map((record, index) => {
    const admitted = rows[index]!;
    if (record.format !== "v11" || record.manifest_id !== options.manifestId || record.device_id !== options.deviceId
        || record.stream !== admitted.stream || record.occurrence_id !== admitted.occurrence_id) {
      throw new Error("TYPED_V11_READER_MEMBERSHIP_CONFLICT");
    }
    return { stream: record.stream, occurrence_id: record.occurrence_id, record_json: record.record_json };
  });
}
