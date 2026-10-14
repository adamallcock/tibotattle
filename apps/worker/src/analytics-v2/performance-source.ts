/**
 * analytics-v2 performance source (A-1, SPD-P2a): the current accountless
 * model-performance reports of primary migration 0079, read back as exact
 * contract records for the community-model-performance-v1 fold.
 *
 * Reading:
 *  - Keyset pages by (report_day, report id) over the current reports with
 *    record_count > 0 and report_day <= throughDay. The page statement walks
 *    0079's partial index telemetry_performance_reports_community_day
 *    (report_day, id) WHERE state = 'current'; a continuation is a row
 *    comparison on the same key, so every page is an index range read.
 *  - Each page's cohorts come back in (page order, cohort_index) order, with
 *    their sparse buckets aggregated per (report, cohort, metric) in SQL (one
 *    JSON object per histogram), so no bucket row reaches the client.
 *  - A superseded report, or a current zero-record report (a day tombstone),
 *    is never read. Current non-empty reports after throughDay are not read
 *    either; their distinct days are counted as deferredFutureDays. The
 *    record_count > 0 filter sits outside the partial index predicate, so day
 *    tombstones inside a page's key range are visited and discarded.
 *
 * Snapshot: the reader runs on the caller's client, inside the caller's
 * read-only REPEATABLE READ transaction (the refresh Job's exported snapshot,
 * or owners.ts withAnalyticsV2ReadSnapshot). It opens, commits and rolls back
 * no transaction of its own; it refuses a client that is not in a read-only
 * repeatable-read (or serializable) transaction. Every page starts with the
 * snapshot.read_only guard, which also reads pg_current_snapshot()::text, and
 * ends by reading it again:
 *  - The checkpoint is bound to that snapshot. A continuation whose snapshot
 *    differs from the one that issued the checkpoint is refused with
 *    SOURCE_INVALID, so a keyset position never carries into a later state
 *    (where a superseded report's replacement could sort after it and a
 *    device-day would be read twice). Under REPEATABLE READ the value is fixed
 *    for the transaction, and every session that imports one exported
 *    snapshot (SET TRANSACTION SNAPSHOT) reports the same value, so a page may
 *    continue on another connection of createSnapshotReadPool.
 *  - Equal snapshot text means equal visibility (no transaction completed in
 *    between), so a page whose closing read differs from its opening guard
 *    mixed snapshots (for example an autocommit session whose session defaults
 *    are REPEATABLE READ READ ONLY) and fails with SOURCE_UNAVAILABLE.
 * The checkpoint is an in-memory token, never persisted.
 *
 * Output: every cohort is rebuilt into the contract record shape
 * (model-performance-daily-v1, keys in the contract's order): the report's
 * schemaVersion, day, measurementVersion and bucketSchemeVersion, the cohort's
 * labels and counts, and three histograms whose sampleCount is the sum of
 * their bucket counts and whose min/max are the stored extrema. The reader
 * only decodes; contract validation (adaptTelemetryPerformanceRecord under
 * fieldDictionaryVersion) is the fold's, so an invalid stored record withholds
 * the performance publication instead of failing the whole run.
 *
 * Keys: participantKey, deviceKey and reportKey are opaque in-memory values.
 * participantKey equals the participant id that community_aggregate_exclusions
 * names (exclusions are an equality lookup); the others only distinguish
 * devices and reports. None of them is ever part of a summary, a checkpoint's
 * enumerable state, a log line or an output.
 *
 * Bounds: a page reads at most pageSize reports and a run at most maxCohorts
 * cohorts (checked from the reports' declared record counts before any cohort
 * row is selected). Failures carry closed AnalyticsV2SourceError codes:
 * SOURCE_INVALID for bad options or a foreign checkpoint, SOURCE_LIMIT for an
 * exceeded run budget, SOURCE_UNAVAILABLE for a missing snapshot or storage
 * drift. No value, identifier or SQL appears in an error.
 *
 * Statement tags: every statement carries `/* analytics_v2:<family> *\/`
 * through owners.ts analyticsV2Statement, whose closed family list holds the
 * two performance families (PERFORMANCE_SOURCE_STATEMENT_FAMILIES); the
 * refresh Job's statement ledger and failure projection name them. The
 * snapshot guard uses the existing snapshot.read_only family.
 *
 * A kernel closure root (cloud-run/analytics-kernel-closure.mjs): the
 * refresh Job streams these pages into the fold (compute-performance.ts)
 * through cloud-run/analytics-refresh-read.mjs, page by page, while the
 * run's snapshot is open. Nothing here writes.
 */

