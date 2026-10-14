/**
 * PostgreSQL performance reports (SPD-G3): dictionary-aware admission and the
 * bounded device-scoped read for the accountless daily model-performance
 * intake on primary migration 0079_performance_telemetry.sql.
 *
 * The oracle is the D1 Worker's telemetry-performance-repository.ts: its
 * closed report parser (parseTelemetryPerformanceReport), its admission
 * (admitTelemetryPerformanceReport) and its read
 * (readTelemetryPerformanceReports). The statuses, error codes and DTOs are
 * the Worker's, with these deliberate differences:
 *
 *   - Every field dictionary the contract registry lists as `accepted` is
 *     admitted, each with the bucket scheme it pairs with (owner decision 3 of
 *     2026-10-10). The legacy Worker stays pinned to 2026-09-29.1.
 *   - A report whose dictionary differs from the device's server-side
 *     capability is 403 TELEMETRY_TRANSPORT_BLOCKED (gate answer 6). The
 *     client re-grants on restart; a 409 would be counted as delivered and
 *     the day silently dropped.
 *   - Invalid reports carry a closed, content-free detail
 *     (PostgresTelemetryPerformanceRecordInvalidError.detail) that only the
 *     refusal counters read. The response body is unchanged: the detail is
 *     never a public detail.
 *   - The report/day advisory lock (the 0079 SQL function the admission
 *     trigger takes, never re-derived here) is taken before the idempotency
 *     read, so concurrent identical POSTs give one write and one idempotent
 *     answer. A unique-index race that still escapes it is re-read and
 *     answered idempotent.
 *   - A new admission or replacement must name a report day inside the
 *     server-time window: from POSTGRES_TELEMETRY_PERFORMANCE_REPORT_DAY_PAST_DAYS
 *     days before the server's UTC day (the injected nowEpoch) through
 *     POSTGRES_TELEMETRY_PERFORMANCE_REPORT_DAY_FUTURE_DAYS day after it.
 *     Outside it the report is 409 TELEMETRY_RECORD_INVALID with the closed
 *     detail REPORT_DAY_OUT_OF_WINDOW and nothing is written. The window is
 *     checked after the idempotency read, so an exact replay of a stored
 *     revision still answers idempotent wherever its day now falls. The D1
 *     Worker has no such bound; without it one device could stretch the
 *     public 'all' period or withhold every publication slot with reports
 *     dated years away from the present.
 *   - The capability is the one the route read immediately before decryption
 *     (D1 parity: the envelope carries no mutable authorization). Its revision
 *     and epoch are what the report row records; the 0079 admission trigger
 *     re-proves the whole fence (active runtime, current unexpired capability
 *     and grant heads, active accountless owner graph) inside this
 *     transaction and is the authority. Its refusal is 403.
 *
 * There is no deletion function: accepted evidence is not withdrawn (decision
 * D2, Variant B), and the online-erasure absence gate forbids one.
 *
 * Privacy: rows hold closed labels, counts, digests and instants only; the
 * plaintext report is not retained. Every failure is an ApiError; provider
 * messages, SQL and bind values never leave this module.
 */
import {
  canonicalTelemetryPerformanceJson,
  parseTelemetryPerformanceRecord,
  PERFORMANCE_FIELD_DICTIONARIES,
  PERFORMANCE_MEASUREMENT_VERSION,
  PERFORMANCE_PRIVACY_CONTRACT_VERSION,
  PERFORMANCE_RECORD_SCHEMA_VERSION,
  REVIEWED_MODEL_CATALOG,
  type PerformanceFieldDictionary,
  type PerformanceFieldDictionaryVersion,
  type PerformanceHistogramSchemeVersion,
  type TelemetryPerformanceRecord,
} from "@app-usagemonitor/telemetry-contract";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaConfig,
  type PostgresSchemaOptions,
} from "./postgres-client";
import { TELEMETRY_PERFORMANCE_METHOD_VERSION } from "./telemetry-performance-policy";

const REPORT_SCHEMA_VERSION = "telemetry-performance-report-v1";
const READ_SCHEMA_VERSION = "telemetry-performance-read-v1";
const READ_POPULATION = "reported_samples";
const REPORT_KEYS = [
  "bucketSchemeVersion", "day", "fieldDictionaryVersion", "measurementVersion",
  "methodVersion", "parserVersion", "privacyContractVersion", "records", "reportRevision",
  "schemaVersion", "sourceDigest", "sourceGeneration", "sourceRevision",
] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/u;
const MODEL_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/u;
const PRINCIPAL = /^[A-Za-z0-9._:-]{1,128}$/u;
const REPORT_ID = /^[A-Za-z0-9-]{36}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const TIMESTAMP_TEXT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const MAX_REPORT_RECORDS = 1_024;
const MAX_REPORT_BYTES = 1_250_000;
const MAX_REVISION = 2_147_483_647;
// The Worker's read envelope, unchanged: report count, declared canonical
// bytes and records, then the counted detail fan-out before any detail row is
// selected.
const MAX_REPORTS_PER_READ = 256;
const MAX_READ_CANONICAL_BYTES = 8 * 1024 * 1024;
const MAX_READ_RECORDS = 16_384;
const MAX_READ_COHORT_ROWS = 16_384;
const MAX_READ_BUCKET_ROWS = 65_536;
// unnest() rows per INSERT statement. A maximal report has 1,024 cohorts and
// at most 211 sparse bins per cohort; chunking keeps each bind array bounded.
const MAX_INSERT_ROWS = 8_192;
const DAY_MS = 86_400_000;
const REVIEWED_MODEL_PAIRS: ReadonlySet<string> = new Set(
  REVIEWED_MODEL_CATALOG.map(({ provider, id }) => `${provider}\u0000${id}`),
);

/**
 * The report-day admission window, in whole UTC days around the server's UTC
 * day. Clients re-send the current day plus the last 7 completed days (the
 * 7-day backfill, owner decision 4 of 2026-10-10), so 10 days back and 1 day
 * ahead leave 2-3 days of clock skew and offline slack. Widening the client
 * backfill requires widening this window first (server first).
 */
export const POSTGRES_TELEMETRY_PERFORMANCE_REPORT_DAY_PAST_DAYS = 10;
export const POSTGRES_TELEMETRY_PERFORMANCE_REPORT_DAY_FUTURE_DAYS = 1;

