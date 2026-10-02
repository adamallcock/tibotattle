import { WORKER_ROUTE_POLICY } from "./route-registry";
import {
  createPostgresSchemaConfig,
  createPostgresSourceIdentityConfig,
  type PostgresPool,
  type PostgresSchemaOptions,
  type PostgresSourceIdentityOptions,
} from "./postgres-client";

/**
 * PostgreSQL foundation available to host-side migration and connection
 * rehearsals. This is deliberately not a Worker application backend: the
 * Worker's own request dispatch, typed ingestion and analytics use the D1
 * contracts and are never routed through these pools. The Cloud Run origin
 * serves POSTGRES_PORTED_WORKER_ROUTE_IDS through its own PostgreSQL route
 * families (cloud-run/postgres-production-host.mjs).
 */
export interface PostgresWorkerBackendFoundation {
  readonly provider: "postgres";
  readonly applicationReady: false;
  readonly schemas: Readonly<{ primary: string }>;
  readonly sourceIdentity: Readonly<{ sourceId: string; sourceNamespace: string }>;
  readonly pools: Readonly<{ primary: PostgresPool }>;
  readonly unsupportedContracts: typeof POSTGRES_UNSUPPORTED_CURRENT_MAIN_CONTRACTS;
}

export interface PostgresWorkerBackendOptions extends PostgresSourceIdentityOptions {
  readonly primaryPool: PostgresPool;
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
 * Validate the one explicit primary pool without connecting. There is no
 * deletion-ledger pool (decisions D2, D4 and D6): a caller that still passes
 * one fails closed. Callers may use this foundation for schema-only
 * rehearsal; `applicationReady` remains false until the current Worker route
 * and storage contracts are ported.
 */
export function createPostgresWorkerBackend(
  options: PostgresWorkerBackendOptions,
): PostgresWorkerBackendFoundation {
  assertPool(options?.primaryPool);
  if (Object.hasOwn(options, "ledgerPool")) throw new TypeError("POSTGRES_LEDGER_POOL_RETIRED");
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
    }),
    sourceIdentity: Object.freeze({
      sourceId: sourceIdentity.sourceId,
      sourceNamespace: sourceIdentity.sourceNamespace,
    }),
    pools: Object.freeze({
      primary: options.primaryPool,
    }),
    unsupportedContracts: POSTGRES_UNSUPPORTED_CURRENT_MAIN_CONTRACTS,
  });
}

/**
 * The WORKER_ROUTE_POLICY ids the Cloud Run origin serves on the public host
 * (CR-6/CR-7, D-CRB): the 21 routes of the wave-3 host scope plus all nine
 * contested routes (owner decision OD-CR-1, 2026-10-02: session, logout,
 * devices, revocation, pairing, pairing claim, v1.2 consent, disconnect and
 * credential renew), in policy order. The six admin console routes are
 * served only on the admin host, behind the Access chokepoint
 * (POSTGRES_ADMIN_HOST_ROUTE_IDS). Every other route (enroll, Google and
 * Apple sign-in, security reset, participant export and the four
 * performance routes; OD-CR-2) answers 503 POSTGRES_ROUTE_NOT_PORTED, and
 * the two root routes are answered by the origin itself. The Worker's own D1
 * handler never serves the PostgreSQL backend: the cloud-run registry
 * (postgres-production-registry.mjs) validates this list against its pinned
 * route classes.
 */
export const POSTGRES_PORTED_WORKER_ROUTE_IDS = Object.freeze([
  "health",
  "ready",
  "accountless_enrollment",
  "accountless_ownership",
  "accountless_telemetry_v12_authorization",
  "accountless_renewal",
  "session",
  "logout",
  "device_pairing",
  "device_pairing_claim",
  "device_upload_authorization",
  "device_disconnect",
  "device_credential_renew",
  "device_sync_state",
  "device_sync_capabilities",
  "device_sync_capabilities_v12",
  "telemetry_v11_consent",
  "telemetry_v12_consent",
  "telemetry_v11_day_manifests",
  "telemetry_v12_day_manifests",
  "telemetry_v11_domain_predecessor",
  "telemetry_v11_domain_activate",
  "telemetry_v12_domain_predecessor",
  "telemetry_v12_domain_activate",
  "device_sync_manifest",
  "participant_devices",
  "participant_device_revocation",
  "envelope_key",
  "contributions",
  "community_daily",
] as const);

/**
 * The admin console routes (the policy's 'admin' authority) the origin
 * serves on the admin host only, after the Access chokepoint (owner decision
 * OD-CR-2: the six admin console routes must work at the switch; ported by
 * C-ADMIN). The production admin host keeps its OD-CR-3 refusal until
 * ADMIN-R12 (round 12 answered OWN-17: open with what is ported); the
 * composition root holds that switch.
 */
export const POSTGRES_ADMIN_HOST_ROUTE_IDS = Object.freeze(WORKER_ROUTE_POLICY
  .filter((route) => route.authority === "admin")
  .map((route) => route.id));

const PORTED_PATHNAMES: ReadonlySet<string> = new Set(WORKER_ROUTE_POLICY
  .filter((route) => (POSTGRES_PORTED_WORKER_ROUTE_IDS as readonly string[]).includes(route.id))
  .map((route) => route.pathname));

/**
 * Whether the Cloud Run origin serves this exact pathname on its public host
 * (POSTGRES_PORTED_WORKER_ROUTE_IDS). A call without a pathname, a
 * non-string, an unknown or unported path and an admin route are false, so
 * the Worker's guard (handleRequest refuses any env that carries
 * POSTGRES_WORKER_BACKEND) and the host's refusal without a mode stay
 * closed.
 */
export function isPostgresWorkerRequestPathSupported(pathname?: unknown): boolean {
  return typeof pathname === "string" && PORTED_PATHNAMES.has(pathname);
}
