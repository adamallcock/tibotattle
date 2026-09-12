import providerSchemas from '../src/d1-provider-schema.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { identityDigest, operationError } from '../../../scripts/lib/release-operation.mjs';

export const D1_STORAGE_OPERATING_CAP = 9_000_000_000;
export const D1_STORAGE_CONFIRMATION = 'EXECUTE_REVIEWED_D1_STORAGE_PLAN';
export const D1_STORAGE_SCHEMA_DIRECTORIES = Object.freeze({
  control: 'routing-migrations', ingestion: '.release-build/ingestion-role-migrations', analytics: 'analytics-migrations',
});
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const matches = (expression, value) => typeof value === 'string' && expression.test(value);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const storageError = (suffix) => operationError(`D1_STORAGE_${suffix}`);
export const storageSha256 = (value) => createHash('sha256').update(value).digest('hex');
export function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join() !== [...keys].sort().join()) throw storageError('SHAPE');
}
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

// This is an operational approval input, not an assertion that the application
// schema has been qualified. Qualification is separately pinned below.
export function validateStoragePlan(plan, { now = Date.now(), allowExpired = false } = {}) {
  exactKeys(plan, ['schema', 'operationId', 'environment', 'accountId', 'sourceCommit', 'previousSourceCommit',
    'createdAt', 'expiresAt', 'phase', 'operatingCapBytes', 'targets']);
  if (plan.schema !== 'd1-storage-plan-v1' || !matches(UUID, plan.operationId)
      || !['staging', 'production'].includes(plan.environment) || !matches(/^[a-f0-9]{32}$/, plan.accountId)
      || !matches(COMMIT, plan.sourceCommit) || !matches(COMMIT, plan.previousSourceCommit)
      || !['create', 'migrate'].includes(plan.phase) || plan.operatingCapBytes !== D1_STORAGE_OPERATING_CAP
      || !date(plan.createdAt) || !date(plan.expiresAt) || Date.parse(plan.createdAt) > now
      || (!allowExpired && Date.parse(plan.expiresAt) <= now)
      || Date.parse(plan.expiresAt) <= Date.parse(plan.createdAt)
      || Date.parse(plan.expiresAt) - Date.parse(plan.createdAt) > 86_400_000
      || !Array.isArray(plan.targets) || plan.targets.length < 1 || plan.targets.length > 32) throw storageError('PLAN_INVALID_OR_STALE');
  const names = new Set(), bindings = new Set(), ids = new Set();
  for (const target of plan.targets) {
    exactKeys(target, ['role', 'name', 'binding', 'databaseId', 'qualificationSha256', 'migrationGrowthBudgetBytes']);
    if (!Object.hasOwn(D1_STORAGE_SCHEMA_DIRECTORIES, target.role)
        || typeof target.name !== 'string' || !/^[a-z][a-z0-9-]{2,95}$/.test(target.name)
        || !target.name.startsWith(`tibotattle-${plan.environment}-${target.role}-`)
        || !matches(/^[A-Z][A-Z0-9_]{0,63}$/, target.binding)
        || !(target.databaseId === null ? plan.phase === 'create' : matches(UUID, target.databaseId))
        || (plan.phase === 'create' && target.databaseId === null && !target.name.endsWith(`-${plan.operationId}`))
        || !matches(SHA, target.qualificationSha256) || !Number.isSafeInteger(target.migrationGrowthBudgetBytes)
        || target.migrationGrowthBudgetBytes < 0 || target.migrationGrowthBudgetBytes >= D1_STORAGE_OPERATING_CAP
        || names.has(target.name) || bindings.has(target.binding) || (target.databaseId !== null && ids.has(target.databaseId))) throw storageError('TARGET_INVALID');
    names.add(target.name); bindings.add(target.binding); if (target.databaseId !== null) ids.add(target.databaseId);
  }
  return structuredClone(plan);
}

/** Canonical digests, like the parent plan digest, ignore JSON indentation.
 * The entire chain remains in the original journal; it changes only the write
 * deadline, never the operation binding, database IDs, schema or lock owner. */
