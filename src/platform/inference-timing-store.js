import { resolve } from 'node:path';
import { createTimingFilesystem } from './inference-timing-filesystem.js';
import { configureGuardedSqliteConnection } from './windows-protected-sqlite.js';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { forEachRolloutLine } from './rollout-line-reader.js';


const APPLICATION = 0x54425450;
const CHUNK = 16 * 1024 * 1024;
const PRIMARY_TURN_COLUMNS = Object.freeze([
  'at', 'model', 'effort', 'tokens', 'reasoning', 'duration', 'ttft',
  'responses', 'covered', 'quality', 'sample_tokens', 'sample_reasoning',
  'sample_duration', 'sample_responses', 'sample_total_responses', 'sample_method',
  'turn_duration', 'speed_mode', 'speed_mode_source', 'api_service_tier',
]);
const V12_TURN_COLUMNS = Object.freeze([
  'turn_duration', 'speed_mode', 'speed_mode_source', 'api_service_tier',
]);
const REQUIRED_TURN_COLUMNS = Object.freeze([
  'key', 'source', 'offset', ...PRIMARY_TURN_COLUMNS.filter(column => !V12_TURN_COLUMNS.includes(column)),
]);
const REQUIRED_SOURCE_COLUMNS = Object.freeze([
  'id', 'digest', 'fingerprint', 'cursor', 'snapshot', 'state', 'revision', 'telemetry_revision',
]);
const safe = (ok, code) => { if (!ok) throw new Error(code); };

// Parser methods identify the HMAC/keying semantics of each projection.  The
// SQLite schema method is separate so a pre-v1.2 writer (methods 2/3) cannot
// reopen a migrated file and overwrite the additive performance columns.
const STORE_SCHEMA_METHODS = Object.freeze({ 2: 4, 3: 5 });

function schemaMethodFor(method) {
  safe(Number.isSafeInteger(method) && method >= 1, 'invalid_method');
  return STORE_SCHEMA_METHODS[method] ?? method;
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
}

function migrateTimingSchema(db, schemaMethod) {
  const turnColumns = tableColumns(db, 'turn');
  const sourceColumns = tableColumns(db, 'source');
  safe(REQUIRED_TURN_COLUMNS.every(column => turnColumns.has(column))
    && REQUIRED_SOURCE_COLUMNS.every(column => sourceColumns.has(column)
      || column === 'revision' || column === 'telemetry_revision'),
  'incompatible_database');
  const additions = [];
  for (const column of V12_TURN_COLUMNS) {
    if (!turnColumns.has(column)) additions.push(`ALTER TABLE turn ADD COLUMN ${column} ${column === 'turn_duration' ? 'INTEGER' : 'TEXT'}`);
  }
  if (!sourceColumns.has('revision')) additions.push('ALTER TABLE source ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  if (!sourceColumns.has('telemetry_revision')) additions.push('ALTER TABLE source ADD COLUMN telemetry_revision INTEGER NOT NULL DEFAULT 0');
  if (!additions.length) {
    db.exec(`PRAGMA user_version=${schemaMethod}`);
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const sql of additions) db.exec(sql);
    db.exec(`PRAGMA user_version=${schemaMethod}`);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the migration failure. */ }
    throw error;
  }
}

function revisionToken(db, supplement = null) {
  const primary = Number(db.prepare('SELECT COALESCE(SUM(revision),0) AS revision FROM source').get().revision);
  safe(Number.isSafeInteger(primary) && primary >= 0, 'invalid_revision');
  if (!supplement) return String(primary);
  const secondary = Number(supplement.db.prepare('SELECT COALESCE(SUM(revision),0) AS revision FROM source').get().revision);
  safe(Number.isSafeInteger(secondary) && secondary >= 0, 'invalid_revision');
  return `${primary}:${secondary}`;
}

