import { MODEL_COMPOSITION_POLICY, QUOTA_CALIBRATION_POLICY } from "@app-usagemonitor/quota-analysis";

/** Quota pools restate `resets_at` with seconds-to-minutes jitter and spawn a
 * fresh pool hours to days away. Only the tolerance is shared with the
 * maintained composition, which groups by `planType` and labels a pool by its
 * cluster start; the acquisition groups by `eraKey`, a refinement of that, and
 * labels a pool by its cluster maximum so an acquired row keeps `resets_at`
 * after `observed_at`. Both then stop fragmenting one pool per instant. */
export const QUOTA_RESET_CLUSTER_TOLERANCE_MS = MODEL_COMPOSITION_POLICY.poolToleranceMs;
/** A dense owner restates `used_percent` every few tens of seconds, so run
 * endpoints alone outgrow every downsampling bound. Retained endpoints are
 * thinned to this spacing per key; the first and the final endpoint of each key
 * are always kept, so the exact last state is never lost and an owner whose
 * changes are already further apart than this is unaffected. */
export const QUOTA_ENDPOINT_MIN_SPACING_MS = 10 * 60 * 1_000;
/** Spacing only engages once a key holds the boundaries the shared calibration
 * refuses below. Fitability admits a reset group on the distinct displayed
 * values of every row, so thinning a burst that carried all of them would
 * retain a pool the calibration then calls `not_testable`: eligibility and the
 * fit would disagree about the same evidence. Keeping the first
 * `minimumBoundaries` distinct displayed values of each key at full resolution
 * costs a fixed handful of rows per pool and leaves a dense owner's reduction
 * intact. Endpoints are counted by displayed value, not by row, because a run's
 * first and last row carry the same value and would otherwise satisfy the
 * bound without carrying a single extra boundary. */
export const QUOTA_ENDPOINT_MINIMUM_RETAINED = QUOTA_CALIBRATION_POLICY.minimumBoundaries;
/** Distinct pools one owner may hold across every group. Real owners hold a
 * handful; this only stops a corrupt source from turning jitter into state. */
export const QUOTA_RESET_CLUSTER_LIMIT = 4_096;

const MIN_TIME = -8_640_000_000_000_000;
const MAX_TIME = 8_640_000_000_000_000;
const safeTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_TIME && value <= MAX_TIME;

/** One pool: the closed hull of the reset instants single-linkage joined it. */
export type QuotaResetInterval = [minMs: number, maxMs: number];
export type QuotaResetClusterEntry = [group: string, intervals: QuotaResetInterval[]];
export interface QuotaResetClusterState {
  groups: Map<string, QuotaResetInterval[]>;
  count: number;
}

export function createQuotaResetClusterState(
  entries: readonly QuotaResetClusterEntry[] = [],
): QuotaResetClusterState {
  const groups = new Map<string, QuotaResetInterval[]>();
  let count = 0;
  for (const [group, intervals] of entries) {
    groups.set(group, intervals.map((interval) => [interval[0], interval[1]] as QuotaResetInterval));
    count += intervals.length;
  }
  return { groups, count };
}

/** Canonical serialization: groups and hulls in sorted order, so the same set
 * of observed resets always frames to the same bytes whatever order the pages
 * delivered them in. That is what lets a promoted successor be reproduced. */
export function quotaResetClusterEntries(state: QuotaResetClusterState): QuotaResetClusterEntry[] {
  return [...state.groups.entries()]
    .map(([group, intervals]) => [group, [...intervals]
      .sort((left, right) => left[0] - right[0] || left[1] - right[1])] as QuotaResetClusterEntry)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
}

/** Add one observed reset instant to its group. Merging every hull the new
 * instant is within tolerance of is exactly single-linkage clustering, which
 * depends only on the set of instants and not on the order they arrive in:
 * a hull's own minimum and maximum are always members, an instant outside a
 * hull joins only within tolerance of one of them, and an instant inside a
 * hull is within tolerance of some member because consecutive members are.
 * Returns false when the owner would exceed the pool bound. */
export function addQuotaReset(state: QuotaResetClusterState, group: string, resetMs: number,
  limit = QUOTA_RESET_CLUSTER_LIMIT): boolean {
  const intervals = state.groups.get(group);
  if (intervals === undefined) {
    if (state.count + 1 > limit) return false;
    state.groups.set(group, [[resetMs, resetMs]]);
    state.count += 1;
    return true;
  }
  let minMs = resetMs, maxMs = resetMs, merged = 0;
  const kept: QuotaResetInterval[] = [];
  for (const interval of intervals) {
    if (resetMs >= interval[0] - QUOTA_RESET_CLUSTER_TOLERANCE_MS
        && resetMs <= interval[1] + QUOTA_RESET_CLUSTER_TOLERANCE_MS) {
      if (interval[0] < minMs) minMs = interval[0];
      if (interval[1] > maxMs) maxMs = interval[1];
      merged += 1;
    } else kept.push(interval);
  }
  if (merged === 0 && state.count + 1 > limit) return false;
  kept.push([minMs, maxMs]);
  state.groups.set(group, kept);
  state.count += 1 - merged;
  return true;
}

