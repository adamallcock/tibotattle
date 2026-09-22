import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelPerformanceProjection } from '../src/reporting/index.js';
import { createModelPerformanceController } from '../apps/local/model-performance-controller.js';
import { modelPerformanceSupplementDirectory } from '../apps/local/model-performance-worker.js';
import { loadWindowsSourceReadBinding } from '../src/platform/windows-filesystem.js';
import { ensureWindowsSyntheticSourceOwner } from '../scripts/lib/windows-synthetic-source-owner.mjs';

const NOW = Date.parse('2026-09-09T12:00:00Z'), DAY = 86400000;
const row = (patch = {}) => ({ at: NOW, model: 'gpt-5.6-sol', sample_method: 'receipt',
  sample_tokens: 100, sample_duration: 1000, sample_responses: 1, sample_total_responses: 2,
  ttft: 5000, ...patch });
test('Windows supplemental timing store avoids the primary guard ancestors', () => {
  const timingRoot = join('/state', 'inference-timing-v2');
  const directory = join(timingRoot, 'source-0123456789abcdef');
  assert.equal(modelPerformanceSupplementDirectory({ directory, timingRoot, platform: 'win32' }),
    join('/state', 'inference-timing-tool-free-v1', 'source-0123456789abcdef'));
  assert.equal(modelPerformanceSupplementDirectory({ directory, timingRoot, platform: 'darwin' }),
    join(directory, 'tool-free-v1'));
});
test('period coverage is independent and combines compatible speed evidence', () => {
  const rows = [row(), row({ sample_method: 'legacy', sample_tokens: 200 }),
    row({ sample_duration: null }), row({ ttft: null }), row({ at: NOW - 8 * DAY }),
    row({ model: 'unknown-private-model' }), row({ at: NOW + 1 })];
  const result = modelPerformanceProjection(rows, { period: '7', now: NOW });
  const m = result.models[0];
  assert.equal(m.turns, 4); assert.equal(m.speedTurns, 3); assert.equal(m.ttftTurns, 3);
  assert.equal(m.timedResponses, 3); assert.equal(m.speed.length, 1);
  assert.equal(m.speed[0].method, 'speed'); assert.equal(m.speed[0].points[0].median, 100);
  assert.equal(m.speed[0].points[0].n, 3); assert.equal(m.ttft[0].median, 5);
  assert.equal(modelPerformanceProjection(rows, { period: 'all', now: NOW }).models[0].turns, 5);
});
test('all compatible speed observations form one percentile distribution', () => {
  const rows = [100, 200, 300, 400, 500].map((speed, index) => row({
    sample_method: index % 2 ? 'legacy' : 'receipt',
    sample_tokens: speed,
  }));
  const result = modelPerformanceProjection(rows, { period: '7', now: NOW });
  const speed = result.models[0].speed;
  assert.equal(speed.length, 1);
  assert.equal(speed[0].method, 'speed');
  assert.deepEqual(speed[0].points[0], {
    at: Math.floor(NOW / DAY) * DAY,
    n: 5,
    p10: 140,
    p25: 200,
    median: 300,
    p75: 400,
    p90: 460,
  });
});
test('output speed adds tool-free fallback once per turn and computes percentiles from samples', () => {
  const rows = [10, 20, 30, 40, 50].map(tokens => row({
    tool_free_tokens: tokens, tool_free_duration: 2000,
  }));
  rows.push(row({ sample_duration: null, ttft: null, tool_free_tokens: 120, tool_free_duration: 4000 }));
  const model = modelPerformanceProjection(rows, { now: NOW }).models[0];
  assert.equal(model.turns, 6);
  assert.equal(model.speedTurns, 6);
  assert.equal(model.ttftTurns, 5);
  assert.equal(model.toolFreeTurns, 1);
  assert.equal(model.timedResponses, 5);
  assert.deepEqual(model.speed[0].points[0], {
    at: Math.floor(NOW / DAY) * DAY, n: 6,
    p10: 65, p25: 100, median: 100, p75: 100, p90: 100,
  });
  assert.equal(model.speed[0].points[0].median, 100);
  assert.equal(model.ttft[0].median, 5);
  assert.deepEqual(model.toolFree[0], {
    at: Math.floor(NOW / DAY) * DAY, n: 1,
    p10: null, p25: null, median: 30, p75: null, p90: null,
  });
});
test('invalid or missing tool-free evidence does not invent throughput or alter existing speed', () => {
  const rows = [{}, { tool_free_tokens: 10 }, { tool_free_duration: 1000 },
    { tool_free_tokens: 0, tool_free_duration: 1000 },
    { tool_free_tokens: 10, tool_free_duration: 0 },
    { tool_free_tokens: NaN, tool_free_duration: 1000 },
    { tool_free_tokens: 10, tool_free_duration: -1 },
    { tool_free_tokens: 10.5, tool_free_duration: 1000 }].map(patch => row(patch));
  const model = modelPerformanceProjection(rows, { now: NOW }).models[0];
  assert.equal(model.toolFreeTurns, 0);
  assert.deepEqual(model.toolFree, []);
  assert.equal(model.speedTurns, rows.length);
  assert.equal(model.speed[0].points[0].median, 100);
  const fallback = modelPerformanceProjection(rows.map(r => ({ ...r, sample_duration: null })), { now: NOW }).models[0];
  assert.equal(fallback.speedTurns, 0);
  assert.equal(fallback.toolFreeTurns, 0);
  assert.deepEqual(fallback.speed[0].points, []);
  assert.deepEqual(fallback.toolFree, []);
});
test('five percentile summary resists extremes without manufacturing missing bins or sparse bands', () => {
  const rows = [1,2,3,4,100000].map(n => row({ ttft: n * 1000 }));
  rows.push(row({ at: NOW - 2 * DAY, ttft: 0 }));
  const points = modelPerformanceProjection(rows, { now: NOW }).models[0].ttft;
  assert.equal(points.length, 2); assert.equal(points[0].median, 0);
  assert.deepEqual([points[0].p10, points[0].p25, points[0].p75, points[0].p90], [null, null, null, null]);
  assert.equal(points[1].median, 3); assert.equal(points[1].p10, 1.4);
  assert.equal(points[1].p25, 2); assert.equal(points[1].p75, 4); assert.ok(Math.abs(points[1].p90 - 60001.6) < 1e-9);
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
test('history scan progress is explicit and fails closed', () => {
  const historyProgress = { checked: 629, total: 9026 };
  const result = modelPerformanceProjection([], { now: NOW, historyProgress });
  assert.equal(result.schemaVersion, 4);
  assert.equal(result.method, 5);
  assert.equal(result.historyProgress, historyProgress);
  for (const invalid of [
    { checked: 2, total: 1 }, { checked: -1, total: 1 }, { checked: 0.5, total: 1 },
    { checked: 0, total: 1, privatePath: '/synthetic/private' }, {}, [],
  ]) assert.throws(() => modelPerformanceProjection([], { now: NOW, historyProgress: invalid }));
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
class BlockedWorker extends EventEmitter {
  unref() {}
  postMessage(message) {
    if (message.type === 'window') return;
    assert.equal(message.type, 'stop');
    queueMicrotask(() => this.emit('exit', 0));
  }
}
async function waitForSavedSnapshot(file, updatedAt) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const receipt = JSON.parse(await readFile(file, 'utf8'));
      if (receipt.snapshot.values.some(value => value.updatedAt === updatedAt)) return receipt;
    } catch { /* The first atomic receipt may not exist yet. */ }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('complete snapshot was not persisted');
}
async function snapshotFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'model-speed-snapshot-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { directory: join(root, 'timing'), codexHome: join(root, 'codex'), platform: 'darwin' };
  let worker;
  const create = patch => createModelPerformanceController({ ...options,
    workerFactory: () => worker = new BlockedWorker(), ...patch });
  const complete = ['1', '7', '30', 'all'].map(period => modelPerformanceProjection([row()], {
    now: NOW, period, historyProgress: { checked: 1, total: 1 },
  }));
  const initial = create();
  assert.equal((await initial.read('all')).status, 'loading');
  worker.emit('message', { type: 'snapshots', values: complete });
  await initial.close();
  return { root, options, create, complete, worker: () => worker,
    file: join(options.directory, 'model-performance-snapshot.json') };
}
test('saved complete measurements are immediately available after restart with a blocked worker', async t => {
  const fixture = await snapshotFixture(t);
  const controller = fixture.create();
  try {
    for (const period of ['1', '7', '30', 'all']) {
      const result = await controller.read(period);
      assert.equal(result.status, 'ready');
      assert.equal(result.collecting, true);
      assert.equal(result.historyProgress, null, 'saved scan progress is not current progress');
      assert.equal(result.stale, false);
      assert.equal(result.updatedAt, new Date(NOW).toISOString());
      assert.equal(result.models[0].turns, 1);
    }
    const disk = await readFile(fixture.file, 'utf8');
    assert.ok(!disk.includes(fixture.options.codexHome));
    assert.ok(!disk.includes(fixture.options.directory));
  } finally { await controller.close(); }
});
test('combined speed and its fallback subset persist when an additive refresh fails', async t => {
  const fixture = await snapshotFixture(t);
  let controller = fixture.create();
  const latest = modelPerformanceProjection([
    row({ tool_free_tokens: 100, tool_free_duration: 2000 }),
    row({ sample_duration: null, tool_free_tokens: 100, tool_free_duration: 2000 }),
  ], {
    now: NOW + DAY,
  });
  try {
    await controller.read('all');
    fixture.worker().emit('message', { type: 'snapshots', values: [latest] });
    await controller.close();
    controller = fixture.create();
    let result = await controller.read('all');
    assert.equal(result.schemaVersion, 4);
    assert.equal(result.method, 5);
    assert.equal(result.models[0].speedTurns, 2);
    assert.equal(result.models[0].speed[0].points[0].n, 2);
    assert.equal(result.models[0].speed[0].points[0].median, 75);
    assert.equal(result.models[0].toolFree[0].median, 50);
    assert.equal(result.models[0].toolFreeTurns, 1);
    fixture.worker().emit('message', { type: 'snapshots', values: [{
      ...modelPerformanceProjection([row()], { now: NOW + 2 * DAY }), stale: true,
    }] });
    result = await controller.read('all');
    assert.equal(result.stale, true);
    assert.equal(result.updatedAt, latest.updatedAt);
    assert.deepEqual(result.models, latest.models, 'failed supplement cannot replace either completed population');
  } finally { await controller.close(); }
});
test('saved pinned windows restore only their exact period and end independently of live periods', async t => {
  const fixture = await snapshotFixture(t);
  const endAt = new Date(NOW).toISOString(), collectedAt = new Date(NOW + 60_000).toISOString();
  const pinned = { ...modelPerformanceProjection([row(), row()], { period: '1', now: NOW, rolling: true }),
    updatedAt: collectedAt, requestKey: `1:${NOW}` };
  let controller = fixture.create();
  try {
    assert.equal((await controller.read('1', { endAt })).status, 'loading');
    fixture.worker().emit('message', { type: 'snapshots', values: [pinned] });
    assert.equal((await controller.read('1', { endAt })).models[0].turns, 2);
    await controller.close();
    controller = fixture.create();
    const restored = await controller.read('1', { endAt });
    assert.equal(restored.collecting, true);
    assert.equal(restored.end, NOW);
    assert.equal(restored.start, NOW - DAY);
    assert.equal(restored.updatedAt, collectedAt);
    assert.equal(restored.models[0].turns, 2);
    assert.equal(Object.hasOwn(restored, 'requestKey'), false, 'internal cache keys do not change the response DTO');
    assert.equal((await controller.read('1')).models[0].turns, 1);
    const other = await controller.read('1', { endAt: new Date(NOW - 1).toISOString() });
    assert.equal(other.status, 'loading');
    assert.equal(other.end, NOW - 1);
    assert.deepEqual(other.models, []);
    fixture.worker().emit('message', { type: 'snapshots', values: [{ ...pinned, requestKey: `1:${NOW - 1}` }] });
    const rejected = await controller.read('1', { endAt });
    assert.equal(rejected.stale, true);
    assert.equal(rejected.models[0].turns, 2, 'mismatched worker window cannot replace the saved value');
  } finally { await controller.close(); }
});
test('pinned retained cache is bounded to eight exact windows plus four live periods', async t => {
  const fixture = await snapshotFixture(t);
  let controller = fixture.create();
  try {
    for (let index = 0; index < 9; index++) {
      const end = NOW - index * DAY;
      await controller.read('1', { endAt: new Date(end).toISOString() });
      fixture.worker().emit('message', { type: 'snapshots', values: [{
        ...modelPerformanceProjection([row({ at: end })], { period: '1', now: end, rolling: true }),
        updatedAt: new Date(NOW).toISOString(), requestKey: `1:${end}`,
      }] });
    }
    await controller.close();
    const receipt = JSON.parse(await readFile(fixture.file, 'utf8'));
    assert.equal(receipt.schemaVersion, 'local-model-performance-snapshot-v4');
    assert.equal(receipt.snapshot.values.length, 12);
    assert.equal(receipt.snapshot.values.filter(value => Object.hasOwn(value, 'requestKey')).length, 8);
    assert.equal(receipt.snapshot.values.some(value => value.requestKey === `1:${NOW}`), false);
    controller = fixture.create();
    assert.equal((await controller.read('1', { endAt: new Date(NOW - 8 * DAY).toISOString() })).models[0].turns, 1);
    assert.equal((await controller.read('1', { endAt: new Date(NOW).toISOString() })).status, 'loading');
  } finally { await controller.close(); }
});
test('pinned cache receipts reject mismatched keys and rolling bounds even with a valid digest', async t => {
  const fixture = await snapshotFixture(t);
  const endAt = new Date(NOW).toISOString();
  let controller = fixture.create();
  await controller.read('1', { endAt });
  fixture.worker().emit('message', { type: 'snapshots', values: [{
    ...modelPerformanceProjection([row()], { period: '1', now: NOW, rolling: true }), requestKey: `1:${NOW}`,
  }] });
  await controller.close();
  const saved = await readFile(fixture.file, 'utf8');
  for (const change of [
    value => { value.requestKey = `1:${NOW - 1}`; },
    value => { value.start++; },
  ]) {
    const receipt = JSON.parse(saved);
    change(receipt.snapshot.values.find(value => Object.hasOwn(value, 'requestKey')));
    receipt.digest = createHash('sha256').update(JSON.stringify(receipt.snapshot)).digest('hex');
    await writeFile(fixture.file, JSON.stringify(receipt));
    controller = fixture.create();
    try {
      const result = await controller.read('1', { endAt });
      assert.equal(result.status, 'loading');
      assert.equal(result.end, NOW);
      assert.deepEqual(result.models, []);
    } finally { await controller.close(); }
  }
});
test('complete measurements persist immediately, then hourly, and flush the latest value on close', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'model-speed-cadence-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'timing'), file = join(directory, 'model-performance-snapshot.json');
  let now = NOW, worker;
  const options = { directory, codexHome: join(root, 'codex'), platform: 'darwin', snapshotNow: () => now,
    workerFactory: () => worker = new BlockedWorker() };
  let controller = createModelPerformanceController(options);
  const publish = count => worker.emit('message', { type: 'snapshots', values: [
    modelPerformanceProjection(Array.from({ length: count }, () => row()), { now }),
  ] });
  try {
    await controller.read('all');
    publish(1);
    const first = await waitForSavedSnapshot(file, new Date(now).toISOString());
    assert.equal(first.savedAt, new Date(now).toISOString());
    now += 5_000;
    publish(2);
    assert.equal((await controller.read('all')).models[0].turns, 2, 'live results are never throttled');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).snapshot.values[0].models[0].turns, 1);
    now = NOW + 60 * 60 * 1_000;
    publish(3);
    await waitForSavedSnapshot(file, new Date(now).toISOString());
    now += 5_000;
    publish(4);
    await controller.close();
    const closed = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(closed.snapshot.values[0].models[0].turns, 4, 'close flushes the latest completed value');
    assert.equal(closed.savedAt, new Date(now).toISOString());
    controller = createModelPerformanceController(options);
    assert.equal((await controller.read('all')).models[0].turns, 4);
    now += 5_000;
    publish(5);
    assert.equal((await controller.read('all')).models[0].turns, 5);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).snapshot.values[0].models[0].turns, 4,
      'restart preserves the persisted write interval');
  } finally { await controller.close(); }
});
test('rebuilding and failed measurements retain complete results and only complete empty results replace them', async t => {
  const fixture = await snapshotFixture(t);
  let controller = fixture.create();
  try {
    await controller.read('all');
    fixture.worker().emit('message', { type: 'snapshots', values: [
      { ...modelPerformanceProjection([], { now: NOW + DAY }), collecting: true,
        historyProgress: { checked: 0, total: 1 } },
    ] });
    let result = await controller.read('all');
    assert.equal(result.models[0].turns, 1);
    assert.equal(result.updatedAt, new Date(NOW).toISOString());
    assert.equal(result.collecting, true);
    fixture.worker().emit('message', { type: 'snapshots', values: [
      { ...modelPerformanceProjection([], { now: NOW + DAY }), stale: true },
    ] });
    result = await controller.read('all');
    assert.equal(result.models[0].turns, 1);
    assert.equal(result.stale, true);
    fixture.worker().emit('error', new Error('synthetic private error'));
    result = await controller.read('all');
    assert.equal(result.collecting, false);
    assert.equal(result.stale, true);
    await controller.close();
    controller = fixture.create();
    assert.equal((await controller.read('all')).models[0].turns, 1);
    fixture.worker().emit('message', { type: 'snapshots', values: [
      modelPerformanceProjection([], { now: NOW + DAY }),
    ] });
    assert.deepEqual((await controller.read('all')).models, []);
    await controller.close();
    controller = fixture.create();
    result = await controller.read('all');
    assert.equal(result.status, 'ready');
    assert.equal(result.updatedAt, new Date(NOW + DAY).toISOString());
    assert.deepEqual(result.models, []);
  } finally { await controller.close(); }
});
test('old independent-distribution receipts are preserved until combined samples are rebuilt', async t => {
  const fixture = await snapshotFixture(t);
  const envelope = JSON.parse(await readFile(fixture.file, 'utf8'));
  envelope.schemaVersion = 'local-model-performance-snapshot-v3';
  for (const value of envelope.snapshot.values) {
    value.schemaVersion = 3; value.method = 4;
    for (const model of value.models) {
      model.toolFreeTurns = 1;
      model.toolFree = structuredClone(model.speed[0].points);
    }
  }
  envelope.digest = createHash('sha256').update(JSON.stringify(envelope.snapshot)).digest('hex');
  const old = JSON.stringify(envelope);
  await writeFile(fixture.file, old);
  let controller = fixture.create();
  try {
    assert.equal((await controller.read('all')).status, 'loading');
    assert.equal(await readFile(fixture.file, 'utf8'), old, 'read cannot relabel or delete old percentiles');
  } finally { await controller.close(); }
  assert.equal(await readFile(fixture.file, 'utf8'), old, 'close without rebuilt evidence preserves the receipt');
  controller = fixture.create();
  try {
    await controller.read('all');
    fixture.worker().emit('message', { type: 'snapshots', values: fixture.complete });
  } finally { await controller.close(); }
  const rebuilt = JSON.parse(await readFile(fixture.file, 'utf8'));
  assert.equal(rebuilt.schemaVersion, 'local-model-performance-snapshot-v4');
  assert.deepEqual(rebuilt.snapshot.values, fixture.complete);
});
test('source changes, corrupted receipts and incompatible schemas fail closed without waiting for the worker', async t => {
  const fixture = await snapshotFixture(t);
  const saved = await readFile(fixture.file, 'utf8');
  for (const mutation of [
    null,
    () => '{broken',
    value => JSON.stringify({ ...JSON.parse(value), schemaVersion: 'future' }),
    value => JSON.stringify({ ...JSON.parse(value), schemaVersion: 'local-model-performance-snapshot-v2' }),
    value => JSON.stringify({ ...JSON.parse(value), schemaVersion: 'local-model-performance-snapshot-v3' }),
    value => JSON.stringify({ ...JSON.parse(value), digest: '0'.repeat(64) }),
    value => {
      const envelope = JSON.parse(value);
      envelope.snapshot.values[0].method = 4;
      envelope.digest = createHash('sha256').update(JSON.stringify(envelope.snapshot)).digest('hex');
      return JSON.stringify(envelope);
    },
    ...[
      value => {
        value.schemaVersion = 2; value.method = 3;
        for (const model of value.models) { delete model.toolFreeTurns; delete model.toolFree; }
      },
      value => { value.schemaVersion = 3; value.method = 4; },
      value => { value.models[0].toolFreeTurns = value.models[0].turns + 1; },
      value => { value.models[0].speedTurns = 0; },
      value => { value.models[0].ttftTurns = 0; },
      value => { value.models[0].timedResponses = 0; },
      value => { value.models[0].speed = []; },
      value => { value.models[0].toolFreeTurns = 1; },
      value => {
        const model = value.models[0];
        model.toolFreeTurns = 1; model.timedResponses = 0;
        model.toolFree = structuredClone(model.speed[0].points);
        model.toolFree[0].at -= DAY;
      },
      value => { value.models[0].toolFree = value.models[0].speed[0].points; },
      value => { value.models[0].toolFreePrivateText = 'synthetic forbidden content'; },
    ].map(mutate => value => {
      const envelope = JSON.parse(value);
      mutate(envelope.snapshot.values[0]);
      envelope.digest = createHash('sha256').update(JSON.stringify(envelope.snapshot)).digest('hex');
      return JSON.stringify(envelope);
    }),
  ]) {
    if (mutation) await writeFile(fixture.file, mutation(saved));
    const controller = fixture.create(mutation ? {} : { codexHome: join(fixture.root, 'another-source') });
    try {
      const started = Date.now();
      const result = await controller.read('all');
      assert.equal(result.status, 'loading');
      assert.deepEqual(result.models, []);
      assert.ok(Date.now() - started < 500, 'does not wait for a worker response');
    } finally { await controller.close(); }
  }
});
test('late messages after cancellation and invalid worker payloads cannot replace a saved snapshot', async t => {
  const fixture = await snapshotFixture(t);
  let controller = fixture.create();
  await controller.read('all');
  const worker = fixture.worker();
  worker.emit('message', { type: 'snapshots', values: [
    { ...fixture.complete.find(value => value.period === 'all'), privateText: 'synthetic private value' },
  ] });
  assert.equal((await controller.read('all')).stale, true);
  await controller.close();
  worker.emit('message', { type: 'snapshots', values: [modelPerformanceProjection([], { now: NOW + DAY })] });
  controller = fixture.create();
  try { assert.equal((await controller.read('all')).models[0].turns, 1); }
  finally { await controller.close(); }
});
test('an explicitly requested initial history pass finishes after the reader lease expires', async () => {
  class FakeWorker extends EventEmitter {
    unref() {}
    postMessage(message) {
      assert.equal(message.type, 'stop'); stops++;
      queueMicrotask(() => this.emit('exit', 0));
    }
  }
  let worker, stops = 0;
  const controller = createModelPerformanceController({
    directory: 'unused', codexHome: 'unused', platform: 'darwin', idleMs: 10,
    workerFactory: () => worker = new FakeWorker(),
  });
  await controller.read('all');
  const progress = modelPerformanceProjection([row()], {
    now: NOW, historyProgress: { checked: 1, total: 2 },
  });
  worker.emit('message', { type: 'snapshots', values: [{ ...progress, collecting: true }] });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(stops, 0, 'unfinished history survives an expired page lease');
  worker.emit('message', { type: 'snapshots', values: [{ ...progress,
    collecting: false, historyProgress: { checked: 2, total: 2 } }] });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(stops, 1, 'completed worker observes the ordinary idle stop');
  await controller.close();
});
test('missing timing capability returns unavailable with bounded worker retry', async () => {
  let workers = 0;
  const controller = createModelPerformanceController({
    directory: 'unused', codexHome: 'unused',
    workerFactory: () => { workers++; throw new Error('native capability unavailable'); },
  });
  try {
    for (const period of ['7', '30', 'all', 'all']) {
      const result = await controller.read(period);
      assert.deepEqual(Object.keys(result).sort(), [
        'schemaVersion', 'method', 'status', 'collecting', 'stale', 'updatedAt',
        'period', 'interval', 'start', 'end', 'historyProgress', 'models',
      ].sort());
      assert.equal(result.status, 'unavailable');
      assert.equal(result.collecting, false);
      assert.equal(result.stale, false);
      assert.equal(result.period, period);
      assert.equal(result.updatedAt, null);
      assert.deepEqual(result.models, []);
    }
    await assert.rejects(controller.read('90'), /invalid_timing_period/u);
    assert.equal(workers, 1, 'missing capability is attempted once during the backoff');
  } finally { await controller.close(); }
  assert.equal((await controller.read('all')).status, 'unavailable');
  assert.equal(workers, 1, 'missing capability is attempted once during the backoff');
});

