import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { identityDigest, openOperation, operationError } from '../../../scripts/lib/release-operation.mjs';
import { createProductionDeploymentLock } from './production-deployment-lock.mjs';
import { storageSchemaDigest, storageSha256 } from './d1-storage-plan.mjs';
import { createWranglerQueryInvocation } from './wrangler-query-launcher.mjs';
import queryValidation from './wrangler-query-preload.cjs';
import { storageWranglerEnvironment } from './d1-storage-wrangler.mjs';
import { createProductionLiveProvider } from './production-live-provider.mjs';
import { createProductionLiveConfigSnapshot, productionLiveConfigFingerprint } from './production-live-config.mjs';

export const TYPED_FORWARD_SCHEMA = 'typed-forward-migration-plan-v2';
export const TYPED_FORWARD_REHEARSAL_SCHEMA = 'typed-forward-migration-rehearsal-v2';
export const TYPED_FORWARD_OPERATION_SCHEMA = 'typed-forward-migration-operation-v2';
export const TYPED_FORWARD_MAINTENANCE_HOLD_SCHEMA = 'typed-forward-maintenance-hold-v1';
export const TYPED_FORWARD_CONFIRMATION = 'EXECUTE_REVIEWED_TYPED_FORWARD_MIGRATION';
export const TYPED_FORWARD_PREVIOUS_SOURCE = 'eaf6f521fb9842399da512fd1ad5020c7b706f5b';
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
const textSummary = column => `json_object(
 'nulls',COALESCE(SUM(CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END),0),
 'bytes',COALESCE(SUM(length(CAST(${column} AS BLOB))),0),
 'min_bytes',COALESCE(MIN(CASE WHEN ${column} IS NULL THEN NULL ELSE length(CAST(${column} AS BLOB)) END),0),
 'max_bytes',COALESCE(MAX(CASE WHEN ${column} IS NULL THEN NULL ELSE length(CAST(${column} AS BLOB)) END),0)
)`;
const jsonSummary = column => `json_object(
 'nulls',COALESCE(SUM(CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END),0),
 'bytes',COALESCE(SUM(length(CAST(${column} AS BLOB))),0),
 'min_bytes',COALESCE(MIN(CASE WHEN ${column} IS NULL THEN NULL ELSE length(CAST(${column} AS BLOB)) END),0),
 'max_bytes',COALESCE(MAX(CASE WHEN ${column} IS NULL THEN NULL ELSE length(CAST(${column} AS BLOB)) END),0),
 'valid',COALESCE(SUM(CASE WHEN ${column} IS NULL THEN 0 ELSE json_valid(${column}) END),0)
)`;
const numberSummary = column => `json_object(
 'nulls',COALESCE(SUM(CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END),0),
 'min',COALESCE(MIN(${column}),0),
 'max',COALESCE(MAX(${column}),0),
 'sum',COALESCE(SUM(${column}),0)
)`;
const analyticsSummary = (table, key, fields) => `SELECT '${table}' AS table_name,COUNT(*) AS row_count,
COALESCE(SUM(length(CAST(${key} AS BLOB))),0) AS key_bytes,
json_object(${fields.map(([name, kind]) => `'${name}',${kind === 'json' ? jsonSummary(name) : kind === 'number' ? numberSummary(name) : textSummary(name)}`).join(',')}) AS column_summary FROM ${table}`;

