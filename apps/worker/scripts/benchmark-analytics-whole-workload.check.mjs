import assert from 'node:assert/strict';
import { test } from 'node:test';
import {createHash} from 'node:crypto';
import { NATIVE_REFERENCE_COMMIT, FUNCTIONAL_NATIVE_INPUT_KINDS,C06_RECEIPT_OPERATION_SCOPES,validateC06SourceCensus,validateNativePreviewCounterReceipt,validateFunctionalNativeInputEvidence, parseArguments,assertFunctionalProfileCompatibility,readFunctionalBranchSummary, readWholeWorkloadSummary, readIntegrationDebugSummary,readFunctionalMutationSummary,createRuntimeObservationBridge,createLaneEvidenceBridge,decodeWholeWorkloadValue,mergeFreshLaneEvidence } from './benchmark-analytics-whole-workload.mjs';

test('whole-workload launcher chooses a closed local population and refuses omitted cold work',()=>{
  assert.deepEqual(parseArguments([]),{dates:1,compare:false,upgradeSource:false,phases:['cold','warm','no_op'],output:null,help:false,integrationDebugDays:null,observeRuntime:false,nativeProfile:'optimized',clockGoldens:false,functionalGoldens:false,functionalMutations:false,functionalBranches:[],functionalAccountlessSecondary:false,sourceLineage:false});
  for(const count of [1,30,365])assert.equal(parseArguments(['--dates',String(count)]).dates,count);
  assert.equal(parseArguments(['--compare']).compare,true);
  assert.equal(parseArguments(['--clock-goldens']).clockGoldens,true);
  assert.equal(parseArguments(['--functional-goldens']).functionalGoldens,true);
  const functional=['--functional-mutations','--compare','--upgrade-source','--dates','1','--integration-debug-days','10','--phases','cold,warm,no_op,unrelated_append'];
  assert.equal(parseArguments(functional).functionalMutations,true);
  for(const args of [['--functional-mutations'],[...functional,'--observe-runtime'],functional.map(value=>value==='cold,warm,no_op,unrelated_append'?'cold,warm,no_op,unrelated_append,old_correction':value)])assert.throws(()=>parseArguments(args));
  for(const extra of ['--compare','--clock-goldens','--observe-runtime','--output'])assert.throws(()=>parseArguments(['--functional-goldens',extra]));
  for(const extra of ['--compare','--observe-runtime','--output'])assert.throws(()=>parseArguments(['--clock-goldens',extra]));
  assert.equal(parseArguments(['--native-profile','unshared-diagnostic']).nativeProfile,'unshared-diagnostic');
  assert.throws(()=>parseArguments(['--native-profile','disabled']));
  assert.equal(parseArguments(['--observe-runtime']).observeRuntime,true);
  assert.throws(()=>parseArguments(['--compare','--phases','cold,unrelated_append']));
  assert.equal(parseArguments(['--compare','--upgrade-source']).upgradeSource,true);
  assert.equal(parseArguments(['--compare','--upgrade-source','--integration-debug-days','10']).integrationDebugDays,10);
  assert.deepEqual(parseArguments(['--phases','cold,warm,unrelated_append,old_correction']).phases,
    ['cold','warm','unrelated_append','old_correction']);
  for(const args of [['--remote'],['--integration-debug-days','10'],['--compare','--upgrade-source','--dates','30','--integration-debug-days','30'],['--compare','--upgrade-source','--integration-debug-days','466'],['--upgrade-source'],['--dates','70'],['--dates'],['--compare','--compare'],
    ['--phases','warm'],['--phases','cold,cold'],['--phases','cold,erasure'],['--output','--compare']])
    assert.throws(()=>parseArguments(args));
});
test('baseline receipt refuses partial output, the wrong native revision and qualification overclaims',()=>{
  const summary={schemaVersion:'analytics-whole-workload-v1',referenceCommit:NATIVE_REFERENCE_COMMIT,
    wholeWorkloadQualification:false,pendingCases:['erasure'],outputDates:1,phases:{cold:{
      reference:{measurementFailures:0,failedStatements:0,metadataSamples:3,statements:3},
      output:{sha256:'a'.repeat(64),completed:{dailyDays:1,currentScalarOwners:2,historicalOwnerModelResults:2,
        nativePublishedModelDates:1,cacheOwnerDays:2,preview:1,cacheSeries:1},
        familySha256:Object.fromEntries(['cacheDays','cacheSeries','currentScalar','daily','modelPublications','ownerModels','preview'].map(key=>[key,'a'.repeat(64)]))}}}};
  const line=value=>'analytics-whole-workload '+JSON.stringify(value);
  assert.deepEqual(readWholeWorkloadSummary(line(summary)),summary);
  const current=structuredClone(summary);current.schemaVersion='analytics-whole-workload-native-diagnostic-v2';current.phases.cold.output.completed.publishedDailyOutcomes=8;current.phases.cold.output.familySha256.publishedDaily='b'.repeat(64);
  assert.deepEqual(readWholeWorkloadSummary(line(current)),current);
  current.phases.cold.output.completed.publishedDailyOutcomes=1;assert.throws(()=>readWholeWorkloadSummary(line(current)));
  for(const value of [{...summary,wholeWorkloadQualification:true},{...summary,referenceCommit:'other'},
    {...summary,schemaVersion:'other'},{...summary,pendingCases:undefined},{...summary,phases:{cold:{}}}])
    assert.throws(()=>readWholeWorkloadSummary(line(value)));
  assert.throws(()=>readWholeWorkloadSummary(line(summary)+'\n'+line(summary)));
  assert.throws(()=>readWholeWorkloadSummary('incomplete run'));
});

