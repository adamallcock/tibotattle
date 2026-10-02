import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {transform} from 'esbuild';
import {createAnalyticsWorkloadPublicationClockTransform,PUBLICATION_CLOCK_REFERENCE_COMMIT} from './analytics-workload-publication-clock.mjs';

const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const daily='apps/worker/src/storage-community-daily.ts';
const profiles=[['pinned-f056940f','reference',4,11],['current','candidate',7,26]];
const digest=value=>createHash('sha256').update(value).digest('hex');
const source=async(profile,file)=>profile==='current'?readFile(path.join(repositoryRoot,file),'utf8'):
 execFileSync('git',['show',PUBLICATION_CLOCK_REFERENCE_COMMIT+':'+file],{cwd:repositoryRoot,encoding:'utf8',maxBuffer:4*1024*1024});
const dataModule=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const adapter=(profile='current',lane='candidate')=>createAnalyticsWorkloadPublicationClockTransform({profile,lane});
const code=expected=>cause=>{assert.equal(cause.code,expected);assert.equal(cause.message,expected);return true;};

test('requires a closed source profile paired with its exact lane',()=>{
 for(const options of [{},{profile:'current',lane:'reference'},{profile:'pinned-f056940f',lane:'candidate'},
  {profile:'__proto__'},{profile:'unknown',lane:'candidate'},{profile:{},lane:'candidate'}])
  assert.throws(()=>createAnalyticsWorkloadPublicationClockTransform(options),code('PUBLICATION_CLOCK_PROFILE_INVALID'));
 const next=adapter();
 for(const file of ['apps/worker/src/unknown.ts','apps/worker/src/__proto__','apps/worker/src/toString',
  'apps/worker/src/../storage-community-daily.ts','/private/source/path'])assert.equal(next.transformSource({path:file,contents:'private input'}),null);
 assert.throws(()=>next.transformSource({path:null,contents:''}),code('PUBLICATION_CLOCK_PATH_INVALID'));
 assert.throws(()=>next.completeManifest(),code('PUBLICATION_CLOCK_MANIFEST_INCOMPLETE'));
});

test('virtual clocks require explicit initialization and isolate the two lanes',async()=>{
 const reference=await import(dataModule(adapter('pinned-f056940f','reference').clockModuleSource));
 const candidate=await import(dataModule(adapter().clockModuleSource));
 for(const clock of [reference,candidate])assert.throws(()=>clock.readAnalyticsWorkloadPublicationClock(),code('PUBLICATION_CLOCK_UNINITIALIZED'));
 const first=reference.setAnalyticsWorkloadPublicationClock(1000);
 assert.deepEqual(first,{lane:'reference',nowMs:1000,revision:1});assert.equal(Object.isFrozen(first),true);
 assert.equal(reference.readAnalyticsWorkloadPublicationClock(),1000);
 assert.throws(()=>candidate.readAnalyticsWorkloadPublicationClock(),code('PUBLICATION_CLOCK_UNINITIALIZED'));
 for(const value of [NaN,Infinity,-1,1.5,'1000',undefined,Number.MAX_SAFE_INTEGER])
  assert.throws(()=>reference.setAnalyticsWorkloadPublicationClock(value),code('PUBLICATION_CLOCK_VALUE_INVALID'));
 assert.equal(reference.readAnalyticsWorkloadPublicationClock(),1000);
 candidate.setAnalyticsWorkloadPublicationClock(2000);assert.equal(reference.readAnalyticsWorkloadPublicationClock(),1000);
 // An intentional earlier clock is allowed; publication CAS owns its refusal.
 assert.equal(reference.setAnalyticsWorkloadPublicationClock(0).revision,2);
 assert.equal(reference.readAnalyticsWorkloadPublicationClock(),0);
 assert.equal(candidate.readAnalyticsWorkloadPublicationClock(),2000);
});

