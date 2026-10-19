/**
 * GET /api/v1/admin/performance-intake on the PostgreSQL origin (GCP): the
 * read-only owner view of the accountless model-performance intake
 * (orchestrator gate answers 2026-10-11, items 4 and 23).
 *
 * A separate admin route, so 'admin-overview' keeps its version and deploy
 * order. Read-only: there is no activation control here; activation goes
 * only through the owner-only run_maintenance task and the runbook.
 *
 * It follows the admin family contract (admin-route-support.mjs):
 * 1. the root's registered admin identity first: none is 403 ADMIN_REQUIRED;
 * 2. GET only: anything else is 405 METHOD_NOT_ALLOWED with Allow: GET;
 * 3. no query keys: any non-empty search is 400 BODY_INVALID (a bare '?' is
 *    an empty search, exactly as for database-health);
 * 4. the injected source deps.admin.readPerformanceIntake({ nowEpoch })
 *    (src/postgres-admin-performance-intake.ts readPostgresAdminPerformanceIntake,
 *    bound by the composition root) answers the closed
 *    'admin-performance-intake-v0.1' DTO, served 200 with no-store and
 *    vary: Cookie. Any failure of the source, or a body that is not that DTO,
 *    is 503 ADMIN_PERFORMANCE_INTAKE_UNAVAILABLE with no detail.
 *
 * The composition root registers the pathname and binds the source; this
 * module edits neither admin-console.mjs nor the route registry.
 */

import { ApiError } from "../../src/errors.ts";
import {
  adminFamilyDispatcher,
  adminOk,
  assertAdminFamilyDeps,
  assertAdminMethod,
  familyClock,
  requireAdminIdentity,
  requiredFunction,
} from "./admin-route-support.mjs";

export const ADMIN_PERFORMANCE_INTAKE_ROUTE_ID = "admin_performance_intake";
export const ADMIN_PERFORMANCE_INTAKE_PATHNAMES = Object.freeze(["/api/v1/admin/performance-intake"]);
export const ADMIN_PERFORMANCE_INTAKE_SCHEMA_VERSION = "admin-performance-intake-v0.1";

function unavailable() {
  return new ApiError(503, "ADMIN_PERFORMANCE_INTAKE_UNAVAILABLE");
}

function intakeBody(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && value.schemaVersion === ADMIN_PERFORMANCE_INTAKE_SCHEMA_VERSION;
}

/** deps.admin.readPerformanceIntake({ nowEpoch }) -> 'admin-performance-intake-v0.1' body. */
export function createAdminPerformanceIntakeDispatch(deps) {
  assertAdminFamilyDeps(ADMIN_PERFORMANCE_INTAKE_ROUTE_ID, deps);
  const readPerformanceIntake = requiredFunction(ADMIN_PERFORMANCE_INTAKE_ROUTE_ID, "readPerformanceIntake",
    deps.admin?.readPerformanceIntake);
  const clock = familyClock(deps);
  return adminFamilyDispatcher(deps, async (request) => {
    requireAdminIdentity(deps, request);
    assertAdminMethod(request, "GET");
    if (new URL(request.url).search !== "") throw new ApiError(400, "BODY_INVALID");
    let body;
    try {
      const nowEpoch = clock();
      if (!Number.isSafeInteger(nowEpoch)) throw unavailable();
      body = await readPerformanceIntake({ nowEpoch });
    } catch {
      throw unavailable();
    }
    if (!intakeBody(body)) throw unavailable();
    return adminOk(body);
  });
}
