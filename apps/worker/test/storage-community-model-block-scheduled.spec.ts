import {env,reset,type D1Migration} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {createModelBlockSelection,MODEL_BLOCK_METHOD,planHistoricalModelBlockRanges,
 type ModelBlockIdentity} from '../src/analytics-model-block-contract';
import {runStorageAnalyticsPass} from '../src/storage-analytics-runtime';
import {publishStorageCommunityModelDay} from '../src/storage-community-graph-publication';
import {advanceAnalyticsModelBlock,assertModelBlockSourceCurrent,captureModelBlockAuthorityDigest} from '../src/analytics-model-block';
import {readStorageCommunityOwnerPage} from '../src/storage-community-authority';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {ensureModelBlockJob,modelBlockJobKey,modelBlockStoreSupported,prepareModelBlockAdmission}
 from '../src/storage-analytics-model-block';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus}
 from './fixtures/shared-analytics-corpus';

const b=env as Env&{STORAGE_ANALYTICS_DB:D1Database;
 TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];
 TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const sourceId='synthetic-scheduled-model-block',sourceNamespace=sourceId;
const source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
const bindings=()=>({source:source(),target:target(),sourceId,sourceNamespace});

it('resumes a scheduled historical block after an accepted same-owner outside-day append',async()=>{
 await reset();
 await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId,sourceNamespace);
 const today=new Date().toISOString().slice(0,10);
 const range=planHistoricalModelBlockRanges(today).at(-1)!;
 const corpus=await seedSharedAnalyticsCorpus({...bindings(),anchorDay:range.outputThroughDay,
  calendarDays:14,graphDays:2,crossDayLinks:false});
 const old=await advanceAnalyticsModelBlock({...bindings(),owner:corpus.owner,...range,
  maxQueries:950,maxSteps:60,deadlineMs:Date.now()+20_000});
 expect(old.status).toBe('deferred');
 expect(old.identity).not.toBeNull();
 const oldKey=await modelBlockJobKey(old.identity!);
 const currentOwner=await corpus.appendOutsideV11();
 expect(currentOwner.ownerRevision).toBeGreaterThan(corpus.owner.ownerRevision);
 await target().prepare(`INSERT INTO analytics_community_graph_scan
  (source_id,revision,tick,current_position,history_position) VALUES(?,1,1,0,0)
  ON CONFLICT(source_id) DO UPDATE SET revision=revision+1,tick=1,current_position=0,history_position=0`)
  .bind(sourceId).run();
 const graphSelectionNowMs=Date.parse(`${today}T12:00:00.000Z`);
 let complete=false;
 for(let attempt=0;attempt<120;attempt++){
  const pass=await runStorageAnalyticsPass({...bindings(),publishCommunity:true,publicOnly:true,
   graphOnly:true,modelBlocks:true,sharedFeatures:true,graphSelectionNowMs,
   maxQueries:950,maxSteps:1,deadlineMs:Date.now()+20_000});
  expect(pass.graphFailure).toBeUndefined();
  expect(pass.queriesUsed).toBeLessThanOrEqual(950);
  complete=(await target().prepare(`SELECT COUNT(*) n FROM analytics_community_graph_results
   WHERE source_id=? AND owner_digest=? AND metric='model' AND day=?`)
   .bind(sourceId,currentOwner.ownerDigest,range.outputThroughDay).first<number>('n'))===1;
  if(complete)break;
 }
 expect(complete).toBe(true);
 expect(await target().prepare(`SELECT COUNT(*) n FROM analytics_model_blocks WHERE job_key=?`)
  .bind(oldKey).first<number>('n')).toBe(0);
 const jobs=(await target().prepare(`SELECT identity_json FROM analytics_model_blocks
  WHERE source_id=? AND owner_digest=?`).bind(sourceId,currentOwner.ownerDigest)
  .all<{identity_json:string}>()).results;
 expect(jobs.length).toBeGreaterThan(0);
 expect(jobs.length).toBeLessThanOrEqual(4);
 expect(jobs.some(row=>(JSON.parse(row.identity_json) as ModelBlockIdentity).ownerRevision===currentOwner.ownerRevision))
  .toBe(true);
},180_000);

