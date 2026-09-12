import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,describe,it,expect} from 'vitest';
import {saveStorageHistoryCheckpoint as save,loadStorageHistoryCheckpoint as load,retireStorageHistoryCheckpoint as retire,
 type StorageHistoryKey,type StorageHistoryLoadCursor} from '../src/storage-history-checkpoint';
import {createV1QuotaAcquisitionCheckpoint} from '../src/quota-analysis-v1-reader';
import type {StorageV1HistoryCheckpoint} from '../src/storage-v1-history';
import {MODEL_HISTORY_METHOD_VERSION} from '../src/quota-analysis-v1';
import {retireStorageGraphPage} from '../src/storage-graph-retirement';
const bindings=env as Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const target=()=>bindings.STORAGE_ANALYTICS_DB;
const key:StorageHistoryKey={sourceId:'synthetic-history-source',ownerDigest:'a'.repeat(64),day:'2026-09-05',dependencyDigest:'b'.repeat(64),sourceNamespace:'synthetic-origin',method:'synthetic-graph-v1'};
beforeEach(async()=>{await reset();await applyD1Migrations(target(),bindings.TEST_ANALYTICS_MIGRATIONS);
 await target().prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')").bind(key.sourceId,key.ownerDigest).run();});
function checkpoint(count=0,finish=false):StorageV1HistoryCheckpoint{
 const identity={participantId:'synthetic-history-participant',inputFingerprint:'c'.repeat(64),sourceMethodVersion:MODEL_HISTORY_METHOD_VERSION,
 observedAtCutoff:'2026-05-28T00:00:00.000Z',resetsAtCutoff:'2026-06-04T00:00:00.000Z',windowMinutes:10080,maxQuotaRows:60000};
 const anchors=Array.from({length:count},(_,i)=>({sourceContext:'["openai_codex","codex"]',contextKey:'openai_codex|codex',observedAtMs:Date.parse('2026-09-01T00:00:00.000Z')+i,planType:'pro',planVariant:'unknown',accountScopeId:null}));
 const base={version:1 as const,day:key.day,layout:`typed:${key.sourceNamespace}`,identity};
 if(finish)return {...base,phase:'finish',acquisition:{planAnchors:anchors,quotaRows:[]}};
 const acquisition=createV1QuotaAcquisitionCheckpoint(identity);acquisition.plan.anchors=anchors;return {...base,phase:'acquisition',acquisition};
}
async function drain(value:StorageV1HistoryCheckpoint,expectedHead:string|null=null){for(let i=0;i<100;i++){
 const result=await save({target:target(),key,checkpoint:value,expectedHead,maxWrites:4});if(result.status==='saved')return result.headDigest;}
 throw new Error('synthetic staging did not finish');}
async function read(){let cursor:StorageHistoryLoadCursor|undefined;for(let i=0;i<140;i++){
 const result=await load({target:target(),key,cursor,maxParts:2});if(result.status!=='deferred')return result;cursor=result.cursor;}
 throw new Error('synthetic load did not finish');}
function batchAdapter(batch:D1Database['batch']):D1Database{return new Proxy(target(),{get(db,p){if(p==='batch')return batch;const v=Reflect.get(db,p);return typeof v==='function'?v.bind(db):v;}});}
describe('private paged historical checkpoint store',()=>{
 it('keeps an in-flight successor then removes superseded checkpoint generations after promotion',async()=>{
  const old=await drain(checkpoint(10000)),next=checkpoint(18000);
  expect((await save({target:target(),key,checkpoint:next,expectedHead:old,maxWrites:4})).status).toBe('staging');
  expect(await retireStorageGraphPage(target(),key.sourceId,Date.parse('2026-09-06T12:00:00Z'))).toMatchObject({state:'idle'});
  expect(await read()).toMatchObject({headDigest:old});
  const current=await drain(next,old);
  for(let n=0;n<10;n++)if((await retireStorageGraphPage(target(),key.sourceId,Date.parse('2026-09-06T12:00:00Z'))).state==='idle')break;
  expect(await read()).toEqual({status:'ready',headDigest:current,checkpoint:next});
  expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_stages').first('n')).toBe(1);
 });
 it('retires erased-owner checkpoint payloads in bounded pages without deleting another owner or allowing resurrection',async()=>{
  const head=await drain(checkpoint(18000,true));
  const other={...key,ownerDigest:'d'.repeat(64)};
  await target().prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')").bind(other.sourceId,other.ownerDigest).run();
  await save({target:target(),key:other,checkpoint:checkpoint(),expectedHead:null});
  await target().prepare("UPDATE analytics_owner_state SET state='erased',revision=2,authority_epoch=2 WHERE owner_digest=?")
   .bind(key.ownerDigest).run();
  let done=false;
  for(let i=0;i<30;i++){
   const before=await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_parts').first<number>('n');
   const result=await retireStorageGraphPage(target(),key.sourceId,Date.parse('2026-09-06T12:00:00Z'));
   const after=await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_parts').first<number>('n');
   expect(before!-after!).toBeLessThanOrEqual(15);
   if(result.state==='idle'){done=true;break;}
  }
  expect(done).toBe(true);
  expect(await target().prepare('SELECT terminal_revision FROM analytics_graph_erasure_receipts WHERE source_id=? AND owner_digest=?')
   .bind(key.sourceId,key.ownerDigest).first('terminal_revision')).toBe(2);
  expect(await read()).toEqual({status:'absent'});
  expect(await load({target:target(),key:other})).toMatchObject({status:'ready'});
  await expect(save({target:target(),key,checkpoint:checkpoint(),expectedHead:head})).rejects.toThrow();
  await expect(target().prepare("INSERT INTO analytics_community_graph_execution VALUES(?,?,?,?,'checkpoint')")
   .bind(key.sourceId,key.ownerDigest,key.day,key.dependencyDigest).run()).rejects.toThrow('owner_erased');
 });
 it('stages a multi-megabyte checkpoint across finite writes, retains prior head, then loads all exact components',async()=>{
  const old=checkpoint(),oldHead=await drain(old),large=checkpoint(18000);
  const first=await save({target:target(),key,checkpoint:large,expectedHead:oldHead,maxWrites:4});expect(first.status).toBe('staging');
  expect(await read()).toMatchObject({status:'ready',headDigest:oldHead,checkpoint:old});
  await target().prepare('UPDATE analytics_owner_state SET revision=2').run();
  expect(await read()).toMatchObject({status:'ready',headDigest:oldHead,checkpoint:old});
  const next=await drain(large,oldHead);expect(next).not.toBe(oldHead);expect(await read()).toEqual({status:'ready',headDigest:next,checkpoint:large});
  await expect(save({target:target(),key,checkpoint:checkpoint(1),expectedHead:oldHead})).rejects.toThrow('CHECKPOINT_UNAVAILABLE');
 });
 it('converges after committed response loss and rolls back a failed part page',async()=>{
  const large=checkpoint(18000,true),lost=batchAdapter(async statements=>{await target().batch(statements);throw new Error('synthetic lost response');});
  await expect(save({target:lost,key,checkpoint:large,expectedHead:null,maxWrites:4})).rejects.toThrow('lost response');
  const retained=await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_parts').first<number>('n');expect(retained).toBe(2);
  await target().prepare("CREATE TRIGGER synthetic_checkpoint_failure BEFORE INSERT ON analytics_history_checkpoint_parts WHEN NEW.part_index=3 BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
  await expect(save({target:target(),key,checkpoint:large,expectedHead:null,maxWrites:4})).rejects.toThrow();
  expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_parts').first('n')).toBe(retained);
  await target().prepare('DROP TRIGGER synthetic_checkpoint_failure').run();const head=await drain(large);expect(await read()).toMatchObject({status:'ready',headDigest:head,checkpoint:large});
  expect(await save({target:target(),key,checkpoint:large,expectedHead:null})).toEqual({status:'saved',headDigest:head});
 });
 it('refuses corrupt cursors, cross-key reads, mutation and revoked authority; retirement stays bounded and prevents resurrection',async()=>{
  const value=checkpoint(10000),head=await drain(value);const page=await load({target:target(),key,maxParts:1});expect(page.status).toBe('deferred');
  if(page.status!=='deferred')throw new Error('expected deferred');page.cursor.parts[0]='[]';
  let cursor=page.cursor;await expect((async()=>{for(let i=0;i<100;i++){const result=await load({target:target(),key,cursor});if(result.status!=='deferred')return result;cursor=result.cursor;}})()).rejects.toThrow();
  expect(await load({target:target(),key:{...key,day:'2026-09-04'}})).toEqual({status:'absent'});
  await expect(target().prepare("UPDATE analytics_history_checkpoint_parts SET payload_json='[]',payload_bytes=2").run()).rejects.toThrow();
  await target().prepare("UPDATE analytics_owner_state SET state='withdrawn',revision=2,authority_epoch=2").run();
  expect(await read()).toEqual({status:'absent',headDigest:head});
  await expect(save({target:target(),key,checkpoint:value,expectedHead:null})).rejects.toThrow();
  let completed=false;for(let i=0;i<100;i++){const before=await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_parts').first<number>('n');
   const result=await retire({target:target(),key,expectedHead:head,maxWrites:4});const after=await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_parts').first<number>('n');expect(before!-after!).toBeLessThanOrEqual(3);
   if(result.status==='retired'){completed=true;break;}}
  expect(completed).toBe(true);expect(await load({target:target(),key})).toEqual({status:'absent'});
  await target().prepare("UPDATE analytics_owner_state SET state='active',revision=3,authority_epoch=3").run();
  await expect(save({target:target(),key,checkpoint:value,expectedHead:null})).rejects.toThrow();
 });
});
