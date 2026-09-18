import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import {
  CACHE_RETENTION_BAND_IDS,
  CACHE_RETENTION_GROUP_LIMIT,
  CACHE_RETENTION_METHOD,
  CACHE_RETENTION_RECORDED_REFUSALS,
  CacheRetentionRefusedError,
  reduceCacheRetentionDay,
  validCacheRetentionDayAggregate,
  validCacheRetentionDayLabel,
  validCacheRetentionToken,
  type CacheRetentionBandId,
  type CacheRetentionDayAggregate,
  type CacheRetentionEvent,
  type CacheRetentionItem,
  type CacheRetentionRecordedRefusal,
} from "./cache-retention-values";
import { parseStoredRecordJson } from "./stored-record";
import { loadV11SourcePin } from "./telemetry-v11-domain";
import { readTypedV11UsageAnalysisPage, TYPED_V11_ANALYSIS_PAGE_SIZE } from "./typed-v11-analysis-reader";
import { assertTypedV11GenerationSnapshotLive, loadTypedV11GenerationSnapshot,
  type V11GenerationSnapshot } from "./typed-v11-quota-reader";

/**
 * The `cache_retention_by_pause` lane: one prepared aggregate per
 * `(owner digest, UTC day, method version, model, effort)`.
 *
 * It mirrors the prepared graph-day lane in every structural respect — the day
 * manifest identity, immutable promoted rows, replaceable staged rows, bounded
 * resumable writes, recorded refusals, metered source reads and owner-digest
 * sharding — because a community figure must be a merge over per-contributor
 * rows rather than a scan of events, and those are the properties that make
 * such a merge replay-safe.
 *
 * Two things differ, and both come from the metric rather than the plumbing:
 *
 * - A day is not self-contained. A pair is attributed to the CURRENT event's
 *   day and its previous event may lie in an earlier one, so the build reads a
 *   bounded lookback tail and the day's identity carries `carryDigest`, the
 *   digest of exactly which days it depended on. The dependency is also stored
 *   row by row, so the selection can detect a late restatement (or a late
 *   first delivery) of any of those days in SQL rather than by rebuilding.
 * - A day yields several values rows, one per `(model, effort)` that produced a
 *   same-configuration adjacency, and yields none at all on a quota-only day.
 *   The day mark is therefore the unit the selection sees; without it an empty
 *   day would be re-selected every pass forever.
 */

/** Maximum lookback days the method admits, restated here as a bound rather
 * than re-derived: the build refuses to read more than this many days for one
 * prepared day whatever the method says, so a method change cannot silently
 * multiply the source cost of a pass. */
export const CACHE_RETENTION_MAX_LOOKBACK_DAYS = 7;
/** Source pages one UTC day may take, per day read. 5,000 rows per page
 * against a densest measured owner-day of about 13,600 usage rows. */
export const CACHE_RETENTION_DAY_PAGES = 64;
export const CACHE_RETENTION_MIN_WRITES = 16;
export const CACHE_RETENTION_MAX_WRITES = 64;
/** Owner buckets, and therefore the most shards that can be distinct: the two
 * leading hex characters of the owner digest give 256 uniform buckets. */
export const CACHE_RETENTION_MAX_SHARDS = 256;

const HASH = /^[a-f0-9]{64}$/u;
const fail = (): Error => new Error("CACHE_RETENTION_UNAVAILABLE");
function bounded(value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail();
}

/**
 * The durable identity of one prepared day, minus the method version and the
 * carry digest which every key derivation adds.
 *
 * The day manifest identity is the owner's per-day input revision, so a
 * re-upload that restates one day changes that day's `manifestDigest` and
 * therefore only that day's keys.
 */
export interface CacheRetentionDayKey {
  sourceId: string;
  sourceLayout: "typed-v11";
  sourceNamespace: string;
  ownerDigest: string;
  deviceId: string;
  manifestId: string;
  manifestDigest: string;
  day: string;
}
const KEY_FIELDS = ["sourceId", "sourceLayout", "sourceNamespace", "ownerDigest", "deviceId",
  "manifestId", "manifestDigest", "day"] as const;

function checkKey(key: CacheRetentionDayKey): void {
  if (!key || typeof key !== "object"
    || Object.keys(key).sort().join(",") !== [...KEY_FIELDS].sort().join(",")
    || typeof key.sourceId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(key.sourceId)
    || !HASH.test(key.ownerDigest) || !HASH.test(key.manifestDigest)
    || key.sourceLayout !== "typed-v11"
    || typeof key.sourceNamespace !== "string" || key.sourceNamespace.length < 1
    || key.sourceNamespace.length > 256
    || typeof key.deviceId !== "string" || key.deviceId.length < 1 || key.deviceId.length > 256
    || typeof key.manifestId !== "string" || key.manifestId.length < 1 || key.manifestId.length > 256
    || !validCacheRetentionDayLabel(key.day)) throw fail();
}

/** One recorded lookback dependency: the delivered manifest digest for that
 * calendar day, or the empty string when nothing was delivered for it. An
 * absent day is recorded rather than omitted, so a day delivered LATER changes
 * the carry exactly as a restated one does. */
export interface CacheRetentionCarryDay {
  readonly day: string;
  readonly manifestDigest: string;
}

function checkCarry(key: CacheRetentionDayKey, carry: readonly CacheRetentionCarryDay[]): void {
  if (!Array.isArray(carry) || carry.length !== CACHE_RETENTION_METHOD.lookbackDays
    || carry.length > CACHE_RETENTION_MAX_LOOKBACK_DAYS) throw fail();
  const dayStartMs = Date.parse(`${key.day}T00:00:00.000Z`);
  for (let index = 0; index < carry.length; index += 1) {
    const entry = carry[index]!;
    if (!entry || typeof entry !== "object"
      || Object.keys(entry).sort().join(",") !== "day,manifestDigest"
      || !validCacheRetentionDayLabel(entry.day)
      || (entry.manifestDigest !== "" && !HASH.test(entry.manifestDigest))) throw fail();
    // Oldest first, contiguous, and every day strictly before the prepared one.
    const expected = new Date(dayStartMs - (carry.length - index) * 86_400_000)
      .toISOString().slice(0, 10);
    if (entry.day !== expected) throw fail();
  }
}

