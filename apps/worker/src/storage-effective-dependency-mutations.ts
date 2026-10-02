import type {D1SchemaObject} from './d1-schema-object-hints';
import {readD1SchemaObjectsAvailable} from './d1-invocation-budget';
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';

export const EFFECTIVE_DEPENDENCY_MUTATION_METHOD='effective-dependency-mutation-v1';
/** Native metadata completion seals and exceptional deletes only; source
 * record/proof INSERTs remain free of per-record cache write amplification. */
export const EFFECTIVE_DEPENDENCY_MUTATION_TRIGGERS=Object.freeze([
  "storage_effective_mutation_participant_erase",
  "storage_effective_mutation_owner_erase",
  "storage_effective_mutation_link_erase",
  "storage_effective_mutation_participants_insert",
  "storage_effective_mutation_participants_update",
  "storage_effective_mutation_participants_delete",
  "storage_effective_mutation_device_credentials_insert",
  "storage_effective_mutation_device_credentials_update",
  "storage_effective_mutation_device_credentials_delete",
  "storage_effective_mutation_storage_v11_owner_links_insert",
  "storage_effective_mutation_storage_v11_owner_links_update",
  "storage_effective_mutation_storage_v11_owner_links_delete",
  "storage_effective_mutation_storage_owner_revisions_insert",
  "storage_effective_mutation_storage_owner_revisions_update",
  "storage_effective_mutation_storage_owner_revisions_delete",
  "storage_effective_mutation_telemetry_v1_chunks_insert",
  "storage_effective_mutation_telemetry_v1_chunks_update",
  "storage_effective_mutation_telemetry_v1_chunks_delete",
  "storage_effective_mutation_typed_v1_event_sources_insert",
  "storage_effective_mutation_typed_v1_event_sources_update",
  "storage_effective_mutation_typed_v1_event_sources_delete",
  "storage_effective_mutation_typed_v1_owner_memberships_insert",
  "storage_effective_mutation_typed_v1_owner_memberships_update",
  "storage_effective_mutation_typed_v1_owner_memberships_delete",
  "storage_effective_mutation_typed_v1_chunk_allocations_insert",
  "storage_effective_mutation_typed_v1_chunk_allocations_update",
  "storage_effective_mutation_typed_v1_chunk_allocations_delete",
  "storage_effective_mutation_telemetry_v11_day_manifests_insert",
  "storage_effective_mutation_telemetry_v11_day_manifests_update",
  "storage_effective_mutation_telemetry_v11_day_manifests_delete",
  "storage_effective_mutation_telemetry_v11_chunks_insert",
  "storage_effective_mutation_telemetry_v11_chunks_update",
  "storage_effective_mutation_telemetry_v11_chunks_delete",
  "storage_effective_mutation_telemetry_v11_domains_insert",
  "storage_effective_mutation_telemetry_v11_domains_update",
  "storage_effective_mutation_telemetry_v11_domains_delete",
  "storage_effective_mutation_telemetry_v11_domain_days_insert",
  "storage_effective_mutation_telemetry_v11_domain_days_update",
  "storage_effective_mutation_telemetry_v11_domain_days_delete",
  "storage_effective_mutation_storage_v11_event_sources_insert",
  "storage_effective_mutation_storage_v11_event_sources_update",
  "storage_effective_mutation_storage_v11_event_sources_delete",
  "storage_effective_mutation_typed_v11_owner_memberships_insert",
  "storage_effective_mutation_typed_v11_owner_memberships_update",
  "storage_effective_mutation_typed_v11_owner_memberships_delete",
  "storage_effective_mutation_typed_v11_manifest_memberships_insert",
  "storage_effective_mutation_typed_v11_manifest_memberships_update",
  "storage_effective_mutation_typed_v11_manifest_memberships_delete",
  "storage_effective_mutation_typed_v11_chunk_allocations_insert",
  "storage_effective_mutation_typed_v11_chunk_allocations_update",
  "storage_effective_mutation_typed_v11_chunk_allocations_delete",
  "storage_effective_mutation_telemetry_v12_day_manifests_insert",
  "storage_effective_mutation_telemetry_v12_day_manifests_update",
  "storage_effective_mutation_telemetry_v12_day_manifests_delete",
  "storage_effective_mutation_telemetry_v12_chunks_insert",
  "storage_effective_mutation_telemetry_v12_chunks_update",
  "storage_effective_mutation_telemetry_v12_chunks_delete",
  "storage_effective_mutation_telemetry_v12_domains_insert",
  "storage_effective_mutation_telemetry_v12_domains_update",
  "storage_effective_mutation_telemetry_v12_domains_delete",
  "storage_effective_mutation_telemetry_v12_domain_days_insert",
  "storage_effective_mutation_telemetry_v12_domain_days_update",
  "storage_effective_mutation_telemetry_v12_domain_days_delete",
  "storage_effective_mutation_telemetry_v12_domain_heads_insert",
  "storage_effective_mutation_telemetry_v12_domain_heads_update",
  "storage_effective_mutation_telemetry_v12_domain_heads_delete",
  "storage_effective_mutation_telemetry_v12_device_capabilities_insert",
  "storage_effective_mutation_telemetry_v12_device_capabilities_update",
  "storage_effective_mutation_telemetry_v12_device_capabilities_delete",
  "storage_effective_mutation_accountless_v12_device_authorizations_insert",
  "storage_effective_mutation_accountless_v12_device_authorizations_update",
  "storage_effective_mutation_accountless_v12_device_authorizations_delete",
  "storage_effective_mutation_accountless_upload_owners_insert",
  "storage_effective_mutation_accountless_upload_owners_update",
  "storage_effective_mutation_accountless_upload_owners_delete",
  "storage_effective_mutation_accountless_v11_device_authorizations_insert",
  "storage_effective_mutation_accountless_v11_device_authorizations_update",
  "storage_effective_mutation_accountless_v11_device_authorizations_delete",
  "storage_effective_mutation_telemetry_v11_device_consents_insert",
  "storage_effective_mutation_telemetry_v11_device_consents_update",
  "storage_effective_mutation_telemetry_v11_device_consents_delete",
  "storage_effective_mutation_storage_source_state_insert",
  "storage_effective_mutation_storage_source_state_update",
  "storage_effective_mutation_storage_source_state_delete",
  "storage_effective_mutation_typed_telemetry_schema_insert",
  "storage_effective_mutation_typed_telemetry_schema_update",
  "storage_effective_mutation_typed_telemetry_schema_delete",
  "storage_effective_mutation_telemetry_usage_correction_runtime_insert",
  "storage_effective_mutation_telemetry_usage_correction_runtime_update",
  "storage_effective_mutation_telemetry_usage_correction_runtime_delete",
  "storage_effective_mutation_telemetry_v12_runtime_insert",
  "storage_effective_mutation_telemetry_v12_runtime_update",
  "storage_effective_mutation_telemetry_v12_runtime_delete",
  "storage_effective_mutation_ingestion_analytics_separation_insert",
  "storage_effective_mutation_ingestion_analytics_separation_update",
  "storage_effective_mutation_ingestion_analytics_separation_delete",
  "storage_effective_mutation_collection_controls_insert",
  "storage_effective_mutation_collection_controls_update",
  "storage_effective_mutation_collection_controls_delete",
  "storage_effective_mutation_accountless_enrollment_ledger_insert",
  "storage_effective_mutation_accountless_enrollment_ledger_update",
  "storage_effective_mutation_accountless_enrollment_ledger_delete",
  "storage_effective_mutation_typed_v1_admission_state_insert",
  "storage_effective_mutation_typed_v1_admission_state_update",
  "storage_effective_mutation_typed_v1_admission_state_delete",
  "storage_effective_mutation_typed_v11_admission_state_insert",
  "storage_effective_mutation_typed_v11_admission_state_update",
  "storage_effective_mutation_typed_v11_admission_state_delete",
  "storage_effective_mutation_correction_fact_insert",
  "storage_effective_mutation_correction_fact_delete",
  "storage_effective_mutation_v12_record_delete",
  "storage_effective_mutation_typed_v1_record_admissions_delete",
  "storage_effective_mutation_typed_v11_record_proofs_delete",
  "storage_effective_mutation_typed_record_delete",
  "storage_effective_mutation_runtime_guard",
  "storage_effective_mutation_runtime_retained",
  "storage_effective_mutation_owner_insert_guard",
  "storage_effective_mutation_owner_guard",
  "storage_effective_mutation_owner_retained"
]);
const SOURCE_GUARDS=Object.freeze([
  "typed_v1_event_guard",
  "typed_v1_record_membership",
  "typed_v1_current_record_retained",
  "typed_v1_record_immutable",
  "typed_v11_record_membership",
  "typed_v11_record_proof_immutable",
  "typed_v11_active_proof_delete_guard",
  "typed_v11_retained_proof_delete_guard",
  "telemetry_v11_manifest_ready",
  "telemetry_v12_manifest_ready",
  "telemetry_v12_record_admission",
  "telemetry_v12_record_immutable",
  "typed_telemetry_record_immutable",
  "typed_telemetry_owner_immutable",
  "typed_telemetry_device_immutable",
  "typed_telemetry_chunk_immutable",
  "telemetry_usage_correction_history_fact",
  "telemetry_usage_correction_history_immutable",
  "telemetry_usage_correction_fact_immutable"
]);
/** Shared closed capability inventory for full proofs and request-local fences. */
export const EFFECTIVE_DEPENDENCY_MUTATION_SCHEMA:readonly D1SchemaObject[]=Object.freeze([
  ...[...EFFECTIVE_DEPENDENCY_MUTATION_TRIGGERS,...SOURCE_GUARDS].map(name=>['trigger',name] as const),
  ...['storage_effective_dependency_mutation_runtime','storage_effective_dependency_owner_mutations'].map(name=>['table',name] as const),
  ...['telemetry_v12_active_authorizations','typed_telemetry_compatibility_records','typed_v11_record_admissions'].map(name=>['view',name] as const),
]);
export interface EffectiveDependencyMutationToken {
  readonly stamp:string;
  /** Earliest source-clock retained-authorization phase change. */
  readonly validUntilMs:number;
}
export interface EffectiveDependencyMutationScope {
  readonly participantId:string; readonly ownerDigest:string;
  readonly sourceId:string; readonly sourceNamespace:string;
}
const safe=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
/** Optional only. Missing/partial schema returns undefined; D1 failures and
 * budget exceptions propagate so callers cannot spend a second native budget.
 * This token is invalidation evidence, never owner/publication authorization. */
