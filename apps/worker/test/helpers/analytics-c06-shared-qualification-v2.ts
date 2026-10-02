import {C06_CONSUMERS,type C06Consumer,c06SourceLineageObserver} from './analytics-c06-source-lineage';
import {C06_OPERATION_SCOPES,c06ScopeConsumer,isC06OperationScope,
 type C06OperationScope} from './analytics-c06-operation-scope';

type Report=Awaited<ReturnType<ReturnType<typeof c06SourceLineageObserver>['report']>>;
type Measurement=Report['measurements'][number];
type BindPlan=Measurement['bindPlans'][number];
type PublicConsumer=Exclude<C06Consumer,'fixture'|'unclassified'>;
export const C06_V2_PUBLIC_CONSUMERS=C06_CONSUMERS.filter((value):value is PublicConsumer=>
 value!=='fixture'&&value!=='unclassified');
/** Scope names only delimit independent reviews. Presence here never certifies SQL. */
export const C06_V2_SHARED_SCOPES=Object.freeze([
 'scheduler_prelude','scheduler_coverage','scheduler_effects','scheduler_cache_publication_admission',
 'scheduler_rolling_admission','scheduler_canonical','scheduler_features',
 'scheduler_activity','scheduler_fits','scheduler_cleanup','scheduler_graph_owner',
 'scheduler_rolling_window',
] as const satisfies readonly C06OperationScope[]);
type SharedScope=(typeof C06_V2_SHARED_SCOPES)[number];
type Bucket='public'|'shared'|'diagnostic';
const HEX=/^[a-f0-9]{64}$/u;
const validCount=(value:number)=>Number.isSafeInteger(value)&&value>=0;
const same=(left:readonly string[],right:readonly string[])=>left.length===right.length
 &&[...left].sort().every((value,index)=>value===[...right].sort()[index]);
const sum=(values:readonly number[])=>values.reduce((total,value)=>total+value,0);
const key=(phase:string,scope:string,sql:string)=>JSON.stringify([phase,scope,sql]);
const isPublic=(value:C06Consumer):value is PublicConsumer=>
 (C06_V2_PUBLIC_CONSUMERS as readonly C06Consumer[]).includes(value);
const isShared=(value:C06OperationScope):value is SharedScope=>
 (C06_V2_SHARED_SCOPES as readonly C06OperationScope[]).includes(value);

/** Every product shape needs an independent review, including every observed
 * bind value. The observer supplies only one EXPLAIN representative per class;
 * the separate review receipt must cover the entire observed class. */
export interface C06V2ShapeCertificate {
 readonly bucket:Bucket;
 readonly phase:'warm'|'no_op'|'unrelated_append';
 readonly operationScope:C06OperationScope;
 readonly consumer:C06Consumer;
 readonly exactSqlSha256:string;
 readonly projectionSchemaSha256:string;
 readonly emptyProjectionReviewed:boolean;
 readonly metadataOnlyReviewed:boolean;
 readonly physical:readonly string[];
 readonly rootAccess:readonly string[];
 readonly columnAccess:readonly string[];
 readonly bindPlans:readonly (BindPlan&{
  readonly bindPredicateReviewed:true;
  readonly classPlanInvariantReviewed:true;
  readonly allObservedValuesReviewed:true;
  readonly reviewedAttempts:number;
  readonly independentReviewReceiptSha256:string;
 })[];
 readonly targetedIndexOrTableRoots:readonly string[];
 readonly maxRowsReadPerCall:number;
 readonly maxReturnedRowsPerCall:number;
}
export interface C06V2PhaseCertificate {
 readonly contract:'c06-shared-phase-certificate-v2';
 readonly kind:'warm'|'no_op'|'unrelated_append';
 readonly sourceSchemaSha256:string;
 readonly sourceLayoutSha256:string;
 readonly runtimeArtifactSha256:string;
 readonly shapes:readonly C06V2ShapeCertificate[];
}
export interface C06V2DiagnosticWindow {
 readonly beforeSourceCalls:number;
 readonly afterSourceCalls:number;
 readonly beforeProfileSourceCalls:number;
 readonly afterProfileSourceCalls:number;
 readonly beforeProductCalls:number;
 readonly afterProductCalls:number;
 readonly meteredStatements:number;
 readonly rowsRead:number;
 readonly rowsWritten:number;
 readonly boundaryReceiptSha256:string;
}
/** Supplied by the full-family runner and independent profile, never inferred
 * from the source census. Diagnostic inventory remains in whole-lane costs. */
