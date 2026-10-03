import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FENCE_ANALYTICS_LAG_MINUTES, FENCE_GRAPHQL_QUERIES, FENCE_GRAPHQL_QUERY_SHA256, FENCE_REQUEST_BUDGETS,
  cloudflareWriterFenceErrorLine, parseCloudflareWriterFenceArguments, readCloudflareWriterFenceReceipt,
  runCloudflareWriterFence, validateCloudflareWriterFencePlan,
} from './cloudflare-writer-fence.mjs';

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
const PLAN_D1_IDS = [D1.ingestion, D1.analytics, D1.ledger, D1.control];
const BUCKET = 'synthetic-quarantine';
const QUEUE = 'd'.repeat(32);
const OTHER_QUEUE = 'e'.repeat(32);
const COMMIT = 'f'.repeat(40);
// Documentation-range addresses and a reserved-domain author: provider
// metadata the fence reads past and must never copy into a receipt.
const AUTHOR = 'synthetic-author@example.invalid';
const DOC_IPV4 = '192.0.2.1';
const DOC_IPV6 = '2001:db8::1';
const T0 = Date.parse('2026-09-26T10:00:00.000Z');
const MINUTE = 60_000;
// Earliest verify with the default window: apply + quiet + quiet + analytics lag.
const VERIFY_AT = T0 + 36 * MINUTE;
const CRONS = {
  'synthetic-analytics': ['* * * * *'],
  'synthetic-publication': ['*/5 * * * *'],
  'synthetic-cache-retention': ['17 * * * *'],
  'synthetic-graph-day': ['*/10 * * * *', '3 4 * * *'],
};
const CRON_SCRIPTS = Object.keys(CRONS);
const FENCED_NAMES = [...CRON_SCRIPTS, 'synthetic-catchup'].sort();
const R2_KEYS = ['telemetry/synthetic-object-one', 'synthetic/synthetic-object-two'];
const SCRIPT_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));
const scriptOf = href => new URL(href).pathname.split('/')[7];
const iso = ms => new Date(ms).toISOString();
const sha256 = value => createHash('sha256').update(value).digest('hex');

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
const catchupQueue = { type: 'queue', name: 'STORAGE_ANALYTICS_CATCHUP_QUEUE', queue_name: 'synthetic-catchup-queue' };
const productionBindings = mode => [
  d1('USAGE_MONITOR_DB', D1.ingestion), d1('ANALYTICS_DB', D1.analytics), d1('DELETION_LEDGER', D1.ledger),
  r2('QUARANTINE', BUCKET), r2('SPARKLE_RELEASES', 'synthetic-releases'), { type: 'assets', name: 'ASSETS' },
  { type: 'secret_text', name: 'SYNTHETIC_SECRET' }, text('DEPLOYMENT_SOURCE_COMMIT', COMMIT),
  ...(mode === null ? [] : [text('EDGE_UPSTREAM_MODE', mode)]),
];
const analyticsBindings = () => [
  d1('STORAGE_INGESTION_DB', D1.ingestion), d1('STORAGE_ANALYTICS_DB', D1.analytics), d1('DELETION_LEDGER', D1.ledger),
  text('STORAGE_ANALYTICS_MODE', 'enabled'), text('STORAGE_ANALYTICS_ORIGIN', `https://[${DOC_IPV6}]:8443/`),
];
const catchupBindings = (controlId = D1.control) => [...analyticsBindings(),
  d1('STORAGE_ANALYTICS_CATCHUP_CONTROL_DB', controlId), catchupQueue];

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
    // Synthetic analytics events: {databaseId, at, rowsWritten, writeQueries}
    // and {scriptName, at, requests}. The fake answers each pinned query only
    // with events that match its posted filter, as the provider does.
    analytics: { d1: [], invocations: [], raw: null },
    failPutNumber: null,
    failPutLanded: false,
    // Lying provider per method: 'stale' (echo the unchanged state),
    // 'unpersisted' (echo the request, change nothing), 'refuse' (403) or
    // 'server-error' (502, outcome unknown).
    lie: { PUT: null, PATCH: null },
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
    script.deployments.unshift({ id: uuid(), created_on: iso(world.now), source: 'api', strategy: 'percentage',
      author_email: AUTHOR, annotations: { 'workers/message': `synthetic deploy from ${DOC_IPV4}`, 'workers/triggered_by': 'upload' },
      versions: entries });
    script.settings = versions.at(-1)[0];
    if (crons !== undefined) script.crons = [...crons];
    world.scripts.set(name, script);
  };
  world.deployProduction = mode => world.deploy('synthetic-production', [[productionBindings(mode), 100]], ['* * * * *']);
  world.deployProduction('worker');
  for (const name of CRON_SCRIPTS) world.deploy(name, [[analyticsBindings(), 100]], CRONS[name]);
  world.deploy('synthetic-catchup', [[catchupBindings(), 100]], []);
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
  const refused = () => Response.json({ success: false, errors: [{ code: 10000 }], messages: [], result: null }, { status: 403 });
  const serverError = () => Response.json({ success: false, errors: [{ code: 10013 }], messages: [], result: null }, { status: 502 });
  const accountBody = account => ({ data: { viewer: { accounts: [account] } }, errors: null });
  const graphql = (query, variables) => {
    const raw = world.analytics.raw?.(query, variables);
    if (raw) return raw;
    const inWindow = at => at >= Date.parse(variables.start) && at <= Date.parse(variables.end);
    if (query === FENCE_GRAPHQL_QUERIES.d1Writes) {
      const groups = new Map();
      for (const event of world.analytics.d1.filter(item => variables.databaseIds.includes(item.databaseId) && inWindow(item.at))) {
        const group = groups.get(event.databaseId) ?? { sum: { rowsWritten: 0, writeQueries: 0 }, dimensions: { databaseId: event.databaseId } };
        group.sum.rowsWritten += event.rowsWritten;
        group.sum.writeQueries += event.writeQueries;
        groups.set(event.databaseId, group);
      }
      return accountBody({ d1AnalyticsAdaptiveGroups: [...groups.values()] });
    }
    if (query === FENCE_GRAPHQL_QUERIES.invocations) {
      const groups = new Map();
      for (const event of world.analytics.invocations.filter(item => variables.scriptNames.includes(item.scriptName) && inWindow(item.at))) {
        const group = groups.get(event.scriptName) ?? { sum: { requests: 0 }, dimensions: { scriptName: event.scriptName } };
        group.sum.requests += event.requests;
        groups.set(event.scriptName, group);
      }
      return accountBody({ workersInvocationsAdaptive: [...groups.values()] });
    }
    return { data: null, errors: [{ message: 'unknown query' }] };
  };
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
      return Response.json(graphql(query, variables));
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
      if (parts[3] === 'deployments') {
        const limit=Number(parsed.searchParams.get('per_page'));
        assert.equal(parsed.searchParams.get('page'),'1');
        assert.ok([1,25].includes(limit));
        const deployments=script.deployments.slice(0,limit);
        return Response.json({success:true,result:{deployments},result_info:{page:1,per_page:limit,count:deployments.length,total_count:script.deployments.length,total_pages:Math.ceil(script.deployments.length/limit)}});
      }
      if (parts[3] === 'versions') {
        return ok({ id: parts[4], number: 1, annotations: { 'workers/message': `synthetic upload from ${DOC_IPV6}` },
          metadata: { author_email: AUTHOR, author_id: 'synthetic-author-id', source: 'wrangler', created_on: iso(world.now) },
          resources: { bindings: world.versions.get(parts[4]) } });
      }
      if (parts[3] === 'settings') return ok({ bindings: script.settings });
      if (parts[3] === 'schedules') {
        const echo = crons => ok({ schedules: crons.map(cron => ({ cron, created_on: 'x', modified_on: 'x' })) });
        if (method === 'PUT') {
          putNumber += 1;
          const requested = JSON.parse(init.body).map(item => item.cron);
          if (putNumber === world.failPutNumber) {
            if (world.failPutLanded) script.crons = requested;
            throw new TypeError('synthetic network failure');
          }
          if (world.lie.PUT === 'refuse') return refused();
          if (world.lie.PUT === 'server-error') return serverError();
          if (world.lie.PUT === 'stale') return echo(script.crons);
          if (world.lie.PUT === 'unpersisted') return echo(requested);
          script.crons = requested;
        }
        return echo(script.crons);
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
        if (world.lie.PATCH === 'refuse') return refused();
        if (world.lie.PATCH === 'server-error') return serverError();
        if (world.lie.PATCH === 'stale') return ok(queue);
        if (world.lie.PATCH === 'unpersisted') return ok({ ...queue, settings: { ...queue.settings, ...body.settings } });
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

const receiptNames = async (f, prefix) => (await readdir(f.receipts)).filter(name => name.startsWith(prefix));
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const apply = (f, planned, extra = {}) => f.run('apply', { confirm: planned.sha256, analyticsDrainComplete: true, ...extra });

// Holds the receipts mutex the way a concurrent apply, verify or release does.
async function holdReceiptsLock(receipts) {
  const path = join(receipts, 'mutex.sqlite');
  await writeFile(path, '', { mode: 0o600, flag: 'a' });
  const holder = new DatabaseSync(path);
  holder.exec('BEGIN EXCLUSIVE');
  return () => holder.close();
}

test('inventory is read-only and its 0600 receipt lists every script and queue by name, binding type, id digest and cron', async t => {
  const f = await fixture(t);
  const result = await f.run('inventory');
  assert.equal(f.mutations().length, 0);
  assert.ok(f.world.calls.every(call => call.method === 'GET'));
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  const receipt = await readJson(result.path);
  assert.equal(receipt.schema, 'cloudflare-writer-fence-inventory-v1');
  assert.equal(receipt.productionWorker.mode, 'worker');
  assert.deepEqual(receipt.fencedScripts.map(item => [item.name, item.crons]),
    [['synthetic-analytics', ['* * * * *']], ['synthetic-cache-retention', ['17 * * * *']], ['synthetic-catchup', []],
      ['synthetic-graph-day', ['*/10 * * * *', '3 4 * * *']], ['synthetic-publication', ['*/5 * * * *']]]);
  const catchup = receipt.fencedScripts.find(item => item.name === 'synthetic-catchup');
  assert.equal(catchup.deliveryPaused, false);
  assert.ok(catchup.bindings.some(item => item.type === 'd1' && item.name === 'STORAGE_ANALYTICS_CATCHUP_CONTROL_DB' && /^[a-f0-9]{64}$/.test(item.ref)));
  assert.deepEqual(receipt.dataResources.find(item => item.label === 'catchup-control').boundBy, ['synthetic-catchup']);
  // The whole account, unlisted scripts included, with listed labels marked.
  assert.deepEqual(receipt.scripts.map(item => [item.name, item.classification]), [
    ['synthetic-analytics', 'fenced'], ['synthetic-cache-retention', 'fenced'], ['synthetic-catchup', 'fenced'],
    ['synthetic-graph-day', 'fenced'], ['synthetic-guard', 'out-of-scope'], ['synthetic-production', 'production'],
    ['synthetic-publication', 'fenced'], ['synthetic-unrelated', 'unlisted']]);
  assert.deepEqual(receipt.scripts.find(item => item.name === 'synthetic-unrelated'),
    { name: 'synthetic-unrelated', classification: 'unlisted', crons: ['0 0 * * *'], bindings: [{ type: 'plain_text', name: 'SYNTHETIC_MODE' }] });
  const production = receipt.scripts.find(item => item.name === 'synthetic-production');
  assert.deepEqual(production.bindings.filter(item => item.label).map(item => [item.name, item.label]).sort(),
    [['ANALYTICS_DB', 'analytics'], ['DELETION_LEDGER', 'deletion-ledger'], ['QUARANTINE', 'quarantine'], ['USAGE_MONITOR_DB', 'ingestion']]);
  assert.deepEqual(receipt.scripts.find(item => item.name === 'synthetic-guard').bindings.filter(item => item.label), []);
  assert.deepEqual(receipt.queues, [
    { queueIdSha256: sha256(`queue:${QUEUE}`), consumers: [{ type: 'worker', script: 'synthetic-catchup' }], deliveryPaused: false },
    { queueIdSha256: sha256(`queue:${OTHER_QUEUE}`), consumers: [], deliveryPaused: false },
  ].sort((a, b) => a.queueIdSha256.localeCompare(b.queueIdSha256)));
  const bytes = await readFile(result.path, 'utf8');
  for (const secret of [TOKEN, ACCOUNT, BUCKET, QUEUE, OTHER_QUEUE, 'synthetic-catchup-queue', ...Object.values(D1), ...R2_KEYS, 'enabled']) {
    assert.equal(bytes.includes(secret), false, secret);
  }
});

test('inventory raises WRITER_UNACCOUNTED for any script outside the fence that binds a listed resource, naming it in a refusal receipt', async t => {
  const f = await fixture(t);
  f.world.deploy('synthetic-rogue', [[[d1('SOME_DB', D1.analytics)], 100]], []);
  const error = await f.run('inventory').then(() => null, caught => caught);
  assert.equal(error?.code, 'WRITER_UNACCOUNTED');
  assert.match(error.refusalReceipt, /^inventory-refusal-[a-f0-9]{64}\.json$/);
  assert.equal(cloudflareWriterFenceErrorLine(error), `WRITER_UNACCOUNTED ${error.refusalReceipt}\n`);
  const refusalPath = join(f.receipts, error.refusalReceipt);
  assert.equal((await stat(refusalPath)).mode & 0o777, 0o600);
  const refusal = await readJson(refusalPath);
  assert.equal(refusal.schema, 'cloudflare-writer-fence-inventory-refusal-v1');
  assert.deepEqual(refusal.refusal, { code: 'WRITER_UNACCOUNTED', scripts: ['synthetic-rogue'], labels: ['analytics'] });
  assert.deepEqual(refusal.scripts.find(item => item.name === 'synthetic-rogue').bindings,
    [{ type: 'd1', name: 'SOME_DB', ref: sha256(`d1:${D1.analytics}`), label: 'analytics' }]);
  assert.equal(refusal.queues.length, 2);
  assert.deepEqual(await receiptNames(f, 'inventory-'), [error.refusalReceipt]);
  const g = await fixture(t);
  // Declaring a script out of scope does not excuse a binding to fenced storage.
  g.world.deploy('synthetic-guard', [[[d1('USAGE_MONITOR_DB', D1.guard), r2('QUARANTINE', BUCKET)], 100]]);
  const guarded = await g.run('plan').then(() => null, caught => caught);
  assert.equal(guarded?.code, 'WRITER_UNACCOUNTED');
  assert.deepEqual((await readJson(join(g.receipts, guarded.refusalReceipt))).refusal,
    { code: 'WRITER_UNACCOUNTED', scripts: ['synthetic-guard'], labels: ['quarantine'] });
  const h = await fixture(t);
  // A split deployment still counts every version's bindings.
  h.world.deploy('synthetic-unrelated', [[[text('SYNTHETIC_MODE', 'on')], 90], [[d1('LATE_DB', D1.ledger)], 10]]);
  await assert.rejects(h.run('inventory'), { code: 'WRITER_UNACCOUNTED' });
  for (const each of [f, g, h]) {
    assert.equal(each.mutations().length, 0);
    assert.deepEqual(await receiptNames(each, 'plan-'), []);
  }
});

test('inventory raises SCHEDULE_DRIFT on any fenced cron mismatch, including a cron on the consumer', async t => {
  const f = await fixture(t);
  f.world.scripts.get('synthetic-graph-day').crons = ['*/10 * * * *'];
  const error = await f.run('inventory').then(() => null, caught => caught);
  assert.equal(error?.code, 'SCHEDULE_DRIFT');
  const refusal = await readJson(join(f.receipts, error.refusalReceipt));
  assert.deepEqual(refusal.refusal.scripts, ['synthetic-graph-day']);
  assert.deepEqual(refusal.scripts.find(item => item.name === 'synthetic-graph-day').crons, ['*/10 * * * *']);
  const g = await fixture(t);
  g.world.scripts.get('synthetic-catchup').crons = ['* * * * *'];
  await assert.rejects(g.run('plan'), { code: 'SCHEDULE_DRIFT' });
});

test('labels must be the live bindings; fenced scripts may bind only listed storage; consumers must match', async t => {
  const refusal = async (f, promise, code) => {
    const error = await promise.then(() => null, caught => caught);
    assert.equal(error?.code, code);
    return (await readJson(join(f.receipts, error.refusalReceipt))).refusal;
  };
  const f = await fixture(t);
  // The unbound legacy D1 can never be named as the ingestion source.
  const legacy = planInput();
  legacy.dataResources[0] = { kind: 'd1', label: 'ingestion', id: D1.legacy };
  assert.deepEqual((await refusal(f, f.run('inventory', { plan: legacy }), 'FENCE_RESOURCE_LABEL_MISMATCH')).labels, ['ingestion']);
  const swapped = planInput();
  swapped.dataResources[0] = { kind: 'd1', label: 'ingestion', id: D1.analytics };
  swapped.dataResources[1] = { kind: 'd1', label: 'analytics', id: D1.ingestion };
  assert.deepEqual((await refusal(f, f.run('inventory', { plan: swapped }), 'FENCE_RESOURCE_LABEL_MISMATCH')).labels, ['analytics', 'ingestion']);
  // The R2 digest must scan the bucket production binds as QUARANTINE.
  const otherBucket = planInput();
  otherBucket.dataResources[4] = { kind: 'r2', bucket: 'synthetic-other-bucket' };
  assert.deepEqual((await refusal(f, f.run('inventory', { plan: otherBucket }), 'FENCE_RESOURCE_LABEL_MISMATCH')).labels, ['quarantine']);
  const c = await fixture(t);
  // catchup-control must be what the fenced consumer binds, even when the
  // id it binds instead is another listed database.
  c.world.deploy('synthetic-catchup', [[catchupBindings(D1.ledger), 100]]);
  assert.deepEqual((await refusal(c, c.run('inventory'), 'FENCE_RESOURCE_LABEL_MISMATCH')).labels, ['catchup-control']);
  const g = await fixture(t);
  g.world.deploy('synthetic-publication', [[[...analyticsBindings(), d1('EXTRA_DB', D1.legacy)], 100]]);
  assert.deepEqual((await refusal(g, g.run('inventory'), 'FENCE_RESOURCE_UNLISTED')).scripts, ['synthetic-publication']);
  const b = await fixture(t);
  b.world.deploy('synthetic-graph-day', [[[...analyticsBindings(), r2('EXTRA_BUCKET', 'synthetic-other-bucket')], 100]]);
  assert.deepEqual((await refusal(b, b.run('inventory'), 'FENCE_RESOURCE_UNLISTED')).scripts, ['synthetic-graph-day']);
  const h = await fixture(t);
  h.world.queues.get(OTHER_QUEUE).consumers = [{ type: 'worker', script: 'synthetic-analytics' }];
  assert.deepEqual((await refusal(h, h.run('inventory'), 'CONSUMER_DRIFT')).scripts, ['synthetic-analytics']);
  const i = await fixture(t);
  i.world.queues.get(QUEUE).consumers = [];
  assert.deepEqual((await refusal(i, i.run('inventory'), 'CONSUMER_DRIFT')).scripts, ['synthetic-catchup']);
  const k = await fixture(t);
  // A second consumer on the fenced queue would keep draining it while paused delivery is claimed.
  k.world.queues.get(QUEUE).consumers.push({ type: 'worker', script: 'synthetic-unrelated' });
  assert.deepEqual((await refusal(k, k.run('plan'), 'CONSUMER_DRIFT')).scripts, ['synthetic-catchup']);
  const m = await fixture(t);
  m.world.scripts.delete('synthetic-publication');
  assert.deepEqual((await refusal(m, m.run('inventory'), 'FENCE_PLAN_SCRIPT_MISSING')).scripts, ['synthetic-publication']);
  const j = await fixture(t);
  j.world.deploy('synthetic-production', [[productionBindings('worker'), 50], [productionBindings('worker'), 50]]);
  await assert.rejects(j.run('plan'), { code: 'PRODUCTION_DEPLOYMENT_AMBIGUOUS' });
  for (const each of [f, c, g, b, h, i, k, m, j]) assert.equal(each.mutations().length, 0);
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
  await assert.rejects(apply(f, planned, { plan: planInput({ quietWindowMinutes: 20 }) }), { code: 'FENCE_PLAN_RECEIPT_MISMATCH' });
  // Production must already be fenced before any writer is unscheduled.
  f.world.deployProduction('worker');
  await assert.rejects(apply(f, planned), { code: 'PRODUCTION_WORKER_NOT_FENCED' });
  f.world.deployProduction('fenced');
  // Any drift of the fenced surface since the plan refuses.
  f.world.deploy('synthetic-analytics', [[[...analyticsBindings(), text('STORAGE_ANALYTICS_EXTRA', 'x')], 100]]);
  await assert.rejects(apply(f, planned), { code: 'FENCE_INVENTORY_CHANGED' });
  assert.equal(f.mutations().length, 0);
  assert.deepEqual(await receiptNames(f, 'apply'), []);
});

test('apply refuses a cron or delivery change made since the plan, before any write or journal', async t => {
  const cases = {
    SCHEDULE_DRIFT: world => { world.scripts.get('synthetic-analytics').crons = ['*/2 * * * *']; },
    CONSUMER_DRIFT: world => { world.queues.get(QUEUE).settings.delivery_paused = true; },
  };
  for (const [code, change] of Object.entries(cases)) {
    const f = await fixture(t);
    const planned = await f.run('plan');
    f.world.deployProduction('fenced');
    f.world.now = T0;
    change(f.world);
    await assert.rejects(apply(f, planned), { code }, code);
    assert.equal(f.mutations().length, 0, code);
    assert.deepEqual(await receiptNames(f, 'apply'), [], code);
  }
});

test('apply refuses an edited plan receipt, an unsafe receipts directory and a concurrent holder before any request', async t => {
  const f = await fixture(t);
  const planned = await f.run('plan');
  f.world.deployProduction('fenced');
  f.world.now = T0;
  const before = f.world.calls.length;
  const planPath = join(f.receipts, `plan-${planned.sha256}.json`);
  const original = await readFile(planPath, 'utf8');
  const edited = JSON.parse(original);
  edited.mutations[0].before.crons = ['*/2 * * * *'];
  await writeFile(planPath, `${JSON.stringify(edited)}\n`, { mode: 0o600 });
  await assert.rejects(apply(f, planned), { code: 'FENCE_CONFIRMATION_MISMATCH' });
  await writeFile(planPath, original, { mode: 0o600 });
  await chmod(f.receipts, 0o755);
  await assert.rejects(apply(f, planned), { code: 'FENCE_RECEIPTS_DIRECTORY_UNSAFE' });
  await chmod(f.receipts, 0o700);
  const release = await holdReceiptsLock(f.receipts);
  try {
    await assert.rejects(apply(f, planned), { code: 'FENCE_BUSY' });
    await assert.rejects(f.run('release', { confirm: planned.sha256, preGcp: true }), { code: 'FENCE_BUSY' });
    await assert.rejects(f.run('verify', { fence: planned.sha256 }), { code: 'FENCE_BUSY' });
  } finally { release(); }
  assert.equal(f.world.calls.length, before);
  assert.deepEqual(await receiptNames(f, 'apply'), []);
  await apply(f, planned);
  assert.equal(f.mutations().length, CRON_SCRIPTS.length + 1);
});

test('confirmed apply issues exactly one PUT [] per cron script and one pause per consumer and records the prior state', async t => {
  const f = await fixture(t);
  const { planned, apply: applied_ } = await applied(f);
  const puts = f.mutations().filter(call => call.method === 'PUT');
  const patches = f.mutations().filter(call => call.method === 'PATCH');
  assert.equal(f.mutations().length, CRON_SCRIPTS.length + 1);
  assert.deepEqual(puts.map(call => scriptOf(call.href)).sort(), [...CRON_SCRIPTS].sort());
  assert.ok(puts.every(call => call.body === '[]' && call.href.endsWith('/schedules')));
  assert.equal(patches.length, 1);
  assert.equal(patches[0].href, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/queues/${QUEUE}`);
  assert.deepEqual(JSON.parse(patches[0].body), { queue_name: 'synthetic-catchup-queue', settings: { delivery_paused: true } });
  for (const name of CRON_SCRIPTS) assert.deepEqual(f.world.scripts.get(name).crons, []);
  assert.equal(f.world.queues.get(QUEUE).settings.delivery_paused, true);
  const receipt = applied_.receipt;
  assert.equal(receipt.planReceiptSha256, planned.sha256);
  assert.equal(receipt.appliedAtMs, T0);
  assert.equal(receipt.analyticsDrainAttested, true);
  assert.equal(receipt.productionWorker.mode, 'fenced');
  assert.deepEqual(Object.fromEntries(receipt.priorState.filter(item => item.action === 'clear-schedules').map(item => [item.script, item.before.crons])), CRONS);
  assert.deepEqual(receipt.priorState.find(item => item.action === 'pause-delivery').before, { deliveryPaused: false });
  assert.equal((await stat(applied_.path)).mode & 0o777, 0o600);
  // Each write went through the fence's own budgeted client and left a
  // content-free provider-write receipt; nothing else was written.
  const providerReceipts = await Promise.all((await receiptNames(f, 'provider-')).map(name => readJson(join(f.receipts, name))));
  const writes = providerReceipts.filter(item => item.kind === 'provider-write');
  assert.deepEqual(writes.map(item => item.method).sort(), ['PATCH_WRITE', 'PUT_WRITE', 'PUT_WRITE', 'PUT_WRITE', 'PUT_WRITE']);
  assert.ok(writes.every(item => /^[a-f0-9]{64}$/.test(item.pathSha256) && item.status === 200));
  assert.ok(f.world.calls.every(call => ['GET', 'PUT', 'PATCH'].includes(call.method) || call.href.endsWith('/graphql')));
  await assert.rejects(apply(f, planned), { code: 'FENCE_ALREADY_APPLIED' });
  assert.equal(f.mutations().length, CRON_SCRIPTS.length + 1);
});

test('apply fails closed when the provider refuses a write or does not do what it reports', async t => {
  const cases = [
    ['PUT', 'refuse', 'FENCE_MUTATION_REFUSED'],
    ['PUT', 'server-error', 'FENCE_MUTATION_UNCERTAIN'],
    ['PUT', 'stale', 'FENCE_MUTATION_UNVERIFIED'],
    ['PUT', 'unpersisted', 'FENCE_APPLY_UNVERIFIED'],
    ['PATCH', 'refuse', 'FENCE_MUTATION_REFUSED'],
    ['PATCH', 'server-error', 'FENCE_MUTATION_UNCERTAIN'],
    ['PATCH', 'stale', 'FENCE_MUTATION_UNVERIFIED'],
    ['PATCH', 'unpersisted', 'FENCE_APPLY_UNVERIFIED'],
  ];
  for (const [method, mode, code] of cases) {
    const f = await fixture(t);
    const planned = await f.run('plan');
    f.world.deployProduction('fenced');
    f.world.now = T0;
    f.world.lie[method] = mode;
    await assert.rejects(apply(f, planned), { code }, `${method} ${mode}`);
    assert.deepEqual(await receiptNames(f, `apply-${planned.sha256}`), [], `${method} ${mode}`);
  }
});

test('an interrupted apply resumes from its journal and never re-issues a completed write', async t => {
  const f = await fixture(t);
  const planned = await f.run('plan');
  f.world.deployProduction('fenced');
  f.world.now = T0;
  f.world.failPutNumber = 2;
  await assert.rejects(apply(f, planned), { code: 'FENCE_MUTATION_UNCERTAIN' });
  assert.ok((await readdir(f.receipts)).includes(`apply-intent-${planned.sha256}.json`));
  f.world.failPutNumber = null;
  f.world.now = T0 + MINUTE;
  const resumed = await apply(f, planned);
  assert.equal(resumed.receipt.mutationsIssued, CRON_SCRIPTS.length);
  assert.equal(resumed.receipt.startedAtMs, T0);
  assert.equal(resumed.receipt.appliedAtMs, T0 + MINUTE);
  // 2 attempted in the first run (1 landed, 1 failed), 3 + 1 pause in the resume.
  assert.equal(f.mutations().filter(call => call.method === 'PUT').length, CRON_SCRIPTS.length + 1);
  assert.equal(f.mutations().filter(call => call.method === 'PATCH').length, 1);
});

test('verify pins bookmarks and the R2 digest after a quiet window, tolerating writes inside that window', async t => {
  const f = await fixture(t);
  const { planned, apply: applied_ } = await applied(f);
  // An in-flight pass finishing inside the quiet window, seen by bookmarks and analytics alike.
  f.world.write(D1.analytics, T0 + 5 * MINUTE);
  f.world.analytics.d1.push({ databaseId: D1.analytics, at: T0 + 5 * MINUTE, rowsWritten: 4, writeQueries: 1 });
  f.world.analytics.invocations.push({ scriptName: 'synthetic-analytics', at: T0 + 5 * MINUTE, requests: 1 });
  f.world.now = T0 + 20 * MINUTE;
  await assert.rejects(f.run('verify', { fence: planned.sha256 }), { code: 'FENCE_WINDOW_TOO_SHORT' });
  // The bookmark window would be long enough; the lag-trimmed analytics interval is not.
  f.world.now = VERIFY_AT - 2 * MINUTE;
  await assert.rejects(f.run('verify', { fence: planned.sha256 }), { code: 'FENCE_WINDOW_TOO_SHORT' });
  f.world.now = VERIFY_AT;
  await assert.rejects(f.run('verify', { fence: planned.sha256, windowStart: iso(T0 + 14 * MINUTE) }), { code: 'FENCE_WINDOW_TOO_EARLY' });
  assert.deepEqual(await receiptNames(f, 'fence-'), []);
  const before = f.world.calls.length;
  const verified = await f.run('verify', { fence: planned.sha256 });
  assert.ok(f.world.calls.slice(before).every(call => call.method === 'GET' || call.href.endsWith('/graphql')));
  assert.equal(f.mutations().length, CRON_SCRIPTS.length + 1);
  const receipt = verified.receipt;
  assert.equal(receipt.applyReceiptSha256, applied_.sha256);
  const window = { start: iso(T0 + 15 * MINUTE), end: iso(VERIFY_AT) };
  assert.deepEqual(receipt.window, { appliedAt: iso(T0), quietWindowMinutes: 15, ...window });
  const analyticsEnd = iso(VERIFY_AT - FENCE_ANALYTICS_LAG_MINUTES * MINUTE);
  assert.deepEqual(receipt.analytics.window, { start: window.start, end: analyticsEnd, lagMinutes: FENCE_ANALYTICS_LAG_MINUTES });
  assert.deepEqual(receipt.d1.map(item => item.label), ['ingestion', 'analytics', 'deletion-ledger', 'catchup-control']);
  assert.equal(receipt.d1.find(item => item.label === 'analytics').bookmark, `00000001-${D1.analytics.slice(0, 8)}-00000001`);
  assert.equal(receipt.r2.inventorySha256, applied_.receipt.r2Baseline.inventorySha256);
  assert.equal(receipt.r2.objects, 2);
  assert.equal(receipt.productionWorker.sourceCommit, COMMIT);
  assert.deepEqual(receipt.fencedScripts, FENCED_NAMES.map(name => ({ name, kind: name === 'synthetic-catchup' ? 'queue-consumer' : 'cron',
    crons: [], deliveryPaused: name === 'synthetic-catchup' ? true : null })));
  assert.deepEqual(receipt.analytics.querySha256, FENCE_GRAPHQL_QUERY_SHA256);
  assert.equal(receipt.analytics.fencedScriptInvocations, 0);
  assert.equal((await stat(verified.path)).mode & 0o777, 0o600);
  assert.deepEqual(await readCloudflareWriterFenceReceipt(verified.path, verified.sha256), receipt);
  await assert.rejects(readCloudflareWriterFenceReceipt(verified.path, applied_.sha256), { code: 'FENCE_RECEIPT_INVALID' });
  // The analytics evidence is tied to the window and to exactly the listed databases and fenced scripts.
  const posted = f.world.calls.filter(call => call.href.endsWith('/graphql')).map(call => JSON.parse(call.body));
  assert.deepEqual(posted.map(item => item.query), [FENCE_GRAPHQL_QUERIES.d1Writes, FENCE_GRAPHQL_QUERIES.invocations]);
  assert.deepEqual(posted[0].variables, { accountTag: ACCOUNT, start: window.start, end: analyticsEnd, databaseIds: PLAN_D1_IDS });
  assert.deepEqual(posted[1].variables, { accountTag: ACCOUNT, start: window.start, end: analyticsEnd, scriptNames: FENCED_NAMES });
});

test('verify fails FENCE_NOT_QUIESCENT on a bookmark, digest, rowsWritten, writeQueries or invocation change', async t => {
  const during = T0 + 20 * MINUTE;
  const cases = {
    bookmark: world => world.write(D1.control, during),
    digest: world => world.objects.push({ ...world.objects[0], key: 'telemetry/synthetic-late-object' }),
    rowsWritten: world => world.analytics.d1.push({ databaseId: D1.ledger, at: during, rowsWritten: 3, writeQueries: 0 }),
    writeQueries: world => world.analytics.d1.push({ databaseId: D1.ingestion, at: during, rowsWritten: 0, writeQueries: 2 }),
    catchupControlWrite: world => world.analytics.d1.push({ databaseId: D1.control, at: during, rowsWritten: 1, writeQueries: 1 }),
    invocation: world => world.analytics.invocations.push({ scriptName: 'synthetic-catchup', at: during, requests: 1 }),
    lastInvocation: world => world.analytics.invocations.push({ scriptName: 'synthetic-publication',
      at: VERIFY_AT - FENCE_ANALYTICS_LAG_MINUTES * MINUTE, requests: 1 }),
  };
  for (const [name, change] of Object.entries(cases)) {
    const f = await fixture(t);
    const { planned } = await applied(f);
    f.world.now = VERIFY_AT;
    change(f.world);
    await assert.rejects(f.run('verify', { fence: planned.sha256 }), { code: 'FENCE_NOT_QUIESCENT' }, name);
    assert.deepEqual(await receiptNames(f, 'fence-'), [], name);
  }
});

test('verify refuses analytics outside the pinned shape, refused analytics and resumed or redeployed fenced writers', async t => {
  const body = account => ({ data: { viewer: { accounts: account === undefined ? [] : [account] } }, errors: null });
  const cases = {
    FENCE_ANALYTICS_INVALID: [
      world => { world.analytics.raw = query => (query === FENCE_GRAPHQL_QUERIES.d1Writes
        ? body({ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: 0, writeQueries: 0 }, dimensions: { databaseId: D1.legacy } }] }) : null); },
      world => { world.analytics.raw = query => (query === FENCE_GRAPHQL_QUERIES.invocations
        ? body({ workersInvocationsAdaptive: [{ sum: { requests: 0 }, dimensions: { scriptName: 'synthetic-unrelated' } }] }) : null); },
      world => { world.analytics.raw = () => body(undefined); },
      // A second account carrying the writes is never read past.
      world => { world.analytics.raw = () => ({ data: { viewer: { accounts: [
        { d1AnalyticsAdaptiveGroups: [], workersInvocationsAdaptive: [] },
        { d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: 5, writeQueries: 5 }, dimensions: { databaseId: D1.ingestion } }],
          workersInvocationsAdaptive: [{ sum: { requests: 5 }, dimensions: { scriptName: 'synthetic-analytics' } }] },
      ] } }, errors: null }); },
      world => { world.analytics.raw = query => (query === FENCE_GRAPHQL_QUERIES.d1Writes
        ? body({ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: -1, writeQueries: 0 }, dimensions: { databaseId: D1.ledger } }] }) : null); },
    ],
    // Partial authorization alongside well-formed empty groups is never zero writes.
    FENCE_ANALYTICS_REFUSED: [
      world => { world.analytics.raw = () => ({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [], workersInvocationsAdaptive: [] }] } },
        errors: [{ message: 'synthetic partial authorization' }] }); },
    ],
    FENCE_NOT_APPLIED: [
      world => { world.queues.get(QUEUE).settings.delivery_paused = false; },
      world => { world.scripts.get('synthetic-publication').crons = ['*/5 * * * *']; },
    ],
    FENCE_INVENTORY_CHANGED: [
      world => { world.now = T0 + 10 * MINUTE; world.deploy('synthetic-publication', [[analyticsBindings(), 100]]); },
    ],
    FENCE_HISTORY_INCOMPLETE: [
      world => { for (let index = 0; index < 25; index += 1) { world.now = T0 + index * 1000; world.deployProduction('fenced'); } },
    ],
  };
  for (const [code, changes] of Object.entries(cases)) {
    for (const [index, change] of changes.entries()) {
      const f = await fixture(t);
      const { planned } = await applied(f);
      change(f.world);
      f.world.now = VERIFY_AT;
      await assert.rejects(f.run('verify', { fence: planned.sha256 }), { code }, `${code} ${index}`);
      assert.deepEqual(await receiptNames(f, 'fence-'), [], `${code} ${index}`);
    }
  }
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
    f.world.now = VERIFY_AT;
    await assert.rejects(f.run('verify', { fence: planned.sha256 }), { code: 'PRODUCTION_WORKER_NOT_FENCED' }, name);
    assert.deepEqual(await receiptNames(f, 'fence-'), [], name);
  }
});

test('release refuses without --pre-gcp or after any gcp version, and otherwise restores the exact prior state', async t => {
  const f = await fixture(t);
  const { planned } = await applied(f);
  const before = f.world.calls.length;
  await assert.rejects(f.run('release', { confirm: planned.sha256 }), { code: 'FENCE_RELEASE_REQUIRES_PRE_GCP' });
  await assert.rejects(f.run('release', { preGcp: true }), { code: 'FENCE_CONFIRMATION_REQUIRED' });
  await assert.rejects(f.run('release', { confirm: '0'.repeat(64), preGcp: true }), { code: 'FENCE_CONFIRMATION_MISMATCH' });
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
  assert.equal(released.receipt.releasedFrom, 'apply');
  assert.equal(released.receipt.applyReceiptSha256, third.apply.sha256);
  assert.match(released.receipt.applyIntentSha256, /^[a-f0-9]{64}$/);
  assert.equal((await stat(released.path)).mode & 0o777, 0o600);
  await assert.rejects(h.run('release', { confirm: third.planned.sha256, preGcp: true }), { code: 'FENCE_ALREADY_RELEASED' });
  await assert.rejects(h.run('verify', { fence: third.planned.sha256 }), { code: 'FENCE_RELEASED' });
  // A released fence is over; re-applying its plan receipt would reuse a stale journal and R2 baseline.
  await assert.rejects(apply(h, third.planned), { code: 'FENCE_RELEASED' });
  assert.equal(h.mutations().length, 2 * (CRON_SCRIPTS.length + 1));

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

test('release never overwrites a consumer someone resumed, and fails closed on a provider that does not persist', async t => {
  // Delivery was already paused before the fence, so apply left it alone;
  // someone resuming it during the fence is not the fence's to undo.
  const f = await fixture(t);
  f.world.queues.get(QUEUE).settings.delivery_paused = true;
  const { planned } = await applied(f);
  assert.equal(f.mutations().filter(call => call.method === 'PATCH').length, 0);
  f.world.queues.get(QUEUE).settings.delivery_paused = false;
  const before = f.mutations().length;
  await assert.rejects(f.run('release', { confirm: planned.sha256, preGcp: true }), { code: 'CONSUMER_DRIFT' });
  assert.equal(f.mutations().length, before);
  for (const method of ['PUT', 'PATCH']) {
    const g = await fixture(t);
    const { planned: fenced } = await applied(g);
    g.world.lie[method] = 'unpersisted';
    await assert.rejects(g.run('release', { confirm: fenced.sha256, preGcp: true }), { code: 'FENCE_RELEASE_UNVERIFIED' }, method);
    assert.deepEqual(await receiptNames(g, 'release-'), [], method);
  }
});

test('release restores the journalled prior state after an apply that stopped partway and cannot resume', async t => {
  const scenarios = {
    // The owner brakes production back to worker mode.
    brake: { code: 'PRODUCTION_WORKER_NOT_FENCED', change: world => world.deployProduction('worker') },
    // A fenced script picks up a new version (for example a secret put).
    redeploy: { code: 'FENCE_INVENTORY_CHANGED', change: world => world.deploy('synthetic-publication', [[analyticsBindings(), 100]]) },
  };
  for (const [name, { code, change }] of Object.entries(scenarios)) {
    for (const landed of [false, true]) {
      const label = `${name} ${landed ? 'landed' : 'lost'}`;
      const f = await fixture(t);
      const planned = await f.run('plan');
      f.world.now = T0 - MINUTE;
      f.world.deployProduction('fenced');
      f.world.now = T0;
      // Mutation order: analytics PUT, cache-retention PUT, catch-up PATCH,
      // then the graph-day PUT fails; its outcome is uncertain either way.
      f.world.failPutNumber = 3;
      f.world.failPutLanded = landed;
      await assert.rejects(apply(f, planned), { code: 'FENCE_MUTATION_UNCERTAIN' }, label);
      f.world.failPutNumber = null;
      assert.deepEqual(f.world.scripts.get('synthetic-analytics').crons, [], label);
      assert.deepEqual(f.world.scripts.get('synthetic-graph-day').crons, landed ? [] : CRONS['synthetic-graph-day'], label);
      assert.equal(f.world.queues.get(QUEUE).settings.delivery_paused, true, label);
      f.world.now = T0 + 5 * MINUTE;
      change(f.world);
      await assert.rejects(apply(f, planned), { code }, label);
      assert.deepEqual(await receiptNames(f, `apply-${planned.sha256}`), [], label);
      f.world.now = T0 + 10 * MINUTE;
      const writesBefore = f.mutations().length;
      const released = await f.run('release', { confirm: planned.sha256, preGcp: true });
      for (const script of CRON_SCRIPTS) assert.deepEqual(f.world.scripts.get(script).crons, [...CRONS[script]].sort(), `${label} ${script}`);
      assert.equal(f.world.queues.get(QUEUE).settings.delivery_paused, false, label);
      // Only what the partial apply changed is written back.
      assert.equal(f.mutations().length - writesBefore, landed ? 4 : 3, label);
      assert.equal(released.receipt.releasedFrom, 'apply-intent', label);
      assert.equal(released.receipt.applyReceiptSha256, null, label);
      assert.equal(released.receipt.mutationsIssued, landed ? 4 : 3, label);
      await assert.rejects(apply(f, planned), { code: 'FENCE_RELEASED' }, label);
      await assert.rejects(f.run('verify', { fence: planned.sha256 }), { code: 'FENCE_RELEASED' }, label);
      await assert.rejects(f.run('release', { confirm: planned.sha256, preGcp: true }), { code: 'FENCE_ALREADY_RELEASED' }, label);
    }
  }
  // The journal still refuses a release once gcp has been deployed since the fence.
  const g = await fixture(t);
  const planned = await g.run('plan');
  g.world.now = T0 - MINUTE;
  g.world.deployProduction('fenced');
  g.world.now = T0;
  g.world.failPutNumber = 2;
  await assert.rejects(apply(g, planned), { code: 'FENCE_MUTATION_UNCERTAIN' });
  g.world.now = T0 + 5 * MINUTE;
  g.world.deployProduction('gcp');
  await assert.rejects(g.run('release', { confirm: planned.sha256, preGcp: true }), { code: 'FENCE_RELEASE_AFTER_GCP' });
});

test('the fence receipt reader enforces the closed shape, its own receipts directory and the release', async t => {
  const f = await fixture(t);
  const { planned } = await applied(f);
  f.world.now = VERIFY_AT;
  const verified = await f.run('verify', { fence: planned.sha256 });
  const variant = async (mutate, directory = f.receipts) => {
    const value = structuredClone(verified.receipt);
    mutate(value);
    const bytes = `${JSON.stringify(value)}\n`;
    const path = join(directory, `fence-${sha256(bytes)}.json`);
    await writeFile(path, bytes, { mode: 0o600 });
    return readCloudflareWriterFenceReceipt(path, sha256(bytes));
  };
  const other = '9'.repeat(64);
  const invalid = {
    extraKey: value => { value.extra = true; },
    emptyWindow: value => { value.window = {}; },
    shortQuiet: value => { value.window.quietWindowMinutes = 10; },
    earlyStart: value => { value.window.start = value.window.appliedAt; value.analytics.window.start = value.window.appliedAt; },
    nonCanonicalEnd: value => { value.window.end = value.window.end.replace('.000Z', 'Z'); },
    verifiedAtDrift: value => { value.verifiedAt = value.window.start; },
    duplicateLabels: value => { value.d1 = value.d1.map(item => ({ ...item, label: 'ingestion' })); },
    missingLabel: value => { value.d1 = value.d1.slice(0, 3); },
    duplicateDatabase: value => { value.d1[1].idSha256 = value.d1[0].idSha256; },
    badBookmark: value => { value.d1[0].bookmark = 'x'; },
    noFencedScripts: value => { value.fencedScripts = []; },
    fencedExtraKey: value => { value.fencedScripts[0].extra = 1; },
    fencedCron: value => { value.fencedScripts[0].crons = ['* * * * *']; },
    resumedDelivery: value => { value.fencedScripts.find(item => item.kind === 'queue-consumer').deliveryPaused = false; },
    productionPartial: value => { value.productionWorker = { mode: 'fenced' }; },
    productionWorkerMode: value => { value.productionWorker.mode = 'worker'; },
    r2Negative: value => { value.r2.objects = -1; },
    r2ExtraKey: value => { value.r2.extra = 1; },
    r2NotBaseline: value => { value.r2.inventorySha256 = other; },
    analyticsNoDatabases: value => { value.analytics.d1 = []; },
    analyticsDuplicate: value => { value.analytics.d1[1].label = 'ingestion'; },
    analyticsWrites: value => { value.analytics.d1[2].rowsWritten = 1; },
    analyticsInvocations: value => { value.analytics.fencedScriptInvocations = 1; },
    analyticsQuery: value => { value.analytics.querySha256.d1Writes = other; },
    analyticsNoLag: value => { value.analytics.window.end = value.window.end; },
    analyticsEmptyWindow: value => { value.analytics.window = {}; },
    applyReceiptMismatch: value => { value.applyReceiptSha256 = other; },
  };
  for (const [name, mutate] of Object.entries(invalid)) {
    await assert.rejects(variant(mutate), { code: 'FENCE_RECEIPT_INVALID' }, name);
  }
  // Away from its receipts directory the release state is unknowable, so it refuses.
  const elsewhere = join(f.root, 'copied');
  await mkdir(elsewhere, { mode: 0o700 });
  await assert.rejects(variant(() => {}, elsewhere), { code: 'FENCE_RECEIPT_INVALID' });
  await chmod(f.receipts, 0o755);
  await assert.rejects(readCloudflareWriterFenceReceipt(verified.path, verified.sha256), { code: 'FENCE_RECEIPTS_DIRECTORY_UNSAFE' });
  await chmod(f.receipts, 0o700);
  assert.deepEqual(await readCloudflareWriterFenceReceipt(verified.path, verified.sha256), verified.receipt);
  // Once released (the P5 abort loop), the old fence receipt is no longer proof.
  f.world.now = VERIFY_AT + 10 * MINUTE;
  await f.run('release', { confirm: planned.sha256, preGcp: true });
  await assert.rejects(readCloudflareWriterFenceReceipt(verified.path, verified.sha256), { code: 'FENCE_RELEASED' });
});

test('receipts are 0600 and hold no token, raw ids, rows, R2 keys, provider metadata or addresses', async t => {
  const f = await fixture(t);
  await f.run('inventory');
  f.world.deploy('synthetic-rogue', [[[d1('SOME_DB', D1.analytics), text('ROGUE_ORIGIN', `http://${DOC_IPV4}/`)], 100]], []);
  await assert.rejects(f.run('inventory'), { code: 'WRITER_UNACCOUNTED' });
  f.world.scripts.delete('synthetic-rogue');
  const { planned } = await applied(f);
  f.world.now = VERIFY_AT;
  await f.run('verify', { fence: planned.sha256 });
  await f.run('release', { confirm: planned.sha256, preGcp: true });
  const names = await readdir(f.receipts);
  for (const prefix of ['inventory-refusal-', 'plan-', 'apply-intent-', `apply-${planned.sha256}`, 'fence-', 'release-', 'provider-']) {
    assert.ok(names.some(name => name.startsWith(prefix)), prefix);
  }
  const forbidden = [TOKEN, ACCOUNT, BUCKET, QUEUE, OTHER_QUEUE, ...Object.values(D1), ...R2_KEYS, 'synthetic-catchup-queue',
    AUTHOR, 'synthetic-author-id', DOC_IPV4, DOC_IPV6, 'workers/message', '"results"', '"rows"'];
  for (const name of names) {
    assert.equal((await stat(join(f.receipts, name))).mode & 0o777, 0o600, name);
    if (name === 'mutex.sqlite') continue;
    const bytes = await readFile(join(f.receipts, name), 'utf8');
    for (const value of forbidden) assert.equal(bytes.includes(value), false, `${name} holds ${value.slice(0, 12)}`);
    assert.doesNotMatch(bytes, /\b\d{1,3}(?:\.\d{1,3}){3}\b|clientIP|[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){7}|[0-9a-f]{0,4}::[0-9a-f]{0,4}|@/i, name);
  }
});

test('the request budget is enforced across provider, R2 and analytics reads, before any write', async t => {
  const f = await fixture(t);
  const planned = await f.run('plan');
  f.world.deployProduction('fenced');
  f.world.now = T0;
  f.world.r2Endless = true;
  const before = f.world.calls.length;
  await assert.rejects(apply(f, planned), { code: 'FENCE_REQUEST_BUDGET' });
  assert.equal(f.world.calls.length - before, FENCE_REQUEST_BUDGETS.apply);
  assert.equal(f.mutations().length, 0);
  const g = await fixture(t);
  const { planned: fenced } = await applied(g);
  g.world.now = VERIFY_AT;
  g.world.r2Endless = true;
  const start = g.world.calls.length;
  await assert.rejects(g.run('verify', { fence: fenced.sha256 }), { code: 'FENCE_REQUEST_BUDGET' });
  assert.equal(g.world.calls.length - start, FENCE_REQUEST_BUDGETS.verify);
});

test('GraphQL query texts are pinned by sha256', () => {
  for (const [name, value] of Object.entries(FENCE_GRAPHQL_QUERIES)) {
    assert.equal(sha256(value), FENCE_GRAPHQL_QUERY_SHA256[name]);
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
  // Only a code, plus a well-formed refusal receipt name; never message text.
  const leaky = Object.assign(new Error(`token ${TOKEN}`), { code: 'WRITER_UNACCOUNTED', refusalReceipt: '../../etc/passwd' });
  assert.equal(cloudflareWriterFenceErrorLine(leaky), 'WRITER_UNACCOUNTED\n');
  assert.equal(cloudflareWriterFenceErrorLine(new Error(`token ${TOKEN}`)), 'FENCE_FAILED\n');
});


test('paginated deployment lifetime does not prevent complete current writer inventory', async t => {
  const f=await fixture(t);
  const script=f.world.scripts.get('synthetic-guard');
  const head=script.deployments[0];
  for(let i=1;i<171;i++)script.deployments.push({...head,id:`synthetic-history-${i}`,created_on:iso(T0-i*MINUTE)});
  await f.run('inventory');
  assert.equal(f.mutations().length,0);
});

test('deployment page metadata and current weightset ambiguity refuse before mutation', async t => {
  for(const scenario of ['wrong-page','wrong-count','wrong-limit','wrong-total','missing-info','partial-head','duplicate-version']) {
    const f=await fixture(t), base=f.world.fetcher;
    f.world.fetcher=async(url,init)=>{
      const response=await base(url,init);
      if(!new URL(url).pathname.endsWith('/deployments'))return response;
      const body=await response.json();
      if(scenario==='wrong-page')body.result_info.page=2;
      if(scenario==='wrong-count')body.result_info.count++;
      if(scenario==='wrong-limit')body.result_info.per_page=10;
      if(scenario==='wrong-total')body.result_info.total_count++;
      if(scenario==='missing-info')delete body.result_info;
      if(scenario==='partial-head')body.result.deployments[0].versions[0].percentage=50;
      if(scenario==='duplicate-version')body.result.deployments[0].versions=[{...body.result.deployments[0].versions[0],percentage:50},{...body.result.deployments[0].versions[0],percentage:50}];
      return Response.json(body);
    };
    await assert.rejects(f.run('inventory'),{code:scenario.endsWith('head')||scenario==='duplicate-version'?'FENCE_PROVIDER_RESPONSE_INVALID':'PRODUCTION_MAINTENANCE_DEPLOYMENT_PAGE_INVALID'});
    assert.equal(f.mutations().length,0);
  }
});

test('script and queue inventory pagination still refuse before mutations', async t => {
  for(const endpoint of ['/workers/scripts','/queues']) {
    const f=await fixture(t),base=f.world.fetcher;
    f.world.fetcher=async(url,init)=>{
      const response=await base(url,init);
      if(!new URL(url).pathname.endsWith(endpoint))return response;
      const body=await response.json();body.result_info={page:1,count:1,total_count:2,total_pages:2};return Response.json(body);
    };
    await assert.rejects(f.run('inventory'),{code:'PRODUCTION_MAINTENANCE_INVENTORY_UNBOUNDED'});
    assert.equal(f.mutations().length,0);
  }
});


test('history proves only the complete newest prefix through its anchor, despite older lifetime pages', async t => {
  const f=await fixture(t);const {planned}=await applied(f);
  const script=f.world.scripts.get('synthetic-production');
  const oldest=script.deployments.at(-1);
  for(let i=1;i<171;i++)script.deployments.push({...oldest,id:`synthetic-old-${i}`,created_on:iso(Date.parse(oldest.created_on)-i*MINUTE)});
  f.world.now=VERIFY_AT;
  await f.run('verify',{fence:planned.sha256});
});

test('history refuses missing anchors, duplicates, ambiguous order and racing current heads', async t => {
  for(const scenario of ['missing-anchor','duplicate','order','race']) {
    const f=await fixture(t);const {planned}=await applied(f);f.world.now=VERIFY_AT;
    const base=f.world.fetcher;let historySeen=false;
    f.world.fetcher=async(url,init)=>{
      const response=await base(url,init),parsed=new URL(url);
      if(!parsed.pathname.endsWith('/synthetic-production/deployments'))return response;
      const body=await response.json();
      if(parsed.searchParams.get('per_page')==='25') {
        historySeen=true;
        if(scenario==='missing-anchor')body.result.deployments=body.result.deployments.slice(1);
        if(scenario==='duplicate')body.result.deployments.push(body.result.deployments[0]);
        if(scenario==='order')body.result.deployments[1].created_on=body.result.deployments[0].created_on;
        body.result_info.count=body.result.deployments.length;body.result_info.total_count=body.result.deployments.length;body.result_info.total_pages=1;
      } else if(scenario==='race'&&historySeen)body.result.deployments[0].id='synthetic-raced-head';
      return Response.json(body);
    };
    await assert.rejects(f.run('verify',{fence:planned.sha256}),{code:'FENCE_HISTORY_INCOMPLETE'},scenario);
    assert.deepEqual(await receiptNames(f,'fence-'),[]);
  }
});