it.each([{name:'constrained default',windowMs:20_000},{name:'minute',windowMs:55_000},
 {name:'long',windowMs:8*60_000}])
 ('completes shared-feature model dates through the scheduled $name window',async({windowMs})=>{
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId,sourceNamespace);
  const today=new Date().toISOString().slice(0,10);
  const selectedDay=planHistoricalModelBlockRanges(today).at(-1)!.outputThroughDay;
  const corpus=await seedSharedAnalyticsCorpus({...bindings(),anchorDay:selectedDay,
   calendarDays:14,graphDays:2,crossDayLinks:false});
  await target().prepare(`INSERT INTO analytics_community_graph_scan
   (source_id,revision,tick,current_position,history_position) VALUES(?,1,1,0,0)
   ON CONFLICT(source_id) DO UPDATE SET revision=revision+1,tick=1,current_position=0,history_position=0`)
   .bind(sourceId).run();
  const graphSelectionNowMs=Date.parse(`${today}T12:00:00.000Z`);
  let completed=false,invocations=0,maxQueries=0,totalQueries=0,wallMs=0;
  for(;invocations<120;invocations++){
   const started=performance.now();
   const pass=await runStorageAnalyticsPass({...bindings(),publishCommunity:true,publicOnly:true,
    graphOnly:true,modelBlocks:true,sharedFeatures:true,graphSelectionNowMs,
    maxQueries:950,maxSteps:1,deadlineMs:Date.now()+windowMs});
   wallMs+=performance.now()-started;
   expect(pass.graphFailure).toBeUndefined();
   expect(pass.queriesUsed).toBeLessThanOrEqual(950);
   maxQueries=Math.max(maxQueries,pass.queriesUsed);
   totalQueries+=pass.queriesUsed;
   completed=(await target().prepare(`SELECT COUNT(*) n FROM analytics_community_graph_results
    WHERE source_id=? AND owner_digest=? AND metric='model' AND day=?`)
    .bind(sourceId,corpus.owner.ownerDigest,selectedDay).first<number>('n'))===1;
   if(completed)break;
  }
  expect(completed).toBe(true);
  expect(maxQueries).toBeGreaterThan(0);
  expect(await target().prepare(`SELECT COUNT(*) n FROM analytics_model_blocks
   WHERE source_id=? AND owner_digest=? AND state='complete'`)
   .bind(sourceId,corpus.owner.ownerDigest).first<number>('n')).toBeGreaterThan(0);
  const featureCount=await target().prepare(`SELECT COUNT(*) n FROM analytics_shared_feature_days
   WHERE source_id=? AND owner_digest=? AND state='complete'`)
   .bind(sourceId,corpus.owner.ownerDigest).first<number>('n');
  expect(featureCount).toBeGreaterThan(0);
  const featureBytes=await target().prepare(`SELECT COALESCE(SUM(payload_bytes),0) n
   FROM analytics_shared_feature_days WHERE source_id=? AND owner_digest=?`)
   .bind(sourceId,corpus.owner.ownerDigest).first<number>('n');
  const projectionBytes=await target().prepare(`SELECT COALESCE(SUM(length(CAST(p.payload_json AS BLOB))),0) n
   FROM analytics_graph_day_pages p JOIN analytics_graph_day_values v ON v.value_key=p.value_key
   WHERE v.source_id=? AND v.owner_digest=?`)
   .bind(sourceId,corpus.owner.ownerDigest).first<number>('n');
  console.log('scheduled-model-block-window',JSON.stringify({windowMs,invocations:invocations+1,
   maxQueries,totalQueries,wallMs:Math.round(wallMs),featureCount,featureBytes,projectionBytes}));
 },180_000);

