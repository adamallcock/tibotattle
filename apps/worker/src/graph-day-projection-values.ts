import { MODEL_COMPOSITION_POLICY, QUOTA_CALIBRATION_POLICY } from "@app-usagemonitor/quota-analysis";
import {
  V11_PLAN_ANCHOR_LIMIT,
  V11_QUOTA_ENDPOINT_LIMIT,
  validateV11QuotaWorkPart,
  type V11AcquiredQuotaRow,
  type V11PlanAnchor,
} from "./quota-analysis-v11-contract";

/**
 * The prepared per-`(owner, UTC day)` graph projection.
 *
 * This is the reusable *input* layer the graph acquisition folds, not a result
 * cache: an unchanged day is prepared once and every model-day that covers it
 * reads the same rows. The four quota components are exactly the artifact the
 * acquisition plan specifies, and they are stored day-locally because that is
 * the smallest unit that composes: `buildPlanAttributionIndex` only ever places
 * an era boundary at an observed instant where the plan signature changes or an
 * equal-time conflict occurs, so a day whose runs are split at both of those
 * retains a superset of the window's true run endpoints.
 *
 * Nothing here is content: no prompt, response, command, path, filename or raw
 * account identifier. The only owner-scoped values are the ones the acquisition
 * checkpoint already carries — opaque occurrence ids, the derived
 * `account-track:v2:` pseudonym and the derived `plan-era:v1:` continuity id —
 * and the store keys them by the existing owner digest.
 */
export const GRAPH_DAY_PROJECTION_VERSION = "graph-day-projection-v1";

/** UTC bins per day. `grainMs` divides a day exactly, so no bin straddles a
 * boundary and a day's usage fragments compose by concatenation. */
export const GRAPH_DAY_USAGE_BIN_COUNT = 86_400_000 / MODEL_COMPOSITION_POLICY.grainMs;
/** Bounds are per day, and every one of them is at or below the window bound
 * the paged acquisition already refuses at, so a day this layer accepts can
 * never be a day the unprepared path would have refused. */
export const GRAPH_DAY_PLAN_ANCHOR_LIMIT = V11_PLAN_ANCHOR_LIMIT;
export const GRAPH_DAY_RUN_ENDPOINT_LIMIT = V11_QUOTA_ENDPOINT_LIMIT;
export const GRAPH_DAY_FIT_FRAGMENT_LIMIT = V11_QUOTA_ENDPOINT_LIMIT;
/** Mirrors of the usage reduction's own window bounds (`MAX_USAGE_BUCKETS`,
 * `MAX_SESSIONS` in `quota-analysis-v11.ts`). A single day cannot exceed a
 * window bound without the window exceeding it, so a day this layer accepts is
 * never a day the paged reduction would have refused. */
export const GRAPH_DAY_USAGE_CELL_LIMIT = 120_000;
export const GRAPH_DAY_USAGE_SESSION_LIMIT = 100_000;
/** The per-cell and per-sum ceiling `reduceModel` refuses above. */
export const GRAPH_DAY_USAGE_COST_CEILING = 90_000_000_000_000;

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const SAFE_TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/u;
const ACCOUNT_TRACK = /^account-track:v2:[0-9a-f]{64}$/u;
const PLAN_ERA = /^plan-era:v1:[0-9a-f]{64}$/u;
const HEX_DIGEST = /^[0-9a-f]{64}$/u;
const MIN_TIME = -8_640_000_000_000_000;
const MAX_TIME = 8_640_000_000_000_000;
/** A structurally valid era key used only to reuse the acquisition reader's own
 * row validator for the fields a day-local row shares with an acquired row.
 * `validQuotaRow` checks `plan_era_key` independently of every other field, so
 * substituting this constant validates the rest exactly as the paged path does
 * without restating that schema here. The window era key itself is not
 * day-local and is resolved by the fold, never stored. */
const PROBE_ERA_KEY = JSON.stringify(["openai_codex|codex", null, "pro", "unknown", 0]);

