#!/usr/bin/env node

/**
 * analytics-refresh: the analytics_v2 Cloud Run Job (A-3, build entry
 * "analytics-refresh" -> dist/analytics-refresh.mjs).
 *
 * One invocation is one full recompute:
 *   1. take pg_try_advisory_lock(hashtext('analytics_v2_refresh')) on a
 *      dedicated session; when another run holds it, exit 0 with state
 *      LOCK_HELD having written nothing;
 *   2. open one REPEATABLE READ READ ONLY transaction on that session, export
 *      its snapshot, read the prior analytics_v2 state (journal cursor, the
 *      days the last run left blocked, the earliest stored cache-band day),
 *      and run every A-1 reader through a pool whose transactions all import
 *      that snapshot;
 *   3. compute with A-2 (pure, single-threaded), one effective owner at a
 *      time: A-1's exact evidence counts (countOwnerOccurrences) decide the
 *      per-owner memory guard and the read spans before anything is read; an
 *      admitted owner is then read in the same snapshot in bounded segments
 *      (the history before the analysis horizon in 60-day segments, each
 *      released before the next, then the analysis horizon), computed and
 *      released, so the heap holds one segment of the largest owner, not its
 *      whole history or the corpus. The exporting transaction stays open
 *      until the last read;
 *   4. write everything with store.ts writeRunOutputs in ONE transaction on
 *      the same session, then release the lock.
 *
 * Publication follows production's queue (d43c8f92
 * advanceNextStorageCommunityDaily): a run recomputes and may republish only
 * the days named by journal events after the cursor plus the days the last
 * run left blocked. Untouched heads are never recomputed, so a change to the
 * eligible roster (opt-out, disconnect, expiry) is not applied retroactively
 * to published history; terminal journal events stop future uploads only and
 * re-queue nothing (2026-09-26 owner decisions).
 *
 * Production and staging (ANALYTICS_REFRESH_TARGET=production|staging): the
 * reviewed target path. The invocation is exactly
 *   node --max-old-space-size=<heap> dist/analytics-refresh.mjs --mode=full
 * (ANALYTICS_REFRESH_PRODUCTION_JOB), with no --schema, --now or
 * --revision-seed, on the real clock. The environment is closed
 * (ANALYTICS_REFRESH_PRODUCTION_ENV): ANALYTICS_REFRESH_TARGET,
 * PRIMARY_INSTANCE_CONNECTION_NAME, PRIMARY_DATABASE, PRIMARY_SCHEMA,
 * POSTGRES_IAM_USER and ANALYTICS_V2_MEMORY_BUDGET_MIB. Any other variable in
 * the job's configuration namespaces (ANALYTICS_, PRIMARY_, POSTGRES_, LEDGER_,
 * and PG, which also covers every libpq-style variable node-pg reads, such as
 * PGOPTIONS, PGSSLMODE or PGPASSWORD), the Node runtime variables that change
 * the code loaded, the database driver or TLS trust
 * (ANALYTICS_REFRESH_RUNTIME_FORBIDDEN: NODE_OPTIONS, NODE_PG_FORCE_NATIVE,
 * NODE_TLS_REJECT_UNAUTHORIZED, NODE_EXTRA_CA_CERTS), every variable
 * postgres-production-configuration.mjs (CR-3) refuses in production (its
 * test seams, edge secrets, the retired ledger settings),
 * ANALYTICS_V2_TEST_CLOCK and GOOGLE_APPLICATION_CREDENTIALS are refused, as
 * are a test or rehearsal target (the IAM test and fast-path resources, a test
 * or rehearsal schema, database, instance or job) and a resource carrying the
 * other plane's marker (CR-3's convention: a staging resource carries
 * 'staging' and never 'production'; a production one never carries
 * 'staging'). The job's own code reads nothing else except the Cloud Run job
 * context: CLOUD_RUN_JOB, one task (CLOUD_RUN_TASK_INDEX=0,
 * CLOUD_RUN_TASK_COUNT=1) and no K_SERVICE. Other platform and image
 * variables (CLOUD_RUN_EXECUTION, K_*, PATH, HOME, NODE_VERSION,
 * DEPLOYMENT_SOURCE_COMMIT and so on) are tolerated; libraries may read some
 * of their own (google-auth-library's GCE_METADATA_HOST, proxy variables),
 * which this contract does not refuse. NODE_OPTIONS is read by Node before
 * this code runs, so its refusal ends the run but cannot undo a preload.
 *
 * Without ANALYTICS_REFRESH_TARGET the Job keeps its test targets (below).
 *
 * Flags:
 *   --mode=full            required; the only mode
 *   --schema=<identifier>  runtime (primary) schema; defaults to PRIMARY_SCHEMA
 *                          (refused under a production target)
 *   --now=<ISO instant>    pin the clock; accepted only under a test clock
 *                          (ANALYTICS_V2_TEST_CLOCK=1 or a POSTGRES_TEST_HTTP_MODE),
 *                          never under a production target
 *   --revision-seed=<n>    published revisions start above n (default 0;
 *                          refused under a production target)
 *   --help
 *
 * Time guard: a run with a known task timeout (a production target takes its
 * profile's, ANALYTICS_REFRESH_PRODUCTION_JOB; elsewhere
 * ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS may set one) refuses with a
 * receipt before the task timeout instead of being killed: it refuses
 * ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED when the remaining owners cannot
 * finish even at the measured phase rates (ANALYTICS_REFRESH_TIME_MODEL), and
 * ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED rather than start a step that could
 * cross the point where the write, the rollback and the receipt still fit.
 * Nothing is written either way.
 *
 * Resources (environment; defaults sized for an 8 GiB task whose Node heap
 * is --max-old-space-size=6144; each value must lie within its bounds; a
 * production target accepts only the memory budget and requires it):
 *   ANALYTICS_V2_MEMORY_BUDGET_MIB       per-owner memory estimate budget
 *                                        (default 4608, 1024..30720); an owner
 *                                        over it is refused with memory_budget
 *   ANALYTICS_V2_MAX_DAY_OCCURRENCES     owner-day backstop (default 250000,
 *                                        20000..250000)
 *   ANALYTICS_V2_MAX_DAY_RECORD_MIB      owner-day record bytes backstop
 *                                        (default 256, 32..256)
 *   ANALYTICS_V2_READ_CHUNK_OCCURRENCES  occurrences one read call targets
 *                                        (default 250000, 10000..2000000)
 * The heap is partitioned: the per-owner budget, the read reserve (4 KiB per
 * read-chunk occurrence), a 256 MiB runtime reserve, and the rest is the
 * output budget, which A-2's output account charges every held output row
 * against (resources.ts). The run refuses to start
 * (ANALYTICS_V2_REFRESH_HEAP_INSUFFICIENT) unless the output budget is at
 * least 64 MiB. Once the plan has fixed the largest admitted owner's
 * estimate, the output budget also takes the rest of the per-owner budget
 * (compute reclaimUnusedOwnerBudget, resources.ts analyticsV2OutputBudget);
 * the run refuses mid-run (ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED, nothing
 * written) when the account exceeds that.
 *
 * Database: under a production target, the configured Cloud SQL instance
 * through cloud-sql.mjs createIamPool. Otherwise, in a Cloud Run Job
 * (CLOUD_RUN_JOB set), only the private test primary or the fast-path test
 * database. Elsewhere it needs a local endpoint: PG_TEST_SOCKET (a private
 * /private/tmp/tibotattle-pg-* socket directory) or a loopback PG_TEST_HOST,
 * with PG_TEST_PORT.
 *
 * Output: one content-free JSON receipt line on stdout (counts and calendar
 * days only), or one JSON error line with a closed code on stderr (a deadline
 * or output-budget refusal adds its content-free figures). Exit 0 for
 * complete and LOCK_HELD, 2 for a usage refusal, 1 for any other failure.
 *
 * The TypeScript store and the A-1/A-2 modules are loaded through literal
 * dynamic imports, so esbuild bundles them into the dist entry while the
 * source file still answers --help under plain Node 22.
 */

import { randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";
import { Connector } from "@google-cloud/cloud-sql-connector";
import pg from "pg";
import {
  closeCloudSqlResources,
  createIamPool as createCloudSqlIamPool,
  normalizeIamUser,
} from "./cloud-sql.mjs";
import {
  FASTPATH_TEST_CLOUD_TARGET,
  FASTPATH_TEST_SCHEMA_PREFIXES,
  isFastpathTestSchema,
} from "./origin-fastpath-mode.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./cloud-run-iam-test-target.mjs";

/** Mirrors contract.ts ANALYTICS_V2_REFRESH_ENTRY; the spec pins the equality. */
export const ANALYTICS_REFRESH_ENTRY = "analytics-refresh";
/** Mirrors contract.ts ANALYTICS_V2_REFRESH_LOCK_KEY; the spec pins the equality. */
export const ANALYTICS_REFRESH_LOCK_KEY = "analytics_v2_refresh";
export const ANALYTICS_REFRESH_RECEIPT_VERSION = "analytics-refresh-receipt-v1";
export const ANALYTICS_REFRESH_MODES = Object.freeze(["full"]);
/**
 * POSTGRES_TEST_HTTP_MODE values the host accepts (server.mjs
 * postgresTestHttpMode); the cloud-run-iam mode is retired (OD-6).
 */
const TEST_HTTP_MODES = new Set(["health-only", "health-and-v12-day-manifest", "fastpath-test"]);
const FLAG = /^--([a-z][a-z-]*)=(.*)$/su;
/** The production target's planes (ANALYTICS_REFRESH_TARGET). */
export const ANALYTICS_REFRESH_TARGETS = Object.freeze(["production", "staging"]);
/** The closed environment of a production or staging run, in the order C-INFRA renders it. */
export const ANALYTICS_REFRESH_PRODUCTION_ENV = Object.freeze([
  "ANALYTICS_REFRESH_TARGET", "PRIMARY_INSTANCE_CONNECTION_NAME", "PRIMARY_DATABASE", "PRIMARY_SCHEMA",
  "POSTGRES_IAM_USER", "ANALYTICS_V2_MEMORY_BUDGET_MIB",
]);
/**
 * Configuration namespaces a production run closes: any other name in them is
 * refused. "PG" covers the rehearsal seams (PG_TEST_*) and every libpq-style
 * variable node-pg reads for a connection it is not given explicitly
 * (PGOPTIONS, PGSSLMODE, PGPASSWORD, PGCONNECT_TIMEOUT and so on).
 */
export const ANALYTICS_REFRESH_CLOSED_PREFIXES = Object.freeze(["ANALYTICS_", "PRIMARY_", "POSTGRES_", "PG", "LEDGER_"]);
/**
 * Node runtime variables a production run refuses: they change the code Node
 * loads (NODE_OPTIONS), the database driver (node-pg's NODE_PG_FORCE_NATIVE)
 * or TLS trust for every connection (NODE_TLS_REJECT_UNAUTHORIZED,
 * NODE_EXTRA_CA_CERTS). The NODE_ namespace is not closed: the node image
 * sets NODE_VERSION.
 */
export const ANALYTICS_REFRESH_RUNTIME_FORBIDDEN = Object.freeze(["NODE_OPTIONS", "NODE_PG_FORCE_NATIVE",
  "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS"]);
/**
 * The production refresh Job as C-INFRA renders it (gcp-ops-infra-manifest.mjs
 * renderJob; its check pins the render to this object). The task profile is
 * the dense one (4 vCPU, 16 GiB, a 12,288 MiB heap, a 10,752 MiB per-owner
 * budget, 4 h) until MEAS-3 measures the largest real owner on Cloud Run
 * (dense-owner parity receipt). The budget admits that owner at the high end
 * of its estimate (about 10 GiB when its records fall in the 170 analysis
 * days, which memory model v2 still charges whole; cap-raise receipt). A run
 * reclaims the part of it that its largest admitted owner leaves for the
 * output account (compute reclaimUnusedOwnerBudget). One task, no retries: a
 * run either writes everything in one transaction or nothing, and the time
 * guard refuses it before taskTimeoutSeconds. `args` follows `node`.
 */
export const ANALYTICS_REFRESH_PRODUCTION_JOB = Object.freeze({
  entry: "dist/analytics-refresh.mjs",
  profile: "dense",
  cpu: "4",
  memory: "16Gi",
  heapMiB: 12_288,
  memoryBudgetMiB: 10_752,
  taskTimeoutSeconds: 14_400,
  tasks: 1,
  parallelism: 1,
  maxRetries: 0,
  args: Object.freeze(["--max-old-space-size=12288", "dist/analytics-refresh.mjs", "--mode=full"]),
  env: ANALYTICS_REFRESH_PRODUCTION_ENV,
});
const KNOWN_FLAGS = new Set(["mode", "schema", "now", "revision-seed"]);
const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;
const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const DECIMAL = /^(?:0|[1-9]\d{0,9})$/u;
const MAX_REVISION_SEED = 2_000_000_000;
const SNAPSHOT_ID = /^[0-9A-F]+-[0-9A-F]+-[0-9]+$/u;
const BEGIN_STATEMENT = /^\s*(?:BEGIN|START\s+TRANSACTION)\b[^;]*;?\s*$/iu;
const END_STATEMENT = /^\s*(?:COMMIT|END|ROLLBACK|ABORT)(?:\s+(?:WORK|TRANSACTION))?\s*;?\s*$/iu;
const SAFE_CODE = /^ANALYTICS_V2_[A-Z0-9_]+$/u;
const SQL_STATE = /^[0-9A-Z]{5}$/u;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PRIVATE_SOCKET_DIRECTORY = /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u;
const POOL_MAX = 4;
const READ_STATEMENT_TIMEOUT_MILLISECONDS = 120_000;
const READ_LOCK_TIMEOUT_MILLISECONDS = 5_000;
const MILLISECONDS_PER_DAY = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const OWNER_DIGEST = /^[0-9a-f]{64}$/u;
const OCCURRENCE_STREAMS = Object.freeze(["usage", "quota", "session"]);
/** Days one run may queue for publication (store ANALYTICS_V2_OUTPUT_LIMITS.days). */
export const ANALYTICS_REFRESH_MAX_QUEUED_DAYS = 4_096;
/** Widest contiguous occurrence range one run reads (bounded full-history recompute). */
export const ANALYTICS_REFRESH_MAX_RANGE_DAYS = 4_096;
/** Journal events per readQueuedDays page, and the page bound of one run. */
const QUEUE_PAGE_EVENTS = 100_000;
const MAX_QUEUE_PAGES = 1_000;
/** A-1's per-call day bound when its module does not export one. */
const DEFAULT_OCCURRENCE_CHUNK_DAYS = 400;
const READ_SUMMARY_KEYS = Object.freeze(["unlinkedTypedOwners", "terminalOwners", "nonEffectiveUnread"]);
const MIB = 1_024 * 1_024;
const ENV_DECIMAL = /^(?:0|[1-9]\d{0,9})$/u;
// Cloud Run job names: a DNS label starting with a letter (CR-3's pattern).
const CLOUD_RUN_NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
// project:region:instance (CR-3's INSTANCE_CONNECTION_NAME_PATTERN).
const INSTANCE_CONNECTION_NAME =
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]:[a-z]+-[a-z]+[0-9]+:[a-z](?:[a-z0-9-]{0,96}[a-z0-9])?$/u;
// CR-3's DATABASE_PATTERN (cloud-sql.mjs DATABASE_PATTERN).
const DATABASE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
// A disposable rehearsal instance (postgres-production-migrations.mjs SCRATCH_INSTANCE_PATTERN).
const SCRATCH_INSTANCE = /-rehearsal-[a-z0-9]{8}b?$/u;
/** Tokens that mark a test or rehearsal resource; a production target refuses them. */
const TEST_TOKENS = Object.freeze(["test", "rehearsal", "fastpath"]);
/** Schema prefixes of the test and rehearsal estates (refused under a production target). */
const TEST_SCHEMA_PREFIXES = Object.freeze([
  ...FASTPATH_TEST_SCHEMA_PREFIXES,
  "typed_legacy_transfer_rehearsal_",
  "tibotattle_test_",
]);
/** Bounds of ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS (a test or local run's task timeout). */
const TASK_TIMEOUT_SECONDS = Object.freeze({ name: "ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS", minimum: 60,
  maximum: 604_800 });
/**
 * The Job's resource environment. The first three mirror resources.ts
 * ANALYTICS_V2_RESOURCE_BOUNDS (in MiB where named so); the spec pins the
 * equality. The read chunk is the Job's own: the occurrences one A-1 read
 * call targets, which bounds the reader's transient memory.
 */
export const ANALYTICS_REFRESH_RESOURCE_ENV = Object.freeze({
  memoryBudgetMiB: Object.freeze({ name: "ANALYTICS_V2_MEMORY_BUDGET_MIB", minimum: 1_024, maximum: 30_720,
    default: 4_608 }),
  maxDayOccurrences: Object.freeze({ name: "ANALYTICS_V2_MAX_DAY_OCCURRENCES", minimum: 20_000, maximum: 250_000,
    default: 250_000 }),
  maxDayRecordMiB: Object.freeze({ name: "ANALYTICS_V2_MAX_DAY_RECORD_MIB", minimum: 32, maximum: 256, default: 256 }),
  readChunkOccurrences: Object.freeze({ name: "ANALYTICS_V2_READ_CHUNK_OCCURRENCES", minimum: 10_000,
    maximum: 2_000_000, default: 250_000 }),
});
/**
 * The heap partition outside the per-owner budget:
 * - runtimeBytes: the bundled modules and kernels, the roster, every
 *   effective owner's evidence counts, the journal days, the device counts,
 *   the community fold (references into held rows) and one write chunk;
 * - bytesPerReadCandidate: the reader's transient per candidate of one read
 *   call (an estimate: decoded sources and reconciliation state of one
 *   expansion batch per candidate);
 * - the rest of the heap is the output budget, which A-2's output account
 *   charges every held output row and the non-effective owners' held
 *   occurrences against (resources.ts). It must be at least
 *   minimumOutputBudgetBytes. The run adds to it the part of the per-owner
 *   budget its largest admitted owner's estimate leaves.
 * The accumulated outputs are accounted, not covered by a fixed reserve: a
 * roster or history whose outputs outgrow the heap refuses the run
 * (ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED) before the heap is exhausted.
 */
export const ANALYTICS_REFRESH_HEAP_RESERVE = Object.freeze({ runtimeBytes: 256 * MIB, bytesPerReadCandidate: 4_096,
  minimumOutputBudgetBytes: 64 * MIB });
/** resources.ts ANALYTICS_V2_RESOURCE_BOUNDS.outputBudgetBytes.maximum (the spec pins the equality). */
const MAX_OUTPUT_BUDGET_BYTES = 30_720 * MIB;

/**
 * Measured phase rates (Node.js 22.16.0, local PostgreSQL 17, the dense-final
 * refresh of docs/receipts/2026-10-01-gcp-dense-owner-parity.md: 360,462
 * occurrences and about 294,000 analysis usage rows for owner e; read 134 s,
 * prepare 107.5 s, scalar 15.1 s, model 399.3 s, write under 1 s for about
 * 12 MB of rows), rounded down. The owner projection uses them as measured,
 * so a run is refused early only when even the local rates cannot finish;
 * a step about to start is projected at stepFactor times them (the test
 * deploy read Cloud SQL about 5x slower than locally), so no step starts that
 * could cross the refusal point. The write projection is deliberately
 * conservative: about 12 times the measured local rate, plus a fixed minute.
 */
export const ANALYTICS_REFRESH_TIME_MODEL = Object.freeze({
  readMsPerOccurrence: 0.37,
  prepareMsPerOccurrence: 0.29,
  scalarMsPerAnalysisUsage: 0.05,
  modelMsPerAnalysisUsage: 1.35,
  stepFactor: 5,
  writeFixedMs: 60_000,
  writeMsPerAccountMiB: 1_000,
  exitMarginMs: 120_000,
});
/** Mirrors occurrence-source.ts MAX_ANALYTICS_V2_CANDIDATES (one read call's ceiling); the spec pins it. */
export const ANALYTICS_REFRESH_MAX_READ_CANDIDATES = 2_000_000;

export const ANALYTICS_REFRESH_USAGE = `Usage: node analytics-refresh.mjs --mode=full [--schema=<identifier>]
       [--now=<ISO instant>] [--revision-seed=<n>]

Recompute every analytics_v2 output from the typed PostgreSQL sources and
write it in one transaction. Exits 0 (complete or LOCK_HELD), 2 (usage
refusal) or 1 (failure).

  --mode=full            full recompute (the only mode)
  --schema=<identifier>  runtime schema (default: PRIMARY_SCHEMA)
  --now=<ISO instant>    test clock only: requires ANALYTICS_V2_TEST_CLOCK=1
                         or POSTGRES_TEST_HTTP_MODE
  --revision-seed=<n>    first published revision is above n (default 0)
  --help                 print this text

Production and staging: ANALYTICS_REFRESH_TARGET=production|staging with
exactly PRIMARY_INSTANCE_CONNECTION_NAME, PRIMARY_DATABASE, PRIMARY_SCHEMA,
POSTGRES_IAM_USER and ANALYTICS_V2_MEMORY_BUDGET_MIB; no --schema, --now or
--revision-seed; run as node --max-old-space-size=12288 dist/analytics-refresh.mjs
--mode=full (the dense profile, 4 h task timeout).

Resources (environment, within bounds): ANALYTICS_V2_MEMORY_BUDGET_MIB (4608),
ANALYTICS_V2_MAX_DAY_OCCURRENCES (250000), ANALYTICS_V2_MAX_DAY_RECORD_MIB (256),
ANALYTICS_V2_READ_CHUNK_OCCURRENCES (250000), and, outside production,
ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS (none). The Node heap limit must cover
the budget, 256 MiB, 4 KiB per read-chunk occurrence and a 64 MiB output budget
(run the Job with --max-old-space-size=6144 for the defaults).
`;

function fail(code, extra = {}) {
  throw Object.assign(new Error(code), { code, ...extra });
}

function usageFail(code) {
  fail(code, { usage: true });
}

/** True only under an explicit test clock. */
export function analyticsRefreshTestClockAllowed(env) {
  return env?.ANALYTICS_V2_TEST_CLOCK === "1"
    || TEST_HTTP_MODES.has(env?.POSTGRES_TEST_HTTP_MODE);
}

