// N-EXCL: the community aggregate exclusions in the A-2 compute core
// (src/analytics-v2/exclusions.ts). An owner excluded on day D is left out of
// D's public daily and the preview's day D, exactly as if it were not in the
// cohort that day, and keeps every row of its own; with no exclusion nothing
// changes. Synthetic, content-free owners only.
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical-json";
import { sha256Hex } from "../src/crypto";
import { analyticsV2RequiredOccurrenceRange, computeAnalyticsV2, type ComputeAnalyticsV2Input } from "../src/analytics-v2/compute";
import {
  ANALYTICS_V2_EXCLUSIONS_METHOD,
  ANALYTICS_V2_NO_EXCLUSIONS_SHA256,
  analyticsV2ExcludedOn,
  analyticsV2ExclusionsOn,
  analyticsV2ExclusionsSha256,
  validAnalyticsV2ExclusionIntervals,
} from "../src/analytics-v2/exclusions";
import type { AdminCommunityAllowancePreview } from "../vendor/analytics-d43c8f92/entry";
import {
  addDays,
  composeFacts,
  composeProofCorpus,
  conflictFacts,
  effectiveV2Owner,
  NOW_MS,
  oneDevicePerOwner,
  syntheticOwner,
  TODAY,
  v1OnlyV2Owner,
} from "./fixtures/synthetic-occurrences.mjs";

const US = 1_000;
const dayStartUs = (day: string) => Date.parse(`${day}T00:00:00.000Z`) * US;
const DAY_US = 86_400_000 * US;

type Corpus = Pick<ComputeAnalyticsV2Input, "owners" | "occurrencesByOwner">;
function inputFor(corpus: Corpus, queued: readonly string[], extra: Partial<ComputeAnalyticsV2Input> = {}): ComputeAnalyticsV2Input {
  const queuedDays = { days: queued, lastSequence: 7 };
  return {
    owners: corpus.owners,
    occurrencesByOwner: corpus.occurrencesByOwner,
    occurrenceRange: analyticsV2RequiredOccurrenceRange({ nowMs: NOW_MS, queuedDays }),
    devicesByDay: oneDevicePerOwner(corpus.occurrencesByOwner, queued),
    queuedDays,
    nowMs: NOW_MS,
    revisionSeed: 0,
    ...extra,
  };
}

describe("community aggregate exclusions: the per-day predicate", () => {
  it("applies D1's weekly predicate per day, at microsecond resolution", () => {
    const day = "2026-09-21";
    const start = dayStartUs(day);
    const end = start + DAY_US;
    const on = (effectiveAtUs: number, expiresAtUs: number | null) =>
      analyticsV2ExcludedOn([{ effectiveAtUs, expiresAtUs }], day);
    // effective_at before the end of D, expires_at NULL or after its start.
    expect(on(start, null)).toBe(true);
    expect(on(end - 1, null)).toBe(true);
    expect(on(end, null)).toBe(false);
    expect(on(start - DAY_US, start + 1)).toBe(true);
    expect(on(start - DAY_US, start)).toBe(false);
    expect(on(start - 2 * DAY_US, start - DAY_US)).toBe(false);
    expect(analyticsV2ExcludedOn(undefined, day)).toBe(false);
    expect(analyticsV2ExclusionsOn([{ effectiveAtUs: start, expiresAtUs: end }, { effectiveAtUs: end, expiresAtUs: null }],
      day)).toEqual([{ effectiveAtUs: start, expiresAtUs: end }]);
    expect(() => analyticsV2ExcludedOn([{ effectiveAtUs: start, expiresAtUs: null }], "2026-02-30"))
      .toThrow("ANALYTICS_V2_INPUT_INVALID:exclusions.day");
  });

  it("refuses malformed intervals and pins the digest of no exclusions", async () => {
    for (const value of [[], null, [{ effectiveAtUs: 1 }], [{ effectiveAtUs: 2, expiresAtUs: 2 }],
      [{ effectiveAtUs: -1, expiresAtUs: null }], [{ effectiveAtUs: 1.5, expiresAtUs: null }],
      [{ effectiveAtUs: 1, expiresAtUs: null, extra: true }]]) {
      expect(() => validAnalyticsV2ExclusionIntervals(value)).toThrow("ANALYTICS_V2_INPUT_INVALID:exclusions");
    }
    expect(await analyticsV2ExclusionsSha256([])).toBe(ANALYTICS_V2_NO_EXCLUSIONS_SHA256);
    expect(ANALYTICS_V2_NO_EXCLUSIONS_SHA256).toBe(await sha256Hex(canonicalJson([ANALYTICS_V2_EXCLUSIONS_METHOD, []])));
    // Every field of every row is in the identity, revoked rows included.
    const row = { exclusionId: "x1", participantId: "p", scope: "community_weekly", state: "active",
      effectiveAtUs: 1, expiresAtUs: null };
    const base = await analyticsV2ExclusionsSha256([row]);
    for (const changed of [{ ...row, state: "revoked" }, { ...row, expiresAtUs: 5 }, { ...row, effectiveAtUs: 2 },
      { ...row, participantId: "q" }, { ...row, exclusionId: "x2" }]) {
      expect(await analyticsV2ExclusionsSha256([changed])).not.toBe(base);
    }
  });
});

