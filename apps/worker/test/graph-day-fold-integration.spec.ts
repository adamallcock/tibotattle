import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,describe,expect,it} from 'vitest';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {initializeStorageSource,readIngestionChanges} from '../src/analytics-delivery';
import {initializeStorageAnalyticsRuntime,advanceStorageAnalytics} from '../src/storage-analytics-runtime';
import {initializeTypedV11Admission,persistTypedV11StagedChunk} from '../src/typed-v11-admission';
import {initializeTypedV1Admission} from '../src/typed-v1-admission';
import {registerTelemetryV11DayManifest} from '../src/telemetry-v11-repository';
import {activateTelemetryV11Domain,createTelemetryV11DomainPredecessor,loadV11SourcePin} from '../src/telemetry-v11-domain';
import {loadTypedV11GenerationSnapshot} from '../src/typed-v11-quota-reader';
import {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization} from '../src/device-auth';
import {telemetryV11DomainManifestDigestInput,type TelemetryV11DomainManifest} from '@app-usagemonitor/telemetry-contract';
import {createV11DeviceFixture,makeV11Day,v11UsageRecord} from './helpers/telemetry-v11';
import {advanceStorageV11Analysis,loadStorageV11PreparedDays,storageV11FoldsPreparedDays,
 STORAGE_V11_PREPARED_FOLD,STORAGE_V11_PREPARED_LOAD_RESERVE} from '../src/storage-v11-history';
import {advanceGraphDayProjectionLane,createGraphDayProjectionSourceBuild} from '../src/graph-day-projection';
import type {GraphDayProjection} from '../src/graph-day-projection-values';

/**
 * The two gates for switching the prepared fold on.
 *
 * Everything else about the fold is proven against fixtures. These are the two
 * claims that can only be made against the real pipeline: that a window the
 * store does not fully hold takes the PAGED path rather than folding a partial
 * set, and that a window it does hold folds to the same bytes the paged path
 * produces from the same source rows.
 */
const b=env as Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_ANALYTICS_MIGRATIONS:D1Migration[];
 TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];
 TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[]};
const source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
const sourceId='synthetic-fold',sourceNamespace='synthetic-fold-original';
const bindings=()=>({source:source(),target:target(),sourceId,sourceNamespace});
const DEPENDENCY='d'.repeat(64);
let occurrence=0;

const ATTRIBUTION={accountBasis:'same_source' as const,accountTrackId:'account-track:v2:'+'a'.repeat(64),
 planBasis:'same_source_occurrence' as const,planType:'pro' as const,planEraId:null};
/** One day's rows, in the shape the model metric admits: one account, one plan,
 * one era, and a pool with enough distinct displayed values and span for the
 * calibration to seed a supported quota track. */
function dayRecords(day:string){
 const start=Date.parse(`${day}T01:00:00.000Z`);
 const quota=Array.from({length:9},(_,i)=>({schemaVersion:'quota-observation-v1.1' as const,
  observationId:`quota-occurrence:v1:${(occurrence+=1).toString(16).padStart(64,'0')}`,
  observedTime:new Date(start+i*300000).toISOString(),provider:'openai_codex',
  planType:'pro' as const,planVariant:'unknown',limitId:'codex',slot:'seven_day' as const,
  usedPercent:10+i*5,windowDurationMinutes:10080,
  resetsAt:new Date(start+7*86400000).toISOString(),accountPlanAttribution:{...ATTRIBUTION}}));
 const usage=Array.from({length:8},(_,i)=>v11UsageRecord(day,'a',
  {eventId:`event:v2:${(occurrence+=1).toString(16).padStart(64,'0')}`,
   eventTime:new Date(start+i*300000+150000).toISOString(),accountPlanAttribution:{...ATTRIBUTION}}));
 return {quota,usage};
}

beforeEach(async()=>{await reset();occurrence=0;});

