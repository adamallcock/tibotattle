import {canonicalJson} from '../../src/canonical-json';
import {sha256Hex} from '../../src/crypto';

export const NATIVE_PREVIEW_COUNTER_CONTRACT='native-preview-cas-trace-v1';
type Row=Record<string,unknown>;
type Kind='upsert'|'refresh'|'retire';
const TABLE='analytics_community_graph_previews';
const columns=['source_id','revision','method','cohort_digest','authority_json','model_revision','payload_json','payload_sha256','generated_at','snapshot_source_epoch','inputs_current','oldest_computed_ms','newest_computed_ms'];
const sqlKey=(sql:string)=>sql.replace(/\s+/gu,' ').trim();
const schemaKey=(sql:string)=>sqlKey(sql.replace(/--[^\n]*/gu,''));
const leaseSql="AND EXISTS(SELECT 1 FROM analytics_partition_work WHERE work_key=? AND revision=? AND claim_token=? AND state='leased' AND claim_expires_ms>?)";
const closureSql="AND EXISTS(SELECT 1 FROM analytics_canonical_publication_closures WHERE closure_key=? AND state='complete')";
const refresh=`UPDATE analytics_community_graph_previews SET revision=revision+1,
 authority_json=?,snapshot_source_epoch=?,inputs_current=?,oldest_computed_ms=?,newest_computed_ms=?
 WHERE source_id=? AND revision=? AND cohort_digest=? AND payload_sha256=? AND snapshot_source_epoch<=?
 AND COALESCE((SELECT model_revision FROM analytics_community_graph_publication_state WHERE source_id=?),0)=?`;
const insertStart=`INSERT INTO analytics_community_graph_previews
 (source_id,revision,method,cohort_digest,authority_json,model_revision,payload_json,payload_sha256,generated_at,
 snapshot_source_epoch,inputs_current,oldest_computed_ms,newest_computed_ms)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE COALESCE((SELECT model_revision FROM analytics_community_graph_publication_state WHERE source_id=?),0)=?`;
const insertEnd=`ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,method=excluded.method,cohort_digest=excluded.cohort_digest,
 authority_json=excluded.authority_json,model_revision=excluded.model_revision,payload_json=excluded.payload_json,
 payload_sha256=excluded.payload_sha256,generated_at=excluded.generated_at,snapshot_source_epoch=excluded.snapshot_source_epoch,
 inputs_current=excluded.inputs_current,oldest_computed_ms=excluded.oldest_computed_ms,newest_computed_ms=excluded.newest_computed_ms
 WHERE analytics_community_graph_previews.revision=?
 AND analytics_community_graph_previews.snapshot_source_epoch<=?
 AND analytics_community_graph_previews.generated_at<=?`;
const retire=`DELETE FROM analytics_community_graph_previews WHERE source_id=?1 AND (method!=?2
 OR json_extract(authority_json,'$.sourceId') IS NOT ?1 OR json_extract(authority_json,'$.sourceNamespace') IS NOT ?3
 OR json_extract(authority_json,'$.policyRevision') IS NOT ?4 OR json_extract(authority_json,'$.collectionRevision') IS NOT ?5
 OR COALESCE(json_extract(authority_json,'$.publicAuthorityEpoch'),-1)<?6)`;
