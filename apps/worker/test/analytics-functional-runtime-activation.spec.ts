import {expect,it} from 'vitest';
import * as kernel from '../src/telemetry-runtime-activation';
import {sha256Hex} from '../src/crypto';
import {buildFunctionalActivationRequest,proveFunctionalRuntimeTransition,activateFunctionalCorrectionRuntime} from './helpers/analytics-functional-runtime-activation';
import type {MutationSnapshot,MutationTable,MutationCell} from './helpers/analytics-mutation-capture';
const nowEpoch=Date.parse('2026-10-02T01:00:00.000Z'),actorIdentityKey='a'.repeat(64);
const build={sourceCommit:'b'.repeat(40),bundleSha256:'c'.repeat(64),configSha256:'d'.repeat(64),versionId:'11111111-1111-4111-8111-111111111111'};
const input={build,nowEpoch,idempotencyKey:'22222222-2222-4222-8222-222222222222',primary:{schemaSha256:'e'.repeat(64),ledgerSha256:'f'.repeat(64)},analytics:{schemaSha256:'1'.repeat(64),ledgerSha256:'2'.repeat(64)}};
const makeTable=(columns:[string,string][],cells:MutationCell[][]):MutationTable=>({columns:columns.map(([name,type])=>({name,type})),keyColumns:[columns[0]![0]],rows:cells.map(row=>({key:[row[0]!],cells:row}))});
async function fixture(){
 const request=await buildFunctionalActivationRequest(kernel,input);
 const runtime=makeTable([['id','INTEGER'],['schema_version','TEXT'],['method_version','TEXT'],['state','TEXT'],['max_capture_rows','INTEGER'],['max_history_page','INTEGER']],
  [[['integer','1'],['text','telemetry-usage-correction-v1'],['text','usage-total-correction-v1'],['text','staged'],['integer','200'],['integer','200']]]);
 const audit=makeTable([['id','INTEGER'],['operation_id','TEXT'],['action','TEXT'],['actor_identity_digest','TEXT'],['outcome','TEXT'],['details_json','TEXT'],['created_at','TEXT']],[]);
 const before:MutationSnapshot={schemaVersion:'analytics-mutation-logical-snapshot-v1',source:{schemaSha256:'3'.repeat(64),tables:{telemetry_usage_correction_runtime:runtime,admin_action_audit:audit,
  accepted_source:makeTable([['id','INTEGER'],['tokens','INTEGER']],[[['integer','1'],['integer','42']]])}},target:{schemaSha256:'4'.repeat(64),tables:{lineage:makeTable([['id','INTEGER']],[[['integer','1']]])},stepPreimages:[]},affectedDays:['2026-10-01']};
 const after=structuredClone(before);after.source.tables.telemetry_usage_correction_runtime!.rows[0]!.cells[3]=['text','active'];
 const details={schemaVersion:'telemetry-runtime-activation-v1',task:'telemetry_runtime_activation',idempotencyKey:request.idempotencyKey,target:request.target,expectedRevision:0,reconciliation:request.reconciliation,fromRevision:0,toRevision:1,state:'active'};
 after.source.tables.admin_action_audit!.rows.push({key:[['integer','1']],cells:[['integer','1'],['text',request.idempotencyKey],['text','run_maintenance'],['text',await sha256Hex('app-usagemonitor/admin-actor/v1\0'+actorIdentityKey)],['text','success'],['text',JSON.stringify(details)],['text',new Date(nowEpoch).toISOString()]]});
 return {before,after,proof:{request,actorIdentityKey,nowEpoch}};
}
it('uses native canonical attestation, reconciliation hashes and exact parser without a global clock override',async()=>{
 const request=await buildFunctionalActivationRequest(kernel,input);
 expect(request.target).toBe('usage_correction');expect(request.expectedRevision).toBe(0);
 const {proofSha256,...unsigned}=request.reconciliation;
 expect(proofSha256).toBe(await sha256Hex(kernel.canonicalTelemetryRuntimeReconciliationJson(unsigned)));
 const {attestationSha256,...deployment}=unsigned.deploymentAttestation;
 expect(attestationSha256).toBe(await sha256Hex(kernel.canonicalTelemetryRuntimeDeploymentAttestationJson(deployment)));
 await expect(buildFunctionalActivationRequest(kernel,{...input,build:{...build,sourceCommit:'unverified'}})).rejects.toThrow('LOCAL_ATTESTATION');
 await expect(buildFunctionalActivationRequest(kernel,{...input,nowEpoch:NaN})).rejects.toThrow('LOCAL_ATTESTATION');
});
it('proves only a staged-to-active singleton plus exact native audit append and retains raw hashes',async()=>{
 const f=await fixture(),proof=await proveFunctionalRuntimeTransition(f.before,f.after,f.proof);
 expect(proof).toMatchObject({fromState:'staged',toState:'active',preservedSourceTables:1,priorSourceRowsExact:true,preservedTargetLineage:true});
 expect(proof.beforeSnapshotSha256).not.toBe(proof.afterSnapshotSha256);
 expect(JSON.stringify(proof)).not.toContain('accepted_source');expect(JSON.stringify(proof)).not.toContain(input.idempotencyKey);
});
it.each(['accepted','schema','catalog','target','runtime','audit','time','method'] as const)('rejects %s drift instead of normalizing it',async kind=>{
 const f=await fixture();
 if(kind==='accepted')f.after.source.tables.accepted_source!.rows[0]!.cells[1]=['integer','43'];
 if(kind==='schema')f.after.source.schemaSha256='0'.repeat(64);
 if(kind==='catalog')delete f.after.source.tables.accepted_source;
 if(kind==='target')f.after.target.tables.lineage!.rows=[];
 if(kind==='runtime')f.before.source.tables.telemetry_usage_correction_runtime!.rows[0]!.cells[3]=['text','active'];
 if(kind==='audit')f.after.source.tables.admin_action_audit!.rows[0]!.cells[4]=['text','failure'];
 if(kind==='time')f.after.source.tables.admin_action_audit!.rows[0]!.cells[6]=['text',new Date(nowEpoch+1).toISOString()];
 if(kind==='method')f.after.source.tables.telemetry_usage_correction_runtime!.rows[0]!.cells[2]=['text','invented-method'];
 await expect(proveFunctionalRuntimeTransition(f.before,f.after,f.proof)).rejects.toThrow('FUNCTIONAL_RUNTIME_');
});
it('refuses aliased stores and nonlocal sources before any native call',async()=>{
 const db={} as D1Database,one={source:db,target:db,ledger:db};
 const value={context:{reference:one,candidate:one,analyticalNowMs:nowEpoch,now:Date.now},kernels:{reference:kernel,candidate:kernel},builds:{reference:build,candidate:build},sourceId:'synthetic-p11-runtime',sourceNamespace:'synthetic-p11-runtime',actorIdentityKey};
 await expect(activateFunctionalCorrectionRuntime(value)).rejects.toThrow('LABORATORY_SCOPE');
});
