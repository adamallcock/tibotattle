import type {
  AnalyticalCheckpoint,
  AnalyticalWorkClaim,
  AnalyticalWorkHead,
  AnalyticalWorkIdentity,
  AnalyticalWorkStore,
  PreparedSourceCommit,
  PreparedSourceHead,
  PreparedSourcePageRequest,
  PreparedSourceStore,
  StorageAdminStore,
  StorageAnalyticsChange,
  StorageAnalyticsDeliveryStore,
  StorageCollectionControls,
  StorageJsonValue,
  StorageLifecycleStore,
  StorageOwnerRoute,
  StorageOwnerRouter,
  StoragePageCursor,
  StoragePublicationAuthority,
  StoragePublicationCapture,
  StoragePublicationStore,
  StorageQuarantineRegistration,
  StorageReleaseGuardNonceStore,
  StorageSourcePage,
  StorageSourcePin,
  StorageSourceRecord,
} from "./storage-provider-ports";
import {
  createPostgresSchemaConfig,
  normalizePostgresError as normalizeSharedPostgresError,
  PostgresStorageError as SharedPostgresStorageError,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresPool,
  type PostgresQueryResult,
  type PostgresSchemaOptions,
} from "./postgres-client";
import {
  ReleaseNonceStorageUnavailableError,
  type ReleaseNonceConsumeOptions,
} from "./release-nonce-store";

/**
 * The PostgreSQL driver is supplied by the host composition root.  Keeping
 * this tiny driver boundary here avoids importing a Node-only client into the
 * Worker bundle.  All statements below are fixed by an operation adapter;
 * callers never pass arbitrary SQL through a storage port.
 */
interface PostgresStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface PostgresTransactionExecutor {
  execute<Row extends object = Record<string, unknown>>(
    query: PostgresStatement,
  ): Promise<PostgresQueryResult<Row>>;
}

/**
 * A storage adapter is always bound to one validated schema.  The transaction
 * helper sets this search path with SET LOCAL after BEGIN, so a host pool does
 * not need ambient connection state and an isolated qualification schema is
 * exercised through the same operation path as production.
 */
interface PostgresStorageDatabase {
  readonly pool: PostgresPool;
  readonly schema: string;
}

function storageDatabase(pool: PostgresPool, options: PostgresSchemaOptions = {}): PostgresStorageDatabase {
  const schema = createPostgresSchemaConfig(options).primarySchema;
  return storageDatabaseForSchema(pool, schema);
}

function storageDatabaseForSchema(pool: PostgresPool, schema: string): PostgresStorageDatabase {
  return Object.freeze({ pool, schema });
}

function setLocalSearchPath(schema: string): string {
  return `SET LOCAL search_path TO ${quotePostgresIdentifier(schema)}, pg_catalog`;
}

type PostgresResult<Row extends object = Record<string, unknown>> = PostgresQueryResult<Row> & {
  readonly rowCount: number;
};

function resultWithCount<Row extends object>(result: PostgresQueryResult<Row>): PostgresResult<Row> {
  return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
}

function transactionExecutor(client: {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PostgresQueryResult<Row>>;
}): PostgresTransactionExecutor {
  return {
    async execute<Row extends object = Record<string, unknown>>(query: PostgresStatement): Promise<PostgresQueryResult<Row>> {
      return client.query<Row>(query.text, [...query.values]);
    },
  };
}

export type PostgresStorageFailureCode =
  | "conflict"
  | "unavailable"
  | "timeout"
  | "source_stale"
  | "withdrawn"
  | "incomplete"
  | "bounds"
  | "not_found";

export class PostgresStorageError extends SharedPostgresStorageError {
  readonly storageCode: PostgresStorageFailureCode;
  constructor(
    code: PostgresStorageFailureCode,
    operation: string,
    options: { readonly retryable?: boolean } = {},
  ) {
    const sharedCode = code === "conflict" || code === "source_stale"
      ? "conflict"
      : code === "timeout" ? "timeout"
        : code === "unavailable" ? "unavailable" : "invalid";
    super(sharedCode, operation, options);
    this.name = "PostgresStorageError";
    this.storageCode = code;
    // This adapter's richer domain classifications ride on the one shared,
    // provider-sanitized error class. No provider cause/message is retained.
  }
}

/**
 * SQLSTATE mapping is deliberately closed.  Provider messages never cross a
 * route boundary and commit acknowledgement loss is surfaced as unavailable;
 * a destructive caller must not retry it as if it were a known rollback.
 */
export function normalizePostgresError(error: unknown, operation: string): PostgresStorageError {
  if (error instanceof PostgresStorageError) return error;
  const normalized = normalizeSharedPostgresError(error, operation);
  if (normalized.code === "conflict") {
    return new PostgresStorageError("conflict", operation, { retryable: normalized.retryable });
  }
  if (normalized.code === "timeout") {
    return new PostgresStorageError("timeout", operation, { retryable: normalized.retryable });
  }
  if (normalized.code === "invalid") return new PostgresStorageError("incomplete", operation);
  return new PostgresStorageError("unavailable", operation, { retryable: normalized.retryable });
}

function statement(text: string, ...values: readonly unknown[]): PostgresStatement {
  return Object.freeze({ text, values: Object.freeze(values) });
}

function safeInteger(value: unknown, operation: string): number {
  const number = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number)) throw new PostgresStorageError("incomplete", operation);
  return number;
}

function safeString(value: unknown, operation: string): string {
  if (typeof value !== "string") throw new PostgresStorageError("incomplete", operation);
  return value;
}

function safeDay(value: unknown, operation: string): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new PostgresStorageError("incomplete", operation);
    // node-postgres maps PostgreSQL `date` to local midnight.  UTC formatting
    // would move a valid date to the previous day in a positive-offset worker
    // process, so retain the calendar fields and reserve ISO formatting for
    // timestamptz instants.
    const year = value.getFullYear();
    const month = value.getMonth() + 1;
    const day = value.getDate();
    const result = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(result)
        || !Number.isFinite(Date.parse(`${result}T00:00:00.000Z`))) {
      throw new PostgresStorageError("incomplete", operation);
    }
    return result;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new PostgresStorageError("incomplete", operation);
  }
  return value;
}

function safeSha256(value: unknown, operation: string): string {
  const digest = safeString(value, operation);
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new PostgresStorageError("incomplete", operation);
  return digest;
}

function parseJson(value: unknown, operation: string): StorageJsonValue {
  if (typeof value !== "string") throw new PostgresStorageError("incomplete", operation);
  try {
    return JSON.parse(value) as StorageJsonValue;
  } catch (error) {
    throw new PostgresStorageError("incomplete", operation);
  }
}

function boundedJson(value: unknown, maximumBytes: number, operation: string): string {
  if (typeof value !== "string" || value.length === 0
      || new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new PostgresStorageError("bounds", operation);
  }
  try {
    JSON.parse(value);
  } catch {
    throw new PostgresStorageError("incomplete", operation);
  }
  return value;
}

async function sha256Text(value: string, operation: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new PostgresStorageError("unavailable", operation);
  }
}

function validateCheckpoint(checkpoint: AnalyticalCheckpoint, operation: string): AnalyticalCheckpoint {
  const parts = Object.freeze(checkpoint.parts.map((part) => Object.freeze({ ...part })));
  if (parts.length > 1024 || checkpoint.generation.length === 0
      || checkpoint.generation.length > 256
      || (checkpoint.expectedHead !== null && (checkpoint.expectedHead.length === 0 || checkpoint.expectedHead.length > 256))
      || typeof checkpoint.complete !== "boolean") {
    throw new PostgresStorageError("bounds", operation);
  }
  const seen = new Set<number>();
  let previous = -1;
  for (const part of parts) {
    if (!Number.isSafeInteger(part.index) || part.index < 0 || part.index > 1023
        || seen.has(part.index) || part.index !== previous + 1
        || !/^[0-9a-f]{64}$/u.test(part.sha256)) {
      throw new PostgresStorageError("bounds", operation);
    }
    boundedJson(part.payloadJson, 128 * 1024, operation);
    seen.add(part.index);
    previous = part.index;
  }
  return Object.freeze({
    generation: checkpoint.generation,
    expectedHead: checkpoint.expectedHead,
    controlJson: boundedJson(checkpoint.controlJson, 16 * 1024, operation),
    manifestJson: boundedJson(checkpoint.manifestJson, 64 * 1024, operation),
    parts,
    complete: checkpoint.complete,
  });
}

function cursorValues(cursor: StoragePageCursor | null): readonly [number, string] {
  return cursor === null ? [-1, ""] : [cursor.observedAtMs, cursor.occurrenceId];
}

function sourceRecord(row: Record<string, unknown>, operation: string): StorageSourceRecord {
  return Object.freeze({
    occurrenceId: safeString(row.occurrence_id, operation),
    observedAtMs: safeInteger(row.observed_at_ms, operation),
    observedDay: safeDay(row.observed_day, operation),
    ownerDigest: safeString(row.owner_digest, operation),
    inputRevision: safeInteger(row.input_revision, operation),
    payloadSha256: safeSha256(row.payload_sha256, operation),
    payload: parseJson(row.payload_json, operation),
  });
}

function sourcePin(row: Record<string, unknown>, operation: string): StorageSourcePin {
  const values = {
    // Every persisted component is required.  Falling back to the caller's
    // requested pin would let a row with missing authority metadata appear to
    // prove that pin and would turn an incomplete migration into a valid read.
    sourceId: safeString(row.source_id, operation),
    sourceNamespace: safeString(row.source_namespace, operation),
    ownerDigest: safeString(row.owner_digest, operation),
    day: safeDay(row.day, operation),
    inputRevision: safeInteger(row.input_revision, operation),
    ownerRevision: safeInteger(row.owner_revision, operation),
    dependencyDigest: safeString(row.dependency_digest, operation),
    method: safeString(row.method, operation),
    authorityEpoch: safeInteger(row.authority_epoch, operation),
    sourceEpoch: safeInteger(row.source_epoch, operation),
    sequence: safeInteger(row.sequence, operation),
  } satisfies StorageSourcePin;
  return Object.freeze(values);
}

function assertSourcePin(actual: StorageSourcePin, expected: StorageSourcePin, operation: string): void {
  const fields: readonly (keyof StorageSourcePin)[] = [
    "sourceId", "sourceNamespace", "ownerDigest", "day", "inputRevision",
    "ownerRevision", "dependencyDigest", "method", "authorityEpoch",
    "sourceEpoch", "sequence",
  ];
  for (const field of fields) {
    if (actual[field] !== expected[field]) {
      throw new PostgresStorageError("source_stale", operation);
    }
  }
}

