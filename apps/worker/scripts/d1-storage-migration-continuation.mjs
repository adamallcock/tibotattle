import {readFile,writeFile,lstat,realpath,mkdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {identityDigest} from '../../../scripts/lib/release-operation.mjs';
import {exactKeys,storageError,storageSha256,storageSchemaDigest} from './d1-storage-plan.mjs';
import {prepareStorageMigrationWorker,validatePlacedMigrationTopology} from './d1-storage-migration-package.mjs';
import {readIngestionRoleInputs} from './d1-storage-role.mjs';
import {MIGRATION_JOURNAL_DDL,MIGRATION_JOURNAL_GUARD} from './d1-storage-migration-worker.mjs';
import {STORAGE_RESTORE_STAGES} from './d1-storage-restore-runner.mjs';

const fail=()=>{throw storageError('MIGRATION_CONTINUATION_REFUSED');};
const sha=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const date=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const equal=(a,b)=>{if(identityDigest(a)!==identityDigest(b))fail();};
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const EVIDENCE=['backend-domains','backend-routes','backend-subdomain','front-domains','front-routes','front-subdomain','resource-pins','backend-deployments','backend-enabled','backend-settings','backend-version','front-consumers','front-deployments','front-enabled','front-schedules','front-settings','front-version','source-schema','source-sequences','source-snapshot','target-checkpoint','target-schema'];
export const MIGRATION_CONTINUATION_READ_SQL=Object.freeze({
 'source-schema':"SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name LIMIT 4097",
 'source-snapshot':'SELECT contract_digest,namespace,snapshot_digest FROM _authority_snapshot WHERE id=1',
 'source-sequences':'SELECT name,seq FROM sqlite_sequence ORDER BY name LIMIT 129',
 'target-schema':"SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='_authority_operator_progress' OR name='_authority_operator_progress'",
 'target-checkpoint':'SELECT contract_digest,execution_digest,stage,steps,intent FROM _authority_operator_progress WHERE id=1',
});
async function privateBytes(path,limit=256*1024){
 path=resolve(path);const st=await lstat(path);
 if(!st.isFile()||st.nlink!==1||(st.mode&0o077)||st.size<1||st.size>limit||await realpath(path)!==path||process.getuid&&st.uid!==process.getuid())fail();
 const bytes=await readFile(path);if(bytes.length!==st.size)fail();return bytes;
}
async function document(path,limit){const bytes=await privateBytes(path,limit);try{return {value:JSON.parse(bytes),sha256:storageSha256(bytes)};}catch{fail();}}
const write=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});

/** Validate reviewed observations; never manufacture drain evidence from a PID,
 * elapsed quiet time, expiry or a NULL intent alone. The approval explicitly
 * binds this receipt and its retained read-only evidence file hashes. */