function parseInstant(value) {
  const match = ISO_INSTANT.exec(value);
  if (!match) usageFail("ANALYTICS_V2_REFRESH_NOW_INVALID");
  const nowMs = Date.parse(value);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0
      || new Date(nowMs).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    usageFail("ANALYTICS_V2_REFRESH_NOW_INVALID");
  }
  return nowMs;
}

/**
 * Parse argv and the clock policy. Never touches the database: a refused
 * --now fails here, before any connection exists.
 */
export function parseAnalyticsRefreshArguments(argv, env = {}) {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== "string")) {
    usageFail("ANALYTICS_V2_REFRESH_ARGUMENT_INVALID");
  }
  if (argv.includes("--help") || argv.includes("-h")) return Object.freeze({ help: true });
  const flags = new Map();
  for (const argument of argv) {
    const match = FLAG.exec(argument);
    if (!match || !KNOWN_FLAGS.has(match[1]) || flags.has(match[1])) {
      usageFail("ANALYTICS_V2_REFRESH_ARGUMENT_INVALID");
    }
    flags.set(match[1], match[2]);
  }
  const mode = flags.get("mode");
  if (!ANALYTICS_REFRESH_MODES.includes(mode)) usageFail("ANALYTICS_V2_REFRESH_MODE_INVALID");
  // A production target's invocation is exactly --mode=full: its schema is
  // PRIMARY_SCHEMA, its clock is real and its revisions follow stored state.
  if (analyticsRefreshProductionTargetRequested(env)) {
    for (const name of ["schema", "now", "revision-seed"]) {
      if (flags.has(name)) fail("ANALYTICS_V2_REFRESH_ARGUMENT_FORBIDDEN", { usage: true, field: name });
    }
  }
  let nowMs = null;
  if (flags.has("now")) {
    if (!analyticsRefreshTestClockAllowed(env)) usageFail("ANALYTICS_V2_TEST_CLOCK_FORBIDDEN");
    nowMs = parseInstant(flags.get("now"));
  }
  const schema = flags.get("schema") ?? env.PRIMARY_SCHEMA;
  if (typeof schema !== "string" || !SCHEMA_IDENTIFIER.test(schema)
      || schema.startsWith("pg_") || schema === "information_schema") {
    usageFail("ANALYTICS_V2_REFRESH_SCHEMA_INVALID");
  }
  const seedText = flags.get("revision-seed") ?? "0";
  if (!DECIMAL.test(seedText) || Number(seedText) > MAX_REVISION_SEED) {
    usageFail("ANALYTICS_V2_REFRESH_REVISION_SEED_INVALID");
  }
  return Object.freeze({
    help: false,
    mode,
    schema,
    nowMs,
    revisionSeed: Number(seedText),
  });
}

/** True when the environment names a production target at all (even an invalid one). */
export function analyticsRefreshProductionTargetRequested(env) {
  return env !== null && typeof env === "object" && Object.hasOwn(env, "ANALYTICS_REFRESH_TARGET");
}

function tokensOf(value) {
  return value.toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length > 0);
}

function markerPattern(marker) {
  return new RegExp(`(?:^|[^a-z0-9])${marker}(?:[^a-z0-9]|$)`, "iu");
}

/**
 * Every resource identity of the IAM test deployment and the fast-path test
 * estate: a production target naming any of them is refused, whatever else it
 * says (CR-3's testTargetIdentities, plus the fast-path resources).
 */
function testTargetIdentities() {
  const iam = CLOUD_RUN_IAM_TEST_TARGET;
  const fastpath = FASTPATH_TEST_CLOUD_TARGET;
  return new Set([
    iam.service, iam.postgres.primary.instanceConnectionName, iam.postgres.ledger.instanceConnectionName,
    iam.postgres.primary.schema, iam.postgres.ledger.schema, iam.postgres.iamUser,
    `${iam.postgres.iamUser}.gserviceaccount.com`,
    fastpath.instanceConnectionName, fastpath.database, fastpath.primarySchema,
    fastpath.iamUser, `${fastpath.iamUser}.gserviceaccount.com`, fastpath.refreshJob, fastpath.originService,
  ]);
}
const TEST_TARGET_VALUES = testTargetIdentities();

/**
 * CR-3's production refusal policy (cloud-run/postgres-production-configuration.mjs):
 * the variables and prefixes it refuses in production, its plane markers and
 * the production resource fingerprint values (Cloudflare's production names).
 * CR-3 refuses the fingerprint on the staging plane only; this job refuses it
 * on both planes, which is stricter and refuses no GCP name the committed
 * desired states use. Mirrored, not imported: CR-3 imports Worker TypeScript
 * (so the source entry could not answer --help under plain Node 22) and is not
 * part of the audited image build context. The spec pins every value equal to
 * CR-3's exports. Which contract governs the production analytics job (this
 * one, or CR-3's unused analytics-job profiles) is an open integration
 * decision; until it is taken the equality pin is the guard against drift.
 */
export const ANALYTICS_REFRESH_CR3_POLICY = Object.freeze({
  forbiddenVariables: Object.freeze([
    "ACCESS_TEST_JWKS_JSON", "IDENTITY_TEST_JWKS_JSON", "POSTGRES_TEST_HTTP_MODE", "ADMIN_OWNER_FIXTURE_JSON",
    "ADMIN_OWNER_PREVIOUS_FIXTURE_JSON", "EDGE_PROOF_SECRET", "EDGE_PROOF_SHA256", "EDGE_CLIENT_KEY_SECRET",
    "EDGE_INVOKER_KEY_JSON", "DISTRIBUTION_ANALYTICS_API_TOKEN", "SPARKLE_APPCAST_GUARD_TOKEN",
    "LEDGER_INSTANCE_CONNECTION_NAME", "LEDGER_DATABASE", "LEDGER_SCHEMA", "GCS_ERASURE_BUCKET_HISTORY_PROOF",
  ]),
  forbiddenPrefixes: Object.freeze(["HOST_RATE_LIMIT_", "LEDGER_"]),
  stagingMarker: "staging",
  productionMarker: "production",
  fingerprint: Object.freeze([
    "https://tibotattle.com", "https://admin.tibotattle.com", "https://www.tibotattle.com",
    "tibotattle.com", "admin.tibotattle.com", "www.tibotattle.com",
    // Both identity-link labels: production-v2 (round 16's rotated label) and
    // the retired production-v1; a staging plane may carry neither.
    "3ffbc68d303a9da74f462a685b788c57935c65024df4e9b144e1c872598bb61c", "production-v2", "production-v1",
    "806510610397-f6k0uje651hpurbmfr7vub9iqj04428j.apps.googleusercontent.com", "com.usagemonitor.web", "L58X7J2J7A",
    "app-usagemonitor", "app-usagemonitor-production", "app-usagemonitor-production-deletion-ledger",
    "app-usagemonitor-production-quarantine", "tibotattle-updates",
  ]),
});
const PRODUCTION_POLICY = Object.freeze({
  forbiddenVariables: ANALYTICS_REFRESH_CR3_POLICY.forbiddenVariables,
  forbiddenPrefixes: ANALYTICS_REFRESH_CR3_POLICY.forbiddenPrefixes,
  fingerprint: new Set(ANALYTICS_REFRESH_CR3_POLICY.fingerprint),
  stagingMarker: markerPattern(ANALYTICS_REFRESH_CR3_POLICY.stagingMarker),
  productionMarker: markerPattern(ANALYTICS_REFRESH_CR3_POLICY.productionMarker),
});

function productionValue(env, name, pattern) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) fail("ANALYTICS_V2_REFRESH_ENV_MISSING", { field: name });
  if (!pattern.test(value)) fail("ANALYTICS_V2_REFRESH_ENV_INVALID", { field: name });
  return value;
}

/**
 * The reviewed production target path (C-REFRESH): read the closed
 * environment of a production or staging run, or return null when no
 * ANALYTICS_REFRESH_TARGET is set (the Job's test targets apply). Refuses,
 * with a closed code naming the setting and never its value:
 * - ANALYTICS_V2_REFRESH_TARGET_INVALID: a target other than production or staging;
 * - ANALYTICS_V2_TEST_CLOCK_FORBIDDEN: ANALYTICS_V2_TEST_CLOCK present (even empty);
 * - ANALYTICS_V2_REFRESH_ENV_FORBIDDEN: any CR-3 production-forbidden variable or
 *   prefix, GOOGLE_APPLICATION_CREDENTIALS, a refused Node runtime variable
 *   (ANALYTICS_REFRESH_RUNTIME_FORBIDDEN), or any other variable in the closed
 *   namespaces (ANALYTICS_REFRESH_CLOSED_PREFIXES);
 * - ANALYTICS_V2_REFRESH_CONTEXT_INVALID: not one task of a Cloud Run Job;
 * - ANALYTICS_V2_REFRESH_ENV_MISSING / _ENV_INVALID: a contract variable absent or malformed;
 * - ANALYTICS_V2_REFRESH_TEST_TARGET_FORBIDDEN: a test or rehearsal resource;
 * - ANALYTICS_V2_REFRESH_PLANE_MISMATCH: a resource carrying the other plane's marker.
 */
