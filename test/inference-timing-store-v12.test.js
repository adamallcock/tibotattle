import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParser, createToolFreeParser, digest, METHOD, TOOL_FREE_METHOD, MAX_STATE_BYTES, INFERENCE_TIMING_PARSER_VERSION } from '../src/providers/codex/logs.js';
import { ingestTimingFile, openTimingStore, readTimingRows } from '../src/platform/inference-timing-store.js';
import { ROLLOUT_LINE_BYTES } from '../src/platform/index.js';
import { modelPerformanceProjection } from '../src/reporting/index.js';
import { projectTelemetryPerformanceDay } from '../src/contribution/index.js';

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
    assert.ok(sourceColumns.has('parser_version'));
    assert.ok(sourceColumns.has('replay_parser_version'));
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 6);
    assert.notEqual(store.db.prepare('PRAGMA user_version').get().user_version, METHOD,
      'the pre-v1.2 writer method cannot reopen the upgraded store');
    const rows = readTimingRows(store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].duration, 1000);
    assert.equal(Object.hasOwn(rows[0], 'turn_duration'), false, 'old rows keep the legacy reporting shape');
  } finally { store.close(); }
});

test('parser upgrades replay unchanged verified sources once without changing stable turn identities', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-parser-replay-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'source.jsonl');
  const rows = fixture();
  Object.assign(rows.find(row => row.type === 'turn_context').payload, { model: 'gpt-6.1-sol', service_tier: 'ultrafast' });
  await writeFile(file, lines(rows), { mode: 0o600 });
  for (const [name, parser, method, oldSchema, newSchema] of [
    ['primary', createParser, METHOD, 4, 6],
    ['supplement', createToolFreeParser, TOOL_FREE_METHOD, 5, 7],
  ]) {
    const directory = join(root, name);
    const config = { ...options, createParser: parser, METHOD: method };
    const old = await openTimingStore(directory, config);
    await ingestTimingFile(old, file);
    old.db.prepare("UPDATE turn SET speed_mode='other',model=NULL").run();
    const oldKey = Buffer.from(old.db.prepare('SELECT key FROM turn').get().key);
    const oldRows = readTimingRows(old);
    old.db.exec(`DROP TABLE parser_replay_turn; ALTER TABLE source DROP COLUMN parser_version;
      ALTER TABLE source DROP COLUMN replay_parser_version; PRAGMA user_version=${oldSchema}`);
    old.close();
    const current = await openTimingStore(directory, { ...config, parserVersion: INFERENCE_TIMING_PARSER_VERSION });
    try {
      assert.equal(current.db.prepare('PRAGMA user_version').get().user_version, newSchema);
      assert.deepEqual(readTimingRows(current), oldRows, 'opening only adds provenance; it does not relabel old evidence');
      assert.equal(readTimingRows(current, { withRevision: true }).sources[0].parserVersion, 0);
      const before = current.db.prepare('SELECT * FROM source').get();
      const cancel = new AbortController();
      await assert.rejects(ingestTimingFile(current, file, { signal: cancel.signal, onReadLine: () => cancel.abort() }), /cancelled/u);
      assert.deepEqual(current.db.prepare('SELECT * FROM source').get(), before);
      assert.deepEqual(readTimingRows(current), oldRows, 'cancelled replay preserves earlier measurements');
      const replay = await ingestTimingFile(current, file);
      assert.equal(replay.replayed, true);
      assert.equal(replay.invalidated, true);
      assert.equal(replay.revision, 1);
      assert.deepEqual(Buffer.from(current.db.prepare('SELECT key FROM turn').get().key), oldKey);
      const after = readTimingRows(current, { withRevision: true });
      assert.equal(after.rows.length, 1);
      assert.equal(after.rows[0].model, 'gpt-6.1-sol');
      assert.equal(after.rows[0].speed_mode, 'ultrafast');
      assert.equal(after.rows[0].api_service_tier, 'unknown');
      assert.equal(after.sources[0].parserVersion, INFERENCE_TIMING_PARSER_VERSION);
      assert.equal(after.sources[0].telemetryRevision, 2);
      assert.deepEqual(await ingestTimingFile(current, file), { bytes: 0, unchanged: true });
      await assert.rejects(openTimingStore(directory, { ...config, parserVersion: INFERENCE_TIMING_PARSER_VERSION - 1 }), /incompatible_parser_version/u);
    } finally { current.close(); }
  }
});

