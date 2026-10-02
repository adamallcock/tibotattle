import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {describe,expect,it} from 'vitest';
import * as candidate from './helpers/analytics-candidate';
import {c06SourceLineageObserver} from './helpers/analytics-c06-source-lineage';
import {C06_CONSUMERS} from './helpers/analytics-c06-source-lineage';
import {c06ScopeSource,c06ScopeConsumer,type C06OperationScope} from './helpers/analytics-c06-operation-scope';
import {createWholeWorkloadMeter,createWholeWorkloadSourceDiagnostic,summarizeWholeWorkload,
 wholeWorkloadRoleEnvironment,wholeWorkloadOptimizationProfile} from './helpers/analytics-whole-workload';
import type {SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';

type Bindings=Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database;TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[]};
const b=env as Bindings;
type InstrumentedCandidate=typeof candidate&{installAnalyticsC06ScopeSource:(scope:typeof c06ScopeSource|null)=>void};
function kernel(){
 const value=candidate as InstrumentedCandidate;
 if(!candidate.publicationClockAdapted||typeof value.installAnalyticsC06ScopeSource!=='function')
  throw Error('C06_ACTUAL_TRANSFORM_BUNDLE_REQUIRED');
 return value;
}
function observe(source:D1Database,target:D1Database,ledger?:D1Database){
 const census=c06SourceLineageObserver(source,()=>({consumer:'unclassified',phase:'operation_probe'}),{allowedPhases:['operation_probe']});
 const diagnostic=createWholeWorkloadSourceDiagnostic(source);
 const perConsumer=Object.fromEntries(C06_CONSUMERS.map(name=>[name,0]));
 const perScope:Partial<Record<C06OperationScope,number>>={};let sourceCalls=0;
 const measured=createWholeWorkloadMeter(census.source,target,undefined,candidate.createD1InvocationBudget,ledger,row=>{
  if(row.side!=='source')return;
  sourceCalls++;const scope=row.operationScope??'unclassified';
  perScope[scope]=(perScope[scope]??0)+1;perConsumer[c06ScopeConsumer(scope)]!++;
 });
 return {census,diagnostic,measured,perConsumer,perScope,sourceCalls:()=>sourceCalls,async finish(){
  const report=await census.report({expectedSourceCalls:sourceCalls,diagnosticDatabase:diagnostic.database});
  const probes=diagnostic.report();
  expect(probes.profile.statements).toBe(report.schemaSetupStatements+report.diagnosticStatements);
  expect(probes.profile.metadataSamples).toBe(probes.profile.statements);
  expect(probes.profile.maximumStatementsPerInvocation).toBeLessThanOrEqual(950);
  return {report,probes};
 }};
}

