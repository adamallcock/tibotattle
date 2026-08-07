import { createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// The one local index.
//
// Everything the product needs in order to show a figure or to upload a
// contribution lives here, in typed columns. There is no JSON payload: the
// previous record shape spent 345 bytes per row re-encoding seven values that
// were byte-identical on all 662,454 rows, and re-parsed JSON on every read.
//
// Privacy invariants, enforced by construction rather than by review:
//
//   * No prompt, reply, reasoning or file content is read, parsed, retained or
//     logged. Only `turn_context`, `token_count` and `thread_settings_applied`
//     records are parsed, and only their metadata fields are projected. There
//     is no column in this schema that can hold free text from a rollout.
//   * `session_local` is HMAC(device_salt, codex_session_id) — 32 raw bytes,
//     irreversible, never leaves the Mac, never rotates. The upload pseudonym
//     stays HMAC(export_secret, session_local), computed at send time, and is
//     never stored here. Rotating the export secret therefore costs nothing;
//     under the old shape each rotation invalidated the whole index.
//   * `scope_local` is the same construction over the local account scope id.

export const LOCAL_UNIFIED_INDEX_SCHEMA_VERSION = "local-unified-index-v1";

// Stamped onto every row. A parser change re-scans only the affected rows'
// source files; rows whose rollout files have rotated away keep their
// last-good values and stay visibly marked as older-parser output.
export const LOCAL_UNIFIED_INDEX_PARSER_VERSION = "unified-rollout-typed-v1";

// A row salvaged from a line that exceeded the bounded-line cap carries this
// parser version instead. The agreed schema has no "partial" column and the
// `outcome` enum is fixed by the telemetry contract, so the row-level parser
// stamp — which decision 4 of the design exists to provide — is where a
// degraded row is recorded.
export const LOCAL_UNIFIED_INDEX_PARTIAL_PARSER_VERSION =
  "unified-rollout-typed-v1-partial";

const INDEX_APPLICATION_ID = 0x554d5549;
const INDEX_USER_VERSION = 1;
const SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 256;
const DEFAULT_COMMIT_ROWS = 10_000;

// Both enums are ordinals into the telemetry contract's fixed member lists.
// Their order is part of the on-disk format: append only, never reorder.
export const REASONING_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "unknown",
]);
export const OUTCOMES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "retry",
  "unknown",
]);
const REASONING_EFFORT_ORDINALS = new Map(
  REASONING_EFFORTS.map((value, index) => [value, index]),
);
const OUTCOME_ORDINALS = new Map(OUTCOMES.map((value, index) => [value, index]));
export const REASONING_EFFORT_UNKNOWN = REASONING_EFFORT_ORDINALS.get("unknown");
export const OUTCOME_UNKNOWN = OUTCOME_ORDINALS.get("unknown");

export function reasoningEffortOrdinal(value) {
  return REASONING_EFFORT_ORDINALS.get(value) ?? REASONING_EFFORT_UNKNOWN;
}

export function outcomeOrdinal(value) {
  return OUTCOME_ORDINALS.get(value) ?? OUTCOME_UNKNOWN;
}

export function reasoningEffortName(ordinal) {
  return REASONING_EFFORTS[ordinal] ?? "unknown";
}

