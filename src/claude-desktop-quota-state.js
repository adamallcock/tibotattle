import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CLAUDE_DESKTOP_QUOTA_STATE_VERSION =
  "claude-desktop-quota-state-v0.1";
export const CLAUDE_DESKTOP_QUOTA_PROVIDER = "anthropic_claude_code";
export const CLAUDE_DESKTOP_QUOTA_AUTHORITY = "claude_desktop_plan_history";

export const CLAUDE_DESKTOP_QUOTA_SOURCE_STATUSES = Object.freeze([
  "present",
  "missing_suspected",
  "inaccessible",
  "partial",
]);

const SOURCE_STATUS_SET = new Set(CLAUDE_DESKTOP_QUOTA_SOURCE_STATUSES);
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
const METER_DURATIONS_MINUTES = Object.freeze({
  five_hour: 5 * 60,
  seven_day_all_models: 7 * 24 * 60,
  extra_usage: null,
});

export class ClaudeDesktopQuotaStateError extends Error {
  constructor(code) {
    super(`Claude Desktop quota state failed (${code})`);
    this.name = "ClaudeDesktopQuotaStateError";
    this.code = `claude_desktop_quota_state_${code}`;
  }
}

function fail(code) {
  throw new ClaudeDesktopQuotaStateError(code);
}

function safeTimestamp(value, code = "timestamp") {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function safeRevision(value, code = "source_revision") {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}

function safeGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail("generation");
  return value;
}

function safeKey(value, code = "key") {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(code);
  return value;
}

function safeMeter(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,96}$/u.test(value)) fail("meter");
  return value;
}

function safeStatus(value) {
  if (!SOURCE_STATUS_SET.has(value)) fail("status");
  return value;
}

function safeUtilization(value) {
  if (typeof value !== "number" || !Number.isFinite(value)
      || value < 0 || value > 100) fail("utilization");
  return value;
}

function safeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail("metadata");
  }
  for (const key of ["dev", "ino", "size"]) {
    if (!Number.isSafeInteger(metadata[key]) || metadata[key] < 0) fail("metadata");
  }
  if (typeof metadata.mtimeMs !== "number" || !Number.isFinite(metadata.mtimeMs)
      || metadata.mtimeMs < 0) fail("metadata");
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
  };
}

function safeStatePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    fail("configuration");
  }
  const selected = resolve(path);
  if (selected !== path) fail("configuration");
  return selected;
}

function assertOwnerOnlyDirectory(path, { create = false } = {}) {
  if (create) {
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } catch {
      fail("storage_unavailable");
    }
  }
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    fail("storage_unavailable");
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail("storage_unsafe");
  }
}

function assertOwnerOnlyDatabase(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    fail("storage_unavailable");
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail("storage_unsafe");
  }
}

function createOwnerOnlyDatabase(path) {
  const parent = dirname(path);
  assertOwnerOnlyDirectory(parent, { create: true });
  let handle;
  try {
    handle = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    closeSync(handle);
  } catch (error) {
    if (error?.code !== "EEXIST") fail("storage_unavailable");
    assertOwnerOnlyDatabase(path);
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    fail("storage_unavailable");
  }
  assertOwnerOnlyDatabase(path);
}