function integratedSummary({debug=false,dates=1}={}) {
  const anchor=Date.parse('2026-10-01T12:00:00.000Z'),midnight=Date.parse('2026-10-01T00:00:00.000Z');
  const before=offset=>new Date(midnight-offset*86_400_000).toISOString().slice(0,10);
  const requested=Array.from({length:dates},(_,index)=>before(dates-index));
  const retained=Array.from({length:70},(_,index)=>before(69-index));
  const calculated=[...new Set([...requested,...retained])].sort(),modelResults=2*calculated.length;
  const inventories=lane=>Object.fromEntries(['initial','before_cleanup','after_cleanup'].map(label=>[label,Object.fromEntries([['source',13],['target',127],['ledger',3]].map(([side,count])=>[side,{schemaVersion:'analytics-logical-stores-v1',side,complete:true,rows:0,rowBytes:0,payloadBytes:0,tables:Object.fromEntries(Array.from({length:count},(_,index)=>['table'+index,{present:side!=='source'||index<(lane==='reference'?2:13),rows:0,rowBytes:0,payloadBytes:0}]))}]))]));
  const profile={logicalStoreSnapshots:inventories('reference'),logicalSubmissionInventoryComplete:true,roleFailurePolicy:'record-and-bound-output-retries-v1',scheduledLaneFailures:[],unexpectedCandidateRoleFailures:0,measurementFailures:0,failedStatements:0,metadataSamples:3,statements:3,maximumStatementsPerInvocation:3,phaseStatements:{analytics_role:1,cache_role:1,publication_role:1,logical_inventory:145}};
  const prerequisites=Array.from({length:(debug?10:466)+7},(_,index)=>before((debug?10:466)+6-index));
  const population={dailyPublicationInventory:prerequisites.map(day=>({day,stored:[],visibleRevisions:[],publicDtoSha256:'a'.repeat(64)})),dailyPublications:{days:1,revisions:1,first_day:before(1),last_day:before(1),dates:[before(1)]},prerequisiteDailyDates:prerequisites,checkedAfterCleanup:true,graphInventorySha256:'b'.repeat(64),graphResults:142,
    modelOwnerResults:140,modelDates:70,calculatedModelOwnerResults:modelResults,calculatedModelDates:calculated.length,
    retiredCalculationDates:Math.max(0,dates-69),currentFitOwners:2,modelPublicationDates:70,
    modelOutcomeCounts:{ready:2,insufficient_data:modelResults-2}};
  return {schemaVersion:debug?'analytics-integration-debug-v5':'analytics-whole-workload-v6',referenceCommit:NATIVE_REFERENCE_COMMIT,
    publicationTimestampContract:'strict-common-analytical-clock-v1: no normalization',
    optimizationProfiles:Object.fromEntries([['reference','native'],['candidate','canonical']].map(([lane,representation])=>[lane,{representation,nativeProfile:'optimized',canonicalPipeline:lane==='candidate',sharedFeatures:true,cacheSharedFeatures:true,modelBlocks:true,preparedFold:true,preparedEffectiveUsage:'native-default',performanceBasis:'existing-native-optimizations-v1'}])),
    independentLaneExecution:{basis:'fresh-worker-per-lane-host-exact-dto-v1',seedDisposedBeforeLanes:true,firstLaneDisposedBeforePeer:true,exits:['seed','candidate','reference'].map(lane=>({lane,code:0,signal:null}))},sourceSchema:'separate_native_pinned_candidate_upgraded',sourceIsolation:'accepted-native-logical-snapshot-v1: synthetic',sourceSnapshot:{schemaVersion:'analytics-source-snapshot-v1',exactSchemaAndData:true,exactRowids:true,sqlSha256:'a'.repeat(64),schemaSha256:'b'.repeat(64),rowidInventorySha256:'c'.repeat(64),exportResourceMetadata:null,physicalSnapshotBytes:null,importAndProof:Object.fromEntries(['reference','candidate'].map(lane=>[lane,{measurementFailures:0,failedStatements:0,metadataSamples:1,statements:1}]))},
    roleFailurePolicy:'record-and-bound-output-retries-v1',roleComposition:'actual-three-role-schedules-v1',integrationDebug:debug,wholeWorkloadQualification:false,pendingCases:['erasure'],outputDates:dates,cachePopulationDays:debug?10:466,
    sharedUniqueHistoryCalendarDays:debug?10:466,analyticalNowMs:anchor,nativePublicModelWindowDays:70,
    graphPopulation:{requestedDates:requested,retainedModelDates:retained,calculatedModelDates:calculated,
      extraRequestedDates:requested.filter(day=>!retained.includes(day)),maintainedOnlyDates:retained.filter(day=>!requested.includes(day))},
    comparisonBasis:debug?'small-fresh-worker-retained-graph-cache-and-ordered-delivery-debug-v5':'fresh-worker-retained-graph-cache-and-ordered-delivery-v6',
    phases:{cold:{reference:profile,candidate:{...structuredClone(profile),logicalStoreSnapshots:inventories('candidate')},actualStoredPopulation:{reference:population,candidate:structuredClone(population)},
      output:{parity:'exact',sha256:'a'.repeat(64),completed:{dailyDays:dates,publishedDailyOutcomes:prerequisites.length,currentScalarOwners:2,calculatedOwnerModelResults:modelResults,
        requestedOwnerModelResults:2*dates,maintainedOwnerModelResults:140,nativePublishedModelDates:70,cacheOwnerDays:debug?20:932,preview:1,cacheSeries:1},
        familySha256:Object.fromEntries(['cacheDays','cacheSeries','currentScalar','daily','modelPublications','ownerModels','preview','publishedDaily'].map(key=>[key,'a'.repeat(64)]))}}}};
}
test('integrated receipt requires the complete retained graph/cache population and measured candidate',()=>{
  const summary=integratedSummary(),read=value=>readWholeWorkloadSummary('analytics-whole-workload '+JSON.stringify(value));
  assert.deepEqual(read(summary),summary);
  for(const mutation of [
    value=>{value.schemaVersion='analytics-whole-workload-v2';},
    value=>{value.runtimeObservationEnabled=true;},
    value=>{value.publicationTimestampContract='normalize-publication-times';},
    value=>{value.optimizationProfiles.reference.sharedFeatures=false;},
    value=>{value.optimizationProfiles.reference.preparedEffectiveUsage=false;},
    value=>{value.phases.cold.actualStoredPopulation.candidate.prerequisiteDailyDates.pop();},
    value=>{value.phases.cold.actualStoredPopulation.reference.prerequisiteDailyDates.pop();value.phases.cold.actualStoredPopulation.candidate.prerequisiteDailyDates.pop();},
    value=>{value.phases.cold.actualStoredPopulation.candidate.dailyPublicationInventory[0].publicDtoSha256='b'.repeat(64);},
    value=>{value.phases.cold.actualStoredPopulation.candidate.dailyPublications.dates.push('2026-09-29');},
    value=>{delete value.phases.cold.output.familySha256.publishedDaily;},
    value=>{value.phases.cold.output.completed.publishedDailyOutcomes--;},
    value=>{value.sourceSnapshot.exactRowids=false;},
    value=>{value.sourceSnapshot.exportResourceMetadata={rowsRead:0};},
    value=>{delete value.phases.cold.candidate.logicalStoreSnapshots.after_cleanup;},
    value=>{value.phases.cold.candidate.logicalSubmissionInventoryComplete=false;},
    value=>{value.cachePopulationDays=1;},
    value=>{value.roleComposition='all-stages-single-meter';},
    value=>{value.phases.cold.candidate.phaseStatements.cache_role=0;},
    value=>{value.phases.cold.candidate=null;},
    value=>{value.roleFailurePolicy='ignore-errors';},
    value=>{value.phases.cold.candidate.unexpectedCandidateRoleFailures=1;},
    value=>{value.phases.cold.candidate.scheduledLaneFailures=[{role:'publication'}];},
    value=>{value.phases.cold.candidate.failedStatements=1;},
    value=>{value.phases.cold.candidate.maximumStatementsPerInvocation=951;},
    value=>{value.phases.cold.output.parity='baseline_only';},
    value=>{value.graphPopulation.retainedModelDates.pop();},
    value=>{value.phases.cold.output.completed.calculatedOwnerModelResults=2;},
    value=>{value.phases.cold.output.completed.nativePublishedModelDates=69;},
    value=>{value.phases.cold.actualStoredPopulation.candidate.graphResults++;},
    value=>{value.phases.cold.actualStoredPopulation.candidate.graphInventorySha256='c'.repeat(64);},
    value=>{value.phases.cold.actualStoredPopulation.candidate.modelOutcomeCounts.insufficient_data--;},
    value=>{value.phases.cold.actualStoredPopulation.candidate.checkedAfterCleanup=false;},
  ]) {const value=structuredClone(summary);mutation(value);assert.throws(()=>read(value));}
});
test('persistent functional receipt requires exact store continuity, native proof, full population and genuine effects',()=>{
  const scenario=kind=>{
    const value=integratedSummary({debug:true});
    value.schemaVersion='analytics-persistent-mutation-functional-v1';
    value.comparisonBasis='persistent-independent-physical-stores-shared-isolate-functional-v1';
    value.runtimeObservationEnabled=false;
    delete value.independentLaneExecution;
    value.functionalMutationExecution={basis:'persistent-independent-physical-stores-shared-isolate-v1',physicalSources:2,physicalTargets:2,physicalLedgers:2,storesRetainedAcrossAllPhases:true,postColdSourceReplacements:0,comparativeHeapQualification:false,freshIsolateMutationQualification:false,proofContract:'native-existing-owner-v2',clockPolicy:'native-v11-trigger-clocks-v1'};
    for(const phase of ['warm','no_op',kind])value.phases[phase]=structuredClone(value.phases.cold);
    for(const phase of ['no_op',kind]){
      const cost={statements:5,metadataSamples:5,measurementFailures:0,failedStatements:0,maximumStatementsPerInvocation:5};
      value.phases[phase].mutationProof={storesReplaced:false,physicalStoresRetained:true,
        proof:{schemaVersion:'analytics-mutation-proof-v2',comparisonContract:'native-existing-owner-v2',clockPolicy:'native-v11-trigger-clocks-v1',kind:phase,verifiedNativeBranch:phase,verified:{newEvents:phase==='no_op'?0:1},rawSnapshotSha256:{before:{reference:'a'.repeat(64),candidate:'b'.repeat(64)},after:{reference:'c'.repeat(64),candidate:'d'.repeat(64)}}},
        paired:{divergences:0,physicalFailures:0},admission:{reference:cost,candidate:cost},delivery:{reference:cost,candidate:cost},
        snapshots:Object.fromEntries(['reference','candidate'].map(lane=>[lane,{before:{sha256:(lane==='reference'?'a':'b').repeat(64),measurement:cost},after:{sha256:(lane==='reference'?'c':'d').repeat(64),measurement:cost}}]))};
      value.phases[phase].mutationEffects=phase==='no_op'?{kind:phase,allFamiliesUnchanged:true}:{kind:phase,affectedDays:1,affectedCacheEventsBefore:1,affectedCacheEventsAfter:2,affectedAggregateChanged:true,appendOutsideRequestedDays:kind==='unrelated_append',requestedDailyUnchanged:true};
    }
    return value;
  };
  const read=value=>readFunctionalMutationSummary('analytics-functional-mutations '+JSON.stringify(value));
  for(const kind of ['unrelated_append','old_correction'])assert.deepEqual(read(scenario(kind)),scenario(kind));
  for(const mutate of [
    v=>{v.functionalMutationExecution.postColdSourceReplacements=1;},
    v=>{v.functionalMutationExecution.storesRetainedAcrossAllPhases=false;},
    v=>{v.functionalMutationExecution.comparativeHeapQualification=true;},
    v=>{v.runtimeObservationEnabled=true;},
    v=>{v.phases.unrelated_append.mutationProof.proof.verifiedNativeBranch='metadata_change';},
    v=>{v.phases.unrelated_append.mutationProof.paired.divergences=1;},
    v=>{v.phases.unrelated_append.mutationProof.proof.rawSnapshotSha256.after.candidate='e'.repeat(64);},
    v=>{delete v.phases.unrelated_append.mutationProof.delivery.reference.maximumStatementsPerInvocation;},
    v=>{v.phases.unrelated_append.mutationProof.delivery.candidate.maximumStatementsPerInvocation=951;},
    v=>{v.phases.unrelated_append.mutationProof.snapshots.reference.after.measurement.metadataSamples=0;},
    v=>{v.phases.unrelated_append.mutationEffects.affectedCacheEventsAfter=1;},
    v=>{v.phases.unrelated_append.mutationEffects.requestedDailyUnchanged=false;},
    v=>{v.phases.no_op.mutationEffects.allFamiliesUnchanged=false;},
    v=>{v.phases.unrelated_append.output.completed.nativePublishedModelDates=69;},
    v=>{delete v.phases.unrelated_append.output.familySha256.publishedDaily;},
    v=>{v.phases.unrelated_append.output.parity='baseline_only';},
  ]){const value=scenario('unrelated_append');mutate(value);assert.throws(()=>read(value));}
  assert.throws(()=>readIntegrationDebugSummary('analytics-integration-debug '+JSON.stringify(scenario('unrelated_append'))));
});
test('365 requested calculations include 366 union dates but publish only 70 native dates',()=>{
  const summary=integratedSummary({dates:365});
  const read=value=>readWholeWorkloadSummary('analytics-whole-workload '+JSON.stringify(value));
  assert.deepEqual(read(summary),summary);
  assert.equal(summary.graphPopulation.calculatedModelDates.length,366);
  assert.equal(summary.graphPopulation.extraRequestedDates.length,296);
  const extended=structuredClone(summary);extended.phases.cold.output.completed.nativePublishedModelDates=366;
  assert.throws(()=>read(extended));
  const retained=structuredClone(summary);retained.phases.cold.actualStoredPopulation.candidate.modelOwnerResults=732;
  assert.throws(()=>read(retained));
});
test('small integration debugging cannot be relabeled as a whole-workload receipt',()=>{
  const summary=integratedSummary({debug:true});
  const read=value=>readIntegrationDebugSummary('analytics-integration-debug '+JSON.stringify(value));
  assert.deepEqual(read(summary),summary);
  assert.throws(()=>readWholeWorkloadSummary('analytics-integration-debug '+JSON.stringify(summary)));
  assert.throws(()=>readWholeWorkloadSummary('analytics-whole-workload '+JSON.stringify({...summary,schemaVersion:'analytics-whole-workload-v6'})));
  for(const value of [{...summary,integrationDebug:false},{...summary,sharedUniqueHistoryCalendarDays:466},
    {...summary,cachePopulationDays:466},{...summary,wholeWorkloadQualification:true}])assert.throws(()=>read(value));
});

test('observed native scheduler faults retain evidence while unexpected candidate faults block a completed receipt',()=>{
  const summary=integratedSummary();
  summary.phases.cold.reference.scheduledLaneFailures=[{role:'publication',lane:'daily_publish',phase:'daily_publish',reason:'application',detail:'02b46568',invocation:1,queriesUsed:1}];
  summary.phases.cold.reference.unexpectedCandidateRoleFailures=null;
  const read=value=>readWholeWorkloadSummary('analytics-whole-workload '+JSON.stringify(value));
  assert.deepEqual(read(summary),summary);
  summary.phases.cold.candidate.scheduledLaneFailures=structuredClone(summary.phases.cold.reference.scheduledLaneFailures);
  assert.throws(()=>read(summary));
});

test('runtime barrier waits for ACKs, preserves diagnostic limits and closes its loopback endpoint',async()=>{
  const calls=[],token={};
  const bridge=await createRuntimeObservationBridge({inspectorUrl:'http://127.0.0.1:1234',expectedTargetId:'core:user:vitest-pool-workers-runner-p11-observed',observerFactory:async()=>({
    startPhase:async input=>{calls.push(['start',input.lane,input.phase]);return token;},
    sampleHeap:async({label})=>{calls.push(['heap',label]);},
    stopPhase:async value=>{assert.equal(value,token);calls.push(['stop']);return {exactCpuMs:null,billedCpuMs:null};},
    close:async()=>{calls.push(['close']);}})});
  const post=kind=>fetch(bridge.url,{method:'POST',body:JSON.stringify({kind,lane:'candidate',phase:'cold'})});
  try {
    const start=await post('start');assert.equal(start.headers.get('connection'),'close');
    assert.equal((await start.json()).acknowledged,true);
    const stopped=await (await post('stop')).json();
    assert.equal(stopped.requestSequence,2);assert.equal(stopped.segmentSequence,1);
    assert.equal(stopped.observation.comparativeHeapQualification,false);
    assert.equal(stopped.observation.basis,'shared-vitest-isolate-phase-diagnostic-v1');
    assert.ok(stopped.observation.controllerBarrierWallMs.start>=0);
    assert.equal(stopped.observation.result.billedCpuMs,null);
    assert.equal((await post('stop')).status,500);
    assert.equal(bridge.observations.at(-1).status,'unavailable');
  } finally {await bridge.close();}
  assert.deepEqual(calls,[['start','candidate','cold'],['heap','start'],['heap','end'],['stop'],['close']]);
  assert.equal(bridge.transport.connectionPolicy,'close-after-each-barrier');
  assert.deepEqual(bridge.transport.events.filter(row=>row.event==='admitted').map(row=>row.requestSequence),[1,2,3]);
  assert.equal(bridge.transport.events.filter(row=>row.event==='response_finish').length,3);
  assert.equal(bridge.transport.events.filter(row=>row.event==='response_close').length,3);
  assert.equal(bridge.transport.droppedEvents,0);
  assert.ok(bridge.transport.events.every(row=>Object.keys(row).sort().join(',')==='event,requestSequence,segmentSequence,wallMs'));
  await assert.rejects(fetch(bridge.url));
});
test('runtime capability errors remain explicit unavailable observations',async()=>{
  const bridge=await createRuntimeObservationBridge({inspectorUrl:'http://127.0.0.1:1234',expectedTargetId:'core:user:vitest-pool-workers-runner-p11-observed',observerFactory:async()=>{throw Error('synthetic unsupported');}});
  try {
    const result=await fetch(bridge.url,{method:'POST',body:JSON.stringify({kind:'start',lane:'reference',phase:'cold'})});
    assert.equal(result.status,500);assert.equal(bridge.observations.length,1);
    assert.equal(bridge.observations[0].cpuMs,null);assert.equal(bridge.observations[0].comparativeHeapQualification,false);
  } finally {await bridge.close();}
});

