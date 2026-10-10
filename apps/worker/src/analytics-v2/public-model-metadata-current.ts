/** Route-only metadata for current v1.4 responses. No fit/value/catalog mutation. */
import { ADMIN_MODEL_HISTORY_CATALOG_VERSION } from "@app-usagemonitor/telemetry-contract";
import { ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG } from "../admin-community-allowance";
import { isPublicModelMetadataBlock, type PublicModelMetadataEntry } from "./public-allowance-breakdowns-v13";
import { PUBLIC_ALLOWANCE_BREAKDOWNS_V14_SCHEMA_VERSION, PublicAllowanceBreakdownsV14Error } from "./public-allowance-breakdowns-v14";
import type { projectPublicAllowanceGraphForGcp } from "./allowance-projection";

// Current presentation is independently bound to the current preview catalog.
// Manifest 1 and the retained v1.3 presentation remain immutable.
export const CURRENT_PUBLIC_MODEL_METADATA_CATALOG_VERSION = "reviewed-model-catalog-2026-09-29.1" as const;
const CURRENT_PUBLIC_MODELS = Object.freeze([
  ["gpt-6-astra", "astra"], ["gpt-6.1-sol", "sol"], ["gpt-6-sol", "sol"],
  ["gpt-6-luna", "luna"], ["gpt-5.6-terra", "terra"],
  ["gpt-5.6-sol", "sol"], ["gpt-5.6-luna", "luna"],
] as const);

/** Labels and primary/published identity come from the same catalog as v0.4.
 * Naming a model never synthesizes a tuple or guarantees a fitted estimate. */
export function buildCurrentPublicModelMetadata(): readonly PublicModelMetadataEntry[] {
  if (String(ADMIN_MODEL_HISTORY_CATALOG_VERSION) !== CURRENT_PUBLIC_MODEL_METADATA_CATALOG_VERSION) {
    throw new PublicAllowanceBreakdownsV14Error();
  }
  const entries = CURRENT_PUBLIC_MODELS.map(([id, family], order) => {
    const matches = ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG.filter((model) => model.modelId === id);
    const model = matches[0];
    if (matches.length !== 1 || model?.allowanceTrack !== "primary" || model.pricingStatus !== "published") {
      throw new PublicAllowanceBreakdownsV14Error();
    }
    return Object.freeze({ id, label: model.label, family, order });
  });
  if (!isPublicModelMetadataBlock(entries)) throw new PublicAllowanceBreakdownsV14Error();
  return Object.freeze(entries);
}

/** Only the validated current projection receives current presentation.
 * The retained v1.3 object, absent projection, and every value stay unchanged. */
export function withCurrentPublicModelMetadata(graph: ReturnType<typeof projectPublicAllowanceGraphForGcp>) {
  if (graph === null || graph.breakdowns.schemaVersion !== PUBLIC_ALLOWANCE_BREAKDOWNS_V14_SCHEMA_VERSION) return graph;
  return { breakdowns: { ...graph.breakdowns, modelConfig: buildCurrentPublicModelMetadata() } };
}
