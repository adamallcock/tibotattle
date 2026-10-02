import {applyD1Migrations,env,reset,type D1Migration} from 'cloudflare:test';
import {beforeAll,describe,expect,it,vi} from 'vitest';
import {telemetryV11DomainManifestDigestInput,type TelemetryV11DomainManifest} from '@app-usagemonitor/telemetry-contract';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization} from '../src/device-auth';
import {registerTelemetryV11DayManifest} from '../src/telemetry-v11-repository';
import {persistTypedV11StagedChunk} from '../src/typed-v11-admission';
import {activateTelemetryV11Domain,createTelemetryV11DomainPredecessor} from '../src/telemetry-v11-domain';
import {revokeAccountlessEnrollment} from '../src/accountless-enrollment';
import {eraseParticipantAsOwner} from '../src/participant-erasure';
import {advanceStorageErasureJobs,requireStorageParticipantErasureComplete} from '../src/storage-erasure';
import {hasDeletionTombstone} from '../src/retention';
import {runStorageAnalyticsPass} from '../src/storage-analytics-runtime';
import {runStorageAnalyticsSchedule,type StorageAnalyticsWorkerEnv} from '../src/storage-analytics-worker';
import {runCacheRetentionDaySchedule,type CacheRetentionDayWorkerEnv} from '../src/cache-retention-day-worker';
import {runCanonicalAnalyticsWorkPass} from '../src/storage-analytics-canonical-runtime';
import {admitAnalyticsPartitionWork,analyticsWorkKey,claimAnalyticsPartitionWork,releaseAnalyticsPartitionWork,
 completeAnalyticsPartitionWork,type AnalyticsWorkRequest} from '../src/storage-analytics-partition-work';
import {advanceEffectiveDependencyCoverage,EFFECTIVE_SELECTIVE_METHOD,readEffectiveScopeMutationToken} from '../src/storage-effective-selective-dependencies';
import {advanceCanonicalInputWork,readCanonicalInputSeal,readCanonicalInputFactPage,type CanonicalInputScope} from '../src/storage-canonical-analytics-input';
import {advanceAnalyticsWorkEffects} from '../src/storage-analytics-work-effects';
import {readStorageCommunityOwnerPage} from '../src/storage-community-authority';
import {readAnalyticsWorkClosureFence} from '../src/storage-analytics-closure-fence';
import {readCanonicalFacts} from '../src/storage-canonical-analytics-facts';
import {prepareCanonicalFeatureContribution} from '../src/canonical-feature-contributions';
import {canonicalCacheRepairPageBlocked,CANONICAL_CACHE_PREPARED_READY_PREDICATE} from '../src/storage-canonical-cache-pairs';
import {CANONICAL_CACHE_PAIR_METHOD} from '../src/canonical-cache-pairs';
import {readMaintainedAnalyticsErasureInventory} from '../src/storage-erasure-artifacts';
import {telemetryV11LegacyProjection} from '../src/telemetry-v11-compatibility';
import {parseTelemetryV1Chunk} from '../src/telemetry-v1';
import {insertTypedTelemetryV1Chunk} from '../src/typed-v1-admission';
import {assertV1SourcePinCurrent,loadV1SourcePin} from '../src/telemetry-v1-source-selection';
import {advanceCanonicalV1Window,executeCanonicalV1WindowRequest} from '../src/storage-canonical-v1-window';
import {createCanonicalV1RollingReader} from '../src/storage-canonical-rolling-inputs';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,type SharedAnalyticsCorpus,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {createV11DeviceFixture,makeV11Day,v11UsageRecord} from './helpers/telemetry-v11';
import {captureAcceptedSourceTransfer,importAcceptedSourceTransfer,type AcceptedSourceTransfer} from './helpers/analytics-source-snapshot';
import {createAnalyticsProfile,profileAnalyticsDatabase,summarizeAnalyticsProfile} from './helpers/analytics-profile';

// Closed component qualification. Dates describe accepted retained work; no
// upload is relabelled as a scheduler history lane. All original source effects
// and work survive setup. This does not simulate the full65,536-job capacity.
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database;TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[]};
const sourceId='synthetic-skew-fairness',dayMs=86_400_000;
const ceiling={delivery:64,coverage:48,input:32,effects:16,features:128,roles:32,sparseProgress:12,oldProgress:16,terminalDelivery:8,erasurePages:48} as const;
const stores=()=>({source:b.USAGE_MONITOR_DB,target:b.STORAGE_ANALYTICS_DB,ledger:b.DELETION_LEDGER});
type Stores=ReturnType<typeof stores>;
type Claim={work_key:string;head_key:string;partition_key:string;owner_digest:string|null;stage:string;lane:string;day:string|null;
 revision:number;claim_token:string;claim_expires_ms:number;resident_bytes:number;last_claimed:number};
type Cost={label:string;statements:number;metadataSamples:number;failedStatements:number;rowsRead:number;rowsWritten:number;elapsedMs:number};
type Episode={costs:Cost[];claims:Claim[];trace?:ScopeTrace};
let corpus:SharedAnalyticsCorpus,oldScope:CanonicalInputScope,hotScope:CanonicalInputScope,sparseScope:CanonicalInputScope,withdrawScope:CanonicalInputScope;
let startup:{source:AcceptedSourceTransfer;target:AcceptedSourceTransfer;ledger:AcceptedSourceTransfer};
let laboratorySetup:unknown;
let historyOwner:{participantId:string;ownerDigest:string},historyWindow:{window_key:string;native_dependency:string;member_count:number};
let historyDevice:Awaited<ReturnType<typeof createV11DeviceFixture>>;

function traceClaims(db:D1Database,claims:Claim[],diagnostic?:{trace:ScopeTrace;role:string;queries:()=>number}):D1Database {
 return new Proxy(db,{get(database,key){
  if(key==='prepare')return(sql:string)=>{
   const wrap=(statement:D1PreparedStatement,bound:unknown[]=[]):D1PreparedStatement=>new Proxy(statement,{get(inner,property){
    if(property==='bind')return(...values:unknown[])=>wrap(inner.bind(...values),values);
    // Profiling reads first() through the native all() result to retain metadata.
    if(property==='all'||property==='run')return async(...args:unknown[])=>{
     const before=diagnostic?.queries(),result=await Reflect.apply(inner[property],inner,args);
     if(sql.includes("UPDATE analytics_partition_work SET state='leased'")){
      const native=result.results as (Claim&{admission_queries:number;attempts:number})[];claims.push(...native);
      if(diagnostic)diagnostic.trace.events.push({kind:'native_claim',role:diagnostic.role,
       actualRoleStatementHeadroomBefore:950-before!,actualRoleStatementHeadroomAfter:950-before!-1,
       budgetRemainingBeforeClaim:950-before!,
       passedAdmissionCeiling:sql.includes('w.admission_queries<=?')&&Number.isSafeInteger(bound[10])?bound[10]:null,
       claimed:native.map(row=>({work:ordinal(diagnostic.trace.work,row.work_key),head:ordinal(diagnostic.trace.head,row.head_key),
        stage:row.stage,lane:row.lane,revision:row.revision,attempts:row.attempts,admissionQueries:row.admission_queries,declaredResidentBytes:row.resident_bytes}))});
     }
     if(diagnostic&&sql.startsWith('UPDATE analytics_partition_work SET reason_code=?'))diagnostic.trace.events.push({kind:'native_producer_reason',role:diagnostic.role,
      work:ordinal(diagnostic.trace.work,String(bound[1])),reason:bound[0],nativeRowsWritten:result.meta.rows_written});
     if(diagnostic&&sql.startsWith('UPDATE analytics_partition_work SET state=?'))diagnostic.trace.events.push({kind:'native_release',role:diagnostic.role,
      work:ordinal(diagnostic.trace.work,String(bound[4])),outcome:bound[1],nativeRowsWritten:result.meta.rows_written});
     return result;
    };
    const value:unknown=Reflect.get(inner,property);return typeof value==='function'?value.bind(inner):value;
   }});return wrap(database.prepare(sql));
  }
  const value:unknown=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
 }});
}
async function invocation<T>(episode:Episode,label:string,run:(db:Stores,meter:ReturnType<typeof createD1InvocationBudget>)=>Promise<T>):Promise<T> {
 const profile=createAnalyticsProfile(),meter=createD1InvocationBudget(950),started=performance.now(),raw=stores();
 const db={source:meter.wrap(profileAnalyticsDatabase(raw.source,'source',profile,()=>label)),
  target:meter.wrap(profileAnalyticsDatabase(traceClaims(raw.target,episode.claims),'target',profile,()=>label)),
  ledger:meter.wrap(profileAnalyticsDatabase(raw.ledger,'ledger',profile,()=>label))};
 try{return await run(db,meter);}
 finally {
  const summary=summarizeAnalyticsProfile(profile);
  expect(meter.queriesUsed).toBeLessThanOrEqual(950);expect(summary.statements).toBe(meter.queriesUsed);
  episode.costs.push({label,statements:meter.queriesUsed,metadataSamples:summary.metadataSamples,failedStatements:summary.failedStatements,
   rowsRead:summary.rowsRead,rowsWritten:summary.rowsWritten,elapsedMs:performance.now()-started});
 }
}
type ScopeTrace={work:Map<string,number>;head:Map<string,number>;input:Map<string,number>;events:unknown[];snapshots:unknown[]};
const ordinal=(map:Map<string,number>,key:string|null):number|null=>{
 if(key===null)return null;let n=map.get(key);if(n===undefined){n=map.size+1;map.set(key,n);}return n;
};
const newScopeTrace=():ScopeTrace=>({work:new Map(),head:new Map(),input:new Map(),events:[],snapshots:[]});
/** Separate metered terminal diagnosis only. It cannot authorize a cache
 * result or substitute for the producer's full source/currentness guards. */
async function retainedTerminalInputDiagnostic(episode:Episode,label:string) {
 return invocation(episode,'terminal_input_'+label,async db=>{
  const token=await readEffectiveScopeMutationToken(db.source,{sourceId,sourceNamespace:sourceId,
   participantId:oldScope.participantId,ownerDigest:oldScope.ownerDigest,
   fromDay:oldScope.day,throughDay:oldScope.day,includeSessions:oldScope.stream==='session'});
  const seal=await readCanonicalInputSeal(db.source,db.target,oldScope);
  const work=(await db.target.prepare(`SELECT state,source_stamp,owner_revision,authority_epoch,seen_count,page_ordinal,version,
   EXISTS(SELECT 1 FROM analytics_canonical_input_pending p WHERE p.scope_key=w.scope_key) pending
   FROM analytics_canonical_input_work w WHERE source_id=? AND owner_digest=? AND selection_method=? AND stream=? AND source_day=?
   LIMIT 2`).bind(sourceId,oldScope.ownerDigest,oldScope.selectionMethod,oldScope.stream,oldScope.day)
   .all<{state:string;source_stamp:string;owner_revision:number;authority_epoch:number;seen_count:number;
    page_ordinal:number;version:number;pending:number}>()).results;
  const effects=await db.target.prepare(`SELECT
   (SELECT count(*) FROM analytics_partition_canonical_effects q JOIN analytics_canonical_effects e USING(effect_key)
    JOIN analytics_canonical_pages p ON p.change_key=e.change_key WHERE p.source_id=? AND p.owner_digest=? AND q.state='pending') pendingCanonical,
   (SELECT count(*) FROM analytics_partition_ranges r WHERE r.source_id=? AND r.owner_digest=?
    AND r.from_day<=? AND r.through_day>=? AND r.state='pending') pendingRanges,
   (SELECT count(*) FROM analytics_partition_ranges r WHERE r.source_id=? AND r.owner_digest=?
    AND r.from_day<=? AND r.through_day>=? AND r.acknowledged=0) unacknowledgedRanges,
   (SELECT complete FROM analytics_partition_reconciliation WHERE source_id=?) reconciled`)
   .bind(sourceId,oldScope.ownerDigest,sourceId,oldScope.ownerDigest,oldScope.day,oldScope.day,
    sourceId,oldScope.ownerDigest,oldScope.day,oldScope.day,sourceId)
   .first<{pendingCanonical:number;pendingRanges:number;unacknowledgedRanges:number;reconciled:number|null}>();
  const row=work[0];
  return {label,sourceTokenPresent:!!token,sealPresent:!!seal,sourceSealMatch:!!token&&!!seal&&token.stamp===seal.sourceStamp,
   rowCount:work.length,rowState:row?.state??null,rowMatchesCurrentToken:!!token&&row?.source_stamp===token.stamp,
   sealMatchesRow:!!seal&&row?.source_stamp===seal.sourceStamp,
   ownerRevisionMatchesSeal:!!seal&&row?.owner_revision===seal.ownerRevision,
   authorityEpochMatchesSeal:!!seal&&row?.authority_epoch===seal.authorityEpoch,
   seen:row?.seen_count??null,pages:row?.page_ordinal??null,version:row?.version??null,pendingPage:row?.pending??null,
   pendingCanonical:effects?.pendingCanonical??null,pendingRanges:effects?.pendingRanges??null,
   unacknowledgedRanges:effects?.unacknowledgedRanges??null,reconciled:effects?.reconciled??null};
 });
}
type RetainedTokenComponents={policyStamp:number;broadStamp:number;clockPhase:number;dayStamp:number;rangeStamp:number};
/** This mirrors the producer's exact covered/scopes SQL and checks its private
 * reconstruction against the public token. The raw components stay in memory;
 * the receipt gets only changed booleans. Every probe has its own 950 meter. */
