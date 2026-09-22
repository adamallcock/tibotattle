import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { identityDigest, openOperation, operationError } from '../../../scripts/lib/release-operation.mjs';
import { createProductionDeploymentLock } from './production-deployment-lock.mjs';
import { storageSchemaDigest, storageSha256 } from './d1-storage-plan.mjs';
import { createWranglerQueryInvocation } from './wrangler-query-launcher.mjs';
import queryValidation from './wrangler-query-preload.cjs';
import fileValidation from './d1-storage-file-preload.cjs';
import { storageWranglerEnvironment } from './d1-storage-wrangler.mjs';

export const TYPED_FORWARD_SCHEMA = 'typed-forward-migration-plan-v1';
export const TYPED_FORWARD_REHEARSAL_SCHEMA = 'typed-forward-migration-rehearsal-v1';
export const TYPED_FORWARD_OPERATION_SCHEMA = 'typed-forward-migration-operation-v1';
export const TYPED_FORWARD_CONFIRMATION = 'EXECUTE_REVIEWED_TYPED_FORWARD_MIGRATION';
export const TYPED_FORWARD_PREVIOUS_SOURCE = 'c93a5a513890be5d4db97de5bcc9a684cbb91f18';
export const TYPED_FORWARD_OPERATING_CAP_BYTES = 9_000_000_000;
export const TYPED_FORWARD_MAX_WINDOW_MS = 86_400_000;

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const NAME = /^[a-z][a-z0-9-]{2,95}$/u;
const SQL_NAME = /^\d{4}_[a-z0-9_-]+\.sql$/u;
const fail = suffix => { throw operationError(`TYPED_FORWARD_${suffix}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const normalized = value => value instanceof Uint8Array ? Array.from(value) : value;
const normalizeRows = rows => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalized(value)])));

export const TYPED_FORWARD_ROLE_BINDINGS = Object.freeze({
  primary: 'USAGE_MONITOR_DB',
  analytics: 'ANALYTICS_DB',
});

// These are closed source pins. A plan is refused if a local SQL file differs,
// even when the file still has the expected migration name.
export const TYPED_FORWARD_MIGRATIONS = Object.freeze([
  Object.freeze({ role: 'primary', binding: 'USAGE_MONITOR_DB', directory: 'ingestion-isolation-migrations', name: '0006_usage_correction_facts.sql', sha256: 'cbcac1caef1e854686752d0d025967b4a74102d1297253f31b2ac2ecb42f6d2d' }),
  Object.freeze({ role: 'primary', binding: 'USAGE_MONITOR_DB', directory: 'ingestion-isolation-migrations', name: '0007_usage_correction_admission.sql', sha256: '3893f350f4c76481a1a0fcc88fd8b5516ec8239fb100f21942c35105263f19ba' }),
  Object.freeze({ role: 'primary', binding: 'USAGE_MONITOR_DB', directory: 'ingestion-isolation-migrations', name: '0008_telemetry_v12.sql', sha256: 'd5802b4a1d228c8b4388b5effe67cbf4e61605628eec00d54f0d1669c988c9e1' }),
  Object.freeze({ role: 'primary', binding: 'USAGE_MONITOR_DB', directory: 'ingestion-isolation-migrations', name: '0009_performance_reports.sql', sha256: 'cfd43797151ea3d5a6740da9792be49bf897968094347cd6fbbb9a0cf6510825' }),
  Object.freeze({ role: 'analytics', binding: 'ANALYTICS_DB', directory: 'analytics-migrations', name: '0024_effective_owner_daily_cursor.sql', sha256: 'f4eef3495ae3e5f1088ddea695607471dcbc2ea871291274ce50ef1295a05e68' }),
  Object.freeze({ role: 'analytics', binding: 'ANALYTICS_DB', directory: 'analytics-migrations', name: '0025_effective_graph_source.sql', sha256: 'a99ba82106e53ac2eda3ac9078784e22774ba0fc099265a66dacc5b1765fe84b' }),
  Object.freeze({ role: 'analytics', binding: 'ANALYTICS_DB', directory: 'analytics-migrations', name: '0026_cache_retention_effective_layout.sql', sha256: 'bac1838613b292b97bfee5022f6b43b6f52c9bc225d6d26f918cdcd7e454a2a1' }),
]);

const PRIOR_DIRECTORIES = Object.freeze([
  'migrations', 'typed-ingestion-migrations', 'ingestion-bridge-migrations',
  'typed-v11-admission-migrations', 'typed-v1-admission-migrations', 'ingestion-isolation-migrations',
]);
const REHEARSAL_PREFIX = Object.freeze({
  primary: Object.freeze({ name: '0001_prior_primary.sql', sql: 'typed-forward-rehearsal-primary' }),
  analytics: Object.freeze({ name: '0001_prior_analytics.sql', sql: 'typed-forward-rehearsal-analytics' }),
});

// These aggregate queries are deliberately fixed. They retain no payloads and
// let the remote path prove that a migration preserved the populated role's
// row counts and key ranges without exposing rows to the operator.
export const TYPED_FORWARD_DATA_INVARIANT_SQL = Object.freeze({
  primary: `SELECT 'participants' AS table_name,COUNT(*) AS row_count,COALESCE(MIN(id),'') AS first_key,COALESCE(MAX(id),'') AS last_key,COALESCE(SUM(length(CAST(id AS TEXT))),0) AS key_bytes FROM participants
UNION ALL SELECT 'telemetry_records',COUNT(*),COALESCE(MIN(id),0),COALESCE(MAX(id),0),COALESCE(SUM(length(CAST(id AS TEXT))),0) FROM telemetry_records
UNION ALL SELECT 'telemetry_v1_records',COUNT(*),COALESCE(MIN(id),0),COALESCE(MAX(id),0),COALESCE(SUM(length(CAST(id AS TEXT))),0) FROM telemetry_v1_records
UNION ALL SELECT 'telemetry_v11_records',COUNT(*),COALESCE(MIN(occurrence_id),''),COALESCE(MAX(occurrence_id),''),COALESCE(SUM(length(CAST(occurrence_id AS TEXT))),0) FROM telemetry_v11_records`,
  // The three tables below are rebuilt by 0024, 0025 and 0026.  A row count
  // and primary-key range are insufficient evidence for a copy: two rows can
  // retain the same key while a carried value changes.  The per-column
  // aggregates retain no payload, but bind every carried column to a stable
  // count/min/max/byte-total summary.  The JSON object is deliberately
  // constructed in a fixed key order so the digest is portable across SQLite
  // providers and the local rehearsal.
  analytics: `SELECT 'analytics_runtime_sources' AS table_name,COUNT(*) AS row_count,COALESCE(MIN(source_id),'') AS first_key,COALESCE(MAX(source_id),'') AS last_key,COALESCE(SUM(length(CAST(source_id AS TEXT))),0) AS key_bytes FROM analytics_runtime_sources
UNION ALL SELECT 'analytics_community_daily_owners',COUNT(*),COALESCE(MIN(source_id),''),COALESCE(MAX(source_id),''),json_object(
 'source_id',json_object('min',COALESCE(MIN(source_id),''),'max',COALESCE(MAX(source_id),''),'bytes',COALESCE(SUM(length(CAST(source_id AS TEXT))),0)),
 'day',json_object('min',COALESCE(MIN(day),''),'max',COALESCE(MAX(day),''),'bytes',COALESCE(SUM(length(CAST(day AS TEXT))),0)),
 'owner_digest',json_object('min',COALESCE(MIN(owner_digest),''),'max',COALESCE(MAX(owner_digest),''),'bytes',COALESCE(SUM(length(CAST(owner_digest AS TEXT))),0)),
 'input_revision',json_object('min',COALESCE(MIN(input_revision),0),'max',COALESCE(MAX(input_revision),0),'sum',COALESCE(SUM(input_revision),0)),
 'owner_revision',json_object('min',COALESCE(MIN(owner_revision),0),'max',COALESCE(MAX(owner_revision),0),'sum',COALESCE(SUM(owner_revision),0)),
 'source_format',json_object('min',COALESCE(MIN(source_format),''),'max',COALESCE(MAX(source_format),''),'bytes',COALESCE(SUM(length(CAST(source_format AS TEXT))),0)),
 'method',json_object('min',COALESCE(MIN(method),''),'max',COALESCE(MAX(method),''),'bytes',COALESCE(SUM(length(CAST(method AS TEXT))),0)),
 'progress_revision',json_object('min',COALESCE(MIN(progress_revision),0),'max',COALESCE(MAX(progress_revision),0),'sum',COALESCE(SUM(progress_revision),0)),
 'next_index',json_object('min',COALESCE(MIN(next_index),0),'max',COALESCE(MAX(next_index),0),'sum',COALESCE(SUM(next_index),0)),
 'fingerprint',json_object('min',COALESCE(MIN(fingerprint),''),'max',COALESCE(MAX(fingerprint),''),'bytes',COALESCE(SUM(length(CAST(fingerprint AS TEXT))),0)),
 'complete',json_object('min',COALESCE(MIN(complete),0),'max',COALESCE(MAX(complete),0),'sum',COALESCE(SUM(complete),0)),
 'values_json',json_object('min',COALESCE(MIN(values_json),''),'max',COALESCE(MAX(values_json),''),'bytes',COALESCE(SUM(length(CAST(values_json AS TEXT))),0))
) FROM analytics_community_daily_owners
UNION ALL SELECT 'analytics_community_graph_results',COUNT(*),COALESCE(MIN(owner_digest),''),COALESCE(MAX(owner_digest),''),json_object(
 'source_id',json_object('min',COALESCE(MIN(source_id),''),'max',COALESCE(MAX(source_id),''),'bytes',COALESCE(SUM(length(CAST(source_id AS TEXT))),0)),
 'owner_digest',json_object('min',COALESCE(MIN(owner_digest),''),'max',COALESCE(MAX(owner_digest),''),'bytes',COALESCE(SUM(length(CAST(owner_digest AS TEXT))),0)),
 'metric',json_object('min',COALESCE(MIN(metric),''),'max',COALESCE(MAX(metric),''),'bytes',COALESCE(SUM(length(CAST(metric AS TEXT))),0)),
 'day',json_object('min',COALESCE(MIN(day),''),'max',COALESCE(MAX(day),''),'bytes',COALESCE(SUM(length(CAST(day AS TEXT))),0)),
 'method',json_object('min',COALESCE(MIN(method),''),'max',COALESCE(MAX(method),''),'bytes',COALESCE(SUM(length(CAST(method AS TEXT))),0)),
 'dependency_digest',json_object('min',COALESCE(MIN(dependency_digest),''),'max',COALESCE(MAX(dependency_digest),''),'bytes',COALESCE(SUM(length(CAST(dependency_digest AS TEXT))),0)),
 'input_revision',json_object('min',COALESCE(MIN(input_revision),0),'max',COALESCE(MAX(input_revision),0),'sum',COALESCE(SUM(input_revision),0)),
 'payload_fingerprint',json_object('min',COALESCE(MIN(payload_fingerprint),''),'max',COALESCE(MAX(payload_fingerprint),''),'bytes',COALESCE(SUM(length(CAST(payload_fingerprint AS TEXT))),0)),
 'payload_json',json_object('min',COALESCE(MIN(payload_json),''),'max',COALESCE(MAX(payload_json),''),'bytes',COALESCE(SUM(length(CAST(payload_json AS TEXT))),0)),
 'payload_sha256',json_object('min',COALESCE(MIN(payload_sha256),''),'max',COALESCE(MAX(payload_sha256),''),'bytes',COALESCE(SUM(length(CAST(payload_sha256 AS TEXT))),0)),
 'authority_json',json_object('min',COALESCE(MIN(authority_json),''),'max',COALESCE(MAX(authority_json),''),'bytes',COALESCE(SUM(length(CAST(authority_json AS TEXT))),0)),
 'computed_ms',json_object('min',COALESCE(MIN(computed_ms),0),'max',COALESCE(MAX(computed_ms),0),'sum',COALESCE(SUM(computed_ms),0)),
 'source_kind',json_object('min',COALESCE(MIN(source_kind),''),'max',COALESCE(MAX(source_kind),''),'bytes',COALESCE(SUM(length(CAST(source_kind AS TEXT))),0))
) FROM analytics_community_graph_results
UNION ALL SELECT 'analytics_cache_retention_day_marks',COUNT(*),COALESCE(MIN(owner_digest),''),COALESCE(MAX(owner_digest),''),json_object(
 'mark_key',json_object('min',COALESCE(MIN(mark_key),''),'max',COALESCE(MAX(mark_key),''),'bytes',COALESCE(SUM(length(CAST(mark_key AS TEXT))),0)),
 'source_id',json_object('min',COALESCE(MIN(source_id),''),'max',COALESCE(MAX(source_id),''),'bytes',COALESCE(SUM(length(CAST(source_id AS TEXT))),0)),
 'source_layout',json_object('min',COALESCE(MIN(source_layout),''),'max',COALESCE(MAX(source_layout),''),'bytes',COALESCE(SUM(length(CAST(source_layout AS TEXT))),0)),
 'source_namespace',json_object('min',COALESCE(MIN(source_namespace),''),'max',COALESCE(MAX(source_namespace),''),'bytes',COALESCE(SUM(length(CAST(source_namespace AS TEXT))),0)),
 'owner_digest',json_object('min',COALESCE(MIN(owner_digest),''),'max',COALESCE(MAX(owner_digest),''),'bytes',COALESCE(SUM(length(CAST(owner_digest AS TEXT))),0)),
 'device_id',json_object('min',COALESCE(MIN(device_id),''),'max',COALESCE(MAX(device_id),''),'bytes',COALESCE(SUM(length(CAST(device_id AS TEXT))),0)),
 'manifest_id',json_object('min',COALESCE(MIN(manifest_id),''),'max',COALESCE(MAX(manifest_id),''),'bytes',COALESCE(SUM(length(CAST(manifest_id AS TEXT))),0)),
 'manifest_digest',json_object('min',COALESCE(MIN(manifest_digest),''),'max',COALESCE(MAX(manifest_digest),''),'bytes',COALESCE(SUM(length(CAST(manifest_digest AS TEXT))),0)),
 'day',json_object('min',COALESCE(MIN(day),''),'max',COALESCE(MAX(day),''),'bytes',COALESCE(SUM(length(CAST(day AS TEXT))),0)),
 'method_version',json_object('min',COALESCE(MIN(method_version),''),'max',COALESCE(MAX(method_version),''),'bytes',COALESCE(SUM(length(CAST(method_version AS TEXT))),0)),
 'carry_digest',json_object('min',COALESCE(MIN(carry_digest),''),'max',COALESCE(MAX(carry_digest),''),'bytes',COALESCE(SUM(length(CAST(carry_digest AS TEXT))),0)),
 'carry_days',json_object('min',COALESCE(MIN(carry_days),0),'max',COALESCE(MAX(carry_days),0),'sum',COALESCE(SUM(carry_days),0)),
 'value_count',json_object('min',COALESCE(MIN(value_count),0),'max',COALESCE(MAX(value_count),0),'sum',COALESCE(SUM(value_count),0)),
 'events_read',json_object('min',COALESCE(MIN(events_read),0),'max',COALESCE(MAX(events_read),0),'sum',COALESCE(SUM(events_read),0)),
 'unreadable_events',json_object('min',COALESCE(MIN(unreadable_events),0),'max',COALESCE(MAX(unreadable_events),0),'sum',COALESCE(SUM(unreadable_events),0)),
 'values_digest',json_object('min',COALESCE(MIN(values_digest),''),'max',COALESCE(MAX(values_digest),''),'bytes',COALESCE(SUM(length(CAST(values_digest AS TEXT))),0)),
 'refusal',json_object('min',COALESCE(MIN(refusal),''),'max',COALESCE(MAX(refusal),''),'bytes',COALESCE(SUM(length(CAST(refusal AS TEXT))),0))
) FROM analytics_cache_retention_day_marks`,
});

const REQUIRED_COLUMNS = Object.freeze({
  'primary:0006_usage_correction_facts.sql': [['telemetry_usage_correction_runtime', ['state', 'max_capture_rows', 'max_history_page']]],
  'primary:0007_usage_correction_admission.sql': [['telemetry_v11_domain_complete_before_insert', null]],
  'primary:0008_telemetry_v12.sql': [['telemetry_v12_runtime', ['state', 'policy_revision']], ['telemetry_transport_device_floors', ['participant_id', 'device_id', 'minimum_rank']]],
  'primary:0009_performance_reports.sql': [['telemetry_performance_runtime', ['state', 'method_version']], ['telemetry_performance_reports', ['report_day', 'record_count', 'bucket_scheme_version']]],
  'analytics:0024_effective_owner_daily_cursor.sql': [['analytics_community_daily_owners', ['source_format', 'progress_revision', 'next_index']]],
  'analytics:0025_effective_graph_source.sql': [['analytics_community_graph_results', ['source_kind']]],
  'analytics:0026_cache_retention_effective_layout.sql': [['analytics_cache_retention_day_marks', ['source_layout']], ['analytics_cache_retention_day_progress', ['source_layout', 'state_json']]],
});

function validateCommit(value) { if (!COMMIT.test(value ?? '')) fail('PLAN_INVALID'); }
function parseLedger(ledger) {
  if (!Array.isArray(ledger) || ledger.length < 1 || ledger.length > 128) fail('PRIOR_RECEIPT_MISSING');
  const names = new Set();
  for (const row of ledger) {
    if (!exact(row, ['name', 'sha256']) || !SQL_NAME.test(row.name) || !SHA256.test(row.sha256) || names.has(row.name)) fail('PRIOR_RECEIPT_INVALID');
    names.add(row.name);
  }
  return ledger;
}

export function previousReceiptDigest(previous) {
  if (!object(previous) || !SHA256.test(previous.schemaSha256 ?? '') || !SHA256.test(previous.dataInvariantSha256 ?? '')) fail('PRIOR_RECEIPT_INVALID');
  return identityDigest({ schemaSha256: previous.schemaSha256, dataInvariantSha256: previous.dataInvariantSha256, ledger: previous.ledger });
}

function validateTarget(target, role, plan) {
  if (!exact(target, ['role', 'binding', 'name', 'databaseId', 'bytes', 'migrationGrowthBudgetBytes', 'previous'])
      || target.role !== role || target.binding !== TYPED_FORWARD_ROLE_BINDINGS[role]
      || !NAME.test(target.name ?? '') || !UUID.test(target.databaseId ?? '')
      || !Number.isSafeInteger(target.bytes) || target.bytes < 0
      || !Number.isSafeInteger(target.migrationGrowthBudgetBytes) || target.migrationGrowthBudgetBytes < 0
      || target.bytes + target.migrationGrowthBudgetBytes >= TYPED_FORWARD_OPERATING_CAP_BYTES) fail('TARGET_INVALID');
  const previous = target.previous;
  if (!exact(previous, ['capturedAt', 'schemaSha256', 'dataInvariantSha256', 'ledger', 'receiptSha256'])
      || !date(previous.capturedAt)) fail('PRIOR_RECEIPT_INVALID');
  parseLedger(previous.ledger);
  if (previousReceiptDigest(previous) !== previous.receiptSha256) fail('PRIOR_RECEIPT_INVALID');
  if (previous.ledger.some(row => TYPED_FORWARD_MIGRATIONS.some(step => step.name === row.name))) fail('PRIOR_RECEIPT_INVALID');
  return target;
}

function validateInventory(inventory, plan) {
  if (!exact(inventory, ['capturedAt', 'sourceCommit', 'versionId', 'fingerprint', 'targetsSha256'])
      || !date(inventory.capturedAt) || inventory.sourceCommit !== plan.previousSourceCommit
      || !UUID.test(inventory.versionId ?? '') || !SHA256.test(inventory.fingerprint ?? '') || !SHA256.test(inventory.targetsSha256 ?? '')) fail('INVENTORY_INVALID');
  const expected = plan.targets.map(target => ({ role: target.role, binding: target.binding, name: target.name, databaseId: target.databaseId, bytes: target.bytes }));
  if (identityDigest(expected) !== inventory.targetsSha256) fail('INVENTORY_INVALID');
}

export function validateTypedForwardPlan(plan, { now = Date.now(), allowExpired = false } = {}) {
  if (!exact(plan, ['schema', 'operationId', 'environment', 'accountId', 'workerName', 'previousSourceCommit', 'candidateSourceCommit',
    'createdAt', 'expiresAt', 'operatingCapBytes', 'wranglerSha256', 'rehearsalSha256', 'inventory', 'targets', 'steps'])
      || plan.schema !== TYPED_FORWARD_SCHEMA || !UUID.test(plan.operationId ?? '') || plan.environment !== 'production'
      || !/^[a-f0-9]{32}$/u.test(plan.accountId ?? '') || !/^[A-Za-z0-9_-]{1,63}$/u.test(plan.workerName ?? '')
      || plan.previousSourceCommit !== TYPED_FORWARD_PREVIOUS_SOURCE || !COMMIT.test(plan.candidateSourceCommit ?? '')
      || plan.candidateSourceCommit === plan.previousSourceCommit || !date(plan.createdAt) || !date(plan.expiresAt)
      || Date.parse(plan.createdAt) > now || (!allowExpired && Date.parse(plan.expiresAt) <= now)
      || Date.parse(plan.expiresAt) <= Date.parse(plan.createdAt)
      || Date.parse(plan.expiresAt) - Date.parse(plan.createdAt) > TYPED_FORWARD_MAX_WINDOW_MS
      || plan.operatingCapBytes !== TYPED_FORWARD_OPERATING_CAP_BYTES || !SHA256.test(plan.wranglerSha256 ?? '') || !SHA256.test(plan.rehearsalSha256 ?? '')) fail('PLAN_INVALID');
  validateInventory(plan.inventory, plan);
  if (!Array.isArray(plan.targets) || plan.targets.length !== 2
      || plan.targets[0]?.role !== 'primary' || plan.targets[1]?.role !== 'analytics') fail('TARGET_ORDER_INVALID');
  const seenBindings = new Set(), seenIds = new Set();
  for (const role of ['primary', 'analytics']) {
    const target = plan.targets.find(row => row.role === role);
    validateTarget(target, role, plan);
    if (seenBindings.has(target.binding) || seenIds.has(target.databaseId)) fail('TARGET_INVALID');
    seenBindings.add(target.binding); seenIds.add(target.databaseId);
  }
  if (!Array.isArray(plan.steps) || plan.steps.length !== TYPED_FORWARD_MIGRATIONS.length) fail('STEP_ORDER_INVALID');
  const previousByRole = Object.fromEntries(plan.targets.map(target => [target.role, target.previous]));
  let previousStep = null;
  for (const [index, step] of plan.steps.entries()) {
    const expected = TYPED_FORWARD_MIGRATIONS[index];
    if (!exact(step, ['role', 'binding', 'directory', 'name', 'sha256', 'beforeSchemaSha256', 'afterSchemaSha256'])
        || step.role !== expected.role || step.binding !== expected.binding || step.directory !== expected.directory
        || step.name !== expected.name || step.sha256 !== expected.sha256 || !SHA256.test(step.beforeSchemaSha256 ?? '')
        || !SHA256.test(step.afterSchemaSha256 ?? '') || step.beforeSchemaSha256 !== (previousStep?.afterSchemaSha256 ?? previousByRole[step.role].schemaSha256)) fail('STEP_ORDER_INVALID');
    previousStep = step;
    if (index === 3) previousStep = null;
  }
  return structuredClone(plan);
}

/**
 * A plan is tied to the exact clean checkout that produced its SQL pins.  The
 * callback used by older operators is deliberately additive: it may perform a
 * second policy check, but it cannot replace this check.
 */
export function assertCleanSource(repositoryRoot, candidateSourceCommit) {
  if (typeof repositoryRoot !== 'string' || !repositoryRoot || typeof candidateSourceCommit !== 'string') fail('SOURCE_CHECK_FAILED');
  const run = args => spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 128 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const top = run(['rev-parse', '--show-toplevel']);
  const head = run(['rev-parse', 'HEAD']);
  const dirty = run(['status', '--porcelain', '--untracked-files=all']);
  let expectedRoot;
  try { expectedRoot = realpathSync(repositoryRoot); } catch { fail('SOURCE_CHECK_FAILED'); }
  if (top.error || top.status !== 0 || head.error || head.status !== 0 || dirty.error || dirty.status !== 0
      || String(top.stdout ?? '').trim() !== expectedRoot
      || String(head.stdout ?? '').trim() !== candidateSourceCommit
      || String(dirty.stdout ?? '') !== '') fail('SOURCE_CHECK_FAILED');
  return true;
}

function validateRehearsalBinding(rehearsal, targets) {
  if (!exact(rehearsal, ['schema', 'status', 'remoteOperations', 'populatedSource', 'dataInvariantPreserved',
    'foreignKeyViolations', 'steps', 'targets', 'mappedColumns'])
      || rehearsal.schema !== TYPED_FORWARD_REHEARSAL_SCHEMA || rehearsal.status !== 'passed'
      || rehearsal.remoteOperations !== false || rehearsal.populatedSource !== true
      || rehearsal.dataInvariantPreserved !== true || rehearsal.foreignKeyViolations !== 0
      || !Array.isArray(rehearsal.steps) || !object(rehearsal.targets) || !Array.isArray(rehearsal.mappedColumns)) fail('REHEARSAL_REQUIRED');
  for (const role of ['primary', 'analytics']) {
    const target = targets.find(item => item.role === role);
    const evidence = rehearsal.targets[role];
    if (!target || !object(evidence) || evidence.schemaSha256 !== target.previous.schemaSha256
        || evidence.dataInvariantSha256 !== target.previous.dataInvariantSha256 || !Array.isArray(evidence.ledger)) fail('REHEARSAL_RECEIPT_MISMATCH');
    const expected = TYPED_FORWARD_MIGRATIONS.filter(step => step.role === role);
    const actual = rehearsal.steps.filter(step => step.role === role);
    if (actual.length !== expected.length) fail('REHEARSAL_REQUIRED');
    let before = target.previous.schemaSha256;
    for (const [index, step] of actual.entries()) {
      if (!exact(step, ['role', 'binding', 'directory', 'name', 'sha256', 'beforeSchemaSha256', 'afterSchemaSha256', 'dataInvariantSha256'])
          || step.role !== role || step.name !== expected[index].name || step.sha256 !== expected[index].sha256
          || step.beforeSchemaSha256 !== before || !SHA256.test(step.afterSchemaSha256 ?? '')
          || step.dataInvariantSha256 !== target.previous.dataInvariantSha256) fail('REHEARSAL_RECEIPT_MISMATCH');
      before = step.afterSchemaSha256;
    }
  }
}

async function safeSql(workerRoot, step) {
  const root = await realpath(resolve(workerRoot));
  const path = join(root, step.directory, step.name);
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 240 * 1024 || await realpath(path) !== path) fail('SOURCE_FILE_UNSAFE');
  const bytes = await readFile(path);
  if (bytes.length !== stat.size || storageSha256(bytes) !== step.sha256 || bytes.includes(0)) fail('SOURCE_CHANGED');
  return bytes.toString('utf8');
}

export async function prepareTypedForwardPlan({ workerRoot, accountId, workerName, candidateSourceCommit, inventory, targets,
  rehearsal, wranglerSha256, createdAt = new Date().toISOString(), expiresAt = new Date(Date.parse(createdAt) + 86_400_000).toISOString(),
  operationId = randomUUID(), previousSourceCommit = TYPED_FORWARD_PREVIOUS_SOURCE, repositoryRoot = resolve(workerRoot, '../..'), checkSource = null }) {
  if (typeof workerRoot !== 'string' || !Array.isArray(targets) || targets.length !== 2 || !object(rehearsal)) fail('PLAN_INPUT_INVALID');
  validateCommit(candidateSourceCommit); if (previousSourceCommit !== TYPED_FORWARD_PREVIOUS_SOURCE) fail('PREVIOUS_SOURCE_INVALID');
  validateRehearsalBinding(rehearsal, targets);
  const targetInventoryDigest = identityDigest(targets.map(target => ({ role: target.role, binding: target.binding, name: target.name, databaseId: target.databaseId, bytes: target.bytes })));
  if (!object(inventory) || inventory.targetsSha256 !== targetInventoryDigest) fail('INVENTORY_INVALID');
  assertCleanSource(repositoryRoot, candidateSourceCommit);
  if (typeof checkSource === 'function') await checkSource(candidateSourceCommit);
  const byStep = new Map((rehearsal.steps ?? []).map(step => [`${step.role}:${step.name}`, step]));
  const steps = [];
  const previousByRole = Object.fromEntries(targets.map(target => [target.role, target.previous]));
  for (const expected of TYPED_FORWARD_MIGRATIONS) {
    const result = byStep.get(`${expected.role}:${expected.name}`);
    if (!result || !SHA256.test(result.afterSchemaSha256 ?? '')) fail('REHEARSAL_REQUIRED');
    await safeSql(workerRoot, expected);
    const prior = steps.filter(step => step.role === expected.role).at(-1);
    steps.push({ ...expected, beforeSchemaSha256: prior?.afterSchemaSha256 ?? previousByRole[expected.role]?.schemaSha256, afterSchemaSha256: result.afterSchemaSha256 });
  }
  const plan = { schema: TYPED_FORWARD_SCHEMA, operationId, environment: 'production', accountId, workerName,
    previousSourceCommit, candidateSourceCommit, createdAt, expiresAt, operatingCapBytes: TYPED_FORWARD_OPERATING_CAP_BYTES,
    wranglerSha256, rehearsalSha256: identityDigest(rehearsal), inventory, targets, steps };
  validateTypedForwardPlan(plan);
  return { plan, planSha256: identityDigest(plan) };
}

function schemaRows(database) {
  return normalizeRows(database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND tbl_name <> 'd1_storage_migrations' ORDER BY type,name").all());
}
function localDataInvariant(database, role) {
  return identityDigest(normalizeRows(database.prepare(TYPED_FORWARD_DATA_INVARIANT_SQL[role]).all()));
}
function localLedger(database) {
  return normalizeRows(database.prepare('SELECT name,sha256 FROM d1_storage_migrations ORDER BY rowid').all());
}
function localInspect(database, role) {
  const rows = schemaRows(database);
  return { schemaSha256: storageSchemaDigest(rows), migrations: localLedger(database), dataInvariantSha256: localDataInvariant(database, role),
    bytes: database.prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get().bytes };
}

async function applyDirectory(database, workerRoot, directory, until = null) {
  const names = (await readdir(join(workerRoot, directory))).filter(name => name.endsWith('.sql')).sort();
  for (const name of names) {
    if (until !== null && name >= until) break;
    database.exec(await readFile(join(workerRoot, directory, name), 'utf8'));
  }
}
async function populatedRehearsalDatabases(workerRoot) {
  const primary = new DatabaseSync(':memory:');
  const analytics = new DatabaseSync(':memory:');
  primary.exec('PRAGMA foreign_keys=ON'); analytics.exec('PRAGMA foreign_keys=ON');
  for (const directory of PRIOR_DIRECTORIES) await applyDirectory(primary, workerRoot, directory, directory === 'ingestion-isolation-migrations' ? '0006_usage_correction_facts.sql' : null);
  await applyDirectory(analytics, workerRoot, 'analytics-migrations', '0024_effective_owner_daily_cursor.sql');
  primary.exec('CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT');
  analytics.exec('CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT');
  for (const [role, database] of [['primary', primary], ['analytics', analytics]]) {
    const prefix = REHEARSAL_PREFIX[role];
    database.prepare('INSERT INTO d1_storage_migrations(name,sha256) VALUES(?,?)').run(prefix.name, storageSha256(prefix.sql));
  }
  primary.exec("INSERT INTO participants(id,owner_kind,access_token_id,access_token_hash,recovery_token_id,recovery_token_hash,consent_version,consented_at,created_at) VALUES ('synthetic-forward-owner','social','access',X'01','recovery',X'02','synthetic-forward','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');");
  primary.exec("INSERT INTO telemetry_records(participant_id,record_kind,occurrence_id,observed_at,provider,model_id,input_uncached_tokens,output_text_tokens,record_json) VALUES ('synthetic-forward-owner','usage','synthetic-occurrence','2026-01-01T00:00:00Z','openai_codex','gpt-synthetic',10,2,'{}');");
  analytics.exec("INSERT INTO analytics_runtime_sources(source_id,source_namespace,contract_version) VALUES ('synthetic-forward-source','synthetic-forward-namespace',1);");
  analytics.exec(`INSERT INTO analytics_community_daily_owners(source_id,day,owner_digest,input_revision,owner_revision,source_format,method,progress_revision,next_index,fingerprint,complete,values_json) VALUES ('synthetic-forward-source','2026-01-01','${'a'.repeat(64)}',1,1,'v11','synthetic-forward',1,0,NULL,1,'{}');`);
  return { primary, analytics };
}

function columns(database, table) {
  return database.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => row.name);
}
function tableSql(database, table) {
  return String(database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table)?.sql ?? '');
}
function assertMappedColumns(database, role, step) {
  for (const [table, expected] of REQUIRED_COLUMNS[`${role}:${step.name}`] ?? []) {
    if (expected === null) {
      if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table)) fail('REHEARSAL_MAPPING_INVALID');
    } else if (!expected.every(column => columns(database, table).includes(column))) fail('REHEARSAL_MAPPING_INVALID');
  }
}
function assertSemanticMappings(database, role, step) {
  const key = `${role}:${step.name}`;
  if (key === 'primary:0006_usage_correction_facts.sql') {
    const row = database.prepare('SELECT schema_version,method_version,state,max_capture_rows,max_history_page FROM telemetry_usage_correction_runtime WHERE id=1').get();
    if (!row || row.schema_version !== 'telemetry-usage-correction-v1' || row.method_version !== 'usage-total-correction-v1'
        || row.state !== 'staged' || row.max_capture_rows !== 200 || row.max_history_page !== 200) fail('REHEARSAL_MAPPING_INVALID');
  } else if (key === 'primary:0008_telemetry_v12.sql') {
    const row = database.prepare('SELECT schema_version,envelope_schema_version,field_dictionary_version,privacy_contract_version,state,policy_revision,max_day_chunks,max_chunk_records,max_day_bytes FROM telemetry_v12_runtime WHERE id=1').get();
    if (!row || row.schema_version !== 'telemetry-contribution-v1.2' || row.envelope_schema_version !== 'telemetry-envelope-v1.2'
        || row.field_dictionary_version !== 'telemetry-v1.2-registry-2026-09-20.1' || row.privacy_contract_version !== 'ongoing-privacy-safe-telemetry-v1.2'
        || row.state !== 'staged' || row.policy_revision !== 1 || row.max_day_chunks !== 4096 || row.max_chunk_records !== 200
        || row.max_day_bytes !== 64000000) fail('REHEARSAL_MAPPING_INVALID');
  } else if (key === 'primary:0009_performance_reports.sql') {
    const row = database.prepare('SELECT schema_version,method_version,state,policy_revision FROM telemetry_performance_runtime WHERE id=1').get();
    if (!row || row.schema_version !== 'model-performance-daily-v1' || row.method_version !== 'performance-daily-histogram-v1'
        || row.state !== 'staged' || row.policy_revision !== 1 || !tableSql(database, 'telemetry_performance_reports').includes("bucket_scheme_version = 'performance-histogram-v1'")) fail('REHEARSAL_MAPPING_INVALID');
  } else if (key === 'analytics:0024_effective_owner_daily_cursor.sql') {
    const row = database.prepare('SELECT source_format,method,progress_revision,next_index,complete,values_json FROM analytics_community_daily_owners WHERE source_id=?').get('synthetic-forward-source');
    if (!row || row.source_format !== 'v11' || row.method !== 'synthetic-forward' || row.progress_revision !== 1
        || row.next_index !== 0 || row.complete !== 1 || row.values_json !== '{}') fail('REHEARSAL_MAPPING_INVALID');
  } else if (key === 'analytics:0025_effective_graph_source.sql') {
    const sql = tableSql(database, 'analytics_community_graph_results');
    if (!sql.includes('source_kind TEXT NOT NULL CHECK') || !sql.includes("'effective'")) fail('REHEARSAL_MAPPING_INVALID');
  } else if (key === 'analytics:0026_cache_retention_effective_layout.sql') {
    const marks = tableSql(database, 'analytics_cache_retention_day_marks');
    const progress = tableSql(database, 'analytics_cache_retention_day_progress');
    if (!marks.includes('source_layout TEXT NOT NULL CHECK') || !marks.includes("'effective'")
        || !progress.includes("method_version TEXT NOT NULL CHECK(method_version='cache-retention-v2')")) fail('REHEARSAL_MAPPING_INVALID');
  }
}

export async function rehearseTypedForwardMigration({ workerRoot, injectFailureAt = null } = {}) {
  if (typeof workerRoot !== 'string') fail('REHEARSAL_INPUT_INVALID');
  const root = await realpath(resolve(workerRoot));
  const { primary, analytics } = await populatedRehearsalDatabases(root);
  const databases = { primary, analytics };
  const before = {};
  const steps = [];
  try {
    for (const role of ['primary', 'analytics']) {
      before[role] = localInspect(databases[role], role);
      let prior = before[role];
      for (const expected of TYPED_FORWARD_MIGRATIONS.filter(step => step.role === role)) {
        const sql = await safeSql(root, expected);
        const beforeSchemaSha256 = localInspect(databases[role], role).schemaSha256;
        if (beforeSchemaSha256 !== prior.schemaSha256) fail('REHEARSAL_SCHEMA_CHAIN_INVALID');
        databases[role].exec('SAVEPOINT typed_forward_step');
        try {
          if (injectFailureAt === `${role}:${expected.name}`) fail('INJECTED_REHEARSAL_FAILURE');
          databases[role].exec(sql);
          databases[role].prepare('INSERT INTO d1_storage_migrations(name,sha256) VALUES(?,?)').run(expected.name, expected.sha256);
          const violations = databases[role].prepare('PRAGMA foreign_key_check').all();
          if (violations.length) fail('REHEARSAL_FOREIGN_KEY_FAILED');
          assertMappedColumns(databases[role], role, expected);
          assertSemanticMappings(databases[role], role, expected);
          databases[role].exec('RELEASE typed_forward_step');
        } catch (error) {
          try { databases[role].exec('ROLLBACK TO typed_forward_step'); databases[role].exec('RELEASE typed_forward_step'); } catch {}
          const restored = localInspect(databases[role], role);
          if (restored.schemaSha256 !== prior.schemaSha256 || restored.dataInvariantSha256 !== prior.dataInvariantSha256
              || !sameRows(restored.migrations, prior.migrations)) fail('REHEARSAL_ROLLBACK_FAILED');
          throw error;
        }
        const after = localInspect(databases[role], role);
        if (after.migrations.at(-1)?.name !== expected.name || after.migrations.at(-1)?.sha256 !== expected.sha256
            || after.dataInvariantSha256 !== prior.dataInvariantSha256) fail('REHEARSAL_PRESERVATION_FAILED');
        steps.push({ role, binding: expected.binding, directory: expected.directory, name: expected.name, sha256: expected.sha256,
          beforeSchemaSha256, afterSchemaSha256: after.schemaSha256, dataInvariantSha256: after.dataInvariantSha256 });
        prior = after;
      }
      if (localDataInvariant(databases[role], role) !== before[role].dataInvariantSha256) fail('REHEARSAL_PRESERVATION_FAILED');
    }
    return { schema: TYPED_FORWARD_REHEARSAL_SCHEMA, status: 'passed', remoteOperations: false, populatedSource: true,
      dataInvariantPreserved: true, foreignKeyViolations: 0, steps, targets: Object.fromEntries(Object.entries(before).map(([role, value]) => [role, {
        syntheticPriorReceipt: true, schemaSha256: value.schemaSha256, dataInvariantSha256: value.dataInvariantSha256, ledger: value.migrations,
      }])), mappedColumns: steps.flatMap(step => (REQUIRED_COLUMNS[`${step.role}:${step.name}`] ?? []).map(([table, expected]) => ({ role: step.role, migration: step.name, table, columns: expected }))) };
  } finally { primary.close(); analytics.close(); }
}

function expectedLedger(target, count) {
  return [...target.previous.ledger, ...TYPED_FORWARD_MIGRATIONS.filter(step => step.role === target.role).slice(0, count).map(step => ({ name: step.name, sha256: step.sha256 }))];
}
function expectedStep(plan, role, index) {
  return plan.steps.filter(step => step.role === role)[index];
}
function sameRows(left, right) { return identityDigest(left) === identityDigest(right); }
function validateInspectionShape(value) {
  if (!object(value) || !SHA256.test(value.schemaSha256 ?? '') || !SHA256.test(value.dataInvariantSha256 ?? '')
      || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || !Array.isArray(value.migrations) || value.migrations.length > 128
      || value.migrations.some(row => !exact(row, ['name', 'sha256']) || !SQL_NAME.test(row.name ?? '') || !SHA256.test(row.sha256 ?? ''))) fail('SCHEMA_READBACK_INVALID');
  return value;
}
function validateInspection(value, target, expectedLedgerRows = null) {
  validateInspectionShape(value);
  const ledger = expectedLedgerRows ?? target.previous.ledger;
  if (!sameRows(value.migrations, ledger)) fail('LEDGER_PREFIX_DRIFT');
  return value;
}

function validateState(state, plan) {
  if (!object(state) || Object.keys(state).some(key => !['schema', 'status', 'owner', 'targets', 'lastFailure', 'lastFailureDiagnostics'].includes(key))
      || !['schema', 'status', 'owner', 'targets'].every(key => Object.hasOwn(state, key))
      || state.schema !== TYPED_FORWARD_OPERATION_SCHEMA
      || !COMMIT.test(plan.candidateSourceCommit) || !/^[a-f0-9]{40}$/u.test(state.owner ?? '')
      || !['lock_intent', 'running', 'release_intent', 'completed'].includes(state.status) || !object(state.targets)
      || (state.lastFailure !== undefined && !/^TYPED_FORWARD_[A-Z_]+$/u.test(state.lastFailure))
      || (state.lastFailureDiagnostics !== undefined && (!object(state.lastFailureDiagnostics)
        || !exact(state.lastFailureDiagnostics, ['classification', 'file', 'sha256'])
        || typeof state.lastFailureDiagnostics.classification !== 'string' || state.lastFailureDiagnostics.classification.length > 64
        || typeof state.lastFailureDiagnostics.file !== 'string' || state.lastFailureDiagnostics.file.length > 256
        || !SHA256.test(state.lastFailureDiagnostics.sha256 ?? '')))) fail('OPERATION_STATE_INVALID');
  if (Object.keys(state.targets).some(binding => !plan.targets.some(target => target.binding === binding))) fail('OPERATION_STATE_INVALID');
  for (const target of plan.targets) {
    const row = state.targets[target.binding];
    const count = TYPED_FORWARD_MIGRATIONS.filter(step => step.role === target.role).length;
    if (row !== undefined && (!exact(row, ['status', 'applied', 'intent']) || !['pending', 'migrated', 'migration_intent'].includes(row.status)
      || !Number.isSafeInteger(row.applied) || row.applied < 0 || row.applied > count
      || !(row.intent === null || (Number.isSafeInteger(row.intent) && row.intent >= 0 && row.intent < count))
      || (row.status === 'migration_intent' && row.intent !== row.applied)
      || (row.status !== 'migration_intent' && row.intent !== null))) fail('OPERATION_STATE_INVALID');
  }
  return state;
}
function boundedDiagnostics(error) {
  const diagnostics = error?.diagnostics;
  if (!object(diagnostics) || typeof diagnostics.file !== 'string' || !SHA256.test(diagnostics.sha256 ?? '')) return undefined;
  return {
    classification: typeof diagnostics.classification === 'string' ? diagnostics.classification.slice(0, 64) : 'uncertain',
    file: diagnostics.file.slice(0, 256),
    sha256: diagnostics.sha256,
  };
}

export async function runTypedForwardMigration({ plan, workerRoot, repositoryRoot, operationDirectory, execute = false, resume = false,
  confirmation = null, approvedPlanSha256 = null, now = Date.now(), adapterFactory = null,
  lockFactory = ({ repositoryRoot: root }) => createProductionDeploymentLock({ repositoryRoot: root }), checkSource = null }) {
  const prepared = validateTypedForwardPlan(plan, { now, allowExpired: execute && resume });
  const planSha256 = identityDigest(prepared);
  if (!execute) return { status: 'planned', planSha256, remoteWrites: false, deploymentPerformed: false, lockChanged: false };
  if (confirmation !== TYPED_FORWARD_CONFIRMATION || approvedPlanSha256 !== planSha256 || typeof adapterFactory !== 'function'
      || typeof operationDirectory !== 'string' || typeof repositoryRoot !== 'string') fail('EXECUTE_NOT_APPROVED');
  assertCleanSource(repositoryRoot, prepared.candidateSourceCommit);
  if (typeof checkSource === 'function') await checkSource(prepared.candidateSourceCommit);
  const operation = await openOperation({ directory: operationDirectory, kind: 'production', binding: prepared, resume });
  let state = operation.record.state;
  const lock = lockFactory({ repositoryRoot });
  try {
    if (resume) validateState(state, prepared);
    else {
      const owner = await lock.createOwner({ id: operation.record.id, sourceCommit: prepared.candidateSourceCommit, previousSourceCommit: prepared.previousSourceCommit });
      state = { schema: TYPED_FORWARD_OPERATION_SCHEMA, status: 'lock_intent', owner, targets: {} };
      await operation.save(state);
    }
    if (state.status === 'completed') return { status: 'completed', planSha256, remoteWrites: true, deploymentPerformed: false, lockChanged: false };
    if (state.status === 'release_intent') {
      if (await lock.status() !== null) await lock.assertOwned(state.owner);
      else { state.status = 'completed'; await operation.save(state); return { status: 'completed', planSha256, remoteWrites: true, deploymentPerformed: false, lockChanged: false }; }
    }
    if (state.status === 'lock_intent') {
      if (await lock.status() === state.owner) { state.status = 'running'; await operation.save(state); }
      else { await lock.acquire(state.owner); state.status = 'running'; await operation.save(state); }
    } else await lock.assertOwned(state.owner);
    const adapter = await adapterFactory({ plan: prepared, workerRoot, operationDirectory, allowExpiredPlan: resume });
    const guard = async () => {
      if (typeof checkSource === 'function') await checkSource(prepared.candidateSourceCommit);
      await lock.assertOwned(state.owner);
      const currentPlan = validateTypedForwardPlan(prepared, { now: Date.now(), allowExpired: true });
      if (identityDigest(currentPlan) !== planSha256) fail('PLAN_CHANGED');
    };
    for (const target of prepared.targets) {
      const count = TYPED_FORWARD_MIGRATIONS.filter(step => step.role === target.role).length;
      let receipt = state.targets[target.binding] ?? { status: 'pending', applied: 0, intent: null };
      state.targets[target.binding] = receipt; await operation.save(state);
      const inventory = await adapter.inventory(target);
      if (!Array.isArray(inventory) || inventory.length !== 1 || inventory[0]?.id !== target.databaseId || inventory[0]?.name !== target.name) fail('RESOURCE_DRIFT');
      if (!Number.isSafeInteger(inventory[0].bytes) || inventory[0].bytes < 0) fail('RESOURCE_DRIFT');
      if (receipt.applied === 0 && receipt.intent === null && inventory[0].bytes !== target.bytes) fail('RESOURCE_DRIFT');
      if (inventory[0].bytes < target.bytes) fail('RESOURCE_DRIFT');
      let rawInspection = validateInspectionShape(await adapter.inspect(target));
      let observed;
      if (receipt.intent !== null) {
        const step = expectedStep(prepared, target.role, receipt.intent);
        const afterLedger = expectedLedger(target, receipt.intent + 1);
        const beforeLedger = expectedLedger(target, receipt.intent);
        const beforeSchema = receipt.intent ? prepared.steps.filter(s => s.role === target.role)[receipt.intent - 1].afterSchemaSha256 : target.previous.schemaSha256;
        if (sameRows(rawInspection.migrations, afterLedger) && rawInspection.schemaSha256 === step.afterSchemaSha256
            && rawInspection.dataInvariantSha256 === target.previous.dataInvariantSha256) {
          receipt = { status: 'migrated', applied: receipt.intent + 1, intent: null };
          state.targets[target.binding] = receipt; await operation.save(state);
        } else if (!sameRows(rawInspection.migrations, beforeLedger) || rawInspection.schemaSha256 !== beforeSchema
            || rawInspection.dataInvariantSha256 !== target.previous.dataInvariantSha256) fail('MIGRATION_RESULT_UNCERTAIN');
        else { receipt = { status: 'pending', applied: receipt.intent, intent: null }; state.targets[target.binding] = receipt; await operation.save(state); }
      } else {
        observed = validateInspection(rawInspection, target);
      }
      if (receipt.status === 'migrated' && receipt.applied === count) continue;
      if (receipt.applied > count) fail('OPERATION_STATE_INVALID');
      for (let index = receipt.applied; index < count; index += 1) {
        await guard();
        const info = (await adapter.inventory(target))?.[0];
        if (!info || info.id !== target.databaseId || info.name !== target.name || !Number.isSafeInteger(info.bytes) || info.bytes < target.bytes
            || info.bytes + target.migrationGrowthBudgetBytes >= TYPED_FORWARD_OPERATING_CAP_BYTES) fail('OPERATING_CAP_EXCEEDED');
        observed = validateInspection(await adapter.inspect(target), target, expectedLedger(target, index));
        const step = expectedStep(prepared, target.role, index);
        if (observed.schemaSha256 !== step.beforeSchemaSha256 || observed.dataInvariantSha256 !== target.previous.dataInvariantSha256) fail('SCHEMA_PREFIX_DRIFT');
        const sql = await safeSql(workerRoot, step);
        receipt = { status: 'migration_intent', applied: index, intent: index };
        state.targets[target.binding] = receipt; await operation.save(state);
        await guard();
        try { await adapter.migrate(target, { ...step, sql }); } catch { throw fail('MIGRATION_RESULT_UNCERTAIN'); }
        observed = validateInspection(await adapter.inspect(target), target, expectedLedger(target, index + 1));
        if (observed.schemaSha256 !== step.afterSchemaSha256 || observed.dataInvariantSha256 !== target.previous.dataInvariantSha256) fail('MIGRATION_RESULT_UNCERTAIN');
        receipt = { status: 'migrated', applied: index + 1, intent: null };
        state.targets[target.binding] = receipt; await operation.save(state);
      }
    }
    await lock.assertOwned(state.owner); state.status = 'release_intent'; await operation.save(state);
    try { await lock.release(state.owner); } catch { throw fail('LOCK_RELEASE_UNCERTAIN'); }
    state.status = 'completed'; await operation.save(state);
    return { status: 'completed', planSha256, remoteWrites: true, deploymentPerformed: false, lockChanged: true };
  } catch (error) {
    if (state && state.status !== 'completed') {
      state.lastFailure = /^TYPED_FORWARD_[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'TYPED_FORWARD_OPERATION_UNCERTAIN';
      const diagnostics = boundedDiagnostics(error);
      if (diagnostics) state.lastFailureDiagnostics = diagnostics;
      await operation.save({ ...state, status: state.status === 'release_intent' ? 'release_intent' : state.status });
    }
    throw error;
  } finally { operation.close(); }
}

// The concrete transport is intentionally separate from the injected runner.
// It uses the existing pinned Wrangler query/file launchers, a fixed account,
// fixed binding IDs, and one file-import call per migration. It never discovers
// a database by name and it never creates a missing d1_storage_migrations table.
export async function createTypedForwardWranglerAdapter({ plan, operationDirectory, cliPath, spawn = spawnSync }) {
  if (!plan || typeof operationDirectory !== 'string' || typeof cliPath !== 'string') fail('TRANSPORT_INPUT_INVALID');
  const cli = queryValidation.verifyCli(cliPath, plan.wranglerSha256);
  if (cli.digest !== plan.wranglerSha256) fail('TRANSPORT_CLI_CHANGED');
  const baseEnvironment = storageWranglerEnvironment(process.env, plan.accountId, '/dev/null');
  const root = join(resolve(operationDirectory), 'typed-forward-wrangler');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || await realpath(root) !== root) fail('TRANSPORT_DIRECTORY_UNSAFE');
  let sequence = 0;
  const privateFile = async (path, bytes) => {
    const expected = Buffer.from(bytes);
    try { await writeFile(path, expected, { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())
          || await realpath(path) !== path || !(await readFile(path)).equals(expected)) fail('TRANSPORT_FILE_CHANGED');
    }
    return path;
  };
  const config = async target => {
    const bytes = Buffer.from(`${JSON.stringify({ name: 'tibotattle-typed-forward', account_id: plan.accountId, compatibility_date: '2026-09-11', d1_databases: [{ binding: target.binding, database_name: target.name, database_id: target.databaseId }] })}\n`);
    const path = join(root, `${target.binding}.json`); await privateFile(path, bytes);
    return path;
  };
  const redacted = value => {
    let text = String(value ?? '');
    for (const [key, secret] of Object.entries(process.env)) {
      if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|COOKIE/i.test(key) && typeof secret === 'string' && secret.length >= 8)
        text = text.split(secret).join('[REDACTED]');
    }
    return text.replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s"',;]+/gi, '$1[REDACTED]');
  };
  const retainProviderFailure = async (result, args) => {
    const stdout = Buffer.from(redacted(result?.stdout)).subarray(0, 4096);
    const stderr = Buffer.from(redacted(result?.stderr)).subarray(0, 4096);
    const receipt = {
      schema: 'typed-forward-provider-failure-v1', outcome: 'uncertain', retryPerformed: false,
      exitStatus: Number.isSafeInteger(result?.status) ? result.status : null,
      signal: ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGINT'].includes(result?.signal) ? result.signal : null,
      errorCode: typeof result?.error?.code === 'string' ? result.error.code.slice(0, 32) : null,
      invocationSha256: storageSha256(JSON.stringify(args)),
      stdout: { sha256: storageSha256(stdout), bytes: stdout.length, truncated: String(result?.stdout ?? '').length > stdout.length },
      stderr: { sha256: storageSha256(stderr), bytes: stderr.length, truncated: String(result?.stderr ?? '').length > stderr.length },
      stdoutSnippet: stdout.toString('utf8'), stderrSnippet: stderr.toString('utf8'),
    };
    const path = join(root, `provider-failure-${sequence++}.json`);
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
    await privateFile(path, bytes);
    return { file: path.split('/').at(-1), sha256: storageSha256(bytes), classification: result?.error ? 'spawn_error' : result?.signal ? 'signal' : 'nonzero_exit' };
  };
  const run = async (args, target, decode = null) => {
    let result;
    try {
      result = spawn(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 512 * 1024,
        env: { ...baseEnvironment, WRANGLER_LOG_PATH: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { result = { error, status: null }; }
    if (result.error || result.status !== 0) {
      const error = operationError('TYPED_FORWARD_PROVIDER_RESULT_UNCERTAIN');
      error.diagnostics = await retainProviderFailure(result, args);
      throw error;
    }
    if (decode) return decode(String(result.stdout ?? ''));
    return String(result.stdout ?? '');
  };
  const readQuery = async (target, sql) => {
    const sqlBytes = Buffer.from(sql), configPath = await config(target), sqlPath = await privateFile(join(root, `query-${sequence++}.sql`), sqlBytes);
    const invocation = createWranglerQueryInvocation({ cliPath, configPath, binding: target.binding, databaseId: target.databaseId, mode: 'remote', sqlPath, expectedSqlSha256: storageSha256(sqlBytes) });
    let value;
    const output = await run(invocation.args, target);
    try { value = JSON.parse(output); } catch { fail('QUERY_RESULT_INVALID'); }
    if (!Array.isArray(value) || value.length !== 1 || value[0]?.success !== true || !Array.isArray(value[0]?.results)
        || value[0].results.length > 4096 || value[0].results.some(row => !object(row) || Object.keys(row).length > 64
          || JSON.stringify(row).length > 128 * 1024)) fail('QUERY_RESULT_INVALID');
    return value[0].results;
  };
  const readInventory = async target => {
    const accountConfig = join(root, 'account.json');
    await privateFile(accountConfig, Buffer.from(`${JSON.stringify({ name: 'tibotattle-typed-forward-account', account_id: plan.accountId, compatibility_date: '2026-09-11', d1_databases: [] })}\n`));
    let list;
    const listOutput = await run([cli.canonical, 'd1', 'list', '--json', '--config', accountConfig], target);
    try { list = JSON.parse(listOutput); } catch { fail('INVENTORY_INVALID'); }
    if (!Array.isArray(list) || list.length > 4096) fail('INVENTORY_INVALID');
    const matches = list.filter(row => row.name === target.name && row.uuid === target.databaseId);
    if (matches.length !== 1) fail('RESOURCE_DRIFT');
    let info;
    const infoOutput = await run([cli.canonical, 'd1', 'info', target.databaseId, '--json', '--config', accountConfig], target);
    try { info = JSON.parse(infoOutput); } catch { fail('INVENTORY_INVALID'); }
    if (info.uuid !== target.databaseId || info.name !== target.name || !Number.isSafeInteger(info.database_size ?? info.file_size)) fail('RESOURCE_DRIFT');
    return [{ id: info.uuid, name: info.name, bytes: info.database_size ?? info.file_size }];
  };
  const fileImport = async (target, sql) => {
    const configPath = await config(target), sqlBytes = Buffer.from(sql), sqlPath = await privateFile(join(root, `migration-${sequence++}.sql`), sqlBytes);
    const invocation = createWranglerQueryInvocation({ cliPath, configPath, binding: target.binding, databaseId: target.databaseId, mode: 'remote', sqlPath, expectedSqlSha256: storageSha256(sqlBytes) });
    invocation.args[2] = fileURLToPath(new URL('./d1-storage-file-preload.cjs', import.meta.url));
    invocation.args[invocation.args.indexOf(queryValidation.PLACEHOLDER)] = fileValidation.PLACEHOLDER;
    const stdout = await run(invocation.args, target);
    const start = stdout.indexOf('['); if (start < 0 || start > 4096) fail('IMPORT_RESULT_INVALID');
    let value; try { value = JSON.parse(stdout.slice(start)); } catch { fail('IMPORT_RESULT_INVALID'); }
    const row = value?.[0];
    if (!Array.isArray(value) || value.length !== 1 || !row || Object.keys(row).sort().join() !== 'finalBookmark,meta,results,success'
        || row.success !== true || !Array.isArray(row.results) || row.results.length > 4096 || typeof row.finalBookmark !== 'string'
        || row.finalBookmark.length < 1 || row.finalBookmark.length > 256 || !object(row.meta) || !Number.isFinite(row.meta.duration)
        || row.meta.duration < 0) fail('IMPORT_RESULT_INVALID');
  };
  return {
    async inventory(target) { return readInventory(target); },
    async inspect(target) {
      const schema = await readQuery(target, "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name <> 'd1_storage_migrations' ORDER BY type,name LIMIT 4097");
      const ledgerSchema = await readQuery(target, "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name='d1_storage_migrations' OR tbl_name='d1_storage_migrations' ORDER BY type,name LIMIT 4");
      const expectedLedgerObjects = [
        { type: 'index', name: 'sqlite_autoindex_d1_storage_migrations_1', tbl_name: 'd1_storage_migrations', sql: null },
        { type: 'table', name: 'd1_storage_migrations', tbl_name: 'd1_storage_migrations', sql: 'CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT' },
      ];
      if (ledgerSchema.length !== expectedLedgerObjects.length || ledgerSchema.some((row, index) => !exact(row, ['type', 'name', 'tbl_name', 'sql'])
          || Object.entries(expectedLedgerObjects[index]).some(([key, value]) => row[key] !== value))) fail('PRIOR_RECEIPT_MISSING');
      const ledger = await readQuery(target, 'SELECT name,sha256 FROM d1_storage_migrations ORDER BY rowid LIMIT 129');
      parseLedger(ledger);
      const data = await readQuery(target, TYPED_FORWARD_DATA_INVARIANT_SQL[target.role]);
      return { schemaSha256: storageSchemaDigest(schema), migrations: ledger, dataInvariantSha256: identityDigest(normalizeRows(data)), bytes: 0 };
    },
    async migrate(target, step) {
      if (!step || storageSha256(step.sql) !== step.sha256) fail('MIGRATION_NOT_PLANNED');
      // The prior ledger was proven present during inspect. No CREATE TABLE is
      // included here: a missing ledger can never be silently seeded.
      await fileImport(target, `${step.sql}\nINSERT INTO d1_storage_migrations(name,sha256) VALUES('${step.name}','${step.sha256}');`);
    },
  };
}

export function parseTypedForwardArguments(args) {
  const result = { mode: 'inspect', resume: false };
  const values = new Map([['--mode', 'mode'], ['--plan', 'planPath'], ['--worker-root', 'workerRoot'], ['--operation', 'operationDirectory'],
    ['--repository-root', 'repositoryRoot'], ['--cli', 'cliPath'], ['--confirmation', 'confirmation'], ['--approved-plan-sha256', 'approvedPlanSha256'],
    ['--inventory', 'inventoryPath'], ['--targets', 'targetsPath'], ['--rehearsal', 'rehearsalPath'], ['--candidate-source', 'candidateSourceCommit'],
    ['--account-id', 'accountId'], ['--worker-name', 'workerName'], ['--wrangler-sha256', 'wranglerSha256'], ['--output', 'outputPath']]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--resume') { if (result.resume) fail('ARGUMENTS_INVALID'); result.resume = true; continue; }
    const key = values.get(arg), value = args[++index];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(result, key) && key !== 'mode') fail('ARGUMENTS_INVALID');
    result[key] = value;
  }
  if (!['inspect', 'prepare', 'rehearse', 'execute'].includes(result.mode)
      || result.mode === 'rehearse' && !result.workerRoot
      || result.mode === 'inspect' && !result.planPath
      || result.mode === 'prepare' && (!result.workerRoot || !result.repositoryRoot || !result.inventoryPath || !result.targetsPath
        || !result.rehearsalPath || !result.candidateSourceCommit || !result.accountId || !result.workerName || !result.wranglerSha256 || !result.outputPath)
      || result.mode === 'execute' && (!result.planPath || !result.workerRoot || !result.operationDirectory || !result.repositoryRoot
        || !result.cliPath || !result.confirmation || !result.approvedPlanSha256)) fail('ARGUMENTS_INVALID');
  return result;
}

async function readPrivateJson(path, code = 'PLAN_INVALID') {
  if (typeof path !== 'string' || !path || path.length > 4096) fail(code);
  const resolved = resolve(path), stat = await lstat(resolved).catch(() => null);
  if (!stat?.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 1_048_576
      || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || await realpath(resolved).catch(() => null) !== resolved) fail(code);
  const bytes = await readFile(resolved);
  if (bytes.length !== stat.size) fail(code);
  try { return JSON.parse(bytes); } catch { fail(code); }
}
async function writePrivateJson(path, value) {
  if (typeof path !== 'string' || !path || path.length > 4096) fail('PLAN_OUTPUT_UNSAFE');
  const resolved = resolve(path), parent = dirname(resolved), parentStat = await lstat(parent).catch(() => null);
  if (!parentStat?.isDirectory() || (parentStat.mode & 0o077) !== 0 || (process.getuid && parentStat.uid !== process.getuid())
      || await realpath(parent).catch(() => null) !== parent) fail('PLAN_OUTPUT_UNSAFE');
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > 1_048_576) fail('PLAN_OUTPUT_UNSAFE');
  try { await writeFile(resolved, bytes, { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') fail('PLAN_OUTPUT_EXISTS'); throw error; }
  return resolved;
}

async function main() {
  try {
    const options = parseTypedForwardArguments(process.argv.slice(2));
    if (options.mode === 'rehearse') { process.stdout.write(`${JSON.stringify(await rehearseTypedForwardMigration({ workerRoot: options.workerRoot }))}\n`); return; }
    if (options.mode === 'prepare') {
      const inventory = await readPrivateJson(options.inventoryPath, 'INVENTORY_INVALID');
      const targets = await readPrivateJson(options.targetsPath, 'TARGET_INVALID');
      const rehearsal = await readPrivateJson(options.rehearsalPath, 'REHEARSAL_REQUIRED');
      const prepared = await prepareTypedForwardPlan({ workerRoot: options.workerRoot, repositoryRoot: options.repositoryRoot,
        accountId: options.accountId, workerName: options.workerName, candidateSourceCommit: options.candidateSourceCommit,
        inventory, targets, rehearsal, wranglerSha256: options.wranglerSha256 });
      await writePrivateJson(options.outputPath, prepared.plan);
      process.stdout.write(`${JSON.stringify({ status: 'prepared', planSha256: prepared.planSha256, outputPath: resolve(options.outputPath), remoteWrites: false })}\n`);
      return;
    }
    const plan = await readPrivateJson(options.planPath);
    if (options.mode === 'inspect') { process.stdout.write(`${JSON.stringify({ status: 'planned', planSha256: identityDigest(validateTypedForwardPlan(plan)), remoteWrites: false })}\n`); return; }
    const result = await runTypedForwardMigration({ plan, workerRoot: options.workerRoot, repositoryRoot: options.repositoryRoot,
      operationDirectory: options.operationDirectory, execute: true, resume: options.resume, confirmation: options.confirmation,
      approvedPlanSha256: options.approvedPlanSha256,
      adapterFactory: input => createTypedForwardWranglerAdapter({ plan: input.plan, operationDirectory: input.operationDirectory, cliPath: options.cliPath }) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${/^TYPED_FORWARD_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'TYPED_FORWARD_FAILED'}\n`); process.exitCode = 1; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
