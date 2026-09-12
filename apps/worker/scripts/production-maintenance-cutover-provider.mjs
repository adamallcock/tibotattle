import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, lstat, realpath, readdir, symlink, readlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { parse } from 'jsonc-parser';
import { createImmutableSourceSnapshot, dependencyTreeDigest, recheckProductionHealth, recheckProductionPublicSurface } from './production-deploy.mjs';
import { stageProductionAssets } from './stage-production-assets.mjs';
import { initializeMaintenanceAnalyticsRegistration, readMaintenanceAnalyticsRegistration, MAINTENANCE_ANALYTICS_REGISTRATION_SQL, MAINTENANCE_ANALYTICS_REGISTRATION_INSERT } from './production-maintenance-analytics-registration.mjs';
import { parseMaintenanceTailCapture } from './production-maintenance-analytics-provider.mjs';
import { createMaintenanceTransport } from './production-maintenance-transport.mjs';
import { createMaintenanceProvider, maintenanceBindingDigest } from './production-maintenance-provider.mjs';
import { maintenanceHash, readMaintenanceFile } from './production-maintenance.mjs';
import { verifyMaintenanceCutoverProof, MAINTENANCE_CUTOVER_PROOF_SQL } from './production-maintenance-cutover-proof.mjs';
import { identityDigest, operationError } from '../../../scripts/lib/release-operation.mjs';
const fail=code=>{throw operationError(`PRODUCTION_MAINTENANCE_CUTOVER_${code}`);};
const uuid=value=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value??'');
const git=(root,args)=>execFileSync('/usr/bin/git',['-c',`core.excludesFile=${join(dirname(root),'git-exclude')}`,'-C',root,...args],{encoding:'utf8',maxBuffer:1024*1024}).trim();
function source(root,commit){if(git(root,['rev-parse','HEAD'])!==commit||git(root,['status','--porcelain','--untracked-files=all']))fail('SOURCE_CHANGED');}
function object(value){return value&&typeof value==='object'&&!Array.isArray(value);}
const rows=(value,key,limit)=>{const result=Array.isArray(value)?value:value?.[key];if(!Array.isArray(result)||result.length>limit)fail('OBSERVATION_INVALID');return result;};

/** The only configuration transform admitted at the typed boundary. Existing
 * production auth, R2, DO, rate limits and site settings remain source-owned. */
export function renderMaintenanceCutoverConfig(config,plan,cutover){
 if(!object(config)||!object(config.env?.production))fail('CONFIG_INVALID');
 const base={...config,...config.env.production};delete base.env;
 const c=cutover.candidate,host=new URL(plan.origin).hostname;
 if(base.name!==plan.workerName||base.main!=='src/index.ts'||base.workers_dev!==false||base.preview_urls!==false
  ||base.vars?.PUBLIC_ORIGIN!==plan.origin||base.build||base.services?.length||base.queues?.consumers?.length
  ||JSON.stringify(base.routes?.map(r=>({pattern:r.pattern,custom_domain:r.custom_domain})).sort((a,b)=>a.pattern.localeCompare(b.pattern)))!==JSON.stringify([host,'www.'+host,'admin.'+host].sort().map(pattern=>({pattern,custom_domain:true})))
  ||base.durable_objects?.bindings?.length!==1||base.durable_objects.bindings[0].class_name!=='UploadIngressBudget'
  ||base.durable_objects.bindings[0].script_name||base.migrations?.at(-1)?.tag!==plan.predecessor.migrationTag)fail('CONFIG_INVALID');
 const db=base.d1_databases;
 if(!Array.isArray(db)||db.length!==2||!db.some(d=>d.binding==='USAGE_MONITOR_DB'&&d.database_id===plan.databaseId)
  ||!db.some(d=>d.binding==='DELETION_LEDGER'&&d.database_id===c.deletionLedgerDatabaseId))fail('CONFIG_DATABASE_MISMATCH');
 base.account_id=plan.accountId;
 base.main='../../apps/worker/src/index.ts';
 base.d1_databases=[{binding:'USAGE_MONITOR_DB',database_id:c.ingestionDatabaseId,database_name:c.ingestionDatabaseName},{binding:'ANALYTICS_DB',database_id:c.analyticsDatabaseId,database_name:c.analyticsDatabaseName},{binding:'DELETION_LEDGER',database_id:c.deletionLedgerDatabaseId,database_name:c.deletionLedgerDatabaseName}];
 base.vars={...base.vars,TELEMETRY_STORAGE_MODE:'typed',TELEMETRY_STORAGE_NAMESPACE:c.sourceNamespace,DEPLOYMENT_SOURCE_COMMIT:c.sourceCommit};
 base.secrets={required:plan.predecessor.secretBindings.map(v=>v.slice(v.indexOf(':')+1))};delete base.keep_vars;
 // Cron stays paused until the independently qualified analytics/lifecycle lane
 // owns its explicit schedule; versions activation does not mutate triggers.
 base.triggers={crons:[]};
 base.assets={...base.assets,binding:'ASSETS',directory:'../worker-assets'};
 if(base.assets.not_found_handling!=='404-page'||base.assets.run_worker_first!==true)fail('CONFIG_ASSETS_INVALID');
 return base;
}


