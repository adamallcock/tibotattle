/**
 * GET /api/v1/admin/reconstruction-progress on the PostgreSQL origin (GCP,
 * C-ADMIN).
 *
 * d43c8f92 handleAdminReconstructionProgress in access mode: GET only; the
 * query is either empty or exactly one `detail=preparation` pair, else 400
 * BODY_INVALID; then, in typed storage mode, readStorageCommunityProgress over
 * the analytics database's incremental graph pipeline (refresh lanes, model
 * publications, graph results, selection and checkpoints).
 *
 * The GCP fast path has no such pipeline: one analytics-refresh job
 * recomputes everything in a single run, so there is no data source with the
 * Worker's lanes, checkpoints or per-owner work states. Without an injected
 * reader the route answers 503 BACKEND_STORAGE_UNAVAILABLE, the Worker's own
 * status when the typed analytics storage cannot serve the read, after
 * authorization and query validation and without touching storage. It never
 * reports an idle or empty pipeline it cannot observe.
 */

import { ApiError } from "../../src/errors.ts";
import {
  adminFamilyDispatcher,
  adminOk,
  assertAdminFamilyDeps,
  assertAdminMethod,
  familyClock,
  optionalFunction,
  requireAdminIdentity,
} from "./admin-route-support.mjs";

export const ADMIN_RECONSTRUCTION_PROGRESS_PATHNAMES = Object.freeze([
  "/api/v1/admin/reconstruction-progress",
]);

/** deps.admin.readReconstructionProgress({nowEpoch, includePreparation}) -> body, optional. */
export function createAdminReconstructionProgressDispatch(deps) {
  assertAdminFamilyDeps("admin_reconstruction_progress", deps);
  const readReconstructionProgress = optionalFunction("admin_reconstruction_progress",
    "readReconstructionProgress", deps.admin?.readReconstructionProgress);
  const clock = familyClock(deps);
  return adminFamilyDispatcher(deps, async (request) => {
    requireAdminIdentity(deps, request);
    assertAdminMethod(request, "GET");
    const params = [...new URL(request.url).searchParams];
    const includePreparation = params.length === 1
      && params[0]?.[0] === "detail" && params[0]?.[1] === "preparation";
    if (params.length !== 0 && !includePreparation) throw new ApiError(400, "BODY_INVALID");
    if (readReconstructionProgress === undefined) {
      throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    }
    return adminOk(await readReconstructionProgress({ nowEpoch: clock(), includePreparation }));
  });
}
