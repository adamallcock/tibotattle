import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createMaintenanceTransport } from './production-maintenance-transport.mjs';
import { identityDigest, operationError } from '../../../scripts/lib/release-operation.mjs';

const fail = code => { throw operationError(`PRODUCTION_MAINTENANCE_${code}`); };
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value ?? '');
const hash = value => createHash('sha256').update(value).digest('hex');
const sorted = values => [...values].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
export const maintenanceBindingDigest = bindings => identityDigest(sorted(bindings));
export const MAINTENANCE_SCHEMA_QUERY = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name LIMIT 4097";
const list = (value, key, max) => { const rows = Array.isArray(value) ? value : value?.[key]; if (!Array.isArray(rows)||rows.length>max) fail('INVENTORY_UNBOUNDED'); return rows; };

/** Fixed-account provider. Only the five closed mutations below exist; schema
 * inspection is a fixed read, never a caller-supplied SQL execution escape. */
export async function createMaintenanceProvider({plan,packageDirectory,operationDirectory,operationId,cliPath,
  fetcher=fetch,spawn=spawnSync,environment=process.env,cutoverInventory=null}) {
  const {api,receipt,publicRead,run:command}=createMaintenanceTransport({plan,operationDirectory,cliPath,fetcher,spawn,environment});
  const account=`/accounts/${plan.accountId}`,script=`${account}/workers/scripts/${plan.workerName}`;
  const tag=`maintenance-${operationId}`;
  const run=(step,args,dry=false)=>command({step,args,dry,directory:packageDirectory,config:join(packageDirectory,step==='restore_cron'?'restore-triggers.json':'wrangler.json')});
  const version=async id=>{if(!uuid(id))fail('VERSION_INVALID');const v=await api(`${script}/versions/${id}`);if(v.id!==id||!Array.isArray(v.resources?.bindings))fail('VERSION_INVALID');return v;};
  const active=async name=>{
    const deployments=list(await api(`${account}/workers/scripts/${name}/deployments`),'deployments',100);
    if(!deployments.length)fail('DEPLOYMENT_UNKNOWN');
    // Provider returns newest first. Reject mixed traffic, including any extra zero-version entry.
    const d=deployments[0];if(!Array.isArray(d.versions)||d.versions.length!==1||d.versions[0].percentage!==100||!uuid(d.versions[0].version_id))fail('DEPLOYMENT_UNKNOWN');
    return d.versions[0].version_id;
  };
  const bindings=async id=>(await version(id)).resources.bindings;
  const expectActive=async id=>{if(await active(plan.workerName)!==id)fail('PREDECESSOR_CHANGED');};
  const crons=async()=>list(await api(`${script}/schedules`),'schedules',16).map(x=>x.cron).sort();
  const checkCrons=async expected=>{if(JSON.stringify(await crons())!==JSON.stringify([...expected].sort()))fail('TRIGGERS_CHANGED');};
  const ingress=async()=>{
    const settings=await api(`${script}/subdomain`);if(settings.enabled!==false||settings.previews_enabled!==false)fail('INGRESS_CHANGED');
    const routes=list(await api(`${account}/workers/services/${plan.workerName}/environments/production/routes?show_zonename=true`),'routes',100);if(routes.length)fail('INGRESS_CHANGED');
    const domains=list(await api(`${account}/workers/domains/records?page=0&per_page=100&service=${plan.workerName}&environment=production`),'records',99);
    const host=new URL(plan.origin).hostname;
    if(JSON.stringify(domains.map(x=>x.hostname).sort())!==JSON.stringify([host,'www.'+host,'admin.'+host].sort()))fail('INGRESS_CHANGED');
    const namespaces=list(await api(`${account}/workers/durable_objects/namespaces?per_page=100`),'namespaces',99);
    const ns=namespaces.filter(x=>x.id===plan.predecessor.durableNamespaceId);
    if(ns.length!==1||ns[0].class!=='UploadIngressBudget'||ns[0].script!==plan.workerName)fail('DURABLE_IDENTITY_CHANGED');
  };
  if(cutoverInventory!==null&&(!/^[a-f0-9]{64}$/.test(cutoverInventory.digest??'')||!/^tibotattle-analytics-[a-z0-9-]{1,42}$/.test(cutoverInventory.analyticsWorker??'')||cutoverInventory.analyticsWorker===plan.workerName))fail('INVENTORY_INVALID');
  const writerInventory=async expectOwn=>{
    const workers=list(await api(`${account}/workers/scripts?per_page=100`),'scripts',30);let own=false;const snapshot={workers:[],queues:[]};
    for(const worker of workers){
      const name=worker.id;if(!/^[a-zA-Z0-9_-]{1,63}$/.test(name??''))fail('INVENTORY_INVALID');
      const id=await active(name);const v=await api(`${account}/workers/scripts/${name}/versions/${id}`);
      const settings=await api(`${account}/workers/scripts/${name}/settings`);
      if(name!==cutoverInventory?.analyticsWorker)snapshot.workers.push(name===plan.workerName?{name}:{name,versionId:id,bindings:maintenanceBindingDigest(v.resources?.bindings??[]),settings:maintenanceBindingDigest(settings.bindings??[])});
      for(const bs of [v.resources?.bindings,settings.bindings]){
        if(!Array.isArray(bs)||bs.length>100)fail('INVENTORY_INVALID');
        const writes=bs.some(b=>b.type==='d1'&&(b.id??b.database_id)===plan.databaseId);
        if(writes&&name!==plan.workerName)fail('OTHER_WRITER');
        if(name===plan.workerName){own ||= writes;if(writes!==expectOwn)fail('WRITER_STATE_CHANGED');}
        for(const b of bs)if(b.type==='dispatch_namespace'||(name!==plan.workerName&&((b.type==='service'&&b.service===plan.workerName)||(b.type==='durable_object_namespace'&&b.namespace_id===plan.predecessor.durableNamespaceId))))fail('OTHER_INGRESS');
      }
    }
    if(expectOwn&&!own||!workers.some(w=>w.id===plan.workerName))fail('WRITER_STATE_CHANGED');
    const queues=list(await api(`${account}/queues?page=1&per_page=100`),'queues',20);
    for(const q of queues){if(!/^[a-f0-9]{32}$/.test(q.queue_id??''))fail('INVENTORY_INVALID');const consumers=list(await api(`${account}/queues/${q.queue_id}/consumers`),'consumers',20);snapshot.queues.push({queueId:q.queue_id,consumers:identityDigest(sorted(consumers))});if(consumers.some(c=>c.script_name===plan.workerName))fail('OTHER_INGRESS');}
    await ingress();
    snapshot.workers=sorted(snapshot.workers);snapshot.queues=sorted(snapshot.queues);
    if(identityDigest(snapshot)!==(cutoverInventory?.digest??plan.predecessor.inventoryDigest))fail('WRITER_INVENTORY_CHANGED');
  };
  const candidate=async id=>{
    const v=await version(id);if(v.annotations?.['workers/tag']!==tag)fail('CANDIDATE_CHANGED');
    const bs=v.resources.bindings;
    const secrets=bs.filter(b=>['secret_text','secret_key'].includes(b.type)).map(b=>`${b.type}:${b.name}`).sort();
    if(JSON.stringify(secrets)!==JSON.stringify([...plan.predecessor.secretBindings].sort()))fail('CANDIDATE_CHANGED');
    const nonSecrets=bs.filter(b=>!['secret_text','secret_key'].includes(b.type));
    if(nonSecrets.length!==2||!nonSecrets.some(b=>b.type==='assets'&&b.name==='ASSETS')||!nonSecrets.some(b=>b.type==='plain_text'&&b.name==='MAINTENANCE_PLAN_DIGEST'&&b.text===identityDigest(plan)))fail('CANDIDATE_CHANGED');
  };
  const discover=async()=>{
    const versions=list(await api(`${script}/versions?deployable=true`),'items',100);
    const matches=versions.filter(v=>v.annotations?.['workers/tag']===tag);
    if(matches.length!==1||!uuid(matches[0].id))fail('UPLOAD_UNCERTAIN');
    await candidate(matches[0].id);return matches[0].id;
  };
  const surface=async maintenance=>{
    for(const file of plan.assets){const route=file.path==='index.html'?'/':file.path.endsWith('.html')?'/'+file.path.slice(0,-5):'/'+file.path;
      const {response,bytes}=await publicRead(plan.origin+route+'?maintenance-proof='+randomUUID());
      if(response.status!==200||bytes.length!==file.bytes||hash(bytes)!==file.sha256)fail('PUBLIC_ASSETS_CHANGED');}
    const host=new URL(plan.origin).hostname;
    for(const url of [plan.origin+'/api/health',plan.origin+'/api/v1/admin/status']){
      const proofURL=url+'?maintenance-proof='+randomUUID();const {response,bytes}=await publicRead(proofURL);
      if(maintenance){if(response.status!==503||response.headers.get('retry-after')!=='300'||bytes.toString()!=='{"error":{"code":"MAINTENANCE_ACTIVE"}}')fail('CONTAINMENT_UNVERIFIED');}
      else if(url===plan.origin+'/api/health'){let health;try{health=JSON.parse(bytes);}catch{fail('RESTORE_UNVERIFIED');}if(response.url!==proofURL||response.status!==200||bytes.length>65536||health.status!=='ok'||response.headers.get('content-type')?.split(';',1)[0]!=='application/json'||response.headers.get('cache-control')!=='no-store'||response.headers.get('referrer-policy')!=='no-referrer'||response.headers.get('x-content-type-options')!=='nosniff'||health.deployment?.sourceCommit!==plan.predecessor.sourceCommit)fail('RESTORE_UNVERIFIED');}
    }
  };
  const assertPredecessor=async()=>{
    await expectActive(plan.predecessor.versionId);
    if(maintenanceBindingDigest(await bindings(plan.predecessor.versionId))!==plan.predecessor.bindingDigest)fail('PREDECESSOR_CHANGED');
    await checkCrons(plan.predecessor.cron);await writerInventory(true);await surface(false);
  };
  const assertRestoreSafe=async()=>{
    const result=await api(`${account}/d1/database/${plan.databaseId}/query`,{sql:MAINTENANCE_SCHEMA_QUERY,params:[]});
    if(!Array.isArray(result)||result.length!==1||result[0].success!==true||!Array.isArray(result[0].results)||result[0].results.length>=4097)fail('RESTORE_SCHEMA_UNVERIFIED');
    const rows=result[0].results;
    if(rows.some(r=>/^_authority_/.test(r.name))||identityDigest(rows)!==plan.restoreSchemaDigest)fail('RESTORE_SCHEMA_CHANGED');
  };
  const reconcile=async(step,id)=>{
    if(step==='upload'){id=id??await discover();await candidate(id);await expectActive(plan.predecessor.versionId);return {matched:true,versionId:id};}
    if(step==='activate'||step==='disable_cron'){await candidate(id);await expectActive(id);await writerInventory(false);await surface(true);if(step==='disable_cron')await checkCrons([]);return {matched:true};}
    if(step==='restore'||step==='restore_cron'){await assertRestoreSafe();await expectActive(plan.predecessor.versionId);if(maintenanceBindingDigest(await bindings(plan.predecessor.versionId))!==plan.predecessor.bindingDigest)fail('PREDECESSOR_CHANGED');await writerInventory(true);await surface(false);if(step==='restore_cron')await checkCrons(plan.predecessor.cron);return {matched:true};}
    fail('STEP_INVALID');
  };
  return {
    dryRun:()=>run('dry-run',['versions','upload','--dry-run','--outdir',join(operationDirectory,'dry-build')],true),assertPredecessor,assertRestoreSafe,reconcile,
    async before(step,id){if(step==='upload'||step==='activate')await assertPredecessor();else if(step==='restore_cron')await expectActive(plan.predecessor.versionId);else{await candidate(id);await expectActive(id);await writerInventory(false);}if(step==='restore'||step==='restore_cron')await assertRestoreSafe();},
    async mutate(step,id){
      if(step==='upload')return run(step,['versions','upload','--tag',tag,'--message',tag]);
      if(step==='activate'){await candidate(id);return run(step,['versions','deploy',`${id}@100%`,'--yes']);}
      if(step==='disable_cron')return run(step,['triggers','deploy']);
      if(step==='restore')return run(step,['versions','deploy',`${plan.predecessor.versionId}@100%`,'--yes']);
      if(step==='restore_cron')return run(step,['triggers','deploy']);
      fail('STEP_INVALID');
    },
    async verifyContained(id){await reconcile('disable_cron',id);await receipt({kind:'contained',planDigest:identityDigest(plan),versionId:id,drainProven:false});}
  };
}
