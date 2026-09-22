import { PLAN_ATTRIBUTION_POLICY, QUOTA_CALIBRATION_POLICY } from "@app-usagemonitor/quota-analysis";
import type { PlanAttributionObservation } from "@app-usagemonitor/quota-analysis";
import { TELEMETRY_PLAN_TYPES } from "@app-usagemonitor/telemetry-contract";
import {
  validQuotaResetClusterEntries,
  type QuotaEndpointRun,
  type QuotaFragmentStats,
} from "./quota-endpoint-collapse";

/**
 * The v1.1 acquisition CONTRACT: the shapes, bounds and validators that both
 * the acquisition reader and the prepared-day artifact are written against.
 *
 * It exists to break a cycle, not to add a layer. The artifact module needs
 * five of the reader's symbols to state its own bounds and to validate the
 * components it stores; the reader needs the artifact's type to accept a folded
 * window. Neither can be loosened — `PlanAttributionObservation` has looser
 * optionality and no `planBasis` — so the shared half lives here, imports only
 * packages and the collapse kernel, and both sides depend on it instead of on
 * each other. The reader re-exports everything it used to own, so its callers
 * are unchanged.
 */

/** The account/plan attribution basis a source row states, as the ingestion
 * envelope defines it. Declared here rather than reached for through the
 * typed reader, which is a D1 module this contract must not depend on. */
export type V11PlanBasis = "unavailable" | "same_source_occurrence" | "provisional_marker" | "conflicted" | null;

export const V11_PLAN_ANCHOR_LIMIT = 120_000;
export const V11_QUOTA_ENDPOINT_LIMIT = 60_000;
export const SAFE_TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/u;
export const OPAQUE_ID = /^[A-Za-z0-9._:-]{8,128}$/u;
export const ACCOUNT_TRACK = /^account-track:v2:[0-9a-f]{64}$/u;
export const PLAN_ERA = /^plan-era:v1:[0-9a-f]{64}$/u;
export const PLAN_TYPES = new Set<string>(TELEMETRY_PLAN_TYPES);
export const SLOTS = new Set(["primary", "secondary", "five_hour", "seven_day", "other", "unknown"]);
export const MIN_TIME = -8_640_000_000_000_000;
export const MAX_TIME = 8_640_000_000_000_000;

export interface V11PlanAnchor extends PlanAttributionObservation {
  contextKey: string;
  observedAtMs: number;
  planType: string | null;
  planVariant: string;
  continuityId: string | null;
  conflicted: boolean;
  accountScopeId: string | null;
  /** Retained to make DISTINCT/LAG semantics stable when a malformed source
   * records two otherwise identical labels with different basis metadata. */
  planBasis: V11PlanBasis;
}

export interface V11AcquiredQuotaRow {
  occurrence_id: string;
  observed_at: string;
  provider: string;
  account_scope_id: string | null;
  limit_id: string;
  plan_type: string;
  plan_variant: string;
  continuity_id: string | null;
  plan_basis: V11PlanBasis;
  slot: string;
  used_percent: number;
  window_duration_minutes: number;
  resets_at: string;
  plan_era_key: string;
}

export interface PlanRun {
  first: V11PlanAnchor;
  last: V11PlanAnchor;
  signature: string;
}

export type FragmentStats = QuotaFragmentStats;
export interface Endpoint {
  id: number;
  row: V11AcquiredQuotaRow;
}
export type EndpointRun = QuotaEndpointRun<Endpoint>;

export function textOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function numberOrder(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export function instant(value: unknown): value is string {
  return typeof value === "string" && value.length <= 27 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}
export function safeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= MIN_TIME && (value as number) <= MAX_TIME;
}
export function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
export function percent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}
export function boundedToken(value: unknown): value is string {
  return typeof value === "string" && SAFE_TOKEN.test(value);
}
export function canonicalTuple(value: unknown, length: number, maximum = 1024): unknown[] | null {
  if (typeof value !== "string" || value.length > maximum) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === length && JSON.stringify(parsed) === value ? parsed : null;
  } catch { return null; }
}

