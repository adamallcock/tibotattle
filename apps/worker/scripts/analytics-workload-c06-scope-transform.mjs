import {createHash} from 'node:crypto';

/** Test-only instrumentation of reviewed candidate producer call boundaries.
 * Product SQL and meter handles are untouched. A source change requires an
 * explicit review of these anchors before another C06 census can run. */
const PREFIX='apps/worker/src/';
const FILES=Object.freeze({
  'storage-analytics-canonical-runtime.ts':{
    originalSha256:'e19db7557085902b0a92cdaa7b15ed12891b933eb65b6a131eae9c60077cd883',
    anchors:[
      ['coverage','advanceEffectiveDependencyCoverage(source,{sourceId:',
        "advanceEffectiveDependencyCoverage(c06ScopeSource(source,'scheduler_coverage'),{sourceId:"],
      ['effects','advanceAnalyticsWorkEffects({source,target,sourceId:',
        "advanceAnalyticsWorkEffects({source:c06ScopeSource(source,'scheduler_effects'),target,sourceId:"],
      ['cache_publication_admission','admitCanonicalCachePublicationRefresh({source,target,sourceId:',
        "admitCanonicalCachePublicationRefresh({source:c06ScopeSource(source,'scheduler_cache_publication_admission'),target,sourceId:"],
      ['rolling_admission','await admitRollingRequests(input,source,target);',
        "await admitRollingRequests(input,c06ScopeSource(source,'scheduler_rolling_admission'),target);"],
      ['singleton_stage','const shared={target,sources:[{sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,database:source}],lease,budget};',
        'const shared={target,sources:[{sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,database:c06ScopeSource(source,c06ScopeForPartitionStage(lease.stage))}],lease,budget};'],
      ['group_stage','({target,sources:[{sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,database:source}],leases,budget});',
        '({target,sources:[{sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,database:c06ScopeSource(source,c06ScopeForPartitionStage(groupStage))}],leases,budget});'],
      ['graph_producer','advanceStorageCommunityGraphWork({source:budget.meter.wrap(source),target:',
        "advanceStorageCommunityGraphWork({source:c06ScopeSource(budget.meter.wrap(source),graph[1]==='fits'?'scheduler_graph_fits':'scheduler_graph_model'),target:"],
      ['rolling_producer','executeCanonicalV1WindowRequest({source:budget.meter.wrap(source),target:',
        "executeCanonicalV1WindowRequest({source:c06ScopeSource(budget.meter.wrap(source),'scheduler_rolling_window'),target:"],
    ],
  },
  'storage-community-graph-work.ts':{
    originalSha256:'d94704336b7e6e6f03f6529331013371e45921e9c1f2fe40a9f47830c2ccd457',
    anchors:[
      ['candidate_model_block','()=>advanceStorageModelBlockGraphWork({source:options.source,target:options.target,',
        "()=>advanceStorageModelBlockGraphWork({source:c06ScopeSource(options.source,'candidate_model_block'),target:options.target,"],
    ],
  },
});
const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw new Error(code);};
const count=(text,needle)=>text.split(needle).length-1;