async function assertPreparedRowEqual(
  transaction: PostgresTransactionExecutor,
  operation: string,
  pin: StorageSourcePin,
  generation: string,
  row: StorageSourceRecord,
  payloadJson: string,
): Promise<void> {
  const existing = await execute<Record<string, unknown>>(transaction, operation, statement(`
    SELECT observed_at_ms, input_revision, payload_json, payload_sha256,
           owner_digest, observed_day
      FROM analytics_prepared_source_rows
     WHERE source_id=$1 AND owner_digest=$2 AND observed_day=$3
       AND generation=$4 AND occurrence_id=$5
     FOR UPDATE`, pin.sourceId, pin.ownerDigest, pin.day, generation, row.occurrenceId));
  const existingRow = existing.rows[0];
  if (!existingRow
      || safeInteger(existingRow.observed_at_ms, operation) !== row.observedAtMs
      || safeInteger(existingRow.input_revision, operation) !== row.inputRevision
      || safeString(existingRow.payload_json, operation) !== payloadJson
      || safeSha256(existingRow.payload_sha256, operation) !== row.payloadSha256
      || safeString(existingRow.owner_digest, operation) !== row.ownerDigest
      || safeDay(existingRow.observed_day, operation) !== row.observedDay) {
    throw new PostgresStorageError("conflict", operation, { retryable: false });
  }
}

function cursorEqual(left: StoragePageCursor | null, right: StoragePageCursor | null): boolean {
  return left === null || right === null
    ? left === right
    : left.observedAtMs === right.observedAtMs && left.occurrenceId === right.occurrenceId;
}

function mapSourcePage(
  rows: readonly Record<string, unknown>[],
  pin: StorageSourcePin,
  status: StorageSourcePage["status"],
  limit: number,
  operation: string,
): StorageSourcePage {
  if (rows.length > limit + 1) throw new PostgresStorageError("bounds", operation);
  const complete = rows.length <= limit;
  const selected = complete ? rows : rows.slice(0, limit);
  const mapped = selected.map((row) => sourceRecord(row, operation));
  const last = mapped.at(-1);
  return Object.freeze({
    status,
    pin,
    rows: Object.freeze(mapped),
    nextCursor: complete || !last ? null : Object.freeze({
      observedAtMs: last.observedAtMs,
      occurrenceId: last.occurrenceId,
    }),
    complete,
  });
}

function normalizeLimit(limit: number, maximum: number, operation: string): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new PostgresStorageError("bounds", operation);
  }
  return limit;
}

async function execute<Row extends object = Record<string, unknown>>(
  database: PostgresStorageDatabase | PostgresTransactionExecutor,
  operation: string,
  query: PostgresStatement,
): Promise<PostgresResult<Row>> {
  try {
    if ("pool" in database) {
      return resultWithCount(await withPostgresRead(
        database.pool,
        async (client) => {
          await client.query(setLocalSearchPath(database.schema));
          return client.query<Row>(query.text, [...query.values]);
        },
        { operation },
      ));
    }
    return resultWithCount(await database.execute<Row>(query));
  } catch (error) {
    throw normalizePostgresError(error, operation);
  }
}

function inTransaction<T>(
  database: PostgresStorageDatabase,
  operation: string,
  callback: (transaction: PostgresTransactionExecutor) => Promise<T>,
): Promise<T> {
  return withPostgresMutation(
    database.pool,
    async (client) => {
      await client.query(setLocalSearchPath(database.schema));
      return callback(transactionExecutor(client));
    },
    { operation },
  ).catch((error: unknown) => {
    throw normalizePostgresError(error, operation);
  });
}

async function executeMutation<Row extends object = Record<string, unknown>>(
  database: PostgresStorageDatabase,
  operation: string,
  query: PostgresStatement,
): Promise<PostgresResult<Row>> {
  try {
    return resultWithCount(await withPostgresMutation(
      database.pool,
      async (client) => {
        await client.query(setLocalSearchPath(database.schema));
        return client.query<Row>(query.text, [...query.values]);
      },
      { operation },
    ));
  } catch (error) {
    throw normalizePostgresError(error, operation);
  }
}

