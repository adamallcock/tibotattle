import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {build,transform} from 'esbuild';
import {createAnalyticsC06ScopeTransform} from './analytics-workload-c06-scope-transform.mjs';
import {createAnalyticsWorkloadPublicationClockTransform} from './analytics-workload-publication-clock.mjs';

const worker=new URL('../',import.meta.url);
const paths=['storage-analytics-canonical-runtime.ts','storage-community-graph-work.ts'];
const hash=value=>createHash('sha256').update(value).digest('hex');

test('candidate transform pins original source and exact call anchors after a prior transform',async()=>{
  const adapter=createAnalyticsC06ScopeTransform({lane:'candidate'});
  const clock=createAnalyticsWorkloadPublicationClockTransform({profile:'current',lane:'candidate'});
  for(const file of paths){
    const original=await readFile(new URL('src/'+file,worker),'utf8');
    const path='apps/worker/src/'+file;
    const prior=clock.sourcePaths.includes(path)
      ?clock.transformSource({path,contents:original}).contents
      :'// preceding reviewed transform\n'+original;
    const changed=adapter.transformSource({path,contents:prior,originalContents:original});
    assert.ok(changed);assert.notEqual(changed.contents,prior);
    await transform(changed.contents,{loader:'ts',format:'esm',target:'es2022'});
    assert.equal(hash(original),file==='storage-analytics-canonical-runtime.ts'
      ?'e19db7557085902b0a92cdaa7b15ed12891b933eb65b6a131eae9c60077cd883'
      :'d94704336b7e6e6f03f6529331013371e45921e9c1f2fe40a9f47830c2ccd457');
  }
  const manifest=adapter.completeManifest();
  assert.equal(manifest.files.length,2);
  assert.deepEqual(manifest.files.map(row=>row.anchors.length),[8,1]);
  assert.equal(manifest.boundary.includes('No C06 certificate'),true);
});

test('shared extension keeps nine original boundaries and pins every extra readiness, owner and completion boundary',async()=>{
  const {createAnalyticsC06SharedScopeTransform}=await import('./analytics-workload-c06-scope-transform.mjs');
  const adapter=createAnalyticsC06SharedScopeTransform({lane:'candidate'});
  const clock=createAnalyticsWorkloadPublicationClockTransform({profile:'current',lane:'candidate'});
  for(const file of paths){
    const original=await readFile(new URL('src/'+file,worker),'utf8'),path='apps/worker/src/'+file;
    const prior=clock.sourcePaths.includes(path)?clock.transformSource({path,contents:original}).contents:original;
    const changed=adapter.transformSource({path,contents:prior,originalContents:original});
    await transform(changed.contents,{loader:'ts',format:'esm',target:'es2022'});
    if(file==='storage-analytics-canonical-runtime.ts'){
      assert.equal(changed.contents.includes("requireAuthorityRestoreServingReady(c06ScopeSource(source,'scheduler_prelude'))"),true);
      assert.equal(changed.contents.includes("effectiveSelectiveSchemaAvailable(c06ScopeSource(source,'scheduler_prelude'))"),true);
      assert.equal(changed.contents.includes("readStorageCommunityOwner(c06ScopeSource(budget.meter.wrap(source),'scheduler_graph_owner')"),true);
      assert.equal(changed.contents.includes("const start=input.invocation.queriesUsed,source=input.invocation.wrap(input.source)"),true);
    }else{
      const start=changed.contents.indexOf("if(block.state!=='unsupported')"),callback=changed.contents.indexOf("if(block.state==='complete')c06ObserveBlockCompletion(");
      assert.ok(start>=0&&callback>start);
      const beforeCallback=changed.contents.slice(start,callback);
      assert.ok(beforeCallback.includes("if(block.state==='complete')await options.assertCurrent?.();"));
      assert.ok(beforeCallback.includes('completeStorageGraphWorkSelection({target:options.target,selection,claimToken})'));
      assert.ok(beforeCallback.includes("if(finished.status!=='completed')return {state:'deferred'"));
      assert.ok(beforeCallback.includes('selection=null;'));
      assert.equal(changed.contents.slice(callback).startsWith("if(block.state==='complete')c06ObserveBlockCompletion({state:'complete',reused:block.reused===true,metric,day,adoptedDates:block.adoptedDates,queriesUsed:block.queriesUsed});"),true);
    }
    assert.equal(await readFile(new URL('src/'+file,worker),'utf8'),original);
  }
  const manifest=adapter.completeManifest();
  assert.equal(manifest.schemaVersion,'analytics-c06-shared-scope-transform-v2');
  assert.deepEqual(manifest.originalNineBoundaries.files.map(row=>row.anchors.length),[8,1]);
  assert.deepEqual(manifest.files.map(row=>row.anchors.length),[3,1]);
  assert.throws(()=>adapter.transformSource({path:'apps/worker/src/'+paths[0]}),/C06_SHARED_SCOPE_SEALED/);
});

