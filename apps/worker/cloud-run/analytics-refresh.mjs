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
 *      prove the kernel transitions from older stored kernels to this one
 *      over their stored price inputs (K-PERCARD, store-price.ts; nothing to
 *      prove once a transition is recorded), and run every A-1 reader through
 *      a pool whose transactions all import that snapshot;
 *   3. compute with A-2 (pure): A-1's exact evidence counts
 *      (countOwnerOccurrences) decide the per-owner memory guard and the read
 *      spans before anything is read; an admitted owner is then read in the
 *      same snapshot in bounded segments (the history before the analysis
 *      horizon in 60-day segments, each released before the next, then the
 *      analysis horizon), computed and released, so a heap holds one segment
 *      of an owner (two, prefetched, in a compute Worker), not its whole
 *      history or the corpus. With --workers=1 owners are computed inline,
 *      one at a time; with more (K-PAR, K-PAR-MEM) they run in compute
 *      Workers (analytics-refresh-pool.mjs), each with a heap limit from its
 *      estimate, admitted against the task memory the main heap leaves, while
 *      every read stays in this thread: the Workers' loads run concurrently on
 *      the snapshot connections and are streamed to them a read call at a
 *      time; either way owners are merged in digest order, so the outputs are
 *      identical. The exporting transaction stays open until the last read;
 *   4. write everything with store.ts writeRunOutputs in ONE transaction on
 *      the same session (with the price rows the prepared-day observer
 *      attributed, the kernel's price cards and the proven transitions, which
 *      the store re-checks against the stored rows), then release the lock.
 *
 * Publication follows production's queue (d43c8f92
 * advanceNextStorageCommunityDaily): a run recomputes and may republish only
 * the days named by journal events after the cursor plus the days the last
 * run left blocked. Untouched heads are never recomputed, so a change to the
 * eligible roster (opt-out, disconnect, expiry) is not applied retroactively
 * to published history; terminal journal events stop future uploads only and
 * re-queue nothing (2026-09-26 owner decisions). A queued day is recomputed
 * over its saved owner set (E-OWNERSET, owner decision round 2): a member
 * that left the roster, or whose read for the day is empty, keeps its stored
 * contribution (and a member that left keeps its exclusions), and the
 * publication records the day's set and contributions (the receipt's
 * `ownerSets` counts them and names blocked, verified, disclosed and adopted
 * days; content-free).
 *
 * Production and staging (ANALYTICS_REFRESH_TARGET=production|staging): the
 * reviewed target path. The invocation is exactly
 *   node dist/analytics-refresh.mjs --mode=full --workers=4
 * (ANALYTICS_REFRESH_PRODUCTION_JOB: four compute Workers, no heap flag), with no --schema, --now or
 * --revision-seed, on the real clock: revisions follow the stored heads and
 * the stored Cloudflare revision floor (REV-SEED: the cutover import loads
 * it before markLive; store-publication.ts nextPublishedRevision). A
 * production target refuses ANALYTICS_V2_REVISION_FLOOR_ABSENT, in the read
 * snapshot before any read or compute and writing nothing, when no floor is
 * loaded; a staging target or a test target treats an absent floor as 0.
 * Before that check, a production FIRST run (no completed run row, or no
 * recorded journal cursor) refuses ANALYTICS_V2_FIRST_RUN_BASELINE_ABSENT
 * the same way when the frozen interim read (C-IPR's row) is absent, even if the
 * revision floor is loaded: a first run must start from the frozen record of
 * Cloudflare's published history (R19 hardening (d), in addition to the H.4
 * flip gate's CUTOVER_INTERIM_READ_NOT_LOADED). Staging and test targets,
 * with or without a synthetic floor, are not gated.
 * The environment is closed
 * (ANALYTICS_REFRESH_PRODUCTION_ENV): ANALYTICS_REFRESH_TARGET,
 * PRIMARY_INSTANCE_CONNECTION_NAME, PRIMARY_DATABASE, PRIMARY_SCHEMA,
 * POSTGRES_IAM_USER and ANALYTICS_V2_MEMORY_BUDGET_MIB. Any other variable in
 * the job's configuration namespaces (ANALYTICS_, PRIMARY_, POSTGRES_, LEDGER_,
 * and PG, which also covers every libpq-style variable node-pg reads, such as
 * PGOPTIONS, PGSSLMODE or PGPASSWORD), the Node runtime variables that change
 * the code loaded, the database driver or TLS trust
 * (ANALYTICS_REFRESH_RUNTIME_FORBIDDEN: NODE_OPTIONS, NODE_PG_FORCE_NATIVE,
 * NODE_TLS_REJECT_UNAUTHORIZED, NODE_EXTRA_CA_CERTS), every variable of the
 * job's own production refusal policy (ANALYTICS_REFRESH_CR3_POLICY: the
 * test seams, edge secrets and retired ledger settings CR-3 refused when the
 * policy was taken from it),
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
 *                          refused under a production target); each day's
 *                          revision is max(head, floor, n) + 1
 *   --workers=<n>          compute Workers, 1..16 (default 1: every owner is
 *                          computed inline, one at a time). With more, owners
 *                          run in Workers of dist/analytics-refresh-worker.mjs
 *                          (K-PAR, analytics-refresh-pool.mjs) and are merged
 *                          in owner-digest order: the outputs are identical
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
 * The heap is partitioned: the per-owner budget, the read reserve
 * (4 KiB per read-chunk occurrence), a 256 MiB runtime reserve, and the rest
 * is the output budget, which A-2's output account charges every held output
 * row against (resources.ts). The partitioned heap is V8's heap_size_limit
 * less the young-generation growth beyond the 48 MiB the budget counted before
 * R19 (ANALYTICS_REFRESH_COUNTED_YOUNG_GENERATION_BYTES): when the Node flags
 * declare --max-old-space-size, the young generation is the rest of
 * heap_size_limit (analyticsRefreshYoungGenerationBytes), so a larger
 * semi-space (--max-semi-space-size) does not grow the output budget, and the
 * budget is at most the declared old space plus 48 MiB less the reserves. The run
 * refuses to start (ANALYTICS_V2_REFRESH_HEAP_INSUFFICIENT) unless the output
 * budget is at least 64 MiB. Once the plan has fixed the largest admitted owner's
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
 * complete and LOCK_HELD, 2 for a usage refusal, 1 for any other failure. The
 * receipt carries the run's kernel stamp (K-STAMP: kernel id and manifest
 * version; a bundle no kernel-registry.json entry names is refused
 * ANALYTICS_V2_KERNEL_UNREGISTERED before any connection), the read side's
 * statement ledger (K-PGSTAT `reads`: calls, client wall time, rows and bytes
 * per statement family, the read phase's unattributed remainder, and the
 * server's execution and planning time per family when pg_stat_statements is
 * readable), K-PERCARD's `prices` (the kernel's card count, the cards, bases
 * and owner-day price rows written, and each kernel transition recorded with
 * its verdict and stale owner-day count), and content-free counts of the
 * community aggregate exclusions
 * it applied (N-EXCL, src/analytics-v2/exclusions.ts: an owner excluded on a
 * day is left out of that day's public daily and allowance preview; the run
 * row records the digest of the exclusions applied, and a run that finds
 * them changed republishes every published day), the read side's counts
 * (`unlinkedTypedOwners`, eligible typed participants without an active owner
 * link; `unlinkedBlockedDays`, the computed days they withheld, 0 when each is
 * excluded on every such day: EXCL-UNLINKED, round 19; `terminalOwners`;
 * `nonEffectiveUnread`), and the revision floor it
 * read (REV-SEED `revisionFloor`: present, dayCount and maxRevision; 0 and 0
 * when absent), and the first-run baseline it read (R19 `baseline`: firstRun
 * and frozenInterimRead, booleans).
 *
 * Profiling (MEAS-SYNTH, analytics-refresh-profile.mjs): ANALYTICS_V2_REFRESH_PROFILE=cpu
 * runs node:inspector's sampling profiler and writes a content-free summary
 * line to stderr every ANALYTICS_V2_REFRESH_PROFILE_SUMMARY_SECONDS (default
 * 30 min), at exit (complete, refused or failed) and on SIGTERM. A staging
 * target and the test targets accept it; a production target refuses every
 * ANALYTICS_V2_REFRESH_PROFILE* variable (ANALYTICS_V2_REFRESH_PROFILE_FORBIDDEN).
 *
 * The TypeScript store and the A-1/A-2 modules are loaded through literal
 * dynamic imports, so esbuild bundles them into the dist entry while the
 * source file still answers --help under plain Node 22.
 */

