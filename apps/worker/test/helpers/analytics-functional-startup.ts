import {sha256Hex} from '../../src/crypto';
import {createWholeWorkloadMeter,summarizeWholeWorkload} from './analytics-whole-workload';
import type {FunctionalActivationKernel,FunctionalActivationBuild} from './analytics-functional-runtime-activation';
import {buildFunctionalActivationRequest} from './analytics-functional-runtime-activation';
export interface FunctionalStartupMigration {directory:string;name:string;sql:string;sha256:string;queries:string[];querySha256:string[];}
export interface FunctionalStartupInputs {schemaVersion:'analytics-functional-startup-inputs-v1';frontier:'full'|'maintained-predecessor';
 migrations:Record<'source'|'target'|'ledger',FunctionalStartupMigration[]>;inputSha256:string;totalBytes:number;}
type Kernel=FunctionalActivationKernel&Pick<typeof import('./analytics-workload-kernels'),
 'initializeStorageSource'|'initializeTypedV1Admission'|'initializeTypedV11Admission'|'drainCommunityPublicSourceBootstrap'|'initializeStorageAnalyticsRuntime'>;
const ledgerDdl='CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT';
const groups={source:['migrations','typed-ingestion-migrations','ingestion-bridge-migrations','typed-v1-admission-migrations','typed-v11-admission-migrations','ingestion-isolation-migrations'],target:['analytics-migrations'],ledger:['deletion-ledger-migrations']};
const fail=(code:string):never=>{throw Error('FUNCTIONAL_STARTUP_'+code);};
export async function verifyFunctionalStartupInputs(input:FunctionalStartupInputs,expectedInputSha256:string){
 if(input.schemaVersion!=='analytics-functional-startup-inputs-v1'||!['full','maintained-predecessor'].includes(input.frontier)
  ||!/^[a-f0-9]{64}$/u.test(expectedInputSha256)||input.inputSha256!==expectedInputSha256
  ||Object.keys(input).sort().join(',')!=='frontier,inputSha256,migrations,schemaVersion,totalBytes'
  ||Object.keys(input.migrations).sort().join(',')!=='ledger,source,target')fail('INPUT_SHAPE');
 const {schemaVersion,frontier,migrations}=input;
 if(await sha256Hex(JSON.stringify({schemaVersion,frontier,migrations}))!==expectedInputSha256)fail('INPUT_DIGEST');
 let bytes=0;
 for(const role of ['source','target','ledger'] as const){const values=migrations[role];
  if(!values.length||values.length>128||new Set(values.map(value=>value.name)).size!==values.length)fail('INPUT_COUNT');
  let previousGroup=-1,previousName='';
  for(const value of values){const group=groups[role].indexOf(value.directory);
   if(Object.keys(value).sort().join(',')!=='directory,name,queries,querySha256,sha256,sql'||group<0||group<previousGroup
    ||group===previousGroup&&value.name<=previousName||!/^\d{4}_[a-z0-9_-]+\.sql$/u.test(value.name)
    ||frontier==='maintained-predecessor'&&(value.directory==='ingestion-isolation-migrations'&&value.name>='0014_'||value.directory==='analytics-migrations'&&value.name>='0034_'))fail('INPUT_ORDER');
   previousGroup=group;previousName=value.name;const size=new TextEncoder().encode(value.sql).length;bytes+=size;
   if(size<1||size>512*1024||value.sql.includes('\0')||await sha256Hex(value.sql)!==value.sha256
    ||!value.queries.length||value.queries.length>900||value.querySha256.length!==value.queries.length)fail('INPUT_SOURCE');
   for(let i=0;i<value.queries.length;i++)if(!value.queries[i]!.trim()||await sha256Hex(value.queries[i]!)!==value.querySha256[i])fail('INPUT_QUERY');
  }
  if(groups[role].some(directory=>!values.some(value=>value.directory===directory)))fail('INPUT_GROUP');
 }
 if(bytes!==input.totalBytes||bytes>16*1024*1024)fail('INPUT_BYTES');
}
const used=new WeakSet<D1Database>();
/** Pristine laboratory startup only. Each actual migration and its source-byte
 * ledger entry share one native D1 batch. No reset/import/drop-latest path is
 * exposed. The returned stores stay live for all pre/transition/post callers. */