describe.runIf((import.meta as ImportMeta&{env?:Record<string,string>}).env?.VITE_C06_OPERATION_RUNTIME==='enabled')('actual C06 operation scopes',()=>{
it('counts the real transformed candidate three-role source calls with the original product budgets',async()=>{
 await reset();const actual=kernel(),source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB;
 const sourceId='synthetic-p11-c06-operation-proof';
 actual.setAnalyticsWorkloadPublicationClock(Date.now());
 await actual.initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId);
 await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
 await actual.seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,calendarDays:10,graphDays:2,
  anchorDay:new Date().toISOString().slice(0,10),targetAuthority:'ordered-delivery'});
 const input=observe(source,target,b.DELETION_LEDGER);let boundaryFailures=0;
 await input.census.establishSchema(input.diagnostic.database);
 // The SAME imported helper owns every facade, including nested overrides.
 actual.installAnalyticsC06ScopeSource((database,scope)=>c06ScopeSource(database,scope,{onFailure:()=>{boundaryFailures++;}}));
 try{
  for(const [role,run] of [['analytics',actual.runStorageAnalyticsSchedule],['cache',actual.runCacheRetentionDaySchedule],
   ['publication',actual.runStoragePublicationSchedule]] as const){
   input.measured.setPhase(`${role}_role`);
   await input.measured.invocation(`${role}_schedule`,async(db,_outer,ledger)=>{
    if(!ledger)throw Error('C06_OPERATION_LEDGER_REQUIRED');
    // No direct scope wraps the scheduled input. The reviewed transform owns
    // producer call boundaries inside the original scheduled implementation.
    await run(wholeWorkloadRoleEnvironment({...db,ledger},sourceId,sourceId,wholeWorkloadOptimizationProfile('canonical')));
   });
  }
 }finally{actual.installAnalyticsC06ScopeSource(null);}
 const profile=summarizeWholeWorkload(input.measured.profile),{report,probes}=await input.finish();
 console.log('c06-operation-runtime-proof',JSON.stringify({contract:'actual-candidate-operation-scope-component-v1',
  invocations:profile.invocations,statements:profile.statements,sourceCalls:input.sourceCalls(),perScope:input.perScope,perConsumer:input.perConsumer,
  metadataSamples:profile.metadataSamples,measurementFailures:profile.measurementFailures,failedStatements:profile.failedStatements,
  statementObserverFailures:profile.statementObserverFailures??null,scopeBoundaryFailures:boundaryFailures,
  censusCalls:report.calls,censusMeterReconciled:report.meterReconciled,censusBoundaryFailures:report.boundaryFailures,
  rowsRead:profile.rowsRead,rowsWritten:profile.rowsWritten,maxQueries:profile.maximumStatementsPerInvocation,
  diagnosticStatements:probes.profile.statements,diagnosticRowsRead:probes.profile.rowsRead,
  setup:'Genuine native synthetic admission and local migrations precede the measured three-role cycle; excluded from these component costs.',
  noRescanQualified:false,fullOutputQualification:false,originalProductBudget:true}));
 expect(profile.invocations).toBe(3);expect(profile.maximumStatementsPerInvocation).toBeLessThanOrEqual(950);
 expect(profile.measurementFailures).toBe(0);expect(profile.failedStatements).toBe(0);
 expect(profile.statementObserverFailures).toBe(0);expect(profile.metadataSamples).toBe(profile.statements);
 expect(input.sourceCalls()).toBeGreaterThan(0);
 expect(Object.entries(input.perScope).some(([scope,count])=>scope.startsWith('scheduler_')&&(count??0)>0)).toBe(true);
 expect(Object.values(input.perScope).reduce((sum,count)=>sum+count,0)).toBe(input.sourceCalls());
 expect(report).toMatchObject({calls:input.sourceCalls(),meterReconciled:true,boundaryFailures:0,schemaStable:true,
  noRescanQualified:false,potentialAccessOnly:true});
 expect(boundaryFailures).toBe(0);
 for(const consumer of C06_CONSUMERS)expect(report.perConsumer[consumer]!.attempts).toBe(input.perConsumer[consumer]);
 expect(Object.values(report.consumerCompletions).every(value=>value.entrypointCalls===0&&value.publicCompleteReceiptSha256.length===0)).toBe(true);
},90_000);

it('retains exact actual D1 outer/phase charges and each mixed batch member scope',async()=>{
 await reset();kernel();const input=observe(b.USAGE_MONITOR_DB,b.STORAGE_ANALYTICS_DB);
 await input.census.establishSchema(input.diagnostic.database);
 await input.measured.invocation('supported_scoped_batch',async(db,outer)=>{
  const phase=candidate.createD1InvocationBudget(950);
  const cache=phase.wrap(c06ScopeSource(db.source,'scheduler_cache'));
  expect((await phase.wrap(cache).prepare('SELECT ? AS ready').bind(1).all()).results).toEqual([{ready:1}]);
  const common=phase.wrap(db.source),left=c06ScopeSource(common,'scheduler_cache'),right=c06ScopeSource(common,'scheduler_features');
  const results=await common.batch([left.prepare('SELECT ? AS ready').bind(2),right.prepare('SELECT ? AS ready').bind(3)]);
  expect(results.map(result=>result.results)).toEqual([[{ready:2}],[{ready:3}]]);
  expect(phase.queriesUsed).toBe(3);expect(outer.queriesUsed).toBe(3);
 });
 const {report}=await input.finish();
 expect(summarizeWholeWorkload(input.measured.profile)).toMatchObject({statements:3,metadataSamples:3,failedStatements:0});
 expect(report).toMatchObject({calls:3,meterReconciled:true,boundaryFailures:0,noRescanQualified:false});
 expect(input.perScope).toEqual({scheduler_cache:2,scheduler_features:1});
});