/** PostgreSQL implementation of the prepared source day protocol. */
export function createPostgresPreparedSourceStore(
  pool: PostgresPool,
  schemaOptions: PostgresSchemaOptions = {},
): PreparedSourceStore {
  const database = storageDatabase(pool, schemaOptions);
  return {
    async readPage(input: PreparedSourcePageRequest): Promise<StorageSourcePage> {
      const operation = "prepared_source.read_page";
      const limit = normalizeLimit(input.limit, 256, operation);
      const [cursorMs, cursorId] = cursorValues(input.cursor);
      // Snapshot the caller-owned values before the first await.  In
      // particular, do not let a mutable pin/cursor be changed while the
      // head and row queries are in flight.
      const pin = Object.freeze({ ...input.pin });
      const generation = String(input.generation);
      const readerPolicy = String(input.readerPolicy);
      if (generation.length === 0 || readerPolicy.length === 0) {
        throw new PostgresStorageError("bounds", operation);
      }
      try {
        return await inTransaction(database, operation, async (transaction) => {
          // Commit locks owner then head.  Read in the same order so a
          // concurrent owner move cannot deadlock an otherwise bounded read.
          const ownerResult = await execute<Record<string, unknown>>(transaction, operation, statement(`
            SELECT state, revision, authority_epoch
              FROM analytics_owner_state
             WHERE source_id = $1 AND owner_digest = $2
             LIMIT 1
             FOR SHARE`, pin.sourceId, pin.ownerDigest));
          const owner = ownerResult.rows[0];
          if (!owner) return mapSourcePage([], pin, "source_unavailable", limit, operation);

          // The head is authoritative.  A row join by itself can silently
          // turn an empty stale/withdrawn source into an available page.
          const headResult = await execute<Record<string, unknown>>(transaction, operation, statement(`
            SELECT generation, state, progress_revision, next_cursor_time,
                   next_cursor_id, rows_written, source_id, source_namespace,
                   owner_digest, day, input_revision, owner_revision,
                   dependency_digest, method, authority_epoch, source_epoch,
                   sequence
              FROM analytics_prepared_source_heads
             WHERE source_id = $1 AND owner_digest = $2 AND day = $3
               AND generation = $4
             LIMIT 1
             FOR SHARE`, pin.sourceId, pin.ownerDigest, pin.day, generation));
          const head = headResult.rows[0];
          if (!head) {
            return mapSourcePage([], pin, "source_unavailable", limit, operation);
          }
          const authoritativePin = sourcePin(head, operation);
          try {
            assertSourcePin(authoritativePin, pin, operation);
          } catch (error) {
            if (error instanceof PostgresStorageError && error.storageCode === "source_stale") {
              return mapSourcePage([], authoritativePin, "stale", limit, operation);
            }
            throw error;
          }

          const ownerState = safeString(owner.state, operation);
          if (ownerState === "withdrawn" || ownerState === "erased") {
            return mapSourcePage([], authoritativePin, "withdrawn", limit, operation);
          }
          if (ownerState !== "active") {
            return mapSourcePage([], authoritativePin, "source_unavailable", limit, operation);
          }
          if (safeInteger(owner.revision, operation) !== authoritativePin.ownerRevision
              || safeInteger(owner.authority_epoch, operation) !== authoritativePin.authorityEpoch) {
            return mapSourcePage([], authoritativePin, "stale", limit, operation);
          }

          const headState = safeString(head.state, operation);
          if (headState === "discarding" || headState === "retired") {
            return mapSourcePage([], authoritativePin, "withdrawn", limit, operation);
          }
          if (headState !== "ready") {
            return mapSourcePage([], authoritativePin, "correction_unavailable", limit, operation);
          }

          const result = await execute<Record<string, unknown>>(transaction, operation, statement(`
            SELECT r.occurrence_id, r.observed_at_ms, r.observed_day,
                   r.owner_digest, r.input_revision, r.payload_json,
                   r.payload_sha256,
                   h.source_id, h.source_namespace, h.day, h.input_revision,
                   h.owner_revision,
                   h.dependency_digest, h.method, h.authority_epoch,
                   h.source_epoch, h.sequence
              FROM analytics_prepared_source_rows r
              JOIN analytics_prepared_source_heads h
                ON h.source_id = r.source_id AND h.owner_digest = r.owner_digest
               AND h.day = r.observed_day AND h.generation = r.generation
             WHERE r.source_id = $1 AND r.owner_digest = $2 AND r.observed_day = $3
               AND r.generation = $4
               AND (r.observed_at_ms, r.occurrence_id) > ($5, $6)
             ORDER BY r.observed_at_ms, r.occurrence_id
             LIMIT $7`, authoritativePin.sourceId, authoritativePin.ownerDigest,
          authoritativePin.day, generation, cursorMs, cursorId, limit + 1));
          for (const row of result.rows) {
            assertSourcePin(sourcePin(row, operation), authoritativePin, operation);
          }
          return mapSourcePage(result.rows, authoritativePin, "available", limit, operation);
        });
      } catch (error) {
        throw normalizePostgresError(error, operation);
      }
    },

    async readHead(input): Promise<PreparedSourceHead | null> {
      const operation = "prepared_source.read_head";
      const result = await execute<Record<string, unknown>>(database, operation, statement(`
        SELECT generation, state, progress_revision, next_cursor_time,
               next_cursor_id, rows_written, source_id, source_namespace,
               owner_digest, day, input_revision, owner_revision,
               dependency_digest, method, authority_epoch, source_epoch, sequence
          FROM analytics_prepared_source_heads
         WHERE source_id = $1 AND owner_digest = $2 AND day = $3 AND generation = $4
         LIMIT 1`, input.sourceId, input.ownerDigest, input.day, input.generation));
      const row = result.rows[0];
      if (!row) return null;
      const state = safeString(row.state, operation);
      if (!["building", "ready", "discarding", "retired"].includes(state)) {
        throw new PostgresStorageError("incomplete", operation);
      }
      return Object.freeze({
        generation: safeString(row.generation, operation),
        state: state as PreparedSourceHead["state"],
        progressRevision: safeInteger(row.progress_revision, operation),
        nextCursor: row.next_cursor_time === null || row.next_cursor_time === undefined
          ? null
          : Object.freeze({
            observedAtMs: safeInteger(row.next_cursor_time, operation),
            occurrenceId: safeString(row.next_cursor_id, operation),
          }),
        rowsWritten: safeInteger(row.rows_written, operation),
            sourcePin: sourcePin(row, operation),
      });
    },

    async commitPage(input: PreparedSourceCommit): Promise<PreparedSourceHead> {
      const operation = "prepared_source.commit_page";
      const pin = Object.freeze({ ...input.pin });
      const rows = Object.freeze(input.rows.map((row) => Object.freeze({ ...row })));
      // Capture payload JSON synchronously with the other caller-owned
      // preconditions. The stored digest is then checked against this frozen
      // representation before any transaction begins, so a mutable payload
      // cannot change between validation and INSERT.
      const payloadJson = Object.freeze(rows.map((row) => {
        let encoded: string;
        try {
          encoded = JSON.stringify(row.payload);
        } catch {
          throw new PostgresStorageError("bounds", operation);
        }
        return boundedJson(encoded, 256 * 1024, operation);
      }));
      const generation = String(input.generation);
      const expectedProgressRevision = input.expectedProgressRevision;
      const nextCursor = input.nextCursor === null ? null : Object.freeze({ ...input.nextCursor });
      const complete = input.complete;
      // Keep the page digest in the public contract for caller replay
      // identity, while each occurrence's payload digest remains the
      // idempotency/conflict key checked below.
      safeSha256(input.rowDigest, operation);
      if (generation.length === 0 || !Number.isSafeInteger(expectedProgressRevision)
          || expectedProgressRevision < 0
          || typeof complete !== "boolean") {
        throw new PostgresStorageError("bounds", operation);
      }
      if (rows.length > 256) throw new PostgresStorageError("bounds", operation);
      const occurrenceIds = new Set<string>();
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!;
        if (row.ownerDigest !== pin.ownerDigest || row.observedDay !== pin.day
            || row.inputRevision !== pin.inputRevision || !/^[0-9a-f]{64}$/u.test(row.payloadSha256)
            || row.occurrenceId.length === 0 || occurrenceIds.has(row.occurrenceId)) {
          throw new PostgresStorageError("source_stale", operation);
        }
        occurrenceIds.add(row.occurrenceId);
        if (await sha256Text(payloadJson[index]!, operation) !== row.payloadSha256) {
          throw new PostgresStorageError("incomplete", operation);
        }
      }
      try {
        return await inTransaction(database, operation, async (transaction) => {
          // Both authority and head are locked before any occurrence write.
          // The same pin and generation are then repeated on the head UPDATE,
          // so a route/owner move cannot race this durable mutation.
          const current = await execute<Record<string, unknown>>(transaction, operation, statement(`
            SELECT state, revision, authority_epoch
              FROM analytics_owner_state
             WHERE source_id=$1 AND owner_digest=$2
             LIMIT 1
             FOR UPDATE`, pin.sourceId, pin.ownerDigest));
          const owner = current.rows[0];
          if (!owner || safeString(owner.state, operation) !== "active"
              || safeInteger(owner.revision, operation) !== pin.ownerRevision
              || safeInteger(owner.authority_epoch, operation) !== pin.authorityEpoch) {
            throw new PostgresStorageError("source_stale", operation);
          }
          const head = await execute<Record<string, unknown>>(transaction, operation, statement(`
            SELECT generation, state, progress_revision, next_cursor_time,
                   next_cursor_id, rows_written, source_id, source_namespace,
                   owner_digest, day, input_revision, owner_revision,
                   dependency_digest, method, authority_epoch, source_epoch,
                   sequence
              FROM analytics_prepared_source_heads
             WHERE source_id=$1 AND owner_digest=$2 AND day=$3 AND generation=$4
             LIMIT 1
             FOR UPDATE`, pin.sourceId, pin.ownerDigest, pin.day, generation));
          const headRow = head.rows[0];
          if (!headRow) throw new PostgresStorageError("conflict", operation, { retryable: true });
          const authoritativePin = sourcePin(headRow, operation);
          assertSourcePin(authoritativePin, pin, operation);
          if (safeString(headRow.generation, operation) !== generation) {
            throw new PostgresStorageError("conflict", operation, { retryable: true });
          }
          const headState = safeString(headRow.state, operation);
          const currentProgressRevision = safeInteger(headRow.progress_revision, operation);
          if (headState === "ready") {
            // A ready generation is immutable. Exact retries reconcile against
            // the committed head and rows, but cannot append, rewrite a row,
            // or advance its cursor a second time after publication.
            const storedCursor = headRow.next_cursor_time === null
              ? null
              : Object.freeze({
                observedAtMs: safeInteger(headRow.next_cursor_time, operation),
                occurrenceId: safeString(headRow.next_cursor_id, operation),
              });
            if (!complete || expectedProgressRevision > currentProgressRevision
                || !cursorEqual(nextCursor, storedCursor)) {
              throw new PostgresStorageError("conflict", operation, { retryable: false });
            }
            for (let index = 0; index < rows.length; index += 1) {
              await assertPreparedRowEqual(
                transaction,
                operation,
                pin,
                generation,
                rows[index]!,
                payloadJson[index]!,
              );
            }
            return Object.freeze({
              generation: safeString(headRow.generation, operation),
              state: "ready" as const,
              progressRevision: currentProgressRevision,
              nextCursor: storedCursor,
              rowsWritten: safeInteger(headRow.rows_written, operation),
              sourcePin: authoritativePin,
            });
          }
          if (headState !== "building") {
            throw new PostgresStorageError("source_stale", operation);
          }
          if (currentProgressRevision !== expectedProgressRevision) {
            throw new PostgresStorageError("conflict", operation, { retryable: true });
          }
          let insertedCount = 0;
          for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index]!;
            const inserted = await execute<Record<string, unknown>>(transaction, operation, statement(`
              INSERT INTO analytics_prepared_source_rows
                (source_id, owner_digest, observed_day, generation, occurrence_id,
                 observed_at_ms, input_revision, payload_json, payload_sha256)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
              ON CONFLICT (source_id, owner_digest, observed_day, generation, occurrence_id)
              DO NOTHING
              RETURNING occurrence_id`,
              pin.sourceId, pin.ownerDigest, pin.day, generation, row.occurrenceId,
              row.observedAtMs, row.inputRevision, payloadJson[index]!, row.payloadSha256));
            if (inserted.rows.length === 1) {
              insertedCount += 1;
              continue;
            }
            await assertPreparedRowEqual(transaction, operation, pin, generation, row, payloadJson[index]!);
          }
          const updated = await execute<Record<string, unknown>>(transaction, operation, statement(`
            UPDATE analytics_prepared_source_heads
               SET progress_revision = progress_revision + 1,
                   next_cursor_time = $1, next_cursor_id = $2,
                   rows_written = rows_written + $3,
                   state = CASE WHEN $4 THEN 'ready' ELSE 'building' END
             WHERE source_id = $5 AND owner_digest = $6 AND day = $7
               AND generation = $8 AND progress_revision = $9
               AND source_namespace = $10 AND input_revision = $11
               AND owner_revision = $12 AND dependency_digest = $13
               AND method = $14 AND authority_epoch = $15
               AND source_epoch = $16 AND sequence = $17
               AND state IN ('building','ready')
             RETURNING generation, state, progress_revision, next_cursor_time,
                       next_cursor_id, rows_written, source_id, source_namespace,
                       owner_digest, day, input_revision, owner_revision,
                       dependency_digest, method, authority_epoch, source_epoch, sequence`,
            nextCursor?.observedAtMs ?? null, nextCursor?.occurrenceId ?? null,
            insertedCount, complete, pin.sourceId, pin.ownerDigest, pin.day, generation,
            expectedProgressRevision, pin.sourceNamespace, pin.inputRevision,
            pin.ownerRevision, pin.dependencyDigest, pin.method, pin.authorityEpoch,
            pin.sourceEpoch, pin.sequence));
          const row = updated.rows[0];
          if (!row) throw new PostgresStorageError("conflict", operation, { retryable: true });
          const state = safeString(row.state, operation);
          return Object.freeze({
            generation: safeString(row.generation, operation),
            state: state as PreparedSourceHead["state"],
            progressRevision: safeInteger(row.progress_revision, operation),
            nextCursor: row.next_cursor_time === null ? null : Object.freeze({
              observedAtMs: safeInteger(row.next_cursor_time, operation),
              occurrenceId: safeString(row.next_cursor_id, operation),
            }),
            rowsWritten: safeInteger(row.rows_written, operation),
            sourcePin: sourcePin(row, operation),
          });
        });
      } catch (error) {
        throw normalizePostgresError(error, operation);
      }
    },

    async retire(input): Promise<{ deleted: number; complete: boolean }> {
      const operation = "prepared_source.retire";
      const limit = normalizeLimit(input.limit, 256, operation);
      const sourceId = String(input.sourceId);
      const ownerDigest = String(input.ownerDigest);
      const day = String(input.day);
      const generation = String(input.generation);
      const expectedProgressRevision = input.expectedProgressRevision;
      if (!sourceId || !ownerDigest || !day || !generation
          || !Number.isSafeInteger(expectedProgressRevision)) {
        throw new PostgresStorageError("bounds", operation);
      }
      try {
        return await inTransaction(database, operation, async (transaction) => {
          const head = await execute<Record<string, unknown>>(transaction, operation, statement(`
            SELECT state, progress_revision
              FROM analytics_prepared_source_heads
             WHERE source_id=$1 AND owner_digest=$2 AND day=$3 AND generation=$4
             LIMIT 1
             FOR UPDATE`, sourceId, ownerDigest, day, generation));
          const headRow = head.rows[0];
          if (!headRow || safeString(headRow.state, operation) !== "discarding"
              || safeInteger(headRow.progress_revision, operation) !== expectedProgressRevision) {
            throw new PostgresStorageError("conflict", operation, { retryable: true });
          }
          const result = await execute<Record<string, unknown>>(transaction, operation, statement(`
            WITH doomed AS (
              SELECT occurrence_id
                FROM analytics_prepared_source_rows
               WHERE source_id = $1 AND owner_digest = $2 AND observed_day = $3
                 AND generation = $4
               ORDER BY observed_at_ms, occurrence_id
               LIMIT $5
            )
            DELETE FROM analytics_prepared_source_rows r
             USING doomed d
             WHERE r.source_id = $1 AND r.owner_digest = $2 AND r.observed_day = $3
               AND r.generation = $4 AND r.occurrence_id = d.occurrence_id
            RETURNING r.occurrence_id`, sourceId, ownerDigest, day, generation, limit));
          const remaining = await execute(transaction, operation, statement(`
            SELECT 1 FROM analytics_prepared_source_rows
             WHERE source_id = $1 AND owner_digest = $2 AND observed_day = $3 AND generation = $4
             LIMIT 1`, sourceId, ownerDigest, day, generation));
          const complete = remaining.rows.length === 0;
          const updated = await execute(transaction, operation, statement(`
            UPDATE analytics_prepared_source_heads
               SET progress_revision = progress_revision + 1,
                   state = CASE WHEN $1 THEN 'retired' ELSE 'discarding' END
             WHERE source_id=$2 AND owner_digest=$3 AND day=$4 AND generation=$5
               AND progress_revision=$6 AND state='discarding'`, complete,
          sourceId, ownerDigest, day, generation, expectedProgressRevision));
          if (updated.rowCount !== 1) throw new PostgresStorageError("conflict", operation, { retryable: true });
          return { deleted: result.rowCount, complete };
        });
      } catch (error) {
        throw normalizePostgresError(error, operation);
      }
    },
  };
}

