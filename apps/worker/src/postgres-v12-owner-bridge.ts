import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";

/**
 * Maintenance access to the PostgreSQL v1.2 owner bridge (staged primary
 * migration 0055). The bridge itself runs inside the transaction that changes
 * a v1.2 domain head: it mints or reuses the owner link, records one
 * storage_v12_event_sources receipt and appends one 'owner-active' journal row
 * through storage_journal_append (D1 ingestion-isolation 0011 parity).
 *
 * A head that changed while it could not be bridged (for example before
 * storage_source_state existed) stays pending. These helpers report and repair
 * that backlog in short transactions of at most one bridged head each, so the
 * repair never holds the source authority while it waits on another owner.
 * They return content-free counts only: no digest, participant, device or
 * source identifier leaves this module.
 *
 * Once 0055 is applied every new head bridges itself, so the backfill is a
 * one-time cutover stage, not part of the every-minute maintenance pass;
 * afterwards a pending count above zero is an alert. Wiring either belongs to
 * its composition root.
 */

/**
 * The most pending heads one backfill transaction inspects; the database
 * refuses more (storage_v12_bridge_limit_invalid). Each transaction bridges at
 * most one of them.
 */
export const POSTGRES_V12_OWNER_BRIDGE_MAX_BATCH = 500;

export type PostgresV12OwnerBridgeCode =
  | "V12_OWNER_BRIDGE_INPUT_INVALID"
  | "V12_OWNER_BRIDGE_TRANSFER_SESSION"
  | "V12_OWNER_BRIDGE_READBACK_FAILED";

export class PostgresV12OwnerBridgeError extends Error {
  readonly code: PostgresV12OwnerBridgeCode;

  constructor(code: PostgresV12OwnerBridgeCode) {
    super(code);
    this.name = "PostgresV12OwnerBridgeError";
    this.code = code;
  }
}

export interface PostgresV12OwnerBridgePending {
  /** False until storage_source_state exists; nothing is bridged before then. */
  readonly sourceInitialized: boolean;
  /** Eligible current heads of non-erased owners without a bridge receipt. */
  readonly pending: number;
}

export interface ReadPostgresV12OwnerBridgePendingOptions {
  readonly pool: PostgresPool;
  readonly schema?: PostgresSchemaOptions;
}

export interface RunPostgresV12OwnerBridgeBackfillOptions {
  readonly pool: PostgresPool;
  readonly schema?: PostgresSchemaOptions;
  /**
   * Pending heads one transaction may inspect, 1..500 (default 500). Heads
   * that another transaction holds are skipped, so a larger window lets a
   * transaction reach an unheld head; it still bridges at most one.
   */
  readonly limit?: number;
  /** Absolute epoch milliseconds after which no further batch starts. */
  readonly deadlineMs: number;
  /** Injected clock for tests; defaults to Date.now. */
  readonly now?: () => number;
}

export interface PostgresV12OwnerBridgeBackfillResult {
  /**
   * complete: nothing is pending. deferred: the deadline passed, or a
   * transaction bridged nothing while heads were still reported pending (held
   * by a concurrent change; the next run retries). source_uninitialized:
   * storage_source_state does not exist, so nothing can be bridged yet.
   */
  readonly status: "complete" | "deferred" | "source_uninitialized";
  /** Heads bridged by this run. */
  readonly bridged: number;
  /** Backfill transactions this run committed; each bridged at most one head. */
  readonly batches: number;
  /**
   * Heads still pending: read from the database, except after a deadline that
   * passed mid-run, where it is the last count less the heads bridged since.
   */
  readonly pending: number;
}

const OPERATION_TIMEOUTS = Object.freeze({
  statementTimeoutMilliseconds: 30_000,
  lockTimeoutMilliseconds: 5_000,
});

/** Constant database refusals raised by migration 0055. */
const DATABASE_CODES: ReadonlyMap<string, PostgresV12OwnerBridgeCode> = new Map([
  ["storage_v12_bridge_limit_invalid", "V12_OWNER_BRIDGE_INPUT_INVALID"],
  ["storage_v12_bridge_transfer_session", "V12_OWNER_BRIDGE_TRANSFER_SESSION"],
]);

function fail(code: PostgresV12OwnerBridgeCode): never {
  throw new PostgresV12OwnerBridgeError(code);
}

function preserveSafeError(error: unknown): Error | null {
  if (error instanceof PostgresV12OwnerBridgeError) return error;
  if (error !== null && typeof error === "object") {
    const state = Reflect.get(error, "code");
    const message = Reflect.get(error, "message");
    const code = state === "P1005" && typeof message === "string" ? DATABASE_CODES.get(message) : undefined;
    if (code !== undefined) return new PostgresV12OwnerBridgeError(code);
  }
  return null;
}

