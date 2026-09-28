import {env,reset,type D1Migration} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {createSharedAnalyticsInputCache,type SharedAnalyticsInputMetrics} from '../src/analytics-shared-input';
import {evaluateSharedCacheDay,evaluateSharedModelDate,evaluateSharedScalarDate,
  type SharedAnalyticsDay} from '../src/analytics-shared-reducers';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {captureStorageGraphScope,computeStorageGraphResult} from '../src/storage-community-graph';
import {readStorageCommunityOwnerPage,type StorageCommunityOwner} from '../src/storage-community-authority';
import {readEffectiveTelemetryOwnerDayPage,type EffectiveUsageReaderCursor} from '../src/telemetry-usage-effective-reader';
import {createV11DailyProjectionValues,foldV11DailyProjectionValues,
  finalizeV11DailyProjectionValues} from '../src/v11-daily-projection-values';
import {CACHE_RETENTION_EFFECTIVE_DEVICE_ID,CACHE_RETENTION_EFFECTIVE_MANIFEST_ID,
  cacheRetentionLookbackDays,createCacheRetentionEffectiveDayBuild,
  createCacheRetentionEffectiveDayReader} from '../src/cache-retention-day';
import type {CacheRetentionDayAggregate} from '../src/cache-retention-values';
import type {CommunityAllowanceFit} from '../src/community-allowance';
import {modelHistoryWindow} from '../src/model-history-window';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus} from './fixtures/shared-analytics-corpus';
import {createAnalyticsProfile,measureAnalyticsWork,profileAnalyticsDatabase,summarizeAnalyticsProfile,
  type AnalyticsProfile} from './helpers/analytics-profile';

type Bindings=Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_MIGRATIONS:D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
type Owner=StorageCommunityOwner&{ownerDigest:string};
type Corpus=Awaited<ReturnType<typeof seedSharedAnalyticsCorpus>>;
type Daily=ReturnType<typeof finalizeV11DailyProjectionValues>;
interface Outputs {
  daily: {day:string;value:Daily}[];
  fits: CommunityAllowanceFit[];
  models: {day:string;value:object}[];
  cache: {day:string;value:CacheRetentionDayAggregate}[];
}
/** The experimental pin has an intentionally separate storage identity. Every
 * analytical field remains in the exact comparison, including refusal codes. */
function analyticalModels(models:Outputs['models']):Outputs['models'] {
  return models.map(({day,value})=>{
    const fields={...value} as Record<string,unknown>;
    if(Object.hasOwn(fields,'inputFingerprint')){
      expect(fields.inputFingerprint).toMatch(/^[0-9a-f]{64}$/u);
      delete fields.inputFingerprint;
    }
    return {day,value:fields};
  });
}
const bindings=env as Bindings;
const source=()=>bindings.USAGE_MONITOR_DB,target=()=>bindings.STORAGE_ANALYTICS_DB;
const sourceId='synthetic-shared-analytics-benchmark',sourceNamespace=sourceId;
const mode=(import.meta as ImportMeta&{env?:{VITE_SHARED_ANALYTICS_BENCHMARK?:string}})
  .env?.VITE_SHARED_ANALYTICS_BENCHMARK==='full'?'full':'small';
const configuration=mode==='full'?{calendarDays:130,graphDays:30}:{calendarDays:14,graphDays:2};
const DAY_MS=86_400_000;
const byDay=(days:readonly SharedAnalyticsDay[],fromDay:string,throughDay:string)=>
  days.filter(day=>day.day>=fromDay&&day.day<=throughDay);
const boundedOwner=(owner:StorageCommunityOwner):Owner=>{
  if(!owner.ownerDigest)throw new Error('shared benchmark owner authority unavailable');
  return {...owner,ownerDigest:owner.ownerDigest};
};

function metadataFixture(result:unknown,batchResults:unknown[]=[result]):D1Database {
  const statement={bind:()=>statement,all:async()=>result,run:async()=>result};
  return {prepare:()=>statement,batch:async()=>batchResults} as unknown as D1Database;
}