function workIdentityJson(identity: AnalyticalWorkIdentity, operation: string): string {
  try {
    return boundedJson(JSON.stringify(identity), 16 * 1024, operation);
  } catch (error) {
    if (error instanceof PostgresStorageError) throw error;
    throw new PostgresStorageError("bounds", operation);
  }
}

function workIdentityFromRow(row: Record<string, unknown>, operation: string): AnalyticalWorkIdentity {
  const value = parseJson(row.identity_json, operation);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PostgresStorageError("incomplete", operation);
  }
  const record = value as Record<string, unknown>;
  return Object.freeze({
    sourceId: safeString(record.sourceId, operation),
    sourceNamespace: safeString(record.sourceNamespace, operation),
    ownerDigest: safeString(record.ownerDigest, operation),
    day: safeString(record.day, operation),
    metric: record.metric === "fits" || record.metric === "model" ? record.metric : (() => { throw new PostgresStorageError("incomplete", operation); })(),
    inputRevision: safeInteger(record.inputRevision, operation),
    ownerRevision: safeInteger(record.ownerRevision, operation),
    dependencyDigest: safeString(record.dependencyDigest, operation),
    method: safeString(record.method, operation),
    authorityEpoch: safeInteger(record.authorityEpoch, operation),
  });
}

function workHeadFromRow(row: Record<string, unknown>, operation: string): AnalyticalWorkHead {
  const state = safeString(row.state, operation);
  if (!["pending", "claimed", "checkpointing", "complete", "discarding", "retired"].includes(state)) {
    throw new PostgresStorageError("incomplete", operation);
  }
  const claimToken = row.claim_token === null || row.claim_token === undefined ? null : safeString(row.claim_token, operation);
  const claim = claimToken === null ? null : Object.freeze({
    claimToken,
    leaseExpiresAtMs: safeInteger(row.lease_expires_ms, operation),
    revision: safeInteger(row.revision, operation),
    identity: workIdentityFromRow(row, operation),
  });
  return Object.freeze({
    identity: workIdentityFromRow(row, operation),
    state: state as AnalyticalWorkHead["state"],
    revision: safeInteger(row.revision, operation),
    headDigest: row.head_digest === null || row.head_digest === undefined ? null : safeString(row.head_digest, operation),
    claim,
    checkpoint: null,
  });
}

function workCheckpointFromRows(
  rows: readonly Record<string, unknown>[],
  generation: string | null,
  operation: string,
): AnalyticalCheckpoint | null {
  if (generation === null) return null;
  const selected = rows.filter((row) => safeString(row.generation, operation) === generation);
  if (selected.length === 0) return null;
  const first = selected[0]!;
  const expectedHead = first.expected_head === null || first.expected_head === undefined
    ? null : safeString(first.expected_head, operation);
  const controlJson = boundedJson(safeString(first.control_json, operation), 16 * 1024, operation);
  const manifestJson = boundedJson(safeString(first.manifest_json, operation), 64 * 1024, operation);
  const complete = first.complete === true || first.complete === 1;
  const parts = selected
    .sort((left, right) => safeInteger(left.part_index, operation) - safeInteger(right.part_index, operation))
    .map((row) => Object.freeze({
      index: safeInteger(row.part_index, operation),
      sha256: safeSha256(row.sha256, operation),
      payloadJson: boundedJson(safeString(row.payload_json, operation), 128 * 1024, operation),
    }));
  return validateCheckpoint({ generation, expectedHead, controlJson, manifestJson, parts, complete }, operation);
}

function withWorkCheckpoint(head: AnalyticalWorkHead, checkpoint: AnalyticalCheckpoint | null): AnalyticalWorkHead {
  return Object.freeze({ ...head, checkpoint });
}

function validatePublicationAuthority(authority: StoragePublicationAuthority, operation: string): StoragePublicationAuthority {
  const snapshot = Object.freeze({ ...authority });
  if (!snapshot.sourceId || !snapshot.sourceNamespace
      || !Number.isSafeInteger(snapshot.policyRevision) || snapshot.policyRevision < 0
      || !Number.isSafeInteger(snapshot.collectionRevision) || snapshot.collectionRevision < 0
      || !Number.isSafeInteger(snapshot.publicAuthorityEpoch) || snapshot.publicAuthorityEpoch < 0
      || !Number.isSafeInteger(snapshot.sourceEpoch) || snapshot.sourceEpoch < 0
      || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) {
    throw new PostgresStorageError("bounds", operation);
  }
  return snapshot;
}

