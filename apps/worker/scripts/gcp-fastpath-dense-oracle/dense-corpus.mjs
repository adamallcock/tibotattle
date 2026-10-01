// Deterministic, content-free generator for the GCP fast-path DENSE owner (e).
//
// Owners a to d stay the Q-1 corpus files byte for byte; this module only adds
// owner e: one social v1.2 owner whose usage is dense enough that production
// (d43c8f92) routes it through its native paths, and large enough to cross every
// bound the GCP fast path refused at 7ef0e144:
//
//   class Q (2026-04-15)     13,500 seven-day quota observations (> 12,800 quota
//                            rows) over ~4,000 usage events;
//   class X (4 days)         ~40,000 usage events: > 20,000 occurrences and
//                            > 32 MiB of record JSON in one day;
//   class H (4 days)         18,000-23,000 usage events: > 20,000 occurrences
//                            under 32 MiB;
//   class M (every 9th day)  6,000-15,000 usage events: production's native
//                            threshold (6,000 rows) but not the GCP one;
//   class L (all others)     300-1,200 usage events.
//
// The latest 101-day window then holds ~409,000 usage rows (> 120,000 and
// > 204,800, the single-call page bound of the shared scalar path) and every
// window holds at most 1,000,000 (MAX_WINDOWED_USAGE_ROWS).
//
// Synthetic and content-free: identifiers are hash-derived, there are no paths,
// prompts, commands, accounts or emails. The generator is pure: it does no I/O
// and takes the pricer it needs (production's priceTelemetryUsageEvent) as an
// argument, so it runs unchanged in Node and in workerd. Every owner-day is
// regenerated from its own PRNG streams, so days stream one at a time and the
// whole owner never has to be held in memory. `scale` multiplies only the M and
// L class targets (a pilot at 0.1 still crosses every bound).

import { createHash } from "node:crypto";

export const DENSE_CORPUS_SCHEMA_VERSION = "gcp-fastpath-dense-corpus-v1";
/** Q-1's seed: hex() and uuid() identities share its namespace, so owner e's
 * pinned digest is hex('owner-digest','e') exactly as a to d's are. */
export const DENSE_CORPUS_SEED = "gcp-fastpath-oracle-2026-10-01";
export const DENSE_CORPUS_THROUGH_DAY = "2026-10-01";
export const DENSE_CORPUS_DAYS = 170;
export const DENSE_CORPUS_PINNED_NOW = "2026-10-01T12:00:00.000Z";

const DAY_MS = 86_400_000, MINUTE = 60_000, SECOND = 1_000, HOUR = 3_600_000;
const OWNER = "e";
const MODELS = Object.freeze(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"]);
const EFFORTS = Object.freeze(["low", "medium", "high"]);
/** Base weekly capacity per model (Q-1's), USD of API-price-equivalent spend per
 * 100% of a pro seven-day window; scaled below so the busiest week peaks at 80%. */
const BASE_CAPACITY = Object.freeze({ "gpt-5.6-sol": 900, "gpt-5.6-terra": 420, "gpt-5.5": 700 });
const PEAK_PERCENT = 80;

export const DENSE_CLASS_DAYS = Object.freeze({
  Q: Object.freeze(["2026-04-15"]),
  X: Object.freeze(["2026-07-02", "2026-08-19", "2026-09-16", "2026-09-29"]),
  H: Object.freeze(["2026-06-24", "2026-08-05", "2026-09-02", "2026-09-24"]),
});
const M_FROM_DAY = "2026-05-01", M_EVERY_DAYS = 9;
const Q_DAY_SEVEN_DAY_OBSERVATIONS = 13_500;

const hex = (...parts) => createHash("sha256").update([DENSE_CORPUS_SEED, ...parts].join("\u0000")).digest("hex");
const uuid = (...parts) => {
  const h = hex("uuid", ...parts);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
/** mulberry32 over a hash-derived state (Q-1's construction). */
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
  };
}
const iso = (ms) => new Date(ms).toISOString();
const dayStartMs = (day) => Date.parse(`${day}T00:00:00.000Z`);
const dayOf = (ms) => iso(ms).slice(0, 10);

