/** Explicit new-contribution correction. Never retro-associates a saved version. */
import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";
import { buildCommunityDailyPayload, createV11DailyProjectionValues, publicInputs,
  validateV11DailyProjectionValues, type V11DailyProjectionValues } from "../../vendor/analytics-d43c8f92/entry";
import { analyticsV2DailyContentSha256 } from "./store-run";
import { ANALYTICS_V2_REPRICE_LIMITS, analyticsV2RepriceNonSpend, priceAnalyticsV2ContributionValues,
  repriceFail, type AnalyticsV2RepriceMember, type AnalyticsV2RepriceHead } from "./reprice";
import { assertAnalyticsV2PricesMatchDaily, decodeAnalyticsV2PriceInputs, priceAnalyticsV2Input,
  type AnalyticsV2PriceInputEvent } from "./price-attribution";

export const ANALYTICS_V2_CURRENT_CORRECTION_LIMITS = ANALYTICS_V2_REPRICE_LIMITS;
export const ANALYTICS_V2_CURRENT_CORRECTION_ERROR_CODES = Object.freeze([
  "ANALYTICS_V2_REPRICE_INVALID", "ANALYTICS_V2_REPRICE_LIMIT", "ANALYTICS_V2_REPRICE_PLAN_CHANGED",
  "ANALYTICS_V2_REPRICE_WRITE_FAILED", "ANALYTICS_V2_REPRICE_SCHEMA_UNAVAILABLE",
] as const);
export const ANALYTICS_V2_CURRENT_CORRECTION_REFUSALS = Object.freeze([
  "owner_set_unavailable", "member_link_unavailable", "price_inputs_unavailable",
  "price_input_association_unproven", "price_inputs_corrupt", "contribution_invalid",
  "reprice_membership_or_evidence_drift", "current_source_unavailable", "current_source_binding_unproven",
  "current_source_run_unproven", "current_source_non_spend_drift", "current_source_values_unchanged",
] as const);
export type CurrentCorrectionRefusal = typeof ANALYTICS_V2_CURRENT_CORRECTION_REFUSALS[number];
export interface CurrentCorrectionProvenance {
  readonly inputSource: "archive" | "current-owner-day";
  readonly priorVersion: number; readonly priorValuesSha256: string;
  readonly sourceRunId: string; readonly sourceKernelId: number; readonly sourceManifestVersion: number;
  readonly sourceValuesSha256: string; readonly sourceInputsSha256: string;
}
export interface CurrentCorrectionMember extends AnalyticsV2RepriceMember {
  readonly manifestVersion: number;
  readonly archivePresent: boolean; readonly archiveValuesSha256: string | null;
  readonly current: null | {
    readonly values: unknown; readonly refusal: unknown; readonly runId: string; readonly kernelId: number;
    readonly manifestVersion: number; readonly priceManifestVersion: number;
    readonly usageEvents: number; readonly runState: string | null; readonly runMode: string | null;
    readonly runKernelId: number | null; readonly runManifestVersion: number | null;
    readonly runFinished: boolean;
  };
}
export interface CurrentCorrectionHead extends Omit<AnalyticsV2RepriceHead, "members"> {
  readonly members: readonly CurrentCorrectionMember[];
}
export interface CurrentCorrectionPreparedMember {
  readonly member: CurrentCorrectionMember; readonly values: V11DailyProjectionValues;
  readonly events: readonly AnalyticsV2PriceInputEvent[]; readonly provenance: CurrentCorrectionProvenance | null;
}
export interface CurrentCorrectionPreparedHead {
  readonly head: CurrentCorrectionHead; readonly outcome: "changed" | "unchanged" | "refused";
  readonly refusal: CurrentCorrectionRefusal | null; readonly payload: Record<string, unknown> | null;
  readonly members: readonly CurrentCorrectionPreparedMember[];
}
export interface CurrentCorrectionReceipt {
  readonly schema: "analytics-v2-current-correction-execution-v1"; readonly status: "complete";
  readonly inputSource: "current-owner-day"; readonly sourceKernelId: number; readonly planSha256: string;
  readonly counts: { planned: number; changed: number; unchanged: number; refused: number;
    contributionVersions: number; currentSourceVersions: number; archiveSourceVersions: number };
  readonly refusals: Record<CurrentCorrectionRefusal, number>; readonly replayed: boolean;
}
const SHA = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function refuse(code: CurrentCorrectionRefusal): never { throw new Error(code); }
export function validCurrentCorrectionSourceKernel(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32767) repriceFail("ANALYTICS_V2_REPRICE_INVALID");
  return value;
}
export function validAnalyticsV2CurrentCorrectionStoredReceipt(value: unknown, planSha256: unknown,
  sourceKernelId: unknown): value is CurrentCorrectionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "counts,inputSource,planSha256,refusals,replayed,schema,sourceKernelId,status"
    || v.schema !== "analytics-v2-current-correction-execution-v1" || v.status !== "complete"
    || v.inputSource !== "current-owner-day" || v.sourceKernelId !== sourceKernelId
    || typeof sourceKernelId !== "number" || !Number.isInteger(sourceKernelId) || sourceKernelId < 1 || sourceKernelId > 32767
    || v.replayed !== false || v.planSha256 !== planSha256 || typeof planSha256 !== "string" || !SHA.test(planSha256)
    || !v.counts || typeof v.counts !== "object" || Array.isArray(v.counts)
    || !v.refusals || typeof v.refusals !== "object" || Array.isArray(v.refusals)) return false;
  const c = v.counts as CurrentCorrectionReceipt["counts"], r = v.refusals as Record<string, number>;
  if (Object.keys(c).sort().join(",") !== "archiveSourceVersions,changed,contributionVersions,currentSourceVersions,planned,refused,unchanged"
    || Object.keys(r).sort().join(",") !== [...ANALYTICS_V2_CURRENT_CORRECTION_REFUSALS].sort().join(",")) return false;
  if (!Object.entries(c).every(([key, n]) => Number.isSafeInteger(n) && n >= 0 && n <= (key.endsWith("Versions") ? 1000 : 32))
    || !Object.values(r).every(n => Number.isSafeInteger(n) && n >= 0 && n <= 32)) return false;
  return c.changed + c.unchanged + c.refused === c.planned
    && c.currentSourceVersions + c.archiveSourceVersions === c.contributionVersions
    && Object.values(r).reduce((sum, n) => sum + n, 0) === c.refused;
}
/** Both inputs must first pass the complete closed projection validator. */
export function currentCorrectionNonSpend(value: V11DailyProjectionValues): string {
  const copy = structuredClone(value) as unknown as Record<string, unknown>;
  delete copy.pricing; delete copy.registrySha256; delete copy.pricingMethodVersion;
  copy.cells = value.cells.map(({ pricing: _pricing, ...cell }) => cell);
  const { pricing: _pricing, ...omitted } = value.omitted;
  copy.omitted = omitted;
  return canonicalJson(copy);
}
function validatedSaved(day: string, member: CurrentCorrectionMember): V11DailyProjectionValues {
  const values = structuredClone(member.values) as V11DailyProjectionValues;
  if (!values || typeof values !== "object" || Array.isArray(values) || !SHA.test(values.registrySha256)
    || !/^server-api-price-equivalent-v\d+\.\d+$/u.test(values.pricingMethodVersion)) return refuse("contribution_invalid");
  const target = createV11DailyProjectionValues(day);
  values.registrySha256 = target.registrySha256; values.pricingMethodVersion = target.pricingMethodVersion;
  try { validateV11DailyProjectionValues(values); } catch { return refuse("contribution_invalid"); }
  if (values.day !== day || values.counts.usage + values.counts.quota + values.counts.session === 0) return refuse("contribution_invalid");
  return values;
}
const COMPONENTS = ["inputUncachedTokens", "inputCacheReadTokens", "inputCacheWriteTokens", "outputTextTokens",
  "outputReasoningTokens", "outputCombinedTokens"] as const;
