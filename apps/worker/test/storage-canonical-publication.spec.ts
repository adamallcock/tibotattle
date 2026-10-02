import {applyD1Migrations,env,reset,type D1Migration} from 'cloudflare:test';
import {beforeEach,expect,it,vi} from 'vitest';
import {canonicalTelemetryV11Json} from '@app-usagemonitor/telemetry-contract';
import {v11UsageRecord} from './helpers/telemetry-v11';
import {normalizeNativeEffectiveOccurrence,type CanonicalScope,type CanonicalFact} from '../src/canonical-analytics-facts';
import {materializeCanonicalPage,materializeCanonicalPartition} from '../src/storage-canonical-analytics-facts';
import {materializeCanonicalFeaturePartition} from '../src/storage-canonical-feature-contributions';
import {sha256Hex} from '../src/crypto';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {admitAnalyticsPartitionWork,claimAnalyticsPartitionWork,type AnalyticsWorkRequest} from '../src/storage-analytics-partition-work';
import {advanceAnalyticsPublicationWork} from '../src/storage-analytics-publication-work';
import {createCanonicalSharedFeaturePreparation} from '../src/storage-analytics-canonical-day';
import {createV11DailyProjectionValues,foldV11DailyProjectionValues} from '../src/v11-daily-projection-values';
import {canonicalPublicationAvailable,replaceCanonicalPublicationPart,beginCanonicalPublicationClosure,
 appendCanonicalPublicationExpected,sealCanonicalPublicationExpected,completeCanonicalPublicationExpected,
 readCanonicalPublicationClosure,commitCanonicalPublicationClosure,retireCanonicalPublicationPage} from '../src/storage-canonical-publication';
const bindings=env as Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const db=()=>bindings.STORAGE_ANALYTICS_DB,sourceId='synthetic-publication',day='2026-09-20';
const scope:CanonicalScope={sourceNamespace:sourceId,ownerDigest:'a'.repeat(64),selectionMethod:'effective-union-v1'};
const unknown={presence:'unknown' as const,value:null};
const membership={method:'contributing-devices-by-reader-v1',dependencyRevision:'c'.repeat(64),
 contributorKey:'d'.repeat(64),deviceKeys:['e'.repeat(64),'f'.repeat(64)]};
const budget={remainingQueries:()=>950,now:()=>0,deadlineMs:60_000};
async function fact(fill='a',overrides:Record<string,unknown>={}):Promise<CanonicalFact>{
 const record={...v11UsageRecord(day,fill),...overrides};
 return normalizeNativeEffectiveOccurrence(scope,{methodVersion:'effective-telemetry-owner-day-v1',stream:'usage',participantId:'synthetic-private',
 ownerDigest:scope.ownerDigest,occurrenceId:record.eventId,eventTime:record.eventTime,eventTimeConflict:false,status:'compatible',
 sourceCount:1,sourceFormats:['v11'],sourceRowIds:[],sourceRecordKeys:[],recordJson:canonicalTelemetryV11Json(record),
 canonicalEvidence:{linkedDays:[day],variants:[{coordinate:'synthetic-variant:'+fill,format:'v11',observedAtMs:Date.parse(record.eventTime)}],
 boundaryFlags:unknown,tieOrder:unknown,cacheWriteFiveMinuteTokens:unknown,cacheWriteOneHourTokens:unknown}},0);
}
async function install(value:CanonicalFact,stamp:string,previous:string|null=null){
 await materializeCanonicalPage({db:db(),sourceId,scope,ownerRevision:1,authorityEpoch:1,pageKey:await sha256Hex('page:'+stamp),
 sourceRevision:await sha256Hex(stamp),stillCurrent:async()=>true,load:async()=>[
 {occurrenceKey:value.occurrenceKey,stream:value.stream,expectedRevision:previous,fact:value}]});
 await materializeCanonicalPartition(db(),value.location.partitionKey);
 const feature=await materializeCanonicalFeaturePartition({target:db(),partitionKey:value.location.partitionKey,budget,
 stillCurrent:async()=>true,membership:async()=>membership});
 if(feature.state!=='complete')throw Error(feature.reason);return feature;
}
async function begin(expectedCount:number,watermark=1){return beginCanonicalPublicationClosure(db(),{sourceId,day,family:'activity',watermark,
 authorityDigest:'b'.repeat(64),expectedCount,nowMs:0});}
