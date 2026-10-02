import { expect, it } from 'vitest';
import { createAnalyticsProfile, profileAnalyticsDatabase, summarizeAnalyticsProfile } from './helpers/analytics-profile';
import {D1_BUDGET_ATTACHMENT,type D1BudgetAttachment} from '../src/d1-invocation-budget';
import { createWholeWorkloadMeter, summarizeWholeWorkload,validateWholeWorkloadPublicationTimes,wholeWorkloadGraphPopulation,completeBoundedWholeWorkloadRequest } from './helpers/analytics-whole-workload';

function database(sizeAfter?:()=>number):D1Database {
  const result={results:[{value:1}],success:true,meta:{rows_read:3,rows_written:0,duration:0,changes:0}};
  const read=async()=>({...result,meta:{...result.meta,...(sizeAfter?{size_after:sizeAfter()}:{})}});
  const statement={bind:()=>statement,all:read,run:read};
  return {prepare:()=>statement,batch:async (statements:D1PreparedStatement[])=>statements.map(()=>result)} as unknown as D1Database;
}
it('counts initial scope raw-history access together with finisher and final proof',async()=>{
  const meter=createWholeWorkloadMeter(database(),database());
  await meter.invocation('scope_then_compute',async(db)=>{
    meter.setPhase('scope_capture');
    await db.source.prepare('SELECT occurrence_id FROM telemetry_v12_records WHERE stream=?').bind('usage').all();
    meter.setPhase('model_compute');
    await db.target.prepare('SELECT payload FROM analytics_history_checkpoint_parts').first();
    meter.setPhase('final_visibility');
    await db.target.prepare('SELECT payload_json FROM analytics_community_graph_results').first();
  });
  const summary=summarizeWholeWorkload(meter.profile);
  expect(summary.statements).toBe(3);
  expect(summary.rawHistoryAccessStatements).toBe(1);
  expect(summary.maximumStatementsPerInvocation).toBe(3);
  expect(summary.phaseStatements.scope_capture).toBe(1);
  expect(summary.phaseStatements.model_compute).toBe(1);
  expect(summary.phaseStatements.final_visibility).toBe(1);
  expect(summary.cpuMs).toBeNull();expect(summary.peakMemoryBytes).toBeNull();expect(summary.cost).toBeNull();
  expect(summary.peakMemoryUnavailableReason).toBe('True peak isolate heap is not measured by this SQL/resource profile. Separately attached runtime observations contain sampled/barrier heap, not a true peak.');
});
it('records representation bytes without retaining bind values, SQL or returned records',async()=>{
  const profile=createAnalyticsProfile(),db=profileAnalyticsDatabase(database(),'source',profile,()=> 'scope_capture');
  const privateValue='synthetic-private-unicode-é';
  await db.prepare('SELECT value FROM typed_telemetry_records WHERE private_column=?').bind(privateValue).first('value');
  const summary=summarizeAnalyticsProfile(profile);
  expect(summary.serializedBoundBytesSubmitted).toBe(new TextEncoder().encode(JSON.stringify([privateValue])).byteLength);
  expect(summary.serializedResultBytesRead).toBe(new TextEncoder().encode(JSON.stringify([{value:1}])).byteLength);
  expect(JSON.stringify(summary)).not.toContain(privateValue);
  expect(JSON.stringify(summary)).not.toContain('private_column');
  expect(summary.metadataSamples).toBe(1);
  expect(()=>createWholeWorkloadMeter(database(),database()).setPhase('unknown')).toThrow('unknown workload phase');
});

it('composes attached databases before wrapping so source and target share one exact counter',async()=>{
  const meter=createWholeWorkloadMeter(database(),database(),db=>{
    const attached=(target:D1Database):D1BudgetAttachment&{target:D1Database}=>({target,
      withBudget(wrap){return attached(wrap(target));}});
    return {...db,source:new Proxy(db.source,{get(source,key){
      return key===D1_BUDGET_ATTACHMENT?attached(db.target):Reflect.get(source,key);
    }})};
  });
  await meter.invocation('attached',async(db,budget)=>{
    await budget.wrap(db.source).prepare('SELECT 1').all();
    const context=Reflect.get(budget.wrap(db.source),D1_BUDGET_ATTACHMENT) as D1BudgetAttachment&{target:D1Database};
    await context.target.prepare('SELECT 1').all();
  });
  expect(summarizeWholeWorkload(meter.profile)).toMatchObject({statements:2,maximumStatementsPerInvocation:2});
});

