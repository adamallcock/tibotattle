import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, rm, cp, symlink, link, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityDigest, readOperation } from '../../../scripts/lib/release-operation.mjs';
import { storageSha256 } from './d1-storage-plan.mjs';
import { TYPED_SCHEMA_INPUT_DIRECTORIES } from './production-typed-schema.mjs';
import { createMaintainedAnalyticsSQLiteAdapter } from './maintained-analytics-forward-migration.mjs';
import { prepareMaintainedAnalyticsForwardTransportCandidate, runMaintainedAnalyticsForwardTransportProof,
  MAINTAINED_FORWARD_TRANSPORT_CONFIRMATION, MAINTAINED_FORWARD_TRANSPORT_ORDINARY_BODY_CAP,
  MAINTAINED_FORWARD_TRANSPORT_SELECTIVE_BODY } from './maintained-analytics-forward-transport.mjs';

const workerDirectory=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const accountId='a'.repeat(32),createdAt='2026-10-01T12:00:00.000Z';
const targets={primary:{binding:'USAGE_MONITOR_DB',databaseId:'11111111-1111-1111-1111-111111111111'},
  analytics:{binding:'ANALYTICS_DB',databaseId:'22222222-2222-2222-2222-222222222222'}};
const codePins=Object.fromEntries(['public','analytics','publication','cache'].map(role=>[role,storageSha256(`synthetic-transport-code:${role}`)]));
const candidatePromise=prepareMaintainedAnalyticsForwardTransportCandidate({workerDirectory,accountId,targets,codePins,createdAt});
const roots=[];
after(async()=>{for (const root of roots) await rm(root,{recursive:true,force:true});});
async function directory(){const root=await mkdtemp('/private/tmp/maintained-transport-check-');roots.push(root);return root;}
const authorization=candidate=>({schema:'maintained-analytics-forward-synthetic-authorization-v1',mode:'synthetic-local',
  approvedCandidateSha256:identityDigest(candidate),confirmation:MAINTAINED_FORWARD_TRANSPORT_CONFIRMATION});
async function runtime(){
  const candidate=await candidatePromise;
  const backend=await createMaintainedAnalyticsSQLiteAdapter({workerDirectory,plan:candidate.localProof,
    seed:({primary})=>primary.exec("INSERT INTO participants(id,owner_kind,created_at) VALUES('synthetic-retained','accountless','2026-10-01T00:00:00.000Z')")});
  return {candidate,backend};
}
async function proof(candidate,backend,fetcher,operationDirectory,extra={}){
  return runMaintainedAnalyticsForwardTransportProof({workerDirectory,candidate,backend,fetcher,operationDirectory,
    mode:'synthetic-local',authorization:authorization(candidate),...extra});
}
const result=count=>({success:true,result:Array.from({length:count},()=>({success:true,results:[]}))});
function mockApi(backend,{before=null,late=null,afterCommit=null}={}){
  const calls=[];
  const fetcher=async(url,request)=>{
    const address=new URL(url);
    assert.equal(address.origin,'https://api.cloudflare.com');
    const role=Object.keys(targets).find(role=>address.pathname===`/client/v4/accounts/${accountId}/d1/database/${targets[role].databaseId}/query`);
    assert.ok(role);assert.equal(request.method,'POST');assert.equal(request.redirect,'error');
    assert.deepEqual(request.headers,{'content-type':'application/json'});assert.ok(request.signal instanceof AbortSignal);
    const body=JSON.parse(request.body);assert.deepEqual(Object.keys(body),['batch']);
    assert.equal(body.batch.at(-1).sql,'INSERT INTO d1_storage_migrations(name,sha256) VALUES(?,?)');
    calls.push({role,body,bytes:Buffer.byteLength(request.body),sha256:storageSha256(request.body)});
    await before?.(calls.length,body);
    const db=backend.databases[role];db.exec('BEGIN IMMEDIATE');
    try {
      for(const query of body.batch)db.prepare(query.sql).run(...query.params);
      await late?.(calls.length,db);db.exec('COMMIT');
    }catch{db.exec('ROLLBACK');return Response.json({success:false,result:[]},{status:409});}
    await afterCommit?.(calls.length);
    return Response.json(result(body.batch.length));
  };
  return {fetcher,calls};
}

