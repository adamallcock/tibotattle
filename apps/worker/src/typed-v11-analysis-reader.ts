import { decodeTypedTelemetryUsageAnalysisRows, readTypedTelemetryRowsByStorageIds } from "./typed-telemetry-compatibility";
import {
  assertTypedV11GenerationSnapshotLive,
  type V11GenerationSnapshot,
} from "./typed-v11-quota-reader";
import { encodeTypedTelemetryId } from "./typed-telemetry-codec";
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

/** The retained-generation counterpart starts from the immutable manifest
 * proof index. It intentionally has no domain-head join: a later successor may
 * be current while this exact generation remains the reader's input. The live
 * owner/retention joins are repeated in the page CTE, and the caller performs a
 * separate live fence before each page so withdrawal cannot look like EOF. */
export const TYPED_V11_USAGE_SNAPSHOT_PAGE_SQL = `WITH snapshot AS MATERIALIZED (
  SELECT s.namespace_id,s.source_namespace,o.typed_owner_id,g.id AS generation_id,g.device_id
  FROM typed_v11_admission_state s
  JOIN typed_v11_owner_memberships o ON o.participant_id=?2
  JOIN typed_telemetry_owners owner ON owner.id=o.typed_owner_id
    AND owner.namespace_id=s.namespace_id
  JOIN telemetry_v11_domains g ON g.id=?3 AND g.participant_id=?2
    AND g.device_id=?4 AND g.manifest_digest=?12 AND g.from_day=?13 AND g.through_day=?14
  JOIN participants participant ON participant.id=g.participant_id AND participant.state='active'
  JOIN device_credentials generation_device ON generation_device.id=g.device_id
    AND generation_device.participant_id=g.participant_id AND generation_device.state='active'
  JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=g.participant_id
    AND owner_link.state='active'
  JOIN storage_owner_revisions owner_revision ON owner_revision.owner_digest=owner_link.owner_digest
    AND owner_revision.state='active'
  WHERE s.id=1 AND s.runtime_contract_version=1 AND s.source_namespace=?1
    AND EXISTS (SELECT 1 FROM storage_v11_event_sources retained_source
      WHERE retained_source.owner_digest=owner_link.owner_digest
        AND retained_source.participant_id=g.participant_id
        AND retained_source.generation_id=g.id)
), manifest_scope AS MATERIALIZED (
  SELECT snapshot.namespace_id,snapshot.typed_owner_id,snapshot.generation_id,
    snapshot.device_id,domain_day.manifest_id,membership.typed_manifest_id
  FROM snapshot
  JOIN telemetry_v11_domain_days domain_day ON domain_day.generation_id=snapshot.generation_id
    AND domain_day.observed_day=?5
  JOIN telemetry_v11_day_manifests manifest ON manifest.id=domain_day.manifest_id
    AND manifest.participant_id=?2 AND manifest.device_id=snapshot.device_id
    AND manifest.chunk_day=domain_day.observed_day AND manifest.state='ready'
  JOIN typed_v11_manifest_memberships membership ON membership.manifest_id=domain_day.manifest_id
), page AS MATERIALIZED (
  SELECT raw.id AS storage_row_id,raw.observed_at_ms,proof.occurrence_id
  FROM manifest_scope
  CROSS JOIN typed_v11_record_proofs proof INDEXED BY typed_v11_manifest_observed
    ON proof.manifest_key=manifest_scope.typed_manifest_id AND proof.stream_code=1
  JOIN typed_telemetry_records raw ON raw.id=proof.typed_record_id
    AND raw.namespace_id=manifest_scope.namespace_id
    AND raw.owner_id=manifest_scope.typed_owner_id AND raw.format=11 AND raw.stream=1
  JOIN typed_telemetry_devices typed_device ON typed_device.id=raw.device_id
    AND typed_device.namespace_id=manifest_scope.namespace_id
    AND typed_device.owner_id=manifest_scope.typed_owner_id AND typed_device.original_id=?11
  WHERE raw.observed_at_ms>=?6 AND raw.observed_at_ms<?7
    AND (raw.observed_at_ms,proof.occurrence_id)>(?8,?9)
  ORDER BY raw.observed_at_ms,proof.occurrence_id LIMIT ?10
)
SELECT records.* FROM page CROSS JOIN typed_telemetry_compatibility_records records
  ON records.storage_row_id=page.storage_row_id
ORDER BY page.observed_at_ms,page.occurrence_id`;

