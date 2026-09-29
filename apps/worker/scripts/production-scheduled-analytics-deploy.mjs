import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityDigest, openOperation, readOperation, operationError } from '../../../scripts/lib/release-operation.mjs';
import { createProductionDeploymentLock } from './production-deployment-lock.mjs';
import { createMaintenanceTransport } from './production-maintenance-transport.mjs';
import { storageSchemaDigest } from './d1-storage-plan.mjs';
import { loadExistingRoleForwardSteps, verifyExistingRoleForwardReceipt } from './existing-role-forward-migration.mjs';

const ROLES = ['analytics', 'publication', 'cache'];
const REFRESH_PREVIOUS_SOURCE = '3216e2258830841c37f17c1a0b7d8703e0a72293';
const REFRESH_PREVIOUS_STAGES = { analytics: 'model-batches', publication: 'shared-publication', cache: 'shared-cache' };
const FILES = { analytics: 'storage-analytics-worker.js', publication: 'storage-publication-worker.js', cache: 'cache-retention-day-worker.js' };
const ROLE_NAMES = { analytics: /^tibotattle-analytics-[a-z0-9-]+$/, publication: /^tibotattle-publication-[a-z0-9-]+$/, cache: /^tibotattle-cache-retention-[a-z0-9-]+$/ };
const FLAGS = { analytics: ['STORAGE_ANALYTICS_SHARED_FEATURES', 'STORAGE_ANALYTICS_MODEL_BLOCKS'], publication: ['STORAGE_ANALYTICS_SHARED_FEATURES', 'STORAGE_ANALYTICS_MODEL_BLOCKS'], cache: ['CACHE_RETENTION_SHARED_FEATURES'] };
const STAGES = { 'deploy-disabled': ROLES, 'refresh-enabled': ROLES, 'shared-publication': ['publication'], 'shared-cache': ['cache'], 'shared-graph': ['analytics'], 'model-batches': ['analytics'],
  'disable-publication': ['publication'], 'disable-cache': ['cache'], 'disable-graph': ['analytics'], 'disable-model': ['analytics'] };
const SHA = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = code => { throw operationError(`SCHEDULED_ANALYTICS_${code}`); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === expected.slice().sort().join();
const requiredFlags = stage => ({
  analytics: { STORAGE_ANALYTICS_SHARED_FEATURES: ['refresh-enabled','shared-graph','model-batches','disable-model'].includes(stage) ? 'enabled' : 'disabled', STORAGE_ANALYTICS_MODEL_BLOCKS: ['refresh-enabled','model-batches'].includes(stage) ? 'enabled' : 'disabled' },
  publication: { STORAGE_ANALYTICS_SHARED_FEATURES: ['refresh-enabled','shared-publication'].includes(stage) ? 'enabled' : 'disabled', STORAGE_ANALYTICS_MODEL_BLOCKS: 'disabled' },
  cache: { CACHE_RETENTION_SHARED_FEATURES: ['refresh-enabled','shared-cache'].includes(stage) ? 'enabled' : 'disabled' },
});
const withoutMutableVars = vars => Object.fromEntries(Object.entries(vars).filter(([name]) => name !== 'DEPLOYMENT_SOURCE_COMMIT' && !Object.values(FLAGS).some(list => list.includes(name))));
const bindingId = binding => binding.id ?? binding.database_id;
const secretNames = bindings => bindings.filter(b => ['secret_text','secret_key'].includes(b.type)).map(b => `${b.type}:${b.name}`).sort();
const same = (left,right) => identityDigest(left??null)===identityDigest(right??null);
export function scheduledSettingsStableDigest(settings){
  const stable=structuredClone(settings);delete stable.bindings;
  if(stable.annotations){
    delete stable.annotations['workers/message'];delete stable.annotations['workers/tag'];delete stable.annotations['workers/triggered_by'];
  }
  return identityDigest(stable);
}

async function safeFile(path, limit = 8 * 1024 * 1024) {
  const full = resolve(path), stat = await lstat(full);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > limit || await realpath(full) !== full || stat.mode & 0o077) fail('FILE_UNSAFE');
  return readFile(full);
}

