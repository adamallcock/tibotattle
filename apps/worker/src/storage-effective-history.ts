import { canonicalTelemetryV11Json, parseTelemetryV11Record } from '@app-usagemonitor/telemetry-contract';
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { readEffectiveTelemetryOwnerDayPage, readEffectiveTelemetryOwnerDays, type EffectiveUsageReaderCursor } from './telemetry-usage-effective-reader';
import { typedTelemetryIdSql } from './typed-telemetry-codec';
import { advanceV11QuotaAcquisition, createV11QuotaAcquisitionCheckpoint,
  type V11QuotaAcquisitionCheckpoint, type V11CompletedQuotaAcquisition,
  type V11QuotaAcquisitionIdentity, type V11QuotaPageReader } from './quota-analysis-v11-reader';
import { advanceV11UsageReduction, createV11QuotaAcquisitionIdentity, finishV11UsageReduction,
  type V11UsageReductionCheckpoint, type UsageRow } from './quota-analysis-v11';
import type { V11SourcePin } from './telemetry-v11-domain';
import type { V11QuotaPageRow } from './typed-v11-quota-reader';
import type { StorageCommunityOwner } from './storage-community-authority';

export const STORAGE_EFFECTIVE_READER_METHOD = 'effective-usage-owner-day-v1';
const DAY_MS = 86_400_000;
const MAX_EFFECTIVE_DEPENDENCY_ROWS = 30_000;
const MAX_EFFECTIVE_DEPENDENCY_BYTES = 4 * 1024 * 1024;
const V12_DEPENDENCY_TABLES = [
  'telemetry_v12_runtime', 'telemetry_v12_device_capabilities',
  'accountless_v12_device_authorizations', 'telemetry_v12_day_manifests',
  'telemetry_v12_chunks', 'telemetry_v12_records', 'telemetry_v12_domain_predecessors',
  'telemetry_v12_domains', 'telemetry_v12_domain_days', 'telemetry_v12_domain_heads',
] as const;
const fail = () => new Error('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
export interface EffectiveQuotaCursor {
  phase: V11QuotaAcquisitionCheckpoint['phase']; day: string;
  after: EffectiveUsageReaderCursor | null; ordinal: number; complete: boolean;
}
export type StorageEffectiveHistoryCheckpoint = {
  version: 1; source: 'effective'; day: string; layout: string;
  identity: V11QuotaAcquisitionIdentity; effectiveCursor: EffectiveQuotaCursor;
  effectiveDays:{quota:readonly string[];usage:readonly string[]};
} & ({phase:'acquisition'; acquisition:V11QuotaAcquisitionCheckpoint}
  |{phase:'finish'; acquisition:V11CompletedQuotaAcquisition}
  |{phase:'usage'; acquisition:V11CompletedQuotaAcquisition; usage:V11UsageReductionCheckpoint});
export function validEffectiveQuotaCursor(value: unknown): value is EffectiveQuotaCursor {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const row=value as EffectiveQuotaCursor;
  return Object.keys(row).sort().join(',')==='after,complete,day,ordinal,phase'
    && ['plan','clusters','fitability','endpoints'].includes(row.phase)
    && /^\d{4}-\d{2}-\d{2}$/u.test(row.day) && Number.isFinite(Date.parse(row.day))
    && new Date(row.day).toISOString().slice(0,10)===row.day
    && Number.isSafeInteger(row.ordinal)&&row.ordinal>=0&&typeof row.complete==='boolean'
    && (row.after===null || (Object.keys(row.after).sort().join(',')==='observedAtMs,occurrenceId'
      && Number.isSafeInteger(row.after.observedAtMs)
      && typeof row.after.occurrenceId==='string'&&row.after.occurrenceId.length<=128));
}
export function validEffectiveDays(value:unknown,fromDay:string,throughDay:string):value is {quota:readonly string[];usage:readonly string[]} {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='quota,usage')return false;
  return Object.values(value).every(days=>Array.isArray(days)&&days.length<=101&&days.every((day,index)=>
    typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/u.test(day)&&Number.isFinite(Date.parse(day))
    &&new Date(day).toISOString().slice(0,10)===day&&day>=fromDay&&day<=throughDay
    &&(index===0||days[index-1]<day)));
}
export interface EffectiveHistoryDependency {
  version: 'effective-history-dependency-v2'; participantId: string; fromDay: string; throughDay: string;
  /** The retained source streams represented by this identity. Session rows
   * are opt-in because usage/quota callers must keep their existing key. */
  streams: readonly ('quota'|'session'|'usage')[];
  v1: readonly Record<string, unknown>[]; v11: readonly Record<string, unknown>[];
  v12: readonly Record<string, unknown>[]; corrections: readonly Record<string, unknown>[];
  /** Immutable header coordinates for selected occurrences whose retained
   * variant lies outside the requested window. In-window rows are covered by
   * the family metadata vectors above. Correction rows use a per-day
   * count/frontier summary rather than one history/fact row per occurrence. */
  occurrenceLinks: readonly Record<string, unknown>[];
}

