import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMaintenanceTransport } from './production-maintenance-transport.mjs';
import { maintenanceBindingDigest } from './production-maintenance-provider.mjs';
import { readMaintenanceFile } from './production-maintenance.mjs';
import { scanR2RestInventory } from './r2-rest-inventory.mjs';
import { durablePrivateJson, identityDigest, operationError } from '../../../scripts/lib/release-operation.mjs';

/*
 * The single fence for every Cloudflare writer other than the production
 * Worker, plus the quiescence proof consumed by the source export (PT-2) and
 * the analytics cutover record (HX-6).
 *
 * - inventory (read-only): classify every script against an owner plan;
 *   WRITER_UNACCOUNTED when a script outside the fence binds a listed D1 or
 *   R2 resource, SCHEDULE_DRIFT when a fenced script's crons differ.
 * - plan (read-only): inventory plus the exact mutation list; its receipt
 *   sha256 is the only accepted --confirm value.
 * - apply --confirm=<plan receipt sha256> --analytics-drain-complete: one
 *   schedules PUT [] per cron script and one delivery pause per consumer,
 *   journalled before the first write. Ordering: the production Worker must
 *   already be fenced and its analytics drain complete (the drain is proved
 *   by HX-6, not here; the operator attests to it and the receipt says so).
 * - verify --fence=<plan receipt sha256> (read-only): production Worker is
 *   one version at 100% with EDGE_UPSTREAM_MODE='fenced' since the fence;
 *   zero schedules and paused delivery; D1 time-travel bookmarks equal at a
 *   window start at least quietWindowMinutes after the last apply and at the
 *   window end, the window itself at least quietWindowMinutes long (so a
 *   verify cannot prove quiescence over an empty interval); R2 quarantine
 *   digest equal to the baseline taken at apply, before any write; GraphQL
 *   rowsWritten/writeQueries 0 per listed database and no invocation of any
 *   fenced script. Emits the fence receipt that pins bookmarks and digest.
 * - release --confirm=<plan receipt sha256> --pre-gcp: restores the exact
 *   prior schedules and delivery; refused once any gcp-mode production
 *   version has been deployed since the fence.
 *
 * Every request goes through one budgeted fetcher restricted to the
 * Cloudflare v4 API. Receipts are 0600, content-addressed or keyed by the
 * plan receipt, and hold names, binding types, id digests, crons, counts,
 * bookmarks and digests only: never the token, rows, R2 keys or addresses.
 * GraphQL analytics are provider-lagged corroboration; the D1 bookmarks are
 * the authoritative write-quiescence evidence.
 */

export const FENCE_PLAN_SCHEMA = 'cloudflare-writer-fence-plan-v1';
export const FENCE_INVENTORY_SCHEMA = 'cloudflare-writer-fence-inventory-v1';
export const FENCE_PLAN_RECEIPT_SCHEMA = 'cloudflare-writer-fence-plan-receipt-v1';
export const FENCE_APPLY_INTENT_SCHEMA = 'cloudflare-writer-fence-apply-intent-v1';
export const FENCE_APPLY_RECEIPT_SCHEMA = 'cloudflare-writer-fence-apply-v1';
export const FENCE_RECEIPT_SCHEMA = 'cloudflare-writer-fence-receipt-v1';
export const FENCE_RELEASE_RECEIPT_SCHEMA = 'cloudflare-writer-fence-release-v1';
export const FENCE_EDGE_MODE_BINDING = 'EDGE_UPSTREAM_MODE';
export const FENCE_MIN_QUIET_WINDOW_MINUTES = 15;

// Label -> the live binding that proves it, so a plan can never fence (or
// pin) a D1 other than the one production and the catch-up consumer use.
export const FENCE_D1_LABELS = Object.freeze({
  ingestion: Object.freeze({ owner: 'production', binding: 'USAGE_MONITOR_DB' }),
  analytics: Object.freeze({ owner: 'production', binding: 'ANALYTICS_DB' }),
  'deletion-ledger': Object.freeze({ owner: 'production', binding: 'DELETION_LEDGER' }),
  'catchup-control': Object.freeze({ owner: 'fenced', binding: 'STORAGE_ANALYTICS_CATCHUP_CONTROL_DB' }),
});
export const FENCE_R2_BINDING = 'QUARANTINE';

// Pinned analytics texts. workersInvocationsAdaptive counts every invocation
// of a fenced script (scheduled, queue and fetch alike), so zero requests is a
// superset of "no scheduled or queue invocation". A provider schema change
// surfaces as FENCE_ANALYTICS_REFUSED, never as a pass.
export const FENCE_GRAPHQL_QUERIES = Object.freeze({
  d1Writes: `query CloudflareWriterFenceD1Writes($accountTag: string!, $start: Time!, $end: Time!, $databaseIds: [string!]!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(limit: 100, filter: { datetime_geq: $start, datetime_leq: $end, databaseId_in: $databaseIds }) {
        sum { rowsWritten writeQueries }
        dimensions { databaseId }
      }
    }
  }
}`,
  invocations: `query CloudflareWriterFenceInvocations($accountTag: string!, $start: Time!, $end: Time!, $scriptNames: [string!]!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(limit: 100, filter: { datetime_geq: $start, datetime_leq: $end, scriptName_in: $scriptNames }) {
        sum { requests }
        dimensions { scriptName }
      }
    }
  }
}`,
});
export const FENCE_GRAPHQL_QUERY_SHA256 = Object.freeze({
  d1Writes: '1eaed45e0be7498432fd6c4fed06c14d322f006c9fe60583d14846c6314603d7',
  invocations: '6e9821035c67bf8e0490d39b24c83214cc4e33418500137144620f4cd52939c5',
});

const MAX_ACCOUNT_SCRIPTS = 50;
const MAX_ACCOUNT_QUEUES = 50;
const MAX_FENCED_SCRIPTS = 20;
const MAX_OUT_OF_SCOPE_SCRIPTS = 50;
const MAX_BINDINGS = 128;
const MAX_HISTORY_DEPLOYMENTS = 25;
const R2_PAGE_SIZE = 1_000;
// Worst case per subcommand: listing + 5 reads/script + queue list + 1
// read/queue; R2 scan 100 pages (100k objects) + 1; history 1 + 2/deployment.
const INVENTORY_READS = 1 + MAX_ACCOUNT_SCRIPTS * 5 + 1 + MAX_ACCOUNT_QUEUES;
const R2_READS = 101;
const HISTORY_READS = 1 + MAX_HISTORY_DEPLOYMENTS * 2;
export const FENCE_REQUEST_BUDGETS = Object.freeze({
  inventory: INVENTORY_READS,
  plan: INVENTORY_READS,
  apply: INVENTORY_READS + R2_READS + 2 * MAX_FENCED_SCRIPTS,
  verify: INVENTORY_READS + HISTORY_READS + 2 * Object.keys(FENCE_D1_LABELS).length + R2_READS + 2,
  release: HISTORY_READS + 3 * MAX_FENCED_SCRIPTS,
});