export function validateMigrationHandoff({previous,previousPreparationSha256,contract,handoff,now=Date.now()}){
 exactKeys(handoff,['schema','previousPreparationSha256','executionDigest','sourceCommit','contractDigest','topologyDigest',
  'accountId','stoppedAt','observedAt','front','backend','source','target','evidence']);
 if(!/^[a-f0-9]{32}$/.test(handoff.accountId??'')||handoff.schema!=='d1-storage-migration-handoff-v1'||handoff.previousPreparationSha256!==previousPreparationSha256
  ||handoff.executionDigest!==previous.executionDigest||handoff.sourceCommit!==previous.sourceCommit
  ||handoff.contractDigest!==previous.contractDigest||handoff.topologyDigest!==previous.topologyDigest)fail();
 const times=['stoppedAt','observedAt'];if(times.some(k=>!date(handoff[k])))fail();
 if(Date.parse(handoff.stoppedAt)>Date.parse(handoff.observedAt)||Date.parse(handoff.observedAt)>now
  ||now-Date.parse(handoff.observedAt)>15*60*1000)fail();
 exactKeys(handoff.front,['name','versionId','mode','cron','consumerAttached','ingressClosed']);
 exactKeys(handoff.backend,['name','versionId','mode','ingressClosed']);
 for(const lane of ['front','backend'])if(handoff[lane].name!==previous.topology[lane+'Name']||!uuid(handoff[lane].versionId)
  ||handoff[lane].mode!=='disabled'||handoff[lane].ingressClosed!==true)fail();
 if(handoff.front.consumerAttached!==false||!Array.isArray(handoff.front.cron)||handoff.front.cron.length)fail();
 exactKeys(handoff.source,['databaseId','contractDigest','namespace','snapshotDigest','schemaDigest','freezeTriggersExact','sequencesExact']);
 equal(handoff.source,{databaseId:previous.topology.source.id,contractDigest:previous.contractDigest,namespace:contract.sourceNamespace,
  snapshotDigest:contract.sourceSnapshotDigest,schemaDigest:contract.sourceSchemaDigest,freezeTriggersExact:true,sequencesExact:true});
 exactKeys(handoff.target,['databaseId','contractDigest','executionDigest','stage','steps','intent']);
 if(handoff.target.databaseId!==previous.topology.target.id||handoff.target.contractDigest!==previous.contractDigest||handoff.target.executionDigest!==previous.executionDigest
  ||!STORAGE_RESTORE_STAGES.includes(handoff.target.stage)||!Number.isSafeInteger(handoff.target.steps)||handoff.target.steps<1
  ||handoff.target.steps>=Number.MAX_SAFE_INTEGER||handoff.target.intent!==null)fail();
 if(!Array.isArray(handoff.evidence)||handoff.evidence.length!==EVIDENCE.length)fail();
 equal(handoff.evidence.map(x=>x.name).sort(),[...EVIDENCE].sort());
 for(const item of handoff.evidence){exactKeys(item,['name','path','sha256',...(Object.hasOwn(MIGRATION_CONTINUATION_READ_SQL,item.name)?['querySha256']:[])]);if(Object.hasOwn(MIGRATION_CONTINUATION_READ_SQL,item.name)&&item.querySha256!==storageSha256(MIGRATION_CONTINUATION_READ_SQL[item.name]))fail();if(typeof item.path!=='string'||item.path.length>4096||!sha(item.sha256))fail();}
 return structuredClone(handoff.target);
}

/** Read the provider/SQL responses themselves, rather than trusting summary
 * flags. These are retained operator reads, not a newly invented provider API. */
