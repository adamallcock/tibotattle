import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import {
  CACHE_RETENTION_BAND_IDS,
  CACHE_RETENTION_GROUP_LIMIT,
  CACHE_RETENTION_METHOD,
  CACHE_RETENTION_RECORDED_REFUSALS,
  CacheRetentionRefusedError,
  applyCacheRetentionReducerCarryPage,
  applyCacheRetentionReducerPage,
  createCacheRetentionReducerState,
  finishCacheRetentionReducer,
  reduceCacheRetentionDay,
  validCacheRetentionReducerState,
  type CacheRetentionReducerState,
  validCacheRetentionDayAggregate,
  validCacheRetentionDayLabel,
  validCacheRetentionToken,
  type CacheRetentionBandId,
  type CacheRetentionDayAggregate,
  type CacheRetentionEvent,
  type CacheRetentionItem,
  type CacheRetentionRecordedRefusal,
  type CacheRetentionBandRow,
  CACHE_RETENTION_METRIC_ID,
  CACHE_RETENTION_PUBLIC_SCHEMA_VERSION,
  CACHE_RETENTION_WINDOWS,
  mergeCacheRetentionBands,
  publicCacheRetentionWindow,
  type PublicCacheRetentionSeries,
  type PublicCacheRetentionWindow,
} from "./cache-retention-values";
import { parseStoredRecordJson } from "./stored-record";
import { assertV1SourcePinCurrent, loadV1SourcePin,
  type V1SourcePin } from "./telemetry-v1-source-selection";
import { loadV11SourcePin } from "./telemetry-v11-domain";
import { loadTypedV1AnalysisScope, readTypedV1UsageAnalysisPage,
  type TypedV1AnalysisScope } from "./typed-v1-analysis-reader";
import { readTypedV11UsageAnalysisPage, TYPED_V11_ANALYSIS_PAGE_SIZE } from "./typed-v11-analysis-reader";
import { assertTypedV11GenerationSnapshotLive, loadTypedV11GenerationSnapshot,
  type V11GenerationSnapshot } from "./typed-v11-quota-reader";
import {
  EffectiveUsageReaderError,
  MAX_EFFECTIVE_USAGE_PAGE,
  readEffectiveTelemetryOwnerDayPage,
  type EffectiveUsageReaderCursor,
} from "./telemetry-usage-effective-reader";
import { effectiveHistoryDependency } from "./storage-effective-history";
import type { StorageCommunityOwner } from "./storage-community-authority";

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

/**
 * The delivered layouts a prepared day may be built from.
 *
 * The measurement is identical for both — same population filter, same
 * same-configuration fields, same bands, same order — so widening this list
 * does NOT change `CACHE_RETENTION_METHOD` and must not bump its version. What
 * differs is only where the day's events and the day's identity are read from,
 * and `source_layout` is in the mark identity so the two never collide.
 */
export const CACHE_RETENTION_SOURCE_LAYOUTS = ["typed-v11", "typed-v1", "effective"] as const;
export type CacheRetentionSourceLayout = (typeof CACHE_RETENTION_SOURCE_LAYOUTS)[number];

/**
 * The two key fields v1 has no delivered value for.
 *
 * A v1 day is delivered as a VECTOR of chunks rather than one manifest, and
 * its device is ELECTED from the source chunk headers at read time
 * (`selectV1WinningDevices`) rather than pinned by the delivery. Both are a
 * function of the day's chunk vector, which `manifestDigest` already covers,
 * so recording them as layout constants keeps exactly one candidate per
 * (owner, day). Carrying the per-device digest instead would make one day
 * several candidates and the pooled community merge would count it twice.
 */
export const CACHE_RETENTION_V1_DEVICE_ID = "v1-elected-at-read";
export const CACHE_RETENTION_V1_MANIFEST_ID = "v1-chunk-vector";
/** Effective owner/day pages are already reconciled across every admitted
 * family. These constants keep their prepared mark a single candidate per
 * owner/day and prevent a physical device or generation from becoming another
 * pooled contributor. */
export const CACHE_RETENTION_EFFECTIVE_DEVICE_ID = "effective-owner";
export const CACHE_RETENTION_EFFECTIVE_MANIFEST_ID = "effective-owner-day";

const EFFECTIVE_DAILY_CURSOR_METHOD = "effective-daily-cursor-v2";
/**
 * Extract the closed-window dependency identity materialized by the effective
 * daily projector. This is deliberately a fail-closed expression: a legacy,
 * malformed, or hand-written effective row must never become an empty digest
 * and accidentally authorize a cache aggregate.
 */
function effectiveDependencyDigestSql(alias: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/u.test(alias)) throw fail();
  const path = `${alias}.fingerprint`;
  return `(CASE WHEN json_valid(${path})=1
      AND json_extract(${path},'$.method')='${EFFECTIVE_DAILY_CURSOR_METHOD}'
      AND json_type(${path},'$.dependencyDigest')='text'
      AND length(json_extract(${path},'$.dependencyDigest'))=64
      AND json_extract(${path},'$.dependencyDigest') NOT GLOB '*[^0-9a-f]*'
    THEN json_extract(${path},'$.dependencyDigest') ELSE NULL END)`;
}

/**
 * The identity a promoted effective mark must still match before it can be
 * read or suppress a legacy row. The daily cursor digest covers the selected
 * day; the carry rows cover each of the seven lookback days. Both are needed:
 * a late lookback projection can leave the selected-day digest unchanged while
 * changing the aggregate's input. `ready` is false for retirement/selection,
 * where a current recorded refusal is still a durable identity; readers and
 * legacy suppression pass true so refusals never appear as values.
 */
function effectiveMarkCurrentSql(markAlias: string, ready = false): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/u.test(markAlias)) throw fail();
  const dayAlias = `${markAlias}_day`;
  const carryAlias = `${markAlias}_carry`;
  const carryDayAlias = `${markAlias}_carry_day`;
  return `(${markAlias}.source_layout='effective'
    AND ${markAlias}.source_namespace=(SELECT runtime.source_namespace FROM analytics_runtime_sources runtime
      WHERE runtime.source_id=${markAlias}.source_id)
    AND EXISTS(SELECT 1 FROM analytics_community_daily_owners ${dayAlias}
      WHERE ${dayAlias}.source_id=${markAlias}.source_id
        AND ${dayAlias}.owner_digest=${markAlias}.owner_digest
        AND ${dayAlias}.day=${markAlias}.day
        AND ${dayAlias}.source_format='effective' AND ${dayAlias}.complete=1
        AND ${effectiveDependencyDigestSql(dayAlias)}=${markAlias}.manifest_digest)
    AND (SELECT COUNT(*) FROM analytics_cache_retention_day_carry ${carryAlias}
      WHERE ${carryAlias}.mark_key=${markAlias}.mark_key)=${markAlias}.carry_days
    AND NOT EXISTS(SELECT 1 FROM analytics_cache_retention_day_carry ${carryAlias}
      WHERE ${carryAlias}.mark_key=${markAlias}.mark_key
        AND ${carryAlias}.manifest_digest!=COALESCE(
          (SELECT ${effectiveDependencyDigestSql(carryDayAlias)}
             FROM analytics_community_daily_owners ${carryDayAlias}
            WHERE ${carryDayAlias}.source_id=${markAlias}.source_id
              AND ${carryDayAlias}.owner_digest=${markAlias}.owner_digest
              AND ${carryDayAlias}.day=${carryAlias}.day
              AND ${carryDayAlias}.source_format='effective'
              AND ${carryDayAlias}.complete=1),''))
    ${ready ? `AND ${markAlias}.refusal IS NULL` : ''})`;
}

/**
 * The v1 day identity, as one SQL expression.
 *
 * v1 delivers no day manifest, so there is no digest to read; this derives the
 * equivalent. `analytics_v1_chunk_values.owner_revision` is the owner's journal
 * revision of the change that wrote the row, revisions are per-owner
 * monotonic, and `analytics_v1_chunk_forward` requires a strictly increasing
 * one on every update, so ANY write to ANY chunk of a day carries a revision
 * greater than every row that owner already holds. `MAX(owner_revision)` over
 * one (owner, day) therefore changes exactly when that day's chunk set changes
 * — a restatement, a new chunk, or a first delivery — and never when another
 * day's does. That is precisely the property v1.1 gets from `manifest_digest`.
 * `COUNT(*)` travels with it as an independent witness.
 *
 * It is an exact fixed-width encoding of two integers, not a hash: there is
 * nothing to collide. `printf` emits lowercase hex, which is the shape the
 * mark column's CHECK admits, and both halves are wide enough that no real
 * revision or row count can overflow its field.
 */
