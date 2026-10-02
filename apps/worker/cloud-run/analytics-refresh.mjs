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
 *      admitted owner is then read in the same snapshot, computed and
 *      released, so the heap holds the largest owner, not the corpus. The
 *      exporting transaction stays open until the last read;
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
 * Flags:
 *   --mode=full            required; the only mode tonight
 *   --schema=<identifier>  runtime (primary) schema; defaults to PRIMARY_SCHEMA
 *   --now=<ISO instant>    pin the clock; accepted only under a test clock
 *                          (ANALYTICS_V2_TEST_CLOCK=1 or a POSTGRES_TEST_HTTP_MODE)
 *   --revision-seed=<n>    published revisions start above n (default 0)
 *   --help
 *
 * Resources (environment; defaults sized for an 8 GiB task whose Node heap
 * is --max-old-space-size=6144; each value must lie within its bounds):
 *   ANALYTICS_V2_MEMORY_BUDGET_MIB       per-owner memory estimate budget
 *                                        (default 4608, 1024..30720); an owner
 *                                        over it is refused with memory_budget
 *   ANALYTICS_V2_MAX_DAY_OCCURRENCES     owner-day backstop (default 250000,
 *                                        20000..250000)
 *   ANALYTICS_V2_MAX_DAY_RECORD_MIB      owner-day record bytes backstop
 *                                        (default 256, 32..256)
 *   ANALYTICS_V2_READ_CHUNK_OCCURRENCES  occurrences one read call targets
 *                                        (default 250000, 10000..2000000)
 * The run refuses to start (ANALYTICS_V2_REFRESH_HEAP_INSUFFICIENT) unless
 * the heap limit covers the budget plus the reserve: 512 MiB plus 4 KiB per
 * read-chunk occurrence.
 *
 * Database: in a Cloud Run Job (CLOUD_RUN_JOB set) it connects through
 * cloud-sql.mjs createIamPool and, until cutover, only to the private test
 * primary instance (production refusal stays in place). Elsewhere it needs a
 * local endpoint: PG_TEST_SOCKET (a private /private/tmp/tibotattle-pg-*
 * socket directory) or a loopback PG_TEST_HOST, with PG_TEST_PORT.
 *
 * Output: one content-free JSON receipt line on stdout (counts and calendar
 * days only), or one JSON error line with a closed code on stderr. Exit 0 for
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
import { FASTPATH_TEST_CLOUD_TARGET, isFastpathTestSchema } from "./origin-fastpath-mode.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./postgres-test-dispatch.mjs";

/** Mirrors contract.ts ANALYTICS_V2_REFRESH_ENTRY; the spec pins the equality. */
export const ANALYTICS_REFRESH_ENTRY = "analytics-refresh";
/** Mirrors contract.ts ANALYTICS_V2_REFRESH_LOCK_KEY; the spec pins the equality. */
export const ANALYTICS_REFRESH_LOCK_KEY = "analytics_v2_refresh";
export const ANALYTICS_REFRESH_RECEIPT_VERSION = "analytics-refresh-receipt-v1";
export const ANALYTICS_REFRESH_MODES = Object.freeze(["full"]);
/** POSTGRES_TEST_HTTP_MODE values the host accepts (server.mjs postgresTestHttpMode). */
const TEST_HTTP_MODES = new Set(["health-only", "health-and-v12-day-manifest", "cloud-run-iam", "fastpath-test"]);
const FLAG = /^--([a-z][a-z-]*)=(.*)$/su;
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
 * Heap the Job keeps outside the per-owner budget: fixed headroom for the
 * accumulated outputs of earlier owners and the community fold, plus the
 * reader's transient per candidate of one read call (an estimate: decoded
 * sources and reconciliation state of one expansion batch per candidate).
 */
export const ANALYTICS_REFRESH_HEAP_RESERVE = Object.freeze({ fixedBytes: 512 * MIB, bytesPerReadCandidate: 4_096 });
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