test('separate lane controller holds accepted input privately and refuses overlap or duplicate evidence',async()=>{
 const bridge=await createLaneEvidenceBridge();
 const send=message=>fetch(bridge.url,{method:'POST',body:JSON.stringify(message)});
 try {
  assert.throws(()=>bridge.begin('candidate'));
  bridge.begin('seed');assert.throws(()=>bridge.begin('candidate'));
  assert.equal((await send({lane:'candidate',kind:'read_seed'})).status,400);
  const seed={transfer:{schemaVersion:'analytics-accepted-source-transfer-v1',statements:['synthetic only']}};
  assert.equal((await send({lane:'seed',kind:'write_seed',seed})).status,200);
  assert.equal((await send({lane:'seed',kind:'write_seed',seed})).status,400);
  bridge.end('seed',0,null);bridge.begin('candidate');
  assert.deepEqual((await (await send({lane:'candidate',kind:'read_seed'})).json()).seed,seed);
  assert.equal((await send({lane:'candidate',kind:'write_phase',phase:'cold',output:['number',42]})).status,200);
  assert.equal((await send({lane:'candidate',kind:'write_phase',phase:'cold',output:['number',43]})).status,400);
  assert.equal((await send({lane:'candidate',kind:'write_lane',evidence:{completed:false}})).status,400);
  assert.equal((await send({lane:'candidate',kind:'write_lane',evidence:{completed:true}})).status,200);
  assert.deepEqual(bridge.state.lanes.get('candidate').outputs,{cold:['number',42]});
  bridge.end('candidate',0,null);bridge.begin('reference');bridge.end('reference',1,null);
  assert.throws(()=>bridge.begin('reference'));
 } finally {await bridge.close();}
 assert.equal(bridge.state.seed,null);assert.equal(bridge.state.lanes.size,0);await assert.rejects(fetch(bridge.url));
});
test('host complete DTO equality preserves undefined members and negative zero and rejects any arithmetic/proof change',()=>{
 const encoded=['object',[['optional',['undefined']],['zero',['negative_zero']],['value',['number',42]]]];
 assert.deepStrictEqual(decodeWholeWorkloadValue(encoded),{optional:undefined,zero:-0,value:42});
 assert.throws(()=>decodeWholeWorkloadValue(['number',NaN]));
 const summary=integratedSummary(),proof={sqlSha256:'a'.repeat(64),schemaSha256:'b'.repeat(64),rowidInventorySha256:'c'.repeat(64)};
 const seed={transfer:{proof},initialAdmission:{},laboratorySetup:{},snapshotProfile:{}};
 const lane=()=>({completed:true,summary:{...structuredClone(summary),initialAdmission:{reference:{},candidate:{}},laboratorySetup:{reference:{},candidate:{}},sourceSchemaUpgrade:{reference:{},candidate:{}}},snapshotImport:{proof,proofProfile:{}},outputs:{cold:structuredClone(encoded)}});
 const reference=lane(),candidate=lane();reference.summary.phases.cold.inputMutation={reference:{},candidate:{}};candidate.summary.phases.cold.inputMutation={reference:{},candidate:{}};const exits=['seed','candidate','reference'].map(lane=>({lane,code:0,signal:null}));
 const result=mergeFreshLaneEvidence(seed,reference,candidate,exits);assert.equal(result.phases.cold.output.parity,'exact');
 candidate.outputs.cold[1][2][1][1]=43;assert.throws(()=>mergeFreshLaneEvidence(seed,reference,candidate,exits),{message:'complete output mismatch: cold'});
 candidate.outputs.cold=structuredClone(encoded);candidate.snapshotImport.proof={...proof,sqlSha256:'d'.repeat(64)};
 assert.throws(()=>mergeFreshLaneEvidence(seed,reference,candidate,exits),/accepted source identity changed/);
});