it('selects and publishes the newest and oldest clipped historical dates after each complete cohort',async()=>{
 await reset();
 await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId,sourceNamespace);
 const liveToday='2026-09-28';
 const ranges=planHistoricalModelBlockRanges(liveToday);
 const newest=ranges.at(-1)!,oldest=ranges[0]!;
 for(const edge of [newest,oldest])expect((Date.parse(edge.outputThroughDay)-
  Date.parse(edge.outputFromDay))/86_400_000+1).toBeLessThan(32);
 const corpus=await seedSharedAnalyticsCorpus({...bindings(),anchorDay:newest.outputThroughDay,
  calendarDays:78,graphDays:2,crossDayLinks:false});
 expect(await modelBlockStoreSupported(target())).toBe(true);
 expect(corpus.owner.hasEffective).toBe(true);
 const graphSelectionNowMs=Date.parse(`${liveToday}T12:00:00.000Z`);
 const owners=await readStorageCommunityOwnerPage(source());
 expect(owners.length).toBe(2);
 expect(owners.some(owner=>owner.ownerDigest===corpus.owner.ownerDigest)).toBe(true);
 // The corpus seeds the primary target owner. Admit the second synthetic
 // contributor so the normal publisher must wait for both native model rows.
 for(const owner of owners)await target().prepare(`INSERT INTO analytics_owner_state
  (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,'active')
  ON CONFLICT(source_id,owner_digest) DO NOTHING`)
  .bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch).run();
 await target().prepare(`INSERT INTO analytics_community_graph_scan
  (source_id,revision,tick,current_position,history_position) VALUES(?,1,1,0,0)
  ON CONFLICT(source_id) DO UPDATE SET revision=revision+1,tick=1,current_position=0,history_position=0`)
  .bind(sourceId).run();

 const runSelectedDay=async(selectedDay:string)=>{
  let sawBlock=false,sawCohortGap=false,published=false;
  for(let attempt=0;attempt<72;attempt++){
  const pass=await runStorageAnalyticsPass({...bindings(),publishCommunity:true,publicOnly:true,
   graphOnly:true,modelBlocks:true,graphSelectionNowMs,maxQueries:950,maxSteps:1,
   deadlineMs:Date.now()+60_000});
  expect(pass.queriesUsed).toBeLessThanOrEqual(950);
  expect(pass.graphFailure).toBeUndefined();
  const jobs=await target().prepare(`SELECT state FROM analytics_model_blocks
   WHERE source_id=? AND owner_digest=? AND json_extract(identity_json,'$.outputFromDay')<=?
    AND json_extract(identity_json,'$.outputThroughDay')>=?`)
   .bind(sourceId,corpus.owner.ownerDigest,selectedDay,selectedDay).all<{state:string}>();
  if(jobs.results.length>0)sawBlock=true;
  const primary=await target().prepare(`SELECT COUNT(*) n FROM analytics_community_graph_results
   WHERE source_id=? AND owner_digest=? AND metric='model' AND day=?`)
   .bind(sourceId,corpus.owner.ownerDigest,selectedDay).first<number>('n');
  const publication=await target().prepare(`SELECT payload_json FROM analytics_community_model_publications
   WHERE source_id=? AND day=?`).bind(sourceId,selectedDay).first<string>('payload_json');
  if(primary===1){
   expect(jobs.results.some(job=>job.state==='complete')).toBe(true);
   if(!publication)sawCohortGap=true;
  }
  if(publication){
   const parsed=JSON.parse(publication) as {day:string;values:unknown[];v1ParticipantCount:number;
    fittedParticipantCount:number;unstableParticipantCount:number;staleParticipantCount:number;
    refusedParticipantCount:number};
   expect(parsed.day).toBe(selectedDay);
   expect(parsed.v1ParticipantCount).toBe(owners.length);
   expect(parsed.fittedParticipantCount+parsed.unstableParticipantCount+
    parsed.staleParticipantCount+parsed.refusedParticipantCount).toBe(owners.length);
   if(selectedDay===newest.outputThroughDay)expect(parsed.values.length).toBeGreaterThan(0);
   published=true;break;
  }
  }
  expect(sawBlock).toBe(true);
  expect(sawCohortGap).toBe(true);
  expect(published).toBe(true);
  expect(await target().prepare(`SELECT COUNT(*) n FROM analytics_community_graph_results
  WHERE source_id=? AND metric='model' AND day=?`)
  .bind(sourceId,selectedDay).first<number>('n')).toBe(owners.length);
  expect(await publishStorageCommunityModelDay(bindings(),{day:selectedDay}))
  .toMatchObject({state:'unchanged'});
 };
 await runSelectedDay(newest.outputThroughDay);
 // Synthetic completed public points for intervening dates let the normal
 // newest-unfinished selector reach the oldest clipped date. The edge cohort
 // itself is still calculated and published through the real scheduled lane.
 const base=await target().prepare(`SELECT revision,method,cohort_digest,authority_json,payload_json,
  computed_ms FROM analytics_community_model_publications WHERE source_id=? AND day=?`)
  .bind(sourceId,newest.outputThroughDay).first<{revision:number;method:string;cohort_digest:string;
   authority_json:string;payload_json:string;computed_ms:number}>();
 expect(base).not.toBeNull();
 for(let ms=Date.parse(`${oldest.outputFromDay}T00:00:00.000Z`)+86_400_000;
  ms<Date.parse(`${newest.outputThroughDay}T00:00:00.000Z`);ms+=86_400_000){
  const day=new Date(ms).toISOString().slice(0,10);
  const payload=canonicalJson({...JSON.parse(base!.payload_json) as object,day});
  await target().prepare(`INSERT INTO analytics_community_model_publications
   (source_id,day,revision,method,cohort_digest,authority_json,payload_json,payload_sha256,computed_ms)
   VALUES(?,?,?,?,?,?,?,?,?)`).bind(sourceId,day,1,base!.method,await sha256Hex(day),
    base!.authority_json,payload,await sha256Hex(payload),base!.computed_ms).run();
 }
 await target().prepare(`UPDATE analytics_community_graph_scan SET revision=revision+1,
  tick=1,current_position=0,history_position=0 WHERE source_id=?`).bind(sourceId).run();
 await runSelectedDay(oldest.outputFromDay);
},240_000);

