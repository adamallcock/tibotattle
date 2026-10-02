import {expect} from 'vitest';
import {createD1InvocationBudget} from '../../src/d1-invocation-budget';
import {createAnalyticsProfile,profileAnalyticsDatabase,summarizeAnalyticsProfile,type AnalyticsProfile} from './analytics-profile';
import type {FunctionalLane,FunctionalScenarioContext} from './analytics-functional-branches';

/** Only real pinned/current public entrypoints are injected. No current
 * erasure implementation may be substituted into the native reference. */
export interface FunctionalLifecycleKernel {
 readIngestionChanges:typeof import('../../src/analytics-delivery').readIngestionChanges;
 applyAnalyticsChange:typeof import('../../src/analytics-delivery').applyAnalyticsChange;
 advanceStorageAnalytics:typeof import('../../src/storage-analytics-runtime').advanceStorageAnalytics;
 readStorageCommunityOwnerPage:typeof import('../../src/storage-community-authority').readStorageCommunityOwnerPage;
 revokeParticipantDevice:typeof import('../../src/device-auth').revokeParticipantDevice;
 revokeAccountlessEnrollment:typeof import('../../src/accountless-enrollment').revokeAccountlessEnrollment;
 eraseParticipantAsOwner:typeof import('../../src/participant-erasure').eraseParticipantAsOwner;
 advanceStorageErasureJobs:typeof import('../../src/storage-erasure').advanceStorageErasureJobs;
 requireStorageParticipantErasureComplete:typeof import('../../src/storage-erasure').requireStorageParticipantErasureComplete;
 hasDeletionTombstone:typeof import('../../src/retention').hasDeletionTombstone;
 replayDeletionTombstones:typeof import('../../src/retention').replayDeletionTombstones;
}
export interface FunctionalLifecycleScope {
 readonly sourceId:string;readonly sourceNamespace:string;readonly participantId:string;
}
export interface FunctionalLifecycleInput extends FunctionalLifecycleScope {
 readonly context:FunctionalScenarioContext;
 readonly kernels:Record<FunctionalLane,FunctionalLifecycleKernel>;
 readonly targetObservers?:Partial<Record<FunctionalLane,{wrap(target:D1Database):D1Database;enterInvocation(target:D1Database):()=>void}>>;
}
type Stores=FunctionalScenarioContext[FunctionalLane];
const lanes=['reference','candidate'] as const,sides=['source','target','ledger'] as const;
function fail(code:string):never {throw Error('FUNCTIONAL_EPISODE_'+code);}
const safeCode=(error:unknown)=>{
 const value=error&&typeof error==='object'?Reflect.get(error,'code'):null;
 return typeof value==='string'&&/^[A-Z_]{1,64}$/u.test(value)?value:null;
};

