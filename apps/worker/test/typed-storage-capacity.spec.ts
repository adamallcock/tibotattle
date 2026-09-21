import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,describe,it,expect} from 'vitest';
import {canonicalTelemetryV11Json} from '@app-usagemonitor/telemetry-contract';
import {createV11DeviceFixture,makeV11Day,v11UsageRecord} from './helpers/telemetry-v11';
import {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization} from '../src/device-auth';
import {initializeTypedV1Admission,insertTypedTelemetryV1Chunk} from '../src/typed-v1-admission';
import {initializeTypedV11Admission,persistTypedV11StagedChunk} from '../src/typed-v11-admission';
import {registerTelemetryV11DayManifest,telemetryV11LegacyProjection} from '../src/telemetry-v11-repository';
import {parseTelemetryV1Chunk} from '../src/telemetry-v1';
import {initializeStorageSource,STORAGE_OPERATING_BUDGET_BYTES} from '../src/analytics-delivery';
import {sha256Hex} from '../src/crypto';
import {assertTypedStorageAdmissionCapacity,TYPED_STORAGE_ADMISSION_HEADROOM_BYTES} from '../src/typed-storage-capacity';
const b=env as Env&{TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[]};
const db=()=>b.USAGE_MONITOR_DB,namespace='synthetic-capacity',day=()=>new Date().toISOString().slice(0,10);
const threshold=STORAGE_OPERATING_BUDGET_BYTES-TYPED_STORAGE_ADMISSION_HEADROOM_BYTES;
beforeEach(async()=>{
 await reset();for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,
  b.TEST_TYPED_V11_ADMISSION_MIGRATIONS,b.TEST_TYPED_V1_ADMISSION_MIGRATIONS])await applyD1Migrations(db(),migrations);
 await initializeStorageSource(db(),'synthetic-capacity-journal');await initializeTypedV11Admission(db(),namespace);await initializeTypedV1Admission(db(),namespace);
});
function observed(size:unknown,fail=false){let probes=0,batches=0;
 const proxy=new Proxy(db(),{get(target,key){
  if(key==='prepare')return (sql:string)=>{const statement=target.prepare(sql);
   if(sql!=='SELECT 1 AS typed_admission_capacity_probe')return statement;
   return new Proxy(statement,{get(s,k){if(k==='run')return async()=>{probes++;if(fail)throw new Error('synthetic private transport detail');
    const result=await s.run();return {...result,meta:{...result.meta,size_after:size}};};const v=Reflect.get(s,k);return typeof v==='function'?v.bind(s):v;}});};
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{batches++;return target.batch(statements);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});return {db:proxy,probes:()=>probes,batches:()=>batches};}
async function fixture(format:'v1'|'v11'){
 const owner=await createV11DeviceFixture(db(),{grant:format==='v11'}),envelopeDigest=await sha256Hex(crypto.randomUUID());
 const principal=await authenticateDevice(db(),owner.authorization),upload=await createDeviceUploadAuthorization(db(),principal,envelopeDigest,200);
 const auth=await claimDeviceUploadAuthorization(db(),`Upload ${upload.uploadAuthorization}`,{envelopeDigest,bodyBytes:200,contentType:'application/json'});
 const common={chunkRowId:`chunk:${crypto.randomUUID()}`,r2Key:'synthetic/capacity',envelopeDigest,deviceUploadAuthorizationId:auth.authorizationId};
 if(format==='v11'){
  const prepared=await makeV11Day(day(),{usage:[v11UsageRecord(day())]});await registerTelemetryV11DayManifest(db(),owner,prepared.manifest);
  return {owner,auth,run:(target:D1Database)=>persistTypedV11StagedChunk(target,owner,prepared.chunks[0],{...common,sourceNamespace:namespace})};
 }
 const records=[JSON.parse(telemetryV11LegacyProjection('usage',v11UsageRecord(day()))!.canonicalRecord)];
 const chunk=parseTelemetryV1Chunk({schemaVersion:'telemetry-contribution-v1.0',chunkId:`usage:${day()}:0`,chunkRevision:1,
  chunkDigest:await sha256Hex(canonicalTelemetryV11Json(records)),parserVersion:'synthetic-capacity',records,
  consent:{telemetrySchemaVersion:'telemetry-contribution-v1.0',fieldDictionaryVersion:'telemetry-v1.0-registry-2026-08-07.1',privacyContractVersion:'ongoing-privacy-safe-telemetry-v1.0'}});
 return {owner,auth,run:(target:D1Database)=>insertTypedTelemetryV1Chunk(target,{...common,participantId:owner.participantId,deviceId:owner.deviceId,
  chunk,createdAt:new Date().toISOString(),supersedes:null},namespace)};
}
describe('typed new-chunk physical admission',()=>{
 it.each(['v1','v11'] as const)('refuses new %s payload above headroom without consuming auth; exact replay still works when full',async format=>{
  const f=await fixture(format),full=observed(threshold+1);
  await expect(f.run(full.db)).rejects.toMatchObject({status:503,code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(full.probes()).toBe(1);expect(full.batches()).toBe(0);
  expect(await db().prepare('SELECT count(*) n FROM typed_telemetry_records').first('n')).toBe(0);
  expect(await db().prepare('SELECT state FROM device_upload_authorizations WHERE id=?').bind(f.auth.authorizationId).first('state')).toBe('consuming');
  const admitted=observed(threshold);expect(await f.run(admitted.db)).toMatchObject({replay:false});expect(admitted.probes()).toBe(1);
  const replay=observed(STORAGE_OPERATING_BUDGET_BYTES,true);expect(await f.run(replay.db)).toMatchObject({replay:true});expect(replay.probes()).toBe(0);
  await replay.db.prepare('DELETE FROM participants WHERE id=?').bind(f.owner.participantId).run();
  expect(await db().prepare('SELECT count(*) n FROM typed_telemetry_records').first('n')).toBe(0);
 });
 it.each([undefined,null,-1,NaN,Infinity,1.5])('refuses invalid observed size %s',async size=>{
  await expect(assertTypedStorageAdmissionCapacity(observed(size).db)).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
 });
 it('redacts a failed size probe',async()=>{
  await expect(assertTypedStorageAdmissionCapacity(observed(0,true).db)).rejects.toThrow('BACKEND_STORAGE_UNAVAILABLE');
 });
});