it('validates exact analytical publication times without changing any DTO or hash',()=>{
 const time='2026-10-01T12:00:01.000Z',now=Date.parse(time);
 const output={preview:{generatedAt:time,observationTime:time,centralUsd:12.34},daily:[{value:{rows:[{
  released_at:time,payload_json:JSON.stringify({releasedAt:time,eventTime:time,usage:42})}],
  allowanceBreakdownsCache:{generated_at:time,payload_json:JSON.stringify({generatedAt:time,fit:0.8})}}}]};
 const before=structuredClone(output),validated=validateWholeWorkloadPublicationTimes(output,now);
 expect(validated.timestampsChecked).toBe(3);expect(validated.output).toBe(output);expect(output).toEqual(before);
 expect(()=>validateWholeWorkloadPublicationTimes(output,now-1)).toThrow('differs from analytical clock');
 const mismatched=structuredClone(output);mismatched.daily[0]!.value.rows[0]!.released_at=new Date(now-1).toISOString();
 expect(()=>validateWholeWorkloadPublicationTimes(mismatched,now)).toThrow('timestamp mismatch');
});


it('includes the retained native graph calendar independently of requested calculation dates',()=>{
 const today='2026-10-01',anchor=Date.parse(today+'T00:00:00.000Z');
 for(const count of [1,30,365]) {
  const requested=Array.from({length:count},(_,index)=>new Date(anchor-(count-index)*86_400_000).toISOString().slice(0,10));
  const population=wholeWorkloadGraphPopulation(today,requested);
  expect(population.retainedModelDates).toHaveLength(70);
  expect(population.retainedModelDates.at(-1)).toBe(today);
  expect(population.calculatedModelDates).toHaveLength(count===365?366:70);
  expect(population.extraRequestedDates).toHaveLength(count===365?296:0);
  expect(population.requestedDates).toEqual(requested);
  expect(population.calculatedModelDates).toEqual([...new Set([...requested,...population.retainedModelDates])].sort());
 }
});
it('rejects incomplete or future request calendars and handles leap-day boundaries',()=>{
 const population=wholeWorkloadGraphPopulation('2024-03-01',['2024-02-29']);
 expect(population.retainedModelDates.at(-2)).toBe('2024-02-29');
 expect(()=>wholeWorkloadGraphPopulation('2024-02-30',['2024-02-29'])).toThrow();
 expect(()=>wholeWorkloadGraphPopulation('2024-03-01',['2024-02-28'])).toThrow('complete preceding calendar');
 expect(()=>wholeWorkloadGraphPopulation('2024-03-01',['2024-03-01'])).toThrow();
});

it('meters deletion-ledger reads with every role and isolates the three invocation ceilings',async()=>{
 const measured=createWholeWorkloadMeter(database(),database(),undefined,undefined,database());
 for(const role of ['analytics','cache','publication']) {
  measured.setPhase(`${role}_role`);
  await measured.invocation(`${role}_schedule`,async(db,_budget,ledger)=>{
   if(!ledger)throw new Error('missing ledger');
   await db.source.prepare('SELECT 1').all();
   await db.target.prepare('SELECT 1').all();
   await ledger.prepare('SELECT 1').all();
  });
 }
 const summary=summarizeWholeWorkload(measured.profile);
 expect(summary).toMatchObject({statements:9,invocations:3,maximumStatementsPerInvocation:3});
 for(const role of ['analytics','cache','publication']) {
  expect(summary.phaseStatements[`${role}_role`]).toBe(3);
  expect(measured.profile.costs[`${role}_role.ledger.other`]?.statements).toBe(1);
 }
});


