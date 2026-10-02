import {applyD1Migrations,env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import * as native from './helpers/analytics-mutation-native-reference';
import * as current from './helpers/analytics-mutation-current';
import {captureAnalyticsMutationSnapshot,type MutationSnapshot,type MutationTable} from './helpers/analytics-mutation-capture';
import {createNativeAnalyticsMutation,type NativeAnalyticsMutationKind} from './helpers/analytics-native-mutation';
import {pairAnalyticsSources} from './helpers/analytics-paired-source';
import {copyAcceptedAnalyticsSource} from './helpers/analytics-source-snapshot';
import {createWholeWorkloadMeter,summarizeWholeWorkload} from './helpers/analytics-whole-workload';
import {createAnalyticsProfile,profileAnalyticsDatabase,summarizeAnalyticsProfile} from './helpers/analytics-profile';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {sha256Hex} from '../src/crypto';
import {canonicalJson} from '../src/canonical-json';
import type {SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
// @ts-expect-error Local benchmark-only ESM validator.
import {assertAnalyticsMutationProofV2} from '../scripts/analytics-workload-mutation-proof-v2.mjs';
const assertAnalyticsMutationProof=(input:unknown)=>assertAnalyticsMutationProofV2(input,{contract:'native-existing-owner-v2',clockPolicy:'native-v11-trigger-clocks-v1'});
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database;STORAGE_INGESTION_A:D1Database;STORAGE_INGESTION_B:D1Database;STORAGE_ROUTING_DB:D1Database;DELETION_LEDGER:D1Database};
const sourceId='synthetic-mutation-capture',sourceNamespace=sourceId;
const reference={source:b.USAGE_MONITOR_DB,target:b.STORAGE_ANALYTICS_DB,kernel:native};
const seed={source:b.STORAGE_ROUTING_DB,target:b.DELETION_LEDGER,kernel:native};
const candidate={source:b.STORAGE_INGESTION_A,target:b.STORAGE_INGESTION_B,kernel:current};
const golden=it.skipIf(!native.mutationCaptureInstrumented||!current.mutationCaptureInstrumented);
type Lane=typeof reference;
type Kind=NativeAnalyticsMutationKind;
const mutate=createNativeAnalyticsMutation(native,sourceNamespace);
const hashReport=(name:string,value:unknown)=>console.log(name,JSON.stringify(value));
async function deliver(lane:Lane){
 const measured=createWholeWorkloadMeter(lane.source,lane.target);let idle=false;
 for(let pass=0;pass<80;pass++){
  const result=await measured.invocation('delivery',db=>lane.kernel.advanceStorageAnalytics({...db,sourceId,sourceNamespace,deadlineMs:Date.now()+55000}));
  if(result.state==='idle'){idle=true;break;}
 }
 expect(idle,'MUTATION_DELIVERY_BOUND').toBe(true);
 return {profile:summarizeWholeWorkload(measured.profile),capture:lane.kernel.drainMutationCaptureMeasurement(),steps:lane.kernel.drainMutationStepPreimages()};
}
async function setup(){
 await reset();
 const migrations=Object.fromEntries(Object.entries(native.nativeMigrationNames).map(([name,names])=>[name,b[name as keyof SharedAnalyticsCorpusMigrations].filter(m=>names.includes(m.name))])) as unknown as SharedAnalyticsCorpusMigrations;
 await native.initializeSharedAnalyticsCorpusDatabases(seed.source,seed.target,migrations,sourceId);
 const corpus=await native.seedSharedAnalyticsCorpus({...seed,sourceId,sourceNamespace,calendarDays:10,graphDays:2,
  anchorDay:new Date(Date.now()-86400000).toISOString().slice(0,10),targetAuthority:'ordered-delivery'});
 const initial=await deliver(seed);
 const sourceClone={reference:await copyAcceptedAnalyticsSource(seed.source,reference.source),candidate:await copyAcceptedAnalyticsSource(seed.source,candidate.source)};
 const targetClone={reference:await copyAcceptedAnalyticsSource(seed.target,reference.target),candidate:await copyAcceptedAnalyticsSource(seed.target,candidate.target)};
 const upgrade=createAnalyticsProfile();
 for(const [db,key] of [[candidate.source,'TEST_INGESTION_ISOLATION_MIGRATIONS'],[candidate.target,'TEST_ANALYTICS_MIGRATIONS']] as const)
  await applyD1Migrations(profileAnalyticsDatabase(db,key==='TEST_ANALYTICS_MIGRATIONS'?'target':'source',upgrade,()=> 'candidate_upgrade'),
   b[key].filter(m=>!native.nativeMigrationNames[key]!.includes(m.name)));
 candidate.kernel.drainMutationCaptureMeasurement();candidate.kernel.drainMutationStepPreimages();
 hashReport('mutation-component-setup',{initial:initial.profile,sourceClone,targetClone,upgrade:summarizeAnalyticsProfile(upgrade),wholeIncrementalQualification:false});
 return corpus;
}
function changeCell(snapshot:MutationSnapshot,side:'source'|'target',name:string,column:string,value:string){
 const table=snapshot[side].tables[name]!;const index=table.columns.findIndex(c=>c.name===column);
 if(index<0||!table.rows.length)throw Error('MUTATION_NEGATIVE_FIXTURE');table.rows[0]!.cells[index]=[table.rows[0]!.cells[index]![0],value];
}
function observedDays(before:MutationSnapshot,after:MutationSnapshot,kind:Kind){
 if(kind==='no_op')return [];
 const name=kind!=='old_correction'?'telemetry_v11_domain_days':'telemetry_v12_domain_days';
 const old=before.source.tables[name]!,next=after.source.tables[name]!,index=(t:MutationTable,c:string)=>t.columns.findIndex(v=>v.name===c);
 const oldKeys=new Set(old.rows.map(r=>JSON.stringify(r.key))),fresh=next.rows.filter(r=>!oldKeys.has(JSON.stringify(r.key)));
 const head=before.source.tables[kind!=='old_correction'?'telemetry_v11_domain_heads':'telemetry_v12_domain_heads']!;
 const priorGeneration=head.rows[0]!.cells[index(head,'generation_id')]![1];
 const prior=new Map(old.rows.filter(r=>r.cells[index(old,'generation_id')]![1]===priorGeneration).map(r=>[r.cells[index(old,'observed_day')]![1],r.cells[index(old,kind!=='old_correction'?'manifest_id':'manifest_digest')]![1]]));
 return fresh.filter(r=>prior.get(r.cells[index(next,'observed_day')]![1])!==r.cells[index(next,kind!=='old_correction'?'manifest_id':'manifest_digest')]![1])
  .map(r=>r.cells[index(next,'observed_day')]![1] as string).sort();
}
for(const kind of ['no_op','old_correction','unrelated_append','metadata_change'] as const)golden('captures authentic pinned '+kind+' SQL and independently delivered provenance',async()=>{
 const corpus=await setup();
 const before={reference:await captureAnalyticsMutationSnapshot(reference),candidate:await captureAnalyticsMutationSnapshot(candidate)};
 const profiles={reference:createAnalyticsProfile(),candidate:createAnalyticsProfile()},meters={reference:createD1InvocationBudget(950),candidate:createD1InvocationBudget(950)};
 const paired=pairAnalyticsSources(meters.reference.wrap(profileAnalyticsDatabase(reference.source,'source',profiles.reference,()=> 'native_action')),
  meters.candidate.wrap(profileAnalyticsDatabase(candidate.source,'source',profiles.candidate,()=> 'native_action')));
 const startMs=Date.now(),nowEpoch=startMs,day=kind==='old_correction'?corpus.correctionDay:corpus.v11DomainThroughDay;
 try{await mutate(paired.database,kind,corpus.participantId,day,nowEpoch);}catch(error){
  hashReport('mutation-action-refused',{kind,paired:paired.proof,admission:{reference:summarizeAnalyticsProfile(profiles.reference),candidate:summarizeAnalyticsProfile(profiles.candidate)},statements:{reference:meters.reference.queriesUsed,candidate:meters.candidate.queriesUsed},complete:false});
  if(kind==='old_correction'){
   const names=['telemetry_v12_runtime','telemetry_v12_device_capabilities','telemetry_v12_day_manifests','telemetry_v12_chunks','telemetry_v12_records','telemetry_v12_domain_predecessors','telemetry_v12_domains','telemetry_v12_domain_days','telemetry_v12_domain_heads'];
   const sql="SELECT name FROM sqlite_master WHERE (type='table' AND name IN ("+names.map(()=>'?').join(',')+")) OR (type='view' AND name=?)";
   const a=(await reference.source.prepare(sql).bind(...names,'telemetry_v12_active_authorizations').all<{name:string}>()).results;
   const c=(await candidate.source.prepare(sql).bind(...names,'telemetry_v12_active_authorizations').all<{name:string}>()).results;
   hashReport('mutation-readonly-capability-diagnostic',{outsideMeasuredAction:true,statements:2,referenceCount:a.length,candidateCount:c.length,
    orderedEqual:JSON.stringify(a)===JSON.stringify(c),setEqual:JSON.stringify(a.map(r=>r.name).sort())===JSON.stringify(c.map(r=>r.name).sort()),
    referenceHash:await sha256Hex(JSON.stringify(a)),candidateHash:await sha256Hex(JSON.stringify(c))});
  }throw error;
 }const endMs=Date.now();paired.assertExact();
 const delivered={reference:await deliver(reference),candidate:await deliver(candidate)};
 const after={reference:await captureAnalyticsMutationSnapshot({...reference,stepPreimages:delivered.reference.steps}),
  candidate:await captureAnalyticsMutationSnapshot({...candidate,stepPreimages:delivered.candidate.steps})};
 for(const lane of ['reference','candidate'] as const){
  after[lane].snapshot.affectedDays=observedDays(before[lane].snapshot,after[lane].snapshot,kind);
  after[lane].snapshotSha256=await sha256Hex(canonicalJson(after[lane].snapshot));
 }
 for(const lane of ['reference','candidate'] as const){
  expect(after[lane].snapshot.source.tables.community_allowance_publication_state).toEqual(before[lane].snapshot.source.tables.community_allowance_publication_state);
 }
 expect(after.reference.snapshot.source.tables.community_allowance_publication_state).toEqual(after.candidate.snapshot.source.tables.community_allowance_publication_state);
 const singletonHashes=Object.fromEntries(await Promise.all((['reference','candidate'] as const).map(async lane=>[lane,Object.fromEntries(await Promise.all(
  ['community_snapshot_mutation_control','community_allowance_publication_state'].map(async table=>[table,{
   beforeRows:before[lane].snapshot.source.tables[table]!.rows.length,afterRows:after[lane].snapshot.source.tables[table]!.rows.length,
   beforeSha256:await sha256Hex(canonicalJson(before[lane].snapshot.source.tables[table])),
   afterSha256:await sha256Hex(canonicalJson(after[lane].snapshot.source.tables[table]))}])))])));
 hashReport('mutation-singleton-evidence',{kind,publicationStateExactUnchanged:true,raw:singletonHashes});
 const recordStores=['telemetry_v11_records','telemetry_v11_chunks','typed_telemetry_records','typed_v11_record_proofs','typed_v11_chunk_allocations','typed_v11_manifest_memberships','typed_telemetry_chunks','typed_telemetry_manifests','typed_telemetry_usage'] as const;
 hashReport('mutation-native-record-inventory',{kind,lanes:Object.fromEntries((['reference','candidate'] as const).map(lane=>[lane,
  Object.fromEntries(recordStores.map(name=>{const a=before[lane].snapshot.source.tables[name]!,z=after[lane].snapshot.source.tables[name]!;
   const oldKeys=new Set(a.rows.map(row=>JSON.stringify(row.key)));
   return [name,{beforeRows:a.rows.length,afterRows:z.rows.length,newRows:z.rows.filter(row=>!oldKeys.has(JSON.stringify(row.key))).length}];}))]))});
 const input={before:{reference:before.reference.snapshot,candidate:before.candidate.snapshot},after:{reference:after.reference.snapshot,candidate:after.candidate.snapshot},
  action:{kind,nowEpoch,intervals:{reference:{startMs,endMs},candidate:{startMs,endMs}}}};
 if(kind==='unrelated_append'){
  const read=(table:MutationTable,row:MutationTable['rows'][number],column:string)=>row.cells[table.columns.findIndex(c=>c.name===column)]![1];
  const selected=(snapshot:MutationSnapshot)=>{
   const store=snapshot.source.tables,heads=store.telemetry_v11_domain_heads!,days=store.telemetry_v11_domain_days!;
   const head=heads.rows.find(row=>read(heads,row,'participant_id')===corpus.participantId)!;
   const manifest=days.rows.find(row=>read(days,row,'generation_id')===read(heads,head,'generation_id')&&read(days,row,'observed_day')===day)!;
   const id=read(days,manifest,'manifest_id'),members=store.typed_v11_manifest_memberships!,physical=store.typed_telemetry_records!,proofs=store.typed_v11_record_proofs!,chunks=store.telemetry_v11_chunks!,allocations=store.typed_v11_chunk_allocations!;
   const keys=new Set(members.rows.filter(row=>read(members,row,'manifest_id')===id).map(row=>read(members,row,'typed_manifest_id')));
   const records=physical.rows.filter(row=>keys.has(read(physical,row,'manifest_id'))),recordIds=new Set(records.map(row=>read(physical,row,'id')));
   const selectedProofs=proofs.rows.filter(row=>keys.has(read(proofs,row,'manifest_key')));
   const legacyChunks=chunks.rows.filter(row=>read(chunks,row,'manifest_id')===id),chunkIds=new Set(legacyChunks.map(row=>read(chunks,row,'id')));
   const assigned=allocations.rows.filter(row=>chunkIds.has(read(allocations,row,'chunk_id')));
   const rangeRows=physical.rows.filter(row=>read(physical,row,'format')==='11'&&assigned.some(a=>read(allocations,a,'namespace_id')===read(physical,row,'namespace_id')&&Number(read(physical,row,'source_row_id'))>=Number(read(allocations,a,'first_source_row_id'))&&Number(read(physical,row,'source_row_id'))<Number(read(allocations,a,'first_source_row_id'))+Number(read(allocations,a,'record_count'))));
   return {membershipRows:keys.size,physicalRows:records.length,usageRows:records.filter(row=>read(physical,row,'stream')==='1').length,
    proofRows:selectedProofs.length,proofRecordMatches:selectedProofs.filter(row=>recordIds.has(read(proofs,row,'typed_record_id'))).length,
    nativeChunks:legacyChunks.length,nativeChunkRecordCount:legacyChunks.reduce((sum,row)=>sum+Number(read(chunks,row,'record_count')),0),allocationRows:assigned.length,allocatedSourceRangeRows:rangeRows.length};
  };
  hashReport('mutation-typed-admission-schema-diagnostic',{kind,outsideAnalyticalMeasurement:true,extraSqlStatements:0,
   schema:Object.fromEntries(recordStores.map(name=>[name,{columns:after.reference.snapshot.source.tables[name]!.columns,keyColumns:after.reference.snapshot.source.tables[name]!.keyColumns}])),
   selected:Object.fromEntries((['reference','candidate'] as const).map(lane=>[lane,{before:selected(before[lane].snapshot),after:selected(after[lane].snapshot)}]))});
 }
 hashReport('mutation-component-costs',{kind,qualification:'pending-strict-proof',paired:paired.proof,
  admission:Object.fromEntries((['reference','candidate'] as const).map(l=>[l,{...summarizeAnalyticsProfile(profiles[l]),maximumStatementsPerInvocation:meters[l].queriesUsed}])),
  delivery:{reference:delivered.reference.profile,candidate:delivered.candidate.profile,instrumentedComponentOnly:true},
  preimageCapture:{reference:delivered.reference.capture,candidate:delivered.candidate.capture},
  capture:Object.fromEntries((['reference','candidate'] as const).map(l=>[l,{before:{hash:before[l].snapshotSha256,counts:before[l].counts,cost:before[l].measurement},
   after:{hash:after[l].snapshotSha256,counts:after[l].counts,cost:after[l].measurement}}])),wholeIncrementalQualification:false});
 let proof:ReturnType<typeof assertAnalyticsMutationProof>;
 try{proof=assertAnalyticsMutationProof(input);}catch(error){
  const differences=[];
  for(const [name,a] of Object.entries(input.after.reference.source.tables)){
   const c=input.after.candidate.source.tables[name]!;if(JSON.stringify(a)===JSON.stringify(c))continue;
   const byKey=new Map(c.rows.map(r=>[JSON.stringify(r.key),r])),columns=new Set<string>();let unmatched=0;
   for(const row of a.rows){const other=byKey.get(JSON.stringify(row.key));if(!other){unmatched++;continue;}
    for(let i=0;i<a.columns.length;i++)if(JSON.stringify(row.cells[i])!==JSON.stringify(other.cells[i]))columns.add(a.columns[i]!.name);}
   differences.push({table:name,columns:[...columns].sort(),referenceRows:a.rows.length,candidateRows:c.rows.length,unmatchedKeys:unmatched,
    referenceHash:await sha256Hex(canonicalJson(a)),candidateHash:await sha256Hex(canonicalJson(c))});
  }
  hashReport('mutation-common-source-diagnostic',{kind,paired:paired.proof,differences,preimageCounts:{reference:delivered.reference.steps.length,candidate:delivered.candidate.steps.length}});throw error;
 }
 expect(paired.proof.divergences).toBe(0);expect(proof.verified.newEvents).toBe(kind==='no_op'?0:1);
 if(kind==='unrelated_append'||kind==='metadata_change'){expect(delivered.reference.steps.length).toBeGreaterThan(0);expect(delivered.candidate.steps.length).toBe(delivered.reference.steps.length);}
 if(kind==='old_correction'){expect(after.reference.snapshot.affectedDays).toEqual([corpus.correctionDay]);expect(delivered.reference.steps.length).toBe(0);}
 const damaged=structuredClone(input);changeCell(damaged.after.candidate,'target','analytics_source_cursors','sequence','999999');
 expect(()=>assertAnalyticsMutationProof(damaged)).toThrow();
 const prior=structuredClone(input);changeCell(prior.after.candidate,'source','storage_ingestion_changes','content_digest','b'.repeat(64));
 expect(()=>assertAnalyticsMutationProof(prior)).toThrow();
 const authority=structuredClone(input);changeCell(authority.after.candidate,'source','storage_source_state','authority_epoch','999999');
 expect(()=>assertAnalyticsMutationProof(authority)).toThrow();
 if(kind!=='no_op'){
  const affected=structuredClone(input);affected.after.candidate.affectedDays=[];
  expect(()=>assertAnalyticsMutationProof(affected)).toThrow();
  const clipped=structuredClone(input);clipped.action.intervals.candidate={startMs:0,endMs:1};
  expect(()=>assertAnalyticsMutationProof(clipped)).toThrow();
 }
 if(kind==='unrelated_append'||kind==='metadata_change'){
  const step=structuredClone(input);step.after.candidate.target.stepPreimages[0]!.preimage.recordCount=999999;
  expect(()=>assertAnalyticsMutationProof(step)).toThrow();
 }
 hashReport('mutation-component-proof',{kind,proof,complete:true,wholeIncrementalQualification:false});
},120000);
