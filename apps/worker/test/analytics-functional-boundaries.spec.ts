import {expect,it} from 'vitest';
import {proveFunctionalAuthorityLag,expireFunctionalGraphLease,type FunctionalBoundaryInput} from './helpers/analytics-functional-boundaries';
const sourceId='synthetic-p11-boundaries',participantId='participant:4aa335fb-32cd-452e-91b9-73e818a3cf81';
function fixture(){
 const row={revision:2,payload_sha256:'a'.repeat(64)},owner={ownerDigest:'b'.repeat(64),participantId,ownerRevision:3,authorityEpoch:4};
 let applied=0;const calls:string[]=[];
 const database=()=>{const statement=(sql:string):D1PreparedStatement=>({bind:()=>statement(sql),all:async()=>{
  calls.push(sql);const results=sql.includes('analytics_source_cursors')?[{sequence:2}]:sql.includes('analytics_owner_state')?[{revision:2,authority_epoch:3,state:'active'}]:sql.includes('analytics_applied_events')?[{n:applied}]:sql.includes('analytics_community_graph_previews')?[structuredClone(row)]:[];
  return {success:true,results,meta:{rows_read:results.length,rows_written:0,duration:0}};
 }} as unknown as D1PreparedStatement);return {prepare:statement} as unknown as D1Database;};
 const stores=()=>({source:database(),target:database(),ledger:database()});
 const event={sequence:3,kind:'owner-active',ownerDigest:owner.ownerDigest,eventDigest:'c'.repeat(64)};
 const kernel={readIngestionChanges:async()=>[event],readStorageCommunityOwnerPage:async()=>[owner],readPublishedStorageCommunityGraph:async()=>null};
 const input={context:{reference:stores(),candidate:stores(),now:Date.now,analyticalNowMs:Date.now()},kernels:{reference:kernel,candidate:kernel},sourceId,sourceNamespace:sourceId,participantId} as unknown as FunctionalBoundaryInput;
 return {input,kernel,owner,event,row,calls,setApplied:(n:number)=>{applied=n;}};
}
it('observes a hard native authority lag without target writes and retains both complete meter receipts',async()=>{
 const f=fixture(),result=await proveFunctionalAuthorityLag(f.input),e=result.evidence;
 expect(e.kind).toBe('authority_lag');expect(f.calls).toHaveLength(12);
 for(const lane of ['reference','candidate'] as const){expect(e.costs[lane]).toMatchObject({statements:6,rowsWritten:0,metadataSamples:6,maximumStatementsPerInvocation:6});expect(e.proof[lane]).toMatchObject({targetSequence:2,sourceSequence:3,targetRevision:2,sourceRevision:3,previewRefused:true,priorPublicationRetainedExactly:true});}
});
it('refuses missing or already-delivered events, nonadvanced authority, visible stale output and changed retained rows',async()=>{
 for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.event.sequence=2;},(f:ReturnType<typeof fixture>)=>{f.event.kind='source-updated';},(f:ReturnType<typeof fixture>)=>{f.owner.authorityEpoch=3;},(f:ReturnType<typeof fixture>)=>f.setApplied(1),(f:ReturnType<typeof fixture>)=>{f.kernel.readPublishedStorageCommunityGraph=async()=>({}) as never;},(f:ReturnType<typeof fixture>)=>{f.kernel.readPublishedStorageCommunityGraph=async()=>{f.row.revision++;return null;};}]){
  const f=fixture();mutate(f);await expect(proveFunctionalAuthorityLag(f.input)).rejects.toThrow();
 }
 const f=fixture();f.input.context.candidate.source=f.input.context.reference.source;await expect(proveFunctionalAuthorityLag(f.input)).rejects.toThrow('BOUNDARY_SCOPE');expect(f.calls).toHaveLength(0);
});
function leaseFixture(){
 const f=fixture(),calls:string[]=[],states=new Map<D1Database,any>();
 const kernel={...f.kernel,
  captureStorageGraphScope:async()=>({source:'effective',fixedNow:1,dependencyDigest:'d'.repeat(64),checkpointDependencyDigest:'e'.repeat(64),owner:f.owner}),
  readStorageGraphWorkSelection:async()=>null,
  ensureStorageGraphWorkSelection:async({target,envelope}:any)=>{calls.push('ensure');const selection={key:{day:envelope.day},revision:1,state:'pending',envelope,envelopeSha256:'f'.repeat(64)};states.set(target,selection);return {status:'created',selection};},
  claimStorageGraphWorkSelection:async({target,selection,leaseMs}:any)=>{calls.push(leaseMs===1?'short-claim':'reclaim');const next={...selection,state:'claimed',revision:selection.revision+1,claimExpiresMs:Date.now()+(leaseMs??1000)};states.set(target,next);return {status:'claimed',selection:next};},
  loadLiveStorageGraphWorkSelection:async({target}:any)=>{calls.push('reap');const current=[...states.values()].find(s=>s.state==='claimed'&&s.claimExpiresMs<=Date.now());if(!current)throw Error('NOT_REAL_EXPIRED');const next={...current,state:'pending',revision:current.revision+1};states.set(target,next);return next;},
  completeStorageGraphWorkSelection:async({target}:any)=>{calls.push('old-complete');return {status:'conflict',selection:states.get(target)};},
  releaseStorageGraphWorkSelection:async({selection}:any)=>{calls.push('release');return {status:'released',selection:{...selection,state:'pending',revision:selection.revision+1}};},
 };
 f.input.kernels={reference:kernel,candidate:kernel} as unknown as FunctionalBoundaryInput['kernels'];return {...f,kernel,order:calls};
}
it('lets a real short lease expire before native reaping and old-CAS refusal, leaving normal pending recovery',async()=>{
 const f=leaseFixture(),result=await expireFunctionalGraphLease({...f.input,day:'2026-10-01'});
 expect(f.order).toEqual(['ensure','short-claim','reap','old-complete','reclaim','release','ensure','short-claim','reap','old-complete','reclaim','release']);
 expect(result.evidence.proof.reference).toMatchObject({priorClaimRevision:2,reapedRevision:3,oldCompletion:'conflict',reclaimedRevision:4,releasedRevision:5,pendingNativeRecovery:true});
 expect(result.evidence.clockOverrides).toBe(0);
});
it('rejects a fake reaper, accepted old CAS, wrong release state and invalid calendar',async()=>{
 for(const mutate of [(f:ReturnType<typeof leaseFixture>)=>{f.kernel.loadLiveStorageGraphWorkSelection=async()=>({revision:2,state:'claimed'}) as never;},(f:ReturnType<typeof leaseFixture>)=>{f.kernel.completeStorageGraphWorkSelection=async()=>({status:'complete'}) as never;},(f:ReturnType<typeof leaseFixture>)=>{f.kernel.releaseStorageGraphWorkSelection=async()=>({status:'released',selection:{state:'claimed'}}) as never;}]){
  const f=leaseFixture();mutate(f);await expect(expireFunctionalGraphLease({...f.input,day:'2026-10-01'})).rejects.toThrow();
 }
 const f=leaseFixture();await expect(expireFunctionalGraphLease({...f.input,day:'2026-02-30'})).rejects.toThrow();expect(f.order).toHaveLength(0);
});
