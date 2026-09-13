import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { buildCommunityDailyPayload, type DailyTotalsRow, type DailyCellRow,
  type PublishedCommunityDailyRead } from './community-daily-aggregates';
import { finalizeCommunityDailySpend, COMMUNITY_DAILY_SPEND_PRICING_METHOD,
  COMMUNITY_DAILY_SPEND_REGISTRY_SHA256 } from './community-daily-spend';
import { createV11DailyProjectionValues, mergeV11DailyProjectionValues, validateV11DailyProjectionValues,
  V11_DAILY_VALUES_SCHEMA, type V11DailyProjectionValues } from './v11-daily-projection-values';
import { readV11ProjectedOwnerDays } from './v11-daily-projection';
import { readV1ProjectedChunkPage } from './v1-daily-projection';
import { readPublishedStorageCommunityGraph } from './storage-community-graph-publication';
import { captureStorageCommunityAuthority, captureStorageCommunityRetirementAuthority, readStorageCommunityOwnerPage,
  sameStorageCommunityAuthority, storageCommunityAuthorityIsCurrent,
  type StorageCommunityAuthority, type StorageCommunityOwner } from './storage-community-authority';

export interface StorageCommunityDailyBindings {
  source: D1Database; target: D1Database; sourceId: string; sourceNamespace: string;
}
const METHOD = `${V11_DAILY_VALUES_SCHEMA}:${COMMUNITY_DAILY_SPEND_PRICING_METHOD}:${COMMUNITY_DAILY_SPEND_REGISTRY_SHA256}`;
// A metadata/value payload limit, not a participant admission policy. Larger
// cohorts remain explicitly deferred; they never publish a prefix as a total.
export const STORAGE_DAILY_CAPTURE_BYTES = 2 * 1024 * 1024;
const unavailable = () => new Error('STORAGE_COMMUNITY_DAILY_UNAVAILABLE');
const byteLength = (s: string) => new TextEncoder().encode(s).byteLength;
function day(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString().slice(0,10) !== value) throw unavailable();
}
function safe(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw unavailable();
  return value;
}
function numeric(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw unavailable();
  const n = BigInt(value); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw unavailable();
  return Number(n);
}
interface OwnerCache {
  owner_digest: string; input_revision: number; owner_revision: number; source_format: 'v1'|'v11';
  method: string; progress_revision: number; next_index: number; fingerprint: string|null;
  complete: number; values_json: string;
}
function current(row: OwnerCache|undefined, owner: StorageCommunityOwner): row is OwnerCache {
  return row !== undefined && row.input_revision === owner.inputRevision && row.owner_revision === owner.ownerRevision
    && row.source_format === (owner.hasV11 ? 'v11':'v1') && row.method === METHOD;
}
function member(owner: StorageCommunityOwner) {
  return {ownerDigest:owner.ownerDigest,inputRevision:owner.inputRevision,ownerRevision:owner.ownerRevision,
    hasV1:owner.hasV1,hasV11:owner.hasV11};
}
async function cohort(source: D1Database): Promise<StorageCommunityOwner[]|null> {
  const owners: StorageCommunityOwner[] = []; let after = '', bytes = 0;
  for (;;) {
    const page = await readStorageCommunityOwnerPage(source,{afterParticipantId:after});
    for (const owner of page) {
      // The established daily activity population is the analytical v1/v11
      // union. Legacy evidence feeds allowance, never an extra usage copy.
      if (!owner.hasV1 && !owner.hasV11) continue;
      if (!owner.ownerDigest || owner.ownerRevision < 1) throw unavailable();
      bytes += byteLength(canonicalJson(member(owner)));
      if (bytes > STORAGE_DAILY_CAPTURE_BYTES) return null;
      owners.push(owner);
    }
    if (page.length < 64) return owners;
    after = page.at(-1)!.participantId;
  }
}
async function assertTarget(options: StorageCommunityDailyBindings): Promise<void> {
  if (options.source === options.target) throw unavailable();
  const row = await options.target.prepare(`SELECT 1 AS ready FROM analytics_runtime_sources
    WHERE source_id=? AND source_namespace=? AND contract_version=1`)
    .bind(options.sourceId,options.sourceNamespace).first();
  if (!row) throw unavailable();
}