function configure(database) {
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA trusted_schema = OFF;
    PRAGMA temp_store = FILE;
    PRAGMA cache_size = -8192;
    PRAGMA mmap_size = 0;
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS ledger_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS source_state (
      provider TEXT NOT NULL CHECK(provider = 'anthropic_claude_code'),
      source_key TEXT NOT NULL CHECK(length(source_key) = 64),
      source_generation INTEGER NOT NULL CHECK(source_generation >= 1),
      status TEXT NOT NULL CHECK(status IN ('present', 'missing_suspected', 'inaccessible', 'partial')),
      observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),
      first_observed_at_ms INTEGER CHECK(first_observed_at_ms IS NULL OR first_observed_at_ms >= 0),
      last_success_at_ms INTEGER CHECK(last_success_at_ms IS NULL OR last_success_at_ms >= 0),
      last_seen_dev INTEGER CHECK(last_seen_dev IS NULL OR last_seen_dev >= 0),
      last_seen_ino INTEGER CHECK(last_seen_ino IS NULL OR last_seen_ino >= 0),
      last_seen_size INTEGER CHECK(last_seen_size IS NULL OR last_seen_size >= 0),
      last_seen_mtime_ms REAL CHECK(last_seen_mtime_ms IS NULL OR last_seen_mtime_ms >= 0),
      coverage_start_at_ms INTEGER CHECK(coverage_start_at_ms IS NULL OR coverage_start_at_ms >= 0),
      coverage_end_at_ms INTEGER CHECK(coverage_end_at_ms IS NULL OR coverage_end_at_ms >= 0),
      last_error_code TEXT,
      PRIMARY KEY(provider, source_key)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS quota_revision (
      provider TEXT NOT NULL CHECK(provider = 'anthropic_claude_code'),
      account_scope TEXT NOT NULL CHECK(length(account_scope) = 64),
      observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),
      meter_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      utilization_percent REAL NOT NULL CHECK(utilization_percent >= 0 AND utilization_percent <= 100),
      resets_at_ms INTEGER CHECK(resets_at_ms IS NULL OR resets_at_ms >= 0),
      source_key TEXT NOT NULL CHECK(length(source_key) = 64),
      source_generation INTEGER NOT NULL CHECK(source_generation >= 1),
      accepted_at_ms INTEGER NOT NULL CHECK(accepted_at_ms >= 0),
      PRIMARY KEY(provider, account_scope, observed_at_ms, meter_id, revision)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS quota_revision_latest
      ON quota_revision(provider, meter_id, observed_at_ms, revision);
    CREATE TABLE IF NOT EXISTS coverage_gap (
      provider TEXT NOT NULL CHECK(provider = 'anthropic_claude_code'),
      source_key TEXT NOT NULL CHECK(length(source_key) = 64),
      kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),
      start_at_ms INTEGER NOT NULL CHECK(start_at_ms >= 0),
      end_at_ms INTEGER CHECK(end_at_ms IS NULL OR end_at_ms >= start_at_ms),
      PRIMARY KEY(provider, source_key, kind, start_at_ms)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS quota_snapshot_state (
      provider TEXT NOT NULL CHECK(provider = 'anthropic_claude_code'),
      source_key TEXT NOT NULL CHECK(length(source_key) = 64),
      observation_count INTEGER NOT NULL CHECK(observation_count >= 0),
      coverage_start_at_ms INTEGER CHECK(coverage_start_at_ms IS NULL OR coverage_start_at_ms >= 0),
      coverage_end_at_ms INTEGER CHECK(coverage_end_at_ms IS NULL OR coverage_end_at_ms >= 0),
      PRIMARY KEY(provider, source_key)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS quota_snapshot_observation (
      provider TEXT NOT NULL CHECK(provider = 'anthropic_claude_code'),
      source_key TEXT NOT NULL CHECK(length(source_key) = 64),
      account_scope TEXT NOT NULL CHECK(length(account_scope) = 64),
      observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),
      meter_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL CHECK(source_revision >= 1),
      utilization_percent REAL NOT NULL CHECK(utilization_percent >= 0 AND utilization_percent <= 100),
      resets_at_ms INTEGER CHECK(resets_at_ms IS NULL OR resets_at_ms >= 0),
      PRIMARY KEY(provider, source_key, account_scope, observed_at_ms, meter_id, source_revision)
    ) STRICT, WITHOUT ROWID;
  `);
  const version = database.prepare(
    "SELECT value FROM ledger_meta WHERE key = 'schema_version'",
  ).get()?.value;
  if (version && version !== CLAUDE_DESKTOP_QUOTA_STATE_VERSION) fail("schema_mismatch");
  database.prepare(
    "INSERT OR REPLACE INTO ledger_meta(key, value) VALUES ('schema_version', ?)",
  ).run(CLAUDE_DESKTOP_QUOTA_STATE_VERSION);
}

function rowValue(row, key) {
  return row?.[key] ?? null;
}

function sourceSnapshot(row) {
  if (!row) return null;
  return {
    provider: row.provider,
    sourceKey: row.source_key,
    sourceGeneration: Number(row.source_generation),
    status: row.status,
    observedAtMs: Number(row.observed_at_ms),
    firstObservedAtMs: rowValue(row, "first_observed_at_ms") === null
      ? null : Number(row.first_observed_at_ms),
    lastSuccessAtMs: rowValue(row, "last_success_at_ms") === null
      ? null : Number(row.last_success_at_ms),
    lastSeen: row.last_seen_dev === null ? null : {
      dev: Number(row.last_seen_dev),
      ino: Number(row.last_seen_ino),
      size: Number(row.last_seen_size),
      mtimeMs: Number(row.last_seen_mtime_ms),
    },
    coverageStartAtMs: row.coverage_start_at_ms === null
      ? null : Number(row.coverage_start_at_ms),
    coverageEndAtMs: row.coverage_end_at_ms === null
      ? null : Number(row.coverage_end_at_ms),
    lastErrorCode: row.last_error_code ?? null,
  };
}

function sourceSnapshotChanged(prior, metadata) {
  if (!prior?.dev && prior?.dev !== 0) return false;
  if (!prior?.ino && prior?.ino !== 0) return false;
  return prior.dev !== metadata.dev || prior.ino !== metadata.ino
    || prior.size !== metadata.size || prior.mtimeMs !== metadata.mtimeMs;
}

function snapshotState(row) {
  if (!row) return null;
  return {
    observationCount: Number(row.observation_count),
    coverageStartAtMs: row.coverage_start_at_ms === null
      ? null : Number(row.coverage_start_at_ms),
    coverageEndAtMs: row.coverage_end_at_ms === null
      ? null : Number(row.coverage_end_at_ms),
  };
}

function snapshotObservationKey(accountScope, observedAtMs, meterId) {
  return `${accountScope}\0${observedAtMs}\0${meterId}`;
}

function normalizeObservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("quota");
  if (value.provider !== CLAUDE_DESKTOP_QUOTA_PROVIDER) fail("provider");
  if (typeof value.accountScope !== "string" || !/^[a-f0-9]{64}$/u.test(value.accountScope)) {
    fail("account_scope");
  }
  return {
    provider: CLAUDE_DESKTOP_QUOTA_PROVIDER,
    accountScope: value.accountScope,
    observedAtMs: safeTimestamp(value.observedAtMs),
    meterId: safeMeter(value.meterId),
    utilizationPercent: safeUtilization(value.utilizationPercent),
    resetsAtMs: value.resetsAtMs === null || value.resetsAtMs === undefined
      ? null : safeTimestamp(value.resetsAtMs, "reset"),
    sourceRevision: value.revision === undefined || value.revision === null
      ? null : safeRevision(value.revision),
  };
}

function sourceKeyFrom(value) {
  return safeKey(value, "source_key");
}

function maxRevision(database, item) {
  const row = database.prepare(`
    SELECT MAX(revision) AS revision
    FROM quota_revision
    WHERE provider = ? AND account_scope = ? AND observed_at_ms = ? AND meter_id = ?
  `).get(item.provider, item.accountScope, item.observedAtMs, item.meterId);
  return Number(row?.revision ?? 0);
}

function sourceUpsert(database, {
  sourceKey,
  sourceGeneration,
  status,
  observedAtMs,
  metadata = null,
  coverageStartAtMs = null,
  coverageEndAtMs = null,
  errorCode = null,
  successful = false,
} = {}) {
  const key = sourceKeyFrom(sourceKey);
  const conflictingSource = database.prepare(`
    SELECT 1 FROM source_state
    WHERE provider = ? AND source_key <> ? LIMIT 1
  `).get(CLAUDE_DESKTOP_QUOTA_PROVIDER, key);
  if (conflictingSource) fail("source_key_mismatch");
  const timestamp = safeTimestamp(observedAtMs);
  const selectedStatus = safeStatus(status);
  const priorRow = database.prepare(`
    SELECT * FROM source_state WHERE provider = ? AND source_key = ?
  `).get(CLAUDE_DESKTOP_QUOTA_PROVIDER, key);
  const prior = sourceSnapshot(priorRow);
  const effectiveTimestamp = Math.max(prior?.observedAtMs ?? timestamp, timestamp);
  const selectedMetadata = metadata === null ? null : safeMetadata(metadata);
  let generation = sourceGeneration === undefined || sourceGeneration === null
    ? Number(prior?.sourceGeneration ?? 1)
    : safeGeneration(sourceGeneration);
  if (selectedMetadata && sourceSnapshotChanged(prior?.lastSeen, selectedMetadata)) {
    generation = Math.max(generation, Number(prior?.sourceGeneration ?? 0) + 1);
  }
  if (prior && generation < prior.sourceGeneration) fail("generation_regression");
  const firstObservedAtMs = prior?.firstObservedAtMs ?? effectiveTimestamp;
  const requestedCoverageStart = coverageStartAtMs === null || coverageStartAtMs === undefined
    ? null : safeTimestamp(coverageStartAtMs);
  const requestedCoverageEnd = coverageEndAtMs === null || coverageEndAtMs === undefined
    ? null : safeTimestamp(coverageEndAtMs);
  const coverageStart = requestedCoverageStart === null
    ? prior?.coverageStartAtMs ?? null
    : prior?.coverageStartAtMs === null || prior?.coverageStartAtMs === undefined
      ? requestedCoverageStart
      : Math.min(prior.coverageStartAtMs, requestedCoverageStart);
  const coverageEnd = requestedCoverageEnd === null
    ? prior?.coverageEndAtMs ?? null
    : prior?.coverageEndAtMs === null || prior?.coverageEndAtMs === undefined
      ? requestedCoverageEnd
      : Math.max(prior.coverageEndAtMs, requestedCoverageEnd);
  if (coverageStart !== null && coverageEnd !== null && coverageEnd < coverageStart) {
    fail("coverage");
  }
  const seen = selectedMetadata ?? prior?.lastSeen ?? null;
  const lastSuccessAtMs = successful
    ? Math.max(prior?.lastSuccessAtMs ?? effectiveTimestamp, effectiveTimestamp)
    : prior?.lastSuccessAtMs ?? null;
  database.prepare(`
    INSERT INTO source_state(
      provider, source_key, source_generation, status, observed_at_ms,
      first_observed_at_ms, last_success_at_ms, last_seen_dev, last_seen_ino,
      last_seen_size, last_seen_mtime_ms, coverage_start_at_ms, coverage_end_at_ms,
      last_error_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, source_key) DO UPDATE SET
      source_generation = excluded.source_generation,
      status = excluded.status,
      observed_at_ms = excluded.observed_at_ms,
      first_observed_at_ms = excluded.first_observed_at_ms,
      last_success_at_ms = excluded.last_success_at_ms,
      last_seen_dev = excluded.last_seen_dev,
      last_seen_ino = excluded.last_seen_ino,
      last_seen_size = excluded.last_seen_size,
      last_seen_mtime_ms = excluded.last_seen_mtime_ms,
      coverage_start_at_ms = excluded.coverage_start_at_ms,
      coverage_end_at_ms = excluded.coverage_end_at_ms,
      last_error_code = excluded.last_error_code
  `).run(
    CLAUDE_DESKTOP_QUOTA_PROVIDER,
    key,
    generation,
    selectedStatus,
    effectiveTimestamp,
    firstObservedAtMs,
    lastSuccessAtMs,
    seen?.dev ?? null,
    seen?.ino ?? null,
    seen?.size ?? null,
    seen?.mtimeMs ?? null,
    coverageStart,
    coverageEnd,
    errorCode,
  );
  if (selectedStatus === "present") {
    database.prepare(`
      UPDATE coverage_gap SET end_at_ms = ?
      WHERE provider = ? AND source_key = ? AND end_at_ms IS NULL AND start_at_ms <= ?
    `).run(effectiveTimestamp, CLAUDE_DESKTOP_QUOTA_PROVIDER, key, effectiveTimestamp);
  } else {
    const kind = selectedStatus === "missing_suspected"
      ? "source_missing" : selectedStatus === "inaccessible" ? "source_inaccessible" : "source_partial";
    database.prepare(`
      INSERT OR IGNORE INTO coverage_gap(
        provider, source_key, kind, start_at_ms, end_at_ms
      ) VALUES (?, ?, ?, ?, NULL)
    `).run(CLAUDE_DESKTOP_QUOTA_PROVIDER, key, kind, effectiveTimestamp);
  }
  return {
    sourceKey: key,
    sourceGeneration: generation,
    prior,
  };
}

function readProjection(database, {
  nowAtMs = Date.now(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
} = {}) {
  const now = safeTimestamp(nowAtMs);
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 0) fail("stale_after");
  const source = sourceSnapshot(database.prepare(`
    SELECT * FROM source_state
    WHERE provider = ? ORDER BY observed_at_ms DESC, source_key ASC LIMIT 1
  `).get(CLAUDE_DESKTOP_QUOTA_PROVIDER));
  const counts = database.prepare(`
    SELECT COUNT(*) AS observations,
           COUNT(DISTINCT account_scope) AS accounts,
           COUNT(DISTINCT meter_id) AS meters,
           COUNT(DISTINCT CASE WHEN meter_id LIKE 'unknown_%' THEN meter_id END) AS unknown_meters,
           COUNT(DISTINCT observed_at_ms || ':' || meter_id || ':' || account_scope) AS points
    FROM quota_revision WHERE provider = ? AND source_key = ?
  `).get(CLAUDE_DESKTOP_QUOTA_PROVIDER, source?.sourceKey ?? null);
  const gapCount = Number(database.prepare(
    "SELECT COUNT(*) AS count FROM coverage_gap WHERE provider = ? AND source_key = ?",
  ).get(CLAUDE_DESKTOP_QUOTA_PROVIDER, source?.sourceKey ?? null).count);
  const latest = database.prepare(`
    WITH active_account AS (
      SELECT account_scope
      FROM quota_snapshot_observation
      WHERE provider = ? AND source_key = ? AND meter_id NOT LIKE 'unknown_%'
      ORDER BY observed_at_ms DESC, source_revision DESC, account_scope ASC
      LIMIT 1
    ), latest_time AS (
      SELECT meter_id, MAX(observed_at_ms) AS observed_at_ms
      FROM quota_snapshot_observation
      WHERE provider = ? AND source_key = ?
        AND account_scope = (SELECT account_scope FROM active_account)
        AND meter_id NOT LIKE 'unknown_%'
      GROUP BY meter_id
    ), latest_source_revision AS (
      SELECT s.meter_id, s.observed_at_ms, MAX(s.source_revision) AS source_revision
      FROM quota_snapshot_observation s
      JOIN latest_time t ON t.meter_id = s.meter_id AND t.observed_at_ms = s.observed_at_ms
      WHERE s.provider = ? AND s.source_key = ?
        AND s.account_scope = (SELECT account_scope FROM active_account)
      GROUP BY s.meter_id, s.observed_at_ms
    )
    SELECT s.meter_id, s.observed_at_ms, s.utilization_percent, s.resets_at_ms,
           COALESCE((
             SELECT MAX(q.revision) FROM quota_revision q
             WHERE q.provider = s.provider AND q.account_scope = s.account_scope
               AND q.source_key = s.source_key
               AND q.observed_at_ms = s.observed_at_ms AND q.meter_id = s.meter_id
               AND q.utilization_percent = s.utilization_percent
               AND q.resets_at_ms IS s.resets_at_ms
           ), 1) AS revision,
           ? AS source_generation
    FROM quota_snapshot_observation s
    JOIN latest_source_revision r
      ON r.meter_id = s.meter_id AND r.observed_at_ms = s.observed_at_ms
      AND r.source_revision = s.source_revision
    WHERE s.provider = ? AND s.source_key = ?
      AND s.account_scope = (SELECT account_scope FROM active_account)
    ORDER BY s.meter_id ASC
  `).all(
    CLAUDE_DESKTOP_QUOTA_PROVIDER,
    source?.sourceKey ?? null,
    CLAUDE_DESKTOP_QUOTA_PROVIDER,
    source?.sourceKey ?? null,
    CLAUDE_DESKTOP_QUOTA_PROVIDER,
    source?.sourceKey ?? null,
    source?.sourceGeneration ?? 1,
    CLAUDE_DESKTOP_QUOTA_PROVIDER,
    source?.sourceKey ?? null,
  );
  const windows = [];
  const seenMeters = new Set();
  for (const row of latest) {
    if (seenMeters.has(row.meter_id)) continue;
    seenMeters.add(row.meter_id);
    windows.push({
      meterId: row.meter_id,
      utilizationPercent: Number(row.utilization_percent),
      remainingPercent: 100 - Number(row.utilization_percent),
      observedAtMs: Number(row.observed_at_ms),
      revision: Number(row.revision),
      resetsAtMs: row.resets_at_ms === null ? null : Number(row.resets_at_ms),
      sourceGeneration: Number(row.source_generation),
      windowDurationMinutes: Object.prototype.hasOwnProperty.call(
        METER_DURATIONS_MINUTES,
        row.meter_id,
      ) ? METER_DURATIONS_MINUTES[row.meter_id] : null,
    });
  }
  const hasObservations = Number(counts.observations) > 0;
  const hasReviewedWindows = windows.length > 0;
  const stale = source?.status !== "present" || source?.lastSuccessAtMs === null
    || source?.lastSuccessAtMs === undefined
    || now - source.lastSuccessAtMs > staleAfterMs;
  const status = !source
    ? "unavailable"
    : source.status === "present" && hasReviewedWindows && !stale
      ? "available"
      : source.status === "present" && hasReviewedWindows
        ? "stale"
        : hasObservations && source.status !== "present" ? "stale" : "unavailable";
  const coverageState = !hasReviewedWindows
    ? hasObservations && source?.status !== "present" ? "partial" : "unavailable"
    : gapCount > 0 || source?.status !== "present" ? "partial" : "complete";
  return {
    schemaVersion: CLAUDE_DESKTOP_QUOTA_STATE_VERSION,
    provider: CLAUDE_DESKTOP_QUOTA_PROVIDER,
    authority: CLAUDE_DESKTOP_QUOTA_AUTHORITY,
    status,
    source: source ? {
      status: source.status,
      sourceGeneration: source.sourceGeneration,
      observedAtMs: source.observedAtMs,
      firstObservedAtMs: source.firstObservedAtMs,
      lastSuccessAtMs: source.lastSuccessAtMs,
      lastErrorCode: source.lastErrorCode,
    } : {
      status: "missing_suspected",
      sourceGeneration: null,
      observedAtMs: null,
      firstObservedAtMs: null,
      lastSuccessAtMs: null,
      lastErrorCode: "source_missing",
    },
    freshness: stale ? "stale" : "fresh",
    coverage: {
      state: coverageState,
      gapCount,
      startAtMs: source?.coverageStartAtMs ?? null,
      endAtMs: source?.coverageEndAtMs ?? null,
    },
    counts: {
      observations: Number(counts.observations),
      points: Number(counts.points),
      accounts: Number(counts.accounts),
      meters: Number(counts.meters),
      unknownMeters: Number(counts.unknown_meters),
    },
    windows,
  };
}

export function defaultClaudeDesktopQuotaStatePath(dataDirectory = null) {
  const directory = dataDirectory === null
    ? resolve(process.cwd(), ".usage-monitor") : safeStatePath(dataDirectory);
  return resolve(directory, "claude-desktop-quota.sqlite");
}

export function openClaudeDesktopQuotaState(path) {
  const selectedPath = safeStatePath(path);
  createOwnerOnlyDatabase(selectedPath);
  let database;
  try {
    database = new DatabaseSync(selectedPath);
    configure(database);
  } catch (error) {
    database?.close();
    throw error;
  }

  function transact(callback) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  return {
    mergeQuotaObservations(observations, {
      sourceKey,
      sourceGeneration = null,
      acceptedAtMs = Date.now(),
      sourceMetadata = null,
    } = {}) {
      if (!Array.isArray(observations)) fail("quota");
      const accepted = safeTimestamp(acceptedAtMs);
      const key = sourceKeyFrom(sourceKey);
      const metadata = sourceMetadata === null ? null : safeMetadata(sourceMetadata);
      return transact(() => {
        let coverageStart = null;
        let coverageEnd = null;
        const sourceRevisions = new Map();
        const normalized = observations.map((value) => {
          const item = normalizeObservation(value);
          const point = snapshotObservationKey(
            item.accountScope, item.observedAtMs, item.meterId,
          );
          const assigned = item.sourceRevision ?? ((sourceRevisions.get(point) ?? 0) + 1);
          sourceRevisions.set(point, Math.max(sourceRevisions.get(point) ?? 0, assigned));
          coverageStart = coverageStart === null
            ? item.observedAtMs : Math.min(coverageStart, item.observedAtMs);
          coverageEnd = coverageEnd === null
            ? item.observedAtMs : Math.max(coverageEnd, item.observedAtMs);
          return { ...item, sourceRevision: assigned };
        });
        const priorSnapshot = snapshotState(database.prepare(`
          SELECT * FROM quota_snapshot_state WHERE provider = ? AND source_key = ?
        `).get(CLAUDE_DESKTOP_QUOTA_PROVIDER, key));
        const priorRows = database.prepare(`
          SELECT account_scope, observed_at_ms, meter_id, source_revision,
                 utilization_percent, resets_at_ms
          FROM quota_snapshot_observation WHERE provider = ? AND source_key = ?
        `).all(CLAUDE_DESKTOP_QUOTA_PROVIDER, key);
        const latestKnownAccount = (rows) => rows
          .filter((row) => !row.meter_id.startsWith("unknown_"))
          .sort((left, right) => (
            Number(right.observed_at_ms) - Number(left.observed_at_ms)
            || Number(right.source_revision) - Number(left.source_revision)
            || String(left.account_scope).localeCompare(String(right.account_scope), "en")
          ))[0]?.account_scope ?? null;
        const currentRows = normalized.map((item) => ({
          account_scope: item.accountScope,
          observed_at_ms: item.observedAtMs,
          meter_id: item.meterId,
          source_revision: item.sourceRevision,
          utilization_percent: item.utilizationPercent,
          resets_at_ms: item.resetsAtMs,
        }));
        const priorAccount = latestKnownAccount(priorRows);
        const currentAccount = latestKnownAccount(currentRows);
        const metersFor = (rows, account) => new Set(rows
          .filter((row) => row.account_scope === account && !row.meter_id.startsWith("unknown_"))
          .map((row) => row.meter_id));
        const priorMeters = metersFor(priorRows, priorAccount);
        const currentMeters = metersFor(currentRows, currentAccount);
        const lostCurrentMeter = priorAccount !== null && priorAccount === currentAccount
          && [...priorMeters].some((meter) => !currentMeters.has(meter));
        const lostReviewedAccount = priorAccount !== null && currentAccount === null;
        const retainedObservationCount = Number(database.prepare(`
          SELECT COUNT(*) AS count FROM quota_revision WHERE provider = ?
        `).get(CLAUDE_DESKTOP_QUOTA_PROVIDER).count);
        const regressedCoverage = priorSnapshot !== null && (
          (coverageEnd === null
            && (priorSnapshot.observationCount > 0 || retainedObservationCount > 0))
          || (coverageEnd !== null && priorSnapshot.coverageEndAtMs !== null
            && coverageEnd < priorSnapshot.coverageEndAtMs)
          || (normalized.length < priorSnapshot.observationCount
            && coverageEnd !== null && priorSnapshot.coverageEndAtMs !== null
            && coverageEnd <= priorSnapshot.coverageEndAtMs)
          || lostCurrentMeter
          || lostReviewedAccount
        );
        const source = sourceUpsert(database, {
          sourceKey: key,
          sourceGeneration: sourceGeneration === null ? undefined : sourceGeneration,
          status: regressedCoverage ? "partial" : "present",
          observedAtMs: accepted,
          metadata,
          coverageStartAtMs: coverageStart,
          coverageEndAtMs: coverageEnd,
          successful: !regressedCoverage,
        });
        const selectedGeneration = source.sourceGeneration;
        let inserted = 0;
        let duplicates = 0;
        let revisions = 0;
        const priorBySlot = new Map(priorRows.map((row) => [
          `${snapshotObservationKey(row.account_scope, row.observed_at_ms, row.meter_id)}\0${row.source_revision}`,
          row,
        ]));
        const latestValue = new Map();
        const durableLatestStatement = database.prepare(`
          SELECT utilization_percent, resets_at_ms FROM quota_revision
          WHERE provider = ? AND account_scope = ? AND observed_at_ms = ? AND meter_id = ?
          ORDER BY revision DESC LIMIT 1
        `);
        const insertStatement = database.prepare(`
          INSERT INTO quota_revision(
            provider, account_scope, observed_at_ms, meter_id, revision,
            utilization_percent, resets_at_ms, source_key, source_generation, accepted_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const item of normalized) {
          const point = snapshotObservationKey(
            item.accountScope, item.observedAtMs, item.meterId,
          );
          const slot = `${point}\0${item.sourceRevision}`;
          const prior = priorBySlot.get(slot);
          const sameValue = (value) => value !== undefined
            && Number(value.utilization_percent) === item.utilizationPercent
            && (value.resets_at_ms === null ? null : Number(value.resets_at_ms)) === item.resetsAtMs;
          if (sameValue(prior)) {
            duplicates += 1;
            latestValue.set(point, prior);
            continue;
          }
          const previous = latestValue.get(point) ?? durableLatestStatement.get(
            item.provider, item.accountScope, item.observedAtMs, item.meterId,
          );
          if (sameValue(previous)) {
            duplicates += 1;
            latestValue.set(point, {
              utilization_percent: item.utilizationPercent,
              resets_at_ms: item.resetsAtMs,
            });
            continue;
          }
          const revision = maxRevision(database, item) + 1;
          insertStatement.run(
            item.provider,
            item.accountScope,
            item.observedAtMs,
            item.meterId,
            revision,
            item.utilizationPercent,
            item.resetsAtMs,
            key,
            selectedGeneration,
            accepted,
          );
          inserted += 1;
          if (revision > 1) revisions += 1;
          latestValue.set(point, {
            utilization_percent: item.utilizationPercent,
            resets_at_ms: item.resetsAtMs,
          });
        }
        database.prepare(`
          DELETE FROM quota_snapshot_observation WHERE provider = ? AND source_key = ?
        `).run(CLAUDE_DESKTOP_QUOTA_PROVIDER, key);
        const insertSnapshot = database.prepare(`
          INSERT INTO quota_snapshot_observation(
            provider, source_key, account_scope, observed_at_ms, meter_id,
            source_revision, utilization_percent, resets_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const item of normalized) {
          insertSnapshot.run(
            item.provider, key, item.accountScope, item.observedAtMs, item.meterId,
            item.sourceRevision, item.utilizationPercent, item.resetsAtMs,
          );
        }
        database.prepare(`
          INSERT INTO quota_snapshot_state(
            provider, source_key, observation_count, coverage_start_at_ms, coverage_end_at_ms
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(provider, source_key) DO UPDATE SET
            observation_count = excluded.observation_count,
            coverage_start_at_ms = excluded.coverage_start_at_ms,
            coverage_end_at_ms = excluded.coverage_end_at_ms
        `).run(
          CLAUDE_DESKTOP_QUOTA_PROVIDER,
          key,
          normalized.length,
          coverageStart,
          coverageEnd,
        );
        return {
          inserted,
          duplicates,
          revisions,
          sourceGeneration: selectedGeneration,
          sourceStatus: regressedCoverage ? "partial" : "present",
        };
      });
    },

    markSourceStatus({
      sourceKey,
      status,
      observedAtMs = Date.now(),
      errorCode = null,
    } = {}) {
      const selectedStatus = safeStatus(status);
      if (selectedStatus === "present") fail("status");
      const timestamp = safeTimestamp(observedAtMs);
      return transact(() => sourceUpsert(database, {
        sourceKey,
        status: selectedStatus,
        observedAtMs: timestamp,
        errorCode: typeof errorCode === "string" && /^[a-z0-9_]{1,96}$/u.test(errorCode)
          ? errorCode : null,
      }));
    },

    markSourcePresent({
      sourceKey,
      sourceMetadata = null,
      observedAtMs = Date.now(),
      coverageStartAtMs = null,
      coverageEndAtMs = null,
    } = {}) {
      const timestamp = safeTimestamp(observedAtMs);
      return transact(() => sourceUpsert(database, {
        sourceKey,
        status: "present",
        observedAtMs: timestamp,
        metadata: sourceMetadata,
        coverageStartAtMs,
        coverageEndAtMs,
        successful: true,
      }));
    },

    readSourceState(sourceKey) {
      const key = sourceKeyFrom(sourceKey);
      return sourceSnapshot(database.prepare(`
        SELECT * FROM source_state WHERE provider = ? AND source_key = ?
      `).get(CLAUDE_DESKTOP_QUOTA_PROVIDER, key));
    },

    readProjection(options = {}) {
      return readProjection(database, options);
    },

    close() {
      database.close();
    },
  };
}

export function readClaudeDesktopQuotaProjection(path, options = {}) {
  const state = openClaudeDesktopQuotaState(path);
  try {
    return state.readProjection(options);
  } finally {
    state.close();
  }
}
