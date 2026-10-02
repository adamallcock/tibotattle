import {expect} from 'vitest';
import {canonicalJson} from '../../src/canonical-json';
import {sha256Hex} from '../../src/crypto';
import {createWholeWorkloadMeter,summarizeWholeWorkload} from './analytics-whole-workload';
import type {FunctionalLane,FunctionalScenarioContext} from './analytics-functional-branches';

type Kernel=Pick<typeof import('./analytics-workload-kernels'),'readIngestionChanges'|'readStorageCommunityOwnerPage'
 |'readPublishedStorageCommunityGraph'|'captureStorageGraphScope'|'readStorageGraphWorkSelection'|'ensureStorageGraphWorkSelection'
 |'claimStorageGraphWorkSelection'|'loadLiveStorageGraphWorkSelection'|'completeStorageGraphWorkSelection'|'releaseStorageGraphWorkSelection'>;
export interface FunctionalBoundaryInput {context:FunctionalScenarioContext;kernels:Record<FunctionalLane,Kernel>;
 sourceId:string;sourceNamespace:string;participantId:string;}
const lanes=['reference','candidate'] as const;
function laboratory(input:FunctionalBoundaryInput){
 if(!/^synthetic-p11-[A-Za-z0-9:_-]{1,110}$/u.test(input.sourceId)||input.sourceId!==input.sourceNamespace
  ||input.context.now!==Date.now||!/^participant:[0-9a-f-]{36}$/u.test(input.participantId)
  ||new Set(lanes.flatMap(lane=>Object.values(input.context[lane]))).size!==6)throw Error('FUNCTIONAL_BOUNDARY_SCOPE');
 const meters=Object.fromEntries(lanes.map(lane=>[lane,createWholeWorkloadMeter(input.context[lane].source,input.context[lane].target,
  undefined,undefined,input.context[lane].ledger)])) as Record<FunctionalLane,ReturnType<typeof createWholeWorkloadMeter>>;
 return {meters,receipt:(kind:'authority_lag'|'stale_lease',proof:Record<FunctionalLane,unknown>)=>({
  schemaVersion:'analytics-native-functional-boundary-v1',kind,proof,
  costs:Object.fromEntries(lanes.map(lane=>[lane,summarizeWholeWorkload(meters[lane].profile)])),
  allFamilyParity:'pending',postStartImports:0,postStartResets:0,clockOverrides:0,
  contract:'Native authority/lease transition on retained physical stores; every statement is inside the original950 meter. Complete public outputs are proved by the caller.'})};
}
/** Called only between an authentic hard-invalidation writer and ordered
 * delivery. No target ACK/state is manufactured to produce the lag. */
export async function proveFunctionalAuthorityLag(input:FunctionalBoundaryInput){
 const io=laboratory(input),proof={} as Record<FunctionalLane,unknown>;
 for(const lane of lanes){const kernel=input.kernels[lane],meter=io.meters[lane];meter.setPhase('final_visibility');
  proof[lane]=await meter.invocation('native_authority_lag',async db=>{
   const cursor=await db.target.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(input.sourceId).first<number>('sequence');
   if(!Number.isSafeInteger(cursor)||cursor!<1)throw Error('FUNCTIONAL_LAG_DELIVERED_BASE');
   const changes=await kernel.readIngestionChanges(db.source,input.sourceId,cursor!,2);
   if(changes.length!==1||changes[0]!.sequence!==cursor!+1||changes[0]!.kind!=='owner-active')throw Error('FUNCTIONAL_LAG_NATIVE_HARD_EVENT');
   const change=changes[0]!,owners=await kernel.readStorageCommunityOwnerPage(db.source);
   const owner=owners.find(value=>value.participantId===input.participantId);
   if(!owner?.ownerDigest||owner.ownerDigest!==change.ownerDigest)throw Error('FUNCTIONAL_LAG_OWNER');
   const target=await db.target.prepare('SELECT revision,authority_epoch,state FROM analytics_owner_state WHERE source_id=? AND owner_digest=?')
    .bind(input.sourceId,owner.ownerDigest).first<{revision:number;authority_epoch:number;state:string}>();
   if(!target||target.state!=='active'||owner.ownerRevision<=target.revision||owner.authorityEpoch<=target.authority_epoch)throw Error('FUNCTIONAL_LAG_AUTHORITY_NOT_AHEAD');
   const applied=await db.target.prepare('SELECT count(*) n FROM analytics_applied_events WHERE source_id=? AND event_digest=?')
    .bind(input.sourceId,change.eventDigest).first<number>('n');expect(applied).toBe(0);
   const raw=await db.target.prepare('SELECT * FROM analytics_community_graph_previews WHERE source_id=?').bind(input.sourceId).first();
   if(!raw)throw Error('FUNCTIONAL_LAG_PRIOR_PUBLICATION_REQUIRED');
   expect(await kernel.readPublishedStorageCommunityGraph({...db,sourceId:input.sourceId,sourceNamespace:input.sourceNamespace},input.context.analyticalNowMs)).toBeNull();
   expect(await db.target.prepare('SELECT * FROM analytics_community_graph_previews WHERE source_id=?').bind(input.sourceId).first()).toEqual(raw);
   expect(await db.target.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(input.sourceId).first()).toEqual({sequence:cursor});
   return {pendingNativeEvents:1,sourceSequence:change.sequence,targetSequence:cursor,sourceRevision:owner.ownerRevision,targetRevision:target.revision,
    sourceAuthorityEpoch:owner.authorityEpoch,targetAuthorityEpoch:target.authority_epoch,eventSha256:await sha256Hex(change.eventDigest),
    priorPreviewSha256:await sha256Hex(canonicalJson(raw)),previewRefused:true,priorPublicationRetainedExactly:true,appliedReceipts:0};
  });
  expect(summarizeWholeWorkload(meter.profile).rowsWritten).toBe(0);
 }
 return {evidence:io.receipt('authority_lag',proof)};
}

