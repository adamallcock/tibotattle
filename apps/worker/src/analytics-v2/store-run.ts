/**
 * analytics_v2 store, run side (K-SPLIT): the closed output validation every
 * write starts with, the shared chunked-insert helpers, the run's lock and
 * journal cursor, the run row, and the prior-state read. store.ts composes
 * these with store-derived.ts and store-publication.ts into the one write
 * transaction (writeRunOutputs); it re-exports this module's public names.
 *
 * Moved out of store.ts unchanged in behaviour. Errors carry closed codes, a
 * field path at most and a SQLSTATE; never a driver message, SQL text, bind
 * value or kernel value.
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
  type AnalyticsV2OwnerResources,
  type AnalyticsV2Phase,
  type AnalyticsV2PublicationSummary,
  type AnalyticsV2Refusal,
  type AnalyticsV2RunOutputs,
  type AnalyticsV2RunResources,
} from "./contract";
import { ANALYTICS_V2_NO_EXCLUSIONS_SHA256 } from "./exclusions";
import { validAnalyticsV2KernelEntry, type AnalyticsV2RunStamp } from "./kernel";

/**
 * REV-SEED's revision-floor tables (staged migration
 * analytics_v2_revision_floor): Cloudflare's last published revision per day
 * and the floor's singleton provenance. The cutover import writes them once;
 * the store and the Job only read them. They are named here, in the store's
 * plumbing, not in contract.ts: contract.ts is in the kernel compute closure
 * (cloud-run/analytics-kernel-closure.mjs), and a revision floor decides no
 * kernel value, so naming it there would mint a new compute class.
 */
export const ANALYTICS_V2_REVISION_FLOOR_TABLES = Object.freeze({
  revisionFloor: "analytics_v2_revision_floor",
  revisionFloorSource: "analytics_v2_revision_floor_source",
} as const);
/** Their columns, in DDL order, and primary keys (the PG17 spec holds the migration to them). */
export const ANALYTICS_V2_REVISION_FLOOR_COLUMNS = Object.freeze({
  revisionFloor: Object.freeze(["day", "revision"] as const),
  revisionFloorSource: Object.freeze([
    "id", "provenance", "seal_id", "floor_sha256", "fence_receipt_sha256", "analytics_bookmark_sha256",
    "source_commit", "captured_at", "day_count", "max_revision", "loaded_at",
  ] as const),
} as const);
export const ANALYTICS_V2_REVISION_FLOOR_PRIMARY_KEYS = Object.freeze({
  revisionFloor: Object.freeze(["day"] as const),
  revisionFloorSource: Object.freeze(["id"] as const),
} as const);

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

/**
 * Bounded outputs: a run beyond these is refused before any write. `owners`
 * equals A-1's roster bound (owners.ts MAX_ANALYTICS_V2_OWNERS), so every
 * roster A-1 can list can be written.
 */
export const ANALYTICS_V2_OUTPUT_LIMITS = Object.freeze({
  owners: 100_000,
  ownerDays: 4_000_000,
  cacheBands: 8_000_000,
  ownerModelDates: 2_000_000,
  days: 4_096,
  refusals: 4_000_000,
});

export const WRITE_STATEMENT_TIMEOUT_MILLISECONDS = 300_000;
export const WRITE_LOCK_TIMEOUT_MILLISECONDS = 5_000;
const CHUNK_MAX_ROWS = 5_000;
const CHUNK_MAX_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const CACHE_LABEL = /^[A-Za-z0-9._:-]{1,64}$/u;
export const DECIMAL = /^(?:0|[1-9]\d{0,18})$/u;
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
  | "ANALYTICS_V2_WRITE_FAILED"
  | "ANALYTICS_V2_KERNEL_CONFLICT"
  | "ANALYTICS_V2_KERNEL_REGRESSION";

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

export function fail(code: AnalyticsV2StoreErrorCode, field?: string): never {
  throw new AnalyticsV2StoreError(code, field === undefined ? {} : { field });
}

