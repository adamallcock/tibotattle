/** A concrete metadata proof that all admitted input changes have reached the
 * canonical/feature work inventory. Output-family closure remains separate. */
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { readEffectiveDependencySourceFence } from './storage-effective-selective-dependencies';
import { analyticsPartitionWorkAvailable } from './storage-analytics-partition-work';
import { captureStorageCommunityAuthority, sameStorageCommunityAuthority,
  type StorageCommunityAuthority } from './storage-community-authority';

export interface AnalyticsWorkClosureFence {
  readonly schema:'analytics-work-closure-fence-v1';
  readonly sourceId:string;readonly sourceNamespace:string;
  readonly acceptedSequence:number;readonly mutationGeneration:number;
  /** Global conservative clock boundary; exact membership is P7's native census. */
  readonly clockPhase:number;readonly validUntilMs:number;
  readonly authority:StorageCommunityAuthority;readonly proofDigest:string;
}
interface Input {source:D1Database;target:D1Database;sourceId:string;sourceNamespace:string}
type TargetInput=Pick<Input,'target'|'sourceId'|'sourceNamespace'>;
/** This maintained count can reject work cheaply. Absence is only a hint;
 * every positive path still checks the complete target inventory and source. */
async function producersPending(input:TargetInput):Promise<boolean> {
 return await input.target.prepare(`SELECT 1 pending FROM analytics_partition_work_counts
  WHERE source_id=? AND stage IN('canonical','features') AND state IN('ready','leased')
  AND jobs>0 LIMIT 1`).bind(input.sourceId).first<number>('pending')===1;
}
const SOURCE_READY=`SELECT sequence,policy_stamp,acknowledged_policy_stamp,
  (SELECT complete FROM storage_effective_selective_bootstrap WHERE id=1) AS bootstrapped,
  EXISTS(SELECT 1 FROM storage_effective_selective_owners WHERE needs_work=1 OR seeded=0) AS owner_pending,
  EXISTS(SELECT 1 FROM storage_effective_selective_work) AS work_pending,
  EXISTS(SELECT 1 FROM storage_effective_selective_reverse_work) AS reverse_pending,
  EXISTS(SELECT 1 FROM storage_effective_selective_effects) AS effect_pending,
  (SELECT count(*) FROM accountless_v12_device_authorizations WHERE state='active'
    AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS clock_phase,
  (SELECT min(expires_at) FROM accountless_v12_device_authorizations WHERE state='active'
    AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS next_expiry
  FROM storage_effective_selective_runtime WHERE id=1 AND method='effective-selective-v1'`;
const TARGET_READY=`SELECT r.source_namespace AS namespace,COALESCE(c.sequence,0) AS delivered,
  EXISTS(SELECT 1 FROM analytics_partition_ranges WHERE source_id=r.source_id
    AND (state!='complete' OR acknowledged=0)) AS range_pending,
  EXISTS(SELECT 1 FROM analytics_partition_global_changes WHERE source_id=r.source_id
    AND (state!='complete' OR acknowledged=0)) AS global_pending,
  EXISTS(SELECT 1 FROM analytics_partition_work WHERE source_id=r.source_id
    AND stage IN('canonical','features') AND state!='complete'
    AND NOT(state='refused' AND reason_code='obsolete_input')) AS producer_pending,
  EXISTS(SELECT 1 FROM analytics_partition_canonical_effects q JOIN analytics_canonical_effects e USING(effect_key)
    JOIN analytics_canonical_pages p USING(change_key) WHERE p.source_id=r.source_id AND q.state='pending') AS effect_pending,
  NOT EXISTS(SELECT 1 FROM analytics_partition_reconciliation WHERE source_id=r.source_id AND complete=1) AS reconciliation_pending,
  EXISTS(SELECT 1 FROM analytics_partition_dirty_work WHERE source_id=r.source_id AND generation>admitted_generation) AS survivor_pending
  FROM analytics_runtime_sources r LEFT JOIN analytics_source_cursors c USING(source_id)
  WHERE r.source_id=? AND r.contract_version=1`;
interface SourceRow {sequence:number;policy_stamp:number;acknowledged_policy_stamp:number;bootstrapped:number;
 owner_pending:number;work_pending:number;reverse_pending:number;effect_pending:number;clock_phase:number;next_expiry:string|null}
interface TargetRow {namespace:string;delivered:number;range_pending:number;global_pending:number;
 producer_pending:number;effect_pending:number;reconciliation_pending:number;survivor_pending:number}