/** The closed refusal details; only the refusal counters read them. */
export const POSTGRES_TELEMETRY_PERFORMANCE_RECORD_INVALID_DETAILS = Object.freeze([
  "MODEL_UNREVIEWED",
  "DICTIONARY_UNACCEPTED",
  "SCHEME_MISMATCH",
  "ORDER",
  "DUPLICATE_COHORT",
  "DAY_MISMATCH",
  "SIZE",
  "SHAPE",
  "REPORT_DAY_OUT_OF_WINDOW",
] as const);

export type PostgresTelemetryPerformanceRecordInvalidDetail =
  typeof POSTGRES_TELEMETRY_PERFORMANCE_RECORD_INVALID_DETAILS[number];

/**
 * 409 TELEMETRY_RECORD_INVALID with a closed detail. The detail is not a
 * public detail, so the response body equals the Worker's.
 */
export class PostgresTelemetryPerformanceRecordInvalidError extends ApiError {
  readonly detail: PostgresTelemetryPerformanceRecordInvalidDetail;

  constructor(detail: PostgresTelemetryPerformanceRecordInvalidDetail) {
    super(409, "TELEMETRY_RECORD_INVALID");
    this.detail = detail;
  }
}

/** The closed refusal detail of an invalid report, or null for any other error. */
export function postgresTelemetryPerformanceRecordInvalidDetail(
  error: unknown,
): PostgresTelemetryPerformanceRecordInvalidDetail | null {
  return error instanceof PostgresTelemetryPerformanceRecordInvalidError
    && POSTGRES_TELEMETRY_PERFORMANCE_RECORD_INVALID_DETAILS.includes(error.detail)
    ? error.detail : null;
}

export interface PostgresTelemetryPerformanceReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly day: string;
  readonly reportRevision: string;
  readonly sourceGeneration: string;
  readonly sourceDigest: string;
  readonly sourceRevision: number;
  readonly methodVersion: typeof TELEMETRY_PERFORMANCE_METHOD_VERSION;
  readonly parserVersion: string;
  readonly fieldDictionaryVersion: PerformanceFieldDictionaryVersion;
  readonly privacyContractVersion: typeof PERFORMANCE_PRIVACY_CONTRACT_VERSION;
  readonly bucketSchemeVersion: PerformanceHistogramSchemeVersion;
  readonly measurementVersion: typeof PERFORMANCE_MEASUREMENT_VERSION;
  readonly records: readonly TelemetryPerformanceRecord[];
}

/** A registry entry as the parser reads it (the contract's, or a spec's injection). */
export type PostgresTelemetryPerformanceDictionaryEntry =
  Pick<PerformanceFieldDictionary, "state" | "bucketSchemeVersion">;

export interface PostgresTelemetryPerformanceParseOptions {
  readonly dictionaries?: Readonly<Record<string, PostgresTelemetryPerformanceDictionaryEntry>>;
}

export interface PostgresTelemetryPerformancePrincipal {
  readonly participantId: string;
  readonly deviceId: string;
}

/**
 * The server-side capability the route read before decryption: the subset of
 * readPostgresTelemetryPerformanceCapability's response that admission uses.
 */
export interface PostgresTelemetryPerformanceAdmissionCapability {
  readonly requiredConsent: { readonly fieldDictionaryVersion: string };
  readonly authorization: {
    readonly capabilityRevision: number;
    readonly authorityEpoch: number;
    readonly expiresAt: string;
  };
}

export interface PostgresTelemetryPerformanceAdmissionOptions {
  readonly schema?: PostgresSchemaConfig | PostgresSchemaOptions;
  readonly principal: PostgresTelemetryPerformancePrincipal;
  readonly plaintext: unknown;
  readonly capability: PostgresTelemetryPerformanceAdmissionCapability;
  readonly envelopeDigest: string;
  readonly nowEpoch?: number;
}

export interface PostgresTelemetryPerformanceAdmission {
  readonly status: "accepted" | "replaced" | "idempotent";
  readonly reportId: string;
  readonly day: string;
  readonly reportRevision: string;
}

/** The inclusive report-day window (YYYY-MM-DD) at one server instant. */
export interface PostgresTelemetryPerformanceReportDayWindow {
  readonly fromDay: string;
  readonly throughDay: string;
}

export interface PostgresTelemetryPerformanceReadOptions {
  readonly schema?: PostgresSchemaConfig | PostgresSchemaOptions;
  readonly participantId: string;
  readonly deviceId: string;
  readonly fromDay?: string;
  readonly throughDay?: string;
  readonly includeSuperseded?: boolean;
}

export type PostgresTelemetryPerformanceMetric = "speed" | "ttft" | "turnDuration";

export interface PostgresTelemetryPerformanceBucket {
  readonly index: number;
  readonly count: number;
}

export interface PostgresTelemetryPerformanceHistogramRead {
  readonly metric: PostgresTelemetryPerformanceMetric;
  readonly min: number | null;
  readonly max: number | null;
  readonly buckets: readonly PostgresTelemetryPerformanceBucket[];
}

export interface PostgresTelemetryPerformanceCohortRead {
  readonly provider: string;
  readonly modelId: string;
  readonly reasoningEffort: string;
  readonly speedMethod: string;
  readonly speedMode: string;
  readonly speedModeSource: string;
  readonly apiServiceTier: string;
  readonly turns: number;
  readonly speedTurns: number;
  readonly ttftTurns: number;
  readonly completionTurns: number;
  readonly timedResponses: number;
  readonly speedTokens: number;
  readonly speedDurationMs: number;
  readonly speedHistogram: PostgresTelemetryPerformanceHistogramRead;
  readonly ttftHistogram: PostgresTelemetryPerformanceHistogramRead;
  readonly completionHistogram: PostgresTelemetryPerformanceHistogramRead;
}

export interface PostgresTelemetryPerformanceReportRead {
  readonly day: string;
  readonly reportRevision: string;
  readonly sourceGeneration: string;
  readonly sourceDigest: string;
  readonly sourceRevision: number;
  readonly fieldDictionaryVersion: string;
  readonly state: "current" | "superseded";
  readonly createdAt: string;
  readonly cohorts: readonly PostgresTelemetryPerformanceCohortRead[];
}

