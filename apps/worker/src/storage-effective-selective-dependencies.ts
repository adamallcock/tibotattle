import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { EFFECTIVE_DEPENDENCY_MUTATION_SCHEMA,readEffectiveDependencyMutationToken, type EffectiveDependencyMutationScope,
  type EffectiveDependencyMutationToken } from './storage-effective-dependency-mutations';
import { canonicalOccurrenceKey } from './canonical-analytics-facts';
import { decodeTypedTelemetryId } from './typed-telemetry-codec';
import { EFFECTIVE_DAY_CATALOG_TABLES,EFFECTIVE_DAY_CATALOG_TRIGGERS } from './storage-effective-dependency-days';
import {d1SchemaObjectHintsFor,readD1SchemaObjectsAvailable,type D1InvocationBudget} from './d1-invocation-budget';
import type {D1SchemaObject} from './d1-schema-object-hints';

export const EFFECTIVE_SELECTIVE_METHOD = 'effective-selective-v1';
export const EFFECTIVE_SELECTIVE_TABLES = ['runtime','bootstrap','owners','work','variants','reverse_work','days','ranges','effects']
  .map(suffix => `storage_effective_selective_${suffix}`);
// Generated once with the local forward migration; these names are a capability
// inventory, never a claim that partially applied migrations can be used.
export const EFFECTIVE_SELECTIVE_TRIGGERS: readonly string[] = [
  'storage_effective_selective_participants_update',
  'storage_effective_selective_participants_delete',
  'storage_effective_selective_device_credentials_insert',
  'storage_effective_selective_device_credentials_update',
  'storage_effective_selective_device_credentials_delete',
  'storage_effective_selective_storage_v11_owner_links_insert',
  'storage_effective_selective_storage_v11_owner_links_update',
  'storage_effective_selective_storage_v11_owner_links_delete',
  'storage_effective_selective_storage_owner_revisions_insert',
  'storage_effective_selective_storage_owner_revisions_update',
  'storage_effective_selective_storage_owner_revisions_delete',
  'storage_effective_selective_telemetry_v1_chunks_insert',
  'storage_effective_selective_telemetry_v1_chunks_update',
  'storage_effective_selective_telemetry_v1_chunks_delete',
  'storage_effective_selective_typed_v1_event_sources_insert',
  'storage_effective_selective_typed_v1_event_sources_update',
  'storage_effective_selective_typed_v1_event_sources_delete',
  'storage_effective_selective_typed_v1_owner_memberships_insert',
  'storage_effective_selective_typed_v1_owner_memberships_update',
  'storage_effective_selective_typed_v1_owner_memberships_delete',
  'storage_effective_selective_typed_v1_chunk_allocations_insert',
  'storage_effective_selective_typed_v1_chunk_allocations_update',
  'storage_effective_selective_typed_v1_chunk_allocations_delete',
  'storage_effective_selective_telemetry_v11_day_manifests_insert',
  'storage_effective_selective_telemetry_v11_day_manifests_update',
  'storage_effective_selective_telemetry_v11_day_manifests_delete',
  'storage_effective_selective_telemetry_v11_chunks_insert',
  'storage_effective_selective_telemetry_v11_chunks_update',
  'storage_effective_selective_telemetry_v11_chunks_delete',
  'storage_effective_selective_telemetry_v11_domains_update',
  'storage_effective_selective_telemetry_v11_domains_delete',
  'storage_effective_selective_telemetry_v11_domain_days_insert',
  'storage_effective_selective_telemetry_v11_domain_days_update',
  'storage_effective_selective_telemetry_v11_domain_days_delete',
  'storage_effective_selective_storage_v11_event_sources_insert',
  'storage_effective_selective_storage_v11_event_sources_update',
  'storage_effective_selective_storage_v11_event_sources_delete',
  'storage_effective_selective_typed_v11_owner_memberships_insert',
  'storage_effective_selective_typed_v11_owner_memberships_update',
  'storage_effective_selective_typed_v11_owner_memberships_delete',
  'storage_effective_selective_typed_v11_manifest_memberships_insert',
  'storage_effective_selective_typed_v11_manifest_memberships_update',
  'storage_effective_selective_typed_v11_manifest_memberships_delete',
  'storage_effective_selective_typed_v11_chunk_allocations_insert',
  'storage_effective_selective_typed_v11_chunk_allocations_update',
  'storage_effective_selective_typed_v11_chunk_allocations_delete',
  'storage_effective_selective_telemetry_v12_day_manifests_insert',
  'storage_effective_selective_telemetry_v12_day_manifests_update',
  'storage_effective_selective_telemetry_v12_day_manifests_delete',
  'storage_effective_selective_telemetry_v12_chunks_insert',
  'storage_effective_selective_telemetry_v12_chunks_update',
  'storage_effective_selective_telemetry_v12_chunks_delete',
  'storage_effective_selective_telemetry_v12_domains_update',
  'storage_effective_selective_telemetry_v12_domains_delete',
  'storage_effective_selective_telemetry_v12_domain_days_insert',
  'storage_effective_selective_telemetry_v12_domain_days_update',
  'storage_effective_selective_telemetry_v12_domain_days_delete',
  'storage_effective_selective_telemetry_v12_device_capabilities_insert',
  'storage_effective_selective_telemetry_v12_device_capabilities_update',
  'storage_effective_selective_telemetry_v12_device_capabilities_delete',
  'storage_effective_selective_accountless_v12_device_authorizations_insert',
  'storage_effective_selective_accountless_v12_device_authorizations_update',
  'storage_effective_selective_accountless_v12_device_authorizations_delete',
  'storage_effective_selective_accountless_upload_owners_insert',
  'storage_effective_selective_accountless_upload_owners_update',
  'storage_effective_selective_accountless_upload_owners_delete',
  'storage_effective_selective_accountless_v11_device_authorizations_insert',
  'storage_effective_selective_accountless_v11_device_authorizations_update',
  'storage_effective_selective_accountless_v11_device_authorizations_delete',
  'storage_effective_selective_telemetry_v11_device_consents_insert',
  'storage_effective_selective_telemetry_v11_device_consents_update',
  'storage_effective_selective_telemetry_v11_device_consents_delete',
  'storage_effective_selective_storage_source_state_insert',
  'storage_effective_selective_storage_source_state_update',
  'storage_effective_selective_storage_source_state_delete',
  'storage_effective_selective_typed_telemetry_schema_insert',
  'storage_effective_selective_typed_telemetry_schema_update',
  'storage_effective_selective_typed_telemetry_schema_delete',
  'storage_effective_selective_telemetry_usage_correction_runtime_insert',
  'storage_effective_selective_telemetry_usage_correction_runtime_update',
  'storage_effective_selective_telemetry_usage_correction_runtime_delete',
  'storage_effective_selective_telemetry_v12_runtime_insert',
  'storage_effective_selective_telemetry_v12_runtime_update',
  'storage_effective_selective_telemetry_v12_runtime_delete',
  'storage_effective_selective_ingestion_analytics_separation_insert',
  'storage_effective_selective_ingestion_analytics_separation_update',
  'storage_effective_selective_ingestion_analytics_separation_delete',
  'storage_effective_selective_collection_controls_insert',
  'storage_effective_selective_collection_controls_update',
  'storage_effective_selective_collection_controls_delete',
  'storage_effective_selective_accountless_enrollment_ledger_insert',
  'storage_effective_selective_accountless_enrollment_ledger_update',
  'storage_effective_selective_accountless_enrollment_ledger_delete',
  'storage_effective_selective_typed_v1_admission_state_insert',
  'storage_effective_selective_typed_v1_admission_state_update',
  'storage_effective_selective_typed_v1_admission_state_delete',
  'storage_effective_selective_typed_v11_admission_state_insert',
  'storage_effective_selective_typed_v11_admission_state_update',
  'storage_effective_selective_typed_v11_admission_state_delete',
  'storage_effective_selective_correction_fact_insert',
  'storage_effective_selective_correction_fact_delete',
  'storage_effective_selective_v12_record_delete',
  'storage_effective_selective_typed_v1_record_admissions_delete',
  'storage_effective_selective_typed_v11_record_proofs_delete',
  'storage_effective_selective_typed_record_delete',
  'storage_effective_selective_erase_storage_owner_revisions',
  'storage_effective_selective_erase_storage_v11_owner_links',
];
const fail = () => new Error('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const day = (value: string) => /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(value+'T00:00:00.000Z'))
  && new Date(value+'T00:00:00.000Z').toISOString().slice(0,10)===value;
const ACTIVE = `EXISTS(SELECT 1 FROM participants p JOIN storage_v11_owner_links l ON l.participant_id=p.id
  JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest
  WHERE p.id=? AND p.state='active' AND l.state='active' AND o.state='active')`;
const STABLE = `(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)=?`;

const EFFECTIVE_SELECTIVE_SCHEMA:readonly D1SchemaObject[]=Object.freeze([
  ...[...EFFECTIVE_SELECTIVE_TABLES,...EFFECTIVE_DAY_CATALOG_TABLES].map(name=>['table',name] as const),
  ...[...EFFECTIVE_SELECTIVE_TRIGGERS,'storage_effective_selective_sequence_guard',
    'storage_effective_selective_runtime_retained',...EFFECTIVE_DAY_CATALOG_TRIGGERS].map(name=>['trigger',name] as const),
  ...['storage_effective_selective_work_owner','storage_effective_selective_variant_day',
    'storage_effective_selective_variant_occurrence','storage_effective_selective_effect_order',
    'storage_effective_selective_typed_page','storage_effective_selective_v12_page','storage_effective_selective_correction_page',
    'storage_effective_selective_variant_key','storage_effective_selective_owner_pending'].map(name=>['index',name] as const),
]);
export async function effectiveSelectiveSchemaAvailable(source:D1Database):Promise<boolean> {
  return readD1SchemaObjectsAvailable(source,EFFECTIVE_SELECTIVE_SCHEMA);
}
export interface EffectiveScopeMutationScope extends EffectiveDependencyMutationScope {
  readonly fromDay: string; readonly throughDay: string; readonly includeSessions: boolean;
}
export interface EffectiveDependencyScopeBounds {
  readonly fromDay:string; readonly throughDay:string; readonly includeSessions:boolean;
}
/** All singleton/range tokens share one sealed source snapshot. Each scope
 * keeps its own day/range maxima, so one changed day cannot contaminate the
 * unaffected members of a bounded multi-day request. */
export async function readEffectiveScopeMutationTokens(source:D1Database,identity:EffectiveDependencyMutationScope,
  scopes:readonly EffectiveDependencyScopeBounds[]):Promise<readonly EffectiveDependencyMutationToken[]|undefined> {
  if(!Array.isArray(scopes)||scopes.length<1||scopes.length>132||scopes.some(scope=>!scope
    ||Object.keys(scope).sort().join(',')!=='fromDay,includeSessions,throughDay'
    ||!day(scope.fromDay)||!day(scope.throughDay)||scope.fromDay>scope.throughDay||typeof scope.includeSessions!=='boolean'))return;
  // Native source guards prove completeness/immutability and namespaces. The
  // conservative broad stamp is deliberately absent from the selective seal.
  const native=await readEffectiveDependencyMutationToken(source,identity);
  if(!native||!await effectiveSelectiveSchemaAvailable(source))return;
  const rows=(await source.prepare(`WITH covered AS MATERIALIZED (
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
      AND ${ACTIVE}
    ), scopes AS MATERIALIZED (SELECT CAST(key AS INTEGER) AS ordinal,json_extract(value,'$[0]') AS from_day,
      json_extract(value,'$[1]') AS through_day,json_extract(value,'$[2]') AS sessions FROM json_each(?6))
    SELECT s.ordinal,c.policyStamp,c.broadStamp,c.clockPhase,c.nextExpiry,
      coalesce((SELECT max(stamp) FROM storage_effective_selective_days WHERE participant_id=c.participant_id
        AND source_day BETWEEN s.from_day AND s.through_day AND (stream IN(1,2) OR s.sessions=1)),0) AS dayStamp,
      coalesce((SELECT max(stamp) FROM storage_effective_selective_ranges WHERE participant_id=c.participant_id
        AND from_day<=s.through_day AND through_day>=s.from_day),0) AS rangeStamp
    FROM covered c CROSS JOIN scopes s ORDER BY s.ordinal`)
    .bind(identity.participantId,identity.sourceNamespace,identity.ownerDigest,EFFECTIVE_SELECTIVE_METHOD,
      identity.participantId,JSON.stringify(scopes.map(scope=>[scope.fromDay,scope.throughDay,scope.includeSessions?1:0])))
    .all<{ordinal:number;policyStamp:number;broadStamp:number;clockPhase:number;nextExpiry:string|null;dayStamp:number;rangeStamp:number}>()).results;
  if(rows.length!==scopes.length)return;
  const result:EffectiveDependencyMutationToken[]=[];
  for(let i=0;i<rows.length;i++) {
    const {ordinal,nextExpiry,...stamps}=rows[i]!;
    const validUntilMs=Math.min(native.validUntilMs,nextExpiry===null?Number.MAX_SAFE_INTEGER:Date.parse(nextExpiry));
    if(ordinal!==i||!Object.values(stamps).every(integer)||!integer(validUntilMs)||validUntilMs<=Date.now())return;
    result.push(Object.freeze({stamp:await sha256Hex(canonicalJson([EFFECTIVE_SELECTIVE_METHOD,{...identity,...scopes[i]},stamps])),validUntilMs}));
  }
  return Object.freeze(result);
}
/** A negative or reusable proof requires complete source coverage. This is an
 * invalidation seal, not owner authority or permission to publish. */
export async function readEffectiveScopeMutationToken(source:D1Database,
  scope:EffectiveScopeMutationScope,context?:EffectiveDependencyReadContext):Promise<EffectiveDependencyMutationToken|undefined> {
  if(!scope||Object.keys(scope).sort().join(',')!=='fromDay,includeSessions,ownerDigest,participantId,sourceId,sourceNamespace,throughDay')return;
  const {fromDay,throughDay,includeSessions,...identity}=scope;
  if(context){
    const state=readContexts.get(context);
    if(!state||state.source!==source||canonicalJson(identity)!==state.identity
      ||!await effectiveDependencyReadContextCurrent(source,context,false))return;
    return state.tokens.get(canonicalJson({fromDay,throughDay,includeSessions}));
  }
  return (await readEffectiveScopeMutationTokens(source,identity,[{fromDay,throughDay,includeSessions}]))?.[0];
}

export interface EffectiveDependencyCoverageProgress {
  readonly status: 'unavailable'|'progress'|'complete'|'deferred';
  readonly steps: number; readonly sourceRows: number; readonly linkedDays: number;
  readonly statements: number;
}
export interface EffectiveDependencyCoverageOptions {
  readonly sourceId: string; readonly sourceNamespace: string;
  readonly participantId?: string;
  readonly maxSteps: number; readonly maxRows: number;
  readonly budget?: D1InvocationBudget;
}
interface Owner {participant_id:string;seeded:number;seed_day:string;owner_digest:string;source_namespace:string}
interface Work {id:number;from_day:string;through_day:string;stamp:number;day_cursor:string;family:number;row_cursor:number}
interface Variant {sourceRow:number;occurrence:number[];stream:number;observedAtMs:number;session:number[]|null;digest:number[]}
const blob=(v:readonly number[])=>new Uint8Array(v);

async function sequence(source:D1Database):Promise<number> {
  const value=await source.prepare('SELECT sequence FROM storage_effective_selective_runtime WHERE id=1 AND method=?')
    .bind(EFFECTIVE_SELECTIVE_METHOD).first<number>('sequence');
  if(!integer(value))throw fail();return value;
}
async function chooseOwner(source:D1Database,options:EffectiveDependencyCoverageOptions):Promise<{
  owner?:Owner;discoveryComplete:boolean;skipped:boolean;
}> {
  let discoveryComplete=true;
  if(options.participantId) {
    await source.prepare(`INSERT INTO storage_effective_selective_owners(participant_id)
      SELECT l.participant_id FROM storage_v11_owner_links l JOIN participants p ON p.id=l.participant_id
      JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest
      WHERE l.participant_id=? AND l.state='active' AND p.state='active' AND o.state='active'
      ON CONFLICT DO NOTHING`).bind(options.participantId).run();
  } else {
    const progress=await source.prepare('SELECT owner_cursor,complete FROM storage_effective_selective_bootstrap WHERE id=1')
      .first<{owner_cursor:string;complete:number}>();
    if(!progress)throw fail();
    if(!progress.complete) {
      // The native owner-digest UNIQUE index gives a bounded durable keyset.
      // New owners below this cursor are captured by their source seal triggers.
      const revision=await sequence(source);
      const page=(await source.prepare(`SELECT owner_digest,participant_id FROM storage_v11_owner_links
        WHERE owner_digest>? ORDER BY owner_digest LIMIT ?`).bind(progress.owner_cursor,options.maxRows)
        .all<{owner_digest:string;participant_id:string}>()).results;
      discoveryComplete=page.length<options.maxRows;
      const cursor=page.at(-1)?.owner_digest??progress.owner_cursor;
      await source.batch([
        source.prepare(`INSERT INTO storage_effective_selective_owners(participant_id)
          SELECT l.participant_id FROM json_each(?) j JOIN storage_v11_owner_links l ON l.owner_digest=j.value
          JOIN participants p ON p.id=l.participant_id JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest
          WHERE l.state='active' AND p.state='active' AND o.state='active' AND ${STABLE} ON CONFLICT DO NOTHING`)
          .bind(JSON.stringify(page.map(row=>row.owner_digest)),revision),
        source.prepare(`UPDATE storage_effective_selective_bootstrap SET owner_cursor=?,complete=?
          WHERE id=1 AND owner_cursor=? AND ${STABLE}`).bind(cursor,discoveryComplete?1:0,progress.owner_cursor,revision),
      ]);
      discoveryComplete=(await source.prepare('SELECT complete FROM storage_effective_selective_bootstrap WHERE id=1').first<number>('complete'))===1;
    }
  }
  const candidate=options.participantId
    ?source.prepare('SELECT participant_id FROM storage_effective_selective_owners WHERE participant_id=? AND needs_work=1').bind(options.participantId)
    :source.prepare('SELECT participant_id FROM storage_effective_selective_owners WHERE needs_work=1 ORDER BY participant_id LIMIT 1');
  const participantId=await candidate.first<string>('participant_id');
  if(!participantId)return {discoveryComplete,skipped:false};
  const row=await source.prepare(`SELECT c.participant_id,c.seeded,c.seed_day,l.owner_digest,c.source_namespace
    FROM storage_effective_selective_owners c JOIN storage_v11_owner_links l ON l.participant_id=c.participant_id
    JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest JOIN participants p ON p.id=c.participant_id
    WHERE c.participant_id=? AND l.state='active' AND o.state='active' AND p.state='active'`)
    .bind(participantId).first<Owner>();
  if(!row) {
    // Dormant owners cannot block the bounded queue. Reactivation source seals
    // mark them pending again; accepted history and catalog remain retained.
    await source.prepare(`UPDATE storage_effective_selective_owners SET needs_work=0 WHERE participant_id=?
      AND NOT (${ACTIVE})`).bind(participantId,participantId).run();
    return {discoveryComplete,skipped:true};
  }
  if(row.source_namespace!==''&&row.source_namespace!==options.sourceNamespace)throw fail();
  await source.prepare(`UPDATE storage_effective_selective_owners SET source_namespace=?,owner_digest=?
    WHERE participant_id=? AND (source_namespace='' OR source_namespace=?)`)
    .bind(options.sourceNamespace,row.owner_digest,row.participant_id,options.sourceNamespace).run();
  return {owner:{...row,source_namespace:options.sourceNamespace},discoveryComplete,skipped:false};
}
async function seed(source:D1Database,owner:Owner,revision:number,limit:number):Promise<void> {
  const rows=(await source.prepare(`SELECT DISTINCT source_day FROM storage_effective_source_days
    WHERE participant_id=? AND source_day>? ORDER BY source_day LIMIT ?`)
    .bind(owner.participant_id,owner.seed_day,limit).all<{source_day:string}>()).results;
  if(rows.some(row=>!day(row.source_day)))throw fail();
  const statements:D1PreparedStatement[]=[];
  if(rows.length)statements.push(source.prepare(`INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
    SELECT ?,value,value,? FROM json_each(?) WHERE ${STABLE} AND ${ACTIVE}
    ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=max(stamp,excluded.stamp)`)
    .bind(owner.participant_id,revision,JSON.stringify(rows.map(row=>row.source_day)),revision,owner.participant_id));
  statements.push(source.prepare(`UPDATE storage_effective_selective_owners SET seed_day=?,seeded=?
    WHERE participant_id=? AND seed_day=? AND ${STABLE}`)
    .bind(rows.at(-1)?.source_day??owner.seed_day,rows.length<limit?1:0,owner.participant_id,owner.seed_day,revision));
  await source.batch(statements);
}
async function variants(source:D1Database,owner:Owner,work:Work,selectedDay:string,limit:number):Promise<Variant[]> {
  const lo=Date.parse(selectedDay+'T00:00:00.000Z'),hi=lo+86400000;
  if(work.family===0)return (await source.prepare(`SELECT r.id AS sourceRow,r.occurrence_id AS occurrence,r.stream,
    r.observed_at_ms AS observedAtMs,i.value AS session,r.canonical_digest AS digest
    FROM typed_telemetry_records r LEFT JOIN typed_telemetry_usage u ON u.record_id=r.id
    LEFT JOIN typed_telemetry_identifiers i ON i.id=u.session_id
    WHERE r.owner_id IN(SELECT typed_owner_id FROM typed_v1_owner_memberships WHERE participant_id=?1
      UNION SELECT typed_owner_id FROM typed_v11_owner_memberships WHERE participant_id=?1)
      AND r.observed_day=?2 AND r.id>?3 ORDER BY r.id LIMIT ?4`)
    .bind(owner.participant_id,lo/86400000,work.row_cursor,limit).all<Variant>()).results;
  if(work.family===1)return (await source.prepare(`SELECT r.id AS sourceRow,r.occurrence_id AS occurrence,
    CASE r.stream WHEN 'usage' THEN 1 WHEN 'quota' THEN 2 ELSE 3 END AS stream,
    r.observed_at_ms AS observedAtMs,u.session_id AS session,r.canonical_digest AS digest
    FROM telemetry_v12_records r JOIN telemetry_v12_chunks c ON c.id=r.chunk_id
    LEFT JOIN telemetry_v12_usage u ON u.record_id=r.id
    WHERE c.participant_id=?1 AND r.observed_day=?2 AND r.id>?3 ORDER BY r.id LIMIT ?4`)
    .bind(owner.participant_id,lo/86400000,work.row_cursor,limit).all<Variant>()).results;
  if(work.family===2)return (await source.prepare(`SELECT h.id AS sourceRow,h.occurrence_id AS occurrence,1 AS stream,
    h.event_time_ms AS observedAtMs,i.value AS session,h.record_digest AS digest
    FROM telemetry_usage_correction_history h LEFT JOIN typed_telemetry_identifiers i ON i.id=h.session_id
    WHERE h.participant_id=?1 AND h.event_time_ms>=?2 AND h.event_time_ms<?3 AND h.id>?4 ORDER BY h.id LIMIT ?5`)
    .bind(owner.participant_id,lo,hi,work.row_cursor,limit).all<Variant>()).results;
  // Retain old locations after physical replacement/deletion. They only cause
  // conservative invalidation; erasure physically removes this catalog.
  return (await source.prepare(`SELECT id AS sourceRow,occurrence_id AS occurrence,stream,
    observed_at_ms AS observedAtMs,session_key AS session,variant_digest AS digest
    FROM storage_effective_selective_variants WHERE participant_id=? AND source_day=? AND id>?
    ORDER BY id LIMIT ?`).bind(owner.participant_id,selectedDay,work.row_cursor,limit).all<Variant>()).results;
}
async function advanceWork(source:D1Database,owner:Owner,work:Work,revision:number,limit:number):Promise<number> {
  const selectedDay=work.day_cursor||work.from_day;
  const rows=await variants(source,owner,work,selectedDay,limit);
  const statements:D1PreparedStatement[]=[];
  // JSON stores only integer BLOB encodings in a request-local bounded batch.
  // SQLite json_each cannot cast a hex string into a BLOB; bind byte buffers.
  for(const row of rows) {
    if(!integer(row.sourceRow)||!Number.isSafeInteger(row.observedAtMs)||![1,2,3].includes(row.stream))throw fail();
    if(work.family<3)statements.push(source.prepare(`INSERT INTO storage_effective_selective_variants
      (participant_id,family,source_row,occurrence_id,occurrence_key,stream,source_day,observed_at_ms,session_key,variant_digest)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${STABLE} AND ${ACTIVE} ON CONFLICT DO NOTHING`)
      .bind(owner.participant_id,work.family,row.sourceRow,blob(row.occurrence),await canonicalOccurrenceKey({sourceNamespace:owner.source_namespace,ownerDigest:owner.owner_digest,
          selectionMethod:'effective-union-v1'},row.stream===1?'usage':row.stream===2?'quota':'session',decodeTypedTelemetryId(blob(row.occurrence))),row.stream,selectedDay,
        row.observedAtMs,row.session===null?null:blob(row.session),blob(row.digest),revision,owner.participant_id));
    statements.push(source.prepare(`INSERT INTO storage_effective_selective_reverse_work(participant_id,occurrence_id,stamp)
      SELECT ?,?,? WHERE ${STABLE} AND ${ACTIVE}
      ON CONFLICT(participant_id,occurrence_id) DO UPDATE SET stamp=max(stamp,excluded.stamp),day_cursor=''
      WHERE excluded.stamp>stamp`).bind(owner.participant_id,blob(row.occurrence),work.stamp,revision,owner.participant_id));
  }
  const family=rows.length<limit?work.family+1:work.family;
  if(family<=3)statements.push(source.prepare(`UPDATE storage_effective_selective_work SET day_cursor=?,family=?,row_cursor=?
    WHERE id=? AND family=? AND row_cursor=? AND ${STABLE}`)
    .bind(selectedDay,family,family===work.family?(rows.at(-1)?.sourceRow??0):0,work.id,work.family,work.row_cursor,revision));
  else {
    const next=await source.prepare(`SELECT min(source_day) AS day FROM storage_effective_source_days
      WHERE participant_id=? AND source_day>? AND source_day<=?`).bind(owner.participant_id,selectedDay,work.through_day).first<{day:string|null}>();
    if(next?.day)statements.push(source.prepare(`UPDATE storage_effective_selective_work SET day_cursor=?,family=0,row_cursor=0
      WHERE id=? AND family=? AND row_cursor=? AND ${STABLE}`).bind(next.day,work.id,work.family,work.row_cursor,revision));
    else {
      statements.push(source.prepare(`INSERT INTO storage_effective_selective_ranges(participant_id,from_day,through_day,stamp)
        SELECT ?,?,?,? WHERE ${STABLE} AND ${ACTIVE} ON CONFLICT(participant_id,from_day,through_day)
        DO UPDATE SET stamp=max(stamp,excluded.stamp)`)
        .bind(owner.participant_id,work.from_day,work.through_day,work.stamp,revision,owner.participant_id));
      statements.push(source.prepare(`INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
        SELECT ?,?,?,0,? WHERE ${STABLE} AND ${ACTIVE} ON CONFLICT(participant_id,source_day,through_day,stream)
        DO UPDATE SET stamp=max(stamp,excluded.stamp)`)
        .bind(owner.participant_id,work.from_day,work.through_day,work.stamp,revision,owner.participant_id));
      statements.push(source.prepare(`DELETE FROM storage_effective_selective_work WHERE id=? AND family=? AND row_cursor=? AND ${STABLE}`)
        .bind(work.id,work.family,work.row_cursor,revision));
    }
  }
  await source.batch(statements);return rows.length;
}
async function reverse(source:D1Database,owner:Owner,revision:number,limit:number):Promise<number|undefined> {
  const work=await source.prepare(`SELECT occurrence_id AS occurrence,stamp,day_cursor FROM storage_effective_selective_reverse_work
    WHERE participant_id=? ORDER BY occurrence_id LIMIT 1`).bind(owner.participant_id)
    .first<{occurrence:number[];stamp:number;day_cursor:string}>();
  if(!work)return;
  const days=(await source.prepare(`SELECT DISTINCT source_day FROM storage_effective_selective_variants
    WHERE participant_id=? AND occurrence_id=? AND source_day>? ORDER BY source_day LIMIT ?`)
    .bind(owner.participant_id,blob(work.occurrence),work.day_cursor,limit).all<{source_day:string}>()).results;
  const encoded=JSON.stringify(days.map(row=>row.source_day));
  // Cross-stream matches follow the native v3 oracle conservatively. Every
  // affected day is stamped once per globally allocated source change.
  const statements=[source.prepare(`INSERT INTO storage_effective_selective_days(participant_id,source_day,stream,stamp)
    SELECT ?,d.value,s.value,? FROM json_each(?) d CROSS JOIN json_each('[1,2,3]') s
    WHERE ${STABLE} AND ${ACTIVE} ON CONFLICT(participant_id,source_day,stream) DO UPDATE SET stamp=max(stamp,excluded.stamp)`)
    .bind(owner.participant_id,work.stamp,encoded,revision,owner.participant_id),
    source.prepare(`INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
    SELECT ?,value,value,0,? FROM json_each(?) WHERE ${STABLE} AND ${ACTIVE}
    ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=max(stamp,excluded.stamp)`)
    .bind(owner.participant_id,work.stamp,encoded,revision,owner.participant_id)];
  if(days.length<limit)statements.push(source.prepare(`DELETE FROM storage_effective_selective_reverse_work
    WHERE participant_id=? AND occurrence_id=? AND stamp=? AND day_cursor=? AND ${STABLE}`)
    .bind(owner.participant_id,blob(work.occurrence),work.stamp,work.day_cursor,revision));
  else statements.push(source.prepare(`UPDATE storage_effective_selective_reverse_work SET day_cursor=?
    WHERE participant_id=? AND occurrence_id=? AND stamp=? AND day_cursor=? AND ${STABLE}`)
    .bind(days.at(-1)!.source_day,owner.participant_id,blob(work.occurrence),work.stamp,work.day_cursor,revision));
  await source.batch(statements);return days.length;
}
/** Bounded/resumable source catalog acquisition. Every statement uses the
 * caller's actual invocation meter, including metadata, backfill and writes. */
export async function advanceEffectiveDependencyCoverage(database:D1Database,
  options:EffectiveDependencyCoverageOptions):Promise<EffectiveDependencyCoverageProgress> {
  if(!options||!integer(options.maxSteps)||options.maxSteps<1||options.maxSteps>64
    ||!integer(options.maxRows)||options.maxRows<1||options.maxRows>128
    ||!options.sourceId||options.sourceId.length>256||!options.sourceNamespace||options.sourceNamespace.length>256)throw fail();
  const source=options.budget?.wrap(database)??database,started=options.budget?.queriesUsed??0;
  let steps=0,sourceRows=0,linkedDays=0;
  const result=(status:EffectiveDependencyCoverageProgress['status']):EffectiveDependencyCoverageProgress=>
    Object.freeze({status,steps,sourceRows,linkedDays,statements:(options.budget?.queriesUsed??started)-started});
  if(!await effectiveSelectiveSchemaAvailable(source))return result('unavailable');
  const runtime=await source.prepare(`SELECT s.source_id FROM storage_source_state s
    JOIN typed_v1_admission_state v1 ON v1.source_namespace=? AND v1.runtime_contract_version=1
    JOIN typed_v11_admission_state v11 ON v11.source_namespace=v1.source_namespace AND v11.runtime_contract_version=1
    WHERE s.singleton=1 AND s.source_id=?`).bind(options.sourceNamespace,options.sourceId).first();
  if(!runtime)return result('unavailable');
  while(steps<options.maxSteps) {
    const remaining=options.budget?.remainingQueries??1000;
    if(remaining<34)return result('deferred');
    // Worst case: two catalog/queue writes per acquired row, plus 24 fixed
    // statements. A whole atomic page must fit before acquisition begins.
    const limit=Math.min(options.maxRows,Math.floor((remaining-26)/2));
    const selected=await chooseOwner(source,options),owner=selected.owner;
    if(!owner) {
      if(selected.discoveryComplete&&!selected.skipped)return result('complete');
      steps++;continue;
    }
    const revision=await sequence(source);
    if(!owner.seeded)await seed(source,owner,revision,limit);
    else {
      const work=await source.prepare(`SELECT id,from_day,through_day,stamp,day_cursor,family,row_cursor
        FROM storage_effective_selective_work WHERE participant_id=? ORDER BY id LIMIT 1`)
        .bind(owner.participant_id).first<Work>();
      if(work)sourceRows+=await advanceWork(source,owner,work,revision,limit);
      else {
        const advanced=await reverse(source,owner,revision,limit);
        linkedDays+=advanced??0;
        if(advanced===undefined)await source.prepare(`UPDATE storage_effective_selective_owners SET needs_work=0
          WHERE participant_id=? AND seeded=1 AND ${STABLE}
            AND NOT EXISTS(SELECT 1 FROM storage_effective_selective_work WHERE participant_id=?)
            AND NOT EXISTS(SELECT 1 FROM storage_effective_selective_reverse_work WHERE participant_id=?)`)
          .bind(owner.participant_id,revision,owner.participant_id,owner.participant_id).run();
      }
    }
    steps++;
  }
  return result('progress');
}
export interface EffectiveDependencyAffectedRange {
  readonly participantId:string; readonly fromDay:string|null; readonly throughDay:string|null;
  readonly stream:'all'|'usage'|'quota'|'session'; readonly stamp:number;
}
/** P8 polls bounded rows and ACKs only after durable changed-work admission. */
export async function readEffectiveDependencyAffectedRanges(source:D1Database,limit=64):Promise<readonly EffectiveDependencyAffectedRange[]> {
  if(!integer(limit)||limit<1||limit>128)throw fail();
  if(!await effectiveSelectiveSchemaAvailable(source))return [];
  const rows=(await source.prepare(`SELECT participant_id AS participantId,source_day AS fromDay,through_day AS throughDay,
    stream,stamp FROM storage_effective_selective_effects ORDER BY stamp,participant_id,source_day,stream LIMIT ?`)
    .bind(limit).all<{participantId:string;fromDay:string;throughDay:string;stream:number;stamp:number}>()).results;
  return rows.map(row=>Object.freeze({...row,fromDay:row.fromDay||null,throughDay:row.throughDay||null,
    stream:row.stream===1?'usage':row.stream===2?'quota':row.stream===3?'session':'all'}));
}
export async function acknowledgeEffectiveDependencyAffectedRanges(source:D1Database,
  rows:readonly EffectiveDependencyAffectedRange[]):Promise<void> {
  if(!Array.isArray(rows)||rows.length>128||rows.some(row=>!row
    ||Object.keys(row).sort().join(',')!=='fromDay,participantId,stamp,stream,throughDay'
    ||typeof row.participantId!=='string'||!row.participantId||!integer(row.stamp)
    ||!['all','usage','quota','session'].includes(row.stream)
    ||!((row.fromDay===null&&row.throughDay===null)||(typeof row.fromDay==='string'&&typeof row.throughDay==='string'
      &&day(row.fromDay)&&day(row.throughDay)&&row.fromDay<=row.throughDay))))throw fail();
  if(!rows.length)return;
  await source.prepare(`DELETE FROM storage_effective_selective_effects AS e WHERE EXISTS(SELECT 1 FROM json_each(?) j
    WHERE e.participant_id=json_extract(j.value,'$[0]') AND e.source_day=json_extract(j.value,'$[1]')
      AND e.through_day=json_extract(j.value,'$[2]') AND e.stream=json_extract(j.value,'$[3]')
      AND e.stamp=json_extract(j.value,'$[4]'))`).bind(JSON.stringify(rows.map(row=>[row.participantId,
      row.fromDay??'',row.throughDay??'',row.stream==='usage'?1:row.stream==='quota'?2:row.stream==='session'?3:0,row.stamp]))).run();
}

/** Resolve an opaque analytics cursor against the covered private source
 * catalog. The caller retains only the canonical key and timestamp. */
export async function readEffectiveDependencyResumeCursor(source:D1Database,scope:EffectiveScopeMutationScope,
  stream:'usage'|'quota'|'session',occurrenceKey:string,observedAtMs:number,context?:EffectiveDependencyReadContext):Promise<{observedAtMs:number;occurrenceId:string}|undefined> {
  if(!['usage','quota','session'].includes(stream)||!/^[a-f0-9]{64}$/u.test(occurrenceKey)||!Number.isSafeInteger(observedAtMs))throw fail();
  const before=await readEffectiveScopeMutationToken(source,scope,context);if(!before)return;
  const rows=(await source.prepare(`SELECT DISTINCT occurrence_id AS occurrence FROM storage_effective_selective_variants
    WHERE participant_id=? AND occurrence_key=? AND observed_at_ms=? AND stream=?
      AND source_day BETWEEN ? AND ? LIMIT 2`).bind(scope.participantId,occurrenceKey,observedAtMs,
      stream==='usage'?1:stream==='quota'?2:3,scope.fromDay,scope.throughDay).all<{occurrence:number[]}>()).results;
  if(rows.length!==1)return;
  const after=await readEffectiveScopeMutationToken(source,scope,context);
  if(!after||after.stamp!==before.stamp||before.validUntilMs<=Date.now())return;
  return Object.freeze({observedAtMs,occurrenceId:decodeTypedTelemetryId(blob(rows[0]!.occurrence))});
}

/** Durable source-global work survives queue loss. The scheduler ACKs only
 * after bounded expansion has admitted all affected owners at this policy. */
export async function readEffectiveDependencyGlobalChange(source:D1Database):Promise<{stamp:number}|undefined> {
  if(!await effectiveSelectiveSchemaAvailable(source))return;
  const row=await source.prepare(`SELECT policy_stamp AS stamp FROM storage_effective_selective_runtime
    WHERE id=1 AND method=? AND policy_stamp>acknowledged_policy_stamp`).bind(EFFECTIVE_SELECTIVE_METHOD).first<{stamp:number}>();
  return row&&integer(row.stamp)?Object.freeze(row):undefined;
}
export async function acknowledgeEffectiveDependencyGlobalChange(source:D1Database,change:{stamp:number}):Promise<void> {
  if(!change||Object.keys(change).join(',')!=='stamp'||!integer(change.stamp))throw fail();
  await source.prepare(`UPDATE storage_effective_selective_runtime SET acknowledged_policy_stamp=policy_stamp
    WHERE id=1 AND method=? AND policy_stamp=?`).bind(EFFECTIVE_SELECTIVE_METHOD,change.stamp).run();
}

export interface EffectiveDependencySourceFence {
  readonly generation:number; readonly capabilityVersion:typeof EFFECTIVE_SELECTIVE_METHOD;
}
const SOURCE_FENCE_SCHEMA=Object.freeze([...EFFECTIVE_DEPENDENCY_MUTATION_SCHEMA,...EFFECTIVE_SELECTIVE_SCHEMA]);
/** Request-local fence only after full owner/scope/clock proof. D1 denies
 * SQLite schema_version, so this rechecks the SAME exact object-name/type
 * capability inventory as the full proof in one fixed metadata statement.
 * It is not a schema cookie, coverage proof or publication authorization. */
export async function readEffectiveDependencySourceFence(source:D1Database,capability?:'typed-v1-analysis'):Promise<EffectiveDependencySourceFence|undefined> {
  const schema:readonly D1SchemaObject[]=capability==='typed-v1-analysis'?[...SOURCE_FENCE_SCHEMA,
    ['table','typed_v1_analytical_schema'],['table','typed_v1_admission_state'],['table','typed_telemetry_schema']]:SOURCE_FENCE_SCHEMA;
  let row:EffectiveDependencySourceFence|null;
  try {
    const hints=d1SchemaObjectHintsFor(source,schema);
    if(hints){
      // Pay one full typed setup only when this operation can actually reuse
      // the parameters. Schema and runtime remain checked in the same SELECT.
      let guard=hints.atomicGuard(source,schema,2,3);
      if(guard.mode==='full_pairs'){
        if(!await hints.check(source,schema))return;
        guard=hints.atomicGuard(source,schema,2,3);
      }
      row=await source.prepare(`SELECT sequence AS generation,method AS capabilityVersion
        FROM storage_effective_selective_runtime WHERE id=1 AND method=?1 AND ${guard.predicateSql}`)
        .bind(EFFECTIVE_SELECTIVE_METHOD,guard.json,guard.expectedCount).first<EffectiveDependencySourceFence>();
    }else row=await source.prepare(`SELECT sequence AS generation,method AS capabilityVersion
      FROM storage_effective_selective_runtime WHERE id=1 AND method=?
      AND (SELECT count(*) FROM sqlite_schema s WHERE (s.type,s.name) IN(
        SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)))=?`)
      .bind(EFFECTIVE_SELECTIVE_METHOD,JSON.stringify(schema),schema.length)
      .first<EffectiveDependencySourceFence>();
  } catch(error) {
    if(String(error).includes('no such table: storage_effective_selective_runtime'))return;
    throw error;
  }
  if(!row||!integer(row.generation)||row.capabilityVersion!==EFFECTIVE_SELECTIVE_METHOD)return;
  return Object.freeze(row);
}

/** Opaque, bounded invocation proof. Its scope tokens retain the exact native
 * selective identities. Intermediate reuse checks sequence and clock expiry;
 * callers must request the full capability fence before sealing or serving.
 * Creation always checks full capabilities. Scoped rowid parameters never cache availability. */
declare const effectiveReadContextBrand:unique symbol;
export interface EffectiveDependencyReadContext {readonly [effectiveReadContextBrand]:true}
const readContexts=new WeakMap<EffectiveDependencyReadContext,{source:D1Database;identity:string;
 generation:number;expiresMs:number;capability?:'typed-v1-analysis';tokens:Map<string,EffectiveDependencyMutationToken>}>();
export async function createEffectiveDependencyReadContext(source:D1Database,identity:EffectiveDependencyMutationScope,
 scopes:readonly EffectiveDependencyScopeBounds[],deadlineMs:number,capability?:'typed-v1-analysis'):Promise<EffectiveDependencyReadContext|undefined> {
 if(!Number.isSafeInteger(deadlineMs)||deadlineMs<=Date.now()||deadlineMs>Date.now()+120_000)return;
 const before=await readEffectiveDependencySourceFence(source,capability);if(!before)return;
 const tokens=await readEffectiveScopeMutationTokens(source,identity,scopes);if(!tokens)return;
 const after=await readEffectiveDependencySourceFence(source,capability);
 if(!after||after.generation!==before.generation)return;
 const context=Object.freeze({}) as EffectiveDependencyReadContext;
 readContexts.set(context,{source,identity:canonicalJson(identity),generation:after.generation,capability,
  expiresMs:Math.min(deadlineMs,...tokens.map(token=>token.validUntilMs)),
  tokens:new Map(scopes.map((scope,index)=>[canonicalJson(scope),tokens[index]!]))});
 return context;
}
export async function effectiveDependencyReadContextCurrent(source:D1Database,
 context:EffectiveDependencyReadContext,capabilities=true):Promise<boolean> {
 const state=readContexts.get(context);
 if(!state||state.source!==source||Date.now()>=state.expiresMs)return false;
 const current=capabilities?await readEffectiveDependencySourceFence(source,state.capability)
  :await source.prepare('SELECT sequence AS generation,method AS capabilityVersion FROM storage_effective_selective_runtime WHERE id=1 AND method=?')
    .bind(EFFECTIVE_SELECTIVE_METHOD).first<EffectiveDependencySourceFence>();
 return !!current&&current.generation===state.generation&&Date.now()<state.expiresMs;
}
