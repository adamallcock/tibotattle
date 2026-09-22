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
import { beginAdminOperation, finishAdminOperation } from "./admin-operations";
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

export interface TelemetryRuntimeActivationRequest {
  readonly target: TelemetryRuntimeActivationTarget;
  readonly expectedRevision: number;
  readonly confirmation: string;
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

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function parseTelemetryRuntimeActivationRequest(
  value: unknown,
): TelemetryRuntimeActivationRequest {
  if (!exactObject(value, ["action", "telemetryRuntimeActivation"])
      || value.action !== "run_maintenance") invalidActivation();
  const rawTarget = value.telemetryRuntimeActivation;
  if (!exactObject(rawTarget, ["confirmation", "expectedRevision", "target"])) {
    invalidActivation();
  }
  const targetValue = rawTarget.target;
  const expectedRevision = rawTarget.expectedRevision;
  const confirmation = rawTarget.confirmation;
  if ((targetValue !== "usage_v12" && targetValue !== "performance")
      || typeof expectedRevision !== "number"
      || !Number.isSafeInteger(expectedRevision)
      || expectedRevision < 1
      || expectedRevision > MAX_REVISION
      || confirmation !== TELEMETRY_RUNTIME_ACTIVATION_CONFIRMATIONS[targetValue]) {
    invalidActivation();
  }
  const target = targetValue as TelemetryRuntimeActivationTarget;
  return Object.freeze({
    target,
    expectedRevision: expectedRevision as number,
    confirmation: confirmation as string,
  });
}

async function assertPrimarySchemaIsComplete(db: D1Database): Promise<void> {
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
      "SELECT name, sha256 FROM d1_storage_migrations",
    ).all<{ name: string; sha256: string }>()).results;
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
  } catch (error) {
    if (error instanceof ApiError) throw error;
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

async function casActivateUsage(
  db: D1Database,
  input: TelemetryRuntimeActivationRequest,
  now: string,
): Promise<{ state: "active"; policy_revision: number }> {
  const row = await db.prepare(
    `UPDATE telemetry_v12_runtime
        SET state = 'active', policy_revision = policy_revision + 1, changed_at = ?
      WHERE id = 1 AND state = 'staged' AND policy_revision = ?
        AND schema_version = ? AND envelope_schema_version = ?
        AND field_dictionary_version = ? AND privacy_contract_version = ?
        AND max_day_chunks = ? AND max_chunk_records = ? AND max_day_bytes = ?
      RETURNING state, policy_revision`,
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
  ).first<{ state: "active"; policy_revision: number }>();
  if (!row || row.state !== "active" || row.policy_revision !== input.expectedRevision + 1) {
    throw new ApiError(409, "ADMIN_ACTION_CONFLICT");
  }
  return row;
}

async function casActivatePerformance(
  db: D1Database,
  input: TelemetryRuntimeActivationRequest,
  now: string,
): Promise<{ state: "active"; policy_revision: number }> {
  const row = await db.prepare(
    `UPDATE telemetry_performance_runtime
        SET state = 'active', policy_revision = policy_revision + 1, updated_at = ?
      WHERE id = 1 AND state = 'staged' AND policy_revision = ?
        AND schema_version = ? AND field_dictionary_version = ?
        AND privacy_contract_version = ? AND method_version = ?
      RETURNING state, policy_revision`,
  ).bind(
    now,
    input.expectedRevision,
    PERFORMANCE_RECORD_SCHEMA_VERSION,
    PERFORMANCE_FIELD_DICTIONARY_VERSION,
    PERFORMANCE_PRIVACY_CONTRACT_VERSION,
    "performance-daily-histogram-v1",
  ).first<{ state: "active"; policy_revision: number }>();
  if (!row || row.state !== "active" || row.policy_revision !== input.expectedRevision + 1) {
    throw new ApiError(409, "ADMIN_ACTION_CONFLICT");
  }
  return row;
}

/**
 * Activate one independent hosted telemetry runtime after all local gates have
 * been proved.  This function performs no remote migration and never treats a
 * replay of an already-active row as success.
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
  const operationId = await beginAdminOperation(db, actorIdentityKey, "run_maintenance", {
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    task: "telemetry_runtime_activation",
    target: input.target,
    expectedRevision: input.expectedRevision,
  }, nowEpoch);
  const auditBase = {
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    task: "telemetry_runtime_activation",
    target: input.target,
    expectedRevision: input.expectedRevision,
  };
  try {
    await assertTypedStorage(db, env);
    await readCollectionControls(db).then((controls) => {
      if (!controls.uploadRegistration) throw new ApiError(503, "UPLOAD_REGISTRATION_DISABLED");
      if (!controls.processing) throw new ApiError(503, "PROCESSING_DISABLED");
    });
    await assertPrimarySchemaIsComplete(db);
    const now = new Date(nowEpoch).toISOString();
    let row: { state: "active"; policy_revision: number };
    if (input.target === "usage_v12") {
      const runtime = await readUsageRuntime(db);
      assertRevisionForActivation(runtime.state, runtime.policy_revision, input.expectedRevision);
      assertUsageTuple(runtime);
      row = await casActivateUsage(db, input, now);
    } else {
      const runtime = await readPerformanceRuntime(db);
      assertRevisionForActivation(runtime.state, runtime.policy_revision, input.expectedRevision);
      assertPerformanceTuple(runtime);
      row = await casActivatePerformance(db, input, now);
    }
    const result: TelemetryRuntimeActivationResult = Object.freeze({
      task: "telemetry_runtime_activation",
      operationId,
      target: input.target,
      state: row.state,
      fromRevision: input.expectedRevision,
      toRevision: row.policy_revision,
      revision: row.policy_revision,
    });
    await finishAdminOperation(db, operationId, "success", {
      ...auditBase,
      fromRevision: result.fromRevision,
      toRevision: result.toRevision,
      state: result.state,
    });
    return result;
  } catch (error) {
    const safeError = error instanceof ApiError
      ? error
      : new ApiError(503, "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE");
    try {
      await finishAdminOperation(db, operationId, "failure", {
        ...auditBase,
        code: safeError.code,
      });
    } catch {
      // Preserve the original failure; an incomplete audit cannot become a
      // false activation success.
    }
    throw safeError;
  }
}