export function outcomeName(ordinal) {
  return OUTCOMES[ordinal] ?? "unknown";
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL) STRICT;

  -- Dimensions. Small, deduplicated, joined by integer id.
  CREATE TABLE IF NOT EXISTS parser_version(
    id INTEGER PRIMARY KEY,
    parser_version TEXT NOT NULL,
    contract_version TEXT NOT NULL,
    UNIQUE(parser_version, contract_version)) STRICT;

  CREATE TABLE IF NOT EXISTS ingest_run(
    id INTEGER PRIMARY KEY,
    received_at_ms INTEGER NOT NULL,
    parser_version_id INTEGER NOT NULL REFERENCES parser_version) STRICT;

  CREATE TABLE IF NOT EXISTS model(
    id INTEGER PRIMARY KEY,
    model_id TEXT NOT NULL UNIQUE,
    recognition TEXT NOT NULL) STRICT;

  CREATE TABLE IF NOT EXISTS tier_semantics(
    id INTEGER PRIMARY KEY,
    api_service_tier TEXT NOT NULL,
    billing_surface TEXT NOT NULL,
    codex_speed_mode TEXT NOT NULL,
    tier_source TEXT NOT NULL,
    provider_tier_raw TEXT,
    UNIQUE(api_service_tier, billing_surface, codex_speed_mode,
           tier_source, provider_tier_raw)) STRICT;

  CREATE TABLE IF NOT EXISTS surface_class(
    id INTEGER PRIMARY KEY,
    agent_scope TEXT NOT NULL,
    surface TEXT NOT NULL,
    thread_source TEXT NOT NULL,
    lineage_disposition TEXT NOT NULL,
    UNIQUE(agent_scope, surface, thread_source, lineage_disposition)) STRICT;

  CREATE TABLE IF NOT EXISTS account_scope(
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    reason TEXT,
    plan_type TEXT,
    scope_local BLOB,
    UNIQUE(status, reason, plan_type, scope_local)) STRICT;

  -- Quota observations as their own series, referenced by usage events. Quota
  -- is re-observed every few minutes while turns fire continuously, so this
  -- deduplicates heavily while preserving the exact event-to-quota pairing the
  -- calibration depends on.
  CREATE TABLE IF NOT EXISTS quota_observation(
    id INTEGER PRIMARY KEY,
    observed_at_ms INTEGER NOT NULL,
    limit_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    plan_type TEXT,
    used_percent REAL,
    resets_at_ms INTEGER,
    duration_mins INTEGER,
    UNIQUE(observed_at_ms, limit_id, slot)) STRICT;

  -- Facts. Fixed width, typed, no JSON.
  CREATE TABLE IF NOT EXISTS usage_event(
    event_key BLOB PRIMARY KEY,
    observed_at_ms INTEGER NOT NULL,
    ingest_run_id INTEGER NOT NULL REFERENCES ingest_run,
    parser_version_id INTEGER NOT NULL REFERENCES parser_version,
    session_local BLOB NOT NULL,
    account_scope_id INTEGER NOT NULL REFERENCES account_scope,
    model_id INTEGER NOT NULL REFERENCES model,
    tier_id INTEGER NOT NULL REFERENCES tier_semantics,
    surface_id INTEGER NOT NULL REFERENCES surface_class,
    quota_observation_id INTEGER REFERENCES quota_observation,
    reasoning_effort INTEGER NOT NULL,
    outcome INTEGER NOT NULL,
    -- Token counts. Integers only. No prompt, reply, reasoning or file content
    -- is read, parsed or stored anywhere in this schema.
    tokens_in_uncached INTEGER,
    tokens_in_cache_read INTEGER,
    tokens_in_cache_write INTEGER,
    tokens_in_cache_write_5m INTEGER,
    tokens_in_cache_write_1h INTEGER,
    tokens_out_text INTEGER,
    tokens_out_reasoning INTEGER,
    tokens_out_combined INTEGER,
    total_input_context INTEGER) STRICT;

  CREATE TABLE IF NOT EXISTS tool_class_count(
    session_local BLOB NOT NULL,
    tool_class TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY(session_local, tool_class)) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS usage_event_observed
    ON usage_event(observed_at_ms);
  CREATE INDEX IF NOT EXISTS usage_event_session
    ON usage_event(session_local);
