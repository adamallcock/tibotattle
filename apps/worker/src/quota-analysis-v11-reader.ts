import {
  PLAN_ATTRIBUTION_POLICY,
  QUOTA_CALIBRATION_POLICY,
  buildPlanAttributionIndex,
  planAttributionContextKey,
  planEraForInterval,
} from "@app-usagemonitor/quota-analysis";
import type {
  PlanAttributionIndex,
  PlanAttributionObservation,
} from "@app-usagemonitor/quota-analysis";
import { TELEMETRY_PLAN_TYPES } from "@app-usagemonitor/telemetry-contract";
import {
  TYPED_V11_QUOTA_PAGE_SIZE,
  type V11QuotaPageCursor,
  type V11QuotaPageRow,
  type V11QuotaSourceRow,
} from "./typed-v11-quota-reader";

/** A private acquisition protocol. It is deliberately separate from the
 * public attribution adapter version: changing its page/checkpoint contract
 * must invalidate an in-flight acquisition without relabelling old evidence. */
export const V11_QUOTA_ACQUISITION_VERSION = "v11-quota-acquisition-1";
export const V11_QUOTA_ACQUISITION_PAGE_SIZE = TYPED_V11_QUOTA_PAGE_SIZE;
export const V11_PLAN_ANCHOR_LIMIT = 120_000;
export const V11_QUOTA_ENDPOINT_LIMIT = 60_000;
const SAFE_TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/u;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{8,128}$/u;
const ACCOUNT_TRACK = /^account-track:v2:[0-9a-f]{64}$/u;
const PLAN_ERA = /^plan-era:v1:[0-9a-f]{64}$/u;
const PLAN_TYPES = new Set<string>(TELEMETRY_PLAN_TYPES);
const SLOTS = new Set(["primary", "secondary", "five_hour", "seven_day", "other", "unknown"]);
const MIN_TIME = -8_640_000_000_000_000;
const MAX_TIME = 8_640_000_000_000_000;

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
  planBasis: V11QuotaSourceRow["planBasis"];
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
  plan_basis: V11QuotaSourceRow["planBasis"];
  slot: string;
  used_percent: number;
  window_duration_minutes: number;
  resets_at: string;
  plan_era_key: string;
}

export interface V11QuotaPageReader {
  readonly pageSize: typeof V11_QUOTA_ACQUISITION_PAGE_SIZE;
  readPage(cursor: V11QuotaPageCursor, limit: number): Promise<V11QuotaPageRow[]>;
}

export interface V11QuotaAcquisitionIdentity {
  participantId: string;
  inputFingerprint: string;
  sourceMethodVersion: string;
  observedAtCutoff: string;
  resetsAtCutoff: string;
  windowMinutes: number;
  maxQuotaRows: number;
}

interface PlanRun {
  first: V11PlanAnchor;
  last: V11PlanAnchor;
  signature: string;
}
const IDENTITY_FIELDS = ["participantId", "inputFingerprint", "sourceMethodVersion",
  "observedAtCutoff", "resetsAtCutoff", "windowMinutes", "maxQuotaRows"] as const;
interface FragmentStats {
  values: number[];
  minimum: number;
  maximum: number;
}
interface Endpoint {
  id: number;
  row: V11AcquiredQuotaRow;
}
interface EndpointRun {
  firstId: number;
  last: Endpoint;
}

export interface V11QuotaAcquisitionCheckpoint {
  version: typeof V11_QUOTA_ACQUISITION_VERSION;
  identity: V11QuotaAcquisitionIdentity;
  phase: "plan" | "fitability" | "endpoints";
  cursor: V11QuotaPageCursor;
  plan: {
    timeMs: number | null;
    equalTime: V11PlanAnchor[];
    runs: Array<[string, PlanRun]>;
    observations: V11PlanAnchor[];
  };
  stats: Array<[string, FragmentStats]>;
  eligible: string[];
  runs: Array<[string, EndpointRun]>;
  endpoints: Endpoint[];
}

export const V11_QUOTA_WORK_COMPONENTS = [
  "plan-observations", "plan-runs", "plan-equal-time", "fit-stats", "eligible",
  "endpoint-runs", "endpoints",
] as const;
export type V11QuotaWorkComponent = typeof V11_QUOTA_WORK_COMPONENTS[number];

export interface V11QuotaWorkControl {
  version: typeof V11_QUOTA_ACQUISITION_VERSION;
  phase: V11QuotaAcquisitionCheckpoint["phase"];
  cursor: V11QuotaPageCursor;
  planTimeMs: number | null;
}

