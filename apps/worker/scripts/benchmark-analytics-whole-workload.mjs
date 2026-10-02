import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, writeFile, symlink, mkdir, rm, realpath, stat } from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createRequire,isBuiltin} from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, transform } from 'esbuild';
import {createAnalyticsWorkloadPublicationClockTransform} from './analytics-workload-publication-clock.mjs';
import {createAnalyticsMutationCaptureTransform} from './analytics-workload-mutation-capture-transform.mjs';
import {createAnalyticsC06ScopeTransform,createAnalyticsC06SharedScopeTransform} from './analytics-workload-c06-scope-transform.mjs';

export const NATIVE_REFERENCE_COMMIT='f056940fefabed0c7f0e88353cf54845b077f0c8';
const workerRoot=fileURLToPath(new URL('../',import.meta.url));
const repositoryRoot=path.resolve(workerRoot,'../..');
const facade='test/helpers/analytics-workload-kernels.ts';
const corpusFixture='test/fixtures/shared-analytics-corpus.ts';
export const FUNCTIONAL_NATIVE_INPUT_KINDS=['timestamp_move','cross_day_move','quota_change','plan_change','equal_time_tie','empty_day_replacement','same_occurrence_total_repair'];
export function parseArguments(args) {
  const result={dates:1,compare:false,upgradeSource:false,phases:['cold','warm','no_op'],output:null,help:false,integrationDebugDays:null,observeRuntime:false,nativeProfile:'optimized',clockGoldens:false,functionalGoldens:false,functionalMutations:false,functionalBranches:[],functionalAccountlessSecondary:false,sourceLineage:false};
  const seen=new Set();
  for(let index=0;index<args.length;index++) {
    const flag=args[index];
    if(seen.has(flag))throw new Error('Repeated benchmark argument');
    seen.add(flag);
    if(flag==='--help')result.help=true;
    else if(flag==='--clock-goldens')result.clockGoldens=true;
    else if(flag==='--functional-goldens')result.functionalGoldens=true;
    else if(flag==='--functional-mutations')result.functionalMutations=true;
    else if(flag==='--functional-accountless-secondary')result.functionalAccountlessSecondary=true;
    else if(flag==='--functional-branches'&&args[index+1]){result.functionalBranches=args[++index].split(',');if(new Set(result.functionalBranches).size!==result.functionalBranches.length||result.functionalBranches.length>21||result.functionalBranches.some(value=>!['no_op','unrelated_append','old_correction','clock_advance','utc_rollover','duplicate_delivery','interruption','device_revocation','withdrawal','opt_out_retained','physical_erasure','authority_lag','stale_lease','restore_after_erasure',...FUNCTIONAL_NATIVE_INPUT_KINDS].includes(value)))throw Error('Unsupported functional branch');}
    else if(flag==='--native-profile'&&['optimized','unshared-diagnostic'].includes(args[index+1]))result.nativeProfile=args[++index];
    else if(flag==='--observe-runtime')result.observeRuntime=true;
    else if(flag==='--source-lineage')result.sourceLineage=true;
    else if(flag==='--c06-review-policy'&&args[index+1]&&!args[index+1].startsWith('--'))result.c06ReviewPolicy=path.resolve(args[++index]);
    else if(flag==='--c06-review-policy-sha256'&&/^[a-f0-9]{64}$/u.test(args[index+1]??''))result.c06ReviewPolicySha256=args[++index];
    else if(['--qualify-census','--c06-certificate'].includes(flag)&&args[index+1]&&!args[index+1].startsWith('--'))result[flag==='--qualify-census'?'qualifyCensus':'c06Certificate']=path.resolve(args[++index]);
    else if(flag==='--compare')result.compare=true;
    else if(flag==='--upgrade-source')result.upgradeSource=true;
    else if(flag==='--integration-debug-days'&&['10','30'].includes(args[index+1]))result.integrationDebugDays=Number(args[++index]);
    else if(flag==='--scale-matrix'&&args[index+1]==='1,30,365'){result.scaleMatrix=[1,30,365];index++;}
    else if(flag==='--dates'&&args[index+1]&&['1','30','365'].includes(args[index+1]))result.dates=Number(args[++index]);
    else if(flag==='--phases'&&args[index+1]) {
      result.phases=args[++index].split(',');
      if(result.phases[0]!=='cold'||new Set(result.phases).size!==result.phases.length
        ||result.phases.some(value=>!['cold','warm','no_op','unrelated_append','old_correction'].includes(value)))
        throw new Error('Phases must start with cold and use supported mutation cases exactly once');
    } else if(flag==='--output'&&args[index+1]&&!args[index+1].startsWith('--'))result.output=path.resolve(args[++index]);
    else throw new Error('Expected --dates 1|30|365, --compare, --upgrade-source, --phases <comma-list>, --output <new-json-file>, --integration-debug-days 10|30, --observe-runtime, or --help');
  }
  if(result.qualifyCensus||result.c06Certificate){if(!result.qualifyCensus||!result.c06Certificate||!result.output||[...seen].some(flag=>!['--qualify-census','--c06-certificate','--output'].includes(flag)))throw Error('C06 attachment requires only completed receipt, separate certificate and new output');return result;}
  if((result.c06ReviewPolicy||result.c06ReviewPolicySha256)&&(!result.c06ReviewPolicy||!result.c06ReviewPolicySha256||!result.sourceLineage))throw Error('C06 review policy requires opt-in census and explicit reviewed source SHA256');
  if(result.scaleMatrix&&(!result.compare||!result.upgradeSource||seen.has('--dates')||result.integrationDebugDays||result.functionalBranches.length||result.functionalMutations||result.clockGoldens||result.functionalGoldens||result.nativeProfile!=='optimized'||result.phases.join(',')!=='cold,warm,no_op'))throw Error('Scale matrix requires one shared full466 seed, optimized compare/upgrade and cold,warm,no_op; no separate date or functional startup');
  if(result.functionalGoldens&&[...seen].some(flag=>!['--functional-goldens','--help'].includes(flag)))throw new Error('Functional goldens are a separate bounded test mode');
  if(result.clockGoldens&&[...seen].some(flag=>!['--clock-goldens','--help'].includes(flag)))throw new Error('Clock goldens are a separate bounded test mode');
  if(result.functionalBranches.length&&(!result.compare||!result.upgradeSource||result.integrationDebugDays!==10||result.dates!==1||result.observeRuntime||result.nativeProfile!=='optimized'||result.functionalMutations||result.phases.join(',')!=='cold'))throw Error('Functional branches require optimized10day cold startup without observer or chained mutations');
  if(result.functionalAccountlessSecondary&&!result.functionalBranches.length)throw Error('--functional-accountless-secondary requires --functional-branches');
  if(result.functionalBranches.some(name=>['withdrawal','opt_out_retained'].includes(name))&&!result.functionalAccountlessSecondary)throw Error('Withdrawal or retained opt-out requires genuine accountless secondary startup');
  if(result.functionalMutations&&(!result.compare||!result.upgradeSource||result.integrationDebugDays!==10||result.dates!==1||result.observeRuntime||result.nativeProfile!=='optimized'
    ||result.phases.length!==4||result.phases.slice(0,3).join(',')!=='cold,warm,no_op'||!['unrelated_append','old_correction'].includes(result.phases[3])))throw Error('Functional mutations require one persistent10day optimized cold,warm,no_op,append-or-correction scenario without runtime observation');
  if(result.compare&&!result.functionalMutations&&result.phases.some(phase=>!['cold','warm','no_op'].includes(phase)))throw new Error('Isolated incremental mutation admission is not yet qualified');
  if(result.upgradeSource&&!result.compare)throw new Error('--upgrade-source requires --compare');
  if(result.integrationDebugDays&&(!result.compare||!result.upgradeSource||result.dates!==1))
    throw new Error('Integration debugging requires --compare --upgrade-source --dates 1');
  if(result.sourceLineage&&(!result.compare||![...result.phases,...result.functionalBranches].some(phase=>['warm','no_op','unrelated_append'].includes(phase))))throw Error('Source lineage requires a compared retained warm/no_op/unrelated_append phase');
  return result;
}
/** Reject unsupported diagnostic labels before archive/build/runtime setup.
 * Actual all-statement accounting remains enabled independently. */
