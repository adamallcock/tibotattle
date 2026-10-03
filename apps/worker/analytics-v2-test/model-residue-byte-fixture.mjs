/** Private deterministic byte-bound fixture. No database or stored raw data.
 * This proves only MODEL-RESIDUE refusal parity, not L2 refusal inclusion. */
import { createHash } from 'node:crypto';
export const residueDay = '2026-09-28';
export const residueStart = Date.parse(residueDay);
export const residueOwner = 'a'.repeat(64);
export const residueAttribution = { accountBasis: 'same_source', accountTrackId: 'account-track:v2:' + 'b'.repeat(64),
  planBasis: 'same_source_occurrence', planType: 'pro', planEraId: null };
export const residuePin = { source:'v1.1', participantId:'synthetic-byte-owner', generationId:'synthetic-byte-generation',
  fromDay:residueDay, throughDay:residueDay, inputRevision:1, mutationEpoch:1, fingerprint:'c'.repeat(64) };
export const residueNow = residueStart + 86400000 - 1;
const noRead = () => { throw new Error('SYNTHETIC_UNEXPECTED_DATABASE_READ'); };
export const residueDb = {prepare:noRead,batch:noRead,exec:noRead,withSession:noRead,dump:noRead};
export function residueUsage(index, { sessions = true, sessionModulo = Number.MAX_SAFE_INTEGER } = {}) {
  const record = { schemaVersion:'usage-event-v1.1',eventId:'event:synthetic:' + index.toString().padStart(8,'0'),
    eventTime:new Date(residueStart + 1000 + index).toISOString(), sessionUuid:sessions ? (index % sessionModulo).toString(16).padStart(64,'0') : 'synthetic-shared-session',
    provider:'openai_codex',modelId:'gpt-5.4',speedMode:'standard',apiServiceTier:'default',
    surface:'local_interactive_unclassified',billingSurface:'chatgpt_subscription',reasoningEffort:'high',agentScope:'root',outcome:'completed',
    totalInputContextTokens:1000,components:{inputUncachedTokens:100,inputCacheReadTokens:900,inputCacheWriteTokens:0,outputTextTokens:50,outputReasoningTokens:25,outputCombinedTokens:null},
    accountPlanAttribution:residueAttribution };
  return {occurrence_id:record.eventId,observed_at:record.eventTime,provider:record.provider,session_uuid:record.sessionUuid,record_json:JSON.stringify(record)};
}
export function residueAcquisition(module) {
  const mapped = Array.from({length:9}, (_,index) => {
    const record = {schemaVersion:'quota-observation-v1.1',observationId:'quota:synthetic:' + index,
      observedTime:new Date(residueStart + index * 3_600_000).toISOString(),provider:'openai_codex',planType:'pro',planVariant:'unknown',
      limitId:'codex',slot:'seven_day',usedPercent:5+index*10,windowDurationMinutes:10080,
      resetsAt:new Date(residueStart+8*86400000).toISOString(),accountPlanAttribution:residueAttribution};
    return module.mapEffectiveQuotaPageRow({stream:'quota',status:'compatible',recordJson:JSON.stringify(record),eventTime:record.observedTime},residueDay,index+1);
  });
  const pending=module.appendEffectiveQuotaDay(null,residueDay,mapped,10080);
  const day= pending && module.finishEffectiveQuotaDay(pending);
  const identity=module.createV11QuotaAcquisitionIdentity(residuePin,residueNow);
  const folded=day && module.foldEffectiveQuotaDays(identity,[day],[residueDay]);
  if (!folded || folded.status !== 'complete') throw new Error('SYNTHETIC_QUOTA_INCOMPLETE');
  return {identity:folded.identity,planAnchors:folded.planAnchors,quotaRows:folded.quotaRows};
}
/** Cursor lookup is arithmetic; 200-row pages preserve the production bound.
 * Prepared keys are exactly feature:<64 hex>, without sharing a L2 generator. */
export async function residueOptions(module, count, { prepared=false, scalarRequested=true, sessions=true, sessionModulo=Number.MAX_SAFE_INTEGER, featureCost, limit }={}) {
  const feature = prepared ? await module.prepareV11UsageFeature(residueUsage(0),residueOwner) : null;
  const reader = {days:[residueDay],async readPage({afterOccurrence}) {
    const offset=afterOccurrence === '' ? 0 : Number(afterOccurrence.slice('event:synthetic:'.length))+1;
    const end=Math.min(count,offset+200),rows=[];
    for(let index=offset;index<end;index++) {
      if(prepared) rows.push({...feature,occurrenceId:'event:synthetic:'+index.toString().padStart(8,'0'),
        observedAtMs:residueStart+1000+index,...(featureCost === undefined ? {} : {costNanousd:featureCost}),sessionDigest:sessions ? (index % sessionModulo).toString(16).padStart(64,'0') : feature.sessionDigest});
      else rows.push(residueUsage(index,{sessions,sessionModulo}));
    }
    return prepared ? {state:'ready',rows,complete:end>=count} : {rows,complete:end>=count};
  }};
  return {nowMs:residueNow,quotaAcquisition:residueAcquisition(module),scalarRequested,
    ...(limit===undefined ? {} : {maxUsageCheckpointBytes:limit}),
    ...(prepared ? {preparedUsageReader:reader} : {effectiveUsageReader:reader})};
}
export async function residueReduce(module,count, config={}) {
  const options=await residueOptions(module,count,config);let state=null,calls=0;
  const checkpoints=[];
  while(!state?.complete && calls<Math.ceil(count/200)+3) {
    const pages=config.maxPages ?? 3;
    state=await module.advanceV11UsageReduction(residueDb,residuePin,options,
      {remainingQueries:pages+1,deadlineMs:Number.MAX_SAFE_INTEGER,now:()=>0},state,pages);
    checkpoints.push(createHash('sha256').update(JSON.stringify(state)).digest('hex'));calls++;
  }
  if(!state?.complete) throw new Error('SYNTHETIC_REDUCTION_INCOMPLETE');
  return {state,checkpoints,calls};
}
