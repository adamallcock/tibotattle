// Deterministic, content-free generator for the GCP fast-path PRODUCTION-SHAPED
// synthetic corpus (MEAS-SYNTH).
//
// The dense corpus (../gcp-fastpath-dense-oracle/dense-corpus.mjs) is ONE dense
// owner; the full-recompute engine's "about 50 minutes" comes from it alone.
// This corpus reproduces the shape of the production roster instead, from the
// content-free OWN-3 counts of 2026-10-02 (CUTOVER-CHECKLIST.md, OWN-3;
// receipts/command-pack-step1.txt in the parity home):
//
//   - 54 eligible owners by source routing: 33 v1.1-only, 16 v1-only,
//     3 v1.2-only, 1 mixed v1.1+v1.2 and 1 with no effective evidence;
//   - 35 owners with usage rows in the 101-day window (here 2026-06-23 to
//     2026-10-01, the 101 days ending on the corpus day): 17 over 30,000,
//     10 (largest single format) to 11 (sum of formats) over 60,000, 7 over
//     120,000, 3 over 240,000, 1 over 600,000, the largest exactly 791,806;
//   - the largest owner holds about 2.52 million records over all history
//     (C-REFRESH receipt): here 791,806 window usage rows plus 1.69 times as
//     many before the window, with quota and session records, about
//     2.5 million records;
//   - the correction runtime is active (the oracle's shared corpus fixture
//     seeds it active, as production is).
//
// The per-owner window counts, the routing of each owner, the history before
// the window and the plan types are a stated, deterministic ASSUMPTION that
// satisfies every OWN-3 threshold; production's own per-owner split is not
// known and is never read. PROD_SHAPE_ROSTER is that assumption.
//
// Day spread: each owner's rows are allocated over its days with weekday and
// weekend weights, a growth trend, log-normal day noise, occasional burst
// days and an activity probability that leaves light owners idle on most
// days. Every owner-day's usage count is exactly its planned count, so the
// window totals are exact. Sessions follow the dense generator's construction
// (short and long request gaps across every cache-retention band, sessions
// crossing midnight, sessions resumed one to six days later), and quota
// observations follow it too (one per about 12 usage events with its
// five-hour twin, plus one a minute after each weekly reset), with each
// owner's capacity scaled so its busiest weekly window peaks at a fixed
// per-owner percentage.
//
// Synthetic and content-free: identifiers are hash-derived; there are no
// paths, prompts, commands, accounts or emails. The generator is pure: it does
// no I/O and takes the pricer it needs (production's priceTelemetryUsageEvent)
// as an argument. Every owner-day is regenerated from its own PRNG streams, so
// days stream one at a time and an owner never has to be held in memory.

import { createHash } from "node:crypto";

export const PROD_SHAPE_CORPUS_SCHEMA_VERSION = "gcp-fastpath-prod-shape-corpus-v1";
export const PROD_SHAPE_SEED = "gcp-fastpath-prod-shape-2026-10-02";
export const PROD_SHAPE_THROUGH_DAY = "2026-10-01";
/** The dense corpus's pinned analysis instant and refresh clock, so receipts compare. */
export const PROD_SHAPE_PINNED_NOW = "2026-10-01T12:00:00.000Z";
export const PROD_SHAPE_REFRESH_NOW = "2026-10-01T12:46:00.000Z";
/** OWN-3's 101-day window, ending on the corpus day. */
export const PROD_SHAPE_WINDOW = Object.freeze({ fromDay: "2026-06-23", throughDay: PROD_SHAPE_THROUGH_DAY, days: 101 });
/** The refresh's 170 analysis days (the dense and Q-1 corpora's window). */
export const PROD_SHAPE_ANALYSIS_FROM_DAY = "2026-04-15";
/** The mixed owner's first v1.2 day; its earlier days are v1.1. */
export const PROD_SHAPE_MIXED_SWITCH_DAY = "2026-09-01";
/** Production v1.2 admission allows 64 MB of canonical records per day; stay well inside it. */
export const PROD_SHAPE_MAX_DAY_USAGE = 45_000;

/** OWN-3 (2026-10-02), the distribution the corpus must reproduce at scale 1. */
export const OWN3_COUNTS = Object.freeze({
  eligibleOwners: 54,
  routing: Object.freeze({ "v1.1": 33, v1: 16, "v1.2": 3, mixed: 1, none: 1 }),
  windowOwners: 35,
  /** threshold: [owners over it by largest single format, owners over it by sum of formats] */
  windowOver: Object.freeze({ 30_000: [17, 17], 60_000: [10, 11], 120_000: [7, 7], 240_000: [3, 3], 600_000: [1, 1],
    1_200_000: [0, 0] }),
  maxWindowRows: 791_806,
  largestOwnerAllHistoryRecords: 2_520_000,
  correctionRuntime: "active",
});