import type { TelemetryPerformanceRecord } from "@app-usagemonitor/telemetry-contract";
import type { PostgresClient } from "../postgres-client";
import {
  analyticsV2Statement,
  dayNumber,
  quotedSchema,
  safeInteger,
  sourceFail,
  type AnalyticsV2StatementFamily,
} from "./owners";

/** The statement families of this reader (members of owners.ts ANALYTICS_V2_STATEMENT_FAMILIES). */
export const PERFORMANCE_SOURCE_STATEMENT_FAMILIES = Object.freeze([
  "performance.reports",
  "performance.cohorts",
] as const satisfies readonly AnalyticsV2StatementFamily[]);
export type PerformanceSourceStatementFamily = (typeof PERFORMANCE_SOURCE_STATEMENT_FAMILIES)[number];

/** Reports per page: the default and the ceiling. */
export const DEFAULT_ANALYTICS_V2_PERFORMANCE_PAGE_REPORTS = 256;
export const MAX_ANALYTICS_V2_PERFORMANCE_PAGE_REPORTS = 1_024;
/**
 * Cohorts per run: the default and the ceiling. The run reads the whole corpus
 * (the publication's "all" window), so the bound is sized for decades of
 * community growth, not a convenience window. It bounds work, not memory:
 * production folds page by page; collectAnalyticsV2PerformanceSource holds
 * every record and is meant for tests and small corpora.
 */
export const DEFAULT_ANALYTICS_V2_PERFORMANCE_COHORTS = 10_000_000;
export const MAX_ANALYTICS_V2_PERFORMANCE_COHORTS = 10_000_000;

/** An opaque in-memory key. Never output, logged or persisted. */
export type AnalyticsV2PerformanceSourceKey = string;

/** One rebuilt cohort record with its opaque owner, device and report keys. */
export interface AnalyticsV2PerformanceSourceRecord {
  readonly participantKey: AnalyticsV2PerformanceSourceKey;
  readonly deviceKey: AnalyticsV2PerformanceSourceKey;
  readonly reportKey: AnalyticsV2PerformanceSourceKey;
  readonly reportDay: string;
  /** The report's stored field dictionary (validated by the fold, not here). */
  readonly fieldDictionaryVersion: string;
  /** Contract-shaped; the fold validates it under fieldDictionaryVersion. */
  readonly record: Readonly<TelemetryPerformanceRecord>;
}

/** An opaque keyset position, accepted only on the snapshot that issued it. */
export interface AnalyticsV2PerformanceSourceCheckpoint {
  readonly kind: "analytics-v2-performance-source-checkpoint";
}

/** Content-free run counts through the current page. */
export interface AnalyticsV2PerformanceSourceSummary {
  /** Reports and cohorts read so far in this run (cumulative). */
  readonly reports: number;
  readonly cohorts: number;
  /** Pages read so far in this run, this one included. */
  readonly pages: number;
  /** Distinct days after throughDay that hold a current non-empty report. */
  readonly deferredFutureDays: number;
  /** True when no current non-empty report remains after this page. */
  readonly complete: boolean;
}

export interface AnalyticsV2PerformanceSourcePage {
  readonly records: readonly AnalyticsV2PerformanceSourceRecord[];
  readonly summary: AnalyticsV2PerformanceSourceSummary;
  /** The next page's position; null when the run is complete. */
  readonly checkpoint: AnalyticsV2PerformanceSourceCheckpoint | null;
}

export interface ReadAnalyticsV2PerformanceSourceOptions {
  /** The primary schema (owners.ts quotedSchema). */
  readonly schema: string;
  /** The last day read (YYYY-MM-DD, inclusive); later days are deferred. */
  readonly throughDay: string;
  /** Reports per page (default 256, at most 1,024). */
  readonly pageSize?: number;
  /** Cohorts per run (default and ceiling 10,000,000). */
  readonly maxCohorts?: number;
  /** The previous page's checkpoint; null or absent for the first page. */
  readonly checkpoint?: AnalyticsV2PerformanceSourceCheckpoint | null;
}