/** Exact native variants only; whitespace is insignificant, SQL tokens/binds are not changed. */
export function nativePreviewCounterSql(kind:Kind,options:{closure?:boolean;lease?:boolean}={}){
 if(kind==='retire'){if(options.closure||options.lease)throw Error('PREVIEW_COUNTER_SQL_VARIANT');return retire;}
 const suffix=[options.closure?closureSql:'',options.lease?leaseSql:''].join(' ');
 return kind==='refresh'?`${refresh} ${suffix}`:`${insertStart} ${suffix} ${insertEnd}`;
}
// These three literal, unbound batch members are native retirement schema reads.
// Do not generalize to other PRAGMAs, SQL variants, methods or bindings.
const retirementMetadataReads=new Map([
 ['PRAGMA table_info(analytics_partition_work)','partition_work_columns'],
 ['PRAGMA table_info(analytics_partition_canonical_effects)','canonical_effect_columns'],
 ['PRAGMA table_info(analytics_partition_effect_refs)','effect_reference_columns'],
] as const);
type StatementMethod='run'|'all'|'first'|'raw'|'batch';
type SqlGap='UNSUPPORTED_SQL_SHAPE'|'UNREVIEWED_TARGET_DDL'|'UNKNOWN_PREVIEW_WRITE'|'UNSUPPORTED_WRITE_METHOD';
const unsupportedFingerprintLimit=64;
const shapes=new Map<string,{kind:Kind;closure:boolean;lease:boolean}>();
for(const kind of ['upsert','refresh'] as const)for(const closure of [false,true])for(const lease of [false,true])
 shapes.set(sqlKey(nativePreviewCounterSql(kind,{closure,lease})),{kind,closure,lease});
shapes.set(sqlKey(retire),{kind:'retire',closure:false,lease:false});
const tableSql=`CREATE TABLE analytics_community_graph_previews (
 source_id TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>0),method TEXT NOT NULL,
 cohort_digest TEXT NOT NULL,authority_json TEXT NOT NULL CHECK(json_valid(authority_json)),
 model_revision INTEGER NOT NULL CHECK(model_revision>=0),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=262144),
 payload_sha256 TEXT NOT NULL,generated_at TEXT NOT NULL,
 snapshot_source_epoch INTEGER NOT NULL CHECK(snapshot_source_epoch>=0),
 inputs_current INTEGER NOT NULL CHECK(inputs_current IN(0,1)),
 oldest_computed_ms INTEGER,newest_computed_ms INTEGER,
 CHECK((oldest_computed_ms IS NULL AND newest_computed_ms IS NULL) OR
 (oldest_computed_ms IS NOT NULL AND newest_computed_ms IS NOT NULL
 AND oldest_computed_ms>=0 AND newest_computed_ms>=oldest_computed_ms))
) STRICT, WITHOUT ROWID`;
function triggerSql(operation:'insert'|'update') {return `CREATE TRIGGER analytics_preview_authority_${operation} BEFORE ${operation.toUpperCase()} ON analytics_community_graph_previews
WHEN json_type(NEW.authority_json,'$.publicAuthorityEpoch') IS NOT 'integer'
 OR json_extract(NEW.authority_json,'$.sourceId') IS NOT NEW.source_id
 OR json_extract(NEW.authority_json,'$.publicAuthorityEpoch')<max(
 COALESCE((SELECT authority_epoch FROM analytics_source_cursors WHERE source_id=NEW.source_id),0),
 COALESCE((SELECT max(public_authority_epoch) FROM analytics_storage_erasure_fences WHERE source_id=NEW.source_id),0))
BEGIN SELECT RAISE(ABORT,'analytics_publication_authority_stale'); END`;}
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const revision=(row:Row|null)=>row===null?null:row.revision as number;
export interface NativePreviewCounterProof {readonly receipt:Readonly<Record<string,unknown>>;}
const proved=new WeakMap<NativePreviewCounterProof,Row|null>();
/** Compare complete raw rows except the one counter separately justified by a private trace. */
export function assertNativePreviewCounterPair(reference:{row:Row;proof:NativePreviewCounterProof},candidate:{row:Row;proof:NativePreviewCounterProof}){
 for(const value of [reference,candidate])if(!proved.has(value.proof)||!same(proved.get(value.proof),value.row))throw Error('PREVIEW_COUNTER_UNPROVED_ROW');
 const without=(row:Row)=>Object.fromEntries(Object.entries(row).filter(([name])=>name!=='revision'));
 if(!same(without(reference.row),without(candidate.row)))throw Error('PREVIEW_COUNTER_NONCOUNTER_DIFFERENCE');
}
/** Local synthetic observer. The underlying SQL/binds/result are unchanged.
 * Before/after probes MUST use the same active 950 statement meter/profile. */
