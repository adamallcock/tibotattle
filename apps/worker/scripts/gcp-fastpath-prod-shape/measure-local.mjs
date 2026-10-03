#!/usr/bin/env node
// Local production-scale measurement of the full-recompute analytics refresh
// (MEAS-SYNTH), against a local PostgreSQL 17 only.
//
//   PG_TEST_SOCKET=/private/tmp/tibotattle-pg-fanout-20260926/socket PG_TEST_PORT=55433 \
//   ~/.nvm/versions/node/v26.2.0/bin/node --max-old-space-size=49152 \
//     apps/worker/scripts/gcp-fastpath-prod-shape/measure-local.mjs \
//       --corpus <seed-source.mjs work dir> --out <report.json> [--keep-database] [--reuse-database <name>]
//       [--clone-from <name>] [--import-only] [--profile dense|dense-workers] [--guard-probe] [--node22 <path>]
//       [--pgstat-interval <10..1800 seconds>]
//       [--cpu-profile <sample interval, us>] [--cpu-profile-summary <seconds>] [--cpu-profile-dir <absolute dir>]
//
//  1. creates a fresh database meas_synth_<8 hex> on the cluster (never an
//     existing one), a fast-path rehearsal target schema in it, and applies
//     every promoted primary migration with the production runner;
//  2. imports the sealed corpus through the reviewed importer chain
//     (import-corpus.mjs), then ANALYZEs the schema;
//     With --clone-from <meas_synth_…> the fresh database is instead a
//     template copy of a kept, already imported one (CREATE DATABASE …
//     TEMPLATE; the source must have no connections), so two profiles can be
//     measured on byte-identical inputs; with --import-only the run stops
//     here and keeps the database for such clones;
//  3. runs cloud-run/dist/analytics-refresh.mjs --mode=full once under
//     Node 22 with a test-deploy refresh task profile's heap, budget and
//     compute Workers (--profile, default dense for inline comparison; production
//     explicitly selects dense-workers with --workers=4 and no inherited heap
//     flags. Dense inline uses heap12288MiB and semi-space64MiB; both profiles
//     use ANALYTICS_V2_MEMORY_BUDGET_MIB=10752;
//     gcp-fastpath-test-deploy.mjs REFRESH_JOB_PROFILES; a24h task timeout),
//     wrapped in /usr/bin/time -l for the
//     process's peak resident set, while the process's resident set and CPU
//     time are sampled every 5 s (ps) for the utilisation of its threads;
//  4. records the job's receipt (phase timings, read ledger, memory summary,
//     owner and refusal counts), the wall time, the peak RSS, the samples'
//     utilisation summary, the per-owner resource record the run row keeps
//     (estimate, heap peak; content-free digests only), the output sizes
//     (rows and bytes of every analytics_v2 table and the published
//     payloads) and a content digest of every output table, which leaves out
//     only each table's declared identity and stamps, retaining raw hashes
//     and checking kernel/compute/manifest provenance separately;
//  5. --guard-probe: a second refresh with
//     ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS=86400 (the production task
//     timeout), stopped after 600 s unless it ends sooner, records whether the
//     time guard refused it within that window. The job logs no
//     plan-checkpoint marker, so a probe stopped unrefused shows only that no
//     refusal came in its first 600 s, not that the plan checkpoint was
//     reached or passed;
//  6. drops the database (unless --keep-database).
//
// --cpu-profile <us> runs the refresh with the job's opt-in CPU profiler
// (cloud-run/analytics-refresh-profile.mjs: ANALYTICS_V2_REFRESH_PROFILE=cpu at
// that sampling interval); the report keeps every content-free summary line
// (steps.refresh.profileLines) and the last one (steps.refresh.profile).
// --cpu-profile-summary <seconds> sets its summary period (10..86400; the
// job's default is 1800), so a short run exercises the periodic
// stop-fold-restart path a long run takes.
// --cpu-profile-dir also keeps one sanitized .cpuprofile per window there.
//
// Local and synthetic only: no network, no production data, no secrets.
// The report holds counts, sizes, timings and digests only.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

