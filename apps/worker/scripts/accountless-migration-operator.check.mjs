import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { accountlessMovementSelection, planAccountlessMovementBatch } from './accountless-migration-movement.mjs';
import { runAccountlessMovementPhase, renderMovementSql } from './accountless-migration-operator.mjs';
import { buildMutationBarrierSetupStatements, buildMutationBarrierPermissionStatements } from '../src/mutation-barrier.ts';
function fixture(range=false) {
 const db=new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
 const state={digest:'a'.repeat(64),phase:'evacuate',revision:0,tableIndex:0,cursor:0,order:['sample'],descriptors:{sample:{columns:['id','payload'],hasRowid:true,keys:['rowid'],integerKeys:['rowid']}},sequences:[],canonicalObjects:null};
 db.exec(`CREATE TABLE sample(id INTEGER PRIMARY KEY,payload TEXT); INSERT INTO sample VALUES(9007199254741007,'private-key-never-log'),(9007199254741011,'two'),(9007199254741013,'three');
 CREATE TABLE _accountless_move_sample(_move_key INTEGER PRIMARY KEY,_original_rowid INTEGER,id,payload);
 CREATE TABLE _accountless_move_journal(id INTEGER PRIMARY KEY CHECK(id=1),metadata TEXT NOT NULL);
 CREATE TABLE _accountless_move_assertion(id INTEGER PRIMARY KEY CHECK(id=1),ok INTEGER NOT NULL CHECK(ok=1));`);
 db.prepare('INSERT INTO _accountless_move_journal VALUES(1,?)').run(JSON.stringify(state));
 if(range){
  db.exec('ALTER TABLE sample RENAME TO telemetry_v1_records; ALTER TABLE _accountless_move_sample RENAME TO _accountless_move_telemetry_v1_records');
  state.order=['telemetry_v1_records'];state.descriptors={telemetry_v1_records:state.descriptors.sample};state.rangeRecordBatches=true;
  db.prepare('UPDATE _accountless_move_journal SET metadata=?').run(JSON.stringify(state));
 }
 const operation='operator-fixture-20260909';
 const setup=buildMutationBarrierSetupStatements({operationId:operation,sourceRevision:'b'.repeat(40),createdAt:'2026-09-09T00:00:00.000Z',productTables:[range?'telemetry_v1_records':'sample']});
 db.exec(renderMovementSql(setup));
 let calls=0; const plans=[];
 const transport={read:async({sql,params})=>db.prepare(sql).all(...params),batch:async({statements,sql})=>{
  calls++;plans.push(sql);db.exec('BEGIN');try{db.exec(sql);db.exec('COMMIT');return {outcome:'committed'};}catch{db.exec('ROLLBACK');return {outcome:'rolled_back'};}
 }};
 return {db,state,operationId:operation,transport,plans,get calls(){return calls},permission:buildMutationBarrierPermissionStatements(operation)};
}
async function using(run){const f=fixture();try{await run(f)}finally{f.db.close()}}
const run=(f,extra={})=>runAccountlessMovementPhase({startJournal:f.state,operationId:f.operationId,permission:f.permission,transport:f.transport,maxRows:1,...extra});
test('real SQLite completes bounded batches, preserves large rowids and emits content-free progress',()=>using(async f=>{
 const progress=[];const result=await run(f,{onProgress:p=>progress.push(p)});
 assert.equal(result.receipt.outcome,'complete');assert.equal(result.receipt.batches,3);
 assert.deepEqual(f.db.prepare('SELECT CAST(_original_rowid AS TEXT) AS id FROM _accountless_move_sample ORDER BY _move_key').all().map(r=>r.id),['9007199254741007','9007199254741011','9007199254741013']);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM _accountless_migration_barrier_permission_v1').get().n,0);
 assert.doesNotMatch(JSON.stringify({receipt:result.receipt,progress}),/private-key|900719925474|payload|sample/);
 const restore={...result.checkpoint,phase:'restore',revision:result.checkpoint.revision+1,tableIndex:0,cursor:0};
 f.db.prepare('UPDATE _accountless_move_journal SET metadata=? WHERE id=1').run(JSON.stringify(restore));
 assert.equal((await run(f,{startJournal:restore})).receipt.outcome,'complete');
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sample').get().n,3);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM _accountless_move_sample').get().n,0);
}));
test('late atomic SQL failure rolls back permission/data/checkpoint and never retries',()=>using(async f=>{
 const original=f.transport.batch; f.transport.batch=packet=>original({...packet,sql:packet.sql+'\nINSERT INTO _accountless_move_assertion VALUES(1,0);'});
 const result=await run(f);assert.equal(result.receipt.code,'BATCH_ROLLED_BACK');assert.equal(result.receipt.outcome,'stopped');assert.equal(f.calls,1);
 assert.deepEqual(result.checkpoint,f.state);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sample').get().n,3);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM _accountless_migration_barrier_permission_v1').get().n,0);
}));
test('lost committed response is uncertain and old checkpoint cannot be replayed by a new run',()=>using(async f=>{
 const original=f.transport.batch; f.transport.batch=async packet=>{await original(packet);throw Error('private-provider-details');};
 const result=await run(f);assert.equal(result.receipt.outcome,'uncertain');assert.equal(f.calls,1);assert.equal(result.receipt.code,'BATCH_OUTCOME_UNKNOWN');
 const replay=await run(f);assert.equal(replay.receipt.code,'START_DRIFT');assert.equal(f.calls,1);
 assert.doesNotMatch(JSON.stringify(result.receipt),/private-provider/);
}));
test('failed postcommit readback remains uncertain and preserves last proven checkpoint',()=>using(async f=>{
 const original=f.transport.read;f.transport.read=statement=>statement.sql.includes(' AS remaining')?Promise.reject(Error('lost readback')):original(statement);
 const result=await run(f);assert.equal(result.receipt.outcome,'uncertain');assert.equal(result.receipt.code,'READ_OUTCOME_UNKNOWN');assert.deepEqual(result.checkpoint,f.state);assert.equal(f.calls,1);
}));
test('full journal readback drift is rejected even when revision matches',()=>using(async f=>{
 const original=f.transport.read;f.transport.read=async statement=>{const rows=await original(statement);if(statement.sql.includes(' AS remaining')){const value=JSON.parse(rows[0].metadata);value.digest='c'.repeat(64);rows[0].metadata=JSON.stringify(value);}return rows;};
 const result=await run(f);assert.equal(result.receipt.outcome,'uncertain');assert.equal(result.receipt.code,'CHECKPOINT_DRIFT');assert.equal(f.calls,1);
}));
test('batch budget returns last completed checkpoint without an additional write',()=>using(async f=>{
 const result=await run(f,{maxBatches:1});assert.equal(result.receipt.code,'BATCH_BUDGET');assert.equal(result.receipt.batches,1);assert.equal(result.checkpoint.revision,1);assert.equal(f.calls,1);
 const resumed=await run(f,{startJournal:result.checkpoint});assert.equal(resumed.receipt.outcome,'complete');assert.equal(f.calls,3);
}));
test('SQL and byte limits refuse before writes; permission is mandatory',()=>using(async f=>{
 assert.equal((await run(f,{maxSqlBytes:1})).receipt.code,'SQL_BUDGET');
 assert.equal((await run(f,{maxBytes:1})).receipt.code,'ROW_BUDGET');
 assert.equal((await run(f,{permission:null})).receipt.code,'PERMISSION_REQUIRED');
 assert.equal((await run(f,{permission:{begin:{sql:'SELECT 1',params:[]},end:f.permission.end}})).receipt.code,'PERMISSION_REQUIRED');assert.equal(f.calls,0);
}));
test('time budget checked before write and hanging batch returns uncertain once',()=>using(async f=>{
 let clock=0; const original=f.transport.read;f.transport.read=async statement=>{const rows=await original(statement);clock+=20;return rows;};
 const result=await run(f,{timeoutMs:10,now:()=>clock});assert.equal(result.receipt.code,'TIME_BUDGET');assert.equal(f.calls,0);
 let attempted=0;const hung={read:original,batch:()=>{attempted++;return new Promise(()=>{});}};
 const timeout=await run(f,{transport:hung,timeoutMs:20});assert.equal(timeout.receipt.outcome,'uncertain');assert.equal(attempted,1);
}));
test('SQL rendering keeps comments/quoted marks and compound migration bytes',()=>{
 assert.equal(renderMovementSql([{sql:"SELECT '?' AS x,? AS y -- ?",params:["O'Reilly"]}]),"SELECT '?' AS x,'O''Reilly' AS y -- ?\n;");
 const sql='-- Canonical\nCREATE TABLE t(x TEXT);';assert.equal(renderMovementSql([{sql,params:[],compound:true}]),sql+'\n;');
 assert.throws(()=>renderMovementSql([{sql:'SELECT ?1',params:[1]}]),/NUMBERED/);
 assert.throws(()=>renderMovementSql([{sql:'SELECT ?',params:[1],compound:true}]),/COMPOUND/);
});