export interface C06V2PhaseEvidence {
 readonly kind:C06V2PhaseCertificate['kind'];
 readonly lane:'candidate';
 readonly runtimeArtifactSha256:string;
 readonly acceptedInputReceiptSha256:string;
 readonly nativeFullOutputSha256:string;
 readonly candidateFullOutputSha256:string;
 readonly authorityAndFinalFencesPassed:boolean;
 readonly profiledSourceCalls:number;
 readonly meteredSourceCalls:number;
 readonly independentProfileReceiptSha256:string;
 readonly invocationMeterReceiptSha256:string;
 readonly wholeSourceRowsRead:number;
 readonly wholeSourceRowsWritten:number;
 readonly profilePerConsumer:Readonly<Record<C06Consumer,number>>;
 readonly profilePerOperation:Readonly<Record<C06OperationScope,number>>;
 readonly diagnosticMeterReceiptSha256:string;
 readonly diagnosticMeterStatements:number;
 readonly publicCompletions:readonly {
  readonly consumer:PublicConsumer;
  readonly entrypointCalls:number;
  readonly sourceCalls:number;
  readonly publicCompleteReceiptSha256:string;
 }[];
 readonly diagnosticInventory:{
  readonly contract:'c06-original-inventory-boundary-v1';
  readonly originalSqlSha256:readonly string[];
  readonly windows:readonly C06V2DiagnosticWindow[];
  readonly receiptSha256:string;
 };
}

/** This pure checker qualifies only an independently reviewed, fully attached
 * certificate. It neither manufactures certificates nor changes the v1 gate. */
