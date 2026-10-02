import {sha256Hex} from '../../src/crypto';
import type {DevicePrincipal} from '../../src/device-auth';
import type {TelemetryV12Chunk,TelemetryV12DayManifest,TelemetryV12Record,
 TelemetryV12UsageEvent,TelemetryV12QuotaObservation,TelemetryV11UsageEvent,TelemetryV11DomainManifest} from '@app-usagemonitor/telemetry-contract';

type Current=typeof import('./analytics-mutation-current');
type Extra={
 readTypedTelemetryRowsByStorageIds:typeof import('../../src/typed-telemetry-compatibility').readTypedTelemetryRowsByStorageIds;
 prepareUsageCorrectionAssertion:typeof import('../../src/telemetry-usage-reconciliation').prepareUsageCorrectionAssertion;
 parseTelemetryV12Record:typeof import('@app-usagemonitor/telemetry-contract').parseTelemetryV12Record;
 validateTelemetryV12DayUsageOrder:typeof import('@app-usagemonitor/telemetry-contract').validateTelemetryV12DayUsageOrder;
 readEffectiveTelemetryOwnerDayPage:typeof import('../../src/telemetry-usage-effective-reader').readEffectiveTelemetryOwnerDayPage;
};
export type FunctionalNativeAdmission=Current&Extra;
export type FunctionalNativeKind='same_occurrence_total_repair'|'timestamp_move'|'cross_day_move'
 |'quota_change'|'plan_change'|'equal_time_tie'|'empty_day_replacement';
export type FunctionalNativeRequest={kind:FunctionalNativeKind;participantId:string;deviceId:string;
 day:string;nowEpoch:number;occurrenceId?:string;destinationDay?:string};
export type FunctionalNativeReceipt={kind:FunctionalNativeKind;outcome:'accepted'|'native_refused';
 affectedDays:readonly string[];changedFields:readonly string[];priorRecords:number;newRecords:number;
 /** Invoked admission API calls only. The episode meter must include preparation, source reads, SQL and delivery. */
 nativeCalls:number;nativeRefusalCode?:string;partialAdmission?:boolean;
 effective?:readonly FunctionalNativeEffectiveResult[]};
export type FunctionalNativeEffectiveResult={day:string;stream:'quota'|'session'|'usage';occurrenceId:string;
 status:'compatible'|'conflict'|'absent';eventTimeConflict:boolean|null;sourceCount:number|null;
 recordDigest:string|null};
type DayEntry={day:string;manifestId:string;manifestDigest:string};
type Selected={id:number;digest:string;record:TelemetryV12Record};
const DAY=/^\d{4}-\d{2}-\d{2}$/u, ID=/^[A-Za-z0-9._:-]{8,128}$/u;
function refuse(code:string):never{throw Error('FUNCTIONAL_NATIVE_'+code);}
function validDay(value:string){const ms=Date.parse(value+'T00:00:00.000Z');
 if(!DAY.test(value)||!Number.isSafeInteger(ms)||new Date(ms).toISOString().slice(0,10)!==value)refuse('DAY');}
const utc=(value:string)=>value.slice(0,10);
const stream=(record:TelemetryV12Record):'quota'|'session'|'usage'=>record.schemaVersion.startsWith('usage-')?'usage'
 :record.schemaVersion.startsWith('quota-')?'quota':'session';
const occurrence=(record:TelemetryV12Record)=>record.schemaVersion==='usage-event-v1.2'?record.eventId
 :record.schemaVersion==='quota-observation-v1.2'?record.observationId:record.sessionUuid;
