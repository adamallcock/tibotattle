import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FENCE_GRAPHQL_QUERIES, FENCE_GRAPHQL_QUERY_SHA256, FENCE_REQUEST_BUDGETS, parseCloudflareWriterFenceArguments,
  readCloudflareWriterFenceReceipt, runCloudflareWriterFence, validateCloudflareWriterFencePlan,
} from './cloudflare-writer-fence.mjs';
import { createMaintenanceTransport } from './production-maintenance-transport.mjs';

const ACCOUNT = 'c'.repeat(32);
const TOKEN = 'synthetic-fence-token-not-a-credential';
const D1 = {
  ingestion: '11111111-1111-4111-8111-111111111111',
  analytics: '22222222-2222-4222-8222-222222222222',
  ledger: '33333333-3333-4333-8333-333333333333',
  control: '44444444-4444-4444-8444-444444444444',
  guard: '55555555-5555-4555-8555-555555555555',
  legacy: '66666666-6666-4666-8666-666666666666',
};
const BUCKET = 'synthetic-quarantine';
const QUEUE = 'd'.repeat(32);
const OTHER_QUEUE = 'e'.repeat(32);
const COMMIT = 'f'.repeat(40);
const T0 = Date.parse('2026-09-26T10:00:00.000Z');
const MINUTE = 60_000;
const CRONS = {
  'synthetic-analytics': ['* * * * *'],
  'synthetic-publication': ['*/5 * * * *'],
  'synthetic-cache-retention': ['17 * * * *'],
  'synthetic-graph-day': ['*/10 * * * *', '3 4 * * *'],
};
const CRON_SCRIPTS = Object.keys(CRONS);
const R2_KEYS = ['telemetry/synthetic-object-one', 'synthetic/synthetic-object-two'];
const SCRIPT_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));
const scriptOf = href => new URL(href).pathname.split('/')[7];

function planInput(overrides = {}) {
  return {
    schema: 'cloudflare-writer-fence-plan-v1',
    accountId: ACCOUNT,
    productionWorker: 'synthetic-production',
    fencedScripts: [
      ...CRON_SCRIPTS.map(name => ({ name, kind: 'cron', expectedCrons: [...CRONS[name]] })),
      { name: 'synthetic-catchup', kind: 'queue-consumer', expectedCrons: [], queueId: QUEUE },
    ],
    dataResources: [
      { kind: 'd1', label: 'ingestion', id: D1.ingestion },
      { kind: 'd1', label: 'analytics', id: D1.analytics },
      { kind: 'd1', label: 'deletion-ledger', id: D1.ledger },
      { kind: 'd1', label: 'catchup-control', id: D1.control },
      { kind: 'r2', bucket: BUCKET },
    ],
    outOfScopeScripts: [{ name: 'synthetic-guard', reason: 'Separate synthetic release guard with its own storage.' }],
    quietWindowMinutes: 15,
    ...overrides,
  };
}

const d1 = (name, id) => ({ type: 'd1', name, id });
const r2 = (name, bucket) => ({ type: 'r2_bucket', name, bucket_name: bucket });
const text = (name, value) => ({ type: 'plain_text', name, text: value });
const productionBindings = mode => [
  d1('USAGE_MONITOR_DB', D1.ingestion), d1('ANALYTICS_DB', D1.analytics), d1('DELETION_LEDGER', D1.ledger),
  r2('QUARANTINE', BUCKET), r2('SPARKLE_RELEASES', 'synthetic-releases'), { type: 'assets', name: 'ASSETS' },
  { type: 'secret_text', name: 'SYNTHETIC_SECRET' }, text('DEPLOYMENT_SOURCE_COMMIT', COMMIT),
  ...(mode === null ? [] : [text('EDGE_UPSTREAM_MODE', mode)]),
];
const analyticsBindings = () => [
  d1('STORAGE_INGESTION_DB', D1.ingestion), d1('STORAGE_ANALYTICS_DB', D1.analytics), d1('DELETION_LEDGER', D1.ledger),
  text('STORAGE_ANALYTICS_MODE', 'enabled'),
];