function sourceFacts(db) {
  return db.prepare('SELECT id,digest,fingerprint,revision,telemetry_revision,snapshot FROM source ORDER BY id').all()
    .map(row => {
      let parsed;
      try { parsed = JSON.parse(row.snapshot); } catch { throw new Error('invalid_source_snapshot'); }
      const digest = Buffer.from(row.digest);
      safe(Number.isSafeInteger(row.id) && row.id > 0
        && digest.length === 32
        && typeof row.fingerprint === 'string' && /^[0-9a-f]{64}$/u.test(row.fingerprint)
        && Number.isSafeInteger(row.revision) && row.revision >= 0
        && Number.isSafeInteger(row.telemetry_revision) && row.telemetry_revision >= 0
        && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'invalid_source_snapshot');
      return {
        id: row.id,
        digest: digest.toString('hex'),
        fingerprint: row.fingerprint,
        revision: row.revision,
        telemetryRevision: row.telemetry_revision,
        exhausted: parsed.exhausted === true,
      };
    });
}

function databaseIsClosed(database) {
  if (database === undefined || database === null) return true;
  try { return database.isOpen === false; } catch { return false; }
}

function setAttemptedBytes(error, attemptedBytes) {
  try {
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      Object.defineProperty(error, 'attemptedBytes', {
        configurable: true, enumerable: false, value: attemptedBytes, writable: true,
      });
    }
  } catch { /* Preserve arbitrary thrown values and frozen errors. */ }
}