export const DENSE_CORPUS_DAY_LIST = Object.freeze(Array.from({ length: DENSE_CORPUS_DAYS }, (_, i) =>
  iso(dayStartMs(DENSE_CORPUS_THROUGH_DAY) - (DENSE_CORPUS_DAYS - 1 - i) * DAY_MS).slice(0, 10)));
const FIRST_DAY = DENSE_CORPUS_DAY_LIST[0];
const LAST_DAY = DENSE_CORPUS_THROUGH_DAY;

/**
 * Weekly seven-day resets: Wednesdays 17:43Z through 2026-08-26, one early
 * reset on Tuesday 2026-09-01 15:43Z, then Tuesdays 15:43Z. The list starts
 * one reset before the corpus so every observation has a window start.
 */
export const DENSE_RESETS = Object.freeze((() => {
  const resets = [];
  for (let at = Date.parse("2026-04-08T17:43:00.000Z"); at <= Date.parse("2026-08-26T17:43:00.000Z"); at += 7 * DAY_MS) {
    resets.push(at);
  }
  for (let at = Date.parse("2026-09-01T15:43:00.000Z"); at <= Date.parse("2026-10-06T15:43:00.000Z"); at += 7 * DAY_MS) {
    resets.push(at);
  }
  return resets;
})());

/** The reset window [start, end) containing ms. */
function resetWindow(ms) {
  for (let index = 1; index < DENSE_RESETS.length; index++) {
    if (ms < DENSE_RESETS[index]) return { start: DENSE_RESETS[index - 1], end: DENSE_RESETS[index] };
  }
  throw new Error("DENSE_CORPUS_RESET_OUT_OF_RANGE");
}
const FIVE_HOURS = 5 * HOUR;

/** The class of one owner-day. X, H and Q take precedence over M; the last day is L. */
export function denseDayClass(day) {
  for (const [name, days] of Object.entries(DENSE_CLASS_DAYS)) if (days.includes(day)) return name;
  if (day === LAST_DAY) return "L";
  const offset = Math.round((dayStartMs(day) - dayStartMs(M_FROM_DAY)) / DAY_MS);
  return offset >= 0 && offset % M_EVERY_DAYS === 0 ? "M" : "L";
}

/** Usage events planned for one owner-day's own sessions (tails are extra). */
export function denseDayUsageTarget(day, scale = 1) {
  const { int } = draws(`${OWNER}:plan:${day}`);
  const kind = denseDayClass(day);
  if (kind === "X") return 40_000 + int(0, 999);
  if (kind === "H") return int(18_000, 23_000);
  if (kind === "Q") return 4_000;
  if (kind === "M") return Math.max(20, Math.round(int(6_000, 15_000) * scale));
  if (day === LAST_DAY) return Math.max(5, Math.round(int(60, 160) * scale));
  return Math.max(20, Math.round(int(300, 1_200) * scale));
}

/** Per-class session shape: events per session, crossing and resumed sessions. */
const SESSION_SHAPE = Object.freeze({
  X: { lo: 5, hi: 600, crossing: 12, resumed: 6, shortGapShare: 0.985 },
  H: { lo: 5, hi: 600, crossing: 8, resumed: 6, shortGapShare: 0.98 },
  Q: { lo: 5, hi: 300, crossing: 2, resumed: 2, shortGapShare: 0.9 },
  M: { lo: 5, hi: 400, crossing: 5, resumed: 3, shortGapShare: 0.9 },
  L: { lo: 5, hi: 120, crossing: 1, resumed: 1, shortGapShare: 0.35 },
});
const SHORT_GAPS_SECONDS = Object.freeze([3, 5, 8, 12, 18, 25, 35, 45, 60, 90]);
// Pauses between consecutive requests span every cache-retention band (Q-1's set).
const LONG_GAPS_MINUTES = Object.freeze([0.5, 1, 2, 3, 4, 6, 9, 14, 22, 35, 50, 70]);

function gap(d, shortShare) {
  if (d.random() < shortShare) return d.pick(SHORT_GAPS_SECONDS) * SECOND + d.int(0, 999);
  return Math.round(d.pick(LONG_GAPS_MINUTES) * MINUTE) + d.int(1, 50) * SECOND + d.int(0, 999);
}

