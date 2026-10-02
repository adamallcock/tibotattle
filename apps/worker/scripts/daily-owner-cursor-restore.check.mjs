import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';

const worker=join(dirname(fileURLToPath(import.meta.url)),'..');
const bundle=await build({stdin:{contents:`export * from './src/storage-community-daily-cursor';
 export * from './src/cache-retention-date-cursor';
 export {createD1InvocationBudget} from './src/d1-invocation-budget';`,resolveDir:worker,loader:'ts'},
 bundle:true,platform:'node',format:'esm',write:false});
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const table='analytics_community_daily_owner_cursor',sourceId='synthetic-cursor-physical',day='2026-09-01';
const ledgerSql='CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT';
async function database(predecessor=false){
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(ledgerSql);
  const names=(await readdir(join(worker,'analytics-migrations'))).filter(name=>name.endsWith('.sql')&&(!predecessor||name<'0034_')).sort();
  const {createHash}=await import('node:crypto');
  for(const name of names){
   const sql=await readFile(join(worker,'analytics-migrations',name),'utf8');db.exec(sql);
   db.prepare('INSERT INTO d1_storage_migrations VALUES(?,?)').run(name,createHash('sha256').update(sql).digest('hex'));
  }
  db.exec('PRAGMA foreign_keys=ON');db.prepare('INSERT INTO analytics_runtime_sources VALUES(?,?,1)').run(sourceId,sourceId);
  return db;
 }catch(error){db.close();throw error;}
}
// Executes unchanged product SQL against a local SQLite file. Resource metadata
// is intentionally absent: this is a physical snapshot control, not D1 cost proof.
function adapter(db){
 const prepare=(sql,bindings=[])=>({
  bind:(...args)=>prepare(sql,args),
  async all(){return {success:true,results:db.prepare(sql).all(...bindings),meta:{}};},
  async first(column){const row=db.prepare(sql).get(...bindings);return row===undefined?null:column===undefined?row:row[column];},
  async run(){const result=db.prepare(sql).run(...bindings);return {success:true,results:[],meta:{changes:result.changes}};},
 });
 return {prepare};
}
const quoted=name=>'"'+name.replaceAll('"','""')+'"';
function noncursorRows(db){
 return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name<>? ORDER BY name").all(table)
  .map(({name})=>[name,db.prepare(`SELECT * FROM ${quoted(name)}`).all()]));
}
test('genuine operator0033 frontier retains explicit predecessor behavior and exact maintained DDL refuses loss',async()=>{
 const db=await database(true);
 try{
  const meter=api.createD1InvocationBudget(950),target=meter.wrap(adapter(db));
  assert.equal(await api.dailyOwnerCursorMode(target),'predecessor');
  db.exec(await readFile(join(worker,'analytics-migrations/0034_shared_preparation_work.sql'),'utf8'));
  db.prepare('INSERT INTO d1_storage_migrations VALUES(?,?)').run('0034_shared_preparation_work.sql','a'.repeat(64));
  assert.equal(db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(table).sql,api.DAILY_OWNER_CURSOR_TABLE_SQL);
  assert.equal(db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(table+'_update').sql,api.DAILY_OWNER_CURSOR_GUARD_SQL);
  assert.equal(await api.dailyOwnerCursorMode(target),'installed');
  db.exec(`DROP TABLE ${table}`);assert.equal(await api.dailyOwnerCursorMode(target),'unavailable');
  assert.ok(meter.queriesUsed<=950);
 }finally{db.close();}
});
test('derived physical copy preserves empty AUTOINCREMENT high-water and rejects stale incarnation CAS',async()=>{
 const db=await database(),root=await mkdtemp('/private/tmp/daily-cursor-physical-');let restored;
 try{
  const meter=api.createD1InvocationBudget(950),target=meter.wrap(adapter(db));
  assert.equal(await api.dailyOwnerCursorMode(target),'installed');
  const beforeRows=noncursorRows(db),first=await api.readDailyOwnerCursor(target,sourceId,day);
  const second=await api.readDailyOwnerCursor(target,sourceId,'2026-09-02');assert.ok(second.cursor_id>first.cursor_id);
  const stale=await api.advanceDailyOwnerCursor(target,sourceId,'2026-09-02',second,4);
  assert.equal(await api.retireDailyOwnerCursorPage(target,sourceId),2);
  assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  const high=db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table).seq;assert.equal(high,stale.cursor_id);
  const file=join(root,'derived-snapshot.sqlite');db.prepare('VACUUM main INTO ?').run(file);
  restored=new DatabaseSync(file);restored.exec('PRAGMA foreign_keys=ON');
  assert.deepEqual(restored.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all());
  assert.deepEqual(noncursorRows(restored),beforeRows);assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(),[]);
  const restoredTarget=meter.wrap(adapter(restored));assert.equal(await api.dailyOwnerCursorMode(restoredTarget),'installed');
  const recreated=await api.readDailyOwnerCursor(restoredTarget,sourceId,'2026-09-02');assert.ok(recreated.cursor_id>high);
  assert.equal(await api.advanceDailyOwnerCursor(restoredTarget,sourceId,'2026-09-02',stale,1),null);
  assert.deepEqual(await api.readDailyOwnerCursor(restoredTarget,sourceId,'2026-09-02'),recreated);
  assert.deepEqual(noncursorRows(restored),beforeRows);
  assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  assert.equal(db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table).seq,high);
  assert.ok(meter.queriesUsed<=950);
 }finally{restored?.close();db.close();await rm(root,{recursive:true,force:true});}
});