test('aborted observer requests retain bounded transport evidence without authorizing a phase or retry',async()=>{
 const {request}=await import('node:http');let starts=0;
 const bridge=await createRuntimeObservationBridge({inspectorUrl:'http://127.0.0.1:1234',expectedTargetId:'closed',observerFactory:async()=>{starts++;throw Error('must not start');}});
 try {
  const req=request(bridge.url,{method:'POST',headers:{'content-length':100}});req.on('error',()=>{});req.write('{');
  for(let index=0;index<100&&!bridge.transport.events.some(row=>row.event==='admitted');index++)await new Promise(resolve=>setTimeout(resolve,1));
  req.destroy();
  for(let index=0;index<100&&!bridge.transport.events.some(row=>row.event==='request_aborted');index++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(starts,0);assert.equal(bridge.transport.events.filter(row=>row.event==='request_aborted').length,1);
  assert.equal(bridge.transport.events.some(row=>row.event==='start_ack'||row.event==='stop_ack'),false);
  assert.ok(bridge.transport.events.every(row=>Object.keys(row).sort().join(',')==='event,requestSequence,segmentSequence,wallMs'));
 }finally{await bridge.close();}
});

test('retained branch CLI is bounded to one complete cold startup and separately named actions',()=>{
 const args=['--functional-branches','no_op,unrelated_append,old_correction,clock_advance,utc_rollover','--compare','--upgrade-source','--integration-debug-days','10','--dates','1','--phases','cold'];
 assert.equal(parseArguments(args).functionalBranches.length,5);
 for(const tail of [['--observe-runtime'],['--functional-mutations']])assert.throws(()=>parseArguments([...args,...tail]));
 for(const branches of ['no_op,no_op','unknown',''])assert.throws(()=>parseArguments(args.map(value=>value==='no_op,unrelated_append,old_correction,clock_advance,utc_rollover'?branches:value)));
 assert.throws(()=>parseArguments(args.map(value=>value==='cold'?'cold,warm':value)));
});
function retainedBranchSummary(){
 const h='a'.repeat(64),t=Date.parse('2026-10-01T12:00:00.000Z'),families=['cacheDays','cacheSeries','currentScalar','daily','modelPublications','ownerModels','preview','publishedDaily'];
 const inventory={checkedAfterCleanup:true,graphInventorySha256:h,dailyPublicationInventorySha256:h,currentFitOwners:2,graphResults:142,modelOwnerResults:140,modelDates:70,modelPublicationDates:70,requestedDailyDates:1,cacheOwnerDaysCompared:20};
 const counter=(cold=false)=>({contract:'native-preview-cas-trace-v1',complete:true,initialRevision:cold?null:1,finalRevision:1,counts:{upsert:cold?1:0,refresh:0,retire:0,unchanged:0,failedWrites:0,unknownWrites:0,mutationAttempts:cold?1:0},gaps:[],initialRowSha256:cold?'74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b':h,finalRowSha256:h,schemaSha256:h,nonCounterColumnsSha256:h,observationCost:{statements:cold?7:4,rowsRead:1,rowsWritten:0,databaseMs:0,wallMs:0,includedInInvocationMeter:true,includedInWorkloadProfile:true},shapes:cold?[{sha256:h,attempts:1}]:[],nativeSqlUnchanged:true,bindsUnchanged:true,callerResultsUnchanged:true});
 const pair=Object.fromEntries(['reference','candidate'].map(lane=>[lane,{outputSha256:h,publicationRowsSha256:h,modelRowsSha256:h,previewRowSha256:h,previewCounterProof:counter(),inventorySha256:h,inventory,familySha256:Object.fromEntries(families.map(f=>[f,h]))}]));
 const basePair=structuredClone(pair);for(const item of Object.values(basePair))item.previewCounterProof=counter(true);
 const proof={sqlSha256:h,schemaSha256:h,rowidInventorySha256:h};
 const keys=['reference.source','reference.target','reference.ledger','candidate.source','candidate.target','candidate.ledger'];
 const captures=Object.fromEntries(keys.map(key=>[key,{proof,exportResourceMetadata:null,physicalSnapshotBytes:null}]));
 const profile={measurementFailures:0,failedStatements:0,statements:20,metadataSamples:20,rowsRead:2,maximumStatementsPerInvocation:20,nativePreviewCounter:{boundary:'lane-entry-after-native-action',startupFullBaseRowMatched:true,receipt:counter()},scheduledLaneFailures:[],unexpectedCandidateRoleFailures:0,publicationTimestampsChecked:74,retainedPublicationClock:{contract:'retained-functional-publication-clock-v1',retainedExactRows:74,newClockRows:0,priorAnalyticalNowMs:t,analyticalNowMs:t+1000}};
 for(const capture of Object.values(captures))capture.profile=profile;
 const inputSha256={reference:h,candidate:h},population={calendarShiftDays:0,requestedDates:['2026-09-30'],cacheDates:Array.from({length:10},(_,i)=>new Date(Date.parse('2026-09-22')+i*86_400_000).toISOString().slice(0,10))};
 const startup={schemaVersion:'analytics-retained-functional-branch-v1',scenario:'clock_advance',outcome:'complete',physicalStores:6,resetCountBeforeScenario:1,importsBeforeScenario:6,postStartImports:0,postStartResets:0,resetResourceMetadata:null,comparativeHeapQualification:false,freshIsolateMutationQualification:false,analyticalNowMs:t+1000,baseAnalyticalNowMs:t,baseInputSha256:inputSha256,
  imports:Object.fromEntries(keys.map(key=>[key,{proof,exactSchemaAndData:true,exactRowids:true,importProfile:profile,proofProfile:profile}])),completion:pair};
 return {schemaVersion:'analytics-retained-functional-branches-v1',referenceCommit:NATIVE_REFERENCE_COMMIT,wholeWorkloadQualification:false,runtimeObservationEnabled:false,sharedIsolate:true,physicalStores:6,outputDates:1,sharedUniqueHistoryCalendarDays:10,analyticalNowMs:t,
  functionalAccountlessSecondary:false,secondaryOwnerKind:'social',previewCounterContract:'native-preview-cas-trace-v1',publicationTimestampContract:'strict-common-analytical-clock-v1: exact',retainedPublicationClockContract:'retained-functional-publication-clock-v1',roleComposition:'actual-three-role-schedules-v1',remainingGates:['owning gate'],sourceSnapshot:{exactSchemaAndData:true,exactRowids:true,...proof},
  optimizationProfiles:Object.fromEntries(['reference','candidate'].map(lane=>[lane,{representation:lane==='candidate'?'canonical':'native',nativeProfile:'optimized',canonicalPipeline:lane==='candidate',sharedFeatures:true,cacheSharedFeatures:true,modelBlocks:true,preparedFold:true,preparedEffectiveUsage:'native-default',performanceBasis:'existing-native-optimizations-v1'}])),
  cold:{reference:{...profile,nativePreviewCounter:{boundary:'cold-null-startup',startupFullBaseRowMatched:false,receipt:counter(true)}},candidate:{...profile,nativePreviewCounter:{boundary:'cold-null-startup',startupFullBaseRowMatched:false,receipt:counter(true)}},output:{parity:'exact',sha256:h}},
  base:{schemaVersion:'analytics-completed-six-store-base-v1',physicalStores:6,analyticalNowMs:t,inputSha256,captures,finalCapture:captures,completed:basePair},
  branches:{clock_advance:{previewActionProof:Object.fromEntries(['reference','candidate'].map(lane=>[lane,{contract:'native-preview-zero-action-writes-v1',previewMutationAttempts:0,unsupportedAttempts:0}])),startup,population,expectedOwnerCount:2,analyticalNowMs:t+1000,profiles:{reference:profile,candidate:profile},action:{kind:'clock_advance',sourceMutation:false}}}};
}
test('retained branch receipts reject reset, incomplete import, wrong population and weak parity',()=>{
 const line=value=>'analytics-functional-branches '+JSON.stringify(value),valid=retainedBranchSummary();
 assert.deepEqual(readFunctionalBranchSummary(line(valid)),valid);
 for(const mutate of [v=>v.branches.clock_advance.startup.postStartImports++,v=>v.branches.clock_advance.startup.imports['candidate.ledger'].exactRowids=false,
  v=>v.base.captures['reference.source'].proof.sqlSha256='bad',v=>v.branches.clock_advance.startup.completion.candidate.outputSha256='b'.repeat(64),
  v=>v.branches.clock_advance.startup.completion.candidate.inventory.modelDates=69,v=>v.branches.clock_advance.profiles.candidate.failedStatements=1,
  v=>v.branches.clock_advance.profiles.candidate.unexpectedCandidateRoleFailures=1,v=>v.branches.clock_advance.profiles.reference.maximumStatementsPerInvocation=951,
  v=>v.branches.clock_advance.startup.completion.reference.familySha256.preview=null,v=>v.branches.clock_advance.action.sourceMutation=true,
  v=>v.branches.clock_advance.population.calendarShiftDays=1,v=>v.wholeWorkloadQualification=true,v=>delete v.base.captures['candidate.target'].profile,v=>delete v.branches.clock_advance.profiles.reference.retainedPublicationClock,v=>v.cold.output.parity='pending',v=>v.sourceSnapshot.exactRowids=false]){
   const value=structuredClone(valid);mutate(value);assert.throws(()=>readFunctionalBranchSummary(line(value)));
 }
 assert.throws(()=>readFunctionalBranchSummary(line(valid)+'\n'+line(valid)));
});

test('native lifecycle branch receipts require costs and actual duplicate/terminal predicates',()=>{
 const value=retainedBranchSummary(),branch=value.branches.clock_advance;delete value.branches.clock_advance;value.branches.duplicate_delivery=branch;
 branch.startup.scenario='duplicate_delivery';branch.effects={allFamiliesUnchanged:true};
 branch.analyticalNowMs=value.analyticalNowMs;branch.startup.analyticalNowMs=value.analyticalNowMs;for(const profile of Object.values(branch.profiles))profile.retainedPublicationClock.analyticalNowMs=value.analyticalNowMs;
 const cost={failedStatements:0,measurementFailures:0,statements:4,metadataSamples:4,maximumStatementsPerInvocation:4,rowsWritten:0};
 const proof={outcome:'already-applied',projectionCalls:0,deliveredBefore:2,deliveredAfter:2};
 branch.action={evidence:{schemaVersion:'analytics-native-functional-episode-v1',kind:'duplicate_delivery',postStartImports:0,postStartResets:0,clockOverrides:0,costs:{reference:cost,candidate:cost},proof:{reference:proof,candidate:proof}}};
 const line=v=>'analytics-functional-branches '+JSON.stringify(v);assert.deepEqual(readFunctionalBranchSummary(line(value)),value);
 for(const mutate of [v=>v.branches.duplicate_delivery.action.evidence.costs.reference.rowsWritten=1,v=>v.branches.duplicate_delivery.action.evidence.proof.candidate.projectionCalls=1,
  v=>v.branches.duplicate_delivery.action.evidence.proof.reference.deliveredAfter=3,v=>delete v.branches.duplicate_delivery.action.evidence.costs.candidate]){
  const bad=structuredClone(value);mutate(bad);assert.throws(()=>readFunctionalBranchSummary(line(bad)));
 }
});


test('accountless startup is explicit, required for withdrawal and retained in the closed receipt',()=>{
 const args=['--functional-branches','device_revocation,withdrawal','--compare','--upgrade-source','--integration-debug-days','10','--dates','1','--phases','cold'];
 assert.throws(()=>parseArguments(args),/requires genuine accountless/);
 assert.equal(parseArguments([...args,'--functional-accountless-secondary']).functionalAccountlessSecondary,true);
 assert.throws(()=>parseArguments(['--functional-accountless-secondary']));
 const value=retainedBranchSummary(),line=v=>'analytics-functional-branches '+JSON.stringify(v);
 value.functionalAccountlessSecondary=true;value.secondaryOwnerKind='accountless';assert.deepEqual(readFunctionalBranchSummary(line(value)),value);
 for(const mutate of [v=>{delete v.functionalAccountlessSecondary;},v=>{v.secondaryOwnerKind='social';},v=>{v.functionalAccountlessSecondary='true';}]){
  const wrong=structuredClone(value);mutate(wrong);assert.throws(()=>readFunctionalBranchSummary(line(wrong)));
 }
});

test('unsupported functional SQL histogram phases fail before runtime without disabling accounting',()=>{
 for(const scenario of ['clock_advance','utc_rollover','device_revocation','opt_out_retained']){
  const options={functionalBranches:[scenario]};
  assert.throws(()=>assertFunctionalProfileCompatibility(options,{VITE_WHOLE_WORKLOAD_SQL_PROFILE:'enabled'}),/histogram phase is unsupported/);
  assert.doesNotThrow(()=>assertFunctionalProfileCompatibility(options,{}));
 }
 for(const scenario of ['no_op','unrelated_append','old_correction','duplicate_delivery','interruption','withdrawal','physical_erasure'])
  assert.doesNotThrow(()=>assertFunctionalProfileCompatibility({functionalBranches:[scenario]},{VITE_WHOLE_WORKLOAD_SQL_PROFILE:'enabled'}));
});

test('device revocation and accountless withdrawal receipts require their distinct native boundaries',()=>{
 const cost={failedStatements:0,measurementFailures:0,statements:8,metadataSamples:8,maximumStatementsPerInvocation:8,rowsWritten:4};
 for(const kind of ['device_revocation','withdrawal']){
  const value=retainedBranchSummary(),branch=value.branches.clock_advance;delete value.branches.clock_advance;value.branches[kind]=branch;
  value.functionalAccountlessSecondary=kind==='withdrawal';value.secondaryOwnerKind=kind==='withdrawal'?'accountless':'social';
  branch.startup.scenario=kind;branch.analyticalNowMs=value.analyticalNowMs;branch.startup.analyticalNowMs=value.analyticalNowMs;
  for(const profile of Object.values(branch.profiles))profile.retainedPublicationClock.analyticalNowMs=value.analyticalNowMs;
  const proof=kind==='device_revocation'?{devicesRevoked:3,ownerState:'active',survivingOwners:2,historyRetained:true}
   :{enrollmentRevoked:true,ownerState:'withdrawn',survivingOwners:1,nativeTerminalChange:true,acceptedRowsRetained:1};
  if(kind==='withdrawal'){
   branch.startup.completion=structuredClone(branch.startup.completion);
   branch.expectedOwnerCount=1;
   for(const lane of ['reference','candidate'])branch.startup.completion[lane]={...branch.startup.completion[lane],inventory:{...branch.startup.completion[lane].inventory,currentFitOwners:1,graphResults:71,modelOwnerResults:70,cacheOwnerDaysCompared:10}};
  }else branch.effects={allFamiliesUnchanged:true};
  branch.action={evidence:{schemaVersion:'analytics-native-functional-episode-v1',kind,postStartImports:0,postStartResets:0,clockOverrides:0,costs:{reference:cost,candidate:cost},proof:{reference:proof,candidate:proof}}};
  const line=v=>'analytics-functional-branches '+JSON.stringify(v);assert.deepEqual(readFunctionalBranchSummary(line(value)),value);
  for(const mutate of [v=>{v.branches[kind].action.evidence.proof.candidate.ownerState='erased';},v=>{v.branches[kind].action.evidence.proof.candidate.survivingOwners=3;},
   v=>{if(kind==='withdrawal')v.branches[kind].action.evidence.proof.candidate.nativeTerminalChange=false;else v.branches[kind].effects.allFamiliesUnchanged=false;}]){
   const wrong=structuredClone(value);mutate(wrong);assert.throws(()=>readFunctionalBranchSummary(line(wrong)));
  }
 }
});


test('retained opt-out requires its native marker and full unchanged-publication evidence',()=>{
 const args=['--functional-branches','opt_out_retained','--compare','--upgrade-source','--integration-debug-days','10','--dates','1','--phases','cold'];
 assert.throws(()=>parseArguments(args),/requires genuine accountless/);
 assert.deepEqual(parseArguments([...args,'--functional-accountless-secondary']).functionalBranches,['opt_out_retained']);
 const value=retainedBranchSummary(),branch=value.branches.clock_advance;delete value.branches.clock_advance;value.branches.opt_out_retained=branch;
 value.functionalAccountlessSecondary=true;value.secondaryOwnerKind='accountless';
 branch.startup.scenario='opt_out_retained';branch.analyticalNowMs=value.analyticalNowMs;branch.startup.analyticalNowMs=value.analyticalNowMs;
 for(const profile of Object.values(branch.profiles))profile.retainedPublicationClock.analyticalNowMs=value.analyticalNowMs;
 const cost={failedStatements:0,measurementFailures:0,statements:12,metadataSamples:12,maximumStatementsPerInvocation:12,rowsWritten:4};
 const proof={enrollmentRevoked:true,ownerState:'active',survivingOwners:2,historyRetained:true,exactRetentionMarker:true,revocationGraphRows:4,acceptedRowsRetained:1};
 branch.effects={allFamiliesUnchanged:true};
 branch.action={evidence:{schemaVersion:'analytics-native-functional-episode-v1',kind:'opt_out_retained',postStartImports:0,postStartResets:0,clockOverrides:0,costs:{reference:cost,candidate:cost},proof:{reference:proof,candidate:proof}}};
 const line=v=>'analytics-functional-branches '+JSON.stringify(v);assert.deepEqual(readFunctionalBranchSummary(line(value)),value);
 for(const mutate of [v=>v.branches.opt_out_retained.effects.allFamiliesUnchanged=false,
  v=>v.branches.opt_out_retained.action.evidence.proof.candidate.exactRetentionMarker=false,
  v=>v.branches.opt_out_retained.action.evidence.proof.candidate.revocationGraphRows=3,
  v=>v.branches.opt_out_retained.action.evidence.proof.candidate.acceptedRowsRetained=0,
  v=>v.branches.opt_out_retained.action.evidence.proof.candidate.ownerState='withdrawn']){
  const wrong=structuredClone(value);mutate(wrong);assert.throws(()=>readFunctionalBranchSummary(line(wrong)));
 }
});


test('native input branch receipts require real admission, exact paired semantics and complete row retention',()=>{
 const args=['--functional-branches',FUNCTIONAL_NATIVE_INPUT_KINDS.join(','),'--compare','--upgrade-source','--integration-debug-days','10','--dates','1','--phases','cold'];
 assert.deepEqual(parseArguments(args).functionalBranches,FUNCTIONAL_NATIVE_INPUT_KINDS);
 const hash='a'.repeat(64),pair={calls:2,statements:2,returnedRows:1,mutatingStatements:1,divergences:0,physicalFailures:0};
 const tables=['typed_telemetry_records','typed_telemetry_usage','typed_telemetry_quota','typed_telemetry_session_tools','typed_v11_chunk_allocations','typed_v11_manifest_memberships','typed_v11_record_proofs','telemetry_v12_day_manifests','telemetry_v12_chunks','telemetry_v12_records','telemetry_v12_usage','telemetry_v12_quota','telemetry_v12_session_tools'];
 const rows=Object.fromEntries(tables.map(t=>[t,{rows:1,sha256:hash}])),event={sequence:3,revision:2,authorityEpoch:1,kind:'owner-active',recordedWithinWriterInterval:true};
 const profile={statements:3,metadataSamples:3,failedStatements:0,measurementFailures:0,maximumStatementsPerInvocation:3};
 const kinds={timestamp_move:['eventTime'],cross_day_move:['eventTime'],quota_change:['usedPercent'],plan_change:['planType','accountPlanAttribution.planType'],equal_time_tie:['tieOrder','eventId','dayRecords'],empty_day_replacement:['dayRecords'],same_occurrence_total_repair:['totalInputContextTokens','components.outputCombinedTokens']};
 for(const kind of FUNCTIONAL_NATIVE_INPUT_KINDS){
  const repair=kind==='same_occurrence_total_repair',affectedDays=kind==='cross_day_move'?['2026-10-01','2026-10-02']:['2026-10-01'];
  const evidence={schemaVersion:'analytics-paired-functional-native-input-v1',action:kind,receiptProjection:'hash-only-native-input-v1',postStartImports:0,postStartResets:0,allFamilyParity:'pending',
   writer:{kind,outcome:'accepted',nativeCalls:3,priorRecords:1,newRecords:['equal_time_tie','empty_day_replacement'].includes(kind)?2:1,affectedDays,changedFields:kinds[kind]},
   paired:{scope:pair,admission:pair},profiles:{reference:profile,candidate:profile},events:{reference:event,candidate:event},
   preparation:repair?{kind:'v11_preparation',baseDigest:hash,nativeCalls:2,paired:pair,interval:{startMs:1,endMs:2}}:null,
   preparationEvents:repair?{reference:event,candidate:event}:null,
   priorPhysical:Object.fromEntries(['reference','candidate'].map(l=>[l,{before:rows,after:rows,...(repair?{afterPreparation:rows}:{}),allPriorRowsRetained:true,preparedRowsRetained:repair?true:null}])),
   freshEffective:Object.fromEntries(['reference','candidate'].map(l=>[l,[{day:affectedDays[0],stream:'usage',status:'compatible',eventTimeConflict:false,sourceCount:1,recordDigest:hash,occurrenceSha256:hash}]]))};
  assert.equal(validateFunctionalNativeInputEvidence(evidence,kind),evidence);
  for(const mutate of [v=>v.paired.admission.divergences=1,v=>v.paired.scope.physicalFailures=1,v=>v.writer.outcome='native_refused',v=>v.writer.changedFields=['unknown'],
   v=>v.priorPhysical.candidate.allPriorRowsRetained=false,v=>delete v.priorPhysical.candidate.before.telemetry_v12_usage,
   v=>v.freshEffective.candidate[0].recordDigest='b'.repeat(64),v=>v.freshEffective.reference[0].occurrenceId='not-in-receipt',v=>v.profiles.reference.maximumStatementsPerInvocation=951,
   v=>v.events.reference.recordedWithinWriterInterval=false,v=>v.postStartResets=1,v=>v.allFamilyParity='exact']){
   const bad=structuredClone(evidence);mutate(bad);assert.throws(()=>validateFunctionalNativeInputEvidence(bad,kind));
  }
  if(repair){const bad=structuredClone(evidence);bad.preparation=null;assert.throws(()=>validateFunctionalNativeInputEvidence(bad,kind));}
  assert.throws(()=>assertFunctionalProfileCompatibility({functionalBranches:[kind]},{VITE_WHOLE_WORKLOAD_SQL_PROFILE:'enabled'}));
 }
});

test('preview counter receipts require closed exact costs, hashes, trace completeness and matching phase bounds',()=>{
 const value=retainedBranchSummary(),profile=value.cold.reference,receipt=profile.nativePreviewCounter.receipt;
 assert.equal(validateNativePreviewCounterReceipt(receipt,profile),receipt);
 for(const mutate of [r=>r.complete=false,r=>r.gaps.push('unknown'),r=>r.nativeSqlUnchanged=false,r=>r.counts.failedWrites++,r=>r.counts.unknownWrites++,r=>r.counts.upsert++,r=>r.observationCost.statements--,r=>r.observationCost.rowsWritten++,r=>r.observationCost.includedInInvocationMeter=false,r=>r.shapes[0].attempts++,r=>r.finalRowSha256='bad',r=>r.privateValue='forbidden']){
  const bad=structuredClone(receipt);mutate(bad);assert.throws(()=>validateNativePreviewCounterReceipt(bad,profile));
 }
 assert.throws(()=>validateNativePreviewCounterReceipt(receipt,{...profile,statements:6}));
 const read=v=>readFunctionalBranchSummary('analytics-functional-branches '+JSON.stringify(v));
 for(const mutate of [v=>delete v.previewCounterContract,v=>v.base.completed.candidate.modelRowsSha256='b'.repeat(64),v=>v.base.completed.candidate.previewRowSha256='b'.repeat(64),v=>v.cold.reference.nativePreviewCounter.startupFullBaseRowMatched=true,v=>v.branches.clock_advance.previewActionProof.reference.previewMutationAttempts++,v=>v.branches.clock_advance.profiles.reference.nativePreviewCounter.receipt.initialRowSha256='b'.repeat(64)]){const bad=structuredClone(value);mutate(bad);assert.throws(()=>read(bad));}
 // Complete raw vectors are preserved independently; only the private worker proof
 // and exact noncounter/model hashes authorize their counter-only difference.
 const unequal=structuredClone(value);unequal.base.completed.candidate.publicationRowsSha256='b'.repeat(64);assert.deepEqual(read(unequal),unequal);
});

test('source census is opt-in and refuses cold-only or unmatched retained phases',()=>{
 assert.equal(parseArguments(['--source-lineage','--compare']).sourceLineage,true);
 for(const args of [['--source-lineage'],['--source-lineage','--compare','--phases','cold'],['--source-lineage','--clock-goldens']])assert.throws(()=>parseArguments(args));
 const args=['--source-lineage','--functional-branches','no_op,duplicate_delivery,unrelated_append','--compare','--upgrade-source','--integration-debug-days','10','--phases','cold'];assert.equal(parseArguments(args).sourceLineage,true);
 assert.throws(()=>parseArguments(args.map(x=>x==='no_op,duplicate_delivery,unrelated_append'?'duplicate_delivery':x)));
});

function sourceCensusFixture(lane='candidate'){
 const h='a'.repeat(64),consumers=['cohort','daily','api','scalar','model','block','cache','publication','fixture','unclassified'];
 const row={consumer:'unclassified',operationScope:'unclassified',phase:'no_op',fingerprint:h,exactSqlSha256:h,attempts:1,rowsRead:2,rowsWritten:0};
 const report={contract:'c06-source-lineage-synthetic-v1',noRescanQualified:false,potentialAccessOnly:true,boundaryFailures:0,calls:1,shapes:1,schemaSha256:h,layoutSha256:h,schemaSetupStatements:1,diagnosticStatements:3,meterReconciled:true,
  measurements:[row],perConsumer:Object.fromEntries(consumers.map(c=>[c,{attempts:c==='unclassified'?1:0,rowsRead:c==='unclassified'?2:0,rowsWritten:0,shapes:c==='unclassified'?1:0}])),consumerCompletions:{api:{entrypointCalls:1,publicCompleteReceiptSha256:[h]}}};
 const profile={costs:{'owner_metadata.source.metadata':{statements:1}}};
 return {profile,outputSha256:h,lane,phase:'no_op',value:{contract:'whole-workload-c06-source-census-v1',lane,phase:'no_op',status:'diagnostic',candidateQualificationEligible:lane==='candidate',noRescanQualified:false,qualificationReason:lane==='candidate'?'reviewed_certificate_not_attached':'native_reference_diagnostic_only',publicCompleteReceiptSha256:h,expectedSourceCalls:1,profiledSourceCalls:1,operationScopeFailures:0,operationScopesComplete:true,producerScopeContract:'immutable-prepared-operation-scope-v1',producerBoundaryTransform:lane==='candidate'?'candidate-nine-reviewed-boundaries-v1':'native-direct-entrypoints-only',perOperationExpectedSourceCalls:Object.fromEntries(C06_RECEIPT_OPERATION_SCOPES.map(scope=>[scope,scope==='unclassified'?1:0])),operationCountsReconciled:true,perConsumerExpectedSourceCalls:Object.fromEntries(consumers.map(c=>[c,c==='unclassified'?1:0])),sourceCallCountsReconciled:true,consumerCountsReconciled:true,diagnosticCountsReconciled:true,diagnostics:{contract:'c06-separate-readonly-diagnostic-meter-v1',actualStatementLimitPerInvocation:950,separateFromAnalyticalPhase:true,oneStatementPerDiagnosticInvocation:true,attempted:4,refused:0,profile:{statements:4,maximumStatementsPerInvocation:1,failedStatements:0,measurementFailures:0,metadataSamples:4}},report}};
}
test('source census retains unknown diagnostics but refuses made-up qualification or unmetered costs',()=>{
 for(const lane of ['reference','candidate']){const fixture=sourceCensusFixture(lane);assert.equal(validateC06SourceCensus(fixture.value,fixture),fixture.value);}
 for(const mutate of [v=>v.operationScopeFailures=-1,v=>v.operationScopesComplete=false,v=>v.report.boundaryFailures++,v=>v.operationCountsReconciled=false,v=>v.producerScopeContract='unknown',v=>v.producerBoundaryTransform='unknown',v=>v.perOperationExpectedSourceCalls.direct_daily++,v=>v.report.measurements[0].operationScope='unknown',v=>v.noRescanQualified=true,v=>v.report.noRescanQualified=true,v=>v.report.potentialAccessOnly=false,v=>v.phase='cold',v=>v.publicCompleteReceiptSha256='b'.repeat(64),v=>v.expectedSourceCalls++,v=>v.profiledSourceCalls++,v=>v.perConsumerExpectedSourceCalls.api++,v=>v.sourceCallCountsReconciled=false,v=>v.consumerCountsReconciled=false,v=>v.diagnosticCountsReconciled=false,v=>v.diagnostics.separateFromAnalyticalPhase=false,v=>v.diagnostics.profile.maximumStatementsPerInvocation=951,v=>v.report.measurements[0].phase='cold']){
  const fixture=sourceCensusFixture();mutate(fixture.value);assert.throws(()=>validateC06SourceCensus(fixture.value,fixture));
 }
 const caught=sourceCensusFixture();caught.value.operationScopeFailures=1;caught.value.operationScopesComplete=false;caught.value.report.boundaryFailures=1;assert.equal(validateC06SourceCensus(caught.value,caught),caught.value);
 const missing=sourceCensusFixture();Object.assign(missing.value,{status:'unavailable',report:null,sourceCallCountsReconciled:false,consumerCountsReconciled:false,diagnosticCountsReconciled:false,operationCountsReconciled:false,operationScopesComplete:false});assert.equal(validateC06SourceCensus(missing.value,missing),missing.value);
 const summary=retainedBranchSummary();summary.sourceLineageEnabled=true;const branch=summary.branches.clock_advance;delete summary.branches.clock_advance;summary.branches.no_op=branch;branch.startup.scenario='no_op';
 assert.throws(()=>readFunctionalBranchSummary('analytics-functional-branches '+JSON.stringify(summary)));
});

test('census receipt operation enum exactly matches the immutable facade contract',async()=>{
 const {readFile}=await import('node:fs/promises'),{transform}=await import('esbuild');
 const source=await readFile(new URL('../test/helpers/analytics-c06-operation-scope.ts',import.meta.url),'utf8');
 const compiled=await transform(source,{loader:'ts',format:'esm',target:'es2022'});
 const helper=await import('data:text/javascript;base64,'+Buffer.from(compiled.code).toString('base64'));
 assert.deepEqual(C06_RECEIPT_OPERATION_SCOPES,helper.C06_OPERATION_SCOPES);
});

function namedBoundaryBranch(name){const value=JSON.parse(JSON.stringify(retainedBranchSummary())),branch=value.branches.clock_advance;delete value.branches.clock_advance;value.branches[name]=branch;branch.startup.scenario=name;branch.analyticalNowMs=value.analyticalNowMs;branch.startup.analyticalNowMs=value.analyticalNowMs;for(const profile of Object.values(branch.profiles))profile.retainedPublicationClock.analyticalNowMs=value.analyticalNowMs;return {value,branch};}
const boundaryRead=value=>readFunctionalBranchSummary('analytics-functional-branches '+JSON.stringify(value));
const boundaryCost=()=>({statements:5,metadataSamples:5,measurementFailures:0,failedStatements:0,maximumStatementsPerInvocation:5,rowsWritten:0,rowsRead:5});
function boundaryEvidence(kind,proof){return {schemaVersion:'analytics-native-functional-boundary-v1',kind,allFamilyParity:'pending',postStartImports:0,postStartResets:0,clockOverrides:0,proof:{reference:structuredClone(proof),candidate:structuredClone(proof)},costs:{reference:boundaryCost(),candidate:boundaryCost()}};}
test('native lag and expired-lease receipts require real transition lineage, refusal and complete recovery output',()=>{
 const args=['--functional-branches','authority_lag,stale_lease,restore_after_erasure','--compare','--upgrade-source','--integration-debug-days','10','--phases','cold'];assert.equal(parseArguments(args).functionalBranches.length,3);
 const {value,branch}=namedBoundaryBranch('stale_lease');branch.effects={allFamiliesUnchanged:true};
 branch.action={evidence:boundaryEvidence('stale_lease',{nativeLeaseExpired:true,priorClaimRevision:2,reapedRevision:3,oldCompletion:'conflict',reclaimedRevision:4,releasedRevision:5,retainedDependencySha256:'a'.repeat(64),realWaitMs:1,pendingNativeRecovery:true})};
 assert.deepEqual(boundaryRead(value),value);
 for(const mutate of [p=>p.oldCompletion='complete',p=>p.nativeLeaseExpired=false,p=>p.reapedRevision=2,p=>p.reclaimedRevision=6,p=>p.releasedRevision=4,p=>p.priorClaimRevision=null,p=>p.retainedDependencySha256='bad',p=>p.pendingNativeRecovery=false]){const bad=structuredClone(value);mutate(bad.branches.stale_lease.action.evidence.proof.candidate);assert.throws(()=>boundaryRead(bad));}
 const {value:lag,branch:b}=namedBoundaryBranch('authority_lag'),h='b'.repeat(64),cost=boundaryCost(),kind='metadata_change';
 b.effects={affectedAggregateChanged:true,affectedCacheEventsBefore:1,affectedCacheEventsAfter:2};
 b.action={storesReplaced:false,physicalStoresRetained:true,paired:{divergences:0,physicalFailures:0},proof:{schemaVersion:'analytics-mutation-proof-v2',comparisonContract:'native-existing-owner-v2',clockPolicy:'native-v11-trigger-clocks-v1',kind,verifiedNativeBranch:kind,verified:{newEvents:1},rawSnapshotSha256:{before:{reference:h,candidate:h},after:{reference:h,candidate:h}}},admission:{reference:cost,candidate:cost},delivery:{reference:cost,candidate:cost},snapshots:Object.fromEntries(['reference','candidate'].map(lane=>[lane,{before:{sha256:h,measurement:cost},after:{sha256:h,measurement:cost}}])),deliveryEpisode:{evidence:boundaryEvidence('authority_lag',{pendingNativeEvents:1,sourceSequence:3,targetSequence:2,sourceRevision:3,targetRevision:2,sourceAuthorityEpoch:4,targetAuthorityEpoch:3,eventSha256:h,priorPreviewSha256:h,previewRefused:true,priorPublicationRetainedExactly:true,appliedReceipts:0})}};
 assert.deepEqual(boundaryRead(lag),lag);
 for(const mutate of [p=>p.sourceSequence=2,p=>p.sourceRevision=2,p=>p.sourceAuthorityEpoch=3,p=>p.targetSequence='2',p=>p.previewRefused=false,p=>p.appliedReceipts=1,p=>p.priorPublicationRetainedExactly=false]){const bad=structuredClone(lag);mutate(bad.branches.authority_lag.action.deliveryEpisode.evidence.proof.reference);assert.throws(()=>boundaryRead(bad));}
 const bad=structuredClone(lag);bad.branches.authority_lag.action.proof.kind='unrelated_append';assert.throws(()=>boundaryRead(bad));
});
function restoreBoundarySummary(){
 const {value,branch}=namedBoundaryBranch('restore_after_erasure'),h='b'.repeat(64),nil='74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b';
 const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
 const episode=(kind,proof)=>({schemaVersion:'analytics-native-functional-episode-v1',kind,postStartImports:0,postStartResets:0,clockOverrides:0,costs:{reference:boundaryCost(),candidate:boundaryCost()},proof:{reference:proof,candidate:proof}});
 const retired=()=>{const r=structuredClone(value.base.completed.reference.previewCounterProof);r.initialRevision=1;r.finalRevision=null;r.initialRowSha256='a'.repeat(64);r.finalRowSha256=nil;r.nonCounterColumnsSha256=nil;r.counts.upsert=0;r.counts.retire=1;return r;};
 const actionTrace=()=>({contract:'native-preview-traced-action-v1',reference:retired(),candidate:retired(),controls:{reference:{...boundaryCost(),maximumStatementsPerInvocation:3},candidate:{...boundaryCost(),maximumStatementsPerInvocation:3}}});
 const restored=structuredClone(value.base);restored.schemaVersion='analytics-terminal-ledger-six-store-base-v1';restored.terminalParticipantSha256=h;restored.preterminalBaseSha256=createHash('sha256').update(canonical(value.base)).digest('hex');restored.terminalProof=Object.fromEntries(['reference','candidate'].map(lane=>[lane,{nativeCompletion:true,tombstone:true,participantRows:0,cost:boundaryCost()}]));
 restored.preparationEvidence={erasure:episode('physical_erasure',{tombstone:true,participantRows:0,nativePhysicalCompletion:true,survivingOwners:1}),previewActionTrace:actionTrace()};
 for(const lane of ['reference','candidate']){for(const boundary of ['captures','finalCapture'])restored[boundary][lane+'.ledger'].proof.sqlSha256=h;branch.startup.imports[lane+'.ledger'].proof.sqlSha256=h;
  const item=branch.startup.completion[lane];Object.assign(item.inventory,{currentFitOwners:1,graphResults:71,modelOwnerResults:70,cacheOwnerDaysCompared:10});
  const counter=structuredClone(value.base.completed[lane].previewCounterProof);item.previewCounterProof=counter;
  branch.profiles[lane].nativePreviewCounter={boundary:'lane-entry-after-traced-native-action',startupFullBaseRowMatched:false,receipt:counter,actionCheckpoint:retired()};
 }
 branch.restoreBase=restored;branch.expectedOwnerCount=1;branch.previewActionProof=actionTrace();branch.action={evidence:episode('restore_after_erasure',{suppressed:1,participantRows:0,nativePhysicalCompletion:true,survivingOwners:1,replayPasses:1})};return value;
}
test('restore requires separate six-store startup, authentic terminal ledger witness and unbroken private preview traces',()=>{
 const value=restoreBoundarySummary();assert.deepEqual(boundaryRead(value),value);
 for(const mutate of [v=>v.branches.restore_after_erasure.startup.postStartImports=1,v=>delete v.branches.restore_after_erasure.restoreBase,
  v=>v.branches.restore_after_erasure.restoreBase.preterminalBaseSha256='b'.repeat(64),v=>v.branches.restore_after_erasure.restoreBase.terminalProof.candidate.tombstone=false,
  v=>v.branches.restore_after_erasure.restoreBase.captures['reference.source'].proof.sqlSha256='b'.repeat(64),
  v=>v.branches.restore_after_erasure.startup.imports['reference.ledger'].proof.sqlSha256='a'.repeat(64),
  v=>v.branches.restore_after_erasure.restoreBase.preparationEvidence.erasure.proof.reference.nativePhysicalCompletion=false,
  v=>v.branches.restore_after_erasure.previewActionProof.reference.finalRowSha256='a'.repeat(64),
  v=>v.branches.restore_after_erasure.profiles.reference.nativePreviewCounter.actionCheckpoint.initialRevision=2,
  v=>v.branches.restore_after_erasure.action.evidence.proof.candidate.suppressed=0,
  v=>v.branches.restore_after_erasure.action.evidence.proof.candidate.replayPasses=33,
  v=>v.branches.restore_after_erasure.profiles.candidate.nativePreviewCounter.receipt.gaps.push('lost'),
  v=>v.branches.restore_after_erasure.previewActionProof.controls.reference.maximumStatementsPerInvocation=951,
  v=>v.branches.restore_after_erasure.previewActionProof.controls.reference.statements=4,
  v=>v.branches.restore_after_erasure.action.evidence.costs.reference.statements=3]){const bad=structuredClone(value);mutate(bad);assert.throws(()=>boundaryRead(bad));}
});

import {captureWholeWorkloadRunInputs,verifyWholeWorkloadRunInputs,assertWholeWorkloadGeneratedArtifacts} from './benchmark-analytics-whole-workload.mjs';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

test('whole input guard captures actual installed imports and refuses file-set, resolution and generated-artifact drift',async t=>{
 const worker=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(path.join(worker,'package.json'));
 const directory=await mkdtemp(path.join(tmpdir(),'p11-input-guard-check-'));
 const put=async(name,content)=>{const file=path.join(directory,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,content);return file;};
 const packageRoot=name=>{for(const base of require.resolve.paths(name)??[]){const directory=path.join(base,name);try{if(JSON.parse(require('node:fs').readFileSync(path.join(directory,'package.json'),'utf8')).name===name)return directory;}catch(error){if(error.code!=='ENOENT')throw error;}}throw Error('Missing fixture runtime package');};
 try{
  for(const name of ['vitest','vite','miniflare','workerd','esbuild','@cloudflare/vitest-pool-workers',`@cloudflare/workerd-${process.platform}-${process.arch}`,`@esbuild/${process.platform}-${process.arch}`,'@app-usagemonitor/telemetry-contract']){
   let source;try{source=path.dirname(require.resolve(name+'/package.json'));}catch{source=packageRoot(name);}
   const link=path.join(directory,'node_modules',name);await mkdir(path.dirname(link),{recursive:true});await symlink(source,link,'dir');
  }
  await put('package.json',JSON.stringify({name:'p11-input-guard-test',version:'1.0.0',type:'module'}));
  await put('package-lock.json','{}\n');await put('wrangler.jsonc','{}\n');await put('worker-configuration.d.ts','export {};\n');await put('tsconfig.json','{}\n');
  await put('migrations/0001.sql','SELECT 1;\n');
  const inherited=await put('scripts/inherited.mjs','export const input=true;\n');
  await put('scripts/tsconfig.json','{}\n');
  const generated=await put('generated.mjs','export const generated=1;\n');
  await put('erased-type.ts','export interface PrivateTestType {value:number};\n');
  const entry=await put('test.ts',"import {type PrivateTestType} from './erased-type'; import * as telemetry from '@app-usagemonitor/telemetry-contract'; import {generated} from 'p11:kernel'; export {telemetry,generated};\n");
  await put('config-leaf.ts','export const value=1;\n');
  const config=await put('config.ts',"import {value} from './config-leaf';import fixture from 'p11-pin-fixture';export default {value,fixture};\n");
  const fakePackage=await put('node_modules/p11-pin-fixture/package.json',JSON.stringify({name:'p11-pin-fixture',version:'1.0.0',type:'module',main:'index.js',dependencies:{'p11-pin-leaf':'1.0.0'}}));
  await put('node_modules/p11-pin-fixture/index.js','export default 1;\n');
  const leafPackage=await put('node_modules/p11-pin-leaf/package.json',JSON.stringify({name:'p11-pin-leaf',version:'1.0.0',main:'index.js'}));
  await put('node_modules/p11-pin-leaf/index.js','module.exports=1;\n');
  const options={workerDirectory:directory,testFiles:[entry],configFiles:[config],aliases:{'p11:kernel':generated},generatedFiles:[generated,config],inheritedFiles:[inherited]};
  const before=await captureWholeWorkloadRunInputs(options);
  await t.test('pins real installed telemetry JS, transitive config, package metadata and actual native/Node binaries',async()=>{
   const telemetry=before.testInputs.filter(file=>file.includes('/telemetry-contract/')&&file.endsWith('.js'));
   assert.equal(telemetry.length,17);assert.ok(telemetry.every(file=>before.files.some(pin=>pin.realPath===file||pin.path===file)));
   assert.ok(before.testInputs.includes(path.join(directory,'erased-type.ts')));
   assert.ok(before.configInputs.includes(path.join(directory,'config-leaf.ts')));
   for(const name of ['package.json','package-lock.json','wrangler.jsonc','worker-configuration.d.ts','tsconfig.json'])assert.ok(before.files.some(pin=>pin.path===path.join(directory,name)));
   for(const file of Object.values(before.runtime.selectedExecutables))assert.ok(before.files.some(pin=>pin.realPath===file&&pin.bytes>0&&/^[a-f0-9]{64}$/u.test(pin.sha256)));
   assert.equal(before.runtime.selectedExecutables.node,await realpath(process.execPath));assert.equal(before.runtime.nodeVersion,process.version);
   assert.equal(before.runtime.systemLibrariesQualified,false);assert.ok(before.runtime.packages.some(row=>row.name==='p11-pin-leaf'));
   assert.equal((await verifyWholeWorkloadRunInputs(before)).unchanged,true);
  });
  for(const name of ['config-leaf.ts','generated.mjs','scripts/inherited.mjs','scripts/tsconfig.json','package-lock.json'])await t.test('refuses changed '+name,async()=>{
   const file=path.join(directory,name),original=await readFile(file);try{await writeFile(file,Buffer.concat([original,Buffer.from('\n ')]));assert.equal((await verifyWholeWorkloadRunInputs(before)).unchanged,false);}finally{await writeFile(file,original);}
  });
  await t.test('refuses newly added SQL including a new migration directory',async()=>{
   const dir=path.join(directory,'new-migrations');try{await put('new-migrations/0001.sql','SELECT 2;\n');const after=await verifyWholeWorkloadRunInputs(before);assert.equal(after.unchanged,false);assert.equal(after.after.sqlFiles.length,before.sqlFiles.length+1);}finally{await rm(dir,{recursive:true});}
  });
  await t.test('refuses missing required configuration and required runtime dependency',async()=>{
   for(const file of [path.join(directory,'wrangler.jsonc'),leafPackage]){const bytes=await readFile(file);try{await rm(file);const after=await verifyWholeWorkloadRunInputs(before);assert.equal(after.unchanged,false);assert.equal(after.captureComplete,false);assert.equal(after.reason,'required_input_capture_failed');}finally{await writeFile(file,bytes);}}
  });
  await t.test('refuses package entrypoint and installed runtime filename-set changes',async()=>{
   const original=await readFile(fakePackage),file=path.join(directory,'node_modules/p11-pin-fixture/alternate.js');
   try{await writeFile(file,'export default 2;\n');assert.equal((await verifyWholeWorkloadRunInputs(before)).unchanged,false);
    await writeFile(fakePackage,JSON.stringify({...JSON.parse(original),main:'alternate.js'}));assert.equal((await verifyWholeWorkloadRunInputs(before)).unchanged,false);
   }finally{await writeFile(fakePackage,original);await rm(file);}
  });
  await t.test('refuses a missing generated bundle and a newly imported config dependency',async()=>{
   const original=await readFile(generated);try{await rm(generated);assert.equal((await verifyWholeWorkloadRunInputs(before)).captureComplete,false);}finally{await writeFile(generated,original);}
   const originalConfig=await readFile(config);try{await put('another-config.ts','export const another=2;\n');await writeFile(config,originalConfig+"import './another-config';\n");assert.equal((await verifyWholeWorkloadRunInputs(before)).unchanged,false);}finally{await writeFile(config,originalConfig);await rm(path.join(directory,'another-config.ts'));}
  });
  await t.test('binds captured generated bytes to the original builder hash, not a replacement before dispatch',()=>{
   const artifacts=before.generatedFiles.map(file=>({path:file,sha256:before.files.find(pin=>pin.path===file).sha256}));
   assert.doesNotThrow(()=>assertWholeWorkloadGeneratedArtifacts(before,artifacts));
   assert.throws(()=>assertWholeWorkloadGeneratedArtifacts(before,artifacts.map((row,index)=>index===0?{...row,sha256:'0'.repeat(64)}:row)),/builder receipt/u);
   assert.throws(()=>assertWholeWorkloadGeneratedArtifacts(before,artifacts.slice(1)),/builder receipt/u);
   assert.throws(()=>assertWholeWorkloadGeneratedArtifacts(before,[artifacts[0],artifacts[0]]),/builder receipt/u);
  });
  await t.test('refuses added and removed nested SQL without changing migration execution',async()=>{
   const nested=path.join(directory,'migrations/nested/deeper/0002.sql');
   try{
    await put('migrations/nested/deeper/0002.sql','SELECT 2;\n');
    const added=await verifyWholeWorkloadRunInputs(before);assert.equal(added.unchanged,false);assert.equal(added.captureComplete,true);
    assert.equal(added.after.sqlFiles.length,before.sqlFiles.length+1);assert.ok(added.after.sqlFiles.includes(nested));
    const withNested=added.after;await rm(nested);
    const removed=await verifyWholeWorkloadRunInputs(withNested);assert.equal(removed.unchanged,false);assert.equal(removed.captureComplete,true);
    assert.deepEqual(removed.after.sqlFiles,before.sqlFiles);
   }finally{await rm(path.join(directory,'migrations/nested'),{recursive:true,force:true});}
  });
  await t.test('requires all explicit entry roots and preserves an unchanged final recapture',async()=>{
   for(const key of ['testFiles','configFiles','generatedFiles'])await assert.rejects(captureWholeWorkloadRunInputs({...options,[key]:[]}),/input roots required/u);
   assert.equal((await verifyWholeWorkloadRunInputs(before)).unchanged,true);
  });
 }finally{await rm(directory,{recursive:true,force:true});}
});

// Additive shared-seed matrix controls. All earlier case bodies are unchanged.
const matrixModule=await import('./benchmark-analytics-whole-workload.mjs');
function sharedSeedFixture(){
 const analyticalNowMs=Date.parse('2026-10-01T12:00:00.000Z'),midnight=Date.parse('2026-10-01T00:00:00.000Z');
 const inputPins=Object.fromEntries(['referenceInputSha256','candidateInputSha256','harnessInputSha256','referenceBundleSha256','candidateBundleSha256','fixtureSha256'].map((key,index)=>[key,String(index+1).repeat(64)]));
 const statements=['synthetic seed statement'],sql=statements.join('\n'),profile={statements:1,metadataSamples:1,failedStatements:0,measurementFailures:0};
 const seed={analyticalNowMs,historyDates:Array.from({length:466},(_,index)=>new Date(midnight-(465-index)*86400000).toISOString().slice(0,10)),
  transfer:{schemaVersion:'analytics-accepted-source-transfer-v1',statements,proof:{sqlSha256:createHash('sha256').update(sql).digest('hex'),schemaSha256:'a'.repeat(64),rowidInventorySha256:'b'.repeat(64),autoIncrementSequenceSha256:'c'.repeat(64),exportStatements:1,exportedLogicalSqlBytes:Buffer.byteLength(sql),rowidRows:0,typedRowsCompared:0}},
  initialAdmission:profile,laboratorySetup:{...profile},snapshotProfile:{...profile},snapshotExportWallMs:1};
 const bridge={state:{active:null,exits:[{lane:'seed',code:0,signal:null}],seed}};
 const summary=dates=>{const value=integratedSummary({dates});for(const phase of ['warm','no_op'])value.phases[phase]=structuredClone(value.phases.cold);
  value.initialAdmission={reference:seed.initialAdmission,candidate:{...profile}};value.inputAdmission=structuredClone(value.initialAdmission);
  value.laboratorySetup={reference:{...profile},candidate:{...profile},seed:seed.laboratorySetup};Object.assign(value.sourceSnapshot,seed.transfer.proof,{seedProof:seed.snapshotProfile});
  value.sharedSeedScale={contract:'accepted-shared-seed-v1',sourceProofSha256:createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(seed.transfer.proof).sort(([a],[b])=>a<b?-1:1)))).digest('hex'),analyticalNowMs,historyCalendarDays:466,requestedDates:dates};
  value.evidence={reference:{inputSha256:inputPins.referenceInputSha256,bundleSha256:inputPins.referenceBundleSha256},candidate:{inputSha256:inputPins.candidateInputSha256,bundleSha256:inputPins.candidateBundleSha256},harness:{inputSha256:inputPins.harnessInputSha256},fixture:{sha256:inputPins.fixtureSha256}};
  return value;};
 return {analyticalNowMs,inputPins,seed,bridge,summary};
}
test('shared-seed matrix CLI is additive and refuses smaller populations or alternate clocks/startups',()=>{
 const args=['--scale-matrix','1,30,365','--compare','--upgrade-source'];
 assert.deepEqual(parseArguments(args).scaleMatrix,[1,30,365]);assert.equal(Object.hasOwn(parseArguments([]),'scaleMatrix'),false);
 for(const suffix of [['--dates','1'],['--integration-debug-days','10'],['--phases','cold'],['--native-profile','unshared-diagnostic'],['--functional-mutations'],['--clock-goldens']])assert.throws(()=>parseArguments([...args,...suffix]));
 for(const value of ['1','365,30,1','1,30','1,30,30','10,30,365'])assert.throws(()=>parseArguments(['--scale-matrix',value,'--compare','--upgrade-source']));
 assert.throws(()=>parseArguments(['--scale-matrix','1,30,365']));
});
test('shared-seed matrix refuses changed seed/rowid/highwater proof, history, setup metadata and failed seed process',()=>{
 for(const mutate of [
  f=>{f.seed.analyticalNowMs++;},f=>{f.seed.historyDates.pop();},f=>{f.seed.historyDates[0]=f.seed.historyDates[1];},
  f=>{f.seed.transfer.statements[0]+='changed';},f=>{f.seed.transfer.proof.exportStatements++;},
  f=>{delete f.seed.transfer.proof.autoIncrementSequenceSha256;},f=>{f.seed.transfer.proof.rowidInventorySha256='unknown';},
  f=>{f.seed.transfer.proof.rowidRows=-1;},f=>{f.seed.snapshotProfile.metadataSamples=0;},f=>{f.seed.initialAdmission.failedStatements=1;},
  f=>{f.bridge.state.exits[0].code=1;},f=>{f.bridge.state.active='seed';},f=>{f.bridge.state.exits.push({lane:'candidate',code:0,signal:null});},
 ]){const fixture=sharedSeedFixture();mutate(fixture);const run=matrixModule.createSharedSeedScaleExperiment(fixture);run.beginScale(1);assert.throws(()=>run.captureSeed(fixture.bridge));run.close();}
});
test('shared-seed matrix counts genuine setup once while retaining every independent scale and phase cost',()=>{
 const f=sharedSeedFixture(),run=matrixModule.createSharedSeedScaleExperiment(f);
 assert.deepEqual(run.beginScale(1),{});run.captureSeed(f.bridge);
 assert.throws(()=>{f.seed.transfer.statements.push('changed');});
 for(const dates of [1,30,365]){if(dates!==1)assert.equal(Object.keys(run.beginScale(dates)).join(','),'retainedSeed');
  const checkpoint=run.completeScale(f.summary(dates));assert.equal(checkpoint.dates,dates);assert.equal(checkpoint.summary.initialAdmission,undefined);
  assert.equal(checkpoint.summary.sharedSeedCosts.referenceAdmission,'commonSeed');assert.equal(checkpoint.summary.phases.no_op.reference.statements,3);
 }
 const receipt=run.finish();assert.equal(receipt.complete,true);assert.deepEqual(receipt.scales,[1,30,365]);assert.equal(receipt.commonSeed.actualSeedProcesses,1);
 assert.deepEqual(receipt.commonSeed.initialAdmission,f.seed.initialAdmission);assert.equal(receipt.commonSeed.exportResourceMetadata,null);assert.equal(receipt.costs.totalCost,null);
 assert.equal(receipt.completed.length,3);assert.equal(JSON.stringify(receipt).includes('synthetic seed statement'),false);run.close();assert.throws(()=>run.finish());
});
test('shared-seed matrix refuses scale/phase/input/source/time drift and preserves completed checkpoints after a later failure',()=>{
 const mutations=[v=>{delete v.sharedSeedScale;},v=>{v.sharedSeedScale.sourceProofSha256='d'.repeat(64);},v=>{v.analyticalNowMs++;},v=>{v.cachePopulationDays=465;},v=>{v.sourceSnapshot.autoIncrementSequenceSha256='d'.repeat(64);},
  v=>{v.sourceSnapshot.sqlSha256='d'.repeat(64);},v=>{v.sourceSnapshot.schemaSha256='d'.repeat(64);},v=>{v.sourceSnapshot.rowidInventorySha256='d'.repeat(64);},
  v=>{v.evidence.reference.bundleSha256='d'.repeat(64);},v=>{v.evidence.fixture.sha256='d'.repeat(64);},v=>{delete v.phases.no_op;},
  v=>{v.phases.warm.output.parity='baseline_only';},v=>{v.phases.no_op.output.completed.dailyDays=1;},v=>{v.laboratorySetup.seed.statements++;}];
 for(const mutate of mutations){const f=sharedSeedFixture(),run=matrixModule.createSharedSeedScaleExperiment(f);run.beginScale(1);run.captureSeed(f.bridge);run.completeScale(f.summary(1));
  assert.throws(()=>run.beginScale(365));run.beginScale(30);const value=structuredClone(f.summary(30));mutate(value);assert.throws(()=>run.completeScale(value));
  run.fail();assert.throws(()=>run.finish());assert.deepEqual(run.checkpoint().completedDates,[1]);assert.equal(run.checkpoint().failed,true);run.close();}
});
test('shared-seed matrix refuses missing peer/full family evidence and cannot finish an incomplete or reordered experiment',()=>{
 const f=sharedSeedFixture(),run=matrixModule.createSharedSeedScaleExperiment(f);
 assert.throws(()=>run.beginScale(30));run.beginScale(1);assert.throws(()=>run.beginScale(1));assert.throws(()=>run.finish());run.captureSeed(f.bridge);assert.throws(()=>run.captureSeed(f.bridge));
 const value=f.summary(1);delete value.phases.cold.candidate;assert.throws(()=>run.completeScale(value));assert.throws(()=>run.finish());run.close();
 for(const change of [v=>{delete v.candidateInputSha256;},v=>{v.fixtureSha256='invalid';},v=>{v.extra='a'.repeat(64);}]){const pins={...f.inputPins};change(pins);assert.throws(()=>matrixModule.createSharedSeedScaleExperiment({...f,inputPins:pins}));}
});


