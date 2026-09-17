import { beforeEach,afterEach,describe,expect,it,vi } from 'vitest';
import { runStorageAnalyticsPass } from '../src/storage-analytics-runtime';
import { runStorageAnalyticsSchedule,STORAGE_ANALYTICS_LONG_CRON,STORAGE_ANALYTICS_MINUTE_CRON,
 type StorageAnalyticsWorkerEnv } from '../src/storage-analytics-worker';
vi.mock('../src/storage-analytics-runtime',()=>({runStorageAnalyticsPass:vi.fn()}));
const pass=vi.mocked(runStorageAnalyticsPass);
const log=vi.fn(),errorLog=vi.fn();
const result={state:'progress' as const,reason:'step_limit' as const,steps:1,recordsRead:0,queriesUsed:0,dailyPublications:0,graphCalculations:0};
function database():D1Database {
 const statement={bind(){return this;},async run(){return {success:true,results:[],meta:{}};}};
 return {prepare(){return statement;}} as unknown as D1Database;
}
function environment():StorageAnalyticsWorkerEnv{return {STORAGE_ANALYTICS_MODE:'enabled',PUBLIC_ANALYTICS_MODE:'enabled',
 STORAGE_SOURCE_ID:'synthetic-source',TELEMETRY_STORAGE_NAMESPACE:'synthetic-namespace',STORAGE_INGESTION_DB:database(),
 STORAGE_ANALYTICS_DB:database(),DELETION_LEDGER:database()};}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(1000);pass.mockReset();log.mockReset();errorLog.mockReset();
 vi.spyOn(console,'log').mockImplementation(log);vi.spyOn(console,'error').mockImplementation(errorLog);});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
