import {expect,it} from 'vitest';
import {createAnalyticsPerformanceHistogram,createAnalyticsRoleOutcomeHistogram} from './helpers/analytics-performance-histogram';
import {createAnalyticsProfile,profileAnalyticsDatabase,type AnalyticsStatementObservation} from './helpers/analytics-profile';
import {createWholeWorkloadMeter,summarizeWholeWorkload} from './helpers/analytics-whole-workload';

const FAILURE=new Error('synthetic-private-error');
function database(){
 const statement=(sql:string)=>{
  const all=async()=>{if(sql.includes('FAIL'))throw FAILURE;
   return {success:true,results:[{value:'synthetic-private-result'}],meta:{rows_read:3,rows_written:/UPDATE|INSERT|DELETE/u.test(sql)?2:0,duration:0.25}};};
  const item={bind:()=>item,all,run:all,raw:async()=>[['synthetic-private-raw']]};return item;
 };
 return {prepare:statement,batch:async(statements:D1PreparedStatement[])=>Promise.all(statements.map(row=>row.all()))} as unknown as D1Database;
}
const observation=(patch:Partial<AnalyticsStatementObservation>={}):AnalyticsStatementObservation=>({
 sql:'SELECT one',phase:'owner_metadata',side:'source',family:'other',method:'all',outcome:'success',
 rowsRead:3,rowsWritten:0,databaseMs:0,callWallMs:0,batchWallAllocation:false,boundLogicalBytes:2,resultLogicalBytes:2,...patch});
const addExpected=(profile:ReturnType<typeof createAnalyticsProfile>,count:number)=>{
 profile.costs['owner_metadata.source.other']={statements:count,failedStatements:0,rowsRead:count*3,rowsWritten:0,
  databaseMs:0,statementCallWallMs:0,allocatedBatchWallMs:0,metadataSamples:count,rawHistoryAccessStatements:0,
  serializedBoundBytesSubmitted:count*2,serializedResultBytesRead:count*2};
};

