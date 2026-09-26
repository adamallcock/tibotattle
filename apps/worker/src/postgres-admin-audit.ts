/**
 * PostgreSQL owner-operation audit helpers, ported from the Worker's
 * admin-operations.ts (beginAdminOperation, beginAdminOperationWithId,
 * finishAdminOperation and their actor digest and bounded JSON details).
 *
 * The audit row holds only the action, a domain-separated SHA-256 digest of
 * the owner identity key, an outcome and bounded content-free details. The
 * identity key itself is never stored or logged.
 *
 * Pool functions run and commit their own bounded transaction, so a begin is
 * durable before the audited work starts. `...InTransaction` variants run on
 * the caller's client inside the caller's transaction and never begin,
 * commit or roll back. Every storage failure surfaces as the content-free
 * 503 BACKEND_STORAGE_UNAVAILABLE (never a driver message or SQLSTATE), so a
 * caller that maps reviewed trigger SQLSTATEs from its own statements cannot
 * confuse an audit failure with them.
 *
 * Requires primary migration 0050 (identity id, nullable UNIQUE operation_id,
 * closed action set, 2000-character details, append-only lifecycle).
 */
import type { AdminAction } from "./admin-operations";
import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import {
  quotePostgresIdentifier,
  withPostgresMutation,
  type PostgresClient,
  type PostgresPool,
} from "./postgres-client";

/** Byte-identical to admin-operations.ts ADMIN_IDENTITY_DOMAIN. */
export const ADMIN_ACTOR_DOMAIN = "app-usagemonitor/admin-actor/v1\0";
/** The Worker's safeJson bound and the 0050 details_json CHECK. */
export const ADMIN_AUDIT_DETAILS_MAX_LENGTH = 2000;
/** The closed audit action vocabulary (D1 0037 and primary 0050 CHECK). */
export const POSTGRES_ADMIN_ACTIONS = Object.freeze([
  "set_collection_controls",
  "run_maintenance",
  "sync_distribution",
] as const satisfies readonly AdminAction[]);

// Compile-time ratchet: a Worker action added without a PostgreSQL entry
// (and a matching successor to the 0050 CHECK) fails typecheck here.
type RequireNever<T extends never> = T;
export type PostgresAdminActionsCoverWorker = RequireNever<
  Exclude<AdminAction, (typeof POSTGRES_ADMIN_ACTIONS)[number]>
>;

export type PostgresAdminAuditOutcome = "success" | "failure";

export interface PostgresAdminOperationBegin {
  /**
   * Caller-supplied idempotency key (the Worker's beginAdminOperationWithId).
   * It must be a lowercase RFC 4122 v4 UUID; otherwise 400 BODY_INVALID.
   * Omitted: a fresh random UUID (the Worker's beginAdminOperation).
   */
  readonly operationId?: string;
  readonly action: AdminAction;
  /** Owner identity key; only its domain-separated digest is stored. */
  readonly identityKey: string;
  /** JSON-serializable, content-free details; at most 2000 characters. */
  readonly details: unknown;
  /** Canonical ISO-8601 UTC instant; defaults to the current time. */
  readonly nowIso?: string;
}

export interface PostgresAdminOperationFinish {
  readonly operationId: string;
  readonly outcome: PostgresAdminAuditOutcome;
  readonly details: unknown;
}

const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AUDIT_TIMEOUT_MILLISECONDS = 5_000;

function storageUnavailable(): never {
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function auditTable(schema: unknown): string {
  try {
    return `${quotePostgresIdentifier(schema)}."admin_action_audit"`;
  } catch {
    return storageUnavailable();
  }
}

/**
 * sha256Hex(ADMIN_ACTOR_DOMAIN + identityKey), byte-identical to the Worker's
 * adminIdentityDigest (UTF-8 of the JavaScript string, lowercase hex).
 */
export async function postgresAdminActorDigest(identityKey: string): Promise<string> {
  if (typeof identityKey !== "string") {
    throw new TypeError("invalid admin identity key");
  }
  return sha256Hex(`${ADMIN_ACTOR_DOMAIN}${identityKey}`);
}

/**
 * The Worker's safeJson: JSON.stringify, refusing anything that does not
 * serialize to a string of at most 2000 UTF-16 code units with 400
 * BODY_INVALID. The database bound counts characters, which is never more.
 */
export function boundedAuditDetails(details: unknown): string {
  const json = JSON.stringify(details);
  if (typeof json !== "string" || json.length > ADMIN_AUDIT_DETAILS_MAX_LENGTH) {
    throw new ApiError(400, "BODY_INVALID");
  }
  return json;
}

function auditInstant(value: unknown): string {
  if (value === undefined) return new Date().toISOString();
  if (typeof value !== "string") throw new TypeError("invalid admin operation time");
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new TypeError("invalid admin operation time");
  }
  return value;
}

interface PreparedBegin {
  readonly operationId: string;
  readonly values: readonly unknown[];
}