test('owned runtime observer closes once per lane and carries no stale seed or peer URL',async()=>{
 const {createRuntimeObservationOwner}=await import('./benchmark-analytics-whole-workload.mjs');
 const created=[],closed=[],diagnostics=[];
 const owner=createRuntimeObservationOwner({factory:async options=>{const bridge={url:options.url,close:async()=>{closed.push(options.url);}};created.push(bridge);return bridge;},onClosed:(_bridge,identity)=>diagnostics.push(identity)});
 assert.equal(await owner.begin(null,{lane:'seed',scale:1}),null);
 for(const scale of [1,30,365])for(const lane of ['candidate','reference']){
  const url=scale+'-'+lane;assert.equal((await owner.begin({url},{scale,lane})).url,url);
  await assert.rejects(owner.begin({url:'overlap'},{}),/overlap/);
  await owner.close();await owner.close();assert.equal(await owner.begin(null,{lane:'seed'}),null);
 }
 assert.equal(created.length,6);assert.deepEqual(closed,created.map(row=>row.url));
 assert.equal(diagnostics.length,6);assert.deepEqual(diagnostics[5],{scale:365,lane:'reference'});
});
test('observer close failure clears ownership and preserves exactly one closed diagnostic',async()=>{
 const {createRuntimeObservationOwner}=await import('./benchmark-analytics-whole-workload.mjs');let calls=0,diagnostics=0;
 const owner=createRuntimeObservationOwner({factory:async()=>({close:async()=>{calls++;throw Error('synthetic close failure');}}),onClosed:()=>{diagnostics++;}});
 await owner.begin({},{});await assert.rejects(owner.close(),/synthetic close/);await owner.close();
 assert.equal(calls,1);assert.equal(diagnostics,1);assert.equal(await owner.begin(null,{}),null);
});

