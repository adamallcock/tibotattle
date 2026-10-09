/** GCP cross-owner projection boundary.
 * Raw owner fits/composition remain the frozen vendored kernels. The authored
 * projection applies the current plan multipliers to those raw results. Stored
 * v0.3 previews retain their original validation, math and v1.3 wire meaning.
 * No selector, storage read or migration occurs at this pure boundary. */
import {
  validCachedAdminCommunityAllowancePreview,
} from "../admin-community-allowance";
import { projectPublicAllowanceGraph } from "../public-allowance-breakdowns";
import {
  validCachedAdminCommunityAllowancePreview as validLegacyPreview,
  projectPublicAllowanceGraph as projectLegacyGraph,
  type PublicAllowanceBreakdownsCacheRow,
} from "../../vendor/analytics-d43c8f92/entry";
import { wrapPublicAllowanceBreakdownsV13, type PublicModelMetadataEntry } from "./public-allowance-breakdowns-v13";
import { wrapPublicAllowanceBreakdownsV14 } from "./public-allowance-breakdowns-v14";

export {
  ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
  buildAdminCommunityAllowancePreview,
  buildCommunityModelCompositionDay,
  validCachedAdminCommunityAllowancePreview,
  type AdminCommunityModelCompositionDay,
} from "../admin-community-allowance";

/** Legacy and current schemas are each checked against their exact contract. */
export function validReadableAdminCommunityAllowancePreview(
  value: unknown, storedGeneratedAt: string, nowMs: number,
): boolean {
  return validCachedAdminCommunityAllowancePreview(value, storedGeneratedAt, nowMs)
    || validLegacyPreview(value, storedGeneratedAt, nowMs);
}

export function projectPublicAllowanceGraphForGcp(
  row: PublicAllowanceBreakdownsCacheRow | null,
  options: { publishedDays: readonly string[]; nowMs: number },
  metadata: readonly PublicModelMetadataEntry[],
) {
  const current = projectPublicAllowanceGraph(row, options);
  if (current !== null) return { breakdowns: wrapPublicAllowanceBreakdownsV14(current.breakdowns, metadata) };
  const legacy = projectLegacyGraph(row, options);
  return legacy === null ? null : { breakdowns: wrapPublicAllowanceBreakdownsV13(legacy.breakdowns, metadata) };
}