test('actual worker persists separate Codex sources and preserves the unscoped legacy sidecar', async t => {
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
  if (process.platform === 'win32') ensureWindowsSyntheticSourceOwner(join(codexHome, 'sessions', 'synthetic.jsonl'));
  const options = { directory: join(root, 'timing'), codexHome };
  await mkdir(options.directory, { mode: 0o700 });
  const legacyFile = join(options.directory, 'timing-experiment.sqlite');
  const legacyBytes = Buffer.from('synthetic legacy sidecar with unknown source provenance');
  await writeFile(legacyFile, legacyBytes, { mode: 0o600 });
  async function readReady(c, expectedModels = 1) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const r = await c.read('all');
      if (expectedModels === 0) assert.deepEqual(r.models, [], 'another source cannot leak during startup');
      if (r.status === 'ready' && !r.collecting && !r.stale && r.models.length === expectedModels) return r;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('worker failed to publish reconstructed data');
  }
  let controller = createModelPerformanceController(options);
  try {
    if (process.platform === 'win32') {
      let unavailable = false;
      try { loadWindowsSourceReadBinding(); } catch { unavailable = true; }
      if (process.env.USAGE_MONITOR_WINDOWS_QUALIFICATION === '1') {
        assert.equal(unavailable, false, 'native Windows qualification requires the exact source-read binding');
      }
      if (unavailable) {
        const deadline = Date.now() + 10000;
        let result;
        do {
          result = await controller.read('all');
          if (result.status === 'unavailable') break;
          await new Promise(resolve => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
        assert.equal(result.status, 'unavailable');
        assert.deepEqual(result.models, []);
        assert.equal(result.historyProgress, null, 'unsupported worker never scans sources');
        return;
      }
    }
    let result = await readReady(controller);
    assert.equal(result.schemaVersion, 4);
    assert.deepEqual(result.historyProgress, { checked: 1, total: 1 });
    assert.equal(result.models[0].speed[0].points[0].median, 100);
    assert.equal(result.models[0].ttft[0].median, .2);
    assert.equal(result.models[0].turns, 1);
    await controller.close();
    controller = createModelPerformanceController(options);
    result = await readReady(controller);
    assert.equal(result.models[0].turns, 1);
    assert.ok(!JSON.stringify(result).includes(thread));
    await controller.close();
    const emptyHome = join(root, 'empty-codex');
    await mkdir(join(emptyHome, 'sessions'), { recursive: true });
    controller = createModelPerformanceController({ ...options, codexHome: emptyHome });
    result = await readReady(controller, 0);
    assert.deepEqual(result.historyProgress, { checked: 0, total: 0 });
    await controller.close();
    controller = createModelPerformanceController(options);
    result = await readReady(controller);
    assert.equal(result.models[0].id, 'gpt-5.6-sol');
    assert.equal(result.models[0].turns, 1, 'switching back preserves the original source sidecar');
    assert.deepEqual(await readFile(legacyFile), legacyBytes, 'unscoped evidence is neither read nor mutated');
  } finally { await controller.close(); }
});

test('explicit reporting windows include exactly the rolling duration and no later samples', () => {
  for (const period of ['1', '7', '30']) {
    const start = NOW - Number(period) * DAY;
    const result = modelPerformanceProjection([row({ at: start - 1 }), row({ at: start }), row(), row({ at: NOW + 1 })], { period, now: NOW, rolling: true });
    assert.equal(result.start, start);
    assert.equal(result.end, NOW);
    assert.equal(result.models[0].turns, 2);
  }
});

test('controller caches each exact reporting window independently and rejects malformed anchors', async () => {
  const messages = [];
  class FakeWorker extends EventEmitter {
    unref() {}
    postMessage(message) { messages.push(message); if (message.type === 'stop') queueMicrotask(() => this.emit('exit', 0)); }
  }
  const worker = new FakeWorker();
  const controller = createModelPerformanceController({ directory: 'unused', codexHome: 'unused', workerFactory: () => worker });
  try {
    const endAt = new Date(NOW).toISOString();
    const prior = new Date(NOW - DAY).toISOString();
    const loading = await controller.read('1', { endAt });
    assert.equal(loading.end, NOW);
    assert.equal(loading.start, NOW - DAY);
    const request = messages.find(message => message.type === 'window');
    worker.emit('message', { type: 'snapshots', values: [{ ...modelPerformanceProjection([row()], { period: '1', now: NOW }), requestKey: request.requestKey }] });
    assert.equal((await controller.read('1', { endAt })).models[0].turns, 1);
    assert.equal((await controller.read('1', { endAt: prior })).status, 'loading');
    assert.equal((await controller.read('1')).status, 'loading');
    await assert.rejects(controller.read('1', { endAt: '2026-09-10' }), /invalid_timing_window/);
    await assert.rejects(controller.read('1', { endAt: new Date(Date.now() + DAY).toISOString() }), /invalid_timing_window/);
  } finally { await controller.close(); }
});
