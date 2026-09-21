/** Conservative shared transaction ceiling for routed typed writes.
 * D1 Paid permits 1,000 queries per invocation, not per batch:
 * https://developers.cloudflare.com/d1/platform/limits/
 * Reserve 100 outside this transaction for routing/authentication/other reads.
 * The request owner must still meter its complete invocation; this is not a
 * replacement for admission, per-query parameter/byte limits or runtime limits.
 */
export const MAX_STORAGE_TRANSACTION_STATEMENTS = 900;
export const MAX_TYPED_STORAGE_DATA_STATEMENTS = 800;
export const MAX_STORAGE_APPLICATION_OVERHEAD_STATEMENTS = 99;
export const MAX_STORAGE_APPLICATION_STATEMENTS =
  MAX_TYPED_STORAGE_DATA_STATEMENTS + MAX_STORAGE_APPLICATION_OVERHEAD_STATEMENTS;
export const STORAGE_WRITE_FENCE_STATEMENTS = 1;
