import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMaintenanceEntry } from './production-maintenance.mjs';

test('native Worker preserves all24 assets and refuses dynamic routes plus inherited DO RPC', {timeout:30000}, async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'maintenance-native-')));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'assets'));
 const names=['index.html','release-site-manifest.json',...Array.from({length:22},(_,i)=>`asset-${i}.js`)];const contents=new Map();for(const name of names){const content=name==='index.html'?'<!doctype html><title>Synthetic</title>':name.endsWith('.json')?'{}':'// '+name;contents.set(name,content);await writeFile(join(root,'assets',name),content);}
 const plan={origin:'https://synthetic.example',assets:names.map(path=>({path}))};await writeFile(join(root,'entry.mjs'),renderMaintenanceEntry(plan));
 const mf=new Miniflare({rootPath:root,cf:false,log:new Log(LogLevel.NONE),workers:[{name:'maintenance',rootPath:root,modulesRoot:root,modules:true,scriptPath:join(root,'entry.mjs'),compatibilityDate:'2026-07-26',assets:{workerName:'maintenance',directory:join(root,'assets'),binding:'ASSETS',routerConfig:{has_user_worker:true,invoke_user_worker_ahead_of_assets:true},assetConfig:{not_found_handling:'404-page'}},durableObjects:{BUDGET:{className:'UploadIngressBudget',useSQLite:true}}},{name:'rpc-probe',modules:true,compatibilityDate:'2026-07-26',script:"export default {async fetch(request,env){const method=new URL(request.url).pathname.slice(1);try{await env.BUDGET.get(env.BUDGET.idFromName('synthetic'))[method]();return new Response('unexpected',{status:500});}catch(error){return new Response(error.message,{status:503});}}}",durableObjects:{BUDGET:{className:'UploadIngressBudget',scriptName:'maintenance',useSQLite:true}}}]});
 try{await mf.ready;for(const [name,content] of contents){const response=await mf.dispatchFetch('https://synthetic.example/'+(name==='index.html'?'':name));assert.equal(response.status,200);assert.equal(await response.text(),content);}
 for(const url of ['https://synthetic.example/api/health','https://admin.synthetic.example/api/v1/admin/action','https://foreign.example/'])for(const method of ['GET','POST']){const response=await mf.dispatchFetch(url,{method});assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'300');}
 const probe=await mf.getWorker('rpc-probe');for(const method of ['acquire','renew','probe','status','release']){const response=await probe.fetch('https://synthetic.example/'+method);assert.equal(response.status,503);assert.match(await response.text(),/MAINTENANCE_ACTIVE/);}
 }finally{await mf.dispose();}
});
