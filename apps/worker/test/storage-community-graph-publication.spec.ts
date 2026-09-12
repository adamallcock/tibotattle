import { publishStorageCommunityModelDay, publishStorageCommunityGraphPreview, readPublishedStorageCommunityGraph,
  readPublishedStorageCommunityAdminPreview, retireStorageCommunityGraphPublications } from '../src/storage-community-graph-publication';
import { advanceStorageCommunityDaily } from '../src/storage-community-daily';
import { handleRequest } from '../src/index';
import { captureStorageCommunityAuthority } from '../src/storage-community-authority';
import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest,
  type TelemetryV11QuotaObservation } from "@app-usagemonitor/telemetry-contract";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { initializeStorageSource, readIngestionChanges } from "../src/analytics-delivery";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { registerTelemetryV11DayManifest } from "../src/telemetry-v11-repository";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { sha256Hex } from "../src/crypto";
import { createD1InvocationBudget } from "../src/d1-invocation-budget";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeStorageAnalyticsRuntime, advanceStorageAnalytics } from "../src/storage-analytics-runtime";
import { captureStorageGraphScope, computeStorageGraphResult } from "../src/storage-community-graph";
import { readStorageCommunityOwnerPage } from "../src/storage-community-authority";
import { drainCommunityPublicSourceBootstrap } from "../src/community-daily-aggregates";
import { createV11DeviceFixture, makeV11Day, stageV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { MODEL_HISTORY_TEST_CAPACITIES, pricedModelHistoryUsage } from './helpers/model-history';
import { eraseParticipantAsOwner } from '../src/participant-erasure';
import { canonicalJson } from '../src/canonical-json';
import { readStorageCommunityProgress } from '../src/storage-community-progress';
import { advanceStorageCommunityGraphWork } from '../src/storage-community-graph-work';

const b=env as Env & { STORAGE_INGESTION_A:D1Database; TEST_MIGRATIONS:D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[]; TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];TEST_ANALYTICS_MIGRATIONS:D1Migration[];
  STORAGE_ANALYTICS_DB:D1Database; TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[] };