describe("community aggregate exclusions in computeAnalyticsV2 (N-EXCL)", () => {
  const corpus = composeProofCorpus();
  const [excluded] = corpus.owners;
  const without = { owners: corpus.owners.slice(1), occurrencesByOwner: new Map([...corpus.occurrencesByOwner]
    .filter(([digest]) => digest !== excluded!.ownerDigest)) };
  const excludedDay = addDays(TODAY, -9);

  it("leaves an owner excluded on one day out of that day's daily and preview day only", async () => {
    expect(corpus.publishedDays).toContain(excludedDay);
    expect(corpus.occurrencesByOwner.get(excluded!.ownerDigest)!.has(excludedDay)).toBe(true);
    const base = await computeAnalyticsV2(inputFor(corpus, corpus.publishedDays));
    const reference = await computeAnalyticsV2(inputFor(without, corpus.publishedDays));
    const outputs = await computeAnalyticsV2(inputFor(corpus, corpus.publishedDays, {
      exclusions: new Map([[excluded!.ownerDigest, [{ effectiveAtUs: dayStartUs(excludedDay),
        expiresAtUs: dayStartUs(excludedDay) + DAY_US }]]]) }));
    // The owner's own rows and every refusal are unchanged. (No owner of this
    // corpus blocks a day; the days an excluded owner's refusals would block
    // are the cases below.)
    for (const family of ["ownerDays", "cacheBands", "ownerFits", "ownerModelDates", "refusals"] as const) {
      expect(outputs[family]).toEqual(base[family]);
    }
    expect(outputs.blockedDays).toEqual([]);
    // The excluded day is the cohort without the owner; every other day is the base.
    for (const candidate of outputs.dailyCandidates) {
      const expected = (candidate.day === excludedDay ? reference : base).dailyCandidates
        .find((other) => other.day === candidate.day)!;
      expect(candidate.payloadSha256, candidate.day).toBe(expected.payloadSha256);
    }
    expect(outputs.dailyCandidates.find((candidate) => candidate.day === excludedDay)!.payloadSha256)
      .not.toBe(base.dailyCandidates.find((candidate) => candidate.day === excludedDay)!.payloadSha256);
    const preview = outputs.preview as AdminCommunityAllowancePreview;
    const basePreview = base.preview as AdminCommunityAllowancePreview;
    const referencePreview = reference.preview as AdminCommunityAllowancePreview;
    expect(preview.coverage).toEqual(basePreview.coverage);
    for (const [index, day] of preview.days.entries()) {
      expect(day, day.day).toEqual((day.day === excludedDay ? referencePreview : basePreview).days[index]);
    }
    for (const [index, day] of preview.models.days.entries()) {
      expect(day, day.day).toEqual((day.day === excludedDay ? referencePreview : basePreview).models.days[index]);
    }
  }, 240_000);

  it("an owner excluded on every day leaves the community outputs of the cohort without it", async () => {
    const reference = await computeAnalyticsV2(inputFor(without, corpus.publishedDays));
    const base = await computeAnalyticsV2(inputFor(corpus, corpus.publishedDays));
    const outputs = await computeAnalyticsV2(inputFor(corpus, corpus.publishedDays, {
      exclusions: new Map([[excluded!.ownerDigest, [{ effectiveAtUs: 0, expiresAtUs: null }]]]) }));
    expect(outputs.preview).toEqual(reference.preview);
    expect(outputs.dailyCandidates.map((candidate) => candidate.payloadSha256))
      .toEqual(reference.dailyCandidates.map((candidate) => candidate.payloadSha256));
    expect(outputs.ownerFits).toEqual(base.ownerFits);
    // A revoked or expired exclusion (none covers a day) changes nothing.
    const expired = await computeAnalyticsV2(inputFor(corpus, corpus.publishedDays, {
      exclusions: new Map([[excluded!.ownerDigest, [{ effectiveAtUs: 0, expiresAtUs: 1 }]]]) }));
    expect(expired.preview).toEqual(base.preview);
    expect(expired.dailyCandidates).toEqual(base.dailyCandidates);
  }, 240_000);

  it("refuses exclusions of an owner outside the run and malformed intervals", async () => {
    await expect(computeAnalyticsV2(inputFor(corpus, corpus.publishedDays, {
      exclusions: new Map([["f".repeat(64), [{ effectiveAtUs: 0, expiresAtUs: null }]]]) })))
      .rejects.toThrow("ANALYTICS_V2_INPUT_INVALID:exclusions.owner");
    await expect(computeAnalyticsV2(inputFor(corpus, corpus.publishedDays, {
      exclusions: new Map([[excluded!.ownerDigest, []]]) }))).rejects.toThrow("ANALYTICS_V2_INPUT_INVALID:exclusions");
    await expect(computeAnalyticsV2(inputFor(corpus, corpus.publishedDays, {
      exclusions: [] as unknown as ComputeAnalyticsV2Input["exclusions"] }))).rejects.toThrow("ANALYTICS_V2_INPUT_INVALID:exclusions");
  });
});

