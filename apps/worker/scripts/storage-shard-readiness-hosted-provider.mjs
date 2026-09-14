import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {dependencyTreeDigest} from './production-deploy.mjs';
import {createMaintenanceTransport} from './production-maintenance-transport.mjs';
import {maintenanceBindingDigest} from './production-maintenance-provider.mjs';
import {runStorageShardReadinessOperator,storageShardCapacityEvidence,
 storageShardReadinessExpectedResources,validateStorageShardReadinessConfiguration,
 validateStorageShardReadinessOperatorPlan} from './storage-shard-readiness-operator.mjs';
import {identityDigest,openOperation} from '../../../scripts/lib/release-operation.mjs';

const SHA=/^[a-f0-9]{64}$/u,COMMIT=/^[a-f0-9]{40}$/u,ACCOUNT=/^[a-f0-9]{32}$/u;
const DATABASE_NAME=/^[a-z][a-z0-9-]{2,95}$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const WORKER=/^[a-z][a-z0-9-]{2,62}$/u;
const HOST_KEYS=['schema','accountId','sourceCommit','dependencyDigest','runtimeBundleSha256','workerBindingDigest',
 'wranglerSha256','workerName','workerVersionId'];
const fail=code=>{const error=new Error(`STORAGE_SHARD_HOSTED_${code}`);error.code=error.message;throw error;};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
 &&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const hash=value=>createHash('sha256').update(value).digest('hex');
const MAX_QUERIES=64,MAX_ROWS=801,MAX_PARAMS=40,MAX_SQL_BYTES=128*1024,MAX_BATCH=8;

export function validateStorageShardReadinessHost(value){
 if(!exact(value,HOST_KEYS)||value.schema!=='storage-shard-readiness-host-v1'
  ||!ACCOUNT.test(value.accountId)||!COMMIT.test(value.sourceCommit)||!SHA.test(value.dependencyDigest)
  ||!SHA.test(value.runtimeBundleSha256)||!SHA.test(value.workerBindingDigest)||!SHA.test(value.wranglerSha256)
  ||!WORKER.test(value.workerName)||!UUID.test(value.workerVersionId))fail('HOST_INVALID');
 return Object.freeze(structuredClone(value));
}

/** This is a private operator input, not a Worker deployment configuration.
 * It contains exactly the selected catalog, ingestion, paired analytics,
 * deletion-ledger and publication resources. */
export function validateStorageShardReadinessHostedConfiguration(configuration,plan){
 plan=validateStorageShardReadinessOperatorPlan(plan);
 validateStorageShardReadinessConfiguration(configuration,plan);
 const rows=configuration?.d1_databases;
 if(!exact(configuration,['d1_databases'])||rows.length!==5
  ||rows.some(row=>!exact(row,['binding','database_id','database_name'])
   ||!DATABASE_NAME.test(row.database_name))
  ||new Set(rows.map(row=>row.database_name)).size!==5)fail('CONFIG_INVALID');
 const expected=storageShardReadinessExpectedResources(plan);
 return Object.freeze(expected.map(resource=>{
  const matches=rows.filter(row=>row.binding===resource.bindingName
   &&row.database_id===resource.databaseId);
  if(matches.length!==1)fail('CONFIG_INVALID');
  return Object.freeze({...resource,databaseName:matches[0].database_name});
 }));
}

function validateQuery(sql,params){
 if(typeof sql!=='string'||Buffer.byteLength(sql)<1||Buffer.byteLength(sql)>MAX_SQL_BYTES
  ||!Array.isArray(params)||params.length>MAX_PARAMS
  ||params.some(value=>value!==null&&typeof value!=='string'&&!Number.isSafeInteger(value)))fail('QUERY_INVALID');
}

function createRemoteDatabase({databaseId,query}){
 class Statement{
  constructor(sql,params=[]){validateQuery(sql,params);this.sql=sql;this.params=params;}
  bind(...params){return new Statement(this.sql,params);}
  async all(){return query([{sql:this.sql,params:this.params}],false).then(values=>values[0]);}
  async first(column){const result=await this.all(),row=result.results[0]??null;
   if(column===undefined)return row;
   if(typeof column!=='string'||!column||row===null||!Object.hasOwn(row,column))return null;
   return row[column];}
  async run(){return query([{sql:this.sql,params:this.params}],true).then(values=>values[0]);}
 }
 return Object.freeze({
  prepare(sql){return new Statement(sql);},
  async batch(statements){
   if(!Array.isArray(statements)||statements.length<1||statements.length>MAX_BATCH
    ||statements.some(statement=>!(statement instanceof Statement)))fail('BATCH_INVALID');
   return query(statements.map(({sql,params})=>({sql,params})),true);
  },
  databaseId,
 });
}

