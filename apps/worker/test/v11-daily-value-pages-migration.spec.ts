import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,describe,it,expect} from 'vitest';
import {createV11DailyProjectionValues,foldV11DailyProjectionValues,normalizeV11DailyProjectionValues} from '../src/v11-daily-projection-values';
import {v11UsageRecord} from './helpers/telemetry-v11';
const bindings=env as Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const db=()=>bindings.STORAGE_ANALYTICS_DB,day='2026-09-11';
const migration=()=>bindings.TEST_ANALYTICS_MIGRATIONS.filter(m=>m.name.startsWith('0013'));
beforeEach(async()=>{await reset();await applyD1Migrations(db(),bindings.TEST_ANALYTICS_MIGRATIONS.filter(m=>m.name<'0013'));});
async function seed(records:number){
 const value=foldV11DailyProjectionValues(createV11DailyProjectionValues(day),records?[v11UsageRecord(day,'a')]:[]);
 const {omitted,...rest}=value;const old={...rest,schemaVersion:'v11-daily-projection-values-v1'};
 await db().prepare(`INSERT INTO analytics_v11_projection_work
 (source_id,event_digest,owner_digest,generation_id,manifest_digest,from_day,through_day,next_day,day_records,values_json)
 VALUES(?,?,?,?,?,?,?,?,?,?)`).bind('synthetic','a'.repeat(64),'b'.repeat(64),'synthetic-generation','c'.repeat(64),day,day,day,records,JSON.stringify(old)).run();
 return value;
}
describe('bounded value-page migration',()=>{
 it('upgrades an empty complete legacy checkpoint without changing exact arithmetic',async()=>{
  const expected=await seed(0);await applyD1Migrations(db(),migration());
  const stored=await db().prepare('SELECT values_json FROM analytics_v11_projection_work').first<string>('values_json');
  expect(normalizeV11DailyProjectionValues(JSON.parse(stored!))).toEqual(expected);
  expect(await db().prepare('SELECT COUNT(*) n FROM analytics_v11_value_pages').first('n')).toBe(0);
 });
 it('refuses a partially folded legacy day rather than inventing its absent detail pages',async()=>{
  await seed(1);await expect(applyD1Migrations(db(),migration())).rejects.toThrow('CHECK constraint failed');
  const stored=await db().prepare('SELECT values_json FROM analytics_v11_projection_work').first<string>('values_json');
  expect(JSON.parse(stored!).schemaVersion).toBe('v11-daily-projection-values-v1');
  expect(await db().prepare('SELECT day_records FROM analytics_v11_projection_work').first('day_records')).toBe(1);
 });
});