test('C06 attachment mode is separate from all workload, seed and runtime execution',()=>{
 const args=['--qualify-census','/private/tmp/completed.json','--c06-certificate','/private/tmp/reviewed.json','--output','/private/tmp/attachment.json'];
 assert.equal(parseArguments(args).qualifyCensus,'/private/tmp/completed.json');
 for(const extra of ['--compare','--source-lineage','--observe-runtime','--functional-mutations'])assert.throws(()=>parseArguments([...args,extra]));
 assert.throws(()=>parseArguments(args.slice(0,4)));assert.throws(()=>parseArguments(['--c06-certificate','x','--output','y']));
});
function attachedSummaryFixture(){
 const summary=integratedSummary(),h='a'.repeat(64);summary.sourceLineageEnabled=true;
 summary.sourceSnapshot={...summary.sourceSnapshot,autoIncrementSequenceSha256:h,exportStatements:1,exportedLogicalSqlBytes:1,rowidRows:1,typedRowsCompared:1};
 summary.phases.no_op=structuredClone(summary.phases.cold);
 for(const lane of ['reference','candidate']){const c=sourceCensusFixture(lane);Object.assign(summary.phases.no_op[lane],c.profile,{c06SourceLineage:c.value});}
 summary.evidence={candidate:{bundleSha256:h},reference:{bundleSha256:h},harness:{inputSha256:h},executionInputReceipts:[{unchanged:true,captureComplete:true,inputSha256:h,afterInputSha256:h}]};
 return summary;
}
test('C06 attachment controller derives current exact phase/peer/source evidence only after original full receipt gates',async()=>{
 const {c06CompletedReceiptCases}=await import('./benchmark-analytics-whole-workload.mjs');
 const receipt=attachedSummaryFixture(),cases=c06CompletedReceiptCases(receipt);
 assert.equal(cases.length,1);assert.equal(cases[0].phase,'no_op');assert.equal(cases[0].expectedProvenance.action,'none');
 assert.equal(cases[0].nativeFullOutputSha256,receipt.phases.no_op.output.sha256);assert.equal(cases[0].expectedProvenance.priorCompleteOutputSha256,receipt.phases.cold.output.sha256);
 for(const edit of [v=>delete v.phases.cold,v=>v.phases.no_op.output.parity='pending',v=>v.evidence.executionInputReceipts[0].unchanged=false,
  v=>v.evidence.candidate.bundleSha256='bad',v=>delete v.sourceSnapshot.autoIncrementSequenceSha256,v=>v.phases.no_op.output.completed.cacheOwnerDays--]){
  const bad=structuredClone(receipt);edit(bad);assert.throws(()=>c06CompletedReceiptCases(bad));
 }
});
test('C06 attachment refuses wrong/missing/duplicate reviews before invoking qualification and preserves refusal output',async()=>{
 const {attachReviewedC06Receipt}=await import('./benchmark-analytics-whole-workload.mjs');
 const receiptBytes=JSON.stringify(attachedSummaryFixture()),certificate={contract:'c06-reviewed-receipt-certificates-v1',receiptSha256:createHash('sha256').update(receiptBytes).digest('hex'),cases:[{dates:1,phase:'no_op',review:{}}]};
 let called=0;const qualify=async()=>{called++;return {contract:'c06-attached-phase-qualification-v1',qualified:false,noRescanQualified:false,refusalCodes:['C06_V2_UNKNOWN_SCOPE']};};
 const result=await attachReviewedC06Receipt({receiptBytes,certificateBytes:JSON.stringify(certificate),qualify});
 assert.equal(result.qualified,false);assert.equal(called,1);assert.equal(result.originalReceiptUnchanged,true);
 for(const edit of [v=>v.receiptSha256='b'.repeat(64),v=>v.cases=[],v=>v.cases.push(v.cases[0]),v=>v.cases[0].phase='warm',v=>v.cases[0].override=true]){
  const bad=structuredClone(certificate);edit(bad);await assert.rejects(attachReviewedC06Receipt({receiptBytes,certificateBytes:JSON.stringify(bad),qualify}));
 }
 assert.equal(called,1);
});


