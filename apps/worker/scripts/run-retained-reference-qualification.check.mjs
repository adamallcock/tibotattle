import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,readdir} from 'node:fs/promises';import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';import {parse} from 'jsonc-parser';import {tmpdir} from 'node:os';import {join,resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {runRetainedReferenceQualification,EXECUTION_CONFIRMATION} from './run-retained-reference-qualification.mjs';
import {RETAINED_QUALIFICATION_NAME,RETAINED_QUALIFICATION_CODE_FILES} from './prepare-retained-reference-qualification.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),sha=v=>createHash('sha256').update(v).digest('hex'),databaseId='11111111-2222-4333-8444-555555555555';
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'retained-runner-test-'));await mkdir(join(directory,'sql'),{mode:0o700});await mkdir(join(directory,'canonical'),{mode:0o700});
 const code=await Promise.all(RETAINED_QUALIFICATION_CODE_FILES.map(async file=>({file,sha256:sha(await readFile(join(root,file))),matchesCommit:true})));
 const migrations=[];for(const name of (await readdir(join(root,'migrations'))).sort()){const bytes=await readFile(join(root,'migrations',name));await writeFile(join(directory,'canonical',name),bytes,{mode:0o600});migrations.push({name,sha256:sha(bytes),matchesCommit:true});}
 const steps=[];for(let i=0;i<60;i++){const sql=`-- synthetic step ${i}\nSELECT 1 AS value;`,file=`sql/${String(i).padStart(3,'0')}.sql`;await writeFile(join(directory,file),sql,{mode:0o600});steps.push({name:`synthetic-${i}`,file,sqlSha256:sha(sql),sqlBytes:Buffer.byteLength(sql),readback:'SELECT 1 AS value;',expectedRows:[{value:1}],expectedFailure:i===5,expectedError:i===5?'CHECK_CONSTRAINT':null});}
 // Deliberately synthetic protocol fixture: every execution uses the fake process below.
 const manifest={schemaVersion:'retained-reference-qualification-v1',mode:'plan-only',productionReady:false,databaseName:RETAINED_QUALIFICATION_NAME,sourceRevision:'a'.repeat(40),code,codeCommitted:true,migrations,canonicalCommitted:true,steps,hostedExecuted:false,localOnlyPassed:true,limits:{maxQueryBytes:262144,maxSteps:256,queryTimeoutMs:45000,totalTimeoutMs:600000}};
 const manifestPath=join(directory,'manifest.json');async function save(){const bytes=JSON.stringify(manifest);await writeFile(manifestPath,bytes,{mode:0o600});return {manifestPath,expectedManifestSha256:sha(bytes),databaseId};}return {directory,manifest,save};
}
function fake({badIdentity=false,notFresh=false,failStep=null,rawFailure=false,stillPresent=false}={}){
 const calls=[];const okay=value=>({status:0,stdout:JSON.stringify(value),stderr:''}),rows=value=>okay([{success:true,results:value,meta:{duration:1}}]);
 return {calls,spawn:(command,args,options)=>{
  calls.push(args);assert.equal(command,process.execPath);assert.ok(options.timeout>0&&options.timeout<=45000);assert.equal(options.maxBuffer,262144);assert.equal(options.killSignal,'SIGKILL');
  if(args.includes('info'))return okay({uuid:badIdentity?'00000000-0000-4000-8000-000000000001':databaseId,name:RETAINED_QUALIFICATION_NAME});
  if(args.includes('delete'))return {status:0,stdout:'Deleted synthetic database',stderr:''};
  if(args.includes('list'))return okay(stillPresent?[{uuid:databaseId,name:RETAINED_QUALIFICATION_NAME}]:[]);
  assert.ok(args.includes('--command=__TIBOTATTLE_FROZEN_QUERY__'));assert.ok(!args.some(a=>a.startsWith('--file')));
  const queryArg=args.find(a=>a.startsWith('--tibo-query-path='));assert.ok(queryArg);const sql=readFileSync(queryArg.slice('--tibo-query-path='.length),'utf8');assert.ok(!args.includes('--command='+sql));
  if(sql.includes('sqlite_master'))return rows([{n:notFresh?1:0}]);
  const step=/^-- synthetic step (\d+)/.exec(sql)?.[1];
  if(step==='5')return {status:1,stdout:rawFailure?'':JSON.stringify({error:{text:'D1 request failed',notes:[{text:'CHECK constraint failed: synthetic_guard'}]}}),stderr:rawFailure?'CHECK constraint failed: not structured':''};
  if(step!==undefined&&Number(step)===failStep)return {status:null,error:{code:'ETIMEDOUT'},stdout:'',stderr:''};
  return rows([{value:1}]);
 }};
}