it('counts a transient scheduled failure and completes only after the requested output is exact',async()=>{
 const measured=createWholeWorkloadMeter(database(),database());
 const failures:{role:string;queries:number}[]=[];let opportunities=0;
 const exact={day:'2026-09-30',schema:'synthetic-public-v1',total:42};
 const result=await completeBoundedWholeWorkloadRequest({limit:3,
  request:async()=>{
   measured.setPhase('final_visibility');
   return measured.invocation('request',async db=>{await db.target.prepare('SELECT 1').all();
    return opportunities<2?{state:'deferred' as const,output:null}:{state:'complete' as const,output:exact};});
  },complete:result=>result.state==='complete'&&JSON.stringify(result.output)===JSON.stringify(exact),
  advanceRoles:async()=>{
   measured.setPhase('publication_role');
   await measured.invocation('publication_schedule',async(db,budget)=>{
    await db.target.prepare('SELECT 1').all();opportunities++;
    if(opportunities===1)failures.push({role:'publication',queries:budget.queriesUsed});
   });
  },exhaustedMessage:'outputs incomplete'});
 expect(result.output).toEqual(exact);expect(failures).toEqual([{role:'publication',queries:1}]);
 expect(summarizeWholeWorkload(measured.profile)).toMatchObject({statements:5,invocations:5,failedStatements:0,
  phaseStatements:{publication_role:2,final_visibility:3}});
});
it('cannot promote persistent role failures or wrong output to complete after bounded opportunities',async()=>{
 for(const wrongOutput of [null,{day:'2026-09-29',total:42}]) {
  let opportunities=0,requests=0;const failures:string[]=[];
  await expect(completeBoundedWholeWorkloadRequest({limit:3,
   request:async()=>{requests++;return {state:'complete',output:wrongOutput};},
   complete:result=>result.output?.day==='2026-09-30',
   advanceRoles:async()=>{opportunities++;failures.push('publication application');},
   exhaustedMessage:'exact outputs incomplete'})).rejects.toThrow('exact outputs incomplete');
  expect({opportunities,requests}).toEqual({opportunities:3,requests:3});expect(failures).toHaveLength(3);
 }
});

it('records changing local database footprint without summing it into write or wire bytes',async()=>{
 const values=[8192,16384,12288],profile=createAnalyticsProfile();
 const db=profileAnalyticsDatabase(database(()=>values.shift()!),'target',profile,()=> 'cleanup');
 for(let i=0;i<3;i++)await db.prepare('SELECT 1').first();
 const summary=summarizeAnalyticsProfile(profile);
 expect(summary.databaseSizeObservations.target).toEqual({firstBytes:8192,lastBytes:12288,maximumBytes:16384,samples:3,unavailableSamples:0});
 expect(summary.statements).toBe(3);expect(summary.rowsWritten).toBe(0);
 expect(summary.totalCheckpointPayloadBytesSubmitted).toBe(0);
 expect(summary.checkpointPayloadByteContract).toContain('subset');
 expect(summary.databaseSizeObservations.source).toBeUndefined();
});
it('prices only measured D1 rows and keeps total cost and billable entry counts unknown',async()=>{
 const measured=createWholeWorkloadMeter(database(),database());
 await measured.invocation('publication_schedule',async db=>{await db.target.prepare('SELECT 1').first();});
 const summary=summarizeWholeWorkload(measured.profile);
 expect(summary.operationInvocations).toEqual({publication_schedule:1});
 expect(summary.measuredD1SubtotalUsd).toBe(0.000000003);
 expect(summary.resourceRateBasis.id).toBe('cloudflare-paid-standard-gross-2026-10-01');
 expect(summary.cost).toBeNull();expect(summary.costUnavailableReason).toContain('not billable request counts');
 expect(summary.databaseSizeObservations.target).toEqual({firstBytes:null,lastBytes:null,maximumBytes:null,samples:0,unavailableSamples:1});
});