function primarySchema(options: PostgresSchemaOptions | undefined): string {
  try {
    return quotePostgresIdentifier(createPostgresSchemaConfig(options ?? {}).primarySchema);
  } catch {
    fail("V12_OWNER_BRIDGE_INPUT_INVALID");
  }
}

function assertPool(pool: unknown): asserts pool is PostgresPool {
  if (pool === null || typeof pool !== "object" || typeof Reflect.get(pool, "connect") !== "function") {
    fail("V12_OWNER_BRIDGE_INPUT_INVALID");
  }
}

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail("V12_OWNER_BRIDGE_READBACK_FAILED");
  return parsed;
}

function singleRow(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object") fail("V12_OWNER_BRIDGE_READBACK_FAILED");
  const rows = Reflect.get(value, "rows");
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0] === null || typeof rows[0] !== "object") {
    fail("V12_OWNER_BRIDGE_READBACK_FAILED");
  }
  return rows[0] as Record<string, unknown>;
}

async function readPending(pool: PostgresPool, schema: string): Promise<PostgresV12OwnerBridgePending> {
  const row = singleRow(await withPostgresRead(pool, (client) => client.query(
    `SELECT EXISTS (SELECT 1 FROM ${schema}.storage_source_state WHERE singleton=1) AS source_initialized,
            ${schema}.storage_v12_bridge_pending_count()::text AS pending`,
  ), { ...OPERATION_TIMEOUTS, operation: "postgres.v12_owner_bridge.pending", preserveSafeError }));
  if (typeof row.source_initialized !== "boolean") fail("V12_OWNER_BRIDGE_READBACK_FAILED");
  return Object.freeze({ sourceInitialized: row.source_initialized, pending: count(row.pending) });
}

/** Read the bridge backlog as content-free counts. */
export async function readPostgresV12OwnerBridgePending(
  options: ReadPostgresV12OwnerBridgePendingOptions,
): Promise<PostgresV12OwnerBridgePending> {
  if (options === null || typeof options !== "object") fail("V12_OWNER_BRIDGE_INPUT_INVALID");
  assertPool(options.pool);
  return readPending(options.pool, primarySchema(options.schema));
}

/**
 * Bridge pending v1.2 heads, one head per short transaction, until none is
 * pending or `deadlineMs` passes. Each transaction is idempotent: a head is
 * bridged at most once whatever runs concurrently, and a head that an
 * activation bridged meanwhile is skipped. The backlog is counted once, and
 * again only when the heads bridged since reach that count, so a long backlog
 * costs one count per pass rather than one per head. Refused in transfer
 * sessions.
 */
export async function runPostgresV12OwnerBridgeBackfill(
  options: RunPostgresV12OwnerBridgeBackfillOptions,
): Promise<PostgresV12OwnerBridgeBackfillResult> {
  if (options === null || typeof options !== "object") fail("V12_OWNER_BRIDGE_INPUT_INVALID");
  assertPool(options.pool);
  const schema = primarySchema(options.schema);
  const limit = options.limit ?? POSTGRES_V12_OWNER_BRIDGE_MAX_BATCH;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > POSTGRES_V12_OWNER_BRIDGE_MAX_BATCH
      || typeof options.deadlineMs !== "number" || !Number.isFinite(options.deadlineMs)
      || typeof now !== "function") {
    fail("V12_OWNER_BRIDGE_INPUT_INVALID");
  }
  let bridged = 0;
  let batches = 0;
  const result = (status: PostgresV12OwnerBridgeBackfillResult["status"], pending: number) =>
    Object.freeze({ status, bridged, batches, pending });
  let state = await readPending(options.pool, schema);
  // `pending` is exact right after a read and an estimate after bridging.
  let pending = state.pending;
  let exact = true;
  for (;;) {
    if (!state.sourceInitialized) return result("source_uninitialized", pending);
    if (pending === 0 && exact) return result("complete", 0);
    if (pending === 0) {
      state = await readPending(options.pool, schema);
      pending = state.pending;
      exact = true;
      continue;
    }
    if (now() >= options.deadlineMs) return result("deferred", pending);
    const row = singleRow(await withPostgresMutation(options.pool, (client) => client.query(
      `SELECT ${schema}.storage_v12_bridge_backfill($1::integer)::text AS bridged`, [limit],
    ), { ...OPERATION_TIMEOUTS, operation: "postgres.v12_owner_bridge.backfill", preserveSafeError }));
    const batch = count(row.bridged);
    batches += 1;
    bridged += batch;
    if (batch === 0) {
      const after = await readPending(options.pool, schema);
      if (!after.sourceInitialized) return result("source_uninitialized", after.pending);
      return result(after.pending === 0 ? "complete" : "deferred", after.pending);
    }
    pending = Math.max(0, pending - batch);
    exact = false;
  }
}