export function assertFunctionalProfileCompatibility(options,environment=process.env) {
 const supported=['no_op','unrelated_append','old_correction','duplicate_delivery','interruption','withdrawal','physical_erasure'];
 if(environment.VITE_WHOLE_WORKLOAD_SQL_PROFILE==='enabled'&&options.functionalBranches.some(name=>!supported.includes(name)))
  throw Error('Functional branch SQL histogram phase is unsupported; choose an explicit histogram-disabled functional run');
}
export function validateNativePreviewCounterReceipt(receipt,profile){
 const fail=()=>{throw Error('Incomplete native preview counter trace');},nat=n=>Number.isSafeInteger(n)&&n>=0,hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/u.test(x);
 const keys=(v,names)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...names].sort().join(',');
 if(!keys(receipt,['contract','complete','initialRevision','finalRevision','counts','gaps','initialRowSha256','finalRowSha256','schemaSha256','nonCounterColumnsSha256','observationCost','shapes','nativeSqlUnchanged','bindsUnchanged','callerResultsUnchanged'])
  ||receipt.contract!=='native-preview-cas-trace-v1'||receipt.complete!==true||receipt.nativeSqlUnchanged!==true||receipt.bindsUnchanged!==true||receipt.callerResultsUnchanged!==true
  ||!Array.isArray(receipt.gaps)||receipt.gaps.length||![receipt.initialRevision,receipt.finalRevision].every(n=>n===null||nat(n)&&n>0)
  ||!['initialRowSha256','finalRowSha256','schemaSha256','nonCounterColumnsSha256'].every(key=>hex(receipt[key])))fail();
 const counts=receipt.counts,cost=receipt.observationCost;
 if(!keys(counts,['upsert','refresh','retire','unchanged','failedWrites','unknownWrites','mutationAttempts'])||!Object.values(counts).every(nat)
  ||counts.failedWrites!==0||counts.unknownWrites!==0||counts.mutationAttempts>100000||counts.upsert+counts.refresh+counts.retire+counts.unchanged!==counts.mutationAttempts
  ||!keys(cost,['statements','rowsRead','rowsWritten','databaseMs','wallMs','includedInInvocationMeter','includedInWorkloadProfile'])
  ||cost.includedInInvocationMeter!==true||cost.includedInWorkloadProfile!==true||cost.statements!==4+3*counts.mutationAttempts||!nat(cost.rowsRead)||cost.rowsWritten!==0
  ||![cost.databaseMs,cost.wallMs].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0))fail();
 if(!Array.isArray(receipt.shapes)||receipt.shapes.length>9||receipt.shapes.some(row=>!keys(row,['sha256','attempts'])||!hex(row.sha256)||!nat(row.attempts)||row.attempts<1)
  ||new Set(receipt.shapes.map(row=>row.sha256)).size!==receipt.shapes.length||receipt.shapes.reduce((n,row)=>n+row.attempts,0)!==counts.mutationAttempts)fail();
 if(profile&&(!nat(profile.statements)||profile.statements<cost.statements||!nat(profile.rowsRead)||profile.rowsRead<cost.rowsRead))fail();
 return receipt;
}
export const C06_RECEIPT_OPERATION_SCOPES=Object.freeze(["direct_cohort","direct_daily","direct_api","direct_scalar","direct_model","native_block","direct_cache","direct_publication","fixture","unclassified","scheduler_shared","scheduler_prelude","scheduler_coverage","scheduler_effects","scheduler_cache_publication_admission","scheduler_rolling_admission","scheduler_canonical","scheduler_features","scheduler_cache","scheduler_activity","scheduler_publication","scheduler_fits","scheduler_cleanup","scheduler_graph_owner","scheduler_graph_fits","scheduler_graph_model","scheduler_rolling_window","candidate_model_block"]);
export function validateC06SourceCensus(value,{lane,phase,profile,outputSha256}){
 const fail=()=>{throw Error('Invalid C06 source census');},nat=n=>Number.isSafeInteger(n)&&n>=0,hex=h=>typeof h==='string'&&/^[a-f0-9]{64}$/u.test(h);
 const consumers=['cohort','daily','api','scalar','model','block','cache','publication','fixture','unclassified'],scopes=C06_RECEIPT_OPERATION_SCOPES;
 if(!value||value.contract!=='whole-workload-c06-source-census-v1'||value.lane!==lane||value.phase!==phase||!['warm','no_op','unrelated_append'].includes(phase)
  ||!['diagnostic','unavailable'].includes(value.status)||value.candidateQualificationEligible!==(lane==='candidate')||value.noRescanQualified!==false
  ||value.qualificationReason!==(lane==='candidate'?'reviewed_certificate_not_attached':'native_reference_diagnostic_only')||!hex(value.publicCompleteReceiptSha256)||value.publicCompleteReceiptSha256!==outputSha256
  ||!nat(value.expectedSourceCalls)||!nat(value.profiledSourceCalls)||value.expectedSourceCalls>20000
  ||Object.keys(value.perConsumerExpectedSourceCalls??{}).sort().join(',')!==[...consumers].sort().join(',')||!Object.values(value.perConsumerExpectedSourceCalls).every(nat)
  ||Object.values(value.perConsumerExpectedSourceCalls).reduce((n,v)=>n+v,0)!==value.expectedSourceCalls
  ||!nat(value.operationScopeFailures)||typeof value.operationScopesComplete!=='boolean'||value.producerScopeContract!=='immutable-prepared-operation-scope-v1'||!(lane==='candidate'?['candidate-nine-reviewed-boundaries-v1','candidate-shared-boundaries-v2']:['native-direct-entrypoints-only']).includes(value.producerBoundaryTransform)
  ||Object.keys(value.perOperationExpectedSourceCalls??{}).sort().join(',')!==[...scopes].sort().join(',')||!Object.values(value.perOperationExpectedSourceCalls).every(nat)
  ||Object.values(value.perOperationExpectedSourceCalls).reduce((n,v)=>n+v,0)!==value.expectedSourceCalls)fail();
 const sourceCalls=Object.entries(profile.costs??{}).filter(([key])=>key.split('.')[1]==='source').reduce((n,[,cost])=>n+cost.statements,0);
 if(sourceCalls!==value.profiledSourceCalls)fail();
 const diagnostic=value.diagnostics,p=diagnostic?.profile;
 if(diagnostic?.contract!=='c06-separate-readonly-diagnostic-meter-v1'||diagnostic.actualStatementLimitPerInvocation!==950||diagnostic.separateFromAnalyticalPhase!==true||diagnostic.oneStatementPerDiagnosticInvocation!==true
  ||!nat(diagnostic.attempted)||!nat(diagnostic.refused)||!p||!nat(p.statements)||p.statements>10000||!nat(p.maximumStatementsPerInvocation)||p.maximumStatementsPerInvocation>950||!nat(p.failedStatements)||!nat(p.measurementFailures)||!nat(p.metadataSamples))fail();
 const report=value.report;
 if(value.status==='unavailable'){if(report!==null||value.sourceCallCountsReconciled!==false||value.consumerCountsReconciled!==false||value.diagnosticCountsReconciled!==false||value.operationCountsReconciled!==false||value.operationScopesComplete!==false)fail();return value;}
 if(report?.contract!=='c06-source-lineage-synthetic-v1'||report.noRescanQualified!==false||report.potentialAccessOnly!==true||!nat(report.calls)||!nat(report.shapes)||report.shapes>1024
  ||!nat(report.boundaryFailures)||value.operationScopesComplete!==(value.operationScopeFailures===0&&report.boundaryFailures===0)||!hex(report.schemaSha256)||!hex(report.layoutSha256)||!Array.isArray(report.measurements)||report.measurements.length!==report.shapes||!nat(report.diagnosticStatements)||report.schemaSetupStatements!==1
  ||report.measurements.some(row=>!consumers.includes(row.consumer)||!scopes.includes(row.operationScope)||row.phase!==phase||!hex(row.fingerprint)||!hex(row.exactSqlSha256)||!nat(row.attempts)||row.attempts<1)
  ||Object.keys(report.perConsumer??{}).sort().join(',')!==[...consumers].sort().join(','))fail();
 const sourceEqual=value.expectedSourceCalls===sourceCalls&&report.calls===sourceCalls,consumerEqual=consumers.every(name=>report.perConsumer[name]?.attempts===value.perConsumerExpectedSourceCalls[name]);
 if(value.sourceCallCountsReconciled!==sourceEqual||value.consumerCountsReconciled!==consumerEqual||report.meterReconciled!==(report.calls===value.expectedSourceCalls)
  ||value.diagnosticCountsReconciled!==(p.statements===report.schemaSetupStatements+report.diagnosticStatements)
  ||value.operationCountsReconciled!==scopes.every(scope=>report.measurements.filter(row=>row.operationScope===scope).reduce((n,row)=>n+row.attempts,0)===value.perOperationExpectedSourceCalls[scope]))fail();
 for(const name of consumers){const rows=report.measurements.filter(row=>row.consumer===name),aggregate=report.perConsumer[name];
  if(!['attempts','rowsRead','rowsWritten','shapes'].every(key=>nat(aggregate[key]))||aggregate.attempts!==rows.reduce((n,row)=>n+row.attempts,0)||aggregate.shapes!==rows.length)fail();}
 for(const [consumer,completion] of Object.entries(report.consumerCompletions??{}))if(!consumers.includes(consumer)||['fixture','unclassified'].includes(consumer)||!nat(completion.entrypointCalls)||!Array.isArray(completion.publicCompleteReceiptSha256)||completion.publicCompleteReceiptSha256.some(hash=>hash!==outputSha256)||completion.entrypointCalls===0&&completion.publicCompleteReceiptSha256.length!==0)fail();
 return value;
}
function canonicalReceiptJson(value){
 if(Array.isArray(value))return '['+value.map(canonicalReceiptJson).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalReceiptJson(value[key])).join(',')+'}';
 return JSON.stringify(value);
}
export function readFunctionalBranchSummary(output) {
 const prefix='analytics-functional-branches ',lines=output.split('\n').filter(line=>line.startsWith(prefix+'{'));
 if(lines.length!==1)throw Error('Expected one complete retained functional summary');
 const value=JSON.parse(lines[0].slice(prefix.length)),hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/u.test(x);
 const lanes=['reference','candidate'],sides=['source','target','ledger'],families=['cacheDays','cacheSeries','currentScalar','daily','modelPublications','ownerModels','preview','publishedDaily'];
 const keys=lanes.flatMap(lane=>sides.map(side=>lane+'.'+side));
 if(value.schemaVersion!=='analytics-retained-functional-branches-v1'||value.referenceCommit!==NATIVE_REFERENCE_COMMIT||value.wholeWorkloadQualification!==false
   ||value.runtimeObservationEnabled!==false||value.sharedIsolate!==true||value.physicalStores!==6||value.outputDates!==1||value.sharedUniqueHistoryCalendarDays!==10
   ||value.previewCounterContract!=='native-preview-cas-trace-v1'||value.retainedPublicationClockContract!=='retained-functional-publication-clock-v1'||!value.publicationTimestampContract?.startsWith('strict-common-analytical-clock-v1:')||value.roleComposition!=='actual-three-role-schedules-v1'
   ||typeof value.functionalAccountlessSecondary!=='boolean'||value.secondaryOwnerKind!==(value.functionalAccountlessSecondary?'accountless':'social')
   ||!Array.isArray(value.remainingGates)||value.remainingGates.length===0||!value.cold||!value.base||!value.branches)throw Error('Invalid retained functional summary');
 const validProfile=(profile,lane)=>{
  if(!profile||profile.measurementFailures!==0||profile.failedStatements!==0||!Number.isSafeInteger(profile.statements)||profile.statements<0||profile.metadataSamples!==profile.statements
    ||!Number.isSafeInteger(profile.maximumStatementsPerInvocation)||profile.maximumStatementsPerInvocation>950||profile.maximumStatementsPerInvocation<0
    ||!Array.isArray(profile.scheduledLaneFailures)||lane==='candidate'&&(profile.unexpectedCandidateRoleFailures!==0||profile.scheduledLaneFailures.length!==0))throw Error('Incomplete branch resource/role accounting');
 };
 const completion=(pair,population,owners)=>{
  if(!pair||!hex(pair.reference?.publicationRowsSha256)||!hex(pair.candidate?.publicationRowsSha256)||!hex(pair.reference?.outputSha256)||pair.reference.outputSha256!==pair.candidate?.outputSha256||pair.reference.inventorySha256!==pair.candidate?.inventorySha256)throw Error('Missing exact branch parity');
  for(const lane of lanes){const item=pair[lane],inventory=item?.inventory;
   const counter=validateNativePreviewCounterReceipt(item.previewCounterProof);
   if(!hex(item.modelRowsSha256)||item.modelRowsSha256!==pair.reference.modelRowsSha256||!hex(item.previewRowSha256)||item.previewRowSha256!==counter.finalRowSha256
    ||counter.nonCounterColumnsSha256!==pair.reference.previewCounterProof.nonCounterColumnsSha256)throw Error('Incomplete exact publication counter parity');
   if(!hex(item?.inventorySha256)||!item.familySha256||Object.keys(item.familySha256).sort().join(',')!==families.join(',')||Object.values(item.familySha256).some(hash=>!hex(hash))
     ||!inventory||inventory.checkedAfterCleanup!==true||!hex(inventory.graphInventorySha256)||!hex(inventory.dailyPublicationInventorySha256)
     ||inventory.currentFitOwners!==owners||inventory.graphResults!==owners*71||inventory.modelOwnerResults!==owners*70||inventory.modelDates!==70
     ||inventory.modelPublicationDates!==70||inventory.requestedDailyDates!==population.requestedDates.length||inventory.cacheOwnerDaysCompared!==owners*population.cacheDates.length)throw Error('Incomplete branch population');
   assertPrivateEqual(item.familySha256,pair.reference.familySha256,'Branch family parity differs');
  }
 };
 const base=value.base;
 const rawProfile=profile=>{if(!profile||profile.failedStatements!==0||profile.measurementFailures!==0||!Number.isSafeInteger(profile.statements)||profile.statements<0||profile.metadataSamples!==profile.statements)throw Error('Missing laboratory resource accounting');};
 const actionProfile=profile=>{rawProfile(profile);if(!Number.isSafeInteger(profile.maximumStatementsPerInvocation)||profile.maximumStatementsPerInvocation<0||profile.maximumStatementsPerInvocation>950)throw Error('Action invocation bound missing');};
 const episodeProof=(episode,kind)=>{
  if(episode?.schemaVersion!=='analytics-native-functional-episode-v1'||episode.kind!==kind||episode.postStartImports!==0||episode.postStartResets!==0||episode.clockOverrides!==0)throw Error('Missing native lifecycle proof');
  for(const lane of lanes){actionProfile(episode.costs?.[lane]);const proof=episode.proof?.[lane];if(!proof)throw Error('Missing lifecycle lane proof');
   if(kind==='duplicate_delivery'&&(proof.outcome!=='already-applied'||proof.projectionCalls!==0||proof.deliveredBefore!==proof.deliveredAfter||episode.costs[lane].rowsWritten!==0))throw Error('Duplicate receipt changed');
   if(kind==='interruption'&&(proof.lostResponses!==1||proof.committedPageBatches<1||proof.receipts!==1||proof.durablePageCount!==proof.workRevision))throw Error('Lost-response receipt missing');
   if(kind==='device_revocation'&&(!Number.isSafeInteger(proof.devicesRevoked)||proof.devicesRevoked<1||proof.ownerState!=='active'||proof.survivingOwners!==2||proof.historyRetained!==true))throw Error('Device revocation retention proof missing');
   if(kind==='withdrawal'&&(value.functionalAccountlessSecondary!==true||proof.enrollmentRevoked!==true||proof.ownerState!=='withdrawn'||proof.survivingOwners!==1||proof.nativeTerminalChange!==true||!Number.isSafeInteger(proof.acceptedRowsRetained)||proof.acceptedRowsRetained<1))throw Error('Withdrawal proof missing');
   if(kind==='opt_out_retained'&&(value.functionalAccountlessSecondary!==true||proof.enrollmentRevoked!==true||proof.ownerState!=='active'||proof.survivingOwners!==2||proof.historyRetained!==true||proof.exactRetentionMarker!==true||proof.revocationGraphRows!==4||!Number.isSafeInteger(proof.acceptedRowsRetained)||proof.acceptedRowsRetained<1))throw Error('Retained opt-out proof missing');
   if(kind==='restore_after_erasure'&&(proof.suppressed!==1||proof.participantRows!==0||proof.nativePhysicalCompletion!==true||proof.survivingOwners!==1||!Number.isSafeInteger(proof.replayPasses)||proof.replayPasses<1||proof.replayPasses>32))throw Error('Restore terminal proof missing');
   if(kind==='physical_erasure'&&(proof.tombstone!==true||proof.participantRows!==0||proof.nativePhysicalCompletion!==true||proof.survivingOwners!==1))throw Error('Physical erasure proof missing');
  }
 };
 const actionTraceProof=(trace,costs,lane,startupHash)=>{
  if(trace?.contract!=='native-preview-traced-action-v1')throw Error('Missing native action counter trace');
  const counter=validateNativePreviewCounterReceipt(trace[lane]),control=trace.controls?.[lane],action=costs?.[lane];actionProfile(control);actionProfile(action);
  if(counter.initialRowSha256!==startupHash||control.statements!==5||control.maximumStatementsPerInvocation!==3
    ||action.statements<4*counter.counts.mutationAttempts||counter.observationCost.statements>control.statements+action.statements
    ||!Number.isFinite(action.rowsRead)||!Number.isFinite(control.rowsRead)||counter.observationCost.rowsRead>action.rowsRead+control.rowsRead)throw Error('Incomplete action counter cost/startup proof');
 };
 const boundaryProof=(episode,kind)=>{
  if(episode?.schemaVersion!=='analytics-native-functional-boundary-v1'||episode.kind!==kind||episode.allFamilyParity!=='pending'||episode.postStartImports!==0||episode.postStartResets!==0||episode.clockOverrides!==0)throw Error('Missing native boundary proof');
  for(const lane of lanes){actionProfile(episode.costs?.[lane]);const proof=episode.proof?.[lane];if(!proof)throw Error('Missing native boundary lane');
   if(kind==='authority_lag'&&(proof.pendingNativeEvents!==1||!['sourceSequence','targetSequence','sourceRevision','targetRevision','sourceAuthorityEpoch','targetAuthorityEpoch'].every(key=>Number.isSafeInteger(proof[key])&&proof[key]>0)||proof.sourceSequence!==proof.targetSequence+1||!(proof.sourceRevision>proof.targetRevision)||!(proof.sourceAuthorityEpoch>proof.targetAuthorityEpoch)||!hex(proof.eventSha256)||!hex(proof.priorPreviewSha256)||proof.previewRefused!==true||proof.priorPublicationRetainedExactly!==true||proof.appliedReceipts!==0||episode.costs[lane].rowsWritten!==0))throw Error('Authority lag refusal missing');
   if(kind==='stale_lease'&&(proof.nativeLeaseExpired!==true||!['priorClaimRevision','reapedRevision','reclaimedRevision','releasedRevision'].every(key=>Number.isSafeInteger(proof[key])&&proof[key]>0)||proof.oldCompletion!=='conflict'||proof.reapedRevision!==proof.priorClaimRevision+1||proof.reclaimedRevision!==proof.reapedRevision+1||proof.releasedRevision!==proof.reclaimedRevision+1||proof.pendingNativeRecovery!==true||!hex(proof.retainedDependencySha256)||!Number.isSafeInteger(proof.realWaitMs)||proof.realWaitMs<0))throw Error('Native expired lease proof missing');
  }
 };
 if(value.sourceSnapshot?.exactSchemaAndData!==true||value.sourceSnapshot.exactRowids!==true||!hex(value.sourceSnapshot.sqlSha256)||!hex(value.sourceSnapshot.schemaSha256)||!hex(value.sourceSnapshot.rowidInventorySha256))throw Error('Initial accepted source snapshot missing');
 for(const [lane,representation] of [['reference','native'],['candidate','canonical']]){
  assertPrivateEqual(value.optimizationProfiles?.[lane],{representation,nativeProfile:'optimized',canonicalPipeline:lane==='candidate',sharedFeatures:true,cacheSharedFeatures:true,modelBlocks:true,preparedFold:true,preparedEffectiveUsage:'native-default',performanceBasis:'existing-native-optimizations-v1'},'Branch optimization basis differs');
  validProfile(value.cold[lane],lane);
  if(value.cold[lane].c06SourceLineage!==undefined)throw Error('Cold source census is forbidden');
  const trace=value.cold[lane].nativePreviewCounter;validateNativePreviewCounterReceipt(trace?.receipt,value.cold[lane]);
  if(trace.boundary!=='cold-null-startup'||trace.startupFullBaseRowMatched!==false||trace.receipt.initialRevision!==null||trace.receipt.initialRowSha256!=='74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b')throw Error('Invalid cold preview counter boundary');
  assertPrivateEqual(trace.receipt,base.completed?.[lane]?.previewCounterProof,'Cold counter proof differs');
 }
 if(value.cold.output?.parity!=='exact'||value.cold.output.sha256!==base.completed?.reference?.outputSha256)throw Error('Missing cold paired output');
 completion(base.completed,{requestedDates:[0],cacheDates:Array(10)},2);

 if(base.schemaVersion!=='analytics-completed-six-store-base-v1'||base.physicalStores!==6||base.analyticalNowMs!==value.analyticalNowMs||!lanes.every(lane=>hex(base.inputSha256?.[lane]))
   ||Object.keys(base.captures??{}).sort().join(',')!==[...keys].sort().join(',')||Object.keys(base.finalCapture??{}).sort().join(',')!==[...keys].sort().join(','))throw Error('Incomplete six-store base');
 for(const key of keys){const first=base.captures[key],last=base.finalCapture[key];
  if(!first?.proof||!hex(first.proof.sqlSha256)||!hex(first.proof.schemaSha256)||!hex(first.proof.rowidInventorySha256)||first.exportResourceMetadata!==null||first.physicalSnapshotBytes!==null)throw Error('Invalid logical base proof');
  rawProfile(first.profile);rawProfile(last?.profile);assertPrivateEqual(last?.proof,first.proof,'Base changed during capture');
 }
 const scenarios=Object.keys(value.branches);
 if(scenarios.length<1||scenarios.length>21||scenarios.some(name=>!['no_op','unrelated_append','old_correction','clock_advance','utc_rollover','duplicate_delivery','interruption','device_revocation','withdrawal','opt_out_retained','physical_erasure','authority_lag','stale_lease','restore_after_erasure',...FUNCTIONAL_NATIVE_INPUT_KINDS].includes(name)))throw Error('Invalid branch selection');
 for(const scenario of scenarios){const branch=value.branches[scenario],startup=branch?.startup,population=branch?.population;
  if(!startup||startup.schemaVersion!=='analytics-retained-functional-branch-v1'||startup.scenario!==scenario||startup.outcome!=='complete'
    ||startup.resetResourceMetadata!==null||startup.physicalStores!==6||startup.resetCountBeforeScenario!==1||startup.importsBeforeScenario!==6||startup.postStartImports!==0||startup.postStartResets!==0
    ||startup.comparativeHeapQualification!==false||startup.freshIsolateMutationQualification!==false||startup.analyticalNowMs!==branch.analyticalNowMs
    ||!Number.isSafeInteger(branch.expectedOwnerCount)||branch.expectedOwnerCount<1||branch.expectedOwnerCount>2
    ||!population||population.requestedDates?.length!==1||population.cacheDates?.length!==10||population.calendarShiftDays!==(scenario==='utc_rollover'?1:0))throw Error('Invalid retained branch startup');
  const branchDay=Math.floor(branch.analyticalNowMs/86_400_000)*86_400_000;
  if(!Number.isSafeInteger(branch.analyticalNowMs)||startup.baseAnalyticalNowMs!==value.analyticalNowMs
    ||branch.analyticalNowMs!==(scenario==='clock_advance'?value.analyticalNowMs+1000:scenario==='utc_rollover'?Math.floor(value.analyticalNowMs/86_400_000)*86_400_000+86_400_000+1000:value.analyticalNowMs))throw Error('Branch analytical clock differs');
  const day=ms=>new Date(ms).toISOString().slice(0,10);
  assertPrivateEqual(population.requestedDates,[day(branchDay-86_400_000)],'Branch requested calendar differs');
  assertPrivateEqual(population.cacheDates,Array.from({length:10},(_,index)=>day(branchDay-(9-index)*86_400_000)),'Branch cache calendar differs');
  assertPrivateEqual(startup.baseInputSha256,base.inputSha256,'Branch base pins differ');
  let importedBase=base;
  if(scenario==='restore_after_erasure'){
   const restored=branch.restoreBase;
   if(restored?.schemaVersion!=='analytics-terminal-ledger-six-store-base-v1'||restored.physicalStores!==6||restored.analyticalNowMs!==value.analyticalNowMs||!hex(restored.terminalParticipantSha256)||!hex(restored.preterminalBaseSha256)||restored.preterminalBaseSha256!==createHash('sha256').update(canonicalReceiptJson(base)).digest('hex'))throw Error('Missing separate restore startup');
   assertPrivateEqual(restored.inputSha256,base.inputSha256,'Restore source pins differ');assertPrivateEqual(restored.completed,base.completed,'Restore preterminal evidence differs');
   episodeProof(restored.preparationEvidence?.erasure,'physical_erasure');
   const preparationTrace=restored.preparationEvidence?.previewActionTrace;
   if(preparationTrace?.contract!=='native-preview-traced-action-v1')throw Error('Missing restore preparation trace');
   for(const lane of lanes){const terminal=restored.terminalProof?.[lane];if(terminal?.nativeCompletion!==true||terminal.tombstone!==true||terminal.participantRows!==0)throw Error('Missing native terminal ledger witness');actionProfile(terminal.cost);
    actionTraceProof(preparationTrace,restored.preparationEvidence.erasure.costs,lane,base.completed[lane].previewRowSha256);
    if(preparationTrace[lane].initialRowSha256!==base.completed[lane].previewRowSha256)throw Error('Restore preparation trace startup differs');
   }
   for(const key of keys){const capture=restored.captures?.[key],last=restored.finalCapture?.[key];if(!capture?.proof||!hex(capture.proof.sqlSha256)||!hex(capture.proof.schemaSha256)||!hex(capture.proof.rowidInventorySha256)||capture.exportResourceMetadata!==null||capture.physicalSnapshotBytes!==null)throw Error('Incomplete restored capture');rawProfile(capture.profile);rawProfile(last?.profile);assertPrivateEqual(last.proof,capture.proof,'Restored capture drift');
    if(key.endsWith('.ledger')){if(capture.proof.sqlSha256===base.captures[key].proof.sqlSha256)throw Error('Terminal ledger unchanged');}
    else assertPrivateEqual(capture,base.captures[key],'Preterminal restore store was replaced');
   }
   importedBase=restored;
  }else if(branch.restoreBase!==undefined)throw Error('Unexpected restored startup');
  for(const key of keys){const imported=startup.imports?.[key];if(imported?.exactSchemaAndData!==true||imported.exactRowids!==true)throw Error('Missing branch import');rawProfile(imported.importProfile);rawProfile(imported.proofProfile);assertPrivateEqual(imported.proof,importedBase.captures[key].proof,'Branch import differs');}
  for(const lane of lanes){validProfile(branch.profiles?.[lane],lane);const clock=branch.profiles[lane].retainedPublicationClock;
   const trace=branch.profiles[lane].nativePreviewCounter;validateNativePreviewCounterReceipt(trace?.receipt,branch.profiles[lane]);
   if(scenario==='restore_after_erasure'){
    const actionTrace=branch.previewActionProof;if(actionTrace?.contract!=='native-preview-traced-action-v1')throw Error('Native restore action trace missing');
    actionTraceProof(actionTrace,branch.action?.evidence?.costs,lane,base.completed[lane].previewRowSha256);
    if(actionTrace[lane].initialRowSha256!==base.completed[lane].previewRowSha256||trace.boundary!=='lane-entry-after-traced-native-action'||trace.startupFullBaseRowMatched!==false||trace.receipt.initialRowSha256!==actionTrace[lane].finalRowSha256)throw Error('Restore preview lineage broken');
    assertPrivateEqual(trace.actionCheckpoint,actionTrace[lane],'Restore action checkpoint differs');
   }else{
    if(trace.boundary!=='lane-entry-after-native-action'||trace.startupFullBaseRowMatched!==true||trace.receipt.initialRowSha256!==base.completed[lane].previewRowSha256)throw Error('Invalid retained preview counter boundary');
    assertPrivateEqual(branch.previewActionProof?.[lane],{contract:'native-preview-zero-action-writes-v1',previewMutationAttempts:0,unsupportedAttempts:0},'Prior preview action write is untraced');
   }
   assertPrivateEqual(trace.receipt,startup.completion?.[lane]?.previewCounterProof,'Branch counter proof differs');
   if(clock?.contract!=='retained-functional-publication-clock-v1'||clock.priorAnalyticalNowMs!==value.analyticalNowMs||clock.analyticalNowMs!==branch.analyticalNowMs
     ||![clock.retainedExactRows,clock.newClockRows].every(n=>Number.isSafeInteger(n)&&n>=0)||clock.retainedExactRows+clock.newClockRows!==branch.profiles[lane].publicationTimestampsChecked)throw Error('Missing retained clock proof');
  }
  completion(startup.completion,population,branch.expectedOwnerCount);
  for(const lane of lanes){const census=branch.profiles[lane].c06SourceLineage;if(value.sourceLineageEnabled===true&&['warm','no_op','unrelated_append'].includes(scenario))validateC06SourceCensus(census,{lane,phase:scenario,profile:branch.profiles[lane],outputSha256:startup.completion[lane].outputSha256});else if(census!==undefined)throw Error('Unexpected source census phase');}
  if(['no_op','unrelated_append','old_correction','interruption','authority_lag'].includes(scenario)){
   const action=branch.action,proof=action?.proof,kind=scenario==='authority_lag'?'metadata_change':scenario==='interruption'?'unrelated_append':scenario;
   if(action?.storesReplaced!==false||action.physicalStoresRetained!==true||action.paired?.divergences!==0||action.paired?.physicalFailures!==0||proof?.schemaVersion!=='analytics-mutation-proof-v2'
     ||proof.comparisonContract!=='native-existing-owner-v2'||proof.clockPolicy!=='native-v11-trigger-clocks-v1'||proof.kind!==kind||proof.verifiedNativeBranch!==kind
     ||proof.verified?.newEvents!==(scenario==='no_op'?0:1))throw Error('Missing native branch action proof');
   for(const lane of lanes){actionProfile(action.admission?.[lane]);actionProfile(action.delivery?.[lane]);for(const boundary of ['before','after']){
    if(!hex(proof.rawSnapshotSha256?.[boundary]?.[lane])||action.snapshots?.[lane]?.[boundary]?.sha256!==proof.rawSnapshotSha256[boundary][lane])throw Error('Branch raw snapshot mismatch');
    actionProfile(action.snapshots[lane][boundary].measurement);
   }}
   if(scenario==='no_op'?branch.effects?.allFamiliesUnchanged!==true:branch.effects?.affectedAggregateChanged!==true||branch.effects.affectedCacheEventsAfter!==branch.effects.affectedCacheEventsBefore+1)throw Error('Missing genuine branch effect');
   if(scenario==='interruption')episodeProof(action.deliveryEpisode?.evidence,'interruption');
   if(scenario==='authority_lag')boundaryProof(action.deliveryEpisode?.evidence,'authority_lag');
  }else if(scenario==='stale_lease'){boundaryProof(branch.action?.evidence,'stale_lease');if(branch.effects?.allFamiliesUnchanged!==true)throw Error('Expired lease changed outputs');
  }else if(FUNCTIONAL_NATIVE_INPUT_KINDS.includes(scenario)){
   validateFunctionalNativeInputEvidence(branch.action?.evidence,scenario);
   if(branch.effects?.nativeInputProved!==true||!Array.isArray(branch.effects.publicChangedFamilies)||new Set(branch.effects.publicChangedFamilies).size!==branch.effects.publicChangedFamilies.length||branch.effects.publicChangedFamilies.some(family=>!families.includes(family)))throw Error('Native input full-family effects missing');
  }else if(['duplicate_delivery','device_revocation','withdrawal','opt_out_retained','physical_erasure','restore_after_erasure'].includes(scenario)){
   const episode=branch.action?.evidence;
   episodeProof(episode,scenario);
   if(['duplicate_delivery','device_revocation','opt_out_retained'].includes(scenario)&&branch.effects?.allFamiliesUnchanged!==true)throw Error('Retained native history changed full outputs');
  }else if(branch.action?.sourceMutation!==false)throw Error('Clock branch unexpectedly mutates source');
 }
 return value;
}
/** Admission evidence remains separate from the complete eight-family caller gate. */
export function validateFunctionalNativeInputEvidence(evidence,kind) {
 const lanes=['reference','candidate'],hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/u.test(x),nat=x=>Number.isSafeInteger(x)&&x>=0;
 const fail=()=>{throw Error('Incomplete native functional input evidence');};
 const pair=p=>{if(!p||!['calls','statements','returnedRows','mutatingStatements','divergences','physicalFailures'].every(k=>nat(p[k]))||p.calls<1||p.statements<1||p.divergences!==0||p.physicalFailures!==0)fail();};
 const profile=p=>{if(!p||p.failedStatements!==0||p.measurementFailures!==0||!nat(p.statements)||p.statements<1||p.metadataSamples!==p.statements||!nat(p.maximumStatementsPerInvocation)||p.maximumStatementsPerInvocation>950)fail();};
 const fields={timestamp_move:['eventTime'],cross_day_move:['eventTime'],quota_change:['usedPercent'],plan_change:['planType','accountPlanAttribution.planType'],equal_time_tie:['tieOrder','eventId','dayRecords'],empty_day_replacement:['dayRecords']};
 if(!FUNCTIONAL_NATIVE_INPUT_KINDS.includes(kind)||evidence?.schemaVersion!=='analytics-paired-functional-native-input-v1'||evidence.action!==kind||evidence.receiptProjection!=='hash-only-native-input-v1'||evidence.postStartImports!==0||evidence.postStartResets!==0||evidence.allFamilyParity!=='pending')fail();
 const writer=evidence.writer;
 if(writer?.kind!==kind||writer.outcome!=='accepted'||writer.partialAdmission||writer.nativeRefusalCode!==undefined||!nat(writer.nativeCalls)||writer.nativeCalls<1||!nat(writer.priorRecords)||!nat(writer.newRecords)||!Array.isArray(writer.affectedDays)||writer.affectedDays.length!==(kind==='cross_day_move'?2:1)||writer.affectedDays.some(d=>typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/u.test(d))||new Set(writer.affectedDays).size!==writer.affectedDays.length)fail();
 if(kind==='same_occurrence_total_repair'){
  if(!Array.isArray(writer.changedFields)||writer.changedFields.length<1||writer.changedFields.length>2||new Set(writer.changedFields).size!==writer.changedFields.length||writer.changedFields.some(f=>!['totalInputContextTokens','components.outputCombinedTokens'].includes(f)))fail();
 }else assertPrivateEqual(writer.changedFields,fields[kind],'Native action fields differ');
 if(writer.newRecords!==writer.priorRecords+(['equal_time_tie','empty_day_replacement'].includes(kind)?1:0))fail();
 pair(evidence.paired?.scope);pair(evidence.paired?.admission);if(evidence.paired.admission.mutatingStatements<1)fail();
 const tableNames=['typed_telemetry_records','typed_telemetry_usage','typed_telemetry_quota','typed_telemetry_session_tools','typed_v11_chunk_allocations','typed_v11_manifest_memberships','typed_v11_record_proofs','telemetry_v12_day_manifests','telemetry_v12_chunks','telemetry_v12_records','telemetry_v12_usage','telemetry_v12_quota','telemetry_v12_session_tools'].sort();
 const event=p=>{if(!p||!nat(p.sequence)||!nat(p.revision)||!nat(p.authorityEpoch)||!['owner-active','source-updated'].includes(p.kind)||p.recordedWithinWriterInterval!==true)fail();};
 for(const lane of lanes){profile(evidence.profiles?.[lane]);event(evidence.events?.[lane]);const physical=evidence.priorPhysical?.[lane];
  if(!physical||physical.allPriorRowsRetained!==true||physical.preparedRowsRetained!==(kind==='same_occurrence_total_repair'?true:null))fail();
  for(const boundary of ['before',...(kind==='same_occurrence_total_repair'?['afterPreparation']:[]),'after']){const rows=physical[boundary];if(!rows||Object.keys(rows).sort().join(',')!==tableNames.join(','))fail();for(const row of Object.values(rows))if(!nat(row.rows)||!hex(row.sha256))fail();}
  const effective=evidence.freshEffective?.[lane];if(!Array.isArray(effective)||effective.length<1||effective.length>4)fail();
  for(const row of effective){if(!row||Object.keys(row).sort().join(',')!==['day','stream','status','eventTimeConflict','sourceCount','recordDigest','occurrenceSha256'].sort().join(',')||!writer.affectedDays.includes(row.day)||!['usage','quota','session'].includes(row.stream)||!['compatible','conflict','absent'].includes(row.status)||!hex(row.occurrenceSha256))fail();
   if(row.status==='absent'?(row.sourceCount!==null||row.recordDigest!==null||row.eventTimeConflict!==null):(!nat(row.sourceCount)||row.sourceCount<1||typeof row.eventTimeConflict!=='boolean'||(row.status==='compatible'?!hex(row.recordDigest):row.recordDigest!==null)))fail();}
 }
 assertPrivateEqual(evidence.events.reference,evidence.events.candidate,'Native event authority differs');
 assertPrivateEqual(evidence.freshEffective.reference,evidence.freshEffective.candidate,'Native effective semantic proof differs');
 for(const boundary of ['before',...(kind==='same_occurrence_total_repair'?['afterPreparation']:[]),'after'])assertPrivateEqual(evidence.priorPhysical.reference[boundary],evidence.priorPhysical.candidate[boundary],'Native physical row hashes differ');
 if(kind==='same_occurrence_total_repair'){
  const prep=evidence.preparation;if(!prep||prep.kind!=='v11_preparation'||!hex(prep.baseDigest)||!nat(prep.nativeCalls)||prep.nativeCalls<1||!Number.isSafeInteger(prep.interval?.startMs)||!Number.isSafeInteger(prep.interval?.endMs)||prep.interval.startMs>prep.interval.endMs)fail();pair(prep.paired);if(prep.paired.mutatingStatements<1)fail();
  for(const lane of lanes)event(evidence.preparationEvents?.[lane]);assertPrivateEqual(evidence.preparationEvents.reference,evidence.preparationEvents.candidate,'Native preparation event differs');
 }else if(evidence.preparation!==null||evidence.preparationEvents!==null)fail();
 return evidence;
}
export function readWholeWorkloadSummary(output) {return readCompletedSummary(output,false);}
export function readIntegrationDebugSummary(output) {return readCompletedSummary(output,true);}
export function readFunctionalMutationSummary(output) {return readCompletedSummary(output,true,true);}
function readCompletedSummary(output,debug,functional=false) {
  const prefix=functional?'analytics-functional-mutations ':debug?'analytics-integration-debug ':'analytics-whole-workload ';
  const lines=output.split('\n').filter(line=>line.includes(prefix+'{'));
  if(lines.length!==1)throw new Error('Expected exactly one completed whole-workload summary');
  const summary=JSON.parse(lines[0].slice(lines[0].indexOf('{')));
  if(!(functional?['analytics-persistent-mutation-functional-v1']:debug?['analytics-integration-debug-v5']:['analytics-whole-workload-v1','analytics-whole-workload-native-diagnostic-v2','analytics-whole-workload-v6']).includes(summary.schemaVersion)||summary.referenceCommit!==NATIVE_REFERENCE_COMMIT
    ||!summary.phases||!summary.pendingCases||summary.wholeWorkloadQualification!==false)
    throw new Error('Invalid or overstated baseline summary');
  if(![1,30,365].includes(summary.outputDates)||!summary.phases.cold)throw new Error('Missing complete cold population');
  const integrated=!['analytics-whole-workload-v1','analytics-whole-workload-native-diagnostic-v2'].includes(summary.schemaVersion);
  if(debug&&(summary.integrationDebug!==true||![10,30].includes(summary.cachePopulationDays)
    ||summary.sharedUniqueHistoryCalendarDays!==summary.cachePopulationDays||summary.outputDates!==1
    ||summary.comparisonBasis!==(functional?'persistent-independent-physical-stores-shared-isolate-functional-v1':'small-fresh-worker-retained-graph-cache-and-ordered-delivery-debug-v5')))
    throw new Error('Invalid small integration debugging population');
  const families=['cacheDays','cacheSeries','currentScalar','daily','modelPublications','ownerModels','preview'];
  if(summary.schemaVersion==='analytics-whole-workload-v6'
    &&(summary.cachePopulationDays!==466||summary.comparisonBasis!=='fresh-worker-retained-graph-cache-and-ordered-delivery-v6'))
    throw new Error('Integrated comparison must cover the complete retained cache population');
  const modelDateCount=integrated?Math.max(70,summary.outputDates+1):summary.outputDates;
  if(integrated) {
    if(!summary.publicationTimestampContract?.startsWith('strict-common-analytical-clock-v1:')||summary.publicationTimestampContract.includes('replace only'))throw new Error('Missing strict analytical publication clock');
    const profiles=summary.optimizationProfiles;
    const mode=profiles?.reference?.nativeProfile;
    if(!['optimized','unshared-diagnostic'].includes(mode))throw new Error('Missing explicit native optimization profile');
    for(const [lane,representation] of [['reference','native'],['candidate','canonical']]) {
      const expected={representation,nativeProfile:mode,canonicalPipeline:lane==='candidate',
        sharedFeatures:lane==='candidate'||mode==='optimized',cacheSharedFeatures:mode==='optimized',modelBlocks:mode==='optimized',
        preparedFold:true,preparedEffectiveUsage:'native-default',performanceBasis:mode==='optimized'?'existing-native-optimizations-v1':'unshared-oracle-diagnostic-only-v1'};
      assertPrivateEqual(profiles[lane],expected,'Native optimization basis changed');
    }
    if(functional){
      assertPrivateEqual(summary.functionalMutationExecution,{basis:'persistent-independent-physical-stores-shared-isolate-v1',physicalSources:2,physicalTargets:2,physicalLedgers:2,storesRetainedAcrossAllPhases:true,postColdSourceReplacements:0,comparativeHeapQualification:false,freshIsolateMutationQualification:false,proofContract:'native-existing-owner-v2',clockPolicy:'native-v11-trigger-clocks-v1'},'Persistent functional store contract differs');
      const phases=Object.keys(summary.phases);
      if(phases.length!==4||phases.slice(0,3).join(',')!=='cold,warm,no_op'||!['unrelated_append','old_correction'].includes(phases[3])||summary.runtimeObservationEnabled!==false)throw Error('Functional mutation scenario or observer claim invalid');
      for(const phase of ['no_op',phases[3]]){
        const mutation=summary.phases[phase].mutationProof,proof=mutation?.proof,effects=summary.phases[phase].mutationEffects;
        if(effects?.kind!==phase||(phase==='no_op'?effects.allFamiliesUnchanged!==true:
          effects.affectedDays!==1||effects.affectedAggregateChanged!==true||!Number.isSafeInteger(effects.affectedCacheEventsBefore)||effects.affectedCacheEventsBefore<0
          ||effects.affectedCacheEventsAfter!==effects.affectedCacheEventsBefore+1||effects.appendOutsideRequestedDays!==(phase==='unrelated_append')
          ||phase==='unrelated_append'&&effects.requestedDailyUnchanged!==true))throw Error('Missing genuine mutation output effects');
        if(mutation?.storesReplaced!==false||mutation?.physicalStoresRetained!==true||proof?.schemaVersion!=='analytics-mutation-proof-v2'
          ||proof.comparisonContract!=='native-existing-owner-v2'||proof.clockPolicy!=='native-v11-trigger-clocks-v1'||proof.kind!==phase
          ||proof.verifiedNativeBranch!==phase||proof.verified?.newEvents!==(phase==='no_op'?0:1)||!proof.rawSnapshotSha256
          ||mutation.paired?.divergences!==0||mutation.paired?.physicalFailures!==0)throw Error('Missing authentic persistent mutation proof');
        for(const lane of ['reference','candidate']){
          for(const boundary of ['before','after']){
            const hash=proof.rawSnapshotSha256?.[boundary]?.[lane];
            if(!/^[a-f0-9]{64}$/u.test(hash??'')||mutation.snapshots?.[lane]?.[boundary]?.sha256!==hash)throw Error('Mutation raw snapshot proof mismatch');
          }
          for(const profile of [mutation.admission?.[lane],mutation.delivery?.[lane],mutation.snapshots?.[lane]?.before?.measurement,mutation.snapshots?.[lane]?.after?.measurement])
            if(!profile||profile.failedStatements!==0||profile.measurementFailures!==0||!Number.isSafeInteger(profile.statements)||profile.statements<0
              ||profile.metadataSamples!==profile.statements||!Number.isSafeInteger(profile.maximumStatementsPerInvocation)
              ||profile.maximumStatementsPerInvocation<0||profile.maximumStatementsPerInvocation>950)throw Error('Mutation capture or delivery measurement incomplete');
        }
      }
    }else{
      const execution=summary.independentLaneExecution;
      if(execution?.basis!=='fresh-worker-per-lane-host-exact-dto-v1'||execution.seedDisposedBeforeLanes!==true||execution.firstLaneDisposedBeforePeer!==true
        ||JSON.stringify(execution.exits?.map(row=>row.lane))!==JSON.stringify(['seed','candidate','reference'])
        ||execution.exits.some(row=>row.code!==0||row.signal!==null))throw new Error('Missing independent cleanly disposed Worker lanes');
    }
    const snapshot=summary.sourceSnapshot;
    if(summary.sourceSchema!=='separate_native_pinned_candidate_upgraded'
      ||!summary.sourceIsolation?.startsWith('accepted-native-logical-snapshot-v1:')
      ||snapshot?.schemaVersion!=='analytics-source-snapshot-v1'||snapshot.exactSchemaAndData!==true||snapshot.exactRowids!==true
      ||![snapshot.sqlSha256,snapshot.schemaSha256,snapshot.rowidInventorySha256].every(value=>/^[a-f0-9]{64}$/u.test(value??''))
      ||snapshot.exportResourceMetadata!==null||snapshot.physicalSnapshotBytes!==null
      ||!['reference','candidate'].every(lane=>snapshot.importAndProof?.[lane]?.measurementFailures===0&&snapshot.importAndProof[lane].failedStatements===0
        &&snapshot.importAndProof[lane].metadataSamples===snapshot.importAndProof[lane].statements))
      throw new Error('Missing exact independent accepted-source snapshot evidence');
    if(summary.roleFailurePolicy!=='record-and-bound-output-retries-v1')throw new Error('Missing bounded role-failure evidence policy');
    if(summary.roleComposition!=='actual-three-role-schedules-v1')throw new Error('Integrated comparison must meter the actual three scheduled roles');
    if(!Number.isSafeInteger(summary.analyticalNowMs))throw new Error('Missing analytical calendar anchor');
    const anchor=Date.parse(new Date(summary.analyticalNowMs).toISOString().slice(0,10)+'T00:00:00.000Z');
    const dateBefore=offset=>new Date(anchor-offset*86_400_000).toISOString().slice(0,10);
    const requested=Array.from({length:summary.outputDates},(_,index)=>dateBefore(summary.outputDates-index));
    const retained=Array.from({length:70},(_,index)=>dateBefore(69-index));
    const calculated=[...new Set([...requested,...retained])].sort();
    const expected={requestedDates:requested,retainedModelDates:retained,calculatedModelDates:calculated,
      extraRequestedDates:requested.filter(day=>!retained.includes(day)),maintainedOnlyDates:retained.filter(day=>!requested.includes(day))};
    if(summary.nativePublicModelWindowDays!==70||JSON.stringify(summary.graphPopulation)!==JSON.stringify(expected))
      throw new Error('Integrated graph population omits retained or requested dates');
  }
  for(const [name,phase] of Object.entries(summary.phases)) {
    const output=phase?.output,counts=output?.completed,reference=phase?.reference;
    if(!counts||counts.dailyDays!==summary.outputDates||counts.currentScalarOwners!==2
      ||(integrated?counts.calculatedOwnerModelResults:counts.historicalOwnerModelResults)!==2*modelDateCount||counts.cacheOwnerDays!==2*(integrated?summary.cachePopulationDays:summary.outputDates)
      ||counts.nativePublishedModelDates!==(integrated?70:Math.min(summary.outputDates,69))||counts.preview!==1||counts.cacheSeries!==1
      ||JSON.stringify(Object.keys(output.familySha256??{}).sort())!==JSON.stringify(summary.schemaVersion==='analytics-whole-workload-v1'?families:[...families,'publishedDaily'].sort())
      ||![output.sha256,...Object.values(output.familySha256)].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value))
      ||!reference||reference.measurementFailures!==0||reference.failedStatements!==0
      ||reference.metadataSamples!==reference.statements)throw new Error('Incomplete output or resource measurement');
    if(summary.schemaVersion==='analytics-whole-workload-native-diagnostic-v2'&&(!Number.isSafeInteger(counts.publishedDailyOutcomes)||counts.publishedDailyOutcomes<summary.outputDates+7))throw new Error('Incomplete native diagnostic daily population');
    if(integrated) {
      const candidate=phase.candidate;
      for(const [lane,profile] of [['reference',reference],['candidate',candidate]]) {
        if(summary.sourceLineageEnabled===true&&['warm','no_op','unrelated_append'].includes(name))validateC06SourceCensus(profile.c06SourceLineage,{lane,phase:name,profile,outputSha256:output.sha256});else if(profile?.c06SourceLineage!==undefined)throw Error('Unexpected source census phase');
        if(summary.runtimeObservationEnabled&&(!['shared-vitest-isolate-phase-diagnostic-v1','fresh-worker-lane-segments-v1'].includes(profile?.runtimeObservation?.basis)||profile.runtimeObservation.comparativeHeapQualification!==false||profile.runtimeObservation.lane!==lane||(!profile.runtimeObservation.result&&!Array.isArray(profile.runtimeObservation.segments))))throw new Error('Missing or overstated runtime observation');
        if(profile?.logicalSubmissionInventoryComplete!==true)throw new Error('Unclassified logical payload submission');
        if(!(profile?.phaseStatements?.logical_inventory>0))throw new Error('Unmetered logical inventory');
        for(const label of ['initial','before_cleanup','after_cleanup'])for(const [side,count] of [['source',13],['target',127],['ledger',3]]) {
          const inventory=profile.logicalStoreSnapshots?.[label]?.[side],tables=Object.values(inventory?.tables??{});
          if(inventory?.schemaVersion!=='analytics-logical-stores-v1'||inventory?.side!==side||inventory?.complete!==true||tables.length!==count
            ||!tables.every(table=>typeof table.present==='boolean'&&['rows','rowBytes','payloadBytes'].every(key=>Number.isSafeInteger(table[key])&&table[key]>=0)
              &&(table.present||table.rows+table.rowBytes+table.payloadBytes===0))
            ||!['rows','rowBytes','payloadBytes'].every(key=>inventory[key]===tables.reduce((sum,table)=>sum+table[key],0))
            ||(side==='source'&&tables.filter(table=>table.present).length!==(lane==='reference'?2:13)))
            throw new Error('Incomplete closed retained logical inventory');
        }
      }
      if(counts.requestedOwnerModelResults!==2*summary.outputDates||counts.maintainedOwnerModelResults!==140)
        throw new Error('Requested and retained graph populations are incomplete');
      for(const population of [phase.actualStoredPopulation?.reference,phase.actualStoredPopulation?.candidate])
        if(!population||population.checkedAfterCleanup!==true||population.graphResults!==142
          ||population.modelOwnerResults!==140||population.modelDates!==70
          ||population.calculatedModelOwnerResults!==2*modelDateCount||population.calculatedModelDates!==modelDateCount
          ||population.retiredCalculationDates!==Math.max(0,summary.outputDates-69)
          ||population.currentFitOwners!==2||population.modelPublicationDates!==70
          ||!Object.values(population.modelOutcomeCounts??{}).every(value=>Number.isSafeInteger(value)&&value>0)
          ||Object.values(population.modelOutcomeCounts??{}).reduce((sum,value)=>sum+value,0)!==2*modelDateCount
          ||! /^[a-f0-9]{64}$/u.test(population.graphInventorySha256??''))
          throw new Error('Actual stored graph population or explicit outcomes incomplete');
      const nativeDaily=phase.actualStoredPopulation.reference,candidateDaily=phase.actualStoredPopulation.candidate;
      const midnight=Date.parse(new Date(summary.analyticalNowMs).toISOString().slice(0,10)+'T00:00:00.000Z');
      const expectedDaily=Array.from({length:summary.cachePopulationDays+7},(_,index)=>
        new Date(midnight-(summary.cachePopulationDays+6-index)*86_400_000).toISOString().slice(0,10));
      assertPrivateEqual(nativeDaily.prerequisiteDailyDates,expectedDaily,'Daily prerequisite population omitted dates');
      assertPrivateEqual(nativeDaily.prerequisiteDailyDates,candidateDaily.prerequisiteDailyDates,'Daily prerequisite populations differ');
      assertPrivateEqual(nativeDaily.dailyPublicationInventory,candidateDaily.dailyPublicationInventory,'Daily published payload inventory differs');
      assertPrivateEqual(nativeDaily.dailyPublications,candidateDaily.dailyPublications,'Actual daily publication populations differ');
      const outcomeDates=[...new Set([...nativeDaily.prerequisiteDailyDates,...(nativeDaily.dailyPublications?.dates??[])])].sort();
      if(!Array.isArray(nativeDaily.dailyPublicationInventory)||JSON.stringify(nativeDaily.dailyPublicationInventory.map(row=>row.day))!==JSON.stringify(outcomeDates)
        ||!nativeDaily.dailyPublicationInventory.every(row=>/^[a-f0-9]{64}$/u.test(row.publicDtoSha256??'')&&Array.isArray(row.stored)
          &&Array.isArray(row.visibleRevisions)&&row.stored.every(value=>Number.isSafeInteger(value.revision)&&value.revision>0
            &&/^[a-f0-9]{64}$/u.test(value.payloadSha256??'')&&typeof value.releasedAt==='string')))
        throw new Error('Daily per-date body/visibility evidence missing');
      if(!Array.isArray(nativeDaily.prerequisiteDailyDates)||nativeDaily.prerequisiteDailyDates.length===0
        ||!Array.isArray(nativeDaily.dailyPublications?.dates)
        ||nativeDaily.dailyPublications.dates.length!==nativeDaily.dailyPublications.days
        ||counts.publishedDailyOutcomes!==new Set([...nativeDaily.prerequisiteDailyDates,...nativeDaily.dailyPublications.dates]).size)
        throw new Error('All daily publication/expiry outcomes missing');
      if(phase.actualStoredPopulation.reference.graphInventorySha256!==phase.actualStoredPopulation.candidate.graphInventorySha256)
        throw new Error('Actual native and candidate graph populations differ');
      if(![reference,candidate].every(profile=>profile?.roleFailurePolicy===summary.roleFailurePolicy
          &&Array.isArray(profile.scheduledLaneFailures))||candidate?.unexpectedCandidateRoleFailures!==0
          ||candidate.scheduledLaneFailures.length!==0)throw new Error('Missing role fault evidence or unexpected candidate role fault');
      if(output.parity!=='exact'||!candidate||candidate.measurementFailures!==0||candidate.failedStatements!==0
        ||candidate.metadataSamples!==candidate.statements
        ||![reference,candidate].every(profile=>Number.isSafeInteger(profile.maximumStatementsPerInvocation)
          &&profile.maximumStatementsPerInvocation<=950
          &&['analytics_role','cache_role','publication_role'].every(role=>Number.isSafeInteger(profile.phaseStatements?.[role])&&profile.phaseStatements[role]>0)))throw new Error('Incomplete integrated candidate measurement');
    }
  }
  return summary;
}
/** Local controller bridge. Only phase labels cross it; no SQL or source rows.
 * The host waits for real CDP ACKs before allowing the runner to proceed. */
