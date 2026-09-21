import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParser, createToolFreeParser, digest, METHOD, TOOL_FREE_METHOD, MAX_STATE_BYTES } from '../src/providers/codex/logs.js';
import { openTimingStore, ingestTimingFile, readTimingRows } from '../src/platform/index.js';
import { createModelPerformanceController } from '../apps/local/model-performance-controller.js';
import { modelPerformanceSourceScope } from '../apps/local/model-performance-snapshots.js';

const BASE = Date.parse('2026-06-01T12:00:00Z');
const key = Buffer.alloc(32, 7);
const rec = (at, type, payload) => ({ timestamp: new Date(BASE + at).toISOString(), type, payload });
const event = (at, type, rest = {}) => rec(at, 'event_msg', { type, turn_id: 'turn', ...rest });
const count = (at, total, last) => rec(at, 'event_msg', { type: 'token_count', info: {
  total_token_usage: { output_tokens: total, reasoning_output_tokens: total / 2 },
  last_token_usage: { output_tokens: last, reasoning_output_tokens: last / 2 },
} });
const fixture = () => [rec(-100, 'session_meta', { id: 'session' }), count(-100, 1000, 10),
  event(0, 'task_started'), rec(0, 'turn_context', { turn_id: 'turn', model: 'gpt-5.5', effort: 'high' }),
  event(1000, 'item_completed', { thread_id: 'session', item: { type: 'AgentMessage' }, completed_at_ms: BASE + 1000 }),
  rec(1000, 'response_item', { type: 'message', role: 'assistant', content: [] }),
  count(1000, 1120, 120), event(1200, 'task_complete', { duration_ms: 1200, time_to_first_token_ms: 200 })];
const lines = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
function parse(rows, factory = createToolFreeParser) {
  const turns = [], parser = factory(key, null, t => turns.push(t));
  rows.forEach((r, i) => parser.line(Buffer.from(JSON.stringify(r)), i, false));
  return turns;
}
const admitted = rows => parse(rows).some(t => t.sample_method === 'tool_free');
const modern = () => {
  const rows = fixture();
  rows[4].payload.started_at_ms = BASE + 500;
  rows.splice(7, 0, rec(1000, 'token_usage_record', { thread_id: 'session', turn_id: 'turn', response_id: 'response',
    usage: { output_tokens: 120, reasoning_output_tokens: 60 }, turn_token_usage: { output_tokens: 120, reasoning_output_tokens: 60 } }));
  return rows;
};

test('old single response adds throughput including initial wait without changing original parser', () => {
  const old = parse(fixture(), createParser)[0], added = parse(fixture())[0];
  assert.equal(old.sample_method, null); assert.equal(old.ttft, 200);
  assert.equal(added.sample_method, 'tool_free'); assert.equal(added.sample_tokens, 120);
  assert.equal(added.sample_reasoning, 60); assert.equal(added.sample_duration, 1200);
  assert.equal(added.sample_responses, 1); assert.equal(added.ttft, old.ttft);
  const noTtft = fixture(); delete noTtft.at(-1).payload.time_to_first_token_ms;
  assert.equal(parse(noTtft)[0].sample_duration, 1200, 'TTFT is not needed and never subtracted');
});

test('known tools, unknown activity and compaction fail closed even without tool outputs', () => {
  for (const type of ['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output',
    'web_search_call', 'image_generation_call', 'tool_search_call', 'tool_search_output', 'future_tool', 'compaction']) {
    const rows = fixture(); rows.splice(4, 0, rec(100, 'response_item', { type }));
    assert.equal(admitted(rows), false, type);
  }
  for (const item of ['McpToolCall', 'FileChange', 'WebSearch', 'ContextCompaction', 'Extension', 'Unknown']) {
    const rows = fixture(); rows.splice(4, 0, event(100, 'item_completed', { thread_id: 'session', item: { type: item } }));
    assert.equal(admitted(rows), false, item);
  }
  for (const type of ['exec_command_begin', 'web_search_end', 'future_activity']) {
    const rows = fixture(); rows.splice(4, 0, event(100, type)); assert.equal(admitted(rows), false, type);
  }
  const rows = fixture(); rows.splice(4, 0, rec(100, 'compacted', {})); assert.equal(admitted(rows), false);
});