function validDependencyDay(value:string):void {
  if(!/^\d{4}-\d{2}-\d{2}$/u.test(value)||!Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    ||new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10)!==value)throw fail();
}
function dependencyRows(rows:readonly Record<string, unknown>[]):readonly Record<string, unknown>[] {
  if(rows.length>MAX_EFFECTIVE_DEPENDENCY_ROWS)throw fail();
  const copy=rows.map(row=>Object.freeze({...row}));
  if(bytes(canonicalJson(copy))>MAX_EFFECTIVE_DEPENDENCY_BYTES)throw fail();
  return Object.freeze(copy);
}
function bytes(value:string):number { return new TextEncoder().encode(value).byteLength; }
async function v12DependencySchema(source:D1Database):Promise<boolean>{
  const rows=(await source.prepare(`SELECT name,type FROM sqlite_master
    WHERE (type='table' AND name IN (${V12_DEPENDENCY_TABLES.map(()=>'?').join(',')}))
       OR (type='view' AND name='telemetry_v12_active_authorizations')`)
    .bind(...V12_DEPENDENCY_TABLES).all<{name:string;type:string}>()).results;
  if(rows.length===0)return false;
  if(rows.length!==V12_DEPENDENCY_TABLES.length+1
    ||!rows.some(row=>row.type==='view'&&row.name==='telemetry_v12_active_authorizations'))throw fail();
  return true;
}

/** Return bounded immutable header identities for retained variants of
 * selected occurrences. The selected arms use the requested source day; the
 * linked arms expand across all retained days and then keep only outside-day
 * headers. This mirrors the effective reader's cross-family occurrence
 * expansion without storing one dependency row per in-window record. */
