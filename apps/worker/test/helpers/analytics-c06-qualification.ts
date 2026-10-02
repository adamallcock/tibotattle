import {C06_CONSUMERS,type C06Consumer,c06SourceLineageObserver} from './analytics-c06-source-lineage';

type LineageReport=Awaited<ReturnType<ReturnType<typeof c06SourceLineageObserver>['report']>>;
type BindPlan=LineageReport['measurements'][number]['bindPlans'][number];

/** A private, source-reviewed certificate for one exact SQL shape. It is never
 * synthesized from the measurement it is intended to check. */
export interface C06ShapeCertificate {
  readonly consumer:C06Consumer;
  readonly phase:string;
  readonly exactSqlSha256:string;
  readonly projectionSchemaSha256:string;
  readonly emptyProjectionReviewed:boolean;
  readonly metadataOnlyReviewed:true;
  readonly physical:readonly string[];
  readonly rootAccess:readonly string[];
  readonly columnAccess:readonly string[];
  readonly bindPlans:readonly (BindPlan&{
    readonly bindPredicateReviewed:true;
    readonly classPlanInvariantReviewed:true;
  })[];
  readonly targetedIndexOrTableRoots:readonly string[];
  readonly maxRowsReadPerCall:number;
  readonly maxReturnedRowsPerCall:number;
}

export interface C06PhaseCertificate {
  readonly contract:'c06-source-phase-certificate-v1';
  readonly kind:'warm'|'no_op'|'unrelated_append';
  readonly sourceSchemaSha256:string;
  readonly sourceLayoutSha256:string;
  readonly runtimeArtifactSha256:string;
  readonly shapes:readonly C06ShapeCertificate[];
}

/** Supplied by the full-family runner, not inferred from zero source calls. */
export interface C06PhaseEvidence {
  readonly kind:C06PhaseCertificate['kind'];
  readonly runtimeArtifactSha256:string;
  readonly acceptedInputReceiptSha256:string;
  readonly nativeFullOutputSha256:string;
  readonly candidateFullOutputSha256:string;
  readonly authorityAndFinalFencesPassed:boolean;
  readonly diagnosticMeterReceiptSha256:string;
  readonly diagnosticMeterStatements:number;
  readonly consumers:readonly {
    readonly consumer:Exclude<C06Consumer,'fixture'|'unclassified'>;
    readonly entrypointCalls:number;
    readonly sourceCalls:number;
    readonly publicCompleteReceiptSha256:string;
  }[];
}

const HEX=/^[0-9a-f]{64}$/u;
function sameList(a:readonly string[],b:readonly string[]):boolean {
  if(a.length!==b.length)return false;
  const sortedA=[...a].sort(),sortedB=[...b].sort();
  return sortedA.every((value,index)=>value===sortedB[index]);
}
function validCount(value:number):boolean{return Number.isSafeInteger(value)&&value>=0;}

/** All closed refusal codes are aggregate only. The report is diagnostic and
 * stays noRescanQualified:false even when this separately reviewed layer passes. */
