import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, realpath } from 'node:fs/promises';
import { mkdirSync, writeFileSync, openSync, readSync, fstatSync, closeSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createTimingFilesystem } from '../src/platform/inference-timing-filesystem.js';
import { openTimingStore, ingestTimingFile, readTimingRows } from '../src/platform/inference-timing-store.js';
import { createParser, digest, METHOD, MAX_STATE_BYTES } from '../src/providers/codex/logs.js';

// Exercises Windows orchestration on real SQLite, not Windows ACL guarantees.
function nativeFixture() {
  const guards = new Set(), sources = new Map(), reads = [];
  const identity = { volumeSerialNumber: '0000000000000001', fileId: '00000000000000000000000000000002', linkCount: 1 };
  const native = {
    credentialAuditFileGuardContractVersion: 'windows-credential-audit-file-guard-v1',
    credentialAuditFileGuardSafe: true,
    ensureDirectory: path => mkdirSync(path, { recursive: true, mode: 0o700 }),
    createFile: (path, data) => writeFileSync(path, data, { flag: 'wx', mode: 0o600 }),
    inspectPath: path => lstatSync(path),
    acquireCredentialAuditFileGuard(path) { const guard = { path }; guards.add(guard); return { guard, identity }; },
    releaseCredentialAuditFileGuard(guard) {
      if (sources.has(guard)) { closeSync(sources.get(guard)); sources.delete(guard); }
      else assert.ok(guards.delete(guard), 'only live guards are released');
    },
    closeSourceFile(lease) { closeSync(sources.get(lease)); sources.delete(lease); },
    openSourceFile(path) { const lease = {}; sources.set(lease, openSync(path, 'r')); return lease; },
    statSourceFile(lease) { return fstatSync(sources.get(lease)); },
    readSourceFile(lease, position, length) {
      assert.ok(length <= 65536); reads.push(length);
      const data = Buffer.alloc(length);
      return data.subarray(0, readSync(sources.get(lease), data, 0, length, position));
    },
  };
  return { native, guards, sources, reads };
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'windows-timing-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = nativeFixture();
  const filesystem = createTimingFilesystem({ platform: 'win32', loadWindowsBinding: () => state.native });
  return { root, ...state, filesystem,
    options: { createParser, digest, METHOD, MAX_STATE_BYTES, filesystem } };
}

function wrappedDatabaseFactory({ close }) {
  return (file, options) => {
    const database = new DatabaseSync(file, options);
    return {
      get isOpen() { return database.isOpen; },
      exec: database.exec.bind(database),
      prepare: database.prepare.bind(database),
      close: () => close(database),
    };
  };
}
function lines() {
  const at = 1789200000000;
  const rec = (ms, type, payload) => JSON.stringify({ timestamp: new Date(at + ms).toISOString(), type, payload });
  return [
    rec(0, 'session_meta', { id: 'synthetic-session' }),
    rec(0, 'event_msg', { type: 'task_started', turn_id: 'synthetic-turn' }),
    rec(0, 'turn_context', { turn_id: 'synthetic-turn', model: 'gpt-5.6-sol' }),
    rec(1000, 'event_msg', { type: 'item_completed', thread_id: 'synthetic-session', turn_id: 'synthetic-turn',
      item: { type: 'Reasoning' }, started_at_ms: at, completed_at_ms: at + 1000 }),
    rec(1000, 'token_usage_record', { thread_id: 'synthetic-session', turn_id: 'synthetic-turn', response_id: 'synthetic-response',
      usage: { output_tokens: 100, reasoning_output_tokens: 50 }, turn_token_usage: { output_tokens: 100, reasoning_output_tokens: 50 } }),
    rec(1000, 'event_msg', { type: 'task_complete', turn_id: 'synthetic-turn', duration_ms: 1000, time_to_first_token_ms: 200 }),
    ' '.repeat(300000), '',
  ].join('\n');
}
test('Windows storage uses guarded persistent journal; bounded ingestion survives restart without duplication', async t => {
  const f = await fixture(t), path = join(f.root, 'synthetic.jsonl'), directory = join(f.root, 'timing');
  await writeFile(path, lines());
  let store = await openTimingStore(directory, f.options);
  try {
    assert.equal(f.guards.size, 2);
    assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'persist');
    await ingestTimingFile(store, path);
    const rows = readTimingRows(store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sample_tokens, 100);
    assert.equal(rows[0].ttft, 200);
    assert.ok(f.reads.length > 4);
    assert.equal(f.sources.size, 0);
    store.close(); assert.equal(f.guards.size, 0);
    store = await openTimingStore(directory, f.options);
    assert.equal((await ingestTimingFile(store, path)).unchanged, true);
    assert.deepEqual(readTimingRows(store), rows);
  } finally { store.close(); }
  assert.equal(f.guards.size, 0);
});
test('partial database-guard acquisition fails closed and releases acquired handles', async t => {
  const f = await fixture(t), original = f.native.acquireCredentialAuditFileGuard;
  f.native.acquireCredentialAuditFileGuard = path => {
    if (path.endsWith('-journal')) throw new Error('synthetic guard refusal');
    return original(path);
  };
  await assert.rejects(openTimingStore(join(f.root, 'timing'), f.options), /Windows protected SQLite operation failed/);
  assert.equal(f.guards.size, 0);
});
test('incompatible database and WAL state are preserved and guards released', async t => {
  const f = await fixture(t), dir = join(f.root, 'timing');
  const store = await openTimingStore(dir, f.options), path = store.file;
  store.db.exec('PRAGMA user_version=999'); store.close();
  const before = await readFile(path);
  await assert.rejects(openTimingStore(dir, f.options), /incompatible_database/);
  assert.deepEqual(await readFile(path), before);
  assert.equal(f.guards.size, 0);
  await writeFile(`${path}-wal`, 'synthetic');
  await assert.rejects(openTimingStore(dir, f.options), /unsafe_journal_mode/);
  assert.equal(f.guards.size, 0);
});
test('source read failure rolls back checkpoints and closes its native handle', async t => {
  const f = await fixture(t), path = join(f.root, 'synthetic.jsonl');
  await writeFile(path, lines());
  const store = await openTimingStore(join(f.root, 'timing'), f.options);
  f.native.readSourceFile = () => { throw new Error('synthetic read failure'); };
  try {
    await assert.rejects(ingestTimingFile(store, path), /read failure/);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM source').get().n, 0);
    assert.equal(f.sources.size, 0);
  } finally { store.close(); }
});
test('source reads reject invalid buffer ranges before calling native code', async t => {
  const f = await fixture(t), path = join(f.root, 'synthetic.jsonl');
  await writeFile(path, 'synthetic\n');
  const handle = await f.filesystem.openSource(path);
  try {
    await assert.rejects(handle.read(Buffer.alloc(8), 0, 9, 0), /invalid_source_read/);
    assert.equal(f.reads.length, 0);
  } finally { await handle.close(); }
  await assert.rejects(handle.stat(), /source_file_closed/);
});