export function validateScheduledAnalyticsPlan(plan, now = Date.now(), allowExpired = false) {
  const refresh = plan?.stage === 'refresh-enabled';
  if (!keys(plan, ['schema','createdAt','expiresAt','stage','candidateSourceCommit','previousSourceCommit','accountId','wranglerSha256','packageManifestSha256','database','disabledOperation','roles',...(refresh ? ['forwardMigration'] : [])])
    || plan.schema !== 'scheduled-analytics-rollout-v1' || !Object.hasOwn(STAGES,plan.stage)
    || !COMMIT.test(plan.candidateSourceCommit) || !COMMIT.test(plan.previousSourceCommit)
    || !/^[a-f0-9]{32}$/.test(plan.accountId) || !SHA.test(plan.wranglerSha256) || !SHA.test(plan.packageManifestSha256)
    || !Number.isFinite(Date.parse(plan.createdAt)) || !Number.isFinite(Date.parse(plan.expiresAt))
    || Date.parse(plan.createdAt) > now || (!allowExpired && Date.parse(plan.expiresAt) <= now)
    || Date.parse(plan.expiresAt) - Date.parse(plan.createdAt) > 86_400_000
    || (['deploy-disabled','refresh-enabled'].includes(plan.stage) ? plan.disabledOperation !== null : typeof plan.disabledOperation !== 'string')
    || refresh && (plan.previousSourceCommit !== REFRESH_PREVIOUS_SOURCE
      || plan.candidateSourceCommit === REFRESH_PREVIOUS_SOURCE
      || !keys(plan.forwardMigration,['operationDirectory','planSha256','receiptSha256'])
      || typeof plan.forwardMigration.operationDirectory !== 'string'
      || resolve(plan.forwardMigration.operationDirectory)!==plan.forwardMigration.operationDirectory
      || plan.forwardMigration.operationDirectory.length>4096
      || /[\0\r\n]/.test(plan.forwardMigration.operationDirectory)
      || !SHA.test(plan.forwardMigration.planSha256)
      || !SHA.test(plan.forwardMigration.receiptSha256))) fail('PLAN_INVALID');
  const d = plan.database;
  if (!keys(d,['id','schemaSha256','migrations']) || !UUID.test(d.id) || !SHA.test(d.schemaSha256)
    || !Array.isArray(d.migrations) || d.migrations.length !== (refresh ? 32 : 31)
    || d.migrations.some(m => !keys(m,['name','sha256']) || !/^\d{4}_[a-z0-9_-]+\.sql$/.test(m.name) || !SHA.test(m.sha256))
    || d.migrations.slice(-3).map(m => m.name).join() !== (refresh
      ? '0031_analytics_model_block_clipped_ranges.sql,0032_analytics_shared_features.sql,0033_cache_retention_owner_cursor.sql'
      : '0030_analytics_model_blocks.sql,0031_analytics_model_block_clipped_ranges.sql,0032_analytics_shared_features.sql')) fail('DATABASE_PIN_INVALID');
  if (!Array.isArray(plan.roles) || plan.roles.length !== 3 || plan.roles.map(x=>x.role).join() !== ROLES.join()
    || new Set(plan.roles.map(x=>x.name)).size !== 3) fail('ROLES_INVALID');
  for (const role of plan.roles) {
    if (!keys(role,['role','name','bundleSha256','configPath','configSha256','d1Bindings','predecessor']) || !SHA.test(role.bundleSha256)
      || typeof role.configPath !== 'string' || !SHA.test(role.configSha256) || role.name.length > 63
      || !ROLE_NAMES[role.role].test(role.name)) fail('ROLE_INVALID');
    if(!Array.isArray(role.d1Bindings)||role.d1Bindings.length<1||role.d1Bindings.length>8
      ||role.d1Bindings.some(x=>!keys(x,['binding','databaseId'])||!/^[A-Z][A-Z0-9_]{0,63}$/.test(x.binding)||!UUID.test(x.databaseId))
      ||new Set(role.d1Bindings.map(x=>x.binding)).size!==role.d1Bindings.length
      ||role.d1Bindings.find(x=>x.binding==='STORAGE_ANALYTICS_DB')?.databaseId!==d.id)fail('RESOURCE_PIN_INVALID');
    const p=role.predecessor;
    if (!keys(p,['versionId','sourceCommit','bindingsSha256','settingsSha256','settingsStableSha256','runtimeSha256','ingressSha256','schedules','secretNames','otherBindingsSha256','provenanceOperation']) || !UUID.test(p.versionId)
      || !COMMIT.test(p.sourceCommit) || !SHA.test(p.bindingsSha256) || !SHA.test(p.settingsSha256) || !SHA.test(p.settingsStableSha256)
      || !SHA.test(p.runtimeSha256) || !SHA.test(p.ingressSha256)
      || !SHA.test(p.otherBindingsSha256) || !Array.isArray(p.secretNames) || p.secretNames.length > 32
      || p.secretNames.some(x=>typeof x!=='string'||!/^secret_(?:text|key):[A-Z][A-Z0-9_]{0,63}$/.test(x))
      || !Array.isArray(p.schedules) || p.schedules.length > 8 || p.schedules.some(x => typeof x !== 'string' || x.length > 100)
      || (plan.stage === 'deploy-disabled' ? p.provenanceOperation !== null : typeof p.provenanceOperation !== 'string' || !p.provenanceOperation)) fail('PREDECESSOR_INVALID');
  }
  return structuredClone(plan);
}

function validateExtension(extension,approvedSha256,planSha256,now){
  if(!keys(extension,['schema','planSha256','approvedAt','expiresAt'])
    ||extension.schema!=='scheduled-analytics-approval-extension-v1'||extension.planSha256!==planSha256
    ||!SHA.test(approvedSha256??'')||identityDigest(extension)!==approvedSha256
    ||!Number.isFinite(Date.parse(extension.approvedAt))||!Number.isFinite(Date.parse(extension.expiresAt))
    ||Date.parse(extension.approvedAt)>now||Date.parse(extension.expiresAt)<=now
    ||Date.parse(extension.expiresAt)-Date.parse(extension.approvedAt)>86_400_000)fail('EXTENSION_INVALID');
  return structuredClone(extension);
}