function sameObservation(left,right){return left&&left.shardId===right.shardId
 &&left.observedBytes===right.observedBytes&&left.observedAt===right.observedAt
 &&left.validUntil===right.validUntil&&left.pressureState===right.pressureState;}
function samePolicy(left,right){return left&&left.shardId===right.shardId
 &&left.allocationTier===right.allocationTier&&left.allocationEnabled===right.allocationEnabled
 &&left.qualificationDigest===right.qualificationDigest&&left.updatedAt===right.updatedAt;}

/** Canonical runtime composition over the Cloudflare D1 query API. The API's
 * `batch` body is kept intact so catalog observation updates execute as one D1
 * transaction. Mutation failures are never retried here; exact readback is the
 * only accepted recovery from an unknown acknowledgement. */
export function createStorageShardReadinessHostedProvider({plan,configuration,deployment,transport,runtime,
 mutationCoordinator}){
 plan=validateStorageShardReadinessOperatorPlan(plan);
 const resources=validateStorageShardReadinessHostedConfiguration(configuration,plan);
 if(!transport||typeof transport.api!=='function'||!runtime
  ||!['qualifyStorageShardRuntimeTuple','readStorageShardReadiness','recordStorageShardReadiness','recordStorageCapacityObservation',
   'configureStorageShardAllocation','readStorageCapacityObservation','readStorageShardAllocationPolicy']
   .every(name=>typeof runtime[name]==='function'))fail('RUNTIME_INVALID');
 if(!exact(deployment,['bindingDigest','sourceCommit','workerName','workerVersionId'])||!COMMIT.test(deployment.sourceCommit)
  ||!SHA.test(deployment.bindingDigest)||!WORKER.test(deployment.workerName)||!UUID.test(deployment.workerVersionId))fail('DEPLOYMENT_INVALID');
 if(!mutationCoordinator||typeof mutationCoordinator.run!=='function')fail('COORDINATOR_INVALID');
 const accountPath=transport.accountPath;
 if(typeof accountPath!=='string'||!/^\/accounts\/[a-f0-9]{32}$/u.test(accountPath))fail('TRANSPORT_INVALID');
 let queries=0;
 const queryFor=databaseId=>async(statements,mutation)=>{
  if(++queries>MAX_QUERIES||!Array.isArray(statements)||statements.length<1||statements.length>MAX_BATCH)fail('QUERY_BUDGET');
  for(const statement of statements)validateQuery(statement.sql,statement.params);
  const body=statements.length===1?statements[0]:{batch:statements};
  const value=await transport.api(`${accountPath}/d1/database/${databaseId}/query`,body,{mutation});
  if(!Array.isArray(value)||value.length!==statements.length||value.some(result=>!result
   ||result.success!==true||!Array.isArray(result.results)||result.results.length>MAX_ROWS))fail(mutation?'MUTATION_UNCERTAIN':'READ_UNCERTAIN');
  return value.map(result=>({success:true,results:result.results,meta:result.meta??{}}));
 };
 const databases=Object.fromEntries(resources.map(resource=>[resource.role,
  createRemoteDatabase({databaseId:resource.databaseId,query:queryFor(resource.databaseId)})]));
 const describeResources=async()=>{
  const deploymentList=await transport.api(`${accountPath}/workers/scripts/${deployment.workerName}/deployments`);
  const latest=Array.isArray(deploymentList)?deploymentList[0]:deploymentList?.deployments?.[0];
  if(!latest||!Array.isArray(latest.versions)||latest.versions.length!==1
   ||latest.versions[0].version_id!==deployment.workerVersionId||latest.versions[0].percentage!==100)fail('DEPLOYMENT_CHANGED');
  const version=await transport.api(`${accountPath}/workers/scripts/${deployment.workerName}/versions/${deployment.workerVersionId}`);
  const bindings=version?.resources?.bindings;
  if(version?.id!==deployment.workerVersionId||!Array.isArray(bindings)||bindings.length>128
   ||bindings.some(binding=>!binding||typeof binding.name!=='string'||!binding.name)
   ||new Set(bindings.map(binding=>binding.name)).size!==bindings.length)fail('DEPLOYMENT_CHANGED');
  if(maintenanceBindingDigest(bindings)!==deployment.bindingDigest)fail('DEPLOYMENT_CHANGED');
  const source=bindings.filter(binding=>binding.type==='plain_text'&&binding.name==='DEPLOYMENT_SOURCE_COMMIT');
  if(source.length!==1||source[0].text!==deployment.sourceCommit)fail('DEPLOYMENT_CHANGED');
  const d1=bindings.filter(binding=>binding.type==='d1');
  for(const resource of resources){
   const physical=binding=>{if(binding.id!==undefined&&binding.database_id!==undefined
    &&binding.id!==binding.database_id)fail('BINDINGS_CHANGED');return binding.id??binding.database_id;};
   const matches=d1.filter(binding=>binding.name===resource.bindingName
    &&physical(binding)===resource.databaseId);
   if(matches.length!==1||d1.some(binding=>binding.name!==resource.bindingName
    &&physical(binding)===resource.databaseId))fail('BINDINGS_CHANGED');
  }
  const observed=[];
  for(const resource of resources){
   const value=await transport.api(`${accountPath}/d1/database/${resource.databaseId}`);
   if(!value||value.uuid!==resource.databaseId||value.name!==resource.databaseName)fail('RESOURCE_IDENTITY_CHANGED');
   observed.push(Object.freeze({role:resource.role,bindingName:resource.bindingName,databaseId:resource.databaseId}));
  }
  return Object.freeze(observed);
 };
 return Object.freeze({
  describeResources,
  async measureIngestionSize(databaseId){
   if(databaseId!==plan.ingestionDatabaseId)fail('RESOURCE_IDENTITY_CHANGED');
   const result=await databases.ingestion.prepare('SELECT 1 AS storage_shard_size_probe').all();
   const observedBytes=result.meta?.size_after;
   if(!Number.isSafeInteger(observedBytes)||observedBytes<0)fail('CAPACITY_UNAVAILABLE');
   return storageShardCapacityEvidence({databaseId,observedBytes,
    observedAt:plan.capacityObservation.observedAt,validUntil:plan.capacityObservation.validUntil});
  },
  qualify:runtimePlan=>runtime.qualifyStorageShardRuntimeTuple(runtimePlan,databases),
  async record(candidate){return mutationCoordinator.run({name:'readiness',intent:candidate,
   reconcile:async()=>{const stored=await runtime.readStorageShardReadiness(databases.catalog,candidate.readinessDigest);
    return stored&&identityDigest(stored)===identityDigest(candidate)?stored:null;},
   mutate:()=>runtime.recordStorageShardReadiness(databases.catalog,candidate)});},
  async observe(observation){
   return mutationCoordinator.run({name:'observation',intent:observation,
    reconcile:async()=>{let stored;try{stored=await runtime.readStorageCapacityObservation(databases.catalog,observation.shardId);}
     catch{fail('ACTIVATION_UNCERTAIN');}return sameObservation(stored,observation)?stored:null;},
    mutate:async()=>{try{await runtime.recordStorageCapacityObservation(databases.catalog,observation);}catch{/* exact readback by coordinator */}}});
  },
  async configure(policy){
   await describeResources();
   return mutationCoordinator.run({name:'policy',intent:policy,
    reconcile:async()=>{let stored;try{stored=await runtime.readStorageShardAllocationPolicy(databases.catalog,policy.shardId);}
     catch{fail('ACTIVATION_UNCERTAIN');}return samePolicy(stored,policy)?stored:null;},
    mutate:async()=>{try{await runtime.configureStorageShardAllocation(databases.catalog,policy);}catch{/* exact readback by coordinator */}}});
  },
  async readPolicy(shardId){
   const stored=await runtime.readStorageShardAllocationPolicy(databases.catalog,shardId);
   if(!stored)fail('ACTIVATION_UNCERTAIN');
   return Object.freeze({allocationTier:stored.allocationTier,allocationEnabled:stored.allocationEnabled,
    qualificationDigest:stored.qualificationDigest,updatedAt:stored.updatedAt});
  },
  observation:()=>Object.freeze({queries}),
 });
}

