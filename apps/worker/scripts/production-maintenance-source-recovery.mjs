import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openOperation,identityDigest,operationError} from '../../../scripts/lib/release-operation.mjs';
import {validateMaintenancePlan,validateMaintenanceState,readMaintenanceFile,maintenanceHash} from './production-maintenance.mjs';
import {createMaintenanceProvider,MAINTENANCE_SCHEMA_QUERY} from './production-maintenance-provider.mjs';
import {createMaintenanceTransport} from './production-maintenance-transport.mjs';
import {createProductionDeploymentLock} from './production-deployment-lock.mjs';
import {storageSchemaDigest} from './d1-storage-plan.mjs';
const fail=c=>{throw operationError(`PRODUCTION_MAINTENANCE_RECOVERY_${c}`);};
const SHA=/^[a-f0-9]{64}$/,ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,COMMIT=/^[a-f0-9]{40}$/,NAME=/^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const exact=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join()!==keys.split(' ').sort().join())fail('INPUT_INVALID');};
const quote=n=>{if(!NAME.test(n))fail('INPUT_INVALID');return '"'+n+'"';};
const sorted=rows=>[...rows].sort((a,b)=>(a.type<b.type?-1:a.type>b.type?1:a.name<b.name?-1:a.name>b.name?1:0));
const equal=(a,b)=>{if(identityDigest(a)!==identityDigest(b))fail('SOURCE_CHANGED');};
const SNAPSHOT='CREATE TABLE _authority_snapshot(id INTEGER PRIMARY KEY CHECK(id=1),contract_digest TEXT NOT NULL,namespace TEXT NOT NULL,snapshot_digest TEXT NOT NULL) STRICT';
const CACHE='SELECT singleton,generated_at,payload_json FROM admin_metrics_history_cache ORDER BY singleton LIMIT 2';
const SEQUENCES='SELECT name,seq FROM sqlite_sequence ORDER BY name LIMIT 129';
const STATE='SELECT contract_digest,namespace,snapshot_digest FROM _authority_snapshot WHERE id=1';
const RESTORE_CACHE='INSERT INTO admin_metrics_history_cache(singleton,generated_at,payload_json) VALUES(1,?,?)';
export function validateMaintenanceRecoveryPlan(p,plan){
 exact(p,'schema maintenancePlanDigest operationId owner maintenanceVersionId contractSha256 contractDigest sourceSchemaSha256 sequencesSha256 cacheArchiveSha256');
 if(p.schema!=='maintenance-source-recovery-v1'||p.maintenancePlanDigest!==identityDigest(plan)||!ID.test(p.operationId)||!COMMIT.test(p.owner)||!ID.test(p.maintenanceVersionId)||![p.contractSha256,p.contractDigest,p.sourceSchemaSha256,p.sequencesSha256].every(v=>SHA.test(v))||!(p.cacheArchiveSha256===null||SHA.test(p.cacheArchiveSha256)))fail('INPUT_INVALID');return p;
}
async function json(path,pin,max=2_000_000){const b=await readMaintenanceFile(path,max);if(maintenanceHash(b)!==pin)fail('INPUT_CHANGED');try{return JSON.parse(b);}catch{fail('INPUT_INVALID');}}
/** Compile a reverse of ONLY the source pause added by the reviewed restore
 * protocol. No baseline table, index, trigger, row or migration is removed. */
