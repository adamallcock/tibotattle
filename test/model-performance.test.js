import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelPerformanceProjection } from '../src/reporting/index.js';
import { createModelPerformanceController } from '../apps/local/model-performance-controller.js';

const NOW = Date.parse('2026-09-09T12:00:00Z'), DAY = 86400000;
const row = (patch = {}) => ({ at: NOW, model: 'gpt-5.6-sol', sample_method: 'receipt',
  sample_tokens: 100, sample_duration: 1000, sample_responses: 1, sample_total_responses: 2,
  ttft: 5000, ...patch });
test('period coverage is independent and separates receipt/legacy distributions', () => {
  const rows = [row(), row({ sample_method: 'legacy', sample_tokens: 200 }),
    row({ sample_duration: null }), row({ ttft: null }), row({ at: NOW - 8 * DAY }),
    row({ model: 'unknown-private-model' }), row({ at: NOW + 1 })];
  const result = modelPerformanceProjection(rows, { period: '7', now: NOW });
  const m = result.models[0];
  assert.equal(m.turns, 4); assert.equal(m.speedTurns, 3); assert.equal(m.ttftTurns, 3);
  assert.equal(m.timedResponses, 3); assert.equal(m.speed[0].points[0].median, 100);
  assert.equal(m.speed[1].points[0].median, 200); assert.equal(m.ttft[0].median, 5);
  assert.equal(modelPerformanceProjection(rows, { period: 'all', now: NOW }).models[0].turns, 5);
});
test('median and middle50% resist extremes without manufacturing missing bins or sparse bands', () => {
  const rows = [1,2,3,4,100000].map(n => row({ ttft: n * 1000 }));
  rows.push(row({ at: NOW - 2 * DAY, ttft: 0 }));
  const points = modelPerformanceProjection(rows, { now: NOW }).models[0].ttft;
  assert.equal(points.length, 2); assert.equal(points[0].median, 0); assert.equal(points[0].p25, null);
  assert.equal(points[1].median, 3); assert.equal(points[1].p25, 2); assert.equal(points[1].p75, 4);
});
test('all history uses bounded weekly bins and excludes missing or invalid samples', () => {
  const rows = [row({ at: NOW - 400 * DAY }), row({ sample_tokens: NaN, ttft: null }),
    row({ sample_responses: 3, ttft: -1 }), row({ model: null })];
  const result = modelPerformanceProjection(rows, { now: NOW });
  assert.equal(result.interval, 'week'); assert.equal(result.models[0].turns, 3);
  assert.equal(result.models[0].speedTurns, 1); assert.equal(result.models[0].ttftTurns, 1);
  assert.deepEqual(modelPerformanceProjection([], { now: NOW }).models, []);
  assert.throws(() => modelPerformanceProjection([], { period: '90', now: NOW }));
  assert.throws(() => modelPerformanceProjection(new Array(100001), { now: NOW }));
});
test('controller is lazy, coalesces reads, retains good snapshots on failure, and cancels', async () => {
  class FakeWorker extends EventEmitter {
    unref() {} postMessage(message) { assert.equal(message.type, 'stop'); queueMicrotask(() => this.emit('exit', 0)); }
  }
  let made = 0, worker;
  const c = createModelPerformanceController({ directory: 'unused', codexHome: 'unused', platform: 'darwin',
    workerFactory: () => { made++; return worker = new FakeWorker(); } });
  assert.equal(made, 0); assert.equal((await c.read('all')).status, 'loading');
  await c.read('7'); assert.equal(made, 1);
  const value = modelPerformanceProjection([row()], { now: NOW });
  worker.emit('message', { type: 'snapshots', values: [value] });
  assert.equal((await c.read('all')).models[0].turns, 1);
  worker.emit('error', new Error('private failure'));
  assert.equal((await c.read('all')).stale, true);
  assert.equal((await c.read('all')).models[0].turns, 1);
  await c.close(); assert.equal((await c.read('all')).status, 'unavailable');
  await assert.rejects(c.read('90'));
});
test('Windows returns the closed unavailable DTO immediately without a timing worker', async () => {
  let workers = 0;
  const controller = createModelPerformanceController({
    directory: 'unused', codexHome: 'unused', platform: 'win32',
    workerFactory: () => { workers++; throw new Error('must not start'); },
  });
  try {
    for (const period of ['7', '30', 'all', 'all']) {
      const result = await controller.read(period);
      assert.deepEqual(Object.keys(result).sort(), [
        'schemaVersion', 'method', 'status', 'collecting', 'stale', 'updatedAt',
        'period', 'interval', 'start', 'end', 'models',
      ].sort());
      assert.equal(result.status, 'unavailable');
      assert.equal(result.collecting, false);
      assert.equal(result.stale, false);
      assert.equal(result.period, period);
      assert.equal(result.updatedAt, null);
      assert.deepEqual(result.models, []);
    }
    await assert.rejects(controller.read('90'), /invalid_timing_period/u);
    assert.equal(workers, 0);
  } finally { await controller.close(); }
  assert.equal((await controller.read('all')).status, 'unavailable');
  assert.equal(workers, 0);
});

test('actual worker reconstructs synthetic logs off-main, persists, and shuts down', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'model-speed-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, 'codex'); await mkdir(join(codexHome, 'sessions'), { recursive: true });
  const at = Date.now() - 5000, thread = 'synthetic-session', turn = 'synthetic-turn';
  const rec = (n, type, payload) => ({ timestamp: new Date(at + n).toISOString(), type, payload });
  const rows = [rec(0, 'session_meta', { id: thread }),
    rec(0, 'event_msg', { type: 'task_started', turn_id: turn }),
    rec(0, 'turn_context', { turn_id: turn, model: 'gpt-5.6-sol', effort: 'high' }),
    rec(1000, 'event_msg', { type: 'item_completed', thread_id: thread, turn_id: turn,
      item: { type: 'Reasoning' }, started_at_ms: at, completed_at_ms: at + 1000 }),
    rec(1000, 'token_usage_record', { thread_id: thread, turn_id: turn, response_id: 'synthetic-response',
      usage: { output_tokens: 100, reasoning_output_tokens: 50 },
      turn_token_usage: { output_tokens: 100, reasoning_output_tokens: 50 } }),
    rec(1000, 'event_msg', { type: 'task_complete', turn_id: turn, duration_ms: 1000, time_to_first_token_ms: 200 })];
  await writeFile(join(codexHome, 'sessions', 'synthetic.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const options = { directory: join(root, 'timing'), codexHome };
  async function readReady(c) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const r = await c.read('all');
      if (r.status === 'ready' && r.models.length) return r;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('worker failed to publish reconstructed data');
  }
  let controller = createModelPerformanceController(options);
  try {
    let result = await readReady(controller);
    assert.equal(result.models[0].speed[0].points[0].median, 100);
    assert.equal(result.models[0].ttft[0].median, .2);
    assert.equal(result.models[0].turns, 1);
    await controller.close();
    controller = createModelPerformanceController(options);
    result = await readReady(controller);
    assert.equal(result.models[0].turns, 1);
    assert.ok(!JSON.stringify(result).includes(thread));
  } finally { await controller.close(); }
});