async function ownerPage(options: StorageCommunityDailyBindings, observedDay: string,
  owner: StorageCommunityOwner, old?: OwnerCache): Promise<'advanced'|'deferred'> {
  const {source,target,sourceId,sourceNamespace}=options, ownerDigest=owner.ownerDigest!;
  const reuse = current(old,owner), progress = old?.progress_revision ?? 0;
  const retained=reuse?await target.prepare(`SELECT CASE WHEN length(CAST(values_json AS BLOB))<=? THEN values_json ELSE NULL END AS values_json
    FROM analytics_community_daily_owners WHERE source_id=? AND day=? AND owner_digest=? AND progress_revision=?`)
    .bind(STORAGE_DAILY_CAPTURE_BYTES,sourceId,observedDay,ownerDigest,progress).first<string>('values_json'):null;
  if(reuse&&retained===null)return 'deferred';
  let values = reuse ? JSON.parse(retained!) as V11DailyProjectionValues : createV11DailyProjectionValues(observedDay);
  validateV11DailyProjectionValues(values);
  let nextIndex = 0, fingerprint: string|null = null, complete = true;
  if (owner.hasV11) {
    const ready = await target.prepare(`SELECT 1 AS ready FROM analytics_owner_state o
      JOIN analytics_v11_owner_heads h ON h.source_id=o.source_id AND h.owner_digest=o.owner_digest
      JOIN analytics_applied_events e ON e.source_id=h.source_id AND e.sequence=h.sequence AND e.revision=o.revision
      WHERE o.source_id=? AND o.owner_digest=? AND o.revision=? AND o.state='active'`)
      .bind(sourceId,ownerDigest,owner.ownerRevision).first();
    if (!ready) return 'deferred';
    const read=await readV11ProjectedOwnerDays({source,target,sourceId,ownerDigest,fromDay:observedDay,throughDay:observedDay});
    if (read.state !== 'available' || read.values.length > 1) return 'deferred';
    values=read.values[0]??createV11DailyProjectionValues(observedDay);
  } else {
    const read=await readV1ProjectedChunkPage({source,target,sourceId,sourceNamespace,ownerDigest,day:observedDay,
      afterIndex:reuse?old.next_index:0,limit:50,...(reuse&&old.fingerprint?{fingerprint:old.fingerprint}:{})});
    if (!read) return 'deferred';
    for (const value of read.values) values=mergeV11DailyProjectionValues(values,value);
    nextIndex=read.nextIndex??0; fingerprint=read.fingerprint; complete=read.nextIndex===null;
  }
  const valuesJson=canonicalJson(values);
  // Source changes after this read can leave a conservative cached value, but
  // the publication's complete cohort check below can never bless that value.
  const statement=target.prepare(`INSERT INTO analytics_community_daily_owners
    (source_id,day,owner_digest,input_revision,owner_revision,source_format,method,progress_revision,next_index,fingerprint,complete,values_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,day,owner_digest) DO UPDATE SET
      input_revision=excluded.input_revision,owner_revision=excluded.owner_revision,source_format=excluded.source_format,
      method=excluded.method,progress_revision=excluded.progress_revision,next_index=excluded.next_index,
      fingerprint=excluded.fingerprint,complete=excluded.complete,values_json=excluded.values_json
    WHERE analytics_community_daily_owners.progress_revision=?`).bind(sourceId,observedDay,ownerDigest,
      owner.inputRevision,owner.ownerRevision,owner.hasV11?'v11':'v1',METHOD,progress+1,nextIndex,fingerprint,complete?1:0,valuesJson,progress);
  try { await statement.run(); } catch { /* Only exact readback acknowledges a lost response or concurrent writer. */ }
  const receipt=await target.prepare(`SELECT * FROM analytics_community_daily_owners WHERE source_id=? AND day=? AND owner_digest=?`)
    .bind(sourceId,observedDay,ownerDigest).first<OwnerCache>();
  return receipt && current(receipt,owner) && receipt.progress_revision===progress+1
    && receipt.next_index===nextIndex && receipt.fingerprint===fingerprint && receipt.complete===(complete?1:0)
    && receipt.values_json===valuesJson ? 'advanced':'deferred';
}