test('candidate pins every exact source, statement and REST body without hosted qualification',async()=>{
  const candidate=await candidatePromise;
  assert.equal(candidate.status,'unreviewed-candidate');assert.equal(candidate.hostedAcceptance,'unqualified');
  assert.equal(candidate.steps.length,17);assert.equal(candidate.localProof.frontiers.length,18);
  assert.deepEqual(await prepareMaintainedAnalyticsForwardTransportCandidate({workerDirectory,accountId,targets,codePins,createdAt}),candidate);
  for(const [index,step]of candidate.steps.entries()){
    assert.equal(step.sourceSha256,candidate.localProof.steps[index].sha256);
    assert.equal(step.sourceBytes,candidate.localProof.steps[index].bytes);
    assert.equal(step.statementSha256.length,step.resultCount-1);
    assert.ok(step.statementSha256.every(hash=>/^[a-f0-9]{64}$/u.test(hash)));
    assert.ok(step.statementBytes.every(bytes=>bytes>0&&bytes<=8192));
    if(index!==1)assert.ok(step.requestBytes<=MAINTAINED_FORWARD_TRANSPORT_ORDINARY_BODY_CAP);
  }
  const selective=candidate.steps[1];
  assert.equal(selective.sourceBytes,269024);assert.equal(selective.resultCount,130);
  assert.equal(Math.max(...selective.statementBytes),7253);
  assert.equal(selective.requestBytes,MAINTAINED_FORWARD_TRANSPORT_SELECTIVE_BODY.bytes);
  assert.equal(selective.requestSha256,MAINTAINED_FORWARD_TRANSPORT_SELECTIVE_BODY.sha256);
  assert.equal(MAINTAINED_FORWARD_TRANSPORT_ORDINARY_BODY_CAP,256*1024);
  assert.equal(JSON.stringify(candidate).includes('CREATE TRIGGER'),false);
});

test('one pinned request per migration commits the exact frontiers and ledger once, retaining source rows',async()=>{
  const {candidate,backend}=await runtime(),{fetcher,calls}=mockApi(backend),op=join(await directory(),'proof');
  try {
    const retained=await backend.acceptedOutputSha256(),value=await proof(candidate,backend,fetcher,op);
    assert.equal(value.status,'complete');assert.equal(value.mockCalls,17);assert.equal(value.remoteWrites,false);
    assert.equal(value.hostedAcceptance,'unqualified');assert.equal(calls.length,17);
    assert.equal(calls[1].bytes,273935);assert.equal(calls[1].sha256,MAINTAINED_FORWARD_TRANSPORT_SELECTIVE_BODY.sha256);
    for(const role of ['primary','analytics'])assert.deepEqual(await backend.inspect(role),candidate.localProof.frontiers[17][role]);
    assert.equal(await backend.acceptedOutputSha256(),retained);
    assert.equal(backend.databases.primary.prepare('SELECT count(*) n FROM participants').get().n,1);
    assert.equal((await proof(candidate,backend,fetcher,op,{resume:true})).mockCalls,0);assert.equal(calls.length,17);
  }finally{backend.close();}
});

test('altered candidate pins, roles, targets and qualification labels refuse before mock submission',async()=>{
  const {candidate,backend}=await runtime();let calls=0;
  const fetcher=async()=>{calls++;throw Error('unexpected mock submission');};
  const variants=[
    value=>{value.steps[1].requestBytes++;},value=>{value.steps[1].requestSha256='0'.repeat(64);},
    value=>{value.steps[1].statementSha256[0]='0'.repeat(64);},value=>{value.steps[1].role='analytics';},
    value=>{value.steps[1].statementSha256[0]=()=>{};},
    value=>{value.targets.primary.databaseId='33333333-3333-3333-3333-333333333333';},
    value=>{value.status='reviewed';},
    value=>{value.hostedAcceptance='qualified';},value=>{value.steps.push(value.steps[0]);},
  ];
  try {
    for(const change of variants){const changed=structuredClone(candidate);change(changed);
      await assert.rejects(proof(changed,backend,fetcher,join(await directory(),'proof')),/MAINTAINED_FORWARD_TRANSPORT_/u);}
    await assert.rejects(proof(candidate,backend,fetcher,join(await directory(),'hosted'),{mode:'hosted'}),
      {code:'MAINTAINED_FORWARD_TRANSPORT_HOSTED_NOT_QUALIFIED'});
    await assert.rejects(proof(candidate,backend,globalThis.fetch,join(await directory(),'real-fetch')),
      {code:'MAINTAINED_FORWARD_TRANSPORT_SYNTHETIC_ADAPTER_REQUIRED'});
    await assert.rejects(proof(candidate,backend,fetcher,join(await directory(),'arbitrary-sql'),{sql:'SELECT 1'}),
      {code:'MAINTAINED_FORWARD_TRANSPORT_OPTIONS_INVALID'});
    assert.equal(calls,0);
  }finally{backend.close();}
});