/** A genuine short native claim expires on the real clock. Native reaping
 * advances the durable revision, so the prior writer loses its exact CAS. */
export async function expireFunctionalGraphLease(input:FunctionalBoundaryInput&{day:string}){
 const io=laboratory(input),proof={} as Record<FunctionalLane,unknown>;
 if(!/^\d{4}-\d{2}-\d{2}$/u.test(input.day)||new Date(Date.parse(input.day+'T00:00:00Z')).toISOString().slice(0,10)!==input.day)
  throw Error('FUNCTIONAL_LEASE_DAY');
 for(const lane of lanes){const kernel=input.kernels[lane],meter=io.meters[lane];meter.setPhase('graph_admission');
  const claimed=await meter.invocation('native_short_graph_claim',async db=>{
   const owner=(await kernel.readStorageCommunityOwnerPage(db.source)).find(value=>value.participantId===input.participantId);
   if(!owner?.ownerDigest)throw Error('FUNCTIONAL_LEASE_OWNER');
   const scope=await kernel.captureStorageGraphScope(db.source,{owner,day:input.day,metric:'model',sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,preparedFold:true});
   if(scope.source!=='effective')throw Error('FUNCTIONAL_LEASE_EFFECTIVE_SCOPE');
   const key={sourceId:input.sourceId,ownerDigest:owner.ownerDigest,day:input.day,metric:'model' as const};
   expect(await kernel.readStorageGraphWorkSelection(db.target,key)).toBeNull();
   const ensured=await kernel.ensureStorageGraphWorkSelection({...db,envelope:{version:2,source:'effective',...key,
    sourceNamespace:input.sourceNamespace,fixedNow:scope.fixedNow,dependencyDigest:scope.dependencyDigest,
    checkpointDependencyDigest:scope.checkpointDependencyDigest,targetAuthorityEpoch:scope.owner.authorityEpoch,
    participantId:scope.owner.participantId,ownerRevision:scope.owner.ownerRevision}});
   if(ensured.status!=='created'||!ensured.selection)throw Error('FUNCTIONAL_LEASE_ENSURE');
   const claimToken=crypto.randomUUID(),value=await kernel.claimStorageGraphWorkSelection({...db,selection:ensured.selection,claimToken,leaseMs:1});
   if(value.status!=='claimed'||!value.selection||value.selection.claimExpiresMs===null)throw Error('FUNCTIONAL_LEASE_CLAIM');
   return {selection:value.selection,claimToken};
  });
  const waitStart=Date.now();
  while(Date.now()<claimed.selection.claimExpiresMs!){
   if(Date.now()-waitStart>1000)throw Error('FUNCTIONAL_LEASE_REAL_WAIT_BOUND');
   await new Promise(resolve=>setTimeout(resolve,1));
  }
  proof[lane]=await meter.invocation('native_stale_graph_claim_refusal',async db=>{
   const live=await kernel.loadLiveStorageGraphWorkSelection({...db,key:claimed.selection.key});
   if(!live||live.state!=='pending'||live.revision!==claimed.selection.revision+1||live.envelopeSha256!==claimed.selection.envelopeSha256)
    throw Error('FUNCTIONAL_LEASE_NATIVE_REAPER');
   const refused=await kernel.completeStorageGraphWorkSelection({target:db.target,selection:claimed.selection,claimToken:claimed.claimToken});
   expect(refused.status).toBe('conflict');expect(refused.selection).toEqual(live);
   const token=crypto.randomUUID(),next=await kernel.claimStorageGraphWorkSelection({...db,selection:live,claimToken:token});
   if(next.status!=='claimed'||!next.selection||next.selection.revision!==live.revision+1)throw Error('FUNCTIONAL_LEASE_RECLAIM');
   const released=await kernel.releaseStorageGraphWorkSelection({target:db.target,selection:next.selection,claimToken:token});
   if(released.status!=='released'||!released.selection||released.selection.state!=='pending')throw Error('FUNCTIONAL_LEASE_RELEASE');
   return {nativeLeaseExpired:true,priorClaimRevision:claimed.selection.revision,reapedRevision:live.revision,
    oldCompletion:'conflict',reclaimedRevision:next.selection.revision,releasedRevision:released.selection.revision,
    retainedDependencySha256:claimed.selection.envelope.dependencyDigest,realWaitMs:Date.now()-waitStart,pendingNativeRecovery:true};
  });
 }
 return {evidence:io.receipt('stale_lease',proof)};
}
