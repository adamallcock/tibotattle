import {
  canonicalTelemetryPerformanceJson,
  parseTelemetryPerformanceRecord,
  PERFORMANCE_BUCKET_SCHEME_VERSION,
  PERFORMANCE_FIELD_DICTIONARY_VERSION,
  PERFORMANCE_MEASUREMENT_VERSION,
  PERFORMANCE_PRIVACY_CONTRACT_VERSION,
  PERFORMANCE_RECORD_SCHEMA_VERSION,
} from "@app-usagemonitor/telemetry-contract";
import { ApiError } from "./errors";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import {
  assertTelemetryPerformanceWriteAllowed,
  TELEMETRY_PERFORMANCE_METHOD_VERSION,
  type TelemetryPerformanceAuthorization,
  type TelemetryPerformancePrincipal,
} from "./telemetry-performance-policy";

const REPORT_SCHEMA_VERSION = "telemetry-performance-report-v1";
const REPORT_KEYS = [
  "bucketSchemeVersion", "day", "fieldDictionaryVersion", "measurementVersion",
  "methodVersion", "parserVersion", "privacyContractVersion", "records", "reportRevision",
  "schemaVersion", "sourceDigest", "sourceGeneration", "sourceRevision",
] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/u;
const MAX_REPORT_RECORDS = 1_024;
const MAX_REPORT_BYTES = 1_250_000;
const MAX_REPORTS_PER_READ = 256;
// A range may contain many small daily reports, but it must remain bounded
// before the cohort and sparse-bin rows are materialized.  The Worker memory
// limit is substantially larger than this envelope; keeping the canonical
// payload budget at 8 MiB leaves room for typed rows, maps, and the response
// object while preserving ordinary 31/90-day reads.
const MAX_READ_CANONICAL_BYTES = 8 * 1024 * 1024;
const MAX_READ_RECORDS = 16_384;
// A corrupt or hand-written report can claim a small canonical payload while
// retaining an unexpectedly large detail fan-out.  Count both detail tables
// before selecting any rows so that the read remains bounded even then.
const MAX_READ_COHORT_ROWS = 16_384;
const MAX_READ_BUCKET_ROWS = 65_536;
// The report byte bound applies to the canonical client payload.  Bucket rows
// repeat the report/cohort metadata when encoded for json_each(), so keep each
// binding comfortably below D1's SQL-text limit instead of passing the whole
// sparse histogram expansion as one parameter.  D1 separately permits values
// up to roughly 2 MB; this 90 KB policy leaves headroom below the roughly
// 100 KB SQL-text bound for driver framing.  The canonical report itself
// remains capped at 1.25 MB; only the expanded json_each bindings are split.
const MAX_INSERT_JSON_BYTES = 90_000;
const MAX_INSERT_JSON_ROWS = 8_192;

export interface TelemetryPerformanceReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly day: string;
  readonly reportRevision: string;
  readonly sourceGeneration: string;
  readonly sourceDigest: string;
  readonly sourceRevision: number;
  readonly methodVersion: typeof TELEMETRY_PERFORMANCE_METHOD_VERSION;
  readonly parserVersion: string;
  readonly fieldDictionaryVersion: typeof PERFORMANCE_FIELD_DICTIONARY_VERSION;
  readonly privacyContractVersion: typeof PERFORMANCE_PRIVACY_CONTRACT_VERSION;
  readonly bucketSchemeVersion: typeof PERFORMANCE_BUCKET_SCHEME_VERSION;
  readonly measurementVersion: typeof PERFORMANCE_MEASUREMENT_VERSION;
  readonly records: readonly Record<string, unknown>[];
}

interface ReportRow {
  id: string;
  report_day: string;
  report_revision: string;
  source_generation: string;
  source_digest: string;
  source_revision: number;
  method_version: string;
  parser_version: string;
  record_count: number;
  canonical_bytes: number;
  created_at: string;
  state: "current" | "superseded";
}

interface CohortRow {
  report_id: string;
  cohort_index: number;
  provider: string;
  model_id: string;
  reasoning_effort: string;
  speed_method: string;
  speed_mode: string;
  speed_mode_source: string;
  api_service_tier: string;
  turns: number;
  speed_turns: number;
  ttft_turns: number;
  completion_turns: number;
  timed_responses: number;
  speed_tokens: number;
  speed_duration_ms: number;
  speed_min: number | null;
  speed_max: number | null;
  ttft_min: number | null;
  ttft_max: number | null;
  completion_min: number | null;
  completion_max: number | null;
}

