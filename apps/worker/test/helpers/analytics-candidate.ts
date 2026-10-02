/** Candidate composition only. The native bundle remains pinned to its own Git tree. */
export * from './analytics-workload-kernels';
import {computeStorageGraphResult as nativeCompute} from '../../src/storage-community-graph';
import {advanceStorageCommunityDaily as nativeDaily,readPublishedStorageCommunityDaily as nativeDailyRead} from '../../src/storage-community-daily';
import {publishStorageCommunityModelDay as nativeModel,publishStorageCommunityGraphPreview as nativePreview} from '../../src/storage-community-graph-publication';
import {readCanonicalCacheDay} from '../../src/storage-canonical-cache-pairs';
import {createCacheRetentionCanonicalDayBuild} from '../../src/cache-retention-day';
import {createCanonicalSharedFeaturePreparation} from '../../src/storage-analytics-canonical-day';
import {readAnalyticsWorkClosureFence} from '../../src/storage-analytics-closure-fence';
import {readPublishedCanonicalCache} from '../../src/storage-community-cache-publication';
import {captureStorageCommunityAuthority,readStorageCommunitySourceTerminalEpoch,readStorageCommunityOwnerPage,type StorageCommunityOwner} from '../../src/storage-community-authority';
import {createD1InvocationBudget as createDiagnosticBudget} from '../../src/d1-invocation-budget';
import {canonicalJson} from '../../src/canonical-json';
import {sha256Hex} from '../../src/crypto';
import {V11_DAILY_VALUES_SCHEMA} from '../../src/v11-daily-projection-values';
import {COMMUNITY_DAILY_SPEND_PRICING_METHOD,COMMUNITY_DAILY_SPEND_REGISTRY_SHA256} from '../../src/community-daily-spend';
import {STORAGE_DAILY_DEVICE_METHOD} from '../../src/storage-community-daily-devices';
export {createD1InvocationBudget} from '../../src/d1-invocation-budget';
export {advanceStorageCommunityGraphWork} from '../../src/storage-community-graph-work';
export {runCanonicalAnalyticsWorkPass} from '../../src/storage-analytics-canonical-runtime';
export {advanceAnalyticsWorkRetirement} from '../../src/storage-analytics-work-retirement';
export {readAnalyticsWorkClosureFence} from '../../src/storage-analytics-closure-fence';
export {withMaintainedEffectiveDependencies} from '../../src/storage-effective-dependency-summaries';
export function computeStorageGraphResult(...[bindings,scope,options]:Parameters<typeof nativeCompute>) {
 return nativeCompute(bindings,scope,{...options,sharedFeatures:true,canonicalPipeline:true});
}
export function advanceStorageCommunityDaily(options:Parameters<typeof nativeDaily>[0]) {
 return nativeDaily({...options,sharedFeatures:true,canonicalPreparation:createCanonicalSharedFeaturePreparation});
}
export function readPublishedStorageCommunityDaily(options:Parameters<typeof nativeDailyRead>[0]) {
 return nativeDailyRead({...options,canonicalPublications:true});
}
export async function readCandidateCacheDay(options:{source:D1Database;target:D1Database;sourceId:string;sourceNamespace:string;ownerDigest:string;day:string;selectionMethod?:'effective-union-v1'|'legacy-selected-v1'}) {
 return readCanonicalCacheDay({...options,scope:{sourceId:options.sourceId,ownerDigest:options.ownerDigest,selectionMethod:options.selectionMethod??'effective-union-v1'},
  stillCurrent:async()=>!!await readAnalyticsWorkClosureFence(options)});
}
export function publishStorageCommunityModelDay(...[bindings,options]:Parameters<typeof nativeModel>) {
 return nativeModel(bindings,{...options,canonicalClosure:true});
}
export function publishStorageCommunityGraphPreview(...[bindings,options]:Parameters<typeof nativePreview>) {
 return nativePreview(bindings,{...options,canonicalClosure:true});
}
export function createCacheRetentionDaySourceBuild(options:{source:D1Database;target?:D1Database;sourceNamespace:string}) {
 if(!options.target)throw new Error('candidate cache requires target');
 const target=options.target;
 return createCacheRetentionCanonicalDayBuild({target,stillCurrent:async key=>!!await readAnalyticsWorkClosureFence({
  source:options.source,target,sourceId:key.sourceId,sourceNamespace:options.sourceNamespace})});
}
export async function readCandidatePublishedCache(options:{source:D1Database;target:D1Database;sourceId:string;sourceNamespace:string;nowMs:number}) {
 return readPublishedCanonicalCache({...options,authority:await captureStorageCommunityAuthority(options.source,options),
  terminalEpoch:await readStorageCommunitySourceTerminalEpoch(options.source)});
}

