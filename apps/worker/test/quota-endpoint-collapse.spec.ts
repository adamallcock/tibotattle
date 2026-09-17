import { describe, expect, it } from "vitest";
import { QUOTA_CALIBRATION_POLICY } from "@app-usagemonitor/quota-analysis";
import {
  addQuotaFragmentValue,
  closeQuotaClusterSpacing,
  createQuotaClusterSpacing,
  offerQuotaClusterEndpoint,
  addQuotaReset,
  collapseQuotaEndpointStream,
  createQuotaResetClusterState,
  mergeQuotaResetHulls,
  quotaFragmentEligible,
  quotaResetClusterEntries,
  quotaResetRepresentativeMs,
  validQuotaResetClusterEntries,
  QUOTA_ENDPOINT_MINIMUM_RETAINED,
  QUOTA_ENDPOINT_MIN_SPACING_MS,
  QUOTA_RESET_CLUSTER_TOLERANCE_MS,
  type QuotaFragmentStats,
} from "../src/quota-endpoint-collapse";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BASE = Date.parse("2026-08-01T00:00:00.000Z");

function clustered(group: string, resets: readonly number[]) {
  const state = createQuotaResetClusterState();
  for (const reset of resets) expect(addQuotaReset(state, group, reset)).toBe(true);
  return state;
}

interface Row { id: number; observedAtMs: number; usedPercent: number; key: string }
const row = (id: number, minutes: number, usedPercent: number, key = "k"): Row =>
  ({ id, observedAtMs: BASE + minutes * MINUTE, usedPercent, key });
const collapse = (rows: readonly Row[]) => collapseQuotaEndpointStream(rows, (value) => value.key,
  (value) => ({ id: value.id, observedAtMs: value.observedAtMs, usedPercent: value.usedPercent }));

describe("quota reset clustering", () => {
  it("merges restated instants inside the tolerance and separates distant pools", () => {
    // Seconds-level jitter around one instant is one pool; a pool that spawns
    // days later is another. The representative is the largest instant the
    // pool restated, so it stays after every observation that carried it.
    const jitter = [BASE, BASE + 2_000, BASE + 45_000, BASE + 17 * MINUTE];
    const distant = BASE + 7 * 24 * HOUR;
    const state = clustered("era", [...jitter, distant, distant + 30_000]);
    expect(quotaResetClusterEntries(state)).toEqual([["era", [
      [BASE, BASE + 17 * MINUTE], [distant, distant + 30_000],
    ]]]);
    for (const reset of jitter) expect(quotaResetRepresentativeMs(state, "era", reset)).toBe(BASE + 17 * MINUTE);
    expect(quotaResetRepresentativeMs(state, "era", distant)).toBe(distant + 30_000);
    expect(quotaResetRepresentativeMs(state, "era", BASE + HOUR)).toBeNull();
    expect(quotaResetRepresentativeMs(state, "other", BASE)).toBeNull();
  });

  it("keeps two interleaved pools of one slot apart however they arrive", () => {
    // A five-hour pool and a weekly pool of the same slot report back and
    // forth. Single-linkage on the set, not on arrival order, so every
    // interleaving settles on the same two pools.
    const five = BASE + 5 * HOUR, week = BASE + 7 * 24 * HOUR;
    const interleaved = [five, week, five + 12_000, week + 9_000, five + 40_000, week + 21_000];
    const canonical = quotaResetClusterEntries(clustered("era", interleaved));
    expect(canonical).toEqual([["era", [[five, five + 40_000], [week, week + 21_000]]]]);
    expect(quotaResetClusterEntries(clustered("era", [...interleaved].reverse()))).toEqual(canonical);
    expect(quotaResetClusterEntries(clustered("era", [...interleaved].sort()))).toEqual(canonical);
  });

  it("joins two pools only through an instant that chains them", () => {
    // Exactly the tolerance still links; one millisecond beyond does not, and
    // a later bridging instant merges hulls that were separate before it.
    const far = BASE + QUOTA_RESET_CLUSTER_TOLERANCE_MS;
    expect(quotaResetClusterEntries(clustered("era", [BASE, far]))).toEqual([["era", [[BASE, far]]]]);
    expect(quotaResetClusterEntries(clustered("era", [BASE, far + 1])))
      .toEqual([["era", [[BASE, BASE], [far + 1, far + 1]]]]);
    const bridged = clustered("era", [BASE, BASE + 4 * HOUR, BASE + 2 * HOUR]);
    expect(quotaResetClusterEntries(bridged)).toEqual([["era", [[BASE, BASE + 4 * HOUR]]]]);
    expect(quotaResetRepresentativeMs(bridged, "era", BASE)).toBe(BASE + 4 * HOUR);
  });

  it("refuses past the pool bound and validates a decoded component", () => {
    const state = createQuotaResetClusterState();
    expect(addQuotaReset(state, "era", BASE, 2)).toBe(true);
    expect(addQuotaReset(state, "era", BASE + 30_000, 2)).toBe(true);
    expect(addQuotaReset(state, "era", BASE + 10 * HOUR, 2)).toBe(true);
    expect(addQuotaReset(state, "era", BASE + 40 * HOUR, 2)).toBe(false);
    expect(state.count).toBe(2);
    expect(validQuotaResetClusterEntries(quotaResetClusterEntries(state))).toBe(true);
    expect(validQuotaResetClusterEntries([])).toBe(true);
    expect(validQuotaResetClusterEntries([["era", [[BASE, BASE - 1]]]])).toBe(false);
    // Two hulls inside the tolerance of each other were never one pass's work.
    expect(validQuotaResetClusterEntries([["era", [[BASE, BASE], [BASE + 1, BASE + 1]]]])).toBe(false);
    expect(validQuotaResetClusterEntries([["era", [[BASE, BASE]]], ["era", [[BASE, BASE]]]])).toBe(false);
    expect(validQuotaResetClusterEntries([["era", [[BASE, Number.NaN]]]])).toBe(false);
    expect(validQuotaResetClusterEntries(quotaResetClusterEntries(state), 1)).toBe(false);
  });
});

