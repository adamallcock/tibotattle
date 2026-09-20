import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { dependencyTreeDigest } from './production-deploy.mjs';
import { createMaintenanceTransport } from './production-maintenance-transport.mjs';
import { maintenanceHash, readMaintenanceFile } from './production-maintenance.mjs';
import { identityDigest, operationError } from '../../../scripts/lib/release-operation.mjs';
const fail=code=>{throw operationError(`PRODUCTION_MAINTENANCE_ANALYTICS_${code}`);};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const rows=(v,key,max=100)=>{const r=Array.isArray(v)?v:v?.[key];if(!Array.isArray(r)||r.length>max)fail('INVENTORY_INVALID');return r;};
const integer=(v,max)=>Number.isSafeInteger(v)&&v>=0&&v<=max;

/** Wrangler --format json emits concatenated, possibly pretty-printed objects.
 * This framing accepts JSON only, not substring matches inside arbitrary logs. */
export function parseMaintenanceTailCapture(bytes) {
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>2_000_000)fail('TAIL_INVALID');
 const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))fail('TAIL_INVALID');
 const events=[];let start=-1,depth=0,quoted=false,escape=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];if(start<0){if(/\s/.test(c))continue;if(c!=='{')fail('TAIL_INVALID');start=i;depth=1;continue;}
  if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;continue;}
  if(c==='"')quoted=true;else if(c==='{'||c==='['){if(++depth>64)fail('TAIL_INVALID');}else if(c==='}'||c===']'){
   if(--depth===0){let event;try{event=JSON.parse(text.slice(start,i+1));}catch{fail('TAIL_INVALID');}events.push(event);if(events.length>256)fail('TAIL_INVALID');start=-1;}
  }
 }
 if(start!==-1||events.length===0)fail('TAIL_INVALID');return events;
}
export function proveMaintenanceAnalyticsInvocation(bytes,{workerName,versionId,notBeforeMs,nowMs=Date.now()}) {
 if(!uuid(versionId)||!integer(notBeforeMs,nowMs))fail('TAIL_PINS_INVALID');
 const events=parseMaintenanceTailCapture(bytes),matches=[];
 for(const e of events){
  if(e.scriptName!==workerName||e.scriptVersion?.id!==versionId||e.event?.cron!=='* * * * *')continue;
  if(!integer(e.event.scheduledTime,nowMs)||e.event.scheduledTime<notBeforeMs)continue;
  if(e.outcome!=='ok'||e.truncated!==false||!Array.isArray(e.exceptions)||e.exceptions.length||!Array.isArray(e.logs)||e.logs.length>256)fail('SCHEDULE_FAILED');
  const found=[];
  for(const log of e.logs){
   if(!Array.isArray(log.message)||log.message.length!==1||typeof log.message[0]!=='string')continue;
   let value;try{value=JSON.parse(log.message[0]);}catch{continue;}
   if(value?.event!=='storage_analytics_schedule')continue;
   if(log.level!=='log'||Object.keys(value).sort().join()!=='dailyPublications,event,graphCalculations,queriesUsed,reason,recordsRead,state,steps'
    ||!['idle','progress','deferred'].includes(value.state)||!['complete','step_limit','deadline','query_budget'].includes(value.reason)
    ||!integer(value.steps,8)||!integer(value.queriesUsed,900)||!integer(value.recordsRead,Number.MAX_SAFE_INTEGER)
    ||!integer(value.dailyPublications,Number.MAX_SAFE_INTEGER)||!integer(value.graphCalculations,Number.MAX_SAFE_INTEGER))fail('SCHEDULE_FAILED');
   found.push(value);
  }
  if(found.length!==1)fail('SCHEDULE_FAILED');matches.push({scheduledTime:e.event.scheduledTime,...found[0]});
 }
 if(!matches.length)fail('NATURAL_INVOCATION_MISSING');
 return {captureSha256:maintenanceHash(bytes),captureBytes:bytes.length,capturedEvents:events.length,qualifiedInvocations:matches.length,firstScheduledTime:Math.min(...matches.map(v=>v.scheduledTime)),lastScheduledTime:Math.max(...matches.map(v=>v.scheduledTime)),observations:matches};
}

