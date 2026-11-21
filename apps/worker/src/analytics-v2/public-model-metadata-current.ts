/** Route-only metadata for current v1.5 and retained v1.4 responses. No
 * fit/value/catalog mutation. */
import { ADMIN_MODEL_HISTORY_CATALOG_VERSION } from "@app-usagemonitor/telemetry-contract";
import { ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG } from "../admin-community-allowance";
import type { PublicAllowanceBreakdownDay } from "../public-allowance-breakdowns";
import { isPublicModelMetadataBlock, type PublicModelMetadataEntry } from "./public-allowance-breakdowns-v13";
import { PUBLIC_ALLOWANCE_BREAKDOWNS_V14_SCHEMA_VERSION } from "./public-allowance-breakdowns-v14";
import { PUBLIC_ALLOWANCE_BREAKDOWNS_V15_SCHEMA_VERSION } from "./public-allowance-breakdowns-v15";
import type { projectPublicAllowanceGraphForGcp } from "./allowance-projection";

/** The current catalog cannot name the current public roster. Content-free. */
export class CurrentPublicModelMetadataError extends Error {
  readonly code = "PUBLIC_MODEL_METADATA_CURRENT_INVALID";
  constructor() { super("PUBLIC_MODEL_METADATA_CURRENT_INVALID"); }
}

// Current presentation is independently bound to the current preview catalog.
// Manifest 1 and the retained v1.3 presentation remain immutable.
export const CURRENT_PUBLIC_MODEL_METADATA_CATALOG_VERSION = "reviewed-model-catalog-2026-11-17.1" as const;
const CURRENT_PUBLIC_MODELS = Object.freeze([
  ["gpt-6.2-astra", "astra"], ["gpt-6.2-sol", "sol"],
  ["gpt-6-astra", "astra"], ["gpt-6.1-sol", "sol"], ["gpt-6-sol", "sol"],
  ["gpt-6-luna", "luna"], ["gpt-6.1-terra", "terra"], ["gpt-5.6-terra", "terra"],
  ["gpt-5.6-sol", "sol"], ["gpt-5.6-luna", "luna"],
] as const);
const LAW_MODEL = ["gpt-6.2-astra-law", "astra"] as const;

/** Labels and primary/published identity come from the same catalog as the
 * v0.4 and v0.5 previews. Naming a model never synthesizes a tuple or
 * guarantees a fitted estimate. */
export function buildCurrentPublicModelMetadata(
  publishedDays: readonly PublicAllowanceBreakdownDay[] = [],
): readonly PublicModelMetadataEntry[] {
  if (String(ADMIN_MODEL_HISTORY_CATALOG_VERSION) !== CURRENT_PUBLIC_MODEL_METADATA_CATALOG_VERSION) {
    throw new CurrentPublicModelMetadataError();
  }
  // The gated Law offering gets a label only for an already-public estimate.
  const models = publishedDays.some(({ models }) => models.some(([id]) => id === LAW_MODEL[0]))
    ? [...CURRENT_PUBLIC_MODELS, LAW_MODEL] : CURRENT_PUBLIC_MODELS;
  const entries = models.map(([id, family], order) => {
    const matches = ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG.filter((model) => model.modelId === id);
    const model = matches[0];
    if (matches.length !== 1 || model?.allowanceTrack !== "primary" || model.pricingStatus !== "published") {
      throw new CurrentPublicModelMetadataError();
    }
    return Object.freeze({ id, label: model.label, family, order });
  });
  if (!isPublicModelMetadataBlock(entries)) throw new CurrentPublicModelMetadataError();
  return Object.freeze(entries);
}

/** Only a validated current (v1.5) or retained Pro 10x (v1.4) projection
 * receives current presentation. The retained v1.3 object, an absent
 * projection, and every value stay unchanged. */
export function withCurrentPublicModelMetadata(graph: ReturnType<typeof projectPublicAllowanceGraphForGcp>) {
  if (graph === null || (graph.breakdowns.schemaVersion !== PUBLIC_ALLOWANCE_BREAKDOWNS_V14_SCHEMA_VERSION
    && graph.breakdowns.schemaVersion !== PUBLIC_ALLOWANCE_BREAKDOWNS_V15_SCHEMA_VERSION)) return graph;
  return { breakdowns: { ...graph.breakdowns, modelConfig: buildCurrentPublicModelMetadata(graph.breakdowns.days) } };
}
