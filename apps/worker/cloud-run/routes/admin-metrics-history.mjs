/**
 * GET /api/v1/admin/metrics/history on the PostgreSQL origin (GCP, C-ADMIN).
 *
 * d43c8f92 handleAdminMetricsHistory in access mode: GET only, then the
 * cached 'admin-metrics-history-v0.3' body served verbatim. On Cloudflare the
 * body is a cache the Worker's cron warms (captureStorageAdminMetricSnapshot
 * and warmStorageAdminMetricsHistoryCache) and the route never builds it.
 *
 * GCP has no producer for that cache on this line: nothing captures metric
 * snapshots or warms analytics_admin_metrics_history_cache, and the analytics
 * database it lived in is not imported. Without an injected reader the route
 * therefore answers the Worker's own authoritative "no cached history"
 * status, 503 ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE, after authorization
 * and the method check and without touching storage. It never builds or
 * returns a zero-filled history.
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

export const ADMIN_METRICS_HISTORY_PATHNAMES = Object.freeze(["/api/v1/admin/metrics/history"]);

/** deps.admin.readMetricsHistory({nowEpoch}) -> body, optional. */
export function createAdminMetricsHistoryDispatch(deps) {
  assertAdminFamilyDeps("admin_metrics_history", deps);
  const readMetricsHistory = optionalFunction("admin_metrics_history", "readMetricsHistory",
    deps.admin?.readMetricsHistory);
  const clock = familyClock(deps);
  return adminFamilyDispatcher(deps, async (request) => {
    requireAdminIdentity(deps, request);
    assertAdminMethod(request, "GET");
    if (readMetricsHistory === undefined) {
      throw new ApiError(503, "ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE");
    }
    return adminOk(await readMetricsHistory({ nowEpoch: clock() }));
  });
}
