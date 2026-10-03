import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/canonical-json";
import { computeAnalyticsV2Owner, analyticsV2EvidenceOf, analyticsV2EmissionBytes,
  type AnalyticsV2OwnerEmission, type AnalyticsV2OwnerRunContext } from "../src/analytics-v2/compute-owner";
import { computeAnalyticsV2Owner as reference } from "./fixtures/model-blocks-inline-reference";
import { prepareSpan, evaluateModelBlock, partitionModelDates, type AnalyticsV2ModelBlockInput } from "../src/analytics-v2/units";
import { ANALYTICS_V2_DEFAULT_RESOURCES } from "../src/analytics-v2/resources";
import * as nativePath from "../src/analytics-v2/native-path";
import { modelHistoryWindow, SharedAnalyticsUnavailable } from "../vendor/analytics-d43c8f92/entry";
import { addDays, composeProofCorpus, denseFacts, effectiveV2Owner, syntheticOwner, TODAY } from "./fixtures/synthetic-occurrences.mjs";

const dates = Array.from({ length: 70 }, (_, i) => addDays(TODAY, i - 69));
const neededDays = Array.from({ length: 170 }, (_, i) => addDays(TODAY, i - 169));
const context: AnalyticsV2OwnerRunContext = { today: TODAY, analysisFrom: neededDays[0]!, cacheFromDay: dates[0]!,
  neededDays, segments: [{ fromDay: neededDays[0]!, throughDay: TODAY }], rangeFromDay: neededDays[0]!,
  queued: [addDays(TODAY, -1), TODAY], modelDates: dates, resources: ANALYTICS_V2_DEFAULT_RESOURCES };
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function capture(budget = Infinity) {
  const emissions: AnalyticsV2OwnerEmission[] = [], progress: unknown[] = [];
  let account = 0;
  return { emissions, progress, get account() { return account; }, hooks: {
    emit: (emission: AnalyticsV2OwnerEmission) => {
      emissions.push(emission);
      account += analyticsV2EmissionBytes(emission);
      if (account > budget) throw Object.assign(new Error("ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED"),
        { code: "ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED", accountBytes: account, outputBudgetBytes: budget });
    }, accountBytes: () => account, progress: (event: unknown) => { progress.push(event); },
    timed: async <T>(_phase: unknown, work: () => T | Promise<T>) => work(),
  } };
}

