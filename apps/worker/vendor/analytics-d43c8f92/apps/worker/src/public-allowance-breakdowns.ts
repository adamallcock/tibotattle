import {
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
  PREVIEW_CACHE_JSON_LIMIT_BYTES,
  validCachedAdminCommunityAllowancePreview,
} from "./admin-community-allowance";
import type { AdminCommunityAllowanceSummary } from "./admin-community-allowance";
import { COMMUNITY_ALLOWANCE_BASIS } from "./community-allowance";

export const PUBLIC_ALLOWANCE_BREAKDOWNS_SCHEMA_VERSION =
  "community-allowance-breakdowns-v1.1";

/** Internal storage projection only. Never serialize this cache row itself. */
export interface PublicAllowanceBreakdownsCacheRow {
  generated_at: string;
  payload_json: string;
}

export interface PublicAllowanceBreakdownDay {
  readonly day: string;
  readonly combined: AdminCommunityAllowanceSummary;
  readonly byPlanType: Readonly<Record<"pro" | "prolite" | "plus", {
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

export interface PublicAllowanceBreakdowns {
  readonly schemaVersion: typeof PUBLIC_ALLOWANCE_BREAKDOWNS_SCHEMA_VERSION;
  readonly basis: typeof COMMUNITY_ALLOWANCE_BASIS;
  readonly referencePlanType: "pro";
  readonly normalization: "pro_x1_prolite_x4_plus_x20";
  readonly modelBasis: typeof ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS;
  readonly modelGate: typeof ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE;
  readonly generatedAt: string;
  readonly days: readonly PublicAllowanceBreakdownDay[];
}

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
 * is validated in full, then copied into a fresh allowlist: coverage, refusal
 * diagnostics, source identities, and plan/model cross-tabs never cross this
 * boundary. This is a bounded cache read, not permission to analyze evidence.
 */
export function projectPublicAllowanceGraph(
  row: PublicAllowanceBreakdownsCacheRow | null,
  options: {
    publishedDays: readonly string[];
    nowMs: number;
  },
): { breakdowns: PublicAllowanceBreakdowns } | null {
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
  if (!validCachedAdminCommunityAllowancePreview(
    preview, row.generated_at, options.nowMs,
  )) return null;

  const today = new Date(options.nowMs).toISOString().slice(0, 10);
  const publishedDays = new Set(options.publishedDays);
  const modelDays = new Map(preview.models.days.map((day) => [day.day, day.values]));
  const closedDays = preview.days.filter((day) => day.day < today && day.day < preview.to
      && publishedDays.has(day.day));
  const days = closedDays
    .map((day): PublicAllowanceBreakdownDay => ({
      day: day.day,
      combined: publicSummary(day.combined),
      byPlanType: {
        pro: publicSummary(day.byPlanType.pro),
        prolite: publicSummary(day.byPlanType.prolite),
        plus: publicSummary(day.byPlanType.plus),
      },
      // A missing historical fit remains a gap, never today's fit carried back.
      models: (modelDays.get(day.day) ?? []).map(([modelId, dollars, accounts]) =>
        [modelId, dollars, accounts] as const),
    }));
  if (days.length === 0) return null;
  const breakdowns: PublicAllowanceBreakdowns = {
    schemaVersion: PUBLIC_ALLOWANCE_BREAKDOWNS_SCHEMA_VERSION,
    basis: COMMUNITY_ALLOWANCE_BASIS,
    referencePlanType: "pro",
    normalization: "pro_x1_prolite_x4_plus_x20",
    modelBasis: ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
    modelGate: ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
    generatedAt: preview.generatedAt,
    days,
  };
  // Keep graph publication separate from immutable daily revisions. All three
  // views advance together; activity/spend revisions keep their original values.
  return { breakdowns };
}

export function projectPublicAllowanceBreakdowns(
  row: PublicAllowanceBreakdownsCacheRow | null,
  options: { allowanceState: "ready" | "updating"; publishedDays: readonly string[]; nowMs: number },
): PublicAllowanceBreakdowns | null {
  return options.allowanceState === "ready" ? projectPublicAllowanceGraph(row, options)?.breakdowns ?? null : null;
}