const API_PREFIX = 'https://api.cloudflare.com/client/v4/';
const GRAPHQL_URL = `${API_PREFIX}graphql`;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX32 = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SCRIPT = /^[a-zA-Z0-9_-]{1,63}$/;
const CRON = /^[0-9A-Za-z*/,?#\- ]{1,64}$/;
const BINDING_TYPE = /^[a-z0-9_]{1,64}$/;
const BINDING_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const OPAQUE = /^[A-Za-z0-9-]{8,128}$/;
const EDGE_MODES = new Set(['worker', 'fenced', 'gcp']);
const DEFAULT_CLI_PATH = fileURLToPath(new URL('../node_modules/wrangler/wrangler-dist/cli.js', import.meta.url));

const fail = code => { throw operationError(code); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const idDigest = (kind, value) => sha256(`${kind}:${value}`);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys, code) => {
  if (!record(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) fail(code);
};
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const iso = ms => new Date(ms).toISOString();
const rows = (value, key, maximum, code = 'FENCE_PROVIDER_RESPONSE_INVALID') => {
  const list = Array.isArray(value) ? value : key === null ? undefined : value?.[key];
  if (!Array.isArray(list)) fail('FENCE_PROVIDER_RESPONSE_INVALID');
  if (list.length > maximum) fail(code);
  return list;
};
const cronList = (value, code) => {
  if (!Array.isArray(value) || value.length > 16) fail(code);
  const crons = value.map(cron => { if (typeof cron !== 'string' || !CRON.test(cron)) fail(code); return cron; });
  if (new Set(crons).size !== crons.length) fail(code);
  return crons.sort();
};

function bucketName(value, code) {
  if (typeof value !== 'string' || value.length < 3 || Buffer.byteLength(value) > 64
      || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value)) fail(code);
  return value;
}

/** Closed, content-free owner plan. Labels come from the live typed snapshot. */
export function validateCloudflareWriterFencePlan(value) {
  const code = 'FENCE_PLAN_INVALID';
  exactKeys(value, ['schema', 'accountId', 'productionWorker', 'fencedScripts', 'dataResources',
    'outOfScopeScripts', 'quietWindowMinutes'], code);
  if (value.schema !== FENCE_PLAN_SCHEMA || !HEX32.test(value.accountId ?? '')
      || !SCRIPT.test(value.productionWorker ?? '')) fail(code);
  if (!Number.isSafeInteger(value.quietWindowMinutes)
      || value.quietWindowMinutes < FENCE_MIN_QUIET_WINDOW_MINUTES || value.quietWindowMinutes > 1_440) fail(code);
  if (!Array.isArray(value.fencedScripts) || value.fencedScripts.length < 1
      || value.fencedScripts.length > MAX_FENCED_SCRIPTS) fail(code);
  const names = new Set([value.productionWorker]);
  const queueIds = new Set();
  const fencedScripts = value.fencedScripts.map(item => {
    if (!record(item)) fail(code);
    exactKeys(item, item.kind === 'queue-consumer' ? ['name', 'kind', 'expectedCrons', 'queueId']
      : ['name', 'kind', 'expectedCrons'], code);
    if (!SCRIPT.test(item.name ?? '') || names.has(item.name)) fail(code);
    names.add(item.name);
    const expectedCrons = cronList(item.expectedCrons, code);
    if (item.kind === 'cron') {
      if (expectedCrons.length === 0) fail(code);
      return Object.freeze({ name: item.name, kind: 'cron', expectedCrons: Object.freeze(expectedCrons), queueId: null });
    }
    if (item.kind !== 'queue-consumer' || expectedCrons.length !== 0 || !HEX32.test(item.queueId ?? '')
        || queueIds.has(item.queueId)) fail(code);
    queueIds.add(item.queueId);
    return Object.freeze({ name: item.name, kind: 'queue-consumer', expectedCrons: Object.freeze([]), queueId: item.queueId });
  });
  if (!Array.isArray(value.dataResources) || value.dataResources.length !== Object.keys(FENCE_D1_LABELS).length + 1) fail(code);
  const d1 = {};
  let r2 = null;
  for (const item of value.dataResources) {
    if (record(item) && item.kind === 'd1') {
      exactKeys(item, ['kind', 'id', 'label'], code);
      if (!UUID.test(item.id ?? '') || !Object.hasOwn(FENCE_D1_LABELS, item.label ?? '')
          || Object.hasOwn(d1, item.label) || Object.values(d1).includes(item.id)) fail(code);
      d1[item.label] = item.id;
    } else if (record(item) && item.kind === 'r2') {
      exactKeys(item, ['kind', 'bucket'], code);
      if (r2 !== null) fail(code);
      r2 = bucketName(item.bucket, code);
    } else fail(code);
  }
  if (r2 === null || Object.keys(d1).length !== Object.keys(FENCE_D1_LABELS).length) fail(code);
  if (!Array.isArray(value.outOfScopeScripts) || value.outOfScopeScripts.length > MAX_OUT_OF_SCOPE_SCRIPTS) fail(code);
  const outOfScopeScripts = value.outOfScopeScripts.map(item => {
    exactKeys(item, ['name', 'reason'], code);
    if (!SCRIPT.test(item.name ?? '') || names.has(item.name) || typeof item.reason !== 'string'
        || item.reason.length < 1 || item.reason.length > 200 || /[\u0000-\u001f\u007f]/u.test(item.reason)) fail(code);
    names.add(item.name);
    return Object.freeze({ name: item.name, reason: item.reason });
  });
  return Object.freeze({
    planSha256: identityDigest(value),
    accountId: value.accountId,
    productionWorker: value.productionWorker,
    fencedScripts: Object.freeze(fencedScripts.sort((a, b) => a.name.localeCompare(b.name))),
    d1: Object.freeze(Object.fromEntries(Object.keys(FENCE_D1_LABELS).map(label => [label, d1[label]]))),
    r2: Object.freeze({ bucket: r2 }),
    outOfScopeScripts: Object.freeze(outOfScopeScripts.sort((a, b) => a.name.localeCompare(b.name))),
    quietWindowMinutes: value.quietWindowMinutes,
  });
}

function databaseBindingId(binding) {
  const aliases = [binding.id, binding.database_id].filter(item => item !== undefined);
  if (!aliases.length || aliases.some(item => !UUID.test(item ?? '')) || new Set(aliases).size !== 1) {
    fail('FENCE_PROVIDER_RESPONSE_INVALID');
  }
  return aliases[0];
}

// In-memory binding view. Raw ids and var text never leave this process;
// receipts carry only {type, name, ref digest}.
function normalizeBinding(binding) {
  if (!record(binding) || !BINDING_TYPE.test(binding.type ?? '') || !BINDING_NAME.test(binding.name ?? '')) {
    fail('FENCE_PROVIDER_RESPONSE_INVALID');
  }
  const view = { type: binding.type, name: binding.name, d1Id: null, bucket: null, service: null, text: null, ref: null };
  if (binding.type === 'd1') {
    view.d1Id = databaseBindingId(binding);
    view.ref = idDigest('d1', view.d1Id);
  } else if (binding.type === 'r2_bucket') {
    view.bucket = bucketName(binding.bucket_name, 'FENCE_PROVIDER_RESPONSE_INVALID');
    view.ref = idDigest('r2', view.bucket);
  } else if (binding.type === 'service') {
    if (!SCRIPT.test(binding.service ?? '')) fail('FENCE_PROVIDER_RESPONSE_INVALID');
    view.service = binding.service;
    view.ref = idDigest('service', view.service);
  } else if (binding.type === 'queue') {
    if (typeof binding.queue_name !== 'string' || !/^[A-Za-z0-9_-]{1,63}$/.test(binding.queue_name)) {
      fail('FENCE_PROVIDER_RESPONSE_INVALID');
    }
    view.ref = idDigest('queue-name', binding.queue_name);
  } else if (binding.type === 'plain_text') {
    if (typeof binding.text !== 'string' || binding.text.length > 4_096) fail('FENCE_PROVIDER_RESPONSE_INVALID');
    view.text = binding.text;
  }
  return view;
}
const publicBinding = ({ type, name, ref }) => (ref === null ? { type, name } : { type, name, ref });
const sortBindings = list => [...list].sort((a, b) => `${a.type}\u0000${a.name}\u0000${a.ref}`
  .localeCompare(`${b.type}\u0000${b.name}\u0000${b.ref}`));

function plainText(bindings, name) {
  const matches = bindings.filter(binding => binding.name === name);
  if (matches.length === 0) return null;
  if (matches.length !== 1 || matches[0].type !== 'plain_text') fail('FENCE_PROVIDER_RESPONSE_INVALID');
  return matches[0].text;
}
const edgeMode = bindings => {
  const text = plainText(bindings, FENCE_EDGE_MODE_BINDING);
  return text === null ? null : EDGE_MODES.has(text) ? text : 'unrecognized';
};

function deploymentOf(value) {
  if (!record(value) || typeof value.id !== 'string' || !OPAQUE.test(value.id)
      || !Number.isFinite(Date.parse(value.created_on ?? '')) || !Array.isArray(value.versions)
      || value.versions.length < 1 || value.versions.length > 2) fail('FENCE_PROVIDER_RESPONSE_INVALID');
  const versions = value.versions.map(item => {
    if (!record(item) || !UUID.test(item.version_id ?? '') || typeof item.percentage !== 'number'
        || !(item.percentage >= 0 && item.percentage <= 100)) fail('FENCE_PROVIDER_RESPONSE_INVALID');
    return { versionId: item.version_id, percentage: item.percentage };
  });
  if (Math.abs(versions.reduce((total, item) => total + item.percentage, 0) - 100) > 1e-9) {
    fail('FENCE_PROVIDER_RESPONSE_INVALID');
  }
  return { deploymentId: value.id, createdOnMs: Date.parse(value.created_on), versions };
}
const singleVersion = deployment => deployment !== null && deployment.versions.length === 1
  && deployment.versions[0].percentage === 100;

async function assertPrivateDirectory(path) {
  let info;
  let canonical;
  try { info = await lstat(path); canonical = await realpath(path); } catch { fail('FENCE_RECEIPTS_DIRECTORY_UNSAFE'); }
  if (!info.isDirectory() || canonical !== resolve(path) || (info.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) fail('FENCE_RECEIPTS_DIRECTORY_UNSAFE');
}

// Same mutex discipline as openOperation: an OS lock released on process
// death, so a crashed apply or release can resume without manual cleanup.
async function lockReceipts(directory) {
  const path = join(directory, 'mutex.sqlite');
  try {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.close();
  } catch (error) { if (error?.code !== 'EEXIST') fail('FENCE_RECEIPTS_DIRECTORY_UNSAFE'); }
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) fail('FENCE_RECEIPTS_DIRECTORY_UNSAFE');
  let mutex;
  try {
    mutex = new DatabaseSync(path);
    mutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  } catch {
    mutex?.close();
    fail('FENCE_BUSY');
  }
  return () => mutex.close();
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    fail('FENCE_RECEIPT_UNSAFE');
  }
}

