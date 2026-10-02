import {expect} from 'vitest';
import {createD1InvocationBudget} from '../../src/d1-invocation-budget';
import {canonicalJson} from '../../src/canonical-json';
import {sha256Hex} from '../../src/crypto';
import {captureAnalyticsMutationSnapshot,type MutationSnapshot,type MutationTable} from './analytics-mutation-capture';
import {createNativeAnalyticsMutation,type NativeAnalyticsMutationKind} from './analytics-native-mutation';
import {pairAnalyticsSources} from './analytics-paired-source';
import {createAnalyticsProfile,profileAnalyticsDatabase,summarizeAnalyticsProfile} from './analytics-profile';
import {createWholeWorkloadMeter,summarizeWholeWorkload} from './analytics-whole-workload';
// @ts-expect-error Reviewed local-only ESM proof.
import {assertAnalyticsMutationProofV2} from '../../scripts/analytics-workload-mutation-proof-v2.mjs';
type Kernel=typeof import('./analytics-mutation-native-reference');
export function observedMutationDays(before:MutationSnapshot,after:MutationSnapshot,kind:NativeAnalyticsMutationKind){
 if(kind==='no_op')return [];
 const format=kind==='old_correction'?'v12':'v11',name=`telemetry_${format}_domain_days`;
 const old=before.source.tables[name]!,next=after.source.tables[name]!,index=(t:MutationTable,c:string)=>t.columns.findIndex(v=>v.name===c);
 const oldKeys=new Set(old.rows.map(r=>JSON.stringify(r.key))),fresh=next.rows.filter(r=>!oldKeys.has(JSON.stringify(r.key)));
 const head=before.source.tables[`telemetry_${format}_domain_heads`]!;
 const priorGeneration=head.rows[0]!.cells[index(head,'generation_id')]![1];
 const identity=format==='v11'?'manifest_id':'manifest_digest';
 const prior=new Map(old.rows.filter(r=>r.cells[index(old,'generation_id')]![1]===priorGeneration).map(r=>[r.cells[index(old,'observed_day')]![1],r.cells[index(old,identity)]![1]]));
 return fresh.filter(r=>prior.get(r.cells[index(next,'observed_day')]![1])!==r.cells[index(next,identity)]![1]).map(r=>r.cells[index(next,'observed_day')]![1] as string).sort();
}
/** Executes one pinned caller against both existing physical stores. The caller
 * retains those stores before and after this function; it never clones/reset them. */