test('both exact installed source profiles transform and parse with complete bounded hash evidence',async()=>{
 for(const [profile,lane,files,anchors] of profiles){
  const next=adapter(profile,lane);let seen=0;
  for(const file of next.sourcePaths){
   const original=await source(profile,file),changed=next.transformSource({path:file,contents:original});
   assert.equal(changed.loader,'ts');assert.ok(changed.contents.startsWith('import {readAnalyticsWorkloadPublicationClock as __p11PublicationNowMs}'));
   await transform(changed.contents,{loader:'ts',format:'esm',target:'es2022',logLevel:'silent'});
   // Repeated original onLoad is deterministic before sealing, without a new row.
   assert.equal(digest(next.transformSource({path:file,contents:original}).contents),digest(changed.contents));
   seen++;
  }
  const receipt=next.completeManifest();assert.equal(seen,files);assert.equal(receipt.files.length,files);
  assert.equal(receipt.files.reduce((sum,file)=>sum+file.anchors.length,0),anchors);
  assert.ok(receipt.files.every(file=>file.anchors.every(anchor=>anchor.matches===1)));
  assert.ok(receipt.files.every(file=>file.originalSha256!==file.transformedSha256&&file.originalBytes>0&&file.transformedBytes>file.originalBytes));
  assert.equal(receipt.virtualModuleSha256,digest(next.clockModuleSource));
  for(const file of receipt.files)assert.equal(file.originalSha256,digest(await source(profile,file.path)));
  assert.ok(Buffer.byteLength(JSON.stringify(receipt))<16*1024);
  assert.ok(!JSON.stringify(receipt).includes('function saveStorageGraphResult'));
  receipt.files[0].anchors[0].matches=99;assert.equal(next.completeManifest().files[0].anchors[0].matches,1);
  assert.throws(()=>next.transformSource({path:daily,contents:''}),code('PUBLICATION_CLOCK_MANIFEST_SEALED'));
 }
});

test('missing and duplicated literal anchors or scopes fail with content-free categories',async()=>{
 const original=await source('current',daily);
 const needle='const nowMs=options.nowMs??Date.now();if(!Number.isFinite(nowMs))throw unavailable();';
 for(const [contents,expected,count] of [
  [original.replace(needle,'const changedPublicationClock = 1;'),'PUBLICATION_CLOCK_ANCHOR_NOT_UNIQUE',0],
  [original.replace(needle,needle+'\n  '+needle),'PUBLICATION_CLOCK_ANCHOR_NOT_UNIQUE',2],
  [original+'\nexport async function advanceStorageCommunityDaily(){throw new Error("private-input");}', 'PUBLICATION_CLOCK_SCOPE_NOT_UNIQUE',2],
 ]){
  assert.throws(()=>adapter().transformSource({path:daily,contents}),cause=>{
   code(expected)(cause);assert.equal(cause.diagnostic.matches,count);assert.ok(!JSON.stringify(cause).includes('private-input'));return true;
  });
 }
 assert.throws(()=>adapter().transformSource({path:daily,contents:null}),code('PUBLICATION_CLOCK_SOURCE_INVALID'));
});

test('profile mismatch, double transformation, oversized source and changed reload fail closed',async()=>{
 const original=await source('current',daily),next=adapter(),first=next.transformSource({path:daily,contents:original});
 assert.throws(()=>next.transformSource({path:daily,contents:first.contents}),code('PUBLICATION_CLOCK_ALREADY_TRANSFORMED'));
 assert.throws(()=>next.transformSource({path:daily,contents:original+'\n// changed source'}),code('PUBLICATION_CLOCK_SOURCE_CHANGED'));
 assert.throws(()=>adapter().transformSource({path:daily,contents:'x'.repeat(2*1024*1024+1)}),code('PUBLICATION_CLOCK_SOURCE_INVALID'));
 assert.throws(()=>adapter('pinned-f056940f','reference').transformSource({path:daily,contents:original}),code('PUBLICATION_CLOCK_SOURCE_PROFILE_MISMATCH'));
});

test('a matching literal outside the named declaration scope stays untouched',async()=>{
 const original=await source('current',daily);
 const outside="\nexport async function syntheticUnrelatedClock(options){\n const nowMs=options.nowMs??Date.now();if(!Number.isFinite(nowMs))throw unavailable();\n return nowMs;\n}\n";
 const changed=adapter().transformSource({path:daily,contents:original+outside});
 assert.ok(changed.contents.endsWith(outside));
});