import { readWorkerProfileSettings, createWorkerProfileCoordinator } from "./analytics-refresh-worker-profile.mjs";
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
  FASTPATH_MEASUREMENT_CLOUD_TARGET,
  FASTPATH_TEST_CLOUD_TARGET,
  FASTPATH_TEST_SCHEMA_PREFIXES,
  isFastpathMeasurementInstanceConnectionName,
  isFastpathTestSchema,
} from "./origin-fastpath-mode.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./cloud-run-iam-test-target.mjs";
import {
  ANALYTICS_REFRESH_DEFAULT_READ_CHUNK_OCCURRENCES,
  ANALYTICS_REFRESH_STATEMENT_MODEL,
  analyticsRefreshServerStatementDelta,
  createAnalyticsRefreshStatementLedger,
  createAnalyticsV2Pipeline,
  createSnapshotReadPool,
  readAnalyticsRefreshServerStatements,
} from "./analytics-refresh-read.mjs";
import {
  ANALYTICS_REFRESH_WORKER_BOUNDS,
  ANALYTICS_REFRESH_WORKER_HEAP_MODEL,
  analyticsRefreshWorkerPoolMinimumBytes,
  createAnalyticsRefreshOwnerPool,
} from "./analytics-refresh-pool.mjs";
import {
  ANALYTICS_REFRESH_PROFILE_PREFIX,
  ANALYTICS_REFRESH_PROFILE_STAGING_ENV,
  createAnalyticsRefreshProfiler,
  readAnalyticsRefreshProfileSettings,
} from "./analytics-refresh-profile.mjs";

// The read side (K-SPLIT) and the compute workers (K-PAR): re-exported so
// callers keep one import surface.
export {
  ANALYTICS_REFRESH_LOAD_CONCURRENCY_BOUNDS,
  ANALYTICS_REFRESH_WORKER_BOUNDS,
  ANALYTICS_REFRESH_WORKER_HEAP_MODEL,
  analyticsRefreshWorkerHeapLimitBytes,
  analyticsRefreshWorkerPoolMinimumBytes,
  createAnalyticsRefreshOwnerPool,
} from "./analytics-refresh-pool.mjs";
export {
  ANALYTICS_REFRESH_PROFILE_ENV,
  ANALYTICS_REFRESH_PROFILE_SCHEMA,
  ANALYTICS_REFRESH_PROFILE_STAGING_ENV,
  readAnalyticsRefreshProfileSettings,
} from "./analytics-refresh-profile.mjs";
export {
  ANALYTICS_REFRESH_STATEMENT_MODEL,
  analyticsRefreshServerStatementDelta,
  analyticsRefreshStatementFamily,
  createAnalyticsRefreshStatementLedger,
  readAnalyticsRefreshServerStatements,
  ANALYTICS_REFRESH_DEFAULT_READ_CHUNK_OCCURRENCES,
  ANALYTICS_REFRESH_MAX_QUEUED_DAYS,
  ANALYTICS_REFRESH_MAX_RANGE_DAYS,
  ANALYTICS_REFRESH_MAX_READ_CANDIDATES,
  analyticsRefreshCacheFromDay,
  analyticsRefreshDaySpans,
  analyticsRefreshForEachConcurrent,
  analyticsRefreshSlots,
  ANALYTICS_REFRESH_READ_CONCURRENCY,
  mergeAnalyticsRefreshOccurrencePart,
  analyticsRefreshPublicationDays,
  analyticsRefreshRangeChunks,
  analyticsRefreshReadSpans,
  createAnalyticsV2Pipeline,
  createSnapshotReadPool,
} from "./analytics-refresh-read.mjs";

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
 * renderJob; its check pins the render to this object): the `dense-workers`
 * task profile (owner decisions round 17, K-PAR-MEM). 4 vCPU and 16 GiB; four
 * compute Workers (K-PAR) and NO heap flag (heapMiB null): a V8 heap flag
 * applies to every isolate and overrides the Workers' own heap limits (the
 * K-CORE-A W = 4 out-of-memory was the old profile's 3,072 MiB flag capping
 * every Worker), so the main heap runs at V8's default for the task (about
 * 4 GiB) and the Workers share the rest less a 1 GiB native reserve, each
 * with a heap limit from its owner's memory estimate and admitted against
 * that pool (analytics-refresh-pool.mjs; the Job refuses a heap flag with
 * --workers > 1). The 10,752 MiB per-owner budget admits the largest real
 * owner at the high end of its estimate; the pool's whole-pool limit holds it
 * alone (analyticsRefreshWorkerPoolMinimumBytes).
 *
 * The task timeout is 24 h (round 17): the production-shaped synthetic
 * corpus previously took about 4.2 h locally inline; the concurrently loaded
 * recovery comparator took 5.42 h. The prior Cloud Run inline projection was
 * 10 to 13 h, not a measured runtime; the Workers' run is in the K-PAR-MEM receipt. One task,
 * no retries: a run either writes everything in one transaction or nothing,
 * and the time guard refuses it before taskTimeoutSeconds. `args` follows
 * `node`. The inline profile (`dense`: --max-old-space-size=12288, no
 * --workers) stays the measured fallback.
 */
export const ANALYTICS_REFRESH_PRODUCTION_JOB = Object.freeze({
  entry: "dist/analytics-refresh.mjs",
  profile: "dense-workers",
  cpu: "4",
  memory: "16Gi",
  heapMiB: null,
  semiSpaceMiB: null,
  memoryBudgetMiB: 10_752,
  workers: 4,
  taskTimeoutSeconds: 86_400,
  tasks: 1,
  parallelism: 1,
  maxRetries: 0,
  args: Object.freeze(["dist/analytics-refresh.mjs", "--mode=full", "--workers=4"]),
  env: ANALYTICS_REFRESH_PRODUCTION_ENV,
});
/**
 * V8's default heap limit (heap_size_limit, MiB) for a 16 GiB task under
 * Node.js 22.16.0 without a heap flag: the main heap of the production
 * profile. Measured locally (the default is the same on any host with at
 * least 16 GiB); the Job reads the live value at start and derives the
 * Workers' pool from it, so this constant only sizes the checks.
 */
