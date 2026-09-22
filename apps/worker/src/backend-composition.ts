import type { IdentityHandoffBackend } from "./identity-handoff-backend";
import {
  createPostgresIdentityHandoffBackend,
} from "./postgres-identity-handoff-backend";
import {
  createPostgresReleaseGuardNonceStore,
  createPostgresAdminStore,
  createPostgresAnalyticsDeliveryStore,
  createPostgresAnalyticalWorkStore,
  createPostgresLifecycleStore,
  createPostgresOwnerRouter,
  createPostgresPreparedSourceStore,
  createPostgresPublicationStore,
} from "./postgres-storage-provider";
import { createPostgresStorageSource } from "./postgres-storage-source";
import {
  createPostgresWorkerApplication,
  type PostgresWorkerApplication,
} from "./postgres-worker-application";
import {
  createPostgresTelemetryAuthorityBackend,
} from "./postgres-telemetry-authority-backend";
import {
  createExperimentalPostgresTelemetryV1Backend,
} from "./postgres-telemetry-v1-backend";
import {
  createPostgresSchemaConfig,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";
import type { StorageProviderPorts, StorageReleaseGuardNonceStore } from "./storage-provider-ports";
import type { TelemetryAuthorityBackend } from "./telemetry-authority-backend";
import type { TelemetryV1Backend } from "./telemetry-v1-backend";
import { WORKER_ROUTE_POLICY } from "./route-registry";
import { ApiError } from "./errors";

/**
 * The complete provider bundle used by a host-side Worker composition root.
 *
 * This object is intentionally separate from Cloudflare's `Env`: a PostgreSQL
 * pool is never a Wrangler binding and must be supplied by the host that owns
 * it. The Worker entrypoint may receive one through the test-only
 * `POSTGRES_WORKER_BACKEND` extension below, but deployed Cloudflare requests
 * continue to use their explicitly configured D1 adapters until each route is
 * migrated.
 */
export interface WorkerBackend {
  readonly provider: "postgres";
  readonly schemas: Readonly<{
    primary: string;
    ledger: string;
  }>;
  readonly authority: TelemetryAuthorityBackend;
  readonly identity: IdentityHandoffBackend;
  readonly telemetryV1: TelemetryV1Backend;
  readonly storage: StorageProviderPorts;
  readonly application: PostgresWorkerApplication;
  readonly releaseNonce: StorageReleaseGuardNonceStore;
}

export interface PostgresWorkerBackendOptions {
  readonly primaryPool: PostgresPool;
  readonly ledgerPool: PostgresPool;
  readonly schemaOptions?: PostgresSchemaOptions;
}

/**
 * Compose all currently implemented PostgreSQL ports against one canonical
 * primary schema and an independent ledger schema. No adapter selects a
 * provider implicitly; the caller owns the pools and migration lifecycle.
 */
export function createPostgresWorkerBackend(
  options: PostgresWorkerBackendOptions,
): WorkerBackend {
  const schemaOptions = options.schemaOptions ?? {};
  const schema = createPostgresSchemaConfig(schemaOptions);
  const primary = options.primaryPool;

  const storage: StorageProviderPorts = Object.freeze({
    source: createPostgresStorageSource(primary, schemaOptions),
    preparedSource: createPostgresPreparedSourceStore(primary, schemaOptions),
    analyticalWork: createPostgresAnalyticalWorkStore(primary, schemaOptions),
    publication: createPostgresPublicationStore(primary, schemaOptions),
    admin: createPostgresAdminStore(primary, schemaOptions),
    lifecycle: createPostgresLifecycleStore({
      primaryPool: primary,
      ledgerPool: options.ledgerPool,
      schemaOptions,
    }),
    analyticsDelivery: createPostgresAnalyticsDeliveryStore(primary, schemaOptions),
    ownerRouter: createPostgresOwnerRouter(primary, schemaOptions),
  });
  const authority = createPostgresTelemetryAuthorityBackend(primary, schemaOptions);

  return Object.freeze({
    provider: "postgres" as const,
    schemas: Object.freeze({
      primary: schema.primarySchema,
      ledger: schema.ledgerSchema,
    }),
    authority,
    identity: createPostgresIdentityHandoffBackend(primary, schemaOptions),
    telemetryV1: createExperimentalPostgresTelemetryV1Backend(primary, schemaOptions),
    storage,
    application: createPostgresWorkerApplication(
      primary,
      options.ledgerPool,
      authority,
      schemaOptions,
    ),
    releaseNonce: createPostgresReleaseGuardNonceStore(primary, schemaOptions),
  });
}

/**
 * Host-only environment extension. This key is deliberately absent from the
 * Worker configuration and is only useful to local no-D1 qualification or a
 * future host runtime that explicitly owns PostgreSQL pools.
 */
export const POSTGRES_WORKER_BACKEND_ENV_KEY = "POSTGRES_WORKER_BACKEND" as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasObjectProperty(value: Record<string, unknown>, key: string): boolean {
  return isObject(value[key]);
}

/**
 * Read an explicitly injected bundle without accepting a partial provider.
 * Partial objects would silently fall through to D1 for some operations and
 * make a no-D1 qualification appear greener than the application really is.
 */
export function readWorkerBackend(env: unknown): WorkerBackend | null {
  if (!isObject(env)) return null;
  if (!Object.prototype.hasOwnProperty.call(env, POSTGRES_WORKER_BACKEND_ENV_KEY)) {
    return null;
  }
  const candidate = env[POSTGRES_WORKER_BACKEND_ENV_KEY];
  if (!isObject(candidate)
      || candidate.provider !== "postgres"
      || !hasObjectProperty(candidate, "schemas")
      || !hasObjectProperty(candidate, "authority")
      || !hasObjectProperty(candidate, "identity")
      || !hasObjectProperty(candidate, "telemetryV1")
      || !hasObjectProperty(candidate, "storage")
      || !hasObjectProperty(candidate.storage as Record<string, unknown>, "source")
      || !hasObjectProperty(candidate, "application")
      || !hasObjectProperty(candidate, "releaseNonce")) {
    // An absent host extension is the explicit D1 fallback. A supplied but
    // malformed bundle must fail closed instead of silently routing half the
    // application back to D1 during no-D1 qualification.
    throw new ApiError(503, "POSTGRES_BACKEND_INVALID");
  }
  return candidate as unknown as WorkerBackend;
}

export type PostgresRouteCoverage =
  | "storage_free"
  | "barrier_only"
  | "postgres_composed"
  | "postgres_partial"
  | "d1_legacy";

/**
 * Honest route inventory for the current composition checkpoint. `d1_legacy`
 * means the route still reaches a D1-specific repository from index.ts;
 * `postgres_partial` means a PostgreSQL port exists but the complete route
 * admission/side-effect path still includes D1. `postgres_composed` is
 * reserved for routes proven through the real Worker entrypoint with D1
 * throwing. Only storage-free and composed routes qualify for no-D1
 * application acceptance.
 */
const ROUTE_COVERAGE_OVERRIDES: Readonly<Record<string, PostgresRouteCoverage>> = Object.freeze({
  apple_domain_association: "storage_free",
  health: "barrier_only",
  ready: "d1_legacy",
  session: "postgres_composed",
  logout: "postgres_composed",
  device_sync_state: "postgres_composed",
  device_sync_manifest: "postgres_composed",
  contributions: "postgres_partial",
  community_daily: "postgres_partial",
});

export const POSTGRES_ROUTE_COVERAGE: Readonly<Record<string, PostgresRouteCoverage>> =
  Object.freeze(Object.fromEntries(WORKER_ROUTE_POLICY.map((route) => [
    route.id,
    ROUTE_COVERAGE_OVERRIDES[route.id] ?? "d1_legacy",
  ])));

export function postgresRouteCoverage(routeId: string): PostgresRouteCoverage {
  const coverage = POSTGRES_ROUTE_COVERAGE[routeId];
  if (!coverage) throw new Error("POSTGRES_ROUTE_COVERAGE_MISSING");
  return coverage;
}

export function noD1QualifiedRouteIds(): readonly string[] {
  return Object.entries(POSTGRES_ROUTE_COVERAGE)
    .filter(([, coverage]) => coverage === "storage_free" || coverage === "postgres_composed")
    .map(([routeId]) => routeId);
}
