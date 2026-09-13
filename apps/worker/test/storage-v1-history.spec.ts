import { env,reset,applyD1Migrations,type D1Migration } from 'cloudflare:test';
import { beforeEach,describe,it,expect } from 'vitest';
import { advanceStorageV1HistoricalAnalysis,type StorageV1HistoryCheckpoint } from '../src/storage-v1-history';
import { seedModelHistoryFixture,modelHistorySourceInput,MODEL_HISTORY_TEST_DAY as day } from './helpers/model-history';
const db=()=>env.USAGE_MONITOR_DB;
beforeEach(async()=>{await reset();await applyD1Migrations(db(),(env as Env&{TEST_MIGRATIONS:D1Migration[]}).TEST_MIGRATIONS);});
const budget=(remainingQueries=1000)=>({remainingQueries,deadlineMs:Date.now()+60000});
function readOnly(){let queries=0;const source=new Proxy(db(),{get(database,key){if(key==='prepare')return(sql:string)=>{
 if(!/^\s*(SELECT|WITH)\b/i.test(sql))throw new Error('synthetic source write refused');queries++;return database.prepare(sql);};
 const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;}});return {source,count:()=>queries};}
describe('source-only resumable v1 historical composition',()=>{
 it('resumes acquisition across query deadlines, retains finished evidence, and matches uninterrupted historical fitting',async()=>{
  const fixture=await seedModelHistoryFixture(),input=await modelHistorySourceInput(fixture.participantId),measured=readOnly();
  const args={source:measured.source,participantId:fixture.participantId,day,sourcePin:input.sourcePin};
  let checkpoint:StorageV1HistoryCheckpoint|null=null,passes=0;
  while(checkpoint?.phase!=='finish'){
   const allocation=budget(11),before=measured.count();
   const result=await advanceStorageV1HistoricalAnalysis({...args,budget:allocation,checkpoint});
   expect(result.status).toBe('deferred');if(result.status!=='deferred')throw new Error('expected deferred');
   checkpoint=JSON.parse(JSON.stringify(result.checkpoint));
   expect(measured.count()-before).toBeLessThanOrEqual(11-allocation.remainingQueries);
   expect(++passes).toBeLessThan(20);
  }
  expect(passes).toBeGreaterThan(1);
  const finishedCheckpoint=structuredClone(checkpoint);
  const short=await advanceStorageV1HistoricalAnalysis({...args,budget:budget(10),checkpoint});
  expect(short).toEqual({status:'deferred',checkpoint:finishedCheckpoint});
  const resumed=await advanceStorageV1HistoricalAnalysis({...args,budget:budget(),checkpoint});
  let uninterrupted=await advanceStorageV1HistoricalAnalysis({...args,budget:budget()});
  for(let i=0;i<20&&uninterrupted.status==='deferred';i++)uninterrupted=await advanceStorageV1HistoricalAnalysis({...args,budget:budget(),checkpoint:uninterrupted.checkpoint});
  expect(resumed).toEqual(uninterrupted);expect(resumed).toMatchObject({status:'complete',analysis:{status:'ready'}});
  expect(checkpoint).toEqual(finishedCheckpoint);
 });
 it('refuses changed source/day checkpoints and spends nothing before admission',async()=>{
  const fixture=await seedModelHistoryFixture(),input=await modelHistorySourceInput(fixture.participantId),measured=readOnly();
  const args={source:measured.source,participantId:fixture.participantId,day,sourcePin:input.sourcePin};
  expect(await advanceStorageV1HistoricalAnalysis({...args,budget:budget(9)})).toEqual({status:'deferred',checkpoint:null});
  expect(measured.count()).toBe(0);
  const replaySmall=await advanceStorageV1HistoricalAnalysis({...args,budget:budget(11)});
  const replayLarge=await advanceStorageV1HistoricalAnalysis({...args,budget:budget(1000)});
  expect(replayLarge).toEqual(replaySmall);
  const pending=await advanceStorageV1HistoricalAnalysis({...args,budget:budget(11)});
  if(pending.status!=='deferred'||!pending.checkpoint)throw new Error('expected checkpoint');
  await expect(advanceStorageV1HistoricalAnalysis({...args,budget:budget(),checkpoint:{...pending.checkpoint,day:'2026-09-04'}})).rejects.toThrow('CHECKPOINT_MISMATCH');
  await db().prepare("UPDATE telemetry_v1_chunks SET parser_version='synthetic-changed'").run();
  await expect(advanceStorageV1HistoricalAnalysis({...args,budget:budget(),checkpoint:pending.checkpoint})).rejects.toThrow('source changed');
 });
});
