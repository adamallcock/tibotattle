import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { syntheticD1Binding, closeSyntheticD1Bindings, SYNTHETIC_D1_WORKER } from './d1-storage-local-d1.mjs';
import { labDigest } from './analytics-shard-lab-core.mjs';
import { syntheticLabPlan, seedLabDatabases, measureLabDatabases } from './analytics-shard-lab-runner.mjs';
import { parseOnlineLabArgs, validateOnlineLabPlan, makeLabApi, makeRemoteLabDatabase,
  provisionLabTargets } from './analytics-shard-lab-online.mjs';
import { measureFullLabRead, readWholeLabPartition } from './analytics-shard-lab-full-read.mjs';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function plan() {
  const sources = ['analytics-shard-lab-core.mjs', 'analytics-shard-lab-runner.mjs',
    'analytics-shard-lab-online.mjs', '../src/d1-provider-schema.json'].map(path => ({ path, sha256: 'a'.repeat(64) }));
  return { method: 'analytics-shard-online-plan-v1', environment: 'private-synthetic-shadow',
    accountId: 'b'.repeat(32), runId: id(100), createdAt: '2026-09-30T22:00:00.000Z',
    expiresAt: '2026-10-01T22:00:00.000Z', placement: syntheticLabPlan(), sources,
    targets: Array.from({ length: 5 }, (_, i) => ({ target: i - 1, location: 'enam',
      name: `tibotattle-shard-lab-000000000000-${i ? `s${i - 1}` : 'baseline'}` })) };
}
function fakeProvider({ lost = false, fail = false } = {}) {
  const resources = new Map(); let writes = 0;
  const api = async (suffix, method = 'GET', body) => {
    if (method === 'GET') return [...resources.values()];
    assert.equal(suffix, ''); assert.equal(method, 'POST'); writes++;
    if (fail) throw Error('synthetic-before-create');
    const value = { uuid: id(writes), name: body.name, file_size: 0, read_replication: { mode: 'disabled' } };
    resources.set(value.name, value); if (lost) throw Error('synthetic-response-lost'); return value;
  };
  return { api, resources, writes: () => writes };
}
const initial = p => ({ planSha256: labDigest(p), targets: Array(5).fill(null) });
test('online CLI requires a separate explicit mode and exact plan approval', () => {
  assert.equal(parseOnlineLabArgs(['--mode', 'prepare', '--dir', '/private/tmp/tibotattle-shard-online-test',
    '--rows', '100000', '--account-plan', '/private/tmp/private-plan.json', '--account-plan-sha', 'a'.repeat(64)])['--mode'], 'prepare');
  assert.equal(parseOnlineLabArgs(['--mode', 'status', '--dir', '/private/tmp/tibotattle-shard-online-test',
    '--approve-plan', 'a'.repeat(64)])['--mode'], 'status');
  const durable = fileURLToPath(new URL('../.wrangler/shard-lab/tibotattle-shard-online-test', import.meta.url));
  assert.equal(parseOnlineLabArgs(['--mode', 'status', '--dir', durable,
    '--approve-plan', 'a'.repeat(64)])['--dir'], durable);
  assert.throws(() => parseOnlineLabArgs(['--mode', 'status', '--dir', durable.replace('/shard-lab/', '/other/'),
    '--approve-plan', 'a'.repeat(64)]), /USAGE/);
  for (const args of [[], ['--mode', 'seed', '--dir', '/private/tmp/tibotattle-shard-online-test'],
    ['--mode', 'seed', '--dir', '/private/tmp/tibotattle-shard-online-test', '--approve-plan', 'a'.repeat(64), '--rows', '1'],
    ['--mode', 'seed', '--dir', '/Users/sensitive', '--approve-plan', 'a'.repeat(64)],
    ['--mode', 'seed', '--dir', '/private/tmp/tibotattle-shard-online-test', '--approve-plan', 'a'.repeat(64), '--mode', 'seed']])
    assert.throws(() => parseOnlineLabArgs(args), /USAGE/);
});
test('online plan fixes five new names, source pins, synthetic data and lifetime', () => {
  validateOnlineLabPlan(plan());
  for (const change of [p => p.environment = 'production', p => p.targets[0].name = 'existing-production',
    p => p.targets.pop(), p => p.targets[1].target = -1, p => p.sources[0].sha256 = '',
    p => p.expiresAt = p.createdAt, p => p.placement.dataKind = 'real', p => p.token = 'must-not-be-stored']) {
    const p = plan(); change(p); assert.throws(() => validateOnlineLabPlan(p));
  }
});
test('provision records intent, reconciles a lost create response and never duplicates it', async () => {
  const p = plan(), state = initial(p), provider = fakeProvider({ lost: true });
  const saved = []; let guards = 0;
  const params = { plan: p, state, api: provider.api, save: async s => saved.push(structuredClone(s)), guard: async () => guards++ };
  await provisionLabTargets(params);
  assert.equal(provider.writes(), 5); assert.equal(guards, 5); assert.equal(saved.length, 10);
  assert.equal(saved[0].targets[0].status, 'creating');
  await provisionLabTargets(params); assert.equal(provider.writes(), 5);
});
test('foreign name, resource drift and missing interrupted create stop without a fresh write', async () => {
  const p = plan(), state = initial(p), provider = fakeProvider();
  provider.resources.set(p.targets[0].name, { uuid: id(99), name: p.targets[0].name, file_size: 0 });
  await assert.rejects(provisionLabTargets({ plan: p, state, api: provider.api, save: async () => {}, guard: async () => {} }), /RESOURCE_NAME_EXISTS/);
  assert.equal(provider.writes(), 0);
  provider.resources.clear(); state.targets[0] = { status: 'creating' };
  await assert.rejects(provisionLabTargets({ plan: p, state, api: provider.api, save: async () => {}, guard: async () => {} }), /CREATE_UNCERTAIN/);
  assert.equal(provider.writes(), 0);
});
test('unapplied create retains exact intent, and explicit resume only reconciles', async () => {
  const p = plan(), state = initial(p), provider = fakeProvider({ fail: true });
  const params = { plan: p, state, api: provider.api, save: async () => {}, guard: async () => {} };
  await assert.rejects(provisionLabTargets(params), /CREATE_UNCERTAIN/); assert.equal(provider.writes(), 1);
  await assert.rejects(provisionLabTargets(params), /CREATE_UNCERTAIN/); assert.equal(provider.writes(), 1);
  assert.deepEqual(state.targets[0], { status: 'creating' });
});
test('approval failure stops before create; malformed state fails before any inventory', async () => {
  const p = plan(), provider = fakeProvider();
  await assert.rejects(provisionLabTargets({ plan: p, state: initial(p), api: provider.api, save: async () => {}, guard: async () => { throw Error('synthetic-approval-refused'); } }), /approval-refused/);
  assert.equal(provider.writes(), 0);
  let calls = 0;
  await assert.rejects(provisionLabTargets({ plan: p, state: { ...initial(p), planSha256: 'wrong' }, api: async () => calls++, save: async () => {}, guard: async () => {} }), /STATE_DRIFT/);
  assert.equal(calls, 0);
});
test('API fixes the D1 origin and redacts provider refusal; no transport retry', async () => {
  let calls = 0;
  const api = makeLabApi({ accountId: 'b'.repeat(32), token: 'synthetic-test-token', fetchImpl: async (url, opts) => {
    calls++; assert(url.startsWith('https://api.cloudflare.com/client/v4/accounts/'));
    assert.equal(opts.redirect, 'error');
    return new Response(JSON.stringify({ success: false, errors: [{ message: 'sensitive-provider-fixture' }] }), { status: 403 });
  } });
  await assert.rejects(api('', 'POST', {}), error => !error.message.includes('sensitive-provider-fixture') && error.code === 'SHARD_LAB_API_REFUSED');
  assert.equal(calls, 1);
  for (const suffix of ['/../production', '/not-a-uuid/query', 'https://other.example']) await assert.rejects(api(suffix), /API_ROUTE_INVALID/);
  assert.equal(calls, 1);
});
test('remote adapter preserves native parameterized batches and fences every call', async () => {
  const requests = [], guards = [];
  const db = makeRemoteLabDatabase(async (...args) => { requests.push(args); return args[2].batch.map(() => ({ success: true, results: [{ n: 0 }], meta: {} })); }, id(1), async write => guards.push(write));
  await db.batch([db.prepare('INSERT INTO shard_lab_guard VALUES(?)').bind(1), db.prepare('DELETE FROM shard_lab_guard')]);
  assert.deepEqual(requests[0][2].batch.map(s => s.params), [[1], []]); assert.deepEqual(guards, [true]);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM shard_lab_guard').first()).n, 0);
  assert.deepEqual(guards, [true, false]);
  await assert.rejects(db.prepare('SELECT * FROM real_application').all(), /STATEMENT_INVALID/);
  await assert.rejects(db.prepare('SELECT * FROM shard_lab_records WHERE id=?').bind(Infinity).all(), /STATEMENT_INVALID/);
  assert.equal(requests.length, 2);
});
test('one-versus-four native runner seals both layouts and measures parity at 1/2/4', async t => {
  const runtimes = Array.from({ length: 5 }, (_, i) => new Miniflare({ host: '127.0.0.1', cf: false, modules: true,
    script: SYNTHETIC_D1_WORKER, compatibilityDate: '2026-07-26', d1Databases: { TARGET: `synthetic-shard-runner-${i}` } }));
  t.after(async () => { for (const mf of runtimes) { await closeSyntheticD1Bindings(mf); await mf.dispose(); } });
  const databases = runtimes.map(mf => syntheticD1Binding(mf, 'TARGET')), p = syntheticLabPlan(1_000);
  const seed = await seedLabDatabases(databases, p);
  assert.equal(seed.baseline.records, 1_000); assert.equal(seed.shards.reduce((n, v) => n + v.records, 0), 1_000);
  const measured = await measureLabDatabases(databases, p, 1);
  assert.equal(measured.summary.length, 6); assert(measured.summary.every(r => r.parity));
  assert(measured.results.every(r => r.rowsWritten === 0));
  const whole = await measureFullLabRead(databases, p, 1);
  assert.equal(whole.summary.length, 3); assert(whole.summary.every(r => r.parity));
  assert(whole.results.every(r => r.records === p.totalRows));
  const resume = await seedLabDatabases(databases, p); assert.equal(resume.baseline.measurementComplete, false);
});
test('whole-history read refuses an oversized or malformed partition before querying', async () => {
  const db = { prepare() { assert.fail('unsafe range must not reach SQL'); } };
  for (const segments of [[], [{ group: 1, from: 1, through: 3_000_001 }],
    [{ group: 1, from: 1, through: 1 }, { group: 1, from: 2, through: 2 }]])
    await assert.rejects(readWholeLabPartition(db, segments), /RANGE/);
});