async function verifyPackage(plan, packageRoot) {
  const manifestBytes=await safeFile(join(packageRoot,'manifest.json'),1024*1024);
  if(hash(manifestBytes)!==plan.packageManifestSha256)fail('PACKAGE_CHANGED');
  const manifest=JSON.parse(manifestBytes);
  if(manifest.sourceCommit!==plan.candidateSourceCommit || manifest.status!=='local-qualified' || manifest.remoteWrites!==false)fail('PACKAGE_INVALID');
  const files=new Map(manifest.files.map(x=>[x.path,x.sha256]));
  const qualificationPath='migrations/worker/analytics-migrations/qualification.json';
  const qualificationBytes=await safeFile(join(packageRoot,qualificationPath),256*1024);
  if(files.get(qualificationPath)!==hash(qualificationBytes))fail('QUALIFICATION_CHANGED');
  const qualification=JSON.parse(qualificationBytes);
  if(qualification.status!=='qualified'||qualification.role!=='analytics'||qualification.sourceCommit!==plan.candidateSourceCommit
    ||JSON.stringify(qualification.migrations.map(x=>({name:x.name,sha256:x.sha256})))!==JSON.stringify(plan.database.migrations)
    ||qualification.migrations.at(-1)?.afterSchemaSha256!==plan.database.schemaSha256)fail('QUALIFICATION_MISMATCH');
  for(const role of plan.roles){
    const path=`artifacts/${role.role}/${FILES[role.role]}`;
    const bundle=await safeFile(join(packageRoot,path));
    if(hash(bundle)!==role.bundleSha256||files.get(path)!==role.bundleSha256)fail('BUNDLE_CHANGED');
    const config=JSON.parse(await safeFile(role.configPath,256*1024));
    if(hash(await safeFile(role.configPath,256*1024))!==role.configSha256)fail('CONFIG_CHANGED');
    const basePath=join(packageRoot,'artifacts',`${role.role}-retained-upload.json`);
    const baseBytes=await safeFile(basePath,256*1024),base=JSON.parse(baseBytes);
    if(files.get(`artifacts/${role.role}-retained-upload.json`)!==hash(baseBytes))fail('BASE_CONFIG_CHANGED');
    if(config.main!==join(packageRoot,path)||config.no_bundle!==true||config.keep_vars!==true||config.workers_dev!==false
      || config.name!==role.name||config.vars?.DEPLOYMENT_SOURCE_COMMIT!==plan.candidateSourceCommit
      || JSON.stringify({...base,vars:{...base.vars,...Object.fromEntries(FLAGS[role.role].map(k=>[k,config.vars[k]]))}})!==JSON.stringify(config))fail('CONFIG_INVALID');
    const expected=requiredFlags(plan.stage)[role.role];
    if(STAGES[plan.stage].includes(role.role) && Object.entries(expected).some(([k,v])=>config.vars[k]!==v))fail('CONTROL_STAGE_INVALID');
    if(plan.stage==='refresh-enabled'&&role.role==='cache'&&config.vars.CACHE_RETENTION_BUILD!=='enabled')fail('CONTROL_STAGE_INVALID');
    if(!Array.isArray(config.d1_databases)||config.d1_databases.length!==role.d1Bindings.length
      ||role.d1Bindings.some(x=>!config.d1_databases.some(y=>y.binding===x.binding&&y.database_id===x.databaseId)))fail('DATABASE_BINDING_CHANGED');
  }
  return manifest;
}

/** The enabled refresh depends on both additive migrations having completed
 * against the exact predecessor inventory. The receipt is independently
 * pinned by raw file hashes; the migration operator validates its contents
 * and completed journal rather than trusting a file's mere presence. */
async function verifyForwardMigrationProof(plan){
  if(plan.stage!=='refresh-enabled')return null;
  const pin=plan.forwardMigration;
  let migration,receipt,operation;
  try{
    const planBytes=await safeFile(join(pin.operationDirectory,'plan.json'),1024*1024);
    const receiptBytes=await safeFile(join(pin.operationDirectory,'receipt.json'),1024*1024);
    if(hash(planBytes)!==pin.planSha256||hash(receiptBytes)!==pin.receiptSha256)fail('MIGRATION_PROOF_CHANGED');
    migration=JSON.parse(planBytes);receipt=JSON.parse(receiptBytes);
    operation=await readOperation(pin.operationDirectory);
    verifyExistingRoleForwardReceipt({plan:migration,receipt,operation});
  }catch{fail('MIGRATION_PROOF_INVALID');}
  const primary=migration.targets.find(item=>item.role==='primary');
  const analytics=migration.targets.find(item=>item.role==='analytics');
  const reviewedSteps=await loadExistingRoleForwardSteps({workerDirectory:join(dirname(fileURLToPath(import.meta.url)),'..')});
  if(migration.accountId!==plan.accountId||migration.sourceCommit!==plan.candidateSourceCommit
    ||migration.previousScheduledSourceCommit!==REFRESH_PREVIOUS_SOURCE
    ||primary?.migrationName!==reviewedSteps[0]?.name
    ||primary?.migrationSha256!==reviewedSteps[0]?.sha256
    ||analytics?.migrationName!==reviewedSteps[1]?.name
    ||analytics?.migrationSha256!==reviewedSteps[1]?.sha256
    ||analytics.databaseId!==plan.database.id
    ||analytics.migrationSha256!==plan.database.migrations.at(-1)?.sha256
    ||analytics.afterSchemaSha256!==plan.database.schemaSha256)fail('MIGRATION_PROOF_MISMATCH');
  for(const [index,role] of plan.roles.entries()){
    const pin=migration.workerPins[index+1];
    if(pin?.workerName!==role.name||pin.versionId!==role.predecessor.versionId
      ||pin.sourceCommit!==role.predecessor.sourceCommit
      ||role.d1Bindings.find(item=>item.binding==='STORAGE_INGESTION_DB')?.databaseId!==primary.databaseId
      ||role.d1Bindings.find(item=>item.binding==='STORAGE_ANALYTICS_DB')?.databaseId!==analytics.databaseId)
      fail('MIGRATION_PROOF_MISMATCH');
  }
  return {id:primary.databaseId,schemaSha256:primary.afterSchemaSha256,
    migrations:[...primary.beforeLedger,{name:primary.migrationName,sha256:primary.migrationSha256}]};
}

function verifyPredecessor(role,snapshot,allowOwnUploadSettings=false){
  const p=role.predecessor;
  if(snapshot?.activeVersionId!==p.versionId || snapshot.sourceCommit!==p.sourceCommit
    || identityDigest(snapshot.bindings)!==p.bindingsSha256
    || (!allowOwnUploadSettings && snapshot.settingsSha256!==p.settingsSha256)
    || snapshot.settingsStableSha256!==p.settingsStableSha256
    || identityDigest(snapshot.runtime)!==p.runtimeSha256
    || identityDigest(snapshot.ingress)!==p.ingressSha256 || snapshot.ingress.subdomainEnabled!==false
    || snapshot.ingress.previewsEnabled!==false || snapshot.ingress.routes!==0 || snapshot.ingress.domains!==0
    || JSON.stringify(snapshot.schedules)!==JSON.stringify(p.schedules)
    || JSON.stringify(secretNames(snapshot.bindings))!==JSON.stringify(p.secretNames)
    || identityDigest(snapshot.bindings.filter(b=>!['secret_text','secret_key','plain_text','d1'].includes(b.type)))!==p.otherBindingsSha256)fail('PREDECESSOR_CHANGED');
}

