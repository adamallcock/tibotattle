import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { identityDigest } from '../../../scripts/lib/release-operation.mjs';
import { createStorageMigrationWorker } from './d1-storage-migration-worker.mjs';
import { SYNTHETIC_D1_WORKER, syntheticD1Binding, closeSyntheticD1Bindings } from './d1-storage-local-d1.mjs';

const contract={targetBaseSchemaDigest:'base'},contractDigest=identityDigest(contract);
async function fixture(t){
 const mf=new Miniflare({host:'127.0.0.1',cf:false,modules:true,script:SYNTHETIC_D1_WORKER,
  compatibilityDate:'2026-07-26',d1Databases:['SOURCE','TARGET']});
 t.after(async()=>{await closeSyntheticD1Bindings(mf);await mf.dispose();});
 const target=syntheticD1Binding(mf,'TARGET'),pending=[];let clock=1000,calls=0,acks=0;
 const api={authorityRestoreContractDigest:async()=>contractDigest,authoritySchemaInventory:async()=>[],
  authoritySchemaDigest:async()=>'base',freezeAuthorityRestoreSource:async()=>{calls++;},beginAuthorityRestore:async()=>{calls++;}};
 const worker=createStorageMigrationWorker({api,contract,contractDigest,expiresAt:2000,frozenSource:true,clock:()=>clock});
 const env={STORAGE_RESTORE_MODE:'enabled',SOURCE:{},TARGET:target,STORAGE_RESTORE_QUEUE:{send:async body=>pending.push(structuredClone(body))}};
 const deliver=body=>worker.queue({messages:[{body,ack(){acks++;}}]},env);
 return {target,pending,api,worker,env,deliver,calls:()=>calls,acks:()=>acks,setClock:n=>{clock=n;}};
}
test('queue continues committed pages immediately and old wakeups cannot advance work',async t=>{
 const f=await fixture(t);await f.worker.scheduled({},f.env);
 assert.equal(f.calls(),0);assert.equal(f.pending.length,1);
 const first=f.pending.shift();await f.deliver(first);
 assert.equal(f.calls(),1);assert.equal(f.pending[0].steps,1);
 await f.deliver(first);assert.equal(f.calls(),1);assert.equal(f.pending.length,1);
 await f.deliver(f.pending.shift());assert.equal(f.calls(),2);
 assert.deepEqual(await f.target.prepare('SELECT stage,steps,intent FROM _authority_operator_progress').first(),
  {stage:'copy-authority',steps:2,intent:null});
 assert.equal(f.acks(),3);
});
test('lost queue send is recovered from committed progress without repeating its page',async t=>{
 const f=await fixture(t);await f.worker.scheduled({},f.env);const first=f.pending.shift();
 const send=f.env.STORAGE_RESTORE_QUEUE.send;
 f.env.STORAGE_RESTORE_QUEUE.send=async body=>{await send(body);throw Error('send response lost');};
 await assert.rejects(f.deliver(first),/send response lost/);assert.equal(f.calls(),1);
 assert.equal(await f.target.prepare('SELECT intent FROM _authority_operator_progress').first('intent'),null);
 f.env.STORAGE_RESTORE_QUEUE.send=send;
 await f.worker.scheduled({},f.env);assert.deepEqual(f.pending[0],f.pending[1]);
 await f.deliver(f.pending.shift());await f.deliver(f.pending.shift());
 assert.equal(f.calls(),2);assert.equal(f.pending.length,1);
});
test('unknown database outcome stays stopped despite queue replay and cron',async t=>{
 const f=await fixture(t);let attempts=0;
 f.api.freezeAuthorityRestoreSource=async()=>{attempts++;throw Error('D1 response lost');};
 await f.worker.scheduled({},f.env);const body=f.pending.shift();
 await assert.rejects(f.deliver(body),/D1 response lost/);
 await assert.rejects(f.deliver(body),/RECONCILE_REQUIRED/);
 await assert.rejects(f.worker.scheduled({},f.env),/RECONCILE_REQUIRED/);
 assert.equal(attempts,1);assert.equal(f.pending.length,0);assert.equal(f.acks(),0);
});
test('wrong, future, expired and unbound queue work cannot call the restore API',async t=>{
 const f=await fixture(t);await f.worker.scheduled({},f.env);const body=f.pending[0];
 for(const invalid of [{...body,contractDigest:'0'.repeat(64)},{...body,steps:1},{...body,extra:'not allowed'}])
  await assert.rejects(f.deliver(invalid),/MESSAGE_INVALID/);
 f.setClock(2000);await assert.rejects(f.deliver(body),/CONFIGURATION_INVALID/);
 f.setClock(1000);await assert.rejects(f.worker.scheduled({},{...f.env,STORAGE_RESTORE_QUEUE:undefined}),/CONFIGURATION_INVALID/);
 assert.equal(f.calls(),0);assert.equal(await f.target.prepare('SELECT intent FROM _authority_operator_progress').first('intent'),null);
 assert.equal(f.worker.fetch(new Request('https://example.test/any-path')).status,404);
});
test('attached journal SQL is refused before it can run, including a post-read race',async t=>{
 const f=await fixture(t);await f.worker.scheduled({},f.env);const body=f.pending[0];
 await f.target.prepare('CREATE TABLE synthetic_audit(n INTEGER)').run();
 const install=()=>f.target.prepare(`CREATE TRIGGER _authority_unreviewed BEFORE UPDATE ON _authority_operator_progress
  BEGIN INSERT INTO synthetic_audit VALUES(1); END`).run();
 await install();
 await assert.rejects(f.deliver(body),/MIGRATION_JOURNAL_INVALID/);
 assert.equal(await f.target.prepare('SELECT count(*) n FROM synthetic_audit').first('n'),0);
 await f.target.prepare('DROP TRIGGER _authority_unreviewed').run();
 // Inject after the metadata read. The UPDATE's own schema guard must exclude
 // the row before SQLite could fire an attached BEFORE UPDATE trigger.
 f.env.TARGET=new Proxy(f.target,{get(target,key){
  if(key!=='prepare')return target[key];
  return sql=>{
   const statement=target.prepare(sql);
   if(!sql.startsWith('UPDATE _authority_operator_progress SET intent='))return statement;
   return {bind(...args){const bound=statement.bind(...args);return {all:async()=>{await install();return bound.all();}};}};
  };
 }});
 await assert.rejects(f.deliver(body),/RECONCILE_REQUIRED/);
 assert.equal(await f.target.prepare('SELECT count(*) n FROM synthetic_audit').first('n'),0);
 assert.equal(f.calls(),0);
});