interface CheckpointState {
  /** pg_current_snapshot()::text of the issuing page (never on the token). */
  readonly snapshot: string;
  readonly schema: string;
  readonly throughDay: string;
  readonly pageSize: number;
  readonly maxCohorts: number;
  readonly afterDay: string;
  readonly afterReportKey: string;
  readonly reports: number;
  readonly cohorts: number;
  readonly pages: number;
  readonly deferredFutureDays: number;
}

// The keyset position lives here, never on the token itself, so a checkpoint
// carries no key in any enumerable or serializable form.
const CHECKPOINTS = new WeakMap<object, CheckpointState>();

const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/u;
const LABEL = /^[A-Za-z0-9._:-]{1,64}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const BUCKET_KEY = /^(?:0|[1-9]\d{0,1})$/u;
const MAX_BUCKET_INDEX = 95;
const MAX_REPORT_RECORDS = 1_024;
const ISOLATIONS: ReadonlySet<string> = new Set(["repeatable read", "serializable"]);
// pg_snapshot text: xmin:xmax:xip_list (decimal xids, comma separated).
const SNAPSHOT = /^\d{1,20}:\d{1,20}:(?:\d{1,20}(?:,\d{1,20})*)?$/u;
const MAX_SNAPSHOT_TEXT = 1_048_576;

const HISTOGRAMS = Object.freeze([
  ["speedHistogram", "speed", "speed_buckets", "speed_min", "speed_max"],
  ["ttftHistogram", "ttft", "ttft_buckets", "ttft_min", "ttft_max"],
  ["completionHistogram", "turnDuration", "turn_duration_buckets", "completion_min", "completion_max"],
] as const);

function boundedOption(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    return sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  }
  return value;
}

function storedText(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  return value;
}

function storedNullable(value: unknown): number | null {
  return value === null ? null : safeInteger(value);
}

/** A per-metric bucket object aggregated in SQL (json text, or NULL for none). */
function storedBuckets(value: unknown): { readonly buckets: Readonly<Record<string, number>>; readonly total: number } {
  if (value === null) return { buckets: Object.freeze({}), total: 0 };
  if (typeof value !== "string") return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  }
  const entries: [number, number][] = [];
  for (const [key, count] of Object.entries(parsed)) {
    if (!BUCKET_KEY.test(key) || Number(key) > MAX_BUCKET_INDEX) sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
    entries.push([Number(key), safeInteger(count, 1)]);
  }
  entries.sort((left, right) => left[0] - right[0]);
  const buckets: Record<string, number> = {};
  let total = 0;
  for (const [index, count] of entries) {
    buckets[String(index)] = count;
    total += count;
    if (!Number.isSafeInteger(total)) sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  }
  return { buckets: Object.freeze(buckets), total };
}

interface ReportRow {
  readonly id: unknown;
  readonly report_day: unknown;
  readonly participant_id: unknown;
  readonly device_id: unknown;
  readonly field_dictionary_version: unknown;
  readonly bucket_scheme_version: unknown;
  readonly schema_version: unknown;
  readonly measurement_version: unknown;
  readonly record_count: unknown;
}

interface PageReport {
  readonly reportKey: string;
  readonly reportDay: string;
  readonly participantKey: string;
  readonly deviceKey: string;
  readonly fieldDictionaryVersion: string;
  readonly bucketSchemeVersion: string;
  readonly schemaVersion: string;
  readonly measurementVersion: string;
  readonly recordCount: number;
}

type CohortRow = Readonly<Record<string, unknown>>;

function pageReport(row: ReportRow): PageReport {
  const recordCount = safeInteger(row.record_count, 1, MAX_REPORT_RECORDS);
  return {
    reportKey: storedText(row.id, TOKEN),
    reportDay: storedText(row.report_day, DAY),
    participantKey: storedText(row.participant_id, TOKEN),
    deviceKey: storedText(row.device_id, TOKEN),
    fieldDictionaryVersion: storedText(row.field_dictionary_version, TOKEN),
    bucketSchemeVersion: storedText(row.bucket_scheme_version, TOKEN),
    schemaVersion: storedText(row.schema_version, TOKEN),
    measurementVersion: storedText(row.measurement_version, TOKEN),
    recordCount,
  };
}

