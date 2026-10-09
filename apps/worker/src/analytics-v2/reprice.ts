/** Bounded saved-cohort repricing. No source/evidence or current-roster reads. */
import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";
import { buildCommunityDailyPayload, createV11DailyProjectionValues, publicInputs,
  validateV11DailyProjectionValues, type V11DailyProjectionValues } from "../../vendor/analytics-d43c8f92/entry";
import { analyticsV2DailyContentSha256 } from "./store-run";
import { assertAnalyticsV2PricesMatchDaily, decodeAnalyticsV2PriceInputs, priceAnalyticsV2Input,
  ANALYTICS_V2_PRICE_STATUS, type AnalyticsV2PriceInput, type AnalyticsV2PricedEvent,
  } from "./price-attribution";

export const ANALYTICS_V2_REPRICE_TABLES = Object.freeze({
  runs: "analytics_v2_reprice_runs", equivalences: "analytics_v2_price_equivalences",
  publicationLog: "analytics_v2_published_daily_log",
  contributionPriceInputs: "analytics_v2_contribution_price_inputs",
});
export const ANALYTICS_V2_REPRICE_LIMITS = Object.freeze({ days: 32, members: 1_000,
  inputBytes: 16 * 1024 * 1024, events: 500_000 });
/** Non-owner audit family. The owner archive is already in the shared contract inventory. */
export const ANALYTICS_V2_REPRICE_AUDIT_TABLES = Object.freeze({ runs: ANALYTICS_V2_REPRICE_TABLES.runs,
  equivalences: ANALYTICS_V2_REPRICE_TABLES.equivalences,publicationLog: ANALYTICS_V2_REPRICE_TABLES.publicationLog });
export const ANALYTICS_V2_REPRICE_AUDIT_COLUMNS = Object.freeze({
  runs: ["run_id","plan_sha256","kernel_id","manifest_version","registry_sha256","pricing_method_version","bounds","receipt","finished_at"],
  equivalences: ["day","revision","payload_sha256","source_sha256","exclusions_sha256","kernel_id","manifest_version","registry_sha256","pricing_method_version","run_id"],
  publicationLog: ["day","revision","released_at","payload","payload_sha256","run_id","kernel_id","manifest_version"],
});
export const ANALYTICS_V2_REPRICE_AUDIT_PRIMARY_KEYS = Object.freeze({ runs: ["run_id"],
  equivalences: ["day","revision","payload_sha256","kernel_id","manifest_version","source_sha256","exclusions_sha256"],
  publicationLog: ["day","revision"] });
export type AnalyticsV2RepriceRefusal = "owner_set_unavailable" | "member_link_unavailable"
  | "price_inputs_unavailable" | "price_input_association_unproven" | "price_inputs_corrupt"
  | "contribution_invalid" | "reprice_membership_or_evidence_drift";