/**
 * A day-local plan signature: canonical JSON of
 * `[contextKey, accountScopeId, planType, planVariant, continuityId, planBasis]`.
 *
 * This is the acquisition reader's own grouping (`[contextKey, accountScopeId]`)
 * joined to its own plan signature (`[planType, planVariant, continuityId,
 * planBasis]`). It deliberately carries no instant: a window era key does, and
 * a day cannot know the window's boundaries.
 */
export type GraphDayPlanSignature = string;

/**
 * A day-local RUN of one plan signature: canonical JSON of
 * `[signature, runFirstObservedAtMs]`.
 *
 * The signature alone is not a sound key. An era boundary is placed only where
 * the plan signature changes or an equal-time conflict occurs, so a signature
 * that is interrupted inside a day and then resumes reaches TWO window eras
 * while carrying one signature. Keying hulls and fit fragments by signature
 * alone merges that evidence before the fold can separate it, and the fold can
 * then only refuse. The run's first observed instant is enough to separate
 * them, because a run by construction contains no boundary instant.
 */
export type GraphDayRunKey = string;
export function graphDayRunKey(signature: GraphDayPlanSignature,
  runFirstObservedAtMs: number): GraphDayRunKey {
  return JSON.stringify([signature, runFirstObservedAtMs]);
}

/** The day's acquired quota row, minus the window-scoped era key the fold
 * assigns and with `resets_at` still the raw restated instant rather than the
 * settled pool representative. */
export type GraphDayAcquiredRow = Omit<V11AcquiredQuotaRow, "plan_era_key">;

/** Component 1. The `plan` sub-phase's emitted run boundaries for this day,
 * in chronological emission order, equal-time ties included. */
export interface GraphDayPlanAnchors {
  readonly anchors: readonly V11PlanAnchor[];
}

/** Component 3, one entry. `values` is the numerically smallest distinct
 * `used_percent` set, capped at `minimumBoundaries`: either a day saturates the
 * cap or it holds its whole distinct set, so the union over days reaches the cap
 * exactly when the pool's true distinct count does and `quotaFragmentEligible`
 * is preserved. Keyed by the RAW reset instant, because the representative is
 * the settled pool maximum and is not day-local. */
export interface GraphDayFitFragment {
  readonly signature: GraphDayPlanSignature;
  /** The day-local run this evidence belongs to; with `signature` it forms the
   * `GraphDayRunKey` the fold settles this pool under. */
  readonly runFirstObservedAtMs: number;
  readonly resetsAtMs: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly values: readonly number[];
}
export interface GraphDayFitFragments {
  readonly fragments: readonly GraphDayFitFragment[];
}

/** Component 4, one entry. Rows surviving equal-value run collapse, with NO
 * 10-minute spacing: spacing is a greedy over the whole window per key and the
 * fold applies it, unmodified, to the concatenated days. */
export interface GraphDayRunEndpoint {
  readonly signature: GraphDayPlanSignature;
  /** The day-local run this row belongs to. It is what lets the fold resolve
   * ONE window era per run rather than one per signature. */
  readonly runFirstObservedAtMs: number;
  readonly slot: string;
  readonly resetsAtMs: number;
  readonly sourceRowId: number;
  readonly observedAtMs: number;
  readonly usedPercent: number;
  readonly row: GraphDayAcquiredRow;
}
export interface GraphDayRunEndpoints {
  readonly endpoints: readonly GraphDayRunEndpoint[];
}

/**
 * The MODEL half of the v1.1 usage reduction, day-locally.
 *
 * `modelFromReduction` reads exactly `modelCosts`, `poisoned`, the two event
 * counters, `attributionUnresolved` and the refusal slots — never the hazards
 * and never the scalar buckets. So this carries the inputs of `reduceModel`
 * and nothing else; `usageScalarBuckets` is deliberately absent, because its
 * key embeds the window era and a window-wide quota grid on which production
 * measures roughly one bucket per usage row, so it neither composes nor
 * compresses.
 *
 * What a day cannot decide is which era an event resolves to, because the era
 * key is window-scoped. So a cell keeps the raw attribution inputs and the fold
 * evaluates `planConflict` and the seed comparison once per cell.
 *
 * `accountBreak` is `prior.scope !== scope` over the event's own session. That
 * is day-local for every event except the first one of a session in the day, so
 * those are held individually as `openers` and the fold decides them from the
 * previous days' `sessions` tails, which are `usagePrevious` itself.
 */