beforeEach(async()=>{
 await reset();await applyD1Migrations(db(),bindings.TEST_ANALYTICS_MIGRATIONS);
 await db().prepare('INSERT INTO analytics_runtime_sources(source_id,source_namespace,contract_version) VALUES(?,?,1)').bind(sourceId,sourceId).run();
 await db().prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')")
 .bind(sourceId,scope.ownerDigest).run();
});
it('rechecks a required publication trigger after a positive hint and accepts its exact restoration',async()=>{
 const trigger='analytics_canonical_publication_part_admit';
 const ddl=await db().prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?')
  .bind('trigger',trigger).first<string>('sql');
 expect(typeof ddl).toBe('string');
 const meter=createD1InvocationBudget(20),scoped=meter.wrap(db());
 expect(await canonicalPublicationAvailable(scoped)).toBe(true);
 expect(await canonicalPublicationAvailable(scoped)).toBe(true);
 expect(meter.queriesUsed).toBe(2);
 await db().prepare(`DROP TRIGGER ${trigger}`).run();
 expect(await canonicalPublicationAvailable(scoped)).toBe(false);
 expect(meter.queriesUsed).toBe(4); // stale rowid, then full exact inventory
 const nowMs=Date.now(),request:AnalyticsWorkRequest={sourceId,ownerDigest:null,stage:'publication',lane:'new',
  partitionKey:'activity/'+day,headKey:'b'.repeat(64),inputRevision:'c'.repeat(64),policyRevision:'d'.repeat(64),
  day,stream:null,selectionMethod:null,residentBytes:1024*1024,admissionQueries:100};
 await admitAnalyticsPartitionWork(db(),[request],nowMs);
 const [lease]=await claimAnalyticsPartitionWork(db(),{sourceId,limit:1,nowMs});
 expect(lease).toBeDefined();
 const workMeter=createD1InvocationBudget(950);
 expect(await advanceAnalyticsPublicationWork({target:db(),sources:[],lease:lease!,
  budget:{meter:workMeter,now:Date.now,deadlineMs:Date.now()+30_000,remainingQueries:()=>workMeter.remainingQueries},
  canonicalPreparation:createCanonicalSharedFeaturePreparation})).toMatchObject({outcome:'refused',reason:'migration_required'});
 expect(await canonicalPublicationAvailable(scoped)).toBe(false);
 expect(meter.queriesUsed).toBe(5); // absence is never cached
 await db().prepare(ddl!).run();
 expect(await canonicalPublicationAvailable(scoped)).toBe(true);
 expect(await canonicalPublicationAvailable(scoped)).toBe(true);
 expect(meter.queriesUsed).toBe(7);
},120_000);
it('replaces complete native values and exact memberships idempotently, preserving maximum candidates',async()=>{
 expect(await canonicalPublicationAvailable(db())).toBe(true);
 const firstFact=await fact(),first=await install(firstFact,'first');
 const result=await replaceCanonicalPublicationPart(db(),{sourceId,feature:first,expectedRevision:null,nowMs:0,stillCurrent:async()=>true});
 if(result.state!=='complete')throw Error(result.reason);
 expect(result.part.value.daily).toEqual(foldV11DailyProjectionValues(createV11DailyProjectionValues(day),[v11UsageRecord(day,'a')]));
 expect(result.part.value).toMatchObject({contributingParticipants:1,contributingDevices:2,
 lastTimeCandidates:[{factRevision:firstFact.revision,observedAtMs:firstFact.location.observedAtMs}]});
 expect(await replaceCanonicalPublicationPart(db(),{sourceId,feature:first,expectedRevision:null,nowMs:1,stillCurrent:async()=>true}))
 .toMatchObject({state:'complete',reused:true,part:result.part});
 const correctedFact=await fact('a',{modelId:'synthetic-unpriced'}),corrected=await install(correctedFact,'second',firstFact.revision);
 const replacement=await replaceCanonicalPublicationPart(db(),{sourceId,feature:corrected,expectedRevision:result.part.revision,nowMs:2,stillCurrent:async()=>true});
 if(replacement.state!=='complete')throw Error(replacement.reason);
 expect(replacement.part.value.daily.counts.usage).toBe(1);
 expect(replacement.part.value.members.every(row=>row.references===1)).toBe(true);
 expect(await replaceCanonicalPublicationPart(db(),{sourceId,feature:corrected,expectedRevision:null,nowMs:3,stillCurrent:async()=>true}))
 .toEqual({state:'deferred',reason:'head_changed'});
 expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_publication_part_heads').first<number>('n')).toBe(1);
 expect(await retireCanonicalPublicationPage(db(),{sourceId,beforeMs:3})).toBe(5);
 expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_publication_parts').first<number>('n')).toBe(1);
});
it('accepts a lost batch response only with the exact committed replacement receipt',async()=>{
 const feature=await install(await fact(),'lost');
 const original=db().batch.bind(db()),spy=vi.spyOn(db(),'batch').mockImplementationOnce(async statements=>{
 await original(statements);throw Error('synthetic lost response');});
 const result=await replaceCanonicalPublicationPart(db(),{sourceId,feature,expectedRevision:null,nowMs:0,stillCurrent:async()=>true});
 spy.mockRestore();expect(result.state).toBe('complete');
 expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_publication_replacements').first<number>('n')).toBe(1);
});
it('requires sealed exact expectations, recognizes unchanged, and refuses dirty manifest closure',async()=>{
 const feature=await install(await fact(),'closure');
 const part=await replaceCanonicalPublicationPart(db(),{sourceId,feature,expectedRevision:null,nowMs:0,stillCurrent:async()=>true});
 if(part.state!=='complete')throw Error(part.reason);
 const closure=await begin(1),expected={partitionKey:feature.manifest.partitionKey,contentRevision:feature.manifest.contentRevision};
 expect(await sealCanonicalPublicationExpected(db(),closure)).toBe(false);
 await appendCanonicalPublicationExpected(db(),closure,[expected]);await appendCanonicalPublicationExpected(db(),closure,[expected]);
 expect(await readCanonicalPublicationClosure(db(),closure)).toMatchObject({state:'capturing',expected:1,completed:0});
 expect(await commitCanonicalPublicationClosure(db(),closure)).toBe(false);
 expect(await sealCanonicalPublicationExpected(db(),closure)).toBe(true);
 expect(await commitCanonicalPublicationClosure(db(),closure)).toBe(false);
 expect(await completeCanonicalPublicationExpected(db(),{closureKey:closure,partitionKey:expected.partitionKey,partRevision:part.part.revision,outcome:'unchanged'})).toBe(true);
 expect(await commitCanonicalPublicationClosure(db(),closure)).toBe(true);
 expect(await readCanonicalPublicationClosure(db(),closure)).toMatchObject({state:'complete',expected:1,completed:1,watermark:1});
 await db().prepare('UPDATE analytics_canonical_dirty_partitions SET generation=generation+1 WHERE partition_key=?').bind(expected.partitionKey).run();
 expect(await commitCanonicalPublicationClosure(db(),closure)).toBe(false);
});
it('closes explicit first empty partitions and empty populations without truncating expectations',async()=>{
 const partitionKey='effective-union-v1/usage/'+day+'/00';await materializeCanonicalPartition(db(),partitionKey);
 const feature=await materializeCanonicalFeaturePartition({target:db(),partitionKey,budget,stillCurrent:async()=>true});
 if(feature.state!=='complete')throw Error(feature.reason);
 const part=await replaceCanonicalPublicationPart(db(),{sourceId,feature,expectedRevision:null,nowMs:0,stillCurrent:async()=>true});
 if(part.state!=='complete')throw Error(part.reason);
 expect(part.part.value).toMatchObject({contributingParticipants:0,contributingDevices:0,lastObservedAtMs:null,lastTimeCandidates:[]});
 const closure=await begin(1);await appendCanonicalPublicationExpected(db(),closure,[{partitionKey,contentRevision:feature.manifest.contentRevision}]);
 expect(await sealCanonicalPublicationExpected(db(),closure)).toBe(true);
 expect(await completeCanonicalPublicationExpected(db(),{closureKey:closure,partitionKey,partRevision:part.part.revision,outcome:'empty'})).toBe(true);
 expect(await commitCanonicalPublicationClosure(db(),closure)).toBe(true);
 const nobody=await begin(0,2);expect(await sealCanonicalPublicationExpected(db(),nobody)).toBe(true);
 expect(await commitCanonicalPublicationClosure(db(),nobody)).toBe(true);
 await expect(appendCanonicalPublicationExpected(db(),nobody,Array.from({length:129},(_,index)=>({partitionKey:'synthetic/'+index,contentRevision:'b'.repeat(64)})))).rejects.toThrow();
});
it('purges subject-bearing state on withdrawal and fences an intervening terminal',async()=>{
 const feature=await install(await fact(),'terminal');
 const part=await replaceCanonicalPublicationPart(db(),{sourceId,feature,expectedRevision:null,nowMs:0,stillCurrent:async()=>true});
 if(part.state!=='complete')throw Error(part.reason);
 const closure=await begin(1);await appendCanonicalPublicationExpected(db(),closure,[{partitionKey:feature.manifest.partitionKey,contentRevision:feature.manifest.contentRevision}]);
 await sealCanonicalPublicationExpected(db(),closure);
 await completeCanonicalPublicationExpected(db(),{closureKey:closure,partitionKey:feature.manifest.partitionKey,partRevision:part.part.revision,outcome:'changed'});
 await db().prepare("UPDATE analytics_owner_state SET state='erased',revision=2,authority_epoch=2 WHERE source_id=? AND owner_digest=?").bind(sourceId,scope.ownerDigest).run();
 expect(await readCanonicalPublicationClosure(db(),closure)).toBeNull();
 for(const table of ['analytics_canonical_publication_parts','analytics_canonical_publication_part_facts','analytics_canonical_publication_part_heads','analytics_canonical_publication_replacements','analytics_canonical_publication_subjects'])
 expect(await db().prepare('SELECT count(*) n FROM '+table).first<number>('n')).toBe(0);
 expect(await replaceCanonicalPublicationPart(db(),{sourceId,feature,expectedRevision:null,nowMs:1,stillCurrent:async()=>true}))
 .toEqual({state:'deferred',reason:'authority_changed'});
});


