import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { syncPreparedContributionEntryOnce } from "./contribution-device-sync.js";
import { readBoundedDirectoryEntries } from "./export-resource-policy.js";
import { syncDirectory, stableJson } from "./storage.js";
import {
  loadVerifiedPreparedContribution,
  PREPARED_CONTRIBUTION_SET_MANIFEST,
  verifyPreparedContributionSet,
} from "./telemetry-prepared-set.js";
import {
  TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
} from "./telemetry-contribution-builder.js";

export const CONTRIBUTION_SYNC_QUEUE_SCHEMA =
  "contribution-sync-queue-v0.1";
export const CONTRIBUTION_SYNC_STATUS_SCHEMA =
  "contribution-sync-status-v0.1";
export const CONTRIBUTION_SYNC_PREVIEW_SCHEMA =
  "contribution-sync-preview-v0.1";

const SQLITE_USER_VERSION = 1;
const MAX_QUEUE_BYTES = 128 * 1024 * 1024;
const MAX_QUEUE_JOBS = 25_600;
const MAX_DISCOVERED_SETS = 256;
const DEFAULT_MAXIMUM_ATTEMPTS = 8;
const DEFAULT_LEASE_MILLISECONDS = 10 * 60 * 1000;
const DEFAULT_MAXIMUM_JOBS_PER_PASS = 25;
const MAXIMUM_JOBS_PER_PASS = 100;
const MINIMUM_RESERVED_UPLOAD_BYTES_PER_PASS = 16 * 1024;
const DEFAULT_MAXIMUM_RESERVED_UPLOAD_BYTES_PER_PASS = 16 * 1024 * 1024;
const MAXIMUM_RESERVED_UPLOAD_BYTES_PER_PASS = 256 * 1024 * 1024;
const RESERVED_UPLOAD_ENVELOPE_OVERHEAD_BYTES = 8 * 1024;
const MINIMUM_WATCH_INTERVAL_SECONDS = 30;
const MAXIMUM_WATCH_INTERVAL_SECONDS = 3600;
const SET_NAME =
  /^prepared-set-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CONTRIBUTION_ID =
  /^contribution:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const JOB_STATES = Object.freeze([
  "pending",
  "in_flight",
  "accepted",
  "retryable",
  "rejected",
]);
const RETRYABLE_STATES = Object.freeze(["pending", "retryable"]);

const ERROR_CODES = new Set([
  "configuration_invalid",
  "queue_invalid",
  "queue_unavailable",
  "prepared_root_invalid",
  "job_limit",
]);

export class ContributionSyncQueueError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown contribution sync queue error code");
    }
    super("Contribution sync queue failed");
    this.name = "ContributionSyncQueueError";
    this.code = `contribution_sync_queue_${code}`;
  }
}

function fail(code) {
  throw new ContributionSyncQueueError(code);
}

function iso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("configuration_invalid");
  return date.toISOString();
}

function nowMilliseconds(now) {
  const value = typeof now === "function" ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("configuration_invalid");
  return date.getTime();
}

function queueTimestamp(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function conservativeUploadReservationBytes(preparedBytes) {
  if (!integer(preparedBytes, 0, Number.MAX_SAFE_INTEGER)) {
    fail("configuration_invalid");
  }
  const reservation = (preparedBytes * 2)
    + RESERVED_UPLOAD_ENVELOPE_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(reservation)) fail("configuration_invalid");
  return reservation;
}

function assertOwnerOnlyDirectory(stats) {
  if (!stats.isDirectory() || stats.isSymbolicLink()
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail("queue_invalid");
  }
}

function assertOwnerOnlyQueueFile(stats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || stats.size < 0 || stats.size > MAX_QUEUE_BYTES
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail("queue_invalid");
  }
}

