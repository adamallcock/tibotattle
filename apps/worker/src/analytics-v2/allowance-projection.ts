/** GCP cross-owner projection boundary.
 * Raw owner fits/composition remain the frozen vendored kernels. The authored
 * projection applies the current plan multipliers to those raw results: the
 * builder emits only the current B' preview (v0.5, Pro 20x-equivalent four
 * plans). Stored previews are dispatched on their exact schema, each checked
 * against its own frozen contract and keeping its own public meaning:
 *   v0.5 -> community-allowance-breakdowns-v1.5 (current),
 *   v0.4 -> v1.4 (retained Pro 10x, frozen literals),
 *   v0.3 -> v1.3 (legacy Pro 20x three plans, vendored d43c8f92 math).
 * The validators are mutually exclusive by schemaVersion; nothing is
 * relabelled or converted. No selector, storage read or migration occurs at
 * this pure boundary. */
import {
  validCachedAdminCommunityAllowancePreview,
  validRetainedPro10AdminCommunityAllowancePreview,
} from "../admin-community-allowance";
import {
  projectPublicAllowanceGraph,
  projectRetainedPro10PublicAllowanceGraph,
} from "../public-allowance-breakdowns";
import {
  validCachedAdminCommunityAllowancePreview as validLegacyPreview,
  projectPublicAllowanceGraph as projectLegacyGraph,
  type PublicAllowanceBreakdownsCacheRow,
} from "../../vendor/analytics-d43c8f92/entry";
import { wrapPublicAllowanceBreakdownsV13, type PublicModelMetadataEntry } from "./public-allowance-breakdowns-v13";
import { wrapPublicAllowanceBreakdownsV14 } from "./public-allowance-breakdowns-v14";
import { wrapPublicAllowanceBreakdownsV15 } from "./public-allowance-breakdowns-v15";

export {
  ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
  buildAdminCommunityAllowancePreview,
  buildCommunityModelCompositionDay,
  validCachedAdminCommunityAllowancePreview,
  type AdminCommunityModelCompositionDay,
} from "../admin-community-allowance";

/** Current, retained and legacy schemas are each checked against their exact contract. */
export function validReadableAdminCommunityAllowancePreview(
  value: unknown, storedGeneratedAt: string, nowMs: number,
): boolean {
  return validCachedAdminCommunityAllowancePreview(value, storedGeneratedAt, nowMs)
    || validRetainedPro10AdminCommunityAllowancePreview(value, storedGeneratedAt, nowMs)
    || validLegacyPreview(value, storedGeneratedAt, nowMs);
}

export function projectPublicAllowanceGraphForGcp(
  row: PublicAllowanceBreakdownsCacheRow | null,
  options: { publishedDays: readonly string[]; nowMs: number },
  metadata: readonly PublicModelMetadataEntry[],
) {
  const current = projectPublicAllowanceGraph(row, options);
  if (current !== null) return { breakdowns: wrapPublicAllowanceBreakdownsV15(current.breakdowns, metadata) };
  const retained = projectRetainedPro10PublicAllowanceGraph(row, options);
  if (retained !== null) return { breakdowns: wrapPublicAllowanceBreakdownsV14(retained.breakdowns, metadata) };
  const legacy = projectLegacyGraph(row, options);
  return legacy === null ? null : { breakdowns: wrapPublicAllowanceBreakdownsV13(legacy.breakdowns, metadata) };
}
