import { beforeEach,afterEach,describe,expect,it,vi } from 'vitest';
import { runStorageAnalyticsPass } from '../src/storage-analytics-runtime';
import { runStorageAnalyticsSchedule,STORAGE_ANALYTICS_LONG_PASS_MINUTES,STORAGE_ANALYTICS_MINUTE_CRON,
 type StorageAnalyticsWorkerEnv } from '../src/storage-analytics-worker';
vi.mock('../src/storage-v11-history',()=>({
 storageV11PreparedFoldEnabled:(env:unknown)=>!!env&&typeof env==='object'
  &&Reflect.get(env,'GRAPH_DAY_PROJECTION_FOLD')==='enabled'}));
vi.mock('../src/storage-analytics-runtime',()=>({runStorageAnalyticsPass:vi.fn(),
 // The scheduler reads the builder's deployment switch from this module; the
 // mock keeps the real predicate so these passes stay builder-free by default.
 graphDayProjectionBuildEnabled:(env:unknown)=>!!env&&typeof env==='object'
  &&Reflect.get(env,'GRAPH_DAY_PROJECTION_BUILD')==='enabled'}));
const pass=vi.mocked(runStorageAnalyticsPass);
const log=vi.fn(),errorLog=vi.fn();
const result={state:'progress' as const,reason:'step_limit' as const,steps:1,recordsRead:0,queriesUsed:0,dailyPublications:0,graphCalculations:0};
const sourceProbe={sourceId:'synthetic-source',v1Namespace:'synthetic-namespace',
 v11Namespace:'synthetic-namespace',authorityEpoch:12};
const targetProbe={sourceId:'synthetic-source',sourceNamespace:'synthetic-namespace',
 contractVersion:1,cursorSequence:8,cursorEpoch:12};
type Probe={source?:Record<string,unknown>|null;target?:Record<string,unknown>|null;
 onRead?:()=>void};
function database(role:'source'|'target'|'ledger',row:Record<string,unknown>|null,onRead?:()=>void):D1Database {
 return {prepare(sql:string){return {bind(){return this;},
  async first(){
   if(role==='source'&&!sql.includes('FROM storage_source_state s')
    ||role==='target'&&!sql.includes('FROM analytics_runtime_sources r'))throw new Error('unexpected probe');
   onRead?.();
   return row;
  },async run(){return {success:true,results:[],meta:{}};}};}} as unknown as D1Database;
}
function environment(probe:Probe={}):StorageAnalyticsWorkerEnv{return {STORAGE_ANALYTICS_MODE:'enabled',PUBLIC_ANALYTICS_MODE:'enabled',
 STORAGE_SOURCE_ID:'synthetic-source',TELEMETRY_STORAGE_NAMESPACE:'synthetic-namespace',
 STORAGE_INGESTION_DB:database('source',probe.source===undefined?sourceProbe:probe.source,probe.onRead),
 STORAGE_ANALYTICS_DB:database('target',probe.target===undefined?targetProbe:probe.target,probe.onRead),
 DELETION_LEDGER:database('ledger',null)};}
/** A fixed synthetic instant. Its UTC minute is not a multiple of ten, so an
 * invocation that names no minute runs the ordinary two-phase pass. */
const at=(minute:number)=>Date.UTC(2026,8,17,1,minute,0),NOW=at(7);
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(NOW);pass.mockReset();log.mockReset();errorLog.mockReset();
 vi.spyOn(console,'log').mockImplementation(log);vi.spyOn(console,'error').mockImplementation(errorLog);});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
