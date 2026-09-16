/** Provider-neutral bounds and failure contract shared by D1 and the
 * qualification PostgreSQL projection adapter. */
export const V1_QUOTA_PROJECTION_BACKFILL_PAGE_SIZE = 4_096;
export const V1_QUOTA_PROJECTION_BACKFILL_MAX_PAGES = 16;

export class V1QuotaFitProjectionUnavailableError extends Error {
  readonly code = "V1_QUOTA_FIT_PROJECTION_UNAVAILABLE";
  constructor() { super("v1 quota fit projection unavailable"); }
}