export async function executePairedNativeMutation(input:{reference:{source:D1Database;target:D1Database;kernel:Kernel};
 candidate:{source:D1Database;target:D1Database;kernel:Kernel};sourceId:string;sourceNamespace:string;participantId:string;day:string;kind:NativeAnalyticsMutationKind;afterAdmission?:()=>Promise<unknown>}){
 const lanes=['reference','candidate'] as const;
 for(const lane of lanes){if(!input[lane].kernel.mutationCaptureInstrumented)throw Error('MUTATION_INSTRUMENTATION_REQUIRED');
  input[lane].kernel.drainMutationStepPreimages();input[lane].kernel.drainMutationCaptureMeasurement();}
 const before={reference:await captureAnalyticsMutationSnapshot(input.reference),candidate:await captureAnalyticsMutationSnapshot(input.candidate)};
 const profiles={reference:createAnalyticsProfile(),candidate:createAnalyticsProfile()},meters={reference:createD1InvocationBudget(950),candidate:createD1InvocationBudget(950)};
 const paired=pairAnalyticsSources(meters.reference.wrap(profileAnalyticsDatabase(input.reference.source,'source',profiles.reference,()=> 'native_action')),
  meters.candidate.wrap(profileAnalyticsDatabase(input.candidate.source,'source',profiles.candidate,()=> 'native_action')));
 const partialDelivery:Partial<Record<typeof lanes[number],unknown>>={};
 let boundary='native_action',deliveryEpisode:unknown=null;
 try{
 const startMs=Date.now();await createNativeAnalyticsMutation(input.reference.kernel,input.sourceNamespace)(paired.database,input.kind,input.participantId,input.day,startMs);
 const endMs=Date.now();paired.assertExact();
 if(input.afterAdmission){boundary='delivery_episode';deliveryEpisode=await input.afterAdmission();}
 boundary='ordered_delivery';
 const deliver=async(lane:typeof lanes[number])=>{
  const db=input[lane],measured=createWholeWorkloadMeter(db.source,db.target);let idle=false;
  try{for(let pass=0;pass<80;pass++){
   const result=await measured.invocation('mutation_delivery',physical=>db.kernel.advanceStorageAnalytics({...physical,sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,deadlineMs:Date.now()+55000}));
   if(result.state==='idle'){idle=true;break;}}
  expect(idle,'MUTATION_DELIVERY_BOUND').toBe(true);
  }finally{partialDelivery[lane]=summarizeWholeWorkload(measured.profile);}
  return {profile:summarizeWholeWorkload(measured.profile),steps:db.kernel.drainMutationStepPreimages(),capture:db.kernel.drainMutationCaptureMeasurement()};
 };
 const delivered={reference:await deliver('reference'),candidate:await deliver('candidate')};
 boundary='after_snapshot';
 const after={reference:await captureAnalyticsMutationSnapshot({...input.reference,stepPreimages:delivered.reference.steps}),candidate:await captureAnalyticsMutationSnapshot({...input.candidate,stepPreimages:delivered.candidate.steps})};
 for(const lane of lanes){after[lane].snapshot.affectedDays=observedMutationDays(before[lane].snapshot,after[lane].snapshot,input.kind);
  after[lane].snapshotSha256=await sha256Hex(canonicalJson(after[lane].snapshot));}
 boundary='v2_proof';
 const proof=assertAnalyticsMutationProofV2({before:{reference:before.reference.snapshot,candidate:before.candidate.snapshot},
  after:{reference:after.reference.snapshot,candidate:after.candidate.snapshot},action:{kind:input.kind,nowEpoch:startMs,intervals:{reference:{startMs,endMs},candidate:{startMs,endMs}}}},
  {contract:'native-existing-owner-v2',clockPolicy:'native-v11-trigger-clocks-v1'});
 return {proof,...(input.afterAdmission?{deliveryEpisode}:{}),actionSemantics:input.kind==='old_correction'?'native-v12-additive-old-day-restatement':input.kind==='unrelated_append'?'native-v11-same-parser-empty-day-append':input.kind,paired:paired.proof,storesReplaced:false,physicalStoresRetained:true,
  admission:Object.fromEntries(lanes.map(lane=>[lane,{...summarizeAnalyticsProfile(profiles[lane]),maximumStatementsPerInvocation:meters[lane].queriesUsed}])),
  delivery:Object.fromEntries(lanes.map(lane=>[lane,delivered[lane].profile])),
  preimageCapture:Object.fromEntries(lanes.map(lane=>[lane,delivered[lane].capture])),
  snapshots:Object.fromEntries(lanes.map(lane=>[lane,{before:{sha256:before[lane].snapshotSha256,counts:before[lane].counts,measurement:before[lane].measurement},
   after:{sha256:after[lane].snapshotSha256,counts:after[lane].counts,measurement:after[lane].measurement}}])),
  boundary:'Admission, ordered delivery and full source/target proof capture precede the measured maintained repair and exact all-family phase. Raw rows/preimages remain memory-only.'};
 }catch(error){
  console.log('analytics-functional-mutation-incomplete',JSON.stringify({kind:input.kind,boundary,complete:false,
   paired:paired.proof,admission:Object.fromEntries(lanes.map(lane=>[lane,{...summarizeAnalyticsProfile(profiles[lane]),maximumStatementsPerInvocation:meters[lane].queriesUsed}])),
   completedDelivery:partialDelivery,deliveryEpisode,beforeCapture:Object.fromEntries(lanes.map(lane=>[lane,{sha256:before[lane].snapshotSha256,measurement:before[lane].measurement}])),
   incompleteBoundaryResourceMetadata:null,allFamilyParity:'not_checked',storesReplaced:false}));
  throw error;
 }
}
