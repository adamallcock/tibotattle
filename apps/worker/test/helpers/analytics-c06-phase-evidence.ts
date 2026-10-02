import {canonicalJson} from '../../src/canonical-json';
import {sha256Hex} from '../../src/crypto';
import type {AnalyticsStatementObservation} from './analytics-profile';
import {C06_CONSUMERS,type C06Consumer,c06SourceLineageObserver} from './analytics-c06-source-lineage';
import {C06_OPERATION_SCOPES,c06ScopeConsumer,type C06OperationScope} from './analytics-c06-operation-scope';
import type {C06V2DiagnosticWindow,C06V2PhaseEvidence} from './analytics-c06-shared-qualification-v2';

type Counters=ReturnType<ReturnType<typeof c06SourceLineageObserver>['snapshotCounters']>;
type Report=Awaited<ReturnType<ReturnType<typeof c06SourceLineageObserver>['report']>>;
export interface C06InvocationEvidence {contract:'actual-whole-invocation-reconciliation-v1';invocations:number;
 actualStatements:number;profiledStatements:number;sourceStatements:number;failedReconciliations:number;activeInvocations:number;}
export interface C06PhaseProvenance {contract:'retained-source-phase-v1';phase:'warm'|'no_op'|'unrelated_append';
 acceptedSourceReceiptSha256:string;priorCompleteOutputSha256:string;analyticalNowMs:number;storesRetained:true;
 action:'none'|'native-no-op-v2'|'native-append-v2';actionReceiptSha256:string|null;}
const nat=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const digest=(value:unknown)=>sha256Hex(canonicalJson(value));
/** Independent profile input and observer window counters meet only here. Raw
 * SQL stays private until hashed; no bindings/results/identities are retained. */
