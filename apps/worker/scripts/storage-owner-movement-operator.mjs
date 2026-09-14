import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { identityDigest, openOperation, operationError } from '../../../scripts/lib/release-operation.mjs';
import { createMaintenanceTransport } from './production-maintenance-transport.mjs';
import { createMaintenanceProvider } from './production-maintenance-provider.mjs';
import { createProductionDeploymentLock } from './production-deployment-lock.mjs';
import { readMaintenanceFile, validateMaintenancePlan, validateMaintenanceState } from './production-maintenance.mjs';
import { matchesExactBootstrapQueueConsumer } from './cloudflare-queue-consumer.mjs';
import { captureStorageShardReadinessHostedProvenance } from './storage-shard-readiness-hosted-provider.mjs';
import { validateStorageOwnerMovementRuntimePlan } from './storage-owner-movement-runtime.mjs';

const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const QID = /^[a-f0-9]{32}$/;
const BINDING = /^STORAGE_INGESTION_[ABC]$/;
const fail = code => { throw operationError(`D1_STORAGE_OWNER_MOVEMENT_${code}`); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...keys].sort().join();
const hash = value => createHash('sha256').update(value).digest('hex');
const CONFIRM = Object.freeze({ apply: 'ADVANCE_ACCOUNTLESS_V11_OWNER_PRECOPY',
  finalize: 'FENCE_AND_SWITCH_ACCOUNTLESS_V11_OWNER', abort: 'ABORT_ACCOUNTLESS_V11_OWNER_PRECOPY',
  cleanup: 'CLEAN_UP_OWNER_MOVEMENT_OPERATOR' });
const STATUS_STATES = new Set(['absent', 'copying', 'ready', 'fencing', 'finalizing', 'verified',
  'committed', 'abandoning', 'abandoned']);

export function validateStorageOwnerMovementOperatorPlan(value) {
  if (!exact(value, ['schema', 'toolingCommit', 'sourceTree', 'workerLockSha256', 'dependencyDigest',
    'runtimeBundleSha256', 'accountId', 'workerName', 'queueName', 'moveId',
    'ownerId', 'ownerDigest', 'sourceRoute', 'destinationShardId', 'sourceNamespace', 'catalogDatabase',
    'sourceDatabase', 'destinationDatabase', 'sourceReadinessDigest', 'destinationReadinessDigest',
    'destinationReservationBytes', 'newOwnerCutoffBytes', 'operatingBudgetBytes', 'expiresAt',
    'wranglerSha256', 'qualification', 'maintenance', 'limits'])
    || value.schema !== 'storage-owner-movement-operator-v1' || !COMMIT.test(value.toolingCommit)
    || !COMMIT.test(value.sourceTree) || !SHA.test(value.workerLockSha256)
    || !SHA.test(value.dependencyDigest) || !SHA.test(value.runtimeBundleSha256)
    || !/^[a-f0-9]{32}$/.test(value.accountId) || !/^[a-z][a-z0-9-]{2,62}$/.test(value.workerName)
    || !/^[a-z][a-z0-9-]{2,62}$/.test(value.queueName) || value.workerName === value.queueName
    || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value.moveId)
    || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value.ownerId) || !SHA.test(value.ownerDigest)
    || value.ownerDigest !== hash(`app-usagemonitor/storage-owner-movement-owner/v1\0${value.ownerId}`)
    || !exact(value.sourceRoute, ['ownerId', 'shardId', 'bindingName', 'generation', 'mode'])
    || value.sourceRoute.ownerId !== value.ownerId || value.sourceRoute.mode !== 'catalog'
    || !BINDING.test(value.sourceRoute.bindingName) || !Number.isSafeInteger(value.sourceRoute.generation)
    || value.sourceRoute.generation < 1 || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value.sourceRoute.shardId)
    || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value.destinationShardId)
    || value.destinationShardId === value.sourceRoute.shardId
    || typeof value.sourceNamespace !== 'string' || value.sourceNamespace.length < 1 || value.sourceNamespace.length > 256
    || !database(value.catalogDatabase, 'STORAGE_ROUTING_DB')
    || !database(value.sourceDatabase, value.sourceRoute.bindingName)
    || !database(value.destinationDatabase) || !BINDING.test(value.destinationDatabase.bindingName)
    || value.destinationDatabase.bindingName === value.sourceRoute.bindingName
    || new Set([value.catalogDatabase.id, value.sourceDatabase.id, value.destinationDatabase.id]).size !== 3
    || new Set([value.catalogDatabase.name, value.sourceDatabase.name, value.destinationDatabase.name]).size !== 3
    || !SHA.test(value.sourceReadinessDigest) || !SHA.test(value.destinationReadinessDigest)
    || value.sourceReadinessDigest === value.destinationReadinessDigest
    || !Number.isSafeInteger(value.destinationReservationBytes) || value.destinationReservationBytes < 1
    || value.destinationReservationBytes > 268_435_456 || value.newOwnerCutoffBytes !== 6_000_000_000
    || value.operatingBudgetBytes !== 9_000_000_000 || !Number.isSafeInteger(value.expiresAt)
    || !SHA.test(value.wranglerSha256)
    || !exact(value.qualification, ['receiptPath', 'receiptSha256'])
    || typeof value.qualification.receiptPath !== 'string' || !SHA.test(value.qualification.receiptSha256)
    || !exact(value.maintenance, ['planDigest', 'operationId', 'versionId', 'owner'])
    || !SHA.test(value.maintenance.planDigest) || !UUID.test(value.maintenance.operationId)
    || !UUID.test(value.maintenance.versionId) || !COMMIT.test(value.maintenance.owner)
    || !exact(value.limits, ['pageSize', 'maxDeliveries', 'deadlineMs', 'maxOperationMs', 'pauseTargetMs'])
    || !Number.isSafeInteger(value.limits.pageSize) || value.limits.pageSize < 1 || value.limits.pageSize > 100
    || !Number.isSafeInteger(value.limits.maxDeliveries) || value.limits.maxDeliveries < 1
    || value.limits.maxDeliveries > 10_000 || !Number.isSafeInteger(value.limits.deadlineMs)
    || value.limits.deadlineMs < 1_000 || value.limits.deadlineMs > 60_000
    || !Number.isSafeInteger(value.limits.maxOperationMs) || value.limits.maxOperationMs < value.limits.deadlineMs
    || value.limits.maxOperationMs > 86_400_000 || value.limits.pauseTargetMs !== 60_000) fail('PLAN_INVALID');
  return structuredClone(value);
}

function database(value, expectedBinding = null) {
  return exact(value, ['id', 'name', 'bindingName']) && UUID.test(value.id)
    && /^[a-z][a-z0-9-]{2,95}$/.test(value.name)
    && (BINDING.test(value.bindingName) || value.bindingName === 'STORAGE_ROUTING_DB')
    && (expectedBinding === null || value.bindingName === expectedBinding);
}

export function storageOwnerMovementRuntimePlan(rawPlan) {
  const plan = validateStorageOwnerMovementOperatorPlan(rawPlan);
  return validateStorageOwnerMovementRuntimePlan({ schema: 'storage-owner-movement-runtime-v1',
    operationDigest: identityDigest(plan), moveId: plan.moveId, ownerDigest: plan.ownerDigest,
    sourceRoute: plan.sourceRoute, destinationShardId: plan.destinationShardId,
    sourceNamespace: plan.sourceNamespace, catalogBinding: plan.catalogDatabase.bindingName,
    sourceBinding: plan.sourceDatabase.bindingName, destinationBinding: plan.destinationDatabase.bindingName,
    pageSize: plan.limits.pageSize, expiresAt: plan.expiresAt });
}