export async function readAnalyticsRefreshProductionTarget(env = {}) {
  if (env === null || typeof env !== "object") fail("ANALYTICS_V2_REFRESH_TARGET_INVALID");
  if (!analyticsRefreshProductionTargetRequested(env)) return null;
  const target = env.ANALYTICS_REFRESH_TARGET;
  if (!ANALYTICS_REFRESH_TARGETS.includes(target)) fail("ANALYTICS_V2_REFRESH_TARGET_INVALID");
  if (Object.hasOwn(env, "ANALYTICS_V2_TEST_CLOCK")) fail("ANALYTICS_V2_TEST_CLOCK_FORBIDDEN");
  const policy = PRODUCTION_POLICY;
  const names = Object.keys(env);
  for (const name of policy.forbiddenVariables) {
    if (Object.hasOwn(env, name)) fail("ANALYTICS_V2_REFRESH_ENV_FORBIDDEN", { field: name });
  }
  for (const prefix of policy.forbiddenPrefixes) {
    const name = names.find((candidate) => candidate.startsWith(prefix));
    if (name !== undefined) fail("ANALYTICS_V2_REFRESH_ENV_FORBIDDEN", { field: name });
  }
  if (Object.hasOwn(env, "GOOGLE_APPLICATION_CREDENTIALS")) {
    fail("ANALYTICS_V2_REFRESH_ENV_FORBIDDEN", { field: "GOOGLE_APPLICATION_CREDENTIALS" });
  }
  for (const name of ANALYTICS_REFRESH_RUNTIME_FORBIDDEN) {
    if (Object.hasOwn(env, name)) fail("ANALYTICS_V2_REFRESH_ENV_FORBIDDEN", { field: name });
  }
  for (const name of names.sort()) {
    if (ANALYTICS_REFRESH_CLOSED_PREFIXES.some((prefix) => name.startsWith(prefix))
        && !ANALYTICS_REFRESH_PRODUCTION_ENV.includes(name)) {
      fail("ANALYTICS_V2_REFRESH_ENV_FORBIDDEN", { field: name });
    }
  }
  const job = env.CLOUD_RUN_JOB;
  if (typeof job !== "string" || !CLOUD_RUN_NAME.test(job) || Object.hasOwn(env, "K_SERVICE")
      || env.CLOUD_RUN_TASK_INDEX !== "0" || env.CLOUD_RUN_TASK_COUNT !== "1") {
    fail("ANALYTICS_V2_REFRESH_CONTEXT_INVALID");
  }
  const instanceConnectionName = productionValue(env, "PRIMARY_INSTANCE_CONNECTION_NAME", INSTANCE_CONNECTION_NAME);
  const database = productionValue(env, "PRIMARY_DATABASE", DATABASE_IDENTIFIER);
  const schema = productionValue(env, "PRIMARY_SCHEMA", SCHEMA_IDENTIFIER);
  if (schema.startsWith("pg_") || schema === "information_schema") {
    fail("ANALYTICS_V2_REFRESH_ENV_INVALID", { field: "PRIMARY_SCHEMA" });
  }
  const rawIamUser = productionValue(env, "POSTGRES_IAM_USER", /^.{1,128}$/su);
  let iamUser;
  try {
    iamUser = normalizeIamUser(rawIamUser, "POSTGRES_IAM_USER");
  } catch {
    fail("ANALYTICS_V2_REFRESH_ENV_INVALID", { field: "POSTGRES_IAM_USER" });
  }
  productionValue(env, "ANALYTICS_V2_MEMORY_BUDGET_MIB", ENV_DECIMAL);
  // Test and rehearsal resources, by identity and by name.
  const settings = [["CLOUD_RUN_JOB", job], ["PRIMARY_INSTANCE_CONNECTION_NAME", instanceConnectionName],
    ["PRIMARY_DATABASE", database], ["PRIMARY_SCHEMA", schema], ["POSTGRES_IAM_USER", rawIamUser],
    ["POSTGRES_IAM_USER", iamUser]];
  for (const [name, value] of settings) {
    if (TEST_TARGET_VALUES.has(value) || policy.fingerprint.has(value)
        || (name !== "POSTGRES_IAM_USER" && tokensOf(value).some((token) => TEST_TOKENS.includes(token)))) {
      fail("ANALYTICS_V2_REFRESH_TEST_TARGET_FORBIDDEN", { field: name });
    }
  }
  const instance = instanceConnectionName.split(":")[2];
  if (SCRATCH_INSTANCE.test(instance)) fail("ANALYTICS_V2_REFRESH_TEST_TARGET_FORBIDDEN",
    { field: "PRIMARY_INSTANCE_CONNECTION_NAME" });
  if (TEST_SCHEMA_PREFIXES.some((prefix) => schema.startsWith(prefix))) {
    fail("ANALYTICS_V2_REFRESH_TEST_TARGET_FORBIDDEN", { field: "PRIMARY_SCHEMA" });
  }
  // CR-3's plane markers on the plane-identifying names.
  for (const [name, value] of [["CLOUD_RUN_JOB", job], ["PRIMARY_INSTANCE_CONNECTION_NAME", instanceConnectionName]]) {
    if (target === "staging" ? !policy.stagingMarker.test(value) || policy.productionMarker.test(value)
      : policy.stagingMarker.test(value)) {
      fail("ANALYTICS_V2_REFRESH_PLANE_MISMATCH", { field: name });
    }
  }
  return Object.freeze({
    target,
    job,
    instanceConnectionName,
    database,
    schema,
    iamUser,
    taskTimeoutSeconds: ANALYTICS_REFRESH_PRODUCTION_JOB.taskTimeoutSeconds,
  });
}

/**
 * The task timeout the time guard enforces, in milliseconds, or null: a
 * production target's profile timeout; otherwise
 * ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS when set (within its bounds).
 */
export function analyticsRefreshTaskTimeoutMs(env, productionTarget) {
  if (productionTarget !== null && productionTarget !== undefined) return productionTarget.taskTimeoutSeconds * 1_000;
  const text = env?.[TASK_TIMEOUT_SECONDS.name];
  if (text === undefined || text === "") return null;
  if (typeof text !== "string" || !ENV_DECIMAL.test(text)) {
    fail("ANALYTICS_V2_REFRESH_RESOURCES_INVALID", { field: TASK_TIMEOUT_SECONDS.name });
  }
  const seconds = Number(text);
  if (seconds < TASK_TIMEOUT_SECONDS.minimum || seconds > TASK_TIMEOUT_SECONDS.maximum) {
    fail("ANALYTICS_V2_REFRESH_RESOURCES_INVALID", { field: TASK_TIMEOUT_SECONDS.name });
  }
  return seconds * 1_000;
}

function resourceValue(env, entry) {
  const text = env?.[entry.name];
  if (text === undefined || text === "") return entry.default;
  if (typeof text !== "string" || !ENV_DECIMAL.test(text)) {
    fail("ANALYTICS_V2_REFRESH_RESOURCES_INVALID", { field: entry.name });
  }
  const value = Number(text);
  if (value < entry.minimum || value > entry.maximum) {
    fail("ANALYTICS_V2_REFRESH_RESOURCES_INVALID", { field: entry.name });
  }
  return value;
}

/**
 * The run's resources from the environment, and the heap partition they
 * imply. Refused before any connection: a value outside its bounds
 * (ANALYTICS_V2_REFRESH_RESOURCES_INVALID), or a heap limit that leaves less
 * than the minimum output budget after the per-owner budget, the read
 * reserve and the runtime reserve (ANALYTICS_V2_REFRESH_HEAP_INSUFFICIENT).
 * The rest of the heap is the output budget (compute.outputBudgetBytes), so
 * the whole run is bounded: one admitted owner's estimate, the accounted
 * outputs and held inputs, and the reserves.
 */
export function analyticsRefreshResources(env, heapLimitBytes) {
  const spec = ANALYTICS_REFRESH_RESOURCE_ENV;
  const reserve = ANALYTICS_REFRESH_HEAP_RESERVE;
  const memoryBudgetBytes = resourceValue(env, spec.memoryBudgetMiB) * MIB;
  const maxDayOccurrences = resourceValue(env, spec.maxDayOccurrences);
  const maxDayRecordBytes = resourceValue(env, spec.maxDayRecordMiB) * MIB;
  const readChunkOccurrences = resourceValue(env, spec.readChunkOccurrences);
  const reservedBytes = memoryBudgetBytes + reserve.runtimeBytes + readChunkOccurrences * reserve.bytesPerReadCandidate;
  const requiredHeapBytes = reservedBytes + reserve.minimumOutputBudgetBytes;
  if (!Number.isSafeInteger(heapLimitBytes) || heapLimitBytes < requiredHeapBytes) {
    fail("ANALYTICS_V2_REFRESH_HEAP_INSUFFICIENT");
  }
  const outputBudgetBytes = Math.min(heapLimitBytes - reservedBytes, MAX_OUTPUT_BUDGET_BYTES);
  return Object.freeze({
    compute: Object.freeze({ memoryBudgetBytes, maxDayOccurrences, maxDayRecordBytes, outputBudgetBytes }),
    readChunkOccurrences,
    heapLimitBytes,
    requiredHeapBytes,
  });
}

async function privateSocketDirectory(directory) {
  if (!PRIVATE_SOCKET_DIRECTORY.test(directory)) fail("ANALYTICS_V2_REFRESH_DATABASE_INVALID");
  let link;
  let real;
  let metadata;
  try {
    link = await lstat(directory);
    real = await realpath(directory);
    metadata = await stat(real);
  } catch {
    fail("ANALYTICS_V2_REFRESH_DATABASE_INVALID");
  }
  if (link.isSymbolicLink() || !metadata.isDirectory()
      || !real.startsWith("/private/tmp/tibotattle-pg-")
      || (metadata.mode & 0o077) !== 0
      || metadata.uid !== process.getuid?.()) {
    fail("ANALYTICS_V2_REFRESH_DATABASE_INVALID");
  }
  return real;
}

/**
 * The database target. Under a production target
 * (readAnalyticsRefreshProductionTarget), its configured Cloud SQL instance,
 * database and IAM user; the schema must be its PRIMARY_SCHEMA. Without one,
 * a Cloud Run Job may reach only the private test primary: the shared test
 * database, or, for the fast-path refresh Job alone, the disposable fast-path
 * database and only a pinned or seeded fast-path schema (`schema`, the parsed
 * --schema). Anywhere else only a loopback or private-socket PostgreSQL is
 * accepted.
 */
export async function resolveAnalyticsRefreshDatabase(env = {}, { schema } = {}) {
  const production = await readAnalyticsRefreshProductionTarget(env);
  if (production !== null) {
    if (schema !== production.schema) fail("ANALYTICS_V2_REFRESH_TARGET_FORBIDDEN");
    return Object.freeze({
      kind: "cloud-sql",
      target: production.target,
      instanceConnectionName: production.instanceConnectionName,
      database: production.database,
      iamUser: production.iamUser,
    });
  }
  if (typeof env.CLOUD_RUN_JOB === "string" && env.CLOUD_RUN_JOB.length > 0) {
    if (env.K_SERVICE !== undefined) fail("ANALYTICS_V2_REFRESH_CONTEXT_INVALID");
    const fastpath = env.CLOUD_RUN_JOB === FASTPATH_TEST_CLOUD_TARGET.refreshJob;
    const target = fastpath
      ? { instanceConnectionName: FASTPATH_TEST_CLOUD_TARGET.instanceConnectionName,
        database: FASTPATH_TEST_CLOUD_TARGET.database }
      : CLOUD_RUN_IAM_TEST_TARGET.postgres.primary;
    if (env.PRIMARY_INSTANCE_CONNECTION_NAME !== target.instanceConnectionName
        || env.PRIMARY_DATABASE !== target.database) {
      fail("ANALYTICS_V2_REFRESH_TARGET_FORBIDDEN");
    }
    if (fastpath && !(isFastpathTestSchema(schema) && (schema === FASTPATH_TEST_CLOUD_TARGET.primarySchema
        || schema.startsWith(FASTPATH_TEST_CLOUD_TARGET.seededSchemaPrefix)))) {
      fail("ANALYTICS_V2_REFRESH_TARGET_FORBIDDEN");
    }
    let iamUser;
    try {
      iamUser = normalizeIamUser(env.POSTGRES_IAM_USER, "POSTGRES_IAM_USER");
    } catch {
      fail("ANALYTICS_V2_REFRESH_TARGET_FORBIDDEN");
    }
    if (iamUser !== CLOUD_RUN_IAM_TEST_TARGET.postgres.iamUser) {
      fail("ANALYTICS_V2_REFRESH_TARGET_FORBIDDEN");
    }
    return Object.freeze({
      kind: "cloud-sql",
      instanceConnectionName: target.instanceConnectionName,
      database: target.database,
      iamUser,
    });
  }
  const socket = env.PG_TEST_SOCKET || undefined;
  const host = env.PG_TEST_HOST || undefined;
  if (socket === undefined && host === undefined) fail("ANALYTICS_V2_REFRESH_DATABASE_UNCONFIGURED");
  const port = Number(env.PG_TEST_PORT ?? "55432");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) fail("ANALYTICS_V2_REFRESH_DATABASE_INVALID");
  let target;
  if (socket !== undefined) {
    target = await privateSocketDirectory(socket);
  } else if (LOOPBACK_HOSTS.has(host)) {
    target = host;
  } else {
    target = await privateSocketDirectory(host);
  }
  return Object.freeze({
    kind: "local",
    host: target,
    port,
    user: env.PG_TEST_USER || "postgres",
    database: env.PG_TEST_DATABASE || "postgres",
    ...(env.PG_TEST_PASSWORD ? { password: env.PG_TEST_PASSWORD } : {}),
  });
}

