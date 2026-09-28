import {describe,expect,it} from 'vitest';
import {prepareV11UsageFeature,validV11UsageFeature,advanceV11UsageReduction,
  finishV11UsageReduction,createV11QuotaAcquisitionIdentity,
  type UsageRow,type V11PreparedUsageReader} from '../src/quota-analysis-v11';
import {appendEffectiveQuotaDay,finishEffectiveQuotaDay,foldEffectiveQuotaDays,
  mapEffectiveQuotaPageRow} from '../src/effective-quota-day';
import {modelHistoryWindow} from '../src/model-history-window';
import type {EffectiveTelemetryOccurrence} from '../src/telemetry-usage-effective-reader';
import type {V11SourcePin} from '../src/telemetry-v11-domain';
import {v11UsageRecord} from './helpers/telemetry-v11';

const day='2026-09-28',start=Date.parse(day),owner='a'.repeat(64);
const account=`account-track:v2:${'b'.repeat(64)}`;
const attribution={accountBasis:'same_source' as const,accountTrackId:account,
  planBasis:'same_source_occurrence' as const,planType:'pro' as const,planEraId:null};
const noRead=():never=>{throw new Error('UNEXPECTED_FEATURE_DATABASE_READ');};
const db:D1Database={prepare:noRead,batch:noRead,exec:noRead,withSession:noRead,dump:noRead};
const pin:V11SourcePin={source:'v1.1',participantId:'synthetic-feature-owner',generationId:'synthetic-feature-generation',
  fromDay:day,throughDay:day,inputRevision:1,mutationEpoch:1,fingerprint:'c'.repeat(64)};
function row(index:number,changes:Partial<ReturnType<typeof v11UsageRecord>>={}):UsageRow {
  const record=v11UsageRecord(day,'a',{eventId:`event:synthetic:${index.toString().padStart(4,'0')}`,
    eventTime:new Date(start+(index+0.5)*3_600_000).toISOString(),
    sessionUuid:'synthetic-private-session',apiServiceTier:'standard',accountPlanAttribution:attribution,...changes});
  return {occurrence_id:record.eventId,observed_at:record.eventTime,provider:record.provider,
    session_uuid:record.sessionUuid,record_json:JSON.stringify(record)};
}
async function acquisition(){
  const rows:EffectiveTelemetryOccurrence[]=Array.from({length:9},(_,index)=>{
    const record={schemaVersion:'quota-observation-v1.1',observationId:`quota:synthetic:${index}`,
      observedTime:new Date(start+index*3_600_000).toISOString(),provider:'openai_codex',planType:'pro',
      planVariant:'unknown',limitId:'codex',slot:'seven_day',usedPercent:5+index*10,
      windowDurationMinutes:10080,resetsAt:new Date(start+8*86_400_000).toISOString(),accountPlanAttribution:attribution};
    return {methodVersion:'effective-telemetry-owner-day-v1',stream:'quota',participantId:pin.participantId,
      ownerDigest:owner,occurrenceId:record.observationId,eventTime:record.observedTime,eventTimeConflict:false,
      status:'compatible',sourceCount:1,sourceFormats:['v11'],sourceRowIds:[],sourceRecordKeys:[],recordJson:JSON.stringify(record)};
  });
  const pending=appendEffectiveQuotaDay(null,day,rows.map((value,index)=>mapEffectiveQuotaPageRow(value,day,index+1)),10080);
  if(!pending)throw new Error('SYNTHETIC_QUOTA_REFUSED');
  const value=finishEffectiveQuotaDay(pending);
  if(!value)throw new Error('SYNTHETIC_QUOTA_REFUSED');
  const identity=createV11QuotaAcquisitionIdentity(pin,Date.parse(modelHistoryWindow(day).fixedNow));
  const folded=foldEffectiveQuotaDays(identity,[value],[day]);
  if(!folded||folded.status!=='complete')throw new Error('SYNTHETIC_QUOTA_INCOMPLETE');
  return {identity:folded.identity,planAnchors:folded.planAnchors,quotaRows:folded.quotaRows};
}
async function compare(rows:UsageRow[],pageSize=2){
  const quotaAcquisition=await acquisition(),features=await Promise.all(rows.map(value=>prepareV11UsageFeature(value,owner)));
  const after=(at:string,id:string)=>rows.findIndex(value=>value.observed_at>at||value.observed_at===at&&value.occurrence_id>id);
  const preparedUsageReader:V11PreparedUsageReader={days:[day],async readPage({afterTime,afterOccurrence}){
    const offset=after(afterTime,afterOccurrence);
    return {state:'ready',rows:offset<0?[]:features.slice(offset,offset+pageSize),complete:offset<0||offset+pageSize>=rows.length};
  }};
  const effectiveUsageReader={days:[day],async readPage({afterTime,afterOccurrence}:{afterTime:string;afterOccurrence:string}){
    const offset=after(afterTime,afterOccurrence);
    return {rows:offset<0?[]:rows.slice(offset,offset+pageSize),complete:offset<0||offset+pageSize>=rows.length};
  }};
  const common={quotaAcquisition,nowMs:Date.parse(modelHistoryWindow(day).fixedNow),scalarRequested:true};
  let native=null,prepared=null;
  for(let attempt=0;attempt<20;attempt++){
    native=await advanceV11UsageReduction(db,pin,{...common,effectiveUsageReader},
      {remainingQueries:10,deadlineMs:1,now:()=>0},native,1);
    prepared=await advanceV11UsageReduction(db,pin,{...common,preparedUsageReader},
      {remainingQueries:10,deadlineMs:1,now:()=>0},prepared,1);
    expect(prepared.complete).toBe(native.complete);
    expect(prepared.rowsRead).toBe(native.rowsRead);
    if(native.complete)break;
  }
  expect(native?.complete).toBe(true);expect(prepared?.complete).toBe(true);
  const outcomes=[];
  for(const metric of ['fits','model'] as const){
    const expected=await finishV11UsageReduction(db,pin,common,native!,metric);
    const actual=await finishV11UsageReduction(db,pin,common,prepared!,metric);
    expect(actual).toEqual(expected);outcomes.push(actual);
  }
  expect(JSON.stringify(features)).not.toContain('synthetic-private-session');
  expect(JSON.stringify(prepared)).not.toContain('synthetic-private-session');
  return {features,prepared,outcomes};
}