export function proveMaintenanceLifecycleInvocation(bytes,{workerName,versionId,notBeforeMs,nowMs=Date.now()}){
 if(!uuid(versionId)||!Number.isSafeInteger(notBeforeMs)||notBeforeMs<0||notBeforeMs>nowMs)fail('TAIL_PINS_INVALID');
 const events=parseMaintenanceTailCapture(bytes),qualified=[];
 const flags=['lifecycleComplete','quarantineRetentionComplete','restoreReplayComplete','quarantineReconciliationComplete','expiredIdentityHandoffPurgeComplete','deletionTombstonePurgeComplete','primaryIdentityReenrollmentCooldownPurgeComplete','identityReenrollmentCooldownPurgeComplete','signInAdmissionPurgeComplete','aggregateRebuildDelegated'];
 const counts=['expiredIdentityHandoffsPurged','expiredDeletionTombstonesPurged','expiredPrimaryIdentityReenrollmentCooldownsPurged','expiredIdentityReenrollmentCooldownsPurged','expiredSignInAdmissionsPurged','staleDevicePairingsRevoked','staleDeviceCredentialsRevoked','staleDeviceUploadAuthorizationsRevoked','expiredDeviceCredentialRotationsPurged','expiredDevicePairingEventsPurged'];
 for(const e of events){
  if(e.scriptName!==workerName||e.scriptVersion?.id!==versionId||e.event?.cron!=='* * * * *'||!Number.isSafeInteger(e.event.scheduledTime)||e.event.scheduledTime<notBeforeMs||e.event.scheduledTime>nowMs)continue;
  if(e.outcome!=='ok'||e.truncated!==false||!Array.isArray(e.exceptions)||e.exceptions.length||!Array.isArray(e.logs)||e.logs.length>256)fail('LIFECYCLE_FAILED');
  const logs=[];for(const log of e.logs){if(!Array.isArray(log.message)||log.message.length!==1||typeof log.message[0]!=='string')continue;let v;try{v=JSON.parse(log.message[0]);}catch{continue;}if(v?.event==='scheduled_backend_maintenance')logs.push(v);}
  if(logs.length!==1)fail('LIFECYCLE_FAILED');const v=logs[0];
  if(v.level!=='info'||v.outcome!=='success'||v.code!=='OK'||flags.some(k=>v[k]!==true)||counts.some(k=>!Number.isSafeInteger(v[k])||v[k]<0)||typeof v.publicationEnabled!=='boolean'||typeof v.aggregateRebuildComplete!=='boolean')fail('LIFECYCLE_FAILED');
  qualified.push(e.event.scheduledTime);
 }
 if(!qualified.length)fail('NATURAL_INVOCATION_MISSING');
 return {captureSha256:maintenanceHash(bytes),captureBytes:bytes.length,qualifiedInvocations:qualified.length,firstScheduledTime:Math.min(...qualified),lastScheduledTime:Math.max(...qualified)};
}