/** The working window of one day's own sessions. The last day closes by 02:30Z
 * (Q-1's rule) so nothing is after the seeding instant. */
function dayWindow(day) {
  const start = dayStartMs(day);
  if (day === LAST_DAY) return { from: start + 5 * MINUTE, to: start + 150 * MINUTE };
  const kind = denseDayClass(day);
  if (kind === "L") return { from: start + 6 * HOUR, to: start + 23 * HOUR };
  return { from: start + 20 * MINUTE, to: start + 23 * HOUR + 40 * MINUTE };
}

function attribution(planType) {
  return { accountBasis: "same_source", accountTrackId: `account-track:v2:${hex("track", OWNER)}`,
    planBasis: "same_source_occurrence", planType, planEraId: null };
}

/** One usage event (usage-event-v1.2), Q-1's token model. */
function usageRecord(d, { day, label, ordinal, at, sessionUuid, model, effort, first, index }) {
  const scale = 0.4 + d.random() * 1.6;
  const inputUncachedTokens = Math.round((2_000 + d.random() * 30_000) * scale);
  const inputCacheReadTokens = first && d.random() < 0.5 ? 0 : Math.round((20_000 + d.random() * 600_000) * scale);
  const outputTextTokens = Math.max(1, Math.round((800 + d.random() * 12_000) * scale));
  const outputReasoningTokens = Math.round(d.random() * 9_000 * scale);
  const switched = d.random() < 0.2;
  return {
    schemaVersion: "usage-event-v1.2", eventId: `event:v2:${hex("event", OWNER, day, label, String(ordinal))}`,
    eventTime: iso(at), sessionUuid, provider: "openai_codex",
    modelId: switched ? d.pick(MODELS) : model, speedMode: "standard", apiServiceTier: "default",
    surface: "local_interactive_unclassified", billingSurface: "chatgpt_subscription",
    reasoningEffort: switched ? d.pick(EFFORTS) : effort,
    agentScope: index > 2 && d.random() < 0.3 ? "subagent" : "root",
    outcome: "completed", totalInputContextTokens: inputUncachedTokens + inputCacheReadTokens,
    components: { inputUncachedTokens, inputCacheReadTokens, inputCacheWriteTokens: 0,
      outputTextTokens, outputReasoningTokens, outputCombinedTokens: null },
    accountPlanAttribution: attribution("pro"),
    boundaryFlags: null, tieOrder: null, cacheWriteTtl: null,
  };
}

function sessionRecord(d, sessionUuid, firstEventMs) {
  return { schemaVersion: "session-dimension-v1.2", sessionUuid, firstEventTime: iso(firstEventMs),
    provider: "openai_codex",
    toolClassCounts: { localShell: d.int(1, 40), web: d.int(0, 6) + 1, other: d.int(1, 9) } };
}

/** Events of one session run from `from` while they stay before `limit`. */
function sessionEvents(d, { day, label, count, from, limit, shortShare }) {
  const out = [];
  let at = from;
  for (let index = 0; index < count && at < limit; index++) {
    out.push({ at, index });
    at += gap(d, shortShare);
  }
  return out;
}

/** Specs of sessions that cross from `day` into the next day. */
function crossingSessions(day) {
  if (day >= LAST_DAY || !DENSE_CORPUS_DAY_LIST.includes(day)) return [];
  const shape = SESSION_SHAPE[denseDayClass(day)];
  return Array.from({ length: shape.crossing }, (_, j) => ({ origin: day, j,
    sessionUuid: uuid("session", OWNER, day, "cross", String(j)) }));
}

/** Specs of sessions that start on `day` and resume 1 to 6 days later. */
function resumedSessions(day) {
  if (!DENSE_CORPUS_DAY_LIST.includes(day) || day === LAST_DAY) return [];
  const shape = SESSION_SHAPE[denseDayClass(day)];
  const d = draws(`${OWNER}:resume:${day}`);
  const out = [];
  for (let j = 0; j < shape.resumed; j++) {
    const resumeDay = dayOf(dayStartMs(day) + d.int(1, 6) * DAY_MS);
    if (resumeDay >= LAST_DAY) continue;
    out.push({ origin: day, j, resumeDay, sessionUuid: uuid("session", OWNER, day, "resume", String(j)) });
  }
  return out;
}

