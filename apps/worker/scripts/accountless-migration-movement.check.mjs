import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedStatements } from './rehearse-release-migrations.mjs';
import { prepareAccountlessMovement, moveAccountlessBatch, transitionAccountlessMovement, accountlessMovementSelection, planAccountlessMovementBatch } from './accountless-migration-movement.mjs';
const worker = join(dirname(fileURLToPath(import.meta.url)), '..');
const sources = readdirSync(join(worker,'migrations')).sort().map(name => ({name,sql:readFileSync(join(worker,'migrations',name),'utf8')}));
const bigRows = (db,sql) => { const statement=db.prepare(sql); statement.setReadBigInts(true); return statement.all(); };
const q = value => '"'+value.replaceAll('"','""')+'"';
function open(path) { const db=new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON'); return db; }
function apply(db,m) { db.exec('BEGIN'); try { db.exec(m.sql); db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(m.name); db.exec('COMMIT'); } catch(e) { db.exec('ROLLBACK'); throw e; } }
function setup(path) {
 const db=open(path); db.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL)');
 sources.slice(0,56).forEach(m=>apply(db,m)); for(const sql of seedStatements('USAGE_MONITOR_DB',2,20)) db.exec(sql); apply(db,sources[56]);
 // Sparse rowids deliberately differ from primary-key order; deleted high-water IDs must survive.
 db.exec("UPDATE telemetry_records SET id=id*101; UPDATE telemetry_v1_records SET id=id*103; UPDATE sqlite_sequence SET seq=9007199254745000 WHERE name IN ('telemetry_records','telemetry_v1_records'); UPDATE web_sessions SET rowid=9007199254742000-rowid; UPDATE telemetry_records SET record_json='{' || char(34) || 'padding' || char(34) || ':' || char(34) || printf('%.*c',16384,'x') || char(34) || '}';");
 // Historical replay fixture: preserve canonical triggers while preparing already-admitted records.
 const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
 for(const trigger of triggers) db.exec(`DROP TRIGGER ${q(trigger.name)}`);
 const owner='synthetic-rehearsal-0', manifest='00000000-0000-4000-8000-000000000001', chunk='chunk:00000000-0000-4000-8000-000000000002', digest='a'.repeat(64);
 db.prepare(`INSERT INTO telemetry_v11_day_manifests(id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,expected_chunk_count,created_at) VALUES(?,?,?,'2026-09-01',?,'local-movement-fixture','{}',1,'2026-09-01')`).run(manifest,owner,owner,digest);
 db.prepare(`INSERT INTO telemetry_v11_chunks(id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,chunk_digest,envelope_digest,parser_version,record_count,r2_key,device_upload_authorization_id,created_at) VALUES(?,?,?,?,'usage','2026-09-01',0,'synthetic',?,?,'local-movement-fixture',2,'synthetic/v11-movement','synthetic-rehearsal-0-chunk-0','2026-09-01')`).run(chunk,manifest,owner,owner,digest,digest);
 for(const [rowid,occurrence] of [[9007199254742001n,'zz-synthetic'],[101n,'aa-synthetic']]) db.prepare(`INSERT INTO telemetry_v11_records(rowid,chunk_id,manifest_id,stream,occurrence_id,observed_at,record_json) VALUES(?,?,?,'usage',?,'2026-09-01','{}')`).run(rowid,chunk,manifest,occurrence);
 db.prepare(`INSERT INTO community_model_history_dependencies(participant_id,day,from_day) VALUES(?,'2026-09-01',date('2026-09-01','-100 days'))`).run(owner);
 for(const trigger of triggers) db.exec(trigger.sql);
 return db;
}
function snapshot(db,tables,descriptors) { return Object.fromEntries(tables.map(t=>[t, bigRows(db,`SELECT ${descriptors[t].hasRowid?'rowid AS __rowid,':''}${descriptors[t].columns.map(q).join(',')} FROM ${q(t)} ORDER BY ${descriptors[t].keys.map(q).join(',')}`)])); }
function objects(db) { return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT GLOB '_accountless_move_*' ORDER BY type,name").all(); }

test('canonical 57→59 movement preserves rowids, high-water marks and values across reopened interrupted batches',()=>{
 const dir=mkdtempSync(join(tmpdir(),'accountless-move-')), path=join(dir,'phased.sqlite'); let db=setup(path), control;
 try {
  db.exec(`VACUUM INTO '${join(dir,'control.sqlite')}'`); control=open(join(dir,'control.sqlite')); apply(control,sources[57]); apply(control,sources[58]);
  let current=prepareAccountlessMovement(db,sources); const before=snapshot(db,current.order,current.descriptors), sequences=bigRows(db,'SELECT * FROM sqlite_sequence ORDER BY name');
  let batches=0, interrupted=0, bytes=0, maxBatch=0;
  for(const phase of ['evacuate','restore']) {
   let injected=false;
   while(current.tableIndex<current.order.length) {
    const table=(phase==='evacuate'?[...current.order].reverse():current.order)[current.tableIndex];
    const from=phase==='evacuate'?table:'_accountless_move_'+table;
    if(!injected && db.prepare(`SELECT 1 FROM ${q(from)} LIMIT 1`).get()) {
     const old=current;
     assert.throws(()=>moveAccountlessBatch(db,{expectedRevision:current.revision,maxRows:3,maxBytes:65536,beforeCommit:({rows})=>{assert.ok(rows>0);throw new Error('synthetic-interruption')}}),/synthetic-interruption/);
     db.close(); db=open(path); current=prepareAccountlessMovement(db,sources); assert.deepEqual(current,old); injected=true; interrupted++;
    }
    const result=moveAccountlessBatch(db,{expectedRevision:current.revision,maxRows:3,maxBytes:65536}); batches++; bytes+=result.bytes; maxBatch=Math.max(maxBatch,result.rows);
    assert.ok(result.rows<=3 && result.bytes<=65536);
    db.close(); db=open(path); current=prepareAccountlessMovement(db,sources);
   }
   current=transitionAccountlessMovement(db,sources,current.revision);
  }
  assert.equal(current.phase,'complete'); assert.equal(interrupted,2); assert.ok(batches>30&&bytes>0&&maxBatch===3);
  assert.deepEqual(snapshot(db,current.order,current.descriptors),before);
  assert.deepEqual(bigRows(db,'SELECT * FROM sqlite_sequence ORDER BY name'),sequences);
  assert.deepEqual(objects(db),objects(control));
  assert.equal(before.telemetry_v11_records.length,2);
  assert.equal(before.community_model_history_dependencies.length,1);
  assert.ok(before.telemetry_v11_records.some(r=>r.__rowid>9007199254740991n));
  assert.deepEqual(db.prepare('SELECT name FROM d1_migrations ORDER BY id').all(),control.prepare('SELECT name FROM d1_migrations ORDER BY id').all());
  // Exhaustive checks belong only to this small fixture's final oracle, never the movement loop.
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.deepEqual(prepareAccountlessMovement(db,sources),current);
  db.exec(`INSERT INTO telemetry_records(participant_id,record_kind,occurrence_id,observed_at,provider,model_id,input_uncached_tokens,output_text_tokens,record_json) SELECT participant_id,record_kind,'synthetic-high-water-continuation',observed_at,provider,model_id,input_uncached_tokens,output_text_tokens,'{}' FROM telemetry_records LIMIT 1`);
  assert.equal(bigRows(db,"SELECT id FROM telemetry_records WHERE occurrence_id='synthetic-high-water-continuation'")[0].id,9007199254745001n);
  assert.throws(()=>moveAccountlessBatch(db,{expectedRevision:current.revision}),/PHASE_INVALID/);
 }finally{db.close();control?.close();rmSync(dir,{recursive:true,force:true});}
});

test('refuses stale revisions, byte/row limit drift, source drift and early transitions without changing data',()=>{
 const db=setup(':memory:'); try {
  const current=prepareAccountlessMovement(db,sources);
  assert.throws(()=>moveAccountlessBatch(db,{expectedRevision:99}),/REVISION_CONFLICT/);
  assert.throws(()=>transitionAccountlessMovement(db,sources,current.revision),/PHASE_INCOMPLETE/);
  for(const options of [{maxRows:65},{maxRows:0},{maxBytes:1048577},{maxBytes:1.5}]) assert.throws(()=>moveAccountlessBatch(db,{expectedRevision:0,...options}),/LIMIT_INVALID/);
  const drift=structuredClone(sources);drift[58].sql+='\n';assert.throws(()=>prepareAccountlessMovement(db,drift),/SOURCE_INVALID/);
  assert.deepEqual(prepareAccountlessMovement(db,sources),current);
 } finally{db.close();}
});

test('an oversized row is rejected from lengths without evacuating it or advancing its journal',()=>{
 const db=setup(':memory:');try{
  let current=prepareAccountlessMovement(db,sources),seen=false;
  for(let i=0;i<200;i++) {
   try{moveAccountlessBatch(db,{expectedRevision:current.revision,maxBytes:4096});current=prepareAccountlessMovement(db,sources);}
   catch(e){assert.match(e.message,/ROW_TOO_LARGE/);assert.deepEqual(prepareAccountlessMovement(db,sources),current);seen=true;break;}
  }
  assert.equal(seen,true);
 }finally{db.close();}
});

test('actual movement statements use bounded ordered reads and indexed exact-row copy/delete/compare',()=>{
 const db=setup(':memory:');let explained=0;
 try {
  let current=prepareAccountlessMovement(db,sources);
  const observed={exec:sql=>db.exec(sql),prepare(sql){
   const statement=db.prepare(sql);
   return new Proxy(statement,{get(target,key){
    if(['all','get','run'].includes(key))return(...args)=>{
     if((sql.startsWith('SELECT')||sql.startsWith('DELETE')||sql.startsWith('INSERT'))&&!sql.includes('_accountless_move_journal')&&(!sql.includes('_accountless_move_assertion')||sql.includes(' JOIN '))){
      const plans=db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(r=>r.detail);
      assert.equal(plans.some(p=>p.includes('USE TEMP B-TREE')),false);
      if(sql.includes(' AS _bytes '))assert.match(sql,/ORDER BY .+ LIMIT (?:[1-9]|[1-5][0-9]|6[0-4])$/);
      if(sql.includes(' JOIN '))assert.equal(plans.some(p=>/^SCAN [ab]\b/.test(p)),false);
      if(sql.startsWith('DELETE'))assert.ok(plans[0].startsWith('SEARCH '));
      if(sql.startsWith('INSERT'))assert.ok(plans.some(p=>p.startsWith('SEARCH ')));
      explained++;
     }
     return target[key](...args);
    };
    const value=target[key];return typeof value==='function'?value.bind(target):value;
   }});
  }};
  for(const phase of ['evacuate','restore']){
   while(current.tableIndex<current.order.length){moveAccountlessBatch(observed,{expectedRevision:current.revision,maxRows:3,maxBytes:65536});current=prepareAccountlessMovement(db,sources);}
   current=transitionAccountlessMovement(db,sources,current.revision);
  }
  assert.ok(explained>300);
 }finally{db.close();}
});


test('emitted atomic batch refuses replay and changed selected-row metadata with complete rollback',()=>{
 const db=setup(':memory:');try{
  let current=prepareAccountlessMovement(db,sources),selected;
  while(true){const selection=accountlessMovementSelection(current,{maxRows:3});selected=db.prepare(selection.sql).all();if(selected.length)break;moveAccountlessBatch(db,{expectedRevision:current.revision,maxRows:3});current=prepareAccountlessMovement(db,sources);}
  const plan=planAccountlessMovementBatch({current,selectedRows:selected,expectedRevision:current.revision,maxRows:3});
  assert.ok(plan.statements.every(s=>!/^BEGIN|^COMMIT|^ROLLBACK/.test(s.sql)));
  assert.ok(plan.statements.length<=5*3+4);
  const run=statements=>{db.exec('BEGIN IMMEDIATE');try{for(const s of statements)db.prepare(s.sql).run(...s.params);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}};
  const changed=structuredClone(selected);changed[0]._bytes++;
  const bad=planAccountlessMovementBatch({current,selectedRows:changed,expectedRevision:current.revision,maxRows:3});
  assert.throws(()=>run(bad.statements),/constraint failed/);assert.deepEqual(prepareAccountlessMovement(db,sources),current);
  run(plan.statements);const next=prepareAccountlessMovement(db,sources);
  assert.throws(()=>run(plan.statements),/constraint failed/);assert.deepEqual(prepareAccountlessMovement(db,sources),next);
 }finally{db.close();}
});
