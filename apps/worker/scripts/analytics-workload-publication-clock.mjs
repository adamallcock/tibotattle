import {createHash} from 'node:crypto';

/** Benchmark-only source adaptation. Product source never imports this module.
 * Each lane owns an explicitly initialized logical publication clock. Real
 * lease, deadline, cohort, commit and observer clocks remain in the source.
 * These transforms are not proof of H04 or of an unchanged production bundle. */
export const PUBLICATION_CLOCK_REFERENCE_COMMIT='f056940fefabed0c7f0e88353cf54845b077f0c8';
const READ='__p11PublicationNowMs()';
const IDENTIFIER='__p11PublicationNowMs';
const MAX_SOURCE_BYTES=2*1024*1024;
const PREFIX='apps/worker/src/';
const sha=value=>createHash('sha256').update(value).digest('hex');
const failure=(code,diagnostic)=>Object.assign(new Error(code),{code,...(diagnostic?{diagnostic}: {})});
const rule=(id,scope,find,replacement)=>Object.freeze({id,scope,find,replacement});
const exported=name=>'export async function '+name+'(';

// A scope starts at one exact declaration and ends at the next top-level
// declaration. Only literal anchors inside that scope can be replaced.
const common={
 'storage-community-daily.ts':[
  // Role executors explicitly pass real options.nowMs for operational work.
  // Only the final release assignment ignores it; earlier closure creation
  // continues to consume the original option or Date.now().
  rule('daily_release',exported('advanceStorageCommunityDaily'),
   'const nowMs=options.nowMs??Date.now();if(!Number.isFinite(nowMs))throw unavailable();',
   `const nowMs=${READ};if(!Number.isFinite(nowMs))throw unavailable();`),
 ],
 'storage-community-graph.ts':[
  rule('graph_result_computed',exported('saveStorageGraphResult'),
   'canonicalJson(scope.authority),Date.now(),scope.source,',
   `canonicalJson(scope.authority),${READ},scope.source,`),
 ],
 'storage-community-graph-work.ts':[
  // nowMs also governs ensure/claim/expiry. Change only its calendar use.
  rule('graph_work_calendar',exported('advanceStorageCommunityGraphWork'),
   'const today=new Date(nowMs).toISOString().slice(0,10);',
   `const today=new Date(${READ}).toISOString().slice(0,10);`),
 ],
 'storage-community-graph-publication.ts':[
  rule('preview_ready_calendar',exported('storageCommunityGraphPreviewReadyHint'),
   'const nowMs=options.nowMs??Date.now();if(!Number.isFinite(nowMs))throw fail();',
   `const nowMs=options.nowMs??${READ};if(!Number.isFinite(nowMs))throw fail();`),
  rule('graph_capture_future_time','async function capture(',
   'row.computed_ms>Date.now()+300_000',`row.computed_ms>${READ}+300_000`),
  // These publication leaves must also ignore explicit role caller nowMs.
  rule('model_publication_computed',exported('publishStorageCommunityModelDay'),
   'const computedMs=options.nowMs??Date.now();if(!Number.isFinite(computedMs))throw fail();',
   `const computedMs=${READ};if(!Number.isFinite(computedMs))throw fail();`),
  rule('preview_publication_generated',exported('publishStorageCommunityGraphPreview'),
   'const nowMs=options.nowMs??Date.now();if(!Number.isFinite(nowMs))throw fail();',
   `const nowMs=${READ};if(!Number.isFinite(nowMs))throw fail();`),
  rule('public_preview_read',exported('readPublishedStorageCommunityGraph'),
   'nowMs=Date.now()):Promise<PublicAllowanceBreakdownsCacheRow|null>',
   `nowMs=${READ}):Promise<PublicAllowanceBreakdownsCacheRow|null>`),
  rule('admin_preview_read',exported('readPublishedStorageCommunityAdminPreview'),
   'nowMs=Date.now()):Promise<AdminCommunityAllowancePreview|null>',
   `nowMs=${READ}):Promise<AdminCommunityAllowancePreview|null>`),
  rule('model_publication_retention_calendar',exported('retireStorageCommunityGraphPublications'),
   'const from=new Date(Date.parse(new Date(nowMs).toISOString().slice(0,10))',
   `const from=new Date(Date.parse(new Date(${READ}).toISOString().slice(0,10))`),
 ],
};
const pinned={...common,'storage-community-daily.ts':[...common['storage-community-daily.ts'],
 rule('daily_native_cache_read',exported('readPublishedStorageCommunityDaily'),
  'sourceId:options.sourceId,nowMs:Date.now()});',`sourceId:options.sourceId,nowMs:${READ}});`),
]};
const maintained={...common,'storage-community-daily.ts':[...common['storage-community-daily.ts'],
 rule('daily_native_cache_read',exported('readPublishedStorageCommunityDaily'),
  ':await readCacheRetentionCommunitySeries({target:options.target,sourceId:options.sourceId,nowMs:Date.now()});',
  `:await readCacheRetentionCommunitySeries({target:options.target,sourceId:options.sourceId,nowMs:${READ}});`),
],
 'storage-community-cache-publication.ts':[
  rule('canonical_cache_payload_calendar',exported('advanceCanonicalCachePublication'),
   'readCanonicalCacheSeriesResult({target,nowMs:now(),budget:input.budget,stillCurrent,',
   `readCanonicalCacheSeriesResult({target,nowMs:${READ},budget:input.budget,stillCurrent,`),
  // input.nowMs still checks c.valid_until_ms in the adjacent SQL binding.
  rule('canonical_cache_read_calendar',exported('readPublishedCanonicalCache'),
   'new Date(input.nowMs).toISOString().slice(0,10)',`new Date(${READ}).toISOString().slice(0,10)`),
  // Admission/updated/expiry fields still use input.nowMs. computed=now()
  // in the publisher remains real: lease CAS and retirement also consume it.
  rule('canonical_cache_refresh_calendar',exported('admitCanonicalCachePublicationRefresh'),
   'const anchorDay=new Date(input.nowMs).toISOString().slice(0,10);',
   `const anchorDay=new Date(${READ}).toISOString().slice(0,10);`),
 ],
 'storage-analytics-publication-work.ts':[
  // This role gate uses the analytical publication calendar. Keep nowMs and
  // every lease, deadline, closure and completion clock operational.
  rule('maintained_publication_role_today',exported('advanceAnalyticsPublicationWork'),
   'const nowMs=now(),today=new Date(nowMs).toISOString().slice(0,10);',
   `const nowMs=now(),today=new Date(${READ}).toISOString().slice(0,10);`),
  rule('maintained_publication_role_oldest',exported('advanceAnalyticsPublicationWork'),
   'const oldest=new Date(nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*86400000).toISOString().slice(0,10);',
   `const oldest=new Date(${READ}-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*86400000).toISOString().slice(0,10);`),
 ],
 'storage-analytics-maintained-work.ts':[
  rule('maintained_publication_today',exported('admitMaintainedGraphPublications'),
   'const today=new Date(input.nowMs).toISOString().slice(0,10);',`const today=new Date(${READ}).toISOString().slice(0,10);`),
  rule('maintained_publication_oldest',exported('admitMaintainedGraphPublications'),
   'const oldest=dateAt(input.nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS);',
   `const oldest=dateAt(${READ}-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS);`),
  rule('maintained_demand_window','async function updateGraphDemands(',
   'dateAt(input.nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS),dateAt(input.nowMs)).all<GraphDemand>()',
   `dateAt(${READ}-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS),dateAt(${READ})).all<GraphDemand>()`),
  rule('maintained_computation_today',exported('admitMaintainedGraphComputations'),
   'const {target,sourceId,policyRevision,nowMs}=input,today=dateAt(nowMs);',
   `const {target,sourceId,policyRevision,nowMs}=input,today=dateAt(${READ});`),
  rule('maintained_computation_recent',exported('admitMaintainedGraphComputations'),
   'const date=lane===0?today:dateAt(nowMs-6*DAY_MS);',`const date=lane===0?today:dateAt(${READ}-6*DAY_MS);`),
  rule('maintained_computation_selection_window',exported('admitMaintainedGraphComputations'),
   '.bind(sourceId,policyRevision,policyRevision,today,dateAt(nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS),today,date,',
   `.bind(sourceId,policyRevision,policyRevision,today,dateAt(${READ}-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS),today,date,`),
  rule('maintained_computation_retention_window',exported('admitMaintainedGraphComputations'),
   '.bind(sourceId,today,dateAt(nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS)).run();',
   `.bind(sourceId,today,dateAt(${READ}-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS)).run();`),
  rule('maintained_graph_current_window',exported('maintainedGraphWorkIsCurrent'),
   "const today=dateAt(nowMs);if(match[1]==='fits'&&work.day!==today||work.day<dateAt(nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS)||work.day>today)return false;",
   `const today=dateAt(${READ});if(match[1]==='fits'&&work.day!==today||work.day<dateAt(${READ}-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS)||work.day>today)return false;`),
  rule('maintained_obsolete_graph_calendar',exported('closeObsoleteAnalyticsManifestWork'),
   'const today=dateAt(nowMs),oldDate=work.day<dateAt(nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS);',
   `const today=dateAt(${READ}),oldDate=work.day<dateAt(${READ}-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS);`),
  rule('maintained_graph_retirement_calendar',exported('retireMaintainedGraphWork'),
   'const today=dateAt(input.nowMs),oldest=dateAt(input.nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS);',
   `const today=dateAt(${READ}),oldest=dateAt(${READ}-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS);`),
 ],
};
const PROFILES=Object.freeze({'pinned-f056940f':{lane:'reference',files:pinned},current:{lane:'candidate',files:maintained}});
const PINNED_SOURCE_HASHES=Object.freeze({
 'storage-community-daily.ts':'5562105d38ead0bd1b5ffea17ed0404267330563e8b3ad892ca4b4715f1725e0',
 'storage-community-graph.ts':'11c8ec5e24a33488bd094de81231f4655a2ecaca23212b1c6bc0da6252cf38a2',
 'storage-community-graph-work.ts':'78df914c947e213e56edc15962befb4373626da09b781205d45efe6654792c62',
 'storage-community-graph-publication.ts':'9499d1f1142868749b76b93a4ebe493fbe0f7d75b87da981618f2c2c41609e40',
});
const declarations=/^(?:export\s+)?(?:async\s+)?(?:function|interface|class|type|const)\s/gu;

