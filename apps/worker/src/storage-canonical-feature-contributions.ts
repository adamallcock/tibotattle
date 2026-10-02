import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { D1InvocationBudgetExceededError,readD1SchemaObjectsAvailable } from './d1-invocation-budget';
import { canonicalDigest, type CanonicalFact } from './canonical-analytics-facts';
import { canonicalAnalyticsAvailable,readCanonicalPartition, readCanonicalFacts, type CanonicalPartitionManifest } from './storage-canonical-analytics-facts';
import { CANONICAL_ACTIVITY_METHOD, CANONICAL_FEATURE_QUANTITY_METHOD, CANONICAL_DAILY_PRICE_METHOD,
  CANONICAL_FIT_PRICE_METHOD, canonicalPriceMethodDigest, prepareCanonicalFeatureContribution,
  priceCanonicalFeatureContribution, validCanonicalFeatureContribution, validCanonicalPriceProduct,
  validCanonicalMembership, CanonicalFeatureRefused,
  type CanonicalFeatureContribution, type CanonicalPriceMethod, type CanonicalPriceProduct,
  type CanonicalActivityMembership, type CanonicalActivityInput } from './canonical-feature-contributions';
import type { priceChunkUsageRecordValue } from './quota-analysis-v1';

export interface CanonicalFeaturePartitionInput {
  readonly target:D1Database;readonly partitionKey:string;
  readonly budget:{remainingQueries():number;now():number;deadlineMs:number};
  /** Source authority/dependency proof is separate from immutable value reuse. */
  readonly stillCurrent:()=>Promise<boolean>;
  /** A source-bound P7 adapter captures exact native selected credential/day
   * role metadata. Missing metadata stays unknown, never a zero member count. */
  readonly membership?:(fact:CanonicalFact)=>Promise<CanonicalActivityMembership|null>;
  readonly methods?:readonly CanonicalPriceMethod[];
  readonly price?:typeof priceChunkUsageRecordValue;
  /** Optional exact price-cell dependency from the reviewed price registry.
   * Include method semantics plus every relevant tariff, context, tier and
   * provider rule. Returning an unchanged digest asserts identical pricing for
   * this occurrence, allowing registry-only changes elsewhere to reuse costs. */
  readonly priceDependency?:(value:CanonicalFeatureContribution,method:CanonicalPriceMethod)=>Promise<string>;
}
export interface CanonicalFeaturePartitionMetrics {
  quantitiesPrepared:number;quantitiesReused:number;dailyPriceCalls:number;fitPriceCalls:number;
  pricesReused:number;canonicalRows:number;sourceRecordDecodes:number;quantityPayloadDecodes:number;pricePayloadDecodes:number;contributionBytes:number;
}
export type CanonicalFeaturePartitionResult=
  | {state:'complete';manifest:CanonicalPartitionManifest;facts:readonly CanonicalFact[];contributions:readonly CanonicalFeatureContribution[];
      prices:readonly CanonicalPriceProduct[];activityInputs:readonly CanonicalActivityInput[];
      metrics:CanonicalFeaturePartitionMetrics}
  | {state:'deferred'|'refused';reason:string};
export interface CanonicalFeatureRowsInput extends Omit<CanonicalFeaturePartitionInput,'partitionKey'> {
  /** Exact sealed input membership, not a claim that this is a complete day. */
  readonly refs:readonly {readonly occurrenceKey:string;readonly revision:string}[];
}
export type CanonicalFeatureRowsResult=
  | Omit<Extract<CanonicalFeaturePartitionResult,{state:'complete'}>,'manifest'>
  | Extract<CanonicalFeaturePartitionResult,{state:'deferred'|'refused'}>;
/** A scope adapter may prepare one bounded sealed page without rebuilding all
 * unrelated facts in each hash partition. Quantities and price keys are shared
 * with the partition producer, so either entrypoint reuses the same products. */
