import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { identityDigest, openOperation, operationError, readOperation } from '../../../scripts/lib/release-operation.mjs';
import validation from './wrangler-query-preload.cjs';
import { createMaintenanceProvider } from './production-maintenance-provider.mjs';
import { createProductionDeploymentLock } from './production-deployment-lock.mjs';
import { readMaintenanceFile, validateMaintenancePlan, validateMaintenanceState } from './production-maintenance.mjs';
import { FROZEN_ACCOUNTLESS_SOURCE_TABLES } from './storage-existing-owner-bootstrap-runtime.mjs';
import { matchesExactBootstrapQueueConsumer } from './cloudflare-queue-consumer.mjs';

const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const QID = /^[a-f0-9]{32}$/;
const fail = code => { throw operationError(`D1_STORAGE_EXISTING_BOOTSTRAP_${code}`); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...keys].sort().join();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const RUNTIME_SCHEMA = 'storage-existing-accountless-bootstrap-operation-v1';
const MAX_REQUESTS = 160;
const boundedList = (value, key, max) => { const rows = Array.isArray(value) ? value : value?.[key];
  if (!Array.isArray(rows) || rows.length > max) fail('INVENTORY_UNBOUNDED'); return rows; };
const SOURCE_STATUS_SQL = `SELECT operation_digest,source_id,source_database_id,catalog_database_id,shard_id,binding_name,
 route_reservation_bytes,closure_digest,trigger_digest,state,manifest_digest,owner_roster_digest,revision,frozen_at,released_at
 FROM storage_existing_accountless_bootstrap_source_closure WHERE singleton_id=1 LIMIT 2`;
const CATALOG_STATUS_SQL = `SELECT p.manifest_digest,p.state,p.after_owner_id,p.imported_count,p.revision,
 m.owner_count,m.owner_roster_digest,m.source_closure_digest,m.source_id,m.shard_id,m.binding_name,m.route_reservation_bytes
 FROM storage_existing_accountless_bootstrap_progress p JOIN storage_existing_accountless_bootstrap_manifests m
 ON m.singleton_id=p.singleton_id AND m.manifest_digest=p.manifest_digest WHERE p.singleton_id=1 LIMIT 2`;

export function validateExistingAccountlessBootstrapOperatorPlan(value) {
  if (!exact(value, ['schema', 'toolingCommit', 'accountId', 'workerName', 'queueName', 'sourceDatabase',
    'catalogDatabase', 'sourceId', 'shardId', 'bindingName', 'perOwnerFutureHeadroomBytes', 'newOwnerCutoffBytes', 'databaseBudgetBytes',
    'expiresAt', 'wranglerSha256', 'maintenance'])
    || value.schema !== 'storage-existing-accountless-bootstrap-operator-v1' || !COMMIT.test(value.toolingCommit)
    || !/^[a-f0-9]{32}$/.test(value.accountId) || !/^[a-z][a-z0-9-]{2,62}$/.test(value.workerName)
    || !/^[a-z][a-z0-9-]{2,62}$/.test(value.queueName) || value.workerName === value.queueName
    || !exact(value.sourceDatabase, ['id', 'name']) || !exact(value.catalogDatabase, ['id', 'name'])
    || !UUID.test(value.sourceDatabase.id) || !UUID.test(value.catalogDatabase.id)
    || value.sourceDatabase.id === value.catalogDatabase.id || value.sourceDatabase.name === value.catalogDatabase.name
    || !/^[a-z][a-z0-9-]{2,95}$/.test(value.sourceDatabase.name)
    || !/^[a-z][a-z0-9-]{2,95}$/.test(value.catalogDatabase.name)
    || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value.sourceId)
    || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value.shardId)
    || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.bindingName)
    || !Number.isSafeInteger(value.perOwnerFutureHeadroomBytes) || value.perOwnerFutureHeadroomBytes < 1
    || value.perOwnerFutureHeadroomBytes > 268_435_456 || value.newOwnerCutoffBytes !== 6_000_000_000
    || value.databaseBudgetBytes !== 9_000_000_000
    || !Number.isSafeInteger(value.expiresAt) || !SHA.test(value.wranglerSha256)
    || !exact(value.maintenance, ['planDigest', 'operationId', 'versionId', 'owner'])
    || !SHA.test(value.maintenance.planDigest) || !UUID.test(value.maintenance.operationId)
    || !UUID.test(value.maintenance.versionId) || !COMMIT.test(value.maintenance.owner)) fail('PLAN_INVALID');
  return structuredClone(value);
}

export function existingAccountlessBootstrapRuntimePlan(operatorPlan) {
  const plan = validateExistingAccountlessBootstrapOperatorPlan(operatorPlan);
  const operationDigest = identityDigest(plan);
  const triggerDigest = identityDigest({ schema: 1, tables: FROZEN_ACCOUNTLESS_SOURCE_TABLES });
  const sourceClosureDigest = identityDigest({ schema: 1, operationDigest, triggerDigest, sourceId: plan.sourceId,
    sourceDatabaseId: plan.sourceDatabase.id, catalogDatabaseId: plan.catalogDatabase.id });
  return Object.freeze({ schema: RUNTIME_SCHEMA, operationDigest, sourceId: plan.sourceId,
    sourceDatabase: plan.sourceDatabase, catalogDatabase: plan.catalogDatabase, shardId: plan.shardId,
    bindingName: plan.bindingName, routeReservationBytes: plan.perOwnerFutureHeadroomBytes, triggerDigest,
    sourceClosureDigest, expiresAt: plan.expiresAt });
}