describe("quota reset hull merging", () => {
  // The fold's whole claim: a window's pools can be settled from per-day hull
  // sets instead of from every raw instant. Seeded so a failure is replayable.
  const seeded = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const direct = (group: string, instants: readonly number[]) => {
    const state = createQuotaResetClusterState();
    for (const instant of instants) expect(addQuotaReset(state, group, instant)).toBe(true);
    return quotaResetClusterEntries(state);
  };
  const folded = (group: string, partition: ReadonlyArray<readonly number[]>) => {
    const state = createQuotaResetClusterState();
    for (const part of partition) {
      expect(mergeQuotaResetHulls(state, direct(group, part))).toBe(true);
    }
    return quotaResetClusterEntries(state);
  };

  it("merges two hull sets to the fixpoint of the linkage rule", () => {
    // Exactly the tolerance still joins two hulls; one millisecond beyond does
    // not; and a third hull bridging a gap collapses all three at once.
    const state = createQuotaResetClusterState([["era", [[BASE, BASE + MINUTE]]]]);
    expect(mergeQuotaResetHulls(state, [["era", [[BASE + MINUTE + QUOTA_RESET_CLUSTER_TOLERANCE_MS,
      BASE + 2 * HOUR + QUOTA_RESET_CLUSTER_TOLERANCE_MS]]]])).toBe(true);
    expect(quotaResetClusterEntries(state))
      .toEqual([["era", [[BASE, BASE + 2 * HOUR + QUOTA_RESET_CLUSTER_TOLERANCE_MS]]]]);
    expect(state.count).toBe(1);

    const apart = createQuotaResetClusterState([["era", [[BASE, BASE]]]]);
    expect(mergeQuotaResetHulls(apart, [["era", [[BASE + QUOTA_RESET_CLUSTER_TOLERANCE_MS + 1,
      BASE + QUOTA_RESET_CLUSTER_TOLERANCE_MS + 1]]]])).toBe(true);
    expect(apart.count).toBe(2);
    expect(mergeQuotaResetHulls(apart, [["era", [[BASE + 60_000, BASE + 90_000]]]])).toBe(true);
    expect(quotaResetClusterEntries(apart))
      .toEqual([["era", [[BASE, BASE + QUOTA_RESET_CLUSTER_TOLERANCE_MS + 1]]]]);
    expect(apart.count).toBe(1);
  });

  it("keeps groups independent and leaves an untouched group alone", () => {
    const state = createQuotaResetClusterState([["a", [[BASE, BASE]]], ["b", [[BASE, BASE]]]]);
    expect(mergeQuotaResetHulls(state, [["a", [[BASE + 10 * HOUR, BASE + 10 * HOUR]]], ["c", []]])).toBe(true);
    expect(quotaResetClusterEntries(state)).toEqual([
      ["a", [[BASE, BASE], [BASE + 10 * HOUR, BASE + 10 * HOUR]]], ["b", [[BASE, BASE]]]]);
    expect(state.count).toBe(3);
  });

  it("settles the same partition as direct insertion under any day partition", () => {
    // 120 seeds x a random partition into up to eight days. Each day's hulls
    // are built by direct insertion, then merged in day order; the result must
    // be the canonical partition of the whole instant set.
    for (let seed = 1; seed <= 120; seed += 1) {
      const random = seeded(seed);
      const instants: number[] = [];
      let cursor = BASE;
      for (let index = 0; index < 40; index += 1) {
        // Gaps straddle the tolerance so hulls both chain and separate.
        cursor += Math.floor(random() * 2 * QUOTA_RESET_CLUSTER_TOLERANCE_MS) - MINUTE;
        instants.push(cursor);
      }
      const days = 1 + Math.floor(random() * 8);
      const partition: number[][] = Array.from({ length: days }, () => []);
      // A day partition is contiguous in observation time but a pool's
      // instants can land in any of them, which is the case that matters.
      for (const instant of instants) partition[Math.floor(random() * days)]!.push(instant);
      const expected = direct("era", instants);
      expect(folded("era", partition), `seed ${seed}`).toEqual(expected);
      expect(folded("era", [...partition].reverse()), `seed ${seed} reversed`).toEqual(expected);
    }
  });

  it("refuses on the settled count and commits nothing when it does", () => {
    const state = createQuotaResetClusterState([["era", [[BASE, BASE]]]]);
    const distant = BASE + 10 * HOUR;
    expect(mergeQuotaResetHulls(state, [["era", [[distant, distant], [distant + 20 * HOUR, distant + 20 * HOUR]]]], 2))
      .toBe(false);
    // Nothing was committed, so the refusal can be reported against the state
    // that produced it rather than against a half-merged one.
    expect(quotaResetClusterEntries(state)).toEqual([["era", [[BASE, BASE]]]]);
    expect(state.count).toBe(1);
    // A merge that settles back inside the bound is admitted: two incoming
    // hulls that chain through the existing one are one pool, not three.
    expect(mergeQuotaResetHulls(state, [["era", [[BASE + HOUR, BASE + HOUR], [BASE + 2 * HOUR, BASE + 2 * HOUR]]]], 2))
      .toBe(true);
    expect(state.count).toBe(1);
  });

  it("matches direct insertion at the bound and one instant past it", () => {
    // The fixture the plan asks for: a corpus whose settled pool count is
    // exactly the limit, and the same corpus one pool wider.
    const limit = 4;
    const atBound = Array.from({ length: limit }, (_, index) => BASE + index * 10 * HOUR);
    const pastBound = [...atBound, BASE + limit * 10 * HOUR];
    const state = createQuotaResetClusterState();
    for (const instant of atBound) expect(addQuotaReset(state, "era", instant, limit)).toBe(true);
    const foldedAtBound = createQuotaResetClusterState();
    expect(mergeQuotaResetHulls(foldedAtBound, direct("era", atBound), limit)).toBe(true);
    expect(quotaResetClusterEntries(foldedAtBound)).toEqual(quotaResetClusterEntries(state));
    expect(addQuotaReset(state, "era", pastBound.at(-1)!, limit)).toBe(false);
    expect(mergeQuotaResetHulls(createQuotaResetClusterState(), direct("era", pastBound), limit)).toBe(false);
  });

  it("is one-sided: a merge only refuses where direct insertion also refused", () => {
    // A hull count grows by at most one per inserted instant, so any settled
    // count above the bound was reached by the direct order too. The converse
    // fails, and this is the exact shape of that known inexactness: a
    // transient peak inside one day that the day's own hull set no longer
    // shows. Recorded so the divergence is a stated property, not a surprise.
    const limit = 2;
    const transient = [BASE, BASE + 5 * HOUR, BASE + 2.5 * HOUR];
    const direct2 = createQuotaResetClusterState();
    expect(addQuotaReset(direct2, "era", transient[0]!, limit)).toBe(true);
    expect(addQuotaReset(direct2, "era", transient[1]!, limit)).toBe(true);
    // The bridging instant would settle back to one pool, but the direct path
    // never gets there: it refuses the third instant on the intermediate count
    // only when the bound is already reached. Here it merges, so it survives.
    expect(addQuotaReset(direct2, "era", transient[2]!, limit)).toBe(true);
    expect(direct2.count).toBe(1);
    // With a bound of one, the direct path refuses at the second instant while
    // the day's settled hull set is a single pool the merge admits.
    const narrow = createQuotaResetClusterState();
    expect(addQuotaReset(narrow, "era", transient[0]!, 1)).toBe(true);
    expect(addQuotaReset(narrow, "era", transient[1]!, 1)).toBe(false);
    const merged = createQuotaResetClusterState();
    expect(mergeQuotaResetHulls(merged, [["era", [[BASE, BASE + 5 * HOUR]]]], 1)).toBe(true);
    expect(merged.count).toBe(1);
  });
});

