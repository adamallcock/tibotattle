import {
  assertAdmissionBindings,
  assertAttemptAllowed,
  assertDeviceSyncBindings,
  assertDeviceSyncCredentialAllowed,
  assertDeviceSyncPrincipalAllowed,
} from "./admission";
import { parseDeviceAuthorization, type DevicePrincipal } from "./device-auth";
import { ApiError } from "./errors";
import { authenticatePostgresDeviceBearer } from "./postgres-device-bearer-auth";
import type { PostgresPool, PostgresSchemaConfig } from "./postgres-client";

export interface PostgresDeviceSyncPrincipalOptions {
  readonly pool: PostgresPool;
  readonly schema?: PostgresSchemaConfig;
  readonly env: Env;
  readonly clock?: () => number;
}

export type PostgresDeviceSyncPrincipal = (
  request: Request,
  method?: string,
) => Promise<DevicePrincipal>;

function methodNotAllowed(method: string): never {
  throw new ApiError(405, "METHOD_NOT_ALLOWED", {
    responseHeaders: { allow: method },
  });
}

function presentsDeviceBearer(header: string | null): header is string {
  try {
    parseDeviceAuthorization(header);
    return true;
  } catch {
    return false;
  }
}

async function chargeUnauthenticatedAttempt(request: Request, env: Env): Promise<void> {
  await assertAttemptAllowed(
    env.RECOVERY_RATE_LIMIT,
    env.CLIENT_ATTEMPT_RATE_LIMIT,
    request,
    env,
    "device_sync",
  );
}

/** Check the method, required bindings and pre-auth device-sync budgets. */
export async function admitDeviceSyncRequest(
  request: Request,
  method: string,
  env: Env,
): Promise<string> {
  if (request.method !== method) methodNotAllowed(method);

  assertAdmissionBindings(env);
  assertDeviceSyncBindings(env);

  const authorization = request.headers.get("authorization");
  if (request.headers.has("cookie") || !presentsDeviceBearer(authorization)) {
    await chargeUnauthenticatedAttempt(request, env);
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }

  await assertDeviceSyncCredentialAllowed(
    env.DEVICE_SYNC_CLIENT_RATE_LIMIT,
    env.DEVICE_SYNC_RATE_LIMIT,
    request,
    env,
  );
  return authorization;
}

/** Charge malformed authentication discovered after a well-formed bearer was admitted. */
export async function chargeDeviceSyncAuthenticationFailure(
  request: Request,
  env: Env,
  error: unknown,
): Promise<void> {
  if (error instanceof ApiError && error.code === "DEVICE_AUTH_INVALID") {
    await chargeUnauthenticatedAttempt(request, env);
  }
}

/** Charge a successfully authenticated principal after bearer verification. */
export async function admitDeviceSyncParticipant(
  participantId: string,
  env: Env,
): Promise<void> {
  await assertDeviceSyncPrincipalAllowed(
    env.DEVICE_SYNC_PRINCIPAL_RATE_LIMIT,
    participantId,
    env,
  );
}

/**
 * Shared admission and authentication for PostgreSQL device-sync routes.
 * The ordering matches the Worker: malformed requests use attempt budgets,
 * well-formed credentials use edge-replayed client/location budgets before
 * touching PostgreSQL, authentication failures then use attempt budgets, and
 * valid principals use a participant-keyed PostgreSQL budget.
 */
export function createPostgresDeviceSyncPrincipal({
  pool,
  schema,
  env,
  clock = Date.now,
}: PostgresDeviceSyncPrincipalOptions): PostgresDeviceSyncPrincipal {
  return async (request, method = "GET") => {
    const authorization = await admitDeviceSyncRequest(request, method, env);
    let principal: DevicePrincipal;
    try {
      principal = await authenticatePostgresDeviceBearer(pool, authorization, {
        schema,
        nowEpoch: clock(),
        accountlessAuthorizationVersion: "v1.1",
      });
    } catch (error) {
      await chargeDeviceSyncAuthenticationFailure(request, env, error);
      throw error;
    }
    await admitDeviceSyncParticipant(principal.participantId, env);
    return principal;
  };
}
