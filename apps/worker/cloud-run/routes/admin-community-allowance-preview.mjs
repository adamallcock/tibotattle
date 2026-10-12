/**
 * GET /api/v1/admin/community/allowance-preview on the PostgreSQL origin
 * (GCP, C-ADMIN).
 *
 * d43c8f92 handleAdminCommunityAllowancePreview in access mode: GET only (the
 * handler's own 405 Allow: GET; the query string is ignored), then the stored
 * preview, or 503 ADMIN_ALLOWANCE_STORAGE_UNAVAILABLE when there is none to
 * serve. The preview comes from the injected readAllowancePreview adapter
 * (src/postgres-admin-allowance-preview.ts over analytics_v2_preview by
 * default); a null answer is the Worker's unavailable status, never an empty
 * preview.
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

export const ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_PATHNAMES = Object.freeze([
  "/api/v1/admin/community/allowance-preview",
]);

/** deps.admin.readAllowancePreview({nowEpoch}) -> preview | null. */
export function createAdminCommunityAllowancePreviewDispatch(deps) {
  assertAdminFamilyDeps("admin_community_allowance_preview", deps);
  const readAllowancePreview = requiredFunction("admin_community_allowance_preview",
    "readAllowancePreview", deps.admin?.readAllowancePreview);
  const clock = familyClock(deps);
  return adminFamilyDispatcher(deps, async (request) => {
    requireAdminIdentity(deps, request);
    assertAdminMethod(request, "GET");
    const preview = await readAllowancePreview({ nowEpoch: clock() });
    if (preview === null) throw new ApiError(503, "ADMIN_ALLOWANCE_STORAGE_UNAVAILABLE");
    return adminOk(preview);
  });
}
