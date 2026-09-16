import { ApiError } from "./errors";
import {
  MAX_TELEMETRY_V1_CHUNK_RECORDS,
  type TelemetryV1Chunk,
} from "./telemetry-v1";
import type {
  TelemetryV1ContributionReceipt,
  TelemetryV1ContributionStore,
  TelemetryV1ContributionWrite,
} from "./telemetry-v1-contribution-store";

/**
 * Structural subset of a node-postgres pool. The qualification laboratory
 * supplies the driver; this candidate deliberately has no pg runtime import.
 */
export interface PostgresTelemetryV1Pool {
  connect(): Promise<PostgresTelemetryV1Client>;
}

export interface PostgresTelemetryV1Client {
  query(
    text: string,
    values?: unknown[],
  ): Promise<PostgresTelemetryV1QueryResult>;
  release(discard?: boolean): void | Promise<void>;
}

export interface PostgresTelemetryV1QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

const BEGIN = "BEGIN";
const STATEMENT_TIMEOUT = "SET LOCAL statement_timeout='10s'";
const LOCK_TIMEOUT = "SET LOCAL lock_timeout='5s'";
const INSERT_CONTRIBUTION =
  "SELECT accepted_records FROM tibotattle_v1_test.insert_contribution($1::jsonb)";
const COMMIT = "COMMIT";
const ROLLBACK = "ROLLBACK";

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

async function releaseClient(
  client: PostgresTelemetryV1Client,
  discard: boolean,
): Promise<boolean> {
  try {
    await client.release(discard);
    return true;
  } catch {
    return false;
  }
}

/**
 * Qualification-only PostgreSQL candidate. The function is deliberately
 * pinned to the test schema and no production Worker composition imports this
 * adapter; the schema does not claim full D1 projection or graph parity.
 */
export function createExperimentalPostgresTelemetryV1ContributionStore(
  pool: PostgresTelemetryV1Pool,
): TelemetryV1ContributionStore {
  return {
    async insert(input): Promise<TelemetryV1ContributionReceipt> {
      // This is synchronous work by construction: no await precedes it.
      const snapshot = snapshotContribution(input);
      let client: PostgresTelemetryV1Client;
      try {
        client = await pool.connect();
      } catch {
        throw storageUnavailable();
      }

      let receipt: TelemetryV1ContributionReceipt | null = null;
      let commitAttempted = false;
      try {
        await client.query(BEGIN);
        await client.query(STATEMENT_TIMEOUT);
        await client.query(LOCK_TIMEOUT);
        const result = await client.query(INSERT_CONTRIBUTION, [snapshot.json]);
        receipt = {
          acceptedRecords: acceptedRecordCount(result, snapshot.expectedRecords),
        };
        // Set this immediately before COMMIT: a rejection after this point has
        // an uncertain outcome and the connection must be destroyed.
        commitAttempted = true;
        await client.query(COMMIT);
      } catch (error) {
        let rollbackFailed = false;
        try {
          await client.query(ROLLBACK);
        } catch {
          rollbackFailed = true;
        }
        const discarded = commitAttempted || rollbackFailed;
        const released = await releaseClient(client, discarded);
        if (!released || discarded) throw storageUnavailable();
        throw mapSqlState(error);
      }

      // A successful commit is known; release failures still fail closed, but
      // are handled outside the transaction catch to avoid a second release or
      // an invalid rollback after COMMIT.
      if (!await releaseClient(client, false) || receipt === null) {
        throw storageUnavailable();
      }
      return receipt;
    },
  };
}
