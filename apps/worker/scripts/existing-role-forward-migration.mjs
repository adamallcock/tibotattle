import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assertCleanSource, createTypedForwardWranglerAdapter,
  writePrivateJsonNoClobber } from './typed-forward-migration.mjs';
import { buildTypedProductionExpectedSchemas } from './production-typed-schema.mjs';
import { runTypedProductionPreflight, TYPED_PRODUCTION_PREFLIGHT_SQL } from './production-typed-preflight.mjs';
import { storageSchemaDigest, storageSha256 } from './d1-storage-plan.mjs';
import { identityDigest, openOperation, operationError } from '../../../scripts/lib/release-operation.mjs';
import { createProductionDeploymentLock } from './production-deployment-lock.mjs';
import { createProductionLiveProvider } from './production-live-provider.mjs';
import { createProductionLiveConfigSnapshot } from './production-live-config.mjs';

export const EXISTING_ROLE_FORWARD_CONFIRMATION = 'EXECUTE_REVIEWED_EXISTING_ROLE_FORWARD_MIGRATION';
export const EXISTING_ROLE_FORWARD_RETRY_CONFIRMATION = 'RETRY_PROVEN_NOT_APPLIED_EXISTING_ROLE_FORWARD_MIGRATION';
export const EXISTING_ROLE_FORWARD_SCHEMA = 'existing-role-forward-plan-v1';
export const EXISTING_ROLE_FORWARD_PREVIOUS_PUBLIC = 'c7dcdc6f4f9df0b9d006b69ac287f0a253cf2b6d';
export const EXISTING_ROLE_FORWARD_PREVIOUS_SCHEDULED = '3216e2258830841c37f17c1a0b7d8703e0a72293';
export const EXISTING_ROLE_FORWARD_STEPS = Object.freeze([
  Object.freeze({ role: 'primary', binding: 'USAGE_MONITOR_DB', scheduledBinding: 'STORAGE_INGESTION_DB',
    directory: 'typed-ingestion-migrations', name: '0005_owner_occurrence_lookup.sql',
    sha256: 'f3a0d9cfdfd067df30e08771c4f1e5100cdc0b8e6594430d1fc197f4750712ed',
    objectType: 'index', objectName: 'typed_telemetry_owner_occurrence', table: 'typed_telemetry_records' }),
  Object.freeze({ role: 'analytics', binding: 'ANALYTICS_DB', scheduledBinding: 'STORAGE_ANALYTICS_DB',
    directory: 'analytics-migrations', name: '0033_cache_retention_owner_cursor.sql',
    sha256: '370409563c2447a89d48a787c95aaa84da2fe73a437ac3c69ea57d0116cf0f8a',
    objectType: 'table', objectName: 'analytics_cache_retention_owner_cursor', table: 'analytics_cache_retention_owner_cursor' }),
]);