export function resolveStorageApproval({ plan, extensions = [], extension = null, approvedExtensionSha256 = null, now = Date.now() }) {
  validateStoragePlan(plan, { now, allowExpired: true });
  if (!Array.isArray(extensions) || extensions.length > 32) throw storageError('EXTENSION_CHAIN_INVALID');
  const planSha256 = identityDigest(plan);
  let previous = null, deadline = plan.expiresAt, approvedAt = plan.createdAt;
  const validateLink = (document) => {
    exactKeys(document, ['schema', 'planSha256', 'previousExtensionSha256', 'approvedAt', 'expiresAt']);
    if (document.schema !== 'd1-storage-approval-extension-v1' || document.planSha256 !== planSha256
        || !(document.previousExtensionSha256 === null || matches(SHA, document.previousExtensionSha256))
        || document.previousExtensionSha256 !== previous || !date(document.approvedAt) || !date(document.expiresAt)
        || Date.parse(document.approvedAt) > now || Date.parse(document.approvedAt) < Date.parse(approvedAt)
        || Date.parse(document.expiresAt) <= Date.parse(document.approvedAt)
        || Date.parse(document.expiresAt) - Date.parse(document.approvedAt) > 86_400_000
        || Date.parse(document.expiresAt) <= Date.parse(deadline)) throw storageError('EXTENSION_CHAIN_INVALID');
    previous = identityDigest(document); deadline = document.expiresAt; approvedAt = document.approvedAt;
  };
  for (const document of extensions) validateLink(document);
  let next = extensions;
  if (extension !== null || approvedExtensionSha256 !== null) {
    if (extension === null || !matches(SHA, approvedExtensionSha256)
        || identityDigest(extension) !== approvedExtensionSha256) throw storageError('EXTENSION_NOT_APPROVED');
    // Replaying the exact latest extension acknowledges the same authorization,
    // even after expiry; it cannot reset the clock or append a duplicate link.
    if (approvedExtensionSha256 !== previous) {
      if (extensions.length >= 32 || !date(extension.expiresAt) || Date.parse(extension.expiresAt) <= now) throw storageError('EXTENSION_EXPIRED_OR_LIMIT');
      validateLink(extension);
      next = [...extensions, extension];
    }
  }
  return { extensions: structuredClone(next), extensionSha256: previous, expiresAt: deadline };
}

export function assertStorageMutationApproval(plan, extensions = [], now = Date.now()) {
  const approval = resolveStorageApproval({ plan, extensions, now });
  if (Date.parse(approval.expiresAt) <= now) throw storageError('APPROVAL_EXPIRED');
  return approval;
}

async function boundedFile(path, maxBytes) {
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > maxBytes
      || await realpath(path) !== resolve(path)) throw storageError('SOURCE_FILE_UNSAFE');
  const bytes = await readFile(path);
  if (bytes.length !== info.size) throw storageError('SOURCE_CHANGED');
  return bytes;
}