it('measures binary bind slices and closed submitted payload shapes without retaining bodies',async()=>{
 const {logicalBytes,logicalJson,recordLogicalSubmission}=await import('./helpers/analytics-logical-bytes');
 const bytes=new Uint8Array([0,1,254,255]);expect(logicalJson([bytes.subarray(1,3)])).toBe('[{"$blobHex":"01FE"}]');
 expect(logicalBytes([bytes.buffer])).toBe(new TextEncoder().encode('[{"$blobHex":"0001FEFF"}]').byteLength);
 const stores:Record<string,import('./helpers/analytics-logical-bytes').StoreSubmission>={};
 recordLogicalSubmission(stores,'target','INSERT INTO analytics_canonical_cache_nodes (node_key,payload) VALUES (?,?)',['key','é'],false);
 recordLogicalSubmission(stores,'target',"INSERT INTO analytics_canonical_rolling_rows (segment_key,payload) SELECT ?,json_extract(value,'$.payload') FROM json_each(?) WHERE EXISTS(SELECT 1)",['segment',JSON.stringify([{payload:'三'},{payload:'{}'}])],false);
 recordLogicalSubmission(stores,'target','UPDATE analytics_canonical_cache_nodes SET payload=?2 WHERE node_key=?1',['key','[]'],true);
 recordLogicalSubmission(stores,'target','DELETE FROM analytics_canonical_cache_nodes WHERE node_key=?',['key'],false);
 expect(stores['target.analytics_canonical_cache_nodes']).toMatchObject({statements:3,failedStatements:1,payloadBytes:4,payloadAssignments:2,unknownPayloadStatements:0});
 expect(stores['target.analytics_canonical_rolling_rows']).toMatchObject({payloadBytes:5,unknownPayloadStatements:0});
 expect(JSON.stringify(stores)).not.toContain('segment');expect(JSON.stringify(stores)).not.toContain('三');
 recordLogicalSubmission(stores,'target','UPDATE analytics_canonical_cache_nodes SET payload=substr(?,1)',['x'],false);
 expect(stores['target.analytics_canonical_cache_nodes']!.unknownPayloadStatements).toBe(1);
 recordLogicalSubmission(stores,'target','INSERT INTO analytics_future_store(x) VALUES(?)',[1],false);
 expect(stores['target.unregistered_store']!.unknownPayloadStatements).toBe(1);
});
it('compares every paired source proof row and mutation result while retaining independent metadata',async()=>{
 const {pairAnalyticsSources}=await import('./helpers/analytics-paired-source');
 const db=(row:unknown,changes:number)=>({prepare:()=>{const statement={bind:()=>statement,all:async()=>({results:[row],success:true,meta:{changes}})};return statement;}} as unknown as D1Database);
 const paired=pairAnalyticsSources(db({revision:7},1),db({revision:7},12));
 expect(await paired.database.prepare('UPDATE source SET revision=7 RETURNING revision').first()).toEqual({revision:7});
 expect(paired.proof).toEqual({calls:1,statements:1,returnedRows:1,mutatingStatements:1,divergences:0,physicalFailures:0});
 await expect(pairAnalyticsSources(db({revision:7},1),db({revision:8},1)).database.prepare('SELECT revision FROM source').first()).rejects.toThrow('data/proof divergence');
 await expect(pairAnalyticsSources(db({revision:7},1),db({revision:7},0)).database.prepare('UPDATE source SET revision=7').run()).rejects.toThrow('mutation outcome divergence');
});
it('rejects retained inventory schema drift before reading bodies',async()=>{
 const {snapshotLogicalStores,retainedStoreSql}=await import('./helpers/analytics-logical-bytes');
 const queries:string[]=[];
 const db={prepare:(sql:string)=>{queries.push(sql);return {all:async()=>({results:[{table_name:'analytics_unregistered',column_name:'payload',column_type:'TEXT',cid:0}]})};}} as unknown as D1Database;
 await expect(snapshotLogicalStores(db,'target')).rejects.toThrow('unregistered maintained logical table');
 expect(queries).toHaveLength(1);
 const sql=retainedStoreSql('source','storage_effective_selective_reverse_work');
 expect(sql).toContain("WHEN 'blob' THEN hex(");expect(sql).toContain('count(*) rows');expect(sql).not.toContain('SELECT *');
});

