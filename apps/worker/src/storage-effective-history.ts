import { canonicalJson } from './canonical-json';
import { EFFECTIVE_DAY_CATALOG_TABLES, EFFECTIVE_DAY_CATALOG_TRIGGERS, effectiveDayCatalogAvailable,
  effectiveOutsideDayPredicate, EFFECTIVE_DAY_CATALOG_RUNTIME_FENCE } from './storage-effective-dependency-days';
import { sha256Hex } from './crypto';
import { readEffectiveTelemetryOwnerDayPage, readEffectiveTelemetryOwnerDays, type EffectiveUsageReaderCursor } from './telemetry-usage-effective-reader';
import { TYPED_V11_CHUNK_PROOF_COUNT_SQL } from './typed-v11-chunk-completeness';
import { advanceV11QuotaAcquisition, createV11QuotaAcquisitionCheckpoint,
  type V11QuotaAcquisitionCheckpoint, type V11CompletedQuotaAcquisition,
  type V11QuotaAcquisitionIdentity, type V11QuotaPageReader } from './quota-analysis-v11-reader';
import { advanceV11UsageReduction, createV11QuotaAcquisitionIdentity, finishV11UsageReduction,
  foldV11UsageModelReduction,type V11UsageReductionCheckpoint } from './quota-analysis-v11';
import type { V11SourcePin } from './telemetry-v11-domain';
import type { V11QuotaPageRow } from './typed-v11-quota-reader';
import type { StorageCommunityOwner } from './storage-community-authority';
import { appendEffectiveQuotaDay, finishEffectiveQuotaDay, foldEffectiveQuotaDays,
  mapEffectiveQuotaPageRow, validEffectiveQuotaDay, validEffectiveQuotaDayPending,
  type EffectiveQuotaDay, type EffectiveQuotaDayPending } from './effective-quota-day';
import {appendEffectiveUsageDay,mapEffectiveUsagePageRow,validEffectiveUsageDay,validEffectiveUsageDayPending,
  type EffectiveUsageDay,type EffectiveUsageDayPending,type StorageEffectiveUsagePreparation} from './effective-usage-day';
import {MAX_WINDOWED_USAGE_ROWS} from './quota-analysis-v1';

export const STORAGE_EFFECTIVE_READER_METHOD = 'effective-usage-owner-day-v1';
const DAY_MS = 86_400_000;
const MAX_EFFECTIVE_DEPENDENCY_ROWS = 30_000;
const MAX_EFFECTIVE_DEPENDENCY_BYTES = 4 * 1024 * 1024;
const EFFECTIVE_DEPENDENCY_BATCH_DAYS = 16;
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
/** One optional cache gap, independent of the analytical cursor. A completed
 * buffer remains durable until the day manifest has actually been promoted.
 * The turn bounds preparation to one page between analytical advances. */
export interface EffectiveQuotaCoverage {
  next: 'analysis'|'prepare';
  refusedDays: readonly string[];
  pending: { state:'reading'; after: EffectiveUsageReaderCursor; quota: EffectiveQuotaDayPending }
    |{state:'ready';day:EffectiveQuotaDay}|null;
}
export type EffectiveUsagePreparationState={state:'disabled'}
  |{state:'pending';rowsRead:number}
  |{state:'reading';rowsRead:number;after:EffectiveUsageReaderCursor;day:EffectiveUsageDayPending}
  |{state:'ready';rowsRead:number;day:EffectiveUsageDay};
