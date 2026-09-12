import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { build } from 'esbuild';
import { dependencyTreeDigest } from './production-deploy.mjs';
import { identityDigest, operationError } from '../../../scripts/lib/release-operation.mjs';

const fail=code=>{throw operationError(`PRODUCTION_MAINTENANCE_REGISTRATION_${code}`);};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// Exact statements currently used by initializeStorageAnalyticsRuntime. A
// future runtime query change requires explicit adapter review, not a prefix
// allowlist. No other database, SQL, batch or mutation is exposed to the API.
const SQL=Object.freeze({
 targetGuard:"SELECT 1 FROM sqlite_schema WHERE type='table' AND name IN ('participants','storage_source_state') LIMIT 1",
 source:`SELECT s.source_id,a.source_namespace AS v1_namespace,b.source_namespace AS v11_namespace
  FROM storage_source_state s JOIN typed_v1_admission_state a ON a.id=1 AND a.runtime_contract_version=1
  JOIN typed_v11_admission_state b ON b.id=1 AND b.runtime_contract_version=1 WHERE s.singleton=1`,
 registration:'SELECT source_namespace,contract_version FROM analytics_runtime_sources WHERE source_id=?',
 insert:`INSERT INTO analytics_runtime_sources(source_id,source_namespace,contract_version)
  VALUES(?,?,1) ON CONFLICT(source_id) DO NOTHING`,
 cursor:`SELECT c.sequence,c.authority_epoch AS cursor_epoch,
   e.event_digest,e.owner_digest,e.revision,e.kind,e.object_digest,e.content_digest,
   e.authority_epoch,e.public_authority_epoch,e.recorded_ms
  FROM analytics_source_cursors c LEFT JOIN analytics_applied_events e
   ON e.source_id=c.source_id AND e.sequence=c.sequence WHERE c.source_id=?`,
 event:`SELECT 1 FROM storage_ingestion_changes
  WHERE sequence=? AND event_digest=? AND owner_digest=? AND revision=? AND kind=?
   AND object_digest=? AND content_digest=? AND authority_epoch=? AND public_authority_epoch=? AND recorded_ms=?`,
});
export const MAINTENANCE_ANALYTICS_REGISTRATION_SQL=Object.freeze(Object.values(SQL));
export const MAINTENANCE_ANALYTICS_REGISTRATION_INSERT=SQL.insert;

function pin(cutover){
 const c=cutover?.candidate;
 if(!c||!UUID.test(c.ingestionDatabaseId)||!UUID.test(c.analyticsDatabaseId)||c.ingestionDatabaseId===c.analyticsDatabaseId
  ||!/^[a-f0-9]{40}$/.test(c.sourceCommit)||!/^[a-f0-9]{64}$/.test(c.dependencyDigest)
  ||!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(c.sourceId)
  ||typeof c.sourceNamespace!=='string'||!c.sourceNamespace.length||c.sourceNamespace.length>256
  ||c.sourceNamespace.includes('\0')||Buffer.from(c.sourceNamespace).toString()!==c.sourceNamespace)fail('PINS_INVALID');
 return {sourceCommit:c.sourceCommit,dependencyDigest:c.dependencyDigest,sourceId:c.sourceId,sourceNamespace:c.sourceNamespace,
  ingestionDatabaseId:c.ingestionDatabaseId,analyticsDatabaseId:c.analyticsDatabaseId};
}
/** Suitable for retention in the parent journal before the one exact INSERT.
 * It is a statement/identity pin, not permission or evidence of execution. */
