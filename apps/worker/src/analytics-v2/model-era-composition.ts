/**
 * GCP model composition for owners with more than one account/plan era.
 * The old one-era kernel remains the fast path and its answer is unchanged.
 * This extension resolves every quantity against the FULL plan index before
 * reducing it into an isolated era. It never feeds filtered anchors back into
 * attribution, and never uses the lossy prepared two-hour cells for this path.
 */
import {
  createV11UsageModelState,
  MAX_V11_USAGE_CHECKPOINT_BYTES,
  MAX_WINDOWED_USAGE_ROWS,
  MODEL_COMPOSITION_POLICY,
  quotaContext,
  reduceV11UsageModelEvent,
  usageEventSync,
  v11ModelCompositionFromModelHalf,
  v11UsageModelHalf,
  type UsageRow,
  type V11CompletedQuotaAcquisition,
  type V11SourcePin,
  type V11UsageModelState,
  type V1ModelCompositionResult,
} from "../../vendor/analytics-d43c8f92/entry";

export const ANALYTICS_V2_PLAN_ERA_COMPOSITION_VERSION = "analytics-v2-plan-era-composition-v1" as const;
export interface AnalyticsV2ModelEraCandidate {
  readonly candidateId: string;
  readonly composition: V1ModelCompositionResult;
  readonly excludedAttributionBinCount: number;
  readonly excludedBoundaryBinCount: number;
}
export interface AnalyticsV2PartitionedModelComposition {
  readonly schemaVersion: typeof ANALYTICS_V2_PLAN_ERA_COMPOSITION_VERSION;
  readonly status: "partitioned";
  readonly inputFingerprint: string;
  readonly candidates: readonly AnalyticsV2ModelEraCandidate[];
}
export type AnalyticsV2ModelCompositionResult = V1ModelCompositionResult | AnalyticsV2PartitionedModelComposition;

export function modelCompositionNeedsEraPartition(value: V1ModelCompositionResult): boolean {
  return value.status === "not_testable" && ["multi_plan_window_unsupported",
    "multi_account_window_unsupported", "multi_era_window_unsupported"].includes(value.reason);
}

const NO_DB = { prepare(): never { throw new Error("ANALYTICS_V2_MODEL_ERA_UNEXPECTED_DATABASE_READ"); } } as unknown as D1Database;
const GRAIN = MODEL_COMPOSITION_POLICY.grainMs;
const MAX_CELLS = 120_000;
const MAX_HAZARDS = 240_000;
const encoder = new TextEncoder();
const bytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;
const refused = (reason: string): V1ModelCompositionResult => ({ status: "not_testable", reason });
type Context = Exclude<Awaited<ReturnType<typeof quotaContext>>, { status: "not_testable" }>;
type Seed = Context["seeds"] extends Map<string, infer S> ? S : never;
type Era = Context["index"]["eras"][number];
type Range = { start: number; end: number };
type HazardTargets = "possible" | "known" | "unknown";

/** Exact byte accounting without repeatedly serializing a growing session map.
 * The reused resolver replaces session values; it never mutates them in place. */
class SessionCarry extends Map<string, { time: number; scope: string | null }> {
  bytes = 2;
  override set(key: string, value: { time: number; scope: string | null }): this {
    const old = super.get(key);
    this.bytes += bytes([key, value]) - (old === undefined ? 0 : bytes([key, old]));
    if (old === undefined && this.size > 0) this.bytes += 1;
    return super.set(key, value);
  }
}

/** End-ordered intervals merge online. Known foreign accounts are separate;
 * unknown scope or an account change can affect every account of the provider. */