it('uses bounded native historical work when only the prior model-block migration is present',async()=>{
 await reset();
 const priorMigrations={...b,TEST_ANALYTICS_MIGRATIONS:b.TEST_ANALYTICS_MIGRATIONS
  .filter(migration=>migration.name<'0031_')};
 await initializeSharedAnalyticsCorpusDatabases(source(),target(),priorMigrations,sourceId,sourceNamespace);
 const today=new Date().toISOString().slice(0,10);
 const day=planHistoricalModelBlockRanges(today).at(-1)!.outputThroughDay;
 const corpus=await seedSharedAnalyticsCorpus({...bindings(),anchorDay:day,
  calendarDays:14,graphDays:2,crossDayLinks:false});
 expect(await modelBlockStoreSupported(target())).toBe(false);
 await target().prepare(`INSERT INTO analytics_community_graph_scan
  (source_id,revision,tick,current_position,history_position) VALUES(?,1,1,0,0)
  ON CONFLICT(source_id) DO UPDATE SET revision=revision+1,tick=1,current_position=0,history_position=0`)
  .bind(sourceId).run();
 let nativeRow=false;
 for(let attempt=0;attempt<8&&!nativeRow;attempt++){
  const pass=await runStorageAnalyticsPass({...bindings(),publishCommunity:true,publicOnly:true,
   graphOnly:true,modelBlocks:true,graphSelectionNowMs:Date.parse(`${today}T12:00:00.000Z`),
   maxQueries:950,maxSteps:1,deadlineMs:Date.now()+60_000});
  expect(pass.queriesUsed).toBeLessThanOrEqual(950);
  expect(pass.graphFailure).toBeUndefined();
  nativeRow=(await target().prepare(`SELECT COUNT(*) n FROM analytics_community_graph_results
   WHERE source_id=? AND owner_digest=? AND metric='model' AND day=?`)
   .bind(sourceId,corpus.owner.ownerDigest,day).first<number>('n'))===1;
 }
 expect(nativeRow).toBe(true);
 expect(await target().prepare(`SELECT COUNT(*) n FROM analytics_model_blocks`)
  .first<number>('n')).toBe(0);
},90_000);

