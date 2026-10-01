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
  addQuotaFragmentValue,
  addQuotaReset,
  collapseQuotaEndpoint,
  createQuotaResetClusterState,
  finishQuotaEndpoints,
  quotaFragmentEligible,
  quotaResetClusterEntries,
  quotaResetRepresentativeMs,
  validQuotaResetClusterEntries,
  mergeQuotaFragmentStats,
  mergeQuotaResetHulls,
  type QuotaEndpointRun,
  type QuotaFragmentStats,
  type QuotaResetClusterEntry,
  type QuotaResetInterval,
} from "./quota-endpoint-collapse";
// Type-only: the prepared-day artifact module imports this one for its own
// bounds and validators, so a runtime import back would be an initialization
// cycle. The caller validates a day with `validGraphDayProjection`.
import type { GraphDayProjection } from "./graph-day-projection-values";
// The shared half of the acquisition contract, in a module that imports only
// packages and the collapse kernel. The artifact module depends on it too, so
// neither side depends on the other and the graph stays acyclic. Everything
// the reader used to own is re-exported below, so its callers are unchanged.
import {
  ACCOUNT_TRACK,
  MAX_TIME,
  MIN_TIME,
  OPAQUE_ID,
  PLAN_ERA,
  PLAN_TYPES,
  SAFE_TOKEN,
  SLOTS,
  V11_PLAN_ANCHOR_LIMIT,
  V11_QUOTA_ENDPOINT_LIMIT,
  V11_QUOTA_WORK_COMPONENTS,
  accountScope,
  boundedToken,
  canonicalTuple,
  closed,
  endpointKey,
  instant,
  numberOrder,
  percent,
  planGroup,
  planSignature,
  planSort,
  positiveId,
  safeTime,
  statsKey,
  textOrder,
  validEraKey,
  validPlanAnchor,
  validQuotaRow,
  validateV11QuotaWorkPart,
  type Endpoint,
  type EndpointRun,
  type FragmentStats,
  type PlanRun,
  type V11AcquiredQuotaRow,
  type V11PlanAnchor,
  type V11QuotaWorkComponent,
} from "./quota-analysis-v11-contract";
export {
  V11_PLAN_ANCHOR_LIMIT,
  V11_QUOTA_ENDPOINT_LIMIT,
  V11_QUOTA_WORK_COMPONENTS,
  validateV11QuotaWorkPart,
  type V11QuotaWorkComponent,
  type V11AcquiredQuotaRow,
  type V11PlanAnchor,
} from "./quota-analysis-v11-contract";
import {
  TYPED_V11_QUOTA_PAGE_SIZE,
  type V11QuotaPageCursor,
  type V11QuotaPageRow,
  type V11QuotaSourceRow,
} from "./typed-v11-quota-reader";

/** A private acquisition protocol. It is deliberately separate from the
 * public attribution adapter version: changing its page/checkpoint contract
 * must invalidate an in-flight acquisition without relabelling old evidence. */
export const V11_QUOTA_ACQUISITION_VERSION = "v11-quota-acquisition-2";
export const V11_QUOTA_ACQUISITION_PAGE_SIZE = TYPED_V11_QUOTA_PAGE_SIZE;