test('shared extra anchors refuse missing, duplicate and incomplete source without changing the v1 adapter',async()=>{
  const {createAnalyticsC06SharedScopeTransform}=await import('./analytics-workload-c06-scope-transform.mjs');
  const original=await readFile(new URL('src/'+paths[0],worker),'utf8'),path='apps/worker/src/'+paths[0];
  const anchor='await requireAuthorityRestoreServingReady(source);';
  for(const contents of [original.replace(anchor,'missing'),original+'\n'+anchor]){
    const adapter=createAnalyticsC06SharedScopeTransform({lane:'candidate'});
    assert.throws(()=>adapter.transformSource({path,contents,originalContents:original}),/C06_SHARED_SCOPE_ANCHOR_DRIFT_source_readiness/);
    assert.throws(()=>adapter.completeManifest(),/C06_SHARED_SCOPE_MANIFEST_INCOMPLETE/);
  }
  assert.throws(()=>createAnalyticsC06SharedScopeTransform({lane:'reference'}),/C06_SCOPE_LANE/);
});

test('block completion bridge is cold inert, closed, synchronous, bounded and preserves callback failures',async()=>{
  const {createAnalyticsC06SharedScopeTransform}=await import('./analytics-workload-c06-scope-transform.mjs');
  const adapter=createAnalyticsC06SharedScopeTransform({lane:'candidate'});
  const bridge=await import('data:text/javascript;base64,'+Buffer.from(adapter.moduleSource).toString('base64'));
  bridge.c06ObserveBlockCompletion({invalid:true});
  assert.throws(()=>bridge.installAnalyticsC06BlockCompletion({}),/C06_BLOCK_COMPLETION_INSTALL_INVALID/);
  const events=[],value={state:'complete',reused:false,metric:'model',day:'2026-10-01',adoptedDates:32,queriesUsed:950};
  bridge.installAnalyticsC06BlockCompletion(event=>{assert.equal(Object.isFrozen(event),true);events.push(event);});
  bridge.c06ObserveBlockCompletion(value);bridge.c06ObserveBlockCompletion({...value,reused:true,adoptedDates:0});
  assert.deepEqual(events,[value,{...value,reused:true,adoptedDates:0}]);
  for(const invalid of [{...value,state:'deferred'},{...value,reused:undefined},{...value,metric:'fits'},
    {...value,day:'2026-02-30'},{...value,adoptedDates:33},{...value,queriesUsed:951},{...value,ownerDigest:'secret'}])
    assert.throws(()=>bridge.c06ObserveBlockCompletion(invalid),/C06_BLOCK_COMPLETION_CONTRACT/);
  const refusal=new Error('retained callback refusal');bridge.installAnalyticsC06BlockCompletion(()=>{throw refusal;});
  assert.throws(()=>bridge.c06ObserveBlockCompletion(value),error=>error===refusal);
  bridge.installAnalyticsC06BlockCompletion(()=>Promise.resolve());
  assert.throws(()=>bridge.c06ObserveBlockCompletion(value),/C06_BLOCK_COMPLETION_ASYNC_OR_RESULT/);
  bridge.installAnalyticsC06BlockCompletion(()=>{});
  for(let index=0;index<20000;index++)bridge.c06ObserveBlockCompletion(value);
  assert.throws(()=>bridge.c06ObserveBlockCompletion(value),/C06_BLOCK_COMPLETION_CONTRACT/);
  bridge.installAnalyticsC06BlockCompletion(null);bridge.c06ObserveBlockCompletion({invalid:true});
});