async function defaultCreatePool(database, { connector }) {
  if (database.kind === "cloud-sql") {
    return createCloudSqlIamPool({
      connector,
      instanceConnectionName: database.instanceConnectionName,
      database: database.database,
      user: database.iamUser,
      max: POOL_MAX,
      applicationName: "tibotattle-analytics-refresh",
    });
  }
  const pool = new pg.Pool({
    host: database.host,
    port: database.port,
    user: database.user,
    database: database.database,
    ...(database.password === undefined ? {} : { password: database.password }),
    max: POOL_MAX,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: "tibotattle-analytics-refresh",
  });
  pool.on("error", () => {});
  return pool;
}

/**
 * A PostgresPool whose every transaction reads the one exported snapshot.
 * A reader's BEGIN (any isolation or access mode) becomes
 * BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY + SET TRANSACTION SNAPSHOT,
 * so all A-1 reads see exactly the state the run's cursor was read in, and
 * any write throws. A statement outside a transaction runs in its own
 * snapshot transaction. The exporting transaction must stay open until the
 * last read finishes. close() discards any client a reader failed to release
 * (so pool shutdown cannot hang) and refuses later connects.
 */
export function createSnapshotReadPool(pool, snapshotId) {
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function"
      || typeof snapshotId !== "string" || !SNAPSHOT_ID.test(snapshotId)) {
    fail("ANALYTICS_V2_REFRESH_SNAPSHOT_INVALID");
  }
  const beginSnapshot = async (client, state) => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    state.open = true;
    await client.query(`SET TRANSACTION SNAPSHOT '${snapshotId}'`);
  };
  const outstanding = new Set();
  let closed = false;
  return Object.freeze({
    async connect() {
      if (closed) fail("ANALYTICS_V2_REFRESH_SNAPSHOT_CLOSED");
      const client = await pool.connect();
      const state = { open: false, released: false };
      const wrapper = Object.freeze({
        async query(text, values) {
          if (state.released) fail("ANALYTICS_V2_REFRESH_SNAPSHOT_CLIENT_RELEASED");
          if (typeof text !== "string") fail("ANALYTICS_V2_REFRESH_SNAPSHOT_STATEMENT_UNSUPPORTED");
          if (BEGIN_STATEMENT.test(text)) {
            if (state.open) fail("ANALYTICS_V2_REFRESH_SNAPSHOT_NESTED_TRANSACTION");
            await beginSnapshot(client, state);
            return { rows: [], rowCount: null };
          }
          if (END_STATEMENT.test(text)) {
            state.open = false;
            return client.query(text);
          }
          if (state.open) return client.query(text, values);
          await beginSnapshot(client, state);
          try {
            const result = await client.query(text, values);
            await client.query("COMMIT");
            state.open = false;
            return result;
          } catch (error) {
            try {
              await client.query("ROLLBACK");
              state.open = false;
            } catch {
              // release() discards the connection while state.open remains true.
            }
            throw error;
          }
        },
        async release(discard = false) {
          if (state.released) return;
          state.released = true;
          outstanding.delete(wrapper);
          let drop = discard === true;
          if (state.open) {
            try {
              await client.query("ROLLBACK");
            } catch {
              drop = true;
            }
            state.open = false;
          }
          await client.release(drop);
        },
      });
      outstanding.add(wrapper);
      return wrapper;
    },
    async close() {
      closed = true;
      const leaked = [...outstanding];
      for (const wrapper of leaked) {
        try { await wrapper.release(true); } catch { /* the pool is closed by the caller */ }
      }
      return leaked.length;
    },
  });
}

function utcDay(epochMs) {
  return new Date(Math.floor(epochMs / MILLISECONDS_PER_DAY) * MILLISECONDS_PER_DAY)
    .toISOString().slice(0, 10);
}

function addDays(day, delta) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * MILLISECONDS_PER_DAY)
    .toISOString().slice(0, 10);
}

function isDay(value) {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

function daySpan(fromDay, throughDay) {
  return Math.round((Date.parse(`${throughDay}T00:00:00.000Z`) - Date.parse(`${fromDay}T00:00:00.000Z`))
    / MILLISECONDS_PER_DAY) + 1;
}

/**
 * The days a full run publishes (production's queue): the days named by
 * journal events after the cursor plus the days the last run left blocked (a
 * blocked day is not consumed). Published heads that are neither are never
 * recomputed.
 */
export function analyticsRefreshPublicationDays(journalDays, state) {
  return [...new Set([...journalDays, ...state.carriedBlockedDays])].sort();
}

/**
 * First day that gets cache-band rows. Production builds a cache-retention
 * day for every delivered day (d43c8f92 cache-retention-day-worker.ts:
 * CACHE_RETENTION_FROM_DAY is unset in every deployment, which "means every
 * delivered day"), and its `all` window has no lower bound. So the horizon
 * has no fixed lower bound either: it reaches back to the first evidence day
 * of any effective owner (A-1 readOwnerFirstEvidenceDay over the whole day
 * domain), the earliest stored cache-band day and the earliest queued day,
 * and never starts later than the analysis horizon
 * [today-(analysisDays-1), today]. Every stored cache day is recomputed
 * exactly (with its 7-day carry) instead of being dropped.
 */
export function analyticsRefreshCacheFromDay({
  today, analysisDays, queuedDays, cacheFloorDay, firstEvidenceDay = null,
}) {
  let fromDay = addDays(today, -(analysisDays - 1));
  for (const day of queuedDays) if (day < fromDay) fromDay = day;
  if (cacheFloorDay !== null && cacheFloorDay < fromDay) fromDay = cacheFloorDay;
  if (firstEvidenceDay !== null && firstEvidenceDay < fromDay) fromDay = firstEvidenceDay;
  return fromDay;
}

/**
 * Contiguous runs of `days`, each split into ranges of at most `chunkDays`
 * days (A-1 reads at most that many days per call).
 */
export function analyticsRefreshDaySpans(days, chunkDays) {
  const spans = [];
  for (const day of [...new Set(days)].sort()) {
    const last = spans.at(-1);
    if (last !== undefined && addDays(last.throughDay, 1) === day
        && daySpan(last.fromDay, day) <= chunkDays) {
      last.throughDay = day;
    } else {
      spans.push({ fromDay: day, throughDay: day });
    }
  }
  return spans.map((span) => Object.freeze(span));
}

/** One inclusive range split into consecutive ranges of at most `chunkDays` days. */
export function analyticsRefreshRangeChunks(range, chunkDays) {
  const chunks = [];
  for (let fromDay = range.fromDay; fromDay <= range.throughDay; fromDay = addDays(fromDay, chunkDays)) {
    const end = addDays(fromDay, chunkDays - 1);
    chunks.push(Object.freeze({ fromDay, throughDay: end < range.throughDay ? end : range.throughDay }));
  }
  return chunks;
}

/**
 * Contiguous read spans covering `range`, for one owner and stream: each at
 * most `chunkDays` days and, where the exact per-day counts allow, at most
 * `maxOccurrences` occurrences; a single day larger than that is a span of
 * its own (A-1 never splits a day). Without counts the spans are
 * analyticsRefreshRangeChunks(range, chunkDays).
 */
export function analyticsRefreshReadSpans(range, chunkDays, dayCounts, maxOccurrences) {
  const spans = [];
  let current = null;
  for (let day = range.fromDay; day <= range.throughDay; day = addDays(day, 1)) {
    const count = dayCounts.get(day) ?? 0;
    if (current !== null && daySpan(current.fromDay, day) <= chunkDays
        && current.occurrences + count <= maxOccurrences) {
      current.throughDay = day;
      current.occurrences += count;
    } else {
      if (current !== null) spans.push(Object.freeze(current));
      current = { fromDay: day, throughDay: day, occurrences: count };
    }
  }
  if (current !== null) spans.push(Object.freeze(current));
  return spans;
}

function requireFunction(module, name) {
  const value = module?.[name];
  if (typeof value !== "function") fail("ANALYTICS_V2_REFRESH_PIPELINE_UNAVAILABLE", { missing: name });
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail("ANALYTICS_V2_REFRESH_PIPELINE_UNAVAILABLE", { missing: name });
  return value;
}

function sequenceNumber(value) {
  if (value === null || value === undefined) return null;
  const number = typeof value === "string" && /^(?:0|[1-9]\d{0,15})$/u.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    fail("ANALYTICS_V2_REFRESH_JOURNAL_INVALID");
  }
  return number;
}

function hasTypedEvidence(owner) {
  return owner.hasV1 === true || owner.hasV11 === true || owner.hasV12 === true;
}

/** Heap bytes in use: sampled into each owner's heapPeakBytes (operational metadata only). */
function defaultMemoryProbe() {
  return process.memoryUsage().heapUsed;
}

/** A-1's closed, content-free source failure (owners.ts AnalyticsV2SourceError). */
function isSourceError(error) {
  return typeof error?.code === "string" && /^ANALYTICS_V2_SOURCE_[A-Z_]+$/u.test(error.code);
}

function compareOwners(left, right) {
  return left.ownerDigest < right.ownerDigest ? -1 : left.ownerDigest > right.ownerDigest ? 1 : 0;
}

/**
 * The default wiring of the A-1 readers and the A-2 compute core. It adapts
 * the shapes the two packages landed with:
 *
 * - listAnalyticsV2Owners(context) -> {owners, unlinked, correctionRuntimeActive};
 * - readQueuedDays(context, {afterSequence, limit}) -> one journal page, read
 *   until complete;
 * - readOwnerOccurrences(context, {ownerDigest, stream, fromDay, throughDay,
 *   maxCandidates}) -> Map(day -> occurrences), at most
 *   MAX_ANALYTICS_V2_OCCURRENCE_DAYS a call;
 * - countOwnerOccurrences(context, {ownerDigest, stream, fromDay, throughDay})
 *   -> Map(day -> the exact count readOwnerOccurrences returns), same bound;
 * - readOwnerFirstEvidenceDay(context, {ownerDigest, throughDay}) -> the
 *   owner's first evidence day or null (the cache horizon's lower end);
 * - countContributingDevices(context, {days: Map(day -> effective owners)});
 * - computeAnalyticsV2({..., occurrenceRange, cacheFromDay,
 *   loadOwnerOccurrences, ownerEvidence, resources}) over ONE contiguous range
 *   that covers analyticsV2RequiredOccurrenceRange.
 *
 * Effective owners are counted over the whole range during read and loaded,
 * one at a time and one A-2 segment at a time, during compute: every stream
 * of the requested segment (the whole range when A-2 names none) in
 * contiguous spans of at most MAX_ANALYTICS_V2_OCCURRENCE_DAYS days and, by
 * the counts, about the read chunk of occurrences. A-2 skips the load of an owner its memory guard
 * refuses and refuses a load that differs from the counts. A non-effective owner with
 * typed evidence is a member of production's daily cohort: it is read over
 * the queued days only, so A-2 blocks exactly the queued days it has evidence
 * on (a closed A-1 source refusal leaves it unread, and A-2 then blocks every
 * queued day, never fewer). An eligible typed owner without an active owner
 * link makes production's daily lane unavailable (d43c8f92
 * storage-community-daily.ts cohort()): every queued day is blocked and
 * carried. Legacy-only (v0.2) owners are not daily-cohort members and are not
 * read.
 */