describe("quota endpoint collapse", () => {
  it("returns an already sparse owner unchanged", () => {
    // Every change is further apart than the spacing, so the collapse is the
    // run collapse alone and the retained rows are byte-identical.
    const rows = Array.from({ length: 12 }, (_, index) => row(index + 1, index * 15, 10 + index * 5));
    expect(collapse(rows)).toEqual(rows);
  });

  it("keeps each run's first and last row and the key's final endpoint", () => {
    const rows = [row(1, 0, 10), row(2, 20, 10), row(3, 40, 10), row(4, 60, 20), row(5, 80, 20)];
    // Intermediate rows of a flat run carry nothing the first and last do not.
    expect(collapse(rows).map((value) => value.id)).toEqual([1, 3, 4, 5]);
  });

  it("thins a dense non-monotone burst but keeps its span exactly", () => {
    // Eight distinct values establish the boundaries fitability admitted the
    // pool on, then forty minutes of values already seen, then a new low and a
    // new high. The thinned result must still carry the raw span, because the
    // calibration measures the span the eligibility decision was made on.
    const values = [
      ...Array.from({ length: QUOTA_ENDPOINT_MINIMUM_RETAINED }, (_, index) => 10 + index * 2),
      ...Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? 15 : 17)),
      5, 17, 95, 15, 17,
    ];
    const rows = values.map((usedPercent, index) => row(index + 1, index, usedPercent));
    const kept = collapse(rows);
    const span = (list: readonly Row[]) => Math.max(...list.map((value) => value.usedPercent))
      - Math.min(...list.map((value) => value.usedPercent));
    expect(span(kept)).toBe(span(rows));
    expect(kept.map((value) => value.usedPercent)).toContain(5);
    expect(kept.map((value) => value.usedPercent)).toContain(95);
    // The first boundaries and the key's final endpoint are exact; the forty
    // repeated minutes between them collapse to the spacing.
    expect(kept.slice(0, QUOTA_ENDPOINT_MINIMUM_RETAINED).map((value) => value.id))
      .toEqual(Array.from({ length: QUOTA_ENDPOINT_MINIMUM_RETAINED }, (_, index) => index + 1));
    expect(kept.at(-1)!.id).toBe(rows.at(-1)!.id);
    expect(kept.length).toBeLessThan(rows.length / 2);
  });

  it("thins a dense strictly rising key and still keeps both its extremes", () => {
    // Holding the current extremes rather than emitting every new one is what
    // keeps a quota that only rises thinned at all: every run boundary of a
    // monotone key is a new high.
    const rows = Array.from({ length: 30 }, (_, index) => row(index + 1, index, 10 + index));
    const kept = collapse(rows);
    expect(kept.length).toBeLessThan(rows.length);
    expect(kept.at(-1)).toEqual(rows.at(-1));
    const percents = (list: readonly Row[]) => list.map((value) => value.usedPercent);
    expect(Math.max(...percents(kept))).toBe(Math.max(...percents(rows)));
    expect(Math.min(...percents(kept))).toBe(Math.min(...percents(rows)));
  });

  it("spaces each key independently and never merges two keys", () => {
    const rows: Row[] = [];
    for (let index = 0; index < 24; index += 1) {
      rows.push(row(index * 2 + 1, index, 10 + index, "five_hour"));
      rows.push(row(index * 2 + 2, index, 10 + index, "seven_day"));
    }
    const kept = collapse(rows);
    const byKey = (key: string) => kept.filter((value) => value.key === key).map((value) => value.id);
    expect(byKey("five_hour")).toHaveLength(byKey("seven_day").length);
    expect(byKey("five_hour").every((id) => id % 2 === 1)).toBe(true);
    expect(byKey("seven_day").every((id) => id % 2 === 0)).toBe(true);
  });
});