export interface V11QuotaPageReader {
  readonly pageSize: number;
  /** Effective pages preserve occurrence groups and may end a UTC day before
   * the whole window. Only this explicitly tagged adapter may use that seam. */
  readonly effective?: { readonly complete: () => boolean };
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

const IDENTITY_FIELDS = ["participantId", "inputFingerprint", "sourceMethodVersion",
  "observedAtCutoff", "resetsAtCutoff", "windowMinutes", "maxQuotaRows"] as const;

export interface V11QuotaAcquisitionCheckpoint {
  version: typeof V11_QUOTA_ACQUISITION_VERSION;
  identity: V11QuotaAcquisitionIdentity;
  phase: "plan" | "clusters" | "fitability" | "endpoints";
  cursor: V11QuotaPageCursor;
  plan: {
    timeMs: number | null;
    equalTime: V11PlanAnchor[];
    runs: Array<[string, PlanRun]>;
    observations: V11PlanAnchor[];
  };
  /** Pool hulls per plan era, built by the `clusters` sub-phase over every
   * valid quota row before any key is derived from a reset instant. */
  clusters: QuotaResetClusterEntry[];
  stats: Array<[string, FragmentStats]>;
  eligible: string[];
  runs: Array<[string, EndpointRun]>;
  endpoints: Endpoint[];
}

/** `fitability` stays a scan of its own and does not fold into `clusters`.
 * `QuotaFragmentStats` itself would survive the fold: hull merging partitions
 * the raw resets, minimum/maximum fold exactly, and a union of per-raw value
 * sets capped at `minimumBoundaries` reaches the cap exactly when the pool's
 * true distinct count does, so `quotaFragmentEligible` is preserved. The phase
 * merge is not safe for two reasons that have nothing to do with the statistic.
 * A `clusters` checkpoint carries no stats by construction, and its cursor is
 * the proof that the prefix before it was scanned for hulls only; a merged scan
 * resuming there would accumulate stats over the suffix alone and settle a
 * different `eligible` set, which only a new acquisition version could exclude.
 * And stats accumulated during `clusters` must key on the raw reset, whose
 * distinct count is bounded only by the row count, where the representative key
 * is bounded by `QUOTA_RESET_CLUSTER_LIMIT` pools: a mid-`clusters` successor
 * would fail its own `maxEras` part bound on a dense owner. */

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
  "reset-clusters": QuotaResetClusterEntry[];
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
/** The one coded failure for a structurally impossible acquisition state. The
 * direct reader shares it so both quota paths fail with the same code. */
export function invalidV11QuotaAcquisition(): never { invalid(); }
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

export function validateV11CompletedQuotaAcquisition(value: unknown): value is V11CompletedQuotaAcquisition {
  if (!closed(value, ["identity", "planAnchors", "quotaRows"]) || !identityValid(value.identity)
      || !Array.isArray(value.planAnchors)
      || value.planAnchors.length > V11_PLAN_ANCHOR_LIMIT || !value.planAnchors.every(validPlanAnchor)
      || !Array.isArray(value.quotaRows) || value.quotaRows.length > V11_QUOTA_ENDPOINT_LIMIT
      || !value.quotaRows.every(validQuotaRow)) return false;
  return new Set(value.quotaRows.map((row) => row.occurrence_id)).size === value.quotaRows.length;
}


export function validateV11QuotaWorkControl(value: unknown): value is V11QuotaWorkControl {
  return closed(value, ["version", "phase", "cursor", "planTimeMs"])
    && value.version === V11_QUOTA_ACQUISITION_VERSION
    && ["plan", "clusters", "fitability", "endpoints"].includes(value.phase as string)
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
      || !["plan", "clusters", "fitability", "endpoints"].includes(state.phase)
      || !cursorValid(state.cursor) || !closed(state.plan, ["timeMs", "equalTime", "runs", "observations"])
      || !Array.isArray(state.clusters)
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
      || !validateV11QuotaWorkPart("reset-clusters", state.clusters)
      || !validateV11QuotaWorkPart("fit-stats", state.stats)
      || !validateV11QuotaWorkPart("eligible", state.eligible)
      || !validateV11QuotaWorkPart("endpoint-runs", state.runs)
      || !validateV11QuotaWorkPart("endpoints", state.endpoints)) {
    invalid();
  }
  if (state.phase === "plan" && (state.clusters.length > 0 || state.stats.length > 0
      || state.eligible.length > 0 || state.runs.length > 0 || state.endpoints.length > 0)) invalid();
  if (state.phase === "clusters" && (state.plan.timeMs !== null || state.plan.equalTime.length > 0
      || state.plan.runs.length > 0 || state.stats.length > 0 || state.eligible.length > 0
      || state.runs.length > 0 || state.endpoints.length > 0)) invalid();
  if (state.phase === "fitability" && (state.plan.timeMs !== null || state.plan.equalTime.length > 0
      || state.plan.runs.length > 0 || state.eligible.length > 0 || state.runs.length > 0
      || state.endpoints.length > 0)) invalid();
  // Derived state can only exist once the pools it was keyed by do. An owner
  // with no valid quota row legitimately settles no pool at all.
  if (["fitability", "endpoints"].includes(state.phase) && state.clusters.length === 0
      && (state.stats.length > 0 || state.eligible.length > 0 || state.runs.length > 0
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
    clusters: [], stats: [], eligible: [], runs: [], endpoints: [],
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
      "reset-clusters": state.clusters,
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
    clusters: values["reset-clusters"],
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

/** The `plan` sub-phase's run collapse, held in one place so the paged
 * acquisition and the prepared-day fold cannot settle different anchors.
 * Anchors are offered in non-decreasing observation order; the ties at one
 * instant accumulate and are flushed in a canonical order when the instant
 * moves, because the attribution index reads an equal-time contradiction from
 * the whole tie rather than from the order it arrived in. `observations` is
 * the caller's own array so a resumed acquisition keeps appending to the one
 * it already staged. */
function createV11PlanFold(observations: V11PlanAnchor[], seed: {
  timeMs: number | null; runs: ReadonlyArray<[string, PlanRun]>; equalTime: readonly V11PlanAnchor[];
} = { timeMs: null, runs: [], equalTime: [] }) {
  const runs = new Map(seed.runs);
  const ties = new Map(seed.equalTime.map((row) => [JSON.stringify([planGroup(row), planSignature(row)]), row]));
  let timeMs = seed.timeMs;
  const append = (anchor: V11PlanAnchor): boolean => {
    const group = planGroup(anchor);
    const signature = planSignature(anchor);
    const run = runs.get(group);
    if (!run || run.signature !== signature) {
      if (run && run.last.observedAtMs !== run.first.observedAtMs) observations.push(run.last);
      if (observations.length >= V11_PLAN_ANCHOR_LIMIT) return false;
      observations.push(anchor);
      runs.set(group, { first: anchor, last: anchor, signature });
    } else {
      run.last = anchor;
    }
    return observations.length <= V11_PLAN_ANCHOR_LIMIT;
  };
  const flushTime = (): boolean => {
    const ordered = [...ties.values()].sort(planSort);
    for (const anchor of ordered) if (!append(anchor)) return false;
    ties.clear();
    return true;
  };
  return {
    runs, ties,
    get timeMs(): number | null { return timeMs; },
    accept(anchor: V11PlanAnchor): boolean {
      if (timeMs !== null && timeMs !== anchor.observedAtMs && !flushTime()) return false;
      timeMs = anchor.observedAtMs;
      ties.set(JSON.stringify([planGroup(anchor), planSignature(anchor)]), anchor);
      return observations.length + ties.size <= V11_PLAN_ANCHOR_LIMIT;
    },
    finish(): boolean {
      if (!flushTime()) return false;
      for (const run of runs.values()) {
        if (run.last.observedAtMs !== run.first.observedAtMs) observations.push(run.last);
        if (observations.length > V11_PLAN_ANCHOR_LIMIT) return false;
      }
      observations.sort((left, right) => left.observedAtMs - right.observedAtMs
        || textOrder(planGroup(left), planGroup(right)) || textOrder(planSignature(left), planSignature(right)));
      timeMs = null;
      return true;
    },
    clear(): void { runs.clear(); ties.clear(); timeMs = null; },
  };
}

/** Every rejection an acquired row would face, applied once for all three
 * source-reading sub-phases and for the fold: a row that can never be emitted
 * must not shape a pool hull or an eligibility decision either, or the direct
 * read, which rejects them up front, would settle different pools. */
export interface V11AdmittedQuotaRow {
  provider: string; accountScopeId: string | null; resetsAt: string; resetsAtMs: number;
  usedPercent: number; slot: string; planType: string; planVariant: string;
}
export interface V11QuotaAdmissionBounds {
  observedCutoffMs: number; resetsCutoffMs: number; windowMinutes: number;
}
function admissionBounds(identity: V11QuotaAcquisitionIdentity): V11QuotaAdmissionBounds {
  return { observedCutoffMs: Date.parse(identity.observedAtCutoff),
    resetsCutoffMs: Date.parse(identity.resetsAtCutoff), windowMinutes: identity.windowMinutes };
}
function foldableQuotaRow(active: V11QuotaSourceRow, bounds: V11QuotaAdmissionBounds):
  V11AdmittedQuotaRow | null {
  if (active.observedAtMs < bounds.observedCutoffMs
      || active.resetsAt === null || Date.parse(active.resetsAt) < bounds.resetsCutoffMs
      || active.windowDurationMinutes !== bounds.windowMinutes || active.usedPercent === null) return null;
  const accountScopeId = active.accountBasis === "same_source" ? active.accountTrackId : null;
  const provider = active.provider;
  if (provider === null || active.limitId !== "codex" || !SAFE_TOKEN.test(provider)
      || (accountScopeId !== null && !ACCOUNT_TRACK.test(accountScopeId))) return null;
  if (active.planType === null || active.planVariant === null || active.slot === null
      || !PLAN_TYPES.has(active.planType) || !SAFE_TOKEN.test(active.planVariant)
      || !SLOTS.has(active.slot) || !percent(active.usedPercent)
      || Date.parse(active.resetsAt) <= active.observedAtMs) return null;
  return { provider, accountScopeId, resetsAt: active.resetsAt, resetsAtMs: Date.parse(active.resetsAt),
    usedPercent: active.usedPercent, slot: active.slot, planType: active.planType,
    planVariant: active.planVariant };
}

/** The window era one admitted quota row belongs to, or null when the index
 * has no era covering it or the era disagrees with the row's own plan. */
function quotaRowEraKey(index: PlanAttributionIndex, active: V11QuotaSourceRow,
  admitted: { provider: string; accountScopeId: string | null }): string | null {
  const match = planEraForInterval(index, {
    contextKey: planAttributionContextKey(admitted.provider, active.limitId!),
    accountScopeId: admitted.accountScopeId, observedAtMs: active.observedAtMs,
  });
  if (match.status !== "matched" || active.planType !== match.era.planType
      || active.planVariant !== match.era.planVariant) return null;
  return validEraKey(match.era.eraKey) ? match.era.eraKey : null;
}

/** Settle which clustered groups the calibration will accept, and refuse when
 * admitting them could not fit the caller's downsampled-row bound. Shared so
 * the fold cannot admit a group the paged path refused. */
function settleQuotaEligibility(stats: Map<string, FragmentStats>, eligible: Set<string>,
  maxQuotaRows: number): boolean {
  for (const [key, stat] of stats) {
    if (quotaFragmentEligible(stat)) {
      eligible.add(key);
      if (eligible.size * QUOTA_CALIBRATION_POLICY.minimumBoundaries > maxQuotaRows) return false;
    }
  }
  stats.clear();
  return true;
}

/** One source row reduced to what a prepared day stores, or the parts of it a
 * prepared day stores. The admission applied here is exactly the paged path's
 * own, minus the two predicates a day cannot know: the window's observation
 * start, which is day-aligned and therefore decided by which days are folded,
 * and the reset horizon, which moves with every model-day and is applied by the
 * fold. `windowMinutes` is a fixed kernel constant of the caller's analysis and
 * is applied here, because it is NOT part of the day's collapse key and a row
 * of another window duration would otherwise share a run with one of this. */
export interface V11PreparedDayRow {
  sourceRowId: number;
  observedAtMs: number;
  anchor: V11PlanAnchor | null;
  row: Omit<V11AcquiredQuotaRow, "plan_era_key"> | null;
}
export function v11PreparedDayRow(pageRow: V11QuotaPageRow, windowMinutes: number): V11PreparedDayRow {
  const active = pageRow.active;
  if (active === null) {
    return { sourceRowId: pageRow.sourceRowId, observedAtMs: pageRow.observedAtMs, anchor: null, row: null };
  }
  const admitted = foldableQuotaRow(active,
    { observedCutoffMs: MIN_TIME, resetsCutoffMs: MIN_TIME, windowMinutes });
  const row = admitted === null ? null : acquiredRow(active, PREPARED_DAY_PROBE_ERA_KEY);
  if (row !== null) delete (row as Partial<V11AcquiredQuotaRow>).plan_era_key;
  return { sourceRowId: pageRow.sourceRowId, observedAtMs: pageRow.observedAtMs,
    anchor: sourceAnchor(active), row };
}
/** Only ever used to satisfy `acquiredRow`'s own era-key check while building a
 * day-local row; the fold assigns the window era and this value never escapes. */
const PREPARED_DAY_PROBE_ERA_KEY = JSON.stringify(["openai_codex|codex", null, "pro", "unknown", 0]);

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
  if (reader.pageSize !== V11_QUOTA_ACQUISITION_PAGE_SIZE
      && !(reader.pageSize === 200 && typeof reader.effective?.complete === "function")) {
    throw new Error("v11 quota reader page policy invalid");
  }
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

  const plan = createV11PlanFold(state.plan.observations, { timeMs: state.plan.timeMs,
    runs: state.plan.runs, equalTime: state.plan.equalTime });
  const stats = new Map(state.stats);
  const eligible = new Set(state.eligible);
  const endpointRuns = new Map<string, EndpointRun>(state.runs);
  const clusters = createQuotaResetClusterState(state.clusters);
  state.plan.runs = [];
  state.runs = [];
  state.clusters = [];
  const endpointView = (value: Endpoint) => ({ id: value.id,
    observedAtMs: Date.parse(value.row.observed_at), usedPercent: value.row.used_percent });
  const emitEndpoint = (value: Endpoint) => {
    state.endpoints.push(value);
    return state.endpoints.length <= identity.maxQuotaRows;
  };
  const bounds = admissionBounds(identity);
  let index: PlanAttributionIndex | null = state.phase === "plan"
    ? null : buildPlanAttributionIndex(state.plan.observations);
  if (index?.status !== undefined && index.status !== "ready") return refusal("plan_attribution_limit_exceeded");

  const finishStats = (): boolean => settleQuotaEligibility(stats, eligible, identity.maxQuotaRows);
  const finishRuns = (): boolean => finishQuotaEndpoints(endpointRuns, endpointView, emitEndpoint);
  const defer = (): V11QuotaAcquisitionStep => {
    state.plan.timeMs = plan.timeMs;
    state.plan.runs = [...plan.runs];
    state.plan.equalTime = [...plan.ties.values()];
    state.clusters = quotaResetClusterEntries(clusters);
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
        if (!plan.accept(anchor)) return refusal("plan_attribution_limit_exceeded");
        continue;
      }
      if (index === null) throw new Error("v11 quota attribution index missing");
      const admitted = foldableQuotaRow(active, bounds);
      if (admitted === null) continue;
      const eraKey = quotaRowEraKey(index, active, admitted);
      if (eraKey === null) continue;
      // Pool identity, not the restated instant. The `clusters` sub-phase sees
      // every valid quota row before any key is derived, so both the fitable
      // stats and the endpoint runs are keyed by a settled pool.
      if (state.phase === "clusters") {
        if (!addQuotaReset(clusters, eraKey, admitted.resetsAtMs)) {
          return refusal("downsampled_quota_limit_exceeded");
        }
        continue;
      }
      const representative = quotaResetRepresentativeMs(clusters, eraKey, admitted.resetsAtMs);
      if (representative === null) invalid();
      const reset = new Date(representative).toISOString();
      const key = statsKey(reset, eraKey);
      if (state.phase === "fitability") {
        addQuotaFragmentValue(stats, key, admitted.usedPercent);
        continue;
      }
      if (!eligible.has(key)) continue;
      const output = acquiredRow(active, eraKey);
      if (output === null) continue;
      // The representative is the pool's largest restated instant, so it stays
      // strictly after this observation exactly as the raw instant was.
      output.resets_at = reset;
      const endpoint: Endpoint = { id: pageRow.sourceRowId, row: output };
      if (!collapseQuotaEndpoint(endpointRuns, endpointKey(eraKey, output.slot, reset), endpoint,
        endpointView, emitEndpoint)) return refusal("downsampled_quota_limit_exceeded");
    }
    state.cursor = previous;
    if (reader.effective ? !reader.effective.complete() : rows.length === reader.pageSize) continue;
    if (state.phase === "plan") {
      if (!plan.finish()) return refusal("plan_attribution_limit_exceeded");
      index = buildPlanAttributionIndex(state.plan.observations);
      if (index.status !== "ready") return refusal("plan_attribution_limit_exceeded");
      state.phase = "clusters";
      state.plan.timeMs = null;
      state.plan.equalTime = [];
      state.plan.runs = [];
      plan.clear();
      state.cursor = initialCursor(identity);
      if (options.stopAtPhaseBoundary) return defer();
      continue;
    }
    if (state.phase === "clusters") {
      state.phase = "fitability";
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

/** A prepared day cannot be folded without losing evidence the paged path
 * used. Distinct from `invalid()` so an operator can tell an artifact this
 * layer cannot express from a corrupt checkpoint. */
function ambiguousPreparedDay(): never {
  throw new Error("v11 quota prepared day ambiguous");
}

/** The supplied days are not the window's days. A fold over a window with a
 * day missing settles a smaller, complete-LOOKING acquisition under the same
 * result identity, so it is refused rather than folded: the caller supplies
 * every day of the generation's window or none of them. Distinct from the
 * ambiguity failure so an operator can tell a lane that has not finished
 * building from an artifact that cannot be placed. */
export function incompleteV11PreparedDays(): never {
  throw new Error("v11 quota prepared day set incomplete");
}

/** Refuse unless `days` is exactly `expected`, in order. Shared by the quota
 * and usage folds so one rule decides completeness for both. */
export function assertV11PreparedDayCoverage(days: readonly { day: string }[],
  expected: readonly string[]): void {
  if (days.length !== expected.length) incompleteV11PreparedDays();
  for (let index = 0; index < days.length; index += 1) {
    if (days[index]!.day !== expected[index]) incompleteV11PreparedDays();
  }
}

/**
 * Fold prepared per-day projections into the same `V11CompletedQuotaAcquisition`
 * the paged path settles on, without reading a source page.
 *
 * Days must arrive in ascending UTC-day order, must be EXACTLY `expectedDays`
 * — the generation's own days for this window — and must already have passed
 * `validGraphDayProjection`; the caller owns that last check, because the
 * artifact module imports this one and a runtime import back would be a cycle.
 *
 * What composes, and why this is the same result:
 *
 * - **Plan anchors.** Each day's retained run boundaries are replayed through
 *   the shared `createV11PlanFold`, which is the same collapse the `plan`
 *   sub-phase runs. Replaying a run's own boundaries is idempotent, and a run
 *   crossing midnight is rejoined because the fold sees both days' boundaries
 *   in order, so the settled observations are the paged path's own.
 * - **Pools.** `mergeQuotaResetHulls` reaches the same single-linkage partition
 *   as inserting every raw instant, so the representative is resolved here,
 *   after all days merge, and never day-locally.
 * - **Fitability.** Minimum and maximum fold, and the capped distinct-value set
 *   reaches the cap exactly when the pool's true distinct count does, so
 *   `quotaFragmentEligible` decides the same groups.
 * - **Spacing stays here.** The days carry run endpoints with no spacing; the
 *   fold feeds them, in day order, through the unmodified
 *   `collapseQuotaEndpoint` / `finishQuotaEndpoints`.
 *
 * Evidence a prepared day cannot place is refused loudly rather than folded
 * approximately: a day-local RUN whose retained endpoints do not all resolve to
 * one window era, or a hull or fit fragment for a run the day retained no
 * endpoint for. Both are structurally impossible in a day this layer built —
 * `validGraphDayProjection` enforces the second — so reaching either means the
 * artifact is not the one the fold's composition argument applies to.
 *
 * The one inexactness that is not detectable here is the cluster bound: the
 * merge refuses on the count settled at each day boundary, which is one-sided
 * (a refusing merge proves the direct insertion refused too) but misses a
 * transient peak inside a single day that the day's own hull set no longer
 * shows.
 */
export function foldV11QuotaAcquisition(identity: V11QuotaAcquisitionIdentity,
  days: readonly GraphDayProjection[], expectedDays: readonly string[]): V11QuotaAcquisitionStep {
  if (!identityValid(identity)) invalid();
  // Completeness first: ordering and the cutoff say nothing about a day that
  // is simply absent, and an absent day folds silently.
  assertV11PreparedDayCoverage(days, expectedDays);
  const bounds = admissionBounds(identity);
  // The window's observation start is a UTC day boundary, so it selects whole
  // days and never splits one. That is what lets a day's aggregates be folded
  // at all: a straddling observation cutoff would need per-row evidence the
  // aggregates no longer carry. Enforced rather than assumed.
  const cutoffDay = identity.observedAtCutoff.slice(0, 10);
  if (Date.parse(`${cutoffDay}T00:00:00.000Z`) !== bounds.observedCutoffMs) invalid();
  let previousDay = "";
  for (const day of days) {
    if (typeof day.day !== "string" || day.day <= previousDay || day.day < cutoffDay) invalid();
    previousDay = day.day;
  }

  const observations: V11PlanAnchor[] = [];
  const plan = createV11PlanFold(observations);
  let anchorAtMs = -Infinity;
  for (const day of days) {
    for (const anchor of day.planAnchors.anchors) {
      if (!validPlanAnchor(anchor) || anchor.observedAtMs < anchorAtMs) invalid();
      anchorAtMs = anchor.observedAtMs;
      if (!plan.accept(anchor)) return refusal("plan_attribution_limit_exceeded");
    }
  }
  if (!plan.finish()) return refusal("plan_attribution_limit_exceeded");
  const index = buildPlanAttributionIndex(observations);
  if (index.status !== "ready") return refusal("plan_attribution_limit_exceeded");

  /** The window era one day-local signature resolves to at one instant, or
   * null when every row carrying it is one the paged path would skip. */
  const signatureEra = (signature: string, observedAtMs: number): string | null => {
    const fields = canonicalTuple(signature, 6, 2_048);
    if (fields === null) ambiguousPreparedDay();
    const [contextKey, accountScopeId, planType, planVariant] = fields;
    if (typeof contextKey !== "string" || (accountScopeId !== null && typeof accountScopeId !== "string")
        || typeof planType !== "string" || typeof planVariant !== "string") return null;
    const match = planEraForInterval(index, { contextKey,
      accountScopeId: accountScopeId as string | null, observedAtMs });
    if (match.status !== "matched" || planType !== match.era.planType
        || planVariant !== match.era.planVariant) return null;
    return validEraKey(match.era.eraKey) ? match.era.eraKey : null;
  };
  // One era per day-local RUN, proven over every retained endpoint of that run
  // in that day. A run is closed at every signature change and at every
  // equal-time conflict, which are exactly the instants the index can place a
  // boundary at, so a run cannot span two eras and a signature interrupted
  // inside a day keeps its two runs' evidence apart.
  const dayEras = days.map((day) => {
    const eras = new Map<string, Map<number, string | null>>();
    for (const endpoint of day.runEndpoints.endpoints) {
      const era = signatureEra(endpoint.signature, endpoint.observedAtMs);
      let runs = eras.get(endpoint.signature);
      if (runs === undefined) { runs = new Map(); eras.set(endpoint.signature, runs); }
      if (!runs.has(endpoint.runFirstObservedAtMs)) runs.set(endpoint.runFirstObservedAtMs, era);
      else if (runs.get(endpoint.runFirstObservedAtMs) !== era) ambiguousPreparedDay();
    }
    return eras;
  });
  const eraFor = (dayIndex: number, signature: string, runFirstObservedAtMs: number): string | null => {
    const runs = dayEras[dayIndex]!.get(signature);
    if (runs === undefined || !runs.has(runFirstObservedAtMs)) ambiguousPreparedDay();
    return runs.get(runFirstObservedAtMs)!;
  };

  /** Every raw reset instant the day admitted, per run: the fit fragments are
   * keyed by `(run, raw reset)` and the projection emits one for every admitted
   * row, so they enumerate exactly the instants the day's hulls were built
   * from. That is what makes `resetsAtCutoff` applicable here — the paged path
   * drops a row below the horizon BEFORE it clusters, and a hull is an interval
   * whose members are gone, so a straddling pool cannot be split after the
   * fact. Rebuilding from the surviving members is exact where trimming an
   * interval is not. `resetHulls` is consequently not read by the fold; it
   * remains the store's own record of the same evidence. */
  const clusters = createQuotaResetClusterState();
  for (const [dayIndex, day] of days.entries()) {
    const settled = createQuotaResetClusterState();
    for (const fragment of day.fitFragments.fragments) {
      if (fragment.resetsAtMs < bounds.resetsCutoffMs) continue;
      const era = eraFor(dayIndex, fragment.signature, fragment.runFirstObservedAtMs);
      if (era === null) continue;
      if (!addQuotaReset(settled, era, fragment.resetsAtMs)) {
        return refusal("downsampled_quota_limit_exceeded");
      }
    }
    if (!mergeQuotaResetHulls(clusters, quotaResetClusterEntries(settled))) {
      return refusal("downsampled_quota_limit_exceeded");
    }
  }

  const stats = new Map<string, FragmentStats>();
  for (const [dayIndex, day] of days.entries()) {
    for (const fragment of day.fitFragments.fragments) {
      if (fragment.resetsAtMs < bounds.resetsCutoffMs) continue;
      const era = eraFor(dayIndex, fragment.signature, fragment.runFirstObservedAtMs);
      if (era === null) continue;
      const representative = quotaResetRepresentativeMs(clusters, era, fragment.resetsAtMs);
      if (representative === null) invalid();
      mergeQuotaFragmentStats(stats, statsKey(new Date(representative).toISOString(), era),
        { values: [...fragment.values], minimum: fragment.minimum, maximum: fragment.maximum });
    }
  }
  const eligible = new Set<string>();
  if (!settleQuotaEligibility(stats, eligible, identity.maxQuotaRows)) {
    return refusal("downsampled_quota_limit_exceeded");
  }

  const endpointRuns = new Map<string, EndpointRun>();
  const emitted: Endpoint[] = [];
  const endpointView = (value: Endpoint) => ({ id: value.id,
    observedAtMs: Date.parse(value.row.observed_at), usedPercent: value.row.used_percent });
  const emitEndpoint = (value: Endpoint) => {
    emitted.push(value);
    return emitted.length <= identity.maxQuotaRows;
  };
  let previous: V11QuotaPageCursor = { observedAtMs: -Infinity, sourceRowId: 0 };
  for (const [dayIndex, day] of days.entries()) {
    for (const value of day.runEndpoints.endpoints) {
      if (!positiveId(value.sourceRowId) || !safeTime(value.observedAtMs)
          || value.observedAtMs < previous.observedAtMs
          || value.observedAtMs === previous.observedAtMs && value.sourceRowId <= previous.sourceRowId) invalid();
      previous = { observedAtMs: value.observedAtMs, sourceRowId: value.sourceRowId };
      const era = eraFor(dayIndex, value.signature, value.runFirstObservedAtMs);
      if (era === null) continue;
      // The window predicates of the paged path's own row filter. A prepared
      // day is window-agnostic, so they are applied here, once.
      if (value.observedAtMs < bounds.observedCutoffMs || value.resetsAtMs < bounds.resetsCutoffMs
          || value.row.window_duration_minutes !== bounds.windowMinutes) continue;
      const representative = quotaResetRepresentativeMs(clusters, era, value.resetsAtMs);
      if (representative === null) invalid();
      const reset = new Date(representative).toISOString();
      if (!eligible.has(statsKey(reset, era))) continue;
      const row: V11AcquiredQuotaRow = { ...value.row, resets_at: reset, plan_era_key: era };
      if (!collapseQuotaEndpoint(endpointRuns, endpointKey(era, row.slot, reset),
        { id: value.sourceRowId, row }, endpointView, emitEndpoint)) {
        return refusal("downsampled_quota_limit_exceeded");
      }
    }
  }
  if (!finishQuotaEndpoints(endpointRuns, endpointView, emitEndpoint)) {
    return refusal("downsampled_quota_limit_exceeded");
  }
  emitted.sort((left, right) => numberOrder(Date.parse(left.row.observed_at), Date.parse(right.row.observed_at))
    || left.id - right.id);
  return { status: "complete", attributionIndex: index, identity: { ...identity },
    planAnchors: observations, quotaRows: emitted.map(({ row }) => row) };
}
