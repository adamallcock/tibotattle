import {
  PLAN_ATTRIBUTION_POLICY,
  QUOTA_CALIBRATION_POLICY,
  buildPlanAttributionIndex,
  planEraForInterval,
} from "@app-usagemonitor/quota-analysis";
import type { PlanAttributionIndex } from "@app-usagemonitor/quota-analysis";
import { TELEMETRY_PLAN_TYPES } from "@app-usagemonitor/telemetry-contract";

/** Internal server acquisition state; never a public DTO or a completed fit. */
export const V1_QUOTA_ACQUISITION_VERSION = "v1-quota-acquisition-1";
export const V1_QUOTA_ACQUISITION_PAGE_SIZE = 1_024;
export const V1_PLAN_ANCHOR_LIMIT = 120_000;
export const V1_QUOTA_ENDPOINT_LIMIT = 60_000;
const SAFE_TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/u;
const SOURCE_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/u;
const PLAN_TYPES = new Set<string>(TELEMETRY_PLAN_TYPES);

export interface V1PlanSourceRow {
  id: number;
  observed_at: string;
  observed_day: string;
  device_id: string;
  provider: string | null;
  limit_id: string | null;
  plan_type: string | null;
  plan_variant: string | null;
}

export interface V1FitSourceRow extends V1PlanSourceRow {
  occurrence_id: string;
  provider: string;
  limit_id: string;
  plan_type: string;
  plan_variant: string;
  slot: string;
  used_percent: number;
  window_duration_minutes: number;
  resets_at: string;
}

export interface V1AcquiredQuotaRow {
  occurrence_id: string;
  observed_at: string;
  provider: string;
  plan_type: string;
  plan_variant: string;
  limit_id: string;
  slot: string;
  used_percent: number;
  window_duration_minutes: number;
  resets_at: string;
  plan_era_key: string;
}

export interface V1TimeCursor { observedAt: string; id: number }
export interface V1ResetCursor extends V1TimeCursor { resetsAt: string }

/** Each callback performs ONE bounded query, BEFORE residual winner filtering.
 * Plan order is (observed_at,id); fit order is (resets_at,observed_at,id).
 * Adapters must not hide additional queries or unbounded filtered-prefix scans.
 */
export interface V1QuotaPageReader {
  /** A distinct, persisted prepared-reader policy uses smaller bounded fanout
   * pages. Absence is the immutable legacy 1024-row physical protocol. */
  readonly pageSize?: 128;
  readPlanPage(cursor: V1TimeCursor, limit: number): Promise<V1PlanSourceRow[]>;
  readFitPage(cursor: V1ResetCursor, limit: number): Promise<V1FitSourceRow[]>;
}

/** Shared by the entire invocation, not freshly allocated for each account.
 * Source-pin reads, checkpoint writes and finalization need a separate reserve
 * charged by the caller. The reader never spends that reserved allowance.
 */
export interface V1QuotaInvocationBudget {
  remainingQueries: number;
  deadlineMs: number;
  now?: () => number;
}

export interface V1QuotaAcquisitionIdentity {
  participantId: string;
  inputFingerprint: string;
  sourceMethodVersion: string;
  observedAtCutoff: string;
  resetsAtCutoff: string;
  windowMinutes: number;
  maxQuotaRows: number;
}

export interface V1PlanAnchor {
  sourceContext: string;
  contextKey: string;
  observedAtMs: number;
  planType: string;
  planVariant: string;
  accountScopeId: null;
}
type PlanAnchor = V1PlanAnchor;
interface PlanRun { first: PlanAnchor; last: PlanAnchor }
interface FragmentStats { values: number[]; minimum: number; maximum: number }
interface Endpoint { id: number; row: V1AcquiredQuotaRow }
interface EndpointRun { firstId: number; last: Endpoint }
type EndpointRunEntry = [eraKey: string, slot: string, run: EndpointRun];

/** Persist only under the matching participant revision/fingerprint fence.
 * Large checkpoints must be integrity-bound parts, not one oversized D1 row.
 * Retry from the last DURABLE checkpoint: advance consumes its input object.
 * Plan anchors are retained instead of serializing the package's opaque index.
 */
export interface V1QuotaAcquisitionCheckpoint {
  version: typeof V1_QUOTA_ACQUISITION_VERSION;
  identity: V1QuotaAcquisitionIdentity;
  phase: "plan" | "fitability" | "endpoints";
  cursor: V1ResetCursor;
  plan: {
    time: string | null;
    equalTime: PlanAnchor[];
    runs: Array<[string, PlanRun]>;
    anchors: PlanAnchor[];
  };
  reset: string | null;
  stats: Array<[string, FragmentStats]>;
  eligible: string[];
  runs: EndpointRunEntry[];
  endpoints: Endpoint[];
}

export const V1_QUOTA_WORK_COMPONENTS = ["plan-anchors", "plan-runs", "plan-equal-time",
  "fit-stats", "eligible", "endpoint-runs", "endpoints"] as const;