export function accountScope(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && ACCOUNT_TRACK.test(value));
}
export function validEraKey(value: unknown): value is string {
  const fields = canonicalTuple(value, 5) ?? canonicalTuple(value, 6);
  const context = typeof fields?.[0] === "string" ? fields[0].split("|") : [];
  if (!fields || context.length !== 2 || !boundedToken(context[0]!) || context[1] !== "codex"
      || fields[1] !== null && !ACCOUNT_TRACK.test(String(fields[1]))
      || typeof fields[2] !== "string" || !PLAN_TYPES.has(fields[2])
      || !boundedToken(fields[3]) || !safeTime(fields[4])) return false;
  return fields.length === 5
    ? true
    : typeof fields[5] === "string" && PLAN_ERA.test(fields[5]);
}
export function validPlanAnchor(value: unknown): value is V11PlanAnchor {
  if (!closed(value, ["contextKey", "observedAtMs", "planType", "planVariant", "continuityId",
    "conflicted", "accountScopeId", "planBasis"])) return false;
  if (typeof value.contextKey !== "string" || value.contextKey.length === 0
      || !safeTime(value.observedAtMs) || (value.planType !== null && !PLAN_TYPES.has(value.planType as string))
      || !boundedToken(value.planVariant) || (value.continuityId !== null && !PLAN_ERA.test(value.continuityId as string))
      || typeof value.conflicted !== "boolean" || !accountScope(value.accountScopeId)
      || ![null, "unavailable", "same_source_occurrence", "provisional_marker", "conflicted"]
        .includes(value.planBasis as string | null)) return false;
  const [provider, limit] = value.contextKey.split("|");
  return provider !== undefined && limit === "codex" && boundedToken(provider);
}
export function validQuotaRow(value: unknown): value is V11AcquiredQuotaRow {
  if (!closed(value, ["occurrence_id", "observed_at", "provider", "account_scope_id", "limit_id",
    "plan_type", "plan_variant", "continuity_id", "plan_basis", "slot", "used_percent",
    "window_duration_minutes", "resets_at", "plan_era_key"])) return false;
  const occurrence = value.occurrence_id;
  const observed = value.observed_at;
  const provider = value.provider;
  const account = value.account_scope_id;
  const planType = value.plan_type;
  const planVariant = value.plan_variant;
  const continuity = value.continuity_id;
  const basis = value.plan_basis;
  const slot = value.slot;
  const used = value.used_percent;
  const window = value.window_duration_minutes;
  const resets = value.resets_at;
  const validWindow = typeof window === "number" && Number.isSafeInteger(window)
    && window >= 1 && window <= 527_040;
  return typeof occurrence === "string" && OPAQUE_ID.test(occurrence)
    && instant(observed) && boundedToken(provider) && accountScope(account)
    && value.limit_id === "codex" && typeof planType === "string" && PLAN_TYPES.has(planType)
    && boundedToken(planVariant) && (continuity === null || typeof continuity === "string" && PLAN_ERA.test(continuity))
    && [null, "unavailable", "same_source_occurrence", "provisional_marker", "conflicted"]
      .includes(basis as string | null)
    && typeof slot === "string" && SLOTS.has(slot) && percent(used)
    && validWindow && instant(resets)
    && Date.parse(resets) > Date.parse(observed) && validEraKey(value.plan_era_key);
}
export function planSignature(row: V11PlanAnchor): string {
  return JSON.stringify([row.planType, row.planVariant, row.continuityId, row.planBasis]);
}
export function planGroup(row: V11PlanAnchor): string {
  return JSON.stringify([row.contextKey, row.accountScopeId]);
}
export function planSort(left: V11PlanAnchor, right: V11PlanAnchor): number {
  return textOrder(planGroup(left), planGroup(right)) || textOrder(planSignature(left), planSignature(right));
}
export function samePlan(left: V11PlanAnchor, right: V11PlanAnchor): boolean {
  return planSignature(left) === planSignature(right);
}
export function statsKey(reset: string, era: string): string { return JSON.stringify([reset, era]); }
export function endpointKey(era: string, slot: string, reset: string): string {
  return JSON.stringify([era, slot, reset]);
}
export function validStatsKey(value: unknown): value is string {
  const fields = canonicalTuple(value, 2);
  return !!fields && instant(fields[0]) && validEraKey(fields[1]);
}
export function validEligibleKey(value: unknown): value is string {
  return validStatsKey(value);
}
export function validEndpointKey(value: unknown): value is string {
  const fields = canonicalTuple(value, 3);
  return !!fields && validEraKey(fields[0]) && typeof fields[1] === "string"
    && SLOTS.has(fields[1]) && instant(fields[2]);
}
export function validEndpoint(value: unknown): value is Endpoint {
  return closed(value, ["id", "row"]) && positiveId(value.id) && validQuotaRow(value.row);
}
export function validPlanRun(value: unknown): value is PlanRun {
  return closed(value, ["first", "last", "signature"]) && validPlanAnchor(value.first)
    && validPlanAnchor(value.last) && typeof value.signature === "string"
    && value.signature === planSignature(value.first) && value.signature === planSignature(value.last)
    && value.first.contextKey === value.last.contextKey
    && value.first.accountScopeId === value.last.accountScopeId
    && value.first.observedAtMs <= value.last.observedAtMs;
}
export function validStats(value: unknown): value is FragmentStats {
  return closed(value, ["values", "minimum", "maximum"]) && Array.isArray(value.values)
    && value.values.length >= 1 && value.values.length <= QUOTA_CALIBRATION_POLICY.minimumBoundaries
    && value.values.every(percent) && new Set(value.values).size === value.values.length
    && percent(value.minimum) && percent(value.maximum) && value.minimum <= value.maximum
    && value.values.every((number: number) => number >= (value.minimum as number)
      && number <= (value.maximum as number));
}
export function validEndpointRun(value: unknown): value is EndpointRun {
  return closed(value, ["firstId", "last", "keptAtMs", "keptValues", "keptMinimum", "keptMaximum",
    "holdMinimum", "holdMaximum", "pending"])
    && positiveId(value.firstId) && percent(value.keptMinimum) && percent(value.keptMaximum)
    && (value.keptMinimum as number) <= (value.keptMaximum as number)
    && (value.holdMinimum === null || validEndpoint(value.holdMinimum))
    && (value.holdMaximum === null || validEndpoint(value.holdMaximum))
    && validEndpoint(value.last) && safeTime(value.keptAtMs) && Array.isArray(value.keptValues)
    && value.keptValues.length >= 1
    && value.keptValues.length <= QUOTA_CALIBRATION_POLICY.minimumBoundaries
    && value.keptValues.every(percent)
    && new Set(value.keptValues).size === value.keptValues.length
    && (value.pending === null || validEndpoint(value.pending));
}