export async function materializeCanonicalFeatureRows(input:CanonicalFeatureRowsInput):Promise<CanonicalFeatureRowsResult> {
  try {
    if(input.refs.length>128||new Set(input.refs.map(ref=>ref.occurrenceKey)).size!==input.refs.length
      ||new Set(input.refs.map(ref=>ref.revision)).size!==input.refs.length)refused('invalid_fact_refs');
    for(const ref of input.refs){canonicalDigest(ref.occurrenceKey);canonicalDigest(ref.revision);}
    if(input.budget.remainingQueries()<48||input.budget.now()>=input.budget.deadlineMs-1500)
      return {state:'deferred',reason:'query_budget'};
    if(!await canonicalFeatureContributionsAvailable(input.target))return {state:'refused',reason:'migration_required'};
    const current=async()=>await input.stillCurrent()&&(input.refs.length===0||
      await input.target.prepare(`SELECT count(*) AS n FROM json_each(?) r
        JOIN analytics_canonical_facts f ON f.revision=json_extract(r.value,'$.revision')
        JOIN analytics_canonical_heads h ON h.revision=f.revision AND h.selection_method=f.selection_method
          AND h.occurrence_key=json_extract(r.value,'$.occurrenceKey')`)
        .bind(JSON.stringify(input.refs)).first<number>('n')===input.refs.length);
    if(!await current())return {state:'deferred',reason:'source_changed'};
    const facts=await readCanonicalFacts(input.target,input.refs.map(ref=>ref.revision));
    if(facts.length!==input.refs.length||input.refs.some(ref=>!facts.some(fact=>fact.revision===ref.revision
      &&fact.occurrenceKey===ref.occurrenceKey)))return {state:'deferred',reason:'canonical_rows_changed'};
    return await materializeValues({...input,stillCurrent:current},facts);
  } catch(error) {if(error instanceof CanonicalFeatureRefused)return {state:'refused',reason:error.reason};throw error;}
}
export const CANONICAL_FEATURE_CONTRIBUTION_TABLES=['analytics_canonical_feature_quantities','analytics_canonical_feature_prices',
  'analytics_canonical_feature_membership','analytics_canonical_activity_heads'];
export const CANONICAL_FEATURE_CONTRIBUTION_TRIGGERS=['analytics_canonical_feature_quantity_admit','analytics_canonical_feature_quantity_immutable',
  'analytics_canonical_feature_price_admit','analytics_canonical_feature_price_immutable',
  'analytics_canonical_feature_membership_admit','analytics_canonical_feature_membership_immutable',
  'analytics_canonical_activity_admit','analytics_canonical_activity_immutable'];
const encoder=new TextEncoder();
const bytes=(value:string)=>encoder.encode(value).byteLength;
/** Bounded bind pages match the established B02 128 KiB part bound. */
function writePages(rows:readonly unknown[]):string[] {
  const pages:string[]=[],page:string[]=[];let size=2;
  for(const row of rows) {
    const encoded=JSON.stringify(row),rowBytes=bytes(encoded);
    if(rowBytes>128*1024-2)throw new CanonicalFeatureRefused('contribution_write_limit');
    if(page.length===16||size+rowBytes+1>128*1024){pages.push('['+page.join(',')+']');page.length=0;size=2;}
    page.push(encoded);size+=rowBytes+1;
  }
  if(page.length)pages.push('['+page.join(',')+']');return pages;
}
const refused=(reason:string):never=>{throw new CanonicalFeatureRefused(reason);};
export async function canonicalFeatureContributionsAvailable(db:D1Database):Promise<boolean> {
  return readD1SchemaObjectsAvailable(db,[...CANONICAL_FEATURE_CONTRIBUTION_TABLES.map(name=>['table',name] as const),
    ...CANONICAL_FEATURE_CONTRIBUTION_TRIGGERS.map(name=>['trigger',name] as const)]);
}
interface QuantityRow {fact_revision:string;payload:string;payload_digest:string}
interface PriceRow extends QuantityRow {family:'daily'|'fit';dependency_digest:string;method_digest:string}
interface MembershipRow {fact_revision:string;dependency_revision:string;method:string;contributor_key:string;device_keys_json:string}
/** Prepares changed immutable occurrences once. Work is partition-bounded and
 * replay-safe; repricing never updates a quantity or a cache evidence revision.
 * Day assembly is persisted by the existing 0032 B02 feature store. */