`;

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function defaultLocalUnifiedIndexPath(root = process.cwd()) {
  return resolve(root, ".usage-monitor", "local-unified-index-v1.sqlite");
}

export function defaultLocalUnifiedIndexSecretPath(
  indexFile = defaultLocalUnifiedIndexPath(),
) {
  return resolve(dirname(resolve(indexFile)), "local-unified-index-device-salt-v1");
}

function ownerOnlyRegularFile(metadata) {
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1
    && (typeof process.getuid !== "function" || metadata.uid === process.getuid())
    && (process.platform === "win32" || (metadata.mode & 0o077) === 0);
}

/**
 * The device salt. 32 random bytes, owner-only, created once and never
 * rotated: it is the key for `session_local`, which is the join key of the
 * whole index. Rotation is deliberately not offered — the value it protects
 * never leaves this machine, and rotating it would orphan every stored row.
 */
export async function readOrCreateDeviceSalt(
  secretFile = defaultLocalUnifiedIndexSecretPath(),
) {
  await mkdir(dirname(resolve(secretFile)), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(
      secretFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const secret = randomBytes(SECRET_BYTES);
    await handle.writeFile(secret);
    await handle.sync();
    return secret;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw fixedError("local_unified_index_secret_unavailable");
    }
  } finally {
    await handle?.close();
  }
  let readHandle;
  try {
    readHandle = await open(
      secretFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const metadata = await readHandle.stat();
    if (!ownerOnlyRegularFile(metadata)
        || metadata.size < SECRET_BYTES
        || metadata.size > MAX_SECRET_BYTES) {
      throw fixedError("local_unified_index_secret_invalid");
    }
    const buffer = Buffer.alloc(metadata.size);
    await readHandle.read(buffer, 0, buffer.length, 0);
    await chmod(secretFile, 0o600);
    return buffer;
  } catch (error) {
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_secret_unavailable");
  } finally {
    await readHandle?.close();
  }
}

/**
 * The single local one-way derivation used by this index.
 *
 * Domain-separated exactly as the rest of the product does it: a
 * NUL-terminated `app-usagemonitor/<domain>/v1\0` label is committed before the
 * subject, so a session id can never collide with an account scope id.
 * Returns 32 raw bytes; the old shape stored 64 hex characters for the same
 * information.
 */
export function localDigest(deviceSalt, domain, subject) {
  if (!Buffer.isBuffer(deviceSalt) && !ArrayBuffer.isView(deviceSalt)) {
    throw new TypeError("deviceSalt must be a byte buffer");
  }
  if (typeof domain !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(domain)) {
    throw new TypeError("domain must be a short lowercase label");
  }
  if (typeof subject !== "string" || subject.length < 1 || subject.length > 4096) {
    throw new TypeError("subject must be a bounded string");
  }
  return createHmac("sha256", deviceSalt)
    .update(`app-usagemonitor/${domain}/v1\0`, "utf8")
    .update(subject, "utf8")
    .digest();
}

export function sessionLocal(deviceSalt, codexSessionId) {
  return localDigest(deviceSalt, "unified-index-session", codexSessionId);
}

export function scopeLocal(deviceSalt, accountScopeId) {
  return localDigest(deviceSalt, "unified-index-scope", accountScopeId);
}

function configureDatabase(database, { readOnly = false, staging = false } = {}) {
  if (!readOnly) {
    // WAL measured slower than DELETE+FULL on this store. During a rebuild the
    // target is a staging file that is discarded on failure and published by
    // atomic rename after an explicit fsync, so durability there is bought
    // once at the end rather than on every batch.
    // `journal_mode` returns a row, and setting it through `exec()` leaves the
    // mode unchanged — verified by reading it back. It has to be stepped as a
    // statement.
    //
    // The durable mode is DELETE: WAL measured slower than DELETE+FULL on this
    // store. A staging build asks for MEMORY instead, which keeps the rollback
    // journal bounded by one commit batch rather than writing it to disk.
    // (`OFF` is refused outright by the SQLite this runtime bundles — it
    // returns `delete` — so it is not requested.) Whatever mode SQLite grants
    // is recorded rather than assumed, because a staging build that silently
    // keeps a disk journal is only slower, never wrong.
    const journalMode = database
      .prepare(`PRAGMA journal_mode = ${staging ? "MEMORY" : "DELETE"}`)
      .get()?.journal_mode ?? "unknown";
    if (!staging && journalMode !== "delete") {
      throw fixedError("local_unified_index_journal_mode_refused");
    }
    database.exec(staging
      ? `
        PRAGMA synchronous=OFF;
        PRAGMA locking_mode=EXCLUSIVE;
      `
      : "PRAGMA synchronous=FULL;");
  }
  database.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA trusted_schema=OFF;
    PRAGMA temp_store=FILE;
    PRAGMA cache_size=-32768;
    PRAGMA mmap_size=0;
  `);
  database.enableDefensive?.(true);
}

