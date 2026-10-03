#!/usr/bin/env node
// Local production-scale measurement of the full-recompute analytics refresh
// (MEAS-SYNTH), against a local PostgreSQL 17 only.
//
//   PG_TEST_SOCKET=/private/tmp/tibotattle-pg-fanout-20260926/socket PG_TEST_PORT=55433 \
//   ~/.nvm/versions/node/v26.2.0/bin/node --max-old-space-size=49152 \
//     apps/worker/scripts/gcp-fastpath-prod-shape/measure-local.mjs \
//       --corpus <seed-source.mjs work dir> --out <report.json> [--keep-database] [--reuse-database <name>]
//       [--guard-probe] [--node22 <path>]
//
//  1. creates a fresh database meas_synth_<8 hex> on the cluster (never an
//     existing one), a fast-path rehearsal target schema in it, and applies
//     every promoted primary migration with the production runner;
//  2. imports the sealed corpus through the reviewed importer chain
//     (import-corpus.mjs), then ANALYZEs the schema;
//  3. runs cloud-run/dist/analytics-refresh.mjs --mode=full once under
//     Node 22 with the PRODUCTION task profile's heap and budget
//     (--max-old-space-size=12288, ANALYTICS_V2_MEMORY_BUDGET_MIB=10752; no
//     task timeout, so the run is measured to the end), wrapped in
//     /usr/bin/time -l for the process's peak resident set;
//  4. records the job's receipt (phase timings, memory summary, owner and
//     refusal counts), the wall time, the peak RSS and the output sizes
//     (rows and bytes of every analytics_v2 table and the published payloads);
//  5. --guard-probe: a second refresh with
//     ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS=14400 (the production task
//     timeout), stopped after 600 s unless it ends sooner, records whether the
//     time guard refused it within that window. The job logs no
//     plan-checkpoint marker, so a probe stopped unrefused shows only that no
//     refusal came in its first 600 s, not that the plan checkpoint was
//     reached or passed;
//  6. drops the database (unless --keep-database).
//
// Local and synthetic only: no network, no production data, no secrets.
// The report holds counts, sizes, timings and digests only.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

import { fastpathRehearsalSchemas } from "../gcp-fastpath-rehearsal.mjs";
import { applyPostgresMigrations, readPostgresMigrations } from "../postgres-migrations.mjs";
import { importProdShapeCorpus, readProdShapeCorpus } from "./import-corpus.mjs";
import { PROD_SHAPE_REFRESH_NOW } from "./prod-shape-corpus.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(HERE, "../..");
const CLOUD_RUN_ROOT = join(WORKER_ROOT, "cloud-run");
const DIST_REFRESH = join(CLOUD_RUN_ROOT, "dist", "analytics-refresh.mjs");
const DEFAULT_NODE22 = join(homedir(), ".nvm/versions/node/v22.16.0/bin/node");
const PRIVATE_SOCKET = /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u;
const DATABASE = /^meas_synth_[0-9a-f]{8}$/u;
/** The production task profile (cloud-run/analytics-refresh.mjs ANALYTICS_REFRESH_PRODUCTION_JOB, "dense"). */
export const PRODUCTION_PROFILE = Object.freeze({ cpu: 4, memoryGiB: 16, heapMiB: 12_288, budgetMiB: 10_752,
  taskTimeoutSeconds: 14_400 });

function fail(code, detail) {
  throw Object.assign(new Error(detail === undefined ? code : `${code}: ${detail}`), { code });
}

function parseArguments(argv) {
  const options = { corpus: null, out: null, keepDatabase: false, reuseDatabase: null, guardProbe: false,
    node22: process.env.GCP_FASTPATH_NODE22 || DEFAULT_NODE22 };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index], next = () => argv[++index];
    if (argument === "--corpus") options.corpus = resolve(next());
    else if (argument === "--out") options.out = resolve(next());
    else if (argument === "--keep-database") options.keepDatabase = true;
    else if (argument === "--reuse-database") options.reuseDatabase = next();
    else if (argument === "--guard-probe") options.guardProbe = true;
    else if (argument === "--node22") options.node22 = next();
    else fail("MEAS_SYNTH_ARGUMENT_INVALID", argument);
  }
  if (!options.corpus || !options.out) fail("MEAS_SYNTH_ARGUMENT_INVALID", "--corpus and --out are required");
  if (options.reuseDatabase !== null && !DATABASE.test(options.reuseDatabase)) fail("MEAS_SYNTH_DATABASE_INVALID");
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

function refreshEnv(endpoint, database, extra = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ANALYTICS_V2_TEST_CLOCK: "1",
    ANALYTICS_V2_MEMORY_BUDGET_MIB: String(PRODUCTION_PROFILE.budgetMiB),
    PG_TEST_SOCKET: endpoint.host, PG_TEST_PORT: String(endpoint.port), PG_TEST_DATABASE: database, ...extra };
}