async function readReceipt(path, schema) {
  let bytes;
  try { bytes = await readMaintenanceFile(path, 1024 * 1024); } catch { fail('FENCE_RECEIPT_UNSAFE'); }
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('FENCE_RECEIPT_INVALID'); }
  if (!record(value) || value.schema !== schema) fail('FENCE_RECEIPT_INVALID');
  return { value, sha256: sha256(bytes) };
}

async function writeReceipt(path, value) {
  await durablePrivateJson(path, value);
  return { path, sha256: sha256(`${JSON.stringify(value)}\n`), receipt: value };
}
const contentPath = (directory, prefix, value) => join(directory, `${prefix}-${sha256(`${JSON.stringify(value)}\n`)}.json`);

async function boundedBytes(response, maximum) {
  if (!response?.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) fail('FENCE_ANALYTICS_UNBOUNDED');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts);
}

/** One budgeted, Cloudflare-v4-only fetcher shared by the maintenance
 * transport, the R2 scan and the pinned analytics reads. */
function createFenceClient({ plan, subcommand, receiptsDirectory, cliPath, fetcher, environment }) {
  const limit = FENCE_REQUEST_BUDGETS[subcommand];
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (typeof token !== 'string' || token.length < 16) fail('FENCE_CREDENTIAL_REQUIRED');
  let used = 0;
  let exceeded = false;
  const guarded = (url, init) => {
    const href = url instanceof URL ? url.href : String(url);
    if (!href.startsWith(API_PREFIX)) return Promise.reject(operationError('FENCE_ENDPOINT_REFUSED'));
    if (used >= limit) { exceeded = true; return Promise.reject(operationError('FENCE_REQUEST_BUDGET')); }
    used += 1;
    return fetcher(url, init);
  };
  const transport = createMaintenanceTransport({
    plan: { accountId: plan.accountId }, operationDirectory: receiptsDirectory, cliPath, fetcher: guarded, environment,
  });
  const graphql = async (name, variables) => {
    let response;
    let bytes;
    try {
      response = await guarded(GRAPHQL_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: FENCE_GRAPHQL_QUERIES[name], variables }),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      bytes = await boundedBytes(response, 1_000_000);
    } catch (error) {
      if (error?.code === 'FENCE_ANALYTICS_UNBOUNDED') throw error;
      fail('FENCE_ANALYTICS_UNAVAILABLE');
    }
    let body;
    try { body = JSON.parse(bytes.toString('utf8')); } catch { fail('FENCE_ANALYTICS_INVALID'); }
    if (!response.ok || !record(body) || !record(body.data)
        || !(body.errors === undefined || body.errors === null || (Array.isArray(body.errors) && body.errors.length === 0))) {
      fail('FENCE_ANALYTICS_REFUSED');
    }
    const accounts = body.data.viewer?.accounts;
    if (!Array.isArray(accounts) || accounts.length !== 1 || !record(accounts[0])) fail('FENCE_ANALYTICS_INVALID');
    return accounts[0];
  };
  const r2Digest = async () => {
    const result = await scanR2RestInventory({
      accountId: plan.accountId, bucketName: plan.r2.bucket, token, pageSize: R2_PAGE_SIZE, fetchImpl: guarded,
    });
    return { bucketSha256: idDigest('r2', plan.r2.bucket), inventorySha256: result.inventorySha256,
      objects: result.objects, bytes: result.bytes };
  };
  return {
    api: transport.api,
    graphql,
    r2Digest,
    remaining: () => limit - used,
    get exceeded() { return exceeded; },
  };
}

async function readScript(client, plan, name, classification) {
  const path = `/accounts/${plan.accountId}/workers/scripts/${name}`;
  const deployments = rows(await client.api(`${path}/deployments`), 'deployments', 100);
  if (deployments.length === 0 && classification !== 'unlisted' && classification !== 'out-of-scope') {
    fail('FENCE_DEPLOYMENT_UNKNOWN');
  }
  const deployment = deployments.length === 0 ? null : deploymentOf(deployments[0]);
  const versions = [];
  for (const item of deployment?.versions ?? []) {
    const version = await client.api(`${path}/versions/${item.versionId}`);
    const bindings = version?.resources?.bindings;
    if (!record(version) || version.id !== item.versionId || !Array.isArray(bindings) || bindings.length > MAX_BINDINGS) {
      fail('FENCE_PROVIDER_RESPONSE_INVALID');
    }
    versions.push({ ...item, bindingsSha256: maintenanceBindingDigest(bindings), bindings: bindings.map(normalizeBinding) });
  }
  const settings = await client.api(`${path}/settings`);
  if (!record(settings) || !Array.isArray(settings.bindings) || settings.bindings.length > MAX_BINDINGS) {
    fail('FENCE_PROVIDER_RESPONSE_INVALID');
  }
  const schedules = rows(await client.api(`${path}/schedules`), 'schedules', 16);
  const crons = cronList(schedules.map(item => item?.cron), 'FENCE_PROVIDER_RESPONSE_INVALID');
  return {
    name, classification, deployment, versions, crons,
    settingsBindingsSha256: maintenanceBindingDigest(settings.bindings),
    settingsBindings: settings.bindings.map(normalizeBinding),
  };
}

