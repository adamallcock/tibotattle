/**
 * analytics_v2 store: the one write path of the analytics-refresh Job (A-3).
 *
 * writeRunOutputs persists one computeAnalyticsV2 result (contract.ts
 * AnalyticsV2RunOutputs) in ONE transaction on a dedicated client:
 *
 *  1. it re-takes the refresh advisory lock at transaction scope (re-entrant
 *     for the Job's session that already holds it; any other session is
 *     refused) and re-reads the journal cursor FOR UPDATE, refusing a cursor
 *     that moved since the Job's read snapshot;
 *  2. it replaces the owner-scoped families (owner_day, cache_bands,
 *     owner_fits, owner_model_dates) of the owners this run computed (source
 *     'effective'), and only inside the run's horizon: owner_day rows from
 *     horizon.ownerDayFromDay and cache_bands rows from
 *     horizon.cacheBandsFromDay. Rows of owners the run did not compute
 *     (opted out, disconnected, expired, unlinked or not ported) and rows
 *     older than the horizon are retained, never retired: a roster change
 *     stops future contributions only, and a display window is not a
 *     retention policy. The manual offline erasure runbook is the only path
 *     that deletes an owner's rows;
 *  3. it publishes each daily candidate whose content digest differs from the
 *     stored head: revision = max(previous, revisionSeed) + 1 and
 *     releasedAt = nowMs. An unchanged digest keeps the row untouched, and a
 *     blocked day is never written, so it keeps its prior row (or stays
 *     absent);
 *  4. it upserts the preview, advances the journal cursor (never backwards),
 *     and inserts the run row with the refusal list and the publication
 *     summary.
 *
 * Any failure rolls the whole transaction back: no analytics_v2 row changes.
 *
 * Determinism (the zero-diff parity gate): a published payload is the
 * candidate payload with its three revision-bound fields (aggregateId,
 * revision, releasedAt) replaced by the values this store assigns, and
 * payload_sha256 digests the payload WITHOUT those fields. Given the same
 * prior state, nowMs and revisionSeed, the stored rows are byte-identical.
 * The candidate's payloadSha256 must equal analyticsV2DailyContentSha256 of
 * its payload; a disagreement is refused rather than silently re-derived.
 *
 * Errors carry closed codes, a field path at most and a SQLSTATE; never a
 * driver message, SQL text, bind value or kernel value.
 */

import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";
import type { PostgresClient } from "../postgres-client";
import {
  ANALYTICS_V2_CACHE_BAND_COUNTERS,
  ANALYTICS_V2_CONTRACT_VERSION,
  ANALYTICS_V2_MODES,
  ANALYTICS_V2_OWNER_DAY_REFUSAL_REASONS,
  ANALYTICS_V2_OWNER_DIGEST_PATTERN,
  ANALYTICS_V2_OWNER_SOURCES,
  ANALYTICS_V2_PHASES,
  ANALYTICS_V2_REFRESH_LOCK_KEY,
  ANALYTICS_V2_REFUSAL_FAMILIES,
  ANALYTICS_V2_REFUSAL_REASONS,
  ANALYTICS_V2_SHA256_PATTERN,
  ANALYTICS_V2_SINGLETON_ID,
  ANALYTICS_V2_TABLES,
  type AnalyticsV2Day,
  type AnalyticsV2Mode,
  type AnalyticsV2Phase,
  type AnalyticsV2PublicationSummary,
  type AnalyticsV2Refusal,
  type AnalyticsV2RunOutputs,
} from "./contract";

/** The ten closed cache-continuity bands (d43c8f92 CACHE_RETENTION_BAND_IDS). */
export const ANALYTICS_V2_CACHE_BANDS = Object.freeze([
  "under_one_minute",
  "one_to_two_minutes",
  "two_to_five_minutes",
  "five_to_ten_minutes",
  "ten_to_thirty_minutes",
  "thirty_minutes_to_one_hour",
  "one_to_two_hours",
  "two_to_six_hours",
  "six_to_twenty_four_hours",
  "over_twenty_four_hours",
] as const);

/** Payload fields this store assigns at publication; excluded from the digest. */
export const ANALYTICS_V2_DAILY_REVISION_FIELDS = Object.freeze([
  "aggregateId",
  "revision",
  "releasedAt",
] as const);

/**
 * Cap on one published daily payload, in bytes of its jsonb text form: the
 * same measure as 0059's CHECK (octet_length(payload::text)), so the store
 * refuses an oversized payload with its own code before the CHECK can.
 */
export const ANALYTICS_V2_MAX_DAILY_PAYLOAD_BYTES = 262_144;
/** Highest revisionSeed accepted; revision is a PostgreSQL integer. */
export const ANALYTICS_V2_MAX_REVISION_SEED = 2_000_000_000;

/** Bounded outputs: a run beyond these is refused before any write. */
export const ANALYTICS_V2_OUTPUT_LIMITS = Object.freeze({
  owners: 10_000,
  ownerDays: 4_000_000,
  cacheBands: 8_000_000,
  ownerModelDates: 2_000_000,
  days: 4_096,
  refusals: 4_000_000,
});

const WRITE_STATEMENT_TIMEOUT_MILLISECONDS = 300_000;
const WRITE_LOCK_TIMEOUT_MILLISECONDS = 5_000;
const CHUNK_MAX_ROWS = 5_000;
const CHUNK_MAX_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const CACHE_LABEL = /^[A-Za-z0-9._:-]{1,64}$/u;
const DECIMAL = /^(?:0|[1-9]\d{0,18})$/u;
const MILLISECONDS_PER_DAY = 86_400_000;