export function createAnalyticsC06ScopeTransform({lane}={}){
  if(lane!=='candidate')fail('C06_SCOPE_LANE');
  const moduleSpecifier='analytics-workload:c06-operation-scope/candidate';
  const moduleSource=`// Test-only bridge. The installer supplies the SAME operation facade instance as the census.
let scopeSource=null;
const scopes=new Set(${JSON.stringify([
  'canonical','features','cache','activity','publication','fits','cleanup',
])});
export function installAnalyticsC06ScopeSource(value){
  if(value!==null&&typeof value!=='function')throw Error('C06_SCOPE_INSTALL_INVALID');
  scopeSource=value;
}
export function c06ScopeSource(database,operationScope){
  return scopeSource?scopeSource(database,operationScope):database;
}
export function c06ScopeForPartitionStage(stage){
  if(!scopes.has(stage))throw Error('C06_SCOPE_STAGE_UNKNOWN');
  return 'scheduler_'+stage;
}
`;
  const entryExports=`export {installAnalyticsC06ScopeSource} from ${JSON.stringify(moduleSpecifier)};\n`;
  const evidence=new Map();let sealed=false;
  const sourcePaths=Object.freeze(Object.keys(FILES).map(file=>PREFIX+file).sort());
  return Object.freeze({moduleSpecifier,moduleSource,entryExports,sourcePaths,
    transformSource({path,contents,originalContents}={}){
      if(typeof path!=='string')fail('C06_SCOPE_PATH');
      const relative=path.startsWith(PREFIX)?path.slice(PREFIX.length):null;
      const spec=relative!==null&&Object.hasOwn(FILES,relative)?FILES[relative]:null;
      if(!spec)return null;
      if(sealed)fail('C06_SCOPE_SEALED');
      if(typeof contents!=='string'||typeof originalContents!=='string'
        ||Buffer.byteLength(contents)>250_000||Buffer.byteLength(originalContents)>250_000)
        fail('C06_SCOPE_SOURCE_INVALID');
      if(sha(originalContents)!==spec.originalSha256)fail('C06_SCOPE_SOURCE_DRIFT');
      if(contents.includes(moduleSpecifier)||contents.includes('installAnalyticsC06ScopeSource'))
        fail('C06_SCOPE_ALREADY_TRANSFORMED');
      const previous=evidence.get(path);
      if(previous&&previous.priorSha256!==sha(contents))fail('C06_SCOPE_PRIOR_DRIFT');
      let transformed=contents;
      for(const [id,find,replacement] of spec.anchors){
        if(count(originalContents,find)!==1||count(contents,find)!==1)
          fail('C06_SCOPE_ANCHOR_DRIFT_'+id);
        transformed=transformed.replace(find,replacement);
      }
      transformed=`import {c06ScopeSource,c06ScopeForPartitionStage} from ${JSON.stringify(moduleSpecifier)};\n`+transformed;
      const item={path,originalSha256:sha(originalContents),priorSha256:sha(contents),
        transformedSha256:sha(transformed),anchors:spec.anchors.map(([id])=>id)};
      evidence.set(path,item);
      return {contents:transformed,loader:'ts'};
    },
    completeManifest(){
      if(evidence.size!==sourcePaths.length||sourcePaths.some(path=>!evidence.has(path)))
        fail('C06_SCOPE_MANIFEST_INCOMPLETE');
      sealed=true;
      return structuredClone({schemaVersion:'analytics-c06-scope-transform-v1',lane,
        moduleSpecifier,moduleSourceSha256:sha(moduleSource),entryExportsSha256:sha(entryExports),
        files:sourcePaths.map(path=>evidence.get(path)),
        boundary:'Test-only fixed producer call scopes; source statements, budget and result remain authoritative. No C06 certificate.'});
    },
  });
}

/** Additive shared-phase instrumentation. The original nine-boundary adapter
 * and its controls are unchanged. Each new boundary is pinned to the same
 * original product bytes and checked after the original transform. */
