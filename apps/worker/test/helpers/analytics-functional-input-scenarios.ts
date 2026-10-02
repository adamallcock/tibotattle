import {expect} from 'vitest';
import {createD1InvocationBudget} from '../../src/d1-invocation-budget';
import {sha256Hex} from '../../src/crypto';
import {createAnalyticsProfile,profileAnalyticsDatabase,summarizeAnalyticsProfile} from './analytics-profile';
import type {FunctionalLane,FunctionalScenarioContext} from './analytics-functional-branches';
import {createFunctionalNativeInput,buildFunctionalV11RepairPreparation,admitFunctionalV11RepairPreparation,
 verifyFunctionalV11RepairPreparation,readFunctionalEffectiveTargets,
 type FunctionalNativeAdmission,type FunctionalNativeEffectiveResult,type FunctionalNativeKind,
 type FunctionalNativeReceipt} from './analytics-functional-native-input';
import {logicalJson} from './analytics-logical-bytes';
import {pairAnalyticsSources} from './analytics-paired-source';

type Stores=FunctionalScenarioContext[FunctionalLane];
const lanes=['reference','candidate'] as const,sides=['source','target','ledger'] as const;
const priorTables=['typed_telemetry_records','typed_telemetry_usage','typed_telemetry_quota',
 'typed_telemetry_session_tools','typed_v11_chunk_allocations','typed_v11_manifest_memberships',
 'typed_v11_record_proofs','telemetry_v12_day_manifests','telemetry_v12_chunks',
 'telemetry_v12_records','telemetry_v12_usage','telemetry_v12_quota','telemetry_v12_session_tools'] as const;
const id=/^[A-Za-z0-9._:-]{8,128}$/u,day=/^\d{4}-\d{2}-\d{2}$/u;
const hex=/^[0-9a-f]{64}$/u;
function fail(code:string):never{throw Error('FUNCTIONAL_PAIRED_NATIVE_'+code);}
function validDay(value:string){if(!day.test(value))return false;
 const epoch=Date.parse(value+'T00:00:00.000Z');
 return Number.isSafeInteger(epoch)&&new Date(epoch).toISOString().slice(0,10)===value;}
export type FunctionalPairedAction={kind:FunctionalNativeKind;day:string;occurrenceId?:string;destinationDay?:string};
export interface PairedFunctionalNativeInput {context:FunctionalScenarioContext;
 kernels:Record<FunctionalLane,FunctionalNativeAdmission>;sourceId:string;sourceNamespace:string;
 participantId:string;action:FunctionalPairedAction;}

/** Every old physical typed/1.2 record and stream detail row must survive
 * byte-for-byte. Payload stays in memory; the receipt exposes counts/hashes. */