export function verifyMigrationHandoffEvidence({previous,contract,handoff,evidence}) {
 const provider=name=>{const p=JSON.parse(evidence[name]);if(p.success!==true||p.errors?.length||p.result_info?.total_pages>1||p.result_info?.has_more)fail();return p.result;};
 const pins=JSON.parse(evidence['resource-pins']);if(pins.reviewed!==true||pins.accountId!==handoff.accountId||pins.sourceCommit!==previous.sourceCommit||pins.contractDigest!==previous.contractDigest)fail();equal(pins.topology,previous.topology);
 const list=(value,key)=>{const v=Array.isArray(value)?value:value?.[key];if(!Array.isArray(v)||v.length>=100)fail();return v;};
 for(const lane of ['front','backend']){
  const settings=provider(lane+'-settings'),version=provider(lane+'-version'),deployments=list(provider(lane+'-deployments'),'deployments');
  if(!deployments.length||deployments.some(d=>!Number.isFinite(Date.parse(d.created_on))))fail();
  const latest=[...deployments].sort((a,b)=>Date.parse(b.created_on)-Date.parse(a.created_on))[0];
  if(version.id!==handoff[lane].versionId||latest.versions?.length!==1||latest.versions[0].version_id!==version.id||latest.versions[0].percentage!==100||Date.parse(latest.created_on)>Date.parse(handoff.stoppedAt))fail();
  const bindings=rows=>{if(!Array.isArray(rows)||rows.length!==3||new Set(rows.map(x=>x.name)).size!==3)fail();
   const one=(name,type)=>{const row=rows.find(x=>x.name===name);if(row?.type!==type)fail();return row;};
   if(one('STORAGE_RESTORE_MODE','plain_text').text!=='disabled')fail();
   if(lane==='backend'){for(const [binding,role]of [['SOURCE','source'],['TARGET','target']]){const b=one(binding,'d1');if((b.id??b.database_id)!==previous.topology[role].id)fail();}}
   else{const service=one('STORAGE_RESTORE_EXECUTOR','service'),queue=one('STORAGE_RESTORE_QUEUE','queue');
    if(service.service!==previous.topology.backendName||service.environment!==undefined&&service.environment!=='production'
     ||service.entrypoint!==undefined&&service.entrypoint!=='default'||queue.queue_name!==previous.topology.queueName
     ||queue.queue_id!==undefined&&queue.queue_id!==previous.topology.queueId)fail();}
  };bindings(settings.bindings);bindings(version.resources?.bindings);
  if(lane==='backend'){const p=version.resources?.script?.placement;if(p?.mode!=='targeted'||p.target?.length!==1
   ||p.target[0].region!==previous.topology.region||p.target[0].type!=='region'||settings.placement?.mode!=='targeted')fail();equal(settings.placement.target,[p.target[0].id]);}
  const subdomain=provider(lane+'-subdomain');if(subdomain.enabled!==false||subdomain.previews_enabled!==false)fail();equal(list(provider(lane+'-routes'),'routes'),[]);equal(list(provider(lane+'-domains'),'records'),[]);
 const enabled=JSON.parse(evidence[lane+'-enabled']);if(enabled.status!=='passed'||enabled.lane!==lane||enabled.mode!=='enabled'
   ||!date(enabled.checkedAt)||Date.parse(enabled.checkedAt)>Date.parse(latest.created_on)||enabled.sourceCommit!==previous.sourceCommit||enabled.executionDigest!==previous.executionDigest||!uuid(enabled.versionId))fail();
 }
 equal(list(provider('front-schedules'),'schedules'),[]);equal(list(provider('front-consumers'),'consumers'),[]);
 const rows=(name,max)=>{const result=JSON.parse(evidence[name]);if(!Array.isArray(result)||result.length!==1||result[0].success!==true
  ||!Array.isArray(result[0].results)||result[0].results.length>max)fail();return result[0].results;};
 const schema=rows('source-schema',4096),quote=name=>{if(!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))fail();return '"'+name+'"';};
 const expected=[{name:'_authority_snapshot',sql:'CREATE TABLE _authority_snapshot(id INTEGER PRIMARY KEY CHECK(id=1),contract_digest TEXT NOT NULL,namespace TEXT NOT NULL,snapshot_digest TEXT NOT NULL) STRICT'}];
 for(const table of [...contract.tables.map(x=>x.name),'_authority_snapshot'])for(const verb of ['INSERT','UPDATE','DELETE']){const name=`_authority_freeze_${verb.toLowerCase()}_${table}`;expected.push({name,sql:`CREATE TRIGGER ${quote(name)} BEFORE ${verb} ON ${quote(table)} BEGIN SELECT RAISE(ABORT,'AUTHORITY_SNAPSHOT_FROZEN'); END`});}
 const sorted=items=>items.sort((a,b)=>a.name<b.name?-1:1);
 equal(sorted(schema.filter(x=>x.name.startsWith('_authority_')).map(({name,sql})=>({name,sql}))),sorted(expected));
 equal(storageSchemaDigest(schema.filter(x=>!x.name.startsWith('_authority_'))),storageSchemaDigest(contract.sourceSchema));
 equal(rows('source-snapshot',1),[{contract_digest:previous.contractDigest,namespace:contract.sourceNamespace,snapshot_digest:contract.sourceSnapshotDigest}]);
 const sequences=rows('source-sequences',128);for(const entry of contract.authoritySequences)if((sequences.find(x=>x.name===entry.name)?.seq??0)!==entry.sequence)fail();
 equal(rows('target-schema',2),[{type:'table',name:'_authority_operator_progress',sql:MIGRATION_JOURNAL_DDL}]);
 equal(rows('target-checkpoint',1),[{contract_digest:handoff.target.contractDigest,execution_digest:handoff.target.executionDigest,stage:handoff.target.stage,steps:handoff.target.steps,intent:null}]);
 return true;
}

/** Approval changes only the next execution window. Previous preparation and
 * continuation receipt remain immutable; no automatic approval or renewal. */