export type V1QuotaWorkComponent = typeof V1_QUOTA_WORK_COMPONENTS[number];
export interface V1QuotaWorkControl {
  version: typeof V1_QUOTA_ACQUISITION_VERSION;
  phase: V1QuotaAcquisitionCheckpoint["phase"];
  cursor: V1ResetCursor;
  planTime: string | null;
  reset: string | null;
}
export interface V1QuotaWorkComponents {
  "plan-anchors": PlanAnchor[];
  "plan-runs": Array<[string, PlanRun]>;
  "plan-equal-time": PlanAnchor[];
  "fit-stats": Array<[string, FragmentStats]>;
  eligible: string[];
  "endpoint-runs": EndpointRunEntry[];
  endpoints: Endpoint[];
}

/** Persistable completed input, not a fit or a source-authority receipt. */
export interface V1CompletedQuotaAcquisition {
  planAnchors: V1PlanAnchor[];
  quotaRows: V1AcquiredQuotaRow[];
}
export type V1QuotaAcquisitionStep =
  | { status: "deferred"; checkpoint: V1QuotaAcquisitionCheckpoint }
  | ({ status: "complete"; attributionIndex: PlanAttributionIndex } & V1CompletedQuotaAcquisition)
  | { status: "not_testable"; reason: "plan_attribution_limit_exceeded" | "downsampled_quota_limit_exceeded" };

export type V1QuotaPageReplay = {
  from: { phase: V1QuotaAcquisitionCheckpoint["phase"]; cursor: V1ResetCursor };
  through: { phase: V1QuotaAcquisitionCheckpoint["phase"] | "complete"; cursor: V1ResetCursor };
  sourceQueryCount: 1;
  resolution: "resolved";
} & ({ version: "v1-quota-page-replay-1" } | {
  version: "v1-quota-page-replay-2"; readerPolicy: "prepared-source-days-1"; pageSize: 128;
});

function textOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function planOrder(left: PlanAnchor, right: PlanAnchor): number {
  return textOrder(left.sourceContext, right.sourceContext) || left.observedAtMs - right.observedAtMs
    || textOrder(left.planType, right.planType) || textOrder(left.planVariant, right.planVariant);
}
function sameAnchor(left: PlanAnchor, right: PlanAnchor): boolean {
  return planOrder(left, right) === 0;
}
function initialCursor(identity: V1QuotaAcquisitionIdentity): V1ResetCursor {
  return { resetsAt: identity.resetsAtCutoff, observedAt: "", id: 0 };
}
function fail(reason: "plan_attribution_limit_exceeded" | "downsampled_quota_limit_exceeded"): V1QuotaAcquisitionStep {
  return { status: "not_testable", reason };
}
function invalid(): never { throw new Error("v1 quota acquisition checkpoint invalid"); }

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function instant(value: unknown): value is string {
  return typeof value === "string" && value.length <= 27 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}
function token(value: unknown): value is string { return typeof value === "string" && SOURCE_TOKEN.test(value); }
function percent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}
function positiveId(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function validAnchor(value: unknown): value is PlanAnchor {
  if (!closed(value, ["sourceContext", "contextKey", "observedAtMs", "planType", "planVariant", "accountScopeId"])) return false;
  const context = canonicalTuple(value.sourceContext, 2);
  if (!context || (context[0] !== null && !token(context[0])) || context[1] !== "codex") return false;
  const expectedContext = typeof context[0] === "string" && SAFE_TOKEN.test(context[0]) ? `${context[0]}|codex` : "";
  return value.contextKey === expectedContext && Number.isSafeInteger(value.observedAtMs)
    && Math.abs(value.observedAtMs as number) <= 8_640_000_000_000_000
    && typeof value.planType === "string" && PLAN_TYPES.has(value.planType)
    && token(value.planVariant) && value.accountScopeId === null;
}
function canonicalTuple(value: unknown, length: number, maximum = 512): unknown[] | null {
  if (typeof value !== "string" || value.length > maximum) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === length && JSON.stringify(parsed) === value ? parsed : null;
  } catch { return null; }
}
function validEraKey(value: unknown): value is string {
  const fields = canonicalTuple(value, 5);
  if (!fields || typeof fields[0] !== "string") return false;
  const context = fields[0].split("|");
  return context.length === 2 && token(context[0]) && context[1] === "codex" && fields[1] === null
    && typeof fields[2] === "string" && PLAN_TYPES.has(fields[2]) && token(fields[3])
    && Number.isSafeInteger(fields[4]) && Math.abs(fields[4] as number) <= 8_640_000_000_000_000;
}
function validEndpoint(value: unknown): value is Endpoint {
  if (!closed(value, ["id", "row"]) || !positiveId(value.id)) return false;
  return validQuotaRow(value.row);
}
function validQuotaRow(row: unknown): row is V1AcquiredQuotaRow {
  return closed(row, ["occurrence_id", "observed_at", "provider", "plan_type", "plan_variant", "limit_id",
    "slot", "used_percent", "window_duration_minutes", "resets_at", "plan_era_key"])
    && typeof row.occurrence_id === "string" && /^[A-Za-z0-9._:-]{8,128}$/u.test(row.occurrence_id)
    && instant(row.observed_at) && token(row.provider) && row.limit_id === "codex"
    && typeof row.plan_type === "string" && PLAN_TYPES.has(row.plan_type) && token(row.plan_variant)
    && token(row.slot) && percent(row.used_percent) && Number.isSafeInteger(row.window_duration_minutes)
    && (row.window_duration_minutes as number) >= 1 && (row.window_duration_minutes as number) <= 527_040
    && instant(row.resets_at) && validEraKey(row.plan_era_key);
}