export interface PostgresTelemetryPerformanceReadResult {
  readonly schemaVersion: typeof READ_SCHEMA_VERSION;
  readonly population: typeof READ_POPULATION;
  readonly reports: readonly PostgresTelemetryPerformanceReportRead[];
}

// ---------------------------------------------------------------- helpers --

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function utcDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function safeString(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function recordInvalid(detail: PostgresTelemetryPerformanceRecordInvalidDetail): never {
  throw new PostgresTelemetryPerformanceRecordInvalidError(detail);
}

function requestInvalid(): never {
  // The Worker's read answers malformed options with its parser's 409.
  throw new ApiError(409, "TELEMETRY_RECORD_INVALID");
}

function manifestConflict(): never {
  throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
}

function transportBlocked(): never {
  throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
}

function unavailable(): never {
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function rangeTooLarge(): never {
  throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
}

function schemaOf(schema: PostgresSchemaConfig | PostgresSchemaOptions | undefined): string {
  let config: PostgresSchemaConfig;
  try {
    config = createPostgresSchemaConfig(schema ?? {});
  } catch {
    unavailable();
  }
  return quotePostgresIdentifier(config.primarySchema);
}

function table(schema: string, name: string): string {
  return `${schema}.${quotePostgresIdentifier(name)}`;
}

function nowInstant(nowEpoch: unknown): string {
  if (!Number.isSafeInteger(nowEpoch) || (nowEpoch as number) < 0
      || (nowEpoch as number) > 8_640_000_000_000_000) {
    unavailable();
  }
  return new Date(nowEpoch as number).toISOString();
}

/**
 * The inclusive window a newly admitted report day must fall in at the
 * server instant `nowEpoch`: its UTC day minus
 * POSTGRES_TELEMETRY_PERFORMANCE_REPORT_DAY_PAST_DAYS through its UTC day plus
 * POSTGRES_TELEMETRY_PERFORMANCE_REPORT_DAY_FUTURE_DAYS. An invalid instant is
 * 503 BACKEND_STORAGE_UNAVAILABLE, as for admission.
 */
export function postgresTelemetryPerformanceReportDayWindow(
  nowEpoch: number,
): PostgresTelemetryPerformanceReportDayWindow {
  nowInstant(nowEpoch);
  const today = Math.floor(nowEpoch / DAY_MS) * DAY_MS;
  const day = (epoch: number) => new Date(epoch).toISOString().slice(0, 10);
  return Object.freeze({
    fromDay: day(today - POSTGRES_TELEMETRY_PERFORMANCE_REPORT_DAY_PAST_DAYS * DAY_MS),
    throughDay: day(today + POSTGRES_TELEMETRY_PERFORMANCE_REPORT_DAY_FUTURE_DAYS * DAY_MS),
  });
}

function validPrincipal(principal: unknown): principal is PostgresTelemetryPerformancePrincipal {
  return typeof principal === "object" && principal !== null
    && safeString(Reflect.get(principal, "participantId"), PRINCIPAL)
    && safeString(Reflect.get(principal, "deviceId"), PRINCIPAL);
}

/** A stored integer (int8 arrives as decimal text) within [0, max]. */
function storedInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  if (!integer(parsed, max)) unavailable();
  return parsed;
}

function storedNullableInteger(value: unknown): number | null {
  return value === null ? null : storedInteger(value);
}

function cohortIdentity(record: Record<string, unknown>): string {
  // The complete population partition (the Worker's identity, and 0079's
  // telemetry_performance_cohort_identity unique index).
  return JSON.stringify([
    record.provider, record.modelId, record.reasoningEffort, record.speedMethod,
    record.speedMode, record.speedModeSource, record.apiServiceTier,
  ]);
}

function dictionaryEntry(
  dictionaries: Readonly<Record<string, PostgresTelemetryPerformanceDictionaryEntry>>,
  version: unknown,
): PostgresTelemetryPerformanceDictionaryEntry | null {
  if (typeof version !== "string" || !Object.hasOwn(dictionaries, version)) return null;
  const entry = dictionaries[version];
  return entry !== undefined && entry !== null && entry.state === "accepted" ? entry : null;
}

/** The closed detail of one record the contract refused. */
function recordFailureDetail(
  record: unknown,
  scheme: PerformanceHistogramSchemeVersion,
): PostgresTelemetryPerformanceRecordInvalidDetail {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return "SHAPE";
  const provider = Reflect.get(record, "provider");
  const modelId = Reflect.get(record, "modelId");
  if (safeString(provider, MODEL_TOKEN) && safeString(modelId, MODEL_TOKEN)
      && !REVIEWED_MODEL_PAIRS.has(`${provider}\u0000${modelId}`)) {
    // Catalog drift: a client newer than this server's reviewed catalog.
    return "MODEL_UNREVIEWED";
  }
  if (Reflect.get(record, "bucketSchemeVersion") !== scheme) return "SCHEME_MISMATCH";
  for (const field of ["speedHistogram", "ttftHistogram", "completionHistogram"]) {
    const histogram = Reflect.get(record, field);
    if (typeof histogram === "object" && histogram !== null
        && Reflect.get(histogram, "schemaVersion") !== scheme) {
      return "SCHEME_MISMATCH";
    }
  }
  return "SHAPE";
}

// ----------------------------------------------------------------- parser --

/**
 * The Worker's closed report parser, generalized over the field dictionary
 * registry. The report's dictionary must be an `accepted` entry of
 * `dictionaries` and its bucket scheme that entry's; each record must satisfy
 * the contract under that dictionary. Records are canonical, strictly
 * ascending, of distinct cohorts and all of the report day. The option exists
 * only for spec injection. Every failure is 409 TELEMETRY_RECORD_INVALID with
 * a closed detail.
 */
export function parsePostgresTelemetryPerformanceReport(
  value: unknown,
  { dictionaries = PERFORMANCE_FIELD_DICTIONARIES }: PostgresTelemetryPerformanceParseOptions = {},
): PostgresTelemetryPerformanceReport {
  if (!exact(value, REPORT_KEYS)
      || value.schemaVersion !== REPORT_SCHEMA_VERSION
      || !utcDay(value.day)
      || !safeString(value.reportRevision, DIGEST)
      || !safeString(value.sourceGeneration, TOKEN)
      || !safeString(value.sourceDigest, DIGEST)
      || !integer(value.sourceRevision)
      || value.methodVersion !== TELEMETRY_PERFORMANCE_METHOD_VERSION
      || !safeString(value.parserVersion, TOKEN)
      || value.privacyContractVersion !== PERFORMANCE_PRIVACY_CONTRACT_VERSION
      || value.measurementVersion !== PERFORMANCE_MEASUREMENT_VERSION
      || !Array.isArray(value.records)) {
    recordInvalid("SHAPE");
  }
  const dictionary = dictionaryEntry(dictionaries, value.fieldDictionaryVersion);
  if (dictionary === null) recordInvalid("DICTIONARY_UNACCEPTED");
  if (value.bucketSchemeVersion !== dictionary.bucketSchemeVersion) recordInvalid("SCHEME_MISMATCH");
  if (value.records.length > MAX_REPORT_RECORDS) recordInvalid("SIZE");
  const fieldDictionaryVersion = value.fieldDictionaryVersion as PerformanceFieldDictionaryVersion;
  const records: TelemetryPerformanceRecord[] = [];
  const seen = new Set<string>();
  const seenCohorts = new Set<string>();
  let previous = "";
  for (const record of value.records as unknown[]) {
    let canonical: string;
    try {
      parseTelemetryPerformanceRecord(record, fieldDictionaryVersion);
      canonical = canonicalTelemetryPerformanceJson(record, fieldDictionaryVersion);
    } catch {
      recordInvalid(recordFailureDetail(record, dictionary.bucketSchemeVersion));
    }
    if (seen.has(canonical)) recordInvalid("DUPLICATE_COHORT");
    if (previous !== "" && previous > canonical) recordInvalid("ORDER");
    const parsed = JSON.parse(canonical) as TelemetryPerformanceRecord;
    const identity = cohortIdentity(parsed as unknown as Record<string, unknown>);
    if (seenCohorts.has(identity)) recordInvalid("DUPLICATE_COHORT");
    if (parsed.day !== value.day) recordInvalid("DAY_MISMATCH");
    seen.add(canonical);
    seenCohorts.add(identity);
    previous = canonical;
    records.push(parsed);
  }
  const report: PostgresTelemetryPerformanceReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    day: value.day,
    reportRevision: value.reportRevision,
    sourceGeneration: value.sourceGeneration,
    sourceDigest: value.sourceDigest,
    sourceRevision: value.sourceRevision,
    methodVersion: TELEMETRY_PERFORMANCE_METHOD_VERSION,
    parserVersion: value.parserVersion,
    fieldDictionaryVersion,
    privacyContractVersion: PERFORMANCE_PRIVACY_CONTRACT_VERSION,
    bucketSchemeVersion: dictionary.bucketSchemeVersion,
    measurementVersion: PERFORMANCE_MEASUREMENT_VERSION,
    records,
  };
  const bytes = new TextEncoder().encode(canonicalJson(report)).byteLength;
  if (bytes < 1 || bytes > MAX_REPORT_BYTES) recordInvalid("SIZE");
  return report;
}

