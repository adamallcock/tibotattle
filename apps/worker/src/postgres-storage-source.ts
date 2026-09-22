import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import {
  selectV1WinningDevices,
  type V1SourceChunk,
  type V1WinningDevice,
  V1_SOURCE_SELECTION_METHOD_VERSION,
} from "./telemetry-v1-source-selection";
import type {
  StorageJsonValue,
  StoragePageCursor,
  StorageSourcePage,
  StorageSourcePin,
  StorageSourcePinRequest,
  StorageSourceRecord,
  StorageSourceStore,
  StorageSourceStream,
} from "./storage-provider-ports";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresRead,
  PostgresStorageError,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";

const MAX_SOURCE_CHUNKS = 30_000;
const MAX_PAGE = 256;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const HEX64_RE = /^[0-9a-f]{64}$/u;
export const POSTGRES_V1_SOURCE_NAMESPACE = "telemetry-v1";

interface SourceChunkRow extends Record<string, unknown> {
  id: string;
  participant_id: string;
  device_id: string;
  chunk_day: string;
  stream: StorageSourceStream;
  revision: number | string;
  chunk_digest: string;
  parser_version: string;
  accepted_record_count: number | string;
  created_at: string;
}

interface ResolvedSource {
  readonly pin: StorageSourcePin;
  readonly participantId: string;
  readonly participantState: "active" | "deleting";
  readonly ownerState: "active" | "withdrawn" | "erased";
  readonly linkState: "active" | "withdrawn" | "erased";
  readonly effectiveUnavailable: boolean;
  readonly winner: V1WinningDevice | null;
}

function validText(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function validDay(value: unknown): value is string {
  return typeof value === "string" && DATE_RE.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
}

function integer(value: unknown, operation: string): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) throw new PostgresStorageError("invalid", operation);
  return parsed;
}

function text(value: unknown, operation: string): string {
  if (typeof value !== "string") throw new PostgresStorageError("invalid", operation);
  return value;
}

function jsonValue(value: unknown, operation: string): StorageJsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, operation));
  if (typeof value === "object") {
    const result: Record<string, StorageJsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = jsonValue(entry, operation);
    }
    return result;
  }
  throw new PostgresStorageError("invalid", operation);
}

function pinEqual(left: StorageSourcePin, right: StorageSourcePin): boolean {
  return left.sourceId === right.sourceId
    && left.sourceNamespace === right.sourceNamespace
    && left.ownerDigest === right.ownerDigest
    && left.day === right.day
    && left.inputRevision === right.inputRevision
    && left.ownerRevision === right.ownerRevision
    && left.dependencyDigest === right.dependencyDigest
    && left.method === right.method
    && left.authorityEpoch === right.authorityEpoch
    && left.sourceEpoch === right.sourceEpoch
    && left.sequence === right.sequence;
}

function cursorValues(cursor: StoragePageCursor | null): readonly [number | null, string | null] {
  return cursor === null ? [null, null] : [cursor.observedAtMs, cursor.occurrenceId];
}

function emptyPage(pin: StorageSourcePin, status: StorageSourcePage["status"]): StorageSourcePage {
  return Object.freeze({ status, pin, rows: Object.freeze([]), nextCursor: null, complete: true });
}

function sourceChunk(row: SourceChunkRow, operation: string): V1SourceChunk {
  const stream = text(row.stream, operation);
  if (stream !== "quota" && stream !== "usage" && stream !== "session") {
    throw new PostgresStorageError("invalid", operation);
  }
  const chunk: V1SourceChunk = {
    id: text(row.id, operation),
    participant_id: text(row.participant_id, operation),
    device_id: text(row.device_id, operation),
    chunk_day: text(row.chunk_day, operation),
    stream,
    revision: integer(row.revision, operation),
    chunk_digest: text(row.chunk_digest, operation),
    parser_version: text(row.parser_version, operation),
    accepted_record_count: integer(row.accepted_record_count, operation),
    created_at: text(row.created_at, operation),
  };
  if (!validDay(chunk.chunk_day) || !HEX64_RE.test(chunk.chunk_digest)
      || chunk.accepted_record_count < 1 || chunk.revision < 1) {
    throw new PostgresStorageError("invalid", operation);
  }
  return chunk;
}

