import { env, reset, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { authoritySchemaInventory, authoritySchemaDigest, authorityRestoreContractDigest,
 freezeAuthorityRestoreSource, beginAuthorityRestore, copyAuthorityPage, copyAuthorityTypedPage, authorityMigrationLedgerDigest, type AuthorityRestoreContract } from '../src/authority-restore';
import { v11UsageRecord } from './helpers/telemetry-v11';
import { encodeTypedTelemetryRecord, typedTelemetryCanonicalRecords } from '../src/typed-telemetry-codec';
const source=()=>env.USAGE_MONITOR_DB;
const target=()=>(env as Env&{STORAGE_INGESTION_A:D1Database}).STORAGE_INGESTION_A;
const sequences=['telemetry_contributions','telemetry_records','telemetry_contribution_occurrences','telemetry_v1_chunks'];
beforeEach(async()=>reset());
async function fixture(typed=false){
 await source().prepare('CREATE TABLE participants(id TEXT PRIMARY KEY,value TEXT) STRICT').run();
 for(const [i,name] of sequences.entries()){
  await source().prepare(`CREATE TABLE ${name}(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT) STRICT`).run();
  if(i<3){await source().prepare(`INSERT INTO ${name} VALUES(?,NULL)`).bind(100+i).run();await source().prepare(`DELETE FROM ${name}`).run();}
 }
 await source().batch(Array.from({length:35},(_,i)=>source().prepare('INSERT INTO participants VALUES(?,?)').bind(`synthetic-${i}`,i?'':null)));
 if(typed){
  await source().batch([
   source().prepare('CREATE TABLE telemetry_v11_chunks(id TEXT PRIMARY KEY,participant_id TEXT,device_id TEXT,manifest_id TEXT,stream TEXT,chunk_day TEXT) STRICT'),
   source().prepare('CREATE TABLE telemetry_v11_day_manifests(id TEXT PRIMARY KEY,participant_id TEXT,device_id TEXT,chunk_day TEXT) STRICT'),
   source().prepare('CREATE TABLE telemetry_v11_records(chunk_id TEXT,manifest_id TEXT,stream TEXT,occurrence_id TEXT,observed_at TEXT,record_json TEXT,legacy_occurrence_id TEXT,legacy_record_json TEXT) STRICT'),
   source().prepare("INSERT INTO telemetry_v11_chunks VALUES('chunk:synthetic','participant:synthetic','device:synthetic','manifest:synthetic','usage','2026-09-11')"),
   source().prepare("INSERT INTO telemetry_v11_day_manifests VALUES('manifest:synthetic','participant:synthetic','device:synthetic','2026-09-11')"),
  ]);
  const record=v11UsageRecord('2026-09-11'),decoded=typedTelemetryCanonicalRecords(encodeTypedTelemetryRecord('v11',record));
  await source().prepare("INSERT INTO telemetry_v11_records VALUES('chunk:synthetic','manifest:synthetic','usage',?,?,?,?,?)")
   .bind(record.eventId,record.eventTime,decoded.canonicalRecord,decoded.legacy?.occurrenceId??null,decoded.legacy?.canonicalRecord??null).run();
  await applyD1Migrations(target(),(env as Env&{TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[]}).TEST_TYPED_INGESTION_MIGRATIONS);
 }
 const sourceSchema=await authoritySchemaInventory(source()),baseSchema=await authoritySchemaInventory(target());
 const finalSchema=sourceSchema.filter(o=>o.name!=='telemetry_v11_records');
 const contract:AuthorityRestoreContract={version:'authority-restore-v1',runId:'frozen-batch',sourceId:'synthetic-journal',sourceNamespace:'synthetic-frozen-batch',sourceSnapshotDigest:'a'.repeat(64),sourceSchema,sourceSchemaDigest:await authoritySchemaDigest(sourceSchema),targetBaseSchema:baseSchema,targetBaseSchemaDigest:await authoritySchemaDigest(baseSchema),finalSchema,finalSchemaDigest:await authoritySchemaDigest(finalSchema),tables:sourceSchema.filter(o=>o.type==='table').map(o=>({name:o.name,disposition:o.name==='telemetry_v11_records'?'typed-v11':'authority'})),typedCopies:typed?[{runId:'typed-frozen-batch',format:'v11',sourceNamespace:'synthetic-frozen-batch',sourceSnapshotDigest:'a'.repeat(64)}]:[],authoritySequences:sequences.map((name,i)=>({name,sequence:i<3?100+i:0})),operatingLimitBytes:64*1024*1024};
 if(typed)contract.targetMigrationLedgerDigest=await authorityMigrationLedgerDigest(target());
 const pin=await authorityRestoreContractDigest(contract);
 await freezeAuthorityRestoreSource(source(),contract,pin);await beginAuthorityRestore(source(),target(),contract,pin);
 return {contract,pin};
}
type Entry={sql:string;args:unknown[];inner:D1PreparedStatement};
function instrument(db:D1Database,events:string[],label:string,hooks:{before?:(index:number)=>Promise<void>;after?:(results:D1Result[],index:number)=>unknown}={}){
 const metadata=new WeakMap<object,Entry>(),batches:Entry[][]=[],proofs:D1Result[][]=[];
 const wrap=(inner:D1PreparedStatement,sql:string,args:unknown[]=[]):D1PreparedStatement=>{
  const proxy=new Proxy(inner,{get(o,key){
   if(key==='bind')return(...values:unknown[])=>wrap(o.bind(...values),sql,values);
   const value=Reflect.get(o,key);
   if(['first','all','run','raw'].includes(String(key)))return async(...values:unknown[])=>{events.push(`${label}:single:${sql}`);return value.apply(o,values);};
   return typeof value==='function'?value.bind(o):value;
  }});metadata.set(proxy,{inner,sql,args});return proxy;
 };
 return {batches,proofs,db:new Proxy(db,{get(o,key){
  if(key==='prepare')return(sql:string)=>wrap(o.prepare(sql),sql);
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   const batch=statements.map(s=>metadata.get(s)!);batches.push(batch);events.push(`${label}:batch:${batches.length}`);
   await hooks.before?.(batches.length);const results=await o.batch(batch.map(e=>e.inner));proofs.push(structuredClone(results));
   return hooks.after?hooks.after(results,batches.length):results;
  };
  const value=Reflect.get(o,key);return typeof value==='function'?value.bind(o):value;
 }})};
}
const checkpoint=()=>target().prepare("SELECT copy_cursor,copied FROM _authority_restore_tables WHERE name='participants'").first();
const count=()=>target().prepare('SELECT COUNT(*) n FROM _authority_stage_participants').first('n');
describe('fresh batched source freeze proofs',()=>{
 it('retains seven exact independent SELECTs and proof values at both pre-write boundaries: 14 statements, two RPCs',async()=>{
  const f=await fixture(),events:string[]=[];const s=instrument(source(),events,'source'),t=instrument(target(),events,'target');
  expect(await copyAuthorityPage(s.db,t.db,f.contract,f.pin)).toEqual({state:'progress',rows:32});
  expect(s.batches).toHaveLength(2);
  for(const [i,batch] of s.batches.entries()){
   expect(batch).toHaveLength(7);
   expect(batch[0]!.sql).toBe('SELECT contract_digest,namespace,snapshot_digest FROM _authority_snapshot WHERE id=1');
   expect(batch[1]!.sql).toContain('ORDER BY s.type,s.name LIMIT 1025');
   expect(batch[2]!.sql).toBe("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB '_authority_freeze_*' ORDER BY name LIMIT 400");
   expect(batch.slice(3).map(e=>[e.sql,e.args])).toEqual(sequences.map(name=>['SELECT seq FROM sqlite_sequence WHERE name=?',[name]]));
   // Native standalone reads provide the original proof values, without a duplicate runtime implementation.
   const standalone=[];for(const entry of batch)standalone.push((await entry.inner.all()).results);
   expect(s.proofs[i]!.map(r=>r.results)).toEqual(standalone);
   expect(s.proofs[i]![0]!.results).toEqual([{contract_digest:f.pin,namespace:f.contract.sourceNamespace,snapshot_digest:f.contract.sourceSnapshotDigest}]);
   expect(s.proofs[i]![1]!.results).toEqual(f.contract.sourceSchema);
   expect(s.proofs[i]!.slice(3).map(r=>r.results)).toEqual([[{seq:100}],[{seq:101}],[{seq:102}],[]]);
  }
  const pageRead=events.findIndex(e=>e.startsWith('source:single:')&&e.includes('FROM "participants"'));
  expect(events.indexOf('source:batch:1')).toBeLessThan(pageRead);
  expect(pageRead).toBeLessThan(events.indexOf('source:batch:2'));
  expect(events.indexOf('source:batch:2')).toBeLessThan(events.indexOf('target:batch:1'));
  expect(await count()).toBe(32);expect(await checkpoint()).toEqual({copy_cursor:'[["number",32]]',copied:32});
 });
 it.each(['schema','trigger','sequence','snapshot'] as const)('rejects real %s drift at either boundary before target mutation',async kind=>{
  for(const boundary of [1,2]){
   await reset();const f=await fixture(),before=await checkpoint(),events:string[]=[];
   const s=instrument(source(),events,'source',{before:async index=>{
    if(index!==boundary)return;
    if(kind==='schema')await source().prepare('CREATE INDEX changed_schema ON participants(value)').run();
    if(kind==='trigger')await source().prepare('DROP TRIGGER _authority_freeze_update_participants').run();
    if(kind==='sequence')await source().prepare("UPDATE sqlite_sequence SET seq=999 WHERE name='telemetry_records'").run();
    if(kind==='snapshot'){await source().prepare('DROP TRIGGER _authority_freeze_update__authority_snapshot').run();await source().prepare('UPDATE _authority_snapshot SET snapshot_digest=?').bind('b'.repeat(64)).run();}
   }}),t=instrument(target(),events,'target');
   await expect(copyAuthorityPage(s.db,t.db,f.contract,f.pin)).rejects.toThrow('AUTHORITY_RESTORE_EVIDENCE_MISMATCH');
   expect(s.batches).toHaveLength(boundary);expect(t.batches).toHaveLength(0);
   expect(await checkpoint()).toEqual(before);expect(await count()).toBe(0);
  }
 });
 it('fails closed on malformed or failed native results and preserves transport exceptions and unchanged cursor',async()=>{
  const f=await fixture(),before=await checkpoint();
  const mutations=[
   (r:D1Result[])=>r.slice(0,-1),(r:D1Result[])=>[...r,r[0]!],
   (r:D1Result[])=>r.map((x,i)=>i===3?{...x,success:false}:x),
   (r:D1Result[])=>r.map((x,i)=>i===1?{...x,results:null}:x),
   (r:D1Result[])=>r.map((x,i)=>i===3?{...x,results:[...x.results,...x.results]}:x),
  ];
  for(const after of mutations){
   const events:string[]=[],s=instrument(source(),events,'source',{after}),t=instrument(target(),events,'target');
   await expect(copyAuthorityPage(s.db,t.db,f.contract,f.pin)).rejects.toThrow('AUTHORITY_RESTORE_EVIDENCE_MISMATCH');
   expect(t.batches).toHaveLength(0);expect(await checkpoint()).toEqual(before);
  }
  for(const boundary of [1,2]){
   const events:string[]=[],error=new Error('synthetic read transport failure');
   const s=instrument(source(),events,'source',{before:async index=>{if(index===boundary)throw error;}}),t=instrument(target(),events,'target');
   await expect(copyAuthorityPage(s.db,t.db,f.contract,f.pin)).rejects.toBe(error);
   expect(t.batches).toHaveLength(0);expect(await checkpoint()).toEqual(before);
  }
 });
 it('refuses typed acknowledgment after a committed page when the post-write source proof changes, without hiding the durable receipt',async()=>{
  const f=await fixture(true),events:string[]=[];
  const s=instrument(source(),events,'source');
  const t=instrument(target(),events,'target',{after:async results=>{
   await source().prepare("UPDATE sqlite_sequence SET seq=999 WHERE name='telemetry_records'").run();return results;
  }});
  await expect(copyAuthorityTypedPage(s.db,t.db,f.contract,f.pin,'v11')).rejects.toThrow('AUTHORITY_RESTORE_EVIDENCE_MISMATCH');
  expect(s.batches).toHaveLength(2);
  expect(events.indexOf('source:batch:1')).toBeLessThan(events.indexOf('target:batch:1'));
  expect(events.indexOf('target:batch:1')).toBeLessThan(events.indexOf('source:batch:2'));
  expect(await target().prepare('SELECT copied_rows,last_source_row_id FROM storage_raw_copy_runs').first()).toEqual({copied_rows:1,last_source_row_id:1});
  expect(await target().prepare('SELECT COUNT(*) n FROM storage_raw_copy_pages').first('n')).toBe(1);
  await expect(copyAuthorityTypedPage(source(),target(),f.contract,f.pin,'v11')).rejects.toThrow('AUTHORITY_RESTORE_EVIDENCE_MISMATCH');
  expect(await target().prepare('SELECT COUNT(*) n FROM typed_telemetry_records').first('n')).toBe(1);
 });

});
