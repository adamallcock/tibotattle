/**
 * `cache_retention_by_pause` — how long a cached prefix survives a pause.
 *
 * The subject being measured is the provider's caching behaviour, not any
 * contributor's habits. One pair is two CONSECUTIVE requests in one session
 * under an unchanged configuration; the elapsed gap between them is the
 * evidence, and the seven bands are the decay shape.
 *
 * This is deliberately NOT the local dashboard's cache-continuity metric and
 * must never be published beside it, converted into dollars, or described as a
 * cache hit rate. The local lens admits only returns to an idle thread
 * (`usage_event_boundary.turn_context_before = 1`). Nothing uploaded today
 * carries that bit, and three candidate proxies were measured against the
 * owner's own ground truth and all failed to separate a new user turn from an
 * intra-turn continuation. On that corpus 97.6% of sub-minute adjacencies are
 * intra-turn, which inflates apparent reuse in that band from 94.8% to 99.1%
 * and over-weights it 49x (801,239 adjacencies standing in for 16,384 genuine
 * returns). The caption below says so in the product's own words, and every
 * band is published with the number of contributors standing behind it.
 *
 * Nothing in this module is content. Events carry an OPAQUE owner-scoped
 * session digest the caller derives; the reduction only ever compares session
 * digests for equality and only their cardinality reaches a stored row.
 */

/** The published metric id, its title, and the standing caption. The caption is
 * part of the contract: a reader who sees the number must see why it is not the
 * dashboard's number, so it is pinned by a test rather than left to a template. */
export const CACHE_RETENTION_METRIC_ID = "cache_retention_by_pause";
export const CACHE_RETENTION_TITLE = "How long a cached prefix survives a pause";
export const CACHE_RETENTION_CAPTION =
  "Measured across consecutive requests, not across user turns. Your own dashboard's "
  + "cache continuity figure counts only returns to an idle thread and is not comparable. "
  + "This is not a cache hit rate.";

/** One closed gap band. Identical ids, starts and ends to the local lens's
 * `CONTINUITY_GAP_BANDS`, so a hosted band can never be compared against a
 * differently cut one by accident. */
export interface CacheRetentionBand {
  readonly id: CacheRetentionBandId;
  readonly startMs: number;
  readonly endMs: number;
}
export type CacheRetentionBandId = "under_one_minute" | "one_to_two_minutes"
  | "two_to_five_minutes" | "five_to_ten_minutes" | "ten_to_thirty_minutes"
  | "thirty_minutes_to_one_hour" | "one_to_two_hours" | "two_to_six_hours"
  | "six_to_twenty_four_hours" | "over_twenty_four_hours";

/** The bounded lens. 7 days is the local
 * `CACHE_CONTINUITY_OUTCOME_DISPLAY_MAXIMUM_GAP_MS`, so the last band is
 * 24 hours to 7 days on both sides rather than unbounded on one of them. */
const LOOKBACK_DAYS = 7;
const MAXIMUM_GAP_MS = LOOKBACK_DAYS * 86_400_000;

export /** Ten bands, matching the local dashboard's nine plus a split of its 1-6h
 * bucket into 1-2h and 2-6h.
 *
 * The seven-band first cut was too coarse where the curve actually bends. The
 * local corpus puts the interesting decay between one and thirty minutes —
 * 99.2% at 1-2m, 97.6% at 2-5m, 95.7% at 5-10m, 86.4% at 10-30m — and a single
 * `one_to_five_minutes` bucket averages the first two together while
 * `five_to_thirty_minutes` averages the next two. Both distinctions are lost
 * exactly where a reader is trying to see the shape.
 *
 * The extra 1-2h/2-6h split has no local counterpart: it is there because
 * retention falls off a cliff somewhere in that range and a six-hour bucket
 * cannot say where. Bands are half-open [startMs, endMs). */