test('default plan has zero calls and refuses changed bundle bytes and incomplete provenance',async()=>{
 const f=await fixture();try {let calls=0;const args=await f.save();const result=await runRetainedReferenceQualification({...args,spawn:()=>{calls++;throw Error('must not run')}});assert.equal(result.mode,'plan-only');assert.equal(calls,0);
  await assert.rejects(runRetainedReferenceQualification({...args,expectedManifestSha256:'b'.repeat(64)}),/MANIFEST_HASH/);
  const queryPath=join(f.directory,'sql/000.sql'),original=await readFile(queryPath);await writeFile(queryPath,'SELECT 2;');await assert.rejects(runRetainedReferenceQualification(args),/SQL_DRIFT/);await writeFile(queryPath,original);
  const protectedId=parse(await readFile(join(root,'wrangler.jsonc'),'utf8')).d1_databases[0].database_id;
  await assert.rejects(runRetainedReferenceQualification({...args,databaseId:protectedId,confirmation:EXECUTION_CONFIRMATION,spawn:()=>{calls++;}}),/PROTECTED_TARGET/);assert.equal(calls,0);
  f.manifest.code.pop();await assert.rejects(runRetainedReferenceQualification({...await f.save()}),/CODE_SET/);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
test('frozen synthetic protocol runs once, verifies expected rollback readback and confirms deletion absence',async()=>{
 const f=await fixture(),process=fake();try {const receipt=await runRetainedReferenceQualification({...await f.save(),confirmation:EXECUTION_CONFIRMATION,spawn:process.spawn});assert.equal(receipt.ok,true);assert.equal(receipt.sqlQualified,true);assert.equal(receipt.deleted,true);assert.equal(receipt.steps.length,60);assert.equal(receipt.cleanup.status,'absence_confirmed');assert.equal(process.calls.filter(a=>a.includes('delete')).length,1);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
test('target mismatch and nonfresh schema refuse writes and deletion',async()=>{
 for(const options of [{badIdentity:true},{notFresh:true}]){const f=await fixture(),process=fake(options);try{const receipt=await runRetainedReferenceQualification({...await f.save(),confirmation:EXECUTION_CONFIRMATION,spawn:process.spawn});assert.equal(receipt.ok,false);assert.equal(receipt.steps.length,0);assert.equal(process.calls.some(a=>a.includes('delete')),false);}finally{await rm(f.directory,{recursive:true,force:true});}}
});
test('unknown mutation result and unstructured expected-error text stop without retries or cleanup',async()=>{
 for(const options of [{failStep:0},{rawFailure:true}]){const f=await fixture(),process=fake(options);try{const receipt=await runRetainedReferenceQualification({...await f.save(),confirmation:EXECUTION_CONFIRMATION,spawn:process.spawn});assert.equal(receipt.ok,false);assert.equal(receipt.deleted,false);assert.ok(receipt.failedStep);assert.equal(process.calls.some(a=>a.includes('delete')),false);assert.ok(receipt.failedStep.operation.querySha256);const retained=await readFile(join(f.directory,'execution',`invocation-${String(receipt.failedStep.operation.invocation).padStart(3,'0')}-query.sql`),'utf8');assert.ok(retained.startsWith('-- synthetic step'));
 }finally{await rm(f.directory,{recursive:true,force:true});}}
});
test('deletion acknowledgement without exact absence is not successful cleanup',async()=>{
 const f=await fixture(),process=fake({stillPresent:true});try {const receipt=await runRetainedReferenceQualification({...await f.save(),confirmation:EXECUTION_CONFIRMATION,spawn:process.spawn});assert.equal(receipt.sqlQualified,true);assert.equal(receipt.ok,false);assert.equal(receipt.deleted,false);assert.equal(receipt.cleanup.status,'still_present');assert.equal(process.calls.filter(a=>a.includes('delete')).length,1);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
