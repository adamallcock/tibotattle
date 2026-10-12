// MEAS-SYNTH production-tier measurement: the Cloud Run and Cloud SQL side of
// the profile, read from Cloud Monitoring after the run.
//
// measMetricsRequests builds read-only `projects.timeSeries.list` GETs for the
// TEST project `tibotattle` only: the measurement refresh Job's container CPU
// and memory utilisation (mean and 99th percentile per minute) and received
// bytes, and the measurement instance's CPU and memory utilisation, disk
// operations and bytes sent. Every filter names only the measurement Job
// (tibotattle-fastpath-meas-analytics-refresh) or a validated measurement
// instance, so no other resource can be read. readMeasMetrics fetches them
// with an access token held only in memory (gcp-fastpath-test-deploy.mjs
// meas-metrics mints it) and summarises each series; a metric that fails to
// read is recorded with its HTTP status and the rest continue.
//
// Content-free: resource and metric labels are kept only from a closed list
// (job name, location, database id); every other value is a time and a number.

import { FASTPATH_MEASUREMENT_CLOUD_TARGET, fastpathMeasurementInstance } from "../../cloud-run/origin-fastpath-mode.mjs";

export const MEAS_METRICS_SCHEMA = "gcp-meas-metrics-v1";
const MONITORING = "https://monitoring.googleapis.com/v3";
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const LABELS_KEPT = new Set(["job_name", "location", "database_id", "project_id", "region"]);
const MAX_PAGES = 20;
const ALIGNMENT_SECONDS = 60;
/** The metrics read, per resource. Distribution metrics are read as a per-minute mean and 99th percentile. */
export const MEAS_METRICS = Object.freeze([
  Object.freeze({ name: "job-cpu-utilization", resource: "job", type: "run.googleapis.com/container/cpu/utilizations",
    aligners: Object.freeze(["ALIGN_MEAN", "ALIGN_PERCENTILE_99"]) }),
  Object.freeze({ name: "job-memory-utilization", resource: "job",
    type: "run.googleapis.com/container/memory/utilizations", aligners: Object.freeze(["ALIGN_MEAN", "ALIGN_PERCENTILE_99"]) }),
  Object.freeze({ name: "job-received-bytes", resource: "job", type: "run.googleapis.com/container/network/received_bytes_count",
    aligners: Object.freeze(["ALIGN_RATE"]) }),
  Object.freeze({ name: "sql-cpu-utilization", resource: "sql", type: "cloudsql.googleapis.com/database/cpu/utilization",
    aligners: Object.freeze(["ALIGN_MEAN"]) }),
  Object.freeze({ name: "sql-memory-utilization", resource: "sql",
    type: "cloudsql.googleapis.com/database/memory/utilization", aligners: Object.freeze(["ALIGN_MEAN"]) }),
  Object.freeze({ name: "sql-disk-read-ops", resource: "sql", type: "cloudsql.googleapis.com/database/disk/read_ops_count",
    aligners: Object.freeze(["ALIGN_RATE"]) }),
  Object.freeze({ name: "sql-disk-write-ops", resource: "sql",
    type: "cloudsql.googleapis.com/database/disk/write_ops_count", aligners: Object.freeze(["ALIGN_RATE"]) }),
  Object.freeze({ name: "sql-sent-bytes", resource: "sql", type: "cloudsql.googleapis.com/database/network/sent_bytes_count",
    aligners: Object.freeze(["ALIGN_RATE"]) }),
]);

function fail(code, detail) {
  throw Object.assign(new Error(detail === undefined ? code : `${code}: ${detail}`), { code });
}