/** Shape validation only, never evidence of source currency or authority. */
export function validateV1CompletedQuotaAcquisition(value: unknown): value is V1CompletedQuotaAcquisition {
  return closed(value, ["planAnchors", "quotaRows"]) && Array.isArray(value.planAnchors)
    && value.planAnchors.length <= V1_PLAN_ANCHOR_LIMIT && value.planAnchors.every(validAnchor)
    && Array.isArray(value.quotaRows) && value.quotaRows.length <= V1_QUOTA_ENDPOINT_LIMIT
    && value.quotaRows.every(validQuotaRow);
}
function pair(value: unknown): value is [string, unknown] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string";
}

/** Closed inner schema only. The checkpoint store additionally enforces its
 * UTF-8 byte bound per part, manifest hashes, part counts and source fence.
 * The decoder below enforces cross-part counts and unique map keys.
 */
export function validateV1QuotaWorkPart(component: V1QuotaWorkComponent, value: unknown): boolean {
  if (!Array.isArray(value) || value.length > V1_PLAN_ANCHOR_LIMIT) return false;
  switch (component) {
    case "plan-anchors": case "plan-equal-time": return value.every(validAnchor);
    case "plan-runs": return value.every((entry: unknown) => pair(entry)
      && closed(entry[1], ["first", "last"]) && validAnchor(entry[1].first) && validAnchor(entry[1].last)
      && entry[0] === entry[1].first.sourceContext && entry[1].first.sourceContext === entry[1].last.sourceContext
      && entry[1].first.planType === entry[1].last.planType && entry[1].first.planVariant === entry[1].last.planVariant
      && entry[1].first.observedAtMs <= entry[1].last.observedAtMs);
    case "fit-stats": return value.every((entry: unknown) => pair(entry) && validEraKey(entry[0])
      && closed(entry[1], ["values", "minimum", "maximum"]) && Array.isArray(entry[1].values)
      && entry[1].values.length >= 1 && entry[1].values.length <= QUOTA_CALIBRATION_POLICY.minimumBoundaries
      && entry[1].values.every(percent) && new Set(entry[1].values).size === entry[1].values.length
      && percent(entry[1].minimum) && percent(entry[1].maximum) && entry[1].minimum <= entry[1].maximum
      && entry[1].values.every((number: number) => number >= (entry[1] as FragmentStats).minimum
        && number <= (entry[1] as FragmentStats).maximum));
    case "eligible": return value.every((entry: unknown) => {
      const fields = canonicalTuple(entry, 2, 1024);
      return fields !== null && instant(fields[0]) && validEraKey(fields[1]);
    });
    case "endpoint-runs": return value.every((entry: unknown) => Array.isArray(entry) && entry.length === 3
      && validEraKey(entry[0]) && token(entry[1]) && closed(entry[2], ["firstId", "last"])
      && positiveId(entry[2].firstId) && validEndpoint(entry[2].last)
      && entry[0] === entry[2].last.row.plan_era_key && entry[1] === entry[2].last.row.slot);
    case "endpoints": return value.every(validEndpoint);
    default: return false;
  }
}

export function validateV1QuotaWorkControl(value: unknown): value is V1QuotaWorkControl {
  return closed(value, ["version", "phase", "cursor", "planTime", "reset"])
    && value.version === V1_QUOTA_ACQUISITION_VERSION && ["plan", "fitability", "endpoints"].includes(value.phase as string)
    && closed(value.cursor, ["resetsAt", "observedAt", "id"]) && instant(value.cursor.resetsAt)
    && (value.cursor.observedAt === "" || instant(value.cursor.observedAt))
    && Number.isSafeInteger(value.cursor.id) && (value.cursor.id as number) >= 0
    && (value.planTime === null || instant(value.planTime)) && (value.reset === null || instant(value.reset));
}

