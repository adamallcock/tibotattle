import { ApiError } from "./errors";
import {
  withPostgresRead,
  type PostgresSchemaOptions,
} from "./postgres-client";
import type { PostgresTelemetryV1Pool } from "./postgres-telemetry-v1-contribution-store";
import { resolvePostgresTelemetryV1Tables } from "./postgres-telemetry-v1-schema";
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

function preserveSafeError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

/**
 * Reads. Callers must authenticate before invoking this trusted port. Envelope
 * replay is participant-wide, including superseded rows, as on D1; current
 * identity and acknowledgement are device-scoped.
 * No result here authorizes quarantine deletion or owner erasure.
 */
export function createExperimentalPostgresTelemetryV1ContributionReader(
  pool: PostgresTelemetryV1Pool,
  schemaOptions: PostgresSchemaOptions = {},
): TelemetryV1ContributionReader {
  const tables = resolvePostgresTelemetryV1Tables(schemaOptions);
  async function read<T>(
    sql: string,
    values: unknown[],
    decode: (rows: readonly Record<string, unknown>[]) => T,
  ): Promise<T> {
    try {
      return await withPostgresRead(pool, async (client) => {
        const response = await client.query(sql, values);
        if (!Array.isArray(response.rows)
            || response.rowCount !== response.rows.length
            || response.rows.length > 1) throw unavailable();
        return decode(response.rows);
      }, {
        operation: "telemetry.v1.read",
        preserveSafeError,
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  }
  return {
    byEnvelope(participantId, envelopeDigest) {
      return read(`SELECT ${columns} FROM ${tables.chunks}
        WHERE participant_id=$1 AND envelope_digest=$2 LIMIT 2`,
      [participantId, envelopeDigest], rows => rows.length === 0 ? null : chunk(rows[0]!));
    },
    current(identity) {
      // Capture scalar identity before any asynchronous pool acquisition.
      const { participantId, deviceId, stream, chunkDay, chunkSeq } = identity;
      return read(`SELECT ${columns} FROM ${tables.chunks}
        WHERE participant_id=$1 AND device_id=$2 AND stream=$3 AND chunk_day=$4
          AND chunk_seq=$5 AND superseded_at IS NULL LIMIT 2`,
      [participantId, deviceId, stream, chunkDay, chunkSeq], rows => rows.length === 0 ? null : chunk(rows[0]!));
    },
    acknowledgedThroughDay(participantId, deviceId) {
      return read(`SELECT to_char(MAX(chunk_day), 'YYYY-MM-DD') AS through_day
        FROM ${tables.chunks} WHERE participant_id=$1 AND device_id=$2
          AND superseded_at IS NULL`, [participantId, deviceId], rows => {
        if (rows.length !== 1) throw unavailable();
        return rows[0]!.through_day === null ? null : day(rows[0]!.through_day);
      });
    },
  };
}
