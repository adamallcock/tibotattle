import type { AccountlessEnrollmentRequest } from "./accountless-enrollment";
import {
  deviceAuthorizationCapabilityHash,
  deviceHash,
  parseDeviceAuthorization,
  uploadAuthorizationCapabilityHash,
} from "./device-auth";
import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import {
  assertStorageCatalogEpoch,
  captureActiveOwnerRouteSnapshot,
  createCatalogStorageRouter,
  createSingleIngestionShardRouter,
  STORAGE_SHARD_OPERATING_CAP_BYTES,
  StorageRoutingError,
  type OwnerStorageRoute,
  type OwnerStorageTarget,
  type ActiveOwnerRouteSnapshot,
} from "./storage-routing";

export type StorageRoutingMode = "single" | "catalog";

export interface OwnerStorageContext {
  readonly database: D1Database;
  readonly route: OwnerStorageRoute;
}
export interface OwnerStorageTargetContext extends OwnerStorageTarget {
  readonly database: D1Database;
}

interface CatalogRouter {
  resolve(ownerId: string): Promise<OwnerStorageRoute>;
  database(route: OwnerStorageRoute): Promise<D1Database>;
  ensureCapabilityOwner(
    capabilityHash: string,
    proposedOwnerId: string,
    reservationBytes: number,
  ): Promise<OwnerStorageRoute>;
  locateCapability(capabilityHash: string): Promise<OwnerStorageRoute | null>;
  registerCapability(capabilityHash: string, route: OwnerStorageRoute): Promise<void>;
  revokeCapability(capabilityHash: string, route: OwnerStorageRoute): Promise<void>;
  ownerTargets(route: OwnerStorageRoute): Promise<OwnerStorageTarget[]>;
  registerParticipantOwner(participantDigest: string, route: OwnerStorageRoute): Promise<void>;
  locateParticipantOwner(participantDigest: string): Promise<OwnerStorageRoute | null>;
}

interface RoutingRuntimeEnv {
  STORAGE_ROUTING_MODE?: unknown;
  STORAGE_NEW_OWNER_RESERVATION_BYTES?: unknown;
  STORAGE_ROUTING_DB?: unknown;
  STORAGE_INGESTION_A?: unknown;
  STORAGE_INGESTION_B?: unknown;
  STORAGE_INGESTION_C?: unknown;
}

function database(value: unknown): value is D1Database {
  return value !== null && typeof value === "object"
    && typeof Reflect.get(value, "prepare") === "function"
    && typeof Reflect.get(value, "batch") === "function";
}

function routingMode(env: Env): StorageRoutingMode {
  const configured = (env as Env & RoutingRuntimeEnv).STORAGE_ROUTING_MODE;
  if (configured === undefined || configured === "single") return "single";
  if (configured === "catalog") return "catalog";
  throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
}

