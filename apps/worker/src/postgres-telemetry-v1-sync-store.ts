import { ApiError } from "./errors";
import {
  withPostgresRead,
  type PostgresSchemaOptions,
} from "./postgres-client";
import type {
  PostgresTelemetryV1Pool,
  PostgresTelemetryV1QueryResult,
} from "./postgres-telemetry-v1-contribution-store";
import { resolvePostgresTelemetryV1Tables } from "./postgres-telemetry-v1-schema";
import {
  buildTelemetryV1SyncAdmission,
  buildTelemetryV1SyncManifest,
  buildTelemetryV1SyncState,
  MAX_TELEMETRY_V1_SYNC_MANIFEST_CHUNKS,
  MAX_TELEMETRY_V1_SYNC_STATE_CHUNKS,
  telemetryV1SyncAdmissionWindowDay,
  type TelemetryV1SyncAdmission,
  type TelemetryV1SyncAdmissionSnapshot,
  type TelemetryV1SyncChunkDigest,
  type TelemetryV1SyncManifest,
} from "./telemetry-v1-sync-store";
import type { TelemetryV1SyncStore } from "./telemetry-v1-sync-store";

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const COLUMNS = `to_char(chunk_day, 'YYYY-MM-DD') AS chunk_day,
  stream, chunk_seq, chunk_digest, revision, record_count`;

function unavailable(): ApiError {
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function boundsExceeded(): ApiError {
  return new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
}

function day(value: unknown): string {
  if (typeof value !== "string" || !DAY.test(value)) throw unavailable();
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch)
      || new Date(epoch).toISOString().slice(0, 10) !== value) {
    throw unavailable();
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number"
      || !Number.isSafeInteger(value)
      || value < minimum
      || value > maximum) {
    throw unavailable();
  }
  return value;
}

function decodeRow(row: Record<string, unknown>): TelemetryV1SyncChunkDigest {
  const stream = row.stream;
  if (stream !== "usage" && stream !== "quota" && stream !== "session") {
    throw unavailable();
  }
  const chunkDigest = row.chunk_digest;
  if (typeof chunkDigest !== "string" || !DIGEST.test(chunkDigest)) {
    throw unavailable();
  }
  return {
    chunkDay: day(row.chunk_day),
    stream,
    chunkSeq: integer(row.chunk_seq, 0, 99_999),
    chunkDigest,
    revision: integer(row.revision, 1, 1_000_000),
    recordCount: integer(row.record_count, 1, 200),
  };
}

function decodeRows(
  result: PostgresTelemetryV1QueryResult,
  maximumRows: number,
): TelemetryV1SyncChunkDigest[] {
  if (result === null
      || typeof result !== "object"
      || !Array.isArray(result.rows)
      || result.rowCount !== result.rows.length) {
    throw unavailable();
  }
  if (result.rows.length > maximumRows) throw boundsExceeded();
  return result.rows.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw unavailable();
    }
    return decodeRow(row);
  });
}

function decodeAdmission(
  result: PostgresTelemetryV1QueryResult,
): TelemetryV1SyncAdmissionSnapshot {
  if (result === null
      || typeof result !== "object"
      || !Array.isArray(result.rows)
      || result.rowCount !== result.rows.length) {
    throw unavailable();
  }
  if (result.rows.length === 0) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  if (result.rows.length !== 1) throw unavailable();
  const row = result.rows[0];
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw unavailable();
  }
  const acceptedChunks = row.accepted_count;
  if (acceptedChunks !== null
      && (typeof acceptedChunks !== "number"
        || !Number.isSafeInteger(acceptedChunks)
        || acceptedChunks < 0)) {
    throw unavailable();
  }
  const deviceIssuedAt = row.device_issued_at;
  if (typeof deviceIssuedAt !== "string"
      || !Number.isFinite(Date.parse(deviceIssuedAt))) {
    throw unavailable();
  }
  return { acceptedChunks, deviceIssuedAt };
}