/** The components a staged acquisition checkpoint is framed into. Declared
 * here because its validator is, and both sides name them. */
export const V11_QUOTA_WORK_COMPONENTS = [
  "plan-observations", "plan-runs", "plan-equal-time", "reset-clusters", "fit-stats", "eligible",
  "endpoint-runs", "endpoints",
] as const;
export type V11QuotaWorkComponent = typeof V11_QUOTA_WORK_COMPONENTS[number];

export function validateV11QuotaWorkPart(component: V11QuotaWorkComponent, value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  switch (component) {
    case "plan-observations": case "plan-equal-time":
      return value.length <= V11_PLAN_ANCHOR_LIMIT && value.every(validPlanAnchor);
    case "plan-runs":
      return value.length <= PLAN_ATTRIBUTION_POLICY.maxContexts && value.every((entry: unknown) =>
        Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string"
        && validPlanRun(entry[1]) && entry[0] === planGroup(entry[1].first));
    case "reset-clusters":
      return validQuotaResetClusterEntries(value)
        && value.every((entry: unknown) => validEraKey((entry as unknown[])[0]));
    case "fit-stats":
      return value.length <= PLAN_ATTRIBUTION_POLICY.maxEras && value.every((entry: unknown) =>
        Array.isArray(entry) && entry.length === 2 && validStatsKey(entry[0]) && validStats(entry[1]));
    case "eligible":
      return value.length <= V11_QUOTA_ENDPOINT_LIMIT && value.every(validEligibleKey);
    case "endpoint-runs":
      return value.length <= V11_QUOTA_ENDPOINT_LIMIT && value.every((entry: unknown) =>
        Array.isArray(entry) && entry.length === 2 && validEndpointKey(entry[0]) && validEndpointRun(entry[1])
        && entry[1].last.row.plan_era_key === JSON.parse(entry[0] as string)[0]
        && entry[1].last.row.slot === JSON.parse(entry[0] as string)[1]
        && entry[1].last.row.resets_at === JSON.parse(entry[0] as string)[2]);
    case "endpoints":
      return value.length <= V11_QUOTA_ENDPOINT_LIMIT && value.every(validEndpoint);
    default: return false;
  }
}