export type GraphDayUsagePlanBasis = V11PlanAnchor["planBasis"];
export interface GraphDayUsageAttribution {
  readonly provider: string;
  readonly accountScopeId: string | null;
  readonly planBasis: GraphDayUsagePlanBasis;
  readonly planType: string | null;
  readonly planEraId: string | null;
}
/** One aggregated `(2-hour bin, attribution, accountBreak, model)` cell.
 * `model === null` is an event that priced but not fully: it carries no cost
 * and poisons its whole bin, which is why the bin instant is part of the key
 * and a day-level unpriced count could never stand in for it. */
export interface GraphDayUsageCell extends GraphDayUsageAttribution {
  readonly binStartMs: number;
  readonly accountBreak: boolean;
  readonly model: string | null;
  readonly costNanousd: number;
  readonly eventCount: number;
}
/** A session's first event in the day, held alone because its `accountBreak`
 * is not day-local. */
export interface GraphDayUsageOpener extends GraphDayUsageAttribution {
  readonly sessionDigest: string;
  readonly binStartMs: number;
  readonly observedAtMs: number;
  readonly model: string | null;
  readonly costNanousd: number;
}
/** The day's carry-out for one session: `usagePrevious`, exactly. Keyed by an
 * opaque digest the caller derives, so no raw session identifier is stored. */
export interface GraphDayUsageSession {
  readonly sessionDigest: string;
  readonly lastObservedAtMs: number;
  readonly lastAccountScopeId: string | null;
}
export interface GraphDayUsageFragments {
  readonly cells: readonly GraphDayUsageCell[];
  readonly openers: readonly GraphDayUsageOpener[];
  readonly sessions: readonly GraphDayUsageSession[];
  /**
   * Source rows the day's usage read actually returned, INCLUDING rows the
   * mapper skipped or refused and rows that never became a cell, an opener or
   * even a session tail.
   *
   * The components alone are only a lower bound on what the stream read — the
   * reduction drops unmeasurable events after advancing their session, and
   * rejects others before the mapper — so an owner whose overage was all
   * dropped rows would pass a bound derived from them. This is the exact count
   * the streaming path metered, so `MAX_WINDOWED_USAGE_ROWS` decides the same
   * way on both paths.
   */
  readonly rowsRead: number;
}

export interface GraphDayProjection {
  readonly version: typeof GRAPH_DAY_PROJECTION_VERSION;
  readonly day: string;
  readonly planAnchors: GraphDayPlanAnchors;
  readonly fitFragments: GraphDayFitFragments;
  readonly runEndpoints: GraphDayRunEndpoints;
  readonly usage: GraphDayUsageFragments;
}

/** The seven component names, in the order the store frames them. `rowsRead`
 * is a scalar, so it travels as a single-entry component rather than growing
 * the store a second encoding for non-list values. */
export const GRAPH_DAY_PROJECTION_COMPONENTS = [
  "planAnchors", "fitFragments", "runEndpoints",
  "usageCells", "usageOpeners", "usageSessions", "usageRowsRead",
] as const;
export type GraphDayProjectionComponent = typeof GRAPH_DAY_PROJECTION_COMPONENTS[number];

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function safeTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_TIME && value <= MAX_TIME;
}
function percent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}
function instant(value: unknown): value is string {
  return typeof value === "string" && value.length <= 27 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}
