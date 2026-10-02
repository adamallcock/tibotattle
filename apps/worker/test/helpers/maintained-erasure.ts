import {canonicalTelemetryV11Json} from '@app-usagemonitor/telemetry-contract';
import {canonicalOccurrenceKey,normalizeNativeEffectiveOccurrence,type CanonicalFact} from '../../src/canonical-analytics-facts';
import {materializeCanonicalPage,materializeCanonicalPartition} from '../../src/storage-canonical-analytics-facts';
import {materializeCanonicalFeaturePartition} from '../../src/storage-canonical-feature-contributions';
import {materializeCanonicalCachePartition,repairCanonicalCacheNeighbors,prepareCanonicalCacheWindows,readCanonicalCacheDay} from '../../src/storage-canonical-cache-pairs';
import {advanceCanonicalRollingSegment,sealCanonicalRollingWindow} from '../../src/storage-canonical-rolling-inputs';
import {replaceCanonicalPublicationPart,beginCanonicalPublicationClosure,appendCanonicalPublicationExpected,
 sealCanonicalPublicationExpected,completeCanonicalPublicationExpected} from '../../src/storage-canonical-publication';
import {sha256Hex} from '../../src/crypto';
import {v11UsageRecord} from './telemetry-v11';
const budget={remainingQueries:()=>950,now:()=>0,deadlineMs:60_000},current=async()=>true;
const unknown={presence:'unknown' as const,value:null};
interface Scope {sourceId:string;sourceNamespace:string;ownerDigest:string;day:string}
/** Closed synthetic facts exercise lifecycle independently of acquisition parity.
 * Real source/owner admission and erasure are owned by the calling fixture. */
