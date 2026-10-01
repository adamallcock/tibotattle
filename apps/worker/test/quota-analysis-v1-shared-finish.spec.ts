import { describe, expect, it } from "vitest";
import { buildPlanAttributionIndex, planEraForInterval, buildCompositionObservations,
  calibrateCompositionCapacities, MODEL_COMPOSITION_POLICY } from "@app-usagemonitor/quota-analysis";
import { loadV1SourcePin } from "../src/telemetry-v1-source-selection";
import {
  accountScopedQuotaAnalysisV1, accountScopedModelCompositionV1, accountScopedQuotaAnalysisV1FullReferenceForTest,
  finishAccountScopedAnalysesV1, finishAccountScopedQuotaAnalysisV1, finishAccountScopedModelCompositionV1,
  V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION, V1_USAGE_PAGE_AT_TIME_SQL, V1_USAGE_PAGE_AFTER_TIME_SQL,
  QUOTA_DOWNSAMPLE_SQL, v1QuotaFinishQueryReserve, priceChunkUsageRecord, type V1AcquiredQuotaEvidence,
  type V1PreparedFinishEvidence, type WindowedUsageRow, type V1PreparedUsageFragment,
} from "../src/quota-analysis-v1";
import { prepareUsagePage } from "../src/prepared-v1-day";
import type { V1AcquiredQuotaRow, V1PlanAnchor } from "../src/quota-analysis-v1-reader";

const BASE = Date.parse("2026-08-01T00:00:00.000Z"), HOUR = 3_600_000;
const CUTOFF = "2026-07-01T00:00:00.000Z", NOW = Date.parse(CUTOFF) + 100 * 86_400_000;
const PARTICIPANT = "synthetic-shared-finish", PROVIDER = "openai_codex";
const at = (hours: number) => new Date(BASE + hours * HOUR).toISOString();
const recordJson = (model = "gpt-5.6-sol", output = 1000, partial = false) => JSON.stringify({
  provider: PROVIDER, modelId: model, billingSurface: "chatgpt_subscription", apiServiceTier: "priority", speedMode: "fast",
  components: { inputUncachedTokens: 1000, inputCacheReadTokens: 9000, inputCacheWriteTokens: 0,
    outputTextTokens: output, outputReasoningTokens: partial ? null : 0, outputCombinedTokens: null },
});
interface Usage { id: number; occurrence_id: string; observed_at: string; provider: string;
  session_uuid: string | null; record_json: string }
const usage = (id: number, hours: number, extra: Partial<Usage> = {}): Usage => ({ id,
  occurrence_id: `usage-${String(id).padStart(8, "0")}`, observed_at: at(hours), provider: PROVIDER,
  session_uuid: null, record_json: recordJson(), ...extra });

/** SQL-shaped synthetic adapter isolates the finish contract. Existing acquired
 * and full-reference tests separately exercise actual SQLite and migrations.
 * Unbounded quota SQL is allowed ONLY for the explicit old-path oracle calls.
 */
