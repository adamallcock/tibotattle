import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
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
 * - inventory (read-only): every script with its classification, bindings
 *   (type, name, id digest, listed label) and crons, and every queue with
 *   its consumers and delivery state; WRITER_UNACCOUNTED when a script
 *   outside the fence binds a listed D1 or R2 resource, SCHEDULE_DRIFT when
 *   a fenced script's crons differ. A writer-set refusal still writes an
 *   inventory-refusal receipt naming the offending scripts or labels.
 * - plan (read-only): inventory plus the exact mutation list; its receipt
 *   sha256 is the only accepted --confirm value.
 * - apply --confirm=<plan receipt sha256> --analytics-drain-complete: one
 *   schedules PUT [] per cron script and one delivery pause per consumer,
 *   journalled (with the prior state) before the first write. Ordering: the
 *   production Worker must already be fenced and its analytics drain
 *   complete (the drain is proved by HX-6, not here; the operator attests to
 *   it and the receipt says so). A released fence is never re-applied.
 * - verify --fence=<plan receipt sha256> (read-only against the provider,
 *   serialised with apply and release): production Worker is one version at
 *   100% with EDGE_UPSTREAM_MODE='fenced' since the fence; zero schedules and
 *   paused delivery as observed; D1 time-travel bookmarks equal at a window
 *   start at least quietWindowMinutes after the last apply and at the window
 *   end; R2 quarantine digest equal to the baseline taken at apply, before
 *   any write; GraphQL rowsWritten/writeQueries 0 per listed database and no
 *   invocation of any fenced script over [start, end - analytics lag], an
 *   interval itself at least quietWindowMinutes long (so neither proof covers
 *   an empty interval). Emits the fence receipt that pins bookmarks and digest.
 * - release --confirm=<plan receipt sha256> --pre-gcp: restores the exact
 *   prior schedules and delivery from the apply journal, so an apply that
 *   stopped partway is recoverable; refused once any gcp-mode production
 *   version has been deployed since the fence.
 *
 * Every request, reads and the two mutation shapes alike, goes through one
 * budgeted fetcher restricted to the Cloudflare v4 API. Receipts are 0600,
 * content-addressed or keyed by the plan receipt, and hold names, binding
 * types, id digests, crons, counts, bookmarks and digests only: never the
 * token, rows, R2 keys, variable text or addresses. GraphQL analytics are
 * provider-lagged corroboration; the D1 bookmarks are the authoritative
 * write-quiescence evidence.
 */