import { fastpathRehearsalSchemas } from "../gcp-fastpath-rehearsal.mjs";
import { REFRESH_JOB_PROFILES } from "../gcp-fastpath-test-deploy.mjs";
import { applyPostgresMigrations, readPostgresMigrations } from "../postgres-migrations.mjs";
import { importProdShapeCorpus, readProdShapeCorpus } from "./import-corpus.mjs";
import { collectOutputDigestEvidence, OUTPUT_DIGEST_POLICY } from "./output-digest-policy.mjs";
import { capturePgStat, pgStatDelta, refreshPgStatLifecycle } from "./refresh-pgstat-lifecycle.mjs";
import { PROD_SHAPE_REFRESH_NOW } from "./prod-shape-corpus.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(HERE, "../..");
const CLOUD_RUN_ROOT = join(WORKER_ROOT, "cloud-run");
const DIST_REFRESH = join(CLOUD_RUN_ROOT, "dist", "analytics-refresh.mjs");
const DEFAULT_NODE22 = join(homedir(), ".nvm/versions/node/v22.16.0/bin/node");
const PRIVATE_SOCKET = /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u;
const DATABASE = /^meas_synth_[0-9a-f]{8}$/u;
/** Shared production resources plus the dense inline comparison heap; Workers have no inherited heap flags. */
export const PRODUCTION_PROFILE = Object.freeze({ cpu: 4, memoryGiB: 16, heapMiB: 12_288, budgetMiB: 10_752,
  taskTimeoutSeconds: 86_400 });
/** The refresh task profiles this measurement runs locally (the test-deploy wrapper's, by name). */
export const MEASURE_PROFILES = Object.freeze(["dense", "dense-workers"]);

/** One test-deploy refresh profile as the local run takes it: heap, budget, Workers, task timeout. */
export function measureProfile(name) {
  if (!MEASURE_PROFILES.includes(name)) fail("MEAS_SYNTH_PROFILE_INVALID", String(name));
  const profile = REFRESH_JOB_PROFILES[name];
  const budget = new Map(profile.env).get("ANALYTICS_V2_MEMORY_BUDGET_MIB");
  if (profile.memory !== "16Gi" || profile.cpu !== 4 || budget !== String(PRODUCTION_PROFILE.budgetMiB)) {
    fail("MEAS_SYNTH_PROFILE_INVALID", name);
  }
  return Object.freeze({ name, cpu: profile.cpu, memoryGiB: 16, heapMiB: profile.heapMiB, semiSpaceMiB: profile.semiSpaceMiB,
    budgetMiB: PRODUCTION_PROFILE.budgetMiB, workers: profile.workers, taskTimeoutSeconds: profile.taskTimeoutSeconds });
}

export { OUTPUT_DIGEST_POLICY };

function fail(code, detail) {
  throw Object.assign(new Error(detail === undefined ? code : `${code}: ${detail}`), { code });
}

