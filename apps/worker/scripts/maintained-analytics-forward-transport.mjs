import { identityDigest, operationError } from '../../../scripts/lib/release-operation.mjs';
import { storageSha256 } from './d1-storage-plan.mjs';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { assertMigrationInputPolicy, migrationInputMaximumBytes, SELECTIVE_DEPENDENCY_MIGRATION_INPUT } from './migration-input-policy.mjs';
import { prepareMaintainedAnalyticsForwardLocal, loadMaintainedAnalyticsForwardLocalSteps,
  runMaintainedAnalyticsForwardLocal, MAINTAINED_FORWARD_LOCAL_CONFIRMATION,
  MAINTAINED_FORWARD_STEPS } from './maintained-analytics-forward-migration.mjs';

// Preparation and credentialless synthetic proof only. This module has no live
// fetch default, credential discovery, CLI or reviewed hosted execution mode.
export const MAINTAINED_FORWARD_TRANSPORT_SCHEMA = 'maintained-analytics-forward-transport-candidate-v1';
export const MAINTAINED_FORWARD_TRANSPORT_CONFIRMATION = 'EXECUTE_SYNTHETIC_MAINTAINED_ANALYTICS_TRANSPORT';
export const MAINTAINED_FORWARD_TRANSPORT_ORDINARY_BODY_CAP = 256 * 1024;
export const MAINTAINED_FORWARD_TRANSPORT_SELECTIVE_BODY = Object.freeze({
  role:'primary',directory:SELECTIVE_DEPENDENCY_MIGRATION_INPUT.directory,
  name:SELECTIVE_DEPENDENCY_MIGRATION_INPUT.name,sourceSha256:SELECTIVE_DEPENDENCY_MIGRATION_INPUT.sha256,
  bytes:273935,sha256:'d3e365e19ae62a3d351dda95626cd395bab8b8ebb0055e8cc1a958efdf99a820',
});
const ROLES = ['primary','analytics'];
const BINDINGS = {primary:'USAGE_MONITOR_DB',analytics:'ANALYTICS_DB'};
const API_ORIGIN = 'https://api.cloudflare.com/client/v4';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MAX_STATEMENT_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 2_000_000;
const fail = suffix => {throw operationError(`MAINTAINED_FORWARD_TRANSPORT_${suffix}`);};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value,keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const same = (left,right) => identityDigest(left) === identityDigest(right);

function validateTargets(accountId,targets) {
  if (!/^[a-f0-9]{32}$/u.test(accountId) || !exact(targets,ROLES)
    || ROLES.some(role => !exact(targets[role],['binding','databaseId'])
      || targets[role].binding !== BINDINGS[role] || !UUID.test(targets[role].databaseId))
    || targets.primary.databaseId === targets.analytics.databaseId) fail('TARGETS_INVALID');
}
function requestFor(input,workerDirectory) {
  assertMigrationInputPolicy({workerDirectory,directory:input.directory,name:input.name,bytes:Buffer.from(input.sql)});
  if (input.statements.length < 1 || input.statements.length >= 900
    || input.statements.some(sql => Buffer.byteLength(sql) > MAX_STATEMENT_BYTES)) fail('STATEMENT_LIMIT');
  const queries = [...input.statements.map(sql => ({sql,params:[]})),
    {sql:'INSERT INTO d1_storage_migrations(name,sha256) VALUES(?,?)',params:[input.name,input.sha256]}];
  const body = JSON.stringify({batch:queries}), requestBytes = Buffer.byteLength(body), requestSha256 = storageSha256(body);
  const pin = MAINTAINED_FORWARD_TRANSPORT_SELECTIVE_BODY;
  const selective = input.role === pin.role && input.directory === pin.directory && input.name === pin.name;
  if (selective ? input.sha256 !== pin.sourceSha256 || requestBytes !== pin.bytes || requestSha256 !== pin.sha256
    : requestBytes > MAINTAINED_FORWARD_TRANSPORT_ORDINARY_BODY_CAP) fail('REQUEST_NOT_PINNED');
  return {body,pin:{role:input.role,directory:input.directory,name:input.name,sourceSha256:input.sha256,
    sourceBytes:input.bytes,statementSha256:input.statements.map(storageSha256),statementBytes:input.statementBytes,
    resultCount:queries.length,requestBytes,requestSha256}};
}

