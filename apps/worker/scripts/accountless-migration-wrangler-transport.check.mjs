import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createRequire} from 'node:module';
import {createAccountlessWranglerTransport} from './accountless-migration-wrangler-transport.mjs';
import {renderMovementSql} from './accountless-migration-operator.mjs';
const cliPath=createRequire(import.meta.url).resolve('wrangler'),databaseId='00000000-0000-4000-8000-000000000001';
function setup(){const root=mkdtempSync(join(tmpdir(),'movement-transport-')),configPath=join(root,'wrangler.json');const config={name:'transport-local-test',compatibility_date:'2026-09-01',d1_databases:[{binding:'PROBE_DB',database_id:databaseId,database_name:'transport-local-test'}]};writeFileSync(configPath,JSON.stringify(config),{mode:0o600});return {root,config,options:{cliPath,configPath,binding:'PROBE_DB',databaseId,mode:'local',directory:join(root,'transport'),persistTo:join(root,'state')}};}
const statement={sql:'SELECT ? AS value',params:['synthetic']};
const okay=rows=>({status:0,signal:null,stdout:JSON.stringify([{success:true,results:rows}]),stderr:''});

test('adapter validates every result, uses bounded exact launch and removes successful private artifacts',async()=>{
 const f=setup();let calls=0;try {
  const transport=createAccountlessWranglerTransport({...f.options,spawn:(command,args,options)=>{calls++;assert.equal(command,process.execPath);assert.ok(args.includes('--require'));assert.ok(args.includes('--command=__TIBOTATTLE_FROZEN_QUERY__'));assert.ok(!args.some(a=>a.includes("'synthetic'")));assert.ok(options.timeout>0&&options.timeout<=45000);assert.equal(options.maxBuffer,1048576);assert.equal(options.killSignal,'SIGKILL');return okay([{value:'synthetic'}]);}});
  assert.deepEqual(await transport.read(statement),[{value:'synthetic'}]);
  const statements=[{sql:'INSERT INTO synthetic VALUES(?)',params:[1]}];assert.deepEqual(await transport.batch({statements,sql:renderMovementSql(statements)}),{outcome:'committed'});
  assert.equal(calls,2);assert.deepEqual(readdirSync(f.options.directory),[]);assert.equal(statSync(f.options.directory).mode&0o777,0o700);
  await assert.rejects(transport.read({sql:'SELECT 1; DELETE FROM synthetic',params:[]}),/READ_STATEMENT/);
  await assert.rejects(transport.batch({statements,sql:'different'}),/SQL_DRIFT/);assert.equal(calls,2);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('partial success and ambiguous failures retain one exact artifact and stop without retry',async()=>{
 for(const result of [{status:0,stdout:JSON.stringify([{success:true,results:[]},{success:false,results:[]}]),stderr:''},{status:0,stdout:'not-json',stderr:'synthetic raw error'},{status:null,error:{code:'ETIMEDOUT'},stdout:'',stderr:''},{status:1,stdout:'',stderr:'synthetic SQL error'}]) {
  const f=setup();let calls=0;try {
   const transport=createAccountlessWranglerTransport({...f.options,spawn:()=>{calls++;return result;}}),statements=[{sql:'INSERT INTO synthetic VALUES(?)',params:[1]}],sql=renderMovementSql(statements);
   await assert.rejects(transport.batch({statements,sql}),/^Error: ACCOUNTLESS_TRANSPORT_[A-Z_]+$/);
   assert.equal(readFileSync(join(f.options.directory,'active-query.sql'),'utf8'),sql);assert.equal(statSync(join(f.options.directory,'active-query.sql')).mode&0o777,0o600);
   const receipt=JSON.parse(readFileSync(join(f.options.directory,'failed-operation.json')));assert.equal(receipt.attempted,true);assert.equal(receipt.kind,'batch');assert.ok(!JSON.stringify(receipt).includes('synthetic SQL'));
   await assert.rejects(transport.read(statement),/STOPPED/);assert.equal(calls,1);assert.equal(readdirSync(f.options.directory).length,5);
  }finally{rmSync(f.root,{recursive:true,force:true});}
 }
});

test('config and CLI hashes stay pinned across the complete transport lifetime',async()=>{
 const f=setup();let calls=0;try {
  const transport=createAccountlessWranglerTransport({...f.options,spawn:()=>{calls++;return okay([]);}});
  await transport.read(statement);writeFileSync(f.options.configPath,JSON.stringify({...f.config,name:'changed-but-same-target'}));
  await assert.rejects(transport.read(statement),/PIN_DRIFT/);assert.equal(calls,1);
  const receipt=JSON.parse(readFileSync(join(f.options.directory,'failed-operation.json')));assert.equal(receipt.attempted,false);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('read refuses multiple result sets and all-error acknowledgements',async()=>{
 const f=setup();try {
  const transport=createAccountlessWranglerTransport({...f.options,spawn:()=>({status:0,stdout:JSON.stringify([{success:true,results:[]},{success:true,results:[]}]),stderr:''})});
  await assert.rejects(transport.read(statement),/READ_RESPONSE_INVALID/);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('adapter connects to actual pinned local Wrangler with definite batch and single-query readback',async()=>{
 const f=setup();try {
  const transport=createAccountlessWranglerTransport(f.options);
  const statements=[{sql:'CREATE TABLE transport_probe(id INTEGER PRIMARY KEY,value TEXT NOT NULL)',params:[]},{sql:'INSERT INTO transport_probe VALUES(?,?)',params:[1,'synthetic-local']}];
  assert.deepEqual(await transport.batch({statements,sql:renderMovementSql(statements)}),{outcome:'committed'});
  assert.deepEqual(await transport.read({sql:'SELECT value FROM transport_probe WHERE id=?',params:[1]}),[{value:'synthetic-local'}]);
  const entries=readdirSync(f.options.directory);assert.ok(entries.every(name=>name==='.wrangler'));
  if(entries.length)assert.deepEqual(readdirSync(join(f.options.directory,'.wrangler'),{recursive:true}),['cache','cache/cf.json']);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});


test('remaining deadlines cap the blocking spawn and expired or invalid budgets never dispatch',async()=>{
 const f=setup(),timeouts=[];try {
  const transport=createAccountlessWranglerTransport({...f.options,spawn:(_command,_args,options)=>{timeouts.push(options.timeout);return okay([]);}});
  await transport.read(statement,{timeoutMs:1000});
  const statements=[{sql:'INSERT INTO synthetic VALUES(?)',params:[1]}],sql=renderMovementSql(statements);
  await transport.batch({statements,sql,timeoutMs:500});
  assert.equal(timeouts.length,2);assert.ok(timeouts[0]>0&&timeouts[0]<=1000);assert.ok(timeouts[1]>0&&timeouts[1]<=500);
  for(const timeoutMs of [0,-1,45001,0.5,NaN]) {
   await assert.rejects(transport.read(statement,{timeoutMs}),/DEADLINE/);
   await assert.rejects(transport.batch({statements,sql,timeoutMs}),/DEADLINE/);
  }
  assert.equal(timeouts.length,2);assert.deepEqual(readdirSync(f.options.directory),[]);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('failed private Wrangler debug log is precreated privately and truncated after termination',async()=>{
 const f=setup();try {
  const transport=createAccountlessWranglerTransport({...f.options,spawn:(_command,_args,options)=>{
   assert.equal(statSync(options.env.WRANGLER_LOG_PATH).mode&0o777,0o600);
   writeFileSync(options.env.WRANGLER_LOG_PATH,'x'.repeat(300*1024));
   return {status:null,error:{code:'ETIMEDOUT'},stdout:'',stderr:''};
  }});
  await assert.rejects(transport.read(statement),/EXECUTION_UNKNOWN/);
  assert.equal(statSync(join(f.options.directory,'wrangler.log')).size,256*1024);
  const receipt=JSON.parse(readFileSync(join(f.options.directory,'failed-operation.json')));
  assert.deepEqual(receipt.logRetention,{status:'retained',bytesBefore:300*1024,retainedBytes:256*1024,truncated:true});
  assert.ok(readFileSync(join(f.options.directory,'active-query.sql'),'utf8').includes('SELECT'));
 }finally{rmSync(f.root,{recursive:true,force:true});}
});


test('large transition response is fully validated while failure captures stay bounded',async()=>{
 const entries=Array.from({length:600},()=>({success:true,results:[],meta:{padding:'x'.repeat(512)}}));
 const valid=JSON.stringify(entries);assert.ok(Buffer.byteLength(valid)>256*1024&&Buffer.byteLength(valid)<1024*1024);
 for(const variant of ['valid','late_error','over_limit']){
  const f=setup();let calls=0;try{
   const response=variant==='valid'?valid:variant==='late_error'?JSON.stringify([...entries,{success:false,results:[]}]):'x'.repeat(1024*1024+1);
   const transport=createAccountlessWranglerTransport({...f.options,spawn:()=>{calls++;return {status:0,stdout:response,stderr:''};}});
   const statements=[{sql:'SELECT 1',params:[]}],sql=renderMovementSql(statements);
   if(variant==='valid'){assert.deepEqual(await transport.batch({statements,sql}),{outcome:'committed'});assert.deepEqual(readdirSync(f.options.directory),[]);}
   else{
    await assert.rejects(transport.batch({statements,sql}),variant==='late_error'?/RESPONSE_INVALID/:/CAPTURE_LIMIT/);
    assert.equal(statSync(join(f.options.directory,'failed-stdout.bin')).size,256*1024);
    await assert.rejects(transport.batch({statements,sql}),/STOPPED/);assert.equal(calls,1);
   }
  }finally{rmSync(f.root,{recursive:true,force:true});}
 }
});
