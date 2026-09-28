import { captureSelectedStorageGraphScope,captureStorageGraphScope,computeStorageGraphResult,
 STORAGE_GRAPH_METHOD,storageGraphV11CheckpointMethod,
 type StorageGraphScope } from './storage-community-graph';
import { STORAGE_V11_PREPARED_FOLD } from './storage-v11-history';
/** The same rule the write site uses, so the durable envelope names the key
 * work is actually staged under rather than the namespace they were split
 * from — and so a fits envelope and a model envelope record different digests.
 *
 * It takes this pass's own fold switch for the same reason the write site does:
 * the namespace has to follow the configuration the compute will actually run
 * in, not a module default the deployment has overridden. */
const v11CheckpointMethod=(metric:'fits'|'model',preparedFold?:boolean):string=>
 storageGraphV11CheckpointMethod(metric,preparedFold??STORAGE_V11_PREPARED_FOLD);
import { readStorageCommunityOwnerPage, captureStorageCommunityAuthority,
 readStorageCommunityDeliveredTerminalEpoch, readStorageCommunitySourceTerminalEpoch,
 type StorageCommunityOwner } from './storage-community-authority';
import { ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS } from './admin-community-allowance';
import { COMMUNITY_MODEL_CACHE_MAX_BYTES, COMMUNITY_MODEL_CACHE_MAX_PAGES } from './community-allowance';
import type { StorageAnalyticsBindings } from './analytics-delivery';
import { validStorageModelPublication, type StorageModelPublicationValue } from './storage-community-publication-value';
import { StorageGraphOperationError, withStorageGraphFailureStage,
 type StorageGraphFailureFields } from './storage-analytics-failure';
import {loadTypedV11GenerationSnapshot} from './typed-v11-quota-reader';
import {storageHistoryKeyDigest,type StorageHistoryKey} from './storage-history-checkpoint';
import {planHistoricalModelBlockRanges} from './analytics-model-block-contract';
import {advanceStorageModelBlockGraphWork} from './storage-community-graph-model-block';
import {claimStorageGraphWorkSelection,completeStorageGraphWorkSelection,discardStorageGraphWorkSelection,
 ensureStorageGraphWorkSelection,
 loadLiveStorageGraphWorkSelection,readStorageGraphWorkSelection,releaseStorageGraphWorkSelection,
 type StorageGraphWorkEnvelope,type StorageGraphWorkSelection,type StorageGraphSelectionKey}
 from './storage-community-graph-selection';

const fail=()=>new Error('STORAGE_GRAPH_WORK_UNAVAILABLE');
const CURRENT_FIT_CACHE_PAGE=64;
const SCOPE_RETRY_HEADROOM_MS=4_000;
// Covers a claim, bounded scope recapture and release; after recapture the
// same headroom keeps completion/release outside the calculation's meter.
const SELECTION_QUERY_RESERVE=40;
type CachedGraphResult={owner_digest:string;source_kind:'v0.2'|'v1'|'v1.1'|'mixed'|'effective'};
export interface StorageGraphWorkProgress {
 state:'complete'|'reused'|'deferred'|'idle';metric?:'fits'|'model';day?:string;reason?:string;
 failure?:StorageGraphFailureFields;
}

function ownerSource(owner:StorageCommunityOwner):CachedGraphResult['source_kind'] {
 return owner.hasEffective?'effective':owner.hasV11?'v1.1':owner.hasV1?owner.hasLegacy?'mixed':'v1':'v0.2';
}

/** A current fit is publishable as a completed snapshot across later appends,
 * so presence under the exact method and source format is the recovery hint.
 * The graph kernel and publisher retain their full input and authority checks. */