export function createAnalyticsV2Pipeline({ owners, occurrences, devices, queuedDays, compute }) {
  const listOwners = requireFunction(owners, "listAnalyticsV2Owners");
  const readQueued = requireFunction(queuedDays, "readQueuedDays");
  const readOccurrences = requireFunction(occurrences, "readOwnerOccurrences");
  const countOccurrences = requireFunction(occurrences, "countOwnerOccurrences");
  const readFirstEvidenceDay = requireFunction(occurrences, "readOwnerFirstEvidenceDay");
  const countDevices = requireFunction(devices, "countContributingDevices");
  const computeOutputs = requireFunction(compute, "computeAnalyticsV2");
  const requiredRange = requireFunction(compute, "analyticsV2RequiredOccurrenceRange");
  const analysisDays = requirePositiveInteger(compute?.ANALYTICS_V2_ANALYSIS_DAYS, "ANALYTICS_V2_ANALYSIS_DAYS");
  const chunkDays = requirePositiveInteger(
    occurrences?.MAX_ANALYTICS_V2_OCCURRENCE_DAYS ?? DEFAULT_OCCURRENCE_CHUNK_DAYS,
    "MAX_ANALYTICS_V2_OCCURRENCE_DAYS",
  );

  async function readJournal(context, cursor) {
    let afterSequence = cursor === null ? 0 : sequenceNumber(cursor);
    const days = new Set();
    const terminalOwners = new Set();
    for (let page = 0; page < MAX_QUEUE_PAGES; page += 1) {
      const result = await readQueued(context, { afterSequence, limit: QUEUE_PAGE_EVENTS });
      if (result === null || typeof result !== "object" || !Array.isArray(result.days)
          || !result.days.every(isDay) || !Array.isArray(result.terminalOwners)
          || !result.terminalOwners.every((owner) => typeof owner === "string" && OWNER_DIGEST.test(owner))
          || typeof result.complete !== "boolean") {
        fail("ANALYTICS_V2_REFRESH_JOURNAL_INVALID");
      }
      const lastSequence = sequenceNumber(result.lastSequence);
      if (lastSequence === null || lastSequence < afterSequence) fail("ANALYTICS_V2_REFRESH_JOURNAL_INVALID");
      for (const day of result.days) days.add(day);
      for (const owner of result.terminalOwners) terminalOwners.add(owner);
      if (days.size > ANALYTICS_REFRESH_MAX_QUEUED_DAYS) fail("ANALYTICS_V2_REFRESH_QUEUE_CAPACITY_EXCEEDED");
      if (result.complete) {
        return { days: [...days].sort(), lastSequence, terminalOwners: terminalOwners.size };
      }
      // An incomplete page must advance, or the loop could never end.
      if (lastSequence === afterSequence) fail("ANALYTICS_V2_REFRESH_JOURNAL_INVALID");
      afterSequence = lastSequence;
    }
    return fail("ANALYTICS_V2_REFRESH_QUEUE_CAPACITY_EXCEEDED");
  }

  /** `rangesOf(stream)` -> the ranges to read; a range may carry a candidate bound. */
  async function readOwnerDays(context, ownerDigest, rangesOf) {
    const byDay = new Map();
    for (const stream of OCCURRENCE_STREAMS) {
      for (const range of rangesOf(stream)) {
        const result = await readOccurrences(context, {
          ownerDigest,
          stream,
          fromDay: range.fromDay,
          throughDay: range.throughDay,
          ...(range.maxCandidates === undefined ? {} : { maxCandidates: range.maxCandidates }),
        });
        if (!(result instanceof Map)) fail("ANALYTICS_V2_REFRESH_OCCURRENCES_INVALID");
        for (const [day, list] of result) {
          if (!isDay(day) || day < range.fromDay || day > range.throughDay || !Array.isArray(list)) {
            fail("ANALYTICS_V2_REFRESH_OCCURRENCES_INVALID");
          }
          const entry = byDay.get(day) ?? { usage: [], quota: [], session: [] };
          entry[stream] = list;
          byDay.set(day, entry);
        }
      }
    }
    return byDay;
  }

  /** One effective owner's exact counts per stream and day over `chunks` (A-1's own candidate selection). */
  async function countOwnerEvidence(context, ownerDigest, chunks) {
    const byStream = {};
    const evidence = new Map();
    for (const stream of OCCURRENCE_STREAMS) {
      const counts = new Map();
      for (const chunk of chunks) {
        const result = await countOccurrences(context, { ownerDigest, stream, fromDay: chunk.fromDay,
          throughDay: chunk.throughDay });
        if (!(result instanceof Map)) fail("ANALYTICS_V2_REFRESH_OCCURRENCES_INVALID");
        for (const [day, count] of result) {
          if (!isDay(day) || day < chunk.fromDay || day > chunk.throughDay || counts.has(day)
              || !Number.isSafeInteger(count) || count < 1) {
            fail("ANALYTICS_V2_REFRESH_OCCURRENCES_INVALID");
          }
          counts.set(day, count);
          const entry = evidence.get(day) ?? { usage: 0, quota: 0, session: 0 };
          entry[stream] = count;
          evidence.set(day, entry);
        }
      }
      byStream[stream] = counts;
    }
    for (const [day, entry] of evidence) evidence.set(day, Object.freeze(entry));
    return { byStream, evidence };
  }

  return Object.freeze({
    async read({ pool, schema, nowMs, state, resources, checkpoint = () => {} }) {
      const context = Object.freeze({ pool, schema, nowMs });
      const readChunk = resources?.readChunkOccurrences
        ?? ANALYTICS_REFRESH_RESOURCE_ENV.readChunkOccurrences.default;
      if (!Number.isSafeInteger(readChunk) || readChunk < 1 || readChunk > ANALYTICS_REFRESH_MAX_READ_CANDIDATES) {
        fail("ANALYTICS_V2_REFRESH_RESOURCES_INVALID");
      }
      const listing = await listOwners(context);
      if (listing === null || typeof listing !== "object" || Array.isArray(listing)
          || !Array.isArray(listing.owners) || !Array.isArray(listing.unlinked)
          || !listing.owners.every((owner) => owner !== null && typeof owner === "object"
            && typeof owner.ownerDigest === "string" && OWNER_DIGEST.test(owner.ownerDigest))
          || !listing.unlinked.every((owner) => owner !== null && typeof owner === "object")) {
        fail("ANALYTICS_V2_REFRESH_OWNERS_INVALID");
      }
      const journal = await readJournal(context, state.cursor);
      const days = analyticsRefreshPublicationDays(journal.days, state);
      if (days.length > ANALYTICS_REFRESH_MAX_QUEUED_DAYS) fail("ANALYTICS_V2_REFRESH_QUEUE_CAPACITY_EXCEEDED");
      const today = utcDay(nowMs);
      const ownerList = [...listing.owners].sort(compareOwners);
      // Production has no lower bound on cache history: start at the first
      // evidence day of any effective owner, whatever the queue holds.
      let firstEvidenceDay = null;
      for (const owner of ownerList) {
        if (owner.source !== "effective") continue;
        checkpoint(Object.freeze({ kind: "read" }));
        const first = await readFirstEvidenceDay(context, { ownerDigest: owner.ownerDigest, throughDay: today });
        if (first === null) continue;
        if (!isDay(first) || first > today) fail("ANALYTICS_V2_REFRESH_OCCURRENCES_INVALID");
        if (firstEvidenceDay === null || first < firstEvidenceDay) firstEvidenceDay = first;
      }
      const cacheFromDay = analyticsRefreshCacheFromDay({
        today,
        analysisDays,
        queuedDays: days,
        cacheFloorDay: state.cacheFloorDay ?? null,
        firstEvidenceDay,
      });
      const range = await requiredRange({ nowMs, queuedDays: days, cacheFromDay });
      if (range === null || typeof range !== "object" || !isDay(range.fromDay) || !isDay(range.throughDay)
          || range.fromDay > range.throughDay) {
        fail("ANALYTICS_V2_REFRESH_RANGE_INVALID");
      }
      if (daySpan(range.fromDay, range.throughDay) > ANALYTICS_REFRESH_MAX_RANGE_DAYS) {
        fail("ANALYTICS_V2_REFRESH_RANGE_EXCEEDED");
      }
      const occurrenceRange = Object.freeze({ fromDay: range.fromDay, throughDay: range.throughDay });
      const fullRange = analyticsRefreshRangeChunks(occurrenceRange, chunkDays);
      const queuedSpans = analyticsRefreshDaySpans(days, chunkDays);

      // Effective owners: exact counts only. Their occurrences are read one
      // owner at a time during compute, after the memory guard.
      const ownerEvidence = new Map();
      const streamCounts = new Map();
      const occurrencesByOwner = new Map();
      let nonEffectiveUnread = 0;
      for (const owner of ownerList) {
        checkpoint(Object.freeze({ kind: "read" }));
        if (owner.source === "effective") {
          const counted = await countOwnerEvidence(context, owner.ownerDigest, fullRange);
          ownerEvidence.set(owner.ownerDigest, counted.evidence);
          streamCounts.set(owner.ownerDigest, counted.byStream);
        } else if (hasTypedEvidence(owner)) {
          try {
            occurrencesByOwner.set(owner.ownerDigest, await readOwnerDays(context, owner.ownerDigest, () => queuedSpans));
          } catch (error) {
            // Fail closed for publication only: unread, A-2 blocks every queued day.
            if (!isSourceError(error)) throw error;
            nonEffectiveUnread += 1;
          }
        }
      }

      const contributing = new Map(days.map((day) => [day, ownerList
        .filter((owner) => owner.source === "effective" && ownerEvidence.get(owner.ownerDigest).has(day))
        .map((owner) => ({ participantId: owner.participantId, ownerDigest: owner.ownerDigest, source: owner.source }))]));
      const devicesByDay = await countDevices(context, { days: contributing });
      if (!(devicesByDay instanceof Map)) fail("ANALYTICS_V2_REFRESH_DEVICES_INVALID");

      // One effective owner's occurrences over one A-2 segment (the whole
      // range when none is named), in spans of about the read chunk by its
      // exact counts. Called by A-2 only while the run's read snapshot is open
      // (runAnalyticsRefresh closes it after compute).
      const loadOwnerOccurrences = async (ownerDigest, segment = occurrenceRange) => {
        const counts = streamCounts.get(ownerDigest);
        if (counts === undefined) fail("ANALYTICS_V2_REFRESH_OCCURRENCES_INVALID");
        if (segment === null || typeof segment !== "object" || !isDay(segment.fromDay) || !isDay(segment.throughDay)
            || segment.fromDay > segment.throughDay || segment.fromDay < occurrenceRange.fromDay
            || segment.throughDay > occurrenceRange.throughDay) {
          fail("ANALYTICS_V2_REFRESH_RANGE_INVALID");
        }
        const bounded = Object.freeze({ fromDay: segment.fromDay, throughDay: segment.throughDay });
        return readOwnerDays(context, ownerDigest, (stream) =>
          analyticsRefreshReadSpans(bounded, chunkDays, counts[stream], readChunk).map((span) => ({
            fromDay: span.fromDay,
            throughDay: span.throughDay,
            maxCandidates: Math.min(ANALYTICS_REFRESH_MAX_READ_CANDIDATES, Math.max(readChunk, span.occurrences)),
          })));
      };

      return {
        owners: listing.owners,
        unlinkedTypedOwners: listing.unlinked.filter(hasTypedEvidence).length,
        occurrencesByOwner,
        ownerEvidence,
        loadOwnerOccurrences,
        occurrenceRange,
        cacheFromDay,
        devicesByDay,
        queuedDays: days,
        firstEvidenceDay,
        lastSequence: journal.lastSequence,
        terminalOwners: journal.terminalOwners,
        nonEffectiveUnread,
        ...(resources?.compute === undefined ? {} : { resources: resources.compute }),
      };
    },
    async compute(inputs, { nowMs, revisionSeed, memoryProbe = defaultMemoryProbe, checkpoint }) {
      const outputs = await computeOutputs({
        owners: inputs.owners,
        occurrencesByOwner: inputs.occurrencesByOwner,
        occurrenceRange: inputs.occurrenceRange,
        cacheFromDay: inputs.cacheFromDay,
        devicesByDay: inputs.devicesByDay,
        queuedDays: inputs.queuedDays,
        nowMs,
        revisionSeed,
        loadOwnerOccurrences: inputs.loadOwnerOccurrences,
        ownerEvidence: inputs.ownerEvidence,
        // The Job's resources partition one heap (analyticsRefreshResources),
        // so the run may reclaim the per-owner budget its largest owner leaves.
        ...(inputs.resources === undefined ? {} : { resources: inputs.resources, reclaimUnusedOwnerBudget: true }),
        memoryProbe,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      });
      if (outputs === null || typeof outputs !== "object" || !Array.isArray(outputs.dailyCandidates)
          || !Array.isArray(outputs.blockedDays)) {
        fail("ANALYTICS_V2_REFRESH_OUTPUTS_INVALID");
      }
      let publication = {};
      if (inputs.unlinkedTypedOwners > 0) {
        // Production's daily cohort is unavailable while an eligible typed
        // owner has no owner link: nothing publishes, every queued day is
        // carried, and each keeps its prior row.
        publication = {
          dailyCandidates: [],
          blockedDays: [...new Set([...outputs.blockedDays,
            ...outputs.dailyCandidates.map((candidate) => candidate.day)])].sort(),
        };
      }
      return {
        ...outputs,
        ...publication,
        // The journal position is the reader's, not the pure compute core's.
        journal: { lastSequence: inputs.lastSequence },
        // The owner-scoped rows this run recomputes: every prepared day from the
        // start of the occurrence range, and every cache day from cacheFromDay.
        horizon: { ownerDayFromDay: inputs.occurrenceRange.fromDay, cacheBandsFromDay: inputs.cacheFromDay },
        readSummary: {
          unlinkedTypedOwners: inputs.unlinkedTypedOwners,
          terminalOwners: inputs.terminalOwners,
          nonEffectiveUnread: inputs.nonEffectiveUnread,
        },
      };
    },
  });
}