function rebuildRecord(report: PageReport, row: CohortRow): Readonly<TelemetryPerformanceRecord> {
  const histograms: Record<string, unknown> = {};
  for (const [field, metric, bucketsColumn, minColumn, maxColumn] of HISTOGRAMS) {
    const { buckets, total } = storedBuckets(row[bucketsColumn]);
    histograms[field] = Object.freeze({
      schemaVersion: report.bucketSchemeVersion,
      metric,
      sampleCount: total,
      buckets,
      min: storedNullable(row[minColumn]),
      max: storedNullable(row[maxColumn]),
    });
  }
  // The contract's key order (telemetry-performance-v1.js performanceV1RecordKeys).
  return Object.freeze({
    schemaVersion: report.schemaVersion,
    day: report.reportDay,
    provider: storedText(row.provider, LABEL),
    modelId: storedText(row.model_id, LABEL),
    reasoningEffort: storedText(row.reasoning_effort, LABEL),
    speedMethod: storedText(row.speed_method, LABEL),
    speedMode: storedText(row.speed_mode, LABEL),
    speedModeSource: storedText(row.speed_mode_source, LABEL),
    apiServiceTier: storedText(row.api_service_tier, LABEL),
    measurementVersion: report.measurementVersion,
    bucketSchemeVersion: report.bucketSchemeVersion,
    turns: safeInteger(row.turns),
    speedTurns: safeInteger(row.speed_turns),
    ttftTurns: safeInteger(row.ttft_turns),
    completionTurns: safeInteger(row.completion_turns),
    timedResponses: safeInteger(row.timed_responses),
    speedTokens: safeInteger(row.speed_tokens),
    speedDurationMs: safeInteger(row.speed_duration_ms),
    speedHistogram: histograms.speedHistogram,
    ttftHistogram: histograms.ttftHistogram,
    completionHistogram: histograms.completionHistogram,
  }) as unknown as Readonly<TelemetryPerformanceRecord>;
}

const REPORT_COLUMNS = `r.id, to_char(r.report_day, 'YYYY-MM-DD') AS report_day, r.participant_id, r.device_id,
       r.field_dictionary_version, r.bucket_scheme_version, r.schema_version, r.measurement_version,
       r.record_count`;

function firstPageSql(s: string): string {
  return `SELECT ${REPORT_COLUMNS}
  FROM ${s}.telemetry_performance_reports r
 WHERE r.state = 'current' AND r.record_count > 0 AND r.report_day <= $1::date
 ORDER BY r.report_day, r.id
 LIMIT $2`;
}

function nextPageSql(s: string): string {
  return `SELECT ${REPORT_COLUMNS}
  FROM ${s}.telemetry_performance_reports r
 WHERE r.state = 'current' AND r.record_count > 0 AND r.report_day <= $1::date
   AND (r.report_day, r.id) > ($3::date, $4::text)
 ORDER BY r.report_day, r.id
 LIMIT $2`;
}

function deferredDaysSql(s: string): string {
  return `SELECT count(DISTINCT r.report_day)::text AS days
  FROM ${s}.telemetry_performance_reports r
 WHERE r.state = 'current' AND r.record_count > 0 AND r.report_day > $1::date`;
}

function bucketObjectSql(metric: string): string {
  return `(json_object_agg(b.bucket_index, b.bucket_count ORDER BY b.bucket_index)
            FILTER (WHERE b.metric = '${metric}'))::text`;
}

function cohortsSql(s: string): string {
  return `SELECT page.ordinal::text AS ordinal, c.cohort_index, c.provider, c.model_id, c.reasoning_effort,
       c.speed_method, c.speed_mode, c.speed_mode_source, c.api_service_tier,
       c.turns::text AS turns, c.speed_turns::text AS speed_turns, c.ttft_turns::text AS ttft_turns,
       c.completion_turns::text AS completion_turns, c.timed_responses::text AS timed_responses,
       c.speed_tokens::text AS speed_tokens, c.speed_duration_ms::text AS speed_duration_ms,
       c.speed_min::text AS speed_min, c.speed_max::text AS speed_max,
       c.ttft_min::text AS ttft_min, c.ttft_max::text AS ttft_max,
       c.completion_min::text AS completion_min, c.completion_max::text AS completion_max,
       h.speed_buckets, h.ttft_buckets, h.turn_duration_buckets
  FROM unnest($1::text[]) WITH ORDINALITY AS page(report_id, ordinal)
  JOIN ${s}.telemetry_performance_cohorts c ON c.report_id = page.report_id
  CROSS JOIN LATERAL (
    SELECT ${bucketObjectSql("speed")} AS speed_buckets,
           ${bucketObjectSql("ttft")} AS ttft_buckets,
           ${bucketObjectSql("turnDuration")} AS turn_duration_buckets
      FROM ${s}.telemetry_performance_buckets b
     WHERE b.report_id = c.report_id AND b.cohort_index = c.cohort_index
  ) h
 ORDER BY page.ordinal, c.cohort_index
 LIMIT $2`;
}

