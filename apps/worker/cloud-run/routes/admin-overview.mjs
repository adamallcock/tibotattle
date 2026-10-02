/**
 * GET /api/v1/admin/overview on the PostgreSQL origin (GCP, C-ADMIN).
 *
 * d43c8f92 handleAdminOverview in access mode (index.ts admin-hostname
 * branch): the owner identity from the chokepoint, GET only (405 Allow: GET),
 * an optional diagnosticReference that must be a v4 request id (else 400
 * BODY_INVALID), then the overview body with no-store and vary: Cookie.
 * The body comes from the injected readOverview adapter
 * (src/postgres-admin-overview.ts by default, see admin-console.mjs); its
 * ApiError is the answer.
 */

import { ApiError } from "../../src/errors.ts";
import { validDiagnosticReference } from "../../src/admin-operations.ts";
import {
  adminFamilyDispatcher,
  adminOk,
  assertAdminFamilyDeps,
  assertAdminMethod,
  familyClock,
  requireAdminIdentity,
  requiredFunction,
} from "./admin-route-support.mjs";

export const ADMIN_OVERVIEW_PATHNAMES = Object.freeze(["/api/v1/admin/overview"]);

/** deps.admin.readOverview({nowEpoch, diagnosticReference}) -> body. */
export function createAdminOverviewDispatch(deps) {
  assertAdminFamilyDeps("admin_overview", deps);
  const readOverview = requiredFunction("admin_overview", "readOverview", deps.admin?.readOverview);
  const clock = familyClock(deps);
  return adminFamilyDispatcher(deps, async (request) => {
    requireAdminIdentity(deps, request);
    assertAdminMethod(request, "GET");
    const reference = new URL(request.url).searchParams.get("diagnosticReference");
    if (reference !== null && !validDiagnosticReference(reference)) {
      throw new ApiError(400, "BODY_INVALID");
    }
    return adminOk(await readOverview({
      nowEpoch: clock(),
      ...(reference === null ? {} : { diagnosticReference: reference }),
    }));
  });
}