const typed=()=>b.STORAGE_INGESTION_A, legacy=()=>b.USAGE_MONITOR_DB;
const namespace="synthetic-analysis-source", participantId="participant:synthetic-analysis";
const today=()=>new Date().toISOString().slice(0,10);
const day=()=>new Date(Date.now()-86400000).toISOString().slice(0,10);
type Fixture=Awaited<ReturnType<typeof createV11DeviceFixture>>;
type Prepared=Awaited<ReturnType<typeof makeV11Day>>;
beforeEach(async()=>{
  await reset();
  await applyD1Migrations(legacy(),b.TEST_MIGRATIONS);
  await applyD1Migrations(typed(),b.TEST_MIGRATIONS);
  await applyD1Migrations(typed(),b.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(typed(),b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(typed(),b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await initializeStorageSource(typed(),namespace);
  await initializeTypedV11Admission(typed(),namespace);
  await applyD1Migrations(typed(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await initializeTypedV1Admission(typed(),namespace);
  await applyD1Migrations(typed(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
  await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS);
  await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
  await drainCommunityPublicSourceBootstrap(typed());
  await initializeStorageAnalyticsRuntime(bindings());
});
async function stage(db:D1Database,f:Fixture,prepared:Prepared,isTyped:boolean){
  if(!isTyped)return stageV11Day(db,f,prepared);
  await registerTelemetryV11DayManifest(db,f,prepared.manifest);
  for(const chunk of prepared.chunks){
    const digest=await sha256Hex(`synthetic:${crypto.randomUUID()}`);
    const device=await authenticateDevice(db,f.authorization);
    const grant=await createDeviceUploadAuthorization(db,device,digest,200);
    const claim=await claimDeviceUploadAuthorization(db,`Upload ${grant.uploadAuthorization}`,
      {envelopeDigest:digest,bodyBytes:200,contentType:"application/json"});
    await persistTypedV11StagedChunk(db,f,chunk,{sourceNamespace:namespace,
      chunkRowId:`chunk:${crypto.randomUUID()}`,r2Key:`synthetic/${crypto.randomUUID()}`,
      envelopeDigest:digest,deviceUploadAuthorizationId:claim.authorizationId});
  }
  return registerTelemetryV11DayManifest(db,f,prepared.manifest);
}
async function activate(db:D1Database,f:Fixture,prepared:Prepared,isTyped:boolean){
  const candidate=await stage(db,f,prepared,isTyped);
  const currentDay=await stage(db,f,await makeV11Day(today(),{}),isTyped);
  const prior=await createTelemetryV11DomainPredecessor(db,f);
  const manifest:TelemetryV11DomainManifest={schemaVersion:"telemetry-domain-manifest-v1.1",
    fromDay:day(),throughDay:today(),predecessor:{token:prior.token,previousGenerationId:prior.previousGenerationId,
      legacyFingerprint:prior.legacyFingerprint},days:[{day:day(),manifestId:candidate.manifestId,
      manifestDigest:candidate.manifestDigest},{day:today(),manifestId:currentDay.manifestId,manifestDigest:currentDay.manifestDigest}],manifestDigest:"0".repeat(64)};
  manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  return activateTelemetryV11Domain(db,f,manifest);
}
function evidence(){
  const start=Date.parse(day()+"T01:00:00.000Z");
  const attribution={accountBasis:"same_source" as const,accountTrackId:"account-track:v2:"+"a".repeat(64),
    planBasis:"same_source_occurrence" as const,planType:"pro" as const,planEraId:null};
  const quota:TelemetryV11QuotaObservation[]=Array.from({length:9},(_,i)=>({schemaVersion:"quota-observation-v1.1",
    observationId:`quota:synthetic:${i}`,observedTime:new Date(start+i*300000).toISOString(),provider:"openai_codex",
    planType:"pro",planVariant:"unknown",limitId:"codex",slot:"seven_day",usedPercent:10+i*5,
    windowDurationMinutes:10080,resetsAt:new Date(start+7*86400000).toISOString(),accountPlanAttribution:{...attribution}}));
  const usage=Array.from({length:8},(_,i)=>v11UsageRecord(day(),"a",{eventId:`event:synthetic:${i}`,
    eventTime:new Date(start+i*300000+150000).toISOString(),accountPlanAttribution:{...attribution}}));
  return {quota,usage};
}


const bindings=()=>({source:typed(),target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,sourceNamespace:namespace});
async function fixture(id=participantId){
 const f=await createV11DeviceFixture(typed(),{participantId:id,grant:true});
 await activate(typed(),f,await makeV11Day(day(),evidence()),true);
 for(let n=0;n<32;n++){if((await advanceStorageAnalytics(bindings())).state==='idle')break;}
 await advanceStorageCommunityDaily({...bindings(),day:day()});return f;
}
async function modelFixture(){
 const f=await createV11DeviceFixture(typed(),{participantId,grant:true});
 const start=Date.parse(day())-4*86400000,groups=new Map<string,ReturnType<typeof evidence>>();
 const attribution=evidence().quota[0]!.accountPlanAttribution;
 const time=(hour:number)=>new Date(start+hour*3600000).toISOString();let usedPercent=0;
 const group=(at:string)=>{const date=at.slice(0,10),rows=groups.get(date)??{quota:[],usage:[]};groups.set(date,rows);return rows;};
 const addQuota=(hour:number,index:number)=>group(time(hour)).quota.push({...evidence().quota[0]!,
  observationId:`quota:model:${index}`,observedTime:time(hour),usedPercent,
  resetsAt:new Date(start+7*86400000).toISOString(),accountPlanAttribution:{...attribution}});
 addQuota(0,0);
 // Sixty independent two-hour bins span five real source days. Both models
 // have the same known coefficients in both interleaved fit halves.
 for(let bin=0;bin<60;bin++){
  for(const [index,[model,capacity]] of Object.entries(MODEL_HISTORY_TEST_CAPACITIES).entries()){
   const cost=(5+((bin*7+index*11)%17)/4)*((bin+index)%3===0?0.2:1);
   const priced=pricedModelHistoryUsage(model,cost,time(bin*2+.5));
   group(priced.record.observedAt).usage.push(v11UsageRecord(priced.record.observedAt.slice(0,10),'a',{
    ...JSON.parse(priced.record.recordJson),eventId:`event:model:${bin}:${index}`,eventTime:priced.record.observedAt,
    accountPlanAttribution:{...attribution}}));
   usedPercent+=priced.costUsd*100/capacity;
  }
  addQuota(bin*2+1,bin+1);
 }
 expect(usedPercent).toBeLessThan(100);
 const days=[];
 for(const [date,rows] of groups)days.push(await stage(typed(),f,await makeV11Day(date,rows),true));
 days.push(await stage(typed(),f,await makeV11Day(today(),{}),true));
 await activateDays(f,days);
 for(let n=0;n<40;n++){if((await advanceStorageAnalytics(bindings())).state==='idle')break;}
 await advanceStorageCommunityDaily({...bindings(),day:day()});return f;
}
async function activateDays(f:Fixture,days:Array<{day:string;manifestId:string;manifestDigest:string}>){
 const prior=await createTelemetryV11DomainPredecessor(typed(),f),ordered=[...days].sort((a,b)=>a.day.localeCompare(b.day));
 const manifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',
  fromDay:ordered[0]!.day,throughDay:ordered.at(-1)!.day,predecessor:{token:prior.token,
   previousGenerationId:prior.previousGenerationId,legacyFingerprint:prior.legacyFingerprint},
  days:ordered.map(({day,manifestId,manifestDigest})=>({day,manifestId,manifestDigest})),manifestDigest:'0'.repeat(64)};
 manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
 return activateTelemetryV11Domain(typed(),f,manifest);
}
async function activeDays(f:Fixture){
 return (await typed().prepare(`SELECT d.observed_day AS day,m.id AS manifestId,m.manifest_digest AS manifestDigest
  FROM telemetry_v11_domain_heads h JOIN telemetry_v11_domain_days d ON d.generation_id=h.generation_id
  JOIN telemetry_v11_day_manifests m ON m.id=d.manifest_id WHERE h.participant_id=? ORDER BY d.observed_day`)
  .bind(f.participantId).all<{day:string;manifestId:string;manifestDigest:string}>()).results;
}
async function appendToday(f:Fixture,count:number){
 const previous=await activeDays(f),current=await stage(typed(),f,await makeV11Day(today(),{
  usage:Array.from({length:count},(_,i)=>v11UsageRecord(today(),'b',{eventId:`event:today:${i}`}))}),true);
 await activateDays(f,[...previous.filter(row=>row.day!==today()),current]);
}
function observed(db:D1Database,hook:(sql:string,moment:'before'|'after')=>Promise<void>){
 const originals=new WeakMap<D1PreparedStatement,D1PreparedStatement>(),texts=new WeakMap<D1PreparedStatement,string>();
 const wrap=(s:D1PreparedStatement,sql:string):D1PreparedStatement=>{
  const result=new Proxy(s,{get(target,key){
   if(key==='bind')return(...args:unknown[])=>wrap(target.bind(...args),sql);
   if(['first','all','run','raw'].includes(String(key)))return async(...args:unknown[])=>{
    await hook(sql,'before');const value=await Reflect.apply(Reflect.get(target,key),target,args);await hook(sql,'after');return value;
   };
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});originals.set(result,s);texts.set(result,sql);return result;
 };
 return new Proxy(db,{get(target,key){
  if(key==='prepare')return(sql:string)=>wrap(target.prepare(sql),sql);
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   for(const s of statements)await hook(texts.get(s)!,'before');
   const result=await target.batch(statements.map(s=>originals.get(s)!));
   for(const s of statements)await hook(texts.get(s)!,'after');return result;
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}
function cohortMetadataSource(rows:Array<Record<string,unknown>>):D1Database {
 return new Proxy(typed(),{get(db,key){
  if(key==='prepare')return(sql:string)=>{
   const statement=db.prepare(sql);if(!sql.includes('p.id AS participantId'))return statement;
   return new Proxy(statement,{get(s,property){
    if(property==='bind')return(after:string,limit:number)=>{
     const bound=s.bind(after,limit);return new Proxy(bound,{get(original,member){
      if(member==='all')return async()=>{
       const actual=await original.all();
       return {...actual,results:rows.filter(row=>String(row.participantId)>after).slice(0,limit)};
      };
      const value=Reflect.get(original,member);return typeof value==='function'?value.bind(original):value;
     }});
    };
    const value=Reflect.get(s,property);return typeof value==='function'?value.bind(s):value;
   }});
  };
  const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;
 }});
}
function replayPublication(table:'analytics_community_model_publications'|'analytics_community_graph_previews',row:Record<string,unknown>){
 return b.STORAGE_ANALYTICS_DB.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')})
  VALUES(${Object.keys(row).map(()=>'?').join(',')})`).bind(...Object.values(row)).run();
}
function capturedQueries(){
 const queries:Array<{sql:string;args:unknown[]}>=[];
 const database=new Proxy(b.STORAGE_ANALYTICS_DB,{get(db,key){
  if(key==='prepare')return(sql:string)=>new Proxy(db.prepare(sql),{get(s,property){
   if(property==='bind')return(...args:unknown[])=>{queries.push({sql,args});return s.bind(...args);};
   const value=Reflect.get(s,property);return typeof value==='function'?value.bind(s):value;
  }});
  const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;
 }});
 return {database,queries};
}
async function compute(metric:'fits'|'model',date=metric==='fits'?today():day(),ownerIndex=0){
 const owner=(await readStorageCommunityOwnerPage(typed()))[ownerIndex]!;
 const scope=await captureStorageGraphScope(typed(),{owner,day:date,metric,sourceId:namespace,sourceNamespace:namespace});
 return computeStorageGraphResult(bindings(),scope);
}
async function api(){
 const configured={...b,USAGE_MONITOR_DB:typed(),ENVIRONMENT:'synthetic-development',ACCOUNT_SCOPED_INGEST_MODE:'disabled'} as Env;
 Reflect.set(configured,'TELEMETRY_STORAGE_MODE','typed');Reflect.set(configured,'TELEMETRY_STORAGE_NAMESPACE',namespace);
 Reflect.set(configured,'ANALYTICS_DB',b.STORAGE_ANALYTICS_DB);
 return handleRequest(new Request(`https://synthetic.example.test/api/v1/community/daily?from=${day()}&to=${day()}`),configured);
}
describe('isolated allowance graph publication',()=>{
 it('publishes actual fitted allowance through the real daily route while missing historical models remain gaps',async()=>{
  const f=await fixture();
  expect(await publishStorageCommunityGraphPreview(bindings())).toMatchObject({state:'deferred',reason:'cache_pending'});
  expect((await compute('fits')).state).toBe('complete');
  expect(await publishStorageCommunityGraphPreview(bindings())).toMatchObject({state:'published',memberCount:1});
  const response=await api();expect(response.status).toBe(200);const text=await response.text(),body=JSON.parse(text);
  expect(body.allowanceState).toBe('ready');expect(body.allowanceReadState).toBe('confirmed');
  const point=body.allowanceBreakdowns.days.find((x:{day:string})=>x.day===day());
  expect(point.combined.centralUsd).toBeGreaterThan(0);expect(point.models).toEqual([]);
  expect(point.combined.participantCount).toBe(1);
  for(const value of [f.participantId,f.deviceId,namespace,'account-track:v2:'+'a'.repeat(64),
   (await readStorageCommunityOwnerPage(typed()))[0]!.ownerDigest!])expect(text).not.toContain(value);
  expect(await typed().prepare('SELECT count(*) n FROM community_allowance_fit_cache').first('n')).toBe(0);
  expect(await typed().prepare('SELECT count(*) n FROM community_model_composition_days').first('n')).toBe(0);
 });
 it('publishes a separate exact historical model day and refreshes the preview when it arrives',async()=>{
  await modelFixture();await compute('fits');await publishStorageCommunityGraphPreview(bindings());
  expect(await publishStorageCommunityModelDay(bindings(),{day:day()})).toMatchObject({state:'deferred'});
  const result=await compute('model');expect(result).toMatchObject({state:'complete',result:{composition:{status:'ready',fit:{status:'fitted'}}}});
  expect(await publishStorageCommunityModelDay(bindings(),{day:day()})).toMatchObject({state:'published',memberCount:1});
  expect(await publishStorageCommunityGraphPreview(bindings())).toMatchObject({state:'published'});
  const body=await (await api()).json() as {allowanceBreakdowns:{days:Array<{day:string;models:unknown[]}>}};
  expect(body.allowanceBreakdowns.days).toHaveLength(1);
  const stored=JSON.parse((await b.STORAGE_ANALYTICS_DB.prepare('SELECT payload_json FROM analytics_community_model_publications').first<string>('payload_json'))!);
  expect(body.allowanceBreakdowns.days[0]!.models).toEqual(stored.values);
  expect(stored.values.length).toBeGreaterThan(0);
  expect(await readPublishedStorageCommunityAdminPreview(bindings())).toMatchObject({models:{days:[{day:day(),values:stored.values}]}});
  expect(stored.day).toBe(day());expect(await publishStorageCommunityModelDay(bindings(),{day:day()})).toMatchObject({state:'unchanged'});
 });
 it('measures both full 16-owner publications with the actual shared statement meter',async()=>{
  for(let i=0;i<16;i++)await fixture(`participant:budget-${i.toString().padStart(2,'0')}`);
  for(let i=0;i<16;i++){await compute('fits',today(),i);await compute('model',day(),i);}
  const modelMeter=createD1InvocationBudget(900),previewMeter=createD1InvocationBudget(900);
  expect(await publishStorageCommunityModelDay({...bindings(),source:modelMeter.wrap(typed()),target:modelMeter.wrap(b.STORAGE_ANALYTICS_DB)},
   {day:day()})).toMatchObject({state:'published',memberCount:16});
  expect(await publishStorageCommunityGraphPreview({...bindings(),source:previewMeter.wrap(typed()),target:previewMeter.wrap(b.STORAGE_ANALYTICS_DB)}))
   .toMatchObject({state:'published',memberCount:16});
  expect({owners:16,modelQueries:modelMeter.queriesUsed,previewQueries:previewMeter.queriesUsed}).toMatchInlineSnapshot(`
    {
      "modelQueries": 11,
      "owners": 16,
      "previewQueries": 13,
    }
  `);
  expect(modelMeter.queriesUsed).toBeLessThanOrEqual(250);expect(previewMeter.queriesUsed).toBeLessThanOrEqual(250);
 });
 it('bounds publication statements across one thousand controlled owner metadata and cache fixtures',async()=>{
  // The preceding test qualifies actual uploaded owners and kernel results.
  // This scale case replays only the validated metadata boundary, executing
  // every source metadata SQL call and all real indexed target cache queries.
  // It is not a claim that one thousand upload/credential journeys were run.
  await fixture();await compute('fits');
  const template=(await b.STORAGE_ANALYTICS_DB.prepare("SELECT * FROM analytics_community_graph_results WHERE metric='fits'").first<Record<string,unknown>>())!;
  const base=(await readStorageCommunityOwnerPage(typed()))[0]!,rows:Array<Record<string,unknown>>=[];
  let statements:D1PreparedStatement[]=[];
  for(let i=0;i<1000;i++){
   const participantId=`participant:controlled-scale-${String(i).padStart(4,'0')}`,ownerDigest=await sha256Hex(participantId);
   rows.push({...base,participantId,ownerDigest,hasV1:0,hasV11:1,hasLegacy:0});
   const payload=canonicalJson((JSON.parse(String(template.payload_json)) as Array<Record<string,unknown>>)
    .map(fit=>({...fit,participantId:ownerDigest})));
   const row={...template,owner_digest:ownerDigest,payload_json:payload,payload_sha256:await sha256Hex(payload)};
   statements.push(b.STORAGE_ANALYTICS_DB.prepare(`INSERT INTO analytics_community_graph_results
    (${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).bind(...Object.values(row)));
   if(statements.length===100){await b.STORAGE_ANALYTICS_DB.batch(statements);statements=[];}
  }
  const meter=createD1InvocationBudget(900),source=cohortMetadataSource(rows),target=capturedQueries();
  expect(await publishStorageCommunityGraphPreview({...bindings(),source:meter.wrap(source),target:meter.wrap(target.database)}))
   .toMatchObject({state:'published',memberCount:1000});
  expect({owners:1000,previewQueries:meter.queriesUsed}).toMatchInlineSnapshot(`
    {
      "owners": 1000,
      "previewQueries": 74,
    }
  `);
  expect(meter.queriesUsed).toBeLessThanOrEqual(100);
  const reads=target.queries.filter(query=>query.sql.includes('WITH selected AS MATERIALIZED'));
  expect(reads).toHaveLength(32);expect(Math.max(...reads.map(query=>query.args.length))).toBeLessThanOrEqual(100);
  const plan=JSON.stringify((await b.STORAGE_ANALYTICS_DB.prepare('EXPLAIN QUERY PLAN '+reads[0]!.sql)
   .bind(...reads[0]!.args).all()).results);
  expect(plan).toMatch(/SEARCH analytics_community_graph_results USING (PRIMARY KEY|INDEX analytics_community_graph_day)/);
  expect(plan).not.toMatch(/SCAN analytics_community_graph_results/);
  expect((await readPublishedStorageCommunityAdminPreview({...bindings(),source}))!.coverage)
   .toMatchObject({uploadingParticipantCount:1000,cachedParticipantCount:1000});
 });
 it('reports an oversized metadata cohort as capacity and never publishes a prefix',async()=>{
  await fixture();const base=(await readStorageCommunityOwnerPage(typed()))[0]!;
  const rows=Array.from({length:20_000},(_,i)=>({...base,participantId:`participant:oversize-${String(i).padStart(5,'0')}`,
   ownerDigest:i.toString(16).padStart(64,'0'),hasV1:0,hasV11:1,hasLegacy:0}));
  const meter=createD1InvocationBudget(900);
  expect(await publishStorageCommunityGraphPreview({...bindings(),source:meter.wrap(cohortMetadataSource(rows)),
   target:meter.wrap(b.STORAGE_ANALYTICS_DB)})).toMatchObject({state:'deferred',reason:'capacity'});
  expect(meter.queriesUsed).toBeLessThan(250);
  expect(await b.STORAGE_ANALYTICS_DB.prepare('SELECT count(*) n FROM analytics_community_graph_previews').first('n')).toBe(0);
 });
 it('requires the complete uploading cohort and hides old publication after new authority appears',async()=>{
  await fixture();await compute('fits');await publishStorageCommunityGraphPreview(bindings());
  await fixture('participant:second-synthetic');
  expect(await readPublishedStorageCommunityGraph(bindings())).toBeNull();
  await compute('fits',today(),0);
  expect(await publishStorageCommunityGraphPreview(bindings())).toMatchObject({state:'deferred',reason:'cache_pending'});
  await compute('fits',today(),1);
  expect(await publishStorageCommunityGraphPreview(bindings())).toMatchObject({state:'published',memberCount:2});
  const row=(await readPublishedStorageCommunityGraph(bindings()))!;
  expect(JSON.parse(row.payload_json).coverage).toMatchObject({uploadingParticipantCount:2,cachedParticipantCount:2});
 });
 it('repairs corrupt completed days instead of permanently skipping them',async()=>{
  await fixture();await compute('model');await compute('fits');
  await publishStorageCommunityModelDay(bindings(),{day:day()});
  await publishStorageCommunityGraphPreview(bindings());
  const original=await b.STORAGE_ANALYTICS_DB.prepare('SELECT payload_json,payload_sha256 FROM analytics_community_model_publications').first();
  expect((await readStorageCommunityProgress(bindings(),Date.now())).history.resolvedDays).toBe(1);
  await advanceStorageCommunityGraphWork(bindings());
  for(const withSelfHash of [false,true]){
   const invalid='{}';
   await b.STORAGE_ANALYTICS_DB.prepare('UPDATE analytics_community_model_publications SET payload_json=?,payload_sha256=?')
    .bind(invalid,withSelfHash?await sha256Hex(invalid):'0'.repeat(64)).run();
   const pending=await readStorageCommunityProgress(bindings(),Date.now());
   expect(pending.history).toMatchObject({resolvedDays:0,activeDay:day()});
   await b.STORAGE_ANALYTICS_DB.prepare('UPDATE analytics_community_graph_scan SET tick=1').run();
   expect(await advanceStorageCommunityGraphWork(bindings())).toMatchObject({metric:'model',day:day()});
   expect(await publishStorageCommunityModelDay(bindings(),{day:day()})).toMatchObject({state:'published'});
   expect(await b.STORAGE_ANALYTICS_DB.prepare('SELECT payload_json,payload_sha256 FROM analytics_community_model_publications').first()).toEqual(original);
   expect((await readStorageCommunityProgress(bindings(),Date.now())).history.resolvedDays).toBe(1);
  }
  // Matching epochs alone must not convert a completed-result snapshot into a
  // claim that every contributor's newest inputs have been calculated.
  await b.STORAGE_ANALYTICS_DB.prepare('UPDATE analytics_community_graph_previews SET inputs_current=0').run();
  expect((await readStorageCommunityProgress(bindings(),Date.now())).work).toMatchObject({state:'queued',phase:'current'});
 });
 it('fences policy changes and discards invalid cached previews without hiding daily activity',async()=>{
  await fixture();await compute('fits');await publishStorageCommunityGraphPreview(bindings());
  await b.STORAGE_ANALYTICS_DB.prepare("UPDATE analytics_community_graph_previews SET payload_sha256=?").bind('0'.repeat(64)).run();
  expect(await readPublishedStorageCommunityGraph(bindings())).toBeNull();
  const response=await api();expect(response.status).toBe(200);expect(await response.json()).toMatchObject({allowanceState:'updating',days:[{day:day()}]});
  expect((await publishStorageCommunityGraphPreview(bindings())).state).toBe('published');
  expect(await readPublishedStorageCommunityGraph(bindings())).not.toBeNull();
  await typed().prepare('UPDATE community_snapshot_policy SET maturity_days=maturity_days+1 WHERE singleton_id=1').run();
  expect(await readPublishedStorageCommunityGraph(bindings())).toBeNull();
  await retireStorageCommunityGraphPublications(bindings());
  expect(await b.STORAGE_ANALYTICS_DB.prepare('SELECT count(*) n FROM analytics_community_graph_previews').first('n')).toBe(0);
 });
 it('retains a proved historical point across a real outside-window append, but hides attribution corrections',async()=>{
  const f=await fixture();await compute('model');await compute('fits');
  await publishStorageCommunityModelDay(bindings(),{day:day()});await publishStorageCommunityGraphPreview(bindings());
  const old=await b.STORAGE_ANALYTICS_DB.prepare('SELECT * FROM analytics_community_model_publications').first();
  const before=await captureStorageCommunityAuthority(typed());
  const originalDays=await activeDays(f),current=await stage(typed(),f,await makeV11Day(today(),{
   usage:[v11UsageRecord(today(),'b')]}),true);
  await activateDays(f,[...originalDays.filter(row=>row.day!==today()),current]);
  const appended=await captureStorageCommunityAuthority(typed());
  expect(appended).toMatchObject({publicAuthorityEpoch:before.publicAuthorityEpoch,graphInvalidationEpoch:before.graphInvalidationEpoch});
  expect(appended.sourceEpoch).toBeGreaterThan(before.sourceEpoch);
  expect(await readPublishedStorageCommunityGraph(bindings())).not.toBeNull();
  expect(await publishStorageCommunityModelDay(bindings(),{day:day()})).toMatchObject({state:'unchanged'});
  expect(await compute('model')).toMatchObject({state:'complete',reused:true});
  expect(await publishStorageCommunityModelDay(bindings(),{day:day()})).toMatchObject({state:'unchanged'});
  expect(await b.STORAGE_ANALYTICS_DB.prepare('SELECT * FROM analytics_community_model_publications').first()).toEqual(old);
  const corrected=evidence();
  for(const record of [...corrected.quota,...corrected.usage])record.accountPlanAttribution={
   ...record.accountPlanAttribution,accountTrackId:'account-track:v2:'+'b'.repeat(64)};
  const revised=await stage(typed(),f,await makeV11Day(day(),corrected),true);
  await activateDays(f,[revised,current]);
  const after=await captureStorageCommunityAuthority(typed());
  expect(after.graphInvalidationEpoch).toBeGreaterThan(appended.graphInvalidationEpoch);
  expect(await readPublishedStorageCommunityGraph(bindings())).toBeNull();
  await retireStorageCommunityGraphPublications(bindings());
  expect(await b.STORAGE_ANALYTICS_DB.prepare('SELECT count(*) n FROM analytics_community_model_publications').first('n')).toBe(0);
 });
 it('publishes closed history for two active owners while both append today before every attempt',async()=>{
  const fixtures=[await fixture('participant:continuous-a'),await fixture('participant:continuous-b')];
  await compute('model',day(),0);await compute('model',day(),1);
  const cached=await b.STORAGE_ANALYTICS_DB.prepare("SELECT owner_digest,input_revision,dependency_digest,computed_ms,payload_sha256 FROM analytics_community_graph_results WHERE metric='model' ORDER BY owner_digest").all();
  const authority=await captureStorageCommunityAuthority(typed());
  for(let round=1;round<=3;round++){
   for(const f of fixtures)await appendToday(f,round);
   const current=await captureStorageCommunityAuthority(typed());
   expect(current,`append round ${round}`).toMatchObject({publicAuthorityEpoch:authority.publicAuthorityEpoch,graphInvalidationEpoch:authority.graphInvalidationEpoch});
   const meter=createD1InvocationBudget(250);
   expect(await publishStorageCommunityModelDay({...bindings(),source:meter.wrap(typed()),target:meter.wrap(b.STORAGE_ANALYTICS_DB)},
    {day:day()})).toMatchObject({state:round===1?'published':'unchanged',memberCount:2});
   expect(meter.queriesUsed).toBeLessThan(20);
   expect((await b.STORAGE_ANALYTICS_DB.prepare("SELECT owner_digest,input_revision,dependency_digest,computed_ms,payload_sha256 FROM analytics_community_graph_results WHERE metric='model' ORDER BY owner_digest").all()).results).toEqual(cached.results);
  }
  const stored=await b.STORAGE_ANALYTICS_DB.prepare('SELECT payload_json FROM analytics_community_model_publications').first<string>('payload_json');
  expect(JSON.parse(stored!)).toMatchObject({day:day(),v1ParticipantCount:2});
  const original=await activeDays(fixtures[0]!),changed=evidence();
  changed.usage.push(v11UsageRecord(day(),'c',{eventId:'event:historical-append'}));
  const revised=await stage(typed(),fixtures[0]!,await makeV11Day(day(),changed),true);
  await activateDays(fixtures[0]!,[...original.filter(row=>row.day!==day()),revised]);
  expect((await captureStorageCommunityAuthority(typed())).graphInvalidationEpoch).toBe(authority.graphInvalidationEpoch);
  expect(await publishStorageCommunityModelDay(bindings(),{day:day()})).toMatchObject({state:'deferred',reason:'cache_pending'});
 });
 it('publishes a truthful completed current-fit snapshot before continuously appending owners converge',async()=>{
  const fixtures=[await fixture('participant:snapshot-a'),await fixture('participant:snapshot-b')];
  await compute('fits',today(),0);await compute('fits',today(),1);
  const results=(await b.STORAGE_ANALYTICS_DB.prepare("SELECT input_revision,computed_ms,authority_json FROM analytics_community_graph_results WHERE metric='fits'")
   .all<{input_revision:number;computed_ms:number;authority_json:string}>()).results;
  for(const f of fixtures)await appendToday(f,1);
  expect(await publishStorageCommunityGraphPreview(bindings())).toMatchObject({state:'published',memberCount:2});
  const first=(await b.STORAGE_ANALYTICS_DB.prepare('SELECT * FROM analytics_community_graph_previews').first<Record<string,unknown>>())!;
  expect(first).toMatchObject({inputs_current:0,oldest_computed_ms:Math.min(...results.map(row=>row.computed_ms)),
   newest_computed_ms:Math.max(...results.map(row=>row.computed_ms))});
  expect(JSON.parse(String(first.authority_json)).sourceEpoch).toBeLessThan(Number(first.snapshot_source_epoch));
  expect((await readPublishedStorageCommunityAdminPreview(bindings()))!.coverage)
   .toMatchObject({uploadingParticipantCount:2,cachedParticipantCount:2});
  expect((await readStorageCommunityProgress(bindings(),Date.now())).work).toMatchObject({state:'queued',phase:'current'});
  for(const f of fixtures)await appendToday(f,2);
  expect(await publishStorageCommunityGraphPreview(bindings())).toMatchObject({state:'unchanged'});
  const second=(await b.STORAGE_ANALYTICS_DB.prepare('SELECT * FROM analytics_community_graph_previews').first<Record<string,unknown>>())!;
  expect(second).toMatchObject({payload_json:first.payload_json,generated_at:first.generated_at,
   oldest_computed_ms:first.oldest_computed_ms,newest_computed_ms:first.newest_computed_ms,inputs_current:0});
  expect(Number(second.snapshot_source_epoch)).toBeGreaterThan(Number(first.snapshot_source_epoch));
  await compute('fits',today(),0);
  expect(await publishStorageCommunityGraphPreview(bindings())).toMatchObject({state:'published'});
  expect(await b.STORAGE_ANALYTICS_DB.prepare('SELECT inputs_current FROM analytics_community_graph_previews').first('inputs_current')).toBe(0);
  await compute('fits',today(),1);
  expect(await publishStorageCommunityGraphPreview(bindings())).toMatchObject({state:'published'});
  expect(await b.STORAGE_ANALYTICS_DB.prepare('SELECT inputs_current FROM analytics_community_graph_previews').first('inputs_current')).toBe(1);
  expect((await readStorageCommunityProgress(bindings(),Date.now())).work.phase).toBe('history');
 });
 it('refreshes only the proof of an unchanged preview after an actual outside-window append',async()=>{
  const f=await fixture(),days=await activeDays(f);
  const date=(age:number)=>new Date(Date.parse(today())-age*86400000).toISOString().slice(0,10);
  for(let age=2;age<=100;age++)days.push(await stage(typed(),f,await makeV11Day(date(age),{}),true));
  await activateDays(f,days);await compute('fits');await publishStorageCommunityGraphPreview(bindings());
  const previous=(await b.STORAGE_ANALYTICS_DB.prepare('SELECT * FROM analytics_community_graph_previews').first<Record<string,unknown>>())!;
  days.push(await stage(typed(),f,await makeV11Day(date(101),{}),true));await activateDays(f,days);
  expect(await compute('fits')).toMatchObject({state:'complete',reused:true});
  expect(await publishStorageCommunityGraphPreview(bindings())).toMatchObject({state:'unchanged'});
  const refreshed=(await b.STORAGE_ANALYTICS_DB.prepare('SELECT * FROM analytics_community_graph_previews').first<Record<string,unknown>>())!;
  expect(refreshed).toMatchObject({payload_json:previous.payload_json,generated_at:previous.generated_at,
   oldest_computed_ms:previous.oldest_computed_ms,newest_computed_ms:previous.newest_computed_ms,inputs_current:1});
  expect(Number(refreshed.snapshot_source_epoch)).toBeGreaterThan(Number(previous.snapshot_source_epoch));
  expect(JSON.parse(String(refreshed.authority_json)).sourceEpoch).toBe(refreshed.snapshot_source_epoch);
  expect((await readStorageCommunityProgress(bindings(),Date.now())).work.phase).toBe('history');
 });
 it('refuses future input, changed source format and malformed completed-snapshot proofs',async()=>{
  const f=await fixture();await compute('fits');await appendToday(f,1);
  const cached=(await b.STORAGE_ANALYTICS_DB.prepare("SELECT * FROM analytics_community_graph_results WHERE metric='fits'").first<Record<string,unknown>>())!;
  await b.STORAGE_ANALYTICS_DB.prepare("UPDATE analytics_community_graph_results SET input_revision=input_revision+100 WHERE metric='fits'").run();
  expect(await publishStorageCommunityGraphPreview(bindings())).toMatchObject({state:'deferred',reason:'cache_pending'});
  await b.STORAGE_ANALYTICS_DB.prepare("UPDATE analytics_community_graph_results SET input_revision=?,source_kind='v1' WHERE metric='fits'").bind(cached.input_revision).run();
  expect(await publishStorageCommunityGraphPreview(bindings())).toMatchObject({state:'deferred',reason:'cache_pending'});
  await b.STORAGE_ANALYTICS_DB.prepare("UPDATE analytics_community_graph_results SET source_kind='v1.1' WHERE metric='fits'").run();
  expect(await publishStorageCommunityGraphPreview(bindings())).toMatchObject({state:'published'});
  const row=(await b.STORAGE_ANALYTICS_DB.prepare('SELECT * FROM analytics_community_graph_previews').first<Record<string,unknown>>())!;
  const authority=JSON.parse(String(row.authority_json)),latest=await captureStorageCommunityAuthority(typed());
  for(const patch of [{sourceEpoch:-1},{sourceEpoch:'1'},{sequence:latest.sequence+1}]){
   await b.STORAGE_ANALYTICS_DB.prepare('UPDATE analytics_community_graph_previews SET authority_json=?')
    .bind(canonicalJson({...authority,...patch})).run();
   expect(await readPublishedStorageCommunityGraph(bindings())).toBeNull();
  }
  await b.STORAGE_ANALYTICS_DB.prepare('UPDATE analytics_community_graph_previews SET authority_json=?,snapshot_source_epoch=?')
   .bind(row.authority_json,latest.sourceEpoch+1).run();
  expect(await readPublishedStorageCommunityGraph(bindings())).toBeNull();
  await b.STORAGE_ANALYTICS_DB.prepare('UPDATE analytics_community_graph_previews SET snapshot_source_epoch=?,newest_computed_ms=?')
   .bind(row.snapshot_source_epoch,Date.now()+600_000).run();
  expect(await readPublishedStorageCommunityGraph(bindings())).toBeNull();
  await expect(b.STORAGE_ANALYTICS_DB.prepare('UPDATE analytics_community_graph_previews SET oldest_computed_ms=NULL').run())
   .rejects.toThrow('CHECK constraint failed');
 });
 it('removes invalidated publications in bounded pages after actual independent-ledger owner erasure',async()=>{
  const f=await fixture(`participant:${crypto.randomUUID()}`);await compute('fits');
  for(let i=0;i<7;i++){
   const date=new Date(Date.parse(day())-i*86400000).toISOString().slice(0,10);
   await compute('model',date);expect((await publishStorageCommunityModelDay(bindings(),{day:date})).state).toBe('published');
  }
  await publishStorageCommunityGraphPreview(bindings());
  const runtime={...b,USAGE_MONITOR_DB:typed(),ENVIRONMENT:'synthetic-development',ACCOUNT_SCOPED_INGEST_MODE:'disabled'} as Env;
  expect(await eraseParticipantAsOwner(runtime,'e'.repeat(64),f.participantId)).toMatchObject({deleted:true});
  // Source authority withholds the old aggregate before any target delivery or cleanup.
  expect(await readPublishedStorageCommunityGraph(bindings())).toBeNull();
  // D1 changes includes each point's model-revision trigger: four point
  // deletions + four revision updates + the one preview deletion.
  expect(await retireStorageCommunityGraphPublications(bindings())).toBe(9);
  expect(await b.STORAGE_ANALYTICS_DB.prepare('SELECT count(*) n FROM analytics_community_model_publications').first('n')).toBe(3);
  expect(await retireStorageCommunityGraphPublications(bindings())).toBe(6);
  expect(await retireStorageCommunityGraphPublications(bindings())).toBe(0);
  expect(await b.STORAGE_ANALYTICS_DB.prepare('SELECT count(*) n FROM analytics_community_graph_previews').first('n')).toBe(0);
 });
 it('rejects late model and preview writes after a prioritized source-proven erasure fence',async()=>{
  const f=await fixture(`participant:${crypto.randomUUID()}`);await compute('model');await compute('fits');
  await publishStorageCommunityModelDay(bindings(),{day:day()});await publishStorageCommunityGraphPreview(bindings());
  const model=(await b.STORAGE_ANALYTICS_DB.prepare('SELECT * FROM analytics_community_model_publications').first<Record<string,unknown>>())!;
  const preview=(await b.STORAGE_ANALYTICS_DB.prepare('SELECT * FROM analytics_community_graph_previews').first<Record<string,unknown>>())!;
  const cursor=await b.STORAGE_ANALYTICS_DB.prepare('SELECT sequence FROM analytics_source_cursors').first('sequence');
  const runtime={...b,USAGE_MONITOR_DB:typed(),ENVIRONMENT:'synthetic-development',ACCOUNT_SCOPED_INGEST_MODE:'disabled'} as Env;
  await eraseParticipantAsOwner(runtime,'e'.repeat(64),f.participantId);
  const terminal=(await readIngestionChanges(typed(),namespace,0)).at(-1)!;expect(terminal.kind).toBe('owner-erased');
  // Unit-test the target guard with the exact terminal source receipt. The
  // coordinator's separate suite owns discovery/authentication of this fence.
  await b.STORAGE_ANALYTICS_DB.prepare('INSERT INTO analytics_storage_erasure_fences VALUES(?,?,?,?,?,?,?)')
   .bind(namespace,terminal.ownerDigest,terminal.eventDigest,terminal.sequence,terminal.revision,
    terminal.authorityEpoch,terminal.publicAuthorityEpoch).run();
  expect(await b.STORAGE_ANALYTICS_DB.prepare('SELECT sequence FROM analytics_source_cursors').first('sequence')).toBe(cursor);
  expect(await b.STORAGE_ANALYTICS_DB.prepare('SELECT state FROM analytics_owner_state WHERE owner_digest=?')
   .bind(terminal.ownerDigest).first('state')).toBe('active');
  await typed().prepare("UPDATE collection_controls SET publication_enabled=0,control_state='degraded',revision=revision+1 WHERE singleton=1").run();
  await typed().prepare('UPDATE community_public_source_bootstrap SET completed=0 WHERE singleton=1').run();
  await expect(publishStorageCommunityGraphPreview(bindings())).rejects.toThrow('STORAGE_COMMUNITY_AUTHORITY_UNAVAILABLE');
  await expect(readPublishedStorageCommunityGraph(bindings())).rejects.toThrow('STORAGE_COMMUNITY_AUTHORITY_UNAVAILABLE');
  await retireStorageCommunityGraphPublications(bindings());
  await expect(replayPublication('analytics_community_model_publications',model)).rejects.toThrow('analytics_publication_authority_stale');
  await expect(replayPublication('analytics_community_graph_previews',preview)).rejects.toThrow('analytics_publication_authority_stale');
  await typed().prepare("UPDATE collection_controls SET publication_enabled=1,control_state='operational',revision=revision+1 WHERE singleton=1").run();
  await typed().prepare('UPDATE community_public_source_bootstrap SET completed=1 WHERE singleton=1').run();
  expect(await publishStorageCommunityModelDay(bindings(),{day:day()})).toMatchObject({state:'published',memberCount:0});
  expect(await publishStorageCommunityGraphPreview(bindings())).toMatchObject({state:'published',memberCount:0});
  await expect(b.STORAGE_ANALYTICS_DB.prepare('UPDATE analytics_community_model_publications SET authority_json=?')
   .bind(model.authority_json).run()).rejects.toThrow('analytics_publication_authority_stale');
  await expect(b.STORAGE_ANALYTICS_DB.prepare('UPDATE analytics_community_graph_previews SET authority_json=?')
   .bind(preview.authority_json).run()).rejects.toThrow('analytics_publication_authority_stale');
 });
 it('reconciles a lost preview response and refuses a failed corruption repair with the same cohort',async()=>{
  await fixture();await compute('fits');let lost=false;
  const responseLost=observed(b.STORAGE_ANALYTICS_DB,async(sql,moment)=>{
   if(!lost&&moment==='after'&&sql.includes('INSERT INTO analytics_community_graph_previews')){lost=true;throw new Error('synthetic response lost');}
  });
  expect((await publishStorageCommunityGraphPreview({...bindings(),target:responseLost})).state).toBe('published');expect(lost).toBe(true);
  await b.STORAGE_ANALYTICS_DB.prepare('UPDATE analytics_community_graph_previews SET payload_sha256=?').bind('0'.repeat(64)).run();
  const unavailable=observed(b.STORAGE_ANALYTICS_DB,async(sql,moment)=>{
   if(moment==='before'&&sql.includes('INSERT INTO analytics_community_graph_previews'))throw new Error('synthetic target unavailable');
  });
  expect((await publishStorageCommunityGraphPreview({...bindings(),target:unavailable})).state).toBe('deferred');
  expect(await readPublishedStorageCommunityGraph(bindings())).toBeNull();
  expect((await publishStorageCommunityGraphPreview(bindings())).state).toBe('published');
 });
 it('repairs a wrong but self-consistent preview instead of blessing its unchanged cohort digest',async()=>{
  await fixture();await compute('fits');await publishStorageCommunityGraphPreview(bindings());
  const previous=(await b.STORAGE_ANALYTICS_DB.prepare('SELECT payload_json FROM analytics_community_graph_previews').first<string>('payload_json'))!;
  const wrong=JSON.parse(previous);wrong.coverage.uploadingParticipantCount++;
  wrong.coverage.cachedParticipantCount++;wrong.coverage.noQualifyingFitParticipantCount++;
  const payload=canonicalJson(wrong);
  await b.STORAGE_ANALYTICS_DB.prepare('UPDATE analytics_community_graph_previews SET payload_json=?,payload_sha256=?')
   .bind(payload,await sha256Hex(payload)).run();
  // Its shape and own hash are valid; they do not prove the calculated value.
  expect((await readPublishedStorageCommunityAdminPreview(bindings()))!.coverage.uploadingParticipantCount).toBe(2);
  expect(await publishStorageCommunityGraphPreview(bindings())).toMatchObject({state:'published'});
  expect((await readPublishedStorageCommunityAdminPreview(bindings()))!.coverage.uploadingParticipantCount).toBe(1);
 });
 it('does not commit a preview captured before a concurrent historical point publication',async()=>{
  await fixture();await compute('fits');await compute('model');let raced=false;
  const database=observed(b.STORAGE_ANALYTICS_DB,async(sql,moment)=>{
   if(!raced&&moment==='before'&&sql.includes('INSERT INTO analytics_community_graph_previews')){
    raced=true;expect((await publishStorageCommunityModelDay(bindings(),{day:day()})).state).toBe('published');
   }
  });
  expect((await publishStorageCommunityGraphPreview({...bindings(),target:database})).state).toBe('deferred');expect(raced).toBe(true);
  expect(await readPublishedStorageCommunityGraph(bindings())).toBeNull();
  expect((await publishStorageCommunityGraphPreview(bindings())).state).toBe('published');
  expect((await readPublishedStorageCommunityAdminPreview(bindings()))!.models.days).toHaveLength(1);
 });
 it('checks the source again after target reads on publication and on the admin cache read',async()=>{
  await fixture();await compute('fits');let raced=false;
  const database=observed(b.STORAGE_ANALYTICS_DB,async(sql,moment)=>{
   if(!raced&&moment==='after'&&sql.includes('SELECT revision,cohort_digest,payload_json,payload_sha256,authority_json')){
    raced=true;await typed().prepare('UPDATE community_snapshot_policy SET maturity_days=maturity_days+1 WHERE singleton_id=1').run();
   }
  });
  expect(await publishStorageCommunityGraphPreview({...bindings(),target:database})).toMatchObject({state:'deferred',reason:'source_changed'});
  await compute('fits');await publishStorageCommunityGraphPreview(bindings());raced=false;
  const readRace=observed(b.STORAGE_ANALYTICS_DB,async(sql,moment)=>{
   if(!raced&&moment==='after'&&sql.includes('SELECT payload_json,payload_sha256,authority_json,generated_at')){
    raced=true;await typed().prepare('UPDATE community_snapshot_policy SET maturity_days=maturity_days+1 WHERE singleton_id=1').run();
   }
  });
  expect(await readPublishedStorageCommunityAdminPreview({...bindings(),target:readRace})).toBeNull();expect(raced).toBe(true);
 });
});