export async function prepareMaintainedAnalyticsForwardTransportCandidate({workerDirectory,accountId,targets,codePins,
  createdAt=new Date().toISOString()}={}) {
  validateTargets(accountId,targets);
  if (typeof workerDirectory!=='string'||!isAbsolute(workerDirectory))fail('SOURCE_UNSAFE');
  // Apply the retained source admission policy before the local preparer can
  // execute SQL to project frontiers. The local operator owns later inventory,
  // link and complete-prefix identity checks as well.
  const root=resolve(workerDirectory);
  try {
   if (await realpath(root)!==root || !(await lstat(root)).isDirectory()) fail('SOURCE_UNSAFE');
   for (const step of MAINTAINED_FORWARD_STEPS) {
    const folder=join(root,step.directory),path=join(folder,step.name),info=await lstat(path);
    if (await realpath(folder)!==folder || !info.isFile() || info.nlink!==1 || info.size<1
      || info.size>migrationInputMaximumBytes(step.directory,step.name) || await realpath(path)!==path) fail('SOURCE_UNSAFE');
    const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const actual=await handle.stat();
      if(actual.ino!==info.ino||actual.dev!==info.dev||actual.nlink!==1||actual.size!==info.size)fail('SOURCE_UNSAFE');
      const buffer=Buffer.alloc(info.size+1);let count=0,read;
      do {read=(await handle.read(buffer,count,buffer.length-count,null)).bytesRead;count+=read;}while(read>0&&count<buffer.length);
      if(count!==info.size||(await handle.stat()).size!==info.size)fail('SOURCE_UNSAFE');
      assertMigrationInputPolicy({workerDirectory:root,directory:step.directory,name:step.name,bytes:buffer.subarray(0,count)});
    }finally{await handle.close();}
   }
  }catch(error){
    if(error?.code==='MIGRATION_INPUT_POLICY_INVALID'||error?.code==='MAINTAINED_FORWARD_TRANSPORT_SOURCE_UNSAFE')throw error;
    fail('SOURCE_UNSAFE');
  }
  const first = await prepareMaintainedAnalyticsForwardLocal({workerDirectory,codePins,createdAt,
    localTargets:{primary:'synthetic-primary',analytics:'synthetic-analytics'}});
  const inputs = await loadMaintainedAnalyticsForwardLocalSteps({plan:first,workerDirectory});
  const steps = inputs.map(input => requestFor(input,workerDirectory).pin);
  // Bind the existing journal to target identities and the complete transport
  // serialization without changing the deliberately local operator contract.
  const proofBinding = identityDigest({accountId,targets,steps});
  const localTargets = Object.fromEntries(ROLES.map(role => [role,`synthetic-${role}-${proofBinding.slice(0,24)}`]));
  const localProof = await prepareMaintainedAnalyticsForwardLocal({workerDirectory,codePins,createdAt,localTargets});
  return {schema:MAINTAINED_FORWARD_TRANSPORT_SCHEMA,status:'unreviewed-candidate',hostedAcceptance:'unqualified',
    accountId,targets:structuredClone(targets),localProof,steps};
}

async function validateCandidate(candidate,workerDirectory) {
  if (!exact(candidate,['schema','status','hostedAcceptance','accountId','targets','localProof','steps'])
    || candidate.schema !== MAINTAINED_FORWARD_TRANSPORT_SCHEMA || candidate.status !== 'unreviewed-candidate'
    || candidate.hostedAcceptance !== 'unqualified' || !object(candidate.localProof)) fail('CANDIDATE_INVALID');
  validateTargets(candidate.accountId,candidate.targets);
  const inputs=await loadMaintainedAnalyticsForwardLocalSteps({plan:candidate.localProof,workerDirectory});
  const steps=inputs.map(input=>requestFor(input,workerDirectory).pin);
  const proofBinding=identityDigest({accountId:candidate.accountId,targets:candidate.targets,steps});
  const localTargets=Object.fromEntries(ROLES.map(role=>[role,`synthetic-${role}-${proofBinding.slice(0,24)}`]));
  if (!same(candidate.steps,steps)||!same(candidate.localProof.localTargets,localTargets))fail('CANDIDATE_OR_INPUT_CHANGED');
  return inputs;
}

async function readResponse(response) {
  if (!response || typeof response.status !== 'number' || !response.body?.getReader) fail('PROVIDER_RESULT_UNCERTAIN');
  const reader = response.body.getReader(), chunks = [];let length=0;
  try {
    while (true) {const {done,value}=await reader.read();if (done) break;
      length += value.byteLength;if (length > MAX_RESPONSE_BYTES) fail('PROVIDER_RESULT_UNCERTAIN');chunks.push(value);}
  } finally {await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks);
}

async function submitMock(fetcher,url,body,timeoutMs) {
  const controller=new AbortController();let timer;
  try {
    return await Promise.race([
      (async()=>{
        const response=await fetcher(url,{method:'POST',headers:{'content-type':'application/json'},body,
          redirect:'error',signal:controller.signal});
        const bytes=await readResponse(response);
        return {response,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))};
      })(),
      new Promise((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(operationError('MAINTAINED_FORWARD_TRANSPORT_PROVIDER_RESULT_UNCERTAIN'));},timeoutMs);}),
    ]);
  }finally{clearTimeout(timer);}
}