const CACHE_RETENTION_BANDS: readonly CacheRetentionBand[] = Object.freeze([
  Object.freeze({ id: "under_one_minute" as const, startMs: 0, endMs: 60_000 }),
  Object.freeze({ id: "one_to_two_minutes" as const, startMs: 60_000, endMs: 2 * 60_000 }),
  Object.freeze({ id: "two_to_five_minutes" as const, startMs: 2 * 60_000, endMs: 5 * 60_000 }),
  Object.freeze({ id: "five_to_ten_minutes" as const, startMs: 5 * 60_000, endMs: 10 * 60_000 }),
  Object.freeze({ id: "ten_to_thirty_minutes" as const, startMs: 10 * 60_000, endMs: 30 * 60_000 }),
  Object.freeze({ id: "thirty_minutes_to_one_hour" as const, startMs: 30 * 60_000, endMs: 60 * 60_000 }),
  Object.freeze({ id: "one_to_two_hours" as const, startMs: 60 * 60_000, endMs: 2 * 60 * 60_000 }),
  Object.freeze({ id: "two_to_six_hours" as const, startMs: 2 * 60 * 60_000, endMs: 6 * 60 * 60_000 }),
  Object.freeze({ id: "six_to_twenty_four_hours" as const, startMs: 6 * 60 * 60_000, endMs: 86_400_000 }),
  Object.freeze({ id: "over_twenty_four_hours" as const, startMs: 86_400_000, endMs: MAXIMUM_GAP_MS }),
]);
export const CACHE_RETENTION_BAND_IDS: readonly CacheRetentionBandId[] =
  Object.freeze(CACHE_RETENTION_BANDS.map((band) => band.id));

/**
 * The ONE object that governs the computation, including its own version.
 *
 * Every rule below is read from here by `reduceCacheRetentionDay` and the
 * version written into every stored row is `CACHE_RETENTION_METHOD.version`, so
 * the thing that decides the numbers is literally the thing that names them.
 * This repository has already been bitten by the opposite arrangement — a
 * runtime switch changed behaviour while a separate compile-time constant named
 * the cache key — and `cacheRetentionMethodDigest` plus its pinned test make a
 * silent divergence impossible: change any rule and the digest test fails until
 * `version` is bumped and the migration's closed `method_version` enum is
 * widened to admit it.
 */
export const CACHE_RETENTION_METHOD = Object.freeze({
  version: "cache-retention-v2",
  metric: CACHE_RETENTION_METRIC_ID,
  /** Positive-input requests only: quota-only and bookkeeping rows must not
   * consume an adjacency boundary. */
  population: "input_uncached+input_cache_read+input_cache_write>0",
  /** Fields that must be unchanged across the pair for it to be an adjacency
   * at all. Speed mode and surface are filters, not stored dimensions. */
  sameConfiguration: Object.freeze(["modelId", "reasoningEffort", "speedMode", "surface"]),
  /** Fields the stored rows are cut by. */
  groupedBy: Object.freeze(["modelId", "reasoningEffort"]),
  /** No `source_offset` is uploaded, so order is the observed instant with the
   * event's occurrence id only as a deterministic tiebreak. Equal instants are
   * counted as `unorderedTies` and never treated as proven order. */
  order: Object.freeze(["observedAtMs", "occurrenceId"]),
  /** Elapsed time is evidence, not an eligibility gate. */
  minimumGapMs: 0,
  maximumGapMs: MAXIMUM_GAP_MS,
  lookbackDays: LOOKBACK_DAYS,
  /** "More than half reused" is strict: `current > previous * 0.5`. */
  reusedMoreThanHalfRatio: 0.5,
  /** The owner's decision, recorded because it is a decision and not an
   * oversight: the community figure is a POOLED aggregate, not a median across
   * contributors. The subject is the provider's caching behaviour, so the
   * participant with the most evidence should carry the most weight. Every
   * band is published with its contributor count so a reader can see when a
   * number rests on two people. No band is withheld. */
  merge: "pooled",
  bands: CACHE_RETENTION_BANDS,
});

/** Which band a gap falls in, or null when it is outside the lens. A negative
 * gap is never adjacency and a gap beyond the bounded lookback is outside the
 * window the lane can prove anything about. */
export function cacheRetentionBandFor(gapMs: number): CacheRetentionBandId | null {
  if (!Number.isSafeInteger(gapMs) || gapMs < CACHE_RETENTION_METHOD.minimumGapMs
    || gapMs > CACHE_RETENTION_METHOD.maximumGapMs) return null;
  for (const band of CACHE_RETENTION_METHOD.bands) {
    if (gapMs >= band.startMs && gapMs < band.endMs) return band.id;
  }
  // The last band is closed at the lookback maximum, which `gapMs` may equal.
  return gapMs === CACHE_RETENTION_METHOD.maximumGapMs
    ? CACHE_RETENTION_METHOD.bands[CACHE_RETENTION_METHOD.bands.length - 1]!.id : null;
}