/** Load the store and the default pipeline (bundled by esbuild from these literals). */
export async function loadAnalyticsV2Modules() {
  const [store, owners, occurrences, devices, queuedDays, compute] = await Promise.all([
    import("../src/analytics-v2/store.ts"),
    import("../src/analytics-v2/owners.ts"),
    import("../src/analytics-v2/occurrence-source.ts"),
    import("../src/analytics-v2/devices.ts"),
    import("../src/analytics-v2/queued-days.ts"),
    import("../src/analytics-v2/compute.ts"),
  ]);
  return Object.freeze({
    store,
    pipeline: createAnalyticsV2Pipeline({ owners, occurrences, devices, queuedDays, compute }),
  });
}

/**
 * The time guard (see the header). With no task timeout it is inert. With
 * one, the refusal point is the task deadline less the exit margin and the
 * projected write of the current output account; a checkpoint refuses
 * - ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED when the plan, or the remaining
 *   owners at an owner checkpoint, cannot finish before it at the measured
 *   rates, and
 * - ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED when the refusal point has passed,
 *   or a step about to start (a segment load and its days, an owner's scalar
 *   fit, one model date) could cross it at stepFactor times the measured
 *   rates.
 * The error carries `deadline`, content-free seconds and owner counts.
 */
export function createAnalyticsRefreshTimeGuard({ startedAtMs, taskTimeoutMs, wallClock,
  model = ANALYTICS_REFRESH_TIME_MODEL }) {
  if (taskTimeoutMs === null || taskTimeoutMs === undefined) {
    return Object.freeze({ active: false, checkpoint() {}, beforeWrite() {}, summary: () => null });
  }
  if (!Number.isSafeInteger(startedAtMs) || !Number.isSafeInteger(taskTimeoutMs) || taskTimeoutMs < 1
      || typeof wallClock !== "function") {
    fail("ANALYTICS_V2_REFRESH_DEADLINE_INVALID");
  }
  const deadlineMs = startedAtMs + taskTimeoutMs;
  let plannedOwners = null;
  let projections = null;
  let plannedMs = null;
  let ownerIndex = -1;
  let ownerAnalysisUsage = 0;
  let accountBytes = 0;
  const writeMs = (bytes) => model.writeFixedMs + model.writeMsPerAccountMiB * (bytes / MIB);
  const refuseAtMs = () => deadlineMs - model.exitMarginMs - writeMs(accountBytes);
  const ownerMs = (owner) => (owner.admitted
    ? (model.readMsPerOccurrence + model.prepareMsPerOccurrence) * owner.occurrences
      + (model.scalarMsPerAnalysisUsage + model.modelMsPerAnalysisUsage) * owner.analysisUsage
    : 0);
  const seconds = (milliseconds) => Math.max(0, Math.ceil(milliseconds / 1_000));
  const refuse = (code, now, projectedMs = null) => fail(code, {
    deadline: Object.freeze({
      taskTimeoutSeconds: seconds(taskTimeoutMs),
      elapsedSeconds: seconds(now - startedAtMs),
      refuseAtSeconds: seconds(refuseAtMs() - startedAtMs),
      ...(projectedMs === null ? {} : { projectedSeconds: seconds(projectedMs) }),
      ownersStarted: Math.max(0, ownerIndex + 1),
      ownersPlanned: projections === null ? null : projections.length,
    }),
  });
  const now = () => {
    const value = wallClock();
    if (!Number.isSafeInteger(value)) fail("ANALYTICS_V2_REFRESH_DEADLINE_INVALID");
    return value;
  };
  const remainingMs = (fromIndex) => projections.slice(fromIndex).reduce((total, value) => total + value, 0);
  return Object.freeze({
    active: true,
    checkpoint(event) {
      const at = now();
      if (Number.isSafeInteger(event?.accountBytes) && event.accountBytes >= 0) accountBytes = event.accountBytes;
      if (at > refuseAtMs()) refuse("ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED", at);
      switch (event?.kind) {
        case "plan": {
          if (!Array.isArray(event.owners)) fail("ANALYTICS_V2_REFRESH_DEADLINE_INVALID");
          plannedOwners = event.owners;
          projections = event.owners.map(ownerMs);
          plannedMs = remainingMs(0);
          if (at + plannedMs > refuseAtMs()) refuse("ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED", at, plannedMs);
          break;
        }
        case "owner": {
          if (projections === null || !Number.isSafeInteger(event.index) || event.index >= projections.length) {
            fail("ANALYTICS_V2_REFRESH_DEADLINE_INVALID");
          }
          ownerIndex = event.index;
          // Only an admitted owner is read and computed.
          ownerAnalysisUsage = plannedOwners[event.index].admitted ? plannedOwners[event.index].analysisUsage : 0;
          const remaining = remainingMs(event.index);
          if (at + remaining > refuseAtMs()) refuse("ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED", at, remaining);
          break;
        }
        case "segment": {
          const step = model.stepFactor * (model.readMsPerOccurrence + model.prepareMsPerOccurrence)
            * (Number.isSafeInteger(event.occurrences) ? event.occurrences : 0);
          if (at + step > refuseAtMs()) refuse("ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED", at, step);
          break;
        }
        case "scalar": {
          const step = model.stepFactor * model.scalarMsPerAnalysisUsage * ownerAnalysisUsage;
          if (at + step > refuseAtMs()) refuse("ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED", at, step);
          break;
        }
        case "model": {
          const step = model.stepFactor * model.modelMsPerAnalysisUsage * ownerAnalysisUsage / 70;
          if (at + step > refuseAtMs()) refuse("ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED", at, step);
          break;
        }
        default:
          break;
      }
    },
    beforeWrite(bytes) {
      if (Number.isSafeInteger(bytes) && bytes >= 0) accountBytes = bytes;
      const at = now();
      if (at > refuseAtMs()) refuse("ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED", at);
    },
    summary: () => Object.freeze({
      taskTimeoutSeconds: seconds(taskTimeoutMs),
      plannedSeconds: plannedMs === null ? null : seconds(plannedMs),
    }),
  });
}

function safeCode(error, fallback) {
  return typeof error?.code === "string" && SAFE_CODE.test(error.code) ? error.code : fallback;
}

/**
 * The process's peak resident set in bytes (getrusage ru_maxrss, which Node
 * reports in KiB on every platform). Operational metadata only: it sizes the
 * Job's task memory and no decision reads it.
 */
function defaultPeakRssBytes() {
  return process.resourceUsage().maxRSS * 1024;
}

/**
 * The receipt's content-free memory summary: the bounds applied and the
 * counts of computed and refused owners, the largest estimate, the largest
 * sampled heap and the process's peak resident set at the end of compute.
 * Per-owner figures go to analytics_v2_runs.timings only.
 */
function memorySummary(resources, recorded, peakRssBytes) {
  const owners = Array.isArray(recorded?.owners) ? recorded.owners : [];
  const toMiB = (bytes) => Math.ceil(bytes / MIB);
  const largest = (values) => values.reduce((maximum, value) => Math.max(maximum, value), 0);
  return Object.freeze({
    model: typeof recorded?.configuration?.memoryModel === "string" ? recorded.configuration.memoryModel : null,
    budgetMiB: toMiB(resources.compute.memoryBudgetBytes),
    maxDayOccurrences: resources.compute.maxDayOccurrences,
    maxDayRecordMiB: toMiB(resources.compute.maxDayRecordBytes),
    readChunkOccurrences: resources.readChunkOccurrences,
    heapLimitMiB: Math.floor(resources.heapLimitBytes / MIB),
    requiredHeapMiB: toMiB(resources.requiredHeapBytes),
    ownersComputed: owners.filter((owner) => owner.admitted === true).length,
    ownersRefused: owners.filter((owner) => owner.admitted === false).length,
    largestEstimateMiB: toMiB(largest(owners.map((owner) => owner.estimateBytes ?? 0))),
    largestHeapPeakMiB: toMiB(largest(owners.map((owner) => owner.heapPeakBytes ?? 0))),
    peakRssMiB: Number.isSafeInteger(peakRssBytes) && peakRssBytes >= 0 ? toMiB(peakRssBytes) : null,
    outputModel: typeof recorded?.configuration?.outputModel === "string" ? recorded.configuration.outputModel : null,
    outputBudgetMiB: Math.floor(resources.compute.outputBudgetBytes / MIB),
    effectiveOutputBudgetMiB: Number.isSafeInteger(recorded?.account?.outputBudgetBytes)
      ? Math.floor(recorded.account.outputBudgetBytes / MIB) : null,
    accountMiB: Number.isSafeInteger(recorded?.account?.accountBytes) ? toMiB(recorded.account.accountBytes) : null,
    heldInputMiB: Number.isSafeInteger(recorded?.account?.heldInputBytes) ? toMiB(recorded.account.heldInputBytes) : null,
    largestOwnerOutputMiB: toMiB(largest(owners.map((owner) => owner.outputBytes ?? 0))),
  });
}

