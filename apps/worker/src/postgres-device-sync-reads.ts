import { ApiError } from "./errors";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresRead,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";
import { sha256Hex } from "./crypto";
import { TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION } from "./telemetry-v1";

// Keep the legacy cursor endpoint's D1 scan guards when serving the same
// journal through PostgreSQL. The extra row detects overflow without an
// unbounded count or second query.
const MAX_SYNC_MANIFEST_CHUNKS = 10_000;
export const MAX_POSTGRES_SYNC_MANIFEST_RANGE_DAYS = 31;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;

interface PostgresDeviceSyncReadOptions {
  readonly schema?: PostgresSchemaOptions;
}

interface CurrentChunkDigestRow {
  readonly chunk_day: string;
  readonly stream: "usage" | "quota" | "session";
  readonly chunk_seq: number;
  readonly revision: number;
  readonly chunk_digest: string;
  readonly record_count: number;
}

function schemaName(options: PostgresDeviceSyncReadOptions): string {
  const config = createPostgresSchemaConfig(options.schema ?? {});
  return quotePostgresIdentifier(config.primarySchema);
}

function table(schema: string, name: string): string {
  return `${schema}.${quotePostgresIdentifier(name)}`;
}

function safeError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

function dateEpoch(value: string): number {
  if (!ISO_DAY.test(value)) throw new ApiError(400, "BODY_INVALID");
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch)) throw new ApiError(400, "BODY_INVALID");
  return epoch;
}

function postgresDate(value: string): string {
  // PostgreSQL uses 1 BC for ISO year 0000. Converting the boundary keeps the
  // route's four-digit proleptic ISO date contract while leaving the indexed
  // date column bare in the predicate.
  return value.startsWith("0000-")
    ? `0001-${value.slice(5)} BC`
    : value;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function postgresLexicalDateBoundary(
  value: string,
  edge: "lower" | "upper",
): string {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const lastDay = daysInMonth(year, month);
  if (day <= lastDay) return postgresDate(value);

  if (edge === "upper") {
    return postgresDate(`${value.slice(0, 8)}${String(lastDay).padStart(2, "0")}`);
  }
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return postgresDate(
    `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`,
  );
}

function isoDayFromPostgres(value: string): string {
  const bc = /^(\d{4}-\d{2}-\d{2}) BC$/u.exec(value);
  if (!bc) {
    if (!ISO_DAY.test(value)) {
      throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    }
    return value;
  }
  const year = Number(value.slice(0, 4));
  if (year !== 1) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return `${String(1 - year).padStart(4, "0")}${value.slice(4, 10)}`;
}

function validateRange(fromDay: string, toDay: string): void {
  const fromEpoch = dateEpoch(fromDay);
  const toEpoch = dateEpoch(toDay);
  if (fromEpoch > toEpoch) throw new ApiError(400, "BODY_INVALID");
  if ((toEpoch - fromEpoch) / DAY_MILLISECONDS + 1
      > MAX_POSTGRES_SYNC_MANIFEST_RANGE_DAYS) {
    throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  }
}

/**
 * Expose the existing bounded PostgreSQL state implementation through the
 * legacy read-adapter module. It includes the D1 route's admission receipt.
 */
export { readPostgresDeviceSyncState } from "./postgres-device-sync";

/** Read the D1-compatible v1.0 manifest for one authenticated participant/device. */
export async function readPostgresDeviceSyncManifest(
  pool: PostgresPool,
  participantId: string,
  deviceId: string,
  fromDay: string,
  toDay: string,
  options: PostgresDeviceSyncReadOptions = {},
) {
  validateRange(fromDay, toDay);
  const schema = schemaName(options);
  const rows = await withPostgresRead(pool, async (client) => {
    const result = await client.query<CurrentChunkDigestRow>(
      `SELECT CASE WHEN chunk_day < DATE '0001-01-01'
                   THEN to_char(chunk_day, 'YYYY-MM-DD') || ' BC'
                   ELSE to_char(chunk_day, 'YYYY-MM-DD') END AS chunk_day,
              stream, chunk_seq, revision, chunk_digest, record_count
         FROM ${table(schema, "telemetry_v1_chunks")}
        WHERE participant_id = $1 AND device_id = $2
          AND superseded_at IS NULL
          AND chunk_day >= $3::date AND chunk_day <= $4::date
        ORDER BY chunk_day ASC, stream COLLATE "C" ASC, chunk_seq ASC
        LIMIT $5`,
      [participantId, deviceId,
        postgresLexicalDateBoundary(fromDay, "lower"),
        postgresLexicalDateBoundary(toDay, "upper"),
        MAX_SYNC_MANIFEST_CHUNKS + 1],
    );
    if (result.rows.length > MAX_SYNC_MANIFEST_CHUNKS) {
      throw new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
    }
    return [...result.rows];
  }, {
    operation: "device_sync.manifest",
    statementTimeoutMilliseconds: 10_000,
    lockTimeoutMilliseconds: 1_000,
    preserveSafeError: safeError,
  });

  const days = new Map<string, CurrentChunkDigestRow[]>();
  for (const row of rows) {
    const day = isoDayFromPostgres(row.chunk_day);
    const chunks = days.get(day);
    if (chunks) chunks.push(row);
    else days.set(day, [row]);
  }
  const orderedDays = [...days.entries()].sort(([left], [right]) =>
    left.localeCompare(right));
  return Object.freeze({
    schemaVersion: "device-sync-manifest-v1.0" as const,
    contractVersion: TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
    fromDay,
    toDay,
    days: await Promise.all(orderedDays.map(async ([day, chunks]) => ({
      day,
      dayDigest: await sha256Hex(chunks.map((chunk) => chunk.chunk_digest).join("")),
      chunks: chunks.map((chunk) => ({
        chunkId: `${chunk.stream}:${day}:${chunk.chunk_seq}`,
        revision: chunk.revision,
        chunkDigest: chunk.chunk_digest,
        recordCount: chunk.record_count,
      })),
    }))),
  });
}
