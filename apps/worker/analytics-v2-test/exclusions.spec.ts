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
import { addDays, composeProofCorpus, NOW_MS, oneDevicePerOwner, TODAY } from "./fixtures/synthetic-occurrences.mjs";

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
    // The owner's own rows and every refusal are unchanged.
    for (const family of ["ownerDays", "cacheBands", "ownerFits", "ownerModelDates", "refusals", "blockedDays"] as const) {
      expect(outputs[family]).toEqual(base[family]);
    }
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