it('keeps caught immutable-scope failure sticky after a genuine successful D1 query',async()=>{
 await reset();kernel();const input=observe(b.USAGE_MONITOR_DB,b.STORAGE_ANALYTICS_DB);let failures=0;
 await input.census.establishSchema(input.diagnostic.database);
 await input.measured.invocation('caught_scope_boundary',async(db,outer)=>{
  const phase=candidate.createD1InvocationBudget(950);
  const direct=c06ScopeSource(db.source,'direct_model',{onFailure:()=>{failures++;}});
  const hidden=phase.wrap(direct),conflict=c06ScopeSource(hidden,'candidate_model_block',{onFailure:()=>{failures++;}});
  expect(()=>conflict.prepare('SELECT 1 AS ready')).toThrow('C06_OPERATION_STATEMENT_SCOPE_MISMATCH');
  expect(()=>hidden.batch([db.source.prepare('SELECT 1 AS ready')])).toThrow('unmetered or foreign database statement');
  expect(outer.queriesUsed).toBe(0);expect(phase.queriesUsed).toBe(0);
  expect((await direct.prepare('SELECT 1 AS ready').all()).results).toEqual([{ready:1}]);
  expect(outer.queriesUsed).toBe(1);expect(phase.queriesUsed).toBe(0);
 });
 const {report}=await input.finish();
 expect(failures).toBe(1);expect(input.sourceCalls()).toBe(1);
 expect(report).toMatchObject({calls:1,boundaryFailures:1,meterReconciled:true,resourceMeasured:false,allMeasured:false,noRescanQualified:false});
});

it('refuses same-meter scope rewrapping and unprofiled sessions instead of qualifying hidden charges',async()=>{
 await reset();kernel();
 const repeat=observe(b.USAGE_MONITOR_DB,b.STORAGE_ANALYTICS_DB);
 await expect(repeat.measured.invocation('same_meter_scope_rewrap',async(db,outer)=>{
  await outer.wrap(c06ScopeSource(db.source,'scheduler_cache')).prepare('SELECT 1 AS ready').all();
 })).rejects.toThrow('whole workload statement accounting mismatch: same_meter_scope_rewrap, profiled=1, metered=2');
 expect(repeat.sourceCalls()).toBe(1);
 const session=observe(b.USAGE_MONITOR_DB,b.STORAGE_ANALYTICS_DB);
 await session.census.establishSchema(session.diagnostic.database);
 await expect(session.measured.invocation('unsupported_profile_session',async(db,outer)=>{
  const scoped=c06ScopeSource(db.source,'direct_model');
  expect(await scoped.withSession('first-primary').prepare('SELECT 1 AS ready').first<number>('ready')).toBe(1);
  expect(outer.queriesUsed).toBe(1);
 })).rejects.toThrow('whole workload statement accounting mismatch: unsupported_profile_session, profiled=0, metered=1');
 // The census sees the real session SQL; the independent profile does not.
 // No reconciliation or complete qualification may be inferred from that call.
 const {report}=await session.finish();
 expect(report.calls).toBe(1);expect(session.sourceCalls()).toBe(0);
 expect(report.meterReconciled).toBe(false);expect(report.noRescanQualified).toBe(false);
});

});