const V1_DAY_REVISION = "printf('%032x%032x',COUNT(*),MAX(owner_revision))";
/** The same expression where the aggregated table needs an alias. */
const v1DayRevision = (alias: string): string =>
  `printf('%032x%032x',COUNT(*),MAX(${alias}.owner_revision))`;

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
  sourceLayout: CacheRetentionSourceLayout;
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
    || !CACHE_RETENTION_SOURCE_LAYOUTS.includes(key.sourceLayout)
    || typeof key.sourceNamespace !== "string" || key.sourceNamespace.length < 1
    || key.sourceNamespace.length > 256
    || typeof key.deviceId !== "string" || key.deviceId.length < 1 || key.deviceId.length > 256
    || typeof key.manifestId !== "string" || key.manifestId.length < 1 || key.manifestId.length > 256
    // v1 pins neither a device nor a manifest, so the layout constants are the
    // only admissible values. A per-device key would make one day several
    // candidates and the pooled merge would count it twice.
    || (key.sourceLayout === "typed-v1" && (key.deviceId !== CACHE_RETENTION_V1_DEVICE_ID
      || key.manifestId !== CACHE_RETENTION_V1_MANIFEST_ID))
    || (key.sourceLayout === "effective" && (key.deviceId !== CACHE_RETENTION_EFFECTIVE_DEVICE_ID
      || key.manifestId !== CACHE_RETENTION_EFFECTIVE_MANIFEST_ID))
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

/** Values predating the effective lane have a historical uniqueness key that
 * omits source layout. Keep the public v2 carry digest byte-for-byte stable for
 * both frozen layouts, while salting only effective storage identities so an
 * owner/day can retain the legacy mark during an effective replacement without
 * colliding at the values table. The reducer and all band arithmetic remain
 * unchanged; this is solely a storage identity fence. */