export function invalid(field: string): never {
  fail("ANALYTICS_V2_OUTPUTS_INVALID", field);
}

export function sqlStateOf(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  try {
    const code = Reflect.get(error, "code");
    return typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

export function quoteSchema(schema: unknown): string {
  if (typeof schema !== "string" || !SCHEMA_IDENTIFIER.test(schema)
      || schema.startsWith("pg_") || schema === "information_schema") {
    fail("ANALYTICS_V2_SCHEMA_INVALID");
  }
  return `"${schema}"`;
}

export function relation(schema: string, table: string): string {
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

export function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Refuse anything JSON or jsonb would silently alter: undefined, functions,
 * symbols, bigint, non-finite numbers, NUL characters, class instances (Map,
 * Date) and excessive depth.
 */
export function assertJsonValue(value: unknown, field: string, depth = 0): void {
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

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortedDays(days: Iterable<AnalyticsV2Day>): AnalyticsV2Day[] {
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

export function assertNonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(field);
  return value;
}

export interface PreparedDailyCandidate {
  readonly day: AnalyticsV2Day;
  readonly payload: Record<string, unknown>;
  readonly payloadSha256: string;
}

export interface PreparedOutputs {
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
  readonly resources: AnalyticsV2RunResources | null;
}

function refusalKey(refusal: AnalyticsV2Refusal): string {
  return `${refusal.ownerDigest}\u0001${refusal.day ?? ""}\u0001${refusal.family}\u0001${refusal.reason}`;
}

export function validTimings(value: unknown, field: string): Partial<Record<AnalyticsV2Phase, number>> {
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

const RESOURCE_CONFIGURATION_KEYS =
  "maxDayOccurrences,maxDayRecordBytes,memoryBudgetBytes,memoryModel,outputBudgetBytes,outputModel";
const OWNER_RESOURCE_KEYS =
  "admitted,analysisUsage,estimateBytes,heapPeakBytes,maxDayOccurrences,outputBytes,ownerDigest,quota,session,usage";
const MEMORY_MODEL = /^analytics-v2-memory-model-v[0-9]+$/u;
const OUTPUT_MODEL = /^analytics-v2-output-model-v[0-9]+$/u;

/**
 * The run's resource record (contract AnalyticsV2RunResources): closed keys,
 * one entry per effective owner in digest order, and `admitted` false exactly
 * for the owners refused as a whole (an owner-family refusal).
 */
function validResources(value: unknown, effective: ReadonlySet<string>,
  refusedOwners: ReadonlySet<string>): AnalyticsV2RunResources | null {
  if (value === undefined) return null;
  if (!plainObject(value) || Object.keys(value).sort().join(",") !== "account,configuration,owners") invalid("resources");
  const configuration = value.configuration;
  if (!plainObject(configuration) || Object.keys(configuration).sort().join(",") !== RESOURCE_CONFIGURATION_KEYS
      || typeof configuration.memoryModel !== "string" || !MEMORY_MODEL.test(configuration.memoryModel)
      || typeof configuration.outputModel !== "string" || !OUTPUT_MODEL.test(configuration.outputModel)) {
    invalid("resources.configuration");
  }
  for (const name of ["memoryBudgetBytes", "maxDayOccurrences", "maxDayRecordBytes", "outputBudgetBytes"]) {
    if (assertNonNegativeSafeInteger(configuration[name], `resources.configuration.${name}`) < 1) {
      invalid(`resources.configuration.${name}`);
    }
  }
  assertArray(value.owners, "resources.owners");
  assertCapacity(value.owners.length, ANALYTICS_V2_OUTPUT_LIMITS.owners, "resources.owners");
  const owners: AnalyticsV2OwnerResources[] = [];
  let previous = "";
  for (const entry of value.owners) {
    if (!plainObject(entry) || Object.keys(entry).sort().join(",") !== OWNER_RESOURCE_KEYS) invalid("resources.owners");
    assertOwnerDigest(entry.ownerDigest, effective, "resources.owners.ownerDigest");
    if ((entry.ownerDigest as string) <= previous) invalid("resources.owners.ownerDigest");
    previous = entry.ownerDigest as string;
    for (const name of ["usage", "quota", "session", "analysisUsage", "maxDayOccurrences", "estimateBytes",
      "outputBytes"]) {
      assertNonNegativeSafeInteger(entry[name], `resources.owners.${name}`);
    }
    if (typeof entry.admitted !== "boolean" || entry.admitted === refusedOwners.has(entry.ownerDigest as string)) {
      invalid("resources.owners.admitted");
    }
    if (entry.heapPeakBytes !== null) assertNonNegativeSafeInteger(entry.heapPeakBytes, "resources.owners.heapPeakBytes");
    if (!entry.admitted && entry.heapPeakBytes !== null) invalid("resources.owners.heapPeakBytes");
    owners.push(entry as unknown as AnalyticsV2OwnerResources);
  }
  if (owners.length !== effective.size) invalid("resources.owners");
  const account = value.account;
  if (!plainObject(account)
      || Object.keys(account).sort().join(",") !== "accountBytes,heldInputBytes,outputBudgetBytes") {
    invalid("resources.account");
  }
  const heldInputBytes = assertNonNegativeSafeInteger(account.heldInputBytes, "resources.account.heldInputBytes");
  const accountBytes = assertNonNegativeSafeInteger(account.accountBytes, "resources.account.accountBytes");
  const outputBudgetBytes = assertNonNegativeSafeInteger(account.outputBudgetBytes,
    "resources.account.outputBudgetBytes");
  if (heldInputBytes > accountBytes
      || owners.reduce((total, entry) => total + entry.outputBytes, heldInputBytes) > accountBytes) {
    invalid("resources.account");
  }
  // The budget the account was held to: the configured one, or that plus the
  // part of the memory budget the largest admitted estimate left
  // (resources.ts analyticsV2OutputBudget). A completed run stayed within it.
  const configuredOutput = configuration.outputBudgetBytes as number;
  const largestAdmitted = owners.filter((entry) => entry.admitted)
    .reduce((largest, entry) => Math.max(largest, entry.estimateBytes), 0);
  const memoryBudget = configuration.memoryBudgetBytes as number;
  if (accountBytes > outputBudgetBytes || largestAdmitted > memoryBudget
      || (outputBudgetBytes !== configuredOutput
        && outputBudgetBytes !== configuredOutput + memoryBudget - largestAdmitted)) {
    invalid("resources.account.outputBudgetBytes");
  }
  return { configuration: configuration as unknown as AnalyticsV2RunResources["configuration"], owners,
    account: { heldInputBytes, accountBytes, outputBudgetBytes } };
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

export function validHorizon(value: unknown): AnalyticsV2RunHorizon {
  if (!plainObject(value) || !isAnalyticsV2Day(value.ownerDayFromDay)
      || !isAnalyticsV2Day(value.cacheBandsFromDay)) {
    fail("ANALYTICS_V2_RUN_INVALID", "horizon");
  }
  return { ownerDayFromDay: value.ownerDayFromDay, cacheBandsFromDay: value.cacheBandsFromDay };
}

export async function prepareOutputs(outputs: AnalyticsV2RunOutputs, horizon: AnalyticsV2RunHorizon): Promise<PreparedOutputs> {
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
  // An effective owner refused as a whole (an owner-family refusal, such as
  // memory_budget) was not computed: it writes no owner-scoped row and its
  // stored rows are retained like any other uncomputed owner's.
  const effective = new Set(computed);
  assertArray(outputs.refusals, "refusals");
  const refusedOwners = new Set<string>();
  for (const refusal of outputs.refusals) {
    if (plainObject(refusal) && refusal.family === "owner" && typeof refusal.ownerDigest === "string"
        && effective.has(refusal.ownerDigest)) {
      refusedOwners.add(refusal.ownerDigest);
      computed.delete(refusal.ownerDigest);
    }
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
    resources: validResources(outputs.resources, effective, refusedOwners),
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
  /** The kernel and manifest every row of this run is stamped with (K-STAMP, kernel.ts). */
  readonly stamp: AnalyticsV2RunStamp;
  /**
   * The digest of the community aggregate exclusions the run read and
   * applied (N-EXCL, owners.ts readAnalyticsV2Exclusions().sha256), recorded
   * on the run row so the next run can tell when they changed.
   */
  readonly exclusionsSha256: string;
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

export interface StoredHeadRow {
  readonly day: string;
  readonly revision: number;
  readonly payload_sha256: string;
}

export function rowsOf<Row>(result: unknown, operation: AnalyticsV2StoreErrorCode): Row[] {
  if (result === null || typeof result !== "object") fail(operation);
  const rows = Reflect.get(result, "rows");
  if (!Array.isArray(rows)) fail(operation);
  return rows as Row[];
}

export function rowCountOf(result: unknown): number | null {
  if (result === null || typeof result !== "object") return null;
  const count = Reflect.get(result, "rowCount");
  return typeof count === "number" ? count : null;
}

/**
 * Insert JSON rows through jsonb_to_recordset in bounded chunks; every chunk
 * must affect exactly its own row count. Rows are taken from an iterable, so
 * a caller can map them lazily and the write holds one chunk of row copies,
 * not a copy of a whole family (the run's outputs are already in the heap,
 * charged to the output account).
 */
export async function forEachRecordsetChunk(
  rows: Iterable<unknown>,
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

/** `rows` mapped one at a time, as forEachRecordsetChunk consumes them. */
export function* mapped<Row, Mapped>(rows: readonly Row[], map: (row: Row) => Mapped): Generator<Mapped> {
  for (const row of rows) yield map(row);
}

export async function insertRecordset(
  client: PostgresClient,
  statement: string,
  rows: Iterable<unknown>,
  field: string,
  shortfall: AnalyticsV2StoreErrorCode = "ANALYTICS_V2_WRITE_FAILED",
): Promise<void> {
  await forEachRecordsetChunk(rows, async (json, count) => {
    const result = await client.query(statement, [json]);
    if (rowCountOf(result) !== count) fail(shortfall, field);
  });
}


/**
 * Re-take the refresh advisory lock at transaction scope (re-entrant for the
 * Job's session that already holds it; any other session is refused) and
 * re-read the journal cursor FOR UPDATE, refusing a cursor that moved since
 * the Job's read snapshot or one this run would move backwards. Returns the
 * stored cursor.
 */
export async function lockAnalyticsV2Run(client: PostgresClient, schema: string,
  expectedCursor: string | null, lastSequence: number | null): Promise<string | null> {
  const lock = rowsOf<{ acquired: unknown }>(await client.query(
    "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",
    [ANALYTICS_V2_REFRESH_LOCK_KEY],
  ), "ANALYTICS_V2_WRITE_FAILED");
  if (lock[0]?.acquired !== true) fail("ANALYTICS_V2_REFRESH_LOCK_NOT_HELD");

  const cursorRows = rowsOf<{ last_sequence: unknown }>(await client.query(
    `SELECT last_sequence::text AS last_sequence FROM ${relation(schema, ANALYTICS_V2_TABLES.journalCursor)}
      WHERE id=$1 FOR UPDATE`,
    [ANALYTICS_V2_SINGLETON_ID],
  ), "ANALYTICS_V2_WRITE_FAILED");
  const storedCursor = cursorRows.length === 0 ? null : cursorRows[0]?.last_sequence;
  if (storedCursor !== null && (typeof storedCursor !== "string" || !DECIMAL.test(storedCursor))) {
    fail("ANALYTICS_V2_STATE_INVALID", "journalCursor");
  }
  if (storedCursor !== expectedCursor) fail("ANALYTICS_V2_CURSOR_MOVED");
  if (lastSequence !== null && storedCursor !== null && BigInt(lastSequence) < BigInt(storedCursor)) {
    fail("ANALYTICS_V2_CURSOR_REGRESSION");
  }
  return storedCursor as string | null;
}

/** Advance the journal cursor to `lastSequence` (never backwards); returns the cursor after the run. */
export async function advanceAnalyticsV2Cursor(client: PostgresClient, schema: string,
  storedCursor: string | null, lastSequence: number | null, runId: string): Promise<string | null> {
  if (lastSequence === null || String(lastSequence) === storedCursor) return storedCursor;
  await client.query(
    `INSERT INTO ${relation(schema, ANALYTICS_V2_TABLES.journalCursor)} (id, last_sequence, run_id)
     VALUES ($1, $2::bigint, $3::uuid)
     ON CONFLICT (id) DO UPDATE SET last_sequence = EXCLUDED.last_sequence, run_id = EXCLUDED.run_id`,
    [ANALYTICS_V2_SINGLETON_ID, String(lastSequence), runId],
  );
  return String(lastSequence);
}

/** Insert the run row (analytics_v2_runs). */
export async function insertAnalyticsV2RunRow(client: PostgresClient, schema: string, row: {
  readonly runId: string; readonly startedAtMs: number; readonly finishedAtMs: number;
  readonly mode: AnalyticsV2Mode; readonly owners: number; readonly ownerDays: number;
  readonly refusals: readonly AnalyticsV2Refusal[]; readonly publication: AnalyticsV2PublicationSummary;
  readonly timings: Readonly<Record<string, unknown>>;
  readonly stamp: AnalyticsV2RunStamp; readonly compatibilitySha256: string | null;
  readonly exclusionsSha256: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO ${relation(schema, ANALYTICS_V2_TABLES.runs)}
       (run_id, started_at, finished_at, mode, state, owners, owner_days, refusals, publication, timings,
        kernel_id, manifest_version, compatibility_sha256, exclusions_sha256)
     VALUES ($1::uuid, $2::timestamptz, $3::timestamptz, $4, 'complete', $5, $6,
             $7::jsonb, $8::jsonb, $9::jsonb, $10::smallint, $11::integer, $12, $13)`,
    [
      row.runId,
      new Date(row.startedAtMs).toISOString(),
      new Date(row.finishedAtMs).toISOString(),
      row.mode,
      row.owners,
      row.ownerDays,
      JSON.stringify(row.refusals),
      JSON.stringify(row.publication),
      JSON.stringify(row.timings),
      row.stamp.kernel.kernelId,
      row.stamp.manifestVersion,
      row.compatibilitySha256,
      row.exclusionsSha256,
    ],
  );
}

/** A run stamp with a well-formed registry entry and manifest version (kernel.ts). */
export function validRunStamp(value: unknown): AnalyticsV2RunStamp {
  if (!plainObject(value) || Object.keys(value).sort().join(",") !== "kernel,manifestVersion"
      || !Number.isSafeInteger(value.manifestVersion) || (value.manifestVersion as number) < 1
      || (value.manifestVersion as number) > 2_147_483_647) {
    fail("ANALYTICS_V2_RUN_INVALID", "stamp");
  }
  try {
    return Object.freeze({ kernel: validAnalyticsV2KernelEntry(value.kernel), manifestVersion: value.manifestVersion as number });
  } catch {
    return fail("ANALYTICS_V2_RUN_INVALID", "stamp.kernel");
  }
}

/**
 * Register the run's kernel (K-STAMP) inside the write transaction: insert its
 * registry row unless present, refuse a stored row that disagrees
 * (ANALYTICS_V2_KERNEL_CONFLICT: the same id with another identity, or the
 * same identity under another id), and refuse a run whose kernel is older
 * than one that already wrote (ANALYTICS_V2_KERNEL_REGRESSION). Every stamped
 * write commits with its run row, so the run rows hold the newest writer.
 */
export async function registerAnalyticsV2RunKernel(client: PostgresClient, schema: string,
  stamp: AnalyticsV2RunStamp, registeredAt: string): Promise<void> {
  const kernel = stamp.kernel;
  const kernels = relation(schema, ANALYTICS_V2_TABLES.kernels);
  await client.query(
    `INSERT INTO ${kernels} (kernel_id, production_commit, vendor_manifest_sha256, compute_closure_sha256,
       price_registry_sha256, price_registry_version, method_version, registered_at)
     VALUES ($1::smallint, $2, $3, $4, $5, $6, $7, $8::timestamptz)
     ON CONFLICT DO NOTHING`,
    [kernel.kernelId, kernel.productionCommit, kernel.vendorManifestSha256, kernel.computeClosureSha256,
      kernel.priceRegistrySha256, kernel.priceRegistryVersion, kernel.methodVersion, registeredAt],
  );
  const stored = rowsOf<Record<string, unknown>>(await client.query(
    `SELECT kernel_id, production_commit, vendor_manifest_sha256, compute_closure_sha256, price_registry_sha256,
            price_registry_version, method_version
       FROM ${kernels}
      WHERE kernel_id = $1::smallint
         OR (vendor_manifest_sha256 = $2 AND compute_closure_sha256 = $3 AND method_version = $4)`,
    [kernel.kernelId, kernel.vendorManifestSha256, kernel.computeClosureSha256, kernel.methodVersion],
  ), "ANALYTICS_V2_WRITE_FAILED");
  const row = stored[0];
  if (stored.length !== 1 || row === undefined || row.kernel_id !== kernel.kernelId
      || row.production_commit !== kernel.productionCommit || row.vendor_manifest_sha256 !== kernel.vendorManifestSha256
      || row.compute_closure_sha256 !== kernel.computeClosureSha256
      || row.price_registry_sha256 !== kernel.priceRegistrySha256
      || row.price_registry_version !== kernel.priceRegistryVersion || row.method_version !== kernel.methodVersion) {
    fail("ANALYTICS_V2_KERNEL_CONFLICT");
  }
  const newest = rowsOf<{ newest: unknown }>(await client.query(
    `SELECT max(kernel_id)::integer AS newest FROM ${relation(schema, ANALYTICS_V2_TABLES.runs)}`,
  ), "ANALYTICS_V2_WRITE_FAILED")[0]?.newest;
  if (newest !== null && newest !== undefined && (typeof newest !== "number" || newest > kernel.kernelId)) {
    fail("ANALYTICS_V2_KERNEL_REGRESSION");
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
  /**
   * The exclusions digest the latest completed run applied (N-EXCL). A run
   * written before the run-stamps migration applied none: its NULL reads as
   * ANALYTICS_V2_NO_EXCLUSIONS_SHA256, the digest of no rows.
   */
  readonly appliedExclusionsSha256: string;
  /** Every day with a published head, ascending (republished when the exclusions change). */
  readonly publishedDays: readonly AnalyticsV2Day[];
  /**
   * The cutover's revision floor (REV-SEED), content-free: whether its
   * singleton provenance row exists, and the day count and largest revision
   * it records (0 and 0 when absent). The Job refuses a production run
   * without one (ANALYTICS_V2_REVISION_FLOOR_ABSENT); the store applies the
   * day rows whatever the target.
   */
  readonly revisionFloor: AnalyticsV2RevisionFloorSummary;
}

/** The content-free summary of the revision floor a run reads (REV-SEED). */
export interface AnalyticsV2RevisionFloorSummary {
  readonly present: boolean;
  readonly dayCount: number;
  readonly maxRevision: number;
}

/**
 * Read the cursor, the carried blocked days, the cache floor, the applied
 * exclusions digest, the published days and the revision floor's summary.
 * Runs in the caller's transaction
 * (the Job's read snapshot).
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
  let runRows: { blocked: unknown; exclusions_sha256: unknown }[];
  let floorRows: { day: unknown }[];
  let publishedRows: { day: unknown }[];
  let revisionFloorRows: { day_count: unknown; max_revision: unknown }[];
  try {
    cursorRows = rowsOf(await client.query(
      `SELECT last_sequence::text AS last_sequence
         FROM ${relation(schema, ANALYTICS_V2_TABLES.journalCursor)} WHERE id=$1`,
      [ANALYTICS_V2_SINGLETON_ID],
    ), "ANALYTICS_V2_READ_FAILED");
    runRows = rowsOf(await client.query(
      `SELECT publication -> 'blocked' AS blocked, exclusions_sha256
         FROM ${relation(schema, ANALYTICS_V2_TABLES.runs)}
        WHERE state = 'complete'
        ORDER BY finished_at DESC, started_at DESC, run_id DESC LIMIT 1`,
    ), "ANALYTICS_V2_READ_FAILED");
    floorRows = rowsOf(await client.query(
      `SELECT to_char(min(day), 'YYYY-MM-DD') AS day FROM ${relation(schema, ANALYTICS_V2_TABLES.cacheBands)}`,
    ), "ANALYTICS_V2_READ_FAILED");
    publishedRows = rowsOf(await client.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM ${relation(schema, ANALYTICS_V2_TABLES.publishedDaily)}
        ORDER BY day LIMIT $1`, [ANALYTICS_V2_OUTPUT_LIMITS.days + 1],
    ), "ANALYTICS_V2_READ_FAILED");
    revisionFloorRows = rowsOf(await client.query(
      `SELECT day_count, max_revision FROM ${relation(schema, ANALYTICS_V2_REVISION_FLOOR_TABLES.revisionFloorSource)} WHERE id=$1`,
      [ANALYTICS_V2_SINGLETON_ID],
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
  const applied = runRows.length === 0 ? null : runRows[0]?.exclusions_sha256 ?? null;
  if (applied !== null && (typeof applied !== "string" || !ANALYTICS_V2_SHA256_PATTERN.test(applied))) {
    fail("ANALYTICS_V2_STATE_INVALID", "runs.exclusions");
  }
  const publishedDays = publishedRows.map((row) => row.day);
  if (publishedDays.length > ANALYTICS_V2_OUTPUT_LIMITS.days || !publishedDays.every(isAnalyticsV2Day)) {
    fail("ANALYTICS_V2_STATE_INVALID", "publishedDaily");
  }
  const floorRow = revisionFloorRows[0];
  if (revisionFloorRows.length > 1 || (floorRow !== undefined
      && (!Number.isSafeInteger(floorRow.day_count) || (floorRow.day_count as number) < 1
        || !Number.isSafeInteger(floorRow.max_revision) || (floorRow.max_revision as number) < 1
        || (floorRow.max_revision as number) > ANALYTICS_V2_MAX_REVISION_SEED))) {
    fail("ANALYTICS_V2_STATE_INVALID", "revisionFloor");
  }
  const revisionFloor: AnalyticsV2RevisionFloorSummary = floorRow === undefined
    ? Object.freeze({ present: false, dayCount: 0, maxRevision: 0 })
    : Object.freeze({ present: true, dayCount: floorRow.day_count as number,
      maxRevision: floorRow.max_revision as number });
  return Object.freeze({
    cursor,
    carriedBlockedDays: Object.freeze(sortedDays(blocked as AnalyticsV2Day[])),
    cacheFloorDay: cacheFloorDay as AnalyticsV2Day | null,
    appliedExclusionsSha256: (applied as string | null) ?? ANALYTICS_V2_NO_EXCLUSIONS_SHA256,
    publishedDays: Object.freeze(publishedDays as AnalyticsV2Day[]),
    revisionFloor,
  });
}