export function storageOwnerMovementConfig(rawPlan, mode, bundleSha256 = '0'.repeat(64)) {
  const plan = validateStorageOwnerMovementOperatorPlan(rawPlan), runtime = storageOwnerMovementRuntimePlan(plan);
  if (!['disabled', 'enabled'].includes(mode) || !SHA.test(bundleSha256)) fail('CONFIG_INVALID');
  const config = { name: plan.workerName, account_id: plan.accountId, main: 'movement-worker.mjs',
    compatibility_date: '2026-07-26', compatibility_flags: ['nodejs_compat'], workers_dev: false,
    preview_urls: false, routes: [], triggers: { crons: [] }, observability: { enabled: false },
    vars: { STORAGE_OWNER_MOVEMENT_MODE: mode, STORAGE_OWNER_MOVEMENT_OPERATION_DIGEST: runtime.operationDigest,
      STORAGE_OWNER_MOVEMENT_BUNDLE_SHA256: bundleSha256 },
    d1_databases: [plan.catalogDatabase, plan.sourceDatabase, plan.destinationDatabase]
      .map(item => ({ binding: item.bindingName, database_name: item.name, database_id: item.id })) };
  if (mode === 'enabled') config.queues = { consumers: [{ queue: plan.queueName, max_batch_size: 1,
    max_batch_timeout: 1, max_concurrency: 1, max_retries: 0 }] };
  return config;
}

async function privateDirectory(directory, create = false) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || await realpath(directory) !== resolve(directory) || (info.mode & 0o077)
    || process.getuid && info.uid !== process.getuid()) fail('DIRECTORY_UNSAFE');
}

async function writeExclusive(path, bytes) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

async function requireQualification(plan) {
  const path = resolve(plan.qualification.receiptPath), info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || info.size > 1024 * 1024
    || await realpath(path) !== path) fail('QUALIFICATION_CHANGED');
  const bytes = await readFile(path);
  if (hash(bytes) !== plan.qualification.receiptSha256) fail('QUALIFICATION_CHANGED');
  let receipt; try { receipt = JSON.parse(bytes); } catch { fail('QUALIFICATION_CHANGED'); }
  if (receipt?.schema !== 'owner-movement-local-qualification-completion-v1'
    || receipt.sourceCommit !== plan.toolingCommit || receipt.sourceTreeSha256 !== plan.sourceTree || receipt.sourceClean !== true
    || receipt.priorOwningGate?.exitCode !== 0
    || !Number.isSafeInteger(receipt.priorOwningGate?.testFiles) || receipt.priorOwningGate.testFiles < 130
    || !Number.isSafeInteger(receipt.priorOwningGate?.tests) || receipt.priorOwningGate.tests < 1557
    || receipt.allFourWorkerDryBuildsPassed !== true
    || !Array.isArray(receipt.completionChecks) || receipt.completionChecks.some(row => row.exitCode !== 0))
    fail('QUALIFICATION_CHANGED');
}

async function requireMovementProvenance(plan, workerRoot) {
  const provenance = await captureStorageShardReadinessHostedProvenance({
    workerRoot, sourceCommit: plan.toolingCommit,
  });
  if (provenance.dependencyDigest !== plan.dependencyDigest
    || provenance.runtimeBundleSha256 !== plan.runtimeBundleSha256) fail('PROVENANCE_CHANGED');
  return provenance;
}

export async function prepareStorageOwnerMovementPackage({ workerRoot, directory, plan: rawPlan, checkSource = null,
  checkProvenance = requireMovementProvenance }) {
  const plan = validateStorageOwnerMovementOperatorPlan(rawPlan), runtime = storageOwnerMovementRuntimePlan(plan);
  workerRoot = resolve(workerRoot); directory = resolve(directory);
  if (checkSource) await checkSource(workerRoot, plan.toolingCommit);
  else {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workerRoot, encoding: 'utf8' });
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: workerRoot, encoding: 'utf8' });
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: workerRoot, encoding: 'utf8' });
    if (head.status !== 0 || tree.status !== 0 || status.status !== 0 || head.stdout.trim() !== plan.toolingCommit
      || tree.stdout.trim() !== plan.sourceTree || status.stdout.trim())
      fail('SOURCE_CHANGED');
  }
  if (hash(await readFile(join(workerRoot, 'package-lock.json'))) !== plan.workerLockSha256) fail('DEPENDENCIES_CHANGED');
  await requireQualification(plan); await checkProvenance(plan, workerRoot); await privateDirectory(directory, true);
  const require = createRequire(join(workerRoot, 'package.json')), { build } = require('esbuild');
  const source = `import {createAccountlessV11OwnerMovement} from './src/storage-owner-movement.ts';\n`
    + `import {createStorageOwnerMovementWorker} from './scripts/storage-owner-movement-runtime.mjs';\n`
    + `export default createStorageOwnerMovementWorker({createMovement:createAccountlessV11OwnerMovement,plan:${JSON.stringify(runtime)}});`;
  const built = await build({ stdin: { contents: source, resolveDir: workerRoot,
    sourcefile: 'storage-owner-movement-entry.ts', loader: 'ts' }, bundle: true, platform: 'browser',
    target: 'es2022', format: 'esm', write: false, logLevel: 'silent' });
  if (built.outputFiles.length !== 1) fail('BUNDLE_INVALID');
  const bundle = built.outputFiles[0].contents, bundleSha256 = hash(bundle);
  const disabled = `${JSON.stringify(storageOwnerMovementConfig(plan, 'disabled', bundleSha256), null, 2)}\n`;
  const enabled = `${JSON.stringify(storageOwnerMovementConfig(plan, 'enabled', bundleSha256), null, 2)}\n`;
  const preparation = { schema: 'storage-owner-movement-package-v1', planDigest: identityDigest(plan),
    runtimePlanDigest: identityDigest(runtime), bundleSha256, disabledConfigSha256: hash(disabled),
    enabledConfigSha256: hash(enabled), remoteOperations: false, httpIngress: 'none', cronIngress: 'none',
    queueBatchSize: 1, queueMaxConcurrency: 1, queueMaxRetries: 0 };
  for (const [name, bytes] of Object.entries({ 'movement-worker.mjs': bundle,
    'wrangler.disabled.jsonc': disabled, 'wrangler.enabled.jsonc': enabled,
    'plan.json': `${JSON.stringify(plan)}\n`, 'preparation.json': `${JSON.stringify(preparation)}\n` }))
    await writeExclusive(join(directory, name), bytes);
  return preparation;
}

const PACKAGE_FILES = ['movement-worker.mjs', 'wrangler.disabled.jsonc', 'wrangler.enabled.jsonc',
  'plan.json', 'preparation.json'];
async function packageDigest(directory) {
  await privateDirectory(directory);
  return identityDigest({ schema: 1, files: await Promise.all(PACKAGE_FILES.map(async name =>
    ({ name, sha256: hash(await readFile(join(directory, name))) }))) });
}

function list(value, key, maximum) {
  const rows = Array.isArray(value) ? value : value?.[key];
  if (!Array.isArray(rows) || rows.length > maximum) fail('INVENTORY_UNBOUNDED');
  return rows;
}