async function fixture(rows: Usage[], switchPlan = false) {
  const quota: V1AcquiredQuotaRow[] = Array.from({ length: 34 }, (_, i) => ({
    occurrence_id: `quota-${String(i).padStart(8, "0")}`, observed_at: at(i / 2), provider: PROVIDER,
    plan_type: switchPlan && i >= 17 ? "plus" : "pro", plan_variant: "unknown", limit_id: "codex", slot: "seven_day",
    used_percent: i / 2 * 5, window_duration_minutes: 10_080, resets_at: at(168), plan_era_key: "",
  }));
  const anchors: V1PlanAnchor[] = quota.map(row => ({ sourceContext: '["openai_codex","codex"]',
    contextKey: "openai_codex|codex", observedAtMs: Date.parse(row.observed_at), planType: row.plan_type,
    planVariant: row.plan_variant, accountScopeId: null }));
  const index = buildPlanAttributionIndex(anchors);
  for (const row of quota) {
    const match = planEraForInterval(index, { contextKey: "openai_codex|codex", observedAtMs: Date.parse(row.observed_at) });
    if (match.status !== "matched") throw new Error("invalid synthetic quota fixture");
    row.plan_era_key = match.era.eraKey;
  }
  let revision = 1, usageReadCount = 0, queries = 0, allowOracle = false;
  let onUsageRead: (() => void) | undefined;
  const chunks = ["quota", "usage"].flatMap(stream => {
    const count = stream === "quota" ? quota.length : rows.length;
    return Array.from({ length: Math.ceil(count / 200) }, (_, i) => ({ id: `synthetic-chunk-${stream}-${i}`, participant_id: PARTICIPANT,
      device_id: "synthetic-winner", chunk_day: "2026-08-01", stream, revision: 1, chunk_digest: "a".repeat(64),
      parser_version: "synthetic-v1", accepted_record_count: Math.min(200, count - i * 200), created_at: at(20) }));
  });
  class Statement {
    args: unknown[] = [];
    constructor(readonly sql: string) {}
    bind(...args: unknown[]) { this.args = args; return this; }
    async first() {
      queries += 1;
      if (this.sql.includes("FROM telemetry_v11_domain_heads")) return null;
      if (this.sql.includes("sqlite_schema") && this.sql.includes("typed_v1_admission_state")) return null;
      throw new Error("unexpected synthetic first query");
    }
    async all() {
      queries += 1;
      if (this.sql.includes("FROM community_snapshot_mutation_control")) return { results: [{ mutation_epoch: revision, input_revision: revision }] };
      if (this.sql.includes("FROM telemetry_analytical_chunks")) return { results: chunks };
      if (this.sql === V1_USAGE_PAGE_AT_TIME_SQL || this.sql === V1_USAGE_PAGE_AFTER_TIME_SQL) {
        const same = this.sql === V1_USAGE_PAGE_AT_TIME_SQL, time = this.args[2] as string;
        const matching = rows.filter(row => same ? row.observed_at === time && row.id > (this.args[3] as number) : row.observed_at > time)
          .sort((a, b) => a.observed_at.localeCompare(b.observed_at) || a.id - b.id)
          .slice(0, this.args[same ? 4 : 3] as number);
        usageReadCount += matching.length; onUsageRead?.();
        return { results: matching };
      }
      if (!allowOracle) throw new Error("acquired finish attempted unbounded SQL");
      if (this.sql === QUOTA_DOWNSAMPLE_SQL) return { results: quota };
      if (this.sql.includes("WITH plan_times AS MATERIALIZED")) return { results: quota };
      if (this.sql.includes("r.stream IN ('usage', 'quota')")) return { results: [
        ...quota.map(row => ({ ...row, stream: "quota", session_uuid: null, record_json: "{}" })),
        ...rows.map(row => ({ plan_type: null, plan_variant: null, limit_id: null, slot: null, used_percent: null,
          window_duration_minutes: null, resets_at: null, ...row, stream: "usage" })),
      ].sort((a, b) => a.observed_at.localeCompare(b.observed_at)
        || (a.stream === "usage" && b.stream === "usage" ? a.occurrence_id.localeCompare(b.occurrence_id) : 0)) };
      throw new Error("unexpected synthetic oracle query");
    }
  }
  const db = { prepare(sql: string) { return new Statement(sql); },
    async batch(statements: Statement[]) { return Promise.all(statements.map(statement => statement.all())); } } as unknown as D1Database;
  const pin = await loadV1SourcePin(db, { participantId: PARTICIPANT, fromDay: CUTOFF.slice(0, 10) });
  const evidence: V1AcquiredQuotaEvidence = { identity: { participantId: PARTICIPANT, inputFingerprint: pin.fingerprint,
    sourceMethodVersion: V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION, observedAtCutoff: CUTOFF,
    resetsAtCutoff: "2026-07-08T00:00:00.000Z", windowMinutes: 10_080, maxQuotaRows: 60_000 },
    acquisition: { planAnchors: anchors, quotaRows: quota } };
  return { db, pin, evidence, options: { sourcePin: pin, nowMs: NOW },
    setOracle(value: boolean) { allowOracle = value; },
    counts() { return { queries, usageReadCount }; },
    mutate() { revision += 1; }, onRead(callback: () => void) { onUsageRead = callback; } };
}
const budget = (remainingQueries = 1000) => ({ remainingQueries, deadlineMs: Date.now() + 60_000 });
function preparedUsage(rows: Usage[], sourceFingerprint: string): V1PreparedFinishEvidence {
  const order = (a: {observed_at:string;id:number}, b: {observed_at:string;id:number}) =>
    a.observed_at < b.observed_at ? -1 : a.observed_at > b.observed_at ? 1 : a.id-b.id;
  const ordered=[...rows].sort(order), prices:WindowedUsageRow[]=[], fragments:V1PreparedUsageFragment[]=[];
  for(let offset=0;offset<ordered.length;offset+=256) {
    const prepared=prepareUsagePage(ordered.slice(offset,offset+256));
    prices.push(...prepared.prices); fragments.push(...prepared.fragments);
  }
  fragments.sort(order);
  const after=(time:string,id:number)=>(row:{observed_at:string;id:number})=>
    row.observed_at>time || row.observed_at===time&&row.id>id;
  return { sourceFingerprint,
    usageReader:{async readPage(time,id,limit){return prices.filter(after(time,id)).slice(0,limit);}},
    usageBins:{totalRowCount:rows.length,fragmentCount:fragments.length,
      async readPage(time,id,limit){return fragments.filter(after(time,id)).slice(0,limit);}},
  };
}
const newMethod = (analysis: object) => Object.hasOwn(analysis, "attributionMethod")
  ? { ...analysis, attributionMethod: V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION } : analysis;