async function querySourceChunks(
  client: PostgresClient,
  schema: string,
  participantId: string,
  day: string,
  operation: string,
): Promise<readonly V1SourceChunk[]> {
  const primary = quotePostgresIdentifier(schema);
  const result = await client.query<SourceChunkRow>(`
    SELECT id, participant_id, device_id,
           to_char(chunk_day, 'YYYY-MM-DD') AS chunk_day,
           stream, revision, chunk_digest, parser_version,
           accepted_record_count,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
      FROM ${primary}."telemetry_v1_chunks"
     WHERE participant_id=$1 AND chunk_day=$2::date
       AND superseded_at IS NULL AND accepted_record_count > 0
     ORDER BY participant_id, chunk_day, device_id, stream, id
     LIMIT $3`, [participantId, day, MAX_SOURCE_CHUNKS + 1]);
  if (result.rows.length > MAX_SOURCE_CHUNKS) throw new PostgresStorageError("invalid", operation);
  return result.rows.map((row) => sourceChunk(row, operation));
}

async function tableExists(client: PostgresClient, schema: string, table: string): Promise<boolean> {
  const result = await client.query<Record<string, unknown>>(
    "SELECT to_regclass($1) AS relation",
    [`${schema}.${table}`],
  );
  return result.rows[0]?.relation !== null && result.rows[0]?.relation !== undefined;
}

async function hasActiveNewerDomain(
  client: PostgresClient,
  schema: string,
  participantId: string,
  operation: string,
): Promise<boolean> {
  const primary = quotePostgresIdentifier(schema);
  for (const [heads, domains] of [["telemetry_v11_domain_heads", "telemetry_v11_domains"], ["telemetry_v12_domain_heads", "telemetry_v12_domains"]] as const) {
    if (!await tableExists(client, schema, heads) || !await tableExists(client, schema, domains)) continue;
    const result = await client.query<Record<string, unknown>>(`
      SELECT 1
        FROM ${primary}."${heads}" h
        JOIN ${primary}."${domains}" d ON d.id=h.generation_id
       WHERE h.participant_id=$1 AND d.participant_id=$1
       LIMIT 1`, [participantId]);
    if (result.rows.length > 0) return true;
  }
  // A correction revision is effective only after supersession; a v1-only
  // source reader cannot prove that a mixed-format correction is complete.
  return false;
}

async function resolveSource(
  client: PostgresClient,
  schema: string,
  request: StorageSourcePinRequest,
  operation: string,
): Promise<ResolvedSource | null> {
  const primary = quotePostgresIdentifier(schema);
  const sourceResult = await client.query<Record<string, unknown>>(`
    SELECT source_id, authority_epoch
      FROM ${primary}."storage_source_state"
     WHERE singleton=1
     LIMIT 1`);
  const sourceRow = sourceResult.rows[0];
  if (!sourceRow || text(sourceRow.source_id, operation) !== request.sourceId) return null;

  const ownerResult = await client.query<Record<string, unknown>>(`
    SELECT link.participant_id, participant.state AS participant_state,
           link.state AS link_state,
           owner.state AS owner_state, owner.revision AS owner_revision,
           owner.authority_epoch AS owner_authority_epoch,
           versions.revision AS input_revision
      FROM ${primary}."storage_v11_owner_links" link
      JOIN ${primary}."participants" participant ON participant.id=link.participant_id
      LEFT JOIN ${primary}."analytics_owner_state" owner
        ON owner.source_id=$1 AND owner.owner_digest=link.owner_digest
      LEFT JOIN ${primary}."input_versions" versions
        ON versions.participant_id=link.participant_id
     WHERE link.owner_digest=$2
     LIMIT 1`, [request.sourceId, request.ownerDigest]);
  const owner = ownerResult.rows[0];
  if (!owner) return null;
  const participantId = text(owner.participant_id, operation);
  const participantState = text(owner.participant_state, operation);
  const ownerState = text(owner.owner_state, operation);
  const linkState = text(owner.link_state, operation);
  const inputRevision = integer(owner.input_revision, operation);
  const ownerRevision = integer(owner.owner_revision, operation);
  const authorityEpoch = integer(owner.owner_authority_epoch, operation);
  const sourceEpoch = integer(sourceRow.authority_epoch, operation);
  if (!validText(participantId) || !["active", "deleting"].includes(participantState)
      || !["active", "withdrawn", "erased"].includes(ownerState)
      || !["active", "withdrawn", "erased"].includes(linkState)
      || inputRevision < 0 || ownerRevision < 0 || authorityEpoch < 0 || sourceEpoch < 0) {
    throw new PostgresStorageError("invalid", operation);
  }

  const chunks = await querySourceChunks(client, schema, participantId, request.day, operation);
  const winners = selectV1WinningDevices(chunks);
  const winner = winners.find((candidate) => candidate.observed_day === request.day) ?? null;
  const effectiveUnavailable = chunks.some((chunk) => chunk.revision > 1)
    || await hasActiveNewerDomain(client, schema, participantId, operation);
  const dependencyDigest = await sha256Hex(canonicalJson({
    methodVersion: V1_SOURCE_SELECTION_METHOD_VERSION,
    scope: { participantId, day: request.day },
    inputRevision,
    chunks,
    winners,
  }));
  const sequenceResult = await client.query<Record<string, unknown>>(`
    SELECT COALESCE(MAX(sequence), 0)::bigint AS sequence
      FROM ${primary}."storage_ingestion_changes"
     WHERE source_id=$1 AND owner_digest=$2`, [request.sourceId, request.ownerDigest]);
  const sequence = integer(sequenceResult.rows[0]?.sequence, operation);
  const pin: StorageSourcePin = Object.freeze({
    sourceId: request.sourceId,
    sourceNamespace: request.sourceNamespace,
    ownerDigest: request.ownerDigest,
    day: request.day,
    inputRevision,
    ownerRevision,
    dependencyDigest,
    method: request.method,
    authorityEpoch,
    sourceEpoch,
    sequence,
  });
  return Object.freeze({
    pin,
    participantId,
    participantState: participantState as ResolvedSource["participantState"],
    ownerState: ownerState as ResolvedSource["ownerState"],
    linkState: linkState as ResolvedSource["linkState"],
    effectiveUnavailable,
    winner,
  });
}

