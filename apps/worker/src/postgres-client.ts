/**
 * Provider-neutral PostgreSQL boundary for Worker storage adapters.
 *
 * The Worker bundle does not import `pg`. A host composition root supplies a
 * pool matching these structural interfaces. Adapter operations should use
 * the bounded transaction helpers below and keep object-store calls outside
 * the transaction callback.
 */

export interface PostgresQueryResult<Row extends object = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

/** Structural subset implemented by a host PostgreSQL client. */
export interface PostgresClient {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PostgresQueryResult<Row>>;
  release(discard?: boolean): void | Promise<void>;
}

/** Structural subset implemented by a host PostgreSQL pool. */
export interface PostgresPool {
  connect(): Promise<PostgresClient>;
}

/**
 * The one application schema. There is no deletion-ledger schema: decisions
 * D2, D4 and D6 (2026-09-26) remove the independent ledger from the
 * PostgreSQL line.
 */
export interface PostgresSchemaConfig {
  readonly primarySchema: string;
}

export interface PostgresSchemaOptions {
  readonly primarySchema?: unknown;
}

/**
 * Opaque source identity supplied by the host composition root.  These values
 * are data, never SQL identifiers; keeping them separate from schema options
 * prevents an imported source from being silently renamed while still
 * allowing isolated qualification databases to choose their own identity.
 */
export interface PostgresSourceIdentityOptions {
  readonly sourceId?: unknown;
  readonly sourceNamespace?: unknown;
}

export interface PostgresSourceIdentityConfig {
  readonly sourceId: string;
  readonly sourceNamespace: string;
}

export const DEFAULT_POSTGRES_SCHEMA_CONFIG: PostgresSchemaConfig = Object.freeze({
  primarySchema: "tibotattle",
});

const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const SOURCE_IDENTITY = /^[\x21-\x7e]{1,200}$/u;

function reservedSchemaIdentifier(value: string): boolean {
  return value === "pg_catalog"
    || value === "pg_toast"
    || value === "information_schema"
    || value.startsWith("pg_");
}

function validSchemaIdentifier(value: unknown): value is string {
  return typeof value === "string" && SCHEMA_IDENTIFIER.test(value);
}

function validSourceIdentity(value: unknown): value is string {
  return typeof value === "string" && SOURCE_IDENTITY.test(value);
}

/**
 * Validate the runtime-configured schema name before it reaches an identifier
 * position. Test harnesses may provide an isolated name; production defaults
 * to the canonical primary schema. A caller that still passes the retired
 * ledger schema key fails closed instead of having it silently ignored.
 */
export function createPostgresSchemaConfig(
  options: PostgresSchemaOptions = {},
): PostgresSchemaConfig {
  if (options === null || typeof options !== "object"
      || Object.hasOwn(options, "ledgerSchema")) {
    throw new TypeError("invalid PostgreSQL schema configuration");
  }
  const primarySchema = options.primarySchema === undefined
    ? DEFAULT_POSTGRES_SCHEMA_CONFIG.primarySchema
    : options.primarySchema;
  if (!validSchemaIdentifier(primarySchema) || reservedSchemaIdentifier(primarySchema)) {
    throw new TypeError("invalid PostgreSQL schema configuration");
  }
  return Object.freeze({ primarySchema });
}

/** Alias emphasizing that this is the validated runtime boundary. */
export const resolvePostgresSchemaConfig = createPostgresSchemaConfig;

export const DEFAULT_POSTGRES_SOURCE_IDENTITY: PostgresSourceIdentityConfig = Object.freeze({
  sourceId: "canonical-v1-primary",
  sourceNamespace: "telemetry-v1",
});

/** Validate host-provided source identity before it reaches any adapter. */
export function createPostgresSourceIdentityConfig(
  options: PostgresSourceIdentityOptions = {},
): PostgresSourceIdentityConfig {
  const sourceId = options.sourceId === undefined
    ? DEFAULT_POSTGRES_SOURCE_IDENTITY.sourceId : options.sourceId;
  const sourceNamespace = options.sourceNamespace === undefined
    ? DEFAULT_POSTGRES_SOURCE_IDENTITY.sourceNamespace : options.sourceNamespace;
  if (!validSourceIdentity(sourceId) || !validSourceIdentity(sourceNamespace)) {
    throw new TypeError("invalid PostgreSQL source identity");
  }
  return Object.freeze({ sourceId, sourceNamespace });
}

