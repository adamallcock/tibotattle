import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { readBoundedDirectoryEntries } from "./bounded-directory-reader.js";
import { syncDirectory } from "./owner-only-filesystem.js";

const SQLITE_USER_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function failureContext(createError) {
  const factory = requireFunction(createError, "createError");
  const issued = new WeakSet();
  return Object.freeze({
    fail(code) {
      let error;
      try {
        error = Reflect.apply(factory, undefined, [code]);
      } catch {
        throw new TypeError("createError must return an Error");
      }
      if (!(error instanceof Error)) {
        throw new TypeError("createError must return an Error");
      }
      issued.add(error);
      throw error;
    },
    issued(error) {
      try {
        return error instanceof Error && issued.has(error);
      } catch {
        return false;
      }
    },
  });
}

function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function iso(value, failures) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) failures.fail("configuration_invalid");
  return date.toISOString();
}

export function createLocalContributionSyncQueueStorageContext({
  createError,
  queueSchemaVersion,
  queueStatusSchemaVersion,
  maximumQueueBytes,
  maximumQueueJobs,
  jobStates,
  uuid = randomUUID,
} = {}) {
  const failures = failureContext(createError);
  const createUuid = requireFunction(uuid, "uuid");
  if (typeof queueSchemaVersion !== "string"
      || queueSchemaVersion.length < 1
      || typeof queueStatusSchemaVersion !== "string"
      || queueStatusSchemaVersion.length < 1
      || !integer(maximumQueueBytes, 1, Number.MAX_SAFE_INTEGER)
      || !integer(maximumQueueJobs, 1, Number.MAX_SAFE_INTEGER)
      || !Array.isArray(jobStates)
      || jobStates.length !== 5
      || jobStates.some((state) => typeof state !== "string")) {
    throw new TypeError("contribution queue storage configuration is invalid");
  }
  const states = Object.freeze([...jobStates]);

  function nextUuid(code) {
    let value;
    try {
      value = Reflect.apply(createUuid, undefined, []);
    } catch {
      failures.fail(code);
    }
    if (typeof value !== "string" || !UUID_V4.test(value)) failures.fail(code);
    return value;
  }

  function assertOwnerOnlyDirectory(stats, code) {
    if (!stats.isDirectory() || stats.isSymbolicLink()
        || (typeof process.getuid === "function"
          && stats.uid !== process.getuid())
        || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
      failures.fail(code);
    }
  }

  function assertOwnerOnlyQueueFile(stats) {
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
        || stats.size < 0 || stats.size > maximumQueueBytes
        || (typeof process.getuid === "function"
          && stats.uid !== process.getuid())
        || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
      failures.fail("queue_invalid");
    }
  }

  async function prepareQueueFile(queueFile) {
    if (typeof queueFile !== "string" || queueFile.length < 1) {
      failures.fail("configuration_invalid");
    }
    const requested = resolve(queueFile);
    const requestedParent = dirname(requested);
    try {
      await mkdir(requestedParent, { recursive: true, mode: 0o700 });
      const parentStats = await lstat(requestedParent);
      assertOwnerOnlyDirectory(parentStats, "queue_invalid");
      const canonicalParent = await realpath(requestedParent);
      const canonicalStats = await lstat(canonicalParent);
      assertOwnerOnlyDirectory(canonicalStats, "queue_invalid");
      if (parentStats.dev !== canonicalStats.dev
          || parentStats.ino !== canonicalStats.ino) {
        failures.fail("queue_invalid");
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
      if (failures.issued(error)) throw error;
      failures.fail("queue_unavailable");
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
    `).run(queueSchemaVersion, createdAt, createdAt);
    database.exec(`PRAGMA user_version = ${SQLITE_USER_VERSION}`);
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

  function createRepository(database) {
    function enqueueJob({
      preparedSetId,
      setName,
      entry,
      coveredAt,
      timestamp,
      maximumQueuedJobs,
    }) {
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
      const result = transaction(database, () => insert.run(
        nextUuid("queue_invalid"),
        preparedSetId,
        setName,
        entry.basename,
        entry.sha256,
        entry.bytes,
        coveredAt.startAt,
        coveredAt.endAt,
        timestamp,
        timestamp,
        timestamp,
        maximumQueuedJobs,
      ));
      if (result.changes === 1) return "inserted";
      const existing = database.prepare(`
        SELECT 1 AS present
          FROM contribution_jobs
         WHERE prepared_set_id = ? AND contribution_basename = ?
      `).get(preparedSetId, entry.basename);
      return existing ? "existing" : "limit";
    }

    function recoverExpiredLeases(timestamp) {
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

    function status(timestamp) {
      const counts = Object.fromEntries(states.map((state) => [state, 0]));
      for (const row of database.prepare(`
        SELECT state, COUNT(*) AS count
          FROM contribution_jobs
         GROUP BY state
      `).all()) {
        if (!states.includes(row.state)) failures.fail("queue_invalid");
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
        schemaVersion: queueStatusSchemaVersion,
        paused: meta.paused === 1,
        counts: Object.freeze(counts),
        dueNow: Number(due.count),
        nextAttemptAt: next.value ?? null,
        lastAcceptedAt: lastAccepted.value ?? null,
      });
    }

    function preparedSetStatus(preparedSetId) {
      if (!SHA256.test(preparedSetId ?? "")) failures.fail("queue_invalid");
      const rows = database.prepare(`
        SELECT state, COUNT(*) AS count,
               MIN(covered_start_at) AS minimum_start_at,
               MAX(covered_start_at) AS maximum_start_at,
               MIN(covered_end_at) AS minimum_end_at,
               MAX(covered_end_at) AS maximum_end_at
          FROM contribution_jobs
         WHERE prepared_set_id = ?
         GROUP BY state
      `).all(preparedSetId);
      if (rows.length === 0) return null;
      const counts = Object.fromEntries(states.map((state) => [state, 0]));
      let startAt = null;
      let endAt = null;
      let total = 0;
      for (const row of rows) {
        if (!states.includes(row.state)
            || row.minimum_start_at !== row.maximum_start_at
            || row.minimum_end_at !== row.maximum_end_at
            || iso(row.minimum_start_at, failures) !== row.minimum_start_at
            || iso(row.minimum_end_at, failures) !== row.minimum_end_at
            || Date.parse(row.minimum_start_at)
              >= Date.parse(row.minimum_end_at)) {
          failures.fail("queue_invalid");
        }
        if (startAt === null) {
          startAt = row.minimum_start_at;
          endAt = row.minimum_end_at;
        } else if (startAt !== row.minimum_start_at
            || endAt !== row.minimum_end_at) {
          failures.fail("queue_invalid");
        }
        counts[row.state] = Number(row.count);
        if (!integer(counts[row.state], 0, maximumQueueJobs)
            || !Number.isSafeInteger(total + counts[row.state])) {
          failures.fail("queue_invalid");
        }
        total += counts[row.state];
      }
      if (total < 1) failures.fail("queue_invalid");
      return Object.freeze({
        preparedSetId,
        coveredAt: Object.freeze({ startAt, endAt }),
        totalJobs: total,
        acceptedJobs: counts.accepted,
        pendingJobs: counts.pending,
        retryableJobs: counts.retryable,
        inFlightJobs: counts.in_flight,
        rejectedJobs: counts.rejected,
        completeAccepted: counts.accepted === total,
      });
    }

    // The automatic controller must only inherit a retry deadline for the
    // prepared set it selected. `status().nextAttemptAt` is intentionally
    // queue-wide for the local UI, so using it for recurrence could make a
    // different set's earlier job trigger a tight automatic retry loop.
    function preparedSetNextAttemptAt(preparedSetId) {
      if (!SHA256.test(preparedSetId ?? "")) failures.fail("queue_invalid");
      const row = database.prepare(`
        SELECT MIN(next_attempt_at) AS value
          FROM contribution_jobs
         WHERE prepared_set_id = ?
           AND state IN ('pending', 'retryable')
      `).get(preparedSetId);
      if (row.value === null || row.value === undefined) return null;
      const normalized = iso(row.value, failures);
      if (normalized !== row.value) failures.fail("queue_invalid");
      return normalized;
    }

    function setPaused(paused, timestamp) {
      database.prepare(`
        UPDATE queue_meta
           SET paused = ?, updated_at = ?
         WHERE singleton = 1
      `).run(paused ? 1 : 0, timestamp);
    }

    function nextQueuedJob() {
      return database.prepare(`
        SELECT job_id, prepared_set_id, set_name, contribution_basename,
               contribution_sha256, contribution_bytes, schema_version,
               covered_start_at, covered_end_at, attempt_count, next_attempt_at
          FROM contribution_jobs
         WHERE state IN ('pending', 'retryable')
         ORDER BY created_at, job_id
         LIMIT 1
      `).get();
    }

    function readyJobs({ reviewedJob, preparedSetId, readyAt, maximumJobs }) {
      if (reviewedJob !== undefined) {
        return database.prepare(`
          SELECT job_id, prepared_set_id, contribution_bytes
            FROM contribution_jobs
           WHERE job_id = ?
             AND contribution_sha256 = ?
             AND state IN ('pending', 'retryable')
             AND next_attempt_at <= ?
           LIMIT 1
        `).all(reviewedJob.jobId, reviewedJob.contributionSha256, readyAt);
      }
      if (preparedSetId !== undefined) {
        return database.prepare(`
          SELECT job_id, prepared_set_id, contribution_bytes
            FROM contribution_jobs
           WHERE prepared_set_id = ?
             AND state IN ('pending', 'retryable')
             AND next_attempt_at <= ?
           ORDER BY created_at, job_id
           LIMIT ?
        `).all(preparedSetId, readyAt, maximumJobs);
      }
      return database.prepare(`
        SELECT job_id, prepared_set_id, contribution_bytes
          FROM contribution_jobs
         WHERE state IN ('pending', 'retryable')
           AND next_attempt_at <= ?
         ORDER BY created_at, job_id
         LIMIT ?
      `).all(readyAt, maximumJobs);
    }

    function claimJob(jobId, timestamp, leaseExpiresAt) {
      const leaseToken = nextUuid("queue_invalid");
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

    function finishAccepted(job, receipt, timestamp) {
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
      if (result.changes !== 1) failures.fail("queue_invalid");
    }

    function finishFailed(job, {
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
        if (result.changes !== 1) failures.fail("queue_invalid");
        if (pause) {
          database.prepare(`
            UPDATE queue_meta SET paused = 1, updated_at = ?
             WHERE singleton = 1
          `).run(timestamp);
        }
      });
    }

    function acceptedSets(limit) {
      return database.prepare(`
        SELECT prepared_set_id, set_name,
               COUNT(*) AS total_jobs,
               SUM(CASE WHEN state = 'accepted' THEN 1 ELSE 0 END)
                 AS accepted_jobs,
               MAX(accepted_at) AS accepted_at
          FROM contribution_jobs
         GROUP BY prepared_set_id, set_name
        HAVING accepted_jobs = total_jobs
           AND total_jobs > 0
         ORDER BY accepted_at DESC, prepared_set_id
         LIMIT ?
      `).all(limit);
    }

    function deleteAcceptedSet(preparedSetId) {
      return transaction(database, () => database.prepare(`
        DELETE FROM contribution_jobs
         WHERE prepared_set_id = ?
           AND NOT EXISTS (
             SELECT 1
               FROM contribution_jobs AS retained
              WHERE retained.prepared_set_id = ?
                AND retained.state != 'accepted'
           )
      `).run(preparedSetId, preparedSetId));
    }

    return Object.freeze({
      acceptedSets,
      claimJob,
      close: () => database.close(),
      deleteAcceptedSet,
      enqueueJob,
      finishAccepted,
      finishFailed,
      nextQueuedJob,
      preparedSetNextAttemptAt,
      preparedSetStatus,
      readyJobs,
      recoverExpiredLeases,
      setPaused,
      status,
    });
  }

  async function openQueue({ queueFile, now } = {}) {
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
      if (version === 0) createSchema(database, iso(now(), failures));
      else if (version !== SQLITE_USER_VERSION) failures.fail("queue_invalid");
      const check = database.prepare("PRAGMA quick_check(1)").get();
      if (Object.values(check)[0] !== "ok") failures.fail("queue_invalid");
      const meta = database.prepare(`
        SELECT schema_version, paused
          FROM queue_meta
         WHERE singleton = 1
      `).get();
      if (meta?.schema_version !== queueSchemaVersion
          || ![0, 1].includes(meta?.paused)) {
        failures.fail("queue_invalid");
      }
      const after = await lstat(selected.path);
      assertOwnerOnlyQueueFile(after);
      if (after.dev !== selected.identity.dev
          || after.ino !== selected.identity.ino) {
        failures.fail("queue_invalid");
      }
      return createRepository(database);
    } catch (error) {
      database?.close();
      if (failures.issued(error)) throw error;
      failures.fail("queue_invalid");
    }
  }

  async function canonicalPreparedRoot(directory) {
    if (typeof directory !== "string" || directory.length < 1) {
      failures.fail("configuration_invalid");
    }
    try {
      const requested = resolve(directory);
      const requestedStats = await lstat(requested);
      assertOwnerOnlyDirectory(requestedStats, "prepared_root_invalid");
      const canonical = await realpath(requested);
      const canonicalStats = await lstat(canonical);
      assertOwnerOnlyDirectory(canonicalStats, "prepared_root_invalid");
      if (requestedStats.dev !== canonicalStats.dev
          || requestedStats.ino !== canonicalStats.ino) {
        failures.fail("prepared_root_invalid");
      }
      return canonical;
    } catch (error) {
      if (failures.issued(error)) throw error;
      failures.fail("prepared_root_invalid");
    }
  }

  async function manifestExists(directory, manifestName) {
    try {
      const stats = await lstat(join(directory, manifestName));
      return stats.isFile() && !stats.isSymbolicLink();
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      failures.fail("prepared_root_invalid");
    }
  }

  async function preparedSetDirectories({ root, maximumEntries, matches }) {
    const match = requireFunction(matches, "matches");
    let names;
    try {
      names = await readBoundedDirectoryEntries(root, { maximumEntries });
    } catch {
      failures.fail("prepared_root_invalid");
    }
    const directories = [];
    for (const name of names.sort()) {
      if (!Reflect.apply(match, undefined, [name])) continue;
      const child = join(root, name);
      try {
        const stats = await lstat(child);
        assertOwnerOnlyDirectory(stats, "prepared_root_invalid");
      } catch (error) {
        if (failures.issued(error)) throw error;
        failures.fail("prepared_root_invalid");
      }
      directories.push(Object.freeze({ name, directory: child }));
    }
    return directories;
  }

  async function prepareRetentionRoot(directory) {
    if (typeof directory !== "string" || directory.length < 1) {
      failures.fail("configuration_invalid");
    }
    try {
      const requested = resolve(directory);
      await mkdir(requested, { recursive: true, mode: 0o700 });
      const requestedStats = await lstat(requested);
      assertOwnerOnlyDirectory(requestedStats, "retirement_invalid");
      const canonical = await realpath(requested);
      const canonicalStats = await lstat(canonical);
      assertOwnerOnlyDirectory(canonicalStats, "retirement_invalid");
      if (requestedStats.dev !== canonicalStats.dev
          || requestedStats.ino !== canonicalStats.ino) {
        failures.fail("retirement_invalid");
      }
      return canonical;
    } catch (error) {
      if (failures.issued(error)) throw error;
      failures.fail("retirement_invalid");
    }
  }

  function assertOwnerOnlyRetainedFile(stats) {
    if (!stats.isFile()
        || stats.isSymbolicLink()
        || stats.nlink !== 1
        || (typeof process.getuid === "function"
          && stats.uid !== process.getuid())
        || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
      failures.fail("retirement_invalid");
    }
  }

  async function retireFlatDirectory({ root, name, maximumEntries }) {
    if (basename(name) !== name || !integer(maximumEntries, 1, 256)) {
      failures.fail("retirement_invalid");
    }
    const path = join(root, name);
    let directoryStats;
    try {
      directoryStats = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      failures.fail("retirement_invalid");
    }
    try {
      assertOwnerOnlyDirectory(directoryStats, "retirement_invalid");
      const entries = await readdir(path, { withFileTypes: true });
      if (entries.length > maximumEntries) failures.fail("retirement_invalid");
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          failures.fail("retirement_invalid");
        }
        const child = join(path, entry.name);
        const stats = await lstat(child);
        assertOwnerOnlyRetainedFile(stats);
        await unlink(child);
      }
      await rmdir(path);
      await syncDirectory(root);
      return true;
    } catch (error) {
      if (failures.issued(error)) throw error;
      failures.fail("retirement_invalid");
    }
  }

  return Object.freeze({
    canonicalPreparedRoot,
    manifestExists,
    openQueue,
    preparedSetDirectories,
    prepareRetentionRoot,
    retireFlatDirectory,
  });
}
