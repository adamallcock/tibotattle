// E-OWNERSET: saved owner sets in the community fold (compute-community.ts)
// and the compute core's owner-set input (compute.ts). A published day folds
// its saved set S(d) plus every computed owner with non-empty values on d; a
// departed or empty-read member folds its stored contribution, never a zero;
// an unfoldable contribution blocks the day; with no saved set the fold is the
// computed-owners fold byte for byte. Synthetic, content-free values only.
import { describe, expect, it } from "vitest";
import {
  buildAnalyticsV2Community,
  analyticsV2NeededContributions,
  analyticsV2SavedValueKey,
  type AnalyticsV2CommunityInput,
} from "../src/analytics-v2/compute-community";
import { computeAnalyticsV2 } from "../src/analytics-v2/compute";
import type { AnalyticsV2Owner, AnalyticsV2OwnerSetState, AnalyticsV2SavedDay } from "../src/analytics-v2/contract";
import {
  analyticsV2ContributionDigests,
  analyticsV2ContributionKey,
  analyticsV2FrozenParticipants,
} from "../src/analytics-v2/owner-sets";
import {
  buildCommunityDailyPayload,
  createV11DailyProjectionValues,
  publicInputs,
  type V11DailyProjectionValues,
} from "../vendor/analytics-d43c8f92/entry";

const NOW_MS = Date.parse("2026-09-30T18:00:00.000Z");
const DAY = "2026-09-28";
const OTHER_DAY = "2026-09-29";
const digest = (n: number) => String(n).repeat(64);
const A = digest(1), B = digest(2), C = digest(3), X = digest(7);

function owner(ownerDigest: string): AnalyticsV2Owner {
  return Object.freeze({ participantId: `synthetic-owner-${ownerDigest.slice(0, 1)}`, ownerDigest, hasV1: false,
    hasV11: false, hasV12: true, hasLegacy: false, hasEffective: true, source: "effective" });
}

/** Valid daily values with `quota` quota observations and `session` session dimensions. */
function values(day: string, quota: number, session = 0): V11DailyProjectionValues {
  const value = createV11DailyProjectionValues(day);
  value.counts = { usage: 0, quota, session };
  return value;
}

function savedDay(members: Record<string, { version: number; devices: number }>, bootstrapped = false): AnalyticsV2SavedDay {
  return { members: new Map(Object.entries(members).map(([ownerDigest, member]) =>
    [ownerDigest, { ...member, valuesSha256: "a".repeat(64) }])), bootstrapped };
}

function communityInput(overrides: {
  computed: string[];
  fresh: Record<string, V11DailyProjectionValues>;
  queued?: string[];
  saved?: Map<string, AnalyticsV2SavedDay>;
  frozen?: AnalyticsV2OwnerSetState["frozen"];
  savedValues?: Map<string, unknown>;
  devices?: Record<string, number>;
  exclusions?: AnalyticsV2CommunityInput["exclusions"];
  blockers?: AnalyticsV2CommunityInput["blockers"];
}): AnalyticsV2CommunityInput {
  const queued = overrides.queued ?? [DAY];
  const computedOwners = overrides.computed.sort().map(owner);
  const dailyValues = new Map(queued.map((day) => [day, new Map(computedOwners.map((each) =>
    [each.ownerDigest, day === DAY ? overrides.fresh[each.ownerDigest] ?? values(day, 0) : values(day, 0)]))]));
  return {
    nowMs: NOW_MS,
    revisionSeed: 0,
    queued,
    blockers: overrides.blockers ?? new Map(),
    dailyValues,
    computedOwners,
    // No fits: the preview is withheld, which keeps these cases to the daily fold.
    effectiveDigests: computedOwners.map((each) => each.ownerDigest),
    devicesByDay: new Map(queued.map((day) => [day, new Map(Object.entries(overrides.devices ?? {}))])),
    fitsByOwner: new Map(),
    modelDates: [],
    compositionsByDate: new Map(),
    modelRefusedByDate: new Map(),
    exclusions: overrides.exclusions ?? new Map(),
    ownerSets: { days: overrides.saved ?? new Map(), frozen: overrides.frozen ?? null },
    savedValues: overrides.savedValues ?? new Map(),
  };
}

/** The computed-owners fold before E-OWNERSET: every computed owner in digest order. */
async function referencePayload(day: string, entries: Array<[V11DailyProjectionValues, number]>) {
  const inputs = publicInputs(entries.map(([value]) => value), entries.map(([, devices]) => devices));
  return buildCommunityDailyPayload({ day, revision: 1, releasedAt: new Date(NOW_MS).toISOString(), ...inputs });
}

