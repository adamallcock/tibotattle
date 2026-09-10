import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {accountlessRangeSelection,planAccountlessRangeBatch,usesRangeRecordBatch} from './accountless-migration-range.mjs';
const columns=['id','chunk_id','record_json','nullable_value','blob_value'];
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE telemetry_v1_records(id INTEGER PRIMARY KEY,chunk_id TEXT NOT NULL,record_json TEXT NOT NULL,nullable_value TEXT,blob_value BLOB);CREATE TABLE _accountless_move_telemetry_v1_records(_move_key INTEGER PRIMARY KEY,_original_rowid INTEGER,id,chunk_id,record_json,nullable_value,blob_value);CREATE TABLE _accountless_move_journal(id INTEGER PRIMARY KEY CHECK(id=1),metadata TEXT NOT NULL);CREATE TABLE _accountless_move_assertion(id INTEGER PRIMARY KEY CHECK(id=1),ok INTEGER NOT NULL CHECK(ok=1));`);
 const current={digest:'synthetic-range-source',phase:'evacuate',revision:0,tableIndex:0,cursor:0,order:['telemetry_v1_records'],descriptors:{telemetry_v1_records:{columns,hasRowid:true,keys:['rowid'],integerKeys:['rowid']}},sequences:[],canonicalObjects:null,rangeRecordBatches:true};
 save(db,current);
 for(const [i,id] of [-9007199254740993n,-9000n,-1n,0n,72n,9007199254740993n,9223372036854775807n].entries())db.prepare('INSERT INTO telemetry_v1_records VALUES(?,?,?,?,?)').run(id,'synthetic-chunk-'+i,JSON.stringify({value:i}),i%3===0?null:i%3===1?'':'nullable',i%2?new Uint8Array([0,255,i]):null);
 return {db,current};
}
function state(db){return JSON.parse(db.prepare('SELECT metadata FROM _accountless_move_journal WHERE id=1').get().metadata);}
function save(db,current){db.prepare('INSERT OR REPLACE INTO _accountless_move_journal VALUES(1,?)').run(JSON.stringify(current));}
function snapshot(db){const statement=db.prepare('SELECT rowid,* FROM telemetry_v1_records ORDER BY rowid');statement.setReadBigInts(true);return statement.all();}
function plan(db,current,options={}){const query=accountlessRangeSelection(current,options),selection=db.prepare(query.sql).get(...query.params);return planAccountlessRangeBatch({current,selection,expectedRevision:current.revision,...options});}
function execute(db,plan,late=false){db.exec('BEGIN');try{for(const s of plan.statements)db.prepare(s.sql).run(...s.params);if(late)throw Error('synthetic-late-rollback');db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}

test('range batches preserve sparse negative and >2^53 rowids, nullable values and blobs through both phases',()=>{
 const {db,current}=fixture();try{const original=snapshot(db);let checkpoint=current,batches=0;
  for(const phase of ['evacuate','restore']){
   if(phase==='restore'){checkpoint={...checkpoint,phase:'restore',tableIndex:0,cursor:0};save(db,checkpoint);}
   let interrupted=false;while(checkpoint.tableIndex===0){const next=plan(db,checkpoint,{maxRows:2});if(!interrupted){const before=snapshot(db),beforeState=state(db);assert.throws(()=>execute(db,next,true),/synthetic-late-rollback/);assert.deepEqual(snapshot(db),before);assert.deepEqual(state(db),beforeState);interrupted=true;}execute(db,next);checkpoint=state(db);batches++;}
   if(phase==='evacuate')assert.equal(snapshot(db).length,0);
  }
  assert.equal(batches,8);assert.deepEqual(snapshot(db),original);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _accountless_move_telemetry_v1_records').get().n,0);
 }finally{db.close();}
});

test('range rollback, replay and changed admission metadata never leave partial transfers',()=>{
 const {db,current}=fixture();try{
  const original=snapshot(db),batch=plan(db,current,{maxRows:2});assert.throws(()=>execute(db,batch,true),/synthetic-late-rollback/);assert.deepEqual(snapshot(db),original);assert.deepEqual(state(db),current);
  execute(db,batch);const committed=snapshot(db),checkpoint=state(db);assert.throws(()=>execute(db,batch),/CHECK constraint failed/);assert.deepEqual(snapshot(db),committed);assert.deepEqual(state(db),checkpoint);
 }finally{db.close();}
 const next=fixture();try{
  const batch=plan(next.db,next.current,{maxRows:2});next.db.exec("UPDATE telemetry_v1_records SET record_json='changed-and-larger' WHERE id=-9000");const expected=snapshot(next.db);
  assert.throws(()=>execute(next.db,batch),/CHECK constraint failed/);assert.deepEqual(snapshot(next.db),expected);assert.deepEqual(state(next.db),next.current);assert.equal(next.db.prepare('SELECT COUNT(*) AS n FROM _accountless_move_telemetry_v1_records').get().n,0);
 }finally{next.db.close();}
});

test('range caps and malformed selection refuse before execution and empty admission cannot skip rows',()=>{
 const {db,current}=fixture();try{
  assert.equal(usesRangeRecordBatch(current),true);assert.equal(usesRangeRecordBatch({...current,rangeRecordBatches:false}),false);
  for(const maxRows of [0,8193,1.5])assert.throws(()=>accountlessRangeSelection(current,{maxRows}),/ROWS/);
  const query=accountlessRangeSelection(current,{maxRows:2}),selection=db.prepare(query.sql).get();
  for(const change of [{selected_rows:8193},{first_key:'9223372036854775808'},{first_key:1},{first_key:selection.last_key,last_key:selection.first_key},{unexpected:true}])assert.throws(()=>planAccountlessRangeBatch({current,selection:{...selection,...change},expectedRevision:0}),/ACCOUNTLESS_RANGE_/);
  for(const maxBytes of [0,16777217,1.1])assert.throws(()=>planAccountlessRangeBatch({current,selection,expectedRevision:0,maxBytes}),/BYTES/);
  assert.throws(()=>planAccountlessRangeBatch({current,selection:{...selection,selected_bytes:1048577,max_row_bytes:1048577},expectedRevision:0}),/BYTES/);
  assert.throws(()=>planAccountlessRangeBatch({current,selection,expectedRevision:1}),/REVISION/);
  assert.throws(()=>planAccountlessRangeBatch({current:{...current,cursor:Number.MAX_SAFE_INTEGER},selection,expectedRevision:0}),/COUNTER/);
  assert.throws(()=>planAccountlessRangeBatch({current:{...current,revision:Number.MAX_SAFE_INTEGER},selection,expectedRevision:Number.MAX_SAFE_INTEGER}),/COUNTER/);
  const empty=planAccountlessRangeBatch({current,selection:{selected_rows:0,first_key:null,last_key:null,selected_bytes:0,max_row_bytes:0},expectedRevision:0});assert.throws(()=>execute(db,empty),/CHECK constraint failed/);assert.deepEqual(state(db),current);
 }finally{db.close();}
});

test('range copy/delete/compare use integer primary-key searches without temporary sort',()=>{
 const {db,current}=fixture();try{
  for(const phase of ['evacuate','restore']){
   const checkpoint={...current,phase};const selection=accountlessRangeSelection(checkpoint,{maxRows:2});
   const readPlan=db.prepare('EXPLAIN QUERY PLAN '+selection.sql).all();assert.ok(readPlan.every(r=>!r.detail.includes('USE TEMP B-TREE')));
   const batch=planAccountlessRangeBatch({current:checkpoint,selection:{selected_rows:2,first_key:'-9007199254740993',last_key:'-9000',selected_bytes:1,max_row_bytes:1},expectedRevision:0,maxRows:2});
   const mutations=batch.statements.filter(s=>s.sql.startsWith('INSERT INTO "')||s.sql.startsWith('DELETE FROM "')||s.sql.includes(' JOIN '));assert.equal(mutations.length,3);
   for(const s of mutations){const queryPlan=db.prepare('EXPLAIN QUERY PLAN '+s.sql).all(...s.params);assert.ok(queryPlan.some(r=>/SEARCH .*INTEGER PRIMARY KEY/.test(r.detail)),JSON.stringify(queryPlan));assert.ok(queryPlan.every(r=>!r.detail.includes('USE TEMP B-TREE')&&!/^SCAN (?:a|b|telemetry_v1_records|_accountless_move_telemetry_v1_records)\b/.test(r.detail)),JSON.stringify(queryPlan));}
  }
 }finally{db.close();}
});


test('stale selected ranges that gain rows roll back, while a truly empty table advances once',()=>{
 const {db,current}=fixture();try {
  const batch=plan(db,current,{maxRows:2});db.prepare('INSERT INTO telemetry_v1_records VALUES(?,?,?,?,?)').run(-10000,'synthetic-gap','{}',null,null);const before=snapshot(db);
  assert.throws(()=>execute(db,batch),/CHECK constraint failed/);assert.deepEqual(snapshot(db),before);assert.deepEqual(state(db),current);
  db.exec('DELETE FROM telemetry_v1_records');const empty=plan(db,current,{maxRows:2});assert.equal(empty.result.rows,0);execute(db,empty);assert.equal(state(db).tableIndex,1);assert.equal(state(db).cursor,0);assert.throws(()=>execute(db,empty),/CHECK constraint failed/);
 }finally{db.close();}
});
