import {expect,it} from 'vitest';
import {native,candidate,lanes,bindings,setupLegacyFunctional,prepareLegacyFunctional,source,sourceId,sourceNamespace} from './helpers/analytics-functional-qualification';
import {createWholeWorkloadMeter,summarizeWholeWorkload} from './helpers/analytics-whole-workload';
import {sha256Hex} from '../src/crypto';
import type {CacheRetentionDayAggregate} from '../src/cache-retention-values';
import type {CacheRetentionDayWriteCursor} from '../src/cache-retention-day';
const golden=it.skipIf(!native.publicationClockAdapted||!candidate.publicationClockAdapted);
golden('publishes exact native legacy-selected daily, graph, model, preview and cache families from one accepted source',async()=>{
 const fixture=await setupLegacyFunctional();await prepareLegacyFunctional();
 const outputs=[];
 for(const lane of lanes){
  const measured=createWholeWorkloadMeter(source,lane.target,undefined,candidate.createD1InvocationBudget);
  const role=()=>measured.invocation('publication_role',(db,invocation)=>candidate.runCanonicalAnalyticsWorkPass({...bindings(lane.target),...db,
   invocation,now:Date.now,deadlineMs:Date.now()+55000,maxWaves:16,bridge:false,stages:['publication']}));
  for(const day of fixture.days){let complete=false;
   for(let pass=0;pass<32;pass++){
    if(lane.name==='candidate')await role();
    const progress=await measured.invocation('daily',(db,meter)=>lane.kernel.advanceStorageCommunityDaily({...bindings(lane.target),...db,day,
     sharedFeatures:true,sharedFeatureBudget:{now:Date.now,deadlineMs:Date.now()+55000,remainingQueries:()=>meter.remainingQueries}}));
    if(progress.state==='published'||progress.state==='unchanged'){complete=true;break;}
   }
   expect(complete,'LEGACY_DAILY_BOUND:'+lane.name+':'+day).toBe(true);
  }
  const graphs=[];
  for(const [metric,day] of [['model',fixture.day],['fits',fixture.today]] as const){let result;
   for(let pass=0;pass<32;pass++){
    const value=await measured.invocation('graph',async(db,meter)=>{
     const pin=await lane.kernel.loadV11SourcePin(db.source,fixture.participantId);if(!pin)throw Error('LEGACY_GRAPH_PIN_MISSING');
     const snapshot=await lane.kernel.loadTypedV11GenerationSnapshot(db.source,{sourceNamespace,pin});
     const scope=await lane.kernel.captureSelectedStorageGraphScope(db.source,{owner:fixture.owner,sourceId,sourceNamespace,day,metric,preparedFold:true,
      snapshot,ownerAuthorityEpoch:fixture.owner.authorityEpoch});
     expect(scope.source).toBe('v1.1');expect(scope.fixedNow).toBe(new Date(Date.parse(day+'T00:00:00.000Z')+86400000-1).toISOString());
     return lane.kernel.computeStorageGraphResult({...bindings(lane.target),...db},scope,{sharedFeatures:true,preparedFold:true,maxQueries:meter.remainingQueries,deadlineMs:Date.now()+55000});
    });
    if(value.state==='complete'){result=value.result;break;}
    expect(value.failure).toBeUndefined();
   }
   expect(result,'LEGACY_GRAPH_BOUND:'+lane.name+':'+metric).toBeDefined();graphs.push(result);
  }
  const model=await measured.invocation('model_publication',db=>lane.kernel.publishStorageCommunityModelDay({...bindings(lane.target),...db},{day:fixture.day}));
  expect(['published','unchanged']).toContain(model.state);
  const preview=await measured.invocation('preview_publication',db=>lane.kernel.publishStorageCommunityGraphPreview({...bindings(lane.target),...db},{nowMs:fixture.nowMs}));
  expect(['published','unchanged']).toContain(preview.state);
  const cache=[];
  for(const value of fixture.ready){
   if(lane.name==='candidate'){
    const aggregate=await measured.invocation('cache_read',db=>candidate.readCandidateCacheDay({...bindings(lane.target),...db,ownerDigest:fixture.owner.ownerDigest!,day:value.day,selectionMethod:'legacy-selected-v1'}));
    expect(aggregate,'LEGACY_CANONICAL_CACHE_DAY:'+value.day).not.toBeNull();cache.push(aggregate);continue;
   }
   const key={sourceId,sourceNamespace,sourceLayout:'typed-v11' as const,ownerDigest:fixture.owner.ownerDigest!,deviceId:fixture.deviceId,
    manifestId:value.manifestId,manifestDigest:value.manifestDigest,day:value.day};
   const carry=await measured.invocation('carry',db=>lane.kernel.readCacheRetentionCarryDays(db.target,key));
   let aggregate:CacheRetentionDayAggregate|undefined;
   for(let n=0;n<32&&!aggregate;n++)aggregate=await measured.invocation('cache_build',async(db,meter)=>{
    try{return await lane.kernel.createCacheRetentionDaySourceBuild({source:db.source,target:db.target,sourceNamespace,sharedFeatures:true})(key,carry,
     {remainingQueries:meter.remainingQueries,remainingSharedQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+55000});}
    catch(error){if(!(error instanceof lane.kernel.CacheRetentionDeferredError))throw error;return undefined;}
   });
   expect(aggregate).toBeDefined();let cursor:CacheRetentionDayWriteCursor|undefined,stored=false;
   for(let n=0;n<16;n++){
    const result=await measured.invocation('cache_write',db=>lane.kernel.writeCacheRetentionDay({target:db.target,key,carry,aggregate:aggregate!,...(cursor?{cursor}:{})}));
    if(result.status==='stored'){stored=true;break;}cursor=result.cursor;
   }
   expect(stored).toBe(true);
   const visible=await measured.invocation('cache_read',db=>lane.kernel.readCacheRetentionDay({target:db.target,key,carry}));
   expect(visible.status).toBe('ready');if(visible.status==='ready')cache.push(visible.aggregate);
  }
  let cacheSeries;
  if(lane.name==='candidate')for(let n=0;n<120;n++){
   cacheSeries=await candidate.readCandidatePublishedCache({...bindings(lane.target),nowMs:Date.now()});if(cacheSeries)break;await role();
  }else cacheSeries=await lane.kernel.readCacheRetentionCommunitySeries({target:lane.target,sourceId,nowMs:fixture.nowMs});
  expect(cacheSeries,'LEGACY_CACHE_PUBLICATION_BOUND').not.toBeNull();
  const daily=await lane.kernel.readPublishedStorageCommunityDaily({...bindings(lane.target),fromDay:fixture.days[0]!,throughDay:fixture.today});
  const publicGraph=await lane.kernel.readPublishedStorageCommunityGraph(bindings(lane.target),fixture.nowMs);expect(publicGraph).not.toBeNull();
  const storedDaily=(await lane.target.prepare('SELECT day,revision,payload_json,payload_sha256,released_at FROM analytics_community_daily_publications WHERE source_id=? ORDER BY day,revision').bind(sourceId).all()).results;
  const storedModels=(await lane.target.prepare('SELECT day,revision,payload_json,payload_sha256,computed_ms FROM analytics_community_model_publications WHERE source_id=? AND day=?').bind(sourceId,fixture.day).all()).results;
  for(const row of [...storedDaily,...storedModels])expect(await sha256Hex(row.payload_json as string)).toBe(row.payload_sha256);
  expect(storedDaily.map(row=>row.day)).toEqual(fixture.days);expect(storedModels).toHaveLength(1);
  outputs.push({daily,storedDaily,graphs,storedModels,preview:JSON.parse(publicGraph!.payload_json),cache,cacheSeries});
  const cost=summarizeWholeWorkload(measured.profile);console.log('legacy-family-cost',JSON.stringify({lane:lane.name,statements:cost.statements,invocations:cost.invocations,max:cost.maximumStatementsPerInvocation,performanceQualification:false}));
 }
 expect(outputs[1]).toEqual(outputs[0]);
 expect(outputs[0]!.cache.length).toBe(4);expect(outputs[0]!.graphs.length).toBe(2);
 console.log('legacy-family-proof',JSON.stringify({selectionMethod:'legacy-selected-v1',dailyDays:4,ownerGraphs:2,modelPublications:1,previews:1,cacheDays:4,cacheSeries:1,
  exactNativeParity:true,fullWholeWorkloadQualification:false,outputSha256:await sha256Hex(JSON.stringify(outputs[0]))}));
},180000);