// An owner excluded on day D is outside D's cohort (d43c8f92's weekly builder
// removed an excluded participant before anything else): its refusals keep
// being recorded, but they neither block D's public daily nor withhold the
// preview when it is excluded on every day the preview carries.
describe("an excluded owner's refusals decide nothing for the community (N-EXCL)", () => {
  const corpus = composeProofCorpus();
  const queued = corpus.publishedDays;
  const always = [{ effectiveAtUs: 0, expiresAtUs: null }];
  const onDay = (day: string) => [{ effectiveAtUs: dayStartUs(day), expiresAtUs: dayStartUs(day) + DAY_US }];
  const refusalsOf = (outputs: Awaited<ReturnType<typeof computeAnalyticsV2>>, ownerDigest: string) =>
    outputs.refusals.filter((refusal) => refusal.ownerDigest === ownerDigest);
  const contentOf = (outputs: Awaited<ReturnType<typeof computeAnalyticsV2>>) =>
    new Map(outputs.dailyCandidates.map((candidate) => [candidate.day, candidate.payloadSha256]));
  // The community outputs of the corpus without the extra owner.
  let reference: Promise<Awaited<ReturnType<typeof computeAnalyticsV2>>> | undefined;
  const referenceRun = () => (reference ??= computeAnalyticsV2(inputFor(corpus, queued)));

  it("an owner over the memory budget excluded on its day does not block it; excluded everywhere it withholds nothing", async () => {
    const big = syntheticOwner(4, "pro");
    const bigDay = queued[3]!;
    // Ten days of 120,000 usage rows, one of them queued: refused by the memory budget, never read.
    const bigEvidence = new Map(Array.from({ length: 10 }, (_, index) => [addDays(bigDay, -index),
      { usage: 120_000, quota: 9, session: 1 }]));
    const ownerEvidence = new Map([...corpus.occurrencesByOwner].map(([digest, days]) => [digest, new Map([...days]
      .map(([day, value]) => [day, { usage: value.usage.length, quota: value.quota.length, session: value.session.length }]))]));
    ownerEvidence.set(big.digest, bigEvidence);
    const run = (exclusions?: ComputeAnalyticsV2Input["exclusions"]) => computeAnalyticsV2({
      ...inputFor({ owners: [...corpus.owners, effectiveV2Owner(big)], occurrencesByOwner: corpus.occurrencesByOwner }, queued),
      occurrencesByOwner: new Map(), ownerEvidence,
      loadOwnerOccurrences: async (digest: string) => corpus.occurrencesByOwner.get(digest) ?? new Map(),
      ...(exclusions === undefined ? {} : { exclusions }) });
    const base = await run();
    const memoryRefusals = [
      { ownerDigest: big.digest, day: null, family: "owner", reason: "memory_budget" },
      { ownerDigest: big.digest, day: bigDay, family: "daily", reason: "memory_budget" },
    ];
    expect(refusalsOf(base, big.digest)).toEqual(memoryRefusals);
    expect(base.blockedDays).toEqual([bigDay]);
    expect(base.preview).toBeNull();

    // Excluded on its queued day only: the day publishes, the refusals stay,
    // and the preview is still withheld (it is a member of the other days).
    const partial = await run(new Map([[big.digest, onDay(bigDay)]]));
    expect(refusalsOf(partial, big.digest)).toEqual(memoryRefusals);
    expect(partial.blockedDays).toEqual([]);
    expect(contentOf(partial)).toEqual(contentOf(await referenceRun()));
    expect(partial.preview).toBeNull();

    // Excluded on every day: the community outputs are the cohort's without it.
    const everywhere = await run(new Map([[big.digest, always]]));
    expect(refusalsOf(everywhere, big.digest)).toEqual(memoryRefusals);
    expect(everywhere.blockedDays).toEqual([]);
    expect(contentOf(everywhere)).toEqual(contentOf(await referenceRun()));
    expect(everywhere.preview).not.toBeNull();
    expect(everywhere.preview).toEqual((await referenceRun()).preview);
  }, 240_000);

  it("a non-effective typed owner excluded on its evidence day does not block it", async () => {
    const v1Known = syntheticOwner(8), v1Other = syntheticOwner(9);
    const knownDay = queued[2]!, otherDay = queued[4]!;
    const owners = [...corpus.owners, v1OnlyV2Owner(v1Known), v1OnlyV2Owner(v1Other)];
    const occurrencesByOwner = new Map([...corpus.occurrencesByOwner,
      [v1Known.digest, new Map([[knownDay, composeFacts(v1Known).get(knownDay)!]])],
      // A second typed non-effective owner on two days, never excluded.
      [v1Other.digest, new Map([knownDay, otherDay].map((day) => [day, composeFacts(v1Other).get(day)!]))]]);
    const run = (exclusions?: ComputeAnalyticsV2Input["exclusions"]) =>
      computeAnalyticsV2(inputFor({ owners, occurrencesByOwner }, queued, exclusions === undefined ? {} : { exclusions }));
    const base = await run();
    expect(base.blockedDays).toEqual([knownDay, otherDay]);
    // Excluding the first owner on knownDay leaves knownDay blocked by the
    // second owner: one non-excluded blocker is enough.
    const one = await run(new Map([[v1Known.digest, always]]));
    expect(one.blockedDays).toEqual([knownDay, otherDay]);
    expect(one.refusals).toEqual(base.refusals);
    // Both excluded on the days they hold: nothing is blocked, the refusals
    // are recorded as before, and every day is the cohort's own fold.
    const both = await run(new Map([[v1Known.digest, onDay(knownDay)],
      [v1Other.digest, [...onDay(knownDay), ...onDay(otherDay)]]]));
    expect(both.blockedDays).toEqual([]);
    expect(both.refusals).toEqual(base.refusals);
    expect(refusalsOf(both, v1Known.digest)).toEqual([
      { ownerDigest: v1Known.digest, day: null, family: "owner", reason: "non_effective_source_unported" },
      { ownerDigest: v1Known.digest, day: knownDay, family: "daily", reason: "non_effective_source_unported" },
    ]);
    expect(contentOf(both)).toEqual(contentOf(await referenceRun()));
    expect(both.preview).toEqual((await referenceRun()).preview);
  }, 240_000);

  it("an owner without a fit whose days are refused blocks and withholds only what it is a member of", async () => {
    const conflictOwner = syntheticOwner(5);
    const conflictDay = addDays(TODAY, -1);
    const owners = [...corpus.owners, effectiveV2Owner(conflictOwner)];
    const occurrencesByOwner = new Map([...corpus.occurrencesByOwner,
      [conflictOwner.digest, conflictFacts(conflictOwner, conflictDay)]]);
    const run = (exclusions?: ComputeAnalyticsV2Input["exclusions"]) =>
      computeAnalyticsV2(inputFor({ owners, occurrencesByOwner }, queued, exclusions === undefined ? {} : { exclusions }));
    const base = await run();
    expect(base.blockedDays).toEqual([conflictDay, TODAY]);
    expect(base.ownerFits.some((row) => row.ownerDigest === conflictOwner.digest)).toBe(false);
    expect(base.preview).toBeNull();

    // Excluded on the conflict day only: that day publishes without it, TODAY
    // stays blocked by it, and the preview is still withheld.
    const partial = await run(new Map([[conflictOwner.digest, onDay(conflictDay)]]));
    expect(partial.blockedDays).toEqual([TODAY]);
    expect(partial.refusals).toEqual(base.refusals);
    expect(contentOf(partial).get(conflictDay)).toBe(contentOf(await referenceRun()).get(conflictDay));
    expect(partial.preview).toBeNull();

    // Excluded on every day: nothing blocked, the preview is the cohort's
    // without it, and its own rows and refusals are as before.
    const everywhere = await run(new Map([[conflictOwner.digest, always]]));
    expect(everywhere.blockedDays).toEqual([]);
    expect(contentOf(everywhere)).toEqual(contentOf(await referenceRun()));
    expect(everywhere.preview).toEqual((await referenceRun()).preview);
    for (const family of ["ownerDays", "cacheBands", "ownerFits", "ownerModelDates", "refusals"] as const) {
      expect(everywhere[family]).toEqual(base[family]);
    }
  }, 240_000);
});