it('drains obsolete part links before atomically removing its payload and subject provenance',async()=>{
 const feature=await install(await fact(),'retirement-provenance');
 const saved=await replaceCanonicalPublicationPart(db(),{sourceId,feature,expectedRevision:null,nowMs:0,stillCurrent:async()=>true});
 if(saved.state!=='complete')throw Error(saved.reason);const revision=saved.part.revision;
 await db().prepare(`WITH RECURSIVE seq(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<127)
  INSERT INTO analytics_owner_state SELECT ?,printf('%064x',n),1,1,'active' FROM seq`).bind(sourceId).run();
 await db().prepare(`INSERT INTO analytics_canonical_publication_part_subjects SELECT ?,source_id,owner_digest
  FROM analytics_owner_state WHERE source_id=? AND owner_digest!=?`).bind(revision,sourceId,scope.ownerDigest).run();
 await db().prepare('DELETE FROM analytics_canonical_publication_part_heads WHERE revision=?').bind(revision).run();
 await db().prepare(`WITH RECURSIVE seq(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<129)
  INSERT INTO analytics_canonical_publication_replacements(replacement_key,source_id,partition_key,new_revision,created_ms)
  SELECT printf('%064x',n),?, ?,?,0 FROM seq`).bind(sourceId,feature.manifest.partitionKey,revision).run();
 expect(await retireCanonicalPublicationPage(db(),{sourceId,beforeMs:1,limit:16})).toBe(128);
 expect(await db().prepare('SELECT 1 present FROM analytics_canonical_publication_parts WHERE revision=?').bind(revision).first()).not.toBeNull();
 expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_publication_part_subjects WHERE part_revision=?').bind(revision).first<number>('n')).toBe(128);
 expect(await retireCanonicalPublicationPage(db(),{sourceId,beforeMs:1,limit:16})).toBe(3);
 expect(await db().prepare('SELECT 1 present FROM analytics_canonical_publication_parts WHERE revision=?').bind(revision).first()).not.toBeNull();
 expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_publication_part_subjects WHERE part_revision=?').bind(revision).first<number>('n')).toBe(128);
 expect(await retireCanonicalPublicationPage(db(),{sourceId,beforeMs:1,limit:16})).toBe(129);
 expect(await db().prepare('SELECT 1 present FROM analytics_canonical_publication_parts WHERE revision=?').bind(revision).first()).toBeNull();
 expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});

