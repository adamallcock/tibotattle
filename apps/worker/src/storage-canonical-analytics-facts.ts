import { D1InvocationBudgetExceededError,readD1SchemaObjectsAvailable } from './d1-invocation-budget';
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { CANONICAL_ANALYTICS_SCHEMA, CANONICAL_NULLABLE_FIELDS, CANONICAL_NATIVE_SCOPE_FIELDS, CANONICAL_NATIVE_SCOPES_SCHEMA, MAX_CANONICAL_EFFECT_PAGE,
  MAX_CANONICAL_PARTITION_ROWS, canonicalDigest, canonicalInteger, canonicalFail, canonicalErasureKey, canonicalDay,
  canonicalRevisionRef, reconcileCanonicalEffect, compareCanonicalFacts,
  type CanonicalEffect, type CanonicalFact, type CanonicalScope, type CanonicalValues, type CanonicalNativeScopes,
  type CanonicalRevisionRef, type CanonicalSourceVariant } from './canonical-analytics-facts';

export const CANONICAL_ANALYTICS_TABLES = Object.freeze(['analytics_canonical_facts','analytics_canonical_variants',
  'analytics_canonical_days','analytics_canonical_tools','analytics_canonical_heads','analytics_canonical_pages',
  'analytics_canonical_effects','analytics_canonical_dirty_partitions','analytics_canonical_manifests',
  'analytics_canonical_manifest_rows','analytics_canonical_partition_heads']);
const REQUIRED_TRIGGERS = ['fact_admit','fact_immutable','page_admit','page_seal','effect_admit','effect_apply',
  'effect_immutable','manifest_seal','fact_remove','owner_terminal','erasure','owner_delete',
  'variants_immutable','days_immutable','tools_immutable','manifest_rows_immutable']
  .map(name=>`analytics_canonical_${name}`);
export async function canonicalAnalyticsAvailable(db: D1Database): Promise<boolean> {
  return readD1SchemaObjectsAvailable(db,[...CANONICAL_ANALYTICS_TABLES.map(name=>['table',name] as const),
    ...REQUIRED_TRIGGERS.map(name=>['trigger',name] as const)]);
}
const VALUE_COLUMNS = CANONICAL_NULLABLE_FIELDS.map(name=>name.replace(/[A-Z]/gu,letter=>'_'+letter.toLowerCase()));
const EXTENSIONS = ['boundaryFlags','tieOrder','cacheWriteFiveMinuteTokens','cacheWriteOneHourTokens'] as const;
const EXTENSION_COLUMNS = EXTENSIONS.map(name=>name.replace(/[A-Z]/gu,letter=>'_'+letter.toLowerCase()));
const BASE_COLUMNS = ['revision','occurrence_key','source_id','owner_digest','erasure_key','stream','selection_method',
  'status','partition_key','observed_day','observed_at_ms','order_scope_key','native_order','provenance_digest','coverage',
  'reported_fields','conflicted_fields','account_basis','plan_basis'];
const NATIVE_SCOPE_COLUMNS = CANONICAL_NATIVE_SCOPE_FIELDS.map(name=>'native_'+name.replace(/[A-Z]/gu,letter=>'_'+letter.toLowerCase()));
const FACT_COLUMNS = [...BASE_COLUMNS,...VALUE_COLUMNS,...NATIVE_SCOPE_COLUMNS,...EXTENSION_COLUMNS.flatMap(column=>[column+'_presence',column])];
type StoredFact = Record<string,string|number|null>;
interface VariantRow {revision:string;variant_key:string;kind:CanonicalSourceVariant['kind'];format:CanonicalSourceVariant['format'];observed_at_ms:number}
interface DayRow {revision:string;day:string}
interface ToolRow {revision:string;tool_class:string;count:number}
function closedKeys(value: object, keys: readonly string[]) {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) canonicalFail();
}
export async function validateCanonicalFact(fact: CanonicalFact): Promise<void> {
  closedKeys(fact,['schema','occurrenceKey','revision','stream','status','location','provenance','values','reportedFields',
    'conflictedFields','accountBasis','planBasis','nativeScopes',...EXTENSIONS,'toolCounts']);
  closedKeys(fact.values,CANONICAL_NULLABLE_FIELDS);
  closedKeys(fact.nativeScopes,['schema',...CANONICAL_NATIVE_SCOPE_FIELDS]);
  if(fact.nativeScopes.schema!==CANONICAL_NATIVE_SCOPES_SCHEMA)canonicalFail();
  const quotaId=fact.nativeScopes.quotaOccurrenceId;
  if(quotaId!==null&&(fact.stream!=='quota'||fact.status!=='compatible'||typeof quotaId!=='string'
    ||!/^quota-occurrence:v1:[a-f0-9]{64}$/u.test(quotaId)))canonicalFail();
  for(const key of ['cacheSessionDigest','graphSessionDigest','scalarSessionDigest'] as const)
    if(fact.nativeScopes[key]!==null)canonicalDigest(fact.nativeScopes[key]);
  for(const [key,prefix] of [['accountTrackId','account-track:v2:'],['planEraId','plan-era:v1:']] as const) {
    const value=fact.nativeScopes[key];
    if(value!==null&&(typeof value!=='string'||!value.startsWith(prefix)||!/^[a-f0-9]{64}$/u.test(value.slice(prefix.length))))canonicalFail();
  }
  canonicalDigest(fact.nativeScopes.logicalOccurrenceKey);canonicalInteger(fact.nativeScopes.occurrenceTieOrder);
  if(!['effective','v1','v11'].includes(fact.nativeScopes.sourceFamily))canonicalFail();
  if(fact.nativeScopes.sourceFamily==='effective'){
    if(fact.provenance.selectionMethod!=='effective-union-v1'||fact.nativeScopes.selectedSlotKey!==null
      ||fact.nativeScopes.logicalOccurrenceKey!==fact.occurrenceKey)canonicalFail();
  }else{canonicalDigest(fact.nativeScopes.selectedSlotKey);if(fact.provenance.selectionMethod!=='legacy-selected-v1')canonicalFail();}
  if(fact.status!=='compatible'&&(['cacheSessionDigest','graphSessionDigest','scalarSessionDigest','accountTrackId','planEraId'] as const)
    .some(key=>fact.nativeScopes[key]!==null))canonicalFail();
  closedKeys(fact.location,['partitionKey','day','observedAtMs','sessionKey','orderScopeKey','nativeOrder']);
  closedKeys(fact.provenance,['digest','selectionMethod','erasureKey','linkedDays','variants','coverage']);
  for (const extension of EXTENSIONS) closedKeys(fact[extension],['presence','value']);
  for (const variant of fact.provenance.variants) closedKeys(variant,['sourceVariantKey','kind','format','observedAtMs']);
  for (const tool of fact.toolCounts) closedKeys(tool,['toolClass','count']);
  if (fact.schema !== CANONICAL_ANALYTICS_SCHEMA || !['usage','quota','session'].includes(fact.stream)
    || fact.provenance.variants.length > 16_384 || fact.provenance.linkedDays.length > 16_384 || fact.toolCounts.length > 32
    || fact.location.partitionKey !== `${fact.provenance.selectionMethod}/${fact.stream}/${fact.location.day ?? 'unknown'}/${fact.occurrenceKey.slice(0,2)}`) canonicalFail();
  canonicalDigest(fact.revision);canonicalDigest(fact.occurrenceKey);canonicalDigest(fact.provenance.digest);canonicalDigest(fact.provenance.erasureKey);
  const {revision,...body}=fact;
  if (await sha256Hex(canonicalJson(body)) !== revision) canonicalFail();
  const {digest,...provenance}=fact.provenance;
  if (await sha256Hex(canonicalJson(provenance)) !== digest) canonicalFail();
}
/** Reads only allowlisted canonical columns. Bounded references can span owners;
 * no raw source records or compatibility decoder is involved. */