interface BucketRow {
  report_id: string;
  cohort_index: number;
  metric: "speed" | "ttft" | "turnDuration";
  bucket_index: number;
  bucket_count: number;
}

interface DetailCountRow {
  total: number;
}

export interface TelemetryPerformanceBucket {
  readonly index: number;
  readonly count: number;
}

export interface TelemetryPerformanceHistogramRead {
  readonly metric: BucketRow["metric"];
  readonly min: number | null;
  readonly max: number | null;
  readonly buckets: readonly TelemetryPerformanceBucket[];
}

export interface TelemetryPerformanceCohortRead {
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
  readonly speedHistogram: TelemetryPerformanceHistogramRead;
  readonly ttftHistogram: TelemetryPerformanceHistogramRead;
  readonly completionHistogram: TelemetryPerformanceHistogramRead;
}

export interface TelemetryPerformanceReportRead {
  readonly day: string;
  readonly reportRevision: string;
  readonly sourceGeneration: string;
  readonly sourceDigest: string;
  readonly sourceRevision: number;
  readonly state: ReportRow["state"];
  readonly createdAt: string;
  readonly cohorts: readonly TelemetryPerformanceCohortRead[];
}

export interface TelemetryPerformanceReadResult {
  readonly schemaVersion: "telemetry-performance-read-v1";
  readonly population: "reported_samples";
  readonly reports: readonly TelemetryPerformanceReportRead[];
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= 0 && value <= max;
}

function utcDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function invalid(code: "TELEMETRY_RECORD_INVALID" | "TELEMETRY_MANIFEST_CONFLICT" = "TELEMETRY_RECORD_INVALID"): never {
  throw new ApiError(409, code);
}

function safeString(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function reportBody(report: TelemetryPerformanceReport): Record<string, unknown> {
  const { reportRevision: _revision, ...body } = report;
  return body;
}

function cohortIdentity(record: Record<string, unknown>): string {
  // These fields describe the complete population partition.  Keeping the
  // source and tier in the identity prevents two distinct measurements from
  // being silently pooled under one model/effort row.
  return JSON.stringify([
    record.provider,
    record.modelId,
    record.reasoningEffort,
    record.speedMethod,
    record.speedMode,
    record.speedModeSource,
    record.apiServiceTier,
  ]);
}

/** Worker-side closed report parser; no report JSON is retained after rows are typed. */
export function parseTelemetryPerformanceReport(value: unknown): TelemetryPerformanceReport {
  if (!exact(value, REPORT_KEYS)
      || value.schemaVersion !== REPORT_SCHEMA_VERSION
      || !utcDay(value.day)
      || !safeString(value.reportRevision, DIGEST)
      || !safeString(value.sourceGeneration, TOKEN)
      || !safeString(value.sourceDigest, DIGEST)
      || !integer(value.sourceRevision)
      || value.methodVersion !== TELEMETRY_PERFORMANCE_METHOD_VERSION
      || !safeString(value.parserVersion, TOKEN)
      || value.fieldDictionaryVersion !== PERFORMANCE_FIELD_DICTIONARY_VERSION
      || value.privacyContractVersion !== PERFORMANCE_PRIVACY_CONTRACT_VERSION
      || value.bucketSchemeVersion !== PERFORMANCE_BUCKET_SCHEME_VERSION
      || value.measurementVersion !== PERFORMANCE_MEASUREMENT_VERSION
      || !Array.isArray(value.records)
      || value.records.length > MAX_REPORT_RECORDS) {
    invalid();
  }
  const records: Record<string, unknown>[] = [];
  let previous = "";
  const seen = new Set<string>();
  const seenCohorts = new Set<string>();
  for (const record of value.records) {
    try { parseTelemetryPerformanceRecord(record); } catch { invalid(); }
    const canonical = canonicalTelemetryPerformanceJson(record);
    if (seen.has(canonical) || (previous !== "" && previous > canonical)) invalid();
    const identity = cohortIdentity(record);
    if (seenCohorts.has(identity)) invalid();
    seenCohorts.add(identity);
    seen.add(canonical);
    previous = canonical;
    records.push(JSON.parse(canonical) as Record<string, unknown>);
    if (records.at(-1)?.day !== value.day) invalid();
  }
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    day: value.day,
    reportRevision: value.reportRevision,
    sourceGeneration: value.sourceGeneration,
    sourceDigest: value.sourceDigest,
    sourceRevision: value.sourceRevision,
    methodVersion: value.methodVersion,
    parserVersion: value.parserVersion,
    fieldDictionaryVersion: value.fieldDictionaryVersion,
    privacyContractVersion: value.privacyContractVersion,
    bucketSchemeVersion: value.bucketSchemeVersion,
    measurementVersion: value.measurementVersion,
    records,
  } as TelemetryPerformanceReport;
  const bytes = new TextEncoder().encode(canonicalJson(report)).byteLength;
  if (bytes < 1 || bytes > MAX_REPORT_BYTES) invalid();
  return report;
}