function assertExactSource(workerRoot,sourceCommit){
 try{
  const root=execFileSync('/usr/bin/git',['-C',workerRoot,'rev-parse','--show-toplevel'],{encoding:'utf8',maxBuffer:64*1024}).trim();
  const head=execFileSync('/usr/bin/git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',maxBuffer:64*1024}).trim();
  const status=execFileSync('/usr/bin/git',['-C',root,'status','--porcelain','--untracked-files=all'],{encoding:'utf8',maxBuffer:1024*1024}).trim();
  if(head!==sourceCommit||status)fail('SOURCE_CHANGED');
 }catch(error){if(error?.code==='STORAGE_SHARD_HOSTED_SOURCE_CHANGED')throw error;fail('SOURCE_CHANGED');}
}

async function buildCanonicalRuntime({workerRoot,sourceCommit}){
 workerRoot=resolve(workerRoot);assertExactSource(workerRoot,sourceCommit);
 const dependencyPath=join(workerRoot,'node_modules'),dependencyDigest=await dependencyTreeDigest(dependencyPath);
 const require=createRequire(join(workerRoot,'package.json')),{build}=require('esbuild');
 const source=`export {captureStorageShardReadinessSchemaDigests,qualifyStorageShardRuntimeTuple,readStorageShardReadiness,recordStorageShardReadiness} from './src/storage-shard-readiness.ts';
export {recordStorageCapacityObservation,configureStorageShardAllocation,readStorageCapacityObservation,readStorageShardAllocationPolicy} from './src/storage-capacity.ts';`;
 const built=await build({stdin:{contents:source,resolveDir:workerRoot,sourcefile:'storage-shard-readiness-hosted-runtime.ts',loader:'ts'},
  bundle:true,platform:'node',target:'node26',format:'esm',mainFields:['module','main'],write:false,logLevel:'silent'});
 if(built.outputFiles.length!==1)fail('RUNTIME_INVALID');
 const bytes=Buffer.from(built.outputFiles[0].contents),runtimeBundleSha256=hash(bytes);
 if(await dependencyTreeDigest(dependencyPath)!==dependencyDigest)fail('DEPENDENCIES_CHANGED');
 assertExactSource(workerRoot,sourceCommit);
 let runtime;try{runtime=await import(`data:text/javascript;base64,${bytes.toString('base64')}`);}
 catch{fail('RUNTIME_INVALID');}
 return Object.freeze({runtime,runtimeBundleSha256,dependencyDigest,workerRoot,dependencyPath});
}