export async function readTypedV11UsageAnalysisPage(db: D1Database, options: {
  sourceNamespace: string; pin?: V11SourcePin; snapshot?: V11GenerationSnapshot; day: string; from: string; to: string;
  afterTime: string; afterOccurrence: string; pageSize?: number;
}): Promise<Array<{ occurrence_id: string; observed_at: string; provider: string; session_uuid: string | null; record_json: string }>> {
  const { sourceNamespace, day, from, to, afterTime, afterOccurrence } = options;
  if (options.pin !== undefined && options.snapshot !== undefined) {
    throw new Error("TYPED_V11_ANALYSIS_MEMBERSHIP_CONFLICT");
  }
  const snapshot = options.snapshot;
  if (snapshot === undefined && options.pin === undefined) {
    throw new Error("TYPED_V11_ANALYSIS_MEMBERSHIP_CONFLICT");
  }
  if (snapshot !== undefined && snapshot.sourceNamespace !== sourceNamespace) {
    throw new Error("TYPED_V11_ANALYSIS_MEMBERSHIP_CONFLICT");
  }
  // Detach the caller's object before any asynchronous validation so a mutable
  // checkpoint payload cannot change the identity between the live fence and
  // the bound SQL parameters.
  const snapshotCopy = snapshot === undefined ? undefined : Object.freeze({ ...snapshot });
  const pin = options.pin;
  const pageSize = options.pageSize ?? TYPED_V11_ANALYSIS_PAGE_SIZE;
  if (![from,to,afterTime].every(value => Number.isSafeInteger(Date.parse(value)))
      || Date.parse(from)>=Date.parse(to) || typeof afterOccurrence!=="string"
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > TYPED_V11_ANALYSIS_PAGE_SIZE) {
    throw new Error("TYPED_V11_ANALYSIS_CURSOR_INVALID");
  }
  if (snapshotCopy !== undefined && (day < snapshotCopy.fromDay || day > snapshotCopy.throughDay)) {
    throw new Error("TYPED_V11_ANALYSIS_MEMBERSHIP_CONFLICT");
  }
  // The query itself selects the initialized, authoritative domain. Analytical
  // entrypoints check the complete source pin before and after all pages; a
  // concurrent head change cannot become an accepted truncated result.
  const rows = snapshotCopy === undefined
    ? (await db.prepare(TYPED_V11_USAGE_PAGE_SQL).bind(pin!.participantId, pin!.generationId,
      day, Date.parse(from), Date.parse(to), Date.parse(afterTime), afterOccurrence,
      pageSize).all<Record<string, unknown>>()).results
    : (await assertTypedV11GenerationSnapshotLive(db, snapshotCopy),
      (await db.prepare(TYPED_V11_USAGE_SNAPSHOT_PAGE_SQL).bind(
        snapshotCopy.sourceNamespace, snapshotCopy.participantId, snapshotCopy.generationId, snapshotCopy.deviceId, day,
        Date.parse(from), Date.parse(to), Date.parse(afterTime), afterOccurrence, pageSize,
        Uint8Array.from(encodeTypedTelemetryId(snapshotCopy.deviceId)).buffer,
        snapshotCopy.manifestDigest, snapshotCopy.fromDay, snapshotCopy.throughDay,
      ).all<Record<string, unknown>>()).results);
  const records = await decodeTypedTelemetryUsageAnalysisRows(db, rows, {
    sourceNamespace, participantId: snapshotCopy?.participantId ?? pin!.participantId, format: "v11",
  });
  if (records.length !== rows.length) throw new Error("TYPED_V11_ANALYSIS_MEMBERSHIP_CONFLICT");
  return records.map((record, index) => {
    const row = rows[index]!;
    if (record.format !== "v11" || record.stream !== "usage"
        || record.observed_day !== day || record.occurrence_id !== row.occurrence_id
        || record.observed_at !== row.observed_at
        || snapshotCopy !== undefined && record.device_id !== snapshotCopy.deviceId
        || snapshotCopy !== undefined && record.manifest_id === null) throw new Error("TYPED_V11_ANALYSIS_MEMBERSHIP_CONFLICT");
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