async function cacheRetentionStorageCarryDigest(key: CacheRetentionDayKey,
  carry: readonly CacheRetentionCarryDay[]): Promise<string> {
  const digest = await cacheRetentionCarryDigest(carry);
  return key.sourceLayout === "effective"
    ? sha256Hex(canonicalJson({ method: "cache-retention-effective-carry-v1",
      sourceLayout: key.sourceLayout, carryDigest: digest }))
    : digest;
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
  // Still one statement per layout. The v1 arm derives the same per-day
  // identity the selection derives, from the same rows, so a lookback day's
  // recorded dependency and its selected identity can never disagree.
  let rows: Array<{ day: string; manifest_digest: string | null }>;
  if (key.sourceLayout === "typed-v11") {
    rows = (await target.prepare(`SELECT day,MAX(manifest_digest) AS manifest_digest
        FROM analytics_v11_reusable_values
        WHERE source_id=?1 AND owner_digest=?2 AND device_id=?3 AND day>=?4 AND day<?5
          AND source_layout='typed-v11' AND source_namespace=?6
        GROUP BY day`)
      .bind(key.sourceId, key.ownerDigest, key.deviceId, days[0]!, key.day, key.sourceNamespace)
      .all<{ day: string; manifest_digest: string }>()).results;
  } else if (key.sourceLayout === "typed-v1") {
    rows = (await target.prepare(`SELECT observed_day AS day,${V1_DAY_REVISION} AS manifest_digest
        FROM analytics_v1_chunk_values
        WHERE source_id=?1 AND owner_digest=?2 AND observed_day>=?3 AND observed_day<?4
        GROUP BY observed_day`)
      .bind(key.sourceId, key.ownerDigest, days[0]!, key.day)
      .all<{ day: string; manifest_digest: string }>()).results;
  } else {
    rows = (await target.prepare(`SELECT day,${effectiveDependencyDigestSql("e")} AS manifest_digest
        FROM analytics_community_daily_owners e
        WHERE e.source_id=?1 AND e.owner_digest=?2 AND e.source_format='effective'
          AND e.complete=1 AND e.day>=?3 AND e.day<?4
        GROUP BY e.day`)
      .bind(key.sourceId, key.ownerDigest, days[0]!, key.day)
      .all<{ day: string; manifest_digest: string | null }>()).results;
    // An effective row exists, but its closed-window cursor is missing or
    // malformed. Treat that as unavailable rather than allowing a retry to
    // use an empty digest and publish a cache value against unproved inputs.
    if (rows.some((row) => row.manifest_digest === null)) throw fail();
  }
  const delivered = new Map<string, string>();
  for (const row of rows) {
    if (row.manifest_digest !== null) delivered.set(row.day, row.manifest_digest);
  }
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
  maxWrites?: number; cursor?: CacheRetentionDayWriteCursor; progressKey?: string;
}): Promise<CacheRetentionDayWrite> {
  const { target, aggregate } = input, key = { ...input.key };
  checkKey(key);
  checkCarry(key, input.carry);
  const max = input.maxWrites ?? CACHE_RETENTION_MAX_WRITES;
  bounded(max, CACHE_RETENTION_MIN_WRITES, CACHE_RETENTION_MAX_WRITES);
  const carryDigest = await cacheRetentionStorageCarryDigest(key, input.carry);
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
    if (input.progressKey !== undefined) {
      if (!HASH.test(input.progressKey) || input.progressKey !== f.markKey) throw fail();
      // Delete before inserting the immutable mark. The whole batch is one
      // transaction, so a crash cannot leave a promoted mark with a mutable
      // reducer checkpoint, and a retry is idempotent either way.
      statements.push(target.prepare(`DELETE FROM analytics_cache_retention_day_progress
        WHERE progress_key=? AND NOT EXISTS(SELECT 1 FROM analytics_cache_retention_day_marks WHERE mark_key=?)`)
        .bind(input.progressKey, input.progressKey));
    }
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
  const carryDigest = await cacheRetentionStorageCarryDigest(key, input.carry);
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
  if (key.sourceLayout === "effective") {
    // A capacity refusal closes the effective identity.  Remove any cursor
    // left by the failed attempt in the same target transaction so it cannot
    // survive behind an immutable refusal mark.
    statements.unshift(target.prepare(`DELETE FROM analytics_cache_retention_day_progress
      WHERE progress_key=? AND NOT EXISTS(SELECT 1 FROM analytics_cache_retention_day_marks WHERE mark_key=?)`)
      .bind(markKey, markKey));
  }
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
  const carryDigest = await cacheRetentionStorageCarryDigest(key, input.carry);
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
      FROM analytics_cache_retention_day_bands WHERE value_key=?
      LIMIT ${CACHE_RETENTION_BAND_IDS.length + 1}`).bind(value.value_key)
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
        OR (m.source_layout='typed-v11' AND NOT EXISTS(
          SELECT 1 FROM analytics_v11_reusable_values v
          WHERE v.source_id=m.source_id AND v.source_layout=m.source_layout
            AND v.source_namespace=m.source_namespace AND v.owner_digest=m.owner_digest
            AND v.device_id=m.device_id AND v.manifest_id=m.manifest_id
            AND v.manifest_digest=m.manifest_digest AND v.day=m.day))
        OR (m.source_layout='typed-v1' AND NOT EXISTS(
          SELECT 1 FROM analytics_v1_chunk_values c
          WHERE c.source_id=m.source_id AND c.owner_digest=m.owner_digest
            AND c.observed_day=m.day
          GROUP BY c.owner_digest,c.observed_day
          HAVING ${v1DayRevision("c")}=m.manifest_digest))
        OR (m.source_layout='effective' AND NOT ${effectiveMarkCurrentSql("m")})
        OR (m.source_layout IN ('typed-v11','typed-v1') AND EXISTS(
          SELECT 1 FROM analytics_cache_retention_day_marks e
          WHERE ${effectiveMarkCurrentSql("e", true)}
            AND e.method_version=m.method_version AND e.source_id=m.source_id
            AND e.owner_digest=m.owner_digest AND e.day=m.day)))
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
  // Effective reducer checkpoints are replaceable staging. Retire an orphan
  // when its owner is erased or its pinned owner-day revision no longer
  // exists; a promoted mark deliberately blocks this cleanup and is cleaned
  // transactionally by writeCacheRetentionDay instead.
  try {
    await target.prepare(`DELETE FROM analytics_cache_retention_day_progress
      WHERE progress_key IN (SELECT p.progress_key FROM analytics_cache_retention_day_progress p
        WHERE p.source_id=?1 AND NOT EXISTS(
          SELECT 1 FROM analytics_cache_retention_day_marks m WHERE m.mark_key=p.progress_key)
        AND (EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
          WHERE f.source_id=p.source_id AND f.owner_digest=p.owner_digest)
          OR NOT EXISTS(SELECT 1 FROM analytics_community_daily_owners e
            WHERE e.source_id=p.source_id AND e.owner_digest=p.owner_digest AND e.day=p.day
              AND e.source_format='effective' AND e.complete=1
              AND ${effectiveDependencyDigestSql("e")} = p.manifest_digest))
        ORDER BY p.owner_digest,p.day LIMIT ?2)`).bind(sourceId, limit).run();
  } catch { /* Older analytics databases have no staged effective table. */ }
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

/**
 * The stored usage-event schemas this mapper reads.
 *
 * Both are admitted because the fields this measurement uses are the SAME
 * fields, under the same names, with the same closed per-field validators: v1's
 * `parseUsageEvent` and v1.1's `parseTelemetryV11UsageEvent` both require
 * `sessionUuid`, `modelId`, `reasoningEffort`, `speedMode` and `surface` as
 * bounded tokens and all three input components as nullable token counts. The
 * only usage-stream field v1.1 adds is `accountPlanAttribution`, which this
 * measurement never reads. Admitting v1.0 therefore widens the INPUT and not
 * the method, and nothing below is relaxed: an unknown schema version is still
 * unreadable, and so is any admitted record whose fields do not validate.
 */
export const CACHE_RETENTION_RECORD_SCHEMAS: ReadonlySet<string> =
  new Set(["usage-event-v1.1", "usage-event-v1.0"]);

/** Map one stored usage record to the lens's own event, or report that it
 * cannot be read. Only allowlisted fields are consulted and none is coerced: an
 * absent token component stays `null`, and an absent or malformed configuration
 * token makes the row unreadable rather than a guess. */
export function cacheRetentionEventFromRecord(input: { sessionDigest: string; observedAtMs: number;
  orderKey: string; recordJson: string }): CacheRetentionItem | null {
  const record = parseStoredRecordJson(input.recordJson) as Record<string, unknown> | null;
  const unreadable: CacheRetentionItem = { sessionDigest: input.sessionDigest,
    observedAtMs: input.observedAtMs, orderKey: input.orderKey, unreadable: true };
  if (!record || typeof record.schemaVersion !== "string"
    || !CACHE_RETENTION_RECORD_SCHEMAS.has(record.schemaVersion)) return unreadable;
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

/**
 * The production v1 day reader: one UTC day of v1.0 usage rows, paged through
 * `readTypedV1UsageAnalysisPage` with the same `cacheRetentionSessionDigest`
 * hook, so no raw `sessionUuid` crosses this boundary either.
 *
 * Three things differ from the v1.1 reader, all of them properties of the
 * layout rather than of the measurement:
 *
 * - The day is expressed as an instant range plus the day's ELECTED winning
 *   device, because v1 has no manifest to page within. The winner comes from
 *   the pinned chunk-header vector, so a day with no winner delivered nothing
 *   and reads as empty rather than as an error.
 * - The source keyset is `(observed_at_ms, source_row_id)`, which agrees with
 *   the method on the instant and differs only in the tiebreak, so the reader
 *   applies the method's own tiebreak — the occurrence id — to the day it
 *   collected. The v1.1 reader gets that ordering from its proof index. Equal
 *   instants stay `unorderedTies`; nothing here claims an order it lacks.
 * - The liveness fence is the source pin rather than a generation snapshot. A
 *   pin that moved under the read makes the day a skip, never a short day.
 */
export function createCacheRetentionV1DayReader(options: {
  source: D1Database; sourceNamespace: string; scope: TypedV1AnalysisScope; pin: V1SourcePin;
  ownerDigest: string; maxPages?: number;
}): CacheRetentionDayReader {
  const maxPages = options.maxPages ?? CACHE_RETENTION_DAY_PAGES;
  bounded(maxPages, 1, 1_024);
  // The pin and the analysis scope must name the same participant, or the
  // winner vector would be fencing a different owner's uploads.
  if (!HASH.test(options.ownerDigest) || options.scope.sourceNamespace !== options.sourceNamespace
    || !("participantId" in options.pin.scope)
    || options.pin.scope.participantId !== options.scope.participantId) throw fail();
  const scope = { ...options.scope };
  const pin = options.pin;
  return async ({ day, sessions, budget, now }) => {
    if (!validCacheRetentionDayLabel(day)) throw fail();
    // One triple, not the whole history: the pinned vector already elected this
    // day's device, and binding only the day being read keeps the filter small
    // and makes a day nobody won read as empty.
    const winners = pin.winners.filter((winner) => winner.observed_day === day);
    if (winners.length > 1) throw fail();
    if (winners.length === 0) return { items: [], rowsRead: 0 };
    const winnersJson = JSON.stringify(winners.map((winner) =>
      [winner.participant_id, winner.observed_day, winner.device_id]));
    const fromMs = Date.parse(`${day}T00:00:00.000Z`);
    const items: CacheRetentionItem[] = [];
    const seen = new Set<string>();
    let rowsRead = 0, afterTime = new Date(fromMs).toISOString(), afterId = 0;
    for (let page = 0; page < maxPages; page += 1) {
      // Two legs, one statement each: the reader splits an equal-instant page
      // from the page after it, exactly as the quota path does.
      spend(budget, now);
      spend(budget, now);
      const rows = await readTypedV1UsageAnalysisPage(options.source, scope, winnersJson,
        afterTime, afterId, TYPED_V11_ANALYSIS_PAGE_SIZE,
        new Date(fromMs + 86_400_000).toISOString());
      for (const row of rows) {
        rowsRead += 1;
        afterTime = row.observed_at;
        afterId = row.id;
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
        spend(budget, now);
        await assertV1SourcePinCurrent(options.source, pin);
        // The method's order, applied once to the whole day. The source keyset
        // already fixed the instants; only the tiebreak between equal ones can
        // differ from it, and that is a total order over distinct occurrence
        // ids, so this never reorders two events across different instants.
        items.sort((left, right) => left.observedAtMs - right.observedAtMs
          || (left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0));
        return { items, rowsRead };
      }
    }
    throw new CacheRetentionRefusedError("day_page_limit_exceeded");
  };
}

/**
 * The version-neutral production reader. The effective occurrence reader has
 * already joined and reconciled every admitted v1/v1.1/v1.2 source before a
 * row crosses this boundary, so this lane applies the exact same mapper and
 * reduction as the frozen readers above. A page is charged conservatively for
 * the bounded source work behind that public page; this keeps the retention
 * scheduler from opening an effective day it cannot finish within its source
 * allowance. The reservation is 192: at most 16 compatibility decode pages
 * cost 16*(one schema read + three 90-id reads) = 64, at most 16 grouped
 * correction pages cost 16*(runtime + before/after CAS + page) = 64, and the
 * remaining family candidates, v1.2 availability/source expansion and final
 * fences fit within the remaining 64. This is a scheduler reservation, not a
 * claim about D1 subrequest accounting; the wrapped invocation meter remains
 * the final ceiling.
 */
export const CACHE_RETENTION_EFFECTIVE_PAGE_QUERIES = 192;
export const CACHE_RETENTION_EFFECTIVE_SETUP_QUERIES = 3;
/** One closed-window dependency read currently uses six bounded D1 queries:
 * schema capability, v1, v1.1, optional v1.2, correction frontier and the
 * outside-occurrence link page. Reserve the full shape before invoking the
 * helper so the lane's source allowance cannot be overspent invisibly. */
export const CACHE_RETENTION_EFFECTIVE_DEPENDENCY_QUERIES = 6;

function spendMany(budget: CacheRetentionBuildBudget, now: () => number, count: number): void {
  bounded(count, 1, 192);
  for (let index = 0; index < count; index += 1) spend(budget, now);
}

export function createCacheRetentionEffectiveDayReader(options: {
  source: D1Database; sourceNamespace: string; ownerDigest: string;
  ownerRevision: number; authorityEpoch: number; maxPages?: number;
}): CacheRetentionDayReader {
  const maxPages = options.maxPages ?? CACHE_RETENTION_DAY_PAGES;
  bounded(maxPages, 1, CACHE_RETENTION_DAY_PAGES);
  bounded(options.ownerRevision, 1, 0x7fffffff);
  bounded(options.authorityEpoch, 1, 0x7fffffff);
  if (!HASH.test(options.ownerDigest) || typeof options.sourceNamespace !== "string"
    || options.sourceNamespace.length < 1
    || options.sourceNamespace.length > 256) throw fail();
  return async ({ day, sessions, budget, now }) => {
    if (!validCacheRetentionDayLabel(day)) throw fail();
    const items: CacheRetentionItem[] = [];
    const seen = new Set<string>();
    let rowsRead = 0;
    let after: EffectiveUsageReaderCursor | undefined;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      spendMany(budget, now, CACHE_RETENTION_EFFECTIVE_PAGE_QUERIES);
      const page = await readEffectiveTelemetryOwnerDayPage(options.source, {
        sourceNamespace: options.sourceNamespace, ownerDigest: options.ownerDigest,
        ownerRevision: options.ownerRevision, authorityEpoch: options.authorityEpoch,
        day, stream: "usage", limit: MAX_EFFECTIVE_USAGE_PAGE,
        ...(after === undefined ? {} : { after }),
      });
      for (const row of page.rows) {
        rowsRead += 1;
        if (seen.has(row.occurrenceId)) continue;
        seen.add(row.occurrenceId);
        if (seen.size > maxPages * MAX_EFFECTIVE_USAGE_PAGE) {
          throw new CacheRetentionRefusedError("day_page_limit_exceeded");
        }
        if (row.status !== "compatible" || row.recordJson === null || row.eventTime === null) {
          throw new CacheRetentionRefusedError("usage_row_refused");
        }
        const observedAtMs = Date.parse(row.eventTime);
        if (!Number.isSafeInteger(observedAtMs)
          || new Date(observedAtMs).toISOString().slice(0, 10) !== day) {
          throw new CacheRetentionRefusedError("usage_row_refused");
        }
        const record = parseStoredRecordJson(row.recordJson) as Record<string, unknown> | null;
        const sessionUuid = record?.sessionUuid;
        const provider = record?.provider;
        if (!record || typeof sessionUuid !== "string" || sessionUuid.length === 0
          || typeof provider !== "string" || provider.length === 0) {
          throw new CacheRetentionRefusedError("usage_row_refused");
        }
        const sessionDigest = await cacheRetentionSessionDigest({
          ownerDigest: options.ownerDigest, provider, sessionUuid,
        });
        if (sessions !== null && !sessions.has(sessionDigest)) continue;
        const item = cacheRetentionEventFromRecord({ sessionDigest, observedAtMs,
          orderKey: row.occurrenceId, recordJson: row.recordJson });
        if (item !== null) items.push(item);
      }
      if (page.next === null) return { items, rowsRead };
      if (page.rows.length === 0 || page.next.observedAtMs < (after?.observedAtMs ?? -Infinity)
        || (page.next.observedAtMs === (after?.observedAtMs ?? -Infinity)
          && page.next.occurrenceId <= (after?.occurrenceId ?? ""))) {
        throw new CacheRetentionRefusedError("usage_row_refused");
      }
      after = page.next;
    }
    throw new CacheRetentionRefusedError("day_page_limit_exceeded");
  };
}

/** One candidate day. */
export interface CacheRetentionDayCandidate extends CacheRetentionDayKey {}
export type CacheRetentionDayBuild = (candidate: CacheRetentionDayCandidate,
  carry: readonly CacheRetentionCarryDay[],
  budget: CacheRetentionBuildBudget) => Promise<CacheRetentionDayAggregate>;

type CacheRetentionEffectiveProgressPhase = "discover" | "lookback" | "own" | "write";
interface CacheRetentionEffectiveProgressCursor {
  readonly observedAtMs: number;
  readonly occurrenceId: string;
}
interface CacheRetentionEffectiveProgressEnvelope {
  readonly schemaVersion: "cache-retention-effective-progress-v1";
  readonly phase: CacheRetentionEffectiveProgressPhase;
  readonly lookbackIndex: number;
  readonly cursor: CacheRetentionEffectiveProgressCursor | null;
  readonly eventsRead: number;
  readonly sessions: readonly string[];
  readonly reducer: CacheRetentionReducerState;
  readonly aggregate: CacheRetentionDayAggregate | null;
}
interface CacheRetentionEffectiveProgressRow {
  readonly progress_key: string;
  readonly source_id: string;
  readonly source_layout: string;
  readonly source_namespace: string;
  readonly owner_digest: string;
  readonly device_id: string;
  readonly manifest_id: string;
  readonly manifest_digest: string;
  readonly day: string;
  readonly method_version: string;
  readonly carry_digest: string;
  readonly progress_revision: number;
  readonly state_json: string;
  readonly state_digest: string;
}

const CACHE_RETENTION_EFFECTIVE_PROGRESS_VERSION = "cache-retention-effective-progress-v1" as const;
// D1 caps a single TEXT/BLOB value at 2,000,000 bytes.  Keep a margin for
// SQLite's value framing and reject before binding; a larger JavaScript string
// would otherwise fail after the source page had already been consumed.
const CACHE_RETENTION_EFFECTIVE_PROGRESS_MAX_BYTES = 1_900_000;
const CACHE_RETENTION_EFFECTIVE_PROGRESS_MAX_SESSIONS = 100_000;
const progressByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

function progressCursorValid(value: unknown): value is CacheRetentionEffectiveProgressCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  return Object.keys(cursor).sort().join(",") === "observedAtMs,occurrenceId"
    && Number.isSafeInteger(cursor.observedAtMs)
    && typeof cursor.occurrenceId === "string"
    && /^[A-Za-z0-9._:-]{8,128}$/u.test(cursor.occurrenceId);
}

function progressEnvelopeValid(value: unknown): value is CacheRetentionEffectiveProgressEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).sort().join(",") !== "aggregate,cursor,eventsRead,lookbackIndex,phase,reducer,schemaVersion,sessions"
    || envelope.schemaVersion !== CACHE_RETENTION_EFFECTIVE_PROGRESS_VERSION
    || !["discover", "lookback", "own", "write"].includes(envelope.phase as string)
    || !Number.isSafeInteger(envelope.lookbackIndex) || (envelope.lookbackIndex as number) < 0
    || (envelope.lookbackIndex as number) > CACHE_RETENTION_MAX_LOOKBACK_DAYS
    || (envelope.cursor !== null && !progressCursorValid(envelope.cursor))
    || !Number.isSafeInteger(envelope.eventsRead) || (envelope.eventsRead as number) < 0
    || !Array.isArray(envelope.sessions) || envelope.sessions.length > CACHE_RETENTION_EFFECTIVE_PROGRESS_MAX_SESSIONS
    || !envelope.sessions.every((item) => typeof item === "string" && HASH.test(item))
    || envelope.sessions.some((item, index, all) => index > 0 && item <= all[index - 1]!)
    || !validCacheRetentionReducerState(envelope.reducer)
    || (envelope.aggregate !== null && !validCacheRetentionDayAggregate(envelope.aggregate))) return false;
  if (envelope.phase === "write" && envelope.aggregate === null) return false;
  if (envelope.phase !== "write" && envelope.aggregate !== null) return false;
  if (envelope.phase === "discover" && envelope.lookbackIndex !== 0) return false;
  return true;
}

function progressEnvelopeSnapshot(day: string, phase: CacheRetentionEffectiveProgressPhase,
  lookbackIndex: number, cursor: CacheRetentionEffectiveProgressCursor | null,
  eventsRead: number, sessions: readonly string[], reducer: CacheRetentionReducerState,
  aggregate: CacheRetentionDayAggregate | null = null): CacheRetentionEffectiveProgressEnvelope {
  const value: CacheRetentionEffectiveProgressEnvelope = {
    schemaVersion: CACHE_RETENTION_EFFECTIVE_PROGRESS_VERSION,
    phase, lookbackIndex, cursor, eventsRead, sessions: [...new Set(sessions)].sort(), reducer, aggregate,
  };
  if (value.reducer.day !== day || !progressEnvelopeValid(value)) throw fail();
  return value;
}

async function readCacheRetentionEffectiveProgress(target: D1Database,
  key: CacheRetentionDayCandidate, progressKey: string, carryDigest: string): Promise<{
    row: CacheRetentionEffectiveProgressRow; value: CacheRetentionEffectiveProgressEnvelope;
  } | null> {
  let row: CacheRetentionEffectiveProgressRow | null;
  try {
    row = await target.prepare(`SELECT progress_key,source_id,source_layout,source_namespace,owner_digest,
      device_id,manifest_id,manifest_digest,day,method_version,carry_digest,progress_revision,state_json,state_digest
      FROM analytics_cache_retention_day_progress WHERE progress_key=?`).bind(progressKey)
      .first<CacheRetentionEffectiveProgressRow>();
  } catch { throw new CacheRetentionDeferredError("query_budget"); }
  if (!row) return null;
  if (row.source_id !== key.sourceId || row.source_layout !== key.sourceLayout
    || row.source_namespace !== key.sourceNamespace || row.owner_digest !== key.ownerDigest
    || row.device_id !== key.deviceId || row.manifest_id !== key.manifestId
    || row.manifest_digest !== key.manifestDigest || row.day !== key.day
    || row.method_version !== CACHE_RETENTION_METHOD.version || row.carry_digest !== carryDigest) throw fail();
  let value: unknown;
  try { value = JSON.parse(row.state_json); } catch { throw fail(); }
  if (!progressEnvelopeValid(value) || value.reducer.day !== key.day
    || !HASH.test(row.state_digest)
    || await sha256Hex(canonicalJson(value)) !== row.state_digest) throw fail();
  return { row, value };
}

async function writeCacheRetentionEffectiveProgress(target: D1Database,
  key: CacheRetentionDayCandidate, progressKey: string,
  carryDigest: string,
  previous: CacheRetentionEffectiveProgressRow | null,
  value: CacheRetentionEffectiveProgressEnvelope): Promise<CacheRetentionEffectiveProgressRow> {
  const stateJson = canonicalJson(value);
  if (progressByteLength(stateJson) > CACHE_RETENTION_EFFECTIVE_PROGRESS_MAX_BYTES) {
    // This is a closed capacity outcome, not transient query pressure.  A
    // retry would serialize the same state again and starve the owner forever;
    // record the bounded refusal through the ordinary day lane instead.
    throw new CacheRetentionRefusedError("checkpoint_size_exceeded");
  }
  const stateDigest = await sha256Hex(stateJson);
  const revision = previous?.progress_revision === undefined ? 1 : previous.progress_revision + 1;
  try {
    if (!previous) {
      await target.prepare(`INSERT INTO analytics_cache_retention_day_progress
        (progress_key,source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,
         manifest_digest,day,method_version,carry_digest,progress_revision,state_json,state_digest)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(progressKey,key.sourceId,key.sourceLayout,key.sourceNamespace,
          key.ownerDigest,key.deviceId,key.manifestId,key.manifestDigest,key.day,CACHE_RETENTION_METHOD.version,
          carryDigest,revision,stateJson,stateDigest).run();
    } else {
      const updated = await target.prepare(`UPDATE analytics_cache_retention_day_progress SET
        progress_revision=?,state_json=?,state_digest=? WHERE progress_key=? AND progress_revision=?
        AND NOT EXISTS(SELECT 1 FROM analytics_cache_retention_day_marks WHERE mark_key=?)`)
        .bind(revision,stateJson,stateDigest,progressKey,previous.progress_revision,progressKey).run();
      if (updated.meta?.changes !== undefined && updated.meta.changes !== 1) throw new CacheRetentionDeferredError("query_budget");
    }
  } catch (error) {
    if (error instanceof CacheRetentionDeferredError) throw error;
    // An active erasure fence is a terminal privacy decision, not missing
    // capacity.  Preserve the trigger's closed error so the caller cannot
    // retry the same checkpoint forever after the owner has been erased.
    if (String(error).includes("storage_owner_erased")) throw error;
    throw new CacheRetentionDeferredError("query_budget");
  }
  const saved = await target.prepare(`SELECT progress_key,source_id,source_layout,source_namespace,owner_digest,
    device_id,manifest_id,manifest_digest,day,method_version,carry_digest,progress_revision,state_json,state_digest
    FROM analytics_cache_retention_day_progress WHERE progress_key=?`).bind(progressKey)
    .first<CacheRetentionEffectiveProgressRow>();
  if (!saved || saved.progress_revision !== revision || saved.state_digest !== stateDigest
    || saved.state_json !== stateJson) throw new CacheRetentionDeferredError("query_budget");
  return saved;
}

