import { Agent } from 'node:http';
import { request as httpRequest } from 'node:http';
const agents=new WeakMap();
export async function closeSyntheticD1Bindings(miniflare){const value=agents.get(miniflare);if(value){value.destroy();agents.delete(miniflare);}}
/** Synthetic loopback rehearsal transport only. Each batch is one genuine D1
 * batch in workerd, never split or rewritten as SQL text. The production
 * migration worker uses direct bindings and has no HTTP execution route. */
export const SYNTHETIC_D1_WORKER=`
export default {async fetch(request,env){
 if(request.method!=='POST'||new URL(request.url).pathname!=='/synthetic-d1')return new Response('Not found',{status:404});
 try{
 const body=await request.json();
 if(body.binding==='QUARANTINE'&&body.method==='delete'){
  if(!Array.isArray(body.keys)||body.keys.length>1000||body.keys.some(k=>typeof k!=='string'||k.length>512||!(k.startsWith('synthetic/')||k.startsWith('telemetry/v11-test-'))))throw new Error('invalid');
  await env.QUARANTINE.delete(body.keys);return Response.json({ok:true});
 }
 if(!['SOURCE','TARGET','REFERENCE','BASE','ANALYTICS','LEDGER'].includes(body.binding)||!['batch','all','run','first','raw'].includes(body.method)
  ||!Array.isArray(body.statements)||body.statements.length<1||body.statements.length>900)throw new Error('invalid');
 const statements=body.statements.map(s=>{
  if(typeof s.sql!=='string'||!Array.isArray(s.values))throw new Error('invalid');
  const values=s.values.map(v=>v&&typeof v==='object'&&Array.isArray(v.blob)?new Uint8Array(v.blob):v);
  return env[body.binding].prepare(s.sql).bind(...values);
 });
 if(body.method!=='batch'&&statements.length!==1)throw new Error('invalid');
 const value=body.method==='batch'?await env[body.binding].batch(statements):await statements[0][body.method](...(body.args??[]));
 return Response.json({ok:true,value});
 }catch{return Response.json({ok:false},{status:409})}
}};`;
export function syntheticD1Binding(miniflare,binding){
 if(!['SOURCE','TARGET','REFERENCE','BASE','ANALYTICS','LEDGER'].includes(binding))throw new Error('SYNTHETIC_D1_BINDING_INVALID');
 const request=async(method,statements,args=[])=>{
  const url=new URL('/synthetic-d1',await miniflare.ready);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('SYNTHETIC_D1_ORIGIN_INVALID');
  let agent=agents.get(miniflare);if(!agent){agent=new Agent({keepAlive:true,maxSockets:1});agents.set(miniflare,agent);}
  const body=JSON.stringify({binding,method,statements,args});
  if(Buffer.byteLength(body)>8*1024*1024)throw new Error('SYNTHETIC_D1_REQUEST_LIMIT');
  const {status,bytes}=await new Promise((resolve,reject)=>{const req=httpRequest(url,{method:'POST',agent,headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
   const chunks=[];let length=0;res.on('data',chunk=>{length+=chunk.length;if(length>4*1024*1024){res.destroy(new Error('SYNTHETIC_D1_RESPONSE_LIMIT'));return;}chunks.push(chunk);});
   res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,bytes:Buffer.concat(chunks)}));});
   req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('SYNTHETIC_D1_TIMEOUT')));req.end(body);});
  const result=JSON.parse(bytes.toString('utf8'));if(status!==200||result.ok!==true)throw new Error('SYNTHETIC_D1_OPERATION_FAILED');return result.value;
 };
 const encode=v=>v instanceof ArrayBuffer?{blob:Array.from(new Uint8Array(v))}:ArrayBuffer.isView(v)?{blob:Array.from(new Uint8Array(v.buffer,v.byteOffset,v.byteLength))}:v;
 const prepare=(sql,values=[])=>({
  bind(...next){return prepare(sql,next.map(encode));},
  all(){return request('all',[{sql,values}]);},run(){return request('run',[{sql,values}]);},
  first(column){return request('first',[{sql,values}],column===undefined?[]:[column]);},
  raw(options){return request('raw',[{sql,values}],options===undefined?[]:[options]);},
  _syntheticStatement:{sql,values,binding},
 });
 return {prepare,batch(statements){
  const values=statements.map(s=>{if(s?._syntheticStatement?.binding!==binding)throw new Error('SYNTHETIC_D1_STATEMENT_INVALID');
   const {sql,values}=s._syntheticStatement;return {sql,values};});return request('batch',values);
 }};
}

export function syntheticRestoreQuarantine(miniflare){return {async delete(keys){
 const values=Array.isArray(keys)?keys:[keys];
 if(values.some(k=>typeof k!=='string'||!(k.startsWith('synthetic/')||k.startsWith('telemetry/v11-test-'))))throw new Error('SYNTHETIC_R2_KEY_INVALID');
 const result=await miniflare.dispatchFetch(new URL('/synthetic-d1',await miniflare.ready),{method:'POST',body:JSON.stringify({binding:'QUARANTINE',method:'delete',keys:values})});
 if(result.status!==200||(await result.json()).ok!==true)throw new Error('SYNTHETIC_R2_DELETE_FAILED');
 }};}