function catalogRouter(env: Env): CatalogRouter {
  const runtime = env as Env & RoutingRuntimeEnv;
  if (!database(runtime.STORAGE_ROUTING_DB)
      || !database(runtime.STORAGE_INGESTION_A)
      || !database(runtime.STORAGE_INGESTION_B)
      || !database(runtime.STORAGE_INGESTION_C)) {
    throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
  if (new Set([
    runtime.STORAGE_ROUTING_DB,
    runtime.STORAGE_INGESTION_A,
    runtime.STORAGE_INGESTION_B,
    runtime.STORAGE_INGESTION_C,
  ]).size !== 4) {
    throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
  return createCatalogStorageRouter({
    catalog: runtime.STORAGE_ROUTING_DB,
    bindings: {
      STORAGE_INGESTION_A: runtime.STORAGE_INGESTION_A,
      STORAGE_INGESTION_B: runtime.STORAGE_INGESTION_B,
      STORAGE_INGESTION_C: runtime.STORAGE_INGESTION_C,
    },
    clock: Date.now,
  });
}

function reservationBytes(env: Env): number {
  const configured = (env as Env & RoutingRuntimeEnv)
    .STORAGE_NEW_OWNER_RESERVATION_BYTES;
  const parsed = typeof configured === "string" ? Number(configured) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1
      || parsed > STORAGE_SHARD_OPERATING_CAP_BYTES) {
    throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
  return parsed;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function routingFailure(error: unknown, unknownCapability = false): never {
  if (error instanceof ApiError) throw error;
  if (unknownCapability && error instanceof StorageRoutingError
      && ["ROUTE_NOT_FOUND", "ROUTE_NOT_ACTIVE"].includes(error.code)) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

/**
 * New enrollment proposes a server-generated owner identity. The request's
 * device id is never used as the route owner. Its secret hash is only a
 * catalog locator; enrollment still validates the full shard-local ledger.
 */
export async function storageForAccountlessEnrollment(
  env: Env,
  request: AccountlessEnrollmentRequest,
): Promise<OwnerStorageContext> {
  if (routingMode(env) === "single") {
    const route = await createSingleIngestionShardRouter({
      database: env.USAGE_MONITOR_DB,
    }).resolve(`accountless:${crypto.randomUUID()}`);
    return { database: env.USAGE_MONITOR_DB, route };
  }
  try {
    const router = catalogRouter(env);
    const route = await router.ensureCapabilityOwner(
      hex(request.deviceSecretHash),
      `accountless:${crypto.randomUUID()}`,
      reservationBytes(env),
    );
    return { route, database: await router.database(route) };
  } catch (error) {
    return routingFailure(error, true);
  }
}

/** Locate first, authenticate on the located shard second. */
export async function storageForDeviceAuthorization(
  env: Env,
  authorizationHeader: string | null,
): Promise<OwnerStorageContext> {
  if (routingMode(env) === "single") {
    const parsed = parseDeviceAuthorization(authorizationHeader);
    const route = await createSingleIngestionShardRouter({
      database: env.USAGE_MONITOR_DB,
    }).resolve(`device:${parsed.id}`);
    return { database: env.USAGE_MONITOR_DB, route };
  }
  let presentedHash: Uint8Array | null = null;
  try {
    const parsed = parseDeviceAuthorization(authorizationHeader);
    presentedHash = await deviceHash(parsed.id, parsed.secret);
    const router = catalogRouter(env);
    const route = await router.locateCapability(hex(presentedHash));
    if (!route) throw new ApiError(401, "DEVICE_AUTH_INVALID");
    return { route, database: await router.database(route) };
  } catch (error) {
    return routingFailure(error, true);
  } finally {
    presentedHash?.fill(0);
  }
}

export async function storageForUploadAuthorization(
  env: Env,
  authorizationHeader: string | null,
): Promise<OwnerStorageContext> {
  if (routingMode(env) === "single") {
    const route = await createSingleIngestionShardRouter({ database: env.USAGE_MONITOR_DB })
      .resolve(`upload:${crypto.randomUUID()}`);
    return { database: env.USAGE_MONITOR_DB, route };
  }
  try {
    const capabilityHash = await uploadAuthorizationCapabilityHash(authorizationHeader);
    const router = catalogRouter(env);
    const route = await router.locateCapability(capabilityHash);
    if (!route) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
    return { route, database: await router.database(route) };
  } catch (error) {
    if (error instanceof ApiError && error.code === "UPLOAD_AUTH_INVALID") throw error;
    return routingFailure(error, true);
  }
}

export async function registerUploadAuthorizationRoute(
  env: Env,
  route: OwnerStorageRoute,
  uploadAuthorization: string,
): Promise<void> {
  if (routingMode(env) === "single") return;
  try {
    await catalogRouter(env).registerCapability(
      await uploadAuthorizationCapabilityHash(`Upload ${uploadAuthorization}`),
      route,
    );
  } catch (error) {
    return routingFailure(error);
  }
}

export async function revokeDeviceAuthorizationRoute(
  env: Env,
  route: OwnerStorageRoute,
  authorizationHeader: string | null,
): Promise<void> {
  if (routingMode(env) === "single") return;
  try {
    await catalogRouter(env).revokeCapability(
      await deviceAuthorizationCapabilityHash(authorizationHeader),
      route,
    );
  } catch (error) {
    return routingFailure(error);
  }
}

export async function participantStorageLocatorDigest(
  participantId: string,
): Promise<string> {
  if (!/^participant:[0-9a-f-]{36}$/u.test(participantId)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  return sha256Hex(`app-usagemonitor/storage-participant/v1\0${participantId}`);
}

/** Publish only after the shard-local owner graph is complete. A retry reads
 * the same graph participant id and converges this immutable catalog row. */
export async function registerParticipantOwnerRoute(
  env: Env,
  participantId: string,
  route: OwnerStorageRoute,
): Promise<void> {
  if (routingMode(env) === "single") return;
  try {
    await catalogRouter(env).registerParticipantOwner(
      await participantStorageLocatorDigest(participantId),
      route,
    );
  } catch (error) {
    return routingFailure(error);
  }
}

/** An authenticated shard-local participant is usable only after its immutable
 * admin-erasure locator is durable. This does not authenticate the caller. */
export async function assertParticipantOwnerRouteRegistered(
  env: Env, participantId: string, expected: OwnerStorageRoute,
): Promise<void> {
  if (routingMode(env) === "single") return;
  try {
    const route = await catalogRouter(env).locateParticipantOwner(
      await participantStorageLocatorDigest(participantId),
    );
    if (!route || route.ownerId !== expected.ownerId || route.shardId !== expected.shardId
        || route.bindingName !== expected.bindingName || route.generation !== expected.generation) {
      throw new StorageRoutingError("ROUTE_STALE");
    }
  } catch (error) {
    return routingFailure(error);
  }
}

/** Trusted admin locator. The caller retains Access-owner/CSRF authority. */
export async function storageForParticipantOwner(
  env: Env,
  participantId: string,
): Promise<OwnerStorageContext> {
  if (routingMode(env) === "single") {
    const route = await createSingleIngestionShardRouter({ database: env.USAGE_MONITOR_DB })
      .resolve(participantId);
    return { database: env.USAGE_MONITOR_DB, route };
  }
  try {
    const router = catalogRouter(env);
    const route = await router.locateParticipantOwner(
      await participantStorageLocatorDigest(participantId),
    );
    if (!route) throw new StorageRoutingError("ROUTE_NOT_FOUND");
    return { route, database: await router.database(route) };
  } catch (error) {
    return routingFailure(error);
  }
}

export function catalogRoutingEnabled(env: Env): boolean {
  return routingMode(env) === "catalog";
}

/** Read-only, authenticated-caller seam for retained-copy orchestration. */
export async function storageTargetsForOwnerRoute(
  env: Env,
  route: OwnerStorageRoute,
): Promise<OwnerStorageTargetContext[]> {
  if (routingMode(env) === "single") {
    if (route.mode !== "single") throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    return [{
      ownerId: route.ownerId,
      shardId: route.shardId,
      bindingName: route.bindingName,
      generations: [route.generation],
      current: true,
      database: env.USAGE_MONITOR_DB,
    }];
  }
  try {
    const router = catalogRouter(env);
    const targets = await router.ownerTargets(route);
    const runtime = env as Env & RoutingRuntimeEnv;
    return targets.map((target) => {
      const value = Reflect.get(runtime, target.bindingName);
      if (!database(value)) throw new StorageRoutingError("UNKNOWN_BINDING");
      return { ...target, database: value };
    });
  } catch (error) {
    return routingFailure(error);
  }
}

export async function captureActiveOwnerRoutingSnapshot(
  env: Env,
  options: { afterOwnerId?: string; limit?: number } = {},
): Promise<ActiveOwnerRouteSnapshot> {
  if (routingMode(env) !== "catalog") {
    throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
  try {
    const runtime = env as Env & RoutingRuntimeEnv;
    const router = catalogRouter(env);
    void router;
    return await captureActiveOwnerRouteSnapshot({
      catalog: runtime.STORAGE_ROUTING_DB as D1Database,
      bindings: {
        STORAGE_INGESTION_A: runtime.STORAGE_INGESTION_A as D1Database,
        STORAGE_INGESTION_B: runtime.STORAGE_INGESTION_B as D1Database,
        STORAGE_INGESTION_C: runtime.STORAGE_INGESTION_C as D1Database,
      },
      ...options,
    });
  } catch (error) {
    return routingFailure(error);
  }
}

export async function assertActiveOwnerRoutingSnapshotCurrent(
  env: Env,
  catalogEpoch: number,
): Promise<void> {
  if (routingMode(env) !== "catalog") {
    throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
  try {
    const runtime = env as Env & RoutingRuntimeEnv;
    if (!database(runtime.STORAGE_ROUTING_DB)) {
      throw new StorageRoutingError("UNKNOWN_BINDING");
    }
    await assertStorageCatalogEpoch(runtime.STORAGE_ROUTING_DB, catalogEpoch);
  } catch (error) {
    return routingFailure(error);
  }
}