function resetFits(analysis: object): object[] {
  const tracks = Reflect.get(analysis, "tracks") as { calibration: { tracks: { resets: Record<string, unknown>[] }[] } }[];
  return tracks.flatMap(track => track.calibration.tracks.flatMap(value => value.resets.map(reset => ({
    status: reset.status, capacityNanousd: reset.capacityNanousd, displayedSpanPp: reset.displayedSpanPp,
    firstObservedAt: reset.firstObservedAt, lastObservedAt: reset.lastObservedAt, refusalCodes: reset.refusalCodes,
  }))));
}

/** Independent raw-record oracle: global bin map and exact BigInt sums. This
 * intentionally does not call either adapter's newly shared streaming fold. */
function compositionOracle(rows: Usage[], quota: readonly V1AcquiredQuotaRow[]) {
  const costs = new Map<string, { bin: number; model: string; cost: bigint; first: Usage }>();
  const poisoned = new Set<number>();
  let usageEventCount = 0, unpricedUsageEventCount = 0;
  for (const row of [...rows].sort((a, b) => a.observed_at < b.observed_at ? -1 : a.observed_at > b.observed_at ? 1 : a.id - b.id)) {
    if (row.provider !== PROVIDER) continue;
    const priced = priceChunkUsageRecord(row.record_json, row.observed_at);
    if (!priced) continue;
    const bin = Math.floor(Date.parse(row.observed_at) / MODEL_COMPOSITION_POLICY.grainMs) * MODEL_COMPOSITION_POLICY.grainMs;
    if (priced.pricingStatus !== "fully_priced") { poisoned.add(bin); unpricedUsageEventCount += 1; continue; }
    usageEventCount += 1;
    const model = priced.modelId ?? "unknown", key = `${bin}\0${model}`, old = costs.get(key);
    if (old) {
      old.cost += BigInt(priced.costNanousd);
      if (row.observed_at < old.first.observed_at || row.observed_at === old.first.observed_at
          && row.occurrence_id < old.first.occurrence_id) old.first = row;
    } else costs.set(key, { bin, model, cost: BigInt(priced.costNanousd), first: row });
  }
  const ordered = [...costs.values()].filter(row => !poisoned.has(row.bin));
  if (ordered.some(row => row.cost > BigInt(Number.MAX_SAFE_INTEGER))) return { status: "not_testable", reason: "usage_cost_limit_exceeded" };
  ordered.sort((a, b) => a.first.observed_at < b.first.observed_at ? -1 : a.first.observed_at > b.first.observed_at ? 1
    : a.first.occurrence_id < b.first.occurrence_id ? -1 : a.first.occurrence_id > b.first.occurrence_id ? 1 : 0);
  const corpus = buildCompositionObservations({
    usageRows: ordered.filter(row => row.cost > 0n).map(row => ({ observedAtMs: row.bin, model: row.model, costUsd: Number(row.cost) / 1e9 })),
    quotaRows: quota.map(row => ({ observedAtMs: Date.parse(row.observed_at), resetsAtMs: Date.parse(row.resets_at),
      usedPercent: row.used_percent, planType: row.plan_type })),
  });
  return { status: "ready", fit: calibrateCompositionCapacities(corpus.observations), voidedBinCount: corpus.voidedBinCount,
    poolCount: corpus.poolCount, usageEventCount, unpricedUsageEventCount, poisonedBinCount: poisoned.size };
}