class AttributionHazards {
  private groups = new Map<string, { provider: string; scope: string | null; targets: HazardTargets; ranges: Range[] }>();
  count = 0;
  bytes = 2;
  add(provider: string, scope: string | null, interval: Range, targets: HazardTargets = "possible"): void {
    const key = JSON.stringify([provider, scope, targets]);
    let group = this.groups.get(key);
    if (group === undefined) {
      group = { provider, scope, targets, ranges: [] };
      this.bytes += bytes([key, group]) + (this.groups.size > 0 ? 1 : 0);
      this.groups.set(key, group);
    }
    const merged = { ...interval };
    while (group.ranges.length > 0 && group.ranges.at(-1)!.end >= merged.start) {
      const last = group.ranges.pop()!;
      merged.start = Math.min(merged.start, last.start);
      this.bytes -= bytes(last) + (group.ranges.length > 0 ? 1 : 0);
      this.count -= 1;
    }
    this.bytes += bytes(merged) + (group.ranges.length > 0 ? 1 : 0);
    group.ranges.push(merged);
    this.count += 1;
  }
  bins(seed: Seed, firstBin: number, binCount: number): Uint8Array {
    const excluded = new Uint8Array(binCount);
    for (const group of this.groups.values()) {
      if (group.targets === "known" && seed.accountScopeId === null
          || group.targets === "unknown" && seed.accountScopeId !== null) continue;
      if (group.provider !== seed.provider || seed.accountScopeId !== null && group.scope !== null
          && seed.accountScopeId !== group.scope) continue;
      for (const range of group.ranges) {
        // Include both boundary bins conservatively. No ambiguous quantity is
        // moved to its endpoint or prorated across a plan/account transition.
        const first = Math.max(0, Math.floor((range.start - firstBin) / GRAIN));
        // A quota crossing is assigned to its END bin. Every retained crossing
        // is at most maxCrossingElapsedMs long; padding the hazard through that
        // bound also removes later-bin movements whose bracketing interval
        // intersects the ambiguity. Longer crossings are voided by the kernel.
        const last = Math.min(binCount - 1,
          Math.floor((range.end + MODEL_COMPOSITION_POLICY.maxCrossingElapsedMs - firstBin) / GRAIN));
        if (last >= first) excluded.fill(1, first, last + 1);
      }
    }
    return excluded;
  }
}

interface Candidate {
  seed: Seed;
  era: Era;
  quota: Context["quota"];
  state: V11UsageModelState;
}

/** Pure, bounded one-date evaluation. No persisted legacy checkpoint is
 * resumed under this contract; the kernel closure identifies its cached rows. */