/** One positive-input usage event, already mapped by the caller.
 *
 * `sessionDigest` is OPAQUE and owner-scoped: no raw `sessionUuid` reaches this
 * module. `orderKey` is the event's occurrence id, used only in memory as the
 * deterministic tiebreak; it is never stored. Token components are `null` when
 * the upstream field was absent — never coerced to zero, because a missing
 * component is the difference between "no reuse" and "unknown". */
export interface CacheRetentionEvent {
  readonly sessionDigest: string;
  readonly observedAtMs: number;
  readonly orderKey: string;
  readonly model: string;
  readonly effort: string;
  readonly speedMode: string;
  readonly surface: string;
  readonly cacheReadTokens: number | null;
  readonly uncachedTokens: number | null;
  readonly cacheWriteTokens: number | null;
}

/**
 * A row in the session's sequence whose configuration or components could not
 * be read at all.
 *
 * It is not dropped, because dropping it would let the NEXT event pair with an
 * older one and overstate retention. It breaks the session's chain instead:
 * something happened here and the lane cannot say what, so no adjacency spans
 * it. Every field the v1.1 usage-event contract requires is required, so this
 * is a storage-integrity outcome rather than an expected one, and the day
 * records how many it saw.
 */
export interface CacheRetentionSessionBreak {
  readonly sessionDigest: string;
  readonly observedAtMs: number;
  readonly orderKey: string;
  readonly unreadable: true;
}
export type CacheRetentionItem = CacheRetentionEvent | CacheRetentionSessionBreak;

export function validCacheRetentionSessionBreak(value: unknown): value is CacheRetentionSessionBreak {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).sort().join(",")
    === ["sessionDigest", "observedAtMs", "orderKey", "unreadable"].sort().join(",")
    && typeof item.sessionDigest === "string" && /^[0-9a-f]{64}$/u.test(item.sessionDigest)
    && Number.isSafeInteger(item.observedAtMs)
    && typeof item.orderKey === "string" && item.orderKey.length > 0 && item.orderKey.length <= 256
    && item.unreadable === true;
}

export interface CacheRetentionBandCounters {
  readonly band: CacheRetentionBandId;
  /** Comparable adjacencies: the survivors of both exclusions below. */
  readonly adjacencies: number;
  readonly reusedMoreThanHalf: number;
  readonly matchedOrExceeded: number;
  readonly unorderedTies: number;
  /** Either side's cache read unobserved, or the previous cache read was zero,
   * so there was no prefix whose survival could be observed. */
  readonly excludedInsufficientEvidence: number;
  /** The current total input is smaller than the previous cache read, so the
   * prompt could not have held the previous prefix whatever the cache did. */
  readonly excludedContextContracted: number;
  readonly sessions: number;
}

export interface CacheRetentionGroup {
  readonly model: string;
  readonly effort: string;
  readonly adjacencies: number;
  readonly sessions: number;
  readonly bands: readonly CacheRetentionBandCounters[];
}

export interface CacheRetentionDayAggregate {
  readonly methodVersion: string;
  readonly day: string;
  /** Usage rows the day's read returned, including every row the mapper
   * skipped. An empty day that was READ stays distinguishable from one that
   * was never opened. */
  readonly eventsRead: number;
  /** Rows that broke a session chain because they could not be read. Explicit,
   * never folded into `eventsRead` and never treated as absence. */
  readonly unreadableEvents: number;
  readonly groups: readonly CacheRetentionGroup[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const TOKEN = /^[A-Za-z0-9._:-]{1,64}$/u;
const MAX_TOKENS = 1_000_000_000_000;
/** Per-day bounds. A day that exceeds either is refused by the caller rather
 * than silently truncated into an aggregate a merge would read as complete.
 * The measured maximum is 23 distinct `(model, effort, speedMode)` combinations
 * in one owner-day against 6.35 typical, so 512 is headroom rather than a
 * threshold anything approaches; the session bound mirrors the reduction's own
 * `MAX_SESSIONS`. */
export const CACHE_RETENTION_GROUP_LIMIT = 512;
export const CACHE_RETENTION_SESSION_LIMIT = 100_000;

export function validCacheRetentionDayLabel(value: unknown): value is string {
  return typeof value === "string" && DAY.test(value)
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}
export function validCacheRetentionToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}
function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function validTokens(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0
    && (value as number) <= MAX_TOKENS);
}

