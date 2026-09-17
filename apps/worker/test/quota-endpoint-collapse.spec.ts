import { describe, expect, it } from "vitest";
import { QUOTA_CALIBRATION_POLICY } from "@app-usagemonitor/quota-analysis";
import {
  addQuotaFragmentValue,
  addQuotaReset,
  collapseQuotaEndpointStream,
  createQuotaResetClusterState,
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

  it("thins dense changes to the spacing once the key holds its boundaries", () => {
    // One change a minute. The first `minimumBoundaries` distinct displayed
    // values are kept exactly, because fitability admitted the pool on them;
    // after that only the spacing and the final endpoint survive.
    const rows = Array.from({ length: 60 }, (_, index) => row(index + 1, index, 10 + index));
    const kept = collapse(rows).map((value) => value.id);
    expect(kept.slice(0, QUOTA_ENDPOINT_MINIMUM_RETAINED))
      .toEqual(Array.from({ length: QUOTA_ENDPOINT_MINIMUM_RETAINED }, (_, index) => index + 1));
    expect(kept).toContain(rows.at(-1)!.id);
    expect(kept.length).toBeLessThan(rows.length);
    const times = kept.map((id) => rows[id - 1]!.observedAtMs);
    for (let index = QUOTA_ENDPOINT_MINIMUM_RETAINED; index < times.length - 1; index += 1) {
      expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(QUOTA_ENDPOINT_MIN_SPACING_MS);
    }
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