async function effectiveHistoryOccurrenceLinks(source:D1Database,owner:StorageCommunityOwner,
  sourceNamespace:string,fromDay:string,throughDay:string,includeV12:boolean,includeSessions:boolean):Promise<readonly Record<string,unknown>[]> {
  // These fragments are static allowlisted SQL, never caller input. Keeping
  // the stream set in the dependency identity prevents a session-enabled
  // reader from reusing a usage/quota-only checkpoint.
  const sourceStreams=includeSessions?"('usage','quota','session')":"('usage','quota')";
  const typedOccurrence=typedTelemetryIdSql('h.occurrence_id');
  const typedV12Occurrence=typedTelemetryIdSql('v12_record.occurrence_id');
  const typedV12LinkedOccurrence=typedTelemetryIdSql('r.occurrence_id');
  const retainedV12=includeV12?`retained_v12(participant_id,device_id) AS (
      SELECT authorization.participant_id,authorization.device_id
        FROM telemetry_v12_active_authorizations authorization
        JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=authorization.participant_id
          AND owner_link.state='active'
      UNION
      SELECT capability.participant_id,capability.device_id
        FROM telemetry_v12_device_capabilities capability
        JOIN participants participant ON participant.id=capability.participant_id AND participant.state='active'
        JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=capability.participant_id
          AND owner_link.state='active'
       WHERE capability.state IN ('accepted','revoked')
         AND capability.telemetry_schema_version='telemetry-contribution-v1.2'
      UNION
      SELECT authorization.participant_id,authorization.device_credential_id
        FROM accountless_v12_device_authorizations authorization
        JOIN participants participant ON participant.id=authorization.participant_id AND participant.state='active'
        JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=authorization.participant_id
          AND owner_link.state='active'
       WHERE (authorization.state='active' AND authorization.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          OR (authorization.state='revoked' AND authorization.revocation_reason='user_opt_out')
    ),`:' ';
  const selectedV12=includeV12?`      UNION
      SELECT ${typedV12Occurrence}
        FROM telemetry_v12_domains generation
        JOIN scope s
        JOIN retained_v12 retained ON retained.participant_id=generation.participant_id
          AND retained.device_id=generation.device_id
        JOIN telemetry_v12_domain_days domain_day ON domain_day.generation_id=generation.id
        JOIN telemetry_v12_day_manifests manifest ON manifest.id=domain_day.manifest_id
          AND manifest.participant_id=generation.participant_id AND manifest.device_id=generation.device_id
          AND manifest.chunk_day=domain_day.observed_day
          AND manifest.manifest_digest=domain_day.manifest_digest AND manifest.state='ready'
        JOIN telemetry_v12_chunks chunk ON chunk.manifest_id=manifest.id
          AND chunk.participant_id=generation.participant_id AND chunk.device_id=generation.device_id
          AND chunk.chunk_day=manifest.chunk_day AND chunk.stream IN ${sourceStreams}
          AND chunk.record_count=(SELECT count(*) FROM telemetry_v12_records complete
            WHERE complete.chunk_id=chunk.id)
        JOIN telemetry_v12_records v12_record ON v12_record.chunk_id=chunk.id
          AND v12_record.manifest_id=manifest.id AND v12_record.stream=chunk.stream
       WHERE generation.participant_id=s.participant_id
         AND domain_day.observed_day>=s.from_day AND domain_day.observed_day<=s.through_day
` : '';
  const rows=(await source.prepare(`WITH scope(owner_digest,participant_id,source_namespace,from_day,through_day,from_ms,through_ms) AS (
      SELECT ?,?,?,?,?,?,?
    ), ${retainedV12} selected(occurrence_id) AS MATERIALIZED (
      SELECT r.occurrence_id
        FROM typed_telemetry_compatibility_records r
        JOIN scope s
        JOIN typed_v1_admission_state v1 ON v1.id=1 AND v1.runtime_contract_version=1
          AND v1.source_namespace=s.source_namespace
        JOIN typed_v1_owner_memberships owner_membership ON owner_membership.participant_id=r.participant_id
        JOIN typed_telemetry_owners typed_owner ON typed_owner.id=owner_membership.typed_owner_id
          AND typed_owner.namespace_id=v1.namespace_id
        JOIN typed_v1_record_admissions admission ON admission.typed_record_id=r.storage_row_id
        JOIN telemetry_v1_chunks chunk ON chunk.id=admission.chunk_id
          AND chunk.participant_id=r.participant_id AND chunk.device_id=r.device_id
          AND chunk.stream IN ${sourceStreams} AND chunk.superseded_at IS NULL
          AND chunk.accepted_record_count=chunk.record_count
          AND chunk.record_count=(SELECT count(*) FROM typed_v1_record_admissions complete
            WHERE complete.chunk_id=chunk.id)
        JOIN typed_v1_event_sources event ON event.chunk_id=chunk.id
          AND event.owner_digest=s.owner_digest AND event.source_namespace=v1.source_namespace
       WHERE r.participant_id=s.participant_id AND r.source_namespace=v1.source_namespace
         AND r.namespace_id=v1.namespace_id AND r.owner_id=typed_owner.id
         AND r.format_code=10 AND r.stream IN ${sourceStreams}
         AND r.observed_day>=s.from_day AND r.observed_day<=s.through_day
      UNION
      SELECT r.occurrence_id
        FROM typed_telemetry_compatibility_records r
        JOIN scope s
        JOIN typed_v11_admission_state v11 ON v11.id=1 AND v11.runtime_contract_version=1
        JOIN typed_v11_owner_memberships owner_membership ON owner_membership.participant_id=r.participant_id
        JOIN typed_telemetry_owners typed_owner ON typed_owner.id=owner_membership.typed_owner_id
          AND typed_owner.namespace_id=v11.namespace_id
        JOIN typed_v11_record_admissions admission ON admission.typed_record_id=r.storage_row_id
        JOIN telemetry_v11_chunks chunk ON chunk.id=admission.chunk_id AND chunk.stream IN ${sourceStreams}
          AND chunk.record_count=(SELECT count(*) FROM typed_v11_record_admissions complete
            WHERE complete.chunk_id=chunk.id)
        JOIN telemetry_v11_domain_days domain_day ON domain_day.manifest_id=admission.manifest_id
        JOIN telemetry_v11_day_manifests manifest ON manifest.id=domain_day.manifest_id AND manifest.state='ready'
        JOIN typed_v11_manifest_memberships manifest_membership ON manifest_membership.manifest_id=domain_day.manifest_id
        JOIN storage_v11_event_sources event ON event.generation_id=domain_day.generation_id
          AND event.owner_digest=s.owner_digest AND event.participant_id=s.participant_id
        JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=event.participant_id
          AND owner_link.owner_digest=event.owner_digest AND owner_link.state='active'
        JOIN telemetry_v11_domains generation ON generation.id=event.generation_id
          AND generation.id=domain_day.generation_id AND generation.participant_id=chunk.participant_id
          AND generation.device_id=chunk.device_id AND event.manifest_digest=generation.manifest_digest
          AND event.from_day=generation.from_day AND event.through_day=generation.through_day
          AND event.input_revision=generation.input_revision
       WHERE v11.source_namespace=s.source_namespace AND r.participant_id=s.participant_id
         AND r.source_namespace=v11.source_namespace AND r.namespace_id=v11.namespace_id
         AND r.owner_id=typed_owner.id AND r.format_code=11 AND r.stream IN ${sourceStreams}
         AND r.observed_day>=s.from_day AND r.observed_day<=s.through_day
      UNION
      SELECT ${typedOccurrence}
        FROM telemetry_usage_correction_facts f
        JOIN telemetry_usage_correction_history h ON h.id=f.history_id
        JOIN scope s ON h.participant_id=s.participant_id AND lower(hex(h.owner_digest))=s.owner_digest
       WHERE h.event_time_ms>=s.from_ms AND h.event_time_ms<s.through_ms
${selectedV12}    ), linked(family,occurrence_id,source_day,record_day,observed_at_ms,source_key,source_digest,canonical_digest,
      record_digest,base_digest,history_id,fact_id) AS (
      SELECT DISTINCT 'v1',r.occurrence_id,r.observed_day,r.observed_day,r.observed_at_ms,
        chunk.id,chunk.chunk_digest,r.canonical_sha256,NULL,NULL,NULL,NULL
        FROM typed_telemetry_compatibility_records r
        JOIN scope s
        JOIN selected wanted ON wanted.occurrence_id=r.occurrence_id
        JOIN typed_v1_admission_state v1 ON v1.id=1 AND v1.runtime_contract_version=1
          AND v1.source_namespace=s.source_namespace
        JOIN typed_v1_owner_memberships owner_membership ON owner_membership.participant_id=r.participant_id
        JOIN typed_telemetry_owners typed_owner ON typed_owner.id=owner_membership.typed_owner_id
          AND typed_owner.namespace_id=v1.namespace_id
        JOIN typed_v1_record_admissions admission ON admission.typed_record_id=r.storage_row_id
        JOIN telemetry_v1_chunks chunk ON chunk.id=admission.chunk_id
          AND chunk.participant_id=r.participant_id AND chunk.device_id=r.device_id
          AND chunk.stream IN ${sourceStreams} AND chunk.superseded_at IS NULL
          AND chunk.accepted_record_count=chunk.record_count
          AND chunk.record_count=(SELECT count(*) FROM typed_v1_record_admissions complete
            WHERE complete.chunk_id=chunk.id)
        JOIN typed_v1_event_sources event ON event.chunk_id=chunk.id
          AND event.owner_digest=s.owner_digest AND event.source_namespace=v1.source_namespace
       WHERE r.participant_id=s.participant_id AND r.source_namespace=v1.source_namespace
         AND r.namespace_id=v1.namespace_id AND r.owner_id=typed_owner.id
         AND r.format_code=10 AND r.stream IN ${sourceStreams}
      UNION
      SELECT DISTINCT 'v11',r.occurrence_id,domain_day.observed_day,r.observed_day,r.observed_at_ms,
        chunk.id||':'||manifest.id,manifest.manifest_digest,r.canonical_sha256,NULL,NULL,NULL,NULL
        FROM typed_telemetry_compatibility_records r
        JOIN scope s
        JOIN selected wanted ON wanted.occurrence_id=r.occurrence_id
        JOIN typed_v11_admission_state v11 ON v11.id=1 AND v11.runtime_contract_version=1
        JOIN typed_v11_owner_memberships owner_membership ON owner_membership.participant_id=r.participant_id
        JOIN typed_telemetry_owners typed_owner ON typed_owner.id=owner_membership.typed_owner_id
          AND typed_owner.namespace_id=v11.namespace_id
        JOIN typed_v11_record_admissions admission ON admission.typed_record_id=r.storage_row_id
        JOIN telemetry_v11_chunks chunk ON chunk.id=admission.chunk_id AND chunk.stream IN ${sourceStreams}
          AND chunk.record_count=(SELECT count(*) FROM typed_v11_record_admissions complete
            WHERE complete.chunk_id=chunk.id)
        JOIN telemetry_v11_domain_days domain_day ON domain_day.manifest_id=admission.manifest_id
        JOIN telemetry_v11_day_manifests manifest ON manifest.id=domain_day.manifest_id AND manifest.state='ready'
        JOIN typed_v11_manifest_memberships manifest_membership ON manifest_membership.manifest_id=domain_day.manifest_id
        JOIN storage_v11_event_sources event ON event.generation_id=domain_day.generation_id
          AND event.owner_digest=s.owner_digest AND event.participant_id=s.participant_id
        JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=event.participant_id
          AND owner_link.owner_digest=event.owner_digest AND owner_link.state='active'
        JOIN telemetry_v11_domains generation ON generation.id=event.generation_id
          AND generation.id=domain_day.generation_id AND generation.participant_id=chunk.participant_id
          AND generation.device_id=chunk.device_id AND event.manifest_digest=generation.manifest_digest
          AND event.from_day=generation.from_day AND event.through_day=generation.through_day
          AND event.input_revision=generation.input_revision
       WHERE v11.source_namespace=s.source_namespace AND r.participant_id=s.participant_id
         AND r.source_namespace=v11.source_namespace AND r.namespace_id=v11.namespace_id
         AND r.owner_id=typed_owner.id AND r.format_code=11 AND r.stream IN ${sourceStreams}
${includeV12?`      UNION
      SELECT DISTINCT 'v12',${typedV12LinkedOccurrence},domain_day.observed_day,r.observed_day,r.observed_at_ms,
        chunk.id,manifest.manifest_digest,lower(hex(r.canonical_digest)),NULL,NULL,NULL,NULL
        FROM telemetry_v12_domains generation
        JOIN scope s
        JOIN selected wanted ON wanted.occurrence_id=${typedV12LinkedOccurrence}
        JOIN retained_v12 retained ON retained.participant_id=generation.participant_id
          AND retained.device_id=generation.device_id
        JOIN telemetry_v12_domain_days domain_day ON domain_day.generation_id=generation.id
        JOIN telemetry_v12_day_manifests manifest ON manifest.id=domain_day.manifest_id
          AND manifest.participant_id=generation.participant_id AND manifest.device_id=generation.device_id
          AND manifest.chunk_day=domain_day.observed_day
          AND manifest.manifest_digest=domain_day.manifest_digest AND manifest.state='ready'
        JOIN telemetry_v12_chunks chunk ON chunk.manifest_id=manifest.id
          AND chunk.participant_id=generation.participant_id AND chunk.device_id=generation.device_id
          AND chunk.chunk_day=manifest.chunk_day AND chunk.stream IN ${sourceStreams}
          AND chunk.record_count=(SELECT count(*) FROM telemetry_v12_records complete
            WHERE complete.chunk_id=chunk.id)
        JOIN telemetry_v12_records r ON r.chunk_id=chunk.id AND r.manifest_id=manifest.id
          AND r.stream=chunk.stream
       WHERE generation.participant_id=s.participant_id
`:''}    ), correction_frontiers AS (
      /* Active correction history/facts are append-only. The owner-erasure
       * triggers are the only delete path and the caller's owner CAS fences
       * that transition, so an outside-day count plus both monotonic INTEGER
       * PRIMARY KEY frontiers is an exact compact identity. */
      SELECT date(h.event_time_ms/1000,'unixepoch') AS source_day,
        count(*) AS history_fact_count,max(h.id) AS max_history_id,max(f.id) AS max_fact_id
        FROM telemetry_usage_correction_facts f
        JOIN telemetry_usage_correction_history h ON h.id=f.history_id
        JOIN scope s ON h.participant_id=s.participant_id AND lower(hex(h.owner_digest))=s.owner_digest
        JOIN selected wanted ON wanted.occurrence_id=${typedOccurrence}
       WHERE date(h.event_time_ms/1000,'unixepoch')<s.from_day
          OR date(h.event_time_ms/1000,'unixepoch')>s.through_day
       GROUP BY date(h.event_time_ms/1000,'unixepoch')
    ), outside_headers AS (
      SELECT family,NULL AS occurrence_id,source_day,NULL AS record_day,NULL AS observed_at_ms,
        source_key,source_digest,NULL AS canonical_digest,NULL AS record_digest,NULL AS base_digest,
        NULL AS history_fact_count,NULL AS max_history_id,NULL AS max_fact_id
        FROM linked l JOIN scope s
       WHERE l.source_day<s.from_day OR l.source_day>s.through_day
       GROUP BY family,source_day,source_key,source_digest
      UNION ALL
      SELECT 'correction',NULL,source_day,NULL,NULL,
        'correction-day:'||source_day,NULL,NULL,NULL,NULL,
        history_fact_count,max_history_id,max_fact_id
        FROM correction_frontiers
    )
    SELECT family,occurrence_id,source_day,record_day,observed_at_ms,source_key,source_digest,canonical_digest,
      record_digest,base_digest,history_fact_count,max_history_id,max_fact_id
      FROM outside_headers ORDER BY family,source_day,source_key LIMIT ?`)
    .bind(owner.ownerDigest,owner.participantId,sourceNamespace,fromDay,throughDay,
      Date.parse(`${fromDay}T00:00:00.000Z`),Date.parse(`${throughDay}T00:00:00.000Z`)+DAY_MS,
      MAX_EFFECTIVE_DEPENDENCY_ROWS+1).all<Record<string,unknown>>()).results;
  if(rows.length>MAX_EFFECTIVE_DEPENDENCY_ROWS)throw fail();
  return dependencyRows(rows);
}