export function validateV1QuotaPageReplay(value: unknown): value is V1QuotaPageReplay {
  const point = (candidate: unknown, complete: boolean): boolean => closed(candidate, ["phase", "cursor"])
    && (complete && candidate.phase === "complete" || ["plan", "fitability", "endpoints"].includes(candidate.phase as string))
    && closed(candidate.cursor, ["resetsAt", "observedAt", "id"]) && instant(candidate.cursor.resetsAt)
    && (candidate.cursor.observedAt === "" || instant(candidate.cursor.observedAt))
    && Number.isSafeInteger(candidate.cursor.id) && (candidate.cursor.id as number) >= 0;
  return (closed(value, ["version", "from", "through", "sourceQueryCount", "resolution"])
      && value.version === "v1-quota-page-replay-1"
    || closed(value, ["version", "from", "through", "sourceQueryCount", "resolution", "readerPolicy", "pageSize"])
      && value.version === "v1-quota-page-replay-2" && value.readerPolicy === "prepared-source-days-1" && value.pageSize === 128)
    && value.sourceQueryCount === 1 && value.resolution === "resolved"
    && point(value.from, false) && point(value.through, true);
}

/** Share one interner while loading bounded parts of ONE work item, then
 * release it. Never accumulate undecoded JSON parts first: repeated maximum-
 * length metadata and duplicate endpoint/run rows otherwise dominate memory.
 * No values are omitted or changed; equal record IDs with different rows fail.
 */
export function createV1QuotaWorkInterner() {
  const strings = new Map<string, string>();
  const endpoints = new Map<number, Endpoint>();
  const internText = (value: string): string => {
    const prior = strings.get(value);
    if (prior !== undefined) return prior;
    strings.set(value, value);
    return value;
  };
  const anchor = (value: PlanAnchor): void => {
    value.sourceContext = internText(value.sourceContext);
    value.contextKey = internText(value.contextKey);
    value.planType = internText(value.planType);
    value.planVariant = internText(value.planVariant);
  };
  const endpoint = (value: Endpoint): Endpoint => {
    const prior = endpoints.get(value.id);
    if (prior) {
      if ((Object.keys(prior.row) as Array<keyof V1AcquiredQuotaRow>).some((key) => prior.row[key] !== value.row[key])) invalid();
      return prior;
    }
    value.row.provider = internText(value.row.provider);
    value.row.plan_type = internText(value.row.plan_type);
    value.row.plan_variant = internText(value.row.plan_variant);
    value.row.plan_era_key = internText(value.row.plan_era_key);
    endpoints.set(value.id, value);
    return value;
  };
  return {
    internText,
    internPart(component: V1QuotaWorkComponent, value: unknown): void {
      if (!validateV1QuotaWorkPart(component, value)) invalid();
      switch (component) {
        case "plan-anchors": case "plan-equal-time": (value as PlanAnchor[]).forEach(anchor); break;
        case "plan-runs": for (const [, run] of value as Array<[string, PlanRun]>) { anchor(run.first); anchor(run.last); } break;
        case "fit-stats": for (const entry of value as Array<[string, FragmentStats]>) entry[0] = internText(entry[0]); break;
        case "eligible": break;
        case "endpoint-runs": for (const entry of value as EndpointRunEntry[]) {
          entry[0] = internText(entry[0]); entry[2].last = endpoint(entry[2].last);
        } break;
        case "endpoints": {
          const rows = value as Endpoint[];
          for (let index = 0; index < rows.length; index++) rows[index] = endpoint(rows[index]!);
        } break;
      }
    },
    releaseRows() { endpoints.clear(); },
    release() { strings.clear(); endpoints.clear(); },
  };
}

export function encodeV1QuotaWorkCheckpoint(state: V1QuotaAcquisitionCheckpoint): {
  control: V1QuotaWorkControl; components: V1QuotaWorkComponents;
} {
  return { control: { version: state.version, phase: state.phase, cursor: state.cursor,
    planTime: state.plan.time, reset: state.reset }, components: {
    "plan-anchors": state.plan.anchors, "plan-runs": state.plan.runs, "plan-equal-time": state.plan.equalTime,
    "fit-stats": state.stats, eligible: state.eligible, "endpoint-runs": state.runs, endpoints: state.endpoints,
  } };
}

/** Assemble only integrity-checked store parts. Throws one content-free error
 * on corruption; never logs or repairs unknown checkpoint fields.
 */
