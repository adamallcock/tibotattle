import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareBoundedQualification, QUALIFICATION_NAME } from './prepare-bounded-migration-qualification.mjs';
import { runBoundedQualification, EXECUTION_CONFIRMATION } from './run-bounded-migration-qualification.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
const id='12345678-1234-1234-1234-123456789abc';
async function fixture(run){const dir=await mkdtemp(join(tmpdir(),'bounded-qualification-'));try{const outputDirectory=join(dir,'bundle');const result=await prepareBoundedQualification({outputDirectory});const manifestPath=join(outputDirectory,'manifest.json');const manifest=JSON.parse(await readFile(manifestPath));await run({outputDirectory,result,manifestPath,manifest});}finally{await rm(dir,{recursive:true,force:true});}}
async function syntheticCommittedManifest(manifestPath,manifest){
 // Execution tests use a simulated CLI only; no false committed-source receipt escapes.
 manifest.codeCommitted=true;manifest.code.forEach(c=>{c.matchesCommit=true});const bytes=JSON.stringify(manifest);await chmod(manifestPath,0o600);await writeFile(manifestPath,bytes);return sha(bytes);
}
function fakeCli(manifest,queries,{corruptReadback=false,absence='absent'}={}){
 let index=0,reading=false,deleted=false,calls=0;
 const success=value=>({status:0,stdout:JSON.stringify(value),stderr:''});
 const spawn=(_command,args)=>{calls++;assert.ok(!args.includes('--file'));assert.ok(!args.includes('create'));assert.ok(args.includes('--config'));
  if(args[1]==='info')return success({uuid:id,name:QUALIFICATION_NAME});
  if(args[1]==='list'){assert.equal(deleted,true);return absence==='error'?{status:1,stdout:'',stderr:'synthetic network error'}:success(absence==='present'?[{uuid:id,name:QUALIFICATION_NAME}]:[{uuid:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',name:'unrelated-private-resource'}]);}
  if(args[1]==='delete'){deleted=true;return {status:0,stdout:'',stderr:''};}
  assert.equal(args[1],'execute');const sql=args[args.indexOf('--command')+1];
  if(sql.includes("name NOT LIKE '_cf_%'"))return success([{success:true,results:[{n:0}]}]);
  const step=manifest.steps[index];
  if(reading){assert.equal(sql,step.readback);reading=false;index++;return success([{success:true,results:corruptReadback?[{incorrect:true}]:step.expectedRows}]);}
  assert.equal(sql,queries[index]);reading=true;
  if(step.expectedFailure)return {status:1,stdout:'',stderr:step.expectedError==='CHECK_CONSTRAINT'?'D1_ERROR: CHECK constraint failed: ok=1':step.expectedError};
  return success([{success:true,results:[]}]);
 };
 return {spawn,get deleted(){return deleted},get calls(){return calls}};
}
test('plan executes unchanged canonical57→59 locally, retains bounded immutable SQL and makes zero remote calls',async()=>fixture(async({outputDirectory,result,manifestPath,manifest})=>{
 assert.equal(manifest.canonicalCommitted,true);assert.ok(manifest.migrations.every(m=>m.matchesCommit===true));
 assert.equal(result.localOnlyPassed,true);assert.equal(result.hostedExecuted,false);assert.ok(result.maxQueryBytes<=120*1024);
 assert.equal(manifest.migrations.length,59);assert.equal(manifest.steps.filter(s=>s.expectedFailure).length,5);
 assert.ok(manifest.steps.some(s=>s.name==='one-mib-parent-evacuated'));
 const planned=await runBoundedQualification({manifestPath,expectedManifestSha256:result.manifestSha256,spawn:()=>assert.fail('must not call')});assert.equal(planned.remoteCalls,0);
 await assert.rejects(runBoundedQualification({manifestPath,expectedManifestSha256:'f'.repeat(64)}),/MANIFEST_HASH/);
 const canonicalPath=join(outputDirectory,'canonical',manifest.migrations[0].name);await chmod(canonicalPath,0o600);await writeFile(canonicalPath,(await readFile(canonicalPath,'utf8'))+'\n-- synthetic tampering');await assert.rejects(runBoundedQualification({manifestPath,expectedManifestSha256:result.manifestSha256,spawn:()=>assert.fail('must not call')}),/CANONICAL_DRIFT/);
}));
test('explicit execution refuses dirty provenance and absent confirmation before remote access',async()=>fixture(async({result,manifestPath,manifest})=>{
 const bad={...manifest,codeCommitted:false};const bytes=JSON.stringify(bad);await chmod(manifestPath,0o600);await writeFile(manifestPath,bytes);
 await assert.rejects(runBoundedQualification({manifestPath,expectedManifestSha256:sha(bytes),databaseId:id,confirmation:EXECUTION_CONFIRMATION,spawn:()=>assert.fail('must not call')}),/COMMITTED_SOURCE_REQUIRED/);
 await assert.rejects(runBoundedQualification({manifestPath,expectedManifestSha256:sha(bytes),databaseId:id,confirmation:'wrong',spawn:()=>assert.fail('must not call')}),/CONFIRMATION_REQUIRED/);
 bad.codeCommitted=true;bad.code.forEach(c=>{c.matchesCommit=true});bad.canonicalCommitted=false;const canonicalDirty=JSON.stringify(bad);await writeFile(manifestPath,canonicalDirty);await assert.rejects(runBoundedQualification({manifestPath,expectedManifestSha256:sha(canonicalDirty),databaseId:id,confirmation:EXECUTION_CONFIRMATION,spawn:()=>assert.fail('must not call')}),/COMMITTED_SOURCE_REQUIRED/);
}));
test('simulated normal-query execution checks each readback and deletes only after every proof',async()=>fixture(async({outputDirectory,manifestPath,manifest})=>{
 const digest=await syntheticCommittedManifest(manifestPath,manifest);const queries=await Promise.all(manifest.steps.map(s=>readFile(join(outputDirectory,s.file),'utf8')));const cli=fakeCli(manifest,queries);
 const receipt=await runBoundedQualification({manifestPath,expectedManifestSha256:digest,databaseId:id,confirmation:EXECUTION_CONFIRMATION,spawn:cli.spawn});
 assert.equal(receipt.ok,true);assert.equal(receipt.deleted,true);assert.equal(cli.deleted,true);assert.equal(receipt.steps.length,manifest.steps.length);assert.equal(receipt.cleanup.status,'absence_confirmed');
 const absenceOutput=await readFile(join(outputDirectory,'execution',receipt.operation.stdout.file),'utf8');assert.equal(absenceOutput.includes('unrelated-private-resource'),false);assert.equal(JSON.parse(absenceOutput).exactIdPresent,false);assert.ok(receipt.steps.every(s=>s.readbackMatched&&s.durationMs>=0));
}));
test('readback failure retains the exact disposable target and stops without retry or deletion',async()=>fixture(async({outputDirectory,manifestPath,manifest})=>{
 const digest=await syntheticCommittedManifest(manifestPath,manifest);const queries=await Promise.all(manifest.steps.map(s=>readFile(join(outputDirectory,s.file),'utf8')));const cli=fakeCli(manifest,queries,{corruptReadback:true});
 const receipt=await runBoundedQualification({manifestPath,expectedManifestSha256:digest,databaseId:id,confirmation:EXECUTION_CONFIRMATION,spawn:cli.spawn});
 assert.equal(receipt.ok,false);assert.equal(receipt.deleted,false);assert.equal(cli.deleted,false);assert.equal(receipt.steps.length,0);assert.equal(receipt.failureCode,'BOUNDED_QUALIFICATION_READBACK_MISMATCH');assert.equal(cli.calls,4);assert.equal(receipt.failedStep.index,0);assert.equal(receipt.failedStep.sqlSha256,manifest.steps[0].sqlSha256);assert.equal(receipt.failedStep.operation.kind,'step_readback');assert.equal(receipt.failedStep.operation.status,0);assert.equal(receipt.failedStep.readback.matched,false);
 const path=join(outputDirectory,'execution',receipt.failedStep.operation.stdout.file);assert.match(await readFile(path,'utf8'),/incorrect/);assert.equal((await stat(path)).mode&0o777,0o600);
}));


test('successful delete acknowledgement still requires verified exact absence',async()=>{
 for(const absence of ['present','error'])await fixture(async({outputDirectory,manifestPath,manifest})=>{
  const digest=await syntheticCommittedManifest(manifestPath,manifest);const queries=await Promise.all(manifest.steps.map(s=>readFile(join(outputDirectory,s.file),'utf8')));const cli=fakeCli(manifest,queries,{absence});
  const receipt=await runBoundedQualification({manifestPath,expectedManifestSha256:digest,databaseId:id,confirmation:EXECUTION_CONFIRMATION,spawn:cli.spawn});
  assert.equal(receipt.sqlQualified,true);assert.equal(receipt.ok,false);assert.equal(receipt.deleted,false);assert.equal(cli.deleted,true);assert.equal(receipt.failureStage,'cleanup');assert.equal(receipt.cleanup.status,absence==='present'?'still_present':'unknown');assert.equal(receipt.operation.kind,'cleanup_absence');
 });
});