export const FENCE_PLAN_SCHEMA = 'cloudflare-writer-fence-plan-v1';
export const FENCE_INVENTORY_SCHEMA = 'cloudflare-writer-fence-inventory-v1';
export const FENCE_INVENTORY_REFUSAL_SCHEMA = 'cloudflare-writer-fence-inventory-refusal-v1';
export const FENCE_PLAN_RECEIPT_SCHEMA = 'cloudflare-writer-fence-plan-receipt-v1';
export const FENCE_APPLY_INTENT_SCHEMA = 'cloudflare-writer-fence-apply-intent-v1';
export const FENCE_APPLY_RECEIPT_SCHEMA = 'cloudflare-writer-fence-apply-v1';
export const FENCE_RECEIPT_SCHEMA = 'cloudflare-writer-fence-receipt-v1';
export const FENCE_RELEASE_RECEIPT_SCHEMA = 'cloudflare-writer-fence-release-v1';
export const FENCE_EDGE_MODE_BINDING = 'EDGE_UPSTREAM_MODE';
export const FENCE_MIN_QUIET_WINDOW_MINUTES = 15;
// Margin for provider analytics ingestion: GraphQL is queried only up to this
// long before verify runs, and the receipt says which interval it covered.
// A margin, not a provider-guaranteed bound; the bookmarks cover up to now.
export const FENCE_ANALYTICS_LAG_MINUTES = 5;

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
// apply after its inventory: R2 baseline + one write per pending mutation +
// a schedules readback per fenced script + a queue readback per consumer.
const INVENTORY_READS = 1 + MAX_ACCOUNT_SCRIPTS * 5 + 1 + MAX_ACCOUNT_QUEUES;
const R2_READS = 101;
const HISTORY_READS = 1 + MAX_HISTORY_DEPLOYMENTS * 2;
export const FENCE_REQUEST_BUDGETS = Object.freeze({
  inventory: INVENTORY_READS,
  plan: INVENTORY_READS,
  apply: INVENTORY_READS + R2_READS + 3 * MAX_FENCED_SCRIPTS,
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
const CONSUMER_TYPE = /^[a-z0-9_-]{1,32}$/;
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
const isoMs = value => {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isSafeInteger(ms) && iso(ms) === value ? ms : null;
};
const count = value => Number.isSafeInteger(value) && value >= 0;
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

async function boundedBytes(response, maximum, code) {
  if (!response?.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) fail(code);
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts);
}

const MUTATION_ENDPOINTS = Object.freeze({
  PUT: /^\/accounts\/[a-f0-9]{32}\/workers\/scripts\/[a-zA-Z0-9_-]{1,63}\/schedules$/,
  PATCH: /^\/accounts\/[a-f0-9]{32}\/queues\/[a-f0-9]{32}$/,
});

/** One budgeted, Cloudflare-v4-only fetcher shared by the maintenance
 * transport's reads, the fence's two mutation shapes, the R2 scan and the
 * pinned analytics reads. */
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
  // The only writes the fence makes: schedules PUT and queue delivery PATCH,
  // each to its one closed endpoint in this account. A lost, unreadable or
  // 5xx response is uncertain (resume or release reconciles it against the
  // live state); a 4xx or success:false answer is a refusal.
  const mutate = async (method, path, body) => {
    if (!Object.hasOwn(MUTATION_ENDPOINTS, method) || !MUTATION_ENDPOINTS[method].test(path)
        || !path.startsWith(`/accounts/${plan.accountId}/`) || body === undefined) fail('FENCE_MUTATION_INVALID');
    let response;
    let bytes;
    try {
      response = await guarded(`${API_PREFIX}${path.slice(1)}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      bytes = await boundedBytes(response, 2_000_000, 'FENCE_MUTATION_UNCERTAIN');
    } catch (error) {
      if (error?.code === 'FENCE_REQUEST_BUDGET' || error?.code === 'FENCE_ENDPOINT_REFUSED') throw error;
      fail('FENCE_MUTATION_UNCERTAIN');
    }
    await transport.receipt({ kind: 'provider-write', method: `${method}_WRITE`, pathSha256: sha256(path),
      status: response.status, bytes: bytes.length, sha256: sha256(bytes) });
    let json;
    if (response.status >= 500) fail('FENCE_MUTATION_UNCERTAIN');
    try { json = JSON.parse(bytes.toString('utf8')); } catch { fail('FENCE_MUTATION_UNCERTAIN'); }
    if (!response.ok || !record(json) || json.success !== true) fail('FENCE_MUTATION_REFUSED');
    return json.result;
  };
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
      bytes = await boundedBytes(response, 1_000_000, 'FENCE_ANALYTICS_UNBOUNDED');
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
    mutate,
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
    if (!record(item) || !CONSUMER_TYPE.test(item.type ?? '')) fail('FENCE_PROVIDER_RESPONSE_INVALID');
    const aliases = [item.script, item.script_name, item.service].filter(value => value !== undefined && value !== null);
    if (aliases.some(value => !SCRIPT.test(value)) || new Set(aliases).size > 1) fail('FENCE_PROVIDER_RESPONSE_INVALID');
    return { type: item.type, script: aliases[0] ?? null };
  });
  const paused = detail.settings.delivery_paused;
  return { queueId, queueName: detail.queue_name, consumers, deliveryPaused: typeof paused === 'boolean' ? paused : null };
}

/**
 * Read-only writer inventory. Reads every script and queue first, then fails
 * closed on a missing planned script, an unaccounted writer, a label that is
 * not the live binding, an unlisted resource bound by a fenced script, a
 * consumer mapping that differs from the plan or (inventory and plan only) a
 * fenced cron that differs from the plan. Each of these writer-set refusals
 * first writes a content-free inventory-refusal receipt naming what refused,
 * so the owner never has to guess and re-read production. Mutable state
 * (crons and delivery) is returned for the caller's phase-specific comparison.
 */
async function collectInventory(client, plan, { now, requireFenced, expectPlannedCrons = false, receiptsDirectory }) {
  const account = `/accounts/${plan.accountId}`;
  const listed = rows(await client.api(`${account}/workers/scripts?per_page=100`), 'scripts', MAX_ACCOUNT_SCRIPTS, 'FENCE_INVENTORY_UNBOUNDED');
  const names = listed.map(item => { if (!SCRIPT.test(item?.id ?? '')) fail('FENCE_PROVIDER_RESPONSE_INVALID'); return item.id; });
  if (new Set(names).size !== names.length) fail('FENCE_PROVIDER_RESPONSE_INVALID');
  const present = new Set(names);
  const fenced = new Map(plan.fencedScripts.map(item => [item.name, item]));
  const outOfScope = new Map(plan.outOfScopeScripts.map(item => [item.name, item]));
  const scripts = [];
  for (const name of [...names].sort()) {
    const classification = name === plan.productionWorker ? 'production' : fenced.has(name) ? 'fenced'
      : outOfScope.has(name) ? 'out-of-scope' : 'unlisted';
    scripts.push(await readScript(client, plan, name, classification));
  }
  const queueList = rows(await client.api(`${account}/queues?page=1&per_page=100`), 'queues', MAX_ACCOUNT_QUEUES, 'FENCE_INVENTORY_UNBOUNDED');
  const queues = new Map();
  for (const item of queueList) {
    if (!HEX32.test(item?.queue_id ?? '') || queues.has(item.queue_id)) fail('FENCE_PROVIDER_RESPONSE_INVALID');
    queues.set(item.queue_id, await readQueue(client, plan, item.queue_id));
  }

  const allBindings = script => [...script.versions.flatMap(version => version.bindings), ...script.settingsBindings];
  const listedD1 = new Map(Object.entries(plan.d1).map(([label, id]) => [id, label]));
  const listedLabel = binding => (binding.d1Id !== null ? listedD1.get(binding.d1Id) ?? null
    : binding.bucket !== null && binding.bucket === plan.r2.bucket ? 'quarantine' : null);
  const labelled = binding => {
    const label = listedLabel(binding);
    return label === null ? publicBinding(binding) : { ...publicBinding(binding), label };
  };
  const unique = list => sortBindings(list.filter((item, index) => list.findIndex(other => sameList(other, item)) === index));
  const fencedList = scripts.filter(item => item.classification === 'fenced');
  // Content-free survey of the whole account: every script and every queue.
  const survey = {
    scripts: scripts.map(script => ({ name: script.name, classification: script.classification, crons: script.crons,
      bindings: unique(allBindings(script).map(labelled)) })),
    queues: [...queues.values()].map(queue => ({ queueIdSha256: idDigest('queue', queue.queueId),
      consumers: queue.consumers, deliveryPaused: queue.deliveryPaused }))
      .sort((a, b) => a.queueIdSha256.localeCompare(b.queueIdSha256)),
  };
  const capturedAt = iso(now());
  const refuse = async (code, { scripts: subjectScripts = [], labels = [] }) => {
    const receipt = { schema: FENCE_INVENTORY_REFUSAL_SCHEMA, planSha256: plan.planSha256,
      accountSha256: idDigest('account', plan.accountId), capturedAt,
      refusal: { code, scripts: [...subjectScripts].sort(), labels: [...labels].sort() }, ...survey };
    const written = await writeReceipt(contentPath(receiptsDirectory, 'inventory-refusal', receipt), receipt);
    throw Object.assign(operationError(code), { refusalReceipt: basename(written.path) });
  };

  // 0. Every planned script exists.
  const missing = [plan.productionWorker, ...plan.fencedScripts.map(item => item.name)].filter(name => !present.has(name));
  if (missing.length) await refuse('FENCE_PLAN_SCRIPT_MISSING', { scripts: missing });
  // 1. Anything outside production and the fence that binds a listed resource.
  const unaccounted = scripts.filter(script => (script.classification === 'unlisted' || script.classification === 'out-of-scope')
    && allBindings(script).some(binding => listedLabel(binding) !== null));
  if (unaccounted.length) {
    await refuse('WRITER_UNACCOUNTED', { scripts: unaccounted.map(script => script.name),
      labels: [...new Set(unaccounted.flatMap(allBindings).map(listedLabel).filter(label => label !== null))] });
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
    return matches.length === 1 && matches[0].type === type ? matches[0] : null;
  };
  const mismatched = [];
  for (const [label, { owner, binding }] of Object.entries(FENCE_D1_LABELS)) {
    if (owner === 'production') {
      if (productionBinding(binding, 'd1')?.d1Id !== plan.d1[label]) mismatched.push(label);
    } else {
      const ids = new Set(fencedList.flatMap(allBindings).filter(item => item.name === binding && item.type === 'd1')
        .map(item => item.d1Id));
      if (ids.size !== 1 || !ids.has(plan.d1[label])) mismatched.push(label);
    }
  }
  if (productionBinding(FENCE_R2_BINDING, 'r2_bucket')?.bucket !== plan.r2.bucket) mismatched.push('quarantine');
  if (mismatched.length) await refuse('FENCE_RESOURCE_LABEL_MISMATCH', { labels: mismatched });
  // 4. The fence proves quiescence only for listed resources; a fenced
  // script writing anything else is outside the proof.
  const unlistedWriters = fencedList.filter(script => allBindings(script)
    .some(binding => (binding.d1Id !== null || binding.bucket !== null) && listedLabel(binding) === null));
  if (unlistedWriters.length) await refuse('FENCE_RESOURCE_UNLISTED', { scripts: unlistedWriters.map(script => script.name) });
  // 5. Queue consumers: each fenced consumer is the only consumer of exactly
  // its planned queue; no fenced script consumes any other queue.
  const consumerDrift = new Set();
  for (const queue of queues.values()) {
    for (const consumer of queue.consumers) {
      const spec = consumer.script === null ? null : fenced.get(consumer.script);
      if (spec && (spec.kind !== 'queue-consumer' || spec.queueId !== queue.queueId)) consumerDrift.add(spec.name);
    }
  }
  const delivery = new Map();
  for (const spec of plan.fencedScripts.filter(item => item.kind === 'queue-consumer')) {
    const queue = queues.get(spec.queueId);
    if (!queue || queue.consumers.length !== 1 || queue.consumers[0].type !== 'worker'
        || queue.consumers[0].script !== spec.name) {
      consumerDrift.add(spec.name);
      continue;
    }
    if (queue.deliveryPaused === null) fail('FENCE_PROVIDER_RESPONSE_INVALID');
    delivery.set(spec.name, { queueId: spec.queueId, queueName: queue.queueName, paused: queue.deliveryPaused });
  }
  if (consumerDrift.size) await refuse('CONSUMER_DRIFT', { scripts: [...consumerDrift] });
  const crons = new Map(fencedList.map(item => [item.name, item.crons]));
  // 6. Before any apply the crons must be the planned ones; apply, verify and
  // release compare against their own phase state instead.
  if (expectPlannedCrons) {
    const drifted = plan.fencedScripts.filter(spec => !sameList(crons.get(spec.name), [...spec.expectedCrons]));
    if (drifted.length) await refuse('SCHEDULE_DRIFT', { scripts: drifted.map(spec => spec.name) });
  }

  const productionStorage = [
    ...Object.entries(FENCE_D1_LABELS).filter(([, spec]) => spec.owner === 'production')
      .map(([label, spec]) => ({ label, binding: spec.binding, ref: idDigest('d1', plan.d1[label]) })),
    { label: 'quarantine', binding: FENCE_R2_BINDING, ref: idDigest('r2', plan.r2.bucket) },
  ];
  const fencedEntries = fencedList.map(script => {
    const spec = fenced.get(script.name);
    return {
      name: script.name,
      kind: spec.kind,
      queueIdSha256: spec.queueId === null ? null : idDigest('queue', spec.queueId),
      versions: script.versions.map(({ versionId, percentage, bindingsSha256 }) => ({ versionId, percentage, bindingsSha256 })),
      settingsBindingsSha256: script.settingsBindingsSha256,
      bindings: unique(allBindings(script).map(publicBinding)),
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
    capturedAt,
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
    scripts: survey.scripts,
    queues: survey.queues,
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
  const result = await client.mutate('PUT', `/accounts/${plan.accountId}/workers/scripts/${name}/schedules`,
    crons.map(cron => ({ cron })));
  const echoed = rows(result, 'schedules', 16);
  if (!sameList(cronList(echoed.map(item => item?.cron), 'FENCE_PROVIDER_RESPONSE_INVALID'), [...crons].sort())) {
    fail('FENCE_MUTATION_UNVERIFIED');
  }
}

async function setDelivery(client, plan, queueId, queueName, paused) {
  const result = await client.mutate('PATCH', `/accounts/${plan.accountId}/queues/${queueId}`,
    { queue_name: queueName, settings: { delivery_paused: paused } });
  if (record(result?.settings) && result.settings.delivery_paused !== undefined && result.settings.delivery_paused !== paused) {
    fail('FENCE_MUTATION_UNVERIFIED');
  }
}

const RECEIPT_INVALID = 'FENCE_RECEIPT_INVALID';

/** The prior state journalled before apply's first write: exactly one entry
 * per fenced script, with the action its kind implies and a well-formed
 * before value. release restores exactly this. */
function checkPriorState(value, plan) {
  if (!Array.isArray(value) || value.length !== plan.fencedScripts.length) fail(RECEIPT_INVALID);
  const seen = new Set();
  for (const item of value) {
    exactKeys(item, ['script', 'action', 'before'], RECEIPT_INVALID);
    const spec = plan.fencedScripts.find(candidate => candidate.name === item.script);
    if (!spec || seen.has(spec.name)) fail(RECEIPT_INVALID);
    seen.add(spec.name);
    if (spec.kind === 'cron') {
      exactKeys(item.before, ['crons'], RECEIPT_INVALID);
      if (item.action !== 'clear-schedules' || !sameList(cronList(item.before.crons, RECEIPT_INVALID), item.before.crons)) {
        fail(RECEIPT_INVALID);
      }
    } else {
      exactKeys(item.before, ['deliveryPaused'], RECEIPT_INVALID);
      if (item.action !== 'pause-delivery' || typeof item.before.deliveryPaused !== 'boolean') fail(RECEIPT_INVALID);
    }
  }
}

// The production deployment that was fenced and active at apply: the anchor
// for every "since the fence" history check.
function checkProductionAnchor(value) {
  if (!record(value) || !OPAQUE.test(value.deploymentId ?? '') || !UUID.test(value.versionId ?? '')
      || value.mode !== 'fenced') fail(RECEIPT_INVALID);
}

function checkR2Digest(value) {
  exactKeys(value, ['bucketSha256', 'inventorySha256', 'objects', 'bytes'], RECEIPT_INVALID);
  if (!SHA256.test(value.bucketSha256 ?? '') || !SHA256.test(value.inventorySha256 ?? '')
      || !count(value.objects) || !count(value.bytes)) fail(RECEIPT_INVALID);
}

function checkApplyIntent(value, plan, planReceiptSha256) {
  exactKeys(value, ['schema', 'planSha256', 'planReceiptSha256', 'startedAtMs', 'analyticsDrainAttested',
    'productionWorker', 'r2Baseline', 'priorState'], RECEIPT_INVALID);
  if (value.planSha256 !== plan.planSha256 || value.planReceiptSha256 !== planReceiptSha256
      || !Number.isSafeInteger(value.startedAtMs) || value.analyticsDrainAttested !== true) fail(RECEIPT_INVALID);
  checkProductionAnchor(value.productionWorker);
  checkR2Digest(value.r2Baseline);
  checkPriorState(value.priorState, plan);
}

function checkApplyReceipt(value, plan, planReceiptSha256) {
  exactKeys(value, ['schema', 'planSha256', 'planReceiptSha256', 'fingerprintSha256', 'startedAtMs', 'appliedAtMs',
    'quietWindowMinutes', 'analyticsDrainAttested', 'productionWorker', 'r2Baseline', 'priorState', 'fencedState',
    'mutationsIssued'], RECEIPT_INVALID);
  if (value.planSha256 !== plan.planSha256 || value.planReceiptSha256 !== planReceiptSha256
      || !Number.isSafeInteger(value.appliedAtMs) || !Number.isSafeInteger(value.startedAtMs)
      || value.appliedAtMs < value.startedAtMs || !SHA256.test(value.fingerprintSha256 ?? '')
      || value.quietWindowMinutes !== plan.quietWindowMinutes || value.analyticsDrainAttested !== true) {
    fail(RECEIPT_INVALID);
  }
  checkProductionAnchor(value.productionWorker);
  checkR2Digest(value.r2Baseline);
  checkPriorState(value.priorState, plan);
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
  const inventory = await collectInventory(client, plan, { now, requireFenced: false, expectPlannedCrons: true, receiptsDirectory });
  return writeReceipt(contentPath(receiptsDirectory, 'inventory', inventory.receipt), inventory.receipt);
}

async function planCommand({ client, plan, now, receiptsDirectory }) {
  const inventory = await collectInventory(client, plan, { now, requireFenced: false, expectPlannedCrons: true, receiptsDirectory });
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
  const priorState = planReceipt.mutations.map(item => (record(item)
    ? { script: item.script, action: item.action, before: item.before } : item));
  checkPriorState(priorState, plan);
  // A released fence is over: its journal and R2 baseline describe a state
  // the writers have since moved past, so only a fresh plan fences again.
  if (await exists(join(receiptsDirectory, `release-${confirm}.json`))) fail('FENCE_RELEASED');
  const receiptPath = join(receiptsDirectory, `apply-${confirm}.json`);
  if (await exists(receiptPath)) fail('FENCE_ALREADY_APPLIED');
  const intentPath = join(receiptsDirectory, `apply-intent-${confirm}.json`);
  const resuming = await exists(intentPath);
  let intent = null;
  if (resuming) {
    ({ value: intent } = await readReceipt(intentPath, FENCE_APPLY_INTENT_SCHEMA));
    checkApplyIntent(intent, plan, confirm);
    if (!sameList(intent.priorState, priorState)) fail(RECEIPT_INVALID);
  }
  const inventory = await collectInventory(client, plan, { now, requireFenced: true, receiptsDirectory });
  if (inventory.fingerprintSha256 !== planReceipt.fingerprintSha256) fail('FENCE_INVENTORY_CHANGED');
  const pending = [];
  for (const mutation of planReceipt.mutations) {
    const spec = plan.fencedScripts.find(item => item.name === mutation.script);
    if (mutation.action === 'clear-schedules') {
      const current = inventory.crons.get(spec.name);
      if (sameList(current, mutation.after?.crons) && (resuming || sameList(mutation.before.crons, current))) continue;
      if (!sameList(current, mutation.before.crons)) fail('SCHEDULE_DRIFT');
      pending.push({ spec, mutation });
    } else {
      const current = inventory.delivery.get(spec.name);
      if (!sameList(inventory.crons.get(spec.name), [])) fail('SCHEDULE_DRIFT');
      if (current.paused === mutation.after?.deliveryPaused && (resuming || mutation.before.deliveryPaused === true)) continue;
      if (current.paused !== mutation.before.deliveryPaused) fail('CONSUMER_DRIFT');
      pending.push({ spec, mutation, queue: current });
    }
  }
  // Every read and write this apply still needs must fit before the first
  // write: the R2 baseline (fresh apply only), one write per pending
  // mutation, and the schedules and queue readbacks.
  const consumers = plan.fencedScripts.filter(spec => spec.kind === 'queue-consumer').length;
  if (client.remaining() < (resuming ? 0 : R2_READS) + pending.length + plan.fencedScripts.length + consumers) {
    fail('FENCE_REQUEST_BUDGET');
  }
  if (!resuming) {
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
      priorState,
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
  const releasePath = join(receiptsDirectory, `release-${fence}.json`);
  if (await exists(releasePath)) fail('FENCE_RELEASED');
  const applyPath = join(receiptsDirectory, `apply-${fence}.json`);
  if (!await exists(applyPath)) fail('FENCE_NOT_APPLIED');
  const { value: apply, sha256: applyReceiptSha256 } = await readReceipt(applyPath, FENCE_APPLY_RECEIPT_SCHEMA);
  checkApplyReceipt(apply, plan, fence);
  const quietMs = plan.quietWindowMinutes * 60_000;
  const endMs = now();
  // Analytics stop a lag margin short of now; that interval must itself be a
  // full quiet window, so absent (not yet ingested) data is never the proof.
  const analyticsEndMs = endMs - FENCE_ANALYTICS_LAG_MINUTES * 60_000;
  const startMs = windowStartMs ?? apply.appliedAtMs + quietMs;
  if (startMs < apply.appliedAtMs + quietMs) fail('FENCE_WINDOW_TOO_EARLY');
  if (analyticsEndMs - startMs < quietMs) fail('FENCE_WINDOW_TOO_SHORT');

  const inventory = await collectInventory(client, plan, { now, requireFenced: true, receiptsDirectory });
  if (inventory.fingerprintSha256 !== apply.fingerprintSha256) fail('FENCE_INVENTORY_CHANGED');
  for (const deployment of await productionHistory(client, plan, apply.productionWorker.deploymentId)) {
    if (!singleVersion(deployment) || deployment.modes[0] !== 'fenced') fail('PRODUCTION_WORKER_NOT_FENCED');
  }
  // The receipt states the observed schedules and delivery, not the target.
  const fencedScripts = plan.fencedScripts.map(spec => {
    const crons = inventory.crons.get(spec.name);
    const deliveryPaused = spec.kind === 'queue-consumer' ? inventory.delivery.get(spec.name).paused : null;
    if (crons.length !== 0 || (spec.kind === 'queue-consumer' && deliveryPaused !== true)) fail('FENCE_NOT_APPLIED');
    return { name: spec.name, kind: spec.kind, crons, deliveryPaused };
  });

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
  const analyticsWindow = { start: window.start, end: iso(analyticsEndMs) };
  const labelOf = new Map(Object.entries(plan.d1).map(([label, id]) => [id, label]));
  const writes = Object.fromEntries(Object.keys(plan.d1).map(label => [label, { rowsWritten: 0, writeQueries: 0 }]));
  const d1Groups = (await client.graphql('d1Writes', { accountTag: plan.accountId, ...analyticsWindow,
    databaseIds: Object.values(plan.d1) })).d1AnalyticsAdaptiveGroups;
  if (!Array.isArray(d1Groups) || d1Groups.length >= 100) fail('FENCE_ANALYTICS_INVALID');
  for (const group of d1Groups) {
    const label = labelOf.get(group?.dimensions?.databaseId);
    const { rowsWritten, writeQueries } = group?.sum ?? {};
    if (!label || !count(rowsWritten) || !count(writeQueries)) fail('FENCE_ANALYTICS_INVALID');
    writes[label].rowsWritten += rowsWritten;
    writes[label].writeQueries += writeQueries;
  }
  if (Object.values(writes).some(item => item.rowsWritten !== 0 || item.writeQueries !== 0)) fail('FENCE_NOT_QUIESCENT');
  const fencedNames = plan.fencedScripts.map(spec => spec.name);
  const invocationGroups = (await client.graphql('invocations', { accountTag: plan.accountId, ...analyticsWindow,
    scriptNames: fencedNames })).workersInvocationsAdaptive;
  if (!Array.isArray(invocationGroups) || invocationGroups.length >= 100) fail('FENCE_ANALYTICS_INVALID');
  let invocations = 0;
  for (const group of invocationGroups) {
    const requests = group?.sum?.requests;
    if (!fencedNames.includes(group?.dimensions?.scriptName) || !count(requests)) fail('FENCE_ANALYTICS_INVALID');
    invocations += requests;
  }
  if (invocations !== 0) fail('FENCE_NOT_QUIESCENT');

  // verify holds the receipts lock, so no release runs concurrently; the
  // re-check keeps a fence receipt from ever post-dating a release receipt.
  if (await exists(releasePath)) fail('FENCE_RELEASED');
  const receipt = {
    schema: FENCE_RECEIPT_SCHEMA,
    planSha256: plan.planSha256,
    planReceiptSha256: fence,
    applyReceiptSha256,
    accountSha256: idDigest('account', plan.accountId),
    verifiedAt: iso(endMs),
    productionWorker: { name: plan.productionWorker, deploymentId: inventory.production.deploymentId,
      versionId: inventory.production.versionId, mode: 'fenced', sourceCommit: inventory.production.sourceCommit },
    fencedScripts,
    window: { appliedAt: iso(apply.appliedAtMs), quietWindowMinutes: plan.quietWindowMinutes, ...window },
    d1,
    r2,
    analytics: {
      querySha256: { ...FENCE_GRAPHQL_QUERY_SHA256 },
      window: { ...analyticsWindow, lagMinutes: FENCE_ANALYTICS_LAG_MINUTES },
      d1: Object.entries(writes).map(([label, item]) => ({ label, ...item })),
      fencedScriptInvocations: invocations,
    },
  };
  return writeReceipt(contentPath(receiptsDirectory, 'fence', receipt), receipt);
}

async function releaseCommand({ client, plan, now, receiptsDirectory, confirm }) {
  const receiptPath = join(receiptsDirectory, `release-${confirm}.json`);
  if (await exists(receiptPath)) fail('FENCE_ALREADY_RELEASED');
  // apply journals the prior state before its first write, so the journal
  // exists both for a complete apply and for one that stopped partway (and
  // cannot resume); the apply receipt, when present, must agree with it.
  const intentPath = join(receiptsDirectory, `apply-intent-${confirm}.json`);
  const applyPath = join(receiptsDirectory, `apply-${confirm}.json`);
  const intent = await exists(intentPath) ? await readReceipt(intentPath, FENCE_APPLY_INTENT_SCHEMA) : null;
  const apply = await exists(applyPath) ? await readReceipt(applyPath, FENCE_APPLY_RECEIPT_SCHEMA) : null;
  if (intent === null && apply === null) fail('FENCE_CONFIRMATION_MISMATCH');
  if (intent !== null) checkApplyIntent(intent.value, plan, confirm);
  if (apply !== null) checkApplyReceipt(apply.value, plan, confirm);
  if (intent !== null && apply !== null && (!sameList(intent.value.priorState, apply.value.priorState)
      || intent.value.productionWorker.deploymentId !== apply.value.productionWorker.deploymentId)) fail(RECEIPT_INVALID);
  const origin = (apply ?? intent).value;
  const history = await productionHistory(client, plan, origin.productionWorker.deploymentId);
  // An unrecognized mode cannot be proved non-gcp, so it refuses too.
  if (history.some(deployment => deployment.modes.some(mode => mode !== null && mode !== 'worker' && mode !== 'fenced'))) {
    fail('FENCE_RELEASE_AFTER_GCP');
  }

  // Only a script still at the fenced target is restored; one already at its
  // prior value is left alone, and any other value is someone else's change.
  const targets = [];
  for (const prior of origin.priorState) {
    const spec = plan.fencedScripts.find(item => item.name === prior.script);
    if (spec.kind === 'cron') {
      const restore = prior.before.crons;
      const current = await readSchedules(client, plan, spec.name);
      if (!sameList(current, []) && !sameList(current, restore)) fail('SCHEDULE_DRIFT');
      targets.push({ spec, prior: { crons: restore }, pending: !sameList(current, restore) });
    } else {
      const restore = prior.before.deliveryPaused;
      const queue = await readQueue(client, plan, spec.queueId);
      if (queue.deliveryPaused !== true && queue.deliveryPaused !== restore) fail('CONSUMER_DRIFT');
      targets.push({ spec, prior: { deliveryPaused: restore }, queue, pending: queue.deliveryPaused !== restore });
    }
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
    releasedFrom: apply === null ? 'apply-intent' : 'apply',
    applyReceiptSha256: apply?.sha256 ?? null,
    applyIntentSha256: intent?.sha256 ?? null,
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
  // apply, verify and release serialise on the receipts directory, so a fence
  // receipt is never written while a release of the same fence is running.
  const unlock = ['apply', 'verify', 'release'].includes(subcommand) ? await lockReceipts(receiptsDirectory) : () => {};
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

function checkFenceReceipt(value) {
  exactKeys(value, ['schema', 'planSha256', 'planReceiptSha256', 'applyReceiptSha256', 'accountSha256', 'verifiedAt',
    'productionWorker', 'fencedScripts', 'window', 'd1', 'r2', 'analytics'], RECEIPT_INVALID);
  if (['planSha256', 'planReceiptSha256', 'applyReceiptSha256', 'accountSha256'].some(key => !SHA256.test(value[key] ?? ''))) {
    fail(RECEIPT_INVALID);
  }
  const production = value.productionWorker;
  exactKeys(production, ['name', 'deploymentId', 'versionId', 'mode', 'sourceCommit'], RECEIPT_INVALID);
  if (!SCRIPT.test(production.name ?? '') || !OPAQUE.test(production.deploymentId ?? '') || !UUID.test(production.versionId ?? '')
      || production.mode !== 'fenced'
      || !(production.sourceCommit === null || (typeof production.sourceCommit === 'string' && COMMIT.test(production.sourceCommit)))) {
    fail(RECEIPT_INVALID);
  }
  if (!Array.isArray(value.fencedScripts) || value.fencedScripts.length < 1 || value.fencedScripts.length > MAX_FENCED_SCRIPTS) {
    fail(RECEIPT_INVALID);
  }
  const names = new Set([production.name]);
  for (const item of value.fencedScripts) {
    exactKeys(item, ['name', 'kind', 'crons', 'deliveryPaused'], RECEIPT_INVALID);
    if (!SCRIPT.test(item.name ?? '') || names.has(item.name) || !Array.isArray(item.crons) || item.crons.length !== 0
        || !(item.kind === 'cron' ? item.deliveryPaused === null : item.kind === 'queue-consumer' && item.deliveryPaused === true)) {
      fail(RECEIPT_INVALID);
    }
    names.add(item.name);
  }
  // Every time must be a canonical ISO instant; NaN never passes a comparison.
  exactKeys(value.window, ['appliedAt', 'quietWindowMinutes', 'start', 'end'], RECEIPT_INVALID);
  const quiet = value.window.quietWindowMinutes;
  const [appliedAtMs, startMs, endMs, verifiedAtMs] = [value.window.appliedAt, value.window.start, value.window.end,
    value.verifiedAt].map(isoMs);
  if (!Number.isSafeInteger(quiet) || quiet < FENCE_MIN_QUIET_WINDOW_MINUTES || quiet > 1_440
      || [appliedAtMs, startMs, endMs, verifiedAtMs].includes(null)
      || startMs < appliedAtMs + quiet * 60_000 || endMs - startMs < quiet * 60_000 || verifiedAtMs !== endMs) {
    fail(RECEIPT_INVALID);
  }
  const labels = Object.keys(FENCE_D1_LABELS);
  if (!Array.isArray(value.d1) || value.d1.length !== labels.length) fail(RECEIPT_INVALID);
  value.d1.forEach((item, index) => {
    exactKeys(item, ['label', 'idSha256', 'bookmark'], RECEIPT_INVALID);
    if (item.label !== labels[index] || !SHA256.test(item.idSha256 ?? '') || !OPAQUE.test(item.bookmark ?? '')) fail(RECEIPT_INVALID);
  });
  if (new Set(value.d1.map(item => item.idSha256)).size !== labels.length) fail(RECEIPT_INVALID);
  checkR2Digest(value.r2);
  const { analytics } = value;
  exactKeys(analytics, ['querySha256', 'window', 'd1', 'fencedScriptInvocations'], RECEIPT_INVALID);
  exactKeys(analytics.querySha256, Object.keys(FENCE_GRAPHQL_QUERY_SHA256), RECEIPT_INVALID);
  if (Object.entries(FENCE_GRAPHQL_QUERY_SHA256).some(([name, digest]) => analytics.querySha256[name] !== digest)) {
    fail(RECEIPT_INVALID);
  }
  exactKeys(analytics.window, ['start', 'end', 'lagMinutes'], RECEIPT_INVALID);
  const lag = analytics.window.lagMinutes;
  const analyticsEndMs = isoMs(analytics.window.end);
  if (analytics.window.start !== value.window.start || !Number.isSafeInteger(lag) || lag < FENCE_ANALYTICS_LAG_MINUTES
      || analyticsEndMs === null || analyticsEndMs !== endMs - lag * 60_000 || analyticsEndMs - startMs < quiet * 60_000) {
    fail(RECEIPT_INVALID);
  }
  if (!Array.isArray(analytics.d1) || analytics.d1.length !== labels.length) fail(RECEIPT_INVALID);
  analytics.d1.forEach((item, index) => {
    exactKeys(item, ['label', 'rowsWritten', 'writeQueries'], RECEIPT_INVALID);
    if (item.label !== labels[index] || item.rowsWritten !== 0 || item.writeQueries !== 0) fail(RECEIPT_INVALID);
  });
  if (analytics.fencedScriptInvocations !== 0) fail(RECEIPT_INVALID);
}

/**
 * Consumer-side reader for PT-2 and HX-6. Returns the fence receipt only when
 * its bytes hash to the pinned sha256, its closed shape holds, it still sits
 * in its private receipts directory beside the apply receipt it names, and
 * that fence has not been released. The answer holds as of the read: a
 * consumer that acts later reads again.
 */
export async function readCloudflareWriterFenceReceipt(path, expectedSha256) {
  if (typeof path !== 'string' || !SHA256.test(expectedSha256 ?? '')) fail(RECEIPT_INVALID);
  const receiptPath = resolve(path);
  const directory = dirname(receiptPath);
  await assertPrivateDirectory(directory);
  const { value, sha256: actual } = await readReceipt(receiptPath, FENCE_RECEIPT_SCHEMA);
  if (actual !== expectedSha256) fail(RECEIPT_INVALID);
  checkFenceReceipt(value);
  if (await exists(join(directory, `release-${value.planReceiptSha256}.json`))) fail('FENCE_RELEASED');
  const applyPath = join(directory, `apply-${value.planReceiptSha256}.json`);
  if (!await exists(applyPath)) fail(RECEIPT_INVALID);
  const { value: apply, sha256: applySha256 } = await readReceipt(applyPath, FENCE_APPLY_RECEIPT_SCHEMA);
  if (applySha256 !== value.applyReceiptSha256 || apply.planSha256 !== value.planSha256
      || apply.planReceiptSha256 !== value.planReceiptSha256 || !Number.isSafeInteger(apply.appliedAtMs)
      || iso(apply.appliedAtMs) !== value.window.appliedAt || apply.quietWindowMinutes !== value.window.quietWindowMinutes
      || !sameList(apply.r2Baseline, value.r2)) {
    fail(RECEIPT_INVALID);
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

/** Provider failures can carry tokens, ids or metadata, so the CLI emits only
 * the code, plus the content-addressed inventory-refusal receipt when one was
 * written. */
export function cloudflareWriterFenceErrorLine(error) {
  const code = /^[A-Z][A-Z0-9_]{2,95}$/.test(error?.code ?? '') ? error.code : 'FENCE_FAILED';
  const refusal = typeof error?.refusalReceipt === 'string' && /^inventory-refusal-[a-f0-9]{64}\.json$/.test(error.refusalReceipt)
    ? ` ${error.refusalReceipt}` : '';
  return `${code}${refusal}\n`;
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
    process.stderr.write(cloudflareWriterFenceErrorLine(error));
    process.exitCode = 1;
  }
}

for (const [name, text] of Object.entries(FENCE_GRAPHQL_QUERIES)) {
  if (sha256(text) !== FENCE_GRAPHQL_QUERY_SHA256[name]) throw operationError('FENCE_GRAPHQL_QUERY_UNPINNED');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