describe("shared acquired v1 finish", () => {
  it("matches the raw global-bin oracle across page seams, late poison, and distinct future bins", async () => {
    const rows = Array.from({ length: 33 }, (_, i) => usage(i + 1, i / 2 + 0.25));
    rows.push(...Array.from({ length: 5001 }, (_, i) => usage(i + 100, 1.75, {
      occurrence_id: `reverse-${String(10000 - i).padStart(8, "0")}`,
      record_json: recordJson(i % 2 ? "gpt-5.6-sol" : "gpt-5.6-terra", i % 11 + 1),
    })), usage(6000, 1.875, { record_json: recordJson("unknown-model") }));
    rows.push(...Array.from({ length: 200 }, (_, i) => usage(i + 7000, 100_000 + i * 2, {
      record_json: i % 7 === 0 ? recordJson("unknown-model") : i % 11 === 0 ? "{}" : recordJson(),
    })));
    const f = await fixture(rows), expected = compositionOracle(rows, f.evidence.acquisition.quotaRows);
    expect(expected).toMatchObject({ status: "ready", fit: { observationCount: 8 } });
    const result = await finishAccountScopedAnalysesV1(f.db, PARTICIPANT, f.evidence, budget(), f.options);
    expect(result).toMatchObject({ status: "complete", modelComposition: expected });
    f.setOracle(true);
    expect(await accountScopedModelCompositionV1(f.db, PARTICIPANT, f.options)).toMatchObject(expected);
  });

  it.each([false, true])("retains all-bin overflow and late-poison precedence outside quota bins (%s)", async laterPoison => {
    const hugeJson = (tokens: number) => JSON.stringify({ ...JSON.parse(recordJson()), components: {
      inputUncachedTokens: 0, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
      outputTextTokens: tokens, outputReasoningTokens: 0, outputCombinedTokens: null } });
    const time = 100_000, unit = priceChunkUsageRecord(hugeJson(1), at(time))!;
    const json = hugeJson(Math.floor(450_000_000_000 / unit.costNanousd));
    const priced = priceChunkUsageRecord(json, at(time))!;
    expect(priced.pricingStatus).toBe("fully_priced");
    const count = Math.floor(Number.MAX_SAFE_INTEGER / priced.costNanousd) + 1;
    expect(count).toBeGreaterThan(5000);
    const rows = Array.from({ length: count }, (_, i) => usage(i + 1, time, { record_json: json }));
    if (laterPoison) rows.push(usage(count + 1, time + 0.1, { record_json: recordJson("unknown-model") }));
    rows.push(usage(count + 2, time + 2));
    const f = await fixture(rows), expected = compositionOracle(rows, f.evidence.acquisition.quotaRows);
    expect(expected).toMatchObject(laterPoison ? { status: "ready", poisonedBinCount: 1 }
      : { status: "not_testable", reason: "usage_cost_limit_exceeded" });
    expect(await finishAccountScopedAnalysesV1(f.db, PARTICIPANT, f.evidence, budget(), f.options))
      .toMatchObject({ status: "complete", modelComposition: expected });
    const preparedEvidence=preparedUsage(rows,f.pin.fingerprint);
    expect(await finishAccountScopedModelCompositionV1(f.db,PARTICIPANT,f.evidence,budget(),{...f.options,preparedEvidence}))
      .toMatchObject({status:"complete",analysis:expected});
    // Physical page overflow takes precedence even if the prior bin already
    // accumulated an unsafe integer total.
    expect(await finishAccountScopedAnalysesV1(f.db, PARTICIPANT, f.evidence, budget(),
      { ...f.options, maxWindowedUsageRows: rows.length - 1 }))
      .toMatchObject({ status: "complete", modelComposition: { status: "not_testable", reason: "windowed_usage_limit_exceeded" } });
    expect(await finishAccountScopedModelCompositionV1(f.db,PARTICIPANT,f.evidence,budget(),
      {...f.options,preparedEvidence,maxWindowedUsageRows:rows.length-1}))
      .toEqual({status:"complete",analysis:{status:"not_testable",reason:"windowed_usage_limit_exceeded"}});
  }, 20_000);

  it.each([false, true])("matches both independent calculators including refusals and pricing (plan switch %s)", async switchPlan => {
    const rows = Array.from({ length: 33 }, (_, i) => usage(i + 1, i / 2 + 0.25));
    // A grid-exact event, lexical model order unlike insertion order, a DROP
    // record, and a poisoned bin all preserve the original two consumers.
    rows.push(usage(100, 2, { record_json: recordJson("gpt-5.6-terra") }),
      usage(101, 8.25, { session_uuid: "shared-session" }),
      usage(102, 8.75, { session_uuid: "shared-session", occurrence_id: "z-tie-priced" }),
      usage(103, 8.75, { session_uuid: "shared-session", occurrence_id: "a-tie-dropped", record_json: "{}" }),
      usage(104, 12, { record_json: recordJson("unknown-model") }));
    const f = await fixture(rows, switchPlan);
    f.setOracle(true);
    const scalar = await accountScopedQuotaAnalysisV1(f.db, PARTICIPANT, f.options);
    const composition = await accountScopedModelCompositionV1(f.db, PARTICIPANT, f.options);
    f.setOracle(false);
    const before = f.counts(), allocation = budget();
    const combined = await finishAccountScopedAnalysesV1(f.db, PARTICIPANT, f.evidence, allocation, f.options);
    expect(combined.status).toBe("complete");
    if (combined.status !== "complete") throw new Error("unexpected deferral");
    expect(combined.quotaAnalysis).toEqual(newMethod(scalar));
    expect(combined.modelComposition).toEqual(newMethod(composition));
    expect(f.counts().usageReadCount - before.usageReadCount).toBe(rows.length);
    expect(allocation.remainingQueries).toBe(1000 - v1QuotaFinishQueryReserve());
    expect((await finishAccountScopedQuotaAnalysisV1(f.db, PARTICIPANT, f.evidence, budget(), f.options)))
      .toEqual({ status: "complete", analysis: combined.quotaAnalysis });
    expect((await finishAccountScopedModelCompositionV1(f.db, PARTICIPANT, f.evidence, budget(), f.options)))
      .toEqual({ status: "complete", analysis: combined.modelComposition });
    expect(await finishAccountScopedAnalysesV1(f.db,PARTICIPANT,f.evidence,budget(),
      {...f.options,preparedEvidence:preparedUsage(rows,f.pin.fingerprint)})).toEqual(combined);
  });

  it("keeps an occurrence-first interval election across a physical page seam", async () => {
    const rows = [usage(1, 8.25, { session_uuid: "shared-session" }),
      ...Array.from({ length: 5001 }, (_, i) => usage(i + 2, 8.75, {
        occurrence_id: i === 5000 ? "a-final-drop" : `z-priced-${String(i).padStart(8, "0")}`,
        session_uuid: "shared-session", record_json: i === 5000 ? "{}" : recordJson(),
      }))];
    const f = await fixture(rows, true);
    f.setOracle(true);
    const expected = await accountScopedQuotaAnalysisV1(f.db, PARTICIPANT, f.options);
    f.setOracle(false);
    const before = f.counts().usageReadCount;
    const result = await finishAccountScopedAnalysesV1(f.db, PARTICIPANT, f.evidence, budget(), f.options);
    expect(result).toMatchObject({ status: "complete", quotaAnalysis: newMethod(expected),
      modelComposition: { status: "not_testable", reason: "multi_plan_window_unsupported" } });
    expect(f.counts().usageReadCount - before).toBe(rows.length);
  });

  it("preserves usage-limit priority independently of a pre-usage model refusal", async () => {
    const f = await fixture([usage(1, 1)], true);
    const result = await finishAccountScopedAnalysesV1(f.db, PARTICIPANT, f.evidence, budget(v1QuotaFinishQueryReserve(0)),
      { ...f.options, maxWindowedUsageRows: 0 });
    expect(result).toMatchObject({ status: "complete",
      quotaAnalysis: { status: "not_testable", reason: "windowed_usage_limit_exceeded" },
      modelComposition: { status: "not_testable", reason: "multi_plan_window_unsupported" } });
  });

  it("verifies full session identities across dictionary collisions against the raw-event oracle", async () => {
    const seen = new Map<number, string>();
    let pair: [string, string] | undefined;
    for (let i = 0; i < 20_000 && !pair; i++) {
      const key = `collision-${String(i).padStart(8, "0")}`;
      let hash = Math.imul(2166136261, 16777619);
      for (let p = 0; p < key.length; p++) hash = Math.imul(hash ^ key.charCodeAt(p), 16777619);
      const slot = (hash >>> 0) & 262143, previous = seen.get(slot);
      if (previous) pair = [previous, key]; else seen.set(slot, key);
    }
    expect(pair).toBeDefined();
    const rows = Array.from({ length: 33 }, (_, i) => usage(i + 1, i / 2 + 0.25));
    rows.push(usage(100, 8.25, { session_uuid: pair![0], record_json: "{}" }),
      usage(101, 8.75, { session_uuid: pair![1] }));
    const f = await fixture(rows, true);
    f.setOracle(true);
    const expected = resetFits(await accountScopedQuotaAnalysisV1FullReferenceForTest(f.db, PARTICIPANT));
    expect(expected.some(row => Reflect.get(row, "status") === "conditional_estimate")).toBe(true);
    f.setOracle(false);
    const result = await finishAccountScopedAnalysesV1(f.db, PARTICIPANT, f.evidence, budget(), f.options);
    if (result.status !== "complete") throw new Error("unexpected deferral");
    expect(resetFits(result.quotaAnalysis)).toEqual(expected);
  });

  it.each([1, 100_000])("preserves the session cap and independent model result at hour %s", async hours => {
    const json = recordJson();
    const rows = Array.from({ length: 100_001 }, (_, i) => ({ id: i + 1, occurrence_id: `scope-event-${i}`,
      observed_at: at(hours), provider: PROVIDER, session_uuid: `scope-session-${i}`, record_json: json }));
    const f = await fixture(rows);
    const result = await finishAccountScopedAnalysesV1(f.db, PARTICIPANT, f.evidence, budget(), f.options);
    expect(result).toMatchObject({ status: "complete", quotaAnalysis: {
      status: "not_testable", reason: "session_interval_scope_limit_exceeded" },
      modelComposition: { status: "ready", usageEventCount: 100_001 } });
    expect(f.counts().usageReadCount).toBe(100_001);
  }, 20_000);

  it("preserves the final-grid boundary, previous pending flush and post-grid ties against raw events", async () => {
    const rows = Array.from({ length: 33 }, (_, i) => usage(i + 1, i / 2 + 0.25));
    rows.push(usage(100, 8.25, { session_uuid: "pending-before-tail" }),
      usage(101, 8.75, { session_uuid: "pending-before-tail", occurrence_id: "z-priced" }),
      usage(102, 8.75, { session_uuid: "pending-before-tail", occurrence_id: "a-drop", record_json: "{}" }),
      usage(103, 16.5, { session_uuid: "final-grid" }),
      ...Array.from({ length: 5001 }, (_, i) => usage(i + 200, 100_000, {
        session_uuid: i % 2 ? "pending-before-tail" : "final-grid",
        occurrence_id: i === 5000 ? "a-late-tail-drop" : `z-tail-${i}`,
        record_json: i === 5000 ? "{}" : recordJson(),
      })));
    const f = await fixture(rows, true);
    f.setOracle(true);
    const expected = resetFits(await accountScopedQuotaAnalysisV1FullReferenceForTest(f.db, PARTICIPANT));
    f.setOracle(false);
    const result = await finishAccountScopedAnalysesV1(f.db, PARTICIPANT, f.evidence, budget(), f.options);
    if (result.status !== "complete") throw new Error("unexpected deferral");
    expect(resetFits(result.quotaAnalysis)).toEqual(expected);
    expect(f.counts().usageReadCount).toBe(rows.length);
  });

  it("defers without a read and never falls through missing, malformed, or mismatched acquisition", async () => {
    const f = await fixture([usage(1, 1)]), before = f.counts().queries;
    expect(await finishAccountScopedAnalysesV1(f.db, PARTICIPANT, f.evidence, budget(406), f.options)).toEqual({ status: "deferred" });
    expect(f.counts().queries).toBe(before);
    for (const invalid of [null, undefined, {}, { identity: f.evidence.identity, acquisition: null }]) {
      await expect(Reflect.apply(finishAccountScopedAnalysesV1, undefined, [f.db, PARTICIPANT, invalid, budget(), f.options])).rejects.toThrow("evidence required");
    }
    expect(f.counts().queries).toBe(before);
    for (const acquisition of [{ ...f.evidence.acquisition, unexpected: true },
      { ...f.evidence.acquisition, quotaRows: [{ ...f.evidence.acquisition.quotaRows[0], occurrence_id: "bad" }] }]) {
      await expect(finishAccountScopedAnalysesV1(f.db, PARTICIPANT, { ...f.evidence, acquisition } as V1AcquiredQuotaEvidence,
        budget(), f.options)).rejects.toThrow("evidence mismatch");
    }
  });

  it.each([false, true])("rejects a source change even when usage ends in refusal (%s)", async refuse => {
    const f = await fixture([usage(1, 1)]);
    f.onRead(() => f.mutate());
    await expect(finishAccountScopedAnalysesV1(f.db, PARTICIPANT, f.evidence, budget(),
      { ...f.options, maxWindowedUsageRows: refuse ? 0 : 1_000_000 })).rejects.toThrow("source changed during analysis");
  });
});