function request(value:FunctionalNativeRequest){if(!value||!['same_occurrence_total_repair','timestamp_move','cross_day_move',
 'quota_change','plan_change','equal_time_tie','empty_day_replacement'].includes(value.kind)
 ||typeof value.participantId!=='string'||!ID.test(value.participantId)
 ||typeof value.deviceId!=='string'||!ID.test(value.deviceId)
 ||!Number.isSafeInteger(value.nowEpoch)||value.nowEpoch<0)refuse('REQUEST');
 validDay(value.day);if(value.destinationDay!==undefined)validDay(value.destinationDay);
 if(value.kind==='cross_day_move'?(value.destinationDay===undefined||value.destinationDay===value.day):value.destinationDay!==undefined)refuse('DESTINATION');
 if(value.kind==='empty_day_replacement'?(value.occurrenceId!==undefined):typeof value.occurrenceId!=='string'||!ID.test(value.occurrenceId))refuse('OCCURRENCE');
}
async function principal(db:D1Database,participantId:string,deviceId:string){
 const result=await db.prepare(`SELECT device.id AS deviceId,device.participant_id AS participantId,
  participant.consent_version AS participantConsentVersion,device.expires_at AS expiresAt,
  device.credential_generation AS credentialGeneration,device.social_verified_at AS socialVerifiedAt,
  device.authority_kind AS authorityKind FROM device_credentials device
  JOIN participants participant ON participant.id=device.participant_id
  WHERE device.id=? AND device.participant_id=? AND participant.state='active'`)
  .bind(deviceId,participantId).first<DevicePrincipal>();
 if(result===null)refuse('DEVICE_SCOPE');
 if(result.deviceId!==deviceId||result.participantId!==participantId)refuse('DEVICE_SCOPE');return result;
}
async function currentDays(db:D1Database,participantId:string):Promise<{deviceId:string|null;days:DayEntry[]}>{
 const head=await db.prepare(`SELECT head.generation_id AS generationId,domain.device_id AS deviceId,
  domain.from_day AS fromDay,domain.through_day AS throughDay,
  (SELECT count(*) FROM telemetry_v12_domain_days WHERE generation_id=head.generation_id) AS dayCount
  FROM telemetry_v12_domain_heads head LEFT JOIN telemetry_v12_domains domain
   ON domain.id=head.generation_id AND domain.participant_id=head.participant_id
  WHERE head.participant_id=?`).bind(participantId).first<{generationId:string;deviceId:string|null;
   fromDay:string|null;throughDay:string|null;dayCount:number}>();
 if(head&&(head.deviceId===null||head.fromDay===null||head.throughDay===null
  ||!Number.isSafeInteger(head.dayCount)||head.dayCount<1||head.dayCount>466))refuse('DOMAIN_HEAD');
 const rows=(await db.prepare(`SELECT domain.device_id AS deviceId,day.observed_day AS day,
  day.manifest_id AS manifestId,manifest.manifest_digest AS manifestDigest
  FROM telemetry_v12_domain_heads head JOIN telemetry_v12_domains domain ON domain.id=head.generation_id
  JOIN telemetry_v12_domain_days day ON day.generation_id=domain.id
  JOIN telemetry_v12_day_manifests manifest ON manifest.id=day.manifest_id
   AND manifest.participant_id=domain.participant_id AND manifest.device_id=domain.device_id
   AND manifest.chunk_day=day.observed_day AND manifest.manifest_digest=day.manifest_digest
   AND manifest.state='ready' WHERE head.participant_id=? ORDER BY day.observed_day LIMIT 467`)
  .bind(participantId).all<DayEntry&{deviceId:string}>()).results;
 if(rows.length>466||rows.some((row,i)=>i>0&&rows[i-1]!.day>=row.day))refuse('DOMAIN_VECTOR');
 const devices=new Set(rows.map(row=>row.deviceId));if(devices.size>1)refuse('DOMAIN_DEVICE');
 if(head&&(rows.length!==head.dayCount||rows[0]?.day!==head.fromDay
  ||rows.at(-1)?.day!==head.throughDay||rows.some(row=>row.deviceId!==head.deviceId)
  ||rows.some((row,i)=>i>0&&Date.parse(row.day+'T00:00:00.000Z')
   -Date.parse(rows[i-1]!.day+'T00:00:00.000Z')!==86_400_000)))refuse('DOMAIN_VECTOR');
 if(!head&&rows.length)refuse('DOMAIN_HEAD');
 return {deviceId:rows[0]?.deviceId??null,days:rows.map(({day,manifestId,manifestDigest})=>({day,manifestId,manifestDigest}))};
}
async function selected(native:FunctionalNativeAdmission,db:D1Database,participantId:string,entry:DayEntry):Promise<Selected[]>{
 const complete=await db.prepare(`SELECT manifest.expected_chunk_count AS expected,
  (SELECT count(*) FROM telemetry_v12_chunks chunk WHERE chunk.manifest_id=manifest.id) AS actual,
  (SELECT coalesce(sum(chunk.record_count),0) FROM telemetry_v12_chunks chunk
    WHERE chunk.manifest_id=manifest.id) AS expectedRows,
  (SELECT count(*) FROM telemetry_v12_chunks chunk WHERE chunk.manifest_id=manifest.id
    AND chunk.record_count!=(SELECT count(*) FROM telemetry_v12_records record WHERE record.chunk_id=chunk.id)) AS incomplete
  FROM telemetry_v12_day_manifests manifest WHERE manifest.id=? AND manifest.manifest_digest=?
   AND manifest.participant_id=? AND manifest.chunk_day=? AND manifest.state='ready'`)
  .bind(entry.manifestId,entry.manifestDigest,participantId,entry.day)
  .first<{expected:number;actual:number;expectedRows:number;incomplete:number}>();
 if(!complete||complete.expected!==complete.actual||complete.incomplete!==0)refuse('SELECTED_INCOMPLETE');
 const rows=(await db.prepare(`SELECT record.id AS id,hex(record.canonical_digest) AS digest FROM telemetry_v12_day_manifests manifest
  JOIN telemetry_v12_chunks chunk ON chunk.manifest_id=manifest.id
   AND chunk.participant_id=manifest.participant_id AND chunk.device_id=manifest.device_id
   AND chunk.chunk_day=manifest.chunk_day AND chunk.record_count=(SELECT count(*) FROM telemetry_v12_records WHERE chunk_id=chunk.id)
  JOIN telemetry_v12_records record ON record.chunk_id=chunk.id AND record.manifest_id=manifest.id AND record.stream=chunk.stream
  WHERE manifest.id=? AND manifest.manifest_digest=? AND manifest.participant_id=? AND manifest.chunk_day=?
   AND manifest.state='ready' ORDER BY record.id LIMIT 601`)
  .bind(entry.manifestId,entry.manifestDigest,participantId,entry.day).all<{id:number;digest:string}>()).results;
 if(rows.length>600||rows.length!==complete.expectedRows||new Set(rows.map(row=>row.id)).size!==rows.length)refuse('SELECTED_LIMIT');
 const wanted=new Set(rows.map(row=>row.id)),found=new Map<number,TelemetryV12Record>();
 for(const name of ['quota','session','usage'] as const){let after:Parameters<FunctionalNativeAdmission['readTelemetryV12EffectivePage']>[1]['after'];let count=0;
  for(;;){const page=await native.readTelemetryV12EffectivePage(db,{participantId,day:entry.day,stream:name,after,limit:200});
   if(!page.available)refuse('READER_UNAVAILABLE');
   for(const row of page.records){const id=Number(row.sourceRecordKey.slice('v12:record:'.length));
    if(!wanted.has(id))continue;
    if(found.has(id)||row.observedAt.slice(0,10)!==entry.day)refuse('SELECTED_DUPLICATE');
    const record=JSON.parse(row.sourceRecordJson) as TelemetryV12Record;
    native.parseTelemetryV12Record(name,record);found.set(id,record);}
   count+=page.records.length;if(count>3200)refuse('READER_LIMIT');
   if(!page.next)break;after=page.next;
  }}
 if(found.size!==wanted.size)refuse('SELECTED_INCOMPLETE');
 return rows.map(row=>({id:row.id,digest:row.digest,record:found.get(row.id)!}));
}
async function selectedV11Usage(native:FunctionalNativeAdmission,db:D1Database,sourceNamespace:string,
 participantId:string,day:string,occurrenceId:string){
 const rows=(await db.prepare(`SELECT proof.typed_record_id AS id FROM telemetry_v11_domain_heads head
  JOIN telemetry_v11_domain_days selected ON selected.generation_id=head.generation_id AND selected.observed_day=?
  JOIN telemetry_v11_day_manifests manifest ON manifest.id=selected.manifest_id
   AND manifest.participant_id=head.participant_id AND manifest.state='ready' AND manifest.chunk_day=selected.observed_day
  JOIN telemetry_v11_chunks chunk ON chunk.manifest_id=manifest.id AND chunk.stream='usage'
   AND chunk.participant_id=manifest.participant_id AND chunk.device_id=manifest.device_id
   AND chunk.record_count=(SELECT count(*) FROM typed_v11_record_admissions WHERE chunk_id=chunk.id)
  JOIN typed_v11_record_admissions proof ON proof.chunk_id=chunk.id AND proof.manifest_id=manifest.id
   AND proof.stream='usage' AND proof.occurrence_id=?
  WHERE head.participant_id=? LIMIT 2`).bind(day,occurrenceId,participantId).all<{id:number}>()).results;
 if(rows.length!==1)refuse('OLDER_OCCURRENCE');
 const decoded=await native.readTypedTelemetryRowsByStorageIds(db,{sourceNamespace,participantId,storageRowIds:[rows[0]!.id]});
 if(decoded.length!==1||decoded[0]!.format!=='v11'||decoded[0]!.stream!=='usage'
  ||decoded[0]!.occurrence_id!==occurrenceId||decoded[0]!.observed_day!==day)refuse('OLDER_DECODE');
 return decoded[0]!;
}
/** A distinct, metered accepted writer event before same-occurrence repair.
 * It replaces only an empty selected v1.1 day, retaining every prior row and
 * every other selected day. The caller must deliver both native events. */