export async function readCanonicalFacts(db: D1Database, revisions: readonly string[]): Promise<CanonicalFact[]> {
  if (revisions.length > MAX_CANONICAL_PARTITION_ROWS) canonicalFail('CANONICAL_LIMIT');
  if (!revisions.length) return [];
  revisions.forEach(canonicalDigest);
  const parameter=JSON.stringify([...new Set(revisions)]);
  const results = await db.batch<StoredFact | VariantRow | DayRow | ToolRow>([
    db.prepare(`SELECT f.* FROM analytics_canonical_facts f JOIN analytics_owner_state o
      ON o.source_id=f.source_id AND o.owner_digest=f.owner_digest AND o.state='active'
      WHERE f.revision IN(SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e
      WHERE e.source_id=f.source_id AND e.owner_digest=f.owner_digest)`).bind(parameter),
    db.prepare('SELECT * FROM analytics_canonical_variants WHERE revision IN(SELECT value FROM json_each(?)) ORDER BY variant_key LIMIT 16385').bind(parameter),
    db.prepare('SELECT * FROM analytics_canonical_days WHERE revision IN(SELECT value FROM json_each(?)) ORDER BY day LIMIT 16385').bind(parameter),
    db.prepare('SELECT * FROM analytics_canonical_tools WHERE revision IN(SELECT value FROM json_each(?)) ORDER BY tool_class LIMIT 4097').bind(parameter),
  ]);
  const rows=results[0]!.results as StoredFact[],variants=results[1]!.results as VariantRow[],
    days=results[2]!.results as DayRow[],tools=results[3]!.results as ToolRow[];
  if(variants.length>16384||days.length>16384||tools.length>4096)canonicalFail('CANONICAL_LIMIT');
  const output:CanonicalFact[]=[];
  for (const row of rows) {
    const values=Object.fromEntries(CANONICAL_NULLABLE_FIELDS.map((key,index)=>[key,row[VALUE_COLUMNS[index]!]!])) as CanonicalValues;
    const extension=Object.fromEntries(EXTENSIONS.map((key,index)=>[key,{presence:row[EXTENSION_COLUMNS[index]!+'_presence'],value:row[EXTENSION_COLUMNS[index]!]!}])) as Pick<CanonicalFact,typeof EXTENSIONS[number]>;
    const fact:CanonicalFact={schema:CANONICAL_ANALYTICS_SCHEMA,occurrenceKey:row.occurrence_key as string,revision:row.revision as string,
      stream:row.stream as CanonicalFact['stream'],status:row.status as CanonicalFact['status'],
      location:{partitionKey:row.partition_key as string,day:row.observed_day as string|null,observedAtMs:row.observed_at_ms as number|null,
        sessionKey:values.sessionKey,orderScopeKey:row.order_scope_key as string,nativeOrder:row.native_order as number},
      provenance:{digest:row.provenance_digest as string,selectionMethod:row.selection_method as CanonicalScope['selectionMethod'],
        erasureKey:row.erasure_key as string,coverage:row.coverage as 'complete'|'unknown',
        variants:variants.filter(v=>v.revision===row.revision).map(v=>({sourceVariantKey:v.variant_key,kind:v.kind,format:v.format,observedAtMs:v.observed_at_ms})),
        linkedDays:days.filter(v=>v.revision===row.revision).map(v=>v.day)},values,
      nativeScopes:{schema:CANONICAL_NATIVE_SCOPES_SCHEMA,...Object.fromEntries(CANONICAL_NATIVE_SCOPE_FIELDS.map((key,index)=>[key,row[NATIVE_SCOPE_COLUMNS[index]!]!]))} as CanonicalNativeScopes,
      reportedFields:row.reported_fields as number,conflictedFields:row.conflicted_fields as number,
      accountBasis:row.account_basis as string,planBasis:row.plan_basis as string,...extension,
      toolCounts:tools.filter(v=>v.revision===row.revision).map(v=>({toolClass:v.tool_class,count:v.count}))};
    await validateCanonicalFact(fact);output.push(fact);
  }
  return output.sort(compareCanonicalFacts);
}
export interface CanonicalPageAuthority {
  readonly sourceId:string; readonly scope:CanonicalScope;readonly ownerRevision:number;readonly authorityEpoch:number;
}
async function assertAuthority(db:D1Database,input:CanonicalPageAuthority):Promise<void> {
  canonicalDigest(input.scope.ownerDigest);canonicalInteger(input.ownerRevision,1);canonicalInteger(input.authorityEpoch,1);
  if(!/^[A-Za-z0-9._:-]{1,128}$/u.test(input.sourceId))canonicalFail();
  const ready=await db.prepare(`SELECT 1 ready FROM analytics_owner_state o JOIN analytics_runtime_sources s ON s.source_id=o.source_id
    WHERE o.source_id=? AND o.owner_digest=? AND o.revision=? AND o.authority_epoch=? AND o.state='active'
    AND s.source_namespace=? AND s.contract_version=1 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e
    WHERE e.source_id=o.source_id AND e.owner_digest=o.owner_digest)`).bind(input.sourceId,input.scope.ownerDigest,input.ownerRevision,
      input.authorityEpoch,input.scope.sourceNamespace).first<number>('ready');
  if(ready!==1)canonicalFail('CANONICAL_CONFLICT');
}
export interface CanonicalPageUpdate {
  readonly occurrenceKey:string; readonly stream:CanonicalFact['stream']; readonly expectedRevision:string|null;
  readonly fact:CanonicalFact|null;
}
export interface MaterializeCanonicalPageInput extends CanonicalPageAuthority {
  readonly db:D1Database;
  /** Stable logical work page and exact accepted input proof. Neither is an upload/device job identifier. */
  readonly pageKey:string;readonly sourceRevision:string;
  /** Optional acquisition lease, enforced in the same transaction as head CAS. */
  readonly inputLease?: {readonly scopeKey:string;readonly claimToken:string;readonly version:number;readonly nowMs:number};
  /** Expands/normalizes at most 16 complete occurrence groups. Not called on accepted replay. */
  readonly load:()=>Promise<readonly CanonicalPageUpdate[]>;
  /** Revalidates the same sealed source proof, including authority and clock boundaries. */
  readonly stillCurrent:()=>Promise<boolean>;
}
interface EffectRow {selection_method:CanonicalScope['selectionMethod'];effect_key:string;change_key:string;occurrence_key:string;stream:CanonicalFact['stream'];erasure_key:string;
  authority_revision:number;kind:CanonicalEffect['kind'];old_revision:string|null;new_revision:string|null}