function laboratory(input:FunctionalLifecycleInput){
 if(!/^synthetic-p11-[a-zA-Z0-9:_-]{1,110}$/u.test(input.sourceId)
  ||input.sourceNamespace!==input.sourceId||input.context.now!==Date.now
  ||!/^participant:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.participantId)
  ||new Set(lanes.flatMap(lane=>sides.map(side=>input.context[lane][side]))).size!==6)fail('LABORATORY_SCOPE');
 const profiles:Record<FunctionalLane,AnalyticsProfile>={reference:createAnalyticsProfile(),candidate:createAnalyticsProfile()};
 let phase='action';
 const invocation=async<T>(lane:FunctionalLane,label:string,run:(stores:Stores)=>Promise<T>):Promise<T>=>{
  phase=label;const profile=profiles[lane],meter=createD1InvocationBudget(950),started=performance.now();
  const before=summarizeAnalyticsProfile(profile).statements;
  const observed=Object.fromEntries(sides.map(side=>[side,profileAnalyticsDatabase(input.context[lane][side],side,profile,()=>phase)])) as Stores;
  const observer=input.targetObservers?.[lane],leave=observer?.enterInvocation(meter.wrap(observed.target));let failed=false;
  try{
   const db={source:meter.wrap(observed.source),target:meter.wrap(observer?observer.wrap(observed.target):observed.target),ledger:meter.wrap(observed.ledger)};
   return await run(db);
  }catch(error){failed=true;throw error;}finally{
   leave?.();const statements=summarizeAnalyticsProfile(profile).statements-before;
   profile.invocations++;profile.maximumStatementsPerInvocation=Math.max(profile.maximumStatementsPerInvocation,meter.queriesUsed);
   profile.wallMs+=performance.now()-started;
   if(failed||statements!==meter.queriesUsed)console.log('analytics-functional-episode-incomplete',JSON.stringify({schemaVersion:'analytics-native-functional-episode-incomplete-v1',lane,phase:label,complete:false,profile:summarizeAnalyticsProfile(profile),invocationProfiledStatements:statements,invocationMeteredStatements:meter.queriesUsed,statementAccountingExact:statements===meter.queriesUsed}));
   if(statements!==meter.queriesUsed)throw Error('FUNCTIONAL_EPISODE_STATEMENT_ACCOUNTING');
   expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  }
 };
 return {invocation,receipt:(kind:string,proof:Record<FunctionalLane,unknown>)=>({
  schemaVersion:'analytics-native-functional-episode-v1',kind,proof,
  costs:Object.fromEntries(lanes.map(lane=>[lane,summarizeAnalyticsProfile(profiles[lane])])),
  allFamilyParity:'pending',postStartImports:0,postStartResets:0,clockOverrides:0,
  contract:'Actual native operations on retained independent stores. The full workload collector must separately prove every output, hash, timestamp and retained population.'})};
}

/** Re-present the exact last accepted event. A duplicate must exit through its
 * durable inbox receipt before projection preparation or any target write. */
export async function replayFunctionalDuplicateDelivery(input:FunctionalLifecycleInput){
 const io=laboratory(input),proof={} as Record<FunctionalLane,unknown>;
 for(const lane of lanes){
  proof[lane]=await io.invocation(lane,'duplicate_delivery',async db=>{
   const kernel=input.kernels[lane];
   const before=await db.target.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(input.sourceId).first<number>('sequence');
   if(!Number.isSafeInteger(before)||before!<1)fail('DELIVERED_CURSOR_REQUIRED');
   const changes=await kernel.readIngestionChanges(db.source,input.sourceId,before!-1,1);
   if(changes.length!==1||changes[0]!.sequence!==before)fail('ACCEPTED_EVENT_REQUIRED');
   let projectionCalls=0;
   const outcome=await kernel.applyAnalyticsChange(db.target,changes[0]!,async()=>{projectionCalls++;return fail('DUPLICATE_PROJECTION_REENTERED');});
   expect(outcome).toBe('already-applied');expect(projectionCalls).toBe(0);
   const after=await db.target.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(input.sourceId).first<number>('sequence');
   expect(after).toBe(before);
   return {outcome,projectionCalls,sourceSequence:changes[0]!.sequence,deliveredBefore:before,deliveredAfter:after};
  });
 }
 const receipt=io.receipt('duplicate_delivery',proof);
 for(const cost of Object.values(receipt.costs) as ReturnType<typeof summarizeAnalyticsProfile>[])expect(cost.rowsWritten).toBe(0);
 expect(proof.candidate).toEqual(proof.reference);return {evidence:receipt};
}

/** One lost response after a committed native v1.1 page. SQL text is retained
 * only inside the local adapter; reports contain counts, never statements. */