function countBy(values, key) {
  const counts = {};
  for (const value of values) counts[key(value)] = (counts[key(value)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => (left < right ? -1 : 1)));
}

/** A refusal's content-free figures for the error line: closed keys, safe integers or null only. */
function refusalFigures(error) {
  if (error?.code === "ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED" && Number.isSafeInteger(error.accountBytes)
      && Number.isSafeInteger(error.outputBudgetBytes)) {
    return { outputAccount: Object.freeze({ accountMiB: Math.ceil(error.accountBytes / MIB),
      outputBudgetMiB: Math.floor(error.outputBudgetBytes / MIB) }) };
  }
  const deadline = error?.deadline;
  if (deadline !== null && typeof deadline === "object" && /^ANALYTICS_V2_REFRESH_DEADLINE_/u.test(error.code ?? "")) {
    const keys = ["taskTimeoutSeconds", "elapsedSeconds", "refuseAtSeconds", "projectedSeconds", "ownersStarted",
      "ownersPlanned"];
    return { deadline: Object.freeze(Object.fromEntries(keys
      .filter((key) => Object.hasOwn(deadline, key) && (deadline[key] === null || Number.isSafeInteger(deadline[key])))
      .map((key) => [key, deadline[key]]))) };
  }
  return {};
}

/**
 * Run one refresh. dependencies (tests and the composition root only):
 * createPool(database, {connector}), createConnector(), closeResources(),
 * modules ({store, pipeline}), wallClock(), randomUUID(), heapLimitBytes, peakRssBytes().
 * Returns the receipt; throws an error carrying a closed code and phase (and,
 * for a deadline or output-budget refusal, its content-free figures).
 */
export async function runAnalyticsRefresh({
  argv = process.argv.slice(2),
  env = process.env,
  dependencies = {},
} = {}) {
  const parsed = parseAnalyticsRefreshArguments(argv, env);
  if (parsed.help) return Object.freeze({ status: "help" });
  const wallClock = dependencies.wallClock ?? Date.now;
  const startedAtMs = wallClock();
  const nowMs = parsed.nowMs ?? startedAtMs;
  const base = {
    schemaVersion: ANALYTICS_REFRESH_RECEIPT_VERSION,
    target: null,
    mode: parsed.mode,
    schema: parsed.schema,
    now: new Date(nowMs).toISOString(),
    clock: parsed.nowMs === null ? "wall" : "test",
    revisionSeed: parsed.revisionSeed,
  };
  let phase = "configuration";
  let connector;
  let pool;
  let client;
  let locked = false;
  let readOpen = false;
  let discard = false;
  let receipt;
  let failure;
  try {
    const production = await readAnalyticsRefreshProductionTarget(env);
    if (production !== null) base.target = production.target;
    const resources = analyticsRefreshResources(env,
      dependencies.heapLimitBytes ?? getHeapStatistics().heap_size_limit);
    const guard = createAnalyticsRefreshTimeGuard({ startedAtMs,
      taskTimeoutMs: analyticsRefreshTaskTimeoutMs(env, production), wallClock });
    // A deadline that leaves no room for the write and the exit is refused
    // before any module, pool or lock.
    guard.checkpoint(Object.freeze({ kind: "start" }));
    const database = await resolveAnalyticsRefreshDatabase(env, { schema: parsed.schema });
    phase = "modules";
    const modules = dependencies.modules ?? await loadAnalyticsV2Modules();
    const { store, pipeline } = modules ?? {};
    if (typeof store?.writeRunOutputs !== "function"
        || typeof store?.readAnalyticsV2RefreshState !== "function"
        || typeof pipeline?.read !== "function" || typeof pipeline?.compute !== "function") {
      fail("ANALYTICS_V2_REFRESH_PIPELINE_UNAVAILABLE");
    }
    phase = "connection";
    if (database.kind === "cloud-sql") connector = dependencies.createConnector?.() ?? new Connector();
    pool = await (dependencies.createPool ?? defaultCreatePool)(database, { connector });
    client = await pool.connect();

    phase = "lock";
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [ANALYTICS_REFRESH_LOCK_KEY]);
    if (lock?.rows?.[0]?.acquired !== true) {
      receipt = Object.freeze({ ...base, status: "ok", state: "LOCK_HELD" });
    } else {
      locked = true;
      phase = "read";
      const readStartedMs = wallClock();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      readOpen = true;
      await client.query(`SET LOCAL statement_timeout='${READ_STATEMENT_TIMEOUT_MILLISECONDS}ms'`);
      await client.query(`SET LOCAL lock_timeout='${READ_LOCK_TIMEOUT_MILLISECONDS}ms'`);
      // The exporting transaction idles while owners are computed; the snapshot
      // must outlive the last owner's read. It therefore holds the primary's
      // xmin horizon for the whole read and compute (VACUUM cannot remove rows
      // that die meanwhile) until COMMIT, or until the task ends and its
      // connection closes. The dense-owner parity receipt records the duration.
      await client.query("SET LOCAL idle_in_transaction_session_timeout=0");
      const snapshot = (await client.query("SELECT pg_export_snapshot() AS snapshot"))?.rows?.[0]?.snapshot;
      const state = await store.readAnalyticsV2RefreshState(client, { schema: parsed.schema });
      const readPool = createSnapshotReadPool(pool, snapshot);
      let inputs;
      let outputs;
      let readMs;
      try {
        inputs = await pipeline.read({
          pool: readPool,
          schema: parsed.schema,
          nowMs,
          state,
          revisionSeed: parsed.revisionSeed,
          resources,
          checkpoint: guard.checkpoint,
        });
        readMs = Math.max(0, wallClock() - readStartedMs);
        // Owners are read in the same snapshot while they are computed.
        phase = "compute";
        outputs = await pipeline.compute(inputs, {
          mode: parsed.mode,
          nowMs,
          revisionSeed: parsed.revisionSeed,
          ...(guard.active ? { checkpoint: guard.checkpoint } : {}),
        });
      } finally {
        await readPool.close();
      }
      await client.query("COMMIT");
      readOpen = false;
      // The stored revision fields must follow this run's flags exactly.
      if (outputs === null || typeof outputs !== "object" || outputs.mode !== parsed.mode
          || outputs.nowMs !== nowMs || outputs.revisionSeed !== parsed.revisionSeed) {
        fail("ANALYTICS_V2_REFRESH_OUTPUTS_INCONSISTENT");
      }

      phase = "write";
      guard.beforeWrite(outputs.resources?.account?.accountBytes);
      const runId = (dependencies.randomUUID ?? randomUUID)();
      const written = await store.writeRunOutputs(client, outputs, {
        schema: parsed.schema,
        runId,
        startedAtMs,
        expectedCursor: state.cursor,
        horizon: outputs.horizon,
        // The listing, journal and counts, plus the owner loads inside compute.
        timings: { read: readMs + (Number.isFinite(outputs.timings?.read) ? outputs.timings.read : 0) },
        wallClock,
      });
      // Content-free read counts the default pipeline reports (closed keys).
      const readSummary = Object.fromEntries(READ_SUMMARY_KEYS
        .map((key) => [key, outputs.readSummary?.[key]])
        .filter(([, value]) => Number.isSafeInteger(value) && value >= 0));
      receipt = Object.freeze({
        ...base,
        status: "ok",
        state: written.state,
        runId: written.runId,
        owners: written.owners,
        ownerDays: written.ownerDays,
        retainedOwners: written.retainedOwners,
        ...readSummary,
        refusals: written.refusals,
        refusalsByReason: countBy(outputs.refusals ?? [], (refusal) => refusal.reason),
        published: written.publication.published,
        unchanged: written.publication.unchanged.length,
        blocked: written.publication.blocked,
        cursor: written.cursor,
        timings: written.timings,
        memory: memorySummary(resources, outputs.resources, (dependencies.peakRssBytes ?? defaultPeakRssBytes)()),
        timeGuard: guard.summary(),
      });
    }
  } catch (error) {
    discard = true;
    // A store error carries sqlState; a driver error carries its SQLSTATE as code.
    const sqlState = typeof error?.sqlState === "string" ? error.sqlState : error?.code;
    failure = Object.assign(new Error(safeCode(error, "ANALYTICS_V2_REFRESH_FAILED")), {
      code: safeCode(error, "ANALYTICS_V2_REFRESH_FAILED"),
      phase,
      ...(typeof sqlState === "string" && SQL_STATE.test(sqlState) ? { sqlState } : {}),
      ...(typeof error?.field === "string" && /^[A-Za-z0-9_.]{1,80}$/u.test(error.field)
        ? { field: error.field } : {}),
      ...(error?.usage === true ? { usage: true } : {}),
      ...refusalFigures(error),
    });
  } finally {
    if (client !== undefined) {
      if (readOpen) {
        try { await client.query("ROLLBACK"); } catch { discard = true; }
      }
      if (locked) {
        try {
          const unlock = await client.query("SELECT pg_advisory_unlock(hashtext($1)) AS released",
            [ANALYTICS_REFRESH_LOCK_KEY]);
          if (unlock?.rows?.[0]?.released !== true) discard = true;
        } catch {
          discard = true;
        }
      }
      try { await client.release(discard); } catch { /* the pool is closed below */ }
    }
    if (pool !== undefined || connector !== undefined) {
      try {
        await (dependencies.closeResources ?? closeCloudSqlResources)({
          pools: pool === undefined ? [] : [pool],
          connector,
        });
      } catch {
        failure ??= Object.assign(new Error("ANALYTICS_V2_REFRESH_CLOSE_FAILED"), {
          code: "ANALYTICS_V2_REFRESH_CLOSE_FAILED",
          phase: "cleanup",
        });
      }
    }
  }
  if (failure !== undefined) throw failure;
  return receipt;
}

async function main() {
  try {
    const receipt = await runAnalyticsRefresh();
    if (receipt.status === "help") {
      process.stdout.write(ANALYTICS_REFRESH_USAGE);
      return;
    }
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: ANALYTICS_REFRESH_RECEIPT_VERSION,
      status: "failed",
      code: safeCode(error, "ANALYTICS_V2_REFRESH_FAILED"),
      phase: typeof error?.phase === "string" ? error.phase : "configuration",
      ...(typeof error?.sqlState === "string" ? { sqlState: error.sqlState } : {}),
      ...(typeof error?.field === "string" ? { field: error.field } : {}),
      ...(error?.deadline !== null && typeof error?.deadline === "object" ? { deadline: error.deadline } : {}),
      ...(error?.outputAccount !== null && typeof error?.outputAccount === "object"
        ? { outputAccount: error.outputAccount } : {}),
    })}\n`);
    process.exitCode = error?.usage === true ? 2 : 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