async function readEffects(db:D1Database,changeKey:string):Promise<CanonicalEffect[]> {
  const rows=(await db.prepare('SELECT * FROM analytics_canonical_effects WHERE change_key=? ORDER BY effect_key').bind(changeKey).all<EffectRow>()).results;
  return hydrateEffects(db,rows);
}
async function hydrateEffects(db:D1Database,rows:readonly EffectRow[]):Promise<CanonicalEffect[]> {
  if(rows.length>MAX_CANONICAL_EFFECT_PAGE)canonicalFail('CANONICAL_LIMIT');
  const facts=await readCanonicalFacts(db,[...new Set(rows.flatMap(row=>[row.old_revision,row.new_revision].filter((v):v is string=>v!==null)))]);
  const ref=(revision:string|null):CanonicalRevisionRef|null=>{
    if(revision===null)return null;const fact=facts.find(fact=>fact.revision===revision);
    if(!fact)canonicalFail('CANONICAL_UNAVAILABLE');return canonicalRevisionRef(fact);
  };
  return rows.map(row=>({schema:CANONICAL_ANALYTICS_SCHEMA,effectKey:row.effect_key,kind:row.kind,selectionMethod:row.selection_method,occurrenceKey:row.occurrence_key,
    stream:row.stream,erasureKey:row.erasure_key,authorityRevision:row.authority_revision,old:ref(row.old_revision),new:ref(row.new_revision)}));
}
function factValues(authority:CanonicalPageAuthority,fact:CanonicalFact):Array<string|number|null> {
  return [fact.revision,fact.occurrenceKey,authority.sourceId,authority.scope.ownerDigest,
    fact.provenance.erasureKey,fact.stream,fact.provenance.selectionMethod,fact.status,fact.location.partitionKey,fact.location.day,
    fact.location.observedAtMs,fact.location.orderScopeKey,fact.location.nativeOrder,fact.provenance.digest,fact.provenance.coverage,
    fact.reportedFields,fact.conflictedFields,fact.accountBasis,fact.planBasis,...CANONICAL_NULLABLE_FIELDS.map(key=>fact.values[key]),
    ...CANONICAL_NATIVE_SCOPE_FIELDS.map(key=>fact.nativeScopes[key]),
    ...EXTENSIONS.flatMap(key=>[fact[key].presence,fact[key].value])];
}
/** JSON is only bounded statement transport for the already validated closed
 * columns. SQLite stores the same typed cells and normalized provenance rows;
 * source records, private IDs and new payload columns never enter this store. */
function insertRows(db:D1Database,table:string,columns:readonly string[],rows:readonly (readonly (string|number|null)[])[],
 conflict?:string):D1PreparedStatement[] {
 if(!rows.length)return [];
 return [db.prepare(`INSERT INTO ${table}(${columns.join(',')})
  SELECT ${columns.map((_,index)=>`json_extract(value,'$[${index}]')`).join(',')} FROM json_each(?)
  WHERE true ORDER BY CAST(key AS INTEGER) ${conflict?`ON CONFLICT(${conflict}) DO NOTHING`:''}`).bind(JSON.stringify(rows))];
}
function factStatements(db:D1Database,authority:CanonicalPageAuthority,facts:readonly CanonicalFact[]):D1PreparedStatement[] {
 return [
  ...insertRows(db,'analytics_canonical_facts',FACT_COLUMNS,facts.map(fact=>factValues(authority,fact)),'revision'),
  ...insertRows(db,'analytics_canonical_variants',['revision','variant_key','kind','format','observed_at_ms'],
   facts.flatMap(fact=>fact.provenance.variants.map(v=>[fact.revision,v.sourceVariantKey,v.kind,v.format,v.observedAtMs])),'revision,variant_key'),
  ...insertRows(db,'analytics_canonical_days',['revision','day'],facts.flatMap(fact=>fact.provenance.linkedDays.map(day=>[fact.revision,day])),'revision,day'),
  ...insertRows(db,'analytics_canonical_tools',['revision','tool_class','count'],facts.flatMap(fact=>fact.toolCounts.map(tool=>[fact.revision,tool.toolClass,tool.count])),'revision,tool_class'),
 ];
}
/** One bounded atomic reconciliation checkpoint. D1 batch rollback includes the
 * immutable facts, CAS head changes, effects and completion receipt. Lost write
 * responses resume by page/input digest, with no repeated source normalization. */