export type StorageEffectiveHistoryCheckpoint = {
  version: 1; source: 'effective'; day: string; layout: string;
  identity: V11QuotaAcquisitionIdentity; effectiveCursor: EffectiveQuotaCursor;
  effectiveDays:{quota:readonly string[];usage:readonly string[]};
  quotaCoverage?: EffectiveQuotaCoverage;
  /** Model-only optional preparation; the analytical successor remains intact
   * until complete-day coverage can replace it with one exact full fold. */
  usagePreparation?:EffectiveUsagePreparationState;
} & ({phase:'acquisition'; acquisition:V11QuotaAcquisitionCheckpoint; preparingQuota?:EffectiveQuotaDayPending}
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
export function validEffectiveQuotaCoverage(value:unknown,days:readonly string[],phase:StorageEffectiveHistoryCheckpoint['phase'],
  inline?:EffectiveQuotaDayPending):value is EffectiveQuotaCoverage {
  if(!value||typeof value!=='object'||Array.isArray(value)
    ||Object.keys(value).sort().join(',')!=='next,pending,refusedDays')return false;
  const coverage=value as EffectiveQuotaCoverage;
  if(!['analysis','prepare'].includes(coverage.next)||!Array.isArray(coverage.refusedDays)
    ||coverage.refusedDays.length>101||coverage.refusedDays.some((day,index)=>typeof day!=='string'
      ||!days.includes(day)||index>0&&coverage.refusedDays[index-1]!>=day))return false;
  if(coverage.pending===null)return phase==='acquisition';
  const pending=coverage.pending;
  if(inline!==undefined||!pending||typeof pending!=='object'||Array.isArray(pending)
    ||!['reading','ready'].includes(pending.state))return false;
  if(pending.state==='ready')return Object.keys(pending).sort().join(',')==='day,state'
    &&validEffectiveQuotaDay(pending.day)&&days.includes(pending.day.projection.day)
    &&!coverage.refusedDays.includes(pending.day.projection.day);
  if(Object.keys(pending).sort().join(',')!=='after,quota,state'
    ||!validEffectiveQuotaDayPending(pending.quota)||!days.includes(pending.quota.day)
    ||coverage.refusedDays.includes(pending.quota.day))return false;
  const after=pending.after,last=pending.quota.rows.at(-1);
  return phase==='acquisition'&&!!last&&!!after&&typeof after==='object'&&!Array.isArray(after)
    &&Object.keys(after).sort().join(',')==='observedAtMs,occurrenceId'
    &&Number.isSafeInteger(after.observedAtMs)&&after.observedAtMs===last.observedAtMs
    &&typeof after.occurrenceId==='string'&&/^[A-Za-z0-9._:-]{8,128}$/u.test(after.occurrenceId);
}
export function validEffectiveUsagePreparation(value:unknown,checkpoint:Pick<StorageEffectiveHistoryCheckpoint,
  'phase'|'effectiveDays'|'quotaCoverage'>&{usage?:V11UsageReductionCheckpoint}):value is EffectiveUsagePreparationState {
  if(checkpoint.phase==='acquisition'||checkpoint.quotaCoverage?.pending!==undefined&&checkpoint.quotaCoverage.pending!==null
    ||checkpoint.usage&&(checkpoint.usage.scalarReduced||checkpoint.usage.complete)
    ||!value||typeof value!=='object'||Array.isArray(value))return false;
  const preparation=value as EffectiveUsagePreparationState;
  if(preparation.state==='disabled')return Object.keys(preparation).join(',')==='state';
  if(!Number.isSafeInteger(preparation.rowsRead)||preparation.rowsRead<0||preparation.rowsRead>MAX_WINDOWED_USAGE_ROWS)return false;
  if(preparation.state==='pending')return Object.keys(preparation).sort().join(',')==='rowsRead,state';
  if(preparation.state==='ready')return Object.keys(preparation).sort().join(',')==='day,rowsRead,state'
    &&validEffectiveUsageDay(preparation.day)&&checkpoint.effectiveDays.usage.includes(preparation.day.projection.day)
    &&preparation.rowsRead>=preparation.day.projection.usage.rowsRead;
  if(preparation.state!=='reading'||Object.keys(preparation).sort().join(',')!=='after,day,rowsRead,state'
    ||!validEffectiveUsageDayPending(preparation.day)||!checkpoint.effectiveDays.usage.includes(preparation.day.projection.day))return false;
  const after=preparation.after;
  return !!after&&typeof after==='object'&&!Array.isArray(after)
    &&Object.keys(after).sort().join(',')==='observedAtMs,occurrenceId'
    &&Number.isSafeInteger(after.observedAtMs)&&after.observedAtMs===preparation.day.lastObservedAtMs
    &&typeof after.occurrenceId==='string'&&/^[A-Za-z0-9._:-]{8,128}$/u.test(after.occurrenceId)
    &&preparation.rowsRead>=preparation.day.projection.usage.rowsRead;
}
export interface EffectiveHistoryDependency {
  version: 'effective-history-dependency-v3'; participantId: string; fromDay: string; throughDay: string;
  /** The correction-aware reader changes source selection at activation even
   * when no owner revision or historical header changes. */
  correctionRuntime: 'staged'|'active';
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
async function dependencySchemas(source:D1Database):Promise<{v12Available:boolean;dayCatalogAvailable:boolean}>{
  const tables=[...V12_DEPENDENCY_TABLES,...EFFECTIVE_DAY_CATALOG_TABLES];
  const rows=(await source.prepare(`SELECT name,type FROM sqlite_master
    WHERE (type='table' AND name IN (${tables.map(()=>'?').join(',')}))
       OR (type='view' AND name='telemetry_v12_active_authorizations')
       OR (type='trigger' AND name IN (${EFFECTIVE_DAY_CATALOG_TRIGGERS.map(()=>'?').join(',')}))`)
    .bind(...tables,...EFFECTIVE_DAY_CATALOG_TRIGGERS).all<{name:string;type:string}>()).results;
  const dayCatalogAvailable=effectiveDayCatalogAvailable(rows);
  const v12Rows=rows.filter(row=>(row.type==='table'&&(V12_DEPENDENCY_TABLES as readonly string[]).includes(row.name))
    ||(row.type==='view'&&row.name==='telemetry_v12_active_authorizations'));
  if(v12Rows.length===0)return {v12Available:false,dayCatalogAvailable};
  if(v12Rows.length!==V12_DEPENDENCY_TABLES.length+1
    ||!v12Rows.some(row=>row.type==='view'&&row.name==='telemetry_v12_active_authorizations'))throw fail();
  return {v12Available:true,dayCatalogAvailable};
}

/** Return bounded immutable header identities for retained variants of
 * selected occurrences. The selected arms use the requested source day; the
 * linked arms expand across all retained days and then keep only outside-day
 * headers. This mirrors the effective reader's cross-family occurrence
 * expansion without storing one dependency row per in-window record. */
async function effectiveHistoryOccurrenceLinks(source:D1Database,owner:StorageCommunityOwner,
  sourceNamespace:string,fromDay:string,throughDay:string,includeV12:boolean,includeSessions:boolean,
  selectedDays?:readonly string[],dayCatalogAvailable=false):Promise<{
    rows:readonly Record<string,unknown>[];correctionRuntime:EffectiveHistoryDependency['correctionRuntime'];
  }|undefined> {
  const batched=selectedDays!==undefined;
  const useDayCatalog=dayCatalogAvailable&&!batched;
  // A day inside a multi-day batch is still outside another target day.
  // Preserve the original per-target expansion for batches and for every
  // positive (including conservative) catalog lookup.
  // Correction history stores raw digest bytes. Keep the text scope for the
  // admission joins, and bind its exact BLOB once for indexed occurrence seeks.
  const ownerDigest=owner.ownerDigest;
  if(!ownerDigest)throw fail();
  const ownerDigestBlob=Uint8Array.from({length:32},(_,index)=>
    Number.parseInt(ownerDigest.slice(index*2,index*2+2),16));
  const target=(alias='')=>batched?`${alias?`${alias}.`:''}target_day,`:'';
  const selectionScope=batched?'selection_scopes':'scope';
  const outside=(column:string)=>batched?`${column}<>wanted.target_day`:`(${column}<s.from_day OR ${column}>s.through_day)`;
  const physicalOutside=batched?'':`AND (scoped_record.observed_day<CAST(s.from_ms/86400000 AS INTEGER)
            OR scoped_record.observed_day>=CAST(s.through_ms/86400000 AS INTEGER))`;
  const selectedOutside=batched?`AND scoped_record.observed_day<>CAST(strftime('%s',wanted.target_day)/86400 AS INTEGER)`:'';
  // These fragments are static allowlisted SQL, never caller input. Keeping
  // the stream set in the dependency identity prevents a session-enabled
  // reader from reusing a usage/quota-only checkpoint.
  const sourceStreams=includeSessions?"('usage','quota','session')":"('usage','quota')";
  // Admission proofs require an immutable record's observed timestamp/day to
  // match its chunk day. Apply those physical bounds before compatibility
  // decoding, while keeping every decoded source and admission check below.
  const typedStreams=includeSessions?'(1,2,3)':'(1,2)';
  // Every admitted family and correction archive uses the same canonical,
  // reversible occurrence-ID codec. Match those complete BLOBs (including the
  // encoding tag) before compatibility decoding; the final dependency still
  // contains only the same immutable header coordinates.
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
    ), retained_v12_chunks AS MATERIALIZED (
      /* Check each immutable chunk once, before joining its records. A
       * per-record completeness subquery is quadratic in chunk size. */
      SELECT DISTINCT chunk.id,manifest.id AS manifest_id,chunk.stream,
        domain_day.observed_day AS source_day,manifest.manifest_digest
        FROM telemetry_v12_domains generation
        JOIN scope s ON generation.participant_id=s.participant_id
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
       WHERE chunk.record_count=(SELECT count(*) FROM telemetry_v12_records complete
          WHERE complete.chunk_id=chunk.id)
    ),`:' ';
  const selectedV12=includeV12?`      UNION
      SELECT ${target('s')}v12_record.occurrence_id
        FROM retained_v12_chunks chunk
        JOIN ${selectionScope} s ON chunk.source_day>=s.from_day AND chunk.source_day<=s.through_day
        CROSS JOIN telemetry_v12_records v12_record ON v12_record.chunk_id=chunk.id
          AND v12_record.manifest_id=chunk.manifest_id AND v12_record.stream=chunk.stream
` : '';
  const rows=(await source.prepare(`${batched?'/* batched occurrence links */ ':''}WITH ${useDayCatalog?'requested_scope':'scope'}(owner_digest,participant_id,source_namespace,from_day,through_day,from_ms,through_ms,owner_digest_blob) AS (
      SELECT ?,?,?,?,?,?,?,?
    ), ${useDayCatalog?`scope AS MATERIALIZED (
      SELECT * FROM requested_scope requested WHERE ${effectiveOutsideDayPredicate(includeSessions)}
    ), `:''} ${batched?`selection_scopes(target_day,owner_digest,participant_id,source_namespace,from_day,through_day,from_ms,through_ms,owner_digest_blob) AS MATERIALIZED (
      SELECT json_extract(day.value,'$[0]'),s.owner_digest,s.participant_id,s.source_namespace,
        json_extract(day.value,'$[0]'),json_extract(day.value,'$[0]'),
        json_extract(day.value,'$[1]'),json_extract(day.value,'$[2]'),s.owner_digest_blob
        FROM scope s CROSS JOIN json_each(?) day
    ), `:''}complete_v1_selected_chunks AS MATERIALIZED (
      SELECT chunk.id FROM scope s
        JOIN telemetry_v1_chunks chunk ON chunk.participant_id=s.participant_id
       WHERE chunk.chunk_day>=s.from_day AND chunk.chunk_day<=s.through_day
         AND chunk.stream IN ${sourceStreams} AND chunk.superseded_at IS NULL
         AND chunk.accepted_record_count=chunk.record_count
         AND chunk.record_count=(SELECT count(*) FROM typed_v1_record_admissions complete
           WHERE complete.chunk_id=chunk.id)
    ), complete_v11_selected_chunks AS MATERIALIZED (
      SELECT chunk.id FROM scope s
        JOIN telemetry_v11_chunks chunk ON chunk.participant_id=s.participant_id
       WHERE chunk.chunk_day>=s.from_day AND chunk.chunk_day<=s.through_day
         AND chunk.stream IN ${sourceStreams}
         AND chunk.record_count=${TYPED_V11_CHUNK_PROOF_COUNT_SQL}
    ), admitted_v1_selected_chunks AS MATERIALIZED (
      /* Admission seals every record's namespace, owner, device, chunk and day.
       * Retain the complete proof count, validate its immutable header once,
       * then keep raw row keys/time bounds below instead of decoding each row. */
      SELECT chunk.id,chunk.chunk_day AS source_day,r.namespace_id,r.owner_id,
        header_record.device_id AS device_key,header_record.chunk_id AS chunk_key,
        header_record.stream AS stream_code
        FROM scope s
        CROSS JOIN complete_v1_selected_chunks complete_chunk
        CROSS JOIN telemetry_v1_chunks chunk ON chunk.id=complete_chunk.id
        CROSS JOIN typed_v1_record_admissions representative ON representative.typed_record_id=(
          SELECT proof.typed_record_id FROM typed_v1_record_admissions proof INDEXED BY typed_v1_admissions_chunk
           WHERE proof.chunk_id=chunk.id ORDER BY proof.typed_record_id LIMIT 1)
        CROSS JOIN typed_telemetry_records header_record ON header_record.id=representative.typed_record_id
        CROSS JOIN typed_telemetry_compatibility_records r ON r.storage_row_id=header_record.id
        CROSS JOIN typed_v1_admission_state v1 ON v1.id=1 AND v1.runtime_contract_version=1
          AND v1.source_namespace=s.source_namespace
        CROSS JOIN typed_v1_owner_memberships owner_membership ON owner_membership.participant_id=r.participant_id
        CROSS JOIN typed_telemetry_owners typed_owner ON typed_owner.id=owner_membership.typed_owner_id
          AND typed_owner.namespace_id=v1.namespace_id
        CROSS JOIN typed_v1_event_sources event ON event.chunk_id=chunk.id
          AND event.owner_digest=s.owner_digest AND event.source_namespace=v1.source_namespace
       WHERE r.participant_id=s.participant_id AND r.source_namespace=v1.source_namespace
         AND r.namespace_id=v1.namespace_id AND r.owner_id=typed_owner.id
         AND chunk.participant_id=r.participant_id AND chunk.device_id=r.device_id
         AND r.format_code=10 AND r.stream IN ${sourceStreams}
         AND r.observed_day>=s.from_day AND r.observed_day<=s.through_day
    ), admitted_v11_selected_chunks AS MATERIALIZED (
      /* Compact proofs seal each record to this immutable chunk's namespace,
       * owner, device, manifest, stream and day. Validate source metadata once
       * per complete chunk; retain every raw coordinate and time fence below. */
      SELECT DISTINCT chunk.id,chunk.chunk_day AS source_day,r.namespace_id,r.owner_id,
        header_record.device_id AS device_key,header_record.chunk_id AS chunk_key,
        header_record.manifest_id AS manifest_key,header_record.stream AS stream_code
        FROM scope s
        CROSS JOIN typed_v11_owner_memberships scoped_owner ON scoped_owner.participant_id=s.participant_id
        CROSS JOIN complete_v11_selected_chunks complete_chunk
        CROSS JOIN telemetry_v11_chunks chunk ON chunk.id=complete_chunk.id
        CROSS JOIN typed_v11_chunk_allocations allocation ON allocation.chunk_id=chunk.id
        CROSS JOIN typed_telemetry_chunks physical_chunk ON physical_chunk.namespace_id=allocation.namespace_id
          AND physical_chunk.format=11 AND physical_chunk.original_id=allocation.chunk_original
        CROSS JOIN typed_v11_record_proofs representative ON representative.typed_record_id=(
          SELECT proof.typed_record_id FROM typed_v11_record_proofs proof INDEXED BY typed_v11_proof_chunk
           WHERE proof.chunk_key=physical_chunk.id ORDER BY proof.typed_record_id LIMIT 1)
        CROSS JOIN typed_telemetry_records header_record ON header_record.id=representative.typed_record_id
          AND header_record.owner_id=scoped_owner.typed_owner_id AND header_record.format=11
        CROSS JOIN typed_telemetry_compatibility_records r ON r.storage_row_id=header_record.id
        JOIN typed_v11_admission_state v11 ON v11.id=1 AND v11.runtime_contract_version=1
        JOIN typed_v11_owner_memberships owner_membership ON owner_membership.participant_id=r.participant_id
        JOIN typed_telemetry_owners typed_owner ON typed_owner.id=owner_membership.typed_owner_id
          AND typed_owner.namespace_id=v11.namespace_id
        JOIN typed_v11_record_admissions admission ON admission.typed_record_id=r.storage_row_id
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
         AND chunk.stream IN ${sourceStreams} AND chunk.id=admission.chunk_id
         AND r.observed_day>=s.from_day AND r.observed_day<=s.through_day
    ), ${retainedV12} selected(${target()}occurrence_id) AS MATERIALIZED (
      SELECT ${target('s')}scoped_record.occurrence_id
        FROM ${selectionScope} s
        CROSS JOIN admitted_v1_selected_chunks header
          ON header.source_day>=s.from_day AND header.source_day<=s.through_day
        CROSS JOIN typed_v1_record_admissions admission INDEXED BY typed_v1_admissions_chunk
          ON admission.chunk_id=header.id
        CROSS JOIN typed_telemetry_records scoped_record ON scoped_record.id=admission.typed_record_id
          AND scoped_record.namespace_id=header.namespace_id AND scoped_record.owner_id=header.owner_id
          AND scoped_record.device_id=header.device_key AND scoped_record.chunk_id=header.chunk_key
          AND scoped_record.format=10 AND scoped_record.stream=header.stream_code
          AND scoped_record.stream IN ${typedStreams}
          AND scoped_record.observed_at_ms>=s.from_ms AND scoped_record.observed_at_ms<s.through_ms
          AND scoped_record.observed_day>=CAST(s.from_ms/86400000 AS INTEGER)
          AND scoped_record.observed_day<CAST(s.through_ms/86400000 AS INTEGER)
      UNION
      SELECT ${target('s')}scoped_record.occurrence_id
        FROM ${selectionScope} s
        CROSS JOIN admitted_v11_selected_chunks header
          ON header.source_day>=s.from_day AND header.source_day<=s.through_day
        CROSS JOIN typed_v11_record_proofs admission INDEXED BY typed_v11_proof_chunk
          ON admission.chunk_key=header.chunk_key AND admission.manifest_key=header.manifest_key
          AND admission.stream_code=header.stream_code
        CROSS JOIN typed_telemetry_records scoped_record ON scoped_record.id=admission.typed_record_id
          AND scoped_record.namespace_id=header.namespace_id AND scoped_record.owner_id=header.owner_id
          AND scoped_record.device_id=header.device_key AND scoped_record.chunk_id=header.chunk_key
          AND scoped_record.manifest_id=header.manifest_key AND scoped_record.format=11
          AND scoped_record.stream=header.stream_code AND scoped_record.stream IN ${typedStreams}
          AND scoped_record.observed_at_ms>=s.from_ms AND scoped_record.observed_at_ms<s.through_ms
          AND scoped_record.observed_day>=CAST(s.from_ms/86400000 AS INTEGER)
          AND scoped_record.observed_day<CAST(s.through_ms/86400000 AS INTEGER)
      UNION
      SELECT ${target('s')}h.occurrence_id
        FROM ${selectionScope} s
        CROSS JOIN telemetry_usage_correction_history h INDEXED BY telemetry_usage_correction_history_owner_time
          ON h.owner_digest=s.owner_digest_blob AND h.participant_id=s.participant_id
        CROSS JOIN telemetry_usage_correction_facts f INDEXED BY telemetry_usage_correction_facts_history
          ON f.history_id=h.id
       WHERE h.event_time_ms>=s.from_ms AND h.event_time_ms<s.through_ms
${selectedV12}    ), /* Count completeness only for selected-day chunks and distinct matching
       * outside headers. Unrelated retained chunks cannot affect this identity. */
    linked_v1_headers(${target()}family,source_day,source_key,source_digest,chunk_id) AS MATERIALIZED (
      SELECT DISTINCT ${target('wanted')}'v1',r.observed_day,chunk.id,chunk.chunk_digest,chunk.id AS chunk_id
        FROM scope s
        CROSS JOIN typed_v1_owner_memberships scoped_owner
          ON scoped_owner.participant_id=s.participant_id
        CROSS JOIN selected wanted
        CROSS JOIN typed_telemetry_devices scoped_device INDEXED BY typed_telemetry_device_owner
          ON scoped_device.owner_id=scoped_owner.typed_owner_id
        CROSS JOIN typed_telemetry_records scoped_record INDEXED BY typed_telemetry_v1_occurrence
          ON scoped_record.device_id=scoped_device.id
          AND scoped_record.owner_id=scoped_owner.typed_owner_id AND scoped_record.format=10
          AND scoped_record.stream IN ${typedStreams}
          AND scoped_record.occurrence_id=wanted.occurrence_id
          ${physicalOutside} ${selectedOutside}
        CROSS JOIN typed_telemetry_compatibility_records r ON r.storage_row_id=scoped_record.id
        CROSS JOIN typed_v1_admission_state v1 ON v1.id=1 AND v1.runtime_contract_version=1
          AND v1.source_namespace=s.source_namespace
        CROSS JOIN typed_v1_owner_memberships owner_membership ON owner_membership.participant_id=r.participant_id
        CROSS JOIN typed_telemetry_owners typed_owner ON typed_owner.id=owner_membership.typed_owner_id
          AND typed_owner.namespace_id=v1.namespace_id
        CROSS JOIN typed_v1_record_admissions admission ON admission.typed_record_id=r.storage_row_id
        CROSS JOIN telemetry_v1_chunks chunk ON chunk.id=admission.chunk_id
          AND chunk.participant_id=r.participant_id AND chunk.device_id=r.device_id
          AND chunk.stream IN ${sourceStreams} AND chunk.superseded_at IS NULL
          AND chunk.accepted_record_count=chunk.record_count
        CROSS JOIN typed_v1_event_sources event ON event.chunk_id=chunk.id
          AND event.owner_digest=s.owner_digest AND event.source_namespace=v1.source_namespace
       WHERE r.participant_id=s.participant_id AND r.source_namespace=v1.source_namespace
         AND r.namespace_id=v1.namespace_id AND r.owner_id=typed_owner.id
         AND r.format_code=10 AND r.stream IN ${sourceStreams}
         AND ${outside('r.observed_day')}
    ), linked_v11_headers(${target()}family,source_day,source_key,source_digest,chunk_id) AS MATERIALIZED (
      SELECT DISTINCT ${target('wanted')}'v11',domain_day.observed_day,chunk.id||':'||manifest.id,manifest.manifest_digest,chunk.id AS chunk_id
        FROM scope s
        CROSS JOIN typed_v11_owner_memberships scoped_owner
          ON scoped_owner.participant_id=s.participant_id
        CROSS JOIN selected wanted
        CROSS JOIN typed_telemetry_manifests scoped_manifest INDEXED BY typed_telemetry_manifest_owner
          ON scoped_manifest.owner_id=scoped_owner.typed_owner_id
        CROSS JOIN typed_telemetry_records scoped_record INDEXED BY typed_telemetry_v11_occurrence
          ON scoped_record.manifest_id=scoped_manifest.id
          AND scoped_record.owner_id=scoped_owner.typed_owner_id AND scoped_record.format=11
          AND scoped_record.stream IN ${typedStreams}
          AND scoped_record.occurrence_id=wanted.occurrence_id
          ${physicalOutside} ${selectedOutside}
        CROSS JOIN typed_telemetry_compatibility_records r ON r.storage_row_id=scoped_record.id
        CROSS JOIN typed_v11_admission_state v11 ON v11.id=1 AND v11.runtime_contract_version=1
        CROSS JOIN typed_v11_owner_memberships owner_membership ON owner_membership.participant_id=r.participant_id
        CROSS JOIN typed_telemetry_owners typed_owner ON typed_owner.id=owner_membership.typed_owner_id
          AND typed_owner.namespace_id=v11.namespace_id
        CROSS JOIN typed_v11_record_admissions admission ON admission.typed_record_id=r.storage_row_id
        CROSS JOIN telemetry_v11_chunks chunk ON chunk.id=admission.chunk_id AND chunk.stream IN ${sourceStreams}
        CROSS JOIN telemetry_v11_domain_days domain_day ON domain_day.manifest_id=admission.manifest_id
        CROSS JOIN telemetry_v11_day_manifests manifest ON manifest.id=domain_day.manifest_id AND manifest.state='ready'
        CROSS JOIN typed_v11_manifest_memberships manifest_membership ON manifest_membership.manifest_id=domain_day.manifest_id
        CROSS JOIN storage_v11_event_sources event ON event.generation_id=domain_day.generation_id
          AND event.owner_digest=s.owner_digest AND event.participant_id=s.participant_id
        CROSS JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=event.participant_id
          AND owner_link.owner_digest=event.owner_digest AND owner_link.state='active'
        CROSS JOIN telemetry_v11_domains generation ON generation.id=event.generation_id
          AND generation.id=domain_day.generation_id AND generation.participant_id=chunk.participant_id
          AND generation.device_id=chunk.device_id AND event.manifest_digest=generation.manifest_digest
          AND event.from_day=generation.from_day AND event.through_day=generation.through_day
          AND event.input_revision=generation.input_revision
       WHERE v11.source_namespace=s.source_namespace AND r.participant_id=s.participant_id
         AND r.source_namespace=v11.source_namespace AND r.namespace_id=v11.namespace_id
         AND r.owner_id=typed_owner.id AND r.format_code=11 AND r.stream IN ${sourceStreams}
         AND ${outside('domain_day.observed_day')}
    ), complete_v1_chunks AS MATERIALIZED (
      SELECT chunk.id FROM (SELECT DISTINCT chunk_id FROM linked_v1_headers) candidate
        CROSS JOIN telemetry_v1_chunks chunk ON chunk.id=candidate.chunk_id
       WHERE chunk.record_count=(SELECT count(*) FROM typed_v1_record_admissions complete
          WHERE complete.chunk_id=chunk.id)
    ), complete_v11_chunks AS MATERIALIZED (
      SELECT chunk.id FROM (SELECT DISTINCT chunk_id FROM linked_v11_headers) candidate
        CROSS JOIN telemetry_v11_chunks chunk ON chunk.id=candidate.chunk_id
       WHERE chunk.record_count=${TYPED_V11_CHUNK_PROOF_COUNT_SQL}
    ), linked(${target()}family,source_day,source_key,source_digest) AS (
      SELECT ${target('header')}header.family,header.source_day,header.source_key,header.source_digest
        FROM linked_v1_headers header JOIN complete_v1_chunks complete_chunk ON complete_chunk.id=header.chunk_id
      UNION
      SELECT ${target('header')}header.family,header.source_day,header.source_key,header.source_digest
        FROM linked_v11_headers header JOIN complete_v11_chunks complete_chunk ON complete_chunk.id=header.chunk_id
${includeV12?batched?`      UNION
      SELECT DISTINCT wanted.target_day,'v12',chunk.source_day,chunk.id,chunk.manifest_digest
        FROM retained_v12_chunks chunk
        JOIN telemetry_v12_records r ON r.chunk_id=chunk.id
          AND r.manifest_id=chunk.manifest_id AND r.stream=chunk.stream
        JOIN selected wanted ON wanted.occurrence_id=r.occurrence_id
       WHERE chunk.source_day<>wanted.target_day
`:`      UNION
      SELECT 'v12',chunk.source_day,chunk.id,chunk.manifest_digest
        FROM retained_v12_chunks chunk
        JOIN scope s
       WHERE (chunk.source_day<s.from_day OR chunk.source_day>s.through_day)
         AND EXISTS (
           SELECT 1 FROM telemetry_v12_records r
           JOIN selected wanted ON wanted.occurrence_id=r.occurrence_id
           WHERE r.chunk_id=chunk.id AND r.manifest_id=chunk.manifest_id AND r.stream=chunk.stream)
`:''}    ), correction_frontiers AS (
      /* Active correction history/facts are append-only. The owner-erasure
       * triggers are the only delete path and the caller's owner CAS fences
       * that transition, so an outside-day count plus both monotonic INTEGER
       * PRIMARY KEY frontiers is an exact compact identity. */
      SELECT ${target('wanted')}date(h.event_time_ms/1000,'unixepoch') AS source_day,
        count(*) AS history_fact_count,max(h.id) AS max_history_id,max(f.id) AS max_fact_id
        FROM scope s
        CROSS JOIN selected wanted
        CROSS JOIN telemetry_usage_correction_history h INDEXED BY telemetry_usage_correction_history_owner_time
          ON h.owner_digest=s.owner_digest_blob AND h.participant_id=s.participant_id
          AND h.occurrence_id=wanted.occurrence_id
        CROSS JOIN telemetry_usage_correction_facts f INDEXED BY telemetry_usage_correction_facts_history
          ON f.history_id=h.id
       WHERE ${outside("date(h.event_time_ms/1000,'unixepoch')")}
       GROUP BY ${target('wanted')}date(h.event_time_ms/1000,'unixepoch')
    ), outside_headers AS (
      SELECT ${target('l')}family,NULL AS occurrence_id,source_day,NULL AS record_day,NULL AS observed_at_ms,
        source_key,source_digest,NULL AS canonical_digest,NULL AS record_digest,NULL AS base_digest,
        NULL AS history_fact_count,NULL AS max_history_id,NULL AS max_fact_id
        FROM linked l JOIN scope s
       WHERE ${batched?'l.source_day<>l.target_day':'l.source_day<s.from_day OR l.source_day>s.through_day'}
       GROUP BY ${target('l')}family,source_day,source_key,source_digest
      UNION ALL
      SELECT ${target()}'correction',NULL,source_day,NULL,NULL,
        'correction-day:'||source_day,NULL,NULL,NULL,NULL,
        history_fact_count,max_history_id,max_fact_id
        FROM correction_frontiers
    ), fenced_headers AS (
      SELECT ${target()}family,occurrence_id,source_day,record_day,observed_at_ms,source_key,source_digest,
        canonical_digest,record_digest,base_digest,history_fact_count,max_history_id,max_fact_id
        FROM outside_headers
      UNION ALL
      SELECT ${batched?'wanted.target_day,':''}'__correction_runtime__',NULL,NULL,NULL,NULL,NULL,
        runtime.state,NULL,NULL,NULL,NULL,NULL,NULL
        FROM telemetry_usage_correction_runtime runtime
        ${batched?'CROSS JOIN selection_scopes wanted':''}
       WHERE runtime.id=1 AND runtime.schema_version='telemetry-usage-correction-v1'
         AND runtime.method_version='usage-total-correction-v1'
         AND runtime.max_capture_rows BETWEEN 1 AND 200
         AND runtime.max_history_page BETWEEN 1 AND 200
         ${useDayCatalog?EFFECTIVE_DAY_CATALOG_RUNTIME_FENCE:''}
    )
    SELECT ${target()}family,occurrence_id,source_day,record_day,observed_at_ms,source_key,source_digest,canonical_digest,
      record_digest,base_digest,history_fact_count,max_history_id,max_fact_id
      FROM fenced_headers ORDER BY ${target()}family,source_day,source_key LIMIT ?`)
    .bind(owner.ownerDigest,owner.participantId,sourceNamespace,fromDay,throughDay,
      Date.parse(`${fromDay}T00:00:00.000Z`),Date.parse(`${throughDay}T00:00:00.000Z`)+DAY_MS,ownerDigestBlob,
      ...(selectedDays?[JSON.stringify(selectedDays.map(day=>[day,Date.parse(day),Date.parse(day)+DAY_MS]))]:[]),
      MAX_EFFECTIVE_DEPENDENCY_ROWS+(selectedDays?.length??1)+1).all<Record<string,unknown>>()).results;
  const runtimeRows=rows.filter(row=>row.family==='__correction_runtime__');
  const expectedDays=selectedDays??[fromDay];
  if(batched&&rows.length>MAX_EFFECTIVE_DEPENDENCY_ROWS
    &&runtimeRows.length<expectedDays.length)return undefined;
  if(runtimeRows.length!==expectedDays.length || runtimeRows.some((row,index)=>
    (row.source_digest!=='staged'&&row.source_digest!=='active')
      ||(batched&&row.target_day!==expectedDays[index])
      ||(!batched&&'target_day' in row)))throw fail();
  const correctionRuntime=runtimeRows[0]!.source_digest as EffectiveHistoryDependency['correctionRuntime'];
  if(runtimeRows.some(row=>row.source_digest!==correctionRuntime))throw fail();
  const links=rows.filter(row=>row.family!=='__correction_runtime__');
  // The aggregate is optional: a batch too large for one bounded result must
  // not make an otherwise valid singleton dependency unavailable.
  if(batched&&(links.length>MAX_EFFECTIVE_DEPENDENCY_ROWS
    ||bytes(canonicalJson(links))>MAX_EFFECTIVE_DEPENDENCY_BYTES))return undefined;
  if(links.length>MAX_EFFECTIVE_DEPENDENCY_ROWS)throw fail();
  return {rows:dependencyRows(links),correctionRuntime};
}

function validateDependencyScope(owner:StorageCommunityOwner,sourceNamespace:string,fromDay:string,throughDay:string):void {
  validDependencyDay(fromDay);validDependencyDay(throughDay);
  if(throughDay<fromDay||owner.participantId.length<1||owner.participantId.length>256
    ||!owner.ownerDigest||!/^[a-f0-9]{64}$/u.test(owner.ownerDigest)
    ||typeof sourceNamespace!=='string'||sourceNamespace.length<1||sourceNamespace.length>256)throw fail();
}
type EffectiveHistoryHeaders=Pick<EffectiveHistoryDependency,'correctionRuntime'|'v1'|'v11'|'v12'|'corrections'>;
interface EffectiveHistoryHeaderSnapshot extends EffectiveHistoryHeaders { v12Available:boolean;dayCatalogAvailable:boolean }

async function readCorrectionRuntime(source:D1Database):Promise<EffectiveHistoryDependency['correctionRuntime']>{
  const result=await source.prepare(`SELECT id,schema_version,method_version,state,
      max_capture_rows,max_history_page FROM telemetry_usage_correction_runtime LIMIT 2`)
    .all<{id:number;schema_version:string;method_version:string;state:string;
      max_capture_rows:number;max_history_page:number}>();
  if(result.success!==true||!Array.isArray(result.results)||result.results.length!==1)throw fail();
  const row=result.results[0]!;
  if(row.id!==1||row.schema_version!=='telemetry-usage-correction-v1'
    ||row.method_version!=='usage-total-correction-v1'
    ||(row.state!=='staged'&&row.state!=='active')
    ||!Number.isSafeInteger(row.max_capture_rows)||row.max_capture_rows<1||row.max_capture_rows>200
    ||!Number.isSafeInteger(row.max_history_page)||row.max_history_page<1||row.max_history_page>200)throw fail();
  return row.state;
}

/** The same header queries serve the authoritative window reader and the
 * optional multi-day snapshot. The latter shares one aggregate bound across
 * all vectors; exceeding it leaves callers on their exact per-day path. */
async function readEffectiveHistoryHeaders(source:D1Database,owner:StorageCommunityOwner,
  sourceNamespace:string,fromDay:string,throughDay:string,includeSessions:boolean,
  optionalAggregate=false,canContinue?:()=>boolean):Promise<EffectiveHistoryHeaderSnapshot|undefined>{
  const fromMs=Date.parse(`${fromDay}T00:00:00.000Z`),throughExclusive=Date.parse(`${throughDay}T00:00:00.000Z`)+DAY_MS;
  const sourceStreams=includeSessions?"('usage','quota','session')":"('usage','quota')";
  let totalRows=0,totalBytes=bytes(canonicalJson({v1:[],v11:[],v12:[],corrections:[]}));
  const rowLimit=()=>optionalAggregate?MAX_EFFECTIVE_DEPENDENCY_ROWS-totalRows+1:MAX_EFFECTIVE_DEPENDENCY_ROWS+1;
  const accept=(rows:readonly Record<string,unknown>[],vectorLimit=MAX_EFFECTIVE_DEPENDENCY_ROWS):boolean=>{
    if(rows.length>vectorLimit){if(optionalAggregate)return false;throw fail();}
    if(!optionalAggregate)return true;
    totalRows+=rows.length;
    if(totalRows>MAX_EFFECTIVE_DEPENDENCY_ROWS)return false;
    // Replace one empty vector's two brackets in the aggregate encoding.
    totalBytes+=bytes(canonicalJson(rows))-2;
    return totalBytes<=MAX_EFFECTIVE_DEPENDENCY_BYTES;
  };
  if(optionalAggregate&&canContinue?.()===false)return undefined;
  const {v12Available,dayCatalogAvailable}=await dependencySchemas(source);
  if(optionalAggregate&&canContinue?.()===false)return undefined;
  const v1=(await source.prepare(`SELECT c.id,c.device_id,c.stream,c.chunk_day,c.chunk_seq,c.revision,
      c.chunk_digest,c.accepted_record_count
    FROM telemetry_v1_chunks c
    JOIN typed_v1_event_sources event ON event.chunk_id=c.id
      AND event.owner_digest=? AND event.source_namespace=?
    WHERE c.participant_id=? AND c.stream IN ${sourceStreams} AND c.superseded_at IS NULL AND c.accepted_record_count=c.record_count
      AND c.accepted_record_count>0 AND c.chunk_day>=? AND c.chunk_day<=?
    ORDER BY c.chunk_day,c.device_id,c.stream,c.chunk_seq,c.id LIMIT ?`)
    .bind(owner.ownerDigest,sourceNamespace,owner.participantId,fromDay,throughDay,rowLimit())
    .all<Record<string, unknown>>()).results;
  if(!accept(v1))return undefined;
  if(optionalAggregate&&canContinue?.()===false)return undefined;
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
    .bind(owner.participantId,owner.ownerDigest,fromDay,throughDay,rowLimit())
    .all<Record<string, unknown>>()).results;
  if(!accept(v11))return undefined;
  let v12:Record<string, unknown>[]=[];
  if(v12Available){
    if(optionalAggregate&&canContinue?.()===false)return undefined;
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
      .bind(owner.participantId,fromDay,throughDay,rowLimit())
      .all<Record<string, unknown>>()).results;
  }
  if(!accept(v12))return undefined;
  if(optionalAggregate&&canContinue?.()===false)return undefined;
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
    ORDER BY event_day LIMIT ?`)
    .bind(owner.participantId,owner.ownerDigest,fromMs,throughExclusive,Math.min(102,rowLimit()))
    .all<Record<string, unknown>>()).results;
  if(!accept(corrections,101))return undefined;
  if(optionalAggregate&&canContinue?.()===false)return undefined;
  const correctionRuntime=await readCorrectionRuntime(source);
  return {v1,v11,v12,corrections,v12Available,dayCatalogAvailable,correctionRuntime};
}