async function readQueue(client, plan, queueId) {
  const detail = await client.api(`/accounts/${plan.accountId}/queues/${queueId}`);
  if (!record(detail) || detail.queue_id !== queueId || typeof detail.queue_name !== 'string'
      || !/^[A-Za-z0-9_-]{1,63}$/.test(detail.queue_name) || !record(detail.settings)) {
    fail('FENCE_PROVIDER_RESPONSE_INVALID');
  }
  const consumers = rows(detail.consumers, null, 20).map(item => {
    if (!record(item) || typeof item.type !== 'string') fail('FENCE_PROVIDER_RESPONSE_INVALID');
    const aliases = [item.script, item.script_name, item.service].filter(value => value !== undefined && value !== null);
    if (aliases.some(value => !SCRIPT.test(value)) || new Set(aliases).size > 1) fail('FENCE_PROVIDER_RESPONSE_INVALID');
    return { type: item.type, script: aliases[0] ?? null };
  });
  const paused = detail.settings.delivery_paused;
  return { queueId, queueName: detail.queue_name, consumers, deliveryPaused: typeof paused === 'boolean' ? paused : null };
}

/**
 * Read-only writer inventory. Fails closed on an unaccounted writer, a label
 * that is not the live binding, an unlisted resource bound by a fenced script,
 * or a consumer mapping that differs from the plan. Mutable state (crons and
 * delivery) is returned for the caller's phase-specific comparison.
 */
async function collectInventory(client, plan, { now, requireFenced }) {
  const account = `/accounts/${plan.accountId}`;
  const listed = rows(await client.api(`${account}/workers/scripts?per_page=100`), 'scripts', MAX_ACCOUNT_SCRIPTS, 'FENCE_INVENTORY_UNBOUNDED');
  const names = listed.map(item => { if (!SCRIPT.test(item?.id ?? '')) fail('FENCE_PROVIDER_RESPONSE_INVALID'); return item.id; });
  if (new Set(names).size !== names.length) fail('FENCE_PROVIDER_RESPONSE_INVALID');
  const present = new Set(names);
  if (!present.has(plan.productionWorker) || plan.fencedScripts.some(item => !present.has(item.name))) {
    fail('FENCE_PLAN_SCRIPT_MISSING');
  }
  const fenced = new Map(plan.fencedScripts.map(item => [item.name, item]));
  const outOfScope = new Map(plan.outOfScopeScripts.map(item => [item.name, item]));
  const scripts = [];
  for (const name of [...names].sort()) {
    const classification = name === plan.productionWorker ? 'production' : fenced.has(name) ? 'fenced'
      : outOfScope.has(name) ? 'out-of-scope' : 'unlisted';
    scripts.push(await readScript(client, plan, name, classification));
  }
  const allBindings = script => [...script.versions.flatMap(version => version.bindings), ...script.settingsBindings];
  const listedD1 = new Map(Object.entries(plan.d1).map(([label, id]) => [id, label]));
  const bindsListed = binding => (binding.d1Id !== null && listedD1.has(binding.d1Id)) || binding.bucket === plan.r2.bucket;

  // 1. Anything outside production and the fence that binds a listed resource.
  for (const script of scripts) {
    if ((script.classification === 'unlisted' || script.classification === 'out-of-scope')
        && allBindings(script).some(bindsListed)) fail('WRITER_UNACCOUNTED');
  }
  // 2. Production identity: one version at 100%; fenced where required.
  const production = scripts.find(script => script.classification === 'production');
  const single = singleVersion(production.deployment);
  const productionBindings = production.versions[0]?.bindings ?? [];
  const mode = single ? edgeMode(productionBindings) : null;
  if (requireFenced && (!single || mode !== 'fenced')) fail('PRODUCTION_WORKER_NOT_FENCED');
  if (!single) fail('PRODUCTION_DEPLOYMENT_AMBIGUOUS');
  const sourceCommit = plainText(productionBindings, 'DEPLOYMENT_SOURCE_COMMIT');
  // 3. Labels must be the live bindings (never the checked-in wrangler.jsonc).
  const productionBinding = (name, type) => {
    const matches = productionBindings.filter(binding => binding.name === name);
    if (matches.length !== 1 || matches[0].type !== type) fail('FENCE_RESOURCE_LABEL_MISMATCH');
    return matches[0];
  };
  for (const [label, { owner, binding }] of Object.entries(FENCE_D1_LABELS)) {
    if (owner === 'production') {
      if (productionBinding(binding, 'd1').d1Id !== plan.d1[label]) fail('FENCE_RESOURCE_LABEL_MISMATCH');
    } else {
      const ids = new Set(scripts.filter(script => script.classification === 'fenced').flatMap(allBindings)
        .filter(item => item.name === binding && item.type === 'd1').map(item => item.d1Id));
      if (ids.size !== 1 || !ids.has(plan.d1[label])) fail('FENCE_RESOURCE_LABEL_MISMATCH');
    }
  }
  if (productionBinding(FENCE_R2_BINDING, 'r2_bucket').bucket !== plan.r2.bucket) fail('FENCE_RESOURCE_LABEL_MISMATCH');
  // 4. The fence proves quiescence only for listed resources; a fenced
  // script writing anything else is outside the proof.
  for (const script of scripts.filter(item => item.classification === 'fenced')) {
    for (const binding of allBindings(script)) {
      if ((binding.d1Id !== null && !listedD1.has(binding.d1Id)) || (binding.bucket !== null && binding.bucket !== plan.r2.bucket)) {
        fail('FENCE_RESOURCE_UNLISTED');
      }
    }
  }
  // 5. Queue consumers: each fenced consumer owns exactly its planned queue;
  // no fenced script consumes any other queue.
  const queueList = rows(await client.api(`${account}/queues?page=1&per_page=100`), 'queues', MAX_ACCOUNT_QUEUES, 'FENCE_INVENTORY_UNBOUNDED');
  const queues = new Map();
  for (const item of queueList) {
    if (!HEX32.test(item?.queue_id ?? '') || queues.has(item.queue_id)) fail('FENCE_PROVIDER_RESPONSE_INVALID');
    queues.set(item.queue_id, await readQueue(client, plan, item.queue_id));
  }
  for (const queue of queues.values()) {
    for (const consumer of queue.consumers) {
      const spec = consumer.script === null ? null : fenced.get(consumer.script);
      if (spec && (spec.kind !== 'queue-consumer' || spec.queueId !== queue.queueId)) fail('CONSUMER_DRIFT');
    }
  }
  const delivery = new Map();
  for (const spec of plan.fencedScripts.filter(item => item.kind === 'queue-consumer')) {
    const queue = queues.get(spec.queueId);
    if (!queue || queue.consumers.length !== 1 || queue.consumers[0].type !== 'worker'
        || queue.consumers[0].script !== spec.name) fail('CONSUMER_DRIFT');
    if (queue.deliveryPaused === null) fail('FENCE_PROVIDER_RESPONSE_INVALID');
    delivery.set(spec.name, { queueId: spec.queueId, queueName: queue.queueName, paused: queue.deliveryPaused });
  }

  const crons = new Map(scripts.filter(item => item.classification === 'fenced').map(item => [item.name, item.crons]));
  const productionStorage = [
    ...Object.entries(FENCE_D1_LABELS).filter(([, spec]) => spec.owner === 'production')
      .map(([label, spec]) => ({ label, binding: spec.binding, ref: idDigest('d1', plan.d1[label]) })),
    { label: 'quarantine', binding: FENCE_R2_BINDING, ref: idDigest('r2', plan.r2.bucket) },
  ];
  const fencedEntries = scripts.filter(item => item.classification === 'fenced').map(script => {
    const spec = fenced.get(script.name);
    return {
      name: script.name,
      kind: spec.kind,
      queueIdSha256: spec.queueId === null ? null : idDigest('queue', spec.queueId),
      versions: script.versions.map(({ versionId, percentage, bindingsSha256 }) => ({ versionId, percentage, bindingsSha256 })),
      settingsBindingsSha256: script.settingsBindingsSha256,
      bindings: sortBindings(allBindings(script).map(publicBinding)
        .filter((item, index, list) => list.findIndex(other => sameList(other, item)) === index)),
    };
  });
  const dataResources = [
    ...Object.keys(FENCE_D1_LABELS).map(label => ({
      kind: 'd1', label, idSha256: idDigest('d1', plan.d1[label]),
      boundBy: scripts.filter(script => allBindings(script).some(binding => binding.d1Id === plan.d1[label])).map(script => script.name),
    })),
    { kind: 'r2', label: 'quarantine', idSha256: idDigest('r2', plan.r2.bucket),
      boundBy: scripts.filter(script => allBindings(script).some(binding => binding.bucket === plan.r2.bucket)).map(script => script.name) },
  ];
  // Immutable identity of the fenced surface. Crons, delivery, production
  // version and mode are phase state, not identity.
  const fingerprintSha256 = identityDigest({
    production: { name: plan.productionWorker, storage: productionStorage },
    fenced: fencedEntries.map(({ name, kind, queueIdSha256, versions, settingsBindingsSha256 }) => ({
      name, kind, queueIdSha256, versions, settingsBindingsSha256 })),
    dataResources,
  });
  const receipt = {
    schema: FENCE_INVENTORY_SCHEMA,
    planSha256: plan.planSha256,
    accountSha256: idDigest('account', plan.accountId),
    capturedAt: iso(now()),
    productionWorker: {
      name: plan.productionWorker,
      deploymentId: production.deployment.deploymentId,
      versionId: production.deployment.versions[0].versionId,
      mode,
      sourceCommit: sourceCommit !== null && COMMIT.test(sourceCommit) ? sourceCommit : null,
      storage: productionStorage,
    },
    fencedScripts: fencedEntries.map(entry => ({
      ...entry,
      crons: crons.get(entry.name),
      deliveryPaused: delivery.get(entry.name)?.paused ?? null,
    })),
    outOfScopeScripts: plan.outOfScopeScripts.map(item => ({ name: item.name, reason: item.reason, present: present.has(item.name) })),
    unlistedScripts: scripts.filter(item => item.classification === 'unlisted').length,
    dataResources,
    fingerprintSha256,
  };
  return {
    receipt,
    fingerprintSha256,
    crons,
    delivery,
    production: {
      deploymentId: production.deployment.deploymentId,
      createdOnMs: production.deployment.createdOnMs,
      versionId: production.deployment.versions[0].versionId,
      mode,
      sourceCommit: receipt.productionWorker.sourceCommit,
    },
  };
}

