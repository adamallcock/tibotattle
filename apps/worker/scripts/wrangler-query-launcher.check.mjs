import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync,chmodSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createWranglerQueryInvocation} from './wrangler-query-launcher.mjs';
const require=createRequire(import.meta.url),cliPath=require.resolve('wrangler');
const digest=value=>createHash('sha256').update(value).digest('hex');
const databaseId='00000000-0000-4000-8000-000000000001';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'wrangler-query-launch-')),configPath=join(dir,'wrangler.json'),sqlPath=join(dir,'query.sql');writeFileSync(configPath,JSON.stringify({name:'query-preload-local-test',compatibility_date:'2026-09-01',d1_databases:[{binding:'PROBE_DB',database_id:databaseId,database_name:'query-preload-local-only'}]}),{mode:0o600});return {dir,options:{cliPath,configPath,sqlPath,binding:'PROBE_DB',databaseId,mode:'local',persistTo:join(dir,'local-state')}};}
function prepare(options,sql){writeFileSync(options.sqlPath,sql,{mode:0o600});return createWranglerQueryInvocation({...options,expectedSqlSha256:digest(sql)});}
function run(invocation,dir){return spawnSync(invocation.command,invocation.args,{cwd:dir,encoding:'utf8',timeout:45000,maxBuffer:1024*1024,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_SEND_ERROR_REPORTS:'false',WRANGLER_LOG_PATH:join(dir,'wrangler.log')}});}

test('launcher keeps SQL off OS argv and rejects drift, oversized input, nonprivate files and unsupported modes',()=>{
 const {dir,options}=fixture();try {
  const sql='-- Mandatory unchanged leading comment\nSELECT 42;';const invocation=prepare(options,sql);
  assert.ok(invocation.args.every(arg=>!arg.includes(sql)));assert.ok(invocation.args.every(arg=>!arg.includes('--file')));assert.ok(invocation.args.includes('--command=__TIBOTATTLE_FROZEN_QUERY__'));
  assert.equal(invocation.proof.sqlSha256,digest(sql));assert.ok(invocation.args.reduce((n,a)=>n+a.length,0)<4096);
  assert.throws(()=>createWranglerQueryInvocation({...options,expectedSqlSha256:'a'.repeat(64)}),/WRANGLER_QUERY_HASH/);
  assert.throws(()=>createWranglerQueryInvocation({...options,expectedSqlSha256:digest(sql),maxBytes:10}),/WRANGLER_QUERY_SIZE/);
  assert.throws(()=>createWranglerQueryInvocation({...options,expectedSqlSha256:digest(sql),maxBytes:262145}),/WRANGLER_QUERY_LIMIT/);
  assert.throws(()=>createWranglerQueryInvocation({...options,expectedSqlSha256:digest(sql),mode:'import'}),/WRANGLER_QUERY_MODE/);
  chmodSync(options.sqlPath,0o644);assert.throws(()=>createWranglerQueryInvocation({...options,expectedSqlSha256:digest(sql)}),/WRANGLER_QUERY_PRIVATE_FILE_REQUIRED/);
  chmodSync(options.sqlPath,0o600);const alias=join(dir,'query-link.sql');symlinkSync(options.sqlPath,alias);assert.throws(()=>createWranglerQueryInvocation({...options,sqlPath:alias,expectedSqlSha256:digest(sql)}),/WRANGLER_QUERY_SYMLINK/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('preload revalidates artifact and exact target before Wrangler starts',()=>{
 const {dir,options}=fixture();try {
  let invocation=prepare(options,'SELECT 42;');writeFileSync(options.sqlPath,'SELECT 43;');
  let result=run(invocation,dir);assert.equal(result.status,1);assert.equal(result.stderr.trim(),'WRANGLER_QUERY_HASH');assert.equal(result.stdout,'');
  invocation=prepare(options,'SELECT 42;');writeFileSync(options.sqlPath,'x'.repeat(262145));result=run(invocation,dir);assert.equal(result.status,1);assert.equal(result.stderr.trim(),'WRANGLER_QUERY_SIZE');assert.equal(result.stdout,'');
  invocation=prepare(options,'SELECT 42;');writeFileSync(options.configPath,JSON.stringify({d1_databases:[{binding:'PROBE_DB',database_id:'00000000-0000-4000-8000-000000000002'}]}));
  result=run(invocation,dir);assert.equal(result.status,1);assert.equal(result.stderr.trim(),'WRANGLER_QUERY_CONFIG_TARGET');assert.equal(result.stdout,'');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('actual pinned Wrangler executes over142KiB normal local command and rolls back late SQL failure',()=>{
 const {dir,options}=fixture();try {
  let result=run(prepare(options,'CREATE TABLE query_probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL);'),dir);
  assert.equal(result.status,0,result.stderr);
  const prefix='-- Mandatory preserved leading comment\n/*'+ 'p'.repeat(150*1024)+'*/\n';
  const failing=prefix+"INSERT INTO query_probe VALUES(1,'first'); INSERT INTO query_probe VALUES(2,NULL);";
  const invocation=prepare(options,failing);assert.ok(invocation.proof.sqlBytes>142*1024);
  result=run(invocation,dir);assert.equal(result.status,1);assert.match(result.stdout+result.stderr,/NOT NULL constraint failed/);
  result=run(prepare(options,'SELECT COUNT(*) AS rows_after_rollback FROM query_probe;'),dir);assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].results[0].rows_after_rollback,0);
  result=run(prepare(options,prefix+"INSERT INTO query_probe VALUES(3,'complete'); SELECT value FROM query_probe WHERE id=3;"),dir);
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).at(-1).results[0].value,'complete');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
