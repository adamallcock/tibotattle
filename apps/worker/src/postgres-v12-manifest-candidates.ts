import { ApiError } from "./errors";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";
import { encodeTypedTelemetryId } from "./typed-telemetry-codec";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const MAX_DAY_SPAN_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export interface PostgresV12DayPrincipal {
  readonly participantId: string;
  readonly deviceId: string;
}

export interface PostgresV12DayCandidate {
  manifestId: string;
  day: string;
  manifestDigest: string;
  state: "staged" | "ready";
  expectedChunks: number;
}

export interface ReadPostgresV12DayCandidatesOptions {
  readonly fromDay: string;
  readonly toDay: string;
  readonly limit?: number;
  readonly schema?: PostgresSchemaConfig;
  readonly sourceNamespace: string;
}

interface ManifestRow {
  id: string;
  chunk_day: string;
  manifest_digest: string;
  expected_chunk_count: number;
  state: "staged" | "ready";
}

function invalidRange(): ApiError {
  return new ApiError(400, "SYNC_RANGE_TOO_LARGE");
}

function storageUnavailable(): ApiError {
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function parseDay(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return null;
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch)) return null;
  try {
    return new Date(epoch).toISOString().slice(0, 10) === value ? epoch : null;
  } catch {
    return null;
  }
}

function table(schema: string, name: string): string {
  return `${quotePostgresIdentifier(schema)}."${name}"`;
}

async function assertTypedStorageSourcePins(
  client: PostgresClient,
  schema: string,
  sourceNamespace: string,
  encodedNamespace: Uint8Array,
): Promise<void> {
  const result = await client.query<{ ready: boolean }>(
    `SELECT (
        EXISTS (
          SELECT 1 FROM ${table(schema, "typed_v1_admission_state")} state
          JOIN ${table(schema, "typed_telemetry_namespaces")} namespace
            ON namespace.id = state.namespace_id AND namespace.original_id = $2
          WHERE state.id = 1 AND state.source_namespace = $1
            AND state.runtime_contract_version = 1
        ) AND EXISTS (
          SELECT 1 FROM ${table(schema, "typed_v11_admission_state")} state
          JOIN ${table(schema, "typed_telemetry_namespaces")} namespace
            ON namespace.id = state.namespace_id AND namespace.original_id = $2
          WHERE state.id = 1 AND state.source_namespace = $1
            AND state.runtime_contract_version = 1
        )
      ) AS ready`,
    [sourceNamespace, encodedNamespace],
  );
  if (result.rows[0]?.ready !== true) throw storageUnavailable();
}

/** Read bounded, owner-and-device-scoped v1.2 manifest summaries from PostgreSQL. */
export async function readPostgresV12DayCandidates(
  pool: PostgresPool,
  principal: PostgresV12DayPrincipal,
  options: ReadPostgresV12DayCandidatesOptions,
): Promise<{ candidates: PostgresV12DayCandidate[]; bounded: boolean }> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (typeof principal?.participantId !== "string" || principal.participantId.length === 0
      || typeof principal.deviceId !== "string" || principal.deviceId.length === 0
      || typeof options.sourceNamespace !== "string"
      || options.sourceNamespace.length < 1 || options.sourceNamespace.length > 256) {
    throw storageUnavailable();
  }

  let encodedNamespace: Uint8Array;
  let schema: string;
  try {
    encodedNamespace = encodeTypedTelemetryId(options.sourceNamespace);
    schema = createPostgresSchemaConfig({
      primarySchema: options.schema?.primarySchema,
    }).primarySchema;
  } catch {
    throw storageUnavailable();
  }

  const rows = await withPostgresRead(pool, async (client) => {
    await assertTypedStorageSourcePins(client, schema, options.sourceNamespace, encodedNamespace);
    const start = parseDay(options.fromDay);
    const end = parseDay(options.toDay);
    if (start === null || end === null || end < start
        || end - start > MAX_DAY_SPAN_MILLISECONDS
        || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw invalidRange();
    }
    const result = await client.query<ManifestRow>(
      `SELECT id, to_char(chunk_day, 'YYYY-MM-DD') AS chunk_day,
              manifest_digest, expected_chunk_count, state
         FROM ${table(schema, "telemetry_v12_day_manifests")}
        WHERE participant_id = $1 AND device_id = $2
          AND chunk_day >= $3::date AND chunk_day <= $4::date
        ORDER BY chunk_day ASC, created_at ASC, id ASC
        LIMIT $5`,
      [principal.participantId, principal.deviceId, options.fromDay, options.toDay, limit + 1],
    );
    return [...result.rows];
  }, {
    operation: "typed_v12.manifest_candidates",
    statementTimeoutMilliseconds: 10_000,
    lockTimeoutMilliseconds: 1_000,
    preserveSafeError: (error) => error instanceof ApiError ? error : null,
  });

  const candidates: PostgresV12DayCandidate[] = [];
  for (const row of rows.slice(0, limit)) {
    if (typeof row.id !== "string" || typeof row.chunk_day !== "string"
        || !ISO_DAY.test(row.chunk_day) || !DIGEST.test(row.manifest_digest)
        || (row.state !== "staged" && row.state !== "ready")
        || !Number.isSafeInteger(row.expected_chunk_count)) {
      throw storageUnavailable();
    }
    candidates.push({
      manifestId: row.id,
      day: row.chunk_day,
      manifestDigest: row.manifest_digest,
      state: row.state,
      expectedChunks: row.expected_chunk_count,
    });
  }
  return { candidates, bounded: rows.length > limit };
}