test('precise prelude remains an unclassified consumer and never broadens shared default tagging',async()=>{
  const source=await readFile(new URL('test/helpers/analytics-c06-operation-scope.ts',worker),'utf8');
  const compiled=await transform(source,{loader:'ts',format:'esm',target:'es2022'});
  const helper=await import('data:text/javascript;base64,'+Buffer.from(compiled.code).toString('base64'));
  assert.ok(helper.C06_OPERATION_SCOPES.includes('scheduler_prelude'));
  assert.equal(helper.c06ScopeConsumer('scheduler_prelude'),'unclassified');
  assert.equal(helper.c06ScopeConsumer('scheduler_shared'),'unclassified');
  assert.equal(helper.c06ScopeConsumer('scheduler_graph_owner'),'unclassified');
  assert.equal(helper.c06ScopeConsumer('candidate_model_block'),'block');
});

test('drift, duplicate/missing anchors and incomplete manifest refuse',async()=>{
  const file=paths[0],path='apps/worker/src/'+file;
  const original=await readFile(new URL('src/'+file,worker),'utf8');
  const adapter=createAnalyticsC06ScopeTransform({lane:'candidate'});
  assert.throws(()=>adapter.transformSource({path,contents:original,originalContents:original+' '}),/C06_SCOPE_SOURCE_DRIFT/);
  const anchor='advanceEffectiveDependencyCoverage(source,{sourceId:';
  assert.throws(()=>adapter.transformSource({path,contents:original.replace(anchor,'missing'),originalContents:original}),/C06_SCOPE_ANCHOR_DRIFT_coverage/);
  assert.throws(()=>adapter.transformSource({path,contents:original+anchor,originalContents:original}),/C06_SCOPE_ANCHOR_DRIFT_coverage/);
  adapter.transformSource({path,contents:original,originalContents:original});
  assert.throws(()=>adapter.completeManifest(),/C06_SCOPE_MANIFEST_INCOMPLETE/);
  assert.throws(()=>createAnalyticsC06ScopeTransform({lane:'reference'}),/C06_SCOPE_LANE/);
});

test('bundle bridge is cold-inert and injects one reviewed facade function',async()=>{
  const adapter=createAnalyticsC06ScopeTransform({lane:'candidate'});
  const bridge=await import('data:text/javascript;base64,'+Buffer.from(adapter.moduleSource).toString('base64'));
  const database={prepare:()=>null};
  assert.equal(bridge.c06ScopeSource(database,'scheduler_cache'),database);
  assert.equal(bridge.c06ScopeForPartitionStage('features'),'scheduler_features');
  assert.throws(()=>bridge.c06ScopeForPartitionStage('foreign'),/C06_SCOPE_STAGE_UNKNOWN/);
  assert.throws(()=>bridge.installAnalyticsC06ScopeSource({}),/C06_SCOPE_INSTALL_INVALID/);
  const calls=[];
  bridge.installAnalyticsC06ScopeSource((db,scope)=>{calls.push(scope);return db;});
  assert.equal(bridge.c06ScopeSource(database,'candidate_model_block'),database);
  assert.deepEqual(calls,['candidate_model_block']);
  bridge.installAnalyticsC06ScopeSource(null);
  assert.equal(bridge.c06ScopeSource(database,'scheduler_cache'),database);
});