/**
 * The read-only repeatable-read guard; returns the snapshot it runs on
 * (pg_current_snapshot()::text), which binds checkpoints and closes each page.
 */
async function assertSnapshot(client: Pick<PostgresClient, "query">): Promise<string> {
  const result = await client.query<{ read_only: unknown; isolation: unknown; snapshot: unknown }>(
    analyticsV2Statement("snapshot.read_only",
      "SELECT current_setting('transaction_read_only') AS read_only, "
      + "current_setting('transaction_isolation') AS isolation, "
      + "pg_current_snapshot()::text AS snapshot"));
  const row = result.rows[0];
  if (result.rows.length !== 1 || row?.read_only !== "on"
      || typeof row.isolation !== "string" || !ISOLATIONS.has(row.isolation)
      || typeof row.snapshot !== "string" || row.snapshot.length > MAX_SNAPSHOT_TEXT
      || !SNAPSHOT.test(row.snapshot)) {
    return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  }
  return row.snapshot;
}

function issueCheckpoint(state: CheckpointState): AnalyticsV2PerformanceSourceCheckpoint {
  const token = Object.freeze({ kind: "analytics-v2-performance-source-checkpoint" as const });
  CHECKPOINTS.set(token, Object.freeze(state));
  return token;
}

/**
 * Read one keyset page of current, non-empty performance reports up to
 * throughDay, rebuilt as contract records, on the caller's open read-only
 * snapshot. Pass the returned checkpoint back (with the same schema,
 * throughDay, pageSize and maxCohorts, on the same snapshot) until it is null.
 */