async function nextMissingCurrentFitPosition(target:D1Database,sourceId:string,owners:StorageCommunityOwner[],
 position:number,day:string):Promise<number> {
 const cached=new Map<string,CachedGraphResult['source_kind']>();
 const digests=owners.flatMap(owner=>owner.ownerDigest?[owner.ownerDigest]:[]);
 for(let offset=0;offset<digests.length;offset+=CURRENT_FIT_CACHE_PAGE) {
  const page=digests.slice(offset,offset+CURRENT_FIT_CACHE_PAGE);
  const rows=(await target.prepare(`SELECT owner_digest,source_kind FROM analytics_community_graph_results
   WHERE source_id=? AND metric='fits' AND day=? AND method=?
     AND owner_digest IN(${page.map(()=>'?').join(',')}) ORDER BY owner_digest LIMIT ?`)
   .bind(sourceId,day,STORAGE_GRAPH_METHOD,...page,page.length+1).all<CachedGraphResult>()).results;
  if(rows.length>page.length)throw fail();
  const expected=new Set(page);
  for(const row of rows) {
   if(!expected.has(row.owner_digest)||!['v0.2','v1','v1.1','mixed','effective'].includes(row.source_kind))throw fail();
   cached.set(row.owner_digest,row.source_kind);
  }
 }
 const start=Math.floor(position/2);
 for(let offset=0;offset<owners.length;offset++) {
  const index=(start+offset)%owners.length,owner=owners[index]!;
  if(!owner.ownerDigest||cached.get(owner.ownerDigest)!==ownerSource(owner))return index*2;
 }
 return position;
}

/** Historical model results have the same bounded, advisory cache contract as
 * current fits. A missing result is a useful place to resume an existing
 * checkpoint, but it never proves that the checkpoint or its source inputs are
 * valid; the graph kernel still loads and fences the exact dependency key. */
async function nextMissingHistoricalModelPosition(target:D1Database,sourceId:string,owners:StorageCommunityOwner[],
 position:number,day:string):Promise<number> {
 const cached=new Map<string,CachedGraphResult['source_kind']>();
 const digests=owners.flatMap(owner=>owner.ownerDigest?[owner.ownerDigest]:[]);
 for(let offset=0;offset<digests.length;offset+=CURRENT_FIT_CACHE_PAGE) {
  const page=digests.slice(offset,offset+CURRENT_FIT_CACHE_PAGE);
  const rows=(await target.prepare(`SELECT owner_digest,source_kind FROM analytics_community_graph_results
   WHERE source_id=? AND metric='model' AND day=? AND method=?
     AND owner_digest IN(${page.map(()=>'?').join(',')}) ORDER BY owner_digest LIMIT ?`)
   .bind(sourceId,day,STORAGE_GRAPH_METHOD,...page,page.length+1).all<CachedGraphResult>()).results;
  if(rows.length>page.length)throw fail();
  const expected=new Set(page);
  for(const row of rows) {
   if(!expected.has(row.owner_digest)||!['v0.2','v1','v1.1','mixed','effective'].includes(row.source_kind))throw fail();
   cached.set(row.owner_digest,row.source_kind);
  }
 }
 for(let offset=0;offset<owners.length;offset++) {
  const index=(position+offset)%owners.length,owner=owners[index]!;
  if(!owner.ownerDigest||cached.get(owner.ownerDigest)!==ownerSource(owner))return index;
 }
 return position;
}

/** Empty historical slots can serve current work, but must not repeatedly
 * validate a fully cached cohort. A durable selection remains pending even if
 * an older result is present. This is only a scheduling hint: scope capture,
 * epoch validation and the normal lease still govern the selected owner-day. */