type Token = { knownSum: string; unavailable: number };
const sum = (values: readonly (number | null)[]): Token => ({
  knownSum: values.reduce<bigint>((total, value) => total + BigInt(value ?? 0), 0n).toString(),
  unavailable: values.some(value => value === null) ? 1 : 0,
});
function addTokens(target: V11DailyProjectionValues["tokens"], value: V11DailyProjectionValues["tokens"]): void {
  for (const key of Object.keys(target) as Array<keyof typeof target>) {
    target[key].knownSum = (BigInt(target[key].knownSum) + BigInt(value[key].knownSum)).toString();
    target[key].unavailable += value[key].unavailable;
  }
}
/** The codec has usage components, not original occurrence IDs or non-usage streams. */
export function assertCurrentCorrectionInputTokens(day: string, events: readonly AnalyticsV2PriceInputEvent[],
  values: V11DailyProjectionValues): void {
  // The existing checker owns the canonical lexical cell cap and null-model
  // mapping. Use its verified kept-cell count rather than a second cap policy.
  assertAnalyticsV2PricesMatchDaily(day, events, values);
  const keptCellCount = values.cells.length;
  const aggregate = createV11DailyProjectionValues(day);
  const cells = new Map<string, { provider: string; modelId: string; usageEvents: number; tokens: typeof aggregate.tokens }>();
  for (const { input } of events) {
    const tokens = createV11DailyProjectionValues(day).tokens;
    COMPONENTS.forEach((key, i) => { tokens[key] = sum([input.components[i]!]); });
    const output = input.components[5] === null ? [input.components[3]!, input.components[4]!] : [input.components[5]!];
    tokens.effectiveOutput = sum(output);
    tokens.nonOverlappingTotal = sum([...input.components.slice(0, 3), ...output]);
    addTokens(aggregate.tokens, tokens);
    const modelId = input.modelId ?? "", key = canonicalJson([input.provider, modelId]);
    const cell = cells.get(key) ?? { provider: input.provider, modelId, usageEvents: 0,
      tokens: createV11DailyProjectionValues(day).tokens };
    cell.usageEvents++; addTokens(cell.tokens, tokens); cells.set(key, cell);
  }
  const ordered = [...cells.values()].sort((a, b) => a.provider < b.provider ? -1 : a.provider > b.provider ? 1
    : a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0);
  for (const cell of ordered.slice(keptCellCount)) {
    aggregate.omitted.usageEvents += cell.usageEvents; addTokens(aggregate.omitted.tokens, cell.tokens);
  }
  if (values.counts.usage !== events.length || canonicalJson(aggregate.tokens) !== canonicalJson(values.tokens)
    || canonicalJson(ordered.slice(0, keptCellCount)) !== canonicalJson(values.cells.map(({ pricing: _pricing, ...cell }) => cell))
    || aggregate.omitted.usageEvents !== values.omitted.usageEvents
    || canonicalJson(aggregate.omitted.tokens) !== canonicalJson(values.omitted.tokens)) refuse("price_inputs_corrupt");
}
async function prepareMember(day: string, member: CurrentCorrectionMember, sourceKernelId: number): Promise<CurrentCorrectionPreparedMember> {
  if (await sha256Hex(canonicalJson(member.values)) !== member.valuesSha256) refuse("contribution_invalid");
  const values = validatedSaved(day, member);
  // No usage inputs exist to associate. Fold its validated saved non-spend
  // evidence but retain its existing version; never invent archive provenance.
  if (values.counts.usage === 0) return { member,values,events: [],provenance: null };
  let sourceValues = values, sourceRunId = member.runId, sourceKernel = member.priceKernelId;
  let sourceManifest = member.manifestVersion;
  if (member.archivePresent) {
    if (member.archiveValuesSha256 !== member.valuesSha256 || member.priceRunId !== member.runId
      || member.inputKernelId !== member.priceKernelId) refuse("price_input_association_unproven");
  } else {
    const current = member.current;
    if (current === null || current.values === null || current.refusal !== null || member.inputs === null) refuse("current_source_unavailable");
    if (!UUID.test(current.runId) || current.runId !== member.priceRunId || current.kernelId !== sourceKernelId
      || member.inputKernelId !== sourceKernelId || current.manifestVersion !== 1
      || current.priceManifestVersion !== current.manifestVersion) refuse("current_source_binding_unproven");
    if (current.runState !== "complete" || current.runMode !== "full" || !current.runFinished
      || current.runKernelId !== current.kernelId || current.runManifestVersion !== current.manifestVersion) refuse("current_source_run_unproven");
    sourceValues = structuredClone(current.values) as V11DailyProjectionValues;
    try { validateV11DailyProjectionValues(sourceValues); } catch { return refuse("contribution_invalid"); }
    if (sourceValues.day !== day || current.usageEvents !== sourceValues.counts.usage
      || member.inputs.events !== sourceValues.counts.usage) refuse("price_inputs_corrupt");
    if (currentCorrectionNonSpend(values) !== currentCorrectionNonSpend(sourceValues)) refuse("current_source_non_spend_drift");
    sourceRunId = current.runId; sourceKernel = current.kernelId; sourceManifest = current.manifestVersion;
  }
  if (member.inputs === null) refuse("price_inputs_unavailable");
  const decoded = await decodeAnalyticsV2PriceInputs(member.inputs);
  assertCurrentCorrectionInputTokens(day, decoded.events, sourceValues);
  const events = decoded.events.map(event => ({ input: event.input, priced: priceAnalyticsV2Input(event.input) }));
  const corrected = priceAnalyticsV2ContributionValues(values, events);
  if (currentCorrectionNonSpend(corrected) !== currentCorrectionNonSpend(sourceValues)) refuse("current_source_non_spend_drift");
  if (!member.archivePresent && await sha256Hex(canonicalJson(corrected)) === member.valuesSha256) refuse("current_source_values_unchanged");
  return { member, values: corrected, events, provenance: {
    inputSource: member.archivePresent ? "archive" : "current-owner-day", priorVersion: member.version,
    priorValuesSha256: member.valuesSha256, sourceRunId, sourceKernelId: sourceKernel, sourceManifestVersion: sourceManifest,
    sourceValuesSha256: member.archivePresent ? member.valuesSha256 : await sha256Hex(canonicalJson(sourceValues)),
    sourceInputsSha256: member.inputs.sha256,
  } };
}
export async function prepareAnalyticsV2CurrentCorrectionHead(head: CurrentCorrectionHead,
  sourceKernelId: number): Promise<CurrentCorrectionPreparedHead> {
  validCurrentCorrectionSourceKernel(sourceKernelId);
  const failed = (refusal: CurrentCorrectionRefusal): CurrentCorrectionPreparedHead =>
    ({ head, outcome: "refused", refusal, payload: null, members: [] });
  if (!head.recorded) return failed("owner_set_unavailable");
  if (head.members.length > ANALYTICS_V2_REPRICE_LIMITS.members
    || head.members.reduce((sum, m) => sum + (m.inputs?.bytes.byteLength ?? 0), 0) > ANALYTICS_V2_REPRICE_LIMITS.inputBytes
    || head.members.reduce((sum, m) => sum + (m.inputs?.events ?? 0), 0) > ANALYTICS_V2_REPRICE_LIMITS.events) repriceFail("ANALYTICS_V2_REPRICE_LIMIT");
  if (await analyticsV2DailyContentSha256(head.payload) !== head.payloadSha256) return failed("contribution_invalid");
  const members: CurrentCorrectionPreparedMember[] = [], seen = new Set<string>();
  for (const member of [...head.members].sort((a, b) => a.ownerDigest < b.ownerDigest ? -1 : 1)) {
    if (!SHA.test(member.ownerDigest) || seen.has(member.ownerDigest) || !Number.isSafeInteger(member.version) || member.version < 1
      || !Number.isSafeInteger(member.devices) || member.devices < 1) return failed("contribution_invalid");
    seen.add(member.ownerDigest);
    if (!member.participantLinked) return failed("member_link_unavailable");
    if (member.excluded) continue;
    try { members.push(await prepareMember(head.day, member, sourceKernelId)); }
    catch (error) {
      const code = error instanceof Error ? error.message : "";
      return failed((ANALYTICS_V2_CURRENT_CORRECTION_REFUSALS as readonly string[]).includes(code)
        ? code as CurrentCorrectionRefusal : "price_inputs_corrupt");
    }
  }
  const folded = buildCommunityDailyPayload({ day: head.day, revision: head.revision,
    releasedAt: String(head.payload.releasedAt), ...publicInputs(members.map(m => m.values), members.map(m => m.member.devices)) }) as unknown as Record<string, unknown>;
  if (analyticsV2RepriceNonSpend(folded) !== analyticsV2RepriceNonSpend(head.payload)) return failed("reprice_membership_or_evidence_drift");
  const payload = { ...head.payload, apiEquivalentSpend: folded.apiEquivalentSpend };
  return { head, outcome: await analyticsV2DailyContentSha256(payload) === head.payloadSha256 ? "unchanged" : "changed",
    refusal: null, payload, members };
}
