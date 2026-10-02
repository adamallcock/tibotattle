import { applyD1Migrations,env,reset,type D1Migration } from 'cloudflare:test';
import { beforeEach,describe,expect,it,vi } from 'vitest';
import { canonicalTelemetryV11Json } from '@app-usagemonitor/telemetry-contract';
import { v11UsageRecord } from './helpers/telemetry-v11';
import { normalizeNativeEffectiveOccurrence,normalizeSelectedTelemetryRecord,type CanonicalFact,type CanonicalScope } from '../src/canonical-analytics-facts';
import { materializeCanonicalPage,materializeCanonicalPartition } from '../src/storage-canonical-analytics-facts';
import { canonicalFeatureContributionsAvailable,materializeCanonicalFeaturePartition } from '../src/storage-canonical-feature-contributions';
import { CANONICAL_DAILY_PRICE_METHOD,CANONICAL_FIT_PRICE_METHOD,prepareCanonicalFeatureContribution,
  priceCanonicalFeatureContribution,foldCanonicalActivityContributions,validCanonicalFeatureContribution,
  type CanonicalActivityInput,type CanonicalActivityMembership } from '../src/canonical-feature-contributions';
import { createV11DailyProjectionValues,foldV11DailyProjectionValues,finalizeV11DailyProjectionValues } from '../src/v11-daily-projection-values';
import { priceChunkUsageRecordValue } from '../src/quota-analysis-v1';
import { sha256Hex } from '../src/crypto';
import {createAnalyticsProfile,profileAnalyticsDatabase} from './helpers/analytics-profile';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import type { EffectiveTelemetryOccurrence } from '../src/telemetry-usage-effective-reader';
const bindings=env as Env & {STORAGE_ANALYTICS_DB:D1Database;TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const db=()=>bindings.STORAGE_ANALYTICS_DB;
const sourceId='synthetic-features',day='2026-09-20';
const scope:CanonicalScope={sourceNamespace:sourceId,ownerDigest:'a'.repeat(64),selectionMethod:'effective-union-v1'};
const unknown={presence:'unknown' as const,value:null};
const membership:CanonicalActivityMembership={method:'contributing-devices-by-reader-v1',dependencyRevision:'c'.repeat(64),
 contributorKey:'d'.repeat(64),deviceKeys:['e'.repeat(64),'f'.repeat(64)]};
function source(fill='a',overrides:Record<string,unknown>={}):EffectiveTelemetryOccurrence {
 const record={...v11UsageRecord(day,fill),...overrides};
 return {methodVersion:'effective-telemetry-owner-day-v1',stream:'usage',participantId:'synthetic-private',
 ownerDigest:scope.ownerDigest,occurrenceId:record.eventId,eventTime:record.eventTime,eventTimeConflict:false,status:'compatible',
 sourceCount:1,sourceFormats:['v11'],sourceRowIds:[],sourceRecordKeys:[],recordJson:canonicalTelemetryV11Json(record),
 canonicalEvidence:{linkedDays:[record.eventTime.slice(0,10)],variants:[{coordinate:'synthetic-variant:'+fill,format:'v11',observedAtMs:Date.parse(record.eventTime)}],
 boundaryFlags:unknown,tieOrder:unknown,cacheWriteFiveMinuteTokens:unknown,cacheWriteOneHourTokens:unknown}};
}
const fact=(fill='a',overrides:Record<string,unknown>={})=>normalizeNativeEffectiveOccurrence(scope,source(fill,overrides),0);
async function install(value:CanonicalFact,stamp:string,previous:string|null=null){
 await materializeCanonicalPage({db:db(),sourceId,scope,ownerRevision:1,authorityEpoch:1,pageKey:await sha256Hex('page:'+stamp),
 sourceRevision:await sha256Hex(stamp),stillCurrent:async()=>true,load:async()=>[
 {occurrenceKey:value.occurrenceKey,stream:value.stream,expectedRevision:previous,fact:value}]});
 return materializeCanonicalPartition(db(),value.location.partitionKey);
}
const input=(partitionKey:string)=>({target:db(),partitionKey,budget:{remainingQueries:()=>950,now:()=>0,deadlineMs:60_000},
 stillCurrent:async()=>true,membership:async()=>membership});
beforeEach(async()=>{
 await reset();await applyD1Migrations(db(),bindings.TEST_ANALYTICS_MIGRATIONS);
 await db().prepare('INSERT INTO analytics_runtime_sources(source_id,source_namespace,contract_version) VALUES(?,?,1)').bind(sourceId,sourceId).run();
 await db().prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')")
 .bind(sourceId,scope.ownerDigest).run();
});
describe('canonical quantities, prices and exact activity',()=>{
 it('matches native daily arithmetic for full, sparse, all unknown, zero, context threshold and unknown-model evidence',async()=>{
  const records=[source('a'),source('b',{modelId:'synthetic-unpriced'}),source('c',{totalInputContextTokens:272001}),
   source('d',{components:{inputUncachedTokens:1,inputCacheReadTokens:null,inputCacheWriteTokens:0,outputTextTokens:1,outputReasoningTokens:null,outputCombinedTokens:null}}),
   source('e',{components:{inputUncachedTokens:null,inputCacheReadTokens:null,inputCacheWriteTokens:null,outputTextTokens:null,outputReasoningTokens:null,outputCombinedTokens:null}}),
   source('f',{components:{inputUncachedTokens:0,inputCacheReadTokens:0,inputCacheWriteTokens:0,outputTextTokens:0,outputReasoningTokens:0,outputCombinedTokens:null}})];
  let native=createV11DailyProjectionValues(day);const inputs:CanonicalActivityInput[]=[];
  for(const [rank,row]of records.entries()){
   native=foldV11DailyProjectionValues(native,[JSON.parse(row.recordJson!)]);
   const contribution=await prepareCanonicalFeatureContribution(await normalizeNativeEffectiveOccurrence(scope,row,rank));
   const dailyPrice=priceCanonicalFeatureContribution(contribution,CANONICAL_DAILY_PRICE_METHOD);
   const fitPrice=priceCanonicalFeatureContribution(contribution,CANONICAL_FIT_PRICE_METHOD);
   expect(fitPrice.value).toEqual(priceChunkUsageRecordValue(JSON.parse(row.recordJson!),row.eventTime!));
   inputs.push({contribution,dailyPrice,membership});
  }
  const reduced=foldCanonicalActivityContributions(day,'effective-union-v1',inputs);
  expect(reduced.daily).toEqual(native);
  expect(finalizeV11DailyProjectionValues(reduced.daily)).toEqual(finalizeV11DailyProjectionValues(native));
  expect(reduced.contributingParticipants).toBe(1);expect(reduced.contributingDevices).toBe(2);
  expect(reduced.members.filter(row=>row.role==='device').map(row=>row.references)).toEqual([6,6]);
  expect(foldCanonicalActivityContributions(day,'effective-union-v1',[...inputs,inputs[0]!])).toEqual(reduced);
  expect(foldCanonicalActivityContributions(day,'effective-union-v1',inputs.map(row=>({...row,membership:null}))))
   .toMatchObject({contributingParticipants:null,contributingDevices:null,membershipCoverage:'unknown'});
 });
 it('retains exact last-time candidates, rejects competing revisions and keeps selection modes distinct',async()=>{
  const old=await prepareCanonicalFeatureContribution(await fact());
  const later=await prepareCanonicalFeatureContribution(await fact('b',{eventTime:day+'T15:00:00.000Z'}));
  const fold=(values:typeof old[])=>foldCanonicalActivityContributions(day,'effective-union-v1',values.map(contribution=>
   ({contribution,dailyPrice:priceCanonicalFeatureContribution(contribution,CANONICAL_DAILY_PRICE_METHOD),membership})));
  expect(fold([old,later]).lastObservedAtMs).toBe(later.observedAtMs);
  expect(fold([old]).lastObservedAtMs).toBe(old.observedAtMs);
  const replacement=await prepareCanonicalFeatureContribution(await fact('a',{modelId:'gpt-5.6-cyber'}));
  expect(()=>fold([old,replacement])).toThrow('overlapping_revisions');
  const row=source();const legacy=await normalizeSelectedTelemetryRecord({...scope,selectionMethod:'legacy-selected-v1'},
   {stream:'usage',occurrenceId:row.occurrenceId,eventTime:row.eventTime!,recordJson:row.recordJson!,evidence:row.canonicalEvidence!,nativeOrder:0,selectedSlotKey:'f'.repeat(64),sourceFamily:'v11',occurrenceTieOrder:0});
  expect(()=>fold([old,{...old,selectionMethod:legacy.provenance.selectionMethod}])).toThrow('invalid_activity');
  expect(validCanonicalFeatureContribution({...old,rawSession:'synthetic-private'})).toBe(false);
 });
 it('preserves quota/session counts and exact tool facts without pricing them',async()=>{
  const rows:EffectiveTelemetryOccurrence[]=[];
  const at=day+'T12:05:00.000Z';
  for(const [stream,record]of [
   ['quota',{schemaVersion:'quota-observation-v1.1',observationId:'quota-occurrence:v1:'+'b'.repeat(64),provider:'openai_codex',observedTime:at,
    planType:'unknown',planVariant:'unknown',limitId:'codex',slot:'secondary',usedPercent:null,windowDurationMinutes:null,resetsAt:null,
    accountPlanAttribution:{accountBasis:'unavailable',accountTrackId:null,planBasis:'unavailable',planType:'unknown',planEraId:null}}],
   ['session',{schemaVersion:'session-dimension-v1.1',sessionUuid:'0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e00',firstEventTime:at,
    provider:'openai_codex',toolClassCounts:{shell:3,other:0}}]] as const){
   rows.push({...source(),stream,occurrenceId:'observationId'in record?record.observationId:record.sessionUuid,recordJson:canonicalTelemetryV11Json(record)});
  }
  let native=createV11DailyProjectionValues(day);const inputs:CanonicalActivityInput[]=[];
  for(const row of rows){native=foldV11DailyProjectionValues(native,[JSON.parse(row.recordJson!)]);
   inputs.push({contribution:await prepareCanonicalFeatureContribution(await normalizeNativeEffectiveOccurrence(scope,row,0)),dailyPrice:null,membership});}
  const reduced=foldCanonicalActivityContributions(day,'effective-union-v1',inputs);
  expect(reduced.daily).toEqual(native);expect(reduced.tools).toEqual([{toolClass:'other',count:'0'},{toolClass:'shell',count:'3'}]);
 });
 it('reuses immutable quantities and native costs, reprices only a changed cost family, and never decodes source records',async()=>{
  const value=await fact();await install(value,'initial');
  const first=await materializeCanonicalFeaturePartition(input(value.location.partitionKey));
  expect(first).toMatchObject({state:'complete',metrics:{quantitiesPrepared:1,quantitiesReused:0,dailyPriceCalls:1,fitPriceCalls:1,pricesReused:0,sourceRecordDecodes:0}});
  const before=await db().prepare('SELECT * FROM analytics_canonical_feature_quantities').all();
  const warm=await materializeCanonicalFeaturePartition(input(value.location.partitionKey));
  expect(warm).toMatchObject({state:'complete',metrics:{quantitiesPrepared:0,quantitiesReused:1,dailyPriceCalls:0,fitPriceCalls:0,pricesReused:2}});
  const repriced=await materializeCanonicalFeaturePartition({...input(value.location.partitionKey),
   methods:[{...CANONICAL_DAILY_PRICE_METHOD,registrySha256:'0'.repeat(64)},CANONICAL_FIT_PRICE_METHOD]});
  expect(repriced).toMatchObject({state:'complete',metrics:{quantitiesPrepared:0,quantitiesReused:1,dailyPriceCalls:1,fitPriceCalls:0,pricesReused:1}});
  expect((await db().prepare('SELECT * FROM analytics_canonical_feature_quantities').all()).results).toEqual(before.results);
 });
 it('reuses exact unaffected price cells across registry revisions and fences source changes',async()=>{
  const value=await fact();await install(value,'initial');
  const priceDependency=async(_value:unknown,method:{family:string})=>sha256Hex('exact-synthetic-cell:'+method.family);
  await materializeCanonicalFeaturePartition({...input(value.location.partitionKey),priceDependency});
  const price=vi.fn(priceChunkUsageRecordValue);
  expect(await materializeCanonicalFeaturePartition({...input(value.location.partitionKey),priceDependency,price,
   methods:[{...CANONICAL_DAILY_PRICE_METHOD,registrySha256:'1'.repeat(64)},CANONICAL_FIT_PRICE_METHOD]}))
   .toMatchObject({state:'complete',metrics:{dailyPriceCalls:0,fitPriceCalls:0,pricesReused:2}});
  expect(price).not.toHaveBeenCalled();
  expect(await materializeCanonicalFeaturePartition({...input(value.location.partitionKey),stillCurrent:async()=>false}))
   .toEqual({state:'deferred',reason:'source_changed'});
 });
 it('replaces contributions through canonical heads and physically erases every retained product',async()=>{
  const old=await fact();await install(old,'old');await materializeCanonicalFeaturePartition(input(old.location.partitionKey));
  const changed=await fact('a',{modelId:'synthetic-unpriced'});await install(changed,'changed',old.revision);
  const next=await materializeCanonicalFeaturePartition(input(changed.location.partitionKey));
  expect(next).toMatchObject({state:'complete',contributions:[{factRevision:changed.revision}],metrics:{quantitiesPrepared:1}});
  await db().prepare(`INSERT INTO analytics_storage_erasure_fences(source_id,owner_digest,terminal_event_digest,terminal_sequence,
    terminal_revision,authority_epoch,public_authority_epoch) VALUES(?,?,?,1,2,2,2)`).bind(sourceId,scope.ownerDigest,'e'.repeat(64)).run();
  for(const table of ['analytics_canonical_feature_quantities','analytics_canonical_feature_prices','analytics_canonical_feature_membership','analytics_canonical_activity_heads'])
   expect(await db().prepare('SELECT count(*) n FROM '+table).first<number>('n')).toBe(0);
  expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
 });
 it('refuses a partial schema and conflict evidence without publishing a false empty contribution',async()=>{
  const value=await fact();await install(value,'initial');
  const conflict=await normalizeNativeEffectiveOccurrence(scope,{...source(),status:'conflict',recordJson:null,eventTime:null},0);
  await expect(prepareCanonicalFeatureContribution(conflict)).rejects.toThrow('canonical_unavailable');
  await db().prepare('DROP TRIGGER analytics_canonical_feature_price_admit').run();
  expect(await canonicalFeatureContributionsAvailable(db())).toBe(false);
  expect(await materializeCanonicalFeaturePartition(input(value.location.partitionKey))).toEqual({state:'refused',reason:'migration_required'});
 });
});

it('measures all local contribution I/O and source decodes across cold, warm and selective repricing',async()=>{
 const value=await fact();await install(value,'profile');
 const receipt:Record<string,unknown>={};
 for(const phase of ['cold','warm','daily_reprice'] as const){
  const profile=createAnalyticsProfile(),meter=createD1InvocationBudget(950);
  const target=meter.wrap(profileAnalyticsDatabase(db(),'target',profile,()=>phase));
  let sourceDecodes=0;const original=JSON.parse;
  const spy=vi.spyOn(JSON,'parse').mockImplementation((raw,...rest)=>{
   if(typeof raw==='string'&&/"schemaVersion":"(?:usage-event|quota-observation|session-dimension)-v1/u.test(raw))sourceDecodes++;
   return original(raw,...rest);
  });
  let result;
  try{result=await materializeCanonicalFeaturePartition({...input(value.location.partitionKey),target,
   budget:{remainingQueries:()=>meter.remainingQueries,now:()=>0,deadlineMs:60_000},
   ...(phase==='daily_reprice'?{methods:[{...CANONICAL_DAILY_PRICE_METHOD,registrySha256:'2'.repeat(64)},CANONICAL_FIT_PRICE_METHOD]}:{})});}
  finally{spy.mockRestore();}
  expect(result.state).toBe('complete');expect(sourceDecodes).toBe(0);expect(profile.measurementFailures).toBe(0);
  const costs=Object.values(profile.costs);
  expect(costs.reduce((sum,cost)=>sum+cost.statements,0)).toBe(meter.queriesUsed);
  expect(meter.queriesUsed).toBeLessThan(950);
  receipt[phase]={statements:meter.queriesUsed,rowsRead:costs.reduce((n,c)=>n+c.rowsRead,0),
   rowsWritten:costs.reduce((n,c)=>n+c.rowsWritten,0),boundBytes:costs.reduce((n,c)=>n+c.serializedBoundBytesSubmitted,0),
   resultBytes:costs.reduce((n,c)=>n+c.serializedResultBytesRead,0),sourceDecodes,
   metrics:result.state==='complete'?result.metrics:null};
 }
 console.info('P4_CONTRIBUTION_PROFILE '+JSON.stringify(receipt));
});

it('moves between days then withdraws the accepted occurrence without leaving a stale activity contribution',async()=>{
 const original=await fact();await install(original,'before-move');
 await materializeCanonicalFeaturePartition(input(original.location.partitionKey));
 const moved=await fact('a',{eventTime:'2026-09-21T12:05:00.000Z'});
 await install(moved,'move',original.revision);
 await materializeCanonicalPartition(db(),original.location.partitionKey);
 expect(await materializeCanonicalFeaturePartition(input(original.location.partitionKey)))
  .toMatchObject({state:'complete',contributions:[],prices:[],activityInputs:[]});
 expect(await materializeCanonicalFeaturePartition(input(moved.location.partitionKey)))
  .toMatchObject({state:'complete',contributions:[{factRevision:moved.revision,day:'2026-09-21'}]});
 await materializeCanonicalPage({db:db(),sourceId,scope,ownerRevision:1,authorityEpoch:1,
  pageKey:await sha256Hex('withdraw'),sourceRevision:await sha256Hex('withdraw-proof'),stillCurrent:async()=>true,
  load:async()=>[{occurrenceKey:moved.occurrenceKey,stream:'usage',expectedRevision:moved.revision,fact:null}]});
 await materializeCanonicalPartition(db(),moved.location.partitionKey);
 const removed=await materializeCanonicalFeaturePartition(input(moved.location.partitionKey));
 expect(removed).toMatchObject({state:'complete',contributions:[],prices:[],activityInputs:[]});
 if(removed.state==='complete')expect(foldCanonicalActivityContributions('2026-09-21','effective-union-v1',removed.activityInputs))
  .toMatchObject({lastObservedAtMs:null,contributingParticipants:0,contributingDevices:0,daily:{counts:{usage:0,quota:0,session:0}}});
});
it('refuses a conflicting membership value at the same immutable dependency and retires superseded method products',async()=>{
 const value=await fact();await install(value,'membership');
 await materializeCanonicalFeaturePartition(input(value.location.partitionKey));
 expect(await materializeCanonicalFeaturePartition({...input(value.location.partitionKey),
  membership:async()=>({...membership,deviceKeys:['e'.repeat(64)]})}))
  .toEqual({state:'refused',reason:'membership_revision_conflict'});
 for(const revision of ['1','2','3','4','5']){
  expect(await materializeCanonicalFeaturePartition({...input(value.location.partitionKey),
   methods:[{...CANONICAL_DAILY_PRICE_METHOD,registrySha256:revision.repeat(64)},CANONICAL_FIT_PRICE_METHOD]}))
   .toMatchObject({state:'complete',metrics:{quantitiesPrepared:0,dailyPriceCalls:1,fitPriceCalls:0}});
 }
 expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_feature_prices').first<number>('n')).toBe(2);
});
it('namespaces native method changes independently of a reusable price-cell digest',async()=>{
 const value=await fact();await install(value,'method-namespace');
 const priceDependency=async()=> '6'.repeat(64);
 const initial=await materializeCanonicalFeaturePartition({...input(value.location.partitionKey),priceDependency});
 expect(initial.state).toBe('complete');
 const price=vi.fn((record:Record<string,unknown>|null,at:string)=>{
  const native=priceChunkUsageRecordValue(record,at);
  return native?{...native,costNanousd:native.costNanousd+1}:native;
 });
 const changed=await materializeCanonicalFeaturePartition({...input(value.location.partitionKey),priceDependency,price,
  methods:[{...CANONICAL_DAILY_PRICE_METHOD,methodVersion:CANONICAL_DAILY_PRICE_METHOD.methodVersion+'-synthetic-next'},CANONICAL_FIT_PRICE_METHOD]});
 expect(changed).toMatchObject({state:'complete',metrics:{quantitiesPrepared:0,dailyPriceCalls:1,fitPriceCalls:0,pricesReused:1}});
 expect(price).toHaveBeenCalledOnce();
 if(initial.state==='complete'&&changed.state==='complete'){
  expect(changed.facts).toEqual(initial.facts);expect(changed.contributions).toEqual(initial.contributions);
  const before=initial.prices.find(row=>row.method.family==='daily')!.value!;
  expect(changed.prices.find(row=>row.method.family==='daily')!.value!.costNanousd).toBe(before.costNanousd+1);
  expect(changed.prices.find(row=>row.method.family==='fit')).toEqual(initial.prices.find(row=>row.method.family==='fit'));
 }
});
it('refuses an absent contribution migration before acquisition or callback work',async()=>{
 await reset();const stillCurrent=vi.fn(async()=>true);
 expect(await materializeCanonicalFeaturePartition({...input('effective-union-v1/usage/'+day+'/aa'),stillCurrent}))
  .toEqual({state:'refused',reason:'migration_required'});
 expect(stillCurrent).not.toHaveBeenCalled();
});


it('G06 bounds stale contribution cleanup on saved-price replay after interrupted completion',async()=>{
 const value=await fact();await install(value,'cleanup-replay');
 expect((await materializeCanonicalFeaturePartition(input(value.location.partitionKey))).state).toBe('complete');
 const fit=(await db().prepare("SELECT * FROM analytics_canonical_feature_prices WHERE family='fit'").all()).results;
 await db().prepare(`WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200)
  INSERT INTO analytics_canonical_feature_prices SELECT p.fact_revision,p.family,printf('%064x',n.i),
   p.method_digest,p.payload,p.payload_digest FROM analytics_canonical_feature_prices p CROSS JOIN n WHERE p.family='daily'`).run();
 await db().prepare(`WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200)
  INSERT INTO analytics_canonical_feature_membership SELECT p.fact_revision,printf('%064x',n.i),p.method,
   p.contributor_key,p.device_keys_json FROM analytics_canonical_feature_membership p CROSS JOIN n`).run();
 const methods=[{...CANONICAL_DAILY_PRICE_METHOD,registrySha256:'3'.repeat(64)}];
 const nextMembership={...membership,dependencyRevision:'7'.repeat(64)};
 let saved=false;
 const interrupted=new Proxy(db(),{get(database,key){
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await database.batch(statements);
   saved=!!await database.prepare('SELECT 1 saved FROM analytics_canonical_feature_membership WHERE dependency_revision=?')
    .bind(nextMembership.dependencyRevision).first();return result;};
  const entry=Reflect.get(database,key);return typeof entry==='function'?entry.bind(database):entry;
 }});
 expect(await materializeCanonicalFeaturePartition({...input(value.location.partitionKey),target:interrupted,methods,
  membership:async()=>nextMembership,stillCurrent:async()=>!saved})).toEqual({state:'deferred',reason:'canonical_partition_changed'});
 const current=await db().prepare('SELECT * FROM analytics_canonical_feature_membership WHERE dependency_revision=?').bind(nextMembership.dependencyRevision).first();
 const price=vi.fn(()=>{throw Error('saved current prices must be reused');});
 for(let turn=0;turn<2;turn++) {
  const profile=createAnalyticsProfile();
  const result=await materializeCanonicalFeaturePartition({...input(value.location.partitionKey),
   target:profileAnalyticsDatabase(db(),'target',profile,()=> 'contribution-cleanup'),methods,
   membership:async()=>nextMembership,price});
  if(turn===0) {
   expect(result).toEqual({state:'deferred',reason:'source_changed_or_budget'});
   expect(await db().prepare("SELECT count(*) n FROM analytics_canonical_feature_prices WHERE family='daily'").first('n')).toBe(74);
   expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_feature_membership').first('n')).toBe(74);
  } else expect(result).toMatchObject({state:'complete',metrics:{dailyPriceCalls:0,fitPriceCalls:0,pricesReused:1}});
  expect(Object.values(profile.costs).reduce((sum,cost)=>sum+cost.rowsWritten,0)).toBeLessThanOrEqual(512);
  expect(await db().prepare('SELECT * FROM analytics_canonical_feature_membership WHERE dependency_revision=?').bind(nextMembership.dependencyRevision).first()).toEqual(current);
  expect((await db().prepare("SELECT * FROM analytics_canonical_feature_prices WHERE family='fit'").all()).results).toEqual(fit);
 }
 expect(price).not.toHaveBeenCalled();
 expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_feature_prices').first('n')).toBe(2);
 expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_feature_membership').first('n')).toBe(1);
 expect((await materializeCanonicalFeaturePartition({...input(value.location.partitionKey),methods,
  membership:async()=>nextMembership,price})).state).toBe('complete');
 expect(price).not.toHaveBeenCalled();expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});