test('explicit candidate approval, code, disabled controls and exact frontier are required before submission',async()=>{
  const {candidate,backend}=await runtime();let calls=0;
  const fetcher=async()=>{calls++;throw Error('unexpected');};
  try {
    await assert.rejects(proof(candidate,backend,fetcher,join(await directory(),'approval'),{authorization:{}}),
      {code:'MAINTAINED_FORWARD_TRANSPORT_AUTHORIZATION_REQUIRED'});
    const workers=await backend.workers();workers.public.flags.STORAGE_ANALYTICS_CANONICAL_PIPELINE='enabled';backend.setWorkerEvidence(workers);
    await assert.rejects(proof(candidate,backend,fetcher,join(await directory(),'controls')),
      {code:'MAINTAINED_FORWARD_LOCAL_CONTROLS_NOT_DISABLED'});
    workers.public.flags.STORAGE_ANALYTICS_CANONICAL_PIPELINE='disabled';workers.public.codeSha256='0'.repeat(64);backend.setWorkerEvidence(workers);
    await assert.rejects(proof(candidate,backend,fetcher,join(await directory(),'code')),
      {code:'MAINTAINED_FORWARD_LOCAL_CODE_OR_CONTROLS_DRIFT'});
    workers.public.codeSha256=codePins.public;backend.setWorkerEvidence(workers);
    backend.databases.primary.exec('CREATE TABLE synthetic_frontier_drift(id INTEGER)');
    await assert.rejects(proof(candidate,backend,fetcher,join(await directory(),'frontier')),
      {code:'MAINTAINED_FORWARD_LOCAL_FRONTIER_OR_CONTROLS_DRIFT'});assert.equal(calls,0);
  }finally{backend.close();}
});

for(const failure of ['partial','unsuccessful','malformed','rows','oversized','timeout','provider-errors'])
  test(`${failure} response stays uncertain and requires read-only reconciliation before any replay`,async()=>{
    const {candidate,backend}=await runtime(),op=join(await directory(),'proof');let calls=0;
    const fetcher=async(_url,request)=>{
      calls++;const count=JSON.parse(request.body).batch.length;
      if(failure==='partial')return Response.json(result(count-1));
      if(failure==='unsuccessful')return Response.json({success:false,result:[]},{status:409});
      if(failure==='malformed')return new Response('invalid');
      if(failure==='provider-errors')return Response.json({...result(count),errors:[{code:1000,message:'synthetic refusal'}]});
      if(failure==='rows'){const value=result(count);value.result[0].results=[{synthetic:1}];return Response.json(value);}
      if(failure==='oversized')return new Response('x'.repeat(2_000_001));
      // Deliberately ignore AbortSignal: the transport itself must enforce time.
      return new Promise(()=>{});
    };
    try {
      await assert.rejects(proof(candidate,backend,fetcher,op,{requestTimeoutMs:failure==='timeout'?5:20000}),
        {code:'MAINTAINED_FORWARD_TRANSPORT_PROVIDER_RESULT_UNCERTAIN'});
      assert.equal(calls,1);assert.equal((await readOperation(op)).state.status,'uncertain');
      assert.equal((await proof(candidate,backend,fetcher,op,{resume:true})).status,'reconciled-not-applied');assert.equal(calls,1);
      const reconciliation=await proof(candidate,backend,fetcher,op,{resume:true,reconcileOnly:true});
      assert.equal(reconciliation.status,'reconciled-not-applied');assert.equal(calls,1);
    }finally{backend.close();}
  });