async function priorPhysical(db:D1Database){
 const tables={} as Record<(typeof priorTables)[number],string[]>;
 for(const name of priorTables){const rows=(await db.prepare(`SELECT * FROM ${name} ORDER BY rowid LIMIT 3201`).all()).results;
  if(rows.length>3200)fail('PRIOR_ROW_BOUND');tables[name]=rows.map(row=>logicalJson(row)??fail('PRIOR_ROW_ENCODING'));
 }
 return tables;
}
function preserved(before:Awaited<ReturnType<typeof priorPhysical>>,after:Awaited<ReturnType<typeof priorPhysical>>){
 for(const name of priorTables){const remaining=new Map<string,number>();
  for(const row of after[name])remaining.set(row,(remaining.get(row)??0)+1);
  for(const row of before[name]){const count=remaining.get(row)??0;if(count<1)fail('PRIOR_PHYSICAL_ROW_CHANGED');
   remaining.set(row,count-1);}
 }
}
async function physicalSummary(value:Awaited<ReturnType<typeof priorPhysical>>){
 return Object.fromEntries(await Promise.all(priorTables.map(async name=>[name,{rows:value[name].length,
  sha256:await sha256Hex(JSON.stringify(value[name]))}])));
}
type Journal={sequence:number;ownerRevision:number;authorityEpoch:number;ownerDigest:string};
async function journal(db:D1Database,participantId:string):Promise<Journal>{
 const row=await db.prepare(`SELECT (SELECT coalesce(max(sequence),0) FROM storage_ingestion_changes) AS sequence,
  owner.revision AS ownerRevision,owner.authority_epoch AS authorityEpoch,owner.owner_digest AS ownerDigest
  FROM storage_v11_owner_links link JOIN storage_owner_revisions owner ON owner.owner_digest=link.owner_digest
  WHERE link.participant_id=? AND link.state='active' AND owner.state='active' LIMIT 2`)
  .bind(participantId).all<Journal>();
 if(row.results.length!==1||![row.results[0]!.sequence,row.results[0]!.ownerRevision,row.results[0]!.authorityEpoch]
  .every(value=>Number.isSafeInteger(value)&&value>=0)||!hex.test(row.results[0]!.ownerDigest))fail('JOURNAL_SCOPE');
 return row.results[0]!;
}
async function checkEvent(db:D1Database,before:Journal,after:Journal,interval:{startMs:number;endMs:number},
 participantId:string,format:'v11'|'v12'){
 if(!Number.isSafeInteger(interval.startMs)||!Number.isSafeInteger(interval.endMs)||interval.startMs>interval.endMs
  ||new Date(interval.startMs).toISOString().slice(0,10)!==new Date(interval.endMs).toISOString().slice(0,10))
  fail('WRITER_CLOCK_BOUNDARY');
 if(after.sequence!==before.sequence+1||after.ownerDigest!==before.ownerDigest
  ||after.ownerRevision!==before.ownerRevision+1||after.authorityEpoch<before.authorityEpoch)fail('JOURNAL_TRANSITION');
 const event=await db.prepare(`SELECT sequence,event_digest AS eventDigest,owner_digest AS ownerDigest,
  revision,authority_epoch AS authorityEpoch,recorded_ms AS recordedMs,kind
  FROM storage_ingestion_changes WHERE sequence=?`).bind(after.sequence)
  .first<{sequence:number;eventDigest:string;ownerDigest:string;revision:number;authorityEpoch:number;recordedMs:number;kind:string}>();
 const floor=(value:number)=>Math.floor(value/1000)*1000;
 if(!event||event.sequence!==after.sequence||event.ownerDigest!==after.ownerDigest||event.revision!==after.ownerRevision
  ||event.authorityEpoch!==after.authorityEpoch||!['owner-active','source-updated'].includes(event.kind)
  ||event.recordedMs<floor(interval.startMs)||event.recordedMs>floor(interval.endMs))fail('JOURNAL_EVENT');
 const source=await db.prepare(`SELECT event.recorded_ms AS recordedMs FROM storage_${format}_event_sources event
  JOIN telemetry_${format}_domains domain ON domain.id=event.generation_id
   AND domain.participant_id=event.participant_id AND domain.manifest_digest=event.manifest_digest
  JOIN telemetry_${format}_domain_heads head ON head.participant_id=event.participant_id
   AND head.generation_id=event.generation_id AND head.revision=event.head_revision
  WHERE event.event_digest=? AND event.owner_digest=? AND event.participant_id=?`)
  .bind(event.eventDigest,after.ownerDigest,participantId).first<{recordedMs:number}>();
 if(!source||source.recordedMs!==event.recordedMs)fail('EVENT_SOURCE_LINEAGE');
 return {sequence:event.sequence,revision:event.revision,authorityEpoch:event.authorityEpoch,kind:event.kind,
  recordedWithinWriterInterval:true};
}

/** The actual native caller runs once through the reviewed paired-source
 * adapter. Each physical lane still pays and records its own D1 work. */