export async function buildFunctionalV11RepairPreparation(native:FunctionalNativeAdmission,db:D1Database,input:{
 sourceNamespace:string;participantId:string;day:string;occurrenceId:string;nowEpoch:number;
}){
 validDay(input.day);
 if(!ID.test(input.participantId)||!ID.test(input.occurrenceId)||!Number.isSafeInteger(input.nowEpoch))refuse('PREPARATION_SCOPE');
 const active=await currentDays(db,input.participantId),entry=active.days.find(row=>row.day===input.day);
 if(!entry)refuse('PREPARATION_V12_DAY');
 const matching=(await selected(native,db,input.participantId,entry))
  .filter(row=>row.record.schemaVersion==='usage-event-v1.2'&&row.record.eventId===input.occurrenceId);
 if(matching.length!==1)refuse('PREPARATION_V12_OCCURRENCE');
 const current=matching[0]!.record as TelemetryV12UsageEvent;
 const {boundaryFlags:_boundary,tieOrder:_tie,cacheWriteTtl:_ttl,...shared}=current;
 const prior:TelemetryV11UsageEvent={...shared,schemaVersion:'usage-event-v1.1'};
 const assertions=await Promise.all([
  native.prepareUsageCorrectionAssertion({format:'v12',recordJson:native.canonicalTelemetryV12Json(current)}),
  native.prepareUsageCorrectionAssertion({format:'v11',recordJson:native.canonicalTelemetryV12Json(prior)}),
 ]);
 if(assertions[0]!.baseDigest!==assertions[1]!.baseDigest)refuse('PREPARATION_BASE');
 const v11Rows=(await db.prepare(`SELECT domain.device_id AS deviceId,day.observed_day AS day,
  day.manifest_id AS manifestId,manifest.manifest_digest AS manifestDigest,
  manifest.expected_chunk_count AS chunks FROM telemetry_v11_domain_heads head
  JOIN telemetry_v11_domains domain ON domain.id=head.generation_id
  JOIN telemetry_v11_domain_days day ON day.generation_id=domain.id
  JOIN telemetry_v11_day_manifests manifest ON manifest.id=day.manifest_id
   AND manifest.participant_id=domain.participant_id AND manifest.device_id=domain.device_id
   AND manifest.chunk_day=day.observed_day
   AND manifest.state='ready' WHERE head.participant_id=? ORDER BY day.observed_day LIMIT 367`)
  .bind(input.participantId).all<DayEntry&{deviceId:string;chunks:number}>()).results;
 if(!v11Rows.length||v11Rows.length>366||v11Rows.filter(row=>row.day===input.day&&row.chunks===0).length!==1
  ||new Set(v11Rows.map(row=>row.deviceId)).size!==1
  ||v11Rows.some((row,i)=>i>0&&row.day<=v11Rows[i-1]!.day))refuse('PREPARATION_V11_VECTOR');
 const device=await principal(db,input.participantId,v11Rows[0]!.deviceId);
 const prepared=await native.makeV11Day(input.day,{usage:[prior]},'synthetic-functional-native-v11');
 return {input,device,prepared,v11Rows,priorJson:native.canonicalTelemetryV12Json(prior),
  baseDigest:assertions[1]!.baseDigest};
}
export async function admitFunctionalV11RepairPreparation(native:FunctionalNativeAdmission,db:D1Database,
 built:Awaited<ReturnType<typeof buildFunctionalV11RepairPreparation>>,options:{postReadback?:boolean}={}
):Promise<{kind:'v11_preparation';nativeCalls:number;baseDigest:string}>{
 const {input,device,prepared,v11Rows}=built;
 let calls=0;calls++;
 await native.registerTelemetryV11DayManifest(db,device,prepared.manifest,input.nowEpoch);
 for(const chunk of prepared.chunks){const label='functional-v11:'+chunk.manifestDigest+':'+chunk.chunkId,
  digest=await sha256Hex(label);
  calls++;const issued=await native.createDeviceUploadAuthorization(db,device,digest,4096,input.nowEpoch);
  calls++;const claimed=await native.claimDeviceUploadAuthorization(db,'Upload '+issued.uploadAuthorization,
   {envelopeDigest:digest,bodyBytes:4096,contentType:'application/json'});
  calls++;await native.persistTypedV11StagedChunk(db,device,chunk,{sourceNamespace:input.sourceNamespace,
   chunkRowId:'chunk:'+(await sha256Hex(label)).slice(0,36),r2Key:'synthetic/functional/'+digest,
   envelopeDigest:digest,deviceUploadAuthorizationId:claimed.authorizationId},input.nowEpoch);
 }
 calls++;const ready=await native.registerTelemetryV11DayManifest(db,device,prepared.manifest,input.nowEpoch);
 const days=v11Rows.map(row=>row.day===input.day?{day:ready.day,manifestId:ready.manifestId,
  manifestDigest:ready.manifestDigest}:{day:row.day,manifestId:row.manifestId,manifestDigest:row.manifestDigest});
 calls++;const predecessor=await native.createTelemetryV11DomainPredecessor(db,device,input.nowEpoch);
 const manifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',
  fromDay:days[0]!.day,throughDay:days.at(-1)!.day,
  predecessor:{token:predecessor.token,previousGenerationId:predecessor.previousGenerationId,
   legacyFingerprint:predecessor.legacyFingerprint},days,manifestDigest:'0'.repeat(64)};
 manifest.manifestDigest=await sha256Hex(native.telemetryV11DomainManifestDigestInput(manifest));
 calls++;await native.activateTelemetryV11Domain(db,device,manifest,input.nowEpoch);
 if(options.postReadback!==false)await verifyFunctionalV11RepairPreparation(native,db,built);
 return {kind:'v11_preparation',nativeCalls:calls,baseDigest:built.baseDigest};
}
export async function verifyFunctionalV11RepairPreparation(native:FunctionalNativeAdmission,db:D1Database,
 built:Awaited<ReturnType<typeof buildFunctionalV11RepairPreparation>>){
 const {input}=built;
 const accepted=await selectedV11Usage(native,db,input.sourceNamespace,input.participantId,input.day,input.occurrenceId);
 if(accepted.record_json!==built.priorJson)refuse('PREPARATION_POST_RECORD');
 return {selected:true,baseDigest:built.baseDigest};
}
export async function prepareFunctionalV11Repair(native:FunctionalNativeAdmission,db:D1Database,input:{
 sourceNamespace:string;participantId:string;day:string;occurrenceId:string;nowEpoch:number;
}){
 return admitFunctionalV11RepairPreparation(native,db,await buildFunctionalV11RepairPreparation(native,db,input));
}
function qualifiedTotal(values:readonly (number|null)[]){return values.every(value=>value!==null)
 ?values.reduce<number>((sum,value)=>sum+(value??0),0):null;}