function scheduleDrift(inventory, plan) {
  for (const spec of plan.fencedScripts) {
    if (!sameList(inventory.crons.get(spec.name), [...spec.expectedCrons])) fail('SCHEDULE_DRIFT');
  }
}

function plannedMutations(inventory, plan) {
  return plan.fencedScripts.map(spec => (spec.kind === 'cron'
    ? { action: 'clear-schedules', script: spec.name, before: { crons: inventory.crons.get(spec.name) }, after: { crons: [] } }
    : { action: 'pause-delivery', script: spec.name, queueIdSha256: idDigest('queue', spec.queueId),
      before: { deliveryPaused: inventory.delivery.get(spec.name).paused }, after: { deliveryPaused: true } }));
}

async function readSchedules(client, plan, name) {
  const schedules = rows(await client.api(`/accounts/${plan.accountId}/workers/scripts/${name}/schedules`), 'schedules', 16);
  return cronList(schedules.map(item => item?.cron), 'FENCE_PROVIDER_RESPONSE_INVALID');
}

async function putSchedules(client, plan, name, crons) {
  const result = await client.api(`/accounts/${plan.accountId}/workers/scripts/${name}/schedules`,
    crons.map(cron => ({ cron })), { mutation: true, method: 'PUT' });
  const echoed = rows(result, 'schedules', 16);
  if (!sameList(cronList(echoed.map(item => item?.cron), 'FENCE_PROVIDER_RESPONSE_INVALID'), [...crons].sort())) {
    fail('FENCE_MUTATION_UNVERIFIED');
  }
}

async function setDelivery(client, plan, queueId, queueName, paused) {
  const result = await client.api(`/accounts/${plan.accountId}/queues/${queueId}`,
    { queue_name: queueName, settings: { delivery_paused: paused } }, { mutation: true, method: 'PATCH' });
  if (record(result?.settings) && result.settings.delivery_paused !== undefined && result.settings.delivery_paused !== paused) {
    fail('FENCE_MUTATION_UNVERIFIED');
  }
}

function checkApplyReceipt(value, plan, planReceiptSha256) {
  if (value.planSha256 !== plan.planSha256 || value.planReceiptSha256 !== planReceiptSha256
      || !Number.isSafeInteger(value.appliedAtMs) || !Number.isSafeInteger(value.startedAtMs)
      || value.appliedAtMs < value.startedAtMs || !SHA256.test(value.fingerprintSha256 ?? '')
      || !record(value.productionWorker) || !Array.isArray(value.priorState) || !record(value.r2Baseline)) {
    fail('FENCE_RECEIPT_INVALID');
  }
}

/** Production deployments from newest back to the fenced deployment that was
 * active at apply, each with the edge modes of all its versions. */
async function productionHistory(client, plan, fencedDeploymentId) {
  const path = `/accounts/${plan.accountId}/workers/scripts/${plan.productionWorker}`;
  const list = rows(await client.api(`${path}/deployments`), 'deployments', 100).map(deploymentOf);
  const index = list.findIndex(item => item.deploymentId === fencedDeploymentId);
  if (index < 0 || index >= MAX_HISTORY_DEPLOYMENTS) fail('FENCE_HISTORY_INCOMPLETE');
  const modes = new Map();
  const history = [];
  for (const deployment of list.slice(0, index + 1)) {
    const versionModes = [];
    for (const { versionId } of deployment.versions) {
      if (!modes.has(versionId)) {
        const version = await client.api(`${path}/versions/${versionId}`);
        const bindings = version?.resources?.bindings;
        if (!record(version) || version.id !== versionId || !Array.isArray(bindings) || bindings.length > MAX_BINDINGS) {
          fail('FENCE_PROVIDER_RESPONSE_INVALID');
        }
        modes.set(versionId, edgeMode(bindings.map(normalizeBinding)));
      }
      versionModes.push(modes.get(versionId));
    }
    history.push({ ...deployment, modes: versionModes });
  }
  return history;
}

async function inventoryCommand({ client, plan, now, receiptsDirectory }) {
  const inventory = await collectInventory(client, plan, { now, requireFenced: false });
  scheduleDrift(inventory, plan);
  return writeReceipt(contentPath(receiptsDirectory, 'inventory', inventory.receipt), inventory.receipt);
}