async function retainedTerminalProgressDiagnostic(episode:Episode,label:string,baseline?:RetainedTokenComponents) {
 return invocation(episode,'terminal_progress_'+label,async db=>{
  const identity={sourceId,sourceNamespace:sourceId,ownerDigest:oldScope.ownerDigest,participantId:oldScope.participantId};
  const bounds={fromDay:oldScope.day,throughDay:oldScope.day,includeSessions:oldScope.stream==='session'};
  const token=await readEffectiveScopeMutationToken(db.source,{...identity,...bounds});
  const parts=(await db.source.prepare(`WITH covered AS MATERIALIZED (
    SELECT r.policy_stamp AS policyStamp,o.broad_stamp AS broadStamp,o.participant_id,
      (SELECT count(*) FROM accountless_v12_device_authorizations WHERE participant_id=o.participant_id
        AND state='active' AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS clockPhase,
      (SELECT min(expires_at) FROM accountless_v12_device_authorizations WHERE participant_id=o.participant_id
        AND state='active' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS nextExpiry
    FROM storage_effective_selective_owners o CROSS JOIN storage_effective_selective_runtime r
    WHERE o.participant_id=?1 AND o.source_namespace=?2 AND o.owner_digest=?3 AND o.seeded=1
      AND r.id=1 AND r.method=?4
      AND NOT EXISTS(SELECT 1 FROM storage_effective_selective_work WHERE participant_id=o.participant_id)
      AND NOT EXISTS(SELECT 1 FROM storage_effective_selective_reverse_work WHERE participant_id=o.participant_id)
      AND EXISTS(SELECT 1 FROM participants p JOIN storage_v11_owner_links l ON l.participant_id=p.id
        JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest
        WHERE p.id=?5 AND p.state='active' AND l.state='active' AND o.state='active')
    ), scopes AS MATERIALIZED (SELECT CAST(key AS INTEGER) AS ordinal,json_extract(value,'$[0]') AS from_day,
      json_extract(value,'$[1]') AS through_day,json_extract(value,'$[2]') AS sessions FROM json_each(?6))
    SELECT s.ordinal,c.policyStamp,c.broadStamp,c.clockPhase,c.nextExpiry,
      coalesce((SELECT max(stamp) FROM storage_effective_selective_days WHERE participant_id=c.participant_id
        AND source_day BETWEEN s.from_day AND s.through_day AND (stream IN(1,2) OR s.sessions=1)),0) AS dayStamp,
      coalesce((SELECT max(stamp) FROM storage_effective_selective_ranges WHERE participant_id=c.participant_id
        AND from_day<=s.through_day AND through_day>=s.from_day),0) AS rangeStamp
    FROM covered c CROSS JOIN scopes s ORDER BY s.ordinal`)
   .bind(identity.participantId,identity.sourceNamespace,identity.ownerDigest,EFFECTIVE_SELECTIVE_METHOD,
    identity.participantId,JSON.stringify([[bounds.fromDay,bounds.throughDay,bounds.includeSessions?1:0]]))
   .all<RetainedTokenComponents&{ordinal:number;nextExpiry:string|null}>()).results;
  const part=parts.length===1&&parts[0]!.ordinal===0?parts[0]:null;
  const components=part?{policyStamp:part.policyStamp,broadStamp:part.broadStamp,clockPhase:part.clockPhase,
   dayStamp:part.dayStamp,rangeStamp:part.rangeStamp}:undefined;
  const componentReconstructsToken=components&&token?await sha256Hex(canonicalJson([EFFECTIVE_SELECTIVE_METHOD,
   {...identity,...bounds},components]))===token.stamp:null;
  // A drift in this diagnostic mirror must never be interpreted as a valid
  // component classification. The real producer proof remains authoritative.
  const compared=baseline&&components&&componentReconstructsToken===true?{
   policyStamp:components.policyStamp!==baseline.policyStamp,broadStamp:components.broadStamp!==baseline.broadStamp,
   clockPhase:components.clockPhase!==baseline.clockPhase,dayStamp:components.dayStamp!==baseline.dayStamp,
   rangeStamp:components.rangeStamp!==baseline.rangeStamp}:null;
  const current=(await db.target.prepare(`SELECT w.state,w.source_stamp,w.owner_revision,w.authority_epoch,
    w.seen_count,(SELECT count(*) FROM analytics_canonical_input_pending p WHERE p.scope_key=w.scope_key) pending_pages,
    (SELECT r.source_stamp FROM analytics_partition_graph_input_refs r WHERE r.scope_key=w.scope_key) graph_stamp
    FROM analytics_canonical_input_work w WHERE w.source_id=? AND w.owner_digest=? AND w.selection_method=?
      AND w.stream=? AND w.source_day=? LIMIT 2`)
   .bind(sourceId,oldScope.ownerDigest,oldScope.selectionMethod,oldScope.stream,oldScope.day)
   .all<{state:string;source_stamp:string;owner_revision:number;authority_epoch:number;seen_count:number;
    pending_pages:number;graph_stamp:string|null}>()).results;
  const row=current.length===1?current[0]:null;
  const ranges=(await db.target.prepare(`SELECT effect_key,state,acknowledged,selection_method,stream,
    next_day<? AS before_day,next_day=? AS at_day,next_day>? AS after_day,next_day>through_day AS past_through
    FROM analytics_partition_ranges WHERE source_id=? AND owner_digest=? AND from_day<=? AND through_day>=?
    ORDER BY updated_ms,effect_key LIMIT 9`)
   .bind(oldScope.day,oldScope.day,oldScope.day,sourceId,oldScope.ownerDigest,oldScope.day,oldScope.day)
   .all<{effect_key:string;state:string;acknowledged:number;selection_method:string;stream:string;
    before_day:number;at_day:number;after_day:number;past_through:number}>()).results;
  const queue=(await db.target.prepare(`SELECT effect_key FROM analytics_partition_ranges
    WHERE source_id=? AND state='pending' ORDER BY updated_ms,effect_key LIMIT 9`)
   .bind(sourceId).all<{effect_key:string}>()).results;
  const firstEight=new Set(queue.slice(0,8).map(value=>value.effect_key));
  const scopePartitionKey='input/'+await sha256Hex(canonicalJson([sourceId,oldScope.ownerDigest,oldScope.day,
   oldScope.stream,oldScope.selectionMethod]));
  const canonical=(await db.target.prepare(`SELECT state,ready_ms<=? AS due,
    state='leased' AND claim_expires_ms>? AS live,input_revision FROM analytics_partition_work
    WHERE source_id=? AND owner_digest=? AND stage='canonical' AND partition_key=? AND day=?
      AND stream=? AND selection_method=? ORDER BY created_ms,work_key LIMIT 9`)
   .bind(Date.now(),Date.now(),sourceId,oldScope.ownerDigest,scopePartitionKey,oldScope.day,oldScope.stream,
    oldScope.selectionMethod)
   .all<{state:string;due:number;live:number;input_revision:string}>()).results;
  const admissibleRangeRevisions=new Set(await Promise.all(ranges.filter(value=>value.selection_method===oldScope.selectionMethod
   &&(value.stream==='all'||value.stream===oldScope.stream)).map(value=>sha256Hex(canonicalJson([value.effect_key,
    oldScope.day,oldScope.stream])))));
  const report={label,tokenPresent:!!token,tokenCurrentlyValid:!!token&&token.validUntilMs>Date.now(),
   componentUnavailable:!components||componentReconstructsToken!==true,
   componentReconstructsToken:componentReconstructsToken===true,
   componentChanged:compared,componentChangedSinceInitial:compared?Object.values(compared).some(Boolean):null,
   componentComparisonUnavailable:label!=='before_withdrawal'&&compared===null,
   rowCount:current.length,rowState:row?.state??null,rowMatchesCurrentToken:!!token&&row?.source_stamp===token.stamp,
   graphRefMatchesRow:!!row&&row.graph_stamp===row.source_stamp,
   rowPendingPages:row?.pending_pages??null,rowSeen:row?.seen_count??null,
   rangeOverflow:ranges.length>8,pendingSourceRangesAtMost8:Math.min(queue.length,8),
   overlappingRanges:ranges.slice(0,8).map(value=>({state:value.state,acknowledged:value.acknowledged===1,
    cursorBeforeDay:value.before_day===1,cursorAtDay:value.at_day===1,cursorAfterDay:value.after_day===1,
    cursorPastThrough:value.past_through===1,selectionMethodMatches:value.selection_method===oldScope.selectionMethod,
    streamCovers:value.stream==='all'||value.stream===oldScope.stream,queueRankAtMost8:firstEight.has(value.effect_key)})),
   globalQueueOverflow:queue.length>8,canonicalOverflow:canonical.length>8,
   canonical:canonical.slice(0,8).map(value=>({state:value.state,due:value.due===1,
    live:value.live===1,inputRevisionMatchesOverlappingRange:ranges.length>8?null:admissibleRangeRevisions.has(value.input_revision)})),
   contract:'Separate metered read-only diagnosis; private source components and range/work keys remain in memory only.'};
  return {report,components};
 });
}
async function scopeDiagnostic(episode:Episode,label:string,sourceProof=false) {
 const trace=episode.trace!;
 const scopes=[['sparse',sparseScope],['retained',oldScope],['hot',hotScope],['withdrawal',withdrawScope]] as const;
 const labels=[...scopes.map(([name,s])=>[name,s.ownerDigest,s.day,s.stream]),['history',historyOwner.ownerDigest,null,null]];
 return invocation(episode,'diagnostic_'+label,async(db,meter)=>{
  const raw=(await db.target.prepare(`WITH labels AS(SELECT json_extract(value,'$[0]') label,
    json_extract(value,'$[1]') owner,json_extract(value,'$[2]') day,json_extract(value,'$[3]') stream FROM json_each(?))
   SELECT w.work_key,w.head_key,w.input_revision,w.stage,w.lane,w.state,w.attempts,w.revision,w.reason_code,
    w.last_claimed,w.admission_queries,w.resident_bytes,w.day,w.ready_ms<=? due,
    w.claim_token IS NOT NULL live_token,w.claim_expires_ms>? unexpired,
    m.generation input_generation,m.row_count input_rows,cm.generation current_generation,cm.row_count current_rows,
    h.content_revision current_revision,d.generation dirty_generation,dw.admitted_generation,
    (SELECT json_group_array(label) FROM labels l WHERE
      (w.owner_digest=l.owner AND (l.day IS NULL OR w.day=l.day) AND (l.stream IS NULL OR w.stream=l.stream))
      OR (w.day=l.day AND w.stream=l.stream AND EXISTS(SELECT 1 FROM analytics_partition_work_subjects s
       WHERE s.work_key=w.work_key AND s.source_id=w.source_id AND s.owner_digest=l.owner))
      OR (w.stage IN('features','activity','cache') AND w.day=l.day AND w.stream=l.stream
       AND EXISTS(SELECT 1 FROM analytics_canonical_facts f JOIN analytics_canonical_heads fh ON fh.revision=f.revision
        WHERE f.source_id=w.source_id AND f.owner_digest=l.owner AND f.observed_day=l.day AND f.stream=l.stream
        AND substr(w.partition_key,1,length(f.partition_key))=f.partition_key
        AND substr(f.occurrence_key,1,length(w.partition_key)-length(f.partition_key)+2)=substr(w.partition_key,length(f.partition_key)-1)))) labels,
    EXISTS(SELECT 1 FROM analytics_canonical_activity_heads a WHERE a.content_revision=h.content_revision) feature_current,
    EXISTS(SELECT 1 FROM analytics_canonical_cache_partitions c WHERE c.partition_key=w.partition_key AND c.content_revision=w.input_revision) cache_same,
    (SELECT count(*) FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f USING(revision)
     LEFT JOIN analytics_canonical_cache_slots s ON s.fact_revision=f.revision WHERE r.content_revision=w.input_revision
      AND f.stream='usage' AND s.slot_key IS NULL) missing_input_slots,
    (SELECT count(*) FROM analytics_partition_canonical_effects q JOIN analytics_canonical_effects e USING(effect_key)
     LEFT JOIN analytics_canonical_facts old ON old.revision=e.old_revision LEFT JOIN analytics_canonical_facts next ON next.revision=e.new_revision
     WHERE q.state='pending' AND (old.partition_key=d.partition_key OR next.partition_key=d.partition_key)) pending_root_effects
   FROM analytics_partition_work w LEFT JOIN analytics_canonical_manifests m ON m.content_revision=w.input_revision
   LEFT JOIN analytics_canonical_partition_heads h ON h.partition_key=w.partition_key
   LEFT JOIN analytics_canonical_manifests cm ON cm.content_revision=h.content_revision
   LEFT JOIN analytics_canonical_dirty_partitions d ON d.partition_key=COALESCE(m.root_partition_key,cm.root_partition_key,
    w.selection_method||'/'||w.stream||'/'||COALESCE(w.day,'unknown')||'/'||substr(w.partition_key,
     length(w.selection_method||'/'||w.stream||'/'||COALESCE(w.day,'unknown')||'/')+1,2))
   LEFT JOIN analytics_partition_dirty_work dw ON dw.source_id=w.source_id AND dw.partition_key=d.partition_key
   WHERE w.source_id=? ORDER BY w.work_key LIMIT 513`).bind(JSON.stringify(labels),Date.now(),Date.now(),sourceId)
   .all<Record<string,unknown>&{work_key:string;head_key:string;input_revision:string;current_revision:string|null;labels:string}>()).results;
  const work=raw.slice(0,512).map(row=>({work:ordinal(trace.work,row.work_key),head:ordinal(trace.head,row.head_key),input:ordinal(trace.input,row.input_revision),
   currentInput:ordinal(trace.input,row.current_revision),labels:JSON.parse(row.labels) as string[],stage:row.stage,lane:row.lane,state:row.state,
   attempts:row.attempts,revision:row.revision,reason:row.reason_code,lastClaimed:row.last_claimed,admissionQueries:row.admission_queries,
   declaredResidentBytes:row.resident_bytes,ageDays:row.day===null?null:Math.floor((Date.now()-Date.parse(String(row.day)+'T00:00:00Z'))/dayMs),
   due:row.due,liveToken:row.live_token,unexpired:row.unexpired,inputGeneration:row.input_generation,inputRows:row.input_rows,
   currentGeneration:row.current_generation,currentRows:row.current_rows,dirtyGeneration:row.dirty_generation,admittedGeneration:row.admitted_generation,
   inputEqualsCurrent:row.input_revision===row.current_revision,featureCurrent:row.feature_current,cacheSame:row.cache_same,
   missingInputSlots:row.missing_input_slots,pendingRootEffects:row.pending_root_effects}));
  const links=(await db.target.prepare(`SELECT parent_work_key,child_work_key FROM analytics_partition_work_links
   WHERE parent_work_key IN(SELECT work_key FROM analytics_partition_work WHERE source_id=?)
   ORDER BY parent_work_key,child_work_key LIMIT 2049`).bind(sourceId).all<{parent_work_key:string;child_work_key:string}>()).results;
  const counters=(await db.target.prepare(`SELECT stage,state,jobs,last_claimed,claim_count FROM analytics_partition_work_counts
   WHERE source_id=? ORDER BY stage,state`).bind(sourceId).all()).results;
  const repairs=await db.target.prepare(`SELECT (SELECT count(*) FROM analytics_canonical_cache_logical_work) logical,
   (SELECT count(*) FROM analytics_canonical_cache_pair_work) pair`).first();
  const byScope=[];
  for(const [name,scope] of scopes){
   const counts=await db.target.prepare(`SELECT
    (SELECT count(*) FROM analytics_canonical_cache_logical_work WHERE source_id=? AND owner_digest=? AND day=?) logical,
    (SELECT count(*) FROM analytics_canonical_cache_pair_work WHERE source_id=? AND owner_digest=? AND day=?) pair,
    (SELECT count(*) FROM analytics_canonical_facts f JOIN analytics_canonical_heads h ON h.revision=f.revision
      LEFT JOIN analytics_canonical_cache_slots s ON s.fact_revision=f.revision WHERE f.source_id=? AND f.owner_digest=? AND f.observed_day=?
       AND f.stream='usage' AND s.slot_key IS NULL) currentMissingSlots`).bind(...[1,2,3].flatMap(()=>[sourceId,scope.ownerDigest,scope.day])).first();
   const seal=sourceProof?await readCanonicalInputSeal(db.source,db.target,scope):undefined;
   byScope.push({label:name,counts,...(sourceProof?{nativeSeal:seal===null?null:{input:ordinal(trace.input,seal!.sourceStamp),
    seenCount:seal!.seenCount,empty:seal!.empty,ownerRevision:seal!.ownerRevision,authorityEpoch:seal!.authorityEpoch}}:{})});
  }
  const history=await db.target.prepare(`SELECT state,member_count,
   (SELECT count(*) FROM analytics_canonical_rolling_members m WHERE m.window_key=w.window_key) actual_members
   FROM analytics_canonical_rolling_windows w WHERE window_key=?`).bind(historyWindow.window_key).first();
  const blocked=await canonicalCacheRepairPageBlocked({target:db.target,budget:{remainingQueries:()=>meter.remainingQueries,now:Date.now,deadlineMs:Date.now()+60_000}});
  const snapshot={label,work,links:links.slice(0,2048).map(link=>({parent:ordinal(trace.work,link.parent_work_key),child:ordinal(trace.work,link.child_work_key)})),
   counters,repairs,byScope,history,nativeBoundedRepairPageBlocked:blocked,
   gaps:{workLimit:raw.length>512,linkLimit:links.length>2048},diagnosticQueries:meter.queriesUsed};
  trace.snapshots.push(snapshot);return snapshot;
 });
}