function publicInputs(values: V11DailyProjectionValues[]) {
  const totals: DailyTotalsRow={contributing_participants:0,contributing_devices:0,usage_events:0,quota_observations:0,
    session_dimensions:0,input_uncached_tokens:0,input_cache_read_tokens:0,input_cache_write_tokens:0,
    output_text_tokens:0,output_reasoning_tokens:0,output_combined_tokens:0};
  const cells=new Map<string,DailyCellRow>(); let knownNanousd=0n,full=0,partial=0,unpriced=0,truncated=false;
  function add(target: DailyTotalsRow|DailyCellRow, value: V11DailyProjectionValues['tokens']) {
    target.input_uncached_tokens=safe(target.input_uncached_tokens+numeric(value.inputUncachedTokens.knownSum));
    target.input_cache_read_tokens=safe(target.input_cache_read_tokens+numeric(value.inputCacheReadTokens.knownSum));
    target.input_cache_write_tokens=safe(target.input_cache_write_tokens+numeric(value.inputCacheWriteTokens.knownSum));
    target.output_text_tokens=safe(target.output_text_tokens+numeric(value.outputTextTokens.knownSum));
    target.output_reasoning_tokens=safe(target.output_reasoning_tokens+numeric(value.outputReasoningTokens.knownSum));
    target.output_combined_tokens=safe(target.output_combined_tokens+numeric(value.effectiveOutput.knownSum));
  }
  for (const value of values) {
    validateV11DailyProjectionValues(value);
    if(value.omitted.usageEvents>0)truncated=true;
    const count=value.counts.usage+value.counts.quota+value.counts.session;
    if (count>0) {totals.contributing_participants++;totals.contributing_devices++;}
    totals.usage_events=safe(totals.usage_events+value.counts.usage);
    totals.quota_observations=safe(totals.quota_observations+value.counts.quota);
    totals.session_dimensions=safe(totals.session_dimensions+value.counts.session);add(totals,value.tokens);
    knownNanousd+=BigInt(value.pricing.knownNanousd);full+=value.pricing.fullyPriced;
    partial+=value.pricing.partiallyPriced;unpriced+=value.pricing.unpriced;
    for (const v of value.cells) {
      const key=`${v.provider}\0${v.modelId}`;let cell=cells.get(key);
      if (!cell) {
        cell={provider:v.provider,model_id:v.modelId,usage_events:0,input_uncached_tokens:0,input_cache_read_tokens:0,
          input_cache_write_tokens:0,output_text_tokens:0,output_reasoning_tokens:0,output_combined_tokens:0};
        cells.set(key,cell);
      }
      cell.usage_events=safe(cell.usage_events+v.usageEvents);add(cell,v.tokens);
      // Keep the same first 100 lexically ordered model cells as the SQL path.
      // The complete totals/pricing above never inherit the display truncation.
      if(cells.size>100){truncated=true;cells.delete([...cells.keys()].sort().at(-1)!);}
    }
  }
  const ordered=[...cells.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,v])=>v);
  return {totals,cells:ordered,cellsTruncated:truncated,spend:finalizeCommunityDailySpend({usageEvents:totals.usage_events,knownNanousd,
    fullyPricedUsageEvents:full,partiallyPricedUsageEvents:partial,unpricedUsageEvents:unpriced})};
}

export interface StorageCommunityDailyProgress {
  state:'published'|'unchanged'|'progress'|'deferred'; ownersAdvanced:number;
  reason?:'projection_pending'|'source_changed'|'capacity';
}

/** Independent scheduler entry: new/corrected projections enqueue their days
 * transactionally. Policy changes revisit old heads without any ingestion-side
 * analytical write, and only one day advances in this call. */
export async function advanceNextStorageCommunityDaily(options:StorageCommunityDailyBindings & {
  nowMs?:number;maxOwners?:number;
}):Promise<StorageCommunityDailyProgress|{state:'idle';ownersAdvanced:0}> {
  await assertTarget(options);
  const authority=await captureStorageCommunityAuthority(options.source,options);
  let observedDay=await options.target.prepare(`SELECT day FROM analytics_community_daily_queue
    WHERE source_id=? ORDER BY day LIMIT 1`).bind(options.sourceId).first<string>('day');
  if(observedDay===null){
    observedDay=await options.target.prepare(`SELECT h.day FROM analytics_community_daily_heads h
      LEFT JOIN analytics_community_daily_publications p ON p.source_id=h.source_id AND p.day=h.day AND p.revision=h.revision
      WHERE h.source_id=? AND (p.revision IS NULL OR json_extract(p.authority_json,'$.publicAuthorityEpoch')!=?
       OR json_extract(p.authority_json,'$.policyRevision')!=? OR json_extract(p.authority_json,'$.collectionRevision')!=?
       OR json_extract(p.authority_json,'$.graphInvalidationEpoch')!=?
       OR json_extract(p.payload_json,'$.apiEquivalentSpend.pricingMethodVersion')!=?
       OR json_extract(p.payload_json,'$.apiEquivalentSpend.registrySha256')!=?) ORDER BY h.day LIMIT 1`)
      .bind(options.sourceId,authority.publicAuthorityEpoch,authority.policyRevision,authority.collectionRevision,
        authority.graphInvalidationEpoch,COMMUNITY_DAILY_SPEND_PRICING_METHOD,COMMUNITY_DAILY_SPEND_REGISTRY_SHA256).first<string>('day');
  }
  return observedDay===null?{state:'idle',ownersAdvanced:0}:advanceStorageCommunityDaily({...options,day:observedDay});
}
/** One bounded derived step. Completed owner folds survive other owners'
 * appends; a large v1 day resumes at its exact immutable chunk fingerprint. */
