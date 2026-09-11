/** Explicit, single disposable SQL qualification. No creation, import or retries. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { QUALIFICATION_NAME } from './prepare-bounded-migration-qualification.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sha=v=>createHash('sha256').update(v).digest('hex');
const canonical=value=>JSON.stringify(normalize(value));
function normalize(value){if(Array.isArray(value))return value.map(normalize);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,normalize(k==='metadata'&&typeof value[k]==='string'?JSON.parse(value[k]):value[k])]));return value;}
const fail=code=>{throw new Error('BOUNDED_QUALIFICATION_'+code)};
const check=(v,c)=>{if(!v)fail(c)};
export const EXECUTION_CONFIRMATION='EXECUTE_AND_DELETE_ONE_NEW_BOUNDED_D1';
export async function runBoundedQualification({manifestPath,expectedManifestSha256,databaseId,confirmation=null,spawn=spawnSync}={}){
 check(typeof manifestPath==='string'&&/^[a-f0-9]{64}$/.test(expectedManifestSha256),'MANIFEST_REQUIRED');
 const bytes=await readFile(manifestPath);check(sha(bytes)===expectedManifestSha256,'MANIFEST_HASH');const manifest=JSON.parse(bytes);
 check(manifest.schemaVersion==='bounded-migration-qualification-v1'&&manifest.databaseName===QUALIFICATION_NAME&&manifest.hostedExecuted===false&&manifest.localOnlyPassed===true,'MANIFEST_INVALID');
 const directory=await realpath(dirname(manifestPath));
 check(Array.isArray(manifest.steps)&&manifest.steps.length>59&&manifest.steps.length<=128,'STEP_COUNT');
 for(const entry of manifest.code)check(sha(await readFile(join(root,entry.file)))===entry.sha256,'CODE_DRIFT');
 for(const entry of manifest.migrations)check(sha(await readFile(join(directory,'canonical',entry.name)))===entry.sha256,'CANONICAL_DRIFT');
 const queries=[];
 for(const [i,step] of manifest.steps.entries()){
  check(step.file===`sql/${String(i).padStart(3,'0')}.sql`,'SQL_PATH');const sql=await readFile(join(directory,step.file),'utf8');
  check(sha(sql)===step.sqlSha256&&Buffer.byteLength(sql)===step.sqlBytes&&step.sqlBytes<=120*1024,'SQL_DRIFT');queries.push(sql);
 }
 if(confirmation===null)return {mode:'plan-only',databaseName:QUALIFICATION_NAME,manifestSha256:expectedManifestSha256,steps:queries.length,remoteCalls:0};
 check(confirmation===EXECUTION_CONFIRMATION,'CONFIRMATION_REQUIRED');
 check(manifest.codeCommitted===true&&manifest.code.every(c=>c.matchesCommit===true)&&manifest.canonicalCommitted===true&&manifest.migrations.every(m=>m.matchesCommit===true),'COMMITTED_SOURCE_REQUIRED');
 check(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(databaseId),'DATABASE_ID');
 // Refuse every configured production/staging/local identifier before any command.
 for(const name of (await readdir(root)).filter(n=>/^wrangler(?:\.[a-z0-9-]+)?\.jsonc$/.test(n))){
  const errors=[],config=parse(await readFile(join(root,name),'utf8'),errors);check(!errors.length,'CONFIG_INVALID');
  const bindings=[config,...Object.values(config.env??{})].flatMap(c=>c.d1_databases??[]);
  check(!bindings.some(b=>[b.database_id,b.preview_database_id].includes(databaseId)||b.database_name===QUALIFICATION_NAME),'PROTECTED_TARGET');
 }
 const version=JSON.parse(await readFile(join(root,'node_modules/wrangler/package.json'),'utf8')).version;check(version==='4.114.0','WRANGLER_VERSION');
 const execution=join(directory,'execution');await mkdir(execution,{mode:0o700});
 const configPath=join(execution,'wrangler.json');await writeFile(configPath,JSON.stringify({name:'bounded-migration-qualification',compatibility_date:'2026-09-01',d1_databases:[{binding:'QUALIFICATION_DB',database_id:databaseId,database_name:QUALIFICATION_NAME}]}),{mode:0o600,flag:'wx'});
 const cli=join(root,'node_modules/.bin/wrangler'),started=performance.now();
 const receipt={schemaVersion:'bounded-migration-qualification-result-v1',manifestSha256:expectedManifestSha256,databaseId,databaseName:QUALIFICATION_NAME,ok:false,sqlQualified:false,deleted:false,cleanup:{status:'not_started'},steps:[],proofBoundary:manifest.proofBoundary};
 let invocationIndex=0;
 const persist=()=>writeFile(join(execution,'progress.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
 function category(result){
  if(result.error?.code==='ETIMEDOUT')return 'timeout';if(result.error?.code==='ENOBUFS')return 'capture_limit';if(result.error)return 'process_error';
  const text=String(result.stdout)+String(result.stderr);
  if(/check constraint failed/i.test(text))return 'check_constraint';if(/ACCOUNTLESS_MIGRATION_MUTATION_BARRIER/i.test(text))return 'mutation_barrier';
  if(/7429|CPU time limit/i.test(text))return 'd1_cpu_limit';if(/authentication|not authenticated|unauthorized/i.test(text))return 'authentication';
  return result.status===0?'success':'unknown_failure';
 }
 async function invoke(args,operation){
  const remaining=600000-(performance.now()-started);check(remaining>0,'DEADLINE');
  const number=invocationIndex++,stem=`invocation-${String(number).padStart(3,'0')}`;
  receipt.operation={...operation,invocation:number,requestFile:`${stem}-request.json`};
  await writeFile(join(execution,receipt.operation.requestFile),JSON.stringify(receipt.operation,null,2)+'\n',{mode:0o600,flag:'wx'});
  await persist();const start=performance.now();
  let result;try{result=spawn(cli,[...args,'--config',configPath],{cwd:root,encoding:'utf8',timeout:Math.min(45000,remaining),maxBuffer:2*1024*1024,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'}});}catch{result={status:null,error:{code:'SPAWN_THROW'},stdout:'',stderr:''};}
  const durationMs=Math.ceil(performance.now()-start);
  let stdout=String(result.stdout??'');const stderr=String(result.stderr??'');
  // The absence query returns account metadata. Retain only the exact-target
  // projection, never other database names/identifiers from the listing.
  if(operation.kind==='cleanup_absence'&&result.status===0&&!result.error){try{const list=JSON.parse(stdout);stdout=JSON.stringify({projectionOnly:true,completeArray:Array.isArray(list),count:Array.isArray(list)?list.length:null,exactIdPresent:Array.isArray(list)?list.some(r=>r.uuid===databaseId):null,exactNamePresent:Array.isArray(list)?list.some(r=>r.name===QUALIFICATION_NAME):null});}catch{stdout='{"projectionOnly":true,"parseFailed":true}';}}
  const captureLimit=128*1024,output={};
  for(const [stream,text] of [['stdout',stdout],['stderr',stderr]]){const data=Buffer.from(text);const retained=data.subarray(0,captureLimit),file=`${stem}-${stream}.txt`;await writeFile(join(execution,file),retained,{mode:0o600,flag:'wx'});output[stream]={file,bytes:data.length,retainedBytes:retained.length,truncated:data.length>captureLimit,sha256:sha(retained)};}
  receipt.operation={...receipt.operation,status:Number.isInteger(result.status)?result.status:null,signal:['SIGTERM','SIGKILL','SIGABRT'].includes(result.signal)?result.signal:result.signal?'other':null,errorCategory:category(result),durationMs,...output};
  await writeFile(join(execution,`${stem}-result.json`),JSON.stringify(receipt.operation,null,2)+'\n',{mode:0o600,flag:'wx'});await persist();
  return {result,durationMs};
 }
 function jsonSuccess(result){check(!result.error&&result.status===0,'REMOTE_CALL_FAILED');try{return JSON.parse(result.stdout)}catch{fail('REMOTE_JSON_INVALID')}}
 function query(sql,operation){return invoke(['d1','execute','QUALIFICATION_DB','--remote',`--command=${sql}`,'--json'],{...operation,querySha256:sha(sql)});}
 function rows(result){const value=jsonSuccess(result);check(Array.isArray(value)&&value.length===1&&value[0].success===true&&Array.isArray(value[0].results),'READBACK_INVALID');return value[0].results;}
 try{
  const info=jsonSuccess((await invoke(['d1','info','QUALIFICATION_DB','--json'],{kind:'target_identity'})).result);
  check(info.uuid===databaseId&&info.name===QUALIFICATION_NAME,'TARGET_IDENTITY');
  const fresh=rows((await query("SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%';",{kind:'freshness'})).result);check(fresh.length===1&&fresh[0].n===0,'TARGET_NOT_FRESH');
  for(const [i,step] of manifest.steps.entries()){
   receipt.activeStep={index:i,name:step.name,sqlSha256:step.sqlSha256,expectedFailure:step.expectedFailure,expectedError:step.expectedError,readbackSha256:sha(step.readback)};
   const {result,durationMs}=await query(queries[i],{kind:'step_write',stepIndex:i,stepName:step.name});let reportedD1DurationMs=null;
   if(step.expectedFailure){check(!result.error&&result.status!==0&&typeof step.expectedError==='string'&&(step.expectedError==='CHECK_CONSTRAINT'?/check constraint failed/i.test(String(result.stdout)+String(result.stderr)):(String(result.stdout)+String(result.stderr)).toLowerCase().includes(step.expectedError.toLowerCase())),'EXPECTED_SQL_REJECTION_MISSING');}
   else {const response=jsonSuccess(result);check(Array.isArray(response)&&response.length>0&&response.every(r=>r.success===true),'SQL_RESULT_INVALID');if(response.every(r=>Number.isFinite(r.meta?.duration)&&r.meta.duration>=0))reportedD1DurationMs=response.reduce((sum,r)=>sum+r.meta.duration,0);}
   const {result:readback,durationMs:readbackMs}=await query(step.readback,{kind:'step_readback',stepIndex:i,stepName:step.name}),actual=rows(readback);
   receipt.readback={matched:canonical(actual)===canonical(step.expectedRows),expectedSha256:sha(canonical(step.expectedRows)),actualSha256:sha(canonical(actual)),expectedRowCount:step.expectedRows.length,actualRowCount:actual.length};
   check(receipt.readback.matched,'READBACK_MISMATCH');
   receipt.steps.push({name:step.name,sqlSha256:step.sqlSha256,durationMs,readbackMs,reportedD1DurationMs,expectedFailure:step.expectedFailure,readbackMatched:true});
   delete receipt.activeStep;delete receipt.readback;await persist();
  }
  receipt.sqlQualified=true;receipt.cleanup.status='checking_identity';
  const infoAgain=jsonSuccess((await invoke(['d1','info','QUALIFICATION_DB','--json'],{kind:'cleanup_identity'})).result);check(infoAgain.uuid===databaseId&&infoAgain.name===QUALIFICATION_NAME,'CLEANUP_TARGET_IDENTITY');
  receipt.cleanup.status='delete_requested';
  const deletion=(await invoke(['d1','delete','QUALIFICATION_DB','--skip-confirmation'],{kind:'cleanup_delete'})).result;check(!deletion.error&&deletion.status===0,'CLEANUP_DELETE_UNKNOWN');
  receipt.cleanup.status='delete_acknowledged';
  const listed=jsonSuccess((await invoke(['d1','list','--json'],{kind:'cleanup_absence'})).result);
  check(Array.isArray(listed)&&listed.length<=10000&&listed.every(r=>typeof r.uuid==='string'&&typeof r.name==='string'),'CLEANUP_ABSENCE_INVALID');
  receipt.cleanup.exactIdPresent=listed.some(r=>r.uuid===databaseId);receipt.cleanup.exactNamePresent=listed.some(r=>r.name===QUALIFICATION_NAME);
  if(receipt.cleanup.exactIdPresent||receipt.cleanup.exactNamePresent){receipt.cleanup.status='still_present';fail('CLEANUP_STILL_PRESENT');}
  receipt.cleanup.status='absence_confirmed';receipt.deleted=true;receipt.ok=true;
 }catch(error){
  receipt.failureCode=String(error.message).startsWith('BOUNDED_QUALIFICATION_')?error.message:'BOUNDED_QUALIFICATION_EXECUTION_FAILED';
  receipt.failureStage=receipt.sqlQualified?'cleanup':receipt.activeStep?'qualification':'admission';
  if(receipt.activeStep)receipt.failedStep={...receipt.activeStep,operation:receipt.operation,...(receipt.readback?{readback:receipt.readback}:{})};
  if(receipt.sqlQualified&&receipt.cleanup.status!=='still_present')receipt.cleanup.status='unknown';
 }
 finally{receipt.durationMs=Math.ceil(performance.now()-started);await writeFile(join(execution,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});}

 return receipt;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),allowed=new Set(['--manifest','--sha256','--database-id','--confirm']);const values={};
 check(args.length%2===0,'ARGUMENTS');for(let i=0;i<args.length;i+=2){check(allowed.has(args[i])&&!Object.hasOwn(values,args[i]),'ARGUMENTS');values[args[i]]=args[i+1];}
 runBoundedQualification({manifestPath:values['--manifest'],expectedManifestSha256:values['--sha256'],databaseId:values['--database-id'],confirmation:values['--confirm']??null}).then(r=>{console.log(JSON.stringify({mode:r.mode??'execution',ok:r.ok??null,deleted:r.deleted??false,steps:r.steps?.length??r.steps,failureCode:r.failureCode??null}));if(r.ok===false)process.exitCode=1;}).catch(()=>{console.error('BOUNDED_QUALIFICATION_REFUSED');process.exitCode=1;});
}
