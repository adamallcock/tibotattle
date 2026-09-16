import { ApiError } from "./errors";
import type { PostgresTelemetryV1Client, PostgresTelemetryV1Pool } from "./postgres-telemetry-v1-contribution-store";
import type {
  StoredTelemetryV1Chunk,
  TelemetryV1ContributionReader,
} from "./telemetry-v1-contribution-reader";

const unavailable = (): ApiError => new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
const columns = `id, participant_id, device_id, stream,
  to_char(chunk_day, 'YYYY-MM-DD') AS chunk_day, chunk_seq, revision,
  chunk_digest, record_count, accepted_record_count AS accepted_records,
  superseded_at::text AS superseded_at`;

function day(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw unavailable();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw unavailable();
  return value;
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw unavailable();
  return value;
}
function chunk(row: Record<string, unknown>): StoredTelemetryV1Chunk {
  const stream = row.stream;
  if (stream !== "usage" && stream !== "quota" && stream !== "session") throw unavailable();
  const supersededAt = row.superseded_at;
  if (supersededAt !== null && (typeof supersededAt !== "string" || !Number.isFinite(Date.parse(supersededAt)))) throw unavailable();
  const recordCount = integer(row.record_count, 1, 200);
  const chunkDigest = text(row.chunk_digest);
  if (!/^[a-f0-9]{64}$/u.test(chunkDigest)) throw unavailable();
  return {
    id: text(row.id), participantId: text(row.participant_id), deviceId: text(row.device_id),
    stream, chunkDay: day(row.chunk_day), chunkSeq: integer(row.chunk_seq, 0),
    revision: integer(row.revision, 1), chunkDigest,
    recordCount, acceptedRecords: integer(row.accepted_records, 0, recordCount), supersededAt,
  };
}

/**
 * Qualification-only reads. Callers must authenticate before invoking this
 * trusted port. Envelope replay is participant-wide, including superseded rows,
 * as on D1; current identity and acknowledgement are device-scoped.
 * No result here authorizes quarantine deletion or owner erasure.
 */
export function createExperimentalPostgresTelemetryV1ContributionReader(
  pool: PostgresTelemetryV1Pool,
): TelemetryV1ContributionReader {
  async function read<T>(sql: string, values: unknown[], decode: (rows: Record<string, unknown>[]) => T): Promise<T> {
    let client: PostgresTelemetryV1Client;
    try { client = await pool.connect(); } catch { throw unavailable(); }
    let commitAttempted = false;
    let result: T;
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout='10s'");
      await client.query("SET LOCAL lock_timeout='5s'");
      const response = await client.query(sql, values);
      if (!Array.isArray(response.rows) || response.rowCount !== response.rows.length || response.rows.length > 1) throw unavailable();
      result = decode(response.rows);
      commitAttempted = true;
      await client.query("COMMIT");
    } catch {
      let discard = commitAttempted;
      try { await client.query("ROLLBACK"); } catch { discard = true; }
      try { await client.release(discard); } catch { /* never expose pool diagnostics */ }
      throw unavailable();
    }
    try { await client.release(false); } catch { throw unavailable(); }
    return result;
  }
  return {
    byEnvelope(participantId, envelopeDigest) {
      return read(`SELECT ${columns} FROM tibotattle_v1_test.chunks
        WHERE participant_id=$1 AND envelope_digest=$2 LIMIT 2`,
      [participantId, envelopeDigest], rows => rows.length === 0 ? null : chunk(rows[0]!));
    },
    current(identity) {
      // Capture scalar identity before any asynchronous pool acquisition.
      const { participantId, deviceId, stream, chunkDay, chunkSeq } = identity;
      return read(`SELECT ${columns} FROM tibotattle_v1_test.chunks
        WHERE participant_id=$1 AND device_id=$2 AND stream=$3 AND chunk_day=$4
          AND chunk_seq=$5 AND superseded_at IS NULL LIMIT 2`,
      [participantId, deviceId, stream, chunkDay, chunkSeq], rows => rows.length === 0 ? null : chunk(rows[0]!));
    },
    acknowledgedThroughDay(participantId, deviceId) {
      return read(`SELECT to_char(MAX(chunk_day), 'YYYY-MM-DD') AS through_day
        FROM tibotattle_v1_test.chunks WHERE participant_id=$1 AND device_id=$2
          AND superseded_at IS NULL`, [participantId, deviceId], rows => {
        if (rows.length !== 1) throw unavailable();
        return rows[0]!.through_day === null ? null : day(rows[0]!.through_day);
      });
    },
  };
}