export function committedV11PageResponseLoss(database:D1Database){
 const originals=new WeakMap<D1PreparedStatement,{statement:D1PreparedStatement;sql:string}>();
 let lost=0,committedPageBatches=0;
 const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>{
  const proxy=new Proxy(statement,{get(inner,key){
   if(key==='bind')return(...values:unknown[])=>wrap(inner.bind(...values),sql);
   const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
  }});originals.set(proxy,{statement,sql});return proxy;
 };
 const target=new Proxy(database,{get(inner,key){
  if(key==='prepare')return(sql:string)=>wrap(inner.prepare(sql),sql);
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   const mapped=statements.map(statement=>{const entry=originals.get(statement);if(!entry)fail('FOREIGN_FAULT_STATEMENT');return entry;});
   const page=mapped.some(entry=>/^\s*INSERT\s+INTO\s+analytics_v11_projection_steps\b/iu.test(entry.sql));
   const result=await inner.batch(mapped.map(entry=>entry.statement));
   if(page){committedPageBatches++;if(lost===0){lost++;throw Error('FUNCTIONAL_COMMITTED_PAGE_RESPONSE_LOST');}}
   return result;
  };
  if(key==='withSession'||key==='exec'||key==='dump')return()=>fail('UNBOUNDED_FAULT_OPERATION');
  const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
 }});
 return {target,read:()=>({lost,committedPageBatches})};
}

/** Caller first admits exactly one authentic pending v1.1 replacement. No
 * cursor rollback or manufactured event may be used to create interruption. */
export async function interruptFunctionalV11Delivery(input:FunctionalLifecycleInput){
 const io=laboratory(input),proof={} as Record<FunctionalLane,unknown>;
 for(const lane of lanes){
  const kernel=input.kernels[lane];
  const pending=await io.invocation(lane,'interruption_pending_event',async db=>{
   const before=await db.target.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(input.sourceId).first<number>('sequence');
   if(!Number.isSafeInteger(before)||before!<1)fail('DELIVERED_CURSOR_REQUIRED');
   const changes=await kernel.readIngestionChanges(db.source,input.sourceId,before!,2);
   if(changes.length!==1||changes[0]!.sequence!==before!+1)fail('ONE_PENDING_ACCEPTED_EVENT_REQUIRED');
   const v11=await db.source.prepare('SELECT 1 present FROM storage_v11_event_sources WHERE event_digest=? AND participant_id=?')
    .bind(changes[0]!.eventDigest,input.participantId).first<number>('present');
   if(v11!==1)fail('PENDING_V11_EVENT_REQUIRED');return {before,event:changes[0]!};
  });
  let lost=0,pageBatches=0,steps=0;
  for(;steps<32;steps++){
   const result=await io.invocation(lane,'interrupted_native_delivery',async db=>{
    const fault=committedV11PageResponseLoss(db.target);
    try{return await kernel.advanceStorageAnalytics({...db,target:lost===0?fault.target:db.target,
     sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,maxV11PhysicalPages:1,deadlineMs:Date.now()+55_000});}
    finally{lost+=fault.read().lost;pageBatches+=fault.read().committedPageBatches;}
   });
   if(result.state==='idle')break;
  }
  if(steps===32||lost!==1||pageBatches<1)fail('INTERRUPTION_NOT_EXERCISED');
  proof[lane]=await io.invocation(lane,'interruption_receipt_proof',async db=>{
   const sequence=await db.target.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(input.sourceId).first<number>('sequence');
   const receipts=await db.target.prepare('SELECT count(*) n FROM analytics_applied_events WHERE source_id=? AND event_digest=? AND sequence=?')
    .bind(input.sourceId,pending.event.eventDigest,pending.event.sequence).first<number>('n');
   const work=await db.target.prepare('SELECT revision,phase FROM analytics_v11_projection_work WHERE source_id=? AND event_digest=?')
    .bind(input.sourceId,pending.event.eventDigest).first<{revision:number;phase:string}>();
   const pages=await db.target.prepare('SELECT count(*) n,count(DISTINCT revision) revisions FROM analytics_v11_projection_steps WHERE source_id=? AND event_digest=?')
    .bind(input.sourceId,pending.event.eventDigest).first<{n:number;revisions:number}>();
   expect(sequence).toBe(pending.event.sequence);expect(receipts).toBe(1);
   expect(work?.phase).toBe('ready');expect(pages?.n).toBe(work?.revision);expect(pages?.revisions).toBe(pages?.n);
   return {lostResponses:lost,committedPageBatches:pageBatches,deliverySteps:steps+1,sequence,receipts,
    durablePageCount:pages?.n,workRevision:work?.revision};
  });
 }
 // Native and maintained source acquisition may need a different number of
 // bounded calls. Both actual traces are retained, with exact closure above.
 return {evidence:io.receipt('interruption',proof)};
}