/**
 * The usage events and session records of one owner-day, without quota. Pure
 * in `day` and `scale`: own sessions, the heads of sessions crossing into the
 * next day, the tails of sessions crossing in from the previous day, and the
 * origin and resumed portions of resumed sessions.
 */
function dayUsage(day, scale) {
  const kind = denseDayClass(day);
  const shape = SESSION_SHAPE[kind];
  const start = dayStartMs(day), end = start + DAY_MS;
  const window = dayWindow(day);
  const usage = [], sessions = [];
  const addSession = (d, label, sessionUuid, events, { record }) => {
    if (events.length === 0) return;
    const model = d.pick(MODELS), effort = d.pick(EFFORTS);
    events.forEach((event, ordinal) => usage.push(usageRecord(d, { day, label, ordinal, at: event.at,
      sessionUuid, model, effort, first: event.index === 0, index: event.index })));
    if (record) sessions.push(sessionRecord(d, sessionUuid, events[0].at));
  };

  // Own sessions: allocate the day's target across sessions that fit the window.
  const own = draws(`${OWNER}:day:${day}`);
  let remaining = denseDayUsageTarget(day, scale);
  for (let s = 0; remaining > 0 && s < 10_000; s++) {
    const want = Math.min(remaining, own.int(shape.lo, shape.hi));
    const span = Math.max(0, window.to - window.from);
    const from = window.from + Math.floor(own.random() * Math.max(1, span * 0.9));
    const events = sessionEvents(own, { day, label: `own:${s}`, count: want, from,
      limit: Math.min(window.to, end - MINUTE), shortShare: shape.shortGapShare });
    addSession(own, `own:${s}`, uuid("session", OWNER, day, "own", String(s)), events, { record: true });
    remaining -= events.length;
  }
  if (remaining > 0) throw new Error("DENSE_CORPUS_DAY_TARGET_UNPLACED");

  // Sessions crossing into the next day: their heads end before midnight.
  for (const spec of crossingSessions(day)) {
    const d = draws(`${OWNER}:cross:${day}:${spec.j}:head`);
    const from = start + 23 * HOUR + d.int(0, 45) * MINUTE + d.int(0, 59) * SECOND;
    const events = sessionEvents(d, { day, label: `cross-head:${spec.j}`, count: d.int(3, 40), from,
      limit: end - 30 * SECOND, shortShare: 0.9 });
    addSession(d, `cross-head:${spec.j}`, spec.sessionUuid, events, { record: true });
  }
  // Tails of sessions that crossed in from the previous day (no session record:
  // the session's dimension belongs to its first day).
  const previous = dayOf(start - DAY_MS);
  for (const spec of crossingSessions(previous)) {
    const d = draws(`${OWNER}:cross:${previous}:${spec.j}:tail`);
    const from = start + 5 * SECOND + d.int(0, 20) * MINUTE;
    const limit = day === LAST_DAY ? window.to : start + 6 * HOUR;
    const events = sessionEvents(d, { day, label: `cross-tail:${spec.j}`, count: d.int(2, 60), from,
      limit, shortShare: 0.9 }).map((event) => ({ ...event, index: event.index + 1 }));
    addSession(d, `cross-tail:${spec.j}`, spec.sessionUuid, events, { record: false });
  }
  // Resumed sessions: an origin portion today, a resumed portion 1-6 days later.
  for (const spec of resumedSessions(day)) {
    const d = draws(`${OWNER}:resume:${day}:${spec.j}:origin`);
    const from = window.from + Math.floor(d.random() * Math.max(1, (window.to - window.from) * 0.8));
    const events = sessionEvents(d, { day, label: `resume-origin:${spec.j}`, count: d.int(5, 60), from,
      limit: Math.min(window.to, end - MINUTE), shortShare: 0.6 });
    addSession(d, `resume-origin:${spec.j}`, spec.sessionUuid, events, { record: true });
  }
  for (let back = 1; back <= 6; back++) {
    const origin = dayOf(start - back * DAY_MS);
    for (const spec of resumedSessions(origin)) {
      if (spec.resumeDay !== day) continue;
      const d = draws(`${OWNER}:resume:${origin}:${spec.j}:tail`);
      const from = start + 6 * HOUR + d.int(0, 14 * 60) * MINUTE;
      const events = sessionEvents(d, { day, label: `resume-tail:${origin}:${spec.j}`, count: d.int(5, 80), from,
        limit: end - MINUTE, shortShare: 0.6 }).map((event) => ({ ...event, index: event.index + 1 }));
      addSession(d, `resume-tail:${origin}:${spec.j}`, spec.sessionUuid, events, { record: false });
    }
  }
  for (const record of usage) if (dayOf(Date.parse(record.eventTime)) !== day) throw new Error("DENSE_CORPUS_EVENT_DAY");
  usage.sort((left, right) => left.eventTime < right.eventTime ? -1 : left.eventTime > right.eventTime ? 1
    : left.eventId < right.eventId ? -1 : 1);
  sessions.sort((left, right) => left.firstEventTime < right.firstEventTime ? -1
    : left.firstEventTime > right.firstEventTime ? 1 : left.sessionUuid < right.sessionUuid ? -1 : 1);
  return { kind, usage, sessions };
}