export type AnalyticsV2StoreErrorCode =
  | "ANALYTICS_V2_SCHEMA_INVALID"
  | "ANALYTICS_V2_OUTPUTS_INVALID"
  | "ANALYTICS_V2_OUTPUTS_CAPACITY_EXCEEDED"
  | "ANALYTICS_V2_DAILY_DIGEST_MISMATCH"
  | "ANALYTICS_V2_DAILY_PAYLOAD_TOO_LARGE"
  | "ANALYTICS_V2_RUN_INVALID"
  | "ANALYTICS_V2_REFRESH_LOCK_NOT_HELD"
  | "ANALYTICS_V2_CURSOR_MOVED"
  | "ANALYTICS_V2_CURSOR_REGRESSION"
  | "ANALYTICS_V2_PUBLICATION_CONFLICT"
  | "ANALYTICS_V2_STATE_INVALID"
  | "ANALYTICS_V2_READ_FAILED"
  | "ANALYTICS_V2_WRITE_FAILED";

/** Safe store failure: a closed code, an optional field path and SQLSTATE. */
export class AnalyticsV2StoreError extends Error {
  readonly code: AnalyticsV2StoreErrorCode;
  readonly field: string | undefined;
  readonly sqlState: string | undefined;

  constructor(code: AnalyticsV2StoreErrorCode, details: { field?: string; sqlState?: string } = {}) {
    super(code);
    this.name = "AnalyticsV2StoreError";
    this.code = code;
    this.field = details.field;
    this.sqlState = details.sqlState;
  }
}

function fail(code: AnalyticsV2StoreErrorCode, field?: string): never {
  throw new AnalyticsV2StoreError(code, field === undefined ? {} : { field });
}

function invalid(field: string): never {
  fail("ANALYTICS_V2_OUTPUTS_INVALID", field);
}

function sqlStateOf(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  try {
    const code = Reflect.get(error, "code");
    return typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function quoteSchema(schema: unknown): string {
  if (typeof schema !== "string" || !SCHEMA_IDENTIFIER.test(schema)
      || schema.startsWith("pg_") || schema === "information_schema") {
    fail("ANALYTICS_V2_SCHEMA_INVALID");
  }
  return `"${schema}"`;
}

function relation(schema: string, table: string): string {
  return `${schema}."${table}"`;
}

/** A UTC calendar day that round-trips through Date. */
export function isAnalyticsV2Day(value: unknown): value is AnalyticsV2Day {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

/** The UTC day of an epoch-millisecond instant. */
export function analyticsV2UtcDay(nowMs: number): AnalyticsV2Day {
  return new Date(Math.floor(nowMs / MILLISECONDS_PER_DAY) * MILLISECONDS_PER_DAY)
    .toISOString().slice(0, 10);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Refuse anything JSON or jsonb would silently alter: undefined, functions,
 * symbols, bigint, non-finite numbers, NUL characters, class instances (Map,
 * Date) and excessive depth.
 */
function assertJsonValue(value: unknown, field: string, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) invalid(field);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(field);
    return;
  }
  if (typeof value === "string") {
    if (value.includes("\u0000")) invalid(field);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) invalid(field);
      assertJsonValue(value[index], field, depth + 1);
    }
    return;
  }
  if (!plainObject(value)) invalid(field);
  for (const key of Object.keys(value)) {
    if (key.includes("\u0000")) invalid(field);
    assertJsonValue(value[key], field, depth + 1);
  }
}

function contentOf(payload: Record<string, unknown>): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const key of Object.keys(payload)) {
    if (!(ANALYTICS_V2_DAILY_REVISION_FIELDS as readonly string[]).includes(key)) {
      content[key] = payload[key];
    }
  }
  return content;
}

/**
 * The digest a daily candidate must carry as payloadSha256: SHA-256 of the
 * canonical JSON of the payload without aggregateId, revision and releasedAt.
 * computeAnalyticsV2 (A-2) should call this rather than re-implement it.
 */
export async function analyticsV2DailyContentSha256(payload: unknown): Promise<string> {
  if (!plainObject(payload)) invalid("dailyCandidates.payload");
  assertJsonValue(payload, "dailyCandidates.payload");
  return sha256Hex(canonicalJson(contentOf(payload)));
}

/** The published payload: the content plus the store-assigned revision fields. */
export function stampAnalyticsV2DailyPayload(
  payload: Record<string, unknown>,
  stamp: { readonly day: AnalyticsV2Day; readonly revision: number; readonly releasedAt: string },
): Record<string, unknown> {
  return {
    ...contentOf(payload),
    aggregateId: `community-daily:${stamp.day}:r${stamp.revision}`,
    revision: stamp.revision,
    releasedAt: stamp.releasedAt,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedDays(days: Iterable<AnalyticsV2Day>): AnalyticsV2Day[] {
  return [...new Set(days)].sort(compareText);
}

function assertCapacity(length: number, limit: number, field: string): void {
  if (length > limit) fail("ANALYTICS_V2_OUTPUTS_CAPACITY_EXCEEDED", field);
}

function assertArray(value: unknown, field: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) invalid(field);
}

function assertOwnerDigest(value: unknown, owners: ReadonlySet<string>, field: string): string {
  if (typeof value !== "string" || !ANALYTICS_V2_OWNER_DIGEST_PATTERN.test(value)
      || !owners.has(value)) {
    invalid(field);
  }
  return value;
}

function assertDay(value: unknown, field: string): AnalyticsV2Day {
  if (!isAnalyticsV2Day(value)) invalid(field);
  return value;
}

function assertNonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(field);
  return value;
}

interface PreparedDailyCandidate {
  readonly day: AnalyticsV2Day;
  readonly payload: Record<string, unknown>;
  readonly payloadSha256: string;
}