it.each(['rows_read','rows_written','duration'] as const)('refuses incomplete or invalid %s profiling metadata',async(field)=>{
  for(const invalid of [undefined,null,NaN,Infinity,-1]){
    const result={results:[{value:1}],meta:{rows_read:0,rows_written:0,duration:0,[field]:invalid}};
    for(const method of ['first','all','run'] as const){
      const profile=createAnalyticsProfile(),database=profileAnalyticsDatabase(metadataFixture(result),'source',profile,()=> 'metadata');
      await expect(database.prepare('SELECT 1 AS value')[method]()).rejects
        .toThrow(`analytics benchmark requires finite nonnegative D1 metadata: ${field}`);
      expect(profile.costs['metadata.source.other']).toMatchObject({statements:1,failedStatements:0,metadataSamples:0});
      expect(profile.measurementFailures).toBe(1);
      expect(()=>summarizeAnalyticsProfile(profile)).toThrow('profile contains invalid measurements');
    }
    const valid={results:[],meta:{rows_read:0,rows_written:0,duration:0}},profile=createAnalyticsProfile();
    const database=profileAnalyticsDatabase(metadataFixture(valid,[valid,result]),'target',profile,()=> 'metadata');
    await expect(database.batch([database.prepare('SELECT 1'),database.prepare('SELECT 2')])).rejects
      .toThrow(`analytics benchmark requires finite nonnegative D1 metadata: ${field}`);
    expect(profile.costs['metadata.target.other']).toMatchObject({statements:2,failedStatements:0,metadataSamples:1});
    expect(profile.measurementFailures).toBe(1);
    expect(()=>summarizeAnalyticsProfile(profile)).toThrow('profile contains invalid measurements');
  }
});

it('keeps a caught incomplete-batch measurement failure sticky',async()=>{
  const result={results:[],meta:{rows_read:0,rows_written:0,duration:0}};
  for(const returned of [[],[result,result,result]]){
    const profile=createAnalyticsProfile();
    const database=profileAnalyticsDatabase(metadataFixture(result,returned),'target',profile,()=> 'metadata');
    await expect(database.batch([database.prepare('SELECT 1'),database.prepare('SELECT 2')]))
      .rejects.toThrow('incomplete batch results');
    expect(profile.costs['metadata.target.other']).toMatchObject({statements:2,failedStatements:0});
    // A production optional-cache fallback could catch the earlier exception.
    // Neither more valid work nor a later summary can erase its measurement gap.
    await database.prepare('SELECT 1').all();
    expect(profile.costs['metadata.target.other']?.statements).toBe(3);
    expect(()=>summarizeAnalyticsProfile(profile)).toThrow('profile contains invalid measurements');
  }
});

it('retains measured zero metadata and labels batch wall allocation separately',async()=>{
  const result={results:[{value:1}],meta:{rows_read:0,rows_written:0,duration:0}},profile=createAnalyticsProfile();
  const database=profileAnalyticsDatabase(metadataFixture(result),'source',profile,()=> 'metadata');
  expect(await database.prepare('SELECT 1 AS value').first('value')).toBe(1);
  await database.batch([database.prepare('SELECT 1 AS value')]);
  expect(summarizeAnalyticsProfile(profile)).toMatchObject({statements:2,metadataSamples:2,
    rowsRead:0,rowsWritten:0,databaseMs:0});
  expect(profile.costs['metadata.source.other']).toMatchObject({statementCallWallMs:expect.any(Number),
    allocatedBatchWallMs:expect.any(Number)});
  expect(summarizeAnalyticsProfile(profile).batchWallTimeAllocation).toContain('not independently measured');
  const missing=profileAnalyticsDatabase(metadataFixture({results:[]}), 'source', createAnalyticsProfile(),()=> 'metadata');
  await expect(missing.prepare('SELECT 1').all()).rejects.toThrow('finite nonnegative D1 metadata');
});

/** Independent daily reference: exactly the existing effective daily pager's
 * 50-row pages and one-record folds, without the public cohort/publication. */
async function referenceDaily(database:D1Database,owner:Owner,day:string):Promise<Daily> {
  let state=createV11DailyProjectionValues(day);
  for(const stream of ['usage','quota','session'] as const){
    let after:EffectiveUsageReaderCursor|undefined;
    for(let pageNumber=0;;pageNumber++){
      if(pageNumber>=100)throw new Error('shared benchmark daily fixture page bound');
      const page=await readEffectiveTelemetryOwnerDayPage(database,{sourceNamespace,ownerDigest:owner.ownerDigest,
        ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,day,stream,limit:50,
        ...(after?{after}:{})});
      for(const row of page.rows){
        expect(row.status).toBe('compatible');expect(row.recordJson).not.toBeNull();
        state=foldV11DailyProjectionValues(state,[JSON.parse(row.recordJson!)]);
      }
      if(page.next===null)break;
      after=page.next;
    }
  }
  return finalizeV11DailyProjectionValues(state);
}