test('incomplete tokens, multiple responses, resets, missing baselines and changed models fail closed', () => {
  const cases = [
    rows => rows.splice(1, 1),
    rows => { rows[6].payload.info.last_token_usage.output_tokens = 118; },
    rows => { rows[6].payload.info.total_token_usage.output_tokens = 800; },
    rows => { delete rows[6].payload.info.total_token_usage.reasoning_output_tokens; },
    rows => rows.splice(7, 0, count(1100, 1240, 120)),
    rows => rows.splice(6, 0, rec(1000, 'turn_context', { turn_id: 'turn', model: 'gpt-5.4', effort: 'high' })),
    rows => rows.splice(7, 0, rec(1100, 'response_item', { type: 'message', role: 'assistant', content: [] })),
    rows => { rows.at(-1).payload.error = true; },
    rows => { rows.at(-1).payload.duration_ms = 99999; },
    rows => { rows[0].payload.forked_from_id = 'parent'; },
    rows => { rows[4].payload.thread_id = 'other'; },
    rows => { rows[5].payload.internal_chat_message_metadata_passthrough = { turn_id: 'other' }; },
  ];
  for (const mutate of cases) { const rows = fixture(); mutate(rows); assert.equal(admitted(rows), false); }
  const repeated = fixture(); repeated.splice(7, 0, count(1100, 1120, 120));
  assert.equal(admitted(repeated), true, 'repeated token snapshots do not double count');
});

test('steering, transient concurrency and reordered timestamps cannot create a no-tool sample', () => {
  for (const extra of [rec(1050, 'response_item', { type: 'message', role: 'user', content: [] }),
    event(1050, 'user_message'), event(900, 'thread_goal_updated')]) {
    const rows = fixture(); rows.splice(7, 0, extra); assert.equal(admitted(rows), false);
  }
  const rows = fixture(); rows.splice(4, 0, event(100, 'task_started', { turn_id: 'parallel' }),
    event(200, 'turn_aborted', { turn_id: 'parallel' })); assert.equal(admitted(rows), false);
});

test('modern receipts reconcile independently; their mirror cannot rescue rejected usage', () => {
  const rows = modern(), measured = parse(rows, createParser)[0], throughput = parse(rows)[0];
  assert.equal(measured.sample_method, 'receipt'); assert.equal(measured.sample_duration, 500);
  assert.equal(throughput.sample_method, 'tool_free'); assert.equal(throughput.sample_duration, 1200);
  for (const mutate of [rows => { rows[7].payload.turn_token_usage.output_tokens = 999; },
    rows => rows.splice(8, 0, structuredClone(rows[7])),
    rows => { rows[7].payload.turn_id = 'orphan'; },
    ...[undefined, 'orphan'].map(turn_id => rows => {
      const orphan = structuredClone(rows[7]); orphan.payload.turn_id = turn_id; rows.splice(8, 0, orphan);
    })]) {
    const rows = modern(); mutate(rows); assert.equal(admitted(rows), false);
  }
});

test('malformed and oversized content exclude throughput without retaining private text', () => {
  for (const [bytes, partial] of [[Buffer.from('{'), false], [Buffer.from(JSON.stringify(rec(100, 'response_item', {}))), true]]) {
    const results = [], parser = createToolFreeParser(key, null, t => results.push(t));
    fixture().forEach((r, i) => { parser.line(Buffer.from(JSON.stringify(r)), i, false); if (i === 3) parser.line(bytes, i, partial); });
    assert.equal(results[0].sample_method, null);
  }
  const rows = fixture(); rows[5].payload.content = [{ text: 'PRIVATE_SENTINEL function_call' }];
  assert.equal(admitted(rows), true, 'content is data, never an activity type');
  assert.doesNotMatch(JSON.stringify(parse(rows)), /PRIVATE_SENTINEL|response_item/);
});