interface PreparedOutputs {
  readonly mode: AnalyticsV2Mode;
  readonly nowMs: number;
  readonly revisionSeed: number;
  readonly ownerDigests: readonly string[];
  /** Owners this run computed (source 'effective'); only their rows are replaced. */
  readonly computedOwnerDigests: readonly string[];
  readonly dailyCandidates: readonly PreparedDailyCandidate[];
  readonly blockedDays: readonly AnalyticsV2Day[];
  readonly refusals: readonly AnalyticsV2Refusal[];
  readonly lastSequence: number | null;
  readonly timings: Readonly<Partial<Record<AnalyticsV2Phase, number>>>;
}

function refusalKey(refusal: AnalyticsV2Refusal): string {
  return `${refusal.ownerDigest}\u0001${refusal.day ?? ""}\u0001${refusal.family}\u0001${refusal.reason}`;
}

function validTimings(value: unknown, field: string): Partial<Record<AnalyticsV2Phase, number>> {
  if (!plainObject(value)) invalid(field);
  const timings: Partial<Record<AnalyticsV2Phase, number>> = {};
  for (const key of Object.keys(value)) {
    if (!(ANALYTICS_V2_PHASES as readonly string[]).includes(key)) invalid(field);
    const entry = value[key];
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) invalid(field);
    timings[key as AnalyticsV2Phase] = entry;
  }
  return timings;
}

/**
 * Validate one run's outputs against the contract and the 0059 constraints
 * before any database work, and verify every daily candidate's digest.
 * Exported so the Job and specs can check outputs without writing.
 */
export async function assertAnalyticsV2RunOutputs(
  outputs: AnalyticsV2RunOutputs,
  horizon: AnalyticsV2RunHorizon,
): Promise<void> {
  await prepareOutputs(outputs, validHorizon(horizon));
}

/**
 * The owner-scoped rows one run recomputes. A computed owner's owner_day rows
 * from ownerDayFromDay and cache_bands rows from cacheBandsFromDay are
 * replaced; its older rows are retained untouched.
 */
export interface AnalyticsV2RunHorizon {
  readonly ownerDayFromDay: AnalyticsV2Day;
  readonly cacheBandsFromDay: AnalyticsV2Day;
}

function validHorizon(value: unknown): AnalyticsV2RunHorizon {
  if (!plainObject(value) || !isAnalyticsV2Day(value.ownerDayFromDay)
      || !isAnalyticsV2Day(value.cacheBandsFromDay)) {
    fail("ANALYTICS_V2_RUN_INVALID", "horizon");
  }
  return { ownerDayFromDay: value.ownerDayFromDay, cacheBandsFromDay: value.cacheBandsFromDay };
}

