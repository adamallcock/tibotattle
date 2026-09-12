import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import validation from './wrangler-query-preload.cjs';
import { operationError } from '../../../scripts/lib/release-operation.mjs';
const fail=code=>{throw operationError(`PRODUCTION_MAINTENANCE_${code}`);};
const hash=value=>createHash('sha256').update(value).digest('hex');
/** Internal bounded transport. Closed operation providers own target admission,
 * SQL allowlists and mutation selection; this module owns no release state. */
export function createMaintenanceTransport({plan,operationDirectory,cliPath,fetcher=fetch,spawn=spawnSync,environment=process.env}) {
  if (['CLOUDFLARE_API_BASE_URL','CF_API_BASE_URL','WRANGLER_API_ENVIRONMENT','CLOUDFLARE_ENV','NODE_OPTIONS'].some(k=>Object.hasOwn(environment,k))) fail('ENVIRONMENT_OVERRIDE');
  const cli=validation.verifyCli(cliPath,plan.wranglerSha256);
  // Capture once; no OAuth discovery, Keychain access, or secret in any receipt.
  const token=environment.CLOUDFLARE_API_TOKEN;
  const account=`/accounts/${plan.accountId}`;
  let requests=0;
  const receipt=async(value)=>{
    const file=await open(join(operationDirectory,`provider-${randomUUID()}.json`),'wx',0o600);
    try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();}finally{await file.close();}
  };
  const responseBytes=async response=>{
    if(!response.body) return Buffer.alloc(0);
    const reader=response.body.getReader();let size=0;const parts=[];
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2_000_000)fail('RESPONSE_TOO_LARGE');parts.push(value);}}finally{await reader.cancel().catch(()=>{});}
    return Buffer.concat(parts);
  };
  const api=async(path,body,{mutation=false}={})=>{
    if(typeof mutation!=='boolean'||mutation&&!body)fail('REQUEST_INVALID');
    if(typeof token!=='string'||token.length<16)fail('CREDENTIAL_REQUIRED');
    if(++requests>600||!path.startsWith(account+'/'))fail('READ_BUDGET');
    let response,bytes;
    try{response=await fetcher('https://api.cloudflare.com/client/v4'+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(20000)});bytes=await responseBytes(response);}catch{fail(mutation?'MUTATION_UNCERTAIN':'READ_UNCERTAIN');}
    await receipt({kind:'provider-read',method:body?(mutation?'POST_WRITE_QUERY':'POST_READ_QUERY'):'GET',pathSha256:hash(path),status:response.status,bytes:bytes.length,sha256:hash(bytes)});
    let json;try{json=JSON.parse(bytes);}catch{fail('RESPONSE_INVALID');}
    if(!response.ok||json.success!==true)fail('READ_REFUSED');
    if(json.result_info?.total_pages>1||json.result_info?.has_more===true||json.result_info?.cursor||Number.isSafeInteger(json.result_info?.total_count)&&Number.isSafeInteger(json.result_info?.count)&&json.result_info.total_count>json.result_info.count)fail('INVENTORY_UNBOUNDED');
    return json.result;
  };
  const publicRead=async url=>{let response;try{response=await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(20000),headers:{'cache-control':'no-cache'}});}catch{fail('PUBLIC_READ_FAILED');}const bytes=await responseBytes(response);return {response,bytes};};
  const run=async({step,args,config,directory,dry=false})=>{
    validation.verifyCli(cliPath,plan.wranglerSha256);
    const before=hash(await readFile(config));
    const env={PATH:environment.PATH,HOME:environment.HOME,TMPDIR:environment.TMPDIR,CI:'true',NO_COLOR:'1',CLOUDFLARE_ACCOUNT_ID:plan.accountId,WRANGLER_SEND_METRICS:'false',WRANGLER_SEND_ERROR_REPORTS:'false',WRANGLER_LOG_PATH:'/dev/null',...(dry?{}:{CLOUDFLARE_API_TOKEN:token})};
    if(!dry&&(typeof token!=='string'||token.length<16))fail('CREDENTIAL_REQUIRED');
    const r=spawn(process.execPath,[cli.canonical,...args,'--config',config],{cwd:directory,env,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
    await receipt({kind:'command',step,configSha256:before,cliSha256:cli.digest,status:r.status??null,signal:r.signal??null,errorCode:r.error?.code??null,stdoutSha256:hash(String(r.stdout??'')),stderrSha256:hash(String(r.stderr??''))});
    validation.verifyCli(cliPath,plan.wranglerSha256);
    if(hash(await readFile(config))!==before)fail('CONFIG_CHANGED');
    if(r.error||r.status!==0)fail('COMMAND_UNCERTAIN');
    return {};
  };
  return {api,receipt,publicRead,run};
}