export function createStorageOwnerMovementTransport({ plan: rawPlan, packageDirectory, operationDirectory,
  cliPath, fetcher = fetch, spawn = spawnSync, environment = process.env }) {
  const plan = validateStorageOwnerMovementOperatorPlan(rawPlan), runtime = storageOwnerMovementRuntimePlan(plan);
  packageDirectory = resolve(packageDirectory); operationDirectory = resolve(operationDirectory);
  const boundedFetcher = (url, options = {}) => fetcher(url, { ...options,
    signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(plan.limits.deadlineMs)]) });
  const maintenanceSpawn = (command, args, options) => spawn(command, args, { ...options,
    timeout: Math.min(options.timeout ?? plan.limits.deadlineMs, plan.limits.deadlineMs),
    env: { ...options.env, WRANGLER_LOG_PATH: join(operationDirectory, 'wrangler.log') } });
  const base = createMaintenanceTransport({ plan, operationDirectory, cliPath, fetcher: boundedFetcher,
    spawn: maintenanceSpawn, environment });
  const account = `/accounts/${plan.accountId}`;
  const query = async (databaseId, sql, params = []) => {
    const result = await base.api(`${account}/d1/database/${databaseId}/query`, { sql, params });
    if (!Array.isArray(result) || result.length !== 1 || result[0]?.success !== true
      || !Array.isArray(result[0].results) || result[0].results.length > 2) fail('READBACK_INVALID');
    return result[0].results;
  };
  const queues = async () => list(await base.api(`${account}/queues?page=1&per_page=100`), 'queues', 100);
  const workers = async () => list(await base.api(`${account}/workers/scripts?per_page=100`), 'scripts', 100);
  const findQueue = async () => { const matches = (await queues()).filter(row => row.queue_name === plan.queueName);
    if (matches.length > 1 || matches[0] && !QID.test(matches[0].queue_id ?? '')) fail('QUEUE_IDENTITY_CHANGED');
    return matches[0] ?? null; };
  const findWorker = async () => { const matches = (await workers()).filter(row => row.id === plan.workerName);
    if (matches.length > 1) fail('WORKER_IDENTITY_CHANGED'); return matches[0] ?? null; };
  const queue = async queueId => { if (!QID.test(queueId ?? '')) fail('QUEUE_IDENTITY_CHANGED');
    const value = await base.api(`${account}/queues/${queueId}`);
    if (value?.queue_id !== queueId || value?.queue_name !== plan.queueName) fail('QUEUE_IDENTITY_CHANGED'); return value; };
  const consumers = async queueId => list(await base.api(`${account}/queues/${queueId}/consumers`), 'consumers', 2);
  const exactConsumer = async (queueId, optional = false) => { const rows = await consumers(queueId);
    if (rows.length > 1 || !rows.length && !optional) fail('QUEUE_CONSUMER_CHANGED');
    if (!rows.length) return null;
    if (!matchesExactBootstrapQueueConsumer(rows[0], { workerName: plan.workerName,
      queueName: plan.queueName, queueId })) fail('QUEUE_CONSUMER_CHANGED'); return rows[0]; };
  const deleteConsumer = async (queueId, consumerId) => {
    if (!QID.test(queueId ?? '') || !QID.test(consumerId ?? '')) fail('QUEUE_CONSUMER_CHANGED');
    const token = environment.CLOUDFLARE_API_TOKEN;
    if (typeof token !== 'string' || token.length < 16) fail('CREDENTIAL_REQUIRED');
    const path = `${account}/queues/${queueId}/consumers/${consumerId}`;
    let response, bytes;
    try {
      response = await boundedFetcher(`https://api.cloudflare.com/client/v4${path}`, {
        method: 'DELETE', headers: { authorization: `Bearer ${token}` }, redirect: 'error',
      });
      const reader=response.body?.getReader(),parts=[];let size=0;
      if(!reader)fail('RESPONSE_INVALID');
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
        if(size>2_000_000)fail('RESPONSE_UNSAFE');parts.push(value);}
      bytes=Buffer.concat(parts);
    } catch { fail('MUTATION_UNCERTAIN'); }
    if (bytes.length > 2_000_000 || bytes.includes(Buffer.from(token))) fail('RESPONSE_UNSAFE');
    await base.receipt({ kind: 'movement-consumer-delete', pathDigest: hash(path), status: response.status,
      bytes: bytes.length, responseDigest: hash(bytes) });
    let envelope; try { envelope = JSON.parse(bytes); } catch { fail('RESPONSE_INVALID'); }
    if (!response.ok || envelope.success !== true) fail('MUTATION_REFUSED');
  };
  const configPath = mode => join(packageDirectory, `wrangler.${mode}.jsonc`);
  const runDeploy = async (mode, dry) => { const config = configPath(mode), digest = hash(await readFile(config));
    await base.run({ step: `${dry ? 'dry-' : ''}movement-${mode}`,
      args: ['deploy', ...(dry ? ['--dry-run', '--outdir', join(packageDirectory, `dry-${mode}`)]
        : ['--tag', `owner-movement-${mode}-${digest}`])], config, directory: packageDirectory, dry }); };
  const assertDatabase = async expected => { const value = await base.api(`${account}/d1/database/${expected.id}`);
    if (value?.uuid !== expected.id || value?.name !== expected.name) fail('DATABASE_IDENTITY_CHANGED'); };
  const assertAdmission = async () => {
    await Promise.all([assertDatabase(plan.catalogDatabase), assertDatabase(plan.sourceDatabase),
      assertDatabase(plan.destinationDatabase)]);
    const now = Date.now();
    const sourceRows = await query(plan.catalogDatabase.id, `SELECT count(*) AS n FROM storage_owner_routes route
      JOIN storage_shards shard ON shard.shard_id=route.shard_id
      JOIN storage_shard_allocation_policy policy ON policy.shard_id=shard.shard_id
      JOIN storage_shard_runtime_readiness readiness ON readiness.readiness_digest=policy.qualification_digest
      WHERE route.owner_id=? AND route.shard_id=? AND route.route_generation=? AND route.state='active'
       AND route.reservation_bytes=? AND shard.binding_name=? AND readiness.readiness_digest=? AND readiness.state='active'
       AND readiness.binding_name=shard.binding_name AND readiness.ingestion_database_id=?`,
      [plan.ownerId,plan.sourceRoute.shardId,plan.sourceRoute.generation,plan.destinationReservationBytes,plan.sourceDatabase.bindingName,
        plan.sourceReadinessDigest,plan.sourceDatabase.id]);
    const destinationRows = await query(plan.catalogDatabase.id, `SELECT count(*) AS n FROM storage_shards shard
      JOIN storage_shard_capacity_observations observation ON observation.shard_id=shard.shard_id
      JOIN storage_shard_allocation_policy policy ON policy.shard_id=shard.shard_id
      JOIN storage_shard_runtime_readiness readiness ON readiness.readiness_digest=policy.qualification_digest
      WHERE shard.shard_id=? AND shard.binding_name=? AND shard.state='active'
       AND readiness.readiness_digest=? AND readiness.state='active' AND readiness.ingestion_database_id=?
       AND policy.allocation_enabled=1 AND observation.pressure_state='normal'
       AND observation.observed_at<=? AND observation.valid_until>=? AND observation.observed_bytes<?
       AND observation.observed_bytes+shard.reserved_bytes+?<=?`,
      [plan.destinationShardId,plan.destinationDatabase.bindingName,plan.destinationReadinessDigest,
        plan.destinationDatabase.id,now,now,plan.newOwnerCutoffBytes,plan.destinationReservationBytes,
        plan.operatingBudgetBytes]);
    if (Number(sourceRows[0]?.n) !== 1 || Number(destinationRows[0]?.n) !== 1) fail('ADMISSION_CHANGED');
    return true;
  };
  const activeVersion = async () => {
    const deployments = list(await base.api(`${account}/workers/scripts/${plan.workerName}/deployments`), 'deployments', 100);
    const active = deployments[0];
    if (!active || !Array.isArray(active.versions) || active.versions.length !== 1
      || active.versions[0].percentage !== 100 || !UUID.test(active.versions[0].version_id ?? '')) fail('WORKER_CHANGED');
    return active.versions[0].version_id;
  };
  const verifyWorkerBundle = async expectedSha256 => {
    const token=environment.CLOUDFLARE_API_TOKEN;
    if(typeof token!=='string'||token.length<16)fail('CREDENTIAL_REQUIRED');
    const path=`${account}/workers/scripts/${plan.workerName}/content/v2`;let response,bytes;
    try{response=await boundedFetcher(`https://api.cloudflare.com/client/v4${path}`,{method:'GET',
      headers:{authorization:`Bearer ${token}`},redirect:'error'});
      const reader=response.body?.getReader(),parts=[];let size=0;
      if(!reader)fail('WORKER_CHANGED');while(true){const {done,value}=await reader.read();if(done)break;
        size+=value.byteLength;if(size>16*1024*1024)fail('WORKER_CHANGED');parts.push(value);}bytes=Buffer.concat(parts);
    }catch{fail('READ_UNCERTAIN');}
    await base.receipt({kind:'movement-worker-content',pathDigest:hash(path),status:response.status,
      bytes:bytes.length,responseDigest:hash(bytes)});
    const contentType=response.headers.get('content-type')??'',entrypoint=response.headers.get('cf-entrypoint')??'';
    if(!response.ok||!contentType.startsWith('multipart/')||entrypoint!=='movement-worker.mjs')fail('WORKER_CHANGED');
    let form;try{form=await new Response(bytes,{headers:{'content-type':contentType}}).formData();}catch{fail('WORKER_CHANGED');}
    const modules=[];for(const [name,value] of form.entries()){const moduleBytes=Buffer.from(typeof value==='string'
      ?value:await value.arrayBuffer());modules.push({name,sha256:hash(moduleBytes),bytes:moduleBytes.length});}
    if(modules.length!==1||modules[0].name!=='movement-worker.mjs'||modules[0].sha256!==expectedSha256)fail('WORKER_CHANGED');
  };
  const status = async () => {
    const [preparationRows, routeRows, moveRows, sourceFenceRows, destinationFenceRows, controlRows, stagedRows,
      authorityRows, historyRows] = await Promise.all([
      query(plan.catalogDatabase.id, `SELECT move_id,owner_id,source_shard_id,destination_shard_id,source_generation,
       destination_generation,reservation_bytes,source_namespace,state,precopy_after_source_row_id,precopy_high_water,
       final_high_water,materialized_after_source_row_id,verify_after_source_row_id,verify_chain_digest,
       authority_digest,copy_digest
       FROM storage_owner_move_preparations WHERE move_id=? LIMIT 2`, [plan.moveId]),
      query(plan.catalogDatabase.id, `SELECT route.shard_id,shard.binding_name,route.route_generation,route.state
       FROM storage_owner_routes route JOIN storage_shards shard ON shard.shard_id=route.shard_id
       WHERE route.owner_id=? LIMIT 2`, [plan.ownerId]),
      query(plan.catalogDatabase.id, `SELECT move_id,owner_id,source_shard_id,destination_shard_id,source_generation,
       destination_generation,reservation_bytes,state,copy_digest FROM storage_owner_moves WHERE move_id=? LIMIT 2`, [plan.moveId]),
      query(plan.sourceDatabase.id, `SELECT shard_id,route_generation,state,move_id,copy_digest FROM storage_owner_fences
       WHERE owner_id=? LIMIT 2`, [plan.ownerId]),
      query(plan.destinationDatabase.id, `SELECT shard_id,route_generation,state,move_id,copy_digest FROM storage_owner_fences
       WHERE owner_id=? LIMIT 2`, [plan.ownerId]),
      query(plan.destinationDatabase.id, 'SELECT state FROM storage_owner_move_copy_controls WHERE move_id=? LIMIT 2', [plan.moveId]),
      query(plan.destinationDatabase.id, `SELECT count(*) AS n,
       COALESCE(sum(CASE WHEN owner_id<>? OR source_namespace<>? THEN 1 ELSE 0 END),0) AS invalid,
       COALESCE(max(source_row_id),0) AS maximum FROM storage_owner_move_staged_records WHERE move_id=?`,
      [plan.ownerId, plan.sourceNamespace, plan.moveId]),
      query(plan.destinationDatabase.id, `SELECT owner_id,authority_digest,state
       FROM storage_owner_move_authority_seeds WHERE move_id=? LIMIT 2`, [plan.moveId]),
      query(plan.destinationDatabase.id, `SELECT owner_id,source_namespace,state,completed_digest
       FROM storage_owner_move_history_imports WHERE move_id=? LIMIT 2`, [plan.moveId]),
    ]);
    const preparation = preparationRows[0] ?? null, route = routeRows[0] ?? null, move = moveRows[0] ?? null;
    if (preparation && (preparation.move_id !== plan.moveId || preparation.owner_id !== plan.ownerId
      || preparation.source_shard_id !== plan.sourceRoute.shardId
      || preparation.destination_shard_id !== plan.destinationShardId
      || preparation.source_generation !== plan.sourceRoute.generation
      || preparation.destination_generation !== plan.sourceRoute.generation + 1
      || preparation.reservation_bytes !== plan.destinationReservationBytes
      || preparation.source_namespace !== plan.sourceNamespace)) fail('IDENTITY_CHANGED');
    if (route && (!['active', 'moving'].includes(route.state)
      || (preparation?.state === 'committed'
        ? route.shard_id !== plan.destinationShardId || route.route_generation !== plan.sourceRoute.generation + 1
          || route.state !== 'active'
        : route.shard_id !== plan.sourceRoute.shardId || route.route_generation !== plan.sourceRoute.generation)))
      fail('IDENTITY_CHANGED');
    const n = Number(stagedRows[0]?.n ?? 0), invalid = Number(stagedRows[0]?.invalid ?? 0),
      stagedMaximum = Number(stagedRows[0]?.maximum ?? 0);
    if (![n, invalid, stagedMaximum].every(Number.isSafeInteger) || n < 0 || invalid < 0 || stagedMaximum < 0)
      fail('READBACK_INVALID');
    return { state: preparation?.state ?? 'absent',
      destinationGeneration: preparation?.destination_generation ?? null,
      reservationBytes: preparation?.reservation_bytes ?? null,
      sourceNamespace: preparation?.source_namespace ?? null,
      precopyCursor: Number(preparation?.precopy_after_source_row_id ?? 0),
      precopyHighWater: Number(preparation?.precopy_high_water ?? 0),
      finalHighWater: preparation?.final_high_water == null ? null : Number(preparation.final_high_water),
      materializedCursor: Number(preparation?.materialized_after_source_row_id ?? 0),
      verifyCursor: Number(preparation?.verify_after_source_row_id ?? 0), verifyChainDigest: preparation?.verify_chain_digest ?? null,
      authorityDigest: preparation?.authority_digest ?? null,
      copyDigest: preparation?.copy_digest ?? null, route: route ? { shardId: route.shard_id,
        bindingName: route.binding_name, generation: route.route_generation } : null,
      sourceFence: sourceFenceRows[0] ? { shardId: sourceFenceRows[0].shard_id,
        generation: sourceFenceRows[0].route_generation, state: sourceFenceRows[0].state,
        moveId: sourceFenceRows[0].move_id, copyDigest: sourceFenceRows[0].copy_digest } : null,
      destinationFence: destinationFenceRows[0] ? { shardId: destinationFenceRows[0].shard_id,
        generation: destinationFenceRows[0].route_generation, state: destinationFenceRows[0].state,
        moveId: destinationFenceRows[0].move_id, copyDigest: destinationFenceRows[0].copy_digest } : null,
      move: move ? { moveId: move.move_id, ownerId: move.owner_id, sourceShardId: move.source_shard_id,
        destinationShardId: move.destination_shard_id, sourceGeneration: move.source_generation,
        destinationGeneration: move.destination_generation, reservationBytes: move.reservation_bytes,
        state: move.state, copyDigest: move.copy_digest } : null,
      authority: authorityRows[0] ? { ownerId: authorityRows[0].owner_id,
        authorityDigest: authorityRows[0].authority_digest, state: authorityRows[0].state } : null,
      history: historyRows[0] ? { ownerId: historyRows[0].owner_id,
        sourceNamespace: historyRows[0].source_namespace, state: historyRows[0].state,
        completedDigest: historyRows[0].completed_digest } : null,
      copyControl: controlRows[0]?.state ?? null, stagedCount: n, stagedInvalidCount: invalid, stagedMaximum };
  };
  return {
    findQueue, findWorker, status, assertAdmission,
    async createQueue() { if (await findQueue()) fail('QUEUE_ALREADY_EXISTS');
      await base.run({ step: 'movement-create-queue', args: ['queues', 'create', plan.queueName],
        config: configPath('disabled'), directory: packageDirectory });
      const value = await findQueue(); if (!value) fail('MUTATION_UNCERTAIN'); await queue(value.queue_id); return value.queue_id; },
    async deploy(mode, dry = false) { if (!['disabled', 'enabled'].includes(mode)) fail('CONFIG_INVALID');
      if (!dry) { await queue((await findQueue())?.queue_id); }
      await runDeploy(mode, dry); },
    async inspectWorker(mode, allowOwnedConsumer = false) { const preparation = JSON.parse(await readFile(join(packageDirectory, 'preparation.json'), 'utf8'));
      const versionId = await activeVersion();
      const version = await base.api(`${account}/workers/scripts/${plan.workerName}/versions/${versionId}`);
      const settings = await base.api(`${account}/workers/scripts/${plan.workerName}/settings`);
      const subdomain = await base.api(`${account}/workers/scripts/${plan.workerName}/subdomain`);
      const routes = list(await base.api(`${account}/workers/services/${plan.workerName}/environments/production/routes?show_zonename=true`), 'routes', 100);
      const schedules = list(await base.api(`${account}/workers/scripts/${plan.workerName}/schedules`), 'schedules', 16);
      const expected = storageOwnerMovementConfig(plan, mode, preparation.bundleSha256).d1_databases;
      const scriptRuntime = version.resources?.script_runtime;
      if (version?.id !== versionId || version.annotations?.['workers/tag']
          !== `owner-movement-${mode}-${hash(await readFile(configPath(mode)))}`
        || subdomain?.enabled !== false || subdomain?.previews_enabled !== false || routes.length || schedules.length
        || scriptRuntime?.compatibility_date !== '2026-07-26'
        || JSON.stringify([...(scriptRuntime?.compatibility_flags ?? [])].sort()) !== JSON.stringify(['nodejs_compat'])
        || !Array.isArray(settings?.bindings) || settings.bindings.length !== 6
        || !Array.isArray(version.resources?.bindings) || version.resources.bindings.length !== 6) fail('WORKER_CHANGED');
      for (const bindings of [settings.bindings, version.resources.bindings]) for (const item of expected)
        if (!bindings.some(row => { if (row.id !== undefined && row.database_id !== undefined
          && row.id !== row.database_id) fail('WORKER_CHANGED');
          return row.type === 'd1' && row.name === item.binding
            && (row.id ?? row.database_id) === item.database_id; })) fail('WORKER_CHANGED');
      for (const [name, text] of Object.entries({ STORAGE_OWNER_MOVEMENT_MODE: mode,
        STORAGE_OWNER_MOVEMENT_OPERATION_DIGEST: runtime.operationDigest,
        STORAGE_OWNER_MOVEMENT_BUNDLE_SHA256: preparation.bundleSha256 }))
        for (const bindings of [settings.bindings, version.resources.bindings])
          if (!bindings.some(row => row.type === 'plain_text' && row.name === name && row.text === text)) fail('WORKER_CHANGED');
      const ownedQueue=await findQueue();
      if (mode === 'enabled') await exactConsumer(ownedQueue?.queue_id);
      else if (ownedQueue && allowOwnedConsumer) await exactConsumer(ownedQueue.queue_id, true);
      else if (ownedQueue && (await consumers(ownedQueue.queue_id)).length) fail('QUEUE_CONSUMER_CHANGED');
      await verifyWorkerBundle(preparation.bundleSha256);
      if(await activeVersion()!==versionId)fail('WORKER_CHANGED');
      return versionId; },
    async push(queueId, body) { await queue(queueId); return base.api(`${account}/queues/${queueId}/messages`,
      { body, content_type: 'json' }, { mutation: true }); },
    async disable() { await runDeploy('disabled', false); await this.inspectWorker('disabled', true); },
    async inspectDetached(queueId) { await queue(queueId); if (await exactConsumer(queueId, true)) fail('QUEUE_CONSUMER_CHANGED'); return true; },
    async detach(queueId) { await queue(queueId); const consumer = await exactConsumer(queueId, true);
      if (!consumer) return true; await deleteConsumer(queueId, consumer.consumer_id);
      return this.inspectDetached(queueId); },
    async deleteWorker() { await this.inspectWorker('disabled');
      await base.run({ step: 'movement-delete-worker', args: ['delete', plan.workerName],
        config: configPath('disabled'), directory: packageDirectory });
      if (await findWorker()) fail('DELETE_UNCERTAIN'); },
    async deleteQueue(queueId) { await queue(queueId); if ((await consumers(queueId)).length) fail('QUEUE_CONSUMER_CHANGED');
      await base.run({ step: 'movement-delete-queue', args: ['queues', 'delete', plan.queueName],
        config: configPath('disabled'), directory: packageDirectory });
      if ((await queues()).some(row => row.queue_id === queueId || row.queue_name === plan.queueName)) fail('DELETE_UNCERTAIN'); },
  };
}

