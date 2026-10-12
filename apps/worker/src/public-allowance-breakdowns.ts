import {
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
  ADMIN_COMMUNITY_ALLOWANCE_PRO10_MODELS_BASIS,
  PREVIEW_CACHE_JSON_LIMIT_BYTES,
  validCachedAdminCommunityAllowancePreview,
  validRetainedPro10AdminCommunityAllowancePreview,
} from "./admin-community-allowance";
import type {
  AdminCommunityAllowancePreview,
  AdminCommunityAllowanceSummary,
  RetainedPro10AdminCommunityAllowancePreview,
} from "./admin-community-allowance";
import {
  COMMUNITY_ALLOWANCE_BASIS,
  COMMUNITY_ALLOWANCE_NORMALIZATION,
  COMMUNITY_ALLOWANCE_PRO10_BASIS,
  COMMUNITY_ALLOWANCE_PRO10_NORMALIZATION,
} from "./community-allowance";

/** The current (B', Pro 20x-equivalent four-plan) public identity. It never
 * had an earlier wire name, so its base envelope carries the public v1.5
 * label directly; it is served only with its closed model metadata block
 * (analytics-v2/public-allowance-breakdowns-v15.ts), never bare. */
export const PUBLIC_ALLOWANCE_BREAKDOWNS_SCHEMA_VERSION =
  "community-allowance-breakdowns-v1.5";
/** Retained: the Pro 10x base envelope of a stored v0.4 preview, unchanged.
 * GCP serves it as v1.4 (analytics-v2/public-allowance-breakdowns-v14.ts). */
export const PUBLIC_ALLOWANCE_BREAKDOWNS_PRO10_SCHEMA_VERSION =
  "community-allowance-breakdowns-v1.2";

/** Internal storage projection only. Never serialize this cache row itself. */
export interface PublicAllowanceBreakdownsCacheRow {
  generated_at: string;
  payload_json: string;
}

export interface PublicAllowanceBreakdownDay {
  readonly day: string;
  readonly combined: AdminCommunityAllowanceSummary;
  readonly byPlanType: Readonly<Record<"pro" | "prolite" | "promax" | "plus", {
    readonly centralUsd: number | null;
    readonly participantCount: number;
    readonly fitCount: number;
    readonly band80Usd: {
      readonly lowerUsd: number;
      readonly upperUsd: number;
    } | null;
  }>>;
  /** Reviewed model ID, positive API-equivalent dollars, supporting accounts. */
  readonly models: readonly (readonly [string, number, number])[];
}

interface PublicAllowanceBreakdownsFor<
  SchemaVersion extends string, Basis extends string, Normalization extends string, ModelBasis extends string,
> {
  readonly schemaVersion: SchemaVersion;
  readonly basis: Basis;
  readonly referencePlanType: "pro";
  readonly normalization: Normalization;
  readonly modelBasis: ModelBasis;
  readonly modelGate: typeof ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE;
  readonly generatedAt: string;
  readonly days: readonly PublicAllowanceBreakdownDay[];
}

/** The current v1.5 base envelope (before the model metadata block). */
export type PublicAllowanceBreakdowns = PublicAllowanceBreakdownsFor<
  typeof PUBLIC_ALLOWANCE_BREAKDOWNS_SCHEMA_VERSION,
  typeof COMMUNITY_ALLOWANCE_BASIS,
  typeof COMMUNITY_ALLOWANCE_NORMALIZATION,
  typeof ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS>;

/** The retained Pro 10x v1.2 base envelope of a stored v0.4 preview. */
export type RetainedPro10PublicAllowanceBreakdowns = PublicAllowanceBreakdownsFor<
  typeof PUBLIC_ALLOWANCE_BREAKDOWNS_PRO10_SCHEMA_VERSION,
  typeof COMMUNITY_ALLOWANCE_PRO10_BASIS,
  typeof COMMUNITY_ALLOWANCE_PRO10_NORMALIZATION,
  typeof ADMIN_COMMUNITY_ALLOWANCE_PRO10_MODELS_BASIS>;

type ProjectablePreview = AdminCommunityAllowancePreview | RetainedPro10AdminCommunityAllowancePreview;

/** One public identity: the preview contract it reads and the literals it
 * writes. Value projection is shared, so the two cannot drift apart. */
interface PublicAllowanceProjectionContract<Preview extends ProjectablePreview, Breakdowns> {
  readonly valid: (value: unknown, storedGeneratedAt: string, nowEpoch: number) => value is Preview;
  readonly envelope: Omit<Breakdowns, "generatedAt" | "days">;
}

const CURRENT_PROJECTION: PublicAllowanceProjectionContract<
  AdminCommunityAllowancePreview, PublicAllowanceBreakdowns> = Object.freeze({
  valid: validCachedAdminCommunityAllowancePreview,
  envelope: Object.freeze({
    schemaVersion: PUBLIC_ALLOWANCE_BREAKDOWNS_SCHEMA_VERSION,
    basis: COMMUNITY_ALLOWANCE_BASIS,
    referencePlanType: "pro",
    normalization: COMMUNITY_ALLOWANCE_NORMALIZATION,
    modelBasis: ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
    modelGate: ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
  }),
});

