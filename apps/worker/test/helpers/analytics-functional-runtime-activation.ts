import {expect} from 'vitest';
import {canonicalJson} from '../../src/canonical-json';
import {sha256Hex} from '../../src/crypto';
import {createWholeWorkloadMeter,summarizeWholeWorkload} from './analytics-whole-workload';
import {captureAnalyticsMutationSnapshot,type MutationSnapshot,type MutationTable,type MutationCell} from './analytics-mutation-capture';
import type {FunctionalLane,FunctionalScenarioContext} from './analytics-functional-branches';
import type * as NativeActivation from '../../src/telemetry-runtime-activation';

export type FunctionalActivationKernel=Pick<typeof NativeActivation,'activateTelemetryRuntimeAsOwner'
 |'canonicalTelemetryRuntimeDeploymentAttestationJson'|'canonicalTelemetryRuntimeReconciliationJson'
 |'telemetryRuntimeReconciliationDigests'|'parseTelemetryRuntimeActivationRequest'>;
export interface FunctionalActivationBuild {sourceCommit:string;bundleSha256:string;configSha256:string;versionId:string;}
const lanes=['reference','candidate'] as const;
const hex=(value:string)=>/^[a-f0-9]{64}$/u.test(value);
const uuid=(value:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const fail=(code:string):never=>{throw Error('FUNCTIONAL_RUNTIME_'+code);};
const equal=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
function table(snapshot:MutationSnapshot,name:string){const value=snapshot.source.tables[name];if(!value)fail('REQUIRED_TABLE');return value!;}
function scalar(row:MutationTable['rows'][number],value:MutationTable,name:string):MutationCell{
 const index=value.columns.findIndex(column=>column.name===name);if(index<0)fail('COLUMN');return row.cells[index]!;
}
function runtimeState(snapshot:MutationSnapshot,state:'staged'|'active'){
 const value=table(snapshot,'telemetry_usage_correction_runtime');
 if(!equal(value.columns,[{name:'id',type:'INTEGER'},{name:'schema_version',type:'TEXT'},{name:'method_version',type:'TEXT'},
  {name:'state',type:'TEXT'},{name:'max_capture_rows',type:'INTEGER'},{name:'max_history_page',type:'INTEGER'}])
  ||!equal(value.keyColumns,['id'])||value.rows.length!==1
  ||!equal(value.rows[0],{key:[['integer','1']],cells:[['integer','1'],['text','telemetry-usage-correction-v1'],
   ['text','usage-total-correction-v1'],['text',state],['integer','200'],['integer','200']]}))fail('RUNTIME_SINGLETON');
 return value;
}
/** Local synthetic request with the same native hash/parser contract. This is
 * not evidence of a deployed Worker, Access session, or live owner attestation. */
export async function buildFunctionalActivationRequest(kernel:FunctionalActivationKernel,input:{build:FunctionalActivationBuild;
 nowEpoch:number;idempotencyKey:string;target?:'usage_correction'|'usage_v12';primary:NativeActivation.TelemetryRuntimeReconciliationRole;
 analytics:NativeActivation.TelemetryRuntimeReconciliationRole}):Promise<NativeActivation.TelemetryRuntimeActivationRequest>{
 const {build,nowEpoch,idempotencyKey,primary,analytics}=input;const target=input.target??'usage_correction';
 if(!['usage_correction','usage_v12'].includes(target)||!/^[a-f0-9]{40}$/u.test(build.sourceCommit)||![build.bundleSha256,build.configSha256].every(hex)
  ||!uuid(build.versionId)||!uuid(idempotencyKey)||!Number.isSafeInteger(nowEpoch)||nowEpoch<0
  ||!Number.isFinite(new Date(nowEpoch).getTime())||[primary,analytics].some(value=>!value||!hex(value.schemaSha256)||!hex(value.ledgerSha256)))fail('LOCAL_ATTESTATION');
 const capturedAt=new Date(nowEpoch).toISOString();
 const unsigned={schema:'typed-forward-live-deployment-attestation-v1' as const,capturedAt,
  sourceCommit:build.sourceCommit,versionId:build.versionId,configSha256:build.configSha256};
 const deploymentAttestation={...unsigned,attestationSha256:await sha256Hex(kernel.canonicalTelemetryRuntimeDeploymentAttestationJson(unsigned))};
 const proof={schema:'typed-forward-post-deploy-reconciliation-v1' as const,capturedAt,sourceCommit:build.sourceCommit,
  versionId:build.versionId,configSha256:build.configSha256,deploymentAttestation,primary,analytics};
 return kernel.parseTelemetryRuntimeActivationRequest({action:'run_maintenance',telemetryRuntimeActivation:{
  idempotencyKey,target,expectedRevision:target==='usage_correction'?0:1,confirmation:target==='usage_correction'?'activate_telemetry_usage_correction_runtime':'activate_telemetry_v12_runtime',
  reconciliation:{...proof,proofSha256:await sha256Hex(kernel.canonicalTelemetryRuntimeReconciliationJson(proof))}}});
}
/** Every prior source cell is retained exactly. Only the genuine singleton
 * transition and one fully bound native audit append may differ. */
export async function proveFunctionalRuntimeTransition(before:MutationSnapshot,after:MutationSnapshot,input:{
 request:NativeActivation.TelemetryRuntimeActivationRequest;actorIdentityKey:string;nowEpoch:number}){
 const {request,actorIdentityKey,nowEpoch}=input;
 if(!hex(actorIdentityKey)||!uuid(request.idempotencyKey)||request.target!=='usage_correction'||request.expectedRevision!==0
  ||request.confirmation!=='activate_telemetry_usage_correction_runtime'||before.schemaVersion!=='analytics-mutation-logical-snapshot-v1'||before.schemaVersion!==after.schemaVersion
  ||before.source.schemaSha256!==after.source.schemaSha256
  ||!equal(Object.keys(before.source.tables).sort(),Object.keys(after.source.tables).sort())
  ||!equal(before.target,after.target)||!equal(before.affectedDays,after.affectedDays))fail('SCHEMA_OR_TARGET_CHANGED');
 runtimeState(before,'staged');runtimeState(after,'active');
 const left=table(before,'admin_action_audit'),right=table(after,'admin_action_audit');
 if(!equal(left.columns,right.columns)||!equal(left.keyColumns,right.keyColumns)||right.rows.length!==left.rows.length+1)fail('AUDIT_APPEND');
 const prior=new Map(left.rows.map(row=>[canonicalJson(row.key),row]));
 const added=right.rows.filter(row=>!prior.has(canonicalJson(row.key)));
 if(added.length!==1||right.rows.some(row=>prior.has(canonicalJson(row.key))&&!equal(row,prior.get(canonicalJson(row.key)))))fail('AUDIT_PRIOR_CHANGED');
 const row=added[0]!,details={schemaVersion:'telemetry-runtime-activation-v1',task:'telemetry_runtime_activation',
  idempotencyKey:request.idempotencyKey,target:request.target,expectedRevision:request.expectedRevision,
  reconciliation:request.reconciliation,fromRevision:0,toRevision:1,state:'active'};
 const expected:Record<string,MutationCell>={operation_id:['text',request.idempotencyKey],action:['text','run_maintenance'],
  actor_identity_digest:['text',await sha256Hex('app-usagemonitor/admin-actor/v1\0'+actorIdentityKey)],outcome:['text','success'],
  created_at:['text',new Date(nowEpoch).toISOString()]};
 if(!equal(right.columns,[{name:'id',type:'INTEGER'},{name:'operation_id',type:'TEXT'},{name:'action',type:'TEXT'},
  {name:'actor_identity_digest',type:'TEXT'},{name:'outcome',type:'TEXT'},{name:'details_json',type:'TEXT'},{name:'created_at',type:'TEXT'}])
  ||!equal(right.keyColumns,['id'])||!equal(row.key,[scalar(row,right,'id')])
  ||scalar(row,right,'id')[0]!=='integer'||BigInt(scalar(row,right,'id')[1]!)<1n
  ||left.rows.some(value=>BigInt(scalar(value,left,'id')[1]!)>=BigInt(scalar(row,right,'id')[1]!))
  ||Object.entries(expected).some(([name,value])=>!equal(scalar(row,right,name),value)))fail('AUDIT_NATIVE_FIELDS');
 const json=scalar(row,right,'details_json');if(json[0]!=='text'||typeof json[1]!=='string'||json[1].length>2000)fail('AUDIT_DETAILS');
 try{if(!equal(JSON.parse(json[1]!),details))fail('AUDIT_DETAILS');}catch{fail('AUDIT_DETAILS');}
 for(const name of Object.keys(before.source.tables))if(name!=='telemetry_usage_correction_runtime'&&name!=='admin_action_audit'
  &&!equal(before.source.tables[name],after.source.tables[name]))fail('ACCEPTED_SOURCE_CHANGED');
 return {schemaVersion:'analytics-native-runtime-transition-proof-v1',fromState:'staged',toState:'active',
  preservedSourceTables:Object.keys(before.source.tables).length-2,preservedTargetLineage:true,priorSourceRowsExact:true,
  beforeSnapshotSha256:await sha256Hex(canonicalJson(before)),afterSnapshotSha256:await sha256Hex(canonicalJson(after)),
  beforeRuntimeSha256:await sha256Hex(canonicalJson(table(before,'telemetry_usage_correction_runtime'))),
  afterRuntimeSha256:await sha256Hex(canonicalJson(table(after,'telemetry_usage_correction_runtime'))),
  nativeAuditSha256:await sha256Hex(canonicalJson(row)),reconciliationSha256:request.reconciliation.proofSha256};
}

/** Must run on a separately initialized genuinely staged startup. No code here
 * installs schema/ledger rows, rewrites the runtime, resets, or restores a DB. */
export async function activateFunctionalCorrectionRuntime(input:{context:FunctionalScenarioContext;
 kernels:Record<FunctionalLane,FunctionalActivationKernel>;builds:Record<FunctionalLane,FunctionalActivationBuild>;
 sourceId:string;sourceNamespace:string;actorIdentityKey:string}){
 if(!/^synthetic-p11-[A-Za-z0-9:_-]{1,110}$/u.test(input.sourceId)||input.sourceId!==input.sourceNamespace
  ||input.context.now!==Date.now||!hex(input.actorIdentityKey)
  ||new Set(lanes.flatMap(lane=>Object.values(input.context[lane]))).size!==6)fail('LABORATORY_SCOPE');
 const meters=Object.fromEntries(lanes.map(lane=>[lane,createWholeWorkloadMeter(input.context[lane].source,input.context[lane].target,
  undefined,undefined,input.context[lane].ledger)])) as Record<FunctionalLane,ReturnType<typeof createWholeWorkloadMeter>>;
 const captures:Partial<Record<FunctionalLane,{before:unknown;after:unknown}>>={},proof:Partial<Record<FunctionalLane,unknown>>={};
 const nowEpoch=Date.now(),idempotencyKey=crypto.randomUUID();let boundary='before_capture';
 try{
  for(const lane of lanes){
   const kernel=input.kernels[lane],meter=meters[lane],build=input.builds[lane];
   const before=await captureAnalyticsMutationSnapshot(input.context[lane]);runtimeState(before.snapshot,'staged');
   captures[lane]={before:{...before,snapshot:undefined},after:null};meter.setPhase('owner_metadata');boundary=lane+'_reconciliation';
   const request=await meter.invocation('native_runtime_reconciliation',async db=>buildFunctionalActivationRequest(kernel,{build,nowEpoch,idempotencyKey,
    primary:await kernel.telemetryRuntimeReconciliationDigests(db.source),analytics:await kernel.telemetryRuntimeReconciliationDigests(db.target)}));
   boundary=lane+'_activation';
   const activated=await meter.invocation('native_owner_runtime_activation',db=>kernel.activateTelemetryRuntimeAsOwner(db.source,{
    TELEMETRY_STORAGE_MODE:'typed',TELEMETRY_STORAGE_NAMESPACE:input.sourceNamespace,DEPLOYMENT_SOURCE_COMMIT:build.sourceCommit,
    ANALYTICS_DB:db.target},input.actorIdentityKey,request,nowEpoch));
   expect(activated).toEqual({task:'telemetry_runtime_activation',operationId:idempotencyKey,target:'usage_correction',state:'active',fromRevision:0,toRevision:1,revision:1});
   boundary=lane+'_exact_replay';
   const replay=await meter.invocation('native_owner_runtime_replay',db=>kernel.activateTelemetryRuntimeAsOwner(db.source,{
    TELEMETRY_STORAGE_MODE:'typed',TELEMETRY_STORAGE_NAMESPACE:input.sourceNamespace,DEPLOYMENT_SOURCE_COMMIT:build.sourceCommit,
    ANALYTICS_DB:db.target},input.actorIdentityKey,request,nowEpoch));expect(replay).toEqual(activated);
   boundary=lane+'_after_capture';const after=await captureAnalyticsMutationSnapshot(input.context[lane]);
   captures[lane]!.after={...after,snapshot:undefined};proof[lane]=await proveFunctionalRuntimeTransition(before.snapshot,after.snapshot,{request,actorIdentityKey:input.actorIdentityKey,nowEpoch});
  }
  return {evidence:{schemaVersion:'analytics-local-runtime-activation-v1',kind:'runtime_activation',proof,captures,
   builds:input.builds,costs:Object.fromEntries(lanes.map(lane=>[lane,summarizeWholeWorkload(meters[lane].profile)])),
   nativeExactReplay:true,allFamilyParity:'pending',methodChangeQualification:false,postStartImports:0,postStartResets:0,
   localSyntheticAttestation:true,hostedAuthorizationQualification:false}};
 }catch(error){console.log('P11_RUNTIME_ACTIVATION_INCOMPLETE '+JSON.stringify({boundary,captures,proof,
  costs:Object.fromEntries(lanes.map(lane=>[lane,summarizeWholeWorkload(meters[lane].profile)])),complete:false}));throw error;}
}