function parseArguments(argv) {
  const options = { corpus: null, out: null, keepDatabase: false, reuseDatabase: null, guardProbe: false,
    cloneFrom: null, importOnly: false, profile: "dense", node22: process.env.GCP_FASTPATH_NODE22 || DEFAULT_NODE22,
    cpuProfileUs: null, cpuProfileSummarySeconds: null, cpuProfileDir: null, pgStatIntervalSeconds: null, workerProfileDir: null, workerProfileSource: null };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index], next = () => argv[++index];
    if (argument === "--corpus") options.corpus = resolve(next());
    else if (argument === "--out") options.out = resolve(next());
    else if (argument === "--keep-database") options.keepDatabase = true;
    else if (argument === "--reuse-database") options.reuseDatabase = next();
    else if (argument === "--guard-probe") options.guardProbe = true;
    else if (argument === "--clone-from") options.cloneFrom = next();
    else if (argument === "--import-only") options.importOnly = true;
    else if (argument === "--profile") options.profile = next();
    else if (argument === "--node22") options.node22 = next();
    else if (argument === "--pgstat-interval") {
      const value = next();
      if (!/^\d+$/u.test(value ?? "") || Number(value) < 10 || Number(value) > 1800) fail("MEAS_SYNTH_ARGUMENT_INVALID", "--pgstat-interval takes 10..1800 s");
      options.pgStatIntervalSeconds = Number(value);
    }
    else if (argument === "--worker-profile-dir") options.workerProfileDir = resolve(next());
    else if (argument === "--worker-profile-source") options.workerProfileSource = next();
    else if (argument === "--cpu-profile") {
      const value = next();
      if (!/^[1-9]\d{3,5}$/u.test(value ?? "")) fail("MEAS_SYNTH_ARGUMENT_INVALID", "--cpu-profile takes 1000..100000 us");
      options.cpuProfileUs = Number(value);
    } else if (argument === "--cpu-profile-summary") {
      const value = next();
      if (!/^[1-9]\d{1,4}$/u.test(value ?? "") || Number(value) < 10 || Number(value) > 86_400) {
        fail("MEAS_SYNTH_ARGUMENT_INVALID", "--cpu-profile-summary takes 10..86400 s");
      }
      options.cpuProfileSummarySeconds = Number(value);
    } else if (argument === "--cpu-profile-dir") options.cpuProfileDir = resolve(next());
    else fail("MEAS_SYNTH_ARGUMENT_INVALID", argument);
  }
  if (!options.corpus || !options.out) fail("MEAS_SYNTH_ARGUMENT_INVALID", "--corpus and --out are required");
  if (options.reuseDatabase !== null && !DATABASE.test(options.reuseDatabase)) fail("MEAS_SYNTH_DATABASE_INVALID");
  if (options.cloneFrom !== null && (!DATABASE.test(options.cloneFrom) || options.reuseDatabase !== null)) {
    fail("MEAS_SYNTH_DATABASE_INVALID", "--clone-from takes a meas_synth_<8 hex> database, without --reuse-database");
  }
  if (options.importOnly && (options.reuseDatabase !== null || options.cloneFrom !== null || options.guardProbe)) {
    fail("MEAS_SYNTH_ARGUMENT_INVALID", "--import-only imports a fresh database and runs nothing");
  }
  if (options.importOnly) options.keepDatabase = true;
  if ((options.cpuProfileDir !== null || options.cpuProfileSummarySeconds !== null) && options.cpuProfileUs === null) {
    fail("MEAS_SYNTH_ARGUMENT_INVALID", "--cpu-profile-dir and --cpu-profile-summary need --cpu-profile");
  }
  options.profile = measureProfile(options.profile);
  workerProfileEnv(options);
  if (options.workerProfileDir !== null && (options.profile.workers < 2 || options.importOnly || options.guardProbe)) {
    fail("MEAS_SYNTH_ARGUMENT_INVALID", "Worker profiling requires one local parallel refresh");
  }
  return options;
}

async function localEndpoint(env) {
  const socket = env.PG_TEST_SOCKET;
  const port = Number(env.PG_TEST_PORT ?? "55433");
  if (!socket || !PRIVATE_SOCKET.test(socket) || !Number.isSafeInteger(port)) fail("MEAS_SYNTH_DATABASE_UNCONFIGURED");
  const link = await lstat(socket);
  const real = await realpath(socket);
  const metadata = await stat(real);
  if (link.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 0o077) !== 0
      || metadata.uid !== process.getuid()) fail("MEAS_SYNTH_DATABASE_INVALID");
  return { host: real, port };
}

const poolFor = (endpoint, database, max = 6) => {
  const pool = new pg.Pool({ host: endpoint.host, port: endpoint.port, user: process.env.PG_TEST_USER || "postgres",
    database, ssl: false, max, connectionTimeoutMillis: 10_000, application_name: "gcp-fastpath-meas-synth" });
  pool.on("error", () => {});
  return pool;
};

/** /usr/bin/time -l's peak resident set (bytes) and CPU seconds, from its stderr tail. */
function parseTimeL(stderr) {
  const text = String(stderr);
  const number = (pattern) => {
    const match = text.match(pattern);
    return match ? Number(match[1]) : null;
  };
  return { maxResidentSetBytes: number(/(\d+)\s+maximum resident set size/u),
    peakMemoryFootprintBytes: number(/(\d+)\s+peak memory footprint/u),
    realSeconds: number(/([\d.]+)\s+real/u), userSeconds: number(/([\d.]+)\s+user/u),
    sysSeconds: number(/([\d.]+)\s+sys/u) };
}

function lastJson(text) {
  const lines = String(text ?? "").trim().split("\n").filter((line) => line.startsWith("{"));
  for (let index = lines.length - 1; index >= 0; index--) {
    try { return JSON.parse(lines[index]); } catch { /* not JSON */ }
  }
  return null;
}