function initializeSchema(database) {
  database.exec(`
    PRAGMA application_id=${INDEX_APPLICATION_ID};
    PRAGMA user_version=${INDEX_USER_VERSION};
    ${SCHEMA}
  `);
  database.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)")
    .run("schema_version", LOCAL_UNIFIED_INDEX_SCHEMA_VERSION);
}

function validateDatabase(database) {
  const applicationId = Number(
    database.prepare("PRAGMA application_id").get().application_id,
  );
  const userVersion = Number(
    database.prepare("PRAGMA user_version").get().user_version,
  );
  const schema = database.prepare(
    "SELECT value FROM meta WHERE key = 'schema_version'",
  ).get();
  if (applicationId !== INDEX_APPLICATION_ID
      || userVersion !== INDEX_USER_VERSION
      || schema?.value !== LOCAL_UNIFIED_INDEX_SCHEMA_VERSION) {
    throw fixedError("local_unified_index_schema_invalid");
  }
}

export function openLocalUnifiedIndex(indexFile, {
  readOnly = false,
  create = false,
  staging = false,
} = {}) {
  let database;
  try {
    database = new DatabaseSync(indexFile, { readOnly, timeout: 5_000 });
    configureDatabase(database, { readOnly, staging });
    if (create) initializeSchema(database);
    validateDatabase(database);
    return database;
  } catch (error) {
    if (database?.isOpen) database.close();
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_unavailable");
  }
}

async function syncFile(path) {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryPath(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Directory fsync is a best-effort durability step on platforms that
    // refuse to open a directory read-only. The rename itself is still atomic.
  } finally {
    await handle?.close();
  }
}

/**
 * A bulk writer over one persistent connection.
 *
 * The measured reason this exists: the previous write path ran
 * `PRAGMA quick_check` on every 1,000-record batch. quick_check reads every
 * page, so its cost scales with database size — 636-663 ms of a 754 ms batch,
 * 84% of the write path, growing as the store grew. It now runs exactly once,
 * at `close()`, together with one `PRAGMA optimize` and one fsync. A
 * 642,609-record rebuild went from 308.6s to 95.0s on that change alone, and
 * to 36.3s with 10,000-row batches and this persistent connection.
 */