/** Target-only observation of the exact retained cache lineage. This never
 * selects work for a role, repairs a slot, or treats a receipt as source proof. */
async function retainedTargetProbe(episode:Episode,trace:ScopeTrace,label:string) {
 return invocation(episode,'retained_target_probe_'+label,async(db,meter)=>{
  const rows=(await db.target.prepare(`SELECT w.work_key,w.head_key,w.input_revision,w.partition_key,w.policy_revision,
   w.state,w.reason_code,w.revision,w.attempts,im.generation input_generation,im.row_count input_rows,
   im.root_partition_key input_root,h.content_revision head_revision,cm.generation head_generation,cm.state head_state,
   r.work_revision receipt_revision,r.input_revision receipt_input,r.partition_key receipt_partition,
   r.method receipt_method,r.manifest_generation receipt_generation,r.row_count receipt_rows
   FROM analytics_partition_work w LEFT JOIN analytics_canonical_manifests im ON im.content_revision=w.input_revision
   LEFT JOIN analytics_canonical_partition_heads h ON h.partition_key=w.partition_key
   LEFT JOIN analytics_canonical_manifests cm ON cm.content_revision=h.content_revision
   LEFT JOIN analytics_canonical_cache_prepared_receipts r ON r.work_key=w.work_key
   WHERE w.source_id=? AND w.stage='cache' AND w.day=? AND w.stream='usage'
   AND EXISTS(SELECT 1 FROM analytics_partition_work_subjects subject WHERE subject.work_key=w.work_key
    AND subject.source_id=w.source_id AND subject.owner_digest=?) ORDER BY w.work_key LIMIT 9`)
   .bind(sourceId,oldScope.day,oldScope.ownerDigest).all<{work_key:string;head_key:string;input_revision:string;partition_key:string;
    policy_revision:string;state:string;reason_code:string|null;revision:number;attempts:number;
    input_generation:number|null;input_rows:number|null;input_root:string|null;head_revision:string|null;
    head_generation:number|null;head_state:string|null;receipt_revision:number|null;receipt_input:string|null;
    receipt_partition:string|null;receipt_method:string|null;receipt_generation:number|null;receipt_rows:number|null}>()).results;
  const observations=[];
  for(const row of rows.slice(0,8)) {
   const match=/^(effective-union-v1|legacy-selected-v1)\/(usage)\/(\d{4}-\d{2}-\d{2}|unknown)\/([a-f0-9]{2,64})$/u.exec(row.partition_key);
   if(!match){observations.push({work:ordinal(trace.work,row.work_key),partitionValid:false});continue;}
   const root=row.partition_key.slice(0,-match[4]!.length)+match[4]!.slice(0,2);
   const dirty=await db.target.prepare(`SELECT d.generation,dw.generation work_generation,dw.admitted_generation
    FROM analytics_canonical_dirty_partitions d LEFT JOIN analytics_partition_dirty_work dw
     ON dw.partition_key=d.partition_key AND dw.source_id=? WHERE d.partition_key=?`)
    .bind(sourceId,root).first<{generation:number;work_generation:number|null;admitted_generation:number|null}>();
   const expected=dirty?await sha256Hex(canonicalJson([root,dirty.generation])):null;
   // These are read-only mirrors of the three guarded alternatives in
   // closeObsoleteAnalyticsManifestWork, reported separately so a reason code
   // alone never becomes a claim about which branch ran.
   const alternatives=await db.target.prepare(`SELECT
    EXISTS(SELECT 1 FROM analytics_canonical_partition_heads h JOIN analytics_canonical_manifests m USING(content_revision)
     JOIN analytics_partition_work next ON next.source_id=w.source_id AND next.stage=w.stage
      AND next.partition_key=h.partition_key AND next.input_revision=h.content_revision
      AND next.state IN('ready','leased','complete') WHERE h.partition_key=w.partition_key
      AND h.content_revision!=w.input_revision AND m.state='complete'
      AND m.generation=(SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=?3)) head_replacement,
    EXISTS(SELECT 1 FROM analytics_partition_dirty_work d JOIN analytics_canonical_dirty_partitions native USING(partition_key)
     JOIN analytics_partition_work next ON next.source_id=d.source_id AND next.partition_key=d.partition_key
      AND next.stage='features' AND next.input_revision=?2 AND next.state IN('ready','leased','complete')
     WHERE d.source_id=w.source_id AND d.partition_key=?3 AND d.generation=native.generation
      AND d.admitted_generation>=d.generation AND EXISTS(SELECT 1 FROM analytics_canonical_manifests old
       WHERE old.content_revision=w.input_revision AND old.generation<d.generation)) dirty_successor,
    (SELECT count(DISTINCT substr(next.partition_key,length(w.partition_key)+1,1)) FROM analytics_partition_work next
     WHERE next.source_id=w.source_id AND next.stage='features' AND next.input_revision=?2
      AND next.state IN('ready','leased','complete') AND substr(next.partition_key,-1,1) GLOB '[0-9a-f]'
      AND length(next.partition_key)=length(w.partition_key)+1
      AND substr(next.partition_key,1,length(w.partition_key))=w.partition_key
      AND EXISTS(SELECT 1 FROM analytics_partition_dirty_work d JOIN analytics_canonical_dirty_partitions native USING(partition_key)
       WHERE d.source_id=w.source_id AND d.partition_key=?3 AND d.generation=native.generation
        AND d.admitted_generation>=d.generation)) split_children
    FROM analytics_partition_work w WHERE w.work_key=?1`).bind(row.work_key,expected,root)
    .first<{head_replacement:number;dirty_successor:number;split_children:number}>();
   const features=(await db.target.prepare(`SELECT work_key,state,attempts,policy_revision FROM analytics_partition_work
    WHERE source_id=? AND stage='features' AND partition_key=? AND input_revision=?
    ORDER BY work_key LIMIT 5`).bind(sourceId,root,expected)
    .all<{work_key:string;state:string;attempts:number;policy_revision:string}>()).results;
   const slots=await db.target.prepare(`SELECT count(*) rows,
    sum(CASE WHEN s.fact_revision IS NOT NULL AND f.stream='usage' AND s.slot_key=f.selection_method||'/'||f.occurrence_key
     AND s.occurrence_key=f.occurrence_key AND s.root_partition_key=? AND s.source_id=f.source_id
     AND s.owner_digest=f.owner_digest AND s.selection_method=f.selection_method THEN 1 ELSE 0 END) matched
    FROM analytics_canonical_manifest_rows mr LEFT JOIN analytics_canonical_facts f ON f.revision=mr.revision
    LEFT JOIN analytics_canonical_cache_slots s ON s.fact_revision=mr.revision WHERE mr.content_revision=?`)
    .bind(root,row.input_revision).first<{rows:number;matched:number|null}>();
   const receiptValid=await db.target.prepare(`SELECT CASE WHEN ${CANONICAL_CACHE_PREPARED_READY_PREDICATE}
    THEN 1 ELSE 0 END valid FROM analytics_partition_work w WHERE w.work_key=?`)
    .bind(row.work_key).first<number>('valid');
   observations.push({work:ordinal(trace.work,row.work_key),head:ordinal(trace.head,row.head_key),
    input:ordinal(trace.input,row.input_revision),headInput:ordinal(trace.input,row.head_revision),
    partitionValid:true,state:row.state,reason:row.reason_code,revision:row.revision,attempts:row.attempts,
    inputMatchesHead:row.input_revision===row.head_revision,inputGeneration:row.input_generation,
    headGeneration:row.head_generation,headComplete:row.head_state==='complete',
    headMatchesDirty:row.head_generation!==null&&row.head_generation===(dirty?.generation??null),
    dirtyGeneration:dirty?.generation??null,
    dirtyWorkGeneration:dirty?.work_generation??null,admittedGeneration:dirty?.admitted_generation??null,
    dirtyWorkCurrent:dirty!==null&&dirty.work_generation===dirty.generation
     &&dirty.admitted_generation!==null&&dirty.admitted_generation>=dirty.generation,
    inputManifestRows:row.input_rows,slotRows:slots?.rows??null,matchingSlots:slots?.matched??null,
    preparedReceiptPresent:row.receipt_revision!==null,
    receiptRevisionMatches:row.receipt_revision!==null&&row.revision===row.receipt_revision+1,
    receiptInputMatches:row.receipt_input===row.input_revision,receiptPartitionMatches:row.receipt_partition===row.partition_key,
    receiptMethodMatches:row.receipt_method===CANONICAL_CACHE_PAIR_METHOD,
    receiptGenerationMatches:row.receipt_revision!==null&&row.receipt_generation===row.input_generation,
    receiptRowsMatch:row.receipt_revision!==null&&row.receipt_rows===row.input_rows,
    preparedReadyPredicate:receiptValid===1,headReplacement:alternatives?.head_replacement===1,
    dirtySuccessor:alternatives?.dirty_successor===1,splitChildren:alternatives?.split_children??null,
    featureInputDigestMatched:features.length>0,featureOverflow:features.length>4,
    currentFeatureRows:features.slice(0,4).map(feature=>({work:ordinal(trace.work,feature.work_key),state:feature.state,
     attempts:feature.attempts,policyMatches:feature.policy_revision===row.policy_revision}))});
  }
  return {label,observations,overflow:rows.length>8,statements:meter.queriesUsed,
   contract:'Separate target-only metered observation; exact predicate booleans are not source proof or role admission.'};
 });
}