async function repair(native:FunctionalNativeAdmission,db:D1Database,sourceNamespace:string,
 input:FunctionalNativeRequest,selectedRows:Selected[]){
 const old=await selectedV11Usage(native,db,sourceNamespace,input.participantId,input.day,input.occurrenceId!);
 const oldRecord=JSON.parse(old.record_json) as TelemetryV12UsageEvent;
 const oldAssertion=await native.prepareUsageCorrectionAssertion({format:'v11',recordJson:old.record_json});
 const current=selectedRows.filter(row=>row.record.schemaVersion==='usage-event-v1.2'&&row.record.eventId===input.occurrenceId);
 if(current.length>1)refuse('CURRENT_DUPLICATE');
 const source=current[0]?.record as TelemetryV12UsageEvent|undefined;
 if(source){const assertion=await native.prepareUsageCorrectionAssertion({format:'v12',recordJson:native.canonicalTelemetryV12Json(source)});
  if(assertion.baseDigest!==oldAssertion.baseDigest||assertion.occurrenceId!==oldAssertion.occurrenceId||assertion.eventTime!==oldAssertion.eventTime)refuse('BASE_CONFLICT');}
 const record:TelemetryV12UsageEvent=source?structuredClone(source):{...oldRecord,schemaVersion:'usage-event-v1.2',boundaryFlags:null,tieOrder:null,cacheWriteTtl:null};
 const inputTotal=qualifiedTotal([record.components.inputUncachedTokens,record.components.inputCacheReadTokens,record.components.inputCacheWriteTokens]);
 const outputTotal=qualifiedTotal([record.components.outputTextTokens,record.components.outputReasoningTokens]);
 const fields:string[]=[];
 if(record.totalInputContextTokens===null&&inputTotal!==null){record.totalInputContextTokens=inputTotal;fields.push('totalInputContextTokens');}
 if(record.components.outputCombinedTokens===null&&outputTotal!==null){record.components.outputCombinedTokens=outputTotal;fields.push('components.outputCombinedTokens');}
 if(!fields.length)refuse('NO_QUALIFIED_REPAIR');
 native.parseTelemetryV12Record('usage',record);
 const result=await native.prepareUsageCorrectionAssertion({format:'v12',recordJson:native.canonicalTelemetryV12Json(record)});
 if(result.baseDigest!==oldAssertion.baseDigest||result.occurrenceId!==oldAssertion.occurrenceId||result.eventTime!==oldAssertion.eventTime)refuse('BASE_CONFLICT');
 return {records:[...selectedRows.filter(row=>row!==current[0]).map(row=>row.record),record],fields};
}
async function changedRecords(native:FunctionalNativeAdmission,db:D1Database,sourceNamespace:string,input:FunctionalNativeRequest,
 before:Map<string,Selected[]>):Promise<{days:Map<string,TelemetryV12Record[]>;fields:string[]}>{
 const old=before.get(input.day)??[],current=old.map(row=>row.record),fields:string[]=[];
 const days=new Map<string,TelemetryV12Record[]>([[input.day,current]]);
 if(input.kind==='same_occurrence_total_repair'){const fixed=await repair(native,db,sourceNamespace,input,old);days.set(input.day,fixed.records);return {days,fields:fixed.fields};}
 if(input.kind==='empty_day_replacement'){
  if(current.length!==0)refuse('DAY_NOT_EMPTY');
  const token=await sha256Hex('functional-empty:'+input.participantId+':'+input.day);
  const base=native.v11UsageRecord(input.day,'f',{eventId:'event:v2:'+token});
  const record:TelemetryV12UsageEvent={...base,schemaVersion:'usage-event-v1.2',boundaryFlags:null,tieOrder:null,cacheWriteTtl:null};
  native.parseTelemetryV12Record('usage',record);days.set(input.day,[record]);return {days,fields:['dayRecords']};
 }
 const matches=current.filter(record=>occurrence(record)===input.occurrenceId);
 if(matches.length!==1)refuse('CURRENT_OCCURRENCE');
 const prior=matches[0]!;let replacement:TelemetryV12Record|null=null;
 if(input.kind==='timestamp_move'||input.kind==='cross_day_move'){
  if(prior.schemaVersion!=='usage-event-v1.2')refuse('USAGE_REQUIRED');
  const usage=prior as TelemetryV12UsageEvent;
  const targetDay=input.kind==='cross_day_move'?input.destinationDay!:input.day;
  const time=targetDay+usage.eventTime.slice(10);
  const moved:TelemetryV12UsageEvent={...usage,eventTime:input.kind==='timestamp_move'
   ?new Date(Date.parse(usage.eventTime)+60_000).toISOString():time};replacement=moved;
  if(utc(moved.eventTime)!==targetDay||moved.eventTime===usage.eventTime)refuse('TIME_BOUNDARY');
  fields.push('eventTime');
  if(input.kind==='cross_day_move'){const destination=before.get(targetDay);if(!destination)refuse('DESTINATION_NOT_SELECTED');
   days.set(input.day,current.filter(record=>record!==prior));days.set(targetDay,[...destination!.map(row=>row.record),moved]);
   return {days,fields};}
 }else if(input.kind==='quota_change'){
  if(prior.schemaVersion!=='quota-observation-v1.2'||prior.usedPercent===null||prior.usedPercent>95)refuse('QUOTA_REQUIRED');
  const quota=prior as TelemetryV12QuotaObservation;
  replacement={...quota,usedPercent:quota.usedPercent!+5};fields.push('usedPercent');
 }else if(input.kind==='plan_change'){
  if(prior.schemaVersion!=='quota-observation-v1.2'||prior.planType!=='pro')refuse('PLAN_REQUIRED');
  const quota=prior as TelemetryV12QuotaObservation;
  replacement={...quota,planType:'plus',accountPlanAttribution:{...quota.accountPlanAttribution,planType:'plus'}};
  fields.push('planType','accountPlanAttribution.planType');
 }else if(input.kind==='equal_time_tie'){
  if(prior.schemaVersion!=='usage-event-v1.2'||prior.tieOrder!==null)refuse('TIE_REQUIRED');
  const usage=prior as TelemetryV12UsageEvent;
  const token=await sha256Hex('functional-tie:'+input.participantId+':'+input.day+':'+usage.eventId);
  const first:TelemetryV12UsageEvent={...structuredClone(usage),tieOrder:0};
  const second:TelemetryV12UsageEvent={...structuredClone(usage),eventId:'event:v2:'+token,tieOrder:1};
  native.parseTelemetryV12Record('usage',first);native.parseTelemetryV12Record('usage',second);
  days.set(input.day,[...current.filter(record=>record!==prior),first,second]);
  return {days,fields:['tieOrder','eventId','dayRecords']};
 }else refuse('KIND');
 if(replacement===null)refuse('KIND');
 native.parseTelemetryV12Record(stream(replacement),replacement);
 days.set(input.day,current.map(record=>record===prior?replacement:record));return {days,fields};
}
function refusal(error:unknown):string|null{if(!error||typeof error!=='object')return null;
 const value=error as {code?:unknown;status?:unknown};return typeof value.code==='string'&&/^[A-Z][A-Z0-9_]{2,80}$/u.test(value.code)
  &&Number.isInteger(value.status)&&Number(value.status)>=400&&Number(value.status)<600?value.code:null;}