function quotaPayload(row: Record<string, unknown>, operation: string): StorageJsonValue {
  const result = {
    stream: "quota",
    id: integer(row.id, operation),
    occurrence_id: text(row.occurrence_id, operation),
    observed_at: text(row.observed_at, operation),
    observed_day: text(row.observed_day, operation),
    device_id: text(row.device_id, operation),
    provider: row.provider === null ? null : text(row.provider, operation),
    limit_id: row.limit_id === null ? null : text(row.limit_id, operation),
    plan_type: row.plan_type === null ? null : text(row.plan_type, operation),
    plan_variant: row.plan_variant === null ? null : text(row.plan_variant, operation),
    slot: row.slot === null ? null : text(row.slot, operation),
    used_percent: row.used_percent === null ? null : Number(row.used_percent),
    window_duration_minutes: row.window_duration_minutes === null ? null : integer(row.window_duration_minutes, operation),
    resets_at: row.resets_at === null ? null : text(row.resets_at, operation),
  };
  return jsonValue(result, operation);
}

function genericPayload(row: Record<string, unknown>, operation: string): StorageJsonValue {
  let value: unknown = row.record_json;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { throw new PostgresStorageError("invalid", operation); }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PostgresStorageError("invalid", operation);
  }
  return jsonValue({
    ...(value as Record<string, unknown>),
    stream: text(row.stream, operation),
    id: integer(row.id, operation),
    occurrence_id: text(row.occurrence_id, operation),
    observed_at: text(row.observed_at, operation),
    observed_day: text(row.observed_day, operation),
    device_id: text(row.device_id, operation),
  }, operation);
}

async function sourceRecordFromRow(
  row: Record<string, unknown>,
  pin: StorageSourcePin,
  operation: string,
): Promise<StorageSourceRecord> {
  const payload = row.stream === "quota" ? quotaPayload(row, operation) : genericPayload(row, operation);
  const observedAtMs = integer(row.observed_at_ms, operation);
  const observedDay = text(row.observed_day, operation);
  const occurrenceId = String(integer(row.id, operation));
  if (!validDay(observedDay) || !Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    throw new PostgresStorageError("invalid", operation);
  }
  return Object.freeze({
    occurrenceId,
    observedAtMs,
    observedDay,
    ownerDigest: pin.ownerDigest,
    inputRevision: pin.inputRevision,
    payloadSha256: await sha256Hex(canonicalJson(payload)),
    payload,
  });
}

/**
 * Canonical v1 source adapter. It resolves the owner/source pin and reads one
 * bounded winner-device page in a single repeatable-read transaction. The
 * adapter intentionally has no v1.1/v1.2 fallback: callers that ask for a
 * different method receive `correction_unavailable` rather than a partial
 * whole-day winner.
 */