export function validCacheRetentionEvent(value: unknown): value is CacheRetentionEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return Object.keys(event).sort().join(",") === ["sessionDigest", "observedAtMs", "orderKey", "model",
    "effort", "speedMode", "surface", "cacheReadTokens", "uncachedTokens", "cacheWriteTokens"].sort().join(",")
    && typeof event.sessionDigest === "string" && /^[0-9a-f]{64}$/u.test(event.sessionDigest)
    && Number.isSafeInteger(event.observedAtMs)
    && typeof event.orderKey === "string" && event.orderKey.length > 0 && event.orderKey.length <= 256
    && validCacheRetentionToken(event.model) && validCacheRetentionToken(event.effort)
    && validCacheRetentionToken(event.speedMode) && validCacheRetentionToken(event.surface)
    && validTokens(event.cacheReadTokens) && validTokens(event.uncachedTokens)
    && validTokens(event.cacheWriteTokens);
}

export function validCacheRetentionBandCounters(value: unknown): value is CacheRetentionBandCounters {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const band = value as Record<string, unknown>;
  if (Object.keys(band).sort().join(",") !== ["band", "adjacencies", "reusedMoreThanHalf",
    "matchedOrExceeded", "unorderedTies", "excludedInsufficientEvidence",
    "excludedContextContracted", "sessions"].sort().join(",")) return false;
  if (!CACHE_RETENTION_BAND_IDS.includes(band.band as CacheRetentionBandId)) return false;
  for (const key of ["adjacencies", "reusedMoreThanHalf", "matchedOrExceeded", "unorderedTies",
    "excludedInsufficientEvidence", "excludedContextContracted", "sessions"]) {
    if (!validCount(band[key])) return false;
  }
  const counters = band as unknown as CacheRetentionBandCounters;
  return counters.reusedMoreThanHalf <= counters.adjacencies
    && counters.matchedOrExceeded <= counters.reusedMoreThanHalf
    && counters.unorderedTies <= counters.adjacencies
    && counters.sessions <= counters.adjacencies;
}

export function validCacheRetentionGroup(value: unknown): value is CacheRetentionGroup {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const group = value as Record<string, unknown>;
  if (Object.keys(group).sort().join(",")
    !== ["model", "effort", "adjacencies", "sessions", "bands"].sort().join(",")) return false;
  if (!validCacheRetentionToken(group.model) || !validCacheRetentionToken(group.effort)
    || !validCount(group.adjacencies) || !validCount(group.sessions)
    || !Array.isArray(group.bands) || group.bands.length !== CACHE_RETENTION_BAND_IDS.length) return false;
  let total = 0, largest = 0, spread = 0;
  for (let index = 0; index < group.bands.length; index += 1) {
    const band: unknown = group.bands[index];
    if (!validCacheRetentionBandCounters(band)
      || band.band !== CACHE_RETENTION_BAND_IDS[index]) return false;
    total += band.adjacencies;
    spread += band.sessions;
    largest = Math.max(largest, band.sessions);
  }
  // A session may contribute to several bands, so the group's distinct session
  // count is bounded by the bands rather than equal to their sum.
  return total === group.adjacencies && group.sessions >= largest && group.sessions <= spread
    && (group.adjacencies > 0 || group.sessions === 0);
}

export function validCacheRetentionDayAggregate(value: unknown): value is CacheRetentionDayAggregate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const aggregate = value as Record<string, unknown>;
  if (Object.keys(aggregate).sort().join(",")
    !== ["methodVersion", "day", "eventsRead", "unreadableEvents", "groups"].sort().join(",")) return false;
  if (aggregate.methodVersion !== CACHE_RETENTION_METHOD.version
    || !validCacheRetentionDayLabel(aggregate.day) || !validCount(aggregate.eventsRead)
    || !validCount(aggregate.unreadableEvents)
    || (aggregate.unreadableEvents as number) > (aggregate.eventsRead as number)
    || !Array.isArray(aggregate.groups)
    || aggregate.groups.length > CACHE_RETENTION_GROUP_LIMIT) return false;
  let previous = "";
  for (const group of aggregate.groups) {
    if (!validCacheRetentionGroup(group)) return false;
    // Groups are emitted in a total order, so an aggregate has exactly one
    // canonical byte sequence and a rebuild is comparable byte for byte.
    const order = cacheRetentionGroupOrder(group);
    if (order <= previous) return false;
    previous = order;
    // A group with no comparable adjacency and no exclusion is not evidence of
    // anything and must not occupy a row.
    if (group.bands.every((band) => band.adjacencies === 0
      && band.excludedInsufficientEvidence === 0 && band.excludedContextContracted === 0)) return false;
  }
  return true;
}

