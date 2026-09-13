import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,it,expect} from 'vitest';
import {createV11DeviceFixture,v11UsageRecord} from './helpers/telemetry-v11';
import {pricedModelHistoryUsage,MODEL_HISTORY_TEST_CAPACITIES} from './helpers/model-history';
import {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization} from '../src/device-auth';
import {parseTelemetryV1Chunk,type TelemetryV1Record} from '../src/telemetry-v1';
import {initializeTypedV1Admission,insertTypedTelemetryV1Chunk} from '../src/typed-v1-admission';
import {initializeTypedV11Admission} from '../src/typed-v11-admission';
import {telemetryV11LegacyProjection} from '../src/telemetry-v11-repository';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {initializeStorageSource} from '../src/analytics-delivery';
import {initializeStorageAnalyticsRuntime,advanceStorageAnalytics} from '../src/storage-analytics-runtime';
import {drainCommunityPublicSourceBootstrap} from '../src/community-daily-aggregates';
import {readStorageCommunityOwnerPage} from '../src/storage-community-authority';
import {captureStorageGraphScope,computeStorageGraphResult} from '../src/storage-community-graph';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';

const b=env as Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_MIGRATIONS:D1Migration[];
 TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];
 TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB,sourceId='synthetic-history-integration';
const namespace='synthetic-history-origin',day='2026-09-05';
const bindings=()=>({source:source(),target:target(),sourceId,sourceNamespace:namespace});
beforeEach(async()=>{
 await reset();for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,
  b.TEST_TYPED_V1_ADMISSION_MIGRATIONS,b.TEST_TYPED_V11_ADMISSION_MIGRATIONS])await applyD1Migrations(source(),migrations);
 await initializeStorageSource(source(),sourceId);await initializeTypedV1Admission(source(),namespace);await initializeTypedV11Admission(source(),namespace);
 await applyD1Migrations(source(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);await applyD1Migrations(target(),b.TEST_ANALYTICS_MIGRATIONS);
 expect((await drainCommunityPublicSourceBootstrap(source())).completed).toBe(true);
 await initializeStorageAnalyticsRuntime(bindings());
});
async function fixture(){
 const owner=await createV11DeviceFixture(source()),groups=new Map<string,TelemetryV1Record[]>();
 const base=Date.parse('2026-09-01T00:00:00Z'),at=(h:number)=>new Date(base+h*3600000).toISOString();
 const push=(stream:string,time:string,record:TelemetryV1Record)=>{const key=`${stream}:${time.slice(0,10)}`;
  const group=groups.get(key)??[];group.push(record);groups.set(key,group);};
 let percent=0;
 const quota=(time:string)=>push('quota',time,{schemaVersion:'quota-observation-v1.0',observationId:`synthetic:${time}`,
  observedTime:time,provider:'openai_codex',planType:'pro',planVariant:'unknown',limitId:'codex',slot:'seven_day',
  usedPercent:percent,windowDurationMinutes:10080,resetsAt:at(168)});
 quota(at(0));
 for(let bin=0;bin<60;bin++){
  for(const [index,[model,capacity]] of Object.entries(MODEL_HISTORY_TEST_CAPACITIES).entries()){
   const cost=(5+((bin*7+index*11)%17)/4)*((bin+index)%3===0?0.2:1),time=at(bin*2+.5);
   const priced=pricedModelHistoryUsage(model,cost,time),fields=JSON.parse(priced.record.recordJson!);
   const record=v11UsageRecord(time.slice(0,10),'a',{...fields,eventTime:time,eventId:`synthetic:${bin}:${index}`});
   push('usage',time,JSON.parse(telemetryV11LegacyProjection('usage',record)!.canonicalRecord));
   percent+=priced.costUsd*100/capacity;
  }
  quota(at(bin*2+1));
 }
 for(const [key,records] of groups){
  const digest=await sha256Hex(`synthetic:${key}`),principal=await authenticateDevice(source(),owner.authorization);
  const auth=await createDeviceUploadAuthorization(source(),principal,digest,200);
  const claim=await claimDeviceUploadAuthorization(source(),`Upload ${auth.uploadAuthorization}`,{envelopeDigest:digest,bodyBytes:200,contentType:'application/json'});
  const chunk=parseTelemetryV1Chunk({schemaVersion:'telemetry-contribution-v1.0',chunkId:`${key}:0`,chunkRevision:1,
   chunkDigest:await sha256Hex(canonicalJson(records)),parserVersion:'synthetic-history',consent:{telemetrySchemaVersion:'telemetry-contribution-v1.0',
    fieldDictionaryVersion:'telemetry-v1.0-registry-2026-08-07.1',privacyContractVersion:'ongoing-privacy-safe-telemetry-v1.0'},records});
  await insertTypedTelemetryV1Chunk(source(),{chunkRowId:`chunk:${crypto.randomUUID()}`,participantId:owner.participantId,deviceId:owner.deviceId,
   chunk,envelopeDigest:digest,r2Key:`synthetic/${key}`,deviceUploadAuthorizationId:claim.authorizationId,createdAt:new Date().toISOString(),supersedes:null},namespace);
 }
 for(let n=0;n<30;n++)if((await advanceStorageAnalytics(bindings())).state==='idle')break;
 return (await readStorageCommunityOwnerPage(source()))[0]!;
}

it('restarts a lost direct attempt through durable bounded checkpoints and matches the completed typed historical fit',async()=>{
 const owner=await fixture(),scope=await captureStorageGraphScope(source(),{owner,day,metric:'model',sourceId,sourceNamespace:namespace});
 const direct=await computeStorageGraphResult(bindings(),scope);
 expect(direct.state).toBe('complete');if(direct.state!=='complete')throw new Error('direct missing');
 expect(direct.result.composition?.status).toBe('ready');
 // Simulate a lost process after direct intent committed but before final result.
 await target().prepare('DELETE FROM analytics_community_graph_results').run();
 let deferred=0,completed=false;
 for(let i=0;i<24;i++){
  const meter=createD1InvocationBudget(900);
  const result=await computeStorageGraphResult({...bindings(),source:meter.wrap(source()),target:meter.wrap(target())},scope);
  expect(meter.queriesUsed).toBeLessThanOrEqual(900);
  if(result.state==='deferred'){deferred++;continue;}
  expect(result.result.composition).toEqual(direct.result.composition);completed=true;break;
 }
 expect(deferred).toBeGreaterThan(0);expect(completed).toBe(true);
 expect(await source().prepare('SELECT count(*) n FROM community_prepared_usage_rows').first('n')).toBe(0);
 expect(await source().prepare('SELECT count(*) n FROM telemetry_v1_records').first('n')).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_heads').first<number>('n')).toBeGreaterThan(0);
},60000);