function createWorld() {
  let counter = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  const world = {
    now: T0 - 60 * MINUTE,
    scripts: new Map(),
    versions: new Map(),
    queues: new Map(),
    writes: new Map(Object.values(D1).map(id => [id, []])),
    objects: R2_KEYS.map(key => ({ key, size: 12, etag: 'a'.repeat(32), storage_class: 'Standard',
      http_metadata: { contentType: 'application/octet-stream' }, custom_metadata: {} })),
    r2Endless: false,
    analytics: { d1: [], invocations: [] },
    failPutNumber: null,
    calls: [],
  };
  world.deploy = (name, versions, crons) => {
    const existing = world.scripts.get(name);
    const entries = versions.map(([bindings, percentage]) => {
      const id = uuid();
      world.versions.set(id, bindings);
      return { version_id: id, percentage };
    });
    const script = existing ?? { deployments: [], crons: crons ?? [], settings: [] };
    script.deployments.unshift({ id: uuid(), created_on: new Date(world.now).toISOString(), source: 'api', strategy: 'percentage', versions: entries });
    script.settings = versions.at(-1)[0];
    if (crons !== undefined) script.crons = [...crons];
    world.scripts.set(name, script);
  };
  world.deployProduction = mode => world.deploy('synthetic-production', [[productionBindings(mode), 100]], ['* * * * *']);
  world.deployProduction('worker');
  for (const name of CRON_SCRIPTS) world.deploy(name, [[analyticsBindings(), 100]], CRONS[name]);
  world.deploy('synthetic-catchup', [[[...analyticsBindings(), d1('STORAGE_ANALYTICS_CATCHUP_CONTROL_DB', D1.control),
    { type: 'queue', name: 'STORAGE_ANALYTICS_CATCHUP_QUEUE', queue_name: 'synthetic-catchup-queue' }], 100]], []);
  world.deploy('synthetic-guard', [[[d1('USAGE_MONITOR_DB', D1.guard), r2('SPARKLE_RELEASES', 'synthetic-guard-releases')], 100]], []);
  world.deploy('synthetic-unrelated', [[[text('SYNTHETIC_MODE', 'on')], 100]], ['0 0 * * *']);
  world.queues.set(QUEUE, { queue_id: QUEUE, queue_name: 'synthetic-catchup-queue',
    consumers: [{ consumer_id: 'synthetic-consumer', type: 'worker', script: 'synthetic-catchup', settings: { batch_size: 1 } }],
    producers: [{ type: 'worker', script: 'synthetic-catchup' }],
    settings: { delivery_delay: 0, delivery_paused: false, message_retention_period: 345600 } });
  world.queues.set(OTHER_QUEUE, { queue_id: OTHER_QUEUE, queue_name: 'synthetic-other-queue', consumers: [], producers: [],
    settings: { delivery_delay: 0, delivery_paused: false, message_retention_period: 345600 } });
  world.write = (id, atMs = world.now) => world.writes.get(id).push(atMs);
  const bookmarkAt = (id, atMs) => `00000001-${id.slice(0, 8)}-${String(world.writes.get(id).filter(time => time <= atMs).length).padStart(8, '0')}`;
  const ok = result => Response.json({ success: true, errors: [], messages: [], result });
  let putNumber = 0;
  world.fetcher = async (url, init = {}) => {
    const href = url instanceof URL ? url.href : String(url);
    const method = init.method ?? 'GET';
    world.calls.push({ href, method, body: init.body ?? null });
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
    const parsed = new URL(href);
    assert.equal(parsed.origin, 'https://api.cloudflare.com');
    if (parsed.pathname === '/client/v4/graphql') {
      assert.equal(method, 'POST');
      const { query, variables } = JSON.parse(init.body);
      assert.equal(variables.accountTag, ACCOUNT);
      if (query === FENCE_GRAPHQL_QUERIES.d1Writes) {
        return Response.json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: world.analytics.d1 }] } }, errors: null });
      }
      if (query === FENCE_GRAPHQL_QUERIES.invocations) {
        return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: world.analytics.invocations }] } }, errors: null });
      }
      return Response.json({ data: null, errors: [{ message: 'unknown query' }] });
    }
    const prefix = `/client/v4/accounts/${ACCOUNT}/`;
    assert.ok(parsed.pathname.startsWith(prefix), parsed.pathname);
    const parts = parsed.pathname.slice(prefix.length).split('/');
    if (parts[0] === 'workers' && parts[1] === 'scripts' && parts.length === 2) {
      return ok([...world.scripts.keys()].map(id => ({ id })));
    }
    if (parts[0] === 'workers' && parts[1] === 'scripts') {
      const script = world.scripts.get(parts[2]);
      if (!script) return Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
      if (parts[3] === 'deployments') return ok({ deployments: script.deployments });
      if (parts[3] === 'versions') return ok({ id: parts[4], resources: { bindings: world.versions.get(parts[4]) } });
      if (parts[3] === 'settings') return ok({ bindings: script.settings });
      if (parts[3] === 'schedules') {
        if (method === 'PUT') {
          putNumber += 1;
          if (putNumber === world.failPutNumber) throw new TypeError('synthetic network failure');
          script.crons = JSON.parse(init.body).map(item => item.cron);
        }
        return ok({ schedules: script.crons.map(cron => ({ cron, created_on: 'x', modified_on: 'x' })) });
      }
    }
    if (parts[0] === 'queues' && parts.length === 1) return ok([...world.queues.values()].map(({ queue_id, queue_name }) => ({ queue_id, queue_name })));
    if (parts[0] === 'queues' && parts.length === 2) {
      const queue = world.queues.get(parts[1]);
      if (method === 'PATCH') {
        const body = JSON.parse(init.body);
        assert.deepEqual(Object.keys(body).sort(), ['queue_name', 'settings']);
        assert.equal(body.queue_name, queue.queue_name);
        assert.deepEqual(Object.keys(body.settings), ['delivery_paused']);
        queue.settings = { ...queue.settings, ...body.settings };
      }
      return ok(queue);
    }
    if (parts[0] === 'd1' && parts[1] === 'database' && parts[3] === 'time_travel' && parts[4] === 'bookmark') {
      assert.equal(method, 'GET');
      const at = parsed.searchParams.get('timestamp');
      return ok({ bookmark: bookmarkAt(parts[2], at === null ? world.now : Date.parse(at)) });
    }
    if (parts[0] === 'r2' && parts[1] === 'buckets' && parts[3] === 'objects') {
      assert.equal(parts[2], BUCKET);
      if (world.r2Endless) {
        const page = Number(parsed.searchParams.get('cursor') ?? 0) + 1;
        return Response.json({ success: true, result: [{ ...world.objects[0], key: `synthetic/endless-${page}` }],
          result_info: { is_truncated: true, cursor: String(page) } });
      }
      return Response.json({ success: true, result: world.objects, result_info: { is_truncated: false } });
    }
    throw new Error(`unexpected ${method} ${parsed.pathname}`);
  };
  return world;
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'writer-fence-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'wrangler', 'wrangler-dist'), { recursive: true });
  await writeFile(join(root, 'wrangler', 'package.json'), JSON.stringify({ name: 'wrangler', version: '4.114.0', main: 'wrangler-dist/cli.js' }));
  const cliPath = join(root, 'wrangler', 'wrangler-dist', 'cli.js');
  await writeFile(cliPath, '// synthetic pinned executable, never spawned by the fence\n');
  const receipts = join(root, 'receipts');
  await mkdir(receipts, { mode: 0o700 });
  const world = createWorld();
  const run = (subcommand, extra = {}) => runCloudflareWriterFence({
    subcommand, plan: planInput(), receiptsDirectory: receipts, cliPath, fetcher: world.fetcher,
    environment: { PATH: '/usr/bin', HOME: root, CLOUDFLARE_API_TOKEN: TOKEN }, now: () => world.now, ...extra,
  });
  const mutations = () => world.calls.filter(call => call.method !== 'GET' && !call.href.endsWith('/graphql'));
  return { root, receipts, world, run, mutations, cliPath };
}