export async function materializeCanonicalPage(input:MaterializeCanonicalPageInput):Promise<{
  state:'complete';reused:boolean;changeKey:string;effects:readonly CanonicalEffect[];
}> {
  canonicalDigest(input.pageKey);canonicalDigest(input.sourceRevision);
  if(!await canonicalAnalyticsAvailable(input.db))canonicalFail('CANONICAL_UNAVAILABLE');
  await assertAuthority(input.db,input);
  const changeKey=await sha256Hex(canonicalJson([CANONICAL_ANALYTICS_SCHEMA,'page',input.sourceId,input.scope.ownerDigest,
    input.scope.selectionMethod,input.pageKey,input.sourceRevision]));
  const previous=await input.db.prepare('SELECT state FROM analytics_canonical_pages WHERE change_key=?').bind(changeKey).first<string>('state');
  if(previous==='complete') {
    if(!await input.stillCurrent())canonicalFail('CANONICAL_CONFLICT');
    return {state:'complete',reused:true,changeKey,effects:await readEffects(input.db,changeKey)};
  }
  if(previous!==null)canonicalFail('CANONICAL_CONFLICT');
  const updates=await input.load();
  if(!Array.isArray(updates)||updates.length>MAX_CANONICAL_EFFECT_PAGE||new Set(updates.map(row=>row.occurrenceKey)).size!==updates.length)canonicalFail('CANONICAL_LIMIT');
  const erasureKey=await canonicalErasureKey(input.scope);
  for(const update of updates) {
    closedKeys(update,['occurrenceKey','stream','expectedRevision','fact']);canonicalDigest(update.occurrenceKey);
    if(update.expectedRevision!==null)canonicalDigest(update.expectedRevision);
    if(update.fact) {
      await validateCanonicalFact(update.fact);
      if(update.fact.occurrenceKey!==update.occurrenceKey||update.fact.stream!==update.stream
        ||update.fact.provenance.erasureKey!==erasureKey||update.fact.provenance.selectionMethod!==input.scope.selectionMethod
        ||update.fact.provenance.coverage!=='complete')canonicalFail();
    }
  }
  if(new TextEncoder().encode(canonicalJson(updates)).length>1_000_000)canonicalFail('CANONICAL_LIMIT');
  const oldFacts=await readCanonicalFacts(input.db,updates.flatMap(row=>row.expectedRevision===null?[]:[row.expectedRevision]));
  const effects:CanonicalEffect[]=[];
  for(const update of updates) {
    const old=oldFacts.find(fact=>fact.revision===update.expectedRevision);
    if(update.expectedRevision!==null&&!old)canonicalFail('CANONICAL_CONFLICT');
    effects.push(await reconcileCanonicalEffect({changeKey,selectionMethod:input.scope.selectionMethod,authorityRevision:input.authorityEpoch,occurrenceKey:update.occurrenceKey,
      stream:update.stream,erasureKey,old:old?canonicalRevisionRef(old):null,new:update.fact?canonicalRevisionRef(update.fact):null}));
  }
  if(!await input.stillCurrent())canonicalFail('CANONICAL_CONFLICT');
  const lease=input.inputLease;
  if(lease){canonicalDigest(lease.scopeKey);canonicalInteger(lease.version);canonicalInteger(lease.nowMs);
    if(!/^[a-f0-9-]{36}$/u.test(lease.claimToken))canonicalFail();}
  const statements=[input.db.prepare(`INSERT INTO analytics_canonical_pages(change_key,source_id,owner_digest,owner_revision,
    authority_epoch,source_revision,effect_count,state) SELECT ?,?,?,?,?,?,?,'writing' ${lease?`WHERE EXISTS(
      SELECT 1 FROM analytics_canonical_input_work WHERE scope_key=? AND claim_token=? AND version=?
        AND claim_expires_ms>? AND claim_expires_ms>(julianday('now')-2440587.5)*86400000)`:''}`)
    .bind(changeKey,input.sourceId,input.scope.ownerDigest,input.ownerRevision,input.authorityEpoch,input.sourceRevision,updates.length,
      ...(lease?[lease.scopeKey,lease.claimToken,lease.version,lease.nowMs]:[]))];
  statements.push(...factStatements(input.db,input,updates.flatMap(update=>update.fact?[update.fact]:[])));
  statements.push(...insertRows(input.db,'analytics_canonical_effects',
    ['effect_key','change_key','occurrence_key','selection_method','stream','erasure_key','authority_revision','kind','old_revision','new_revision'],
    effects.map(effect=>[effect.effectKey,changeKey,effect.occurrenceKey,effect.selectionMethod,effect.stream,
      effect.erasureKey,effect.authorityRevision,effect.kind,effect.old?.revision??null,effect.new?.revision??null])));
  statements.push(input.db.prepare(`UPDATE analytics_canonical_pages SET state='complete' WHERE change_key=?`).bind(changeKey));
  try {const result=await input.db.batch(statements);if(result[0]!.meta.changes!==1)canonicalFail('CANONICAL_CONFLICT');} catch(error) {if(error instanceof D1InvocationBudgetExceededError)throw error;canonicalFail('CANONICAL_CONFLICT');}
  return {state:'complete',reused:false,changeKey,effects};
}
export interface CanonicalPartitionManifest {
  readonly schema:typeof CANONICAL_ANALYTICS_SCHEMA;
  readonly partitionKey:string;readonly contentRevision:string;readonly contentDigest:string;
  readonly generation:number;readonly rowCount:number;readonly minObservedAtMs:number|null;readonly maxObservedAtMs:number|null;
  readonly rows:readonly {occurrenceKey:string;revision:string;provenanceDigest:string;erasureKey:string}[];
}
/** Bounded metadata acquisition for original manifest groups. It never creates
 * a manifest or hydrates value payloads. The consumer must still validate the
 * typed union through readCanonicalFacts and its normal source/lease proofs. */