function targetItems(input:FunctionalNativeRequest,old:Map<string,Selected[]>,
 changed:Map<string,TelemetryV12Record[]>){
 const targets=new Map<string,Set<string>>();
 for(const [day,records] of changed){const previous=old.get(day)??[];
  const priorIds=new Set(previous.map(row=>occurrence(row.record)));
  for(const record of [...previous.map(row=>row.record),...records]){
   const id=occurrence(record);
   if(id!==input.occurrenceId&&priorIds.has(id))continue;
   const key=day+'|'+stream(record),ids=targets.get(key)??new Set<string>();ids.add(id);targets.set(key,ids);
  }
 }
 return [...targets].flatMap(([key,ids])=>{
  const [day,name]=key.split('|') as [string,'quota'|'session'|'usage'];
  return [...ids].map(occurrenceId=>({day,stream:name,occurrenceId}));
 });
}
async function effectiveProof(native:FunctionalNativeAdmission,db:D1Database,sourceNamespace:string,
 participantId:string,input:FunctionalNativeRequest,old:Map<string,Selected[]>,
 changed:Map<string,TelemetryV12Record[]>):Promise<FunctionalNativeEffectiveResult[]>{
 return readFunctionalEffectiveTargets(native,db,sourceNamespace,participantId,targetItems(input,old,changed));
}