export function refreshEnv(endpoint, database, profile, extra = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ANALYTICS_V2_TEST_CLOCK: "1",
    ANALYTICS_V2_MEMORY_BUDGET_MIB: String(profile.budgetMiB),
    ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS: String(profile.taskTimeoutSeconds),
    PG_TEST_SOCKET: endpoint.host, PG_TEST_PORT: String(endpoint.port), PG_TEST_DATABASE: database, ...extra };
}

/** The profiler environment for --cpu-profile (empty without it). */
export function cpuProfileEnv({ cpuProfileUs = null, cpuProfileSummarySeconds = null, cpuProfileDir = null } = {}) {
  if (cpuProfileUs === null) return {};
  return { ANALYTICS_V2_REFRESH_PROFILE: "cpu", ANALYTICS_V2_REFRESH_PROFILE_SAMPLE_US: String(cpuProfileUs),
    ...(cpuProfileSummarySeconds === null ? {}
      : { ANALYTICS_V2_REFRESH_PROFILE_SUMMARY_SECONDS: String(cpuProfileSummarySeconds) }),
    ...(cpuProfileDir === null ? {} : { ANALYTICS_V2_REFRESH_PROFILE_DIR: cpuProfileDir }) };
}

/** The job's content-free profile summary lines (analytics-refresh-profile.mjs), oldest first. */
export function profileLines(text) {
  const lines = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.startsWith("{\"profile\":")) continue;
    try { lines.push(JSON.parse(line)); } catch { /* not JSON */ }
  }
  return lines;
}

/** The job's arguments under a profile (the wrapper's refreshJobCommand order). */
export function refreshArguments(profile, schema) {
  return [...(profile.heapMiB === null ? [] : [`--max-old-space-size=${profile.heapMiB}`]),
    ...(profile.semiSpaceMiB === null ? [] : [`--max-semi-space-size=${profile.semiSpaceMiB}`]), DIST_REFRESH, "--mode=full", `--now=${PROD_SHAPE_REFRESH_NOW}`,
    `--schema=${schema}`, ...(profile.workers > 1 ? [`--workers=${profile.workers}`] : [])];
}

/** "[[dd-]hh:]mm:ss[.ff]" (ps time) in seconds, or null. */
export function psSeconds(text) {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u.exec(String(text).trim());
  if (match === null) return null;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

/**
 * Busy cores between consecutive samples (CPU seconds over wall seconds), as
 * a distribution: the share of sampled wall time at each whole number of busy
 * cores (rounded), the mean, and the CPU over wall of the whole sampled span.
 */
export function utilisationSummary(samples, { cores }) {
  const spans = [];
  for (let index = 1; index < samples.length; index++) {
    const wall = samples[index].atS - samples[index - 1].atS;
    const cpu = samples[index].cpuS - samples[index - 1].cpuS;
    if (wall > 0 && cpu >= 0) spans.push({ wall, busy: cpu / wall });
  }
  const wall = spans.reduce((sum, span) => sum + span.wall, 0);
  if (wall === 0) return null;
  const shares = {};
  for (const span of spans) {
    const key = String(Math.min(cores + 1, Math.max(0, Math.round(span.busy))));
    shares[key] = (shares[key] ?? 0) + span.wall / wall;
  }
  const busy = spans.reduce((sum, span) => sum + span.busy * span.wall, 0) / wall;
  return { sampledWallS: Math.round(wall), meanBusyCores: Number(busy.toFixed(2)),
    utilisationOfCores: Number((busy / cores).toFixed(3)), cores,
    wallShareByBusyCores: Object.fromEntries(Object.entries(shares).sort(([a], [b]) => Number(a) - Number(b))
      .map(([key, share]) => [key, Number(share.toFixed(3))])),
    peakRssMiB: Math.ceil(Math.max(...samples.map((sample) => sample.rssKiB)) / 1024) };
}

/** Samples a process's resident set (KiB) and CPU time (s) every `intervalMs` (ps), until stopped. */
function sampleProcess(pid, { intervalMs = 5_000, started = performance.now() } = {}) {
  const samples = [];
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const { stdout } = await execFileAsync("/bin/ps", ["-o", "rss=,time=", "-p", String(pid)]);
      const [rss, time] = stdout.trim().split(/\s+/u);
      const cpuS = psSeconds(time);
      if (Number.isSafeInteger(Number(rss)) && cpuS !== null) {
        samples.push({ atS: (performance.now() - started) / 1_000, rssKiB: Number(rss), cpuS });
      }
    } catch { /* the process ended */ }
  };
  const timer = setInterval(tick, intervalMs);
  void tick();
  return { samples, stop() { stopped = true; clearInterval(timer); } };
}