export async function advanceStorageCommunityDaily(options: StorageCommunityDailyBindings & {
  day:string;nowMs?:number;maxOwners?:number;
}):Promise<StorageCommunityDailyProgress> {
  const {source,target,sourceId}=options;day(options.day);await assertTarget(options);
  const maxOwners=options.maxOwners??4;
  if(!Number.isSafeInteger(maxOwners)||maxOwners<1||maxOwners>16)throw unavailable();
  const authority=await captureStorageCommunityAuthority(source,options), owners=await cohort(source);
  const deferred=(reason:NonNullable<StorageCommunityDailyProgress['reason']>,ownersAdvanced=0):StorageCommunityDailyProgress=>
    ({state:reason==='projection_pending'&&ownersAdvanced>0?'progress':'deferred',reason,ownersAdvanced});
  if(!owners)return deferred('capacity');
  if(!await storageCommunityAuthorityIsCurrent(source,authority,true))return deferred('source_changed');
  const requested=owners.map(member), requestJson=canonicalJson(requested);
  const rowset=(await target.prepare(`SELECT owner_digest,input_revision,owner_revision,source_format,method,
    progress_revision,next_index,fingerprint,complete,'' AS values_json FROM analytics_community_daily_owners
    WHERE source_id=? AND day=? AND owner_digest IN(SELECT json_extract(value,'$.ownerDigest') FROM json_each(?))`)
    .bind(sourceId,options.day,requestJson).all<OwnerCache>()).results;
  const cache=new Map(rowset.map(row=>[row.owner_digest,row]));let ownersAdvanced=0;
  for(const owner of owners) {
    const row=cache.get(owner.ownerDigest!);
    if(current(row,owner)&&row.complete===1)continue;
    if(ownersAdvanced>=maxOwners)return {state:'progress',ownersAdvanced};
    if(await ownerPage(options,options.day,owner,row)==='deferred')return deferred('projection_pending',ownersAdvanced);
    ownersAdvanced++;
  }
  // Read all selected values and the queue revision in one target snapshot.
  // Values belong to exact current source revisions, not a prefix cursor.
  const result=await target.batch<OwnerCache|{revision:number}|{revision:number;cohort_digest:string}>([
    target.prepare(`WITH budget AS MATERIALIZED(SELECT COALESCE(SUM(length(CAST(values_json AS BLOB))),0) AS bytes
      FROM analytics_community_daily_owners WHERE source_id=?1 AND day=?2
      AND owner_digest IN(SELECT json_extract(value,'$.ownerDigest') FROM json_each(?3)))
      SELECT c.owner_digest,c.input_revision,c.owner_revision,c.source_format,c.method,c.progress_revision,
      c.next_index,c.fingerprint,c.complete,CASE WHEN budget.bytes<=?4 THEN c.values_json ELSE NULL END AS values_json
      FROM analytics_community_daily_owners c CROSS JOIN budget WHERE c.source_id=?1 AND c.day=?2
      AND c.owner_digest IN(SELECT json_extract(value,'$.ownerDigest') FROM json_each(?3))
      ORDER BY c.owner_digest`).bind(sourceId,options.day,requestJson,STORAGE_DAILY_CAPTURE_BYTES),
    target.prepare(`SELECT revision FROM analytics_community_daily_queue WHERE source_id=? AND day=?`).bind(sourceId,options.day),
    target.prepare(`SELECT h.revision,h.cohort_digest,p.payload_json,p.payload_sha256 FROM analytics_community_daily_heads h
      LEFT JOIN analytics_community_daily_publications p ON p.source_id=h.source_id AND p.day=h.day AND p.revision=h.revision
      WHERE h.source_id=? AND h.day=?`).bind(sourceId,options.day),
  ]);
  const rows=result[0]!.results as OwnerCache[], queueRevision=(result[1]!.results[0] as {revision:number}|undefined)?.revision??0;
  const previous=result[2]!.results[0] as {revision:number;cohort_digest:string;payload_json:string|null;payload_sha256:string|null}|undefined;
  if(rows.length!==owners.length)return deferred('projection_pending',ownersAdvanced);
  const byOwner=new Map(owners.map(owner=>[owner.ownerDigest!,owner]));let bytes=0;
  for(const row of rows){if(!current(row,byOwner.get(row.owner_digest)!)||row.complete!==1)return deferred('projection_pending',ownersAdvanced);
    if(typeof row.values_json!=='string')return deferred('capacity',ownersAdvanced);
    bytes+=byteLength(row.values_json);if(bytes>STORAGE_DAILY_CAPTURE_BYTES)return deferred('capacity',ownersAdvanced);}
  const cohortDigest=await sha256Hex(canonicalJson({members:requested,method:METHOD,
    authority:{...authority,sourceEpoch:0,sequence:0}}));
  const nowMs=options.nowMs??Date.now();if(!Number.isFinite(nowMs))throw unavailable();
  const revision=(previous?.revision??0)+1,releasedAt=new Date(nowMs).toISOString();
  const payload=buildCommunityDailyPayload({day:options.day,revision,releasedAt,
    ...publicInputs(rows.map(row=>JSON.parse(row.values_json) as V11DailyProjectionValues))});
  const payloadJson=canonicalJson(payload),payloadHash=await sha256Hex(payloadJson);
  // Source metadata is reread after all target data. A changed member, policy,
  // revocation or collection revision cannot authorize this publication.
  const finalOwners=await cohort(source);
  if(!finalOwners || canonicalJson(finalOwners.map(member))!==requestJson
    || !await storageCommunityAuthorityIsCurrent(source,authority,true))return deferred('source_changed',ownersAdvanced);
  const unchanged=previous?.cohort_digest===cohortDigest&&typeof previous.payload_json==='string'
    &&await sha256Hex(previous.payload_json)===previous.payload_sha256;
  const commit=target.prepare(`INSERT INTO analytics_community_daily_publications
    (source_id,day,revision,cohort_digest,authority_json,payload_json,payload_sha256,released_at)
    SELECT ?,?,?,?,?,?,?,? WHERE ?=0 AND NOT EXISTS(SELECT 1 FROM analytics_community_daily_publications
      WHERE source_id=? AND day=? AND revision>=?) AND NOT EXISTS(
      SELECT 1 FROM json_each(?) m LEFT JOIN analytics_community_daily_owners c
      ON c.source_id=? AND c.day=? AND c.owner_digest=json_extract(m.value,'$.ownerDigest')
      WHERE c.owner_digest IS NULL OR c.input_revision!=json_extract(m.value,'$.inputRevision')
       OR c.owner_revision!=json_extract(m.value,'$.ownerRevision') OR c.complete!=1 OR c.method!=?)`)
    .bind(sourceId,options.day,revision,cohortDigest,canonicalJson(authority),payloadJson,payloadHash,releasedAt,unchanged?1:0,
      sourceId,options.day,revision,requestJson,sourceId,options.day,METHOD);
  try {await target.batch([commit,target.prepare(`DELETE FROM analytics_community_daily_queue
    WHERE source_id=? AND day=? AND revision=? AND EXISTS(SELECT 1 FROM analytics_community_daily_publications
      WHERE source_id=? AND day=? AND cohort_digest=?)`).bind(sourceId,options.day,queueRevision,sourceId,options.day,cohortDigest)]);}catch{
    // A receipt, not an exception class, decides whether a lost response committed.
  }
  const receipt=await target.prepare(`SELECT h.cohort_digest,p.payload_json,p.payload_sha256 FROM analytics_community_daily_heads h
    JOIN analytics_community_daily_publications p ON p.source_id=h.source_id AND p.day=h.day AND p.revision=h.revision
    WHERE h.source_id=? AND h.day=?`).bind(sourceId,options.day)
    .first<{cohort_digest:string;payload_json:string;payload_sha256:string}>();
  const expectedJson=unchanged?previous!.payload_json:payloadJson,expectedHash=unchanged?previous!.payload_sha256:payloadHash;
  return receipt?.cohort_digest===cohortDigest&&receipt.payload_json===expectedJson&&receipt.payload_sha256===expectedHash
    ?{state:unchanged?'unchanged':'published',ownersAdvanced}:deferred('source_changed',ownersAdvanced);
}