// Plan in worker mode, fenced deploy (the drain runs after it), then apply at T0.
async function applied(f) {
  const planned = await f.run('plan');
  f.world.now = T0 - 20 * MINUTE;
  f.world.deployProduction('fenced');
  f.world.now = T0;
  const apply = await f.run('apply', { confirm: planned.sha256, analyticsDrainComplete: true });
  return { planned, apply };
}

test('inventory is read-only and its 0600 receipt holds names, binding types, id digests and crons', async t => {
  const f = await fixture(t);
  const result = await f.run('inventory');
  assert.equal(f.mutations().length, 0);
  assert.ok(f.world.calls.every(call => call.method === 'GET'));
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  const receipt = JSON.parse(await readFile(result.path, 'utf8'));
  assert.equal(receipt.schema, 'cloudflare-writer-fence-inventory-v1');
  assert.equal(receipt.productionWorker.mode, 'worker');
  assert.equal(receipt.unlistedScripts, 1);
  assert.deepEqual(receipt.fencedScripts.map(item => [item.name, item.crons]),
    [['synthetic-analytics', ['* * * * *']], ['synthetic-cache-retention', ['17 * * * *']], ['synthetic-catchup', []],
      ['synthetic-graph-day', ['*/10 * * * *', '3 4 * * *']], ['synthetic-publication', ['*/5 * * * *']]]);
  const catchup = receipt.fencedScripts.find(item => item.name === 'synthetic-catchup');
  assert.equal(catchup.deliveryPaused, false);
  assert.ok(catchup.bindings.some(item => item.type === 'd1' && item.name === 'STORAGE_ANALYTICS_CATCHUP_CONTROL_DB' && /^[a-f0-9]{64}$/.test(item.ref)));
  assert.deepEqual(receipt.dataResources.find(item => item.label === 'catchup-control').boundBy, ['synthetic-catchup']);
  const bytes = await readFile(result.path, 'utf8');
  for (const secret of [TOKEN, ACCOUNT, BUCKET, QUEUE, ...Object.values(D1), ...R2_KEYS, 'enabled']) assert.equal(bytes.includes(secret), false, secret);
});

test('inventory raises WRITER_UNACCOUNTED for any script outside the fence that binds a listed resource', async t => {
  const f = await fixture(t);
  f.world.deploy('synthetic-rogue', [[[d1('SOME_DB', D1.analytics)], 100]], []);
  await assert.rejects(f.run('inventory'), { code: 'WRITER_UNACCOUNTED' });
  const g = await fixture(t);
  // Declaring a script out of scope does not excuse a binding to fenced storage.
  g.world.deploy('synthetic-guard', [[[d1('USAGE_MONITOR_DB', D1.guard), r2('QUARANTINE', BUCKET)], 100]]);
  await assert.rejects(g.run('plan'), { code: 'WRITER_UNACCOUNTED' });
  const h = await fixture(t);
  // A split deployment still counts every version's bindings.
  h.world.deploy('synthetic-unrelated', [[[text('SYNTHETIC_MODE', 'on')], 90], [[d1('LATE_DB', D1.ledger)], 10]]);
  await assert.rejects(h.run('inventory'), { code: 'WRITER_UNACCOUNTED' });
  for (const each of [f, g, h]) assert.equal(each.mutations().length, 0);
});