export const ANALYTICS_REFRESH_DEFAULT_HEAP_LIMIT_MIB = 4_144;
/**
 * The task-memory relation a refresh profile must keep (K-PAR-MEM): the main
 * heap and, with compute Workers, their pool (the task memory less the main
 * heap and the native reserve; the pool's admission keeps the Workers' heap
 * limits and overheads within it; inline the budget is inside the main
 * heap), with at least nativeReserveMiB of the task's memory left for native
 * allocations.
 */
export const ANALYTICS_REFRESH_TASK_MEMORY_CHECK = Object.freeze({ taskMemoryMiB: 16_384, nativeReserveMiB: 1_024,
  youngGenerationSemiSpaces: 3 });
const KNOWN_FLAGS = new Set(["mode", "schema", "now", "revision-seed", "workers", "model-block-size", "model-fanout"]);
const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;
const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const DECIMAL = /^(?:0|[1-9]\d{0,9})$/u;
const MAX_REVISION_SEED = 2_000_000_000;
const SAFE_CODE = /^ANALYTICS_V2_[A-Z0-9_]+$/u;
const SQL_STATE = /^[0-9A-Z]{5}$/u;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PRIVATE_SOCKET_DIRECTORY = /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u;
const POOL_MAX = 4;
/**
 * Snapshot read connections (K-PAR-MEM): the pool less the session that holds
 * the lock and exports the snapshot. The owner-scoped reads before compute
 * and, with compute Workers, the owner loads run on up to this many at once.
 */
export const ANALYTICS_REFRESH_READ_CONNECTIONS = POOL_MAX - 1;
const READ_STATEMENT_TIMEOUT_MILLISECONDS = 120_000;
const READ_LOCK_TIMEOUT_MILLISECONDS = 5_000;
const READ_SUMMARY_KEYS = Object.freeze(["unlinkedTypedOwners", "unlinkedBlockedDays", "terminalOwners",
  "nonEffectiveUnread"]);
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
/**
 * Tokens that mark a test, rehearsal or measurement resource; a production
 * target refuses them ("meas": the disposable measurement instances,
 * FASTPATH_MEASUREMENT_CLOUD_TARGET).
 */
const TEST_TOKENS = Object.freeze(["test", "rehearsal", "fastpath", "meas"]);
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
    maximum: 2_000_000, default: ANALYTICS_REFRESH_DEFAULT_READ_CHUNK_OCCURRENCES }),
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
/**
 * V8 heap-size flags (either spelling): with compute Workers they are refused,
 * because V8 applies them to every isolate and so overrides the Workers'
 * resourceLimits (K-PAR-MEM).
 */
export const ANALYTICS_REFRESH_V8_HEAP_FLAG =
  /^--(?:max|initial)[-_](?:old[-_]space|heap|semi[-_]space|young[-_]generation)[-_]size(?:=|$)/u;
/** resources.ts ANALYTICS_V2_RESOURCE_BOUNDS.outputBudgetBytes.maximum (the spec pins the equality). */
const MAX_OUTPUT_BUDGET_BYTES = 30_720 * MIB;
/**
 * The young generation the output budget keeps counting: the 48 MiB V8 gives
 * the job by default on Node.js 22.16.0 (three 16 MiB semi-spaces), which the
 * budget counted before R19. Owner decisions round 19 adopt
 * --max-semi-space-size=64 with the output budget corrected for the
 * young-generation growth only, so the growth beyond this is excluded and the
 * budget stays where the default young generation left it, on every profile.
 */
export const ANALYTICS_REFRESH_COUNTED_YOUNG_GENERATION_BYTES = 48 * MIB;
const OLD_SPACE_FLAG = /^--max[-_]old[-_]space[-_]size(?:=(.*))?$/su;
const OLD_SPACE_MIB = /^[1-9]\d{0,8}$/u;

/**
 * The young-generation bytes inside V8's heap_size_limit, which hold no
 * retained output row: heap_size_limit less the old-space size the Node flags
 * declare (--max-old-space-size, the last declaration winning, NODE_OPTIONS
 * before the command line as Node applies them). V8 adds its young generation
 * to the declared old space (Node.js 22.16.0: three semi-spaces, so 48 MiB at
 * the default 16 MiB semi-space and 192 MiB at --max-semi-space-size=64), and
 * the default semi-space differs between Node versions (Node.js 24.14.0 gives
 * 192 MiB and 26.2.0 96 MiB without the flag), so the declared old space is
 * the one figure the job can trust. Without a declaration (or with one it
 * cannot read, or one above the limit) it is 0, and the whole limit is
 * partitioned, as before R19.
 */
export function analyticsRefreshYoungGenerationBytes(heapLimitBytes, flags = []) {
  let declaredBytes = null;
  for (const flag of Array.isArray(flags) ? flags : []) {
    const match = typeof flag === "string" ? OLD_SPACE_FLAG.exec(flag) : null;
    if (match === null) continue;
    declaredBytes = match[1] !== undefined && OLD_SPACE_MIB.test(match[1]) ? Number(match[1]) * MIB : null;
  }
  if (declaredBytes === null || !Number.isSafeInteger(heapLimitBytes) || declaredBytes > heapLimitBytes) return 0;
  return heapLimitBytes - declaredBytes;
}

/**
 * Local planning rates from the completed 2026-10-03 recovery inline run:
 * Node.js 22.16.0, PostgreSQL 17, 53 synthetic owners, 8,109,760 occurrences
 * and 4,032,323 analysis usage rows. Read 4,029 s, prepare 3,614 s, scalar
 * 311 s, model 11,547 s (docs/receipts/2026-10-03-gcp-kpar-mem.md).
 * Rounded per-occurrence and per-analysis-usage rates replace the smaller
 * 2026-10-01 dense-owner calibration. The local host was concurrently loaded;
 * these conservative planning rates are not Cloud Run calibration.
 *
 * The plan uses local rates, refusing work that cannot finish even there.
 * Before each step, stepFactor scales its projection (the earlier test read
 * Cloud SQL about 5x slower locally), retaining write/exit margins before the
 * 24-hour task limit. Dedicated production-tier cloud measurements must
 * recalibrate that factor separately. The write estimate includes a fixed
 * minute plus a conservative per-MiB allowance.
 */
export const ANALYTICS_REFRESH_TIME_MODEL = Object.freeze({
  readMsPerOccurrence: 0.50,
  prepareMsPerOccurrence: 0.45,
  scalarMsPerAnalysisUsage: 0.08,
  modelMsPerAnalysisUsage: 2.86,
  stepFactor: 5,
  writeFixedMs: 60_000,
  writeMsPerAccountMiB: 1_000,
  exitMarginMs: 120_000,
});

