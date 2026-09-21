import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParser, digest, METHOD, MAX_STATE_BYTES } from '../src/providers/codex/logs.js';
import { ingestTimingFile, openTimingStore, readTimingRows } from '../src/platform/inference-timing-store.js';

const BASE = Date.parse('2026-09-01T12:00:00Z');
const rec = (ms, type, payload) => ({ timestamp: new Date(BASE + ms).toISOString(), type, payload });
const fixture = () => [
  rec(0, 'session_meta', { id: 'synthetic-session' }),
  rec(0, 'event_msg', { type: 'task_started', turn_id: 'synthetic-turn' }),
  rec(0, 'turn_context', { turn_id: 'synthetic-turn', model: 'gpt-5.6-sol', effort: 'high' }),
  rec(1000, 'event_msg', { type: 'item_completed', thread_id: 'synthetic-session', turn_id: 'synthetic-turn',
    item: { type: 'Reasoning' }, started_at_ms: BASE, completed_at_ms: BASE + 1000 }),
  rec(1000, 'token_usage_record', { thread_id: 'synthetic-session', turn_id: 'synthetic-turn', response_id: 'synthetic-response',
    usage: { output_tokens: 100, reasoning_output_tokens: 50 },
    turn_token_usage: { output_tokens: 100, reasoning_output_tokens: 50 } }),
  rec(1000, 'event_msg', { type: 'task_complete', turn_id: 'synthetic-turn', duration_ms: 1000, time_to_first_token_ms: 200 }),
];
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const options = { createParser, digest, METHOD, MAX_STATE_BYTES };

