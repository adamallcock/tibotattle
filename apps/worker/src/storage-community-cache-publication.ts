import {canonicalJson} from './canonical-json';
import {sha256Hex} from './crypto';
import {readAnalyticsWorkClosureFence} from './storage-analytics-closure-fence';
import {readAnalyticsPartitionWork,completeAnalyticsPartitionWork,admitAnalyticsPartitionWork} from './storage-analytics-partition-work';
import {readMaintainedPublicationCohort} from './storage-community-publication-cohort';
import {readCanonicalCacheSeriesResult} from './storage-canonical-cache-pairs';
import {beginCanonicalPublicationClosure,appendCanonicalPublicationExpected,sealCanonicalPublicationExpected,
 readCanonicalPublicationClosure,canonicalPublicationProducerCoverage} from './storage-canonical-publication';
import {captureStorageCommunityAuthority,readStorageCommunitySourceTerminalEpoch,sameStorageCommunityCalculationAuthority,storageCommunityPublicationVisible,type StorageCommunityAuthority} from './storage-community-authority';
import type {AnalyticsPublicationWorkInput,AnalyticsPublicationWorkResult} from './storage-analytics-work-contract';
import type {PublicCacheRetentionSeries} from './cache-retention-values';
const hash=(value:unknown)=>sha256Hex(canonicalJson(value));
const INVENTORY=`SELECT DISTINCT w.partition_key,w.input_revision content_revision FROM analytics_partition_work w
 JOIN analytics_canonical_partition_heads h ON h.partition_key=w.partition_key AND h.content_revision=w.input_revision
 JOIN analytics_canonical_manifests m ON m.content_revision=w.input_revision AND m.state='complete'
 WHERE w.source_id=? AND w.stage='cache'
 AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions d WHERE d.partition_key=m.root_partition_key),0)`;
const CACHE_EXPECTED_CURRENT=`NOT EXISTS(SELECT 1 FROM analytics_canonical_publication_expected e
 LEFT JOIN analytics_canonical_cache_partitions p ON p.partition_key=e.partition_key AND p.content_revision=e.content_revision
 LEFT JOIN analytics_canonical_partition_heads h ON h.partition_key=e.partition_key AND h.content_revision=e.content_revision
 LEFT JOIN analytics_canonical_manifests m ON m.content_revision=e.content_revision
 WHERE e.closure_key=? AND (e.outcome='pending' OR p.content_revision IS NULL OR p.method!='cache-retention-v2'
 OR h.content_revision IS NULL OR m.generation IS NOT COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions d
 WHERE d.partition_key=m.root_partition_key),0)))`;
/** Cache successors carry the exact leaf manifest. Population and completion
 * are captured independently; prepared rows cannot establish eligibility. */
