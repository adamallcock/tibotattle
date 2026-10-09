/** Post-cutover Pro 10x projection: canonical v1.2 meaning plus model metadata.
 * This wrapper never converts stored values. Only a freshly validated v0.4
 * preview can reach it through allowance-projection.ts. */
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

export const PUBLIC_ALLOWANCE_BREAKDOWNS_V14_SCHEMA_VERSION = "community-allowance-breakdowns-v1.4" as const;
export const PUBLIC_ALLOWANCE_BREAKDOWNS_V14_BASE_SCHEMA_VERSION = "community-allowance-breakdowns-v1.2" as const;

export class PublicAllowanceBreakdownsV14Error extends Error {
  readonly code = "PUBLIC_ALLOWANCE_BREAKDOWNS_V14_INVALID";
  constructor() { super("PUBLIC_ALLOWANCE_BREAKDOWNS_V14_INVALID"); }
}

function validBase(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  return keys.length === PUBLIC_ALLOWANCE_BREAKDOWNS_V11_KEYS.length
    && keys.every((key, index) => key === PUBLIC_ALLOWANCE_BREAKDOWNS_V11_KEYS[index])
    && row.schemaVersion === PUBLIC_ALLOWANCE_BREAKDOWNS_V14_BASE_SCHEMA_VERSION
    && row.basis === COMMUNITY_ALLOWANCE_BASIS
    && row.referencePlanType === "pro"
    && row.normalization === COMMUNITY_ALLOWANCE_NORMALIZATION
    && row.modelBasis === ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS
    && row.modelGate === ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE;
}

export function wrapPublicAllowanceBreakdownsV14<T extends object>(
  breakdowns: T,
  metadata: readonly PublicModelMetadataEntry[],
): Omit<T, "schemaVersion"> & {
  readonly schemaVersion: typeof PUBLIC_ALLOWANCE_BREAKDOWNS_V14_SCHEMA_VERSION;
  readonly modelConfig: readonly PublicModelMetadataEntry[];
} {
  if (!validBase(breakdowns) || !isPublicModelMetadataBlock(metadata)) {
    throw new PublicAllowanceBreakdownsV14Error();
  }
  return { ...breakdowns, schemaVersion: PUBLIC_ALLOWANCE_BREAKDOWNS_V14_SCHEMA_VERSION, modelConfig: metadata } as never;
}

/** Exact inverse of the declared wire difference, with no amount conversion. */
export function reducePublicAllowanceBreakdownsV14(value: unknown): {
  base: Record<string, unknown>;
  metadata: readonly PublicModelMetadataEntry[];
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PublicAllowanceBreakdownsV14Error();
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== PUBLIC_ALLOWANCE_BREAKDOWNS_V11_KEYS.length + 1
      || keys.at(-1) !== "modelConfig"
      || row.schemaVersion !== PUBLIC_ALLOWANCE_BREAKDOWNS_V14_SCHEMA_VERSION
      || !isPublicModelMetadataBlock(row.modelConfig)) throw new PublicAllowanceBreakdownsV14Error();
  const { modelConfig, ...rest } = row;
  const base = { ...rest, schemaVersion: PUBLIC_ALLOWANCE_BREAKDOWNS_V14_BASE_SCHEMA_VERSION };
  if (!validBase(base)) throw new PublicAllowanceBreakdownsV14Error();
  return { base, metadata: modelConfig as readonly PublicModelMetadataEntry[] };
}