export function createUnifiedIndexWriter(database, {
  commitRows = DEFAULT_COMMIT_ROWS,
  receivedAtMs = Date.now(),
  parserVersion = LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  contractVersion,
} = {}) {
  if (!Number.isSafeInteger(commitRows) || commitRows < 1) {
    throw new TypeError("commitRows must be a positive safe integer");
  }
  if (typeof contractVersion !== "string" || contractVersion.length < 1) {
    throw new TypeError("contractVersion must be a non-empty string");
  }

  const statements = {
    parserVersion: database.prepare(`
      INSERT INTO parser_version(parser_version, contract_version)
      VALUES (?, ?) ON CONFLICT DO NOTHING`),
    selectParserVersion: database.prepare(`
      SELECT id FROM parser_version
      WHERE parser_version = ? AND contract_version = ?`),
    ingestRun: database.prepare(`
      INSERT INTO ingest_run(received_at_ms, parser_version_id) VALUES (?, ?)`),
    model: database.prepare(`
      INSERT INTO model(model_id, recognition) VALUES (?, ?)
      ON CONFLICT(model_id) DO NOTHING`),
    selectModel: database.prepare("SELECT id FROM model WHERE model_id = ?"),
    tier: database.prepare(`
      INSERT INTO tier_semantics(api_service_tier, billing_surface,
        codex_speed_mode, tier_source, provider_tier_raw)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`),
    selectTier: database.prepare(`
      SELECT id FROM tier_semantics
      WHERE api_service_tier = ? AND billing_surface = ?
        AND codex_speed_mode = ? AND tier_source = ?
        AND provider_tier_raw IS ?`),
    surface: database.prepare(`
      INSERT INTO surface_class(agent_scope, surface, thread_source,
        lineage_disposition)
      VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`),
    selectSurface: database.prepare(`
      SELECT id FROM surface_class
      WHERE agent_scope = ? AND surface = ? AND thread_source = ?
        AND lineage_disposition = ?`),
    accountScope: database.prepare(`
      INSERT INTO account_scope(status, reason, plan_type, scope_local)
      VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`),
    selectAccountScope: database.prepare(`
      SELECT id FROM account_scope
      WHERE status = ? AND reason IS ? AND plan_type IS ? AND scope_local IS ?`),
    // Two rollout files genuinely report the same (observed_at_ms, limit_id,
    // slot) with different readings — a fork replays the parent's older
    // percentage stamped with the fork's own timestamp, alongside the live
    // one. `DO NOTHING` would resolve that by arrival order, which differs
    // between a single-threaded and a worker rebuild: measured at 180 of
    // 1,934,526 rows.
    //
    // The tie-break keeps one whole observed tuple rather than mixing fields
    // from two, and the ordering is total, so the outcome is the same under
    // any arrival order. Higher `used_percent` wins because a quota gauge that
    // reached a level did reach it; a later `resets_at_ms` breaks an exact
    // tie, since it names the newer allowance window.
    quota: database.prepare(`
      INSERT INTO quota_observation(observed_at_ms, limit_id, slot, plan_type,
        used_percent, resets_at_ms, duration_mins)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(observed_at_ms, limit_id, slot) DO UPDATE SET
        plan_type = excluded.plan_type,
        used_percent = excluded.used_percent,
        resets_at_ms = excluded.resets_at_ms,
        duration_mins = excluded.duration_mins
      WHERE excluded.used_percent > quota_observation.used_percent
        OR (excluded.used_percent IS quota_observation.used_percent
            AND COALESCE(excluded.resets_at_ms, -1)
                > COALESCE(quota_observation.resets_at_ms, -1))`),
    selectQuota: database.prepare(`
      SELECT id FROM quota_observation
      WHERE observed_at_ms = ? AND limit_id = ? AND slot = ?`),
    usage: database.prepare(`
      INSERT INTO usage_event(
        event_key, observed_at_ms, ingest_run_id, parser_version_id,
        session_local, account_scope_id, model_id, tier_id, surface_id,
        quota_observation_id, reasoning_effort, outcome,
        tokens_in_uncached, tokens_in_cache_read, tokens_in_cache_write,
        tokens_in_cache_write_5m, tokens_in_cache_write_1h,
        tokens_out_text, tokens_out_reasoning, tokens_out_combined,
        total_input_context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_key) DO NOTHING`),
    toolClass: database.prepare(`
      INSERT INTO tool_class_count(session_local, tool_class, count)
      VALUES (?, ?, ?)
      ON CONFLICT(session_local, tool_class)
      DO UPDATE SET count = count + excluded.count`),
    meta: database.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  };

  // Interning caches. Every dimension in this schema has at most a few
  // thousand distinct rows across the whole corpus (`surfaceClassification`
  // had six distinct values across 662,454 records, `accountScope` one), so
  // these are bounded by the data's own cardinality, not by row count.
  const parserVersionIds = new Map();
  const modelIds = new Map();
  const tierIds = new Map();
  const surfaceIds = new Map();
  const accountScopeIds = new Map();
  const quotaIds = new Map();

  let open = false;
  let pending = 0;
  let usageRows = 0;
  let toolRows = 0;
  let batches = 0;

  function begin() {
    if (open) return;
    database.exec("BEGIN IMMEDIATE");
    open = true;
  }

  function commit() {
    if (!open) return;
    database.exec("COMMIT");
    open = false;
    pending = 0;
    batches += 1;
  }

  function step() {
    pending += 1;
    if (pending >= commitRows) commit();
  }

  function internParserVersion(version) {
    const cached = parserVersionIds.get(version);
    if (cached !== undefined) return cached;
    begin();
    statements.parserVersion.run(version, contractVersion);
    const id = Number(statements.selectParserVersion.get(version, contractVersion).id);
    parserVersionIds.set(version, id);
    return id;
  }

  const defaultParserVersionId = (() => {
    begin();
    return internParserVersion(parserVersion);
  })();
  const ingestRunId = (() => {
    begin();
    return Number(
      statements.ingestRun.run(receivedAtMs, defaultParserVersionId).lastInsertRowid,
    );
  })();

  function internModel(modelId, recognition) {
    const cached = modelIds.get(modelId);
    if (cached !== undefined) return cached;
    begin();
    statements.model.run(modelId, recognition);
    const id = Number(statements.selectModel.get(modelId).id);
    modelIds.set(modelId, id);
    return id;
  }

  function internTier(tier) {
    const key = `${tier.apiServiceTier} ${tier.billingSurface} ${tier.codexSpeedMode} ${tier.tierSource} ${tier.providerTierRaw ?? ""} ${tier.providerTierRaw === null ? "n" : "s"}`;
    const cached = tierIds.get(key);
    if (cached !== undefined) return cached;
    begin();
    statements.tier.run(
      tier.apiServiceTier,
      tier.billingSurface,
      tier.codexSpeedMode,
      tier.tierSource,
      tier.providerTierRaw,
    );
    const id = Number(statements.selectTier.get(
      tier.apiServiceTier,
      tier.billingSurface,
      tier.codexSpeedMode,
      tier.tierSource,
      tier.providerTierRaw,
    ).id);
    tierIds.set(key, id);
    return id;
  }

  function internSurface(surface) {
    const key = `${surface.agentScope} ${surface.surface} ${surface.threadSource} ${surface.lineageDisposition}`;
    const cached = surfaceIds.get(key);
    if (cached !== undefined) return cached;
    begin();
    statements.surface.run(
      surface.agentScope,
      surface.surface,
      surface.threadSource,
      surface.lineageDisposition,
    );
    const id = Number(statements.selectSurface.get(
      surface.agentScope,
      surface.surface,
      surface.threadSource,
      surface.lineageDisposition,
    ).id);
    surfaceIds.set(key, id);
    return id;
  }

  function internAccountScope(scope) {
    const scopeBlob = scope.scopeLocal ?? null;
    const key = `${scope.status} ${scope.reason ?? ""} ${scope.reason === null ? "n" : "s"} ${scope.planType ?? ""} ${scope.planType === null ? "n" : "s"} ${scopeBlob === null ? "" : Buffer.from(scopeBlob).toString("base64")}`;
    const cached = accountScopeIds.get(key);
    if (cached !== undefined) return cached;
    begin();
    statements.accountScope.run(
      scope.status,
      scope.reason ?? null,
      scope.planType ?? null,
      scopeBlob,
    );
    const id = Number(statements.selectAccountScope.get(
      scope.status,
      scope.reason ?? null,
      scope.planType ?? null,
      scopeBlob,
    ).id);
    accountScopeIds.set(key, id);
    return id;
  }

  function internQuota(observation) {
    // The cache key is the whole observation, not just its uniqueness key.
    // Caching on the uniqueness key alone would let the first arrival suppress
    // a genuinely different reading for the same millisecond, reintroducing the
    // arrival-order dependence the upsert above exists to remove.
    const key = `${observation.observedAtMs} ${observation.limitId} ${observation.slot}`
      + ` ${observation.planType ?? ""} ${observation.usedPercent ?? ""}`
      + ` ${observation.resetsAtMs ?? ""} ${observation.durationMins ?? ""}`;
    const cached = quotaIds.get(key);
    if (cached !== undefined) return cached;
    begin();
    statements.quota.run(
      observation.observedAtMs,
      observation.limitId,
      observation.slot,
      observation.planType ?? null,
      observation.usedPercent ?? null,
      observation.resetsAtMs ?? null,
      observation.durationMins ?? null,
    );
    const id = Number(statements.selectQuota.get(
      observation.observedAtMs,
      observation.limitId,
      observation.slot,
    ).id);
    quotaIds.set(key, id);
    // The cache would otherwise grow with the quota series. Quota is observed
    // every few minutes, so this stays small over any real history, but keep
    // an explicit ceiling rather than an implicit one.
    if (quotaIds.size > 200_000) quotaIds.clear();
    return id;
  }

  return {
    get usageRows() { return usageRows; },
    get toolRows() { return toolRows; },
    get batches() { return batches; },
    ingestRunId,

    internModel,
    internTier,
    internSurface,
    internAccountScope,
    internQuota,
    internParserVersion,

    writeUsageEvent(event) {
      begin();
      const changes = statements.usage.run(
        event.eventKey,
        event.observedAtMs,
        ingestRunId,
        event.partial
          ? internParserVersion(LOCAL_UNIFIED_INDEX_PARTIAL_PARSER_VERSION)
          : defaultParserVersionId,
        event.sessionLocal,
        event.accountScopeId,
        event.modelId,
        event.tierId,
        event.surfaceId,
        event.quotaObservationId ?? null,
        event.reasoningEffort,
        event.outcome,
        event.tokensInUncached ?? null,
        event.tokensInCacheRead ?? null,
        event.tokensInCacheWrite ?? null,
        event.tokensInCacheWrite5m ?? null,
        event.tokensInCacheWrite1h ?? null,
        event.tokensOutText ?? null,
        event.tokensOutReasoning ?? null,
        event.tokensOutCombined ?? null,
        event.totalInputContext ?? null,
      );
      const inserted = Number(changes.changes ?? 0);
      usageRows += inserted;
      step();
      return inserted;
    },

    addToolClassCount(sessionLocalKey, toolClass, count) {
      if (count <= 0) return;
      begin();
      statements.toolClass.run(sessionLocalKey, toolClass, count);
      toolRows += 1;
      step();
    },

    writeMeta(key, value) {
      begin();
      statements.meta.run(key, String(value));
      step();
    },

    flush() {
      commit();
    },

    /**
     * Settle the whole run: one optimize, one integrity check, one fsync.
     */
    async close({ integrityCheck = true, fsyncPath = null } = {}) {
      commit();
      database.exec("PRAGMA optimize");
      if (integrityCheck) {
        const result = database.prepare("PRAGMA quick_check").get();
        if (result?.quick_check !== "ok") {
          throw fixedError("local_unified_index_integrity_failed");
        }
      }
      database.close();
      if (fsyncPath !== null) {
        await chmod(fsyncPath, 0o600);
        await syncFile(fsyncPath);
      }
      return { usageRows, toolRows, batches };
    },
  };
}