export function maintenanceAnalyticsRegistrationIntent(cutover){
 const p=pin(cutover);return {schema:'maintenance-analytics-registration-intent-v1',pinDigest:identityDigest(p),
  databaseId:p.analyticsDatabaseId,statementDigest:identityDigest(SQL.insert),parametersDigest:identityDigest([p.sourceId,p.sourceNamespace])};
}
async function source(p,sourceDirectory){
 const worker=resolve(sourceDirectory),root=resolve(worker,'../..');
 if(worker!==join(root,'apps/worker')||await realpath(root)!==root||await realpath(worker)!==worker)fail('SOURCE_CHANGED');
 const git=args=>execFileSync('/usr/bin/git',['-c',`core.excludesFile=${join(dirname(root),'git-exclude')}`,'-C',root,...args],{encoding:'utf8',maxBuffer:1024*1024}).trim();
 if(git(['rev-parse','HEAD'])!==p.sourceCommit||git(['status','--porcelain','--untracked-files=all']))fail('SOURCE_CHANGED');
 if(await dependencyTreeDigest(join(worker,'node_modules'))!==p.dependencyDigest)fail('DEPENDENCIES_CHANGED');
 return worker;
}
function session(p,queryDatabase){
 if(typeof queryDatabase!=='function')fail('TRANSPORT_INVALID');
 let queries=0,bytes=0,writeAttempted=false;const evidence=[];
 const query=async(id,sql,params=[],write=false)=>{
  const isSource=id===p.ingestionDatabaseId;
  if(![p.ingestionDatabaseId,p.analyticsDatabaseId].includes(id)||!MAINTENANCE_ANALYTICS_REGISTRATION_SQL.includes(sql)
   ||!Array.isArray(params)||params.length>10||params.some(v=>!['string','number'].includes(typeof v)||typeof v==='number'&&!Number.isSafeInteger(v))
   ||++queries>24)fail('QUERY_NOT_ADMITTED');
  if(isSource!==[SQL.source,SQL.event].includes(sql))fail('QUERY_NOT_ADMITTED');
  if(sql===SQL.insert){
   if(!write||writeAttempted||identityDigest(params)!==identityDigest([p.sourceId,p.sourceNamespace]))fail('WRITE_NOT_ADMITTED');
   writeAttempted=true;
  }else if(write)fail('WRITE_NOT_ADMITTED');
  let r;try{r=await queryDatabase(id,sql,params);}catch{fail(write?'WRITE_UNCERTAIN':'READ_UNCERTAIN');}
  if(r?.success!==true||!Array.isArray(r.results)||r.results.length>1)fail(write?'WRITE_UNCERTAIN':'READ_INVALID');
  const encoded=JSON.stringify(r.results);bytes+=Buffer.byteLength(encoded);if(bytes>65536)fail(write?'WRITE_UNCERTAIN':'READ_INVALID');
  evidence.push({databaseId:id,statementDigest:identityDigest(sql),parametersDigest:identityDigest(params),resultsDigest:identityDigest(r.results),write});
  return r;
 };
 const first=async(id,sql,params=[])=>(await query(id,sql,params)).results[0]??null;
 const binding=id=>({prepare(sql){
  if(!MAINTENANCE_ANALYTICS_REGISTRATION_SQL.includes(sql))fail('QUERY_NOT_ADMITTED');
  const statement=params=>Object.freeze({
   bind(...values){if(params.length)fail('QUERY_NOT_ADMITTED');return statement(values);},
   first(column){if(column!==undefined)fail('QUERY_NOT_ADMITTED');return first(id,sql,params);},
   run(){return query(id,sql,params,true);},
  });return statement([]);
 }});
 return {first,bindings:{source:binding(p.ingestionDatabaseId),target:binding(p.analyticsDatabaseId),sourceId:p.sourceId,sourceNamespace:p.sourceNamespace},
  receipt:()=>({queries,writeAttempted,readEvidenceDigest:identityDigest(evidence)})};
}
const same=(a,b,code)=>{if(identityDigest(a)!==identityDigest(b))fail(code);};
async function inspect(p,s){
 if(await s.first(p.analyticsDatabaseId,SQL.targetGuard))fail('TARGET_ROLE_INVALID');
 same(await s.first(p.ingestionDatabaseId,SQL.source),{source_id:p.sourceId,v1_namespace:p.sourceNamespace,v11_namespace:p.sourceNamespace},'SOURCE_ROLE_INVALID');
 const registration=await s.first(p.analyticsDatabaseId,SQL.registration,[p.sourceId]);
 if(registration)same(registration,{source_namespace:p.sourceNamespace,contract_version:1},'REGISTRATION_CONFLICT');
 const cursor=await s.first(p.analyticsDatabaseId,SQL.cursor,[p.sourceId]);
 if(cursor){
  if(!Number.isSafeInteger(cursor.sequence)||cursor.sequence<0||(!registration&&cursor.sequence!==0))fail('CONTINUITY_REQUIRED');
  if(cursor.sequence===0){if(cursor.cursor_epoch!==0||cursor.event_digest!==null)fail('CONTINUITY_REQUIRED');}
  else{
   if(!cursor.event_digest||cursor.cursor_epoch!==cursor.public_authority_epoch)fail('CONTINUITY_REQUIRED');
   const matched=await s.first(p.ingestionDatabaseId,SQL.event,[cursor.sequence,cursor.event_digest,cursor.owner_digest,cursor.revision,cursor.kind,
    cursor.object_digest,cursor.content_digest,cursor.authority_epoch,cursor.public_authority_epoch,cursor.recorded_ms]);
   if(!matched)fail('CONTINUITY_REQUIRED');
  }
 }
 return registration?'present':'absent';
}
function result(p,s,state){return {schema:'maintenance-analytics-registration-v1',state,pinDigest:identityDigest(p),
 sourceCommit:p.sourceCommit,sourceId:p.sourceId,sourceNamespace:p.sourceNamespace,...s.receipt(),
 registrationOnly:true,analyticsCaughtUp:false,privacyReady:false};}