export function decodeV1QuotaWorkCheckpoint(identity: V1QuotaAcquisitionIdentity, control: unknown,
  components: unknown): V1QuotaAcquisitionCheckpoint {
  if (!validateV1QuotaWorkControl(control) || !closed(components, V1_QUOTA_WORK_COMPONENTS)
      || !V1_QUOTA_WORK_COMPONENTS.every((key) => validateV1QuotaWorkPart(key, components[key]))) invalid();
  const values = components as unknown as V1QuotaWorkComponents;
  const interner = createV1QuotaWorkInterner();
  for (const component of V1_QUOTA_WORK_COMPONENTS) interner.internPart(component, values[component]);
  interner.release();
  const state: V1QuotaAcquisitionCheckpoint = { version: control.version, identity: { ...identity }, phase: control.phase,
    cursor: control.cursor, plan: { time: control.planTime, anchors: values["plan-anchors"],
      runs: values["plan-runs"], equalTime: values["plan-equal-time"] }, reset: control.reset,
    stats: values["fit-stats"], eligible: values.eligible, runs: values["endpoint-runs"], endpoints: values.endpoints };
  validateCheckpoint(state, identity);
  for (const entries of [state.plan.runs, state.stats]) {
    if (new Set(entries.map(([key]) => key)).size !== entries.length) invalid();
  }
  const slotsByEra = new Map<string, Set<string>>();
  for (const [era, slot] of state.runs) {
    let slots = slotsByEra.get(era);
    if (!slots) { slots = new Set(); slotsByEra.set(era, slots); }
    if (slots.has(slot)) invalid();
    slots.add(slot);
  }
  if (new Set(state.eligible).size !== state.eligible.length
      || new Set(state.endpoints.map((row) => row.id)).size !== state.endpoints.length
      || state.plan.equalTime.some((row) => row.observedAtMs !== Date.parse(state.plan.time ?? ""))
      || new Set(state.plan.equalTime.map((row) => JSON.stringify([row.sourceContext, row.planType, row.planVariant])))
        .size !== state.plan.equalTime.length) invalid();
  if (state.phase !== "plan" && (state.plan.runs.length > 0 || state.plan.equalTime.length > 0)) invalid();
  if (state.phase === "plan" && (state.reset !== null || state.stats.length > 0 || state.eligible.length > 0
      || state.runs.length > 0 || state.endpoints.length > 0)) invalid();
  if (state.phase === "fitability" && (state.runs.length > 0 || state.endpoints.length > 0)) invalid();
  if (state.phase === "endpoints" && state.stats.length > 0) invalid();
  return state;
}

function validateIdentity(identity: V1QuotaAcquisitionIdentity): void {
  if (!closed(identity, ["participantId", "inputFingerprint", "sourceMethodVersion", "observedAtCutoff",
    "resetsAtCutoff", "windowMinutes", "maxQuotaRows"])
      || typeof identity.participantId !== "string" || identity.participantId.length < 1 || identity.participantId.length > 128
      || !/^[a-f0-9]{64}$/u.test(identity.inputFingerprint)
      || typeof identity.sourceMethodVersion !== "string" || identity.sourceMethodVersion.length < 1
      || identity.sourceMethodVersion.length > 256 || !Number.isSafeInteger(identity.windowMinutes)
      || identity.windowMinutes < 1 || !Number.isSafeInteger(identity.maxQuotaRows)
      || identity.maxQuotaRows < 1 || identity.maxQuotaRows > V1_QUOTA_ENDPOINT_LIMIT
      || !instant(identity.observedAtCutoff) || !instant(identity.resetsAtCutoff)) invalid();
}

export function createV1QuotaAcquisitionCheckpoint(
  identity: V1QuotaAcquisitionIdentity,
): V1QuotaAcquisitionCheckpoint {
  validateIdentity(identity);
  return {
    version: V1_QUOTA_ACQUISITION_VERSION, identity: { ...identity }, phase: "plan",
    cursor: { observedAt: identity.observedAtCutoff, resetsAt: identity.resetsAtCutoff, id: 0 },
    plan: { time: null, equalTime: [], runs: [], anchors: [] },
    reset: null, stats: [], eligible: [], runs: [], endpoints: [],
  };
}

function validateCheckpoint(state: V1QuotaAcquisitionCheckpoint, identity: V1QuotaAcquisitionIdentity): void {
  validateIdentity(identity);
  if (state.version !== V1_QUOTA_ACQUISITION_VERSION
      || Object.keys(identity).length !== Object.keys(state.identity).length
      || (Object.keys(identity) as Array<keyof V1QuotaAcquisitionIdentity>)
        .some((key) => state.identity[key] !== identity[key])
      || !["plan", "fitability", "endpoints"].includes(state.phase)
      || !Number.isSafeInteger(state.cursor.id) || state.cursor.id < 0
      || typeof state.cursor.observedAt !== "string" || typeof state.cursor.resetsAt !== "string"
      || state.plan.anchors.length > V1_PLAN_ANCHOR_LIMIT
      || state.plan.runs.length > V1_PLAN_ANCHOR_LIMIT
      || state.plan.equalTime.length > V1_PLAN_ANCHOR_LIMIT
      || state.plan.anchors.length + state.plan.equalTime.length > V1_PLAN_ANCHOR_LIMIT
      || state.stats.length > PLAN_ATTRIBUTION_POLICY.maxEras
      || state.eligible.length > identity.maxQuotaRows
      || state.runs.length > identity.maxQuotaRows || state.endpoints.length > identity.maxQuotaRows) invalid();
}