function verifyConfigAgainstLive(role,config,snapshot,plan){
  const runtime=snapshot.runtime,settings=snapshot.settings;
  if(!runtime||!settings||config.compatibility_date!==runtime.compatibility_date
    ||!same(config.compatibility_flags,runtime.compatibility_flags)
    ||!same(config.limits,runtime.limits)
    ||!same(config.logpush,settings.logpush)
    ||!same(config.observability,settings.observability)
    ||!same(config.tail_consumers,settings.tail_consumers)
    ||!same(config.placement,settings.placement?.mode==='smart'?settings.placement:null))fail('RUNTIME_SETTINGS_CHANGED');
  const d1=snapshot.bindings.filter(x=>x.type==='d1');
  if(d1.length!==role.d1Bindings.length || d1.some(b=>!role.d1Bindings.some(x=>x.binding===b.name&&x.databaseId===bindingId(b)))
    ||role.d1Bindings.some(x=>!config.d1_databases.some(y=>y.binding===x.binding&&y.database_id===x.databaseId)))fail('DATABASE_BINDING_CHANGED');
  const plain=Object.fromEntries(snapshot.bindings.filter(b=>b.type==='plain_text').map(b=>[b.name,b.text]));
  if(identityDigest(withoutMutableVars(plain))!==identityDigest(withoutMutableVars(config.vars)))fail('VARS_CHANGED');
  if(JSON.stringify(config.triggers?.crons?.slice().sort())!==JSON.stringify(snapshot.schedules))fail('SCHEDULE_CHANGED');
  if(config.vars.DEPLOYMENT_SOURCE_COMMIT!==plan.candidateSourceCommit)fail('SOURCE_CHANGED');
}

function verifyVersion(role,config,version,tag){
  if(!version || !UUID.test(version.id) || version.tag!==tag || version.message!==tag
    || !Array.isArray(version.bindings) || identityDigest(version.runtime)!==role.predecessor.runtimeSha256)fail('VERSION_INVALID');
  const actual=version.bindings;
  if(JSON.stringify(secretNames(actual))!==JSON.stringify(role.predecessor.secretNames))fail('SECRET_NAMES_CHANGED');
  const nonSecrets=b=>!['secret_text','secret_key','plain_text','d1'].includes(b.type);
  if(identityDigest(actual.filter(nonSecrets))!==role.predecessor.otherBindingsSha256)fail('RESOURCE_BINDINGS_CHANGED');
  if(actual.filter(b=>b.type==='d1').length!==config.d1_databases.length
    ||actual.filter(b=>b.type==='d1').some(b=>!config.d1_databases.some(x=>x.binding===b.name&&x.database_id===bindingId(b))))fail('DATABASE_BINDING_CHANGED');
  const vars=actual.filter(b=>b.type==='plain_text');
  if(vars.length!==Object.keys(config.vars).length||vars.some(b=>config.vars[b.name]!==b.text))fail('VERSION_VARS_CHANGED');
}

/** Upload may rewrite /settings before it activates the new version. Prove
 * exactly that rewrite by restoring the old version's two annotations and
 * bindings, then requiring the original raw-settings plan hash. */
function verifyOwnUploadSettings(role,snapshot,predecessorVersion,uploadedVersion){
  const p=role.predecessor,settings=snapshot?.settings;
  if(!settings||typeof settings!=='object'||Array.isArray(settings)
    ||!settings.annotations||typeof settings.annotations!=='object'||Array.isArray(settings.annotations)
    ||!Array.isArray(settings.bindings)
    ||predecessorVersion?.id!==p.versionId||!Array.isArray(predecessorVersion.bindings)
    ||identityDigest(predecessorVersion.bindings)!==p.bindingsSha256
    ||identityDigest(predecessorVersion.runtime)!==p.runtimeSha256
    ||!Array.isArray(uploadedVersion?.bindings)
    ||snapshot.settingsSha256!==identityDigest(settings)
    ||snapshot.settingsStableSha256!==scheduledSettingsStableDigest(settings)
    ||snapshot.settingsStableSha256!==p.settingsStableSha256
    ||settings.annotations['workers/message']!==uploadedVersion.message
    ||settings.annotations['workers/tag']!==uploadedVersion.tag
    ||identityDigest(settings.bindings)!==identityDigest(uploadedVersion.bindings))fail('PREDECESSOR_CHANGED');
  const restored=structuredClone(settings);
  restored.bindings=predecessorVersion.bindings;
  for(const [key,value] of [['workers/message',predecessorVersion.message],['workers/tag',predecessorVersion.tag]]){
    if(value===undefined)delete restored.annotations[key];else restored.annotations[key]=value;
  }
  if(identityDigest(restored)!==p.settingsSha256)fail('PREDECESSOR_CHANGED');
}

function verifyPendingUploadPredecessor(role,snapshot,predecessorVersion,uploadedVersion){
  if(snapshot?.settingsSha256===role.predecessor.settingsSha256){verifyPredecessor(role,snapshot);return;}
  verifyOwnUploadSettings(role,snapshot,predecessorVersion,uploadedVersion);
  verifyPredecessor(role,snapshot,true);
}