const RETAINED_PRO10_PROJECTION: PublicAllowanceProjectionContract<
  RetainedPro10AdminCommunityAllowancePreview, RetainedPro10PublicAllowanceBreakdowns> = Object.freeze({
  valid: validRetainedPro10AdminCommunityAllowancePreview,
  envelope: Object.freeze({
    schemaVersion: PUBLIC_ALLOWANCE_BREAKDOWNS_PRO10_SCHEMA_VERSION,
    basis: COMMUNITY_ALLOWANCE_PRO10_BASIS,
    referencePlanType: "pro",
    normalization: COMMUNITY_ALLOWANCE_PRO10_NORMALIZATION,
    modelBasis: ADMIN_COMMUNITY_ALLOWANCE_PRO10_MODELS_BASIS,
    modelGate: ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
  }),
});

function publicSummary(summary: AdminCommunityAllowanceSummary) {
  return {
    centralUsd: summary.centralUsd,
    participantCount: summary.participantCount,
    fitCount: summary.fitCount,
    band80Usd: summary.band80Usd === null ? null : {
      lowerUsd: summary.band80Usd.lowerUsd,
      upperUsd: summary.band80Usd.upperUsd,
    },
  };
}

/**
 * Explicit owner-approved public projection of plan/model dollar estimates and
 * their supporting counts, including single-account estimates. The admin DTO
 * is validated in full against exactly one contract, then copied into a fresh
 * allowlist: coverage, refusal diagnostics, source identities, and plan/model
 * cross-tabs never cross this boundary. This is a bounded cache read, not
 * permission to analyze evidence.
 */
function projectWith<Preview extends ProjectablePreview, Breakdowns>(
  contract: PublicAllowanceProjectionContract<Preview, Breakdowns>,
  row: PublicAllowanceBreakdownsCacheRow | null,
  options: {
    publishedDays: readonly string[];
    nowMs: number;
  },
): { breakdowns: Breakdowns } | null {
  if (!Number.isFinite(options.nowMs)
      || row === null || typeof row.generated_at !== "string"
      || typeof row.payload_json !== "string"
      || row.payload_json.length > PREVIEW_CACHE_JSON_LIMIT_BYTES
      || new TextEncoder().encode(row.payload_json).byteLength
        > PREVIEW_CACHE_JSON_LIMIT_BYTES) return null;
  let preview: unknown;
  try {
    preview = JSON.parse(row.payload_json);
  } catch {
    return null;
  }
  if (!contract.valid(preview, row.generated_at, options.nowMs)) return null;
  const valid: ProjectablePreview = preview;

  const today = new Date(options.nowMs).toISOString().slice(0, 10);
  const publishedDays = new Set(options.publishedDays);
  const modelDays = new Map(valid.models.days.map((day) => [day.day, day.values]));
  const closedDays = valid.days.filter((day) => day.day < today && day.day < valid.to
      && publishedDays.has(day.day));
  const days = closedDays
    .map((day): PublicAllowanceBreakdownDay => ({
      day: day.day,
      combined: publicSummary(day.combined),
      byPlanType: {
        pro: publicSummary(day.byPlanType.pro),
        prolite: publicSummary(day.byPlanType.prolite),
        promax: publicSummary(day.byPlanType.promax),
        plus: publicSummary(day.byPlanType.plus),
      },
      // A missing historical fit remains a gap, never today's fit carried back.
      models: (modelDays.get(day.day) ?? []).map(([modelId, dollars, accounts]) =>
        [modelId, dollars, accounts] as const),
    }));
  if (days.length === 0) return null;
  const breakdowns = {
    ...contract.envelope,
    generatedAt: valid.generatedAt,
    days,
  } as Breakdowns;
  // Keep graph publication separate from immutable daily revisions. All three
  // views advance together; activity/spend revisions keep their original values.
  return { breakdowns };
}

/** Current v0.5 previews only, as the v1.5 base envelope. */
export function projectPublicAllowanceGraph(
  row: PublicAllowanceBreakdownsCacheRow | null,
  options: { publishedDays: readonly string[]; nowMs: number },
): { breakdowns: PublicAllowanceBreakdowns } | null {
  return projectWith(CURRENT_PROJECTION, row, options);
}

/** Retained v0.4 previews only, as their unchanged v1.2 base envelope. */
export function projectRetainedPro10PublicAllowanceGraph(
  row: PublicAllowanceBreakdownsCacheRow | null,
  options: { publishedDays: readonly string[]; nowMs: number },
): { breakdowns: RetainedPro10PublicAllowanceBreakdowns } | null {
  return projectWith(RETAINED_PRO10_PROJECTION, row, options);
}

export function projectPublicAllowanceBreakdowns(
  row: PublicAllowanceBreakdownsCacheRow | null,
  options: { allowanceState: "ready" | "updating"; publishedDays: readonly string[]; nowMs: number },
): PublicAllowanceBreakdowns | null {
  return options.allowanceState === "ready" ? projectPublicAllowanceGraph(row, options)?.breakdowns ?? null : null;
}