function attributionIndex(anchors: PlanAnchor[]): PlanAttributionIndex {
  // Already normalized public observations: no second 120k-object mapping.
  // sourceContext is acquisition-only; the shared builder ignores it.
  return buildPlanAttributionIndex(anchors);
}

/** This is quota acquisition only. It never writes a cache or publishes a day.
 * Caller must positively check the exact source pin before resumption and fence
 * checkpoint/final writes. Deferred is not an analytical refusal or zero fit.
 */
export async function advanceV1QuotaAcquisition(
  reader: V1QuotaPageReader,
  identity: V1QuotaAcquisitionIdentity,
  winningDayDevices: ReadonlyMap<string, string>,
  budget: V1QuotaInvocationBudget,
  state: V1QuotaAcquisitionCheckpoint = createV1QuotaAcquisitionCheckpoint(identity),
  options: { maxPages?: number } = {},
): Promise<V1QuotaAcquisitionStep> {
  const pageSize = reader.pageSize ?? V1_QUOTA_ACQUISITION_PAGE_SIZE;
  if (pageSize !== 128 && pageSize !== V1_QUOTA_ACQUISITION_PAGE_SIZE) throw new Error("v1 quota reader page policy invalid");
  validateCheckpoint(state, identity);
  if (!Number.isSafeInteger(budget.remainingQueries) || budget.remainingQueries < 0
      || !Number.isFinite(budget.deadlineMs)) throw new Error("v1 quota acquisition budget invalid");
  if (options.maxPages !== undefined && (!Number.isSafeInteger(options.maxPages) || options.maxPages < 1)) {
    throw new Error("v1 quota acquisition page bound invalid");
  }
  const now = budget.now ?? Date.now;
  if (budget.remainingQueries === 0 || now() >= budget.deadlineMs) return { status: "deferred", checkpoint: state };
  const interner = createV1QuotaWorkInterner();
  const encoded = encodeV1QuotaWorkCheckpoint(state);
  for (const component of V1_QUOTA_WORK_COMPONENTS) interner.internPart(component, encoded.components[component]);
  // Only the currently retained rows are deduplicated. Keeping every changing
  // last endpoint in this lookup would retain dense discarded observations.
  interner.releaseRows();
  const planRuns = new Map(state.plan.runs);
  const equalTime = new Map(state.plan.equalTime.map((row) =>
    [JSON.stringify([row.sourceContext, row.planType, row.planVariant]), row]));
  const stats = new Map(state.stats);
  const eligible = new Set(state.eligible);
  const endpointRuns = new Map<string, Map<string, EndpointRun>>();
  for (const [eraKey, slot, run] of state.runs) {
    let slots = endpointRuns.get(eraKey);
    if (!slots) { slots = new Map(); endpointRuns.set(eraKey, slots); }
    slots.set(slot, run);
  }
  state.runs = [];
  let index: PlanAttributionIndex | null = state.phase === "plan" ? null : attributionIndex(state.plan.anchors);
  if (index?.status === "limit_exceeded") return fail("plan_attribution_limit_exceeded");

  const flushPlanTime = (): boolean => {
    const ordered = [...equalTime.values()].sort(planOrder);
    for (let offset = 0; offset < ordered.length;) {
      const row = ordered[offset]!;
      const key = row.sourceContext;
      let end = offset + 1;
      while (end < ordered.length && ordered[end]!.sourceContext === row.sourceContext) end += 1;
      const run = planRuns.get(key);
      if (end - offset > 1) {
        // Equal-time distinct labels are an indivisible attribution barrier.
        // Flattening their lexical order into normal runs loses the last
        // pre-conflict or first post-conflict anchor when either label matches
        // its neighbor. Preserve both sides as the full shared builder does.
        // Unknown labels remain anchors; the shared builder alone interprets
        // them, so an unknown/known pair is not invented as a conflict here.
        if (run && !sameAnchor(run.first, run.last)) state.plan.anchors.push(run.last);
        for (let index = offset; index < end; index++) state.plan.anchors.push(ordered[index]!);
        planRuns.delete(key);
      } else if (run && run.last.planType === row.planType && run.last.planVariant === row.planVariant) {
        run.last = row;
      } else {
        if (run && !sameAnchor(run.first, run.last)) state.plan.anchors.push(run.last);
        state.plan.anchors.push(row);
        planRuns.set(key, { first: row, last: row });
      }
      if (state.plan.anchors.length > V1_PLAN_ANCHOR_LIMIT) return false;
      offset = end;
    }
    equalTime.clear();
    return true;
  };
  const finishStats = (): boolean => {
    for (const [eraKey, stat] of stats) {
      if (stat.values.length >= QUOTA_CALIBRATION_POLICY.minimumBoundaries
          && stat.maximum - stat.minimum >= QUOTA_CALIBRATION_POLICY.minimumDisplayedSpanPp) {
        eligible.add(JSON.stringify([state.reset, eraKey]));
        // Each proven-fitable fragment contains at least this many distinct
        // percentages, each represented by some retained run endpoint. This
        // lower bound is the EXISTING post-fitability cap, not a raw/group cap.
        if (eligible.size * QUOTA_CALIBRATION_POLICY.minimumBoundaries > identity.maxQuotaRows) return false;
      }
    }
    stats.clear();
    return true;
  };
  const finishRuns = (): boolean => {
    for (const slots of endpointRuns.values()) for (const run of slots.values()) {
      if (run.last.id !== run.firstId) state.endpoints.push(run.last);
      if (state.endpoints.length > identity.maxQuotaRows) return false;
    }
    endpointRuns.clear();
    return true;
  };
  const defer = (): V1QuotaAcquisitionStep => {
    state.plan.runs = [...planRuns];
    state.plan.equalTime = [...equalTime.values()];
    state.stats = [...stats];
    state.eligible = [...eligible];
    state.runs = [];
    for (const [era, slots] of endpointRuns) for (const [slot, run] of slots) state.runs.push([era, slot, run]);
    return { status: "deferred", checkpoint: state };
  };

  let pagesRead = 0;
  while (budget.remainingQueries > 0 && pagesRead < (options.maxPages ?? Infinity) && now() < budget.deadlineMs) {
    budget.remainingQueries -= 1;
    pagesRead += 1;
    if (state.phase === "plan") {
      const rows = await reader.readPlanPage(state.cursor, pageSize);
      if (rows.length > pageSize) throw new Error("v1 quota acquisition page overflow");
      let previous: V1TimeCursor = state.cursor;
      for (const row of rows) {
        if (!Number.isSafeInteger(row.id) || row.id <= 0
            || textOrder(row.observed_at, previous.observedAt) < 0
            || (row.observed_at === previous.observedAt && row.id <= previous.id)) {
          throw new Error("v1 quota acquisition page order invalid");
        }
        previous = { observedAt: row.observed_at, id: row.id };
        if (row.limit_id !== "codex" || winningDayDevices.get(row.observed_day) !== row.device_id) continue;
        if (state.plan.time !== null && state.plan.time !== row.observed_at && !flushPlanTime()) {
          return fail("plan_attribution_limit_exceeded");
        }
        state.plan.time = row.observed_at;
        const anchor: PlanAnchor = { observedAtMs: Date.parse(row.observed_at),
          sourceContext: interner.internText(JSON.stringify([row.provider, row.limit_id])),
          contextKey: row.provider !== null && SAFE_TOKEN.test(row.provider)
            ? interner.internText(`${row.provider}|${row.limit_id}`) : "",
          planType: row.plan_type ?? "unknown", planVariant: interner.internText(row.plan_variant ?? "unknown"), accountScopeId: null };
        equalTime.set(JSON.stringify([anchor.sourceContext, anchor.planType, anchor.planVariant]), anchor);
        // Every current distinct label is a future endpoint, even when a
        // matching run defers its final anchor. This lower bound includes
        // previously retained anchors: never hold two entire cap-sized sets.
        if (state.plan.anchors.length + equalTime.size > V1_PLAN_ANCHOR_LIMIT) return fail("plan_attribution_limit_exceeded");
      }
      state.cursor = { ...state.cursor, ...previous };
      if (rows.length === pageSize) continue;
      if (!flushPlanTime()) return fail("plan_attribution_limit_exceeded");
      for (const run of planRuns.values()) {
        if (!sameAnchor(run.first, run.last)) state.plan.anchors.push(run.last);
        if (state.plan.anchors.length > V1_PLAN_ANCHOR_LIMIT) return fail("plan_attribution_limit_exceeded");
      }
      state.plan.anchors.sort(planOrder);
      planRuns.clear();
      state.plan.runs = [];
      state.plan.equalTime = [];
      index = attributionIndex(state.plan.anchors);
      if (index.status !== "ready") return fail("plan_attribution_limit_exceeded");
      state.phase = "fitability";
      state.cursor = initialCursor(identity);
      continue;
    }

    const rows = await reader.readFitPage(state.cursor, pageSize);
    if (rows.length > pageSize) throw new Error("v1 quota acquisition page overflow");
    let previous: V1ResetCursor = state.cursor;
    for (const row of rows) {
      const order = textOrder(row.resets_at, previous.resetsAt) || textOrder(row.observed_at, previous.observedAt)
        || row.id - previous.id;
      if (!Number.isSafeInteger(row.id) || row.id <= 0 || order <= 0) {
        throw new Error("v1 quota acquisition page order invalid");
      }
      previous = { resetsAt: row.resets_at, observedAt: row.observed_at, id: row.id };
      if (row.observed_at < identity.observedAtCutoff
          || row.resets_at < identity.resetsAtCutoff || row.limit_id !== "codex"
          || row.window_duration_minutes !== identity.windowMinutes
          || winningDayDevices.get(row.observed_day) !== row.device_id) continue;
      if (state.reset !== null && state.reset !== row.resets_at) {
        if (!(state.phase === "fitability" ? finishStats() : finishRuns())) return fail("downsampled_quota_limit_exceeded");
      }
      state.reset = row.resets_at;
      const match = planEraForInterval(index!, { contextKey: `${row.provider}|${row.limit_id}`,
        observedAtMs: Date.parse(row.observed_at) });
      if (match.status !== "matched" || match.era.planType !== row.plan_type
          || match.era.planVariant !== row.plan_variant) continue;
      const eraKey = match.era.eraKey;
      if (state.phase === "fitability") {
        let stat = stats.get(eraKey);
        if (!stat) {
          stat = { values: [], minimum: row.used_percent, maximum: row.used_percent };
          stats.set(eraKey, stat);
        }
        stat.minimum = Math.min(stat.minimum, row.used_percent);
        stat.maximum = Math.max(stat.maximum, row.used_percent);
        if (stat.values.length < QUOTA_CALIBRATION_POLICY.minimumBoundaries && !stat.values.includes(row.used_percent)) {
          stat.values.push(row.used_percent);
        }
        continue;
      }
      if (!eligible.has(JSON.stringify([row.resets_at, eraKey]))) continue;
      let slots = endpointRuns.get(eraKey);
      if (!slots) { slots = new Map(); endpointRuns.set(eraKey, slots); }
      const endpoint: Endpoint = { id: row.id, row: { occurrence_id: row.occurrence_id, observed_at: row.observed_at,
        provider: interner.internText(row.provider), plan_type: row.plan_type, plan_variant: interner.internText(row.plan_variant),
        limit_id: row.limit_id, slot: row.slot, used_percent: row.used_percent,
        window_duration_minutes: row.window_duration_minutes, resets_at: row.resets_at, plan_era_key: eraKey } };
      const run = slots.get(row.slot);
      if (run && run.last.row.used_percent === row.used_percent) run.last = endpoint;
      else {
        if (run && run.last.id !== run.firstId) state.endpoints.push(run.last);
        state.endpoints.push(endpoint);
        if (state.endpoints.length > identity.maxQuotaRows) return fail("downsampled_quota_limit_exceeded");
        slots.set(row.slot, { firstId: row.id, last: endpoint });
      }
    }
    state.cursor = previous;
    if (rows.length === pageSize) continue;
    if (state.phase === "fitability") {
      if (!finishStats()) return fail("downsampled_quota_limit_exceeded");
      state.phase = "endpoints";
      state.reset = null;
      state.cursor = initialCursor(identity);
      continue;
    }
    if (!finishRuns()) return fail("downsampled_quota_limit_exceeded");
    state.endpoints.sort((left, right) => textOrder(left.row.observed_at, right.row.observed_at) || left.id - right.id);
    return { status: "complete", attributionIndex: index!, planAnchors: state.plan.anchors,
      quotaRows: state.endpoints.map(({ row }) => row) };
  }
  return defer();
}