test('inventory raises SCHEDULE_DRIFT on any fenced cron mismatch, including a cron on the consumer', async t => {
  const f = await fixture(t);
  f.world.scripts.get('synthetic-graph-day').crons = ['*/10 * * * *'];
  await assert.rejects(f.run('inventory'), { code: 'SCHEDULE_DRIFT' });
  const g = await fixture(t);
  g.world.scripts.get('synthetic-catchup').crons = ['* * * * *'];
  await assert.rejects(g.run('plan'), { code: 'SCHEDULE_DRIFT' });
});

test('labels must be the live bindings; fenced scripts may bind only listed storage; consumers must match', async t => {
  const f = await fixture(t);
  // The unbound legacy D1 can never be named as the ingestion source.
  const legacy = planInput();
  legacy.dataResources[0] = { kind: 'd1', label: 'ingestion', id: D1.legacy };
  await assert.rejects(f.run('inventory', { plan: legacy }), { code: 'FENCE_RESOURCE_LABEL_MISMATCH' });
  const swapped = planInput();
  swapped.dataResources[0] = { kind: 'd1', label: 'ingestion', id: D1.analytics };
  swapped.dataResources[1] = { kind: 'd1', label: 'analytics', id: D1.ingestion };
  await assert.rejects(f.run('inventory', { plan: swapped }), { code: 'FENCE_RESOURCE_LABEL_MISMATCH' });
  const g = await fixture(t);
  g.world.deploy('synthetic-publication', [[[...analyticsBindings(), d1('EXTRA_DB', D1.legacy)], 100]]);
  await assert.rejects(g.run('inventory'), { code: 'FENCE_RESOURCE_UNLISTED' });
  const h = await fixture(t);
  h.world.queues.get(OTHER_QUEUE).consumers = [{ type: 'worker', script: 'synthetic-analytics' }];
  await assert.rejects(h.run('inventory'), { code: 'CONSUMER_DRIFT' });
  const i = await fixture(t);
  i.world.queues.get(QUEUE).consumers = [];
  await assert.rejects(i.run('inventory'), { code: 'CONSUMER_DRIFT' });
  const j = await fixture(t);
  j.world.deploy('synthetic-production', [[productionBindings('worker'), 50], [productionBindings('worker'), 50]]);
  await assert.rejects(j.run('plan'), { code: 'PRODUCTION_DEPLOYMENT_AMBIGUOUS' });
});

test('plan and every unconfirmed apply make zero mutations', async t => {
  const f = await fixture(t);
  const planned = await f.run('plan');
  assert.equal(planned.receipt.remoteWrites, false);
  assert.deepEqual(planned.receipt.mutations.map(item => item.action),
    ['clear-schedules', 'clear-schedules', 'pause-delivery', 'clear-schedules', 'clear-schedules']);
  f.world.now = T0;
  f.world.deployProduction('fenced');
  const before = f.world.calls.length;
  await assert.rejects(f.run('apply', { analyticsDrainComplete: true }), { code: 'FENCE_CONFIRMATION_REQUIRED' });
  await assert.rejects(f.run('apply', { confirm: '0'.repeat(64), analyticsDrainComplete: true }), { code: 'FENCE_CONFIRMATION_MISMATCH' });
  await assert.rejects(f.run('apply', { confirm: 'not-a-sha', analyticsDrainComplete: true }), { code: 'FENCE_CONFIRMATION_MISMATCH' });
  await assert.rejects(f.run('apply', { confirm: planned.sha256 }), { code: 'FENCE_DRAIN_UNATTESTED' });
  assert.equal(f.world.calls.length, before, 'refusals before any provider request');
  // A plan receipt for a different owner plan cannot be confirmed.
  await assert.rejects(f.run('apply', { plan: planInput({ quietWindowMinutes: 20 }), confirm: planned.sha256, analyticsDrainComplete: true }),
    { code: 'FENCE_PLAN_RECEIPT_MISMATCH' });
  // Production must already be fenced before any writer is unscheduled.
  f.world.deployProduction('worker');
  await assert.rejects(f.run('apply', { confirm: planned.sha256, analyticsDrainComplete: true }), { code: 'PRODUCTION_WORKER_NOT_FENCED' });
  f.world.deployProduction('fenced');
  // Any drift of the fenced surface since the plan refuses.
  f.world.deploy('synthetic-analytics', [[[...analyticsBindings(), text('STORAGE_ANALYTICS_EXTRA', 'x')], 100]]);
  await assert.rejects(f.run('apply', { confirm: planned.sha256, analyticsDrainComplete: true }), { code: 'FENCE_INVENTORY_CHANGED' });
  assert.equal(f.mutations().length, 0);
  assert.deepEqual((await readdir(f.receipts)).filter(name => name.startsWith('apply')), []);
});