/** A synthetic v1.1 owner with real source rows, delivered to analytics. */
async function fixture(days:number){
 for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,
  b.TEST_TYPED_V11_ADMISSION_MIGRATIONS,b.TEST_TYPED_V1_ADMISSION_MIGRATIONS])await applyD1Migrations(source(),migrations);
 await applyD1Migrations(target(),b.TEST_ANALYTICS_MIGRATIONS);
 await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
 await initializeStorageSource(source(),sourceId);
 await initializeTypedV11Admission(source(),sourceNamespace);
 await initializeTypedV1Admission(source(),sourceNamespace);
 await applyD1Migrations(source(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
 await initializeStorageAnalyticsRuntime(bindings());
 const device=await createV11DeviceFixture(source(),{grant:true});
 const today=new Date().toISOString().slice(0,10);
 const entries:TelemetryV11DomainManifest['days']=[];
 for(let n=days-1;n>=0;n--){
  const day=new Date(Date.parse(today)-n*86400000).toISOString().slice(0,10);
  const prepared=await makeV11Day(day,dayRecords(day));
  const staged=await registerTelemetryV11DayManifest(source(),device,prepared.manifest);
  for(const chunk of prepared.chunks){
   const envelopeDigest=await sha256Hex(`synthetic:${crypto.randomUUID()}`);
   const upload=await createDeviceUploadAuthorization(source(),await authenticateDevice(source(),device.authorization),envelopeDigest,200);
   const claim=await claimDeviceUploadAuthorization(source(),`Upload ${upload.uploadAuthorization}`,
    {envelopeDigest,bodyBytes:200,contentType:'application/json'});
   await persistTypedV11StagedChunk(source(),device,chunk,{sourceNamespace,chunkRowId:`chunk:${crypto.randomUUID()}`,
    r2Key:`synthetic/${crypto.randomUUID()}`,envelopeDigest,deviceUploadAuthorizationId:claim.authorizationId});
  }
  entries.push({day,manifestId:staged.manifestId,manifestDigest:staged.manifestDigest});
 }
 const prior=await createTelemetryV11DomainPredecessor(source(),device);
 const manifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',fromDay:entries[0]!.day,
  throughDay:today,predecessor:{token:prior.token,previousGenerationId:prior.previousGenerationId,
   legacyFingerprint:prior.legacyFingerprint},days:entries,manifestDigest:'0'.repeat(64)};
 manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
 await activateTelemetryV11Domain(source(),device,manifest);
 for(let i=0;i<60;i++)if((await advanceStorageAnalytics(bindings())).state==='idle')break;
 const pin=(await loadV11SourcePin(source(),device.participantId))!;
 const snapshot=await loadTypedV11GenerationSnapshot(source(),{sourceNamespace,pin});
 const ownerDigest=(await readIngestionChanges(source(),sourceId,0)).at(-1)!.ownerDigest;
 return {device,pin,snapshot,ownerDigest,today,days:entries.map(entry=>entry.day)};
}

type Fixture=Awaited<ReturnType<typeof fixture>>;
const loaderInput=(f:Fixture,overrides:Record<string,unknown>={})=>({source:source(),target:target(),
 sourceId,sourceNamespace,ownerDigest:f.ownerDigest,snapshot:f.snapshot,sourcePin:f.pin,
 nowMs:Date.parse(`${f.today}T23:00:00.000Z`),
 budget:{remainingQueries:900,deadlineMs:Date.now()+120_000},enabled:true,...overrides});

/** Build every prepared day this owner has, through the production builder. */
async function buildPreparedDays(f:Fixture):Promise<number>{
 const build=createGraphDayProjectionSourceBuild({source:source(),sourceNamespace});
 let built=0;
 for(let pass=0;pass<20;pass++){
  const lane=await advanceGraphDayProjectionLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+120_000,remainingQueries:900,sourceQueries:900,maxDays:8});
  built+=lane.built;
  if(lane.state==='idle')break;
 }
 expect(built).toBeGreaterThanOrEqual(f.days.length);
 return built;
}

/** Drive one owner-day to a completed analysis. With `preparedDays` supplied
 * and `preparedFold` on this is the FOLDED path; with neither it is the paged
 * one, and every other input is identical. */
