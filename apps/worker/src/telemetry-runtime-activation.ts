import {
  PERFORMANCE_BUCKET_SCHEME_VERSION,
  PERFORMANCE_FIELD_DICTIONARY_VERSION,
  PERFORMANCE_PRIVACY_CONTRACT_VERSION,
  PERFORMANCE_RECORD_SCHEMA_VERSION,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
} from "@app-usagemonitor/telemetry-contract";
import { readCollectionControls } from "./collection-controls";
import { beginAdminOperationWithId, finishAdminOperation } from "./admin-operations";
import { sha256Hex } from "./crypto";
import { D1_PROVIDER_SCHEMA_PREDICATE } from "./d1-provider-schema";
import { ApiError } from "./errors";
import {
  parseTelemetryStorageMode,
  resolveTelemetryStorageMode,
  type TelemetryStorageMode,
} from "./telemetry-storage-mode";

/**
 * The owner action is deliberately a subtype of run_maintenance.  Keeping
 * activation in the existing protected envelope means Access/session owner
 * authorization, CSRF, request limits, and audit lifecycle cannot drift into
 * a second privileged route.
 */
export const TELEMETRY_RUNTIME_ACTIVATION_CONFIRMATIONS = Object.freeze({
  usage_v12: "activate_telemetry_v12_runtime",
  performance: "activate_telemetry_performance_runtime",
} as const);

export type TelemetryRuntimeActivationTarget = keyof typeof TELEMETRY_RUNTIME_ACTIVATION_CONFIRMATIONS;

export const TELEMETRY_RUNTIME_RECONCILIATION_SCHEMA =
  "typed-forward-post-deploy-reconciliation-v1" as const;

export interface TelemetryRuntimeReconciliationRole {
  readonly schemaSha256: string;
  readonly ledgerSha256: string;
}

export interface TelemetryRuntimeReconciliationProof {
  readonly schema: typeof TELEMETRY_RUNTIME_RECONCILIATION_SCHEMA;
  readonly capturedAt: string;
  readonly sourceCommit: string;
  readonly versionId: string;
  readonly configSha256: string;
  readonly primary: TelemetryRuntimeReconciliationRole;
  readonly analytics: TelemetryRuntimeReconciliationRole;
  readonly proofSha256: string;
}

export interface TelemetryRuntimeActivationRequest {
  readonly idempotencyKey: string;
  readonly target: TelemetryRuntimeActivationTarget;
  readonly expectedRevision: number;
  readonly confirmation: string;
  readonly reconciliation: TelemetryRuntimeReconciliationProof;
}

export interface TelemetryRuntimeActivationResult {
  readonly task: "telemetry_runtime_activation";
  readonly operationId: string;
  readonly target: TelemetryRuntimeActivationTarget;
  readonly state: "active";
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly revision: number;
}

const MAX_REVISION = 2_147_483_647;
const ACTIVATION_SCHEMA_VERSION = "telemetry-runtime-activation-v1";
export const EXPECTED_PRIMARY_MIGRATIONS = Object.freeze([
  Object.freeze({
    name: "0006_usage_correction_facts.sql",
    sha256: "cbcac1caef1e854686752d0d025967b4a74102d1297253f31b2ac2ecb42f6d2d",
  }),
  Object.freeze({
    name: "0007_usage_correction_admission.sql",
    sha256: "3893f350f4c76481a1a0fcc88fd8b5516ec8239fb100f21942c35105263f19ba",
  }),
  Object.freeze({
    name: "0008_telemetry_v12.sql",
    sha256: "d5802b4a1d228c8b4388b5effe67cbf4e61605628eec00d54f0d1669c988c9e1",
  }),
  Object.freeze({
    name: "0009_performance_reports.sql",
    sha256: "cfd43797151ea3d5a6740da9792be49bf897968094347cd6fbbb9a0cf6510825",
  }),
] as const);

export const EXPECTED_ANALYTICS_MIGRATIONS = Object.freeze([
  Object.freeze({
    name: "0024_effective_owner_daily_cursor.sql",
    sha256: "f4eef3495ae3e5f1088ddea695607471dcbc2ea871291274ce50ef1295a05e68",
  }),
  Object.freeze({
    name: "0025_effective_graph_source.sql",
    sha256: "a99ba82106e53ac2eda3ac9078784e22774ba0fc099265a66dacc5b1765fe84b",
  }),
  Object.freeze({
    name: "0026_cache_retention_effective_layout.sql",
    sha256: "bac1838613b292b97bfee5022f6b43b6f52c9bc225d6d26f918cdcd7e454a2a1",
  }),
] as const);

type SchemaObjectType = "table" | "index" | "trigger" | "view";
interface SchemaObjectPin {
  readonly type: SchemaObjectType;
  readonly name: string;
}

/*
 * These are the final objects from the forward primary role.  Activation is
 * intentionally stricter than checking the singleton runtime row: a partially
 * applied migration must remain unusable even if that row happens to exist.
 * The list contains only schema object names; it never reads participant or
 * event payload rows.
 */
