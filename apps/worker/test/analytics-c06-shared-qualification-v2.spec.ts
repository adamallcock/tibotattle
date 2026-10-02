import {describe,expect,it} from 'vitest';
import {C06_CONSUMERS} from './helpers/analytics-c06-source-lineage';
import {C06_OPERATION_SCOPES} from './helpers/analytics-c06-operation-scope';
import {C06_V2_PUBLIC_CONSUMERS,qualifyC06SharedPhaseV2,
 type C06V2PhaseCertificate,type C06V2PhaseEvidence,type C06V2ShapeCertificate}
 from './helpers/analytics-c06-shared-qualification-v2';

type Report=Parameters<typeof qualifyC06SharedPhaseV2>[0];
const H='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const plan={bindClass:'int:1',attempts:1,planSha256:H,opcodeSha256:B,
 rootAccess:['OpenRead:index:synthetic_lookup'],columnAccess:['index:synthetic_lookup.id'],
 seekRoots:['index:synthetic_lookup'],iterateRoots:[]};
function row(consumer:'daily'|'unclassified'|'fixture',operationScope:'direct_daily'|'scheduler_coverage'|'fixture',
 exactSqlSha256:string,rowsRead:number){
 return {consumer,phase:'warm',operationScope,exactSqlSha256,attempts:1,failures:0,unknownExecution:0,
  rowsRead,rowsWritten:0,returnedRows:1,maxRowsRead:rowsRead,maxRowsWritten:0,maxReturnedRows:1,
  bindPlans:[plan],emptyResults:0,projectionSchemaSha256:H,invalidMetadataFields:0,
  physical:consumer==='fixture'?['telemetry_records']:['source_meta'],
  rootAccess:plan.rootAccess,columnAccess:plan.columnAccess,unknownRoots:[],nonMainOpens:[],
  virtualOpens:0,unknownColumns:0,programCalls:0,opaquePayloadOps:0,writeOpens:0,
  diagnosticFailure:false,unmeasured:false,physicalSeek:'indexed_seek_potential'};
}
function fixture(){
 const measurements=[row('fixture','fixture',H,5),row('daily','direct_daily',B,1),
  row('unclassified','scheduler_coverage',C,1)];
 const perConsumer=Object.fromEntries(C06_CONSUMERS.map(name=>[name,{attempts:name==='fixture'||name==='daily'||name==='unclassified'?1:0}]));
 const completions=Object.fromEntries(C06_V2_PUBLIC_CONSUMERS.map(name=>[name,
  {entrypointCalls:1,publicCompleteReceiptSha256:[D]}]));
 const report={contract:'c06-source-lineage-synthetic-v1',calls:3,schemaSha256:H,layoutSha256:B,
  resourceMeasured:true,potentialAccessComplete:true,meterReconciled:true,schemaStable:true,
  ddlAttempts:0,boundaryFailures:0,diagnosticStatements:1,schemaSetupStatements:1,
  measurements,perConsumer,consumerCompletions:completions} as unknown as Report;
 const shape=(item:typeof measurements[number],bucket:C06V2ShapeCertificate['bucket']):C06V2ShapeCertificate=>({
  bucket,phase:'warm',operationScope:item.operationScope,consumer:item.consumer,
  exactSqlSha256:item.exactSqlSha256,projectionSchemaSha256:H,
  emptyProjectionReviewed:true,metadataOnlyReviewed:bucket!=='diagnostic',
  physical:item.physical,rootAccess:item.rootAccess,columnAccess:item.columnAccess,
  bindPlans:[{...plan,bindPredicateReviewed:true,classPlanInvariantReviewed:true,
   allObservedValuesReviewed:true,reviewedAttempts:1,independentReviewReceiptSha256:D}],
  targetedIndexOrTableRoots:bucket==='diagnostic'?[]:['index:synthetic_lookup'],
  maxRowsReadPerCall:item.maxRowsRead,maxReturnedRowsPerCall:1,
 });
 const certificate:C06V2PhaseCertificate={contract:'c06-shared-phase-certificate-v2',kind:'warm',
  sourceSchemaSha256:H,sourceLayoutSha256:B,runtimeArtifactSha256:C,
  shapes:[shape(measurements[0]!,'diagnostic'),shape(measurements[1]!,'public'),shape(measurements[2]!,'shared')]};
 const perConsumerProfile=Object.fromEntries(C06_CONSUMERS.map(name=>[name,
  name==='fixture'||name==='daily'||name==='unclassified'?1:0])) as C06V2PhaseEvidence['profilePerConsumer'];
 const perOperationProfile=Object.fromEntries(C06_OPERATION_SCOPES.map(name=>[name,
  name==='fixture'||name==='direct_daily'||name==='scheduler_coverage'?1:0])) as C06V2PhaseEvidence['profilePerOperation'];
 const evidence:C06V2PhaseEvidence={kind:'warm',lane:'candidate',runtimeArtifactSha256:C,
  acceptedInputReceiptSha256:D,nativeFullOutputSha256:H,candidateFullOutputSha256:H,
  authorityAndFinalFencesPassed:true,profiledSourceCalls:3,meteredSourceCalls:3,
  independentProfileReceiptSha256:B,invocationMeterReceiptSha256:C,
  wholeSourceRowsRead:7,wholeSourceRowsWritten:0,
  profilePerConsumer:perConsumerProfile,profilePerOperation:perOperationProfile,
  diagnosticMeterReceiptSha256:B,diagnosticMeterStatements:2,
  publicCompletions:C06_V2_PUBLIC_CONSUMERS.map(consumer=>({consumer,entrypointCalls:1,
   sourceCalls:consumer==='daily'?1:0,publicCompleteReceiptSha256:D})),
  diagnosticInventory:{contract:'c06-original-inventory-boundary-v1',originalSqlSha256:[H],
   receiptSha256:C,windows:[{beforeSourceCalls:0,afterSourceCalls:1,
    beforeProfileSourceCalls:0,afterProfileSourceCalls:1,beforeProductCalls:0,afterProductCalls:0,
    meteredStatements:1,rowsRead:5,rowsWritten:0,boundaryReceiptSha256:D}]}};
 return {report,certificate,evidence};
}
const run=(value:ReturnType<typeof fixture>)=>qualifyC06SharedPhaseV2(value.report,value.certificate,value.evidence);