async function planCommand({ client, plan, now, receiptsDirectory }) {
  const inventory = await collectInventory(client, plan, { now, requireFenced: false });
  scheduleDrift(inventory, plan);
  const receipt = {
    schema: FENCE_PLAN_RECEIPT_SCHEMA,
    planSha256: plan.planSha256,
    createdAt: iso(now()),
    quietWindowMinutes: plan.quietWindowMinutes,
    fingerprintSha256: inventory.fingerprintSha256,
    inventory: inventory.receipt,
    mutations: plannedMutations(inventory, plan),
    remoteWrites: false,
  };
  return writeReceipt(contentPath(receiptsDirectory, 'plan', receipt), receipt);
}

async function applyCommand({ client, plan, now, receiptsDirectory, confirm, analyticsDrainComplete }) {
  const planPath = join(receiptsDirectory, `plan-${confirm}.json`);
  if (!await exists(planPath)) fail('FENCE_CONFIRMATION_MISMATCH');
  const { value: planReceipt, sha256: planReceiptSha256 } = await readReceipt(planPath, FENCE_PLAN_RECEIPT_SCHEMA);
  if (planReceiptSha256 !== confirm) fail('FENCE_CONFIRMATION_MISMATCH');
  if (planReceipt.planSha256 !== plan.planSha256 || !Array.isArray(planReceipt.mutations)
      || planReceipt.mutations.length !== plan.fencedScripts.length) fail('FENCE_PLAN_RECEIPT_MISMATCH');
  const receiptPath = join(receiptsDirectory, `apply-${confirm}.json`);
  if (await exists(receiptPath)) fail('FENCE_ALREADY_APPLIED');
  const intentPath = join(receiptsDirectory, `apply-intent-${confirm}.json`);
  const resuming = await exists(intentPath);
  const inventory = await collectInventory(client, plan, { now, requireFenced: true });
  if (inventory.fingerprintSha256 !== planReceipt.fingerprintSha256) fail('FENCE_INVENTORY_CHANGED');
  const pending = [];
  for (const mutation of planReceipt.mutations) {
    const spec = plan.fencedScripts.find(item => item.name === mutation.script);
    if (!spec) fail('FENCE_PLAN_RECEIPT_MISMATCH');
    if (mutation.action === 'clear-schedules' && spec.kind === 'cron') {
      const current = inventory.crons.get(spec.name);
      if (sameList(current, mutation.after.crons) && (resuming || sameList(mutation.before.crons, mutation.after.crons))) continue;
      if (!sameList(current, mutation.before.crons)) fail('SCHEDULE_DRIFT');
      pending.push({ spec, mutation });
    } else if (mutation.action === 'pause-delivery' && spec.kind === 'queue-consumer') {
      const current = inventory.delivery.get(spec.name);
      if (!sameList(inventory.crons.get(spec.name), [])) fail('SCHEDULE_DRIFT');
      if (current.paused === mutation.after.deliveryPaused && (resuming || mutation.before.deliveryPaused === true)) continue;
      if (current.paused !== mutation.before.deliveryPaused) fail('CONSUMER_DRIFT');
      pending.push({ spec, mutation, queue: current });
    } else fail('FENCE_PLAN_RECEIPT_MISMATCH');
  }
  if (client.remaining() < 2 * pending.length + R2_READS) fail('FENCE_REQUEST_BUDGET');
  let intent;
  if (resuming) {
    ({ value: intent } = await readReceipt(intentPath, FENCE_APPLY_INTENT_SCHEMA));
    if (intent.planReceiptSha256 !== confirm || intent.planSha256 !== plan.planSha256) fail('FENCE_RECEIPT_INVALID');
  } else {
    // The R2 quarantine baseline is taken with production already fenced and
    // before any write: verify must see the same digest at the window end.
    intent = {
      schema: FENCE_APPLY_INTENT_SCHEMA,
      planSha256: plan.planSha256,
      planReceiptSha256: confirm,
      startedAtMs: now(),
      analyticsDrainAttested: analyticsDrainComplete === true,
      productionWorker: inventory.production,
      r2Baseline: await client.r2Digest(),
      priorState: planReceipt.mutations.map(({ script, action, before }) => ({ script, action, before })),
    };
    await writeReceipt(intentPath, intent);
  }
  for (const { spec, mutation, queue } of pending) {
    if (mutation.action === 'clear-schedules') await putSchedules(client, plan, spec.name, []);
    else await setDelivery(client, plan, spec.queueId, queue.queueName, true);
  }
  const fencedState = [];
  for (const spec of plan.fencedScripts) {
    const crons = await readSchedules(client, plan, spec.name);
    if (crons.length !== 0) fail('FENCE_APPLY_UNVERIFIED');
    let deliveryPaused = null;
    if (spec.kind === 'queue-consumer') {
      deliveryPaused = (await readQueue(client, plan, spec.queueId)).deliveryPaused;
      if (deliveryPaused !== true) fail('FENCE_APPLY_UNVERIFIED');
    }
    fencedState.push({ script: spec.name, kind: spec.kind, crons, deliveryPaused });
  }
  const receipt = {
    schema: FENCE_APPLY_RECEIPT_SCHEMA,
    planSha256: plan.planSha256,
    planReceiptSha256: confirm,
    fingerprintSha256: planReceipt.fingerprintSha256,
    startedAtMs: intent.startedAtMs,
    appliedAtMs: now(),
    quietWindowMinutes: plan.quietWindowMinutes,
    analyticsDrainAttested: true,
    productionWorker: intent.productionWorker,
    r2Baseline: intent.r2Baseline,
    priorState: intent.priorState,
    fencedState,
    mutationsIssued: pending.length,
  };
  return writeReceipt(receiptPath, receipt);
}