export function admitMigrationContinuation({previous,previousPreparationSha256,previousContinuation=null,
 previousContinuationSha256=null,approval,approvedApprovalSha256,handoff,handoffSha256,contract,now=Date.now()}){
 if(previous.schema!=='d1-storage-placed-migration-preparation-v1'||previous.frozenSource!==true||previous.mode!=='disabled'||previous.executionFenceVersion!==1
  ||!sha(previousPreparationSha256)||!sha(handoffSha256)||!sha(previous.executionDigest)||!sha(previous.roleInputSha256)
  ||!date(previous.expiresAt)||!sha(previous.contractDigest)||identityDigest(contract)!==previous.contractDigest)fail();
 const topology=validatePlacedMigrationTopology(previous.topology);equal(previous.topologyDigest,identityDigest(topology));
 equal(previous.executionDigest,identityDigest({sourceCommit:previous.sourceCommit,roleInputSha256:previous.roleInputSha256,
  contractDigest:previous.contractDigest,expiresAt:previous.expiresAt,topology}));
 exactKeys(approval,['schema','originalPreparationSha256','previousPreparationSha256','previousContinuationSha256','handoffSha256','approvedAt','expiresAt']);
 if(!sha(approvedApprovalSha256)||identityDigest(approval)!==approvedApprovalSha256
  ||approval.schema!=='d1-storage-migration-continuation-approval-v1'||approval.previousPreparationSha256!==previousPreparationSha256
  ||approval.handoffSha256!==handoffSha256||!date(approval.approvedAt)||!date(approval.expiresAt)
  ||Date.parse(approval.approvedAt)>now||Date.parse(approval.approvedAt)<Date.parse(handoff.observedAt)
  ||Date.parse(approval.expiresAt)<=now||Date.parse(approval.expiresAt)<=Date.parse(previous.expiresAt)
  ||Date.parse(approval.expiresAt)-Date.parse(approval.approvedAt)>86400000)fail();
 let original=previousPreparationSha256,window=1;
 if(previousContinuation!==null){
  exactKeys(previousContinuation,['schema','executionFenceVersion','status','originalPreparationSha256','previousPreparationSha256','previousContinuationSha256',
   'approval','approvedApprovalSha256','handoffSha256','checkpoint','sourceCommit','roleInputSha256','contractDigest','topologyDigest',
   'previousExecutionDigest','executionDigest','nextPreparationSha256','rolloverSha256','window','remoteOperations']);
  if(!sha(previousContinuationSha256)||previousContinuation.schema!=='d1-storage-migration-continuation-v1'||previousContinuation.executionFenceVersion!==1
   ||previousContinuation.status!=='prepared-disabled'||!sha(previousContinuation.rolloverSha256)||previousContinuation.nextPreparationSha256!==previousPreparationSha256
   ||previousContinuation.executionDigest!==previous.executionDigest||previousContinuation.sourceCommit!==previous.sourceCommit
   ||previousContinuation.roleInputSha256!==previous.roleInputSha256||previousContinuation.contractDigest!==previous.contractDigest
   ||previousContinuation.topologyDigest!==previous.topologyDigest||previousContinuation.remoteOperations!==false
   ||!Number.isSafeInteger(previousContinuation.window)||previousContinuation.window<1||previousContinuation.window>=32
   ||identityDigest(previousContinuation.approval)!==previousContinuation.approvedApprovalSha256
   ||previousContinuation.approval.expiresAt!==previous.expiresAt)fail();
  original=previousContinuation.originalPreparationSha256;window=previousContinuation.window+1;
 }else if(previousContinuationSha256!==null)fail();
 if(!sha(original)||approval.originalPreparationSha256!==original||approval.previousContinuationSha256!==previousContinuationSha256)fail();
 const checkpoint=validateMigrationHandoff({previous,previousPreparationSha256,contract,handoff,now});
 if(previousContinuation&&(checkpoint.steps<previousContinuation.checkpoint.steps||STORAGE_RESTORE_STAGES.indexOf(checkpoint.stage)<STORAGE_RESTORE_STAGES.indexOf(previousContinuation.checkpoint.stage)))fail();
 return {originalPreparationSha256:original,window,checkpoint,expiresAt:approval.expiresAt,
  executionDigest:identityDigest({sourceCommit:previous.sourceCommit,roleInputSha256:previous.roleInputSha256,
   contractDigest:previous.contractDigest,expiresAt:approval.expiresAt,topology})};
}