/** Graph/history work uses one target head and a transaction-scoped lease. */
export function createPostgresAnalyticalWorkStore(
  pool: PostgresPool,
  schemaOptions: PostgresSchemaOptions = {},
): AnalyticalWorkStore {
  const database = storageDatabase(pool, schemaOptions);
  return {
    async claim(input): Promise<AnalyticalWorkClaim | null> {
      const operation = "analytical_work.claim";
      const identity = Object.freeze({ ...input.identity });
      const nowMs = input.nowMs;
      const leaseMs = input.leaseMs;
      if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(leaseMs) || leaseMs < 1
          || leaseMs > 86_400_000) {
        throw new PostgresStorageError("bounds", operation);
      }
      const token = crypto.randomUUID();
      const result = await executeMutation<Record<string, unknown>>(database, operation, statement(`
        INSERT INTO analytics_analysis_work_heads
          (source_id,owner_digest,day,metric,identity_json,state,revision,claim_token,lease_expires_ms)
        VALUES ($1,$2,$3,$4,$5,'claimed',1,$6,$7)
        ON CONFLICT (source_id,owner_digest,day,metric) DO UPDATE
          SET identity_json = EXCLUDED.identity_json,
              state = 'claimed', revision = analytics_analysis_work_heads.revision + 1,
              claim_token = EXCLUDED.claim_token, lease_expires_ms = EXCLUDED.lease_expires_ms
        WHERE analytics_analysis_work_heads.identity_json = EXCLUDED.identity_json
          AND analytics_analysis_work_heads.state IN ('pending','claimed','checkpointing')
          AND (analytics_analysis_work_heads.state = 'pending' OR analytics_analysis_work_heads.lease_expires_ms <= $8)
        RETURNING identity_json,state,revision,claim_token,lease_expires_ms`,
      identity.sourceId, identity.ownerDigest, identity.day, identity.metric,
      workIdentityJson(identity, operation), token, nowMs + leaseMs, nowMs));
      const row = result.rows[0];
      if (!row) return null;
      const head = workHeadFromRow(row, operation);
      if (!head.claim) throw new PostgresStorageError("incomplete", operation);
      return head.claim;
    },

    async renew(input): Promise<AnalyticalWorkClaim> {
      const operation = "analytical_work.renew";
      const identity = Object.freeze({ ...input.identity });
      const nowMs = input.nowMs;
      const leaseMs = input.leaseMs;
      const claimToken = String(input.claimToken);
      const expectedRevision = input.expectedRevision;
      if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(leaseMs) || leaseMs < 1
          || leaseMs > 86_400_000 || !Number.isSafeInteger(expectedRevision)
          || claimToken.length === 0 || claimToken.length > 256) {
        throw new PostgresStorageError("bounds", operation);
      }
      const result = await executeMutation<Record<string, unknown>>(database, operation, statement(`
        UPDATE analytics_analysis_work_heads
           SET lease_expires_ms = $1, revision = revision + 1
         WHERE source_id = $2 AND owner_digest = $3 AND day = $4 AND metric = $5
           AND state IN ('claimed','checkpointing') AND claim_token = $6 AND revision = $7
           AND identity_json = $9
           AND lease_expires_ms > $8
         RETURNING identity_json,revision,claim_token,lease_expires_ms`, nowMs + leaseMs,
      identity.sourceId, identity.ownerDigest, identity.day, identity.metric,
      claimToken, expectedRevision, nowMs, workIdentityJson(identity, operation)));
      const row = result.rows[0];
      if (!row) throw new PostgresStorageError("conflict", operation, { retryable: true });
      return Object.freeze({
        claimToken: safeString(row.claim_token, operation),
        leaseExpiresAtMs: safeInteger(row.lease_expires_ms, operation),
        revision: safeInteger(row.revision, operation),
        identity: workIdentityFromRow(row, operation),
      });
    },

    async read(identity): Promise<AnalyticalWorkHead | null> {
      const operation = "analytical_work.read";
      const snapshot = Object.freeze({ ...identity });
      try {
        return await withPostgresRead(database.pool, async (client) => {
          await client.query(setLocalSearchPath(database.schema));
          const result = await client.query<Record<string, unknown>>(`
            SELECT identity_json,state,revision,head_digest,checkpoint_generation,claim_token,lease_expires_ms
              FROM analytics_analysis_work_heads
             WHERE source_id = $1 AND owner_digest = $2 AND day = $3 AND metric = $4
             LIMIT 1`, [snapshot.sourceId, snapshot.ownerDigest, snapshot.day, snapshot.metric]);
          const row = result.rows[0];
          if (!row) return null;
          const head = workHeadFromRow(row, operation);
          const checkpointGeneration = row.checkpoint_generation === null || row.checkpoint_generation === undefined
            ? null : safeString(row.checkpoint_generation, operation);
          if (!checkpointGeneration) return head;
          const parts = await client.query<Record<string, unknown>>(`
            SELECT generation,part_index,sha256,payload_json,expected_head,control_json,manifest_json,complete
             FROM analytics_analysis_work_parts
             WHERE source_id = $1 AND owner_digest = $2 AND day = $3 AND metric = $4
               AND generation = $5
             ORDER BY part_index LIMIT 1025`, [snapshot.sourceId, snapshot.ownerDigest, snapshot.day, snapshot.metric,
            checkpointGeneration]);
          const checkpoint = workCheckpointFromRows(parts.rows, checkpointGeneration, operation);
          if (!checkpoint) throw new PostgresStorageError("incomplete", operation);
          return withWorkCheckpoint(head, checkpoint);
        }, { operation });
      } catch (error) {
        throw normalizePostgresError(error, operation);
      }
    },

    async saveCheckpoint(input): Promise<AnalyticalWorkHead> {
      const operation = "analytical_work.save_checkpoint";
      const identity = Object.freeze({ ...input.identity });
      const claimToken = String(input.claimToken);
      const expectedRevision = input.expectedRevision;
      const nowMs = input.nowMs;
      const checkpoint = validateCheckpoint(input.checkpoint, operation);
      const identityJson = workIdentityJson(identity, operation);
      if (claimToken.length === 0 || claimToken.length > 256 || !Number.isSafeInteger(expectedRevision)
          || !Number.isSafeInteger(nowMs)) {
        throw new PostgresStorageError("bounds", operation);
      }
      try {
        return await inTransaction(database, operation, async (transaction) => {
          const current = await execute<Record<string, unknown>>(transaction, operation, statement(`
            SELECT identity_json,state,revision,claim_token,lease_expires_ms,head_digest
              FROM analytics_analysis_work_heads
             WHERE source_id=$1 AND owner_digest=$2 AND day=$3 AND metric=$4
             FOR UPDATE`, identity.sourceId, identity.ownerDigest, identity.day, identity.metric));
          const currentRow = current.rows[0];
          if (!currentRow || safeString(currentRow.identity_json, operation) !== identityJson
              || !["claimed", "checkpointing"].includes(safeString(currentRow.state, operation))
              || safeInteger(currentRow.revision, operation) !== expectedRevision
              || safeString(currentRow.claim_token, operation) !== claimToken
              || safeInteger(currentRow.lease_expires_ms, operation) <= nowMs
              || (currentRow.head_digest === null ? null : safeString(currentRow.head_digest, operation)) !== checkpoint.expectedHead) {
            throw new PostgresStorageError("conflict", operation, { retryable: true });
          }
          for (const part of checkpoint.parts) {
            const inserted = await execute<Record<string, unknown>>(transaction, operation, statement(`
              INSERT INTO analytics_analysis_work_parts
                (source_id,owner_digest,day,metric,generation,part_index,sha256,payload_json,
                 expected_head,control_json,manifest_json,complete)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
              ON CONFLICT (source_id,owner_digest,day,metric,generation,part_index)
              DO NOTHING
              RETURNING part_index`, identity.sourceId, identity.ownerDigest, identity.day,
            identity.metric, checkpoint.generation, part.index, part.sha256, part.payloadJson,
            checkpoint.expectedHead, checkpoint.controlJson, checkpoint.manifestJson, checkpoint.complete));
            if (inserted.rows.length !== 1) {
              const existing = await execute<Record<string, unknown>>(transaction, operation, statement(`
                SELECT sha256,payload_json,expected_head,control_json,manifest_json,complete
                  FROM analytics_analysis_work_parts
                 WHERE source_id=$1 AND owner_digest=$2 AND day=$3 AND metric=$4
                   AND generation=$5 AND part_index=$6
                 FOR UPDATE`, identity.sourceId, identity.ownerDigest, identity.day,
              identity.metric, checkpoint.generation, part.index));
              const row = existing.rows[0];
              const expectedHead = row?.expected_head === null || row?.expected_head === undefined
                ? null : safeString(row.expected_head, operation);
              if (!row || safeSha256(row.sha256, operation) !== part.sha256
                  || safeString(row.payload_json, operation) !== part.payloadJson
                  || expectedHead !== checkpoint.expectedHead
                  || safeString(row.control_json, operation) !== checkpoint.controlJson
                  || safeString(row.manifest_json, operation) !== checkpoint.manifestJson
                  || (row.complete !== true && row.complete !== false
                    && row.complete !== 0 && row.complete !== 1)
                  || (row.complete === true || row.complete === 1) !== checkpoint.complete) {
                throw new PostgresStorageError("conflict", operation);
              }
            }
          }
          const result = await execute<Record<string, unknown>>(transaction, operation, statement(`
            UPDATE analytics_analysis_work_heads
               SET state = 'checkpointing', revision = revision + 1,
                   head_digest = $1, checkpoint_generation = $1
             WHERE source_id = $2 AND owner_digest = $3 AND day = $4 AND metric = $5
               AND state IN ('claimed','checkpointing') AND claim_token = $6 AND revision = $7
               AND identity_json = $8 AND lease_expires_ms > $9
               AND head_digest IS NOT DISTINCT FROM $10
             RETURNING identity_json,state,revision,head_digest,claim_token,lease_expires_ms`,
          checkpoint.generation, identity.sourceId, identity.ownerDigest,
          identity.day, identity.metric, claimToken, expectedRevision, identityJson, nowMs,
          checkpoint.expectedHead));
          const row = result.rows[0];
          if (!row) throw new PostgresStorageError("conflict", operation, { retryable: true });
          return withWorkCheckpoint(workHeadFromRow(row, operation), checkpoint);
        });
      } catch (error) {
        throw normalizePostgresError(error, operation);
      }
    },

    async complete(input): Promise<AnalyticalWorkHead> {
      const operation = "analytical_work.complete";
      const identity = Object.freeze({ ...input.identity });
      const claimToken = String(input.claimToken);
      const expectedRevision = input.expectedRevision;
      const nowMs = input.nowMs;
      const resultDigest = safeSha256(input.resultDigest, operation);
      const identityJson = workIdentityJson(identity, operation);
      if (claimToken.length === 0 || claimToken.length > 256 || !Number.isSafeInteger(expectedRevision)
          || !Number.isSafeInteger(nowMs)) {
        throw new PostgresStorageError("bounds", operation);
      }
      const result = await executeMutation<Record<string, unknown>>(database, operation, statement(`
        UPDATE analytics_analysis_work_heads
           SET state = 'complete', revision = revision + 1, head_digest = $1,
               claim_token = NULL, lease_expires_ms = NULL
         WHERE source_id = $2 AND owner_digest = $3 AND day = $4 AND metric = $5
           AND state IN ('claimed','checkpointing') AND claim_token = $6 AND revision = $7
           AND identity_json = $8 AND lease_expires_ms > $9 AND checkpoint_generation IS NOT NULL
         RETURNING identity_json,state,revision,head_digest,claim_token,lease_expires_ms`, resultDigest,
      identity.sourceId, identity.ownerDigest, identity.day, identity.metric,
      claimToken, expectedRevision, identityJson, nowMs));
      const row = result.rows[0];
      if (!row) throw new PostgresStorageError("conflict", operation, { retryable: true });
      return workHeadFromRow(row, operation);
    },

    async discard(input): Promise<AnalyticalWorkHead> {
      const operation = "analytical_work.discard";
      const identity = Object.freeze({ ...input.identity });
      const expectedRevision = input.expectedRevision;
      if (!Number.isSafeInteger(expectedRevision)) throw new PostgresStorageError("bounds", operation);
      const result = await executeMutation<Record<string, unknown>>(database, operation, statement(`
        UPDATE analytics_analysis_work_heads
           SET state = 'discarding', revision = revision + 1,
               claim_token = NULL, lease_expires_ms = NULL
         WHERE source_id = $1 AND owner_digest = $2 AND day = $3 AND metric = $4
           AND revision = $5 AND state <> 'retired'
         RETURNING identity_json,state,revision,head_digest,claim_token,lease_expires_ms`, identity.sourceId,
      identity.ownerDigest, identity.day, identity.metric, expectedRevision));
      const row = result.rows[0];
      if (!row) throw new PostgresStorageError("conflict", operation, { retryable: true });
      return workHeadFromRow(row, operation);
    },

    async retire(input): Promise<{ deleted: number; complete: boolean }> {
      const operation = "analytical_work.retire";
      const limit = normalizeLimit(input.limit, 256, operation);
      const identity = Object.freeze({ ...input.identity });
      const expectedRevision = input.expectedRevision;
      if (!Number.isSafeInteger(expectedRevision)) throw new PostgresStorageError("bounds", operation);
      try {
        return await inTransaction(database, operation, async (transaction) => {
          const head = await execute<Record<string, unknown>>(transaction, operation, statement(`
            SELECT state,revision
              FROM analytics_analysis_work_heads
             WHERE source_id=$1 AND owner_digest=$2 AND day=$3 AND metric=$4
             LIMIT 1
             FOR UPDATE`, identity.sourceId, identity.ownerDigest, identity.day, identity.metric));
          const headRow = head.rows[0];
          if (!headRow || safeString(headRow.state, operation) !== "discarding"
              || safeInteger(headRow.revision, operation) !== expectedRevision) {
            throw new PostgresStorageError("conflict", operation, { retryable: true });
          }
          const result = await execute<Record<string, unknown>>(transaction, operation, statement(`
            WITH doomed AS (
              SELECT source_id,owner_digest,day,metric,generation,part_index
                FROM analytics_analysis_work_parts
               WHERE source_id=$1 AND owner_digest=$2 AND day=$3 AND metric=$4
               ORDER BY generation,part_index LIMIT $5
            )
            DELETE FROM analytics_analysis_work_parts p USING doomed d
             WHERE p.source_id=d.source_id AND p.owner_digest=d.owner_digest AND p.day=d.day
               AND p.metric=d.metric AND p.generation=d.generation AND p.part_index=d.part_index
            RETURNING p.part_index`, identity.sourceId, identity.ownerDigest,
          identity.day, identity.metric, limit));
          const left = await execute(transaction, operation, statement(`
            SELECT 1 FROM analytics_analysis_work_parts
             WHERE source_id=$1 AND owner_digest=$2 AND day=$3 AND metric=$4 LIMIT 1`,
          identity.sourceId, identity.ownerDigest, identity.day, identity.metric));
          const complete = left.rows.length === 0;
          const updated = await execute(transaction, operation, statement(`
            UPDATE analytics_analysis_work_heads
               SET state = CASE WHEN $1 THEN 'retired' ELSE 'discarding' END,
                   revision = revision + 1
             WHERE source_id=$2 AND owner_digest=$3 AND day=$4 AND metric=$5
               AND state='discarding' AND revision=$6`, complete,
          identity.sourceId, identity.ownerDigest, identity.day, identity.metric, expectedRevision));
          if (updated.rowCount !== 1) throw new PostgresStorageError("conflict", operation, { retryable: true });
          return { deleted: result.rowCount, complete };
        });
      } catch (error) {
        throw normalizePostgresError(error, operation);
      }
    },
  };
}

function publicationRow(row: Record<string, unknown>, authority: StoragePublicationAuthority, operation: string): StoragePublicationCapture {
  return Object.freeze({
    generation: safeString(row.generation, operation),
    day: safeString(row.day, operation),
    metric: row.metric === "daily" || row.metric === "model" || row.metric === "graph" ? row.metric : (() => { throw new PostgresStorageError("incomplete", operation); })(),
    cohortDigest: safeString(row.cohort_digest, operation),
    authority,
    expectedMembers: safeInteger(row.expected_members, operation),
    payloadJson: safeString(row.payload_json, operation),
  });
}