test('actual local Queue transport drains the fixed-contract driver without minute ticks',async t=>{
 // This proves the native Queue/D1 driver, not the actual data-copy algorithms;
 // the complete restored-runtime rehearsal separately exercises those APIs.
 const entry=`import {createStorageMigrationWorker} from './scripts/d1-storage-migration-worker.mjs';
 const api={authorityRestoreContractDigest:async()=>${JSON.stringify(contractDigest)},authoritySchemaInventory:async()=>[],authoritySchemaDigest:async()=>'base'};
 for(const name of ['freezeAuthorityRestoreSource','beginAuthorityRestore','sealAuthorityRestore','completeAuthorityVerification','promoteAuthorityRestore','finalizeAuthorityRestore','initializeAuthorityRestoreBootstrap'])api[name]=async()=>({});
 api.copyAuthorityPage=async()=>({state:'complete'});api.copyAuthorityTypedPage=api.verifyAuthorityTypedPage=async()=>({reachedEnd:true});
 api.adoptAuthorityTypedPage=async()=>({done:true});api.bootstrapAuthorityRestorePage=async()=>({completed:true});
 export default createStorageMigrationWorker({api,contract:${JSON.stringify(contract)},contractDigest:${JSON.stringify(contractDigest)},expiresAt:${Date.now()+30_000},frozenSource:true});`;
 const bundled=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'js'},bundle:true,write:false,format:'esm',platform:'browser',logLevel:'silent'});
 const mf=new Miniflare({host:'127.0.0.1',cf:false,workers:[
  {name:'inspector',modules:true,script:SYNTHETIC_D1_WORKER,compatibilityDate:'2026-07-26',d1Databases:{SOURCE:'source',TARGET:'target'}},
  {name:'restore',modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-07-26',
   bindings:{STORAGE_RESTORE_MODE:'enabled'},d1Databases:{SOURCE:'source',TARGET:'target'},
   queueProducers:{STORAGE_RESTORE_QUEUE:'synthetic-restore'},queueConsumers:{'synthetic-restore':{maxBatchSize:1,maxBatchTimeout:0,maxRetries:0}}},
 ]});
 t.after(async()=>{await closeSyntheticD1Bindings(mf);await mf.dispose();});
 const producer=await mf.getQueueProducer('STORAGE_RESTORE_QUEUE','restore');
 await producer.send({schema:'d1-storage-restore-wakeup-v1',contractDigest,stage:'freeze-source',steps:0});
 const target=syntheticD1Binding(mf,'TARGET'),deadline=Date.now()+15_000;let state;
 while(Date.now()<deadline){
  try{state=await target.prepare('SELECT stage,steps,intent FROM _authority_operator_progress').first();}catch{/* First delivery initializes the journal. */}
  if(state?.stage===null)break;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 assert.deepEqual(state,{stage:null,steps:19,intent:null});
});