test('calendar and publication changes leave real operational clocks and guards intact',async()=>{
 const next=adapter();
 const graph=next.transformSource({path:'apps/worker/src/storage-community-graph-work.ts',contents:await source('current','apps/worker/src/storage-community-graph-work.ts')}).contents;
 for(const keep of ['const nowMs=options.nowMs??Date.now();','selection:selection!,claimToken:token,nowMs,','Date.now()>=(options.deadlineMs??Date.now()+20_000)'])assert.ok(graph.includes(keep));
 const activity=next.transformSource({path:daily,contents:await source('current',daily)}).contents;
 assert.ok(activity.includes('expectedCount:0,nowMs:options.nowMs??Date.now()'));
 assert.ok(activity.includes('lease.claimToken,Date.now()'));
 assert.ok(activity.includes('nowMs:Date.now(),authority,terminalEpoch:sourceTerminal'));
 const cache=next.transformSource({path:'apps/worker/src/storage-community-cache-publication.ts',contents:await source('current','apps/worker/src/storage-community-cache-publication.ts')}).contents;
 for(const keep of ['const start=input.budget.meter.queriesUsed,target=input.budget.meter.wrap(input.target),now=input.budget.now;',
  'expectedCount:expected,nowMs:now()','payloadHash=await sha256Hex(payload),computed=now();',
  'input.lease.workKey,input.lease.revision,input.lease.claimToken,computed,closureKey,previous',
  'slice(0,10),input.nowMs)', 'previous.valid_until_ms>input.nowMs'])assert.ok(cache.includes(keep));
 const work=next.transformSource({path:'apps/worker/src/storage-analytics-maintained-work.ts',contents:await source('current','apps/worker/src/storage-analytics-maintained-work.ts')}).contents;
 for(const keep of ['analyticsWorkAdmissionStatements(target,[request],nowMs)',
  'readAnalyticsPartitionWork(target,lease,nowMs)', '.bind(nowMs,lease.workKey,lease.revision,lease.claimToken,nowMs,'])assert.ok(work.includes(keep));
 for(const file of ['storage-analytics-worker.ts','storage-publication-worker.ts','cache-retention-day-worker.ts','storage-community-publication-cohort.ts'])
  assert.equal(next.transformSource({path:'apps/worker/src/'+file,contents:'Date.now()'}),null);
});

test('explicit daily caller time stays operational while publication uses the logical clock',async()=>{
 const next=adapter();
 const fixture=`const unavailable=()=>new Error('synthetic');
export async function advanceStorageCommunityDaily(options={}){
 const realLeaseNow=Date.now();
 const realClosureNow=options.nowMs??Date.now();
 const nowMs=options.nowMs??Date.now();if(!Number.isFinite(nowMs))throw unavailable();
 return {releasedAt:new Date(nowMs).toISOString(),realLeaseNow,realClosureNow};
}
export async function readPublishedStorageCommunityDaily(options){
 return false?null:await readCacheRetentionCommunitySeries({target:options.target,sourceId:options.sourceId,nowMs:Date.now()});
}
`;
 const clockUrl=dataModule(next.clockModuleSource+'\n// synthetic-clock-fixture');
 const clock=await import(clockUrl);clock.setAnalyticsWorkloadPublicationClock(1000);
 const changed=next.transformSource({path:daily,contents:fixture});
 const compiled=await transform(changed.contents,{loader:'ts',format:'esm',target:'es2022',logLevel:'silent'});
 const publisher=await import(dataModule(compiled.code.replace(next.moduleSpecifier,clockUrl)));
 const before=Date.now(),receipt=await publisher.advanceStorageCommunityDaily();
 assert.equal(receipt.releasedAt,'1970-01-01T00:00:01.000Z');assert.ok(receipt.realLeaseNow>=before);
 const operationalNow=Date.now(),explicit=await publisher.advanceStorageCommunityDaily({nowMs:operationalNow});
 assert.equal(explicit.releasedAt,'1970-01-01T00:00:01.000Z');assert.equal(explicit.realClosureNow,operationalNow);
 assert.ok(receipt.realClosureNow>=before);
 assert.ok(Date.now()>=before);assert.ok(!next.clockModuleSource.includes('Date.now ='));
});