function stagePrerequisites(stage,snapshots,source){
  if(stage==='deploy-disabled')return;
  if(stage==='refresh-enabled'){
    for(const role of ROLES){
      const expected={...requiredFlags(stage)[role],...(role==='cache'?{CACHE_RETENTION_BUILD:'enabled'}:{})};
      for(const [name,value] of Object.entries(expected)){
        const matches=snapshots[role].bindings.filter(binding=>binding.type==='plain_text'&&binding.name===name);
        if(matches.length!==1||matches[0].text!==value)fail('STAGE_ORDER');
      }
    }
    return;
  }
  for(const role of ['analytics','publication'])if(snapshots[role].sourceCommit!==source)fail('ERASURE_SCHEDULER_NOT_DEPLOYED');
  const vars=role=>Object.fromEntries(snapshots[role].bindings.filter(b=>b.type==='plain_text').map(b=>[b.name,b.text]));
  if(!['model-batches','disable-model','disable-graph','disable-cache','disable-publication'].includes(stage)
    &&vars('analytics').STORAGE_ANALYTICS_MODEL_BLOCKS!=='disabled')fail('STAGE_ORDER');
  if(stage==='shared-publication' && vars('analytics').STORAGE_ANALYTICS_SHARED_FEATURES!=='disabled')fail('STAGE_ORDER');
  if(stage==='shared-cache' && vars('analytics').STORAGE_ANALYTICS_SHARED_FEATURES!=='disabled')fail('STAGE_ORDER');
  if(stage==='shared-graph' && vars('analytics').STORAGE_ANALYTICS_SHARED_FEATURES!=='disabled')fail('STAGE_ORDER');
  if(['shared-cache','shared-graph','model-batches'].includes(stage) && vars('publication').STORAGE_ANALYTICS_SHARED_FEATURES!=='enabled')fail('STAGE_ORDER');
  if(['shared-graph','model-batches'].includes(stage) && vars('cache').CACHE_RETENTION_SHARED_FEATURES!=='enabled')fail('STAGE_ORDER');
  if(stage==='model-batches' && (vars('analytics').STORAGE_ANALYTICS_SHARED_FEATURES!=='enabled'||vars('analytics').STORAGE_ANALYTICS_MODEL_BLOCKS!=='disabled'))fail('STAGE_ORDER');
  if(stage==='disable-publication'&&(vars('publication').STORAGE_ANALYTICS_SHARED_FEATURES!=='enabled'
    ||vars('cache').CACHE_RETENTION_SHARED_FEATURES!=='disabled'||vars('analytics').STORAGE_ANALYTICS_SHARED_FEATURES!=='disabled'
    ||vars('analytics').STORAGE_ANALYTICS_MODEL_BLOCKS!=='disabled'))fail('STAGE_ORDER');
  if(stage==='disable-cache'&&(vars('cache').CACHE_RETENTION_SHARED_FEATURES!=='enabled'
    ||vars('analytics').STORAGE_ANALYTICS_SHARED_FEATURES!=='disabled'||vars('analytics').STORAGE_ANALYTICS_MODEL_BLOCKS!=='disabled'))fail('STAGE_ORDER');
  if(stage==='disable-graph'&&(vars('analytics').STORAGE_ANALYTICS_SHARED_FEATURES!=='enabled'
    ||vars('analytics').STORAGE_ANALYTICS_MODEL_BLOCKS!=='disabled'))fail('STAGE_ORDER');
  if(stage==='disable-model'&&vars('analytics').STORAGE_ANALYTICS_MODEL_BLOCKS!=='enabled')fail('STAGE_ORDER');
}