export async function createStorageOwnerMovementContainment({ plan: rawPlan, maintenancePlan,
  maintenanceOperationDirectory, repositoryRoot, maintenancePackageDirectory, movementPackageDirectory,
  cliPath, fetcher = fetch, spawn = spawnSync, environment = process.env }) {
  const plan = validateStorageOwnerMovementOperatorPlan(rawPlan);
  if (identityDigest(validateMaintenancePlan(maintenancePlan)) !== plan.maintenance.planDigest) fail('MAINTENANCE_CHANGED');
  const record = await (await import('../../../scripts/lib/release-operation.mjs')).readOperation(maintenanceOperationDirectory);
  const retained = validateMaintenanceState(record.state);
  if (record.id !== plan.maintenance.operationId || retained.owner !== plan.maintenance.owner
    || retained.uploadedVersion !== plan.maintenance.versionId || retained.phase !== 'contained'
    || retained.intent !== null || retained.lock !== 'held') fail('MAINTENANCE_NOT_CONTAINED');
  createProductionDeploymentLock({ repositoryRoot }).assertOwned(retained.owner);
  return async context => {
    const latest = await (await import('../../../scripts/lib/release-operation.mjs')).readOperation(maintenanceOperationDirectory);
    const state = validateMaintenanceState(latest.state);
    if (latest.id !== record.id || state.owner !== retained.owner || state.uploadedVersion !== retained.uploadedVersion
      || state.phase !== 'contained' || state.intent !== null || state.lock !== 'held') fail('MAINTENANCE_NOT_CONTAINED');
    createProductionDeploymentLock({ repositoryRoot }).assertOwned(state.owner);
    const preparation = JSON.parse(await readFile(join(movementPackageDirectory, 'preparation.json'), 'utf8'));
    if (preparation.planDigest !== identityDigest(plan)
      || preparation.bundleSha256 !== hash(await readFile(join(movementPackageDirectory, 'movement-worker.mjs')))
      || preparation.disabledConfigSha256 !== hash(await readFile(join(movementPackageDirectory, 'wrangler.disabled.jsonc')))
      || preparation.enabledConfigSha256 !== hash(await readFile(join(movementPackageDirectory, 'wrangler.enabled.jsonc')))) fail('PACKAGE_CHANGED');
    const phase = context?.phase, queueId = context?.queueId;
    const isolationPhase = ['prepared', 'complete'].includes(phase) ? null : ['queue-created', 'worker-deleted'].includes(phase) ? 'queue-only'
      : phase === 'worker-disabled' ? 'disabled-before-detach'
        : ['disabled', 'consumer-detached'].includes(phase) ? 'disabled'
          : ['enabled', 'movement'].includes(phase) ? 'enabled' : null;
    if (!['prepared', 'complete'].includes(phase) && (isolationPhase === null || !QID.test(queueId ?? ''))) fail('JOURNAL_INVALID');
    const provider = await createMaintenanceProvider({ plan: maintenancePlan,
      packageDirectory: maintenancePackageDirectory, operationDirectory: maintenanceOperationDirectory,
      operationId: record.id, cliPath, fetcher, spawn, environment,
      isolatedMovement: isolationPhase === null ? null : { schema: 'storage-owner-movement-isolation-v1', phase: isolationPhase,
        operationDigest: identityDigest(plan), workerName: plan.workerName, queueName: plan.queueName, queueId,
        catalogDatabaseId: plan.catalogDatabase.id, sourceDatabaseId: plan.sourceDatabase.id,
        destinationDatabaseId: plan.destinationDatabase.id, sourceBinding: plan.sourceDatabase.bindingName,
        destinationBinding: plan.destinationDatabase.bindingName, bundleSha256: preparation.bundleSha256,
        disabledConfigSha256: preparation.disabledConfigSha256,
        enabledConfigSha256: preparation.enabledConfigSha256, workerVersionId: context.workerVersionId ?? null } });
    await provider.verifyContained(state.uploadedVersion);
  };
}

