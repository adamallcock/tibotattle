import { constants } from 'node:fs';
import { lstat, open, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { forEachRolloutLine } from '../../../src/rollout-line-reader.js';
import { createParser, digest, METHOD, MAX_STATE_BYTES } from './parser.mjs';

const APPLICATION = 0x54425450;
const CHUNK = 16 * 1024 * 1024;
const safe = (ok, code) => { if (!ok) throw new Error(code); };
function ownerFile(s) {
  return s.isFile() && s.nlink === 1 && s.uid === process.getuid() && !(s.mode & 0o077);
}
export async function openStore(directory) {
  const dir = resolve(directory);
  // Parent must exist and every resolved component must be the requested path.
  const parent = resolve(dir, '..');
  safe(await realpath(parent) === parent, 'unsafe_directory');
  await mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
  const d = await lstat(dir);
  safe(d.isDirectory() && !d.isSymbolicLink() && d.uid === process.getuid() && !(d.mode & 0o077), 'unsafe_directory');
  const file = join(dir, 'timing-experiment.sqlite');
  let created = false;
  try {
    const h = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await h.close(); created = true;
  } catch (e) { if (e.code !== 'EEXIST') throw e; }
  safe(ownerFile(await lstat(file)), 'unsafe_database');
  const db = new DatabaseSync(file);
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const application = db.prepare('PRAGMA application_id').get().application_id;
    safe(created || (version === METHOD && application === APPLICATION), 'incompatible_database');
    db.exec('PRAGMA busy_timeout=100; PRAGMA cache_size=-2048; PRAGMA synchronous=FULL; PRAGMA max_page_count=65536;');
    if (created) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE metadata (key BLOB NOT NULL CHECK(length(key)=32));
        CREATE TABLE source (id INTEGER PRIMARY KEY, digest BLOB UNIQUE NOT NULL,
          fingerprint TEXT NOT NULL, cursor INTEGER NOT NULL, snapshot TEXT NOT NULL,
          state TEXT NOT NULL CHECK(length(state)<=${MAX_STATE_BYTES}));
        CREATE TABLE turn (key BLOB PRIMARY KEY, source INTEGER NOT NULL, offset INTEGER NOT NULL,
          at INTEGER NOT NULL, model TEXT, effort TEXT, tokens INTEGER, reasoning INTEGER,
          duration INTEGER, ttft INTEGER, responses INTEGER NOT NULL, covered INTEGER NOT NULL,
          quality TEXT NOT NULL) WITHOUT ROWID;
        CREATE INDEX turn_time ON turn(at);
        PRAGMA application_id=${APPLICATION}; PRAGMA user_version=${METHOD};`);
      db.prepare('INSERT INTO metadata VALUES (?)').run(randomBytes(32));
      db.exec('COMMIT');
    }
    const key = Buffer.from(db.prepare('SELECT key FROM metadata').get().key);
    safe(key.length === 32, 'invalid_metadata');
    return { db, key, file, close: () => db.close() };
  } catch (e) { db.close(); throw e; }
}

const snapshot = s => ({ dev: s.dev, ino: s.ino, birth: s.birthtimeMs,
  size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birth === b.birth;
async function fingerprint(handle, cursor, key) {
  const first = Buffer.alloc(Math.min(cursor, 4096));
  const tail = Buffer.alloc(Math.min(cursor, 4096));
  if (first.length) {
    safe((await handle.read(first, 0, first.length, 0)).bytesRead === first.length, 'source_changed');
    safe((await handle.read(tail, 0, tail.length, cursor - tail.length)).bytesRead === tail.length, 'source_changed');
  }
  return digest(key, 'prefix-tail', Buffer.concat([first, tail]));
}

export async function ingestFile(store, path, { maxBytes = CHUNK, signal, onReadLine } = {}) {
  safe(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= CHUNK, 'invalid_budget');
  const { db, key } = store;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let attemptedBytes = 0;
  try {
    const stat = await handle.stat();
    safe(stat.isFile() && stat.uid === process.getuid(), 'unsafe_source');
    const before = snapshot(stat);
    const sourceKey = Buffer.from(digest(key, 'source-path', resolve(path)), 'hex');
    const old = db.prepare('SELECT * FROM source WHERE digest=?').get(sourceKey);
    const cursor = old?.cursor ?? 0;
    if (old) {
      const previous = JSON.parse(old.snapshot);
      safe(sameFile(before, previous) && before.size >= previous.size, 'source_replaced');
      if (before.size === previous.size) {
        safe(before.mtime === previous.mtime && before.ctime === previous.ctime, 'source_rewritten');
        if (cursor === before.size || previous.exhausted === true) return { bytes: 0, unchanged: true };
      }
      safe(await fingerprint(handle, cursor, key) === old.fingerprint, 'source_rewritten');
    }
    if (signal?.aborted) throw new Error('cancelled');
    const end = Math.min(before.size, cursor + maxBytes);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!old) db.prepare('INSERT INTO source(digest,fingerprint,cursor,snapshot,state) VALUES (?,?,?,?,?)')
        .run(sourceKey, '', 0, JSON.stringify(before), '{}');
      const source = old?.id ?? Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
      const insert = db.prepare('INSERT OR IGNORE INTO turn VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const existing = db.prepare('SELECT at,model,effort,tokens,reasoning,duration,ttft,responses,covered,quality FROM turn WHERE key=?');
      const conflict = db.prepare("UPDATE turn SET model=NULL,effort=NULL,duration=NULL,ttft=NULL,quality='conflicting_duplicate' WHERE key=?");
      const saved = old ? JSON.parse(old.state) : null;
      let discardLine = saved?.discardLine === true;
      const parser = createParser(key, saved, t => {
        const turnKey = Buffer.from(t.key, 'hex');
        const prior = existing.get(turnKey);
        if (prior) {
          if (Object.keys(prior).some(k => prior[k] !== t[k])) conflict.run(turnKey);
        } else insert.run(turnKey, source, t.offset, t.at, t.model, t.effort, t.tokens,
          t.reasoning, t.duration, t.ttft, t.responses, t.covered, t.quality);
      });
      attemptedBytes = end - cursor;
      const receipt = await forEachRolloutLine(handle, { start: cursor, end, signal,
        onLine: (line, offset, partial) => {
          if (discardLine) discardLine = false;
          else parser.line(line, offset, partial);
          onReadLine?.();
        } });
      if (receipt.aborted || signal?.aborted) throw new Error('cancelled');
      const after = snapshot(await handle.stat());
      const named = snapshot(await lstat(path));
      safe(sameFile(before, after) && sameFile(before, named)
        && before.size === after.size && before.mtime === after.mtime
        && before.ctime === after.ctime, 'source_changed');
      let nextOffset = receipt.nextOffset;
      // Persist only the fact that an oversized line is being discarded. This
      // allows arbitrarily large content lines without retaining their bytes or
      // repeatedly reading the same prefix. Resume parsing after its newline.
      if (nextOffset === cursor && (discardLine || end - cursor > 64 * 1024)) {
        if (!discardLine) parser.line(Buffer.alloc(0), end, true);
        discardLine = true; nextOffset = end;
      }
      const state = parser.state(); state.discardLine = discardLine;
      after.exhausted = end === before.size;
      db.prepare('UPDATE source SET fingerprint=?,cursor=?,snapshot=?,state=? WHERE id=?')
        .run(await fingerprint(handle, nextOffset, key), nextOffset,
          JSON.stringify(after), JSON.stringify(state), source);
      if (state.blocked) db.prepare("UPDATE turn SET model=NULL,effort=NULL,duration=NULL,ttft=NULL,quality='blocked_source' WHERE source=?").run(source);
      db.exec('COMMIT');
      return { bytes: end - cursor, unchanged: false, cursor: nextOffset,
        remaining: before.size - nextOffset, partial: receipt.partialDeferred };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } catch (e) { e.attemptedBytes = attemptedBytes; throw e; }
  finally { await handle.close(); }
}

export function report(store) {
  const rows = store.db.prepare(`SELECT at,model,effort,tokens,reasoning,duration,ttft,
    responses,covered,quality FROM turn ORDER BY at LIMIT 100001`).all();
  safe(rows.length <= 100000, 'export_limit');
  const diagnostics = {};
  for (const row of store.db.prepare('SELECT state FROM source').iterate()) {
    for (const [k, v] of Object.entries(JSON.parse(row.state).diagnostics ?? {}))
      diagnostics[k] = (diagnostics[k] ?? 0) + v;
  }
  return { method: METHOD, diagnostics, turns: rows };
}