test('parser upgrade reclassifies initial settings without changing retained timing or identities', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-mode-replay-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'source.jsonl'), directory = join(root, 'timing');
  const rows = fixture();
  rows[2].timestamp = new Date(BASE + 100).toISOString();
  rows[3].payload.started_at_ms = BASE + 200;
  rows.splice(2, 0, rec(100, 'event_msg', { type: 'thread_settings_applied',
    thread_id: 'synthetic-session', thread_settings: { service_tier: 'priority' } }));
  await writeFile(file, lines(rows), { mode: 0o600 });
  const priorParser = (key, saved, emit) => createParser(key, saved, row => emit({
    ...row, speed_mode: 'mixed', speed_mode_source: 'mixed',
  }));
  const prior = await openTimingStore(directory, { ...options, createParser: priorParser,
    parserVersion: INFERENCE_TIMING_PARSER_VERSION - 1 });
  await ingestTimingFile(prior, file);
  const before = prior.db.prepare('SELECT * FROM turn').get();
  prior.close();
  const current = await openTimingStore(directory, { ...options, parserVersion: INFERENCE_TIMING_PARSER_VERSION });
  try {
    assert.equal(current.db.prepare('SELECT speed_mode FROM turn').get().speed_mode, 'mixed');
    assert.equal((await ingestTimingFile(current, file)).replayed, true);
    const after = current.db.prepare('SELECT * FROM turn').get();
    assert.equal(after.speed_mode, 'fast');
    assert.equal(after.speed_mode_source, 'rollout_thread_settings');
    assert.deepEqual({ ...after, speed_mode: before.speed_mode, speed_mode_source: before.speed_mode_source }, { ...before });
    assert.deepEqual(await ingestTimingFile(current, file), { bytes: 0, unchanged: true });
  } finally { current.close(); }
});

async function assertTimingModelUpgradeReplay(t, { model, previousVersion }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-model-replay-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const presentFile = join(root, 'present.jsonl'), absentFile = join(root, 'absent.jsonl');
  const directory = join(root, 'timing');
  const present = fixture();
  present.find(row => row.type === 'turn_context').payload.model = model;
  const absent = JSON.parse(JSON.stringify(present)
    .replaceAll('synthetic-session', 'synthetic-absent-session')
    .replaceAll('synthetic-turn', 'synthetic-absent-turn')
    .replaceAll('synthetic-response', 'synthetic-absent-response'));
  for (const row of absent) {
    row.timestamp = new Date(Date.parse(row.timestamp) + 10000).toISOString();
    for (const key of ['started_at_ms', 'completed_at_ms']) if (Object.hasOwn(row.payload, key)) row.payload[key] += 10000;
  }
  await writeFile(presentFile, lines(present), { mode: 0o600 });
  await writeFile(absentFile, lines(absent), { mode: 0o600 });
  const old = await openTimingStore(directory, { ...options, parserVersion: previousVersion });
  await ingestTimingFile(old, presentFile);
  await ingestTimingFile(old, absentFile);
  // Seed the previous parser's unrecognized model and unavailable full-turn
  // duration without retaining an obsolete copy of that parser.
  old.db.exec('UPDATE turn SET model=NULL,turn_duration=NULL');
  const before = readTimingRows(old, { withRevision: true });
  const beforeRaw = old.db.prepare('SELECT * FROM turn ORDER BY at').all();
  assert.equal(beforeRaw.length, 2);
  assert.ok(before.sources.every(source => source.parserVersion === previousVersion));
  old.close();
  await rm(absentFile);
  assert.equal(INFERENCE_TIMING_PARSER_VERSION, 22);
  let current = await openTimingStore(directory, { ...options, parserVersion: INFERENCE_TIMING_PARSER_VERSION });
  try {
    assert.deepEqual(readTimingRows(current, { withRevision: true }), before, 'opening does not relabel retained facts');
    const cancel = new AbortController();
    await assert.rejects(ingestTimingFile(current, presentFile, {
      signal: cancel.signal, onReadLine: () => cancel.abort(),
    }), /cancelled/u);
    assert.deepEqual(readTimingRows(current, { withRevision: true }), before);
    current.close();
    current = await openTimingStore(directory, { ...options, parserVersion: INFERENCE_TIMING_PARSER_VERSION });
    assert.equal((await ingestTimingFile(current, presentFile)).replayed, true);
    const afterRaw = current.db.prepare('SELECT * FROM turn ORDER BY at').all();
    assert.deepEqual({ ...afterRaw[0] }, { ...beforeRaw[0], model, turn_duration: 1000 });
    assert.deepEqual(afterRaw[1], beforeRaw[1], 'missing source keeps its original unknown identity and timing');
    assert.equal(afterRaw[0].speed_mode, 'unknown');
    assert.equal(afterRaw[0].speed_mode_source, 'unobserved');
    const sourceVersions = current.db.prepare('SELECT parser_version FROM source ORDER BY id').all();
    assert.deepEqual(sourceVersions.map(source => source.parser_version), [INFERENCE_TIMING_PARSER_VERSION, previousVersion]);
    const after = readTimingRows(current, { withRevision: true });
    await assert.rejects(ingestTimingFile(current, absentFile));
    assert.deepEqual(await ingestTimingFile(current, presentFile), { bytes: 0, unchanged: true });
    assert.deepEqual(readTimingRows(current, { withRevision: true }), after);
  } finally { current.close(); }
}