const EXPECTED_PRIMARY_SCHEMA_OBJECTS: readonly SchemaObjectPin[] = Object.freeze([
  { type: "table", name: "accountless_telemetry_performance_authorizations" },
  { type: "table", name: "accountless_v12_device_authorizations" },
  { type: "table", name: "collection_controls" },
  { type: "table", name: "device_credentials" },
  { type: "table", name: "participants" },
  { type: "table", name: "telemetry_performance_buckets" },
  { type: "table", name: "telemetry_performance_cohorts" },
  { type: "table", name: "telemetry_performance_device_capabilities" },
  { type: "table", name: "telemetry_performance_receipts" },
  { type: "table", name: "telemetry_performance_reports" },
  { type: "table", name: "telemetry_performance_runtime" },
  { type: "table", name: "telemetry_transport_device_floors" },
  { type: "table", name: "telemetry_transport_formats" },
  { type: "table", name: "telemetry_usage_correction_cas_guard" },
  { type: "table", name: "telemetry_usage_correction_facts" },
  { type: "table", name: "telemetry_usage_correction_history" },
  { type: "table", name: "telemetry_usage_correction_runtime" },
  { type: "table", name: "storage_ingestion_changes" },
  { type: "table", name: "storage_owner_revisions" },
  { type: "table", name: "storage_raw_copy_pages" },
  { type: "table", name: "storage_raw_copy_runs" },
  { type: "table", name: "storage_source_state" },
  { type: "table", name: "storage_v11_append_transitions" },
  { type: "table", name: "storage_v11_event_sources" },
  { type: "table", name: "storage_v11_head_requests" },
  { type: "table", name: "storage_v11_owner_links" },
  { type: "table", name: "typed_telemetry_attributions" },
  { type: "table", name: "typed_telemetry_chunks" },
  { type: "table", name: "typed_telemetry_devices" },
  { type: "table", name: "typed_telemetry_dictionary" },
  { type: "table", name: "typed_telemetry_identifiers" },
  { type: "table", name: "typed_telemetry_manifests" },
  { type: "table", name: "typed_telemetry_namespaces" },
  { type: "table", name: "typed_telemetry_owners" },
  { type: "table", name: "typed_telemetry_quota" },
  { type: "table", name: "typed_telemetry_quota_dimensions" },
  { type: "table", name: "typed_telemetry_records" },
  { type: "table", name: "typed_telemetry_schema" },
  { type: "table", name: "typed_telemetry_session_tools" },
  { type: "table", name: "typed_telemetry_usage" },
  { type: "table", name: "typed_v1_admission_state" },
  { type: "table", name: "typed_v1_analytical_schema" },
  { type: "table", name: "typed_v1_authority_requests" },
  { type: "table", name: "typed_v1_chunk_allocations" },
  { type: "table", name: "typed_v1_event_sources" },
  { type: "table", name: "typed_v1_owner_memberships" },
  { type: "table", name: "typed_v1_preservation_proofs" },
  { type: "table", name: "typed_v1_record_admissions" },
  { type: "table", name: "typed_v11_admission_state" },
  { type: "table", name: "typed_v11_chunk_allocations" },
  { type: "table", name: "typed_v11_manifest_memberships" },
  { type: "table", name: "typed_v11_owner_memberships" },
  { type: "table", name: "typed_v11_record_proofs" },
  { type: "table", name: "telemetry_v11_domains" },
  { type: "table", name: "telemetry_v11_domain_predecessors" },
  { type: "table", name: "telemetry_v12_attributions" },
  { type: "table", name: "telemetry_v12_chunks" },
  { type: "table", name: "telemetry_v12_day_manifests" },
  { type: "table", name: "telemetry_v12_device_capabilities" },
  { type: "table", name: "telemetry_v12_domain_days" },
  { type: "table", name: "telemetry_v12_domain_heads" },
  { type: "table", name: "telemetry_v12_domain_predecessors" },
  { type: "table", name: "telemetry_v12_domains" },
  { type: "table", name: "telemetry_v12_quota" },
  { type: "table", name: "telemetry_v12_records" },
  { type: "table", name: "telemetry_v12_runtime" },
  { type: "table", name: "telemetry_v12_session_tools" },
  { type: "table", name: "telemetry_v12_usage" },
  { type: "index", name: "accountless_telemetry_performance_authorizations_active" },
  { type: "index", name: "accountless_telemetry_performance_authorizations_head" },
  { type: "index", name: "accountless_v12_device_authorizations_active" },
  { type: "index", name: "telemetry_performance_buckets_report" },
  { type: "index", name: "telemetry_performance_capabilities_device" },
  { type: "index", name: "telemetry_performance_capabilities_head" },
  { type: "index", name: "telemetry_performance_cohort_identity" },
  { type: "index", name: "telemetry_performance_current_day" },
  { type: "index", name: "telemetry_performance_receipts_owner" },
  { type: "index", name: "telemetry_performance_reports_owner_day" },
  { type: "index", name: "telemetry_transport_device_floors_participant" },
  { type: "index", name: "telemetry_v12_capabilities_device" },
  { type: "index", name: "telemetry_v12_chunks_device" },
  { type: "index", name: "telemetry_v12_chunks_participant" },
  { type: "index", name: "telemetry_v12_domain_days_manifest" },
  { type: "index", name: "telemetry_v12_manifests_device_day" },
  { type: "index", name: "telemetry_v12_predecessors_current" },
  { type: "index", name: "telemetry_v12_records_order" },
  { type: "index", name: "telemetry_v12_usage_order" },
  { type: "index", name: "telemetry_usage_correction_facts_history" },
  { type: "index", name: "telemetry_usage_correction_history_identity" },
  { type: "index", name: "telemetry_usage_correction_history_owner_time" },
  { type: "index", name: "telemetry_usage_correction_history_source" },
  { type: "index", name: "storage_ingestion_owner_cursor" },
  { type: "index", name: "storage_v11_event_generation" },
  { type: "index", name: "storage_v11_event_owner" },
  { type: "index", name: "typed_telemetry_day" },
  { type: "index", name: "typed_telemetry_owner_time" },
  { type: "index", name: "typed_telemetry_quota_dimensions_identity" },
  { type: "index", name: "typed_telemetry_v1_occurrence" },
  { type: "index", name: "typed_telemetry_v11_occurrence" },
  { type: "index", name: "typed_v1_admissions_chunk" },
  { type: "index", name: "typed_v1_events_owner" },
  { type: "index", name: "typed_v1_owner_observed" },
  { type: "index", name: "typed_v1_quota_reset" },
  { type: "index", name: "typed_v11_admissions_legacy" },
  { type: "index", name: "typed_v11_manifest_observed" },
  { type: "index", name: "typed_v11_proof_chunk" },
  { type: "index", name: "typed_v11_proof_manifest" },
  { type: "trigger", name: "accountless_telemetry_performance_authorization_admission" },
  { type: "trigger", name: "accountless_telemetry_performance_authorization_immutable" },
  { type: "trigger", name: "accountless_telemetry_performance_authorization_revision" },
  { type: "trigger", name: "accountless_v12_authorization_admission" },
  { type: "trigger", name: "accountless_v12_authorization_immutable" },
  { type: "trigger", name: "telemetry_performance_capability_admission" },
  { type: "trigger", name: "telemetry_performance_capability_immutable" },
  { type: "trigger", name: "telemetry_performance_capability_revision" },
  { type: "trigger", name: "telemetry_performance_report_admission" },
  { type: "trigger", name: "telemetry_performance_report_immutable" },
  { type: "trigger", name: "telemetry_performance_report_revision_order" },
  { type: "trigger", name: "telemetry_transport_device_floor_created" },
  { type: "trigger", name: "telemetry_transport_device_floor_no_implicit_downgrade" },
  { type: "trigger", name: "telemetry_transport_device_floor_revision" },
  { type: "trigger", name: "telemetry_transport_device_floor_v11_consent" },
  { type: "trigger", name: "telemetry_transport_v12_v1_insert" },
  { type: "trigger", name: "telemetry_usage_correction_admission_retirement" },
  { type: "trigger", name: "telemetry_usage_correction_allocation_retirement" },
  { type: "trigger", name: "telemetry_usage_correction_cas_guard_consume" },
  { type: "trigger", name: "telemetry_usage_correction_cas_guard_validate" },
  { type: "trigger", name: "telemetry_usage_correction_chunk_retirement" },
  { type: "trigger", name: "telemetry_usage_correction_fact_erasure" },
  { type: "trigger", name: "telemetry_usage_correction_fact_immutable" },
  { type: "trigger", name: "telemetry_usage_correction_fact_provenance" },
  { type: "trigger", name: "telemetry_usage_correction_history_erasure" },
  { type: "trigger", name: "telemetry_usage_correction_history_fact" },
  { type: "trigger", name: "telemetry_usage_correction_history_immutable" },
  { type: "trigger", name: "telemetry_usage_correction_history_provenance" },
  { type: "trigger", name: "telemetry_usage_correction_participant_erasure" },
  { type: "trigger", name: "telemetry_usage_correction_record_retirement" },
  { type: "trigger", name: "telemetry_usage_correction_runtime_immutable" },
  { type: "trigger", name: "telemetry_usage_correction_runtime_retained" },
  { type: "trigger", name: "telemetry_v11_domain_complete_before_insert" },
  { type: "trigger", name: "telemetry_v12_capability_admission" },
  { type: "trigger", name: "telemetry_v12_capability_immutable" },
  { type: "trigger", name: "telemetry_v12_chunk_admission" },
  { type: "trigger", name: "telemetry_v12_chunk_authorization_consumed" },
  { type: "trigger", name: "telemetry_v12_chunk_immutable" },
  { type: "trigger", name: "telemetry_v12_domain_admission" },
  { type: "trigger", name: "telemetry_v12_domain_day_admission" },
  { type: "trigger", name: "telemetry_v12_domain_head_immutable" },
  { type: "trigger", name: "telemetry_v12_manifest_admission" },
  { type: "trigger", name: "telemetry_v12_manifest_immutable" },
  { type: "trigger", name: "telemetry_v12_manifest_ready" },
  { type: "trigger", name: "telemetry_v12_predecessor_admission" },
  { type: "trigger", name: "telemetry_v12_quota_admission" },
  { type: "trigger", name: "telemetry_v12_record_admission" },
  { type: "trigger", name: "telemetry_v12_record_immutable" },
  { type: "trigger", name: "telemetry_v12_session_tool_immutable" },
  { type: "trigger", name: "telemetry_v12_session_admission" },
  { type: "trigger", name: "telemetry_v12_usage_admission" },
  { type: "trigger", name: "telemetry_v12_usage_immutable" },
  { type: "trigger", name: "telemetry_v12_quota_immutable" },
  { type: "trigger", name: "storage_ingestion_change_commit" },
  { type: "trigger", name: "storage_ingestion_change_immutable" },
  { type: "trigger", name: "storage_ingestion_change_retained" },
  { type: "trigger", name: "storage_ingestion_change_validate" },
  { type: "trigger", name: "storage_raw_copy_page_commit" },
  { type: "trigger", name: "storage_raw_copy_page_guard" },
  { type: "trigger", name: "storage_raw_copy_page_immutable" },
  { type: "trigger", name: "storage_raw_copy_run_identity" },
  { type: "trigger", name: "storage_source_identity_immutable" },
  { type: "trigger", name: "storage_v11_append_transition_immutable" },
  { type: "trigger", name: "storage_v11_append_transition_retained" },
  { type: "trigger", name: "storage_v11_classify_head" },
  { type: "trigger", name: "storage_v11_chunks_retained" },
  { type: "trigger", name: "storage_v11_day_manifests_retained" },
  { type: "trigger", name: "storage_v11_device_withdraw_delete" },
  { type: "trigger", name: "storage_v11_device_withdraw_update" },
  { type: "trigger", name: "storage_v11_domain_day_retained" },
  { type: "trigger", name: "storage_v11_event_delete" },
  { type: "trigger", name: "storage_v11_event_immutable" },
  { type: "trigger", name: "storage_v11_event_publish" },
  { type: "trigger", name: "storage_v11_grant_withdraw_delete" },
  { type: "trigger", name: "storage_v11_grant_withdraw_update" },
  { type: "trigger", name: "storage_v11_head_insert" },
  { type: "trigger", name: "storage_v11_head_request_apply" },
  { type: "trigger", name: "storage_v11_head_update" },
  { type: "trigger", name: "storage_v11_head_withdrawal" },
  { type: "trigger", name: "storage_v11_ledger_withdraw_delete" },
  { type: "trigger", name: "storage_v11_ledger_withdraw_update" },
  { type: "trigger", name: "storage_v11_owner_delete" },
  { type: "trigger", name: "storage_v11_owner_identity" },
  { type: "trigger", name: "storage_v11_owner_terminal" },
  { type: "trigger", name: "storage_v11_owner_withdraw_delete" },
  { type: "trigger", name: "storage_v11_owner_withdraw_update" },
  { type: "trigger", name: "storage_v11_participant_erasure" },
  { type: "trigger", name: "storage_v11_participant_withdrawal" },
  { type: "trigger", name: "storage_v11_records_retained" },
  { type: "trigger", name: "telemetry_v11_head_insert_publish" },
  { type: "trigger", name: "telemetry_v11_head_update_publish" },
  { type: "trigger", name: "telemetry_v11_manifest_ready" },
  { type: "trigger", name: "typed_telemetry_attributions_immutable" },
  { type: "trigger", name: "typed_telemetry_chunk_immutable" },
  { type: "trigger", name: "typed_telemetry_device_immutable" },
  { type: "trigger", name: "typed_telemetry_dictionary_immutable" },
  { type: "trigger", name: "typed_telemetry_identifiers_immutable" },
  { type: "trigger", name: "typed_telemetry_manifest_immutable" },
  { type: "trigger", name: "typed_telemetry_namespace_immutable" },
  { type: "trigger", name: "typed_telemetry_owner_immutable" },
  { type: "trigger", name: "typed_telemetry_quota_dimensions_immutable" },
  { type: "trigger", name: "typed_telemetry_quota_immutable" },
  { type: "trigger", name: "typed_telemetry_record_immutable" },
  { type: "trigger", name: "typed_telemetry_schema_admission" },
  { type: "trigger", name: "typed_telemetry_session_tools_immutable" },
  { type: "trigger", name: "typed_telemetry_usage_attribution" },
  { type: "trigger", name: "typed_telemetry_usage_immutable" },
  { type: "trigger", name: "typed_telemetry_manifest_membership" },
  { type: "trigger", name: "typed_telemetry_record_membership" },
  { type: "trigger", name: "typed_telemetry_quota_attribution" },
  { type: "trigger", name: "typed_v1_allocated_row" },
  { type: "trigger", name: "typed_v1_allocation_advance" },
  { type: "trigger", name: "typed_v1_allocation_guard" },
  { type: "trigger", name: "typed_v1_allocation_immutable" },
  { type: "trigger", name: "typed_v1_chunk_delete" },
  { type: "trigger", name: "typed_v1_current_record_retained" },
  { type: "trigger", name: "typed_v1_event_guard" },
  { type: "trigger", name: "typed_v1_event_immutable" },
  { type: "trigger", name: "typed_v1_event_publish" },
  { type: "trigger", name: "typed_v1_event_retained" },
  { type: "trigger", name: "typed_v1_header_authority" },
  { type: "trigger", name: "typed_v1_initialize_empty" },
  { type: "trigger", name: "typed_v1_no_json" },
  { type: "trigger", name: "typed_v1_owner_delete" },
  { type: "trigger", name: "typed_v1_owner_membership_guard" },
  { type: "trigger", name: "typed_v1_owner_membership_immutable" },
  { type: "trigger", name: "typed_v1_owner_membership_retained" },
  { type: "trigger", name: "typed_v1_preservation_chunk_changed" },
  { type: "trigger", name: "typed_v1_preservation_proof_immutable" },
  { type: "trigger", name: "typed_v1_preservation_record_changed" },
  { type: "trigger", name: "typed_v1_quota_analysis_initial" },
  { type: "trigger", name: "typed_v1_quota_analysis_keys" },
  { type: "trigger", name: "typed_v1_quota_delete_guard" },
  { type: "trigger", name: "typed_v1_record_immutable" },
  { type: "trigger", name: "typed_v1_record_membership" },
  { type: "trigger", name: "typed_v1_request_immutable" },
  { type: "trigger", name: "typed_v1_session_tools_delete_guard" },
  { type: "trigger", name: "typed_v1_state_guard" },
  { type: "trigger", name: "typed_v1_state_retained" },
  { type: "trigger", name: "typed_v1_supersession_guard" },
  { type: "trigger", name: "typed_v1_tools_sealed" },
  { type: "trigger", name: "typed_v1_usage_delete_guard" },
  { type: "trigger", name: "typed_v11_active_proof_delete_guard" },
  { type: "trigger", name: "typed_v11_allocation_advance" },
  { type: "trigger", name: "typed_v11_allocation_guard" },
  { type: "trigger", name: "typed_v11_allocation_immutable" },
  { type: "trigger", name: "typed_v11_chunk_delete" },
  { type: "trigger", name: "typed_v11_initialize_empty" },
  { type: "trigger", name: "typed_v11_legacy_record_refusal" },
  { type: "trigger", name: "typed_v11_manifest_membership_guard" },
  { type: "trigger", name: "typed_v11_manifest_membership_immutable" },
  { type: "trigger", name: "typed_v11_manifest_membership_retained" },
  { type: "trigger", name: "typed_v11_owner_delete" },
  { type: "trigger", name: "typed_v11_owner_membership_guard" },
  { type: "trigger", name: "typed_v11_owner_membership_immutable" },
  { type: "trigger", name: "typed_v11_owner_membership_retained" },
  { type: "trigger", name: "typed_v11_quota_delete_guard" },
  { type: "trigger", name: "typed_v11_record_compat_delete" },
  { type: "trigger", name: "typed_v11_record_compat_update" },
  { type: "trigger", name: "typed_v11_record_membership" },
  { type: "trigger", name: "typed_v11_record_proof_immutable" },
  { type: "trigger", name: "typed_v11_record_time_guard" },
  { type: "trigger", name: "typed_v11_retained_proof_delete_guard" },
  { type: "trigger", name: "typed_v11_runtime_contract_qualify" },
  { type: "trigger", name: "typed_v11_runtime_initial_version" },
  { type: "trigger", name: "typed_v11_session_tools_delete_guard" },
  { type: "trigger", name: "typed_v11_session_tools_insert_guard" },
  { type: "trigger", name: "typed_v11_state_immutable" },
  { type: "trigger", name: "typed_v11_state_retained" },
  { type: "trigger", name: "typed_v11_typed_row_allocation" },
  { type: "trigger", name: "typed_v11_usage_delete_guard" },
  { type: "view", name: "telemetry_usage_correction_effective_facts" },
  { type: "view", name: "telemetry_v12_active_authorizations" },
  { type: "view", name: "typed_telemetry_compatibility_records" },
  { type: "view", name: "typed_telemetry_compatibility_session_tools" },
  { type: "view", name: "typed_v1_current_records" },
  { type: "view", name: "typed_v11_active_records" },
  { type: "view", name: "typed_v11_record_admissions" },
  { type: "trigger", name: "typed_v1_v11_transition_unqualified" },
] as const);