export function qualifyC06SharedPhaseV2(report:Report,certificate:C06V2PhaseCertificate,
 evidence:C06V2PhaseEvidence){
 const refusals=new Set<string>(),refuse=(code:string)=>{refusals.add(code);};
 if(certificate.contract!=='c06-shared-phase-certificate-v2'||certificate.kind!==evidence.kind
  ||evidence.lane!=='candidate'||!HEX.test(certificate.runtimeArtifactSha256)
  ||certificate.runtimeArtifactSha256!==evidence.runtimeArtifactSha256
  ||certificate.sourceSchemaSha256!==report.schemaSha256||!HEX.test(certificate.sourceSchemaSha256)
  ||certificate.sourceLayoutSha256!==report.layoutSha256||!HEX.test(certificate.sourceLayoutSha256))
  refuse('C06_V2_SOURCE_IDENTITY');
 if(!report.resourceMeasured||!report.potentialAccessComplete||!report.meterReconciled
  ||!report.schemaStable||report.ddlAttempts!==0||report.boundaryFailures!==0
  ||!HEX.test(evidence.independentProfileReceiptSha256)
  ||!HEX.test(evidence.invocationMeterReceiptSha256)
  ||report.calls!==sum(report.measurements.map(row=>row.attempts))
  ||report.calls!==evidence.profiledSourceCalls||report.calls!==evidence.meteredSourceCalls
  ||report.measurements.some(row=>!validCount(row.attempts)||!validCount(row.rowsRead)||!validCount(row.rowsWritten))
  ||sum(report.measurements.map(row=>row.rowsRead))!==evidence.wholeSourceRowsRead
  ||sum(report.measurements.map(row=>row.rowsWritten))!==evidence.wholeSourceRowsWritten)
  refuse('C06_V2_CENSUS_OR_RESOURCE');
 if(!HEX.test(evidence.diagnosticMeterReceiptSha256)||!validCount(evidence.diagnosticMeterStatements)
  ||evidence.diagnosticMeterStatements!==report.diagnosticStatements+report.schemaSetupStatements
  ||evidence.diagnosticMeterStatements>950)refuse('C06_V2_DIAGNOSTIC_METER');
 if(!HEX.test(evidence.acceptedInputReceiptSha256)||!HEX.test(evidence.nativeFullOutputSha256)
  ||evidence.nativeFullOutputSha256!==evidence.candidateFullOutputSha256
  ||!evidence.authorityAndFinalFencesPassed)refuse('C06_V2_OUTPUT_OR_FENCE');
 if(Object.keys(evidence.profilePerConsumer).length!==C06_CONSUMERS.length
  ||C06_CONSUMERS.some(consumer=>!validCount(evidence.profilePerConsumer[consumer])
   ||report.perConsumer[consumer]?.attempts!==evidence.profilePerConsumer[consumer])
  ||Object.keys(evidence.profilePerOperation).length!==C06_OPERATION_SCOPES.length
  ||C06_OPERATION_SCOPES.some(scope=>!validCount(evidence.profilePerOperation[scope])
   ||sum(report.measurements.filter(row=>row.operationScope===scope).map(row=>row.attempts))
    !==evidence.profilePerOperation[scope])
  ||sum(C06_CONSUMERS.map(consumer=>evidence.profilePerConsumer[consumer]))!==report.calls
  ||sum(C06_OPERATION_SCOPES.map(scope=>evidence.profilePerOperation[scope]))!==report.calls)
  refuse('C06_V2_INDEPENDENT_COUNTS');
 if(evidence.publicCompletions.length!==C06_V2_PUBLIC_CONSUMERS.length
  ||new Set(evidence.publicCompletions.map(row=>row.consumer)).size!==C06_V2_PUBLIC_CONSUMERS.length
  ||evidence.publicCompletions.some(row=>!isPublic(row.consumer)||!validCount(row.entrypointCalls)
   ||row.entrypointCalls===0||!validCount(row.sourceCalls)||!HEX.test(row.publicCompleteReceiptSha256)
   ||row.sourceCalls!==report.perConsumer[row.consumer]?.attempts
   ||row.sourceCalls!==evidence.profilePerConsumer[row.consumer]
   ||report.consumerCompletions[row.consumer]?.entrypointCalls!==row.entrypointCalls
   ||!report.consumerCompletions[row.consumer]?.publicCompleteReceiptSha256.includes(row.publicCompleteReceiptSha256)))
  refuse('C06_V2_PUBLIC_COMPLETION');

 const buckets={public:0,shared:0,diagnostic:0};
 const observedKeys=new Set<string>();
 for(const row of report.measurements){
  const scope=row.operationScope,consumer=row.consumer;
  if(!isC06OperationScope(scope)||row.phase!==certificate.kind){
   refuse('C06_V2_UNKNOWN_SCOPE');continue;
  }
  const bucket:Bucket=scope==='fixture'&&consumer==='fixture'?'diagnostic'
   :isShared(scope)&&consumer==='unclassified'?'shared'
    :isPublic(consumer)&&c06ScopeConsumer(scope)===consumer?'public':'shared';
  if(scope==='unclassified'||scope==='scheduler_shared'
   ||bucket==='shared'&&(!isShared(scope)||consumer!=='unclassified'))refuse('C06_V2_UNKNOWN_SCOPE');
  buckets[bucket]+=row.attempts;
  observedKeys.add(key(row.phase,scope,row.exactSqlSha256));
 }
 if(certificate.shapes.length!==report.measurements.length
  ||new Set(certificate.shapes.map(row=>key(row.phase,row.operationScope,row.exactSqlSha256))).size
    !==certificate.shapes.length||observedKeys.size!==report.measurements.length)
  refuse('C06_V2_SHAPE_COVERAGE');
 const reviews=new Map(certificate.shapes.map(row=>[key(row.phase,row.operationScope,row.exactSqlSha256),row]));
 for(const row of report.measurements){
  if(!isC06OperationScope(row.operationScope)||row.phase!==certificate.kind){
   refuse('C06_V2_UNKNOWN_SCOPE');continue;
  }
  const review=reviews.get(key(row.phase,row.operationScope,row.exactSqlSha256));
  if(!review){refuse('C06_V2_UNREVIEWED_SQL');continue;}
  const bucket:Bucket=row.operationScope==='fixture'&&row.consumer==='fixture'?'diagnostic'
   :isShared(row.operationScope)&&row.consumer==='unclassified'?'shared':'public';
  if(review.bucket!==bucket||review.consumer!==row.consumer||review.phase!==row.phase
   ||review.operationScope!==row.operationScope||!HEX.test(review.exactSqlSha256))
   refuse('C06_V2_SCOPE_OR_SHAPE');
  if(!same(review.physical,row.physical)||!same(review.rootAccess,row.rootAccess)
   ||!same(review.columnAccess,row.columnAccess)||row.unknownRoots.length!==0
   ||row.nonMainOpens.length!==0||row.virtualOpens!==0||row.unknownColumns!==0
   ||row.programCalls!==0||row.opaquePayloadOps!==0||row.writeOpens!==0
   ||row.diagnosticFailure||row.unmeasured||row.failures!==0||row.unknownExecution!==0)
   refuse('C06_V2_PHYSICAL_ACCESS');
  if(row.bindPlans.length!==review.bindPlans.length
   ||sum(row.bindPlans.map(plan=>plan.attempts))!==row.attempts
   ||new Set(review.bindPlans.map(plan=>plan.bindClass)).size!==review.bindPlans.length)
   refuse('C06_V2_BIND_COVERAGE');
  for(const observed of row.bindPlans){
   const expected=review.bindPlans.find(plan=>plan.bindClass===observed.bindClass);
   if(!expected||!expected.bindPredicateReviewed||!expected.classPlanInvariantReviewed
    ||!expected.allObservedValuesReviewed||!HEX.test(expected.independentReviewReceiptSha256)
    ||expected.reviewedAttempts!==observed.attempts||observed.bindClass.includes('unsupported')
    ||expected.planSha256!==observed.planSha256||expected.opcodeSha256!==observed.opcodeSha256
    ||!same(expected.rootAccess,observed.rootAccess)||!same(expected.columnAccess,observed.columnAccess)
    ||!same(expected.seekRoots,observed.seekRoots)||!same(expected.iterateRoots,observed.iterateRoots))
    refuse('C06_V2_BIND_COVERAGE');
   for(const root of review.targetedIndexOrTableRoots)
    if(!observed.seekRoots.includes(root))refuse('C06_V2_UNBOUNDED_LOOKUP');
  }
  if(bucket==='diagnostic')continue;
  if(!review.metadataOnlyReviewed||!HEX.test(review.projectionSchemaSha256)
   ||review.projectionSchemaSha256!==row.projectionSchemaSha256
   ||row.emptyResults>0&&!review.emptyProjectionReviewed||row.invalidMetadataFields!==0)
   refuse('C06_V2_PROJECTION');
  if(!validCount(review.maxRowsReadPerCall)||!validCount(review.maxReturnedRowsPerCall)
   ||row.maxRowsRead>review.maxRowsReadPerCall||row.maxReturnedRows>review.maxReturnedRowsPerCall
   ||row.rowsWritten!==0||row.maxRowsWritten!==0||row.physicalSeek==='unknown'
   ||row.physicalSeek==='history_scan_or_other_scan_unresolved')refuse('C06_V2_ROW_BOUND');
  if(review.targetedIndexOrTableRoots.length===0
   &&row.physical.some(name=>/^(?:telemetry_|typed_)/u.test(name)
    &&name!=='telemetry_usage_correction_runtime'))refuse('C06_V2_UNBOUNDED_LOOKUP');
 }
 if(certificate.kind==='warm'||certificate.kind==='no_op'){
  if(evidence.wholeSourceRowsWritten!==0)refuse('C06_V2_SOURCE_WRITE');
 }else refuse('C06_V2_MUTATION_ACK_REQUIRED');
 const inventory=evidence.diagnosticInventory;
 const fixtureRows=report.measurements.filter(row=>row.consumer==='fixture'&&row.operationScope==='fixture');
 if(inventory.contract!=='c06-original-inventory-boundary-v1'||!HEX.test(inventory.receiptSha256)
  ||!same(inventory.originalSqlSha256,fixtureRows.map(row=>row.exactSqlSha256))
  ||inventory.windows.some((window,index)=>window.afterSourceCalls>report.calls
   ||window.afterProfileSourceCalls>report.calls
   ||index>0&&inventory.windows[index-1]!.afterSourceCalls>window.beforeSourceCalls
   ||index>0&&inventory.windows[index-1]!.afterProfileSourceCalls>window.beforeProfileSourceCalls)
  ||inventory.windows.some(window=>!HEX.test(window.boundaryReceiptSha256)
   ||![window.beforeSourceCalls,window.afterSourceCalls,window.beforeProfileSourceCalls,
    window.afterProfileSourceCalls,window.beforeProductCalls,window.afterProductCalls,
    window.meteredStatements,window.rowsRead,window.rowsWritten].every(validCount)
   ||window.afterSourceCalls<window.beforeSourceCalls
   ||window.afterProfileSourceCalls<window.beforeProfileSourceCalls
   ||window.beforeProductCalls!==window.afterProductCalls
   ||window.afterSourceCalls-window.beforeSourceCalls!==window.afterProfileSourceCalls-window.beforeProfileSourceCalls
   ||window.meteredStatements!==window.afterSourceCalls-window.beforeSourceCalls)
  ||sum(inventory.windows.map(window=>window.meteredStatements))!==buckets.diagnostic
  ||sum(inventory.windows.map(window=>window.rowsRead))!==sum(fixtureRows.map(row=>row.rowsRead))
  ||sum(inventory.windows.map(window=>window.rowsWritten))!==sum(fixtureRows.map(row=>row.rowsWritten))
  ||buckets.diagnostic!==evidence.profilePerConsumer.fixture)
  refuse('C06_V2_DIAGNOSTIC_BOUNDARY');
 return {contract:'c06-shared-phase-qualification-v2' as const,kind:evidence.kind,
  qualified:refusals.size===0,refusalCodes:[...refusals].sort(),
  buckets,sourceCalls:report.calls,sourceRowsRead:evidence.wholeSourceRowsRead,
  sourceRowsWritten:evidence.wholeSourceRowsWritten,reviewedShapes:report.measurements.length,
  sourceSchemaSha256:report.schemaSha256,noRescanQualified:refusals.size===0};
}