function occurrences(text,needle,start=0,end=text.length){
 const positions=[];let next=start;
 for(;;){const at=text.indexOf(needle,next);if(at<0||at+needle.length>end)return positions;positions.push(at);next=at+needle.length;}
}
function locate(contents,anchor,diagnostic){
 const starts=occurrences(contents,anchor.scope);
 if(starts.length!==1)throw failure('PUBLICATION_CLOCK_SCOPE_NOT_UNIQUE',{...diagnostic,anchorId:anchor.id,matches:starts.length});
 const start=starts[0],lineEnd=contents.indexOf('\n',start);
 let end=contents.length,position=lineEnd<0?end:lineEnd+1;
 // Top-level declarations have no leading indentation in these two profiles.
 // Multiline type signatures and nested declarations therefore stay in scope.
 for(;position<contents.length;){
  let next=contents.indexOf('\n',position);if(next<0)next=contents.length;
  declarations.lastIndex=0;
  if(declarations.test(contents.slice(position,next))){end=position;break;}
  position=next+1;
 }
 const matches=occurrences(contents,anchor.find,start,end);
 if(matches.length!==1)throw failure('PUBLICATION_CLOCK_ANCHOR_NOT_UNIQUE',{...diagnostic,anchorId:anchor.id,matches:matches.length});
 return {at:matches[0],find:anchor.find,replacement:anchor.replacement};
}