async function prepareOutputs(outputs: AnalyticsV2RunOutputs, horizon: AnalyticsV2RunHorizon): Promise<PreparedOutputs> {
  if (!plainObject(outputs)) invalid("outputs");
  if (outputs.contractVersion !== ANALYTICS_V2_CONTRACT_VERSION) invalid("contractVersion");
  if (!(ANALYTICS_V2_MODES as readonly string[]).includes(outputs.mode)) invalid("mode");
  const nowMs = assertNonNegativeSafeInteger(outputs.nowMs, "nowMs");
  if (outputs.today !== analyticsV2UtcDay(nowMs)) invalid("today");
  const revisionSeed = assertNonNegativeSafeInteger(outputs.revisionSeed, "revisionSeed");
  if (revisionSeed > ANALYTICS_V2_MAX_REVISION_SEED) invalid("revisionSeed");

  assertArray(outputs.owners, "owners");
  assertCapacity(outputs.owners.length, ANALYTICS_V2_OUTPUT_LIMITS.owners, "owners");
  const owners = new Set<string>();
  const computed = new Set<string>();
  for (const owner of outputs.owners) {
    if (!plainObject(owner) || typeof owner.ownerDigest !== "string"
        || !ANALYTICS_V2_OWNER_DIGEST_PATTERN.test(owner.ownerDigest)
        || owners.has(owner.ownerDigest)
        || typeof owner.participantId !== "string" || owner.participantId.length === 0
        || !(ANALYTICS_V2_OWNER_SOURCES as readonly string[]).includes(owner.source)
        || ![owner.hasV1, owner.hasV11, owner.hasV12, owner.hasLegacy, owner.hasEffective]
          .every((flag) => typeof flag === "boolean")) {
      invalid("owners");
    }
    owners.add(owner.ownerDigest);
    if (owner.source === "effective") computed.add(owner.ownerDigest);
  }

  assertArray(outputs.ownerDays, "ownerDays");
  assertCapacity(outputs.ownerDays.length, ANALYTICS_V2_OUTPUT_LIMITS.ownerDays, "ownerDays");
  for (const row of outputs.ownerDays) {
    if (!plainObject(row)) invalid("ownerDays");
    assertOwnerDigest(row.ownerDigest, computed, "ownerDays.ownerDigest");
    if (assertDay(row.day, "ownerDays.day") < horizon.ownerDayFromDay) invalid("ownerDays.day");
    const hasDaily = row.daily !== null && row.daily !== undefined;
    const hasRefusal = row.refusal !== null && row.refusal !== undefined;
    if (hasDaily === hasRefusal) invalid("ownerDays.daily");
    if (hasDaily) assertJsonValue(row.daily, "ownerDays.daily");
    if (hasRefusal && !(ANALYTICS_V2_OWNER_DAY_REFUSAL_REASONS as readonly string[]).includes(row.refusal as string)) {
      invalid("ownerDays.refusal");
    }
  }

  assertArray(outputs.cacheBands, "cacheBands");
  assertCapacity(outputs.cacheBands.length, ANALYTICS_V2_OUTPUT_LIMITS.cacheBands, "cacheBands");
  for (const row of outputs.cacheBands) {
    if (!plainObject(row)) invalid("cacheBands");
    assertOwnerDigest(row.ownerDigest, computed, "cacheBands.ownerDigest");
    if (assertDay(row.day, "cacheBands.day") < horizon.cacheBandsFromDay) invalid("cacheBands.day");
    if (typeof row.model !== "string" || !CACHE_LABEL.test(row.model)) invalid("cacheBands.model");
    if (typeof row.effort !== "string" || !CACHE_LABEL.test(row.effort)) invalid("cacheBands.effort");
    if (!(ANALYTICS_V2_CACHE_BANDS as readonly string[]).includes(row.band)) invalid("cacheBands.band");
    if (!plainObject(row.counters)
        || Object.keys(row.counters).length !== ANALYTICS_V2_CACHE_BAND_COUNTERS.length) {
      invalid("cacheBands.counters");
    }
    const counters = row.counters as Record<string, unknown>;
    for (const name of ANALYTICS_V2_CACHE_BAND_COUNTERS) {
      assertNonNegativeSafeInteger(counters[name], `cacheBands.counters.${name}`);
    }
    const value = (name: (typeof ANALYTICS_V2_CACHE_BAND_COUNTERS)[number]) => counters[name] as number;
    if (value("reused_more_than_half") > value("adjacencies")
        || value("matched_or_exceeded") > value("reused_more_than_half")
        || value("unordered_ties") > value("adjacencies")
        || value("sessions") > value("adjacencies")) {
      invalid("cacheBands.counters");
    }
  }

  assertArray(outputs.ownerFits, "ownerFits");
  assertCapacity(outputs.ownerFits.length, ANALYTICS_V2_OUTPUT_LIMITS.owners, "ownerFits");
  for (const row of outputs.ownerFits) {
    if (!plainObject(row)) invalid("ownerFits");
    assertOwnerDigest(row.ownerDigest, computed, "ownerFits.ownerDigest");
    assertDay(row.asOfDay, "ownerFits.asOfDay");
    if (row.fits === null || row.fits === undefined) invalid("ownerFits.fits");
    assertJsonValue(row.fits, "ownerFits.fits");
  }

  assertArray(outputs.ownerModelDates, "ownerModelDates");
  assertCapacity(outputs.ownerModelDates.length, ANALYTICS_V2_OUTPUT_LIMITS.ownerModelDates, "ownerModelDates");
  for (const row of outputs.ownerModelDates) {
    if (!plainObject(row)) invalid("ownerModelDates");
    assertOwnerDigest(row.ownerDigest, computed, "ownerModelDates.ownerDigest");
    assertDay(row.day, "ownerModelDates.day");
    if (row.result === null || row.result === undefined) invalid("ownerModelDates.result");
    assertJsonValue(row.result, "ownerModelDates.result");
  }

  assertArray(outputs.blockedDays, "blockedDays");
  assertCapacity(outputs.blockedDays.length, ANALYTICS_V2_OUTPUT_LIMITS.days, "blockedDays");
  const blocked = new Set<string>();
  for (const day of outputs.blockedDays) {
    assertDay(day, "blockedDays");
    if (blocked.has(day)) invalid("blockedDays");
    blocked.add(day);
  }

  assertArray(outputs.dailyCandidates, "dailyCandidates");
  assertCapacity(outputs.dailyCandidates.length, ANALYTICS_V2_OUTPUT_LIMITS.days, "dailyCandidates");
  const candidateDays = new Set<string>();
  const dailyCandidates: PreparedDailyCandidate[] = [];
  for (const candidate of outputs.dailyCandidates) {
    if (!plainObject(candidate)) invalid("dailyCandidates");
    const day = assertDay(candidate.day, "dailyCandidates.day");
    if (candidateDays.has(day) || blocked.has(day)) invalid("dailyCandidates.day");
    candidateDays.add(day);
    if (!plainObject(candidate.payload) || candidate.payload.day !== day) {
      invalid("dailyCandidates.payload");
    }
    if (typeof candidate.payloadSha256 !== "string"
        || !ANALYTICS_V2_SHA256_PATTERN.test(candidate.payloadSha256)) {
      invalid("dailyCandidates.payloadSha256");
    }
    const digest = await analyticsV2DailyContentSha256(candidate.payload);
    if (digest !== candidate.payloadSha256) fail("ANALYTICS_V2_DAILY_DIGEST_MISMATCH", "dailyCandidates.payloadSha256");
    dailyCandidates.push({ day, payload: candidate.payload, payloadSha256: digest });
  }
  dailyCandidates.sort((left, right) => compareText(left.day, right.day));

  if (outputs.preview !== null) {
    if (outputs.preview === undefined) invalid("preview");
    assertJsonValue(outputs.preview, "preview");
  }

  assertArray(outputs.refusals, "refusals");
  assertCapacity(outputs.refusals.length, ANALYTICS_V2_OUTPUT_LIMITS.refusals, "refusals");
  const refusals: AnalyticsV2Refusal[] = [];
  for (const refusal of outputs.refusals) {
    if (!plainObject(refusal) || Object.keys(refusal).length !== 4) invalid("refusals");
    assertOwnerDigest(refusal.ownerDigest, owners, "refusals.ownerDigest");
    if (refusal.day !== null) assertDay(refusal.day, "refusals.day");
    if (!(ANALYTICS_V2_REFUSAL_FAMILIES as readonly string[]).includes(refusal.family)) invalid("refusals.family");
    if (!(ANALYTICS_V2_REFUSAL_REASONS as readonly string[]).includes(refusal.reason)) invalid("refusals.reason");
    refusals.push({
      ownerDigest: refusal.ownerDigest,
      day: refusal.day,
      family: refusal.family,
      reason: refusal.reason,
    });
  }
  refusals.sort((left, right) => compareText(refusalKey(left), refusalKey(right)));

  if (!plainObject(outputs.journal)) invalid("journal");
  const lastSequence = outputs.journal.lastSequence === null
    ? null
    : assertNonNegativeSafeInteger(outputs.journal.lastSequence, "journal.lastSequence");

  return {
    mode: outputs.mode,
    nowMs,
    revisionSeed,
    ownerDigests: [...owners].sort(compareText),
    computedOwnerDigests: [...computed].sort(compareText),
    dailyCandidates,
    blockedDays: sortedDays(blocked),
    refusals,
    lastSequence,
    timings: validTimings(outputs.timings, "timings"),
  };
}