test('oversized multi-row SQL adapts locally to fitting prefixes without mutation retry or lost rows',()=>using(async f=>{
 const selection=accountlessMovementSelection(f.state,{maxRows:3});
 const rows=f.db.prepare(selection.sql).all(...selection.params);
 const bytes=count=>Buffer.byteLength(renderMovementSql(planAccountlessMovementBatch({current:f.state,
  selectedRows:rows.slice(0,count),expectedRevision:0,maxRows:3,permission:f.permission}).statements));
 const single=bytes(1),pair=bytes(2);assert.ok(pair>single+100);
 const cap=Math.floor((single+pair)/2);let reads=0;
 const read=f.transport.read;f.transport.read=statement=>{reads++;return read(statement);};
 const result=await run(f,{maxRows:3,maxSqlBytes:cap});
 assert.equal(result.receipt.outcome,'complete');assert.equal(result.receipt.rows,3);
 assert.equal(result.receipt.batches,3);assert.equal(result.receipt.attemptedBatches,3);
 assert.equal(f.calls,3);assert.equal(reads,7);assert.ok(f.plans.every(sql=>Buffer.byteLength(sql)<=cap));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sample').get().n,0);
 assert.deepEqual(f.db.prepare('SELECT payload FROM _accountless_move_sample ORDER BY _move_key').all().map(r=>r.payload),['private-key-never-log','two','three']);
}));
test('remaining operation deadline is passed to every transport call',()=>using(async f=>{
 let clock=0;const deadlines=[];const read=f.transport.read,batch=f.transport.batch;
 f.transport.read=async(statement,options)=>{deadlines.push(options.timeoutMs);clock+=10;return read(statement);};
 f.transport.batch=async packet=>{deadlines.push(packet.timeoutMs);clock+=10;return batch(packet);};
 const result=await run(f,{maxRows:3,timeoutMs:100,now:()=>clock});
 assert.equal(result.receipt.outcome,'complete');assert.deepEqual(deadlines,[100,90,80,70]);
}));