async function nextPendingCurrentPosition(target:D1Database,sourceId:string,owners:StorageCommunityOwner[],
 position:number,day:string):Promise<number|null> {
 const cached=new Map<string,CachedGraphResult['source_kind']>();
 const digests=owners.flatMap(owner=>owner.ownerDigest?[owner.ownerDigest]:[]);
 for(let offset=0;offset<digests.length;offset+=CURRENT_FIT_CACHE_PAGE) {
  const page=digests.slice(offset,offset+CURRENT_FIT_CACHE_PAGE);
  const rows=(await target.prepare(`SELECT r.owner_digest,r.metric,r.source_kind FROM analytics_community_graph_results r
   WHERE r.source_id=? AND r.day=? AND r.method=? AND r.metric IN('fits','model')
    AND r.owner_digest IN(${page.map(()=>'?').join(',')})
    AND NOT EXISTS(SELECT 1 FROM analytics_community_graph_work_selection s
     WHERE s.source_id=r.source_id AND s.owner_digest=r.owner_digest AND s.day=r.day AND s.metric=r.metric
      AND s.state IN('pending','claimed'))
   ORDER BY r.owner_digest,r.metric LIMIT ?`)
   .bind(sourceId,day,STORAGE_GRAPH_METHOD,...page,page.length*2+1)
   .all<CachedGraphResult&{metric:'fits'|'model'}>()).results;
  if(rows.length>page.length*2)throw fail();
  const expected=new Set(page);
  for(const row of rows) {
   const key=`${row.owner_digest}:${row.metric}`;
   if(!expected.has(row.owner_digest)||!['fits','model'].includes(row.metric)
    ||!['v0.2','v1','v1.1','mixed','effective'].includes(row.source_kind)||cached.has(key))throw fail();
   cached.set(key,row.source_kind);
  }
 }
 for(let offset=0;offset<owners.length*2;offset++) {
  const index=(position+offset)%(owners.length*2),owner=owners[Math.floor(index/2)]!;
  const metric=index%2===0?'fits':'model';
  if(!owner.ownerDigest||cached.get(`${owner.ownerDigest}:${metric}`)!==ownerSource(owner))return index;
 }
 return null;
}

/** Fair selection is durable BEFORE an expensive query. One problematic source
 * cannot prevent every other source from advancing. One third of the service
 * goes to current fits/models, two thirds to the newest unfinished historical
 * day. Finish that cohort before opening another day's checkpoints. */