export function createAnalyticsC06SharedScopeTransform({lane}={}){
  const base=createAnalyticsC06ScopeTransform({lane});
  const extra=Object.freeze({
    'storage-analytics-canonical-runtime.ts':[
      ['source_readiness','await requireAuthorityRestoreServingReady(source);',
        "await requireAuthorityRestoreServingReady(c06ScopeSource(source,'scheduler_prelude'));"],
      ['source_capability','!await effectiveSelectiveSchemaAvailable(source)',
        "!await effectiveSelectiveSchemaAvailable(c06ScopeSource(source,'scheduler_prelude'))"],
      ['graph_owner','await readStorageCommunityOwner(budget.meter.wrap(source),{ownerDigest:work.ownerDigest})',
        "await readStorageCommunityOwner(c06ScopeSource(budget.meter.wrap(source),'scheduler_graph_owner'),{ownerDigest:work.ownerDigest})"],
    ],
    'storage-community-graph-work.ts':[
      ['completed_model_block','    return block.state===\'complete\'?{state:block.reused?\'reused\':\'complete\',metric,day,\n',
        "    if(block.state==='complete')c06ObserveBlockCompletion({state:'complete',reused:block.reused===true,metric,day,adoptedDates:block.adoptedDates,queriesUsed:block.queriesUsed});\n    return block.state==='complete'?{state:block.reused?'reused':'complete',metric,day,\n"],
    ],
  });
  const moduleSource=base.moduleSource+`
let blockCompletion=null,blockCompletionCalls=0;
export function installAnalyticsC06BlockCompletion(value){
  if(value!==null&&typeof value!=='function')throw Error('C06_BLOCK_COMPLETION_INSTALL_INVALID');
  blockCompletion=value;blockCompletionCalls=0;
}
export function c06ObserveBlockCompletion(value){
  if(!blockCompletion)return;
  if(!value||Object.keys(value).sort().join(',')!=='adoptedDates,day,metric,queriesUsed,reused,state'
    ||value.state!=='complete'||typeof value.reused!=='boolean'||value.metric!=='model'
    ||typeof value.day!=='string'||!/^\\d{4}-\\d{2}-\\d{2}$/u.test(value.day)
    ||!Number.isFinite(Date.parse(value.day+'T00:00:00.000Z'))
    ||new Date(value.day+'T00:00:00.000Z').toISOString().slice(0,10)!==value.day
    ||!Number.isSafeInteger(value.adoptedDates)||value.adoptedDates<0||value.adoptedDates>32
    ||!Number.isSafeInteger(value.queriesUsed)||value.queriesUsed<0||value.queriesUsed>950
    ||++blockCompletionCalls>20000)throw Error('C06_BLOCK_COMPLETION_CONTRACT');
  const returned=blockCompletion(Object.freeze({...value}));
  if(returned!==undefined)throw Error('C06_BLOCK_COMPLETION_ASYNC_OR_RESULT');
}
`;
  const entryExports=base.entryExports+`export {installAnalyticsC06BlockCompletion} from ${JSON.stringify(base.moduleSpecifier)};\n`;
  const evidence=new Map();let sealed=false;
  return Object.freeze({...base,moduleSource,entryExports,
    transformSource(input={}){
      if(sealed)fail('C06_SHARED_SCOPE_SEALED');
      const transformed=base.transformSource(input);if(!transformed)return null;
      const relative=input.path.slice(PREFIX.length),anchors=extra[relative];
      let contents=transformed.contents;
      for(const [id,find,replacement]of anchors){
        if(count(input.originalContents,find)!==1||count(contents,find)!==1)
          fail('C06_SHARED_SCOPE_ANCHOR_DRIFT_'+id);
        contents=contents.replace(find,replacement);
      }
      if(relative==='storage-community-graph-work.ts')contents=`import {c06ObserveBlockCompletion} from ${JSON.stringify(base.moduleSpecifier)};\n`+contents;
      const previous=evidence.get(input.path);
      if(previous&&previous.priorSha256!==sha(transformed.contents))fail('C06_SHARED_SCOPE_PRIOR_DRIFT');
      evidence.set(input.path,{path:input.path,originalSha256:sha(input.originalContents),priorSha256:sha(transformed.contents),
        transformedSha256:sha(contents),anchors:anchors.map(([id])=>id)});
      return {...transformed,contents};
    },
    completeManifest(){
      if(evidence.size!==base.sourcePaths.length||base.sourcePaths.some(path=>!evidence.has(path)))fail('C06_SHARED_SCOPE_MANIFEST_INCOMPLETE');
      const original=base.completeManifest();sealed=true;
      return structuredClone({schemaVersion:'analytics-c06-shared-scope-transform-v2',lane,moduleSpecifier:base.moduleSpecifier,
        moduleSourceSha256:sha(moduleSource),entryExportsSha256:sha(entryExports),originalNineBoundaries:original,
        files:base.sourcePaths.map(path=>evidence.get(path)),
        boundary:'Test-only exact readiness/owner scopes and witnessed completed native model-block after source and selection fences; no source SQL or product outcome changes, no C06 certificate.'});
    },
  });
}
