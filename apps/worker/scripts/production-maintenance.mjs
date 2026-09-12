import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, readdir, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { openOperation, identityDigest, operationError } from '../../../scripts/lib/release-operation.mjs';
import { createProductionDeploymentLock } from './production-deployment-lock.mjs';
import { createMaintenanceProvider } from './production-maintenance-provider.mjs';

const SHA=/^[a-f0-9]{64}$/, COMMIT=/^[a-f0-9]{40}$/, ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=code=>{throw operationError(`PRODUCTION_MAINTENANCE_${code}`);};
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==keys.split(' ').sort().join())fail('INPUT_INVALID');};
export const maintenanceHash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validateMaintenancePlan(plan) {
  exact(plan,'schema toolingCommit expiresAt accountId workerName databaseId origin predecessor assets restoreSchemaDigest wranglerSha256');
  if(plan.schema!=='production-maintenance-v1'||!COMMIT.test(plan.toolingCommit)||!Number.isSafeInteger(plan.expiresAt)
    ||!/^[a-f0-9]{32}$/.test(plan.accountId)||!/^[a-zA-Z0-9_-]{1,63}$/.test(plan.workerName)||!ID.test(plan.databaseId)||!SHA.test(plan.wranglerSha256)||!SHA.test(plan.restoreSchemaDigest))fail('INPUT_INVALID');
  let url;try{url=new URL(plan.origin);}catch{fail('INPUT_INVALID');}
  if(url.protocol!=='https:'||url.origin!==plan.origin||url.username||url.password||url.hostname.startsWith('www.'))fail('INPUT_INVALID');
  exact(plan.predecessor,'sourceCommit versionId bindingDigest inventoryDigest cron durableNamespaceId migrationTag secretBindings');
  const p=plan.predecessor;
  if(!COMMIT.test(p.sourceCommit)||!ID.test(p.versionId)||!SHA.test(p.bindingDigest)||!SHA.test(p.inventoryDigest)||!/^[a-f0-9]{32}$/.test(p.durableNamespaceId)
    ||p.migrationTag!=='upload-ingress-budget-v1'||!Array.isArray(p.cron)||p.cron.length!==1||p.cron[0]!=='* * * * *'
    ||!Array.isArray(p.secretBindings)||p.secretBindings.length>32||new Set(p.secretBindings).size!==p.secretBindings.length
    ||p.secretBindings.some(x=>!/^secret_(text|key):[A-Z][A-Z0-9_]{0,127}$/.test(x)))fail('INPUT_INVALID');
  if(!Array.isArray(plan.assets)||plan.assets.length!==24||new Set(plan.assets.map(x=>x.path)).size!==24)fail('ASSETS_INVALID');
  for(const f of plan.assets){exact(f,'path bytes sha256');if(!/^[a-zA-Z0-9_.-]{1,80}$/.test(f.path)||f.path.startsWith('.')||!SHA.test(f.sha256)||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>2_000_000)fail('ASSETS_INVALID');}
  if(!plan.assets.some(f=>f.path==='index.html')||!plan.assets.some(f=>f.path==='release-site-manifest.json'))fail('ASSETS_INVALID');
  return plan;
}
async function privateDirectory(path) {
  const st=await lstat(path);if(!st.isDirectory()||await realpath(path)!==resolve(path)||(st.mode&0o077)||st.uid!==process.getuid())fail('PATH_UNSAFE');
}
export async function readMaintenanceFile(path,max=2_000_000) {
  const before=await lstat(path);if(await realpath(path)!==resolve(path)||!before.isFile()||before.nlink!==1||(before.mode&0o077)||before.uid!==process.getuid()||before.size>max)fail('FILE_UNSAFE');
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const actual=await f.stat();if(actual.ino!==before.ino||actual.dev!==before.dev||actual.size!==before.size||actual.nlink!==1)fail('FILE_UNSAFE');return await f.readFile();}finally{await f.close();}
}
export async function verifyMaintenanceAssets(directory,plan) {
  await privateDirectory(directory);
  if(JSON.stringify((await readdir(directory)).sort())!==JSON.stringify(plan.assets.map(f=>f.path).sort()))fail('ASSETS_INVALID');
  for(const f of plan.assets){const bytes=await readMaintenanceFile(join(directory,f.path));if(bytes.length!==f.bytes||maintenanceHash(bytes)!==f.sha256)fail('ASSETS_CHANGED');}
}
export function renderMaintenanceEntry(plan) {
  const host=new URL(plan.origin).hostname;
  const paths=plan.assets.flatMap(f=>f.path.endsWith('.html')?['/'+f.path,f.path==='index.html'?'/':'/'+f.path.slice(0,-5)]:['/'+f.path]);
  return `import {DurableObject} from 'cloudflare:workers';
const paths=new Set(${JSON.stringify(paths)}),host=${JSON.stringify(host)},origin=${JSON.stringify(plan.origin)};
const unavailable=()=>new Response('{"error":{"code":"MAINTENANCE_ACTIVE"}}',{status:503,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','retry-after':'300','x-content-type-options':'nosniff'}});
export default {async fetch(request,env){const url=new URL(request.url);if(!['GET','HEAD'].includes(request.method)||![host,'www.'+host].includes(url.hostname)||!paths.has(url.pathname))return unavailable();if(url.hostname==='www.'+host){const target=new URL(origin);target.pathname=url.pathname;target.search=url.search;return Response.redirect(target.href,308);}try{const a=await env.ASSETS.fetch(request),h=new Headers(a.headers);h.set('referrer-policy','no-referrer');h.set('x-content-type-options','nosniff');h.set('content-security-policy',"default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");h.set('permissions-policy','camera=(), microphone=(), geolocation=()');return new Response(a.body,{status:a.status,statusText:a.statusText,headers:h});}catch{return unavailable();}},scheduled(){},queue(){throw Error('MAINTENANCE_ACTIVE');}};
export class UploadIngressBudget extends DurableObject {fetch(){return unavailable();}async acquire(){throw Error('MAINTENANCE_ACTIVE');}async renew(){throw Error('MAINTENANCE_ACTIVE');}async probe(){throw Error('MAINTENANCE_ACTIVE');}async status(){throw Error('MAINTENANCE_ACTIVE');}async release(){throw Error('MAINTENANCE_ACTIVE');}async alarm(){throw Error('MAINTENANCE_ACTIVE');}}
`;
}
export function maintenanceConfig(plan,assetDirectory,restore=false) {
  const host=new URL(plan.origin).hostname;
  const c={name:plan.workerName,account_id:plan.accountId,workers_dev:false,preview_urls:false,
    routes:[host,'www.'+host,'admin.'+host].map(pattern=>({pattern,custom_domain:true})),triggers:{crons:restore?plan.predecessor.cron:[]}};
  if(restore)return c;
  return {...c,main:'entry.mjs',compatibility_date:'2026-07-26',compatibility_flags:['nodejs_compat'],
    migrations:[{tag:plan.predecessor.migrationTag,new_sqlite_classes:['UploadIngressBudget']}],durable_objects:{bindings:[]},
    secrets:{required:plan.predecessor.secretBindings.map(value=>value.slice(value.indexOf(':')+1))},
    vars:{MAINTENANCE_PLAN_DIGEST:identityDigest(plan)},assets:{binding:'ASSETS',directory:assetDirectory,not_found_handling:'404-page',run_worker_first:true}};
}
async function createPackage(directory,assets,plan) {
  await mkdir(directory,{mode:0o700});await privateDirectory(directory);await mkdir(join(directory,'assets'),{mode:0o700});
  for(const f of plan.assets){const bytes=await readMaintenanceFile(join(assets,f.path));if(maintenanceHash(bytes)!==f.sha256)fail('ASSETS_CHANGED');await writeExclusive(join(directory,'assets',f.path),bytes);}
  await writeExclusive(join(directory,'entry.mjs'),renderMaintenanceEntry(plan));
  await writeExclusive(join(directory,'wrangler.json'),JSON.stringify(maintenanceConfig(plan,'./assets'))+'\n');
  await writeExclusive(join(directory,'restore-triggers.json'),JSON.stringify(maintenanceConfig(plan,'./assets',true))+'\n');
}
async function writeExclusive(path,bytes){const f=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}}
async function verifyPackage(directory,plan){await privateDirectory(directory);await verifyMaintenanceAssets(join(directory,'assets'),plan);for(const [name,expected]of [['entry.mjs',renderMaintenanceEntry(plan)],['wrangler.json',JSON.stringify(maintenanceConfig(plan,'./assets'))+'\n'],['restore-triggers.json',JSON.stringify(maintenanceConfig(plan,'./assets',true))+'\n']])if((await readMaintenanceFile(join(directory,name))).toString()!==expected)fail('PACKAGE_CHANGED');}
function sourceCheck(repositoryRoot,commit){try{if(execFileSync('git',['rev-parse','HEAD'],{cwd:repositoryRoot,encoding:'utf8'}).trim()!==commit||execFileSync('git',['status','--porcelain','--untracked-files=all'],{cwd:repositoryRoot,encoding:'utf8'}).trim())fail('SOURCE_CHANGED');}catch{fail('SOURCE_CHANGED');}}
export function validateMaintenanceState(s) {
  exact(s,'schema owner phase intent uploadedVersion everActivated lock cutover'+(Object.hasOwn(s,'sourceRecovery')?' sourceRecovery':''));
  if(s.schema!==1||!COMMIT.test(s.owner)||!['prepared','uploaded','active','contained','restoring','restored'].includes(s.phase)
    ||![null,'lock_acquire','lock_release','upload','activate','disable_cron','restore','restore_cron'].includes(s.intent)
    ||!(s.uploadedVersion===null||ID.test(s.uploadedVersion))||typeof s.everActivated!=='boolean'
    ||!['not_acquired','held','released'].includes(s.lock))fail('JOURNAL_INVALID');
  if(s.cutover!==null){
    exact(s.cutover,'planDigest phase intent versionId oldRestoreForbidden snapshot analytics lifecycle');
    if(!SHA.test(s.cutover.planDigest)||!['prepared','uploaded','active','verified'].includes(s.cutover.phase)
      ||![null,'upload','activate','release','analytics_deploy','analytics_initialize','analytics_upload','analytics_activate','analytics_cron','main_cron'].includes(s.cutover.intent)
      ||!(s.cutover.versionId===null||ID.test(s.cutover.versionId))||typeof s.cutover.oldRestoreForbidden!=='boolean'
      ||!s.cutover.snapshot||typeof s.cutover.snapshot!=='object')fail('JOURNAL_INVALID');
    const a=s.cutover.analytics,l=s.cutover.lifecycle;
    exact(a,'descriptor phase disabledVersionId enabledVersionId notBeforeMs naturalDigest registrationIntent registrationDigest preAdmissionDigest');exact(l,'scheduled notBeforeMs naturalDigest');
    if(!a.descriptor||!['prepared','disabled','uploaded','active','scheduled','observed'].includes(a.phase)||![a.disabledVersionId,a.enabledVersionId].every(v=>v===null||ID.test(v))||![a.notBeforeMs,l.notBeforeMs].every(v=>v===null||Number.isSafeInteger(v)&&v>=0)||![a.naturalDigest,l.naturalDigest,a.registrationDigest,a.preAdmissionDigest].every(v=>v===null||SHA.test(v))||!(a.registrationIntent===null||typeof a.registrationIntent==='object')||typeof l.scheduled!=='boolean')fail('JOURNAL_INVALID');
  }
  if(s.sourceRecovery!==undefined){const r=s.sourceRecovery;exact(r,'planDigest nextTrigger cacheRestored snapshotRemoved intent phase');if(!SHA.test(r.planDigest)||!Number.isSafeInteger(r.nextTrigger)||r.nextTrigger<0||r.nextTrigger>400||typeof r.cacheRestored!=='boolean'||typeof r.snapshotRemoved!=='boolean'||!['recovering','verified'].includes(r.phase)||r.phase==='verified'&&(!r.snapshotRemoved||r.intent!==null))fail('JOURNAL_INVALID');if(r.intent!==null){exact(r.intent,'kind statementDigest parametersDigest');if(!['drop-trigger','drop-snapshot','restore-cache'].includes(r.intent.kind)||!SHA.test(r.intent.statementDigest)||!SHA.test(r.intent.parametersDigest))fail('JOURNAL_INVALID');}}
  return s;
}