/** Build the exact immutable evidence identity for one closed owner window.
 * This reads headers/digests only. Owner revision and authority epoch are
 * intentionally absent: callers fence them before and after each invocation,
 * while this identity remains reusable when an unrelated later upload advances
 * the owner-wide revision. Every source family is retained independently so a
 * late device/generation cannot be hidden by a winning-family shortcut. */
export async function effectiveHistoryDependency(source:D1Database,owner:StorageCommunityOwner,
  sourceNamespace:string,fromDay:string,throughDay:string,
  options:{includeSessions?:boolean}={}):Promise<EffectiveHistoryDependency>{
  validDependencyDay(fromDay);validDependencyDay(throughDay);
  if(throughDay<fromDay||owner.participantId.length<1||owner.participantId.length>256
    ||!owner.ownerDigest||!/^[a-f0-9]{64}$/u.test(owner.ownerDigest)
    ||typeof sourceNamespace!=='string'||sourceNamespace.length<1||sourceNamespace.length>256)throw fail();
  const fromMs=Date.parse(`${fromDay}T00:00:00.000Z`),throughExclusive=Date.parse(`${throughDay}T00:00:00.000Z`)+DAY_MS;
  if(!options||typeof options!=='object'||Array.isArray(options))throw fail();
  const includeSessions=options.includeSessions===true;
  if(Object.keys(options).some(key=>key!=='includeSessions'))throw fail();
  const sourceStreams=includeSessions?"('usage','quota','session')":"('usage','quota')";
  const streams=Object.freeze((includeSessions?['quota','session','usage']:['quota','usage']) as ('quota'|'session'|'usage')[]);
  const v12Available=await v12DependencySchema(source);
  const v1=(await source.prepare(`SELECT c.id,c.device_id,c.stream,c.chunk_day,c.chunk_seq,c.revision,
      c.chunk_digest,c.accepted_record_count
    FROM telemetry_v1_chunks c
    JOIN typed_v1_event_sources event ON event.chunk_id=c.id
      AND event.owner_digest=? AND event.source_namespace=?
    WHERE c.participant_id=? AND c.stream IN ${sourceStreams} AND c.superseded_at IS NULL AND c.accepted_record_count=c.record_count
      AND c.accepted_record_count>0 AND c.chunk_day>=? AND c.chunk_day<=?
    ORDER BY c.chunk_day,c.device_id,c.stream,c.chunk_seq,c.id LIMIT ?`)
    .bind(owner.ownerDigest,sourceNamespace,owner.participantId,fromDay,throughDay,MAX_EFFECTIVE_DEPENDENCY_ROWS+1)
    .all<Record<string, unknown>>()).results;
  if(v1.length>MAX_EFFECTIVE_DEPENDENCY_ROWS)throw fail();
  const v11=(await source.prepare(`SELECT DISTINCT event.device_id,domain_day.observed_day,manifest.id AS manifest_id,
      manifest.manifest_digest
    FROM storage_v11_event_sources event
    JOIN telemetry_v11_domains generation ON generation.id=event.generation_id
      AND generation.participant_id=event.participant_id AND generation.device_id=event.device_id
      AND generation.manifest_digest=event.manifest_digest
      AND generation.input_revision=event.input_revision
    JOIN telemetry_v11_domain_days domain_day ON domain_day.generation_id=generation.id
    JOIN telemetry_v11_day_manifests manifest ON manifest.id=domain_day.manifest_id
      AND manifest.participant_id=generation.participant_id AND manifest.device_id=generation.device_id
      AND manifest.state='ready'
    JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=event.participant_id
      AND owner_link.owner_digest=event.owner_digest AND owner_link.state='active'
    WHERE event.participant_id=? AND event.owner_digest=? AND domain_day.observed_day>=?
      AND domain_day.observed_day<=?
    ORDER BY domain_day.observed_day,event.device_id,manifest.id LIMIT ?`)
    .bind(owner.participantId,owner.ownerDigest,fromDay,throughDay,MAX_EFFECTIVE_DEPENDENCY_ROWS+1)
    .all<Record<string, unknown>>()).results;
  if(v11.length>MAX_EFFECTIVE_DEPENDENCY_ROWS)throw fail();
  let v12:Record<string, unknown>[]=[];
  if(v12Available){
    v12=(await source.prepare(`WITH retained(participant_id,device_id) AS (
      SELECT authorization.participant_id,authorization.device_id
        FROM telemetry_v12_active_authorizations authorization
        JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=authorization.participant_id
          AND owner_link.state='active'
      UNION
      SELECT capability.participant_id,capability.device_id
        FROM telemetry_v12_device_capabilities capability
        JOIN participants participant ON participant.id=capability.participant_id AND participant.state='active'
        JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=capability.participant_id
          AND owner_link.state='active'
       WHERE capability.state IN ('accepted','revoked')
         AND capability.telemetry_schema_version='telemetry-contribution-v1.2'
      UNION
      SELECT authorization.participant_id,authorization.device_credential_id
        FROM accountless_v12_device_authorizations authorization
        JOIN participants participant ON participant.id=authorization.participant_id AND participant.state='active'
        JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=authorization.participant_id
          AND owner_link.state='active'
       WHERE (authorization.state='active' AND authorization.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          OR (authorization.state='revoked' AND authorization.revocation_reason='user_opt_out')
    )
    SELECT DISTINCT generation.device_id,domain_day.observed_day,manifest.id AS manifest_id,manifest.manifest_digest
      FROM telemetry_v12_domains generation
      JOIN retained ON retained.participant_id=generation.participant_id AND retained.device_id=generation.device_id
      JOIN telemetry_v12_domain_days domain_day ON domain_day.generation_id=generation.id
      JOIN telemetry_v12_day_manifests manifest ON manifest.id=domain_day.manifest_id
        AND manifest.participant_id=generation.participant_id AND manifest.device_id=generation.device_id
        AND manifest.chunk_day=domain_day.observed_day
        AND manifest.manifest_digest=domain_day.manifest_digest AND manifest.state='ready'
     WHERE generation.participant_id=? AND domain_day.observed_day>=? AND domain_day.observed_day<=?
     ORDER BY domain_day.observed_day,generation.device_id,manifest.id LIMIT ?`)
      .bind(owner.participantId,fromDay,throughDay,MAX_EFFECTIVE_DEPENDENCY_ROWS+1)
      .all<Record<string, unknown>>()).results;
    if(v12.length>MAX_EFFECTIVE_DEPENDENCY_ROWS)throw fail();
  }
  // Correction history/facts are immutable while the owner is active. The
  // only permitted deletion path is the owner-erasure fence, which also
  // invalidates this reader's owner CAS. Therefore a per-day count plus the
  // monotonic history/fact frontiers is an exact append identity for the
  // selected window; outside-day occurrence links retain individual source
  // identities when they overlap a selected occurrence.
  const corrections=(await source.prepare(`SELECT date(h.event_time_ms/1000,'unixepoch') AS event_day,
      count(*) AS history_fact_count,max(h.id) AS max_history_id,max(f.id) AS max_fact_id
    FROM telemetry_usage_correction_facts f
    JOIN telemetry_usage_correction_history h ON h.id=f.history_id
    WHERE h.participant_id=? AND lower(hex(h.owner_digest))=?
      AND h.event_time_ms>=? AND h.event_time_ms<?
    GROUP BY date(h.event_time_ms/1000,'unixepoch')
    ORDER BY event_day LIMIT 102`)
    .bind(owner.participantId,owner.ownerDigest,fromMs,throughExclusive)
    .all<Record<string, unknown>>()).results;
  if(corrections.length>101)throw fail();
  const occurrenceLinks=await effectiveHistoryOccurrenceLinks(source,owner,sourceNamespace,fromDay,throughDay,v12Available,includeSessions);
  const dependency={version:'effective-history-dependency-v2' as const,participantId:owner.participantId,
    fromDay,throughDay,streams,v1:dependencyRows(v1),v11:dependencyRows(v11),v12:dependencyRows(v12),
    corrections:dependencyRows(corrections),occurrenceLinks:dependencyRows(occurrenceLinks)};
  if(bytes(canonicalJson(dependency))>MAX_EFFECTIVE_DEPENDENCY_BYTES)throw fail();
  return Object.freeze(dependency);
}
export async function effectiveHistoryPin(owner:StorageCommunityOwner,fromDay:string,throughDay:string,
  dependency:EffectiveHistoryDependency):Promise<V11SourcePin>{
  return {source:'v1.1',participantId:owner.participantId,generationId:`effective:${owner.ownerDigest}`,
    fromDay,throughDay,inputRevision:owner.inputRevision,mutationEpoch:owner.authorityEpoch,
    fingerprint:await sha256Hex(canonicalJson([fromDay,throughDay,dependency]))};
}
export async function assertEffectiveHistoryOwner(source:D1Database,owner:StorageCommunityOwner):Promise<void>{
  const live=await source.prepare(`SELECT r.revision,r.authority_epoch FROM storage_owner_revisions r
    JOIN storage_v11_owner_links l ON l.owner_digest=r.owner_digest
    JOIN participants p ON p.id=l.participant_id AND p.state='active'
    WHERE l.participant_id=? AND l.owner_digest=? AND l.state='active' AND r.state='active'`)
    .bind(owner.participantId,owner.ownerDigest).first<{revision:number;authority_epoch:number}>();
  if(!live||live.revision!==owner.ownerRevision||live.authority_epoch!==owner.authorityEpoch)throw fail();
}