/** Exactly one owned observer at a time. Clear ownership before closing so an
 * error cannot leak the previous lane URL or cause a second close attempt. */
export function createRuntimeObservationOwner({factory=createRuntimeObservationBridge,onClosed=()=>{}}={}) {
  let active=null,opening=false,closing=false;
  return {
    async begin(options,identity) {
      if(active||opening||closing)throw Error('Runtime observer lane overlap');
      if(options===null)return null;
      opening=true;
      try{const bridge=await factory(options);active={bridge,identity};return bridge;}
      finally{opening=false;}
    },
    async close() {
      if(opening)throw Error('Runtime observer open in progress');
      if(!active)return;
      const owned=active;active=null;closing=true;
      try{await owned.bridge.close();}
      finally{try{onClosed(owned.bridge,owned.identity);}finally{closing=false;}}
    },
  };
}

export async function createRuntimeObservationBridge({inspectorUrl,expectedTargetId,observerFactory,independentLane=false}) {
  if(!observerFactory)({createAnalyticsWorkloadRuntimeObserver:observerFactory}=await import('./analytics-workload-runtime-observer.mjs'));
  const key=randomUUID();let observer=null,active=null,closed=false,requestSequence=0,segmentSequence=0;const observations=[];
  const transport={events:[],droppedEvents:0,maximumEvents:2048,connectionPolicy:'close-after-each-barrier'};
  const record=(event)=>{if(transport.events.length<transport.maximumEvents)transport.events.push(event);else transport.droppedEvents++;};
  const server=createServer(async(req,res)=>{
    const barrierStarted=performance.now(),sequence=++requestSequence;let event=null,segment=null;
    const trace=kind=>record({requestSequence:sequence,segmentSequence:segment,event:kind,wallMs:performance.now()-barrierStarted});
    trace('admitted');req.once('end',()=>trace('body_end'));req.once('aborted',()=>trace('request_aborted'));
    res.once('finish',()=>trace('response_finish'));res.once('close',()=>trace('response_close'));
    const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json',connection:'close'});res.end(JSON.stringify(value));};
    try {
      if(closed||req.method!=='POST'||req.url!=='/'+key){reply(404,{error:'unknown local observer barrier'});return;}
      let body='';for await(const chunk of req){body+=chunk;if(body.length>2048)throw new Error('observer barrier body bound');}
      event=JSON.parse(body);
      if(!event||Object.keys(event).sort().join(',')!=='kind,lane,phase'
        ||!['candidate','reference'].includes(event.lane)||!['cold','warm','no_op'].includes(event.phase)
        ||!['start','stop'].includes(event.kind))throw new Error('invalid local observer barrier');
      if(event.kind==='start') {
        if(active)throw new Error('overlapping runtime observation');segment=++segmentSequence;
        observer??=await observerFactory({inspectorUrl,expectedTargetId,commandTimeoutMs:5000,heapSampleIntervalMs:0,maxHeapObservations:256});
        const token=await observer.startPhase({lane:event.lane,phase:event.phase,deadlineMs:Date.now()+1_800_000});
        active={token,segmentSequence:segment,lane:event.lane,phase:event.phase,startBarrierWallMs:null};await observer.sampleHeap({label:'start'});active.startBarrierWallMs=performance.now()-barrierStarted;
        trace('start_ack');reply(200,{acknowledged:true,requestSequence:sequence,segmentSequence:segment});
      } else {
        if(!active||active.lane!==event.lane||active.phase!==event.phase)throw new Error('runtime stop does not match start');
        segment=active.segmentSequence;await observer.sampleHeap({label:'end'});
        const result=await observer.stopPhase(active.token),startBarrierWallMs=active.startBarrierWallMs;active=null;
        const observation={requestSequence:sequence,segmentSequence:segment,lane:event.lane,phase:event.phase,basis:independentLane?'fresh-vitest-isolate-segment-diagnostic-v1':'shared-vitest-isolate-phase-diagnostic-v1',comparativeHeapQualification:false,controllerBarrierWallMs:{start:startBarrierWallMs,stop:performance.now()-barrierStarted},sampledCpuContract:'Frame sample weights are neither exact nor billed CPU; heap observations are not a true peak.',
          boundary:'Actual scheduled roles, scoped requests, final fences, logical inventory, cleanup and exact full public DTO capture; excludes schema/admission/snapshot setup and separate SQL EXPLAIN. Complete outputs are transferred after observation to the controller for exact paired comparison.',result};
        observations.push(observation);if(independentLane){await observer.close();observer=null;}trace('stop_ack');reply(200,{acknowledged:true,requestSequence:sequence,segmentSequence:segment,observation});
      }
    } catch(error) {trace('rejected');observations.push({status:'unavailable',lane:['candidate','reference'].includes(event?.lane)?event.lane:null,phase:['cold','warm','no_op'].includes(event?.phase)?event.phase:null,comparativeHeapQualification:false,cpuMs:null,peakMemoryBytes:null,controllerBarrierWallMs:performance.now()-barrierStarted,reason:/^OBSERVER_[A-Z_]+$/u.test(error?.code??'')?error.code:'local_runtime_observer_barrier_failed'});reply(500,{error:'local runtime observer barrier failed'});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error('local observer address missing');
  return {url:`http://127.0.0.1:${address.port}/${key}`,observations,transport,
    async close(){if(closed)return;closed=true;try{const closed=await observer?.close();if(closed?.phase)observations.push({status:'incomplete',basis:'shared-vitest-isolate-phase-diagnostic-v1',comparativeHeapQualification:false,result:closed.phase});}finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}}};
}
/** Private accepted seed capability. It is minted only after the actual seed
 * process exited, then reused across independent scale laboratories. */
const sharedSeedCapabilities=new WeakMap();
const SCALE_MATRIX=Object.freeze([1,30,365]);
const SCALE_PIN_KEYS=Object.freeze(['referenceInputSha256','candidateInputSha256','harnessInputSha256','referenceBundleSha256','candidateBundleSha256','fixtureSha256']);
const seedFailure=code=>{throw Error('SHARED_SEED_'+code);};
const seedHex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const seedNat=value=>Number.isSafeInteger(value)&&value>=0;
const seedDigest=value=>createHash('sha256').update(canonicalReceiptJson(value)).digest('hex');
function freezeSeedValue(value){
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freezeSeedValue(child);Object.freeze(value);}return value;
}
function checkedSeedProfile(profile){
 if(!profile||!seedNat(profile.statements)||profile.metadataSamples!==profile.statements||profile.failedStatements!==0||profile.measurementFailures!==0)seedFailure('SETUP_COST');
 return profile;
}
function checkedSharedSeed(seed,analyticalNowMs){
 if(!seed||seed.analyticalNowMs!==analyticalNowMs||seed.transfer?.schemaVersion!=='analytics-accepted-source-transfer-v1')seedFailure('CLOCK_OR_TRANSFER');
 const {proof,statements}=seed.transfer;
 if(!proof||!['sqlSha256','schemaSha256','rowidInventorySha256','autoIncrementSequenceSha256'].every(key=>seedHex(proof[key]))
  ||!['exportStatements','exportedLogicalSqlBytes','rowidRows','typedRowsCompared'].every(key=>seedNat(proof[key]))
  ||!Array.isArray(statements)||statements.length>100000||statements.some(sql=>typeof sql!=='string')||proof.exportStatements!==statements.length)seedFailure('PROOF');
 const sql=[...statements].sort().join('\n');
 if(Buffer.byteLength(sql)>128*1024*1024||Buffer.byteLength(JSON.stringify(seed))>192*1024*1024
  ||Buffer.byteLength(sql)!==proof.exportedLogicalSqlBytes||createHash('sha256').update(sql).digest('hex')!==proof.sqlSha256)seedFailure('TRANSFER_DIGEST_OR_BOUND');
 const midnight=Date.parse(new Date(analyticalNowMs).toISOString().slice(0,10)+'T00:00:00.000Z');
 const dates=Array.from({length:466},(_,index)=>new Date(midnight-(465-index)*86400000).toISOString().slice(0,10));
 if(canonicalReceiptJson(seed.historyDates)!==canonicalReceiptJson(dates))seedFailure('HISTORY_POPULATION');
 for(const profile of [seed.initialAdmission,seed.laboratorySetup,seed.snapshotProfile])checkedSeedProfile(profile);
 if(!Number.isFinite(seed.snapshotExportWallMs)||seed.snapshotExportWallMs<0)seedFailure('EXPORT_WALL');
 return seed;
}
/** Local-only coordinator. Its output contains aggregate evidence, never SQL,
 * accepted rows or a transferable seed token. Existing single-scale validators
 * are reused before each checkpoint; defaults are unchanged. */
export function createSharedSeedScaleExperiment({analyticalNowMs,inputPins}){
 if(!Number.isSafeInteger(analyticalNowMs)||analyticalNowMs<0||!Number.isFinite(new Date(analyticalNowMs).getTime()))seedFailure('CLOCK');
 if(!inputPins||Object.keys(inputPins).sort().join(',')!==[...SCALE_PIN_KEYS].sort().join(',')||!Object.values(inputPins).every(seedHex))seedFailure('INPUT_PINS');
 const pins=freezeSeedValue(structuredClone(inputPins));let active=null,token=null,closed=false,failed=false;const completed=[];
 const assertOpen=()=>{if(closed||failed)seedFailure('CLOSED_OR_FAILED');};
 const seedRecord=()=>{const value=token&&sharedSeedCapabilities.get(token);if(!value)seedFailure('NOT_CAPTURED');return value;};
 const rehydrate=(compact,record)=>({...compact,initialAdmission:{reference:record.seed.initialAdmission,candidate:compact.sharedSeedCosts.candidateAdmission},
  inputAdmission:{reference:record.seed.initialAdmission,candidate:compact.sharedSeedCosts.candidateAdmission},
  laboratorySetup:{...compact.laboratorySetup,seed:record.seed.laboratorySetup},sourceSnapshot:{...compact.sourceSnapshot,seedProof:record.seed.snapshotProfile}});
 return {
  beginScale(dates){assertOpen();if(active!==null||dates!==SCALE_MATRIX[completed.length])seedFailure('SCALE_ORDER');active=dates;return token?{retainedSeed:token}:{};},
  captureSeed(bridge){assertOpen();if(active!==1||token)seedFailure('CAPTURE_ORDER');
   const state=bridge?.state,exit=state?.exits?.[0];
   if(!state||state.active!==null||state.exits.length!==1||exit?.lane!=='seed'||exit.code!==0||exit.signal!==null)seedFailure('SEED_EXIT');
   const seed=checkedSharedSeed(state.seed,analyticalNowMs),value={seed:freezeSeedValue(seed),exit:freezeSeedValue({...exit}),pins,active:true};
   token=Object.freeze({});sharedSeedCapabilities.set(token,value);
   return {contract:'accepted-shared-seed-v1',analyticalNowMs,sourceProof:seed.transfer.proof,inputPins:pins,historyCalendarDays:466,actualSeedProcesses:1};
  },
  completeScale(summary){assertOpen();const record=seedRecord();
   if(active===null||summary.outputDates!==active||summary.sharedUniqueHistoryCalendarDays!==466||summary.cachePopulationDays!==466||summary.analyticalNowMs!==analyticalNowMs)seedFailure('SCALE_BASIS');
   readWholeWorkloadSummary('analytics-whole-workload '+JSON.stringify(summary));
   if(summary.sharedSeedScale?.contract!=='accepted-shared-seed-v1'||summary.sharedSeedScale.sourceProofSha256!==seedDigest(record.seed.transfer.proof)||summary.sharedSeedScale.analyticalNowMs!==analyticalNowMs||summary.sharedSeedScale.historyCalendarDays!==466||summary.sharedSeedScale.requestedDates!==active)seedFailure('LANE_PROVENANCE');
   if(summary.integrationDebug||summary.comparisonBasis!=='fresh-worker-retained-graph-cache-and-ordered-delivery-v6'||Object.keys(summary.phases).join(',')!=='cold,warm,no_op')seedFailure('PHASES');
   for(const key of Object.keys(record.seed.transfer.proof))if(summary.sourceSnapshot[key]!==record.seed.transfer.proof[key])seedFailure('SOURCE_IDENTITY');
   const evidence=summary.evidence;
   if(!evidence||evidence.reference?.inputSha256!==pins.referenceInputSha256||evidence.reference?.bundleSha256!==pins.referenceBundleSha256
    ||evidence.candidate?.inputSha256!==pins.candidateInputSha256||evidence.candidate?.bundleSha256!==pins.candidateBundleSha256
    ||evidence.harness?.inputSha256!==pins.harnessInputSha256||evidence.fixture?.sha256!==pins.fixtureSha256)seedFailure('INPUT_DRIFT');
   assertPrivateEqual(summary.initialAdmission.reference,record.seed.initialAdmission,'Shared seed admission changed');
   assertPrivateEqual(summary.inputAdmission.reference,record.seed.initialAdmission,'Shared input admission changed');
   assertPrivateEqual(summary.inputAdmission.candidate,summary.initialAdmission.candidate,'Candidate admission accounting changed');
   assertPrivateEqual(summary.laboratorySetup.seed,record.seed.laboratorySetup,'Shared seed setup changed');
   assertPrivateEqual(summary.sourceSnapshot.seedProof,record.seed.snapshotProfile,'Shared seed proof changed');
   const compact=structuredClone(summary),candidateAdmission=compact.initialAdmission.candidate;
   delete compact.initialAdmission;delete compact.inputAdmission;delete compact.laboratorySetup.seed;delete compact.sourceSnapshot.seedProof;
   compact.sharedSeedCosts={contract:'one-actual-seed-cost-v1',referenceAdmission:'commonSeed',seedSetup:'commonSeed',seedProof:'commonSeed',candidateAdmission};
   const checkpoint=freezeSeedValue({dates:active,summary:compact,summarySha256:seedDigest(compact),sourceProofSha256:seedDigest(record.seed.transfer.proof)});
   completed.push(checkpoint);active=null;
   return checkpoint;
  },
  checkpoint(){const record=token&&sharedSeedCapabilities.get(token);return {contract:'shared-seed-scale-progress-v1',complete:false,completedDates:completed.map(row=>row.dates),activeDate:active,failed,
   acceptedSourceProofSha256:record?seedDigest(record.seed.transfer.proof):null,completed:completed.map(row=>({dates:row.dates,summarySha256:row.summarySha256}))};},
  finish(){assertOpen();const record=seedRecord();if(active!==null||completed.length!==3)seedFailure('INCOMPLETE');
   for(const row of completed)readWholeWorkloadSummary('analytics-whole-workload '+JSON.stringify(rehydrate(row.summary,record)));
   const receipt={schemaVersion:'analytics-shared-seed-scale-matrix-v1',wholeWorkloadQualification:false,complete:true,analyticalNowMs,inputPins:pins,scales:[...SCALE_MATRIX],
    commonSeed:{contract:'accepted-shared-seed-v1',actualSeedProcesses:1,historyCalendarDays:466,proof:record.seed.transfer.proof,
     laboratorySetup:record.seed.laboratorySetup,initialAdmission:record.seed.initialAdmission,snapshotProfile:record.seed.snapshotProfile,snapshotExportWallMs:record.seed.snapshotExportWallMs,
     exportResourceMetadata:null,physicalSnapshotBytes:null},
    costs:{contract:'one-seed-plus-independent-scale-work-v1',sharedSeedChargedOnce:true,perScaleImportsSetupProofsUpgradesPhasesAndCleanupRetained:true,totalCost:null,
     reason:'No sum across incompatible units; native export resource metadata, exact CPU, peak heap and cloud bytes remain unavailable.'},
    completed};
   if(Buffer.byteLength(JSON.stringify(receipt))>8*1024*1024)seedFailure('RECEIPT_BOUND');return receipt;
  },
  fail(){failed=true;},
  close(){closed=true;if(token){const record=sharedSeedCapabilities.get(token);if(record)record.active=false;sharedSeedCapabilities.delete(token);}token=null;},
 };
}

/** The sole holder of both lane DTOs. Synthetic accepted SQL and complete DTOs
 * cross loopback only, stay in memory, and never enter receipt/log artifacts. */
export async function createLaneEvidenceBridge({retainedSeed}={}) {
  const key=randomUUID(),state={active:null,seed:null,lanes:new Map(),phaseOutputs:new Map(),transfers:[],exits:[],closed:false};
  if(retainedSeed!==undefined){const record=sharedSeedCapabilities.get(retainedSeed);if(!record?.active)seedFailure('FOREIGN_OR_CLOSED_TOKEN');state.seed=record.seed;state.exits.push(record.exit);}
  const server=createServer(async(req,res)=>{
    const started=performance.now();let requestBytes=0,message;
    const reply=(status,value)=>{const encoded=JSON.stringify(value);state.transfers.push({lane:state.active,status,kind:['read_seed','write_seed','write_phase','write_lane'].includes(message?.kind)?message.kind:'refused',requestPayloadUtf8Bytes:requestBytes,responsePayloadUtf8Bytes:Buffer.byteLength(encoded),controllerWallMs:performance.now()-started});res.writeHead(status,{'content-type':'application/json'});res.end(encoded);};
    try {
      if(state.closed||req.method!=='POST'||req.url!=='/'+key)return reply(404,{error:'unknown laboratory transfer'});
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>192*1024*1024)throw Error('laboratory transfer bound');chunks.push(chunk);}
      requestBytes=size;message=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!message||!['seed','candidate','reference'].includes(message.lane)||message.lane!==state.active)throw Error('laboratory lane mismatch');
      if(message.kind==='read_seed'&&message.lane!=='seed'&&state.seed){reply(200,{acknowledged:true,seed:state.seed});return;}
      if(message.kind==='write_seed'&&message.lane==='seed'&&!state.seed&&message.seed?.transfer?.schemaVersion==='analytics-accepted-source-transfer-v1') {
        state.seed=message.seed;reply(200,{acknowledged:true});return;
      }
      if(message.kind==='write_phase'&&message.lane!=='seed'&&['cold','warm','no_op'].includes(message.phase)&&Array.isArray(message.output)) {
        const phases=state.phaseOutputs.get(message.lane)??{};if(Object.hasOwn(phases,message.phase))throw Error('duplicate complete phase');
        phases[message.phase]=message.output;state.phaseOutputs.set(message.lane,phases);reply(200,{acknowledged:true});return;
      }
      if(message.kind==='write_lane'&&message.lane!=='seed'&&!state.lanes.has(message.lane)&&message.evidence?.completed===true) {
        state.lanes.set(message.lane,{...message.evidence,outputs:state.phaseOutputs.get(message.lane)??{}});reply(200,{acknowledged:true});return;
      }
      throw Error('invalid laboratory transfer state');
    } catch {reply(400,{error:'laboratory transfer refused'});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const {port}=server.address();
  return {url:`http://127.0.0.1:${port}/${key}`,state,
    begin(lane){if(state.active||!['seed','candidate','reference'].includes(lane)||state.exits.some(row=>row.lane===lane))throw Error('overlapping or repeated laboratory lane');if(lane!=='seed'&&(!state.seed||state.exits[0]?.code!==0))throw Error('accepted seed did not exit successfully');state.active=lane;},
    end(lane,code,signal){if(state.active!==lane)throw Error('laboratory exit lane mismatch');state.exits.push({lane,code,signal:signal??null});state.active=null;},
    async close(){if(state.closed)return;state.closed=true;await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));state.seed=null;state.lanes.clear();state.phaseOutputs.clear();}};
}
export function decodeWholeWorkloadValue(node,depth=0) {
  if(depth>128||!Array.isArray(node))throw Error('invalid complete DTO encoding');
  const [kind,value]=node;
  if(kind==='undefined'&&node.length===1)return undefined;
  if(kind==='null'&&node.length===1)return null;
  if(kind==='string'&&node.length===2&&typeof value==='string')return value;
  if(kind==='boolean'&&node.length===2&&typeof value==='boolean')return value;
  if(kind==='number'&&node.length===2&&typeof value==='number'&&Number.isFinite(value))return value;
  if(kind==='negative_zero'&&node.length===1)return -0;
  if(kind==='array'&&node.length===2&&Array.isArray(value))return value.map(child=>decodeWholeWorkloadValue(child,depth+1));
  if(kind==='object'&&node.length===2&&Array.isArray(value)) {
    const result={};for(const pair of value){if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='string'||Object.hasOwn(result,pair[0]))throw Error('invalid complete DTO object');Object.defineProperty(result,pair[0],{value:decodeWholeWorkloadValue(pair[1],depth+1),enumerable:true,writable:true,configurable:true});}return result;
  }
  throw Error('invalid complete DTO encoding');
}
function assertPrivateEqual(left,right,label) {try{assert.deepStrictEqual(left,right);}catch{throw Error(label??'private exact comparison differs');}}
export function mergeFreshLaneEvidence(seed,reference,candidate,exits) {
  if(!seed||!reference?.completed||!candidate?.completed||JSON.stringify(exits.map(row=>row.lane))!==JSON.stringify(['seed','candidate','reference'])||exits.some(row=>row.code!==0||row.signal!==null))throw Error('independent laboratory lanes did not exit cleanly');
  const left=reference.summary,right=candidate.summary;
  for(const key of ['schemaVersion','referenceCommit','analyticalNowMs','graphPopulation','outputDates','cachePopulationDays','comparisonBasis','publicationTimestampContract','roleComposition','roleFailurePolicy','optimizationProfiles','dailyPopulationContract','sourceLineageEnabled','sharedSeedScale'])assertPrivateEqual(left[key],right[key],`lane basis differs: ${key}`);
  for(const lane of [reference,candidate])assertPrivateEqual(lane.snapshotImport.proof,seed.transfer.proof,'accepted source identity changed');
  const phases={};assertPrivateEqual(Object.keys(left.phases),Object.keys(right.phases));
  for(const phase of Object.keys(left.phases)) {
    const native=left.phases[phase],next=right.phases[phase];
    assertPrivateEqual(decodeWholeWorkloadValue(reference.outputs[phase]),decodeWholeWorkloadValue(candidate.outputs[phase]),`complete output mismatch: ${phase}`);
    assertPrivateEqual(native.output,next.output,'output hash/count mismatch');
    phases[phase]={...native,candidate:next.candidate,actualStoredPopulation:{reference:native.actualStoredPopulation.reference,candidate:next.actualStoredPopulation.candidate},inputMutation:{reference:native.inputMutation.reference,candidate:next.inputMutation.candidate},output:{...native.output,parity:'exact'}};
  }
  const empty={reference:left.initialAdmission.reference,candidate:right.initialAdmission.candidate};
  const observations=Object.values(phases).flatMap(phase=>[phase.reference.runtimeObservation,phase.candidate.runtimeObservation]).filter(Boolean);
  const ids=observations.map(value=>value.isolateId);
  if(left.runtimeObservationEnabled&&(ids.some(id=>typeof id!=='string')||new Set(ids.slice(0,2)).size!==2))throw Error('observed lane isolate identity reused');
  return {...left,phases,initialAdmission:{...empty,reference:seed.initialAdmission},inputAdmission:{...empty,reference:seed.initialAdmission},
    laboratorySetup:{reference:left.laboratorySetup.reference,candidate:right.laboratorySetup.candidate,seed:seed.laboratorySetup},
    sourceSchemaUpgrade:{reference:left.sourceSchemaUpgrade.reference,candidate:right.sourceSchemaUpgrade.candidate},
    sourceSnapshot:{schemaVersion:'analytics-source-snapshot-v1',exactSchemaAndData:true,exactRowids:true,...seed.transfer.proof,
      importAndProof:{reference:reference.snapshotImport.proofProfile,candidate:candidate.snapshotImport.proofProfile},
      laneImports:{reference:reference.snapshotImport,candidate:candidate.snapshotImport},seedProof:seed.snapshotProfile,
      exportResourceMetadata:null,physicalSnapshotBytes:null,exportResourceGap:'Three local exports (seed plus each imported lane verification) expose no D1 resource metadata; export reads/CPU/physical bytes remain unknown.'},
    independentLaneExecution:{basis:'fresh-worker-per-lane-host-exact-dto-v1',exits,comparison:'Complete tagged DTOs decoded and deep-strict compared in the loopback controller; no peer DTO retained in either Worker.',seedDisposedBeforeLanes:true,firstLaneDisposedBeforePeer:true,isolateIds:ids},
    sourceIsolation:SOURCE_ISOLATION_CONTRACT};
}
const SOURCE_ISOLATION_CONTRACT='accepted-native-logical-snapshot-v1: one pinned native admission, exact source export/schema/typed-row/rowid verification in each fresh physical lane before candidate-only upgrade; host retains accepted transport in memory only. Import/export setup and unavailable exporter metadata are separate; not byte-identical storage or incremental restore.';

