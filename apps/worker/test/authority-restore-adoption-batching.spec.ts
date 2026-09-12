import { persistTypedTelemetryBatch, readTypedTelemetryPage } from '../src/typed-telemetry-repository';
import { env, reset, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { telemetryV11DayManifestDigestInput, telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest } from '@app-usagemonitor/telemetry-contract';
import { createV11DeviceFixture, makeV11Day, stageV11Day, v11UsageRecord } from './helpers/telemetry-v11';
import { canonicalTelemetryV11Json } from '@app-usagemonitor/telemetry-contract';
import { insertTelemetryV1Chunk } from '../src/telemetry-v1-repository';
import { parseTelemetryV1Chunk } from '../src/telemetry-v1';
import { AUTHORITY_ADMISSION_TABLES, restoreTypedAdmissionPage } from '../src/authority-restore-adoption';
import { sha256Hex } from '../src/crypto';
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from '../src/telemetry-v11-domain';
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from '../src/device-auth';
import { registerTelemetryV11DayManifest } from '../src/telemetry-v11-repository';
import { prepareAuthorityRoleTarget } from '../src/authority-restore-role';
import { AUTHORITY_OPERATOR_LEDGER_SQL,authoritySchemaInventory, authoritySchemaDigest, authorityRestoreContractDigest, authorityRestoreRetainedTableNames,
 freezeAuthorityRestoreSource,beginAuthorityRestore,copyAuthorityPage,copyAuthorityTypedPage,
 sealAuthorityRestore,adoptAuthorityTypedPage,type AuthorityRestoreContract } from '../src/authority-restore';
const b=env as Env&{STORAGE_ANALYTICS_DB:D1Database;STORAGE_INGESTION_A:D1Database;STORAGE_INGESTION_B:D1Database;TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[]};
const source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_INGESTION_A,reference=()=>b.STORAGE_INGESTION_B;
const today=()=>new Date().toISOString().slice(0,10);
beforeEach(async()=>reset());
async function activate(db:D1Database,fixture:Awaited<ReturnType<typeof createV11DeviceFixture>>,day:Awaited<ReturnType<typeof registerTelemetryV11DayManifest>>){
 const previous=await createTelemetryV11DomainPredecessor(db,fixture);
 const value:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',fromDay:day.day,throughDay:day.day,predecessor:{token:previous.token,previousGenerationId:previous.previousGenerationId,legacyFingerprint:previous.legacyFingerprint},days:[{day:day.day,manifestId:day.manifestId,manifestDigest:day.manifestDigest}],manifestDigest:'0'.repeat(64)};
 value.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(value));return activateTelemetryV11Domain(db,fixture,value);
}
async function prepare(withV1=false,usageCount=102,chunkWidth=200,v1Count=32){
 await applyD1Migrations(source(),b.TEST_MIGRATIONS);
 const fixture=await createV11DeviceFixture(source(),{grant:true});
 const records=Array.from({length:usageCount},(_,i)=>v11UsageRecord(today(),'a',{eventId:`event:v2:${(i+1).toString(16).padStart(64,'0')}`}));
 const day=await makeV11Day(today(),{usage:records,quota:[{schemaVersion:'quota-observation-v1.1',observationId:`quota-occurrence:v1:${'a'.repeat(64)}`,provider:'openai_codex',observedTime:`${today()}T12:00:00.000Z`,planType:'pro',planVariant:'unknown',limitId:'codex',slot:'secondary',usedPercent:null,windowDurationMinutes:null,resetsAt:null,accountPlanAttribution:{accountBasis:'unavailable',accountTrackId:null,planBasis:'same_source_occurrence',planType:'pro',planEraId:null}}],session:[{schemaVersion:'session-dimension-v1.1',sessionUuid:'0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b',firstEventTime:`${today()}T12:00:00.000Z`,provider:'openai_codex',toolClassCounts:{shell:0,other:3}}]});
 if(chunkWidth!==200){
  const chunks=[];
  for(const chunk of day.chunks)for(let offset=0;offset<chunk.records.length;offset+=chunkWidth){
   const part=chunk.records.slice(offset,offset+chunkWidth),slot=Number(chunk.chunkId.split(':').at(-1))*200+offset;
   chunks.push({...chunk,chunkId:chunk.chunkId.replace(/:[0-9]+$/,`:${slot/chunkWidth}`),records:part,chunkDigest:await sha256Hex(canonicalTelemetryV11Json(part))});
  }
  day.chunks=chunks;day.manifest.chunks=chunks.map(chunk=>({chunkId:chunk.chunkId,chunkDigest:chunk.chunkDigest,recordCount:chunk.records.length}));
  day.manifest.manifestDigest=await sha256Hex(telemetryV11DayManifestDigestInput(day.manifest));
  for(const chunk of chunks)chunk.manifestDigest=day.manifest.manifestDigest;
 }
 const staged=await stageV11Day(source(),fixture,day);
 const original=await activate(source(),fixture,staged);
 let legacyChunk:string|undefined;
 if(withV1){const legacy=await createV11DeviceFixture(source());const record={schemaVersion:'quota-observation-v1.0',observationId:`quota-occurrence:v1:${'c'.repeat(64)}`,observedTime:`${today()}T12:00:00.000Z`,provider:'openai_codex',planType:'pro',planVariant:'unknown',limitId:'codex',slot:'secondary',usedPercent:0.30000000000000004,windowDurationMinutes:10080,resetsAt:`${today()}T13:00:00.000Z`};
 const legacyRecords=Array.from({length:v1Count},(_,i)=>({...record,observationId:`quota-occurrence:v1:${(i+128).toString(16).padStart(64,'0')}`,usedPercent:record.usedPercent}));
 const envelopeDigest=await sha256Hex('synthetic-v1-preserved');const principal=await authenticateDevice(source(),legacy.authorization);const upload=await createDeviceUploadAuthorization(source(),principal,envelopeDigest,200);const claim=await claimDeviceUploadAuthorization(source(),`Upload ${upload.uploadAuthorization}`,{envelopeDigest,bodyBytes:200,contentType:'application/json'});
 const chunk=parseTelemetryV1Chunk({schemaVersion:'telemetry-contribution-v1.0',chunkId:`quota:${today()}:0`,chunkRevision:1,chunkDigest:await sha256Hex(canonicalTelemetryV11Json(legacyRecords)),parserVersion:'synthetic-v1',consent:{telemetrySchemaVersion:'telemetry-contribution-v1.0',fieldDictionaryVersion:'telemetry-v1.0-registry-2026-08-07.1',privacyContractVersion:'ongoing-privacy-safe-telemetry-v1.0'},records:legacyRecords});legacyChunk=`chunk:${crypto.randomUUID()}`;
 await insertTelemetryV1Chunk(source(),{chunkRowId:legacyChunk,participantId:legacy.participantId,deviceId:legacy.deviceId,chunk,envelopeDigest,r2Key:'synthetic/legacy',deviceUploadAuthorizationId:claim.authorizationId,createdAt:new Date().toISOString(),supersedes:null});await source().prepare("UPDATE sqlite_sequence SET seq=500 WHERE name='telemetry_v1_records'").run();}

 for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,b.TEST_TYPED_V11_ADMISSION_MIGRATIONS,b.TEST_TYPED_V1_ADMISSION_MIGRATIONS,b.TEST_INGESTION_ISOLATION_MIGRATIONS])await applyD1Migrations(reference(),migrations);
 const role=await prepareAuthorityRoleTarget(reference(),target(),await authoritySchemaDigest(await authoritySchemaInventory(reference())));
 const sourceSchema=await authoritySchemaInventory(source()),retained=new Set(authorityRestoreRetainedTableNames());
 const sourceNamespace='synthetic.restored.'+'x'.repeat(130),sourceSnapshotDigest='a'.repeat(64);
 const tables:AuthorityRestoreContract['tables']=sourceSchema.filter(x=>x.type==='table').map(x=>({name:x.name,disposition:retained.has(x.name)?'authority':x.name==='telemetry_v1_records'?'typed-v1':x.name==='telemetry_v11_records'?'typed-v11':x.name==='d1_migrations'?'outside-role':'analytics'}));
 const authoritySequences=[];for(const object of sourceSchema.filter(x=>x.type==='table'&&(retained.has(x.name)||x.name==='telemetry_v1_records')&&/AUTOINCREMENT/.test(x.sql)))authoritySequences.push({name:object.name,sequence:await source().prepare('SELECT seq FROM sqlite_sequence WHERE name=?').bind(object.name).first<number>('seq')??0});
 const ledgerRows=[{name:'0001_restore_base.sql',sha256:'f'.repeat(64)}] as const;
 await target().batch([target().prepare(AUTHORITY_OPERATOR_LEDGER_SQL),target().prepare('INSERT INTO d1_storage_migrations VALUES(?,?)').bind(ledgerRows[0].name,ledgerRows[0].sha256)]);
 role.baseSchema.push({type:'table',name:'d1_storage_migrations',tbl_name:'d1_storage_migrations',sql:AUTHORITY_OPERATOR_LEDGER_SQL});
 role.finalSchema.push({type:'table',name:'d1_storage_migrations',tbl_name:'d1_storage_migrations',sql:AUTHORITY_OPERATOR_LEDGER_SQL});
 role.baseSchema.sort((a,b)=>a.type<b.type?-1:a.type>b.type?1:a.name<b.name?-1:a.name>b.name?1:0);role.finalSchema.sort((a,b)=>a.type<b.type?-1:a.type>b.type?1:a.name<b.name?-1:a.name>b.name?1:0);
 const contract:AuthorityRestoreContract={targetOperatorLedgerDigest:await sha256Hex(canonicalTelemetryV11Json(ledgerRows)),version:'authority-restore-v1',runId:'synthetic-real-role',sourceId:'synthetic-restored-journal',sourceNamespace,sourceSnapshotDigest,sourceSchema,sourceSchemaDigest:await authoritySchemaDigest(sourceSchema),targetBaseSchema:role.baseSchema,targetBaseSchemaDigest:await authoritySchemaDigest(role.baseSchema),tables,finalSchema:role.finalSchema,finalSchemaDigest:await authoritySchemaDigest(role.finalSchema),typedCopies:['v1','v11'].map(format=>({runId:`restore-${format}`,sourceNamespace,sourceSnapshotDigest,format:format as 'v1'|'v11'})),authoritySequences,admissionContract:'typed-v1-v11-restore-v1',operatingLimitBytes:64*1024*1024};
 return {fixture,records,original,legacyChunk,contract,pin:await authorityRestoreContractDigest(contract)};
}
async function drain(step:()=>Promise<boolean>){for(let n=0;n<256;n++)if(await step())return;throw new Error('Synthetic bounded operation did not complete');}