export async function materializeCanonicalFeaturePartition(input:CanonicalFeaturePartitionInput):Promise<CanonicalFeaturePartitionResult> {
  try {return await materialize(input);}
  catch(error) {if(error instanceof CanonicalFeatureRefused)return {state:'refused',reason:error.reason};throw error;}
}
export interface CanonicalFeaturePartitionGroupInput extends Omit<CanonicalFeaturePartitionInput,'partitionKey'> {
  readonly manifests:readonly CanonicalPartitionManifest[];
  /** Joint target-only lease/head/erasure guard for private preparation. The
   * full source proof remains mandatory at original activity-head sealing. */
  readonly canCommit:()=>Promise<boolean>;
}
export type CanonicalFeaturePartitionGroupResult=
 | {state:'complete';partitions:readonly Omit<Extract<CanonicalFeaturePartitionResult,{state:'complete'}>,'metrics'>[];
    metrics:CanonicalFeaturePartitionMetrics}
 | Extract<CanonicalFeaturePartitionResult,{state:'deferred'|'refused'}>;
/** Acquire and prepare one exact union. Original manifests are independently
 * sealed; there is no combined fact revision, root or publication artifact. */
export async function materializeCanonicalFeaturePartitionGroup(input:CanonicalFeaturePartitionGroupInput):Promise<CanonicalFeaturePartitionGroupResult> {
  try{
    const manifests=input.manifests,refs=manifests.flatMap(manifest=>manifest.rows),keys=manifests.map(manifest=>manifest.partitionKey);
    const match=/^(effective-union-v1|legacy-selected-v1)\/(usage|quota|session)\/(\d{4}-\d{2}-\d{2}|unknown)\/([a-f0-9]{2,64})$/u;
    const identities=keys.map(key=>match.exec(key));
    if(!manifests.length||manifests.length>8||refs.length>16||new Set(keys).size!==keys.length
      ||new Set(refs.map(ref=>ref.revision)).size!==refs.length||new Set(refs.map(ref=>ref.occurrenceKey)).size!==refs.length
      ||identities.some(value=>!value)||identities.some(value=>value!.slice(1,4).join('/')!==identities[0]!.slice(1,4).join('/'))
      ||keys.some((key,index)=>keys.some((other,otherIndex)=>index!==otherIndex&&key.startsWith(other)))
      ||manifests.some(manifest=>manifest.rowCount!==manifest.rows.length))return {state:'refused',reason:'group_capacity'};
    const expected=JSON.stringify(manifests.map(manifest=>({partitionKey:manifest.partitionKey,contentRevision:manifest.contentRevision,
      contentDigest:manifest.contentDigest,generation:manifest.generation,rowCount:manifest.rowCount,
      minObservedAtMs:manifest.minObservedAtMs,maxObservedAtMs:manifest.maxObservedAtMs})));
    const targetCurrent=async()=>await input.canCommit()&&await input.target.prepare(`SELECT count(*) n FROM json_each(?) expected
      JOIN analytics_canonical_partition_heads h ON h.partition_key=json_extract(expected.value,'$.partitionKey')
      JOIN analytics_canonical_manifests m USING(content_revision)
      WHERE h.content_revision=json_extract(expected.value,'$.contentRevision') AND m.state='complete'
      AND m.content_digest=json_extract(expected.value,'$.contentDigest') AND m.generation=json_extract(expected.value,'$.generation')
      AND m.row_count=json_extract(expected.value,'$.rowCount')
      AND m.min_observed_ms IS json_extract(expected.value,'$.minObservedAtMs') AND m.max_observed_ms IS json_extract(expected.value,'$.maxObservedAtMs')
      AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=m.root_partition_key),0)
      AND m.row_count=(SELECT count(*) FROM analytics_canonical_manifest_rows WHERE content_revision=m.content_revision)
      AND NOT EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows r LEFT JOIN analytics_canonical_heads f ON f.revision=r.revision
        WHERE r.content_revision=m.content_revision AND f.revision IS NULL)`).bind(expected).first<number>('n')===manifests.length;
    if(input.budget.remainingQueries()<48||input.budget.now()>=input.budget.deadlineMs-1500)return {state:'deferred',reason:'query_budget'};
    if(!await canonicalFeatureContributionsAvailable(input.target))return {state:'refused',reason:'migration_required'};
    const current=async()=>await input.stillCurrent()&&await targetCurrent();
    if(!await current())return {state:'deferred',reason:'canonical_partition_changed'};
    const scopes=(await input.target.prepare(`SELECT DISTINCT source_id,owner_digest,observed_day,stream,selection_method
      FROM analytics_canonical_facts WHERE revision IN(SELECT value FROM json_each(?)) LIMIT 5`)
      .bind(JSON.stringify(refs.map(ref=>ref.revision))).all()).results;
    if(scopes.length>4)return {state:'refused',reason:'scope_capacity'};
    const facts=await readCanonicalFacts(input.target,refs.map(ref=>ref.revision));
    if(facts.length!==refs.length)return {state:'deferred',reason:'canonical_rows_changed'};
    const byRevision=new Map(facts.map(fact=>[fact.revision,fact]));
    for(const [index,manifest] of manifests.entries()){
      const prefix=identities[index]![4]!,root=manifest.partitionKey.slice(0,-prefix.length)+prefix.slice(0,2);
      const selected=manifest.rows.map(ref=>byRevision.get(ref.revision));
      if(selected.some((fact,ordinal)=>!fact||fact.occurrenceKey!==manifest.rows[ordinal]!.occurrenceKey
        ||fact.provenance.digest!==manifest.rows[ordinal]!.provenanceDigest||fact.provenance.erasureKey!==manifest.rows[ordinal]!.erasureKey
        ||fact.location.partitionKey!==root||!fact.occurrenceKey.startsWith(prefix))
        ||await sha256Hex(canonicalJson([manifest.schema,manifest.partitionKey,manifest.rows]))!==manifest.contentDigest
        ||await sha256Hex(canonicalJson([manifest.contentDigest,manifest.generation]))!==manifest.contentRevision)
        return {state:'deferred',reason:'canonical_partition_changed'};
    }
    const result=await materializeValues({...input,stillCurrent:targetCurrent},facts);
    if(result.state!=='complete')return result;
    if(input.budget.remainingQueries()<manifests.length+8||!await current())return {state:'deferred',reason:'source_changed_or_budget'};
    if(!await canonicalAnalyticsAvailable(input.target)||!await canonicalFeatureContributionsAvailable(input.target))return {state:'deferred',reason:'migration_required'};
    try{await input.target.batch(manifests.map(manifest=>input.target.prepare(`INSERT INTO analytics_canonical_activity_heads(content_revision,method,quantity_count)
      VALUES(?,?,?) ON CONFLICT(content_revision) DO NOTHING`).bind(manifest.contentRevision,CANONICAL_ACTIVITY_METHOD,manifest.rowCount)));}
    catch(error){if(error instanceof D1InvocationBudgetExceededError)throw error;
      if(/canonical_feature_authority|canonical_feature_incomplete|FOREIGN KEY/iu.test(String(error)))return {state:'deferred',reason:'canonical_partition_changed'};
      throw error;}
    if(!await canonicalAnalyticsAvailable(input.target)||!await canonicalFeatureContributionsAvailable(input.target))return {state:'deferred',reason:'migration_required'};
    if(!await current())return {state:'deferred',reason:'canonical_partition_changed'};
    return {state:'complete',metrics:result.metrics,partitions:manifests.map(manifest=>{
      const revisions=new Set(manifest.rows.map(ref=>ref.revision));
      return {state:'complete' as const,manifest,facts:manifest.rows.map(ref=>byRevision.get(ref.revision)!),
        contributions:result.contributions.filter(value=>revisions.has(value.factRevision)),
        prices:result.prices.filter(value=>revisions.has(value.factRevision)),
        activityInputs:result.activityInputs.filter(value=>revisions.has(value.contribution.factRevision))};
    })};
  }catch(error){if(error instanceof CanonicalFeatureRefused)return {state:'refused',reason:error.reason};throw error;}
}
async function materialize(input:CanonicalFeaturePartitionInput):Promise<CanonicalFeaturePartitionResult> {
  const available=(reserve=48)=>input.budget.remainingQueries()>=reserve&&input.budget.now()<input.budget.deadlineMs-1500;
  if(!available())return {state:'deferred',reason:'query_budget'};
  if(!await canonicalFeatureContributionsAvailable(input.target))return {state:'refused',reason:'migration_required'};
  if(!await input.stillCurrent())return {state:'deferred',reason:'source_changed'};
  const partition=await readCanonicalPartition(input.target,input.partitionKey);
  if(!partition)return {state:'deferred',reason:'canonical_partition_changed'};
  const {manifest,facts}=partition;
  const result=await materializeValues(input,facts,manifest);
  return result.state==='complete'?{...result,manifest}:result;
}
async function materializeValues(input:Omit<CanonicalFeaturePartitionInput,'partitionKey'>&{partitionKey?:string},
  facts:readonly CanonicalFact[],manifest?:CanonicalPartitionManifest):Promise<CanonicalFeatureRowsResult> {
  const available=(reserve=48)=>input.budget.remainingQueries()>=reserve&&input.budget.now()<input.budget.deadlineMs-1500;
  const refs=JSON.stringify(facts.map(fact=>fact.revision));
  const methods=input.methods??[CANONICAL_DAILY_PRICE_METHOD,CANONICAL_FIT_PRICE_METHOD];
  if(methods.length>2||new Set(methods.map(method=>method.family)).size!==methods.length)refused('invalid_price_methods');
  const methodDigests=new Map<string,string>();
  for(const method of methods)methodDigests.set(method.family,await canonicalPriceMethodDigest(method));
  const quantityRows=(await input.target.prepare(`SELECT fact_revision,payload,payload_digest FROM analytics_canonical_feature_quantities
    WHERE fact_revision IN(SELECT value FROM json_each(?))`).bind(refs).all<QuantityRow>()).results;
  const quantities=new Map<string,CanonicalFeatureContribution>();
  const metrics:CanonicalFeaturePartitionMetrics={quantitiesPrepared:0,quantitiesReused:0,dailyPriceCalls:0,
    fitPriceCalls:0,pricesReused:0,canonicalRows:facts.length,sourceRecordDecodes:0,quantityPayloadDecodes:0,pricePayloadDecodes:0,contributionBytes:0};
  for(const row of quantityRows) {
    if(bytes(row.payload)>16384||await sha256Hex(row.payload)!==row.payload_digest)refused('invalid_quantity');
    let decoded:unknown;try{decoded=JSON.parse(row.payload);metrics.quantityPayloadDecodes++;}catch{refused('invalid_quantity');}
    if(!validCanonicalFeatureContribution(decoded)||decoded.factRevision!==row.fact_revision)refused('invalid_quantity');
    quantities.set(row.fact_revision,decoded as CanonicalFeatureContribution);metrics.quantitiesReused++;
  }
  const writes:D1PreparedStatement[]=[];
  for(const fact of facts)if(!quantities.has(fact.revision)) {
    const value=await prepareCanonicalFeatureContribution(fact),payload=canonicalJson(value);
    if(bytes(payload)>16384)refused('quantity_limit');
    quantities.set(fact.revision,value);metrics.quantitiesPrepared++;
  }
  // One bounded insert per contribution family; no per-occurrence round trips.
  const missing=[...quantities.values()].filter(value=>!quantityRows.some(row=>row.fact_revision===value.factRevision));
  if(missing.length) {
    const rows=await Promise.all(missing.map(async value=>({revision:value.factRevision,payload:canonicalJson(value),
      digest:await sha256Hex(canonicalJson(value))})));
    for(const page of writePages(rows))writes.push(input.target.prepare(`INSERT INTO analytics_canonical_feature_quantities(fact_revision,method,payload,payload_digest)
      SELECT json_extract(value,'$.revision'),?,json_extract(value,'$.payload'),json_extract(value,'$.digest') FROM json_each(?)
      WHERE true ON CONFLICT(fact_revision) DO NOTHING`).bind(CANONICAL_FEATURE_QUANTITY_METHOD,page));
  }
  const requests: {quantity:CanonicalFeatureContribution;method:CanonicalPriceMethod;dependency:string}[]=[];
  for(const quantity of quantities.values())if(quantity.stream==='usage')for(const method of methods) {
    const cellDependency=input.priceDependency?await input.priceDependency(quantity,method):methodDigests.get(method.family)!;
    canonicalDigest(cellDependency);
    // Registry cells may prove unrelated tariffs unchanged, but a different
    // native pricing method always receives its own namespace.
    const dependency=await sha256Hex(canonicalJson([method.family,method.methodVersion,cellDependency]));
    requests.push({quantity,method,dependency});
  }
  const requestKeys=JSON.stringify(requests.map(row=>[row.quantity.factRevision,row.method.family,row.dependency]));
  const storedPrices=(await input.target.prepare(`SELECT p.fact_revision,p.family,p.dependency_digest,p.method_digest,p.payload,p.payload_digest
    FROM analytics_canonical_feature_prices p JOIN json_each(?) r
    ON p.fact_revision=json_extract(r.value,'$[0]') AND p.family=json_extract(r.value,'$[1]')
    AND p.dependency_digest=json_extract(r.value,'$[2]')`).bind(requestKeys).all<PriceRow>()).results;
  const prices:CanonicalPriceProduct[]=[],priceWrites:{revision:string;family:string;dependency:string;method:string;payload:string;digest:string}[]=[];
  for(const request of requests) {
    const old=storedPrices.find(row=>row.fact_revision===request.quantity.factRevision&&row.family===request.method.family&&row.dependency_digest===request.dependency);
    if(old) {
      if(bytes(old.payload)>4096||await sha256Hex(old.payload)!==old.payload_digest)refused('invalid_price');
      let decoded:unknown;try{decoded=JSON.parse(old.payload);metrics.pricePayloadDecodes++;}catch{refused('invalid_price');}
      if(!validCanonicalPriceProduct(decoded)||decoded.factRevision!==old.fact_revision||decoded.method.family!==old.family
        ||await canonicalPriceMethodDigest(decoded.method)!==old.method_digest)refused('invalid_price');
      // An exact cell dependency is an explicit proof that this value survives
      // a registry change elsewhere; serving still carries the current method.
      prices.push({...decoded as CanonicalPriceProduct,method:request.method});metrics.pricesReused++;
    } else {
      const value=priceCanonicalFeatureContribution(request.quantity,request.method,input.price),payload=canonicalJson(value);
      prices.push(value);if(request.method.family==='daily')metrics.dailyPriceCalls++;else metrics.fitPriceCalls++;
      priceWrites.push({revision:value.factRevision,family:request.method.family,dependency:request.dependency,
        method:methodDigests.get(request.method.family)!,payload,digest:await sha256Hex(payload)});
    }
  }
  for(const page of writePages(priceWrites))writes.push(input.target.prepare(`INSERT INTO analytics_canonical_feature_prices
    (fact_revision,family,dependency_digest,method_digest,payload,payload_digest)
    SELECT json_extract(value,'$.revision'),json_extract(value,'$.family'),json_extract(value,'$.dependency'),
      json_extract(value,'$.method'),json_extract(value,'$.payload'),json_extract(value,'$.digest') FROM json_each(?)
    WHERE true ON CONFLICT(fact_revision,family,dependency_digest) DO NOTHING`).bind(page));
  const membershipRows:MembershipRow[]=[],memberships=new Map<string,CanonicalActivityMembership|null>();
  for(const fact of facts) {
    const membership=input.membership?await input.membership(fact):null;
    if(membership!==null&&!validCanonicalMembership(membership))refused('invalid_membership');
    memberships.set(fact.revision,membership);
    if(membership!==null)membershipRows.push({fact_revision:fact.revision,dependency_revision:membership.dependencyRevision,
      method:membership.method,contributor_key:membership.contributorKey,device_keys_json:JSON.stringify(membership.deviceKeys)});
  }
  for(const page of writePages(membershipRows))writes.push(input.target.prepare(`INSERT INTO analytics_canonical_feature_membership
    (fact_revision,dependency_revision,method,contributor_key,device_keys_json)
    SELECT json_extract(value,'$.fact_revision'),json_extract(value,'$.dependency_revision'),json_extract(value,'$.method'),
     json_extract(value,'$.contributor_key'),json_extract(value,'$.device_keys_json') FROM json_each(?)
    WHERE true ON CONFLICT(fact_revision,dependency_revision) DO NOTHING`).bind(page));
  if(manifest)writes.push(input.target.prepare(`INSERT INTO analytics_canonical_activity_heads(content_revision,method,quantity_count)
    VALUES(?,?,?) ON CONFLICT(content_revision) DO NOTHING`).bind(manifest.contentRevision,CANONICAL_ACTIVITY_METHOD,facts.length));
  if(!available(writes.length+32)||!await input.stillCurrent())return {state:'deferred',reason:'source_changed_or_budget'};
  try {if(writes.length)await input.target.batch(writes);}catch(error){
    if(error instanceof D1InvocationBudgetExceededError)throw error;
    if(/canonical_feature_authority|canonical_feature_incomplete|FOREIGN KEY/iu.test(String(error)))
      return {state:'deferred',reason:'canonical_partition_changed'};
    throw error;
  }
  if(membershipRows.length) {
    const saved=(await input.target.prepare(`SELECT m.* FROM analytics_canonical_feature_membership m
      JOIN json_each(?) r ON m.fact_revision=json_extract(r.value,'$.fact_revision')
      AND m.dependency_revision=json_extract(r.value,'$.dependency_revision')`)
      .bind(JSON.stringify(membershipRows)).all<MembershipRow>()).results;
    if(saved.length!==membershipRows.length||membershipRows.some(expected=>!saved.some(row=>
      canonicalJson(row)===canonicalJson(expected))))refused('membership_revision_conflict');
  }
  const live=manifest&&input.partitionKey?await readCanonicalPartition(input.target,input.partitionKey):null;
  if(manifest&&(!live||live.manifest.contentRevision!==manifest.contentRevision)||!await input.stillCurrent())
    return {state:'deferred',reason:'canonical_partition_changed'};
  // Keep one current dependency per requested cost family and membership
  // contribution. Rows for families omitted by this invocation stay intact.
  // This is private derived-state retirement, independent of source retention.
  if(requests.length||membershipRows.length) {
    if(input.budget.remainingQueries()<4)return {state:'deferred',reason:'source_changed_or_budget'};
    // Cleanup continues on saved/reused requests after an interrupted write.
    // Keep the job discoverable until all old requested dependencies drain.
    const stalePrices=`EXISTS(SELECT 1 FROM json_each(?) r WHERE fact_revision=json_extract(r.value,'$[0]')
      AND family=json_extract(r.value,'$[1]') AND dependency_digest!=json_extract(r.value,'$[2]'))`;
    const staleMembership=`EXISTS(SELECT 1 FROM json_each(?) r WHERE fact_revision=json_extract(r.value,'$.fact_revision')
      AND dependency_revision!=json_extract(r.value,'$.dependency_revision'))`;
    if(requests.length)await input.target.prepare(`DELETE FROM analytics_canonical_feature_prices
      WHERE (fact_revision,family,dependency_digest) IN(SELECT fact_revision,family,dependency_digest
        FROM analytics_canonical_feature_prices WHERE ${stalePrices} ORDER BY fact_revision,family,dependency_digest LIMIT 128)`)
      .bind(requestKeys).run();
    if(membershipRows.length)await input.target.prepare(`DELETE FROM analytics_canonical_feature_membership
      WHERE (fact_revision,dependency_revision) IN(SELECT fact_revision,dependency_revision
        FROM analytics_canonical_feature_membership WHERE ${staleMembership} ORDER BY fact_revision,dependency_revision LIMIT 128)`)
      .bind(JSON.stringify(membershipRows)).run();
    const pricesPending=requests.length&&await input.target.prepare(`SELECT 1 pending FROM analytics_canonical_feature_prices
      WHERE ${stalePrices} LIMIT 1`).bind(requestKeys).first<number>('pending');
    const membersPending=membershipRows.length&&await input.target.prepare(`SELECT 1 pending FROM analytics_canonical_feature_membership
      WHERE ${staleMembership} LIMIT 1`).bind(JSON.stringify(membershipRows)).first<number>('pending');
    if(pricesPending||membersPending)return {state:'deferred',reason:'source_changed_or_budget'};
  }
  const contributions=facts.map(fact=>quantities.get(fact.revision)!);
  const activityInputs=contributions.map(contribution=>({contribution,
    dailyPrice:prices.find(price=>price.factRevision===contribution.factRevision&&price.method.family==='daily')??null,
    membership:memberships.get(contribution.factRevision)??null}));
  metrics.contributionBytes=bytes(canonicalJson({contributions,prices,membershipRows}));
  return {state:'complete',facts,contributions,prices,activityInputs,metrics};
}