/** Quote a schema/table identifier after applying the same closed validation. */
export function quotePostgresIdentifier(identifier: unknown): string {
  if (!validSchemaIdentifier(identifier)) throw new TypeError("invalid PostgreSQL identifier");
  return `"${identifier}"`;
}

export interface PostgresTransactionOptions {
  readonly readOnly?: boolean;
  readonly isolationLevel?: "read_committed" | "repeatable_read";
  readonly statementTimeoutMilliseconds?: number;
  readonly lockTimeoutMilliseconds?: number;
  /** A short fixed label used only in sanitized local errors. */
  readonly operation?: string;
  /**
   * Optional caller-owned mapper for a reviewed closed domain error. It must
   * return only a safe application error such as an ApiError; provider errors
   * and arbitrary messages must return null.
   */
  readonly preserveSafeError?: (error: unknown) => Error | null;
}

export const DEFAULT_POSTGRES_TRANSACTION_OPTIONS: Required<
  Pick<PostgresTransactionOptions, "statementTimeoutMilliseconds" | "lockTimeoutMilliseconds">
> = Object.freeze({
  statementTimeoutMilliseconds: 10_000,
  lockTimeoutMilliseconds: 5_000,
});

export type PostgresStorageFailureCode =
  | "conflict"
  | "unavailable"
  | "timeout"
  | "invalid";

/**
 * Safe application-facing error. It intentionally has no `cause`, provider
 * message, SQL text, bind values, or driver stack attached.
 */
export class PostgresStorageError extends Error {
  readonly code: PostgresStorageFailureCode;
  readonly operation: string;
  readonly retryable: boolean;

  constructor(
    code: PostgresStorageFailureCode,
    operation: string,
    options: { readonly retryable?: boolean } = {},
  ) {
    const safeOperation = operationLabel(operation);
    super(`POSTGRES_${code.toUpperCase()}:${safeOperation}`);
    this.name = "PostgresStorageError";
    this.code = code;
    this.operation = safeOperation;
    this.retryable = options.retryable ?? (code === "conflict" || code === "timeout");
  }
}

function operationLabel(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_.:-]{1,80}$/iu.test(value)) {
    return "postgres";
  }
  return value;
}

function timeoutMilliseconds(value: unknown, fallback: number): number {
  const timeout = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 600_000) {
    throw new TypeError("invalid PostgreSQL transaction timeout");
  }
  return timeout as number;
}

interface NormalizedPostgresTransactionOptions {
  readonly readOnly: boolean;
  readonly isolationLevel: "read_committed" | "repeatable_read";
  readonly statementTimeoutMilliseconds: number;
  readonly lockTimeoutMilliseconds: number;
  readonly operation: string;
  readonly preserveSafeError: ((error: unknown) => Error | null) | undefined;
}

function transactionOptions(options: PostgresTransactionOptions): NormalizedPostgresTransactionOptions {
  const isolationLevel = options.isolationLevel ?? "read_committed";
  if (isolationLevel !== "read_committed" && isolationLevel !== "repeatable_read") {
    throw new TypeError("invalid PostgreSQL isolation level");
  }
  return {
    readOnly: options.readOnly ?? false,
    isolationLevel,
    statementTimeoutMilliseconds: timeoutMilliseconds(
      options.statementTimeoutMilliseconds,
      DEFAULT_POSTGRES_TRANSACTION_OPTIONS.statementTimeoutMilliseconds,
    ),
    lockTimeoutMilliseconds: timeoutMilliseconds(
      options.lockTimeoutMilliseconds,
      DEFAULT_POSTGRES_TRANSACTION_OPTIONS.lockTimeoutMilliseconds,
    ),
    operation: operationLabel(options.operation),
    preserveSafeError: options.preserveSafeError,
  };
}

function sqlState(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  try {
    const code = Reflect.get(error, "code");
    if (typeof code === "string") return code;
    const state = Reflect.get(error, "sqlState");
    return typeof state === "string" ? state : null;
  } catch {
    return null;
  }
}

/** Map only closed SQLSTATE classes; provider messages never cross this boundary. */
export function normalizePostgresError(
  error: unknown,
  operation = "postgres",
): PostgresStorageError {
  if (error instanceof PostgresStorageError) return error;
  switch (sqlState(error)) {
    case "40001":
    case "40P01":
    case "23505":
    case "23514":
      return new PostgresStorageError("conflict", operation, { retryable: true });
    case "57014":
    case "55P03":
      return new PostgresStorageError("timeout", operation, { retryable: true });
    case "22P02":
    case "23502":
    case "23503":
      return new PostgresStorageError("invalid", operation, { retryable: false });
    default:
      return new PostgresStorageError("unavailable", operation, { retryable: false });
  }
}