/** Social credential revocation stops future uploads while the active social
 * owner remains a public source. The full collector must prove native retained
 * history and outputs after this ordinary authority transition. */
export async function revokeFunctionalDevices(input:FunctionalLifecycleInput){
 const io=laboratory(input),proof={} as Record<FunctionalLane,unknown>;
 let expectedOwnerDigests:readonly string[]|undefined;
 for(const lane of lanes){
  proof[lane]=await io.invocation(lane,'device_revocation',async db=>{
   const kernel=input.kernels[lane],owners=await kernel.readStorageCommunityOwnerPage(db.source);
   const held=owners.find(owner=>owner.participantId===input.participantId);
   if(!held?.ownerDigest)fail('ACTIVE_OWNER_REQUIRED');
   expect(await db.source.prepare('SELECT owner_kind FROM participants WHERE id=?').bind(input.participantId).first<string>('owner_kind')).toBe('social');
   const devices=(await db.source.prepare("SELECT id FROM device_credentials WHERE participant_id=? AND state='active' ORDER BY id LIMIT 17")
    .bind(input.participantId).all<{id:string}>()).results;
   if(devices.length<1||devices.length>16)fail('DEVICE_BOUND');
   for(const device of devices)expect(await kernel.revokeParticipantDevice(db.source,input.participantId,device.id)).toBe(true);
   const remaining=await kernel.readStorageCommunityOwnerPage(db.source);
   expect(remaining.some(owner=>owner.ownerDigest===held.ownerDigest)).toBe(true);
   const survivors=remaining.map(owner=>owner.ownerDigest!).sort();
   expect(survivors).toEqual(owners.map(owner=>owner.ownerDigest!).sort());
   if(expectedOwnerDigests)expect(survivors).toEqual(expectedOwnerDigests);else expectedOwnerDigests=survivors;
   const state=await db.source.prepare('SELECT state FROM storage_owner_revisions WHERE owner_digest=?')
    .bind(held.ownerDigest).first<string>('state');expect(state).toBe('active');
   return {devicesRevoked:devices.length,ownerState:state,survivingOwners:survivors.length,historyRetained:true};
  });
 }
 expect(proof.candidate).toEqual(proof.reference);
 return {evidence:io.receipt('device_revocation',proof),expectedOwnerDigests};
}

/** A genuine accountless security reset removes public eligibility while
 * retaining the accepted physical records. It is distinct from prospective
 * user opt-out and from owner-only physical erasure. */