/** The read-only requests for one measurement window ([since, until], ISO instants). */
export function measMetricsRequests({ instance, since, until }) {
  const measurement = fastpathMeasurementInstance(instance);
  if (measurement === null) fail("MEAS_METRICS_INSTANCE_INVALID", String(instance));
  if (!ISO_INSTANT.test(since ?? "") || !ISO_INSTANT.test(until ?? "") || Date.parse(since) >= Date.parse(until)) {
    fail("MEAS_METRICS_WINDOW_INVALID");
  }
  const project = FASTPATH_MEASUREMENT_CLOUD_TARGET.project;
  const resources = {
    job: `resource.type = "cloud_run_job" AND resource.labels.job_name = "${FASTPATH_MEASUREMENT_CLOUD_TARGET.refreshJob}"`,
    sql: `resource.type = "cloudsql_database" AND resource.labels.database_id = "${project}:${measurement.instance}"`,
  };
  const requests = [];
  for (const metric of MEAS_METRICS) {
    for (const aligner of metric.aligners) {
      const query = new URLSearchParams({
        filter: `metric.type = "${metric.type}" AND ${resources[metric.resource]}`,
        "interval.startTime": since,
        "interval.endTime": until,
        "aggregation.alignmentPeriod": `${ALIGNMENT_SECONDS}s`,
        "aggregation.perSeriesAligner": aligner,
        view: "FULL",
        pageSize: "100000",
      });
      requests.push(Object.freeze({ metric: metric.name, aligner,
        url: `${MONITORING}/projects/${project}/timeSeries?${query}` }));
    }
  }
  return requests;
}

function pointValue(point) {
  const value = point?.value ?? {};
  if (typeof value.doubleValue === "number") return value.doubleValue;
  if (value.int64Value !== undefined) return Number(value.int64Value);
  if (typeof value.distributionValue?.mean === "number") return value.distributionValue.mean;
  return null;
}

function keptLabels(labels) {
  return Object.fromEntries(Object.entries(labels ?? {}).filter(([key]) => LABELS_KEPT.has(key))
    .map(([key, value]) => [key, String(value).slice(0, 120)]));
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

/** One series' points (oldest first) and their summary. */
export function measSeriesSummary(series) {
  const points = (Array.isArray(series?.points) ? series.points : [])
    .map((point) => [point?.interval?.endTime ?? null, pointValue(point)])
    .filter(([at, value]) => typeof at === "string" && ISO_INSTANT.test(at) && Number.isFinite(value))
    .sort(([left], [right]) => (left < right ? -1 : 1));
  const values = points.map(([, value]) => value).sort((left, right) => left - right);
  const round = (value) => (value === null ? null : Math.round(value * 10_000) / 10_000);
  return {
    resource: keptLabels(series?.resource?.labels),
    metricLabels: keptLabels(series?.metric?.labels),
    points: points.length,
    first: points[0]?.[0] ?? null,
    last: points.at(-1)?.[0] ?? null,
    mean: round(values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length),
    p50: round(quantile(values, 0.5)),
    p95: round(quantile(values, 0.95)),
    max: round(values.at(-1) ?? null),
    series: points.map(([at, value]) => [at, round(value)]),
  };
}

/**
 * Fetch every request (GET only; `fetchImpl` is injectable) and
 * summarise. The token never leaves the Authorization header.
 */
export async function readMeasMetrics({ instance, since, until, token, fetchImpl = fetch, timeoutMs = 60_000 }) {
  if (typeof token !== "string" || token.length === 0) fail("MEAS_METRICS_TOKEN_MISSING");
  const result = { schemaVersion: MEAS_METRICS_SCHEMA, instance, since, until, alignmentSeconds: ALIGNMENT_SECONDS,
    metrics: [] };
  for (const request of measMetricsRequests({ instance, since, until })) {
    const entry = { metric: request.metric, aligner: request.aligner, httpStatus: null, series: [] };
    let pageToken = null;
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const url = pageToken === null ? request.url : `${request.url}&pageToken=${encodeURIComponent(pageToken)}`;
        const response = await fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs) });
        entry.httpStatus = response.status;
        if (!response.ok) break;
        const body = await response.json();
        for (const series of Array.isArray(body?.timeSeries) ? body.timeSeries : []) {
          entry.series.push(measSeriesSummary(series));
        }
        pageToken = typeof body?.nextPageToken === "string" && body.nextPageToken.length > 0 ? body.nextPageToken : null;
        if (pageToken === null) break;
      }
    } catch (error) {
      entry.error = error?.name === "TimeoutError" ? "timeout" : "fetch-failed";
    }
    result.metrics.push(entry);
  }
  return result;
}