export async function advanceCanonicalCachePublication(input:AnalyticsPublicationWorkInput):Promise<AnalyticsPublicationWorkResult> {
 const start=input.budget.meter.queriesUsed,target=input.budget.meter.wrap(input.target),now=input.budget.now;
 const result=(reason:string,completed=false,closureKey?:string):AnalyticsPublicationWorkResult=>({outcome:completed?'complete':'deferred',
  reason,completedWithinLease:completed,statements:input.budget.meter.queriesUsed-start,...(closureKey?{closureKey}:{})});
 const available=(reserve=100)=>input.budget.remainingQueries()>=reserve&&now()<input.budget.deadlineMs-1500;
 const work=await readAnalyticsPartitionWork(target,input.lease,now());if(!work)return result('lease_changed');
 const source=input.sources.find(row=>row.sourceId===work.sourceId);if(!source||!work.day)return result('source_scope_unavailable');
 const bindings={source:input.budget.meter.wrap(source.database),target,sourceId:source.sourceId,sourceNamespace:source.sourceNamespace};
 const fence=await readAnalyticsWorkClosureFence(bindings);if(!fence)return result('source_prefix_pending');
 const cohort=await readMaintainedPublicationCohort(bindings,fence);if(!cohort)return result('cohort_pending');
 if(cohort.members.length>1024)return result('publication_capacity');
 if(cohort.members.some(owner=>!owner.ownerDigest))return result('source_scope_unavailable');
 if(!available())return result('query_budget');
 const marker=await target.prepare(`SELECT 1 ready FROM analytics_canonical_cache_partitions p
 JOIN analytics_canonical_partition_heads h ON h.partition_key=p.partition_key AND h.content_revision=p.content_revision
 WHERE p.partition_key=? AND p.content_revision=? AND p.method='cache-retention-v2'`)
 .bind(work.partitionKey,work.inputRevision).first<number>('ready');
 if(marker!==1)return result('cache_partition_changed');
 const stillCurrent=async()=>{const fresh=await readAnalyticsWorkClosureFence(bindings);
  return fresh?.proofDigest===fence.proofDigest&&!!await readAnalyticsPartitionWork(target,input.lease,now());};
 const prepared=await readCanonicalCacheSeriesResult({target,nowMs:now(),budget:input.budget,stillCurrent,
  scopes:cohort.members.map(owner=>({sourceId:source.sourceId,ownerDigest:owner.ownerDigest!,
   selectionMethod:owner.hasEffective?'effective-union-v1' as const:'legacy-selected-v1' as const}))});
 if(prepared.state!=='complete')return {...result(prepared.reason),outcome:prepared.state};
 if(!available())return result('query_budget');
 const expected=await target.prepare('SELECT count(*) n FROM ('+INVENTORY+')').bind(work.sourceId).first<number>('n');
 if(expected===null||expected>65536)return result('publication_capacity');
 // No canonical usage fact may escape the producer inventory, even when its
 // selected partition currently has an explicitly empty cache contribution.
 if(!await canonicalPublicationProducerCoverage(target,{sourceId:work.sourceId,family:'cache'}))return result('cache_coverage_pending');
 const closureKey=await beginCanonicalPublicationClosure(target,{sourceId:source.sourceId,day:prepared.anchorDay,family:'cache',
  watermark:fence.acceptedSequence,authorityDigest:await hash(['cache-closure-v1',fence.proofDigest,prepared.membershipDigest,prepared.cacheRevision]),
  expectedCount:expected,nowMs:now()});
 const closure=await readCanonicalPublicationClosure(target,closureKey);if(!closure||closure.state==='invalidated')return result('closure_changed',false,closureKey);
 if(closure.state==='capturing') {
  const after=await target.prepare('SELECT MAX(partition_key) after_key FROM analytics_canonical_publication_expected WHERE closure_key=?')
   .bind(closureKey).first<string>('after_key')??'';
  const page=(await target.prepare('SELECT * FROM ('+INVENTORY+') WHERE partition_key>? ORDER BY partition_key LIMIT 128')
   .bind(work.sourceId,after).all<{partition_key:string;content_revision:string}>()).results;
  await appendCanonicalPublicationExpected(target,closureKey,page.map(row=>({partitionKey:row.partition_key,contentRevision:row.content_revision})));
  if(!await sealCanonicalPublicationExpected(target,closureKey))return result('expected_capture_pending',false,closureKey);
 }
 const cohortKey=await hash(['native-publication-cohort-v1',fence.proofDigest]);
 await target.batch([
  target.prepare(`INSERT INTO analytics_canonical_publication_subjects(closure_key,source_id,owner_digest)
   SELECT ?,source_id,owner_digest FROM analytics_canonical_publication_cohort_members WHERE cohort_key=? ON CONFLICT DO NOTHING`).bind(closureKey,cohortKey),
  target.prepare(`UPDATE analytics_canonical_publication_expected SET outcome=CASE WHEN
   (SELECT row_count FROM analytics_canonical_manifests m WHERE m.content_revision=analytics_canonical_publication_expected.content_revision)=0
   THEN 'empty' ELSE 'unchanged' END WHERE (closure_key,partition_key) IN(SELECT e.closure_key,e.partition_key
   FROM analytics_canonical_publication_expected e JOIN analytics_canonical_cache_partitions p
   ON p.partition_key=e.partition_key AND p.content_revision=e.content_revision AND p.method='cache-retention-v2'
   WHERE e.closure_key=? AND e.outcome='pending' ORDER BY e.partition_key LIMIT 128)`).bind(closureKey),
 ]);
 await target.prepare(`UPDATE analytics_canonical_publication_closures SET state='complete' WHERE closure_key=? AND state IN('sealed','complete')
 AND expected_count=(SELECT count(*) FROM analytics_canonical_publication_expected WHERE closure_key=?) AND ${CACHE_EXPECTED_CURRENT}`)
 .bind(closureKey,closureKey,closureKey).run();
 const ready=await target.prepare("SELECT 1 ready FROM analytics_canonical_publication_closures WHERE closure_key=? AND state='complete'")
 .bind(closureKey).first<number>('ready');
 if(ready!==1)return result('cache_completion_pending',false,closureKey);
 if(!available(50)||!await stillCurrent())return result('source_prefix_changed',false,closureKey);
 const prior=await target.prepare('SELECT revision,closure_key,payload_json,payload_sha256 FROM analytics_canonical_cache_publications WHERE source_id=?')
  .bind(work.sourceId).first<{revision:number;closure_key:string;payload_json:string;payload_sha256:string}>();
 const previous=prior?.revision??0;
 const payload=canonicalJson(prepared.value),payloadHash=await sha256Hex(payload),computed=now();
 if(new TextEncoder().encode(payload).byteLength>1024*1024)return result('publication_capacity',false,closureKey);
 if(prior?.closure_key===closureKey&&prior.payload_json===payload&&prior.payload_sha256===payloadHash) {
  const completed=await completeAnalyticsPartitionWork(target,input.lease,[],now());
  return result(completed?'cache_unchanged':'lease_changed',completed,closureKey);
 }
 try {await target.prepare(`INSERT INTO analytics_canonical_cache_publications
 (source_id,revision,closure_key,cohort_key,cache_revision,anchor_day,authority_json,payload_json,payload_sha256,computed_ms)
 SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM analytics_partition_work WHERE work_key=? AND revision=?
 AND claim_token=? AND state='leased' AND claim_expires_ms>?) AND ${CACHE_EXPECTED_CURRENT}
 ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,closure_key=excluded.closure_key,cohort_key=excluded.cohort_key,
 cache_revision=excluded.cache_revision,anchor_day=excluded.anchor_day,authority_json=excluded.authority_json,
 payload_json=excluded.payload_json,payload_sha256=excluded.payload_sha256,computed_ms=excluded.computed_ms
 WHERE analytics_canonical_cache_publications.revision=?`)
 .bind(work.sourceId,previous+1,closureKey,cohortKey,prepared.cacheRevision,prepared.anchorDay,canonicalJson(fence.authority),payload,payloadHash,computed,
 input.lease.workKey,input.lease.revision,input.lease.claimToken,computed,closureKey,previous).run();}
 catch(error){if(!/canonical_cache_publication_changed/iu.test(String(error))){
  const receipt=await target.prepare('SELECT 1 ready FROM analytics_canonical_cache_publications WHERE source_id=? AND closure_key=? AND payload_sha256=?')
   .bind(work.sourceId,closureKey,payloadHash).first<number>('ready');if(receipt!==1)throw error;}}
 const receipt=await target.prepare('SELECT 1 ready FROM analytics_canonical_cache_publications WHERE source_id=? AND closure_key=? AND payload_sha256=?')
 .bind(work.sourceId,closureKey,payloadHash).first<number>('ready');
 if(receipt!==1)return result('publication_changed',false,closureKey);
 const completed=await completeAnalyticsPartitionWork(target,input.lease,[],now());
 return result(completed?'cache_published':'lease_changed',completed,closureKey);
}
/** Hash-verified saved native DTO. No cohort discovery or feature work occurs
 * on public reads. Terminal subjects cascade-delete the whole mixed snapshot. */