async function verifyCommand({ client, plan, now, receiptsDirectory, fence, windowStartMs }) {
  const applyPath = join(receiptsDirectory, `apply-${fence}.json`);
  if (!await exists(applyPath)) fail('FENCE_NOT_APPLIED');
  if (await exists(join(receiptsDirectory, `release-${fence}.json`))) fail('FENCE_RELEASED');
  const { value: apply, sha256: applyReceiptSha256 } = await readReceipt(applyPath, FENCE_APPLY_RECEIPT_SCHEMA);
  checkApplyReceipt(apply, plan, fence);
  const quietMs = plan.quietWindowMinutes * 60_000;
  const endMs = now();
  const startMs = windowStartMs ?? apply.appliedAtMs + quietMs;
  if (startMs < apply.appliedAtMs + quietMs) fail('FENCE_WINDOW_TOO_EARLY');
  if (endMs - startMs < quietMs) fail('FENCE_WINDOW_TOO_SHORT');

  const inventory = await collectInventory(client, plan, { now, requireFenced: true });
  if (inventory.fingerprintSha256 !== apply.fingerprintSha256) fail('FENCE_INVENTORY_CHANGED');
  for (const deployment of await productionHistory(client, plan, apply.productionWorker.deploymentId)) {
    if (!singleVersion(deployment) || deployment.modes[0] !== 'fenced') fail('PRODUCTION_WORKER_NOT_FENCED');
  }
  for (const spec of plan.fencedScripts) {
    if (inventory.crons.get(spec.name).length !== 0) fail('FENCE_NOT_APPLIED');
    if (spec.kind === 'queue-consumer' && inventory.delivery.get(spec.name).paused !== true) fail('FENCE_NOT_APPLIED');
  }

  const bookmark = async (id, atMs) => {
    const query = atMs === null ? '' : `?timestamp=${encodeURIComponent(iso(atMs))}`;
    const result = await client.api(`/accounts/${plan.accountId}/d1/database/${id}/time_travel/bookmark${query}`);
    if (!record(result) || typeof result.bookmark !== 'string' || !OPAQUE.test(result.bookmark)) {
      fail('FENCE_PROVIDER_RESPONSE_INVALID');
    }
    return result.bookmark;
  };
  const d1 = [];
  for (const [label, id] of Object.entries(plan.d1)) {
    const atStart = await bookmark(id, startMs);
    const atEnd = await bookmark(id, null);
    if (atStart !== atEnd) fail('FENCE_NOT_QUIESCENT');
    d1.push({ label, idSha256: idDigest('d1', id), bookmark: atEnd });
  }
  const r2 = await client.r2Digest();
  if (r2.bucketSha256 !== apply.r2Baseline.bucketSha256 || r2.inventorySha256 !== apply.r2Baseline.inventorySha256
      || r2.objects !== apply.r2Baseline.objects || r2.bytes !== apply.r2Baseline.bytes) fail('FENCE_NOT_QUIESCENT');

  const window = { start: iso(startMs), end: iso(endMs) };
  const labelOf = new Map(Object.entries(plan.d1).map(([label, id]) => [id, label]));
  const writes = Object.fromEntries(Object.keys(plan.d1).map(label => [label, { rowsWritten: 0, writeQueries: 0 }]));
  const d1Groups = (await client.graphql('d1Writes', { accountTag: plan.accountId, ...window, databaseIds: Object.values(plan.d1) }))
    .d1AnalyticsAdaptiveGroups;
  if (!Array.isArray(d1Groups) || d1Groups.length >= 100) fail('FENCE_ANALYTICS_INVALID');
  for (const group of d1Groups) {
    const label = labelOf.get(group?.dimensions?.databaseId);
    const { rowsWritten, writeQueries } = group?.sum ?? {};
    if (!label || !Number.isSafeInteger(rowsWritten) || rowsWritten < 0 || !Number.isSafeInteger(writeQueries) || writeQueries < 0) {
      fail('FENCE_ANALYTICS_INVALID');
    }
    writes[label].rowsWritten += rowsWritten;
    writes[label].writeQueries += writeQueries;
  }
  if (Object.values(writes).some(item => item.rowsWritten !== 0 || item.writeQueries !== 0)) fail('FENCE_NOT_QUIESCENT');
  const fencedNames = plan.fencedScripts.map(spec => spec.name);
  const invocationGroups = (await client.graphql('invocations', { accountTag: plan.accountId, ...window, scriptNames: fencedNames }))
    .workersInvocationsAdaptive;
  if (!Array.isArray(invocationGroups) || invocationGroups.length >= 100) fail('FENCE_ANALYTICS_INVALID');
  let invocations = 0;
  for (const group of invocationGroups) {
    const requests = group?.sum?.requests;
    if (!fencedNames.includes(group?.dimensions?.scriptName) || !Number.isSafeInteger(requests) || requests < 0) {
      fail('FENCE_ANALYTICS_INVALID');
    }
    invocations += requests;
  }
  if (invocations !== 0) fail('FENCE_NOT_QUIESCENT');

  const receipt = {
    schema: FENCE_RECEIPT_SCHEMA,
    planSha256: plan.planSha256,
    planReceiptSha256: fence,
    applyReceiptSha256,
    accountSha256: idDigest('account', plan.accountId),
    verifiedAt: iso(endMs),
    productionWorker: { name: plan.productionWorker, deploymentId: inventory.production.deploymentId,
      versionId: inventory.production.versionId, mode: 'fenced', sourceCommit: inventory.production.sourceCommit },
    fencedScripts: plan.fencedScripts.map(spec => ({ name: spec.name, kind: spec.kind, crons: [],
      deliveryPaused: spec.kind === 'queue-consumer' ? true : null })),
    window: { appliedAt: iso(apply.appliedAtMs), quietWindowMinutes: plan.quietWindowMinutes, ...window },
    d1,
    r2,
    analytics: {
      querySha256: { ...FENCE_GRAPHQL_QUERY_SHA256 },
      d1: Object.entries(writes).map(([label, item]) => ({ label, ...item })),
      fencedScriptInvocations: invocations,
    },
  };
  return writeReceipt(contentPath(receiptsDirectory, 'fence', receipt), receipt);
}

async function releaseCommand({ client, plan, now, receiptsDirectory, confirm }) {
  const applyPath = join(receiptsDirectory, `apply-${confirm}.json`);
  if (!await exists(applyPath)) fail('FENCE_CONFIRMATION_MISMATCH');
  const { value: apply, sha256: applyReceiptSha256 } = await readReceipt(applyPath, FENCE_APPLY_RECEIPT_SCHEMA);
  checkApplyReceipt(apply, plan, confirm);
  const receiptPath = join(receiptsDirectory, `release-${confirm}.json`);
  if (await exists(receiptPath)) fail('FENCE_ALREADY_RELEASED');
  const history = await productionHistory(client, plan, apply.productionWorker.deploymentId);
  // An unrecognized mode cannot be proved non-gcp, so it refuses too.
  if (history.some(deployment => deployment.modes.some(mode => mode !== null && mode !== 'worker' && mode !== 'fenced'))) {
    fail('FENCE_RELEASE_AFTER_GCP');
  }

  const targets = [];
  for (const prior of apply.priorState) {
    const spec = plan.fencedScripts.find(item => item.name === prior.script);
    if (!spec) fail('FENCE_RECEIPT_INVALID');
    if (prior.action === 'clear-schedules' && spec.kind === 'cron') {
      const restore = cronList(prior.before?.crons, 'FENCE_RECEIPT_INVALID');
      const current = await readSchedules(client, plan, spec.name);
      if (!sameList(current, []) && !sameList(current, restore)) fail('SCHEDULE_DRIFT');
      targets.push({ spec, prior: { crons: restore }, pending: !sameList(current, restore) });
    } else if (prior.action === 'pause-delivery' && spec.kind === 'queue-consumer') {
      const restore = prior.before?.deliveryPaused;
      if (typeof restore !== 'boolean') fail('FENCE_RECEIPT_INVALID');
      const queue = await readQueue(client, plan, spec.queueId);
      if (queue.deliveryPaused !== true && queue.deliveryPaused !== restore) fail('CONSUMER_DRIFT');
      targets.push({ spec, prior: { deliveryPaused: restore }, queue, pending: queue.deliveryPaused !== restore });
    } else fail('FENCE_RECEIPT_INVALID');
  }
  if (client.remaining() < 2 * targets.length) fail('FENCE_REQUEST_BUDGET');
  let mutationsIssued = 0;
  for (const target of targets.filter(item => item.pending)) {
    if (target.spec.kind === 'cron') await putSchedules(client, plan, target.spec.name, target.prior.crons);
    else await setDelivery(client, plan, target.spec.queueId, target.queue.queueName, target.prior.deliveryPaused);
    mutationsIssued += 1;
  }
  const restoredState = [];
  for (const target of targets) {
    if (target.spec.kind === 'cron') {
      const crons = await readSchedules(client, plan, target.spec.name);
      if (!sameList(crons, target.prior.crons)) fail('FENCE_RELEASE_UNVERIFIED');
      restoredState.push({ script: target.spec.name, kind: 'cron', crons, deliveryPaused: null });
    } else {
      const { deliveryPaused } = await readQueue(client, plan, target.spec.queueId);
      if (deliveryPaused !== target.prior.deliveryPaused) fail('FENCE_RELEASE_UNVERIFIED');
      restoredState.push({ script: target.spec.name, kind: 'queue-consumer', crons: null, deliveryPaused });
    }
  }
  const receipt = {
    schema: FENCE_RELEASE_RECEIPT_SCHEMA,
    planSha256: plan.planSha256,
    planReceiptSha256: confirm,
    applyReceiptSha256,
    releasedAt: iso(now()),
    preGcp: true,
    productionHistory: history.map(({ deploymentId, modes }) => ({ deploymentId, modes })),
    restoredState,
    mutationsIssued,
  };
  return writeReceipt(receiptPath, receipt);
}