async function readCurrentChunkDigests(
  pool: PostgresTelemetryV1Pool,
  tables: ReturnType<typeof resolvePostgresTelemetryV1Tables>,
  participantId: string,
  deviceId: string,
  range: { fromDay: string; toDay: string } | null,
  maximumRows: number,
): Promise<TelemetryV1SyncChunkDigest[]> {
  if (typeof participantId !== "string" || participantId.length === 0
      || typeof deviceId !== "string" || deviceId.length === 0) {
    throw unavailable();
  }
  const values: unknown[] = range === null
    ? [participantId, deviceId, maximumRows + 1]
    : [participantId, deviceId, day(range.fromDay), day(range.toDay), maximumRows + 1];
  const rangePredicate = range === null
    ? ""
    : " AND chunk_day >= $3::date AND chunk_day <= $4::date";
  const limitPlaceholder = range === null ? "$3" : "$5";
  const sql = `SELECT ${COLUMNS}
    FROM ${tables.chunks}
    WHERE participant_id=$1 AND device_id=$2 AND superseded_at IS NULL${rangePredicate}
    ORDER BY chunk_day ASC, stream ASC, chunk_seq ASC
    LIMIT ${limitPlaceholder}`;

  try {
    return await withPostgresRead(pool, async (client) => {
      return decodeRows(await client.query(sql, values), maximumRows);
    }, {
      operation: "telemetry.v1.sync.read",
      preserveSafeError: (error) => error instanceof ApiError ? error : null,
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "LIFECYCLE_BOUNDS_EXCEEDED") {
      throw error;
    }
    throw unavailable();
  }
}

async function readAdmission(
  pool: PostgresTelemetryV1Pool,
  tables: ReturnType<typeof resolvePostgresTelemetryV1Tables>,
  participantId: string,
  deviceId: string,
  nowEpoch: number,
): Promise<TelemetryV1SyncAdmission> {
  if (typeof participantId !== "string" || participantId.length === 0
      || typeof deviceId !== "string" || deviceId.length === 0) {
    throw unavailable();
  }
  // Match D1's invalid-clock handling before acquiring a provider connection.
  const windowDay = telemetryV1SyncAdmissionWindowDay(nowEpoch);
  const sql = `SELECT a.accepted_count AS accepted_count,
    to_char(d.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS device_issued_at
    FROM ${tables.devices} d
    LEFT JOIN ${tables.admissionWindows} a
      ON a.participant_id=$1 AND a.device_id=d.id AND a.window_day=$3::date
    WHERE d.id=$2 AND d.participant_id=$1`;
  try {
    return await withPostgresRead(pool, async (client) => {
      const snapshot = decodeAdmission(await client.query(sql, [
        participantId,
        deviceId,
        windowDay,
      ]));
      // Construct before COMMIT so malformed calculation inputs still roll back.
      return buildTelemetryV1SyncAdmission(snapshot, nowEpoch);
    }, {
      operation: "telemetry.v1.sync.admission",
      preserveSafeError: (error) => error instanceof ApiError ? error : null,
    });
  } catch (error) {
    if (error instanceof ApiError
        && (error.code === "UPLOAD_AUTH_INVALID" || error.code === "INTERNAL_ERROR")) {
      throw error;
    }
    throw unavailable();
  }
}

/**
 * PostgreSQL v1 sync reads. The default is the operational primary schema;
 * test harnesses must pass an explicit validated schema option.
 */
export function createExperimentalPostgresTelemetryV1SyncStore(
  pool: PostgresTelemetryV1Pool,
  schemaOptions: PostgresSchemaOptions = {},
): TelemetryV1SyncStore {
  const tables = resolvePostgresTelemetryV1Tables(schemaOptions);
  return {
    async state(participantId, deviceId) {
      return buildTelemetryV1SyncState(await readCurrentChunkDigests(
        pool,
        tables,
        participantId,
        deviceId,
        null,
        MAX_TELEMETRY_V1_SYNC_STATE_CHUNKS,
      ));
    },
    async manifest(participantId, deviceId, fromDay, toDay): Promise<TelemetryV1SyncManifest> {
      return buildTelemetryV1SyncManifest(
        await readCurrentChunkDigests(
          pool,
          tables,
          participantId,
          deviceId,
          { fromDay, toDay },
          MAX_TELEMETRY_V1_SYNC_MANIFEST_CHUNKS,
        ),
        fromDay,
        toDay,
      );
    },
    admission(participantId, deviceId, nowEpoch) {
      return readAdmission(
        pool,
        tables,
        participantId,
        deviceId,
        nowEpoch === undefined ? Date.now() : nowEpoch,
      );
    },
  };
}
