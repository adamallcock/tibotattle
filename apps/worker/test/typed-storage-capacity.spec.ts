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
import {assertTypedStorageAdmissionCapacity,estimateTypedStorageWriteBytes,prepareTypedStorageAdmissionReservation,reconcileTypedStorageAdmissionReservation,
 TYPED_STORAGE_ADMISSION_HEADROOM_BYTES} from '../src/typed-storage-capacity';
import {ownerWriteFenceStatement} from '../src/storage-routing-fence';
import type {OwnerStorageRoute} from '../src/storage-routing';
const b=env as Env&{TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];TEST_INGESTION_ROUTING_MIGRATIONS:D1Migration[];STORAGE_INGESTION_A:D1Database};
const db=()=>b.USAGE_MONITOR_DB,namespace='synthetic-capacity',day=()=>new Date().toISOString().slice(0,10);
const threshold=STORAGE_OPERATING_BUDGET_BYTES-TYPED_STORAGE_ADMISSION_HEADROOM_BYTES;
beforeEach(async()=>{
 await reset();for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,
  b.TEST_TYPED_V11_ADMISSION_MIGRATIONS,b.TEST_TYPED_V1_ADMISSION_MIGRATIONS,b.TEST_INGESTION_ROUTING_MIGRATIONS])await applyD1Migrations(db(),migrations);
 await initializeStorageSource(db(),'synthetic-capacity-journal');await initializeTypedV11Admission(db(),namespace);await initializeTypedV1Admission(db(),namespace);
});
function observed(size:unknown,fail=false,options:{throwAfterReservationCommit?:boolean;finalSize?:number}={}){
 let probes=0,batches=0,reservationBatches=0;
 const sql=new WeakMap<object,string>();
 const proxy=new Proxy(db(),{get(target,key){
  if(key==='prepare')return (query:string)=>{const statement=target.prepare(query);sql.set(statement,query);
   const wrapped=new Proxy(statement,{get(s,k){
    if(k==='bind')return (...values:(string|number|null|ArrayBuffer)[])=>{const bound=s.bind(...values);sql.set(bound,query);return bound;};
    if(k==='run'&&query==='SELECT 1 AS typed_admission_capacity_probe')return async()=>{probes++;if(fail)throw new Error('synthetic private transport detail');
     const result=await s.run();return {...result,meta:{...result.meta,size_after:size}};};
    const v=Reflect.get(s,k);return typeof v==='function'?v.bind(s):v;}});
   sql.set(wrapped,query);return wrapped;};
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{batches++;
   const queries=statements.map(statement=>sql.get(statement as object)??'');
   const probeIndex=queries.indexOf('SELECT 1 AS typed_admission_capacity_probe');
   if(probeIndex>=0&&fail){probes++;throw new Error('synthetic private transport detail');}
   const results=await target.batch(statements);
   if(probeIndex>=0){probes++;const result=results[probeIndex]!;
    results[probeIndex]={...result,meta:{...result.meta,size_after:size as number}} as D1Result;}
   const reservationIndex=queries.findIndex(query=>query.includes('INSERT INTO storage_write_capacity_reservations'));
   if(reservationIndex>=0)reservationBatches++;
   if(reservationIndex>=0&&options.finalSize!==undefined){const last=results.length-1;
    const result=results[last]!;results[last]={...result,meta:{...result.meta,size_after:options.finalSize}} as D1Result;}
   if(reservationIndex>=0&&options.throwAfterReservationCommit)throw new Error('synthetic lost final acknowledgement');
   return results;};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});return {db:proxy,probes:()=>probes,batches:()=>batches,reservationBatches:()=>reservationBatches};}
async function fixture(format:'v1'|'v11',route?:OwnerStorageRoute){
 const owner=await createV11DeviceFixture(db(),{grant:format==='v11'}),envelopeDigest=await sha256Hex(crypto.randomUUID());
 const principal=await authenticateDevice(db(),owner.authorization),upload=await createDeviceUploadAuthorization(db(),principal,envelopeDigest,200);
 const auth=await claimDeviceUploadAuthorization(db(),`Upload ${upload.uploadAuthorization}`,{envelopeDigest,bodyBytes:200,contentType:'application/json'});
 const common={chunkRowId:`chunk:${crypto.randomUUID()}`,r2Key:'synthetic/capacity',envelopeDigest,deviceUploadAuthorizationId:auth.authorizationId};
 if(format==='v11'){
  const prepared=await makeV11Day(day(),{usage:[v11UsageRecord(day())]});await registerTelemetryV11DayManifest(db(),owner,prepared.manifest);
  return {owner,auth,run:(target:D1Database)=>persistTypedV11StagedChunk(target,owner,prepared.chunks[0],{...common,sourceNamespace:namespace},Date.now(),route)};
 }
 const records=[JSON.parse(telemetryV11LegacyProjection('usage',v11UsageRecord(day()))!.canonicalRecord)];
 const chunk=parseTelemetryV1Chunk({schemaVersion:'telemetry-contribution-v1.0',chunkId:`usage:${day()}:0`,chunkRevision:1,
  chunkDigest:await sha256Hex(canonicalTelemetryV11Json(records)),parserVersion:'synthetic-capacity',records,
  consent:{telemetrySchemaVersion:'telemetry-contribution-v1.0',fieldDictionaryVersion:'telemetry-v1.0-registry-2026-08-07.1',privacyContractVersion:'ongoing-privacy-safe-telemetry-v1.0'}});
 return {owner,auth,run:(target:D1Database)=>insertTypedTelemetryV1Chunk(target,{...common,participantId:owner.participantId,deviceId:owner.deviceId,
  chunk,createdAt:new Date().toISOString(),supersedes:null},namespace,route)};
}
async function catalogRoute(ownerId:string,generation=1):Promise<OwnerStorageRoute>{
 const route={ownerId,shardId:'ingestion-a',bindingName:'STORAGE_INGESTION_A',generation,mode:'catalog' as const};
 await db().prepare(`INSERT INTO storage_owner_fences(owner_id,shard_id,route_generation,state)
  VALUES(?,?,?,'active')`).bind(route.ownerId,route.shardId,route.generation).run();
 return route;
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

 it.each(['v1','v11'] as const)('binds one catalog reservation to the final %s batch and reconciles confirmed growth',async format=>{
  const ownerId=`owner:${crypto.randomUUID()}`,route=await catalogRoute(ownerId),f=await fixture(format,route);
  const target=observed(1_000_000,false,{finalSize:1_500_000});
  await expect(f.run(target.db)).resolves.toMatchObject({replay:false});
  expect(target.probes()).toBe(1);
  expect(target.reservationBatches()).toBe(1);
  expect(await db().prepare('SELECT count(*) AS n FROM storage_write_capacity_reservations').first('n')).toBe(0);
  expect(await db().prepare('SELECT observed_bytes FROM storage_write_capacity_observations WHERE singleton_id=1').first('observed_bytes')).toBe(1_500_000);
 });

 it('fails catalog admission closed when reservation schema or headroom is unavailable',async()=>{
  const route={ownerId:`owner:${crypto.randomUUID()}`,shardId:'ingestion-a',bindingName:'STORAGE_INGESTION_A',generation:1,mode:'catalog' as const};
  await expect(prepareTypedStorageAdmissionReservation(b.STORAGE_INGESTION_A,route,{transactionBytes:0,recordCount:1}))
   .rejects.toMatchObject({status:503,code:'BACKEND_STORAGE_UNAVAILABLE'});
  const installed=await catalogRoute(route.ownerId),reserved=estimateTypedStorageWriteBytes(0,1);
  await expect(prepareTypedStorageAdmissionReservation(observed(STORAGE_OPERATING_BUDGET_BYTES-reserved+1).db,installed,
   {transactionBytes:0,recordCount:1})).rejects.toMatchObject({status:503,code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await db().prepare('SELECT count(*) AS n FROM storage_write_capacity_reservations').first('n')).toBe(0);
 });

 it.each(['v1','v11'] as const)('refuses a new catalog %s write without consuming authority when headroom is insufficient',async format=>{
  const route=await catalogRoute(`owner:${crypto.randomUUID()}`),f=await fixture(format,route);
  await expect(f.run(observed(STORAGE_OPERATING_BUDGET_BYTES).db)).rejects.toMatchObject({status:503,code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await db().prepare('SELECT state FROM device_upload_authorizations WHERE id=?').bind(f.auth.authorizationId).first('state')).toBe('consuming');
  expect(await db().prepare('SELECT count(*) AS n FROM typed_telemetry_records').first('n')).toBe(0);
  expect(await db().prepare('SELECT count(*) AS n FROM storage_write_capacity_reservations').first('n')).toBe(0);
 });

 it('serializes concurrent reservations so the same observed headroom cannot be spent twice',async()=>{
  const route=await catalogRoute(`owner:${crypto.randomUUID()}`),reserved=estimateTypedStorageWriteBytes(0,1);
  const target=observed(STORAGE_OPERATING_BUDGET_BYTES-reserved);
  const [first,second]=await Promise.all([
   prepareTypedStorageAdmissionReservation(target.db,route,{transactionBytes:0,recordCount:1}),
   prepareTypedStorageAdmissionReservation(target.db,route,{transactionBytes:0,recordCount:1}),
  ]);
  const attempts=await Promise.allSettled([
   target.db.batch([ownerWriteFenceStatement(target.db,route),first.statement]),
   target.db.batch([ownerWriteFenceStatement(target.db,route),second.statement]),
  ]);
  expect(attempts.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(attempts.filter(result=>result.status==='rejected')).toHaveLength(1);
  expect(await db().prepare('SELECT count(*) AS n FROM storage_write_capacity_reservations').first('n')).toBe(1);
 });

 it('does not reclaim a later reservation from an earlier confirmed write result',async()=>{
  const route=await catalogRoute(`owner:${crypto.randomUUID()}`),target=observed(0);
  const [first,second]=await Promise.all([
   prepareTypedStorageAdmissionReservation(target.db,route,{transactionBytes:0,recordCount:1}),
   prepareTypedStorageAdmissionReservation(target.db,route,{transactionBytes:0,recordCount:1}),
  ]);
  const firstResults=await target.db.batch([ownerWriteFenceStatement(target.db,route),first.statement]);
  const secondResults=await target.db.batch([ownerWriteFenceStatement(target.db,route),second.statement]);
  expect(await reconcileTypedStorageAdmissionReservation(target.db,first,firstResults[1],firstResults.at(-1))).toBe(true);
  const pending=await db().prepare('SELECT reservation_id FROM storage_write_capacity_reservations').all<{reservation_id:string}>();
  expect(pending.results.map(row=>row.reservation_id)).toEqual([second.reservationId]);
  expect(await reconcileTypedStorageAdmissionReservation(target.db,second,secondResults[1],secondResults.at(-1))).toBe(true);
  expect(await db().prepare('SELECT count(*) AS n FROM storage_write_capacity_reservations').first('n')).toBe(0);
 });

 it('accepts a newer lower physical-size sample without requiring a new write sequence',async()=>{
  const route=await catalogRoute(`owner:${crypto.randomUUID()}`);
  await prepareTypedStorageAdmissionReservation(observed(8_000_000_000).db,route,{transactionBytes:0,recordCount:1});
  await prepareTypedStorageAdmissionReservation(observed(2_000_000_000).db,route,{transactionBytes:0,recordCount:1});
  expect(await db().prepare('SELECT observed_bytes FROM storage_write_capacity_observations WHERE singleton_id=1').first('observed_bytes'))
   .toBe(2_000_000_000);
 });

 it('refuses a reservation whose physical-size evidence expired before the final batch',async()=>{
  const route=await catalogRoute(`owner:${crypto.randomUUID()}`),reservation=await prepareTypedStorageAdmissionReservation(observed(0).db,route,
   {transactionBytes:0,recordCount:1});
  await db().prepare('UPDATE storage_write_capacity_observations SET sampled_at_epoch=0,expires_at_epoch=0').run();
  await expect(db().batch([ownerWriteFenceStatement(db(),route),reservation.statement])).rejects.toThrow('STORAGE_WRITE_CAPACITY_UNAVAILABLE');
  expect(await db().prepare('SELECT count(*) AS n FROM storage_write_capacity_reservations').first('n')).toBe(0);
 });

 it.each(['v1','v11'] as const)('keeps an ambiguous %s reservation until a later actual-size sample reconciles it',async format=>{
  const route=await catalogRoute(`owner:${crypto.randomUUID()}`),f=await fixture(format,route),lost=observed(0,false,{throwAfterReservationCommit:true});
  await expect(f.run(lost.db)).resolves.toMatchObject({replay:true});
  expect(await db().prepare('SELECT count(*) AS n FROM storage_write_capacity_reservations').first('n')).toBe(1);
  await prepareTypedStorageAdmissionReservation(observed(0).db,route,{transactionBytes:0,recordCount:1});
  expect(await db().prepare('SELECT count(*) AS n FROM storage_write_capacity_reservations').first('n')).toBe(0);
 });

 it.each(['v1','v11'] as const)('lets exact catalog %s replay bypass unavailable capacity evidence',async format=>{
  const route=await catalogRoute(`owner:${crypto.randomUUID()}`),f=await fixture(format,route),first=observed(0);
  await expect(f.run(first.db)).resolves.toMatchObject({replay:false});
  const unavailable=observed(STORAGE_OPERATING_BUDGET_BYTES,true);
  await expect(f.run(unavailable.db)).resolves.toMatchObject({replay:true});
  expect(unavailable.probes()).toBe(0);
 });
});