test('failed progress sink reports a known completed checkpoint and stops before another write',()=>using(async f=>{
 const result=await run(f,{onProgress:()=>{throw Error('private sink details');}});
 assert.equal(result.receipt.outcome,'stopped');assert.equal(result.receipt.code,'PROGRESS_SINK_FAILED');
 assert.equal(result.receipt.batches,1);assert.equal(result.checkpoint.revision,1);assert.equal(f.calls,1);
 assert.doesNotMatch(JSON.stringify(result.receipt),/private sink/);
}));


test('range operator shrinks oversized metadata selections before dispatch and restores exact rows',async()=>{
 const f=fixture(true);try{
  let selections=0;const original=f.transport.read;
  f.transport.read=(statement,options)=>{if(statement.sql.includes(' AS selected_rows'))selections++;return original(statement,options)};
  const result=await run(f,{rangeMaxRows:4,rangeMaxBytes:45});
  assert.equal(result.receipt.outcome,'complete');assert.equal(result.receipt.rows,3);assert.ok(selections>result.receipt.batches);
  assert.equal(f.calls,result.receipt.batches);assert.ok(f.calls>1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM telemetry_v1_records').get().n,0);
  const restore={...result.checkpoint,phase:'restore',revision:result.checkpoint.revision+1,tableIndex:0,cursor:0};
  f.db.prepare('UPDATE _accountless_move_journal SET metadata=?').run(JSON.stringify(restore));
  const back=await run(f,{startJournal:restore,rangeMaxRows:8192,rangeMaxBytes:16*1024*1024});
  assert.equal(back.receipt.outcome,'complete');assert.equal(back.receipt.batches,1);
  assert.deepEqual(f.db.prepare('SELECT CAST(rowid AS TEXT) AS id,payload FROM telemetry_v1_records ORDER BY rowid').all().map(r=>({...r})),[
   {id:'9007199254741007',payload:'private-key-never-log'},{id:'9007199254741011',payload:'two'},{id:'9007199254741013',payload:'three'}]);
 }finally{f.db.close()}
});
test('range operator never replays a lost committed response and refuses invalid limits before transport',async()=>{
 const f=fixture(true);try{
  assert.equal((await run(f,{rangeMaxRows:8193})).receipt.code,'LIMIT_INVALID');assert.equal(f.calls,0);
  const original=f.transport.batch;f.transport.batch=async packet=>{await original(packet);throw Error('lost')};
  const result=await run(f,{rangeMaxRows:2});assert.equal(result.receipt.outcome,'uncertain');assert.equal(f.calls,1);
  assert.equal((await run(f)).receipt.code,'START_DRIFT');assert.equal(f.calls,1);
 }finally{f.db.close()}
});