function histogramParts(value: Record<string, unknown>, key: string) {
  const histogram = value[key] as Record<string, unknown>;
  const buckets = histogram.buckets as Record<string, number>;
  const rows = Object.entries(buckets).map(([index, count]) => ({
    index: Number(index), count,
  }));
  return {
    min: histogram.min as number | null,
    max: histogram.max as number | null,
    rows,
  };
}

function cohortInsertValues(reportId: string, records: readonly Record<string, unknown>[]) {
  const cohorts: Record<string, unknown>[] = [];
  // Compact tuples avoid repeating reportId and JSON property names for every
  // sparse bin.  The report id is bound once by the INSERT statement.
  const buckets: (readonly [number, BucketRow["metric"], number, number])[] = [];
  records.forEach((record, index) => {
    const speed = histogramParts(record, "speedHistogram");
    const ttft = histogramParts(record, "ttftHistogram");
    const completion = histogramParts(record, "completionHistogram");
    cohorts.push({
      reportId, cohortIndex: index, provider: record.provider, modelId: record.modelId,
      reasoningEffort: record.reasoningEffort, speedMethod: record.speedMethod,
      speedMode: record.speedMode, speedModeSource: record.speedModeSource,
      apiServiceTier: record.apiServiceTier, turns: record.turns,
      speedTurns: record.speedTurns, ttftTurns: record.ttftTurns,
      completionTurns: record.completionTurns, timedResponses: record.timedResponses,
      speedTokens: record.speedTokens, speedDurationMs: record.speedDurationMs,
      speedMin: speed.min, speedMax: speed.max, ttftMin: ttft.min, ttftMax: ttft.max,
      completionMin: completion.min, completionMax: completion.max,
    });
    for (const [metric, parts] of [["speed", speed], ["ttft", ttft], ["turnDuration", completion]] as const) {
      for (const bucket of parts.rows) buckets.push([
        index, metric, bucket.index, bucket.count,
      ]);
    }
  });
  return { cohorts, buckets };
}

function jsonBindingChunks(rows: readonly unknown[]): string[] {
  if (rows.length === 0) return [];
  const chunks: string[] = [];
  let current: unknown[] = [];
  let currentBytes = 2; // '[' and ']'
  const encoder = new TextEncoder();
  for (const row of rows) {
    const rowBytes = encoder.encode(JSON.stringify(row)).byteLength;
    const separatorBytes = current.length > 0 ? 1 : 0;
    const candidateBytes = currentBytes + separatorBytes + rowBytes;
    if (current.length > 0 && (current.length >= MAX_INSERT_JSON_ROWS
      || candidateBytes > MAX_INSERT_JSON_BYTES)) {
      chunks.push(JSON.stringify(current));
      current = [row];
      currentBytes = 2 + rowBytes;
      if (currentBytes > MAX_INSERT_JSON_BYTES) invalid();
    } else {
      current.push(row);
      currentBytes = candidateBytes;
    }
  }
  if (current.length > 0) chunks.push(JSON.stringify(current));
  return chunks;
}