/** The child of `parentPid` (the job under /usr/bin/time), polled until it appears. */
async function childPid(parentPid, { attempts = 50 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const { stdout } = await execFileAsync("/usr/bin/pgrep", ["-P", String(parentPid)]);
      const pid = Number(stdout.trim().split("\n")[0]);
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch { /* not yet */ }
    await new Promise((wait) => setTimeout(wait, 100));
  }
  return null;
}

/** Explicit projection only; do not inherit local diagnostic settings from the environment. */
export function workerProfileEnv({ workerProfileDir = null, workerProfileSource = null } = {}) {
  if (workerProfileDir === null && workerProfileSource === null) return {};
  if (typeof workerProfileDir !== "string" || !workerProfileDir.startsWith("/")
      || !/^[a-f0-9]{40}$/u.test(workerProfileSource ?? "")) fail("MEAS_SYNTH_ARGUMENT_INVALID", "Worker profile directory and exact source are required together");
  return { ANALYTICS_V2_LOCAL_WORKER_PROFILE_DIR: workerProfileDir,
    ANALYTICS_V2_LOCAL_WORKER_PROFILE_SOURCE: workerProfileSource };
}

/** One full refresh under /usr/bin/time -l, measured to the end, its process sampled. */
async function runRefresh({ node22, endpoint, database, schema, outDir, label, profile, cpuProfile = {}, pgStat = null, workerProfile = {} }) {
  let started, sampler = null, stdout = "", stderr = "";
  const measured = await refreshPgStatLifecycle({ ...pgStat, run: async () => {
    started = performance.now();
    const child = spawn("/usr/bin/time", ["-l", node22, ...refreshArguments(profile, schema)], {
      cwd: CLOUD_RUN_ROOT, env: refreshEnv(endpoint, database, profile, { ...cpuProfileEnv(cpuProfile), ...workerProfileEnv(workerProfile) }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolveExit, rejectExit) => {
      child.once("close", resolveExit);
      child.once("error", rejectExit);
    });
    let stopped = false;
    const pidReady = childPid(child.pid).then((pid) => {
      if (!stopped && pid !== null) sampler = sampleProcess(pid, { started });
    });
    try {
      const [, code] = await Promise.all([pidReady, exited]);
      return { code, wallMs: Math.round(performance.now() - started) };
    } finally {
      stopped = true;
      await pidReady;
      sampler?.stop();
    }
  } });
  const code = measured.result.code;
  const exitCode = typeof code === "number" ? code : 1;
  const wallMs = measured.result.wallMs;
  await writeFile(join(outDir, `${label}.stdout.json`), String(stdout));
  await writeFile(join(outDir, `${label}.stderr.txt`), String(stderr));
  const samples = sampler?.samples ?? [];
  await writeFile(join(outDir, `${label}.samples.json`), `${JSON.stringify(samples)}\n`);
  return { exitCode, wallMs, receipt: lastJson(stdout), error: exitCode === 0 ? null : lastJson(stderr),
    time: parseTimeL(stderr), profileLines: profileLines(stderr), pgStat: measured.evidence,
    utilisation: utilisationSummary(samples, { cores: profile.cpu }) };
}

/**
 * The production time guard within its first `waitMs`: a refresh with the
 * production task timeout, stopped after `waitMs` unless it ends first.
 * `outcome` is "refused" (a deadline refusal, at whichever checkpoint),
 * "exited" (it ended otherwise) or "stopped-unrefused". The job logs no
 * plan-checkpoint marker, so "stopped-unrefused" does not show that the plan
 * checkpoint was reached.
 */
async function guardProbe({ node22, endpoint, database, schema, profile, waitMs = 600_000 }) {
  return new Promise((resolveProbe) => {
    const child = spawn(node22, refreshArguments(profile, schema), {
      cwd: CLOUD_RUN_ROOT, stdio: ["ignore", "pipe", "pipe"],
      env: refreshEnv(endpoint, database, profile, {
        ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS: String(profile.taskTimeoutSeconds) }),
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const started = performance.now();
    const timer = setTimeout(() => child.kill("SIGTERM"), waitMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const error = lastJson(stderr);
      const refused = /^ANALYTICS_V2_REFRESH_DEADLINE_/u.test(error?.code ?? "");
      resolveProbe({ taskTimeoutSeconds: profile.taskTimeoutSeconds, waitMs, exitCode: code, signal,
        elapsedMs: Math.round(performance.now() - started),
        outcome: refused ? "refused" : code === null && signal === "SIGTERM" ? "stopped-unrefused" : "exited",
        refusalCode: refused ? error.code : null,
        stoppedAfterMs: signal === "SIGTERM" ? waitMs : null, error, receipt: lastJson(stdout) });
    });
  });
}

/** Rows and bytes of every analytics_v2 table, and the published payload bytes. */
export async function outputSizes(pool, schema) {
  const quoted = `"${schema}"`;
  const tables = await pool.query(`SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes,
      pg_relation_size(c.oid)::bigint AS heap_bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname LIKE 'analytics_v2%' ORDER BY c.relname`, [schema]);
  const out = {};
  for (const row of tables.rows) {
    const count = await pool.query(`SELECT count(*)::bigint AS n FROM ${quoted}."${row.name}"`);
    out[row.name] = { rows: Number(count.rows[0].n), bytes: Number(row.bytes), heapBytes: Number(row.heap_bytes) };
  }
  const payloads = await pool.query(`SELECT count(*)::int AS days, COALESCE(sum(octet_length(payload::text)),0)::bigint AS bytes,
      COALESCE(max(octet_length(payload::text)),0)::int AS max_bytes FROM ${quoted}.analytics_v2_published_daily`)
    .catch(() => ({ rows: [null] }));
  return { tables: out, totalBytes: Object.values(out).reduce((sum, table) => sum + table.bytes, 0),
    publishedDaily: payloads.rows[0] === null ? null : { days: payloads.rows[0].days,
      payloadBytes: Number(payloads.rows[0].bytes), maxPayloadBytes: payloads.rows[0].max_bytes } };
}

/** Source-bound fresh-run evidence; callers must supply exact kernel and compute-class identity. */
export async function outputDigests(pool, schema, binding) {
  const evidence = await collectOutputDigestEvidence(pool, schema, binding);
  return Object.fromEntries(Object.entries(evidence.tables).filter(([, table]) => table.semanticSha256 !== null)
    .map(([name, table]) => [name, { rows: table.rows, sha256: table.semanticSha256 }]));
}

async function expectedOutputBinding() {
  const { stdout } = await execFileAsync(process.execPath, [join(CLOUD_RUN_ROOT, "build.mjs"), "--kernel-closure"],
    { cwd: CLOUD_RUN_ROOT, maxBuffer: 4 * 1024 * 1024 });
  const identity = JSON.parse(stdout.trim()).kernel;
  const registry = JSON.parse(await readFile(join(WORKER_ROOT, "src/analytics-v2/kernel-registry.json"), "utf8"));
  const matches = registry.kernels.filter((entry) => entry.computeClosureSha256 === identity.computeClosureSha256
    && entry.vendorManifestSha256 === identity.vendorManifestSha256);
  if (matches.length !== 1) fail("MEAS_OUTPUT_PROVENANCE_BINDING_INVALID");
  return { kernelId: matches[0].kernelId, computeSha256: identity.computeSha256, manifestVersion: 1 };
}

/**
 * The newest run row's per-owner resource record (analytics_v2_runs.timings
 * owners: estimate, heap peak, output bytes and counts), with each owner
 * named by a 12-hex prefix of its digest only, plus the run's stamps.
 */
export async function runRecord(pool, schema) {
  const result = await pool.query(`SELECT timings, kernel_id, manifest_version, compatibility_sha256,
      exclusions_sha256, extract(epoch FROM finished_at - started_at)::float8 AS seconds
    FROM "${schema}".analytics_v2_runs ORDER BY finished_at DESC LIMIT 1`);
  const row = result.rows[0];
  if (row === undefined) return null;
  const MIB = 1_048_576;
  const owners = (Array.isArray(row.timings?.owners) ? row.timings.owners : []).map((owner) => ({
    owner: String(owner.ownerDigest ?? "").slice(0, 12), admitted: owner.admitted === true,
    usage: owner.usage ?? null, quota: owner.quota ?? null, session: owner.session ?? null,
    analysisUsage: owner.analysisUsage ?? null,
    estimateMiB: Number.isSafeInteger(owner.estimateBytes) ? Math.ceil(owner.estimateBytes / MIB) : null,
    heapPeakMiB: Number.isSafeInteger(owner.heapPeakBytes) ? Math.ceil(owner.heapPeakBytes / MIB) : null,
    outputMiB: Number.isSafeInteger(owner.outputBytes) ? Math.ceil(owner.outputBytes / MIB) : null,
  })).sort((left, right) => (right.estimateMiB ?? 0) - (left.estimateMiB ?? 0));
  return { kernelId: row.kernel_id, manifestVersion: row.manifest_version,
    compatibilitySha256: row.compatibility_sha256, exclusionsSha256: row.exclusions_sha256,
    runSeconds: row.seconds, owners };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!existsSync(options.node22)) fail("MEAS_SYNTH_NODE22_MISSING");
  const node22Version = (await execFileAsync(options.node22, ["--version"])).stdout.trim();
  if (!/^v22\./u.test(node22Version)) fail("MEAS_SYNTH_NODE22_MISSING");
  if (!existsSync(DIST_REFRESH)) fail("MEAS_SYNTH_DIST_MISSING", "build cloud-run/dist under Node 22 first");
  const corpus = await readProdShapeCorpus(options.corpus);
  const endpoint = await localEndpoint(process.env);
  const outDir = dirname(options.out);
  await mkdir(outDir, { recursive: true });
  const database = options.reuseDatabase ?? `meas_synth_${randomBytes(4).toString("hex")}`;
  // A clone keeps its template's schema, named from the template's suffix.
  const suffix = createHashSuffix(options.cloneFrom ?? database);
  const { schema, controlSchema } = fastpathRehearsalSchemas(suffix);
  const report = {
    schemaVersion: "gcp-fastpath-prod-shape-local-measurement-v1",
    startedAt: new Date().toISOString(),
    node: { driver: process.version, analyticsRefresh: node22Version },
    database, schema, reusedDatabase: options.reuseDatabase !== null, clonedFrom: options.cloneFrom,
    profile: options.profile, refreshArguments: refreshArguments(options.profile, schema).slice(1)
      .map((argument) => (argument === DIST_REFRESH ? "dist/analytics-refresh.mjs" : argument)),
    refreshNow: PROD_SHAPE_REFRESH_NOW,
    corpus: { sealedSha256: corpus.manifest.sealed.sha256, scale: corpus.manifest.corpus.scale,
      owners: corpus.manifest.owners.length, totals: corpus.manifest.totals, own3: corpus.manifest.own3 },
    steps: {},
  };
  const admin = poolFor(endpoint, "postgres", 2);
  let pool = null;
  let created = false;
  const save = () => writeFile(options.out, `${JSON.stringify(report, null, 1)}\n`);
  try {
    const version = await admin.query("SELECT current_setting('server_version_num')::integer AS version");
    if (Math.floor(version.rows[0].version / 10_000) !== 17) fail("MEAS_SYNTH_POSTGRES_17_REQUIRED");
    if (options.reuseDatabase === null) {
      const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
      if (exists.rows.length > 0) fail("MEAS_SYNTH_DATABASE_EXISTS");
      if (options.cloneFrom !== null) {
        const source = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [options.cloneFrom]);
        if (source.rows.length !== 1) fail("MEAS_SYNTH_DATABASE_INVALID", "--clone-from names no database");
        const cloneStarted = performance.now();
        await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${options.cloneFrom}"`);
        report.steps.clone = { from: options.cloneFrom, ms: Math.round(performance.now() - cloneStarted) };
      } else {
        await admin.query(`CREATE DATABASE "${database}"`);
      }
      created = true;
    }
    pool = poolFor(endpoint, database);
    if (options.reuseDatabase === null && options.cloneFrom === null) {
      const migrateStarted = performance.now();
      for (const name of [schema, controlSchema]) await pool.query(`CREATE SCHEMA "${name}"`);
      const primary = await applyPostgresMigrations({ role: "primary", schema, pool });
      const expected = await readPostgresMigrations({ role: "primary" });
      if (primary.applied !== expected.length) fail("MEAS_SYNTH_MIGRATION_INCOMPLETE");
      report.steps.migrate = { applied: primary.applied, tail: primary.migrations.at(-1)?.name ?? null,
        ms: Math.round(performance.now() - migrateStarted) };
      await save();
      const workDirectory = await realpath(await mkdtemp(join(tmpdir(), "meas-synth-import-")));
      let importBefore = null;
      try {
        if (options.pgStatIntervalSeconds !== null) {
          report.steps.importWorkDirectory = workDirectory;
          await save();
          importBefore = await capturePgStat(pool, "import-before");
        }
        report.steps.import = await importProdShapeCorpus({ pool, suffix, corpus, workDirectory,
          log: (line) => console.error(line) });
      } finally {
        await rm(workDirectory, { recursive: true, force: true });
        if (options.pgStatIntervalSeconds !== null) report.steps.importWorkDirectoryRemoved = true;
      }
      if (importBefore !== null) {
        const after = await capturePgStat(pool, "import-after");
        report.steps.importPgStat = { scope: "corpus-import-only", before: importBefore, after, delta: pgStatDelta(importBefore, after) };
      }
      await save();
    }
    if (options.importOnly) {
      report.finishedAt = new Date().toISOString();
      await save();
      return;
    }
    console.error(`# refresh (profile ${options.profile.name}) on ${schema}`);
    const run = await runRefresh({ node22: options.node22, endpoint, database, schema, outDir, label: "refresh-1",
      profile: options.profile, workerProfile: options, cpuProfile: { cpuProfileUs: options.cpuProfileUs,
        cpuProfileSummarySeconds: options.cpuProfileSummarySeconds, cpuProfileDir: options.cpuProfileDir },
      pgStat: options.pgStatIntervalSeconds === null ? null : { intervalMs: options.pgStatIntervalSeconds * 1000, snapshot: (label) => capturePgStat(pool, label) } });
    if (run.pgStat !== null) report.steps.refreshPgStat = run.pgStat;
    if (options.workerProfileDir !== null) report.steps.workerProfileCapture = { directory: options.workerProfileDir,
      declaredSource: options.workerProfileSource, scope: "local synthetic isolate diagnostics; inspect manifest coverage" };
    report.steps.refresh = { exitCode: run.exitCode, wallMs: run.wallMs, state: run.receipt?.state ?? null,
      timingsMs: run.receipt?.timings ?? null, memory: run.receipt?.memory ?? null, reads: run.receipt?.reads ?? null,
      utilisation: run.utilisation,
      owners: run.receipt?.owners ?? null, ownerDays: run.receipt?.ownerDays ?? null,
      refusals: run.receipt?.refusals ?? null, refusalsByReason: run.receipt?.refusalsByReason ?? null,
      published: Array.isArray(run.receipt?.published) ? run.receipt.published.length : null,
      blocked: run.receipt?.blocked ?? null, error: run.error, time: run.time,
      cpuProfileUs: options.cpuProfileUs, cpuProfileSummarySeconds: options.cpuProfileSummarySeconds, profile: run.profileLines.at(-1) ?? null, profileLines: run.profileLines };
    await save();
    report.steps.outputs = await outputSizes(pool, schema);
    report.steps.outputDigestEvidence = await collectOutputDigestEvidence(pool, schema, await expectedOutputBinding());
    report.steps.outputDigests = Object.fromEntries(Object.entries(report.steps.outputDigestEvidence.tables)
      .filter(([, table]) => table.semanticSha256 !== null)
      .map(([name, table]) => [name, { rows: table.rows, sha256: table.semanticSha256 }]));
    report.steps.run = await runRecord(pool, schema);
    await save();
    if (options.guardProbe) {
      console.error(`# guard probe (task timeout ${measureProfile(options.profile).taskTimeoutSeconds} s)`);
      report.steps.guardProbe = await guardProbe({ node22: options.node22, endpoint, database, schema,
        profile: options.profile });
      await save();
    }
    report.finishedAt = new Date().toISOString();
    await save();
  } finally {
    if (pool !== null) await pool.end().catch(() => {});
    if (created && !options.keepDatabase) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
      report.databaseDropped = true;
    } else {
      report.databaseDropped = false;
    }
    await save().catch(() => {});
    await admin.end().catch(() => {});
  }
}

/** The rehearsal target's 8-hex suffix, from the database name. */
function createHashSuffix(database) {
  return database.slice("meas_synth_".length);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "error", code: error?.code ?? "MEAS_SYNTH_FAILED",
      message: String(error?.message ?? "").slice(0, 2_000) }));
    process.exitCode = 1;
  });
}