export async function withdrawFunctionalAccountlessOwner(input:FunctionalLifecycleInput&{enrollmentDeviceId:string}){
 const io=laboratory(input),proof={} as Record<FunctionalLane,unknown>;
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.enrollmentDeviceId))fail('ENROLLMENT_ID');
 const actionNow=Date.now();let expectedOwnerDigests:readonly string[]|undefined;
 for(const lane of lanes){
  proof[lane]=await io.invocation(lane,'withdrawal',async db=>{
   const kernel=input.kernels[lane],owners=await kernel.readStorageCommunityOwnerPage(db.source);
   const held=owners.find(owner=>owner.participantId===input.participantId);
   if(!held?.ownerDigest)fail('ACTIVE_OWNER_REQUIRED');
   expect(await db.source.prepare('SELECT owner_kind FROM participants WHERE id=?').bind(input.participantId).first<string>('owner_kind')).toBe('accountless');
   const root=await db.source.prepare("SELECT state FROM accountless_upload_owners WHERE participant_id=? AND enrollment_device_id=?")
    .bind(input.participantId,input.enrollmentDeviceId).first<string>('state');expect(root).toBe('active');
   const before=await db.source.prepare('SELECT COALESCE(max(sequence),0) sequence FROM storage_ingestion_changes').first<number>('sequence');
   const retainedRows=()=>db.source.prepare(`SELECT count(*) n FROM telemetry_v12_records r
    JOIN telemetry_v12_day_manifests m ON m.id=r.manifest_id WHERE m.participant_id=?`).bind(input.participantId).first<number>('n');
   const rowsBefore=await retainedRows();expect(rowsBefore).toBeGreaterThan(0);
   expect(await kernel.revokeAccountlessEnrollment(db.source,input.enrollmentDeviceId,'security_reset',actionNow)).toBe(true);
   const remaining=await kernel.readStorageCommunityOwnerPage(db.source);
   expect(remaining.some(owner=>owner.ownerDigest===held.ownerDigest)).toBe(false);
   const survivors=remaining.map(owner=>owner.ownerDigest!).sort();
   expect(survivors).toEqual(owners.filter(owner=>owner.ownerDigest!==held.ownerDigest).map(owner=>owner.ownerDigest!).sort());
   if(expectedOwnerDigests)expect(survivors).toEqual(expectedOwnerDigests);else expectedOwnerDigests=survivors;
   const terminal=await db.source.prepare('SELECT state FROM storage_owner_revisions WHERE owner_digest=?')
    .bind(held.ownerDigest).first<string>('state');expect(terminal).toBe('withdrawn');
   const changes=await db.source.prepare("SELECT count(*) n FROM storage_ingestion_changes WHERE owner_digest=? AND kind='owner-withdrawn' AND sequence>?")
    .bind(held.ownerDigest,before).first<number>('n');expect(changes).toBe(1);
   expect(await retainedRows()).toBe(rowsBefore);
   expect(await db.source.prepare('SELECT state FROM participants WHERE id=?').bind(input.participantId).first<string>('state')).toBe('active');
   return {enrollmentRevoked:true,ownerState:terminal,survivingOwners:survivors.length,nativeTerminalChange:true,acceptedRowsRetained:rowsBefore};
  });
 }
 expect(proof.candidate).toEqual(proof.reference);
 return {evidence:io.receipt('withdrawal',proof),expectedOwnerDigests};
}

/** Prospective user opt-out must retain the exact accepted head/history and
 * active public owner. All authority rows and the native retention marker must
 * agree; a security-reset transition cannot satisfy this proof. */