describe('closed C06 shared qualification v2',()=>{
 it('accepts only separately reviewed public, shared and diagnostic shapes with all eight real completions',()=>{
  const value=fixture(),result=run(value);
  expect(result).toMatchObject({qualified:true,noRescanQualified:true,refusalCodes:[],
   buckets:{public:1,shared:1,diagnostic:1},sourceCalls:3,sourceRowsRead:7});
  expect(value.evidence.publicCompletions).toHaveLength(8);
 });
 it('refuses unknown or generic shared scope, even if a matching shape certificate is supplied',()=>{
  for(const scope of ['scheduler_shared','unclassified'] as const){
   const value=fixture(),row=value.report.measurements[2]!;
   const changed={...row,operationScope:scope};
   const report={...value.report,measurements:[...value.report.measurements.slice(0,2),changed]};
   const certificate={...value.certificate,shapes:[...value.certificate.shapes.slice(0,2),
    {...value.certificate.shapes[2]!,operationScope:scope}]};
   expect(qualifyC06SharedPhaseV2(report,certificate,value.evidence).refusalCodes)
    .toContain('C06_V2_UNKNOWN_SCOPE');
  }
  const value=fixture(),changed={...value.report,measurements:[...value.report.measurements.slice(0,2),
   {...value.report.measurements[2]!,operationScope:'future_unknown_scope'}] as Report['measurements']};
  expect(qualifyC06SharedPhaseV2(changed,value.certificate,value.evidence).refusalCodes)
   .toContain('C06_V2_UNKNOWN_SCOPE');
 });
 it('refuses an observed phase that disagrees with the independently declared phase',()=>{
  const value=fixture(),changed={...value.report,measurements:value.report.measurements.map(row=>
   ({...row,phase:'no_op'}))};
  expect(qualifyC06SharedPhaseV2(changed,value.certificate,value.evidence).refusalCodes)
   .toContain('C06_V2_UNKNOWN_SCOPE');
 });
 it('keeps operation scope in the exact shape key and refuses missing independent review',()=>{
  const value=fixture();
  expect(run({...value,certificate:{...value.certificate,shapes:value.certificate.shapes.slice(0,2)}})
   .refusalCodes).toContain('C06_V2_UNREVIEWED_SQL');
  const changed={...value.certificate.shapes[2]!,operationScope:'scheduler_effects' as const};
  expect(run({...value,certificate:{...value.certificate,shapes:[...value.certificate.shapes.slice(0,2),changed]}})
   .refusalCodes).toContain('C06_V2_UNREVIEWED_SQL');
 });
 it('refuses count drift, an absent public completion and altered native output',()=>{
  const value=fixture();
  expect(run({...value,evidence:{...value.evidence,profiledSourceCalls:2}}).refusalCodes)
   .toContain('C06_V2_CENSUS_OR_RESOURCE');
  expect(run({...value,evidence:{...value.evidence,independentProfileReceiptSha256:''}}).refusalCodes)
   .toContain('C06_V2_CENSUS_OR_RESOURCE');
  expect(run({...value,evidence:{...value.evidence,profilePerOperation:{...value.evidence.profilePerOperation,
   scheduler_coverage:0}}}).refusalCodes).toContain('C06_V2_INDEPENDENT_COUNTS');
  expect(run({...value,evidence:{...value.evidence,publicCompletions:value.evidence.publicCompletions.slice(1)}})
   .refusalCodes).toContain('C06_V2_PUBLIC_COMPLETION');
  expect(run({...value,evidence:{...value.evidence,candidateFullOutputSha256:B}}).refusalCodes)
   .toContain('C06_V2_OUTPUT_OR_FENCE');
 });
 it('does not erase fixture inventory SQL, rows, or its independent boundary cost',()=>{
  const value=fixture(),inventory=value.evidence.diagnosticInventory;
  expect(run({...value,evidence:{...value.evidence,diagnosticInventory:{...inventory,originalSqlSha256:[B]}}})
   .refusalCodes).toContain('C06_V2_DIAGNOSTIC_BOUNDARY');
  expect(run({...value,evidence:{...value.evidence,diagnosticInventory:{...inventory,windows:[
   {...inventory.windows[0]!,rowsRead:0}]}}}).refusalCodes).toContain('C06_V2_DIAGNOSTIC_BOUNDARY');
  expect(run({...value,evidence:{...value.evidence,diagnosticInventory:{...inventory,windows:[
   {...inventory.windows[0]!,afterProductCalls:1}]}}}).refusalCodes).toContain('C06_V2_DIAGNOSTIC_BOUNDARY');
  expect(run({...value,evidence:{...value.evidence,diagnosticInventory:{...inventory,windows:[
   {...inventory.windows[0]!,afterSourceCalls:99}]}}}).refusalCodes).toContain('C06_V2_DIAGNOSTIC_BOUNDARY');
 });
 it('requires reviewed physical roots, metadata projection, every bind and actual row bound',()=>{
  const value=fixture(),original=value.certificate.shapes[1]!;
  const changed=(shape:C06V2ShapeCertificate)=>({...value,certificate:{...value.certificate,
   shapes:[value.certificate.shapes[0]!,shape,value.certificate.shapes[2]!]}});
  expect(run(changed({...original,physical:[]})).refusalCodes).toContain('C06_V2_PHYSICAL_ACCESS');
  expect(run(changed({...original,metadataOnlyReviewed:false})).refusalCodes).toContain('C06_V2_PROJECTION');
  expect(run(changed({...original,maxRowsReadPerCall:0})).refusalCodes).toContain('C06_V2_ROW_BOUND');
  expect(run(changed({...original,bindPlans:[{...original.bindPlans[0]!,allObservedValuesReviewed:false as never}]}))
   .refusalCodes).toContain('C06_V2_BIND_COVERAGE');
  expect(run(changed({...original,targetedIndexOrTableRoots:['index:wrong']})).refusalCodes)
   .toContain('C06_V2_UNBOUNDED_LOOKUP');
 });
 it('refuses warm source writes and unrelated append until its mutation ACK proof is separately reviewed',()=>{
  const value=fixture(),writing={...value.report,measurements:value.report.measurements.map((row,index)=>
   index===2?{...row,rowsWritten:1,maxRowsWritten:1}:row)};
  expect(qualifyC06SharedPhaseV2(writing,value.certificate,
   {...value.evidence,wholeSourceRowsWritten:1}).refusalCodes).toContain('C06_V2_SOURCE_WRITE');
  const append={...value,certificate:{...value.certificate,kind:'unrelated_append' as const,
   shapes:value.certificate.shapes.map(row=>({...row,phase:'unrelated_append' as const}))},
   evidence:{...value.evidence,kind:'unrelated_append' as const},
   report:{...value.report,measurements:value.report.measurements.map(row=>({...row,phase:'unrelated_append'}))}};
  expect(run(append).refusalCodes).toContain('C06_V2_MUTATION_ACK_REQUIRED');
 });
});