test('opens the prior method-2 schema, adds nullable v1.2 columns, and preserves old rows', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-v12-schema-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'timing'); await mkdir(directory, { mode: 0o700 });
  const file = join(directory, 'timing-experiment.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE metadata (key BLOB NOT NULL CHECK(length(key)=32));
    CREATE TABLE source (id INTEGER PRIMARY KEY, digest BLOB UNIQUE NOT NULL,
      fingerprint TEXT NOT NULL, cursor INTEGER NOT NULL, snapshot TEXT NOT NULL,
      state TEXT NOT NULL CHECK(length(state)<=${MAX_STATE_BYTES}));
    CREATE TABLE turn (key BLOB PRIMARY KEY, source INTEGER NOT NULL, offset INTEGER NOT NULL,
      at INTEGER NOT NULL, model TEXT, effort TEXT, tokens INTEGER, reasoning INTEGER,
      duration INTEGER, ttft INTEGER, responses INTEGER NOT NULL, covered INTEGER NOT NULL,
      quality TEXT NOT NULL, sample_tokens INTEGER, sample_reasoning INTEGER,
      sample_duration INTEGER, sample_responses INTEGER NOT NULL,
      sample_total_responses INTEGER NOT NULL, sample_method TEXT) WITHOUT ROWID;
    CREATE INDEX turn_time ON turn(at);
    INSERT INTO metadata VALUES (X'0707070707070707070707070707070707070707070707070707070707070707');
    INSERT INTO turn VALUES (X'0909090909090909090909090909090909090909090909090909090909090909', 1, 4,
      ${BASE}, 'gpt-5.6-sol', 'high', 100, 50, 1000, 200, 1, 1, 'complete',
      100, 50, 1000, 1, 1, 'receipt');
    PRAGMA application_id=0x54425450;
    PRAGMA user_version=${METHOD};
  `);
  db.close();
  await chmod(file, 0o600);
  const store = await openTimingStore(directory, options);
  try {
    const names = new Set(store.db.prepare('PRAGMA table_info(turn)').all().map(row => row.name));
    for (const name of ['turn_duration', 'speed_mode', 'speed_mode_source', 'api_service_tier']) assert.ok(names.has(name));
    const sourceColumns = new Set(store.db.prepare('PRAGMA table_info(source)').all().map(row => row.name));
    assert.ok(sourceColumns.has('revision'));
    assert.ok(sourceColumns.has('telemetry_revision'));
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.notEqual(store.db.prepare('PRAGMA user_version').get().user_version, METHOD,
      'the pre-v1.2 writer method cannot reopen the upgraded store');
    const rows = readTimingRows(store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].duration, 1000);
    assert.equal(Object.hasOwn(rows[0], 'turn_duration'), false, 'old rows keep the legacy reporting shape');
  } finally { store.close(); }
});

test('replays an exhausted source after append and advances a content-free revision fence', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-v12-replay-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'timing'), file = join(root, 'source.jsonl');
  await writeFile(file, lines(fixture()), { mode: 0o600 });
  const store = await openTimingStore(directory, options);
  try {
    const initial = await ingestTimingFile(store, file);
    assert.equal(initial.replayed, false);
    assert.equal(readTimingRows(store, { withRevision: true }).revision, '0');
    const before = readTimingRows(store);
    const beforeWithSources = readTimingRows(store, { withRevision: true });
    assert.equal(before.length, 1);
    assert.equal(beforeWithSources.sources[0].telemetryRevision, 1);
    assert.equal(before[0].turn_duration, 1000);
    await appendFile(file, JSON.stringify(rec(1100, 'event_msg', { type: 'task_started', turn_id: 'late-turn' })) + '\n');
    const replay = await ingestTimingFile(store, file);
    assert.equal(replay.replayed, true);
    assert.equal(replay.invalidated, true);
    assert.equal(replay.revision, 1);
    const after = readTimingRows(store, { withRevision: true });
    assert.equal(after.revision, '1');
    assert.equal(after.sources.length, 1);
    assert.equal(after.sources[0].revision, 1);
    assert.equal(after.sources[0].telemetryRevision, 2);
    assert.match(after.sources[0].digest, /^[0-9a-f]{64}$/u);
    assert.match(after.sources[0].fingerprint, /^[0-9a-f]{64}$/u);
    assert.equal(Object.hasOwn(after.sources[0], 'path'), false);
    assert.deepEqual(after.rows, before, 'stable logical turn remains after a conservative replay');
  } finally { store.close(); }
});

test('advances the telemetry counter on an ordinary append without changing cache revision', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-v12-append-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'timing'), file = join(root, 'source.jsonl');
  const initialRows = fixture().slice(0, 3);
  await writeFile(file, lines(initialRows), { mode: 0o600 });
  const store = await openTimingStore(directory, options);
  try {
    const partial = await ingestTimingFile(store, file, { maxBytes: 1 });
    assert.equal(partial.replayed, false);
    const before = readTimingRows(store, { withRevision: true });
    assert.equal(before.revision, '0');
    assert.equal(before.sources[0].telemetryRevision, 1);

    await appendFile(file, lines(fixture().slice(3)));
    const append = await ingestTimingFile(store, file);
    assert.equal(append.replayed, false, 'an incomplete source resumes from its cursor');
    assert.equal(append.revision, 0, 'the cache/replay revision remains unchanged');
    const after = readTimingRows(store, { withRevision: true });
    assert.equal(after.revision, '0');
    assert.equal(after.sources[0].telemetryRevision, 2);
    assert.equal(after.rows.length, 1);
  } finally { store.close(); }
});

test('daily reads bound primary and supplemental history before the retained export limit', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-v12-day-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'source.jsonl');
  await writeFile(file, lines(fixture()), { mode: 0o600 });
  const store = await openTimingStore(join(root, 'timing'), options);
  try {
    await ingestTimingFile(store, file);
    const initial = readTimingRows(store, { withRevision: true });
    const originalKey = store.db.prepare('SELECT key FROM turn').get().key;
    const columns = store.db.prepare('PRAGMA table_info(turn)').all().map(row => row.name);
    const dayStart = Date.parse('2026-09-01T00:00:00.000Z');
    // Synthetic retained history exceeds both primary and supplement ceilings.
    // A day selector must reach SQLite, not filter the already bounded export.
    const priorSelection = columns.map(column => column === 'key' ? "CAST(printf('%032x',n.x) AS BLOB)"
      : column === 'offset' ? 'n.x' : column === 'at' ? String(dayStart - 1)
      : column === 'sample_method' ? "'tool_free'" : `t.${column}`).join(',');
    store.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100001)
      INSERT INTO turn (${columns.join(',')}) SELECT ${priorSelection}
      FROM n CROSS JOIN turn t WHERE t.key=?`).run(originalKey);
    const edgeSelection = columns.map(column => ['key', 'at'].includes(column) ? '?' : `t.${column}`).join(',');
    const edge = store.db.prepare(`INSERT INTO turn (${columns.join(',')})
      SELECT ${edgeSelection} FROM turn t WHERE t.key=?`);
    edge.run(Buffer.alloc(32, 0xf1), dayStart, originalKey);
    edge.run(Buffer.alloc(32, 0xf2), dayStart + 86_400_000, originalKey);
    assert.throws(() => readTimingRows(store), /export_limit/u);
    assert.throws(() => readTimingRows(store, { supplement: store }), /export_limit/u);
    const daily = readTimingRows(store, { day: '2026-09-01', supplement: store, withRevision: true });
    assert.equal(daily.rows.length, 2);
    assert.deepEqual(daily.rows.map(row => row.at), [dayStart, initial.rows[0].at]);
    assert.deepEqual(daily.sources, initial.sources.map(source => ({ ...source, role: 'primary' }))
      .concat(initial.sources.map(source => ({ ...source, role: 'supplement' }))));
    assert.equal(readTimingRows(store, { day: '2026-09-02' }).length, 1,
      'the UTC upper endpoint belongs only to the next day');
    assert.equal(readTimingRows(store, { day: '2026-09-03' }).length, 0);
    for (const day of ['2026-02-30', '2026-9-01', '', null, true]) {
      assert.throws(() => readTimingRows(store, { day }), /invalid_day/u);
    }
  } finally { store.close(); }
});