describe("MODEL-BLOCKS inline stage proof", () => {
  it("reproduces frozen base emissions, computations, progress and exact budget crossing", async () => {
    const corpus = composeProofCorpus();
    for (const owner of corpus.owners.filter((owner: { source: string }) => owner.source === "effective")) {
      const occurrences = corpus.occurrencesByOwner.get(owner.ownerDigest)!;
      const input = { context, owner, occurrences, evidence: analyticsV2EvidenceOf(occurrences), load: null };
      const before = capture(), after = capture();
      expect(await computeAnalyticsV2Owner({ ...input, hooks: after.hooks }))
        .toEqual(await reference({ ...input, hooks: before.hooks }));
      expect(after.emissions).toEqual(before.emissions);
      expect(digest(after.emissions)).toBe(digest(before.emissions));
      expect(after.progress).toEqual(before.progress);
      for (const budget of [1, 10000, Math.floor(before.account / 2)]) {
        const left = capture(budget), right = capture(budget);
        const failures = await Promise.allSettled([reference({ ...input, hooks: left.hooks }),
          computeAnalyticsV2Owner({ ...input, hooks: right.hooks })]);
        expect(failures.map((result) => result.status)).toEqual(["rejected", "rejected"]);
        expect(left.account).toBe(right.account);
        expect(left.emissions).toEqual(right.emissions);
        if (failures[0]!.status === "rejected" && failures[1]!.status === "rejected") {
          expect(failures[1].reason.code).toBe(failures[0].reason.code);
          expect(failures[1].reason.accountBytes).toBe(failures[0].reason.accountBytes);
        }
      }
    }
  }, 60000);

  it("clones exactly and preserves per-date results across reverse, shuffled and block orders", async () => {
    const synthetic = syntheticOwner(4, "pro");
    const owner = effectiveV2Owner(synthetic);
    const occurrences = denseFacts(synthetic, { usagePerDay: 10, denseDays: 2 });
    const prepared = await prepareSpan({ owner, span: neededDays.map((day) => [day, occurrences.get(day)
      ?? { usage: [], quota: [], session: [] }] as const), lookbackCacheTail: new Map(), analysisFrom: context.analysisFrom,
      today: TODAY, cacheFromDay: context.cacheFromDay, queued: new Set(context.queued), resources: context.resources });
    expect(prepared.terminalError).toBeNull();
    const horizonQuota = new Map([...occurrences].map(([day, value]) => [day, value.quota]));
    const input: AnalyticsV2ModelBlockInput = { owner, dates, prepared: prepared.prepared,
      dayDigests: prepared.dayDigests, horizonQuota };
    const nativeInput = { ...input, prepared: new Map([...input.prepared].map(([day, value]) =>
      [day, { ...value, modelUsage: null, quota: null }])) };
    const nativeOrdered = await evaluateModelBlock(nativeInput);
    const nativeByDay = new Map(nativeOrdered.map((result) => [result.day, result]));
    for (const result of await evaluateModelBlock({ ...nativeInput, dates: [...dates].reverse() })) {
      expect(result).toEqual(nativeByDay.get(result.day));
    }
    const ordered = await evaluateModelBlock(input);
    const byDay = new Map(ordered.map((result) => [result.day, result]));
    const shuffled = [...dates].sort((a, b) => digest(a).localeCompare(digest(b)));
    for (const order of [[...dates].reverse(), shuffled]) {
      for (const result of await evaluateModelBlock({ ...input, dates: order })) expect(result).toEqual(byDay.get(result.day));
    }
    for (const size of [1, 5, 14, 70]) {
      const blocks = [];
      for (let i = 0; i < dates.length; i += size) {
        const blockDates = dates.slice(i, i + size), from = modelHistoryWindow(blockDates[0]!).fromDay,
          through = blockDates.at(-1)!;
        const trim = <T>(values: ReadonlyMap<string, T>) => new Map([...values].filter(([day]) => day >= from && day <= through));
        const payload = { ...input, dates: blockDates, prepared: trim(input.prepared),
          dayDigests: trim(input.dayDigests), horizonQuota: trim(input.horizonQuota) };
        const cloned = structuredClone(payload);
        expect(isDeepStrictEqual(cloned, payload)).toBe(true);
        expect(Object.keys(cloned)).toEqual(Object.keys(payload));
        blocks.push(cloned);
      }
      const completed = await Promise.all([...blocks].reverse().map(async (block, i) => {
        await new Promise((resolve) => setTimeout(resolve, i % 3));
        return evaluateModelBlock(block);
      }));
      expect(completed.flat().sort((a, b) => a.day.localeCompare(b.day))).toEqual(ordered);
    }
  }, 60000);
});


it("MODEL-BLOCKS replays earlier refusal/emissions before the first date-ordered terminal error", async () => {
  const owner = effectiveV2Owner(syntheticOwner(9, "pro")), occurrences = new Map();
  const input = { context, owner, occurrences, evidence: analyticsV2EvidenceOf(occurrences), load: null };
  const original = nativePath.evaluateAnalyticsV2ModelDate;
  const spy = vi.spyOn(nativePath, "evaluateAnalyticsV2ModelDate").mockImplementation(async (window) => {
    if (window.day === dates[2]) throw new SharedAnalyticsUnavailable("incomplete_window");
    if (window.day === dates[5] || window.day === dates[30]) {
      const code = window.day === dates[5] ? "ANALYTICS_V2_SYNTHETIC_FIRST" : "ANALYTICS_V2_SYNTHETIC_SECOND";
      throw Object.assign(new Error(code), { code });
    }
    return original(window);
  });
  try {
    const before = capture(), after = capture();
    await expect(reference({ ...input, hooks: before.hooks })).rejects.toMatchObject({ code: "ANALYTICS_V2_SYNTHETIC_FIRST" });
    await expect(computeAnalyticsV2Owner({ ...input, hooks: { ...after.hooks, modelBlocks: { size: 5, fanOut: "all",
      run: async (input) => {
        const blocks = partitionModelDates(input.dates, 5);
        const completed = await Promise.all([...blocks].reverse().map(async (dates, index) => {
          await new Promise((resolve) => setTimeout(resolve, index % 3));
          return evaluateModelBlock({ ...input, dates });
        }));
        return { dates: completed.reverse().flat(), heapPeakBytes: null };
      } } } })).rejects.toMatchObject({ code: "ANALYTICS_V2_SYNTHETIC_FIRST" });
    expect(after.emissions).toEqual(before.emissions);
    expect(after.account).toBe(before.account);
    expect(after.emissions.some((emission) => emission.kind === "refusal" && emission.refusal.day === dates[2])).toBe(true);
  } finally { spy.mockRestore(); }
});