export function qualifyC06SourcePhase(report:LineageReport,
  certificate:C06PhaseCertificate,evidence:C06PhaseEvidence){
  const refusals=new Set<string>();
  const refuse=(code:string)=>{refusals.add(code);};
  if(certificate.contract!=='c06-source-phase-certificate-v1'||certificate.kind!==evidence.kind
    ||!HEX.test(certificate.runtimeArtifactSha256)||!HEX.test(evidence.runtimeArtifactSha256)
    ||certificate.runtimeArtifactSha256!==evidence.runtimeArtifactSha256
    ||!HEX.test(certificate.sourceSchemaSha256)||certificate.sourceSchemaSha256!==report.schemaSha256
    ||!HEX.test(certificate.sourceLayoutSha256)||certificate.sourceLayoutSha256!==report.layoutSha256)
    refuse('C06_SOURCE_IDENTITY');
  if(!report.resourceMeasured||!report.potentialAccessComplete||!report.meterReconciled
    ||!report.schemaStable||report.ddlAttempts!==0
    ||report.boundaryFailures!==0||report.calls!==report.measurements.reduce((sum,row)=>sum+row.attempts,0))
    refuse('C06_CENSUS_OR_RESOURCE');
  if(!HEX.test(evidence.diagnosticMeterReceiptSha256)
    ||!validCount(evidence.diagnosticMeterStatements)
    ||evidence.diagnosticMeterStatements!==report.diagnosticStatements+report.schemaSetupStatements
    ||evidence.diagnosticMeterStatements>950)refuse('C06_DIAGNOSTIC_METER');
  if(!HEX.test(evidence.acceptedInputReceiptSha256)
    ||!HEX.test(evidence.nativeFullOutputSha256)||!HEX.test(evidence.candidateFullOutputSha256)
    ||evidence.nativeFullOutputSha256!==evidence.candidateFullOutputSha256
    ||!evidence.authorityAndFinalFencesPassed)refuse('C06_OUTPUT_OR_FENCE');
  const required=C06_CONSUMERS.filter(consumer=>consumer!=='fixture'&&consumer!=='unclassified');
  if(evidence.consumers.length!==required.length
    ||new Set(evidence.consumers.map(row=>row.consumer)).size!==required.length
    ||evidence.consumers.some(row=>!required.includes(row.consumer)
      ||!validCount(row.entrypointCalls)||row.entrypointCalls===0||!validCount(row.sourceCalls)
      ||!HEX.test(row.publicCompleteReceiptSha256)
      ||report.perConsumer[row.consumer]?.attempts!==row.sourceCalls
      ||report.consumerCompletions[row.consumer]?.entrypointCalls!==row.entrypointCalls
      ||!report.consumerCompletions[row.consumer]?.publicCompleteReceiptSha256.includes(
        row.publicCompleteReceiptSha256))
    ||report.perConsumer.fixture?.attempts!==0
    ||report.perConsumer.unclassified?.attempts!==0)refuse('C06_CONSUMER_ENTRYPOINT');
  if(certificate.shapes.length!==report.measurements.length
    ||new Set(certificate.shapes.map(row=>JSON.stringify([row.consumer,row.phase,row.exactSqlSha256]))).size
      !==certificate.shapes.length)refuse('C06_SHAPE_COVERAGE');
  const reviews=new Map(certificate.shapes.map(row=>[
    JSON.stringify([row.consumer,row.phase,row.exactSqlSha256]),row,
  ]));
  for(const row of report.measurements){
    const review=reviews.get(JSON.stringify([row.consumer,row.phase,row.exactSqlSha256]));
    if(!review){refuse('C06_UNREVIEWED_SQL');continue;}
    if(!review.metadataOnlyReviewed||!HEX.test(review.projectionSchemaSha256)
      ||review.projectionSchemaSha256!==row.projectionSchemaSha256
      ||row.emptyResults>0&&!review.emptyProjectionReviewed
      ||row.invalidMetadataFields!==0)
      refuse('C06_PROJECTION');
    if(!sameList(review.physical,row.physical)||!sameList(review.rootAccess,row.rootAccess)
      ||!sameList(review.columnAccess,row.columnAccess)
      ||row.unknownRoots.length!==0||row.nonMainOpens.length!==0||row.virtualOpens!==0
      ||row.unknownColumns!==0||row.programCalls!==0||row.opaquePayloadOps!==0
      ||row.diagnosticFailure)
      refuse('C06_PHYSICAL_ACCESS');
    if(!validCount(review.maxRowsReadPerCall)||!validCount(review.maxReturnedRowsPerCall)
      ||row.maxRowsRead>review.maxRowsReadPerCall
      ||row.maxReturnedRows>review.maxReturnedRowsPerCall
      ||row.maxRowsWritten!==0||row.rowsWritten!==0||row.unmeasured
      ||row.failures!==0||row.unknownExecution!==0)
      refuse('C06_ROW_BOUND');
    if(row.bindPlans.reduce((sum,item)=>sum+item.attempts,0)!==row.attempts
      ||review.bindPlans.length!==row.bindPlans.length
      ||new Set(review.bindPlans.map(item=>item.bindClass)).size!==review.bindPlans.length)
      refuse('C06_BIND_CLASS');
    for(const observed of row.bindPlans){
      const expected=review.bindPlans.find(item=>item.bindClass===observed.bindClass);
      if(!expected||!expected.bindPredicateReviewed||!expected.classPlanInvariantReviewed
        ||observed.bindClass.includes('unsupported')
        ||expected.planSha256!==observed.planSha256
        ||expected.opcodeSha256!==observed.opcodeSha256
        ||!sameList(expected.rootAccess,observed.rootAccess)
        ||!sameList(expected.columnAccess,observed.columnAccess)
        ||!sameList(expected.seekRoots,observed.seekRoots)
        ||!sameList(expected.iterateRoots,observed.iterateRoots))refuse('C06_BIND_CLASS');
      for(const root of review.targetedIndexOrTableRoots){
        if(!observed.seekRoots.includes(root))refuse('C06_UNBOUNDED_LOOKUP');
      }
    }
    if(review.targetedIndexOrTableRoots.length===0
      &&row.physical.some(name=>/^(?:telemetry_|typed_)/u.test(name)
        &&name!=='telemetry_usage_correction_runtime'))refuse('C06_UNBOUNDED_LOOKUP');
    if(row.physicalSeek==='history_scan_or_other_scan_unresolved'
      ||row.physicalSeek==='unknown')refuse('C06_UNBOUNDED_LOOKUP');
  }
  return {contract:'c06-source-phase-qualification-v1' as const,kind:evidence.kind,
    qualified:refusals.size===0,refusalCodes:[...refusals].sort(),
    sourceCalls:report.calls,sourceRowsRead:report.measurements.reduce((sum,row)=>sum+row.rowsRead,0),
    reviewedShapes:report.measurements.length,diagnosticStatements:report.diagnosticStatements,
    sourceSchemaSha256:report.schemaSha256};
}