export async function readEffectiveDependencyMutationToken(source:D1Database,
  scope:EffectiveDependencyMutationScope):Promise<EffectiveDependencyMutationToken|undefined> {
  if(!scope||Object.keys(scope).sort().join(',')!=='ownerDigest,participantId,sourceId,sourceNamespace'
    ||typeof scope.participantId!=='string'||scope.participantId.length<1||scope.participantId.length>256
    ||!/^[a-f0-9]{64}$/u.test(scope.ownerDigest)
    ||typeof scope.sourceId!=='string'||scope.sourceId.length<1||scope.sourceId.length>256
    ||typeof scope.sourceNamespace!=='string'||scope.sourceNamespace.length<1||scope.sourceNamespace.length>256)return undefined;
  if(!await readD1SchemaObjectsAvailable(source,EFFECTIVE_DEPENDENCY_MUTATION_SCHEMA))return undefined;
  const row=await source.prepare(`SELECT runtime.global_revision AS globalRevision,
      coalesce(owner.revision,0) AS participantRevision,
      (SELECT min(expires_at) FROM accountless_v12_device_authorizations
        WHERE participant_id=?1 AND state='active'
          AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS nextExpiry,
      (SELECT count(*) FROM accountless_v12_device_authorizations
        WHERE participant_id=?1 AND state='active'
          AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS expiredPhase,
      CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER) AS nowMs,
      v1.namespace_id AS v1Namespace,v11.namespace_id AS v11Namespace
    FROM storage_effective_dependency_mutation_runtime runtime
    JOIN storage_source_state source ON source.singleton=1 AND source.source_id=?3
    JOIN typed_v1_admission_state v1 ON v1.id=1 AND v1.runtime_contract_version=1 AND v1.source_namespace=?4
    JOIN typed_v11_admission_state v11 ON v11.id=1 AND v11.runtime_contract_version=1 AND v11.source_namespace=?4
    JOIN storage_v11_owner_links link ON link.participant_id=?1 AND link.owner_digest=?2
    LEFT JOIN storage_effective_dependency_owner_mutations owner ON owner.participant_id=?1
    WHERE runtime.id=1 AND runtime.method=?5`)
    .bind(scope.participantId,scope.ownerDigest,scope.sourceId,scope.sourceNamespace,EFFECTIVE_DEPENDENCY_MUTATION_METHOD)
    .first<{globalRevision:number;participantRevision:number;nextExpiry:string|null;expiredPhase:number;
      nowMs:number;v1Namespace:number;v11Namespace:number}>();
  if(!row||![row.globalRevision,row.participantRevision,row.expiredPhase,row.nowMs,row.v1Namespace,row.v11Namespace].every(safe))return undefined;
  const validUntilMs=row.nextExpiry===null?Number.MAX_SAFE_INTEGER:Date.parse(row.nextExpiry);
  if(!safe(validUntilMs)||validUntilMs<=row.nowMs)return undefined;
  const stamp=await sha256Hex(canonicalJson({method:EFFECTIVE_DEPENDENCY_MUTATION_METHOD,...scope,
    globalRevision:row.globalRevision,participantRevision:row.participantRevision,
    v1Namespace:row.v1Namespace,v11Namespace:row.v11Namespace,expiredPhase:row.expiredPhase}));
  return Object.freeze({stamp,validUntilMs});
}
