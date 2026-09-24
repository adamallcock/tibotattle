import {
  createPostgresSchemaConfig,
  createPostgresSourceIdentityConfig,
  type PostgresPool,
  type PostgresSchemaOptions,
  type PostgresSourceIdentityOptions,
} from "./postgres-client";

/**
 * PostgreSQL foundation available to host-side migration and connection
 * rehearsals. This is deliberately not a Worker application backend: current
 * request dispatch, typed v1.2 ingestion/readers, and analytics still use the
 * D1 contracts and are not routed through these pools.
 */
export interface PostgresWorkerBackendFoundation {
  readonly provider: "postgres";
  readonly applicationReady: false;
  readonly schemas: Readonly<{ primary: string; ledger: string }>;
  readonly sourceIdentity: Readonly<{ sourceId: string; sourceNamespace: string }>;
  readonly pools: Readonly<{ primary: PostgresPool; ledger: PostgresPool }>;
  readonly unsupportedContracts: typeof POSTGRES_UNSUPPORTED_CURRENT_MAIN_CONTRACTS;
}

export interface PostgresWorkerBackendOptions extends PostgresSourceIdentityOptions {
  readonly primaryPool: PostgresPool;
  readonly ledgerPool: PostgresPool;
  readonly schemaOptions?: PostgresSchemaOptions;
}

/** Current-main contracts that have no PostgreSQL adapter or route binding. */
export const POSTGRES_UNSUPPORTED_CURRENT_MAIN_CONTRACTS = Object.freeze([
  "worker-request-dispatch",
  "four-source-role-routing",
  "normalized-typed-v1.2-ingestion",
  "current-effective-telemetry-readers",
  "current-analytics-source-and-publication-contracts",
] as const);

function assertPool(value: unknown): asserts value is PostgresPool {
  if (value === null || typeof value !== "object"
      || typeof Reflect.get(value, "connect") !== "function") {
    throw new TypeError("POSTGRES_POOL_INVALID");
  }
}

/**
 * Validate explicit primary and deletion-ledger pools without connecting.
 * Callers may use this foundation for schema-only rehearsal; `applicationReady`
 * remains false until the current Worker route and storage contracts are ported.
 */
export function createPostgresWorkerBackend(
  options: PostgresWorkerBackendOptions,
): PostgresWorkerBackendFoundation {
  assertPool(options?.primaryPool);
  assertPool(options?.ledgerPool);
  const schema = createPostgresSchemaConfig(options.schemaOptions ?? {});
  const sourceIdentity = createPostgresSourceIdentityConfig({
    sourceId: options.sourceId,
    sourceNamespace: options.sourceNamespace,
  });
  return Object.freeze({
    provider: "postgres" as const,
    applicationReady: false as const,
    schemas: Object.freeze({
      primary: schema.primarySchema,
      ledger: schema.ledgerSchema,
    }),
    sourceIdentity: Object.freeze({
      sourceId: sourceIdentity.sourceId,
      sourceNamespace: sourceIdentity.sourceNamespace,
    }),
    pools: Object.freeze({
      primary: options.primaryPool,
      ledger: options.ledgerPool,
    }),
    unsupportedContracts: POSTGRES_UNSUPPORTED_CURRENT_MAIN_CONTRACTS,
  });
}

/** Host processes must not serve requests until route adapters are qualified. */
export function isPostgresWorkerRequestPathSupported(): false {
  return false;
}