describe('durable ordered priced usage features',()=>{
  it('matches nonempty scalar and model finishers over repeated durable pages',async()=>{
    const {outcomes}=await compare(Array.from({length:8},(_,index)=>row(index)));
    expect(JSON.stringify(outcomes)).toContain('ready');
  });
  it('preserves account breaks, equal timestamps, partial pricing and unknown models',async()=>{
    const rows=Array.from({length:8},(_,index)=>row(index));
    const changed=JSON.parse(rows[3]!.record_json);
    changed.accountPlanAttribution.accountTrackId=`account-track:v2:${'d'.repeat(64)}`;
    rows[3]!.record_json=JSON.stringify(changed);
    const unpriced=JSON.parse(rows[4]!.record_json);unpriced.model='synthetic-unknown-model';rows[4]!.record_json=JSON.stringify(unpriced);
    const partial=JSON.parse(rows[5]!.record_json);partial.components.inputUncachedTokens=null;rows[5]!.record_json=JSON.stringify(partial);
    rows[2]!.observed_at=rows[1]!.observed_at;
    const sameTime=JSON.parse(rows[2]!.record_json);sameTime.eventTime=rows[2]!.observed_at;rows[2]!.record_json=JSON.stringify(sameTime);
    await compare(rows,1);
  });
  it('rejects leaked fields, invalid attribution keys and corrupt feature values',async()=>{
    const feature=await prepareV11UsageFeature(row(0),owner);
    expect(validV11UsageFeature(feature)).toBe(true);
    expect(validV11UsageFeature({...feature,record_json:'private'})).toBe(false);
    expect(validV11UsageFeature({...feature,sessionDigest:'raw-session'})).toBe(false);
    expect(validV11UsageFeature({...feature,accountScopeId:'raw-account'})).toBe(false);
    expect(validV11UsageFeature({...feature,costNanousd:-1})).toBe(false);
    expect(validV11UsageFeature({...feature,refusalReason:'unexpected'})).toBe(false);
    const other=await prepareV11UsageFeature(row(0),'e'.repeat(64));
    expect(other.sessionDigest).not.toBe(feature.sessionDigest);
  });
  it('defers a feature page without advancing its durable usage cursor',async()=>{
    const quotaAcquisition=await acquisition();
    const checkpoint=await advanceV11UsageReduction(db,pin,{quotaAcquisition,
      preparedUsageReader:{days:[day],async readPage(){return {state:'deferred'};}}},
    {remainingQueries:10,deadlineMs:1,now:()=>0},null,1);
    expect(checkpoint.complete).toBe(false);expect(checkpoint.rowsRead).toBe(0);
    expect(checkpoint.dayIndex).toBe(0);expect(checkpoint.previous).toEqual([]);
  });
});