function stateValid(value) {
  if (!exact(value, ['schema', 'phase', 'intent', 'queueId', 'deliveries', 'packageDigest', 'workerMode', 'workerVersionId',
    'lastStatusDigest', 'lastMoveState', 'pause']) || value.schema !== 1
    || !['prepared', 'queue-created', 'disabled', 'enabled', 'movement', 'worker-disabled',
      'consumer-detached', 'worker-deleted', 'complete'].includes(value.phase)
    || !(value.intent === null || exact(value.intent,
      ['kind', 'action', 'sequence', 'beforeDigest', 'beforeState', 'createdAt', 'containment']))
    || value.intent && (!['resource', 'movement'].includes(value.intent.kind)
      || typeof value.intent.action !== 'string' || !Number.isSafeInteger(value.intent.sequence)
      || !SHA.test(value.intent.beforeDigest) || !STATUS_STATES.has(value.intent.beforeState)
      || !Number.isSafeInteger(value.intent.createdAt)
      || !(value.intent.kind === 'resource' && value.intent.containment === null
        || value.intent.kind === 'movement' && ['enabled', 'disable-pending', 'disabled',
          'detach-pending', 'detached'].includes(value.intent.containment)))
    || !(value.queueId === null || QID.test(value.queueId)) || !Number.isSafeInteger(value.deliveries)
    || value.deliveries < 0 || !SHA.test(value.packageDigest) || !['absent', 'disabled', 'enabled', 'deleted'].includes(value.workerMode)
    || !(value.workerVersionId === null || UUID.test(value.workerVersionId))
    || !(value.lastStatusDigest === null || SHA.test(value.lastStatusDigest))
    || !STATUS_STATES.has(value.lastMoveState)
    || !(value.pause === null || exact(value.pause, ['startedAt', 'startedMonotonicMs', 'endedAt',
      'endedMonotonicMs', 'elapsedMs', 'targetMs', 'passed',
      'startDelivery', 'endDelivery', 'precopyHighWater', 'finalHighWater', 'catchUpRows'])
      && Number.isSafeInteger(value.pause.startedAt) && Number.isSafeInteger(value.pause.startedMonotonicMs)
      && (value.pause.endedAt === null || Number.isSafeInteger(value.pause.endedAt))
      && (value.pause.endedMonotonicMs === null || Number.isSafeInteger(value.pause.endedMonotonicMs))
      && (value.pause.elapsedMs === null || Number.isSafeInteger(value.pause.elapsedMs))
      && value.pause.targetMs === 60_000 && Number.isSafeInteger(value.pause.startDelivery)
      && (value.pause.endDelivery===null||Number.isSafeInteger(value.pause.endDelivery))
      && Number.isSafeInteger(value.pause.precopyHighWater)
      && (value.pause.finalHighWater===null||Number.isSafeInteger(value.pause.finalHighWater))
      && (value.pause.catchUpRows===null||Number.isSafeInteger(value.pause.catchUpRows))
      && (value.pause.passed === null || typeof value.pause.passed === 'boolean')))
    fail('JOURNAL_INVALID');
  return value;
}