export function createNativePreviewCounter(sourceId:string){
 if(!/^synthetic-p11-[A-Za-z0-9:_-]{1,110}$/u.test(sourceId))throw Error('PREVIEW_COUNTER_SCOPE');
 let started=false,closed=false,busy=false,current:Row|null=null,initial:Row|null=null,schema:string|null=null;
 let probeDb:D1Database|undefined;
 const gaps=new Set<string>(),counts={upsert:0,refresh:0,retire:0,unchanged:0,failedWrites:0,unknownWrites:0,mutationAttempts:0};
 const observations={statements:0,rowsRead:0,rowsWritten:0,databaseMs:0,wallMs:0};
 const fingerprints=new Map<string,number>();
 const metadataReads=new Map<string,number>();
 const unsupported=new Map<string,{sha256:string;method:StatementMethod;attempts:number;reasons:SqlGap[]}>();
 let unsupportedAttempts=0,unsupportedOmittedAttempts=0;
 const classification=()=>({readOnlyMetadata:{statements:[...metadataReads.values()].reduce((sum,n)=>sum+n,0),
   shapes:[...metadataReads].map(([id,attempts])=>({id,method:'batch' as const,attempts}))},
  unsupported:{attempts:unsupportedAttempts,fingerprintLimit:unsupportedFingerprintLimit,
   omittedAttempts:unsupportedOmittedAttempts,overflow:unsupportedOmittedAttempts>0,
   fingerprints:[...unsupported.values()].map(value=>({...value,reasons:[...value.reasons]}))}});
 const recordUnsupported=async(sql:string,method:StatementMethod,reasons:SqlGap[])=>{
  unsupportedAttempts++;for(const reason of reasons)gaps.add(reason);
  const sha256=await sha256Hex(sql),key=method+':'+sha256,prior=unsupported.get(key);
  if(prior){prior.attempts++;for(const reason of reasons)if(!prior.reasons.includes(reason))prior.reasons.push(reason);}
  else if(unsupported.size<unsupportedFingerprintLimit)unsupported.set(key,{sha256,method,attempts:1,reasons:[...reasons]});
  else{unsupportedOmittedAttempts++;gaps.add('UNSUPPORTED_FINGERPRINT_BOUND');}
 };
 const fail=(reason:string):never=>{gaps.add(reason);throw Error('PREVIEW_COUNTER_'+reason);};
 const db=()=>probeDb??fail('NO_METERED_PROBE_HANDLE');
 const probe=async(sql:string,values:unknown[]=[])=>{const begin=performance.now();observations.statements++;
  try{const result=await db().prepare(sql).bind(...values).all<Row>();const meta=result.meta;
   if(result.success!==true||!['rows_read','rows_written','duration'].every(k=>{const value=Reflect.get(meta,k);return typeof value==='number'&&Number.isFinite(value)&&value>=0;}))fail('PROBE_METADATA');
   observations.rowsRead+=meta.rows_read;observations.rowsWritten+=meta.rows_written;observations.databaseMs+=meta.duration;return result.results;
  }catch(error){gaps.add('PROBE_FAILED');throw error;}finally{observations.wallMs+=performance.now()-begin;}};
 const readRow=async()=>{const rows=await probe(`SELECT * FROM analytics_community_graph_previews WHERE source_id=?`,[sourceId]);
  if(rows.length>1)fail('ROW_POPULATION');const row=rows[0]??null;
  if(row&&(row.source_id!==sourceId||!Number.isSafeInteger(row.revision)||Number(row.revision)<1||Object.keys(row).sort().join(',')!==[...columns].sort().join(',')))fail('ROW_SCHEMA');return row;};
 const readSchema=async()=>{const rows=await probe(`SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name LIMIT 2049`);
  if(rows.length>2048||new TextEncoder().encode(canonicalJson(rows)).byteLength>4*1024*1024)fail('SCHEMA_BOUND');
  const table=rows.filter(row=>row.type==='table'&&row.name===TABLE);
  if(table.length!==1||typeof table[0]!.sql!=='string'||schemaKey(table[0]!.sql)!==schemaKey(tableSql))fail('TABLE_SCHEMA');
  const triggers=rows.filter(row=>row.type==='trigger'&&typeof row.sql==='string'&&new RegExp('\\b'+TABLE+'\\b','iu').test(row.sql));
  if(triggers.length!==2)fail('TRIGGER_SCHEMA');
  for(const operation of ['insert','update'] as const){const trigger=triggers.find(row=>row.name===`analytics_preview_authority_${operation}`);
   if(!trigger||typeof trigger.sql!=='string'||schemaKey(trigger.sql)!==schemaKey(triggerSql(operation)))fail('TRIGGER_SCHEMA');}
  return canonicalJson(rows);};
 const inspect=async(sql:string,bound:readonly unknown[],method:StatementMethod)=>{
  const metadata=retirementMetadataReads.get(sql as Parameters<typeof retirementMetadataReads.get>[0]);
  if(metadata&&method==='batch'&&bound.length===0){metadataReads.set(metadata,(metadataReads.get(metadata)??0)+1);return;}
  const key=sqlKey(sql),known=shapes.get(key);
  const tokens=key.replace(/\/\*[\s\S]*?\*\//gu,' ').replace(/--[^\n]*/gu,' ').trim();
  const reasons:SqlGap[]=[];
  if(!/^(?:SELECT|WITH|INSERT|UPDATE|DELETE)\b/iu.test(tokens))reasons.push('UNSUPPORTED_SQL_SHAPE');
  if(/^(?:CREATE|DROP|ALTER|ATTACH|DETACH|VACUUM|REINDEX|PRAGMA)\b/iu.test(tokens))reasons.push('UNREVIEWED_TARGET_DDL');
  if(!known&&new RegExp('\\b'+TABLE+'\\b','iu').test(key)&&!/^SELECT\b/iu.test(key)){counts.unknownWrites++;reasons.push('UNKNOWN_PREVIEW_WRITE');}
  if(known&&method!=='run'&&method!=='batch')reasons.push('UNSUPPORTED_WRITE_METHOD');
  if(reasons.length)await recordUnsupported(sql,method,reasons);
  return known;};
 const mutate=async<T>(sql:string,bound:unknown[],known:NonNullable<Awaited<ReturnType<typeof inspect>>>,run:()=>Promise<T>)=>{
  if(!started||closed)fail('LIFECYCLE');if(busy)fail('CONCURRENT_WRITE');if(counts.mutationAttempts>=100000)fail('ATTEMPT_BOUND');busy=true;counts.mutationAttempts++;
  const key=sqlKey(sql);fingerprints.set(key,(fingerprints.get(key)??0)+1);
  try{if(await readSchema()!==schema)fail('SCHEMA_CHANGED');const before=await readRow();if(!same(before,current))fail('UNOBSERVED_ROW_CHANGE');
   const extra=(known.closure?1:0)+(known.lease?4:0),expectedCount=known.kind==='upsert'?18+extra:known.kind==='refresh'?12+extra:6;
   if(bound.length!==expectedCount||bound[known.kind==='refresh'?5:0]!==sourceId||known.kind!=='retire'&&bound[known.kind==='refresh'?10:13]!==sourceId)fail('BIND_SCOPE');
   const expected=known.kind==='upsert'?bound[bound.length-3]:known.kind==='refresh'?bound[6]:null;
   if(known.kind!=='retire'&&(!Number.isSafeInteger(expected)||Number(expected)<0))fail('EXPECTED_CAS');
   if(known.kind==='upsert'&&bound[1]!==Number(expected)+1)fail('PROPOSED_REVISION');
   let result:T;try{result=await run();}catch(error){counts.failedWrites++;gaps.add('NATIVE_WRITE_FAILED_OR_RESPONSE_LOST');throw error;}
   if((result as {success?:boolean})?.success!==true)fail('NATIVE_WRITE_RESULT');
   const after=await readRow();
   if(same(before,after)){counts.unchanged++;return result;}
   if(known.kind==='retire'){if(before===null||after!==null)fail('DELETE_TRANSITION');}
   else{
    if((before===null?0:revision(before))!==expected||after===null||revision(after)!==Number(expected)+1)fail('COUNTER_TRANSITION');
    const wanted=known.kind==='upsert'?Object.fromEntries(columns.map((name,index)=>[name,bound[index]]))
     :before===null?fail('REFRESH_ABSENT'):{...before,revision:Number(expected)+1,...Object.fromEntries(['authority_json','snapshot_source_epoch','inputs_current','oldest_computed_ms','newest_computed_ms'].map((name,index)=>[name,bound[index]]))};
    if(!same(after,wanted))fail('FULL_ROW_TRANSITION');
   }
   counts[known.kind]++;current=structuredClone(after);return result;
  }finally{busy=false;}
 };
 const wrap=(target:D1Database):D1Database=>{
  const prepared=new WeakMap<D1PreparedStatement,{original:D1PreparedStatement;sql:string;bound:unknown[]}>();
  const statement=(original:D1PreparedStatement,sql:string,bound:unknown[]=[]):D1PreparedStatement=>{
   const value=new Proxy(original,{get(inner,key){
    if(key==='bind')return(...values:unknown[])=>statement(inner.bind(...values),sql,values);
    if(['run','all','first','raw'].includes(String(key)))return async(...args:unknown[])=>{
     const known=await inspect(sql,bound,key as StatementMethod),method=Reflect.get(inner,key) as (...args:unknown[])=>Promise<unknown>;
     const run=()=>Reflect.apply(method,inner,args) as Promise<unknown>;
     if(known&&key!=='run')fail('UNSUPPORTED_WRITE_METHOD');return known?mutate(sql,bound,known,run):run();};
    const member:unknown=Reflect.get(inner,key);return typeof member==='function'?member.bind(inner):member;
   }});prepared.set(value,{original,sql,bound});return value;};
  return new Proxy(target,{get(inner,key){
   if(key==='prepare')return(sql:string)=>statement(inner.prepare(sql),sql);
   if(key==='batch')return async(items:D1PreparedStatement[])=>{
    const entries=items.map(item=>prepared.get(item));if(entries.some(item=>!item))fail('FOREIGN_BATCH');
    const inspected=await Promise.all(entries.map(async(item,index)=>({item:item!,index,known:await inspect(item!.sql,item!.bound,'batch')})));
    const writes=inspected.flatMap(({item,index,known})=>known?[{...item,known,index}]:[]);
    if(writes.length>1)fail('MULTIPLE_BATCH_WRITES');
    const run=()=>inner.batch(entries.map(item=>item!.original));if(!writes.length)return run();
    const write=writes[0]!;let results:D1Result[]|undefined;
    await mutate(write.sql,write.bound,write.known,async()=>{results=await run();if(results.length!==entries.length)fail('BATCH_RESULT_COUNT');return results[write.index]!;});return results!;
   };
   if(['exec','dump','withSession'].includes(String(key)))return()=>fail('UNSUPPORTED_TARGET_METHOD');
   const member:unknown=Reflect.get(inner,key);return typeof member==='function'?member.bind(inner):member;
  }});
 };
 return {wrap,enterInvocation(meteredTarget:D1Database){if(probeDb)fail('OVERLAPPING_INVOCATION');probeDb=meteredTarget;return()=>{probeDb=undefined;};},
  async start(expected:Row|null){if(started||closed)fail('LIFECYCLE');schema=await readSchema();current=await readRow();if(!same(current,expected))fail('STARTUP_ROW');initial=structuredClone(current);started=true;},
  async finish(expected:Row|null):Promise<NativePreviewCounterProof>{if(!started||closed||busy)fail('LIFECYCLE');
   const final=await readRow();if(!same(final,current)||!same(final,expected))fail('FINAL_ROW');if(await readSchema()!==schema)fail('SCHEMA_CHANGED');if(gaps.size)fail('INCOMPLETE_TRACE');
   const proof={receipt:Object.freeze({contract:NATIVE_PREVIEW_COUNTER_CONTRACT,complete:true,initialRevision:revision(initial),finalRevision:revision(final),counts:{...counts},gaps:[],
    initialRowSha256:await sha256Hex(canonicalJson(initial)),finalRowSha256:await sha256Hex(canonicalJson(final)),schemaSha256:await sha256Hex(schema!),
    nonCounterColumnsSha256:await sha256Hex(canonicalJson(final===null?null:Object.fromEntries(Object.entries(final).filter(([name])=>name!=='revision')))),
    observationCost:{...observations,includedInInvocationMeter:true,includedInWorkloadProfile:true},
    shapes:await Promise.all([...fingerprints].map(async([sql,attempts])=>({sha256:await sha256Hex(sql),attempts}))),
    nativeSqlUnchanged:true,bindsUnchanged:true,callerResultsUnchanged:true})};proved.set(proof,structuredClone(final));closed=true;return proof;},
  diagnostic(){return {contract:NATIVE_PREVIEW_COUNTER_CONTRACT,complete:false,counts:{...counts},gaps:[...gaps].sort(),observationCost:{...observations},classification:classification()};},
  close(){closed=true;probeDb=undefined;schema=null;current=null;initial=null;fingerprints.clear();metadataReads.clear();unsupported.clear();},
 };
}

/** First functional branches have no native preview writes in their action.
 * Refuse such a write before execution; this is not a substitute counter trace. */
export function createNativePreviewActionGuard(target:D1Database){
 let attempts=0,unsupported=0;
 const check=(sql:string)=>{const tokens=sql.replace(/\/\*[\s\S]*?\*\//gu,' ').replace(/--[^\n]*/gu,' ').trim();
  if(/^(?:CREATE|DROP|ALTER|ATTACH|DETACH|VACUUM|REINDEX|PRAGMA)\b/iu.test(tokens)){unsupported++;throw Error('PREVIEW_ACTION_SCHEMA_MUTATION');}
  if(new RegExp('\\b'+TABLE+'\\b','iu').test(tokens)&&!/^SELECT\b/iu.test(tokens)){attempts++;throw Error('PREVIEW_ACTION_MUTATION');}
 };
 const prepared=new WeakMap<D1PreparedStatement,{original:D1PreparedStatement;sql:string}>();
 const statement=(original:D1PreparedStatement,sql:string):D1PreparedStatement=>{const value=new Proxy(original,{get(inner,key){
  if(key==='bind')return(...values:unknown[])=>statement(inner.bind(...values),sql);
  if(['run','all','first','raw'].includes(String(key)))return(...args:unknown[])=>{check(sql);return Reflect.apply(Reflect.get(inner,key) as (...args:unknown[])=>unknown,inner,args);};
  const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
 }});prepared.set(value,{original,sql});return value;};
 const database=new Proxy(target,{get(inner,key){
  if(key==='prepare')return(sql:string)=>statement(inner.prepare(sql),sql);
  if(key==='batch')return(items:D1PreparedStatement[])=>{const entries=items.map(item=>prepared.get(item));if(entries.some(item=>!item)){unsupported++;throw Error('PREVIEW_ACTION_FOREIGN_BATCH');}
   for(const entry of entries)check(entry!.sql);return inner.batch(entries.map(entry=>entry!.original));};
  if(['exec','dump','withSession'].includes(String(key)))return()=>{unsupported++;throw Error('PREVIEW_ACTION_UNSUPPORTED_METHOD');};
  const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
 }});
 return {target:database,assertNoMutation(){if(attempts||unsupported)throw Error('PREVIEW_ACTION_INCOMPLETE');return {contract:'native-preview-zero-action-writes-v1',previewMutationAttempts:0,unsupportedAttempts:0};}};
}
