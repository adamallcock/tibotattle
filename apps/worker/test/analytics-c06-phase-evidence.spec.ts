import {expect,it} from 'vitest';
import {createC06PhaseEvidenceRecorder,type C06PhaseProvenance} from './helpers/analytics-c06-phase-evidence';
import type {AnalyticsStatementObservation} from './helpers/analytics-profile';
import {C06_CONSUMERS} from './helpers/analytics-c06-source-lineage';
const H='a'.repeat(64),B='b'.repeat(64);
function fixture(){
 const observer={sourceCalls:0,productCalls:0,rowsRead:0,rowsWritten:0,boundaryFailures:0};
 const recorder=createC06PhaseEvidenceRecorder(()=>({...observer}));
 const emit=(scope:'fixture'|'direct_daily'='fixture',overrides:Partial<AnalyticsStatementObservation>={})=>{
  const row:AnalyticsStatementObservation={sql:'SELECT synthetic_metadata FROM synthetic_catalog',phase:'scope_capture',side:'source',family:'read',method:'all',operationScope:scope,
   outcome:'success',rowsRead:1,rowsWritten:0,databaseMs:0,callWallMs:0,batchWallAllocation:false,boundLogicalBytes:0,resultLogicalBytes:0,...overrides};
  observer.sourceCalls++;if(scope!=='fixture')observer.productCalls++;observer.rowsRead+=row.rowsRead??0;observer.rowsWritten+=row.rowsWritten??0;recorder.observe(row);
 };
 const provenance:C06PhaseProvenance={contract:'retained-source-phase-v1',phase:'warm',acceptedSourceReceiptSha256:H,priorCompleteOutputSha256:B,analyticalNowMs:1,storesRetained:true,action:'none',actionReceiptSha256:null};
 const finish=(changes:Record<string,unknown>={})=>recorder.finish({phase:'warm',provenance,runtimeArtifactSha256:H,ownFullOutputSha256:B,
  invocation:{contract:'actual-whole-invocation-reconciliation-v1',invocations:1,actualStatements:observer.sourceCalls,profiledStatements:observer.sourceCalls,sourceStatements:observer.sourceCalls,failedReconciliations:0,activeInvocations:0},
  diagnosticMeterStatements:2,diagnosticMeterReceipt:{statements:2},report:{consumerCompletions:Object.fromEntries(C06_CONSUMERS.map(c=>[c,{entrypointCalls:1,publicCompleteReceiptSha256:[B]}]))} as Parameters<typeof recorder.finish>[0]['report'],...changes});
 return {observer,recorder,emit,finish,provenance};
}
it('keeps exact independently observed fixture windows and hashes without serializing SQL',async()=>{
 const f=fixture(),token=f.recorder.beginFixture();f.emit();f.recorder.endFixture(token,true);f.emit('direct_daily');
 const value=await f.finish();expect(value.complete).toBe(true);expect(value.noRescanQualified).toBe(false);
 expect(value.evidence.diagnosticInventory.windows[0]).toMatchObject({beforeSourceCalls:0,afterSourceCalls:1,beforeProductCalls:0,afterProductCalls:0,meteredStatements:1,rowsRead:1,rowsWritten:0});
 expect(value.evidence.diagnosticInventory.originalSqlSha256).toHaveLength(1);expect(JSON.stringify(value)).not.toContain('SELECT');
 expect(value.evidence.profiledSourceCalls).toBe(2);expect(value.evidence.publicCompletions).toHaveLength(8);
});
it('caught nested or unknown-window errors stay sticky after later valid work',async()=>{
 for(const unknown of [false,true]){const f=fixture(),token=f.recorder.beginFixture();
  expect(()=>unknown?f.recorder.endFixture({},true):f.recorder.beginFixture()).toThrow();f.emit();f.recorder.endFixture(token,true);f.emit('direct_daily');
  expect((await f.finish()).complete).toBe(false);}
});
it('refuses product interleaving, missing fixture windows and failed inventory work',async()=>{
 const interleaved=fixture(),token=interleaved.recorder.beginFixture();interleaved.emit();interleaved.emit('direct_daily');interleaved.recorder.endFixture(token,true);
 expect((await interleaved.finish()).refusalCodes).toContain('C06_EVIDENCE_WINDOW_RECONCILIATION');
 const missing=fixture();missing.emit();expect((await missing.finish()).refusalCodes).toContain('C06_EVIDENCE_MISSING_FIXTURE_WINDOW');
 const failed=fixture(),t=failed.recorder.beginFixture();failed.emit();failed.recorder.endFixture(t,false);expect((await failed.finish()).refusalCodes).toContain('C06_EVIDENCE_FAILED_WINDOW');
});
it('refuses independent call/resource mismatch and preserves observed failed resources',async()=>{
 const f=fixture(),token=f.recorder.beginFixture();f.emit();f.observer.rowsRead++;f.recorder.endFixture(token,true);
 expect((await f.finish()).refusalCodes).toContain('C06_EVIDENCE_WINDOW_RECONCILIATION');
 const failed=fixture();failed.emit('direct_daily',{outcome:'failed',rowsRead:null,rowsWritten:null});
 expect((await failed.finish()).refusalCodes).toContain('C06_EVIDENCE_FAILED_RESOURCE');
});
it('requires current-phase source, previous completion, action and exact analytical clock provenance',async()=>{
 for(const change of [{phase:'no_op'},{acceptedSourceReceiptSha256:''},{priorCompleteOutputSha256:''},{analyticalNowMs:-1},{storesRetained:false},{action:'native-append-v2',actionReceiptSha256:H}]){
  const f=fixture();expect((await f.finish({provenance:{...f.provenance,...change}})).refusalCodes).toContain('C06_PHASE_PROVENANCE');}
 expect((await fixture().finish({provenance:undefined})).complete).toBe(false);
});
it('does not substitute profile counters for a failed or active original invocation meter',async()=>{
 for(const change of [{actualStatements:1},{failedReconciliations:1},{activeInvocations:1},{sourceStatements:1}]){
  const f=fixture();const value=await f.finish({invocation:{contract:'actual-whole-invocation-reconciliation-v1',invocations:0,actualStatements:0,profiledStatements:0,sourceStatements:0,failedReconciliations:0,activeInvocations:0,...change}});
  expect(value.refusalCodes).toContain('C06_EVIDENCE_INVOCATION_METER');}
});