interface RuntimeActivationEnv {
  readonly TELEMETRY_STORAGE_MODE?: unknown;
  readonly TELEMETRY_STORAGE_NAMESPACE?: unknown;
  readonly DEPLOYMENT_SOURCE_COMMIT?: unknown;
  readonly ANALYTICS_DB?: unknown;
  readonly STORAGE_ANALYTICS_DB?: unknown;
}

interface UsageRuntimeRow {
  readonly state: string;
  readonly policy_revision: number;
  readonly schema_version: string;
  readonly envelope_schema_version: string;
  readonly field_dictionary_version: string;
  readonly privacy_contract_version: string;
  readonly max_day_chunks: number;
  readonly max_chunk_records: number;
  readonly max_day_bytes: number;
}

interface PerformanceRuntimeRow {
  readonly state: string;
  readonly policy_revision: number;
  readonly schema_version: string;
  readonly field_dictionary_version: string;
  readonly privacy_contract_version: string;
  readonly method_version: string;
}

function invalidActivation(): never {
  throw new ApiError(400, "BODY_INVALID");
}

function unavailableActivation(): never {
  throw new ApiError(503, "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE");
}

function reconciliationRequired(): never {
  throw new ApiError(503, "TELEMETRY_RUNTIME_ACTIVATION_RECONCILE_REQUIRED");
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Canonical content for an operator reconciliation proof without its
 * self-digest.  The migration operator and the Worker intentionally share
 * this small value-level convention without importing an operator script into
 * product code.
 */
export function canonicalTelemetryRuntimeReconciliationJson(
  proof: Omit<TelemetryRuntimeReconciliationProof, "proofSha256">,
): string {
  return canonicalJson(proof);
}

interface ReconciliationSchemaRow {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

interface ReconciliationLedgerRow {
  readonly name: string;
  readonly sha256: string;
}

function compareSchemaText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalSchemaRows(rows: readonly ReconciliationSchemaRow[]): string {
  const filtered = rows
    .filter((row) => !row.name.startsWith("sqlite_")
      && row.tbl_name !== "d1_storage_migrations")
    .map((row) => ({
      type: row.type,
      name: row.name,
      tbl_name: row.tbl_name,
      sql: row.sql,
    }))
    .sort((left, right) => compareSchemaText(left.type, right.type)
      || compareSchemaText(left.name, right.name));
  return canonicalJson(filtered);
}

function canonicalLedgerRows(rows: readonly ReconciliationLedgerRow[]): string {
  return canonicalJson(rows.map((row) => ({ name: row.name, sha256: row.sha256 })));
}

/** Hash the same ordered schema/ledger value that the forward operator stores. */
export async function telemetryRuntimeReconciliationDigests(
  db: D1Database,
): Promise<TelemetryRuntimeReconciliationRole> {
  const schema = (await db.prepare(
    `SELECT s.type, s.name, s.tbl_name, s.sql
       FROM sqlite_schema s
      WHERE s.name NOT GLOB 'sqlite_*'
        AND s.tbl_name <> 'd1_storage_migrations'
        AND NOT (${D1_PROVIDER_SCHEMA_PREDICATE})
      ORDER BY s.type, s.name`,
  ).all<ReconciliationSchemaRow>()).results;
  const ledger = (await db.prepare(
    "SELECT name, sha256 FROM d1_storage_migrations ORDER BY rowid LIMIT 129",
  ).all<ReconciliationLedgerRow>()).results;
  if (schema.length > 4096 || ledger.length > 512
      || schema.some((row) => typeof row.type !== "string"
        || typeof row.name !== "string"
        || typeof row.tbl_name !== "string"
        || (typeof row.sql !== "string" && row.sql !== null))
      || ledger.some((row) => typeof row.name !== "string"
        || !SHA256_PATTERN.test(row.sha256))) {
    unavailableActivation();
  }
  return {
    schemaSha256: await sha256Hex(canonicalSchemaRows(schema)),
    ledgerSha256: await sha256Hex(canonicalLedgerRows(ledger)),
  };
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function canonicalIso(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function parseReconciliationRole(value: unknown): TelemetryRuntimeReconciliationRole {
  if (!exactObject(value, ["ledgerSha256", "schemaSha256"])
      || typeof value.schemaSha256 !== "string"
      || typeof value.ledgerSha256 !== "string"
      || !SHA256_PATTERN.test(value.schemaSha256)
      || !SHA256_PATTERN.test(value.ledgerSha256)) {
    invalidActivation();
  }
  return Object.freeze({
    schemaSha256: value.schemaSha256,
    ledgerSha256: value.ledgerSha256,
  });
}

function parseReconciliationProof(value: unknown): TelemetryRuntimeReconciliationProof {
  if (!exactObject(value, [
    "analytics", "capturedAt", "configSha256", "primary", "proofSha256",
    "schema", "sourceCommit", "versionId",
  ])
      || value.schema !== TELEMETRY_RUNTIME_RECONCILIATION_SCHEMA
      || !canonicalIso(value.capturedAt)
      || typeof value.sourceCommit !== "string"
      || !COMMIT_PATTERN.test(value.sourceCommit)
      || typeof value.versionId !== "string"
      || !UUID_PATTERN.test(value.versionId)
      || typeof value.configSha256 !== "string"
      || !SHA256_PATTERN.test(value.configSha256)
      || typeof value.proofSha256 !== "string"
      || !SHA256_PATTERN.test(value.proofSha256)) {
    invalidActivation();
  }
  return Object.freeze({
    schema: TELEMETRY_RUNTIME_RECONCILIATION_SCHEMA,
    capturedAt: value.capturedAt,
    sourceCommit: value.sourceCommit,
    versionId: value.versionId,
    configSha256: value.configSha256,
    primary: parseReconciliationRole(value.primary),
    analytics: parseReconciliationRole(value.analytics),
    proofSha256: value.proofSha256,
  });
}

export function parseTelemetryRuntimeActivationRequest(
  value: unknown,
): TelemetryRuntimeActivationRequest {
  if (!exactObject(value, ["action", "telemetryRuntimeActivation"])
      || value.action !== "run_maintenance") invalidActivation();
  const rawTarget = value.telemetryRuntimeActivation;
  if (!exactObject(rawTarget, [
    "confirmation", "expectedRevision", "idempotencyKey", "reconciliation", "target",
  ])) {
    invalidActivation();
  }
  const targetValue = rawTarget.target;
  const expectedRevision = rawTarget.expectedRevision;
  const confirmation = rawTarget.confirmation;
  const idempotencyKey = rawTarget.idempotencyKey;
  const reconciliation = parseReconciliationProof(rawTarget.reconciliation);
  if ((targetValue !== "usage_v12" && targetValue !== "performance")
      || typeof idempotencyKey !== "string"
      || !UUID_PATTERN.test(idempotencyKey)
      || typeof expectedRevision !== "number"
      || !Number.isSafeInteger(expectedRevision)
      || expectedRevision < 1
      || expectedRevision > MAX_REVISION
      || confirmation !== TELEMETRY_RUNTIME_ACTIVATION_CONFIRMATIONS[targetValue]) {
    invalidActivation();
  }
  const target = targetValue as TelemetryRuntimeActivationTarget;
  return Object.freeze({
    idempotencyKey,
    target,
    expectedRevision: expectedRevision as number,
    confirmation: confirmation as string,
    reconciliation,
  });
}

async function assertPrimarySchemaIsComplete(
  db: D1Database,
): Promise<TelemetryRuntimeReconciliationRole> {
  try {
    // Keep each query below D1's bound-parameter ceiling even as the pinned
    // schema grows with the v1/v1.1 compatibility surface.
    const actual = new Set<string>();
    for (let offset = 0; offset < EXPECTED_PRIMARY_SCHEMA_OBJECTS.length; offset += 50) {
      const objects = EXPECTED_PRIMARY_SCHEMA_OBJECTS.slice(offset, offset + 50);
      const names = objects.map(() => "?").join(",");
      const rows = (await db.prepare(
        `SELECT type, name FROM sqlite_schema WHERE name IN (${names})`,
      ).bind(...objects.map((object) => object.name)).all<SchemaObjectPin>()).results;
      for (const row of rows) actual.add(`${row.type}\0${row.name}`);
    }
    if (actual.size !== EXPECTED_PRIMARY_SCHEMA_OBJECTS.length
        || EXPECTED_PRIMARY_SCHEMA_OBJECTS.some((object) => !actual.has(`${object.type}\0${object.name}`))) {
      unavailableActivation();
    }

    const ledgerRows = (await db.prepare(
      "SELECT name, sha256 FROM d1_storage_migrations ORDER BY rowid",
    ).all<ReconciliationLedgerRow>()).results;
    const ledger = new Map(ledgerRows.map((row) => [row.name, row.sha256]));
    if (EXPECTED_PRIMARY_MIGRATIONS.some((migration) => ledger.get(migration.name) !== migration.sha256)) {
      unavailableActivation();
    }

    const performanceSql = await db.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'telemetry_performance_reports'",
    ).first<{ sql: string }>();
    if (!performanceSql?.sql
        || !performanceSql.sql.includes(`bucket_scheme_version TEXT NOT NULL CHECK (bucket_scheme_version = '${PERFORMANCE_BUCKET_SCHEME_VERSION}')`)
        || !performanceSql.sql.includes("measurement_version TEXT NOT NULL CHECK (measurement_version = 'model-performance-samples-v1')")) {
      unavailableActivation();
    }
    return await telemetryRuntimeReconciliationDigests(db);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    unavailableActivation();
  }
}

async function assertAnalyticsSchemaIsComplete(
  db: D1Database,
): Promise<TelemetryRuntimeReconciliationRole> {
  try {
    const names = [
      "analytics_runtime_sources",
      "analytics_community_daily_owners",
      "analytics_community_graph_results",
      "analytics_cache_retention_day_marks",
    ];
    const rows = (await db.prepare(
      `SELECT type, name FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(",")})`,
    ).bind(...names).all<{ type: string; name: string }>()).results;
    if (rows.length !== names.length
        || names.some((name) => !rows.some((row) => row.type === "table" && row.name === name))) {
      unavailableActivation();
    }
    const ledger = (await db.prepare(
      "SELECT name, sha256 FROM d1_storage_migrations ORDER BY rowid",
    ).all<ReconciliationLedgerRow>()).results;
    const byName = new Map(ledger.map((row) => [row.name, row.sha256]));
    if (EXPECTED_ANALYTICS_MIGRATIONS.some((migration) => byName.get(migration.name) !== migration.sha256)) {
      unavailableActivation();
    }
    return await telemetryRuntimeReconciliationDigests(db);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    unavailableActivation();
  }
}

async function assertReconciliationProof(
  db: D1Database,
  env: RuntimeActivationEnv,
  proof: TelemetryRuntimeReconciliationProof,
  nowEpoch: number,
): Promise<void> {
  const capturedAt = Date.parse(proof.capturedAt);
  if (!Number.isFinite(capturedAt)
      || capturedAt > nowEpoch
      || nowEpoch - capturedAt > 86_400_000) unavailableActivation();
  const unsigned = {
    schema: proof.schema,
    capturedAt: proof.capturedAt,
    sourceCommit: proof.sourceCommit,
    versionId: proof.versionId,
    configSha256: proof.configSha256,
    primary: proof.primary,
    analytics: proof.analytics,
  } satisfies Omit<TelemetryRuntimeReconciliationProof, "proofSha256">;
  if (await sha256Hex(canonicalTelemetryRuntimeReconciliationJson(unsigned)) !== proof.proofSha256) {
    unavailableActivation();
  }

  const configuredSource = Reflect.get(env, "DEPLOYMENT_SOURCE_COMMIT");
  if (typeof configuredSource !== "string" || !COMMIT_PATTERN.test(configuredSource)
      || proof.sourceCommit !== configuredSource) {
    unavailableActivation();
  }

  const analytics = (Reflect.get(env, "ANALYTICS_DB")
    ?? Reflect.get(env, "STORAGE_ANALYTICS_DB")) as D1Database | undefined;
  if (!analytics || typeof analytics.prepare !== "function" || analytics === db) {
    unavailableActivation();
  }
  const [primary, analytical] = await Promise.all([
    assertPrimarySchemaIsComplete(db),
    assertAnalyticsSchemaIsComplete(analytics),
  ]);
  if (primary.schemaSha256 !== proof.primary.schemaSha256
      || primary.ledgerSha256 !== proof.primary.ledgerSha256
      || analytical.schemaSha256 !== proof.analytics.schemaSha256
      || analytical.ledgerSha256 !== proof.analytics.ledgerSha256) {
    unavailableActivation();
  }
}

async function assertTypedStorage(
  db: D1Database,
  env: RuntimeActivationEnv,
): Promise<TelemetryStorageMode> {
  let mode: TelemetryStorageMode;
  try {
    mode = parseTelemetryStorageMode(env);
  } catch {
    unavailableActivation();
  }
  if (mode.kind !== "typed") unavailableActivation();
  try {
    await resolveTelemetryStorageMode(db, env, "v1");
    await resolveTelemetryStorageMode(db, env, "v11");
  } catch {
    unavailableActivation();
  }
  return mode;
}

async function readUsageRuntime(db: D1Database): Promise<UsageRuntimeRow> {
  try {
    const row = await db.prepare(
      `SELECT state, policy_revision, schema_version, envelope_schema_version,
              field_dictionary_version, privacy_contract_version, max_day_chunks,
              max_chunk_records, max_day_bytes
         FROM telemetry_v12_runtime WHERE id = 1`,
    ).first<UsageRuntimeRow>();
    if (!row) unavailableActivation();
    return row;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    unavailableActivation();
  }
}

async function readPerformanceRuntime(db: D1Database): Promise<PerformanceRuntimeRow> {
  try {
    const row = await db.prepare(
      `SELECT state, policy_revision, schema_version, field_dictionary_version,
              privacy_contract_version, method_version
         FROM telemetry_performance_runtime WHERE id = 1`,
    ).first<PerformanceRuntimeRow>();
    if (!row) unavailableActivation();
    return row;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    unavailableActivation();
  }
}

function assertRevisionForActivation(
  state: string,
  revision: number,
  expectedRevision: number,
): void {
  if (state !== "staged" || revision !== expectedRevision) {
    throw new ApiError(409, "ADMIN_ACTION_CONFLICT");
  }
}

function assertUsageTuple(row: UsageRuntimeRow): void {
  if (row.schema_version !== TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION
      || row.envelope_schema_version !== "telemetry-envelope-v1.2"
      || row.field_dictionary_version !== TELEMETRY_V12_FIELD_DICTIONARY_VERSION
      || row.privacy_contract_version !== TELEMETRY_V12_PRIVACY_CONTRACT_VERSION
      || row.max_day_chunks !== 4_096
      || row.max_chunk_records !== 200
      || row.max_day_bytes !== 64_000_000) unavailableActivation();
}

function assertPerformanceTuple(row: PerformanceRuntimeRow): void {
  if (row.schema_version !== PERFORMANCE_RECORD_SCHEMA_VERSION
      || row.field_dictionary_version !== PERFORMANCE_FIELD_DICTIONARY_VERSION
      || row.privacy_contract_version !== PERFORMANCE_PRIVACY_CONTRACT_VERSION
      || row.method_version !== "performance-daily-histogram-v1") unavailableActivation();
}

function auditDetailsJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (typeof json !== "string" || json.length > 2_000) {
    throw new ApiError(503, "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE");
  }
  return json;
}

function activationMutation(
  db: D1Database,
  input: TelemetryRuntimeActivationRequest,
  controlsRevision: number,
  now: string,
): D1PreparedStatement {
  const controlGuard = `
        AND EXISTS (
          SELECT 1 FROM collection_controls controls
           WHERE controls.singleton = 1
             AND controls.upload_registration_enabled = 1
             AND controls.processing_enabled = 1
             AND controls.revision = ?
        )`;
  if (input.target === "usage_v12") {
    return db.prepare(
      `UPDATE telemetry_v12_runtime
          SET state = 'active', policy_revision = policy_revision + 1, changed_at = ?
        WHERE id = 1 AND state = 'staged' AND policy_revision = ?
          AND schema_version = ? AND envelope_schema_version = ?
          AND field_dictionary_version = ? AND privacy_contract_version = ?
          AND max_day_chunks = ? AND max_chunk_records = ? AND max_day_bytes = ?
          ${controlGuard}`,
    ).bind(
      now,
      input.expectedRevision,
      TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
      "telemetry-envelope-v1.2",
      TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
      TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
      4_096,
      200,
      64_000_000,
      controlsRevision,
    );
  }
  return db.prepare(
    `UPDATE telemetry_performance_runtime
        SET state = 'active', policy_revision = policy_revision + 1, updated_at = ?
      WHERE id = 1 AND state = 'staged' AND policy_revision = ?
        AND schema_version = ? AND field_dictionary_version = ?
        AND privacy_contract_version = ? AND method_version = ?
        ${controlGuard}`,
  ).bind(
    now,
    input.expectedRevision,
    PERFORMANCE_RECORD_SCHEMA_VERSION,
    PERFORMANCE_FIELD_DICTIONARY_VERSION,
    PERFORMANCE_PRIVACY_CONTRACT_VERSION,
    "performance-daily-histogram-v1",
    controlsRevision,
  );
}

async function activateAndAuditAtomically(
  db: D1Database,
  input: TelemetryRuntimeActivationRequest,
  operationId: string,
  controlsRevision: number,
  now: string,
  successDetails: unknown,
): Promise<{ state: "active"; policy_revision: number }> {
  const mutation = activationMutation(
    db, input, controlsRevision, now,
  );
  const audit = db.prepare(
    `UPDATE admin_action_audit
        SET outcome = 'success', details_json = ?
      WHERE operation_id = ? AND outcome = 'started' AND changes() = 1`,
  ).bind(auditDetailsJson(successDetails), operationId);
  const results = await db.batch([mutation, audit]);
  const mutationChanges = Number(results[0]?.meta?.changes ?? 0);
  const auditChanges = Number(results[1]?.meta?.changes ?? 0);
  if (mutationChanges !== 1 || auditChanges !== 1) {
    throw new DeterministicActivationBatchError(mutationChanges, auditChanges);
  }
  const row = input.target === "usage_v12"
    ? await readUsageRuntime(db)
    : await readPerformanceRuntime(db);
  if (row.state !== "active" || row.policy_revision !== input.expectedRevision + 1) {
    reconciliationRequired();
  }
  return { state: "active", policy_revision: row.policy_revision };
}

/**
 * D1 returned a completed batch result, so this outcome is not a lost
 * response. In particular, a zero-row CAS is a deterministic loser and must
 * never inspect the now-active runtime and claim another operation's success.
 */
class DeterministicActivationBatchError extends Error {
  constructor(
    readonly mutationChanges: number,
    readonly auditChanges: number,
  ) {
    super(`telemetry runtime activation batch changed ${mutationChanges}/${auditChanges} rows`);
    this.name = "DeterministicActivationBatchError";
  }
}

type RuntimeStateRow = UsageRuntimeRow | PerformanceRuntimeRow;

async function readTargetRuntime(
  db: D1Database,
  target: TelemetryRuntimeActivationTarget,
): Promise<RuntimeStateRow> {
  return target === "usage_v12" ? readUsageRuntime(db) : readPerformanceRuntime(db);
}

function activationResult(
  operationId: string,
  input: TelemetryRuntimeActivationRequest,
  row: { state: "active"; policy_revision: number },
): TelemetryRuntimeActivationResult {
  return Object.freeze({
    task: "telemetry_runtime_activation",
    operationId,
    target: input.target,
    state: row.state,
    fromRevision: input.expectedRevision,
    toRevision: row.policy_revision,
    revision: row.policy_revision,
  });
}

interface AuditOutcomeRow {
  readonly operation_id: string;
  readonly action: string;
  readonly outcome: "started" | "success" | "failure";
  readonly details_json: string;
}

async function readActivationAudit(
  db: D1Database,
  operationId: string,
): Promise<AuditOutcomeRow | null> {
  return db.prepare(
    `SELECT operation_id, action, outcome, details_json
       FROM admin_action_audit
      WHERE operation_id = ?`,
  ).bind(operationId).first<AuditOutcomeRow>();
}

function activationDetailsMatch(
  detailsJson: string,
  input: TelemetryRuntimeActivationRequest,
): Record<string, unknown> | null {
  let details: unknown;
  try {
    details = JSON.parse(detailsJson);
  } catch {
    return null;
  }
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const value = details as Record<string, unknown>;
  if (value.schemaVersion !== ACTIVATION_SCHEMA_VERSION
      || value.task !== "telemetry_runtime_activation"
      || value.idempotencyKey !== input.idempotencyKey
      || value.target !== input.target
      || value.expectedRevision !== input.expectedRevision
      || canonicalJson(value.reconciliation) !== canonicalJson(input.reconciliation)) {
    throw new ApiError(409, "ADMIN_ACTION_CONFLICT");
  }
  return value;
}

async function resolveExistingActivation(
  db: D1Database,
  input: TelemetryRuntimeActivationRequest,
  runtime: RuntimeStateRow,
): Promise<TelemetryRuntimeActivationResult | null> {
  const existing = await readActivationAudit(db, input.idempotencyKey);
  if (existing === null) return null;
  if (existing.action !== "run_maintenance") {
    throw new ApiError(409, "ADMIN_ACTION_CONFLICT");
  }
  const details = activationDetailsMatch(existing.details_json, input);
  if (details === null) reconciliationRequired();
  if (existing.outcome === "failure") throw new ApiError(409, "ADMIN_ACTION_CONFLICT");
  if (runtime.state !== "active" || runtime.policy_revision !== input.expectedRevision + 1) {
    reconciliationRequired();
  }
  const toRevision = details.toRevision;
  const state = details.state;
  if (existing.outcome === "success"
      && state === "active"
      && toRevision === input.expectedRevision + 1) {
    return activationResult(existing.operation_id, input, {
      state: "active",
      policy_revision: runtime.policy_revision,
    });
  }
  // The runtime update and terminal success audit are one atomic D1 batch.
  // An active row with a started audit therefore cannot be safely attributed
  // to this operation; never promote it based on runtime state alone.
  reconciliationRequired();
}

async function recoverActiveActivation(
  db: D1Database,
  input: TelemetryRuntimeActivationRequest,
  runtime: RuntimeStateRow,
): Promise<TelemetryRuntimeActivationResult | null> {
  if (runtime.state !== "active" || runtime.policy_revision !== input.expectedRevision + 1) {
    return null;
  }
  return resolveExistingActivation(db, input, runtime);
}

async function reconcilePostMutation(
  db: D1Database,
  input: TelemetryRuntimeActivationRequest,
  operationId: string,
): Promise<TelemetryRuntimeActivationResult | null> {
  let runtime: RuntimeStateRow;
  let audit: AuditOutcomeRow | null;
  try {
    [runtime, audit] = await Promise.all([
      readTargetRuntime(db, input.target),
      readActivationAudit(db, operationId),
    ]);
  } catch {
    reconciliationRequired();
  }
  if (runtime.state === "active" && runtime.policy_revision === input.expectedRevision + 1) {
    if (audit !== null && audit.action !== "run_maintenance") reconciliationRequired();
    const result = activationResult(operationId, input, {
      state: "active",
      policy_revision: runtime.policy_revision,
    });
    if (audit?.outcome === "success") return result;
    // Atomicity means a committed own activation always has a success audit.
    // A started audit beside an active row is an ambiguous state and must be
    // left untouched for exact operator reconciliation.
    reconciliationRequired();
  }
  if (runtime.state === "staged" && runtime.policy_revision === input.expectedRevision) {
    return null;
  }
  reconciliationRequired();
}

/**
 * Activate one independent hosted telemetry runtime after all local gates have
 * been proved. This function performs no remote migration. Exact replay of the
 * same committed operation is safe; a different operation cannot inherit it.
 */
export async function activateTelemetryRuntimeAsOwner(
  db: D1Database,
  env: RuntimeActivationEnv,
  actorIdentityKey: string,
  input: TelemetryRuntimeActivationRequest,
  nowEpoch = Date.now(),
): Promise<TelemetryRuntimeActivationResult> {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  const auditBase = {
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    task: "telemetry_runtime_activation",
    idempotencyKey: input.idempotencyKey,
    target: input.target,
    expectedRevision: input.expectedRevision,
    reconciliation: input.reconciliation,
  };
  let operationId: string | null = null;
  let mutationAttempted = false;
  try {
    await assertTypedStorage(db, env);
    const controls = await readCollectionControls(db);
    if (!controls.uploadRegistration) throw new ApiError(503, "UPLOAD_REGISTRATION_DISABLED");
    if (!controls.processing) throw new ApiError(503, "PROCESSING_DISABLED");
    await assertReconciliationProof(db, env, input.reconciliation, nowEpoch);
    const runtime = await readTargetRuntime(db, input.target);
    if (runtime.state === "active") {
      const recovered = await recoverActiveActivation(db, input, runtime);
      if (recovered !== null) return recovered;
      throw new ApiError(409, "ADMIN_ACTION_CONFLICT");
    }
    const existing = await readActivationAudit(db, input.idempotencyKey);
    if (existing !== null) {
      if (existing.action !== "run_maintenance") {
        throw new ApiError(409, "ADMIN_ACTION_CONFLICT");
      }
      activationDetailsMatch(existing.details_json, input);
      if (existing.outcome !== "started"
          || runtime.state !== "staged"
          || runtime.policy_revision !== input.expectedRevision) {
        throw new ApiError(409, "ADMIN_ACTION_CONFLICT");
      }
      // A crash after the durable intent row and before the D1 batch leaves a
      // staged runtime with a started audit. Reuse that exact operation id so
      // the retry completes the original intent instead of inserting a second
      // audit operation.
      operationId = existing.operation_id;
    }
    assertRevisionForActivation(runtime.state, runtime.policy_revision, input.expectedRevision);
    if (input.target === "usage_v12") {
      if (!("envelope_schema_version" in runtime)) unavailableActivation();
      assertUsageTuple(runtime);
    } else {
      if (!("method_version" in runtime)) unavailableActivation();
      assertPerformanceTuple(runtime);
    }
    if (operationId === null) {
      try {
        operationId = await beginAdminOperationWithId(
          db,
          input.idempotencyKey,
          actorIdentityKey,
          "run_maintenance",
          auditBase,
          nowEpoch,
        );
      } catch (error) {
        const raced = await readActivationAudit(db, input.idempotencyKey);
        if (raced !== null) {
          if (raced.action !== "run_maintenance") {
            throw new ApiError(409, "ADMIN_ACTION_CONFLICT");
          }
          activationDetailsMatch(raced.details_json, input);
          const racedRuntime = await readTargetRuntime(db, input.target);
          if (raced.outcome === "started"
              && racedRuntime.state === "staged"
              && racedRuntime.policy_revision === input.expectedRevision) {
            operationId = raced.operation_id;
          } else if (racedRuntime.state === "active") {
            const recovered = await resolveExistingActivation(db, input, racedRuntime);
            if (recovered !== null) return recovered;
          } else if (raced.outcome === "failure") {
            throw new ApiError(409, "ADMIN_ACTION_CONFLICT");
          } else {
            // A successful intent without the expected active runtime, or a
            // started intent at another staged revision, is not safe to
            // inherit from a raced insert. Leave it for explicit recovery.
            reconciliationRequired();
          }
        }
        if (operationId !== null) {
          // The competing insert was the only failure; continue with the
          // already durable intent below.
        } else {
          throw error;
        }
      }
    }
    const now = new Date(nowEpoch).toISOString();
    mutationAttempted = true;
    const row = await activateAndAuditAtomically(
      db,
      input,
      operationId,
      controls.revision,
      now,
      {
        ...auditBase,
        fromRevision: input.expectedRevision,
        toRevision: input.expectedRevision + 1,
        state: "active",
      },
    );
    return activationResult(operationId, input, row);
  } catch (error) {
    const deterministicBatch = error instanceof DeterministicActivationBatchError
      ? error
      : null;
    const safeError = error instanceof ApiError
      ? error
      : deterministicBatch?.mutationChanges === 0
        ? new ApiError(409, "ADMIN_ACTION_CONFLICT")
        : deterministicBatch !== null
          ? new ApiError(503, "TELEMETRY_RUNTIME_ACTIVATION_RECONCILE_REQUIRED")
          : new ApiError(503, "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE");
    // Only an exception from D1 itself leaves the batch outcome unknown. A
    // returned zero-row result is deterministic and must not reconcile against
    // a runtime transition committed by a competing operation.
    if (mutationAttempted && operationId !== null && deterministicBatch === null) {
      try {
        const recovered = await reconcilePostMutation(db, input, operationId);
        if (recovered !== null) return recovered;
      } catch (reconciliationError) {
        if (reconciliationError instanceof ApiError
            && reconciliationError.code === "TELEMETRY_RUNTIME_ACTIVATION_RECONCILE_REQUIRED") {
          throw reconciliationError;
        }
        throw new ApiError(503, "TELEMETRY_RUNTIME_ACTIVATION_RECONCILE_REQUIRED");
      }
    }
    // A returned one-row runtime mutation with a missing terminal audit is a
    // known, unsafe partial state. Leave it for exact operation-id recovery
    // instead of recording a false failure.
    if (deterministicBatch !== null && deterministicBatch.mutationChanges === 1) {
      throw safeError;
    }
    if (operationId !== null) {
      try {
        await finishAdminOperation(db, operationId, "failure", {
          ...auditBase,
          code: safeError.code,
        });
      } catch {
        if (mutationAttempted) reconciliationRequired();
      }
    }
    throw safeError;
  }
}