export async function openTimingStore(directory, { createParser, digest, METHOD, MAX_STATE_BYTES, correlationKey,
  filesystem = createTimingFilesystem(),
  databaseFactory = (file, options) => new DatabaseSync(file, options) }) {
  const schemaMethod = schemaMethodFor(METHOD);
  safe(correlationKey === undefined || Buffer.isBuffer(correlationKey) && correlationKey.length === 32, 'invalid_metadata');
  const lease = await filesystem.prepare(directory);
  const { file, created } = lease;
  let db;
  let dbClosed = false;
  let leaseReleaseAttempted = false;
  let leaseReleaseError = null;

  // SQLite must be closed before its native file guards are released. If a
  // close failure leaves the database open, retain the lease and let a caller
  // retry close rather than allowing another owner to reach the file.
  function closeOwnedResources(primaryError = null) {
    let firstError = primaryError;
    if (!dbClosed && db !== undefined) {
      try {
        db.close();
        dbClosed = databaseIsClosed(db);
        if (!dbClosed && firstError === null) firstError = new Error('database_close_incomplete');
      } catch (error) {
        if (firstError === null) firstError = error;
        dbClosed = databaseIsClosed(db);
      }
    } else if (db === undefined) {
      dbClosed = true;
    }
    if (dbClosed && !leaseReleaseAttempted) {
      leaseReleaseAttempted = true;
      try {
        lease.release();
      } catch (error) {
        leaseReleaseError = error;
        if (firstError === null) firstError = error;
      }
    }
    if (firstError === null && leaseReleaseError !== null) firstError = leaseReleaseError;
    return firstError;
  }

  try {
    db = databaseFactory(file, { timeout: 100 });
    if (lease.persistentJournal) configureGuardedSqliteConnection(db);
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const application = db.prepare('PRAGMA application_id').get().application_id;
    safe(created || (application === APPLICATION
      && (version === METHOD || version === schemaMethod)), 'incompatible_database');
    db.exec('PRAGMA busy_timeout=100; PRAGMA cache_size=-2048; PRAGMA synchronous=FULL; PRAGMA max_page_count=65536;');
    if (created) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE metadata (key BLOB NOT NULL CHECK(length(key)=32));
        CREATE TABLE source (id INTEGER PRIMARY KEY, digest BLOB UNIQUE NOT NULL,
          fingerprint TEXT NOT NULL, cursor INTEGER NOT NULL, snapshot TEXT NOT NULL,
          state TEXT NOT NULL CHECK(length(state)<=${MAX_STATE_BYTES}),
          revision INTEGER NOT NULL DEFAULT 0,
          telemetry_revision INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE turn (key BLOB PRIMARY KEY, source INTEGER NOT NULL, offset INTEGER NOT NULL,
          at INTEGER NOT NULL, model TEXT, effort TEXT, tokens INTEGER, reasoning INTEGER,
          duration INTEGER, ttft INTEGER, responses INTEGER NOT NULL, covered INTEGER NOT NULL,
          quality TEXT NOT NULL, sample_tokens INTEGER, sample_reasoning INTEGER,
          sample_duration INTEGER, sample_responses INTEGER NOT NULL,
          sample_total_responses INTEGER NOT NULL, sample_method TEXT,
          turn_duration INTEGER, speed_mode TEXT, speed_mode_source TEXT,
          api_service_tier TEXT) WITHOUT ROWID;
        CREATE INDEX turn_time ON turn(at);
        PRAGMA application_id=${APPLICATION}; PRAGMA user_version=${schemaMethod};`);
      db.prepare('INSERT INTO metadata VALUES (?)').run(correlationKey ?? randomBytes(32));
      db.exec('COMMIT');
    }
    // Validate the local correlation envelope before changing an existing
    // schema. A sidecar opened with another store's key must not even perform
    // the forward migration.
    const key = Buffer.from(db.prepare('SELECT key FROM metadata').get().key);
    safe(key.length === 32, 'invalid_metadata');
    safe(correlationKey === undefined || key.equals(correlationKey), 'correlation_mismatch');
    if (!created) migrateTimingSchema(db, schemaMethod);
    return { db, key, file, createParser, digest, filesystem, method: METHOD, close: () => {
      const error = closeOwnedResources();
      if (error !== null) throw error;
    } };
  } catch (e) {
    closeOwnedResources(e);
    throw e;
  }
}

const snapshot = s => ({ dev: s.dev, ino: s.ino, birth: s.birthtimeMs,
  size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birth === b.birth;
async function fingerprint(handle, cursor, key, digest) {
  const first = Buffer.alloc(Math.min(cursor, 4096));
  const tail = Buffer.alloc(Math.min(cursor, 4096));
  if (first.length) {
    safe((await handle.read(first, 0, first.length, 0)).bytesRead === first.length, 'source_changed');
    safe((await handle.read(tail, 0, tail.length, cursor - tail.length)).bytesRead === tail.length, 'source_changed');
  }
  return digest(key, 'prefix-tail', Buffer.concat([first, tail]));
}

export async function ingestTimingFile(store, path, { maxBytes = CHUNK, signal, onReadLine } = {}) {
  safe(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= CHUNK, 'invalid_budget');
  const { db, key, createParser, digest } = store;
  const handle = await store.filesystem.openSource(path);
  let attemptedBytes = 0;
  let primaryError = null;
  try {
    const stat = await handle.stat();
    const before = snapshot(stat);
    const sourceKey = Buffer.from(digest(key, 'source-path', resolve(path)), 'hex');
    const old = db.prepare('SELECT * FROM source WHERE digest=?').get(sourceKey);
    const cursor = old?.cursor ?? 0;
    let previous = null;
    let replay = false;
    if (old) {
      previous = JSON.parse(old.snapshot);
      safe(sameFile(before, previous) && before.size >= previous.size, 'source_replaced');
      if (before.size === previous.size) {
        safe(before.mtime === previous.mtime && before.ctime === previous.ctime, 'source_rewritten');
        if (cursor === before.size || previous.exhausted === true) return { bytes: 0, unchanged: true };
      }
      // A source that was completely scanned can later gain a delayed record.
      // Rebuild its logical rows from the beginning in the same transaction so
      // stale measurements disappear even when the late record is not itself
      // a second completion. Stable HMAC keys preserve logical identities.
      replay = before.size > previous.size && previous.exhausted === true;
      safe(await fingerprint(handle, cursor, key, digest) === old.fingerprint, 'source_rewritten');
    }
    if (signal?.aborted) throw new Error('cancelled');
    const start = replay ? 0 : cursor;
    const end = Math.min(before.size, start + maxBytes);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!old) db.prepare('INSERT INTO source(digest,fingerprint,cursor,snapshot,state) VALUES (?,?,?,?,?)')
        .run(sourceKey, '', 0, JSON.stringify(before), '{}');
      const source = old?.id ?? Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
      if (replay) db.prepare('DELETE FROM turn WHERE source=?').run(source);
      const insert = db.prepare(`INSERT OR IGNORE INTO turn
        (key,source,offset,${PRIMARY_TURN_COLUMNS.join(',')})
        VALUES (${new Array(3 + PRIMARY_TURN_COLUMNS.length).fill('?').join(',')})`);
      const existing = db.prepare(`SELECT ${PRIMARY_TURN_COLUMNS.join(',')} FROM turn WHERE key=?`);
      const conflict = db.prepare("UPDATE turn SET model=NULL,effort=NULL,duration=NULL,ttft=NULL,sample_tokens=NULL,sample_reasoning=NULL,sample_duration=NULL,sample_responses=0,sample_method=NULL,turn_duration=NULL,speed_mode=NULL,speed_mode_source=NULL,api_service_tier=NULL,quality='conflicting_duplicate' WHERE key=?");
      const saved = replay ? null : old ? JSON.parse(old.state) : null;
      let discardLine = saved?.discardLine === true;
      const parser = createParser(key, saved, t => {
        const turnKey = Buffer.from(t.key, 'hex');
        const prior = existing.get(turnKey);
        const values = PRIMARY_TURN_COLUMNS.map(column => t[column] ?? null);
        if (prior) {
          if (PRIMARY_TURN_COLUMNS.some((column, index) => prior[column] !== values[index])) conflict.run(turnKey);
        } else insert.run(turnKey, source, t.offset, ...values);
      });
      attemptedBytes = end - start;
      const receipt = await forEachRolloutLine(handle, { start, end, signal,
        onLine: (line, offset, partial) => {
          if (discardLine) discardLine = false;
          else parser.line(line, offset, partial);
          onReadLine?.();
        } });
      if (receipt.aborted || signal?.aborted) throw new Error('cancelled');
      const after = snapshot(await handle.stat());
      const named = snapshot(await store.filesystem.namedStat(path, handle));
      safe(sameFile(before, after) && sameFile(before, named)
        && before.size === after.size && before.mtime === after.mtime
        && before.ctime === after.ctime, 'source_changed');
      let nextOffset = receipt.nextOffset;
      // Persist only the fact that an oversized line is being discarded. This
      // allows arbitrarily large content lines without retaining their bytes or
      // repeatedly reading the same prefix. Resume parsing after its newline.
      if (nextOffset === start && (discardLine || end - start > 64 * 1024)) {
        if (!discardLine) parser.line(Buffer.alloc(0), end, true);
        discardLine = true; nextOffset = end;
      }
      const state = parser.state(); state.discardLine = discardLine;
      after.exhausted = end === before.size;
      const previousRevision = old === undefined ? 0 : old.revision;
      const previousTelemetryRevision = old === undefined ? 0 : old.telemetry_revision;
      safe(Number.isSafeInteger(previousRevision) && previousRevision >= 0, 'invalid_revision');
      safe(Number.isSafeInteger(previousTelemetryRevision) && previousTelemetryRevision >= 0, 'invalid_telemetry_revision');
      const revision = previousRevision + (replay ? 1 : 0);
      const telemetryRevision = previousTelemetryRevision + 1;
      safe(Number.isSafeInteger(revision) && revision >= 0, 'invalid_revision');
      safe(Number.isSafeInteger(telemetryRevision) && telemetryRevision >= 1, 'invalid_telemetry_revision');
      db.prepare('UPDATE source SET fingerprint=?,cursor=?,snapshot=?,state=?,revision=?,telemetry_revision=? WHERE id=?')
        .run(await fingerprint(handle, nextOffset, key, digest), nextOffset,
          JSON.stringify(after), JSON.stringify(state), revision, telemetryRevision, source);
      if (state.blocked) db.prepare("UPDATE turn SET model=NULL,effort=NULL,duration=NULL,ttft=NULL,sample_tokens=NULL,sample_reasoning=NULL,sample_duration=NULL,sample_responses=0,sample_method=NULL,turn_duration=NULL,speed_mode=NULL,speed_mode_source=NULL,api_service_tier=NULL,quality='blocked_source' WHERE source=?").run(source);
      db.exec('COMMIT');
      return { bytes: end - start, unchanged: false, replayed: replay, invalidated: replay,
        revision, cursor: nextOffset, remaining: before.size - nextOffset, partial: receipt.partialDeferred };
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the operation failure. */ }
      throw e;
    }
  } catch (e) {
    primaryError = e;
    setAttemptedBytes(e, attemptedBytes);
    throw e;
  } finally {
    try {
      await handle.close();
    } catch (e) {
      if (primaryError === null) {
        setAttemptedBytes(e, attemptedBytes);
        throw e;
      }
      // A cleanup failure must not replace the parser, read, or transaction
      // error that the caller uses to account for attempted bytes.
    }
  }
}

export function readTimingRows(store, { supplement = null, withRevision = false, day } = {}) {
  // Bound daily sharing reads before materializing rows. The all-history
  // dashboard/export limit must not make a small day unavailable merely
  // because retained history outside that day exceeds the export ceiling.
  let window = null;
  if (day !== undefined) {
    safe(typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(day), 'invalid_day');
    const start = Date.parse(`${day}T00:00:00.000Z`);
    safe(Number.isSafeInteger(start) && start >= 0
      && new Date(start).toISOString().slice(0, 10) === day, 'invalid_day');
    window = [start, start + 86_400_000];
  }
  // Correlation handles remain local. Only joined numeric observations leave
  // this owner; a supplemental scan cannot add turns or replace old metrics.
  let extras = null;
  if (supplement) {
    safe(store.key.equals(supplement.key), 'correlation_mismatch');
    const candidates = supplement.db.prepare(`SELECT key,at,model,effort,tokens,reasoning,duration,ttft,
      responses,covered,quality,sample_tokens,sample_duration FROM turn
      WHERE sample_method='tool_free'${window ? ' AND at>=? AND at<?' : ''}
      LIMIT 100001`).all(...(window ?? []));
    safe(candidates.length <= 100000, 'export_limit');
    extras = new Map(candidates.map(row => [Buffer.from(row.key).toString('hex'), row]));
  }
  const rows = store.db.prepare(`SELECT key,at,model,effort,tokens,reasoning,duration,ttft,
    responses,covered,quality,sample_tokens,sample_reasoning,sample_duration,
    sample_responses,sample_total_responses,sample_method,turn_duration,speed_mode,
    speed_mode_source,api_service_tier FROM turn${window ? ' WHERE at>=? AND at<?' : ''}
    ORDER BY at LIMIT 100001`).all(...(window ?? []));
  safe(rows.length <= 100000, 'export_limit');
  const result = rows.map(({ key, turn_duration, speed_mode, speed_mode_source, api_service_tier, ...row }) => {
    // Legacy v1 rows predate the performance supplement. Keep their exact
    // reporting shape; newly parsed rows carry at least the explicit unknown
    // mode/service values and therefore expose the additive nullable fields.
    if (turn_duration !== null || speed_mode !== null || speed_mode_source !== null || api_service_tier !== null) {
      row.turn_duration = turn_duration;
      row.speed_mode = speed_mode;
      row.speed_mode_source = speed_mode_source;
      row.api_service_tier = api_service_tier;
    }
    const extra = extras?.get(Buffer.from(key).toString('hex'));
    if (extra && row.model !== null && ['at', 'model', 'effort', 'tokens', 'reasoning',
      'duration', 'ttft', 'responses', 'covered', 'quality'].every(field => row[field] === extra[field])) {
      row.tool_free_tokens = extra.sample_tokens;
      row.tool_free_duration = extra.sample_duration;
    }
    return row;
  });
  if (!withRevision) return result;
  const sources = sourceFacts(store.db).map(source => ({ ...source, role: 'primary' }));
  if (supplement) sources.push(...sourceFacts(supplement.db).map(source => ({ ...source, role: 'supplement' })));
  return { rows: result, revision: revisionToken(store.db, supplement), sources };
}

export function timingReport(store) {
  const rows = readTimingRows(store);
  const diagnostics = {};
  for (const row of store.db.prepare('SELECT state FROM source').iterate()) {
    for (const [k, v] of Object.entries(JSON.parse(row.state).diagnostics ?? {}))
      diagnostics[k] = (diagnostics[k] ?? 0) + v;
  }
  return { method: store.method, diagnostics, turns: rows };
}