export function existingAccountlessBootstrapConfig(plan, mode) {
  const runtime = existingAccountlessBootstrapRuntimePlan(plan);
  if (!['disabled', 'enabled'].includes(mode)) fail('MODE_INVALID');
  const config = { name: plan.workerName, account_id: plan.accountId, main: 'bootstrap-worker.mjs',
    compatibility_date: '2026-07-26', compatibility_flags: ['nodejs_compat'], workers_dev: false,
    preview_urls: false, routes: [], triggers: { crons: [] }, observability: { enabled: false },
    vars: { STORAGE_EXISTING_BOOTSTRAP_MODE: mode, STORAGE_EXISTING_BOOTSTRAP_OPERATION_DIGEST: runtime.operationDigest },
    d1_databases: [
      { binding: 'SOURCE', database_name: plan.sourceDatabase.name, database_id: plan.sourceDatabase.id },
      { binding: 'STORAGE_ROUTING_DB', database_name: plan.catalogDatabase.name, database_id: plan.catalogDatabase.id },
    ] };
  if (mode === 'enabled') config.queues = { consumers: [{ queue: plan.queueName, max_batch_size: 1,
    max_batch_timeout: 1, max_concurrency: 1, max_retries: 0 }] };
  return config;
}

async function privateDirectory(directory, create = false) {
  if (create) await mkdir(directory, { mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || await realpath(directory) !== resolve(directory) || (info.mode & 0o077)
    || process.getuid && info.uid !== process.getuid()) fail('DIRECTORY_UNSAFE');
}
async function writeExclusive(path, bytes) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

export async function prepareExistingAccountlessBootstrapPackage({ workerRoot, directory, plan, checkSource = null }) {
  workerRoot = resolve(workerRoot); directory = resolve(directory); plan = validateExistingAccountlessBootstrapOperatorPlan(plan);
  if (checkSource) await checkSource(workerRoot, plan.toolingCommit);
  else {
    const { execFileSync } = await import('node:child_process');
    try {
      if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workerRoot, encoding: 'utf8' }).trim() !== plan.toolingCommit
        || execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: workerRoot, encoding: 'utf8' }).trim()) fail('SOURCE_CHANGED');
    } catch { fail('SOURCE_CHANGED'); }
  }
  await privateDirectory(directory, true);
  const runtimePlan = existingAccountlessBootstrapRuntimePlan(plan);
  const require = createRequire(join(workerRoot, 'package.json')), { build } = require('esbuild');
  const source = `import * as bootstrap from './src/storage-existing-owner-bootstrap.ts';
import {sha256Hex} from './src/crypto.ts';
import {createExistingAccountlessBootstrapWorker} from './scripts/storage-existing-owner-bootstrap-runtime.mjs';
export default createExistingAccountlessBootstrapWorker({api:{...bootstrap,sha256Hex},plan:${JSON.stringify(runtimePlan)}});`;
  const built = await build({ stdin: { contents: source, resolveDir: workerRoot, sourcefile: 'bootstrap-entry.ts', loader: 'ts' },
    bundle: true, platform: 'browser', target: 'es2022', format: 'esm', write: false, logLevel: 'silent' });
  if (built.outputFiles.length !== 1) fail('BUNDLE_INVALID');
  const bundle = built.outputFiles[0].contents;
  const bundleSha256 = hash(bundle);
  const configFor = mode => { const config = existingAccountlessBootstrapConfig(plan, mode);
    config.vars.STORAGE_EXISTING_BOOTSTRAP_BUNDLE_SHA256 = bundleSha256; return config; };
  const disabledBytes = `${JSON.stringify(configFor('disabled'), null, 2)}\n`;
  const enabledBytes = `${JSON.stringify(configFor('enabled'), null, 2)}\n`;
  const files = { 'bootstrap-worker.mjs': bundle,
    'wrangler.disabled.jsonc': disabledBytes,
    'wrangler.enabled.jsonc': enabledBytes,
    'plan.json': `${JSON.stringify(plan)}\n`,
    'preparation.json': `${JSON.stringify({ schema: 'storage-existing-accountless-bootstrap-preparation-v1',
      planDigest: identityDigest(plan), runtimePlanDigest: identityDigest(runtimePlan), bundleSha256,
      disabledConfigSha256: hash(disabledBytes), enabledConfigSha256: hash(enabledBytes),
      remoteOperations: false, initialMode: 'disabled', httpIngress: 'none', cronIngress: 'none',
      driver: 'private-cloudflare-queue' })}\n` };
  for (const [name, bytes] of Object.entries(files)) await writeExclusive(join(directory, name), bytes);
  return JSON.parse(files['preparation.json']);
}

const PREPARED_PACKAGE_FILES = Object.freeze(['bootstrap-worker.mjs', 'wrangler.disabled.jsonc',
  'wrangler.enabled.jsonc', 'plan.json', 'preparation.json']);