export async function applyPairedFunctionalNativeInput(input:PairedFunctionalNativeInput){
 const action=input.action;
 if(!/^synthetic-p11-[a-zA-Z0-9:_-]{1,110}$/u.test(input.sourceId)
  ||input.sourceNamespace!==input.sourceId||input.context.now!==Date.now
  ||!/^participant:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.participantId)
  ||new Set(lanes.flatMap(lane=>sides.map(side=>input.context[lane][side]))).size!==6
  ||!validDay(action.day)||!Object.values(['same_occurrence_total_repair','timestamp_move','cross_day_move',
   'quota_change','plan_change','equal_time_tie','empty_day_replacement']).includes(action.kind)
  ||(action.kind==='empty_day_replacement'?action.occurrenceId!==undefined:!action.occurrenceId||!id.test(action.occurrenceId))
  ||(action.kind==='cross_day_move'?!action.destinationDay||!validDay(action.destinationDay)||action.destinationDay===action.day:action.destinationDay!==undefined))fail('ACTION_SCOPE');
 const profiles={reference:createAnalyticsProfile(),candidate:createAnalyticsProfile()};
 const invoke=async<T>(lane:FunctionalLane,label:string,run:(db:Stores)=>Promise<T>)=>{
  const meter=createD1InvocationBudget(950),started=performance.now();
  const db=Object.fromEntries(sides.map(side=>[side,meter.wrap(profileAnalyticsDatabase(input.context[lane][side],side,profiles[lane],()=>label))])) as Stores;
  try{return await run(db);}finally{profiles[lane].invocations++;
   profiles[lane].maximumStatementsPerInvocation=Math.max(profiles[lane].maximumStatementsPerInvocation,meter.queriesUsed);
   profiles[lane].wallMs+=performance.now()-started;expect(meter.queriesUsed).toBeLessThanOrEqual(950);}
 };
 const pairedStep=async<T>(label:string,run:(source:D1Database,nowEpoch:number)=>Promise<T>)=>{
  const meter={reference:createD1InvocationBudget(950),candidate:createD1InvocationBudget(950)};
  const started=performance.now(),startMs=Date.now(),nowEpoch=input.context.now();
  const paired=pairAnalyticsSources(meter.reference.wrap(profileAnalyticsDatabase(input.context.reference.source,'source',profiles.reference,()=>label)),
   meter.candidate.wrap(profileAnalyticsDatabase(input.context.candidate.source,'source',profiles.candidate,()=>label)));
  try{const result=await run(paired.database,nowEpoch);paired.assertExact();return {result,proof:{...paired.proof},interval:{startMs,endMs:Date.now()}};}
  finally{for(const lane of lanes){profiles[lane].invocations++;
    profiles[lane].maximumStatementsPerInvocation=Math.max(profiles[lane].maximumStatementsPerInvocation,meter[lane].queriesUsed);
    profiles[lane].wallMs+=performance.now()-started;expect(meter[lane].queriesUsed).toBeLessThanOrEqual(950);}}
 };
 // Preflight source identity is read through the same paired SQL/bind boundary.
 const device=await pairedStep('native_scope',async db=>{
  const row=await db.prepare(`SELECT domain.device_id AS deviceId FROM telemetry_v12_domain_heads head
   JOIN telemetry_v12_domains domain ON domain.id=head.generation_id AND domain.participant_id=head.participant_id
   WHERE head.participant_id=?`).bind(input.participantId).first<{deviceId:string}>();
  if(!row||!id.test(row.deviceId))fail('DEVICE_SCOPE');return row.deviceId;
 });
 const prior={} as Record<FunctionalLane,Awaited<ReturnType<typeof priorPhysical>>>;
 const prepared={} as Partial<Record<FunctionalLane,Awaited<ReturnType<typeof priorPhysical>>>>;
 const before={} as Record<FunctionalLane,Journal>;
 for(const lane of lanes){const capture=await invoke(lane,'native_before',async db=>({
   rows:await priorPhysical(db.source),head:await journal(db.source,input.participantId)}));
  prior[lane]=capture.rows;before[lane]=capture.head;}
 expect(prior.candidate).toEqual(prior.reference);
 expect(before.candidate).toEqual(before.reference);
 let preparation:Awaited<ReturnType<typeof pairedStep<Awaited<ReturnType<typeof admitFunctionalV11RepairPreparation>>>>>|null=null;
 const preparationEvents={} as Partial<Record<FunctionalLane,unknown>>;
 if(action.kind==='same_occurrence_total_repair'){
  const prepNowEpoch=input.context.now();
  const v11Plans={} as Record<FunctionalLane,Awaited<ReturnType<typeof buildFunctionalV11RepairPreparation>>>;
  for(const lane of lanes){const priorWrites=summarizeAnalyticsProfile(profiles[lane]).rowsWritten;
   v11Plans[lane]=await invoke(lane,'native_v11_preparation_read',db=>
   buildFunctionalV11RepairPreparation(input.kernels[lane],db.source,{
    sourceNamespace:input.sourceNamespace,participantId:input.participantId,day:action.day,
    occurrenceId:action.occurrenceId!,nowEpoch:prepNowEpoch}));
   expect(summarizeAnalyticsProfile(profiles[lane]).rowsWritten).toBe(priorWrites);}
  expect(v11Plans.candidate).toEqual(v11Plans.reference);
  preparation=await pairedStep('native_v11_preparation',db=>admitFunctionalV11RepairPreparation(input.kernels.reference,
   db,v11Plans.reference,{postReadback:false}));
  for(const lane of lanes){const state=await invoke(lane,'native_preparation_event',async db=>({
    head:await journal(db.source,input.participantId),rows:await priorPhysical(db.source)}));
   preserved(prior[lane],state.rows);prepared[lane]=state.rows;
   await invoke(lane,'native_preparation_readback',db=>verifyFunctionalV11RepairPreparation(input.kernels[lane],
    db.source,v11Plans[lane]));
   preparationEvents[lane]=await invoke(lane,'native_preparation_event_check',db=>checkEvent(db.source,before[lane],state.head,preparation!.interval,
    input.participantId,'v11'));
   before[lane]=state.head;}
  expect(prepared.candidate).toEqual(prepared.reference);
  expect(before.candidate).toEqual(before.reference);
  expect(preparationEvents.candidate).toEqual(preparationEvents.reference);
 }
 const actionNowEpoch=input.context.now();
 const plans={} as Record<FunctionalLane,Awaited<ReturnType<ReturnType<typeof createFunctionalNativeInput>['prepare']>>>;
 for(const lane of lanes){const priorWrites=summarizeAnalyticsProfile(profiles[lane]).rowsWritten;
  plans[lane]=await invoke(lane,'native_action_preparation',db=>
  createFunctionalNativeInput(input.kernels[lane],input.sourceNamespace).prepare(db.source,{
   ...action,participantId:input.participantId,deviceId:device.result,nowEpoch:actionNowEpoch}));
  expect(summarizeAnalyticsProfile(profiles[lane]).rowsWritten).toBe(priorWrites);}
 expect(plans.candidate).toEqual(plans.reference);
 const admission=await pairedStep('native_action',db=>createFunctionalNativeInput(input.kernels.reference,
  input.sourceNamespace).admit(db,plans.reference,{postReadback:false}));
 const accepted=admission.result as FunctionalNativeReceipt;
 if(accepted.outcome!=='accepted'||accepted.partialAdmission)fail('NATIVE_REFUSAL_REQUIRES_EXPLICIT_EPISODE');
 const after={} as Record<FunctionalLane,Awaited<ReturnType<typeof priorPhysical>>>;
 const effective={} as Record<FunctionalLane,readonly FunctionalNativeEffectiveResult[]>;
 const events={} as Record<FunctionalLane,unknown>;
 for(const lane of lanes){const state=await invoke(lane,'native_after',async db=>({
   rows:await priorPhysical(db.source),head:await journal(db.source,input.participantId)}));
  after[lane]=state.rows;preserved(prior[lane],state.rows);
  if(prepared[lane])preserved(prepared[lane],state.rows);
  events[lane]=await invoke(lane,'native_event_check',db=>checkEvent(db.source,before[lane],state.head,admission.interval,
   input.participantId,'v12'));
  effective[lane]=await invoke(lane,'native_effective_observer',db=>readFunctionalEffectiveTargets(input.kernels[lane],db.source,
   input.sourceNamespace,input.participantId,plans.reference.targets));
 }
 expect(effective.candidate).toEqual(effective.reference);
 expect(after.candidate).toEqual(after.reference);
 expect(events.candidate).toEqual(events.reference);
 return {evidence:{schemaVersion:'analytics-paired-functional-native-input-v1',action:action.kind,
  writer:accepted,preparation:preparation?{kind:preparation.result.kind,nativeCalls:preparation.result.nativeCalls,
   baseDigest:preparation.result.baseDigest,paired:preparation.proof,interval:preparation.interval}:null,
  paired:{scope:device.proof,admission:admission.proof},events,preparationEvents:preparation?preparationEvents:null,
  priorPhysical:Object.fromEntries(await Promise.all(lanes.map(async lane=>[lane,{
   before:await physicalSummary(prior[lane]),
   ...(prepared[lane]?{afterPreparation:await physicalSummary(prepared[lane])}:{}),
   after:await physicalSummary(after[lane]),allPriorRowsRetained:true,
   preparedRowsRetained:prepared[lane]?true:null}]))),
  freshEffective:effective,profiles:Object.fromEntries(lanes.map(lane=>[lane,summarizeAnalyticsProfile(profiles[lane])])),
  postStartImports:0,postStartResets:0,allFamilyParity:'pending',
  boundary:'Paired native admission and v1.1 preparation use one pinned caller with identical SQL and binds; each physical source is independently metered. Fresh per-lane effective reads are separate. Full family/public DTO parity remains the caller gate.'},
  expectedOwnerDigests:undefined};
}