export async function advanceStorageCommunityGraphWork(options:StorageAnalyticsBindings & {
 nowMs?:number;remainingQueries?:number;deadlineMs?:number;
 /** Claim lease for the owner-day this call selects. The caller sets it above
  * its own deadline, so a pass that works for its whole window still holds the
  * claim at the end and a concurrent pass sees the owner-day as busy. An
  * abandoned claim still recovers on its own once the lease expires. */
 leaseMs?:number;
 /** Whether this pass may fold prepared days for a v1.1 owner. Threaded from
  * the composition root's `GRAPH_DAY_PROJECTION_FOLD` switch; absent means the
  * module constant, which is off. */
 preparedFold?:boolean;
 /** Statements this call refuses to start below. The default reserves one
  * heavy attempt and its checkpoint save, which is what a pass that gets one
  * graph attempt per invocation needs. A pass that keeps returning to this
  * lane inside one window sets a smaller floor, so the last of its meter is
  * spent resuming a claim rather than left unusable. */
  admissionQueries?:number;
  /** Local qualification seam for complete historical model blocks. The
   * ordinary scheduler leaves this off until the integrated path is measured. */
  modelBlocks?:boolean;
  sharedFeatures?:boolean;
}):Promise<StorageGraphWorkProgress> {
 const nowMs=options.nowMs??Date.now();
 if(!Number.isFinite(nowMs))throw fail();
 if(options.modelBlocks!==undefined&&typeof options.modelBlocks!=='boolean'
  ||options.sharedFeatures!==undefined&&typeof options.sharedFeatures!=='boolean')throw fail();
 const admissionQueries=options.admissionQueries??550;
 if(!Number.isSafeInteger(admissionQueries)||admissionQueries<1||admissionQueries>1_000)throw fail();
 if((options.remainingQueries??900)<admissionQueries || Date.now()>=(options.deadlineMs??Date.now()+20_000)) {
  return {state:'deferred',reason:'budget'};
 }
 const owners:StorageCommunityOwner[]=[];let after='',bytes=0;
 for(let page=0;;page++) {
  if(page>=COMMUNITY_MODEL_CACHE_MAX_PAGES)return {state:'deferred',reason:'cohort_capacity'};
  const rows=await readStorageCommunityOwnerPage(options.source,{afterParticipantId:after});
  for(const owner of rows) {
  if(!owner.hasV1&&!owner.hasV11&&!owner.hasV12&&!owner.hasLegacy)continue;
   bytes+=new TextEncoder().encode(JSON.stringify(owner)).byteLength;
   if(bytes>COMMUNITY_MODEL_CACHE_MAX_BYTES)return {state:'deferred',reason:'cohort_capacity'};
   owners.push(owner);
  }
  if(rows.length<64)break;
  after=rows.at(-1)!.participantId;
 }
 if(!owners.length)return {state:'idle'};
 await options.target.prepare(`INSERT INTO analytics_community_graph_scan(source_id,revision,tick,current_position,history_position) VALUES(?,1,0,0,0)
  ON CONFLICT(source_id) DO NOTHING`).bind(options.sourceId).run();
 const scan=await options.target.prepare(`SELECT revision,tick,current_position,history_position
  FROM analytics_community_graph_scan WHERE source_id=?`).bind(options.sourceId)
  .first<{revision:number;tick:number;current_position:number;history_position:number}>();
 if(!scan||![scan.revision,scan.tick,scan.current_position,scan.history_position].every(Number.isSafeInteger)
  ||scan.revision<1||scan.tick<0||scan.tick>2||scan.current_position<0||scan.history_position<0)throw fail();
 let current=scan.tick===0;
 let position=current?scan.current_position%(owners.length*2)
  :scan.history_position%owners.length;
 const today=new Date(nowMs).toISOString().slice(0,10);
 if(current&&position%2===0)position=await nextMissingCurrentFitPosition(options.target,options.sourceId,owners,position,today);
 let day:string|null=today;
 if(!current) {
  const authority=await captureStorageCommunityAuthority(options.source,options);
  const terminalEpoch=Math.max(await readStorageCommunitySourceTerminalEpoch(options.source),
   await readStorageCommunityDeliveredTerminalEpoch(options.target,options.sourceId));
  const from=new Date(Date.parse(today)-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*86400000).toISOString().slice(0,10);
  const published=(await options.target.prepare(`SELECT day,authority_json,payload_json,payload_sha256 FROM analytics_community_model_publications
   WHERE source_id=? AND day>=? AND day<? AND method=? ORDER BY day LIMIT ?`)
   .bind(options.sourceId,from,today,STORAGE_GRAPH_METHOD,ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS).all<StorageModelPublicationValue>()).results;
  const completed=new Set<string>();
  for(const row of published)if(await validStorageModelPublication(row,authority,terminalEpoch))completed.add(row.day);
  day=null;
  for(let offset=1;offset<ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS;offset++) {
   const candidate=new Date(Date.parse(today)-offset*86400000).toISOString().slice(0,10);
   if(!completed.has(candidate)){day=candidate;break;}
  }
  if(day===null) {
   const pending=await nextPendingCurrentPosition(options.target,options.sourceId,owners,
    scan.current_position%(owners.length*2),today);
   if(pending!==null){current=true;position=pending;day=today;}
  }
 }
 if(!current&&day!==null)position=await nextMissingHistoricalModelPosition(options.target,options.sourceId,owners,position,day);
 const owner=owners[current?Math.floor(position/2):position%owners.length]!;
 const metric=current&&position%2===0?'fits':'model';
 const claimed=await options.target.prepare(`UPDATE analytics_community_graph_scan SET revision=revision+1,
  tick=(tick+1)%3,current_position=?,history_position=?,updated_ms=? WHERE source_id=? AND revision=?`)
  .bind(current?position+1:scan.current_position,current?scan.history_position:position+1,nowMs,options.sourceId,scan.revision).run();
 if(claimed.meta.changes!==1)return {state:'deferred',reason:'claim_changed'};
 if(day===null)return {state:'idle'};
 if(!owner.ownerDigest)return {state:'deferred',metric,day,reason:'source_bootstrap_pending'};
 const capture=()=>withStorageGraphFailureStage('graph_scope',()=>captureStorageGraphScope(options.source,{owner,day,metric,
  sourceId:options.sourceId,sourceNamespace:options.sourceNamespace,
  ...(options.preparedFold===undefined?{}:{preparedFold:options.preparedFold})}));
 const captureLatest=async()=>{
  try{return await capture();}
  catch(error){
   // A concurrent owner-authority change invalidates the first captured scope.
   // Retry that exact claimed owner once from a fresh authority snapshot. Every
   // source/input/final fence still runs; a second race remains a closed error.
   if(!(error instanceof StorageGraphOperationError)||error.reason!=='source_changed'
    ||Date.now()+SCOPE_RETRY_HEADROOM_MS>=(options.deadlineMs??Date.now()+20_000))throw error;
   return capture();
  }
 };
 let scope:StorageGraphScope|undefined,selection:StorageGraphWorkSelection|null=null,claimToken:string|null=null;
 if(owner.hasV11||owner.hasEffective){
  const key:StorageGraphSelectionKey={sourceId:options.sourceId,ownerDigest:owner.ownerDigest,day,metric};
  const existing=await withStorageGraphFailureStage('graph_scope',()=>readStorageGraphWorkSelection(options.target,key));
  if(existing&&existing.state!=='complete'){
   const live=await withStorageGraphFailureStage('graph_scope',()=>loadLiveStorageGraphWorkSelection({
    source:options.source,target:options.target,key,nowMs}));
   if(!live)return {state:'deferred',metric,day,reason:'selection_invalidated'};
   selection=live;
   // Effective source pages are expensive. The live owner/target proofs above
   // suffice to leave another claimant alone before capturing the full window.
   if(owner.hasEffective&&selection.state==='claimed'&&selection.claimExpiresMs!>nowMs)
    return {state:'deferred',metric,day,reason:'selection_busy'};
  }else{
   const latest=await captureLatest();
   if(!['v1.1','effective'].includes(latest.source)||!('source'in latest.pin))throw fail();
   const pin=latest.pin;
   const snapshot=latest.source==='v1.1'
    ?await withStorageGraphFailureStage('graph_scope',()=>loadTypedV11GenerationSnapshot(options.source,
      {sourceNamespace:options.sourceNamespace,pin})):null;
   const ownerAuthorityEpoch=await options.target.prepare(`SELECT authority_epoch FROM analytics_owner_state
    WHERE source_id=? AND owner_digest=? AND state='active'`).bind(options.sourceId,owner.ownerDigest)
    .first<number>('authority_epoch');
   if(!Number.isSafeInteger(ownerAuthorityEpoch)||ownerAuthorityEpoch!<1)
    return {state:'deferred',metric,day,reason:latest.source==='effective'?'effective_owner_pending':'v11_owner_pending'};
   const authorityEpoch=ownerAuthorityEpoch as number;
   let envelope:StorageGraphWorkEnvelope;
   if(latest.source==='effective'){
    if(authorityEpoch!==latest.owner.authorityEpoch)return {state:'deferred',metric,day,reason:'effective_owner_pending'};
    envelope={version:2,source:'effective',sourceId:options.sourceId,sourceNamespace:options.sourceNamespace,
     ownerDigest:owner.ownerDigest,day:latest.day,metric,fixedNow:latest.fixedNow,
     dependencyDigest:latest.dependencyDigest,checkpointDependencyDigest:latest.checkpointDependencyDigest,
     targetAuthorityEpoch:authorityEpoch,participantId:latest.owner.participantId,ownerRevision:latest.owner.ownerRevision};
   }else{
    if(!snapshot)throw fail();
    scope={...latest,snapshot,ownerAuthorityEpoch:authorityEpoch,owner:{...latest.owner,inputRevision:snapshot.inputRevision}};
    const checkpointKey:StorageHistoryKey={sourceId:options.sourceId,sourceNamespace:options.sourceNamespace,
     ownerDigest:owner.ownerDigest,day:scope.day,dependencyDigest:scope.checkpointDependencyDigest,
     method:v11CheckpointMethod(metric,options.preparedFold)};
    envelope={version:1,source:'v1.1',sourceId:options.sourceId,
     sourceNamespace:options.sourceNamespace,ownerDigest:owner.ownerDigest,day:scope.day,metric,
     fixedNow:scope.fixedNow,dependencyDigest:scope.dependencyDigest,
     checkpointDependencyDigest:scope.checkpointDependencyDigest,checkpointMethod:checkpointKey.method,
     checkpointKeyDigest:await storageHistoryKeyDigest(checkpointKey),targetAuthorityEpoch:authorityEpoch,snapshot};
   }
   const ensured=await withStorageGraphFailureStage('graph_scope',()=>ensureStorageGraphWorkSelection({
    source:options.source,target:options.target,envelope,...(existing?{expectedRevision:existing.revision}:{}),nowMs}));
   if(!('selection'in ensured)||!ensured.selection||ensured.status==='conflict')
    return {state:'deferred',metric,day,reason:'selection_changed'};
   selection=ensured.selection;
  }
  if((options.remainingQueries??900)<SELECTION_QUERY_RESERVE
   ||Date.now()>=(options.deadlineMs??Date.now()+20_000))return {state:'deferred',metric,day,reason:'budget'};
  const token=crypto.randomUUID();claimToken=token;
  const claimed=await withStorageGraphFailureStage('graph_scope',()=>claimStorageGraphWorkSelection({
   source:options.source,target:options.target,selection:selection!,claimToken:token,nowMs,
   ...(options.leaseMs===undefined?{}:{leaseMs:options.leaseMs})}));
  if(claimed.status!=='claimed'||!claimed.selection)
   return {state:'deferred',metric,day,reason:claimed.status==='busy'?'selection_busy':'selection_changed'};
  selection=claimed.selection;
  // Revalidate the claimed source contract before doing page work. v1.1 keeps
  // its pinned generation; effective work must recapture its exact live scope.
  let superseded=false;
  try{
   const envelope=selection.envelope;
   if(owner.hasEffective&&envelope.source==='effective'){
    // The lease does not authorize cached source evidence. Recompute every
    // family/correction dependency after claiming and retain the reader's
    // owner checks before/after every page and checkpoint promotion.
    scope=await captureLatest();
    superseded=scope.source!=='effective'||envelope.day!==scope.day||envelope.metric!==scope.metric
     ||envelope.fixedNow!==scope.fixedNow||envelope.dependencyDigest!==scope.dependencyDigest
     ||envelope.checkpointDependencyDigest!==scope.checkpointDependencyDigest
     ||envelope.participantId!==scope.owner.participantId||envelope.ownerRevision!==scope.owner.ownerRevision
     ||envelope.targetAuthorityEpoch!==scope.owner.authorityEpoch;
   }else if(!owner.hasEffective&&envelope.source==='v1.1'){
    scope=await withStorageGraphFailureStage('graph_scope',()=>captureSelectedStorageGraphScope(options.source,{owner,day,metric,
     snapshot:envelope.snapshot,ownerAuthorityEpoch:envelope.targetAuthorityEpoch,
     sourceId:options.sourceId,sourceNamespace:options.sourceNamespace,
     ...(options.preparedFold===undefined?{}:{preparedFold:options.preparedFold})}));
    const checkpointKey:StorageHistoryKey={sourceId:options.sourceId,sourceNamespace:options.sourceNamespace,
     ownerDigest:owner.ownerDigest,day:scope.day,dependencyDigest:scope.checkpointDependencyDigest,
     method:v11CheckpointMethod(scope.metric,options.preparedFold)};
    superseded=envelope.day!==scope.day||envelope.metric!==scope.metric||envelope.fixedNow!==scope.fixedNow
     ||envelope.dependencyDigest!==scope.dependencyDigest
     ||envelope.checkpointDependencyDigest!==scope.checkpointDependencyDigest
     ||envelope.checkpointMethod!==checkpointKey.method
     ||envelope.checkpointKeyDigest!==await storageHistoryKeyDigest(checkpointKey);
   }else superseded=true;
  }catch(error){
   try{await releaseStorageGraphWorkSelection({target:options.target,selection,claimToken:token});}catch{/* Preserve the scope failure. */}
   selection=null;claimToken=null;throw error;
  }
  if(superseded){
   // Never throw here: a stale row would otherwise cost this lane its whole
   // attempt on every pass that selects the owner-day. Remove the superseded
   // row under this claim's revision; the next pass records a fresh selection
   // from the current scope and resumes that owner-day normally.
   try{await discardStorageGraphWorkSelection(options.target,selection);}
   catch{try{await releaseStorageGraphWorkSelection({target:options.target,selection,claimToken:token});}
    catch{/* The lease still expires on its own. */}}
   selection=null;claimToken=null;
   return {state:'deferred',metric,day,reason:'selection_changed'};
  }
 }else scope=await captureLatest();
 try{
  if(!scope)throw fail();
  const selectedScope=scope;
  const maxQueries=(options.remainingQueries??900)-SELECTION_QUERY_RESERVE;
  if(maxQueries<50||Date.now()>=(options.deadlineMs??Date.now()+20_000))
   return {state:'deferred',metric,day,reason:'budget'};
  // The normal scan cursor and owner-day selection claim stay authoritative.
  // A block may serve only a selected effective historical model date in a
  // planned UTC-aligned range, including its clipped historical edges.
  if(options.modelBlocks===true&&metric==='model'&&day<today&&selectedScope.source==='effective'
   &&planHistoricalModelBlockRanges(today).some(range=>range.outputFromDay<=day&&day<=range.outputThroughDay)){
   // The adapter retires stale jobs even when the remaining allowance cannot
   // start its block runner. It still shares this claim and invocation meter.
   const block=await withStorageGraphFailureStage('graph_model_compute',
    ()=>advanceStorageModelBlockGraphWork({source:options.source,target:options.target,
     sourceId:options.sourceId,sourceNamespace:options.sourceNamespace,
     scope:selectedScope,nowMs,maxQueries,deadlineMs:options.deadlineMs,
     ...(options.sharedFeatures===true?{sharedFeatures:true}:{})}));
   if(block.state!=='unsupported'){
    if(block.state==='complete'&&selection&&claimToken){
     const finished=await completeStorageGraphWorkSelection({target:options.target,selection,claimToken});
     if(finished.status!=='completed')return {state:'deferred',metric,day,reason:'selection_changed'};
     selection=null;
    }
    return block.state==='complete'?{state:block.reused?'reused':'complete',metric,day}
     :{state:'deferred',metric,day,reason:block.reason??'block_deferred'};
   }
  }
  // An unsupported block may have spent bounded preflight statements before
  // yielding to the native path. Re-read the live allowance before computing.
  const nativeQueries=(options.remainingQueries??900)-SELECTION_QUERY_RESERVE;
  if(nativeQueries<50||Date.now()>=(options.deadlineMs??Date.now()+20_000))
   return {state:'deferred',metric,day,reason:'budget'};
  const result=await withStorageGraphFailureStage(metric==='fits'?'graph_current_fit_compute':'graph_model_compute',
   ()=>computeStorageGraphResult(options,selectedScope,{maxQueries:nativeQueries,
    deadlineMs:options.deadlineMs,
    ...(options.sharedFeatures===true?{sharedFeatures:true}:{}),
    ...(options.preparedFold!==undefined?{preparedFold:options.preparedFold}:{})}));
  if(result.state==='complete'&&selection&&claimToken){
   const finished=await completeStorageGraphWorkSelection({target:options.target,selection,claimToken});
   if(finished.status!=='completed')return {state:'deferred',metric,day,reason:'selection_changed'};
   selection=null;
  }
  return result.state==='complete'?{state:result.reused?'reused':'complete',metric,day}
   :{state:'deferred',metric,day,reason:result.reason,...(result.failure?{failure:result.failure}:{})};
 }finally{
  if(selection&&claimToken){
   try{await releaseStorageGraphWorkSelection({target:options.target,selection,claimToken});}catch{/* Preserve the graph failure. */}
  }
 }
}