async function deleteCacheRetentionEffectiveProgress(target: D1Database, progressKey: string): Promise<void> {
  try { await target.prepare(`DELETE FROM analytics_cache_retention_day_progress WHERE progress_key=?
    AND NOT EXISTS(SELECT 1 FROM analytics_cache_retention_day_marks WHERE mark_key=?)`)
    .bind(progressKey,progressKey).run(); } catch { /* stale/missing staged state is recoverable */ }
}

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
  return cacheRetentionBuildFromReader(options.read ?? createCacheRetentionDayReader({
    source: options.source, sourceNamespace: options.sourceNamespace, snapshot: options.snapshot,
    ownerDigest: options.ownerDigest }), options.sourceNamespace, options.now ?? Date.now);
}

/**
 * The layout-independent half of the build: the day's own read, the bounded
 * lookback, and the reduction. Only the reader knows which layout it is
 * reading, which is exactly why the measurement is the same for both and why
 * adding a layout does not touch `CACHE_RETENTION_METHOD`.
 */
function cacheRetentionBuildFromReader(read: CacheRetentionDayReader, sourceNamespace: string,
  now: () => number): CacheRetentionDayBuild {
  return async (candidate, carry, budget) => {
    checkKey(candidate);
    checkCarry(candidate, carry);
    if (candidate.sourceNamespace !== sourceNamespace || !Number.isFinite(budget.deadlineMs)
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

/** The production v1 day builder. Same reduction, same lookback, same budget;
 * only the reader differs. */
export function createCacheRetentionV1DayBuild(options: {
  source: D1Database; sourceNamespace: string; scope: TypedV1AnalysisScope; pin: V1SourcePin;
  ownerDigest: string; now?: () => number;
  /** Test seam only: production derives the reader from the source. */
  read?: CacheRetentionDayReader;
}): CacheRetentionDayBuild {
  return cacheRetentionBuildFromReader(options.read ?? createCacheRetentionV1DayReader({
    source: options.source, sourceNamespace: options.sourceNamespace, scope: options.scope,
    pin: options.pin, ownerDigest: options.ownerDigest }), options.sourceNamespace,
    options.now ?? Date.now);
}

/** Effective rows are folded through the same cache-retention-v2 reduction;
 * only the source reader and its owner revision fence differ. */
export function createCacheRetentionEffectiveDayBuild(options: {
  source: D1Database; target?: D1Database; sourceNamespace: string; ownerDigest: string;
  ownerRevision: number; authorityEpoch: number; now?: () => number;
  read?: CacheRetentionDayReader;
  /** Narrow test seam for proving durable page resumption without source data. */
  readPage?: typeof readEffectiveTelemetryOwnerDayPage;
}): CacheRetentionDayBuild {
  if (options.read) {
    return cacheRetentionBuildFromReader(options.read, options.sourceNamespace, options.now ?? Date.now);
  }
  if (!options.target) {
    return async () => { throw new CacheRetentionDeferredError("query_budget"); };
  }
  const target = options.target;
  const now = options.now ?? Date.now;
  if (typeof options.sourceNamespace !== "string" || options.sourceNamespace.length < 1
    || options.sourceNamespace.length > 256) throw fail();
  return async (candidate, carry, budget) => {
    checkKey(candidate);
    checkCarry(candidate, carry);
    if (candidate.sourceLayout !== "effective" || candidate.sourceNamespace !== options.sourceNamespace
      || candidate.ownerDigest !== options.ownerDigest) throw fail();
    if (!Number.isFinite(budget.deadlineMs) || !Number.isSafeInteger(budget.remainingQueries)) throw fail();
    const carryDigest = await cacheRetentionStorageCarryDigest(candidate, carry);
    const progressKey = await cacheRetentionDayMarkKey(candidate, carryDigest);
    let saved = await readCacheRetentionEffectiveProgress(target, candidate, progressKey, carryDigest);
    let envelope = saved?.value ?? progressEnvelopeSnapshot(candidate.day, "discover", 0, null, 0, [],
      createCacheRetentionReducerState(candidate.day));
    const sessions = new Set(envelope.sessions);
    const lookbackDays = cacheRetentionLookbackDays(candidate.day);
    const pageItems = async (day: string, sessionSet: ReadonlySet<string> | null,
      cursor: CacheRetentionEffectiveProgressCursor | null): Promise<{
      items: CacheRetentionItem[]; rowsRead: number; next: CacheRetentionEffectiveProgressCursor | null;
    }> => {
      spendMany(budget, now, CACHE_RETENTION_EFFECTIVE_PAGE_QUERIES);
      let page: Awaited<ReturnType<typeof readEffectiveTelemetryOwnerDayPage>>;
      try {
        page = await (options.readPage ?? readEffectiveTelemetryOwnerDayPage)(options.source, {
          sourceNamespace: options.sourceNamespace, ownerDigest: options.ownerDigest,
          ownerRevision: options.ownerRevision, authorityEpoch: options.authorityEpoch,
          day, stream: "usage", limit: MAX_EFFECTIVE_USAGE_PAGE,
          ...(cursor === null ? {} : { after: cursor }),
        });
      } catch (error) {
        if (error instanceof EffectiveUsageReaderError
          && error.code === "EFFECTIVE_USAGE_LIMIT") throw new CacheRetentionDeferredError("query_budget");
        if (error instanceof EffectiveUsageReaderError
          && ["EFFECTIVE_USAGE_CAS_MISMATCH", "EFFECTIVE_USAGE_UNAVAILABLE"].includes(error.code)) {
          throw new CacheRetentionRefusedError("owner_source_unavailable");
        }
        if (error instanceof EffectiveUsageReaderError
          && ["EFFECTIVE_USAGE_INVALID", "EFFECTIVE_USAGE_SOURCE_CONFLICT"].includes(error.code)) {
          throw new CacheRetentionRefusedError("usage_row_refused");
        }
        throw error;
      }
      const items: CacheRetentionItem[] = [];
      for (const row of page.rows) {
        if (row.status !== "compatible" || row.recordJson === null || row.eventTime === null) {
          throw new CacheRetentionRefusedError("usage_row_refused");
        }
        const observedAtMs = Date.parse(row.eventTime);
        if (!Number.isSafeInteger(observedAtMs)
          || new Date(observedAtMs).toISOString().slice(0, 10) !== day) {
          throw new CacheRetentionRefusedError("usage_row_refused");
        }
        const record = parseStoredRecordJson(row.recordJson) as Record<string, unknown> | null;
        const sessionUuid = record?.sessionUuid;
        const provider = record?.provider;
        if (!record || typeof sessionUuid !== "string" || sessionUuid.length === 0
          || typeof provider !== "string" || provider.length === 0) {
          throw new CacheRetentionRefusedError("usage_row_refused");
        }
        const sessionDigest = await cacheRetentionSessionDigest({
          ownerDigest: options.ownerDigest, provider, sessionUuid,
        });
        if (sessionSet !== null && !sessionSet.has(sessionDigest)) continue;
        const item = cacheRetentionEventFromRecord({ sessionDigest, observedAtMs,
          orderKey: row.occurrenceId, recordJson: row.recordJson });
        if (item !== null) items.push(item);
      }
      if (page.next !== null && (page.rows.length === 0
        || (cursor !== null && (page.next.observedAtMs < cursor.observedAtMs
          || (page.next.observedAtMs === cursor.observedAtMs
            && page.next.occurrenceId <= cursor.occurrenceId))))) {
        throw new CacheRetentionRefusedError("usage_row_refused");
      }
      return { items, rowsRead: page.rows.length, next: page.next };
    };
    const save = async (next: CacheRetentionEffectiveProgressEnvelope): Promise<void> => {
      saved = { row: await writeCacheRetentionEffectiveProgress(target, candidate, progressKey,
        carryDigest, saved?.row ?? null, next), value: next };
      envelope = next;
    };
    for (;;) {
      if (envelope.phase === "write") {
        if (!envelope.aggregate) throw fail();
        return envelope.aggregate;
      }
      if (envelope.phase === "discover") {
        const page = await pageItems(candidate.day, null, envelope.cursor);
        for (const item of page.items) {
          if (!("unreadable" in item)) sessions.add(item.sessionDigest);
        }
        const next = page.next;
        const state = progressEnvelopeSnapshot(candidate.day, next === null ? (sessions.size === 0 ? "own" : "lookback") : "discover",
          next === null ? 0 : 0, next, envelope.eventsRead + page.rowsRead, [...sessions], envelope.reducer);
        await save(state);
        if (next !== null) continue;
        envelope = state;
        continue;
      }
      if (envelope.phase === "lookback") {
        if (sessions.size === 0) {
          const next = progressEnvelopeSnapshot(candidate.day, "own", 0, null,
            envelope.eventsRead, [...sessions], envelope.reducer);
          await save(next); envelope = next; continue;
        }
        if (envelope.lookbackIndex >= lookbackDays.length) {
          const next = progressEnvelopeSnapshot(candidate.day, "own", 0, null,
            envelope.eventsRead, [...sessions], envelope.reducer);
          await save(next); envelope = next; continue;
        }
        const page = await pageItems(lookbackDays[envelope.lookbackIndex]!, sessions, envelope.cursor);
        const reducer = applyCacheRetentionReducerCarryPage(envelope.reducer, page.items);
        const next = page.next === null
          ? progressEnvelopeSnapshot(candidate.day, "lookback", envelope.lookbackIndex + 1, null,
            envelope.eventsRead, [...sessions], reducer)
          : progressEnvelopeSnapshot(candidate.day, "lookback", envelope.lookbackIndex, page.next,
            envelope.eventsRead, [...sessions], reducer);
        await save(next); envelope = next; continue;
      }
      // Own-day pages are now reduced incrementally. `eventsRead` came from
      // discovery, so it counts source rows exactly once even though the own
      // pass reads the same immutable cursor a second time.
      const page = await pageItems(candidate.day, null, envelope.cursor);
      const reducer = applyCacheRetentionReducerPage(envelope.reducer, page.items);
      const next = page.next === null
        ? progressEnvelopeSnapshot(candidate.day, "write", 0, null, envelope.eventsRead,
          [...sessions], reducer, finishCacheRetentionReducer(reducer, envelope.eventsRead))
        : progressEnvelopeSnapshot(candidate.day, "own", 0, page.next, envelope.eventsRead,
          [...sessions], reducer);
      await save(next); envelope = next;
    }
  };
}

/**
 * The production build for a WHOLE source, resolving each candidate owner's
 * source itself.
 *
 * Analytics never holds a participant identifier, so the owner digest is
 * bridged back through `storage_v11_owner_links` in the source database — the
 * same mapping owner erasure uses. Legacy resolution is memoized per pass and
 * layout. Effective resolution is revalidated for every candidate because its
 * closed-window source identity includes the day and carry vector, and a late
 * source row must not reuse a factory that was proved against an older empty
 * carry. An owner whose link, pin, snapshot or analysis scope is absent is
 * skipped rather than guessed at.
 *
 * The effective layout is selected when the version-neutral daily owner page
 * is complete. It is one owner/day lane even when the source contains several
 * physical families; legacy candidates are suppressed while that effective
 * identity is current.
 */
export function createCacheRetentionDaySourceBuild(options: {
  source: D1Database; target?: D1Database; sourceNamespace: string; now?: () => number;
}): CacheRetentionDayBuild {
  const resolved = new Map<string, CacheRetentionDayBuild | null>();
  const now = options.now ?? Date.now;
  return async (candidate, carry, budget) => {
    checkKey(candidate);
    if (candidate.sourceNamespace !== options.sourceNamespace) throw fail();
    // The effective key contains every target-side identity that the source
    // validation proves. The effective branch below still resolves afresh on
    // every call, because a source-only late arrival can invalidate a target
    // carry that is still recorded as empty between two invocations.
    const carryIdentity = candidate.sourceLayout === "effective"
      ? await cacheRetentionStorageCarryDigest(candidate, carry) : "";
    const memo = `${candidate.sourceLayout}\0${candidate.ownerDigest}\0${candidate.day}\0${candidate.manifestDigest}\0${carryIdentity}`;
    let build = candidate.sourceLayout === "effective" ? undefined : resolved.get(memo);
    if (build === undefined) {
      build = null;
      spend(budget, now);
      const link = await options.source
        .prepare("SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=?")
        .bind(candidate.ownerDigest).first<string>("participant_id");
      if (link) {
        if (candidate.sourceLayout === "effective") {
          // The owner page already proved that this is an effective lane. Do
          // not key it to the correction runtime: a v1.2-only owner is valid
          // while correction remains staged, and the effective reader fences
          // that successor directly.
          if (!options.target) throw new CacheRetentionDeferredError("query_budget");
          spend(budget, now);
          const owner = await options.source.prepare(`SELECT link.participant_id,
              owner.revision,owner.authority_epoch
            FROM storage_v11_owner_links link
            JOIN storage_owner_revisions owner ON owner.owner_digest=link.owner_digest
            JOIN participants participant ON participant.id=link.participant_id
              AND participant.state='active'
            WHERE link.owner_digest=? AND link.state='active' AND owner.state='active'
            LIMIT 2`).bind(candidate.ownerDigest)
            .first<{ participant_id: string; revision: number; authority_epoch: number }>();
          if (owner && Number.isSafeInteger(owner.revision) && owner.revision >= 1
            && Number.isSafeInteger(owner.authority_epoch) && owner.authority_epoch >= 1) {
            // The candidate digest is the effective daily projection's
            // closed-window dependency, not the live owner revision. An
            // unrelated day can advance the latter without changing this
            // cache day; the effective reader still fences the source read
            // with the current revision and authority epoch.
            spendMany(budget, now, CACHE_RETENTION_EFFECTIVE_DEPENDENCY_QUERIES);
            try {
              const effectiveOwner: StorageCommunityOwner = {
                participantId: owner.participant_id, ownerDigest: candidate.ownerDigest,
                inputRevision: 1, ownerRevision: owner.revision,
                authorityEpoch: owner.authority_epoch,
                hasV1: false, hasV11: false, hasV12: true, hasLegacy: false,
                hasEffective: true,
              };
              const dependency = await effectiveHistoryDependency(options.source,
                effectiveOwner, options.sourceNamespace, candidate.day, candidate.day,
                { includeSessions: true });
              const digest = await sha256Hex(canonicalJson(dependency));
              let dependenciesMatch = digest === candidate.manifestDigest;
              // The day key also commits to every non-empty lookback source
              // identity. Recheck those closed days against the same helper
              // before resuming a staged reducer; otherwise a late carry-day
              // upload could be folded under an old target digest.
              for (const carryDay of carry) {
                if (!dependenciesMatch) continue;
                spendMany(budget, now, CACHE_RETENTION_EFFECTIVE_DEPENDENCY_QUERIES);
                const carryDependency = await effectiveHistoryDependency(options.source,
                  effectiveOwner, options.sourceNamespace, carryDay.day, carryDay.day,
                  { includeSessions: true });
                const carryHasSource = carryDependency.v1.length > 0 || carryDependency.v11.length > 0
                  || carryDependency.v12.length > 0 || carryDependency.corrections.length > 0
                  || carryDependency.occurrenceLinks.length > 0;
                if (carryDay.manifestDigest === "" ? carryHasSource
                  : await sha256Hex(canonicalJson(carryDependency)) !== carryDay.manifestDigest) {
                  dependenciesMatch = false;
                }
              }
              if (dependenciesMatch) {
                build = createCacheRetentionEffectiveDayBuild({ source: options.source, target: options.target,
                  sourceNamespace: options.sourceNamespace, ownerDigest: candidate.ownerDigest,
                  ownerRevision: owner.revision, authorityEpoch: owner.authority_epoch, now });
              }
            } catch (error) {
              if (error instanceof CacheRetentionDeferredError) throw error;
              // A missing/partial effective source or a changed closed-window
              // dependency is a transient source refusal. Leave the candidate
              // unbuilt so the next pass can reselect it after projection has
              // delivered a matching fingerprint.
            }
          }
        } else {
          spend(budget, now);
          const pin = await loadV11SourcePin(options.source, link);
          if (candidate.sourceLayout === "typed-v11") {
          if (pin && pin.source === "v1.1") {
            spend(budget, now);
            spend(budget, now);
            const snapshot = await loadTypedV11GenerationSnapshot(options.source,
              { sourceNamespace: options.sourceNamespace, pin });
            build = createCacheRetentionDayBuild({ source: options.source,
              sourceNamespace: options.sourceNamespace, snapshot,
              ownerDigest: candidate.ownerDigest, now });
          }
          } else if (pin === null) {
            spend(budget, now);
            const scope = await loadTypedV1AnalysisScope(options.source, link);
            if (scope && scope.sourceNamespace === options.sourceNamespace) {
              // The pin is scoped to the participant, so it fences every day the
              // pass reads for this owner and one unrelated upload retries the
              // owner rather than half-building a day from two vectors.
              spend(budget, now);
              spend(budget, now);
              const sourcePin = await loadV1SourcePin(options.source, { participantId: link });
              build = createCacheRetentionV1DayBuild({ source: options.source,
                sourceNamespace: options.sourceNamespace, scope, pin: sourcePin,
                ownerDigest: candidate.ownerDigest, now });
            }
          }
        }
      }
      if (candidate.sourceLayout !== "effective") resolved.set(memo, build);
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

/** Deterministic owner sharding, identical for both layouts. */
const shardSql = (column: string): string =>
  `(?5=1 OR ((instr('0123456789abcdef',substr(${column},1,1))-1)*16
    +(instr('0123456789abcdef',substr(${column},2,1))-1))%?5=?6)`;

/**
 * The candidate selection: oldest day first across all delivered layouts.
 *
 * Each arm is limited on its own before the union, so the compound never
 * materializes more than `3 * maxDays` rows; taking the oldest N of each arm
 * and then the oldest N of the union is the oldest N overall.
 *
 * The v1 arm derives its day identity rather than reading one, for the reason
 * `V1_DAY_REVISION` states, and aggregates before it filters because that
 * identity is an aggregate over the day's chunk rows. Its `source_namespace`
 * comes from the runtime source row the marks table already keys on by foreign
 * key, so no second copy of that name enters the lane.
 *
 * An effective owner/day row supersedes either legacy layout. The suppression
 * is repeated in both legacy arms and the read path also filters stale overlap,
 * so a daily projection completing between two lane passes cannot make one
 * owner-day count twice.
 */
const SELECTION_SQL = `SELECT * FROM (
    SELECT DISTINCT v.source_id AS source_id,v.source_layout AS source_layout,
      v.source_namespace AS source_namespace,v.owner_digest AS owner_digest,
      v.device_id AS device_id,v.manifest_id AS manifest_id,
      v.manifest_digest AS manifest_digest,v.day AS day
    FROM analytics_v11_reusable_values v
    JOIN analytics_owner_state o ON o.source_id=v.source_id AND o.owner_digest=v.owner_digest
      AND o.state='active'
    WHERE v.source_id=?1 AND v.source_layout='typed-v11' AND (?2 IS NULL OR v.day>=?2)
      AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
        WHERE f.source_id=v.source_id AND f.owner_digest=v.owner_digest)
      AND NOT EXISTS(SELECT 1 FROM analytics_community_daily_owners e
        WHERE e.source_id=v.source_id AND e.owner_digest=v.owner_digest AND e.day=v.day
          AND e.source_format='effective' AND e.complete=1)
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
      AND ${shardSql("v.owner_digest")}
    ORDER BY v.day,v.owner_digest,v.device_id LIMIT ?4)
  UNION ALL
  SELECT * FROM (
    SELECT d.source_id AS source_id,'typed-v1' AS source_layout,
      (SELECT r.source_namespace FROM analytics_runtime_sources r
        WHERE r.source_id=d.source_id) AS source_namespace,
      d.owner_digest AS owner_digest,'${CACHE_RETENTION_V1_DEVICE_ID}' AS device_id,
      '${CACHE_RETENTION_V1_MANIFEST_ID}' AS manifest_id,
      d.manifest_digest AS manifest_digest,d.day AS day
    FROM (SELECT c.source_id AS source_id,c.owner_digest AS owner_digest,
        c.observed_day AS day,${v1DayRevision("c")} AS manifest_digest
      FROM analytics_v1_chunk_values c
      WHERE c.source_id=?1 AND (?2 IS NULL OR c.observed_day>=?2)
        AND ${shardSql("c.owner_digest")}
        AND EXISTS(SELECT 1 FROM analytics_owner_state o WHERE o.source_id=c.source_id
          AND o.owner_digest=c.owner_digest AND o.state='active')
        AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
          WHERE f.source_id=c.source_id AND f.owner_digest=c.owner_digest)
        AND NOT EXISTS(SELECT 1 FROM analytics_community_daily_owners e
          WHERE e.source_id=c.source_id AND e.owner_digest=c.owner_digest
            AND e.day=c.observed_day AND e.source_format='effective' AND e.complete=1)
        AND NOT EXISTS(SELECT 1 FROM analytics_v11_reusable_values x
          WHERE x.source_id=c.source_id AND x.owner_digest=c.owner_digest)
      GROUP BY c.source_id,c.owner_digest,c.observed_day) d
    WHERE NOT EXISTS(SELECT 1 FROM analytics_cache_retention_day_marks m
      WHERE m.source_id=d.source_id AND m.owner_digest=d.owner_digest AND m.day=d.day
        AND m.method_version=?3 AND m.source_layout='typed-v1'
        AND m.manifest_digest=d.manifest_digest
        AND NOT EXISTS(SELECT 1 FROM analytics_cache_retention_day_carry y
          WHERE y.mark_key=m.mark_key AND y.manifest_digest!=COALESCE(
            (SELECT ${v1DayRevision("w")} FROM analytics_v1_chunk_values w
              WHERE w.source_id=m.source_id AND w.owner_digest=m.owner_digest
                AND w.observed_day=y.day
              GROUP BY w.owner_digest,w.observed_day),'')))
    ORDER BY d.day,d.owner_digest LIMIT ?4)
  UNION ALL
  SELECT * FROM (
    SELECT e.source_id AS source_id,'effective' AS source_layout,
      (SELECT r.source_namespace FROM analytics_runtime_sources r
        WHERE r.source_id=e.source_id) AS source_namespace,
      e.owner_digest AS owner_digest,'${CACHE_RETENTION_EFFECTIVE_DEVICE_ID}' AS device_id,
      '${CACHE_RETENTION_EFFECTIVE_MANIFEST_ID}' AS manifest_id,
      ${effectiveDependencyDigestSql("e")} AS manifest_digest,e.day AS day
    FROM analytics_community_daily_owners e
    JOIN analytics_owner_state o ON o.source_id=e.source_id AND o.owner_digest=e.owner_digest
      AND o.state='active'
    WHERE e.source_id=?1 AND e.source_format='effective' AND e.complete=1
      AND ${effectiveDependencyDigestSql("e")} IS NOT NULL
      AND (?2 IS NULL OR e.day>=?2)
      AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
        WHERE f.source_id=e.source_id AND f.owner_digest=e.owner_digest)
      AND NOT EXISTS(SELECT 1 FROM analytics_cache_retention_day_marks m
        WHERE m.source_id=e.source_id AND m.owner_digest=e.owner_digest AND m.day=e.day
          AND m.method_version=?3 AND m.device_id='${CACHE_RETENTION_EFFECTIVE_DEVICE_ID}'
          AND m.manifest_id='${CACHE_RETENTION_EFFECTIVE_MANIFEST_ID}'
          AND ${effectiveMarkCurrentSql("m")})
      AND ${shardSql("e.owner_digest")}
    ORDER BY e.day,e.owner_digest LIMIT ?4)
  ORDER BY day,owner_digest,device_id LIMIT ?4`;

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
    if (row.source_id !== sourceId
      || !CACHE_RETENTION_SOURCE_LAYOUTS.includes(
        row.source_layout as CacheRetentionSourceLayout)) throw fail();
    const candidate: CacheRetentionDayCandidate = { sourceId,
      sourceLayout: row.source_layout as CacheRetentionSourceLayout,
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
    const progressKey = candidate.sourceLayout === "effective"
      ? await cacheRetentionDayMarkKey(candidate, await cacheRetentionStorageCarryDigest(candidate, carry))
      : undefined;
    const result = await writeCacheRetentionDay({ target, key: candidate, carry, aggregate, maxWrites, progressKey });
    if (result.status === "stored") built += 1; else staged += 1;
  }
  // A pass that only refused still advanced: it recorded refusals the next
  // selection excludes. Reporting idle there would claim the lane is complete.
  return idle("progress", candidates.length < maxDays ? "complete" : "day_limit",
    candidates.length, spent());
}

/** The whole community's band rows, one per (owner, band), ready for
 * `mergeCacheRetentionBands`.
 *
 * Every retained day is included. There is no window: a display window is not
 * a retention policy, and a convenience-sized one here would quietly change
 * the published figure every time the lane caught up. The lane's own
 * retirement sweep is what bounds this table.
 *
 * One aggregate statement. The result is at most one row per owner per band,
 * so it is bounded by the participant count and cannot grow with the corpus.
 */
export async function readCacheRetentionCommunityBands(input: {
  target: D1Database; sourceId: string; methodVersion?: string;
  /** Inclusive lower day bound. Absent means every retained day. */
  fromDay?: string;
  /** Group by the values row's model as well as the owner. Effort is summed
   * over: a reader choosing a model is not choosing a reasoning effort. */
  byModel?: boolean;
}): Promise<readonly CacheRetentionBandRow[]> {
  const method = input.methodVersion ?? CACHE_RETENTION_METHOD.version;
  if (typeof input.sourceId !== "string" || input.sourceId.length === 0
    || typeof method !== "string" || method.length === 0) throw fail();
  if (input.fromDay !== undefined && !validCacheRetentionDayLabel(input.fromDay)) throw fail();
  const model = input.byModel === true;
  // The model lives on the values row, so grouping by it costs a join. The
  // bound stays the same either way: at most one row per owner, model and
  // band, so the result cannot grow with the corpus.
  const rows = (await input.target.prepare(`SELECT b.owner_digest,b.band,${model ? "v.model model," : ""}
      SUM(b.adjacencies) adjacencies, SUM(b.reused_more_than_half) reused_more_than_half,
      SUM(b.matched_or_exceeded) matched_or_exceeded, SUM(b.unordered_ties) unordered_ties,
      SUM(b.excluded_insufficient_evidence) excluded_insufficient_evidence,
      SUM(b.excluded_context_contracted) excluded_context_contracted, SUM(b.sessions) sessions
    FROM analytics_cache_retention_day_bands b
    JOIN analytics_cache_retention_day_values v ON v.value_key=b.value_key
    JOIN analytics_cache_retention_day_marks m ON m.mark_key=v.mark_key
    WHERE b.source_id=? AND b.method_version=?${input.fromDay === undefined ? "" : " AND b.day>=?"}
      AND ((${effectiveMarkCurrentSql("m", true)}) OR
        (m.source_layout!='effective' AND NOT EXISTS(
          SELECT 1 FROM analytics_cache_retention_day_marks e
          WHERE ${effectiveMarkCurrentSql("e", true)}
            AND e.method_version=m.method_version AND e.source_id=m.source_id
            AND e.owner_digest=m.owner_digest AND e.day=m.day)))
    GROUP BY b.owner_digest,b.band${model ? ",v.model" : ""} ORDER BY b.owner_digest,b.band`)
    .bind(...[input.sourceId, method, ...(input.fromDay === undefined ? [] : [input.fromDay])])
    .all<{ owner_digest: string; band: string; adjacencies: number; reused_more_than_half: number;
      matched_or_exceeded: number; unordered_ties: number; excluded_insufficient_evidence: number;
      excluded_context_contracted: number; sessions: number; model?: string }>()).results;
  return rows.map((row) => {
    if (!CACHE_RETENTION_BAND_IDS.includes(row.band as CacheRetentionBandId)) throw fail();
    return {
      ownerDigest: row.owner_digest, band: row.band as CacheRetentionBandId,
      adjacencies: row.adjacencies, reusedMoreThanHalf: row.reused_more_than_half,
      matchedOrExceeded: row.matched_or_exceeded, unorderedTies: row.unordered_ties,
      excludedInsufficientEvidence: row.excluded_insufficient_evidence,
      excludedContextContracted: row.excluded_context_contracted, sessions: row.sessions,
      ...(model ? { model: row.model as string } : {}),
    };
  });
}

/**
 * The whole published series: every window, pooled and cut by model.
 *
 * Two reads per window — one pooled, one grouped by model — because the
 * per-model read cannot produce the pooled `sessions` figure. `sessions` is a
 * DISTINCT count per stored row, so summing it across models would count a
 * session that used two models twice. The pooled read sums the same rows
 * without the model split and is the one that answers "how many sessions".
 *
 * Eight statements for four windows, bounded and independent of corpus size.
 */
export async function readCacheRetentionCommunitySeries(input: {
  target: D1Database; sourceId: string; nowMs: number; methodVersion?: string;
}): Promise<PublicCacheRetentionSeries | null> {
  const method = input.methodVersion ?? CACHE_RETENTION_METHOD.version;
  if (!Number.isSafeInteger(input.nowMs)) throw fail();
  const windows: PublicCacheRetentionWindow[] = [];
  let anyEvidence = false;
  for (const span of CACHE_RETENTION_WINDOWS) {
    // The window is calendar days ending today inclusive, so a one-day window
    // is today itself rather than the last 24 hours. That matches how the
    // stored rows are cut; a rolling hour boundary would silently include or
    // exclude part of a day depending on when the page was read.
    const fromDay = span.days === null ? undefined
      : new Date(input.nowMs - (span.days - 1) * 86_400_000).toISOString().slice(0, 10);
    const pooled = await readCacheRetentionCommunityBands({ target: input.target,
      sourceId: input.sourceId, methodVersion: method, ...(fromDay === undefined ? {} : { fromDay }) });
    const modelRows = await readCacheRetentionCommunityBands({ target: input.target,
      sourceId: input.sourceId, methodVersion: method, byModel: true,
      ...(fromDay === undefined ? {} : { fromDay }) });
    if (pooled.length > 0) anyEvidence = true;
    windows.push(publicCacheRetentionWindow({ window: span.id, days: span.days,
      pooled: mergeCacheRetentionBands(pooled), modelRows }));
  }
  // No evidence in ANY window is absence, not a series of empty curves.
  if (!anyEvidence) return null;
  return {
    schemaVersion: CACHE_RETENTION_PUBLIC_SCHEMA_VERSION,
    metric: CACHE_RETENTION_METRIC_ID, methodVersion: method,
    measures: "consecutive_requests", gapBasis: "response_end_to_response_end",
    windows,
  };
}