/** The pool's representative instant: the largest reset any member restated.
 * Every member was observed strictly before its own reset, so the maximum is
 * strictly after every observation in the pool and the acquired row keeps the
 * `resets_at > observed_at` guarantee the calibration depends on. Null means
 * the instant was never clustered, which is a caller bug rather than data. */
export function quotaResetRepresentativeMs(state: QuotaResetClusterState, group: string,
  resetMs: number): number | null {
  for (const interval of state.groups.get(group) ?? []) {
    if (resetMs >= interval[0] && resetMs <= interval[1]) return interval[1];
  }
  return null;
}

export function validQuotaResetClusterEntries(value: unknown, limit = QUOTA_RESET_CLUSTER_LIMIT): boolean {
  if (!Array.isArray(value) || value.length > limit) return false;
  const groups = new Set<string>();
  let count = 0;
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string"
        || entry[0].length > 1_024 || groups.has(entry[0]) || !Array.isArray(entry[1])) return false;
    groups.add(entry[0]);
    let previous = -Infinity;
    for (const interval of entry[1] as unknown[]) {
      if (!Array.isArray(interval) || interval.length !== 2 || !safeTime(interval[0])
          || !safeTime(interval[1]) || interval[0] > interval[1]
          // Sorted, disjoint and never within tolerance of each other: two
          // hulls that close would have been one pool.
          || interval[0] - previous <= QUOTA_RESET_CLUSTER_TOLERANCE_MS) return false;
      previous = interval[1];
      count += 1;
    }
  }
  return count <= limit;
}

/** Fragment statistics for one clustered reset group, in the shape the shared
 * calibration refuses on: enough distinct displayed values and enough span. */
export interface QuotaFragmentStats {
  values: number[];
  minimum: number;
  maximum: number;
}

export function addQuotaFragmentValue(stats: Map<string, QuotaFragmentStats>, key: string,
  usedPercent: number): void {
  const stat = stats.get(key);
  if (stat === undefined) {
    stats.set(key, { values: [usedPercent], minimum: usedPercent, maximum: usedPercent });
    return;
  }
  if (usedPercent < stat.minimum) stat.minimum = usedPercent;
  if (usedPercent > stat.maximum) stat.maximum = usedPercent;
  if (stat.values.length < QUOTA_CALIBRATION_POLICY.minimumBoundaries
      && !stat.values.includes(usedPercent)) stat.values.push(usedPercent);
}

/** The exact refusal the direct SQL used to apply in its `fitable` stage. It
 * is evaluated in JS now so the same clustered key decides it on both paths. */
export function quotaFragmentEligible(stat: QuotaFragmentStats): boolean {
  return stat.values.length >= QUOTA_CALIBRATION_POLICY.minimumBoundaries
    && stat.maximum - stat.minimum >= QUOTA_CALIBRATION_POLICY.minimumDisplayedSpanPp;
}

/** Streaming run collapse plus endpoint spacing for one key. `keptAtMs` is the
 * observation of the last endpoint actually emitted for the key and `pending`
 * the most recent one spacing held back, which becomes the key's final
 * endpoint if nothing later is emitted. */
export interface QuotaEndpointRun<E> {
  firstId: number;
  last: E;
  keptAtMs: number;
  keptValues: number[];
  keptMinimum: number;
  keptMaximum: number;
  holdMinimum: E | null;
  holdMaximum: E | null;
  pending: E | null;
}
export interface QuotaEndpointView {
  id: number;
  observedAtMs: number;
  usedPercent: number;
}