export async function readCanonicalPartitionManifests(db:D1Database,expected:readonly {
 readonly partitionKey:string;readonly contentRevision:string}[]):Promise<readonly CanonicalPartitionManifest[]|null> {
 if(!Array.isArray(expected)||expected.length<1||expected.length>8
  ||new Set(expected.map(value=>value.partitionKey)).size!==expected.length
  ||expected.some((value,index)=>expected.some((other,otherIndex)=>index!==otherIndex&&value.partitionKey.startsWith(other.partitionKey))))canonicalFail('CANONICAL_LIMIT');
 for(const value of expected){closedKeys(value,['partitionKey','contentRevision']);partition(value.partitionKey);canonicalDigest(value.contentRevision);}
 if(!await canonicalAnalyticsAvailable(db))return null;
 const encoded=JSON.stringify(expected);
 const headerSql=`SELECT m.* FROM json_each(?) expected JOIN analytics_canonical_partition_heads h
  ON h.partition_key=json_extract(expected.value,'$.partitionKey') JOIN analytics_canonical_manifests m USING(content_revision)
  WHERE h.content_revision=json_extract(expected.value,'$.contentRevision') AND m.state='complete'
  AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=m.root_partition_key),0)
  AND m.row_count=(SELECT count(*) FROM analytics_canonical_manifest_rows WHERE content_revision=m.content_revision)
  AND NOT EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows r
   LEFT JOIN analytics_canonical_facts f ON f.revision=r.revision
   LEFT JOIN analytics_canonical_heads c ON c.revision=f.revision AND c.occurrence_key=f.occurrence_key AND c.selection_method=f.selection_method
   LEFT JOIN analytics_owner_state o ON o.source_id=f.source_id AND o.owner_digest=f.owner_digest
   WHERE r.content_revision=m.content_revision AND(f.revision IS NULL OR c.revision IS NULL OR o.state IS NOT 'active'
    OR EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e WHERE e.source_id=f.source_id AND e.owner_digest=f.owner_digest)))`;
 const headers=(await db.prepare(headerSql).bind(encoded).all<{partition_key:string;content_revision:string;content_digest:string;
  root_partition_key:string;hash_prefix:string;generation:number;row_count:number;min_observed_ms:number|null;max_observed_ms:number|null}>()).results;
 if(headers.length!==expected.length||headers.some(row=>!Number.isSafeInteger(row.row_count)||row.row_count<0||row.row_count>16)
  ||headers.reduce((sum,row)=>sum+row.row_count,0)>16)return null;
 const metadata=(await db.prepare(`SELECT r.content_revision,r.ordinal,f.revision,f.occurrence_key,f.provenance_digest,f.erasure_key,
  f.partition_key,f.observed_at_ms FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f ON f.revision=r.revision
  JOIN analytics_canonical_heads h ON h.revision=f.revision AND h.selection_method=f.selection_method AND h.occurrence_key=f.occurrence_key
  JOIN analytics_owner_state o ON o.source_id=f.source_id AND o.owner_digest=f.owner_digest AND o.state='active'
  WHERE r.content_revision IN(SELECT json_extract(value,'$.contentRevision') FROM json_each(?))
  AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e WHERE e.source_id=f.source_id AND e.owner_digest=f.owner_digest)
  ORDER BY r.content_revision,r.ordinal LIMIT 17`).bind(encoded).all<{content_revision:string;ordinal:number;revision:string;
   occurrence_key:string;provenance_digest:string;erasure_key:string;partition_key:string;observed_at_ms:number|null}>()).results;
 if(metadata.length!==headers.reduce((sum,row)=>sum+row.row_count,0)||metadata.length>16
  ||new Set(metadata.map(row=>row.revision)).size!==metadata.length
  ||new Set(metadata.map(row=>row.occurrence_key)).size!==metadata.length)return null;
 const manifests:CanonicalPartitionManifest[]=[];
 for(const value of expected){
  const header=headers.find(row=>row.partition_key===value.partitionKey&&row.content_revision===value.contentRevision);
  if(!header)return null;const {root,prefix}=partition(value.partitionKey);
  const selected=metadata.filter(row=>row.content_revision===value.contentRevision);
  if(header.root_partition_key!==root||header.hash_prefix!==prefix||selected.length!==header.row_count
   ||selected.some((row,index)=>row.ordinal!==index||row.partition_key!==root||!row.occurrence_key.startsWith(prefix)))return null;
  const rows=selected.map(row=>({occurrenceKey:row.occurrence_key,revision:row.revision,provenanceDigest:row.provenance_digest,erasureKey:row.erasure_key}));
  for(const row of rows){canonicalDigest(row.occurrenceKey);canonicalDigest(row.revision);canonicalDigest(row.provenanceDigest);canonicalDigest(row.erasureKey);}
  const times=selected.flatMap(row=>row.observed_at_ms===null?[]:[row.observed_at_ms]);
  if(header.min_observed_ms!==(times.length?Math.min(...times):null)||header.max_observed_ms!==(times.length?Math.max(...times):null)
   ||await sha256Hex(canonicalJson([CANONICAL_ANALYTICS_SCHEMA,value.partitionKey,rows]))!==header.content_digest
   ||await sha256Hex(canonicalJson([header.content_digest,header.generation]))!==header.content_revision)return null;
  manifests.push({schema:CANONICAL_ANALYTICS_SCHEMA,partitionKey:value.partitionKey,contentRevision:header.content_revision,
   contentDigest:header.content_digest,generation:header.generation,rowCount:header.row_count,minObservedAtMs:header.min_observed_ms,
   maxObservedAtMs:header.max_observed_ms,rows});
 }
 const fresh=(await db.prepare(headerSql).bind(encoded).all()).results;
 if(canonicalJson(fresh)!==canonicalJson(headers))return null;
 return Object.freeze(manifests);
}
function partition(value:string):{root:string;prefix:string} {
  const match=/^(effective-union-v1|legacy-selected-v1)\/(usage|quota|session)\/(\d{4}-\d{2}-\d{2}|unknown)\/([0-9a-f]{2,64})$/u.exec(value);
  if(!match)canonicalFail();if(match[3]!=='unknown')canonicalDay(match[3]);return {root:`${match[1]}/${match[2]}/${match[3]}/${match[4]!.slice(0,2)}`,prefix:match[4]!};
}
/** Logical time/hash partitions can mix any number of subjects and protocols.
 * Overflow returns 16 smaller hash ranges; it never silently truncates a leaf. */