/**
 * Publish a staged index over the live one by atomic rename. The staged file is
 * fsynced first, so a crash mid-publish leaves either the old index or the new
 * one, never a torn mixture.
 */
export async function publishStagedUnifiedIndex(stageFile, indexFile) {
  await chmod(stageFile, 0o600);
  await syncFile(stageFile);
  await rename(stageFile, indexFile);
  await syncDirectoryPath(dirname(resolve(indexFile)));
  await syncFile(indexFile);
}

export async function removeIfPresent(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const EMPTY_INSPECTION = Object.freeze({
  status: "missing",
  schemaVersion: null,
  usageEvents: 0,
  quotaObservations: 0,
  toolClassRows: 0,
  sessions: 0,
  models: [],
  firstObservedAtMs: null,
  lastObservedAtMs: null,
  indexBytes: 0,
});

export async function inspectLocalUnifiedIndex({
  indexFile = defaultLocalUnifiedIndexPath(),
} = {}) {
  let metadata;
  try {
    metadata = await lstat(indexFile);
  } catch (error) {
    if (error?.code === "ENOENT") return EMPTY_INSPECTION;
    throw fixedError("local_unified_index_unavailable");
  }
  let database;
  try {
    database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    const usage = database.prepare(`
      SELECT COUNT(*) AS events,
             COUNT(DISTINCT session_local) AS sessions,
             MIN(observed_at_ms) AS first_ms,
             MAX(observed_at_ms) AS last_ms
      FROM usage_event`).get();
    const models = database.prepare(`
      SELECT m.model_id AS model_id, m.recognition AS recognition,
             COUNT(*) AS events
      FROM usage_event u JOIN model m ON m.id = u.model_id
      GROUP BY m.model_id, m.recognition
      ORDER BY events DESC`).all().map((row) => ({
        modelId: row.model_id,
        recognition: row.recognition,
        events: Number(row.events),
      }));
    return {
      status: "available",
      schemaVersion: LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
      usageEvents: Number(usage?.events ?? 0),
      quotaObservations: Number(
        database.prepare("SELECT COUNT(*) AS c FROM quota_observation").get()?.c ?? 0,
      ),
      toolClassRows: Number(
        database.prepare("SELECT COUNT(*) AS c FROM tool_class_count").get()?.c ?? 0,
      ),
      sessions: Number(usage?.sessions ?? 0),
      models,
      firstObservedAtMs: usage?.first_ms === null ? null : Number(usage.first_ms),
      lastObservedAtMs: usage?.last_ms === null ? null : Number(usage.last_ms),
      indexBytes: metadata.size,
    };
  } finally {
    database?.close();
  }
}

/**
 * The aggregate used to prove that a rebuild changed nothing observable. It is
 * deliberately computed in SQLite rather than by replaying rows in JavaScript,
 * so it can be run against a 190 MB index without allocating.
 */
export function readUnifiedIndexAggregate(database) {
  const totals = database.prepare(`
    SELECT COUNT(*) AS events,
           COALESCE(SUM(tokens_in_uncached), 0) AS in_uncached,
           COALESCE(SUM(tokens_in_cache_read), 0) AS in_cache_read,
           COALESCE(SUM(tokens_in_cache_write), 0) AS in_cache_write,
           COALESCE(SUM(tokens_out_text), 0) AS out_text,
           COALESCE(SUM(tokens_out_reasoning), 0) AS out_reasoning,
           MIN(observed_at_ms) AS first_ms,
           MAX(observed_at_ms) AS last_ms
    FROM usage_event`).get();
  return {
    events: Number(totals?.events ?? 0),
    inputUncachedTokens: Number(totals?.in_uncached ?? 0),
    inputCacheReadTokens: Number(totals?.in_cache_read ?? 0),
    inputCacheWriteTokens: Number(totals?.in_cache_write ?? 0),
    outputTextTokens: Number(totals?.out_text ?? 0),
    outputReasoningTokens: Number(totals?.out_reasoning ?? 0),
    firstObservedAtMs: totals?.first_ms === null ? null : Number(totals.first_ms),
    lastObservedAtMs: totals?.last_ms === null ? null : Number(totals.last_ms),
  };
}