describe("saved owner sets in the community fold (E-OWNERSET)", () => {
  it("with no saved set, folds exactly the computed owners and records the non-empty ones as new members", async () => {
    const a = values(DAY, 3), c = values(DAY, 5, 2);
    const result = await buildAnalyticsV2Community(communityInput({ computed: [C, A, B], fresh: { [A]: a, [C]: c },
      devices: { [A]: 2 } }));
    const [candidate] = result.dailyCandidates;
    expect(candidate!.payload).toEqual(await referencePayload(DAY, [[a, 2], [values(DAY, 0), 0], [c, 1]]));
    expect(candidate!.members).toEqual([
      { ownerDigest: A, origin: "computed", values: a, devices: 2, savedVersion: null },
      { ownerDigest: C, origin: "computed", values: c, devices: 1, savedVersion: null },
    ]);
    expect(candidate!.bootstrap).toBeNull();
    expect(result.ownerSets).toEqual({ contributionRetainedEvidenceAbsent: 0, savedMembersFolded: 0,
      memberContributionUnavailableDays: [] });
    expect(result.preview).toBeNull();
  });

  it("keeps a departed member's contribution in its digest position (round 2), never a zero", async () => {
    const a = values(DAY, 3), stored = values(DAY, 11, 4);
    const result = await buildAnalyticsV2Community(communityInput({ computed: [A, C], fresh: { [A]: a },
      saved: new Map([[DAY, savedDay({ [A]: { version: 1, devices: 1 }, [B]: { version: 3, devices: 2 } })]]),
      savedValues: new Map([[analyticsV2SavedValueKey(DAY, B, 3), stored]]) }));
    const [candidate] = result.dailyCandidates;
    expect(candidate!.payload).toEqual(await referencePayload(DAY, [[a, 1], [stored, 2], [values(DAY, 0), 0]]));
    expect((candidate!.payload as { totals: { contributingParticipants: number } }).totals.contributingParticipants).toBe(2);
    expect(candidate!.members.map((member) => [member.ownerDigest, member.origin, member.savedVersion]))
      .toEqual([[A, "computed", null], [B, "saved", 3]]);
    expect(result.ownerSets.savedMembersFolded).toBe(1);
  });

  it("retains a computed member's contribution when its read for the day is empty", async () => {
    const stored = values(DAY, 4);
    const result = await buildAnalyticsV2Community(communityInput({ computed: [A, B], fresh: { [B]: values(DAY, 1) },
      saved: new Map([[DAY, savedDay({ [A]: { version: 2, devices: 3 }, [B]: { version: 1, devices: 1 } })]]),
      savedValues: new Map([[analyticsV2SavedValueKey(DAY, A, 2), stored]]) }));
    const [candidate] = result.dailyCandidates;
    expect(candidate!.payload).toEqual(await referencePayload(DAY, [[stored, 3], [values(DAY, 1), 1]]));
    expect(candidate!.members.map((member) => member.origin)).toEqual(["retained", "computed"]);
    expect(candidate!.members[0]!.savedVersion).toBe(2);
    expect(result.ownerSets.contributionRetainedEvidenceAbsent).toBe(1);
  });

  it("leaves a member excluded on the day out of its fold and in its set", async () => {
    const day = Date.parse(`${DAY}T00:00:00.000Z`) * 1_000;
    const result = await buildAnalyticsV2Community(communityInput({ computed: [A, B],
      fresh: { [A]: values(DAY, 3), [B]: values(DAY, 5) },
      saved: new Map([[DAY, savedDay({ [B]: { version: 1, devices: 1 } })]]),
      exclusions: new Map([[B, [{ effectiveAtUs: day, expiresAtUs: day + 86_400_000_000 }]]]) }));
    const [candidate] = result.dailyCandidates;
    expect(candidate!.payload).toEqual(await referencePayload(DAY, [[values(DAY, 3), 1]]));
    expect(candidate!.members.map((member) => [member.origin, member.values, member.savedVersion]))
      .toEqual([["computed", values(DAY, 3), null], ["excluded", null, null]]);
  });

  it("blocks a day whose member contribution cannot be folded under the run's kernel", async () => {
    const saved = new Map([[DAY, savedDay({ [X]: { version: 1, devices: 1 } })]]);
    for (const stored of [
      undefined,
      { ...values(DAY, 2), registrySha256: "f".repeat(64) },
      { ...values(DAY, 2), schemaVersion: "v11-daily-projection-values-v0" },
      values(OTHER_DAY, 2),
      values(DAY, 0),
    ]) {
      const savedValues = new Map(stored === undefined ? [] : [[analyticsV2SavedValueKey(DAY, X, 1), stored]]);
      const result = await buildAnalyticsV2Community(communityInput({ computed: [A], fresh: { [A]: values(DAY, 1) },
        queued: [DAY, OTHER_DAY], saved, savedValues }));
      expect(result.dailyCandidates.map((candidate) => candidate.day)).toEqual([OTHER_DAY]);
      expect(result.blockedDays).toEqual([DAY]);
      expect(result.ownerSets.memberContributionUnavailableDays).toEqual([DAY]);
    }
  });

  it("names the contributions a fold needs: uncomputed and empty-read members not excluded", () => {
    const input = communityInput({ computed: [A, B], fresh: { [B]: values(DAY, 1) },
      saved: new Map([[DAY, savedDay({ [A]: { version: 2, devices: 1 }, [B]: { version: 1, devices: 1 },
        [X]: { version: 4, devices: 1 } })]]) });
    expect(analyticsV2NeededContributions(input)).toEqual([
      { day: DAY, ownerDigest: A, version: 2 }, { day: DAY, ownerDigest: X, version: 4 }]);
    expect(analyticsV2SavedValueKey(DAY, A, 2)).toBe(analyticsV2ContributionKey({ day: DAY, ownerDigest: A, version: 2 }));
  });

  it("records the first frozen-window recording as verified only when Cloudflare's count matches (round 7)", async () => {
    const frozen = { exportSha256: "e".repeat(64), fromDay: "2025-10-01", throughDay: DAY,
      participants: new Map([[DAY, 2]]) };
    const fresh = { [A]: values(DAY, 1), [B]: values(DAY, 2) };
    const run = async (extra: Partial<Parameters<typeof communityInput>[0]>) =>
      (await buildAnalyticsV2Community(communityInput({ computed: [A, B], fresh, frozen, ...extra })))
        .dailyCandidates.find((candidate) => candidate.day === DAY)!.bootstrap;
    expect(await run({})).toEqual({ provenance: 2, frozenParticipants: 2, frozenExportSha256: "e".repeat(64) });
    expect(await run({ fresh: { [A]: values(DAY, 1) } }))
      .toEqual({ provenance: 3, frozenParticipants: 2, frozenExportSha256: "e".repeat(64) });
    expect(await run({ frozen: { ...frozen, participants: new Map() } }))
      .toEqual({ provenance: 3, frozenParticipants: null, frozenExportSha256: "e".repeat(64) });
    // Outside the window, after the first recording, or onto an existing set: provenance 1 (no bootstrap).
    expect(await run({ frozen: { ...frozen, throughDay: "2026-09-27" } })).toBeNull();
    expect(await run({ saved: new Map([[DAY, savedDay({}, true)]]) })).toBeNull();
    expect(await run({ frozen: null })).toBeNull();
  });

  it("digests a contribution with and without its price identity", async () => {
    const value = values(DAY, 3);
    const digests = await analyticsV2ContributionDigests(value);
    const restamped = await analyticsV2ContributionDigests({ ...value, registrySha256: "0".repeat(64),
      pricingMethodVersion: "server-api-price-equivalent-v9.9" });
    expect(restamped.valuesSha256).not.toBe(digests.valuesSha256);
    expect(restamped.stableValuesSha256).toBe(digests.stableValuesSha256);
    expect((await analyticsV2ContributionDigests(values(DAY, 4))).stableValuesSha256).not.toBe(digests.stableValuesSha256);
    await expect(analyticsV2ContributionDigests(null)).rejects.toThrow("ANALYTICS_V2_CONTRIBUTION_INVALID");
  });

  it("reads the frozen export's per-day participants and refuses a malformed one", () => {
    const day = (dayLabel: string, contributingParticipants: unknown) =>
      ({ day: dayLabel, revision: 1, releasedAt: `${dayLabel}T01:00:00.000Z`, payload: { totals: { contributingParticipants } } });
    const frozen = { from: "2025-09-29", to: DAY, allowanceState: "updating", allowanceReadState: "confirmed",
      allowanceBreakdowns: null, cacheRetention: null, days: [day("2026-09-27", 3), day(DAY, 0)] } as const;
    const read = analyticsV2FrozenParticipants(frozen as never, "e".repeat(64));
    expect([...read.participants]).toEqual([["2026-09-27", 3], [DAY, 0]]);
    expect(read.fromDay).toBe("2025-09-29");
    for (const bad of [{ ...frozen, days: [day(DAY, -1)] }, { ...frozen, days: [day(DAY, 1), day(DAY, 1)] },
      { ...frozen, days: [day(DAY, "2")] }, { ...frozen, from: "2026-10-01" }]) {
      expect(() => analyticsV2FrozenParticipants(bad as never, "e".repeat(64))).toThrow("ANALYTICS_V2_FROZEN_EXPORT_INVALID");
    }
    expect(() => analyticsV2FrozenParticipants(frozen as never, "E".repeat(64))).toThrow("ANALYTICS_V2_FROZEN_EXPORT_INVALID");
  });
});