const DAY_MS = 86_400_000, MINUTE = 60_000, SECOND = 1_000, HOUR = 3_600_000;
const FIVE_HOURS = 5 * HOUR;
const MODELS = Object.freeze(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"]);
const EFFORTS = Object.freeze(["low", "medium", "high"]);
/** Q-1's base weekly capacity per model, USD of API-price-equivalent spend per 100% of a window. */
const BASE_CAPACITY = Object.freeze({ "gpt-5.6-sol": 900, "gpt-5.6-terra": 420, "gpt-5.5": 700 });
const SHORT_GAPS_SECONDS = Object.freeze([3, 5, 8, 12, 18, 25, 35, 45, 60, 90]);
// Pauses between consecutive requests span every cache-retention band (Q-1's set).
const LONG_GAPS_MINUTES = Object.freeze([0.5, 1, 2, 3, 4, 6, 9, 14, 22, 35, 50, 70]);

const hex = (...parts) => createHash("sha256").update([PROD_SHAPE_SEED, ...parts].join("\u0000")).digest("hex");
const uuid = (...parts) => {
  const h = hex("uuid", ...parts);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
/** mulberry32 over a hash-derived state (Q-1's and the dense corpus's construction). */
function prng(label) {
  let state = parseInt(hex("prng", label).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function draws(label) {
  const random = prng(label);
  return {
    random,
    int: (lo, hi) => lo + Math.floor(random() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(random() * list.length)],
    /** A standard normal draw (Box-Muller). */
    normal: () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random()),
  };
}
const iso = (ms) => new Date(ms).toISOString();
const dayStartMs = (day) => Date.parse(`${day}T00:00:00.000Z`);
const dayOf = (ms) => iso(ms).slice(0, 10);
const addDays = (day, n) => dayOf(dayStartMs(day) + n * DAY_MS);
export function dayRange(from, through) {
  const out = [];
  for (let at = dayStartMs(from); at <= dayStartMs(through); at += DAY_MS) out.push(dayOf(at));
  return out;
}
const LAST_DAY = PROD_SHAPE_THROUGH_DAY;
const PRE_WINDOW_LAST_DAY = addDays(PROD_SHAPE_WINDOW.fromDay, -1);

// ----------------------------------------------------------------- roster --
//
// [key, routing, kind, planType, window usage rows, pre-window ratio, first day]
// for the 35 owners active in the window; [key, routing, kind, planType,
// pre-window usage rows, first day, last day] for the 19 that are not. The
// pre-window ratio is the owner's usage before the window over its window
// usage. Routing: v1.1 (accountless or social), v1 (social, legacy chunks),
// v1.2 (social), mixed (social, v1.1 then v1.2 from PROD_SHAPE_MIXED_SWITCH_DAY)
// and none (a social participant with a paired device and no evidence: every
// active social participant is an eligible public source owner, d43c8f92
// community_public_source_owners).

const ACTIVE = Object.freeze([
  ["o01", "v1.1", "social", "pro", 791_806, 1.69, "2025-06-01"],
  ["o02", "v1.2", "social", "pro", 430_000, 1.10, "2025-08-01"],
  ["o03", "v1.1", "accountless", "pro", 285_000, 1.40, "2025-07-01"],
  ["o04", "v1.1", "social", "pro", 215_000, 0.90, "2025-09-15"],
  ["o05", "v1.1", "accountless", "pro", 180_000, 1.20, "2025-08-15"],
  ["o06", "v1.1", "accountless", "prolite", 150_000, 1.00, "2025-10-01"],
  ["o07", "v1", "social", "pro", 128_000, 1.50, "2025-07-15"],
  ["o08", "v1.1", "social", "prolite", 105_000, 0.80, "2025-11-01"],
  ["o09", "v1.1", "accountless", "pro", 88_000, 1.10, "2025-09-01"],
  ["o10", "v1.1", "accountless", "plus", 72_000, 0.60, "2026-01-10"],
  ["o11", "mixed", "social", "pro", 65_000, 1.00, "2025-10-15"],
  ["o12", "v1", "social", "prolite", 56_000, 0.90, "2025-11-15"],
  ["o13", "v1.1", "accountless", "plus", 50_000, 0.50, "2026-02-01"],
  ["o14", "v1.1", "social", "pro", 44_000, 1.30, "2025-08-01"],
  ["o15", "v1.1", "accountless", "plus", 39_000, 0.70, "2025-12-15"],
  ["o16", "v1.1", "accountless", "prolite", 35_000, 0.40, "2026-03-01"],
  ["o17", "v1.2", "social", "plus", 31_500, 0.30, "2026-03-20"],
  ["o18", "v1.1", "accountless", "plus", 26_000, 0.90, "2025-12-01"],
  ["o19", "v1.1", "accountless", "plus", 21_000, 0.60, "2026-01-20"],
  ["o20", "v1.1", "social", "prolite", 17_000, 1.20, "2025-10-01"],
  ["o21", "v1", "social", "plus", 13_500, 0.80, "2025-11-01"],
  ["o22", "v1.1", "accountless", "plus", 10_500, 0.50, "2026-02-15"],
  ["o23", "v1.1", "accountless", "plus", 8_200, 0.70, "2026-01-01"],
  ["o24", "v1", "social", "plus", 6_300, 1.00, "2025-12-01"],
  ["o25", "v1.1", "accountless", "plus", 4_800, 0.40, "2026-03-15"],
  ["o26", "v1.1", "accountless", "plus", 3_600, 0.30, "2026-04-10"],
  ["o27", "v1.2", "social", "plus", 2_700, 0.20, "2026-05-01"],
  ["o28", "v1.1", "accountless", "plus", 2_000, 0.50, "2026-03-01"],
  ["o29", "v1", "social", "plus", 1_450, 0.60, "2026-02-01"],
  ["o30", "v1.1", "accountless", "plus", 1_050, 0.30, "2026-04-20"],
  ["o31", "v1.1", "accountless", "plus", 750, 0.40, "2026-04-01"],
  ["o32", "v1.1", "accountless", "plus", 520, 0.20, "2026-05-10"],
  ["o33", "v1", "social", "plus", 360, 0.50, "2026-03-20"],
  ["o34", "v1.1", "accountless", "plus", 240, 0.10, "2026-06-01"],
  ["o35", "v1.1", "accountless", "plus", 150, 0, "2026-06-23"],
]);
const INACTIVE = Object.freeze([
  ["o36", "v1", "social", "pro", 150_000, "2025-06-15", "2026-06-15"],
  ["o37", "v1.1", "accountless", "pro", 90_000, "2025-09-01", "2026-06-10"],
  ["o38", "v1", "social", "prolite", 60_000, "2025-08-01", "2026-05-31"],
  ["o39", "v1.1", "accountless", "prolite", 42_000, "2025-11-01", "2026-05-20"],
  ["o40", "v1", "social", "plus", 30_000, "2025-10-01", "2026-04-10"],
  ["o41", "v1.1", "social", "plus", 21_000, "2026-01-15", "2026-06-18"],
  ["o42", "v1", "social", "plus", 15_000, "2025-11-15", "2026-06-12"],
  ["o43", "v1.1", "accountless", "plus", 11_000, "2026-02-01", "2026-04-30"],
  ["o44", "v1", "social", "plus", 8_000, "2025-12-01", "2026-03-31"],
  ["o45", "v1.1", "accountless", "plus", 6_000, "2026-03-10", "2026-06-01"],
  ["o46", "v1", "social", "plus", 4_500, "2026-01-05", "2026-05-25"],
  ["o47", "v1.1", "accountless", "plus", 3_200, "2026-04-01", "2026-05-10"],
  ["o48", "v1", "social", "plus", 2_400, "2026-02-14", "2026-04-14"],
  ["o49", "v1.1", "accountless", "plus", 1_200, "2026-04-20", "2026-06-05"],
  ["o50", "v1", "social", "plus", 1_700, "2026-03-01", "2026-06-21"],
  ["o51", "v1", "social", "plus", 800, "2026-04-01", "2026-05-05"],
  ["o52", "v1.1", "accountless", "plus", 500, "2026-05-15", "2026-06-20"],
  ["o53", "v1", "social", "plus", 300, "2026-05-01", "2026-06-10"],
  ["o54", "none", "social", "plus", 0, null, null],
]);

/** The 54 owners, frozen. Day ranges are UTC days; usage counts are at scale 1. */
export const PROD_SHAPE_ROSTER = Object.freeze([
  ...ACTIVE.map(([key, routing, kind, planType, windowUsage, ratio, firstDay]) => Object.freeze({
    key, routing, kind, planType, windowUsage, preWindowUsage: Math.round(windowUsage * ratio),
    firstDay: ratio === 0 ? PROD_SHAPE_WINDOW.fromDay : firstDay, lastDay: LAST_DAY,
  })),
  ...INACTIVE.map(([key, routing, kind, planType, preWindowUsage, firstDay, lastDay]) => Object.freeze({
    key, routing, kind, planType, windowUsage: 0, preWindowUsage, firstDay, lastDay,
  })),
]);

/** The storage format of one owner-day: v11, v1 or v12. */
export function dayFormat(owner, day) {
  if (owner.routing === "v1.1") return "v11";
  if (owner.routing === "v1") return "v1";
  if (owner.routing === "v1.2") return "v12";
  if (owner.routing === "mixed") return day < PROD_SHAPE_MIXED_SWITCH_DAY ? "v11" : "v12";
  throw new Error("PROD_SHAPE_ROUTING_HAS_NO_FORMAT");
}

function validScale(scale) {
  if (!(typeof scale === "number" && scale > 0 && scale <= 1)) throw new TypeError("PROD_SHAPE_SCALE_INVALID");
  return scale;
}

// ------------------------------------------------------------ day plan --

const WEEKDAY_WEIGHT = Object.freeze([0.55, 1, 1.05, 1.08, 1.04, 0.95, 0.6]); // Sunday first

/**
 * Integer usage targets for `days` summing exactly to `total`: weekday weight,
 * a linear trend from `trendFrom` to `trendTo`, log-normal noise (sigma 0.55),
 * burst days (4%, times 2.5), an activity probability that rises with the mean
 * per day, and the last corpus day (which closes at 02:30Z) at a seventh of a
 * day. Largest remainder; no day above PROD_SHAPE_MAX_DAY_USAGE.
 */
function allocateDays({ label, days, total, trendFrom, trendTo }) {
  const out = new Map();
  if (total <= 0 || days.length === 0) return out;
  const d = draws(label);
  const mean = total / days.length;
  const activity = Math.min(0.97, Math.max(0.06, mean / 70));
  const weights = days.map((day, index) => {
    const active = d.random() < activity;
    const noise = Math.exp(0.55 * d.normal() - 0.15);
    const burst = d.random() < 0.04 ? 2.5 : 1;
    if (!active) return 0;
    const trend = trendFrom + (trendTo - trendFrom) * (days.length === 1 ? 1 : index / (days.length - 1));
    const weekday = WEEKDAY_WEIGHT[new Date(dayStartMs(day)).getUTCDay()];
    return weekday * trend * noise * burst * (day === LAST_DAY ? 1 / 7 : 1);
  });
  // At least one active day carries the total.
  if (weights.every((weight) => weight === 0)) weights[weights.length - 1] = 1;
  let capped = new Set();
  let targets;
  for (let round = 0; round < 50; round++) {
    const free = weights.reduce((sum, weight, index) => sum + (capped.has(index) ? 0 : weight), 0);
    const remaining = total - capped.size * PROD_SHAPE_MAX_DAY_USAGE;
    const raw = weights.map((weight, index) => capped.has(index) ? PROD_SHAPE_MAX_DAY_USAGE : weight / free * remaining);
    const over = raw.flatMap((value, index) => !capped.has(index) && value > PROD_SHAPE_MAX_DAY_USAGE ? [index] : []);
    if (over.length === 0) { targets = raw; break; }
    for (const index of over) capped.add(index);
  }
  if (!targets) throw new Error("PROD_SHAPE_DAY_CAP_UNPLACEABLE");
  const floors = targets.map(Math.floor);
  let left = total - floors.reduce((sum, value) => sum + value, 0);
  const order = targets.map((value, index) => [value - Math.floor(value), index])
    .filter(([, index]) => weights[index] > 0 && floors[index] < PROD_SHAPE_MAX_DAY_USAGE)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  if (left > 0 && order.length === 0) throw new Error("PROD_SHAPE_DAY_CAP_UNPLACEABLE");
  for (let index = 0; left > 0; index = (index + 1) % order.length, left--) floors[order[index][1]]++;
  days.forEach((day, index) => { if (floors[index] > 0) out.set(day, floors[index]); });
  return out;
}

/**
 * One owner's usage target per day at `scale`: the window (2026-06-23 to the
 * corpus day) and the history before it (from the owner's first day), each
 * exact. An inactive owner has only history, ending on its last day.
 */
export function ownerDayPlan(owner, scale = 1) {
  validScale(scale);
  const plan = new Map();
  if (owner.routing === "none") return plan;
  const window = Math.round(owner.windowUsage * scale);
  const pre = Math.round(owner.preWindowUsage * scale);
  if (window > 0) {
    for (const [day, n] of allocateDays({ label: `${owner.key}:plan:window`, total: window,
      days: dayRange(PROD_SHAPE_WINDOW.fromDay, LAST_DAY), trendFrom: 0.85, trendTo: 1.15 })) plan.set(day, n);
  }
  if (pre > 0) {
    const through = owner.windowUsage > 0 ? PRE_WINDOW_LAST_DAY : owner.lastDay;
    for (const [day, n] of allocateDays({ label: `${owner.key}:plan:history`, total: pre,
      days: dayRange(owner.firstDay, through), trendFrom: owner.windowUsage > 0 ? 0.35 : 0.8,
      trendTo: owner.windowUsage > 0 ? 1 : 0.6 })) plan.set(day, n);
  }
  return plan;
}

/** Window and history usage per owner at `scale`, from the plans alone (no records). */
export function prodShapeSummary(scale = 1) {
  return PROD_SHAPE_ROSTER.map((owner) => {
    const plan = ownerDayPlan(owner, scale);
    let window = 0, beforeWindow = 0, analysisDays = 0, maxDay = 0;
    const formats = { v1: 0, v11: 0, v12: 0 };
    for (const [day, n] of plan) {
      if (day >= PROD_SHAPE_WINDOW.fromDay) window += n; else beforeWindow += n;
      if (day >= PROD_SHAPE_ANALYSIS_FROM_DAY) analysisDays += n;
      maxDay = Math.max(maxDay, n);
      if (day >= PROD_SHAPE_WINDOW.fromDay) formats[dayFormat(owner, day)] += n;
    }
    const days = [...plan.keys()].sort();
    return { key: owner.key, routing: owner.routing, kind: owner.kind, planType: owner.planType,
      windowUsage: window, windowUsageByFormat: formats, beforeWindowUsage: beforeWindow,
      analysisHorizonUsage: analysisDays, totalUsage: window + beforeWindow, activeDays: plan.size,
      firstDay: days[0] ?? null, lastDay: days.at(-1) ?? null, maxDayUsage: maxDay };
  });
}

// -------------------------------------------------------------- records --

function sessionShape(target) {
  if (target >= 5_000) return { lo: 5, hi: 600, shortGapShare: 0.98 };
  if (target >= 1_500) return { lo: 5, hi: 400, shortGapShare: 0.9 };
  return { lo: 5, hi: 120, shortGapShare: 0.35 };
}
function gap(d, shortShare) {
  if (d.random() < shortShare) return d.pick(SHORT_GAPS_SECONDS) * SECOND + d.int(0, 999);
  return Math.round(d.pick(LONG_GAPS_MINUTES) * MINUTE) + d.int(1, 50) * SECOND + d.int(0, 999);
}
/** The working window of one day's own sessions. The last day closes by 02:30Z. */
function dayWindow(day, target) {
  const start = dayStartMs(day);
  if (day === LAST_DAY) return { from: start + 5 * MINUTE, to: start + 150 * MINUTE };
  if (target < 1_500) return { from: start + 6 * HOUR, to: start + 23 * HOUR };
  return { from: start + 20 * MINUTE, to: start + 23 * HOUR + 40 * MINUTE };
}
function sessionEvents(d, { count, from, limit, shortShare }) {
  const out = [];
  let at = from;
  for (let index = 0; index < count && at < limit; index++) {
    out.push({ at, index });
    at += gap(d, shortShare);
  }
  return out;
}

/**
 * Builds one owner's records. `plan` is its day plan; `models` its model set.
 * Records carry the day's storage format's schema versions (v1 days carry
 * v1.1 records, which seeding projects to v1.0 with production's own
 * projection).
 */
function ownerRecordBuilder(owner, plan, models) {
  const trackId = `account-track:v2:${hex("track", owner.key)}`;
  const attribution = () => ({ accountBasis: "same_source", accountTrackId: trackId,
    planBasis: "same_source_occurrence", planType: owner.planType, planEraId: null });
  const target = (day) => plan.get(day) ?? 0;

  /** Sessions crossing from `day` into the next day: heads cost at most a quarter of the day. */
  const crossing = (day) => {
    const t = target(day);
    if (day >= LAST_DAY || t < 160 || target(addDays(day, 1)) === 0) return [];
    return Array.from({ length: Math.min(8, Math.floor(t / 160)) }, (_, j) => ({ j,
      sessionUuid: uuid("session", owner.key, day, "cross", String(j)) }));
  };
  /** Sessions starting on `day` and resumed 1 to 6 days later: origins cost at most a quarter of the day. */
  const resumed = (day) => {
    const t = target(day);
    if (day >= LAST_DAY || t < 240) return [];
    const d = draws(`${owner.key}:resume:${day}`);
    const out = [];
    for (let j = 0; j < Math.min(4, Math.floor(t / 240)); j++) {
      const resumeDay = addDays(day, d.int(1, 6));
      if (resumeDay >= LAST_DAY || target(resumeDay) === 0) continue;
      out.push({ j, resumeDay, sessionUuid: uuid("session", owner.key, day, "resume", String(j)) });
    }
    return out;
  };

  const usageRecord = (d, { format, day, label, ordinal, at, sessionUuid, model, effort, first, index }) => {
    const scale = 0.4 + d.random() * 1.6;
    const inputUncachedTokens = Math.round((2_000 + d.random() * 30_000) * scale);
    const inputCacheReadTokens = first && d.random() < 0.5 ? 0 : Math.round((20_000 + d.random() * 600_000) * scale);
    const outputTextTokens = Math.max(1, Math.round((800 + d.random() * 12_000) * scale));
    const outputReasoningTokens = Math.round(d.random() * 9_000 * scale);
    const switched = d.random() < 0.2;
    const record = {
      schemaVersion: format === "v12" ? "usage-event-v1.2" : "usage-event-v1.1",
      eventId: `event:v2:${hex("event", owner.key, day, label, String(ordinal))}`,
      eventTime: iso(at), sessionUuid, provider: "openai_codex",
      modelId: switched ? d.pick(models) : model, speedMode: "standard", apiServiceTier: "default",
      surface: "local_interactive_unclassified", billingSurface: "chatgpt_subscription",
      reasoningEffort: switched ? d.pick(EFFORTS) : effort,
      agentScope: index > 2 && d.random() < 0.3 ? "subagent" : "root",
      outcome: "completed", totalInputContextTokens: inputUncachedTokens + inputCacheReadTokens,
      components: { inputUncachedTokens, inputCacheReadTokens, inputCacheWriteTokens: 0,
        outputTextTokens, outputReasoningTokens, outputCombinedTokens: null },
      accountPlanAttribution: attribution(),
    };
    if (format === "v12") Object.assign(record, { boundaryFlags: null, tieOrder: null, cacheWriteTtl: null });
    return record;
  };
  const sessionRecord = (d, format, sessionUuid, firstEventMs) => ({
    schemaVersion: format === "v12" ? "session-dimension-v1.2" : "session-dimension-v1.1",
    sessionUuid, firstEventTime: iso(firstEventMs), provider: "openai_codex",
    toolClassCounts: { localShell: d.int(1, 40), web: d.int(0, 6) + 1, other: d.int(1, 9) } });

  /**
   * Usage and session records of one owner-day, exactly target(day) usage
   * records: the heads of sessions crossing into the next day and the origins
   * of resumed sessions (each at most a quarter of the day), the tails of
   * sessions arriving from earlier days (truncated to what is left of half the
   * day), then the day's own sessions fill the rest.
   */
  const dayUsage = (day) => {
    const t = target(day);
    if (t === 0) return { usage: [], sessions: [] };
    const format = dayFormat(owner, day);
    const shape = sessionShape(t);
    const start = dayStartMs(day), end = start + DAY_MS;
    const window = dayWindow(day, t);
    const usage = [], sessions = [];
    const add = (d, label, sessionUuid, events, { record }) => {
      if (events.length === 0) return 0;
      const model = d.pick(models), effort = d.pick(EFFORTS);
      events.forEach((event, ordinal) => usage.push(usageRecord(d, { format, day, label, ordinal, at: event.at,
        sessionUuid, model, effort, first: event.index === 0, index: event.index })));
      if (record) sessions.push(sessionRecord(d, format, sessionUuid, events[0].at));
      return events.length;
    };
    let placed = 0;
    for (const spec of crossing(day)) {
      const d = draws(`${owner.key}:cross:${day}:${spec.j}:head`);
      const from = start + 23 * HOUR + d.int(0, 45) * MINUTE + d.int(0, 59) * SECOND;
      placed += add(d, `cross-head:${spec.j}`, spec.sessionUuid, sessionEvents(d, { count: d.int(3, 40), from,
        limit: end - 30 * SECOND, shortShare: 0.9 }), { record: true });
    }
    for (const spec of resumed(day)) {
      const d = draws(`${owner.key}:resume:${day}:${spec.j}:origin`);
      const from = window.from + Math.floor(d.random() * Math.max(1, (window.to - window.from) * 0.8));
      placed += add(d, `resume-origin:${spec.j}`, spec.sessionUuid, sessionEvents(d, { count: d.int(5, 60), from,
        limit: Math.min(window.to, end - MINUTE), shortShare: 0.6 }), { record: true });
    }
    let tailBudget = Math.max(0, Math.floor(t / 2) - placed);
    const previous = addDays(day, -1);
    for (const spec of crossing(previous)) {
      const d = draws(`${owner.key}:cross:${previous}:${spec.j}:tail`);
      const from = start + 5 * SECOND + d.int(0, 20) * MINUTE;
      const limit = day === LAST_DAY ? window.to : start + 6 * HOUR;
      const events = sessionEvents(d, { count: d.int(2, 60), from, limit, shortShare: 0.9 })
        .slice(0, tailBudget).map((event) => ({ ...event, index: event.index + 1 }));
      const n = add(d, `cross-tail:${spec.j}`, spec.sessionUuid, events, { record: false });
      placed += n; tailBudget -= n;
    }
    for (let back = 1; back <= 6; back++) {
      const origin = addDays(day, -back);
      for (const spec of resumed(origin)) {
        if (spec.resumeDay !== day) continue;
        const d = draws(`${owner.key}:resume:${origin}:${spec.j}:tail`);
        const from = start + 6 * HOUR + d.int(0, 14 * 60) * MINUTE;
        const events = sessionEvents(d, { count: d.int(5, 80), from, limit: day === LAST_DAY ? window.to : end - MINUTE,
          shortShare: 0.6 }).slice(0, tailBudget).map((event) => ({ ...event, index: event.index + 1 }));
        const n = add(d, `resume-tail:${origin}:${spec.j}`, spec.sessionUuid, events, { record: false });
        placed += n; tailBudget -= n;
      }
    }
    const own = draws(`${owner.key}:day:${day}`);
    let remaining = t - placed;
    for (let s = 0; remaining > 0 && s < 100_000; s++) {
      const want = Math.min(remaining, own.int(shape.lo, shape.hi));
      const span = Math.max(0, window.to - window.from);
      const from = window.from + Math.floor(own.random() * Math.max(1, span * 0.9));
      const n = add(own, `own:${s}`, uuid("session", owner.key, day, "own", String(s)),
        sessionEvents(own, { count: want, from, limit: Math.min(window.to, end - MINUTE),
          shortShare: shape.shortGapShare }), { record: true });
      remaining -= n;
    }
    if (remaining !== 0 || usage.length !== t) throw new Error("PROD_SHAPE_DAY_TARGET_UNPLACED");
    for (const record of usage) if (dayOf(Date.parse(record.eventTime)) !== day) throw new Error("PROD_SHAPE_EVENT_DAY");
    usage.sort((left, right) => left.eventTime < right.eventTime ? -1 : left.eventTime > right.eventTime ? 1
      : left.eventId < right.eventId ? -1 : 1);
    sessions.sort((left, right) => left.firstEventTime < right.firstEventTime ? -1
      : left.firstEventTime > right.firstEventTime ? 1 : left.sessionUuid < right.sessionUuid ? -1 : 1);
    return { usage, sessions };
  };
  return { dayUsage, attribution, window: dayWindow };
}

/** Production's usage-event-v0.1 pricing shape (Q-1's priceCost, the dense corpus's costUsd), in USD. */
function costUsd(pricer, record) {
  const c = record.components;
  const priced = pricer({
    schemaVersion: "usage-event-v0.1", eventTime: record.eventTime, provider: record.provider,
    modelId: record.modelId, modelRecognition: "recognized", modelFingerprint: null,
    billingSurface: record.billingSurface, speedMode: record.speedMode, apiServiceTier: record.apiServiceTier,
    reasoningEffort: record.reasoningEffort,
    components: { inputUncachedTokens: c.inputUncachedTokens, inputCacheReadTokens: c.inputCacheReadTokens,
      inputCacheWriteTokens: c.inputCacheWriteTokens, inputCacheWrite5mTokens: null, inputCacheWrite1hTokens: null,
      outputTextTokens: c.outputTextTokens, outputReasoningTokens: c.outputReasoningTokens,
      outputCombinedTokens: c.outputCombinedTokens },
    totalInputContextTokens: record.totalInputContextTokens,
  });
  if (priced?.coverageStatus !== "fully_priced" || !(priced.costNanousd > 0)) {
    throw new Error(`PROD_SHAPE_MODEL_NOT_FULLY_PRICED:${record.modelId}`);
  }
  return priced.costNanousd / 1e9;
}

/** Weekly resets of one owner: a fixed weekday and minute, from a week before its first day. */
function weeklyResets(owner, firstDay, lastDay) {
  const d = draws(`${owner.key}:resets`);
  const weekday = d.int(0, 6), minuteOfDay = d.int(0, 23) * 60 + 43;
  let at = dayStartMs(firstDay) - 7 * DAY_MS;
  while (new Date(at).getUTCDay() !== weekday) at += DAY_MS;
  at += minuteOfDay * MINUTE;
  const resets = [];
  for (; at <= dayStartMs(lastDay) + 15 * DAY_MS; at += 7 * DAY_MS) resets.push(at);
  return resets;
}

/**
 * One owner of the corpus at `scale`. `pricer` is production's
 * priceTelemetryUsageEvent. The first call prices every usage event once to
 * fix the owner's capacity scale; days() then regenerates each owner-day with
 * its quota. An owner with routing "none" has no days.
 */
export function createProdShapeOwner(owner, { pricer, scale = 1 }) {
  if (typeof pricer !== "function") throw new TypeError("PROD_SHAPE_PRICER_REQUIRED");
  validScale(scale);
  const plan = ownerDayPlan(owner, scale);
  const days = [...plan.keys()].sort();
  const pick = draws(`${owner.key}:profile`);
  const modelCount = owner.windowUsage + owner.preWindowUsage >= 50_000 ? 3 : pick.int(1, 2);
  const models = Object.freeze([...MODELS].sort((a, b) => hex("model-order", owner.key, a)
    .localeCompare(hex("model-order", owner.key, b))).slice(0, modelCount));
  const peakPercent = pick.int(55, 92);
  const participantId = `participant:${uuid("participant", owner.key)}`;
  const pinnedOwnerDigest = hex("owner-digest", owner.key);
  const spec = { key: owner.key, routing: owner.routing, kind: owner.kind, planType: owner.planType,
    participantId, pinnedOwnerDigest, accountTrackId: `account-track:v2:${hex("track", owner.key)}`, models,
    peakPercent, dayCount: days.length, firstDay: days[0] ?? null, lastDay: days.at(-1) ?? null };
  if (days.length === 0) {
    return Object.freeze({ spec: Object.freeze({ ...spec, usageEvents: 0, capacityScale: null, resets: 0 }),
      plan, *days() {} });
  }
  const builder = ownerRecordBuilder(owner, plan, models);
  const resets = weeklyResets(owner, days[0], days.at(-1));
  // Pass 1: every usage event's instant and capacity-normalized spend, in time
  // order (each day is sorted and the days ascend).
  const times = new Float64Array(days.reduce((sum, day) => sum + plan.get(day), 0));
  const normalized = new Float64Array(times.length);
  let n = 0;
  for (const day of days) {
    for (const record of builder.dayUsage(day).usage) {
      const at = Date.parse(record.eventTime);
      if (n > 0 && at < times[n - 1]) throw new Error("PROD_SHAPE_EVENT_ORDER");
      times[n] = at;
      normalized[n] = costUsd(pricer, record) / BASE_CAPACITY[record.modelId];
      n++;
    }
  }
  if (n !== times.length) throw new Error("PROD_SHAPE_EVENT_COUNT");
  const prefix = new Float64Array(n + 1);
  for (let index = 0; index < n; index++) prefix[index + 1] = prefix[index] + normalized[index];
  const bound = (ms, inclusive) => {
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (inclusive ? times[mid] <= ms : times[mid] < ms) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  const spend = (fromMs, throughMs) => prefix[bound(throughMs, true)] - prefix[bound(fromMs, false)];
  let peak = 0;
  for (let index = 0; index + 1 < resets.length; index++) {
    peak = Math.max(peak, spend(resets[index], resets[index + 1] - 1) * 100);
  }
  const capacityScale = Math.max(1e-6, Math.round(peak / peakPercent * 1e6) / 1e6);
  const resetWindow = (ms) => {
    for (let index = 1; index < resets.length; index++) {
      if (ms < resets[index]) return { start: resets[index - 1], end: resets[index] };
    }
    throw new Error("PROD_SHAPE_RESET_OUT_OF_RANGE");
  };
  const quotaRecord = (d, { format, label, observed, slot }) => {
    let percent, resetsAt;
    if (slot === "seven_day") {
      const window = resetWindow(observed);
      percent = spend(window.start, observed) * 100 / capacityScale;
      resetsAt = window.end;
    } else {
      const from = Math.floor(observed / FIVE_HOURS) * FIVE_HOURS;
      percent = spend(from, observed) * 100 / (capacityScale / 6);
      resetsAt = from + FIVE_HOURS;
    }
    percent = Math.round(Math.min(100, percent) * 10_000) / 10_000;
    if (!(percent >= 0 && percent <= 100)) throw new Error("PROD_SHAPE_PERCENT_INVALID");
    return { schemaVersion: format === "v12" ? "quota-observation-v1.2" : "quota-observation-v1.1",
      observationId: `quota-occurrence:v1:${hex("quota", owner.key, label)}`,
      observedTime: iso(observed), provider: "openai_codex", planType: owner.planType, planVariant: "unknown",
      limitId: "codex", slot, usedPercent: percent, windowDurationMinutes: slot === "seven_day" ? 10_080 : 300,
      resetsAt: iso(resetsAt + d.int(-2_000, 2_000)), accountPlanAttribution: builder.attribution() };
  };

  const ownerDay = (day) => {
    const { usage, sessions } = builder.dayUsage(day);
    const format = dayFormat(owner, day);
    const start = dayStartMs(day), end = start + DAY_MS;
    const lastObservable = day === LAST_DAY ? builder.window(day, plan.get(day) ?? 0).to : end - 1;
    const d = draws(`${owner.key}:quota:${day}`);
    const quota = [];
    usage.forEach((record, index) => {
      if (d.random() >= 1 / 12) return;
      const observed = Date.parse(record.eventTime) + d.int(1, 20) * SECOND + d.int(0, 999);
      if (observed > lastObservable) return;
      quota.push(quotaRecord(d, { format, label: `${day}:7d:${index}`, observed, slot: "seven_day" }));
      quota.push(quotaRecord(d, { format, label: `${day}:5h:${index}`, observed, slot: "five_hour" }));
    });
    for (const reset of resets) {
      const observed = reset + MINUTE;
      if (usage.length === 0 || observed < start || observed > lastObservable) continue;
      quota.push(quotaRecord(d, { format, label: `${day}:reset`, observed, slot: "seven_day" }));
    }
    quota.sort((left, right) => left.observedTime < right.observedTime ? -1 : left.observedTime > right.observedTime ? 1
      : left.observationId < right.observationId ? -1 : 1);
    for (const record of quota) if (dayOf(Date.parse(record.observedTime)) !== day) throw new Error("PROD_SHAPE_QUOTA_DAY");
    return { day, format, records: { quota, session: sessions, usage } };
  };

  // A v1.1 or v1.2 domain is one complete, contiguous range of day manifests,
  // including days with no records (parseTelemetryV11DomainManifest), and its
  // predecessor reaches the activation day (d43c8f92 createTelemetryV11-
  // DomainPredecessor counts today among the known days), so those owners
  // yield every day from their first planned day through the corpus day, as a
  // client's domain covers its whole history through today. v1 owners upload
  // legacy chunks per day and yield only their active days.
  const yielded = owner.routing === "v1" ? days : dayRange(days[0], LAST_DAY);
  return Object.freeze({
    spec: Object.freeze({ ...spec, usageEvents: n, capacityScale, resets: resets.length, manifestDays: yielded.length }),
    plan,
    day: ownerDay,
    /** Every owner-day in day order (empty days inside a domain included). */
    *days() { for (const day of yielded) yield ownerDay(day); },
  });
}