export interface V11QuotaWorkComponents {
  "plan-observations": V11PlanAnchor[];
  "plan-runs": Array<[string, PlanRun]>;
  "plan-equal-time": V11PlanAnchor[];
  "fit-stats": Array<[string, FragmentStats]>;
  eligible: string[];
  "endpoint-runs": Array<[string, EndpointRun]>;
  endpoints: Endpoint[];
}

export interface V11CompletedQuotaAcquisition {
  identity: V11QuotaAcquisitionIdentity;
  planAnchors: V11PlanAnchor[];
  quotaRows: V11AcquiredQuotaRow[];
}

export type V11QuotaAcquisitionStep =
  | { status: "deferred"; checkpoint: V11QuotaAcquisitionCheckpoint }
  | ({ status: "complete"; attributionIndex: PlanAttributionIndex } & V11CompletedQuotaAcquisition)
  | { status: "not_testable"; reason: "plan_attribution_limit_exceeded" | "downsampled_quota_limit_exceeded" };

export interface V11QuotaInvocationBudget {
  remainingQueries: number;
  deadlineMs: number;
  now?: () => number;
}

function invalid(): never { throw new Error("v11 quota acquisition checkpoint invalid"); }
function textOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function numberOrder(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function instant(value: unknown): value is string {
  return typeof value === "string" && value.length <= 27 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}
function safeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= MIN_TIME && (value as number) <= MAX_TIME;
}
function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function percent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}
function boundedToken(value: unknown): value is string {
  return typeof value === "string" && SAFE_TOKEN.test(value);
}
function canonicalTuple(value: unknown, length: number, maximum = 1024): unknown[] | null {
  if (typeof value !== "string" || value.length > maximum) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === length && JSON.stringify(parsed) === value ? parsed : null;
  } catch { return null; }
}
function cursorValid(value: unknown): value is V11QuotaPageCursor {
  return closed(value, ["observedAtMs", "sourceRowId"])
    && safeTime(value.observedAtMs) && Number.isSafeInteger(value.sourceRowId)
    && (value.sourceRowId as number) >= 0;
}
function identityValid(identity: unknown): identity is V11QuotaAcquisitionIdentity {
  return closed(identity, ["participantId", "inputFingerprint", "sourceMethodVersion", "observedAtCutoff",
    "resetsAtCutoff", "windowMinutes", "maxQuotaRows"])
    && typeof identity.participantId === "string" && identity.participantId.length >= 1
    && identity.participantId.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(identity.participantId)
    && typeof identity.inputFingerprint === "string" && /^[a-f0-9]{64}$/u.test(identity.inputFingerprint)
    && typeof identity.sourceMethodVersion === "string" && identity.sourceMethodVersion.length >= 1
    && identity.sourceMethodVersion.length <= 256 && instant(identity.observedAtCutoff)
    && instant(identity.resetsAtCutoff) && Number.isSafeInteger(identity.windowMinutes)
    && (identity.windowMinutes as number) >= 1 && (identity.windowMinutes as number) <= 527_040
    && Number.isSafeInteger(identity.maxQuotaRows) && (identity.maxQuotaRows as number) >= 1
    && (identity.maxQuotaRows as number) <= V11_QUOTA_ENDPOINT_LIMIT;
}
export function validateV11QuotaAcquisitionIdentity(
  value: unknown,
): value is V11QuotaAcquisitionIdentity {
  return identityValid(value);
}
export function v11QuotaAcquisitionIdentityMatches(
  actual: unknown,
  expected: V11QuotaAcquisitionIdentity,
): actual is V11QuotaAcquisitionIdentity {
  return identityValid(actual) && IDENTITY_FIELDS.every((field) => actual[field] === expected[field]);
}
function accountScope(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && ACCOUNT_TRACK.test(value));
}
function validEraKey(value: unknown): value is string {
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
function validPlanAnchor(value: unknown): value is V11PlanAnchor {
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
function validQuotaRow(value: unknown): value is V11AcquiredQuotaRow {
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
function planSignature(row: V11PlanAnchor): string {
  return JSON.stringify([row.planType, row.planVariant, row.continuityId, row.planBasis]);
}
function planGroup(row: V11PlanAnchor): string {
  return JSON.stringify([row.contextKey, row.accountScopeId]);
}
function planSort(left: V11PlanAnchor, right: V11PlanAnchor): number {
  return textOrder(planGroup(left), planGroup(right)) || textOrder(planSignature(left), planSignature(right));
}
function samePlan(left: V11PlanAnchor, right: V11PlanAnchor): boolean {
  return planSignature(left) === planSignature(right);
}
function statsKey(reset: string, era: string): string { return JSON.stringify([reset, era]); }
function endpointKey(era: string, slot: string, reset: string): string {
  return JSON.stringify([era, slot, reset]);
}
function validStatsKey(value: unknown): value is string {
  const fields = canonicalTuple(value, 2);
  return !!fields && instant(fields[0]) && validEraKey(fields[1]);
}
function validEligibleKey(value: unknown): value is string {
  return validStatsKey(value);
}
function validEndpointKey(value: unknown): value is string {
  const fields = canonicalTuple(value, 3);
  return !!fields && validEraKey(fields[0]) && typeof fields[1] === "string"
    && SLOTS.has(fields[1]) && instant(fields[2]);
}
function validEndpoint(value: unknown): value is Endpoint {
  return closed(value, ["id", "row"]) && positiveId(value.id) && validQuotaRow(value.row);
}
function validPlanRun(value: unknown): value is PlanRun {
  return closed(value, ["first", "last", "signature"]) && validPlanAnchor(value.first)
    && validPlanAnchor(value.last) && typeof value.signature === "string"
    && value.signature === planSignature(value.first) && value.signature === planSignature(value.last)
    && value.first.contextKey === value.last.contextKey
    && value.first.accountScopeId === value.last.accountScopeId
    && value.first.observedAtMs <= value.last.observedAtMs;
}
function validStats(value: unknown): value is FragmentStats {
  return closed(value, ["values", "minimum", "maximum"]) && Array.isArray(value.values)
    && value.values.length >= 1 && value.values.length <= QUOTA_CALIBRATION_POLICY.minimumBoundaries
    && value.values.every(percent) && new Set(value.values).size === value.values.length
    && percent(value.minimum) && percent(value.maximum) && value.minimum <= value.maximum
    && value.values.every((number: number) => number >= (value.minimum as number)
      && number <= (value.maximum as number));
}
function validEndpointRun(value: unknown): value is EndpointRun {
  return closed(value, ["firstId", "last"]) && positiveId(value.firstId) && validEndpoint(value.last);
}

export function validateV11CompletedQuotaAcquisition(value: unknown): value is V11CompletedQuotaAcquisition {
  if (!closed(value, ["identity", "planAnchors", "quotaRows"]) || !identityValid(value.identity)
      || !Array.isArray(value.planAnchors)
      || value.planAnchors.length > V11_PLAN_ANCHOR_LIMIT || !value.planAnchors.every(validPlanAnchor)
      || !Array.isArray(value.quotaRows) || value.quotaRows.length > V11_QUOTA_ENDPOINT_LIMIT
      || !value.quotaRows.every(validQuotaRow)) return false;
  return new Set(value.quotaRows.map((row) => row.occurrence_id)).size === value.quotaRows.length;
}

export function validateV11QuotaWorkPart(component: V11QuotaWorkComponent, value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  switch (component) {
    case "plan-observations": case "plan-equal-time":
      return value.length <= V11_PLAN_ANCHOR_LIMIT && value.every(validPlanAnchor);
    case "plan-runs":
      return value.length <= PLAN_ATTRIBUTION_POLICY.maxContexts && value.every((entry: unknown) =>
        Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string"
        && validPlanRun(entry[1]) && entry[0] === planGroup(entry[1].first));
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

export function validateV11QuotaWorkControl(value: unknown): value is V11QuotaWorkControl {
  return closed(value, ["version", "phase", "cursor", "planTimeMs"])
    && value.version === V11_QUOTA_ACQUISITION_VERSION
    && ["plan", "fitability", "endpoints"].includes(value.phase as string)
    && cursorValid(value.cursor) && (value.planTimeMs === null || safeTime(value.planTimeMs));
}

function validateCheckpoint(state: V11QuotaAcquisitionCheckpoint, identity: V11QuotaAcquisitionIdentity): void {
  const sameIdentity = identityValid(identity) && identityValid(state.identity)
    && state.identity.participantId === identity.participantId
    && state.identity.inputFingerprint === identity.inputFingerprint
    && state.identity.sourceMethodVersion === identity.sourceMethodVersion
    && state.identity.observedAtCutoff === identity.observedAtCutoff
    && state.identity.resetsAtCutoff === identity.resetsAtCutoff
    && state.identity.windowMinutes === identity.windowMinutes
    && state.identity.maxQuotaRows === identity.maxQuotaRows;
  if (!sameIdentity
      || state.version !== V11_QUOTA_ACQUISITION_VERSION
      || !["plan", "fitability", "endpoints"].includes(state.phase)
      || !cursorValid(state.cursor) || !closed(state.plan, ["timeMs", "equalTime", "runs", "observations"])
      || (state.plan.timeMs !== null && !safeTime(state.plan.timeMs))
      || !Array.isArray(state.plan.equalTime) || !Array.isArray(state.plan.runs)
      || !Array.isArray(state.plan.observations) || !Array.isArray(state.stats)
      || !Array.isArray(state.eligible) || !Array.isArray(state.runs) || !Array.isArray(state.endpoints)
      || state.plan.observations.length > V11_PLAN_ANCHOR_LIMIT
      || state.plan.equalTime.length > V11_PLAN_ANCHOR_LIMIT
      || state.plan.runs.length > PLAN_ATTRIBUTION_POLICY.maxContexts
      || state.stats.length > PLAN_ATTRIBUTION_POLICY.maxEras
      || state.eligible.length > identity.maxQuotaRows || state.runs.length > identity.maxQuotaRows
      || state.endpoints.length > identity.maxQuotaRows
      || !validateV11QuotaWorkPart("plan-observations", state.plan.observations)
      || !validateV11QuotaWorkPart("plan-equal-time", state.plan.equalTime)
      || !validateV11QuotaWorkPart("plan-runs", state.plan.runs)
      || !validateV11QuotaWorkPart("fit-stats", state.stats)
      || !validateV11QuotaWorkPart("eligible", state.eligible)
      || !validateV11QuotaWorkPart("endpoint-runs", state.runs)
      || !validateV11QuotaWorkPart("endpoints", state.endpoints)) {
    invalid();
  }
  if (state.phase === "plan" && (state.stats.length > 0 || state.eligible.length > 0
      || state.runs.length > 0 || state.endpoints.length > 0)) invalid();
  if (state.phase === "fitability" && (state.plan.timeMs !== null || state.plan.equalTime.length > 0
      || state.plan.runs.length > 0 || state.eligible.length > 0 || state.runs.length > 0
      || state.endpoints.length > 0)) invalid();
  if (state.phase === "endpoints" && (state.plan.timeMs !== null || state.plan.equalTime.length > 0
      || state.plan.runs.length > 0 || state.stats.length > 0)) invalid();
  if (new Set(state.plan.observations.map((row) => JSON.stringify([
    row.contextKey, row.accountScopeId, row.observedAtMs, planSignature(row),
  ]))).size !== state.plan.observations.length) invalid();
  if (new Set(state.plan.runs.map(([key]) => key)).size !== state.plan.runs.length
      || new Set(state.stats.map(([key]) => key)).size !== state.stats.length
      || new Set(state.eligible).size !== state.eligible.length
      || new Set(state.runs.map(([key]) => key)).size !== state.runs.length
      || new Set(state.endpoints.map(({ id }) => id)).size !== state.endpoints.length) invalid();
  if (new Set(state.plan.equalTime.map((row) => JSON.stringify([planGroup(row), planSignature(row)]))).size
      !== state.plan.equalTime.length
      || (state.plan.equalTime.length > 0 && (state.plan.timeMs === null
        || state.plan.equalTime.some((row) => row.observedAtMs !== state.plan.timeMs)))) invalid();
}

export function createV11QuotaAcquisitionCheckpoint(
  identity: V11QuotaAcquisitionIdentity,
): V11QuotaAcquisitionCheckpoint {
  if (!identityValid(identity)) invalid();
  return {
    version: V11_QUOTA_ACQUISITION_VERSION, identity: { ...identity }, phase: "plan",
    cursor: { observedAtMs: Date.parse(identity.observedAtCutoff), sourceRowId: 0 },
    plan: { timeMs: null, equalTime: [], runs: [], observations: [] },
    stats: [], eligible: [], runs: [], endpoints: [],
  };
}

export function encodeV11QuotaWorkCheckpoint(state: V11QuotaAcquisitionCheckpoint): {
  control: V11QuotaWorkControl; components: V11QuotaWorkComponents;
} {
  return {
    control: { version: state.version, phase: state.phase, cursor: state.cursor, planTimeMs: state.plan.timeMs },
    components: {
      "plan-observations": state.plan.observations,
      "plan-runs": state.plan.runs,
      "plan-equal-time": state.plan.equalTime,
      "fit-stats": state.stats,
      eligible: state.eligible,
      "endpoint-runs": state.runs,
      endpoints: state.endpoints,
    },
  };
}

export function decodeV11QuotaWorkCheckpoint(identity: V11QuotaAcquisitionIdentity, control: unknown,
  components: unknown): V11QuotaAcquisitionCheckpoint {
  const badComponents = closed(components, V11_QUOTA_WORK_COMPONENTS)
    ? V11_QUOTA_WORK_COMPONENTS.filter((component) => !validateV11QuotaWorkPart(component, components[component]))
    : [...V11_QUOTA_WORK_COMPONENTS];
  if (!identityValid(identity) || !validateV11QuotaWorkControl(control) || badComponents.length > 0) {
    invalid();
  }
  const values = components as unknown as V11QuotaWorkComponents;
  const state: V11QuotaAcquisitionCheckpoint = {
    version: control.version, identity: { ...identity }, phase: control.phase, cursor: control.cursor,
    plan: { timeMs: control.planTimeMs, equalTime: values["plan-equal-time"],
      runs: values["plan-runs"], observations: values["plan-observations"] },
    stats: values["fit-stats"], eligible: values.eligible,
    runs: values["endpoint-runs"], endpoints: values.endpoints,
  };
  validateCheckpoint(state, identity);
  return state;
}

export function createV11QuotaWorkInterner() {
  const strings = new Map<string, string>();
  const endpoints = new Map<number, Endpoint>();
  const internText = (value: string): string => {
    const prior = strings.get(value);
    if (prior !== undefined) return prior;
    strings.set(value, value);
    return value;
  };
  const internAnchor = (value: V11PlanAnchor): void => {
    value.contextKey = internText(value.contextKey);
    value.planVariant = internText(value.planVariant);
    if (value.planType !== null) value.planType = internText(value.planType);
    if (value.continuityId !== null) value.continuityId = internText(value.continuityId);
    if (value.accountScopeId !== null) value.accountScopeId = internText(value.accountScopeId);
  };
  const endpoint = (value: Endpoint): Endpoint => {
    const prior = endpoints.get(value.id);
    if (prior) {
      if (JSON.stringify(prior.row) !== JSON.stringify(value.row)) invalid();
      return prior;
    }
    value.row.occurrence_id = internText(value.row.occurrence_id);
    value.row.observed_at = internText(value.row.observed_at);
    value.row.provider = internText(value.row.provider);
    value.row.plan_type = internText(value.row.plan_type);
    value.row.plan_variant = internText(value.row.plan_variant);
    value.row.resets_at = internText(value.row.resets_at);
    value.row.plan_era_key = internText(value.row.plan_era_key);
    endpoints.set(value.id, value);
    return value;
  };
  return {
    internText,
    internPart(component: V11QuotaWorkComponent, value: unknown): void {
      if (!validateV11QuotaWorkPart(component, value)) invalid();
      switch (component) {
        case "plan-observations": case "plan-equal-time":
          (value as V11PlanAnchor[]).forEach(internAnchor); break;
        case "plan-runs":
          for (const [, run] of value as Array<[string, PlanRun]>) { internAnchor(run.first); internAnchor(run.last); }
          break;
        case "fit-stats": case "eligible": break;
        case "endpoint-runs":
          for (const entry of value as Array<[string, EndpointRun]>) entry[1].last = endpoint(entry[1].last);
          break;
        case "endpoints": {
          const rows = value as Endpoint[];
          for (let index = 0; index < rows.length; index += 1) rows[index] = endpoint(rows[index]!);
          break;
        }
      }
    },
    releaseRows() { endpoints.clear(); },
    release() { strings.clear(); endpoints.clear(); },
  };
}

function sourceAnchor(row: V11QuotaSourceRow): V11PlanAnchor | null {
  if (row.provider === null || row.limitId !== "codex" || !SAFE_TOKEN.test(row.provider)) return null;
  const accountScopeId = row.accountBasis === "same_source" ? row.accountTrackId : null;
  if (accountScopeId !== null && !ACCOUNT_TRACK.test(accountScopeId)) return null;
  return {
    contextKey: planAttributionContextKey(row.provider, row.limitId), observedAtMs: row.observedAtMs,
    planType: row.planType, planVariant: row.planVariant ?? "unknown", continuityId: row.planEraId,
    conflicted: row.planBasis === "conflicted", accountScopeId, planBasis: row.planBasis,
  };
}
function acquiredRow(row: V11QuotaSourceRow, eraKey: string): V11AcquiredQuotaRow | null {
  if (row.provider === null || row.limitId !== "codex" || row.planType === null || row.planVariant === null
      || row.slot === null || row.usedPercent === null || row.windowDurationMinutes === null
      || row.resetsAt === null || !SAFE_TOKEN.test(row.provider) || !PLAN_TYPES.has(row.planType)
      || !SAFE_TOKEN.test(row.planVariant) || !SLOTS.has(row.slot) || !percent(row.usedPercent)
      || !Number.isSafeInteger(row.windowDurationMinutes) || Date.parse(row.resetsAt) <= row.observedAtMs
      || !validEraKey(eraKey)) return null;
  const accountScopeId = row.accountBasis === "same_source" ? row.accountTrackId : null;
  if (accountScopeId !== null && !ACCOUNT_TRACK.test(accountScopeId)) return null;
  return {
    occurrence_id: row.occurrenceId, observed_at: row.observedAt, provider: row.provider,
    account_scope_id: accountScopeId, limit_id: row.limitId, plan_type: row.planType,
    plan_variant: row.planVariant, continuity_id: row.planEraId, plan_basis: row.planBasis,
    slot: row.slot, used_percent: row.usedPercent, window_duration_minutes: row.windowDurationMinutes,
    resets_at: row.resetsAt, plan_era_key: eraKey,
  };
}

function initialCursor(identity: V11QuotaAcquisitionIdentity): V11QuotaPageCursor {
  return { observedAtMs: Date.parse(identity.observedAtCutoff), sourceRowId: 0 };
}
function refusal(reason: "plan_attribution_limit_exceeded" | "downsampled_quota_limit_exceeded"): V11QuotaAcquisitionStep {
  return { status: "not_testable", reason };
}

/** Advance only complete physical pages. The page cursor moves across every
 * owner row, including retired/non-quota rows; eligibility is residual JS
 * filtering. This is what prevents a dense irrelevant prefix from looking like
 * EOF and keeps a resume replayable after a deadline.
 *
 * `stopAtPhaseBoundary` ends the group on each deterministic sub-phase
 * boundary, returning exactly the successor the budget would have produced one
 * iteration later. Callers that stage a partial group use it so a single group
 * cannot carry a whole sub-phase's accumulated state into the next one: a
 * boundary successor is compact, while a successor cut in the middle of the
 * fitability or endpoints sub-phase can reach hundreds of parts. */
export async function advanceV11QuotaAcquisition(
  reader: V11QuotaPageReader,
  identity: V11QuotaAcquisitionIdentity,
  budget: V11QuotaInvocationBudget,
  state: V11QuotaAcquisitionCheckpoint = createV11QuotaAcquisitionCheckpoint(identity),
  options: { maxPages?: number; stopAtPhaseBoundary?: boolean } = {},
): Promise<V11QuotaAcquisitionStep> {
  if (reader.pageSize !== V11_QUOTA_ACQUISITION_PAGE_SIZE) throw new Error("v11 quota reader page policy invalid");
  validateCheckpoint(state, identity);
  if (!Number.isSafeInteger(budget.remainingQueries) || budget.remainingQueries < 0
      || !Number.isFinite(budget.deadlineMs)) throw new Error("v11 quota acquisition budget invalid");
  if (options.maxPages !== undefined && (!Number.isSafeInteger(options.maxPages) || options.maxPages < 1)) {
    throw new Error("v11 quota acquisition page bound invalid");
  }
  if (options.stopAtPhaseBoundary !== undefined && typeof options.stopAtPhaseBoundary !== "boolean") {
    throw new Error("v11 quota acquisition page bound invalid");
  }
  const now = budget.now ?? Date.now;
  if (budget.remainingQueries === 0 || now() >= budget.deadlineMs) return { status: "deferred", checkpoint: state };

  const planRuns = new Map(state.plan.runs);
  const equalTime = new Map(state.plan.equalTime.map((row) => [
    JSON.stringify([planGroup(row), planSignature(row)]), row,
  ]));
  const stats = new Map(state.stats);
  const eligible = new Set(state.eligible);
  const endpointRuns = new Map<string, EndpointRun>(state.runs);
  state.plan.runs = [];
  state.runs = [];
  let index: PlanAttributionIndex | null = state.phase === "plan"
    ? null : buildPlanAttributionIndex(state.plan.observations);
  if (index?.status !== undefined && index.status !== "ready") return refusal("plan_attribution_limit_exceeded");

  const appendPlan = (anchor: V11PlanAnchor): boolean => {
    const group = planGroup(anchor);
    const signature = planSignature(anchor);
    const run = planRuns.get(group);
    if (!run || run.signature !== signature) {
      if (run && run.last.observedAtMs !== run.first.observedAtMs) state.plan.observations.push(run.last);
      if (state.plan.observations.length >= V11_PLAN_ANCHOR_LIMIT) return false;
      state.plan.observations.push(anchor);
      planRuns.set(group, { first: anchor, last: anchor, signature });
    } else {
      run.last = anchor;
    }
    return state.plan.observations.length <= V11_PLAN_ANCHOR_LIMIT;
  };
  const flushPlanTime = (): boolean => {
    const ordered = [...equalTime.values()].sort(planSort);
    for (const anchor of ordered) if (!appendPlan(anchor)) return false;
    equalTime.clear();
    return true;
  };
  const finishPlan = (): boolean => {
    if (!flushPlanTime()) return false;
    for (const run of planRuns.values()) {
      if (run.last.observedAtMs !== run.first.observedAtMs) state.plan.observations.push(run.last);
      if (state.plan.observations.length > V11_PLAN_ANCHOR_LIMIT) return false;
    }
    state.plan.observations.sort((left, right) => left.observedAtMs - right.observedAtMs
      || textOrder(planGroup(left), planGroup(right)) || textOrder(planSignature(left), planSignature(right)));
    return true;
  };
  const finishStats = (): boolean => {
    for (const [key, stat] of stats) {
      if (stat.values.length >= QUOTA_CALIBRATION_POLICY.minimumBoundaries
          && stat.maximum - stat.minimum >= QUOTA_CALIBRATION_POLICY.minimumDisplayedSpanPp) {
        eligible.add(key);
        if (eligible.size * QUOTA_CALIBRATION_POLICY.minimumBoundaries > identity.maxQuotaRows) return false;
      }
    }
    stats.clear();
    return true;
  };
  const finishRuns = (): boolean => {
    for (const run of endpointRuns.values()) {
      if (run.last.id !== run.firstId) state.endpoints.push(run.last);
      if (state.endpoints.length > identity.maxQuotaRows) return false;
    }
    endpointRuns.clear();
    return true;
  };
  const defer = (): V11QuotaAcquisitionStep => {
    state.plan.runs = [...planRuns];
    state.plan.equalTime = [...equalTime.values()];
    state.stats = [...stats];
    state.eligible = [...eligible];
    state.runs = [...endpointRuns];
    return { status: "deferred", checkpoint: state };
  };

  let pages = 0;
  while (budget.remainingQueries > 0 && pages < (options.maxPages ?? Infinity) && now() < budget.deadlineMs) {
    budget.remainingQueries -= 1;
    pages += 1;
    const rows = await reader.readPage(state.cursor, reader.pageSize);
    if (rows.length > reader.pageSize) throw new Error("v11 quota acquisition page overflow");
    let previous = state.cursor;
    for (const pageRow of rows) {
      if (!positiveId(pageRow.physicalId) || !positiveId(pageRow.sourceRowId)
          || !safeTime(pageRow.observedAtMs) || pageRow.observedAtMs < previous.observedAtMs
          || pageRow.observedAtMs === previous.observedAtMs && pageRow.sourceRowId <= previous.sourceRowId) {
        throw new Error("v11 quota acquisition page order invalid");
      }
      if (pageRow.active !== null && (pageRow.active.id !== pageRow.sourceRowId
          || pageRow.active.observedAtMs !== pageRow.observedAtMs)) {
        throw new Error("v11 quota acquisition membership conflict");
      }
      previous = { observedAtMs: pageRow.observedAtMs, sourceRowId: pageRow.sourceRowId };
      const active = pageRow.active;
      if (active === null) continue;
      if (state.phase === "plan") {
        const anchor = sourceAnchor(active);
        if (anchor === null) continue;
        if (state.plan.timeMs !== null && state.plan.timeMs !== anchor.observedAtMs
            && !flushPlanTime()) return refusal("plan_attribution_limit_exceeded");
        state.plan.timeMs = anchor.observedAtMs;
        equalTime.set(JSON.stringify([planGroup(anchor), planSignature(anchor)]), anchor);
        if (state.plan.observations.length + equalTime.size > V11_PLAN_ANCHOR_LIMIT) {
          return refusal("plan_attribution_limit_exceeded");
        }
        continue;
      }
      if (active.observedAtMs < Date.parse(identity.observedAtCutoff)
          || active.resetsAt === null || Date.parse(active.resetsAt) < Date.parse(identity.resetsAtCutoff)
          || active.windowDurationMinutes !== identity.windowMinutes || active.usedPercent === null) continue;
      if (index === null) throw new Error("v11 quota attribution index missing");
      const accountScopeId = active.accountBasis === "same_source" ? active.accountTrackId : null;
      const provider = active.provider;
      if (provider === null || active.limitId !== "codex" || !SAFE_TOKEN.test(provider)
          || (accountScopeId !== null && !ACCOUNT_TRACK.test(accountScopeId))) continue;
      const match = planEraForInterval(index, {
        contextKey: planAttributionContextKey(provider, active.limitId), accountScopeId,
        observedAtMs: active.observedAtMs,
      });
      if (match.status !== "matched" || active.planType !== match.era.planType
          || active.planVariant !== match.era.planVariant) continue;
      const eraKey = match.era.eraKey;
      if (state.phase === "fitability") {
        const key = statsKey(active.resetsAt, eraKey);
        let stat = stats.get(key);
        if (!stat) {
          stat = { values: [], minimum: active.usedPercent, maximum: active.usedPercent };
          stats.set(key, stat);
        }
        stat.minimum = Math.min(stat.minimum, active.usedPercent);
        stat.maximum = Math.max(stat.maximum, active.usedPercent);
        if (stat.values.length < QUOTA_CALIBRATION_POLICY.minimumBoundaries
            && !stat.values.includes(active.usedPercent)) stat.values.push(active.usedPercent);
        continue;
      }
      const key = statsKey(active.resetsAt, eraKey);
      if (!eligible.has(key)) continue;
      if (active.slot === null || !SLOTS.has(active.slot)) continue;
      const output = acquiredRow(active, eraKey);
      if (output === null) continue;
      const endpoint: Endpoint = { id: pageRow.sourceRowId, row: output };
      const runKey = endpointKey(eraKey, output.slot, output.resets_at);
      const run = endpointRuns.get(runKey);
      if (!run) {
        state.endpoints.push(endpoint);
        if (state.endpoints.length > identity.maxQuotaRows) return refusal("downsampled_quota_limit_exceeded");
        endpointRuns.set(runKey, { firstId: endpoint.id, last: endpoint });
      } else if (run.last.row.used_percent === output.used_percent) {
        run.last = endpoint;
      } else {
        if (run.last.id !== run.firstId) state.endpoints.push(run.last);
        state.endpoints.push(endpoint);
        if (state.endpoints.length > identity.maxQuotaRows) return refusal("downsampled_quota_limit_exceeded");
        endpointRuns.set(runKey, { firstId: endpoint.id, last: endpoint });
      }
    }
    state.cursor = previous;
    if (rows.length === reader.pageSize) continue;
    if (state.phase === "plan") {
      if (!finishPlan()) return refusal("plan_attribution_limit_exceeded");
      index = buildPlanAttributionIndex(state.plan.observations);
      if (index.status !== "ready") return refusal("plan_attribution_limit_exceeded");
      state.phase = "fitability";
      state.plan.timeMs = null;
      state.plan.equalTime = [];
      state.plan.runs = [];
      planRuns.clear();
      state.cursor = initialCursor(identity);
      if (options.stopAtPhaseBoundary) return defer();
      continue;
    }
    if (state.phase === "fitability") {
      if (!finishStats()) return refusal("downsampled_quota_limit_exceeded");
      state.phase = "endpoints";
      state.cursor = initialCursor(identity);
      if (options.stopAtPhaseBoundary) return defer();
      continue;
    }
    if (!finishRuns()) return refusal("downsampled_quota_limit_exceeded");
    state.endpoints.sort((left, right) => numberOrder(Date.parse(left.row.observed_at), Date.parse(right.row.observed_at))
      || left.id - right.id);
    return { status: "complete", attributionIndex: index!, identity: { ...identity },
      planAnchors: state.plan.observations,
      quotaRows: state.endpoints.map(({ row }) => row) };
  }
  return defer();
}

/** One query and one whole physical page, useful to stage/checkpoint each
 * deterministic step. A zero-query deadline deferral has no replay receipt. */
export async function advanceV11QuotaAcquisitionPage(
  reader: V11QuotaPageReader, identity: V11QuotaAcquisitionIdentity, budget: V11QuotaInvocationBudget,
  state: V11QuotaAcquisitionCheckpoint = createV11QuotaAcquisitionCheckpoint(identity),
): Promise<{ result: V11QuotaAcquisitionStep; checkpoint: V11QuotaAcquisitionCheckpoint | null }> {
  const before = budget.remainingQueries;
  const result = await advanceV11QuotaAcquisition(reader, identity, budget, state, { maxPages: 1 });
  return { result, checkpoint: before === budget.remainingQueries || result.status === "not_testable" ? null : state };
}