/** A fresh per-lane observer after the paired writer has finished. Its returned
 * status is evidence, never an inferred selected-head or publication result. */
export async function readFunctionalEffectiveTargets(native:FunctionalNativeAdmission,db:D1Database,
 sourceNamespace:string,participantId:string,requested:readonly Pick<FunctionalNativeEffectiveResult,'day'|'stream'|'occurrenceId'>[]
):Promise<FunctionalNativeEffectiveResult[]>{
 if(requested.length<1||requested.length>601)refuse('POST_TARGET_BOUND');
 const owners=(await db.prepare(`SELECT link.owner_digest AS ownerDigest,owner.revision AS ownerRevision,
  owner.authority_epoch AS authorityEpoch FROM storage_v11_owner_links link
  JOIN storage_owner_revisions owner ON owner.owner_digest=link.owner_digest
  WHERE link.participant_id=? AND link.state='active' AND owner.state='active' LIMIT 2`)
  .bind(participantId).all<{ownerDigest:string;ownerRevision:number;authorityEpoch:number}>()).results;
 if(owners.length!==1||!Number.isSafeInteger(owners[0]!.ownerRevision)
  ||!Number.isSafeInteger(owners[0]!.authorityEpoch))refuse('POST_OWNER_SCOPE');
 const owner=owners[0]!,targets=new Map<string,Set<string>>();
 for(const item of requested){validDay(item.day);
  if(!['quota','session','usage'].includes(item.stream)||!ID.test(item.occurrenceId))refuse('POST_TARGET_SCOPE');
  const key=item.day+'|'+item.stream,ids=targets.get(key)??new Set<string>();ids.add(item.occurrenceId);targets.set(key,ids);
 }
 const output:FunctionalNativeEffectiveResult[]=[];
 for(const [key,ids] of [...targets].sort(([a],[b])=>a<b?-1:a>b?1:0)){const [day,name]=key.split('|') as [string,'quota'|'session'|'usage'];
  const found=new Map<string,{status:'compatible'|'conflict';eventTimeConflict:boolean;sourceCount:number;recordJson:string|null}>();
  let after:Parameters<FunctionalNativeAdmission['readEffectiveTelemetryOwnerDayPage']>[1]['after'];let scanned=0;
  for(;;){const page=await native.readEffectiveTelemetryOwnerDayPage(db,{sourceNamespace,
   ownerDigest:owner.ownerDigest,ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,
   day,stream:name,after,limit:100});
   for(const row of page.rows){scanned++;if(scanned>3200)refuse('POST_EFFECTIVE_LIMIT');
    if(ids.has(row.occurrenceId)){if(found.has(row.occurrenceId))refuse('POST_EFFECTIVE_DUPLICATE');
     if((row.status==='compatible')!==(row.recordJson!==null)||row.sourceCount<1)refuse('POST_EFFECTIVE_INVALID');
     found.set(row.occurrenceId,{status:row.status,eventTimeConflict:row.eventTimeConflict,
      sourceCount:row.sourceCount,recordJson:row.recordJson});}}
   if(!page.next)break;after=page.next;
  }
  for(const id of [...ids].sort()){const value=found.get(id);
   output.push({day,stream:name,occurrenceId:id,status:value?.status??'absent',
    eventTimeConflict:value?.eventTimeConflict??null,sourceCount:value?.sourceCount??null,
    recordDigest:value?.recordJson===null||value?.recordJson===undefined?null:await sha256Hex(value.recordJson)});
  }
 }
 return output;
}