// ------------------------------------------------------------- admission --

interface CohortColumns {
  readonly cohortIndex: number[];
  readonly provider: string[];
  readonly modelId: string[];
  readonly reasoningEffort: string[];
  readonly speedMethod: string[];
  readonly speedMode: string[];
  readonly speedModeSource: string[];
  readonly apiServiceTier: string[];
  readonly turns: number[];
  readonly speedTurns: number[];
  readonly ttftTurns: number[];
  readonly completionTurns: number[];
  readonly timedResponses: number[];
  readonly speedTokens: number[];
  readonly speedDurationMs: number[];
  readonly speedMin: (number | null)[];
  readonly speedMax: (number | null)[];
  readonly ttftMin: (number | null)[];
  readonly ttftMax: (number | null)[];
  readonly completionMin: (number | null)[];
  readonly completionMax: (number | null)[];
}

interface BucketTuple {
  readonly cohortIndex: number;
  readonly metric: PostgresTelemetryPerformanceMetric;
  readonly bucketIndex: number;
  readonly count: number;
}

const HISTOGRAM_FIELDS = [
  ["speedHistogram", "speed"], ["ttftHistogram", "ttft"], ["completionHistogram", "turnDuration"],
] as const;

function typedRows(records: readonly TelemetryPerformanceRecord[]) {
  const cohorts: CohortColumns = {
    cohortIndex: [], provider: [], modelId: [], reasoningEffort: [], speedMethod: [], speedMode: [],
    speedModeSource: [], apiServiceTier: [], turns: [], speedTurns: [], ttftTurns: [],
    completionTurns: [], timedResponses: [], speedTokens: [], speedDurationMs: [], speedMin: [],
    speedMax: [], ttftMin: [], ttftMax: [], completionMin: [], completionMax: [],
  };
  const buckets: BucketTuple[] = [];
  records.forEach((record, index) => {
    cohorts.cohortIndex.push(index);
    cohorts.provider.push(record.provider);
    cohorts.modelId.push(record.modelId);
    cohorts.reasoningEffort.push(record.reasoningEffort);
    cohorts.speedMethod.push(record.speedMethod);
    cohorts.speedMode.push(record.speedMode);
    cohorts.speedModeSource.push(record.speedModeSource);
    cohorts.apiServiceTier.push(record.apiServiceTier);
    cohorts.turns.push(record.turns);
    cohorts.speedTurns.push(record.speedTurns);
    cohorts.ttftTurns.push(record.ttftTurns);
    cohorts.completionTurns.push(record.completionTurns);
    cohorts.timedResponses.push(record.timedResponses);
    cohorts.speedTokens.push(record.speedTokens);
    cohorts.speedDurationMs.push(record.speedDurationMs);
    cohorts.speedMin.push(record.speedHistogram.min);
    cohorts.speedMax.push(record.speedHistogram.max);
    cohorts.ttftMin.push(record.ttftHistogram.min);
    cohorts.ttftMax.push(record.ttftHistogram.max);
    cohorts.completionMin.push(record.completionHistogram.min);
    cohorts.completionMax.push(record.completionHistogram.max);
    for (const [field, metric] of HISTOGRAM_FIELDS) {
      const histogram = record[field] as unknown as { readonly buckets: Readonly<Record<string, number>> };
      for (const [bucketIndex, count] of Object.entries(histogram.buckets)) {
        buckets.push({ cohortIndex: index, metric, bucketIndex: Number(bucketIndex), count });
      }
    }
  });
  return { cohorts, buckets };
}