/** One command per mutation method. The parent owns intent journaling and must
 * permanently latch old-source rollback off before enabling this scheduler. */
export function createMaintenanceAnalyticsProvider({plan,cutover,operationDirectory,cliPath,fetcher=fetch,spawn=spawnSync,
 environment=process.env,dependencyDigest=dependencyTreeDigest}) {
 const c=cutover.candidate,name=cutover.analytics?.workerName;
 if(typeof c.sourceId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(c.sourceId)||typeof c.sourceNamespace!=='string'||!/^[A-Za-z0-9_.:-]{1,256}$/.test(c.sourceNamespace)||typeof name!=='string'||!/^tibotattle-analytics-[a-z0-9-]{1,42}$/.test(name)||name===plan.workerName||!uuid(cutover.operationId))fail('CONFIG_INVALID');
 const transport=createMaintenanceTransport({plan,operationDirectory,cliPath,fetcher,spawn,environment});
 const account=`/accounts/${plan.accountId}`,script=`${account}/workers/scripts/${name}`;
 const tag=mode=>`analytics-${mode}-${cutover.operationId}`;
 const snapshotPin=s=>({repositoryRoot:s.repositoryRoot,workerDirectory:s.workerDirectory,dependencyPath:s.dependencyPath,sourceCommit:s.sourceCommit,dependencyDigest:s.dependencyDigest});
 const verifySource=async s=>{
  if(!s||s.sourceCommit!==c.sourceCommit||s.dependencyDigest!==c.dependencyDigest||s.workerDirectory!==join(s.repositoryRoot,'apps/worker')||s.dependencyPath!==join(s.workerDirectory,'node_modules')||await realpath(s.repositoryRoot)!==s.repositoryRoot)fail('SNAPSHOT_INVALID');
  const git=args=>execFileSync('/usr/bin/git',['-c',`core.excludesFile=${join(dirname(s.repositoryRoot),'git-exclude')}`,'-C',s.repositoryRoot,...args],{encoding:'utf8',maxBuffer:1024*1024}).trim();
  if(git(['rev-parse','HEAD'])!==c.sourceCommit||git(['status','--porcelain','--untracked-files=all']))fail('SOURCE_CHANGED');
  if(await dependencyDigest(s.dependencyPath)!==c.dependencyDigest)fail('DEPENDENCIES_CHANGED');
 };
 const configuration=async(s,mode,cron=false)=>{
  const base=JSON.parse(await readFile(join(s.workerDirectory,'wrangler.analytics.example.jsonc'),'utf8'));
  if(Object.keys(base).sort().join()!=='$schema,compatibility_date,compatibility_flags,d1_databases,main,name,preview_urls,triggers,vars,workers_dev'||base.main!=='src/storage-analytics-worker.ts'||base.workers_dev!==false||base.preview_urls!==false||base.vars?.STORAGE_ANALYTICS_MODE!=='disabled'||base.triggers?.crons?.length!==0)fail('CONFIG_INVALID');
  const pairs=[['STORAGE_INGESTION_DB',c.ingestionDatabaseId,c.ingestionDatabaseName],['STORAGE_ANALYTICS_DB',c.analyticsDatabaseId,c.analyticsDatabaseName],['DELETION_LEDGER',c.deletionLedgerDatabaseId,c.deletionLedgerDatabaseName]];
  if(pairs.some(([,id,n])=>!uuid(id)||typeof n!=='string'||!/^[a-z][a-z0-9-]{2,95}$/.test(n))||new Set(pairs.map(x=>x[1])).size!==3||pairs.some(x=>x[1]===plan.databaseId))fail('DATABASE_IDENTITY_INVALID');
  return {name,account_id:plan.accountId,main:'../../apps/worker/src/storage-analytics-worker.ts',compatibility_date:base.compatibility_date,compatibility_flags:base.compatibility_flags,
   workers_dev:false,preview_urls:false,routes:[],triggers:{crons:cron?['* * * * *']:[]},
   vars:{STORAGE_ANALYTICS_MODE:mode,STORAGE_SOURCE_ID:c.sourceId,TELEMETRY_STORAGE_NAMESPACE:c.sourceNamespace,DEPLOYMENT_SOURCE_COMMIT:c.sourceCommit,MAINTENANCE_ANALYTICS_PLAN_DIGEST:identityDigest(cutover)},
   d1_databases:pairs.map(([binding,database_id,database_name])=>({binding,database_id,database_name})),observability:{enabled:true,head_sampling_rate:1}};
 };
 const descriptorFor=async s=>{
  const directory=join(s.repositoryRoot,'.release-build/maintenance-analytics'),files={};
  for(const [key,mode,cron]of [['disabled','disabled',false],['enabled','enabled',false],['cron','enabled',true]]){
   const bytes=JSON.stringify(await configuration(s,mode,cron))+'\n';files[key]={path:join(directory,key+'.json'),sha256:maintenanceHash(bytes)};
  }
  return {schema:'maintenance-analytics-descriptor-v1',workerName:name,snapshotDigest:identityDigest(snapshotPin(s)),files};
 };
 const verify=async(s,d)=>{await verifySource(s);const expected=await descriptorFor(s);if(identityDigest(expected)!==identityDigest(d))fail('DESCRIPTOR_CHANGED');for(const f of Object.values(d.files))if(maintenanceHash(await readMaintenanceFile(f.path,256*1024))!==f.sha256)fail('CONFIG_CHANGED');};
 const prepare=async s=>{await verifySource(s);const d=await descriptorFor(s);await mkdir(dirname(d.files.disabled.path),{mode:0o700});for(const[key,mode,cron]of [['disabled','disabled',false],['enabled','enabled',false],['cron','enabled',true]])await writeFile(d.files[key].path,JSON.stringify(await configuration(s,mode,cron))+'\n',{flag:'wx',mode:0o600});await verify(s,d);await transport.receipt({kind:'analytics-prepared',descriptorDigest:identityDigest(d),sourceCommit:c.sourceCommit});return d;};
 const active=async()=>{const d=rows(await transport.api(`${script}/deployments`),'deployments')[0];if(d?.versions?.length!==1||d.versions[0].percentage!==100||!uuid(d.versions[0].version_id))fail('DEPLOYMENT_INVALID');return d.versions[0].version_id;};
 const candidate=async(s,d,id,mode)=>{
  await verify(s,d);if(!uuid(id))fail('VERSION_INVALID');const v=await transport.api(`${script}/versions/${id}`),bs=v.resources?.bindings,config=await configuration(s,mode);
  if(v.id!==id||v.annotations?.['workers/tag']!==tag(mode)||!Array.isArray(bs)||bs.length!==3+Object.keys(config.vars).length)fail('VERSION_CHANGED');
  const names=new Set();for(const b of bs){if(names.has(b.name))fail('BINDINGS_CHANGED');names.add(b.name);if(b.type==='d1'){if(!config.d1_databases.some(x=>x.binding===b.name&&x.database_id===(b.id??b.database_id)))fail('BINDINGS_CHANGED');}else if(b.type!=='plain_text'||!Object.hasOwn(config.vars,b.name)||config.vars[b.name]!==b.text)fail('BINDINGS_CHANGED');}
  return v;
 };
 const ingress=async()=>{
  const sub=await transport.api(`${script}/subdomain`);if(sub.enabled!==false||sub.previews_enabled!==false)fail('HTTP_ENABLED');
  if(rows(await transport.api(`${account}/workers/services/${name}/environments/production/routes?show_zonename=true`),'routes').length||rows(await transport.api(`${account}/workers/domains/records?page=0&per_page=100&service=${name}&environment=production`),'records',99).length)fail('HTTP_ENABLED');
 };
 const schedule=async expected=>{const list=rows(await transport.api(`${script}/schedules`),'schedules',16);if(JSON.stringify(list.map(x=>x.cron).sort())!==JSON.stringify(expected))fail('SCHEDULE_CHANGED');};
 const verifyMode=async(s,d,id,mode,scheduled=false)=>{await candidate(s,d,id,mode);if(await active()!==id)fail('DEPLOYMENT_CHANGED');await ingress();await schedule(scheduled?['* * * * *']:[]);};
 const command=async(s,d,key,step,args,dry=false)=>{await verify(s,d);await transport.run({step,args,config:d.files[key].path,directory:s.workerDirectory,dry});await verify(s,d);};
 const discover=async(s,d,mode)=>{await verify(s,d);const list=rows(await transport.api(`${script}/versions?deployable=true`),'items').filter(x=>x.annotations?.['workers/tag']===tag(mode));if(list.length!==1)fail('UPLOAD_UNCERTAIN');await candidate(s,d,list[0].id,mode);return list[0].id;};
 const assertAbsent=async()=>{if(rows(await transport.api(`${account}/workers/scripts`),null).some(x=>x.id===name||x.name===name))fail('WORKER_ALREADY_EXISTS');};
 return {prepare,assertAbsent,
  dryRun:async(s,d)=>{await command(s,d,'disabled','analytics-disabled-dry',['versions','upload','--dry-run','--outdir',join(operationDirectory,'analytics-disabled-dry')],true);await command(s,d,'enabled','analytics-enabled-dry',['versions','upload','--dry-run','--outdir',join(operationDirectory,'analytics-enabled-dry')],true);},
  deployDisabled:async(s,d)=>{await assertAbsent();return command(s,d,'disabled','analytics-disabled-deploy',['deploy','--tag',tag('disabled'),'--message',tag('disabled')]);},
  discoverDisabled:(s,d)=>discover(s,d,'disabled'),
  activateDisabled:async(s,d,id)=>{await candidate(s,d,id,'disabled');return command(s,d,'disabled','analytics-disabled-activate',['versions','deploy',`${id}@100%`,'--yes']);},
  verifyDisabled:(s,d,id)=>verifyMode(s,d,id,'disabled'),
  uploadEnabled:async(s,d)=>{const id=await active();await verifyMode(s,d,id,'disabled');return command(s,d,'enabled','analytics-enabled-upload',['versions','upload','--tag',tag('enabled'),'--message',tag('enabled')]);},
  discoverEnabled:(s,d)=>discover(s,d,'enabled'),
  async verifyEnabledUploadAbsent(s,d,disabledId){await verifyMode(s,d,disabledId,'disabled');const list=rows(await transport.api(`${script}/versions?deployable=true`),'items').filter(x=>x.annotations?.['workers/tag']===tag('enabled'));if(list.length)fail('UPLOAD_UNCERTAIN');},
  activateEnabled:async(s,d,id)=>{await candidate(s,d,id,'enabled');return command(s,d,'enabled','analytics-enabled-activate',['versions','deploy',`${id}@100%`,'--yes']);},
  enableCron:async(s,d,id)=>{await verifyMode(s,d,id,'enabled');return command(s,d,'cron','analytics-enable-cron',['triggers','deploy']);},
  verifyEnabledUnscheduled:(s,d,id)=>verifyMode(s,d,id,'enabled'),
  verifyEnabled:(s,d,id)=>verifyMode(s,d,id,'enabled',true),
  verifyNaturalInvocation:async(s,d,id,capturePath,notBeforeMs)=>{await verifyMode(s,d,id,'enabled',true);const bytes=await readMaintenanceFile(capturePath,2_000_000);const proof=proveMaintenanceAnalyticsInvocation(bytes,{workerName:name,versionId:id,notBeforeMs});await transport.receipt({kind:'analytics-natural-invocation',sourceCommit:c.sourceCommit,versionId:id,descriptorDigest:identityDigest(d),...proof});return proof;},
 };
}