/** The caller supplies a pinned native module for each lane. This helper never resets or rewrites a source. */
export function createFunctionalNativeInput(native:FunctionalNativeAdmission,sourceNamespace:string){
 if(typeof sourceNamespace!=='string'||sourceNamespace.length<1||sourceNamespace.length>256)refuse('NAMESPACE');
 const prepare=async(db:D1Database,input:FunctionalNativeRequest)=>{
  request(input);const device=await principal(db,input.participantId,input.deviceId),head=await currentDays(db,input.participantId);
  if(head.deviceId!==null&&head.deviceId!==input.deviceId)refuse('DEVICE_HEAD');
  const entries=new Map(head.days.map(entry=>[entry.day,entry]));
  if(input.kind!=='same_occurrence_total_repair'&&!entries.has(input.day))refuse('DAY_NOT_SELECTED');
  if(input.kind==='cross_day_move'&&!entries.has(input.destinationDay!))refuse('DESTINATION_NOT_SELECTED');
  if(input.kind==='same_occurrence_total_repair'&&head.days.length>0&&!entries.has(input.day))refuse('DAY_NOT_SELECTED');
  const selectedDays=new Map<string,Selected[]>();
  for(const day of [input.day,...(input.destinationDay?[input.destinationDay]:[])]){
   const entry=entries.get(day);selectedDays.set(day,entry?await selected(native,db,input.participantId,entry):[]);}
  const changed=await changedRecords(native,db,sourceNamespace,input,selectedDays);
  const changedDays=[...changed.days.keys()].sort(),countBefore=[...selectedDays.values()].reduce((sum,rows)=>sum+rows.length,0);
  const staged:{day:string;manifest:TelemetryV12DayManifest;chunks:TelemetryV12Chunk[]}[]=[];
  for(const day of changedDays){const records=changed.days.get(day)!;
   const usage=records.filter((record):record is TelemetryV12UsageEvent=>record.schemaVersion==='usage-event-v1.2');
   native.validateTelemetryV12DayUsageOrder(day,usage);
   const consent=native.telemetryV12RequiredConsent(),chunks:TelemetryV12Chunk[]=[];
   for(const name of ['quota','session','usage'] as const){const rows=records.filter(record=>stream(record)===name);
    if(rows.length>200)refuse('DAY_LIMIT');if(!rows.length)continue;
    const chunk:TelemetryV12Chunk={schemaVersion:'telemetry-contribution-v1.2',manifestDigest:'0'.repeat(64),
     chunkId:name+':'+day+':0',chunkRevision:1,chunkDigest:await sha256Hex(native.canonicalTelemetryV12Json(rows)),
     parserVersion:'synthetic-functional-native-v12',consent,records:rows};chunks.push(chunk);}
   const manifest:TelemetryV12DayManifest={schemaVersion:'telemetry-day-manifest-v1.2',day,
    parserVersion:'synthetic-functional-native-v12',consent,chunks:chunks.map(chunk=>({chunkId:chunk.chunkId,
     chunkDigest:chunk.chunkDigest,recordCount:chunk.records.length})),excluded:{quota:0,session:0,usage:0},manifestDigest:'0'.repeat(64)};
   manifest.manifestDigest=await sha256Hex(native.telemetryV12DayManifestDigestInput(manifest));
   for(const chunk of chunks)chunk.manifestDigest=manifest.manifestDigest;
   staged.push({day,manifest,chunks});
  }
  return {input,device,head,selectedDays,changed,changedDays,countBefore,staged,
   targets:targetItems(input,selectedDays,changed.days)};
 };
 const admit=async(db:D1Database,prepared:Awaited<ReturnType<typeof prepare>>,
  options:{postReadback?:boolean}={}):Promise<FunctionalNativeReceipt>=>{
  const {input,device,head,selectedDays,changed,changedDays,countBefore,staged}=prepared;
  let calls=0,started=false;
  try{
   const replacements:DayEntry[]=[];
   for(const {day,manifest,chunks} of staged){
    calls++;started=true;await native.registerTelemetryV12DayManifest(db,device,manifest,input.nowEpoch);
    for(const chunk of chunks){chunk.manifestDigest=manifest.manifestDigest;
     const label='synthetic-functional:'+manifest.manifestDigest+':'+chunk.chunkId;
     const digest=await sha256Hex(label);calls++;const issued=await native.createDeviceUploadAuthorization(db,device,digest,4096,input.nowEpoch);
     calls++;const claimed=await native.claimDeviceUploadAuthorization(db,'Upload '+issued.uploadAuthorization,
      {envelopeDigest:digest,bodyBytes:4096,contentType:'application/json'});
     calls++;await native.persistTelemetryV12StagedChunk(db,device,chunk,{chunkRowId:'chunk:'+(await sha256Hex(label)).slice(0,36),
      r2Key:'synthetic/functional/'+digest,envelopeDigest:digest,deviceUploadAuthorizationId:claimed.authorizationId},input.nowEpoch);}
    calls++;const ready=await native.registerTelemetryV12DayManifest(db,device,manifest,input.nowEpoch);
    replacements.push({day:ready.day,manifestId:ready.manifestId,manifestDigest:ready.manifestDigest});
   }
   const vector=new Map(head.days.map(entry=>[entry.day,entry]));for(const entry of replacements)vector.set(entry.day,entry);
   if(vector.size<1||vector.size>466)refuse('DOMAIN_VECTOR');
   const days=[...vector.values()].sort((a,b)=>a.day<b.day?-1:a.day>b.day?1:0);
   calls++;const predecessor=await native.createTelemetryV12DomainPredecessor(db,device,input.nowEpoch);
   const domain={schemaVersion:'telemetry-domain-manifest-v1.2' as const,fromDay:days[0]!.day,throughDay:days.at(-1)!.day,
    predecessor:{token:predecessor.token,previousGenerationId:predecessor.previousGenerationId,
     legacyFingerprint:predecessor.legacyFingerprint},days,manifestDigest:'0'.repeat(64)};
   domain.manifestDigest=await sha256Hex(native.telemetryV12DomainManifestDigestInput(domain));
   calls++;await native.activateTelemetryV12Domain(db,device,domain,input.nowEpoch);
   const after=await currentDays(db,input.participantId);
   if(after.deviceId!==input.deviceId||after.days.length!==days.length||after.days.some((entry,i)=>
    entry.day!==days[i]!.day||entry.manifestDigest!==days[i]!.manifestDigest))refuse('POST_DOMAIN');
   const priorIds=[...selectedDays.values()].flat().map(row=>row.id);
   if(priorIds.length){const old=new Map([...selectedDays.values()].flat().map(row=>[row.id,row.digest]));
    const checks=(await db.prepare(`SELECT id,hex(canonical_digest) AS digest FROM telemetry_v12_records
     WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 601`)
     .bind(JSON.stringify(priorIds)).all<{id:number;digest:string}>()).results;
    if(checks.length!==old.size||checks.some(row=>old.get(row.id)!==row.digest))refuse('PRIOR_RECORD_CHANGED');}
   const effective=options.postReadback===false?undefined:await effectiveProof(native,db,sourceNamespace,
    input.participantId,input,selectedDays,changed.days);
   return {kind:input.kind,outcome:'accepted',affectedDays:changedDays,changedFields:changed.fields,
    priorRecords:countBefore,newRecords:[...changed.days.values()].reduce((sum,rows)=>sum+rows.length,0),nativeCalls:calls,effective};
  }catch(error){const code=refusal(error);if(code!==null)return {kind:input.kind,outcome:'native_refused',affectedDays:changedDays,
   changedFields:changed.fields,priorRecords:countBefore,newRecords:[...changed.days.values()].reduce((sum,rows)=>sum+rows.length,0),
   nativeCalls:calls,nativeRefusalCode:code,partialAdmission:started};throw error;}
 };
 return {prepare,admit,async apply(db:D1Database,input:FunctionalNativeRequest){
  return admit(db,await prepare(db,input));
 }};
}