/** One full refresh under /usr/bin/time -l, measured to the end. */
async function runRefresh({ node22, endpoint, database, schema, outDir, label }) {
  const started = performance.now();
  let stdout = "", stderr = "", exitCode = 0;
  try {
    ({ stdout, stderr } = await execFileAsync("/usr/bin/time", ["-l", node22,
      `--max-old-space-size=${PRODUCTION_PROFILE.heapMiB}`, DIST_REFRESH, "--mode=full",
      `--now=${PROD_SHAPE_REFRESH_NOW}`, `--schema=${schema}`], {
      cwd: CLOUD_RUN_ROOT, env: refreshEnv(endpoint, database), maxBuffer: 256 * 1024 * 1024,
    }));
  } catch (error) {
    stdout = error.stdout ?? ""; stderr = error.stderr ?? "";
    exitCode = typeof error.code === "number" ? error.code : 1;
  }
  const wallMs = Math.round(performance.now() - started);
  await writeFile(join(outDir, `${label}.stdout.json`), String(stdout));
  await writeFile(join(outDir, `${label}.stderr.txt`), String(stderr));
  return { exitCode, wallMs, receipt: lastJson(stdout), error: exitCode === 0 ? null : lastJson(stderr),
    time: parseTimeL(stderr) };
}

/**
 * The production time guard within its first `waitMs`: a refresh with the
 * production task timeout, stopped after `waitMs` unless it ends first.
 * `outcome` is "refused" (a deadline refusal, at whichever checkpoint),
 * "exited" (it ended otherwise) or "stopped-unrefused". The job logs no
 * plan-checkpoint marker, so "stopped-unrefused" does not show that the plan
 * checkpoint was reached.
 */
async function guardProbe({ node22, endpoint, database, schema, waitMs = 600_000 }) {
  return new Promise((resolveProbe) => {
    const child = spawn(node22, [`--max-old-space-size=${PRODUCTION_PROFILE.heapMiB}`, DIST_REFRESH, "--mode=full",
      `--now=${PROD_SHAPE_REFRESH_NOW}`, `--schema=${schema}`], {
      cwd: CLOUD_RUN_ROOT, stdio: ["ignore", "pipe", "pipe"],
      env: refreshEnv(endpoint, database, {
        ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS: String(PRODUCTION_PROFILE.taskTimeoutSeconds) }),
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
      resolveProbe({ taskTimeoutSeconds: PRODUCTION_PROFILE.taskTimeoutSeconds, waitMs, exitCode: code, signal,
        elapsedMs: Math.round(performance.now() - started),
        outcome: refused ? "refused" : code === null && signal === "SIGTERM" ? "stopped-unrefused" : "exited",
        refusalCode: refused ? error.code : null,
        stoppedAfterMs: signal === "SIGTERM" ? waitMs : null, error, receipt: lastJson(stdout) });
    });
  });
}

/** Rows and bytes of every analytics_v2 table, and the published payload bytes. */
async function outputSizes(pool, schema) {
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
  const suffix = createHashSuffix(database);
  const { schema, controlSchema } = fastpathRehearsalSchemas(suffix);
  const report = {
    schemaVersion: "gcp-fastpath-prod-shape-local-measurement-v1",
    startedAt: new Date().toISOString(),
    node: { driver: process.version, analyticsRefresh: node22Version },
    database, schema, reusedDatabase: options.reuseDatabase !== null,
    profile: PRODUCTION_PROFILE, refreshNow: PROD_SHAPE_REFRESH_NOW,
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
      await admin.query(`CREATE DATABASE "${database}"`);
      created = true;
    }
    pool = poolFor(endpoint, database);
    if (options.reuseDatabase === null) {
      const migrateStarted = performance.now();
      for (const name of [schema, controlSchema]) await pool.query(`CREATE SCHEMA "${name}"`);
      const primary = await applyPostgresMigrations({ role: "primary", schema, pool });
      const expected = await readPostgresMigrations({ role: "primary" });
      if (primary.applied !== expected.length) fail("MEAS_SYNTH_MIGRATION_INCOMPLETE");
      report.steps.migrate = { applied: primary.applied, tail: primary.migrations.at(-1)?.name ?? null,
        ms: Math.round(performance.now() - migrateStarted) };
      await save();
      const workDirectory = await realpath(await mkdtemp(join(tmpdir(), "meas-synth-import-")));
      try {
        report.steps.import = await importProdShapeCorpus({ pool, suffix, corpus, workDirectory,
          log: (line) => console.error(line) });
      } finally {
        await rm(workDirectory, { recursive: true, force: true });
      }
      await save();
    }
    console.error(`# refresh (production profile) on ${schema}`);
    const run = await runRefresh({ node22: options.node22, endpoint, database, schema, outDir, label: "refresh-1" });
    report.steps.refresh = { exitCode: run.exitCode, wallMs: run.wallMs, state: run.receipt?.state ?? null,
      timingsMs: run.receipt?.timings ?? null, memory: run.receipt?.memory ?? null,
      owners: run.receipt?.owners ?? null, ownerDays: run.receipt?.ownerDays ?? null,
      refusals: run.receipt?.refusals ?? null, refusalsByReason: run.receipt?.refusalsByReason ?? null,
      published: Array.isArray(run.receipt?.published) ? run.receipt.published.length : null,
      blocked: run.receipt?.blocked ?? null, error: run.error, time: run.time };
    await save();
    report.steps.outputs = await outputSizes(pool, schema);
    await save();
    if (options.guardProbe) {
      console.error("# guard probe (task timeout 14,400 s)");
      report.steps.guardProbe = await guardProbe({ node22: options.node22, endpoint, database, schema });
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

main().catch((error) => {
  console.error(JSON.stringify({ status: "error", code: error?.code ?? "MEAS_SYNTH_FAILED",
    message: String(error?.message ?? "").slice(0, 2_000) }));
  process.exitCode = 1;
});