function validCapability(
  capability: unknown,
  nowEpoch: number,
): capability is PostgresTelemetryPerformanceAdmissionCapability {
  if (typeof capability !== "object" || capability === null) return false;
  const consent = Reflect.get(capability, "requiredConsent");
  const authorization = Reflect.get(capability, "authorization");
  if (typeof consent !== "object" || consent === null
      || typeof authorization !== "object" || authorization === null) {
    return false;
  }
  const expiresAt = Reflect.get(authorization, "expiresAt");
  const revision = Reflect.get(authorization, "capabilityRevision");
  const epoch = Reflect.get(authorization, "authorityEpoch");
  return typeof Reflect.get(consent, "fieldDictionaryVersion") === "string"
    && integer(revision, MAX_REVISION) && revision >= 1
    && integer(epoch, MAX_REVISION) && epoch >= 1
    && safeString(expiresAt, INSTANT) && Date.parse(expiresAt) > nowEpoch;
}

/** Signals a unique-index race; the caller re-reads outside the aborted transaction. */
class UniqueRaceSignal extends Error {}

function admissionSafeError(error: unknown): Error | null {
  if (error instanceof ApiError) return error;
  if (error === null || typeof error !== "object") return null;
  const code = Reflect.get(error, "code");
  const message = Reflect.get(error, "message");
  if (code === "23505") return new UniqueRaceSignal("unique");
  if (code === "P1005" && message === "telemetry_performance_report_admission_denied") {
    return new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  if (code === "P1005" && message === "telemetry_performance_report_revision_conflict") {
    return new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  }
  return null;
}

function chunks<T>(rows: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < rows.length; start += MAX_INSERT_ROWS) {
    result.push(rows.slice(start, start + MAX_INSERT_ROWS));
  }
  return result;
}

async function insertCohorts(
  client: PostgresClient,
  schema: string,
  reportId: string,
  report: PostgresTelemetryPerformanceReport,
  cohorts: CohortColumns,
): Promise<void> {
  for (let start = 0; start < cohorts.cohortIndex.length; start += MAX_INSERT_ROWS) {
    const slice = <T>(column: readonly T[]) => column.slice(start, start + MAX_INSERT_ROWS);
    await client.query(
      `INSERT INTO ${table(schema, "telemetry_performance_cohorts")} (
         report_id, cohort_index, field_dictionary_version, bucket_scheme_version, provider, model_id,
         reasoning_effort, speed_method, speed_mode, speed_mode_source, api_service_tier, turns,
         speed_turns, ttft_turns, completion_turns, timed_responses, speed_tokens, speed_duration_ms,
         speed_min, speed_max, ttft_min, ttft_max, completion_min, completion_max)
       SELECT $1, c.cohort_index, $2, $3, c.provider, c.model_id, c.reasoning_effort, c.speed_method,
              c.speed_mode, c.speed_mode_source, c.api_service_tier, c.turns, c.speed_turns,
              c.ttft_turns, c.completion_turns, c.timed_responses, c.speed_tokens, c.speed_duration_ms,
              c.speed_min, c.speed_max, c.ttft_min, c.ttft_max, c.completion_min, c.completion_max
         FROM unnest($4::integer[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                     $10::text[], $11::text[], $12::bigint[], $13::bigint[], $14::bigint[],
                     $15::bigint[], $16::bigint[], $17::bigint[], $18::bigint[], $19::bigint[],
                     $20::bigint[], $21::bigint[], $22::bigint[], $23::bigint[], $24::bigint[])
           AS c(cohort_index, provider, model_id, reasoning_effort, speed_method, speed_mode,
                speed_mode_source, api_service_tier, turns, speed_turns, ttft_turns, completion_turns,
                timed_responses, speed_tokens, speed_duration_ms, speed_min, speed_max, ttft_min,
                ttft_max, completion_min, completion_max)`,
      [reportId, report.fieldDictionaryVersion, report.bucketSchemeVersion,
        slice(cohorts.cohortIndex), slice(cohorts.provider), slice(cohorts.modelId),
        slice(cohorts.reasoningEffort), slice(cohorts.speedMethod), slice(cohorts.speedMode),
        slice(cohorts.speedModeSource), slice(cohorts.apiServiceTier), slice(cohorts.turns),
        slice(cohorts.speedTurns), slice(cohorts.ttftTurns), slice(cohorts.completionTurns),
        slice(cohorts.timedResponses), slice(cohorts.speedTokens), slice(cohorts.speedDurationMs),
        slice(cohorts.speedMin), slice(cohorts.speedMax), slice(cohorts.ttftMin), slice(cohorts.ttftMax),
        slice(cohorts.completionMin), slice(cohorts.completionMax)],
    );
  }
}

async function insertBuckets(
  client: PostgresClient,
  schema: string,
  reportId: string,
  report: PostgresTelemetryPerformanceReport,
  buckets: readonly BucketTuple[],
): Promise<void> {
  for (const part of chunks(buckets)) {
    await client.query(
      `INSERT INTO ${table(schema, "telemetry_performance_buckets")}
         (report_id, cohort_index, bucket_scheme_version, metric, bucket_index, bucket_count)
       SELECT $1, b.cohort_index, $2, b.metric, b.bucket_index, b.bucket_count
         FROM unnest($3::integer[], $4::text[], $5::smallint[], $6::bigint[])
           AS b(cohort_index, metric, bucket_index, bucket_count)`,
      [reportId, report.bucketSchemeVersion, part.map((row) => row.cohortIndex),
        part.map((row) => row.metric), part.map((row) => row.bucketIndex), part.map((row) => row.count)],
    );
  }
}

async function readAdmittedRevision(
  client: PostgresClient,
  schema: string,
  principal: PostgresTelemetryPerformancePrincipal,
  report: PostgresTelemetryPerformanceReport,
): Promise<PostgresTelemetryPerformanceAdmission | null> {
  const existing = await client.query<{ id: string; report_day: string; report_revision: string }>(
    `SELECT id, to_char(report_day, 'YYYY-MM-DD') AS report_day, report_revision
       FROM ${table(schema, "telemetry_performance_reports")}
      WHERE participant_id = $1 AND device_id = $2 AND report_day = $3::date AND report_revision = $4`,
    [principal.participantId, principal.deviceId, report.day, report.reportRevision],
  );
  const row = existing.rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    status: "idempotent", reportId: row.id, day: row.report_day, reportRevision: row.report_revision,
  });
}

