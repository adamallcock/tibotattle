import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaintenanceProvider, maintenanceBindingDigest, MAINTENANCE_SCHEMA_QUERY } from './production-maintenance-provider.mjs';
import { identityDigest } from '../../../scripts/lib/release-operation.mjs';
import { maintenanceHash } from './production-maintenance.mjs';
const old='11111111-1111-4111-8111-111111111111',next='22222222-2222-4222-8222-222222222222',op='33333333-3333-4333-8333-333333333333';
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'maintenance-provider-')));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'wrangler-dist'));await writeFile(join(root,'package.json'),JSON.stringify({name:'wrangler',version:'4.114.0',main:'wrangler-dist/cli.js'}));const cliPath=join(root,'wrangler-dist/cli.js');await writeFile(cliPath,'// synthetic pinned executable\n');
 await writeFile(join(root,'wrangler.json'),'{}');await writeFile(join(root,'restore-triggers.json'),'{}');
 const oldBindings=[{type:'d1',name:'DB',id:old},{type:'assets',name:'ASSETS'},{type:'plain_text',name:'DEPLOYMENT_SOURCE_COMMIT',text:'f'.repeat(40)}];
 const rows=[{type:'table',name:'synthetic',tbl_name:'synthetic',sql:'CREATE TABLE synthetic(id INTEGER)'}];
 const plan={schema:'production-maintenance-v1',toolingCommit:'b'.repeat(40),expiresAt:Date.now()+3600000,accountId:'c'.repeat(32),workerName:'synthetic-worker',databaseId:old,origin:'https://synthetic.example',restoreSchemaDigest:identityDigest(rows),wranglerSha256:maintenanceHash(await readFile(cliPath)),predecessor:{sourceCommit:'f'.repeat(40),versionId:old,bindingDigest:maintenanceBindingDigest(oldBindings),inventoryDigest:identityDigest({workers:[{name:'synthetic-worker'}],queues:[]}),cron:['* * * * *'],durableNamespaceId:'2'.repeat(32),migrationTag:'upload-ingress-budget-v1',secretBindings:[]},assets:Array.from({length:24},(_,i)=>({path:i===0?'index.html':i===1?'release-site-manifest.json':`asset-${i}.js`,bytes:5,sha256:maintenanceHash('bytes')}))};
 const state={active:old,cron:['* * * * *'],otherWriter:false,secret:false,extraBinding:false,duplicate:false,schema:rows,pageInfo:false,badAsset:false,unhealthy:false};let calls=[];const spawns=[];const token='synthetic-not-a-real-credential';
 const candidateBindings=()=>[{type:'assets',name:'ASSETS'},{type:'plain_text',name:'MAINTENANCE_PLAN_DIGEST',text:identityDigest(plan)},...(state.extraBinding?[{type:'d1',name:'FORBIDDEN',id:old}]:[])];
 const fetcher=async(url,options)=>{
  calls.push({url,method:options.method??'GET',body:options.body??null});
  if(!url.startsWith('https://api.cloudflare.com/')){const u=new URL(url);if(u.pathname==='/api/health'||u.pathname==='/api/v1/admin/status'){const r=state.active===next?new Response('{"error":{"code":"MAINTENANCE_ACTIVE"}}',{status:503,headers:{'retry-after':'300'}}):Response.json({status:state.unhealthy?'unhealthy':'ok',deployment:{sourceCommit:plan.predecessor.sourceCommit}},{headers:{'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'}});Object.defineProperty(r,'url',{value:url});return r;}return new Response(state.badAsset?'wrong':'bytes');}
  assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,`Bearer ${token}`);
  const p=new URL(url).pathname;let result;
  if(p.endsWith('/workers/scripts'))result=[{id:plan.workerName},...(state.otherWriter?[{id:'other-worker'}]:[])];
  else if(p.endsWith('/deployments'))result={deployments:[{versions:[{version_id:state.active,percentage:100}]}]};
  else if(p.endsWith('/versions'))result={items:[{id:next,annotations:{'workers/tag':'maintenance-'+op}},...(state.duplicate?[{id:old,annotations:{'workers/tag':'maintenance-'+op}}]:[])]};
  else if(p.includes('/versions/')){const id=p.split('/').at(-1);result={id,annotations:id===next?{'workers/tag':'maintenance-'+op}:{},resources:{bindings:id===next?candidateBindings():oldBindings}};}
  else if(p.endsWith('/settings'))result={bindings:state.active===next?candidateBindings():oldBindings};
  else if(p.endsWith('/subdomain'))result={enabled:false,previews_enabled:false};
  else if(p.endsWith('/routes'))result=[];
  else if(p.endsWith('/records'))result=['synthetic.example','www.synthetic.example','admin.synthetic.example'].map(hostname=>({hostname}));
  else if(p.endsWith('/namespaces'))result=[{id:plan.predecessor.durableNamespaceId,class:'UploadIngressBudget',script:plan.workerName}];
  else if(p.endsWith('/queues'))result=[];
  else if(p.endsWith('/schedules'))result={schedules:state.cron.map(cron=>({cron}))};
  else if(p.endsWith('/query')){assert.equal(JSON.parse(options.body).sql,MAINTENANCE_SCHEMA_QUERY);result=[{success:true,results:state.schema}];}
  else throw Error('unexpected request '+p);
  return Response.json({success:true,result,...(state.pageInfo?{result_info:{total_pages:2}}:{})});
 };
 const options={plan,packageDirectory:root,operationDirectory:root,operationId:op,cliPath,fetcher,environment:{PATH:'/usr/bin',HOME:root,CLOUDFLARE_API_TOKEN:token},spawn:(cmd,args,opts)=>{spawns.push({cmd,args,opts});return {status:0,stdout:'synthetic output',stderr:''};}};
 return {root,plan,state,calls,spawns,options,token,provider:await createMaintenanceProvider(options)};
}
test('exact predecessor inventory, 24 static bytes and fixed read-only restore schema are checked',async t=>{const f=await fixture(t);await f.provider.assertPredecessor();await f.provider.assertRestoreSafe();assert.equal(f.calls.filter(x=>x.method==='POST').length,1);assert.ok(f.calls.every(x=>x.method==='GET'||x.url.endsWith('/query')));});
test('extra writer, partial inventory and asset mismatch fail before mutation',async t=>{const f=await fixture(t);f.state.otherWriter=true;await assert.rejects(f.provider.assertPredecessor(),{code:'PRODUCTION_MAINTENANCE_OTHER_WRITER'});f.state.otherWriter=false;f.state.pageInfo=true;await assert.rejects(f.provider.assertPredecessor(),{code:'PRODUCTION_MAINTENANCE_INVENTORY_UNBOUNDED'});f.state.pageInfo=false;f.state.badAsset=true;await assert.rejects(f.provider.assertPredecessor(),{code:'PRODUCTION_MAINTENANCE_PUBLIC_ASSETS_CHANGED'});assert.equal(f.spawns.length,0);});
test('unique operation-tag recovery requires exact marker/no-D1 bindings; duplicate or modified versions refuse',async t=>{const f=await fixture(t);assert.deepEqual(await f.provider.reconcile('upload',null),{matched:true,versionId:next});f.state.duplicate=true;await assert.rejects(f.provider.reconcile('upload',null),{code:'PRODUCTION_MAINTENANCE_UPLOAD_UNCERTAIN'});f.state.duplicate=false;f.state.extraBinding=true;await assert.rejects(f.provider.reconcile('upload',null),{code:'PRODUCTION_MAINTENANCE_CANDIDATE_CHANGED'});assert.equal(f.spawns.length,0);});
test('contained proof uses exact candidate/traffic/empty cron/assets/503; source freeze refuses restore',async t=>{const f=await fixture(t);f.state.active=next;f.state.cron=[];await f.provider.verifyContained(next);f.state.schema=[...f.state.schema,{type:'table',name:'_authority_snapshot',tbl_name:'_authority_snapshot',sql:'CREATE TABLE _authority_snapshot(id)'}];await assert.rejects(f.provider.assertRestoreSafe(),{code:'PRODUCTION_MAINTENANCE_RESTORE_SCHEMA_CHANGED'});});
test('dry build has no credentials; closed commands pin CLI and record only hashes, including uncertain failure',async t=>{const f=await fixture(t);await f.provider.dryRun();assert.equal(f.spawns[0].opts.env.CLOUDFLARE_API_TOKEN,undefined);assert.ok(f.spawns[0].args.includes('--dry-run'));await f.provider.mutate('activate',next);assert.ok(f.spawns[1].args.includes(next+'@100%'));assert.equal(f.spawns[1].opts.timeout,60000);const provider=await createMaintenanceProvider({...f.options,spawn:()=>({status:null,error:{code:'ETIMEDOUT'},stdout:f.token,stderr:f.token})});await assert.rejects(provider.mutate('upload',null),{code:'PRODUCTION_MAINTENANCE_COMMAND_UNCERTAIN'});for(const name of await readdir(f.root))if(name.startsWith('provider-'))assert.equal((await readFile(join(f.root,name),'utf8')).includes(f.token),false);await writeFile(f.options.cliPath,'changed');await assert.rejects(f.provider.dryRun());});
test('API override, missing token and provider failures cannot select an alternate endpoint or launch a mutation',async t=>{const f=await fixture(t);await assert.rejects(createMaintenanceProvider({...f.options,environment:{...f.options.environment,CLOUDFLARE_API_BASE_URL:'https://foreign.example'}}),{code:'PRODUCTION_MAINTENANCE_ENVIRONMENT_OVERRIDE'});const missing=await createMaintenanceProvider({...f.options,environment:{}});await assert.rejects(missing.assertPredecessor(),{code:'PRODUCTION_MAINTENANCE_CREDENTIAL_REQUIRED'});assert.equal(f.spawns.length,0);});
test('same-source unhealthy200 cannot qualify restoration or predecessor admission',async t=>{const f=await fixture(t);f.state.unhealthy=true;await assert.rejects(f.provider.assertPredecessor(),{code:'PRODUCTION_MAINTENANCE_RESTORE_UNVERIFIED'});assert.equal(f.spawns.length,0);});