export function cacheRetentionGroupOrder(group: { model: string; effort: string }): string {
  return JSON.stringify([group.model, group.effort]);
}

interface MutableBand {
  adjacencies: number; reusedMoreThanHalf: number; matchedOrExceeded: number; unorderedTies: number;
  excludedInsufficientEvidence: number; excludedContextContracted: number; sessions: Set<string>;
}
interface MutableGroup { model: string; effort: string; bands: Map<CacheRetentionBandId, MutableBand>;
  sessions: Set<string> }

const emptyBand = (): MutableBand => ({ adjacencies: 0, reusedMoreThanHalf: 0, matchedOrExceeded: 0,
  unorderedTies: 0, excludedInsufficientEvidence: 0, excludedContextContracted: 0, sessions: new Set() });

/**
 * A day whose own reduction cannot be represented within the method's bounds.
 * Kept explicit: a bounded day is never silently truncated into an aggregate a
 * merge would then treat as complete evidence.
 *
 * `owner_source_unavailable` is deliberately NOT in this vocabulary. It is an
 * owner-scoped, transient condition, and recording it against a day would
 * exclude that owner's earliest days for good; the lane skips and retries it.
 */
export const CACHE_RETENTION_RECORDED_REFUSALS: ReadonlySet<string> = new Set([
  "group_limit_exceeded", "session_limit_exceeded", "usage_row_refused", "day_page_limit_exceeded",
]);
export type CacheRetentionRecordedRefusal = "group_limit_exceeded" | "session_limit_exceeded"
  | "usage_row_refused" | "day_page_limit_exceeded";
export class CacheRetentionRefusedError extends Error {
  readonly code = "CACHE_RETENTION_REFUSED";
  constructor(readonly reason: CacheRetentionRecordedRefusal | "owner_source_unavailable") {
    super("prepared cache retention day refused");
  }
}

/**
 * Reduce one UTC day to its per-(model, effort) band counters.
 *
 * `events` are the day's positive-input events in `(observedAtMs, orderKey)`
 * order. `carry` is the bounded cross-midnight tail: the last positive event
 * per session in the preceding `lookbackDays`, each strictly before the day
 * starts. A pair is attributed to the CURRENT event's day, which is what makes
 * the day the unit and the carry a real input rather than a convenience.
 *
 * Every event advances its session's cursor whether or not it produced a
 * comparable adjacency, so an excluded pair can never make the following pair
 * look adjacent to something older than it was.
 */