describe("the compute core's owner-set input (E-OWNERSET)", () => {
  const queuedDays = { days: [DAY], lastSequence: 3 };
  const base = { owners: [], occurrencesByOwner: new Map(), devicesByDay: new Map(), queuedDays, nowMs: NOW_MS,
    revisionSeed: 0 };

  it("loads only the contributions the fold needs, and folds a departed member's", async () => {
    const stored = values(DAY, 6, 1);
    const requested: unknown[] = [];
    const outputs = await computeAnalyticsV2({ ...base, ownerSets: {
      state: { days: new Map([[DAY, savedDay({ [X]: { version: 2, devices: 4 } })]]), frozen: null },
      loadValues: async (keys) => {
        requested.push(...keys);
        return new Map(keys.map((key) => [analyticsV2ContributionKey(key), stored]));
      },
    } });
    expect(requested).toEqual([{ day: DAY, ownerDigest: X, version: 2 }]);
    const [candidate] = outputs.dailyCandidates;
    expect(candidate!.payload).toEqual(await referencePayload(DAY, [[stored, 4]]));
    expect(candidate!.members).toEqual([{ ownerDigest: X, origin: "saved", values: null, devices: null, savedVersion: 2 }]);
    expect(outputs.ownerSets.savedMembersFolded).toBe(1);
    // Without the input, nothing is saved and the day folds no one.
    const bare = await computeAnalyticsV2(base);
    expect(bare.dailyCandidates[0]!.members).toEqual([]);
    expect(bare.ownerSets).toEqual({ contributionRetainedEvidenceAbsent: 0, savedMembersFolded: 0,
      memberContributionUnavailableDays: [] });
  });

  it("refuses a malformed owner-set input before any kernel runs", async () => {
    const loadValues = async () => new Map();
    const good: AnalyticsV2SavedDay = savedDay({ [X]: { version: 1, devices: 1 } });
    for (const [ownerSets, what] of [
      [{ state: { days: new Map([[OTHER_DAY, good]]), frozen: null }, loadValues }, "ownerSets.days"],
      [{ state: { days: new Map([[DAY, { ...good, bootstrapped: "no" }]]), frozen: null }, loadValues }, "ownerSets.days"],
      [{ state: { days: new Map([[DAY, savedDay({ [X]: { version: 0, devices: 1 } })]]), frozen: null }, loadValues },
        "ownerSets.members"],
      [{ state: { days: new Map([[DAY, savedDay({ [X]: { version: 1, devices: 0 } })]]), frozen: null }, loadValues },
        "ownerSets.members"],
      [{ state: { days: new Map([[DAY, savedDay({ BAD: { version: 1, devices: 1 } })]]), frozen: null }, loadValues },
        "ownerSets.members"],
      [{ state: { days: new Map(), frozen: { exportSha256: "e".repeat(64), fromDay: DAY, throughDay: OTHER_DAY,
        participants: new Map([["2026-10-05", 1]]) } }, loadValues }, "ownerSets.frozen"],
      [{ state: { days: new Map(), frozen: { exportSha256: "e".repeat(64), fromDay: OTHER_DAY, throughDay: DAY,
        participants: new Map() } }, loadValues }, "ownerSets.frozen"],
      [{ state: { days: new Map() }, loadValues: "no" }, "ownerSets"],
    ] as const) {
      await expect(computeAnalyticsV2({ ...base, ownerSets: ownerSets as never })).rejects
        .toThrow(`ANALYTICS_V2_INPUT_INVALID:${what}`);
    }
    // A loader that answers with anything but a Map is a defect.
    await expect(computeAnalyticsV2({ ...base, ownerSets: { state: { days: new Map([[DAY, good]]), frozen: null },
      loadValues: async () => [] as never } })).rejects.toThrow("ANALYTICS_V2_INPUT_INVALID:ownerSets.loadValues");
  });
});