export function createPostgresStorageSource(
  pool: PostgresPool,
  schemaOptions: PostgresSchemaOptions = {},
): StorageSourceStore {
  const schema = createPostgresSchemaConfig(schemaOptions).primarySchema;
  const primary = quotePostgresIdentifier(schema);
  const run = <T>(operation: string, callback: (client: PostgresClient) => Promise<T>): Promise<T> =>
    withPostgresRead(pool, async (client) => {
      await client.query(`SET LOCAL search_path TO ${primary}, pg_catalog`);
      return callback(client);
    }, { operation });
  return {
    async readPin(input): Promise<StorageSourcePin | null> {
      const operation = "source.read_pin";
      if (!validText(input.sourceId) || input.sourceNamespace !== POSTGRES_V1_SOURCE_NAMESPACE
          || !HEX64_RE.test(input.ownerDigest) || !validDay(input.day) || !validText(input.method)) {
        throw new PostgresStorageError("invalid", operation);
      }
      if (input.method !== V1_SOURCE_SELECTION_METHOD_VERSION) return null;
      const request = Object.freeze({ ...input });
      const resolved = await run(operation, (client) => resolveSource(client, schema, request, operation));
      return resolved?.pin ?? null;
    },

    async readPage(input): Promise<StorageSourcePage> {
      const operation = "source.read_page";
      if (!validText(input.pin.sourceId) || input.pin.sourceNamespace !== POSTGRES_V1_SOURCE_NAMESPACE
          || !HEX64_RE.test(input.pin.ownerDigest) || !validDay(input.pin.day)
          || !validText(input.pin.method) || !validText(input.deviceId)
          || !["quota", "usage", "session"].includes(input.stream)
          || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE) {
        throw new PostgresStorageError("invalid", operation);
      }
      if (input.pin.method !== V1_SOURCE_SELECTION_METHOD_VERSION) {
        return emptyPage(input.pin, "correction_unavailable");
      }
      const pin = Object.freeze({ ...input.pin });
      const cursor = input.cursor === null ? null : Object.freeze({ ...input.cursor });
      const beforeObservedAtMs = input.beforeObservedAtMs;
      if (beforeObservedAtMs !== undefined
          && (!Number.isSafeInteger(beforeObservedAtMs) || beforeObservedAtMs < 0)) {
        throw new PostgresStorageError("invalid", operation);
      }
      const resolved = await run(operation, async (client) => {
        const current = await resolveSource(client, schema, {
          sourceId: pin.sourceId,
          sourceNamespace: pin.sourceNamespace,
          ownerDigest: pin.ownerDigest,
          day: pin.day,
          method: pin.method,
        }, operation);
        if (!current) return emptyPage(pin, "source_unavailable");
        if (!pinEqual(current.pin, pin)) return emptyPage(current.pin, "stale");
        if (current.participantState !== "active" || current.ownerState !== "active" || current.linkState !== "active") {
          return emptyPage(current.pin, "withdrawn");
        }
        if (current.effectiveUnavailable) return emptyPage(current.pin, "correction_unavailable");
        if (!current.winner || current.winner.device_id !== input.deviceId) {
          return emptyPage(current.pin, "available");
        }
        const [cursorMs, cursorId] = cursorValues(cursor);
        const result = await client.query<Record<string, unknown>>(`
          SELECT id,
                 floor(extract(epoch FROM observed_at) * 1000)::bigint AS observed_at_ms,
                 to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
                 to_char(observed_day, 'YYYY-MM-DD') AS observed_day,
                 device_id, stream, occurrence_id,
                 provider, limit_id, plan_type, plan_variant,
                 slot, used_percent, window_duration_minutes,
                 to_char(resets_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS resets_at,
                 record_json
            FROM ${primary}."telemetry_v1_records"
           WHERE participant_id=$1 AND device_id=$2 AND stream=$3
             AND observed_day=$4::date
             AND ($5::bigint IS NULL OR (observed_at,id) >
                  (to_timestamp($5::double precision / 1000.0), $6::bigint))
             AND ($7::bigint IS NULL OR observed_at < to_timestamp($7::double precision / 1000.0))
           ORDER BY observed_at,id
           LIMIT $8`, [current.participantId, input.deviceId, input.stream, pin.day,
          cursorMs, cursorId, beforeObservedAtMs ?? null, input.limit + 1]);
        const selected = result.rows.length <= input.limit ? result.rows : result.rows.slice(0, input.limit);
        const rows = await Promise.all(selected.map((row) => sourceRecordFromRow(row, current.pin, operation)));
        const complete = result.rows.length <= input.limit;
        const last = rows.at(-1);
        return Object.freeze({
          status: "available" as const,
          pin: current.pin,
          rows: Object.freeze(rows),
          nextCursor: complete || !last ? null : Object.freeze({
            observedAtMs: last.observedAtMs,
            occurrenceId: last.occurrenceId,
          }),
          complete,
        });
      });
      return resolved;
    },
  };
}