export async function optOutFunctionalAccountlessOwner(input:FunctionalLifecycleInput&{enrollmentDeviceId:string}){
 const io=laboratory(input),proof={} as Record<FunctionalLane,unknown>;
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.enrollmentDeviceId))fail('ENROLLMENT_ID');
 const actionNow=Date.now(),actionIso=new Date(actionNow).toISOString();let expectedOwnerDigests:readonly string[]|undefined;
 for(const lane of lanes){
  proof[lane]=await io.invocation(lane,'opt_out_retained',async db=>{
   const kernel=input.kernels[lane],owners=await kernel.readStorageCommunityOwnerPage(db.source);
   const held=owners.find(owner=>owner.participantId===input.participantId);
   if(!held?.ownerDigest)fail('ACTIVE_OWNER_REQUIRED');
   expect(await db.source.prepare('SELECT owner_kind FROM participants WHERE id=?').bind(input.participantId).first<string>('owner_kind')).toBe('accountless');
   const owner=await db.source.prepare("SELECT device_credential_id FROM accountless_upload_owners WHERE participant_id=? AND enrollment_device_id=? AND state='active'")
    .bind(input.participantId,input.enrollmentDeviceId).first<{device_credential_id:string}>();if(!owner)fail('ACTIVE_ENROLLMENT_REQUIRED');
   const head=await db.source.prepare('SELECT generation_id,revision FROM telemetry_v12_domain_heads WHERE participant_id=?')
    .bind(input.participantId).first<{generation_id:string;revision:number}>();if(!head)fail('ACCEPTED_HEAD_REQUIRED');
   const acceptedRows=async()=>{
    const records=(await db.source.prepare(`SELECT r.* FROM telemetry_v12_records r JOIN telemetry_v12_day_manifests m ON m.id=r.manifest_id
     WHERE m.participant_id=? ORDER BY r.id LIMIT 4097`).bind(input.participantId).all()).results;
    if(records.length<1||records.length>4096)fail('ACCEPTED_RECORD_BOUND');
    // Record metadata/digests alone cannot prove retained typed quantities.
    // Capture every child column and each referenced attribution before/after;
    // these synthetic rows stay private and every query is action-metered.
    const children:Record<string,unknown[]>={};
    for(const [table,order] of [['telemetry_v12_usage','c.record_id'],['telemetry_v12_quota','c.record_id'],
     ['telemetry_v12_session_tools','c.record_id,c.tool_class_id']] as const){
     const rows=(await db.source.prepare(`SELECT c.* FROM ${table} c JOIN telemetry_v12_records r ON r.id=c.record_id
      JOIN telemetry_v12_day_manifests m ON m.id=r.manifest_id WHERE m.participant_id=? ORDER BY ${order} LIMIT 4097`)
      .bind(input.participantId).all()).results;
     if(rows.length>4096)fail('ACCEPTED_CHILD_BOUND');children[table]=rows;
    }
    const attributions=(await db.source.prepare(`SELECT a.* FROM telemetry_v12_attributions a WHERE EXISTS (
     SELECT 1 FROM telemetry_v12_usage u JOIN telemetry_v12_records r ON r.id=u.record_id
      JOIN telemetry_v12_day_manifests m ON m.id=r.manifest_id WHERE m.participant_id=? AND u.attribution_id=a.id
    ) OR EXISTS (
     SELECT 1 FROM telemetry_v12_quota q JOIN telemetry_v12_records r ON r.id=q.record_id
      JOIN telemetry_v12_day_manifests m ON m.id=r.manifest_id WHERE m.participant_id=? AND q.attribution_id=a.id
    ) ORDER BY a.id LIMIT 4097`).bind(input.participantId,input.participantId).all()).results;
    if(attributions.length>4096)fail('ACCEPTED_ATTRIBUTION_BOUND');
    return {records,children,attributions};
   };
   const rowsBefore=await acceptedRows();
   expect(await kernel.revokeAccountlessEnrollment(db.source,input.enrollmentDeviceId,'user_opt_out',actionNow)).toBe(true);
   expect(await db.source.prepare('SELECT generation_id,revision FROM telemetry_v12_domain_heads WHERE participant_id=?')
    .bind(input.participantId).first()).toEqual(head);
   const marker=await db.source.prepare(`SELECT participant_id,enrollment_device_id,device_credential_id,generation_id,head_revision,retained_at
    FROM accountless_public_history_retention WHERE participant_id=? AND enrollment_device_id=?`)
    .bind(input.participantId,input.enrollmentDeviceId).first();
   expect(marker).toEqual({participant_id:input.participantId,enrollment_device_id:input.enrollmentDeviceId,
    device_credential_id:owner.device_credential_id,generation_id:head.generation_id,head_revision:head.revision,retained_at:actionIso});
   for(const [table,column,value] of [
    ['accountless_enrollment_ledger','device_id',input.enrollmentDeviceId],
    ['accountless_upload_owners','enrollment_device_id',input.enrollmentDeviceId],
    ['accountless_v12_device_authorizations','enrollment_device_id',input.enrollmentDeviceId],
   ] as const){
    expect(await db.source.prepare('SELECT state,revocation_reason,revoked_at FROM '+table+' WHERE '+column+'=?')
     .bind(value).first()).toEqual({state:'revoked',revocation_reason:'user_opt_out',revoked_at:actionIso});
   }
   expect(await db.source.prepare('SELECT state,revoked_at FROM device_credentials WHERE id=? AND participant_id=?')
    .bind(owner.device_credential_id,input.participantId).first()).toEqual({state:'revoked',revoked_at:actionIso});
   const remaining=await kernel.readStorageCommunityOwnerPage(db.source),survivors=remaining.map(value=>value.ownerDigest!).sort();
   expect(survivors).toEqual(owners.map(value=>value.ownerDigest!).sort());
   if(expectedOwnerDigests)expect(survivors).toEqual(expectedOwnerDigests);else expectedOwnerDigests=survivors;
   expect(await db.source.prepare('SELECT state FROM storage_owner_revisions WHERE owner_digest=?').bind(held.ownerDigest).first<string>('state')).toBe('active');
   expect(await db.source.prepare('SELECT state FROM participants WHERE id=?').bind(input.participantId).first<string>('state')).toBe('active');
   expect(await acceptedRows()).toEqual(rowsBefore);
   return {enrollmentRevoked:true,ownerState:'active',survivingOwners:survivors.length,historyRetained:true,
    exactRetentionMarker:true,revocationGraphRows:4,acceptedRowsRetained:rowsBefore.records.length,
    acceptedChildRowsRetained:Object.values(rowsBefore.children).reduce((sum,rows)=>sum+rows.length,0),
    acceptedAttributionRowsRetained:rowsBefore.attributions.length};
  });
 }
 expect(proof.candidate).toEqual(proof.reference);
 return {evidence:io.receipt('opt_out_retained',proof),expectedOwnerDigests};
}