/** This existing builder owns the carry selection and reduction. Synthetic
 * key digests only identify this non-persisting local call; they do not stand
 * in for production cache admission or publication proof. */
async function referenceCache(database:D1Database,owner:Owner,day:string):Promise<CacheRetentionDayAggregate> {
  const read=createCacheRetentionEffectiveDayReader({source:database,sourceNamespace,
    ownerDigest:owner.ownerDigest,ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch});
  const build=createCacheRetentionEffectiveDayBuild({source:database,sourceNamespace,ownerDigest:owner.ownerDigest,
    ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,read,now:Date.now});
  return build({sourceId,sourceLayout:'effective',sourceNamespace,ownerDigest:owner.ownerDigest,
    deviceId:CACHE_RETENTION_EFFECTIVE_DEVICE_ID,manifestId:CACHE_RETENTION_EFFECTIVE_MANIFEST_ID,
    manifestDigest:'0'.repeat(64),day},cacheRetentionLookbackDays(day).map(value=>({day:value,manifestDigest:''})),
  {remainingQueries:100_000,deadlineMs:Date.now()+60_000});
}

async function referenceGraph(input:{source:D1Database;target:D1Database;owner:Owner;day:string;
  metric:'fits'|'model';profile:AnalyticsProfile;setPhase:(phase:string)=>void}) {
  for(let attempt=0;attempt<80;attempt++){
    const meter=createD1InvocationBudget(950),meteredSource=meter.wrap(input.source),meteredTarget=meter.wrap(input.target);
    input.setPhase(`${input.metric}.scope`);
    const owner=(await readStorageCommunityOwnerPage(meteredSource)).find(value=>value.participantId===input.owner.participantId);
    if(!owner)throw new Error('shared benchmark current owner unavailable');
    const scope=await measureAnalyticsWork(input.profile,`${input.metric}.scope`,()=>captureStorageGraphScope(meteredSource,
      {owner,day:input.day,metric:input.metric,sourceId,sourceNamespace,preparedFold:true}));
    expect(scope.source).toBe('effective');
    input.setPhase(`${input.metric}.compute`);
    const result=await measureAnalyticsWork(input.profile,`${input.metric}.compute`,()=>computeStorageGraphResult(
      {source:meteredSource,target:meteredTarget,sourceId,sourceNamespace},scope,
      {maxQueries:meter.remainingQueries,deadlineMs:Date.now()+60_000,preparedFold:true}));
    input.profile.invocations++;
    input.profile.maximumStatementsPerInvocation=Math.max(input.profile.maximumStatementsPerInvocation,meter.queriesUsed);
    expect(meter.queriesUsed).toBeLessThanOrEqual(950);
    if(result.state==='complete'){
      if(input.metric==='model'){
        const value=result.result.composition as {status?:string;inputFingerprint?:string}|null;
        if(value?.status==='ready')expect(value.inputFingerprint).toBe(scope.pin.fingerprint);
      }
      return result;
    }
    expect(result.failure).toBeUndefined();
    expect(['effective_checkpoint','effective_checkpoint_read_budget','checkpoint_advanced']).toContain(result.reason);
  }
  throw new Error('shared benchmark graph did not complete within bounded invocations');
}