export function reduceCacheRetentionDay(input: {
  day: string; events: readonly CacheRetentionItem[]; carry: readonly CacheRetentionEvent[];
  eventsRead: number;
}): CacheRetentionDayAggregate {
  const { day, events, carry, eventsRead } = input;
  if (!validCacheRetentionDayLabel(day) || !validCount(eventsRead)
    || !Array.isArray(events) || !Array.isArray(carry)) {
    throw new TypeError("CACHE_RETENTION_INPUT_INVALID");
  }
  const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
  const dayEndMs = dayStartMs + 86_400_000;
  const previous = new Map<string, CacheRetentionEvent>();
  for (const event of carry) {
    if (!validCacheRetentionEvent(event) || event.observedAtMs >= dayStartMs
      || event.observedAtMs < dayStartMs - CACHE_RETENTION_METHOD.maximumGapMs) {
      throw new TypeError("CACHE_RETENTION_CARRY_INVALID");
    }
    const held = previous.get(event.sessionDigest);
    // The carry is the LAST event per session; a caller that supplied several
    // is reduced here rather than trusted, so the pairing cannot depend on the
    // order the lookback days happened to be read in.
    if (held === undefined || held.observedAtMs < event.observedAtMs
      || (held.observedAtMs === event.observedAtMs && held.orderKey < event.orderKey)) {
      previous.set(event.sessionDigest, event);
    }
    if (previous.size > CACHE_RETENTION_SESSION_LIMIT) {
      throw new CacheRetentionRefusedError("session_limit_exceeded");
    }
  }
  const groups = new Map<string, MutableGroup>();
  let lastOrder = "", unreadableEvents = 0;
  for (const item of events) {
    const readable = validCacheRetentionEvent(item);
    if (!readable && !validCacheRetentionSessionBreak(item)) {
      throw new TypeError("CACHE_RETENTION_EVENT_INVALID");
    }
    if (item.observedAtMs < dayStartMs || item.observedAtMs >= dayEndMs) {
      throw new TypeError("CACHE_RETENTION_EVENT_INVALID");
    }
    const order = `${String(item.observedAtMs).padStart(16, "0")}\0${item.orderKey}`;
    if (order <= lastOrder) throw new TypeError("CACHE_RETENTION_ORDER_INVALID");
    lastOrder = order;
    if (!readable) {
      // Something happened in this session that the lane cannot describe, so
      // no adjacency may span it. Dropping it instead would pair the next
      // event with an older one and overstate retention.
      unreadableEvents += 1;
      previous.delete(item.sessionDigest);
      continue;
    }
    const event = item;
    const prior = previous.get(event.sessionDigest);
    if (!previous.has(event.sessionDigest) && previous.size >= CACHE_RETENTION_SESSION_LIMIT) {
      throw new CacheRetentionRefusedError("session_limit_exceeded");
    }
    previous.set(event.sessionDigest, event);
    if (prior === undefined) continue;
    // Same configuration, or it is not an adjacency in this lens at all.
    if (prior.model !== event.model || prior.effort !== event.effort
      || prior.speedMode !== event.speedMode || prior.surface !== event.surface) continue;
    const gapMs = event.observedAtMs - prior.observedAtMs;
    const bandId = cacheRetentionBandFor(gapMs);
    if (bandId === null) continue;
    const key = cacheRetentionGroupOrder(event);
    let group = groups.get(key);
    if (group === undefined) {
      if (groups.size >= CACHE_RETENTION_GROUP_LIMIT) {
        throw new CacheRetentionRefusedError("group_limit_exceeded");
      }
      group = { model: event.model, effort: event.effort,
        bands: new Map(CACHE_RETENTION_BAND_IDS.map((id) => [id, emptyBand()])), sessions: new Set() };
      groups.set(key, group);
    }
    const band = group.bands.get(bandId)!;
    if (prior.cacheReadTokens === null || prior.cacheReadTokens === 0
      || event.cacheReadTokens === null || event.uncachedTokens === null
      || event.cacheWriteTokens === null) {
      band.excludedInsufficientEvidence += 1;
      continue;
    }
    const totalInput = event.uncachedTokens + event.cacheReadTokens + event.cacheWriteTokens;
    if (totalInput < prior.cacheReadTokens) {
      band.excludedContextContracted += 1;
      continue;
    }
    band.adjacencies += 1;
    band.sessions.add(event.sessionDigest);
    group.sessions.add(event.sessionDigest);
    if (gapMs === 0) band.unorderedTies += 1;
    if (event.cacheReadTokens
      > prior.cacheReadTokens * CACHE_RETENTION_METHOD.reusedMoreThanHalfRatio) {
      band.reusedMoreThanHalf += 1;
      if (event.cacheReadTokens >= prior.cacheReadTokens) band.matchedOrExceeded += 1;
    }
  }
  const aggregate: CacheRetentionDayAggregate = {
    methodVersion: CACHE_RETENTION_METHOD.version, day, eventsRead, unreadableEvents,
    groups: [...groups.values()].map((group) => {
      const bands = CACHE_RETENTION_BAND_IDS.map((id) => {
        const band = group.bands.get(id)!;
        return { band: id, adjacencies: band.adjacencies,
          reusedMoreThanHalf: band.reusedMoreThanHalf, matchedOrExceeded: band.matchedOrExceeded,
          unorderedTies: band.unorderedTies,
          excludedInsufficientEvidence: band.excludedInsufficientEvidence,
          excludedContextContracted: band.excludedContextContracted, sessions: band.sessions.size };
      });
      return { model: group.model, effort: group.effort,
        adjacencies: bands.reduce((total, band) => total + band.adjacencies, 0),
        sessions: group.sessions.size, bands };
    }).sort((left, right) => (cacheRetentionGroupOrder(left) < cacheRetentionGroupOrder(right) ? -1 : 1)),
  };
  if (!validCacheRetentionDayAggregate(aggregate)) throw new TypeError("CACHE_RETENTION_AGGREGATE_INVALID");
  return aggregate;
}