/** No computation or source writes on the interactive public path. */
export async function readPublishedStorageCommunityDaily(options:StorageCommunityDailyBindings & {
  fromDay:string;throughDay:string;
}):Promise<PublishedCommunityDailyRead> {
  day(options.fromDay);day(options.throughDay);await assertTarget(options);
  const range=(Date.parse(options.throughDay)-Date.parse(options.fromDay))/86_400_000+1;
  if(!Number.isSafeInteger(range)||range<1||range>366)throw unavailable();
  const authority=await captureStorageCommunityAuthority(options.source,options);
  const rows=(await options.target.prepare(`SELECT p.* FROM analytics_community_daily_publications p
    WHERE p.source_id=? AND p.day BETWEEN ? AND ? AND p.revision=(SELECT MAX(n.revision)
      FROM analytics_community_daily_publications n WHERE n.source_id=p.source_id AND n.day=p.day)
    ORDER BY p.day`).bind(options.sourceId,options.fromDay,options.throughDay).all<{
      day:string;revision:number;authority_json:string;payload_json:string;payload_sha256:string;released_at:string;
    }>()).results;
  const visible=[];
  for(const row of rows){
    const pin=JSON.parse(row.authority_json) as StorageCommunityAuthority;
    if(!sameStorageCommunityAuthority(pin,authority))continue;
    if(await sha256Hex(row.payload_json)!==row.payload_sha256)throw unavailable();
    visible.push({day:row.day,revision:row.revision,payload_json:row.payload_json,released_at:row.released_at});
  }
  let allowanceBreakdownsCache:PublishedCommunityDailyRead['allowanceBreakdownsCache']=null;
  try {allowanceBreakdownsCache=await readPublishedStorageCommunityGraph(options);}catch{
    // Optional graph failure preserves verified activity; the final source
    // fence below still rejects a revocation which raced either target read.
  }
  if(!await storageCommunityAuthorityIsCurrent(options.source,authority))throw unavailable();
  return {rows:visible,allowancePublicationState:null,allowanceBreakdownsCache,
    allowanceReadState:allowanceBreakdownsCache===null?'temporarily_unavailable':'confirmed'};
}

