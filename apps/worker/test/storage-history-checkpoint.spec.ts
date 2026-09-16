import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,describe,it,expect} from 'vitest';
import {saveStorageHistoryCheckpoint as save,loadStorageHistoryCheckpoint as load,retireStorageHistoryCheckpoint as retire,
 type StorageHistoryCheckpoint,type StorageHistoryKey,type StorageHistoryLoadCursor} from '../src/storage-history-checkpoint';
import {createV1QuotaAcquisitionCheckpoint} from '../src/quota-analysis-v1-reader';
import {createV11QuotaAcquisitionCheckpoint,type V11QuotaAcquisitionIdentity} from '../src/quota-analysis-v11-reader';
import type {StorageV1HistoryCheckpoint} from '../src/storage-v1-history';
import type {StorageV11HistoryCheckpoint} from '../src/storage-v11-history';
import {MODEL_HISTORY_METHOD_VERSION} from '../src/quota-analysis-v1';
import type {V11UsageReductionCheckpoint} from '../src/quota-analysis-v11';
import {retireStorageGraphPage} from '../src/storage-graph-retirement';
import {STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD,STORAGE_GRAPH_METHOD,
 STORAGE_GRAPH_V11_FIT_CHECKPOINT_METHOD} from '../src/storage-community-graph';
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
async function drain(value:StorageHistoryCheckpoint,expectedHead:string|null=null,storageKey=key){for(let i=0;i<100;i++){
 const result=await save({target:target(),key:storageKey,checkpoint:value,expectedHead,maxWrites:4});if(result.status==='saved')return result.headDigest;}
 throw new Error('synthetic staging did not finish');}
async function read(storageKey=key){let cursor:StorageHistoryLoadCursor|undefined;for(let i=0;i<140;i++){
 const result=await load({target:target(),key:storageKey,cursor,maxParts:2});if(result.status!=='deferred')return result;cursor=result.cursor;}
 throw new Error('synthetic load did not finish');}
