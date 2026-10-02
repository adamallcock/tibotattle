import {canonicalJson} from '../../src/canonical-json';
import {createNativePreviewCounter} from './analytics-preview-counter';
import {createWholeWorkloadMeter,summarizeWholeWorkload} from './analytics-whole-workload';
import type {FunctionalLane,FunctionalScenarioContext} from './analytics-functional-branches';
export interface FunctionalActionPreviewCheckpoint {readonly receipt:Readonly<Record<string,unknown>>;}
const proved=new WeakMap<FunctionalActionPreviewCheckpoint,Record<string,unknown>|null>();
export function assertFunctionalActionPreviewStartup(checkpoint:FunctionalActionPreviewCheckpoint,row:Record<string,unknown>|null){
 if(!proved.has(checkpoint)||canonicalJson(proved.get(checkpoint))!==canonicalJson(row))throw Error('FUNCTIONAL_ACTION_PREVIEW_UNPROVED_STARTUP');
}
/** Lifecycle helper writes and every native counter probe use its SAME950
 * invocation. Only start/finish controls use separately reported950 invocations. */
export async function startFunctionalActionPreviewTrace(input:{context:FunctionalScenarioContext;sourceId:string;
 expected:Record<FunctionalLane,Record<string,unknown>>}){
 const lanes=['reference','candidate'] as const;
 const counters={reference:createNativePreviewCounter(input.sourceId),candidate:createNativePreviewCounter(input.sourceId)};
 const controls=Object.fromEntries(lanes.map(lane=>[lane,createWholeWorkloadMeter(input.context[lane].source,input.context[lane].target,
  undefined,undefined,input.context[lane].ledger,undefined,counters[lane])])) as Record<FunctionalLane,ReturnType<typeof createWholeWorkloadMeter>>;
 let closed=false;
 try{for(const lane of lanes)await controls[lane].invocation('native_preview_action_start',()=>counters[lane].start(input.expected[lane]));}
 catch(error){console.log('analytics-functional-action-incomplete',JSON.stringify({boundary:'native_preview_action_start',complete:false,lanes:Object.fromEntries(lanes.map(lane=>[lane,counters[lane].diagnostic()])),controls:Object.fromEntries(lanes.map(lane=>[lane,summarizeWholeWorkload(controls[lane].profile)]))}));for(const counter of Object.values(counters))counter.close();throw error;}
 return {targetObservers:counters,async finish(){
  if(closed)throw Error('FUNCTIONAL_ACTION_PREVIEW_CLOSED');
  const checkpoints={} as Record<FunctionalLane,FunctionalActionPreviewCheckpoint>;
  try{for(const lane of lanes){
   checkpoints[lane]=await controls[lane].invocation('native_preview_action_finish',async db=>{
    const row=await db.target.prepare('SELECT * FROM analytics_community_graph_previews WHERE source_id=?').bind(input.sourceId).first<Record<string,unknown>>();
    const proof=await counters[lane].finish(row),checkpoint={receipt:proof.receipt};proved.set(checkpoint,structuredClone(row));return checkpoint;
   });
  }
  const receipt={contract:'native-preview-traced-action-v1',reference:checkpoints.reference.receipt,candidate:checkpoints.candidate.receipt,
   controls:Object.fromEntries(lanes.map(lane=>[lane,summarizeWholeWorkload(controls[lane].profile)])),
   probeCostContract:'Start/final controls are listed separately. Mutation readbacks are charged in the lifecycle action invocation and its profile. SQL/binds/results unchanged.'};
  return {checkpoints,receipt};
  }finally{closed=true;for(const counter of Object.values(counters))counter.close();}
 },close(){closed=true;for(const counter of Object.values(counters))counter.close();},
 diagnostic(){return {complete:false,lanes:Object.fromEntries(lanes.map(lane=>[lane,counters[lane].diagnostic()])),
  controls:Object.fromEntries(lanes.map(lane=>[lane,summarizeWholeWorkload(controls[lane].profile)]))};}};
}