function assembleEffectiveHistoryDependency(owner:StorageCommunityOwner,fromDay:string,throughDay:string,
  includeSessions:boolean,headers:EffectiveHistoryHeaders,occurrenceLinks:readonly Record<string,unknown>[]):EffectiveHistoryDependency {
  const {correctionRuntime,v1,v11,v12,corrections}=headers;
  const streams=Object.freeze((includeSessions?['quota','session','usage']:['quota','usage']) as ('quota'|'session'|'usage')[]);
  const dependency={version:'effective-history-dependency-v3' as const,participantId:owner.participantId,
    correctionRuntime,
    fromDay,throughDay,streams,v1:dependencyRows(v1),v11:dependencyRows(v11),v12:dependencyRows(v12),
    corrections:dependencyRows(corrections),occurrenceLinks:dependencyRows(occurrenceLinks)};
  if(bytes(canonicalJson(dependency))>MAX_EFFECTIVE_DEPENDENCY_BYTES)throw fail();
  return Object.freeze(dependency);
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
  validateDependencyScope(owner,sourceNamespace,fromDay,throughDay);
  if(!options||typeof options!=='object'||Array.isArray(options))throw fail();
  const includeSessions=options.includeSessions===true;
  if(Object.keys(options).some(key=>key!=='includeSessions'))throw fail();
  const headers=await readEffectiveHistoryHeaders(source,owner,sourceNamespace,fromDay,throughDay,includeSessions);
  if(!headers)throw fail();
  const occurrenceLinks=await effectiveHistoryOccurrenceLinks(source,owner,sourceNamespace,fromDay,throughDay,headers.v12Available,includeSessions,undefined,headers.dayCatalogAvailable);
  if(!occurrenceLinks)throw fail();
  if(occurrenceLinks.correctionRuntime!==headers.correctionRuntime)throw fail();
  return assembleEffectiveHistoryDependency(owner,fromDay,throughDay,includeSessions,headers,occurrenceLinks.rows);
}