/** One stored band row, as the merge reads it back. */
export interface CacheRetentionBandRow extends CacheRetentionBandCounters {
  readonly ownerDigest: string;
}

/**
 * The community figure for one band: a POOLED aggregate.
 *
 * The owner's decision, and the reasoning, is recorded on
 * `CACHE_RETENTION_METHOD.merge` and in the plan document. The alternative
 * considered and rejected was the median across contributors, which exists to
 * stop the largest contributor dominating; here the subject being measured is
 * the provider's caching behaviour, so the participant holding the most
 * evidence SHOULD carry the most weight. `contributors` and
 * `topContributorShare` travel with every band precisely so a reader can see
 * when a number rests on two people, and no band is withheld for being thin.
 */
export interface CacheRetentionCommunityBand {
  readonly band: CacheRetentionBandId;
  readonly adjacencies: number;
  readonly reusedMoreThanHalf: number;
  readonly matchedOrExceeded: number;
  readonly unorderedTies: number;
  readonly excludedInsufficientEvidence: number;
  readonly excludedContextContracted: number;
  readonly sessions: number;
  readonly contributors: number;
  /** Pooled `reusedMoreThanHalf / adjacencies`, or null with no adjacency.
   * Never zero for absent evidence. */
  readonly reusedMoreThanHalfRate: number | null;
  readonly matchedOrExceededRate: number | null;
  /** The largest single contributor's share of this band's adjacencies, so the
   * concentration a pooled figure carries is visible rather than implied. */
  readonly topContributorShare: number | null;
}

export function mergeCacheRetentionBands(
  rows: readonly CacheRetentionBandRow[],
): readonly CacheRetentionCommunityBand[] {
  const byBand = new Map<CacheRetentionBandId, { totals: CacheRetentionBandCounters;
    owners: Map<string, number> }>();
  for (const id of CACHE_RETENTION_BAND_IDS) {
    byBand.set(id, { totals: { band: id, adjacencies: 0, reusedMoreThanHalf: 0, matchedOrExceeded: 0,
      unorderedTies: 0, excludedInsufficientEvidence: 0, excludedContextContracted: 0, sessions: 0 },
      owners: new Map() });
  }
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof row.ownerDigest !== "string"
      || !/^[0-9a-f]{64}$/u.test(row.ownerDigest)) throw new TypeError("CACHE_RETENTION_ROW_INVALID");
    const { ownerDigest: _owner, ...counters } = row;
    void _owner;
    if (!validCacheRetentionBandCounters(counters)) throw new TypeError("CACHE_RETENTION_ROW_INVALID");
    const bucket = byBand.get(row.band)!;
    const totals = bucket.totals as { -readonly [K in keyof CacheRetentionBandCounters]:
      CacheRetentionBandCounters[K] };
    totals.adjacencies += row.adjacencies;
    totals.reusedMoreThanHalf += row.reusedMoreThanHalf;
    totals.matchedOrExceeded += row.matchedOrExceeded;
    totals.unorderedTies += row.unorderedTies;
    totals.excludedInsufficientEvidence += row.excludedInsufficientEvidence;
    totals.excludedContextContracted += row.excludedContextContracted;
    // Sessions are distinct per (owner, day, group, band) and cannot be made
    // distinct across them without a session identifier the store does not
    // hold, so this is an upper bound and is named as a sum, not a distinct.
    totals.sessions += row.sessions;
    if (row.adjacencies > 0) {
      bucket.owners.set(row.ownerDigest, (bucket.owners.get(row.ownerDigest) ?? 0) + row.adjacencies);
    }
  }
  return CACHE_RETENTION_BAND_IDS.map((id) => {
    const { totals, owners } = byBand.get(id)!;
    const top = [...owners.values()].reduce((largest, value) => Math.max(largest, value), 0);
    return { ...totals, contributors: owners.size,
      reusedMoreThanHalfRate: totals.adjacencies === 0 ? null
        : totals.reusedMoreThanHalf / totals.adjacencies,
      matchedOrExceededRate: totals.adjacencies === 0 ? null
        : totals.matchedOrExceeded / totals.adjacencies,
      topContributorShare: totals.adjacencies === 0 ? null : top / totals.adjacencies };
  });
}