/** The real owner erasure route and independent finite cleanup queue. Caller
 * supplies a synthetic-development Env with this invocation's exact bindings. */
export async function eraseFunctionalParticipant(input:FunctionalLifecycleInput&{environment:(stores:Stores)=>Env}){
 const io=laboratory(input),proof={} as Record<FunctionalLane,unknown>;
 let expectedOwnerDigests:readonly string[]|undefined;
 for(const lane of lanes){
  const kernel=input.kernels[lane];let requestDeferred=false;
  await io.invocation(lane,'owner_erasure_request',async db=>{
   const configured=input.environment(db);
   const storageMode:unknown=Reflect.get(configured,'TELEMETRY_STORAGE_MODE');
   if(configured.ENVIRONMENT!=='synthetic-development'||configured.USAGE_MONITOR_DB!==db.source||configured.DELETION_LEDGER!==db.ledger
    ||Reflect.get(configured,'ANALYTICS_DB')!==db.target||Reflect.get(configured,'TELEMETRY_STORAGE_NAMESPACE')!==input.sourceNamespace
    ||storageMode!=='typed')fail('ERASURE_ENVIRONMENT');
   try{const result=await kernel.eraseParticipantAsOwner(configured,'synthetic-p11-owner',input.participantId);expect(result.deleted).toBe(true);}
   catch(error){if(safeCode(error)!=='BACKEND_STORAGE_UNAVAILABLE')throw error;
    expect(await kernel.hasDeletionTombstone(db.ledger,input.participantId)).toBe(true);requestDeferred=true;}
  });
  let cleanupSteps=0;
  for(;cleanupSteps<256;cleanupSteps++){
   const state=await io.invocation(lane,'physical_erasure_page',db=>kernel.advanceStorageErasureJobs({...db,
    sourceId:input.sourceId,sourceNamespace:input.sourceNamespace},{maxJobs:1}));
   if(!state.pending)break;
  }
  if(cleanupSteps===256)fail('ERASURE_PAGE_BOUND');
  proof[lane]=await io.invocation(lane,'physical_erasure_completion',async db=>{
   await kernel.requireStorageParticipantErasureComplete(db.ledger,input.participantId,{...db,sourceId:input.sourceId,sourceNamespace:input.sourceNamespace});
   expect(await kernel.hasDeletionTombstone(db.ledger,input.participantId)).toBe(true);
   expect(await db.source.prepare('SELECT count(*) n FROM participants WHERE id=?').bind(input.participantId).first<number>('n')).toBe(0);
   const survivors=(await kernel.readStorageCommunityOwnerPage(db.source)).map(owner=>owner.ownerDigest!).sort();
   if(expectedOwnerDigests)expect(survivors).toEqual(expectedOwnerDigests);else expectedOwnerDigests=survivors;
   return {ownerRequestDeferred:requestDeferred,cleanupSteps:cleanupSteps+1,tombstone:true,participantRows:0,survivingOwners:survivors.length,
    nativePhysicalCompletion:true};
  });
 }
 return {evidence:io.receipt('physical_erasure',proof),expectedOwnerDigests};
}

