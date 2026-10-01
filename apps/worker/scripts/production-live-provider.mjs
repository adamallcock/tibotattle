import { createHash } from 'node:crypto';
import { TYPED_PRODUCTION_QUERIES } from './production-typed-preflight.mjs';

const fail = (reason) => {
  const error = new Error(`PRODUCTION_LIVE_${reason}`);
  error.code = error.message;
  throw error;
};
const uuid = (value) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value ?? '');
const digest = (value) => createHash('sha256').update(value).digest('hex');

/** Read-only, fixed-account inventory and fixed SELECT probes. No deployment,
 * secret retrieval, trigger mutation, or arbitrary API path is exposed.
 * Credentials never enter results. */
export function createProductionLiveProvider({
  accountId,
  workerName,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
}) {
  if (!/^[a-f0-9]{32}$/.test(accountId ?? '')
      || !/^[a-zA-Z0-9_-]{1,63}$/.test(workerName ?? '')) fail('IDENTITY_INVALID');
  if (['CLOUDFLARE_API_BASE_URL', 'CF_API_BASE_URL', 'WRANGLER_API_ENVIRONMENT',
    'CLOUDFLARE_ENV'].some((key) => Object.hasOwn(environment, key))) fail('ENVIRONMENT_OVERRIDE');
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (typeof token !== 'string' || token.length < 16) fail('CREDENTIAL_REQUIRED');
  const account = `/accounts/${accountId}`;
  const script = `${account}/workers/scripts/${workerName}`;
  let requests = 0;
  const evidence = [];
  const get = async (path, { firstPageOnly = false, query = null } = {}) => {
    // A coordinated typed deployment uses 66 reads including the final
    // configuration capture after schema qualification. Keep a fixed ceiling.
    if (++requests > 80) fail('READ_BUDGET');
    let response;
    let bytes;
    try {
      response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
        method: query === null ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`,
          ...(query === null ? {} : { 'content-type': 'application/json' }) },
        ...(query === null ? {} : { body: JSON.stringify({ sql: query, params: [] }) }),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.body) fail('RESPONSE_INVALID');
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2_000_000) fail('RESPONSE_TOO_LARGE');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      bytes = Buffer.concat(chunks);
    } catch (error) {
      if (error?.code === 'PRODUCTION_LIVE_RESPONSE_TOO_LARGE') throw error;
      fail('READ_FAILED');
    }
    evidence.push({ pathSha256: digest(path), status: response.status,
      bytes: bytes.length, sha256: digest(bytes) });
    let body;
    try { body = JSON.parse(bytes); } catch { fail('RESPONSE_INVALID'); }
    if (!response.ok || body.success !== true) fail('READ_REFUSED');
    const page = body.result_info;
    if (!firstPageOnly && (page?.total_pages > 1 || page?.has_more === true
      || page?.cursor || (Number.isSafeInteger(page?.total_count)
        && Number.isSafeInteger(page?.count) && page.total_count > page.count))) fail('INVENTORY_UNBOUNDED');
    return body.result;
  };
  const rows = (value, key, maximum) => {
    const result = Array.isArray(value) ? value : value?.[key];
    if (!Array.isArray(result) || result.length > maximum) fail('INVENTORY_INVALID');
    return result;
  };
  const active = async () => {
    // The API lists deployments newest first. Only the active first entry is
    // needed; historical deployment pagination is deliberately irrelevant.
    const list = rows(await get(`${script}/deployments`, { firstPageOnly: true }), 'deployments', 100);
    const versions = list[0]?.versions;
    if (versions?.length !== 1 || versions[0].percentage !== 100
        || !uuid(versions[0].version_id)) fail('DEPLOYMENT_AMBIGUOUS');
    return versions[0].version_id;
  };
  return {
    async query(inventory, binding, sql) {
      if (inventory?.accountId !== accountId || inventory?.workerName !== workerName
        || !['USAGE_MONITOR_DB', 'ANALYTICS_DB', 'DELETION_LEDGER'].includes(binding)
        || !Object.values(TYPED_PRODUCTION_QUERIES).includes(sql)) fail('QUERY_REFUSED');
      const bindings = inventory.version?.resources?.bindings;
      if (!Array.isArray(bindings)) fail('QUERY_REFUSED');
      const matches = bindings.filter((row) => row.name === binding);
      const row = matches[0];
      const ids = [row?.id, row?.database_id].filter((value) => value !== undefined);
      if (matches.length !== 1 || row.type !== 'd1' || ids.length === 0
        || ids.some((value) => !uuid(value)) || new Set(ids).size !== 1) fail('QUERY_REFUSED');
      return get(`${account}/d1/database/${ids[0]}/query`, { query: sql });
    },
    async capture() {
      const id = await active();
      const version = await get(`${script}/versions/${id}`);
      if (version?.id !== id || !Array.isArray(version?.resources?.bindings)
          || version.resources.bindings.length > 100) fail('VERSION_INVALID');
      const settings = await get(`${script}/settings`);
      const schedules = rows(await get(`${script}/schedules`), 'schedules', 16);
      const subdomain = await get(`${script}/subdomain`);
      const routes = rows(await get(`${account}/workers/services/${workerName}/environments/production/routes?show_zonename=true`), 'routes', 100);
      const domains = rows(await get(`${account}/workers/domains/records?page=0&per_page=100&service=${workerName}&environment=production`), 'records', 99);
      const namespaces = rows(await get(`${account}/workers/durable_objects/namespaces?per_page=100`), 'namespaces', 99);
      // Refuse an inventory spanning two code deployments. The caller must
      // recapture and compare again at its own mutation boundary.
      if (await active() !== id) fail('PREDECESSOR_CHANGED');
      return { accountId, workerName, capturedAt: now(), version, settings,
        schedules: { schedules }, subdomain, routes, domains, namespaces };
    },
    evidence: () => structuredClone(evidence),
  };
}
