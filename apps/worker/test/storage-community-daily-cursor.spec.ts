import {applyD1Migrations,env,reset,type D1Migration} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {dailyOwnerCursorMode,readDailyOwnerCursor,advanceDailyOwnerCursor,retireDailyOwnerCursorPage,
 DAILY_OWNER_CURSOR_TABLE_SQL,DAILY_OWNER_CURSOR_GUARD_SQL} from '../src/storage-community-daily-cursor';
import {captureAcceptedSourceTransfer,importAcceptedSourceTransfer} from './helpers/analytics-source-snapshot';
const b=env as Env&{STORAGE_ANALYTICS_DB:D1Database;STORAGE_INGESTION_A:D1Database;TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const sourceId='synthetic-daily-cursor',day='2026-09-01',db=()=>b.STORAGE_ANALYTICS_DB;
async function setup(predecessor=false){
 await reset();await applyD1Migrations(db(),b.TEST_ANALYTICS_MIGRATIONS.filter(row=>!predecessor||row.name<'0034_'));
 await db().prepare('INSERT INTO analytics_runtime_sources VALUES(?,?,1)').bind(sourceId,sourceId).run();
}
async function bounded<T>(fn:(target:D1Database)=>Promise<T>){
 const meter=createD1InvocationBudget(950);try{return await fn(meter.wrap(db()));}
 finally{expect(meter.queriesUsed).toBeLessThanOrEqual(950);}
}

it('requires the fresh cursor contract and preserves the actual0033 predecessor',async()=>{
 await setup(true);expect(await bounded(dailyOwnerCursorMode)).toBe('predecessor');
 await applyD1Migrations(db(),b.TEST_ANALYTICS_MIGRATIONS.filter(row=>row.name>='0034_'));
 expect(await bounded(dailyOwnerCursorMode)).toBe('installed');
 await db().prepare('DROP TRIGGER analytics_community_daily_owner_cursor_update').run();
 expect(await bounded(dailyOwnerCursorMode)).toBe('unavailable');
 await db().prepare(DAILY_OWNER_CURSOR_GUARD_SQL).run();
 expect(await bounded(dailyOwnerCursorMode)).toBe('installed');
 // Even removing BOTH new objects cannot masquerade as the uninstalled frontier.
 await db().prepare('DROP TABLE analytics_community_daily_owner_cursor').run();
 expect(await bounded(dailyOwnerCursorMode)).toBe('unavailable');
 await db().prepare(DAILY_OWNER_CURSOR_TABLE_SQL).run();await db().prepare(DAILY_OWNER_CURSOR_GUARD_SQL).run();
 expect(await bounded(dailyOwnerCursorMode)).toBe('installed');
 await db().prepare('ALTER TABLE analytics_community_daily_owner_cursor ADD COLUMN unreviewed INTEGER').run();
 expect(await bounded(dailyOwnerCursorMode)).toBe('unavailable');
});
it('rejects altered guards and unknown cursor attachments without advancing',async()=>{
 await setup();const initial=await bounded(target=>readDailyOwnerCursor(target,sourceId,day));expect(initial).not.toBeNull();
 await db().prepare('DROP TRIGGER analytics_community_daily_owner_cursor_update').run();
 await db().prepare(DAILY_OWNER_CURSOR_GUARD_SQL.replace('WHEN NEW.cursor_id!=OLD.cursor_id','WHEN 0 AND NEW.cursor_id!=OLD.cursor_id')).run();
 expect(await bounded(dailyOwnerCursorMode)).toBe('unavailable');
 expect(await bounded(target=>advanceDailyOwnerCursor(target,sourceId,day,initial!,1))).toBeNull();
 await db().prepare('DROP TRIGGER analytics_community_daily_owner_cursor_update').run();await db().prepare(DAILY_OWNER_CURSOR_GUARD_SQL).run();
 await db().prepare('CREATE INDEX synthetic_cursor_attachment ON analytics_community_daily_owner_cursor(revision)').run();
 expect(await bounded(dailyOwnerCursorMode)).toBe('unavailable');
 expect(await bounded(target=>advanceDailyOwnerCursor(target,sourceId,day,initial!,1))).toBeNull();
 expect(await bounded(target=>readDailyOwnerCursor(target,sourceId,day))).toEqual(initial);
});
it('claims one numeric turn with exact CAS and independent day positions',async()=>{
 await setup();await bounded(async target=>{
  const first=(await readDailyOwnerCursor(target,sourceId,day))!,other=(await readDailyOwnerCursor(target,sourceId,'2026-09-02'))!;
  expect(first.next_owner_offset).toBe(0);
  const won=await advanceDailyOwnerCursor(target,sourceId,day,first,4);
  expect(won).toEqual({...first,next_owner_offset:4,revision:first.revision+1});
  expect(await advanceDailyOwnerCursor(target,sourceId,day,first,1)).toBeNull();
  expect(await readDailyOwnerCursor(target,sourceId,'2026-09-02')).toEqual(other);
  expect(await advanceDailyOwnerCursor(target,sourceId,day,won!,0)).toEqual({...won,next_owner_offset:0,revision:won!.revision+1});
 });
});
it('rejects identity rewrites, skipped revisions and unsafe numeric cursor values',async()=>{
 await setup();await bounded(async target=>{
  const before=(await readDailyOwnerCursor(target,sourceId,day))!;
  for(const assignment of ['cursor_id=cursor_id+1',"source_id=source_id||'x'","day='2026-09-02'",'revision=revision+2',
   'next_owner_offset=-1,revision=revision+1','next_owner_offset=9007199254740992,revision=revision+1'])
   await expect(target.prepare(`UPDATE analytics_community_daily_owner_cursor SET ${assignment} WHERE cursor_id=?`)
    .bind(before.cursor_id).run()).rejects.toThrow();
  for(const value of [-1,1.5,Number.MAX_SAFE_INTEGER+1])
   await expect(advanceDailyOwnerCursor(target,sourceId,day,before,value)).rejects.toThrow('STORAGE_COMMUNITY_DAILY_CURSOR_UNAVAILABLE');
  await expect(advanceDailyOwnerCursor(target,sourceId,day,{...before,revision:Number.MAX_SAFE_INTEGER},0))
   .rejects.toThrow('STORAGE_COMMUNITY_DAILY_CURSOR_UNAVAILABLE');
  expect(await readDailyOwnerCursor(target,sourceId,day)).toEqual(before);
 });
});
it('retains a committed turn after response loss and refuses stale incarnation after bounded cleanup',async()=>{
 await setup();await bounded(async target=>{
  const before=(await readDailyOwnerCursor(target,sourceId,day))!;
  let injected=false;
  const lost=new Proxy(target,{get(original,key){if(key==='prepare')return(sql:string)=>{
   const statement=original.prepare(sql);
   if(!sql.startsWith('UPDATE analytics_community_daily_owner_cursor'))return statement;
   const wrap=(value:D1PreparedStatement):D1PreparedStatement=>new Proxy(value,{get(stmt,method){
    if(method==='bind')return(...args:unknown[])=>wrap(stmt.bind(...args));
    if(method==='all')return async()=>{await stmt.all();injected=true;throw new Error('SYNTHETIC_CURSOR_RESPONSE_LOST');};
    const member=Reflect.get(stmt,method);return typeof member==='function'?member.bind(stmt):member;
   }});return wrap(statement);
  };const member=Reflect.get(original,key);return typeof member==='function'?member.bind(original):member;}});
  await expect(advanceDailyOwnerCursor(lost,sourceId,day,before,1)).rejects.toThrow('SYNTHETIC_CURSOR_RESPONSE_LOST');
  expect(injected).toBe(true);const committed=(await readDailyOwnerCursor(target,sourceId,day))!;
  expect(committed).toEqual({...before,revision:before.revision+1,next_owner_offset:1});
  expect(await retireDailyOwnerCursorPage(target,sourceId)).toBe(1);
  const recreated=(await readDailyOwnerCursor(target,sourceId,day))!;
  expect(recreated.cursor_id).toBeGreaterThan(committed.cursor_id);
  expect(await advanceDailyOwnerCursor(target,sourceId,day,before,3)).toBeNull();
  expect(await readDailyOwnerCursor(target,sourceId,day)).toEqual(recreated);
 });
});
it('retires at most16 scheduling rows while queued days retain their exact positions',async()=>{
 await setup();await bounded(async target=>{
  for(let n=1;n<=20;n++)await readDailyOwnerCursor(target,sourceId,`2026-09-${String(n).padStart(2,'0')}`);
  await target.prepare('INSERT INTO analytics_community_daily_queue VALUES(?,?,1)').bind(sourceId,day).run();
  const kept=await readDailyOwnerCursor(target,sourceId,day);
  expect(await retireDailyOwnerCursorPage(target,sourceId)).toBe(16);
  expect(await target.prepare('SELECT count(*) n FROM analytics_community_daily_owner_cursor').first('n')).toBe(4);
  expect(await retireDailyOwnerCursorPage(target,sourceId)).toBe(3);
  expect(await readDailyOwnerCursor(target,sourceId,day)).toEqual(kept);
 });
});
it('preserves an empty cursor high-water through exact local target transfer and defeats stale CAS',async()=>{
 await setup();let stale:{cursor_id:number;next_owner_offset:number;revision:number}|null=null;
 await bounded(async target=>{
  stale=await readDailyOwnerCursor(target,sourceId,day);expect(stale).not.toBeNull();
  expect(await retireDailyOwnerCursorPage(target,sourceId)).toBe(1);
 });
 const seq=await db().prepare("SELECT seq FROM sqlite_sequence WHERE name='analytics_community_daily_owner_cursor'").first<number>('seq');
 expect(seq).toBe(stale!.cursor_id);
 // These are separately measured laboratory copy/proof resources, not role work.
 const captured=await captureAcceptedSourceTransfer(db(),'target');
 const copied=await importAcceptedSourceTransfer(captured.transfer,b.STORAGE_INGESTION_A,'target');
 expect(copied.proof).toEqual(captured.transfer.proof);
 const meter=createD1InvocationBudget(950),restored=meter.wrap(b.STORAGE_INGESTION_A);
 expect(await restored.prepare("SELECT seq FROM sqlite_sequence WHERE name='analytics_community_daily_owner_cursor'").first('seq')).toBe(seq);
 expect(await dailyOwnerCursorMode(restored)).toBe('installed');
 const next=(await readDailyOwnerCursor(restored,sourceId,day))!;expect(next.cursor_id).toBeGreaterThan(seq!);
 expect(await advanceDailyOwnerCursor(restored,sourceId,day,stale!,3)).toBeNull();
 expect(await readDailyOwnerCursor(restored,sourceId,day)).toEqual(next);
 expect(await db().prepare('SELECT count(*) n FROM analytics_community_daily_owner_cursor').first('n')).toBe(0);
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);
 console.info(JSON.stringify({event:'daily_cursor_local_restore',exactTransfer:true,emptyHighWaterPreserved:true,staleCasRefused:true,
  capture:captured.profile,import:copied.importProfile,verification:copied.proofProfile}));
},30_000);