/** Deterministic staging unit: exactly one whole physical page, or no progress.
 * Never stages a wall-clock-dependent number of pages. A deadline crossing
 * during the bounded query does not split its row processing. Caller binds
 * this marker and old/target manifest hashes to the unchanged source identity.
 */
export async function advanceV1QuotaAcquisitionPage(reader: V1QuotaPageReader, identity: V1QuotaAcquisitionIdentity,
  winningDayDevices: ReadonlyMap<string, string>, budget: V1QuotaInvocationBudget,
  state: V1QuotaAcquisitionCheckpoint = createV1QuotaAcquisitionCheckpoint(identity),
): Promise<{ result: V1QuotaAcquisitionStep; replay: V1QuotaPageReplay | null;
  checkpoint: V1QuotaAcquisitionCheckpoint | null }> {
  const from = { phase: state.phase, cursor: { ...state.cursor } };
  const queriesBefore = budget.remainingQueries;
  const result = await advanceV1QuotaAcquisition(reader, identity, winningDayDevices, budget, state, { maxPages: 1 });
  if (queriesBefore === budget.remainingQueries || result.status === "not_testable") {
    return { result, replay: null, checkpoint: null };
  }
  if (queriesBefore - budget.remainingQueries !== 1) throw new Error("v1 quota acquisition replay invalid");
  // Explicitly expose the actual final endpoint IDs for staged persistence.
  // A completed marker has phase complete while this resumable control stays
  // endpoints; no opaque attribution index is part of the checkpoint.
  return { result, checkpoint: state, replay: { ...(reader.pageSize === 128
    ? { version: "v1-quota-page-replay-2" as const, readerPolicy: "prepared-source-days-1" as const, pageSize: 128 as const }
    : { version: "v1-quota-page-replay-1" as const }), from,
    through: { phase: result.status === "complete" ? "complete" : result.checkpoint.phase, cursor: { ...state.cursor } },
    sourceQueryCount: 1, resolution: "resolved" } };
}
