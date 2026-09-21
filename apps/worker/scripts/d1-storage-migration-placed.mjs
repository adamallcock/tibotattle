// The backend owns the complete existing claim/step/commit frame.
// Only the front owns durable Queue publication and acknowledgment.
import { createStorageMigrationWorker } from './d1-storage-migration-worker.mjs';
import { STORAGE_RESTORE_STAGES } from './d1-storage-restore-runner.mjs';
const SCHEMA='d1-storage-private-execution-v1',LIMIT=2048;
const fail=()=>{throw Error('D1_STORAGE_PRIVATE_EXECUTION_UNCERTAIN');};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join()===keys.sort().join();
function wake(value,digest){return exact(value,['schema','contractDigest','stage','steps'])&&value.schema==='d1-storage-restore-wakeup-v1'&&value.contractDigest===digest&&STORAGE_RESTORE_STAGES.includes(value.stage)&&Number.isSafeInteger(value.steps)&&value.steps>=0;}
async function boundedJson(stream){
 if(!stream)fail();const reader=stream.getReader(),pieces=[];let total=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>LIMIT){await reader.cancel();fail();}pieces.push(value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(total);let at=0;for(const piece of pieces){bytes.set(piece,at);at+=piece.byteLength;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail();}
}
const notFound=()=>new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});
export function createStorageMigrationBackend(options){
 const driver=createStorageMigrationWorker(options),digest=options.contractDigest,executionDigest=options.executionDigest;
 if(!/^[a-f0-9]{64}$/.test(executionDigest??''))fail();
 return {async fetch(request,env){
  const url=new URL(request.url);
  if(request.method!=='POST'||url.pathname!=='/private/restore'||url.search||request.headers.get('content-type')!=='application/json')return notFound();
  try{
   const body=await boundedJson(request.body);
   if(!exact(body,['schema','contractDigest','executionDigest','operation','message'])||body.schema!==SCHEMA||body.contractDigest!==digest||body.executionDigest!==executionDigest
     ||!['step','wakeup'].includes(body.operation)||(body.operation==='step'?!wake(body.message,digest):body.message!==null)
     ||env.STORAGE_RESTORE_MODE!=='enabled')fail();
   const next=[];let acknowledgements=0;
   // This captures the already-committed continuation; only the front owns the
   // real Queue producer. Failure before send is the existing lost-send case.
   const localEnv={...env,STORAGE_RESTORE_QUEUE:{async send(message){if(next.length)fail();next.push(structuredClone(message));}}};
   if(body.operation==='step')await driver.queue({messages:[{body:body.message,ack(){acknowledgements++;}}]},localEnv);
   else await driver.scheduled({},localEnv);
   if(acknowledgements!==(body.operation==='step'?1:0))fail();
   return Response.json({schema:SCHEMA,contractDigest:digest,executionDigest,request:body,next:next[0]??null},{headers:{'cache-control':'no-store'}});
  }catch{return Response.json({error:'D1_STORAGE_PRIVATE_EXECUTION_UNCERTAIN'},{status:503,headers:{'cache-control':'no-store'}});}
 }};
}
export function createStorageMigrationFront({contractDigest,executionDigest,expiresAt,clock=()=>Date.now()}){
 if(!/^[a-f0-9]{64}$/.test(executionDigest??'')||!/^[a-f0-9]{64}$/.test(contractDigest)||!Number.isSafeInteger(expiresAt))fail();
 const enabled=env=>{if(env.STORAGE_RESTORE_MODE===undefined||env.STORAGE_RESTORE_MODE==='disabled')return false;
  if(env.STORAGE_RESTORE_MODE!=='enabled'||clock()>=expiresAt||typeof env.STORAGE_RESTORE_EXECUTOR?.fetch!=='function'||typeof env.STORAGE_RESTORE_QUEUE?.send!=='function')fail();return true;};
 async function invoke(env,operation,message){
  const request={schema:SCHEMA,contractDigest,executionDigest,operation,message};
  const response=await env.STORAGE_RESTORE_EXECUTOR.fetch(new Request('https://private.invalid/private/restore',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)}));
  if(response.status!==200||!response.headers.get('content-type')?.startsWith('application/json'))fail();
  const result=await boundedJson(response.body);
  if(!exact(result,['schema','contractDigest','executionDigest','request','next'])||result.schema!==SCHEMA||result.contractDigest!==contractDigest||result.executionDigest!==executionDigest||JSON.stringify(result.request)!==JSON.stringify(request)
    ||result.next!==null&&!wake(result.next,contractDigest))fail();
  if(operation==='step'&&result.next!==null&&(result.next.steps!==message.steps+1||![message.stage,STORAGE_RESTORE_STAGES[STORAGE_RESTORE_STAGES.indexOf(message.stage)+1]].includes(result.next.stage)))fail();
  if(result.next!==null){if(clock()>=expiresAt)fail();await env.STORAGE_RESTORE_QUEUE.send(result.next);}
 }
 return {fetch:notFound,async scheduled(_controller,env){if(enabled(env))await invoke(env,'wakeup',null);},async queue(batch,env){
  if(!enabled(env))return;
  if(!Array.isArray(batch?.messages)||batch.messages.length!==1)fail();const message=batch.messages[0];
  if(typeof message.ack!=='function'||!wake(message.body,contractDigest))fail();
  await invoke(env,'step',structuredClone(message.body));message.ack();
 }};
}