export function createC06PhaseEvidenceRecorder(readObserver:()=>Counters){
 const perConsumer=Object.fromEntries(C06_CONSUMERS.map(name=>[name,0])) as Record<C06Consumer,number>;
 const perOperation=Object.fromEntries(C06_OPERATION_SCOPES.map(name=>[name,0])) as Record<C06OperationScope,number>;
 const fixtureSql=new Set<string>(),gaps=new Set<string>();
 let sourceCalls=0,productCalls=0,rowsRead=0,rowsWritten=0,fixtureReads=0,fixtureWrites=0,active:object|null=null;
 const windows:Array<Omit<C06V2DiagnosticWindow,'boundaryReceiptSha256'>>=[];
 const tokens=new WeakMap<object,{observer:Counters;profile:{sourceCalls:number;productCalls:number;rowsRead:number;rowsWritten:number}}>();
 const snap=()=>({sourceCalls,productCalls,rowsRead,rowsWritten});
 const valid=(value:Counters)=>[value.sourceCalls,value.productCalls,value.rowsRead,value.rowsWritten,value.boundaryFailures].every(nat);
 const observe=(row:AnalyticsStatementObservation)=>{
  if(row.side!=='source')return;sourceCalls++;
  const scope=row.operationScope??'unclassified',consumer=c06ScopeConsumer(scope);
  perOperation[scope]++;perConsumer[consumer]++;
  if(scope==='fixture'&&consumer==='fixture'){
   if(fixtureSql.size>=1024&&!fixtureSql.has(row.sql))gaps.add('C06_EVIDENCE_SHAPE_BOUND');else fixtureSql.add(row.sql);
  }else productCalls++;
  if(row.outcome!=='success'||!nat(row.rowsRead)||!nat(row.rowsWritten))gaps.add('C06_EVIDENCE_FAILED_RESOURCE');
  else{rowsRead+=row.rowsRead;rowsWritten+=row.rowsWritten;if(scope==='fixture'){fixtureReads+=row.rowsRead;fixtureWrites+=row.rowsWritten;}}
  if(![sourceCalls,productCalls,rowsRead,rowsWritten].every(nat))gaps.add('C06_EVIDENCE_NUMERIC_BOUND');
 };
 const beginFixture=()=>{
  if(active){gaps.add('C06_EVIDENCE_OVERLAPPING_WINDOW');throw Error('C06_EVIDENCE_OVERLAPPING_WINDOW');}
  const observer=readObserver();if(!valid(observer)||observer.boundaryFailures!==0)gaps.add('C06_EVIDENCE_OBSERVER_BOUNDARY');
  const token=Object.freeze({});tokens.set(token,{observer,profile:snap()});active=token;return token;
 };
 const endFixture=(token:object,succeeded:boolean)=>{
  const before=tokens.get(token);if(!before||active!==token){gaps.add('C06_EVIDENCE_UNKNOWN_WINDOW');throw Error('C06_EVIDENCE_UNKNOWN_WINDOW');}
  tokens.delete(token);active=null;const after=readObserver(),profile=snap();
  if(!succeeded)gaps.add('C06_EVIDENCE_FAILED_WINDOW');
  if(!valid(after)||after.boundaryFailures!==0)gaps.add('C06_EVIDENCE_OBSERVER_BOUNDARY');
  const delta=after.sourceCalls-before.observer.sourceCalls,profileDelta=profile.sourceCalls-before.profile.sourceCalls;
  if(delta!==profileDelta||before.observer.productCalls!==after.productCalls||before.profile.productCalls!==profile.productCalls
   ||delta<0||before.observer.sourceCalls!==before.profile.sourceCalls||after.sourceCalls!==profile.sourceCalls
   ||after.rowsRead-before.observer.rowsRead!==profile.rowsRead-before.profile.rowsRead
   ||after.rowsWritten-before.observer.rowsWritten!==profile.rowsWritten-before.profile.rowsWritten)gaps.add('C06_EVIDENCE_WINDOW_RECONCILIATION');
  if(delta===0&&profileDelta===0)return;
  if(windows.length>=4096){gaps.add('C06_EVIDENCE_WINDOW_BOUND');return;}
  windows.push({beforeSourceCalls:before.observer.sourceCalls,afterSourceCalls:after.sourceCalls,
   beforeProfileSourceCalls:before.profile.sourceCalls,afterProfileSourceCalls:profile.sourceCalls,
   beforeProductCalls:before.observer.productCalls,afterProductCalls:after.productCalls,
   meteredStatements:profileDelta,rowsRead:profile.rowsRead-before.profile.rowsRead,rowsWritten:profile.rowsWritten-before.profile.rowsWritten});
 };
 const finish=async(input:{phase:'warm'|'no_op'|'unrelated_append';provenance:C06PhaseProvenance|undefined;report:Report;
  invocation:C06InvocationEvidence;runtimeArtifactSha256:string;ownFullOutputSha256:string;diagnosticMeterStatements:number;diagnosticMeterReceipt:unknown})=>{
  if(active)gaps.add('C06_EVIDENCE_OPEN_WINDOW');
  if(windows.reduce((n,w)=>n+w.meteredStatements,0)!==perConsumer.fixture||windows.reduce((n,w)=>n+w.rowsRead,0)!==fixtureReads||windows.reduce((n,w)=>n+w.rowsWritten,0)!==fixtureWrites)gaps.add('C06_EVIDENCE_MISSING_FIXTURE_WINDOW');
  const p=input.provenance,m=input.invocation;
  if(!p||p.contract!=='retained-source-phase-v1'||p.phase!==input.phase||!hex(p.acceptedSourceReceiptSha256)||!hex(p.priorCompleteOutputSha256)
   ||!nat(p.analyticalNowMs)||p.storesRetained!==true
   ||(p.action==='none'?p.actionReceiptSha256!==null:!['native-no-op-v2','native-append-v2'].includes(p.action)||!hex(p.actionReceiptSha256))
   ||input.phase==='warm'&&p.action!=='none'||input.phase==='no_op'&&!['none','native-no-op-v2'].includes(p.action))gaps.add('C06_PHASE_PROVENANCE');
  if(m.contract!=='actual-whole-invocation-reconciliation-v1'||m.activeInvocations!==0||m.failedReconciliations!==0
   ||![m.invocations,m.actualStatements,m.profiledStatements,m.sourceStatements].every(nat)||m.actualStatements!==m.profiledStatements||m.sourceStatements!==sourceCalls)gaps.add('C06_EVIDENCE_INVOCATION_METER');
  if(!hex(input.runtimeArtifactSha256)||!hex(input.ownFullOutputSha256))gaps.add('C06_EVIDENCE_OUTPUT_OR_BUNDLE');
  const originalSqlSha256=await Promise.all([...fixtureSql].map(sql=>sha256Hex(sql)));
  const inventoryWindows=await Promise.all(windows.map(async window=>({...window,boundaryReceiptSha256:await digest(window)})));
  const inventory={contract:'c06-original-inventory-boundary-v1' as const,originalSqlSha256,windows:inventoryWindows,
   receiptSha256:await digest({originalSqlSha256,windows:inventoryWindows})};
  const evidence:Omit<C06V2PhaseEvidence,'nativeFullOutputSha256'>={kind:input.phase,lane:'candidate',runtimeArtifactSha256:input.runtimeArtifactSha256,
   acceptedInputReceiptSha256:p?await digest(p):'',candidateFullOutputSha256:input.ownFullOutputSha256,authorityAndFinalFencesPassed:gaps.size===0,
   profiledSourceCalls:sourceCalls,meteredSourceCalls:m.sourceStatements,independentProfileReceiptSha256:await digest({sourceCalls,rowsRead,rowsWritten,perConsumer,perOperation}),
   invocationMeterReceiptSha256:await digest(m),wholeSourceRowsRead:rowsRead,wholeSourceRowsWritten:rowsWritten,profilePerConsumer:{...perConsumer},profilePerOperation:{...perOperation},
   diagnosticMeterReceiptSha256:await digest(input.diagnosticMeterReceipt),diagnosticMeterStatements:input.diagnosticMeterStatements,
   publicCompletions:C06_CONSUMERS.filter((consumer):consumer is Exclude<C06Consumer,'fixture'|'unclassified'>=>consumer!=='fixture'&&consumer!=='unclassified').map(consumer=>({consumer,
    entrypointCalls:input.report.consumerCompletions[consumer]?.entrypointCalls??0,sourceCalls:perConsumer[consumer],publicCompleteReceiptSha256:input.ownFullOutputSha256})),diagnosticInventory:inventory};
  return {contract:'c06-pending-paired-phase-evidence-v1' as const,complete:gaps.size===0,refusalCodes:[...gaps].sort(),provenance:p??null,
   evidence,invocation:m,noRescanQualified:false as const};
 };
 return {observe,beginFixture,endFixture,finish};
}