function batchAdapter(batch:D1Database['batch']):D1Database{return new Proxy(target(),{get(db,p){if(p==='batch')return batch;const v=Reflect.get(db,p);return typeof v==='function'?v.bind(db):v;}});}
/** Counts D1 round trips: one per executed statement and one per batch. */
function countRoundTrips(db:D1Database){
 const counts={reads:0,batches:0};
 const statement=(s:D1PreparedStatement):D1PreparedStatement=>new Proxy(s,{get(base,p){
  const v=Reflect.get(base,p);if(typeof v!=='function')return v;
  if(p==='bind')return (...args:unknown[])=>statement((v as (...a:unknown[])=>D1PreparedStatement).apply(base,args));
  if(p==='first'||p==='all'||p==='run'||p==='raw')return (...args:unknown[])=>{counts.reads++;return (v as (...a:unknown[])=>unknown).apply(base,args);};
  return v.bind(base);}});
 const database=new Proxy(db,{get(base,p){
  if(p==='batch')return async(statements:D1PreparedStatement[])=>{counts.batches++;return base.batch(statements);};
  if(p==='prepare')return (sql:string)=>statement(base.prepare(sql));
  const v=Reflect.get(base,p);return typeof v==='function'?v.bind(base):v;}});
 return {database,counts};
}
describe('private paged historical checkpoint store',()=>{
 it('roundtrips v1.1 acquisition, compact usage, and shared-result generations under a distinct exact key',async()=>{
  const identity:V11QuotaAcquisitionIdentity={participantId:'synthetic-v11-participant',inputFingerprint:'e'.repeat(64),
   sourceMethodVersion:'synthetic-v11-reader-1',observedAtCutoff:'2026-05-28T00:00:00.000Z',
   resetsAtCutoff:'2026-06-04T00:00:00.000Z',windowMinutes:10080,maxQuotaRows:60000};
  const v11Key={...key,method:STORAGE_GRAPH_V11_FIT_CHECKPOINT_METHOD},acquisition:StorageV11HistoryCheckpoint={version:1,source:'v1.1',
   day:key.day,layout:`typed-v11:${key.sourceNamespace}`,identity,phase:'acquisition',
   acquisition:createV11QuotaAcquisitionCheckpoint(identity)};
  const first=await drain(acquisition,null,v11Key);
  expect(await read(v11Key)).toEqual({status:'ready',headDigest:first,checkpoint:acquisition});
  expect(await read()).toEqual({status:'absent'});
  const large=structuredClone(acquisition);large.acquisition.plan.observations=Array.from({length:30000},(_,index)=>({
   contextKey:'openai_codex|codex',observedAtMs:Date.parse(identity.observedAtCutoff)+index,planType:'pro',
   planVariant:'unknown',continuityId:null,conflicted:false,accountScopeId:null,planBasis:null}));
  expect((await save({target:target(),key:v11Key,checkpoint:large,expectedHead:first,maxWrites:4})).status).toBe('staging');
  expect(await read(v11Key)).toEqual({status:'ready',headDigest:first,checkpoint:acquisition});
  const largeHead=await drain(large,first,v11Key);expect(await read(v11Key)).toEqual({status:'ready',headDigest:largeHead,checkpoint:large});
  const finish:StorageV11HistoryCheckpoint={...acquisition,phase:'finish',acquisition:{identity,planAnchors:[],quotaRows:[]}};
  const second=await drain(finish,largeHead,v11Key);
  expect(second).not.toBe(largeHead);expect(await read(v11Key)).toEqual({status:'ready',headDigest:second,checkpoint:finish});
  const reduced:V11UsageReductionCheckpoint={version:1,identity,days:[],dayIndex:0,cursorTime:identity.observedAtCutoff,
   cursorOccurrence:'',rowsRead:0,complete:true,commonRefusal:'supported_quota_track_unavailable',scalarRefusal:null,
   modelRefusal:null,previous:[],hazards:[],scalarBuckets:[],modelCosts:[],poisoned:[],usageEventCount:0,
   unpricedUsageEventCount:0,attributionUnresolved:false};
  const usage:StorageV11HistoryCheckpoint={...finish,phase:'usage',usage:reduced};
  const usageHead=await drain(usage,second,v11Key);
  expect(await read(v11Key)).toEqual({status:'ready',headDigest:usageHead,checkpoint:usage});
  for(let i=0;i<10;i++)if((await retireStorageGraphPage(target(),key.sourceId,Date.parse('2026-09-06T12:00:00Z'))).state==='idle')break;
  const insert=async(metric:'fits'|'model')=>target().prepare(`INSERT INTO analytics_community_graph_results
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(v11Key.sourceId,v11Key.ownerDigest,metric,v11Key.day,
    STORAGE_GRAPH_METHOD,v11Key.dependencyDigest,1,'c'.repeat(64),'{}','d'.repeat(64),'{}',Date.now(),'v1.1').run();
  await insert('model');expect(await retireStorageGraphPage(target(),key.sourceId,Date.parse('2026-09-06T12:00:00Z')))
   .toEqual({state:'idle',deleted:0});
  expect(await read(v11Key)).toMatchObject({status:'ready',headDigest:usageHead});
  await insert('fits');expect(await retireStorageGraphPage(target(),key.sourceId,Date.parse('2026-09-06T12:00:00Z')))
   .toEqual({state:'idle',deleted:0});
  expect(await read(v11Key)).toMatchObject({status:'ready',headDigest:usageHead});
  expect(await retireStorageGraphPage(target(),key.sourceId,Date.parse('2027-09-06T12:00:00Z')))
   .toEqual({state:'retiring',deleted:2});
  expect(await read(v11Key)).toEqual({status:'absent'});
 },30000);
 it('retires current-fit checkpoints only after their exact semantic fit result exists',async()=>{
  const currentKey={...key,method:STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD};
  await drain(checkpoint(),null,currentKey);
  const insert=async(metric:'fits'|'model')=>target().prepare(`INSERT INTO analytics_community_graph_results
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(currentKey.sourceId,currentKey.ownerDigest,metric,currentKey.day,
    STORAGE_GRAPH_METHOD,currentKey.dependencyDigest,1,'c'.repeat(64),'{}','d'.repeat(64),'{}',Date.now(),'v1').run();
  await insert('model');
  expect(await retireStorageGraphPage(target(),key.sourceId,Date.parse('2026-09-06T12:00:00Z'))).toEqual({state:'idle',deleted:0});
  expect(await load({target:target(),key:currentKey})).toMatchObject({status:'ready'});
  await insert('fits');
  expect(await retireStorageGraphPage(target(),key.sourceId,Date.parse('2026-09-06T12:00:00Z'))).toEqual({state:'retiring',deleted:0});
  expect(await load({target:target(),key:currentKey})).toEqual({status:'absent'});
  expect(await target().prepare(`SELECT count(*) n FROM analytics_community_graph_results
   WHERE source_id=? AND owner_digest=?`).bind(key.sourceId,key.ownerDigest).first('n')).toBe(2);
 });
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
 it('resumes a staged generation from its private cursor with one part batch and one head read per call',async()=>{
  const old=await drain(checkpoint()),large=checkpoint(18000);
  const first=await save({target:target(),key,checkpoint:large,expectedHead:old,maxWrites:4});
  expect(first.status).toBe('staging');if(first.status!=='staging')throw new Error('expected staging');
  const observed=countRoundTrips(target());let cursor=first.cursor,result:Awaited<ReturnType<typeof save>>=first;
  for(let i=0;i<100&&result.status==='staging';i++){
   const before={...observed.counts};
   result=await save({target:observed.database,key,checkpoint:large,expectedHead:old,maxWrites:4,cursor});
   expect(observed.counts.batches-before.batches).toBe(1);expect(observed.counts.reads-before.reads).toBe(1);
   if(result.status==='staging')cursor=result.cursor;
  }
  expect(result.status).toBe('saved');if(result.status!=='saved')throw new Error('expected saved');
  expect(await read()).toEqual({status:'ready',headDigest:result.headDigest,checkpoint:large});
  expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_stages').first('n')).toBe(2);
  // A cursor binds its exact key, expected head, control and manifest: another
  // checkpoint, another expected head or another key cannot borrow it.
  const staged=checkpoint(18001),second=await save({target:target(),key,checkpoint:staged,expectedHead:result.headDigest,maxWrites:4});
  expect(second.status).toBe('staging');if(second.status!=='staging')throw new Error('expected staging');
  await expect(save({target:target(),key,checkpoint:checkpoint(18002),expectedHead:result.headDigest,maxWrites:4,cursor:second.cursor}))
   .rejects.toThrow('CHECKPOINT_UNAVAILABLE');
  await expect(save({target:target(),key,checkpoint:staged,expectedHead:old,maxWrites:4,cursor:second.cursor}))
   .rejects.toThrow('CHECKPOINT_UNAVAILABLE');
  await expect(save({target:target(),key:{...key,day:'2026-09-04'},checkpoint:staged,expectedHead:result.headDigest,maxWrites:4,cursor:second.cursor}))
   .rejects.toThrow();
  expect(await read()).toMatchObject({status:'ready',headDigest:result.headDigest});
 });
 it('loads a promoted generation with one read per resumed page and a final head fence',async()=>{
  const large=checkpoint(18000),head=await drain(large);
  const partCount=await target().prepare('SELECT part_count FROM analytics_history_checkpoint_stages WHERE generation=?').bind(head).first<number>('part_count');
  expect(partCount!).toBeGreaterThan(8);
  const observed=countRoundTrips(target());let cursor:StorageHistoryLoadCursor|undefined,pages=0;
  for(let i=0;i<200;i++){
   const before=observed.counts.reads,result=await load({target:observed.database,key,cursor,maxParts:4});pages++;
   if(result.status==='deferred'){expect(observed.counts.reads-before).toBe(cursor?1:3);cursor=result.cursor;continue;}
   expect(result).toEqual({status:'ready',headDigest:head,checkpoint:large});expect(observed.counts.reads-before).toBe(2);break;
  }
  expect(pages).toBe(Math.ceil(partCount!/4));expect(observed.counts.reads).toBe(pages+3);expect(observed.counts.batches).toBe(0);
  expect((await load({target:target(),key,maxParts:32})).status).toBe(partCount!>32?'deferred':'ready');
  await expect(load({target:target(),key,maxParts:33})).rejects.toThrow('CHECKPOINT_UNAVAILABLE');
 });
 it('removes an abandoned partial successor once a different successor promotes',async()=>{
  const old=await drain(checkpoint(10000)),abandoned=checkpoint(18000),next=checkpoint(18500);
  expect((await save({target:target(),key,checkpoint:abandoned,expectedHead:old,maxWrites:4})).status).toBe('staging');
  expect((await save({target:target(),key,checkpoint:next,expectedHead:old,maxWrites:4})).status).toBe('staging');
  expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_stages').first('n')).toBe(3);
  // Both partial successors still expect the standing head, so neither is
  // disposable until one of them promotes.
  expect(await retireStorageGraphPage(target(),key.sourceId,Date.parse('2026-09-06T12:00:00Z'))).toMatchObject({state:'idle'});
  expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_stages').first('n')).toBe(3);
  const current=await drain(next,old);
  let idle=false;
  for(let n=0;n<40;n++)if((await retireStorageGraphPage(target(),key.sourceId,Date.parse('2026-09-06T12:00:00Z'))).state==='idle'){idle=true;break;}
  expect(idle).toBe(true);
  expect(await read()).toEqual({status:'ready',headDigest:current,checkpoint:next});
  expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_stages').first('n')).toBe(1);
  expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_parts WHERE generation!=?').bind(current).first('n')).toBe(0);
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