export async function readPublishedCanonicalCache(input:{target:D1Database;sourceId:string;nowMs:number;
 authority:StorageCommunityAuthority;terminalEpoch:number}):Promise<PublicCacheRetentionSeries|null> {
 const row=await input.target.prepare(`SELECT p.authority_json,p.payload_json,p.payload_sha256 FROM analytics_canonical_cache_publications p
 JOIN analytics_canonical_publication_cohorts c ON c.cohort_key=p.cohort_key
 WHERE p.source_id=? AND p.anchor_day=? AND c.state='complete' AND c.valid_until_ms>?`).bind(input.sourceId,new Date(input.nowMs).toISOString().slice(0,10),input.nowMs)
 .first<{authority_json:string;payload_json:string;payload_sha256:string}>();
 if(!row||!storageCommunityPublicationVisible(JSON.parse(row.authority_json) as StorageCommunityAuthority,input.authority,input.terminalEpoch))return null;
 if(await sha256Hex(row.payload_json)!==row.payload_sha256)throw new Error('CANONICAL_CACHE_PUBLICATION_INVALID');
 return JSON.parse(row.payload_json) as PublicCacheRetentionSeries|null;
}

/** Calendar/eligibility clocks need one publication successor even when no
 * occurrence changed. This reads only bounded maintained metadata; the
 * executor still obtains the complete source fence and native cohort. */