export async function acceptedC06SourceReceiptSha256(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('C06_ACCEPTED_SOURCE_PROOF');
 const snapshot=value as Record<string,unknown>;
 const hashes=['sqlSha256','schemaSha256','rowidInventorySha256','autoIncrementSequenceSha256'];
 const counts=['exportStatements','exportedLogicalSqlBytes','rowidRows','typedRowsCompared'];
 if(snapshot.exactSchemaAndData!==true||snapshot.exactRowids!==true||hashes.some(key=>!hex(snapshot[key]))
  ||counts.some(key=>!nat(snapshot[key])))throw Error('C06_ACCEPTED_SOURCE_PROOF');
 return digest(Object.fromEntries([...hashes,...counts].map(key=>[key,snapshot[key]])));
}

import {qualifyC06SharedPhaseV2,type C06V2PhaseCertificate} from './analytics-c06-shared-qualification-v2';
export interface C06BindingReview {phase:string;operationScope:string;exactSqlSha256:string;bindClass:string;
 attempts:number;valuesSha256:string;independentReviewReceiptSha256:string;}
export interface C06AttachedPhaseReview {censusSha256:string;phaseEvidenceSha256:string;
 bindingReviews:readonly C06BindingReview[];certificate:C06V2PhaseCertificate;}
type Pending=Awaited<ReturnType<ReturnType<typeof createC06PhaseEvidenceRecorder>['finish']>>;
/** Separately attached qualification never rewrites diagnostic false. The host
 * first validates the complete paired receipt and supplies its actual peer hash. */