describe('ordered ingestion before public analytics',()=>{
 it('reserves delivery time, then uses only the remaining invocation query budget',async()=>{
  pass.mockImplementationOnce(async options=>{
   expect(options).toMatchObject({publishCommunity:false,maxSteps:32,maxQueries:175,deadlineMs:NOW+10_000});
   for(let i=0;i<175;i++)await options.source.prepare('SELECT 1').run();
   return {...result,steps:16,recordsRead:3200,queriesUsed:175};
  }).mockImplementationOnce(async options=>{
   expect(options).toMatchObject({publishCommunity:true,publicOnly:true,maxSteps:32,maxQueries:773,deadlineMs:NOW+55_000});
   await options.target.prepare('SELECT 1').run();
   return {...result,steps:2,recordsRead:0,queriesUsed:1,graphCalculations:1};
  });
  await runStorageAnalyticsSchedule(environment());
  expect(pass).toHaveBeenCalledTimes(2);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({steps:18,recordsRead:3200,queriesUsed:178,
   deliverySteps:16,deliveryRecordsRead:3200,deliveryQueriesUsed:175,
   publicIterations:2,publicRecordsRead:0,publicQueriesUsed:1,graphCalculations:1,
   recoveryAdmitted:false,deliveryElapsedMs:0});
 });
 it('stops instead of starting graph work after delivery fails',async()=>{
  pass.mockRejectedValueOnce(new Error('synthetic failure'));
  await expect(runStorageAnalyticsSchedule(environment())).rejects.toThrow('STORAGE_ANALYTICS_UNAVAILABLE');
  expect(pass).toHaveBeenCalledTimes(1);
 });
 it('does not start another phase when an in-flight query overran the overall deadline',async()=>{
  pass.mockImplementationOnce(async()=>{vi.setSystemTime(NOW+57_000);return {...result,state:'deferred',reason:'deadline'};});
  await runStorageAnalyticsSchedule(environment());
  expect(pass).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({state:'deferred',reason:'deadline',
   deliverySteps:1,deliveryRecordsRead:0,deliveryQueriesUsed:0,publicIterations:0,publicRecordsRead:0,publicQueriesUsed:0});
 });
 it('does not extend the shared deadline after slow delivery',async()=>{
  pass.mockImplementationOnce(async()=>{vi.setSystemTime(NOW+41_000);return result;})
   .mockImplementationOnce(async options=>{
    expect(options.deadlineMs).toBe(NOW+55_000);
    expect(options.deadlineMs!-Date.now()).toBe(14000);
    expect(options).toMatchObject({publishCommunity:true,publicOnly:true});
    return result;
   });
  await runStorageAnalyticsSchedule(environment());
  expect(pass).toHaveBeenCalledTimes(2);
 });
 it('uses the rest of an ordinary minute only for a verified authority gap',async()=>{
  pass.mockImplementationOnce(async options=>{
   expect(options).toMatchObject({publishCommunity:false,maxSteps:32,maxQueries:850,deadlineMs:NOW+45_000});
   for(let i=0;i<200;i++)await options.source.prepare('SELECT 1').run();
   vi.setSystemTime(NOW+39_000);
   return {...result,steps:32,recordsRead:640,queriesUsed:200};
  });
  await runStorageAnalyticsSchedule(environment({target:{...targetProbe,cursorEpoch:11}}));
  expect(pass).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({state:'deferred',reason:'step_limit',
   recoveryAdmitted:true,deliveryElapsedMs:39000,deliverySteps:32,deliveryRecordsRead:640,
   deliveryQueriesUsed:200,publicIterations:0,queriesUsed:202});
 });
 it('still opens the public phase when recovery delivery completes within the shared caps',async()=>{
  pass.mockImplementationOnce(async options=>{
   expect(options.maxQueries).toBe(850);
   for(let i=0;i<548;i++)await options.source.prepare('SELECT 1').run();
   vi.setSystemTime(NOW+35_000);
   return {...result,state:'idle',reason:'complete',queriesUsed:548};
  }).mockImplementationOnce(async options=>{
   expect(options).toMatchObject({publishCommunity:true,publicOnly:true,
    maxQueries:400,deadlineMs:NOW+55_000});
   for(let i=0;i<400;i++)await options.target.prepare('SELECT 1').run();
   expect(()=>options.target.prepare('SELECT 1').run()).toThrow();
   return {...result,queriesUsed:400};
  });
  await runStorageAnalyticsSchedule(environment({target:{...targetProbe,cursorEpoch:11}}));
  expect(pass).toHaveBeenCalledTimes(2);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({recoveryAdmitted:true,
   deliveryElapsedMs:35000,deliveryQueriesUsed:548,publicQueriesUsed:400,queriesUsed:950});
 });
 it('defers public work when recovered delivery leaves too little budget',async()=>{
  pass.mockImplementationOnce(async options=>{
   for(let i=0;i<850;i++)await options.source.prepare('SELECT 1').run();
   return {...result,state:'idle',reason:'complete',queriesUsed:850};
  });
  await runStorageAnalyticsSchedule(environment({target:{...targetProbe,cursorEpoch:11}}));
  expect(pass).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({state:'deferred',reason:'query_budget',
   recoveryAdmitted:true,deliveryQueriesUsed:850,publicIterations:0,queriesUsed:852});
 });
 it('bounds recovery by the scheduled minute when startup is delayed',async()=>{
  vi.setSystemTime(NOW+20_000);pass.mockResolvedValue(result);
  await runStorageAnalyticsSchedule(environment({target:{...targetProbe,cursorEpoch:11}}),{nowMs:NOW});
  expect(pass.mock.calls[0]![0]).toMatchObject({maxQueries:850,deadlineMs:NOW+45_000});
  expect(pass).toHaveBeenCalledTimes(1);
 });
 it('keeps the ordinary delivery allowance when the metadata probe leaves under five seconds',async()=>{
  let reads=0;pass.mockResolvedValue(result);
  await runStorageAnalyticsSchedule(environment({target:{...targetProbe,cursorEpoch:11},
   onRead:()=>{if(++reads===2)vi.setSystemTime(NOW+41_000);}}));
  expect(reads).toBe(2);
  expect(pass.mock.calls[0]![0]).toMatchObject({maxQueries:175,deadlineMs:NOW+10_000});
  expect(JSON.parse(log.mock.calls[0]![0] as string).recoveryAdmitted).toBe(false);
 });
 it('does not extend work after a metadata probe overruns the outer deadline',async()=>{
  let reads=0;pass.mockResolvedValue(result);
  await runStorageAnalyticsSchedule(environment({target:{...targetProbe,cursorEpoch:11},
   onRead:()=>{if(++reads===2)vi.setSystemTime(NOW+56_000);}}));
  expect(pass.mock.calls[0]![0]).toMatchObject({maxQueries:175,deadlineMs:NOW+10_000});
  expect(pass).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({state:'deferred',
   reason:'deadline',recoveryAdmitted:false,publicIterations:0});
 });
 it('reports metadata read errors without logging provider details',async()=>{
  await expect(runStorageAnalyticsSchedule(environment({onRead:()=>{
   throw new Error('D1 secret row');}}))).rejects.toThrow('STORAGE_ANALYTICS_UNAVAILABLE');
  expect(pass).not.toHaveBeenCalled();
  expect(JSON.parse(errorLog.mock.calls[0]![0] as string)).toEqual({event:'storage_analytics_schedule',
   state:'unavailable'});
 });
 it('does not open public work after a recovery query or deadline deferral',async()=>{
  pass.mockImplementationOnce(async()=>{
   vi.setSystemTime(NOW+56_000);
   return {...result,state:'deferred',reason:'deadline'};
  });
  await runStorageAnalyticsSchedule(environment({target:{...targetProbe,cursorEpoch:11}}));
  expect(pass).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({state:'deferred',reason:'deadline',
   recoveryAdmitted:true,deliveryElapsedMs:56000,publicIterations:0});
 });
 it('never admits recovery from missing, malformed or mismatched metadata',async()=>{
  const cases:Probe[]=[{source:null},{target:null},
   {source:{...sourceProbe,authorityEpoch:null}},
   {source:{...sourceProbe,authorityEpoch:'12'}},
   {source:{...sourceProbe,sourceId:'different-source'}},
   {source:{...sourceProbe,v11Namespace:'different-namespace'}},
   {target:{...targetProbe,sourceId:'different-source'}},
   {target:{...targetProbe,sourceNamespace:'different-namespace'}},
   {target:{...targetProbe,contractVersion:2}},
   {target:{...targetProbe,cursorSequence:null}},
   {target:{...targetProbe,cursorEpoch:13}}];
  for(const probe of cases){
   pass.mockReset();log.mockReset();pass.mockResolvedValue(result);
   await runStorageAnalyticsSchedule(environment(probe));
   expect(pass).toHaveBeenCalledTimes(2);
   expect(pass.mock.calls[0]![0]).toMatchObject({publishCommunity:false,maxQueries:175,
    deadlineMs:NOW+10_000});
   expect(JSON.parse(log.mock.calls[0]![0] as string).recoveryAdmitted).toBe(false);
  }
 });
 it('keeps publication-disabled delivery as one bounded pass',async()=>{
  pass.mockResolvedValue(result);
  await runStorageAnalyticsSchedule({...environment(),PUBLIC_ANALYTICS_MODE:'disabled'});
  expect(pass).toHaveBeenCalledTimes(1);
  expect(pass.mock.calls[0]![0]).toMatchObject({publishCommunity:false,maxQueries:950,deadlineMs:NOW+20_000});
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({deliverySteps:1,deliveryRecordsRead:0,
   deliveryQueriesUsed:0,publicIterations:0,publicRecordsRead:0,publicQueriesUsed:0});
 });
 it('forwards the prepared-fold switch to the pass only when it is enabled',async()=>{
  pass.mockResolvedValue(result);
  // Unset, then explicitly disabled: the graph lane keeps paging the source.
  await runStorageAnalyticsSchedule(environment());
  expect(pass.mock.calls.at(-1)![0]).not.toHaveProperty('foldGraphDayProjections');
  await runStorageAnalyticsSchedule({...environment(),GRAPH_DAY_PROJECTION_FOLD:'disabled'});
  expect(pass.mock.calls.at(-1)![0]).not.toHaveProperty('foldGraphDayProjections');
  // Enabled: forwarded, and independent of the builder switch.
  await runStorageAnalyticsSchedule({...environment(),GRAPH_DAY_PROJECTION_FOLD:'enabled'});
  expect(pass.mock.calls.at(-1)![0]).toMatchObject({foldGraphDayProjections:true});
  expect(pass.mock.calls.at(-1)![0]).not.toHaveProperty('buildGraphDayProjections');
 });
 it('does no work when the scheduler is disabled',async()=>{
  await runStorageAnalyticsSchedule({STORAGE_ANALYTICS_MODE:'disabled'});
  expect(pass).not.toHaveBeenCalled();
 });
 it('activates durable features and model blocks independently in the public phase',async()=>{
  pass.mockResolvedValue(result);
  await runStorageAnalyticsSchedule(environment());
  expect(pass.mock.calls[1]![0]).not.toHaveProperty('sharedFeatures');
  expect(pass.mock.calls[1]![0]).not.toHaveProperty('modelBlocks');
  pass.mockClear();
  await runStorageAnalyticsSchedule({...environment(),STORAGE_ANALYTICS_SHARED_FEATURES:'enabled'});
  expect(pass.mock.calls[0]![0]).not.toHaveProperty('sharedFeatures');
  expect(pass.mock.calls[1]![0]).toMatchObject({sharedFeatures:true,maxQueries:948});
  expect(pass.mock.calls[1]![0]).not.toHaveProperty('modelBlocks');
  pass.mockClear();
  await runStorageAnalyticsSchedule({...environment(),STORAGE_ANALYTICS_SHARED_FEATURES:'disabled',
   STORAGE_ANALYTICS_MODEL_BLOCKS:'enabled'});
  expect(pass.mock.calls[1]![0]).not.toHaveProperty('sharedFeatures');
  expect(pass.mock.calls[1]![0]).toMatchObject({modelBlocks:true});
  pass.mockClear();
  await runStorageAnalyticsSchedule({...environment(),STORAGE_ANALYTICS_SHARED_FEATURES:'enabled',
   STORAGE_ANALYTICS_MODEL_BLOCKS:'enabled'},{nowMs:at(10)});
  expect(pass.mock.calls[1]![0]).toMatchObject({sharedFeatures:true,modelBlocks:true,graphOnly:true});
 });
 it('rejects malformed durable feature activation before any database work',async()=>{
  for(const field of ['STORAGE_ANALYTICS_SHARED_FEATURES','STORAGE_ANALYTICS_MODEL_BLOCKS'] as const) {
   await expect(runStorageAnalyticsSchedule({...environment(),[field]:'yes' as 'enabled'}))
    .rejects.toThrow('STORAGE_ANALYTICS_FEATURE_CONFIGURATION_INVALID');
  }
  expect(pass).not.toHaveBeenCalled();
 });
});
describe('long graph-only pass on the single minute schedule',()=>{
 const deliveryPhase=(spend:number)=>async(options:Parameters<typeof runStorageAnalyticsPass>[0])=>{
  expect(options).toMatchObject({publishCommunity:false,maxSteps:32,maxQueries:175,deadlineMs:Date.now()+10_000});
  for(let i=0;i<spend;i++)await options.source.prepare('SELECT 1').run();
  return {...result,steps:2,recordsRead:64,queriesUsed:spend};
 };
 it('gives every tenth UTC minute the long window, after the same bounded delivery phase',async()=>{
  for(const minute of [0,10,20,30,40,50]) {
   pass.mockReset();log.mockReset();vi.setSystemTime(at(minute));
   pass.mockImplementationOnce(deliveryPhase(5)).mockImplementationOnce(async options=>{
    expect(options).toMatchObject({publishCommunity:true,publicOnly:true,graphOnly:true,maxSteps:32,
     maxQueries:945,deadlineMs:at(minute)+8*60_000,graphLeaseMs:570_000});
    await options.target.prepare('SELECT 1').run();
    return {...result,steps:3,queriesUsed:99,graphCalculations:1};
   });
   await runStorageAnalyticsSchedule(environment(),{cron:STORAGE_ANALYTICS_MINUTE_CRON,nowMs:at(minute)});
   expect(pass).toHaveBeenCalledTimes(2);
   // One invocation, one meter: the long phase receives what delivery left.
   expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({event:'storage_analytics_long_schedule',
    state:'progress',reason:'step_limit',steps:5,deliverySteps:2,deliveryRecordsRead:64,deliveryQueriesUsed:5,
    publicIterations:3,queriesUsed:6,graphCalculations:1,dailyPublications:0});
  }
 });
 it('does not use authority recovery on a long graph minute',async()=>{
  vi.setSystemTime(at(10));pass.mockResolvedValue(result);
  let reads=0;
  await runStorageAnalyticsSchedule(environment({target:{...targetProbe,cursorEpoch:11},
   onRead:()=>{reads++;}}),{nowMs:at(10)});
  expect(pass.mock.calls[0]![0]).toMatchObject({maxQueries:175,deadlineMs:at(10)+10_000});
  expect(pass.mock.calls[1]![0]).toMatchObject({graphOnly:true,maxQueries:950,
   deadlineMs:at(10)+8*60_000});
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({recoveryAdmitted:false,
   deliveryElapsedMs:0,queriesUsed:0});
  expect(reads).toBe(0);
 });
 it('keeps every other minute on the two-phase pass',async()=>{
  for(const minute of [1,7,9,11,59]) {
   pass.mockReset();log.mockReset();vi.setSystemTime(at(minute));pass.mockResolvedValue(result);
   await runStorageAnalyticsSchedule(environment(),{cron:STORAGE_ANALYTICS_MINUTE_CRON,nowMs:at(minute)});
   expect(pass).toHaveBeenCalledTimes(2);
   expect(pass.mock.calls[1]![0]).toMatchObject({publishCommunity:true,publicOnly:true,deadlineMs:at(minute)+55_000});
   expect(pass.mock.calls[1]![0]!.graphOnly).toBeUndefined();
   expect(pass.mock.calls[1]![0]!.graphLeaseMs).toBeUndefined();
   expect(JSON.parse(log.mock.calls[0]![0] as string).event).toBe('storage_analytics_schedule');
  }
 });
 it('selects the pass from the scheduled minute and never from the delivered expression',async()=>{
  // Overlapping triggers are coalesced into one invocation, so the expression
  // the platform reports cannot decide which pass runs.
  pass.mockResolvedValue(result);
  vi.setSystemTime(at(20));
  await runStorageAnalyticsSchedule(environment(),{cron:'*/10 * * * *',nowMs:at(7)});
  expect(pass.mock.calls[1]![0]!.graphOnly).toBeUndefined();
  expect(JSON.parse(log.mock.calls[0]![0] as string).event).toBe('storage_analytics_schedule');
  pass.mockReset();log.mockReset();pass.mockResolvedValue(result);
  await runStorageAnalyticsSchedule(environment(),{cron:STORAGE_ANALYTICS_MINUTE_CRON,nowMs:at(20)});
  expect(pass.mock.calls[1]![0]).toMatchObject({graphOnly:true,graphLeaseMs:570_000});
  expect(JSON.parse(log.mock.calls[0]![0] as string).event).toBe('storage_analytics_long_schedule');
  // With no named instant the invocation's own clock decides.
  pass.mockReset();log.mockReset();pass.mockResolvedValue(result);
  await runStorageAnalyticsSchedule(environment());
  expect(pass.mock.calls[1]![0]).toMatchObject({graphOnly:true});
  expect(STORAGE_ANALYTICS_LONG_PASS_MINUTES).toBe(10);
 });
 it('stays on the bounded pass at a tenth minute when publication is deployed off',async()=>{
  vi.setSystemTime(at(30));pass.mockResolvedValue(result);
  await runStorageAnalyticsSchedule({...environment(),PUBLIC_ANALYTICS_MODE:'disabled'},
   {cron:STORAGE_ANALYTICS_MINUTE_CRON,nowMs:at(30)});
  expect(pass).toHaveBeenCalledTimes(1);
  expect(pass.mock.calls[0]![0]).toMatchObject({publishCommunity:false,maxQueries:950,deadlineMs:at(30)+20_000});
  expect(pass.mock.calls[0]![0]!.graphOnly).toBeUndefined();
  expect(JSON.parse(log.mock.calls[0]![0] as string).event).toBe('storage_analytics_schedule');
 });
 it('does no long work when the scheduler is disabled',async()=>{
  vi.setSystemTime(at(0));
  await runStorageAnalyticsSchedule({STORAGE_ANALYTICS_MODE:'disabled'},{nowMs:at(0)});
  expect(pass).not.toHaveBeenCalled();expect(log).not.toHaveBeenCalled();
 });
 it('refuses a cron or a scheduled instant of the wrong shape before any database work',async()=>{
  for(const invalid of [{cron:600 as unknown as string},{nowMs:'2026-09-17' as unknown as number},
   {nowMs:1.5},{nowMs:-1}]) {
   await expect(runStorageAnalyticsSchedule(environment(),invalid))
    .rejects.toThrow('STORAGE_ANALYTICS_CONFIGURATION_INVALID');
  }
  expect(pass).not.toHaveBeenCalled();expect(log).not.toHaveBeenCalled();expect(errorLog).not.toHaveBeenCalled();
 });
 it('reports a long-pass failure as a closed code and never as a provider message',async()=>{
  vi.setSystemTime(at(40));
  pass.mockImplementationOnce(deliveryPhase(0)).mockRejectedValueOnce(new Error('STORAGE_GRAPH_WORK_UNAVAILABLE'));
  await expect(runStorageAnalyticsSchedule(environment(),{nowMs:at(40)}))
   .rejects.toThrow('STORAGE_ANALYTICS_UNAVAILABLE');
  expect(JSON.parse(errorLog.mock.calls[0]![0] as string))
   .toEqual({event:'storage_analytics_long_schedule',state:'unavailable',code:'STORAGE_GRAPH_WORK_UNAVAILABLE'});
  errorLog.mockReset();pass.mockReset();
  pass.mockImplementationOnce(deliveryPhase(0)).mockRejectedValueOnce(new Error('D1_ERROR: near "SELECT": owner_digest=0123'));
  await expect(runStorageAnalyticsSchedule(environment(),{nowMs:at(40)}))
   .rejects.toThrow('STORAGE_ANALYTICS_UNAVAILABLE');
  const hidden=errorLog.mock.calls[0]![0] as string;
  expect(JSON.parse(hidden)).toEqual({event:'storage_analytics_long_schedule',state:'unavailable'});
  expect(hidden).not.toContain('owner_digest');
 });
});