async function unusedLoopbackPort() {
  const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error('inspector port allocation unavailable');
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return address.port;
}
export async function buildKernelBundle(root,outfile,lane,referenceCommit,options={}) {
  if(Object.keys(options).some(key=>!['mutationCapture','c06Scope','c06SharedScope'].includes(key))||Object.values(options).some(value=>value!==true)||(options.c06Scope||options.c06SharedScope)&&lane!=='candidate'||options.c06Scope&&options.c06SharedScope)throw Error('Unsupported kernel bundle instrumentation');
  const mutation=options.mutationCapture?createAnalyticsMutationCaptureTransform({lane}):null;
  const c06Scope=options.c06SharedScope?createAnalyticsC06SharedScopeTransform({lane}):options.c06Scope?createAnalyticsC06ScopeTransform({lane}):null;
  root=await realpath(root);
  const clock=createAnalyticsWorkloadPublicationClockTransform({profile:lane==='candidate'?'current':'pinned-f056940f',lane});
  let source=await readFile(path.join(workerRoot,facade),'utf8');
  source=source.replace(/export const publicationClockAdapted[^;]+;/u,'export const publicationClockAdapted=true;')
    .replace(/export function (?:setAnalyticsWorkloadPublicationClock|readAnalyticsWorkloadPublicationClock)[^\n]+/gu,'');
  source+='\n'+clock.entryExports;
  if(c06Scope)source+='\n'+c06Scope.entryExports;
  if(lane==='candidate') {
    for(const name of ['computeStorageGraphResult','advanceStorageCommunityDaily','readPublishedStorageCommunityDaily','publishStorageCommunityModelDay','publishStorageCommunityGraphPreview','createCacheRetentionDaySourceBuild'])
      source=source.replace(new RegExp('\\b'+name+'\\s*,?'),'');
    source+='\n'+(await readFile(path.join(workerRoot,'test/helpers/analytics-candidate.ts'),'utf8')).replace("export * from './analytics-workload-kernels';",'');
  }
  if(mutation){
    let admission=await readFile(path.join(workerRoot,'test/helpers/analytics-mutation-current.ts'),'utf8');
    admission=admission.replace(/^export \{initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus\}[^\n]+$/gmu,'')
      .replace(/^export \{initializeStorageAnalyticsRuntime,advanceStorageAnalytics\}[^\n]+$/gmu,'')
      .replace(/^export \* from [^\n]+$/gmu,'')
      .replace(/^export const nativeMigrationNames[^\n]+$/gmu,'')
      .replace(/^export function drainMutation(?:StepPreimages|CaptureMeasurement)[^\n]+$/gmu,'')
      .replace('export const mutationCaptureInstrumented:boolean=false;','export const mutationCaptureInstrumented=true;')
      .replace("'./telemetry-v11'","'./test/helpers/telemetry-v11'");
    source+='\n'+admission+'\n'+mutation.entryExports;
  }
  const directories={TEST_MIGRATIONS:'migrations',TEST_TYPED_INGESTION_MIGRATIONS:'typed-ingestion-migrations',
    TEST_INGESTION_BRIDGE_MIGRATIONS:'ingestion-bridge-migrations',TEST_TYPED_V1_ADMISSION_MIGRATIONS:'typed-v1-admission-migrations',
    TEST_TYPED_V11_ADMISSION_MIGRATIONS:'typed-v11-admission-migrations',TEST_INGESTION_ISOLATION_MIGRATIONS:'ingestion-isolation-migrations',
    TEST_ANALYTICS_MIGRATIONS:'analytics-migrations'};
  const migrationNames=Object.fromEntries(await Promise.all(Object.entries(directories).map(async([key,directory])=>
    [key,(await readdir(path.join(root,'apps/worker',directory))).filter(file=>file.endsWith('.sql')).sort()])));
  const entry=source.replaceAll('../../src/','./src/').replaceAll('../fixtures/','./test/fixtures/').replace(/export const referenceCommit:[^;]+;/u,
    `export const referenceCommit=${JSON.stringify(referenceCommit)};`)
    .replace(/export const nativeMigrationNames:[^;]+;/u,`export const nativeMigrationNames=${JSON.stringify(migrationNames)};`)
    .replace(/export function resetPricingCalls[^\n]+/u,
      `export function resetPricingCalls(){globalThis[${JSON.stringify('__p11_'+lane)}]=0;}`)
    .replace(/export function pricingCalls[^\n]+/u,
      `export function pricingCalls(){return globalThis[${JSON.stringify('__p11_'+lane)}]??0;}`);
  let instrumentedDefinitions=0,fixtureOverrides=0;
  const result=await build({stdin:{contents:entry,resolveDir:path.join(root,'apps/worker'),loader:'ts'},
    outfile,absWorkingDir:repositoryRoot,bundle:true,write:true,metafile:true,platform:'neutral',format:'esm',target:'es2022',
    mainFields:['module','main'],external:['cloudflare:test','cloudflare:workers'],nodePaths:[path.join(workerRoot,'node_modules')],
    alias:Object.fromEntries(['accounting','quota-analysis','telemetry-contract'].map(name=>
      ['@app-usagemonitor/'+name,path.join(root,'packages',name,'index.js')])),
    plugins:[{name:'local-analytical-clock-and-pricing-counter',setup(builder){
      if(mutation){
        builder.onResolve({filter:/^analytics-workload:mutation-step\//},args=>{if(args.path!==mutation.moduleSpecifier)throw Error('Unexpected mutation lane');return {path:args.path,namespace:'p11-mutation-step'};});
        builder.onLoad({filter:/.*/,namespace:'p11-mutation-step'},()=>({contents:mutation.moduleSource,loader:'js'}));
      }
      if(c06Scope){
        builder.onResolve({filter:/^analytics-workload:c06-operation-scope\//},args=>{if(args.path!==c06Scope.moduleSpecifier)throw Error('Unexpected C06 scope lane');return {path:args.path,namespace:'p11-c06-operation-scope'};});
        builder.onLoad({filter:/.*/,namespace:'p11-c06-operation-scope'},()=>({contents:c06Scope.moduleSource,loader:'js'}));
      }
      builder.onResolve({filter:/^analytics-workload:publication-clock\//},args=>{if(args.path!==clock.moduleSpecifier)throw Error('Unexpected clock lane');return {path:args.path,namespace:'p11-publication-clock'};});
      builder.onLoad({filter:/.*/,namespace:'p11-publication-clock'},()=>({contents:clock.clockModuleSource,loader:'js'}));
      builder.onLoad({filter:/\.[cm]?[jt]s$/},async args=>{
      // Only the synthetic fixture gains the explicit delivery mode. Its
      // production imports continue to resolve inside each lane's own tree.
      const fixture=args.path.endsWith('/apps/worker/'+corpusFixture);
      const original=await readFile(fixture?path.join(workerRoot,corpusFixture):args.path,'utf8');
      const sourcePath=path.relative(root,args.path).split(path.sep).join('/');
      const captured=mutation?.transformSource({path:sourcePath,contents:original});
      const clocked=clock.transformSource({path:sourcePath,contents:captured?.contents??original})??captured;
      const adapted=c06Scope?.transformSource({path:sourcePath,contents:clocked?.contents??original,originalContents:original})??clocked;
      const contents=adapted?.contents??original;
      if(fixture){fixtureOverrides++;return {contents,loader:'ts'};}
      if(!/function (?:priceChunkUsageRecord(?:Value)?|priceUsageRecord)\s*\(/u.test(contents))return adapted??undefined;
      const converted=await transform(contents,{loader:args.path.endsWith('.ts')?'ts':'js',target:'es2022'});
      const code=converted.code.replace(/function (priceChunkUsageRecord(?:Value)?|priceUsageRecord)\(([^)]*)\) \{/gu,
        (match)=>{instrumentedDefinitions++;return `${match} globalThis[${JSON.stringify('__p11_'+lane)}]=(globalThis[${JSON.stringify('__p11_'+lane)}]??0)+1;`;});
      return {contents:code,loader:'js'};
    });}}],logLevel:'silent'});
  if(fixtureOverrides!==1)throw new Error('Maintained corpus fixture override unavailable');
  if(instrumentedDefinitions===0)throw new Error('Native pricing instrumentation seam unavailable');
  const publicationClock=clock.completeManifest();
  const hash=createHash('sha256');
  const files=[];
  for(const input of Object.keys(result.metafile.inputs).filter(value=>value!=='<stdin>'&&!value.startsWith('p11-publication-clock:')&&!value.startsWith('p11-mutation-step:')&&!value.startsWith('p11-c06-operation-scope:')).sort()) {
    const resolved=path.resolve(repositoryRoot,input);
    const absolute=resolved.endsWith('/apps/worker/'+corpusFixture)?path.join(workerRoot,corpusFixture):resolved;
    const bytes=await readFile(absolute);
    const sha256=createHash('sha256').update(bytes).digest('hex');
    hash.update(sha256);
    files.push({path:absolute,sha256});
  }
  return {bundleSha256:createHash('sha256').update(await readFile(outfile)).digest('hex'),
    inputSha256:hash.digest('hex'),inputFiles:files,instrumentedDefinitions,fixtureOverrides,publicationClock,...(mutation?{capture:mutation.completeManifest()}: {}),...(c06Scope?{c06Scope:c06Scope.completeManifest()}: {})};
}
async function verifyBundleInputs(bundle) {
  for(const file of bundle.inputFiles)
    if(createHash('sha256').update(await readFile(file.path)).digest('hex')!==file.sha256)
      throw new Error('Bundle inputs changed during benchmark; no receipt can be saved');
}
// Local controller provenance only. This does not establish analytical output,
// source-lineage coverage, billed CPU, or an isolated/complete OS environment.
const WHOLE_INPUT_RUNTIME_ROOTS=['vitest','vite','miniflare','workerd','esbuild','@cloudflare/vitest-pool-workers'];
const pinDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pinBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
function pinEnvironment(){return {nodeOptionsSha256:pinBytes(process.env.NODE_OPTIONS??''),execArgvSha256:pinDigest(process.execArgv),
  workerdOverrideSha256:pinBytes(process.env.MINIFLARE_WORKERD_PATH??''),esbuildOverrideSha256:pinBytes(process.env.ESBUILD_BINARY_PATH??'')};}
async function sqlInputNames(worker){
  const files=[];
  async function walk(directory,ancestors=new Set()){
    const resolved=await realpath(directory);if(ancestors.has(resolved))throw Error('Whole-workload migration directory cycle');
    const next=new Set(ancestors).add(resolved);
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name),type=entry.isSymbolicLink()?await stat(file):entry;
      if(type.isDirectory())await walk(file,next);
      else if(entry.name.endsWith('.sql')){if(!type.isFile())throw Error('Whole-workload migration input is not a file');files.push(file);}
    }
  }
  for(const dir of await readdir(worker))if(dir==='migrations'||dir.endsWith('-migrations'))await walk(path.join(worker,dir));
  return files.sort();
}
function resolveRuntimePackage(name,resolver,required){
  try{return resolver.resolve(name+'/package.json');}catch(error){if(!['ERR_PACKAGE_PATH_NOT_EXPORTED','MODULE_NOT_FOUND'].includes(error.code))throw error;}
  for(const folder of resolver.resolve.paths(name)??[]){const file=path.join(folder,name,'package.json');
    try{if(JSON.parse(readFileSync(file,'utf8')).name===name)return file;}catch(error){if(error.code!=='ENOENT')throw error;}}
  if(required)throw Error('Whole-workload required runtime package unavailable');
}
async function filePin(file){const resolved=await realpath(file),info=await stat(resolved);if(!info.isFile())throw Error('Whole-workload input is not a file');
  return {path:file,realPath:resolved,bytes:info.size,sha256:pinBytes(await readFile(file))};}
/** Capture the actual test/config graphs as well as all existing caller pins.
 * workerDirectory is explicit only to allow isolated filesystem refusal tests. */
export async function captureWholeWorkloadRunInputs({workerDirectory=workerRoot,testFiles,configFiles,aliases={},generatedFiles,inheritedFiles=[]}){
  const started=performance.now();
  if(!Array.isArray(testFiles)||!testFiles.length||!Array.isArray(configFiles)||!configFiles.length||!Array.isArray(generatedFiles)||!generatedFiles.length)
    throw Error('Whole-workload input roots required');
  const selected=new Set([...testFiles,...configFiles,...generatedFiles,...inheritedFiles].map(file=>path.resolve(file))),packages=[],packageSeen=new Set(),runtimeFiles=new Set();
  const resolver=createRequire(path.join(workerDirectory,'package.json'));
  const metadataDirectories=new Set();
  async function sourceMetadata(file){const start=path.dirname(file);if(metadataDirectories.has(start))return;metadataDirectories.add(start);
    // Include compiler/package metadata for the archived native input tree as
    // well as the current graph; generated bundle bytes remain independently pinned.
    for(const name of ['package.json','tsconfig.json'])for(let dir=start;;){
      try{const metadata=path.join(dir,name);await stat(metadata);selected.add(metadata);break;}catch(error){if(error.code!=='ENOENT')throw error;}
      const parent=path.dirname(dir);if(parent===dir)break;dir=parent;
    }
  }
  for(const file of inheritedFiles)await sourceMetadata(path.resolve(file));
  async function tree(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);
    if(entry.isDirectory()&&entry.name!=='node_modules'&&entry.name!=='.git')await tree(file);
    else if(entry.isFile()||entry.isSymbolicLink()){const info=await stat(file);if(info.isFile()){selected.add(file);runtimeFiles.add(file);}else throw Error('Whole-workload unsupported runtime link');}}}
  async function addPackageJson(file){const resolved=await realpath(file);if(packageSeen.has(resolved))return;packageSeen.add(resolved);selected.add(file);
    const value=JSON.parse(await readFile(resolved,'utf8'));if(typeof value.name!=='string'||typeof value.version!=='string')throw Error('Whole-workload malformed runtime package');
    packages.push({name:value.name,version:value.version,packageJson:resolved});await tree(path.dirname(resolved));const child=createRequire(resolved);
    for(const name of Object.keys(value.dependencies??{}).sort())await addPackageJson(resolveRuntimePackage(name,child,true));
    for(const name of Object.keys(value.optionalDependencies??{}).sort()){const found=resolveRuntimePackage(name,child,false);if(found)await addPackageJson(found);}}
  const localEdges=new Set();
  async function collectGraph(entries,config=false){
    const result=await build({entryPoints:entries,absWorkingDir:workerDirectory,bundle:true,write:false,outdir:path.join(workerDirectory,'.whole-input-unused'),metafile:true,
      platform:config?'node':'neutral',format:'esm',target:'es2022',mainFields:['module','main'],nodePaths:[path.join(workerDirectory,'node_modules')],
      ...(config?{packages:'external'}:{external:['vitest','cloudflare:test','cloudflare:workers','node:*']}),
      plugins:config?[]:[{name:'exact-whole-kernel-aliases',setup(builder){builder.onResolve({filter:/.*/},args=>isBuiltin(args.path)?{path:args.path,external:true}:Object.hasOwn(aliases,args.path)?{path:aliases[args.path]}:undefined);}}],logLevel:'silent'});
    const inputs=[],localRoots=[];
    for(const [key,details] of Object.entries(result.metafile.inputs)){const file=path.resolve(workerDirectory,key.replace(/ with \{.*\}$/u,''));inputs.push(file);selected.add(file);
      // Package manifests and installed copies are actual inputs even when the
      // same library is separately bundled from repository sources.
      const marker=file.lastIndexOf('/node_modules/');if(marker>=0){const suffix=file.slice(marker+14).split('/'),count=suffix[0]?.startsWith('@')?2:1;
        await addPackageJson(path.join(file.slice(0,marker+14),...suffix.slice(0,count),'package.json'));}
      else await sourceMetadata(file);
      for(const dependency of details?.imports??[])if(dependency.external&&!isBuiltin(dependency.path)&&!['cloudflare:test','cloudflare:workers'].includes(dependency.path)){
        if(dependency.path.startsWith('.')||path.isAbsolute(dependency.path)){
          // Esbuild can mark an erased/type-only local import external. Resolve
          // it through esbuild as another entry, conservatively retaining its
          // exact closure; an actually missing local dependency still fails.
          const local=path.resolve(path.dirname(file),dependency.path),key=String(config)+':'+local;
          if(!localEdges.has(key)){localEdges.add(key);localRoots.push(local);}continue;
        }
        const parts=dependency.path.split('/'),name=parts.slice(0,parts[0].startsWith('@')?2:1).join('/');await addPackageJson(resolveRuntimePackage(name,createRequire(file),true));}
    }
    if(localRoots.length)inputs.push(...await collectGraph(localRoots,config));
    return [...new Set(inputs)].sort();
  }
  const testInputs=await collectGraph(testFiles),configInputs=await collectGraph(configFiles,true);
  for(const file of ['package.json','package-lock.json','wrangler.jsonc','worker-configuration.d.ts','tsconfig.json'])selected.add(path.join(workerDirectory,file));
  const sqlFiles=await sqlInputNames(workerDirectory);for(const file of sqlFiles)selected.add(file);
  for(const name of [...WHOLE_INPUT_RUNTIME_ROOTS,`@cloudflare/workerd-${process.platform}-${process.arch}`,`@esbuild/${process.platform}-${process.arch}`])await addPackageJson(resolveRuntimePackage(name,resolver,true));
  const node=await realpath(process.execPath),workerd=await realpath(process.env.MINIFLARE_WORKERD_PATH??resolver('workerd').default),
    esbuild=await realpath(process.env.ESBUILD_BINARY_PATH||path.join(path.dirname(resolveRuntimePackage(`@esbuild/${process.platform}-${process.arch}`,resolver,true)),'bin/esbuild'));
  for(const file of [node,workerd,esbuild])selected.add(file);
  const files=[];for(const file of [...selected].sort())files.push(await filePin(file));
  const runtime={packages:packages.sort((a,b)=>a.packageJson.localeCompare(b.packageJson)),files:[...runtimeFiles].sort(),selectedExecutables:{node,workerd,esbuild},
    nodeVersion:process.version,nodeVersions:process.versions,platform:process.platform,arch:process.arch,environment:pinEnvironment(),systemLibrariesQualified:false};
  return {schemaVersion:'whole-workload-run-inputs-v1',captureOptions:{workerDirectory,testFiles,configFiles,aliases,generatedFiles,inheritedFiles},workerDirectory,testInputs,configInputs,generatedFiles:[...generatedFiles].sort(),sqlFiles,runtime,files,
    inputSha256:pinDigest(files),captureWallMs:performance.now()-started};
}
export function assertWholeWorkloadGeneratedArtifacts(before,artifacts){
  if(!Array.isArray(artifacts)||artifacts.length!==before.generatedFiles.length||new Set(artifacts.map(row=>row.path)).size!==artifacts.length
    ||artifacts.some(row=>!before.generatedFiles.includes(row.path)||!(/^[a-f0-9]{64}$/u.test(row.sha256))
      ||before.files.find(file=>file.path===row.path)?.sha256!==row.sha256))
    throw Error('Whole-workload generated artifact differs from its builder receipt');
}
export async function verifyWholeWorkloadRunInputs(before){
  const started=performance.now();
  try{
    // Recompute graphs, filename sets and installed resolution, not only the
    // old files: new SQL/runtime files and changed package entrypoints count.
    const after=await captureWholeWorkloadRunInputs(before.captureOptions);
    const unchanged=after.inputSha256===before.inputSha256&&pinDigest(after.sqlFiles)===pinDigest(before.sqlFiles)
      &&pinDigest(after.runtime)===pinDigest(before.runtime);
    return {schemaVersion:'whole-workload-run-input-verification-v1',unchanged,captureComplete:true,after,verificationWallMs:performance.now()-started};
  }catch{
    return {schemaVersion:'whole-workload-run-input-verification-v1',unchanged:false,captureComplete:false,after:null,
      reason:'required_input_capture_failed',verificationWallMs:performance.now()-started};
  }
}
function requireUnchangedRunInputs(result){if(!result.unchanged)throw Error('Whole-workload execution inputs changed; no receipt can be saved');}

/** The policy is explicit self-contained reviewed JavaScript, not generated
 * from the census. Imports/dynamic imports and source hash drift are refused. */
export async function buildC06ReviewPolicy(file,expectedSha256,outfile){
 if(!seedHex(expectedSha256)||(await stat(file)).size>1024*1024)throw Error('C06 policy input bound');
 const original=await readFile(file,'utf8');if(pinBytes(original)!==expectedSha256)throw Error('C06 policy review hash differs');
 const lexer=await import('es-module-lexer');await lexer.init;
 if(lexer.parse(original)[0].length)throw Error('C06 policy imports forbidden');
 const result=await build({stdin:{contents:original,sourcefile:'c06-independent-policy.mjs',loader:'js'},
  bundle:true,write:false,metafile:true,format:'esm',platform:'browser',target:'es2022',tsconfigRaw:{},logLevel:'silent',
  plugins:[{name:'self-contained-c06-review',setup(builder){builder.onResolve({filter:/.*/},()=>{throw Error('C06 policy imports forbidden');});}}]});
 if(Object.keys(result.metafile.inputs).length!==1||Object.values(result.metafile.inputs).some(row=>row.imports.length)
  ||result.metafile.outputs[Object.keys(result.metafile.outputs)[0]]?.exports.join(',')!=='c06IndependentReviewPolicy')throw Error('C06 policy exact export unavailable');
 const contents=result.outputFiles[0].text;if(pinBytes(await readFile(file,'utf8'))!==expectedSha256)throw Error('C06 policy changed during build');
 await writeFile(outfile,contents,{flag:'wx',mode:0o600});
 return {contract:'c06-explicit-independent-policy-v1',entrySha256:expectedSha256,bundleSha256:pinBytes(contents),path:outfile,inputFiles:[{path:await realpath(file),sha256:expectedSha256}]};
}

const C06_ATTACH_PHASES=['warm','no_op','unrelated_append'];
const C06_SOURCE_PROOF_KEYS=['sqlSha256','schemaSha256','rowidInventorySha256','autoIncrementSequenceSha256','exportStatements','exportedLogicalSqlBytes','rowidRows','typedRowsCompared'];
const c06AttachmentFailure=()=>{throw Error('C06 attached receipt provenance unavailable');};
/** Validate every original paired gate before exposing a candidate census to a
 * separate checker. Certificates never establish output completion. */
export function c06CompletedReceiptCases(receipt){
 const summaries=[];
 if(receipt?.schemaVersion==='analytics-shared-seed-scale-matrix-v1'){
  const seed=receipt.commonSeed;
  if(receipt.complete!==true||receipt.wholeWorkloadQualification!==false||canonicalReceiptJson(receipt.scales)!=='[1,30,365]'
   ||receipt.completed?.length!==3||seed?.actualSeedProcesses!==1||seed.historyCalendarDays!==466)c06AttachmentFailure();
  for(const [index,row]of receipt.completed.entries()){
   if(row.dates!==receipt.scales[index]||row.summarySha256!==seedDigest(row.summary)||row.sourceProofSha256!==seedDigest(seed.proof))c06AttachmentFailure();
   const compact=row.summary;
   if(compact.analyticalNowMs!==receipt.analyticalNowMs||compact.outputDates!==row.dates||compact.sharedUniqueHistoryCalendarDays!==466
    ||C06_SOURCE_PROOF_KEYS.some(key=>compact.sourceSnapshot?.[key]!==seed.proof[key]))c06AttachmentFailure();
   summaries.push({...compact,initialAdmission:{reference:seed.initialAdmission,candidate:compact.sharedSeedCosts?.candidateAdmission},
    inputAdmission:{reference:seed.initialAdmission,candidate:compact.sharedSeedCosts?.candidateAdmission},
    laboratorySetup:{...compact.laboratorySetup,seed:seed.laboratorySetup},sourceSnapshot:{...compact.sourceSnapshot,seedProof:seed.snapshotProfile}});
  }
 }else summaries.push(receipt);
 const cases=[];
 for(const summary of summaries){
  let branches=false;
  if(summary?.schemaVersion==='analytics-retained-functional-branches-v1'){readFunctionalBranchSummary('analytics-functional-branches '+JSON.stringify(summary));branches=true;}
  else if(summary?.schemaVersion==='analytics-persistent-mutation-functional-v1')readFunctionalMutationSummary('analytics-functional-mutations '+JSON.stringify(summary));
  else if(summary?.schemaVersion==='analytics-integration-debug-v5')readIntegrationDebugSummary('analytics-integration-debug '+JSON.stringify(summary));
  else if(summary?.schemaVersion==='analytics-whole-workload-v6')readWholeWorkloadSummary('analytics-whole-workload '+JSON.stringify(summary));
  else c06AttachmentFailure();
  if(summary.sourceLineageEnabled!==true||!seedHex(summary.evidence?.candidate?.bundleSha256)||!seedHex(summary.evidence?.harness?.inputSha256)
   ||!seedHex(summary.evidence?.reference?.bundleSha256)||!summary.evidence.executionInputReceipts?.length
   ||summary.evidence.executionInputReceipts.some(row=>row.unchanged!==true||row.captureComplete!==true||!seedHex(row.inputSha256)||row.inputSha256!==row.afterInputSha256))c06AttachmentFailure();
  const source=summary.sourceSnapshot;
  if(source?.exactSchemaAndData!==true||source.exactRowids!==true||C06_SOURCE_PROOF_KEYS.slice(0,4).some(key=>!seedHex(source[key]))
   ||C06_SOURCE_PROOF_KEYS.slice(4).some(key=>!seedNat(source[key])))c06AttachmentFailure();
  const acceptedSourceReceiptSha256=seedDigest(Object.fromEntries(C06_SOURCE_PROOF_KEYS.map(key=>[key,source[key]])));
  let previous=(branches?summary.cold:summary.phases.cold).output.sha256;
  for(const [phase,value]of Object.entries(branches?summary.branches:summary.phases)){
   if(C06_ATTACH_PHASES.includes(phase)){
    const profile=branches?value.profiles.candidate:value.candidate,census=profile.c06SourceLineage;
    const full=branches?value.startup.completion.reference.outputSha256:value.output.sha256;
    const action=branches?value.action:value.mutationProof;
    const expectedProvenance={contract:'retained-source-phase-v1',phase,
     acceptedSourceReceiptSha256:branches?seedDigest(summary.base):acceptedSourceReceiptSha256,
     priorCompleteOutputSha256:branches?summary.base.completed.reference.outputSha256:previous,
     analyticalNowMs:branches?value.analyticalNowMs:summary.analyticalNowMs,storesRetained:true,
     action:action?phase==='no_op'?'native-no-op-v2':'native-append-v2':'none',actionReceiptSha256:action?seedDigest(action):null};
    cases.push({dates:summary.outputDates,phase,census,expectedProvenance,
     candidateBundleSha256:summary.evidence.candidate.bundleSha256,nativeFullOutputSha256:full,
     policyPin:summary.evidence.c06ReviewPolicy?{entrySha256:summary.evidence.c06ReviewPolicy.entrySha256,bundleSha256:summary.evidence.c06ReviewPolicy.bundleSha256}:null});
   }
   if(!branches)previous=value.output.sha256;
  }
 }
 if(cases.length<1||cases.length>9||new Set(cases.map(row=>row.dates+':'+row.phase)).size!==cases.length)c06AttachmentFailure();
 return cases;
}
export async function attachReviewedC06Receipt({receiptBytes,certificateBytes,qualify}){
 if(typeof receiptBytes!=='string'||typeof certificateBytes!=='string'||Buffer.byteLength(receiptBytes)>8*1024*1024||Buffer.byteLength(certificateBytes)>8*1024*1024)c06AttachmentFailure();
 const receipt=JSON.parse(receiptBytes),certificate=JSON.parse(certificateBytes),receiptSha256=pinBytes(receiptBytes);
 if(!certificate||Object.keys(certificate).sort().join(',')!=='cases,contract,receiptSha256'||certificate.contract!=='c06-reviewed-receipt-certificates-v1'
  ||certificate.receiptSha256!==receiptSha256||!Array.isArray(certificate.cases))c06AttachmentFailure();
 const cases=c06CompletedReceiptCases(receipt),reviews=new Map(certificate.cases.map(row=>[row.dates+':'+row.phase,row]));
 if(reviews.size!==certificate.cases.length||reviews.size!==cases.length)c06AttachmentFailure();
 const phases=[];
 for(const row of cases){const selected=reviews.get(row.dates+':'+row.phase);
  if(!selected||Object.keys(selected).sort().join(',')!=='dates,phase,review')c06AttachmentFailure();
  const result=await qualify({...row,review:selected.review});
  if(result?.contract!=='c06-attached-phase-qualification-v1'||typeof result.qualified!=='boolean'||result.noRescanQualified!==result.qualified)c06AttachmentFailure();
  phases.push({dates:row.dates,phase:row.phase,...result});
 }
 return {schemaVersion:'analytics-c06-reviewed-receipt-attachment-v1',wholeWorkloadQualification:false,
  receiptSha256,certificateSha256:pinBytes(certificateBytes),qualified:phases.every(row=>row.qualified),phases,
  originalReceiptUnchanged:true,nativeReferenceDiagnosticOnly:true,
  boundary:'Separate local reviewed source-access qualification on completed exact paired outputs. No replay, new D1 work, CPU/heap qualification or rewriting of the original diagnostic false.'};
}
async function runC06Attachment(options){
 const started=performance.now(),helper=path.join(workerRoot,'test/helpers/analytics-c06-phase-evidence.ts');
 for(const file of [options.qualifyCensus,options.c06Certificate])if((await stat(file)).size>8*1024*1024)throw Error('C06 attachment input bound');
 const scratch=await mkdtemp(path.join(tmpdir(),'p11-c06-attachment-'));
 try{
  const bundle=path.join(scratch,'checker.mjs');
  const built=await build({absWorkingDir:workerRoot,entryPoints:[helper],bundle:true,write:false,metafile:true,platform:'node',format:'esm',target:'es2022',logLevel:'silent'});
  if(built.outputFiles.length!==1)throw Error('C06 qualification bundle unavailable');
  const code=built.outputFiles[0].text;await writeFile(bundle,code,{flag:'wx',mode:0o600});
  const before=await captureWholeWorkloadRunInputs({testFiles:[helper],configFiles:[path.join(workerRoot,'tsconfig.json')],generatedFiles:[bundle],
   inheritedFiles:[fileURLToPath(import.meta.url),options.qualifyCensus,options.c06Certificate,...Object.keys(built.metafile.inputs).map(name=>path.resolve(workerRoot,name))]});
  assertWholeWorkloadGeneratedArtifacts(before,[{path:bundle,sha256:pinBytes(code)}]);
  const receiptBytes=await readFile(options.qualifyCensus,'utf8'),certificateBytes=await readFile(options.c06Certificate,'utf8');
  const module=await import(pathToFileURL(bundle).href);
  const result=await attachReviewedC06Receipt({receiptBytes,certificateBytes,qualify:module.attachC06PhaseQualification});
  const after=await verifyWholeWorkloadRunInputs(before);requireUnchangedRunInputs(after);
  const report={...result,checker:{bundleSha256:pinBytes(code),inputSha256:before.inputSha256,inputsUnchanged:true,
   inputFiles:before.files.length,nodeVersion:process.version,wallMs:performance.now()-started,d1Statements:0}};
  const encoded=JSON.stringify(report,null,2)+'\n';if(Buffer.byteLength(encoded)>8*1024*1024)throw Error('C06 attachment output bound');
  await writeFile(options.output+'.before.json',JSON.stringify(before,null,2)+'\n',{flag:'wx',mode:0o600});
  await writeFile(options.output+'.after.json',JSON.stringify(after,null,2)+'\n',{flag:'wx',mode:0o600});
  await writeFile(options.output,encoded,{flag:'wx',mode:0o600});
  process.stdout.write('analytics-c06-reviewed-attachment '+JSON.stringify({qualified:report.qualified,phases:report.phases.map(({dates,phase,qualified,refusalCodes})=>({dates,phase,qualified,refusalCodes})),receiptSha256:report.receiptSha256})+'\n');
  if(!report.qualified)process.exitCode=1;
 }finally{await rm(scratch,{recursive:true,force:true});}
}

export async function main(args=process.argv.slice(2)) {
  let options=parseArguments(args);
  if(options.qualifyCensus)return runC06Attachment(options);
  if(options.help){process.stdout.write('Disposable local all-output native baseline.\n'
    +'Shared466 seed/T scale experiment: --scale-matrix 1,30,365 --compare --upgrade-source --phases cold,warm,no_op (independent scale laboratories; no repeated seed admission).\n'
    +'Retained functional branches: --functional-branches no_op,unrelated_append,old_correction,clock_advance,utc_rollover with --compare --upgrade-source --integration-debug-days 10 --dates 1 --phases cold.\n'
    +'Use --functional-accountless-secondary only with functional branches to seed an authentic accountless secondary; withdrawal requires it. Device revocation retains the primary social owner.\n'
    +'Persistent functional mutations: add --functional-mutations to --compare --upgrade-source --dates 1 --integration-debug-days 10 --phases cold,warm,no_op,unrelated_append (or old_correction); no runtime observation.\n'
    +'Functional goldens: node scripts/benchmark-analytics-whole-workload.mjs --functional-goldens (accepted native input and legacy selection; no workload).\n'
    +'Clock goldens: node scripts/benchmark-analytics-whole-workload.mjs --clock-goldens (focused D1 only; no workload).\n'
    +'Usage: node scripts/benchmark-analytics-whole-workload.mjs [--dates 1|30|365] [--compare] [--upgrade-source] [--phases cold,warm,no_op,unrelated_append,old_correction] [--output <new-json-file>] [--integration-debug-days 10|30] [--observe-runtime] [--native-profile optimized|unshared-diagnostic]\n'
    +'Pins f056940f; uses independent source/target/ledger databases initialized from one exact accepted native logical snapshot.\n'
    +'Native optimization profile defaults to optimized (shared analytics/cache and model blocks, native prepared usage default). Unshared is diagnostic-only.\n'
    +'--upgrade-source applies current migrations only to the candidate source after exact snapshot verification.\n'
    +'Integrated comparisons currently allow cold/warm/no_op only; incremental mutation isolation remains unqualified.\n'
    +'--c06-review-policy <self-contained-js> --c06-review-policy-sha256 <reviewed-sha> attaches an explicitly pinned independent in-memory review; absence or refusal stays unqualified.\n'
    +'--qualify-census <complete-json> --c06-certificate <review-json> --output <new-json> creates a separate offline qualification attachment.\n'
    +'--source-lineage attaches bounded source SQL census only to warm/no_op/unrelated_append; separate metered schema/EXPLAIN costs, no automatic no-rescan claim.\n'
    +'--observe-runtime adds sampled CPU and barrier heap diagnostics in independent lane Workers; comparative heap remains unqualified.\n'
    +'--integration-debug-days uses a separately labeled small fixture and cannot produce a whole-workload receipt.\n'
    +'Integrated runs always include 70 retained model dates and current fits; --dates 365 computes the 366-date union while publishing only 70 dates.\n'
    +'365 requested historical dates are reported separately from the native 70-day public window. No online resources or credentials.\n');return;}
  assertFunctionalProfileCompatibility(options);
  if(options.scaleMatrix&&process.env.VITE_WHOLE_WORKLOAD_PREPARATION_LIMIT!==undefined&&process.env.VITE_WHOLE_WORKLOAD_PREPARATION_LIMIT!=='400')throw Error('Shared scale preparation bound is exactly400');
  // Direct Vitest helpers and migration SQL participate in the measured
  // candidate just as bundled kernels do. Refuse a receipt if any change.
  const harnessPaths=['test/analytics-whole-workload-clock.spec.ts','test/analytics-whole-workload-profile.spec.ts','test/analytics-performance-histogram.spec.ts','test/analytics-whole-workload.spec.ts','test/helpers/analytics-whole-workload.ts',
    'test/helpers/analytics-functional-qualification.ts','test/fixtures/analytics-legacy-selected-corpus.ts','test/analytics-native-source-cutoff.spec.ts','test/analytics-legacy-selected-families.spec.ts','test/helpers/analytics-performance-histogram.ts','test/helpers/analytics-profile.ts','test/helpers/analytics-store-inventory.ts','test/helpers/analytics-logical-bytes.ts','test/helpers/analytics-source-snapshot.ts','test/helpers/analytics-candidate.ts','test/helpers/analytics-workload-kernels.ts',
    'test/helpers/canonical-rolling-profile.ts',corpusFixture,'scripts/benchmark-analytics-whole-workload.mjs','scripts/analytics-workload-publication-clock.mjs','scripts/analytics-workload-mutation-capture-transform.mjs','vitest.config.ts'];
  for(const directory of ['migrations','typed-ingestion-migrations','ingestion-bridge-migrations',
    'typed-v1-admission-migrations','typed-v11-admission-migrations','ingestion-isolation-migrations','analytics-migrations','deletion-ledger-migrations','routing-migrations'])
    for(const file of (await readdir(path.join(workerRoot,directory))).filter(file=>file.endsWith('.sql')))
      harnessPaths.push(directory+'/'+file);
  harnessPaths.push('test/helpers/analytics-mutation-replay.ts','test/helpers/analytics-native-mutation.ts','test/helpers/analytics-mutation-capture.ts','test/helpers/analytics-mutation-current.ts','test/helpers/analytics-paired-source.ts','scripts/analytics-workload-mutation-proof.mjs','scripts/analytics-workload-mutation-proof-v2.mjs');
  harnessPaths.push('test/helpers/analytics-functional-native-input.ts','test/analytics-functional-native-input.spec.ts','test/helpers/analytics-functional-input-scenarios.ts','test/analytics-functional-input-scenarios.spec.ts');
  harnessPaths.push('test/helpers/analytics-c06-source-lineage.ts','test/helpers/analytics-c06-qualification.ts','test/analytics-c06-source-lineage.spec.ts','test/analytics-c06-qualification.spec.ts','test/helpers/analytics-preview-counter.ts','test/analytics-preview-counter.spec.ts','test/analytics-preview-counter-action.spec.ts','test/helpers/analytics-functional-branches.ts','test/helpers/analytics-functional-boundaries.ts','test/helpers/analytics-functional-action-trace.ts','test/analytics-functional-boundaries.spec.ts','test/analytics-functional-action-trace.spec.ts','test/helpers/analytics-sql-fixtures.d.ts','test/analytics-functional-branches.spec.ts','test/helpers/analytics-retained-functional-clock.ts','test/analytics-retained-functional-clock.spec.ts','test/helpers/analytics-functional-scenarios.ts','test/analytics-functional-scenarios.spec.ts');
  harnessPaths.push('test/helpers/analytics-c06-operation-scope.ts','test/analytics-c06-operation-meter.spec.ts','scripts/analytics-workload-c06-scope-transform.mjs','scripts/analytics-workload-c06-scope-transform.check.mjs');
  harnessPaths.push('test/helpers/analytics-c06-phase-evidence.ts','test/helpers/analytics-c06-independent-policy.ts','test/analytics-c06-phase-evidence.spec.ts','test/helpers/analytics-c06-shared-qualification-v2.ts','test/analytics-c06-shared-qualification-v2.spec.ts');
  if(options.observeRuntime)harnessPaths.push('scripts/analytics-workload-runtime-observer.mjs');
  const harnessFiles=await Promise.all(harnessPaths.sort().map(async relative=>{
    const file=path.join(workerRoot,relative);return {path:file,sha256:createHash('sha256').update(await readFile(file)).digest('hex')};
  }));
  const harness={inputFiles:harnessFiles,inputSha256:createHash('sha256').update(harnessFiles.map(file=>file.sha256).join('')).digest('hex')};
  const snapshot=await mkdtemp(path.join(tmpdir(),'tibotattle-native-reference-'));
  await mkdir(path.join(workerRoot,'.wrangler'),{recursive:true});
  const scratch=await mkdtemp(path.join(workerRoot,'.wrangler','p11-whole-workload-'));
  let laneBridge=null,activeInputGuard=null,inputDirectory=null,scaleExperiment=null,reviewPolicy=null;
  const runtimeOwner=createRuntimeObservationOwner({onClosed:(bridge,identity)=>process.stdout.write('analytics-workload-runtime-observer-diagnostic '+JSON.stringify({...identity,wholeWorkloadQualification:false,comparativeHeapQualification:false,observations:bridge.observations,transport:bridge.transport})+'\n')});
  const executionInputReceipts=[];
  async function beginInputGuard(label,testFiles,configPath,aliases,reference,candidate,generatedArtifacts) {
    await verifyBundleInputs(reference);if(candidate)await verifyBundleInputs(candidate);await verifyBundleInputs(harness);if(reviewPolicy)await verifyBundleInputs(reviewPolicy);
    if(activeInputGuard)throw Error('Whole-workload input guard already active');
    if(options.scaleMatrix)label='scale-'+options.dates+'-'+label;
    if(!inputDirectory){
      inputDirectory=options.output?options.output+'.inputs':await mkdtemp(path.join(tmpdir(),'tibotattle-whole-inputs-'));
      if(options.output)await mkdir(inputDirectory,{mode:0o700});
    }
    const generatedFiles=generatedArtifacts.map(row=>row.path);
    let before;try{before=await captureWholeWorkloadRunInputs({testFiles:testFiles.map(file=>path.resolve(workerRoot,file)),configFiles:[configPath],aliases,generatedFiles,
      inheritedFiles:[...harness.inputFiles,...reference.inputFiles,...(candidate?.inputFiles??[]),...(reviewPolicy?.inputFiles??[])].map(file=>file.path)});}catch{throw Error('Whole-workload execution input capture unavailable; no workload launched');}
    assertWholeWorkloadGeneratedArtifacts(before,generatedArtifacts);
    const bytes=JSON.stringify(before,null,2)+'\n';
    await writeFile(path.join(inputDirectory,label+'-before.json'),bytes,{flag:'wx',mode:0o600});
    activeInputGuard={label,before,beforeManifestSha256:pinBytes(bytes)};
  }
  async function finishInputGuard() {
    if(!activeInputGuard)return;
    const {label,before,beforeManifestSha256}=activeInputGuard;activeInputGuard=null;
    const checked=await verifyWholeWorkloadRunInputs(before),bytes=JSON.stringify(checked,null,2)+'\n';
    await writeFile(path.join(inputDirectory,label+'-after.json'),bytes,{flag:'wx',mode:0o600});
    const receipt={schemaVersion:'whole-workload-controller-inputs-v1',lane:label,unchanged:checked.unchanged,captureComplete:checked.captureComplete,
      inputSha256:before.inputSha256,afterInputSha256:checked.after?.inputSha256??null,beforeManifestSha256,afterManifestSha256:pinBytes(bytes),
      files:before.files.length,testInputs:before.testInputs.length,configInputs:before.configInputs.length,sqlFiles:before.sqlFiles.length,
      generatedFiles:before.generatedFiles.length,installedPackages:before.runtime.packages.length,
      captureWallMs:before.captureWallMs,verificationWallMs:checked.verificationWallMs,systemLibrariesQualified:false,
      costBoundary:'Local controller input capture and verification; separate from analytical SQL/resource measurement. Not C06 or output qualification.'};
    executionInputReceipts.push(receipt);process.stdout.write('analytics-workload-controller-inputs '+JSON.stringify(receipt)+'\n');
    requireUnchangedRunInputs(checked);
  }
  try {
    const archive=path.join(snapshot,'source.tar');
    const git=spawnSync('git',['archive','--format=tar','--output',archive,NATIVE_REFERENCE_COMMIT],{cwd:repositoryRoot,stdio:'pipe'});
    if(git.status!==0)throw new Error('Pinned native reference could not be archived');
    const tar=spawnSync('tar',['-xf',archive,'-C',snapshot],{stdio:'pipe'});
    if(tar.status!==0)throw new Error('Pinned native reference could not be extracted');
    await symlink(path.join(workerRoot,'node_modules'),path.join(snapshot,'apps/worker/node_modules'),'dir');
    const referencePath=path.join(scratch,'native-reference.mjs');
    const reference=await buildKernelBundle(snapshot,referencePath,'reference',NATIVE_REFERENCE_COMMIT,options.functionalMutations||options.functionalBranches.length?{mutationCapture:true}:{});
    const candidatePath=path.join(scratch,'candidate.mjs');
    const candidate=options.compare||options.clockGoldens||options.functionalGoldens?await buildKernelBundle(repositoryRoot,candidatePath,'candidate',null,{...(options.functionalMutations||options.functionalBranches.length?{mutationCapture:true}:{}),...(options.sourceLineage?{c06SharedScope:true}:{})}):null;
    if(options.c06ReviewPolicy)reviewPolicy=await buildC06ReviewPolicy(options.c06ReviewPolicy,options.c06ReviewPolicySha256,path.join(scratch,'c06-independent-review.mjs'));
    const bundleProof={c06ReviewPolicy:reviewPolicy?{entrySha256:reviewPolicy.entrySha256,bundleSha256:reviewPolicy.bundleSha256}:null,reference:{commit:NATIVE_REFERENCE_COMMIT,bundleSha256:reference.bundleSha256,inputSha256:reference.inputSha256,publicationClock:reference.publicationClock,...(reference.capture?{mutationCapture:reference.capture}:{})},
      candidate:candidate?{bundleSha256:candidate.bundleSha256,inputSha256:candidate.inputSha256,publicationClock:candidate.publicationClock,...(candidate.c06Scope?{c06Scope:candidate.c06Scope}:{})}:null,
      harnessInputSha256:harness.inputSha256,fixtureSha256:createHash('sha256').update(await readFile(path.join(workerRoot,corpusFixture))).digest('hex'),
      integrationDebugDays:options.integrationDebugDays,dates:options.dates,phases:options.phases,nativeProfile:options.nativeProfile,functionalAccountlessSecondary:options.functionalAccountlessSecondary};
    process.stdout.write('analytics-workload-bundle '+JSON.stringify(bundleProof)+'\n');
    if(options.clockGoldens||options.functionalGoldens) {
      const configPath=path.join(scratch,'clock-goldens.config.ts');
      const configSource=`import {mergeConfig} from 'vitest/config';\nimport base from ${JSON.stringify(path.join(workerRoot,'vitest.config.ts'))};\nexport default mergeConfig(base,{resolve:{alias:[{find:'./helpers/analytics-native-reference',replacement:${JSON.stringify(referencePath)}},{find:'./helpers/analytics-candidate',replacement:${JSON.stringify(candidatePath)}},{find:'./analytics-native-reference',replacement:${JSON.stringify(referencePath)}},{find:'./analytics-candidate',replacement:${JSON.stringify(candidatePath)}}]}});\n`;
      await writeFile(configPath,configSource,{flag:'wx'});
      const testFiles=options.functionalGoldens?['test/analytics-native-source-cutoff.spec.ts','test/analytics-legacy-selected-families.spec.ts']:['test/analytics-whole-workload-clock.spec.ts','test/analytics-whole-workload-profile.spec.ts'];
      await beginInputGuard(options.functionalGoldens?'functional-goldens':'clock-goldens',testFiles,configPath,
        {'./helpers/analytics-native-reference':referencePath,'./helpers/analytics-candidate':candidatePath,'./analytics-native-reference':referencePath,'./analytics-candidate':candidatePath},
        reference,candidate,[{path:referencePath,sha256:reference.bundleSha256},{path:candidatePath,sha256:candidate.bundleSha256},{path:configPath,sha256:pinBytes(configSource)}]);
      const child=spawn(process.execPath,[path.join(workerRoot,'node_modules/vitest/vitest.mjs'),'run',...testFiles,'--config',configPath,'--disableConsoleIntercept'],{cwd:workerRoot,env:{...process.env,FORCE_COLOR:'0'},stdio:['ignore','inherit','inherit']});
      const stop=()=>child.kill('SIGTERM');process.once('SIGINT',stop);process.once('SIGTERM',stop);
      let code,signal;
      try{[code,signal]=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve([code,signal]));});}
      finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await finishInputGuard();}
      await verifyBundleInputs(reference);await verifyBundleInputs(candidate);await verifyBundleInputs(harness);
      if(code!==0||signal!==null)throw Error('Strict publication clock goldens did not pass');
      process.stdout.write((options.functionalGoldens?'analytics-workload-functional-goldens ':'analytics-workload-clock-goldens ')+JSON.stringify({complete:true,inputsUnchanged:true,wholeWorkloadQualification:false})+'\n');return;
    }
    const requestedOptions=options,analyticalNowMs=Date.now();
    if(options.scaleMatrix)scaleExperiment=createSharedSeedScaleExperiment({analyticalNowMs,inputPins:{
      referenceInputSha256:reference.inputSha256,candidateInputSha256:candidate.inputSha256,harnessInputSha256:harness.inputSha256,
      referenceBundleSha256:reference.bundleSha256,candidateBundleSha256:candidate.bundleSha256,fixtureSha256:bundleProof.fixtureSha256}});
    for(const selectedDates of requestedOptions.scaleMatrix??[requestedOptions.dates]) {
    options={...requestedOptions,dates:selectedDates};
    const scaleInputStart=executionInputReceipts.length,bridgeOptions=scaleExperiment?.beginScale(selectedDates);
    let output='';
    if(options.compare&&!options.functionalMutations&&!options.functionalBranches.length)laneBridge=await createLaneEvidenceBridge(bridgeOptions);
    for(const lane of options.compare&&!options.functionalMutations&&!options.functionalBranches.length?(bridgeOptions?.retainedSeed?['candidate','reference']:['seed','candidate','reference']):[null]) {
      const inspectorPort=options.observeRuntime&&lane!=='seed'?await unusedLoopbackPort():null;
      const runtimeBridge=await runtimeOwner.begin(inspectorPort?{inspectorUrl:`http://127.0.0.1:${inspectorPort}`,expectedTargetId:'core:user:vitest-pool-workers-runner-p11-observed',independentLane:Boolean(lane)}:null,{lane,scale:selectedDates});
      const configPath=path.join(scratch,`vitest-${options.scaleMatrix?'scale-'+selectedDates+'-':''}${lane??'baseline'}.config.ts`);
      const configSource=`import {mergeConfig} from 'vitest/config';\nimport base from ${JSON.stringify(path.join(workerRoot,'vitest.config.ts'))};\nexport default mergeConfig(base,{${inspectorPort?`test:{name:'p11-observed',inspect:'127.0.0.1:${inspectorPort}',inspector:{waitForDebugger:false}},`:''}resolve:{alias:[{find:'./helpers/analytics-native-reference',replacement:${JSON.stringify(referencePath)}},${candidate?`{find:'./helpers/analytics-candidate',replacement:${JSON.stringify(candidatePath)}}`:''}${reviewPolicy?`,{find:'./helpers/analytics-c06-independent-policy',replacement:${JSON.stringify(reviewPolicy.path)}}`:''}]}});\n`;
      await writeFile(configPath,configSource,{flag:'wx'});
      await beginInputGuard(lane??'baseline',['test/analytics-whole-workload.spec.ts'],configPath,
        {'./helpers/analytics-native-reference':referencePath,...(candidate?{'./helpers/analytics-candidate':candidatePath}:{}),...(reviewPolicy?{'./helpers/analytics-c06-independent-policy':reviewPolicy.path}:{})},
        reference,candidate,[{path:referencePath,sha256:reference.bundleSha256},...(candidate?[{path:candidatePath,sha256:candidate.bundleSha256}]:[]),...(reviewPolicy?[{path:reviewPolicy.path,sha256:reviewPolicy.bundleSha256}]:[]),{path:configPath,sha256:pinBytes(configSource)}]);
      if(lane)laneBridge.begin(lane);
      const child=spawn(process.execPath,[path.join(workerRoot,'node_modules/vitest/vitest.mjs'),'run','test/analytics-whole-workload.spec.ts','--config',configPath,'--disableConsoleIntercept'],
        {cwd:workerRoot,env:{...process.env,...(options.scaleMatrix?{VITE_WHOLE_WORKLOAD_PREPARATION_LIMIT:'400'}:{}),FORCE_COLOR:'0',VITE_WHOLE_WORKLOAD:'enabled',VITE_WHOLE_WORKLOAD_DATES:String(options.dates),
          VITE_WHOLE_WORKLOAD_SOURCE_LINEAGE:options.sourceLineage?'enabled':'disabled',VITE_C06_REVIEW_POLICY_ENTRY:reviewPolicy?.entrySha256??'',VITE_C06_REVIEW_POLICY_BUNDLE:reviewPolicy?.bundleSha256??'',VITE_WHOLE_WORKLOAD_FUNCTIONAL_BRANCHES:options.functionalBranches.join(','),VITE_WHOLE_WORKLOAD_FUNCTIONAL_ACCOUNTLESS_SECONDARY:options.functionalAccountlessSecondary?'enabled':'disabled',VITE_WHOLE_WORKLOAD_REFERENCE_INPUT:reference.inputSha256,VITE_WHOLE_WORKLOAD_CANDIDATE_INPUT:candidate?.inputSha256??'',VITE_WHOLE_WORKLOAD_REFERENCE_BUNDLE:reference.bundleSha256,VITE_WHOLE_WORKLOAD_CANDIDATE_BUNDLE:candidate?.bundleSha256??'',
          VITE_WHOLE_WORKLOAD_COMPARE:options.compare?'enabled':'disabled',VITE_WHOLE_WORKLOAD_FUNCTIONAL_MUTATIONS:options.functionalMutations?'enabled':'disabled',VITE_WHOLE_WORKLOAD_SOURCE_UPGRADE:options.upgradeSource?'enabled':'disabled',
          VITE_WHOLE_WORKLOAD_PHASES:options.phases.join(','),VITE_WHOLE_WORKLOAD_NATIVE_PROFILE:options.nativeProfile,VITE_WHOLE_WORKLOAD_OBSERVER_URL:runtimeBridge?.url??'',
          VITE_WHOLE_WORKLOAD_SCALE_MATRIX:options.scaleMatrix?'enabled':'disabled',VITE_WHOLE_WORKLOAD_SHARED_SEED_PROOF:scaleExperiment?.checkpoint().acceptedSourceProofSha256??'',
          VITE_WHOLE_WORKLOAD_LANE:lane??'',VITE_WHOLE_WORKLOAD_TRANSFER_URL:laneBridge?.url??'',VITE_WHOLE_WORKLOAD_ANALYTICAL_NOW:String(analyticalNowMs),
          VITE_WHOLE_WORKLOAD_INTEGRATION_DEBUG_DAYS:options.integrationDebugDays?String(options.integrationDebugDays):''},stdio:['ignore','pipe','inherit']});
      let laneOutput='',code,signal;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{process.stdout.write(chunk);if(laneOutput.length+chunk.length>8*1024*1024)child.kill('SIGTERM');else laneOutput+=chunk;});
      const stop=()=>child.kill('SIGTERM');process.once('SIGINT',stop);process.once('SIGTERM',stop);
      try{[code,signal]=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve([code,signal]));});}
      finally {
        process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
        if(lane)laneBridge.end(lane,code,signal);
        try{await finishInputGuard();}finally{await runtimeOwner.close();}
      }
      process.stdout.write('analytics-workload-process-exit '+JSON.stringify({lane:lane??'baseline',code,signal:signal??null})+'\n');
      if(code!==0||signal) {
        await verifyBundleInputs(reference);if(candidate)await verifyBundleInputs(candidate);await verifyBundleInputs(harness);
        process.stdout.write('analytics-workload-bundle-stability '+JSON.stringify({inputsUnchanged:true})+'\n');
        throw new Error('Whole-workload lane did not complete; no paired receipt saved');
      }
      if(scaleExperiment&&lane==='seed')scaleExperiment.captureSeed(laneBridge);
      if(!lane)output=laneOutput;
    }
    if(laneBridge) {
      const {seed,lanes,exits}=laneBridge.state;
      const merged=mergeFreshLaneEvidence(seed,lanes.get('reference'),lanes.get('candidate'),exits);
      merged.laboratoryControllerTransfers={observations:laneBridge.state.transfers,contract:'Observed UTF-8 HTTP body representations and controller handler wall time; source setup and output transfer outside profiled analytic phases. Not physical network frames, TLS, billed CPU or product payload delivery.'};
      output=(options.integrationDebugDays?'analytics-integration-debug ':'analytics-whole-workload ')+JSON.stringify(merged)+'\n';
      process.stdout.write(output);
    }
    await verifyBundleInputs(reference);if(candidate)await verifyBundleInputs(candidate);await verifyBundleInputs(harness);
    process.stdout.write('analytics-workload-bundle-stability '+JSON.stringify({inputsUnchanged:true})+'\n');
    const summary=options.functionalBranches.length?readFunctionalBranchSummary(output):options.functionalMutations?readFunctionalMutationSummary(output):options.integrationDebugDays?readIntegrationDebugSummary(output):readWholeWorkloadSummary(output);
    if(Boolean(summary.sourceLineageEnabled)!==options.sourceLineage)throw Error('Source lineage option differs from receipt');
    if(options.functionalBranches.length){if(summary.functionalAccountlessSecondary!==options.functionalAccountlessSecondary)throw Error('Functional startup owner kind differs');assertPrivateEqual(summary.base.inputSha256,{reference:reference.inputSha256,candidate:candidate.inputSha256},'Functional base input pins differ');assertPrivateEqual(Object.keys(summary.branches),options.functionalBranches,'Functional branch selection differs');}
    summary.evidence={c06ReviewPolicy:reviewPolicy?{entrySha256:reviewPolicy.entrySha256,bundleSha256:reviewPolicy.bundleSha256}:null,nodeVersion:process.version,executionInputReceipts:options.scaleMatrix?executionInputReceipts.slice(scaleInputStart):executionInputReceipts,harness:{inputSha256:harness.inputSha256,inputFiles:harness.inputFiles.length},reference:{commit:NATIVE_REFERENCE_COMMIT,
      bundleSha256:reference.bundleSha256,inputSha256:reference.inputSha256,inputFiles:reference.inputFiles.length,publicationClock:reference.publicationClock,...(reference.capture?{mutationCapture:reference.capture}:{})},
      candidate:candidate?{bundleSha256:candidate.bundleSha256,inputSha256:candidate.inputSha256,
        inputFiles:candidate.inputFiles.length,publicationClock:candidate.publicationClock,...(candidate.capture?{mutationCapture:candidate.capture}:{}),...(candidate.c06Scope?{c06Scope:candidate.c06Scope}:{})}:null,
      fixture:{sha256:createHash('sha256').update(await readFile(path.join(workerRoot,corpusFixture))).digest('hex'),
        contract:'Maintained corpus helper; source admission dependencies resolve against the pinned native tree. Integrated target authority derives only from real ordered delivery.'},
      source:'Independent synthetic sources, targets and ledgers; candidate source is copied from the exact accepted pinned-native logical snapshot, then upgraded independently. Import/proof costs and export resource gaps are explicit.',
      privacy:'Reports contain closed counters and output hashes; no rows, SQL, bindings or identifiers.',
      protectedOperations:false};
    if(scaleExperiment){
      const checkpoint=scaleExperiment.completeScale(summary);
      process.stdout.write('analytics-shared-seed-scale-checkpoint '+JSON.stringify({dates:checkpoint.dates,summarySha256:checkpoint.summarySha256,sourceProofSha256:checkpoint.sourceProofSha256})+'\n');
      if(options.output){const encoded=JSON.stringify(checkpoint,null,2)+'\n';if(Buffer.byteLength(encoded)>8*1024*1024)seedFailure('CHECKPOINT_BOUND');await writeFile(options.output+'.scale-'+selectedDates+'.json',encoded,{flag:'wx',mode:0o600});}
    }else if(options.output)await writeFile(options.output,JSON.stringify(summary,null,2)+'\n',{flag:'wx',mode:0o600});
    await laneBridge?.close();laneBridge=null;
    }
    if(scaleExperiment){const matrix=scaleExperiment.finish();process.stdout.write('analytics-shared-seed-scale-matrix '+JSON.stringify(matrix)+'\n');
      if(requestedOptions.output){const encoded=JSON.stringify(matrix,null,2)+'\n';if(Buffer.byteLength(encoded)>8*1024*1024)seedFailure('RECEIPT_BOUND');await writeFile(requestedOptions.output,encoded,{flag:'wx',mode:0o600});}}
  } catch(error) {if(scaleExperiment){scaleExperiment.fail();process.stdout.write('analytics-shared-seed-scale-incomplete '+JSON.stringify(scaleExperiment.checkpoint())+'\n');}throw error;
  } finally {try{try{await finishInputGuard();}finally{try{await runtimeOwner.close();}finally{await laneBridge?.close();scaleExperiment?.close();}}}finally{await rm(scratch,{recursive:true,force:true});await rm(snapshot,{recursive:true,force:true});}}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