/** Failure attribution only: bounded read-only synthetic snapshot, after the
 * measured workload has stopped. No cohort capture, producer or publication is
 * invoked; identifiers stay local and only closed guard evidence is returned. */
export async function readCandidateDailyFailureSnapshot(input:{source:D1Database;target:D1Database;
 sourceId:string;sourceNamespace:string;day:string}) {
 if(!input.sourceId.startsWith('synthetic-p11-')||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(input.day))
  throw new Error('P11_DAILY_DIAGNOSTIC_SCOPE');
 const meter=createDiagnosticBudget(200);
 const readOnly=(database:D1Database):D1Database=>new Proxy(database,{get(target,property,receiver){
  if(property==='prepare')return (sql:string)=>{
   if(!/^\s*(?:SELECT|WITH)\b/iu.test(sql))throw new Error('P11_DIAGNOSTIC_WRITE_REJECTED');
   return target.prepare(sql);
  };
  if(property==='exec')return ()=>{throw new Error('P11_DIAGNOSTIC_WRITE_REJECTED');};
  const value=Reflect.get(target,property,receiver);return typeof value==='function'?value.bind(target):value;
 }});
 const source=meter.wrap(readOnly(input.source)),target=meter.wrap(readOnly(input.target)),bindings={...input,source,target};
 const initial=await readAnalyticsWorkClosureFence(bindings);
 const descriptor=(owner:StorageCommunityOwner)=>({ownerDigest:owner.ownerDigest,inputRevision:owner.inputRevision,
  ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,hasV1:owner.hasV1,hasV11:owner.hasV11,
  hasV12:owner.hasV12,hasLegacy:owner.hasLegacy,hasEffective:owner.hasEffective===true});
 const cohortKey=initial?await sha256Hex(canonicalJson(['native-publication-cohort-v1',initial.proofDigest])):null;
 const header=cohortKey?await target.prepare(`SELECT member_count,valid_until_ms,cursor_count,revision,state
  FROM analytics_canonical_publication_cohorts WHERE cohort_key=? AND source_id=? AND proof_digest=?`)
  .bind(cohortKey,input.sourceId,initial!.proofDigest)
  .first<{member_count:number;valid_until_ms:number;cursor_count:number;revision:number;state:string}>():null;
 const stored=header?(await target.prepare(`SELECT owner_digest,ordinal,descriptor
  FROM analytics_canonical_publication_cohort_members WHERE cohort_key=? ORDER BY ordinal LIMIT 65`)
  .bind(cohortKey).all<{owner_digest:string;ordinal:number;descriptor:string}>()).results:[];
 if(stored.length>64)throw new Error('P11_DAILY_DIAGNOSTIC_COHORT_BOUND');
 const currentOwners=await readStorageCommunityOwnerPage(source);
 if(currentOwners.length>=64)throw new Error('P11_DAILY_DIAGNOSTIC_COHORT_BOUND');
 const currentByOwner=new Map(currentOwners.map(owner=>[owner.ownerDigest,owner]));
 const members=stored.map(row=>({row,owner:JSON.parse(row.descriptor) as StorageCommunityOwner}));
 const descriptorsCurrent=members.every(({row,owner})=>{
  const current=currentByOwner.get(row.owner_digest);
  return owner.ownerDigest===row.owner_digest&&!!current&&canonicalJson(descriptor(current))===row.descriptor;
 });
 const links=stored.length?(await source.prepare(`SELECT owner_digest FROM storage_v11_owner_links
  WHERE owner_digest IN(SELECT value FROM json_each(?)) AND state='active' LIMIT 65`)
  .bind(JSON.stringify(stored.map(row=>row.owner_digest))).all<{owner_digest:string}>()).results:[];
 const linksCurrent=links.length===stored.length&&new Set(links.map(row=>row.owner_digest)).size===stored.length;
 const selected=members.filter(({owner})=>owner.hasV1||owner.hasV11||owner.hasV12);
 const method=`${V11_DAILY_VALUES_SCHEMA}:${COMMUNITY_DAILY_SPEND_PRICING_METHOD}:${COMMUNITY_DAILY_SPEND_REGISTRY_SHA256}`
  +(initial?.authority.usageCorrectionState==='active'?':usage-total-correction-active':'');
 const wanted=selected.map(({row,owner})=>({ordinal:row.ordinal,ownerDigest:row.owner_digest,
  inputRevision:owner.inputRevision,ownerRevision:owner.ownerRevision,
  sourceFormat:owner.hasEffective===true?'effective':owner.hasV11?'v11':'v1',
  selectionMethod:owner.hasEffective===true?'effective-union-v1':'legacy-selected-v1'}));
 const requested=JSON.stringify(wanted);
 const projections=(await target.prepare(`SELECT json_extract(w.value,'$.ordinal') ordinal,
  c.owner_digest IS NOT NULL present,c.input_revision,c.owner_revision,c.source_format,c.method,c.complete,
  json_extract(w.value,'$.inputRevision') expected_input_revision,
  json_extract(w.value,'$.ownerRevision') expected_owner_revision,
  json_extract(w.value,'$.sourceFormat') expected_source_format,
  CASE WHEN json_valid(c.values_json) THEN json_extract(c.values_json,'$.counts.usage')
   +json_extract(c.values_json,'$.counts.quota')+json_extract(c.values_json,'$.counts.session') ELSE NULL END contributing_rows
  FROM json_each(?) w LEFT JOIN analytics_community_daily_owners c
   ON c.source_id=? AND c.day=? AND c.owner_digest=json_extract(w.value,'$.ownerDigest') ORDER BY ordinal`)
  .bind(requested,input.sourceId,input.day).all<{ordinal:number;present:number;input_revision:number|null;
   owner_revision:number|null;source_format:string|null;method:string|null;complete:number|null;
   expected_input_revision:number;expected_owner_revision:number;expected_source_format:string;contributing_rows:number|null}>()).results;
 const projectionState=projections.map(row=>({...row,methodMatches:row.method===method,
  current:row.present===1&&row.input_revision===row.expected_input_revision&&row.owner_revision===row.expected_owner_revision
   &&row.source_format===row.expected_source_format&&row.method===method&&row.complete===1}));
 const devices=(await target.prepare(`WITH selected AS MATERIALIZED(
  SELECT f.owner_digest,f.revision FROM json_each(?1) wanted JOIN analytics_canonical_facts f
   ON f.source_id=?2 AND f.owner_digest=json_extract(wanted.value,'$.ownerDigest') AND f.observed_day=?3
   AND f.selection_method=json_extract(wanted.value,'$.selectionMethod')
  JOIN analytics_canonical_heads h ON h.revision=f.revision), complete AS MATERIALIZED(
  SELECT s.owner_digest,s.revision,m.device_keys_json FROM selected s LEFT JOIN analytics_canonical_feature_membership m
   ON m.fact_revision=s.revision AND m.method=?4)
  SELECT json_extract(w.value,'$.ordinal') ordinal,
   (SELECT count(*) FROM selected s WHERE s.owner_digest=json_extract(w.value,'$.ownerDigest')) fact_count,
   (SELECT count(*) FROM complete c WHERE c.owner_digest=json_extract(w.value,'$.ownerDigest') AND c.device_keys_json IS NULL) missing,
   (SELECT count(DISTINCT d.value) FROM complete c,json_each(c.device_keys_json) d
    WHERE c.owner_digest=json_extract(w.value,'$.ownerDigest')) device_count FROM json_each(?1) w ORDER BY ordinal`)
  .bind(requested,input.sourceId,input.day,STORAGE_DAILY_DEVICE_METHOD)
  .all<{ordinal:number;fact_count:number;missing:number;device_count:number}>()).results;
 const closures=(await target.prepare(`SELECT state,authority_digest=? matches_fence,count(*) n,min(watermark) first_watermark,
  max(watermark) last_watermark FROM analytics_canonical_publication_closures
  WHERE source_id=? AND day=? AND family='activity' GROUP BY state,authority_digest=?`)
  .bind(initial?.proofDigest??'',input.sourceId,input.day,initial?.proofDigest??'')
  .all<{state:string;matches_fence:number;n:number;first_watermark:number;last_watermark:number}>()).results;
 const uncoveredFacts=await target.prepare(`SELECT count(*) n FROM analytics_canonical_heads h
  JOIN analytics_canonical_facts f ON f.revision=h.revision WHERE f.source_id=? AND f.observed_day=? AND NOT EXISTS(
   SELECT 1 FROM analytics_canonical_manifest_rows r JOIN analytics_partition_work w
    ON w.input_revision=r.content_revision AND w.source_id=f.source_id AND w.stage='activity'
   JOIN analytics_canonical_partition_heads p ON p.partition_key=w.partition_key AND p.content_revision=w.input_revision
   WHERE r.revision=f.revision)`).bind(input.sourceId,input.day).first<number>('n');
 const publicDay=await target.prepare(`SELECT count(*) revisions,max(revision) latest_revision FROM analytics_community_daily_publications
  WHERE source_id=? AND day=?`).bind(input.sourceId,input.day).first();
 const final=await readAnalyticsWorkClosureFence(bindings);
 const stable=!!initial&&final?.proofDigest===initial.proofDigest;
 const cohortCurrent=!!header&&header.state==='complete'&&header.valid_until_ms>Date.now()
  &&header.member_count===stored.length&&descriptorsCurrent&&linksCurrent;
 const closureCurrent=closures.some(row=>row.state==='complete'&&row.matches_fence===1&&row.n>0);
 const projectionCurrent=projectionState.length===selected.length&&projectionState.every(row=>row.current);
 const devicesCurrent=projectionState.filter(row=>(row.contributing_rows??0)>0).every(row=>{
  const device=devices.find(value=>value.ordinal===row.ordinal);
  return !!device&&device.fact_count>0&&device.missing===0&&device.device_count>0;
 });
 const firstMissingGuard=!initial?'maintained_fence':!stable?'snapshot_changed':!cohortCurrent?'maintained_cohort'
  :!closureCurrent?'activity_closure':!projectionCurrent?'owner_projection':!devicesCurrent?'canonical_device_membership':'not_identified';
 return {schema:'p11-daily-guard-diagnostic-v1',measurementContract:'Read-only synthetic failure attribution after measured workload; excluded from lane totals.',
  day:input.day,queries:meter.queriesUsed,queryLimit:200,firstMissingGuard,
  fence:{initialPresent:!!initial,finalPresent:!!final,stable,validUntilMs:initial?.validUntilMs??null},
  cohort:{present:!!header,state:header?.state??null,members:stored.length,expectedMembers:header?.member_count??null,
   cursorCount:header?.cursor_count??null,descriptorsCurrent,linksCurrent,current:cohortCurrent},
  activityClosures:closures,uncoveredCurrentActivityFacts:uncoveredFacts,expectedMethod:method,
  ownerProjections:projectionState,deviceMembership:devices,publicDay};
}

// Public composition boundaries for clock/expiry goldens in the adapted bundle.
export {readMaintainedPublicationCohort} from '../../src/storage-community-publication-cohort';
export {admitAnalyticsPartitionWork,claimAnalyticsPartitionWork} from '../../src/storage-analytics-partition-work';

// This maintained payload proof does not exist in the pinned native revision.
export {storageTerminalPayloadAbsent} from '../../src/storage-erasure';