/** Reuse the existing quota and usage reducers, advancing only a bounded
 * occurrence-group page. The separately framed checkpoint retains compact
 * quota acquisition/reduction state; no usage-event copies enter analytics.
 * An empty day advances the effective cursor instead of falsely ending the
 * horizon. Both sides of each page are fenced by the effective source reader. */
export async function advanceStorageEffectiveAnalysis(input:{
  source:D1Database;sourceNamespace:string;owner:StorageCommunityOwner & {ownerDigest:string};
  pin:V11SourcePin;day:string;metric:'fits'|'model';nowMs:number;
  checkpoint?:StorageEffectiveHistoryCheckpoint|null;
  budget:{remainingQueries:number;deadlineMs:number;now?:()=>number};
}):Promise<{status:'deferred';checkpoint:StorageEffectiveHistoryCheckpoint|null}|{status:'complete';analysis:object}>{
  const {source,pin,owner,budget}=input;
  const now=budget.now??Date.now;
  if(budget.remainingQueries<120||now()>=budget.deadlineMs)return {status:'deferred',checkpoint:null};
  if(!owner.ownerDigest||input.day!==pin.throughDay||pin.participantId!==owner.participantId
    ||Date.parse(`${pin.throughDay}T00:00:00.000Z`)-Date.parse(`${pin.fromDay}T00:00:00.000Z`)>101*DAY_MS)throw fail();
  await assertEffectiveHistoryOwner(source,owner);
  const identity=createV11QuotaAcquisitionIdentity(pin,input.nowMs),layout=`effective:${input.sourceNamespace}`;
  let checkpoint=input.checkpoint??null;
  if(checkpoint&&(checkpoint.source!=='effective'||checkpoint.version!==1||checkpoint.day!==input.day
    ||checkpoint.layout!==layout||canonicalJson(checkpoint.identity)!==canonicalJson(identity)
    ||!validEffectiveQuotaCursor(checkpoint.effectiveCursor)
    ||!validEffectiveDays(checkpoint.effectiveDays,pin.fromDay,pin.throughDay)))throw fail();
  if(!checkpoint){
    const inventory={sourceNamespace:input.sourceNamespace,ownerDigest:owner.ownerDigest,
      ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,fromDay:pin.fromDay,throughDay:pin.throughDay};
    const quota=await readEffectiveTelemetryOwnerDays(source,{...inventory,stream:'quota'});
    const usage=await readEffectiveTelemetryOwnerDays(source,{...inventory,stream:'usage'});
    checkpoint={version:1,source:'effective',day:input.day,layout,identity,phase:'acquisition',effectiveDays:{quota,usage},
      effectiveCursor:{phase:'plan',day:quota[0]??pin.throughDay,after:null,ordinal:0,complete:quota.length===0},
      acquisition:createV11QuotaAcquisitionCheckpoint(identity)};
  }
  const read=(day:string,stream:'quota'|'usage',after?:EffectiveUsageReaderCursor)=>
    readEffectiveTelemetryOwnerDayPage(source,{sourceNamespace:input.sourceNamespace,
      ownerDigest:owner.ownerDigest,ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,
      day,stream,limit:200,...(after?{after}:{})});
  if(checkpoint.phase==='acquisition'){
    const acquisition=checkpoint.acquisition;
    const cursor=structuredClone(checkpoint.effectiveCursor);
    if(cursor.phase!==acquisition.phase){Object.assign(cursor,{phase:acquisition.phase,day:checkpoint.effectiveDays.quota[0]??pin.throughDay,
      after:null,ordinal:0,complete:checkpoint.effectiveDays.quota.length===0});}
    const reader:V11QuotaPageReader={pageSize:200,effective:{complete:()=>cursor.complete},
      async readPage(){
        if(cursor.complete)return [];
        const page=await read(cursor.day,'quota',cursor.after??undefined);
        const rows:V11QuotaPageRow[]=page.rows.map(row=>{
          if(row.status!=='compatible'||row.recordJson===null||row.eventTime===null)throw fail();
          const value=parseTelemetryV11Record('quota',JSON.parse(row.recordJson));
          if(value.schemaVersion!=='quota-observation-v1.1')throw fail();
          const id=++cursor.ordinal;if(!Number.isSafeInteger(id))throw fail();
          const at=Date.parse(row.eventTime),attribution=value.accountPlanAttribution;
          return {physicalId:id,sourceRowId:id,observedAtMs:at,active:{id,observedAtMs:at,
            observedAt:row.eventTime,observedDay:cursor.day,deviceId:'effective-owner',provider:value.provider,
            limitId:value.limitId,planType:value.planType,planVariant:value.planVariant,
            accountBasis:attribution.accountBasis,accountTrackId:attribution.accountTrackId,
            planBasis:attribution.planBasis,planEraId:attribution.planEraId,occurrenceId:value.observationId,
            slot:value.slot,usedPercent:value.usedPercent,windowDurationMinutes:value.windowDurationMinutes,
            resetsAt:value.resetsAt,resetsAtMs:value.resetsAt===null?null:Date.parse(value.resetsAt)}};
        });
        if(page.next)cursor.after=page.next;
        else {
          const nextDay=checkpoint!.effectiveDays.quota.find(day=>day>cursor.day);
          if(nextDay){cursor.day=nextDay;cursor.after=null;}else cursor.complete=true;
        }
        return rows;
      }};
    const step=await advanceV11QuotaAcquisition(reader,identity,{remainingQueries:1,deadlineMs:budget.deadlineMs,now},
      acquisition,{maxPages:1,stopAtPhaseBoundary:true});
    await assertEffectiveHistoryOwner(source,owner);
    if(step.status==='not_testable')return {status:'complete',analysis:input.metric==='fits'
      ?{schemaVersion:'account-scoped-quota-analysis-v0.1',status:'not_testable',reason:step.reason,tracks:[]}
      :{status:'not_testable',reason:step.reason,tracks:[]}};
    const base={version:1 as const,source:'effective' as const,day:input.day,layout,identity,effectiveCursor:cursor,effectiveDays:checkpoint.effectiveDays};
    return {status:'deferred',checkpoint:step.status==='deferred'
      ?{...base,phase:'acquisition',acquisition:step.checkpoint}
      :{...base,phase:'finish',acquisition:{identity,planAnchors:step.planAnchors,quotaRows:step.quotaRows}}};
  }
  const days=checkpoint.effectiveDays.usage;
  const options={nowMs:input.nowMs,sourcePin:pin,quotaAcquisition:checkpoint.acquisition,
    scalarRequested:input.metric==='fits',effectiveUsageReader:{days,async readPage(cursor:{day:string;afterTime:string;afterOccurrence:string}){
      const page=await read(cursor.day,'usage',cursor.afterOccurrence?{
        observedAtMs:Date.parse(cursor.afterTime),occurrenceId:cursor.afterOccurrence}:undefined);
      const rows:UsageRow[]=page.rows.map(row=>{
        if(row.status!=='compatible'||row.recordJson===null||row.eventTime===null)throw fail();
        const value=parseTelemetryV11Record('usage',JSON.parse(row.recordJson));
        if(value.schemaVersion!=='usage-event-v1.1')throw fail();
        return {occurrence_id:value.eventId,observed_at:row.eventTime,provider:value.provider,
          session_uuid:value.sessionUuid,record_json:canonicalTelemetryV11Json(value)};
      });
      return {rows,complete:page.next===null};
    }}};
  const prior=checkpoint.phase==='usage'?checkpoint.usage:null;
  if(prior?.complete){const analysis=await finishV11UsageReduction(source,pin,options,prior,input.metric,identity);
    await assertEffectiveHistoryOwner(source,owner);return {status:'complete',analysis};}
  const usage=await advanceV11UsageReduction(source,pin,options,
    {remainingQueries:2,deadlineMs:budget.deadlineMs,now},prior,1,identity);
  await assertEffectiveHistoryOwner(source,owner);
  return {status:'deferred',checkpoint:{version:1,source:'effective',day:input.day,layout,identity,
    effectiveCursor:checkpoint.effectiveCursor,effectiveDays:checkpoint.effectiveDays,phase:'usage',acquisition:checkpoint.acquisition,usage}};
}