/** The published schema of the community curve. Additive changes keep this
 * string; a change to what a field MEANS must move it. */
export const CACHE_RETENTION_PUBLIC_SCHEMA_VERSION = "community-cache-retention-v1.0";

export interface PublicCacheRetentionCurve {
  readonly schemaVersion: typeof CACHE_RETENTION_PUBLIC_SCHEMA_VERSION;
  readonly metric: typeof CACHE_RETENTION_METRIC_ID;
  readonly methodVersion: string;
  /** What an adjacency IS, carried on the payload rather than left to the
   * caption, so a reader holding only the JSON cannot mistake this for the
   * local dashboard's turn-scoped figure. */
  readonly measures: "consecutive_requests";
  /** The gap is measured between the two events' observed instants, and the
   * only instant uploaded is written when a response FINISHES. So a gap is
   * end-to-end and overstates the idle pause by the later request's duration.
   * The error is proportional to response time, which is why the short bands
   * are not a usable answer to "how long may I wait" and the long ones are. */
  readonly gapBasis: "response_end_to_response_end";
  readonly bands: readonly PublicCacheRetentionBand[];
}

export interface PublicCacheRetentionBand {
  readonly band: CacheRetentionBandId;
  readonly startMs: number;
  readonly endMs: number;
  readonly adjacencies: number;
  readonly sessions: number;
  readonly contributors: number;
  /** The raw counts behind the rates. Published because a rate alone cannot be
   * checked, cannot be re-pooled against another band, and cannot be rendered
   * by anything that needs the parts to sum -- and because deriving a count by
   * multiplying a rounded rate back out invents a number. */
  readonly reusedMoreThanHalf: number;
  readonly matchedOrExceeded: number;
  readonly reusedMoreThanHalfRate: number | null;
  readonly matchedOrExceededRate: number | null;
  readonly topContributorShare: number | null;
  readonly excludedInsufficientEvidence: number;
  readonly excludedContextContracted: number;
  readonly unorderedTies: number;
}

/**
 * Project merged bands for publication.
 *
 * Nothing is withheld and nothing is rounded away: a band with two
 * contributors publishes with `contributors: 2` rather than being suppressed,
 * because `contributors` and `topContributorShare` are exactly what let a
 * reader judge it. A band with no adjacency publishes a NULL rate, never a
 * zero — no reuse and no evidence are different claims.
 *
 * The owner digests that `mergeCacheRetentionBands` folded over do not appear
 * and cannot: it returns counts and shares only.
 */
export function publicCacheRetentionCurve(
  bands: readonly CacheRetentionCommunityBand[], methodVersion: string,
): PublicCacheRetentionCurve {
  if (typeof methodVersion !== "string" || methodVersion.length === 0) {
    throw new TypeError("CACHE_RETENTION_METHOD_VERSION_INVALID");
  }
  const byId = new Map(bands.map((band) => [band.band, band]));
  return {
    schemaVersion: CACHE_RETENTION_PUBLIC_SCHEMA_VERSION,
    metric: CACHE_RETENTION_METRIC_ID,
    methodVersion,
    measures: "consecutive_requests",
    gapBasis: "response_end_to_response_end",
    // Every band, in the method's own order, whether or not it has evidence.
    // A curve that omitted its empty bands would read as a shorter curve.
    bands: CACHE_RETENTION_BANDS.map((definition) => {
      const merged = byId.get(definition.id);
      return {
        band: definition.id, startMs: definition.startMs, endMs: definition.endMs,
        adjacencies: merged?.adjacencies ?? 0, sessions: merged?.sessions ?? 0,
        contributors: merged?.contributors ?? 0,
        reusedMoreThanHalf: merged?.reusedMoreThanHalf ?? 0,
        matchedOrExceeded: merged?.matchedOrExceeded ?? 0,
        reusedMoreThanHalfRate: merged?.reusedMoreThanHalfRate ?? null,
        matchedOrExceededRate: merged?.matchedOrExceededRate ?? null,
        topContributorShare: merged?.topContributorShare ?? null,
        excludedInsufficientEvidence: merged?.excludedInsufficientEvidence ?? 0,
        excludedContextContracted: merged?.excludedContextContracted ?? 0,
        unorderedTies: merged?.unorderedTies ?? 0,
      };
    }),
  };
}