/** Stopped-executor reconciliation. Missing state permits a separately approved
 * retry; matching state proves the exact registration committed. Never writes,
 * never starts analytics and never interprets registration as catchup/privacy. */
export async function readMaintenanceAnalyticsRegistration({cutover,sourceDirectory,queryDatabase}){
 const p=pin(cutover);await source(p,sourceDirectory);const s=session(p,queryDatabase),state=await inspect(p,s);
 await source(p,sourceDirectory);return result(p,s,state);
}

/** Parent must persist its exact intent and old-source rollback latch first.
 * Invoke the maintained initializer through the closed adapter, with one INSERT
 * at most. Any lost result or later failure leaves parent reconciliation due;
 * this helper never retries or deletes/overwrites a conflicting registration. */
export async function initializeMaintenanceAnalyticsRegistration({cutover,sourceDirectory,queryDatabase}){
 const p=pin(cutover),worker=await source(p,sourceDirectory),s=session(p,queryDatabase);
 if(await inspect(p,s)==='present'){await source(p,sourceDirectory);return result(p,s,'present');}
 const built=await build({stdin:{contents:"export {initializeStorageAnalyticsRuntime} from './storage-analytics-runtime';",resolveDir:join(worker,'src'),loader:'ts'},
  bundle:true,write:false,format:'esm',platform:'node',mainFields:['module','main'],logLevel:'silent'});
 if(built.outputFiles.length!==1||built.outputFiles[0].contents.length>2*1024*1024)fail('RUNTIME_CONTRACT_INVALID');
 let runtime;try{runtime=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);}catch{fail('RUNTIME_CONTRACT_INVALID');}
 await source(p,sourceDirectory);
 try{await runtime.initializeStorageAnalyticsRuntime(s.bindings);}catch(error){
  if(/^PRODUCTION_MAINTENANCE_REGISTRATION_[A-Z_]+$/.test(error?.code??''))throw error;
  fail(s.receipt().writeAttempted?'WRITE_UNVERIFIED':'RUNTIME_REFUSED');
 }
 if(!s.receipt().writeAttempted)fail('RUNTIME_CONTRACT_INVALID');
 if(await inspect(p,s)!=='present')fail('WRITE_UNVERIFIED');
 await source(p,sourceDirectory);return result(p,s,'present');
}