function statusDigest(status) { return identityDigest(status); }
function actionFor(action, status) {
  if (action === 'apply') {
    if (status.state === 'absent') return 'prepare';
    if (status.state === 'copying') return 'copy';
    if (status.state === 'ready') return null;
    fail('FINALIZE_CONFIRMATION_REQUIRED');
  }
  if (action === 'finalize') {
    if (status.state === 'ready' || status.state === 'fencing') return 'fence';
    if (['finalizing', 'verified'].includes(status.state)) return 'resume';
    if (status.state === 'committed') return null;
    fail('FINALIZE_NOT_READY');
  }
  if (action === 'abort') {
    if (['copying', 'ready', 'abandoning'].includes(status.state)) return 'abort';
    if (status.state === 'abandoned') return null;
    fail('ABORT_NOT_ALLOWED');
  }
  fail('ACTION_INVALID');
}

function provesEffect(intent, status) {
  const after = statusDigest(status);
  if (after === intent.beforeDigest) return false;
  if (intent.action === 'prepare') return status.state !== 'absent';
  if (intent.action === 'copy') return ['copying', 'ready'].includes(status.state);
  if (intent.action === 'fence') return ['fencing', 'finalizing', 'verified', 'committed'].includes(status.state);
  if (intent.action === 'resume') return ['finalizing', 'verified', 'committed'].includes(status.state);
  if (intent.action === 'abort') return ['abandoning', 'abandoned'].includes(status.state);
  return false;
}

function requireTerminalStatus(plan, status) {
  const source = { shardId: plan.sourceRoute.shardId, generation: plan.sourceRoute.generation,
    state: 'fenced', moveId: plan.moveId, copyDigest: null };
  if (status.destinationGeneration !== plan.sourceRoute.generation + 1
    || status.reservationBytes !== plan.destinationReservationBytes
    || status.sourceNamespace !== plan.sourceNamespace || status.stagedInvalidCount !== 0) fail('TERMINAL_UNVERIFIED');
  if (status.state === 'committed') {
    if (!Number.isSafeInteger(status.finalHighWater) || status.finalHighWater < status.precopyHighWater
      || status.materializedCursor !== status.finalHighWater || status.verifyCursor !== status.finalHighWater
      || status.stagedMaximum > status.finalHighWater
      || ![status.verifyChainDigest, status.authorityDigest, status.copyDigest,
        status.history?.completedDigest].every(value => SHA.test(value ?? ''))
      || JSON.stringify(status.route) !== JSON.stringify({ shardId: plan.destinationShardId,
        bindingName: plan.destinationDatabase.bindingName, generation: plan.sourceRoute.generation + 1 })
      || JSON.stringify(status.sourceFence) !== JSON.stringify(source)
      || JSON.stringify(status.destinationFence) !== JSON.stringify({ shardId: plan.destinationShardId,
        generation: plan.sourceRoute.generation + 1, state: 'active', moveId: plan.moveId,
        copyDigest: status.copyDigest })
      || JSON.stringify(status.move) !== JSON.stringify({ moveId: plan.moveId, ownerId: plan.ownerId,
        sourceShardId: plan.sourceRoute.shardId, destinationShardId: plan.destinationShardId,
        sourceGeneration: plan.sourceRoute.generation, destinationGeneration: plan.sourceRoute.generation + 1,
        reservationBytes: plan.destinationReservationBytes, state: 'committed', copyDigest: status.copyDigest })
      || JSON.stringify(status.authority) !== JSON.stringify({ ownerId: plan.ownerId,
        authorityDigest: status.authorityDigest, state: 'materialized' })
      || JSON.stringify(status.history) !== JSON.stringify({ ownerId: plan.ownerId,
        sourceNamespace: plan.sourceNamespace, state: 'complete', completedDigest: status.history.completedDigest })
      || status.copyControl !== 'closed') fail('TERMINAL_UNVERIFIED');
    return status;
  }
  if (status.state === 'abandoned') {
    if (status.finalHighWater !== null || status.verifyChainDigest !== null || status.authorityDigest !== null
      || status.copyDigest !== null || status.materializedCursor !== 0 || status.verifyCursor !== 0
      || status.stagedCount !== 0 || status.stagedMaximum !== 0 || status.move !== null
      || status.destinationFence !== null || status.authority !== null || status.history !== null
      || ![null, 'closed'].includes(status.copyControl)
      || JSON.stringify(status.route) !== JSON.stringify({ shardId: plan.sourceRoute.shardId,
        bindingName: plan.sourceDatabase.bindingName, generation: plan.sourceRoute.generation })
      || JSON.stringify(status.sourceFence) !== JSON.stringify({ ...source, state: 'active', moveId: null }))
      fail('TERMINAL_UNVERIFIED');
    return status;
  }
  fail('TERMINAL_UNVERIFIED');
}

async function settleStatus(operation, state, status, plan, clock, monotonicClock) {
  if (['committed', 'abandoned'].includes(status.state)) requireTerminalStatus(plan, status);
  state.lastStatusDigest = statusDigest(status); state.lastMoveState = status.state;
  if (status.state === 'committed' && state.pause?.endedAt === null) {
    const endedAt = clock(), endedMonotonicMs = monotonicClock();
    if (!Number.isSafeInteger(endedMonotonicMs) || endedMonotonicMs < state.pause.startedMonotonicMs)
      fail('MONOTONIC_CLOCK_CHANGED');
    const elapsedMs = endedMonotonicMs - state.pause.startedMonotonicMs;
    const finalHighWater=status.finalHighWater??state.pause.precopyHighWater;
    state.pause = { ...state.pause, endedAt, endedMonotonicMs, elapsedMs, passed: elapsedMs < state.pause.targetMs,
      endDelivery:state.deliveries,finalHighWater,
      catchUpRows:Math.max(0,finalHighWater-state.pause.precopyHighWater) };
  }
  state.phase = 'movement'; state.intent = null; await operation.save(state);
}