/** Production's usage-event-v0.1 pricing shape (Q-1's priceCost), in USD. */
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
    throw new Error(`DENSE_CORPUS_MODEL_NOT_FULLY_PRICED:${record.modelId}`);
  }
  return priced.costNanousd / 1e9;
}

/**
 * Owner e. `pricer` is production's priceTelemetryUsageEvent; `scale` scales the
 * M and L classes only. The first call prices every usage event once to fix the
 * capacity scale; days() then regenerates each owner-day with its quota.
 */
export function createDenseOwner({ pricer, scale = 1 }) {
  if (typeof pricer !== "function") throw new TypeError("DENSE_CORPUS_PRICER_REQUIRED");
  if (!(typeof scale === "number" && scale > 0 && scale <= 1)) throw new TypeError("DENSE_CORPUS_SCALE_INVALID");
  // Pass 1: every usage event's instant and capacity-normalized spend.
  const times = [], normalized = [];
  for (const day of DENSE_CORPUS_DAY_LIST) {
    for (const record of dayUsage(day, scale).usage) {
      times.push(Date.parse(record.eventTime));
      normalized.push(costUsd(pricer, record) / BASE_CAPACITY[record.modelId]);
    }
  }
  const order = times.map((_, index) => index).sort((left, right) => times[left] - times[right] || left - right);
  const at = Float64Array.from(order, (index) => times[index]);
  const prefix = new Float64Array(order.length + 1);
  order.forEach((index, position) => { prefix[position + 1] = prefix[position] + normalized[index]; });
  const upTo = (ms) => { // events with time <= ms
    let lo = 0, hi = at.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (at[mid] <= ms) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const before = (ms) => { // events with time < ms
    let lo = 0, hi = at.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (at[mid] < ms) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const spend = (fromMs, throughMs) => prefix[upTo(throughMs)] - prefix[before(fromMs)];
  // The capacity scale: the busiest seven-day window peaks at PEAK_PERCENT.
  let peak = 0;
  for (let index = 0; index + 1 < DENSE_RESETS.length; index++) {
    peak = Math.max(peak, spend(DENSE_RESETS[index], DENSE_RESETS[index + 1] - 1) * 100);
  }
  const capacityScale = Math.round(peak / PEAK_PERCENT * 10_000) / 10_000;
  const sevenDayPercent = (ms) => {
    const window = resetWindow(ms);
    return { percent: Math.round(spend(window.start, ms) * 100 / capacityScale * 10_000) / 10_000, resetsAt: window.end };
  };
  const fiveHourPercent = (ms) => {
    const from = Math.floor(ms / FIVE_HOURS) * FIVE_HOURS;
    const percent = Math.min(100, spend(from, ms) * 100 / (capacityScale / 6));
    return { percent: Math.round(percent * 10_000) / 10_000, resetsAt: from + FIVE_HOURS };
  };
  const quotaRecord = (d, { label, observed, slot }) => {
    const value = slot === "seven_day" ? sevenDayPercent(observed) : fiveHourPercent(observed);
    if (!(value.percent >= 0 && value.percent <= 100)) throw new Error("DENSE_CORPUS_PERCENT_INVALID");
    return { schemaVersion: "quota-observation-v1.2",
      observationId: `quota-occurrence:v1:${hex("quota", OWNER, label)}`,
      observedTime: iso(observed), provider: "openai_codex", planType: "pro", planVariant: "unknown",
      limitId: "codex", slot, usedPercent: value.percent,
      windowDurationMinutes: slot === "seven_day" ? 10_080 : 300,
      resetsAt: iso(value.resetsAt + d.int(-2_000, 2_000)), accountPlanAttribution: attribution("pro") };
  };

  const ownerDay = (day) => {
    const { kind, usage, sessions } = dayUsage(day, scale);
    const start = dayStartMs(day), end = start + DAY_MS;
    const d = draws(`${OWNER}:quota:${day}`);
    const quota = [];
    if (kind === "Q") {
      // Evenly spaced seven-day observations across the whole day.
      const step = Math.floor((DAY_MS - 90 * SECOND) / Q_DAY_SEVEN_DAY_OBSERVATIONS);
      for (let index = 0; index < Q_DAY_SEVEN_DAY_OBSERVATIONS; index++) {
        quota.push(quotaRecord(d, { label: `${day}:q:${index}`, observed: start + 30 * SECOND + index * step,
          slot: "seven_day" }));
      }
    }
    // One observation per ~12 usage events, with its five-hour-slot twin.
    usage.forEach((record, index) => {
      if (d.random() >= 1 / 12) return;
      const observed = Date.parse(record.eventTime) + d.int(1, 20) * SECOND + d.int(0, 999);
      if (observed >= end || (day === LAST_DAY && observed > dayWindow(day).to)) return;
      if (kind !== "Q") quota.push(quotaRecord(d, { label: `${day}:7d:${index}`, observed, slot: "seven_day" }));
      quota.push(quotaRecord(d, { label: `${day}:5h:${index}`, observed, slot: "five_hour" }));
    });
    // One start-of-window observation one minute after each reset in this day.
    for (const reset of DENSE_RESETS) {
      const observed = reset + MINUTE;
      if (observed < start || observed >= end || day < FIRST_DAY) continue;
      if (day === LAST_DAY && observed > dayWindow(day).to) continue;
      quota.push(quotaRecord(d, { label: `${day}:reset`, observed, slot: "seven_day" }));
    }
    quota.sort((left, right) => left.observedTime < right.observedTime ? -1 : left.observedTime > right.observedTime ? 1
      : left.observationId < right.observationId ? -1 : 1);
    for (const record of quota) if (dayOf(Date.parse(record.observedTime)) !== day) throw new Error("DENSE_CORPUS_QUOTA_DAY");
    return { day, class: kind, format: "v12", records: { quota, session: sessions, usage } };
  };

  return Object.freeze({
    spec: Object.freeze({
      key: OWNER, kind: "social", format: "v12",
      participantId: `participant:${uuid("participant", OWNER)}`,
      pinnedOwnerDigest: hex("owner-digest", OWNER),
      planType: "pro", accountTrackId: `account-track:v2:${hex("track", OWNER)}`, models: MODELS,
      capacitiesUsdPerWindow: Object.fromEntries(MODELS.map((model) =>
        [model, Math.round(BASE_CAPACITY[model] * capacityScale * 100) / 100])),
      capacityScale, peakPercent: PEAK_PERCENT,
      resets: DENSE_RESETS.map(iso),
      storage: { v12: [FIRST_DAY, LAST_DAY] },
      dayCount: DENSE_CORPUS_DAY_LIST.length,
      usageEvents: at.length,
    }),
    /** Regenerate one owner-day. */
    day: ownerDay,
    /** Every owner-day in day order. */
    *days() { for (const day of DENSE_CORPUS_DAY_LIST) yield ownerDay(day); },
  });
}
