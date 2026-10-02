// Unit checks for the owner-level parity compare. Synthetic, content-free
// inputs only; no database, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANALYTICS_V2_OWNER_PARITY_FAMILIES,
  compareAnalyticsV2OwnerParity,
} from "./analytics-v2-owner-parity-compare.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);
const COUNTERS = { adjacencies: 2, reusedMoreThanHalf: 1, matchedOrExceeded: 1, unorderedTies: 0,
  excludedInsufficientEvidence: 0, excludedContextContracted: 0, sessions: 1 };
const fits = [{ capacityNanousd: 12.5, lastObservedAt: "2026-09-29T15:00:00.000Z", participantId: A, planType: "pro" }];
const composition = { status: "ready", fit: { capacityUsdByModel: { m: 1.25 } }, planType: "pro" };
const values = (day) => ({ day, counts: { usage: 3, quota: 1, session: 1 }, cells: [], schemaVersion: "v" });

function fixture() {
  const ownerResults = {
    schemaVersion: "gcp-fastpath-dense-owner-results-v1",
    today: "2026-10-01",
    modelDates: ["2026-09-30", "2026-10-01"],
    owners: {
      a: {
        ownerDigest: A,
        fits: { direct: { sha256: "x", fits } },
        model: {
          "2026-09-30": { direct: { state: "failed", reason: "STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE" } },
          "2026-10-01": { direct: { sha256: "y", result: { ...composition, inputFingerprint: "run-specific" } } },
        },
        daily: { "2026-10-01": { sourceFormat: "effective", complete: 1, values: values("2026-10-01") } },
      },
      b: {
        ownerDigest: B,
        fits: { direct: { sha256: "z", fits: [] } },
        model: {
          "2026-09-30": { direct: { sha256: "y", result: composition } },
          "2026-10-01": { direct: { sha256: "y", result: composition } },
        },
        daily: {},
      },
    },
  };
  const band = (band) => ({ layout: "effective", method: "cache-retention-v2", model: "m", effort: "high", band, ...COUNTERS });
  const cacheReference = {
    schemaVersion: "gcp-fastpath-dense-cache-reference-v1",
    days: { "a:2026-09-30": { state: "refused", reason: "usage_row_refused" }, "a:2026-10-01": { state: "built" } },
    ownerDays: { "a:2026-10-01": [band("under_one_minute"), band("one_to_two_minutes")] },
  };
  const storedBand = (bandName) => ({ ownerDigest: A, day: "2026-10-01", model: "m", effort: "high", band: bandName,
    ...COUNTERS, runId: "r" });
  const rows = {
    runId: "r",
    fits: [{ ownerDigest: A, asOfDay: "2026-10-01", fits, runId: "r" },
      { ownerDigest: B, asOfDay: "2026-10-01", fits: [], runId: "r" }],
    modelDates: [{ ownerDigest: A, day: "2026-10-01", result: composition, runId: "r" },
      { ownerDigest: B, day: "2026-09-30", result: composition, runId: "r" },
      { ownerDigest: B, day: "2026-10-01", result: composition, runId: "r" }],
    ownerDays: [{ ownerDigest: A, day: "2026-09-29", daily: null, refusal: "source_conflict_or_order", runId: "r" },
      { ownerDigest: A, day: "2026-10-01", daily: values("2026-10-01"), refusal: null, runId: "r" },
      { ownerDigest: B, day: "2026-09-29", daily: values("2026-09-29"), refusal: null, runId: "r" }],
    // Stored in the opposite band order: the compare sorts both sides.
    cacheBands: [storedBand("under_one_minute"), storedBand("one_to_two_minutes")],
    refusals: [
      { ownerDigest: A, day: "2026-09-29", family: "daily", reason: "source_conflict_or_order" },
      { ownerDigest: A, day: "2026-09-30", family: "model", reason: "incomplete_window" },
      { ownerDigest: A, day: "2026-09-30", family: "cache", reason: "incomplete_cache_day" },
    ],
  };
  return { ownerResults, cacheReference, conflict: { owner: "a", days: ["2026-09-29"] }, rows };
}

const families = (report) => Object.fromEntries(report.families.map((entry) => [entry.family, entry]));

test("stored outputs equal to the references pass every family; only inputFingerprint is dropped", () => {
  const report = compareAnalyticsV2OwnerParity(fixture());
  assert.deepEqual(report.families.map((entry) => entry.family), [...ANALYTICS_V2_OWNER_PARITY_FAMILIES]);
  assert.equal(report.unexpectedDiffs, 0, JSON.stringify(report.families));
  const byName = families(report);
  assert.deepEqual([byName["owner-fits"].equal, byName["owner-model-dates"].equal, byName["owner-days"].equal,
    byName["owner-cache-days"].equal, byName.refusals.equal], [2, 4, 1, 2, 3]);
  assert.deepEqual(report.unreferencedOwnerDays, ["a:2026-09-29", "b:2026-09-29"]);
  assert.deepEqual(report.normalized, ["owner-model-dates: reference inputFingerprint"]);
});