test('cache date physical copy preserves empty sequence incarnation and exact other tables',async()=>{
 const db=await database(),root=await mkdtemp('/private/tmp/cache-date-cursor-physical-');let restored;
 const dateTable=api.CACHE_DATE_CURSOR_TABLE,owner='b'.repeat(64);
 const rows=database=>Object.fromEntries(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name<>? ORDER BY name").all(dateTable)
  .map(({name})=>[name,database.prepare(`SELECT * FROM ${quoted(name)}`).all()]));
 try{
  db.prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')").run(sourceId,owner);
  const meter=api.createD1InvocationBudget(950),target=meter.wrap(adapter(db));
  assert.equal(await api.cacheDateCursorMode(target),'installed');
  const beforeRows=rows(db),first=await api.initializeCacheDateCursor(target,sourceId,owner,2,9);
  assert.ok(first);assert.equal(await api.retireCacheDateCursorPage(target,sourceId),1);
  assert.equal(db.prepare(`SELECT count(*) n FROM ${dateTable}`).get().n,0);
  const high=db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(dateTable).seq;assert.equal(high,first.cursor_id);
  const file=join(root,'derived-snapshot.sqlite');db.prepare('VACUUM main INTO ?').run(file);
  restored=new DatabaseSync(file);restored.exec('PRAGMA foreign_keys=ON');
  assert.deepEqual(restored.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all());
  assert.deepEqual(rows(restored),beforeRows);assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(),[]);
  const restoredTarget=meter.wrap(adapter(restored));assert.equal(await api.cacheDateCursorMode(restoredTarget),'installed');
  const next=await api.initializeCacheDateCursor(restoredTarget,sourceId,owner,2,9);assert.ok(next.cursor_id>high);
  assert.equal(await api.advanceCacheDateCursor(restoredTarget,sourceId,owner,first,
   {cycle_upper_day:9,next_day:3,next_ordinal:0,day_slot_limit:0}),null);
  assert.deepEqual(await api.readCacheDateCursor(restoredTarget,sourceId,owner),next);
  assert.deepEqual(rows(restored),beforeRows);assert.equal(db.prepare(`SELECT count(*) n FROM ${dateTable}`).get().n,0);
  assert.equal(db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(dateTable).seq,high);
  assert.ok(meter.queriesUsed<=950);
 }finally{restored?.close();db.close();await rm(root,{recursive:true,force:true});}
});
