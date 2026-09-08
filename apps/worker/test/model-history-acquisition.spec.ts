import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { advanceCommunityAnalysisRun } from "../src/community-analysis-runner";
import {
  createCommunityAnalysisWorkStore, readCommunityAnalysisWork,
  type CommunityAnalysisWorkBudget,
} from "../src/community-analysis-work";
import {
  finishHistoricalModelCompositionV1, MODEL_HISTORY_METHOD_VERSION,
  V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION, type V1AcquiredQuotaEvidence, type V1ModelComposition,
} from "../src/quota-analysis-v1";
import { modelHistoryWindow } from "../src/model-history-window";
import { loadV1SourcePin } from "../src/telemetry-v1-source-selection";
import {
  MODEL_HISTORY_TEST_PARTICIPANT as PARTICIPANT, MODEL_HISTORY_TEST_DAY as DAY,
  MODEL_HISTORY_TEST_CAPACITIES as CAPACITIES, modelHistoryTestTime as at,
  seedModelHistoryFixture as seed, insertModelHistoryRecords as insertRecords,
  pricedModelHistoryUsage as pricedUsage, modelHistorySourceInput,
  type SyntheticModelHistoryRecord as SyntheticRecord,
} from "./helpers/model-history";

const database = () => env.USAGE_MONITOR_DB;
const budget = (remainingQueries = 1000): CommunityAnalysisWorkBudget =>
  ({ remainingQueries, deadlineMs: 100, now: () => 0, reserveQueries: 3 });
const historyInput = (day = DAY) => modelHistorySourceInput(PARTICIPANT, day);