export async function runStorageOwnerMovementOperator({ plan: rawPlan, workerRoot, operationDirectory,
  action = 'prepare', confirmation = null, approvedPlanSha256 = null, transport = null,
  assertContained = null, prepare = prepareStorageOwnerMovementPackage, checkProvenance = requireMovementProvenance,
  clock = Date.now, monotonicClock = () => Number(process.hrtime.bigint() / 1_000_000n) }) {
  const plan = validateStorageOwnerMovementOperatorPlan(rawPlan), planDigest = identityDigest(plan);
  if (!['prepare', 'dry-run', 'apply', 'finalize', 'abort', 'reconcile', 'cleanup'].includes(action)
    || approvedPlanSha256 !== planDigest) fail('APPROVAL_INVALID');
  if (CONFIRM[action] && confirmation !== CONFIRM[action]) fail('CONFIRMATION_REQUIRED');
  const operation = await openOperation({ directory: operationDirectory, kind: 'qualification',
    binding: { schema: 1, planDigest }, resume: action !== 'prepare' });
  try {
    let state;
    if (action === 'prepare') {
      const candidate = join(operation.directory, 'candidate');
      await prepare({ workerRoot, directory: candidate, plan });
      state = { schema: 1, phase: 'prepared', intent: null, queueId: null, deliveries: 0,
        packageDigest: await packageDigest(candidate), workerMode: 'absent', workerVersionId: null, lastStatusDigest: null,
        lastMoveState: 'absent', pause: null };
      await operation.save(state); return { code: 'OWNER_MOVEMENT_PREPARED', phase: state.phase };
    }
    state = stateValid(operation.record.state);
    if (await packageDigest(join(operation.directory, 'candidate')) !== state.packageDigest) fail('PACKAGE_CHANGED');
    await checkProvenance(plan, resolve(workerRoot));
    if (clock() >= plan.expiresAt && !['reconcile', 'cleanup'].includes(action)) fail('WINDOW_CLOSED');
    if (clock() > Date.parse(operation.record.createdAt) + plan.limits.maxOperationMs
      && !['reconcile', 'cleanup'].includes(action)) fail('OPERATION_DEADLINE_EXCEEDED');
    if (action === 'dry-run') {
      if (state.phase !== 'prepared' || !transport) fail('DRY_RUN_NOT_READY');
      await transport.deploy('disabled', true); await transport.deploy('enabled', true);
      return { code: 'OWNER_MOVEMENT_DRY_RUN_COMPLETE', phase: state.phase };
    }
    if (action === 'cleanup' && state.phase === 'complete') {
      if (!transport || !assertContained) fail('CONTAINMENT_PROVIDER_REQUIRED');
      requireTerminalStatus(plan, await transport.status());
      await assertContained({ phase: 'complete', queueId: state.queueId, workerMode: state.workerMode,
        workerVersionId: state.workerVersionId, packageDigest: state.packageDigest });
      return { code: 'OWNER_MOVEMENT_COMPLETE', phase: state.phase };
    }
    if (!transport || !assertContained) fail('CONTAINMENT_PROVIDER_REQUIRED');
    const contain = () => assertContained({ phase: state.intent?.kind === 'movement'
      && ['disable-pending', 'disabled'].includes(state.intent.containment) ? 'worker-disabled'
      : state.intent?.kind === 'movement' && ['detach-pending', 'detached'].includes(state.intent.containment)
        ? 'consumer-detached' : state.phase, queueId: state.queueId,
      workerMode: state.workerMode, workerVersionId: state.workerVersionId, packageDigest: state.packageDigest });
    if (action === 'reconcile') {
      if (!state.intent) { const status = await transport.status(); await settleStatus(operation, state, status, plan, clock, monotonicClock);
        return { code: 'OWNER_MOVEMENT_RECONCILED', phase: state.phase, moveState: status.state }; }
      if (state.intent.kind === 'movement') {
        const status = await transport.status();
        if (provesEffect(state.intent, status)) { await settleStatus(operation, state, status, plan, clock, monotonicClock);
          return { code: 'OWNER_MOVEMENT_RECONCILED', phase: state.phase, moveState: status.state }; }
        if (state.intent.containment === 'enabled') {
          await contain();
          state.intent.containment = 'disable-pending'; await operation.save(state);
          try { await transport.disable(); } catch { fail('RECONCILIATION_REQUIRED'); }
          state.workerMode = 'disabled'; state.workerVersionId = await transport.inspectWorker('disabled', true);
          state.intent.containment = 'disabled'; await operation.save(state);
          return { code: 'OWNER_MOVEMENT_CONTAINMENT_PROGRESS', phase: state.phase, moveState: status.state };
        }
        if (state.intent.containment === 'disable-pending') {
          state.workerMode = 'disabled'; state.workerVersionId = await transport.inspectWorker('disabled', true);
          state.intent.containment = 'disabled'; await operation.save(state);
          return { code: 'OWNER_MOVEMENT_CONTAINMENT_PROGRESS', phase: state.phase, moveState: status.state };
        }
        if (state.intent.containment === 'disabled') {
          await contain();
          state.intent.containment = 'detach-pending'; await operation.save(state);
          try { await transport.detach(state.queueId); } catch { fail('RECONCILIATION_REQUIRED'); }
          state.intent.containment = 'detached'; await operation.save(state);
          fail('RECONCILIATION_REQUIRED');
        }
        if (state.intent.containment === 'detach-pending') {
          await transport.inspectDetached(state.queueId); state.intent.containment = 'detached'; await operation.save(state);
        }
        fail('RECONCILIATION_REQUIRED');
      }
      if (state.intent.action === 'create-queue') { const queue = await transport.findQueue();
        if (!queue) fail('RESOURCE_RECONCILIATION_REQUIRED'); state.queueId = queue.queue_id;
        state.phase = 'queue-created'; state.intent = null; await operation.save(state); }
      else if (state.intent.action === 'deploy-disabled') {
        state.workerMode = 'disabled'; state.workerVersionId = await transport.inspectWorker('disabled');
        state.phase = 'disabled'; state.intent = null; await operation.save(state); }
      else if (state.intent.action === 'deploy-enabled') {
        state.workerVersionId = await transport.inspectWorker('enabled');
        state.workerMode = 'enabled'; state.phase = 'enabled'; state.intent = null; await operation.save(state); }
      else if (state.intent.action === 'disable') {
        state.workerMode = 'disabled'; state.workerVersionId = await transport.inspectWorker('disabled', true);
        state.phase = 'worker-disabled'; state.intent = null; await operation.save(state); }
      else if (state.intent.action === 'detach') { await transport.inspectDetached(state.queueId);
        state.phase = 'consumer-detached'; state.intent = null; await operation.save(state); }
      else if (state.intent.action === 'delete-worker') { if (await transport.findWorker()) fail('RESOURCE_RECONCILIATION_REQUIRED');
        state.workerMode = 'deleted'; state.workerVersionId = null; state.phase = 'worker-deleted'; state.intent = null; await operation.save(state); }
      else if (state.intent.action === 'delete-queue') { if (await transport.findQueue()) fail('RESOURCE_RECONCILIATION_REQUIRED');
        state.phase = 'complete'; state.intent = null; await operation.save(state); }
      else fail('RESOURCE_RECONCILIATION_REQUIRED');
      return { code: 'OWNER_MOVEMENT_RECONCILED', phase: state.phase, moveState: state.lastMoveState };
    }
    if (state.intent) fail('RECONCILIATION_REQUIRED');
    if (action === 'cleanup') {
      const status = requireTerminalStatus(plan, await transport.status());
      await contain();
      const resourceIntent = async resourceAction => { state.intent = { kind: 'resource', action: resourceAction,
        sequence: state.deliveries, beforeDigest: state.lastStatusDigest ?? '0'.repeat(64),
        beforeState: state.lastMoveState, createdAt: clock(), containment: null }; await operation.save(state); };
      if (state.workerMode === 'enabled') { await resourceIntent('disable'); try { await transport.disable(); }
        catch { fail('RECONCILIATION_REQUIRED'); } state.workerMode = 'disabled'; state.workerVersionId = await transport.inspectWorker('disabled', true);
        state.phase = 'worker-disabled'; state.intent = null; await operation.save(state); }
      else if (state.phase === 'worker-disabled') { await resourceIntent('detach'); try { await transport.detach(state.queueId); }
        catch { fail('RECONCILIATION_REQUIRED'); } state.phase = 'consumer-detached'; state.intent = null; await operation.save(state); }
      else if (state.phase === 'consumer-detached') { await resourceIntent('delete-worker'); try { await transport.deleteWorker(); }
        catch { fail('RECONCILIATION_REQUIRED'); } state.workerMode = 'deleted'; state.workerVersionId = null;
        state.phase = 'worker-deleted'; state.intent = null; await operation.save(state); }
      else if (state.phase === 'worker-deleted') { await resourceIntent('delete-queue'); try { await transport.deleteQueue(state.queueId); }
        catch { fail('RECONCILIATION_REQUIRED'); } state.phase = 'complete'; state.intent = null; await operation.save(state);
        await contain(); }
      else if (state.phase === 'complete') return { code: 'OWNER_MOVEMENT_COMPLETE', phase: state.phase };
      else fail('CLEANUP_NOT_READY');
      return { code: 'OWNER_MOVEMENT_CLEANUP_PROGRESS', phase: state.phase };
    }
    if (state.phase === 'prepared') { await contain(); await transport.assertAdmission(); state.intent = { kind: 'resource', action: 'create-queue',
      sequence: state.deliveries, beforeDigest: '0'.repeat(64), beforeState: state.lastMoveState, createdAt: clock(), containment: null };
      await operation.save(state); try { state.queueId = await transport.createQueue(); } catch { fail('RECONCILIATION_REQUIRED'); }
      state.phase = 'queue-created'; state.intent = null; await operation.save(state); return { code: 'OWNER_MOVEMENT_PROGRESS', phase: state.phase }; }
    if (state.phase === 'queue-created') { await contain(); await transport.assertAdmission();
      state.intent = { kind: 'resource', action: 'deploy-disabled', sequence: state.deliveries,
        beforeDigest: state.lastStatusDigest ?? '0'.repeat(64), beforeState: state.lastMoveState, createdAt: clock(), containment: null };
      await operation.save(state); try { await transport.deploy('disabled', false); } catch { fail('RECONCILIATION_REQUIRED'); }
      state.workerMode = 'disabled'; state.workerVersionId = await transport.inspectWorker('disabled');
      state.phase = 'disabled'; state.intent = null; await operation.save(state);
      return { code: 'OWNER_MOVEMENT_PROGRESS', phase: state.phase };
    }
    if (state.workerMode === 'disabled') { await contain(); await transport.assertAdmission();
      state.intent = { kind: 'resource', action: 'deploy-enabled', sequence: state.deliveries,
        beforeDigest: state.lastStatusDigest ?? '0'.repeat(64), beforeState: state.lastMoveState, createdAt: clock(), containment: null };
      await operation.save(state); try { await transport.deploy('enabled', false); } catch { fail('RECONCILIATION_REQUIRED'); }
      state.workerMode = 'enabled'; state.workerVersionId = await transport.inspectWorker('enabled');
      state.phase = 'enabled'; state.intent = null; await operation.save(state);
      return { code: 'OWNER_MOVEMENT_PROGRESS', phase: state.phase }; }
    const status = await transport.status(), primitive = actionFor(action, status);
    if (!primitive) { await settleStatus(operation, state, status, plan, clock, monotonicClock);
      return { code: status.state === 'ready' ? 'OWNER_MOVEMENT_READY' : `OWNER_MOVEMENT_${status.state.toUpperCase()}`,
        phase: state.phase, moveState: status.state, pause: state.pause }; }
    if (state.deliveries >= plan.limits.maxDeliveries) fail('DELIVERY_BUDGET_EXHAUSTED');
    await contain(); if (['absent', 'copying', 'ready'].includes(status.state)) await transport.assertAdmission();
    const sequence = state.deliveries + 1;
    if (primitive === 'fence' && state.pause === null) state.pause = { startedAt: clock(),
      startedMonotonicMs: monotonicClock(), endedAt: null, endedMonotonicMs: null,
      elapsedMs: null, targetMs: plan.limits.pauseTargetMs, passed: null,startDelivery:sequence,
      endDelivery:null,precopyHighWater:status.precopyHighWater,finalHighWater:null,catchUpRows:null };
    state.intent = { kind: 'movement', action: primitive, sequence, beforeDigest: statusDigest(status),
      beforeState: status.state, createdAt: clock(), containment: 'enabled' }; state.deliveries = sequence; await operation.save(state);
    try { await transport.push(state.queueId, { schema: 'storage-owner-movement-wakeup-v1',
      operationDigest: storageOwnerMovementRuntimePlan(plan).operationDigest, action: primitive, sequence }); }
    catch { fail('RECONCILIATION_REQUIRED'); }
    const after = await transport.status();
    if (!provesEffect(state.intent, after)) fail('RECONCILIATION_REQUIRED');
    await settleStatus(operation, state, after, plan, clock, monotonicClock);
    return { code: 'OWNER_MOVEMENT_PROGRESS', phase: state.phase, moveState: after.state, pause: state.pause };
  } finally { operation.close(); }
}