export const ANALYTICS_REFRESH_USAGE = `Usage: node analytics-refresh.mjs --mode=full [--schema=<identifier>]
       [--now=<ISO instant>] [--revision-seed=<n>] [--workers=<n>]

Recompute every analytics_v2 output from the typed PostgreSQL sources and
write it in one transaction. Exits 0 (complete or LOCK_HELD), 2 (usage
refusal) or 1 (failure).

  --mode=full            full recompute (the only mode)
  --schema=<identifier>  runtime schema (default: PRIMARY_SCHEMA)
  --now=<ISO instant>    test clock only: requires ANALYTICS_V2_TEST_CLOCK=1
                         or POSTGRES_TEST_HTTP_MODE
  --revision-seed=<n>    first published revision is above n (default 0); a
                         day publishes at max(head, revision floor, n) + 1
  --workers=<n>          compute Workers, 1..16 (default 1: inline)
  --model-block-size=<b> contiguous dates per block, 1..70 (default 10)
  --model-fanout=<mode>  auto, all or off (default auto)
  --help                 print this text

Production and staging: ANALYTICS_REFRESH_TARGET=production|staging with
exactly PRIMARY_INSTANCE_CONNECTION_NAME, PRIMARY_DATABASE, PRIMARY_SCHEMA,
POSTGRES_IAM_USER and ANALYTICS_V2_MEMORY_BUDGET_MIB; no --schema, --now or
--revision-seed; run as node dist/analytics-refresh.mjs --mode=full --workers=4
(the dense-workers profile: four compute Workers, no heap flag, 24 h task
timeout). With --workers > 1 a V8 heap flag is refused.
A production target refuses ANALYTICS_V2_REVISION_FLOOR_ABSENT until
 the cutover import has loaded the revision floor, and a production first run
 refuses ANALYTICS_V2_FIRST_RUN_BASELINE_ABSENT when the frozen interim read
 is absent, even if the revision floor is loaded.

Resources (environment, within bounds): ANALYTICS_V2_MEMORY_BUDGET_MIB (4608),
ANALYTICS_V2_MAX_DAY_OCCURRENCES (250000), ANALYTICS_V2_MAX_DAY_RECORD_MIB (256),
ANALYTICS_V2_READ_CHUNK_OCCURRENCES (250000), and, outside production,
ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS (none). The Node old space and 48 MiB
of the young generation must cover the budget, 256 MiB, 4 KiB per read-chunk
occurrence and a 64 MiB output budget (run the Job with
--max-old-space-size=6144 for the defaults); young generation beyond 48 MiB
(a larger --max-semi-space-size) is not counted.
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
  // K-PAR: compute workers; 1 computes every owner inline, as before.
  const workersText = flags.get("workers") ?? "1";
  if (!DECIMAL.test(workersText) || Number(workersText) < ANALYTICS_REFRESH_WORKER_BOUNDS.minimum
      || Number(workersText) > ANALYTICS_REFRESH_WORKER_BOUNDS.maximum) {
    usageFail("ANALYTICS_V2_REFRESH_WORKERS_INVALID");
  }
  // model-blocks-flags: independent of read-plan's readConcurrency hunk.
  const modelBlockSizeText = flags.get("model-block-size") ?? "10";
  const modelFanOut = flags.get("model-fanout") ?? "auto";
  if (!DECIMAL.test(modelBlockSizeText) || Number(modelBlockSizeText) < 1 || Number(modelBlockSizeText) > 70
      || !["auto", "all", "off"].includes(modelFanOut)) usageFail("ANALYTICS_V2_REFRESH_MODEL_BLOCKS_INVALID");
  return Object.freeze({
    help: false,
    mode,
    schema,
    nowMs,
    revisionSeed: Number(seedText),
    workers: Number(workersText),
    modelBlockSize: Number(modelBlockSizeText), modelFanOut,
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
    FASTPATH_MEASUREMENT_CLOUD_TARGET.refreshJob,
  ]);
}
const TEST_TARGET_VALUES = testTargetIdentities();

/**
 * The job's production refusal policy: the variables and prefixes it refuses
 * in production, the plane markers and the production resource fingerprint
 * values (Cloudflare's production names). Its values were taken from CR-3
 * (cloud-run/postgres-production-configuration.mjs) and keep CR-3's name for
 * a byte-stable build. Owner round 12 (2026-10-02, OWN-20.1) made this
 * contract (C-REFRESH's) the only one that governs the production analytics
 * job: CR-3's analytics-job profiles and the spec's equality pin between the
 * two were retired, so this policy is owned here and changes only with a
 * reviewed change to this file. The job refuses the fingerprint on both
 * planes (CR-3 refuses it on the staging plane only), which is stricter and
 * refuses no GCP name the committed desired states use.
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
 * - ANALYTICS_V2_REFRESH_PROFILE_FORBIDDEN: any ANALYTICS_V2_REFRESH_PROFILE*
 *   variable under a production target (a staging target accepts
 *   ANALYTICS_REFRESH_PROFILE_STAGING_ENV and no other);
 * - ANALYTICS_V2_REFRESH_ENV_FORBIDDEN: any production-forbidden variable or
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
  // The opt-in profiler (analytics-refresh-profile.mjs): never in production;
  // staging accepts its mode, sampling interval and summary period only.
  const profileNames = names.filter((name) => name.startsWith(ANALYTICS_REFRESH_PROFILE_PREFIX)).sort();
  if (target === "production" && profileNames.length > 0) {
    fail("ANALYTICS_V2_REFRESH_PROFILE_FORBIDDEN", { field: profileNames[0] });
  }
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
        && !ANALYTICS_REFRESH_PRODUCTION_ENV.includes(name)
        && !(target === "staging" && ANALYTICS_REFRESH_PROFILE_STAGING_ENV.includes(name))) {
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
  if (isFastpathMeasurementInstanceConnectionName(instanceConnectionName)
      || instance.startsWith(FASTPATH_MEASUREMENT_CLOUD_TARGET.instancePrefix)) {
    fail("ANALYTICS_V2_REFRESH_TEST_TARGET_FORBIDDEN", { field: "PRIMARY_INSTANCE_CONNECTION_NAME" });
  }
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
 * The rest of the partitioned heap is the output budget
 * (compute.outputBudgetBytes), so the whole run is bounded: one admitted
 * owner's estimate, the accounted outputs and held inputs, and the reserves.
 * heapLimitBytes is V8's heap_size_limit; execArgv (and env.NODE_OPTIONS) are
 * the Node flags, from which the young generation is read
 * (analyticsRefreshYoungGenerationBytes); the part of it beyond
 * ANALYTICS_REFRESH_COUNTED_YOUNG_GENERATION_BYTES is not partitioned.
 */
export function analyticsRefreshResources(env, heapLimitBytes, { workers = 1,
  taskMemoryBytes = ANALYTICS_REFRESH_TASK_MEMORY_CHECK.taskMemoryMiB * MIB, execArgv = [] } = {}) {
  const spec = ANALYTICS_REFRESH_RESOURCE_ENV;
  const reserve = ANALYTICS_REFRESH_HEAP_RESERVE;
  if (!Number.isSafeInteger(workers) || workers < ANALYTICS_REFRESH_WORKER_BOUNDS.minimum
      || workers > ANALYTICS_REFRESH_WORKER_BOUNDS.maximum) {
    fail("ANALYTICS_V2_REFRESH_WORKERS_INVALID");
  }
  const memoryBudgetBytes = resourceValue(env, spec.memoryBudgetMiB) * MIB;
  const maxDayOccurrences = resourceValue(env, spec.maxDayOccurrences);
  const maxDayRecordBytes = resourceValue(env, spec.maxDayRecordMiB) * MIB;
  const readChunkOccurrences = resourceValue(env, spec.readChunkOccurrences);
  // Inline (one worker) the owner being computed lives in the main heap; with
  // compute Workers (K-PAR) it lives in a Worker's own heap, and the main heap
  // holds about one read chunk across the loads in flight (K-PAR-MEM: each
  // load's read calls target the chunk divided by the load concurrency, and
  // are streamed to their Worker one call at a time).
  const ownerBytesInHeap = workers === 1 ? memoryBudgetBytes : 0;
  const reservedBytes = ownerBytesInHeap + reserve.runtimeBytes + readChunkOccurrences * reserve.bytesPerReadCandidate;
  const requiredHeapBytes = reservedBytes + reserve.minimumOutputBudgetBytes;
  if (!Number.isSafeInteger(heapLimitBytes)) fail("ANALYTICS_V2_REFRESH_HEAP_INSUFFICIENT");
  const nodeOptions = typeof env?.NODE_OPTIONS === "string" ? env.NODE_OPTIONS.split(/\s+/u) : [];
  const youngGenerationBytes = analyticsRefreshYoungGenerationBytes(heapLimitBytes,
    [...nodeOptions, ...(Array.isArray(execArgv) ? execArgv : [])]);
  const partitionedBytes = heapLimitBytes
    - Math.max(0, youngGenerationBytes - ANALYTICS_REFRESH_COUNTED_YOUNG_GENERATION_BYTES);
  if (partitionedBytes < requiredHeapBytes) fail("ANALYTICS_V2_REFRESH_HEAP_INSUFFICIENT");
  const outputBudgetBytes = Math.min(partitionedBytes - reservedBytes, MAX_OUTPUT_BUDGET_BYTES);
  // K-PAR-MEM: the compute Workers share the task memory the main heap and
  // the native reserve leave. The pool must run the largest owner the budget
  // admits at its modelled heap, alone (analytics-refresh-pool.mjs).
  let workerPool = null;
  if (workers > 1) {
    // A V8 heap flag is process-wide: it overrides every Worker's
    // resourceLimits (in both directions), so the pool's limits and its
    // admission would not hold. Compute Workers run with the main heap at
    // V8's default; the Workers re-check their limits (analytics-refresh-pool.mjs).
    const flags = [...(Array.isArray(execArgv) ? execArgv : []),
      ...(typeof env?.NODE_OPTIONS === "string" ? env.NODE_OPTIONS.split(/\s+/u) : [])];
    if (flags.some((flag) => typeof flag === "string" && ANALYTICS_REFRESH_V8_HEAP_FLAG.test(flag))) {
      fail("ANALYTICS_V2_REFRESH_WORKER_HEAP_FLAG_FORBIDDEN", { usage: true });
    }
    if (!Number.isSafeInteger(taskMemoryBytes) || taskMemoryBytes < 1) fail("ANALYTICS_V2_REFRESH_WORKER_POOL_INSUFFICIENT");
    const poolBytes = taskMemoryBytes - ANALYTICS_REFRESH_TASK_MEMORY_CHECK.nativeReserveMiB * MIB - heapLimitBytes;
    if (poolBytes < analyticsRefreshWorkerPoolMinimumBytes(memoryBudgetBytes)) {
      fail("ANALYTICS_V2_REFRESH_WORKER_POOL_INSUFFICIENT");
    }
    workerPool = Object.freeze({ poolBytes, loadConcurrency: Math.min(workers, ANALYTICS_REFRESH_READ_CONNECTIONS) });
  }
  return Object.freeze({
    compute: Object.freeze({ memoryBudgetBytes, maxDayOccurrences, maxDayRecordBytes, outputBudgetBytes }),
    readChunkOccurrences,
    heapLimitBytes,
    youngGenerationBytes,
    requiredHeapBytes,
    workers,
    workerPool,
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
 * --schema); the measurement refresh Job alone
 * (FASTPATH_MEASUREMENT_CLOUD_TARGET) reaches a disposable measurement
 * instance's fast-path database, a seeded schema only. Anywhere else only a
 * loopback or private-socket PostgreSQL is accepted.
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
    const measurement = env.CLOUD_RUN_JOB === FASTPATH_MEASUREMENT_CLOUD_TARGET.refreshJob;
    const target = fastpath
      ? { instanceConnectionName: FASTPATH_TEST_CLOUD_TARGET.instanceConnectionName,
        database: FASTPATH_TEST_CLOUD_TARGET.database }
      : measurement
        // The measurement Job: any measurement instance (by name), never another.
        ? { instanceConnectionName: isFastpathMeasurementInstanceConnectionName(env.PRIMARY_INSTANCE_CONNECTION_NAME)
          ? env.PRIMARY_INSTANCE_CONNECTION_NAME : null,
        database: FASTPATH_MEASUREMENT_CLOUD_TARGET.database }
        : CLOUD_RUN_IAM_TEST_TARGET.postgres.primary;
    if (target.instanceConnectionName === null || env.PRIMARY_INSTANCE_CONNECTION_NAME !== target.instanceConnectionName
        || env.PRIMARY_DATABASE !== target.database) {
      fail("ANALYTICS_V2_REFRESH_TARGET_FORBIDDEN");
    }
    if (fastpath && !(isFastpathTestSchema(schema) && (schema === FASTPATH_TEST_CLOUD_TARGET.primarySchema
        || schema.startsWith(FASTPATH_TEST_CLOUD_TARGET.seededSchemaPrefix)))) {
      fail("ANALYTICS_V2_REFRESH_TARGET_FORBIDDEN");
    }
    if (measurement && !(isFastpathTestSchema(schema)
        && schema.startsWith(FASTPATH_MEASUREMENT_CLOUD_TARGET.seededSchemaPrefix))) {
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


/** Load the store and the default pipeline (bundled by esbuild from these literals). */
export async function loadAnalyticsV2Modules() {
  const [store, owners, occurrences, devices, queuedDays, compute, ownerSets] = await Promise.all([
    import("../src/analytics-v2/store.ts"),
    import("../src/analytics-v2/owners.ts"),
    import("../src/analytics-v2/occurrence-source.ts"),
    import("../src/analytics-v2/devices.ts"),
    import("../src/analytics-v2/queued-days.ts"),
    import("../src/analytics-v2/compute.ts"),
    import("../src/analytics-v2/owner-sets.ts"),
  ]);
  return Object.freeze({
    store,
    pipeline: createAnalyticsV2Pipeline({ owners, occurrences, devices, queuedDays, compute, ownerSets }),
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
  let workers = 1;
  let ownerIndex = -1;
  let ownersStarted = 0;
  const done = new Set();
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
      ownersStarted,
      ownersPlanned: projections === null ? null : projections.length,
    }),
  });
  const now = () => {
    const value = wallClock();
    if (!Number.isSafeInteger(value)) fail("ANALYTICS_V2_REFRESH_DEADLINE_INVALID");
    return value;
  };
  // The owners not yet done, spread over the run's compute workers (K-PAR): no
  // faster than the largest of them alone. With one worker this is the sum of
  // the remaining owners, as before.
  const remainingMs = () => {
    let total = 0;
    let largest = 0;
    for (const [index, value] of projections.entries()) {
      if (done.has(index)) continue;
      total += value;
      largest = Math.max(largest, value);
    }
    return Math.max(total / workers, largest);
  };
  const analysisUsageOf = (index) => (Number.isSafeInteger(index) && plannedOwners !== null
    && index >= 0 && index < plannedOwners.length && plannedOwners[index].admitted
    ? plannedOwners[index].analysisUsage : 0);
  return Object.freeze({
    active: true,
    checkpoint(event) {
      const at = now();
      if (Number.isSafeInteger(event?.accountBytes) && event.accountBytes >= 0) accountBytes = event.accountBytes;
      if (at > refuseAtMs()) refuse("ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED", at);
      switch (event?.kind) {
        case "plan": {
          if (!Array.isArray(event.owners)) fail("ANALYTICS_V2_REFRESH_DEADLINE_INVALID");
          if (event.workers !== undefined && (!Number.isSafeInteger(event.workers) || event.workers < 1)) {
            fail("ANALYTICS_V2_REFRESH_DEADLINE_INVALID");
          }
          workers = event.workers ?? 1;
          plannedOwners = event.owners;
          projections = event.owners.map(ownerMs);
          plannedMs = remainingMs();
          if (at + plannedMs > refuseAtMs()) refuse("ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED", at, plannedMs);
          break;
        }
        case "owner": {
          if (projections === null || !Number.isSafeInteger(event.index) || event.index >= projections.length) {
            fail("ANALYTICS_V2_REFRESH_DEADLINE_INVALID");
          }
          ownerIndex = event.index;
          ownersStarted += 1;
          const remaining = remainingMs();
          if (at + remaining > refuseAtMs()) refuse("ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED", at, remaining);
          break;
        }
        case "ownerDone": {
          if (projections === null || !Number.isSafeInteger(event.index) || event.index >= projections.length) {
            fail("ANALYTICS_V2_REFRESH_DEADLINE_INVALID");
          }
          done.add(event.index);
          break;
        }
        case "segment": {
          const step = model.stepFactor * (model.readMsPerOccurrence + model.prepareMsPerOccurrence)
            * (Number.isSafeInteger(event.occurrences) ? event.occurrences : 0);
          if (at + step > refuseAtMs()) refuse("ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED", at, step);
          break;
        }
        case "scalar": {
          // Only an admitted owner is read and computed; the event names it.
          const step = model.stepFactor * model.scalarMsPerAnalysisUsage
            * analysisUsageOf(event.ownerIndex ?? ownerIndex);
          if (at + step > refuseAtMs()) refuse("ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED", at, step);
          break;
        }
        case "model": {
          const step = model.stepFactor * model.modelMsPerAnalysisUsage
            * analysisUsageOf(event.ownerIndex ?? ownerIndex) / 70;
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

/**
 * The run's kernel stamp (K-STAMP): the registry entry naming `identity` (or
 * the bundle's own build-time identity), on the compiled baseline manifest.
 * ANALYTICS_V2_KERNEL_UNREGISTERED when no entry names it, including an
 * unbundled run that injected none.
 */
export function analyticsRefreshRunStamp(store, identity) {
  if (typeof store?.resolveAnalyticsV2Kernel !== "function" || typeof store?.analyticsV2BaselineRunStamp !== "function"
      || typeof store?.analyticsV2BundledKernelIdentity !== "function") {
    fail("ANALYTICS_V2_REFRESH_PIPELINE_UNAVAILABLE");
  }
  let kernel;
  const stated = identity ?? store.analyticsV2BundledKernelIdentity();
  try {
    kernel = store.resolveAnalyticsV2Kernel(stated);
  } catch (error) {
    fail(error?.code === "ANALYTICS_V2_KERNEL_REGISTRY_INVALID" ? error.code : "ANALYTICS_V2_KERNEL_UNREGISTERED");
  }
  // K-PERCARD: the bundle's compute class rides on the stamp (null when it stated none).
  return store.analyticsV2BaselineRunStamp(kernel, typeof stated?.computeSha256 === "string" ? stated.computeSha256 : null);
}

/**
 * The receipt's content-free exclusion counts (N-EXCL, the pipeline's closed
 * summary), or null when an injected pipeline reported none.
 */
function exclusionSummary(value) {
  if (value === null || typeof value !== "object"
      || Object.keys(value).sort().join(",") !== "active,changed,excludedOwners,republishedDays,rows"
      || ![value.rows, value.active, value.excludedOwners, value.republishedDays]
        .every((count) => Number.isSafeInteger(count) && count >= 0)
      || typeof value.changed !== "boolean") {
    return null;
  }
  return Object.freeze({ rows: value.rows, active: value.active, excludedOwners: value.excludedOwners,
    changed: value.changed, republishedDays: value.republishedDays });
}

/** R19 hardening (d): the closed refusal of a production first run without the frozen interim read. */
export const ANALYTICS_REFRESH_FIRST_RUN_REFUSAL = "ANALYTICS_V2_FIRST_RUN_BASELINE_ABSENT";

/**
 * The receipt's content-free baseline facts (R19 hardening (d)): whether this
 * is a first run and whether the frozen interim read is loaded. Anything but
 * the store's booleans reads as a first run without the frozen read, so the
 * production gate fails closed.
 */
export function analyticsRefreshBaseline(state) {
  return Object.freeze({
    firstRun: state?.firstRun !== false,
    frozenInterimRead: state?.frozenInterimRead === true,
  });
}

/**
 * The read-snapshot gates of a production target, in order (null when it may
 * run): a first run without the frozen interim read is
 * ANALYTICS_V2_FIRST_RUN_BASELINE_ABSENT; any run without the floor
 * is ANALYTICS_V2_REVISION_FLOOR_ABSENT. Staging and test targets are never
 * gated here.
 */
export function analyticsRefreshBaselineRefusal({ target, baseline, revisionFloor }) {
  if (target !== "production") return null;
  if (baseline?.firstRun !== false && baseline?.frozenInterimRead !== true) {
    return ANALYTICS_REFRESH_FIRST_RUN_REFUSAL;
  }
  if (revisionFloor?.present !== true) return "ANALYTICS_V2_REVISION_FLOOR_ABSENT";
  return null;
}

/**
 * The receipt's content-free revision floor (REV-SEED): whether the cutover's
 * floor is loaded, its day count and its largest revision. Anything but the
 * store's closed summary reads as absent.
 */
function revisionFloorSummary(value) {
  const absent = Object.freeze({ present: false, dayCount: 0, maxRevision: 0 });
  if (value === null || typeof value !== "object"
      || Object.keys(value).sort().join(",") !== "dayCount,maxRevision,present"
      || value.present !== true || !Number.isSafeInteger(value.dayCount) || value.dayCount < 1
      || !Number.isSafeInteger(value.maxRevision) || value.maxRevision < 1 || value.maxRevision > MAX_REVISION_SEED) {
    return absent;
  }
  return Object.freeze({ present: true, dayCount: value.dayCount, maxRevision: value.maxRevision });
}

/**
 * The receipt's content-free price summary (K-PERCARD): the kernel's card
 * count, the cards and bases this run registered, its price rows, and each
 * transition recorded (kernel ids, the verdict and owner-day counts).
 */
function priceSummary(value) {
  const count = (entry) => Number.isSafeInteger(entry) && entry >= 0;
  if (value === null || typeof value !== "object" || !count(value.kernelCards) || !count(value.cardsRegistered)
      || !count(value.basesRegistered) || !count(value.ownerDays) || !Array.isArray(value.transitions)) {
    return null;
  }
  return Object.freeze({ kernelCards: value.kernelCards, cardsRegistered: value.cardsRegistered,
    basesRegistered: value.basesRegistered, ownerDays: value.ownerDays,
    transitions: Object.freeze(value.transitions.filter((entry) => entry !== null && typeof entry === "object"
      && count(entry.fromKernel) && count(entry.toKernel) && typeof entry.compatible === "boolean"
      && count(entry.ownerDays) && count(entry.staleOwnerDays))
      .map((entry) => Object.freeze({ fromKernel: entry.fromKernel, toKernel: entry.toKernel,
        compatible: entry.compatible, ownerDays: entry.ownerDays, staleOwnerDays: entry.staleOwnerDays }))) });
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
function memorySummary(resources, recorded, peakRssBytes, { mainHeapPeakBytes = null, workerPool = null } = {}) {
  const owners = Array.isArray(recorded?.owners) ? recorded.owners : [];
  const toMiB = (bytes) => Math.ceil(bytes / MIB);
  const largest = (values) => values.reduce((maximum, value) => Math.max(maximum, value), 0);
  return Object.freeze({
    model: typeof recorded?.configuration?.memoryModel === "string" ? recorded.configuration.memoryModel : null,
    budgetMiB: toMiB(resources.compute.memoryBudgetBytes),
    workers: resources.workers ?? 1,
    maxDayOccurrences: resources.compute.maxDayOccurrences,
    maxDayRecordMiB: toMiB(resources.compute.maxDayRecordBytes),
    readChunkOccurrences: resources.readChunkOccurrences,
    heapLimitMiB: Math.floor(resources.heapLimitBytes / MIB),
    youngGenerationMiB: Math.floor((resources.youngGenerationBytes ?? 0) / MIB),
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
    mainHeapPeakMiB: Number.isSafeInteger(mainHeapPeakBytes) && mainHeapPeakBytes >= 0 ? toMiB(mainHeapPeakBytes) : null,
    // K-PAR-MEM: the compute Workers' pool and what it did (null inline).
    workerPool: resources.workerPool === null || resources.workerPool === undefined ? null : Object.freeze({
      heapModel: ANALYTICS_REFRESH_WORKER_HEAP_MODEL.version,
      poolMiB: Math.floor(resources.workerPool.poolBytes / MIB),
      loadConcurrency: resources.workerPool.loadConcurrency,
      ...(workerPool === null ? {} : {
        started: workerPool.started,
        retriedAlone: workerPool.retriedAlone,
        peakRunning: workerPool.peakRunning,
        peakChargedMiB: toMiB(workerPool.peakChargedBytes),
        peakLoads: workerPool.peakLoads,
        // model-blocks-metrics: receipt projection only; no time-guard change.
        ...(workerPool.modelBlockedOwners > 0 ? { modelBlocks: Object.freeze({
          blockedOwners: workerPool.modelBlockedOwners,
          blocksPerOwner: workerPool.modelBlocksPerOwner,
          grantsRequested: workerPool.blockGrantsRequested,
          grantsGranted: workerPool.blockGrantsGranted,
          grantsRefused: workerPool.blockGrantsRefused,
          ownerEvaluatedBlocks: workerPool.modelBlockedOwners + workerPool.blockGrantsRefused,
          serializedBytes: workerPool.blockSerializedBytes,
          cloneMs: workerPool.blockCloneMs,
          evaluationMs: workerPool.blockEvaluationMs,
          heapPeakBytes: workerPool.blockHeapPeakBytes,
          measurements: workerPool.blockMeasurements,
        }) } : {}),
        largestGcCallbackHeapMiB: workerPool.largestGcCallbackHeapBytes === null
          ? null : toMiB(workerPool.largestGcCallbackHeapBytes),
        largestGcCallbackHeapPercentOfLimit: workerPool.largestGcCallbackHeapShareOfLimit === null
          ? null : Math.ceil(workerPool.largestGcCallbackHeapShareOfLimit * 100),
      }),
    }),
  });
}

/** Samples the main heap's used size every few seconds until stopped; peak() is the largest seen. */
function sampleMainHeap(intervalMs = 2_000) {
  let peak = 0;
  const sample = () => { peak = Math.max(peak, getHeapStatistics().used_heap_size); };
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref?.();
  return Object.freeze({
    peak: () => { sample(); return peak; },
    stop: () => clearInterval(timer),
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
 * modules ({store, pipeline}), wallClock(), randomUUID(), heapLimitBytes, execArgv, peakRssBytes(),
 * createProfiler(options), writeProfileLine(line), profileSignals (false: no SIGTERM handler).
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
    workers: parsed.workers,
  };
  let phase = "configuration";
  // The main heap's peak, sampled (operational metadata: it sizes the main
  // heap of a compute-Worker profile; no decision reads it).
  const mainHeap = sampleMainHeap();
  let ownerPool;
  let connector;
  let pool;
  let client;
  let locked = false;
  let readOpen = false;
  let discard = false;
  let receipt;
  let failure;
  let profiler = null;
  let workerProfiles = null;
  let onSignal = null;
  try {
    const production = await readAnalyticsRefreshProductionTarget(env);
    if (production !== null) base.target = production.target;
    const workerProfileSettings = readWorkerProfileSettings(env, { target: production?.target ?? null });
    if (workerProfileSettings !== null) workerProfiles = createWorkerProfileCoordinator(workerProfileSettings,
      { workerUrl: dependencies.workerUrl ?? new URL("./analytics-refresh-worker.mjs", import.meta.url) });
    const resources = analyticsRefreshResources(env,
      dependencies.heapLimitBytes ?? getHeapStatistics().heap_size_limit,
      // An injected heap limit is not this process's, so neither are its flags.
      { workers: parsed.workers,
        execArgv: dependencies.execArgv ?? (dependencies.heapLimitBytes === undefined ? process.execArgv : []) });
    const guard = createAnalyticsRefreshTimeGuard({ startedAtMs,
      taskTimeoutMs: analyticsRefreshTaskTimeoutMs(env, production), wallClock });
    // The opt-in profiler starts before the first refusal that can follow, so
    // a refused or failed run still leaves its exit summary.
    const profileSettings = readAnalyticsRefreshProfileSettings(env, { target: production?.target ?? null });
    if (profileSettings !== null) {
      profiler = await (dependencies.createProfiler ?? createAnalyticsRefreshProfiler)({
        settings: profileSettings,
        phase: () => phase,
        wallClock,
        bundleUrls: [import.meta.url],
        ...(dependencies.writeProfileLine === undefined ? {} : { write: dependencies.writeProfileLine }),
      });
      profiler.start();
      if (dependencies.profileSignals !== false) {
        // Cloud Run's task timeout and a cancel send SIGTERM: fold the last
        // window, then end as the default handler would.
        onSignal = () => {
          process.off("SIGTERM", onSignal);
          try { profiler.finishNow("signal"); } finally { process.kill(process.pid, "SIGTERM"); }
        };
        process.on("SIGTERM", onSignal);
      }
    }
    const checkpoint = profiler === null ? guard.checkpoint : (event) => {
      profiler.checkpoint(event);
      guard.checkpoint(event);
    };
    // A deadline that leaves no room for the write and the exit is refused
    // before any module, pool or lock.
    guard.checkpoint(Object.freeze({ kind: "start" }));
    const database = await resolveAnalyticsRefreshDatabase(env, { schema: parsed.schema });
    phase = "modules";
    const modules = dependencies.modules ?? await loadAnalyticsV2Modules();
    const { store, pipeline } = modules ?? {};
    if (typeof store?.writeRunOutputs !== "function"
        || typeof store?.readAnalyticsV2RefreshState !== "function"
        || typeof store?.proveAnalyticsV2PriceTransitions !== "function"
        || typeof pipeline?.read !== "function" || typeof pipeline?.compute !== "function") {
      fail("ANALYTICS_V2_REFRESH_PIPELINE_UNAVAILABLE");
    }
    // K-STAMP: the kernel this bundle is, from its build-time identity (a
    // spec running the sources unbundled injects one); refused before any
    // connection when no kernel-registry.json entry names it.
    const stamp = analyticsRefreshRunStamp(store, dependencies.kernelIdentity);
    base.kernel = Object.freeze({ kernelId: stamp.kernel.kernelId, manifestVersion: stamp.manifestVersion });
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
      // REV-SEED: a production run publishes only above Cloudflare's last
      // revisions, so it refuses before any read or compute without the
      // floor the cutover import loads. R19 (d): a production first run also
      // needs the frozen interim read, and refuses first when it is absent
      // even if the floor is loaded. Staging and test targets publish above
      // whatever floor is stored, none being 0.
      const revisionFloor = revisionFloorSummary(state?.revisionFloor);
      base.revisionFloor = revisionFloor;
      const baseline = analyticsRefreshBaseline(state);
      base.baseline = baseline;
      const baselineRefusal = analyticsRefreshBaselineRefusal({ target: production?.target, baseline, revisionFloor });
      if (baselineRefusal !== null) fail(baselineRefusal);
      // K-PERCARD: prove the transitions from older stored kernels to this
      // one over their stored price inputs, in the read snapshot; the write
      // re-checks the proof and records it.
      const priceTransitions = await store.proveAnalyticsV2PriceTransitions(client, { schema: parsed.schema, stamp });
      // K-PGSTAT: the read side's round trips by statement family, and the
      // server's execution and planning time for the same families when
      // pg_stat_statements is readable (snapshots on their own connection).
      const ledger = createAnalyticsRefreshStatementLedger();
      const serverBefore = await readAnalyticsRefreshServerStatements(pool);
      const readPool = createSnapshotReadPool(pool, snapshot, { ledger });
      if (parsed.workers > 1) {
        ownerPool = (dependencies.createOwnerPool ?? createAnalyticsRefreshOwnerPool)({
          ...(workerProfiles === null ? {} : { profileCapture: workerProfiles }),
          workers: parsed.workers, memoryBudgetBytes: resources.compute.memoryBudgetBytes,
          modelBlockSize: parsed.modelBlockSize, modelFanOut: parsed.modelFanOut,
          poolBytes: resources.workerPool.poolBytes, loadConcurrency: resources.workerPool.loadConcurrency,
          ...(dependencies.workerUrl === undefined ? {} : { workerUrl: dependencies.workerUrl }) });
      }
      let inputs;
      let outputs;
      let readMs;
      let reads;
      try {
        inputs = await pipeline.read({
          pool: readPool,
          schema: parsed.schema,
          nowMs,
          state,
          revisionSeed: parsed.revisionSeed,
          resources,
          checkpoint,
          // READ-PLAN: the merged evidence pass uses the run's snapshot
          // read connections. Count validation remains after range checks;
          // Cloud SQL timeout margin is a separate combined-candidate gate.
          readConcurrency: ANALYTICS_REFRESH_READ_CONNECTIONS,
          loadConcurrency: resources.workerPool?.loadConcurrency ?? 1,
        });
        readMs = Math.max(0, wallClock() - readStartedMs);
        // Owners are read in the same snapshot while they are computed.
        phase = "compute";
        outputs = await pipeline.compute(inputs, {
          mode: parsed.mode,
          nowMs,
          revisionSeed: parsed.revisionSeed,
          ...(guard.active || profiler !== null ? { checkpoint } : {}),
          ...(ownerPool === undefined ? {} : { ownerPool }),
        });
        const statements = ledger.summary();
        const loadWallMs = typeof inputs?.loadWallMs === "function" ? inputs.loadWallMs() : 0;
        const phaseWallMs = Math.round(readMs + (Number.isFinite(loadWallMs) ? loadWallMs : 0));
        reads = Object.freeze({
          model: ANALYTICS_REFRESH_STATEMENT_MODEL,
          // The listing, journal and counts before compute, plus every owner
          // load (main-thread wall time); the rest of it is client work
          // between round trips (decode, digest, reconcile).
          phaseWallMs,
          statements,
          unattributedMs: Math.max(0, phaseWallMs - statements.wallMs),
          server: analyticsRefreshServerStatementDelta(serverBefore, await readAnalyticsRefreshServerStatements(pool)),
        });
      } finally {
        // Drain streamed loads before closing their snapshot readers. An
        // aborted Worker can leave a bounded read call in flight.
        try {
          if (ownerPool !== undefined) await ownerPool.abort();
        } finally {
          await readPool.close();
        }
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
        stamp,
        // N-EXCL: the exclusions this run applied (the store refuses a run without them).
        exclusionsSha256: outputs.exclusionsSha256,
        priceTransitions,
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
        // E-OWNERSET: counts and days only (never an owner).
        ownerSets: written.publication.ownerSets,
        cursor: written.cursor,
        timings: written.timings,
        memory: memorySummary(resources, outputs.resources, (dependencies.peakRssBytes ?? defaultPeakRssBytes)(),
          { mainHeapPeakBytes: mainHeap.peak(), workerPool: ownerPool?.stats?.() ?? null }),
        reads,
        exclusions: exclusionSummary(outputs.exclusions),
        prices: priceSummary(written.prices),
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
    if (ownerPool !== undefined) {
      try { await ownerPool.abort(); } catch { /* every Worker is terminated or gone */ }
    }
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
    if (workerProfiles !== null) {
      try { workerProfiles.finish({ analyticsRunId: receipt?.runId ?? null }); } catch {
        try { process.stderr.write(`${JSON.stringify({ workerProfile: "local-isolate-v1", coverage: "incomplete",
          error: "WORKER_PROFILE_MANIFEST_FAILED" })}\n`); } catch { /* retain computation outcome */ }
      }
    }
    if (profiler !== null) {
      if (onSignal !== null) process.off("SIGTERM", onSignal);
      // The exit summary precedes the receipt or error line main() writes.
      await profiler.finish(failure === undefined ? "exit" : "exit-failed");
    }
  }
  mainHeap.stop();
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