/** One explicitly executed target CAS. No retry or intent clearing. The driver
 * uses the same exact DDL guard, so pending old claims cannot cross this fence. */
export function migrationRolloverStatement({contractDigest,previousExecutionDigest,executionDigest,expiresAt,checkpoint}){
 if(!date(expiresAt)||!sha(contractDigest)||!sha(previousExecutionDigest)||!sha(executionDigest)||previousExecutionDigest===executionDigest
  ||checkpoint.contractDigest!==contractDigest||checkpoint.executionDigest!==previousExecutionDigest
  ||!STORAGE_RESTORE_STAGES.includes(checkpoint.stage)||!Number.isSafeInteger(checkpoint.steps)||checkpoint.steps<1||checkpoint.intent!==null)fail();
 return {sql:`UPDATE _authority_operator_progress SET execution_digest=? WHERE id=1 AND contract_digest=? AND execution_digest=?
 AND stage=? AND steps=? AND intent IS NULL AND ${MIGRATION_JOURNAL_GUARD} AND unixepoch('now') < ?
 RETURNING contract_digest,execution_digest,stage,steps,intent`,
 params:[executionDigest,contractDigest,previousExecutionDigest,checkpoint.stage,checkpoint.steps,MIGRATION_JOURNAL_DDL,Math.floor(Date.parse(expiresAt)/1000)]};
}
/** Read-first response-loss classification. Anything beyond the exact before or
 * after row remains unresolved; this never repeats a mutation. */
export function migrationRolloverDisposition(input,row){
 migrationRolloverStatement(input);
 const base={contract_digest:input.contractDigest,stage:input.checkpoint.stage,steps:input.checkpoint.steps,intent:null};
 if(identityDigest(row)===identityDigest({...base,execution_digest:input.executionDigest}))return 'applied';
 if(identityDigest(row)===identityDigest({...base,execution_digest:input.previousExecutionDigest}))return 'not-applied';
 fail();
}

/** Local-only package preparation. All remote reads/stopping/approval are explicit
 * prerequisite artifacts. No provider client or restore/copy API is called here. */