const SHA=/^[a-f0-9]{64}$/u, COMMIT=/^[a-f0-9]{40}$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const NAME=/^[A-Za-z0-9_-]{1,63}$/u;
const fail=code=>{throw operationError(`EXISTING_ROLE_FORWARD_${code}`);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const same=(a,b)=>identityDigest(a)===identityDigest(b);
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const validRows=rows=>Array.isArray(rows)&&rows.length>0&&rows.length<=4096
  &&rows.every(row=>exact(row,['type','name','tbl_name','sql'])
    &&['table','index','trigger','view'].includes(row.type)
    &&typeof row.name==='string'&&typeof row.tbl_name==='string'
    &&(typeof row.sql==='string'||row.sql===null));
const validLedger=rows=>Array.isArray(rows)&&rows.length>=1&&rows.length<128
  &&rows.every(row=>exact(row,['name','sha256'])
    &&/^\d{4}_[a-z0-9_-]+\.sql$/u.test(row.name)&&SHA.test(row.sha256))
  &&new Set(rows.map(row=>row.name)).size===rows.length;
const CONTROL_SQL=Object.freeze({
  collection:'SELECT schema_version,control_state,revision,enrollment_enabled,upload_registration_enabled,processing_enabled,publication_enabled FROM collection_controls WHERE singleton=1',
  correction:'SELECT schema_version,method_version,state FROM telemetry_usage_correction_runtime WHERE id=1',
  source:'SELECT source_id FROM storage_source_state WHERE singleton=1',
  v1:'SELECT source_namespace,namespace_id,runtime_contract_version FROM typed_v1_admission_state WHERE id=1',
  v11:'SELECT source_namespace,namespace_id,runtime_contract_version FROM typed_v11_admission_state WHERE id=1',
  analytics:'SELECT source_id,source_namespace,contract_version FROM analytics_runtime_sources ORDER BY source_id LIMIT 2',
  schema:TYPED_PRODUCTION_PREFLIGHT_SQL.schema,
  ledgerSchema:"SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name='d1_storage_migrations' OR tbl_name='d1_storage_migrations' ORDER BY type,name LIMIT 4",
  ledger:TYPED_PRODUCTION_PREFLIGHT_SQL.ledger,
});
const LEDGER_SCHEMA_ROWS=Object.freeze([
  Object.freeze({type:'index',name:'sqlite_autoindex_d1_storage_migrations_1',
    tbl_name:'d1_storage_migrations',sql:null}),
  Object.freeze({type:'table',name:'d1_storage_migrations',tbl_name:'d1_storage_migrations',
    sql:'CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT'}),
]);

async function validateCheckoutPaths(repositoryRoot,workerDirectory){
  if(typeof repositoryRoot!=='string'||typeof workerDirectory!=='string')fail('SOURCE_PATH_INVALID');
  const repository=resolve(repositoryRoot),worker=resolve(workerDirectory);
  if(await realpath(repository)!==repository||await realpath(worker)!==worker
    ||worker!==join(repository,'apps','worker'))fail('SOURCE_PATH_INVALID');
}

/** Inspect the two closed candidate files in a disposable SQLite database.
 * Only a single additive CREATE object can pass; no SQL is supplied by a plan. */
export async function loadExistingRoleForwardSteps({workerDirectory}){
  const root=resolve(workerDirectory);
  const require=createRequire(join(root,'package.json'));
  const split=require('wrangler').unstable_splitSqlQuery;
  if(typeof split!=='function')fail('SPLITTER_UNAVAILABLE');
  const output=[];
  for(const step of EXISTING_ROLE_FORWARD_STEPS){
    const path=join(root,step.directory,step.name),stat=await lstat(path);
    if(!stat.isFile()||stat.nlink!==1||stat.size<1||stat.size>240*1024
      ||await realpath(path)!==path)fail('SQL_FILE_UNSAFE');
    const bytes=await readFile(path);
    if(bytes.length!==stat.size||bytes.includes(0)||storageSha256(bytes)!==step.sha256)fail('SQL_FILE_CHANGED');
    const sql=bytes.toString('utf8');
    if(!Buffer.from(sql).equals(bytes)||/\bd1_storage_migrations\b/iu.test(sql)
      ||split(sql).length!==1)fail('SQL_NOT_SINGLE_ADDITIVE_OBJECT');
    const ddl=sql.replace(/^--[^\n]*(?:\n|$)/gmu,'').trim();
    if(step.role==='primary'
      ? !/^CREATE INDEX typed_telemetry_owner_occurrence\s+ON typed_telemetry_records\s*\(/iu.test(ddl)
      : !/^CREATE TABLE analytics_cache_retention_owner_cursor\s*\(/iu.test(ddl))
      fail('SQL_OBJECT_NOT_REVIEWED');
    const db=new DatabaseSync(':memory:');
    try{
      db.exec(step.role==='primary'
        ? 'CREATE TABLE typed_telemetry_records(owner_id INTEGER,format INTEGER,stream TEXT,occurrence_id BLOB)'
        : 'CREATE TABLE analytics_runtime_sources(source_id TEXT PRIMARY KEY)');
      db.exec(sql);
      const rows=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name<>? ORDER BY type,name")
        .all(step.role==='primary'?'typed_telemetry_records':'analytics_runtime_sources');
      if(rows.length!==1||rows[0].type!==step.objectType||rows[0].name!==step.objectName
        ||rows[0].tbl_name!==step.table||typeof rows[0].sql!=='string')fail('SQL_OBJECT_NOT_REVIEWED');
      output.push({...step,sha256:storageSha256(bytes),bytes:bytes.length,sql,addedObject:rows[0]});
    }finally{db.close();}
  }
  return output;
}

export function projectExistingRoleSchema(rows,step){
  if(!validRows(rows)||!object(step?.addedObject)
    ||rows.some(row=>row.name===step.objectName))fail('BEFORE_SCHEMA_INVALID');
  const projected=[...rows,step.addedObject];
  if(!validRows(projected))fail('PROJECTED_SCHEMA_INVALID');
  return {rows:projected,beforeSha256:storageSchemaDigest(rows),afterSha256:storageSchemaDigest(projected)};
}

export function validateExistingRoleInventory({accountId,publicWorker,scheduledWorkers}){
  if(!/^[a-f0-9]{32}$/u.test(accountId??'')||!object(publicWorker)
    ||!Array.isArray(scheduledWorkers)||scheduledWorkers.length!==3)fail('INVENTORY_INVALID');
  const workers=[publicWorker,...scheduledWorkers];
  if(new Set(workers.map(worker=>worker?.workerName)).size!==4)fail('INVENTORY_INVALID');
  const pins=workers.map((worker,index)=>{
    if(worker?.schema!==(index===0?'production-live-config-v1':'existing-role-scheduled-inventory-v1')||worker.accountId!==accountId
      ||!NAME.test(worker.workerName??'')||!UUID.test(worker.versionId??'')
      ||!SHA.test(worker.fingerprint??'')
      ||worker.sourceCommit!==(index===0?EXISTING_ROLE_FORWARD_PREVIOUS_PUBLIC:EXISTING_ROLE_FORWARD_PREVIOUS_SCHEDULED)
      ||!Array.isArray(worker.bindings))fail('INVENTORY_INVALID');
    const bindings={};
    for(const step of EXISTING_ROLE_FORWARD_STEPS){
      const name=index===0?step.binding:step.scheduledBinding;
      const matches=worker.bindings.filter(binding=>binding.name===name);
      if(matches.length!==1||matches[0].type!=='d1'||!UUID.test(matches[0].database_id??''))fail('BINDING_INVALID');
      bindings[step.role]=matches[0].database_id;
    }
    return {workerName:worker.workerName,versionId:worker.versionId,
      sourceCommit:worker.sourceCommit,fingerprint:worker.fingerprint,bindings};
  });
  for(const scheduled of pins.slice(1))for(const role of ['primary','analytics'])
    if(scheduled.bindings[role]!==pins[0].bindings[role])fail('BINDING_IDENTITY_DRIFT');
  if(pins[0].bindings.primary===pins[0].bindings.analytics)fail('BINDING_IDENTITY_DRIFT');
  return pins;
}

export function normalizeScheduledInventory(raw){
  const bindings=raw?.version?.resources?.bindings;
  if(!/^[a-f0-9]{32}$/u.test(raw?.accountId??'')||!NAME.test(raw?.workerName??'')
    ||!UUID.test(raw?.version?.id??'')||!Array.isArray(bindings)
    ||bindings.length<3||bindings.length>100||!object(raw.version.resources.script_runtime)
    ||!object(raw.settings)||!object(raw.schedules)||!Array.isArray(raw.schedules.schedules)
    ||!object(raw.subdomain)||!Array.isArray(raw.routes)||!Array.isArray(raw.domains)
    ||!Array.isArray(raw.namespaces))fail('SCHEDULED_INVENTORY_INVALID');
  const sources=bindings.filter(row=>row?.name==='DEPLOYMENT_SOURCE_COMMIT');
  if(sources.length!==1||sources[0].type!=='plain_text'
    ||sources[0].text!==EXISTING_ROLE_FORWARD_PREVIOUS_SCHEDULED)fail('SCHEDULED_SOURCE_DRIFT');
  const normalizedBindings=bindings.map(row=>{
    if(!object(row)||typeof row.name!=='string'||typeof row.type!=='string')
      fail('SCHEDULED_BINDING_INVALID');
    if(row.type!=='d1')return row;
    const id=row.id??row.database_id;
    if(!UUID.test(id??'')||(row.id!==undefined&&row.database_id!==undefined
      &&row.id!==row.database_id))fail('SCHEDULED_BINDING_INVALID');
    return {...row,database_id:id};
  });
  if(new Set(normalizedBindings.map(row=>row.name)).size!==normalizedBindings.length)
    fail('SCHEDULED_BINDING_INVALID');
  const fingerprint=identityDigest({accountId:raw.accountId,workerName:raw.workerName,
    versionId:raw.version.id,bindings:normalizedBindings,runtime:raw.version.resources.script_runtime,
    settings:raw.settings,schedules:raw.schedules,subdomain:raw.subdomain,
    routes:raw.routes,domains:raw.domains,namespaces:raw.namespaces});
  return {schema:'existing-role-scheduled-inventory-v1',accountId:raw.accountId,
    workerName:raw.workerName,versionId:raw.version.id,
    sourceCommit:sources[0].text,bindings:normalizedBindings,fingerprint};
}

function validateControls(controls){
  if(!exact(controls,['collection','correction'])
    ||!exact(controls.collection,['schema_version','control_state','revision','enrollment_enabled',
      'upload_registration_enabled','processing_enabled','publication_enabled'])
    ||controls.collection.schema_version!=='collection-controls-v0.1'
    ||controls.collection.control_state!=='operational'||controls.collection.revision!==9
    ||!['enrollment_enabled','upload_registration_enabled','processing_enabled','publication_enabled']
      .every(key=>controls.collection[key]===1)
    ||!exact(controls.correction,['schema_version','method_version','state'])
    ||controls.correction.schema_version!=='telemetry-usage-correction-v1'
    ||controls.correction.method_version!=='usage-total-correction-v1'
    ||controls.correction.state!=='active')fail('ACTIVE_RUNTIME_DRIFT');
}

function validateInspection(inspection,step,pin){
  if(!exact(inspection,['schemaRows','ledger','controlInvariantSha256','bytes','name'])
    ||!validRows(inspection.schemaRows)||!validLedger(inspection.ledger)
    ||!SHA.test(inspection.controlInvariantSha256??'')
    ||!Number.isSafeInteger(inspection.bytes)||inspection.bytes<0||inspection.bytes>=9_000_000_000
    ||typeof inspection.name!=='string'||!/^[a-z][a-z0-9-]{2,95}$/u.test(inspection.name)
    ||inspection.ledger.some(row=>row.name===step.name)
    ||pin.bindings[step.role]===undefined)fail('BEFORE_INSPECTION_INVALID');
  return {...inspection,schemaSha256:storageSchemaDigest(inspection.schemaRows)};
}

/** All supplied remote methods must be read-only. Production composition uses
 * pinned Wrangler/Cloudflare readers; tests inject deterministic observations. */
export async function prepareExistingRoleForwardPlan({workerDirectory,repositoryRoot,accountId,
  candidateSourceCommit,publicWorker,scheduledWorkers,sourceNamespace,wranglerSha256,
  readOnly,now=Date.now(),expiresAt}={}){
  if(!readOnly||typeof readOnly.inspect!=='function'||typeof readOnly.query!=='function'
    ||typeof readOnly.controls!=='function'||typeof readOnly.backup!=='function'
    ||typeof sourceNamespace!=='string'||!/^[A-Za-z0-9_.:-]{1,256}$/u.test(sourceNamespace)
    ||!SHA.test(wranglerSha256??'')||readOnly.wranglerSha256!==wranglerSha256)
    fail('PREPARE_INPUT_INVALID');
  if(!COMMIT.test(candidateSourceCommit??'')
    ||candidateSourceCommit===EXISTING_ROLE_FORWARD_PREVIOUS_PUBLIC)fail('CANDIDATE_INVALID');
  await validateCheckoutPaths(repositoryRoot,workerDirectory);
  assertCleanSource(repositoryRoot,candidateSourceCommit);
  const steps=await loadExistingRoleForwardSteps({workerDirectory});
  const expected=await buildTypedProductionExpectedSchemas({workerDirectory});
  const pins=validateExistingRoleInventory({accountId,publicWorker,scheduledWorkers});
  const controls=await readOnly.controls(pins[0].bindings.primary);
  validateControls(controls);
  const targets=[];
  const projected=new Map();
  for(const step of steps){
    const databaseId=pins[0].bindings[step.role];
    const before=validateInspection(await readOnly.inspect({step,databaseId}),step,pins[0]);
    const schema=projectExistingRoleSchema(before.schemaRows,step);
    projected.set(step.binding,schema.rows);
    targets.push({role:step.role,binding:step.binding,name:before.name,databaseId,
      migrationName:step.name,migrationSha256:step.sha256,
      beforeSchemaSha256:schema.beforeSha256,afterSchemaSha256:schema.afterSha256,
      beforeLedger:before.ledger,controlInvariantSha256:before.controlInvariantSha256,
      beforeBytes:before.bytes});
  }
  const roles=[{role:'primary',binding:'USAGE_MONITOR_DB'},
    {role:'analytics',binding:'ANALYTICS_DB'},
    {role:'ledger',binding:'DELETION_LEDGER'}];
  const preflight=await runTypedProductionPreflight({roles,expectedSchemas:expected.expectedSchemas,
    config:{mode:'typed',sourceNamespace},
    runQuery:(binding,sql)=>projected.has(binding)&&sql===TYPED_PRODUCTION_PREFLIGHT_SQL.schema
      ?{success:true,results:projected.get(binding)}:readOnly.query(binding,sql)});
  if(!preflight.ok)fail('PROJECTED_PREFLIGHT_FAILED');
  if(!date(expiresAt)||Date.parse(expiresAt)<=now||Date.parse(expiresAt)-now>86_400_000)fail('EXPIRY_INVALID');
  const backup=await readOnly.backup(targets,new Date(now).toISOString(),expiresAt);
  if(backup?.schema!=='typed-forward-backup-receipt-v2'
    ||backup.provider!=='cloudflare-d1-time-travel'
    ||!SHA.test(backup.receiptSha256??'')
    ||!Array.isArray(backup.targetBookmarks)||backup.targetBookmarks.length!==2)fail('BACKUP_INVALID');
  const plan={schema:EXISTING_ROLE_FORWARD_SCHEMA,operationId:randomUUID(),environment:'production',
    accountId,sourceCommit:candidateSourceCommit,
    previousPublicSourceCommit:EXISTING_ROLE_FORWARD_PREVIOUS_PUBLIC,
    previousScheduledSourceCommit:EXISTING_ROLE_FORWARD_PREVIOUS_SCHEDULED,
    createdAt:new Date(now).toISOString(),expiresAt,sourceNamespace,wranglerSha256,
    workerPins:pins,expectedInputSha256:expected.inputSha256,
    controlsSha256:identityDigest(controls),projectedPreflightSha256:identityDigest(preflight),
    backup,targets};
  validatePlan(plan,steps,expected,now);
  return plan;
}

function validatePlan(plan,steps,expected,now,allowExpired=false){
  if(!exact(plan,['schema','operationId','environment','accountId','sourceCommit',
    'previousPublicSourceCommit','previousScheduledSourceCommit','createdAt','expiresAt',
    'sourceNamespace','wranglerSha256','workerPins','expectedInputSha256','controlsSha256',
    'projectedPreflightSha256','backup','targets'])
    ||plan.schema!==EXISTING_ROLE_FORWARD_SCHEMA||plan.environment!=='production'
    ||!UUID.test(plan.operationId??'')||!/^[a-f0-9]{32}$/u.test(plan.accountId??'')
    ||!COMMIT.test(plan.sourceCommit??'')
    ||plan.previousPublicSourceCommit!==EXISTING_ROLE_FORWARD_PREVIOUS_PUBLIC
    ||plan.previousScheduledSourceCommit!==EXISTING_ROLE_FORWARD_PREVIOUS_SCHEDULED
    ||!date(plan.createdAt)||!date(plan.expiresAt)
    ||Date.parse(plan.createdAt)>now||Date.parse(plan.expiresAt)<=Date.parse(plan.createdAt)
    ||Date.parse(plan.expiresAt)-Date.parse(plan.createdAt)>86_400_000
    ||(!allowExpired&&Date.parse(plan.expiresAt)<=now)
    ||!Array.isArray(plan.workerPins)||plan.workerPins.length!==4
    ||!SHA.test(plan.controlsSha256??'')||!SHA.test(plan.projectedPreflightSha256??'')
    ||typeof plan.sourceNamespace!=='string'
    ||!/^[A-Za-z0-9_.:-]{1,256}$/u.test(plan.sourceNamespace)
    ||!SHA.test(plan.wranglerSha256??'')
    ||!same(plan.expectedInputSha256,expected.inputSha256)
    ||!Array.isArray(plan.targets)||plan.targets.length!==2)fail('PLAN_INVALID');
  if(!exact(plan.backup,['schema','provider','capturedAt','expiresAt','targetsSha256',
      'targetBookmarks','receiptSha256'])
    ||plan.backup.schema!=='typed-forward-backup-receipt-v2'
    ||plan.backup.provider!=='cloudflare-d1-time-travel'
    ||!date(plan.backup.capturedAt)||!date(plan.backup.expiresAt)
    ||Date.parse(plan.backup.expiresAt)<Date.parse(plan.expiresAt)
    ||!Array.isArray(plan.backup.targetBookmarks)||plan.backup.targetBookmarks.length!==2
    ||!SHA.test(plan.backup.receiptSha256??'')
    ||identityDigest(Object.fromEntries(Object.entries(plan.backup)
      .filter(([key])=>key!=='receiptSha256')))!==plan.backup.receiptSha256)fail('PLAN_BACKUP_INVALID');
  for(let index=0;index<plan.workerPins.length;index++){
    const worker=plan.workerPins[index];
    if(!exact(worker,['workerName','versionId','sourceCommit','fingerprint','bindings'])
      ||!NAME.test(worker.workerName??'')||!UUID.test(worker.versionId??'')
      ||!SHA.test(worker.fingerprint??'')
      ||worker.sourceCommit!==(index===0?EXISTING_ROLE_FORWARD_PREVIOUS_PUBLIC:EXISTING_ROLE_FORWARD_PREVIOUS_SCHEDULED)
      ||!exact(worker.bindings,['primary','analytics'])
      ||!UUID.test(worker.bindings.primary??'')||!UUID.test(worker.bindings.analytics??'')
      ||worker.bindings.primary!==plan.workerPins[0].bindings.primary
      ||worker.bindings.analytics!==plan.workerPins[0].bindings.analytics)fail('PLAN_INVENTORY_INVALID');
  }
  if(new Set(plan.workerPins.map(worker=>worker.workerName)).size!==4
    ||plan.workerPins[0].bindings.primary===plan.workerPins[0].bindings.analytics)fail('PLAN_INVENTORY_INVALID');
  for(let index=0;index<steps.length;index++){
    const step=steps[index],target=plan.targets[index];
    if(!exact(target,['role','binding','name','databaseId','migrationName','migrationSha256',
      'beforeSchemaSha256','afterSchemaSha256','beforeLedger','controlInvariantSha256','beforeBytes'])
      ||target.role!==step.role||target.binding!==step.binding||target.migrationName!==step.name
      ||target.migrationSha256!==step.sha256||!UUID.test(target.databaseId??'')
      ||!SHA.test(target.beforeSchemaSha256??'')||!SHA.test(target.afterSchemaSha256??'')
      ||!SHA.test(target.controlInvariantSha256??'')||!validLedger(target.beforeLedger)
      ||!Number.isSafeInteger(target.beforeBytes)||target.beforeBytes<0
      ||target.beforeBytes>=9_000_000_000
      ||typeof target.name!=='string'||!/^[a-z][a-z0-9-]{2,95}$/u.test(target.name)
      ||target.databaseId!==plan.workerPins[0].bindings[step.role]
      ||target.beforeLedger.some(row=>row.name===step.name))fail('PLAN_INVALID');
  }
  if(plan.backup.targetsSha256!==identityDigest(plan.targets.map(target=>
    ({role:target.role,databaseId:target.databaseId})))
    ||plan.backup.targetBookmarks.some((row,index)=>!exact(row,['role','databaseId','bookmark'])
      ||row.role!==plan.targets[index].role||row.databaseId!==plan.targets[index].databaseId
      ||typeof row.bookmark!=='string'||row.bookmark.length<1||row.bookmark.length>256
      ||/[\u0000-\u001f\u007f]/u.test(row.bookmark)))fail('PLAN_BACKUP_INVALID');
  return identityDigest(plan);
}

function afterLedger(target){return [...target.beforeLedger,
  {name:target.migrationName,sha256:target.migrationSha256}];}

function receiptFields(plan){
  const planSha256=identityDigest(plan);
  return {schema:'existing-role-forward-receipt-v1',status:'complete',planSha256,
    sourceCommit:plan.sourceCommit,workerPinsSha256:identityDigest(plan.workerPins),
    backupReceiptSha256:plan.backup.receiptSha256,
    projectedPreflightSha256:plan.projectedPreflightSha256,
    targets:plan.targets.map(target=>({role:target.role,binding:target.binding,
      databaseId:target.databaseId,migrationName:target.migrationName,
      migrationSha256:target.migrationSha256,
      beforeSchemaSha256:target.beforeSchemaSha256,afterSchemaSha256:target.afterSchemaSha256,
      beforeLedgerSha256:identityDigest(target.beforeLedger),
      afterLedgerSha256:identityDigest(afterLedger(target)),
      controlInvariantSha256:target.controlInvariantSha256}))};
}

function validateReceiptContent(plan,receipt){
  const expected=receiptFields(plan);
  if(!exact(receipt,[...Object.keys(expected),'completedAt','receiptSha256'])
    ||!date(receipt.completedAt)||Date.parse(receipt.completedAt)<Date.parse(plan.createdAt)
    ||Object.keys(expected).some(key=>!same(receipt[key],expected[key]))
    ||!SHA.test(receipt.receiptSha256??'')
    ||identityDigest(Object.fromEntries(Object.entries(receipt)
      .filter(([key])=>key!=='receiptSha256')))!==receipt.receiptSha256)
    fail('RECEIPT_INVALID');
  return true;
}

/** Consumers must also pin the raw private receipt/plan file hashes. */
export function verifyExistingRoleForwardReceipt({plan,receipt,operation}){
  validatePlan(plan,EXISTING_ROLE_FORWARD_STEPS,{inputSha256:plan?.expectedInputSha256},Date.now(),true);
  validateReceiptContent(plan,receipt);
  if(!exact(operation,['schema','kind','binding','id','createdAt','updatedAt','state'])
    ||operation.schema!==1||operation.kind!=='production'
    ||operation.binding!==identityDigest(plan)
    ||!exact(operation.state,['status','owner','nextRole','lastFailure'])
    ||operation.state.status!=='complete'||operation.state.nextRole!==2
    ||operation.state.lastFailure!==null||!COMMIT.test(operation.state.owner??''))
    fail('OPERATION_NOT_COMPLETE');
  return {status:'verified',planSha256:identityDigest(plan),receiptSha256:receipt.receiptSha256};
}

/** One reviewed migration plus its operator ledger row in one D1 request. */
export function existingRoleAtomicSql(step){
  if(!EXISTING_ROLE_FORWARD_STEPS.some(value=>value.role===step?.role
      &&value.name===step.name&&value.sha256===step.sha256)
    ||typeof step.sql!=='string'||storageSha256(step.sql)!==step.sha256)fail('STEP_INVALID');
  return `${step.sql.trim()}\nINSERT INTO d1_storage_migrations(name,sha256) VALUES('${step.name}','${step.sha256}');\n`;
}

/** The concrete transport has a closed set of D1 reads. Migration writes use
 * the maintained pinned Wrangler query adapter, never this REST reader. */
export function createExistingRoleProductionAdapter({accountId,publicWorkerName,
  scheduledWorkerNames,operationDirectory,cliPath,wranglerSha256,sourceNamespace,
  environment=process.env,fetchImpl=globalThis.fetch}={}){
  if(!/^[a-f0-9]{32}$/u.test(accountId??'')||!NAME.test(publicWorkerName??'')
    ||!Array.isArray(scheduledWorkerNames)||scheduledWorkerNames.length!==3
    ||scheduledWorkerNames.some(name=>!NAME.test(name))
    ||new Set([publicWorkerName,...scheduledWorkerNames]).size!==4
    ||!SHA.test(wranglerSha256??'')
    ||typeof operationDirectory!=='string'||!operationDirectory
    ||typeof cliPath!=='string'||!cliPath
    ||typeof sourceNamespace!=='string'||!/^[A-Za-z0-9_.:-]{1,256}$/u.test(sourceNamespace)
    ||typeof fetchImpl!=='function'
    ||['CLOUDFLARE_API_BASE_URL','CF_API_BASE_URL','WRANGLER_API_ENVIRONMENT','CLOUDFLARE_ENV']
      .some(key=>Object.hasOwn(environment,key)))fail('TRANSPORT_INPUT_INVALID');
  const token=environment.CLOUDFLARE_API_TOKEN;
  if(typeof token!=='string'||token.length<16)fail('CREDENTIAL_REQUIRED');
  const names=[publicWorkerName,...scheduledWorkerNames];
  const providers=names.map(workerName=>createProductionLiveProvider({
    accountId,workerName,environment,fetchImpl}));
  let rawPublic=null,pins=null,transport=null;
  const api=async(path,{sql=null}={})=>{
    let response,bytes;
    try{
      response=await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,{
        method:sql===null?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(20_000),
        headers:{authorization:`Bearer ${token}`,
          ...(sql===null?{}:{'content-type':'application/json'})},
        ...(sql===null?{}:{body:JSON.stringify({sql,params:[]})}),
      });
      if(!response.body)fail('READ_RESULT_INVALID');
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;
        size+=value.byteLength;if(size>2_000_000)fail('READ_RESULT_TOO_LARGE');chunks.push(value);}}
      finally{await reader.cancel().catch(()=>{});}
      bytes=Buffer.concat(chunks);
    }catch{fail('READ_UNAVAILABLE');}
    let body;try{body=JSON.parse(bytes);}catch{fail('READ_RESULT_INVALID');}
    if(!response.ok||body?.success!==true)fail('READ_REFUSED');
    return body.result;
  };
  const captureWorkers=async()=>{
    const raw=[];
    for(const provider of providers)raw.push(await provider.capture());
    const snapshots=[createProductionLiveConfigSnapshot(raw[0]),
      ...raw.slice(1).map(normalizeScheduledInventory)];
    const current=validateExistingRoleInventory({accountId,publicWorker:snapshots[0],
      scheduledWorkers:snapshots.slice(1)});
    rawPublic=raw[0];pins=current;
    return {publicWorker:snapshots[0],scheduledWorkers:snapshots.slice(1),pins:current};
  };
  const ensurePins=async()=>pins??(await captureWorkers()).pins;
  const fixedRows=async(databaseId,sql)=>{
    const current=await ensurePins();
    if(!Object.values(CONTROL_SQL).includes(sql)
      ||![current[0].bindings.primary,current[0].bindings.analytics].includes(databaseId))fail('QUERY_NOT_ADMITTED');
    const result=await api(`/d1/database/${databaseId}/query`,{sql});
    if(!Array.isArray(result)||result.length!==1||result[0]?.success!==true
      ||!Array.isArray(result[0].results)||result[0].results.length>4096
      ||result[0].results.some(row=>!object(row)||JSON.stringify(row).length>128*1024))fail('READ_RESULT_INVALID');
    return result[0].results;
  };
  const resource=async databaseId=>{
    const info=await api(`/d1/database/${databaseId}`);
    const bytes=info?.database_size??info?.file_size;
    if(info?.uuid!==databaseId||typeof info.name!=='string'
      ||!/^[a-z][a-z0-9-]{2,95}$/u.test(info.name)
      ||!Number.isSafeInteger(bytes)||bytes<0)fail('RESOURCE_INVALID');
    return {name:info.name,bytes};
  };
  const controls=async()=>{
    const current=await ensurePins(),databaseId=current[0].bindings.primary;
    const collection=await fixedRows(databaseId,CONTROL_SQL.collection);
    const correction=await fixedRows(databaseId,CONTROL_SQL.correction);
    if(collection.length!==1||correction.length!==1)fail('ACTIVE_RUNTIME_DRIFT');
    const result={collection:collection[0],correction:correction[0]};
    validateControls(result);return result;
  };
  const inspect=async input=>{
    const step=input.step??input,role=step.role,databaseId=input.databaseId;
    if(!EXISTING_ROLE_FORWARD_STEPS.some(value=>value.role===role)
      ||(await ensurePins())[0].bindings[role]!==databaseId)fail('TARGET_INVALID');
    const [schemaRows,ledgerSchema,ledger,info]=await Promise.all([
      fixedRows(databaseId,CONTROL_SQL.schema),fixedRows(databaseId,CONTROL_SQL.ledgerSchema),
      fixedRows(databaseId,CONTROL_SQL.ledger),
      resource(databaseId),
    ]);
    if(!validRows(schemaRows)||!same(ledgerSchema,LEDGER_SCHEMA_ROWS)
      ||!validLedger(ledger))fail('SCHEMA_OR_LEDGER_INVALID');
    const stable=role==='primary'
      ?await Promise.all([CONTROL_SQL.source,CONTROL_SQL.v1,CONTROL_SQL.v11,
        CONTROL_SQL.collection,CONTROL_SQL.correction].map(sql=>fixedRows(databaseId,sql)))
      :[await fixedRows(databaseId,CONTROL_SQL.analytics)];
    if(stable.some(rows=>rows.length!==1))fail('CONTROL_INVARIANT_INVALID');
    const controlInvariantSha256=identityDigest(stable);
    return {schemaRows,ledger,controlInvariantSha256,bytes:info.bytes,name:info.name,
      schemaSha256:storageSchemaDigest(schemaRows)};
  };
  const wrangler=async()=>{
    if(transport===null){
      // The maintained transport numbers private SQL files from zero. Every
      // explicit invocation gets its own owner-private namespace, so a
      // resumed second-role request cannot collide with first-role SQL bytes.
      const attemptDirectory=join(resolve(operationDirectory),`transport-${randomUUID()}`);
      await mkdir(attemptDirectory,{mode:0o700});
      transport=await createTypedForwardWranglerAdapter({
        plan:{accountId,workerName:publicWorkerName,wranglerSha256},
        operationDirectory:attemptDirectory,cliPath});
    }
    return transport;
  };
  const query=async(binding,sql)=>{
    if(!Object.values(TYPED_PRODUCTION_PREFLIGHT_SQL).includes(sql)
      ||!['USAGE_MONITOR_DB','ANALYTICS_DB','DELETION_LEDGER'].includes(binding))fail('QUERY_NOT_ADMITTED');
    await ensurePins();
    return providers[0].query(rawPublic,binding,sql);
  };
  return {
    wranglerSha256,
    captureWorkers,
    workerPins:async()=>(await captureWorkers()).pins,
    controls,
    inspect:async input=>{
      const value=await inspect(input);
      return input.step?{schemaRows:value.schemaRows,ledger:value.ledger,
        controlInvariantSha256:value.controlInvariantSha256,bytes:value.bytes,name:value.name}
        :{schemaSha256:value.schemaSha256,ledger:value.ledger,
          controlInvariantSha256:value.controlInvariantSha256};
    },
    query,
    backup:async(targets,capturedAt,expiresAt)=>(await wrangler())
      .captureBackupReceipt(targets,capturedAt,expiresAt),
    verifyBackup:async(backup,targets,{allowExpired=false}={})=>(await wrangler())
      .verifyBackupReceipt(backup,targets,Date.now(),{allowExpired}),
    migrateAtomic:async(target,statement)=>(await wrangler()).migrateStatement(target,
      {kind:'migration',...statement}),
    preflight:async expectedSchemas=>{
      await captureWorkers();
      return runTypedProductionPreflight({roles:[
        {role:'primary',binding:'USAGE_MONITOR_DB'},
        {role:'analytics',binding:'ANALYTICS_DB'},
        {role:'ledger',binding:'DELETION_LEDGER'},
      ],runQuery:query,expectedSchemas,config:{mode:'typed',sourceNamespace}});
    },
  };
}