it('counts analytical decoding without retaining calls and restores original parse behavior',async()=>{
 const {installAnalyticalDecodeCounter}=await import('./helpers/analytics-profile');
 const original=JSON.parse,descriptor=Object.getOwnPropertyDescriptor(JSON,'parse');
 const counter=installAnalyticalDecodeCounter();
 try {
  expect(JSON.parse('{"number":2}',(key,value)=>key==='number'?value*3:value)).toEqual({number:6});
  JSON.parse('{"schemaVersion":"usage-event-v1.2"}');
  expect(()=>JSON.parse('{')).toThrow(SyntaxError);
  for(let i=0;i<10_000;i++)JSON.parse('{"unrelated":"ephemeral"}');
  expect(counter.read()).toEqual({calls:10_003,analyticalDecodes:1,retainedCallRecords:0});
  expect(Object.keys(JSON.parse)).not.toContain('mock');
 } finally {counter.restore();counter.restore();}
 expect(JSON.parse).toBe(original);expect(Object.getOwnPropertyDescriptor(JSON,'parse')).toEqual(descriptor);
});
it('accounts the native dependency payload array-page expression without guessing unknown expressions',async()=>{
 const {recordLogicalSubmission}=await import('./helpers/analytics-logical-bytes');
 const stores:Record<string,import('./helpers/analytics-logical-bytes').StoreSubmission>={};
 recordLogicalSubmission(stores,'target',"INSERT INTO analytics_effective_dependency_summaries (scope_key,payload) SELECT json_extract(value,'$[0]'),json_extract(value,'$[5]') FROM json_each(?) WHERE 1",[JSON.stringify([['a',0,0,0,0,'é'],['b',0,0,0,0,null]])],false);
 expect(stores['target.analytics_effective_dependency_summaries']).toMatchObject({payloadBytes:2,payloadAssignments:1,unknownPayloadStatements:0});
});

it('transports every complete DTO member losslessly and refuses unsupported observations',async()=>{
 const {encodeWholeWorkloadValue}=await import('./helpers/analytics-whole-workload');
 expect(encodeWholeWorkloadValue({absent:undefined,zero:-0,array:[null,true,'x',42]})).toEqual(['object',[
  ['absent',['undefined']],['zero',['negative_zero']],['array',['array',[['null'],['boolean',true],['string','x'],['number',42]]]]]]);
 expect(()=>encodeWholeWorkloadValue(NaN)).toThrow('nonfinite');expect(()=>encodeWholeWorkloadValue(new Date())).toThrow('unsupported');
});

it('bounds immutable SQL shape retention independently of number of executed statements',async()=>{
 const {logicalShapeCacheRetention,recordLogicalSubmission}=await import('./helpers/analytics-logical-bytes');
 for(let i=0;i<2200;i++)recordLogicalSubmission({},'source',`SELECT ${i} AS synthetic_value`,[],false);
 expect(logicalShapeCacheRetention()).toEqual({entries:2048,maximumEntries:2048,retainedBindingValues:0});
});


it('keeps native B02/D02 optimizations independent of canonical representation and names the unshared diagnostic',async()=>{
 const {wholeWorkloadOptimizationProfile,wholeWorkloadRoleEnvironment,wholeWorkloadDailyPopulation}=await import('./helpers/analytics-whole-workload');
 const db={source:database(),target:database(),ledger:database()};
 for(const representation of ['native','canonical'] as const){
  const profile=wholeWorkloadOptimizationProfile(representation);
  expect(profile).toMatchObject({sharedFeatures:true,cacheSharedFeatures:true,modelBlocks:true,preparedFold:true,preparedEffectiveUsage:'native-default'});
  const env=wholeWorkloadRoleEnvironment(db,'synthetic','synthetic',profile);
  expect(env.STORAGE_ANALYTICS_SHARED_FEATURES).toBe('enabled');
  expect(env.CACHE_RETENTION_SHARED_FEATURES).toBe('enabled');expect(env.STORAGE_ANALYTICS_MODEL_BLOCKS).toBe('enabled');
  expect(env.STORAGE_ANALYTICS_CANONICAL_PIPELINE==='enabled').toBe(representation==='canonical');
 }
 expect(wholeWorkloadOptimizationProfile('native','unshared-diagnostic')).toMatchObject({
  sharedFeatures:false,modelBlocks:false,performanceBasis:'unshared-oracle-diagnostic-only-v1'});
 const cache=Array.from({length:10},(_,index)=>new Date(Date.parse('2026-09-22T00:00:00.000Z')+index*86_400_000).toISOString().slice(0,10));
 expect(wholeWorkloadDailyPopulation(['2026-09-30'],cache)).toEqual(Array.from({length:17},(_,index)=>
  new Date(Date.parse('2026-09-15T00:00:00.000Z')+index*86_400_000).toISOString().slice(0,10)));
});
it('checks every additional published daily body against the exact analytical clock',()=>{
 const time='2026-10-01T12:00:01.000Z',output={preview:{generatedAt:time},daily:[],publishedDaily:[{
  day:'2026-09-15',stored:[{payload_json:JSON.stringify({releasedAt:time,counts:{usage:0}}),released_at:time}],
  visible:{rows:[],cacheRetention:null,allowanceBreakdownsCache:null}}]};
 const normalized=validateWholeWorkloadPublicationTimes(output,Date.parse(time));
 expect(normalized.output.publishedDaily).toEqual(output.publishedDaily);
 expect(normalized.output.publishedDaily[0]!.stored[0]!.released_at).toBe(time);
});