/**
 * Admit one decrypted daily report for an authenticated device, in one
 * transaction: the report/day advisory lock, then the idempotency read, the
 * report-day window at `nowEpoch`, the revision digest, the capability
 * dictionary, the source-revision order against the locked current row, then
 * supersession and the report, cohorts, sparse buckets and receipt. An
 * idempotent replay writes nothing and is answered even outside the window.
 */
export async function admitPostgresTelemetryPerformanceReport(
  pool: PostgresPool,
  {
    schema,
    principal,
    plaintext,
    capability,
    envelopeDigest,
    nowEpoch = Date.now(),
  }: PostgresTelemetryPerformanceAdmissionOptions,
): Promise<PostgresTelemetryPerformanceAdmission> {
  const quoted = schemaOf(schema);
  const now = nowInstant(nowEpoch);
  const dayWindow = postgresTelemetryPerformanceReportDayWindow(nowEpoch);
  if (!validPrincipal(principal)) transportBlocked();
  if (!safeString(envelopeDigest, DIGEST)) recordInvalid("SHAPE");
  const report = parsePostgresTelemetryPerformanceReport(plaintext);
  if (!validCapability(capability, nowEpoch)) transportBlocked();
  const { reportRevision: _revision, ...body } = report;
  const expectedRevision = await sha256Hex(canonicalJson(body));
  const canonicalBytes = new TextEncoder().encode(canonicalJson(report)).byteLength;
  const { cohorts, buckets } = typedRows(report.records);
  const reportId = crypto.randomUUID();
  const receiptId = crypto.randomUUID();
  const reports = table(quoted, "telemetry_performance_reports");
  try {
    return await withPostgresMutation(pool, async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(${quoted}.telemetry_performance_report_lock_key($1, $2, $3::date))`,
        [principal.participantId, principal.deviceId, report.day],
      );
      const replay = await readAdmittedRevision(client, quoted, principal, report);
      if (replay !== null) return replay;
      // Only after the replay read: a stored revision stays idempotent, while
      // a new admission or replacement must name a day inside the window.
      if (report.day < dayWindow.fromDay || report.day > dayWindow.throughDay) {
        recordInvalid("REPORT_DAY_OUT_OF_WINDOW");
      }
      if (expectedRevision !== report.reportRevision) manifestConflict();
      if (report.fieldDictionaryVersion !== capability.requiredConsent.fieldDictionaryVersion) {
        transportBlocked();
      }
      const current = await client.query<{
        id: string; source_generation: string; source_digest: string; source_revision: string;
      }>(
        `SELECT id, source_generation, source_digest, source_revision::text AS source_revision
           FROM ${reports}
          WHERE participant_id = $1 AND device_id = $2 AND report_day = $3::date AND state = 'current'
          FOR UPDATE`,
        [principal.participantId, principal.deviceId, report.day],
      );
      const head = current.rows[0];
      if (head !== undefined) {
        const headRevision = storedInteger(head.source_revision);
        // sourceRevision is the client's persistent local mutation counter:
        // an older counter never displaces a newer snapshot, and an equal one
        // must name the same source generation and digest.
        if (headRevision > report.sourceRevision
            || (headRevision === report.sourceRevision
              && (head.source_generation !== report.sourceGeneration
                || head.source_digest !== report.sourceDigest))) {
          manifestConflict();
        }
        const superseded = await client.query(
          `UPDATE ${reports}
              SET state = 'superseded', superseded_at = GREATEST(created_at, $2::timestamptz)
            WHERE id = $1 AND state = 'current'`,
          [head.id, now],
        );
        if (superseded.rowCount !== 1) unavailable();
      }
      await client.query(
        `INSERT INTO ${reports} (
           id, participant_id, device_id, report_day, report_revision, source_generation, source_digest,
           source_revision, method_version, parser_version, schema_version, field_dictionary_version,
           bucket_scheme_version, privacy_contract_version, measurement_version, record_count,
           canonical_bytes, capability_revision, authority_epoch, state, created_at
         ) VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
           $19, 'current', $20::timestamptz)`,
        [reportId, principal.participantId, principal.deviceId, report.day, report.reportRevision,
          report.sourceGeneration, report.sourceDigest, report.sourceRevision, report.methodVersion,
          report.parserVersion, PERFORMANCE_RECORD_SCHEMA_VERSION, report.fieldDictionaryVersion,
          report.bucketSchemeVersion, report.privacyContractVersion, report.measurementVersion,
          report.records.length, canonicalBytes, capability.authorization.capabilityRevision,
          capability.authorization.authorityEpoch, now],
      );
      await insertCohorts(client, quoted, reportId, report, cohorts);
      await insertBuckets(client, quoted, reportId, report, buckets);
      const outcome = head === undefined ? "accepted" : "replaced";
      await client.query(
        `INSERT INTO ${table(quoted, "telemetry_performance_receipts")} (
           id, participant_id, device_id, report_id, report_day, report_revision, envelope_digest,
           outcome, created_at
         ) VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9::timestamptz)`,
        [receiptId, principal.participantId, principal.deviceId, reportId, report.day,
          report.reportRevision, envelopeDigest, outcome, now],
      );
      return Object.freeze({
        status: outcome, reportId, day: report.day, reportRevision: report.reportRevision,
      });
    }, { operation: "telemetry_performance.report_admission", preserveSafeError: admissionSafeError });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (!(error instanceof UniqueRaceSignal)) unavailable();
  }
  // A concurrent writer committed first. The same revision is idempotent;
  // anything else conflicts (the Worker's unique-index answer).
  let raced: PostgresTelemetryPerformanceAdmission | null;
  try {
    raced = await withPostgresRead(pool, (client) => readAdmittedRevision(client, quoted, principal, report),
      { operation: "telemetry_performance.report_admission_reread" });
  } catch {
    unavailable();
  }
  if (raced === null) manifestConflict();
  return raced;
}

// ------------------------------------------------------------------- read --

interface ReportRow {
  readonly id: unknown;
  readonly report_day: unknown;
  readonly report_revision: unknown;
  readonly source_generation: unknown;
  readonly source_digest: unknown;
  readonly source_revision: unknown;
  readonly method_version: unknown;
  readonly parser_version: unknown;
  readonly field_dictionary_version: unknown;
  readonly record_count: unknown;
  readonly canonical_bytes: unknown;
  readonly created_at: unknown;
  readonly state: unknown;
}

interface ValidReportRow {
  readonly id: string;
  readonly day: string;
  readonly reportRevision: string;
  readonly sourceGeneration: string;
  readonly sourceDigest: string;
  readonly sourceRevision: number;
  readonly fieldDictionaryVersion: string;
  readonly recordCount: number;
  readonly canonicalBytes: number;
  readonly createdAt: string;
  readonly state: "current" | "superseded";
}

interface CohortRow {
  readonly report_id: unknown;
  readonly cohort_index: unknown;
  readonly provider: unknown;
  readonly model_id: unknown;
  readonly reasoning_effort: unknown;
  readonly speed_method: unknown;
  readonly speed_mode: unknown;
  readonly speed_mode_source: unknown;
  readonly api_service_tier: unknown;
  readonly turns: unknown;
  readonly speed_turns: unknown;
  readonly ttft_turns: unknown;
  readonly completion_turns: unknown;
  readonly timed_responses: unknown;
  readonly speed_tokens: unknown;
  readonly speed_duration_ms: unknown;
  readonly speed_min: unknown;
  readonly speed_max: unknown;
  readonly ttft_min: unknown;
  readonly ttft_max: unknown;
  readonly completion_min: unknown;
  readonly completion_max: unknown;
}

interface BucketRow {
  readonly report_id: unknown;
  readonly cohort_index: unknown;
  readonly metric: unknown;
  readonly bucket_index: unknown;
  readonly bucket_count: unknown;
}

function validateStoredReport(row: ReportRow): ValidReportRow {
  // These declarations drive the range preflight and are copied into the
  // response; a malformed row is unavailable rather than trusted.
  if (!safeString(row.id, REPORT_ID)
      || !utcDay(row.report_day)
      || !safeString(row.report_revision, DIGEST)
      || !safeString(row.source_generation, TOKEN)
      || !safeString(row.source_digest, DIGEST)
      || !safeString(row.method_version, TOKEN)
      || !safeString(row.parser_version, TOKEN)
      || typeof row.field_dictionary_version !== "string"
      || !Object.hasOwn(PERFORMANCE_FIELD_DICTIONARIES, row.field_dictionary_version)
      || !safeString(row.created_at, INSTANT)
      || (row.state !== "current" && row.state !== "superseded")) {
    unavailable();
  }
  const canonicalBytes = storedInteger(row.canonical_bytes, MAX_REPORT_BYTES);
  if (canonicalBytes < 1) unavailable();
  return {
    id: row.id,
    day: row.report_day,
    reportRevision: row.report_revision,
    sourceGeneration: row.source_generation,
    sourceDigest: row.source_digest,
    sourceRevision: storedInteger(row.source_revision),
    fieldDictionaryVersion: row.field_dictionary_version,
    recordCount: storedInteger(row.record_count, MAX_REPORT_RECORDS),
    canonicalBytes,
    createdAt: row.created_at,
    state: row.state,
  };
}

function detailCount(value: unknown, maximum: number): number {
  const total = storedInteger(value);
  if (total > maximum) rangeTooLarge();
  return total;
}

function histogramFor(
  cohort: CohortRow,
  metric: PostgresTelemetryPerformanceMetric,
  rows: readonly BucketRow[],
): PostgresTelemetryPerformanceHistogramRead {
  const [min, max] = metric === "speed" ? [cohort.speed_min, cohort.speed_max]
    : metric === "ttft" ? [cohort.ttft_min, cohort.ttft_max]
      : [cohort.completion_min, cohort.completion_max];
  return Object.freeze({
    metric,
    min: storedNullableInteger(min),
    max: storedNullableInteger(max),
    buckets: Object.freeze(rows.filter((row) => row.metric === metric)
      .map((row) => Object.freeze({
        index: storedInteger(row.bucket_index, 95), count: storedInteger(row.bucket_count),
      }))
      .sort((left, right) => left.index - right.index)),
  });
}

function cohortRead(cohort: CohortRow, buckets: readonly BucketRow[]): PostgresTelemetryPerformanceCohortRead {
  const labels = [cohort.provider, cohort.model_id, cohort.reasoning_effort, cohort.speed_method,
    cohort.speed_mode, cohort.speed_mode_source, cohort.api_service_tier];
  if (!labels.every((label) => safeString(label, MODEL_TOKEN))) unavailable();
  return Object.freeze({
    provider: cohort.provider as string,
    modelId: cohort.model_id as string,
    reasoningEffort: cohort.reasoning_effort as string,
    speedMethod: cohort.speed_method as string,
    speedMode: cohort.speed_mode as string,
    speedModeSource: cohort.speed_mode_source as string,
    apiServiceTier: cohort.api_service_tier as string,
    turns: storedInteger(cohort.turns),
    speedTurns: storedInteger(cohort.speed_turns),
    ttftTurns: storedInteger(cohort.ttft_turns),
    completionTurns: storedInteger(cohort.completion_turns),
    timedResponses: storedInteger(cohort.timed_responses),
    speedTokens: storedInteger(cohort.speed_tokens),
    speedDurationMs: storedInteger(cohort.speed_duration_ms),
    speedHistogram: histogramFor(cohort, "speed", buckets),
    ttftHistogram: histogramFor(cohort, "ttft", buckets),
    completionHistogram: histogramFor(cohort, "turnDuration", buckets),
  });
}

function readSafeError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

/**
 * The Worker's bounded device-scoped read, in one read-only repeatable-read
 * transaction: at most 256 reports, then the declared canonical-byte and
 * record fences, then counted cohort and bucket fan-out before any detail row
 * is selected (400 SYNC_RANGE_TOO_LARGE). The population label makes pooled
 * samples' semantics explicit.
 */
export async function readPostgresTelemetryPerformanceReports(
  pool: PostgresPool,
  { schema, participantId, deviceId, fromDay, throughDay, includeSuperseded }: PostgresTelemetryPerformanceReadOptions,
): Promise<PostgresTelemetryPerformanceReadResult> {
  const quoted = schemaOf(schema);
  if (!safeString(participantId, PRINCIPAL)
      || !safeString(deviceId, PRINCIPAL)
      || (fromDay !== undefined && !utcDay(fromDay))
      || (throughDay !== undefined && !utcDay(throughDay))
      || (includeSuperseded !== undefined && typeof includeSuperseded !== "boolean")
      || (fromDay !== undefined && throughDay !== undefined && fromDay > throughDay)) {
    requestInvalid();
  }
  const states = includeSuperseded === true ? ["current", "superseded"] : ["current"];
  try {
    return await withPostgresRead(pool, async (client) => {
      const rows = await client.query<ReportRow>(
        `SELECT id, to_char(report_day, 'YYYY-MM-DD') AS report_day, report_revision, source_generation,
                source_digest, source_revision::text AS source_revision, method_version, parser_version,
                field_dictionary_version, record_count, canonical_bytes,
                to_char(created_at AT TIME ZONE 'UTC', ${TIMESTAMP_TEXT}) AS created_at, state
           FROM ${table(quoted, "telemetry_performance_reports")}
          WHERE participant_id = $1 AND device_id = $2 AND state = ANY($3::text[])
            AND ($4::date IS NULL OR report_day >= $4::date)
            AND ($5::date IS NULL OR report_day <= $5::date)
          ORDER BY report_day, created_at, id
          LIMIT $6`,
        [participantId, deviceId, states, fromDay ?? null, throughDay ?? null, MAX_REPORTS_PER_READ + 1],
      );
      if (rows.rows.length > MAX_REPORTS_PER_READ) rangeTooLarge();
      if (rows.rows.length === 0) {
        return Object.freeze({ schemaVersion: READ_SCHEMA_VERSION, population: READ_POPULATION, reports: [] });
      }
      let canonicalBytes = 0;
      let recordCount = 0;
      const reports: ValidReportRow[] = [];
      for (const row of rows.rows) {
        const report = validateStoredReport(row);
        canonicalBytes += report.canonicalBytes;
        recordCount += report.recordCount;
        if (canonicalBytes > MAX_READ_CANONICAL_BYTES || recordCount > MAX_READ_RECORDS) rangeTooLarge();
        reports.push(report);
      }
      const ids = reports.map((report) => report.id);
      // Count the detail rows before selecting them: the declared metadata
      // bounds the normal path, and a malformed or maintenance-created
      // fan-out still cannot force a large result set into memory.
      const counts = await client.query<{ cohorts: unknown; buckets: unknown }>(
        `SELECT (SELECT count(*) FROM ${table(quoted, "telemetry_performance_cohorts")}
                  WHERE report_id = ANY($1::text[])) AS cohorts,
                (SELECT count(*) FROM ${table(quoted, "telemetry_performance_buckets")}
                  WHERE report_id = ANY($1::text[])) AS buckets`,
        [ids],
      );
      const cohortCount = detailCount(counts.rows[0]?.cohorts, MAX_READ_COHORT_ROWS);
      const bucketCount = detailCount(counts.rows[0]?.buckets, MAX_READ_BUCKET_ROWS);
      if (cohortCount !== recordCount) unavailable();
      const cohorts = await client.query<CohortRow>(
        `SELECT report_id, cohort_index, provider, model_id, reasoning_effort, speed_method, speed_mode,
                speed_mode_source, api_service_tier, turns, speed_turns, ttft_turns, completion_turns,
                timed_responses, speed_tokens, speed_duration_ms, speed_min, speed_max, ttft_min, ttft_max,
                completion_min, completion_max
           FROM ${table(quoted, "telemetry_performance_cohorts")}
          WHERE report_id = ANY($1::text[])
          ORDER BY report_id, cohort_index
          LIMIT $2`,
        [ids, MAX_READ_COHORT_ROWS + 1],
      );
      const bucketRows = await client.query<BucketRow>(
        `SELECT report_id, cohort_index, metric, bucket_index, bucket_count
           FROM ${table(quoted, "telemetry_performance_buckets")}
          WHERE report_id = ANY($1::text[])
          ORDER BY report_id, cohort_index, metric, bucket_index
          LIMIT $2`,
        [ids, MAX_READ_BUCKET_ROWS + 1],
      );
      if (cohorts.rows.length > MAX_READ_COHORT_ROWS || bucketRows.rows.length > MAX_READ_BUCKET_ROWS) {
        rangeTooLarge();
      }
      // One snapshot serves every statement, so a mismatch is storage drift:
      // never return a partial reconstruction.
      if (cohorts.rows.length !== cohortCount || bucketRows.rows.length !== bucketCount) unavailable();
      const cohortsByReport = new Map<string, CohortRow[]>();
      for (const row of cohorts.rows) {
        const key = String(row.report_id);
        const list = cohortsByReport.get(key) ?? [];
        list.push(row);
        cohortsByReport.set(key, list);
      }
      const bucketsByCohort = new Map<string, BucketRow[]>();
      for (const row of bucketRows.rows) {
        const key = `${String(row.report_id)}\0${String(row.cohort_index)}`;
        const list = bucketsByCohort.get(key) ?? [];
        list.push(row);
        bucketsByCohort.set(key, list);
      }
      return Object.freeze({
        schemaVersion: READ_SCHEMA_VERSION,
        population: READ_POPULATION,
        reports: Object.freeze(reports.map((report) => Object.freeze({
          day: report.day,
          reportRevision: report.reportRevision,
          sourceGeneration: report.sourceGeneration,
          sourceDigest: report.sourceDigest,
          sourceRevision: report.sourceRevision,
          fieldDictionaryVersion: report.fieldDictionaryVersion,
          state: report.state,
          createdAt: report.createdAt,
          cohorts: Object.freeze((cohortsByReport.get(report.id) ?? []).map((cohort) => cohortRead(
            cohort, bucketsByCohort.get(`${report.id}\0${String(cohort.cohort_index)}`) ?? []))),
        }))),
      });
    }, { operation: "telemetry_performance.report_read", preserveSafeError: readSafeError });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    unavailable();
  }
}

export { REPORT_SCHEMA_VERSION as POSTGRES_TELEMETRY_PERFORMANCE_REPORT_SCHEMA_VERSION };