test('fixed facades tag exact metered statements, preserve binds/batches and nested override',async()=>{
  const source=await readFile(new URL('test/helpers/analytics-c06-operation-scope.ts',worker),'utf8');
  const compiled=await transform(source,{loader:'ts',format:'esm',target:'es2022'});
  const helper=await import('data:text/javascript;base64,'+Buffer.from(compiled.code).toString('base64'));
  const {C06_DATABASE_SCOPE,C06_STATEMENT_SCOPE,c06ScopeSource,c06ScopeConsumer}=helper;
  const dispatched=[];let charged=0;
  function statement(sql,args=[],operationScope){
    return {
      [C06_STATEMENT_SCOPE](next){
        if(next!==undefined){
          if(operationScope!==undefined&&operationScope!==next)throw Error('scope collision');
          operationScope=next;
        }
        return operationScope;
      },
      bind(...values){return statement(sql,values,operationScope);},
      async all(){charged++;dispatched.push({sql,args,operationScope});return {results:[],meta:{rows_read:0,rows_written:0}};},
    };
  }
  const base={
    [C06_DATABASE_SCOPE]:true,
    prepare:sql=>statement(sql),
    async batch(items){return Promise.all(items.map(item=>item.all()));},
    withSession(){return this;},
  };
  const outer=c06ScopeSource(base,'direct_model');
  await outer.prepare('SELECT ?').bind(1).all();
  const nested=c06ScopeSource(outer,'candidate_model_block');
  const batch=[nested.prepare('SELECT ?').bind(2),outer.prepare('SELECT ?').bind(3)];
  await nested.batch(batch);
  await nested.withSession().prepare('SELECT ?').bind(4).all();
  assert.equal(charged,4);
  assert.deepEqual(dispatched.map(row=>row.operationScope),[
    'direct_model','candidate_model_block','direct_model','candidate_model_block']);
  assert.deepEqual(dispatched.map(row=>row.args),[[1],[2],[3],[4]]);
  assert.equal(c06ScopeConsumer('candidate_model_block'),'block');
  assert.equal(c06ScopeConsumer('scheduler_coverage'),'unclassified');
  const cold={prepare:()=>statement('SELECT 1')};
  assert.equal(c06ScopeSource(cold,'direct_model'),cold);
  assert.throws(()=>c06ScopeSource(base,'invented'),/C06_OPERATION_SCOPE_INVALID/);
});

test('source census groups each dispatched statement by immutable scope, including mixed batch',async()=>{
  const result=await build({entryPoints:[new URL('test/helpers/analytics-c06-source-lineage.ts',worker).pathname],
    bundle:true,platform:'node',format:'cjs',target:'es2022',write:false,logLevel:'silent',external:['jsonc-parser']});
  const observerModule={exports:{}};
  new Function('require','module','exports',result.outputFiles[0].text)(
    createRequire(import.meta.url),observerModule,observerModule.exports);
  const helperSource=await readFile(new URL('test/helpers/analytics-c06-operation-scope.ts',worker),'utf8');
  const helperJs=await transform(helperSource,{loader:'ts',format:'esm',target:'es2022'});
  const {c06ScopeSource}=await import('data:text/javascript;base64,'+Buffer.from(helperJs.code).toString('base64'));
  let charged=0;
  function statement(sql,args=[]){return {bind:(...values)=>statement(sql,values),
    all:async()=>{charged++;return {results:[{answer:args[0]??1}],meta:{rows_read:1,rows_written:0,duration:0}};}};}
  const database={prepare:sql=>statement(sql),batch:async statements=>Promise.all(statements.map(row=>row.all()))};
  const census=observerModule.exports.c06SourceLineageObserver(database,
    ()=>({consumer:'unclassified',phase:'warm'}),{allowedPhases:['warm']});
  const coverage=c06ScopeSource(census.source,'scheduler_coverage');
  const cache=c06ScopeSource(census.source,'scheduler_cache');
  await coverage.prepare('SELECT ?').bind(1).all();
  await cache.batch([cache.prepare('SELECT ?').bind(2),coverage.prepare('SELECT ?').bind(3)]);
  assert.equal(charged,3);
  const candidates=await census.privateReviewCandidates();
  assert.deepEqual(candidates.map(row=>row.operationScope).sort(),['scheduler_cache','scheduler_coverage']);
  assert.deepEqual(candidates.map(row=>[row.operationScope,row.consumer]).sort((a,b)=>a[0].localeCompare(b[0])),
    [['scheduler_cache','cache'],['scheduler_coverage','unclassified']]);
  assert.equal(candidates.every(row=>row.phase==='warm'),true);
  assert.deepEqual(candidates.map(row=>row.bindClasses.length).sort(),[1,2]);
});
