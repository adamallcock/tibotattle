import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,describe,it,expect} from 'vitest';
import {accountScopedHistoricalModelCompositionV1} from '../src/quota-analysis-v1';
import {advanceStorageV1HistoricalAnalysis} from '../src/storage-v1-history';
import {seedModelHistoryFixture,modelHistorySourceInput,insertModelHistoryRecords,pricedModelHistoryUsage,
 MODEL_HISTORY_TEST_DAY as day} from './helpers/model-history';
const db=()=>env.USAGE_MONITOR_DB;
beforeEach(async()=>{await reset();await applyD1Migrations(db(),(env as Env&{TEST_MIGRATIONS:D1Migration[]}).TEST_MIGRATIONS);});
const clean=(value:object)=>{const {inputFingerprint,...rest}=value as Record<string,unknown>;expect(inputFingerprint).toMatch(/^[a-f0-9]{64}$/);return rest;};
async function direct(participantId:string){const {sourcePin}=await modelHistorySourceInput(participantId);return accountScopedHistoricalModelCompositionV1(db(),participantId,day,{sourcePin});}
describe('direct source-only historical composition',()=>{
 it('matches the actual acquired historical kernel with only the closed endpoint-reduction reads',async()=>{
  const fixture=await seedModelHistoryFixture(),{sourcePin}=await modelHistorySourceInput(fixture.participantId);
  let result=await advanceStorageV1HistoricalAnalysis({source:db(),participantId:fixture.participantId,day,sourcePin,budget:{remainingQueries:1000,deadlineMs:Date.now()+60000}});
  for(let i=0;i<20&&result.status==='deferred';i++)result=await advanceStorageV1HistoricalAnalysis({source:db(),participantId:fixture.participantId,day,sourcePin,checkpoint:result.checkpoint,budget:{remainingQueries:1000,deadlineMs:Date.now()+60000}});
  expect(result.status).toBe('complete');if(result.status!=='complete')throw new Error('expected fit');
  expect(result.analysis.status).toBe('ready');expect(await direct(fixture.participantId)).toEqual(result.analysis);
 });
 it('excludes future plan labels, quota boundaries and costs before any window transforms',async()=>{
  const fixture=await seedModelHistoryFixture(),baseline=await direct(fixture.participantId);
  await insertModelHistoryRecords(fixture,'normal-future',[{stream:'quota',observedAt:'2026-09-06T12:00:00.000Z',usedPercent:99,planType:'plus'},
   pricedModelHistoryUsage('gpt-5.6-sol',9000,'2026-09-06T12:00:00.000Z').record]);
  expect(await direct(fixture.participantId)).toEqual(baseline);
  // Defensive old-layout corruption: an admitted day header plus a later
  // source timestamp must not let the day membership bypass the explicit upper.
  await insertModelHistoryRecords(fixture,'synthetic-future-mismatch',[{stream:'quota',observedAt:'2026-09-05T12:00:00.000Z',usedPercent:99,planType:'plus'},
   pricedModelHistoryUsage('gpt-5.6-sol',9000,'2026-09-05T12:00:00.000Z').record]);
  await db().prepare("UPDATE telemetry_v1_records SET observed_at='2026-09-06T12:00:00.000Z' WHERE chunk_row_id LIKE '%synthetic-future-mismatch%'").run();
  expect(clean(await direct(fixture.participantId))).toEqual(clean(baseline));
 });
 it('source-fences a conservative early refusal, including a change during the plan read',async()=>{
  const fixture=await seedModelHistoryFixture();await insertModelHistoryRecords(fixture,'plan-switch',[
   {stream:'quota',observedAt:'2026-09-05T22:00:00.000Z',usedPercent:80,planType:'plus'}]);
  const {sourcePin}=await modelHistorySourceInput(fixture.participantId);
  expect(await direct(fixture.participantId)).toMatchObject({status:'not_testable',reason:'multi_plan_window_unsupported'});
  const measured=new Proxy(db(),{get(database,key){if(key==='prepare')return(sql:string)=>{
   const statement=database.prepare(sql);if(!sql.includes('plan_times AS MATERIALIZED'))return statement;
   const wrap=(value:D1PreparedStatement):D1PreparedStatement=>new Proxy(value,{get(s,k){if(k==='bind')return(...args:unknown[])=>wrap(s.bind(...args));
    if(k==='all')return async()=>{const result=await s.all();await db().prepare("UPDATE telemetry_v1_chunks SET parser_version='synthetic-source-change'").run();return result;};
    const v=Reflect.get(s,k);return typeof v==='function'?v.bind(s):v;}});return wrap(statement);};
   const value=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;}});
  await expect(accountScopedHistoricalModelCompositionV1(measured,fixture.participantId,day,{sourcePin})).rejects.toThrow('source changed');
 });
});