export async function loadMaintenanceRecoveryInputs({plan,recovery,contractPath,sourceSchemaPath,sequencesPath,cacheArchivePath}){
 validateMaintenanceRecoveryPlan(recovery,plan);
 const contract=await json(contractPath,recovery.contractSha256),original=await json(sourceSchemaPath,recovery.sourceSchemaSha256),sequences=await json(sequencesPath,recovery.sequencesSha256);
 if(identityDigest(contract)!==recovery.contractDigest||contract.version!=='authority-restore-v1'||!SHA.test(contract.sourceSnapshotDigest)||typeof contract.sourceNamespace!=='string'||!contract.sourceNamespace.length||contract.sourceNamespace.length>256||!Array.isArray(contract.tables)||contract.tables.length>128||!Array.isArray(original)||original.length>1024||identityDigest(original)!==plan.restoreSchemaDigest||storageSchemaDigest(contract.sourceSchema)!==storageSchemaDigest(original))fail('INPUT_INVALID');
 const tables=contract.tables.map(x=>x.name).sort();if(new Set(tables).size!==tables.length||tables.some(n=>!NAME.test(n)||n.startsWith('_authority_'))||identityDigest(tables)!==identityDigest(contract.sourceSchema.filter(x=>x.type==='table').map(x=>x.name).sort())||!tables.includes('participants')||!tables.includes('admin_metrics_history_cache'))fail('INPUT_INVALID');
 for(const row of original){exact(row,'type name tbl_name sql');if(row.name.startsWith('_authority_')||!NAME.test(row.name)||!NAME.test(row.tbl_name)||typeof row.sql!=='string')fail('INPUT_INVALID');}
 if(!Array.isArray(sequences)||sequences.length>128||sequences.some(r=>Object.keys(r).sort().join()!=='name,seq'||!NAME.test(r.name)||!Number.isSafeInteger(r.seq)||r.seq<0))fail('INPUT_INVALID');
 let cache=null;if(recovery.cacheArchiveSha256!==null){cache=await json(cacheArchivePath,recovery.cacheArchiveSha256);exact(cache,'singleton generated_at payload_json');if(cache.singleton!==1||typeof cache.generated_at!=='string'||!Number.isFinite(Date.parse(cache.generated_at))||typeof cache.payload_json!=='string'||cache.payload_json.length>524288)fail('CACHE_ARCHIVE_INVALID');try{JSON.parse(cache.payload_json);}catch{fail('CACHE_ARCHIVE_INVALID');}}
 else if(cacheArchivePath)fail('INPUT_INVALID');
 const triggers=[];for(const table of [...tables,'_authority_snapshot'])for(const verb of ['INSERT','UPDATE','DELETE']){const name=`_authority_freeze_${verb.toLowerCase()}_${table}`;triggers.push({type:'trigger',name,tbl_name:table,sql:`CREATE TRIGGER ${quote(name)} BEFORE ${verb} ON ${quote(table)} BEGIN SELECT RAISE(ABORT,'AUTHORITY_SNAPSHOT_FROZEN'); END`});}
 triggers.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
 return {contract,original,sequences,cache,triggers,snapshot:{type:'table',name:'_authority_snapshot',tbl_name:'_authority_snapshot',sql:SNAPSHOT}};
}
export function createMaintenanceSourceRecoveryProvider({plan,recovery,inputs,operationDirectory,cliPath,fetcher=fetch,environment=process.env}){
 const transport=createMaintenanceTransport({plan,operationDirectory,cliPath,fetcher,environment});
 const writes=new Set([...inputs.triggers.map(t=>'DROP TRIGGER '+quote(t.name)),RESTORE_CACHE,'DROP TABLE _authority_snapshot']);
 const reads=new Set([MAINTENANCE_SCHEMA_QUERY,CACHE,SEQUENCES,STATE]);
 return {async query(sql,params=[]){if(!reads.has(sql)&&!writes.has(sql))fail('QUERY_NOT_ADMITTED');const write=writes.has(sql);if(sql===RESTORE_CACHE&&!inputs.cache)fail('QUERY_NOT_ADMITTED');if(!Array.isArray(params)||params.length>2||sql===RESTORE_CACHE&&identityDigest(params)!==identityDigest([inputs.cache.generated_at,inputs.cache.payload_json])||sql!==RESTORE_CACHE&&params.length)fail('QUERY_NOT_ADMITTED');
  const result=await transport.api(`/accounts/${plan.accountId}/d1/database/${plan.databaseId}/query`,{sql,params},{mutation:write});if(!Array.isArray(result)||result.length!==1||result[0].success!==true||!Array.isArray(result[0].results)||result[0].results.length>4096)fail(write?'WRITE_UNVERIFIED':'READ_UNVERIFIED');return result[0].results;}};
}
const sourceCheck=(root,pin)=>{if(execFileSync('/usr/bin/git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==pin||execFileSync('/usr/bin/git',['-C',root,'status','--porcelain','--untracked-files=all'],{encoding:'utf8'}).trim())fail('TOOLING_CHANGED');};
/** Recovery is deliberately stopped-executor only. It retains the original
 * maintenance owner and never activates a Writer. Up to16 individually journaled
 * metadata removals per call; an uncertain one requires read reconciliation. */
export async function runMaintenanceSourceRecovery({plan,recovery,operationDirectory,repositoryRoot,contractPath,sourceSchemaPath,sequencesPath,cacheArchivePath,cliPath,action='inspect',confirmation=null,executorStopped=false,provider=null,containmentProvider=null,coordinationFactory=createProductionDeploymentLock,checkSource=sourceCheck}){
 plan=structuredClone(validateMaintenancePlan(plan));recovery=structuredClone(validateMaintenanceRecoveryPlan(recovery,plan));
 if(!['inspect','apply','reconcile'].includes(action))fail('ACTION_INVALID');
 if(action!=='inspect'&&(!executorStopped||confirmation!==(action==='apply'?'RECOVER_FROZEN_PRODUCTION_SOURCE':'RECONCILE_FROZEN_SOURCE_RECOVERY')))fail('CONFIRMATION_REQUIRED');
 checkSource(repositoryRoot,plan.toolingCommit);
 const inputs=await loadMaintenanceRecoveryInputs({plan,recovery,contractPath,sourceSchemaPath,sequencesPath,cacheArchivePath});
 if(action==='inspect')return {ok:true,code:'MAINTENANCE_SOURCE_RECOVERY_PREPARED',triggerCount:inputs.triggers.length,restoresArchivedCache:inputs.cache!==null,rawRowsDeleted:0,remoteWrites:false};
 const op=await openOperation({directory:operationDirectory,kind:'maintenance',binding:{planDigest:identityDigest(plan)},resume:true});
 try{
  const state=validateMaintenanceState(op.record.state),lock=coordinationFactory({repositoryRoot});
  if(op.record.id!==recovery.operationId||state.owner!==recovery.owner||state.phase!=='contained'||state.intent!==null||state.lock!=='held'||state.uploadedVersion!==recovery.maintenanceVersionId||state.cutover?.oldRestoreForbidden)fail('PARENT_MISMATCH');
  // A prepared local cutover is harmless; remotely created analytics resources
  // require their own pinned closure before the predecessor inventory can pass.
  if(state.cutover&&state.cutover.analytics.phase!=='prepared')fail('CUTOVER_RESOURCES_REQUIRE_CLOSURE');
  lock.assertOwned(state.owner);
  containmentProvider??=await createMaintenanceProvider({plan,packageDirectory:join(op.directory,'candidate'),operationDirectory:op.directory,operationId:op.record.id,cliPath});
  await containmentProvider.verifyContained(state.uploadedVersion);
  provider??=createMaintenanceSourceRecoveryProvider({plan,recovery,inputs,operationDirectory:op.directory,cliPath});
  if(!state.sourceRecovery){if(action==='reconcile')fail('NOT_STARTED');state.sourceRecovery={planDigest:identityDigest(recovery),nextTrigger:0,cacheRestored:false,snapshotRemoved:false,intent:null,phase:'recovering'};await op.save(state);}
  const r=state.sourceRecovery;if(r.planDigest!==identityDigest(recovery))fail('PLAN_CHANGED');
  if(r.nextTrigger>inputs.triggers.length||r.snapshotRemoved&&r.nextTrigger!==inputs.triggers.length||r.phase==='verified'&&(!r.snapshotRemoved||inputs.cache&&!r.cacheRestored))fail('STATE_INVALID');
  if(r.intent){const kind=r.nextTrigger<inputs.triggers.length?'drop-trigger':!r.snapshotRemoved?'drop-snapshot':'restore-cache';const sql=kind==='drop-trigger'?'DROP TRIGGER '+quote(inputs.triggers[r.nextTrigger].name):kind==='drop-snapshot'?'DROP TABLE _authority_snapshot':RESTORE_CACHE;const params=kind==='restore-cache'&&inputs.cache?[inputs.cache.generated_at,inputs.cache.payload_json]:[];if(identityDigest(r.intent)!==identityDigest({kind,statementDigest:identityDigest(sql),parametersDigest:identityDigest(params)}))fail('STATE_INVALID');}
  const schema=async()=>provider.query(MAINTENANCE_SCHEMA_QUERY);
  const expected=()=>sorted([...inputs.original,...(r.snapshotRemoved?[]:[inputs.snapshot,...inputs.triggers.slice(r.nextTrigger)])]);
  const unchanged=async()=>{equal(await provider.query(SEQUENCES),inputs.sequences);if(!r.snapshotRemoved)equal(await provider.query(STATE),[{contract_digest:recovery.contractDigest,namespace:inputs.contract.sourceNamespace,snapshot_digest:inputs.contract.sourceSnapshotDigest}]);};
  const cacheCheck=async present=>{if(inputs.cache)equal(await provider.query(CACHE),present?[inputs.cache]:[]);};
  const pinFiles=()=>loadMaintenanceRecoveryInputs({plan,recovery,contractPath,sourceSchemaPath,sequencesPath,cacheArchivePath});
  if(action==='reconcile'&&r.intent){
   equal(await provider.query(SEQUENCES),inputs.sequences);const observed=await schema();
   if(r.intent.kind==='drop-trigger'){
    const before=expected(),after=before.filter(x=>x.name!==inputs.triggers[r.nextTrigger]?.name);
    if(identityDigest(observed)===identityDigest(after))r.nextTrigger++;else equal(observed,before);
   }else if(r.intent.kind==='restore-cache'){
    equal(observed,expected());const rows=await provider.query(CACHE);if(identityDigest(rows)===identityDigest([inputs.cache]))r.cacheRestored=true;else equal(rows,[]);
   }else if(r.intent.kind==='drop-snapshot'){
    if(identityDigest(observed)===identityDigest(inputs.original))r.snapshotRemoved=true;else equal(observed,expected());
   }else fail('STATE_INVALID');
   r.intent=null;await op.save(state);
  }
  if(r.intent)fail('RECONCILE_REQUIRED');
  equal(await schema(),expected());await unchanged();await cacheCheck(r.cacheRestored);
  if(action==='reconcile')return {ok:true,code:'MAINTENANCE_SOURCE_RECOVERY_RECONCILED',phase:r.phase,coordination:'held'};
  let steps=0;
  const mutate=async(kind,sql,params,complete)=>{lock.assertOwned(state.owner);await pinFiles();r.intent={kind,statementDigest:identityDigest(sql),parametersDigest:identityDigest(params)};await op.save(state);await provider.query(sql,params);complete();equal(await schema(),expected());await unchanged();await cacheCheck(r.cacheRestored);lock.assertOwned(state.owner);r.intent=null;await op.save(state);steps++;};
  while(r.nextTrigger<inputs.triggers.length&&steps<16){const trigger=inputs.triggers[r.nextTrigger];await mutate('drop-trigger','DROP TRIGGER '+quote(trigger.name),[],()=>r.nextTrigger++);}
  // Remove the final temporary page before replacing an archived cache: the
  // source may be at its hard allocation cap. The held journal blocks ordinary
  // writer restoration until the exact archived row is verified below.
  if(r.nextTrigger===inputs.triggers.length&&steps<16&&!r.snapshotRemoved)await mutate('drop-snapshot','DROP TABLE _authority_snapshot',[],()=>{r.snapshotRemoved=true;});
  if(r.snapshotRemoved&&steps<16&&inputs.cache&&!r.cacheRestored)await mutate('restore-cache',RESTORE_CACHE,[inputs.cache.generated_at,inputs.cache.payload_json],()=>{r.cacheRestored=true;});
  if(r.snapshotRemoved&&(!inputs.cache||r.cacheRestored)){await containmentProvider.verifyContained(state.uploadedVersion);await pinFiles();equal(await schema(),inputs.original);await unchanged();await cacheCheck(inputs.cache!==null);await containmentProvider.assertRestoreSafe();r.phase='verified';await op.save(state);}
  return {ok:true,code:r.phase==='verified'?'MAINTENANCE_SOURCE_RECOVERED':'MAINTENANCE_SOURCE_RECOVERY_PROGRESS',steps,nextTrigger:r.nextTrigger,coordination:'held',rawRowsDeleted:0,writerActivated:false};
 }finally{op.close();}
}
function arguments_(args){const result={action:'inspect'},map={'--plan':'planPath','--recovery-plan':'recoveryPath','--operation':'operationDirectory','--repository':'repositoryRoot','--contract':'contractPath','--source-schema':'sourceSchemaPath','--sequences':'sequencesPath','--cache-archive':'cacheArchivePath','--wrangler-cli':'cliPath','--action':'action','--confirm':'confirmation'},seen=new Set();for(let i=0;i<args.length;i++){const key=args[i];if(seen.has(key))fail('ARGUMENTS_INVALID');seen.add(key);if(key==='--executor-stopped'){result.executorStopped=true;continue;}if(!map[key]||!args[i+1]||args[i+1].startsWith('--'))fail('ARGUMENTS_INVALID');result[map[key]]=args[++i];}for(const key of ['planPath','recoveryPath','operationDirectory','repositoryRoot','contractPath','sourceSchemaPath','sequencesPath','cliPath'])if(!result[key])fail('ARGUMENTS_INVALID');return result;}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){try{const o=arguments_(process.argv.slice(2)),plan=JSON.parse((await readMaintenanceFile(o.planPath,65536)).toString()),recovery=JSON.parse((await readMaintenanceFile(o.recoveryPath,65536)).toString());console.log(JSON.stringify(await runMaintenanceSourceRecovery({...o,plan,recovery})));}catch(e){console.error(/^PRODUCTION_MAINTENANCE_[A-Z_]+$/.test(e?.code??'')?e.code:'PRODUCTION_MAINTENANCE_RECOVERY_FAILED');process.exitCode=1;}}