/** A maintenance operation deliberately keeps the shared owner while contained.
 * The production release reconciler must never accept this distinct kind. */
export async function runProductionMaintenance({plan,assetDirectory,operationDirectory,repositoryRoot,cliPath,
  action='inspect',confirmation=null,resume=false,executorStopped=false,clock=()=>Date.now(),
  provider=null,coordinationFactory=createProductionDeploymentLock,checkSource=sourceCheck}) {
  plan=structuredClone(validateMaintenancePlan(plan));const pin=identityDigest(plan);
  if(!['inspect','dry-run','enter','reconcile','restore','abort'].includes(action))fail('ACTION_INVALID');
  if(action==='inspect'){await verifyMaintenanceAssets(assetDirectory,plan);return {ok:true,code:'MAINTENANCE_INSPECTED',planDigest:pin,remoteWrites:false};}
  const approvals={enter:'ENTER_PRODUCTION_MAINTENANCE',restore:'RESTORE_PRODUCTION_FROM_MAINTENANCE',reconcile:'RECONCILE_PRODUCTION_MAINTENANCE',abort:'ABORT_UNACTIVATED_MAINTENANCE'};
  if(action!=='dry-run'&&confirmation!==approvals[action])fail('CONFIRMATION_REQUIRED');
  if(['reconcile','abort'].includes(action)&&!executorStopped)fail('EXECUTOR_NOT_STOPPED');
  if(action==='enter'&&(clock()>=plan.expiresAt||plan.expiresAt-clock()>86400000))fail('PLAN_EXPIRED');
  checkSource(repositoryRoot,plan.toolingCommit);
  let operation;let lock;let state;
  try{
    operation=await openOperation({directory:operationDirectory,kind:'maintenance',binding:{planDigest:pin},resume:resume||['restore','reconcile','abort'].includes(action)});
    const packageDirectory=join(operation.directory,'candidate');
    if(!resume&&!['restore','reconcile','abort'].includes(action)){
      await verifyMaintenanceAssets(assetDirectory,plan);await createPackage(packageDirectory,assetDirectory,plan);
      lock=coordinationFactory({repositoryRoot});state={schema:1,owner:lock.createOwner({id:operation.record.id,sourceCommit:plan.toolingCommit,previousSourceCommit:plan.predecessor.sourceCommit}),phase:'prepared',intent:null,uploadedVersion:null,everActivated:false,lock:'not_acquired',cutover:null};await operation.save(state);
    }else{state=operation.record.state;validateMaintenanceState(state);lock=coordinationFactory({repositoryRoot});}
    if(state.cutover?.oldRestoreForbidden)fail('CUTOVER_FORWARD_ONLY');
    if(['restore','abort'].includes(action)&&state.sourceRecovery?.phase==='recovering')fail('SOURCE_RECOVERY_REQUIRED');
    await verifyPackage(packageDirectory,plan);
    provider??=await createMaintenanceProvider({plan,packageDirectory,operationDirectory:operation.directory,operationId:operation.record.id,cliPath});
    if(action==='dry-run'){await provider.dryRun();return {ok:true,code:'MAINTENANCE_DRY_RUN',remoteWrites:false};}
    if(action==='reconcile'){
      if(state.lock==='released')return {ok:true,code:'MAINTENANCE_ALREADY_RESTORED'};
      if(state.intent==='lock_acquire'){
        if(lock.status()!==state.owner)fail('RECONCILIATION_UNVERIFIED');
        state.lock='held';state.intent=null;await operation.save(state);
      }else if(state.intent==='lock_release'){
        // Absence is only proof after this exact verified-restored release intent.
        const observedOwner=lock.status();
        if(state.phase!=='restored'||![null,state.owner].includes(observedOwner))fail('RECONCILIATION_UNVERIFIED');
        await provider.reconcile('restore_cron',state.uploadedVersion).then(r=>{if(!r?.matched)fail('RECONCILIATION_UNVERIFIED');});
        state.lock=observedOwner===null?'released':'held';state.intent=null;await operation.save(state);
        return {ok:true,code:'MAINTENANCE_RECONCILED',phase:state.phase,coordination:state.lock};
      }
      lock.assertOwned(state.owner);
      if(state.intent){
        const result=await provider.reconcile(state.intent,state.uploadedVersion);
        if(!result?.matched)fail('RECONCILIATION_UNVERIFIED');
        applyResult(state,state.intent,result.versionId);state.intent=null;await operation.save(state);
      }
      // Read-only reconciliation never releases a still-held owner. Restore resumes that explicit step.
      return {ok:true,code:'MAINTENANCE_RECONCILED',phase:state.phase,coordination:state.lock};
    }
    if(state.intent!==null)fail('RECONCILE_REQUIRED');
    if(state.lock==='released')fail('OPERATION_CLOSED');
    if(state.lock==='not_acquired'){
      if(action!=='enter')fail('JOURNAL_INVALID');
      await provider.assertPredecessor();state.intent='lock_acquire';await operation.save(state);lock.acquire(state.owner);state.lock='held';state.intent=null;await operation.save(state);
      await provider.assertPredecessor();
    }else lock.assertOwned(state.owner);
    const step=async name=>{
      if(!['restore','restore_cron'].includes(name)&&clock()>=plan.expiresAt)fail('PLAN_EXPIRED');
      checkSource(repositoryRoot,plan.toolingCommit);await verifyPackage(packageDirectory,plan);lock.assertOwned(state.owner);
      await provider.before(name,state.uploadedVersion);
      state.intent=name;await operation.save(state);
      const result=await provider.mutate(name,state.uploadedVersion);
      lock.assertOwned(state.owner);
      const verified=await provider.reconcile(name,result?.versionId??state.uploadedVersion);
      if(!verified?.matched)fail('MUTATION_UNVERIFIED');
      applyResult(state,name,verified.versionId??result?.versionId);state.intent=null;await operation.save(state);
    };
    if(action==='enter'){
      if(state.phase==='prepared')await step('upload');
      if(state.phase==='uploaded')await step('activate');
      if(state.phase==='active')await step('disable_cron');
      if(state.phase!=='contained')fail('JOURNAL_INVALID');
      await provider.verifyContained(state.uploadedVersion);
      return {ok:true,code:'MAINTENANCE_CONTAINED',coordination:'held',drainProven:false};
    }
    if(action==='abort'){
      if(state.everActivated||!['prepared','uploaded'].includes(state.phase))fail('ABORT_STATE_INVALID');
      await provider.assertPredecessor();await provider.assertRestoreSafe();
      state.phase='restored';state.intent='lock_release';await operation.save(state);
      lock.release(state.owner);state.lock='released';state.intent=null;await operation.save(state);
      return {ok:true,code:'MAINTENANCE_ABORTED',coordination:'released'};
    }
    if(action==='restore'){
      if(!['active','contained','restoring','restored'].includes(state.phase))fail('RESTORE_STATE_INVALID');
      await provider.assertRestoreSafe();
      if(['active','contained'].includes(state.phase))await step('restore');
      if(state.phase==='restoring')await step('restore_cron');
      if(!(await provider.reconcile('restore_cron',state.uploadedVersion))?.matched)fail('RESTORE_UNVERIFIED');
      lock.assertOwned(state.owner);
      state.intent='lock_release';await operation.save(state);lock.release(state.owner);state.lock='released';state.intent=null;await operation.save(state);
      return {ok:true,code:'MAINTENANCE_RESTORED',coordination:'released'};
    }
  }finally{operation?.close();}
}
function applyResult(state,intent,versionId){
  if(intent==='upload'){if(!ID.test(versionId??''))fail('UPLOAD_ID_INVALID');state.uploadedVersion=versionId;state.phase='uploaded';}
  if(intent==='activate'){state.everActivated=true;state.phase='active';}
  if(intent==='disable_cron')state.phase='contained';
  if(intent==='restore')state.phase='restoring';
  if(intent==='restore_cron')state.phase='restored';
}
export function parseMaintenanceArguments(args){const result={action:'inspect'},seen=new Set();for(let i=0;i<args.length;i++){const key=args[i];if(seen.has(key))fail('ARGUMENTS_INVALID');seen.add(key);if(['--resume','--executor-stopped'].includes(key)){result[key==='--resume'?'resume':'executorStopped']=true;continue;}const names={'--plan':'planPath','--assets':'assetDirectory','--operation':'operationDirectory','--repository':'repositoryRoot','--wrangler-cli':'cliPath','--action':'action','--confirm':'confirmation'};if(!names[key]||!args[i+1]||args[i+1].startsWith('--')||Object.hasOwn(result,names[key])&&key!=='--action')fail('ARGUMENTS_INVALID');result[names[key]]=args[++i];}for(const k of ['planPath','assetDirectory','operationDirectory','repositoryRoot','cliPath'])if(!result[k])fail('ARGUMENTS_INVALID');return result;}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){try{const options=parseMaintenanceArguments(process.argv.slice(2));const plan=JSON.parse((await readMaintenanceFile(options.planPath,65536)).toString());console.log(JSON.stringify(await runProductionMaintenance({...options,plan})));}catch(error){console.error(/^(PRODUCTION_MAINTENANCE|RELEASE_OPERATION|PRODUCTION_COORDINATION)_[A-Z_]+$/.test(error?.code??'')?error.code:'PRODUCTION_MAINTENANCE_FAILED');process.exitCode=1;}}
