import { readTypedTelemetryRowsByStorageIds } from "./typed-telemetry-compatibility";
import { encodeTypedTelemetryId } from "./typed-telemetry-codec";
import { TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST } from "./typed-telemetry-origins";

const binary = (value: string): ArrayBuffer => Uint8Array.from(encodeTypedTelemetryId(value)).buffer;

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
  const manifest = await db.prepare(`SELECT 1 AS present FROM telemetry_v11_day_manifests m
    JOIN typed_v11_manifest_memberships membership ON membership.manifest_id=m.id
    JOIN typed_telemetry_manifests typed_manifest ON typed_manifest.id=membership.typed_manifest_id
      AND typed_manifest.namespace_id=membership.namespace_id AND typed_manifest.original_id=?
    JOIN typed_telemetry_owners owner ON owner.id=typed_manifest.owner_id
      AND owner.namespace_id=membership.namespace_id AND owner.original_id=?
    JOIN typed_telemetry_devices device ON device.id=typed_manifest.device_id
      AND device.namespace_id=membership.namespace_id AND device.owner_id=typed_manifest.owner_id
      AND device.original_id=?
    JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=membership.namespace_id
      AND origin.namespace_original=? AND origin.source_namespace=?
      AND origin.v11_read_contract_version=2 AND origin.source_schema_digest=?
    JOIN typed_v11_owner_memberships owner_membership ON owner_membership.participant_id=m.participant_id
      AND owner_membership.namespace_id=membership.namespace_id
      AND owner_membership.typed_owner_id=typed_manifest.owner_id
    WHERE m.id=? AND m.participant_id=? AND m.device_id=? AND m.state='ready'
    UNION ALL
    SELECT 1 AS present FROM telemetry_v11_day_manifests m
    JOIN typed_v11_admission_state s ON s.id=1 AND s.runtime_contract_version=1
    JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=s.namespace_id
      AND origin.source_namespace=s.source_namespace AND origin.source_namespace=?
      AND origin.namespace_original=? AND origin.access_mode='current-write'
      AND origin.v11_read_contract_version=2 AND origin.source_schema_digest=?
    WHERE m.id=? AND m.participant_id=? AND m.device_id=? AND m.state='ready'
      AND m.expected_chunk_count=0
      AND NOT EXISTS(SELECT 1 FROM telemetry_v11_chunks c WHERE c.manifest_id=m.id)`)
    .bind(binary(options.manifestId), binary(options.participantId), binary(options.deviceId),
      binary(options.sourceNamespace), options.sourceNamespace, TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST,
      options.manifestId, options.participantId, options.deviceId,
      options.sourceNamespace, binary(options.sourceNamespace), TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST,
      options.manifestId, options.participantId, options.deviceId).first();
  if (!manifest) throw new Error("TYPED_V11_READER_MEMBERSHIP_CONFLICT");
  const rows = (await db.prepare(TYPED_V11_MANIFEST_PAGE_SQL)
    .bind(options.manifestId, options.afterStream, options.afterOccurrence, options.limit)
    .all<{ record_id: number; stream: string; occurrence_id: string }>()).results;
  const decoded = await readTypedTelemetryRowsByStorageIds(db, {
    sourceNamespace: options.sourceNamespace, participantId: options.participantId,
    storageRowIds: rows.map(row => row.record_id),
  });
  return decoded.map((record, index) => {
    const admitted = rows[index]!;
    if (record.format !== "v11" || record.manifest_id !== options.manifestId || record.device_id !== options.deviceId
        || record.stream !== admitted.stream || record.occurrence_id !== admitted.occurrence_id) {
      throw new Error("TYPED_V11_READER_MEMBERSHIP_CONFLICT");
    }
    return { stream: record.stream, occurrence_id: record.occurrence_id, record_json: record.record_json };
  });
}