for (const fixture of [
  { model: 'gpt-6.1-terra', previousVersion: 20 },
  { model: 'gpt-6.2-astra', previousVersion: 21 },
  { model: 'gpt-6.2-sol', previousVersion: 21 },
  { model: 'gpt-6.2-astra-law', previousVersion: 21 },
]) {
  test(`timing replays present ${fixture.model} without changing absent v${fixture.previousVersion} facts`,
    t => assertTimingModelUpgradeReplay(t, fixture));
}

test('v19 replay repairs oversized-output Fast attribution atomically across cancellation and restart', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-speed-repair-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'source.jsonl'), directory = join(root, 'timing');
  const first = fixture();
  first[2].timestamp = new Date(BASE + 500).toISOString();
  first[3].payload.started_at_ms = BASE + 800;
  first.at(-1).timestamp = new Date(BASE + 2000).toISOString();
  Object.assign(first.at(-1).payload, { duration_ms: 2000, time_to_first_token_ms: 800 });
  const oversized = rec(200, 'response_item', {
    type: 'message', role: 'assistant',
    internal_chat_message_metadata_passthrough: { turn_id: 'synthetic-turn' },
    content: [{ type: 'output_text', text: 'x'.repeat(ROLLOUT_LINE_BYTES + 1) }],
  });
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > ROLLOUT_LINE_BYTES);
  first.splice(2, 0, oversized, rec(500, 'event_msg', {
    type: 'thread_settings_applied', thread_id: 'synthetic-session',
    thread_settings: { service_tier: 'priority' },
  }));
  const second = JSON.parse(JSON.stringify(fixture().slice(1))
    .replaceAll('synthetic-turn', 'synthetic-next-turn')
    .replaceAll('synthetic-response', 'synthetic-next-response'));
  for (const row of second) {
    row.timestamp = new Date(Date.parse(row.timestamp) + 4000).toISOString();
    for (const key of ['started_at_ms', 'completed_at_ms']) if (Object.hasOwn(row.payload, key)) row.payload[key] += 4000;
  }
  await writeFile(file, lines([...first, ...second]), { mode: 0o600 });
  const priorVersion = 19;
  const prior = await openTimingStore(directory, { ...options, parserVersion: priorVersion });
  await ingestTimingFile(prior, file);
  // Seed the persisted v19 defect without retaining a duplicate obsolete parser.
  prior.db.prepare("UPDATE turn SET speed_mode='fast',speed_mode_source='rollout_thread_settings' WHERE at=?")
    .run(BASE + 2000);
  const before = readTimingRows(prior, { withRevision: true });
  const beforeRaw = prior.db.prepare('SELECT * FROM turn ORDER BY at').all();
  assert.equal(before.rows.length, 2);
  assert.equal(before.rows[0].quality, 'complete');
  assert.equal(before.rows[0].sample_duration, 200);
  assert.equal(JSON.parse(prior.db.prepare('SELECT state FROM source').get().state).diagnostics.oversized, 1);
  const localFastTurns = rows => modelPerformanceProjection(rows, {
    period: 'all', speedMode: 'fast', now: BASE + 6000,
  }).models.reduce((sum, model) => sum + model.turns, 0);
  const project = rows => projectTelemetryPerformanceDay(rows, {
    day: '2026-09-01', provider: 'openai_codex', now: BASE + 6000,
  });
  assert.equal(localFastTurns(before.rows), 2);
  assert.equal(project(before.rows).filter(report => report.speedMode === 'fast')
    .reduce((sum, report) => sum + report.speedTurns, 0), 2);
  prior.close();

  assert.ok(INFERENCE_TIMING_PARSER_VERSION > priorVersion, 'repair requires a parser-version replay');
  const currentOptions = { ...options, parserVersion: INFERENCE_TIMING_PARSER_VERSION };
  let current = await openTimingStore(directory, currentOptions);
  try {
    assert.deepEqual(readTimingRows(current, { withRevision: true }), before);
    const firstBytes = Buffer.byteLength(lines(first));
    const partial = await ingestTimingFile(current, file, { maxBytes: firstBytes });
    assert.equal(partial.replayed, true);
    assert.equal(partial.invalidated, false);
    assert.equal(partial.bytes, firstBytes);
    assert.equal(partial.cursor, firstBytes);
    assert.deepEqual(readTimingRows(current), before.rows, 'incomplete replay retains the prior live population');
    const staged = current.db.prepare('SELECT * FROM parser_replay_turn').all();
    assert.equal(staged.length, 1);
    assert.ok(['unknown', 'mixed'].includes(staged[0].speed_mode));
    assert.deepEqual({ ...staged[0], speed_mode: beforeRaw[0].speed_mode,
      speed_mode_source: beforeRaw[0].speed_mode_source }, { ...beforeRaw[0] },
    'reclassification preserves the HMAC, receipt timing, TTFT and completion measurements');
    const checkpoint = current.db.prepare('SELECT * FROM source').get();
    assert.equal(checkpoint.parser_version, priorVersion);
    assert.equal(checkpoint.replay_parser_version, INFERENCE_TIMING_PARSER_VERSION);
    assert.equal(JSON.parse(checkpoint.state).diagnostics.oversized, 1);
    const cancel = new AbortController();
    await assert.rejects(ingestTimingFile(current, file, {
      signal: cancel.signal, onReadLine: () => cancel.abort(),
    }), /cancelled/u);
    assert.deepEqual(current.db.prepare('SELECT * FROM source').get(), checkpoint);
    assert.deepEqual(current.db.prepare('SELECT * FROM parser_replay_turn').all(), staged);
    assert.deepEqual(readTimingRows(current), before.rows);
    current.close();
    current = await openTimingStore(directory, currentOptions);
    assert.deepEqual(readTimingRows(current), before.rows);
    const complete = await ingestTimingFile(current, file);
    assert.equal(complete.replayed, true);
    assert.equal(complete.invalidated, true);
    assert.equal(complete.revision, 1);
    const after = readTimingRows(current, { withRevision: true });
    assert.equal(after.rows.length, 2);
    assert.ok(['unknown', 'mixed'].includes(after.rows[0].speed_mode));
    assert.equal(after.rows[1].speed_mode, 'fast');
    const afterRaw = current.db.prepare('SELECT * FROM turn ORDER BY at').all();
    assert.deepEqual(afterRaw.map((row, index) => ({ ...row,
      speed_mode: beforeRaw[index].speed_mode, speed_mode_source: beforeRaw[index].speed_mode_source,
    })), beforeRaw.map(row => ({ ...row })));
    assert.equal(after.sources[0].parserVersion, INFERENCE_TIMING_PARSER_VERSION);
    assert.equal(after.sources[0].replayParserVersion, 0);
    assert.equal(after.sources[0].telemetryRevision, before.sources[0].telemetryRevision + 2);
    assert.equal(JSON.parse(current.db.prepare('SELECT state FROM source').get().state).diagnostics.oversized, 1);
    assert.equal(current.db.prepare('SELECT COUNT(*) AS count FROM parser_replay_turn').get().count, 0);
    assert.equal(localFastTurns(after.rows), 1);
    const reports = project(after.rows);
    assert.equal(reports.filter(report => report.speedMode === 'fast')
      .reduce((sum, report) => sum + report.speedTurns, 0), 1);
    assert.equal(reports.filter(report => ['unknown', 'mixed'].includes(report.speedMode))
      .reduce((sum, report) => sum + report.speedTurns, 0), 1);
    assert.deepEqual(await ingestTimingFile(current, file), { bytes: 0, unchanged: true });
    assert.deepEqual(readTimingRows(current, { withRevision: true }), after);
  } finally { current.close(); }
});