const emptyEpisode=():Episode=>({costs:[],claims:[]});
async function restore() {
 await reset();const started=performance.now(),proofs=[];
 for(const side of ['source','target','ledger'] as const){const imported=await importAcceptedSourceTransfer(startup[side],stores()[side]);
  expect(imported.proof).toEqual(startup[side].proof);proofs.push({side,statements:imported.importProfile.statements+imported.proofProfile.statements});}
 return {elapsedMs:performance.now()-started,proofs,contract:'Startup copy and proof are separate laboratory work, before measured role scheduling.'};
}
async function delivery(episode:Episode,max:number) {
 for(let turn=0;turn<max;turn++){
  const result=await invocation(episode,'ordered_delivery',db=>runStorageAnalyticsPass({...db,sourceId,sourceNamespace:sourceId,
   publishCommunity:false,maxQueries:950,maxSteps:32,deadlineMs:Date.now()+60_000}));
  expect(result.state).not.toBe('unavailable');
  if(result.state==='idle'&&result.reason==='complete')return turn+1;
 }
 throw Error('SKEW_FIXTURE_DELIVERY_CEILING');
}
async function acceptedSparse(episode:Episode,day:string) {
 return invocation(episode,'accepted_sparse_update',async db=>{
  const device=await createV11DeviceFixture(db.source,{grant:true});
  const prepared=await makeV11Day(day,{usage:[v11UsageRecord(day,'a',{eventId:'event:v2:'+await sha256Hex('synthetic-skew-fresh')})]},'synthetic-skew-fairness');
  await registerTelemetryV11DayManifest(db.source,device,prepared.manifest);
  for(const chunk of prepared.chunks){
   const envelopeDigest=await sha256Hex(canonicalJson(['synthetic-skew-upload',chunk.chunkDigest]));
   const principal=await authenticateDevice(db.source,device.authorization),upload=await createDeviceUploadAuthorization(db.source,principal,envelopeDigest,4096);
   const claimed=await claimDeviceUploadAuthorization(db.source,'Upload '+upload.uploadAuthorization,{envelopeDigest,bodyBytes:4096,contentType:'application/json'});
   await persistTypedV11StagedChunk(db.source,device,chunk,{sourceNamespace:sourceId,chunkRowId:'chunk:'+crypto.randomUUID(),
    envelopeDigest,deviceUploadAuthorizationId:claimed.authorizationId,r2Key:'synthetic/skew-fairness'});
  }
  const ready=await registerTelemetryV11DayManifest(db.source,device,prepared.manifest),predecessor=await createTelemetryV11DomainPredecessor(db.source,device);
  // Native predecessor closure includes today even when the accepted update
  // is yesterday. Preserve that horizon with genuine empty day manifests.
  const fromDay=day<predecessor.fromDay?day:predecessor.fromDay,throughDay=day>predecessor.throughDay?day:predecessor.throughDay;
  expect((Date.parse(throughDay)-Date.parse(fromDay))/dayMs+1).toBeLessThanOrEqual(2);
  const days:TelemetryV11DomainManifest['days']=[];
  for(let at=Date.parse(fromDay+'T00:00:00.000Z');at<=Date.parse(throughDay+'T00:00:00.000Z');at+=dayMs){
   const currentDay=new Date(at).toISOString().slice(0,10),value=currentDay===day?ready:
    await registerTelemetryV11DayManifest(db.source,device,(await makeV11Day(currentDay,{},'synthetic-skew-fairness')).manifest);
   days.push({day:currentDay,manifestId:value.manifestId,manifestDigest:value.manifestDigest});
  }
  const domain:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',fromDay,throughDay,
   predecessor:{token:predecessor.token,previousGenerationId:predecessor.previousGenerationId,legacyFingerprint:predecessor.legacyFingerprint},
   days,manifestDigest:'0'.repeat(64)};
  domain.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(domain));await activateTelemetryV11Domain(db.source,device,domain);
  const owners=(await readStorageCommunityOwnerPage(db.source)).filter(owner=>owner.participantId===device.participantId);
  expect(owners).toHaveLength(1);expect(owners[0]!.ownerDigest).toBeTruthy();
  expect(await db.source.prepare(`SELECT count(*) n FROM typed_telemetry_records r JOIN typed_v11_owner_memberships o ON o.typed_owner_id=r.owner_id
   WHERE o.participant_id=? AND r.stream=1 AND r.format=11`).bind(device.participantId).first<number>('n')).toBe(1);
  return {sourceId,sourceNamespace:sourceId,ownerDigest:owners[0]!.ownerDigest!,participantId:device.participantId,day,
   stream:'usage' as const,selectionMethod:'effective-union-v1' as const};
 });
}
async function cover(episode:Episode) {
 for(let turn=0;turn<ceiling.coverage;turn++)if((await invocation(episode,'coverage',(db,meter)=>advanceEffectiveDependencyCoverage(db.source,
  {sourceId,sourceNamespace:sourceId,maxSteps:64,maxRows:128,budget:meter}))).status==='complete')return;
 throw Error('SKEW_FIXTURE_COVERAGE_CEILING');
}
async function acceptedHistory(episode:Episode) {
 const device=await invocation(episode,'accepted_history_device',db=>createV11DeviceFixture(db.source));
 historyDevice=device; // Only an in-memory synthetic test credential; never enters receipts.
 // Nine genuine native selected days require18 usage/quota scopes; the
 // existing window producer prepares at most8 scopes in one bounded pass.
 for(let index=0;index<9;index++)await invocation(episode,'accepted_history_day',async db=>{
  const day=corpus.historyDates[index]!,projected=telemetryV11LegacyProjection('usage',v11UsageRecord(day,'a',{
   eventId:'event:v2:'+await sha256Hex('synthetic-skew-history:'+index)}));expect(projected).not.toBeNull();
  const records=[JSON.parse(projected!.canonicalRecord)],chunk=parseTelemetryV1Chunk({schemaVersion:'telemetry-contribution-v1.0',
   chunkId:'usage:'+day+':0',chunkRevision:1,chunkDigest:await sha256Hex(canonicalJson(records)),parserVersion:'synthetic-skew-history',
   consent:{telemetrySchemaVersion:'telemetry-contribution-v1.0',fieldDictionaryVersion:'telemetry-v1.0-registry-2026-08-07.1',privacyContractVersion:'ongoing-privacy-safe-telemetry-v1.0'},records});
  const envelopeDigest=await sha256Hex('synthetic-skew-history-upload:'+index),principal=await authenticateDevice(db.source,device.authorization);
  const authorization=await createDeviceUploadAuthorization(db.source,principal,envelopeDigest,4096),claim=await claimDeviceUploadAuthorization(db.source,
   'Upload '+authorization.uploadAuthorization,{envelopeDigest,bodyBytes:4096,contentType:'application/json'});
  await insertTypedTelemetryV1Chunk(db.source,{chunkRowId:'chunk:skew-history:'+index,participantId:device.participantId,deviceId:device.deviceId,
   chunk,envelopeDigest,deviceUploadAuthorizationId:claim.authorizationId,r2Key:'synthetic/skew-history/'+index,createdAt:new Date().toISOString(),supersedes:null},sourceId);
 });
 historyOwner=await invocation(episode,'native_history_owner_proof',async db=>{
  const owner=(await readStorageCommunityOwnerPage(db.source)).find(value=>value.participantId===device.participantId);
  expect(owner?.hasV1).toBe(true);expect(owner?.hasV11).toBe(false);expect(owner?.ownerDigest).toBeTruthy();
  expect(await db.source.prepare('SELECT count(*) n FROM typed_telemetry_records r JOIN typed_v1_owner_memberships m ON m.typed_owner_id=r.owner_id WHERE m.participant_id=? AND r.format=10 AND r.stream=1')
   .bind(device.participantId).first<number>('n')).toBe(9);
  return {participantId:device.participantId,ownerDigest:owner!.ownerDigest!};
 });
}
async function prepareHistoryRequest(episode:Episode) {
 const result=await invocation(episode,'native_history_window_request',async db=>{
  const pin=await loadV1SourcePin(db.source,{participantId:historyOwner.participantId,fromDay:corpus.historyDates[0]!,throughDay:corpus.historyDates[8]!});
  expect(pin.winners).toHaveLength(9);
  return advanceCanonicalV1Window({...db,sourceId,sourceNamespace:sourceId,ownerDigest:historyOwner.ownerDigest,pin,kind:'legacy-model',maxQueries:950,deadlineMs:Date.now()+60_000});
 });
 expect(result.state).toBe('deferred');
 historyWindow=await invocation(episode,'native_history_request_proof',async db=>{
  const rows=(await db.target.prepare("SELECT window_key,native_dependency,member_count FROM analytics_canonical_rolling_windows WHERE owner_digest=? AND state='building'")
   .bind(historyOwner.ownerDigest).all<typeof historyWindow>()).results;expect(rows).toHaveLength(1);expect(rows[0]!.member_count).toBe(18);return rows[0]!;
 });
}
async function prepareScope(episode:Episode,scope:CanonicalInputScope) {
 for(let turn=0;turn<ceiling.input;turn++)if((await invocation(episode,'canonical_input',(db,meter)=>advanceCanonicalInputWork(db.source,db.target,
  {...scope,budget:{meter,maxSteps:1,now:Date.now,deadlineMs:Date.now()+60_000}}))).state==='complete'){
   expect(await invocation(episode,'input_final_proof',db=>readCanonicalInputSeal(db.source,db.target,scope))).not.toBeNull();return;
  }
 throw Error('SKEW_FIXTURE_INPUT_CEILING');
}
async function bridgeCanonicalEffects(episode:Episode) {
 for(let turn=0;turn<ceiling.effects;turn++){
  const done=await invocation(episode,'original_effect_bridge',(db,meter)=>advanceAnalyticsWorkEffects({...db,sourceId,sourceNamespace:sourceId,
   meter,now:Date.now,deadlineMs:Date.now()+60_000,maxEffects:16,maxDays:1}));expect(done.state).not.toBe('unavailable');
  if(await invocation(episode,'effect_population',db=>db.target.prepare("SELECT count(*) n FROM analytics_partition_canonical_effects WHERE state='pending'").first<number>('n'))===0)return;
 }
 throw Error('SKEW_FIXTURE_EFFECT_CEILING');
}
async function prepareOriginalFeatures(episode:Episode) {
 for(let turn=0;turn<ceiling.features;turn++){
  if(await invocation(episode,'feature_population',db=>db.target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='ready'").first<number>('n'))===0)return;
  const result=await invocation(episode,'original_feature_consumer',(db,meter)=>runCanonicalAnalyticsWorkPass({...db,sourceId,sourceNamespace:sourceId,
   invocation:meter,now:Date.now,deadlineMs:Date.now()+60_000,degree:1,maxWaves:1,stages:['features'],bridge:false}));
  expect(result.failed).toBe(0);expect(result.releaseDeferred).toBe(0);expect(result.complete+result.refused).toBeGreaterThan(0);
 }
 throw Error('SKEW_FIXTURE_FEATURE_CEILING');
}
async function currentFacts(episode:Episode,scope:CanonicalInputScope) {
 return invocation(episode,'current_native_membership',async db=>{
  const page=await readCanonicalInputFactPage(db.source,db.target,scope,{limit:128});expect(page).not.toBeNull();expect(page!.next).toBeNull();
  const facts=await readCanonicalFacts(db.target,page!.refs.map(ref=>ref.revision));expect(facts).toHaveLength(page!.refs.length);
  return {seal:page!.seal,facts};
 });
}

async function nativePopulations(episode:Episode,label:string) {
 return invocation(episode,label,async db=>({
  work:(await db.target.prepare('SELECT stage,state,reason_code,count(*) jobs FROM analytics_partition_work GROUP BY stage,state,reason_code ORDER BY stage,state,reason_code').all()).results,
  facts:(await db.target.prepare('SELECT stream,status,count(*) facts FROM analytics_canonical_facts GROUP BY stream,status ORDER BY stream,status').all()).results,
  typedAccepted:(await db.source.prepare('SELECT format,stream,count(*) records FROM typed_telemetry_records GROUP BY format,stream ORDER BY format,stream').all()).results,
  bootstrap:await db.source.prepare('SELECT complete FROM storage_effective_selective_bootstrap WHERE id=1').first<number>('complete'),
  sourcePending:await db.source.prepare('SELECT count(*) n FROM storage_effective_selective_owners WHERE needs_work=1 OR seeded=0').first<number>('n'),
 }));
}

function aggregate(episode:Episode) {
 return {invocations:episode.costs.length,statements:episode.costs.reduce((n,c)=>n+c.statements,0),maximumStatements:Math.max(0,...episode.costs.map(c=>c.statements)),
  rowsRead:episode.costs.reduce((n,c)=>n+c.rowsRead,0),rowsWritten:episode.costs.reduce((n,c)=>n+c.rowsWritten,0),elapsedMs:episode.costs.reduce((n,c)=>n+c.elapsedMs,0),
  claims:episode.claims.length,stages:episode.claims.reduce<Record<string,number>>((out,c)=>{out[c.stage]=(out[c.stage]??0)+1;return out;},{}),
  lanes:episode.claims.reduce<Record<string,number>>((out,c)=>{out[c.lane]=(out[c.lane]??0)+1;return out;},{}),cpuMs:null,observedPeakHeapBytes:null,
  residentContract:'32MiB is declared admission metadata, not measured isolate peak.',steps:episode.costs};
}


async function scheduled(episode:Episode,role:'analytics'|'cache',captureEffects=false) {
 const profile=createAnalyticsProfile(),started=performance.now(),raw=stores(),logs:Record<string,unknown>[]=[];
 const controlPrelude:{kind:'runtime_schema'|'runtime_upsert'|'other';outcome:string}[]=[];let targetStatements=0;
 const db={source:profileAnalyticsDatabase(raw.source,'source',profile,()=>role),
  target:profileAnalyticsDatabase(traceClaims(raw.target,episode.claims,episode.trace?{trace:episode.trace,role,queries:()=>summarizeAnalyticsProfile(profile).statements}:undefined),'target',profile,()=>role,observation=>{
   // Match only the role's first two observed target operations; retain closed
   // identities/outcomes, never query text, bindings or result values.
   if(targetStatements<2)controlPrelude.push({
    kind:observation.sql==="SELECT 1 ready FROM sqlite_schema WHERE type='table' AND name=?"?'runtime_schema':
     observation.sql.startsWith('INSERT INTO analytics_pipeline_runtime(')?'runtime_upsert':'other',outcome:observation.outcome});
   targetStatements++;
  }),ledger:profileAnalyticsDatabase(raw.ledger,'ledger',profile,()=>role)};
 const log=vi.spyOn(console,'log').mockImplementation((value:unknown)=>{
  if(typeof value==='string'){const decoded:unknown=JSON.parse(value);if(decoded&&typeof decoded==='object'&&!Array.isArray(decoded))logs.push(decoded as Record<string,unknown>);}
 });
 const error=vi.spyOn(console,'error').mockImplementation((value:unknown)=>{
  if(typeof value==='string'){const decoded:unknown=JSON.parse(value);if(decoded&&typeof decoded==='object'&&!Array.isArray(decoded))logs.push(decoded as Record<string,unknown>);}
 });
 try {
  if(role==='cache')await runCacheRetentionDaySchedule({STORAGE_INGESTION_DB:db.source,STORAGE_ANALYTICS_DB:db.target,STORAGE_SOURCE_ID:sourceId,
   TELEMETRY_STORAGE_NAMESPACE:sourceId,CACHE_RETENTION_BUILD:'enabled',STORAGE_ANALYTICS_CANONICAL_PIPELINE:'enabled',STORAGE_ANALYTICS_SHARED_FEATURES:'enabled'} as CacheRetentionDayWorkerEnv);
  else {
   // Select an ordinary cron minute without replacing real operational clocks.
   const now=Date.now(),scheduledMs=now-(new Date(now).getUTCMinutes()%10===0?60_000:0);
   await runStorageAnalyticsSchedule({STORAGE_INGESTION_DB:db.source,STORAGE_ANALYTICS_DB:db.target,DELETION_LEDGER:db.ledger,STORAGE_SOURCE_ID:sourceId,
    TELEMETRY_STORAGE_NAMESPACE:sourceId,STORAGE_ANALYTICS_MODE:'enabled',PUBLIC_ANALYTICS_MODE:'enabled',PUBLICATION_LANE_EXTERNAL:'enabled',
    STORAGE_ANALYTICS_CANONICAL_PIPELINE:'enabled',STORAGE_ANALYTICS_SHARED_FEATURES:'enabled',STORAGE_ANALYTICS_MODEL_BLOCKS:'enabled'} as StorageAnalyticsWorkerEnv,{nowMs:scheduledMs});
  }
 } finally {log.mockRestore();error.mockRestore();}
 const summary=summarizeAnalyticsProfile(profile);expect(summary.statements).toBeLessThanOrEqual(950);expect(summary.failedStatements).toBe(0);
 episode.costs.push({label:role+'_schedule',statements:summary.statements,metadataSamples:summary.metadataSamples,failedStatements:summary.failedStatements,
  rowsRead:summary.rowsRead,rowsWritten:summary.rowsWritten,elapsedMs:performance.now()-started});
 const receipt=logs.find(value=>value.event===(role==='cache'?'cache_retention_day_schedule':'storage_analytics_schedule'));
 expect(receipt,'The actual role must produce its closed receipt').toBeDefined();expect(receipt!.state).not.toBe('unavailable');
 // Canonical cache receipts count the kernel; the role's exact fresh schema
 // read and control upsert precede it on the same actual950 invocation meter.
 if(role==='cache'){
  expect(controlPrelude).toEqual([{kind:'runtime_schema',outcome:'success'},{kind:'runtime_upsert',outcome:'success'}]);
  expect(Number(receipt!.statements)+controlPrelude.length).toBe(summary.statements);
 }else expect(receipt!.queriesUsed).toBe(summary.statements);
 const work=role==='cache'?receipt:receipt!.canonicalWork as Record<string,unknown>|undefined;
 if(work){expect(work.failed).toBe(0);expect(work.releaseDeferred).toBe(0);}
 const nativeEffects=work?.effects as Record<string,unknown>|undefined;
 const effects=captureEffects?{executed:!!nativeEffects,state:typeof nativeEffects?.state==='string'?nativeEffects.state:null,
  rangesAdmitted:typeof nativeEffects?.rangesAdmitted==='number'?nativeEffects.rangesAdmitted:null,
  rangesAcknowledged:typeof nativeEffects?.rangesAcknowledged==='number'?nativeEffects.rangesAcknowledged:null,
  daysAdmitted:typeof nativeEffects?.daysAdmitted==='number'?nativeEffects.daysAdmitted:null,
  canonicalEffects:typeof nativeEffects?.canonicalEffects==='number'?nativeEffects.canonicalEffects:null,
  globalOwners:typeof nativeEffects?.globalOwners==='number'?nativeEffects.globalOwners:null,
  statements:typeof nativeEffects?.statements==='number'?nativeEffects.statements:null}:undefined;
 return {claimed:Number(work?.claimed??0),admitted:typeof work?.admitted==='number'?work.admitted:null,complete:Number(work?.complete??0),deferred:Number(work?.deferred??0),refused:Number(work?.refused??0),
  reason:typeof work?.reason==='string'?work.reason:null,queries:summary.statements,controlPrelude,
  ...(captureEffects?{effects}:{})};
}

it('accepts a genuine fresh sparse v11 owner with the complete native predecessor horizon',async({task})=>{
 await reset();const started=performance.now(),raw=stores(),profile=createAnalyticsProfile();
 await initializeSharedAnalyticsCorpusDatabases(profileAnalyticsDatabase(raw.source,'source',profile,()=> 'small_fixture_setup'),
  profileAnalyticsDatabase(raw.target,'target',profile,()=> 'small_fixture_setup'),b,sourceId);
 const setup=summarizeAnalyticsProfile(profile),episode=emptyEpisode(),day=new Date(Date.now()-dayMs).toISOString().slice(0,10);
 const scope=await acceptedSparse(episode,day);
 await invocation(episode,'sparse_native_horizon_proof',async db=>{
  const domain=await db.source.prepare(`SELECT d.from_day,d.through_day,(SELECT count(*) FROM telemetry_v11_domain_days x WHERE x.generation_id=d.id) AS days
   FROM telemetry_v11_domain_heads h JOIN telemetry_v11_domains d ON d.id=h.generation_id WHERE h.participant_id=?`)
   .bind(scope.participantId).first<{from_day:string;through_day:string;days:number}>();
  expect(domain).toEqual({from_day:day,through_day:new Date().toISOString().slice(0,10),days:2});
  expect(await db.source.prepare(`SELECT count(*) n FROM typed_telemetry_records r JOIN typed_v11_owner_memberships o ON o.typed_owner_id=r.owner_id
   WHERE o.participant_id=? AND r.stream=1 AND r.format=11`).bind(scope.participantId).first<number>('n')).toBe(1);
  expect((await readStorageCommunityOwnerPage(db.source)).some(owner=>owner.participantId===scope.participantId&&owner.ownerDigest===scope.ownerDigest&&owner.hasV11)).toBe(true);
 });
 const emptyCacheRole=await scheduled(episode,'cache');expect(emptyCacheRole.claimed).toBe(0);
 Object.assign(task.meta,{skewSparseFixtureReceipt:{laboratorySetup:{elapsedMs:performance.now()-started,statements:setup.statements,rowsRead:setup.rowsRead,rowsWritten:setup.rowsWritten},
  acceptedUsageRows:1,nativeDomainDays:2,emptyCacheRole,resources:aggregate(episode),qualification:'Only genuine sparse native admission/predecessor closure; no scheduler fairness qualification.'}});
},30_000);

describe('native skew role qualification',()=>{
beforeAll(async({},suite)=>{
 await reset();const started=performance.now(),raw=stores(),profile=createAnalyticsProfile(),setup=emptyEpisode();
 try {
 const source=profileAnalyticsDatabase(raw.source,'source',profile,()=> 'laboratory_acceptance'),target=profileAnalyticsDatabase(raw.target,'target',profile,()=> 'laboratory_acceptance');
 await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId);
 await applyD1Migrations(raw.ledger,b.TEST_DELETION_LEDGER_MIGRATIONS);
 corpus=await seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,calendarDays:14,graphDays:2,denseUsageRows:64,
  anchorDay:new Date(Date.now()-104*dayMs).toISOString().slice(0,10),secondaryOwnerKind:'accountless',targetAuthority:'ordered-delivery'});
 await acceptedHistory(setup);await delivery(setup,ceiling.delivery);await cover(setup);
 const owners=await invocation(setup,'source_owner_proof',db=>readStorageCommunityOwnerPage(db.source));
 const victim=owners.find(owner=>owner.participantId===corpus.secondaryAccountless!.participantId);expect(victim?.ownerDigest).toBeTruthy();
 const scope=(ownerDigest:string,participantId:string,day:string):CanonicalInputScope=>({sourceId,sourceNamespace:sourceId,ownerDigest,participantId,day,stream:'usage',selectionMethod:'effective-union-v1'});
 oldScope=scope(corpus.owner.ownerDigest,corpus.participantId,corpus.historyDates[0]!);
 hotScope=scope(corpus.owner.ownerDigest,corpus.participantId,corpus.graphDates[0]!);
 withdrawScope=scope(victim!.ownerDigest!,victim!.participantId,corpus.equivalentDay);
 expect(Date.now()-Date.parse(oldScope.day+'T00:00:00Z')).toBeGreaterThan(101*dayMs);
 for(const value of [oldScope,hotScope,withdrawScope])await prepareScope(setup,value);
 await bridgeCanonicalEffects(setup);await prepareOriginalFeatures(setup);
 const coldReady=await scopeJobs(setup,hotScope,'ready');expect(coldReady).toBeGreaterThan(8);
 // Fresh acceptance happens after genuine cold descendants already exist.
 sparseScope=await acceptedSparse(setup,new Date(Date.now()-dayMs).toISOString().slice(0,10));
 await delivery(setup,ceiling.delivery);await cover(setup);await prepareScope(setup,sparseScope);await bridgeCanonicalEffects(setup);await prepareOriginalFeatures(setup);
 await prepareHistoryRequest(setup);
 const dense=await currentFacts(setup,hotScope),sparse=await currentFacts(setup,sparseScope),old=await currentFacts(setup,oldScope),withdraw=await currentFacts(setup,withdrawScope);
 expect(dense.facts.length).toBeGreaterThanOrEqual(64);expect(sparse.facts).toHaveLength(1);expect(old.facts.length).toBeGreaterThan(0);expect(withdraw.facts).toHaveLength(1);
 expect(new Set([oldScope.ownerDigest,sparseScope.ownerDigest,withdrawScope.ownerDigest]).size).toBe(3);
 const copies={} as typeof startup;for(const side of ['source','target','ledger'] as const)copies[side]=(await captureAcceptedSourceTransfer(raw[side])).transfer;
 startup=copies;const acceptance=summarizeAnalyticsProfile(profile);
 laboratorySetup={elapsedMs:performance.now()-started,acceptedDenseExtraRows:64,acceptedSparseRows:1,retainedDays:14,
  oldestAgeDays:Math.floor((Date.now()-Date.parse(oldScope.day+'T00:00:00Z'))/dayMs),coldReady,
  acceptance:{statements:acceptance.statements,rowsRead:acceptance.rowsRead,rowsWritten:acceptance.rowsWritten},preparation:setup.costs,
  startupProofs:Object.fromEntries(Object.entries(startup).map(([side,value])=>[side,value.proof])),ceilings:ceiling,
  acceptedHistoryRows:9,historyScopeCount:18,
  contract:'Actual native acceptance/ordered delivery/coverage/input/effects/original feature producers and real native rolling-window request; all setup is separate. No job insertion, fabricated ACK, history-lane relabelling or current-result substitution.'};
 } catch(error) {
  let populations:unknown=null;
  try {populations=await invocation(setup,'setup_failure_shape',async db=>({
   work:(await db.target.prepare('SELECT stage,state,reason_code,count(*) jobs FROM analytics_partition_work GROUP BY stage,state,reason_code ORDER BY stage,state,reason_code').all()).results,
   facts:(await db.target.prepare('SELECT stream,status,count(*) facts FROM analytics_canonical_facts GROUP BY stream,status ORDER BY stream,status').all()).results,
   typedAccepted:(await db.source.prepare('SELECT format,stream,count(*) records FROM typed_telemetry_records GROUP BY format,stream ORDER BY format,stream').all()).results,
   bootstrap:await db.source.prepare('SELECT complete FROM storage_effective_selective_bootstrap WHERE id=1').first<number>('complete'),
   sourcePending:await db.source.prepare('SELECT count(*) n FROM storage_effective_selective_owners WHERE needs_work=1 OR seeded=0').first<number>('n'),
  }));}catch{populations={diagnosticUnavailable:true};}
  const acceptance=summarizeAnalyticsProfile(profile);
  for(const task of suite.tasks)Object.assign(task.meta,{skewSetupFailure:{populations,preparation:aggregate(setup),
   acceptance:{statements:acceptance.statements,rowsRead:acceptance.rowsRead,rowsWritten:acceptance.rowsWritten},ceilings:ceiling,
   qualification:'Fixture did not reach measured role admission. No fairness/capacity conclusion.'}});
  throw error;
 }
},120_000);

it('paces a real legacy rolling request when it claims between successor selection and admission',async({task})=>{
 const imported=await restore(),episode=emptyEpisode(),nowMs=Date.now();
 const partitionKey='rolling-window/'+historyWindow.window_key;
 const headKey=await sha256Hex(canonicalJson(['rolling-window',sourceId,historyWindow.window_key]));
 const oldPolicy=await sha256Hex(canonicalJson(['rolling-window-producer-v1']));
 const newPolicy=await sha256Hex(canonicalJson(['rolling-window-producer-v2',300]));
 const oldRequest:AnalyticsWorkRequest={sourceId,ownerDigest:historyOwner.ownerDigest,stage:'fits',lane:'history',
  partitionKey,headKey,inputRevision:historyWindow.native_dependency,policyRevision:oldPolicy,day:null,stream:null,
  selectionMethod:'legacy-selected-v1',residentBytes:8*1024*1024,admissionQueries:600};
 const newRequest={...oldRequest,policyRevision:newPolicy,admissionQueries:300};
 const oldKey=await analyticsWorkKey(oldRequest),newKey=await analyticsWorkKey(newRequest);
 await invocation(episode,'exact_old_producer_request',async db=>{
  expect(await db.target.prepare('SELECT state FROM analytics_canonical_rolling_windows WHERE window_key=? AND source_id=? AND owner_digest=?')
   .bind(historyWindow.window_key,sourceId,historyOwner.ownerDigest).first<string>('state')).toBe('building');
  expect(await db.target.prepare("SELECT count(*) n FROM analytics_partition_work WHERE source_id=? AND stage='fits'")
   .bind(sourceId).first<number>('n')).toBe(0);
  expect(await admitAnalyticsPartitionWork(db.target,[oldRequest],nowMs)).toEqual([oldKey]);
 });
 let legacyLease:Awaited<ReturnType<typeof claimAnalyticsPartitionWork>>[number]|undefined;
 let injected=false;
 const runProducer=async(label:string,at:number,interleave=false)=>{
  const outer=createD1InvocationBudget(950),phase=createD1InvocationBudget(180),raw=stores();
  const profile=createAnalyticsProfile(),started=performance.now();
  const tagged=new WeakSet<D1PreparedStatement>();
  const tag=(statement:D1PreparedStatement,match=false):D1PreparedStatement=>{
   const wrapped=new Proxy(statement,{get(inner,key){
    if(key==='bind')return(...values:unknown[])=>tag(inner.bind(...values),typeof values[0]==='string'
     &&values[0].includes(newPolicy)&&values[0].includes(partitionKey));
    const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
   }});if(match)tagged.add(wrapped);return wrapped;
  };
  let target!:D1Database;
  const interception=new Proxy(raw.target,{get(database,key){
   if(key==='prepare')return(sql:string)=>sql.startsWith('INSERT INTO analytics_partition_work(')
    ?tag(database.prepare(sql)):database.prepare(sql);
   if(key==='batch')return async(statements:D1PreparedStatement[])=>{
    if(interleave&&!injected&&statements.some(statement=>tagged.has(statement))){
     injected=true;
     const leases=await claimAnalyticsPartitionWork(target,{sourceId,limit:1,nowMs:at,stages:['fits'],
      maxAdmissionQueries:600});
     expect(leases.map(lease=>lease.workKey)).toEqual([oldKey]);legacyLease=leases[0];
    }
    return database.batch(statements);
   };
   const value:unknown=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
  }});
  const source=phase.wrap(outer.wrap(profileAnalyticsDatabase(raw.source,'source',profile,()=>label)));
  target=phase.wrap(outer.wrap(profileAnalyticsDatabase(interception,'target',profile,()=>label)));
  try{return await runCanonicalAnalyticsWorkPass({source,target,sourceId,sourceNamespace:sourceId,
   invocation:phase,now:()=>at,deadlineMs:at+60_000,degree:1,maxWaves:1,stages:['fits'],bridge:false});}
  finally {
   const summary=summarizeAnalyticsProfile(profile);
   episode.costs.push({label,statements:outer.queriesUsed,metadataSamples:summary.metadataSamples,
    failedStatements:summary.failedStatements,rowsRead:summary.rowsRead,rowsWritten:summary.rowsWritten,
    elapsedMs:performance.now()-started});
   expect(outer.queriesUsed).toBe(phase.queriesUsed);expect(summary.statements).toBe(outer.queriesUsed);
   expect(outer.queriesUsed).toBeLessThanOrEqual(950);
  }
 };
 try {
  await runProducer('v2_admission_with_native_claim_race',nowMs,true);
  expect(injected).toBe(true);expect(legacyLease).toBeDefined();
  await invocation(episode,'live_legacy_and_durable_successor',async db=>{
   const rows=(await db.target.prepare(`SELECT work_key,state,policy_revision,input_revision,head_key,admission_queries,
    claim_expires_ms,ready_ms,attempts FROM analytics_partition_work WHERE work_key IN(?,?) ORDER BY work_key`)
    .bind(oldKey,newKey).all()).results;
   expect(rows).toHaveLength(2);
   expect(rows.find(row=>row.work_key===oldKey)).toMatchObject({state:'leased',policy_revision:oldPolicy,
    input_revision:historyWindow.native_dependency,head_key:headKey,admission_queries:600});
   expect(rows.find(row=>row.work_key===newKey)).toMatchObject({state:'ready',policy_revision:newPolicy,
    input_revision:historyWindow.native_dependency,head_key:headKey,admission_queries:300,attempts:0});
  });
  expect(await invocation(episode,'native_legacy_failure',db=>releaseAnalyticsPartitionWork(db.target,legacyLease!,'failure',nowMs+1))).toBe(true);
  await runProducer('legacy_backoff_kept',nowMs+2);
  await invocation(episode,'early_same_input_pacing',async db=>{
   expect(await claimAnalyticsPartitionWork(db.target,{sourceId,limit:1,nowMs:nowMs+2,stages:['fits'],
    maxAdmissionQueries:300})).toEqual([]);
   const old=await db.target.prepare('SELECT state,ready_ms,attempts FROM analytics_partition_work WHERE work_key=?')
    .bind(oldKey).first<{state:string;ready_ms:number;attempts:number}>();
   expect(old).toEqual({state:'ready',ready_ms:nowMs+5_001,attempts:1});
   expect(await db.target.prepare('SELECT attempts FROM analytics_partition_work WHERE work_key=?')
    .bind(newKey).first<number>('attempts')).toBe(0);
  });
  const [successor]=await invocation(episode,'due_successor_claim',db=>claimAnalyticsPartitionWork(db.target,
   {sourceId,limit:1,nowMs:nowMs+5_001,stages:['fits'],maxAdmissionQueries:300}));
  expect(successor?.workKey).toBe(newKey);
  expect(await invocation(episode,'defer_unexecuted_successor',db=>releaseAnalyticsPartitionWork(db.target,successor!,'not_admitted',nowMs+5_002))).toBe(true);
  await runProducer('guarded_due_legacy_cleanup',nowMs+5_003);
  await invocation(episode,'exact_no_duplicate_or_source_rewrite',async db=>{
   expect(await db.target.prepare('SELECT state FROM analytics_partition_work WHERE work_key=?').bind(oldKey)
    .first<string>('state')).toBe('refused');
   expect(await db.target.prepare('SELECT count(*) n FROM analytics_partition_work WHERE work_key=?')
    .bind(newKey).first<number>('n')).toBe(1);
   const pin=await loadV1SourcePin(db.source,{participantId:historyOwner.participantId,
    fromDay:corpus.historyDates[0]!,throughDay:corpus.historyDates[8]!});
   expect(pin.fingerprint).toBe(historyWindow.native_dependency);await assertV1SourcePinCurrent(db.source,pin);
  });
 } finally {
  Object.assign(task.meta,{rollingPolicyRace:{imported,interleaved:injected,legacyFailurePaced:true,
   resources:aggregate(episode),contract:'Genuine native window and public immutable v1 admission; actual public claim between v2 selection and insert, real failure release, no source mutation. No full 18-member completion claim.'}});
 }
},120_000);

it('keeps a live or backed-off legacy request until its exact successor can be admitted and retired',async({task})=>{
 const imported=await restore(),episode=emptyEpisode(),nowMs=Date.now();
 const request:AnalyticsWorkRequest={sourceId,ownerDigest:historyOwner.ownerDigest,stage:'fits',lane:'history',
  partitionKey:'rolling-window/'+historyWindow.window_key,
  headKey:await sha256Hex(canonicalJson(['rolling-window',sourceId,historyWindow.window_key])),
  inputRevision:historyWindow.native_dependency,
  policyRevision:await sha256Hex(canonicalJson(['rolling-window-producer-v1'])),day:null,stream:null,
  selectionMethod:'legacy-selected-v1',residentBytes:8*1024*1024,admissionQueries:600};
 const oldKey=await analyticsWorkKey(request),newKey=await analyticsWorkKey({...request,
  policyRevision:await sha256Hex(canonicalJson(['rolling-window-producer-v2',300])),admissionQueries:300});
 const producer=async(label:string,at:number)=>invocation(episode,label,async db=>{
  const phase=createD1InvocationBudget(180);
  const result=await runCanonicalAnalyticsWorkPass({...db,sourceId,sourceNamespace:sourceId,source:phase.wrap(db.source),target:phase.wrap(db.target),
   invocation:phase,now:()=>at,deadlineMs:at+60_000,degree:1,maxWaves:1,stages:['fits'],bridge:false});
  expect(phase.queriesUsed).toBeLessThanOrEqual(180);expect(result.state).not.toBe('unavailable');
  return result;
 });
 try {
  expect(await invocation(episode,'historical_policy_request',db=>admitAnalyticsPartitionWork(db.target,[request],nowMs)))
   .toEqual([oldKey]);
  const [oldLease]=await invocation(episode,'actual_legacy_claim',db=>claimAnalyticsPartitionWork(db.target,
   {sourceId,limit:1,nowMs,stages:['fits'],maxAdmissionQueries:600}));
  expect(oldLease?.workKey).toBe(oldKey);
  await producer('live_legacy_cannot_be_superseded',nowMs+1);
  await invocation(episode,'live_legacy_unchanged',async db=>{
   expect(await db.target.prepare('SELECT state FROM analytics_partition_work WHERE work_key=?').bind(oldKey)
    .first<string>('state')).toBe('leased');
   expect(await db.target.prepare('SELECT count(*) n FROM analytics_partition_work WHERE work_key=?').bind(newKey)
    .first<number>('n')).toBe(0);
  });
  expect(await invocation(episode,'native_failure_backoff',db=>releaseAnalyticsPartitionWork(db.target,oldLease!,'failure',nowMs+1))).toBe(true);
  await producer('future_ready_legacy_cannot_be_superseded',nowMs+2);
  await invocation(episode,'exact_backoff_untouched',async db=>{
   expect(await db.target.prepare('SELECT ready_ms FROM analytics_partition_work WHERE work_key=?').bind(oldKey)
    .first<number>('ready_ms')).toBe(nowMs+5_001);
   expect(await db.target.prepare('SELECT count(*) n FROM analytics_partition_work WHERE work_key=?').bind(newKey)
    .first<number>('n')).toBe(0);
  });
  await producer('due_legacy_gains_exact_v2_successor',nowMs+5_001);
  await producer('idempotent_successor_admission',nowMs+5_002);
  await invocation(episode,'exact_successor_and_retirement',async db=>{
   expect(await db.target.prepare('SELECT state FROM analytics_partition_work WHERE work_key=?').bind(oldKey)
    .first<string>('state')).toBe('refused');
   expect(await db.target.prepare('SELECT count(*) n FROM analytics_partition_work WHERE work_key=?').bind(newKey)
    .first<number>('n')).toBe(1);
  });
 } finally {
  Object.assign(task.meta,{rollingPolicyBackoff:{imported,resources:aggregate(episode),
   contract:'Actual native rolling window and public immutable request admission, claim and failure release. Live and future-ready v1 retain their lease/backoff; due v1 is refused only after v2 durability.'}});
 }
},120_000);

it('retires a due legacy request only after a durable successor and reuses a current complete window',async({task})=>{
 const imported=await restore(),episode=emptyEpisode(),nowMs=Date.now();
 const oldPolicy=await sha256Hex(canonicalJson(['rolling-window-producer-v1']));
 const newPolicy=await sha256Hex(canonicalJson(['rolling-window-producer-v2',300]));
 const request:AnalyticsWorkRequest={sourceId,ownerDigest:historyOwner.ownerDigest,stage:'fits',lane:'history',
  partitionKey:'rolling-window/'+historyWindow.window_key,
  headKey:await sha256Hex(canonicalJson(['rolling-window',sourceId,historyWindow.window_key])),
  inputRevision:historyWindow.native_dependency,policyRevision:oldPolicy,day:null,stream:null,
  selectionMethod:'legacy-selected-v1',residentBytes:8*1024*1024,admissionQueries:600};
 const oldKey=await analyticsWorkKey(request),newKey=await analyticsWorkKey({...request,policyRevision:newPolicy,admissionQueries:300});
 try {
  await invocation(episode,'actual_v1_policy_admission',async db=>{
   expect(await admitAnalyticsPartitionWork(db.target,[request],nowMs)).toEqual([oldKey]);
  });
  let ready=false;
  for(let call=0;call<4&&!ready;call++){
   const result=await invocation(episode,'native_complete_window_'+call,db=>executeCanonicalV1WindowRequest({...db,
    sourceId,sourceNamespace:sourceId,ownerDigest:historyOwner.ownerDigest,participantId:historyOwner.participantId,
    windowKey:historyWindow.window_key,maxQueries:600,deadlineMs:Date.now()+60_000,now:Date.now}));
   expect(result.state).not.toBe('refused');ready=result.state==='complete';
  }
  expect(ready).toBe(true);
  const phase=createD1InvocationBudget(180);
  const progress=await invocation(episode,'durable_successor_for_complete_window',db=>runCanonicalAnalyticsWorkPass({...db,sourceId,sourceNamespace:sourceId,
   source:phase.wrap(db.source),target:phase.wrap(db.target),invocation:phase,now:()=>nowMs,
   deadlineMs:nowMs+60_000,degree:1,maxWaves:1,stages:['fits'],bridge:false}));
  expect(progress.state).not.toBe('unavailable');expect(phase.queriesUsed).toBeLessThanOrEqual(180);
  await invocation(episode,'legacy_retirement_after_v2_receipt',async db=>{
   expect(await db.target.prepare('SELECT state FROM analytics_partition_work WHERE work_key=?')
    .bind(oldKey).first<string>('state')).toBe('refused');
   expect(await db.target.prepare('SELECT count(*) n FROM analytics_partition_work WHERE work_key=?')
    .bind(newKey).first<number>('n')).toBe(1);
   expect(await db.target.prepare('SELECT state FROM analytics_canonical_rolling_windows WHERE window_key=?')
    .bind(historyWindow.window_key).first<string>('state')).toBe('complete');
  });
  const [lease]=await invocation(episode,'current_complete_successor_claim',db=>claimAnalyticsPartitionWork(db.target,
   {sourceId,limit:1,nowMs:nowMs+1,stages:['fits'],maxAdmissionQueries:300}));
  expect(lease?.workKey).toBe(newKey);
  const reused=await invocation(episode,'native_complete_window_reuse',db=>executeCanonicalV1WindowRequest({...db,
   sourceId,sourceNamespace:sourceId,ownerDigest:historyOwner.ownerDigest,participantId:historyOwner.participantId,
   windowKey:historyWindow.window_key,maxQueries:300,deadlineMs:Date.now()+60_000,now:Date.now}));
  expect(reused.state).toBe('complete');
  expect(await invocation(episode,'native_successor_completion',db=>completeAnalyticsPartitionWork(db.target,lease!,[],nowMs+2))).toBe(true);
  await invocation(episode,'native_same_device_source_change',async db=>{
   const day=corpus.historyDates[0]!,projected=telemetryV11LegacyProjection('usage',v11UsageRecord(day,'a',{
    eventId:'event:v2:'+await sha256Hex('synthetic-skew-history-source-change')}));
   expect(projected).not.toBeNull();const records=[JSON.parse(projected!.canonicalRecord)];
   const chunk=parseTelemetryV1Chunk({schemaVersion:'telemetry-contribution-v1.0',chunkId:'usage:'+day+':1',
    chunkRevision:1,chunkDigest:await sha256Hex(canonicalJson(records)),parserVersion:'synthetic-skew-history-update',
    consent:{telemetrySchemaVersion:'telemetry-contribution-v1.0',fieldDictionaryVersion:'telemetry-v1.0-registry-2026-08-07.1',
     privacyContractVersion:'ongoing-privacy-safe-telemetry-v1.0'},records});
   const envelopeDigest=await sha256Hex('synthetic-skew-history-source-change-upload');
   const principal=await authenticateDevice(db.source,historyDevice.authorization);
   const authorization=await createDeviceUploadAuthorization(db.source,principal,envelopeDigest,4096);
   const claim=await claimDeviceUploadAuthorization(db.source,'Upload '+authorization.uploadAuthorization,
    {envelopeDigest,bodyBytes:4096,contentType:'application/json'});
   await insertTypedTelemetryV1Chunk(db.source,{chunkRowId:'chunk:skew-history:source-change',
    participantId:historyDevice.participantId,deviceId:historyDevice.deviceId,chunk,envelopeDigest,
    deviceUploadAuthorizationId:claim.authorizationId,r2Key:'synthetic/skew-history/source-change',
    createdAt:new Date().toISOString(),supersedes:null},sourceId);
   expect(await db.source.prepare(`SELECT count(*) n FROM typed_telemetry_records r JOIN typed_v1_owner_memberships m
    ON m.typed_owner_id=r.owner_id WHERE m.participant_id=? AND r.format=10 AND r.stream=1`)
    .bind(historyOwner.participantId).first<number>('n')).toBe(10);
  });
  await invocation(episode,'changed_source_refuses_old_complete_result',async db=>{
   const pin=await loadV1SourcePin(db.source,{participantId:historyOwner.participantId,
    fromDay:corpus.historyDates[0]!,throughDay:corpus.historyDates[8]!});
   expect(pin.fingerprint).not.toBe(historyWindow.native_dependency);
   const result=await executeCanonicalV1WindowRequest({...db,sourceId,sourceNamespace:sourceId,
    ownerDigest:historyOwner.ownerDigest,participantId:historyOwner.participantId,windowKey:historyWindow.window_key,
    maxQueries:300,deadlineMs:Date.now()+60_000,now:Date.now});
   expect(result).toMatchObject({state:'refused',reason:'source_changed'});
  });
 } finally {
  Object.assign(task.meta,{rollingPolicyCompleteReuse:{imported,resources:aggregate(episode),
   contract:'Genuine retained v1 writer, durable v2 admission before old due-row retirement, complete-window native readback, then additive accepted source change. No raw credentials or rows retained.'}});
 }
},120_000);

async function assertPopulation(episode:Episode) {
 return invocation(episode,'capacity_and_lineage_proof',async db=>{
  const actual=(await db.target.prepare(`SELECT source_id,stage,state,count(*) jobs FROM analytics_partition_work GROUP BY source_id,stage,state ORDER BY source_id,stage,state`).all()).results;
  const counted=(await db.target.prepare(`SELECT source_id,stage,state,jobs FROM analytics_partition_work_counts WHERE jobs>0 ORDER BY source_id,stage,state`).all()).results;
  expect(counted).toEqual(actual);
  const pending=await db.target.prepare("SELECT COALESCE(sum(jobs),0) n FROM analytics_partition_work_counts WHERE state IN('ready','leased')").first<number>('n');
  expect(pending).toBeLessThanOrEqual(65536);
  expect(await db.target.prepare(`SELECT count(*) n FROM analytics_partition_work WHERE resident_bytes>33554432`).first<number>('n')).toBe(0);
  expect((await db.target.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  expect(await db.target.prepare(`SELECT count(*) n FROM analytics_partition_work_links l LEFT JOIN analytics_partition_work p ON p.work_key=l.parent_work_key
   LEFT JOIN analytics_partition_work c ON c.work_key=l.child_work_key WHERE p.work_key IS NULL OR c.work_key IS NULL`).first<number>('n')).toBe(0);
  return {pending,maintainedCountersExact:true,foreignKeysExact:true,declaredMaximumResidentBytes:32*1024*1024,observedPeakHeapBytes:null};
 });
}
async function scopeJobs(episode:Episode,scope:CanonicalInputScope,state:'ready'|'complete') {
 // Manifest jobs deliberately have owner_digest=NULL; actual subject metadata
 // is populated by the original native manifest admission trigger.
 return invocation(episode,'original_cache_population_proof',db=>db.target.prepare(`SELECT count(*) n FROM analytics_partition_work w
  WHERE w.source_id=? AND w.day=? AND w.stream='usage' AND w.stage='cache' AND w.state=?
  AND EXISTS(SELECT 1 FROM analytics_partition_work_subjects s WHERE s.work_key=w.work_key AND s.source_id=w.source_id AND s.owner_digest=?)`)
  .bind(sourceId,scope.day,state,scope.ownerDigest).first<number>('n'));
}
const completed=(episode:Episode,scope:CanonicalInputScope)=>scopeJobs(episode,scope,'complete');

async function exactCurrentProducts(episode:Episode,scope:CanonicalInputScope) {
 const values=await currentFacts(episode,scope),expected=await Promise.all(values.facts.map(prepareCanonicalFeatureContribution));
 const quantities=await invocation(episode,'exact_quantities_proof',async db=>(await db.target.prepare(`SELECT q.payload FROM analytics_canonical_feature_quantities q
  JOIN analytics_canonical_facts f ON f.revision=q.fact_revision JOIN analytics_canonical_heads h ON h.revision=f.revision
  WHERE f.owner_digest=? AND f.source_id=? AND f.stream='usage' AND f.observed_day=? ORDER BY f.revision`).bind(scope.ownerDigest,sourceId,scope.day).all<{payload:string}>()).results.map(row=>JSON.parse(row.payload)));
 expect(quantities).toEqual([...expected].sort((a,z)=>a.factRevision.localeCompare(z.factRevision)));
 return {facts:values.facts.length,hash:await sha256Hex(canonicalJson(values.facts))};
}

it('measures genuine retained rolling-window continuation at separate child query budgets',async({task})=>{
 const budgets=[300,400,500,600,900] as const,days=corpus.historyDates.slice(0,9);
 expect(days).toHaveLength(9);expect(historyWindow.member_count).toBe(18);
 const from=days[0]!+'T00:00:00.000Z',through=new Date(Date.parse(days[8]!+'T00:00:00.000Z')+dayMs).toISOString();
 type Checkpoint={day:string;stream:string;inputState:string|null;pageOrdinal:number|null;seenCount:number|null;
  segmentState:string|null;segmentRows:number|null;cursorMs:number|null;cursorOrder:number|null;member:boolean};
 type Snapshot={state:string;members:number;checkpoints:Checkpoint[];memberKeys:string[];memberContentHash:string};
 const observations:unknown[]=[];let completeReaderHash:string|null=null;
 try {
 for(const budget of budgets){
  const copy=await restore(),episode=emptyEpisode();
  const steps:unknown[]=[];
  const trial:{childBudget:number;copy:typeof copy;initialMembers:number|null;steps:unknown[];completed:boolean;
   completedReaderHash:string|null;executionCosts:unknown[];diagnosticCosts:unknown[]}={childBudget:budget,copy,
    initialMembers:null,steps,completed:false,completedReaderHash:null,executionCosts:[],diagnosticCosts:[]};
  observations.push(trial);
  try {
  const snapshot=async(label:string):Promise<Snapshot>=>invocation(episode,label,async db=>{
   const window=await db.target.prepare(`SELECT state,member_count,native_dependency FROM analytics_canonical_rolling_windows
    WHERE window_key=? AND source_id=? AND owner_digest=?`).bind(historyWindow.window_key,sourceId,historyOwner.ownerDigest)
    .first<{state:string;member_count:number;native_dependency:string}>();
   expect(window).toMatchObject({member_count:18,native_dependency:historyWindow.native_dependency});
   expect(window?.state==='building'||window?.state==='complete').toBe(true);
   const inputs=(await db.target.prepare(`SELECT source_day day,stream,state,page_ordinal,seen_count,source_stamp
    FROM analytics_canonical_input_work WHERE source_id=? AND owner_digest=? AND selection_method='legacy-selected-v1'
    AND source_day BETWEEN ? AND ? ORDER BY source_day,stream`)
    .bind(sourceId,historyOwner.ownerDigest,days[0],days[8]).all<{day:string;stream:string;state:string;page_ordinal:number;seen_count:number;source_stamp:string}>()).results;
   const segments=(await db.target.prepare(`SELECT day,stream,state,row_count,cursor_ms,cursor_order,source_stamp
    FROM analytics_canonical_rolling_segments WHERE source_id=? AND owner_digest=? AND selection_method='legacy-selected-v1'
    AND day BETWEEN ? AND ? ORDER BY day,stream`)
    .bind(sourceId,historyOwner.ownerDigest,days[0],days[8]).all<{day:string;stream:string;state:string;row_count:number;cursor_ms:number;cursor_order:number;source_stamp:string}>()).results;
   const members=(await db.target.prepare(`SELECT m.segment_key,s.day,s.stream,s.state,s.row_count,s.source_stamp FROM analytics_canonical_rolling_members m
    JOIN analytics_canonical_rolling_segments s USING(segment_key) WHERE m.window_key=? ORDER BY s.day,s.stream`)
    .bind(historyWindow.window_key).all<{segment_key:string;day:string;stream:string;state:string;row_count:number;source_stamp:string}>()).results;
   const inputByScope=new Map(inputs.map(row=>[row.day+'/'+row.stream,row])),segmentByScope=new Map(segments.map(row=>[row.day+'/'+row.stream,row]));
   const expected=days.flatMap(day=>['quota','usage'].map(stream=>day+'/'+stream));
   expect(new Set(expected).size).toBe(18);expect(inputs.length).toBeLessThanOrEqual(18);expect(segments.length).toBeLessThanOrEqual(18);
   expect(members.length).toBeLessThanOrEqual(18);expect(new Set(members.map(row=>row.day+'/'+row.stream)).size).toBe(members.length);
   for(const row of members){const key=row.day+'/'+row.stream;expect(expected).toContain(key);expect(row.state).toBe('complete');
    expect(inputByScope.get(key)?.state).toBe('sealed');expect(inputByScope.get(key)?.source_stamp).toBe(row.source_stamp);}
   const memberKeys=members.map(row=>row.day+'/'+row.stream);
   const checkpoints=days.flatMap(day=>['quota','usage'].map(stream=>{const key=day+'/'+stream,input=inputByScope.get(key),segment=segmentByScope.get(key);
    if(segment)expect(input?.source_stamp).toBe(segment.source_stamp);
    return {day,stream,inputState:input?.state??null,pageOrdinal:input?.page_ordinal??null,seenCount:input?.seen_count??null,
     segmentState:segment?.state??null,segmentRows:segment?.row_count??null,cursorMs:segment?.cursor_ms??null,cursorOrder:segment?.cursor_order??null,
     member:memberKeys.includes(key)} satisfies Checkpoint;}));
   return {state:window!.state,members:members.length,checkpoints,memberKeys,memberContentHash:await sha256Hex(canonicalJson(members))};
  });
  const proveCurrent=async(label:string)=>invocation(episode,label,async db=>{
   const pin=await loadV1SourcePin(db.source,{participantId:historyOwner.participantId,fromDay:days[0]!,throughDay:days[8]!});
   expect(pin.winners).toHaveLength(9);expect(pin.winners.map(row=>row.observed_day)).toEqual(days);
   expect(pin.fingerprint).toBe(historyWindow.native_dependency);await assertV1SourcePinCurrent(db.source,pin);
   const owner=(await readStorageCommunityOwnerPage(db.source)).find(value=>value.participantId===historyOwner.participantId);
   expect(owner?.ownerDigest).toBe(historyOwner.ownerDigest);expect(owner?.hasV1).toBe(true);expect(owner?.hasV11).toBe(false);
   const state=await db.target.prepare(`SELECT revision,authority_epoch,state FROM analytics_owner_state WHERE source_id=? AND owner_digest=?`)
    .bind(sourceId,historyOwner.ownerDigest).first<{revision:number;authority_epoch:number;state:string}>();
   expect(state).toMatchObject({revision:owner!.ownerRevision,authority_epoch:owner!.authorityEpoch,state:'active'});
   expect(await db.target.prepare(`SELECT 1 FROM analytics_storage_erasure_fences WHERE source_id=? AND owner_digest=?`)
    .bind(sourceId,historyOwner.ownerDigest).first()).toBeNull();
  });
  let previous=await snapshot('rolling_checkpoint_initial');trial.initialMembers=previous.members;expect(previous.members).toBe(6);
  await proveCurrent('rolling_source_current_initial');
  for(let call=1;call<=4;call++){
   const result=await invocation(episode,'rolling_execute_'+call,db=>executeCanonicalV1WindowRequest({...db,
    sourceId,sourceNamespace:sourceId,ownerDigest:historyOwner.ownerDigest,participantId:historyOwner.participantId,
    windowKey:historyWindow.window_key,maxQueries:budget,deadlineMs:Date.now()+60_000,now:Date.now}));
   const execution=episode.costs.at(-1)!;
   expect(result.queriesUsed).toBe(execution.statements);expect(result.queriesUsed).toBeLessThanOrEqual(budget);
   expect(result.state==='deferred'||result.state==='complete').toBe(true);
   const next=await snapshot('rolling_checkpoint_'+call);await proveCurrent('rolling_source_current_'+call);
   expect(next.members).toBeGreaterThanOrEqual(previous.members);
   expect(next.memberKeys).toEqual([...new Set(next.memberKeys)]);
   for(const key of previous.memberKeys)expect(next.memberKeys).toContain(key);
   const changes=next.checkpoints.flatMap((scope,index)=>JSON.stringify(scope)===JSON.stringify(previous.checkpoints[index])?[]:[{
    dayIndex:days.indexOf(scope.day),stream:scope.stream,inputState:scope.inputState,pageOrdinal:scope.pageOrdinal,
    seenCount:scope.seenCount,segmentState:scope.segmentState,segmentRows:scope.segmentRows,
    cursorMs:scope.cursorMs,cursorOrder:scope.cursorOrder,member:scope.member}]);
   steps.push({call,childBudget:budget,childQueries:result.queriesUsed,outerQueries:execution.statements,
    state:result.state,...(result.reason?{reason:result.reason}:{}),membersBefore:previous.members,membersAfter:next.members,
    changes,rowsRead:execution.rowsRead,rowsWritten:execution.rowsWritten});
   if(result.state==='complete'){
    expect(next.state).toBe('complete');expect(next.members).toBe(18);expect(next.memberKeys).toEqual(days.flatMap(day=>['quota','usage'].map(stream=>day+'/'+stream)));
    const readerHash=await invocation(episode,'rolling_completed_reader_proof',async db=>{
     const reader=await createCanonicalV1RollingReader(db.target,historyWindow.window_key,historyWindow.native_dependency,async()=>{
      const pin=await loadV1SourcePin(db.source,{participantId:historyOwner.participantId,fromDay:days[0]!,throughDay:days[8]!});
      return pin.fingerprint===historyWindow.native_dependency;});
     const usage=await reader.usageReader.readPage(from,0,128,through),quota=await reader.quotaReader.readPlanPage({observedAt:from,id:0},128);
     const bins=await reader.usageBins.readPage(from,0,128);await reader.assertCurrent();
     expect(usage).toHaveLength(9);expect(bins).toHaveLength(9);expect(quota).toEqual([]);
     expect(usage.map(row=>row.observed_at.slice(0,10))).toEqual(days);
     return sha256Hex(canonicalJson({usage,quota,bins,memberContentHash:next.memberContentHash}));
    });
    if(completeReaderHash!==null)expect(readerHash).toBe(completeReaderHash);else completeReaderHash=readerHash;
    trial.completed=true;trial.completedReaderHash=completeReaderHash;break;
   }
   previous=next;
  }
  } finally {
   trial.executionCosts=episode.costs.filter(cost=>cost.label.startsWith('rolling_execute_'))
    .map(({label,statements,rowsRead,rowsWritten})=>({label,statements,rowsRead,rowsWritten}));
   trial.diagnosticCosts=episode.costs.filter(cost=>!cost.label.startsWith('rolling_execute_'))
    .map(({label,statements,rowsRead,rowsWritten})=>({label,statements,rowsRead,rowsWritten}));
  }
 }
 } finally {
 Object.assign(task.meta,{retainedRollingBudgetMeasurement:{contract:'Genuine accepted v1 history, identical restored source and target per trial; copy and probes excluded from execution budgets.',
  expectedMembers:18,requestedBudgets:budgets,observations,completeReaderHash,
  limitation:'This is a local bounded continuation measurement, not an admission-floor change or role fairness qualification.'}});
 }
},120_000);

it('gives genuine fresh sparse and retained older-than101-day work bounded turns while accepted hot cache work remains pending',async({task})=>{
 const imported=await restore(),episode=emptyEpisode(),turns=[];let sparseAt:number|null=null,oldAt:number|null=null,historyAt:number|null=null,historyFirstClaim:number|null=null,analyticsTurns=0;
 const retainedTargetProbes:unknown[]=[];
 episode.trace=newScopeTrace();
 try {
 await scopeDiagnostic(episode,'startup',true);
 expect(await completed(episode,sparseScope)).toBe(0);expect(await completed(episode,oldScope)).toBe(0);
 const originalHot=await scopeJobs(episode,hotScope,'ready');expect(originalHot).toBeGreaterThan(8);
 for(let turn=0;turn<ceiling.roles;turn++){
  const role=turn%4===3?'analytics':'cache';if(role==='analytics')analyticsTurns++;
  turns.push(await scheduled(episode,role));
  await scopeDiagnostic(episode,'role_'+(turn+1));
  if(turn===15||turn===16)retainedTargetProbes.push(await retainedTargetProbe(episode,episode.trace!,'role_'+(turn+1)));
  if(historyFirstClaim===null&&episode.claims.some(claim=>claim.owner_digest===historyOwner.ownerDigest&&claim.stage==='fits'&&claim.lane==='history'
   &&claim.partition_key==='rolling-window/'+historyWindow.window_key&&claim.day===null))historyFirstClaim=analyticsTurns;
  if(historyAt===null&&await invocation(episode,'native_history_job_progress_proof',db=>db.target.prepare(`SELECT count(*) n FROM analytics_partition_work
   WHERE owner_digest=? AND partition_key=? AND stage='fits' AND lane='history' AND state='complete'`).bind(historyOwner.ownerDigest,'rolling-window/'+historyWindow.window_key).first<number>('n')))historyAt=turn+1;
  if(sparseAt===null&&await completed(episode,sparseScope))sparseAt=turn+1;
  if(oldAt===null&&await completed(episode,oldScope))oldAt=turn+1;
  if(sparseAt!==null&&oldAt!==null&&historyAt!==null)break;
 }
 Object.assign(task.meta,{skewFairnessReceipt:{laboratorySetup,imported,turns,sparseAt,oldAt,historyAt,historyFirstClaim,analyticsTurns,
  retainedTargetProbes,resources:aggregate(episode)}});
 expect(sparseAt).not.toBeNull();expect(sparseAt!).toBeLessThanOrEqual(ceiling.sparseProgress);
 expect(oldAt).not.toBeNull();expect(oldAt!).toBeLessThanOrEqual(ceiling.oldProgress);
 expect(historyFirstClaim).not.toBeNull();expect(historyFirstClaim!).toBeLessThanOrEqual(6);expect(historyAt).not.toBeNull();
 await invocation(episode,'exact_native_history_window_completion',async db=>{
  expect(await db.target.prepare('SELECT native_dependency,member_count,state FROM analytics_canonical_rolling_windows WHERE window_key=?')
   .bind(historyWindow.window_key).first()).toEqual({native_dependency:historyWindow.native_dependency,member_count:18,state:'complete'});
  expect(await db.target.prepare('SELECT count(*) n FROM analytics_canonical_rolling_members WHERE window_key=?').bind(historyWindow.window_key).first<number>('n')).toBe(18);
 });
 await invocation(episode,'exact_claimed_subject_proof',async db=>{
  for(const scope of [sparseScope,oldScope])expect(await db.target.prepare(`SELECT count(*) n FROM analytics_partition_work_subjects s
   JOIN analytics_partition_work w USING(work_key) WHERE s.source_id=? AND s.owner_digest=? AND w.day=? AND w.stage='cache'
   AND s.work_key IN(SELECT value FROM json_each(?))`).bind(sourceId,scope.ownerDigest,scope.day,JSON.stringify(episode.claims.map(c=>c.work_key))).first<number>('n')).toBeGreaterThan(0);
 });
 expect(episode.claims.every(c=>c.resident_bytes<=32*1024*1024&&c.claim_token&&c.claim_expires_ms>0)).toBe(true);
 const exact={sparse:await exactCurrentProducts(episode,sparseScope),retained:await exactCurrentProducts(episode,oldScope)};
 const population=await assertPopulation(episode);
 Object.assign(task.meta,{skewFairnessReceipt:{laboratorySetup,imported,turns,sparseAt,oldAt,historyAt,historyFirstClaim,analyticsTurns,exact,population,resources:aggregate(episode),
  qualification:'Actual analytics/cache schedules, native retained/new inputs and original fits/history request. Full backlog drain and full-store capacity qualification are not inferred.'}});
 } finally {
  const nativeState=await nativePopulations(episode,'role_final_native_shape').catch(()=>({diagnosticUnavailable:true}));
  await scopeDiagnostic(episode,'final',true);
  retainedTargetProbes.push(await retainedTargetProbe(episode,episode.trace!,'final'));
  Object.assign(task.meta,{skewFairnessReceipt:{...(task.meta as Record<string,unknown>).skewFairnessReceipt as Record<string,unknown>,laboratorySetup,imported,turns,
   sparseAt,oldAt,historyAt,historyFirstClaim,analyticsTurns,nativeState,retainedTargetProbes,resources:aggregate(episode),
   nativeScopeTrace:{events:episode.trace!.events,snapshots:episode.trace!.snapshots,contract:'Read-only synthetic labels/ordinals; no raw keys, payloads or job mutations. Role admitted counters are observed; per-leaf admission is not inferred. Diagnostic probes are separate actual950 invocations.'}}});
 }
},120_000);

it('handles genuine withdrawal and physical erasure during a retained hot backlog and preserves unrelated original progress',async({task})=>{
 const imported=await restore(),episode=emptyEpisode(),survivorBefore=await currentFacts(episode,oldScope);
 const retainedProbeTrace=newScopeTrace();
 const terminalProgress:unknown[]=[],terminalRoleEffects:unknown[]=[];
 let initialComponents:RetainedTokenComponents|undefined;
 const probe=async(label:string)=>{
  const observed=await retainedTerminalProgressDiagnostic(episode,label,initialComponents);
  if(label==='before_withdrawal'&&observed.report.componentReconstructsToken===true)
   initialComponents=observed.components;
  terminalProgress.push(observed.report);
 };
 try {
 const initialHot=await scopeJobs(episode,hotScope,'ready');expect(initialHot).toBeGreaterThan(8);
 await probe('before_withdrawal');
 expect(await invocation(episode,'native_withdrawal',db=>revokeAccountlessEnrollment(db.source,corpus.secondaryAccountless!.enrollmentDeviceId,'security_reset',Date.now()))).toBe(true);
 const withdrawal=await invocation(episode,'immediate_withdrawal_proof',async db=>{
  const owners=await readStorageCommunityOwnerPage(db.source);expect(owners.some(owner=>owner.ownerDigest===withdrawScope.ownerDigest)).toBe(false);
  expect(await db.source.prepare('SELECT state FROM storage_owner_revisions WHERE owner_digest=?').bind(withdrawScope.ownerDigest).first<string>('state')).toBe('withdrawn');
  expect(await readCanonicalInputSeal(db.source,db.target,withdrawScope)).toBeNull();
  expect(await db.source.prepare("SELECT count(*) n FROM storage_ingestion_changes WHERE owner_digest=? AND kind='owner-withdrawn'")
   .bind(withdrawScope.ownerDigest).first<number>('n')).toBe(1);
  expect(await db.source.prepare(`SELECT count(*) n FROM telemetry_v12_records r JOIN telemetry_v12_day_manifests m ON m.id=r.manifest_id
   WHERE m.participant_id=?`).bind(withdrawScope.participantId).first<number>('n')).toBeGreaterThan(0);
  return {sourceTerminal:true,historyRetained:true,nativeSealRefused:true};
 });
 await probe('after_withdrawal');
 // Target may still have the old active owner until ordered delivery. Its stale
 // cache descendants must not complete by substituting target-only authority.
 const staleCompleted=await completed(episode,withdrawScope);await scheduled(episode,'cache');expect(await completed(episode,withdrawScope)).toBe(staleCompleted);
 const deliveryTurns=await delivery(episode,ceiling.terminalDelivery);
 await probe('after_withdrawal_delivery');
 await invocation(episode,'target_withdrawal_proof',async db=>{
  expect(await db.target.prepare('SELECT state FROM analytics_owner_state WHERE source_id=? AND owner_digest=?').bind(sourceId,withdrawScope.ownerDigest).first<string>('state')).toBe('withdrawn');
  expect(await db.target.prepare('SELECT count(*) n FROM analytics_canonical_facts WHERE owner_digest=?').bind(withdrawScope.ownerDigest).first<number>('n')).toBe(0);
 });
 let requestDeferred=false;
 try {await invocation(episode,'native_owner_erasure',async db=>eraseParticipantAsOwner({...b,USAGE_MONITOR_DB:db.source,DELETION_LEDGER:db.ledger,
  ANALYTICS_DB:db.target,STORAGE_INGESTION_DB:db.source,STORAGE_ANALYTICS_DB:db.target,TELEMETRY_STORAGE_NAMESPACE:sourceId,
  TELEMETRY_STORAGE_MODE:'typed',ENVIRONMENT:'synthetic-development'} as unknown as Env,'synthetic-skew-owner',sparseScope.participantId));}
 catch(error){if(!error||typeof error!=='object'||Reflect.get(error,'code')!=='BACKEND_STORAGE_UNAVAILABLE')throw error;requestDeferred=true;}
 expect(await invocation(episode,'immediate_erasure_ledger_proof',db=>hasDeletionTombstone(db.ledger,sparseScope.participantId))).toBe(true);
 let erasurePages=0,physicalComplete=false;
 for(;erasurePages<ceiling.erasurePages;erasurePages++){
  const result=await invocation(episode,'native_physical_erasure_page',db=>advanceStorageErasureJobs({...db,sourceId,sourceNamespace:sourceId},{maxJobs:1}));
  if(!result.pending){physicalComplete=true;erasurePages++;break;}
 }
 Object.assign(task.meta,{skewTerminalReceipt:{laboratorySetup,imported,withdrawal,deliveryTurns,requestDeferred,erasurePages,physicalComplete,resources:aggregate(episode)}});
 expect(physicalComplete).toBe(true);
 await probe('after_physical_erasure');
 await invocation(episode,'native_erasure_completion_proof',async db=>{
  await requireStorageParticipantErasureComplete(db.ledger,sparseScope.participantId,{...db,sourceId,sourceNamespace:sourceId});
  expect(await db.source.prepare('SELECT count(*) n FROM participants WHERE id=?').bind(sparseScope.participantId).first<number>('n')).toBe(0);
  expect(await db.source.prepare('SELECT state FROM storage_owner_revisions WHERE owner_digest=?').bind(sparseScope.ownerDigest).first<string>('state')).toBe('erased');
  expect((await readStorageCommunityOwnerPage(db.source)).some(owner=>owner.ownerDigest===sparseScope.ownerDigest)).toBe(false);
  expect(await db.source.prepare("SELECT count(*) n FROM storage_ingestion_changes WHERE owner_digest=? AND kind='owner-erased'")
   .bind(sparseScope.ownerDigest).first<number>('n')).toBe(1);
  // Physical deletion and its ledger receipt do not advance the ordered inbox.
  expect(await db.target.prepare("SELECT count(*) n FROM analytics_applied_events WHERE source_id=? AND owner_digest=? AND kind='owner-erased'")
   .bind(sourceId,sparseScope.ownerDigest).first<number>('n')).toBe(0);
  const inventory=await readMaintainedAnalyticsErasureInventory(db.target);
  for(const table of inventory.ownerTables)expect(await db.target.prepare(`SELECT count(*) n FROM ${table} WHERE source_id=? AND owner_digest=?`)
   .bind(sourceId,sparseScope.ownerDigest).first<number>('n'),table).toBe(0);
  expect(await readCanonicalInputSeal(db.source,db.target,sparseScope)).toBeNull();
 });
 const erasureDeliveryTurns=await delivery(episode,ceiling.terminalDelivery);
 await probe('after_erasure_delivery');
 const retainedInputAfterTerminalDelivery=await retainedTerminalInputDiagnostic(episode,'after_delivery');
 await invocation(episode,'target_ordered_erasure_proof',async db=>{
  expect(await db.target.prepare('SELECT state FROM analytics_owner_state WHERE source_id=? AND owner_digest=?')
   .bind(sourceId,sparseScope.ownerDigest).first<string>('state')).toBe('erased');
  const columns='sequence,event_digest,owner_digest,revision,kind,object_digest,content_digest,authority_epoch,public_authority_epoch,recorded_ms';
  const native=await db.source.prepare(`SELECT ${columns} FROM storage_ingestion_changes WHERE owner_digest=? AND kind='owner-erased'`)
   .bind(sparseScope.ownerDigest).first<{sequence:number}>();
  expect(native).not.toBeNull();expect(Number.isSafeInteger(native!.sequence)&&native!.sequence>0).toBe(true);
  expect(await db.target.prepare(`SELECT ${columns} FROM analytics_applied_events WHERE source_id=? AND sequence=?`)
   .bind(sourceId,native!.sequence).first()).toEqual(native);
  expect(await db.target.prepare("SELECT count(*) n FROM analytics_applied_events WHERE source_id=? AND owner_digest=? AND kind='owner-erased'")
   .bind(sourceId,sparseScope.ownerDigest).first<number>('n')).toBe(1);
 });
 Object.assign(task.meta,{skewTerminalReceipt:{...(task.meta as Record<string,unknown>).skewTerminalReceipt as Record<string,unknown>,
  erasureDeliveryTurns,retainedInputAfterTerminalDelivery}});
 let progressAt:number|null=null;const turns=[];
 for(let turn=0;turn<ceiling.oldProgress;turn++){
  const role=turn%4===3?'analytics':'cache',scheduledTurn=await scheduled(episode,role,true);
  turns.push(scheduledTurn);
  terminalRoleEffects.push({turn:turn+1,role,queries:scheduledTurn.queries,effects:scheduledTurn.effects});
  if(turn===3||turn===7||turn===15)await probe('role_'+(turn+1));
  if(await completed(episode,oldScope)){progressAt=turn+1;break;}
 }
 expect(progressAt).not.toBeNull();const survivorAfter=await currentFacts(episode,oldScope);
 const priorSeal=survivorBefore.seal,nextSeal=survivorAfter.seal;
 const survivorComparison={
  sealFieldsEqual:{scopeKey:priorSeal.scopeKey===nextSeal.scopeKey,sourceStamp:priorSeal.sourceStamp===nextSeal.sourceStamp,
   ownerRevision:priorSeal.ownerRevision===nextSeal.ownerRevision,authorityEpoch:priorSeal.authorityEpoch===nextSeal.authorityEpoch,
   day:priorSeal.day===nextSeal.day,stream:priorSeal.stream===nextSeal.stream,
   seenCount:priorSeal.seenCount===nextSeal.seenCount,empty:priorSeal.empty===nextSeal.empty},
  factsEqual:canonicalJson(survivorBefore.facts)===canonicalJson(survivorAfter.facts),
  factCounts:{before:survivorBefore.facts.length,after:survivorAfter.facts.length},
  revisionRefsEqual:canonicalJson(survivorBefore.facts.map(fact=>fact.revision))===canonicalJson(survivorAfter.facts.map(fact=>fact.revision)),
 };
 Object.assign(task.meta,{skewTerminalReceipt:{...(task.meta as Record<string,unknown>).skewTerminalReceipt as Record<string,unknown>,survivorComparison}});
 expect(survivorAfter).toEqual(survivorBefore);
 expect(await invocation(episode,'terminal_global_closure_proof',db=>readAnalyticsWorkClosureFence({...db,sourceId,sourceNamespace:sourceId}))).toBeNull();
 const exact=await exactCurrentProducts(episode,oldScope),population=await assertPopulation(episode);
 Object.assign(task.meta,{skewTerminalReceipt:{laboratorySetup,imported,withdrawal,deliveryTurns,erasureDeliveryTurns,requestDeferred,erasurePages,physicalComplete,turns,progressAt,
  exact,population,survivorComparison,resources:aggregate(episode),qualification:'Native withdrawal/owner erasure plus original unrelated progress; no public closure or complete full-store capacity claim.'}});
 } finally {
  const nativeState=await nativePopulations(episode,'terminal_final_native_shape').catch(()=>({diagnosticUnavailable:true}));
 const retainedTargetProbeFinal=await retainedTargetProbe(episode,retainedProbeTrace,'terminal_final');
  const retainedInputFinal=await retainedTerminalInputDiagnostic(episode,'final');
  Object.assign(task.meta,{skewTerminalReceipt:{...(task.meta as Record<string,unknown>).skewTerminalReceipt as Record<string,unknown>,laboratorySetup,imported,
   nativeState,retainedTargetProbeFinal,retainedInputFinal,terminalProgress,terminalRoleEffects,resources:aggregate(episode)}});
 }
},120_000);

});