function mapRepositoryError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const message = String(error);
  if (message.includes("telemetry_performance_report_admission_denied")) {
    return new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  if (message.includes("telemetry_performance_capability_unavailable")) {
    return new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  }
  if (message.includes("telemetry_performance_report_revision_conflict")) {
    return new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  }
  if (message.includes("UNIQUE constraint failed: telemetry_performance_current_day")) {
    return new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  }
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function storedMetadataInvalid(): never {
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function validateStoredReportMetadata(row: ReportRow): void {
  // These declarations drive the range preflight and are also copied into the
  // response.  Treat a malformed row as unavailable rather than trusting a
  // widened/negative SQLite value to bypass the memory envelope.
  if (!safeString(row.id, /^[A-Za-z0-9-]{36}$/u)
      || !utcDay(row.report_day)
      || !safeString(row.report_revision, DIGEST)
      || !safeString(row.source_generation, TOKEN)
      || !safeString(row.source_digest, DIGEST)
      || !integer(row.source_revision)
      || !safeString(row.method_version, TOKEN)
      || !safeString(row.parser_version, TOKEN)
      || !integer(row.record_count, MAX_REPORT_RECORDS)
      || !integer(row.canonical_bytes, MAX_REPORT_BYTES)
      || row.canonical_bytes < 1
      || typeof row.created_at !== "string"
      || row.created_at.length < 1
      || row.created_at.length > 128
      || (row.state !== "current" && row.state !== "superseded")) {
    storedMetadataInvalid();
  }
}

function detailCount(value: unknown, maximum: number): number {
  if (!integer(value)) storedMetadataInvalid();
  if (value > maximum) throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  return value;
}

export interface TelemetryPerformanceAdmission {
  readonly status: "accepted" | "replaced" | "idempotent";
  readonly reportId: string;
  readonly day: string;
  readonly reportRevision: string;
}

/**
 * Admit one encrypted/decrypted daily report after the route has authenticated
 * the device.  A report revision is immutable; a later revision supersedes
 * the current device/day row in the same D1 batch.  The server never stores
 * per-turn membership or the encrypted plaintext.
 */
export async function admitTelemetryPerformanceReport(
  db: D1Database,
  principal: TelemetryPerformancePrincipal,
  value: unknown,
  authorization: TelemetryPerformanceAuthorization,
  envelopeDigest: string,
  nowEpoch = Date.now(),
): Promise<TelemetryPerformanceAdmission> {
  if (!DIGEST.test(envelopeDigest)) invalid();
  const report = parseTelemetryPerformanceReport(value);
  await assertTelemetryPerformanceWriteAllowed(db, principal, authorization, nowEpoch);
  const existing = await db.prepare(
    `SELECT id, report_day, report_revision, state
       FROM telemetry_performance_reports
      WHERE participant_id = ? AND device_id = ? AND report_day = ? AND report_revision = ?`,
  ).bind(principal.participantId, principal.deviceId, report.day, report.reportRevision)
    .first<Pick<ReportRow, "id" | "report_day" | "report_revision" | "state">>();
  if (existing) {
    return Object.freeze({
      status: "idempotent", reportId: existing.id,
      day: existing.report_day, reportRevision: existing.report_revision,
    });
  }
  const expectedRevision = await sha256Hex(canonicalJson(reportBody(report)));
  if (expectedRevision !== report.reportRevision) invalid("TELEMETRY_MANIFEST_CONFLICT");
  const canonicalBytes = new TextEncoder().encode(canonicalJson(report)).byteLength;
  const current = await db.prepare(
    `SELECT id, source_generation, source_digest, source_revision FROM telemetry_performance_reports
      WHERE participant_id = ? AND device_id = ? AND report_day = ? AND state = 'current'`,
  ).bind(principal.participantId, principal.deviceId, report.day)
    .first<Pick<ReportRow, "id" | "source_generation" | "source_digest" | "source_revision">>();
  if (current) {
    if (current.source_revision > report.sourceRevision
        || (current.source_revision === report.sourceRevision
          && (current.source_generation !== report.sourceGeneration
            || current.source_digest !== report.sourceDigest))) {
      // sourceRevision is a generic, persistent local mutation counter.  It
      // orders reports even when a parser rebuild changes the opaque source
      // generation; an older generation replay therefore cannot displace a
      // newer snapshot.  Equal counters must describe the exact same source
      // generation and digest.
      invalid("TELEMETRY_MANIFEST_CONFLICT");
    }
  }
  const reportId = crypto.randomUUID();
  const now = new Date(nowEpoch).toISOString();
  const { cohorts, buckets } = cohortInsertValues(reportId, report.records);
  const cohortJsonChunks = jsonBindingChunks(cohorts);
  const bucketJsonChunks = jsonBindingChunks(buckets);
  const statements = [
    ...(current ? [db.prepare(
      `UPDATE telemetry_performance_reports
          SET state = 'superseded', superseded_at = ?
        WHERE id = ? AND state = 'current'`,
    ).bind(now, current.id)] : []),
    db.prepare(
      `INSERT INTO telemetry_performance_reports (
        id, participant_id, device_id, report_day, report_revision,
        source_generation, source_digest, source_revision, method_version,
        parser_version, schema_version, field_dictionary_version,
        privacy_contract_version, bucket_scheme_version, measurement_version,
        record_count, canonical_bytes, capability_revision, authority_epoch,
        state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?)`,
    ).bind(reportId, principal.participantId, principal.deviceId, report.day, report.reportRevision,
      report.sourceGeneration, report.sourceDigest, report.sourceRevision, report.methodVersion,
      report.parserVersion, PERFORMANCE_RECORD_SCHEMA_VERSION, report.fieldDictionaryVersion,
      report.privacyContractVersion, report.bucketSchemeVersion, report.measurementVersion,
      report.records.length, canonicalBytes, authorization.capabilityRevision,
      authorization.authorityEpoch, now),
    ...cohortJsonChunks.map((cohortJson) => db.prepare(
      `INSERT INTO telemetry_performance_cohorts (
        report_id, cohort_index, provider, model_id, reasoning_effort, speed_method,
        speed_mode, speed_mode_source, api_service_tier, turns, speed_turns,
        ttft_turns, completion_turns, timed_responses, speed_tokens, speed_duration_ms,
        speed_min, speed_max, ttft_min, ttft_max, completion_min, completion_max
      ) SELECT json_extract(value, '$.reportId'), CAST(json_extract(value, '$.cohortIndex') AS INTEGER),
        json_extract(value, '$.provider'), json_extract(value, '$.modelId'),
        json_extract(value, '$.reasoningEffort'), json_extract(value, '$.speedMethod'),
        json_extract(value, '$.speedMode'), json_extract(value, '$.speedModeSource'),
        json_extract(value, '$.apiServiceTier'), CAST(json_extract(value, '$.turns') AS INTEGER),
        CAST(json_extract(value, '$.speedTurns') AS INTEGER), CAST(json_extract(value, '$.ttftTurns') AS INTEGER),
        CAST(json_extract(value, '$.completionTurns') AS INTEGER), CAST(json_extract(value, '$.timedResponses') AS INTEGER),
        CAST(json_extract(value, '$.speedTokens') AS INTEGER), CAST(json_extract(value, '$.speedDurationMs') AS INTEGER),
        json_extract(value, '$.speedMin'), json_extract(value, '$.speedMax'),
        json_extract(value, '$.ttftMin'), json_extract(value, '$.ttftMax'),
        json_extract(value, '$.completionMin'), json_extract(value, '$.completionMax')
        FROM json_each(?)`,
    ).bind(cohortJson)),
    ...bucketJsonChunks.map((bucketJson) => db.prepare(
      `INSERT INTO telemetry_performance_buckets (
        report_id, cohort_index, metric, bucket_index, bucket_count
      ) SELECT ?, CAST(json_extract(value, '$[0]') AS INTEGER),
        json_extract(value, '$[1]'), CAST(json_extract(value, '$[2]') AS INTEGER),
        CAST(json_extract(value, '$[3]') AS INTEGER)
        FROM json_each(?)`,
    ).bind(reportId, bucketJson)),
    db.prepare(
      `INSERT INTO telemetry_performance_receipts (
        id, participant_id, device_id, report_id, report_day, report_revision,
        envelope_digest, outcome, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), principal.participantId, principal.deviceId, reportId,
      report.day, report.reportRevision, envelopeDigest, current ? "replaced" : "accepted", now),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    throw mapRepositoryError(error);
  }
  return Object.freeze({
    status: current ? "replaced" : "accepted",
    reportId, day: report.day, reportRevision: report.reportRevision,
  });
}

function histogramFor(
  cohort: CohortRow,
  metric: BucketRow["metric"],
  rows: readonly BucketRow[],
): TelemetryPerformanceHistogramRead {
  const min = metric === "speed" ? cohort.speed_min
    : metric === "ttft" ? cohort.ttft_min : cohort.completion_min;
  const max = metric === "speed" ? cohort.speed_max
    : metric === "ttft" ? cohort.ttft_max : cohort.completion_max;
  return Object.freeze({
    metric,
    min,
    max,
    buckets: Object.freeze(rows.filter((row) => row.metric === metric)
      .sort((left, right) => left.bucket_index - right.bucket_index)
      .map((row) => Object.freeze({ index: row.bucket_index, count: row.bucket_count }))),
  });
}

/** Read typed cohorts and bins.  The population label makes pooled samples' semantics explicit. */
export async function readTelemetryPerformanceReports(
  db: D1Database,
  participantId: string,
  options: { fromDay?: string; throughDay?: string; deviceId?: string; includeSuperseded?: boolean } = {},
): Promise<TelemetryPerformanceReadResult> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(participantId)
      || (options.fromDay !== undefined && !utcDay(options.fromDay))
      || (options.throughDay !== undefined && !utcDay(options.throughDay))
      || (options.includeSuperseded !== undefined && typeof options.includeSuperseded !== "boolean")
      || (options.fromDay && options.throughDay && options.fromDay > options.throughDay)) {
    invalid();
  }
  const statePredicate = options.includeSuperseded === true
    ? "state IN ('current', 'superseded')" : "state = 'current'";
  const rows = await db.prepare(
    `SELECT id, report_day, report_revision, source_generation, source_digest, source_revision,
            method_version, parser_version, record_count, canonical_bytes, created_at, state
       FROM telemetry_performance_reports
      WHERE participant_id = ? AND ${statePredicate}
        AND (? IS NULL OR report_day >= ?) AND (? IS NULL OR report_day <= ?)
        AND (? IS NULL OR device_id = ?)
      ORDER BY report_day, created_at, id LIMIT ?`,
  ).bind(participantId, options.fromDay ?? null, options.fromDay ?? null,
    options.throughDay ?? null, options.throughDay ?? null,
    options.deviceId ?? null, options.deviceId ?? null, MAX_REPORTS_PER_READ + 1)
    .all<ReportRow>();
  if (rows.results.length > MAX_REPORTS_PER_READ) throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  if (rows.results.length === 0) {
    return Object.freeze({ schemaVersion: "telemetry-performance-read-v1", population: "reported_samples", reports: [] });
  }
  let canonicalBytes = 0;
  let recordCount = 0;
  for (const row of rows.results) {
    validateStoredReportMetadata(row);
    canonicalBytes += row.canonical_bytes;
    recordCount += row.record_count;
    if (canonicalBytes > MAX_READ_CANONICAL_BYTES || recordCount > MAX_READ_RECORDS) {
      throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
    }
  }
  const ids = rows.results.map((row) => row.id);
  const idJson = JSON.stringify(ids);
  // Count detail rows in SQL before selecting them.  This is a second fence
  // against storage drift: declared metadata bounds the normal path, while a
  // malformed or maintenance-created fan-out cannot force a large result set
  // into Worker memory.
  const [cohortCountResult, bucketCountResult] = await db.batch([
    db.prepare(
      `SELECT count(*) AS total
         FROM telemetry_performance_cohorts
        WHERE report_id IN (SELECT value FROM json_each(?))`,
    ).bind(idJson),
    db.prepare(
      `SELECT count(*) AS total
         FROM telemetry_performance_buckets
        WHERE report_id IN (SELECT value FROM json_each(?))`,
    ).bind(idJson),
  ]);
  const cohortCount = detailCount(
    (cohortCountResult?.results[0] as DetailCountRow | undefined)?.total,
    MAX_READ_COHORT_ROWS,
  );
  const bucketCount = detailCount(
    (bucketCountResult?.results[0] as DetailCountRow | undefined)?.total,
    MAX_READ_BUCKET_ROWS,
  );
  if (cohortCount !== recordCount) storedMetadataInvalid();
  const [cohorts, buckets] = await db.batch([
    db.prepare(
      `SELECT report_id, cohort_index, provider, model_id, reasoning_effort, speed_method,
              speed_mode, speed_mode_source, api_service_tier, turns, speed_turns,
              ttft_turns, completion_turns, timed_responses, speed_tokens, speed_duration_ms,
              speed_min, speed_max, ttft_min, ttft_max, completion_min, completion_max
         FROM telemetry_performance_cohorts
        WHERE report_id IN (SELECT value FROM json_each(?))
        ORDER BY report_id, cohort_index
        LIMIT ?`,
    ).bind(idJson, MAX_READ_COHORT_ROWS + 1),
    db.prepare(
      `SELECT report_id, cohort_index, metric, bucket_index, bucket_count
         FROM telemetry_performance_buckets
        WHERE report_id IN (SELECT value FROM json_each(?))
        ORDER BY report_id, cohort_index, metric, bucket_index
        LIMIT ?`,
    ).bind(idJson, MAX_READ_BUCKET_ROWS + 1),
  ]);
  const cohortRows = cohorts?.results ?? [];
  const bucketRows = buckets?.results ?? [];
  if (cohortRows.length > MAX_READ_COHORT_ROWS
      || bucketRows.length > MAX_READ_BUCKET_ROWS) {
    throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  }
  if (cohortRows.length !== cohortCount || bucketRows.length !== bucketCount) {
    // The source tables changed between the count fence and detail selection
    // (for example, owner erasure raced this read).  Do not return a partial
    // reconstruction or silently turn the race into a smaller population.
    storedMetadataInvalid();
  }
  const cohortsByReport = new Map<string, CohortRow[]>();
  for (const row of cohortRows as CohortRow[]) {
    const list = cohortsByReport.get(row.report_id) ?? [];
    list.push(row); cohortsByReport.set(row.report_id, list);
  }
  const bucketsByCohort = new Map<string, BucketRow[]>();
  for (const row of bucketRows as BucketRow[]) {
    const key = `${row.report_id}\0${row.cohort_index}`;
    const list = bucketsByCohort.get(key) ?? [];
    list.push(row); bucketsByCohort.set(key, list);
  }
  const reports = rows.results.map((row) => Object.freeze({
    day: row.report_day,
    reportRevision: row.report_revision,
    sourceGeneration: row.source_generation,
    sourceDigest: row.source_digest,
    sourceRevision: row.source_revision,
    state: row.state,
    createdAt: row.created_at,
    cohorts: Object.freeze((cohortsByReport.get(row.id) ?? []).map((cohort) => {
      const bucketRows = bucketsByCohort.get(`${row.id}\0${cohort.cohort_index}`) ?? [];
      return Object.freeze({
        provider: cohort.provider, modelId: cohort.model_id, reasoningEffort: cohort.reasoning_effort,
        speedMethod: cohort.speed_method, speedMode: cohort.speed_mode,
        speedModeSource: cohort.speed_mode_source, apiServiceTier: cohort.api_service_tier,
        turns: cohort.turns, speedTurns: cohort.speed_turns, ttftTurns: cohort.ttft_turns,
        completionTurns: cohort.completion_turns, timedResponses: cohort.timed_responses,
        speedTokens: cohort.speed_tokens, speedDurationMs: cohort.speed_duration_ms,
        speedHistogram: histogramFor(cohort, "speed", bucketRows),
        ttftHistogram: histogramFor(cohort, "ttft", bucketRows),
        completionHistogram: histogramFor(cohort, "turnDuration", bucketRows),
      });
    })),
  }));
  return Object.freeze({ schemaVersion: "telemetry-performance-read-v1", population: "reported_samples", reports });
}

/** Caller supplies the already-authorized owner erase operation; this function only removes this dialect. */
export async function eraseTelemetryPerformanceReports(
  db: D1Database,
  participantId: string,
): Promise<{ deletedReports: number; deletedReceipts: number }> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(participantId)) invalid();
  const counts = await db.prepare(
    `SELECT
       (SELECT count(*) FROM telemetry_performance_reports WHERE participant_id = ?) AS reports,
       (SELECT count(*) FROM telemetry_performance_receipts WHERE participant_id = ?) AS receipts`,
  ).bind(participantId, participantId).first<{ reports: number; receipts: number }>();
  const result = await db.batch([
    db.prepare("DELETE FROM telemetry_performance_receipts WHERE participant_id = ?").bind(participantId),
    db.prepare("DELETE FROM telemetry_performance_reports WHERE participant_id = ?").bind(participantId),
    db.prepare("DELETE FROM telemetry_performance_device_capabilities WHERE participant_id = ?").bind(participantId),
    db.prepare("DELETE FROM accountless_telemetry_performance_authorizations WHERE participant_id = ?").bind(participantId),
  ]);
  if (!counts || result.length < 4) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return { deletedReports: Number(counts.reports ?? 0), deletedReceipts: Number(counts.receipts ?? 0) };
}

export { REPORT_SCHEMA_VERSION as TELEMETRY_PERFORMANCE_REPORT_SCHEMA_VERSION };