export async function prepareMigrationContinuation({workerRoot,previousDirectory,previousPreparationSha256,contractPath,
 handoffPath,handoffSha256,approvalPath,approvedApprovalSha256,directory,now=Date.now()}){
 workerRoot=resolve(workerRoot);previousDirectory=resolve(previousDirectory);directory=resolve(directory);
 const files=[];const load=async(path,limit)=>{const doc=await document(path,limit);files.push({path:resolve(path),sha256:doc.sha256});return doc;};
 const prior=await load(join(previousDirectory,'preparation.json'));if(prior.sha256!==previousPreparationSha256)fail();
 const previous=prior.value;
 for(const [file,pin]of [['migration-worker.mjs','bundleSha256'],['migration-backend.mjs','backendBundleSha256'],['wrangler.jsonc','frontConfigSha256'],['wrangler.backend.jsonc','backendConfigSha256']]){
  const path=join(previousDirectory,file),hash=storageSha256(await privateBytes(path,4*1024*1024));if(hash!==previous[pin])fail();files.push({path,sha256:hash});
 }
 const contract=await load(contractPath,2*1024*1024),handoff=await load(handoffPath),approval=await load(approvalPath);
 if(handoff.sha256!==handoffSha256)fail();
 let priorContinuation=null;
 try{priorContinuation=await load(join(previousDirectory,'continuation.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const admitted=admitMigrationContinuation({previous,previousPreparationSha256,previousContinuation:priorContinuation?.value??null,
  previousContinuationSha256:priorContinuation?.sha256??null,approval:approval.value,approvedApprovalSha256,handoff:handoff.value,handoffSha256,contract:contract.value,now});
 const inputs=await readIngestionRoleInputs(workerRoot);if(inputs.sourceCommit!==previous.sourceCommit||inputs.inputSha256!==previous.roleInputSha256)fail();
 const evidence={};for(const item of handoff.value.evidence){const path=resolve(dirname(handoffPath),item.path),bytes=await privateBytes(path,2*1024*1024);if(storageSha256(bytes)!==item.sha256)fail();files.push({path,sha256:item.sha256});evidence[item.name]=bytes;}
 verifyMigrationHandoffEvidence({previous,contract:contract.value,handoff:handoff.value,evidence});
 // New parent directory is a no-clobber operation boundary. Interrupted local
 // generation remains incomplete evidence; it never authorizes deployment.
 await mkdir(directory,{mode:0o700});const topologyPath=join(directory,'topology.json');await write(topologyPath,previous.topology);
 const output=join(directory,'package');
 await prepareStorageMigrationWorker({workerRoot,contractPath,contractDigest:previous.contractDigest,directory:output,
  expiresAt:admitted.expiresAt,placedTopologyPath:topologyPath,placedTopologyDigest:previous.topologyDigest});
 for(const item of files)if(storageSha256(await privateBytes(item.path,4*1024*1024))!==item.sha256)fail();
 const next=await document(join(output,'preparation.json'));if(next.value.executionDigest!==admitted.executionDigest
  ||next.value.sourceCommit!==previous.sourceCommit||next.value.roleInputSha256!==previous.roleInputSha256)fail();
 const rollover=migrationRolloverStatement({contractDigest:previous.contractDigest,previousExecutionDigest:previous.executionDigest,executionDigest:admitted.executionDigest,expiresAt:admitted.expiresAt,checkpoint:admitted.checkpoint});
 let index=0;const rolloverSql=rollover.sql.replace(/\?/g,()=>{const v=rollover.params[index++];return typeof v==='number'?String(v):"'"+v.replaceAll("'","''")+"'";})+';\n';
 await writeFile(join(output,'rollover.sql'),rolloverSql,{mode:0o600,flag:'wx'});
 const receipt={schema:'d1-storage-migration-continuation-v1',executionFenceVersion:1,status:'prepared-disabled',originalPreparationSha256:admitted.originalPreparationSha256,
  previousPreparationSha256,previousContinuationSha256:priorContinuation?.sha256??null,approval:approval.value,approvedApprovalSha256,handoffSha256,
  checkpoint:admitted.checkpoint,sourceCommit:previous.sourceCommit,roleInputSha256:previous.roleInputSha256,contractDigest:previous.contractDigest,
  topologyDigest:previous.topologyDigest,previousExecutionDigest:previous.executionDigest,executionDigest:admitted.executionDigest,
  nextPreparationSha256:next.sha256,rolloverSha256:storageSha256(rolloverSql),window:admitted.window,remoteOperations:false};
 await write(join(output,'continuation.json'),receipt);await write(join(directory,'inputs.json'),{files,remoteOperations:false});
 return {status:receipt.status,executionDigest:receipt.executionDigest,preparationSha256:next.sha256,
  continuationSha256:storageSha256(await privateBytes(join(output,'continuation.json'))),window:receipt.window,remoteOperations:false};
}
async function main(){
 const keys={'--worker-root':'workerRoot','--previous-directory':'previousDirectory','--previous-preparation-sha256':'previousPreparationSha256',
  '--contract':'contractPath','--handoff':'handoffPath','--handoff-sha256':'handoffSha256','--approval':'approvalPath',
  '--approved-approval-sha256':'approvedApprovalSha256','--directory':'directory'},options={};
 for(let i=2;i<process.argv.length;i+=2){const key=keys[process.argv[i]];if(!key||Object.hasOwn(options,key)||typeof process.argv[i+1]!=='string')fail();options[key]=process.argv[i+1];}
 if(Object.keys(options).length!==Object.keys(keys).length)fail();console.log(JSON.stringify(await prepareMigrationContinuation(options)));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('D1_STORAGE_MIGRATION_CONTINUATION_REFUSED');process.exitCode=1;});