async function prepareQueueFile(queueFile) {
  if (typeof queueFile !== "string" || queueFile.length < 1) {
    fail("configuration_invalid");
  }
  const requested = resolve(queueFile);
  const requestedParent = dirname(requested);
  try {
    await mkdir(requestedParent, { recursive: true, mode: 0o700 });
    const parentStats = await lstat(requestedParent);
    assertOwnerOnlyDirectory(parentStats);
    const canonicalParent = await realpath(requestedParent);
    const canonicalStats = await lstat(canonicalParent);
    assertOwnerOnlyDirectory(canonicalStats);
    if (parentStats.dev !== canonicalStats.dev
        || parentStats.ino !== canonicalStats.ino) {
      fail("queue_invalid");
    }
    const selected = join(canonicalParent, basename(requested));
    let handle;
    try {
      handle = await open(
        selected,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = null;
      await syncDirectory(canonicalParent);
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== "EEXIST") throw error;
    }
    const before = await lstat(selected);
    assertOwnerOnlyQueueFile(before);
    await chmod(selected, 0o600);
    return {
      path: selected,
      identity: { dev: before.dev, ino: before.ino },
    };
  } catch (error) {
    if (error instanceof ContributionSyncQueueError) throw error;
    fail("queue_unavailable");
  }
}