/** Exact API for the buildKernelBundle onLoad hook. Paths are repository-relative
 * POSIX paths. Other sources return null. Known sources must match every anchor.
 * Add entryExports to the entry, resolve moduleSpecifier into a virtual namespace
 * and return clockModuleSource from its onLoad. Set the exported clock before roles.
 * Never log contents; completeManifest is the bounded content-free build receipt. */
export function createAnalyticsWorkloadPublicationClockTransform({profile,lane}={}){
 const selected=typeof profile==='string'&&Object.hasOwn(PROFILES,profile)?PROFILES[profile]:null;
 if(!selected||selected.lane!==lane)throw failure('PUBLICATION_CLOCK_PROFILE_INVALID');
 const moduleSpecifier='analytics-workload:publication-clock/'+lane;
 const clockModuleSource=`// Benchmark logical publication clock; real clocks are untouched.
let value=null,revision=0;
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function setAnalyticsWorkloadPublicationClock(nowMs){
 if(!Number.isSafeInteger(nowMs)||nowMs<0||nowMs>8640000000000000)fail('PUBLICATION_CLOCK_VALUE_INVALID');
 if(revision>=65536)fail('PUBLICATION_CLOCK_REVISION_LIMIT');
 value=nowMs;revision++;return Object.freeze({lane:${JSON.stringify(lane)},nowMs:value,revision});
}
export function readAnalyticsWorkloadPublicationClock(){
 if(value===null)fail('PUBLICATION_CLOCK_UNINITIALIZED');return value;
}
`;
 const entryExports=`export {setAnalyticsWorkloadPublicationClock,readAnalyticsWorkloadPublicationClock} from ${JSON.stringify(moduleSpecifier)};\n`;
 const sourcePaths=Object.freeze(Object.keys(selected.files).map(file=>PREFIX+file).sort());
 const evidence=new Map();let sealed=false;
 return Object.freeze({moduleSpecifier,clockModuleSource,entryExports,sourcePaths,
  transformSource({path,contents}={}){
   if(typeof path!=='string')throw failure('PUBLICATION_CLOCK_PATH_INVALID');
   const relative=path.startsWith(PREFIX)?path.slice(PREFIX.length):null;
   const anchors=relative!==null&&Object.hasOwn(selected.files,relative)?selected.files[relative]:null;
   if(!anchors)return null;
   if(sealed)throw failure('PUBLICATION_CLOCK_MANIFEST_SEALED');
   const diagnostic={profile,lane,path};
   if(typeof contents!=='string'||Buffer.byteLength(contents)>MAX_SOURCE_BYTES)throw failure('PUBLICATION_CLOCK_SOURCE_INVALID',diagnostic);
   if(contents.includes(IDENTIFIER)||contents.includes(moduleSpecifier))throw failure('PUBLICATION_CLOCK_ALREADY_TRANSFORMED',diagnostic);
   const originalSha256=sha(contents);
   if(profile==='pinned-f056940f'&&originalSha256!==PINNED_SOURCE_HASHES[relative])
    throw failure('PUBLICATION_CLOCK_SOURCE_PROFILE_MISMATCH',diagnostic);
   if(evidence.has(path)&&evidence.get(path).originalSha256!==originalSha256)throw failure('PUBLICATION_CLOCK_SOURCE_CHANGED',diagnostic);
   const edits=anchors.map(anchor=>locate(contents,anchor,diagnostic)).sort((a,b)=>b.at-a.at);
   for(let index=1;index<edits.length;index++)if(edits[index].at+edits[index].find.length>edits[index-1].at)
    throw failure('PUBLICATION_CLOCK_ANCHORS_OVERLAP',diagnostic);
   let transformed=contents;
   for(const edit of edits)transformed=transformed.slice(0,edit.at)+edit.replacement+transformed.slice(edit.at+edit.find.length);
   transformed=`import {readAnalyticsWorkloadPublicationClock as ${IDENTIFIER}} from ${JSON.stringify(moduleSpecifier)};\n`+transformed;
   evidence.set(path,{path,originalSha256,transformedSha256:sha(transformed),originalBytes:Buffer.byteLength(contents),
    transformedBytes:Buffer.byteLength(transformed),anchors:anchors.map(anchor=>({id:anchor.id,matches:1}))});
   return {contents:transformed,loader:'ts'};
  },
  completeManifest(){
   if(evidence.size!==sourcePaths.length||sourcePaths.some(path=>!evidence.has(path)))
    throw failure('PUBLICATION_CLOCK_MANIFEST_INCOMPLETE',{profile,lane,expectedFiles:sourcePaths.length,transformedFiles:evidence.size});
   sealed=true;
   return structuredClone({schemaVersion:'analytics-workload-publication-clock-transform-v1',profile,lane,
    referenceCommit:profile==='pinned-f056940f'?PUBLICATION_CLOCK_REFERENCE_COMMIT:null,moduleSpecifier,
    virtualModuleSha256:sha(clockModuleSource),entryExportsSha256:sha(entryExports),files:sourcePaths.map(path=>evidence.get(path)),
    boundary:'Explicit benchmark analytical/publication clock only; real leases, deadlines, cohort creation/expiry and canonical cache commit metadata remain real. No global Date.now replacement; not H04 qualification.'});
  },
 });
}