const sourceReady=(row:SourceRow|null,generation:number)=>!!row&&row.sequence===generation
  &&row.policy_stamp===row.acknowledged_policy_stamp&&row.bootstrapped===1
  &&[row.owner_pending,row.work_pending,row.reverse_pending,row.effect_pending].every(value=>value===0);
const targetSettled=(row:TargetRow|null,input:TargetInput)=>!!row&&row.namespace===input.sourceNamespace
  &&[row.range_pending,row.global_pending,row.producer_pending,row.effect_pending,
    row.reconciliation_pending,row.survivor_pending].every(value=>value===0);
const targetReady=(row:TargetRow|null,input:Input,sequence:number)=>targetSettled(row,input)&&row!.delivered===sequence;
/** Scheduling hint only. A positive result is never a source or publication
 * proof; every publication still obtains the complete closure fence. */
export async function readAnalyticsWorkTargetSettled(input:TargetInput):Promise<boolean> {
  if(!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(input.sourceId)||!input.sourceNamespace
    ||input.sourceNamespace.length>256)throw new Error('ANALYTICS_CLOSURE_FENCE_INVALID');
  try {
    if(await producersPending(input))return false;
    return targetSettled(await input.target.prepare(TARGET_READY).bind(input.sourceId).first<TargetRow>(),input);
  } catch(error) {
    if(error instanceof Error&&/no such table|no such column/iu.test(error.message))return false;
    throw error;
  }
}
/** Absence of work is usable only after complete source discovery, exact ACKs,
 * delivery and migration reconciliation. A refusal is never a completed input. */
export async function readAnalyticsWorkClosureFence(input:Input):Promise<AnalyticsWorkClosureFence|null> {
  if(!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(input.sourceId)||!input.sourceNamespace
    ||input.sourceNamespace.length>256||input.source===input.target)throw new Error('ANALYTICS_CLOSURE_FENCE_INVALID');
  try {
    if(await producersPending(input))return null;
    // A fresh negative target proof needs no source reconstruction. Nothing
    // positive escapes these checks: a zero count still takes the exact target
    // inventory, schema, source, authority, clock and final-target proofs.
    const target=await input.target.prepare(TARGET_READY).bind(input.sourceId).first<TargetRow>();
    if(!targetSettled(target,input)||!await analyticsPartitionWorkAvailable(input.target))return null;
    const first=await readEffectiveDependencySourceFence(input.source);if(!first)return null;
    const authority=await captureStorageCommunityAuthority(input.source,input);
    const source=await input.source.prepare(SOURCE_READY).first<SourceRow>();
    if(!sourceReady(source,first.generation)||!targetReady(target,input,authority.sequence))return null;
    const finalAuthority=await captureStorageCommunityAuthority(input.source,input);
    // Install rejection handlers before any metered database method runs.
    // A later synchronous budget refusal must not orphan an earlier source
    // proof that was already started while constructing a Promise.all array.
    const [fresh,finalSource,finalTarget]=await Promise.all([
      Promise.resolve().then(()=>readEffectiveDependencySourceFence(input.source)),
      Promise.resolve().then(()=>input.source.prepare(SOURCE_READY).first<SourceRow>()),
      Promise.resolve().then(()=>input.target.prepare(TARGET_READY).bind(input.sourceId).first<TargetRow>()),
    ]);
    if(!source||!finalSource||source.clock_phase!==finalSource.clock_phase||source.next_expiry!==finalSource.next_expiry
      ||!Number.isSafeInteger(source.clock_phase)||source.clock_phase<0||!fresh||fresh.generation!==first.generation||fresh.capabilityVersion!==first.capabilityVersion
      ||!sameStorageCommunityAuthority(authority,finalAuthority,true)||!sourceReady(finalSource,fresh.generation)
      ||!targetReady(finalTarget,input,authority.sequence))return null;
    const validUntilMs=source.next_expiry===null?Number.MAX_SAFE_INTEGER:Date.parse(source.next_expiry);
    if(!Number.isSafeInteger(validUntilMs)||validUntilMs<=Date.now())return null;
    const identity={schema:'analytics-work-closure-fence-v1' as const,sourceId:input.sourceId,
      sourceNamespace:input.sourceNamespace,acceptedSequence:authority.sequence,mutationGeneration:first.generation,clockPhase:source.clock_phase,validUntilMs,authority};
    return {...identity,proofDigest:await sha256Hex(canonicalJson(identity))};
  } catch(error) {
    if(error instanceof Error&&(/no such table|no such column/iu.test(error.message)
      ||error.message==='STORAGE_COMMUNITY_AUTHORITY_UNAVAILABLE'))return null;
    throw error;
  }
}