/** Target-side publication adapter. Capture and publish are separate so an
 * object-store/publication acknowledgement can never be mistaken for a SQL
 * commit acknowledgement. */
export function createPostgresPublicationStore(
  pool: PostgresPool,
  schemaOptions: PostgresSchemaOptions = {},
): StoragePublicationStore {
  const database = storageDatabase(pool, schemaOptions);
  return {
    async capture(input): Promise<StoragePublicationCapture | null> {
      const operation = "publication.capture";
      const limit = normalizeLimit(input.limit, 10_000, operation);
      const sourceId = String(input.sourceId);
      const day = String(input.day);
      const generation = String(input.generation);
      const metric = input.metric;
      const authority = validatePublicationAuthority(input.authority, operation);
      if (!sourceId || !day || !generation || !["daily", "model", "graph"].includes(metric)) {
        throw new PostgresStorageError("bounds", operation);
      }
      const result = await execute<Record<string, unknown>>(database, operation, statement(`
        SELECT generation,day,metric,cohort_digest,expected_members,payload_json
          FROM analytics_publication_captures
         WHERE source_id=$1 AND day=$2 AND metric=$3 AND generation=$4
           AND policy_revision=$5 AND collection_revision=$6
         LIMIT $7`, sourceId, day, metric, generation,
      authority.policyRevision, authority.collectionRevision, limit));
      const row = result.rows[0];
      return row ? publicationRow(row, authority, operation) : null;
    },
    async publish(input): Promise<"published" | "unchanged" | "stale" | "incomplete"> {
      const operation = "publication.publish";
      const capture = Object.freeze({
        ...input.capture,
        authority: validatePublicationAuthority(input.capture.authority, operation),
      });
      const payloadSha256 = safeSha256(input.payloadSha256, operation);
      const computedAtMs = input.computedAtMs;
      if (!Number.isSafeInteger(computedAtMs) || computedAtMs < 0
          || capture.payloadJson.length === 0) {
        throw new PostgresStorageError("bounds", operation);
      }
      const payloadJson = boundedJson(capture.payloadJson, 1024 * 1024, operation);
      const result = await inTransaction(database, operation, async (transaction) => {
        const published = await execute<Record<string, unknown>>(transaction, operation, statement(`
          INSERT INTO analytics_publications
            (source_id,day,metric,generation,cohort_digest,authority_json,payload_json,payload_sha256,
             computed_at_ms,policy_revision,collection_revision)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
           WHERE EXISTS (
             SELECT 1 FROM analytics_publication_captures c
              WHERE c.source_id=$1 AND c.day=$2 AND c.metric=$3 AND c.generation=$4
                AND c.cohort_digest=$5 AND c.payload_json=$7
                AND c.policy_revision=$10 AND c.collection_revision=$11
           )
           AND EXISTS (
             SELECT 1 FROM analytics_owner_state o
              WHERE o.source_id=$1 AND o.state <> 'erased'
           )
          ON CONFLICT (source_id,day,metric) DO UPDATE
            SET generation=EXCLUDED.generation,cohort_digest=EXCLUDED.cohort_digest,
                authority_json=EXCLUDED.authority_json,payload_json=EXCLUDED.payload_json,
                payload_sha256=EXCLUDED.payload_sha256,computed_at_ms=EXCLUDED.computed_at_ms,
                policy_revision=EXCLUDED.policy_revision,collection_revision=EXCLUDED.collection_revision
          WHERE analytics_publications.policy_revision=$10
            AND analytics_publications.collection_revision=$11
          RETURNING source_id`, capture.authority.sourceId, capture.day,
        capture.metric, capture.generation, capture.cohortDigest,
        JSON.stringify(capture.authority), payloadJson, payloadSha256,
        computedAtMs, capture.authority.policyRevision, capture.authority.collectionRevision));
        if (published.rowCount === 1) {
          const members = await execute(transaction, operation, statement(`
            INSERT INTO analytics_publication_owner_members
              (source_id,day,metric,generation,owner_digest)
            SELECT $1,$2,$3,$4,owner_digest
              FROM analytics_owner_state
             WHERE source_id=$1 AND state <> 'erased'
            ON CONFLICT (source_id,day,metric,generation,owner_digest) DO NOTHING`,
          capture.authority.sourceId, capture.day, capture.metric, capture.generation));
          if (members.rowCount < 1) throw new PostgresStorageError("incomplete", operation);
        }
        return published;
      });
      if (result.rows.length === 1) return "published";
      const existing = await execute(database, operation, statement(`
        SELECT 1 FROM analytics_publications WHERE source_id=$1 AND day=$2 AND metric=$3
          AND payload_sha256=$4 AND policy_revision=$5 AND collection_revision=$6
          AND NOT EXISTS (SELECT 1 FROM analytics_publication_invalidations i
            WHERE i.source_id=analytics_publications.source_id AND i.day=analytics_publications.day
              AND i.metric=analytics_publications.metric AND i.generation=analytics_publications.generation)
          LIMIT 1`,
      capture.authority.sourceId, capture.day,
      capture.metric, payloadSha256, capture.authority.policyRevision, capture.authority.collectionRevision));
      if (existing.rows.length === 1) return "unchanged";
      return "stale";
    },
    async readPublished(input): Promise<StoragePublicationCapture | null> {
      const operation = "publication.read_published";
      const sourceId = String(input.sourceId);
      const day = String(input.day);
      const authority = validatePublicationAuthority(input.authority, operation);
      const result = await execute<Record<string, unknown>>(database, operation, statement(`
        SELECT p.generation,p.day,p.metric,p.cohort_digest,c.expected_members,p.payload_json
          FROM analytics_publications p
          JOIN analytics_publication_captures c
            ON c.source_id=p.source_id AND c.day=p.day AND c.metric=p.metric
           AND c.generation=p.generation
         WHERE p.source_id=$1 AND p.day=$2 AND p.metric=$3
           AND p.policy_revision=$4 AND p.collection_revision=$5
           AND EXISTS (
             SELECT 1 FROM analytics_publication_owner_members m
              WHERE m.source_id=p.source_id AND m.day=p.day AND m.metric=p.metric
                AND m.generation=p.generation
           )
           AND NOT EXISTS (
             SELECT 1 FROM analytics_publication_invalidations i
              WHERE i.source_id=p.source_id AND i.day=p.day AND i.metric=p.metric
                AND i.generation=p.generation
           )
         LIMIT 1`, sourceId, day, input.metric,
      authority.policyRevision, authority.collectionRevision));
      const row = result.rows[0];
      return row ? publicationRow(row, authority, operation) : null;
    },
    async retire(input): Promise<{ deleted: number; complete: boolean }> {
      const operation = "publication.retire";
      const limit = normalizeLimit(input.limit, 256, operation);
      const deleted = await inTransaction(database, operation, async (transaction) => {
        await execute(transaction, operation, statement(`
          WITH doomed AS (
            SELECT source_id,day,metric,generation FROM analytics_publications
             WHERE source_id=$1 AND day < $2 ORDER BY day,metric LIMIT $3
          ) DELETE FROM analytics_publication_owner_members m USING doomed d
           WHERE m.source_id=d.source_id AND m.day=d.day AND m.metric=d.metric
             AND m.generation=d.generation`, input.sourceId, input.beforeDay, limit));
        await execute(transaction, operation, statement(`
          WITH doomed AS (
            SELECT source_id,day,metric,generation FROM analytics_publications
             WHERE source_id=$1 AND day < $2 ORDER BY day,metric LIMIT $3
          ) DELETE FROM analytics_publication_invalidations i USING doomed d
           WHERE i.source_id=d.source_id AND i.day=d.day AND i.metric=d.metric
             AND i.generation=d.generation`, input.sourceId, input.beforeDay, limit));
        await execute(transaction, operation, statement(`
          WITH doomed AS (
            SELECT source_id,day,metric,generation FROM analytics_publications
             WHERE source_id=$1 AND day < $2 ORDER BY day,metric LIMIT $3
          ) DELETE FROM analytics_publication_captures c USING doomed d
           WHERE c.source_id=d.source_id AND c.day=d.day AND c.metric=d.metric
             AND c.generation=d.generation`, input.sourceId, input.beforeDay, limit));
        const result = await execute<Record<string, unknown>>(transaction, operation, statement(`
          WITH doomed AS (
            SELECT source_id,day,metric,generation FROM analytics_publications
             WHERE source_id=$1 AND day < $2 ORDER BY day,metric LIMIT $3
          ) DELETE FROM analytics_publications p USING doomed d
           WHERE p.source_id=d.source_id AND p.day=d.day AND p.metric=d.metric
             AND p.generation=d.generation
           RETURNING p.day`, input.sourceId, input.beforeDay, limit));
        return result.rowCount;
      });
      const left = await execute(database, operation, statement(`
        SELECT 1 FROM analytics_publications WHERE source_id=$1 AND day < $2 LIMIT 1`, input.sourceId, input.beforeDay));
      return { deleted, complete: left.rows.length === 0 };
    },
  };
}