it('retires expired model block parts on a full target only when model blocks are enabled',async()=>{
 await reset();
 await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId,sourceNamespace);
 const graphSelectionNowMs=Date.parse('2026-09-28T12:00:00.000Z');
 const priorNowMs=graphSelectionNowMs-90*86_400_000;
 const priorDay=new Date(priorNowMs).toISOString().slice(0,10);
 const range=planHistoricalModelBlockRanges(priorDay).at(-1)!;
 const corpus=await seedSharedAnalyticsCorpus({...bindings(),anchorDay:range.outputThroughDay,
  calendarDays:14,graphDays:2,crossDayLinks:false});
 const identity:ModelBlockIdentity={version:1,method:MODEL_BLOCK_METHOD,sourceId,sourceNamespace,
  ownerDigest:corpus.owner.ownerDigest,ownerRevision:corpus.owner.ownerRevision,
  authorityEpoch:corpus.owner.authorityEpoch,inputRevision:corpus.owner.inputRevision,
  authorityDigest:await captureModelBlockAuthorityDigest(source(),{sourceId,sourceNamespace}),...range};
 const token=await prepareModelBlockAdmission({target:target(),identity,todayDay:priorDay,
  now:priorNowMs,assertSourceCurrent:()=>assertModelBlockSourceCurrent(source(),corpus.owner,identity)});
 expect(token).not.toBeNull();
 expect(await ensureModelBlockJob({target:target(),identity,initial:createModelBlockSelection(identity),
  now:priorNowMs,historicalTodayDay:priorDay,admission:token!})).toBe(true);
 const counts=async()=>({jobs:await target().prepare(`SELECT COUNT(*) n FROM analytics_model_blocks`)
  .first<number>('n'),parts:await target().prepare(`SELECT COUNT(*) n FROM analytics_model_block_parts`)
  .first<number>('n')});
 expect(await counts()).toEqual({jobs:1,parts:1});
 const full=new Proxy(target(),{get(db,key){
  if(key==='prepare')return(sql:string)=>{
   const statement=db.prepare(sql);
   if(sql!=='SELECT 1 AS capacity_probe')return statement;
   return new Proxy(statement,{get(s,method){
    if(method==='run')return async()=>{const receipt=await s.run();
     return {...receipt,meta:{...receipt.meta,size_after:10_000_000_000}};};
    const value=Reflect.get(s,method);return typeof value==='function'?value.bind(s):value;
   }});
  };
  const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;
 }});
 const pass=(modelBlocks?:boolean)=>runStorageAnalyticsPass({...bindings(),target:full,
  publishCommunity:true,publicOnly:true,graphOnly:true,maxQueries:950,maxSteps:1,
  deadlineMs:Date.now()+60_000,graphSelectionNowMs,...(modelBlocks===undefined?{}:{modelBlocks})});
 expect(await pass()).toMatchObject({state:'deferred',reason:'capacity',sweepGraphWorked:0});
 expect(await counts()).toEqual({jobs:1,parts:1});
 const cleaned=await pass(true);
 expect(cleaned).toMatchObject({state:'deferred',reason:'capacity',sweepGraphWorked:1});
 expect(cleaned.sweepQueries).toBeGreaterThan(0);
 expect(cleaned.queriesUsed).toBeLessThanOrEqual(950);
 expect(await counts()).toEqual({jobs:0,parts:0});
},60_000);