export async function readAnalyticsV2PerformanceSource(
  client: Pick<PostgresClient, "query">,
  options: ReadAnalyticsV2PerformanceSourceOptions,
): Promise<AnalyticsV2PerformanceSourcePage> {
  if (client === null || typeof client !== "object" || typeof client.query !== "function"
      || options === null || typeof options !== "object") {
    return sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  }
  const s = quotedSchema(options.schema);
  const throughDay = options.throughDay;
  dayNumber(throughDay);
  const pageSize = boundedOption(options.pageSize, DEFAULT_ANALYTICS_V2_PERFORMANCE_PAGE_REPORTS,
    MAX_ANALYTICS_V2_PERFORMANCE_PAGE_REPORTS);
  const maxCohorts = boundedOption(options.maxCohorts, DEFAULT_ANALYTICS_V2_PERFORMANCE_COHORTS,
    MAX_ANALYTICS_V2_PERFORMANCE_COHORTS);
  let prior: CheckpointState | null = null;
  if (options.checkpoint !== undefined && options.checkpoint !== null) {
    prior = typeof options.checkpoint === "object" ? CHECKPOINTS.get(options.checkpoint) ?? null : null;
    if (prior === null || prior.schema !== s || prior.throughDay !== throughDay
        || prior.pageSize !== pageSize || prior.maxCohorts !== maxCohorts) {
      return sourceFail("ANALYTICS_V2_SOURCE_INVALID");
    }
  }

  const snapshot = await assertSnapshot(client);
  // A checkpoint continues only the snapshot that issued it.
  if (prior !== null && prior.snapshot !== snapshot) return sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  let deferredFutureDays: number;
  if (prior === null) {
    const deferred = await client.query<{ days: unknown }>(
      analyticsV2Statement("performance.reports", deferredDaysSql(s)), [throughDay]);
    if (deferred.rows.length !== 1) sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
    deferredFutureDays = safeInteger(deferred.rows[0]?.days);
  } else {
    deferredFutureDays = prior.deferredFutureDays;
  }

  const page = prior === null
    ? await client.query<ReportRow>(analyticsV2Statement("performance.reports", firstPageSql(s)),
      [throughDay, pageSize + 1])
    : await client.query<ReportRow>(analyticsV2Statement("performance.reports", nextPageSql(s)),
      [throughDay, pageSize + 1, prior.afterDay, prior.afterReportKey]);
  if (page.rows.length > pageSize + 1) sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  const complete = page.rows.length <= pageSize;
  const reports = page.rows.slice(0, pageSize).map(pageReport);
  const priorReports = prior?.reports ?? 0;
  const priorCohorts = prior?.cohorts ?? 0;
  const pages = (prior?.pages ?? 0) + 1;

  // Keyset order is strictly ascending; a repeat or regression is drift.
  let previous: { day: string; key: string } | null = prior === null ? null
    : { day: prior.afterDay, key: prior.afterReportKey };
  let pageCohorts = 0;
  for (const report of reports) {
    if (report.reportDay > throughDay) sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
    if (previous !== null && (report.reportDay < previous.day
        || (report.reportDay === previous.day && report.reportKey === previous.key))) {
      sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
    }
    previous = { day: report.reportDay, key: report.reportKey };
    pageCohorts += report.recordCount;
  }
  // The run budget is checked from the declared counts before any cohort row is read.
  if (priorCohorts + pageCohorts > maxCohorts) sourceFail("ANALYTICS_V2_SOURCE_LIMIT");

  const records: AnalyticsV2PerformanceSourceRecord[] = [];
  if (reports.length > 0) {
    const cohorts = await client.query<CohortRow>(analyticsV2Statement("performance.cohorts", cohortsSql(s)),
      [reports.map((report) => report.reportKey), pageCohorts + 1]);
    // One snapshot serves every statement, so any count mismatch is storage
    // drift: never return a partial reconstruction.
    if (cohorts.rows.length !== pageCohorts) sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
    let reportIndex = 0;
    let cohortIndex = 0;
    for (const row of cohorts.rows) {
      while (reportIndex < reports.length && cohortIndex === reports[reportIndex]!.recordCount) {
        reportIndex += 1;
        cohortIndex = 0;
      }
      const report = reports[reportIndex];
      if (report === undefined
          || safeInteger(row.ordinal, 1) !== reportIndex + 1
          || safeInteger(row.cohort_index, 0, MAX_REPORT_RECORDS - 1) !== cohortIndex) {
        sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
      }
      records.push(Object.freeze({
        participantKey: report.participantKey,
        deviceKey: report.deviceKey,
        reportKey: report.reportKey,
        reportDay: report.reportDay,
        fieldDictionaryVersion: report.fieldDictionaryVersion,
        record: rebuildRecord(report, row),
      }));
      cohortIndex += 1;
    }
  }
  // Every statement of this page saw one state only if the snapshot is unchanged.
  if (await assertSnapshot(client) !== snapshot) sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");

  const summary: AnalyticsV2PerformanceSourceSummary = Object.freeze({
    reports: priorReports + reports.length,
    cohorts: priorCohorts + pageCohorts,
    pages,
    deferredFutureDays,
    complete,
  });
  const last = reports.at(-1);
  const checkpoint = complete || last === undefined ? null : issueCheckpoint({
    snapshot,
    schema: s,
    throughDay,
    pageSize,
    maxCohorts,
    afterDay: last.reportDay,
    afterReportKey: last.reportKey,
    reports: summary.reports,
    cohorts: summary.cohorts,
    pages,
    deferredFutureDays,
  });
  return Object.freeze({ records: Object.freeze(records), summary, checkpoint });
}

/**
 * Read every page (readAnalyticsV2PerformanceSource until its checkpoint is
 * null) on the caller's snapshot. The run is bounded by maxCohorts, and every
 * page holds at least one cohort, so the loop ends.
 */
export async function collectAnalyticsV2PerformanceSource(
  client: Pick<PostgresClient, "query">,
  options: Omit<ReadAnalyticsV2PerformanceSourceOptions, "checkpoint">,
): Promise<{ readonly records: readonly AnalyticsV2PerformanceSourceRecord[];
  readonly summary: AnalyticsV2PerformanceSourceSummary }> {
  const records: AnalyticsV2PerformanceSourceRecord[] = [];
  let checkpoint: AnalyticsV2PerformanceSourceCheckpoint | null = null;
  for (;;) {
    const page: AnalyticsV2PerformanceSourcePage = await readAnalyticsV2PerformanceSource(client,
      { ...options, checkpoint });
    for (const record of page.records) records.push(record);
    if (page.checkpoint === null) return Object.freeze({ records: Object.freeze(records), summary: page.summary });
    checkpoint = page.checkpoint;
  }
}