/** Bounded retirement after hard invalidation; append-only revisions need only
 * retain the latest day value. Owner digests are erased when their source owner
 * is erased, without delaying the source upload/erasure transaction. */
export async function retireStorageCommunityDailyPage(options:StorageCommunityDailyBindings):Promise<number> {
  const authority=await captureStorageCommunityRetirementAuthority(options.source,options);
  const result=await options.target.batch([
    options.target.prepare(`DELETE FROM analytics_community_daily_owners WHERE (source_id,day,owner_digest) IN(
      SELECT c.source_id,c.day,c.owner_digest FROM analytics_community_daily_owners c LEFT JOIN analytics_owner_state o
      ON o.source_id=c.source_id AND o.owner_digest=c.owner_digest
      WHERE c.source_id=? AND (o.state='erased' OR EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
        WHERE f.source_id=c.source_id AND f.owner_digest=c.owner_digest)) LIMIT 16)`).bind(options.sourceId),
    options.target.prepare(`DELETE FROM analytics_community_daily_publications WHERE (source_id,day,revision) IN(
      SELECT p.source_id,p.day,p.revision FROM analytics_community_daily_publications p WHERE p.source_id=? AND (
       json_extract(p.authority_json,'$.publicAuthorityEpoch')!=? OR json_extract(p.authority_json,'$.policyRevision')!=?
       OR json_extract(p.authority_json,'$.collectionRevision')!=? OR json_extract(p.authority_json,'$.graphInvalidationEpoch')!=?
       OR EXISTS(SELECT 1 FROM analytics_community_daily_publications n WHERE n.source_id=p.source_id AND n.day=p.day AND n.revision>p.revision))
      ORDER BY p.day,p.revision LIMIT 4)`).bind(options.sourceId,authority.publicAuthorityEpoch,authority.policyRevision,
        authority.collectionRevision,authority.graphInvalidationEpoch),
  ]);
  return result.reduce((n,row)=>n+row.meta.changes,0);
}