/** Remote effects are injected and occur only after exact plan approval.
 * An uncertain response is reconciled read-only; the SQL is never replayed. */
export async function runExistingRoleForwardMigration({plan,workerDirectory,repositoryRoot,
  operationDirectory,execute=false,resume=false,confirmation,approvedPlanSha256,
  reconcileOnly=false,approvedReconciliationSha256=null,retryConfirmation=null,
  adapterFactory,lockFactory=()=>createProductionDeploymentLock({repositoryRoot}),now=Date.now()}={}){
  await validateCheckoutPaths(repositoryRoot,workerDirectory);
  const steps=await loadExistingRoleForwardSteps({workerDirectory});
  const expected=await buildTypedProductionExpectedSchemas({workerDirectory});
  const planSha256=validatePlan(plan,steps,expected,now,resume&&(execute||reconcileOnly));
  assertCleanSource(repositoryRoot,plan.sourceCommit);
  if(reconcileOnly&&!resume)fail('RECONCILE_REQUIRES_RESUME');
  if(!execute&&!reconcileOnly)return {status:'planned',planSha256,remoteWrites:false};
  if(typeof adapterFactory!=='function')fail('ADAPTER_INVALID');
  if(!reconcileOnly&&(confirmation!==EXISTING_ROLE_FORWARD_CONFIRMATION
      ||approvedPlanSha256!==planSha256))fail('EXECUTE_NOT_APPROVED');
  const operation=await openOperation({directory:operationDirectory,kind:'production',binding:plan,resume});
  let state=operation.record.state;
  try{
    if(resume){
      if(!exact(state,['status','owner','nextRole','lastFailure'])
        ||!['lock_intent','running','uncertain','release_intent','complete'].includes(state.status)
        ||(state.owner!==null&&!COMMIT.test(state.owner))
        ||!Number.isSafeInteger(state.nextRole)||state.nextRole<0||state.nextRole>2)fail('JOURNAL_INVALID');
    }else{
      state={status:'lock_intent',owner:null,nextRole:0,lastFailure:null};
      await operation.save(state);
    }
    const adapter=await adapterFactory({plan,steps,expected});
    if(adapter?.wranglerSha256!==plan.wranglerSha256)fail('TRANSPORT_PIN_CHANGED');
    const inspect=async(index)=>{
      const target=plan.targets[index],observed=await adapter.inspect(target);
      if(!exact(observed,['schemaSha256','ledger','controlInvariantSha256'])
        ||!SHA.test(observed.schemaSha256??'')||!validLedger(observed.ledger)
        ||observed.controlInvariantSha256!==target.controlInvariantSha256)fail('CONTROL_INVARIANT_DRIFT');
      return observed;
    };
    const verifyCurrent=async({allowExpired=false}={})=>{
      if(!same(await adapter.workerPins(),plan.workerPins))fail('WORKER_INVENTORY_DRIFT');
      const controls=await adapter.controls();
      validateControls(controls);
      if(identityDigest(controls)!==plan.controlsSha256)fail('ACTIVE_RUNTIME_DRIFT');
      await adapter.verifyBackup(plan.backup,plan.targets,{allowExpired});
    };
    if(state.status==='uncertain'){
      // A lost response may already have committed. The first reconciliation
      // is remote-read-only and does not release the lock or replay SQL.
      const lock=lockFactory();await lock.assertOwned(state.owner);
      await verifyCurrent({allowExpired:true});
      const observed=await inspect(state.nextRole);
      const target=plan.targets[state.nextRole];
      const after=observed.schemaSha256===target.afterSchemaSha256
        &&same(observed.ledger,afterLedger(target));
      const before=observed.schemaSha256===target.beforeSchemaSha256
        &&same(observed.ledger,target.beforeLedger);
      const classification=after?'applied':before?'not-applied':'ambiguous';
      const reconciliation={schema:'existing-role-forward-reconciliation-v1',planSha256,
        role:target.role,classification,observedSchemaSha256:observed.schemaSha256,
        observedLedgerSha256:identityDigest(observed.ledger),
        controlInvariantSha256:observed.controlInvariantSha256};
      const reconciliationSha256=identityDigest(reconciliation);
      if(reconcileOnly||approvedReconciliationSha256===null)
        return {status:`reconciled-${classification}`,reconciliation,reconciliationSha256,
          remoteWrites:false};
      if(approvedReconciliationSha256!==reconciliationSha256||classification==='ambiguous')
        fail('RECONCILIATION_NOT_APPROVED');
      if(classification==='not-applied'
        &&retryConfirmation!==EXISTING_ROLE_FORWARD_RETRY_CONFIRMATION)
        fail('RETRY_NOT_APPROVED');
      if(Date.parse(plan.expiresAt)<=Date.now())fail('APPROVAL_EXPIRED');
      state={...state,status:'running',nextRole:state.nextRole+(classification==='applied'?1:0),
        lastFailure:null};
      await operation.save(state);
    }
    if(state.status==='lock_intent'){
      const lock=lockFactory();
      const owner=await lock.status();
      if(reconcileOnly)return {status:owner===state.owner&&owner!==null
        ?'lock-owned':'lock-acquire-uncertain',planSha256,remoteWrites:false};
      if(state.owner!==null){
        if(owner!==state.owner)fail('LOCK_ACQUIRE_UNCERTAIN');
        state={...state,status:'running'};await operation.save(state);
      }
    }
    if(reconcileOnly)fail('NOT_UNCERTAIN');
    if(state.status==='complete')return {status:'complete',planSha256,remoteWrites:false};
    const lock=lockFactory();
    if(state.status==='release_intent'){
      const receipt=await readPrivateJson(join(operationDirectory,'receipt.json'),'RECEIPT',1024*1024);
      validateReceiptContent(plan,receipt);
      const owner=await lock.status();
      if(owner!==null){
        if(owner!==state.owner)fail('LOCK_NOT_OWNED');
        await lock.release(state.owner);
      }
      state={...state,status:'complete',lastFailure:null};await operation.save(state);
      return {status:'complete',planSha256,receiptPath:join(operationDirectory,'receipt.json'),remoteWrites:owner!==null};
    }
    if(state.owner===null){
      state.owner=await lock.createOwner({id:operation.record.id,sourceCommit:plan.sourceCommit,
        previousSourceCommit:plan.previousPublicSourceCommit});
      await operation.save(state);
      await lock.acquire(state.owner);
      state={...state,status:'running'};await operation.save(state);
    }else await lock.assertOwned(state.owner);
    for(let index=state.nextRole;index<steps.length;index++){
      const target=plan.targets[index],step=steps[index];
      if(Date.parse(plan.expiresAt)<=Date.now())fail('APPROVAL_EXPIRED');
      await lock.assertOwned(state.owner);
      await verifyCurrent();
      const before=await inspect(index);
      if(before.schemaSha256!==target.beforeSchemaSha256
        ||!same(before.ledger,target.beforeLedger))fail('BEFORE_DRIFT');
      // The read-only checks above can outlive the approval window. Recheck
      // authorization, backup and source after inspection and at the actual
      // transport boundary, while the production lock remains owned.
      await verifyCurrent();
      assertCleanSource(repositoryRoot,plan.sourceCommit);
      if(Date.parse(plan.expiresAt)<=Date.now())fail('APPROVAL_EXPIRED');
      const sql=existingRoleAtomicSql(step);
      state={...state,status:'uncertain',nextRole:index,lastFailure:null};
      await operation.save(state);
      await lock.assertOwned(state.owner);
      assertCleanSource(repositoryRoot,plan.sourceCommit);
      if(Date.parse(plan.expiresAt)<=Date.now())fail('APPROVAL_EXPIRED');
      try{await adapter.migrateAtomic(target,{sql,sha256:storageSha256(sql),resultCount:2,atomic:true});}
      catch{state.lastFailure='PROVIDER_RESULT_UNCERTAIN';await operation.save(state);fail('PROVIDER_RESULT_UNCERTAIN');}
      const after=await inspect(index);
      if(after.schemaSha256!==target.afterSchemaSha256
        ||!same(after.ledger,afterLedger(target)))fail('RESULT_UNCERTAIN');
      state={...state,status:'running',nextRole:index+1,lastFailure:null};
      await operation.save(state);
    }
    await verifyCurrent();
    const afterPreflight=await adapter.preflight(expected.expectedSchemas);
    if(!afterPreflight?.ok||identityDigest(afterPreflight)!==plan.projectedPreflightSha256)
      fail('AFTER_PREFLIGHT_FAILED');
    await lock.assertOwned(state.owner);
    const receiptPath=join(operationDirectory,'receipt.json');
    const existing=await lstat(receiptPath).catch(error=>{
      if(error?.code==='ENOENT')return null;throw error;});
    if(existing){
      if(!existing.isFile()||existing.nlink!==1||(existing.mode&0o077)
        ||(process.getuid&&existing.uid!==process.getuid()))fail('RECEIPT_UNSAFE');
      validateReceiptContent(plan,await readPrivateJson(receiptPath,'RECEIPT',1024*1024));
    }else{
      const value={...receiptFields(plan),completedAt:new Date().toISOString()};
      await writePrivateJsonNoClobber(receiptPath,{...value,receiptSha256:identityDigest(value)});
    }
    state={...state,status:'release_intent'};await operation.save(state);
    await lock.release(state.owner);
    state={...state,status:'complete'};await operation.save(state);
    return {status:'complete',planSha256,receiptPath,remoteWrites:true};
  }finally{operation.close();}
}