it('charges local target observer probes to the identical 950 meter and leaves it on success and error',async()=>{
 const base=database();let probe:D1Database|undefined,entered=0,left=0;
 const observer={wrap:(target:D1Database)=>target,enterInvocation(target:D1Database){probe=target;entered++;return()=>{probe=undefined;left++;};}};
 const meter=createWholeWorkloadMeter(base,base,undefined,undefined,undefined,undefined,observer);
 await meter.invocation('probe_success',async(db,budget)=>{await db.target.prepare('SELECT 1').all();await probe!.prepare('SELECT 2').all();expect(budget.queriesUsed).toBe(2);});
 expect(probe).toBeUndefined();await expect(meter.invocation('probe_failure',async()=>{await probe!.prepare('SELECT 3').all();throw Error('synthetic after query');})).rejects.toThrow('synthetic after query');
 expect({entered,left}).toEqual({entered:2,left:2});expect(probe).toBeUndefined();expect(summarizeWholeWorkload(meter.profile)).toMatchObject({statements:3,maximumStatementsPerInvocation:2,invocations:2});
});

it('labels graph consumers from the actual metric and keeps mixed analytics work unclassified',async()=>{
 const {wholeWorkloadSourceConsumer:label}=await import('./helpers/analytics-whole-workload');
 for(const op of ['scoped_graph_request','scoped_graph_production_request','scoped_graph_production_visibility']){
  expect(label(op,'fits')).toBe('scalar');expect(label(op,'model')).toBe('model');expect(label(op)).toBe('unclassified');
 }
 expect(label('analytics_schedule','model')).toBe('unclassified');expect(label('unknown','fits')).toBe('unclassified');
 expect(label('daily_publication')).toBe('daily');expect(label('daily_api_visibility')).toBe('api');expect(label('publication_schedule')).toBe('publication');
 expect(label('cache_build')).toBe('cache');expect(label('logical_inventory_initial')).toBe('fixture');
});
it('keeps read-only C06 diagnostics on separate actual950 meters and refuses writes',async()=>{
 const {createWholeWorkloadSourceDiagnostic}=await import('./helpers/analytics-whole-workload');
 const diagnostics=createWholeWorkloadSourceDiagnostic(database());
 await diagnostics.database.prepare('SELECT 1').all();await diagnostics.database.prepare('EXPLAIN SELECT 1').all();
 await expect(diagnostics.database.prepare('DELETE FROM source_table').all()).rejects.toThrow('C06_DIAGNOSTIC_SQL_BOUND');
 expect(diagnostics.report()).toMatchObject({contract:'c06-separate-readonly-diagnostic-meter-v1',actualStatementLimitPerInvocation:950,separateFromAnalyticalPhase:true,attempted:3,refused:1,profile:{statements:2,maximumStatementsPerInvocation:1,invocations:2}});
});