export async function runScheduledAnalyticsRollout({plan,packageRoot,operationDirectory,repositoryRoot,execute=false,resume=false,reconcile=false,executorStopped=false,
  confirmation,approvedPlanSha256,extension,approvedExtensionSha256,provider,lockFactory=()=>createProductionDeploymentLock({repositoryRoot}),clock=Date.now}){
  if(execute&&reconcile || resume&&!execute&&!reconcile || executorStopped&&!resume
    || reconcile&&!resume || resume&&!executorStopped
    || !execute&&!reconcile&&(confirmation!==undefined||approvedPlanSha256!==undefined)
    || Boolean(extension)!==Boolean(approvedExtensionSha256)
    || extension&&(!execute||!resume||reconcile))fail('ARGUMENTS');
  const now=clock();
  plan=validateScheduledAnalyticsPlan(plan,now,reconcile||resume);
  const planSha256=identityDigest(plan);
  const approvedExtension=extension?validateExtension(extension,approvedExtensionSha256,planSha256,now):null;
  await verifyPackage(plan,packageRoot);
  const sourceDatabasePin=await verifyForwardMigrationProof(plan);
  if(!execute&&!reconcile)return {status:'planned',planSha256,stage:plan.stage,remoteWrites:false};
  if(approvedPlanSha256!==planSha256||!provider||!repositoryRoot||!operationDirectory)fail('EXECUTION_NOT_APPROVED');
  if(reconcile?(!executorStopped||confirmation!=='RECONCILE_SCHEDULED_ANALYTICS'):confirmation!=='DEPLOY_REVIEWED_SCHEDULED_ANALYTICS')fail('EXECUTION_NOT_APPROVED');
  if(reconcile&&!resume||resume&&!executorStopped)fail('EXECUTOR_STATE_REQUIRED');
  const operation=await openOperation({directory:operationDirectory,kind:'production',binding:plan,resume});
  const lock=lockFactory();let state=operation.record.state;
  try{
    if(plan.stage==='refresh-enabled'&&(typeof lock.isAncestor!=='function'
      ||!lock.isAncestor(plan.previousSourceCommit,plan.candidateSourceCommit)))fail('SOURCE_ANCESTRY_INVALID');
    if(!resume){
      const snapshots={};for(const role of plan.roles){snapshots[role.role]=await provider.snapshot(role);verifyPredecessor(role,snapshots[role.role]);}
      stagePrerequisites(plan.stage,snapshots,plan.candidateSourceCommit);
      if(typeof provider.versionInventory!=='function')fail('PROVIDER_INVALID');
      for(const role of plan.roles)await provider.versionInventory(role);
      const database=await provider.databaseState(plan.database);
      if(database.schemaSha256!==plan.database.schemaSha256||JSON.stringify(database.migrations)!==JSON.stringify(plan.database.migrations))fail('SCHEMA_OR_LEDGER_CHANGED');
      if(sourceDatabasePin){
        const source=await provider.databaseState(sourceDatabasePin);
        if(source.schemaSha256!==sourceDatabasePin.schemaSha256
          ||JSON.stringify(source.migrations)!==JSON.stringify(sourceDatabasePin.migrations))fail('SOURCE_SCHEMA_OR_LEDGER_CHANGED');
      }
      if(plan.stage==='refresh-enabled'){
        for(const role of plan.roles){
          const prior=await readOperation(role.predecessor.provenanceOperation).catch(()=>fail('PREDECESSOR_PROOF_MISSING'));
          if(prior.kind!=='production'||prior.state?.status!=='completed'
            ||prior.state?.stage!==REFRESH_PREVIOUS_STAGES[role.role]
            ||prior.state?.candidateSourceCommit!==REFRESH_PREVIOUS_SOURCE
            ||prior.state.deployed?.[role.role]?.versionId!==role.predecessor.versionId
            ||!SHA.test(prior.state.deployed?.[role.role]?.bundleSha256??''))fail('PREDECESSOR_PROOF_MISSING');
        }
      }else if(plan.stage!=='deploy-disabled'){
        const prior=await readOperation(plan.disabledOperation).catch(()=>fail('ERASURE_PROOF_MISSING'));
        if(prior.kind!=='production'||prior.state?.status!=='completed'||prior.state?.stage!=='deploy-disabled'||prior.state?.candidateSourceCommit!==plan.candidateSourceCommit
          ||prior.state.deployed?.analytics?.bundleSha256!==plan.roles[0].bundleSha256
          ||prior.state.deployed?.publication?.bundleSha256!==plan.roles[1].bundleSha256)fail('ERASURE_PROOF_MISSING');
        for(const role of plan.roles){
          const proof=await readOperation(role.predecessor.provenanceOperation).catch(()=>fail('ERASURE_PROOF_MISSING'));
          if(proof.kind!=='production'||proof.state?.status!=='completed'||proof.state?.candidateSourceCommit!==plan.candidateSourceCommit
            ||proof.state.deployed?.[role.role]?.versionId!==role.predecessor.versionId
            ||proof.state.deployed?.[role.role]?.bundleSha256!==role.bundleSha256)fail('ERASURE_PROOF_MISSING');
        }
      }
      const owner=lock.createOwner({id:operation.record.id,sourceCommit:plan.candidateSourceCommit,previousSourceCommit:plan.previousSourceCommit});
      state={status:'lock_intent',stage:plan.stage,candidateSourceCommit:plan.candidateSourceCommit,owner,index:0,deployed:{}};
      await operation.save(state);lock.acquire(owner);state.status='running';await operation.save(state);
    }else{
      if(!state.owner||state.stage!==plan.stage||state.candidateSourceCommit!==plan.candidateSourceCommit)fail('JOURNAL_INVALID');
      if(state.status!=='release_intent'&&state.status!=='lock_intent')lock.assertOwned(state.owner);
      if(approvedExtension){state.approvalExtension=approvedExtension;await operation.save(state);}
    }
    const assertMutationWindow=()=>{
      const deadline=state.approvalExtension?.expiresAt??plan.expiresAt;
      if(Date.parse(deadline)<=clock())fail('APPROVAL_EXPIRED');
    };
    const targets=STAGES[plan.stage];
    if(state.status==='lock_intent'){
      if(!reconcile)fail('RECONCILIATION_REQUIRED');
      const held=lock.status();
      if(held===null){state.status='aborted';await operation.save(state);return {status:'aborted',planSha256,stage:plan.stage,lock:'absent'};}
      if(held!==state.owner)fail('LOCK_CHANGED');
      state.status='running';await operation.save(state);
      return {status:'reconciled',planSha256,stage:plan.stage,index:0,lock:'held'};
    }
    if(state.status==='upload_intent'||state.status==='deploy_intent'){
      if(!reconcile)fail('RECONCILIATION_REQUIRED');
      const role=plan.roles.find(r=>r.role===targets[state.index]);const tag=`scheduled-${plan.stage}-${operation.record.id}-${role.role}`;
      const config=JSON.parse(await safeFile(role.configPath,256*1024));
      const version=await provider.findTagged(role,tag);
      if(!version)fail('REMOTE_OUTCOME_UNCERTAIN');
      verifyVersion(role,config,version,tag);
      if(state.status==='upload_intent'){
        const predecessorVersion=await provider.version(role,role.predecessor.versionId);
        verifyPendingUploadPredecessor(role,await provider.snapshot(role),predecessorVersion,version);
        state.status='uploaded';state.versionId=version.id;await operation.save(state);
      }else{
        if(!UUID.test(state.versionId)||version.id!==state.versionId)fail('REMOTE_OUTCOME_UNCERTAIN');
        const current=await provider.snapshot(role);
        if(current.activeVersionId!==version.id||current.sourceCommit!==plan.candidateSourceCommit
          ||current.settingsStableSha256!==role.predecessor.settingsStableSha256
          ||identityDigest(current.ingress)!==role.predecessor.ingressSha256
          ||JSON.stringify(current.schedules)!==JSON.stringify(role.predecessor.schedules)
          ||identityDigest(current.bindings)!==identityDigest(version.bindings))fail('REMOTE_OUTCOME_UNCERTAIN');
        verifyOwnUploadSettings(role,current,await provider.version(role,role.predecessor.versionId),version);
        state.deployed[role.role]={versionId:version.id,bundleSha256:role.bundleSha256};state.index++;state.status='running';delete state.versionId;await operation.save(state);
      }
      return {status:'reconciled',planSha256,stage:plan.stage,index:state.index,lock:'held'};
    }
    const recheckLive=async(afterStage=false)=>{
      const snapshots={};
      for(const item of plan.roles){
        const snapshot=await provider.snapshot(item);snapshots[item.role]=snapshot;
        const deployed=state.deployed[item.role];
        if(deployed){
          if(snapshot.activeVersionId!==deployed.versionId||snapshot.sourceCommit!==plan.candidateSourceCommit
            ||snapshot.settingsStableSha256!==item.predecessor.settingsStableSha256
            ||identityDigest(snapshot.ingress)!==item.predecessor.ingressSha256
            ||JSON.stringify(snapshot.schedules)!==JSON.stringify(item.predecessor.schedules))fail('DEPLOYMENT_DRIFT');
          const config=JSON.parse(await safeFile(item.configPath,256*1024));
          const tag=`scheduled-${plan.stage}-${operation.record.id}-${item.role}`;
          const version=await provider.version(item,deployed.versionId);
          verifyVersion(item,config,version,tag);
          if(identityDigest(snapshot.bindings)!==identityDigest(version.bindings))fail('DEPLOYMENT_DRIFT');
          verifyOwnUploadSettings(item,snapshot,await provider.version(item,item.predecessor.versionId),version);
          verifyConfigAgainstLive(item,config,snapshot,plan);
        }
        else if(item.role===targets[state.index]&&['uploaded','deploy_intent'].includes(state.status)){
          if(!UUID.test(state.versionId))fail('JOURNAL_INVALID');
          const config=JSON.parse(await safeFile(item.configPath,256*1024));
          const tag=`scheduled-${plan.stage}-${operation.record.id}-${item.role}`;
          const version=await provider.version(item,state.versionId);verifyVersion(item,config,version,tag);
          verifyPendingUploadPredecessor(item,snapshot,await provider.version(item,item.predecessor.versionId),version);
        }else verifyPredecessor(item,snapshot);
      }
      if(!afterStage)stagePrerequisites(plan.stage,snapshots,plan.candidateSourceCommit);
      await verifyForwardMigrationProof(plan);
      const database=await provider.databaseState(plan.database);
      if(database.schemaSha256!==plan.database.schemaSha256||JSON.stringify(database.migrations)!==JSON.stringify(plan.database.migrations))fail('SCHEMA_OR_LEDGER_CHANGED');
      if(sourceDatabasePin){
        const source=await provider.databaseState(sourceDatabasePin);
        if(source.schemaSha256!==sourceDatabasePin.schemaSha256
          ||JSON.stringify(source.migrations)!==JSON.stringify(sourceDatabasePin.migrations))fail('SOURCE_SCHEMA_OR_LEDGER_CHANGED');
      }
      return snapshots;
    };
    if(state.status==='release_intent'){
      if(!reconcile)fail('RECONCILIATION_REQUIRED');
      await recheckLive(true);
      const held=lock.status();
      if(held!==null && held!==state.owner)fail('LOCK_CHANGED');
      if(held===state.owner)lock.release(state.owner);
      state.status='completed';await operation.save(state);
      return {status:'completed',planSha256,stage:plan.stage,deployed:state.deployed,lock:'released'};
    }
    if(reconcile)fail('NO_PENDING_INTENT');
    for(;state.index<targets.length;){
      lock.assertOwned(state.owner);
      const role=plan.roles.find(r=>r.role===targets[state.index]);const config=JSON.parse(await safeFile(role.configPath,256*1024));
      const current=(await recheckLive())[role.role];verifyConfigAgainstLive(role,config,current,plan);
      const tag=`scheduled-${plan.stage}-${operation.record.id}-${role.role}`;
      if(state.status==='running'){
        if(await provider.findTagged(role,tag))fail('UNEXPECTED_TAGGED_VERSION');
        assertMutationWindow();
        state.status='upload_intent';await operation.save(state);lock.assertOwned(state.owner);
        await recheckLive();
        await verifyPackage(plan,packageRoot);
        assertMutationWindow();
        await provider.upload(role,tag);
        const version=await provider.findTagged(role,tag);
        if(!version)fail('UPLOAD_OUTCOME_UNCERTAIN');
        verifyVersion(role,config,version,tag);
        state.status='uploaded';state.versionId=version.id;await operation.save(state);
      }
      if(state.status!=='uploaded'||!UUID.test(state.versionId))fail('JOURNAL_INVALID');
      const version=await provider.version(role,state.versionId);verifyVersion(role,config,version,tag);
      lock.assertOwned(state.owner);await recheckLive();
      assertMutationWindow();
      state.status='deploy_intent';await operation.save(state);lock.assertOwned(state.owner);
      await recheckLive();
      await verifyPackage(plan,packageRoot);
      assertMutationWindow();
      await provider.deploy(role,state.versionId);
      const after=await provider.snapshot(role);
      if(after.activeVersionId!==state.versionId)fail('DEPLOY_OUTCOME_UNCERTAIN');
      if(after.sourceCommit!==plan.candidateSourceCommit||after.settingsStableSha256!==role.predecessor.settingsStableSha256
        ||identityDigest(after.ingress)!==role.predecessor.ingressSha256
        ||JSON.stringify(after.schedules)!==JSON.stringify(role.predecessor.schedules))fail('DEPLOY_CONFIG_CHANGED');
      const deployedVersion=await provider.version(role,state.versionId);
      verifyVersion(role,config,deployedVersion,tag);
      verifyOwnUploadSettings(role,after,await provider.version(role,role.predecessor.versionId),deployedVersion);
      state.deployed[role.role]={versionId:state.versionId,bundleSha256:role.bundleSha256};state.index++;state.status='running';delete state.versionId;await operation.save(state);
    }
    lock.assertOwned(state.owner);await recheckLive(true);
    state.status='release_intent';await operation.save(state);lock.assertOwned(state.owner);lock.release(state.owner);
    state.status='completed';await operation.save(state);
    return {status:'completed',planSha256,stage:plan.stage,deployed:state.deployed,lock:'released'};
  }finally{operation.close();}
}