export async function evaluateAnalyticsV2PlanEraComposition(input: {
  readonly pin: V11SourcePin;
  readonly nowMs: number;
  readonly quotaAcquisition: V11CompletedQuotaAcquisition;
  readonly days: readonly { readonly day: string; readonly usageRows: readonly UsageRow[] }[];
}): Promise<AnalyticsV2ModelCompositionResult> {
  const context = await quotaContext(NO_DB, input.pin, input);
  if ("status" in context) return context;
  if (context.seeds.size === 0) return refused("supported_quota_track_unavailable");
  let rows = 0;
  let priorDay = "";
  for (const day of input.days) {
    if (day.day <= priorDay || day.day < context.start.slice(0, 10) || day.day >= context.end.slice(0, 10)) {
      throw new Error("ANALYTICS_V2_MODEL_ERA_DAY_ORDER_INVALID");
    }
    priorDay = day.day;
    rows += day.usageRows.length;
  }
  if (rows > MAX_WINDOWED_USAGE_ROWS) return refused("windowed_usage_limit_exceeded");
  const eras = new Map(context.index.eras.map(era => [era.eraKey, era]));
  const candidates = new Map<string, Candidate>();
  const candidateScopes = new Map<string, Set<string | null>>();
  for (const seed of context.seeds.values()) {
    // Different slots/reset pools in one era remain topology inputs, not
    // independent contributor votes. quotaContext already caps all seeds at 256.
    if (!candidates.has(seed.planEraKey)) candidates.set(seed.planEraKey, {
      seed, era: eras.get(seed.planEraKey)!, quota: [], state: createV11UsageModelState(),
    });
    const scopes = candidateScopes.get(seed.provider) ?? new Set<string | null>();
    scopes.add(seed.accountScopeId);
    candidateScopes.set(seed.provider, scopes);
  }
  for (const row of context.quota) candidates.get(row.plan_era_key)!.quota.push(row);
  const previous = new SessionCarry(), hazards = new AttributionHazards();
  // Reserve metadata/counters up front at their admitted numeric/string bounds.
  // Variable cost cells, session carry and hazards are then charged incrementally.
  let stateBytes = candidates.size * 2_048;
  let cells = 0;
  for (const day of input.days) for (const row of day.usageRows) {
    const event = usageEventSync(context, previous, row);
    if (event !== null && "status" in event) return event;
    if (event !== null) {
      const scopes = candidateScopes.get(event.provider);
      if (event.eraKey === null) {
        if (scopes !== undefined && (event.accountBreak || event.scope === null
            || scopes.has(null) || scopes.has(event.scope))) {
          hazards.add(event.provider, event.accountBreak ? null : event.scope, event.interval);
        }
      } else {
        // A positively resolved row is incompatible with other KNOWN accounts,
        // but unknown-scope quota could still measure it (and vice versa).
        // Preserve that uncertainty even when its own era has no eligible seed.
        if (scopes !== undefined && (event.scope === null ? scopes.size > (scopes.has(null) ? 1 : 0) : scopes.has(null))) {
          hazards.add(event.provider, null, event.interval, event.scope === null ? "known" : "unknown");
        }
        const candidate = candidates.get(event.eraKey);
        if (candidate !== undefined) {
          const state = candidate.state, bin = Math.floor(event.interval.end / GRAIN) * GRAIN;
          const key = JSON.stringify([bin, event.priced.modelId ?? "unknown"]);
          const oldCost = state.costs.get(key);
          const oldBytes = oldCost === undefined ? 0 : bytes([key, oldCost]);
          const before = state.costs.size + state.poisoned.size;
          const alreadyPoisoned = state.poisoned.has(bin);
          reduceV11UsageModelEvent(state, candidate.seed, null, {
            provider: event.provider, scope: event.scope, accountBreak: event.accountBreak, eraKey: event.eraKey,
            observedAtMs: event.interval.end, fullyPriced: event.priced.pricingStatus === "fully_priced",
            model: event.priced.modelId ?? "unknown", costNanousd: event.priced.costNanousd, events: 1,
          });
          if (state.modelRefusal !== null) return refused(state.modelRefusal);
          const cost = state.costs.get(key);
          if (cost !== undefined) stateBytes += bytes([key, cost]) - oldBytes + (oldCost === undefined ? 1 : 0);
          if (!alreadyPoisoned && state.poisoned.has(bin)) stateBytes += bytes(bin) + 1;
          cells += state.costs.size + state.poisoned.size - before;
        }
      }
    }
    if (cells > MAX_CELLS || hazards.count > MAX_HAZARDS
        || stateBytes + previous.bytes + hazards.bytes > MAX_V11_USAGE_CHECKPOINT_BYTES) {
      return refused("reduced_usage_limit_exceeded");
    }
  }
  const firstBin = Math.floor(Date.parse(context.start) / GRAIN) * GRAIN;
  const binCount = Math.ceil((Date.parse(context.end) - firstBin) / GRAIN);
  const results: AnalyticsV2ModelEraCandidate[] = [];
  let resultBytes = 256;
  const candidateKey = await crypto.subtle.importKey("raw", encoder.encode(input.pin.fingerprint),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  for (const [eraKey, candidate] of candidates) {
    const excluded = hazards.bins(candidate.seed, firstBin, binCount);
    const attributionBins = new Set<number>(), boundaryBins = new Set<number>();
    // Remove a WHOLE observation (its costs and therefore its quota movement
    // from the corpus join), never only the unattributed event's cost.
    const supportedBins = new Set(candidate.quota.map(row => Math.floor(Date.parse(row.observed_at) / GRAIN) * GRAIN));
    for (const bin of supportedBins) {
      if (excluded[(bin - firstBin) / GRAIN] === 1) attributionBins.add(bin);
      if (candidate.era.lowerBoundMs !== null && bin < candidate.era.lowerBoundMs
          || candidate.era.upperBoundMs !== null && bin + GRAIN - 1 > candidate.era.upperBoundMs) boundaryBins.add(bin);
    }
    for (const [key, cost] of candidate.state.costs) {
      if (attributionBins.has(cost.observedAtMs) || boundaryBins.has(cost.observedAtMs)) candidate.state.costs.delete(key);
    }
    const composition = v11ModelCompositionFromModelHalf({ reason: null, half: v11UsageModelHalf(candidate.state),
      quota: candidate.quota, planType: candidate.seed.planType, inputFingerprint: input.pin.fingerprint });
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", candidateKey,
      encoder.encode(JSON.stringify([ANALYTICS_V2_PLAN_ERA_COMPOSITION_VERSION, eraKey]))));
    const candidateId = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
    const result = { candidateId, composition, excludedAttributionBinCount: attributionBins.size,
      excludedBoundaryBinCount: boundaryBins.size };
    resultBytes += bytes(result) + 1;
    if (resultBytes > MAX_V11_USAGE_CHECKPOINT_BYTES) return refused("reduced_usage_limit_exceeded");
    results.push(result);
  }
  results.sort((a, b) => a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0);
  return { schemaVersion: ANALYTICS_V2_PLAN_ERA_COMPOSITION_VERSION, status: "partitioned",
    inputFingerprint: input.pin.fingerprint, candidates: results };
}
