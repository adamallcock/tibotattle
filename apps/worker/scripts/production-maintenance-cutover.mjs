import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openOperation, identityDigest, operationError } from '../../../scripts/lib/release-operation.mjs';
import { createProductionDeploymentLock } from './production-deployment-lock.mjs';
import { validateMaintenancePlan, validateMaintenanceState, readMaintenanceFile } from './production-maintenance.mjs';
import { createMaintenanceCutoverProvider } from './production-maintenance-cutover-provider.mjs';
import { maintenanceAnalyticsRegistrationIntent } from './production-maintenance-analytics-registration.mjs';
import { createMaintenanceAnalyticsProvider } from './production-maintenance-analytics-provider.mjs';
import { validateMaintenanceCutoverProof } from './production-maintenance-cutover-proof.mjs';

const fail=code=>{throw operationError(`PRODUCTION_MAINTENANCE_CUTOVER_${code}`);};
const sha=/^[a-f0-9]{64}$/,commit=/^[a-f0-9]{40}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==keys.split(' ').sort().join())fail('PLAN_INVALID');}
export function validateMaintenanceCutoverPlan(value,plan){
 exact(value,'schema maintenancePlanDigest operationId owner maintenanceVersionId expiresAt candidate proof analytics inventoryDigest');
 if(value.schema!=='production-maintenance-cutover-v1'||value.maintenancePlanDigest!==identityDigest(plan)||!uuid.test(value.operationId)||!commit.test(value.owner)||!uuid.test(value.maintenanceVersionId)||!Number.isSafeInteger(value.expiresAt))fail('PLAN_INVALID');
 exact(value.candidate,'sourceCommit dependencyDigest ingestionDatabaseId analyticsDatabaseId deletionLedgerDatabaseId ingestionDatabaseName analyticsDatabaseName deletionLedgerDatabaseName sourceNamespace sourceId');
 exact(value.analytics,'workerName');
 if(!/^tibotattle-analytics-[a-z0-9-]{1,42}$/.test(value.analytics.workerName??'')||value.analytics.workerName===plan.workerName||!sha.test(value.inventoryDigest??''))fail('PLAN_INVALID');
 const c=value.candidate;
 if(!commit.test(c.sourceCommit)||!sha.test(c.dependencyDigest)||![c.ingestionDatabaseId,c.analyticsDatabaseId,c.deletionLedgerDatabaseId].every(id=>uuid.test(id))
  ||new Set([plan.databaseId,c.ingestionDatabaseId,c.analyticsDatabaseId,c.deletionLedgerDatabaseId]).size!==4
  ||![c.ingestionDatabaseName,c.analyticsDatabaseName,c.deletionLedgerDatabaseName].every(name=>/^[a-z][a-z0-9-]{2,95}$/.test(name??''))
  ||typeof c.sourceNamespace!=='string'||c.sourceNamespace.length<1||c.sourceNamespace.length>256||c.sourceNamespace.includes('\0')||Buffer.from(c.sourceNamespace).toString()!==c.sourceNamespace
  ||!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(c.sourceId??''))fail('PLAN_INVALID');
 validateMaintenanceCutoverProof(value.proof);return value;
}
const checkTooling=(root,expected)=>{if(execFileSync('/usr/bin/git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==expected||execFileSync('/usr/bin/git',['-C',root,'status','--porcelain','--untracked-files=all'],{encoding:'utf8'}).trim())fail('SOURCE_CHANGED');};

/** Continues the original maintenance journal/owner. Target activation is a
 * one-way authority boundary: even a lost response forbids old-source restore. */
export async function runProductionMaintenanceCutover({plan,cutover,operationDirectory,repositoryRoot,candidateWorkerDirectory,
 qualificationRoot,restoreContractPath,ledgerSchemaPath,cliPath,action='dry-run',confirmation=null,executorStopped=false,
 analyticsCapturePath=null,lifecycleCapturePath=null,clock=()=>Date.now(),provider=null,analyticsProvider=null,coordinationFactory=createProductionDeploymentLock,checkSource=checkTooling}){
 plan=structuredClone(validateMaintenancePlan(plan));cutover=structuredClone(validateMaintenanceCutoverPlan(cutover,plan));
 if(!['dry-run','apply','reconcile'].includes(action))fail('ACTION_INVALID');
 if(action==='apply'&&confirmation!=='CUT_OVER_QUALIFIED_TYPED_PRODUCTION')fail('CONFIRMATION_REQUIRED');
 if(action==='reconcile'&&(confirmation!=='RECONCILE_TYPED_PRODUCTION_CUTOVER'||!executorStopped))fail('RECONCILIATION_CONFIRMATION_REQUIRED');
 checkSource(repositoryRoot,plan.toolingCommit);
 const op=await openOperation({directory:operationDirectory,kind:'maintenance',binding:{planDigest:identityDigest(plan)},resume:true});
 try{
  const state=validateMaintenanceState(op.record.state),pin=identityDigest(cutover),lock=coordinationFactory({repositoryRoot});
  if(op.record.id!==cutover.operationId||state.owner!==cutover.owner||state.uploadedVersion!==cutover.maintenanceVersionId||state.phase!=='contained'||state.intent!==null)fail('PARENT_MISMATCH');
  if(state.cutover&&state.cutover.planDigest!==pin)fail('PLAN_CHANGED');
  if(state.lock==='released'){
   if(state.cutover?.phase!=='verified'||state.cutover?.intent!==null)fail('PARENT_MISMATCH');
   return {ok:true,code:'MAINTENANCE_CUTOVER_ALREADY_COMPLETE'};
  }
  if(state.lock!=='held')fail('PARENT_MISMATCH');
  if(action==='apply'&&!state.cutover?.oldRestoreForbidden&&(clock()>=cutover.expiresAt||cutover.expiresAt-clock()>86400000))fail('PLAN_EXPIRED');
  const pending=state.cutover;
  if(action==='reconcile'&&pending?.intent==='release'){
   const observed=lock.status();if(![null,state.owner].includes(observed))fail('OWNER_CHANGED');
  }else lock.assertOwned(state.owner);
  provider??=await createMaintenanceCutoverProvider({plan,cutover,operationDirectory:op.directory,candidateWorkerDirectory,qualificationRoot,restoreContractPath,ledgerSchemaPath,cliPath});
  analyticsProvider??=createMaintenanceAnalyticsProvider({plan,cutover,operationDirectory:op.directory,cliPath});
  if(!state.cutover){
   if(action==='reconcile')fail('NOT_STARTED');
   const snapshot=await provider.prepare();
   const descriptor=await analyticsProvider.prepare(snapshot);
   state.cutover={planDigest:pin,phase:'prepared',intent:null,versionId:null,oldRestoreForbidden:false,snapshot,analytics:{descriptor,registrationIntent:null,registrationDigest:null,preAdmissionDigest:null,phase:'prepared',disabledVersionId:null,enabledVersionId:null,notBeforeMs:null,naturalDigest:null},lifecycle:{scheduled:false,notBeforeMs:null,naturalDigest:null}};
   await op.save(state);
  }
  const c=state.cutover;
  if(action==='dry-run'){
   if(c.intent!==null||c.oldRestoreForbidden)fail('RECONCILE_REQUIRED');
   await provider.dryRun(c.snapshot);await analyticsProvider.dryRun(c.snapshot,c.analytics.descriptor);return {ok:true,code:'MAINTENANCE_CUTOVER_DRY_RUN',remoteWrites:false};
  }
  const a=c.analytics,d=a.descriptor;
  const verifyFinal=async()=>{await provider.verifyActivated(c.versionId,c.snapshot,{scheduled:true});await analyticsProvider.verifyEnabled(c.snapshot,d,a.enabledVersionId);if(!a.naturalDigest||!c.lifecycle.naturalDigest)fail('NATURAL_PROOF_MISSING');};
  if(action==='reconcile'){
   if(c.intent==='release'){
    if(c.phase!=='verified'||!c.oldRestoreForbidden)fail('STATE_INVALID');
    await verifyFinal();
    if(lock.status()===null){state.lock='released';c.intent=null;await op.save(state);return {ok:true,code:'MAINTENANCE_CUTOVER_RECONCILED',coordination:'released'};}
    lock.assertOwned(state.owner);c.intent=null;
   }else if(c.intent==='upload'){
    try{c.versionId=await provider.reconcileUpload(c.versionId,c.snapshot);c.phase='uploaded';}
    catch{await provider.verifyUploadAbsent(c.snapshot);c.phase='prepared';}c.intent=null;
   }else if(c.intent==='analytics_deploy'){
    try{a.disabledVersionId=await analyticsProvider.discoverDisabled(c.snapshot,d);await analyticsProvider.verifyDisabled(c.snapshot,d,a.disabledVersionId);a.phase='disabled';}
    catch{await analyticsProvider.assertAbsent();a.phase='prepared';}c.intent=null;
   }else if(c.intent==='analytics_initialize'){
    if(!c.oldRestoreForbidden||identityDigest(a.registrationIntent)!==identityDigest(maintenanceAnalyticsRegistrationIntent(cutover)))fail('STATE_INVALID');
    const proof=await provider.readAnalyticsRegistration(c.snapshot);if(!['absent','present'].includes(proof.state)||proof.writeAttempted!==false)fail('REGISTRATION_INVALID');a.registrationDigest=proof.state==='present'?identityDigest(proof):null;c.intent=null;
   }else if(c.intent==='analytics_upload'){
    try{a.enabledVersionId=await analyticsProvider.discoverEnabled(c.snapshot,d);a.phase='uploaded';}
    catch{await analyticsProvider.verifyEnabledUploadAbsent(c.snapshot,d,a.disabledVersionId);a.phase='disabled';}c.intent=null;
   }else if(c.intent==='analytics_activate'){
    if(!c.oldRestoreForbidden)fail('STATE_INVALID');
    try{await analyticsProvider.verifyEnabledUnscheduled(c.snapshot,d,a.enabledVersionId);a.phase='active';}
    catch{await analyticsProvider.verifyDisabled(c.snapshot,d,a.disabledVersionId);a.phase='uploaded';}
    c.intent=null;
   }else if(c.intent==='analytics_cron'){
    try{await analyticsProvider.verifyEnabled(c.snapshot,d,a.enabledVersionId);a.phase='scheduled';}
    catch{await analyticsProvider.verifyEnabledUnscheduled(c.snapshot,d,a.enabledVersionId);a.phase='active';}
    c.intent=null;
   }else if(c.intent==='activate'){
    if(!c.oldRestoreForbidden||!c.snapshot.admissionDigest)fail('STATE_INVALID');
    try{await provider.verifyActivated(c.versionId,c.snapshot);c.phase='active';}
    catch{await provider.verifyActivationPending(c.versionId,c.snapshot);c.phase='uploaded';}
    c.intent=null;
   }else if(c.intent==='main_cron'){
    try{await provider.verifyActivated(c.versionId,c.snapshot,{scheduled:true});c.lifecycle.scheduled=true;}
    catch{await provider.verifyActivated(c.versionId,c.snapshot);c.lifecycle.scheduled=false;}
    c.intent=null;
   }else if(c.phase==='verified'){await verifyFinal();}
   await op.save(state);
   return {ok:true,code:'MAINTENANCE_CUTOVER_RECONCILED',phase:c.phase,coordination:state.lock};
  }
  if(c.intent!==null)fail('RECONCILE_REQUIRED');
  const before=async()=>{if(!c.oldRestoreForbidden&&clock()>=cutover.expiresAt)fail('PLAN_EXPIRED');checkSource(repositoryRoot,plan.toolingCommit);lock.assertOwned(state.owner);await provider.verifySnapshot(c.snapshot);};
  const intent=async name=>{await before();c.intent=name;await op.save(state);};
  const saved=async()=>{lock.assertOwned(state.owner);c.intent=null;await op.save(state);};
  if(a.phase==='prepared'){
   await before();await provider.verifyContained();await analyticsProvider.assertAbsent();
   await intent('analytics_deploy');await analyticsProvider.deployDisabled(c.snapshot,d);
   a.disabledVersionId=await analyticsProvider.discoverDisabled(c.snapshot,d);await analyticsProvider.verifyDisabled(c.snapshot,d,a.disabledVersionId);a.phase='disabled';await saved();
  }
  if(c.phase==='prepared'){
   await before();await provider.verifyContained();await analyticsProvider.verifyDisabled(c.snapshot,d,a.disabledVersionId);
   const proof=await provider.admit(c.snapshot,'pre-analytics');if(proof.stage!=='pre-analytics'||proof.analyticsCaughtUp!==false)fail('ADMISSION_STAGE_INVALID');
   a.preAdmissionDigest=identityDigest(proof);await intent('upload');await provider.upload(c.snapshot);
   c.versionId=await provider.reconcileUpload(null,c.snapshot);c.phase='uploaded';await saved();
  }
  if(!a.registrationDigest){
   await before();await provider.verifyContained();await analyticsProvider.verifyDisabled(c.snapshot,d,a.disabledVersionId);
   if(!c.oldRestoreForbidden){const proof=await provider.admit(c.snapshot,'pre-analytics');if(proof.stage!=='pre-analytics'||proof.analyticsCaughtUp!==false)fail('ADMISSION_STAGE_INVALID');a.preAdmissionDigest=identityDigest(proof);}
   if(!a.preAdmissionDigest)fail('ADMISSION_MISSING');
   await before();a.registrationIntent=maintenanceAnalyticsRegistrationIntent(cutover);c.oldRestoreForbidden=true;c.intent='analytics_initialize';await op.save(state);
   const proof=await provider.initializeAnalytics(c.snapshot);if(proof.state!=='present'||proof.analyticsCaughtUp!==false||proof.privacyReady!==false)fail('REGISTRATION_INVALID');a.registrationDigest=identityDigest(proof);await saved();
  }
  if(a.phase==='disabled'){
   await intent('analytics_upload');await analyticsProvider.uploadEnabled(c.snapshot,d);
   a.enabledVersionId=await analyticsProvider.discoverEnabled(c.snapshot,d);a.phase='uploaded';await saved();
  }
  if(a.phase==='uploaded'){
   await before();await provider.verifyContained();
   if(!c.oldRestoreForbidden){const proof=await provider.admit(c.snapshot,'pre-analytics');if(proof.stage!=='pre-analytics'||proof.analyticsCaughtUp!==false)fail('ADMISSION_STAGE_INVALID');}
   // The registration latch already forbids old-source restoration. It remains
   // set across enabled-version activation and both failure orderings.
   await before();c.oldRestoreForbidden=true;c.intent='analytics_activate';await op.save(state);
   await analyticsProvider.activateEnabled(c.snapshot,d,a.enabledVersionId);await analyticsProvider.verifyEnabledUnscheduled(c.snapshot,d,a.enabledVersionId);a.phase='active';await saved();
  }
  if(a.phase==='active'){
   a.notBeforeMs=clock();await intent('analytics_cron');await analyticsProvider.enableCron(c.snapshot,d,a.enabledVersionId);await analyticsProvider.verifyEnabled(c.snapshot,d,a.enabledVersionId);a.phase='scheduled';await saved();
  }
  if(a.phase==='scheduled'){
   if(!analyticsCapturePath)return {ok:false,code:'MAINTENANCE_ANALYTICS_NATURAL_PROOF_REQUIRED',coordination:'held'};
   const proof=await analyticsProvider.verifyNaturalInvocation(c.snapshot,d,a.enabledVersionId,analyticsCapturePath,a.notBeforeMs);a.naturalDigest=identityDigest(proof);a.phase='observed';await op.save(state);
  }
  if(c.phase==='uploaded'){
   await before();await provider.verifyContained();await analyticsProvider.verifyEnabled(c.snapshot,d,a.enabledVersionId);
   if(!c.snapshot.admissionDigest){const proof=await provider.admit(c.snapshot,'full');if(proof.stage!=='full'||proof.analyticsCaughtUp!==true)fail('ADMISSION_STAGE_INVALID');c.snapshot.admissionDigest=identityDigest(proof);}
   await intent('activate');await provider.activate(c.versionId,c.snapshot);await provider.verifyActivated(c.versionId,c.snapshot);c.phase='active';await saved();
  }
  if(c.phase==='active'&&!c.lifecycle.scheduled){
   c.lifecycle.notBeforeMs=clock();await intent('main_cron');await provider.enableMainCron(c.versionId,c.snapshot);await provider.verifyActivated(c.versionId,c.snapshot,{scheduled:true});c.lifecycle.scheduled=true;await saved();
  }
  if(c.phase==='active'){
   if(!lifecycleCapturePath)return {ok:false,code:'MAINTENANCE_LIFECYCLE_NATURAL_PROOF_REQUIRED',coordination:'held'};
   const proof=await provider.verifyMainNaturalInvocation(c.versionId,c.snapshot,lifecycleCapturePath,c.lifecycle.notBeforeMs);c.lifecycle.naturalDigest=identityDigest(proof);c.phase='verified';await op.save(state);
  }
  if(c.phase!=='verified'||!c.oldRestoreForbidden)fail('STATE_INVALID');
  await verifyFinal();lock.assertOwned(state.owner);
  c.intent='release';await op.save(state);lock.release(state.owner);state.lock='released';c.intent=null;await op.save(state);
  return {ok:true,code:'MAINTENANCE_TYPED_CUTOVER_VERIFIED',coordination:'released',oldSourceRestoreForbidden:true};
 }finally{op.close();}
}
export function parseMaintenanceCutoverArguments(args){const r={action:'dry-run'},seen=new Set(),names={'--plan':'planPath','--cutover-plan':'cutoverPath','--operation':'operationDirectory','--repository':'repositoryRoot','--candidate-worker':'candidateWorkerDirectory','--qualification-root':'qualificationRoot','--restore-contract':'restoreContractPath','--ledger-schema':'ledgerSchemaPath','--wrangler-cli':'cliPath','--action':'action','--confirm':'confirmation','--analytics-tail':'analyticsCapturePath','--lifecycle-tail':'lifecycleCapturePath'};
 for(let i=0;i<args.length;i++){const k=args[i];if(seen.has(k))fail('ARGUMENTS_INVALID');seen.add(k);if(k==='--executor-stopped'){r.executorStopped=true;continue;}if(!names[k]||!args[i+1]||args[i+1].startsWith('--'))fail('ARGUMENTS_INVALID');r[names[k]]=args[++i];}
 for(const k of ['planPath','cutoverPath','operationDirectory','repositoryRoot','candidateWorkerDirectory','qualificationRoot','restoreContractPath','ledgerSchemaPath','cliPath'])if(!r[k])fail('ARGUMENTS_INVALID');return r;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){try{const o=parseMaintenanceCutoverArguments(process.argv.slice(2));const plan=JSON.parse((await readMaintenanceFile(o.planPath,65536)).toString()),cutover=JSON.parse((await readMaintenanceFile(o.cutoverPath,65536)).toString());console.log(JSON.stringify(await runProductionMaintenanceCutover({...o,plan,cutover})));}catch(e){console.error(/^(PRODUCTION_MAINTENANCE|D1_STORAGE|RELEASE_OPERATION|PRODUCTION_COORDINATION)_[A-Z_]+$/.test(e?.code??'')?e.code:'PRODUCTION_MAINTENANCE_CUTOVER_FAILED');process.exitCode=1;}}