export function createScheduledAnalyticsProvider({plan,operationDirectory,cliPath,fetcher,spawn,environment}){
  const transport=createMaintenanceTransport({plan,operationDirectory,cliPath,fetcher,spawn,environment});
  const account=`/accounts/${plan.accountId}`;
  const script=role=>`${account}/workers/scripts/${role.name}`;
  const rows=(value,key,max=128)=>{const result=key?value?.[key]:value;if(!Array.isArray(result)||result.length>max)fail('REMOTE_SHAPE_INVALID');return result;};
  const version=async(role,id)=>{const value=await transport.api(`${script(role)}/versions/${id}`);return {id:value.id,tag:value.annotations?.['workers/tag'],message:value.annotations?.['workers/message'],bindings:value.resources?.bindings,runtime:value.resources?.script_runtime};};
  return {
    async snapshot(role){
      const deployments=rows(await transport.api(`${script(role)}/deployments?per_page=100`),'deployments',100);
      const versions=deployments[0]?.versions;
      if(!Array.isArray(versions)||versions.length!==1||versions[0].percentage!==100||!UUID.test(versions[0].version_id))fail('DEPLOYMENT_AMBIGUOUS');
      const active=await version(role,versions[0].version_id);
      if(!Array.isArray(active.bindings))fail('VERSION_INVALID');
      const settings=await transport.api(`${script(role)}/settings`);
      const schedules=rows(await transport.api(`${script(role)}/schedules`),'schedules').map(x=>x.cron).sort();
      const subdomain=await transport.api(`${script(role)}/subdomain`);
      const routes=rows(await transport.api(`${account}/workers/services/${role.name}/environments/production/routes?show_zonename=true`),undefined,100);
      const domains=rows(await transport.api(`${account}/workers/domains/records?page=0&per_page=100&service=${role.name}&environment=production`),undefined,99);
      const ingress={subdomainEnabled:subdomain.enabled,previewsEnabled:subdomain.previews_enabled,routes:routes.length,domains:domains.length};
      const sources=active.bindings.filter(x=>x.type==='plain_text'&&x.name==='DEPLOYMENT_SOURCE_COMMIT');
      if(sources.length!==1||!COMMIT.test(sources[0].text))fail('SOURCE_UNAVAILABLE');
      return {activeVersionId:active.id,sourceCommit:sources[0].text,bindings:active.bindings,runtime:active.runtime,settings,ingress,
        settingsSha256:identityDigest(settings),settingsStableSha256:scheduledSettingsStableDigest(settings),schedules};
    },
    async databaseState(database){
      const path=`${account}/d1/database/${database.id}/query`;
      const schema=rows(await transport.api(path,{sql:"SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND tbl_name <> 'd1_storage_migrations' ORDER BY type,name LIMIT 4097",params:[]}));
      const ledger=rows(await transport.api(path,{sql:'SELECT name,sha256 FROM d1_storage_migrations ORDER BY name LIMIT 129',params:[]}));
      if(schema.length!==1||schema[0].success!==true||!Array.isArray(schema[0].results)||schema[0].results.length>4096
        ||ledger.length!==1||ledger[0].success!==true||!Array.isArray(ledger[0].results)||ledger[0].results.length>128)fail('DATABASE_READ_INVALID');
      return {schemaSha256:storageSchemaDigest(schema[0].results),migrations:ledger[0].results};
    },
    version,
    // Reserve one bounded inventory slot for this operation's tagged upload.
    async versionInventory(role){rows(await transport.api(`${script(role)}/versions?deployable=true`),'items',127);return true;},
    async findTagged(role,tag){const all=rows(await transport.api(`${script(role)}/versions?deployable=true`),'items').filter(x=>x.annotations?.['workers/tag']===tag);if(all.length>1)fail('TAG_AMBIGUOUS');return all.length?version(role,all[0].id):null;},
    upload:(role,tag)=>transport.run({step:`${role.role}-upload`,args:['versions','upload','--tag',tag,'--message',tag],config:role.configPath,directory:operationDirectory}),
    deploy:(role,id)=>transport.run({step:`${role.role}-deploy`,args:['versions','deploy',`${id}@100%`,'--yes'],config:role.configPath,directory:operationDirectory}),
  };
}