export async function attachC06PhaseQualification(input:{census:Record<string,unknown>;review:C06AttachedPhaseReview;
 expectedProvenance:C06PhaseProvenance;candidateBundleSha256:string;nativeFullOutputSha256:string;policyPin?:C06PolicyPin|null}){
 const failures=new Set<string>();let result:ReturnType<typeof qualifyC06SharedPhaseV2>|null=null;
 const refuse=(code:string)=>{failures.add(code);};
 const key=(row:{phase:string;operationScope:string;exactSqlSha256:string;bindClass:string})=>JSON.stringify([row.phase,row.operationScope,row.exactSqlSha256,row.bindClass]);
 try{
  const c=input.census,review=input.review,report=c.report as Report,pending=c.phaseEvidence as Pending;
  const independent=c.independentReview as Awaited<ReturnType<typeof runC06IndependentReview>>;
  if(!independent||independent.status!=='reviewed'||!input.policyPin
    ||canonicalJson(independent.policy)!==canonicalJson(input.policyPin)
    ||independent.reportSha256!==await digest(report)
    ||canonicalJson(independent.certificate)!==canonicalJson(review.certificate)
    ||canonicalJson(independent.bindingReviews)!==canonicalJson(review.bindingReviews))refuse('C06_ATTACH_INDEPENDENT_POLICY');
  else{
   const {policy,reportSha256,allValuesSha256,reviewedAttempts,certificate,bindingReviews}=independent;
   if(independent.reviewReceiptSha256!==await digest({policy,reportSha256,allValuesSha256,reviewedAttempts,certificate,bindingReviews})
    ||reviewedAttempts!==report.calls||!hex(allValuesSha256))refuse('C06_ATTACH_INDEPENDENT_POLICY');
  }
  if(c.lane!=='candidate'||c.status!=='diagnostic'||c.noRescanQualified!==false||c.candidateQualificationEligible!==true
   ||c.sourceCallCountsReconciled!==true||c.consumerCountsReconciled!==true||c.operationCountsReconciled!==true||c.diagnosticCountsReconciled!==true
   ||c.operationScopeFailures!==0||c.operationScopesComplete!==true)refuse('C06_ATTACH_CENSUS_BOUNDARY');
  if(review.censusSha256!==await digest(c)||review.phaseEvidenceSha256!==await digest(pending))refuse('C06_ATTACH_RECEIPT_BINDING');
  if(pending.contract!=='c06-pending-paired-phase-evidence-v1'||pending.complete!==true||pending.refusalCodes.length!==0
   ||canonicalJson(pending.provenance)!==canonicalJson(input.expectedProvenance)
   ||pending.evidence.acceptedInputReceiptSha256!==await digest(input.expectedProvenance)
   ||pending.evidence.runtimeArtifactSha256!==input.candidateBundleSha256
   ||pending.evidence.candidateFullOutputSha256!==input.nativeFullOutputSha256
   ||c.publicCompleteReceiptSha256!==input.nativeFullOutputSha256
   ||!hex(input.nativeFullOutputSha256)||!hex(input.candidateBundleSha256))refuse('C06_ATTACH_PHASE_PROVENANCE');
  const e=pending.evidence,m=pending.invocation,inventory=e.diagnosticInventory;
  if(e.invocationMeterReceiptSha256!==await digest(m)||m.failedReconciliations!==0||m.activeInvocations!==0
   ||m.actualStatements!==m.profiledStatements||m.sourceStatements!==report.calls
   ||e.independentProfileReceiptSha256!==await digest({sourceCalls:e.profiledSourceCalls,rowsRead:e.wholeSourceRowsRead,
    rowsWritten:e.wholeSourceRowsWritten,perConsumer:e.profilePerConsumer,perOperation:e.profilePerOperation})
   ||e.diagnosticMeterReceiptSha256!==await digest(c.diagnostics))refuse('C06_ATTACH_METER_HASH');
  for(const window of inventory.windows){const {boundaryReceiptSha256,...values}=window;
   if(boundaryReceiptSha256!==await digest(values))refuse('C06_ATTACH_WINDOW_HASH');}
  if(inventory.receiptSha256!==await digest({originalSqlSha256:inventory.originalSqlSha256,windows:inventory.windows}))refuse('C06_ATTACH_WINDOW_HASH');
  const bindingEvidence=report.bindingEvidence;
  if(!bindingEvidence||bindingEvidence.contract!=='c06-exact-bind-values-v1'||!bindingEvidence.complete
   ||bindingEvidence.gaps!==0||bindingEvidence.bytes>bindingEvidence.maximumBytes||bindingEvidence.maximumBytes!==8*1024*1024)refuse('C06_ATTACH_BIND_WITNESS');
  const reviews=new Map(review.bindingReviews.map(row=>[key(row),row]));let plans=0;
  if(reviews.size!==review.bindingReviews.length)refuse('C06_ATTACH_BIND_WITNESS');
  for(const row of report.measurements)for(const plan of row.bindPlans){plans++;
   const witness=plan.bindingWitness,checked=reviews.get(key({...row,bindClass:plan.bindClass}));
   if(!witness||witness.contract!=='c06-exact-bind-values-v1'||witness.complete!==true||witness.capturedAttempts!==plan.attempts
    ||witness.attempts!==plan.attempts||!hex(witness.valuesSha256)||!checked||checked.attempts!==plan.attempts
    ||checked.valuesSha256!==witness.valuesSha256||!hex(checked.independentReviewReceiptSha256))refuse('C06_ATTACH_BIND_WITNESS');
   const shape=review.certificate.shapes.find(shape=>shape.phase===row.phase&&shape.operationScope===row.operationScope&&shape.exactSqlSha256===row.exactSqlSha256);
   if(shape?.bindPlans.find(value=>value.bindClass===plan.bindClass)?.independentReviewReceiptSha256!==checked?.independentReviewReceiptSha256)refuse('C06_ATTACH_BIND_REVIEW');
  }
  if(plans!==review.bindingReviews.length)refuse('C06_ATTACH_BIND_WITNESS');
  result=qualifyC06SharedPhaseV2(report,review.certificate,{...e,nativeFullOutputSha256:input.nativeFullOutputSha256});
  for(const code of result.refusalCodes)refuse(code);
 }catch{refuse('C06_ATTACH_MALFORMED_OR_MISSING');}
 return {contract:'c06-attached-phase-qualification-v1' as const,qualified:failures.size===0,
  noRescanQualified:failures.size===0,refusalCodes:[...failures].sort(),
  censusSha256:await digest(input.census),reviewSha256:await digest(input.review),
  phaseProvenanceSha256:await digest(input.expectedProvenance),diagnosticRemainsUnqualified:true,
  qualification:result};
}