/** Options for one run's write. The client must not be inside a transaction. */
export interface WriteAnalyticsV2RunOptions {
  /** The runtime (primary) schema holding the analytics_v2 tables. */
  readonly schema: string;
  /** Lowercase UUID naming this run (analytics_v2_runs.run_id). */
  readonly runId: string;
  /** Wall-clock start of the run (epoch ms); operational metadata only. */
  readonly startedAtMs: number;
  /**
   * The journal cursor read in the Job's snapshot before computing
   * (readAnalyticsV2RefreshState().cursor). A different value at write time
   * means another writer advanced it, and the run is refused.
   */
  readonly expectedCursor: string | null;
  /** The owner-scoped rows this run recomputes (required; see AnalyticsV2RunHorizon). */
  readonly horizon: AnalyticsV2RunHorizon;
  /** Phases the caller measured (for example "read"); merged into the run row. */
  readonly timings?: Readonly<Partial<Record<AnalyticsV2Phase, number>>>;
  /** Wall clock for finished_at and the write timing; defaults to Date.now. */
  readonly wallClock?: () => number;
}

export interface AnalyticsV2WriteReceipt {
  readonly runId: string;
  readonly state: "complete";
  readonly mode: AnalyticsV2Mode;
  readonly owners: number;
  readonly ownerDays: number;
  /** Owners with stored owner-scoped rows this run did not compute; their rows are retained. */
  readonly retainedOwners: number;
  readonly refusals: number;
  readonly publication: AnalyticsV2PublicationSummary;
  /** The journal cursor after the run, as a decimal string, or null when absent. */
  readonly cursor: string | null;
  readonly timings: Readonly<Partial<Record<AnalyticsV2Phase, number>>>;
}

interface StoredHeadRow {
  readonly day: string;
  readonly revision: number;
  readonly payload_sha256: string;
}

function rowsOf<Row>(result: unknown, operation: AnalyticsV2StoreErrorCode): Row[] {
  if (result === null || typeof result !== "object") fail(operation);
  const rows = Reflect.get(result, "rows");
  if (!Array.isArray(rows)) fail(operation);
  return rows as Row[];
}

function rowCountOf(result: unknown): number | null {
  if (result === null || typeof result !== "object") return null;
  const count = Reflect.get(result, "rowCount");
  return typeof count === "number" ? count : null;
}

/**
 * Insert JSON rows through jsonb_to_recordset in bounded chunks; every chunk
 * must affect exactly its own row count.
 */
async function forEachRecordsetChunk(
  rows: readonly unknown[],
  visit: (json: string, count: number) => Promise<void>,
): Promise<void> {
  let parts: string[] = [];
  let bytes = 2;
  const flush = async () => {
    if (parts.length === 0) return;
    await visit(`[${parts.join(",")}]`, parts.length);
    parts = [];
    bytes = 2;
  };
  for (const row of rows) {
    const json = JSON.stringify(row);
    if (parts.length >= CHUNK_MAX_ROWS || (parts.length > 0 && bytes + json.length + 1 > CHUNK_MAX_BYTES)) {
      await flush();
    }
    parts.push(json);
    bytes += json.length + 1;
  }
  await flush();
}

async function insertRecordset(
  client: PostgresClient,
  statement: string,
  rows: readonly unknown[],
  field: string,
  shortfall: AnalyticsV2StoreErrorCode = "ANALYTICS_V2_WRITE_FAILED",
): Promise<void> {
  await forEachRecordsetChunk(rows, async (json, count) => {
    const result = await client.query(statement, [json]);
    if (rowCountOf(result) !== count) fail(shortfall, field);
  });
}

/**
 * Persist one run's outputs atomically (see the module comment). Throws an
 * AnalyticsV2StoreError and leaves every analytics_v2 table unchanged on any
 * failure.
 */