test('database close failure keeps the native lease until a retry can close SQLite', async t => {
  const f = await fixture(t), directory = join(f.root, 'timing');
  let failClose = true;
  const databaseFactory = wrappedDatabaseFactory({
    close(database) {
      if (failClose) throw new Error('synthetic database close failure');
      return database.close();
    },
  });
  const store = await openTimingStore(directory, { ...f.options, databaseFactory });
  try {
    assert.throws(() => store.close(), /database close failure/);
    assert.equal(f.guards.size, 2, 'an open database retains both native guards');
    failClose = false;
    store.close();
    assert.equal(f.guards.size, 0);
    store.close();
  } finally {
    failClose = false;
    try { store.close(); } catch { /* Preserve the test failure. */ }
  }
});

test('database close failure after SQLite closes still releases the native lease', async t => {
  const f = await fixture(t), directory = join(f.root, 'timing');
  const databaseFactory = wrappedDatabaseFactory({
    close(database) {
      database.close();
      throw new Error('synthetic post-close failure');
    },
  });
  const store = await openTimingStore(directory, { ...f.options, databaseFactory });
  assert.throws(() => store.close(), /post-close failure/);
  assert.equal(f.guards.size, 0, 'a closed database no longer needs native guards');
  store.close();
});

test('store initialization preserves the schema failure when lease cleanup fails', async t => {
  const f = await fixture(t), directory = join(f.root, 'timing');
  let store = await openTimingStore(directory, f.options);
  store.db.exec('PRAGMA user_version=999');
  store.close(); store = null;
  const originalRelease = f.native.releaseCredentialAuditFileGuard;
  f.native.releaseCredentialAuditFileGuard = guard => {
    originalRelease(guard);
    throw new Error('synthetic lease release failure');
  };
  await assert.rejects(
    openTimingStore(directory, f.options),
    /incompatible_database/,
  );
  assert.equal(f.guards.size, 0);
});

test('ingestion preserves its primary failure when source-handle cleanup fails', async t => {
  const f = await fixture(t), path = join(f.root, 'synthetic.jsonl');
  await writeFile(path, lines());
  const store = await openTimingStore(join(f.root, 'timing'), f.options);
  const originalRead = f.native.readSourceFile;
  const originalClose = f.native.closeSourceFile;
  f.native.readSourceFile = () => { throw new Error('synthetic read failure'); };
  f.native.closeSourceFile = lease => {
    originalClose(lease);
    throw new Error('synthetic handle close failure');
  };
  try {
    await assert.rejects(ingestTimingFile(store, path), error => {
      assert.match(error.message, /read failure/);
      assert.ok(error.attemptedBytes > 0);
      return true;
    });
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM source').get().n, 0);
    assert.equal(f.sources.size, 0);
  } finally {
    f.native.readSourceFile = originalRead;
    f.native.closeSourceFile = originalClose;
    store.close();
  }
});

test('read and batch limits retain measurements after an 8 MiB record across resumptions', async t => {
  const f = await fixture(t), path = join(f.root, 'synthetic-large.jsonl');
  const later = lines().split('\n').slice(1).join('\n')
    .replaceAll('synthetic-turn', 'synthetic-later-turn')
    .replaceAll('synthetic-response', 'synthetic-later-response');
  const content = lines() + JSON.stringify({ type: 'synthetic_ignored', padding: 'x'.repeat(8 * 1024 * 1024) }) + '\n' + later;
  await writeFile(path, content);
  const store = await openTimingStore(join(f.root, 'timing'), f.options);
  try {
    let result, passes = 0;
    do {
      result = await ingestTimingFile(store, path, { maxBytes: 4 * 1024 * 1024 });
      assert.ok(++passes < 10, 'bounded batches make forward progress');
    } while (result.remaining > 0);
    assert.ok(passes >= 3, 'the source crosses several ingestion batches');
    assert.equal(result.cursor, Buffer.byteLength(content), 'cursor reaches the entire file');
    const rows = readTimingRows(store);
    assert.equal(rows.length, 2, 'turns before and after the large record survive');
    assert.ok(rows.every(row => row.sample_tokens === 100 && row.ttft === 200));
    assert.ok(f.reads.every(bytes => bytes <= 65536), 'native reads stay bounded');
    assert.equal(f.sources.size, 0);
  } finally { store.close(); }
});