test('confirmed apply issues exactly one PUT [] per cron script and one pause per consumer and records the prior state', async t => {
  const f = await fixture(t);
  const { planned, apply } = await applied(f);
  const puts = f.mutations().filter(call => call.method === 'PUT');
  const patches = f.mutations().filter(call => call.method === 'PATCH');
  assert.equal(f.mutations().length, CRON_SCRIPTS.length + 1);
  assert.deepEqual(puts.map(call => scriptOf(call.href)).sort(), [...CRON_SCRIPTS].sort());
  assert.ok(puts.every(call => call.body === '[]'));
  assert.equal(patches.length, 1);
  assert.deepEqual(JSON.parse(patches[0].body), { queue_name: 'synthetic-catchup-queue', settings: { delivery_paused: true } });
  for (const name of CRON_SCRIPTS) assert.deepEqual(f.world.scripts.get(name).crons, []);
  assert.equal(f.world.queues.get(QUEUE).settings.delivery_paused, true);
  const receipt = apply.receipt;
  assert.equal(receipt.planReceiptSha256, planned.sha256);
  assert.equal(receipt.appliedAtMs, T0);
  assert.equal(receipt.analyticsDrainAttested, true);
  assert.equal(receipt.productionWorker.mode, 'fenced');
  assert.deepEqual(Object.fromEntries(receipt.priorState.filter(item => item.action === 'clear-schedules').map(item => [item.script, item.before.crons])), CRONS);
  assert.deepEqual(receipt.priorState.find(item => item.action === 'pause-delivery').before, { deliveryPaused: false });
  assert.equal((await stat(apply.path)).mode & 0o777, 0o600);
  await assert.rejects(f.run('apply', { confirm: planned.sha256, analyticsDrainComplete: true }), { code: 'FENCE_ALREADY_APPLIED' });
  assert.equal(f.mutations().length, CRON_SCRIPTS.length + 1);
});

test('an interrupted apply resumes from its journal and never re-issues a completed write', async t => {
  const f = await fixture(t);
  const planned = await f.run('plan');
  f.world.deployProduction('fenced');
  f.world.now = T0;
  f.world.failPutNumber = 2;
  await assert.rejects(f.run('apply', { confirm: planned.sha256, analyticsDrainComplete: true }), { code: 'PRODUCTION_MAINTENANCE_MUTATION_UNCERTAIN' });
  assert.ok((await readdir(f.receipts)).includes(`apply-intent-${planned.sha256}.json`));
  f.world.failPutNumber = null;
  f.world.now = T0 + MINUTE;
  const apply = await f.run('apply', { confirm: planned.sha256, analyticsDrainComplete: true });
  assert.equal(apply.receipt.mutationsIssued, CRON_SCRIPTS.length);
  assert.equal(apply.receipt.startedAtMs, T0);
  assert.equal(apply.receipt.appliedAtMs, T0 + MINUTE);
  // 2 attempted in the first run (1 landed, 1 failed), 3 + 1 pause in the resume.
  assert.equal(f.mutations().filter(call => call.method === 'PUT').length, CRON_SCRIPTS.length + 1);
  assert.equal(f.mutations().filter(call => call.method === 'PATCH').length, 1);
});

test('verify pins bookmarks and the R2 digest after a quiet window, tolerating writes inside that window', async t => {
  const f = await fixture(t);
  const { planned, apply } = await applied(f);
  f.world.write(D1.analytics, T0 + 5 * MINUTE); // in-flight pass finishing inside the quiet window
  f.world.now = T0 + 20 * MINUTE;
  await assert.rejects(f.run('verify', { fence: planned.sha256 }), { code: 'FENCE_WINDOW_TOO_SHORT' });
  f.world.now = T0 + 31 * MINUTE;
  await assert.rejects(f.run('verify', { fence: planned.sha256, windowStart: new Date(T0 + 14 * MINUTE).toISOString() }), { code: 'FENCE_WINDOW_TOO_EARLY' });
  const before = f.world.calls.length;
  const verified = await f.run('verify', { fence: planned.sha256 });
  assert.ok(f.world.calls.slice(before).every(call => call.method === 'GET' || call.href.endsWith('/graphql')));
  assert.equal(f.mutations().length, CRON_SCRIPTS.length + 1);
  const receipt = verified.receipt;
  assert.equal(receipt.applyReceiptSha256, apply.sha256);
  assert.deepEqual(receipt.window, { appliedAt: new Date(T0).toISOString(), quietWindowMinutes: 15,
    start: new Date(T0 + 15 * MINUTE).toISOString(), end: new Date(T0 + 31 * MINUTE).toISOString() });
  assert.deepEqual(receipt.d1.map(item => item.label), ['ingestion', 'analytics', 'deletion-ledger', 'catchup-control']);
  assert.equal(receipt.d1.find(item => item.label === 'analytics').bookmark, `00000001-${D1.analytics.slice(0, 8)}-00000001`);
  assert.equal(receipt.r2.inventorySha256, apply.receipt.r2Baseline.inventorySha256);
  assert.equal(receipt.r2.objects, 2);
  assert.equal(receipt.productionWorker.sourceCommit, COMMIT);
  assert.deepEqual(receipt.analytics.querySha256, FENCE_GRAPHQL_QUERY_SHA256);
  assert.equal(receipt.analytics.fencedScriptInvocations, 0);
  assert.equal((await stat(verified.path)).mode & 0o777, 0o600);
  assert.deepEqual(await readCloudflareWriterFenceReceipt(verified.path, verified.sha256), receipt);
  await assert.rejects(readCloudflareWriterFenceReceipt(verified.path, apply.sha256), { code: 'FENCE_RECEIPT_INVALID' });
  const posted = f.world.calls.filter(call => call.href.endsWith('/graphql')).map(call => JSON.parse(call.body));
  assert.deepEqual(posted.map(item => item.query), [FENCE_GRAPHQL_QUERIES.d1Writes, FENCE_GRAPHQL_QUERIES.invocations]);
  assert.deepEqual(posted[1].variables.scriptNames, planInput().fencedScripts.map(item => item.name).sort());
});