export async function materializeCanonicalPartition(db:D1Database,partitionKey:string):Promise<
  {state:'split';partitions:readonly string[]}|{state:'complete';reused:boolean;manifest:CanonicalPartitionManifest}> {
  const {root,prefix}=partition(partitionKey);
  if(!await canonicalAnalyticsAvailable(db))canonicalFail('CANONICAL_UNAVAILABLE');
  const generation=await db.prepare('SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=?').bind(root).first<number>('generation')??0;
  const revisionRows=(await db.prepare(`SELECT h.revision FROM analytics_canonical_heads h WHERE h.partition_key=?
    AND h.occurrence_key>=? AND h.occurrence_key<? ORDER BY h.occurrence_key LIMIT ?`).bind(root,prefix,prefix+'g',MAX_CANONICAL_PARTITION_ROWS+1)
    .all<{revision:string}>()).results;
  if(revisionRows.length>MAX_CANONICAL_PARTITION_ROWS) {
    if(prefix.length===64)canonicalFail('CANONICAL_LIMIT');
    return {state:'split',partitions:Object.freeze('0123456789abcdef'.split('').map(suffix=>partitionKey+suffix))};
  }
  const facts=await readCanonicalFacts(db,revisionRows.map(row=>row.revision));
  if(facts.length!==revisionRows.length)canonicalFail('CANONICAL_CONFLICT');
  const rows=facts.map(fact=>({occurrenceKey:fact.occurrenceKey,revision:fact.revision,provenanceDigest:fact.provenance.digest,erasureKey:fact.provenance.erasureKey}));
  const contentDigest=await sha256Hex(canonicalJson([CANONICAL_ANALYTICS_SCHEMA,partitionKey,rows]));
  const contentRevision=await sha256Hex(canonicalJson([contentDigest,generation]));
  const times=facts.flatMap(fact=>fact.location.observedAtMs===null?[]:[fact.location.observedAtMs]);
  const manifest:CanonicalPartitionManifest={schema:CANONICAL_ANALYTICS_SCHEMA,partitionKey,contentRevision,contentDigest,generation,
    rowCount:rows.length,minObservedAtMs:times.length?Math.min(...times):null,maxObservedAtMs:times.length?Math.max(...times):null,rows};
  const existing=await db.prepare(`SELECT content_revision FROM analytics_canonical_partition_heads WHERE partition_key=?`).bind(partitionKey).first<string>('content_revision');
  if(existing===contentRevision){
    if(!await readCanonicalPartition(db,partitionKey))canonicalFail('CANONICAL_CONFLICT');
    return {state:'complete',reused:true,manifest};
  }
  const statements=[db.prepare(`INSERT INTO analytics_canonical_manifests(content_revision,partition_key,content_digest,root_partition_key,hash_prefix,generation,row_count,
    min_observed_ms,max_observed_ms,state) VALUES(?,?,?,?,?,?,?,?,?,'writing')`).bind(contentRevision,partitionKey,contentDigest,root,prefix,generation,rows.length,manifest.minObservedAtMs,manifest.maxObservedAtMs)];
  if(rows.length)statements.push(db.prepare(`INSERT INTO analytics_canonical_manifest_rows(content_revision,ordinal,revision)
    SELECT ?,CAST(key AS INTEGER),json_extract(value,'$.revision') FROM json_each(?)`).bind(contentRevision,JSON.stringify(rows)));
  statements.push(db.prepare(`UPDATE analytics_canonical_manifests SET state='complete' WHERE content_revision=?`).bind(contentRevision),
    db.prepare(`INSERT INTO analytics_canonical_partition_heads(partition_key,content_revision) VALUES(?,?)
      ON CONFLICT(partition_key) DO UPDATE SET content_revision=excluded.content_revision`).bind(partitionKey,contentRevision));
  try {await db.batch(statements);} catch(error) {if(error instanceof D1InvocationBudgetExceededError)throw error;canonicalFail('CANONICAL_CONFLICT');}
  return {state:'complete',reused:false,manifest};
}

/** Sealed manifest read: dirty generation, replaced occurrence, terminal subject
 * and incomplete row coverage all refuse. Callers never serve staged rows. */
export async function readCanonicalPartition(db:D1Database,partitionKey:string):Promise<{
  manifest:CanonicalPartitionManifest;facts:readonly CanonicalFact[];
}|null> {
  const {root}=partition(partitionKey);
  const row=await db.prepare(`SELECT m.* FROM analytics_canonical_partition_heads h JOIN analytics_canonical_manifests m
    ON m.content_revision=h.content_revision WHERE h.partition_key=? AND m.state='complete'
    AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=?),0)`)
    .bind(partitionKey,root).first<{content_revision:string;content_digest:string;generation:number;row_count:number;
      min_observed_ms:number|null;max_observed_ms:number|null}>();
  if(!row)return null;
  const refs=(await db.prepare(`SELECT r.revision FROM analytics_canonical_manifest_rows r
    JOIN analytics_canonical_heads h ON h.revision=r.revision WHERE r.content_revision=? ORDER BY r.ordinal LIMIT 129`)
    .bind(row.content_revision).all<{revision:string}>()).results;
  if(refs.length!==row.row_count||refs.length>MAX_CANONICAL_PARTITION_ROWS)return null;
  const facts=await readCanonicalFacts(db,refs.map(ref=>ref.revision));
  if(facts.length!==row.row_count)return null;
  const rows=facts.map(fact=>({occurrenceKey:fact.occurrenceKey,revision:fact.revision,provenanceDigest:fact.provenance.digest,erasureKey:fact.provenance.erasureKey}));
  if(await sha256Hex(canonicalJson([CANONICAL_ANALYTICS_SCHEMA,partitionKey,rows]))!==row.content_digest
    ||await sha256Hex(canonicalJson([row.content_digest,row.generation]))!==row.content_revision)canonicalFail('CANONICAL_UNAVAILABLE');
  const current=await db.prepare(`SELECT 1 ready FROM analytics_canonical_partition_heads h JOIN analytics_canonical_manifests m
    ON m.content_revision=h.content_revision WHERE h.partition_key=? AND h.content_revision=? AND m.state='complete'
    AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=?),0)
    AND NOT EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows r LEFT JOIN analytics_canonical_heads f ON f.revision=r.revision
     WHERE r.content_revision=m.content_revision AND f.revision IS NULL)`).bind(partitionKey,row.content_revision,root).first<number>('ready');
  if(current!==1)return null;
  return {manifest:{schema:CANONICAL_ANALYTICS_SCHEMA,partitionKey,contentRevision:row.content_revision,contentDigest:row.content_digest,
    generation:row.generation,rowCount:row.row_count,minObservedAtMs:row.min_observed_ms,maxObservedAtMs:row.max_observed_ms,rows},facts};
}


export interface CanonicalWorkEffect extends CanonicalEffect {
  readonly sourceId:string;
  /** Subject metadata for authorization/erasure only; partitions remain logical. */
  readonly ownerDigest:string;
  readonly partitions:readonly {readonly partitionKey:string;readonly day:string|null}[];
}
/** Bounded immutable effect handoff for the durable partition outbox. */
export async function readCanonicalWorkEffects(db:D1Database,effectKeys:readonly string[]):Promise<CanonicalWorkEffect[]> {
  if(effectKeys.length>MAX_CANONICAL_EFFECT_PAGE||new Set(effectKeys).size!==effectKeys.length)canonicalFail('CANONICAL_LIMIT');
  effectKeys.forEach(canonicalDigest);if(!effectKeys.length)return [];
  const rows=(await db.prepare(`SELECT e.*,p.source_id,p.owner_digest FROM analytics_canonical_effects e
    JOIN analytics_canonical_pages p ON p.change_key=e.change_key AND p.state='complete'
    JOIN analytics_owner_state o ON o.source_id=p.source_id AND o.owner_digest=p.owner_digest AND o.state='active'
    WHERE e.effect_key IN(SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
      WHERE f.source_id=p.source_id AND f.owner_digest=p.owner_digest) ORDER BY e.effect_key`)
    .bind(JSON.stringify(effectKeys)).all<EffectRow&{source_id:string;owner_digest:string}>()).results;
  const effects=await hydrateEffects(db,rows);
  return effects.map((effect,index)=>({...effect,sourceId:rows[index]!.source_id,ownerDigest:rows[index]!.owner_digest,
    partitions:[...new Map([effect.old,effect.new].flatMap(ref=>ref?[{partitionKey:ref.location.partitionKey,day:ref.location.day}]:[])
      .map(location=>[location.partitionKey,location])).values()]}));
}