const primaryConfig = { createParser, digest, METHOD, MAX_STATE_BYTES };
const extraConfig = correlationKey => ({ createParser: createToolFreeParser, digest, METHOD: TOOL_FREE_METHOD, MAX_STATE_BYTES, correlationKey });
async function setup(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'tool-free-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'synthetic.jsonl');
  const primary = await openTimingStore(join(dir, 'primary'), primaryConfig);
  t.after(() => primary.close());
  return { dir, file, primary };
}

test('additive sidecar resumes and joins without changing original rows, version or turn counts', async t => {
  const { dir, file, primary } = await setup(t);
  await writeFile(file, lines(fixture()), { mode: 0o600 }); await ingestTimingFile(primary, file);
  const before = readTimingRows(primary);
  const path = join(dir, 'supplement');
  let extra = await openTimingStore(path, extraConfig(primary.key));
  try {
    assert.equal(extra.db.prepare('PRAGMA user_version').get().user_version, 5);
    await ingestTimingFile(extra, file, { maxBytes: Buffer.byteLength(lines(fixture().slice(0, 6))) });
  } finally { extra.close(); }
  extra = await openTimingStore(path, extraConfig(primary.key));
  try {
    await ingestTimingFile(extra, file);
    const joined = readTimingRows(primary, { supplement: extra });
    assert.equal(joined.length, 1); assert.equal(joined[0].tool_free_tokens, 120); assert.equal(joined[0].tool_free_duration, 1200);
    const { tool_free_tokens, tool_free_duration, ...original } = joined[0];
    assert.deepEqual(original, before[0]); assert.deepEqual(readTimingRows(primary), before);
    assert.equal(primary.db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal((await ingestTimingFile(extra, file)).bytes, 0);
    await assert.rejects(openTimingStore(path, primaryConfig), /incompatible_database/);
    await assert.rejects(openTimingStore(path, extraConfig(Buffer.alloc(32))), /correlation_mismatch/);
    const duplicate = join(dir, 'duplicate.jsonl'); await writeFile(duplicate, lines(fixture()), { mode: 0o600 });
    await ingestTimingFile(extra, duplicate); assert.equal(readTimingRows(primary, { supplement: extra }).length, 1);
    const conflict = fixture(); conflict[5].payload.type = 'function_call';
    const conflicting = join(dir, 'conflict.jsonl'); await writeFile(conflicting, lines(conflict), { mode: 0o600 });
    await ingestTimingFile(extra, conflicting);
    assert.deepEqual(readTimingRows(primary, { supplement: extra }), before, 'conflicting supplement drops only new observation');
  } finally { extra.close(); }
});

test('supplement cancellation rolls back rows and checkpoints, preserving existing data', async t => {
  const { dir, file, primary } = await setup(t);
  await writeFile(file, lines(fixture()), { mode: 0o600 }); await ingestTimingFile(primary, file);
  const before = readTimingRows(primary), extra = await openTimingStore(join(dir, 'extra'), extraConfig(primary.key));
  try {
    const abort = new AbortController();
    await assert.rejects(ingestTimingFile(extra, file, { signal: abort.signal, onReadLine: () => abort.abort() }), /cancelled/);
    assert.equal(extra.db.prepare('SELECT count(*) n FROM source').get().n, 0);
    assert.deepEqual(readTimingRows(primary, { supplement: extra }), before);
    await ingestTimingFile(extra, file);
    assert.equal(readTimingRows(primary, { supplement: extra })[0].tool_free_tokens, 120);
  } finally { extra.close(); }
});


test('real worker backfills the supplement beside saved measurements and preserves them on restart', async t => {
  const { dir, file, primary } = await setup(t);
  const codexHome = join(dir, 'codex'); await mkdir(join(codexHome, 'sessions'), { recursive: true });
  const source = join(codexHome, 'sessions', 'synthetic.jsonl');
  await writeFile(source, lines(fixture()), { mode: 0o600 });
  await ingestTimingFile(primary, source);
  const before = readTimingRows(primary);
  const options = { directory: join(dir, 'primary'), codexHome };
  const ready = async (controller, expectedModels = 1) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const result = await controller.read('all');
      if (expectedModels === 0) assert.deepEqual(result.models, [], 'another source cannot supply either throughput population');
      if (result.status === 'ready' && !result.collecting && result.models.length === expectedModels) return result;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('worker did not complete the additive scan');
  };
  for (let pass = 0; pass < 2; pass++) {
    const controller = createModelPerformanceController(options);
    try {
      const result = await ready(controller), model = result.models[0];
      assert.equal(result.stale, false); assert.equal(model.turns, 1);
      assert.equal(model.speedTurns, 1); assert.equal(model.ttftTurns, 1); assert.equal(model.toolFreeTurns, 1);
      assert.equal(model.toolFree[0].median, 100);
      assert.equal(model.speed[0].points[0].median, 100);
      assert.deepEqual(readTimingRows(primary), before);
    } finally { await controller.close(); }
  }
  const emptyHome = join(dir, 'empty-codex');
  await mkdir(join(emptyHome, 'sessions'), { recursive: true });
  for (const [home, expectedModels] of [[emptyHome, 0], [codexHome, 1]]) {
    const controller = createModelPerformanceController({ ...options, codexHome: home });
    try {
      const result = await ready(controller, expectedModels);
      assert.equal(result.stale, false);
      if (expectedModels) {
        assert.equal(result.models[0].toolFreeTurns, 1);
        assert.equal(result.models[0].toolFree[0].median, 100, 'returning to the original source preserves its supplement');
      }
    } finally { await controller.close(); }
  }
  // Each Codex root owns both of its additive sidecars; the unscoped original
  // remains untouched because it cannot prove which root produced its rows.
  const scopedDirectory = join(options.directory, `source-${modelPerformanceSourceScope(codexHome)}`);
  const scopedPrimary = await openTimingStore(scopedDirectory, primaryConfig);
  try {
    const extra = await openTimingStore(join(scopedDirectory, 'tool-free-v1'), extraConfig(scopedPrimary.key));
    extra.db.exec('PRAGMA user_version=999'); extra.close();
    assert.equal(scopedPrimary.db.prepare('PRAGMA user_version').get().user_version, 4);
  } finally { scopedPrimary.close(); }
  const snapshotFile = join(options.directory, 'model-performance-snapshot.json');
  const saved = await readFile(snapshotFile, 'utf8');
  let controller = createModelPerformanceController(options);
  try {
    const result = await ready(controller);
    assert.equal(result.stale, true); assert.equal(result.models[0].ttftTurns, 1);
    assert.equal(result.models[0].turns, 1); assert.equal(result.models[0].toolFreeTurns, 1);
    assert.equal(result.models[0].toolFree[0].median, 100, 'last completed supplement stays visible with stale label');
  } finally { await controller.close(); }
  assert.equal(await readFile(snapshotFile, 'utf8'), saved, 'failed supplement cannot replace the saved completion');
  // Without a retained completion, an incompatible supplement still leaves the
  // original metrics available; no new throughput evidence is manufactured.
  await rename(snapshotFile, join(options.directory, 'preserved-snapshot.json'));
  controller = createModelPerformanceController(options);
  try {
    const result = await ready(controller);
    assert.equal(result.stale, true); assert.equal(result.models[0].ttftTurns, 1);
    assert.equal(result.models[0].turns, 1); assert.equal(result.models[0].toolFreeTurns, 0);
    assert.deepEqual(result.models[0].toolFree, []);
    assert.deepEqual(readTimingRows(primary), before, 'legacy original metrics remain unchanged');
  } finally { await controller.close(); }
});