async function preparedPackageDigest(directory) {
  await privateDirectory(directory);
  const files = [];
  for (const name of PREPARED_PACKAGE_FILES) files.push({ name,
    sha256: hash(await readMaintenanceFile(join(directory, name), 16 * 1024 * 1024)) });
  return identityDigest({ schema: 'storage-existing-bootstrap-package-v1', files });
}

async function responseBytes(response) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > 2_000_000) fail('RESPONSE_TOO_LARGE'); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

export function createExistingAccountlessBootstrapTransport({ plan, packageDirectory, cliPath, token,
  fetcher = fetch, spawn = spawnSync, environment = process.env, receipt = async () => {} }) {
  plan = validateExistingAccountlessBootstrapOperatorPlan(plan); packageDirectory = resolve(packageDirectory);
  if (['CLOUDFLARE_API_BASE_URL', 'CF_API_BASE_URL', 'WRANGLER_API_ENVIRONMENT', 'CLOUDFLARE_ENV', 'NODE_OPTIONS']
    .some(key => Object.hasOwn(environment, key))) fail('ENVIRONMENT_OVERRIDE');
  const cli = validation.verifyCli(cliPath, plan.wranglerSha256), account = `/accounts/${plan.accountId}`;
  let requests = 0;
  const api = async (method, path, body, mutation = false) => {
    if (!['GET', 'POST', 'DELETE'].includes(method) || !path.startsWith(`${account}/`) || ++requests > MAX_REQUESTS
      || mutation && !['POST', 'DELETE'].includes(method) || !mutation && method === 'DELETE') fail('REQUEST_INVALID');
    if (typeof token !== 'string' || token.length < 16) fail('CREDENTIAL_REQUIRED');
    let response, bytes;
    try { response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, { method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(20_000) });
      bytes = await responseBytes(response); } catch { fail(mutation ? 'MUTATION_UNCERTAIN' : 'READ_UNCERTAIN'); }
    await receipt({ kind: mutation ? 'api-mutation-result' : 'api-read-result', method,
      pathDigest: hash(path), status: response.status, bytes: bytes.length, responseDigest: hash(bytes) });
    let json; try { json = JSON.parse(bytes); } catch { fail('RESPONSE_INVALID'); }
    if (!response.ok || json.success !== true) fail(mutation ? 'MUTATION_REFUSED' : 'READ_REFUSED');
    if (json.result_info?.total_pages > 1 || json.result_info?.has_more === true || json.result_info?.cursor) fail('INVENTORY_UNBOUNDED');
    return json.result;
  };
  const d1 = async (databaseId, sql) => {
    const result = await api('POST', `${account}/d1/database/${databaseId}/query`, { sql, params: [] }, false);
    if (!Array.isArray(result) || result.length !== 1 || result[0].success !== true || !Array.isArray(result[0].results)
      || result[0].results.length > 2) fail('READBACK_INVALID');
    return result[0].results;
  };
  const run = async (step, mode, args, dry = false) => {
    const config = join(packageDirectory, `wrangler.${mode}.jsonc`), configDigest = hash(await readFile(config));
    validation.verifyCli(cliPath, plan.wranglerSha256);
    const env = { PATH: environment.PATH, HOME: environment.HOME, TMPDIR: environment.TMPDIR, CI: 'true', NO_COLOR: '1',
      CLOUDFLARE_ACCOUNT_ID: plan.accountId, ...(dry ? {} : { CLOUDFLARE_API_TOKEN: token }), WRANGLER_SEND_METRICS: 'false',
      WRANGLER_SEND_ERROR_REPORTS: 'false', WRANGLER_LOG_PATH: '/dev/null' };
    if (!dry && (typeof token !== 'string' || token.length < 16)) fail('CREDENTIAL_REQUIRED');
    const result = spawn(process.execPath, [cli.canonical, ...args, ...(dry ? [] : ['--tag', `existing-bootstrap-${mode}-${configDigest}`]), '--config', config], { cwd: packageDirectory,
      env, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
    await receipt({ kind: 'wrangler-result', step, configDigest, cliDigest: cli.digest, status: result.status ?? null,
      signal: result.signal ?? null, errorCode: result.error?.code ?? null, stdoutDigest: hash(String(result.stdout ?? '')),
      stderrDigest: hash(String(result.stderr ?? '')) });
    if (hash(await readFile(config)) !== configDigest) fail('CONFIG_CHANGED');
    if (result.error || result.status !== 0) fail('COMMAND_UNCERTAIN');
  };
  const database = async expected => { const value = await api('GET', `${account}/d1/database/${expected.id}`, undefined, false);
    if (value?.uuid !== expected.id || value?.name !== expected.name) fail('DATABASE_IDENTITY_CHANGED'); return value; };
  const queue = async id => { if (!QID.test(id ?? '')) fail('QUEUE_INVALID');
    const value = await api('GET', `${account}/queues/${id}`, undefined, false);
    if (value?.queue_id !== id || value?.queue_name !== plan.queueName) fail('QUEUE_IDENTITY_CHANGED'); return value; };
  const queues = async () => boundedList(await api('GET', `${account}/queues?page=1&per_page=100`, undefined, false), 'queues', 100);
  const workers = async () => boundedList(await api('GET', `${account}/workers/scripts?per_page=100`, undefined, false), 'scripts', 100);
  const assertDatabases = async () => { await database(plan.sourceDatabase); await database(plan.catalogDatabase); };
  const findQueue = async () => { const matches = (await queues()).filter(item => item.queue_name === plan.queueName);
    if (matches.length > 1 || matches[0] && !QID.test(matches[0].queue_id ?? '')) fail('QUEUE_IDENTITY_CHANGED'); return matches[0] ?? null; };
  const exactOwnedConsumer = (consumers, queueId, allowAbsent = false) => {
    if (!Array.isArray(consumers) || consumers.length > 1 || !consumers.length && !allowAbsent) fail('QUEUE_CONSUMER_CHANGED');
    if (!consumers.length) return null;
    const consumer = consumers[0];
    if (!QID.test(consumer?.consumer_id ?? '') || !matchesExactBootstrapQueueConsumer(consumer, {
      workerName: plan.workerName, queueName: plan.queueName, queueId,
    })) fail('QUEUE_CONSUMER_CHANGED');
    return consumer;
  };
  const inspectWorkerState = async (mode, allowOwnedConsumer = false) => {
    const preparation = JSON.parse(await readFile(join(packageDirectory, 'preparation.json'), 'utf8'));
    if (preparation.planDigest !== identityDigest(plan) || !SHA.test(preparation.bundleSha256)
      || preparation[`${mode}ConfigSha256`] !== hash(await readFile(join(packageDirectory, `wrangler.${mode}.jsonc`)))) fail('PACKAGE_CHANGED');
    const settings = await api('GET', `${account}/workers/scripts/${plan.workerName}/settings`, undefined, false);
    const subdomain = await api('GET', `${account}/workers/scripts/${plan.workerName}/subdomain`, undefined, false);
    const routes = await api('GET', `${account}/workers/services/${plan.workerName}/environments/production/routes?show_zonename=true`, undefined, false);
    const scheduleResponse = await api('GET', `${account}/workers/scripts/${plan.workerName}/schedules`, undefined, false);
    const schedules = Array.isArray(scheduleResponse) ? scheduleResponse
      : exact(scheduleResponse, ['schedules']) ? scheduleResponse.schedules : null;
    if (subdomain?.enabled !== false || subdomain?.previews_enabled !== false
      || !Array.isArray(routes) || routes.length || !Array.isArray(schedules) || schedules.length) fail('WORKER_INGRESS_CHANGED');
    const bindings = settings?.bindings;
    if (!Array.isArray(bindings) || bindings.length > 8
      || !bindings.some(item => item.type === 'd1' && item.name === 'SOURCE' && (item.id ?? item.database_id) === plan.sourceDatabase.id)
      || !bindings.some(item => item.type === 'd1' && item.name === 'STORAGE_ROUTING_DB' && (item.id ?? item.database_id) === plan.catalogDatabase.id)
      || !bindings.some(item => item.type === 'plain_text' && item.name === 'STORAGE_EXISTING_BOOTSTRAP_MODE' && item.text === mode)
      || !bindings.some(item => item.type === 'plain_text' && item.name === 'STORAGE_EXISTING_BOOTSTRAP_OPERATION_DIGEST'
        && item.text === identityDigest(plan))
      || !bindings.some(item => item.type === 'plain_text' && item.name === 'STORAGE_EXISTING_BOOTSTRAP_BUNDLE_SHA256'
        && item.text === preparation.bundleSha256)) fail('WORKER_BINDINGS_CHANGED');
    const found = await findQueue();
    if (mode === 'enabled') {
      if (!found) fail('QUEUE_MISSING');
      const consumers = await api('GET', `${account}/queues/${found.queue_id}/consumers`, undefined, false);
      exactOwnedConsumer(consumers, found.queue_id);
    } else if (found) {
      const consumers = await api('GET', `${account}/queues/${found.queue_id}/consumers`, undefined, false);
      if (allowOwnedConsumer) exactOwnedConsumer(consumers, found.queue_id, true);
      else if (!Array.isArray(consumers) || consumers.length) fail('QUEUE_CONSUMER_CHANGED');
    }
    return true;
  };
  const inspectWorker = mode => inspectWorkerState(mode, false);
  const inspectWorkerForCleanup = () => inspectWorkerState('disabled', true);
  const inspectConsumerDetached = async queueId => {
    await queue(queueId);
    const consumers = await api('GET', `${account}/queues/${queueId}/consumers`, undefined, false);
    if (!Array.isArray(consumers) || consumers.length) fail('QUEUE_CONSUMER_CHANGED');
    return true;
  };
  return {
    assertDatabases, findQueue, queue, inspectWorker, inspectWorkerForCleanup, inspectConsumerDetached,
    async findWorker() { const matches = (await workers()).filter(item => item.id === plan.workerName);
      if (matches.length > 1) fail('WORKER_IDENTITY_CHANGED'); return matches[0] ?? null; },
    async createQueue() { await assertDatabases(); if (await findQueue()) fail('QUEUE_ALREADY_EXISTS');
      const value = await api('POST', `${account}/queues`, { queue_name: plan.queueName,
        settings: { delivery_delay: 0, delivery_paused: false, message_retention_period: 86400 } }, true);
      if (!QID.test(value?.queue_id ?? '') || value.queue_name !== plan.queueName) fail('MUTATION_UNCERTAIN');
      await queue(value.queue_id); return value.queue_id; },
    async deploy(mode, dry = false) { if (!['disabled', 'enabled'].includes(mode)) fail('MODE_INVALID');
      if (!dry) { await assertDatabases(); if (mode === 'enabled' && !await findQueue()) fail('QUEUE_MISSING'); }
      await run(`${dry ? 'dry-' : ''}deploy-${mode}`, mode, ['deploy', ...(dry ? ['--dry-run', '--outdir', join(packageDirectory, `dry-${mode}`)] : [])], dry);
      if (!dry) await inspectWorker(mode); },
    async disableWorkerForCleanup() { await assertDatabases(); await run('cleanup-deploy-disabled', 'disabled', ['deploy']);
      await inspectWorkerForCleanup(); },
    async detachConsumer(queueId) { await queue(queueId);
      const consumers = await api('GET', `${account}/queues/${queueId}/consumers`, undefined, false);
      const consumer = exactOwnedConsumer(consumers, queueId, true);
      if (!consumer) return true;
      await api('DELETE', `${account}/queues/${queueId}/consumers/${consumer.consumer_id}`, undefined, true);
      await inspectConsumerDetached(queueId); return true; },
    async push(queueId, body) { await queue(queueId); return api('POST', `${account}/queues/${queueId}/messages`,
      { body, content_type: 'json' }, true); },
    sourceStatus: async () => (await d1(plan.sourceDatabase.id, SOURCE_STATUS_SQL))[0] ?? null,
    catalogStatus: async () => (await d1(plan.catalogDatabase.id, CATALOG_STATUS_SQL))[0] ?? null,
    async deleteWorker() { await inspectWorker('disabled'); await api('DELETE', `${account}/workers/scripts/${plan.workerName}`, undefined, true);
      if ((await workers()).some(item => item.id === plan.workerName)) fail('DELETE_UNCERTAIN'); },
    async deleteQueue(queueId) { await queue(queueId); const consumers = await api('GET', `${account}/queues/${queueId}/consumers`, undefined, false);
      if (!Array.isArray(consumers) || consumers.length) fail('QUEUE_CONSUMER_CHANGED');
      await api('DELETE', `${account}/queues/${queueId}`, undefined, true);
      if ((await queues()).some(item => item.queue_id === queueId || item.queue_name === plan.queueName)) fail('DELETE_UNCERTAIN'); },
  };
}

export async function createExistingAccountlessBootstrapContainment({ plan, maintenancePlan, maintenanceOperationDirectory,
  repositoryRoot, maintenancePackageDirectory, bootstrapPackageDirectory, cliPath,
  fetcher = fetch, spawn = spawnSync, environment = process.env }) {
  plan = validateExistingAccountlessBootstrapOperatorPlan(plan);
  if (identityDigest(validateMaintenancePlan(maintenancePlan)) !== plan.maintenance.planDigest) fail('MAINTENANCE_CHANGED');
  const record = await readOperation(maintenanceOperationDirectory), state = validateMaintenanceState(record.state);
  if (record.id !== plan.maintenance.operationId || state.owner !== plan.maintenance.owner
    || state.uploadedVersion !== plan.maintenance.versionId || state.phase !== 'contained' || state.intent !== null
    || state.lock !== 'held') fail('MAINTENANCE_NOT_CONTAINED');
  createProductionDeploymentLock({ repositoryRoot }).assertOwned(state.owner);
  return async context => {
    const latest = await readOperation(maintenanceOperationDirectory), current = validateMaintenanceState(latest.state);
    if (latest.id !== record.id || current.owner !== state.owner || current.uploadedVersion !== state.uploadedVersion
      || current.phase !== 'contained' || current.intent !== null || current.lock !== 'held') fail('MAINTENANCE_NOT_CONTAINED');
    createProductionDeploymentLock({ repositoryRoot }).assertOwned(current.owner);
    const phase = context?.phase, queueId = context?.queueId;
    const isolationPhase = phase === 'queue-created' || phase === 'worker-deleted' ? 'queue-only'
      : phase === 'worker-disabled' ? 'disabled-before-detach'
        : phase === 'disabled' || phase === 'consumer-detached' ? 'disabled'
        : ['enabled', 'frozen', 'importing', 'ready', 'released'].includes(phase) ? 'enabled' : null;
    let isolatedBootstrap = null;
    if (isolationPhase !== null) {
      if (!QID.test(queueId ?? '')) fail('JOURNAL_INVALID');
      const preparation = JSON.parse(await readFile(join(bootstrapPackageDirectory, 'preparation.json'), 'utf8'));
      const bundleSha256 = hash(await readFile(join(bootstrapPackageDirectory, 'bootstrap-worker.mjs')));
      const disabledConfigSha256 = hash(await readFile(join(bootstrapPackageDirectory, 'wrangler.disabled.jsonc')));
      const enabledConfigSha256 = hash(await readFile(join(bootstrapPackageDirectory, 'wrangler.enabled.jsonc')));
      if (!exact(preparation, ['schema', 'planDigest', 'runtimePlanDigest', 'bundleSha256', 'disabledConfigSha256',
        'enabledConfigSha256', 'remoteOperations', 'initialMode', 'httpIngress', 'cronIngress', 'driver'])
        || preparation.planDigest !== identityDigest(plan) || preparation.bundleSha256 !== bundleSha256
        || preparation.disabledConfigSha256 !== disabledConfigSha256 || preparation.enabledConfigSha256 !== enabledConfigSha256) fail('PACKAGE_CHANGED');
      isolatedBootstrap = { schema: 'storage-existing-accountless-bootstrap-isolation-v1', phase: isolationPhase,
        operationDigest: identityDigest(plan), workerName: plan.workerName, queueName: plan.queueName, queueId,
        sourceDatabaseId: plan.sourceDatabase.id, catalogDatabaseId: plan.catalogDatabase.id, bundleSha256,
        disabledConfigSha256, enabledConfigSha256 };
    }
    const provider = await createMaintenanceProvider({ plan: maintenancePlan, packageDirectory: maintenancePackageDirectory,
      operationDirectory: maintenanceOperationDirectory, operationId: record.id, cliPath, fetcher, spawn, environment,
      isolatedBootstrap });
    await provider.verifyContained(current.uploadedVersion);
  };
}

function stateValid(state) {
  if (!exact(state, ['schema', 'phase', 'intent', 'queueId', 'manifestDigest', 'ownerRosterDigest', 'importedCount', 'packageDigest'])
    || state.schema !== 1 || !SHA.test(state.packageDigest) || !['prepared', 'queue-created', 'disabled', 'enabled', 'frozen', 'importing', 'ready',
      'released', 'worker-disabled', 'consumer-detached', 'worker-deleted', 'complete'].includes(state.phase)
    || !(state.intent === null || typeof state.intent === 'string') || !(state.queueId === null || QID.test(state.queueId))
    || !(state.manifestDigest === null || SHA.test(state.manifestDigest)) || !(state.ownerRosterDigest === null || SHA.test(state.ownerRosterDigest))
    || !Number.isSafeInteger(state.importedCount) || state.importedCount < 0) fail('JOURNAL_INVALID');
  return state;
}
const message = (runtime, action, releaseAuthorization) => ({ schema: 'storage-existing-accountless-bootstrap-wakeup-v1',
  operationDigest: runtime.operationDigest, action, ...(action === 'release' ? { releaseAuthorization } : {}) });
function releaseAuthorization(runtime, row) {
  return hash(`app-usagemonitor/storage-existing-accountless-bootstrap-release/v1\0${runtime.operationDigest}\0${row.manifest_digest}\0${row.owner_roster_digest}\0${row.revision}`);
}

export async function runExistingAccountlessBootstrapOperator({ plan, workerRoot, operationDirectory, action = 'prepare',
  confirmation = null, approvedPlanSha256 = null, transport = null, assertContained = null,
  prepare = prepareExistingAccountlessBootstrapPackage, clock = () => Date.now() }) {
  plan = validateExistingAccountlessBootstrapOperatorPlan(plan); const planDigest = identityDigest(plan), runtime = existingAccountlessBootstrapRuntimePlan(plan);
  if (!['prepare', 'dry-run', 'apply', 'release', 'cleanup'].includes(action) || approvedPlanSha256 !== planDigest) fail('APPROVAL_INVALID');
  if (action === 'apply' && confirmation !== 'ADVANCE_EXISTING_ACCOUNTLESS_BOOTSTRAP') fail('CONFIRMATION_REQUIRED');
  if (action === 'release' && confirmation !== 'RELEASE_IMPORTED_ACCOUNTLESS_SOURCE_WRITES') fail('CONFIRMATION_REQUIRED');
  if (action === 'cleanup' && confirmation !== 'CLEAN_UP_EXISTING_ACCOUNTLESS_BOOTSTRAP_OPERATOR') fail('CONFIRMATION_REQUIRED');
  const operation = await openOperation({ directory: operationDirectory, kind: 'qualification',
    binding: { schema: 1, planDigest }, resume: action !== 'prepare' });
  try {
    let state;
    if (action === 'prepare') {
      const packageDirectory = join(operation.directory, 'candidate');
      await prepare({ workerRoot, directory: packageDirectory, plan });
      state = { schema: 1, phase: 'prepared', intent: null, queueId: null, manifestDigest: null,
        ownerRosterDigest: null, importedCount: 0, packageDigest: await preparedPackageDigest(packageDirectory) }; await operation.save(state);
      return { code: 'EXISTING_ACCOUNTLESS_BOOTSTRAP_PREPARED', planDigest, remoteWrites: false };
    }
    state = stateValid(operation.record.state);
    const assertPackage = async () => {
      if (await preparedPackageDigest(join(operation.directory, 'candidate')) !== state.packageDigest) fail('PACKAGE_CHANGED');
    };
    await assertPackage();
    if ((action === 'apply' || action === 'release') && clock() >= plan.expiresAt) fail('OPERATION_EXPIRED');
    if (!transport) fail('TRANSPORT_REQUIRED');
    if (action === 'dry-run') { await transport.deploy('disabled', true); await transport.deploy('enabled', true);
      return { code: 'EXISTING_ACCOUNTLESS_BOOTSTRAP_DRY_RUN', remoteWrites: false }; }
    if (state.intent !== null) fail('RECONCILIATION_REQUIRED');
    if (!assertContained) fail('MAINTENANCE_PROOF_REQUIRED');
    await assertContained({ phase: state.phase, queueId: state.queueId });
    const saveIntent = async intent => { await assertPackage();
      if ((action === 'apply' || action === 'release') && clock() >= plan.expiresAt) fail('OPERATION_EXPIRED');
      state.intent = intent; await operation.save(state); };
    const settle = async phase => { state.phase = phase; state.intent = null; await operation.save(state); };
    if (action === 'apply') {
      if (state.phase === 'prepared') { await saveIntent('create-queue'); state.queueId = await transport.createQueue(); await settle('queue-created'); }
      else if (state.phase === 'queue-created') { await saveIntent('deploy-disabled'); await transport.deploy('disabled'); await settle('disabled'); }
      else if (state.phase === 'disabled') { await saveIntent('deploy-enabled'); await transport.deploy('enabled'); await settle('enabled'); }
      else if (state.phase === 'enabled') { await saveIntent('freeze'); await transport.push(state.queueId, message(runtime, 'freeze'));
        state.intent = null; await operation.save(state); return { code: 'EXISTING_ACCOUNTLESS_BOOTSTRAP_FREEZE_QUEUED', phase: state.phase }; }
      else if (state.phase === 'frozen' || state.phase === 'importing') { await saveIntent('advance'); await transport.push(state.queueId, message(runtime, 'advance'));
        state.intent = null; await operation.save(state); return { code: 'EXISTING_ACCOUNTLESS_BOOTSTRAP_ADVANCE_QUEUED', phase: state.phase }; }
      else if (state.phase === 'ready') return { code: 'EXISTING_ACCOUNTLESS_BOOTSTRAP_READY_FOR_RELEASE', phase: state.phase };
      else fail('PHASE_INVALID');
    } else if (action === 'release') {
      const source = await transport.sourceStatus(), catalog = await transport.catalogStatus();
      if (state.phase !== 'ready' || source?.state !== 'ready' || catalog?.state !== 'ready'
        || source.manifest_digest !== catalog.manifest_digest || source.owner_roster_digest !== catalog.owner_roster_digest
        || source.operation_digest !== runtime.operationDigest) fail('RELEASE_NOT_READY');
      await saveIntent('release'); await assertContained({ phase: state.phase, queueId: state.queueId });
      await transport.push(state.queueId, message(runtime, 'release', releaseAuthorization(runtime, source)));
      state.intent = null; await operation.save(state);
      return { code: 'EXISTING_ACCOUNTLESS_BOOTSTRAP_RELEASE_QUEUED', phase: state.phase };
    } else if (action === 'cleanup') {
      if (state.phase === 'released') { await saveIntent('cleanup-disable'); await transport.disableWorkerForCleanup(); await settle('worker-disabled'); }
      else if (state.phase === 'worker-disabled') { await saveIntent('detach-consumer'); await transport.detachConsumer(state.queueId); await settle('consumer-detached'); }
      else if (state.phase === 'consumer-detached') { await saveIntent('delete-worker'); await transport.deleteWorker(); await settle('worker-deleted'); }
      else if (state.phase === 'worker-deleted') { await saveIntent('delete-queue'); await transport.deleteQueue(state.queueId); await settle('complete');
        await assertContained({ phase: state.phase, queueId: state.queueId }); }
      else if (state.phase === 'complete') return { code: 'EXISTING_ACCOUNTLESS_BOOTSTRAP_COMPLETE', phase: state.phase };
      else fail('CLEANUP_NOT_READY');
    }
    return { code: 'EXISTING_ACCOUNTLESS_BOOTSTRAP_PROGRESS', phase: state.phase };
  } finally { operation.close(); }
}

export async function reconcileExistingAccountlessBootstrapOperator({ plan, operationDirectory, transport, assertContained }) {
  plan = validateExistingAccountlessBootstrapOperatorPlan(plan); const runtime = existingAccountlessBootstrapRuntimePlan(plan);
  const operation = await openOperation({ directory: operationDirectory, kind: 'qualification',
    binding: { schema: 1, planDigest: identityDigest(plan) }, resume: true });
  try {
    const state = stateValid(operation.record.state);
    if (await preparedPackageDigest(join(operation.directory, 'candidate')) !== state.packageDigest) fail('PACKAGE_CHANGED');
    if (!assertContained) fail('MAINTENANCE_PROOF_REQUIRED');
    if (state.intent === 'create-queue') { const queue = await transport.findQueue(); if (!queue) fail('RECONCILIATION_UNVERIFIED');
      await assertContained({ phase: 'queue-created', queueId: queue.queue_id });
      state.queueId = queue.queue_id; state.phase = 'queue-created'; state.intent = null; await operation.save(state); return { code: 'EXISTING_ACCOUNTLESS_BOOTSTRAP_RECONCILED', phase: state.phase }; }
    if (state.intent === 'deploy-disabled' || state.intent === 'deploy-enabled') { const mode = state.intent.slice(7);
      await transport.inspectWorker(mode); await assertContained({ phase: mode, queueId: state.queueId });
      state.phase = mode; state.intent = null; await operation.save(state); return { code: 'EXISTING_ACCOUNTLESS_BOOTSTRAP_RECONCILED', phase: state.phase }; }
    if (state.intent === 'cleanup-disable') { await transport.inspectWorkerForCleanup();
      await assertContained({ phase: 'worker-disabled', queueId: state.queueId });
      state.phase = 'worker-disabled'; state.intent = null; await operation.save(state); return { code: 'EXISTING_ACCOUNTLESS_BOOTSTRAP_RECONCILED', phase: state.phase }; }
    if (state.intent === 'detach-consumer') { await transport.inspectConsumerDetached(state.queueId);
      await assertContained({ phase: 'consumer-detached', queueId: state.queueId });
      state.phase = 'consumer-detached'; state.intent = null; await operation.save(state); return { code: 'EXISTING_ACCOUNTLESS_BOOTSTRAP_RECONCILED', phase: state.phase }; }
    if (state.intent === 'delete-worker') { if (await transport.findWorker()) fail('RECONCILIATION_UNVERIFIED');
      await assertContained({ phase: 'worker-deleted', queueId: state.queueId });
      state.phase = 'worker-deleted'; state.intent = null; await operation.save(state); return { code: 'EXISTING_ACCOUNTLESS_BOOTSTRAP_RECONCILED', phase: state.phase }; }
    if (state.intent === 'delete-queue') { if (await transport.findQueue()) fail('RECONCILIATION_UNVERIFIED');
      await assertContained({ phase: 'complete', queueId: state.queueId });
      state.phase = 'complete'; state.intent = null; await operation.save(state); return { code: 'EXISTING_ACCOUNTLESS_BOOTSTRAP_RECONCILED', phase: state.phase }; }
    const source = await transport.sourceStatus().catch(() => null), catalog = await transport.catalogStatus().catch(() => null);
    if (source?.operation_digest === runtime.operationDigest) {
      if (source.state === 'released') state.phase = 'released';
      else if (source.state === 'ready' && catalog?.state === 'ready' && source.manifest_digest === catalog.manifest_digest) state.phase = 'ready';
      else if (source.state === 'frozen') state.phase = catalog?.imported_count > 0 ? 'importing' : 'frozen';
      await assertContained({ phase: state.phase, queueId: state.queueId });
      state.manifestDigest = source.manifest_digest ?? catalog?.manifest_digest ?? state.manifestDigest;
      state.ownerRosterDigest = source.owner_roster_digest ?? catalog?.owner_roster_digest ?? state.ownerRosterDigest;
      state.importedCount = Number.isSafeInteger(catalog?.imported_count) ? Math.max(state.importedCount, catalog.imported_count) : state.importedCount;
      state.intent = null; await operation.save(state);
      return { code: 'EXISTING_ACCOUNTLESS_BOOTSTRAP_RECONCILED', phase: state.phase, importedCount: state.importedCount };
    }
    fail('RECONCILIATION_UNVERIFIED');
  } finally { operation.close(); }
}

export function parseExistingAccountlessBootstrapArguments(argv) {
  const values = {}, flags = new Set(), names = new Set(['--plan', '--operation', '--worker-root', '--repository-root',
    '--wrangler-cli', '--maintenance-plan', '--maintenance-operation', '--action', '--confirm', '--approved-plan-sha256']);
  for (let i = 0; i < argv.length; i++) { const key = argv[i]; if (!names.has(key) || flags.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('ARGUMENTS');
    flags.add(key); values[key.slice(2)] = argv[++i]; }
  for (const key of ['plan', 'operation', 'worker-root', 'repository-root', 'wrangler-cli', 'maintenance-plan',
    'maintenance-operation', 'approved-plan-sha256']) if (!values[key]) fail('ARGUMENTS');
  values.action ??= 'prepare'; return values;
}

async function cliMain() {
  const args = parseExistingAccountlessBootstrapArguments(process.argv.slice(2));
  const plan = JSON.parse((await readMaintenanceFile(args.plan, 65_536)).toString());
  const maintenancePlan = JSON.parse((await readMaintenanceFile(args['maintenance-plan'], 65_536)).toString());
  const packageDirectory = join(resolve(args.operation), 'candidate');
  const transport = createExistingAccountlessBootstrapTransport({ plan, packageDirectory, cliPath: args['wrangler-cli'],
    token: process.env.CLOUDFLARE_API_TOKEN });
  const assertContained = await createExistingAccountlessBootstrapContainment({ plan, maintenancePlan,
    maintenanceOperationDirectory: args['maintenance-operation'], repositoryRoot: args['repository-root'],
    maintenancePackageDirectory: join(resolve(args['maintenance-operation']), 'candidate'), bootstrapPackageDirectory: packageDirectory,
    cliPath: args['wrangler-cli'] });
  const options = { plan, workerRoot: args['worker-root'], operationDirectory: args.operation, action: args.action,
    confirmation: args.confirm ?? null, approvedPlanSha256: args['approved-plan-sha256'], transport, assertContained };
  const result = args.action === 'reconcile'
    ? await reconcileExistingAccountlessBootstrapOperator({ plan, operationDirectory: args.operation, transport, assertContained })
    : await runExistingAccountlessBootstrapOperator(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await cliMain(); } catch (error) { process.stderr.write(`${/^D1_STORAGE_EXISTING_BOOTSTRAP_[A-Z_]+$/.test(error?.code ?? '')
    ? error.code : 'D1_STORAGE_EXISTING_BOOTSTRAP_FAILED'}\n`); process.exitCode = 1; }
}