export interface C06PolicyPin {entrySha256:string;bundleSha256:string;}
type PrivateBindings=NonNullable<Awaited<ReturnType<ReturnType<typeof c06SourceLineageObserver>['privateBindingReview']>>>;
export interface C06IndependentPolicyInput {contract:'c06-independent-policy-input-v1';policy:C06PolicyPin;
 report:Report;bindings:PrivateBindings;reportSha256:string;allValuesSha256:string;reviewedAttempts:number;}
export type C06IndependentPolicy=(input:Readonly<C06IndependentPolicyInput>)=>unknown|Promise<unknown>;
function immutable<T>(value:T):T{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))immutable(child);Object.freeze(value);}return value;}
/** Explicitly selected, source-pinned policy receives bounded synthetic data in
 * memory. It has no DB handle and cannot supply census or completion counters. */
export async function runC06IndependentReview(input:{policy:C06IndependentPolicy|null;pin:C06PolicyPin|null;report:Report;bindings:PrivateBindings|null}){
 const started=performance.now();
 const refusal=(reason:string)=>({contract:'c06-independent-memory-review-v1' as const,status:'refused' as const,reason,
  reviewWallMs:performance.now()-started,noRescanQualified:false as const});
 if(input.policy===null&&input.pin===null)return {contract:'c06-independent-memory-review-v1' as const,status:'absent' as const,reason:'policy_not_selected',noRescanQualified:false as const};
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  if(typeof input.policy!=='function'||!input.pin||!hex(input.pin.entrySha256)||!hex(input.pin.bundleSha256))return refusal('policy_pin');
  const bindings=input.bindings,report=input.report;
  if(report.boundaryFailures!==0||report.ddlAttempts!==0||report.resourceMeasured!==true||report.schemaStable!==true||report.meterReconciled!==true
   ||report.potentialAccessComplete!==true||report.measurements.some(row=>row.failures!==0||row.unknownExecution!==0||row.unmeasured||row.diagnosticFailure))return refusal('observed_failure');
  if(!bindings||!bindings.complete||bindings.maximumBytes!==8*1024*1024||bindings.bytes>bindings.maximumBytes
   ||bindings.vectors.length>20000||!report.bindingEvidence?.complete||report.bindingEvidence.gaps!==0)return refusal('binding_capture');
  const bytes=bindings.vectors.reduce((n,vector)=>n+new TextEncoder().encode(vector).byteLength,0);
  if(bytes!==bindings.bytes||new Set(bindings.vectors).size!==bindings.vectors.length)return refusal('binding_capture');
  let attempts=0;const usedVectors=new Set<number>();const observed=new Map(report.measurements.map(row=>[JSON.stringify([row.phase,row.operationScope,row.exactSqlSha256]),row]));
  if(bindings.shapes.length!==observed.size||new Set(bindings.shapes.map(shape=>JSON.stringify([shape.phase,shape.operationScope,shape.exactSqlSha256]))).size!==observed.size)return refusal('binding_shape');
  for(const shape of bindings.shapes){const row=observed.get(JSON.stringify([shape.phase,shape.operationScope,shape.exactSqlSha256]));
   if(!row||shape.exactSqlSha256!==await sha256Hex(shape.sql)||shape.bindClasses.length!==row.bindPlans.length||new Set(shape.bindClasses.map(value=>value.bindClass)).size!==shape.bindClasses.length)return refusal('binding_shape');
   for(const sample of shape.bindClasses){const plan=row.bindPlans.find(plan=>plan.bindClass===sample.bindClass);
    if(!plan?.bindingWitness?.complete||plan.bindingWitness.capturedAttempts!==plan.attempts||plan.bindingWitness.attempts!==plan.attempts||sample.attempts!==plan.attempts||sample.vectors.some(v=>!nat(v.index)||v.index>=bindings.vectors.length||!nat(v.attempts)||v.attempts===0)
     ||new Set(sample.vectors.map(v=>v.index)).size!==sample.vectors.length||sample.vectors.reduce((n,v)=>n+v.attempts,0)!==sample.attempts)return refusal('binding_shape');
    for(const vector of sample.vectors)usedVectors.add(vector.index);
    const values=sample.vectors.map(v=>[bindings.vectors[v.index],v.attempts]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
    if(plan.bindingWitness.valuesSha256!==await sha256Hex(JSON.stringify(values)))return refusal('binding_digest');attempts+=sample.attempts;
   }
  }
  if(attempts!==report.calls||attempts>20000||usedVectors.size!==bindings.vectors.length)return refusal('binding_attempts');
  const reportSha256=await digest(report),allValuesSha256=await digest(bindings);
  const callbackInput:C06IndependentPolicyInput={contract:'c06-independent-policy-input-v1',policy:input.pin,report,bindings,reportSha256,allValuesSha256,reviewedAttempts:attempts};
  if(new TextEncoder().encode(JSON.stringify(callbackInput)).byteLength>12*1024*1024)return refusal('policy_input_bound');
  const snapshot=immutable(structuredClone(callbackInput));
  const returned=await Promise.race([Promise.resolve().then(()=>input.policy!(snapshot)),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),5000);})]) as Record<string,unknown>;
  if(!returned||Object.keys(returned).sort().join(',')!=='allValuesSha256,bindingReviews,certificate,contract,policyEntrySha256,reviewReceiptSha256,reviewedAttempts'
   ||returned.contract!=='c06-independent-policy-review-v1'||returned.policyEntrySha256!==input.pin.entrySha256
   ||returned.allValuesSha256!==allValuesSha256||returned.reviewedAttempts!==attempts||!hex(returned.reviewReceiptSha256))return refusal('policy_return');
  if(new TextEncoder().encode(JSON.stringify(returned)).byteLength>2*1024*1024)return refusal('policy_return_bound');
  const certificate=returned.certificate as C06V2PhaseCertificate,reviews=returned.bindingReviews as C06BindingReview[];
  if(!certificate||!Array.isArray(certificate.shapes)||certificate.shapes.length!==report.measurements.length
   ||!Array.isArray(reviews)||reviews.length!==report.measurements.reduce((n,row)=>n+row.bindPlans.length,0))return refusal('policy_return');
  // All strings that could otherwise carry private data are exact observed
  // schema/plan fields or closed hashes; discard every unknown property.
  const tuple=(row:{phase:string;operationScope:string;exactSqlSha256:string})=>JSON.stringify([row.phase,row.operationScope,row.exactSqlSha256]);
  if(new Set(certificate.shapes.map(tuple)).size!==certificate.shapes.length||new Set(reviews.map(row=>JSON.stringify([tuple(row),row.bindClass]))).size!==reviews.length)return refusal('policy_return');
  const safeShapes=[];
  for(const shape of certificate.shapes){const row=report.measurements.find(row=>row.phase===shape.phase&&row.operationScope===shape.operationScope&&row.exactSqlSha256===shape.exactSqlSha256);
   if(!row||!['public','shared','diagnostic'].includes(shape.bucket)||shape.consumer!==row.consumer||shape.projectionSchemaSha256!==row.projectionSchemaSha256
    ||['emptyProjectionReviewed','metadataOnlyReviewed'].some(key=>typeof Reflect.get(shape,key)!=='boolean')
    ||canonicalJson(shape.physical)!==canonicalJson(row.physical)||canonicalJson(shape.rootAccess)!==canonicalJson(row.rootAccess)
    ||canonicalJson(shape.columnAccess)!==canonicalJson(row.columnAccess)||!Array.isArray(shape.targetedIndexOrTableRoots)
    ||shape.targetedIndexOrTableRoots.some((root:unknown)=>typeof root!=='string'||!row.bindPlans.some(plan=>plan.seekRoots.includes(root)))
    ||!nat(shape.maxRowsReadPerCall)||!nat(shape.maxReturnedRowsPerCall)||shape.bindPlans.length!==row.bindPlans.length)return refusal('policy_return');
   if(new Set(shape.bindPlans.map((plan:{bindClass:string})=>plan.bindClass)).size!==shape.bindPlans.length)return refusal('policy_return');
   const safePlans=[];
   for(const plan of shape.bindPlans){const actual=row.bindPlans.find(value=>value.bindClass===plan.bindClass);
    if(!actual||plan.planSha256!==actual.planSha256||plan.opcodeSha256!==actual.opcodeSha256
     ||!['rootAccess','columnAccess','seekRoots','iterateRoots'].every(key=>canonicalJson(Reflect.get(plan,key))===canonicalJson(Reflect.get(actual,key)))
     ||plan.bindPredicateReviewed!==true||plan.classPlanInvariantReviewed!==true||plan.allObservedValuesReviewed!==true
     ||plan.reviewedAttempts!==actual.attempts||!hex(plan.independentReviewReceiptSha256))return refusal('policy_return');
    safePlans.push({...actual,bindPredicateReviewed:true as const,classPlanInvariantReviewed:true as const,allObservedValuesReviewed:true as const,
     reviewedAttempts:plan.reviewedAttempts,independentReviewReceiptSha256:plan.independentReviewReceiptSha256});
   }
   safeShapes.push({bucket:shape.bucket,phase:row.phase as C06V2PhaseCertificate['kind'],operationScope:row.operationScope,consumer:row.consumer,
    exactSqlSha256:row.exactSqlSha256,projectionSchemaSha256:row.projectionSchemaSha256,emptyProjectionReviewed:shape.emptyProjectionReviewed,
    metadataOnlyReviewed:shape.metadataOnlyReviewed,physical:row.physical,rootAccess:row.rootAccess,columnAccess:row.columnAccess,bindPlans:safePlans,
    targetedIndexOrTableRoots:shape.targetedIndexOrTableRoots,maxRowsReadPerCall:shape.maxRowsReadPerCall,maxReturnedRowsPerCall:shape.maxReturnedRowsPerCall});
  }
  const safeReviews:C06BindingReview[]=[];
  for(const review of reviews){const row=report.measurements.find(row=>row.phase===review.phase&&row.operationScope===review.operationScope&&row.exactSqlSha256===review.exactSqlSha256);
   const plan=row?.bindPlans.find(plan=>plan.bindClass===review.bindClass);
   if(!plan||review.attempts!==plan.attempts||review.valuesSha256!==plan.bindingWitness?.valuesSha256||!hex(review.independentReviewReceiptSha256))return refusal('policy_return');
   safeReviews.push({phase:review.phase,operationScope:review.operationScope,exactSqlSha256:review.exactSqlSha256,bindClass:review.bindClass,
    attempts:review.attempts,valuesSha256:review.valuesSha256,independentReviewReceiptSha256:review.independentReviewReceiptSha256});
  }
  if(certificate.contract!=='c06-shared-phase-certificate-v2'||!['warm','no_op','unrelated_append'].includes(certificate.kind)
   ||certificate.sourceSchemaSha256!==report.schemaSha256||certificate.sourceLayoutSha256!==report.layoutSha256||!hex(certificate.runtimeArtifactSha256))return refusal('policy_return');
  const safeCertificate:C06V2PhaseCertificate={contract:certificate.contract,kind:certificate.kind,sourceSchemaSha256:certificate.sourceSchemaSha256,
   sourceLayoutSha256:certificate.sourceLayoutSha256,runtimeArtifactSha256:certificate.runtimeArtifactSha256,shapes:safeShapes};
  const body={policy:input.pin,reportSha256,allValuesSha256,reviewedAttempts:attempts,certificate:safeCertificate,bindingReviews:safeReviews};
  if(returned.reviewReceiptSha256!==await digest(body))return refusal('policy_receipt_digest');
  return {contract:'c06-independent-memory-review-v1' as const,status:'reviewed' as const,...body,reviewReceiptSha256:returned.reviewReceiptSha256,
   reviewWallMs:performance.now()-started,noRescanQualified:false as const};
 }catch{return refusal('policy_callback_failed');}finally{if(timer!==undefined)clearTimeout(timer);}
}