test('verify fails FENCE_NOT_QUIESCENT on a bookmark, digest, rowsWritten or invocation change', async t => {
  const cases = {
    bookmark: world => world.write(D1.control, T0 + 20 * MINUTE),
    digest: world => world.objects.push({ ...world.objects[0], key: 'telemetry/synthetic-late-object' }),
    rowsWritten: world => { world.analytics.d1 = [{ sum: { rowsWritten: 3, writeQueries: 1 }, dimensions: { databaseId: D1.ledger } }]; },
    writeQueries: world => { world.analytics.d1 = [{ sum: { rowsWritten: 0, writeQueries: 2 }, dimensions: { databaseId: D1.ingestion } }]; },
    invocation: world => { world.analytics.invocations = [{ sum: { requests: 1 }, dimensions: { scriptName: 'synthetic-catchup' } }]; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const f = await fixture(t);
    const { planned } = await applied(f);
    f.world.now = T0 + 30 * MINUTE;
    change(f.world);
    await assert.rejects(f.run('verify', { fence: planned.sha256 }), { code: 'FENCE_NOT_QUIESCENT' }, name);
    assert.deepEqual((await readdir(f.receipts)).filter(file => file.startsWith('fence-')), [], name);
  }
  // Analytics outside the pinned shape is refused, never read as zero.
  const f = await fixture(t);
  const { planned } = await applied(f);
  f.world.now = T0 + 30 * MINUTE;
  f.world.analytics.d1 = [{ sum: { rowsWritten: 0, writeQueries: 0 }, dimensions: { databaseId: D1.legacy } }];
  await assert.rejects(f.run('verify', { fence: planned.sha256 }), { code: 'FENCE_ANALYTICS_INVALID' });
});

test('verify fails PRODUCTION_WORKER_NOT_FENCED on a mode mismatch, a split deployment or an unfenced interlude', async t => {
  const cases = {
    worker: world => world.deployProduction('worker'),
    absent: world => world.deployProduction(null),
    split: world => world.deploy('synthetic-production', [[productionBindings('fenced'), 50], [productionBindings('fenced'), 50]]),
    interlude: world => { world.deployProduction('worker'); world.now += MINUTE; world.deployProduction('fenced'); },
  };
  for (const [name, change] of Object.entries(cases)) {
    const f = await fixture(t);
    const { planned } = await applied(f);
    f.world.now = T0 + 10 * MINUTE;
    change(f.world);
    f.world.now = T0 + 30 * MINUTE;
    await assert.rejects(f.run('verify', { fence: planned.sha256 }), { code: 'PRODUCTION_WORKER_NOT_FENCED' }, name);
  }
  const f = await fixture(t);
  const { planned } = await applied(f);
  f.world.scripts.get('synthetic-publication').crons = ['*/5 * * * *'];
  f.world.now = T0 + 30 * MINUTE;
  await assert.rejects(f.run('verify', { fence: planned.sha256 }), { code: 'FENCE_NOT_APPLIED' });
});

test('release refuses without --pre-gcp or after any gcp version, and otherwise restores the exact prior state', async t => {
  const f = await fixture(t);
  const { planned } = await applied(f);
  const before = f.world.calls.length;
  await assert.rejects(f.run('release', { confirm: planned.sha256 }), { code: 'FENCE_RELEASE_REQUIRES_PRE_GCP' });
  await assert.rejects(f.run('release', { preGcp: true }), { code: 'FENCE_CONFIRMATION_REQUIRED' });
  assert.equal(f.world.calls.length, before);
  // gcp then the brake back to fenced: history since the fence still holds gcp.
  f.world.now = T0 + 40 * MINUTE;
  f.world.deployProduction('gcp');
  f.world.now = T0 + 50 * MINUTE;
  f.world.deployProduction('fenced');
  await assert.rejects(f.run('release', { confirm: planned.sha256, preGcp: true }), { code: 'FENCE_RELEASE_AFTER_GCP' });
  const g = await fixture(t);
  const second = await applied(g);
  g.world.now = T0 + 40 * MINUTE;
  g.world.deploy('synthetic-production', [[productionBindings('fenced'), 90], [productionBindings('gcp'), 10]]);
  await assert.rejects(g.run('release', { confirm: second.planned.sha256, preGcp: true }), { code: 'FENCE_RELEASE_AFTER_GCP' });
  const k = await fixture(t);
  const unknown = await applied(k);
  k.world.now = T0 + 40 * MINUTE;
  k.world.deployProduction('gcp-next');
  await assert.rejects(k.run('release', { confirm: unknown.planned.sha256, preGcp: true }), { code: 'FENCE_RELEASE_AFTER_GCP' });
  for (const each of [f, g, k]) assert.equal(each.mutations().length, CRON_SCRIPTS.length + 1);

  const h = await fixture(t);
  const third = await applied(h);
  const applyMutations = h.mutations().length;
  h.world.now = T0 + 45 * MINUTE;
  const released = await h.run('release', { confirm: third.planned.sha256, preGcp: true });
  const writes = h.mutations().slice(applyMutations);
  assert.equal(writes.length, CRON_SCRIPTS.length + 1);
  for (const call of writes.filter(item => item.method === 'PUT')) {
    const name = scriptOf(call.href);
    assert.deepEqual(JSON.parse(call.body), CRONS[name].map(cron => ({ cron })));
  }
  assert.deepEqual(JSON.parse(writes.find(item => item.method === 'PATCH').body).settings, { delivery_paused: false });
  for (const name of CRON_SCRIPTS) assert.deepEqual(h.world.scripts.get(name).crons, [...CRONS[name]].sort());
  assert.equal(h.world.queues.get(QUEUE).settings.delivery_paused, false);
  assert.equal(released.receipt.preGcp, true);
  assert.equal((await stat(released.path)).mode & 0o777, 0o600);
  await assert.rejects(h.run('release', { confirm: third.planned.sha256, preGcp: true }), { code: 'FENCE_ALREADY_RELEASED' });
  await assert.rejects(h.run('verify', { fence: third.planned.sha256 }), { code: 'FENCE_RELEASED' });

  // Unknown schedules are never overwritten, and a pruned history refuses.
  const i = await fixture(t);
  const fourth = await applied(i);
  i.world.scripts.get('synthetic-analytics').crons = ['2 2 * * *'];
  await assert.rejects(i.run('release', { confirm: fourth.planned.sha256, preGcp: true }), { code: 'SCHEDULE_DRIFT' });
  i.world.scripts.get('synthetic-analytics').crons = [];
  i.world.now = T0 + 40 * MINUTE;
  i.world.deployProduction('fenced');
  i.world.scripts.get('synthetic-production').deployments.splice(1);
  await assert.rejects(i.run('release', { confirm: fourth.planned.sha256, preGcp: true }), { code: 'FENCE_HISTORY_INCOMPLETE' });
  assert.equal(i.mutations().length, CRON_SCRIPTS.length + 1);
});

test('receipts are 0600 and hold no token, raw ids, rows, R2 keys or addresses', async t => {
  const f = await fixture(t);
  await f.run('inventory');
  const { planned } = await applied(f);
  f.world.now = T0 + 30 * MINUTE;
  await f.run('verify', { fence: planned.sha256 });
  await f.run('release', { confirm: planned.sha256, preGcp: true });
  const names = await readdir(f.receipts);
  for (const prefix of ['inventory-', 'plan-', 'apply-intent-', 'apply-', 'fence-', 'release-', 'provider-']) {
    assert.ok(names.some(name => name.startsWith(prefix)), prefix);
  }
  const forbidden = [TOKEN, ACCOUNT, BUCKET, QUEUE, OTHER_QUEUE, ...Object.values(D1), ...R2_KEYS, 'synthetic-catchup-queue', '"results"', '"rows"'];
  for (const name of names) {
    assert.equal((await stat(join(f.receipts, name))).mode & 0o777, 0o600, name);
    if (name === 'mutex.sqlite') continue;
    const bytes = await readFile(join(f.receipts, name), 'utf8');
    for (const value of forbidden) assert.equal(bytes.includes(value), false, `${name} holds ${value.slice(0, 12)}`);
    assert.doesNotMatch(bytes, /\b\d{1,3}(?:\.\d{1,3}){3}\b|clientIP|[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){7}/i, name);
  }
});

test('the request budget is enforced across provider, R2 and analytics reads, before any write', async t => {
  const f = await fixture(t);
  const planned = await f.run('plan');
  f.world.deployProduction('fenced');
  f.world.now = T0;
  f.world.r2Endless = true;
  const before = f.world.calls.length;
  await assert.rejects(f.run('apply', { confirm: planned.sha256, analyticsDrainComplete: true }), { code: 'FENCE_REQUEST_BUDGET' });
  assert.equal(f.world.calls.length - before, FENCE_REQUEST_BUDGETS.apply);
  assert.equal(f.mutations().length, 0);
  const g = await fixture(t);
  const { planned: fenced } = await applied(g);
  g.world.now = T0 + 30 * MINUTE;
  g.world.r2Endless = true;
  const start = g.world.calls.length;
  await assert.rejects(g.run('verify', { fence: fenced.sha256 }), { code: 'FENCE_REQUEST_BUDGET' });
  assert.equal(g.world.calls.length - start, FENCE_REQUEST_BUDGETS.verify);
});

test('GraphQL query texts are pinned by sha256', () => {
  for (const [name, text] of Object.entries(FENCE_GRAPHQL_QUERIES)) {
    assert.equal(createHash('sha256').update(text).digest('hex'), FENCE_GRAPHQL_QUERY_SHA256[name]);
  }
  assert.deepEqual(FENCE_GRAPHQL_QUERY_SHA256, {
    d1Writes: '1eaed45e0be7498432fd6c4fed06c14d322f006c9fe60583d14846c6314603d7',
    invocations: '6e9821035c67bf8e0490d39b24c83214cc4e33418500137144620f4cd52939c5',
  });
  assert.doesNotMatch(Object.values(FENCE_GRAPHQL_QUERIES).join('\n'), /clientIP|userAgent|mutation/);
});

test('the example plan fixture is a valid closed plan and the validator is closed', async () => {
  const example = JSON.parse(await readFile(join(SCRIPT_DIRECTORY, 'fixtures', 'cloudflare-writer-inventory.example.json'), 'utf8'));
  const plan = validateCloudflareWriterFencePlan(example);
  assert.equal(plan.fencedScripts.filter(item => item.kind === 'queue-consumer').length, 1);
  const invalid = [
    { ...example, quietWindowMinutes: 14 },
    { ...example, extra: true },
    { ...example, dataResources: [...example.dataResources.slice(0, 3), { ...example.dataResources[0], label: 'catchup-control' }, example.dataResources[4]] },
    { ...example, fencedScripts: [...example.fencedScripts, { name: 'x-cron', kind: 'cron', expectedCrons: [] }] },
    { ...example, fencedScripts: [{ name: 'x-consumer', kind: 'queue-consumer', expectedCrons: ['* * * * *'], queueId: 'a'.repeat(32) }] },
    { ...example, outOfScopeScripts: [{ name: example.productionWorker, reason: 'dup' }] },
  ];
  for (const value of invalid) assert.throws(() => validateCloudflareWriterFencePlan(value), { code: 'FENCE_PLAN_INVALID' });
});

test('the transport admits PUT/PATCH only as explicit mutations', async t => {
  const f = await fixture(t);
  const calls = [];
  const transport = createMaintenanceTransport({ plan: { accountId: ACCOUNT }, operationDirectory: f.receipts, cliPath: f.cliPath,
    fetcher: async (url, init) => { calls.push(init.method); return Response.json({ success: true, result: { schedules: [] } }); },
    environment: { CLOUDFLARE_API_TOKEN: TOKEN } });
  const path = `/accounts/${ACCOUNT}/workers/scripts/synthetic-analytics/schedules`;
  await assert.rejects(transport.api(path, [], { method: 'PUT' }), { code: 'PRODUCTION_MAINTENANCE_REQUEST_INVALID' });
  await assert.rejects(transport.api(path, [], { mutation: true, method: 'DELETE' }), { code: 'PRODUCTION_MAINTENANCE_REQUEST_INVALID' });
  await assert.rejects(transport.api(path, undefined, { mutation: true, method: 'PUT' }), { code: 'PRODUCTION_MAINTENANCE_REQUEST_INVALID' });
  await transport.api(path, [], { mutation: true, method: 'PUT' });
  await transport.api(path);
  assert.deepEqual(calls, ['PUT', 'GET']);
  const receipts = await Promise.all((await readdir(f.receipts)).map(name => readFile(join(f.receipts, name), 'utf8')));
  assert.deepEqual(receipts.map(item => JSON.parse(item).method).sort(), ['GET', 'PUT_WRITE']);
});

test('arguments are closed and the CLI prints only codes on failure', async t => {
  const sha = 'a'.repeat(64);
  assert.deepEqual(parseCloudflareWriterFenceArguments(['apply', '--plan', 'p.json', '--receipts=r', `--confirm=${sha}`, '--analytics-drain-complete']),
    { subcommand: 'apply', planPath: 'p.json', receiptsDirectory: 'r', confirm: sha, analyticsDrainComplete: true });
  for (const args of [['deploy', '--plan', 'p', '--receipts', 'r'], ['plan', '--plan', 'p'], ['plan', '--plan', 'p', '--receipts', 'r', '--plan', 'q'],
    ['release', '--plan', 'p', '--receipts', 'r', '--pre-gcp=yes'], ['plan', '--plan', 'p', '--receipts', 'r', '--token', 'x']]) {
    assert.throws(() => parseCloudflareWriterFenceArguments(args), { code: 'FENCE_ARGUMENTS_INVALID' });
  }
  const f = await fixture(t);
  const planPath = join(f.root, 'plan.json');
  await writeFile(planPath, JSON.stringify(planInput()), { mode: 0o600 });
  const result = spawnSync(process.execPath, [join(SCRIPT_DIRECTORY, 'cloudflare-writer-fence.mjs'), 'inventory', '--plan', planPath, '--receipts', f.receipts],
    { encoding: 'utf8', env: { PATH: '/usr/bin', HOME: f.root } });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'FENCE_CREDENTIAL_REQUIRED\n');
  await assert.rejects(f.run('inventory', { environment: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_API_BASE_URL: 'https://example.invalid' } }),
    { code: 'PRODUCTION_MAINTENANCE_ENVIRONMENT_OVERRIDE' });
  assert.equal(f.world.calls.length, 0);
});
