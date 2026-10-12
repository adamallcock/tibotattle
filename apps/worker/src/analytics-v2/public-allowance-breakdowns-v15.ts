/** Current Pro 20x-equivalent four-plan projection (owner option B',
 * 2026-10-10): every personal plan in Pro 20x-week units, Pro 20x x1, Pro 5x
 * x4, Pro Max 25x x0.8 and Plus x20, plus the closed model metadata block.
 *
 * B' never had an earlier public wire name, so the base envelope from
 * public-allowance-breakdowns.ts already carries the v1.5 label; this wrapper
 * only appends `modelConfig` and never relabels, reorders or converts a value.
 * Only a freshly validated current v0.5 preview can reach it through
 * allowance-projection.ts. A v1.5 envelope without the block is not a served
 * contract: the public reader refuses it, and no route emits it. */
import {
  isPublicModelMetadataBlock,
  PUBLIC_ALLOWANCE_BREAKDOWNS_V11_KEYS,
  type PublicModelMetadataEntry,
} from "./public-allowance-breakdowns-v13";
import {
  COMMUNITY_ALLOWANCE_BASIS,
  COMMUNITY_ALLOWANCE_NORMALIZATION,
} from "../community-allowance";
import {
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
} from "../admin-community-allowance";

export const PUBLIC_ALLOWANCE_BREAKDOWNS_V15_SCHEMA_VERSION = "community-allowance-breakdowns-v1.5" as const;

export class PublicAllowanceBreakdownsV15Error extends Error {
  readonly code = "PUBLIC_ALLOWANCE_BREAKDOWNS_V15_INVALID";
  constructor() { super("PUBLIC_ALLOWANCE_BREAKDOWNS_V15_INVALID"); }
}

function validBase(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  return keys.length === PUBLIC_ALLOWANCE_BREAKDOWNS_V11_KEYS.length
    && keys.every((key, index) => key === PUBLIC_ALLOWANCE_BREAKDOWNS_V11_KEYS[index])
    && row.schemaVersion === PUBLIC_ALLOWANCE_BREAKDOWNS_V15_SCHEMA_VERSION
    && row.basis === COMMUNITY_ALLOWANCE_BASIS
    && row.referencePlanType === "pro"
    && row.normalization === COMMUNITY_ALLOWANCE_NORMALIZATION
    && row.modelBasis === ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS
    && row.modelGate === ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE;
}

export function wrapPublicAllowanceBreakdownsV15<T extends object>(
  breakdowns: T,
  metadata: readonly PublicModelMetadataEntry[],
): Omit<T, "schemaVersion"> & {
  readonly schemaVersion: typeof PUBLIC_ALLOWANCE_BREAKDOWNS_V15_SCHEMA_VERSION;
  readonly modelConfig: readonly PublicModelMetadataEntry[];
} {
  if (!validBase(breakdowns) || !isPublicModelMetadataBlock(metadata)) {
    throw new PublicAllowanceBreakdownsV15Error();
  }
  return { ...breakdowns, schemaVersion: PUBLIC_ALLOWANCE_BREAKDOWNS_V15_SCHEMA_VERSION, modelConfig: metadata } as never;
}

/** Exact inverse of the declared wire difference: only the trailing block is
 * removed. No relabel and no amount conversion. */
export function reducePublicAllowanceBreakdownsV15(value: unknown): {
  base: Record<string, unknown>;
  metadata: readonly PublicModelMetadataEntry[];
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PublicAllowanceBreakdownsV15Error();
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== PUBLIC_ALLOWANCE_BREAKDOWNS_V11_KEYS.length + 1
      || keys.at(-1) !== "modelConfig"
      || row.schemaVersion !== PUBLIC_ALLOWANCE_BREAKDOWNS_V15_SCHEMA_VERSION
      || !isPublicModelMetadataBlock(row.modelConfig)) throw new PublicAllowanceBreakdownsV15Error();
  const { modelConfig, ...base } = row;
  if (!validBase(base)) throw new PublicAllowanceBreakdownsV15Error();
  return { base, metadata: modelConfig as readonly PublicModelMetadataEntry[] };
}
