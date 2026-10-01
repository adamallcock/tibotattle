import { MODEL_COMPOSITION_POLICY } from "@app-usagemonitor/quota-analysis";
import { priceChunkUsageRecord, type V1PreparedUsageFragment, type WindowedUsageRow } from "./quota-analysis-v1";
import type { V1FitSourceRow, V1PlanSourceRow } from "./quota-analysis-v1-reader";

export interface PreparationQuotaRow extends V1PlanSourceRow {
  occurrence_id: string;
  slot: string | null;
  used_percent: number | null;
  window_duration_minutes: number | null;
  resets_at: string | null;
}

export interface PreparedQuotaRuns {
  plan: { first: V1PlanSourceRow; last: V1PlanSourceRow } | null;
  fit: { first: V1FitSourceRow; last: V1FitSourceRow } | null;
  lastTime: string | null;
  lastSignature: string | null;
  equalTimeChanged: boolean;
}

const label = (row: V1PlanSourceRow) => JSON.stringify([row.provider, row.limit_id, row.plan_type, row.plan_variant]);
const fitLabel = (row: V1FitSourceRow) => JSON.stringify([label(row), row.slot,
  row.used_percent, row.window_duration_minutes, row.resets_at]);

function fitRow(row: PreparationQuotaRow): V1FitSourceRow | null {
  if (row.limit_id !== "codex" || row.window_duration_minutes !== 10080 || row.provider === null
    || row.plan_type === null || row.plan_variant === null || row.slot === null
    || row.used_percent === null || row.resets_at === null) return null;
  return { ...row, provider: row.provider, limit_id: row.limit_id, plan_type: row.plan_type, plan_variant: row.plan_variant,
    slot: row.slot, used_percent: row.used_percent, window_duration_minutes: 10080, resets_at: row.resets_at };
}

/** Conservative chronological run compression, independent of a target window.
 * Keep first AND last, and split at every intervening plan signature, including
 * short-window/unknown/conflicting quota. Interleaved slots and reset groups
 * may retain extra rows; only the unchanged acquisition engine decides whether
 * to collapse those. No distinct-percent, fitability, count or cap is changed.
 */
export function prepareQuotaPage(rows: readonly PreparationQuotaRow[], runs: PreparedQuotaRuns,
  complete: boolean): { plans: V1PlanSourceRow[]; fits: V1FitSourceRow[] } {
  const plans: V1PlanSourceRow[] = [], fits: V1FitSourceRow[] = [];
  const flushPlan = () => {
    if (runs.plan) {
      plans.push(runs.plan.first);
      if (runs.plan.last.id !== runs.plan.first.id) plans.push(runs.plan.last);
      runs.plan = null;
    }
  };
  const flushFit = () => {
    if (runs.fit) {
      fits.push(runs.fit.first);
      if (runs.fit.last.id !== runs.fit.first.id) fits.push(runs.fit.last);
      runs.fit = null;
    }
  };
  for (const row of rows) {
    const signature = label(row);
    if (runs.lastTime !== row.observed_at) {
      // A conflicting timestamp is an indivisible plan barrier. Its matching
      // label cannot stand in for the first observation AFTER the conflict.
      // This flag survives page boundaries, including A/B/A equal-time ties.
      if (runs.equalTimeChanged) { flushPlan(); flushFit(); }
      runs.lastTime = row.observed_at; runs.equalTimeChanged = false;
    } else if (runs.lastSignature !== signature) runs.equalTimeChanged = true;
    runs.lastSignature = signature;
    // Non-codex observations are ignored by the plan engine, but conservatively
    // break preparation runs: this can only retain a superset of its inputs.
    if (runs.fit && label(runs.fit.last) !== label(row)) flushFit();
    if (row.limit_id === "codex") {
      const plan: V1PlanSourceRow = { id: row.id, observed_at: row.observed_at, observed_day: row.observed_day,
        device_id: row.device_id, provider: row.provider, limit_id: row.limit_id,
        plan_type: row.plan_type, plan_variant: row.plan_variant };
      if (runs.plan && label(runs.plan.last) === label(plan)) runs.plan.last = plan;
      else { flushPlan(); runs.plan = { first: plan, last: plan }; }
    }
    const fit = fitRow(row);
    if (fit) {
      if (runs.fit && fitLabel(runs.fit.last) === fitLabel(fit)) runs.fit.last = fit;
      else { flushFit(); runs.fit = { first: fit, last: fit }; }
    }
  }
  if (complete) {
    flushPlan(); flushFit();
    runs.lastTime = null; runs.lastSignature = null; runs.equalTimeChanged = false;
  }
  return { plans, fits };
}

const SAFE_TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/u;

/** Each fragment is bounded by ONE physical page, not a whole day's model or
 * provider cardinality. Later fragments merge in integer nanodollars; a late
 * poison still discards the complete bin before any overflow refusal. */
export function prepareUsagePage(rows: readonly WindowedUsageRow[]): {
  prices: WindowedUsageRow[]; fragments: V1PreparedUsageFragment[];
} {
  const prices: WindowedUsageRow[] = [], fragments = new Map<string, V1PreparedUsageFragment>();
  const cells = new Map<V1PreparedUsageFragment, Map<string, V1PreparedUsageFragment["cells"][number]>>();
  for (const row of rows) {
    const priced = priceChunkUsageRecord(row.record_json, row.observed_at);
    prices.push({ ...row, record_json: "", preparedPrice: priced });
    if (!SAFE_TOKEN.test(row.provider) || !Number.isFinite(Date.parse(row.observed_at)) || priced === null) continue;
    const binStartMs = Math.floor(Date.parse(row.observed_at) / MODEL_COMPOSITION_POLICY.grainMs) * MODEL_COMPOSITION_POLICY.grainMs;
    const key = JSON.stringify([binStartMs, row.provider]);
    let fragment = fragments.get(key);
    if (!fragment) {
      fragment = { id: row.id, observed_at: new Date(binStartMs).toISOString(), provider: row.provider,
        binStartMs, usageEventCount: 0, unpricedUsageEventCount: 0, cells: [] };
      fragments.set(key, fragment); cells.set(fragment, new Map());
    }
    if (priced.pricingStatus !== "fully_priced") { fragment.unpricedUsageEventCount += 1; continue; }
    fragment.usageEventCount += 1;
    const model = priced.modelId ?? "unknown", modelCells = cells.get(fragment)!;
    const old = modelCells.get(model), valid = Number.isSafeInteger(priced.costNanousd) && priced.costNanousd >= 0;
    if (old) {
      if (!valid || priced.costNanousd > Number.MAX_SAFE_INTEGER - old.costNanousd) old.overflowed = true;
      else if (!old.overflowed) old.costNanousd += priced.costNanousd;
      if (row.observed_at < old.firstObservedAt || row.observed_at === old.firstObservedAt && row.occurrence_id < old.firstOccurrenceId) {
        old.firstObservedAt = row.observed_at; old.firstOccurrenceId = row.occurrence_id;
      }
    } else modelCells.set(model, { model, costNanousd: valid ? priced.costNanousd : 0, overflowed: !valid,
      firstObservedAt: row.observed_at, firstOccurrenceId: row.occurrence_id });
  }
  for (const fragment of fragments.values()) fragment.cells = [...cells.get(fragment)!.values()];
  return { prices, fragments: [...fragments.values()] };
}