/** Validate and serialize everything before any database work starts. */
async function prepareBegin(input: PostgresAdminOperationBegin): Promise<PreparedBegin> {
  if (input === null || typeof input !== "object") throw new TypeError("invalid admin operation");
  const operationId = input.operationId === undefined ? crypto.randomUUID() : input.operationId;
  if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  if (!POSTGRES_ADMIN_ACTIONS.includes(input.action)) {
    throw new TypeError("invalid admin action");
  }
  const createdAt = auditInstant(input.nowIso);
  const details = boundedAuditDetails(input.details);
  const actorDigest = await postgresAdminActorDigest(input.identityKey);
  return Object.freeze({
    operationId,
    values: Object.freeze([operationId, input.action, actorDigest, details, createdAt]),
  });
}

interface PreparedFinish {
  readonly values: readonly unknown[];
}

function prepareFinish(input: PostgresAdminOperationFinish): PreparedFinish {
  if (input === null || typeof input !== "object") throw new TypeError("invalid admin operation");
  if (typeof input.operationId !== "string") {
    // As in the Worker, an id that matches no started row is reported through
    // the unchanged row count as storage unavailability.
    storageUnavailable();
  }
  if (input.outcome !== "success" && input.outcome !== "failure") {
    throw new TypeError("invalid admin operation outcome");
  }
  const details = boundedAuditDetails(input.details);
  return Object.freeze({ values: Object.freeze([input.outcome, details, input.operationId]) });
}

function beginStatement(schema: string): string {
  return `INSERT INTO ${auditTable(schema)} (
            operation_id, action, actor_identity_digest, outcome, details_json, created_at
          ) VALUES ($1, $2, $3, 'started', $4, $5::timestamptz)`;
}

function finishStatement(schema: string): string {
  return `UPDATE ${auditTable(schema)}
             SET outcome = $1, details_json = $2
           WHERE operation_id = $3 AND outcome = 'started'`;
}

async function runExactlyOne(
  client: PostgresClient,
  text: string,
  values: readonly unknown[],
): Promise<void> {
  if (client === null || typeof client !== "object" || typeof client.query !== "function") {
    storageUnavailable();
  }
  let rowCount: number | null;
  try {
    rowCount = (await client.query(text, [...values])).rowCount;
  } catch {
    storageUnavailable();
  }
  if (rowCount !== 1) storageUnavailable();
}

async function inOwnTransaction(
  pool: PostgresPool,
  operation: string,
  work: (client: PostgresClient) => Promise<void>,
): Promise<void> {
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function") {
    storageUnavailable();
  }
  try {
    await withPostgresMutation(pool, work, {
      operation,
      statementTimeoutMilliseconds: AUDIT_TIMEOUT_MILLISECONDS,
      lockTimeoutMilliseconds: AUDIT_TIMEOUT_MILLISECONDS,
      preserveSafeError: (error) => (error instanceof ApiError ? error : null),
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    storageUnavailable();
  }
}

/**
 * Insert a 'started' audit row on the caller's client inside the caller's
 * transaction. Returns the operation id. The row becomes durable only when
 * the caller commits.
 */
export async function beginPostgresAdminOperationInTransaction(
  client: PostgresClient,
  schema: string,
  input: PostgresAdminOperationBegin,
): Promise<string> {
  const text = beginStatement(schema);
  const prepared = await prepareBegin(input);
  await runExactlyOne(client, text, prepared.values);
  return prepared.operationId;
}

/**
 * Insert a 'started' audit row in its own transaction and commit it before
 * returning, so the audited work never runs without a durable intent.
 */
export async function beginPostgresAdminOperation(
  pool: PostgresPool,
  schema: string,
  input: PostgresAdminOperationBegin,
): Promise<string> {
  const text = beginStatement(schema);
  const prepared = await prepareBegin(input);
  await inOwnTransaction(pool, "admin_audit.begin", (client) =>
    runExactlyOne(client, text, prepared.values));
  return prepared.operationId;
}

/**
 * Move the caller's 'started' row to a terminal outcome inside the caller's
 * transaction. Exactly one row must change; a missing, malformed or already
 * terminal operation is 503 BACKEND_STORAGE_UNAVAILABLE.
 */
export async function finishPostgresAdminOperationInTransaction(
  client: PostgresClient,
  schema: string,
  input: PostgresAdminOperationFinish,
): Promise<void> {
  const text = finishStatement(schema);
  const prepared = prepareFinish(input);
  await runExactlyOne(client, text, prepared.values);
}

/** finishPostgresAdminOperationInTransaction in its own committed transaction. */
export async function finishPostgresAdminOperation(
  pool: PostgresPool,
  schema: string,
  input: PostgresAdminOperationFinish,
): Promise<void> {
  const text = finishStatement(schema);
  const prepared = prepareFinish(input);
  await inOwnTransaction(pool, "admin_audit.finish", (client) =>
    runExactlyOne(client, text, prepared.values));
}

/**
 * Best-effort terminal record for a failure path whose own error must reach
 * the caller unchanged. Every error, including invalid input, is swallowed;
 * an unrecorded outcome leaves the row 'started', which lease readers treat
 * as an expired attempt.
 */
export async function finishPostgresAdminOperationBestEffort(
  pool: PostgresPool,
  schema: string,
  input: PostgresAdminOperationFinish,
): Promise<void> {
  try {
    await finishPostgresAdminOperation(pool, schema, input);
  } catch {
    // Deliberately swallowed: the audited operation already failed and its
    // own error is the response.
  }
}