const COMMANDS = { inventory: inventoryCommand, plan: planCommand, apply: applyCommand, verify: verifyCommand, release: releaseCommand };

/**
 * Programmatic entry. `plan` is the parsed owner plan JSON. Preconditions that
 * need no provider read (flags, confirmation shape, receipts directory,
 * credential) are enforced before the first request.
 */
export async function runCloudflareWriterFence({ subcommand, plan: input, receiptsDirectory, confirm, fence,
  windowStart, preGcp = false, analyticsDrainComplete = false, cliPath = DEFAULT_CLI_PATH, fetcher = globalThis.fetch,
  environment = process.env, now = Date.now }) {
  if (!Object.hasOwn(COMMANDS, subcommand ?? '')) fail('FENCE_ARGUMENTS_INVALID');
  const plan = validateCloudflareWriterFencePlan(input);
  if (subcommand === 'release' && preGcp !== true) fail('FENCE_RELEASE_REQUIRES_PRE_GCP');
  if (subcommand === 'apply' || subcommand === 'release') {
    if (confirm === undefined || confirm === null) fail('FENCE_CONFIRMATION_REQUIRED');
    if (!SHA256.test(confirm)) fail('FENCE_CONFIRMATION_MISMATCH');
  } else if (confirm !== undefined && confirm !== null) fail('FENCE_ARGUMENTS_INVALID');
  if (subcommand === 'apply' && analyticsDrainComplete !== true) fail('FENCE_DRAIN_UNATTESTED');
  if (subcommand === 'verify' ? !SHA256.test(fence ?? '') : fence !== undefined && fence !== null) fail('FENCE_ARGUMENTS_INVALID');
  let windowStartMs = null;
  if (windowStart !== undefined && windowStart !== null) {
    windowStartMs = Date.parse(windowStart);
    if (subcommand !== 'verify' || typeof windowStart !== 'string' || !Number.isSafeInteger(windowStartMs)) fail('FENCE_ARGUMENTS_INVALID');
  }
  if (typeof receiptsDirectory !== 'string') fail('FENCE_RECEIPTS_DIRECTORY_UNSAFE');
  receiptsDirectory = resolve(receiptsDirectory);
  await assertPrivateDirectory(receiptsDirectory);
  const client = createFenceClient({ plan, subcommand, receiptsDirectory, cliPath, fetcher, environment });
  const unlock = subcommand === 'apply' || subcommand === 'release' ? await lockReceipts(receiptsDirectory) : () => {};
  try {
    return await COMMANDS[subcommand]({ client, plan, now, receiptsDirectory, confirm, fence, windowStartMs, analyticsDrainComplete });
  } catch (error) {
    // Budget refusals are raised inside provider adapters that re-code
    // transport failures; restore the budget code once it tripped.
    if (client.exceeded) fail('FENCE_REQUEST_BUDGET');
    throw error;
  } finally {
    unlock();
  }
}

/** Consumer-side reader for PT-2 and HX-6: returns the fence receipt only when
 * its bytes hash to the pinned sha256 and its closed shape holds. */
export async function readCloudflareWriterFenceReceipt(path, expectedSha256) {
  if (!SHA256.test(expectedSha256 ?? '')) fail('FENCE_RECEIPT_INVALID');
  const { value, sha256: actual } = await readReceipt(path, FENCE_RECEIPT_SCHEMA);
  if (actual !== expectedSha256) fail('FENCE_RECEIPT_INVALID');
  exactKeys(value, ['schema', 'planSha256', 'planReceiptSha256', 'applyReceiptSha256', 'accountSha256', 'verifiedAt',
    'productionWorker', 'fencedScripts', 'window', 'd1', 'r2', 'analytics'], 'FENCE_RECEIPT_INVALID');
  if (value.productionWorker?.mode !== 'fenced' || !Array.isArray(value.fencedScripts)
      || value.fencedScripts.some(item => item?.crons?.length !== 0 || (item.kind === 'queue-consumer' && item.deliveryPaused !== true))
      || !Array.isArray(value.d1) || value.d1.length !== Object.keys(FENCE_D1_LABELS).length
      || value.d1.some(item => !Object.hasOwn(FENCE_D1_LABELS, item?.label) || !OPAQUE.test(item.bookmark ?? '') || !SHA256.test(item.idSha256 ?? ''))
      || !SHA256.test(value.r2?.inventorySha256 ?? '') || value.analytics?.fencedScriptInvocations !== 0
      || !Array.isArray(value.analytics?.d1) || value.analytics.d1.some(item => item?.rowsWritten !== 0 || item.writeQueries !== 0)
      || Date.parse(value.window?.start) < Date.parse(value.window?.appliedAt) + value.window?.quietWindowMinutes * 60_000
      || Date.parse(value.window?.end) - Date.parse(value.window?.start) < value.window?.quietWindowMinutes * 60_000) {
    fail('FENCE_RECEIPT_INVALID');
  }
  return value;
}

const FLAG_SPECS = {
  '--plan': 'value', '--receipts': 'value', '--confirm': 'value', '--fence': 'value', '--window-start': 'value',
  '--pre-gcp': 'switch', '--analytics-drain-complete': 'switch',
};
export function parseCloudflareWriterFenceArguments(args) {
  const [subcommand, ...rest] = args;
  if (!Object.hasOwn(COMMANDS, subcommand ?? '')) fail('FENCE_ARGUMENTS_INVALID');
  const options = { subcommand };
  const seen = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const [flag, inline] = rest[index].split(/=(.*)/s, 2);
    if (!Object.hasOwn(FLAG_SPECS, flag) || seen.has(flag)) fail('FENCE_ARGUMENTS_INVALID');
    seen.add(flag);
    let value = true;
    if (FLAG_SPECS[flag] === 'value') {
      value = inline ?? rest[++index];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) fail('FENCE_ARGUMENTS_INVALID');
    } else if (inline !== undefined) fail('FENCE_ARGUMENTS_INVALID');
    const key = { '--plan': 'planPath', '--receipts': 'receiptsDirectory', '--confirm': 'confirm', '--fence': 'fence',
      '--window-start': 'windowStart', '--pre-gcp': 'preGcp', '--analytics-drain-complete': 'analyticsDrainComplete' }[flag];
    options[key] = value;
  }
  if (!options.planPath || !options.receiptsDirectory) fail('FENCE_ARGUMENTS_INVALID');
  return options;
}

async function main() {
  try {
    const { planPath, ...options } = parseCloudflareWriterFenceArguments(process.argv.slice(2));
    let plan;
    try { plan = JSON.parse((await readMaintenanceFile(resolve(planPath), 64 * 1024)).toString('utf8')); } catch { fail('FENCE_PLAN_UNREADABLE'); }
    const result = await runCloudflareWriterFence({ ...options, plan });
    const summary = { subcommand: options.subcommand, receipt: basename(result.path), sha256: result.sha256 };
    if (options.subcommand === 'plan') {
      summary.confirm = result.sha256;
      summary.mutations = result.receipt.mutations.length;
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    // Provider failures can carry tokens, ids or metadata; emit only codes.
    process.stderr.write(`${/^[A-Z][A-Z0-9_]{2,95}$/.test(error?.code ?? '') ? error.code : 'FENCE_FAILED'}\n`);
    process.exitCode = 1;
  }
}

for (const [name, text] of Object.entries(FENCE_GRAPHQL_QUERIES)) {
  if (sha256(text) !== FENCE_GRAPHQL_QUERY_SHA256[name]) throw operationError('FENCE_GRAPHQL_QUERY_UNPINNED');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