export class AnalyticsV2RepriceError extends Error {
  constructor(readonly code: "ANALYTICS_V2_REPRICE_INVALID" | "ANALYTICS_V2_REPRICE_LIMIT"
    | "ANALYTICS_V2_REPRICE_PLAN_CHANGED" | "ANALYTICS_V2_REPRICE_WRITE_FAILED"
    | "ANALYTICS_V2_REPRICE_SCHEMA_UNAVAILABLE") { super(code); this.name = "AnalyticsV2RepriceError"; }
}
export const repriceFail = (code: AnalyticsV2RepriceError["code"]): never => { throw new AnalyticsV2RepriceError(code); };
export interface AnalyticsV2RepriceBounds {
  readonly fromDay: string; readonly throughDay: string;
  readonly maxDays: number; readonly maxMembers: number; readonly maxInputBytes: number;
}
export function validAnalyticsV2RepriceBounds(value: AnalyticsV2RepriceBounds): AnalyticsV2RepriceBounds {
  const day = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(v)
    && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  if (!value || !day(value.fromDay) || !day(value.throughDay) || value.fromDay > value.throughDay
    || Object.keys(value).sort().join(",") !== "fromDay,maxDays,maxInputBytes,maxMembers,throughDay"
    || !Number.isSafeInteger(value.maxDays) || value.maxDays < 1 || value.maxDays > ANALYTICS_V2_REPRICE_LIMITS.days
    || !Number.isSafeInteger(value.maxMembers) || value.maxMembers < 1 || value.maxMembers > ANALYTICS_V2_REPRICE_LIMITS.members
    || !Number.isSafeInteger(value.maxInputBytes) || value.maxInputBytes < 1 || value.maxInputBytes > ANALYTICS_V2_REPRICE_LIMITS.inputBytes) {
    repriceFail("ANALYTICS_V2_REPRICE_INVALID");
  }
  return Object.freeze({ ...value });
}
export interface AnalyticsV2RepriceMember {
  readonly ownerDigest: string; readonly version: number; readonly devices: number;
  readonly values: unknown; readonly valuesSha256: string; readonly runId: string; readonly priceKernelId: number;
  readonly participantLinked: boolean; readonly excluded: boolean;
  readonly priceRunId: string | null; readonly inputKernelId: number | null;
  readonly inputs: Parameters<typeof decodeAnalyticsV2PriceInputs>[0] | null;
}
export interface AnalyticsV2RepriceHead {
  readonly day: string; readonly revision: number; readonly payload: Record<string, unknown>;
  readonly payloadSha256: string; readonly recorded: boolean;
  readonly members: readonly AnalyticsV2RepriceMember[];
}
export interface AnalyticsV2RepricePreparedHead {
  readonly head: AnalyticsV2RepriceHead;
  readonly outcome: "changed" | "equivalent" | "unchanged" | "refused";
  readonly refusal: AnalyticsV2RepriceRefusal | null;
  readonly payload: Record<string, unknown> | null;
  readonly members: readonly { readonly member: AnalyticsV2RepriceMember; readonly values: V11DailyProjectionValues }[];
}
/** Remove price identity only: equal means equivalent stamps, not changed dollars/coverage. */
export function analyticsV2RepriceStableContent(payload: Record<string, unknown>): string {
  const copy = structuredClone(payload);
  delete copy.aggregateId; delete copy.revision; delete copy.releasedAt;
  const spend = copy.apiEquivalentSpend;
  if (spend && typeof spend === "object" && !Array.isArray(spend)) {
    delete (spend as Record<string, unknown>).registrySha256;
    delete (spend as Record<string, unknown>).pricingMethodVersion;
  }
  return canonicalJson(copy);
}
/** Non-spend payload invariant. Revision metadata is assigned separately by the existing writer. */
export function analyticsV2RepriceNonSpend(payload: Record<string, unknown>): string {
  const { apiEquivalentSpend: _spend, aggregateId: _id, revision: _revision, releasedAt: _at, ...rest } = payload;
  return canonicalJson(rest);
}
type Pricing = V11DailyProjectionValues["pricing"];
const emptyPricing = (): Pricing => ({ knownNanousd: "0", fullyPriced: 0, partiallyPriced: 0, unpriced: 0 });
function addPricing(target: Pricing, priced: AnalyticsV2PricedEvent): void {
  if (!Number.isSafeInteger(priced.costNanousd) || priced.costNanousd < 0
    || ![0, 1, 2, 3].includes(priced.status)) repriceFail("ANALYTICS_V2_REPRICE_INVALID");
  if (priced.status === ANALYTICS_V2_PRICE_STATUS.fullyPriced) target.fullyPriced++;
  else if (priced.status === ANALYTICS_V2_PRICE_STATUS.partiallyPriced) target.partiallyPriced++;
  else { target.unpriced++; return; }
  target.knownNanousd = (BigInt(target.knownNanousd) + BigInt(priced.costNanousd)).toString();
}
/** Strict first supported association: input and saved contribution came from the SAME run/kernel. */
export async function repriceAnalyticsV2Contribution(day: string, member: AnalyticsV2RepriceMember,
  price: (input: AnalyticsV2PriceInput) => AnalyticsV2PricedEvent = priceAnalyticsV2Input): Promise<V11DailyProjectionValues> {
  if (await sha256Hex(canonicalJson(member.values)) !== member.valuesSha256) throw new Error("contribution_invalid");
  const values = structuredClone(member.values) as V11DailyProjectionValues;
  if (!values || typeof values !== "object" || Array.isArray(values)
    || typeof values.registrySha256 !== "string" || !/^[0-9a-f]{64}$/u.test(values.registrySha256)
    || typeof values.pricingMethodVersion !== "string"
    || !/^server-api-price-equivalent-v\d+\.\d+$/u.test(values.pricingMethodVersion)) throw new Error("contribution_invalid");
  const identity = createV11DailyProjectionValues(day);
  values.registrySha256 = identity.registrySha256;
  values.pricingMethodVersion = identity.pricingMethodVersion;
  try { validateV11DailyProjectionValues(values); } catch { throw new Error("contribution_invalid"); }
  if (values.day !== day || values.counts.usage + values.counts.quota + values.counts.session === 0) {
    throw new Error("contribution_invalid");
  }
  // There are no price inputs to recover when the saved usage count is zero.
  if (values.counts.usage === 0) return values;
  if (member.inputs === null) throw new Error("price_inputs_unavailable");
  if (member.priceRunId !== member.runId || member.inputKernelId !== member.priceKernelId) {
    throw new Error("price_input_association_unproven");
  }
  const decoded = await decodeAnalyticsV2PriceInputs(member.inputs);
  assertAnalyticsV2PricesMatchDaily(day, decoded.events, values);
  values.pricing = emptyPricing();
  values.omitted.pricing = emptyPricing();
  for (const cell of values.cells) cell.pricing = emptyPricing();
  const cells = new Map(values.cells.map((cell) => [canonicalJson([cell.provider, cell.modelId]), cell]));
  for (const event of decoded.events) {
    const priced = price(event.input);
    addPricing(values.pricing, priced);
    const cell = cells.get(canonicalJson([event.input.provider, event.input.modelId ?? ""]));
    addPricing(cell?.pricing ?? values.omitted.pricing, priced);
  }
  validateV11DailyProjectionValues(values);
  return values;
}
/** Pure saved-set lane: does not union in today's roster. */
export async function prepareAnalyticsV2RepriceHead(head: AnalyticsV2RepriceHead,
  price?: (input: AnalyticsV2PriceInput) => AnalyticsV2PricedEvent): Promise<AnalyticsV2RepricePreparedHead> {
  const refuse = (refusal: AnalyticsV2RepriceRefusal): AnalyticsV2RepricePreparedHead =>
    ({ head, outcome: "refused", refusal, payload: null, members: [] });
  if (!head.recorded) return refuse("owner_set_unavailable");
  if (head.members.length > ANALYTICS_V2_REPRICE_LIMITS.members
    || head.members.reduce((bytes, member) => bytes + (member.inputs?.bytes.byteLength ?? 0), 0)
      > ANALYTICS_V2_REPRICE_LIMITS.inputBytes) repriceFail("ANALYTICS_V2_REPRICE_LIMIT");
  if (await analyticsV2DailyContentSha256(head.payload) !== head.payloadSha256) return refuse("contribution_invalid");
  const members: Array<{ member: AnalyticsV2RepriceMember; values: V11DailyProjectionValues }> = [];
  const seen = new Set<string>();
  let events = 0;
  for (const member of [...head.members].sort((a, b) => a.ownerDigest < b.ownerDigest ? -1 : 1)) {
    if (!/^[0-9a-f]{64}$/u.test(member.ownerDigest) || seen.has(member.ownerDigest)
      || !Number.isSafeInteger(member.version) || member.version < 1
      || !Number.isSafeInteger(member.devices) || member.devices < 1) return refuse("contribution_invalid");
    seen.add(member.ownerDigest);
    if (!member.participantLinked) return refuse("member_link_unavailable");
    if (member.excluded) continue; // EXCL-DEPARTED: stays in S(d), folds nothing.
    events += member.inputs?.events ?? 0;
    if (events > ANALYTICS_V2_REPRICE_LIMITS.events) repriceFail("ANALYTICS_V2_REPRICE_LIMIT");
    try { members.push({ member, values: await repriceAnalyticsV2Contribution(head.day, member, price) }); }
    catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (["price_inputs_unavailable", "price_input_association_unproven", "contribution_invalid"].includes(code)) {
        return refuse(code as AnalyticsV2RepriceRefusal);
      }
      return refuse("price_inputs_corrupt");
    }
  }
  const inputs = publicInputs(members.map((m) => m.values), members.map((m) => m.member.devices));
  const folded = buildCommunityDailyPayload({ day: head.day, revision: head.revision,
    releasedAt: String(head.payload.releasedAt), ...inputs }) as unknown as Record<string, unknown>;
  if (analyticsV2RepriceNonSpend(folded) !== analyticsV2RepriceNonSpend(head.payload)) {
    return refuse("reprice_membership_or_evidence_drift");
  }
  const payload = { ...head.payload, apiEquivalentSpend: folded.apiEquivalentSpend };
  const outcome = await analyticsV2DailyContentSha256(payload) === head.payloadSha256 ? "unchanged"
    : analyticsV2RepriceStableContent(payload) === analyticsV2RepriceStableContent(head.payload) ? "equivalent" : "changed";
  return { head, outcome, refusal: null, payload, members };
}