it('preserves an unrelated same-subject complete closure when an unreferenced superseded fact retires',async()=>{
 const original=await fact(),previous=await install(original,'retirement-original');
 const currentFact=await fact('a',{modelId:'synthetic-unpriced'}),current=await install(currentFact,'retirement-current',original.revision);
 const part=await replaceCanonicalPublicationPart(db(),{sourceId,feature:current,expectedRevision:null,nowMs:0,stillCurrent:async()=>true});
 if(part.state!=='complete')throw Error(part.reason);
 const closure=await begin(1);
 await appendCanonicalPublicationExpected(db(),closure,[{partitionKey:current.manifest.partitionKey,contentRevision:current.manifest.contentRevision}]);
 await sealCanonicalPublicationExpected(db(),closure);
 await completeCanonicalPublicationExpected(db(),{closureKey:closure,partitionKey:current.manifest.partitionKey,partRevision:part.part.revision,outcome:'changed'});
 expect(await commitCanonicalPublicationClosure(db(),closure)).toBe(true);
 expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_publication_subjects WHERE closure_key=?').bind(closure).first<number>('n')).toBe(1);
 // Ordinary fact retirement requires all old payload/dependency links to be
 // drained. The current same-owner contribution has no reference to this fact.
 await db().prepare('DELETE FROM analytics_canonical_manifests WHERE content_revision=?').bind(previous.manifest.contentRevision).run();
 await db().prepare('DELETE FROM analytics_canonical_pages WHERE change_key IN(SELECT change_key FROM analytics_canonical_effects WHERE old_revision=? OR new_revision=?)')
 .bind(original.revision,original.revision).run();
 await db().prepare('DELETE FROM analytics_canonical_facts WHERE revision=?').bind(original.revision).run();
 expect(await readCanonicalPublicationClosure(db(),closure)).toMatchObject({state:'complete',completed:1});
 expect(await commitCanonicalPublicationClosure(db(),closure)).toBe(true);
 expect(await db().prepare('SELECT revision FROM analytics_canonical_publication_part_heads').first<string>('revision')).toBe(part.part.revision);
 // Exact terminal erasure still invalidates every closure carrying this subject.
 await db().prepare("UPDATE analytics_owner_state SET state='erased',revision=revision+1,authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?")
 .bind(sourceId,scope.ownerDigest).run();
 expect(await readCanonicalPublicationClosure(db(),closure)).toBeNull();
 expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});
