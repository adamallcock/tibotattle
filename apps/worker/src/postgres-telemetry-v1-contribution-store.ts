import { ApiError } from "./errors";
import {
  quotePostgresIdentifier,
  withPostgresMutation,
  type PostgresClient,
  type PostgresPool,
  type PostgresQueryResult,
  type PostgresSchemaOptions,
} from "./postgres-client";
import {
  MAX_TELEMETRY_V1_CHUNK_RECORDS,
  type TelemetryV1Chunk,
} from "./telemetry-v1";
import { resolvePostgresTelemetryV1Tables } from "./postgres-telemetry-v1-schema";
import type {
  TelemetryV1ContributionReceipt,
  TelemetryV1ContributionStore,
  TelemetryV1ContributionWrite,
} from "./telemetry-v1-contribution-store";

/** Compatibility aliases retained for qualification callers. */
export type PostgresTelemetryV1Pool = PostgresPool;
export type PostgresTelemetryV1Client = PostgresClient;
export type PostgresTelemetryV1QueryResult = PostgresQueryResult<Record<string, unknown>>;

function storageUnavailable(): ApiError {
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function sqlState(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  try {
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

function preserveSafeError(error: unknown): Error | null {
  if (error instanceof ApiError) return error;
  return mapSqlState(error);
}

/**
 * SQLSTATEs are intentionally the only provider detail consulted here. Error
 * text, names, and stack traces can contain schema details or private values.
 */
function mapSqlState(error: unknown): ApiError {
  switch (sqlState(error)) {
    case "P1001":
      return new ApiError(409, "PARTICIPANT_DELETING");
    case "P1002":
      return new ApiError(401, "UPLOAD_AUTH_INVALID");
    case "P1003":
      return new ApiError(429, "CHUNK_ADMISSION_LIMIT_REACHED", {
        responseHeaders: { "retry-after": "60" },
      });
    case "P1004":
      return new ApiError(409, "RECORD_OWNED_BY_OTHER_CHUNK");
    case "P1005":
      return new ApiError(409, "CHUNK_REVISION_CONFLICT");
    case "P1006":
      return new ApiError(403, "TELEMETRY_CONSENT_INVALID");
    case "P1007":
      return new ApiError(409, "TELEMETRY_TRANSPORT_BLOCKED");
    default:
      return storageUnavailable();
  }
}

interface ContributionSnapshot {
  json: string;
  expectedRecords: number;
}

/**
 * Snapshot all provider-neutral fields and serialize them before acquiring a
 * connection. The string passed to PostgreSQL cannot subsequently change if a
 * caller mutates its original input while the transaction is awaiting I/O.
 */
function snapshotContribution(
  input: TelemetryV1ContributionWrite,
): ContributionSnapshot {
  try {
    const chunk: TelemetryV1Chunk = input.chunk;
    const records = chunk.records;
    if (!Array.isArray(records)
        || records.length < 1
        || records.length > MAX_TELEMETRY_V1_CHUNK_RECORDS) {
      throw storageUnavailable();
    }

    const snapshot = {
      participantId: input.participantId,
      deviceId: input.deviceId,
      uploadAuthorizationId: input.uploadAuthorizationId,
      uploadAuthorizationLeaseExpiresAt: input.uploadAuthorizationLeaseExpiresAt,
      chunkId: input.chunkId,
      objectKey: input.objectKey,
      envelopeDigest: input.envelopeDigest,
      chunk,
      supersedes: input.supersedes === null
        ? null
        : { id: input.supersedes.id },
      createdAt: input.createdAt,
    };
    const json = JSON.stringify(snapshot);
    if (typeof json !== "string") throw storageUnavailable();
    return { json, expectedRecords: records.length };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw storageUnavailable();
  }
}

function acceptedRecordCount(
  result: PostgresTelemetryV1QueryResult,
  expectedRecords: number,
): number {
  try {
    if (result === null
        || typeof result !== "object"
        || !Array.isArray(result.rows)
        || result.rows.length !== 1
        || result.rowCount !== 1) {
      throw storageUnavailable();
    }
    const row = result.rows[0];
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw storageUnavailable();
    }
    const accepted = Reflect.get(row, "accepted_records");
    if (!Number.isSafeInteger(accepted) || accepted !== expectedRecords) {
      throw storageUnavailable();
    }
    return accepted;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw storageUnavailable();
  }
}

/**
 * PostgreSQL v1 contribution store. The default is the operational primary
 * schema; test harnesses must pass an explicit validated schema option.
 */
export function createExperimentalPostgresTelemetryV1ContributionStore(
  pool: PostgresTelemetryV1Pool,
  schemaOptions: PostgresSchemaOptions = {},
): TelemetryV1ContributionStore {
  const tables = resolvePostgresTelemetryV1Tables(schemaOptions);
  const insertContribution = `SELECT accepted_records FROM ${tables.insertContribution}($1::jsonb)`;
  return {
    async insert(input): Promise<TelemetryV1ContributionReceipt> {
      // This is synchronous work by construction: no await precedes it.
      const snapshot = snapshotContribution(input);
      try {
        return await withPostgresMutation(pool, async (client) => {
          // The migration binds the function's row types to the configured
          // schema but leaves table lookup to the caller's transaction. Set a
          // validated local path before invoking it; it cannot escape COMMIT.
          await client.query(
            `SET LOCAL search_path TO ${quotePostgresIdentifier(tables.primarySchema)}, pg_catalog`,
          );
          const result = await client.query(insertContribution, [snapshot.json]);
          return {
            acceptedRecords: acceptedRecordCount(result, snapshot.expectedRecords),
          };
        }, {
          operation: "telemetry.v1.insert",
          preserveSafeError,
        });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw storageUnavailable();
      }
    },
  };
}