export async function admitCanonicalCachePublicationRefresh(input:{source:D1Database;target:D1Database;sourceId:string;sourceNamespace:string;policyRevision:string;nowMs:number}):Promise<readonly string[]> {
 const anchorDay=new Date(input.nowMs).toISOString().slice(0,10);
 const previous=await input.target.prepare(`SELECT p.anchor_day,p.authority_json,c.valid_until_ms FROM analytics_runtime_sources r
 LEFT JOIN analytics_canonical_cache_publications p ON p.source_id=r.source_id
 LEFT JOIN analytics_canonical_publication_cohorts c ON c.cohort_key=p.cohort_key
 WHERE r.source_id=? AND r.source_namespace=? AND r.contract_version=1`).bind(input.sourceId,input.sourceNamespace)
 .first<{anchor_day:string|null;authority_json:string|null;valid_until_ms:number|null}>();
 if(!previous)return [];
 const authority=await captureStorageCommunityAuthority(input.source,input);
 const terminal=await readStorageCommunitySourceTerminalEpoch(input.source);
 const pin=previous.authority_json===null?null:JSON.parse(previous.authority_json) as StorageCommunityAuthority;
 if(previous.anchor_day===anchorDay&&previous.valid_until_ms!==null&&previous.valid_until_ms>input.nowMs&&pin
  &&storageCommunityPublicationVisible(pin,authority,terminal)&&sameStorageCommunityCalculationAuthority(pin,authority)
  &&pin.graphInvalidationEpoch===authority.graphInvalidationEpoch)return [];
 const headKey=await hash(['cache-publication-clock-v1',input.sourceId,anchorDay]);
 // Preparation itself advances the cache clock. Keep one pending clock job
 // while its bounded window pages progress, then let a later terminal clock
 // create a new immutable revision if that completed snapshot was removed.
 const pending=await input.target.prepare(`SELECT work_key FROM analytics_partition_work WHERE source_id=? AND head_key=?
 AND state IN('ready','leased') LIMIT 1`).bind(input.sourceId,headKey).first<string>('work_key');
 if(pending)return [pending];
 const marker=await input.target.prepare(`SELECT w.partition_key,w.input_revision,w.stream,w.selection_method,
 (SELECT revision FROM analytics_canonical_cache_clock WHERE id=1) cache_revision
 FROM analytics_partition_work w JOIN analytics_canonical_cache_partitions p ON p.partition_key=w.partition_key AND p.content_revision=w.input_revision
 JOIN analytics_canonical_partition_heads h ON h.partition_key=p.partition_key AND h.content_revision=p.content_revision
 JOIN analytics_canonical_manifests m ON m.content_revision=p.content_revision WHERE w.source_id=? AND w.stage='cache' AND w.state='complete'
 AND p.method='cache-retention-v2' AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions d
 WHERE d.partition_key=m.root_partition_key),0) ORDER BY w.partition_key LIMIT 1`).bind(input.sourceId)
 .first<{partition_key:string;input_revision:string;cache_revision:number;stream:'usage'|'quota'|'session'|null;selection_method:'effective-union-v1'|'legacy-selected-v1'|null}>();
 if(!marker)return [];
 return admitAnalyticsPartitionWork(input.target,[{sourceId:input.sourceId,ownerDigest:null,stage:'publication',lane:'new',
  partitionKey:marker.partition_key,headKey,inputRevision:marker.input_revision,
  policyRevision:await hash(['cache-publication-clock-policy-v1',input.policyRevision,marker.cache_revision,previous.valid_until_ms,
   authority.policyRevision,authority.collectionRevision,authority.graphInvalidationEpoch,authority.usageCorrectionState??'staged',terminal]),
  day:anchorDay,stream:marker.stream,selectionMethod:marker.selection_method,
  residentBytes:2*1024*1024,admissionQueries:400}],input.nowMs).catch(error=>{
   if(/analytics_partition_manifest_changed|analytics_partition_authority/iu.test(String(error)))return [];throw error;
  });
}