it('registers only successful consumer entrypoints before the final public proof',async()=>{
 const {wholeWorkloadConsumerCompleted:complete}=await import('./helpers/analytics-whole-workload');
 for(const operation of ['canonical_cache_day_visibility','cache_series','cache_visibility','model_visibility','preview_visibility']){
  expect(complete(operation,null)).toBe(false);expect(complete(operation,undefined)).toBe(false);
 }
 expect(complete('cache_visibility',{status:'pending'})).toBe(false);
 expect(complete('cache_visibility',{status:'ready',aggregate:{}})).toBe(true);
 expect(complete('canonical_cache_day_visibility',{day:'2026-10-01'})).toBe(true);
 expect(complete('daily_api_visibility',{rows:[]})).toBe(true);
 expect(complete('daily_population_visibility',{stored:[],visible:{rows:[]}})).toBe(true);
 expect(complete('daily_population_visibility',{stored:[],visible:null})).toBe(false);
 expect(complete('model_visibility',{})).toBe(false);
 expect(complete('model_visibility',{payload_json:'{}',payload_sha256:'a'.repeat(64)})).toBe(true);
 expect(complete('daily_publication',{state:'deferred'})).toBe(false);
 expect(complete('daily_publication',{state:'unchanged'})).toBe(true);
 expect(complete('scoped_graph_production_request',{state:'complete'})).toBe(true);
 expect(complete('unknown',{state:'complete'})).toBe(false);
});

it('captures immutable operation tags per statement across reversed async and mixed batch completion',async()=>{
 const {C06_STATEMENT_SCOPE}=await import('./helpers/analytics-c06-operation-scope');
 const releases=new Map<string,()=>void>();
 const result={results:[{value:1}],success:true,meta:{rows_read:1,rows_written:0,duration:0,changes:0}};
 const scopes:Record<string,string>={a:'direct_scalar',b:'candidate_model_block',c:'scheduler_features',d:'scheduler_cache'};
 const statement=(sql:string):D1PreparedStatement=>({
  [C06_STATEMENT_SCOPE]:()=>scopes[sql],bind:()=>statement(sql),
  all:async()=>{if(sql==='a'||sql==='b')await new Promise<void>(resolve=>releases.set(sql,resolve));return result;},
 } as unknown as D1PreparedStatement);
 const raw={prepare:statement,batch:async(items:D1PreparedStatement[])=>items.map(()=>result)} as unknown as D1Database;
 const seen:{method:string;scope:string|undefined}[]=[],profile=createAnalyticsProfile();
 const db=profileAnalyticsDatabase(raw,'source',profile,()=> 'scope_capture',row=>seen.push({method:row.method,scope:row.operationScope}));
 const a=db.prepare('a').bind('synthetic').all(),b=db.prepare('b').first();
 releases.get('b')!();await b;releases.get('a')!();await a;
 await db.batch([db.prepare('c').bind(1),db.prepare('d')]);
 expect(seen).toEqual([{method:'first',scope:'candidate_model_block'},{method:'all',scope:'direct_scalar'},
  {method:'batch',scope:'scheduler_features'},{method:'batch',scope:'scheduler_cache'}]);
 expect(summarizeAnalyticsProfile(profile)).toMatchObject({statements:4,rowsRead:4,rowsWritten:0,measurementFailures:0});
 expect(JSON.stringify(profile)).not.toContain('candidate_model_block');
});
it('keeps a closed operation tag on failed statements and refuses malformed private tags',async()=>{
 const {C06_STATEMENT_SCOPE}=await import('./helpers/analytics-c06-operation-scope');
 let calls=0;const raw={prepare:(sql:string)=>({[C06_STATEMENT_SCOPE]:()=>sql==='invalid'?'invented':'scheduler_activity',
  all:async()=>{calls++;throw Error('synthetic SQL failure');}})} as unknown as D1Database;
 const seen:unknown[]=[],profile=createAnalyticsProfile(),db=profileAnalyticsDatabase(raw,'source',profile,()=> 'scope_capture',row=>seen.push({scope:row.operationScope,outcome:row.outcome}));
 await expect(db.prepare('known').all()).rejects.toThrow('synthetic SQL failure');
 await expect(db.prepare('invalid').all()).rejects.toThrow('ANALYTICS_PROFILE_OPERATION_SCOPE');
 expect(calls).toBe(1);expect(seen).toEqual([{scope:'scheduler_activity',outcome:'failed'}]);
 expect(summarizeAnalyticsProfile(profile)).toMatchObject({statements:1,failedStatements:1});
});