export function parseExistingRoleForwardArguments(argv){
  if(!Array.isArray(argv)||argv.length<2||argv.length>40||argv.length%2!==0)fail('ARGUMENTS');
  const flags=new Map();
  for(let index=0;index<argv.length;index+=2){
    const key=argv[index],value=argv[index+1];
    if(!/^--[a-z-]+$/u.test(key??'')||typeof value!=='string'||!value
      ||flags.has(key))fail('ARGUMENTS');
    flags.set(key,value);
  }
  const modes=['prepare','inspect','execute','reconcile'];
  const mode=flags.get('--mode');
  if(!modes.includes(mode))fail('ARGUMENTS');
  const common=['--mode','--repository-root','--operation-directory'];
  const prepared=['--account-id','--public-worker','--scheduled-workers',
    '--source-namespace','--candidate-source-commit','--expires-at','--cli-path','--wrangler-sha256'];
  const execute=['--cli-path','--wrangler-sha256','--approved-plan-sha256',
    '--confirmation','--resume','--approved-reconciliation-sha256','--retry-confirmation'];
  const allowed=new Set([...common,...(mode==='prepare'?prepared:mode==='inspect'?[]:execute)]);
  if([...flags.keys()].some(key=>!allowed.has(key))
    ||common.some(key=>!flags.has(key))
    ||(mode==='prepare'&&prepared.some(key=>!flags.has(key)))
    ||(mode==='execute'&&['--cli-path','--wrangler-sha256','--approved-plan-sha256','--confirmation']
      .some(key=>!flags.has(key)))
    ||(mode==='reconcile'&&['--cli-path','--wrangler-sha256'].some(key=>!flags.has(key)))
    ||(flags.has('--resume')&&flags.get('--resume')!=='yes')
    ||(mode==='reconcile'&&flags.has('--resume'))
    ||(flags.has('--approved-reconciliation-sha256')&&!flags.has('--resume'))
    ||(flags.has('--retry-confirmation')&&!flags.has('--approved-reconciliation-sha256')))
    fail('ARGUMENTS');
  return Object.fromEntries([...flags].map(([key,value])=>[key.slice(2).replaceAll('-','_'),value]));
}