export async function createMaintenanceCutoverProvider({plan,cutover,operationDirectory,candidateWorkerDirectory,
 qualificationRoot,restoreContractPath,ledgerSchemaPath,cliPath,fetcher=fetch,spawn=spawnSync,environment=process.env,
 snapshotFactory=createImmutableSourceSnapshot,dependencyDigest=dependencyTreeDigest,stageAssets=stageProductionAssets}){
 const transport=createMaintenanceTransport({plan,operationDirectory,cliPath,fetcher,spawn,environment});
 const maintenance=await createMaintenanceProvider({plan,packageDirectory:join(operationDirectory,'candidate'),operationDirectory,operationId:cutover.operationId,cliPath,fetcher,spawn,environment,cutoverInventory:{digest:cutover.inventoryDigest,analyticsWorker:cutover.analytics.workerName}});
 const {api,receipt}=transport,c=cutover.candidate,account=`/accounts/${plan.accountId}`,script=`${account}/workers/scripts/${plan.workerName}`,tag=`typed-cutover-${cutover.operationId}`;
 const paths={qualificationRoot:resolve(qualificationRoot),restoreContractPath:resolve(restoreContractPath),ledgerSchemaPath:resolve(ledgerSchemaPath)};
 const readDatabase=async(id,sql,params=[])=>{
  if(![plan.databaseId,c.ingestionDatabaseId,c.analyticsDatabaseId,c.deletionLedgerDatabaseId].includes(id)||!MAINTENANCE_CUTOVER_PROOF_SQL.includes(sql)||!Array.isArray(params)||params.length>20)fail('QUERY_NOT_ADMITTED');
  const result=await api(`${account}/d1/database/${id}/query`,{sql,params});
  if(!Array.isArray(result)||result.length!==1||result[0].success!==true||!Array.isArray(result[0].results))fail('QUERY_FAILED');return result[0];
 };
 const registrationQuery=async(id,sql,params=[])=>{
  if(![c.ingestionDatabaseId,c.analyticsDatabaseId].includes(id)||!MAINTENANCE_ANALYTICS_REGISTRATION_SQL.includes(sql)||!Array.isArray(params)||params.length>10)fail('QUERY_NOT_ADMITTED');
  const result=await api(`${account}/d1/database/${id}/query`,{sql,params},{mutation:sql===MAINTENANCE_ANALYTICS_REGISTRATION_INSERT});
  if(!Array.isArray(result)||result.length!==1||result[0].success!==true||!Array.isArray(result[0].results))fail('QUERY_FAILED');return result[0];
 };
 const privateJSON=async(path,value)=>{await writeFile(path,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});};
 const verifyFiles=async(s)=>{
  if(!object(s)||Object.keys(s).sort().join()!=='admissionDigest,assetsDirectory,configurationPath,configurationSha256,cronConfigurationPath,cronConfigurationSha256,dependencyDigest,dependencyPath,repositoryRoot,sourceCommit,workerDirectory')fail('SNAPSHOT_INVALID');
  if(s.sourceCommit!==c.sourceCommit||s.dependencyDigest!==c.dependencyDigest||s.workerDirectory!==join(s.repositoryRoot,'apps/worker')||s.dependencyPath!==join(s.workerDirectory,'node_modules')||s.assetsDirectory!==join(s.repositoryRoot,'.release-build/worker-assets')||s.configurationPath!==join(s.repositoryRoot,'.release-build/maintenance-cutover/wrangler.json')||s.cronConfigurationPath!==join(s.repositoryRoot,'.release-build/maintenance-cutover/lifecycle-cron.json'))fail('SNAPSHOT_INVALID');
  if(await realpath(s.repositoryRoot)!==s.repositoryRoot||!(await lstat(s.repositoryRoot)).isDirectory())fail('SNAPSHOT_INVALID');
  source(s.repositoryRoot,c.sourceCommit);
  const rootDependencies=join(s.repositoryRoot,'node_modules');
  if(!(await lstat(rootDependencies)).isSymbolicLink()||await readlink(rootDependencies)!==s.dependencyPath)fail('DEPENDENCIES_CHANGED');
  if(await dependencyDigest(s.dependencyPath)!==s.dependencyDigest)fail('DEPENDENCIES_CHANGED');
  const originalErrors=[],original=parse(await readFile(join(s.workerDirectory,'wrangler.jsonc'),'utf8'),originalErrors);
  if(originalErrors.length)fail('CONFIG_INVALID');
  const expected=JSON.stringify(renderMaintenanceCutoverConfig(original,plan,cutover))+'\n';
  const bytes=await readMaintenanceFile(s.configurationPath,256*1024);
  if(bytes.toString()!==expected||maintenanceHash(bytes)!==s.configurationSha256)fail('CONFIG_CHANGED');
  const cron=JSON.parse(expected);cron.triggers={crons:[...plan.predecessor.cron]};
  const cronBytes=await readMaintenanceFile(s.cronConfigurationPath,256*1024);
  if(cronBytes.toString()!==JSON.stringify(cron)+'\n'||maintenanceHash(cronBytes)!==s.cronConfigurationSha256)fail('CONFIG_CHANGED');
  const names=(await readdir(s.assetsDirectory)).sort();if(JSON.stringify(names)!==JSON.stringify(plan.assets.map(a=>a.path).sort()))fail('ASSETS_CHANGED');
  for(const a of plan.assets){const path=join(s.assetsDirectory,a.path),st=await lstat(path);if(!st.isFile()||st.nlink!==1||await realpath(path)!==path)fail('ASSETS_CHANGED');const b=await readFile(path);if(b.length!==a.bytes||maintenanceHash(b)!==a.sha256)fail('ASSETS_CHANGED');}
 };
 const localCheck=async(s,name)=>{
  await verifyFiles(s);
  const r=spawn(process.execPath,[join(s.workerDirectory,'scripts',name)],{cwd:s.workerDirectory,encoding:'utf8',timeout:120000,maxBuffer:1024*1024,
   env:{PATH:dirname(process.execPath)+':/usr/bin:/bin',HOME:dirname(s.repositoryRoot),CI:'true',NO_COLOR:'1',WRANGLER_SEND_METRICS:'false',WRANGLER_SEND_ERROR_REPORTS:'false',WRANGLER_LOG_PATH:'/dev/null'}});
  await receipt({kind:'cutover-local-check',name,status:r.status??null,stdoutSha256:maintenanceHash(String(r.stdout??'')),stderrSha256:maintenanceHash(String(r.stderr??''))});
  if(r.error||r.status!==0)fail('LOCAL_CHECK_FAILED');await verifyFiles(s);
 };
 const prepare=async()=>{
  const worker=resolve(candidateWorkerDirectory),root=resolve(worker,'../..');source(root,c.sourceCommit);
  const snapshot=await snapshotFactory({workerDirectory:worker,sourceCommit:c.sourceCommit});
  // macOS temporary roots may enter through /var; persist their canonical
  // directory spelling while retaining the original snapshot Git adapter.
  snapshot.repositoryRoot=await realpath(snapshot.repositoryRoot);
  snapshot.workerDirectory=join(snapshot.repositoryRoot,'apps/worker');
  snapshot.dependencyPath=join(snapshot.workerDirectory,'node_modules');
  // Root release checks use the same already hashed Worker dependency tree.
  // No second mutable dependency source is introduced.
  await symlink(snapshot.dependencyPath,join(snapshot.repositoryRoot,'node_modules'),'dir');
  // Retain the snapshot after unknown outcomes; do not clean it behind a journal.
  if(snapshot.dependencyDigest!==c.dependencyDigest)fail('DEPENDENCIES_CHANGED');
  await stageAssets({repositoryRoot:snapshot.repositoryRoot,sourceDirectory:join(snapshot.repositoryRoot,'.release-build/public-release-site'),destinationDirectory:join(snapshot.repositoryRoot,'.release-build/worker-assets'),expectedSourceCommit:c.sourceCommit,git:snapshot.git});
  const directory=join(snapshot.repositoryRoot,'.release-build/maintenance-cutover');await mkdir(directory,{mode:0o700});
  const errors=[],config=parse(await readFile(join(snapshot.workerDirectory,'wrangler.jsonc'),'utf8'),errors);if(errors.length)fail('CONFIG_INVALID');
  const configurationPath=join(directory,'wrangler.json'),configuration=renderMaintenanceCutoverConfig(config,plan,cutover);await privateJSON(configurationPath,configuration);
  const cronConfigurationPath=join(directory,'lifecycle-cron.json');await privateJSON(cronConfigurationPath,{...configuration,triggers:{crons:[...plan.predecessor.cron]}});
  const s={repositoryRoot:snapshot.repositoryRoot,workerDirectory:snapshot.workerDirectory,dependencyPath:snapshot.dependencyPath,dependencyDigest:snapshot.dependencyDigest,configurationPath,configurationSha256:maintenanceHash(await readFile(configurationPath)),cronConfigurationPath,cronConfigurationSha256:maintenanceHash(await readFile(cronConfigurationPath)),assetsDirectory:join(snapshot.repositoryRoot,'.release-build/worker-assets'),sourceCommit:c.sourceCommit,admissionDigest:null};
  await verifyFiles(s);
  for(const name of ['check-local-workspace-packages.mjs','check-deployment-endpoints.mjs','release-preflight.mjs'])await localCheck(s,name);
  await receipt({kind:'cutover-prepared',sourceCommit:c.sourceCommit,configurationSha256:s.configurationSha256,dependencyDigest:s.dependencyDigest,remoteWrites:false});return s;
 };
 const active=async()=>{const values=rows(await api(`${script}/deployments`),'deployments',100);const v=values[0]?.versions;if(!Array.isArray(v)||v.length!==1||v[0].percentage!==100||!uuid(v[0].version_id))fail('DEPLOYMENT_INVALID');return v[0].version_id;};
 const version=async id=>{if(!uuid(id))fail('VERSION_INVALID');const v=await api(`${script}/versions/${id}`);if(v.id!==id||!Array.isArray(v.resources?.bindings))fail('VERSION_INVALID');return v;};
 const assertLedgerBinding=async()=>{
  const old=await version(plan.predecessor.versionId);if(maintenanceBindingDigest(old.resources.bindings)!==plan.predecessor.bindingDigest)fail('PREDECESSOR_CHANGED');
  if(old.resources.bindings.filter(b=>b.type==='d1'&&b.name==='DELETION_LEDGER'&&(b.id??b.database_id)===c.deletionLedgerDatabaseId).length!==1)fail('LEDGER_SUBSTITUTED');
  for(const [id,name] of [[c.ingestionDatabaseId,c.ingestionDatabaseName],[c.analyticsDatabaseId,c.analyticsDatabaseName],[c.deletionLedgerDatabaseId,c.deletionLedgerDatabaseName]]){const info=await api(`${account}/d1/database/${id}`);if(info.uuid!==id||info.name!==name)fail('DATABASE_IDENTITY_CHANGED');}
 };
 const candidate=async(id,s)=>{
  const v=await version(id),bs=v.resources.bindings;
  if(bs.some(b=>typeof b.name!=='string'||!b.name)||new Set(bs.map(b=>b.name)).size!==bs.length)fail('CONFIG_BINDINGS_CHANGED');
  if(v.annotations?.['workers/tag']!==tag)fail('VERSION_CHANGED');
  const config=JSON.parse((await readMaintenanceFile(s.configurationPath,256*1024)).toString());
  const expected=new Map(config.d1_databases.map(d=>[d.binding,d.database_id])),actual=bs.filter(b=>b.type==='d1');
  if(actual.length!==3||actual.some(b=>expected.get(b.name)!==(b.id??b.database_id)))fail('DATABASE_BINDINGS_CHANGED');
  const vars=bs.filter(b=>b.type==='plain_text');
  if(vars.length!==Object.keys(config.vars).length||vars.some(b=>config.vars[b.name]!==b.text))fail('CONFIG_BINDINGS_CHANGED');
  const secretNames=bs.filter(b=>['secret_text','secret_key'].includes(b.type)).map(b=>b.type+':'+b.name).sort();
  if(JSON.stringify(secretNames)!==JSON.stringify([...plan.predecessor.secretBindings].sort()))fail('SECRET_BINDINGS_CHANGED');
  const budget=bs.filter(b=>b.type==='durable_object_namespace');if(budget.length!==1||budget[0].namespace_id!==plan.predecessor.durableNamespaceId||budget[0].name!==config.durable_objects.bindings[0].name)fail('DURABLE_IDENTITY_CHANGED');
  // Remaining source-owned bindings (R2/rate limit/etc.) must match the exact
  // previous version. No implicit resource creation or unreviewed substitution.
  const ordinary=b=>!['d1','plain_text','secret_text','secret_key','durable_object_namespace'].includes(b.type);
  const old=await version(plan.predecessor.versionId);
  if(maintenanceBindingDigest(bs.filter(ordinary))!==maintenanceBindingDigest(old.resources.bindings.filter(ordinary)))fail('RESOURCE_BINDINGS_CHANGED');
  return v;
 };
 const command=async(s,step,args,dry=false)=>{await verifyFiles(s);await transport.run({step,args,config:s.configurationPath,directory:s.workerDirectory,dry});await verifyFiles(s);};
 const verifyContained=()=>maintenance.verifyContained(cutover.maintenanceVersionId);
 const admit=async(s,stage='full')=>{await verifyFiles(s);await assertLedgerBinding();const proof=await verifyMaintenanceCutoverProof({plan,cutover,...paths,readDatabase,stage});await receipt({kind:'cutover-admission',planDigest:identityDigest(cutover),proof});return proof;};
 const reconcileUpload=async(id,s)=>{await verifyFiles(s);if(!id){const list=rows(await api(`${script}/versions?deployable=true`),'items',100).filter(v=>v.annotations?.['workers/tag']===tag);if(list.length!==1)fail('UPLOAD_UNCERTAIN');id=list[0].id;}await candidate(id,s);if(await active()!==cutover.maintenanceVersionId)fail('PREDECESSOR_CHANGED');return id;};
 const verifyActivated=async(id,s,{scheduled=false}={})=>{
  // Pristine copy counts are not replayed after new-target writes may begin.
  // The fsynced admission + latch precede activation; immutable code/bindings
  // and the actual healthy new source are the forward reconciliation boundary.
  if(!/^[a-f0-9]{64}$/.test(s.admissionDigest??''))fail('ADMISSION_MISSING');await verifyFiles(s);await candidate(id,s);if(await active()!==id)fail('DEPLOYMENT_CHANGED');
  const health=await recheckProductionHealth({fetchImpl:fetcher});if(!health.ok||health.sourceCommit!==c.sourceCommit)fail('HEALTH_UNVERIFIED');
  if(!(await recheckProductionPublicSurface({fetchImpl:fetcher})).ok)fail('SURFACE_UNVERIFIED');
  for(const a of plan.assets){const path=a.path==='index.html'?'/':a.path.endsWith('.html')?'/'+a.path.slice(0,-5):'/'+a.path;const {response,bytes}=await transport.publicRead(plan.origin+path+'?cutover-proof='+identityDigest(cutover));if(response.status!==200||bytes.length!==a.bytes||maintenanceHash(bytes)!==a.sha256)fail('ASSETS_CHANGED');}
  const schedules=rows(await api(`${script}/schedules`),'schedules',16);if(JSON.stringify(schedules.map(x=>x.cron).sort())!==JSON.stringify(scheduled?[...plan.predecessor.cron].sort():[]))fail('SCHEDULE_CHANGED');
  await receipt({kind:'typed-cutover-verified',sourceCommit:c.sourceCommit,versionId:id,planDigest:identityDigest(cutover),admissionDigest:s.admissionDigest});
 };
 return {prepare,
  async initializeAnalytics(s){await verifyFiles(s);return initializeMaintenanceAnalyticsRegistration({cutover,sourceDirectory:s.workerDirectory,queryDatabase:registrationQuery});},
  async readAnalyticsRegistration(s){await verifyFiles(s);return readMaintenanceAnalyticsRegistration({cutover,sourceDirectory:s.workerDirectory,queryDatabase:registrationQuery});},
  verifySnapshot:verifyFiles,verifyContained,admit,reconcileUpload,verifyActivated,
  async verifyUploadAbsent(s){await verifyFiles(s);const list=rows(await api(`${script}/versions?deployable=true`),'items',100).filter(v=>v.annotations?.['workers/tag']===tag);if(list.length)fail('UPLOAD_UNCERTAIN');await verifyContained();},
  async verifyActivationPending(id,s){await verifyFiles(s);await candidate(id,s);await verifyContained();},
  async enableMainCron(id,s){await verifyActivated(id,s);await transport.run({step:'cutover-main-cron',args:['triggers','deploy'],config:s.cronConfigurationPath,directory:s.workerDirectory});await verifyFiles(s);},
  async verifyMainNaturalInvocation(id,s,capturePath,notBeforeMs){await verifyActivated(id,s,{scheduled:true});const proof=proveMaintenanceLifecycleInvocation(await readMaintenanceFile(capturePath,2_000_000),{workerName:plan.workerName,versionId:id,notBeforeMs});await receipt({kind:'main-lifecycle-natural-invocation',sourceCommit:c.sourceCommit,versionId:id,...proof});return proof;},
  dryRun:s=>command(s,'cutover-dry-run',['versions','upload','--dry-run','--outdir',join(operationDirectory,'cutover-dry-build')],true),
  upload:s=>command(s,'cutover-upload',['versions','upload','--tag',tag,'--message',tag]),
  async activate(id,s){await candidate(id,s);return command(s,'cutover-activate',['versions','deploy',`${id}@100%`,'--yes']);}};
}