async function runReference(corpus:Corpus,owner:Owner,dates:readonly string[]) {
  const profile=createAnalyticsProfile();let phase='daily';
  const observedSource=profileAnalyticsDatabase(source(),'source',profile,()=>phase);
  const observedTarget=profileAnalyticsDatabase(target(),'target',profile,()=>phase);
  const started=performance.now(),output:Outputs={daily:[],fits:[],models:[],cache:[]};
  await measureAnalyticsWork(profile,'daily',async()=>{
    for(const day of corpus.historyDates)output.daily.push({day,value:await referenceDaily(observedSource,owner,day)});
  });
  const graph=async(day:string,metric:'fits'|'model')=>referenceGraph({source:observedSource,target:observedTarget,
    owner,day,metric,profile,setPhase:value=>{phase=value;}});
  const fits=await graph(corpus.historyDates.at(-1)!,'fits');
  output.fits=fits.result.fits??[];
  let reusedModels=0;
  for(const day of dates){
    const result=await graph(day,'model');
    if(result.result.composition===null)throw new Error('shared benchmark model completion unavailable');
    output.models.push({day,value:result.result.composition});
    if(result.reused)reusedModels++;
  }
  phase='cache';
  await measureAnalyticsWork(profile,'cache',async()=>{
    for(const day of dates)output.cache.push({day,value:await referenceCache(observedSource,owner,day)});
  });
  profile.wallMs=performance.now()-started;
  return {output,profile,reused:{fits:fits.reused,models:reusedModels}};
}

async function outputSummary(output:Outputs) {
  const statuses:Record<string,number>={},refusals:Record<string,number>={};
  for(const model of output.models){
    const value=model.value as {status?:string;reason?:string},status=value.status??'unknown';
    statuses[status]=(statuses[status]??0)+1;
    if(value.reason)refusals[value.reason]=(refusals[value.reason]??0)+1;
  }
  return {completed:{daily:output.daily.length,currentScalarFits:1,historicalModels:output.models.length,cacheDays:output.cache.length},
    nonempty:{dailyDays:output.daily.filter(value=>value.value.counts.usage>0).length,
      sessionRows:output.daily.reduce((sum,value)=>sum+value.value.counts.session,0),scalarFits:output.fits.length,
      models:statuses,modelRefusals:refusals,cacheGroups:output.cache.reduce((sum,day)=>sum+day.value.groups.length,0),
      cacheAdjacencies:output.cache.reduce((sum,day)=>sum+day.value.groups.reduce((n,group)=>n+group.adjacencies,0),0)},
    digests:{daily:await sha256Hex(canonicalJson(output.daily)),fits:await sha256Hex(canonicalJson(output.fits)),
      models:await sha256Hex(canonicalJson(analyticalModels(output.models))),cache:await sha256Hex(canonicalJson(output.cache))}};
}

