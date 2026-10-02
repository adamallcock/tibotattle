import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {C06_CONSUMERS,c06SourceLineageObserver} from './helpers/analytics-c06-source-lineage';
import {qualifyC06SourcePhase,type C06PhaseCertificate,type C06PhaseEvidence}
  from './helpers/analytics-c06-qualification';

const HASH='a'.repeat(64);
const SQL='SELECT id, revision FROM c06_qualification_meta WHERE id=?';

async function syntheticReviewedPhase(){
  await reset();
  const db=env.USAGE_MONITOR_DB;
  await db.prepare('CREATE TABLE c06_qualification_meta(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL)').run();
  await db.prepare('INSERT INTO c06_qualification_meta VALUES(1,7)').run();
  const observer=c06SourceLineageObserver(db,()=>({consumer:'api',phase:'warm'}),
    {allowedPhases:['warm']});
  const diagnosticMeter=createD1InvocationBudget(950);
  const diagnosticDatabase=diagnosticMeter.wrap(db);
  await observer.establishSchema(diagnosticDatabase);
  expect((await observer.source.prepare(SQL).bind(1).all()).results)
    .toEqual([{id:1,revision:7}]);
  expect((await observer.source.prepare(SQL).bind(2).all()).results).toEqual([]);
  for(const consumer of C06_CONSUMERS){
    if(consumer==='fixture'||consumer==='unclassified')continue;
    observer.registerConsumerCompletion({consumer,publicCompleteReceiptSha256:HASH});
  }
  const report=await observer.report({expectedSourceCalls:2,diagnosticDatabase});
  expect(diagnosticMeter.queriesUsed)
    .toBe(report.diagnosticStatements+report.schemaSetupStatements);
  const row=report.measurements[0]!;
  // This certificate is fabricated solely to exercise the gate mechanics on
  // synthetic D1. Production certificates require independent SQL review.
  const certificate:C06PhaseCertificate={contract:'c06-source-phase-certificate-v1',
    kind:'warm',sourceSchemaSha256:report.schemaSha256,
    sourceLayoutSha256:report.layoutSha256,runtimeArtifactSha256:HASH,
    shapes:[{consumer:'api',phase:'warm',exactSqlSha256:row.exactSqlSha256,
      projectionSchemaSha256:row.projectionSchemaSha256,emptyProjectionReviewed:true,
      metadataOnlyReviewed:true,physical:row.physical,rootAccess:row.rootAccess,
      columnAccess:row.columnAccess,
      bindPlans:row.bindPlans.map(plan=>({...plan,bindPredicateReviewed:true,
        classPlanInvariantReviewed:true})),
      targetedIndexOrTableRoots:['table:c06_qualification_meta'],
      maxRowsReadPerCall:row.maxRowsRead,maxReturnedRowsPerCall:1}]};
  const evidence:C06PhaseEvidence={kind:'warm',runtimeArtifactSha256:HASH,
    acceptedInputReceiptSha256:HASH,nativeFullOutputSha256:HASH,
    candidateFullOutputSha256:HASH,authorityAndFinalFencesPassed:true,
    diagnosticMeterReceiptSha256:HASH,
    diagnosticMeterStatements:diagnosticMeter.queriesUsed,
    consumers:C06_CONSUMERS.filter(consumer=>consumer!=='fixture'&&consumer!=='unclassified')
      .map(consumer=>({consumer,entrypointCalls:1,sourceCalls:consumer==='api'?2:0,
        publicCompleteReceiptSha256:HASH})),
  };
  return {report,certificate,evidence};
}

it('qualifies only an exact independently completed synthetic metadata phase',async()=>{
  const {report,certificate,evidence}=await syntheticReviewedPhase();
  expect(report.noRescanQualified).toBe(false);
  expect(report.schemaStable).toBe(true);
  expect(report.measurements[0]?.bindPlans[0]?.seekRoots)
    .toContain('table:c06_qualification_meta');
  expect(report.measurements[0]?.bindPlans).toHaveLength(2);
  expect(qualifyC06SourcePhase(report,certificate,evidence)).toMatchObject({
    qualified:true,refusalCodes:[],sourceCalls:2,
  });
});

it('refuses unreviewed binds, physical drift, row bounds, meter and missing entrypoint proof',async()=>{
  const {report,certificate,evidence}=await syntheticReviewedPhase();
  const original=certificate.shapes[0]!;
  const altered=(shape:typeof original):C06PhaseCertificate=>({...certificate,shapes:[shape]});
  expect(qualifyC06SourcePhase(report,altered({...original,bindPlans:[]}),evidence)
    .refusalCodes).toContain('C06_BIND_CLASS');
  expect(qualifyC06SourcePhase(report,altered({...original,emptyProjectionReviewed:false}),evidence)
    .refusalCodes).toContain('C06_PROJECTION');
  expect(qualifyC06SourcePhase(report,altered({...original,columnAccess:[]}),evidence)
    .refusalCodes).toContain('C06_PHYSICAL_ACCESS');
  expect(qualifyC06SourcePhase(report,altered({...original,maxRowsReadPerCall:0}),evidence)
    .refusalCodes).toContain('C06_ROW_BOUND');
  expect(qualifyC06SourcePhase(report,certificate,{...evidence,diagnosticMeterStatements:0})
    .refusalCodes).toContain('C06_DIAGNOSTIC_METER');
  expect(qualifyC06SourcePhase({...report,schemaStable:false},certificate,evidence)
    .refusalCodes).toContain('C06_CENSUS_OR_RESOURCE');
  expect(qualifyC06SourcePhase(report,certificate,{...evidence,
    consumers:evidence.consumers.filter(row=>row.consumer!=='daily')})
    .refusalCodes).toContain('C06_CONSUMER_ENTRYPOINT');
});

it('observes an unclassified source call but refuses phase qualification',async()=>{
  const {report,certificate,evidence}=await syntheticReviewedPhase();
  const unclassified={...report,perConsumer:{...report.perConsumer,
    unclassified:{...report.perConsumer.unclassified!,attempts:1}}};
  expect(qualifyC06SourcePhase(unclassified,certificate,evidence)
    .refusalCodes).toContain('C06_CONSUMER_ENTRYPOINT');
});