function offer<E>(run: QuotaEndpointRun<E>, candidate: E, view: (value: E) => QuotaEndpointView,
  emit: (value: E) => boolean, spacingMs: number, minimumRetained: number): boolean {
  const seen = view(candidate);
  if (run.keptValues.length >= minimumRetained && seen.observedAtMs - run.keptAtMs < spacingMs) {
    // Fitability admitted this pool on the displayed span of every row, so the
    // rows carrying the extremes must survive the thinning or the calibration
    // measures a narrower span than the eligibility decision was made on.
    // Holding only the current extremes, rather than emitting every new one,
    // keeps a monotone pool thinned: a quota that only rises would otherwise
    // make every run boundary an extreme and never thin at all.
    run.pending = candidate;
    if (seen.usedPercent < run.keptMinimum
        && (run.holdMinimum === null || seen.usedPercent < view(run.holdMinimum).usedPercent)) {
      run.holdMinimum = candidate;
    }
    if (seen.usedPercent > run.keptMaximum
        && (run.holdMaximum === null || seen.usedPercent > view(run.holdMaximum).usedPercent)) {
      run.holdMaximum = candidate;
    }
    return true;
  }
  if (!emit(candidate)) return false;
  run.keptAtMs = seen.observedAtMs;
  if (seen.usedPercent < run.keptMinimum) run.keptMinimum = seen.usedPercent;
  if (seen.usedPercent > run.keptMaximum) run.keptMaximum = seen.usedPercent;
  if (run.holdMinimum !== null && view(run.holdMinimum).usedPercent >= run.keptMinimum) run.holdMinimum = null;
  if (run.holdMaximum !== null && view(run.holdMaximum).usedPercent <= run.keptMaximum) run.holdMaximum = null;
  if (run.keptValues.length < minimumRetained && !run.keptValues.includes(seen.usedPercent)) {
    run.keptValues.push(seen.usedPercent);
  }
  run.pending = null;
  return true;
}

/** Offer one acquired row to its key. A run of equal `used_percent` keeps only
 * its first and last row, and those candidates are then thinned to the minimum
 * spacing. `emit` returns false when the caller's own bound is exceeded. */
export function collapseQuotaEndpoint<E>(runs: Map<string, QuotaEndpointRun<E>>, key: string,
  endpoint: E, view: (value: E) => QuotaEndpointView, emit: (value: E) => boolean,
  spacingMs = QUOTA_ENDPOINT_MIN_SPACING_MS, minimumRetained = QUOTA_ENDPOINT_MINIMUM_RETAINED): boolean {
  const seen = view(endpoint);
  const run = runs.get(key);
  if (run === undefined) {
    if (!emit(endpoint)) return false;
    runs.set(key, { firstId: seen.id, last: endpoint, keptAtMs: seen.observedAtMs,
      keptValues: [seen.usedPercent], keptMinimum: seen.usedPercent, keptMaximum: seen.usedPercent,
      holdMinimum: null, holdMaximum: null, pending: null });
    return true;
  }
  if (view(run.last).usedPercent === seen.usedPercent) {
    run.last = endpoint;
    return true;
  }
  if (view(run.last).id !== run.firstId
      && !offer(run, run.last, view, emit, spacingMs, minimumRetained)) return false;
  if (!offer(run, endpoint, view, emit, spacingMs, minimumRetained)) return false;
  run.firstId = seen.id;
  run.last = endpoint;
  return true;
}

/** Close every open run. Each key's final endpoint is emitted even when the
 * spacing rule held it back, so the last observed state stays exact. */
export function finishQuotaEndpoints<E>(runs: Map<string, QuotaEndpointRun<E>>,
  view: (value: E) => QuotaEndpointView, emit: (value: E) => boolean,
  spacingMs = QUOTA_ENDPOINT_MIN_SPACING_MS, minimumRetained = QUOTA_ENDPOINT_MINIMUM_RETAINED): boolean {
  for (const run of runs.values()) {
    if (view(run.last).id !== run.firstId
        && !offer(run, run.last, view, emit, spacingMs, minimumRetained)) return false;
    // The key's final endpoint and the rows carrying its displayed extremes,
    // each emitted once however many of those roles one row holds.
    const closing: E[] = [];
    for (const held of [run.pending, run.holdMinimum, run.holdMaximum]) {
      if (held !== null && !closing.some((value) => view(value).id === view(held).id)) closing.push(held);
    }
    run.pending = null;
    run.holdMinimum = null;
    run.holdMaximum = null;
    for (const value of closing) if (!emit(value)) return false;
  }
  runs.clear();
  return true;
}

/** The whole collapse over an ordered batch, for callers that already hold the
 * rows. It drives the same two streaming entry points the paged acquisition
 * uses, so a direct read and a resumed acquisition cannot diverge. */
export function collapseQuotaEndpointStream<E>(rows: readonly E[], key: (value: E) => string,
  view: (value: E) => QuotaEndpointView, spacingMs = QUOTA_ENDPOINT_MIN_SPACING_MS,
  minimumRetained = QUOTA_ENDPOINT_MINIMUM_RETAINED): E[] {
  const runs = new Map<string, QuotaEndpointRun<E>>();
  const kept: E[] = [];
  const emit = (value: E) => { kept.push(value); return true; };
  for (const row of rows) collapseQuotaEndpoint(runs, key(row), row, view, emit, spacingMs, minimumRetained);
  finishQuotaEndpoints(runs, view, emit, spacingMs, minimumRetained);
  return kept.sort((left, right) => view(left).observedAtMs - view(right).observedAtMs
    || view(left).id - view(right).id);
}