function timeoutStatement(name: "statement_timeout" | "lock_timeout", milliseconds: number): string {
  return `SET LOCAL ${name}='${milliseconds}ms'`;
}

function beginStatement(
  readOnly: boolean,
  isolationLevel: "read_committed" | "repeatable_read",
): string {
  if (isolationLevel === "repeatable_read") {
    return readOnly
      ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
      : "BEGIN ISOLATION LEVEL REPEATABLE READ";
  }
  return readOnly ? "BEGIN READ ONLY" : "BEGIN";
}

async function releaseOnce(
  client: PostgresClient,
  discard: boolean,
  state: { released: boolean },
  operation: string,
): Promise<PostgresStorageError | null> {
  if (state.released) return null;
  state.released = true;
  try {
    await client.release(discard);
    return null;
  } catch {
    return new PostgresStorageError("unavailable", `${operation}.release`, { retryable: false });
  }
}

/**
 * Run one bounded database transaction. The callback must contain database
 * work only: external object calls belong before or after this helper so a
 * commit acknowledgement cannot be confused with an object-store outcome.
 * Every acquired client is released exactly once.
 */
export async function withPostgresTransaction<T>(
  pool: PostgresPool,
  operation: (client: PostgresClient) => Promise<T>,
  options: PostgresTransactionOptions = {},
): Promise<T> {
  const config = transactionOptions(options);
  let client: PostgresClient;
  try {
    client = await pool.connect();
  } catch {
    throw new PostgresStorageError("unavailable", `${config.operation}.connect`, { retryable: true });
  }

  const releaseState = { released: false };
  let beginAttempted = false;
  let transactionStarted = false;
  let commitAttempted = false;
  try {
    beginAttempted = true;
    await client.query(beginStatement(config.readOnly, config.isolationLevel));
    transactionStarted = true;
    await client.query(
      timeoutStatement("statement_timeout", config.statementTimeoutMilliseconds),
    );
    await client.query(timeoutStatement("lock_timeout", config.lockTimeoutMilliseconds));
    const value = await operation(client);
    // From this point onward the commit result may be unknown to the caller.
    commitAttempted = true;
    await client.query("COMMIT");
    const releaseError = await releaseOnce(client, false, releaseState, config.operation);
    if (releaseError !== null) throw releaseError;
    return value;
  } catch (error) {
    let rollbackFailed = false;
    if (transactionStarted && !commitAttempted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        rollbackFailed = true;
      }
    }
    const discard = commitAttempted || rollbackFailed || (beginAttempted && !transactionStarted);
    const releaseError = await releaseOnce(client, discard, releaseState, config.operation);
    if (commitAttempted) {
      throw new PostgresStorageError("unavailable", `${config.operation}.commit`, { retryable: false });
    }
    if (rollbackFailed) {
      throw new PostgresStorageError("unavailable", `${config.operation}.rollback`, { retryable: false });
    }
    if (beginAttempted && !transactionStarted) {
      throw new PostgresStorageError("unavailable", `${config.operation}.begin`, { retryable: true });
    }
    if (releaseError !== null) throw releaseError;
    if (!commitAttempted && !rollbackFailed && config.preserveSafeError !== undefined) {
      let safeError: Error | null = null;
      try {
        safeError = config.preserveSafeError(error);
      } catch {
        // A mapper is an optional convenience; a broken mapper cannot expose
        // provider details or replace the sanitized storage error.
      }
      if (safeError instanceof Error) throw safeError;
    }
    throw normalizePostgresError(error, config.operation);
  }
}

/** Execute a bounded read transaction with read-only mode enforced. */
export function withPostgresRead<T>(
  pool: PostgresPool,
  operation: (client: PostgresClient) => Promise<T>,
  options: Omit<PostgresTransactionOptions, "readOnly"> = {},
): Promise<T> {
  return withPostgresTransaction(pool, operation, {
    ...options,
    readOnly: true,
    isolationLevel: options.isolationLevel ?? "repeatable_read",
  });
}

/** Execute a bounded mutation transaction. */
export function withPostgresMutation<T>(
  pool: PostgresPool,
  operation: (client: PostgresClient) => Promise<T>,
  options: Omit<PostgresTransactionOptions, "readOnly"> = {},
): Promise<T> {
  return withPostgresTransaction(pool, operation, { ...options, readOnly: false });
}
