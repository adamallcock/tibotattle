import { canonicalJson } from "./canonical-json";
import { ApiError } from "./errors";
import {
  TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V1_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V1_PRIVACY_CONTRACT_VERSION,
  telemetryV1RecordAnchor,
  type TelemetryV1QuotaObservation,
  type TelemetryV1Record,
  type TelemetryV1SessionDimension,
  type TelemetryV1Stream,
  type TelemetryV1UsageEvent,
} from "./telemetry-v1";
import type {
  TelemetryV1ContributionReceipt,
  TelemetryV1ContributionStore,
  TelemetryV1ContributionWrite,
} from "./telemetry-v1-contribution-store";

function recordStatement(
  db: D1Database,
  chunkRowId: string,
  participantId: string,
  deviceId: string,
  stream: TelemetryV1Stream,
  record: TelemetryV1Record,
): D1PreparedStatement {
  const anchor = telemetryV1RecordAnchor(stream, record);
  const usage = stream === "usage" ? record as TelemetryV1UsageEvent : null;
  const quota = stream === "quota" ? record as TelemetryV1QuotaObservation : null;
  const session = stream === "session"
    ? record as TelemetryV1SessionDimension
    : null;
  // A record may move between chunks only through supersession of its origin
  // chunk, whose delete-then-insert frees the occurrence first. A plain
  // INSERT here means an arriving chunk can never silently steal a record
  // that a different still-current chunk owns — that would falsify the other
  // chunk's digest with no rebuild enqueued; the conflict maps to a typed
  // 409 instead (RECORD_OWNED_BY_OTHER_CHUNK).
  return db.prepare(
    `INSERT INTO telemetry_v1_records (
      chunk_row_id, participant_id, device_id, stream, occurrence_id,
      observed_at, observed_day, provider, model_id, session_uuid,
      plan_type, plan_variant, limit_id, slot, used_percent,
      window_duration_minutes, resets_at,
      input_uncached_tokens, input_cache_read_tokens, input_cache_write_tokens,
      output_text_tokens, output_reasoning_tokens, output_combined_tokens,
      record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    chunkRowId,
    participantId,
    deviceId,
    stream,
    anchor.occurrenceId,
    anchor.observedAt,
    anchor.observedAt.slice(0, 10),
    usage?.provider ?? quota?.provider ?? session?.provider ?? null,
    usage?.modelId ?? null,
    usage?.sessionUuid ?? session?.sessionUuid ?? null,
    quota?.planType ?? null,
    quota?.planVariant ?? null,
    quota?.limitId ?? null,
    quota?.slot ?? null,
    quota?.usedPercent ?? null,
    quota?.windowDurationMinutes ?? null,
    quota?.resetsAt ?? null,
    usage?.components.inputUncachedTokens ?? null,
    usage?.components.inputCacheReadTokens ?? null,
    usage?.components.inputCacheWriteTokens ?? null,
    usage?.components.outputTextTokens ?? null,
    usage?.components.outputReasoningTokens ?? null,
    usage?.components.outputCombinedTokens ?? null,
    canonicalJson(record),
  );
}

/**
 * D1 surfaces trigger aborts and constraint violations as opaque batch
 * errors. Every guard the 0031 schema enforces has a typed public code, so
 * a raced insert answers with the same contract as the pre-insert checks
 * instead of a 500.
 */
function mapTelemetryV1BatchError(error: unknown): unknown {
  const message = String(error);
  if (message.includes("participant unavailable")) {
    return new ApiError(409, "PARTICIPANT_DELETING");
  }
  if (message.includes("chunk admission window exhausted")) {
    return new ApiError(429, "CHUNK_ADMISSION_LIMIT_REACHED", {
      responseHeaders: { "retry-after": "60" },
    });
  }
  if (message.includes("upload unavailable")) {
    return new ApiError(401, "UPLOAD_AUTH_INVALID");
  }
  if (message.includes("UNIQUE constraint failed: telemetry_v1_records.")) {
    return new ApiError(409, "RECORD_OWNED_BY_OTHER_CHUNK");
  }
  if (message.includes("UNIQUE constraint failed: telemetry_v1_chunks")) {
    return new ApiError(409, "CHUNK_REVISION_CONFLICT");
  }
  return error;
}

/**
 * Journal + current-view write, atomic in one D1 batch. Supersession marks
 * the prior revision superseded and removes exactly its records before the
 * new revision's records land; the daily-aggregate rebuild for the chunk's
 * day is enqueued by the journal trigger inside the same transaction.
 */
async function insertD1TelemetryV1Contribution(
  db: D1Database,
  input: TelemetryV1ContributionWrite,
): Promise<TelemetryV1ContributionReceipt> {
  const { chunk } = input;
  const statements: D1PreparedStatement[] = [];
  // Scoped preservation is not an authorization bypass: the normal admission
  // triggers still validate and consume the upload. This marker only separates
  // an accepted contribution/correction from revocation of published evidence.
  // Both supersession and insertion consume the exact marker within this batch.
  statements.push(db.prepare(`INSERT INTO community_graph_update_scope
    (singleton,participant_id,device_id,stream,chunk_day,chunk_seq,old_chunk_id,new_chunk_id,
      new_revision,chunk_digest,parser_version,record_count,authorization_id,envelope_digest,created_at,expected_epoch,phase)
    SELECT 1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,s.mutation_epoch,?15
    FROM community_snapshot_mutation_control s
    JOIN participants p ON p.id=?1 AND p.state='active'
    JOIN device_credentials d ON d.id=?2 AND d.participant_id=p.id AND d.state='active'
      AND d.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    JOIN device_upload_authorizations a ON a.id=?12 AND a.participant_id=p.id
      AND a.issued_by_device_id=d.id AND a.state='consuming' AND a.envelope_digest=?13
      AND a.consume_lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    JOIN telemetry_v1_device_consents consent ON consent.participant_id=p.id AND consent.device_id=d.id
      AND consent.telemetry_schema_version=?16 AND consent.field_dictionary_version=?17
      AND consent.privacy_contract_version=?18
    WHERE s.singleton_id=1
      AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=p.id)
      AND NOT EXISTS (SELECT 1 FROM telemetry_contributions WHERE participant_id=p.id AND status='accepted')
      AND ((?6 IS NULL AND NOT EXISTS (SELECT 1 FROM telemetry_v1_chunks c
        WHERE c.participant_id=?1 AND c.device_id=?2 AND c.stream=?3 AND c.chunk_day=?4 AND c.chunk_seq=?5))
      OR EXISTS (SELECT 1 FROM telemetry_v1_chunks c
        WHERE c.id=?6 AND c.participant_id=?1 AND c.device_id=?2 AND c.stream=?3 AND c.chunk_day=?4
          AND c.chunk_seq=?5 AND c.revision=?8-1 AND c.superseded_at IS NULL))`)
    .bind(input.participantId, input.deviceId, chunk.stream, chunk.chunkDay, chunk.chunkSeq,
      input.supersedes?.id ?? null, input.chunkId, chunk.chunkRevision, chunk.chunkDigest,
      chunk.parserVersion, chunk.records.length, input.uploadAuthorizationId, input.envelopeDigest,
      input.createdAt, input.supersedes ? "supersede" : "insert", TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
      TELEMETRY_V1_FIELD_DICTIONARY_VERSION, TELEMETRY_V1_PRIVACY_CONTRACT_VERSION));
  // The prior revision leaves the current view before the new revision
  // enters it: the partial current-identity uniqueness would otherwise see
  // two current rows for one chunk mid-batch. The batch is one transaction,
  // so a failed insert also rolls the supersession back.
  if (input.supersedes) {
    statements.push(db.prepare(
      `UPDATE telemetry_v1_chunks
          SET superseded_at = ?
        WHERE id = ? AND participant_id = ? AND superseded_at IS NULL`,
    ).bind(input.createdAt, input.supersedes.id, input.participantId));
    statements.push(db.prepare(
      "DELETE FROM telemetry_v1_records WHERE chunk_row_id = ?",
    ).bind(input.supersedes.id));
  }
  const chunkStatementIndex = statements.length;
  statements.push(db.prepare(
    `INSERT INTO telemetry_v1_chunks (
      id, participant_id, device_id, stream, chunk_day, chunk_seq,
      revision, chunk_digest, envelope_digest, parser_version,
      record_count, accepted_record_count, r2_key,
      device_upload_authorization_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(
    input.chunkId,
    input.participantId,
    input.deviceId,
    chunk.stream,
    chunk.chunkDay,
    chunk.chunkSeq,
    chunk.chunkRevision,
    chunk.chunkDigest,
    input.envelopeDigest,
    chunk.parserVersion,
    chunk.records.length,
    chunk.records.length,
    input.objectKey,
    input.uploadAuthorizationId,
    input.createdAt,
  ));
  for (const record of chunk.records) {
    statements.push(recordStatement(
      db,
      input.chunkId,
      input.participantId,
      input.deviceId,
      chunk.stream,
      record,
    ));
  }
  statements.push(db.prepare("DELETE FROM community_graph_update_scope WHERE new_chunk_id = ?")
    .bind(input.chunkId));
  let results: D1Result<unknown>[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    throw mapTelemetryV1BatchError(error);
  }
  const inserted = results[chunkStatementIndex]?.results;
  if (inserted?.length !== 1 || typeof inserted[0] !== "object" || inserted[0] === null
      || Reflect.get(inserted[0], "id") !== input.chunkId) {
    throw new ApiError(409, "PARTICIPANT_DELETING");
  }
  return { acceptedRecords: chunk.records.length };
}

export function createD1TelemetryV1ContributionStore(
  db: D1Database,
): TelemetryV1ContributionStore {
  return {
    insert(input) {
      return insertD1TelemetryV1Contribution(db, input);
    },
  };
}