export function parseStorageOwnerMovementArguments(argv) {
  const names = new Set(['--plan', '--operation', '--worker-root', '--repository-root', '--wrangler-cli',
    '--maintenance-plan', '--maintenance-operation', '--action', '--confirm', '--approved-plan-sha256']);
  const values = {}, seen = new Set();
  for (let index = 0; index < argv.length; index++) { const key = argv[index];
    if (!names.has(key) || seen.has(key) || !argv[index + 1] || argv[index + 1].startsWith('--')) fail('ARGUMENTS');
    seen.add(key); values[key.slice(2)] = argv[++index]; }
  for (const key of ['plan', 'operation', 'worker-root', 'repository-root', 'wrangler-cli',
    'maintenance-plan', 'maintenance-operation', 'approved-plan-sha256']) if (!values[key]) fail('ARGUMENTS');
  values.action ??= 'prepare'; return values;
}

async function cliMain() {
  const args = parseStorageOwnerMovementArguments(process.argv.slice(2));
  const plan = JSON.parse((await readMaintenanceFile(resolve(args.plan), 65_536)).toString());
  const maintenancePlan = JSON.parse((await readMaintenanceFile(resolve(args['maintenance-plan']), 65_536)).toString());
  const packageDirectory = join(resolve(args.operation), 'candidate');
  const transport = args.action === 'prepare' ? null : createStorageOwnerMovementTransport({ plan,
    packageDirectory, operationDirectory: resolve(args.operation), cliPath: args['wrangler-cli'] });
  const assertContained = args.action === 'prepare' || args.action === 'dry-run' ? null
    : await createStorageOwnerMovementContainment({ plan, maintenancePlan,
      maintenanceOperationDirectory: args['maintenance-operation'], repositoryRoot: args['repository-root'],
      maintenancePackageDirectory: join(resolve(args['maintenance-operation']), 'candidate'),
      movementPackageDirectory: packageDirectory, cliPath: args['wrangler-cli'] });
  const result = await runStorageOwnerMovementOperator({ plan, workerRoot: args['worker-root'],
    operationDirectory: args.operation, action: args.action, confirmation: args.confirm ?? null,
    approvedPlanSha256: args['approved-plan-sha256'], transport, assertContained });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await cliMain(); } catch (error) {
    process.stderr.write(`${/^D1_STORAGE_OWNER_MOVEMENT_[A-Z_]+$/.test(error?.code ?? '')
      ? error.code : 'D1_STORAGE_OWNER_MOVEMENT_FAILED'}\n`); process.exitCode = 1;
  }
}