function parseArgs(argv){
  const args={execute:false,resume:false,reconcile:false,executorStopped:false};
  const boolean=new Set(['execute','resume','reconcile','executor-stopped']);
  const values=new Set(['plan','package','operation','repository-root','cli','approved-plan-sha256','confirmation','extension','approved-extension-sha256']);
  for(let i=0;i<argv.length;i++){
    const key=argv[i].startsWith('--')?argv[i].slice(2):'';
    if(boolean.has(key)){if(args[key])fail('ARGUMENTS');args[key]=true;}
    else if(values.has(key)&&!Object.hasOwn(args,key)&&argv[i+1]&&!argv[i+1].startsWith('--'))args[key]=argv[++i];
    else fail('ARGUMENTS');
  }
  if(!args.plan||!args.package||(args.execute||args.reconcile)&&(!args.operation||!args['repository-root']||!args.cli))fail('ARGUMENTS');
  return args;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=parseArgs(process.argv.slice(2));
    const plan=JSON.parse(await safeFile(args.plan,256*1024));
    const extension=args.extension?JSON.parse(await safeFile(args.extension,4096)):undefined;
    const provider=args.execute||args.reconcile?createScheduledAnalyticsProvider({plan,operationDirectory:args.operation,cliPath:args.cli}):undefined;
    const result=await runScheduledAnalyticsRollout({plan,packageRoot:args.package,operationDirectory:args.operation,
      repositoryRoot:args['repository-root'],execute:args.execute,resume:args.resume,reconcile:args.reconcile,
      executorStopped:args['executor-stopped'],confirmation:args.confirmation,approvedPlanSha256:args['approved-plan-sha256'],
      extension,approvedExtensionSha256:args['approved-extension-sha256'],provider});
    process.stdout.write(JSON.stringify(result)+'\n');
  }catch(error){process.stderr.write(/^SCHEDULED_ANALYTICS_[A-Z_]+$/.test(error?.code??'')?error.code+'\n':'SCHEDULED_ANALYTICS_FAILED\n');process.exitCode=1;}
}