export async function writeRunOutputs(
  client: PostgresClient,
  outputs: AnalyticsV2RunOutputs,
  options: WriteAnalyticsV2RunOptions,
): Promise<AnalyticsV2WriteReceipt> {
  if (client === null || typeof client !== "object" || typeof client.query !== "function"
      || options === null || typeof options !== "object") {
    fail("ANALYTICS_V2_RUN_INVALID");
  }
  const schema = quoteSchema(options.schema);
  if (typeof options.runId !== "string" || !UUID.test(options.runId)) fail("ANALYTICS_V2_RUN_INVALID", "runId");
  if (typeof options.startedAtMs !== "number" || !Number.isSafeInteger(options.startedAtMs)
      || options.startedAtMs < 0) {
    fail("ANALYTICS_V2_RUN_INVALID", "startedAtMs");
  }
  if (options.expectedCursor !== null
      && (typeof options.expectedCursor !== "string" || !DECIMAL.test(options.expectedCursor))) {
    fail("ANALYTICS_V2_RUN_INVALID", "expectedCursor");
  }
  const callerTimings = options.timings === undefined ? {} : validTimings(options.timings, "options.timings");
  const horizon = validHorizon(options.horizon);
  const wallClock = options.wallClock ?? Date.now;
  const prepared = await prepareOutputs(outputs, horizon);
  const writeStartedMs = wallClock();
  const runId = options.runId;
  const ownerDigests = prepared.ownerDigests;
  const computedOwners = prepared.computedOwnerDigests;
  const releasedAt = new Date(prepared.nowMs).toISOString();
  const tables = ANALYTICS_V2_TABLES;

  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(`SET LOCAL statement_timeout='${WRITE_STATEMENT_TIMEOUT_MILLISECONDS}ms'`);
    await client.query(`SET LOCAL lock_timeout='${WRITE_LOCK_TIMEOUT_MILLISECONDS}ms'`);

    const lock = rowsOf<{ acquired: unknown }>(await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",
      [ANALYTICS_V2_REFRESH_LOCK_KEY],
    ), "ANALYTICS_V2_WRITE_FAILED");
    if (lock[0]?.acquired !== true) fail("ANALYTICS_V2_REFRESH_LOCK_NOT_HELD");

    const cursorRows = rowsOf<{ last_sequence: unknown }>(await client.query(
      `SELECT last_sequence::text AS last_sequence FROM ${relation(schema, tables.journalCursor)}
        WHERE id=$1 FOR UPDATE`,
      [ANALYTICS_V2_SINGLETON_ID],
    ), "ANALYTICS_V2_WRITE_FAILED");
    const storedCursor = cursorRows.length === 0 ? null : cursorRows[0]?.last_sequence;
    if (storedCursor !== null && (typeof storedCursor !== "string" || !DECIMAL.test(storedCursor))) {
      fail("ANALYTICS_V2_STATE_INVALID", "journalCursor");
    }
    if (storedCursor !== options.expectedCursor) fail("ANALYTICS_V2_CURSOR_MOVED");
    if (prepared.lastSequence !== null && storedCursor !== null
        && BigInt(prepared.lastSequence) < BigInt(storedCursor)) {
      fail("ANALYTICS_V2_CURSOR_REGRESSION");
    }

    // Owner-scoped families: replace the computed owners' rows inside the
    // horizon; every other owner-scoped row is retained.
    const ownerTables = [tables.ownerDay, tables.cacheBands, tables.ownerFits, tables.ownerModelDates];
    const retained = rowsOf<{ retained: unknown }>(await client.query(
      `SELECT count(*)::integer AS retained FROM (
         ${ownerTables.map((name) => `SELECT owner_digest FROM ${relation(schema, name)}`).join("\nUNION\n")}
       ) present WHERE NOT (owner_digest = ANY($1::text[]))`,
      [computedOwners],
    ), "ANALYTICS_V2_WRITE_FAILED");
    const retainedOwners = retained[0]?.retained;
    if (typeof retainedOwners !== "number" || !Number.isSafeInteger(retainedOwners) || retainedOwners < 0) {
      fail("ANALYTICS_V2_WRITE_FAILED", "retainedOwners");
    }
    await client.query(
      `DELETE FROM ${relation(schema, tables.ownerDay)} WHERE owner_digest = ANY($1::text[]) AND day >= $2::date`,
      [computedOwners, horizon.ownerDayFromDay],
    );
    await client.query(
      `DELETE FROM ${relation(schema, tables.cacheBands)} WHERE owner_digest = ANY($1::text[]) AND day >= $2::date`,
      [computedOwners, horizon.cacheBandsFromDay],
    );
    for (const name of [tables.ownerFits, tables.ownerModelDates]) {
      await client.query(`DELETE FROM ${relation(schema, name)} WHERE owner_digest = ANY($1::text[])`, [computedOwners]);
    }

    await insertRecordset(client,
      `INSERT INTO ${relation(schema, tables.ownerDay)} (owner_digest, day, daily, refusal, run_id)
       SELECT owner_digest, day, daily, refusal, run_id
         FROM jsonb_to_recordset($1::jsonb)
           AS row(owner_digest text, day date, daily jsonb, refusal text, run_id uuid)`,
      outputs.ownerDays.map((row) => ({
        owner_digest: row.ownerDigest,
        day: row.day,
        daily: row.daily ?? null,
        refusal: row.refusal ?? null,
        run_id: runId,
      })),
      "ownerDays");

    const counterColumns = ANALYTICS_V2_CACHE_BAND_COUNTERS.join(", ");
    await insertRecordset(client,
      `INSERT INTO ${relation(schema, tables.cacheBands)}
         (owner_digest, day, model, effort, band, ${counterColumns}, run_id)
       SELECT owner_digest, day, model, effort, band, ${counterColumns}, run_id
         FROM jsonb_to_recordset($1::jsonb)
           AS row(owner_digest text, day date, model text, effort text, band text,
                  ${ANALYTICS_V2_CACHE_BAND_COUNTERS.map((name) => `${name} bigint`).join(", ")},
                  run_id uuid)`,
      outputs.cacheBands.map((row) => ({
        owner_digest: row.ownerDigest,
        day: row.day,
        model: row.model,
        effort: row.effort,
        band: row.band,
        ...Object.fromEntries(ANALYTICS_V2_CACHE_BAND_COUNTERS.map((name) => [name, row.counters[name]])),
        run_id: runId,
      })),
      "cacheBands");

    await insertRecordset(client,
      `INSERT INTO ${relation(schema, tables.ownerFits)} (owner_digest, as_of_day, fits, run_id)
       SELECT owner_digest, as_of_day, fits, run_id
         FROM jsonb_to_recordset($1::jsonb)
           AS row(owner_digest text, as_of_day date, fits jsonb, run_id uuid)`,
      outputs.ownerFits.map((row) => ({
        owner_digest: row.ownerDigest,
        as_of_day: row.asOfDay,
        fits: row.fits,
        run_id: runId,
      })),
      "ownerFits");

    await insertRecordset(client,
      `INSERT INTO ${relation(schema, tables.ownerModelDates)} (owner_digest, day, result, run_id)
       SELECT owner_digest, day, result, run_id
         FROM jsonb_to_recordset($1::jsonb)
           AS row(owner_digest text, day date, result jsonb, run_id uuid)`,
      outputs.ownerModelDates.map((row) => ({
        owner_digest: row.ownerDigest,
        day: row.day,
        result: row.result,
        run_id: runId,
      })),
      "ownerModelDates");

    // Published heads: write only days whose content digest changed. Blocked
    // days are never named here, so their prior rows stay untouched.
    const candidateDays = prepared.dailyCandidates.map((candidate) => candidate.day);
    const heads = new Map<string, StoredHeadRow>();
    if (candidateDays.length > 0) {
      for (const row of rowsOf<StoredHeadRow>(await client.query(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, revision, payload_sha256
           FROM ${relation(schema, tables.publishedDaily)}
          WHERE day = ANY($1::date[]) ORDER BY day FOR UPDATE`,
        [candidateDays],
      ), "ANALYTICS_V2_WRITE_FAILED")) {
        if (typeof row.day !== "string" || typeof row.revision !== "number"
            || !Number.isSafeInteger(row.revision) || row.revision < 1
            || typeof row.payload_sha256 !== "string") {
          fail("ANALYTICS_V2_STATE_INVALID", "publishedDaily");
        }
        heads.set(row.day, row);
      }
    }
    const published: AnalyticsV2Day[] = [];
    const unchanged: AnalyticsV2Day[] = [];
    const publishRows: unknown[] = [];
    for (const candidate of prepared.dailyCandidates) {
      const head = heads.get(candidate.day);
      if (head !== undefined && head.payload_sha256 === candidate.payloadSha256) {
        unchanged.push(candidate.day);
        continue;
      }
      const revision = Math.max(head?.revision ?? 0, prepared.revisionSeed) + 1;
      const payload = stampAnalyticsV2DailyPayload(candidate.payload, {
        day: candidate.day,
        revision,
        releasedAt,
      });
      published.push(candidate.day);
      publishRows.push({
        day: candidate.day,
        revision,
        released_at: releasedAt,
        payload,
        payload_sha256: candidate.payloadSha256,
        run_id: runId,
      });
    }
    // Size each payload exactly as 0059's CHECK does (its jsonb text form), so
    // an oversized day is refused with its own code rather than as 23514.
    await forEachRecordsetChunk(publishRows, async (chunk) => {
      const sizes = rowsOf<{ oversized: unknown }>(await client.query(
        `SELECT count(*)::integer AS oversized FROM jsonb_array_elements($1::jsonb) AS item
          WHERE octet_length((item -> 'payload')::text) > $2`,
        [chunk, ANALYTICS_V2_MAX_DAILY_PAYLOAD_BYTES],
      ), "ANALYTICS_V2_WRITE_FAILED");
      if (sizes[0]?.oversized !== 0) fail("ANALYTICS_V2_DAILY_PAYLOAD_TOO_LARGE", "dailyCandidates.payload");
    });
    // The heads are row-locked above. The upsert is still guarded (a new digest
    // and a strictly higher revision); any shortfall refuses the whole run.
    await insertRecordset(client,
      `INSERT INTO ${relation(schema, tables.publishedDaily)} AS head
         (day, revision, released_at, payload, payload_sha256, run_id)
       SELECT day, revision, released_at, payload, payload_sha256, run_id
         FROM jsonb_to_recordset($1::jsonb)
           AS row(day date, revision integer, released_at timestamptz, payload jsonb,
                  payload_sha256 text, run_id uuid)
       ON CONFLICT (day) DO UPDATE SET
         revision = EXCLUDED.revision,
         released_at = EXCLUDED.released_at,
         payload = EXCLUDED.payload,
         payload_sha256 = EXCLUDED.payload_sha256,
         run_id = EXCLUDED.run_id
       WHERE head.payload_sha256 <> EXCLUDED.payload_sha256
         AND head.revision < EXCLUDED.revision`,
      publishRows,
      "dailyCandidates",
      "ANALYTICS_V2_PUBLICATION_CONFLICT");

    await client.query(
      `INSERT INTO ${relation(schema, tables.preview)} (id, preview, computed_at, run_id)
       VALUES ($1, $2::jsonb, $3::timestamptz, $4::uuid)
       ON CONFLICT (id) DO UPDATE SET
         preview = EXCLUDED.preview, computed_at = EXCLUDED.computed_at, run_id = EXCLUDED.run_id`,
      [
        ANALYTICS_V2_SINGLETON_ID,
        outputs.preview === null ? null : JSON.stringify(outputs.preview),
        releasedAt,
        runId,
      ],
    );

    let cursor = storedCursor;
    if (prepared.lastSequence !== null && String(prepared.lastSequence) !== storedCursor) {
      await client.query(
        `INSERT INTO ${relation(schema, tables.journalCursor)} (id, last_sequence, run_id)
         VALUES ($1, $2::bigint, $3::uuid)
         ON CONFLICT (id) DO UPDATE SET last_sequence = EXCLUDED.last_sequence, run_id = EXCLUDED.run_id`,
        [ANALYTICS_V2_SINGLETON_ID, String(prepared.lastSequence), runId],
      );
      cursor = String(prepared.lastSequence);
    }

    const publication: AnalyticsV2PublicationSummary = {
      published: sortedDays(published),
      unchanged: sortedDays(unchanged),
      blocked: prepared.blockedDays,
    };
    const clockMs = wallClock();
    if (!Number.isSafeInteger(clockMs) || !Number.isSafeInteger(writeStartedMs)) {
      fail("ANALYTICS_V2_RUN_INVALID", "wallClock");
    }
    // Operational metadata only: a wall clock stepped backwards must not fail
    // a run, so finished_at is clamped to started_at.
    const finishedAtMs = Math.max(clockMs, options.startedAtMs);
    const timings = {
      ...prepared.timings,
      ...callerTimings,
      write: Math.max(0, clockMs - writeStartedMs),
    };
    await client.query(
      `INSERT INTO ${relation(schema, tables.runs)}
         (run_id, started_at, finished_at, mode, state, owners, owner_days, refusals, publication, timings)
       VALUES ($1::uuid, $2::timestamptz, $3::timestamptz, $4, 'complete', $5, $6,
               $7::jsonb, $8::jsonb, $9::jsonb)`,
      [
        runId,
        new Date(options.startedAtMs).toISOString(),
        new Date(finishedAtMs).toISOString(),
        prepared.mode,
        ownerDigests.length,
        outputs.ownerDays.length,
        JSON.stringify(prepared.refusals),
        JSON.stringify(publication),
        JSON.stringify(timings),
      ],
    );
    await client.query("COMMIT");
    transactionStarted = false;
    return Object.freeze({
      runId,
      state: "complete",
      mode: prepared.mode,
      owners: ownerDigests.length,
      ownerDays: outputs.ownerDays.length,
      retainedOwners,
      refusals: prepared.refusals.length,
      publication,
      cursor,
      timings,
    });
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The caller discards the connection; the transaction cannot commit.
      }
    }
    if (error instanceof AnalyticsV2StoreError) throw error;
    const sqlState = sqlStateOf(error);
    throw new AnalyticsV2StoreError("ANALYTICS_V2_WRITE_FAILED", sqlState === undefined ? {} : { sqlState });
  }
}

/** The prior state a run starts from, read inside the Job's read snapshot. */
export interface AnalyticsV2RefreshState {
  /** analytics_v2_journal_cursor.last_sequence as a decimal string, or null when absent. */
  readonly cursor: string | null;
  /**
   * Days the latest completed run reported blocked. They stay pending (queue
   * semantics: a blocked day is not consumed) until a run publishes them.
   */
  readonly carriedBlockedDays: readonly AnalyticsV2Day[];
  /**
   * The earliest day with a stored cache-band row, or null. The next run's
   * cache horizon reaches back at least this far, so stored cache history is
   * recomputed rather than dropped.
   */
  readonly cacheFloorDay: AnalyticsV2Day | null;
}

/**
 * Read the cursor, the carried blocked days and the cache floor. Runs in the
 * caller's transaction (the Job's read snapshot).
 */
export async function readAnalyticsV2RefreshState(
  client: PostgresClient,
  options: { readonly schema: string },
): Promise<AnalyticsV2RefreshState> {
  if (client === null || typeof client !== "object" || typeof client.query !== "function"
      || options === null || typeof options !== "object") {
    fail("ANALYTICS_V2_RUN_INVALID");
  }
  const schema = quoteSchema(options.schema);
  let cursorRows: { last_sequence: unknown }[];
  let runRows: { blocked: unknown }[];
  let floorRows: { day: unknown }[];
  try {
    cursorRows = rowsOf(await client.query(
      `SELECT last_sequence::text AS last_sequence
         FROM ${relation(schema, ANALYTICS_V2_TABLES.journalCursor)} WHERE id=$1`,
      [ANALYTICS_V2_SINGLETON_ID],
    ), "ANALYTICS_V2_READ_FAILED");
    runRows = rowsOf(await client.query(
      `SELECT publication -> 'blocked' AS blocked
         FROM ${relation(schema, ANALYTICS_V2_TABLES.runs)}
        WHERE state = 'complete'
        ORDER BY finished_at DESC, started_at DESC, run_id DESC LIMIT 1`,
    ), "ANALYTICS_V2_READ_FAILED");
    floorRows = rowsOf(await client.query(
      `SELECT to_char(min(day), 'YYYY-MM-DD') AS day FROM ${relation(schema, ANALYTICS_V2_TABLES.cacheBands)}`,
    ), "ANALYTICS_V2_READ_FAILED");
  } catch (error) {
    if (error instanceof AnalyticsV2StoreError) throw error;
    const sqlState = sqlStateOf(error);
    throw new AnalyticsV2StoreError("ANALYTICS_V2_READ_FAILED", sqlState === undefined ? {} : { sqlState });
  }
  const cursor = cursorRows.length === 0 ? null : cursorRows[0]?.last_sequence;
  if (cursor !== null && (typeof cursor !== "string" || !DECIMAL.test(cursor))) {
    fail("ANALYTICS_V2_STATE_INVALID", "journalCursor");
  }
  const blocked = runRows.length === 0 ? [] : runRows[0]?.blocked;
  if (!Array.isArray(blocked) || blocked.length > ANALYTICS_V2_OUTPUT_LIMITS.days
      || blocked.some((day) => !isAnalyticsV2Day(day))) {
    fail("ANALYTICS_V2_STATE_INVALID", "runs.publication");
  }
  const cacheFloorDay = floorRows.length === 0 ? null : floorRows[0]?.day ?? null;
  if (floorRows.length > 1 || (cacheFloorDay !== null && !isAnalyticsV2Day(cacheFloorDay))) {
    fail("ANALYTICS_V2_STATE_INVALID", "cacheBands");
  }
  return Object.freeze({
    cursor,
    carriedBlockedDays: Object.freeze(sortedDays(blocked as AnalyticsV2Day[])),
    cacheFloorDay: cacheFloorDay as AnalyticsV2Day | null,
  });
}