function createSchema(database, createdAt) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS queue_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version TEXT NOT NULL,
      paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS contribution_jobs (
      job_id TEXT PRIMARY KEY,
      prepared_set_id TEXT NOT NULL,
      set_name TEXT NOT NULL,
      contribution_basename TEXT NOT NULL,
      contribution_sha256 TEXT NOT NULL,
      contribution_bytes INTEGER NOT NULL,
      schema_version TEXT NOT NULL,
      covered_start_at TEXT NOT NULL,
      covered_end_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN ('pending', 'in_flight', 'accepted', 'retryable', 'rejected')
      ),
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
      next_attempt_at TEXT,
      last_error_code TEXT,
      contribution_id TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      accepted_at TEXT,
      UNIQUE (prepared_set_id, contribution_basename)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS contribution_jobs_due
      ON contribution_jobs (state, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS contribution_jobs_set
      ON contribution_jobs (prepared_set_id, contribution_basename);
  `);
  database.prepare(`
    INSERT OR IGNORE INTO queue_meta (
      singleton, schema_version, paused, created_at, updated_at
    ) VALUES (1, ?, 0, ?, ?)
  `).run(CONTRIBUTION_SYNC_QUEUE_SCHEMA, createdAt, createdAt);
  database.exec(`PRAGMA user_version = ${SQLITE_USER_VERSION}`);
}

async function openQueueDatabase(queueFile, now) {
  const selected = await prepareQueueFile(queueFile);
  let database;
  try {
    database = new DatabaseSync(selected.path, {
      open: true,
      readOnly: false,
      enableForeignKeyConstraints: true,
      allowExtension: false,
      timeout: 5000,
    });
    database.exec("PRAGMA trusted_schema = OFF");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA temp_store = MEMORY");
    database.exec("PRAGMA secure_delete = ON");
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("PRAGMA synchronous = FULL");
    const version = Number(
      Object.values(database.prepare("PRAGMA user_version").get())[0],
    );
    if (version === 0) createSchema(database, iso(now()));
    else if (version !== SQLITE_USER_VERSION) fail("queue_invalid");
    const check = database.prepare("PRAGMA quick_check(1)").get();
    if (Object.values(check)[0] !== "ok") fail("queue_invalid");
    const meta = database.prepare(`
      SELECT schema_version, paused
        FROM queue_meta
       WHERE singleton = 1
    `).get();
    if (meta?.schema_version !== CONTRIBUTION_SYNC_QUEUE_SCHEMA
        || ![0, 1].includes(meta?.paused)) {
      fail("queue_invalid");
    }
    const after = await lstat(selected.path);
    assertOwnerOnlyQueueFile(after);
    if (after.dev !== selected.identity.dev || after.ino !== selected.identity.ino) {
      fail("queue_invalid");
    }
    return database;
  } catch (error) {
    database?.close();
    if (error instanceof ContributionSyncQueueError) throw error;
    fail("queue_invalid");
  }
}

function transaction(database, operation) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original fixed error boundary.
    }
    throw error;
  }
}

async function canonicalPreparedRoot(directory) {
  if (typeof directory !== "string" || directory.length < 1) {
    fail("configuration_invalid");
  }
  try {
    const requested = resolve(directory);
    const requestedStats = await lstat(requested);
    assertOwnerOnlyDirectory(requestedStats);
    const canonical = await realpath(requested);
    const canonicalStats = await lstat(canonical);
    assertOwnerOnlyDirectory(canonicalStats);
    if (requestedStats.dev !== canonicalStats.dev
        || requestedStats.ino !== canonicalStats.ino) {
      fail("prepared_root_invalid");
    }
    return canonical;
  } catch (error) {
    if (error instanceof ContributionSyncQueueError) {
      if (error.code.endsWith("_queue_invalid")) fail("prepared_root_invalid");
      throw error;
    }
    fail("prepared_root_invalid");
  }
}

async function manifestExists(directory) {
  try {
    const stats = await lstat(join(
      directory,
      PREPARED_CONTRIBUTION_SET_MANIFEST,
    ));
    return stats.isFile() && !stats.isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail("prepared_root_invalid");
  }
}

function preparedSetId(manifest) {
  return createHash("sha256").update(stableJson(manifest)).digest("hex");
}

/**
 * Accept either one direct prepared set or an owner-only spool whose immediate
 * child names are generated `prepared-set-<uuid>` directories. Unrecognized
 * loose files and directories are never queued.
 */
export async function discoverCommittedPreparedSets({
  directory,
  verifySet = verifyPreparedContributionSet,
} = {}) {
  if (typeof verifySet !== "function") fail("configuration_invalid");
  const root = await canonicalPreparedRoot(directory);
  const discovered = [];
  if (await manifestExists(root)) {
    const manifest = await verifySet({
      directory: root,
      builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    });
    discovered.push({
      setName: ".",
      directory: root,
      preparedSetId: preparedSetId(manifest),
      manifest,
    });
    return discovered;
  }

  let names;
  try {
    names = await readBoundedDirectoryEntries(root, {
      maximumEntries: MAX_DISCOVERED_SETS,
    });
  } catch {
    fail("prepared_root_invalid");
  }
  for (const name of names.sort()) {
    if (!SET_NAME.test(name)) continue;
    const child = join(root, name);
    let stats;
    try {
      stats = await lstat(child);
      assertOwnerOnlyDirectory(stats);
    } catch (error) {
      if (error instanceof ContributionSyncQueueError) {
        fail("prepared_root_invalid");
      }
      fail("prepared_root_invalid");
    }
    const manifest = await verifySet({
      directory: child,
      builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    });
    discovered.push({
      setName: name,
      directory: child,
      preparedSetId: preparedSetId(manifest),
      manifest,
    });
  }
  return discovered;
}

function validateCoveredAt(payload) {
  const startAt = payload?.coveredAt?.startAt;
  const endAt = payload?.coveredAt?.endAt;
  if (typeof startAt !== "string" || typeof endAt !== "string"
      || iso(startAt) !== startAt || iso(endAt) !== endAt
      || Date.parse(startAt) > Date.parse(endAt)) {
    fail("queue_invalid");
  }
  return { startAt, endAt };
}

async function enqueueDiscoveredSets({
  database,
  sets,
  now,
  loadContribution,
  maximumQueuedJobs,
}) {
  const timestamp = iso(now());
  const insert = database.prepare(`
    INSERT OR IGNORE INTO contribution_jobs (
      job_id, prepared_set_id, set_name, contribution_basename,
      contribution_sha256, contribution_bytes, schema_version,
      covered_start_at, covered_end_at, state, attempt_count,
      next_attempt_at, last_error_code, contribution_id,
      lease_token, lease_expires_at, created_at, updated_at, accepted_at
    ) SELECT
      ?, ?, ?, ?, ?, ?, 'telemetry-contribution-v0.1',
      ?, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, ?, ?, NULL
     WHERE (SELECT COUNT(*) FROM contribution_jobs) < ?
  `);
  const existing = database.prepare(`
    SELECT 1 AS present
      FROM contribution_jobs
     WHERE prepared_set_id = ? AND contribution_basename = ?
  `);
  let inserted = 0;
  let alreadyQueued = 0;
  for (const set of sets) {
    if (!SHA256.test(set.preparedSetId)
        || (set.setName !== "." && !SET_NAME.test(set.setName))) {
      fail("queue_invalid");
    }
    for (const entry of set.manifest.files) {
      const payload = await loadContribution({
        directory: set.directory,
        entry,
      });
      const covered = validateCoveredAt(payload);
      const result = transaction(database, () => insert.run(
        randomUUID(),
        set.preparedSetId,
        set.setName,
        entry.basename,
        entry.sha256,
        entry.bytes,
        covered.startAt,
        covered.endAt,
        timestamp,
        timestamp,
        timestamp,
        maximumQueuedJobs,
      ));
      if (result.changes === 0) {
        if (!existing.get(set.preparedSetId, entry.basename)) fail("job_limit");
        alreadyQueued += 1;
      }
      inserted += Number(result.changes);
    }
  }
  return { inserted, existing: alreadyQueued };
}

function recoverExpiredLeases(database, timestamp) {
  return database.prepare(`
    UPDATE contribution_jobs
       SET state = 'retryable',
           next_attempt_at = ?,
           last_error_code = 'lease_expired',
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = ?
     WHERE state = 'in_flight'
       AND lease_expires_at <= ?
  `).run(timestamp, timestamp, timestamp);
}

function statusFromDatabase(database, timestamp) {
  const counts = Object.fromEntries(JOB_STATES.map((state) => [state, 0]));
  for (const row of database.prepare(`
    SELECT state, COUNT(*) AS count
      FROM contribution_jobs
     GROUP BY state
  `).all()) {
    if (!JOB_STATES.includes(row.state)) fail("queue_invalid");
    counts[row.state] = Number(row.count);
  }
  const meta = database.prepare(`
    SELECT paused, created_at, updated_at
      FROM queue_meta
     WHERE singleton = 1
  `).get();
  const due = database.prepare(`
    SELECT COUNT(*) AS count
      FROM contribution_jobs
     WHERE state IN ('pending', 'retryable')
       AND next_attempt_at <= ?
  `).get(timestamp);
  const next = database.prepare(`
    SELECT MIN(next_attempt_at) AS value
      FROM contribution_jobs
     WHERE state IN ('pending', 'retryable')
  `).get();
  const lastAccepted = database.prepare(`
    SELECT MAX(accepted_at) AS value
      FROM contribution_jobs
     WHERE state = 'accepted'
  `).get();
  return Object.freeze({
    schemaVersion: CONTRIBUTION_SYNC_STATUS_SCHEMA,
    paused: meta.paused === 1,
    counts: Object.freeze(counts),
    dueNow: Number(due.count),
    nextAttemptAt: next.value ?? null,
    lastAcceptedAt: lastAccepted.value ?? null,
  });
}

export function defaultContributionSyncQueueFile() {
  return resolve(
    process.cwd(),
    ".usage-monitor",
    "private",
    "contribution-sync-v0.1.sqlite3",
  );
}

export async function inspectContributionSyncQueue({
  queueFile = defaultContributionSyncQueueFile(),
  now = () => new Date(),
} = {}) {
  const database = await openQueueDatabase(queueFile, now);
  try {
    const timestamp = iso(now());
    recoverExpiredLeases(database, timestamp);
    return statusFromDatabase(database, timestamp);
  } finally {
    database.close();
  }
}

export async function setContributionSyncPaused({
  paused,
  queueFile = defaultContributionSyncQueueFile(),
  now = () => new Date(),
} = {}) {
  if (typeof paused !== "boolean") fail("configuration_invalid");
  const database = await openQueueDatabase(queueFile, now);
  try {
    const timestamp = iso(now());
    database.prepare(`
      UPDATE queue_meta
         SET paused = ?, updated_at = ?
       WHERE singleton = 1
    `).run(paused ? 1 : 0, timestamp);
    return statusFromDatabase(database, timestamp);
  } finally {
    database.close();
  }
}

function boundedErrorCode(error, fallback) {
  const code = error?.code;
  if (typeof code === "string"
      && /^[a-z0-9_]{1,80}$/u.test(code)) {
    return code;
  }
  return fallback;
}

function retryDelayMilliseconds(attemptCount, random) {
  const base = Math.min(3_600_000, 5000 * (2 ** Math.max(0, attemptCount - 1)));
  const jitter = 0.75 + (Math.min(1, Math.max(0, random())) * 0.5);
  return Math.max(1000, Math.round(base * jitter));
}

function claimJob(database, jobId, timestamp, leaseExpiresAt) {
  const leaseToken = randomUUID();
  const result = transaction(database, () => {
    const changed = database.prepare(`
      UPDATE contribution_jobs
         SET state = 'in_flight',
             attempt_count = attempt_count + 1,
             next_attempt_at = NULL,
             last_error_code = NULL,
             lease_token = ?,
             lease_expires_at = ?,
             updated_at = ?
       WHERE job_id = ?
         AND state IN ('pending', 'retryable')
         AND next_attempt_at <= ?
    `).run(leaseToken, leaseExpiresAt, timestamp, jobId, timestamp);
    if (changed.changes !== 1) return null;
    return database.prepare(`
      SELECT job_id, prepared_set_id, set_name, contribution_basename,
             contribution_sha256, contribution_bytes, attempt_count
        FROM contribution_jobs
       WHERE job_id = ?
    `).get(jobId);
  });
  return result === null ? null : { ...result, leaseToken };
}

function finishAccepted(database, job, receipt, timestamp) {
  if (!CONTRIBUTION_ID.test(receipt?.contributionId ?? "")) {
    throw new Error("Receipt identity invalid");
  }
  const result = database.prepare(`
    UPDATE contribution_jobs
       SET state = 'accepted',
           contribution_id = ?,
           accepted_at = ?,
           updated_at = ?,
           last_error_code = NULL,
           lease_token = NULL,
           lease_expires_at = NULL
     WHERE job_id = ? AND state = 'in_flight' AND lease_token = ?
  `).run(
    receipt.contributionId,
    timestamp,
    timestamp,
    job.job_id,
    job.leaseToken,
  );
  if (result.changes !== 1) fail("queue_invalid");
}

function finishFailed(database, job, {
  state,
  errorCode,
  nextAttemptAt,
  timestamp,
  pause,
}) {
  transaction(database, () => {
    const result = database.prepare(`
      UPDATE contribution_jobs
         SET state = ?,
             next_attempt_at = ?,
             last_error_code = ?,
             updated_at = ?,
             lease_token = NULL,
             lease_expires_at = NULL
       WHERE job_id = ? AND state = 'in_flight' AND lease_token = ?
    `).run(
      state,
      nextAttemptAt,
      errorCode,
      timestamp,
      job.job_id,
      job.leaseToken,
    );
    if (result.changes !== 1) fail("queue_invalid");
    if (pause) {
      database.prepare(`
        UPDATE queue_meta SET paused = 1, updated_at = ? WHERE singleton = 1
      `).run(timestamp);
    }
  });
}

function entryForJob(set, job) {
  const entry = set?.manifest?.files?.find(
    (candidate) => candidate.basename === job.contribution_basename,
  );
  if (!entry || entry.sha256 !== job.contribution_sha256
      || entry.bytes !== job.contribution_bytes
      || set.setName !== job.set_name) {
    return null;
  }
  return entry;
}

function safeContributionProjection(payload) {
  if (payload?.schemaVersion !== "telemetry-contribution-v0.1"
      || ![
        "macos",
        "linux",
        "windows",
        "other",
        "unknown",
      ].includes(payload.clientPlatform)
      || ![
        "unknown",
        "openai_pre_agentic_pool_2026_07_09",
        "openai_agentic_pool_2026_07_09",
        "anthropic_unknown",
      ].includes(payload.providerPolicyEpoch)
      || !Array.isArray(payload.usageEvents)
      || !Array.isArray(payload.quotaSnapshots)
      || !Array.isArray(payload.activityMarkers)
      || !payload.accounting || typeof payload.accounting !== "object") {
    fail("queue_invalid");
  }
  const coveredAt = validateCoveredAt(payload);
  const recordCounts = {
    usageEvents: payload.usageEvents.length,
    quotaSnapshots: payload.quotaSnapshots.length,
    activityMarkers: payload.activityMarkers.length,
  };
  const total = Object.values(recordCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (!Object.values(recordCounts).every(
    (count) => integer(count, 0, 200),
  ) || !integer(total, 1, 200)) {
    fail("queue_invalid");
  }
  const accounting = payload.accounting;
  const {
    estimatedApiCostUsd,
    pricedEventCoveragePercent,
    unknownModelEventCount,
    unknownBillableUnits,
    priceBasis,
  } = accounting;
  if ((estimatedApiCostUsd !== null
        && (typeof estimatedApiCostUsd !== "string"
          || !/^(?:0|[1-9]\d*)\.\d{6}$/u.test(estimatedApiCostUsd)))
      || !Number.isFinite(pricedEventCoveragePercent)
      || pricedEventCoveragePercent < 0
      || pricedEventCoveragePercent > 100
      || !integer(unknownModelEventCount, 0, recordCounts.usageEvents)
      || !integer(unknownBillableUnits, 0, Number.MAX_SAFE_INTEGER)
      || ![
        "current_api_prices",
        "historical_api_prices",
        "unpriced",
      ].includes(priceBasis)) {
    fail("queue_invalid");
  }
  return {
    schemaVersion: payload.schemaVersion,
    clientPlatform: payload.clientPlatform,
    providerPolicyEpoch: payload.providerPolicyEpoch,
    coveredAt,
    recordCounts: { ...recordCounts, total },
    accounting: {
      estimatedApiCostUsd,
      pricedEventCoveragePercent,
      unknownModelEventCount,
      unknownBillableUnits,
      priceBasis,
      verification: "client_declared_unverified",
    },
  };
}

export async function inspectNextContributionSyncUpload({
  directory,
  queueFile = defaultContributionSyncQueueFile(),
  now = () => new Date(),
  maximumQueuedJobs = MAX_QUEUE_JOBS,
  discoverSets = discoverCommittedPreparedSets,
  loadContribution = loadVerifiedPreparedContribution,
} = {}) {
  if (typeof discoverSets !== "function"
      || typeof loadContribution !== "function"
      || !integer(maximumQueuedJobs, 1, MAX_QUEUE_JOBS)) {
    fail("configuration_invalid");
  }
  const sets = await discoverSets({ directory });
  const database = await openQueueDatabase(queueFile, now);
  try {
    const timestamp = iso(now());
    recoverExpiredLeases(database, timestamp);
    const enqueued = await enqueueDiscoveredSets({
      database,
      sets,
      now,
      loadContribution,
      maximumQueuedJobs,
    });
    const queue = statusFromDatabase(database, timestamp);
    const job = database.prepare(`
      SELECT job_id, prepared_set_id, set_name, contribution_basename,
             contribution_sha256, contribution_bytes, schema_version,
             covered_start_at, covered_end_at, attempt_count, next_attempt_at
        FROM contribution_jobs
       WHERE state IN ('pending', 'retryable')
       ORDER BY created_at, job_id
       LIMIT 1
    `).get();
    if (!job) {
      return Object.freeze({
        schemaVersion: CONTRIBUTION_SYNC_PREVIEW_SCHEMA,
        state: "empty",
        networkActivity: false,
        discoveredSets: sets.length,
        enqueued: enqueued.inserted,
        queue,
        item: null,
      });
    }
    const set = sets.find(
      (candidate) => candidate.preparedSetId === job.prepared_set_id,
    );
    const entry = entryForJob(set, job);
    if (!set || !entry) fail("queue_invalid");
    const payload = await loadContribution({
      directory: set.directory,
      entry,
    });
    const projection = safeContributionProjection(payload);
    if (projection.coveredAt.startAt !== job.covered_start_at
        || projection.coveredAt.endAt !== job.covered_end_at
        || job.schema_version !== projection.schemaVersion) {
      fail("queue_invalid");
    }
    const retryWaiting = job.next_attempt_at > timestamp;
    return Object.freeze({
      schemaVersion: CONTRIBUTION_SYNC_PREVIEW_SCHEMA,
      state: queue.paused
        ? "paused"
        : retryWaiting
          ? "retry_wait"
          : "ready",
      networkActivity: false,
      discoveredSets: sets.length,
      enqueued: enqueued.inserted,
      queue,
      item: Object.freeze({
        ...projection,
        preparedBytes: job.contribution_bytes,
        reservedUploadBytes: conservativeUploadReservationBytes(
          job.contribution_bytes,
        ),
        attemptCount: job.attempt_count,
        nextAttemptAt: job.next_attempt_at,
      }),
    });
  } finally {
    database.close();
  }
}

export async function runContributionSyncQueueOnce({
  directory,
  origin,
  backend,
  queueFile = defaultContributionSyncQueueFile(),
  stateFile = undefined,
  signal = undefined,
  now = () => new Date(),
  random = Math.random,
  maximumAttempts = DEFAULT_MAXIMUM_ATTEMPTS,
  maximumQueuedJobs = MAX_QUEUE_JOBS,
  leaseMilliseconds = DEFAULT_LEASE_MILLISECONDS,
  maximumJobs = DEFAULT_MAXIMUM_JOBS_PER_PASS,
  maximumReservedUploadBytes =
    DEFAULT_MAXIMUM_RESERVED_UPLOAD_BYTES_PER_PASS,
  discoverSets = discoverCommittedPreparedSets,
  loadContribution = loadVerifiedPreparedContribution,
  syncEntry = syncPreparedContributionEntryOnce,
} = {}) {
  if (!backend || typeof backend !== "object"
      || typeof discoverSets !== "function"
      || typeof loadContribution !== "function"
      || typeof syncEntry !== "function"
      || typeof random !== "function"
      || !integer(maximumAttempts, 1, 32)
      || !integer(maximumQueuedJobs, 1, MAX_QUEUE_JOBS)
      || !integer(leaseMilliseconds, 60_000, 60 * 60 * 1000)
      || !integer(maximumJobs, 1, MAXIMUM_JOBS_PER_PASS)
      || !integer(
        maximumReservedUploadBytes,
        MINIMUM_RESERVED_UPLOAD_BYTES_PER_PASS,
        MAXIMUM_RESERVED_UPLOAD_BYTES_PER_PASS,
      )
      || (signal !== undefined && !(signal instanceof AbortSignal))) {
    fail("configuration_invalid");
  }
  const sets = await discoverSets({ directory });
  const database = await openQueueDatabase(queueFile, now);
  const openedAt = queueTimestamp(nowMilliseconds(now));
  let enqueued;
  try {
    recoverExpiredLeases(database, openedAt);
    enqueued = await enqueueDiscoveredSets({
      database,
      sets,
      now,
      loadContribution,
      maximumQueuedJobs,
    });
    const readyAt = queueTimestamp(nowMilliseconds(now));
    const initialStatus = statusFromDatabase(database, readyAt);
    if (initialStatus.paused || signal?.aborted) {
      return Object.freeze({
        status: initialStatus.paused ? "paused" : "interrupted",
        discoveredSets: sets.length,
        enqueued: enqueued.inserted,
        processed: 0,
        accepted: 0,
        retryable: 0,
        rejected: 0,
        reservedUploadBytes: 0,
        bandwidthLimited: false,
        queue: initialStatus,
      });
    }

    const availableSets = new Map(
      sets.map((set) => [set.preparedSetId, set]),
    );
    const candidates = database.prepare(`
      SELECT job_id, prepared_set_id, contribution_bytes
        FROM contribution_jobs
       WHERE state IN ('pending', 'retryable')
         AND next_attempt_at <= ?
       ORDER BY created_at, job_id
       LIMIT ?
    `).all(readyAt, maximumJobs);
    const result = {
      processed: 0,
      accepted: 0,
      retryable: 0,
      rejected: 0,
      reservedUploadBytes: 0,
      bandwidthLimited: false,
    };
    for (const candidate of candidates) {
      if (signal?.aborted) break;
      const set = availableSets.get(candidate.prepared_set_id);
      if (!set) continue;
      const reservation = conservativeUploadReservationBytes(
        candidate.contribution_bytes,
      );
      if (result.reservedUploadBytes + reservation
          > maximumReservedUploadBytes) {
        result.bandwidthLimited = true;
        break;
      }
      const claimedAtMs = nowMilliseconds(now);
      const claimedAt = queueTimestamp(claimedAtMs);
      const job = claimJob(
        database,
        candidate.job_id,
        claimedAt,
        queueTimestamp(claimedAtMs + leaseMilliseconds),
      );
      if (!job) continue;
      result.processed += 1;
      const entry = entryForJob(set, job);
      if (!entry) {
        finishFailed(database, job, {
          state: "rejected",
          errorCode: "prepared_entry_changed",
          nextAttemptAt: null,
          timestamp: iso(now()),
          pause: false,
        });
        result.rejected += 1;
        continue;
      }
      try {
        result.reservedUploadBytes += reservation;
        const receipt = await syncEntry({
          directory: set.directory,
          entry,
          origin,
          backend,
          stateFile,
          signal,
        });
        finishAccepted(database, job, receipt, iso(now()));
        result.accepted += 1;
      } catch (error) {
        const failureAtMs = nowMilliseconds(now);
        const failureAt = queueTimestamp(failureAtMs);
        const interrupted = signal?.aborted === true;
        const deviceUnavailable = error?.deviceUnavailable === true;
        const mayRetry = interrupted || deviceUnavailable
          || error?.retryable === true;
        const exhausted = job.attempt_count >= maximumAttempts;
        const state = mayRetry && !exhausted ? "retryable" : "rejected";
        const errorCode = interrupted
          ? "interrupted"
          : exhausted && mayRetry
            ? "retry_exhausted"
            : boundedErrorCode(error, "local_failure");
        const nextAttemptAt = state === "retryable"
          ? queueTimestamp(
            interrupted
              ? failureAtMs
              : failureAtMs + retryDelayMilliseconds(job.attempt_count, random),
          )
          : null;
        finishFailed(database, job, {
          state,
          errorCode,
          nextAttemptAt,
          timestamp: failureAt,
          pause: deviceUnavailable,
        });
        if (state === "retryable") result.retryable += 1;
        else result.rejected += 1;
        if (deviceUnavailable || interrupted) break;
      }
    }
    const completedAt = iso(now());
    const queue = statusFromDatabase(database, completedAt);
    return Object.freeze({
      status: queue.paused
        ? "paused"
        : signal?.aborted
          ? "interrupted"
          : "completed",
      discoveredSets: sets.length,
      enqueued: enqueued.inserted,
      ...result,
      queue,
    });
  } finally {
    database.close();
  }
}

function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timeout = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolveDelay();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function runContributionSyncQueueWatch({
  intervalSeconds = 60,
  durationMilliseconds = null,
  signal = undefined,
  sleep = abortableDelay,
  clock = Date.now,
  ...options
} = {}) {
  if (!integer(intervalSeconds, MINIMUM_WATCH_INTERVAL_SECONDS,
    MAXIMUM_WATCH_INTERVAL_SECONDS)
      || (durationMilliseconds !== null
        && !integer(durationMilliseconds, 0, 30 * 24 * 60 * 60 * 1000))
      || (signal !== undefined && !(signal instanceof AbortSignal))
      || typeof sleep !== "function" || typeof clock !== "function") {
    fail("configuration_invalid");
  }
  const startedAt = clock();
  if (!Number.isFinite(startedAt)) fail("configuration_invalid");
  const totals = {
    passes: 0,
    enqueued: 0,
    processed: 0,
    accepted: 0,
    retryable: 0,
    rejected: 0,
    reservedUploadBytes: 0,
    bandwidthLimitedPasses: 0,
  };
  let latest = null;
  while (!signal?.aborted) {
    latest = await runContributionSyncQueueOnce({
      ...options,
      signal,
    });
    totals.passes += 1;
    for (const key of [
      "enqueued",
      "processed",
      "accepted",
      "retryable",
      "rejected",
      "reservedUploadBytes",
    ]) {
      totals[key] += latest[key];
    }
    if (latest.bandwidthLimited) totals.bandwidthLimitedPasses += 1;
    if (latest.status === "paused") break;
    const elapsed = clock() - startedAt;
    if (durationMilliseconds !== null && elapsed >= durationMilliseconds) break;
    const remaining = durationMilliseconds === null
      ? intervalSeconds * 1000
      : Math.min(intervalSeconds * 1000, durationMilliseconds - elapsed);
    if (remaining <= 0) break;
    await sleep(remaining, signal);
  }
  return Object.freeze({
    status: latest?.status === "paused"
      ? "paused"
      : signal?.aborted
        ? "interrupted"
        : "completed",
    ...totals,
    queue: latest?.queue ?? await inspectContributionSyncQueue({
      queueFile: options.queueFile,
    }),
  });
}

export const CONTRIBUTION_SYNC_QUEUE_LIMITS = Object.freeze({
  maximumQueueBytes: MAX_QUEUE_BYTES,
  maximumJobs: MAX_QUEUE_JOBS,
  maximumPreparedSets: MAX_DISCOVERED_SETS,
  maximumAttempts: DEFAULT_MAXIMUM_ATTEMPTS,
  leaseMilliseconds: DEFAULT_LEASE_MILLISECONDS,
  maximumJobsPerPass: DEFAULT_MAXIMUM_JOBS_PER_PASS,
  maximumJobsPerPassAllowed: MAXIMUM_JOBS_PER_PASS,
  minimumReservedUploadBytesPerPass:
    MINIMUM_RESERVED_UPLOAD_BYTES_PER_PASS,
  maximumReservedUploadBytesPerPass:
    MAXIMUM_RESERVED_UPLOAD_BYTES_PER_PASS,
  defaultMaximumReservedUploadBytesPerPass:
    DEFAULT_MAXIMUM_RESERVED_UPLOAD_BYTES_PER_PASS,
  reservedUploadEnvelopeOverheadBytes:
    RESERVED_UPLOAD_ENVELOPE_OVERHEAD_BYTES,
  minimumWatchIntervalSeconds: MINIMUM_WATCH_INTERVAL_SECONDS,
  maximumWatchIntervalSeconds: MAXIMUM_WATCH_INTERVAL_SECONDS,
});