/** The calendar days one prepared day depends on, oldest first. */
export function cacheRetentionLookbackDays(day: string): readonly string[] {
  if (!validCacheRetentionDayLabel(day)) throw fail();
  const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
  const days: string[] = [];
  for (let back = CACHE_RETENTION_METHOD.lookbackDays; back >= 1; back -= 1) {
    days.push(new Date(dayStartMs - back * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

export const CACHE_RETENTION_CARRY_METHOD = "cache-retention-carry-v1";
/** The digest of the bounded lookback tail's INPUT identity — which days, and
 * which delivered revision of each. It is part of every row's key, so a
 * restatement of any contributing day retires the dependent day rather than
 * leaving it silently computed from withdrawn evidence. */
export async function cacheRetentionCarryDigest(
  carry: readonly CacheRetentionCarryDay[],
): Promise<string> {
  if (!Array.isArray(carry) || carry.length > CACHE_RETENTION_MAX_LOOKBACK_DAYS) throw fail();
  return sha256Hex(canonicalJson({ method: CACHE_RETENTION_CARRY_METHOD,
    lookbackDays: CACHE_RETENTION_METHOD.lookbackDays,
    days: carry.map((entry) => [entry.day, entry.manifestDigest]) }));
}

/** The content-addressed day identity. It covers the day manifest identity, the
 * method version and the carry digest and nothing else: those are exactly the
 * inputs whose change must invalidate a prepared day. */
export async function cacheRetentionDayMarkKey(key: CacheRetentionDayKey,
  carryDigest: string): Promise<string> {
  checkKey(key);
  if (!HASH.test(carryDigest)) throw fail();
  return sha256Hex(canonicalJson({
    ...Object.fromEntries(KEY_FIELDS.map((field) => [field, key[field]])),
    methodVersion: CACHE_RETENTION_METHOD.version, carryDigest }));
}

/** The content-addressed values-row identity: the day identity plus the two
 * dimensions the row is cut by. `methodVersion` is in it because a definition
 * change must not be servable beside rows computed the old way. */
export async function cacheRetentionDayValueKey(key: CacheRetentionDayKey, carryDigest: string,
  model: string, effort: string): Promise<string> {
  checkKey(key);
  if (!HASH.test(carryDigest) || !validCacheRetentionToken(model)
    || !validCacheRetentionToken(effort)) throw fail();
  return sha256Hex(canonicalJson({
    ...Object.fromEntries(KEY_FIELDS.map((field) => [field, key[field]])),
    methodVersion: CACHE_RETENTION_METHOD.version, carryDigest, model, effort }));
}

/** Read the lookback dependency from the delivered-day table. One statement.
 * A day with several delivered manifests (a restatement whose predecessor has
 * not been retired yet) resolves to the lexicographically greatest digest, so
 * the dependency is a deterministic function of what is delivered rather than
 * of read order. */
export async function readCacheRetentionCarryDays(target: D1Database,
  key: CacheRetentionDayKey): Promise<readonly CacheRetentionCarryDay[]> {
  checkKey(key);
  const days = cacheRetentionLookbackDays(key.day);
  const rows = (await target.prepare(`SELECT day,MAX(manifest_digest) AS manifest_digest
    FROM analytics_v11_reusable_values
    WHERE source_id=?1 AND owner_digest=?2 AND device_id=?3 AND day>=?4 AND day<?5
      AND source_layout='typed-v11' AND source_namespace=?6
    GROUP BY day`)
    .bind(key.sourceId, key.ownerDigest, key.deviceId, days[0]!, key.day, key.sourceNamespace)
    .all<{ day: string; manifest_digest: string }>()).results;
  const delivered = new Map(rows.map((row) => [row.day, row.manifest_digest]));
  const carry = days.map((day) => ({ day, manifestDigest: delivered.get(day) ?? "" }));
  checkCarry(key, carry);
  return carry;
}

export interface CacheRetentionDayWriteCursor {
  markKey: string;
  digest: string;
  /** Value keys already staged with this frame's band digests. */
  present: string[];
}
export type CacheRetentionDayWrite =
  | { status: "stored"; markKey: string; valueCount: number }
  | { status: "staging"; markKey: string; storedValues: number; totalValues: number;
      cursor: CacheRetentionDayWriteCursor };

interface Framed {
  markKey: string;
  valuesDigest: string;
  groups: Array<{ valueKey: string; model: string; effort: string; adjacencies: number;
    sessions: number; bandsDigest: string;
    bands: Array<{ band: CacheRetentionBandId; counters: readonly number[] }> }>;
}

const BAND_COLUMNS = ["adjacencies", "reusedMoreThanHalf", "matchedOrExceeded", "unorderedTies",
  "excludedInsufficientEvidence", "excludedContextContracted", "sessions"] as const;

async function frame(key: CacheRetentionDayKey, carryDigest: string,
  aggregate: CacheRetentionDayAggregate): Promise<Framed> {
  if (!validCacheRetentionDayAggregate(aggregate) || aggregate.day !== key.day) throw fail();
  const markKey = await cacheRetentionDayMarkKey(key, carryDigest);
  const groups: Framed["groups"] = [];
  for (const group of aggregate.groups) {
    const bands = group.bands.map((band) => ({ band: band.band,
      counters: BAND_COLUMNS.map((column) => band[column]) }));
    groups.push({ valueKey: await cacheRetentionDayValueKey(key, carryDigest, group.model, group.effort),
      model: group.model, effort: group.effort, adjacencies: group.adjacencies,
      sessions: group.sessions, bandsDigest: await sha256Hex(canonicalJson(bands)), bands });
  }
  return { markKey, valuesDigest: await sha256Hex(canonicalJson(aggregate)), groups };
}
// Framing hashes every group. One invocation stages the same immutable aggregate
// across several bounded writes, so the frame is memoized per object -- but the
// frame is a function of the KEY and the carry digest as well, so the memo
// records which mark it was built for and re-frames rather than returning a
// frame belonging to a different day.
const frames = new WeakMap<object, { markKey: string; frame: Framed }>();
async function framed(key: CacheRetentionDayKey, carryDigest: string,
  aggregate: CacheRetentionDayAggregate): Promise<Framed> {
  const markKey = await cacheRetentionDayMarkKey(key, carryDigest);
  const cached = frames.get(aggregate);
  if (cached && cached.markKey === markKey) return cached.frame;
  const built = await frame(key, carryDigest, aggregate);
  if (built.markKey !== markKey) throw fail();
  frames.set(aggregate, { markKey, frame: built });
  return built;
}

/**
 * Write one prepared day, in bounded batches.
 *
 * Replay is free: the mark key is the day's identity and the mark row is
 * immutable, so re-writing the same aggregate stores nothing new, and a rebuild
 * that produced DIFFERENT bytes under the same identity is a refusal rather
 * than a silent overwrite. Resumption is durable without a cursor table: a day
 * that was only partly written has band and values rows but no mark, so the
 * next pass re-frames the same immutable aggregate and continues.
 */
export async function writeCacheRetentionDay(input: { target: D1Database; key: CacheRetentionDayKey;
  carry: readonly CacheRetentionCarryDay[]; aggregate: CacheRetentionDayAggregate;
  maxWrites?: number; cursor?: CacheRetentionDayWriteCursor;
}): Promise<CacheRetentionDayWrite> {
  const { target, aggregate } = input, key = { ...input.key };
  checkKey(key);
  checkCarry(key, input.carry);
  const max = input.maxWrites ?? CACHE_RETENTION_MAX_WRITES;
  bounded(max, CACHE_RETENTION_MIN_WRITES, CACHE_RETENTION_MAX_WRITES);
  const carryDigest = await cacheRetentionCarryDigest(input.carry);
  const f = await framed(key, carryDigest, aggregate);
  if (f.groups.length > CACHE_RETENTION_GROUP_LIMIT) throw fail();
  const present = new Set<string>();
  if (input.cursor) {
    const cursor = input.cursor;
    const known = new Set(f.groups.map((group) => group.valueKey));
    if (cursor.markKey !== f.markKey || cursor.digest !== f.valuesDigest
      || !Array.isArray(cursor.present)
      || cursor.present.some((valueKey) => !known.has(valueKey))) throw fail();
    for (const valueKey of cursor.present) present.add(valueKey);
  } else {
    const row = await target.prepare(`SELECT values_digest,value_count,events_read,refusal
      FROM analytics_cache_retention_day_marks WHERE mark_key=?`).bind(f.markKey)
      .first<{ values_digest: string; value_count: number; events_read: number; refusal: string | null }>();
    if (row) {
      if (row.values_digest !== f.valuesDigest || row.value_count !== f.groups.length
        || row.events_read !== aggregate.eventsRead || row.refusal !== null) throw fail();
      return { status: "stored", markKey: f.markKey, valueCount: f.groups.length };
    }
    const staged = (await target.prepare(`SELECT value_key,bands_digest
      FROM analytics_cache_retention_day_values WHERE mark_key=? LIMIT ?`)
      .bind(f.markKey, CACHE_RETENTION_GROUP_LIMIT + 1)
      .all<{ value_key: string; bands_digest: string }>()).results;
    if (staged.length > CACHE_RETENTION_GROUP_LIMIT) throw fail();
    // A staged row whose band digest disagrees with this frame is left to be
    // replaced: no mark authorizes it yet, so it is not evidence.
    const digests = new Map(f.groups.map((group) => [group.valueKey, group.bandsDigest]));
    for (const row of staged) {
      if (digests.get(row.value_key) === row.bands_digest) present.add(row.value_key);
    }
  }
  const statements: D1PreparedStatement[] = [];
  // The lookback dependency is restated on every attempt. It is seven idempotent
  // upserts, paid only while the day is unfinished, and it removes a read that
  // would otherwise have to precede every batch.
  for (const entry of input.carry) {
    statements.push(target.prepare(`INSERT INTO analytics_cache_retention_day_carry
      (mark_key,day,source_id,owner_digest,device_id,manifest_digest) VALUES(?,?,?,?,?,?)
      ON CONFLICT(mark_key,day) DO UPDATE SET manifest_digest=excluded.manifest_digest
       WHERE analytics_cache_retention_day_carry.manifest_digest IS NOT excluded.manifest_digest`)
      .bind(f.markKey, entry.day, key.sourceId, key.ownerDigest, key.deviceId, entry.manifestDigest));
  }
  const missing = f.groups.filter((group) => !present.has(group.valueKey));
  // Each group costs its seven bands plus its values row, and the mark costs
  // one more. A group is never split across batches: a values row whose bands
  // are in a previous batch would be admitted by the completeness trigger
  // before the batch that carries it could fail, which is the one ordering the
  // trigger cannot protect against.
  const room = Math.max(0, max - statements.length - 1);
  const page = missing.slice(0, Math.floor(room / (CACHE_RETENTION_BAND_IDS.length + 1)));
  for (const group of page) {
    for (const band of group.bands) {
      statements.push(target.prepare(`INSERT INTO analytics_cache_retention_day_bands
        (value_key,band,source_id,owner_digest,day,method_version,adjacencies,reused_more_than_half,
         matched_or_exceeded,unordered_ties,excluded_insufficient_evidence,
         excluded_context_contracted,sessions)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(value_key,band) DO UPDATE SET adjacencies=excluded.adjacencies,
         reused_more_than_half=excluded.reused_more_than_half,
         matched_or_exceeded=excluded.matched_or_exceeded,unordered_ties=excluded.unordered_ties,
         excluded_insufficient_evidence=excluded.excluded_insufficient_evidence,
         excluded_context_contracted=excluded.excluded_context_contracted,sessions=excluded.sessions`)
        .bind(group.valueKey, band.band, key.sourceId, key.ownerDigest, key.day,
          CACHE_RETENTION_METHOD.version, ...band.counters));
    }
    statements.push(target.prepare(`INSERT INTO analytics_cache_retention_day_values
      (value_key,mark_key,source_id,owner_digest,day,method_version,carry_digest,model,effort,
       adjacencies,sessions,bands_digest)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(value_key) DO NOTHING`)
      .bind(group.valueKey, f.markKey, key.sourceId, key.ownerDigest, key.day,
        CACHE_RETENTION_METHOD.version, carryDigest, group.model, group.effort,
        group.adjacencies, group.sessions, group.bandsDigest));
  }
  const complete = page.length === missing.length;
  if (complete) {
    statements.push(markStatement(target, key, f, carryDigest, aggregate, null));
  }
  if (statements.length) await target.batch(statements);
  if (!complete) {
    return { status: "staging", markKey: f.markKey, storedValues: present.size + page.length,
      totalValues: f.groups.length,
      cursor: { markKey: f.markKey, digest: f.valuesDigest,
        present: [...present, ...page.map((group) => group.valueKey)] } };
  }
  const stored = await target.prepare(
    "SELECT values_digest FROM analytics_cache_retention_day_marks WHERE mark_key=?")
    .bind(f.markKey).first<string>("values_digest");
  if (stored !== f.valuesDigest) throw fail();
  return { status: "stored", markKey: f.markKey, valueCount: f.groups.length };
}

function markStatement(target: D1Database, key: CacheRetentionDayKey, f: Framed, carryDigest: string,
  aggregate: CacheRetentionDayAggregate | null, refusal: CacheRetentionRecordedRefusal | null,
): D1PreparedStatement {
  return target.prepare(`INSERT INTO analytics_cache_retention_day_marks
    (mark_key,source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,
     manifest_digest,day,method_version,carry_digest,carry_days,value_count,events_read,
     unreadable_events,values_digest,refusal)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(mark_key) DO NOTHING`)
    .bind(f.markKey, key.sourceId, key.sourceLayout, key.sourceNamespace, key.ownerDigest,
      key.deviceId, key.manifestId, key.manifestDigest, key.day, CACHE_RETENTION_METHOD.version,
      carryDigest, CACHE_RETENTION_METHOD.lookbackDays, f.groups.length,
      aggregate?.eventsRead ?? 0, aggregate?.unreadableEvents ?? 0, f.valuesDigest, refusal);
}

/**
 * Record a day the build refused, under the same identity a successful day
 * would have taken. The carry rows are written with it so the selection's
 * staleness check retries the day when any contributing day is restated, and
 * so the completeness trigger can see the dependency it claims.
 */
export async function writeCacheRetentionDayRefusal(input: { target: D1Database;
  key: CacheRetentionDayKey; carry: readonly CacheRetentionCarryDay[];
  reason: CacheRetentionRecordedRefusal;
}): Promise<{ markKey: string }> {
  const { target, reason } = input, key = { ...input.key };
  checkKey(key);
  checkCarry(key, input.carry);
  if (!CACHE_RETENTION_RECORDED_REFUSALS.has(reason)) throw fail();
  const carryDigest = await cacheRetentionCarryDigest(input.carry);
  const markKey = await cacheRetentionDayMarkKey(key, carryDigest);
  const empty: Framed = { markKey, groups: [],
    valuesDigest: await sha256Hex(canonicalJson({ methodVersion: CACHE_RETENTION_METHOD.version,
      day: key.day, refusal: reason })) };
  const statements = input.carry.map((entry) => target.prepare(
    `INSERT INTO analytics_cache_retention_day_carry
      (mark_key,day,source_id,owner_digest,device_id,manifest_digest) VALUES(?,?,?,?,?,?)
      ON CONFLICT(mark_key,day) DO UPDATE SET manifest_digest=excluded.manifest_digest
       WHERE analytics_cache_retention_day_carry.manifest_digest IS NOT excluded.manifest_digest`)
    .bind(markKey, entry.day, key.sourceId, key.ownerDigest, key.deviceId, entry.manifestDigest));
  statements.push(markStatement(target, key, empty, carryDigest, null, reason));
  await target.batch(statements);
  return { markKey };
}

export type CacheRetentionDayRead =
  | { status: "absent" }
  | { status: "refused"; markKey: string; reason: string }
  | { status: "ready"; markKey: string; aggregate: CacheRetentionDayAggregate };

/** Read one prepared day back. Every band row is re-checked against the stored
 * band digest and the reassembled aggregate must match the promoted
 * `values_digest`, so a torn or tampered row can never decode. */
export async function readCacheRetentionDay(input: { target: D1Database; key: CacheRetentionDayKey;
  carry: readonly CacheRetentionCarryDay[];
}): Promise<CacheRetentionDayRead> {
  const { target } = input, key = { ...input.key };
  checkKey(key);
  checkCarry(key, input.carry);
  const carryDigest = await cacheRetentionCarryDigest(input.carry);
  const markKey = await cacheRetentionDayMarkKey(key, carryDigest);
  const mark = await target.prepare(`SELECT value_count,events_read,unreadable_events,values_digest,refusal
    FROM analytics_cache_retention_day_marks WHERE mark_key=?`).bind(markKey)
    .first<{ value_count: number; events_read: number; unreadable_events: number;
      values_digest: string; refusal: string | null }>();
  if (!mark) return { status: "absent" };
  if (mark.refusal !== null) return { status: "refused", markKey, reason: mark.refusal };
  const values = (await target.prepare(`SELECT value_key,model,effort,adjacencies,sessions,bands_digest
    FROM analytics_cache_retention_day_values WHERE mark_key=? ORDER BY model,effort LIMIT ?`)
    .bind(markKey, CACHE_RETENTION_GROUP_LIMIT + 1)
    .all<{ value_key: string; model: string; effort: string; adjacencies: number; sessions: number;
      bands_digest: string }>()).results;
  if (values.length !== mark.value_count || values.length > CACHE_RETENTION_GROUP_LIMIT) throw fail();
  const groups: Array<CacheRetentionDayAggregate["groups"][number]> = [];
  for (const value of values) {
    const rows = (await target.prepare(`SELECT band,adjacencies,reused_more_than_half,
        matched_or_exceeded,unordered_ties,excluded_insufficient_evidence,
        excluded_context_contracted,sessions
      FROM analytics_cache_retention_day_bands WHERE value_key=? LIMIT 8`).bind(value.value_key)
      .all<Record<string, string | number>>()).results;
    if (rows.length !== CACHE_RETENTION_BAND_IDS.length) throw fail();
    const byBand = new Map(rows.map((row) => [String(row.band), row]));
    const bands = CACHE_RETENTION_BAND_IDS.map((band) => {
      const row = byBand.get(band);
      if (!row) throw fail();
      return { band, adjacencies: Number(row.adjacencies),
        reusedMoreThanHalf: Number(row.reused_more_than_half),
        matchedOrExceeded: Number(row.matched_or_exceeded),
        unorderedTies: Number(row.unordered_ties),
        excludedInsufficientEvidence: Number(row.excluded_insufficient_evidence),
        excludedContextContracted: Number(row.excluded_context_contracted),
        sessions: Number(row.sessions) };
    });
    if (await sha256Hex(canonicalJson(bands.map((band) => ({ band: band.band,
      counters: BAND_COLUMNS.map((column) => band[column]) })))) !== value.bands_digest) throw fail();
    groups.push({ model: value.model, effort: value.effort, adjacencies: value.adjacencies,
      sessions: value.sessions, bands });
  }
  const aggregate: CacheRetentionDayAggregate = { methodVersion: CACHE_RETENTION_METHOD.version,
    day: key.day, eventsRead: mark.events_read, unreadableEvents: mark.unreadable_events, groups };
  if (!validCacheRetentionDayAggregate(aggregate)
    || await sha256Hex(canonicalJson(aggregate)) !== mark.values_digest) throw fail();
  return { status: "ready", markKey, aggregate };
}

/**
 * One bounded retirement page. Three independent reasons, all keyed to this
 * source only: a row whose `method_version` is not the current contract, a row
 * for an owner with a terminal erasure fence, and a row whose day manifest
 * identity no longer matches any delivered day. Children are deleted after the
 * row that authorized them, so an interrupted retirement resumes from the
 * orphans rather than leaving a mark pointing at a partly deleted aggregate.
 */
export async function retireCacheRetentionDayPage(target: D1Database, sourceId: string,
  options: { limit?: number; methodVersion?: string } = {},
): Promise<{ state: "idle" | "retiring"; marks: number; carry: number; values: number; bands: number }> {
  const limit = options.limit ?? 32;
  bounded(limit, 1, 200);
  const version = options.methodVersion ?? CACHE_RETENTION_METHOD.version;
  if (typeof version !== "string" || version.length < 1 || version.length > 128) throw fail();
  const marks = (await target.prepare(`DELETE FROM analytics_cache_retention_day_marks
    WHERE mark_key IN (SELECT m.mark_key FROM analytics_cache_retention_day_marks m
      WHERE m.source_id=?1 AND (m.method_version!=?2
        OR EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
          WHERE f.source_id=m.source_id AND f.owner_digest=m.owner_digest)
        OR NOT EXISTS(SELECT 1 FROM analytics_v11_reusable_values v
          WHERE v.source_id=m.source_id AND v.source_layout=m.source_layout
            AND v.source_namespace=m.source_namespace AND v.owner_digest=m.owner_digest
            AND v.device_id=m.device_id AND v.manifest_id=m.manifest_id
            AND v.manifest_digest=m.manifest_digest AND v.day=m.day))
      ORDER BY m.owner_digest,m.day,m.mark_key LIMIT ?3) RETURNING mark_key`)
    .bind(sourceId, version, limit).all()).results.length;
  const values = (await target.prepare(`DELETE FROM analytics_cache_retention_day_values
    WHERE value_key IN (SELECT v.value_key FROM analytics_cache_retention_day_values v
      WHERE v.source_id=?1 AND NOT EXISTS(SELECT 1 FROM analytics_cache_retention_day_marks m
        WHERE m.mark_key=v.mark_key)
      ORDER BY v.value_key LIMIT ?2) RETURNING value_key`)
    .bind(sourceId, limit).all()).results.length;
  const bands = (await target.prepare(`DELETE FROM analytics_cache_retention_day_bands
    WHERE (value_key,band) IN (SELECT b.value_key,b.band FROM analytics_cache_retention_day_bands b
      WHERE b.source_id=?1 AND NOT EXISTS(SELECT 1 FROM analytics_cache_retention_day_values v
        WHERE v.value_key=b.value_key)
      ORDER BY b.value_key,b.band LIMIT ?2) RETURNING band`)
    .bind(sourceId, limit).all()).results.length;
  const carry = (await target.prepare(`DELETE FROM analytics_cache_retention_day_carry
    WHERE (mark_key,day) IN (SELECT c.mark_key,c.day FROM analytics_cache_retention_day_carry c
      WHERE c.source_id=?1 AND NOT EXISTS(SELECT 1 FROM analytics_cache_retention_day_marks m
        WHERE m.mark_key=c.mark_key)
      ORDER BY c.mark_key,c.day LIMIT ?2) RETURNING day`)
    .bind(sourceId, limit).all()).results.length;
  return { state: marks + carry + values + bands > 0 ? "retiring" : "idle",
    marks, carry, values, bands };
}

/**
 * The opaque session key the reduction pairs on.
 *
 * A raw `sessionUuid` is session content and must never reach a derived
 * artifact, so the reduction only ever sees this digest and compares it for
 * equality. Owner-scoped, following the prepared graph day's own derivation, so
 * one uuid under two owners cannot collide. Only its cardinality is stored.
 */
export const CACHE_RETENTION_SESSION_DIGEST_METHOD = "cache-retention-session-v1";
export async function cacheRetentionSessionDigest(input: { ownerDigest: string; provider: string;
  sessionUuid: string }): Promise<string> {
  if (!HASH.test(input.ownerDigest) || typeof input.provider !== "string"
    || typeof input.sessionUuid !== "string" || input.sessionUuid.length === 0) throw fail();
  return sha256Hex(canonicalJson({ method: CACHE_RETENTION_SESSION_DIGEST_METHOD, kind: "session",
    ownerDigest: input.ownerDigest, value: [input.provider, input.sessionUuid] }));
}

/** The lane's own deadline and the source statements this pass may still spend
 * building. Several days share one pass allowance. */
export interface CacheRetentionBuildBudget {
  readonly deadlineMs: number;
  remainingQueries: number;
}
/** The build ran out of the pass's source allowance or reached its deadline.
 * Distinct from a refusal: the day is representable, it simply did not fit this
 * pass, and nothing was written. */
export class CacheRetentionDeferredError extends Error {
  readonly code = "CACHE_RETENTION_DEFERRED";
  constructor(readonly reason: "deadline" | "query_budget") { super("prepared cache retention day deferred"); }
}
function spend(budget: CacheRetentionBuildBudget, now: () => number): void {
  if (now() >= budget.deadlineMs) throw new CacheRetentionDeferredError("deadline");
  if (budget.remainingQueries < 1) throw new CacheRetentionDeferredError("query_budget");
  budget.remainingQueries -= 1;
}

const TOKENS = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1e12
    ? value as number : null;
};

/** Map one stored usage record to the lens's own event, or report that it
 * cannot be read. Only allowlisted fields are consulted and none is coerced: an
 * absent token component stays `null`, and an absent or malformed configuration
 * token makes the row unreadable rather than a guess. */
export function cacheRetentionEventFromRecord(input: { sessionDigest: string; observedAtMs: number;
  orderKey: string; recordJson: string }): CacheRetentionItem | null {
  const record = parseStoredRecordJson(input.recordJson) as Record<string, unknown> | null;
  const unreadable: CacheRetentionItem = { sessionDigest: input.sessionDigest,
    observedAtMs: input.observedAtMs, orderKey: input.orderKey, unreadable: true };
  if (!record || record.schemaVersion !== "usage-event-v1.1") return unreadable;
  const components = record.components;
  if (!components || typeof components !== "object" || Array.isArray(components)) return unreadable;
  const { modelId, reasoningEffort, speedMode, surface } = record;
  if (!validCacheRetentionToken(modelId) || !validCacheRetentionToken(reasoningEffort)
    || !validCacheRetentionToken(speedMode) || !validCacheRetentionToken(surface)) return unreadable;
  const parts = components as Record<string, unknown>;
  const cacheReadTokens = TOKENS(parts.inputCacheReadTokens);
  const uncachedTokens = TOKENS(parts.inputUncachedTokens);
  const cacheWriteTokens = TOKENS(parts.inputCacheWriteTokens);
  // The population filter, exactly as the local lens states it: positive-input
  // requests only, so a quota-only or bookkeeping row can never consume an
  // adjacency boundary. A row outside the population is not in the session's
  // sequence at all, which is why it is dropped rather than made a break.
  if ((cacheReadTokens ?? 0) + (uncachedTokens ?? 0) + (cacheWriteTokens ?? 0) <= 0) return null;
  return { sessionDigest: input.sessionDigest, observedAtMs: input.observedAtMs,
    orderKey: input.orderKey, model: modelId, effort: reasoningEffort, speedMode, surface,
    cacheReadTokens, uncachedTokens, cacheWriteTokens };
}

/** One UTC day of mapped events. The seam stays open so a test can drive the
 * store and the reduction without a source database. */
export interface CacheRetentionDaySource {
  readonly items: readonly CacheRetentionItem[];
  readonly rowsRead: number;
}
export type CacheRetentionDayReader = (input: { day: string; sessions: ReadonlySet<string> | null;
  budget: CacheRetentionBuildBudget; now: () => number }) => Promise<CacheRetentionDaySource>;

/**
 * The production day reader: one UTC day of v1.1 usage rows, paged through
 * `readTypedV11UsageAnalysisPage` with `cacheRetentionSessionDigest` as the
 * session hook, so no raw `sessionUuid` crosses this boundary.
 *
 * `sessions` narrows a LOOKBACK read to the sessions the prepared day actually
 * contains; the day's own read passes null. It changes what is retained in
 * memory, never what is read or how a pair is decided.
 */
export function createCacheRetentionDayReader(options: {
  source: D1Database; sourceNamespace: string; snapshot: V11GenerationSnapshot;
  ownerDigest: string; maxPages?: number;
}): CacheRetentionDayReader {
  const maxPages = options.maxPages ?? CACHE_RETENTION_DAY_PAGES;
  bounded(maxPages, 1, 1_024);
  if (!HASH.test(options.ownerDigest)
    || options.snapshot.sourceNamespace !== options.sourceNamespace) throw fail();
  return async ({ day, sessions, budget, now }) => {
    if (!validCacheRetentionDayLabel(day)) throw fail();
    if (day < options.snapshot.fromDay || day > options.snapshot.throughDay) {
      return { items: [], rowsRead: 0 };
    }
    const fromMs = Date.parse(`${day}T00:00:00.000Z`);
    const items: CacheRetentionItem[] = [];
    const seen = new Set<string>();
    let rowsRead = 0, afterTime = new Date(fromMs).toISOString(), afterOccurrence = "";
    for (let page = 0; page < maxPages; page += 1) {
      spend(budget, now);
      const rows = await readTypedV11UsageAnalysisPage(options.source, {
        sourceNamespace: options.sourceNamespace, snapshot: options.snapshot, day,
        from: new Date(fromMs).toISOString(), to: new Date(fromMs + 86_400_000).toISOString(),
        afterTime, afterOccurrence, fenceSnapshot: false });
      for (const row of rows) {
        // Counted before the mapper, so a skipped row still counts against the
        // same bound the streaming path metered it against.
        rowsRead += 1;
        afterTime = row.observed_at;
        afterOccurrence = row.occurrence_id;
        // The raw layer restates rows; `(owner, occurrence)` is the event
        // identity and the collapse is lossless, so a repeat is a duplicate
        // rather than a second event. Deduplicating here keeps the day's
        // sequence replay-safe whatever the scope returns.
        if (seen.has(row.occurrence_id)) continue;
        seen.add(row.occurrence_id);
        if (seen.size > TYPED_V11_ANALYSIS_PAGE_SIZE * maxPages) {
          throw new CacheRetentionRefusedError("day_page_limit_exceeded");
        }
        if (row.session_uuid === null) continue;
        const sessionDigest = await cacheRetentionSessionDigest({ ownerDigest: options.ownerDigest,
          provider: row.provider, sessionUuid: row.session_uuid });
        if (sessions !== null && !sessions.has(sessionDigest)) continue;
        const observedAtMs = Date.parse(row.observed_at);
        if (!Number.isSafeInteger(observedAtMs)) throw new CacheRetentionRefusedError("usage_row_refused");
        const item = cacheRetentionEventFromRecord({ sessionDigest, observedAtMs,
          orderKey: row.occurrence_id, recordJson: row.record_json });
        if (item !== null) items.push(item);
      }
      if (rows.length < TYPED_V11_ANALYSIS_PAGE_SIZE) {
        spend(budget, now);
        await assertTypedV11GenerationSnapshotLive(options.source, options.snapshot);
        return { items, rowsRead };
      }
    }
    // A day that needs more pages than the bound is refused, never truncated
    // into an aggregate a merge would read as a complete day.
    throw new CacheRetentionRefusedError("day_page_limit_exceeded");
  };
}

/** One candidate day. */
export interface CacheRetentionDayCandidate extends CacheRetentionDayKey {}
export type CacheRetentionDayBuild = (candidate: CacheRetentionDayCandidate,
  carry: readonly CacheRetentionCarryDay[],
  budget: CacheRetentionBuildBudget) => Promise<CacheRetentionDayAggregate>;

/**
 * The production day builder.
 *
 * The day's own events are read first. When it has none, the lookback is not
 * read at all — there is nothing for a carry to pair with — but the day's
 * recorded carry dependency is unchanged, because it is derived from what was
 * DELIVERED rather than from what was read. The identity of an empty day is
 * therefore the same whichever path produced it.
 */
export function createCacheRetentionDayBuild(options: {
  source: D1Database; sourceNamespace: string; snapshot: V11GenerationSnapshot;
  ownerDigest: string; now?: () => number;
  /** Test seam only: production derives the reader from the source. */
  read?: CacheRetentionDayReader;
}): CacheRetentionDayBuild {
  const read = options.read ?? createCacheRetentionDayReader({ source: options.source,
    sourceNamespace: options.sourceNamespace, snapshot: options.snapshot,
    ownerDigest: options.ownerDigest });
  const now = options.now ?? Date.now;
  return async (candidate, carry, budget) => {
    checkKey(candidate);
    checkCarry(candidate, carry);
    if (candidate.sourceNamespace !== options.sourceNamespace || !Number.isFinite(budget.deadlineMs)
      || !Number.isSafeInteger(budget.remainingQueries)) throw fail();
    const own = await read({ day: candidate.day, sessions: null, budget, now });
    const sessions = new Set(own.items.map((item) => item.sessionDigest));
    const tail = new Map<string, CacheRetentionEvent>();
    if (sessions.size > 0) {
      // Oldest first, so the map ends holding each session's LAST readable
      // event; an unreadable row clears the session's carry for the same
      // reason it breaks a chain inside a day.
      for (const day of cacheRetentionLookbackDays(candidate.day)) {
        const lookback = await read({ day, sessions, budget, now });
        for (const item of lookback.items) {
          if ("unreadable" in item) tail.delete(item.sessionDigest);
          else tail.set(item.sessionDigest, item);
        }
      }
    }
    return reduceCacheRetentionDay({ day: candidate.day, events: own.items,
      carry: [...tail.values()], eventsRead: own.rowsRead });
  };
}

/**
 * The production build for a WHOLE source, resolving each candidate owner's
 * generation snapshot itself.
 *
 * Analytics never holds a participant identifier, so the owner digest is
 * bridged back through `storage_v11_owner_links` in the source database — the
 * same mapping owner erasure uses. Resolution is memoized per pass. An owner
 * whose link, pin or snapshot is absent is skipped rather than guessed at.
 */
export function createCacheRetentionDaySourceBuild(options: {
  source: D1Database; sourceNamespace: string; now?: () => number;
}): CacheRetentionDayBuild {
  const resolved = new Map<string, CacheRetentionDayBuild | null>();
  const now = options.now ?? Date.now;
  return async (candidate, carry, budget) => {
    checkKey(candidate);
    if (candidate.sourceNamespace !== options.sourceNamespace) throw fail();
    let build = resolved.get(candidate.ownerDigest);
    if (build === undefined) {
      build = null;
      spend(budget, now);
      const link = await options.source
        .prepare("SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=?")
        .bind(candidate.ownerDigest).first<string>("participant_id");
      if (link) {
        spend(budget, now);
        const pin = await loadV11SourcePin(options.source, link);
        if (pin && pin.source === "v1.1") {
          spend(budget, now);
          spend(budget, now);
          const snapshot = await loadTypedV11GenerationSnapshot(options.source,
            { sourceNamespace: options.sourceNamespace, pin });
          build = createCacheRetentionDayBuild({ source: options.source,
            sourceNamespace: options.sourceNamespace, snapshot,
            ownerDigest: candidate.ownerDigest, now });
        }
      }
      resolved.set(candidate.ownerDigest, build);
    }
    if (build === null) throw new CacheRetentionRefusedError("owner_source_unavailable");
    return build(candidate, carry, budget);
  };
}

export interface CacheRetentionDayLaneResult {
  state: "idle" | "progress" | "deferred";
  reason: "complete" | "deadline" | "query_budget" | "day_limit";
  built: number;
  staged: number;
  /** Days refused for a reason recorded against the day's own inputs, so the
   * next selection excludes them. */
  refused: number;
  /** Days refused for a transient, owner-scoped reason, deliberately NOT
   * recorded, so the same days are selected again next pass. A pass whose
   * candidates are all skipped makes no progress and repeats forever, which is
   * indistinguishable from "never opened" without this counter. */
  skipped: number;
  candidates: number;
  /** Source statements the build spent. The lane's own meter wraps only the
   * target, so the caller deducts this from the pass meter. */
  sourceQueriesUsed: number;
}

const SELECTION_SQL = `SELECT DISTINCT v.source_id,v.source_layout,v.source_namespace,v.owner_digest,
    v.device_id,v.manifest_id,v.manifest_digest,v.day
  FROM analytics_v11_reusable_values v
  JOIN analytics_owner_state o ON o.source_id=v.source_id AND o.owner_digest=v.owner_digest
    AND o.state='active'
  WHERE v.source_id=?1 AND v.source_layout='typed-v11' AND (?2 IS NULL OR v.day>=?2)
    AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
      WHERE f.source_id=v.source_id AND f.owner_digest=v.owner_digest)
    AND NOT EXISTS(SELECT 1 FROM analytics_cache_retention_day_marks m
      WHERE m.source_id=v.source_id AND m.owner_digest=v.owner_digest AND m.day=v.day
        AND m.method_version=?3 AND m.source_layout=v.source_layout
        AND m.source_namespace=v.source_namespace AND m.device_id=v.device_id
        AND m.manifest_id=v.manifest_id AND m.manifest_digest=v.manifest_digest
        AND NOT EXISTS(SELECT 1 FROM analytics_cache_retention_day_carry c
          WHERE c.mark_key=m.mark_key AND c.manifest_digest!=COALESCE(
            (SELECT MAX(w.manifest_digest) FROM analytics_v11_reusable_values w
              WHERE w.source_id=m.source_id AND w.owner_digest=m.owner_digest
                AND w.device_id=m.device_id AND w.day=c.day
                AND w.source_layout='typed-v11' AND w.source_namespace=m.source_namespace),'')))
    AND (?5=1 OR ((instr('0123456789abcdef',substr(v.owner_digest,1,1))-1)*16
      +(instr('0123456789abcdef',substr(v.owner_digest,2,1))-1))%?5=?6)
  ORDER BY v.day,v.owner_digest,v.device_id LIMIT ?4`;

/**
 * One bounded, resumable preparation page.
 *
 * Oldest day first, so a backfill converges and a stalled day is visible rather
 * than skipped. The lane refuses to OPEN a day it cannot pay for in full, so a
 * pass never ends with a day half written; a day that still needs another batch
 * keeps its staged rows and no mark, which is what the next pass resumes from.
 */
export async function advanceCacheRetentionDayLane(options: {
  target: D1Database; sourceId: string; build: CacheRetentionDayBuild;
  deadlineMs: number; remainingQueries: number; maxDays?: number; maxWrites?: number;
  fromDay?: string; now?: () => number; sourceQueries?: number;
  /** Deterministic owner sharding: every owner digest falls in exactly one of
   * 256 buckets by its first two hex characters, so two instances can never
   * select the same day and no day is unreachable. */
  shardIndex?: number; shardCount?: number;
}): Promise<CacheRetentionDayLaneResult> {
  const { target, sourceId, build } = options;
  const maxDays = options.maxDays ?? 4, maxWrites = options.maxWrites ?? CACHE_RETENTION_MAX_WRITES;
  const shardCount = options.shardCount ?? 1, shardIndex = options.shardIndex ?? 0;
  bounded(shardCount, 1, CACHE_RETENTION_MAX_SHARDS);
  bounded(shardIndex, 0, shardCount - 1);
  bounded(maxDays, 1, 64);
  bounded(maxWrites, CACHE_RETENTION_MIN_WRITES, CACHE_RETENTION_MAX_WRITES);
  if (typeof build !== "function" || !Number.isFinite(options.deadlineMs)
    || !Number.isSafeInteger(options.remainingQueries) || options.remainingQueries < 0
    || (options.fromDay !== undefined
      && !validCacheRetentionDayLabel(options.fromDay))) throw fail();
  const now = (): number => {
    const value = (options.now ?? Date.now)();
    if (!Number.isFinite(value)) throw fail();
    return value;
  };
  let built = 0, staged = 0, refused = 0, skipped = 0;
  const idle = (state: CacheRetentionDayLaneResult["state"],
    reason: CacheRetentionDayLaneResult["reason"], candidates: number,
    sourceQueriesUsed: number): CacheRetentionDayLaneResult =>
    ({ state, reason, built, staged, refused, skipped, candidates, sourceQueriesUsed });
  // One selection statement plus, per day, the carry read, a mark read, a
  // staged read, its write batch and the promotion check. Refuse to open the
  // lane below that.
  if (options.remainingQueries < 5) return idle("deferred", "query_budget", 0, 0);
  if (now() >= options.deadlineMs) return idle("deferred", "deadline", 0, 0);
  const candidates = (await target.prepare(SELECTION_SQL)
    .bind(sourceId, options.fromDay ?? null, CACHE_RETENTION_METHOD.version, maxDays,
      shardCount, shardIndex)
    .all<{ source_id: string; source_layout: string; source_namespace: string; owner_digest: string;
      device_id: string; manifest_id: string; manifest_digest: string; day: string }>()).results;
  if (!candidates.length) return idle("idle", "complete", 0, 0);
  // One day costs the carry read, a mark read, a staged read, its write batches
  // and the promotion check, plus one more for a recorded refusal.
  const perDay = 5 + maxWrites;
  let affordable = options.remainingQueries - 1;
  const sourceAllowance = options.sourceQueries ?? 256;
  const sourceBudget: CacheRetentionBuildBudget = { deadlineMs: options.deadlineMs,
    remainingQueries: sourceAllowance };
  const spent = (): number => sourceAllowance - sourceBudget.remainingQueries;
  for (const row of candidates) {
    if (affordable < perDay) {
      return idle(built + staged ? "progress" : "deferred", "query_budget", candidates.length, spent());
    }
    affordable -= perDay;
    if (now() >= options.deadlineMs) {
      return idle(built + staged ? "progress" : "deferred", "deadline", candidates.length, spent());
    }
    if (row.source_id !== sourceId || row.source_layout !== "typed-v11") throw fail();
    const candidate: CacheRetentionDayCandidate = { sourceId, sourceLayout: "typed-v11",
      sourceNamespace: row.source_namespace, ownerDigest: row.owner_digest, deviceId: row.device_id,
      manifestId: row.manifest_id, manifestDigest: row.manifest_digest, day: row.day };
    checkKey(candidate);
    const carry = await readCacheRetentionCarryDays(target, candidate);
    let aggregate: CacheRetentionDayAggregate;
    try {
      aggregate = await build(candidate, carry, sourceBudget);
    } catch (error) {
      if (error instanceof CacheRetentionRefusedError) {
        if (!CACHE_RETENTION_RECORDED_REFUSALS.has(error.reason)) {
          // Transient and owner-scoped: the pass's own memo already makes the
          // rest of this owner's days free, and the next pass retries it.
          skipped += 1;
          console.log(JSON.stringify({ event: "cache_retention_day_skipped", reason: error.reason }));
          continue;
        }
        refused += 1;
        await writeCacheRetentionDayRefusal({ target, key: candidate, carry,
          reason: error.reason as CacheRetentionRecordedRefusal });
        console.log(JSON.stringify({ event: "cache_retention_day_refused", reason: error.reason }));
        continue;
      }
      // A deferred build wrote nothing, so the pass ends here and the next one
      // starts this day again.
      if (!(error instanceof CacheRetentionDeferredError)) throw error;
      return idle(built + staged ? "progress" : "deferred", error.reason, candidates.length, spent());
    }
    const result = await writeCacheRetentionDay({ target, key: candidate, carry, aggregate, maxWrites });
    if (result.status === "stored") built += 1; else staged += 1;
  }
  // A pass that only refused still advanced: it recorded refusals the next
  // selection excludes. Reporting idle there would claim the lane is complete.
  return idle("progress", candidates.length < maxDays ? "complete" : "day_limit",
    candidates.length, spent());
}