test('explicit role model and preview times cannot override or bypass logical clock initialization',async()=>{
 const next=adapter(),clockUrl=dataModule(next.clockModuleSource+'\n// synthetic-explicit-publisher-fixture');
 const fixture=`const fail=()=>new Error('synthetic');
export async function storageCommunityGraphPreviewReadyHint(bindings,options={}){
 const nowMs=options.nowMs??Date.now();if(!Number.isFinite(nowMs))throw fail();
 return nowMs;
}
async function capture(row){return row.computed_ms>Date.now()+300_000;}
export async function publishStorageCommunityModelDay(bindings,options){
 const computedMs=options.nowMs??Date.now();if(!Number.isFinite(computedMs))throw fail();
 return {computedMs,realLeaseNow:options.nowMs};
}
export async function publishStorageCommunityGraphPreview(bindings,options={}){
 const nowMs=options.nowMs??Date.now();if(!Number.isFinite(nowMs))throw fail();
 return {generatedAt:new Date(nowMs).toISOString(),realLeaseNow:options.nowMs};
}
export async function readPublishedStorageCommunityGraph(bindings,
 nowMs=Date.now()):Promise<PublicAllowanceBreakdownsCacheRow|null>{return null;}
export async function readPublishedStorageCommunityAdminPreview(bindings,
 nowMs=Date.now()):Promise<AdminCommunityAllowancePreview|null>{return null;}
export async function retireStorageCommunityGraphPublications(bindings,nowMs=Date.now()){
 const from=new Date(Date.parse(new Date(nowMs).toISOString().slice(0,10))
 -(70-1)*86400000).toISOString().slice(0,10);return from;
}
`;
 const changed=next.transformSource({path:'apps/worker/src/storage-community-graph-publication.ts',contents:fixture});
 const compiled=await transform(changed.contents,{loader:'ts',format:'esm',target:'es2022',logLevel:'silent'});
 const publisher=await import(dataModule(compiled.code.replace(next.moduleSpecifier,clockUrl))),real=Date.now();
 for(const publish of [publisher.publishStorageCommunityModelDay,publisher.publishStorageCommunityGraphPreview])
  await assert.rejects(publish({}, {nowMs:real}),code('PUBLICATION_CLOCK_UNINITIALIZED'));
 const clock=await import(clockUrl);clock.setAnalyticsWorkloadPublicationClock(1000);
 assert.deepEqual(await publisher.publishStorageCommunityModelDay({}, {nowMs:real}),{computedMs:1000,realLeaseNow:real});
 assert.deepEqual(await publisher.publishStorageCommunityGraphPreview({}, {nowMs:real}),{generatedAt:'1970-01-01T00:00:01.000Z',realLeaseNow:real});
});

test('synthetic calendar control cannot revive an expired real graph lease or cache cohort',async()=>{
 const next=adapter(),clockUrl=dataModule(next.clockModuleSource+'\n// synthetic-real-expiry-fixture');
 const clock=await import(clockUrl);clock.setAnalyticsWorkloadPublicationClock(1000);
 const graphFixture=`export async function advanceStorageCommunityGraphWork(options){
 const nowMs=options.nowMs??Date.now();
 const today=new Date(nowMs).toISOString().slice(0,10);
 return {today,leaseLive:options.claimExpiresMs>nowMs,realLeaseNow:nowMs};
}
`;
 const cacheFixture=`export async function advanceCanonicalCachePublication(input){
 const target=input.target;
 return readCanonicalCacheSeriesResult({target,nowMs:now(),budget:input.budget,stillCurrent,
 scopes:[]});
}
export async function readPublishedCanonicalCache(input){
 return input.target.prepare('synthetic').bind(input.sourceId,new Date(input.nowMs).toISOString().slice(0,10),input.nowMs).first();
}
export async function admitCanonicalCachePublicationRefresh(input){
 const anchorDay=new Date(input.nowMs).toISOString().slice(0,10);
 return {anchorDay,realAdmissionNow:input.nowMs};
}
`;
 const load=async(file,fixture)=>{
  const changed=next.transformSource({path:'apps/worker/src/'+file,contents:fixture});
  const compiled=await transform(changed.contents,{loader:'ts',format:'esm',target:'es2022',logLevel:'silent'});
  return import(dataModule(compiled.code.replace(next.moduleSpecifier,clockUrl)));
 };
 const graph=await load('storage-community-graph-work.ts',graphFixture);
 const actual=Date.now(),result=await graph.advanceStorageCommunityGraphWork({nowMs:actual,claimExpiresMs:actual-1});
 assert.equal(result.today,'1970-01-01');assert.equal(result.leaseLive,false);assert.equal(result.realLeaseNow,actual);
 const cache=await load('storage-community-cache-publication.ts',cacheFixture);let bound;
 const target={prepare:()=>({bind:(...values)=>{bound=values;return {first:async()=>actual-1>values[2]?{synthetic:true}:null};}})};
 assert.equal(await cache.readPublishedCanonicalCache({target,sourceId:'synthetic',nowMs:actual}),null);
 assert.equal(bound[1],'1970-01-01');assert.equal(bound[2],actual);
 assert.deepEqual(await cache.admitCanonicalCachePublicationRefresh({nowMs:actual}),{anchorDay:'1970-01-01',realAdmissionNow:actual});
});