async function analysis(f:Fixture,day:string,
 prepared?:readonly GraphDayProjection[]):Promise<object>{
 let checkpoint=null as Awaited<ReturnType<typeof advanceStorageV11Analysis>> extends never?never:
  Parameters<typeof advanceStorageV11Analysis>[0]['checkpoint'];
 for(let step=0;step<400;step++){
  const result=await advanceStorageV11Analysis({source:source(),sourceNamespace,
   participantId:f.pin.participantId,day,metric:'model',nowMs:Date.parse(`${f.today}T23:00:00.000Z`),
   sourcePin:f.pin,generationSnapshot:f.snapshot,closedDependencyDigest:DEPENDENCY,
   budget:{remainingQueries:100_000,deadlineMs:Date.now()+120_000},checkpoint,maxPages:64,
   ...(prepared===undefined?{}:{preparedDays:prepared,preparedFold:true})});
  if(result.status==='complete')return result.analysis;
  checkpoint=result.checkpoint;
  if(checkpoint===null)throw new Error('paged analysis cut without progress');
 }
 throw new Error('paged analysis did not complete');
}

describe('prepared-day load is the safety gate',()=>{
 it('is skipped entirely while the switch is off',async()=>{
  const f=await fixture(3);
  await buildPreparedDays(f);
  const off=await loadStorageV11PreparedDays({...loaderInput(f),enabled:false});
  expect(off).toEqual({status:'off',days:undefined,statements:0});
  // And the shipped default is off, so a deploy changes nothing on its own.
  expect(STORAGE_V11_PREPARED_FOLD).toBe(false);
  expect(storageV11FoldsPreparedDays([],STORAGE_V11_PREPARED_FOLD)).toBe(false);
 });
 it('refuses a window the store does not fully hold, wherever the hole is',async()=>{
  const f=await fixture(4);
  await buildPreparedDays(f);
  const ready=await loadStorageV11PreparedDays(loaderInput(f));
  expect(ready.status).toBe('ready');
  if(ready.status!=='ready')throw new Error('unreachable');
  expect(ready.days.map(day=>day.day)).toEqual(f.days);
  const complete=canonicalJson(ready.days);
  // A hole at the start, in the middle and at the end: each exercises a
  // different comparison in the manifest-to-store walk.
  for(const hole of [f.days[0]!,f.days[Math.floor(f.days.length/2)]!,f.days.at(-1)!]){
   const saved=(await target().prepare(`SELECT * FROM analytics_graph_day_values WHERE day=?`)
    .bind(hole).all<Record<string,unknown>>()).results;
   const pages=(await target().prepare(`SELECT * FROM analytics_graph_day_pages WHERE day=?`)
    .bind(hole).all<Record<string,unknown>>()).results;
   expect(saved).toHaveLength(1);
   await target().prepare('DELETE FROM analytics_graph_day_values WHERE day=?').bind(hole).run();
   const missing=await loadStorageV11PreparedDays(loaderInput(f));
   expect(missing.status,`hole at ${hole}`).toBe('incomplete');
   // The safety property: nothing partial is handed back for folding.
   expect(missing.days,`hole at ${hole}`).toBeUndefined();
   // Restore and prove the same window loads again, byte for byte.
   await target().prepare(`INSERT INTO analytics_graph_day_values
    (value_key,source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,
     day,acquisition_version,record_count,part_count,values_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(saved[0]!.value_key,saved[0]!.source_id,saved[0]!.source_layout,saved[0]!.source_namespace,
     saved[0]!.owner_digest,saved[0]!.device_id,saved[0]!.manifest_id,saved[0]!.manifest_digest,
     saved[0]!.day,saved[0]!.acquisition_version,saved[0]!.record_count,saved[0]!.part_count,
     saved[0]!.values_digest).run();
   expect(pages.length).toBeGreaterThan(0);
   const restored=await loadStorageV11PreparedDays(loaderInput(f));
   expect(restored.status,`restored ${hole}`).toBe('ready');
   if(restored.status!=='ready')throw new Error('unreachable');
   expect(canonicalJson(restored.days)).toBe(complete);
  }
 });
 it('an incomplete window still publishes a normal paged result, never not_testable',async()=>{
  const f=await fixture(3);
  await buildPreparedDays(f);
  await target().prepare('DELETE FROM analytics_graph_day_values WHERE day=?').bind(f.days[1]!).run();
  const load=await loadStorageV11PreparedDays(loaderInput(f));
  expect(load.status).toBe('incomplete');
  // This is what the caller does with `incomplete`: supply nothing, so the
  // paged acquisition serves the group exactly as before.
  const paged=await analysis(f,f.today) as {status?:string};
  expect(paged.status).not.toBe('not_testable');
  expect(paged.status).toBe('ready');
 });
 it('defers rather than half-reading when the budget or the deadline runs out',async()=>{
  const f=await fixture(3);
  await buildPreparedDays(f);
  const budget=await loadStorageV11PreparedDays({...loaderInput(f),
   budget:{remainingQueries:STORAGE_V11_PREPARED_LOAD_RESERVE-1,deadlineMs:Date.now()+120_000}});
  expect(budget).toMatchObject({status:'budget',days:undefined});
  const deadline=await loadStorageV11PreparedDays({...loaderInput(f),
   budget:{remainingQueries:900,deadlineMs:Date.now()-1}});
  expect(deadline).toMatchObject({status:'budget',days:undefined});
  // A budget that admits the reserve but not the whole walk stops mid-window
  // with nothing to fold, rather than returning the days it managed to read.
  const cut=await loadStorageV11PreparedDays({...loaderInput(f),
   budget:{remainingQueries:STORAGE_V11_PREPARED_LOAD_RESERVE+2,deadlineMs:Date.now()+120_000}});
  expect(cut).toMatchObject({status:'budget',days:undefined});
  expect(cut.statements).toBeGreaterThan(0);
 });
 it('costs one statement per window day plus the manifest read',async()=>{
  const f=await fixture(5);
  await buildPreparedDays(f);
  const load=await loadStorageV11PreparedDays(loaderInput(f));
  expect(load.status).toBe('ready');
  // The measured cost of a whole window, against the 254 usage pages plus 300
  // quota pages a paged model-day spends for the dense owner.
  expect(load.statements).toBe(1+f.days.length);
  console.log(JSON.stringify({windowDays:f.days.length,loadStatements:load.statements}));
 });
});

describe('prepared days equal the paged path over real source rows',()=>{
 it('loads exactly the days the builder prepared from the same generation',async()=>{
  const f=await fixture(4);
  await buildPreparedDays(f);
  const load=await loadStorageV11PreparedDays(loaderInput(f));
  expect(load.status).toBe('ready');
  if(load.status!=='ready')throw new Error('unreachable');
  // Every day the analysis window expects, in ascending order, each one the
  // artifact the production builder wrote from this generation's own rows.
  expect(load.days.map(day=>day.day)).toEqual(f.days);
  expect(load.days.every(day=>day.runEndpoints.endpoints.length>0)).toBe(true);
  expect(load.days.every(day=>day.usage.rowsRead>0)).toBe(true);
  expect(storageV11FoldsPreparedDays(load.days,true)).toBe(true);
  expect(storageV11FoldsPreparedDays(load.days)).toBe(false);
 });
 it('folds to the same composition the paged path publishes, byte for byte',async()=>{
  const f=await fixture(4);
  await buildPreparedDays(f);
  const load=await loadStorageV11PreparedDays(loaderInput(f));
  expect(load.status).toBe('ready');
  if(load.status!=='ready')throw new Error('unreachable');
  // Same owner, same day, same generation snapshot, same identity: the only
  // difference is whether the window is folded from the store or paged from
  // the source. This is the claim the whole change rests on.
  const paged=await analysis(f,f.today) as {status?:string};
  const folded=await analysis(f,f.today,load.days) as {status?:string};
  expect(paged.status).toBe('ready');
  expect(folded.status).toBe('ready');
  expect(canonicalJson(folded)).toBe(canonicalJson(paged));
  // The guard that the equality above is not free: the same call with one day
  // withheld reaches the fold's own coverage assertion, which only the folded
  // branch can raise. So the matching result was genuinely folded from the
  // store rather than quietly paged from the source.
  await expect(analysis(f,f.today,load.days.slice(1)))
   .rejects.toThrow('v11 quota prepared day set incomplete');
 });
});