export function createPostgresAdminStore(
  pool: PostgresPool,
  schemaOptions: PostgresSchemaOptions = {},
): StorageAdminStore {
  const database = storageDatabase(pool, schemaOptions);
  return {
    async authorize(input): Promise<boolean> {
      const result = await execute(database, "admin.authorize", statement(`
        SELECT 1 FROM participants WHERE id=$1 AND state='active' AND identity_link_key=$2 LIMIT 1`, input.participantId, input.identityLinkKey));
      return result.rows.length === 1;
    },
    async beginAudit(input): Promise<void> {
      await executeMutation(database, "admin.begin_audit", statement(`
        INSERT INTO admin_action_audit(operation_id,action,actor_identity_digest,outcome,details_json,created_at)
        VALUES($1,$2,$3,'started',$4,$5)`, input.operationId, input.action, input.actorIdentityDigest, input.detailsJson, input.createdAt));
    },
    async finishAudit(input): Promise<void> {
      const result = await executeMutation(database, "admin.finish_audit", statement(`
        UPDATE admin_action_audit SET outcome=$1,details_json=$2
         WHERE operation_id=$3 AND outcome='started'`, input.outcome, input.detailsJson, input.operationId));
      if (result.rowCount !== 1) throw new PostgresStorageError("conflict", "admin.finish_audit");
    },
    async readControls(): Promise<StorageCollectionControls> {
      const result = await execute<Record<string, unknown>>(database, "admin.read_controls", statement(`
        SELECT revision,control_state,enrollment_enabled,upload_registration_enabled,
               processing_enabled,publication_enabled
          FROM collection_controls WHERE singleton=1`));
      const row = result.rows[0];
      if (!row) throw new PostgresStorageError("unavailable", "admin.read_controls");
      const flags = [row.enrollment_enabled,row.upload_registration_enabled,row.processing_enabled,row.publication_enabled];
      if (!flags.every((value) => value === true || value === false || value === 0 || value === 1)) {
        throw new PostgresStorageError("incomplete", "admin.read_controls");
      }
      const enabled = flags.map((value) => value === true || value === 1);
      const state = safeString(row.control_state, "admin.read_controls");
      if (!["operational", "degraded", "contained"].includes(state)) throw new PostgresStorageError("incomplete", "admin.read_controls");
      return Object.freeze({
        revision: safeInteger(row.revision, "admin.read_controls"), state: state as StorageCollectionControls["state"],
        enrollment: enabled[0]!, uploadRegistration: enabled[1]!, processing: enabled[2]!, publication: enabled[3]!,
      });
    },
    async setControls(input): Promise<StorageCollectionControls> {
      const operation = "admin.set_controls";
      const nextRevision = input.expectedRevision + 1;
      const values = [Number(input.flags.enrollment), Number(input.flags.uploadRegistration), Number(input.flags.processing), Number(input.flags.publication)];
      const enabled = values.filter((value) => value === 1).length;
      const state = enabled === 4 ? "operational" : enabled === 0 ? "contained" : "degraded";
      try {
        return await inTransaction(database, operation, async (transaction) => {
          await execute(transaction, operation, statement(`
            INSERT INTO admin_action_audit(operation_id,action,actor_identity_digest,outcome,details_json,created_at)
            VALUES($1,'set_collection_controls',$2,'started',$3,$4)`, input.audit.operationId,
          input.audit.actorIdentityDigest, input.audit.detailsJson, input.updatedAt));
          const updated = await execute(transaction, operation, statement(`
            UPDATE collection_controls
               SET enrollment_enabled=$1,upload_registration_enabled=$2,
                   processing_enabled=$3,publication_enabled=$4,
                   control_state=$5,revision=revision+1,reason_code=$6,updated_at=$7
             WHERE singleton=1 AND revision=$8
             RETURNING revision`, ...values, state, input.reasonCode, input.updatedAt, input.expectedRevision));
          if (updated.rowCount !== 1) throw new PostgresStorageError("conflict", operation, { retryable: true });
          const audit = await execute(transaction, operation, statement(`
            UPDATE admin_action_audit SET outcome='success',details_json=$1
             WHERE operation_id=$2 AND outcome='started'`, input.audit.detailsJson, input.audit.operationId));
          if (audit.rowCount !== 1) throw new PostgresStorageError("unavailable", operation);
          return Object.freeze({ revision: nextRevision, state: state as StorageCollectionControls["state"], ...input.flags });
        });
      } catch (error) {
        throw normalizePostgresError(error, operation);
      }
    },
  };
}

export interface PostgresLifecycleStoreOptions {
  readonly primaryPool: PostgresPool;
  readonly ledgerPool: PostgresPool;
  readonly schemaOptions?: PostgresSchemaOptions;
}

const QUARANTINE_REFERENCE_TABLES = Object.freeze([
  "contributions",
  "telemetry_contributions",
  "telemetry_v1_chunks",
  "telemetry_v11_chunks",
  "telemetry_v12_chunks",
] as const);

const REQUIRED_QUARANTINE_REFERENCE_TABLES = new Set([
  "telemetry_v1_chunks",
  "telemetry_v11_chunks",
  "telemetry_v12_chunks",
]);

/**
 * Resolve only the fixed source tables used by quarantine cleanup.  Older
 * hosted schemas may not have the v0 tables, but an incomplete canonical
 * schema must never turn an unknown reference into an orphan claim.  The
 * result is consumed only to compose fixed, quoted identifiers below; callers
 * cannot supply SQL or table names through a storage port.
 */
async function quarantineReferenceTables(
  transaction: PostgresTransactionExecutor,
  operation: string,
): Promise<readonly string[]> {
  const result = await execute<{ table_name: unknown; column_name: unknown }>(transaction, operation, statement(`
    SELECT t.table_name,c.column_name
      FROM information_schema.tables t
      LEFT JOIN information_schema.columns c
        ON c.table_schema=t.table_schema
       AND c.table_name=t.table_name
       AND c.column_name='r2_key'
     WHERE t.table_schema=current_schema()
       AND t.table_name = ANY($1::text[])
     ORDER BY t.table_name`, [...QUARANTINE_REFERENCE_TABLES]));
  const tableColumns = new Map<string, string | null>();
  for (const row of result.rows) {
    const tableName = safeString(row.table_name, operation);
    const columnName = row.column_name === null ? null : safeString(row.column_name, operation);
    if (!QUARANTINE_REFERENCE_TABLES.includes(tableName as typeof QUARANTINE_REFERENCE_TABLES[number])) {
      throw new PostgresStorageError("incomplete", operation);
    }
    const prior = tableColumns.get(tableName);
    if (prior !== undefined && prior !== columnName) {
      throw new PostgresStorageError("incomplete", operation);
    }
    tableColumns.set(tableName, columnName);
  }
  for (const required of REQUIRED_QUARANTINE_REFERENCE_TABLES) {
    if (tableColumns.get(required) !== "r2_key") {
      throw new PostgresStorageError("unavailable", operation);
    }
  }
  for (const [tableName, columnName] of tableColumns) {
    if (columnName !== "r2_key") throw new PostgresStorageError("incomplete", operation);
  }
  return Object.freeze([...tableColumns.keys()]);
}

function quarantineReferencePredicate(tableNames: readonly string[], objectExpression: string): string {
  return tableNames.map((tableName) =>
    `NOT EXISTS (SELECT 1 FROM ${quotePostgresIdentifier(tableName)} c WHERE c.r2_key=${objectExpression})`,
  ).join(" AND ");
}

function quarantineReferenceQuery(tableNames: readonly string[]): string {
  return tableNames.map((tableName) =>
    `SELECT 1 FROM ${quotePostgresIdentifier(tableName)} c WHERE c.r2_key=$1`,
  ).join(" UNION ALL ");
}

/**
 * Lifecycle state spans two authorities. Tombstones and identity cooldowns
 * are written to the independent ledger pool/schema; quarantine and
 * maintenance state remain in the primary schema and transaction boundary.
 */
export function createPostgresLifecycleStore(
  options: PostgresLifecycleStoreOptions,
): StorageLifecycleStore {
  const schema = createPostgresSchemaConfig(options.schemaOptions);
  const primaryDatabase = storageDatabaseForSchema(options.primaryPool, schema.primarySchema);
  const ledgerDatabase = storageDatabaseForSchema(options.ledgerPool, schema.ledgerSchema);
  return {
    async recordDeletionTombstone(input): Promise<void> {
      const operation = "lifecycle.record_deletion_tombstone";
      await executeMutation(ledgerDatabase, operation, statement(`
        INSERT INTO deletion_tombstones(participant_digest,schema_version,deleted_at,retain_until)
        VALUES($1,'participant-deletion-tombstone-v0.1',$2,$3)
        ON CONFLICT(participant_digest) DO UPDATE SET retain_until=GREATEST(deletion_tombstones.retain_until,EXCLUDED.retain_until)`,
      input.participantDigest, input.retainUntil, input.retainUntil));
      const result = await execute(ledgerDatabase, operation, statement(`
        SELECT 1 FROM deletion_tombstones WHERE participant_digest=$1 AND retain_until >= $2`, input.participantDigest, input.retainUntil));
      if (result.rows.length !== 1) throw new PostgresStorageError("unavailable", operation);
    },
    async hasDeletionTombstone(input): Promise<boolean> {
      const result = await execute(ledgerDatabase, "lifecycle.has_deletion_tombstone", statement(`
        SELECT 1 FROM deletion_tombstones WHERE participant_digest=$1 AND retain_until > $2 LIMIT 1`, input.participantDigest, input.now));
      return result.rows.length === 1;
    },
    async recordIdentityCooldown(input): Promise<void> {
      await executeMutation(ledgerDatabase, "lifecycle.record_identity_cooldown", statement(`
        INSERT INTO identity_reenrollment_cooldowns(identity_cooldown_digest,schema_version,deleted_at,retain_until)
        VALUES($1,'identity-reenrollment-cooldown-v0.1',$2,$3)
        ON CONFLICT(identity_cooldown_digest) DO UPDATE SET retain_until=GREATEST(identity_reenrollment_cooldowns.retain_until,EXCLUDED.retain_until)`, input.digest, input.deletedAt, input.retainUntil));
    },
    async registerQuarantine(input: StorageQuarantineRegistration): Promise<void> {
      await executeMutation(primaryDatabase, "lifecycle.register_quarantine", statement(`
        INSERT INTO pending_objects(object_key,contribution_id,object_kind,registered_at,reconciliation_state)
        VALUES($1,$2,$3,$4,'registered')`, input.objectKey, input.contributionId, input.objectKind, input.registeredAt));
    },
    async claimQuarantine(input): Promise<"claimed" | "referenced" | "gone"> {
      const operation = "lifecycle.claim_quarantine";
      return inTransaction(primaryDatabase, operation, async (transaction) => {
        const tableNames = await quarantineReferenceTables(transaction, operation);
        const result = await execute(transaction, operation, statement(`
          UPDATE pending_objects q
             SET reconciliation_state='deleting',reconciliation_lease_id=$1
           WHERE q.object_key=$2 AND q.registered_at=$3
             AND q.reconciliation_state IN ('registered','deleting')
             AND ${quarantineReferencePredicate(tableNames, "q.object_key")}
           RETURNING q.object_key`, input.leaseId, input.objectKey, input.registeredAt));
        if (result.rowCount === 1) return "claimed";
        const referenced = await execute(transaction, operation, statement(`
          ${quarantineReferenceQuery(tableNames)}
          LIMIT 1`, input.objectKey));
        if (referenced.rows.length) return "referenced";
        const pending = await execute(transaction, operation, statement(`SELECT 1 FROM pending_objects WHERE object_key=$1`, input.objectKey));
        return pending.rows.length ? "referenced" : "gone";
      });
    },
    async clearQuarantine(input): Promise<void> {
      const result = await executeMutation(primaryDatabase, "lifecycle.clear_quarantine", statement(`
        DELETE FROM pending_objects
         WHERE object_key=$1
           AND (($2::text IS NOT NULL AND reconciliation_lease_id=$2)
             OR ($2::text IS NULL AND reconciliation_state='registered' AND reconciliation_lease_id IS NULL))`, input.objectKey, input.leaseId ?? null));
      if (result.rowCount !== 1) throw new PostgresStorageError("conflict", "lifecycle.clear_quarantine", { retryable: true });
    },
    async beginMaintenance(input): Promise<boolean> {
      const result = await executeMutation(primaryDatabase, "lifecycle.begin_maintenance", statement(`
        UPDATE retention_state SET state='running',last_started_at=$1,lease_id=$2,
          lease_expires_at=$3,failure_code=NULL
         WHERE singleton=1 AND (state <> 'running' OR lease_expires_at <= $1)
         RETURNING singleton`, input.now, input.leaseId, input.leaseExpiresAt));
      return result.rowCount === 1;
    },
    async finishMaintenance(input): Promise<void> {
      const result = await executeMutation(primaryDatabase, "lifecycle.finish_maintenance", statement(`
        UPDATE retention_state SET state='completed',last_completed_at=$1,
          lease_id=NULL,lease_expires_at=NULL,restored_participants_suppressed=$2,
          restore_replay_complete=$3,quarantine_objects_deleted=$4,
          quarantine_retention_complete=$5,failure_code=NULL
         WHERE singleton=1 AND state='running' AND lease_id=$6`, input.now,
      input.restoredParticipantsSuppressed, input.restoreReplayComplete, input.quarantineObjectsDeleted,
      input.quarantineRetentionComplete, input.leaseId));
      if (result.rowCount !== 1) throw new PostgresStorageError("conflict", "lifecycle.finish_maintenance", { retryable: true });
    },
  };
}