test('publication role calendar anchors are exact, scoped and current-only',async()=>{
 const file='apps/worker/src/storage-analytics-publication-work.ts',original=await source('current',file);
 const anchors=[
  'const nowMs=now(),today=new Date(nowMs).toISOString().slice(0,10);',
  'const oldest=new Date(nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*86400000).toISOString().slice(0,10);',
 ];
 assert.equal(adapter('pinned-f056940f','reference').transformSource({path:file,contents:original}),null);
 for(const anchor of anchors){
  for(const [replacement,matches] of [['/* missing calendar anchor */',0],[anchor+'\n  '+anchor,2]]){
   assert.throws(()=>adapter().transformSource({path:file,contents:original.replace(anchor,replacement)}),cause=>{
    code('PUBLICATION_CLOCK_ANCHOR_NOT_UNIQUE')(cause);assert.equal(cause.diagnostic.matches,matches);return true;
   });
  }
 }
 const outside='\nexport async function unrelatedCalendar(){\n '+anchors.join('\n ')+'\n}\n';
 const changed=adapter().transformSource({path:file,contents:original+outside}).contents;
 assert.ok(changed.endsWith(outside));
 for(const keep of ['now()<input.budget.deadlineMs-1500',
  'nowMs:now(),canonicalClosure:true,publicationLease:input.lease',
  'completeAnalyticsPartitionWork(target,input.lease,[],now())'])assert.ok(changed.includes(keep),keep);
});

test('publication role rollover uses analytical days without reviving real expired leases or deadlines',async()=>{
 const next=adapter(),clockUrl=dataModule(next.clockModuleSource+'\n// synthetic-publication-role-calendar');
 const fixture=`const ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS=70;
export async function advanceAnalyticsPublicationWork(input){
 const now=input.now;
 const nowMs=now(),today=new Date(nowMs).toISOString().slice(0,10);
 const oldest=new Date(nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*86400000).toISOString().slice(0,10);
 return {today,oldest,clockPending:input.day>today,obsolete:input.day<oldest,
  realLeaseNow:nowMs,leaseLive:input.leaseExpiresMs>nowMs,deadlineLive:now()<input.deadlineMs};
}
`;
 const changed=next.transformSource({path:'apps/worker/src/storage-analytics-publication-work.ts',contents:fixture});
 const compiled=await transform(changed.contents,{loader:'ts',format:'esm',target:'es2022',logLevel:'silent'});
 const role=await import(dataModule(compiled.code.replace(next.moduleSpecifier,clockUrl))),clock=await import(clockUrl);
 const real=Date.now(),nextDay=Date.parse(new Date(real).toISOString().slice(0,10))+86400000;
 const input={now:()=>real,day:new Date(nextDay).toISOString().slice(0,10),leaseExpiresMs:real-1,deadlineMs:real-1};
 await assert.rejects(role.advanceAnalyticsPublicationWork(input),code('PUBLICATION_CLOCK_UNINITIALIZED'));
 clock.setAnalyticsWorkloadPublicationClock(nextDay+1000);
 const rollover=await role.advanceAnalyticsPublicationWork(input);
 assert.deepEqual(rollover,{today:input.day,oldest:new Date(nextDay-69*86400000).toISOString().slice(0,10),
  clockPending:false,obsolete:false,realLeaseNow:real,leaseLive:false,deadlineLive:false});
 assert.equal((await role.advanceAnalyticsPublicationWork({...input,day:new Date(nextDay+86400000).toISOString().slice(0,10)})).clockPending,true);
 assert.equal((await role.advanceAnalyticsPublicationWork({...input,day:new Date(nextDay-70*86400000).toISOString().slice(0,10)})).obsolete,true);
 clock.setAnalyticsWorkloadPublicationClock(1000);
 const old=await role.advanceAnalyticsPublicationWork({...input,day:'1970-01-01'});
 assert.equal(old.today,'1970-01-01');assert.equal(old.realLeaseNow,real);assert.equal(old.leaseLive,false);assert.equal(old.deadlineLive,false);
});