test('C06 policy selection is opt-in with an explicit independently reviewed source digest',()=>{
 const sha='a'.repeat(64),args=['--compare','--source-lineage','--c06-review-policy','/private/tmp/policy.mjs','--c06-review-policy-sha256',sha];
 assert.equal(parseArguments(args).c06ReviewPolicySha256,sha);assert.equal(Object.hasOwn(parseArguments([]),'c06ReviewPolicy'),false);
 for(const bad of [args.filter(value=>value!=='--source-lineage'),args.slice(0,4),['--compare','--source-lineage','--c06-review-policy-sha256',sha],args.map(x=>x===sha?'invalid':x)])assert.throws(()=>parseArguments(bad));
});
test('C06 policy builder pins self-contained exact bytes and refuses hash/import/export/replacement drift',async()=>{
 const {buildC06ReviewPolicy}=await import('./benchmark-analytics-whole-workload.mjs');
 const directory=await mkdtemp(path.join(tmpdir(),'p11-c06-policy-check-')),source=path.join(directory,'policy.mjs'),output=path.join(directory,'built.mjs');
 const valid='export function c06IndependentReviewPolicy(input){return {contract:"synthetic-refusal",calls:input.reviewedAttempts};}\n';
 try{
  await writeFile(source,valid);const hash=createHash('sha256').update(valid).digest('hex');
  const result=await buildC06ReviewPolicy(source,hash,output);
  assert.equal(result.entrySha256,hash);assert.equal(result.bundleSha256,createHash('sha256').update(await readFile(output)).digest('hex'));
  assert.deepEqual(result.inputFiles,[{path:await realpath(source),sha256:hash}]);
  await assert.rejects(buildC06ReviewPolicy(source,'b'.repeat(64),path.join(directory,'wrong.mjs')),/hash differs/);
  await assert.rejects(buildC06ReviewPolicy(source,hash,output),/EEXIST/);
  for(const value of ['import x from "node:fs";'+valid,'export {x} from "./missing.mjs";'+valid,
   'export const c06IndependentReviewPolicy=()=>import("./missing.mjs");',
   'export const c06IndependentReviewPolicy=x=>import(x.path);',valid+'export const extra=1;',valid+'syntax error !!']){
   await writeFile(source,value);await assert.rejects(buildC06ReviewPolicy(source,createHash('sha256').update(value).digest('hex'),path.join(directory,'invalid.mjs')));
  }
  await writeFile(source,'x'.repeat(1024*1024+1));await assert.rejects(buildC06ReviewPolicy(source,hash,path.join(directory,'large.mjs')),/bound/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('actual main has one owned observer close path per lane and an outer finally for pre-dispatch failures',()=>{
 const main=matrixModule.main.toString();
 assert.equal((main.match(/const runtimeBridge=await runtimeOwner.begin/gu)||[]).length,1);
 assert.equal((main.match(/runtimeBridge\.close/gu)||[]).length,0);
 assert.equal((main.match(/runtimeBridge=null/gu)||[]).length,0);
 assert.equal((main.match(/await runtimeOwner.close\(\)/gu)||[]).length,2);
 assert.ok(main.includes('try{await finishInputGuard();}finally{await runtimeOwner.close();}'));
 assert.ok(main.includes('finally{try{await runtimeOwner.close();}finally{await laneBridge?.close();scaleExperiment?.close();}}'));
 // Config writes, input-guard acquisition and spawn all happen after ownership
 // is acquired and inside the outer try; any failure reaches that outer finally.
 const open=main.indexOf('const runtimeBridge=await runtimeOwner.begin');
 assert.ok(main.indexOf('await writeFile(configPath',open)>open);
 assert.ok(main.indexOf('await beginInputGuard(lane',open)>open);
 assert.ok(main.indexOf('const child=spawn(',open)>open);
 assert.ok(main.lastIndexOf('await runtimeOwner.close()')>main.lastIndexOf('const child=spawn('));
});