export async function loadStorageQualification({ workerRoot, plan, target }) {
  const directory = join(resolve(workerRoot), D1_STORAGE_SCHEMA_DIRECTORIES[target.role]);
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || await realpath(directory) !== directory) throw storageError('SCHEMA_DIRECTORY_UNQUALIFIED');
  const bytes = await boundedFile(join(directory, 'qualification.json'), 256 * 1024).catch(() => { throw storageError('SCHEMA_UNQUALIFIED'); });
  if (storageSha256(bytes) !== target.qualificationSha256) throw storageError('QUALIFICATION_CHANGED');
  let manifest;
  try { manifest = JSON.parse(bytes); } catch { throw storageError('QUALIFICATION_INVALID'); }
  exactKeys(manifest, ['schema', 'status', 'role', 'directory', 'sourceCommit', 'evidenceSha256', 'migrations',
    ...(target.role === 'ingestion' ? ['qualificationScope','runtimeReady','finalRoleSchemaSha256','roleInputsSha256'] : [])]);
  if (manifest.schema !== 'd1-storage-schema-qualification-v1' || manifest.status !== 'qualified'
      || manifest.role !== target.role || manifest.directory !== D1_STORAGE_SCHEMA_DIRECTORIES[target.role]
      || manifest.sourceCommit !== plan.sourceCommit || !matches(SHA, manifest.evidenceSha256)
      || !Array.isArray(manifest.migrations) || manifest.migrations.length < 1 || manifest.migrations.length > 128) throw storageError('QUALIFICATION_INVALID');
  const evidence = await boundedFile(join(directory, 'qualification-evidence.json'), 256 * 1024);
  if (storageSha256(evidence) !== manifest.evidenceSha256) throw storageError('QUALIFICATION_EVIDENCE_CHANGED');
  if (target.role === 'ingestion') {
    if (manifest.qualificationScope !== 'restore-base-schema-only' || manifest.runtimeReady !== false
        || !matches(SHA,manifest.finalRoleSchemaSha256) || !matches(SHA,manifest.roleInputsSha256)) throw storageError('ROLE_QUALIFICATION_INVALID');
    const finalRole=await boundedFile(join(directory,'final-role-schema.json'),2*1024*1024);
    const roleInputs=await boundedFile(join(directory,'role-inputs.json'),256*1024);
    if(storageSha256(finalRole)!==manifest.finalRoleSchemaSha256 || storageSha256(roleInputs)!==manifest.roleInputsSha256)
      throw storageError('ROLE_QUALIFICATION_CHANGED');
    let proof,objects,inputs;try{proof=JSON.parse(evidence);objects=JSON.parse(finalRole);inputs=JSON.parse(roleInputs);}catch{throw storageError('ROLE_QUALIFICATION_INVALID');}
    if(proof.schema!=='d1-storage-restore-rehearsal-v1'||proof.status!=='passed'||proof.frozenSource!==true
      ||proof.scope!=='synthetic-v11-authority-copy-and-bootstrap'||!matches(SHA,proof.runnerSha256)||!matches(SHA,proof.contractDigest)
      ||manifest.migrations.length!==1||manifest.migrations[0].name!=='0001_restore_base.sql'||proof.baseSqlSha256!==manifest.migrations[0].sha256
      ||proof.sourceCommit!==plan.sourceCommit||proof.runtimeReady!==false||proof.remoteOperations!==false
      ||proof.finalRoleSchemaSha256!==manifest.finalRoleSchemaSha256||proof.roleInputsSha256!==manifest.roleInputsSha256
      ||inputs.sourceCommit!==plan.sourceCommit||inputs.frozen!==true||inputs.schema!=='d1-ingestion-role-inputs-v1'
      ||identityDigest(inputs.migrations)!==inputs.inputSha256||proof.inputSha256!==inputs.inputSha256
      ||!['sourceRowsPreserved','typedEvidenceVerified','authorityVerified','finalRoleInstalled','publicSourceBootstrapComplete'].every(k=>proof[k]===true)
      ||!Array.isArray(objects)||objects.length>1024||proof.finalSchemaSha256!==storageSchemaDigest(objects))throw storageError('ROLE_QUALIFICATION_INVALID');
    // The final manifest must cover actual authority, exact evidence, admission,
    // source journal and analytics isolation; typed tables alone are insufficient.
    for(const name of ['participants','device_credentials','upload_authorizations','accountless_enrollment_ledger',
      'telemetry_contributions','telemetry_records','telemetry_contribution_occurrences','typed_telemetry_records',
      'typed_v1_admission_state','typed_v11_record_proofs','typed_v11_manifest_memberships','telemetry_v11_domain_heads','storage_v11_owner_links',
      'storage_legacy_event_sources','ingestion_analytics_separation','storage_v11_append_transitions'])
      if(!objects.some(o=>o.type==='table'&&o.name===name))throw storageError('ROLE_QUALIFICATION_INCOMPLETE');
    if(!objects.some(o=>o.type==='view'&&o.name==='typed_v11_record_admissions'))throw storageError('ROLE_QUALIFICATION_INCOMPLETE');
    const expectedDirectories=['migrations','typed-ingestion-migrations','ingestion-bridge-migrations',
      'typed-v11-admission-migrations','typed-v1-admission-migrations','ingestion-isolation-migrations'];
    if(JSON.stringify([...new Set(inputs.migrations.map(m=>m.directory))])!==JSON.stringify(expectedDirectories))throw storageError('ROLE_QUALIFICATION_INCOMPLETE');
    for(const directoryName of expectedDirectories){
      const pinned=inputs.migrations.filter(m=>m.directory===directoryName);
      const actual=(await readdir(join(workerRoot,directoryName))).filter(name=>name.endsWith('.sql')).sort();
      if(JSON.stringify(actual)!==JSON.stringify(pinned.map(m=>m.name)))throw storageError('ROLE_INPUT_CHANGED');
      for(const input of pinned){if(!/^\d{4}_[a-z0-9_-]+\.sql$/.test(input.name)
        ||storageSha256(await boundedFile(join(workerRoot,directoryName,input.name),240*1024))!==input.sha256)throw storageError('ROLE_INPUT_CHANGED');}
    }
  }

  const names = [], migrations = [];
  for (const step of manifest.migrations) {
    exactKeys(step, ['name', 'sha256', 'beforeSchemaSha256', 'afterSchemaSha256']);
    if (typeof step.name !== 'string' || !/^\d{4}_[a-z0-9_-]+\.sql$/.test(step.name)
        || !matches(SHA, step.sha256) || !matches(SHA, step.beforeSchemaSha256) || !matches(SHA, step.afterSchemaSha256)
        || names.includes(step.name) || (names.length && step.name <= names.at(-1))
        || (migrations.length && step.beforeSchemaSha256 !== migrations.at(-1).afterSchemaSha256)) throw storageError('MIGRATION_CHAIN_INVALID');
    const sqlBytes = await boundedFile(join(directory, step.name), 240 * 1024);
    const sql = sqlBytes.toString('utf8');
    if (storageSha256(sqlBytes) !== step.sha256 || !Buffer.from(sql).equals(sqlBytes) || sql.includes('\0')
        || /\bd1_storage_migrations\b/i.test(sql)) throw storageError('MIGRATION_CHANGED_OR_RESERVED');
    names.push(step.name); migrations.push({ ...step, sql });
  }
  const actual = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  if (JSON.stringify(actual) !== JSON.stringify(names)) throw storageError('UNQUALIFIED_MIGRATIONS');
  return { manifest, migrations, schemaSha256: migrations.at(-1).afterSchemaSha256 };
}

