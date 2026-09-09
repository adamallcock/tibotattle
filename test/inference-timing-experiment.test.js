import test from 'node:test';
import { appendFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, appendFile, chmod, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createParser } from '../tools/reports/inference-timing/parser.mjs';
import { openStore, ingestFile, report } from '../tools/reports/inference-timing/store.mjs';
import { argumentsFor } from '../tools/reports/inference-timing/run.mjs';

const BASE = Date.parse('2026-09-01T12:00:00Z');
const key = Buffer.alloc(32, 7);
const rec = (ms, type, payload) => ({ timestamp: new Date(BASE + ms).toISOString(), type, payload });
const event = (ms, type, rest = {}) => rec(ms, 'event_msg', { type, turn_id: 'synthetic-turn', ...rest });
function fixture() {
  return [rec(0, 'session_meta', { id: 'synthetic-session' }),
    event(0, 'task_started'),
    rec(0, 'turn_context', { turn_id: 'synthetic-turn', model: 'gpt-6-astra', effort: 'high' }),
    event(1000, 'item_completed', { thread_id: 'synthetic-session', item: { type: 'Reasoning' }, started_at_ms: BASE, completed_at_ms: BASE + 1000 }),
    usage(1000, 'response-one', 100, 100),
    rec(201000, 'response_item', { type: 'function_call_output', output: 'synthetic tool result' }),
    event(202000, 'item_completed', { thread_id: 'synthetic-session', item: { type: 'AgentMessage' }, started_at_ms: BASE + 201000, completed_at_ms: BASE + 202000 }),
    usage(202000, 'response-two', 100, 200),
    event(202000, 'task_complete', { duration_ms: 202000, time_to_first_token_ms: 100 })];
}
function usage(ms, response, n, total) {
  return rec(ms, 'token_usage_record', { thread_id: 'synthetic-session', turn_id: 'synthetic-turn',
    response_id: response, usage: { output_tokens: n, reasoning_output_tokens: n / 2 },
    turn_token_usage: { output_tokens: total, reasoning_output_tokens: total / 2 } });
}
const lines = rows => rows.map(r => JSON.stringify(r) + '\n').join('');
function parse(rows) {
  const result = []; const parser = createParser(key, null, t => result.push(t));
  rows.forEach((r, i) => parser.line(Buffer.from(JSON.stringify(r)), i + 1, false));
  return { result, parser };
}
test('excludes 200 seconds of tools and includes reasoning exactly once', () => {
  const t = parse(fixture()).result[0];
  assert.equal(t.tokens, 200); assert.equal(t.reasoning, 100);
  assert.equal(t.duration, 2000); assert.equal(t.tokens / (t.duration / 1000), 100);
  assert.equal(t.ttft, 100); assert.equal(t.responses, 2); assert.equal(t.quality, 'complete');
});
test('missing, overlapping, duplicate, conflicting and mixed evidence fails closed', () => {
  const cases = [
    x => x.splice(3, 1),
    x => { x[6].payload.started_at_ms = BASE + 500; },
    x => x.splice(5, 0, structuredClone(x[4])),
    x => { x[7].payload.turn_token_usage.output_tokens = 999; },
    x => x.splice(6, 0, rec(201000, 'turn_context', { turn_id: 'synthetic-turn', model: 'gpt-5.6-luna', effort: 'high' })),
  ];
  for (const mutate of cases) { const x = fixture(); mutate(x); assert.equal(parse(x).result[0].duration, null); }
});
test('TTFT stays independent and missing TTFT does not become zero', () => {
  const x = fixture(); x.splice(3, 1); assert.equal(parse(x).result[0].ttft, 100);
  const y = fixture(); delete y.at(-1).payload.time_to_first_token_ms;
  assert.equal(parse(y).result[0].ttft, null); assert.equal(parse(y).result[0].duration, 2000);
});
test('oversized timing and malformed records invalidate timing; oversized tool content is ignored', () => {
  for (const type of ['timing', 'malformed', 'tool']) {
    const result = []; const p = createParser(key, null, t => result.push(t));
    fixture().forEach((r, i) => {
      p.line(Buffer.from(JSON.stringify(r)), i, false);
      if (i === 3) p.line(Buffer.from(type === 'tool' ? JSON.stringify(rec(1000, 'response_item', {}))
        : type === 'malformed' ? '{"type":"token_usage_record",' : '{'), 33, type !== 'malformed');
    });
    assert.equal(result[0].duration, type === 'tool' ? 2000 : null);
  }
});
test('forks are excluded and retained fields contain no raw identities or item content', () => {
  const x = fixture(); x[0].payload.forked_from_id = 'synthetic-parent'; assert.equal(parse(x).result.length, 0);
  const y = fixture(); y[3].payload.item.text = 'PRIVATE_SENTINEL';
  const { result, parser } = parse(y);
  assert.doesNotMatch(JSON.stringify({ result, state: parser.state() }), /PRIVATE_SENTINEL|synthetic-session|synthetic-turn|response-one/);
});
async function setup(t) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'timing-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'synthetic.jsonl'); await writeFile(file, lines(fixture()), { mode: 0o600 });
  const store = await openStore(join(dir, 'out')); t.after(() => store.close());
  return { dir, file, store };
}
test('incremental restart equals cold scan; unchanged scan reads no rollout bytes', async t => {
  const { file, store } = await setup(t);
  const x = fixture(); await writeFile(file, lines(x.slice(0, 5)));
  await ingestFile(store, file); assert.equal(report(store).turns.length, 0);
  await appendFile(file, lines(x.slice(5))); await ingestFile(store, file);
  assert.equal(report(store).turns[0].duration, 2000);
  assert.equal((await ingestFile(store, file)).bytes, 0);
  const data = report(store); await ingestFile(store, file); assert.deepEqual(report(store), data);
});
test('partial trailing line is deferred, then read exactly once', async t => {
  const { file, store } = await setup(t); const text = lines(fixture());
  await writeFile(file, text.slice(0, -12)); await ingestFile(store, file);
  assert.equal(report(store).turns.length, 0);
  assert.equal((await ingestFile(store, file)).bytes, 0);
  await appendFile(file, text.slice(-12)); await ingestFile(store, file);
  assert.equal(report(store).turns.length, 1);
});
test('unfinished reconstruction survives closing and reopening the database', async t => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'timing-restart-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'synthetic.jsonl'), output = join(dir, 'out');
  const x = fixture(); await writeFile(file, lines(x.slice(0, 5)), { mode: 0o600 });
  const first = await openStore(output);
  try { await ingestFile(first, file); } finally { first.close(); }
  await appendFile(file, lines(x.slice(5)));
  const second = await openStore(output);
  try { await ingestFile(second, file); assert.equal(report(second).turns[0].duration, 2000); }
  finally { second.close(); }
});
test('unbounded active turns cannot grow pending state without limit', () => {
  const parser = createParser(key, null, () => {});
  parser.line(Buffer.from(JSON.stringify(fixture()[0])), 1, false);
  for (let i = 0; i < 1000; i++) parser.line(Buffer.from(JSON.stringify(event(i, 'task_started', { turn_id: `synthetic-${i}` }))), i + 2, false);
  assert.ok(Object.keys(parser.state().turns).length <= 8);
  assert.ok(Buffer.byteLength(JSON.stringify(parser.state())) <= 128 * 1024);
  assert.ok(parser.state().diagnostics.capacity > 0);
});
test('cancellation rolls back both rows and checkpoint and can retry', async t => {
  const { file, store } = await setup(t); const controller = new AbortController();
  await assert.rejects(ingestFile(store, file, { signal: controller.signal, onReadLine: () => controller.abort() }), /cancelled/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM source').get().n, 0);
  assert.equal(report(store).turns.length, 0);
  await ingestFile(store, file); assert.equal(report(store).turns.length, 1);
});
test('truncation, rewrites and replacement preserve last good result', async t => {
  const { file, store } = await setup(t); await ingestFile(store, file);
  const before = report(store);
  await writeFile(file, 'x'); await assert.rejects(ingestFile(store, file), /source_replaced/);
  assert.deepEqual(report(store), before);
});
test('duplicate physical source does not duplicate logical turn', async t => {
  const { dir, file, store } = await setup(t); await ingestFile(store, file);
  const copy = join(dir, 'copy.jsonl'); await writeFile(copy, await readFile(file), { mode: 0o600 });
  await ingestFile(store, copy); assert.equal(report(store).turns.length, 1);
});
test('conflicting duplicate invalidates the measurement', async t => {
  const { dir, file, store } = await setup(t); await ingestFile(store, file);
  const x = fixture(); x.at(-1).payload.time_to_first_token_ms = 200;
  const copy = join(dir, 'conflict.jsonl'); await writeFile(copy, lines(x), { mode: 0o600 });
  await ingestFile(store, copy);
  const rows = report(store).turns;
  assert.equal(rows.length, 1); assert.equal(rows[0].quality, 'conflicting_duplicate');
  assert.equal(rows[0].duration, null); assert.equal(rows[0].ttft, null);
});
test('oversized lines resume across budgets and later turns remain readable', async t => {
  const { file, store } = await setup(t);
  const x = fixture(); const huge = JSON.stringify(rec(0, 'response_item', { text: 'x'.repeat(3 * 1024 ** 2) })) + '\n';
  await writeFile(file, lines(x.slice(0, 1)) + huge + lines(x.slice(1)));
  let calls = 0, receipt;
  do { receipt = await ingestFile(store, file, { maxBytes: 1024 ** 2 }); calls++; } while (receipt.remaining && calls < 10);
  assert.ok(calls < 10); assert.equal(report(store).turns[0].duration, 2000);
});
test('failed source validation charges the attempted range', async t => {
  const { file, store } = await setup(t); let changed = false;
  const size = Buffer.byteLength(lines(fixture()));
  await assert.rejects(ingestFile(store, file, { onReadLine: () => {
    if (!changed) { changed = true; appendFileSync(file, '\n'); }
  } }), e => e.message === 'source_changed' && e.attemptedBytes === size);
  assert.equal(report(store).turns.length, 0);
});
test('unknown schema, unsafe permissions and symlinks are refused', async t => {
  const { dir, file, store } = await setup(t);
  store.db.exec('PRAGMA user_version=999');
  await assert.rejects(openStore(join(dir, 'out')), /incompatible_database/);
  await chmod(join(dir, 'out'), 0o755); await assert.rejects(openStore(join(dir, 'out')), /unsafe_directory/);
  const link = join(dir, 'link.jsonl'); await symlink(file, link); await assert.rejects(ingestFile(store, link));
});
test('busy database leaves prior result and cursor intact', async t => {
  const { file, store } = await setup(t); const other = new DatabaseSync(store.file);
  try {
    other.exec('BEGIN IMMEDIATE'); await assert.rejects(ingestFile(store, file), /locked/);
    assert.equal(report(store).turns.length, 0); other.exec('ROLLBACK');
    await ingestFile(store, file); assert.equal(report(store).turns.length, 1);
  } finally { other.close(); }
});
test('CLI refuses unknown options and unbounded budgets', () => {
  assert.throws(() => argumentsFor(['--unknown']));
  assert.throws(() => argumentsFor(['--root', '.', '--output', '.', '--since', '2026-09-01', '--max-bytes', '-1']));
});

test('expanded scan file limit remains explicitly bounded', () => {
  const base = ['--root', '.', '--output', '.', '--since', '2026-08-10'];
  assert.equal(argumentsFor([...base, '--max-files', '5000'])['max-files'], 5000);
  assert.throws(() => argumentsFor([...base, '--max-files', '5001']));
});