it('compares complete local shared analytics work against current graph and independent daily/cache readers',async()=>{
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(),target(),bindings,sourceId,sourceNamespace);
  const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace,...configuration});
  let owner=boundedOwner(corpus.owner);
  const throughDay=corpus.historyDates.at(-1)!;
  const fromDay=[corpus.historyDates[0]!,modelHistoryWindow(corpus.graphDates[0]!).fromDay].sort()[0]!;
  const inputDays=(Date.parse(throughDay)-Date.parse(fromDay))/DAY_MS+1;
  const createSharedRunner=(dependencyMode:'per-day'|'batched')=>{
    let profile=createAnalyticsProfile(),operation='acquisition';
    const observedSource=profileAnalyticsDatabase(source(),'source',()=>profile,()=>operation);
    const cache=createSharedAnalyticsInputCache({source:observedSource,sourceNamespace,dependencyMode});
    return async(dates:readonly string[])=>{
      profile=createAnalyticsProfile();operation='acquisition';const started=performance.now();
      const snapshot=await measureAnalyticsWork(profile,'acquisition',()=>cache.load({owner,fromDay,throughDay,
        deadlineMs:Date.now()+120_000}));
      const output:Outputs={daily:[],fits:[],models:[],cache:[]};
      operation='daily';
      await measureAnalyticsWork(profile,'daily',async()=>{
        const selected=new Map(snapshot.days.map(day=>[day.day,day]));
        for(const day of corpus.historyDates){const value=selected.get(day);if(!value)throw new Error('shared benchmark daily input absent');
          output.daily.push({day,value:value.daily});}
      });
      const sourcePin=async(day:string,metric:'fits'|'model')=>{
        operation=`${metric}.scope`;
        return measureAnalyticsWork(profile,operation,()=>snapshot.pinForDate(day));
      };
      const scalarPin=await sourcePin(throughDay,'fits');
      operation='fits.compute';
      const scalar=await measureAnalyticsWork(profile,operation,()=>evaluateSharedScalarDate({pin:scalarPin,
        day:throughDay,ownerDigest:owner.ownerDigest,days:byDay(snapshot.days,scalarPin.fromDay,throughDay)}));
      output.fits=scalar.selectedFits;
      for(const day of dates){
        const pin=await sourcePin(day,'model');operation='model.compute';
        const value=await measureAnalyticsWork(profile,operation,()=>evaluateSharedModelDate({pin,day,
          ownerDigest:owner.ownerDigest,days:byDay(snapshot.days,pin.fromDay,day)}));
        const identified=value as {status?:string;inputFingerprint?:string};
        if(identified.status==='ready')expect(identified.inputFingerprint).toBe(pin.fingerprint);
        output.models.push({day,value});
      }
      operation='cache';
      await measureAnalyticsWork(profile,'cache',async()=>{
        for(const day of dates)output.cache.push({day,value:evaluateSharedCacheDay({day,
          ownerDigest:owner.ownerDigest,days:byDay(snapshot.days,cacheRetentionLookbackDays(day)[0]!,day)})});
      });
      operation='final_fence';await snapshot.assertCurrent();
      profile.wallMs=performance.now()-started;
      return {output,profile,metrics:snapshot.metrics};
    };
  };
  const sharedRunners={'per-day':createSharedRunner('per-day'),batched:createSharedRunner('batched')};
  const phases:Record<string,unknown>={};
  let coldDailyDigest='',coldFitsDigest='',correctedDigest='';
  const initiallyCompletedDates:string[]=[];
  for(const phase of ['cold','warm','corrected','noop'] as const){
    if(phase==='corrected')owner=boundedOwner(await corpus.mutateCorrection());
    const dates=phase==='cold'?corpus.graphDates.slice(0,1)
      :phase==='warm'?corpus.graphDates.slice(1):corpus.graphDates;
    const reference=await runReference(corpus,owner,dates);
    const perDay=await sharedRunners['per-day'](dates),batched=await sharedRunners.batched(dates);
    const sharedVariants={'per-day':perDay,batched};
    for(const shared of Object.values(sharedVariants)){
      expect(canonicalJson(shared.output.daily)).toBe(canonicalJson(reference.output.daily));
      expect(canonicalJson(shared.output.fits)).toBe(canonicalJson(reference.output.fits));
      expect(shared.output.models.map(model=>Object.hasOwn(model.value,'inputFingerprint')))
        .toEqual(reference.output.models.map(model=>Object.hasOwn(model.value,'inputFingerprint')));
      expect(canonicalJson(analyticalModels(shared.output.models))).toBe(canonicalJson(analyticalModels(reference.output.models)));
      expect(canonicalJson(shared.output.cache)).toBe(canonicalJson(reference.output.cache));
    }
    // Query batching changes neither the shared private identity nor any feature.
    expect(canonicalJson(batched.output)).toBe(canonicalJson(perDay.output));
    expect(batched.metrics).toEqual(perDay.metrics);
    const summary=await outputSummary(perDay.output);
    expect(summary.nonempty.dailyDays).toBeGreaterThan(0);
    expect(summary.nonempty.sessionRows).toBeGreaterThan(0);
    expect(summary.nonempty.scalarFits,JSON.stringify({phase,nonempty:summary.nonempty})).toBeGreaterThan(0);
    expect(summary.nonempty.models,JSON.stringify({phase,nonempty:summary.nonempty})).toEqual({ready:dates.length});
    expect(summary.nonempty.cacheGroups,JSON.stringify({phase,nonempty:summary.nonempty})).toBeGreaterThan(0);
    expect(summary.nonempty.cacheAdjacencies).toBeGreaterThan(0);
    if(phase==='cold'){
      for(const shared of Object.values(sharedVariants))expect(shared.metrics.preparedDays).toBe(inputDays);
      coldDailyDigest=summary.digests.daily;coldFitsDigest=summary.digests.fits;
      expect(reference.reused).toEqual({fits:false,models:0});
      initiallyCompletedDates.push(...dates);
    }else if(phase==='corrected'){
      for(const shared of Object.values(sharedVariants)){
        expect(shared.metrics.preparedDays).toBe(1);expect(shared.metrics.reusedDays).toBe(inputDays-1);
      }
      correctedDigest=await sha256Hex(canonicalJson(perDay.output));
      expect(summary.digests.daily).not.toBe(coldDailyDigest);
    }else{
      for(const shared of Object.values(sharedVariants)){
        expect(shared.metrics.preparedDays).toBe(0);expect(shared.metrics.reusedDays).toBe(inputDays);
        expect(shared.metrics.sourcePages).toBe(0);expect(shared.metrics.sourceRows).toBe(0);
        expect(shared.metrics.dependencyDays).toBe(0);
      }
      if(phase==='warm'){
        expect(summary.digests.daily).toBe(coldDailyDigest);expect(summary.digests.fits).toBe(coldFitsDigest);
        expect(reference.reused).toEqual({fits:true,models:0});
        initiallyCompletedDates.push(...dates);
      }else{
        for(const shared of Object.values(sharedVariants))
          expect(await sha256Hex(canonicalJson(shared.output))).toBe(correctedDigest);
        expect(reference.reused).toEqual({fits:true,models:dates.length});
      }
    }
    for(const measured of [reference.profile,perDay.profile,batched.profile]){
      const totals=summarizeAnalyticsProfile(measured);
      expect(totals.failedStatements).toBe(0);
      expect(totals.metadataSamples).toBe(totals.statements);
    }
    phases[phase]={reference:{profile:summarizeAnalyticsProfile(reference.profile),reused:reference.reused},
      sharedVariants:Object.fromEntries(Object.entries(sharedVariants).map(([dependencyMode,shared])=>[dependencyMode,
        {dependencyMode,profile:summarizeAnalyticsProfile(shared.profile),input:shared.metrics as SharedAnalyticsInputMetrics}])),
      parity:{semanticExact:true,compared:['reference','shared-per-day','shared-batched'],
        excludedMetadata:['model.inputFingerprint'],sharedPrivateIdentityExact:true,...summary}};
  }
  expect(initiallyCompletedDates).toEqual(corpus.graphDates);
  const summary={schemaVersion:'shared-analytics-benchmark-v2',mode,
    executionOrder:['reference','per-day','batched'],
    corpus:{calendarDays:configuration.calendarDays,inputDays,historicalModelDates:corpus.graphDates.length,
      synthetic:true,sourceFamilies:['v1','v11','v12']},
    phaseMeaning:{cold:'Acquire all input days and compute the first historical model/cache date plus current fits.',
      warm:'Reuse prepared input days for the remaining distinct historical model/cache dates plus current fits.',
      corrected:'Replace one historical day and compute all historical model/cache dates plus current fits.',
      noop:'Replay all completed corrected outputs without a source mutation.'},
    bounds:{referenceGraphInvocationStatements:950,prototype:{maximumDays:466,maximumRows:200_000,
      maximumSerializedBytes:32*1024*1024,scheduledInvocation:false}},phases,
    referenceBoundaries:{graph:'Current captureStorageGraphScope + computeStorageGraphResult with prepared input caches enabled and durable target writes.',
      daily:'Independent effective owner pages and existing daily activity/API-spend kernel; uncached reference, not current warm publication cost.',
      cache:'Independent existing effective cache-retention reader and existing carry/reduction builder; uncached reference, not current warm lane cost.'},
    limitations:['The shared path is a bounded local batch, not a production Worker handler or a durable job.',
      'Candidate reductions remain in memory; graph reference includes durable checkpoints/results. Persistence and publication costs are asymmetric.',
      'Mixed workload totals are not whole-production totals; graph artifact costs are the primary current-path comparison.',
      'Each phase runs the reference first, then shared per-day, then shared batched. Timings are indicative and may reflect execution order; statements and rows are primary.',
      'Per-owner contributions are compared. Public cohort aggregation, publication, deployment and live throughput are not qualified.',
      'Model parity excludes only the validated inputFingerprint: the experiment uses a separate private pin identity. Every analytical field is compared exactly.',
      'D1 first() is observed through all() on the identical prepared SQL to retain rows/time metadata.',
      'Checkpoint payload bytes count submitted INSERT payloads, including idempotent retries; physical writes use D1 rows_written metadata.',
      'Missing, nonfinite or negative D1 rows_read, rows_written or duration rejects the report; measured zeros are retained.',
      'Per-family batch wall time is an equal allocation of the measured batch call, not an independent family timing.',
      'Serialized retained bytes are not peak heap. CPU and peak memory are unavailable from local Workerd bindings.']};
  console.info('shared-analytics-benchmark',JSON.stringify(summary));
},mode==='full'?600_000:180_000);