beforeEach(async () => {
  await reset();
  await applyD1Migrations(database(), (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

async function acquire(input: Awaited<ReturnType<typeof historyInput>>, storage: "current" | "model-history" = "model-history") {
  for (let pass = 0; pass < 100; pass++) {
    const allocation = budget(60);
    const result = await advanceCommunityAnalysisRun(database(), { ...input, budget: allocation, storage });
    expect(allocation.remainingQueries).toBeGreaterThanOrEqual(3);
    if (result.status === "ready") return result;
    expect(result).toEqual({ status: "deferred" });
  }
  throw new Error("synthetic historical acquisition did not finish");
}

async function fit(day: string, input: Awaited<ReturnType<typeof historyInput>>, evidence: V1AcquiredQuotaEvidence) {
  const result = await finishHistoricalModelCompositionV1(database(), PARTICIPANT, day, evidence,
    budget(), { sourcePin: input.sourcePin, maxWindowedUsageRows: 120 });
  if (result.status !== "complete" || result.analysis.status !== "ready") throw new Error("expected synthetic model fit");
  return result.analysis;
}

function withoutFingerprint(analysis: V1ModelComposition) {
  const { inputFingerprint: _fingerprint, ...value } = analysis;
  return value;
}

async function currentStorageSnapshot() {
  const statements = [
    "SELECT * FROM community_analysis_work ORDER BY participant_id",
    "SELECT * FROM community_analysis_work_parts ORDER BY participant_id, run_id, component, payload_sha256",
    "SELECT * FROM community_analysis_work_stage ORDER BY participant_id",
  ];
  return Promise.all(statements.map(sql => database().prepare(sql).all()
    .then(result => result.results)));
}

describe("date-specific historical model acquisition", () => {
  it("reconstructs different as-of days from their own evidence, with identifiable model fits", async () => {
    await seed();
    for (const [day, bins] of [["2026-09-03", 36], [DAY, 60]] as const) {
      const input = await historyInput(day), acquired = await acquire(input), window = modelHistoryWindow(day);
      expect(acquired.evidence.acquisition.quotaRows).toHaveLength(bins + 1);
      expect(acquired.evidence.acquisition.quotaRows.every(row =>
        row.observed_at >= window.observedAtCutoff && row.observed_at < window.observedAtBefore)).toBe(true);
      expect(acquired.evidence.acquisition.planAnchors.every(row =>
        row.observedAtMs >= Date.parse(window.observedAtCutoff) && row.observedAtMs < Date.parse(window.observedAtBefore))).toBe(true);
      const analysis = await fit(day, input, acquired.evidence);
      expect(analysis).toMatchObject({ status: "ready", planType: "pro", usageEventCount: bins * 2,
        quotaRowCount: bins + 1, latestQuotaObservedAt: at(bins * 2 - 1),
        fit: { status: "fitted", observationCount: bins }, attributionMethod: MODEL_HISTORY_METHOD_VERSION });
      expect(Object.keys(analysis.fit.capacityUsdByModel!)).toEqual([...Object.keys(CAPACITIES), "other"]);
      expect(analysis.fit.capacityUsdByModel!.other).toBeNull();
      for (const [model, capacity] of Object.entries(CAPACITIES)) {
        expect(analysis.fit.capacityUsdByModel![model]).toBeCloseTo(capacity, 4);
      }
    }
  });

  it("does not let later Astra usage, plan changes, or future-only physical pages rewrite an earlier fit", async () => {
    const fixture = await seed(), input = await historyInput();
    const before = await fit(DAY, input, (await acquire(input)).evidence);
    // This reset sorts before the historical reset. More than one physical
    // page of future-only rows must be traversed, not mistaken for EOF.
    const future: SyntheticRecord[] = Array.from({ length: 1100 }, (_, index) => ({
      stream: "quota", observedAt: new Date(Date.parse(at(120)) + index * 1000).toISOString(),
      planType: "plus", usedPercent: index / 20, resetsAt: "2026-09-07T00:00:00.000Z",
    }));
    future.push(pricedUsage("gpt-6-astra", 10_000, at(120)).record);
    await insertRecords(fixture, "future", future);
    const next = await historyInput();
    expect(next.sourcePin.inputRevision).toBeGreaterThan(input.sourcePin.inputRevision!);
    // Upload fencing advances, but later-day data is not a dependency of this
    // closed historical fit. Its exact vector identity must remain reusable.
    expect(next.sourcePin.fingerprint).toBe(input.sourcePin.fingerprint);
    expect(next.sourcePin.winners).toEqual(input.sourcePin.winners);
    const after = await fit(DAY, next, (await acquire(next)).evidence);
    expect(withoutFingerprint(after)).toEqual(withoutFingerprint(before));
    expect(Object.hasOwn(after.fit.capacityUsdByModel!, "gpt-6-astra")).toBe(false);
    const later = await historyInput("2026-09-06"), laterEvidence = (await acquire(later)).evidence;
    expect(laterEvidence.acquisition.planAnchors.some(anchor => anchor.planType === "plus")).toBe(true);
    expect(await finishHistoricalModelCompositionV1(database(), PARTICIPANT, "2026-09-06", laterEvidence,
      budget(), { sourcePin: later.sourcePin })).toEqual({ status: "complete",
      analysis: { status: "not_testable", reason: "multi_plan_window_unsupported" } });
  });

  it("keeps an in-progress current checkpoint byte-for-byte intact while historical work resumes", async () => {
    await seed();
    const history = await historyInput();
    const sourcePin = await loadV1SourcePin(database(),
      { participantId: PARTICIPANT, fromDay: history.identity.observedAtCutoff.slice(0, 10) });
    const current = { sourcePin, identity: { ...history.identity,
      inputFingerprint: sourcePin.fingerprint, sourceMethodVersion: V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION } };
    expect(await advanceCommunityAnalysisRun(database(), { ...current, budget: budget(10) }))
      .toEqual({ status: "deferred" });
    expect(await readCommunityAnalysisWork(database(), current.identity, budget()))
      .toMatchObject({ status: "ready", head: { phase: "plan" } });
    const before = await currentStorageSnapshot();
    const historical = await acquire(history);
    expect(await currentStorageSnapshot()).toEqual(before);
    const store = createCommunityAnalysisWorkStore("model-history");
    expect(await store.readCommunityAnalysisWork(database(), history.identity, budget()))
      .toEqual({ status: "ready", head: historical.head });
    const finishedCurrent = await acquire(current, "current");
    expect(finishedCurrent.evidence.acquisition).toEqual(historical.evidence.acquisition);
    expect(finishedCurrent.head.runId).not.toBe(historical.head.runId);
    expect(await store.readCommunityAnalysisWork(database(), history.identity, budget()))
      .toEqual({ status: "ready", head: historical.head });
  });

  it("refuses forged acquired quota or plan evidence outside the closed historical day range", async () => {
    await seed();
    const input = await historyInput(), acquired = (await acquire(input)).evidence, window = modelHistoryWindow(DAY);
    const futureQuota = structuredClone(acquired);
    futureQuota.acquisition.quotaRows.push({ ...futureQuota.acquisition.quotaRows.at(-1)!,
      occurrence_id: "synthetic-future-quota", observed_at: window.observedAtBefore });
    const futurePlan = structuredClone(acquired);
    futurePlan.acquisition.planAnchors.push({ ...futurePlan.acquisition.planAnchors.at(-1)!,
      observedAtMs: Date.parse(window.observedAtBefore) });
    const staleQuota = structuredClone(acquired);
    staleQuota.acquisition.quotaRows[0]!.observed_at = new Date(Date.parse(window.observedAtCutoff) - 1).toISOString();
    const stalePlan = structuredClone(acquired);
    stalePlan.acquisition.planAnchors[0]!.observedAtMs = Date.parse(window.observedAtCutoff) - 1;
    for (const evidence of [futureQuota, futurePlan, staleQuota, stalePlan]) {
      await expect(finishHistoricalModelCompositionV1(database(), PARTICIPANT, DAY, evidence,
        budget(), { sourcePin: input.sourcePin })).rejects.toThrow("v1 historical evidence outside day range");
    }
  });

  it("refuses an unbounded current source pin or current-method evidence for a historical fit", async () => {
    await seed();
    const input = await historyInput(), evidence = (await acquire(input)).evidence;
    const currentPin = await loadV1SourcePin(database(),
      { participantId: PARTICIPANT, fromDay: input.identity.observedAtCutoff.slice(0, 10) });
    await expect(finishHistoricalModelCompositionV1(database(), PARTICIPANT, DAY, evidence,
      budget(), { sourcePin: currentPin })).rejects.toThrow("v1 source pin scope mismatch");
    await expect(finishHistoricalModelCompositionV1(database(), PARTICIPANT, DAY,
      { ...evidence, identity: { ...evidence.identity, sourceMethodVersion: V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION } },
      budget(), { sourcePin: input.sourcePin })).rejects.toThrow("v1 acquired quota evidence mismatch");
    await expect(advanceCommunityAnalysisRun(database(), { ...input, storage: "current", budget: budget() }))
      .rejects.toThrow("community analysis historical scope mismatch");
    await expect(advanceCommunityAnalysisRun(database(), { ...input, sourcePin: currentPin,
      storage: "model-history", budget: budget() })).rejects.toThrow("community analysis historical scope mismatch");
  });
});