test("a changed number anywhere in a fit, a model date, a daily value or a band counter fails", () => {
  const mutations = [
    ["owner-fits", (input) => { input.rows.fits[0].fits = [{ ...fits[0], capacityNanousd: 12.500001 }]; }],
    ["owner-model-dates", (input) => { input.rows.modelDates[1].result = { ...composition, planType: "plus" }; }],
    ["owner-days", (input) => { input.rows.ownerDays[1].daily = { ...values("2026-10-01"), counts: { usage: 4, quota: 1, session: 1 } }; }],
    ["owner-cache-days", (input) => { input.rows.cacheBands[0] = { ...input.rows.cacheBands[0], sessions: 2 }; }],
  ];
  for (const [name, mutate] of mutations) {
    const input = fixture();
    mutate(input);
    const report = compareAnalyticsV2OwnerParity(input);
    assert.deepEqual(report.unexpectedFamilies, [name], name);
  }
});

test("the stored inputFingerprint is not dropped: a stored fingerprint differs from the reference", () => {
  const input = fixture();
  input.rows.modelDates[0].result = { ...composition, inputFingerprint: "run-specific" };
  assert.deepEqual(compareAnalyticsV2OwnerParity(input).unexpectedFamilies, ["owner-model-dates"]);
});

test("a missing, extra or refused result where production computed fails", () => {
  const missingModel = fixture();
  missingModel.rows.modelDates.shift();
  assert.deepEqual(compareAnalyticsV2OwnerParity(missingModel).unexpectedFamilies, ["owner-model-dates"]);
  const resultOnFailure = fixture();
  resultOnFailure.rows.modelDates.push({ ownerDigest: A, day: "2026-09-30", result: composition, runId: "r" });
  assert.deepEqual(compareAnalyticsV2OwnerParity(resultOnFailure).unexpectedFamilies, ["owner-model-dates"]);
  const missingFits = fixture();
  missingFits.rows.fits.pop();
  assert.deepEqual(compareAnalyticsV2OwnerParity(missingFits).unexpectedFamilies, ["owner-fits"]);
  const refusedDay = fixture();
  refusedDay.rows.ownerDays[1] = { ...refusedDay.rows.ownerDays[1], daily: null, refusal: "day_row_limit" };
  assert.deepEqual(compareAnalyticsV2OwnerParity(refusedDay).unexpectedFamilies, ["owner-days"]);
  const bandsOnRefusedDay = fixture();
  bandsOnRefusedDay.rows.cacheBands.push({ ...bandsOnRefusedDay.rows.cacheBands[0], day: "2026-09-30" });
  assert.deepEqual(compareAnalyticsV2OwnerParity(bandsOnRefusedDay).unexpectedFamilies, ["owner-cache-days"]);
  const unreferencedDay = fixture();
  unreferencedDay.rows.ownerDays.push({ ownerDigest: B, day: "2026-09-28", daily: values("2026-09-28"), refusal: null, runId: "r" });
  assert.deepEqual(compareAnalyticsV2OwnerParity(unreferencedDay).unexpectedFamilies, ["owner-days"]);
  const stranger = fixture();
  stranger.rows.fits.push({ ownerDigest: "c".repeat(64), asOfDay: "2026-10-01", fits: [], runId: "r" });
  assert.deepEqual(compareAnalyticsV2OwnerParity(stranger).unexpectedFamilies, ["owner-fits"]);
});

test("refusals must be exactly the reference failures, with closed reasons", () => {
  const extra = fixture();
  extra.rows.refusals.push({ ownerDigest: B, day: null, family: "owner", reason: "memory_budget" });
  assert.deepEqual(compareAnalyticsV2OwnerParity(extra).unexpectedFamilies, ["refusals"]);
  const missing = fixture();
  missing.rows.refusals.pop();
  assert.deepEqual(compareAnalyticsV2OwnerParity(missing).unexpectedFamilies, ["refusals"]);
  const openReason = fixture();
  openReason.rows.refusals[1] = { ...openReason.rows.refusals[1], reason: "usage_window_unrepresentable" };
  assert.deepEqual(compareAnalyticsV2OwnerParity(openReason).unexpectedFamilies, ["refusals"]);
});

test("malformed references and rows fail closed", () => {
  const badVersion = fixture();
  badVersion.ownerResults.schemaVersion = "other";
  assert.throws(() => compareAnalyticsV2OwnerParity(badVersion), /OWNER_PARITY_INPUT_INVALID:ownerResults/u);
  const badLayout = fixture();
  badLayout.cacheReference.ownerDays["a:2026-10-01"][0].layout = "typed-v11";
  assert.throws(() => compareAnalyticsV2OwnerParity(badLayout), /OWNER_PARITY_INPUT_INVALID:cacheReference/u);
  const badRows = fixture();
  delete badRows.rows.refusals;
  assert.throws(() => compareAnalyticsV2OwnerParity(badRows), /OWNER_PARITY_INPUT_INVALID:rows.refusals/u);
  const incomplete = fixture();
  incomplete.ownerResults.owners.a.daily["2026-10-01"].complete = 0;
  assert.throws(() => compareAnalyticsV2OwnerParity(incomplete), /OWNER_PARITY_INPUT_INVALID:ownerResults.daily/u);
});