Resources (environment, within bounds): ANALYTICS_V2_MEMORY_BUDGET_MIB (4608),
ANALYTICS_V2_MAX_DAY_OCCURRENCES (250000), ANALYTICS_V2_MAX_DAY_RECORD_MIB (256),
ANALYTICS_V2_READ_CHUNK_OCCURRENCES (250000). The Node heap limit must cover the
budget plus 512 MiB plus 4 KiB per read-chunk occurrence (run the Job with
--max-old-space-size=6144 for the defaults).
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
 * The run's resources from the environment, and the heap they need. Refused
 * before any connection: a value outside its bounds
 * (ANALYTICS_V2_REFRESH_RESOURCES_INVALID), or a heap limit below the budget
 * plus the reserve (ANALYTICS_V2_REFRESH_HEAP_INSUFFICIENT), so an owner the
 * guard admits cannot exhaust the heap by design.
 */
export function analyticsRefreshResources(env, heapLimitBytes) {
  const spec = ANALYTICS_REFRESH_RESOURCE_ENV;
  const memoryBudgetBytes = resourceValue(env, spec.memoryBudgetMiB) * MIB;
  const maxDayOccurrences = resourceValue(env, spec.maxDayOccurrences);
  const maxDayRecordBytes = resourceValue(env, spec.maxDayRecordMiB) * MIB;
  const readChunkOccurrences = resourceValue(env, spec.readChunkOccurrences);
  const requiredHeapBytes = memoryBudgetBytes + ANALYTICS_REFRESH_HEAP_RESERVE.fixedBytes
    + readChunkOccurrences * ANALYTICS_REFRESH_HEAP_RESERVE.bytesPerReadCandidate;
  if (!Number.isSafeInteger(heapLimitBytes) || heapLimitBytes < requiredHeapBytes) {
    fail("ANALYTICS_V2_REFRESH_HEAP_INSUFFICIENT");
  }
  return Object.freeze({
    compute: Object.freeze({ memoryBudgetBytes, maxDayOccurrences, maxDayRecordBytes }),
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
 * The database target. A Cloud Run Job may reach only the private test
 * primary until cutover: the shared test database, or, for the fast-path
 * refresh Job alone, the disposable fast-path database and only a pinned or
 * seeded fast-path schema (`schema`, the parsed --schema). Anywhere else
 * only a loopback or private-socket PostgreSQL is accepted.
 */
export async function resolveAnalyticsRefreshDatabase(env = {}, { schema } = {}) {
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
 * Effective owners are counted over the whole range during read and loaded
 * over it, one at a time, during compute: every stream in contiguous spans of
 * at most MAX_ANALYTICS_V2_OCCURRENCE_DAYS days and, by the counts, about the
 * read chunk of occurrences. A-2 skips the load of an owner its memory guard
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
    async read({ pool, schema, nowMs, state, resources }) {
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

      // One effective owner's occurrences over the whole range, in spans of
      // about the read chunk by its exact counts. Called by A-2 only while the
      // run's read snapshot is open (runAnalyticsRefresh closes it after compute).
      const loadOwnerOccurrences = async (ownerDigest) => {
        const counts = streamCounts.get(ownerDigest);
        if (counts === undefined) fail("ANALYTICS_V2_REFRESH_OCCURRENCES_INVALID");
        return readOwnerDays(context, ownerDigest, (stream) =>
          analyticsRefreshReadSpans(occurrenceRange, chunkDays, counts[stream], readChunk).map((span) => ({
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
    async compute(inputs, { nowMs, revisionSeed, memoryProbe = defaultMemoryProbe }) {
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
        ...(inputs.resources === undefined ? {} : { resources: inputs.resources }),
        memoryProbe,
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
  });
}

function countBy(values, key) {
  const counts = {};
  for (const value of values) counts[key(value)] = (counts[key(value)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => (left < right ? -1 : 1)));
}

/**
 * Run one refresh. dependencies (tests and the composition root only):
 * createPool(database, {connector}), createConnector(), closeResources(),
 * modules ({store, pipeline}), wallClock(), randomUUID(), heapLimitBytes, peakRssBytes().
 * Returns the receipt; throws an error carrying a closed code and phase.
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
    const resources = analyticsRefreshResources(env,
      dependencies.heapLimitBytes ?? getHeapStatistics().heap_size_limit);
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
      // must outlive the last owner's read.
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
        });
        readMs = Math.max(0, wallClock() - readStartedMs);
        // Owners are read in the same snapshot while they are computed.
        phase = "compute";
        outputs = await pipeline.compute(inputs, {
          mode: parsed.mode,
          nowMs,
          revisionSeed: parsed.revisionSeed,
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
    })}\n`);
    process.exitCode = error?.usage === true ? 2 : 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