describe("quota fragment eligibility", () => {
  it("admits a group only on enough distinct displayed values and enough span", () => {
    const stats = new Map<string, QuotaFragmentStats>();
    const boundaries = QUOTA_CALIBRATION_POLICY.minimumBoundaries;
    for (let index = 0; index < boundaries; index += 1) addQuotaFragmentValue(stats, "wide", 10 + index * 5);
    for (let index = 0; index < boundaries; index += 1) addQuotaFragmentValue(stats, "narrow", 10 + index * 0.1);
    for (let index = 0; index < boundaries - 1; index += 1) addQuotaFragmentValue(stats, "short", 10 + index * 5);
    expect(quotaFragmentEligible(stats.get("wide")!)).toBe(true);
    expect(quotaFragmentEligible(stats.get("narrow")!)).toBe(false);
    expect(quotaFragmentEligible(stats.get("short")!)).toBe(false);
    // Repeated values never buy a boundary, and the cap never hides the span.
    for (let index = 0; index < 50; index += 1) addQuotaFragmentValue(stats, "short", 10);
    expect(quotaFragmentEligible(stats.get("short")!)).toBe(false);
    expect(stats.get("wide")!.values).toHaveLength(boundaries);
    expect(stats.get("wide")!.maximum - stats.get("wide")!.minimum)
      .toBeGreaterThanOrEqual(QUOTA_CALIBRATION_POLICY.minimumDisplayedSpanPp);
  });
});