async function readPrivateJson(path,kind,limit){
  const info=await lstat(path);
  if(!info.isFile()||info.nlink!==1||(info.mode&0o077)||info.size<1||info.size>limit
    ||(process.getuid&&info.uid!==process.getuid())||await realpath(path)!==path)fail(`${kind}_FILE_UNSAFE`);
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const current=await handle.stat();
    if(current.ino!==info.ino||current.dev!==info.dev||current.nlink!==1
      ||current.size!==info.size)fail(`${kind}_FILE_CHANGED`);
    return JSON.parse(await handle.readFile('utf8'));
  }finally{await handle.close();}
}

const readPrivatePlan=path=>readPrivateJson(path,'PLAN',1024*1024);

async function main(){
  const options=parseExistingRoleForwardArguments(process.argv.slice(2));
  const repositoryRoot=resolve(options.repository_root);
  const workerDirectory=join(repositoryRoot,'apps','worker');
  const operationDirectory=resolve(options.operation_directory);
  await validateCheckoutPaths(repositoryRoot,workerDirectory);
  if(options.mode==='prepare'){
    await mkdir(operationDirectory,{recursive:true,mode:0o700});
    const directory=await lstat(operationDirectory);
    if(!directory.isDirectory()||(directory.mode&0o077)
      ||(process.getuid&&directory.uid!==process.getuid())
      ||await realpath(operationDirectory)!==operationDirectory)fail('OPERATION_DIRECTORY_UNSAFE');
    const scheduledWorkerNames=options.scheduled_workers.split(',');
    const adapter=createExistingRoleProductionAdapter({accountId:options.account_id,
      publicWorkerName:options.public_worker,scheduledWorkerNames,operationDirectory,
      cliPath:options.cli_path,wranglerSha256:options.wrangler_sha256,
      sourceNamespace:options.source_namespace});
    const inventory=await adapter.captureWorkers();
    const plan=await prepareExistingRoleForwardPlan({workerDirectory,repositoryRoot,
      accountId:options.account_id,candidateSourceCommit:options.candidate_source_commit,
      publicWorker:inventory.publicWorker,scheduledWorkers:inventory.scheduledWorkers,
      sourceNamespace:options.source_namespace,wranglerSha256:options.wrangler_sha256,
      readOnly:adapter,
      expiresAt:options.expires_at});
    await writePrivateJsonNoClobber(join(operationDirectory,'plan.json'),plan);
    process.stdout.write(`${JSON.stringify({status:'prepared',planSha256:identityDigest(plan),remoteWrites:false})}\n`);
    return;
  }
  const plan=await readPrivatePlan(join(operationDirectory,'plan.json'));
  if(options.mode!=='inspect'&&options.wrangler_sha256!==plan.wranglerSha256)
    fail('TRANSPORT_PIN_CHANGED');
  const adapterFactory=options.mode==='inspect'?null:()=>createExistingRoleProductionAdapter({
    accountId:plan.accountId,publicWorkerName:plan.workerPins[0].workerName,
    scheduledWorkerNames:plan.workerPins.slice(1).map(worker=>worker.workerName),
    operationDirectory,cliPath:options.cli_path,wranglerSha256:options.wrangler_sha256,
    sourceNamespace:plan.sourceNamespace});
  const result=await runExistingRoleForwardMigration({plan,workerDirectory,repositoryRoot,
    operationDirectory,execute:options.mode==='execute',resume:options.resume==='yes'
      ||options.mode==='reconcile',reconcileOnly:options.mode==='reconcile',
    confirmation:options.confirmation,approvedPlanSha256:options.approved_plan_sha256,
    approvedReconciliationSha256:options.approved_reconciliation_sha256??null,
    retryConfirmation:options.retry_confirmation??null,adapterFactory});
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  main().catch(error=>{
    const code=/^EXISTING_ROLE_FORWARD_[A-Z_]+$/.test(error?.code??'')
      ?error.code:'EXISTING_ROLE_FORWARD_FAILED';
    process.stderr.write(`${code}\n`);process.exitCode=1;
  });
}
