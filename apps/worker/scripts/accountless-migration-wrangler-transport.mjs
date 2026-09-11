/** Pinned, injected-process adapter. Construction never calls Wrangler or authenticates. */
import {mkdirSync,writeFileSync,unlinkSync,realpathSync,statSync,lstatSync,openSync,fstatSync,ftruncateSync,closeSync,constants} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import validation from './wrangler-query-preload.cjs';
import {createWranglerQueryInvocation} from './wrangler-query-launcher.mjs';
import {renderMovementSql} from './accountless-migration-operator.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw new Error('ACCOUNTLESS_TRANSPORT_'+code);};
const check=(ok,code)=>{if(!ok)fail(code);};
// Canonical transitions return one metadata entry per SQL statement. Keep the
// complete bounded response for validation; failure artifacts retain less.
const PROCESS_CAPTURE_BYTES=1024*1024;
const CAPTURE_BYTES=256*1024;
const capture=value=>Buffer.from(typeof value==='string'?value:Buffer.isBuffer(value)?value:[]).subarray(0,CAPTURE_BYTES);
function retainBoundedLog(path) {
  let fd;
  try {
    fd=openSync(path,constants.O_RDWR|constants.O_NOFOLLOW);const info=fstatSync(fd);
    check(info.isFile()&&(info.mode&0o077)===0,'LOG_FILE');
    if(info.size>CAPTURE_BYTES)ftruncateSync(fd,CAPTURE_BYTES);
    return {status:'retained',bytesBefore:info.size,retainedBytes:Math.min(info.size,CAPTURE_BYTES),truncated:info.size>CAPTURE_BYTES};
  } catch(error) {return {status:error.code==='ENOENT'?'absent':'unavailable'};}
  finally{if(fd!==undefined)closeSync(fd);}
}
export function createAccountlessWranglerTransport({cliPath,configPath,binding,databaseId,mode,directory,maxSqlBytes=256*1024,persistTo=null,spawn=spawnSync}={}) {
  check(['local','remote'].includes(mode)&&typeof spawn==='function','CONFIG');
  check(Number.isSafeInteger(maxSqlBytes)&&maxSqlBytes>0&&maxSqlBytes<=256*1024,'LIMIT');
  check(typeof directory==='string'&&isAbsolute(directory),'DIRECTORY');
  const pinnedCli=validation.verifyCli(cliPath),pinnedConfig=validation.verifyConfig({configPath,binding,databaseId});
  mkdirSync(directory,{mode:0o700});
  const root=realpathSync(directory),info=statSync(root);
  check(!lstatSync(directory).isSymbolicLink()&&(info.mode&0o077)===0,'DIRECTORY');
  const sqlPath=join(root,'active-query.sql'),logPath=join(root,'wrangler.log');let stopped=false,busy=false,sequence=0;
  async function call(sql,kind,timeoutMs,startedAt) {
    check(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=45000,'DEADLINE');
    check(!stopped,'STOPPED');check(!busy,'BUSY');busy=true;
    let result,invocation,querySha256,attempted=false;
    try {
      check(typeof sql==='string'&&Buffer.byteLength(sql)>0&&Buffer.byteLength(sql)<=maxSqlBytes,'SQL_LIMIT');
      querySha256=sha(sql);writeFileSync(sqlPath,sql,{mode:0o600,flag:'wx'});
      invocation=createWranglerQueryInvocation({cliPath:pinnedCli.canonical,configPath:pinnedConfig.canonical,binding,databaseId,mode,sqlPath,expectedSqlSha256:querySha256,maxBytes:maxSqlBytes,persistTo});
      check(invocation.proof.cliSha256===pinnedCli.digest&&invocation.proof.configSha256===pinnedConfig.digest,'PIN_DRIFT');
      const remaining=Math.floor(timeoutMs-(performance.now()-startedAt));check(remaining>0,'DEADLINE');
      writeFileSync(logPath,'',{mode:0o600,flag:'wx'});
      attempted=true;
      result=spawn(invocation.command,invocation.args,{cwd:root,encoding:'utf8',timeout:Math.min(45000,remaining),killSignal:'SIGKILL',maxBuffer:PROCESS_CAPTURE_BYTES,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_SEND_ERROR_REPORTS:'false',WRANGLER_LOG_PATH:logPath}});
      check(result&&!result.error&&result.status===0&&!result.signal,'EXECUTION_UNKNOWN');
      check(Buffer.byteLength(result.stdout??'')<=PROCESS_CAPTURE_BYTES&&Buffer.byteLength(result.stderr??'')<=PROCESS_CAPTURE_BYTES,'CAPTURE_LIMIT');
      let parsed;try{parsed=JSON.parse(result.stdout);}catch{fail('RESPONSE_INVALID');}
      check(Array.isArray(parsed)&&parsed.length>0&&parsed.every(r=>r&&r.success===true&&Array.isArray(r.results)&&!r.error&&(!Array.isArray(r.errors)||r.errors.length===0)),'RESPONSE_INVALID');
      if(kind==='read')check(parsed.length===1,'READ_RESPONSE_INVALID');
      // A successful query has no retained SQL/capture file. Failed operations lock
      // this instance and preserve one exact query for external reconciliation.
      try{unlinkSync(logPath);}catch(error){if(error.code!=='ENOENT')throw error;}unlinkSync(sqlPath);
      sequence++;
      return kind==='read'?parsed[0].results:{outcome:'committed'};
    } catch(error) {
      stopped=true;
      const allowed=new Set(['DEADLINE','SQL_LIMIT','PIN_DRIFT','EXECUTION_UNKNOWN','CAPTURE_LIMIT','RESPONSE_INVALID','READ_RESPONSE_INVALID']);
      const suffix=String(error?.message??'').replace(/^ACCOUNTLESS_TRANSPORT_/,'');
      const code=allowed.has(suffix)?suffix:'REFUSED';
      // Bound retained debug output after termination; this is not a live disk quota.
      const logRetention=retainBoundedLog(logPath);
      const stdout=capture(result?.stdout),stderr=capture(result?.stderr);
      try { writeFileSync(join(root,'failed-stdout.bin'),stdout,{mode:0o600,flag:'wx'});
      writeFileSync(join(root,'failed-stderr.bin'),stderr,{mode:0o600,flag:'wx'});
      writeFileSync(join(root,'failed-operation.json'),JSON.stringify({schemaVersion:'accountless-wrangler-transport-failure-v1',sequence,kind,code,attempted,logRetention,querySha256:querySha256??null,databaseId,mode,cliSha256:pinnedCli.digest,configSha256:pinnedConfig.digest,status:Number.isInteger(result?.status)?result.status:null,termination:result?.error?.code==='ETIMEDOUT'?'timeout':result?.error?.code==='ENOBUFS'?'capture_limit':result?.signal?'signal':result?.error?'process_error':'none',stdoutSha256:sha(stdout),stderrSha256:sha(stderr)},null,2)+'\n',{mode:0o600,flag:'wx'}); } catch { /* The closed error remains usable even if private receipt storage fails. */ }
      fail(code);
    } finally {busy=false;}
  }
  return Object.freeze({
    async read(statement,{timeoutMs=45000}={}) {
      const startedAt=performance.now();
      check(statement&&typeof statement.sql==='string'&&/^SELECT\b/i.test(statement.sql.trim())&&!statement.sql.includes(';')&&!statement.compound,'READ_STATEMENT');
      return call(renderMovementSql([statement]),'read',timeoutMs,startedAt);
    },
    async batch({statements,sql,timeoutMs=45000}={}) {
      const startedAt=performance.now();
      const rendered=renderMovementSql(statements);check(typeof sql==='string'&&sql===rendered,'SQL_DRIFT');
      return call(sql,'batch',timeoutMs,startedAt);
    }
  });
}
