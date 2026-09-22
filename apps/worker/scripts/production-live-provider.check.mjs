import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductionLiveProvider } from './production-live-provider.mjs';
import { TYPED_PRODUCTION_QUERIES } from './production-typed-preflight.mjs';

const id = '11111111-1111-1111-1111-111111111111';
const next = '22222222-2222-2222-2222-222222222222';
const token = 'synthetic-only-provider-token';
function fixture({ drift = false, mixed = false, paged = false, refused = false, huge = false } = {}) {
  const calls = [];
  let activeReads = 0;
  const provider = createProductionLiveProvider({ accountId: 'a'.repeat(32), workerName: 'synthetic-worker',
    environment: { CLOUDFLARE_API_TOKEN: token },
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      assert.equal(options.method, 'GET');
      assert.ok(options.signal);
      const path = new URL(url).pathname;
      let result;
      if (path.endsWith('/deployments')) {
        activeReads += 1;
        result = { deployments: [{ versions: [{ version_id: drift && activeReads > 1 ? next : id, percentage: mixed ? 50 : 100 }] }] };
      } else if (path.endsWith(`/versions/${id}`)) result = { id, resources: { bindings: [] } };
      else if (path.endsWith('/settings')) result = { bindings: [] };
      else if (path.endsWith('/schedules')) result = { schedules: [{ cron: '* * * * *' }] };
      else if (path.endsWith('/subdomain')) result = { enabled: false, previews_enabled: false };
      else if (path.endsWith('/routes') || path.endsWith('/records') || path.endsWith('/namespaces')) result = [];
      else assert.fail('Unexpected endpoint');
      if (huge) return new Response('x'.repeat(2_000_001));
      return Response.json({ success: !refused, result,
        result_info: { total_pages: path.endsWith('/deployments') || paged ? 2 : 1 } }, { status: refused ? 403 : 200 });
    } });
  return { provider, calls };
}

test('captures bounded inventory using GET only, checks active version twice, redacts evidence', async () => {
  const { provider, calls } = fixture();
  const result = await provider.capture();
  assert.equal(result.version.id, id);
  assert.equal(result.schedules.schedules.length, 1);
  assert.equal(calls.filter((c) => c.url.endsWith('/deployments')).length, 2);
  assert.equal(calls.length, 9);
  assert.equal(JSON.stringify(provider.evidence()).includes(token), false);
  assert.equal(JSON.stringify(provider.evidence()).includes('synthetic-worker'), false);
});

for (const [option, code] of [['drift', 'PREDECESSOR_CHANGED'], ['mixed', 'DEPLOYMENT_AMBIGUOUS'],
  ['paged', 'INVENTORY_UNBOUNDED'], ['refused', 'READ_REFUSED'], ['huge', 'RESPONSE_TOO_LARGE']]) {
  test(`refuses ${option} without exposing provider data`, async () => {
    const { provider } = fixture({ [option]: true });
    await assert.rejects(provider.capture(), { code: `PRODUCTION_LIVE_${code}` });
  });
}

test('refuses credentials, account ambiguity and endpoint overrides before network use', () => {
  for (const [options, code] of [
    [{ accountId: 'bad' }, 'IDENTITY_INVALID'],
    [{ environment: {} }, 'CREDENTIAL_REQUIRED'],
    [{ environment: { CLOUDFLARE_API_TOKEN: token, CF_API_BASE_URL: 'https://synthetic.invalid' } }, 'ENVIRONMENT_OVERRIDE'],
  ]) {
    assert.throws(() => createProductionLiveProvider({ accountId: 'a'.repeat(32), workerName: 'synthetic-worker',
      ...options, fetchImpl: () => assert.fail('No network expected') }), { code: `PRODUCTION_LIVE_${code}` });
  }
});

test('schema reader admits only fixed SELECTs and exact known database identities', async () => {
  const accountId = 'a'.repeat(32);
  let requests = 0;
  const inventory = { accountId, workerName: 'synthetic-worker', version: { resources: {
    bindings: [{ name: 'USAGE_MONITOR_DB', type: 'd1', id, database_id: id }],
  } } };
  const provider = createProductionLiveProvider({ accountId, workerName: inventory.workerName,
    environment: { CLOUDFLARE_API_TOKEN: token }, fetchImpl: async (url, options) => {
      requests += 1;
      assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${id}/query`);
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { sql: TYPED_PRODUCTION_QUERIES.probe, params: [] });
      return Response.json({ success: true, result: [{ success: true, results: [{ typed_preflight_probe: 1 }] }] });
    } });
  const result = await provider.query(inventory, 'USAGE_MONITOR_DB', TYPED_PRODUCTION_QUERIES.probe);
  assert.equal(result[0].results[0].typed_preflight_probe, 1);
  for (const sql of ['DELETE FROM participants', 'SELECT 1', `${TYPED_PRODUCTION_QUERIES.probe}; DELETE FROM participants`]) {
    await assert.rejects(provider.query(inventory, 'USAGE_MONITOR_DB', sql), { code: 'PRODUCTION_LIVE_QUERY_REFUSED' });
  }
  await assert.rejects(provider.query(inventory, 'OTHER_DB', TYPED_PRODUCTION_QUERIES.probe), { code: 'PRODUCTION_LIVE_QUERY_REFUSED' });
  const changed = structuredClone(inventory);
  changed.version.resources.bindings[0].database_id = next;
  await assert.rejects(provider.query(changed, 'USAGE_MONITOR_DB', TYPED_PRODUCTION_QUERIES.probe), { code: 'PRODUCTION_LIVE_QUERY_REFUSED' });
  changed.version.resources.bindings = [...inventory.version.resources.bindings, ...inventory.version.resources.bindings];
  await assert.rejects(provider.query(changed, 'USAGE_MONITOR_DB', TYPED_PRODUCTION_QUERIES.probe), { code: 'PRODUCTION_LIVE_QUERY_REFUSED' });
  assert.equal(requests, 1);
});

test('the deployment read budget permits final verification but refuses excess network calls', async () => {
  const { provider, calls } = fixture();
  for (let index = 0; index < 8; index += 1) await provider.capture();
  assert.equal(calls.length, 72);
  await assert.rejects(provider.capture(), { code: 'PRODUCTION_LIVE_READ_BUDGET' });
  assert.equal(calls.length, 80);
  await assert.rejects(provider.capture(), { code: 'PRODUCTION_LIVE_READ_BUDGET' });
  assert.equal(calls.length, 80);
});
