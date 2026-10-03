#!/usr/bin/env node
// MEAS-SYNTH production-tier measurement: the run's summary.json, from the
// receipts run-prodtier-measurement.sh leaves in its OUT directory. Works on
// a partial directory (a killed or failed run), so it also answers "where did
// the time go" for a run that never finished.
//
//   node apps/worker/scripts/gcp-fastpath-prod-shape/summarize-prodtier.mjs <OUT> <profile>...
//
// Per profile: the guarded refresh (when one ran) and the uncapped run
// (execution, duration, outcome, phase timings, memory, read ledger), the
// profiler's last summary line and its cadence (every line's sequence,
// reason, phase, elapsed time and owner progress), the database delta from
// the "<profile>-before" snapshot to the "<profile>-after" one (or the last
// "-during-NN" one, when the run never reached "after"), every snapshot's
// sessions by wait event, and the Cloud Monitoring series summaries (without
// their points). Content-free inputs give a content-free summary.
//
// Profile lines reach the receipts only when refresh-uncapped (or the guarded
// refresh) finishes polling and writes its receipt. While the run executes,
// or after the operator stops the script, they exist only in Cloud Logging:
// save them read-only to <OUT>/<profile>/profile-log.json (the gcloud logging
// read command in the run script's header) and this summary uses that file's
// newest execution when no receipt holds lines (profile.source says which).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { measPgStatDelta } from "./meas-pgstat.mjs";

function read(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function lastStatus(receipt) {
  return Array.isArray(receipt?.results) && receipt.results.length > 0 ? receipt.results.at(-1) : null;
}

function run(receipt, status) {
  if (receipt === null) return null;
  return { execution: receipt.execution ?? null, executed: receipt.executed !== false,
    durationSeconds: receipt.durationSeconds ?? null, outcome: receipt.outcome ?? null,
    state: status?.state ?? null, code: status?.code ?? null, phase: status?.phase ?? null,
    timingsMs: status?.timings ?? null, memory: status?.memory ?? null,
    readsPhaseWallMs: status?.reads?.phaseWallMs ?? null, readsUnattributedMs: status?.reads?.unattributedMs ?? null,
    serverStatements: status?.reads?.server ?? null, deadline: status?.deadline ?? null };
}

const PROFILE_SCHEMA = "analytics-refresh-profile-v1";
const EXECUTION_LABEL = "run.googleapis.com/execution_name";

/**
 * Profile lines from a saved `gcloud logging read --format=json` listing: the
 * newest execution's lines (by its latest entry), in sequence order. Anything
 * that is not a profile line is ignored.
 */
export function loggedProfileLines(entries) {
  const byExecution = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    let value = entry?.jsonPayload ?? null;
    if (value === null && typeof entry?.textPayload === "string") {
      try { value = JSON.parse(entry.textPayload); } catch { value = null; }
    }
    if (!value || typeof value !== "object" || value.profile !== PROFILE_SCHEMA) continue;
    const execution = typeof entry?.labels?.[EXECUTION_LABEL] === "string" ? entry.labels[EXECUTION_LABEL] : "";
    const at = Date.parse(entry?.timestamp ?? "") || 0;
    const group = byExecution.get(execution) ?? { execution, latest: 0, lines: [] };
    group.latest = Math.max(group.latest, at);
    group.lines.push(value);
    byExecution.set(execution, group);
  }
  const newest = [...byExecution.values()].sort((left, right) => right.latest - left.latest)[0];
  if (newest === undefined) return { execution: null, lines: [] };
  const seen = new Set();
  const lines = newest.lines.filter((line) => !seen.has(line.sequence) && seen.add(line.sequence))
    .sort((left, right) => left.sequence - right.sequence);
  return { execution: newest.execution || null, lines };
}

function profileCadence(lines) {
  return (Array.isArray(lines) ? lines : []).map((line) => ({ sequence: line.sequence, reason: line.reason,
    phase: line.phase, elapsedSeconds: line.elapsedSeconds, progress: line.progress,
    heapUsedMiB: line.memory?.heapUsedMiB ?? null, rssMiB: line.memory?.rssMiB ?? null,
    eventLoopUtilization: line.eventLoop?.utilization ?? null, gcMs: line.gc?.ms ?? null,
    foldMs: line.fold?.lastMs ?? null, profilerMs: line.fold === undefined ? null : line.fold.ms + line.fold.writeMs }));
}