describe("cluster-scoped spacing for a reset-major stream", () => {
  // The v1 reader delivers a pool's rows as one monotone block per restated
  // instant, so the observation clock jumps backwards between blocks. These
  // build the same candidate set in both orders.
  interface Candidate { id: number; observedAtMs: number; usedPercent: number; block: string }
  const view = (value: Candidate) => ({ id: value.id, observedAtMs: value.observedAtMs,
    usedPercent: value.usedPercent });
  function candidates(): Candidate[] {
    const rows: Candidate[] = [];
    let id = 0;
    for (let minute = 0; minute < 90; minute += 1) {
      // Three restated instants of one pool, interleaved in time.
      rows.push({ id: (id += 1), observedAtMs: BASE + minute * MINUTE,
        usedPercent: 10 + (minute % 17), block: `reset-${minute % 3}` });
    }
    return rows;
  }
  const spaced = (rows: readonly Candidate[]) => {
    const state = createQuotaClusterSpacing<Candidate>();
    const kept: Candidate[] = [];
    const emit = (value: Candidate) => { kept.push(value); return true; };
    for (const row of rows) offerQuotaClusterEndpoint(state, row, view, emit);
    closeQuotaClusterSpacing(state, view, emit);
    return kept.sort((left, right) => left.observedAtMs - right.observedAtMs);
  };
  const resetMajor = (rows: readonly Candidate[]) => [...rows]
    .sort((left, right) => (left.block < right.block ? -1 : left.block > right.block ? 1 : 0)
      || left.observedAtMs - right.observedAtMs);

  // The greedy rule picks different rows in the two orders — that is expected,
  // and the reader's order is fixed — but the guarantees the calibration relies
  // on hold either way, which is what makes the rule safe for a reset-major
  // stream in the first place.
  it("keeps the same guarantees whichever order the blocks arrive in", () => {
    const rows = candidates();
    for (const [name, ordered] of [["time order", rows], ["reset-major order", resetMajor(rows)]] as const) {
      const kept = spaced(ordered);
      const times = kept.map((value) => value.observedAtMs);
      const percents = kept.map((value) => value.usedPercent);
      // The pool's window and displayed span are exact in both orders.
      expect(times[0], name).toBe(Math.min(...rows.map((value) => value.observedAtMs)));
      expect(times.at(-1), name).toBe(Math.max(...rows.map((value) => value.observedAtMs)));
      expect(Math.min(...percents), name).toBe(Math.min(...rows.map((value) => value.usedPercent)));
      expect(Math.max(...percents), name).toBe(Math.max(...rows.map((value) => value.usedPercent)));
      // The rule admits at most the calibration boundaries, one row per
      // spacing slot across the window, and the four rows it holds to keep the
      // window and span exact. Both orders land on the same count.
      const window = times.at(-1)! - times[0]!;
      expect(kept.length, name).toBeLessThanOrEqual(QUOTA_ENDPOINT_MINIMUM_RETAINED
        + Math.ceil(window / QUOTA_ENDPOINT_MIN_SPACING_MS) + 4);
      expect(kept.length, name).toBeLessThan(rows.length);
    }
  });

  it("returns an already sparse pool unchanged in either order", () => {
    // Every candidate is further apart than the spacing, so nothing is thinned
    // and the retained set is byte-identical to the input.
    const rows: Candidate[] = Array.from({ length: 10 }, (_, index) => ({ id: index + 1,
      observedAtMs: BASE + index * 15 * MINUTE, usedPercent: 10 + index * 5, block: `reset-${index % 3}` }));
    expect(spaced(rows)).toEqual(rows);
    expect(spaced(resetMajor(rows))).toEqual(rows);
  });
});
