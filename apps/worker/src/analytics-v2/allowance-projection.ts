/** GCP cross-owner projection boundary.
 * Scalar and per-era model fits use the frozen vendored kernels. The authored
 * projection applies the current plan multipliers to those results: the
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
  buildCommunityModelCompositionDayFromSummary,
  normalizeCommunityModelCompositionForDay,
  validCachedAdminCommunityAllowancePreview,
  validRetainedPro10AdminCommunityAllowancePreview,
  type CommunityModelCompositionNormalization,
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
import { ANALYTICS_V2_PLAN_ERA_COMPOSITION_VERSION,
  type AnalyticsV2ModelCompositionResult } from "./model-era-composition";

/** Normalize each era on its own plan basis, then choose at most one value
 * per owner/model. Recent unstable evidence never turns into a fitted value;
 * another still-fresh identified era may independently support that model. */
export function normalizeAnalyticsV2ModelCompositionForDay(
  result: AnalyticsV2ModelCompositionResult, day: string,
): CommunityModelCompositionNormalization | { readonly state: "refused" } {
  if (result.status === "not_testable") return { state: "refused" };
  if (result.status === "ready") return normalizeCommunityModelCompositionForDay(result, day);
  if (result.schemaVersion !== ANALYTICS_V2_PLAN_ERA_COMPOSITION_VERSION || result.candidates.length > 256) {
    throw new Error("ANALYTICS_V2_MODEL_ERA_RESULT_INVALID");
  }
  const ids = new Set<string>();
  const selected = new Map<string, { value: number; observed: number; id: string }>();
  let fitted = false, unstable = false, stale = false;
  for (const candidate of result.candidates) {
    if (!/^[a-f0-9]{64}$/u.test(candidate.candidateId) || ids.has(candidate.candidateId)) {
      throw new Error("ANALYTICS_V2_MODEL_ERA_RESULT_INVALID");
    }
    ids.add(candidate.candidateId);
    if (candidate.composition.status === "not_testable") continue;
    const normalized = normalizeCommunityModelCompositionForDay(candidate.composition, day);
    if (normalized.state === "stale") { stale = true; continue; }
    if (normalized.state === "unstable") { unstable = true; continue; }
    fitted = true;
    const observed = Date.parse(candidate.composition.latestQuotaObservedAt);
    for (const [model, value] of Object.entries(normalized.values)) {
      const prior = selected.get(model);
      if (prior === undefined || observed > prior.observed
          || observed === prior.observed && candidate.candidateId < prior.id) {
        selected.set(model, { value, observed, id: candidate.candidateId });
      }
    }
  }
  if (fitted) return { state: "fitted", values: Object.fromEntries([...selected].map(([model, row]) => [model, row.value])) };
  return { state: unstable ? "unstable" : stale ? "stale" : "refused" };
}

/** The owner is the public sampling unit, even when its analysis has several
 * isolated eras. Duplicate owner input is a contract error, never extra votes. */
export function buildAnalyticsV2ModelCompositionDay(
  evaluated: readonly { readonly ownerDigest: string; readonly result: AnalyticsV2ModelCompositionResult }[],
  refusedParticipants: number, day: string,
) {
  const owners = new Set<string>(), valuesByModel = new Map<string, number[]>();
  const counts = { fittedParticipantCount: 0, unstableParticipantCount: 0, staleParticipantCount: 0,
    refusedParticipantCount: refusedParticipants };
  for (const { ownerDigest, result } of evaluated) {
    if (owners.has(ownerDigest)) throw new Error("ANALYTICS_V2_MODEL_ERA_DUPLICATE_OWNER");
    owners.add(ownerDigest);
    const normalized = normalizeAnalyticsV2ModelCompositionForDay(result, day);
    if (normalized.state === "refused") { counts.refusedParticipantCount += 1; continue; }
    if (normalized.state === "stale") { counts.staleParticipantCount += 1; continue; }
    if (normalized.state === "unstable") { counts.unstableParticipantCount += 1; continue; }
    counts.fittedParticipantCount += 1;
    for (const [model, value] of Object.entries(normalized.values)) {
      const values = valuesByModel.get(model) ?? [];
      values.push(value);
      valuesByModel.set(model, values);
    }
  }
  const mediansByModel = new Map<string, { median: number; participantCount: number }>();
  for (const [model, values] of valuesByModel) {
    values.sort((left, right) => left - right);
    const middle = Math.floor(values.length / 2);
    mediansByModel.set(model, { median: values.length % 2 === 0
      ? (values[middle - 1]! + values[middle]!) / 2 : values[middle]!, participantCount: values.length });
  }
  return buildCommunityModelCompositionDayFromSummary({ ...counts, mediansByModel,
    v1ParticipantCount: evaluated.length + refusedParticipants, unsupportedSourceParticipantCount: 0 }, day);
}

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