/** Runs ONLY after a separate restore scenario has imported preterminal
 * source+target with the authentic terminal ledger at laboratory startup. */
export async function replayFunctionalTerminalLedger(input:FunctionalLifecycleInput&{quarantine:R2Bucket}){
 const io=laboratory(input),proof={} as Record<FunctionalLane,unknown>;
 let expectedOwnerDigests:readonly string[]|undefined;
 for(const lane of lanes){
  const kernel=input.kernels[lane];
  await io.invocation(lane,'restore_terminal_ledger_precondition',async db=>{
   expect(await kernel.hasDeletionTombstone(db.ledger,input.participantId)).toBe(true);
   expect(await db.source.prepare('SELECT count(*) n FROM participants WHERE id=?').bind(input.participantId).first<number>('n')).toBe(1);
  });
  let passes=0,suppressed=0;
  for(;passes<32;passes++){
   const value=await io.invocation(lane,'restore_terminal_replay',db=>kernel.replayDeletionTombstones(db.source,db.ledger,input.quarantine,
    Date.now(),undefined,true,{...db,sourceId:input.sourceId,sourceNamespace:input.sourceNamespace}));
   suppressed+=value.suppressed;if(value.complete)break;
  }
  if(passes===32||suppressed!==1)fail('RESTORE_REPLAY_BOUND');
  for(let step=0;step<256;step++){
   const state=await io.invocation(lane,'restore_erasure_page',db=>kernel.advanceStorageErasureJobs({...db,sourceId:input.sourceId,
    sourceNamespace:input.sourceNamespace},{maxJobs:1}));
   if(!state.pending)break;if(step===255)fail('RESTORE_ERASURE_BOUND');
  }
  proof[lane]=await io.invocation(lane,'restore_terminal_completion',async db=>{
   await kernel.requireStorageParticipantErasureComplete(db.ledger,input.participantId,{...db,sourceId:input.sourceId,sourceNamespace:input.sourceNamespace});
   expect(await db.source.prepare('SELECT count(*) n FROM participants WHERE id=?').bind(input.participantId).first<number>('n')).toBe(0);
   const survivors=(await kernel.readStorageCommunityOwnerPage(db.source)).map(owner=>owner.ownerDigest!).sort();
   if(expectedOwnerDigests)expect(survivors).toEqual(expectedOwnerDigests);else expectedOwnerDigests=survivors;
   return {replayPasses:passes+1,suppressed,participantRows:0,nativePhysicalCompletion:true,survivingOwners:survivors.length};
  });
 }
 return {evidence:io.receipt('restore_after_erasure',proof),expectedOwnerDigests};
}