describe('ordered ingestion before public analytics',()=>{
 it('reserves delivery time, then uses only the remaining invocation query budget',async()=>{
  pass.mockImplementationOnce(async options=>{
   expect(options).toMatchObject({publishCommunity:false,maxSteps:32,maxQueries:175,deadlineMs:11000});
   for(let i=0;i<175;i++)await options.source.prepare('SELECT 1').run();
   return {...result,steps:16,recordsRead:3200,queriesUsed:175};
  }).mockImplementationOnce(async options=>{
   expect(options).toMatchObject({publishCommunity:true,publicOnly:true,maxSteps:32,maxQueries:725,deadlineMs:56000});
   await options.target.prepare('SELECT 1').run();
   return {...result,steps:2,recordsRead:0,queriesUsed:1,graphCalculations:1};
  });
  await runStorageAnalyticsSchedule(environment());
  expect(pass).toHaveBeenCalledTimes(2);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({steps:18,recordsRead:3200,queriesUsed:176,
   deliverySteps:16,deliveryRecordsRead:3200,deliveryQueriesUsed:175,
   publicIterations:2,publicRecordsRead:0,publicQueriesUsed:1,graphCalculations:1});
 });
 it('stops instead of starting graph work after delivery fails',async()=>{
  pass.mockRejectedValueOnce(new Error('synthetic failure'));
  await expect(runStorageAnalyticsSchedule(environment())).rejects.toThrow('STORAGE_ANALYTICS_UNAVAILABLE');
  expect(pass).toHaveBeenCalledTimes(1);
 });
 it('does not start another phase when an in-flight query overran the overall deadline',async()=>{
  pass.mockImplementationOnce(async()=>{vi.setSystemTime(57000);return {...result,state:'deferred',reason:'deadline'};});
  await runStorageAnalyticsSchedule(environment());
  expect(pass).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({state:'deferred',reason:'deadline',
   deliverySteps:1,deliveryRecordsRead:0,deliveryQueriesUsed:0,publicIterations:0,publicRecordsRead:0,publicQueriesUsed:0});
 });
  it('does not extend the shared deadline after slow delivery',async()=>{
  pass.mockImplementationOnce(async()=>{vi.setSystemTime(42000);return result;})
   .mockImplementationOnce(async options=>{
    expect(options.deadlineMs).toBe(56000);
    expect(options.deadlineMs!-Date.now()).toBe(14000);
    expect(options).toMatchObject({publishCommunity:true,publicOnly:true});
    return result;
   });
  await runStorageAnalyticsSchedule(environment());
  expect(pass).toHaveBeenCalledTimes(2);
 });
 it('keeps publication-disabled delivery as one bounded pass',async()=>{
  pass.mockResolvedValue(result);
  await runStorageAnalyticsSchedule({...environment(),PUBLIC_ANALYTICS_MODE:'disabled'});
  expect(pass).toHaveBeenCalledTimes(1);
  expect(pass.mock.calls[0]![0]).toMatchObject({publishCommunity:false,maxQueries:900,deadlineMs:21000});
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({deliverySteps:1,deliveryRecordsRead:0,
   deliveryQueriesUsed:0,publicIterations:0,publicRecordsRead:0,publicQueriesUsed:0});
 });
 it('does no work when the scheduler is disabled',async()=>{
  await runStorageAnalyticsSchedule({STORAGE_ANALYTICS_MODE:'disabled'});
  expect(pass).not.toHaveBeenCalled();
 });
});
describe('long graph-only schedule',()=>{
 it('runs one graph-only pass with its own window and claim lease, and no delivery phase',async()=>{
  pass.mockImplementationOnce(async options=>{
   expect(options).toMatchObject({publishCommunity:true,publicOnly:true,graphOnly:true,maxSteps:32,maxQueries:900,
    deadlineMs:1000+9*60_000,graphLeaseMs:12*60_000});
   // Ordered delivery, erasure and the daily lane stay on the minute schedule.
   expect(options.ledger).toBeUndefined();
   await options.target.prepare('SELECT 1').run();
   return {...result,steps:4,recordsRead:0,queriesUsed:7,graphCalculations:2};
  });
  await runStorageAnalyticsSchedule(environment(),{cron:STORAGE_ANALYTICS_LONG_CRON});
  expect(pass).toHaveBeenCalledTimes(1);
  const logged=JSON.parse(log.mock.calls[0]![0] as string);
  // The log reports the invocation's own measured statements, not the claim.
  expect(logged).toMatchObject({event:'storage_analytics_long_schedule',state:'progress',reason:'step_limit',
   steps:4,queriesUsed:1,dailyPublications:0,graphCalculations:2});
  expect(logged.deliverySteps).toBeUndefined();
  expect(log).toHaveBeenCalledTimes(1);
 });
 it('leaves the minute cron and an unnamed cron on the two-phase pass',async()=>{
  pass.mockResolvedValue(result);
  await runStorageAnalyticsSchedule(environment(),{cron:STORAGE_ANALYTICS_MINUTE_CRON});
  await runStorageAnalyticsSchedule(environment());
  expect(pass).toHaveBeenCalledTimes(4);
  for(const call of pass.mock.calls)expect(call[0]!.graphOnly).toBeUndefined();
  expect(pass.mock.calls[0]![0]).toMatchObject({publishCommunity:false,maxQueries:175,deadlineMs:11000});
  expect(pass.mock.calls[1]![0]).toMatchObject({publishCommunity:true,publicOnly:true,deadlineMs:56000});
  for(const call of log.mock.calls)expect(JSON.parse(call[0] as string).event).toBe('storage_analytics_schedule');
 });
 it('does no long work when the scheduler is disabled',async()=>{
  await runStorageAnalyticsSchedule({STORAGE_ANALYTICS_MODE:'disabled'},{cron:STORAGE_ANALYTICS_LONG_CRON});
  expect(pass).not.toHaveBeenCalled();expect(log).not.toHaveBeenCalled();
 });
 it('does no long work when public analytics is deployed off',async()=>{
  await runStorageAnalyticsSchedule({...environment(),PUBLIC_ANALYTICS_MODE:'disabled'},{cron:STORAGE_ANALYTICS_LONG_CRON});
  expect(pass).not.toHaveBeenCalled();expect(log).not.toHaveBeenCalled();
 });
 it('refuses an incomplete binding configuration on the long cron',async()=>{
  await expect(runStorageAnalyticsSchedule({STORAGE_ANALYTICS_MODE:'enabled',PUBLIC_ANALYTICS_MODE:'enabled'},
   {cron:STORAGE_ANALYTICS_LONG_CRON})).rejects.toThrow('STORAGE_ANALYTICS_CONFIGURATION_INVALID');
  expect(pass).not.toHaveBeenCalled();
 });
 it('refuses a cron that is not a string before any database work',async()=>{
  await expect(runStorageAnalyticsSchedule(environment(),{cron:600 as unknown as string}))
   .rejects.toThrow('STORAGE_ANALYTICS_CONFIGURATION_INVALID');
  expect(pass).not.toHaveBeenCalled();expect(log).not.toHaveBeenCalled();expect(errorLog).not.toHaveBeenCalled();
 });
 it('reports a long-pass failure as a closed code and never as a provider message',async()=>{
  pass.mockRejectedValueOnce(new Error('STORAGE_GRAPH_WORK_UNAVAILABLE'));
  await expect(runStorageAnalyticsSchedule(environment(),{cron:STORAGE_ANALYTICS_LONG_CRON}))
   .rejects.toThrow('STORAGE_ANALYTICS_UNAVAILABLE');
  expect(JSON.parse(errorLog.mock.calls[0]![0] as string))
   .toEqual({event:'storage_analytics_long_schedule',state:'unavailable',code:'STORAGE_GRAPH_WORK_UNAVAILABLE'});
  errorLog.mockReset();
  pass.mockRejectedValueOnce(new Error('D1_ERROR: near "SELECT": owner_digest=0123'));
  await expect(runStorageAnalyticsSchedule(environment(),{cron:STORAGE_ANALYTICS_LONG_CRON}))
   .rejects.toThrow('STORAGE_ANALYTICS_UNAVAILABLE');
  const hidden=errorLog.mock.calls[0]![0] as string;
  expect(JSON.parse(hidden)).toEqual({event:'storage_analytics_long_schedule',state:'unavailable'});
  expect(hidden).not.toContain('owner_digest');
 });
});