export async function initializeFunctionalStagedStartup(input:{source:D1Database;target:D1Database;ledger:D1Database;
 sourceId:string;sourceNamespace:string;kernel:Kernel;build:FunctionalActivationBuild;inputs:FunctionalStartupInputs;expectedInputSha256:string}){
 if(!/^synthetic-p11-[A-Za-z0-9:_-]{1,110}$/u.test(input.sourceId)||input.sourceId!==input.sourceNamespace
  ||new Set([input.source,input.target,input.ledger]).size!==3||[input.source,input.target,input.ledger].some(db=>used.has(db)))fail('PRISTINE_SCOPE');
 await verifyFunctionalStartupInputs(input.inputs,input.expectedInputSha256);
 const io=createWholeWorkloadMeter(input.source,input.target,undefined,undefined,input.ledger);io.setPhase('owner_metadata');
 let boundary='pristine';const applied:{role:string;name:string;sourceSha256:string;statements:number}[]=[];
 try{
  await io.invocation('functional_startup_pristine',async(db,_budget,ledger)=>{
   for(const handle of [db.source,db.target,ledger!]){const count=await handle.prepare("SELECT count(*) n FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name!='d1_migrations' AND tbl_name!='d1_migrations'").first<number>('n');
    if(count!==0)fail('NONEMPTY');}
  });
  for(const db of [input.source,input.target,input.ledger])used.add(db);
  await io.invocation('functional_startup_journals',async(db,_budget,ledger)=>{for(const handle of [db.source,db.target,ledger!])await handle.prepare(ledgerDdl).run();});
  const apply=async(role:'source'|'target'|'ledger',value:FunctionalStartupMigration)=>{
   boundary=role+'_'+value.name;
   await io.invocation('functional_startup_atomic_migration',async(db,_budget,ledger)=>{
    const handle=role==='ledger'?ledger!:db[role];
    const result=await handle.batch([...value.queries.map(sql=>handle.prepare(sql)),handle.prepare('INSERT INTO d1_storage_migrations(name,sha256) VALUES(?,?)').bind(value.name,value.sha256)]);
    if(result.length!==value.queries.length+1||result.some(row=>row.success!==true))fail('MIGRATION_RESULT');
   });applied.push({role,name:value.name,sourceSha256:value.sha256,statements:value.queries.length+1});
  };
  for(const value of input.inputs.migrations.source.filter(value=>value.directory!=='ingestion-isolation-migrations'))await apply('source',value);
  boundary='native_source_initialization';await io.invocation(boundary,async db=>{
   await input.kernel.initializeStorageSource(db.source,input.sourceId);
   await input.kernel.initializeTypedV1Admission(db.source,input.sourceNamespace);
   await input.kernel.initializeTypedV11Admission(db.source,input.sourceNamespace);
  });
  for(const value of input.inputs.migrations.source.filter(value=>value.directory==='ingestion-isolation-migrations'))await apply('source',value);
  for(const role of ['target','ledger'] as const)for(const value of input.inputs.migrations[role])await apply(role,value);
  boundary='native_analytics_initialization';await io.invocation(boundary,async db=>{
   if(!(await input.kernel.drainCommunityPublicSourceBootstrap(db.source)).completed)fail('BOOTSTRAP_INCOMPLETE');
   await input.kernel.initializeStorageAnalyticsRuntime({...db,sourceId:input.sourceId,sourceNamespace:input.sourceNamespace});
  });
  boundary='native_v12_activation';const nowEpoch=Date.now(),request=await io.invocation('functional_startup_reconciliation',async db=>
   buildFunctionalActivationRequest(input.kernel,{build:input.build,nowEpoch,idempotencyKey:crypto.randomUUID(),target:'usage_v12',
    primary:await input.kernel.telemetryRuntimeReconciliationDigests(db.source),analytics:await input.kernel.telemetryRuntimeReconciliationDigests(db.target)}));
  const activation=await io.invocation(boundary,db=>input.kernel.activateTelemetryRuntimeAsOwner(db.source,{
   TELEMETRY_STORAGE_MODE:'typed',TELEMETRY_STORAGE_NAMESPACE:input.sourceNamespace,DEPLOYMENT_SOURCE_COMMIT:input.build.sourceCommit,ANALYTICS_DB:db.target},
   'a'.repeat(64),request,nowEpoch));
  if(activation.state!=='active'||activation.fromRevision!==1||activation.toRevision!==2)fail('NATIVE_V12_TRANSITION');
  await io.invocation('functional_startup_staged_correction',async db=>{
   const runtime=await db.source.prepare('SELECT state FROM telemetry_usage_correction_runtime WHERE id=1').first<string>('state');if(runtime!=='staged')fail('CORRECTION_ALREADY_ACTIVE');
  });
  return {receipt:{schemaVersion:'analytics-pristine-staged-startup-v1',frontier:input.inputs.frontier,inputSha256:input.inputs.inputSha256,
   applied,correctionState:'staged',v12NativeActivation:true,physicalStores:3,costs:summarizeWholeWorkload(io.profile),
   localSyntheticAttestation:true,hostedAuthorizationQualification:false,postStartImports:0,postStartResets:0}};
 }catch(error){console.log('P11_STAGED_STARTUP_INCOMPLETE '+JSON.stringify({boundary,applied,costs:summarizeWholeWorkload(io.profile),complete:false}));throw error;}
}