// sqlite_schema SQL is part of the proof, not a normalized approximation.
// The tool's own receipt ledger is excluded; its rows are checked separately.
export function storageSchemaDigest(rows) {
  if (!Array.isArray(rows) || rows.length > 4096) throw storageError('SCHEMA_RESULT_INVALID');
  const ordered = rows.map((row) => {
    exactKeys(row, ['type', 'name', 'tbl_name', 'sql']);
    if (!['table', 'index', 'trigger', 'view'].includes(row.type) || typeof row.name !== 'string'
        || typeof row.tbl_name !== 'string' || !(typeof row.sql === 'string' || row.sql === null)) throw storageError('SCHEMA_RESULT_INVALID');
    return row;
  }).filter((row) => !row.name.startsWith('sqlite_') && row.tbl_name !== 'd1_storage_migrations'
    && !providerSchemas.some(providerSchema => Object.keys(providerSchema).every(key => row[key] === providerSchema[key])
      && !rows.some(attached => attached.tbl_name === providerSchema.tbl_name
        && attached.name !== providerSchema.name && attached.sql !== null)));
  ordered.sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return identityDigest(ordered);
}

export async function prepareStoragePlan({ plan, workerRoot, now, allowExpired = false }) {
  const approved = validateStoragePlan(plan, { now, allowExpired });
  const qualifications = {};
  for (const target of approved.targets) qualifications[target.binding] = await loadStorageQualification({ workerRoot, plan: approved, target });
  return { plan: approved, planSha256: identityDigest(approved), qualifications, publishingPerformed: false };
}