export async function seedMaintainedErasureFacts(db:D1Database,input:Scope,prefix?:string):Promise<CanonicalFact[]> {
 const scope={sourceNamespace:input.sourceNamespace,ownerDigest:input.ownerDigest,selectionMethod:'effective-union-v1' as const};
 const owner=await db.prepare('SELECT revision,authority_epoch FROM analytics_owner_state WHERE source_id=? AND owner_digest=?')
  .bind(input.sourceId,input.ownerDigest).first<{revision:number;authority_epoch:number}>();if(!owner)throw Error('synthetic owner missing');
 let first='';for(let n=0;n<4096;n++){
  const id='event:v2:'+n.toString(16).padStart(64,'0');
  if(!prefix||(await canonicalOccurrenceKey(scope,'usage',id)).startsWith(prefix)){first=id;break;}
 }if(!first)throw Error('synthetic mixed partition missing');
 const facts:CanonicalFact[]=[];
 for(let n=0;n<3;n++){
  const stream=n===2?'session':'usage',time=input.day+`T12:0${n*2}:00.000Z`;
  const usage=v11UsageRecord(input.day,'a',{eventId:n===0?first:'event:v2:'+await sha256Hex(input.ownerDigest+':later'),eventTime:time});
  const record=n===2?{schemaVersion:'session-dimension-v1.1',sessionUuid:usage.sessionUuid,firstEventTime:time,provider:usage.provider,toolClassCounts:{shell:1}}:usage;
  facts.push(await normalizeNativeEffectiveOccurrence(scope,{methodVersion:'effective-telemetry-owner-day-v1',stream,
   participantId:'synthetic-private-fixture',ownerDigest:input.ownerDigest,occurrenceId:n===2?usage.sessionUuid:usage.eventId,
   eventTime:time,eventTimeConflict:false,status:'compatible',sourceCount:1,sourceFormats:['v11'],sourceRowIds:[],sourceRecordKeys:[],
   recordJson:canonicalTelemetryV11Json(record),canonicalEvidence:{linkedDays:[input.day],variants:[{coordinate:'synthetic:'+n,format:'v11',observedAtMs:Date.parse(time)}],
    boundaryFlags:unknown,tieOrder:unknown,cacheWriteFiveMinuteTokens:unknown,cacheWriteOneHourTokens:unknown}},n));
 }
 await materializeCanonicalPage({db,sourceId:input.sourceId,scope,ownerRevision:owner.revision,authorityEpoch:owner.authority_epoch,
  pageKey:await sha256Hex(input.ownerDigest+':page'),sourceRevision:await sha256Hex(input.ownerDigest+':source'),stillCurrent:current,
  load:async()=>facts.map(fact=>({occurrenceKey:fact.occurrenceKey,stream:fact.stream,expectedRevision:null,fact}))});
 return facts;
}
export async function prepareMaintainedErasurePartitions(db:D1Database,sourceId:string,facts:readonly CanonicalFact[]) {
 const features=[];
 for(const partitionKey of new Set(facts.map(f=>f.location.partitionKey))){
  await materializeCanonicalPartition(db,partitionKey);
  const feature=await materializeCanonicalFeaturePartition({target:db,partitionKey,budget,stillCurrent:current,
   membership:async fact=>({method:'contributing-devices-by-reader-v1',dependencyRevision:'c'.repeat(64),
    contributorKey:fact.provenance.erasureKey,deviceKeys:[await sha256Hex(fact.provenance.erasureKey+':device')]})});
  if(feature.state!=='complete')throw Error('synthetic feature '+feature.reason);features.push(feature);
  if(feature.facts[0]?.stream==='usage')await materializeCanonicalCachePartition({target:db,partitionKey,budget,stillCurrent:current});
  const part=await replaceCanonicalPublicationPart(db,{sourceId,feature,expectedRevision:null,nowMs:0,stillCurrent:current});
  if(part.state!=='complete')throw Error('synthetic publication '+part.reason);
  const closure=await beginCanonicalPublicationClosure(db,{sourceId,day:partitionKey.split('/')[2]!,family:'activity',watermark:features.length,
   authorityDigest:'d'.repeat(64),expectedCount:1,nowMs:0});
  await appendCanonicalPublicationExpected(db,closure,[{partitionKey,contentRevision:feature.manifest.contentRevision}]);
  await sealCanonicalPublicationExpected(db,closure);
  await completeCanonicalPublicationExpected(db,{closureKey:closure,partitionKey,partRevision:part.part.revision,outcome:'changed'});
 }
 for(let n=0;n<24;n++)if(await repairCanonicalCacheNeighbors({target:db,budget,stillCurrent:current}))return features;
 throw Error('synthetic cache repair bound');
}
export async function seedMaintainedErasureOwnerMetadata(db:D1Database,input:Scope,facts:readonly CanonicalFact[]) {
 const {sourceId,ownerDigest,day}=input,hash=(label:string)=>sha256Hex(ownerDigest+':'+label),usage=facts.filter(f=>f.stream==='usage');
 const owner=(await db.prepare('SELECT revision,authority_epoch FROM analytics_owner_state WHERE source_id=? AND owner_digest=?')
  .bind(sourceId,ownerDigest).first<{revision:number;authority_epoch:number}>())!;
 const scopeKey=await hash('input'),sourceStamp=await hash('stamp');
 await db.prepare(`INSERT INTO analytics_canonical_input_work(scope_key,source_id,owner_digest,selection_method,stream,source_day,
  source_stamp,owner_revision,authority_epoch,state,seen_count) VALUES(?,?,?,'effective-union-v1','usage',?,?,?,?,'draining',?)`)
  .bind(scopeKey,sourceId,ownerDigest,day,sourceStamp,owner.revision,owner.authority_epoch,usage.length).run();
 for(const fact of usage)await db.prepare('INSERT INTO analytics_canonical_input_seen VALUES(?,?)').bind(scopeKey,fact.occurrenceKey).run();
 await db.prepare("UPDATE analytics_canonical_input_work SET state='sealed' WHERE scope_key=?").bind(scopeKey).run();
 const seal={scopeKey,sourceStamp,ownerRevision:owner.revision,authorityEpoch:owner.authority_epoch,day,stream:'usage' as const,seenCount:usage.length,empty:false};
 let segment=await advanceCanonicalRollingSegment({target:db,sourceId,ownerDigest,selectionMethod:'effective-union-v1',seal,budget,stillCurrent:current});
 for(let n=0;n<4&&segment.state==='progress';n++)segment=await advanceCanonicalRollingSegment({target:db,sourceId,ownerDigest,selectionMethod:'effective-union-v1',seal,budget,stillCurrent:current});
 if(segment.state!=='complete')throw Error('synthetic rolling '+segment.state);
 await sealCanonicalRollingWindow(db,{sourceId,ownerDigest,kind:'effective-model',fromMs:Date.parse(day),throughMs:Date.parse(day)+86400000,
  nativeDependency:await hash('rolling-dependency'),segments:[segment.segment]},current);
 const pendingKey=await hash('pending');
 await db.prepare(`INSERT INTO analytics_canonical_input_work(scope_key,source_id,owner_digest,selection_method,stream,source_day,
  source_stamp,owner_revision,authority_epoch,state) VALUES(?,?,?,'effective-union-v1','quota',?,?,?,?,'reading')`)
  .bind(pendingKey,sourceId,ownerDigest,day,sourceStamp,owner.revision,owner.authority_epoch).run();
 await db.prepare(`INSERT INTO analytics_canonical_input_pending(scope_key,source_stamp,page_key,source_revision,next_key,next_ms,next_tie_rank,seen_keys_json,terminal)
  VALUES(?,?,?,?,NULL,NULL,0,'[]',1)`).bind(pendingKey,sourceStamp,await hash('pending-page'),sourceStamp).run();
 await db.prepare(`INSERT INTO analytics_shared_preparation_ranges(source_id,owner_digest,history_from_day,history_through_day,
  history_next_day,recent_next_day,revision,updated_ms) VALUES(?,?,?,?,?,?,1,0)`).bind(sourceId,ownerDigest,day,day,day,day).run();
 await db.prepare(`INSERT INTO analytics_effective_dependency_summaries(scope_key,source_id,source_namespace,owner_digest,from_day,through_day,
  include_sessions,mutation_stamp,dependency_digest,owner_revision,authority_epoch,updated_ms,valid_until_ms) VALUES(?,?,?,?,?,?,1,?,?,?,?,0,1)`)
  .bind(await hash('summary'),sourceId,input.sourceNamespace,ownerDigest,day,day,sourceStamp,await hash('dependency'),owner.revision,owner.authority_epoch).run();
 await db.prepare('INSERT INTO analytics_partition_subject_schedule VALUES(?,?,0)').bind(sourceId,ownerDigest).run();
 await db.prepare(`INSERT INTO analytics_partition_ranges(effect_key,source_id,owner_digest,from_day,through_day,next_day,stream,selection_method,
  source_stamp,lane,updated_ms) VALUES(?,?,?,?,?,?,'usage','effective-union-v1',1,'recovery',0)`)
  .bind(await hash('range'),sourceId,ownerDigest,day,day,day).run();
 const cacheScope={sourceId,ownerDigest,selectionMethod:'effective-union-v1' as const};
 const cache=await readCanonicalCacheDay({target:db,scope:cacheScope,day,stillCurrent:current});
 await prepareCanonicalCacheWindows(db,cacheScope,day);
 return {cache,scopeKey};
}