// These aggregates deliberately never return an identifier, text value, or JSON
// body. They retain row/byte/null/validity summaries only, so even the 1 MiB
// graph payload column cannot escape through a readback response.
export const TYPED_FORWARD_DATA_INVARIANT_SQL = Object.freeze({
  primary: `SELECT 'participants' AS table_name,COUNT(*) AS row_count,COALESCE(MIN(id),'') AS first_key,COALESCE(MAX(id),'') AS last_key,COALESCE(SUM(length(CAST(id AS TEXT))),0) AS key_bytes FROM participants
UNION ALL SELECT 'telemetry_records',COUNT(*),COALESCE(MIN(id),0),COALESCE(MAX(id),0),COALESCE(SUM(length(CAST(id AS TEXT))),0) FROM telemetry_records
UNION ALL SELECT 'telemetry_v1_records',COUNT(*),COALESCE(MIN(id),0),COALESCE(MAX(id),0),COALESCE(SUM(length(CAST(id AS TEXT))),0) FROM telemetry_v1_records
UNION ALL SELECT 'telemetry_v11_records',COUNT(*),COALESCE(MIN(occurrence_id),''),COALESCE(MAX(occurrence_id),''),COALESCE(SUM(length(CAST(occurrence_id AS TEXT))),0) FROM telemetry_v11_records`,
  analytics: [
    analyticsSummary('analytics_runtime_sources', 'source_id', [
      ['source_id', 'text'], ['source_namespace', 'text'], ['contract_version', 'number'],
    ]),
    analyticsSummary('analytics_community_daily_owners', 'source_id', [
      ['source_id', 'text'], ['day', 'text'], ['owner_digest', 'text'], ['input_revision', 'number'],
      ['owner_revision', 'number'], ['source_format', 'text'], ['method', 'text'],
      ['progress_revision', 'number'], ['next_index', 'number'], ['fingerprint', 'text'],
      ['complete', 'number'], ['values_json', 'json'],
    ]),
    analyticsSummary('analytics_community_graph_results', 'owner_digest', [
      ['source_id', 'text'], ['owner_digest', 'text'], ['metric', 'text'], ['day', 'text'],
      ['method', 'text'], ['dependency_digest', 'text'], ['input_revision', 'number'],
      ['payload_fingerprint', 'text'], ['payload_json', 'json'], ['payload_sha256', 'text'],
      ['authority_json', 'json'], ['computed_ms', 'number'], ['source_kind', 'text'],
    ]),
    analyticsSummary('analytics_cache_retention_day_marks', 'owner_digest', [
      ['mark_key', 'text'], ['source_id', 'text'], ['source_layout', 'text'],
      ['source_namespace', 'text'], ['owner_digest', 'text'], ['device_id', 'text'],
      ['manifest_id', 'text'], ['manifest_digest', 'text'], ['day', 'text'],
      ['method_version', 'text'], ['carry_digest', 'text'], ['carry_days', 'number'],
      ['value_count', 'number'], ['events_read', 'number'], ['unreadable_events', 'number'],
      ['values_digest', 'text'], ['refusal', 'text'],
    ]),
  ].join('\nUNION ALL '),
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

// The active Worker readback uses the same canonical production inventory
// normalisation as the deployment operator.  Keep the full inventory private;
// this digest is the only config material carried into the migration journal.
export function typedForwardWorkerConfigSha256(snapshot) {
  if (!object(snapshot)) fail('INVENTORY_INVALID');
  return productionLiveConfigFingerprint(snapshot);
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

function validateMaintenanceHold(hold, plan = null, now = null) {
  if (!exact(hold, ['schema', 'state', 'revision', 'capturedAt', 'expiresAt', 'holdSha256'])
      || hold.schema !== TYPED_FORWARD_MAINTENANCE_HOLD_SCHEMA || hold.state !== 'contained'
      || !Number.isSafeInteger(hold.revision) || hold.revision < 1
      || !date(hold.capturedAt) || !date(hold.expiresAt)
      || Date.parse(hold.expiresAt) <= Date.parse(hold.capturedAt)
      || Date.parse(hold.expiresAt) - Date.parse(hold.capturedAt) > TYPED_FORWARD_MAX_WINDOW_MS
      || identityDigest({ schema: hold.schema, state: hold.state, revision: hold.revision }) !== hold.holdSha256) fail('MAINTENANCE_HOLD_INVALID');
  if (plan && Date.parse(hold.expiresAt) < Date.parse(plan.expiresAt)) fail('MAINTENANCE_HOLD_EXPIRED');
  if (now !== null && Date.parse(hold.expiresAt) <= now) fail('MAINTENANCE_HOLD_EXPIRED');
  return hold;
}

function validateBackupReceipt(backup, targets, now = null) {
  if (!exact(backup, ['schema', 'provider', 'capturedAt', 'expiresAt', 'targetsSha256', 'targetBookmarks', 'receiptSha256'])
      || backup.schema !== 'typed-forward-backup-receipt-v2' || backup.provider !== 'cloudflare-d1-time-travel'
      || !date(backup.capturedAt) || !date(backup.expiresAt) || Date.parse(backup.expiresAt) <= Date.parse(backup.capturedAt)
      || !SHA256.test(backup.targetsSha256 ?? '') || !SHA256.test(backup.receiptSha256 ?? '')
      || backup.targetsSha256 !== identityDigest(targets.map(target => ({ role: target.role, databaseId: target.databaseId })))
      || !Array.isArray(backup.targetBookmarks) || backup.targetBookmarks.length !== targets.length
      || backup.targetBookmarks.some((bookmark, index) => !exact(bookmark, ['role', 'databaseId', 'bookmark'])
        || bookmark.role !== targets[index]?.role || bookmark.databaseId !== targets[index]?.databaseId
        || typeof bookmark.bookmark !== 'string' || bookmark.bookmark.length < 1 || bookmark.bookmark.length > 256
        || /[\u0000-\u001f\u007f]/u.test(bookmark.bookmark))) fail('BACKUP_RECEIPT_INVALID');
  if (new Set(backup.targetBookmarks.map(bookmark => `${bookmark.role}:${bookmark.databaseId}`)).size !== targets.length) fail('BACKUP_RECEIPT_INVALID');
  const receipt = { schema: backup.schema, provider: backup.provider, capturedAt: backup.capturedAt,
    expiresAt: backup.expiresAt, targetsSha256: backup.targetsSha256, targetBookmarks: backup.targetBookmarks };
  if (identityDigest(receipt) !== backup.receiptSha256) fail('BACKUP_RECEIPT_INVALID');
  if (now !== null && Date.parse(backup.expiresAt) <= now) fail('BACKUP_RECEIPT_EXPIRED');
  return backup;
}

function validateBackupTargetIdentities(targets) {
  if (!Array.isArray(targets) || targets.length !== 2
      || targets[0]?.role !== 'primary' || targets[1]?.role !== 'analytics') fail('BACKUP_CAPTURE_TARGETS_INVALID');
  return targets.map((target, index) => {
    if (!object(target) || !['role', 'binding', 'name', 'databaseId'].every(key => typeof target[key] === 'string')
        || target.role !== ['primary', 'analytics'][index]
        || target.binding !== TYPED_FORWARD_ROLE_BINDINGS[target.role]
        || !NAME.test(target.name) || !UUID.test(target.databaseId)) fail('BACKUP_CAPTURE_TARGETS_INVALID');
    return { role: target.role, binding: target.binding, name: target.name, databaseId: target.databaseId };
  });
}

function backupReceipt({ capturedAt, expiresAt, targetBookmarks }) {
  const receipt = { schema: 'typed-forward-backup-receipt-v2', provider: 'cloudflare-d1-time-travel',
    capturedAt, expiresAt, targetsSha256: identityDigest(targetBookmarks.map(target => ({ role: target.role, databaseId: target.databaseId }))), targetBookmarks };
  return { ...receipt, receiptSha256: identityDigest(receipt) };
}

function validateWorkerInventory(worker) {
  if (!exact(worker, ['sourceCommit', 'versionId', 'configSha256', 'fingerprint'])
      || !COMMIT.test(worker.sourceCommit ?? '') || !UUID.test(worker.versionId ?? '')
      || !SHA256.test(worker.configSha256 ?? '') || !SHA256.test(worker.fingerprint ?? '')) fail('INVENTORY_INVALID');
  return worker;
}

function validateInventory(inventory, plan) {
  if (!exact(inventory, ['capturedAt', 'sourceCommit', 'versionId', 'fingerprint', 'targetsSha256', 'worker', 'maintenanceHold', 'backupReceipt'])
      || !date(inventory.capturedAt) || inventory.sourceCommit !== plan.previousSourceCommit
      || !UUID.test(inventory.versionId ?? '') || !SHA256.test(inventory.fingerprint ?? '') || !SHA256.test(inventory.targetsSha256 ?? '')) fail('INVENTORY_INVALID');
  const expected = plan.targets.map(target => ({ role: target.role, binding: target.binding, name: target.name, databaseId: target.databaseId, bytes: target.bytes }));
  if (identityDigest(expected) !== inventory.targetsSha256) fail('INVENTORY_INVALID');
  validateWorkerInventory(inventory.worker);
  if (inventory.worker.sourceCommit !== plan.previousSourceCommit
      || inventory.versionId !== inventory.worker.versionId || inventory.fingerprint !== inventory.worker.fingerprint) fail('INVENTORY_INVALID');
  validateMaintenanceHold(inventory.maintenanceHold);
  validateBackupReceipt(inventory.backupReceipt, plan.targets);
}

export function validateTypedForwardPlan(plan, { now = Date.now(), allowExpired = false } = {}) {
  if (!exact(plan, ['schema', 'operationId', 'environment', 'accountId', 'workerName', 'previousSourceCommit', 'candidateSourceCommit',
    'createdAt', 'expiresAt', 'operatingCapBytes', 'wranglerSha256', 'rehearsalSha256', 'inventorySha256', 'inventory', 'targets', 'steps'])
      || plan.schema !== TYPED_FORWARD_SCHEMA || !UUID.test(plan.operationId ?? '') || plan.environment !== 'production'
      || !/^[a-f0-9]{32}$/u.test(plan.accountId ?? '') || !/^[A-Za-z0-9_-]{1,63}$/u.test(plan.workerName ?? '')
      || plan.previousSourceCommit !== TYPED_FORWARD_PREVIOUS_SOURCE || !COMMIT.test(plan.candidateSourceCommit ?? '')
      || plan.candidateSourceCommit === plan.previousSourceCommit || !date(plan.createdAt) || !date(plan.expiresAt)
      || Date.parse(plan.createdAt) > now || (!allowExpired && Date.parse(plan.expiresAt) <= now)
      || Date.parse(plan.expiresAt) <= Date.parse(plan.createdAt)
      || Date.parse(plan.expiresAt) - Date.parse(plan.createdAt) > TYPED_FORWARD_MAX_WINDOW_MS
      || plan.operatingCapBytes !== TYPED_FORWARD_OPERATING_CAP_BYTES || !SHA256.test(plan.wranglerSha256 ?? '')
      || !SHA256.test(plan.rehearsalSha256 ?? '') || !SHA256.test(plan.inventorySha256 ?? '')) fail('PLAN_INVALID');
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
    if (!exact(step, ['role', 'binding', 'directory', 'name', 'sha256', 'beforeSchemaSha256', 'afterSchemaSha256', 'dataInvariantSha256', 'statements'])
        || step.role !== expected.role || step.binding !== expected.binding || step.directory !== expected.directory
        || step.name !== expected.name || step.sha256 !== expected.sha256 || !SHA256.test(step.beforeSchemaSha256 ?? '')
        || !SHA256.test(step.afterSchemaSha256 ?? '') || !SHA256.test(step.dataInvariantSha256 ?? '')
        || step.beforeSchemaSha256 !== (previousStep?.afterSchemaSha256 ?? previousByRole[step.role].schemaSha256)
        || !Array.isArray(step.statements) || step.statements.length < 1) fail('STEP_ORDER_INVALID');
    let prior = { schemaSha256: step.beforeSchemaSha256, ledgerSha256: identityDigest(previousStep ? expectedLedger(plan.targets.find(target => target.role === step.role), TYPED_FORWARD_MIGRATIONS.filter(item => item.role === step.role).indexOf(expected)) : previousByRole[step.role].ledger), progressSha256: previousByRole[step.role].dataInvariantSha256 };
    for (const [statementIndex, statement] of step.statements.entries()) {
      if (!exact(statement, ['index', 'kind', 'sha256', 'resultCount', 'atomic', 'beforeSchemaSha256', 'afterSchemaSha256', 'beforeLedgerSha256', 'afterLedgerSha256', 'beforeProgressSha256', 'afterProgressSha256'])
          || statement.index !== statementIndex || !['migration', 'ledger'].includes(statement.kind)
          || !SHA256.test(statement.sha256 ?? '') || !Number.isSafeInteger(statement.resultCount) || statement.resultCount < 1 || statement.resultCount > 512
          || typeof statement.atomic !== 'boolean' || (statement.kind === 'ledger' && (statement.resultCount !== 1 || statement.atomic))
          || (statement.kind === 'migration' && statement.atomic !== (statement.resultCount > 1))
          || !SHA256.test(statement.beforeSchemaSha256 ?? '')
          || !SHA256.test(statement.afterSchemaSha256 ?? '') || !SHA256.test(statement.beforeLedgerSha256 ?? '')
          || !SHA256.test(statement.afterLedgerSha256 ?? '')
          || !(statement.beforeProgressSha256 === null || SHA256.test(statement.beforeProgressSha256))
          || !(statement.afterProgressSha256 === null || SHA256.test(statement.afterProgressSha256))
          || statement.beforeSchemaSha256 !== prior.schemaSha256 || statement.beforeLedgerSha256 !== prior.ledgerSha256
          || statement.beforeProgressSha256 !== prior.progressSha256) fail('STEP_ORDER_INVALID');
      if (statement.kind === 'ledger' && statementIndex !== step.statements.length - 1) fail('STEP_ORDER_INVALID');
      if (statement.kind === 'migration' && statementIndex === step.statements.length - 1) fail('STEP_ORDER_INVALID');
      prior = { schemaSha256: statement.afterSchemaSha256, ledgerSha256: statement.afterLedgerSha256, progressSha256: statement.afterProgressSha256 };
    }
    if (prior.schemaSha256 !== step.afterSchemaSha256 || prior.progressSha256 !== step.dataInvariantSha256) fail('STEP_ORDER_INVALID');
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
        || !SHA256.test(evidence.dataInvariantSha256 ?? '') || !Array.isArray(evidence.ledger)) fail('REHEARSAL_RECEIPT_MISMATCH');
    const expected = TYPED_FORWARD_MIGRATIONS.filter(step => step.role === role);
    const actual = rehearsal.steps.filter(step => step.role === role);
    if (actual.length !== expected.length) fail('REHEARSAL_REQUIRED');
    let before = target.previous.schemaSha256;
    let ledgerSha256 = identityDigest(evidence.ledger);
    for (const [index, step] of actual.entries()) {
      if (!exact(step, ['role', 'binding', 'directory', 'name', 'sha256', 'beforeSchemaSha256', 'afterSchemaSha256', 'dataInvariantSha256', 'statements'])
          || step.role !== role || step.name !== expected[index].name || step.sha256 !== expected[index].sha256
          || step.beforeSchemaSha256 !== before || !SHA256.test(step.afterSchemaSha256 ?? '')
          || !SHA256.test(step.dataInvariantSha256 ?? '') || !Array.isArray(step.statements) || step.statements.length < 2) fail('REHEARSAL_RECEIPT_MISMATCH');
      let beforeStatement = { schemaSha256: step.beforeSchemaSha256, ledgerSha256, progressSha256: evidence.dataInvariantSha256 };
      for (const [statementIndex, statement] of step.statements.entries()) {
        if (!exact(statement, ['index', 'kind', 'sha256', 'resultCount', 'atomic', 'beforeSchemaSha256', 'afterSchemaSha256', 'beforeLedgerSha256', 'afterLedgerSha256', 'beforeProgressSha256', 'afterProgressSha256'])
            || statement.index !== statementIndex || statement.beforeSchemaSha256 !== beforeStatement.schemaSha256
            || statement.beforeLedgerSha256 !== beforeStatement.ledgerSha256 || statement.beforeProgressSha256 !== beforeStatement.progressSha256
            || !SHA256.test(statement.sha256 ?? '') || !Number.isSafeInteger(statement.resultCount) || statement.resultCount < 1 || statement.resultCount > 512
            || typeof statement.atomic !== 'boolean' || (statement.kind === 'ledger' && (statement.resultCount !== 1 || statement.atomic))
            || (statement.kind === 'migration' && statement.atomic !== (statement.resultCount > 1))
            || !SHA256.test(statement.beforeSchemaSha256 ?? '')
            || !SHA256.test(statement.afterSchemaSha256 ?? '') || !SHA256.test(statement.beforeLedgerSha256 ?? '')
            || !SHA256.test(statement.afterLedgerSha256 ?? '')
            || !(statement.beforeProgressSha256 === null || SHA256.test(statement.beforeProgressSha256))
            || !(statement.afterProgressSha256 === null || SHA256.test(statement.afterProgressSha256))) fail('REHEARSAL_RECEIPT_MISMATCH');
        beforeStatement = { schemaSha256: statement.afterSchemaSha256, ledgerSha256: statement.afterLedgerSha256, progressSha256: statement.afterProgressSha256 };
      }
      if (beforeStatement.schemaSha256 !== step.afterSchemaSha256 || beforeStatement.progressSha256 !== step.dataInvariantSha256) fail('REHEARSAL_RECEIPT_MISMATCH');
      ledgerSha256 = beforeStatement.ledgerSha256;
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

function bindRehearsalStepToLiveTarget(rehearsalStep, rehearsalTarget, target, expected, startingLedger = target.previous.ledger) {
  let ledger = startingLedger;
  let progress = target.previous.dataInvariantSha256;
  const statements = rehearsalStep.statements.map((statement, index) => {
    const afterLedger = statement.kind === 'ledger'
      ? [...ledger, { name: expected.name, sha256: expected.sha256 }]
      : ledger;
    const afterProgress = statement.afterProgressSha256 === null ? null : target.previous.dataInvariantSha256;
    const bound = { ...statement, index, beforeLedgerSha256: identityDigest(ledger), afterLedgerSha256: identityDigest(afterLedger),
      beforeProgressSha256: statement.beforeProgressSha256 === null ? null : progress,
      afterProgressSha256: afterProgress };
    ledger = afterLedger;
    progress = afterProgress;
    return bound;
  });
  const first = statements[0], last = statements.at(-1);
  if (!first || !last || first.beforeSchemaSha256 !== (rehearsalStep.beforeSchemaSha256)
      || last.afterSchemaSha256 !== rehearsalStep.afterSchemaSha256
      || last.afterProgressSha256 !== target.previous.dataInvariantSha256) fail('REHEARSAL_RECEIPT_MISMATCH');
  return { ...rehearsalStep, beforeSchemaSha256: rehearsalStep.beforeSchemaSha256, afterSchemaSha256: rehearsalStep.afterSchemaSha256,
    dataInvariantSha256: target.previous.dataInvariantSha256, statements };
}

export async function prepareTypedForwardPlan({ workerRoot, accountId, workerName, candidateSourceCommit, inventory, targets,
  rehearsal, wranglerSha256, createdAt = new Date().toISOString(), expiresAt = new Date(Date.parse(createdAt) + 86_400_000).toISOString(),
  inventorySha256, operationId = randomUUID(), previousSourceCommit = TYPED_FORWARD_PREVIOUS_SOURCE,
  repositoryRoot = resolve(workerRoot, '../..'), checkSource = null, now = Date.now() }) {
  if (typeof workerRoot !== 'string' || !Array.isArray(targets) || targets.length !== 2 || !object(rehearsal)) fail('PLAN_INPUT_INVALID');
  validateCommit(candidateSourceCommit);
  if (!SHA256.test(inventorySha256 ?? '')) fail('INVENTORY_INVALID');
  if (previousSourceCommit !== TYPED_FORWARD_PREVIOUS_SOURCE) fail('PREVIOUS_SOURCE_INVALID');
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
    const target = targets.find(item => item.role === expected.role);
    const rehearsalTarget = rehearsal.targets[expected.role];
    const startingLedger = [...target.previous.ledger, ...TYPED_FORWARD_MIGRATIONS.filter(item => item.role === expected.role)
      .slice(0, TYPED_FORWARD_MIGRATIONS.filter(item => item.role === expected.role).indexOf(expected)).map(item => ({ name: item.name, sha256: item.sha256 }))];
    const bound = bindRehearsalStepToLiveTarget(result, rehearsalTarget, target, expected, startingLedger);
    if (bound.beforeSchemaSha256 !== (prior?.afterSchemaSha256 ?? previousByRole[expected.role]?.schemaSha256)) fail('REHEARSAL_RECEIPT_MISMATCH');
    steps.push({ ...expected, beforeSchemaSha256: bound.beforeSchemaSha256, afterSchemaSha256: bound.afterSchemaSha256,
      dataInvariantSha256: bound.dataInvariantSha256, statements: bound.statements });
  }
  const plan = { schema: TYPED_FORWARD_SCHEMA, operationId, environment: 'production', accountId, workerName,
    previousSourceCommit, candidateSourceCommit, createdAt, expiresAt, operatingCapBytes: TYPED_FORWARD_OPERATING_CAP_BYTES,
    wranglerSha256, rehearsalSha256: identityDigest(rehearsal), inventorySha256, inventory, targets, steps };
  validateTypedForwardPlan(plan, { now });
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
  const migrations = localLedger(database);
  let dataInvariantSha256 = null;
  try { dataInvariantSha256 = localDataInvariant(database, role); } catch (error) {
    if (!/no such table|no such column/iu.test(String(error?.message ?? ''))) throw error;
  }
  return { schemaSha256: storageSchemaDigest(rows), migrations, ledgerSha256: identityDigest(migrations), dataInvariantSha256,
    bytes: database.prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get().bytes };
}

async function splitSqlStatements(workerRoot, sql) {
  const root = await realpath(resolve(workerRoot));
  const requireFromWorker = createRequire(join(root, 'package.json'));
  let splitter;
  try { splitter = requireFromWorker('wrangler').unstable_splitSqlQuery; } catch { fail('SQL_SPLITTER_UNAVAILABLE'); }
  if (typeof splitter !== 'function') fail('SQL_SPLITTER_UNAVAILABLE');
  const statements = splitter(sql).map(statement => String(statement).trim()).filter(Boolean);
  if (statements.length < 1 || statements.length > 512 || statements.some(statement => Buffer.byteLength(statement) > 240 * 1024)) fail('SOURCE_FILE_UNSAFE');
  return statements;
}

function deriveMigrationOperations(statements) {
  const operations = [];
  let foreignKeysOff = false;
  let foreignKeyRegion = [];
  const flushForeignKeyRegion = () => {
    if (!foreignKeyRegion.length) fail('SOURCE_FILE_UNSAFE');
    operations.push({
      // D1 runs every query in an implicit transaction.  The old migration
      // files used foreign_keys=OFF, which D1 rejects; defer the constraints
      // for the complete rebuild batch instead of splitting this region.
      sql: `PRAGMA defer_foreign_keys = ON;\n${foreignKeyRegion.map(statement => `${statement};`).join('\n')}`,
      resultCount: foreignKeyRegion.length + 1,
      atomic: true,
    });
    foreignKeyRegion = [];
  };
  for (const statement of statements) {
    const normalizedStatement = statement.replace(/;\s*$/u, '').trim().toLowerCase();
    if (/^pragma\s+foreign_keys\s*=\s*off$/u.test(normalizedStatement)) {
      if (foreignKeysOff) fail('SOURCE_FILE_UNSAFE');
      foreignKeysOff = true;
      continue;
    }
    if (/^pragma\s+foreign_keys\s*=\s*on$/u.test(normalizedStatement)) {
      if (foreignKeysOff) flushForeignKeyRegion();
      // A standalone ON is an explicit connection-state assertion (0008); it
      // does not carry a remote operation.
      foreignKeysOff = false;
      continue;
    }
    if (foreignKeysOff) foreignKeyRegion.push(statement);
    else operations.push({ sql: statement, resultCount: 1, atomic: false });
  }
  if (foreignKeysOff || operations.length < 1 || operations.length > 512) fail('SOURCE_FILE_UNSAFE');
  return operations;
}

export async function plannedMigrationOperations(workerRoot, step) {
  return deriveMigrationOperations(await splitSqlStatements(workerRoot, await safeSql(workerRoot, step)));
}

function ledgerStatementSql(step) {
  return `INSERT INTO d1_storage_migrations(name,sha256) VALUES('${step.name}','${step.sha256}');`;
}

function statementCheckpoint({ index, kind, sql, resultCount = 1, atomic = false, before, after }) {
  return { index, kind, sha256: storageSha256(sql), resultCount, atomic,
    beforeSchemaSha256: before.schemaSha256, afterSchemaSha256: after.schemaSha256,
    beforeLedgerSha256: before.ledgerSha256, afterLedgerSha256: after.ledgerSha256,
    beforeProgressSha256: before.dataInvariantSha256, afterProgressSha256: after.dataInvariantSha256 };
}

async function applyDirectory(database, workerRoot, directory, until = null) {
  const names = (await readdir(join(workerRoot, directory))).filter(name => name.endsWith('.sql')).sort();
  for (const name of names) {
    if (until !== null && name >= until) break;
    database.exec(await readFile(join(workerRoot, directory, name), 'utf8'));
  }
}
async function populatedRehearsalDatabases(workerRoot, { largePayload = false } = {}) {
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
  analytics.prepare(`INSERT INTO analytics_community_graph_results(source_id,owner_digest,metric,day,method,dependency_digest,input_revision,payload_fingerprint,payload_json,payload_sha256,authority_json,computed_ms,source_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'synthetic-forward-source', 'a'.repeat(64), 'model', '2026-01-01', 'synthetic-forward', 'b'.repeat(64), 1, 'c'.repeat(64),
    largePayload ? JSON.stringify({ pad: 'x'.repeat(1_047_000) }) : '{"model":"synthetic"}', 'd'.repeat(64), '{"policyRevision":1}', 12, 'v1.1');
  analytics.exec(`INSERT INTO analytics_cache_retention_day_marks(mark_key,source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,day,method_version,carry_digest,carry_days,value_count,events_read,unreadable_events,values_digest,refusal) VALUES ('${'e'.repeat(64)}','synthetic-forward-source','typed-v11','synthetic-forward-namespace','${'a'.repeat(64)}','synthetic-device','synthetic-manifest','${'f'.repeat(64)}','2026-01-01','cache-retention-v2','${'1'.repeat(64)}',0,0,0,0,'${'2'.repeat(64)}',NULL);`);
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

export async function rehearseTypedForwardMigration({ workerRoot, injectFailureAt = null, injectForeignKeyViolationAt = null, largePayload = false } = {}) {
  if (typeof workerRoot !== 'string') fail('REHEARSAL_INPUT_INVALID');
  const root = await realpath(resolve(workerRoot));
  const { primary, analytics } = await populatedRehearsalDatabases(root, { largePayload });
  const databases = { primary, analytics };
  const before = {};
  const steps = [];
  try {
    for (const role of ['primary', 'analytics']) {
      before[role] = localInspect(databases[role], role);
      let prior = before[role];
      for (const expected of TYPED_FORWARD_MIGRATIONS.filter(step => step.role === role)) {
        const sql = await safeSql(root, expected);
        const statements = deriveMigrationOperations(await splitSqlStatements(root, sql));
        const beforeSchemaSha256 = localInspect(databases[role], role).schemaSha256;
        if (beforeSchemaSha256 !== prior.schemaSha256) fail('REHEARSAL_SCHEMA_CHAIN_INVALID');
        const checkpoints = [];
        if (injectFailureAt === `${role}:${expected.name}`) fail('INJECTED_REHEARSAL_FAILURE');
        for (const [statementIndex, statement] of statements.entries()) {
          const beforeStatement = localInspect(databases[role], role);
          let committed = false;
          try {
            // Every derived operation is its own local transaction.  The
            // coalesced defer_foreign_keys region is therefore checked at the
            // same end-of-transaction boundary as a D1 implicit transaction.
            databases[role].exec('BEGIN');
            databases[role].exec(statement.sql);
            if (injectForeignKeyViolationAt === `${role}:${expected.name}:${statementIndex}`) {
              if (role !== 'analytics' || expected.name !== '0025_effective_graph_source.sql') fail('REHEARSAL_INPUT_INVALID');
              databases[role].exec("CREATE TABLE typed_forward_fk_probe (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id)) STRICT; INSERT INTO typed_forward_fk_probe(id,source_id) VALUES ('probe','missing-source');");
            }
            const violations = databases[role].prepare('PRAGMA foreign_key_check').all();
            if (violations.length) fail('REHEARSAL_FOREIGN_KEY_FAILED');
            if (injectFailureAt === `${role}:${expected.name}:after:${statementIndex}`) fail('INJECTED_REHEARSAL_FAILURE');
            databases[role].exec('COMMIT');
            committed = true;
            // This models a provider response lost after the D1 implicit
            // transaction committed.  The operation runner exercises the
            // corresponding read-first reconciliation path with its injected
            // adapter; this hook keeps the local rehearsal boundary explicit.
            if (injectFailureAt === `${role}:${expected.name}:after-commit:${statementIndex}`) fail('INJECTED_REHEARSAL_FAILURE');
          } catch (error) {
            if (!committed) {
              try { databases[role].exec('ROLLBACK'); } catch {}
              const restored = localInspect(databases[role], role);
              if (restored.schemaSha256 !== beforeStatement.schemaSha256 || restored.dataInvariantSha256 !== beforeStatement.dataInvariantSha256
                  || !sameRows(restored.migrations, beforeStatement.migrations)) fail('REHEARSAL_ROLLBACK_FAILED');
            }
            throw error;
          }
          const afterStatement = localInspect(databases[role], role);
          checkpoints.push(statementCheckpoint({ index: statementIndex, kind: 'migration', sql: statement.sql,
            resultCount: statement.resultCount, atomic: statement.atomic, before: beforeStatement, after: afterStatement }));
        }
        // The ledger receipt is a separate transaction and checkpoint.  A
        // migration prefix may therefore be safely resumed without inventing
        // a ledger row for a statement that never committed.
        const beforeLedger = localInspect(databases[role], role);
        try {
          databases[role].exec('BEGIN');
          databases[role].prepare('INSERT INTO d1_storage_migrations(name,sha256) VALUES(?,?)').run(expected.name, expected.sha256);
          const violations = databases[role].prepare('PRAGMA foreign_key_check').all();
          if (violations.length) fail('REHEARSAL_FOREIGN_KEY_FAILED');
          databases[role].exec('COMMIT');
        } catch (error) {
          try { databases[role].exec('ROLLBACK'); } catch {}
          const restored = localInspect(databases[role], role);
          if (restored.schemaSha256 !== beforeLedger.schemaSha256 || restored.dataInvariantSha256 !== beforeLedger.dataInvariantSha256
              || !sameRows(restored.migrations, beforeLedger.migrations)) fail('REHEARSAL_ROLLBACK_FAILED');
          throw error;
        }
        assertMappedColumns(databases[role], role, expected);
        assertSemanticMappings(databases[role], role, expected);
        const afterLedger = localInspect(databases[role], role);
        checkpoints.push(statementCheckpoint({ index: checkpoints.length, kind: 'ledger', sql: ledgerStatementSql(expected), before: beforeLedger, after: afterLedger }));
        const after = localInspect(databases[role], role);
        if (after.migrations.at(-1)?.name !== expected.name || after.migrations.at(-1)?.sha256 !== expected.sha256
            || after.dataInvariantSha256 !== prior.dataInvariantSha256 || !checkpoints.length
            || checkpoints.at(-1).afterProgressSha256 !== after.dataInvariantSha256) fail('REHEARSAL_PRESERVATION_FAILED');
        steps.push({ role, binding: expected.binding, directory: expected.directory, name: expected.name, sha256: expected.sha256,
          beforeSchemaSha256, afterSchemaSha256: after.schemaSha256, dataInvariantSha256: after.dataInvariantSha256, statements: checkpoints });
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
  if (!object(value) || !SHA256.test(value.schemaSha256 ?? '') || !(value.dataInvariantSha256 === null || SHA256.test(value.dataInvariantSha256 ?? ''))
      || !SHA256.test(value.ledgerSha256 ?? '')
      || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || !Array.isArray(value.migrations) || value.migrations.length > 128
      || value.migrations.some(row => !exact(row, ['name', 'sha256']) || !SQL_NAME.test(row.name ?? '') || !SHA256.test(row.sha256 ?? ''))) fail('SCHEMA_READBACK_INVALID');
  if (identityDigest(value.migrations) !== value.ledgerSha256) fail('SCHEMA_READBACK_INVALID');
  return value;
}
function validateInspection(value, target, expectedLedgerRows = null) {
  validateInspectionShape(value);
  const ledger = expectedLedgerRows ?? target.previous.ledger;
  if (!sameRows(value.migrations, ledger)) fail('LEDGER_PREFIX_DRIFT');
  if (value.dataInvariantSha256 !== null && expectedLedgerRows === null && value.dataInvariantSha256 !== target.previous.dataInvariantSha256) fail('DATA_INVARIANT_DRIFT');
  return value;
}

function validateState(state, plan, now = Date.now()) {
  if (!object(state) || Object.keys(state).some(key => !['schema', 'status', 'owner', 'targets', 'approvalExtensions', 'lastFailure', 'lastFailureDiagnostics'].includes(key))
      || !['schema', 'status', 'owner', 'targets', 'approvalExtensions'].every(key => Object.hasOwn(state, key))
      || state.schema !== TYPED_FORWARD_OPERATION_SCHEMA
      || !COMMIT.test(plan.candidateSourceCommit) || !/^[a-f0-9]{40}$/u.test(state.owner ?? '')
      || !['lock_intent', 'running', 'release_intent', 'completed'].includes(state.status) || !object(state.targets)
      || (state.lastFailure !== undefined && !/^TYPED_FORWARD_[A-Z_]+$/u.test(state.lastFailure))
      || (state.lastFailureDiagnostics !== undefined && (!object(state.lastFailureDiagnostics)
        || !exact(state.lastFailureDiagnostics, ['classification', 'file', 'sha256'])
        || typeof state.lastFailureDiagnostics.classification !== 'string' || state.lastFailureDiagnostics.classification.length > 64
        || typeof state.lastFailureDiagnostics.file !== 'string' || state.lastFailureDiagnostics.file.length > 256
        || !SHA256.test(state.lastFailureDiagnostics.sha256 ?? '')))) fail('OPERATION_STATE_INVALID');
  if (!Array.isArray(state.approvalExtensions) || state.approvalExtensions.length > 32) fail('OPERATION_STATE_INVALID');
  for (const extension of state.approvalExtensions) validateApprovalExtension(extension, identityDigest(plan), null, now, true);
  if (Object.keys(state.targets).some(binding => !plan.targets.some(target => target.binding === binding))) fail('OPERATION_STATE_INVALID');
  for (const target of plan.targets) {
    const row = state.targets[target.binding];
    const count = TYPED_FORWARD_MIGRATIONS.filter(step => step.role === target.role).length;
    if (row !== undefined && (!exact(row, ['status', 'applied', 'statementIndex', 'intent']) || !['pending', 'migrated', 'statement_intent'].includes(row.status)
      || !Number.isSafeInteger(row.applied) || row.applied < 0 || row.applied > count
      || !Number.isSafeInteger(row.statementIndex) || row.statementIndex < 0
      || !(row.intent === null || (object(row.intent) && Number.isSafeInteger(row.intent.stepIndex) && row.intent.stepIndex >= 0
        && row.intent.stepIndex < count && Number.isSafeInteger(row.intent.statementIndex) && row.intent.statementIndex >= 0))
      || (row.status === 'statement_intent' && row.intent === null)
      || (row.status !== 'statement_intent' && row.intent !== null)
      || (row.status === 'statement_intent' && (row.intent.stepIndex !== row.applied || row.intent.statementIndex !== row.statementIndex))
      || (row.status === 'migrated' && row.statementIndex !== 0))) fail('OPERATION_STATE_INVALID');
    const step = row && row.applied < count ? expectedStep(plan, target.role, row.applied) : null;
    if (step && row.statementIndex > step.statements.length) fail('OPERATION_STATE_INVALID');
  }
  return state;
}

function validateApprovalExtension(extension, planSha256, previousExtensionSha256, now, allowExpired = false) {
  if (!exact(extension, ['schema', 'planSha256', 'previousExtensionSha256', 'approvedAt', 'expiresAt'])
      || extension.schema !== 'd1-storage-approval-extension-v1' || extension.planSha256 !== planSha256
      || (previousExtensionSha256 === null && extension.previousExtensionSha256 !== null)
      || (previousExtensionSha256 !== null && extension.previousExtensionSha256 !== previousExtensionSha256)
      || !date(extension.approvedAt) || !date(extension.expiresAt)
      || Date.parse(extension.approvedAt) > now || Date.parse(extension.expiresAt) <= Date.parse(extension.approvedAt)
      || Date.parse(extension.expiresAt) - Date.parse(extension.approvedAt) > TYPED_FORWARD_MAX_WINDOW_MS
      || (!allowExpired && Date.parse(extension.expiresAt) <= now)) fail('APPROVAL_EXTENSION_INVALID');
  return extension;
}

function resolveTypedForwardApproval({ plan, state, extension, approvedExtensionSha256, now }) {
  const planSha256 = identityDigest(plan);
  const chain = Array.isArray(state.approvalExtensions) ? [...state.approvalExtensions] : [];
  let previous = null;
  for (const current of chain) {
    validateApprovalExtension(current, planSha256, previous, now, true);
    previous = identityDigest(current);
  }
  if (extension !== null && extension !== undefined) {
    if (!approvedExtensionSha256 || identityDigest(extension) !== approvedExtensionSha256) fail('APPROVAL_EXTENSION_NOT_APPROVED');
    validateApprovalExtension(extension, planSha256, previous, now);
    chain.push(extension);
  }
  const deadline = chain.length ? Date.parse(chain.at(-1).expiresAt) : Date.parse(plan.expiresAt);
  return { chain, active: deadline > now };
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

function expectedStatementLedger(target, step, statement, after) {
  const roleIndex = TYPED_FORWARD_MIGRATIONS.filter(item => item.role === target.role).findIndex(item => item.name === step.name);
  return expectedLedger(target, roleIndex + (after && statement.kind === 'ledger' ? 1 : 0));
}

function assertStatementObservation(value, target, step, statement, after) {
  const expectedLedgerRows = expectedStatementLedger(target, step, statement, after);
  validateInspection(value, target, expectedLedgerRows);
  const schemaSha256 = after ? statement.afterSchemaSha256 : statement.beforeSchemaSha256;
  const progressSha256 = after ? statement.afterProgressSha256 : statement.beforeProgressSha256;
  if (value.schemaSha256 !== schemaSha256 || value.ledgerSha256 !== (after ? statement.afterLedgerSha256 : statement.beforeLedgerSha256)
      || value.dataInvariantSha256 !== progressSha256) fail('MIGRATION_RESULT_UNCERTAIN');
}

async function statementSql(step, statement, workerRoot) {
  if (statement.kind === 'ledger') return ledgerStatementSql(step);
  const operations = await plannedMigrationOperations(workerRoot, step);
  const operation = operations[statement.index];
  if (!operation || storageSha256(operation.sql) !== statement.sha256
      || operation.resultCount !== statement.resultCount || operation.atomic !== statement.atomic) fail('SOURCE_CHANGED');
  return operation.sql;
}

export async function runTypedForwardMigration({ plan, workerRoot, repositoryRoot, operationDirectory, execute = false, resume = false,
  confirmation = null, approvedPlanSha256 = null, extension = null, approvedExtensionSha256 = null, now = undefined, clock = null, adapterFactory = null,
  lockFactory = ({ repositoryRoot: root }) => createProductionDeploymentLock({ repositoryRoot: root }), checkSource = null }) {
  if (clock !== null && typeof clock !== 'function') fail('EXECUTE_NOT_APPROVED');
  const currentNow = () => clock === null ? (now === undefined ? Date.now() : now) : clock();
  const prepared = validateTypedForwardPlan(plan, { now: currentNow(), allowExpired: execute && resume });
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
    if (resume) validateState(state, prepared, currentNow());
    else {
      const owner = await lock.createOwner({ id: operation.record.id, sourceCommit: prepared.candidateSourceCommit, previousSourceCommit: prepared.previousSourceCommit });
      state = { schema: TYPED_FORWARD_OPERATION_SCHEMA, status: 'lock_intent', owner, targets: {}, approvalExtensions: [] };
      await operation.save(state);
    }
    const approval = resolveTypedForwardApproval({ plan: prepared, state, extension, approvedExtensionSha256, now: currentNow() });
    if (extension !== null && extension !== undefined) {
      state.approvalExtensions = approval.chain;
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
    const assertSafety = async ({ write = false } = {}) => {
      // The source pin is mandatory at every mutation boundary.  An injected
      // check may add an independent review, but it cannot replace this local
      // clean-HEAD assertion.
      assertCleanSource(repositoryRoot, prepared.candidateSourceCommit);
      if (typeof checkSource === 'function') await checkSource(prepared.candidateSourceCommit);
      await lock.assertOwned(state.owner);
      const boundaryNow = currentNow();
      const currentPlan = validateTypedForwardPlan(prepared, { now: boundaryNow, allowExpired: true });
      if (identityDigest(currentPlan) !== planSha256) fail('PLAN_CHANGED');
      const readOnlyReconciliation = resume && !write;
      if (typeof adapter.assertMaintenanceHold !== 'function') fail('MAINTENANCE_HOLD_UNVERIFIED');
      await adapter.assertMaintenanceHold(prepared.inventory.maintenanceHold);
      validateMaintenanceHold(prepared.inventory.maintenanceHold, null, readOnlyReconciliation ? null : boundaryNow);
      if (typeof adapter.activeWorker !== 'function') fail('ACTIVE_WORKER_UNVERIFIED');
      const activeWorker = await adapter.activeWorker();
      validateWorkerInventory(activeWorker);
      if (identityDigest(activeWorker) !== identityDigest(prepared.inventory.worker)
          || activeWorker.sourceCommit !== prepared.inventory.sourceCommit
          || activeWorker.versionId !== prepared.inventory.versionId
          || activeWorker.fingerprint !== prepared.inventory.fingerprint) fail('ACTIVE_WORKER_DRIFT');
      if (typeof adapter.verifyBackupReceipt !== 'function') fail('BACKUP_RECEIPT_UNVERIFIED');
      await adapter.verifyBackupReceipt(prepared.inventory.backupReceipt, prepared.targets, boundaryNow, { allowExpired: readOnlyReconciliation });
      validateBackupReceipt(prepared.inventory.backupReceipt, prepared.targets, readOnlyReconciliation ? null : boundaryNow);
      if (write && !resolveTypedForwardApproval({ plan: prepared, state, extension: null, approvedExtensionSha256: null, now: boundaryNow }).active) fail('APPROVAL_EXPIRED');
    };
    await assertSafety();
    for (const target of prepared.targets) {
      const count = TYPED_FORWARD_MIGRATIONS.filter(step => step.role === target.role).length;
      let receipt = state.targets[target.binding] ?? { status: 'pending', applied: 0, statementIndex: 0, intent: null };
      state.targets[target.binding] = receipt; await operation.save(state);
      await assertSafety();
      const inventory = await adapter.inventory(target);
      if (!Array.isArray(inventory) || inventory.length !== 1 || inventory[0]?.id !== target.databaseId || inventory[0]?.name !== target.name
          || !Number.isSafeInteger(inventory[0].bytes) || inventory[0].bytes < target.bytes
          || inventory[0].bytes + target.migrationGrowthBudgetBytes >= TYPED_FORWARD_OPERATING_CAP_BYTES) fail('RESOURCE_DRIFT');
      if (receipt.applied === 0 && receipt.statementIndex === 0 && receipt.intent === null && inventory[0].bytes !== target.bytes) fail('RESOURCE_DRIFT');
      let observed = validateInspectionShape(await adapter.inspect(target));
      if (receipt.intent !== null) {
        const step = expectedStep(prepared, target.role, receipt.intent.stepIndex);
        const statement = step.statements[receipt.intent.statementIndex];
        if (!statement) fail('OPERATION_STATE_INVALID');
        try { assertStatementObservation(observed, target, step, statement, true); }
        catch (error) {
          try { assertStatementObservation(observed, target, step, statement, false); }
          catch { throw error; }
          receipt = { status: 'pending', applied: receipt.applied, statementIndex: receipt.intent.statementIndex, intent: null };
          state.targets[target.binding] = receipt; await operation.save(state);
        }
        if (receipt.intent !== null) {
          const completedStep = statement.kind === 'ledger';
          receipt = completedStep
            ? { status: 'migrated', applied: receipt.applied + 1, statementIndex: 0, intent: null }
            : { status: 'pending', applied: receipt.applied, statementIndex: receipt.intent.statementIndex + 1, intent: null };
          state.targets[target.binding] = receipt; await operation.save(state);
        }
      } else if (receipt.applied < count && receipt.statementIndex > 0) {
        const step = expectedStep(prepared, target.role, receipt.applied);
        const priorStatement = step.statements[receipt.statementIndex - 1];
        if (!priorStatement) fail('OPERATION_STATE_INVALID');
        assertStatementObservation(observed, target, step, priorStatement, true);
      } else {
        validateInspection(observed, target, expectedLedger(target, receipt.applied));
      }
      while (receipt.applied < count) {
        const step = expectedStep(prepared, target.role, receipt.applied);
        while (receipt.statementIndex < step.statements.length) {
          const statement = step.statements[receipt.statementIndex];
          await assertSafety({ write: true });
          const info = (await adapter.inventory(target))?.[0];
          if (!info || info.id !== target.databaseId || info.name !== target.name || !Number.isSafeInteger(info.bytes)
              || info.bytes < target.bytes || info.bytes + target.migrationGrowthBudgetBytes >= TYPED_FORWARD_OPERATING_CAP_BYTES) fail('OPERATING_CAP_EXCEEDED');
          observed = validateInspectionShape(await adapter.inspect(target));
          assertStatementObservation(observed, target, step, statement, false);
          const sql = await statementSql(step, statement, workerRoot);
          receipt = { status: 'statement_intent', applied: receipt.applied, statementIndex: statement.index,
            intent: { stepIndex: receipt.applied, statementIndex: statement.index } };
          state.targets[target.binding] = receipt; await operation.save(state);
          await assertSafety({ write: true });
          try { await adapter.migrateStatement(target, { ...step, ...statement, sql, stepIndex: receipt.applied, statementIndex: statement.index }); }
          catch (error) {
            const uncertain = operationError('TYPED_FORWARD_MIGRATION_RESULT_UNCERTAIN');
            if (object(error?.diagnostics)) uncertain.diagnostics = error.diagnostics;
            throw uncertain;
          }
          observed = validateInspectionShape(await adapter.inspect(target));
          assertStatementObservation(observed, target, step, statement, true);
          if (typeof adapter.foreignKeyCheck !== 'function') fail('FOREIGN_KEY_READBACK_UNVERIFIED');
          const violations = await adapter.foreignKeyCheck(target);
          if ((Array.isArray(violations) && violations.length > 1024)
              || (!Array.isArray(violations) && !Number.isSafeInteger(violations))) fail('FOREIGN_KEY_READBACK_INVALID');
          if ((Array.isArray(violations) && violations.length > 0) || violations > 0) fail('FOREIGN_KEY_READBACK_FAILED');
          receipt = statement.kind === 'ledger'
            ? { status: 'migrated', applied: receipt.applied + 1, statementIndex: 0, intent: null }
            : { status: 'pending', applied: receipt.applied, statementIndex: receipt.statementIndex + 1, intent: null };
          state.targets[target.binding] = receipt; await operation.save(state);
          if (statement.kind === 'ledger') break;
        }
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
// It uses the existing pinned Wrangler query launcher, a fixed account, fixed
// binding IDs, and one bounded query per journaled statement. It never discovers
// a database by name and it never creates a missing d1_storage_migrations table.
export async function createTypedForwardWranglerAdapter({ plan, operationDirectory, cliPath, spawn = spawnSync,
  activeWorkerReader = null, backupVerifier = null, liveProviderFactory = createProductionLiveProvider,
  liveConfigSnapshot = createProductionLiveConfigSnapshot }) {
  if (!plan || typeof operationDirectory !== 'string' || typeof cliPath !== 'string') fail('TRANSPORT_INPUT_INVALID');
  if (activeWorkerReader !== null && typeof activeWorkerReader !== 'function') fail('TRANSPORT_INPUT_INVALID');
  if (backupVerifier !== null && typeof backupVerifier !== 'function') fail('TRANSPORT_INPUT_INVALID');
  if (typeof liveProviderFactory !== 'function' || typeof liveConfigSnapshot !== 'function') fail('TRANSPORT_INPUT_INVALID');
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
  const readMutation = async (target, sql, expectedResultCount) => {
    if (!Number.isSafeInteger(expectedResultCount) || expectedResultCount < 1 || expectedResultCount > 512) fail('MIGRATION_NOT_PLANNED');
    const sqlBytes = Buffer.from(sql), configPath = await config(target), sqlPath = await privateFile(join(root, `mutation-${sequence++}.sql`), sqlBytes);
    const invocation = createWranglerQueryInvocation({ cliPath, configPath, binding: target.binding, databaseId: target.databaseId, mode: 'remote', sqlPath, expectedSqlSha256: storageSha256(sqlBytes) });
    let value;
    const output = await run(invocation.args, target);
    try { value = JSON.parse(output); } catch { fail('MIGRATION_RESULT_INVALID'); }
    if (!Array.isArray(value) || value.length !== expectedResultCount || value.some(result => result?.success !== true
        || !Array.isArray(result.results) || result.results.length > 4096 || result.results.some(row => !object(row)
          || Object.keys(row).length > 64 || JSON.stringify(row).length > 128 * 1024))) fail('MIGRATION_RESULT_INVALID');
    return value;
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
  const assertMaintenanceHold = async hold => {
    validateMaintenanceHold(hold);
    const rows = await readQuery(plan.targets[0], `SELECT schema_version,control_state,revision,enrollment_enabled,upload_registration_enabled,processing_enabled,publication_enabled FROM collection_controls WHERE singleton=1`);
    if (rows.length !== 1 || rows[0].schema_version !== 'collection-controls-v0.1' || rows[0].control_state !== 'contained'
        || rows[0].revision !== hold.revision || ![rows[0].enrollment_enabled, rows[0].upload_registration_enabled,
          rows[0].processing_enabled, rows[0].publication_enabled].every(value => value === 0)) fail('MAINTENANCE_HOLD_DRIFT');
  };
  let liveProvider = null;
  const activeWorker = async () => {
    if (activeWorkerReader !== null) {
      const value = await activeWorkerReader({ readOnly: true });
      validateWorkerInventory(value);
      return value;
    }
    liveProvider ??= liveProviderFactory({ accountId: plan.accountId, workerName: plan.workerName });
    let snapshot;
    try { snapshot = liveConfigSnapshot(await liveProvider.capture()); }
    catch (error) {
      if (/^PRODUCTION_LIVE_[A-Z_]+$|^PRODUCTION_LIVE_CONFIG_[A-Z_]+$/u.test(error?.code ?? '')) throw error;
      fail('ACTIVE_WORKER_UNVERIFIED');
    }
    const value = { sourceCommit: snapshot.sourceCommit, versionId: snapshot.versionId,
      configSha256: typedForwardWorkerConfigSha256(snapshot), fingerprint: snapshot.fingerprint };
    validateWorkerInventory(value);
    return value;
  };
  const readTimeTravelBookmark = async (target, capturedAt) => {
    const configPath = await config(target);
    const output = await run([
      cli.canonical, 'd1', 'time-travel', 'info', target.binding,
      `--timestamp=${capturedAt}`, '--json', '--config', configPath,
    ], target);
    let value;
    try { value = JSON.parse(output); } catch { fail('BACKUP_RECEIPT_UNVERIFIED'); }
    if (!object(value) || Object.keys(value).some(key => key !== 'bookmark')
        || typeof value.bookmark !== 'string' || value.bookmark.length < 1 || value.bookmark.length > 256
        || /[\u0000-\u001f\u007f]/u.test(value.bookmark)) fail('BACKUP_RECEIPT_UNVERIFIED');
    return value.bookmark;
  };
  const captureBackup = async (targets, capturedAt, expiresAt, now = Date.now()) => {
    const identities = validateBackupTargetIdentities(targets);
    if (!date(capturedAt) || !date(expiresAt) || Date.parse(capturedAt) > now || Date.parse(expiresAt) <= now
        || Date.parse(expiresAt) <= Date.parse(capturedAt)
        || Date.parse(expiresAt) - Date.parse(capturedAt) > TYPED_FORWARD_MAX_WINDOW_MS) fail('BACKUP_CAPTURE_TIME_INVALID');
    const targetBookmarks = [];
    for (const target of identities) targetBookmarks.push({ role: target.role, databaseId: target.databaseId,
      bookmark: await readTimeTravelBookmark(target, capturedAt) });
    return backupReceipt({ capturedAt, expiresAt, targetBookmarks });
  };
  const verifyBackup = async (backup, targets, now = Date.now(), { allowExpired = false } = {}) => {
    validateBackupReceipt(backup, targets, allowExpired ? null : now);
    // A self-digest is only an admission pin.  The default concrete path also
    // asks Wrangler for a read-only Time Travel bookmark at the reviewed
    // capture instant for every exact database ID.  A missing/ambiguous
    // bookmark fails closed before any migration statement can be sent.
    for (const target of targets) {
      const bookmark = await readTimeTravelBookmark(target, backup.capturedAt);
      if (bookmark !== backup.targetBookmarks.find(item => item.role === target.role && item.databaseId === target.databaseId)?.bookmark) fail('BACKUP_RECEIPT_UNVERIFIED');
    }
    // A caller-supplied verifier is an additional policy check.  It cannot
    // replace the concrete pinned Wrangler observation above.
    if (backupVerifier !== null) await backupVerifier({ receipt: backup, targets, readOnly: true });
  };
  const foreignKeyCheck = async target => {
    const rows = await readQuery(target, 'SELECT * FROM pragma_foreign_key_check LIMIT 1025');
    if (rows.length > 1024) fail('FOREIGN_KEY_READBACK_INVALID');
    return rows;
  };
  const migrateStatement = async (target, statement) => {
    if (!statement || !['migration', 'ledger'].includes(statement.kind) || typeof statement.sql !== 'string'
        || storageSha256(statement.sql) !== statement.sha256 || !Number.isSafeInteger(statement.resultCount)
        || statement.resultCount < 1 || statement.resultCount > 512 || typeof statement.atomic !== 'boolean'
        || (statement.kind === 'ledger' && (statement.resultCount !== 1 || statement.atomic))
        || (statement.kind === 'migration' && statement.atomic !== (statement.resultCount > 1))) fail('MIGRATION_NOT_PLANNED');
    // D1 executes each request as one implicit transaction.  Former
    // foreign_keys=OFF rebuild regions are coalesced into a single request
    // using defer_foreign_keys, while ordinary operations remain one request
    // and one journal checkpoint each.
    await readMutation(target, statement.sql, statement.resultCount);
  };
  return {
    async inventory(target) { return readInventory(target); },
    async assertMaintenanceHold(hold) { return assertMaintenanceHold(hold); },
    async activeWorker() { return activeWorker(); },
    async verifyBackupReceipt(backup, targets, now, options) { return verifyBackup(backup, targets, now, options); },
    async captureBackupReceipt(targets, capturedAt, expiresAt, now) { return captureBackup(targets, capturedAt, expiresAt, now); },
    async foreignKeyCheck(target) { return foreignKeyCheck(target); },
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
      const required = target.role === 'primary'
        ? ['participants', 'telemetry_records', 'telemetry_v1_records', 'telemetry_v11_records']
        : ['analytics_runtime_sources', 'analytics_community_daily_owners', 'analytics_community_graph_results', 'analytics_cache_retention_day_marks'];
      const names = new Set(schema.map(row => row.name));
      const data = required.every(name => names.has(name)) ? await readQuery(target, TYPED_FORWARD_DATA_INVARIANT_SQL[target.role]) : null;
      return { schemaSha256: storageSchemaDigest(schema), migrations: ledger, ledgerSha256: identityDigest(ledger),
        dataInvariantSha256: data === null ? null : identityDigest(normalizeRows(data)), bytes: 0 };
    },
    async migrateStatement(target, statement) { return migrateStatement(target, statement); },
  };
}

export async function captureTypedForwardBackupReceipt({ accountId, targets, operationDirectory, cliPath, wranglerSha256,
  capturedAt = new Date().toISOString(), expiresAt = null, now = Date.now(), outputPath = null, spawn = spawnSync } = {}) {
  const identities = validateBackupTargetIdentities(targets);
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? '') || !SHA256.test(wranglerSha256 ?? '')
      || typeof operationDirectory !== 'string' || !operationDirectory || typeof cliPath !== 'string' || !cliPath) fail('BACKUP_CAPTURE_INPUT_INVALID');
  if (!date(capturedAt)) fail('BACKUP_CAPTURE_TIME_INVALID');
  const effectiveExpiresAt = expiresAt ?? new Date(Date.parse(capturedAt) + TYPED_FORWARD_MAX_WINDOW_MS).toISOString();
  const adapter = await createTypedForwardWranglerAdapter({
    plan: { accountId, workerName: 'typed-forward-backup-capture', wranglerSha256 },
    operationDirectory, cliPath, spawn,
  });
  const receipt = await adapter.captureBackupReceipt(identities, capturedAt, effectiveExpiresAt, now);
  const writtenPath = outputPath === null ? null : await writePrivateJson(outputPath, receipt);
  return { receipt, outputPath: writtenPath, remoteWrites: false };
}

export function parseTypedForwardArguments(args) {
  const result = { mode: 'inspect', resume: false };
  const values = new Map([['--mode', 'mode'], ['--plan', 'planPath'], ['--worker-root', 'workerRoot'], ['--operation', 'operationDirectory'],
    ['--repository-root', 'repositoryRoot'], ['--cli', 'cliPath'], ['--confirmation', 'confirmation'], ['--approved-plan-sha256', 'approvedPlanSha256'],
    ['--extension', 'extensionPath'], ['--approved-extension-sha256', 'approvedExtensionSha256'],
    ['--inventory', 'inventoryPath'], ['--targets', 'targetsPath'], ['--rehearsal', 'rehearsalPath'], ['--candidate-source', 'candidateSourceCommit'],
    ['--captured-at', 'capturedAt'], ['--expires-at', 'expiresAt'],
    ['--account-id', 'accountId'], ['--worker-name', 'workerName'], ['--wrangler-sha256', 'wranglerSha256'], ['--output', 'outputPath']]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--resume') { if (result.resume) fail('ARGUMENTS_INVALID'); result.resume = true; continue; }
    const key = values.get(arg), value = args[++index];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(result, key) && key !== 'mode') fail('ARGUMENTS_INVALID');
    result[key] = value;
  }
  if (!['inspect', 'prepare', 'rehearse', 'capture-backup', 'execute'].includes(result.mode)
      || result.mode === 'rehearse' && !result.workerRoot
      || result.mode === 'inspect' && !result.planPath
      || result.mode === 'prepare' && (!result.workerRoot || !result.repositoryRoot || !result.inventoryPath || !result.targetsPath
        || !result.rehearsalPath || !result.candidateSourceCommit || !result.accountId || !result.workerName || !result.wranglerSha256 || !result.outputPath)
      || result.mode === 'capture-backup' && (!result.targetsPath || !result.operationDirectory || !result.cliPath
        || !result.accountId || !result.wranglerSha256 || !result.outputPath)
      || result.mode === 'execute' && (!result.planPath || !result.workerRoot || !result.operationDirectory || !result.repositoryRoot
        || !result.cliPath || !result.confirmation || !result.approvedPlanSha256)) fail('ARGUMENTS_INVALID');
  return result;
}

async function readPrivateJson(path, code = 'PLAN_INVALID', { withSha256 = false } = {}) {
  if (typeof path !== 'string' || !path || path.length > 4096) fail(code);
  const resolved = resolve(path), stat = await lstat(resolved).catch(() => null);
  if (!stat?.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 1_048_576
      || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || await realpath(resolved).catch(() => null) !== resolved) fail(code);
  const bytes = await readFile(resolved);
  if (bytes.length !== stat.size) fail(code);
  try {
    const value = JSON.parse(bytes);
    return withSha256 ? { value, sha256: storageSha256(bytes) } : value;
  } catch { fail(code); }
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
      const inventoryFile = await readPrivateJson(options.inventoryPath, 'INVENTORY_INVALID', { withSha256: true });
      const targets = await readPrivateJson(options.targetsPath, 'TARGET_INVALID');
      const rehearsal = await readPrivateJson(options.rehearsalPath, 'REHEARSAL_REQUIRED');
      const prepared = await prepareTypedForwardPlan({ workerRoot: options.workerRoot, repositoryRoot: options.repositoryRoot,
        accountId: options.accountId, workerName: options.workerName, candidateSourceCommit: options.candidateSourceCommit,
        inventory: inventoryFile.value, inventorySha256: inventoryFile.sha256, targets, rehearsal, wranglerSha256: options.wranglerSha256 });
      await writePrivateJson(options.outputPath, prepared.plan);
      process.stdout.write(`${JSON.stringify({ status: 'prepared', planSha256: prepared.planSha256, outputPath: resolve(options.outputPath), remoteWrites: false })}\n`);
      return;
    }
    if (options.mode === 'capture-backup') {
      const targets = await readPrivateJson(options.targetsPath, 'TARGET_INVALID');
      if (!Array.isArray(targets)) fail('BACKUP_CAPTURE_TARGETS_INVALID');
      const captured = await captureTypedForwardBackupReceipt({ accountId: options.accountId, targets,
        operationDirectory: options.operationDirectory, cliPath: options.cliPath, wranglerSha256: options.wranglerSha256,
        capturedAt: options.capturedAt, expiresAt: options.expiresAt, outputPath: options.outputPath });
      process.stdout.write(`${JSON.stringify({ status: 'captured', outputPath: resolve(options.outputPath), receiptSha256: captured.receipt.receiptSha256, remoteWrites: false })}\n`);
      return;
    }
    const plan = await readPrivateJson(options.planPath);
    if (options.mode === 'inspect') { process.stdout.write(`${JSON.stringify({ status: 'planned', planSha256: identityDigest(validateTypedForwardPlan(plan)), remoteWrites: false })}\n`); return; }
    const extension = options.extensionPath ? await readPrivateJson(options.extensionPath, 'APPROVAL_EXTENSION_INVALID') : null;
    const result = await runTypedForwardMigration({ plan, workerRoot: options.workerRoot, repositoryRoot: options.repositoryRoot,
      operationDirectory: options.operationDirectory, execute: true, resume: options.resume, confirmation: options.confirmation,
      approvedPlanSha256: options.approvedPlanSha256, extension, approvedExtensionSha256: options.approvedExtensionSha256,
      adapterFactory: input => createTypedForwardWranglerAdapter({ plan: input.plan, operationDirectory: input.operationDirectory, cliPath: options.cliPath }) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${/^TYPED_FORWARD_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'TYPED_FORWARD_FAILED'}\n`); process.exitCode = 1; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