/** Share bounded immutable headers across selected days while preserving each
 * day's exact occurrence-link expansion. Optional batches carry a target day
 * through every join: another selected day is still outside THIS dependency.
 * Callers keep the existing owner fences around this snapshot and its reads. */
export async function createEffectiveHistoryDayDependencyReader(source:D1Database,owner:StorageCommunityOwner,
  sourceNamespace:string,days:readonly string[],
  options:{includeSessions?:boolean;canContinue?:()=>boolean;occurrenceLinks?:'per-day'|'batched'}={}):Promise<{
    readDigest(day:string):Promise<string|undefined>;
  }|undefined>{
  if(!Array.isArray(days)||days.length>101||!options||typeof options!=='object'||Array.isArray(options)
    ||Object.keys(options).some(key=>key!=='includeSessions'&&key!=='canContinue'&&key!=='occurrenceLinks')
    ||(options.occurrenceLinks!==undefined&&options.occurrenceLinks!=='per-day'&&options.occurrenceLinks!=='batched')
    ||(options.canContinue!==undefined&&typeof options.canContinue!=='function'))throw fail();
  if(days.some((day,index)=>typeof day!=='string'||(index>0&&days[index-1]!>=day)))throw fail();
  for(const day of days)validDependencyDay(day);
  const fromDay=days[0]??'1970-01-01',throughDay=days.at(-1)??fromDay;
  validateDependencyScope(owner,sourceNamespace,fromDay,throughDay);
  if(Date.parse(throughDay)-Date.parse(fromDay)>100*DAY_MS)throw fail();
  if(options.canContinue?.()===false)return undefined;
  if(days.length===0)return {readDigest:async()=>{throw fail();}};
  const includeSessions=options.includeSessions===true;
  const selected=new Map(days.map(day=>[day,{v1:[],v11:[],v12:[],corrections:[]} as {
    v1:Record<string,unknown>[];v11:Record<string,unknown>[];v12:Record<string,unknown>[];corrections:Record<string,unknown>[];
  }]));
  const headers=await readEffectiveHistoryHeaders(source,owner,sourceNamespace,fromDay,throughDay,
    includeSessions,true,options.canContinue);
  if(!headers)return undefined;
  for(const [family,column] of [['v1','chunk_day'],['v11','observed_day'],['v12','observed_day'],['corrections','event_day']] as const){
    for(const row of headers[family]){
      const day=row[column];
      if(typeof day!=='string')throw fail();
      // The SQL orders each family by day and then by its immutable source
      // coordinates. Appending to the partition preserves that exact order.
      selected.get(day)?.[family].push(row);
    }
  }
  const {v12Available,dayCatalogAvailable}=headers;
  const selectedDays=[...days];
  const oversizedBlocks=new Set<number>();
  let blockIndex=-1;
  let blockLinks=new Map<string,readonly Record<string,unknown>[]>();
  const readDigest=async(day:string):Promise<string|undefined>=>{
    const dayHeaders=selected.get(day);if(!dayHeaders)throw fail();
    if(options.canContinue?.()===false)return undefined;
    let links:readonly Record<string,unknown>[]|undefined;
    if(options.occurrenceLinks==='batched'){
      const index=Math.floor(selectedDays.indexOf(day)/EFFECTIVE_DEPENDENCY_BATCH_DAYS);
      let loadedBlock=false;
      if(index!==blockIndex){
        // Retain only one bounded block. Concurrent calls are serialized below
        // so two block loads cannot transiently accumulate retained results.
        blockLinks.clear();blockIndex=-1;
        if(!oversizedBlocks.has(index)){
          const block=selectedDays.slice(index*EFFECTIVE_DEPENDENCY_BATCH_DAYS,(index+1)*EFFECTIVE_DEPENDENCY_BATCH_DAYS);
          const rows=await effectiveHistoryOccurrenceLinks(source,owner,sourceNamespace,
            block[0]!,block.at(-1)!,v12Available,includeSessions,block);
          if(options.canContinue?.()===false)return undefined;
          if(rows){
            if(rows.correctionRuntime!==headers.correctionRuntime)return undefined;
            const partition=new Map(block.map(targetDay=>[targetDay,[] as Record<string,unknown>[]]));
            for(const row of rows.rows){
              const {target_day:targetDay,...dependency}=row;
              if(typeof targetDay!=='string'||!partition.has(targetDay))throw fail();
              partition.get(targetDay)!.push(dependency);
            }
            blockLinks=new Map([...partition].map(([targetDay,values])=>[targetDay,dependencyRows(values)]));
            blockIndex=index;
            loadedBlock=true;
          }else oversizedBlocks.add(index);
        }
      }
      links=blockLinks.get(day);
      // A block can be read over several asynchronous consumer steps. The
      // first day was fenced by its link query; later days must not reuse its
      // staged identity after the one-way correction runtime activation.
      if(links&&!loadedBlock&&headers.correctionRuntime==='staged'
        &&await readCorrectionRuntime(source)!==headers.correctionRuntime)
        return undefined;
    }
    if(!links){
      if(options.canContinue?.()===false)return undefined;
      const snapshot=await effectiveHistoryOccurrenceLinks(source,owner,sourceNamespace,day,day,v12Available,includeSessions,undefined,dayCatalogAvailable);
      if(snapshot?.correctionRuntime!==headers.correctionRuntime)return undefined;
      links=snapshot?.rows;
    }
    if(!links)throw fail();
    if(options.canContinue?.()===false)return undefined;
    return sha256Hex(canonicalJson(assembleEffectiveHistoryDependency(owner,day,day,includeSessions,
      {...dayHeaders,correctionRuntime:headers.correctionRuntime},links)));
  };
  let pending:Promise<unknown>=Promise.resolve();
  return {readDigest(day:string){
    if(options.occurrenceLinks!=='batched')return readDigest(day);
    const result=pending.then(()=>readDigest(day));
    pending=result.then(()=>undefined,()=>undefined);
    return result;
  }};
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
  /** Complete source-validated days only; missing coverage keeps the paged
   * calculation. Preparation piggybacks on any quota acquisition scan. */
  preparedQuota?:{
    load(days:readonly string[],identity:V11QuotaAcquisitionIdentity):Promise<readonly EffectiveQuotaDay[]|undefined>;
    store(day:EffectiveQuotaDay):Promise<'stored'|'deferred'>;
    /** Only a source-validated stale head or a missing head may open a gap. */
    nextMissingDay?:(eligibleDays:readonly string[],excludedDays:readonly string[])=>Promise<string|undefined>;
    /** Called only at a day boundary, before accumulating a complete day. */
    shouldPrepare?:(day:string)=>Promise<boolean>;
    /** A costly cache miss leaves room for one deterministic page/save. */
    preferSinglePageCheckpoint?:()=>boolean;
  };
  preparedUsage?:StorageEffectiveUsagePreparation;
  /** Complete durable ordered features; caller isolates its checkpoint key. */
  preparedUsageReader?:import('./quota-analysis-v11').V11PreparedUsageReader;
  /** The durable group boundary is the only place to start a cache-only step. */
  allowQuotaCoverage?:boolean;
  budget:{remainingQueries:number;deadlineMs:number;now?:()=>number};
}):Promise<{status:'deferred';checkpoint:StorageEffectiveHistoryCheckpoint|null;quotaCoverageStep?:true;usagePreparationStep?:true}|{status:'complete';analysis:object}>{
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
  if(checkpoint?.phase==='acquisition'&&checkpoint.preparingQuota!==undefined
    &&(!validEffectiveQuotaDayPending(checkpoint.preparingQuota)
      ||checkpoint.acquisition.phase!==checkpoint.effectiveCursor.phase||checkpoint.effectiveCursor.complete
      ||checkpoint.preparingQuota.day!==checkpoint.effectiveCursor.day
      ||checkpoint.preparingQuota.quotaRowsRead>checkpoint.effectiveCursor.ordinal))throw fail();
  if(checkpoint?.quotaCoverage!==undefined&&!validEffectiveQuotaCoverage(checkpoint.quotaCoverage,
    checkpoint.effectiveDays.quota,checkpoint.phase,checkpoint.phase==='acquisition'?checkpoint.preparingQuota:undefined))throw fail();
  if(checkpoint?.usagePreparation!==undefined&&(input.metric!=='model'
    ||!validEffectiveUsagePreparation(checkpoint.usagePreparation,checkpoint)))throw fail();
  if(!checkpoint){
    const inventory={sourceNamespace:input.sourceNamespace,ownerDigest:owner.ownerDigest,
      ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,fromDay:pin.fromDay,throughDay:pin.throughDay};
    const quota=await readEffectiveTelemetryOwnerDays(source,{...inventory,stream:'quota'});
    const usage=await readEffectiveTelemetryOwnerDays(source,{...inventory,stream:'usage'});
    checkpoint={version:1,source:'effective',day:input.day,layout,identity,phase:'acquisition',effectiveDays:{quota,usage},
      effectiveCursor:{phase:'plan',day:quota[0]??pin.throughDay,after:null,ordinal:0,complete:quota.length===0},
      acquisition:createV11QuotaAcquisitionCheckpoint(identity)};
  }
  const read=(day:string,stream:'quota'|'usage',after?:EffectiveUsageReaderCursor,limit=200)=>
    readEffectiveTelemetryOwnerDayPage(source,{sourceNamespace:input.sourceNamespace,
      ownerDigest:owner.ownerDigest,ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,
      day,stream,limit,...(after?{after}:{})});
  let coverage=checkpoint.quotaCoverage;
  const refused=(day:string):EffectiveQuotaCoverage=>({next:'analysis',pending:null,
    refusedDays:[...new Set([...(coverage?.refusedDays??[]),day])].sort()});
  const coverageFields=(phase:StorageEffectiveHistoryCheckpoint['phase'])=>
    coverage&&(phase==='acquisition'||coverage.pending?.state==='ready')?{quotaCoverage:coverage}:{};
  // Cache writes may span invocations. Both inline and gap preparation first
  // checkpoint the reduced complete day, so retrying a write never needs to
  // rescan that day or change the analytical cursor.
  if(input.preparedQuota&&coverage?.pending?.state==='ready'){
    if(input.allowQuotaCoverage===false)return {status:'deferred',checkpoint:null};
    if(await input.preparedQuota.store(coverage.pending.day)==='stored')
      coverage={...coverage,next:'analysis',pending:null};
    else return {status:'deferred',checkpoint:null};
    await assertEffectiveHistoryOwner(source,owner);
    const {quotaCoverage:_,...withoutCoverage}=checkpoint;
    checkpoint={...withoutCoverage,...coverageFields(checkpoint.phase)};
    // The completed day and analytical cursor already have a durable head.
    // Combine clearing that buffer with useful analytical/fold progress. If
    // the write used this slice's headroom, keep the old ready head; replay
    // merely confirms the idempotent cache write before trying again.
    if(budget.remainingQueries<120||now()>=budget.deadlineMs)return {status:'deferred',checkpoint:null};
  }
  if(checkpoint.phase==='acquisition'){
    const acquisition=checkpoint.acquisition;
    if(input.preparedQuota){
      const prepared=await input.preparedQuota.load(checkpoint.effectiveDays.quota,identity);
      const folded=prepared===undefined?undefined:foldEffectiveQuotaDays(identity,prepared,checkpoint.effectiveDays.quota);
      if(folded!==undefined){
        await assertEffectiveHistoryOwner(source,owner);
        if(folded.status==='not_testable')return {status:'complete',analysis:input.metric==='fits'
          ?{schemaVersion:'account-scoped-quota-analysis-v0.1',status:'not_testable',reason:folded.reason,tracks:[]}
          :{status:'not_testable',reason:folded.reason,tracks:[]}};
        if(folded.status!=='complete')throw fail();
        return {status:'deferred',checkpoint:{version:1,source:'effective',day:input.day,layout,identity,
          effectiveDays:checkpoint.effectiveDays,effectiveCursor:checkpoint.effectiveCursor,
          phase:'finish',acquisition:{identity,planAnchors:folded.planAnchors,quotaRows:folded.quotaRows}}};
      }
      if(budget.remainingQueries<120||now()>=budget.deadlineMs)return {status:'deferred',checkpoint:null};
    }
    const cursor=structuredClone(checkpoint.effectiveCursor);
    let preparingQuota=input.preparedQuota?checkpoint.preparingQuota:undefined;
    if(cursor.phase!==acquisition.phase){Object.assign(cursor,{phase:acquisition.phase,day:checkpoint.effectiveDays.quota[0]??pin.throughDay,
      after:null,ordinal:0,complete:checkpoint.effectiveDays.quota.length===0});}
    if(input.preparedQuota&&input.allowQuotaCoverage!==false&&preparingQuota===undefined
      &&coverage?.next!=='analysis'){
      // Days still ahead will be prepared by the normal scan. Only fill its
      // missed prefix (including an adopted midpoint) independently.
      const eligible=checkpoint.effectiveDays.quota.filter(day=>day<cursor.day
        ||day===cursor.day&&(cursor.after!==null||cursor.complete));
      const gap=coverage?.pending?.state==='reading'?coverage.pending:null;
      const day=gap?.quota.day??await input.preparedQuota.nextMissingDay?.(eligible,coverage?.refusedDays??[]);
      if(day!==undefined){
        if(!checkpoint.effectiveDays.quota.includes(day)||(gap===null&&!eligible.includes(day)))throw fail();
        const page=await read(day,'quota',gap?.after??undefined);
        let ordinal=gap?.quota.quotaRowsRead??0;
        const rows=page.rows.map(row=>mapEffectiveQuotaPageRow(row,day,++ordinal));
        const pending=appendEffectiveQuotaDay(gap?.quota??null,day,rows,identity.windowMinutes);
        const prepared=pending!==null&&page.next===null?finishEffectiveQuotaDay(pending):undefined;
        coverage=pending===null||page.next===null&&prepared===undefined?refused(day):{
          next:'analysis',refusedDays:coverage?.refusedDays??[],pending:page.next===null
            ?{state:'ready',day:prepared!}:{state:'reading',quota:pending!,after:page.next}};
        await assertEffectiveHistoryOwner(source,owner);
        return {status:'deferred',checkpoint:{...checkpoint,quotaCoverage:coverage},quotaCoverageStep:true};
      }
    }
    const reader:V11QuotaPageReader={pageSize:200,effective:{complete:()=>cursor.complete},
      async readPage(){
        if(cursor.complete)return [];
        // An adopted job may begin halfway through a day. Wait for the next
        // boundary: later acquisition phases rewind and can fill that prefix.
        // The reducer filters phase-specific rows only after this reader, so
        // each phase can prepare the same complete, unfiltered day.
        const prepare=!!input.preparedQuota&&!coverage?.pending&&!coverage?.refusedDays.includes(cursor.day)
          &&(preparingQuota!==undefined||cursor.after===null
          &&(await input.preparedQuota.shouldPrepare?.(cursor.day)??true));
        const page=await read(cursor.day,'quota',cursor.after??undefined);
        const rows:V11QuotaPageRow[]=page.rows.map(row=>mapEffectiveQuotaPageRow(row,cursor.day,++cursor.ordinal));
        if(prepare&&input.preparedQuota){
          preparingQuota=appendEffectiveQuotaDay(preparingQuota??null,cursor.day,rows,identity.windowMinutes)??undefined;
          if(preparingQuota===undefined)coverage=refused(cursor.day);
          if(page.next===null&&preparingQuota){
            const prepared=finishEffectiveQuotaDay(preparingQuota);
            coverage=prepared?{next:'prepare',refusedDays:coverage?.refusedDays??[],pending:{state:'ready',day:prepared}}
              :refused(cursor.day);
            preparingQuota=undefined;
          }
        }
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
    if(step.status==='not_testable'&&coverage?.pending?.state==='ready'){
      const {preparingQuota:_,...withoutInline}=checkpoint;
      return {status:'deferred',checkpoint:{...withoutInline,quotaCoverage:coverage},quotaCoverageStep:true};
    }
    if(step.status==='not_testable')return {status:'complete',analysis:input.metric==='fits'
      ?{schemaVersion:'account-scoped-quota-analysis-v0.1',status:'not_testable',reason:step.reason,tracks:[]}
      :{status:'not_testable',reason:step.reason,tracks:[]}};
    if(coverage&&coverage.pending?.state!=='ready')coverage={...coverage,next:'prepare'};
    const nextPhase=step.status==='deferred'?'acquisition':'finish';
    const base={version:1 as const,source:'effective' as const,day:input.day,layout,identity,effectiveCursor:cursor,
      effectiveDays:checkpoint.effectiveDays,...coverageFields(nextPhase)};
    return {status:'deferred',checkpoint:step.status==='deferred'
      ?{...base,phase:'acquisition',acquisition:step.checkpoint,
        ...(step.checkpoint.phase===cursor.phase&&preparingQuota?{preparingQuota}:{})}
      :{...base,phase:'finish',acquisition:{identity,planAnchors:step.planAnchors,quotaRows:step.quotaRows}}};
  }
  const days=checkpoint.effectiveDays.usage;
  const options={nowMs:input.nowMs,sourcePin:pin,quotaAcquisition:checkpoint.acquisition,
    ...(input.preparedUsageReader?{preparedUsageReader:input.preparedUsageReader}:{}),
    scalarRequested:input.metric==='fits',effectiveUsageReader:{days,async readPage(cursor:{day:string;afterTime:string;afterOccurrence:string}){
      const page=await read(cursor.day,'usage',cursor.afterOccurrence?{
        observedAtMs:Date.parse(cursor.afterTime),occurrenceId:cursor.afterOccurrence}:undefined);
      const rows=page.rows.map(mapEffectiveUsagePageRow);
      return {rows,complete:page.next===null};
    }}};
  const prior=checkpoint.phase==='usage'?checkpoint.usage:null;
  if(prior?.complete){const analysis=await finishV11UsageReduction(source,pin,options,prior,input.metric,identity);
    await assertEffectiveHistoryOwner(source,owner);return {status:'complete',analysis};}
  let preparation=checkpoint.usagePreparation;
  if(input.metric==='model'&&input.preparedUsage&&preparation?.state!=='disabled'){
    // A new day or cache write begins only at a durable group boundary. Small
    // reading buffers may share the ordinary four-page checkpoint group; an
    // adopted analytical reduction remains available if any day refuses.
    if(input.allowQuotaCoverage===false&&preparation?.state!=='reading')return {status:'deferred',checkpoint:null};
    if(preparation?.state==='ready'){
      if(await input.preparedUsage.store(preparation.day)==='deferred')return {status:'deferred',checkpoint:null};
      await assertEffectiveHistoryOwner(source,owner);
      preparation={state:'pending',rowsRead:preparation.rowsRead};
      if(budget.remainingQueries<120||now()>=budget.deadlineMs)return {status:'deferred',checkpoint:null};
    }
    const prepared=await input.preparedUsage.load(days);
    if(prepared!==undefined){
      const usage=await foldV11UsageModelReduction(source,pin,options,prepared.map(day=>day.projection),days,identity);
      await assertEffectiveHistoryOwner(source,owner);
      return {status:'deferred',checkpoint:{version:1,source:'effective',day:input.day,layout,identity,
        effectiveCursor:checkpoint.effectiveCursor,effectiveDays:checkpoint.effectiveDays,
        phase:'usage',acquisition:checkpoint.acquisition,usage},usagePreparationStep:true};
    }
    if(input.preparedUsage.refused())preparation={state:'disabled'};
    else {
      if(budget.remainingQueries<120||now()>=budget.deadlineMs)return {status:'deferred',checkpoint:null};
      const reading=preparation?.state==='reading'?preparation:undefined;
      const day=reading?.day.projection.day??await input.preparedUsage.nextMissingDay(days);
      if(day!==undefined){
        if(!days.includes(day))throw fail();
        // Bound all new preparation work across days and invocations. Compact
        // summaries must not permit a million dropped/same-cell source rows
        // to keep the exclusive preparation branch scanning indefinitely.
        if((preparation?.rowsRead??0)>=MAX_WINDOWED_USAGE_ROWS){
          return {status:'deferred',checkpoint:{...checkpoint,usagePreparation:{state:'disabled'}},usagePreparationStep:true};
        }
        const page=await read(day,'usage',reading?.after,Math.min(200,MAX_WINDOWED_USAGE_ROWS-(preparation?.rowsRead??0)));
        const rowsRead=(preparation?.rowsRead??0)+page.rows.length;
        const pending=rowsRead>MAX_WINDOWED_USAGE_ROWS?null:
          await appendEffectiveUsageDay(reading?.day??null,day,page.rows.map(mapEffectiveUsagePageRow),owner.ownerDigest);
        preparation=pending===null?{state:'disabled'}:page.next===null
          ?{state:'ready',rowsRead,day:{projection:pending.projection}}:{state:'reading',rowsRead,day:pending,after:page.next};
        await assertEffectiveHistoryOwner(source,owner);
        return {status:'deferred',checkpoint:{...checkpoint,usagePreparation:preparation},
          ...(preparation.state==='reading'?{}:{usagePreparationStep:true as const})};
      }
    }
  }else if(preparation!==undefined&&input.preparedUsage===undefined)preparation={state:'disabled'};
  const usage=await advanceV11UsageReduction(source,pin,options,
    {remainingQueries:2,deadlineMs:budget.deadlineMs,now},prior,1,identity);
  await assertEffectiveHistoryOwner(source,owner);
  return {status:'deferred',checkpoint:{version:1,source:'effective',day:input.day,layout,identity,
    effectiveCursor:checkpoint.effectiveCursor,effectiveDays:checkpoint.effectiveDays,phase:'usage',acquisition:checkpoint.acquisition,usage,
    ...(!usage.complete&&preparation?{usagePreparation:preparation}:{})}};
}