export function createPostgresAnalyticsDeliveryStore(
  pool: PostgresPool,
  schemaOptions: PostgresSchemaOptions = {},
): StorageAnalyticsDeliveryStore {
  const database = storageDatabase(pool, schemaOptions);
  return {
    async append(input: StorageAnalyticsChange): Promise<void> {
      await executeMutation(database, "analytics_delivery.append", statement(`
        INSERT INTO storage_ingestion_changes(source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(source_id,sequence) DO NOTHING`, input.sourceId, input.sequence, input.eventDigest,
      input.ownerDigest, input.ownerRevision, input.authorityEpoch, input.kind, input.recordedMs));
    },
    async read(input): Promise<readonly StorageAnalyticsChange[]> {
      const limit = normalizeLimit(input.limit, 100, "analytics_delivery.read");
      const result = await execute<Record<string, unknown>>(database, "analytics_delivery.read", statement(`
        SELECT source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms
          FROM storage_ingestion_changes WHERE source_id=$1 AND sequence>$2
         ORDER BY sequence LIMIT $3`, input.sourceId, input.afterSequence, limit));
      return Object.freeze(result.rows.map((row) => Object.freeze({
        sourceId: safeString(row.source_id, "analytics_delivery.read"),
        sequence: safeInteger(row.sequence, "analytics_delivery.read"),
        eventDigest: safeString(row.event_digest, "analytics_delivery.read"),
        ownerDigest: safeString(row.owner_digest, "analytics_delivery.read"),
        ownerRevision: safeInteger(row.owner_revision, "analytics_delivery.read"),
        authorityEpoch: safeInteger(row.authority_epoch, "analytics_delivery.read"),
        kind: safeString(row.kind, "analytics_delivery.read") as StorageAnalyticsChange["kind"],
        recordedMs: safeInteger(row.recorded_ms, "analytics_delivery.read"),
      })));
    },
    async apply(input): Promise<"applied" | "already_applied"> {
      const operation = "analytics_delivery.apply";
      try {
        return await inTransaction(database, operation, async (transaction) => {
          const receipt = await execute(transaction, operation, statement(`
            SELECT 1 FROM analytics_applied_events
             WHERE source_id=$1 AND sequence=$2 AND event_digest=$3 LIMIT 1`, input.change.sourceId,
          input.change.sequence, input.change.eventDigest));
          if (receipt.rows.length) return "already_applied";
          await execute(transaction, operation, statement(`
            INSERT INTO analytics_applied_events(source_id,sequence,event_digest,owner_digest,authority_epoch,projection_json)
            VALUES($1,$2,$3,$4,$5,$6)`, input.change.sourceId, input.change.sequence, input.change.eventDigest,
          input.change.ownerDigest, input.change.authorityEpoch, JSON.stringify(input.projection)));
          const cursor = await execute(transaction, operation, statement(`
            UPDATE analytics_source_cursors SET sequence=$1,authority_epoch=GREATEST(authority_epoch,$2)
             WHERE source_id=$3 AND sequence=$4 RETURNING source_id`, input.change.sequence, input.change.authorityEpoch,
          input.change.sourceId, input.change.sequence - 1));
          if (cursor.rowCount !== 1) throw new PostgresStorageError("conflict", operation, { retryable: true });
          return "applied";
        });
      } catch (error) {
        throw normalizePostgresError(error, operation);
      }
    },
    async readCursor(input) {
      const result = await execute<Record<string, unknown>>(database, "analytics_delivery.read_cursor", statement(`
        SELECT sequence,authority_epoch FROM analytics_source_cursors WHERE source_id=$1`, input.sourceId));
      const row = result.rows[0];
      if (!row) return { sequence: 0, authorityEpoch: 0 };
      return { sequence: safeInteger(row.sequence, "analytics_delivery.read_cursor"), authorityEpoch: safeInteger(row.authority_epoch, "analytics_delivery.read_cursor") };
    },
    async authorityIsCurrent(input): Promise<boolean> {
      const result = await execute(database, "analytics_delivery.authority", statement(`
        SELECT 1 FROM storage_source_state WHERE singleton=1 AND source_id=$1 AND authority_epoch=$2`, input.sourceId, input.authorityEpoch));
      return result.rows.length === 1;
    },
  };
}

export function createPostgresOwnerRouter(
  pool: PostgresPool,
  schemaOptions: PostgresSchemaOptions = {},
): StorageOwnerRouter {
  const database = storageDatabase(pool, schemaOptions);
  return {
    async resolve(ownerId: string): Promise<StorageOwnerRoute> {
      const result = await execute<Record<string, unknown>>(database, "routing.resolve", statement(`
        SELECT owner_id,shard_id,route_generation,state FROM storage_owner_routes
         WHERE owner_id=$1 AND state='active' LIMIT 1`, ownerId));
      const row = result.rows[0];
      if (!row) throw new PostgresStorageError("not_found", "routing.resolve");
      return Object.freeze({ ownerId: safeString(row.owner_id, "routing.resolve"), shardId: safeString(row.shard_id, "routing.resolve"), generation: safeInteger(row.route_generation, "routing.resolve"), state: "active" });
    },
    async assertCurrent(input): Promise<void> {
      const operation = `routing.${input.operation}`;
      const route = await this.resolve(input.route.ownerId);
      if (route.shardId !== input.route.shardId || route.generation !== input.route.generation || route.state !== "active") {
        throw new PostgresStorageError("conflict", operation, { retryable: true });
      }
      const fence = await execute(database, operation, statement(`
        SELECT 1 FROM storage_owner_fences
         WHERE owner_id=$1 AND shard_id=$2 AND route_generation=$3 AND state='active'`, route.ownerId, route.shardId, route.generation));
      if (fence.rows.length !== 1) throw new PostgresStorageError("source_stale", operation, { retryable: true });
    },
  };
}

/** One-time release/update guard authority.  The delete and insert happen in
 * one transaction so an expired nonce cannot be resurrected by a concurrent
 * request, and a lost insert acknowledgement is reconciled by the unique key.
 */
interface PostgresReleaseNonceStore extends StorageReleaseGuardNonceStore {
  purgeExpired(nowSeconds: number, limit: number): Promise<{ readonly deleted: number; readonly complete: boolean }>;
}

function validReleaseNonceWindow(nonce: unknown, options: ReleaseNonceConsumeOptions): boolean {
  return typeof nonce === "string" && nonce.length > 0 && nonce.length <= 512
    && Number.isSafeInteger(options.nowSeconds) && options.nowSeconds >= 0
    && Number.isSafeInteger(options.expiresAtSeconds)
    && options.expiresAtSeconds > options.nowSeconds;
}

/** PostgreSQL implementation of the release guard's existing neutral nonce port. */
export function createPostgresReleaseNonceStore(
  pool: PostgresPool,
  schemaOptions: PostgresSchemaOptions = {},
): PostgresReleaseNonceStore {
  const database = storageDatabase(pool, schemaOptions);
  return {
    async consume(nonce, options): Promise<"consumed" | "replay"> {
      const operation = "release_guard.consume_nonce";
      if (!validReleaseNonceWindow(nonce, options)) {
        throw new ReleaseNonceStorageUnavailableError();
      }
      try {
        return await inTransaction(database, operation, async (transaction) => {
          // Delete only this nonce at the exact expiry boundary. A global
          // cleanup would make unrelated claims contend and could turn an
          // expired row into a replay if cleanup and insert interleave.
          await execute(transaction, operation, statement(`
            DELETE FROM sparkle_appcast_guard_nonces
             WHERE nonce=$1 AND expires_at <= to_timestamp($2)`, nonce, options.nowSeconds));
          const inserted = await execute<Record<string, unknown>>(transaction, operation, statement(`
            INSERT INTO sparkle_appcast_guard_nonces(nonce,expires_at)
            VALUES($1,to_timestamp($2))
            ON CONFLICT(nonce) DO NOTHING
            RETURNING nonce`, nonce, options.expiresAtSeconds));
          return inserted.rows.length === 1 ? "consumed" : "replay";
        });
      } catch {
        // Keep the release guard's neutral error boundary content-free.
        throw new ReleaseNonceStorageUnavailableError();
      }
    },
    async purgeExpired(nowSeconds, limit): Promise<{ deleted: number; complete: boolean }> {
      const operation = "release_guard.purge_nonces";
      const bounded = normalizeLimit(limit, 256, operation);
      if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
        throw new ReleaseNonceStorageUnavailableError();
      }
      try {
        const result = await executeMutation<Record<string, unknown>>(database, operation, statement(`
          WITH doomed AS (
            SELECT nonce FROM sparkle_appcast_guard_nonces
             WHERE expires_at <= to_timestamp($1) ORDER BY expires_at,nonce LIMIT $2
          ) DELETE FROM sparkle_appcast_guard_nonces n USING doomed d
           WHERE n.nonce=d.nonce RETURNING n.nonce`, nowSeconds, bounded));
        const remaining = await execute(database, operation, statement(
          "SELECT 1 FROM sparkle_appcast_guard_nonces WHERE expires_at <= to_timestamp($1) LIMIT 1",
          nowSeconds,
        ));
        return { deleted: result.rowCount, complete: remaining.rows.length === 0 };
      } catch {
        throw new ReleaseNonceStorageUnavailableError();
      }
    },
  };
}

/** Compatibility name for storage-provider composition roots. */
export const createPostgresReleaseGuardNonceStore = createPostgresReleaseNonceStore;
