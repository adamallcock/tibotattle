import { beforeEach,afterEach,describe,expect,it,vi } from 'vitest';
import { runStorageAnalyticsPass } from '../src/storage-analytics-runtime';
import { runStorageAnalyticsSchedule,type StorageAnalyticsWorkerEnv } from '../src/storage-analytics-worker';
vi.mock('../src/storage-analytics-runtime',()=>({runStorageAnalyticsPass:vi.fn()}));
const pass=vi.mocked(runStorageAnalyticsPass);
const log=vi.fn();
const result={state:'progress' as const,reason:'step_limit' as const,steps:1,recordsRead:0,queriesUsed:0,dailyPublications:0,graphCalculations:0};
function database():D1Database {
 const statement={bind(){return this;},async run(){return {success:true,results:[],meta:{}};}};
 return {prepare(){return statement;}} as unknown as D1Database;
}
function environment():StorageAnalyticsWorkerEnv{return {STORAGE_ANALYTICS_MODE:'enabled',PUBLIC_ANALYTICS_MODE:'enabled',
 STORAGE_SOURCE_ID:'synthetic-source',TELEMETRY_STORAGE_NAMESPACE:'synthetic-namespace',STORAGE_INGESTION_DB:database(),
 STORAGE_ANALYTICS_DB:database(),DELETION_LEDGER:database()};}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(1000);pass.mockReset();log.mockReset();vi.spyOn(console,'log').mockImplementation(log);vi.spyOn(console,'error').mockImplementation(()=>{});});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
describe('ordered ingestion before public analytics',()=>{
 it('reserves delivery time, then uses only the remaining invocation query budget',async()=>{
  pass.mockImplementationOnce(async options=>{
   expect(options).toMatchObject({publishCommunity:false,maxSteps:32,maxQueries:175,deadlineMs:11000});
   for(let i=0;i<175;i++)await options.source.prepare('SELECT 1').run();
   return {...result,steps:16,recordsRead:3200,queriesUsed:175};
  }).mockImplementationOnce(async options=>{
   expect(options).toMatchObject({publishCommunity:true,maxQueries:725,deadlineMs:21000});
   await options.target.prepare('SELECT 1').run();
   return {...result,recordsRead:4,graphCalculations:1};
  });
  await runStorageAnalyticsSchedule(environment());
  expect(pass).toHaveBeenCalledTimes(2);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({steps:17,recordsRead:3204,queriesUsed:176,graphCalculations:1});
 });
 it('stops instead of starting graph work after delivery fails',async()=>{
  pass.mockRejectedValueOnce(new Error('synthetic failure'));
  await expect(runStorageAnalyticsSchedule(environment())).rejects.toThrow('STORAGE_ANALYTICS_UNAVAILABLE');
  expect(pass).toHaveBeenCalledTimes(1);
 });
 it('does not start another phase when an in-flight query overran the overall deadline',async()=>{
  pass.mockImplementationOnce(async()=>{vi.setSystemTime(42000);return {...result,state:'deferred',reason:'deadline'};});
  await runStorageAnalyticsSchedule(environment());
  expect(pass).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({state:'deferred',reason:'deadline'});
 });
 it('keeps publication-disabled delivery as one bounded pass',async()=>{
  pass.mockResolvedValue(result);
  await runStorageAnalyticsSchedule({...environment(),PUBLIC_ANALYTICS_MODE:'disabled'});
  expect(pass).toHaveBeenCalledTimes(1);
  expect(pass.mock.calls[0]![0]).toMatchObject({publishCommunity:false,maxQueries:900,deadlineMs:21000});
 });
 it('does no work when the scheduler is disabled',async()=>{
  await runStorageAnalyticsSchedule({STORAGE_ANALYTICS_MODE:'disabled'});
  expect(pass).not.toHaveBeenCalled();
 });
});