function canonicalTuple(value: unknown, length: number, maximum = 2_048): unknown[] | null {
  if (typeof value !== "string" || value.length > maximum) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === length && JSON.stringify(parsed) === value ? parsed : null;
  } catch { return null; }
}
export function validGraphDayLabel(value: unknown): value is string {
  return typeof value === "string" && DAY.test(value)
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

/** Build the day-local plan signature for one plan anchor. */
export function graphDayPlanSignature(anchor: Pick<V11PlanAnchor, "contextKey" | "accountScopeId"
  | "planType" | "planVariant" | "continuityId" | "planBasis">): GraphDayPlanSignature {
  return JSON.stringify([anchor.contextKey, anchor.accountScopeId, anchor.planType,
    anchor.planVariant, anchor.continuityId, anchor.planBasis]);
}

export function validGraphDayPlanSignature(value: unknown): value is GraphDayPlanSignature {
  const fields = canonicalTuple(value, 6);
  if (!fields) return false;
  const [contextKey, accountScopeId, planType, planVariant, continuityId, planBasis] = fields;
  // One probe anchor through the acquisition reader's own anchor validator:
  // every field of a signature is a field of an anchor, and `conflicted` is
  // derived from `planBasis` exactly as the reader derives it.
  return validateV11QuotaWorkPart("plan-observations", [{
    contextKey, accountScopeId, planType, planVariant, continuityId, planBasis,
    observedAtMs: 0, conflicted: planBasis === "conflicted",
  }]);
}

export function validGraphDayPlanAnchors(value: unknown): value is GraphDayPlanAnchors {
  if (!closed(value, ["anchors"]) || !Array.isArray(value.anchors)
      || value.anchors.length > GRAPH_DAY_PLAN_ANCHOR_LIMIT
      || !validateV11QuotaWorkPart("plan-observations", value.anchors)) return false;
  let previous = -Infinity;
  for (const anchor of value.anchors as V11PlanAnchor[]) {
    if (anchor.observedAtMs < previous) return false;
    previous = anchor.observedAtMs;
  }
  return true;
}

export function validGraphDayRunKey(value: unknown): value is GraphDayRunKey {
  const fields = canonicalTuple(value, 2, 4_096);
  return !!fields && validGraphDayPlanSignature(fields[0]) && safeTime(fields[1]);
}

function validFitFragment(value: unknown): value is GraphDayFitFragment {
  if (!closed(value, ["signature", "runFirstObservedAtMs", "resetsAtMs", "minimum", "maximum", "values"])
      || !validGraphDayPlanSignature(value.signature) || !safeTime(value.runFirstObservedAtMs)
      || !safeTime(value.resetsAtMs)
      || !percent(value.minimum) || !percent(value.maximum) || value.minimum > value.maximum
      || !Array.isArray(value.values) || value.values.length < 1
      || value.values.length > QUOTA_CALIBRATION_POLICY.minimumBoundaries) return false;
  // The retained set is the numerically smallest distinct values, so it is
  // strictly ascending and always opens at the fragment's minimum.
  const values = value.values as unknown[];
  if (values[0] !== value.minimum) return false;
  let previous = -Infinity;
  for (const entry of values) {
    if (!percent(entry) || entry <= previous || entry > (value.maximum as number)) return false;
    previous = entry;
  }
  return true;
}

export function validGraphDayFitFragments(value: unknown): value is GraphDayFitFragments {
  if (!closed(value, ["fragments"]) || !Array.isArray(value.fragments)
      || value.fragments.length > GRAPH_DAY_FIT_FRAGMENT_LIMIT
      || !value.fragments.every(validFitFragment)) return false;
  let previous: string | null = null;
  for (const fragment of value.fragments as GraphDayFitFragment[]) {
    const key = graphDayFitFragmentOrder(fragment);
    if (previous !== null && key <= previous) return false;
    previous = key;
  }
  return true;
}

/** The canonical order of component 3: run before raw reset, so one run's
 * fragments stay contiguous and the fold reads them in hull order. */
export function graphDayFitFragmentOrder(fragment: Pick<GraphDayFitFragment,
  "signature" | "runFirstObservedAtMs" | "resetsAtMs">): string {
  return JSON.stringify([graphDayRunKey(fragment.signature, fragment.runFirstObservedAtMs),
    fragment.resetsAtMs]);
}

function validRunEndpoint(value: unknown): value is GraphDayRunEndpoint {
  if (!closed(value, ["signature", "runFirstObservedAtMs", "slot", "resetsAtMs", "sourceRowId",
    "observedAtMs", "usedPercent", "row"])
      || !validGraphDayPlanSignature(value.signature) || typeof value.slot !== "string"
      || !safeTime(value.runFirstObservedAtMs) || !safeTime(value.observedAtMs)
      || value.runFirstObservedAtMs > value.observedAtMs
      || !safeTime(value.resetsAtMs) || !percent(value.usedPercent)
      || !Number.isSafeInteger(value.sourceRowId) || (value.sourceRowId as number) <= 0
      || !closed(value.row, ["occurrence_id", "observed_at", "provider", "account_scope_id", "limit_id",
        "plan_type", "plan_variant", "continuity_id", "plan_basis", "slot", "used_percent",
        "window_duration_minutes", "resets_at"])) return false;
  const row = value.row as Record<string, unknown>;
  if (!validateV11QuotaWorkPart("endpoints",
    [{ id: value.sourceRowId, row: { ...row, plan_era_key: PROBE_ERA_KEY } }])) return false;
  // The denormalized key fields are the row's own, so a fold can key without
  // re-parsing and can never key on something the row does not say.
  return row.slot === value.slot && row.used_percent === value.usedPercent
    && Date.parse(row.observed_at as string) === value.observedAtMs
    && Date.parse(row.resets_at as string) === value.resetsAtMs
    && value.signature === graphDayPlanSignature({
      contextKey: `${row.provider as string}|${row.limit_id as string}`,
      accountScopeId: row.account_scope_id as string | null,
      planType: row.plan_type as string, planVariant: row.plan_variant as string,
      continuityId: row.continuity_id as string | null,
      planBasis: row.plan_basis as V11PlanAnchor["planBasis"],
    });
}

export function validGraphDayRunEndpoints(value: unknown): value is GraphDayRunEndpoints {
  if (!closed(value, ["endpoints"]) || !Array.isArray(value.endpoints)
      || value.endpoints.length > GRAPH_DAY_RUN_ENDPOINT_LIMIT
      || !value.endpoints.every(validRunEndpoint)) return false;
  const endpoints = value.endpoints as GraphDayRunEndpoint[];
  let previous: readonly [number, number] | null = null;
  for (const endpoint of endpoints) {
    if (previous !== null && (endpoint.observedAtMs < previous[0]
      || endpoint.observedAtMs === previous[0] && endpoint.sourceRowId <= previous[1])) return false;
    previous = [endpoint.observedAtMs, endpoint.sourceRowId];
  }
  // One source row carries one slot and one restated reset, so it reaches one
  // key and survives collapse at most once.
  return new Set(endpoints.map((endpoint) => endpoint.sourceRowId)).size === endpoints.length;
}

function validAttribution(value: Record<string, unknown>): boolean {
  return typeof value.provider === "string" && SAFE_TOKEN.test(value.provider)
    && (value.accountScopeId === null
      || typeof value.accountScopeId === "string" && ACCOUNT_TRACK.test(value.accountScopeId))
    && [null, "unavailable", "same_source_occurrence", "provisional_marker", "conflicted"]
      .includes(value.planBasis as string | null)
    && (value.planType === null || typeof value.planType === "string" && SAFE_TOKEN.test(value.planType))
    && (value.planEraId === null || typeof value.planEraId === "string" && PLAN_ERA.test(value.planEraId));
}
function validCost(model: unknown, costNanousd: unknown): boolean {
  return (model === null || typeof model === "string" && model.length >= 1 && model.length <= 256)
    && Number.isSafeInteger(costNanousd) && (costNanousd as number) >= 0
    // The kernel refuses a reduction above this ceiling, so a day that cannot
    // be summed below it is refused when it is built, never rounded.
    && (costNanousd as number) <= GRAPH_DAY_USAGE_COST_CEILING
    && (model !== null || costNanousd === 0);
}
function inDayBin(binStartMs: unknown, day: string): boolean {
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  return safeTime(binStartMs) && (binStartMs - dayStart) % MODEL_COMPOSITION_POLICY.grainMs === 0
    && binStartMs >= dayStart && binStartMs < dayStart + 86_400_000;
}
/** The canonical order of the usage cells: bin, then attribution, then the
 * break flag, then model — so one bin's cells stay contiguous. */
export const graphDayUsageCellOrder = (cell: GraphDayUsageCell): string => JSON.stringify([cell.binStartMs,
  cell.provider, cell.accountScopeId, cell.planBasis, cell.planType, cell.planEraId,
  cell.accountBreak, cell.model]);

function validUsageCell(value: unknown, day: string): value is GraphDayUsageCell {
  return closed(value, ["binStartMs", "provider", "accountScopeId", "planBasis", "planType",
    "planEraId", "accountBreak", "model", "costNanousd", "eventCount"])
    && validAttribution(value) && inDayBin(value.binStartMs, day)
    && typeof value.accountBreak === "boolean" && validCost(value.model, value.costNanousd)
    && Number.isSafeInteger(value.eventCount) && (value.eventCount as number) >= 1;
}
function validUsageOpener(value: unknown, day: string): value is GraphDayUsageOpener {
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  return closed(value, ["sessionDigest", "binStartMs", "observedAtMs", "provider", "accountScopeId",
    "planBasis", "planType", "planEraId", "model", "costNanousd"])
    && typeof value.sessionDigest === "string" && HEX_DIGEST.test(value.sessionDigest)
    && validAttribution(value) && inDayBin(value.binStartMs, day)
    && safeTime(value.observedAtMs) && value.observedAtMs >= dayStart
    && value.observedAtMs < dayStart + 86_400_000
    && (value.observedAtMs as number) - (value.binStartMs as number) >= 0
    && (value.observedAtMs as number) - (value.binStartMs as number) < MODEL_COMPOSITION_POLICY.grainMs
    && validCost(value.model, value.costNanousd);
}
function validUsageSession(value: unknown, day: string): value is GraphDayUsageSession {
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  return closed(value, ["sessionDigest", "lastObservedAtMs", "lastAccountScopeId"])
    && typeof value.sessionDigest === "string" && HEX_DIGEST.test(value.sessionDigest)
    && safeTime(value.lastObservedAtMs) && value.lastObservedAtMs >= dayStart
    && value.lastObservedAtMs < dayStart + 86_400_000
    && (value.lastAccountScopeId === null || typeof value.lastAccountScopeId === "string"
      && ACCOUNT_TRACK.test(value.lastAccountScopeId));
}

export function validGraphDayUsageFragments(value: unknown, day: string): value is GraphDayUsageFragments {
  if (!validGraphDayLabel(day) || !closed(value, ["cells", "openers", "sessions", "rowsRead"])
      || !Number.isSafeInteger(value.rowsRead) || (value.rowsRead as number) < 0
      || !Array.isArray(value.cells) || !Array.isArray(value.openers) || !Array.isArray(value.sessions)
      || value.cells.length > GRAPH_DAY_USAGE_CELL_LIMIT
      || value.openers.length > GRAPH_DAY_USAGE_SESSION_LIMIT
      || value.sessions.length > GRAPH_DAY_USAGE_SESSION_LIMIT
      || !value.cells.every((cell: unknown) => validUsageCell(cell, day))
      || !value.openers.every((opener: unknown) => validUsageOpener(opener, day))
      || !value.sessions.every((session: unknown) => validUsageSession(session, day))) return false;
  let previous: string | null = null;
  for (const cell of value.cells as GraphDayUsageCell[]) {
    const key = graphDayUsageCellOrder(cell);
    if (previous !== null && key <= previous) return false;
    previous = key;
  }
  previous = null;
  for (const opener of value.openers as GraphDayUsageOpener[]) {
    if (previous !== null && opener.sessionDigest <= previous) return false;
    previous = opener.sessionDigest;
  }
  previous = null;
  for (const session of value.sessions as GraphDayUsageSession[]) {
    if (previous !== null && session.sessionDigest <= previous) return false;
    previous = session.sessionDigest;
  }
  // An opener is by construction an event of a session the day saw, so its
  // carry-out must exist: otherwise the fold would decide `accountBreak` from
  // a carry the day never closed.
  const sessions = new Set((value.sessions as GraphDayUsageSession[]).map((session) => session.sessionDigest));
  if (!(value.openers as GraphDayUsageOpener[]).every((opener) => sessions.has(opener.sessionDigest))) return false;
  // The retained components are a lower bound on the read, so a count below
  // them is not an understatement the fold could tolerate: it is a wrong count.
  const retained = (value.cells as GraphDayUsageCell[]).reduce((total, cell) => total + cell.eventCount, 0)
    + (value.openers as GraphDayUsageOpener[]).length;
  return (value.rowsRead as number) >= retained;
}

/**
 * The whole artifact, closed: an unknown key anywhere refuses.
 *
 * Plus one cross-component rule the fold depends on and cannot recover from:
 * every run that carries a fit fragment must also carry at least one run
 * endpoint. The fold resolves a run's window era from its endpoints' observed
 * instants, so a fragment for a run with no retained endpoint is evidence the
 * fold can neither place nor ignore.
 */
export function validGraphDayProjection(value: unknown): value is GraphDayProjection {
  if (!closed(value, ["version", "day", "planAnchors", "fitFragments", "runEndpoints", "usage"])
    || value.version !== GRAPH_DAY_PROJECTION_VERSION || !validGraphDayLabel(value.day)
    || !validGraphDayPlanAnchors(value.planAnchors)
    || !validGraphDayFitFragments(value.fitFragments) || !validGraphDayRunEndpoints(value.runEndpoints)
    || !validGraphDayUsageFragments(value.usage, value.day)) return false;
  const resolvable = new Set((value.runEndpoints as GraphDayRunEndpoints).endpoints
    .map((endpoint) => graphDayRunKey(endpoint.signature, endpoint.runFirstObservedAtMs)));
  return (value.fitFragments as GraphDayFitFragments).fragments.every((fragment) =>
    resolvable.has(graphDayRunKey(fragment.signature, fragment.runFirstObservedAtMs)));
}

/** Retained entries across every component, including the single-entry
 * `usageRowsRead` component. This is the row count the store records, not a count of source records: a prepared day deliberately retains
 * far fewer entries than the rows it reduced.
 *
 * It counts COMPONENT ENTRIES, which is what the framer pages and what the
 * completeness trigger sums, so one hull group counts once however many pools
 * it holds. Counting intervals instead made the two disagree for every day
 * whose run mixed `five_hour` and `seven_day` resets — the signature carries no
 * slot — and the trigger then refused to promote it. */
export function graphDayProjectionRecordCount(projection: GraphDayProjection): number {
  return 1 + projection.planAnchors.anchors.length
    + projection.fitFragments.fragments.length
    + projection.runEndpoints.endpoints.length
    + projection.usage.cells.length + projection.usage.openers.length
    + projection.usage.sessions.length;
}

/** The component arrays, in framing order. */
export function graphDayProjectionComponentEntries(
  projection: GraphDayProjection,
): Array<[GraphDayProjectionComponent, readonly unknown[]]> {
  return [
    ["planAnchors", projection.planAnchors.anchors],
    ["fitFragments", projection.fitFragments.fragments],
    ["runEndpoints", projection.runEndpoints.endpoints],
    ["usageCells", projection.usage.cells],
    ["usageOpeners", projection.usage.openers],
    ["usageSessions", projection.usage.sessions],
    ["usageRowsRead", [projection.usage.rowsRead]],
  ];
}

/** Reassemble a projection from framed component arrays. The result is not
 * trusted until `validGraphDayProjection` and the payload digest both pass. */
export function graphDayProjectionFromComponents(day: string,
  components: Partial<Record<GraphDayProjectionComponent, unknown[]>>): unknown {
  return {
    version: GRAPH_DAY_PROJECTION_VERSION, day,
    planAnchors: { anchors: components.planAnchors ?? [] },
    fitFragments: { fragments: components.fitFragments ?? [] },
    runEndpoints: { endpoints: components.runEndpoints ?? [] },
    usage: { cells: components.usageCells ?? [], openers: components.usageOpeners ?? [],
      sessions: components.usageSessions ?? [],
      // Absent or repeated leaves this not-a-number, which the validator
      // refuses: a missing read count must never decode as zero.
      rowsRead: components.usageRowsRead?.length === 1 ? components.usageRowsRead[0] : undefined },
  };
}