import {attachC06PhaseQualification,acceptedC06SourceReceiptSha256,runC06IndependentReview,type C06IndependentPolicyInput,type C06AttachedPhaseReview} from './helpers/analytics-c06-phase-evidence';
import {sha256Hex} from '../src/crypto';
import {canonicalJson} from '../src/canonical-json';
import {c06SourceLineageObserver} from './helpers/analytics-c06-source-lineage';
const digest=(value:unknown)=>sha256Hex(canonicalJson(value));
async function attachmentFixture(){
 const f=fixture();f.emit('direct_daily');
 const sql='SELECT member_count FROM synthetic WHERE id=?',sqlHash=await sha256Hex(sql),encoded=JSON.stringify([['number','1']]);
 const valuesHash=await sha256Hex(JSON.stringify([[encoded,1]]));
 const plan={bindClass:'int:1',attempts:1,planSha256:H,opcodeSha256:B,
  rootAccess:['OpenRead:index:synthetic_lookup'],columnAccess:['index:synthetic_lookup.id'],seekRoots:['index:synthetic_lookup'],iterateRoots:[],
  bindingWitness:{contract:'c06-exact-bind-values-v1' as const,attempts:1,capturedAttempts:1,complete:true,valuesSha256:valuesHash}};
 const measurement={consumer:'daily',phase:'warm',operationScope:'direct_daily',exactSqlSha256:sqlHash,attempts:1,failures:0,unknownExecution:0,
  rowsRead:1,rowsWritten:0,returnedRows:1,maxRowsRead:1,maxRowsWritten:0,maxReturnedRows:1,bindPlans:[plan],emptyResults:0,
  projectionSchemaSha256:H,invalidMetadataFields:0,physical:['source_meta'],rootAccess:plan.rootAccess,columnAccess:plan.columnAccess,
  unknownRoots:[],nonMainOpens:[],virtualOpens:0,unknownColumns:0,programCalls:0,opaquePayloadOps:0,writeOpens:0,
  diagnosticFailure:false,unmeasured:false,physicalSeek:'indexed_seek_potential'};
 const report={contract:'c06-source-lineage-synthetic-v1',calls:1,schemaSha256:H,layoutSha256:B,
  resourceMeasured:true,potentialAccessComplete:true,meterReconciled:true,schemaStable:true,ddlAttempts:0,boundaryFailures:0,
  diagnosticStatements:1,schemaSetupStatements:1,measurements:[measurement],bindingEvidence:{contract:'c06-exact-bind-values-v1',complete:true,bytes:new TextEncoder().encode(encoded).byteLength,maximumBytes:8*1024*1024,gaps:0,uniqueVectors:1,maximumVectors:20000},
  perConsumer:Object.fromEntries(C06_CONSUMERS.map(c=>[c,{attempts:c==='daily'?1:0}])),
  consumerCompletions:Object.fromEntries(C06_CONSUMERS.filter(c=>c!=='fixture'&&c!=='unclassified').map(c=>[c,{entrypointCalls:1,publicCompleteReceiptSha256:[B]}]))};
 const pending=await f.finish({report}),diagnostics={statements:2};
 const census={lane:'candidate',status:'diagnostic',noRescanQualified:false,candidateQualificationEligible:true,sourceCallCountsReconciled:true,
  consumerCountsReconciled:true,operationCountsReconciled:true,diagnosticCountsReconciled:true,operationScopeFailures:0,operationScopesComplete:true,
  publicCompleteReceiptSha256:B,report,phaseEvidence:pending,diagnostics};
 const review:C06AttachedPhaseReview={censusSha256:await digest(census),phaseEvidenceSha256:await digest(pending),
  bindingReviews:[{phase:'warm',operationScope:'direct_daily',exactSqlSha256:sqlHash,bindClass:'int:1',attempts:1,valuesSha256:valuesHash,independentReviewReceiptSha256:B}],
  certificate:{contract:'c06-shared-phase-certificate-v2',kind:'warm',sourceSchemaSha256:H,sourceLayoutSha256:B,runtimeArtifactSha256:H,
   shapes:[{bucket:'public',phase:'warm',operationScope:'direct_daily',consumer:'daily',exactSqlSha256:sqlHash,projectionSchemaSha256:H,emptyProjectionReviewed:true,
    metadataOnlyReviewed:true,physical:measurement.physical,rootAccess:plan.rootAccess,columnAccess:plan.columnAccess,
    bindPlans:[{...plan,bindPredicateReviewed:true,classPlanInvariantReviewed:true,allObservedValuesReviewed:true,reviewedAttempts:1,independentReviewReceiptSha256:B}],
    targetedIndexOrTableRoots:plan.seekRoots,maxRowsReadPerCall:1,maxReturnedRowsPerCall:1}]}};
 const bindings={contract:'c06-private-bind-dictionary-v1' as const,complete:true,vectors:[encoded],bytes:report.bindingEvidence.bytes,maximumBytes:8*1024*1024,
  shapes:[{sql,phase:'warm',operationScope:'direct_daily' as const,exactSqlSha256:sqlHash,bindClasses:[{bindClass:'int:1',attempts:1,vectors:[{index:0,attempts:1}]}]}]};
 const policyPin={entrySha256:H,bundleSha256:B};
 const policy=async(input:Readonly<C06IndependentPolicyInput>)=>({contract:'c06-independent-policy-review-v1',policyEntrySha256:input.policy.entrySha256,
  allValuesSha256:input.allValuesSha256,reviewedAttempts:input.reviewedAttempts,certificate:review.certificate,bindingReviews:review.bindingReviews,
  reviewReceiptSha256:await digest({policy:input.policy,reportSha256:input.reportSha256,allValuesSha256:input.allValuesSha256,reviewedAttempts:input.reviewedAttempts,certificate:review.certificate,bindingReviews:review.bindingReviews})});
 const hookInput={policy,pin:policyPin,report:report as unknown as C06IndependentPolicyInput['report'],bindings};
 const independentReview=await runC06IndependentReview(hookInput);expect(independentReview.status).toBe('reviewed');
 const reviewedCensus={...census,independentReview};review.censusSha256=await digest(reviewedCensus);
 return {census:reviewedCensus,review,expectedProvenance:f.provenance,candidateBundleSha256:H,nativeFullOutputSha256:B,policyPin,hookInput};
}
it('attaches independent exact binding review after full paired evidence without changing diagnostic false',async()=>{
 const f=await attachmentFixture(),before=canonicalJson(f.census);const result=await attachC06PhaseQualification(f);
 expect(result.refusalCodes).toEqual([]);expect(result.qualified).toBe(true);expect(canonicalJson(f.census)).toBe(before);expect(f.census.noRescanQualified).toBe(false);
});
it('refuses stale receipt/phase/counter/window provenance even with matching shape names',async()=>{
 for(const change of ['census','phase','provenance','meter','window','peer','bundle'] as const){
  const f=await attachmentFixture();
  if(change==='census')f.review.censusSha256=B;
  if(change==='phase')f.review.phaseEvidenceSha256=B;
  if(change==='provenance')f.expectedProvenance={...f.expectedProvenance,analyticalNowMs:2};
  if(change==='meter')f.census.phaseEvidence.invocation.actualStatements++;
  if(change==='window')f.census.phaseEvidence.evidence={...f.census.phaseEvidence.evidence,diagnosticInventory:{...f.census.phaseEvidence.evidence.diagnosticInventory,receiptSha256:H}};
  if(change==='peer')f.nativeFullOutputSha256=H;
  if(change==='bundle')f.candidateBundleSha256=B;
  expect((await attachC06PhaseQualification(f)).qualified,change).toBe(false);
 }
});
it('refuses absent/partial/value-changed binding witnesses or independent review',async()=>{
 for(const change of ['absent','partial','values','review','duplicate','attempts'] as const){
  const f=await attachmentFixture();const witness=f.census.report.measurements[0]!.bindPlans[0]!.bindingWitness;
  if(change==='absent')Reflect.deleteProperty(f.census.report,'bindingEvidence');
  if(change==='partial')witness.complete=false;
  if(change==='values')witness.valuesSha256=B;
  if(change==='review')f.review.bindingReviews=[];
  if(change==='duplicate')f.review.bindingReviews=[...f.review.bindingReviews,...f.review.bindingReviews];
  if(change==='attempts')witness.capturedAttempts=0;
  f.review.censusSha256=await digest(f.census);
  expect((await attachC06PhaseQualification(f)).refusalCodes,change).toContain('C06_ATTACH_BIND_WITNESS');
 }
});
it('retains shared-v2 unknown scope, missing completion and append refusal under an attached certificate',async()=>{
 for(const change of ['scope','completion','append'] as const){
  const f=await attachmentFixture();
  if(change==='scope'){f.census.report.measurements[0]!.operationScope='unclassified';f.review.certificate={...f.review.certificate,shapes:[{...f.review.certificate.shapes[0]!,operationScope:'unclassified'}]};}
  if(change==='completion')f.census.report.consumerCompletions.block!.entrypointCalls=0;
  if(change==='append')f.review.certificate={...f.review.certificate,kind:'unrelated_append'};
  f.review.censusSha256=await digest(f.census);expect((await attachC06PhaseQualification(f)).qualified).toBe(false);
 }
});
it('binds accepted source schema, rowids and empty-table sequence highwater separately from costs',async()=>{
 const source={exactSchemaAndData:true,exactRowids:true,sqlSha256:H,schemaSha256:H,rowidInventorySha256:H,autoIncrementSequenceSha256:H,
  exportStatements:1,exportedLogicalSqlBytes:1,rowidRows:1,typedRowsCompared:1};const first=await acceptedC06SourceReceiptSha256(source);
 expect(await acceptedC06SourceReceiptSha256({...source,unmeasuredExportWallMs:2})).toBe(first);
 expect(await acceptedC06SourceReceiptSha256({...source,autoIncrementSequenceSha256:B})).not.toBe(first);
 for(const change of [{exactRowids:false},{autoIncrementSequenceSha256:undefined},{typedRowsCompared:-1}])await expect(acceptedC06SourceReceiptSha256({...source,...change})).rejects.toThrow();
});
it('captures every exact typed bind vector privately and never serializes values into the census',async()=>{
 const fake={prepare:(sql:string)=>({bind(){return this;},async all(){return {success:true,meta:{rows_read:1,rows_written:0},results:sql.startsWith('SELECT type,name,tbl_name,rootpage')?[]:sql.startsWith('EXPLAIN')?[]:[{member_count:1}]};}})} as unknown as D1Database;
 const observer=c06SourceLineageObserver(fake,()=>({consumer:'daily',phase:'warm',operationScope:'direct_daily'}),{allowedPhases:['warm'],bindingEvidence:true});
 await observer.establishSchema(fake);
 await observer.source.prepare('SELECT member_count FROM synthetic WHERE id=?').bind('synthetic-private-a').all();
 await observer.source.prepare('SELECT member_count FROM synthetic WHERE id=?').bind('synthetic-private-b').all();
 const report=await observer.report({expectedSourceCalls:2,diagnosticDatabase:fake}),privateRows=(await observer.privateBindingReview())!;
 const plan=report.measurements[0]!.bindPlans[0]!;
 expect(plan.bindingWitness).toMatchObject({attempts:2,capturedAttempts:2,complete:true});
 expect(JSON.stringify(privateRows)).toContain('synthetic-private-a');expect(JSON.stringify(report)).not.toContain('synthetic-private-');
 expect(privateRows.vectors).toHaveLength(2);
 const typed=privateRows.shapes[0]!.bindClasses[0]!.vectors.map(row=>[privateRows.vectors[row.index],row.attempts]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
 expect(plan.bindingWitness!.valuesSha256).toBe(await sha256Hex(JSON.stringify(typed)));
});

// These are policy transport/refusal mechanics. No synthetic policy certifies a
// production SQL shape or a real whole-workload phase.
it('independent hook requires source/bundle pins and every exact actual vector before calling policy',async()=>{
 const f=await attachmentFixture();
 expect((await runC06IndependentReview({...f.hookInput,policy:null,pin:null})).status).toBe('absent');
 for(const change of ['pin','incomplete','vector','digest','class','shape','attempts','bytes','duplicate','count'] as const){
  let calls=0;const input={...f.hookInput,report:structuredClone(f.hookInput.report),bindings:structuredClone(f.hookInput.bindings),policy:async(value:Readonly<C06IndependentPolicyInput>)=>{calls++;return f.hookInput.policy(value);}};
  if(change==='pin')input.pin={...input.pin,entrySha256:'invalid'};
  if(change==='incomplete')input.bindings.complete=false;
  if(change==='vector')input.bindings.vectors[0]='[["number","2"]]';
  if(change==='digest')input.report.measurements[0]!.bindPlans[0]!.bindingWitness!.valuesSha256=B;
  if(change==='class')input.bindings.shapes[0]!.bindClasses[0]!.bindClass='int:2';
  if(change==='shape')input.bindings.shapes[0]!.sql+=' changed';
  if(change==='attempts')input.bindings.shapes[0]!.bindClasses[0]!.vectors[0]!.attempts=2;
  if(change==='bytes')input.bindings.bytes=8*1024*1024+1;
  if(change==='duplicate')input.bindings.vectors.push(input.bindings.vectors[0]!);
  if(change==='count')input.bindings.vectors=Array.from({length:20001},(_,index)=>String(index));
  expect((await runC06IndependentReview(input)).status,change).toBe('refused');expect(calls,change).toBe(0);
 }
});
it('policy receives frozen in-memory data and cannot replace plan, attempts, digest or closed receipt',async()=>{
 const f=await attachmentFixture();
 for(const change of ['throw','mutate','pin','plan','attempts','digest','receipt','extra','missing'] as const){
  const policy=async(input:Readonly<C06IndependentPolicyInput>)=>{
   expect(Object.isFrozen(input)).toBe(true);expect(Object.isFrozen(input.bindings.vectors)).toBe(true);
   if(change==='throw')throw Error('synthetic private policy error');
   if(change==='mutate'){input.bindings.vectors.push('private');}
   const value=structuredClone(await f.hookInput.policy(input));
   if(change==='pin')value.policyEntrySha256=B;
   if(change==='plan')Reflect.set(value.certificate.shapes[0]!.bindPlans[0]!,'opcodeSha256',H);
   if(change==='attempts')value.reviewedAttempts++;
   if(change==='digest')value.allValuesSha256=B;
   if(change==='receipt')value.reviewReceiptSha256=B;
   if(change==='extra')Reflect.set(value,'rawPrivateValue','synthetic-private-policy-output');
   if(change==='missing')Reflect.deleteProperty(value,'certificate');
   return value;
  };
  const result=await runC06IndependentReview({...f.hookInput,policy});
  expect(result.status,change).toBe('refused');expect(JSON.stringify(result)).not.toContain('private');
 }
});
it('attachment refuses absent or changed independent policy evidence despite a matching external certificate',async()=>{
 for(const change of ['absent','pin','receipt','attempts'] as const){const f=await attachmentFixture();
  if(change==='absent')Reflect.deleteProperty(f.census,'independentReview');
  if(change==='pin')f.policyPin={...f.policyPin,entrySha256:B};
  if(change==='receipt')Reflect.set(f.census.independentReview,'reviewReceiptSha256',B);
  if(change==='attempts')Reflect.set(f.census.independentReview,'reviewedAttempts',2);
  f.review.censusSha256=await digest(f.census);
  expect((await attachC06PhaseQualification(f)).refusalCodes,change).toContain('C06_ATTACH_INDEPENDENT_POLICY');
 }
});
function bindFake(){let dispatched=0;
 const database={prepare:(sql:string)=>({bind(){return this;},async all(){if(!sql.startsWith('EXPLAIN')&&!sql.startsWith('SELECT type,name,tbl_name,rootpage'))dispatched++;
  return {success:true,meta:{rows_read:1,rows_written:0},results:[]};}})} as unknown as D1Database;
 return {database,dispatched:()=>dispatched};
}
it('deduplicates exact bytes globally across shapes/classes and counts every repeated attempt',async()=>{
 const fake=bindFake(),observer=c06SourceLineageObserver(fake.database,()=>({consumer:'daily',phase:'warm',operationScope:'direct_daily'}),{allowedPhases:['warm'],bindingEvidence:true});
 await observer.establishSchema(fake.database);
 const value='x'.repeat(900000);
 for(let i=0;i<12;i++)await observer.source.prepare('SELECT member_count FROM synthetic_'+i+' WHERE id=?').bind(value).all();
 const bindings=(await observer.privateBindingReview())!,report=await observer.report({expectedSourceCalls:12,diagnosticDatabase:fake.database});
 expect(fake.dispatched()).toBe(12);expect(bindings.vectors).toHaveLength(1);expect(bindings.bytes).toBe(new TextEncoder().encode(JSON.stringify([['text',value]])).byteLength);
 expect(report.bindingEvidence).toMatchObject({complete:true,uniqueVectors:1,gaps:0});expect(bindings.shapes.reduce((n,row)=>n+row.bindClasses[0]!.attempts,0)).toBe(12);
});
it('aggregate overflow across different shapes stays refused while all original SQL dispatches remain counted',async()=>{
 const fake=bindFake(),observer=c06SourceLineageObserver(fake.database,()=>({consumer:'daily',phase:'warm',operationScope:'direct_daily'}),{allowedPhases:['warm'],bindingEvidence:true});
 await observer.establishSchema(fake.database);
 for(let i=0;i<12;i++)await observer.source.prepare('SELECT member_count FROM synthetic_'+i+' WHERE id=?').bind(String(i).padStart(2,'0')+'x'.repeat(900000)).all();
 const bindings=(await observer.privateBindingReview())!,report=await observer.report({expectedSourceCalls:12,diagnosticDatabase:fake.database});
 expect(fake.dispatched()).toBe(12);expect(bindings.complete).toBe(false);expect(bindings.bytes).toBeLessThanOrEqual(8*1024*1024);expect(bindings.vectors.length).toBeLessThan(12);
 expect(report.calls).toBe(12);expect(report.bindingEvidence!.gaps).toBeGreaterThan(0);
 expect(report.measurements.every(row=>row.bindPlans.every(plan=>plan.bindingWitness!.complete===false))).toBe(true);
 expect(report.measurements.some(row=>row.diagnosticFailure)).toBe(true);
 const result=await runC06IndependentReview({policy:()=>{throw Error('must not call');},pin:{entrySha256:H,bundleSha256:B},report,bindings});
 expect(result).toMatchObject({status:'refused'});
 expect(['binding_capture','observed_failure']).toContain(Reflect.get(result,'reason'));
});

it('actual caught observer or diagnostic failure refuses review even after successful later calls',async()=>{
 const f=await attachmentFixture();
 for(const change of ['boundary','sql','diagnostic','schema','metadata'] as const){let calls=0;const report=structuredClone(f.hookInput.report);
  if(change==='boundary')report.boundaryFailures=1;
  if(change==='sql')report.measurements[0]!.failures=1;
  if(change==='diagnostic')report.measurements[0]!.diagnosticFailure=true;
  if(change==='schema')report.schemaStable=false;
  if(change==='metadata')report.resourceMeasured=false;
  const result=await runC06IndependentReview({...f.hookInput,report,policy:()=>{calls++;return {};}});
  expect(result).toMatchObject({status:'refused',reason:'observed_failure'});expect(calls).toBe(0);
 }
});