/** Local-only provenance capture used to prepare the immutable hosted input.
 * The root runner independently recomputes every value before remote reads. */
export async function captureStorageShardReadinessHostedProvenance({workerRoot,sourceCommit}){
 if(!COMMIT.test(sourceCommit??''))fail('SOURCE_CHANGED');
 const built=await buildCanonicalRuntime({workerRoot,sourceCommit});
 return Object.freeze({sourceCommit,dependencyDigest:built.dependencyDigest,
  runtimeBundleSha256:built.runtimeBundleSha256});
}

export function createStorageShardReadinessMutationCoordinator({operation,beforeMutation}){
 const allowed=new Set(['readiness','observation','policy']);
 let state=operation.record.state;
 if(!exact(state,[])&&!exact(state,['schema','steps','complete']))fail('OPERATION_INVALID');
 if(exact(state,[]))state={schema:'storage-shard-readiness-mutations-v1',steps:{},complete:false};
 if(state.schema!=='storage-shard-readiness-mutations-v1'||!state.steps||typeof state.steps!=='object'
  ||Array.isArray(state.steps)||typeof state.complete!=='boolean')fail('OPERATION_INVALID');
 for(const [name,step] of Object.entries(state.steps))if(!allowed.has(name)
  ||!exact(step,['intentDigest','status'])||!SHA.test(step.intentDigest)||!['intent','committed'].includes(step.status))fail('OPERATION_INVALID');
 const save=async()=>operation.save(state);
 return Object.freeze({
  async run({name,intent,reconcile,mutate}){
   if(!allowed.has(name)||typeof reconcile!=='function'||typeof mutate!=='function')fail('OPERATION_INVALID');
   const intentDigest=identityDigest(intent),existing=state.steps[name];
   if(existing&&existing.intentDigest!==intentDigest)fail('OPERATION_INPUT_MISMATCH');
   let observed;try{observed=await reconcile();}catch{fail('RECONCILIATION_UNAVAILABLE');}
   if(observed){
    if(!existing)state.steps[name]={intentDigest,status:'committed'};
    else if(existing.status==='intent')existing.status='committed';
    await save();return observed;
   }
   if(existing)fail(existing.status==='intent'?'MUTATION_UNRESOLVED':'MUTATION_CHANGED');
   await beforeMutation();state.steps[name]={intentDigest,status:'intent'};await save();await beforeMutation();
   try{await mutate();}catch(error){
    try{observed=await reconcile();}catch{/* retained intent forces read-only resume */}
    if(!observed)throw error;
   }
   if(!observed)try{observed=await reconcile();}catch{fail('RECONCILIATION_UNAVAILABLE');}
   if(!observed)fail('MUTATION_UNRESOLVED');
   state.steps[name].status='committed';await save();return observed;
  },
  async complete(){
   if([...allowed].some(name=>state.steps[name]?.status!=='committed'))fail('OPERATION_INCOMPLETE');
   state.complete=true;await save();
  },
 });
}