/** Injected synthetic backend and mock fetch only. The existing local runner
 * owns exact code/control/frontier checks, durable intent and reconciliation.
 * No live authorization schema is accepted while hosted acceptance is unknown. */
export async function runMaintainedAnalyticsForwardTransportProof(options={}) {
  const keys = ['workerDirectory','candidate','authorization','backend','fetcher','operationDirectory','mode',
    'resume','reconcileOnly','approvedReconciliationSha256','retryNotApplied','requestTimeoutMs'];
  if (!object(options) || Object.keys(options).some(key => !keys.includes(key))) fail('OPTIONS_INVALID');
  const {workerDirectory,authorization,backend,fetcher,operationDirectory,mode,resume=false,
    reconcileOnly=false,approvedReconciliationSha256=null,retryNotApplied=false,requestTimeoutMs=20000} = options;
  if (typeof workerDirectory!=='string'||!isAbsolute(workerDirectory)||typeof operationDirectory!=='string'
    || !isAbsolute(operationDirectory)||[resume,reconcileOnly,retryNotApplied].some(value=>typeof value!=='boolean')
    || approvedReconciliationSha256!==null&&!/^[a-f0-9]{64}$/u.test(approvedReconciliationSha256))fail('OPTIONS_INVALID');
  let candidate;
  try{candidate=structuredClone(options.candidate);}catch{fail('CANDIDATE_INVALID');}
  const inputs = await validateCandidate(candidate,workerDirectory);
  if (mode !== 'synthetic-local') fail('HOSTED_NOT_QUALIFIED');
  if (!exact(authorization,['schema','mode','approvedCandidateSha256','confirmation'])
    || authorization.schema !== 'maintained-analytics-forward-synthetic-authorization-v1'
    || authorization.mode !== 'synthetic-local' || authorization.confirmation !== MAINTAINED_FORWARD_TRANSPORT_CONFIRMATION
    || authorization.approvedCandidateSha256 !== identityDigest(candidate)) fail('AUTHORIZATION_REQUIRED');
  if (!backend || backend.localOnly !== true || !same(backend.localTargets,candidate.localProof.localTargets)
    || ['workers','inspect','acceptedOutputSha256'].some(key => typeof backend[key] !== 'function')
    || typeof fetcher !== 'function' || fetcher === globalThis.fetch
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 20000) fail('SYNTHETIC_ADAPTER_REQUIRED');
  let calls=0;
  const adapter = {localOnly:true,localTargets:backend.localTargets,
    workers:()=>backend.workers(),inspect:role=>backend.inspect(role),acceptedOutputSha256:()=>backend.acceptedOutputSha256(),
    async migrateAtomic(input,sql) {
      // The local runner rechecks source/code/control/frontier after its fsync.
      // This private candidate copy also prevents injected callback changes to
      // target selection or request pins during the mock operation.
      const index=inputs.findIndex(value => value.name === input?.name), pinned=inputs[index];
      if (!pinned || input.sql !== pinned.sql || input.role !== pinned.role || input.directory !== pinned.directory
        || input.sha256 !== pinned.sha256
        || sql !== `${pinned.sql.trim()}\nINSERT INTO d1_storage_migrations(name,sha256) VALUES('${pinned.name}','${pinned.sha256}');\n`)
        fail('REQUEST_NOT_PINNED');
      const request=requestFor(pinned,workerDirectory);
      if (!same(request.pin,candidate.steps[index]) || ++calls > candidate.steps.length) fail('REQUEST_NOT_PINNED');
      const target=candidate.targets[pinned.role];
      let response,value;
      try {
        ({response,value}=await submitMock(fetcher,`${API_ORIGIN}/accounts/${candidate.accountId}/d1/database/${target.databaseId}/query`,
          request.body,requestTimeoutMs));
      } catch {fail('PROVIDER_RESULT_UNCERTAIN');}
      if (!response.ok || value?.success !== true || !Array.isArray(value.result)
        || value.errors!==undefined&&(!Array.isArray(value.errors)||value.errors.length!==0)
        || value.result.length !== request.pin.resultCount || value.result.some(result => result?.success !== true
          || !Array.isArray(result.results) || result.results.length !== 0)) fail('PROVIDER_RESULT_UNCERTAIN');
    },
  };
  const result=await runMaintainedAnalyticsForwardLocal({workerDirectory,plan:candidate.localProof,adapter,operationDirectory,
    phase:'migrate',execute:true,confirmation:MAINTAINED_FORWARD_LOCAL_CONFIRMATION,
    approvedPlanSha256:identityDigest(candidate.localProof),resume,reconcileOnly,approvedReconciliationSha256,retryNotApplied});
  return {...result,transport:'synthetic-local',candidateSha256:identityDigest(candidate),hostedAcceptance:'unqualified',mockCalls:calls};
}