test('bounded parser repair keeps last-good rows until the complete replay commits after restart', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-parser-staging-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'source.jsonl'), directory = join(root, 'timing');
  const first = fixture();
  Object.assign(first.find(row => row.type === 'turn_context').payload, { model: 'gpt-6.1-sol', service_tier: 'ultrafast' });
  const second = JSON.parse(JSON.stringify(first.slice(1)).replaceAll('synthetic-turn', 'synthetic-next-turn')
    .replaceAll('synthetic-response', 'synthetic-next-response'));
  for (const row of second) {
    row.timestamp = new Date(Date.parse(row.timestamp) + 2000).toISOString();
    for (const key of ['started_at_ms', 'completed_at_ms']) if (Object.hasOwn(row.payload, key)) row.payload[key] += 2000;
  }
  await writeFile(file, lines([...first, ...second]), { mode: 0o600 });
  const priorVersion = INFERENCE_TIMING_PARSER_VERSION - 1;
  const old = await openTimingStore(directory, { ...options, parserVersion: priorVersion });
  await ingestTimingFile(old, file);
  old.db.exec("UPDATE turn SET model=NULL,speed_mode='other'");
  const before = readTimingRows(old);
  assert.equal(before.length, 2);
  old.close();
  const currentOptions = { ...options, parserVersion: INFERENCE_TIMING_PARSER_VERSION };
  let current = await openTimingStore(directory, currentOptions);
  try {
    const partial = await ingestTimingFile(current, file, { maxBytes: Buffer.byteLength(lines(first)) });
    assert.equal(partial.replayed, true);
    assert.equal(partial.invalidated, false);
    assert.equal(partial.revision, 0);
    assert.deepEqual(readTimingRows(current), before);
    assert.equal(current.db.prepare('SELECT COUNT(*) AS count FROM parser_replay_turn').get().count, 1);
    const source = current.db.prepare('SELECT * FROM source').get();
    assert.equal(source.parser_version, priorVersion);
    assert.equal(source.replay_parser_version, INFERENCE_TIMING_PARSER_VERSION);
    const cancel = new AbortController();
    await assert.rejects(ingestTimingFile(current, file, { signal: cancel.signal, onReadLine: () => cancel.abort() }), /cancelled/u);
    assert.deepEqual(current.db.prepare('SELECT * FROM source').get(), source);
    assert.deepEqual(readTimingRows(current), before);
    current.close();
    await assert.rejects(openTimingStore(directory, { ...options, parserVersion: priorVersion }), /incompatible_parser_version/u);
    current = await openTimingStore(directory, currentOptions);
    assert.deepEqual(readTimingRows(current), before);
    const complete = await ingestTimingFile(current, file);
    assert.equal(complete.replayed, true);
    assert.equal(complete.invalidated, true);
    assert.equal(complete.revision, 1);
    const after = readTimingRows(current, { withRevision: true });
    assert.equal(after.rows.length, 2);
    assert.ok(after.rows.every(row => row.model === 'gpt-6.1-sol' && row.speed_mode === 'ultrafast'));
    assert.equal(after.sources[0].parserVersion, INFERENCE_TIMING_PARSER_VERSION);
    assert.equal(after.sources[0].replayParserVersion, 0);
    assert.equal(current.db.prepare('SELECT COUNT(*) AS count FROM parser_replay_turn').get().count, 0);
    assert.deepEqual(await ingestTimingFile(current, file), { bytes: 0, unchanged: true });
  } finally { current.close(); }
});

test('parser repair preserves retained evidence when a source is unavailable or rewritten', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-parser-source-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'source.jsonl'), directory = join(root, 'timing');
  await writeFile(file, lines(fixture()), { mode: 0o600 });
  const old = await openTimingStore(directory, options);
  await ingestTimingFile(old, file);
  const before = readTimingRows(old, { withRevision: true });
  old.close();
  const current = await openTimingStore(directory, { ...options, parserVersion: INFERENCE_TIMING_PARSER_VERSION });
  try {
    await assert.rejects(ingestTimingFile(current, join(root, 'missing.jsonl')));
    await writeFile(file, lines(fixture()).replace('gpt-5.6-sol', 'gpt-6-astra'), { mode: 0o600 });
    await assert.rejects(ingestTimingFile(current, file), /source_rewritten/u);
    assert.deepEqual(readTimingRows(current, { withRevision: true }), before);
  } finally { current.close(); }
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