/** Root invocation surface. Construction performs local source/config checks
 * before the first credentialed request. It creates no database or Worker and
 * only the catalog record/observation/policy calls are admitted as mutations. */
export async function runHostedStorageShardReadiness({plan,configuration,host,workerRoot,
 operationDirectory,cliPath,resume=false,clock=Date.now,fetcher=fetch,environment=process.env}){
 plan=validateStorageShardReadinessOperatorPlan(plan);host=validateStorageShardReadinessHost(host);
 validateStorageShardReadinessHostedConfiguration(configuration,plan);
 if(typeof resume!=='boolean')fail('OPERATION_INVALID');
 const built=await buildCanonicalRuntime({workerRoot,sourceCommit:host.sourceCommit});
 if(built.dependencyDigest!==host.dependencyDigest||built.runtimeBundleSha256!==host.runtimeBundleSha256)fail('PROVENANCE_CHANGED');
 const canonical=resolve(operationDirectory),binding={schema:'storage-shard-readiness-hosted-operation-v1',plan,configuration,host};
 const operation=await openOperation({directory:canonical,kind:'qualification',binding,resume});
 try{
 const base=createMaintenanceTransport({plan:{accountId:host.accountId,wranglerSha256:host.wranglerSha256},
  operationDirectory:canonical,cliPath,fetcher,environment});
 const transport={accountPath:`/accounts/${host.accountId}`,api:base.api};
 await base.receipt({kind:'storage-shard-readiness-hosted-admission',sourceCommit:host.sourceCommit,
   dependencyDigest:host.dependencyDigest,runtimeBundleSha256:host.runtimeBundleSha256,
   workerVersionId:host.workerVersionId,workerBindingDigest:host.workerBindingDigest,
   resourceIds:storageShardReadinessExpectedResources(plan).map(value=>value.databaseId),
   planSha256:identityDigest(plan),configurationSha256:identityDigest(configuration),remoteWrites:false});
  const beforeMutation=async()=>{
   assertExactSource(built.workerRoot,host.sourceCommit);
   if(await dependencyTreeDigest(built.dependencyPath)!==host.dependencyDigest)fail('DEPENDENCIES_CHANGED');
   const now=clock();if(!Number.isSafeInteger(now)||now>plan.expiresAt||now>plan.capacityObservation.validUntil)fail('WINDOW_CLOSED');
  };
  const mutationCoordinator=createStorageShardReadinessMutationCoordinator({operation,beforeMutation});
  const deployment={sourceCommit:host.sourceCommit,workerName:host.workerName,
   workerVersionId:host.workerVersionId,bindingDigest:host.workerBindingDigest};
  const api=createStorageShardReadinessHostedProvider({plan,configuration,deployment,transport,runtime:built.runtime,
   mutationCoordinator});
  const result=await runStorageShardReadinessOperator({plan,api,configuration,clock});
  await mutationCoordinator.complete();
  await base.receipt({kind:'storage-shard-readiness-hosted-complete',sourceCommit:host.sourceCommit,
   dependencyDigest:host.dependencyDigest,runtimeBundleSha256:host.runtimeBundleSha256,
   workerVersionId:host.workerVersionId,workerBindingDigest:host.workerBindingDigest,
   resourceIds:storageShardReadinessExpectedResources(plan).map(value=>value.databaseId),
   readinessDigest:result.readinessDigest,resourceDigest:result.resourceDigest,remoteWrites:true,
   queryCount:api.observation().queries});
  return result;
 }finally{operation.close();}
}