function measured(db:D1Database,mutate?:(sql:string,row:unknown)=>unknown,mutateBatch?:(results:D1Result[])=>unknown,beforeWrite?:()=>Promise<void>,afterWrite?:()=>void){
 const stats={roundtrips:0,statements:0,maxParameters:0,maxBatchBytes:0,writeTransactions:[] as {sql:string;args:unknown[]}[][],readQueries:[] as {sql:string;args:unknown[]}[],readBatchSizes:[] as number[]};
 const metadata=new WeakMap<object,{inner:D1PreparedStatement;sql:string;args:unknown[]}>();
 const wrap=(inner:D1PreparedStatement,sql:string,args:unknown[]=[]):D1PreparedStatement=>{
  const proxy=new Proxy(inner,{get(o,key){
   if(key==='bind')return(...values:unknown[])=>{stats.maxParameters=Math.max(stats.maxParameters,values.length);return wrap(o.bind(...values),sql,values);};
   if(['first','all','run','raw'].includes(String(key)))return async(...values:unknown[])=>{
    stats.roundtrips++;stats.statements++;const result=await (Reflect.get(o,key) as (...v:unknown[])=>Promise<unknown>).apply(o,values);
    return mutate&&key==='first'?mutate(sql,result):result;
   };
   const value=Reflect.get(o,key);return typeof value==='function'?value.bind(o):value;
  }});metadata.set(proxy,{inner,sql,args});return proxy;
 };
 const wrapped=new Proxy(db,{get(o,key){
  if(key==='prepare')return(sql:string)=>wrap(o.prepare(sql),sql);
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   stats.roundtrips++;stats.statements+=statements.length;
   const entries=statements.map(s=>metadata.get(s)!);expect(entries.every(Boolean)).toBe(true);
   const encoder=new TextEncoder();stats.maxBatchBytes=Math.max(stats.maxBatchBytes,entries.reduce((sum,e)=>sum+encoder.encode(e.sql).byteLength+e.args.reduce<number>((n,v)=>n+(typeof v==='string'?encoder.encode(v).byteLength:v instanceof ArrayBuffer?v.byteLength:8),0),0));
   if(entries.every(e=>/^SELECT\b/.test(e.sql))){stats.readBatchSizes.push(entries.length);stats.readQueries.push(...entries.map(e=>({sql:e.sql,args:e.args})));}
   else stats.writeTransactions.push(entries.map(e=>({sql:e.sql,args:e.args.map(v=>v instanceof ArrayBuffer?Array.from(new Uint8Array(v)):v)})));
   const writes=!entries.every(e=>/^SELECT\b/.test(e.sql));
   if(writes&&beforeWrite)await beforeWrite();
   const result=await o.batch(entries.map(e=>e.inner));
   if(writes&&afterWrite)afterWrite();
   if(mutateBatch&&entries.every(e=>/^SELECT\b/.test(e.sql)))return mutateBatch(result);
   return mutate?result.map((r,i)=>({...r,results:r.results.map(row=>mutate(entries[i]!.sql,row))})):result;
  };
  const value=Reflect.get(o,key);return typeof value==='function'?value.bind(o):value;
 }});
 return {db:wrapped,stats};
}