test('lost committed reply reconciles applied state without resubmission and resumes only with exact approval',async()=>{
  const {candidate,backend}=await runtime();let lost=true;
  const {fetcher,calls}=mockApi(backend,{afterCommit:async()=>{if(lost){lost=false;throw Error('synthetic lost reply');}}});
  const op=join(await directory(),'proof');
  try {
    await assert.rejects(proof(candidate,backend,fetcher,op),{code:'MAINTAINED_FORWARD_TRANSPORT_PROVIDER_RESULT_UNCERTAIN'});
    const reconciliation=await proof(candidate,backend,fetcher,op,{resume:true,reconcileOnly:true});
    assert.equal(reconciliation.status,'reconciled-applied');assert.equal(calls.length,1);
    const value=await proof(candidate,backend,fetcher,op,{resume:true,approvedReconciliationSha256:reconciliation.reconciliationSha256});
    assert.equal(value.status,'complete');assert.equal(value.mockCalls,16);assert.equal(calls.length,17);
  }finally{backend.close();}
});

test('synthetic batch late failure rolls back the whole selective migration and its ledger',async()=>{
  const {candidate,backend}=await runtime();const retained=await backend.acceptedOutputSha256();
  const {fetcher,calls}=mockApi(backend,{late:async(number,db)=>{if(number===2)db.exec('INSERT INTO synthetic_missing_late_failure VALUES(1)');}});
  const op=join(await directory(),'proof');
  try {
    await assert.rejects(proof(candidate,backend,fetcher,op),{code:'MAINTAINED_FORWARD_TRANSPORT_PROVIDER_RESULT_UNCERTAIN'});
    assert.equal(calls.length,2);assert.deepEqual(await backend.inspect('primary'),candidate.localProof.frontiers[1].primary);
    assert.equal(await backend.acceptedOutputSha256(),retained);
    assert.equal(backend.databases.primary.prepare('SELECT count(*) n FROM d1_storage_migrations WHERE name=?').get(candidate.steps[1].name).n,0);
    assert.equal((await proof(candidate,backend,fetcher,op,{resume:true,reconcileOnly:true})).status,'reconciled-not-applied');
    assert.equal(calls.length,2);
  }finally{backend.close();}
});

test('a changed exact source cannot prepare a new oversized request even with recomputed candidate pins',async()=>{
  const root=await directory(),worker=join(root,'worker');
  for(const folder of new Set([...TYPED_SCHEMA_INPUT_DIRECTORIES.primary,...TYPED_SCHEMA_INPUT_DIRECTORIES.analytics]))
    await cp(join(workerDirectory,folder),join(worker,folder),{recursive:true});
  await cp(join(workerDirectory,'package.json'),join(worker,'package.json'));await symlink(join(workerDirectory,'node_modules'),join(worker,'node_modules'));
  const path=join(worker,MAINTAINED_FORWARD_TRANSPORT_SELECTIVE_BODY.directory,MAINTAINED_FORWARD_TRANSPORT_SELECTIVE_BODY.name);
  const bytes=await readFile(path);bytes[bytes.length-1]=bytes.at(-1)===32?10:32;await writeFile(path,bytes);
  await assert.rejects(prepareMaintainedAnalyticsForwardTransportCandidate({workerDirectory:worker,accountId,targets,codePins,createdAt}),
    {code:'MIGRATION_INPUT_POLICY_INVALID'});
});

test('symlink, hardlink and absent candidate sources refuse with bounded safe errors',async()=>{
  for(const alias of ['symlink','hardlink','absent']){
    const root=await directory(),worker=join(root,'worker'),folder=join(worker,'ingestion-isolation-migrations');
    await mkdir(folder,{recursive:true});
    await cp(join(workerDirectory,'ingestion-isolation-migrations','0014_effective_dependency_mutations.sql'),
      join(folder,'0014_effective_dependency_mutations.sql'));
    if(alias!=='absent'){
      const backup=join(folder,'synthetic-source-copy');
      await cp(join(workerDirectory,'ingestion-isolation-migrations',MAINTAINED_FORWARD_TRANSPORT_SELECTIVE_BODY.name),backup);
      await (alias==='symlink'?symlink:link)(backup,join(folder,MAINTAINED_FORWARD_TRANSPORT_SELECTIVE_BODY.name));
    }
    await assert.rejects(prepareMaintainedAnalyticsForwardTransportCandidate({workerDirectory:worker,accountId,targets,codePins,createdAt}),
      {code:'MAINTAINED_FORWARD_TRANSPORT_SOURCE_UNSAFE'});
  }
});