/** Retire at most limit of each immutable storage family. Unacknowledged effects,
 * pending input receipts, current heads/manifests, rolling/cache pins, and ready/leased consumers
 * retain their exact references. Missing scheduler authority cannot authorize GC.
 * This removes obsolete derived artifacts only; it never mutates source retention. */
export async function retireCanonicalAnalyticsPage(db:D1Database,sourceId:string,limit=16):Promise<{
  state:'complete'|'unavailable';pagesRetired:number;factsRetired:number;manifestsRetired:number;partitionHeadsRetired:number;dirtyPartitionsRetired:number;factChildrenRetired:number;
}> {
  if(!/^[A-Za-z0-9._:-]{1,128}$/u.test(sourceId)||!Number.isSafeInteger(limit)||limit<1||limit>16)canonicalFail();
  const names=(await db.prepare(`SELECT name FROM sqlite_schema WHERE type='table' AND name IN
    ('analytics_partition_work','analytics_partition_canonical_effects','analytics_partition_effect_refs','analytics_partition_dirty_work',
     'analytics_canonical_publication_parts','analytics_canonical_publication_expected','analytics_canonical_publication_part_facts','analytics_canonical_cache_partitions',
     'analytics_canonical_rolling_rows','analytics_canonical_cache_slots','analytics_canonical_cache_nodes',
     'analytics_canonical_feature_quantities','analytics_canonical_feature_prices','analytics_canonical_feature_membership')`).all<{name:string}>()).results;
  const unavailable={state:'unavailable' as const,pagesRetired:0,factsRetired:0,manifestsRetired:0,partitionHeadsRetired:0,dirtyPartitionsRetired:0,factChildrenRetired:0};
  if(!['analytics_partition_work','analytics_partition_canonical_effects','analytics_partition_effect_refs','analytics_partition_dirty_work'].every(name=>names.some(row=>row.name===name))||!await canonicalAnalyticsAvailable(db))return unavailable;
  const schema=await db.batch<{name:string}>([
    db.prepare('PRAGMA table_info(analytics_partition_work)'),db.prepare('PRAGMA table_info(analytics_partition_canonical_effects)'),
    db.prepare('PRAGMA table_info(analytics_partition_effect_refs)'),
    db.prepare(`SELECT name FROM sqlite_schema WHERE type='trigger' AND name IN
      ('analytics_partition_canonical_outbox','analytics_partition_work_admit','analytics_partition_work_immutable')`),
  ]);
  if(!['partition_key','source_id','owner_digest','state'].every(name=>schema[0]!.results.some(row=>row.name===name))
    ||!['effect_key','state'].every(name=>schema[1]!.results.some(row=>row.name===name))
    ||!['work_key','effect_key'].every(name=>schema[2]!.results.some(row=>row.name===name))||schema[3]!.results.length!==3)return unavailable;
  const activeFact=`EXISTS(SELECT 1 FROM analytics_partition_work w WHERE w.state IN('ready','leased')
    AND (substr(w.partition_key,1,length(f.partition_key))=f.partition_key
      OR (w.source_id=f.source_id AND w.owner_digest=f.owner_digest)))`;
  // Empty manifests have no fact-row source attribution. These metadata roots
  // are shared across sources, so every root/work/product exclusion is global.
  const has=(name:string)=>names.some(row=>row.name===name);
  const noProducts=(manifest:string)=>(has('analytics_canonical_publication_parts')?` AND NOT EXISTS(SELECT 1 FROM analytics_canonical_publication_parts p WHERE p.content_revision=${manifest}.content_revision)`:'')
    +(has('analytics_canonical_publication_expected')?` AND NOT EXISTS(SELECT 1 FROM analytics_canonical_publication_expected e WHERE e.content_revision=${manifest}.content_revision)`:'')
    +(has('analytics_canonical_cache_partitions')?` AND NOT EXISTS(SELECT 1 FROM analytics_canonical_cache_partitions c WHERE c.content_revision=${manifest}.content_revision)`:'');
  const rootIdle=`NOT EXISTS(SELECT 1 FROM analytics_partition_work w WHERE w.state IN('ready','leased')
    AND (w.input_revision=m.content_revision OR substr(w.partition_key,1,length(m.root_partition_key))=m.root_partition_key))`;
  const noPartFact=has('analytics_canonical_publication_part_facts')?` AND NOT EXISTS(SELECT 1 FROM analytics_canonical_publication_part_facts p WHERE p.fact_revision=f.revision)`:'';
  const noRetainedFact=noPartFact+['analytics_canonical_rolling_rows','analytics_canonical_cache_slots','analytics_canonical_cache_nodes']
    .filter(has).map(table=>` AND NOT EXISTS(SELECT 1 FROM ${table} pin WHERE pin.fact_revision=f.revision)`).join('');
  const obsoleteFact=`f.source_id=?
    AND NOT EXISTS(SELECT 1 FROM analytics_canonical_heads h WHERE h.revision=f.revision)
    AND NOT EXISTS(SELECT 1 FROM analytics_canonical_effects e WHERE f.revision IN(e.old_revision,e.new_revision))
    AND NOT EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows r WHERE r.revision=f.revision)
    ${noRetainedFact} AND NOT ${activeFact}`;
  const childFamilies=[
    ['analytics_canonical_variants','revision','revision,variant_key'],
    ['analytics_canonical_days','revision','revision,day'],
    ['analytics_canonical_tools','revision','revision,tool_class'],
    ...['analytics_canonical_feature_prices','analytics_canonical_feature_membership','analytics_canonical_feature_quantities']
      .filter(has).map(table=>[table,'fact_revision',table.endsWith('_prices')?'fact_revision,family,dependency_digest':
        table.endsWith('_membership')?'fact_revision,dependency_revision':'fact_revision']),
  ];
  const noFactChildren=childFamilies.map(([table,column])=>` AND NOT EXISTS(SELECT 1 FROM ${table} c WHERE c.${column}=f.revision)`).join('');
  const statements=[
    db.prepare(`DELETE FROM analytics_canonical_partition_heads WHERE partition_key IN(
      SELECT h.partition_key FROM analytics_canonical_partition_heads h JOIN analytics_canonical_manifests m
        ON m.content_revision=h.content_revision
      WHERE m.generation!=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions d WHERE d.partition_key=m.root_partition_key),0)
      AND EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f ON f.revision=r.revision
        WHERE r.content_revision=m.content_revision AND f.source_id=?)
      AND NOT EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f ON f.revision=r.revision
        WHERE r.content_revision=m.content_revision AND ${activeFact})
      AND ${rootIdle}
      ORDER BY h.partition_key LIMIT ?) RETURNING partition_key`).bind(sourceId,limit),
    db.prepare(`DELETE FROM analytics_canonical_manifests WHERE content_revision IN(
      SELECT m.content_revision FROM analytics_canonical_manifests m WHERE m.state='complete'
      AND NOT EXISTS(SELECT 1 FROM analytics_canonical_partition_heads h WHERE h.content_revision=m.content_revision)
      AND EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f ON f.revision=r.revision
        WHERE r.content_revision=m.content_revision AND f.source_id=?)
      AND NOT EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f ON f.revision=r.revision
        WHERE r.content_revision=m.content_revision AND ${activeFact})
      AND ${rootIdle}${noProducts('m')}
      ORDER BY m.content_revision LIMIT 1) RETURNING content_revision` ).bind(sourceId),
    db.prepare(`DELETE FROM analytics_canonical_pages WHERE change_key IN(
      SELECT p.change_key FROM analytics_canonical_pages p WHERE p.source_id=? AND p.state='complete'
      AND NOT EXISTS(SELECT 1 FROM analytics_canonical_input_pending pending WHERE pending.source_revision=p.source_revision)
      AND NOT EXISTS(SELECT 1 FROM analytics_canonical_effects e JOIN analytics_partition_effect_refs r ON r.effect_key=e.effect_key
        WHERE e.change_key=p.change_key)
      AND NOT EXISTS(SELECT 1 FROM analytics_canonical_effects e WHERE e.change_key=p.change_key
        AND NOT EXISTS(SELECT 1 FROM analytics_partition_canonical_effects outbox WHERE outbox.effect_key=e.effect_key AND outbox.state='accepted'))
      AND NOT EXISTS(SELECT 1 FROM analytics_canonical_effects e JOIN analytics_canonical_facts f
        ON f.revision IN(e.old_revision,e.new_revision) WHERE e.change_key=p.change_key
        AND ((e.kind!='noop' AND EXISTS(SELECT 1 FROM analytics_canonical_heads h WHERE h.revision=f.revision)) OR ${activeFact}))
      ORDER BY p.change_key LIMIT ?) RETURNING change_key` ).bind(sourceId,limit),
    db.prepare(`DELETE FROM analytics_canonical_facts WHERE revision IN(
      SELECT f.revision FROM analytics_canonical_facts f WHERE ${obsoleteFact}${noFactChildren}
      ORDER BY f.revision LIMIT ?) RETURNING revision` ).bind(sourceId,limit),
    db.prepare(`DELETE FROM analytics_canonical_partition_heads WHERE partition_key IN(
      SELECT h.partition_key FROM analytics_canonical_partition_heads h JOIN analytics_canonical_manifests m USING(content_revision)
      WHERE m.state='complete' AND m.row_count=0
      AND m.generation!=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions d WHERE d.partition_key=m.root_partition_key),0)
      AND ${rootIdle}${noProducts('m')} ORDER BY h.partition_key LIMIT ?) RETURNING partition_key`).bind(limit),
    db.prepare(`DELETE FROM analytics_canonical_manifests WHERE content_revision IN(
      SELECT m.content_revision FROM analytics_canonical_manifests m WHERE m.state='complete' AND m.row_count=0
      AND NOT EXISTS(SELECT 1 FROM analytics_canonical_partition_heads h WHERE h.content_revision=m.content_revision)
      AND ${rootIdle}${noProducts('m')} ORDER BY m.content_revision LIMIT ?) RETURNING content_revision`).bind(limit),
    db.prepare(`DELETE FROM analytics_canonical_dirty_partitions WHERE partition_key IN(
      SELECT d.partition_key FROM analytics_canonical_dirty_partitions d
      WHERE NOT EXISTS(SELECT 1 FROM analytics_canonical_facts f WHERE f.partition_key=d.partition_key)
      AND NOT EXISTS(SELECT 1 FROM analytics_canonical_manifests m WHERE m.root_partition_key=d.partition_key)
      AND NOT EXISTS(SELECT 1 FROM analytics_canonical_partition_heads h WHERE substr(h.partition_key,1,length(d.partition_key))=d.partition_key)
      AND NOT EXISTS(SELECT 1 FROM analytics_partition_work w WHERE substr(w.partition_key,1,length(d.partition_key))=d.partition_key)
      AND NOT EXISTS(SELECT 1 FROM analytics_partition_dirty_work w WHERE w.partition_key=d.partition_key)
      ORDER BY d.partition_key LIMIT ?) RETURNING partition_key`).bind(limit),
  ];
  // Metadata retirement can release the last fact reference in this call.
  // Drain one obsolete fact's children before permitting its root deletion;
  // root eligibility is repeated on every write and after the final child.
  const before=await db.batch(statements.slice(0,3));
  const revision=await db.prepare(`SELECT f.revision FROM analytics_canonical_facts f WHERE ${obsoleteFact}
    ORDER BY f.revision LIMIT 1`).bind(sourceId).first<string>('revision');
  let factChildrenRetired=0,remaining=128;
  if(revision)for(const [table,column,columns]of childFamilies) {
    if(!remaining)break;
    const quantityGuard=table==='analytics_canonical_feature_quantities'?
      ['analytics_canonical_feature_prices','analytics_canonical_feature_membership'].filter(has)
        .map(child=>` AND NOT EXISTS(SELECT 1 FROM ${child} dependent WHERE dependent.fact_revision=?)`).join(''):'';
    const removed=await db.prepare(`DELETE FROM ${table} WHERE (${columns}) IN(SELECT ${columns} FROM ${table}
      WHERE ${column}=? AND EXISTS(SELECT 1 FROM analytics_canonical_facts f WHERE f.revision=? AND ${obsoleteFact})
      ${quantityGuard} ORDER BY ${columns} LIMIT ?) RETURNING ${column}`)
      .bind(revision,revision,sourceId,...(quantityGuard?['analytics_canonical_feature_prices','analytics_canonical_feature_membership'].filter(has).map(()=>revision):[]),remaining).all();
    remaining-=removed.results.length;factChildrenRetired+=removed.results.length;
  }
  const results=[...before,...await db.batch(statements.slice(3))];
  return {state:'complete',partitionHeadsRetired:results[0]!.results.length+results[4]!.results.length,manifestsRetired:results[1]!.results.length+results[5]!.results.length,dirtyPartitionsRetired:results[6]!.results.length,pagesRetired:results[2]!.results.length,factsRetired:results[3]!.results.length,factChildrenRetired};
}
