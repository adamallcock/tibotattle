/**
 * GET /api/v1/admin/database-health on the PostgreSQL origin (GCP, C-ADMIN).
 *
 * d43c8f92 handleAdminDatabaseHealth in access mode: GET only, any query
 * string (even an empty value) is 400 BODY_INVALID, then the closed
 * 'admin-database-health-v0.2' DTO from the injected readDatabaseHealth
 * adapter (src/postgres-admin-database-health.ts by default): the Worker's
 * v0.1 with the removed deletion ledger reported not_applicable (round 12).
 */

import { ApiError } from "../../src/errors.ts";
import {
  adminFamilyDispatcher,
  adminOk,
  assertAdminFamilyDeps,
  assertAdminMethod,
  requireAdminIdentity,
  requiredFunction,
} from "./admin-route-support.mjs";

export const ADMIN_DATABASE_HEALTH_PATHNAMES = Object.freeze(["/api/v1/admin/database-health"]);

/** deps.admin.readDatabaseHealth() -> body. */
export function createAdminDatabaseHealthDispatch(deps) {
  assertAdminFamilyDeps("admin_database_health", deps);
  const readDatabaseHealth = requiredFunction("admin_database_health", "readDatabaseHealth",
    deps.admin?.readDatabaseHealth);
  return adminFamilyDispatcher(deps, async (request) => {
    requireAdminIdentity(deps, request);
    assertAdminMethod(request, "GET");
    if (new URL(request.url).search !== "") throw new ApiError(400, "BODY_INVALID");
    return adminOk(await readDatabaseHealth());
  });
}