async function readyForAdoption(usageCount=102,chunkWidth=200,v1Count=32){
 const f=await prepare(true,usageCount,chunkWidth,v1Count);await freezeAuthorityRestoreSource(source(),f.contract,f.pin);await beginAuthorityRestore(source(),target(),f.contract,f.pin);
 await drain(async()=>(await copyAuthorityPage(source(),target(),f.contract,f.pin)).state==='complete');
 for(const format of ['v1','v11'] as const)await drain(async()=>(await copyAuthorityTypedPage(source(),target(),f.contract,f.pin,format)).reachedEnd);
 return {f,options:{format:'v11' as const,sourceNamespace:f.contract.sourceNamespace,contractDigest:f.pin,limit:100}};
}
async function assertFirstPage(f:Awaited<ReturnType<typeof prepare>>){
 const typed=await readTypedTelemetryPage(target(),{sourceNamespace:f.contract.sourceNamespace,format:'v11',limit:100});
 const raw=(await source().prepare('SELECT record_json FROM telemetry_v11_records ORDER BY rowid LIMIT 100').all<{record_json:string}>()).results;
 expect(typed.records.map(r=>r.canonicalRecord)).toEqual(raw.map(r=>r.record_json));
 expect(typed.records.some(r=>JSON.parse(r.canonicalRecord).schemaVersion==='quota-observation-v1.1')).toBe(true);
 expect(typed.records.some(r=>JSON.parse(r.canonicalRecord).schemaVersion==='session-dimension-v1.1')).toBe(true);
 expect(await target().prepare('SELECT count(*) n FROM typed_v11_record_proofs').first('n')).toBe(100);
 expect(await target().prepare(`SELECT count(*) n FROM typed_v11_record_proofs p JOIN typed_telemetry_records r ON r.id=p.typed_record_id
  WHERE p.chunk_key!=r.chunk_id OR p.manifest_key!=r.manifest_id OR p.stream_code!=r.stream OR p.occurrence_blob!=r.occurrence_id OR p.observed_at_ms!=r.observed_at_ms`).first('n')).toBe(0);
 expect(await target().prepare("SELECT after_id,copied,done FROM _authority_restore_adoption WHERE format='v11'").first()).toEqual({after_id:100,copied:100,done:0});
}
describe('bounded native D1 adoption reads',()=>{
 it('preserves 100 mixed records, exact proof bindings, all-page counts and replay while bounding statements and calls',async()=>{
  const {f,options}=await readyForAdoption();
  const copy=measured(target());expect(await restoreTypedAdmissionPage(copy.db,options)).toEqual({done:false,records:100});
  expect(copy.stats.roundtrips).toBe(10);expect(copy.stats.statements).toBeLessThan(130);expect(copy.stats.readBatchSizes).toEqual([2,6]);
  expect(copy.stats.writeTransactions.map(x=>x.length)).toEqual([107]);await assertFirstPage(f);
  expect(await restoreTypedAdmissionPage(target(),options)).toEqual({done:false,records:4});expect(await restoreTypedAdmissionPage(target(),options)).toEqual({done:true,records:0});
  const replay=measured(target());expect(await restoreTypedAdmissionPage(replay.db,options)).toEqual({done:true,records:0});expect(replay.stats.writeTransactions).toEqual([]);
  const v1={...options,format:'v1' as const},copyV1=measured(target());
  expect(await restoreTypedAdmissionPage(copyV1.db,v1)).toEqual({done:false,records:32});
  expect(copyV1.stats).toMatchObject({statements:45,roundtrips:9,readBatchSizes:[1,2]});expect(copyV1.stats.writeTransactions.map(x=>x.length)).toEqual([36]);
  expect(await restoreTypedAdmissionPage(target(),v1)).toEqual({done:true,records:0});
  await sealAuthorityRestore(source(),target(),f.contract,f.pin);
  const verify={...options,verify:true};
  for(const change of ['missing-result','missing-row','extra-row','failed-result']){
   const wrapped=measured(target(),undefined,results=>change==='missing-result'?results.slice(1):results.map((row,index)=>index?row:change==='missing-row'?{...row,results:[]}:change==='extra-row'?{...row,results:[...row.results,...row.results]}:{...row,success:false}));
   await expect(restoreTypedAdmissionPage(wrapped.db,verify),change).rejects.toThrow('AUTHORITY_RESTORE_ADOPTION_MISMATCH');
   expect(wrapped.stats.writeTransactions,change).toEqual([]);expect(await target().prepare("SELECT verified FROM _authority_restore_adoption WHERE format='v11'").first('verified')).toBe(0);
  }
  await expect(restoreTypedAdmissionPage(target(),{...verify,contractDigest:'e'.repeat(64)})).rejects.toThrow('AUTHORITY_RESTORE_ADOPTION_MISMATCH');
  await expect(restoreTypedAdmissionPage(target(),{...verify,verify:false})).rejects.toThrow('AUTHORITY_RESTORE_ADOPTION_MISMATCH');
  const checked=measured(target());expect(await restoreTypedAdmissionPage(checked.db,verify)).toEqual({done:false,records:100});
  expect(checked.stats.roundtrips).toBe(10);expect(checked.stats.statements).toBeLessThan(25);expect(checked.stats.readBatchSizes).toEqual([2,6,5]);expect(checked.stats.writeTransactions.map(x=>x.length)).toEqual([2]);
  await drain(async()=>(await restoreTypedAdmissionPage(target(),verify)).done);expect(await restoreTypedAdmissionPage(target(),verify)).toEqual({done:true,records:0});
  const checkedV1=measured(target());expect(await restoreTypedAdmissionPage(checkedV1.db,{...v1,verify:true})).toEqual({done:false,records:32});
  expect(checkedV1.stats).toMatchObject({statements:13,roundtrips:9,readBatchSizes:[1,2,3]});expect(checkedV1.stats.writeTransactions.map(x=>x.length)).toEqual([2]);
  expect(await restoreTypedAdmissionPage(target(),{...v1,verify:true})).toEqual({done:true,records:0});
  expect((await target().prepare('SELECT format,copied,verified,done,verify_done FROM _authority_restore_adoption ORDER BY format').all()).results)
   .toEqual([{format:'v1',copied:32,verified:32,done:1,verify_done:1},{format:'v11',copied:104,verified:104,done:1,verify_done:1}]);
  expect(await source().prepare('SELECT count(*) n FROM telemetry_v11_records').first('n')).toBe(104);
  expect(await target().prepare('SELECT count(*) n FROM typed_telemetry_records WHERE format=11').first('n')).toBe(104);
  const quota=(await target().prepare('SELECT used_percent FROM typed_telemetry_quota ORDER BY used_percent').all()).results;
  expect(quota.filter(r=>r.used_percent===null)).toHaveLength(1);expect(quota.filter(r=>r.used_percent===0.30000000000000004)).toHaveLength(32);
 },30000);
 it('uses the existing chunk index on exact role schemas and preserves 200-row, neighboring, final and empty ranges',async()=>{
  const {f,options}=await readyForAdoption(200),wrapped=measured(target());
  expect(await restoreTypedAdmissionPage(wrapped.db,options)).toEqual({done:false,records:100});
  const probes=wrapped.stats.readQueries.filter(q=>q.sql.includes('min(source_row_id) first_id'));
  expect(probes).toHaveLength(3);
  const sql=probes[0]!.sql;
  for(const db of [reference(),target()]){
   const index=(await db.prepare('PRAGMA index_info(sqlite_autoindex_typed_telemetry_records_2)').all<{name:string}>()).results;
   expect(index.map(x=>x.name)).toEqual(['chunk_id','occurrence_id']);
   const plan=(await db.prepare('EXPLAIN QUERY PLAN '+sql).bind(...probes[0]!.args).all<{detail:string}>()).results.map(x=>x.detail).join('\n');
   expect(plan).toMatch(/USING INDEX sqlite_autoindex_typed_telemetry_records_2 \(chunk_id=\?\)/);
   expect(plan).not.toMatch(/USING (?:COVERING )?INDEX .*\(namespace_id=/);
  }
  const memberships=(await target().prepare('SELECT namespace_id,format,chunk_id,min(source_row_id) first_id,max(source_row_id) last_id,count(*) count FROM typed_telemetry_records WHERE format=11 GROUP BY chunk_id ORDER BY first_id').all<{namespace_id:number;format:number;chunk_id:number;first_id:number;last_id:number;count:number}>()).results;
  expect(memberships.map(r=>r.count)).toEqual([1,1,200]);
  for(const row of memberships){
   expect(await target().prepare(sql).bind(row.namespace_id,row.format,row.chunk_id).first()).toEqual({first_id:row.first_id,last_id:row.last_id,count:row.count});
   for(const args of [[row.namespace_id+1000,row.format,row.chunk_id],[row.namespace_id,10,row.chunk_id],[row.namespace_id,row.format,-1]])
    expect(await target().prepare(sql).bind(...args).first()).toEqual({first_id:null,last_id:null,count:0});
  }
  const last=measured(target());expect(await restoreTypedAdmissionPage(last.db,options)).toEqual({done:false,records:100});
  expect(await restoreTypedAdmissionPage(target(),options)).toEqual({done:false,records:2});
  expect(await restoreTypedAdmissionPage(target(),options)).toEqual({done:true,records:0});
  expect(await target().prepare('SELECT count(*) n FROM typed_v11_record_proofs').first('n')).toBe(202);
  expect(await source().prepare('SELECT count(*) n FROM telemetry_v11_records').first('n')).toBe(202);
 },30000);

 it('refuses overfull retained chunks after a bounded 201-row acquisition without advancing adoption',async()=>{
  const {options}=await readyForAdoption(200);
  const row=(await readTypedTelemetryPage(target(),{sourceNamespace:options.sourceNamespace,format:'v11',afterSourceRowId:2,limit:1})).records[0]!;
  const {canonicalRecord:_canonical,legacy:_legacy,...original}=row;
  const extra=Array.from({length:100},(_,i)=>({...original,sourceRowId:203+i,record:{...row.record,eventId:`event:v2:${(1000+i).toString(16).padStart(64,'0')}`}}));
  await persistTypedTelemetryBatch(target(),extra);
  const wrapped=measured(target());
  await expect(restoreTypedAdmissionPage(wrapped.db,options)).rejects.toThrow('AUTHORITY_RESTORE_ADOPTION_MISMATCH');
  expect(wrapped.stats.writeTransactions).toEqual([]);
  const probe=wrapped.stats.readQueries.find(q=>q.sql.includes('min(source_row_id) first_id')&&q.args[2]===1)??wrapped.stats.readQueries.filter(q=>q.sql.includes('min(source_row_id) first_id')).at(-1)!;
  const full=(await target().prepare('SELECT chunk_id,count(*) n FROM typed_telemetry_records WHERE format=11 GROUP BY chunk_id ORDER BY n DESC LIMIT 1').first<{chunk_id:number;n:number}>())!;
  expect(full.n).toBe(300);
  const result=await target().prepare(probe.sql).bind(probe.args[0],11,full.chunk_id).first<{count:number}>();
  expect(result?.count).toBe(201);
  expect(await target().prepare("SELECT after_id,copied FROM _authority_restore_adoption WHERE format='v11'").first()).toEqual({after_id:0,copied:0});
  expect(await target().prepare('SELECT count(*) n FROM typed_v11_record_proofs').first('n')).toBe(0);
 },30000);

 it('refuses a noncontiguous retained chunk without advancing its page',async()=>{
  const {options}=await readyForAdoption(200);
  await target().prepare('DELETE FROM typed_telemetry_records WHERE format=11 AND source_row_id=100').run();
  const wrapped=measured(target());await expect(restoreTypedAdmissionPage(wrapped.db,options)).rejects.toThrow('AUTHORITY_RESTORE_ADOPTION_MISMATCH');
  expect(wrapped.stats.writeTransactions).toEqual([]);
  expect(await target().prepare("SELECT copied FROM _authority_restore_adoption WHERE format='v11'").first('copied')).toBe(0);
 },30000);
 for(const corruption of ['digest','foreign-owner'] as const)it(`refuses actual ${corruption} proof corruption without advancing verification or deleting evidence`,async()=>{
  const {f,options}=await readyForAdoption();
  for(const format of ['v1','v11'] as const)await drain(async()=>(await restoreTypedAdmissionPage(target(),{...options,format})).done);
  if(corruption==='digest')await target().prepare('UPDATE typed_v11_record_proofs SET base_digest=zeroblob(32)').run();
  else await target().prepare('UPDATE typed_v11_owner_memberships SET typed_owner_id=(SELECT typed_owner_id FROM typed_v1_owner_memberships LIMIT 1)').run();
  await sealAuthorityRestore(source(),target(),f.contract,f.pin);
  const wrapped=measured(target());await expect(restoreTypedAdmissionPage(wrapped.db,{...options,verify:true})).rejects.toThrow('AUTHORITY_RESTORE_ADOPTION_MISMATCH');
  expect(wrapped.stats.writeTransactions).toEqual([]);expect(await target().prepare("SELECT verify_after,verified,verify_done FROM _authority_restore_adoption WHERE format='v11'").first()).toEqual({verify_after:0,verified:0,verify_done:0});
  expect(await source().prepare('SELECT count(*) n FROM telemetry_v11_records').first('n')).toBe(104);
  expect(await target().prepare('SELECT count(*) n FROM typed_v11_record_proofs').first('n')).toBe(104);
 },30000);
 for(const boundary of ['concurrent-page','lost-write-response'] as const)it(`retains exact page membership through ${boundary}`,async()=>{
  const {f,options}=await readyForAdoption();let first=true;
  const wrapped=measured(target(),undefined,undefined,boundary==='concurrent-page'?async()=>{if(first){first=false;await restoreTypedAdmissionPage(target(),options);}}:undefined,
   boundary==='lost-write-response'?()=>{if(first){first=false;throw new Error('synthetic response loss after commit');}}:undefined);
  expect(await restoreTypedAdmissionPage(wrapped.db,options)).toEqual({done:false,records:100});expect(wrapped.stats.writeTransactions).toHaveLength(1);await assertFirstPage(f);
  expect(await restoreTypedAdmissionPage(target(),options)).toEqual({done:false,records:4});
  expect(await target().prepare("SELECT copied FROM _authority_restore_adoption WHERE format='v11'").first('copied')).toBe(104);
 },30000);

 it('produces identical v1/v11 proofs, source IDs and durable completion with 100 versus 200 rows',async()=>{
  const {f,options}=await readyForAdoption(398,200,200),other=b.STORAGE_ANALYTICS_DB;
  await prepareAuthorityRoleTarget(reference(),other,await authoritySchemaDigest(await authoritySchemaInventory(reference())));
  await other.batch([other.prepare(AUTHORITY_OPERATOR_LEDGER_SQL),other.prepare('INSERT INTO d1_storage_migrations VALUES(?,?)').bind('0001_restore_base.sql','f'.repeat(64))]);
  await beginAuthorityRestore(source(),other,f.contract,f.pin);
  await drain(async()=>(await copyAuthorityPage(source(),other,f.contract,f.pin)).state==='complete');
  for(const format of ['v1','v11'] as const)await drain(async()=>(await copyAuthorityTypedPage(source(),other,f.contract,f.pin,format)).reachedEnd);
  const measurements=[];
  for(const [db,limit] of [[target(),100],[other,200]] as const){
   const wrapped=measured(db),started=performance.now();let pages=0;
   for(const format of ['v1','v11'] as const)await drain(async()=>{const step=await restoreTypedAdmissionPage(wrapped.db,{...options,format,limit});if(step.records)pages++;return step.done;});
   await sealAuthorityRestore(source(),db,f.contract,f.pin);
   for(const format of ['v1','v11'] as const)await drain(async()=>{const step=await restoreTypedAdmissionPage(wrapped.db,{...options,format,limit,verify:true});if(step.records)pages++;return step.done;});
   measurements.push({limit,pages,statements:wrapped.stats.statements,roundtrips:wrapped.stats.roundtrips,elapsedMs:performance.now()-started});
   expect(wrapped.stats.maxParameters).toBeLessThanOrEqual(100);expect(wrapped.stats.maxBatchBytes).toBeLessThanOrEqual(4*1024*1024);
  }
  for(const table of [...AUTHORITY_ADMISSION_TABLES,'typed_v11_record_admissions','_authority_restore_adoption','storage_raw_copy_pages']){
   const read=async(db:D1Database)=>(await db.prepare(`SELECT * FROM ${table}`).all()).results.map(row=>canonicalTelemetryV11Json(row)).sort();
   expect(await read(other),table).toEqual(await read(target()));
  }
  expect(measurements.map(m=>m.pages)).toEqual([12,6]);
  expect(measurements[1]!.statements).toBeLessThan(measurements[0]!.statements);
  expect(measurements[1]!.roundtrips).toBeLessThan(measurements[0]!.roundtrips);
  console.log('synthetic-adoption-page-comparison',JSON.stringify(measurements));
  expect(await source().prepare('SELECT count(*) n FROM telemetry_v11_records').first('n')).toBe(400);
 },30000);

 it('uses 200 rows through the public coordinator and preserves its total source/target budget',async()=>{
  const {f}=await readyForAdoption(200),s=measured(source()),t=measured(target());
  expect(await adoptAuthorityTypedPage(s.db,t.db,f.contract,f.pin,'v11')).toEqual({done:false,records:200});
  expect(s.stats.statements+t.stats.statements).toBeLessThanOrEqual(900);
  expect(t.stats.readBatchSizes).toEqual([3,6]);expect(t.stats.writeTransactions[0]).toHaveLength(207);
  expect(await target().prepare("SELECT after_id,copied FROM _authority_restore_adoption WHERE format='v11'").first()).toEqual({after_id:200,copied:200});
  expect(t.stats.maxParameters).toBeLessThanOrEqual(100);
 },30000);

 it('reduces a high-cardinality public page deterministically without crossing the invocation budget',async()=>{
  const {f}=await readyForAdoption(200,1),s=measured(source()),t=measured(target());
  const page=await adoptAuthorityTypedPage(s.db,t.db,f.contract,f.pin,'v11');
  const remaining=900-64-2*f.contract.authoritySequences.length;
  expect(page).toEqual({done:false,records:Math.floor((remaining-34)/4)});
  expect(page.records).toBeLessThan(200);expect(page.records).toBeGreaterThan(0);
  expect(s.stats.statements+t.stats.statements).toBeLessThanOrEqual(900);
  expect(await target().prepare('SELECT count(*) n FROM typed_v11_record_proofs').first('n')).toBe(page.records);
  await drain(async()=>(await adoptAuthorityTypedPage(source(),target(),f.contract,f.pin,'v11')).done);
  await drain(async()=>(await adoptAuthorityTypedPage(source(),target(),f.contract,f.pin,'v1')).done);
  await sealAuthorityRestore(source(),target(),f.contract,f.pin);
  const checkedSource=measured(source()),checkedTarget=measured(target());
  expect(await adoptAuthorityTypedPage(checkedSource.db,checkedTarget.db,f.contract,f.pin,'v11',true)).toEqual({done:false,records:200});
  expect(checkedSource.stats.statements+checkedTarget.stats.statements).toBeLessThanOrEqual(900);
 },30000);

 it('shrinks a byte-limited prefix before its proof transaction and resumes every remaining row',async()=>{
  const {options}=await readyForAdoption(200),wrapped=measured(target());
  const maxBytes=128*1024;
  const page=await restoreTypedAdmissionPage(wrapped.db,{...options,limit:200,maxBytes});
  expect(page.records).toBeGreaterThan(0);expect(page.records).toBeLessThan(200);
  expect(wrapped.stats.maxBatchBytes).toBeLessThanOrEqual(maxBytes);
  expect(await target().prepare('SELECT count(*) n FROM typed_v11_record_proofs').first('n')).toBe(page.records);
  await drain(async()=>(await restoreTypedAdmissionPage(target(),{...options,limit:200,maxBytes})).done);
  expect(await target().prepare("SELECT copied FROM _authority_restore_adoption WHERE format='v11'").first('copied')).toBe(202);
 },30000);

 it('maps reordered sets exactly and refuses duplicate, foreign and wrongly typed stored-row keys',async()=>{
  const {options}=await readyForAdoption(200);
  for(const change of ['duplicate','foreign','wrong-type','wrong-id-type','conflicting-owner']){
   const wrapped=measured(target(),undefined,results=>results.map(result=>{
    const sourceRows=result.results as Record<string,unknown>[];
    if(sourceRows[0]?.source_row_id===undefined)return result;
    const rows=sourceRows.map(row=>({...row}));
    if(change==='duplicate')rows[1]=rows[0]!;
    else if(change==='foreign')rows[0]!.source_row_id=999999;
    else if(change==='wrong-type')rows[0]!.source_row_id=String(rows[0]!.source_row_id);
    else if(change==='wrong-id-type')rows[0]!.id=String(rows[0]!.id);
    else rows[1]!.owner_id=Number(rows[0]!.owner_id)+100;
    return {...result,results:rows};
   }));
   await expect(restoreTypedAdmissionPage(wrapped.db,{...options,limit:200}),change).rejects.toThrow('AUTHORITY_RESTORE_ADOPTION_MISMATCH');
   expect(wrapped.stats.writeTransactions).toEqual([]);
  }
  const reordered=measured(target(),undefined,results=>results.map(result=>({...result,results:[...result.results].reverse()})));
  expect(await restoreTypedAdmissionPage(reordered.db,{...options,limit:200})).toEqual({done:false,records:200});
  expect(await target().prepare('SELECT count(*) n FROM typed_v11_record_proofs').first('n')).toBe(200);
 },30000);

 it('verifies every keyed proof despite reordering and refuses mismatched result identity or cardinality',async()=>{
  const {f,options}=await readyForAdoption(200);
  for(const format of ['v1','v11'] as const)await drain(async()=>(await restoreTypedAdmissionPage(target(),{...options,format,limit:200})).done);
  await sealAuthorityRestore(source(),target(),f.contract,f.pin);
  for(const change of ['duplicate','foreign','wrong-type','missing','failed']){
   const wrapped=measured(target(),undefined,results=>results.map(result=>{
    const sourceRows=result.results as Record<string,unknown>[];
    if(sourceRows[0]?.typed_record_id===undefined)return result;
    const rows=sourceRows.map(row=>({...row}));
    if(change==='duplicate')rows[1]=rows[0]!;
    else if(change==='foreign')rows[0]!.typed_record_id=999999;
    else if(change==='wrong-type')rows[0]!.typed_record_id=String(rows[0]!.typed_record_id);
    return {...result,success:change!=='failed',results:change==='missing'?rows.slice(1):rows};
   }));
   await expect(restoreTypedAdmissionPage(wrapped.db,{...options,limit:200,verify:true}),change).rejects.toThrow('AUTHORITY_RESTORE_ADOPTION_MISMATCH');
   expect(wrapped.stats.writeTransactions).toEqual([]);
   expect(await target().prepare("SELECT verified FROM _authority_restore_adoption WHERE format='v11'").first('verified')).toBe(0);
  }
  const reordered=measured(target(),undefined,results=>results.map(result=>({...result,results:[...result.results].reverse()})));
  expect(await restoreTypedAdmissionPage(reordered.db,{...options,limit:200,verify:true})).toEqual({done:false,records:200});
  expect(reordered.stats.readBatchSizes).toEqual([3,6,7]);
 },30000);

 it('does not acknowledge a differently sized concurrent prefix and resumes only its committed watermark',async()=>{
  const {options}=await readyForAdoption(200);let first=true;
  const raced=measured(target(),undefined,undefined,async()=>{if(first){first=false;await restoreTypedAdmissionPage(target(),{...options,limit:100});}});
  await expect(restoreTypedAdmissionPage(raced.db,{...options,limit:200})).rejects.toThrow('AUTHORITY_RESTORE_ADOPTION_UNACKNOWLEDGED');
  expect(await target().prepare('SELECT count(*) n FROM typed_v11_record_proofs').first('n')).toBe(100);
  expect(await restoreTypedAdmissionPage(target(),{...options,limit:200})).toEqual({done:false,records:102});
  expect(await target().prepare("SELECT copied,after_id FROM _authority_restore_adoption WHERE format='v11'").first()).toEqual({copied:202,after_id:202});
 },30000);

 it('rolls back shared writes and every proof on a late insert failure, then retries the same 200 rows',async()=>{
  const {options}=await readyForAdoption(200);
  await target().prepare(`CREATE TRIGGER synthetic_last_proof BEFORE INSERT ON typed_v11_record_proofs
   WHEN NEW.typed_record_id=(SELECT id FROM typed_telemetry_records WHERE format=11 AND source_row_id=200)
   BEGIN SELECT RAISE(ABORT,'synthetic late proof failure'); END`).run();
  await expect(restoreTypedAdmissionPage(target(),{...options,limit:200})).rejects.toThrow('AUTHORITY_RESTORE_ADOPTION_UNACKNOWLEDGED');
  for(const table of ['typed_v11_record_proofs','typed_v11_chunk_allocations','typed_v11_owner_memberships','typed_v11_manifest_memberships'])expect(await target().prepare(`SELECT count(*) n FROM ${table}`).first('n')).toBe(0);
  expect(await target().prepare("SELECT copied,after_id FROM _authority_restore_adoption WHERE format='v11'").first()).toEqual({copied:0,after_id:0});
  await target().prepare('DROP TRIGGER synthetic_last_proof').run();
  let once=true;const lost=measured(target(),undefined,undefined,undefined,()=>{if(once){once=false;throw new Error('synthetic committed response loss');}});
  expect(await restoreTypedAdmissionPage(lost.db,{...options,limit:200})).toEqual({done:false,records:200});
  expect(await restoreTypedAdmissionPage(target(),{...options,limit:200})).toEqual({done:false,records:2});
  expect(await target().prepare('SELECT count(*) n FROM typed_v11_record_proofs').first('n')).toBe(202);
 },30000);
});