it('exports every metered shape and write across roles/sides/ledger with exact requested-method counters',async()=>{
 const histogram=createAnalyticsPerformanceHistogram({lane:'candidate',workloadPhase:'cold'});
 const meter=createWholeWorkloadMeter(database(),database(),undefined,undefined,database(),histogram.observe);
 meter.setPhase('publication_role');
 await meter.invocation('publication_schedule',async(db,_budget,ledger)=>{
  await db.source.prepare('SELECT private_sql_canary FROM participants WHERE id=?').bind('synthetic-private-bind').first('value');
  await db.source.prepare('SELECT private_sql_canary FROM participants WHERE id=?').bind('other-private-bind').all();
  await db.target.prepare('WITH n AS(SELECT 1) UPDATE analytics_canonical_heads SET a=1').run();
  await db.target.batch([db.target.prepare('INSERT INTO analytics_canonical_heads VALUES(1)'),db.target.prepare('DELETE FROM analytics_canonical_heads')]);
  await ledger!.prepare('SELECT value FROM ledger_private').all();
  for(let i=0;i<12;i++)await db.target.prepare('SELECT value FROM synthetic_private_'+i).all();
  const streams=db.source.prepare('SELECT value FROM telemetry_v12_records WHERE stream=?');
  await streams.bind('usage').all();await streams.bind('quota').all();
 });
 meter.setPhase('final_visibility');
 await meter.invocation('visibility',db=>db.source.prepare('SELECT private_sql_canary FROM participants WHERE id=?').first());
 const report=await histogram.report(meter.profile),summary=summarizeWholeWorkload(meter.profile);
 expect(report.completeForMeteredStatements).toBe(true);expect(report.resourceDimensionsComplete).toBe(true);
 expect(report.entries.length).toBeGreaterThan(10);expect(report.observedStatements).toBe(21);
 expect(report.expectedMeteredStatements).toBe(summary.statements);expect(report.reconciliation.matches).toBe(true);
 expect(report.entries.reduce((sum,row)=>sum+row.rowsWritten,0)).toBe(6);
 expect(report.entries.find(row=>row.side==='ledger')?.statements).toBe(1);
 const repeated=report.entries.find(row=>row.operation==='publication_role'&&row.statements===2)!;
 expect(repeated.methods).toEqual({first:1,all:1,run:0,raw:0,batch:0});
 expect(report.entries.filter(row=>row.methods.batch).reduce((sum,row)=>sum+row.methods.batch,0)).toBe(2);
 expect(report.entries.map(row=>row.family)).toEqual(expect.arrayContaining(['v12_usage','v12_quota']));
 expect(report.noRescanQualified).toBe(false);
 for(const row of report.entries)expect(row.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
 for(const value of ['synthetic-private','private_sql_canary','ledger_private','SELECT','UPDATE'])expect(JSON.stringify(report)).not.toContain(value);
});

it('counts failed single and batch submissions without replacing errors or making unknown resources zero',async()=>{
 const histogram=createAnalyticsPerformanceHistogram({lane:'reference',workloadPhase:'warm'}),profile=createAnalyticsProfile();
 const db=profileAnalyticsDatabase(database(),'source',profile,()=> 'publication_role',histogram.observe);
 await expect(db.prepare('SELECT FAIL').all()).rejects.toBe(FAILURE);
 await expect(db.batch([db.prepare('SELECT FAIL'),db.prepare('SELECT other')])).rejects.toBe(FAILURE);
 const report=await histogram.report(profile);
 expect(report).toMatchObject({completeForMeteredStatements:true,resourceDimensionsComplete:false,observedStatements:3,
  gaps:{failedResourceUnknownStatements:3},reconciliation:{matches:true}});
 expect(report.entries.every(row=>row.resourceDimensionsKnown===false&&row.successfulStatements===0)).toBe(true);
 expect(report.entries.reduce((sum,row)=>sum+row.failedStatements,0)).toBe(3);
 expect(JSON.stringify(report)).not.toContain(FAILURE.message);
});

it('keeps raw/missing metadata invalid and reports its shape without relaxing the main profile',async()=>{
 const histogram=createAnalyticsPerformanceHistogram({lane:'candidate',workloadPhase:'warm'}),profile=createAnalyticsProfile();
 const db=profileAnalyticsDatabase(database(),'target',profile,()=> 'final_visibility',histogram.observe);
 await expect(db.prepare('SELECT raw_private').raw()).rejects.toThrow('requires finite nonnegative D1 metadata');
 const report=await histogram.report(profile);
 expect(profile.measurementFailures).toBe(1);
 expect(report).toMatchObject({completeForMeteredStatements:false,resourceDimensionsComplete:false,
  gaps:{invalidMetadataStatements:1},reconciliation:{matches:true}});
 expect(report.entries[0]).toMatchObject({methods:{raw:1},successfulStatements:0,invalidMetadataStatements:1});
});

it('captures phase at dispatch and leaves a first-column application error as successful SQL',async()=>{
 const histogram=createAnalyticsPerformanceHistogram({lane:'candidate',workloadPhase:'no_op'}),profile=createAnalyticsProfile();
 let phase='owner_metadata';const db=profileAnalyticsDatabase(database(),'source',profile,()=>phase,histogram.observe);
 const pending=db.prepare('SELECT value').all();phase='final_visibility';await pending;
 await expect(db.prepare('SELECT value').first('missing')).rejects.toThrow('first() column unavailable');
 const report=await histogram.report(profile);
 expect(report.entries).toEqual(expect.arrayContaining([
  expect.objectContaining({operation:'owner_metadata',statements:1,methods:expect.objectContaining({all:1})}),
  expect.objectContaining({operation:'final_visibility',failedStatements:0,methods:expect.objectContaining({first:1})})]));
 expect(report.completeForMeteredStatements).toBe(true);
});

it('bounds retained entries at4096 with sticky overflow and count reconciliation failure',async()=>{
 const histogram=createAnalyticsPerformanceHistogram({lane:'candidate',workloadPhase:'cold'}),profile=createAnalyticsProfile();
 for(let i=0;i<4097;i++)histogram.observe(observation({sql:'SELECT shape_'+i}));addExpected(profile,4097);
 const report=await histogram.report(profile);
 expect(report).toMatchObject({maximumEntries:4096,entryCount:4096,observedStatements:4097,
  completeForMeteredStatements:false,gaps:{overflowStatements:1},reconciliation:{matches:false}});
 expect(report.entries).toHaveLength(4096);
 expect((await histogram.report(profile)).gaps.overflowStatements).toBe(1);
});

it('keeps unknown closed fields and counter overflow explicit without emitting their values',async()=>{
 const histogram=createAnalyticsPerformanceHistogram({lane:'candidate',workloadPhase:'cold'}),profile=createAnalyticsProfile();
 histogram.observe(observation({phase:'synthetic-private-operation'}));
 histogram.observe(observation({rowsRead:Number.MAX_SAFE_INTEGER}));histogram.observe(observation({rowsRead:1}));
 addExpected(profile,3);
 const report=await histogram.report(profile);
 expect(report.completeForMeteredStatements).toBe(false);expect(report.gaps.unknownObservations).toBe(1);
 expect(report.gaps.numericOverflows).toBeGreaterThan(0);expect(JSON.stringify(report)).not.toContain('synthetic-private-operation');
});

it('makes observer exceptions sticky while preserving original SQL success and failure',async()=>{
 const histogram=createAnalyticsPerformanceHistogram({lane:'candidate',workloadPhase:'cold'}),profile=createAnalyticsProfile();
 const db=profileAnalyticsDatabase(database(),'source',profile,()=> 'owner_metadata',()=>{throw new Error('private-observer');});
 expect(profile.statementObserverFailures).toBe(0);
 expect(await db.prepare('SELECT value').first('value')).toBe('synthetic-private-result');
 await expect(db.prepare('SELECT FAIL').all()).rejects.toBe(FAILURE);
 const report=await histogram.report(profile);
 expect(profile.statementObserverFailures).toBe(2);expect(report.gaps.observerFailures).toBe(2);
 expect(report.completeForMeteredStatements).toBe(false);
 const reattached=profileAnalyticsDatabase(database(),'target',profile,()=> 'owner_metadata',()=>{});
 expect(profile.statementObserverFailures).toBe(2);
 await reattached.prepare('SELECT value').all();expect(profile.statementObserverFailures).toBe(2);
 const plain=createAnalyticsProfile();await profileAnalyticsDatabase(database(),'source',plain,()=> 'owner_metadata').prepare('SELECT value').all();
 expect(Object.hasOwn(plain,'statementObserverFailures')).toBe(false);
});

it('initializes successful lazy observer profiles without extra getter calls or clearing prior failures',async()=>{
 const first=createAnalyticsProfile(),second=createAnalyticsProfile();let active=first,getterCalls=0,throws=false;
 const db=profileAnalyticsDatabase(database(),'source',()=>{getterCalls++;return active;},()=> 'owner_metadata',()=>{
  if(throws)throw new Error('private-observer');
 });
 expect(getterCalls).toBe(0);expect(Object.hasOwn(first,'statementObserverFailures')).toBe(false);
 await db.prepare('SELECT value').all();expect(getterCalls).toBe(1);expect(first.statementObserverFailures).toBe(0);
 active=second;throws=true;await db.prepare('SELECT value').all();
 expect(getterCalls).toBe(2);expect(second.statementObserverFailures).toBe(1);expect(first.statementObserverFailures).toBe(0);
 throws=false;await db.prepare('SELECT value').all();expect(getterCalls).toBe(3);expect(second.statementObserverFailures).toBe(1);
 active=first;await db.prepare('SELECT value').all();expect(getterCalls).toBe(4);expect(first.statementObserverFailures).toBe(0);
});

it('aggregates all role invocations past four and reconciles whole-role costs without event bodies',async()=>{
 const histogram=createAnalyticsPerformanceHistogram({lane:'candidate',workloadPhase:'cold'}),roles=createAnalyticsRoleOutcomeHistogram();
 const meter=createWholeWorkloadMeter(database(),database(),undefined,undefined,database(),row=>{histogram.observe(row);roles.observe(row);});
 for(let i=0;i<9;i++){
  meter.setPhase('publication_role');roles.begin('publication',meter.profile);
  await meter.invocation('publication_schedule',async(db,_budget,ledger)=>{
   await db.source.prepare('SELECT value').all();await db.target.prepare('UPDATE analytics_canonical_heads SET a=1').run();await ledger!.prepare('SELECT value').all();
  });
  roles.end({role:'publication',event:{state:'deferred',reason:'query_budget',dailyPublications:0,
   canonicalWork:{state:'deferred',reason:'source_prefix_pending',claimed:0},privateBody:'do-not-retain'},eventCount:1,threw:false,profile:meter.profile});
 }
 const report=roles.report(meter.profile);
 expect(report).toMatchObject({completeForRoleInvocations:true,invocations:9,expectedInvocations:9,reconciliation:{matches:true}});
 expect(report.entries).toHaveLength(1);expect(report.entries[0]).toMatchObject({invocations:9,canonicalClaims:'zero',publishedDays:'zero',
  costs:{source:{statements:9},target:{statements:9,rowsWritten:18},ledger:{statements:9}}});
 expect(JSON.stringify(report)).not.toContain('do-not-retain');expect(JSON.stringify(report)).not.toContain('privateBody');
 expect((await histogram.report(meter.profile)).completeForMeteredStatements).toBe(true);
});

it('preserves thrown role costs and reports missing/unknown schedule outcomes as gaps',async()=>{
 const roles=createAnalyticsRoleOutcomeHistogram();
 const meter=createWholeWorkloadMeter(database(),database(),undefined,undefined,database(),roles.observe);
 meter.setPhase('publication_role');roles.begin('publication',meter.profile);
 await expect(meter.invocation('publication_schedule',async db=>{await db.source.prepare('SELECT value').all();throw FAILURE;})).rejects.toBe(FAILURE);
 roles.end({role:'publication',event:{state:'private-state',reason:'private-reason',dailyPublications:'bad'},eventCount:0,threw:true,profile:meter.profile});
 const report=roles.report(meter.profile);
 expect(report).toMatchObject({completeForRoleInvocations:false,invocations:1,expectedInvocations:1,
  gaps:{missingScheduleEvents:1},reconciliation:{matches:true}});
 expect(report.gaps.unknownFields).toBeGreaterThan(0);expect(report.entries[0]).toMatchObject({threw:true,costs:{source:{statements:1}}});
 for(const value of ['private-state','private-reason','bad'])expect(JSON.stringify(report)).not.toContain(value);
});


it('ignores extraneous constructor fields and refuses unknown role labels without serializing them',async()=>{
 const histogram=createAnalyticsPerformanceHistogram({lane:'candidate',workloadPhase:'cold',privateField:'private-constructor'} as Parameters<typeof createAnalyticsPerformanceHistogram>[0]);
 const profile=createAnalyticsProfile(),report=await histogram.report(profile);
 expect(JSON.stringify(report)).not.toContain('private-constructor');expect(JSON.stringify(report)).not.toContain('privateField');
 const roles=createAnalyticsRoleOutcomeHistogram();roles.begin('private-role' as 'publication',profile);
 expect(roles.report(profile)).toMatchObject({completeForRoleInvocations:false,gaps:{unknownFields:1}});
 expect(JSON.stringify(roles.report(profile))).not.toContain('private-role');
});

it('handles direct cache canonical results and all three role costs, with extra events explicit',async()=>{
 const roles=createAnalyticsRoleOutcomeHistogram();
 const meter=createWholeWorkloadMeter(database(),database(),undefined,undefined,database(),roles.observe);
 for(const role of ['analytics','cache','publication'] as const){
  meter.setPhase(role+'_role');roles.begin(role,meter.profile);
  await meter.invocation(role+'_schedule',db=>db.source.prepare('SELECT value').all());
  roles.end({role,event:role==='cache'?{state:'idle',reason:'complete',claimed:0}
   :{state:'progress',reason:'complete',dailyPublications:1},eventCount:role==='analytics'?2:1,threw:false,profile:meter.profile});
 }
 const report=roles.report(meter.profile);
 expect(report).toMatchObject({invocations:3,expectedInvocations:3,completeForRoleInvocations:false,
  gaps:{multipleScheduleEvents:1},reconciliation:{matches:true}});
 expect(report.entries.find(row=>row.role==='cache')).toMatchObject({canonicalState:'idle',canonicalReason:'complete',
  canonicalClaims:'zero',publishedDays:'not_applicable'});
 expect(report.entries.find(row=>row.role==='publication')).toMatchObject({canonicalClaims:'not_applicable',publishedDays:'positive'});
});


it('keeps repeated report reads stable when cross-shape totals overflow',async()=>{
 const histogram=createAnalyticsPerformanceHistogram({lane:'candidate',workloadPhase:'cold'}),profile=createAnalyticsProfile();
 histogram.observe(observation({sql:'SELECT shape_one',rowsRead:Number.MAX_SAFE_INTEGER}));
 histogram.observe(observation({sql:'SELECT shape_two',rowsRead:Number.MAX_SAFE_INTEGER}));addExpected(profile,2);
 const first=await histogram.report(profile),second=await histogram.report(profile);
 expect(first.gaps.reconciliationNumericOverflows).toBeGreaterThan(0);expect(first.completeForMeteredStatements).toBe(false);
 expect(second).toEqual(first);
});