/** The pgstat snapshots of one profile, by label: before, during-NN (in order), after. */
function snapshots(out, profile) {
  const dir = join(out, "pgstat");
  let names = [];
  try { names = readdirSync(dir); } catch { return { before: null, during: [], after: null }; }
  const load = (label) => read(join(dir, `meas-pgstat-${label}.json`));
  const during = names.map((name) => new RegExp(`^meas-pgstat-(${profile}-during-\\d{2,})\\.json$`, "u").exec(name))
    .filter(Boolean).map((match) => match[1]).sort().map(load).filter(Boolean);
  return { before: load(`${profile}-before`), during, after: load(`${profile}-after`) };
}

function metricsSummary(out, profile) {
  const metrics = read(join(out, "metrics", profile, "meas-metrics.json"));
  if (metrics === null) return null;
  return { since: metrics.since, until: metrics.until, metrics: metrics.metrics.map((metric) => ({
    metric: metric.metric, aligner: metric.aligner, httpStatus: metric.httpStatus, error: metric.error ?? null,
    series: metric.series.map(({ series: _points, ...summary }) => summary) })) };
}

export function summarizeProdtier(out, profiles) {
  const seed = read(join(out, "seed.json")) ?? {};
  const summary = {
    create: read(join(out, "create", "meas-create.json")),
    seed: { schema: seed.schema ?? null, durationSeconds: seed.durationSeconds ?? null,
      instanceConnectionName: seed.instanceConnectionName ?? null, timingsMs: seed.timingsMs ?? null },
    pgstatEnable: read(join(out, "pgstat", "meas-pgstat-enable.json")),
    runs: {},
  };
  for (const profile of profiles) {
    const guarded = read(join(out, profile, "refresh", "refresh.json"));
    const uncapped = read(join(out, profile, "uncapped", "refresh-uncapped.json"));
    const receiptLines = [...(guarded?.profiles ?? []), ...(uncapped?.profiles ?? [])];
    const logged = loggedProfileLines(read(join(out, profile, "profile-log.json")));
    // The run's own lines: the uncapped run's, else the guarded run's, else the saved log's newest execution.
    const own = uncapped?.profiles?.length ? uncapped.profiles : guarded?.profiles?.length ? guarded.profiles
      : logged.lines;
    const source = receiptLines.length > 0 ? "receipt" : logged.lines.length > 0 ? "cloud-logging" : null;
    const { before, during, after } = snapshots(out, profile);
    const end = after ?? during.at(-1) ?? null;
    summary.runs[profile] = {
      guarded: guarded?.executed === false ? { executed: false } : run(guarded, lastStatus(guarded)),
      uncapped: run(uncapped, uncapped?.statusLine ?? null),
      profile: { source, lines: source === "receipt" ? receiptLines.length : logged.lines.length,
        loggedExecution: source === "cloud-logging" ? logged.execution : null,
        cadence: profileCadence(own), last: own.at(-1) ?? null },
      database: before === null || end === null ? null : measPgStatDelta(before, end),
      sessions: [before, ...during, after].filter(Boolean).map((snapshot) => ({ label: snapshot.label,
        takenAt: snapshot.takenAt, sessions: snapshot.sessions })),
      snapshots: { before: before !== null, during: during.length, after: after !== null },
      cloudMonitoring: metricsSummary(out, profile),
    };
  }
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [out, ...profiles] = process.argv.slice(2);
  if (!out || profiles.length === 0) {
    console.error("usage: summarize-prodtier.mjs <OUT> <profile>...");
    process.exit(2);
  }
  const summary = summarizeProdtier(resolve(out), profiles);
  writeFileSync(join(resolve(out), "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  for (const [profile, value] of Object.entries(summary.runs)) {
    const top = value.profile.last?.top;
    console.log(JSON.stringify({ profile, guarded: value.guarded, uncapped: value.uncapped === null ? null
      : { outcome: value.uncapped.outcome, durationSeconds: value.uncapped.durationSeconds, timingsMs: value.uncapped.timingsMs },
    profileLines: value.profile.lines, topSelf: top?.self?.slice(0, 10) ?? null, topTotal: top?.total?.slice(0, 10) ?? null,
    serverExecMs: value.database?.execMs ?? null, snapshots: value.snapshots }));
  }
}
