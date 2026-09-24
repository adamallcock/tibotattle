import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyPostgresMigrations } from "./postgres-migrations.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const D1_MIGRATIONS = join(WORKER_ROOT, "migrations");
const D1_STORAGE_MIGRATION_DIRECTORIES = Object.freeze([
  "typed-ingestion-migrations", "ingestion-bridge-migrations",
  "typed-v11-admission-migrations", "typed-v1-admission-migrations",
  "ingestion-isolation-migrations",
]);
const HASH = value => createHash("sha256").update(value).digest("hex");
const SYNTHETIC_SOURCES = new WeakSet();
const AUTHORIZED_TARGET_POOLS = new WeakMap();
const V1_TABLES = Object.freeze([
  "telemetry_v1_device_consents", "telemetry_v1_chunks", "telemetry_v1_records",
]);
const V11_TABLES = Object.freeze([
  "telemetry_v11_device_consents", "telemetry_v11_day_manifests",
  "telemetry_v11_chunks", "telemetry_v11_records",
]);
const V12_TABLES = Object.freeze([
  "telemetry_v12_runtime", "telemetry_v12_device_capabilities",
  "telemetry_v12_day_manifests", "telemetry_v12_chunks", "telemetry_v12_records",
  "telemetry_v12_quota", "telemetry_v12_session_tools", "telemetry_v12_usage",
  "telemetry_v12_attributions",
  "telemetry_v12_domain_predecessors", "telemetry_v12_domains",
  "telemetry_v12_domain_days", "telemetry_v12_domain_heads",
  "accountless_v12_device_authorizations",
]);
const V12_TYPED_IMPORT_TABLES = Object.freeze([
  "typed_telemetry_dictionary", "telemetry_v12_day_manifests", "telemetry_v12_chunks",
  "telemetry_v12_attributions", "telemetry_v12_records", "telemetry_v12_usage",
  "telemetry_v12_quota", "telemetry_v12_session_tools",
]);
const V12_RUNTIME_DOMAIN_IMPORT_TABLES = Object.freeze([
  "telemetry_v12_runtime", "telemetry_v12_device_capabilities",
  "telemetry_v12_domain_predecessors", "telemetry_v12_domains",
  "telemetry_v12_domain_days", "telemetry_v12_domain_heads",
]);
const V12_MAPPED_IMPORT_TABLES = Object.freeze([
  ...V12_TYPED_IMPORT_TABLES, ...V12_RUNTIME_DOMAIN_IMPORT_TABLES,
]);
const REQUIRED_CUTOVER_SOURCE_ROLES = Object.freeze(["primary", "ingestion", "analytics", "deletionLedger"]);
const SOURCE_MIGRATION_LEDGER_TABLES = Object.freeze(["d1_migrations", "d1_storage_migrations"]);
const SOURCE_INFRASTRUCTURE_TABLES = new Set([...SOURCE_MIGRATION_LEDGER_TABLES, "sqlite_sequence", "_cf_KV"]);
const SOURCE_TABLES = Object.freeze({
  telemetry_v1_device_consents: ["participant_id", "device_id", "telemetry_schema_version", "field_dictionary_version", "privacy_contract_version", "consented_at"],
  telemetry_v1_chunks: ["id", "participant_id", "device_id", "stream", "chunk_day", "chunk_seq", "revision", "chunk_digest", "envelope_digest", "parser_version", "record_count", "accepted_record_count", "r2_key", "device_upload_authorization_id", "superseded_at", "quarantine_deleted_at", "created_at"],
  telemetry_v1_records: ["id", "chunk_row_id", "participant_id", "device_id", "stream", "occurrence_id", "observed_at", "observed_day", "provider", "model_id", "session_uuid", "plan_type", "plan_variant", "limit_id", "slot", "used_percent", "window_duration_minutes", "resets_at", "input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens", "output_text_tokens", "output_reasoning_tokens", "output_combined_tokens", "record_json"],
  telemetry_v11_device_consents: ["participant_id", "device_id", "telemetry_schema_version", "field_dictionary_version", "privacy_contract_version", "consented_at"],
  telemetry_v11_day_manifests: ["id", "participant_id", "device_id", "chunk_day", "manifest_digest", "parser_version", "manifest_json", "expected_chunk_count", "state", "created_at", "ready_at"],
  telemetry_v11_chunks: ["id", "manifest_id", "participant_id", "device_id", "stream", "chunk_day", "chunk_seq", "chunk_id", "chunk_digest", "envelope_digest", "parser_version", "record_count", "r2_key", "device_upload_authorization_id", "quarantine_deleted_at", "created_at"],
  telemetry_v11_records: ["chunk_id", "manifest_id", "stream", "occurrence_id", "observed_at", "record_json", "legacy_occurrence_id", "legacy_record_json"],
  typed_telemetry_dictionary: ["id", "value"],
  telemetry_v12_runtime: ["id", "schema_version", "envelope_schema_version", "field_dictionary_version", "privacy_contract_version", "state", "policy_revision", "max_day_chunks", "max_chunk_records", "max_day_bytes", "changed_at"],
  telemetry_v12_device_capabilities: ["participant_id", "device_id", "telemetry_schema_version", "field_dictionary_version", "privacy_contract_version", "state", "consented_at", "revoked_at"],
  telemetry_v12_day_manifests: ["id", "participant_id", "device_id", "chunk_day", "manifest_digest", "parser_version", "manifest_json", "expected_chunk_count", "state", "created_at", "ready_at"],
  telemetry_v12_chunks: ["id", "manifest_id", "participant_id", "device_id", "stream", "chunk_day", "chunk_seq", "chunk_id", "chunk_digest", "envelope_digest", "parser_version", "record_count", "r2_key", "device_upload_authorization_id", "created_at"],
  telemetry_v12_attributions: ["id", "account_basis", "account_track", "plan_basis", "plan_type_id", "plan_era"],
  telemetry_v12_records: ["id", "chunk_id", "manifest_id", "stream", "record_index", "occurrence_id", "observed_at_ms", "observed_day", "provider_id", "canonical_digest"],
  telemetry_v12_usage: ["record_id", "session_id", "model_id", "speed_mode_id", "api_service_tier_id", "surface_id", "billing_surface_id", "reasoning_effort_id", "agent_scope_id", "outcome_id", "attribution_id", "total_input_context_tokens", "input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens", "output_text_tokens", "output_reasoning_tokens", "output_combined_tokens", "boundary_flags", "tie_order", "cache_write_ttl_five_minute_tokens", "cache_write_ttl_one_hour_tokens"],
  telemetry_v12_quota: ["record_id", "plan_type_id", "plan_variant_id", "limit_id", "slot_id", "used_percent", "window_duration_minutes", "resets_at_ms", "attribution_id"],
  telemetry_v12_session_tools: ["record_id", "tool_class_id", "count"],
  telemetry_v12_domain_predecessors: ["token_hash", "participant_id", "device_id", "previous_generation_id", "legacy_fingerprint", "input_revision", "from_day", "through_day", "days_json", "created_at", "expires_at", "consumed_at"],
  telemetry_v12_domains: ["id", "participant_id", "device_id", "predecessor_token_hash", "previous_generation_id", "manifest_digest", "legacy_fingerprint", "input_revision", "from_day", "through_day", "days_json", "created_at"],
  telemetry_v12_domain_days: ["generation_id", "observed_day", "manifest_id", "manifest_digest"],
  telemetry_v12_domain_heads: ["participant_id", "generation_id", "revision", "updated_at"],
  pending_quarantine_objects: ["r2_key", "contribution_id", "object_kind", "registered_at", "reconciliation_state", "reconciliation_lease_id"],
});
const SOURCE_INTEGER_COLUMNS = Object.freeze({
  telemetry_v1_chunks: new Set(["chunk_seq", "revision", "record_count", "accepted_record_count"]),
  telemetry_v1_records: new Set(["id", "window_duration_minutes", "input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens", "output_text_tokens", "output_reasoning_tokens", "output_combined_tokens"]),
  telemetry_v11_day_manifests: new Set(["expected_chunk_count"]),
  telemetry_v11_chunks: new Set(["chunk_seq", "record_count"]),
  typed_telemetry_dictionary: new Set(["id"]),
  telemetry_v12_runtime: new Set(["id", "policy_revision", "max_day_chunks", "max_chunk_records", "max_day_bytes"]),
  telemetry_v12_day_manifests: new Set(["expected_chunk_count"]),
  telemetry_v12_chunks: new Set(["chunk_seq", "record_count"]),
  telemetry_v12_attributions: new Set(["id", "account_basis", "plan_basis", "plan_type_id"]),
  telemetry_v12_records: new Set(["id", "record_index", "observed_at_ms", "observed_day", "provider_id"]),
  telemetry_v12_usage: new Set(["record_id", "model_id", "speed_mode_id", "api_service_tier_id", "surface_id", "billing_surface_id", "reasoning_effort_id", "agent_scope_id", "outcome_id", "attribution_id", "total_input_context_tokens", "input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens", "output_text_tokens", "output_reasoning_tokens", "output_combined_tokens", "boundary_flags", "tie_order", "cache_write_ttl_five_minute_tokens", "cache_write_ttl_one_hour_tokens"]),
  telemetry_v12_quota: new Set(["record_id", "plan_type_id", "plan_variant_id", "limit_id", "slot_id", "window_duration_minutes", "resets_at_ms", "attribution_id"]),
  telemetry_v12_session_tools: new Set(["record_id", "tool_class_id", "count"]),
  telemetry_v12_domain_predecessors: new Set(["input_revision"]),
  telemetry_v12_domains: new Set(["input_revision"]),
  telemetry_v12_domain_heads: new Set(["revision"]),
});
const SOURCE_REAL_COLUMNS = Object.freeze({ telemetry_v1_records: new Set(["used_percent"]), telemetry_v12_quota: new Set(["used_percent"]) });
const SOURCE_BLOB_COLUMNS = Object.freeze({
  telemetry_v12_attributions: new Set(["account_track", "plan_era"]),
  telemetry_v12_records: new Set(["occurrence_id", "canonical_digest"]),
  telemetry_v12_usage: new Set(["session_id"]),
});
const IMPORT_ORDER = Object.freeze([
  "pending_objects", "telemetry_v1_device_consents", "telemetry_v11_device_consents",
  "telemetry_v11_day_manifests", "telemetry_v1_chunks", "telemetry_v1_records",
  "telemetry_v11_chunks", "telemetry_v11_records",
  "telemetry_v12_runtime", "telemetry_v12_device_capabilities",
  "typed_telemetry_dictionary", "telemetry_v12_day_manifests", "telemetry_v12_chunks",
  "telemetry_v12_attributions", "telemetry_v12_records", "telemetry_v12_usage",
  "telemetry_v12_quota", "telemetry_v12_session_tools",
  "telemetry_v12_domain_predecessors", "telemetry_v12_domains",
  "telemetry_v12_domain_days", "telemetry_v12_domain_heads",
]);
const FULL_TABLE_IMPORTS = new Set([
  "telemetry_v1_device_consents", "telemetry_v1_chunks", "telemetry_v1_records",
  "telemetry_v11_device_consents", "telemetry_v11_day_manifests",
  "telemetry_v11_chunks", "telemetry_v11_records",
  ...V12_MAPPED_IMPORT_TABLES,
]);
const TARGET_TABLES = Object.freeze({
  telemetry_v12_runtime: "telemetry_v12_typed_runtime",
  telemetry_v12_attributions: "telemetry_v12_typed_attributions",
  telemetry_v12_records: "telemetry_v12_typed_records",
  telemetry_v12_usage: "telemetry_v12_typed_usage",
  telemetry_v12_quota: "telemetry_v12_typed_quota",
  telemetry_v12_session_tools: "telemetry_v12_typed_session_tools",
});
const IDENTITY_AUTHORITY_TABLES = new Set([
  "participants", "web_sessions", "device_pairings", "device_credentials",
  "device_credential_rotations", "device_pairing_events", "device_upload_authorizations",
  "upload_authorizations", "enrollment_grants", "participant_community_eligibility",
  "recovery_retry_receipts", "identity_link_secret_configuration",
  "identity_reenrollment_cooldowns", "attribution_enrollments",
  "accountless_upload_owners", "accountless_v11_device_authorizations",
  "accountless_enrollment_ledger", "accountless_enrollment_issuance",
  "accountless_telemetry_performance_authorizations",
]);
const TARGET_COLUMNS = Object.freeze({
  pending_objects: ["contribution_id", "object_key", "object_kind", "registered_at", "reconciliation_state", "reconciliation_lease_id"],
  telemetry_v1_device_consents: SOURCE_TABLES.telemetry_v1_device_consents,
  telemetry_v1_chunks: SOURCE_TABLES.telemetry_v1_chunks,
  telemetry_v1_records: SOURCE_TABLES.telemetry_v1_records,
  telemetry_v11_device_consents: SOURCE_TABLES.telemetry_v11_device_consents,
  telemetry_v11_day_manifests: SOURCE_TABLES.telemetry_v11_day_manifests,
  telemetry_v11_chunks: SOURCE_TABLES.telemetry_v11_chunks,
  telemetry_v11_records: SOURCE_TABLES.telemetry_v11_records,
  telemetry_v12_runtime: SOURCE_TABLES.telemetry_v12_runtime,
  telemetry_v12_device_capabilities: SOURCE_TABLES.telemetry_v12_device_capabilities,
  typed_telemetry_dictionary: SOURCE_TABLES.typed_telemetry_dictionary,
  telemetry_v12_day_manifests: SOURCE_TABLES.telemetry_v12_day_manifests,
  telemetry_v12_chunks: SOURCE_TABLES.telemetry_v12_chunks,
  telemetry_v12_attributions: SOURCE_TABLES.telemetry_v12_attributions,
  telemetry_v12_records: SOURCE_TABLES.telemetry_v12_records,
  telemetry_v12_usage: SOURCE_TABLES.telemetry_v12_usage,
  telemetry_v12_quota: SOURCE_TABLES.telemetry_v12_quota,
  telemetry_v12_session_tools: SOURCE_TABLES.telemetry_v12_session_tools,
  telemetry_v12_domain_predecessors: SOURCE_TABLES.telemetry_v12_domain_predecessors,
  telemetry_v12_domains: SOURCE_TABLES.telemetry_v12_domains,
  telemetry_v12_domain_days: SOURCE_TABLES.telemetry_v12_domain_days,
  telemetry_v12_domain_heads: SOURCE_TABLES.telemetry_v12_domain_heads,
});
const STORES_NOT_IMPORTED = Object.freeze([
  "identity_and_device_authority", "upload_authorization_and_admission_journals",
  "v1_chunk_admission_windows_and_derived_analytics", "v11_typed_admission_and_domain_publication",
  "v12_accountless_authority_and_live_source_qualification", "ledger_database", "analytics_migration_families",
  "correction_replay_and_retained-telemetry-stores", "accountless_enrollment_and_erasure_authority",
]);
const IMPORT_BATCH_MAX_ROWS = 256;
const IMPORT_BATCH_MAX_BYTES = 4 * 1024 * 1024;
const IMPORT_SOURCE_MAX_ROW_BYTES = 8 * 1024 * 1024;
const REHEARSAL_RUN_TABLE = "cutover_rehearsal_import_run";
const REHEARSAL_CHECKPOINT_TABLE = "cutover_rehearsal_import_checkpoints";
const REHEARSAL_MANIFEST_TABLE = "cutover_rehearsal_manifest_ready_times";
const EMPTY_PREFIX_CHAIN = HASH("tibotattle-cutover-rehearsal-prefix-v1");
const TARGET_TYPES = Object.freeze({
  pending_objects: { contribution_id: "text", object_key: "text", object_kind: "text", registered_at: "timestamp with time zone", reconciliation_state: "text", reconciliation_lease_id: "text", registration_token: "text" },
  telemetry_v1_device_consents: { participant_id: "text", device_id: "text", telemetry_schema_version: "text", field_dictionary_version: "text", privacy_contract_version: "text", consented_at: "timestamp with time zone" },
  telemetry_v1_chunks: { id: "text", participant_id: "text", device_id: "text", stream: "text", chunk_day: "date", chunk_seq: "integer", revision: "integer", chunk_digest: "text", envelope_digest: "text", parser_version: "text", record_count: "integer", accepted_record_count: "integer", r2_key: "text", device_upload_authorization_id: "text", superseded_at: "timestamp with time zone", quarantine_deleted_at: "timestamp with time zone", created_at: "timestamp with time zone" },
  telemetry_v1_records: { id: "bigint", chunk_row_id: "text", participant_id: "text", device_id: "text", stream: "text", occurrence_id: "text", observed_at: "timestamp with time zone", observed_day: "date", provider: "text", model_id: "text", session_uuid: "text", plan_type: "text", plan_variant: "text", limit_id: "text", slot: "text", used_percent: "double precision", window_duration_minutes: "integer", resets_at: "timestamp with time zone", input_uncached_tokens: "bigint", input_cache_read_tokens: "bigint", input_cache_write_tokens: "bigint", output_text_tokens: "bigint", output_reasoning_tokens: "bigint", output_combined_tokens: "bigint", record_json: "jsonb" },
  telemetry_v11_device_consents: { participant_id: "text", device_id: "text", telemetry_schema_version: "text", field_dictionary_version: "text", privacy_contract_version: "text", consented_at: "timestamp with time zone" },
  telemetry_v11_day_manifests: { id: "text", participant_id: "text", device_id: "text", chunk_day: "date", manifest_digest: "text", parser_version: "text", manifest_json: "text", expected_chunk_count: "integer", state: "text", created_at: "timestamp with time zone", ready_at: "timestamp with time zone" },
  telemetry_v11_chunks: { id: "text", manifest_id: "text", participant_id: "text", device_id: "text", stream: "text", chunk_day: "date", chunk_seq: "integer", chunk_id: "text", chunk_digest: "text", envelope_digest: "text", parser_version: "text", record_count: "integer", r2_key: "text", device_upload_authorization_id: "text", quarantine_deleted_at: "timestamp with time zone", created_at: "timestamp with time zone" },
  telemetry_v11_records: { chunk_id: "text", manifest_id: "text", stream: "text", occurrence_id: "text", observed_at: "timestamp with time zone", record_json: "text", legacy_occurrence_id: "text", legacy_record_json: "text" },
  typed_telemetry_dictionary: { id: "bigint", value: "text" },
  telemetry_v12_runtime: { id: "integer", schema_version: "text", envelope_schema_version: "text", field_dictionary_version: "text", privacy_contract_version: "text", state: "text", policy_revision: "integer", max_day_chunks: "integer", max_chunk_records: "integer", max_day_bytes: "integer", changed_at: "timestamp with time zone" },
  telemetry_v12_device_capabilities: { participant_id: "text", device_id: "text", telemetry_schema_version: "text", field_dictionary_version: "text", privacy_contract_version: "text", state: "text", consented_at: "timestamp with time zone", revoked_at: "timestamp with time zone" },
  telemetry_v12_day_manifests: { id: "text", participant_id: "text", device_id: "text", chunk_day: "date", manifest_digest: "text", parser_version: "text", manifest_json: "text", expected_chunk_count: "integer", state: "text", created_at: "timestamp with time zone", ready_at: "timestamp with time zone" },
  telemetry_v12_chunks: { id: "text", manifest_id: "text", participant_id: "text", device_id: "text", stream: "text", chunk_day: "date", chunk_seq: "integer", chunk_id: "text", chunk_digest: "text", envelope_digest: "text", parser_version: "text", record_count: "integer", r2_key: "text", device_upload_authorization_id: "text", quarantine_deleted_at: "timestamp with time zone", created_at: "timestamp with time zone" },
  telemetry_v12_attributions: { id: "bigint", account_basis: "smallint", account_track: "bytea", plan_basis: "smallint", plan_type_id: "bigint", plan_era: "bytea" },
  telemetry_v12_records: { id: "bigint", chunk_id: "text", manifest_id: "text", stream: "text", record_index: "integer", occurrence_id: "bytea", observed_at_ms: "bigint", observed_day: "integer", provider_id: "bigint", canonical_digest: "bytea" },
  telemetry_v12_usage: { record_id: "bigint", session_id: "bytea", model_id: "bigint", speed_mode_id: "bigint", api_service_tier_id: "bigint", surface_id: "bigint", billing_surface_id: "bigint", reasoning_effort_id: "bigint", agent_scope_id: "bigint", outcome_id: "bigint", attribution_id: "bigint", total_input_context_tokens: "bigint", input_uncached_tokens: "bigint", input_cache_read_tokens: "bigint", input_cache_write_tokens: "bigint", output_text_tokens: "bigint", output_reasoning_tokens: "bigint", output_combined_tokens: "bigint", boundary_flags: "integer", tie_order: "integer", cache_write_ttl_five_minute_tokens: "bigint", cache_write_ttl_one_hour_tokens: "bigint" },
  telemetry_v12_quota: { record_id: "bigint", plan_type_id: "bigint", plan_variant_id: "bigint", limit_id: "bigint", slot_id: "bigint", used_percent: "double precision", window_duration_minutes: "integer", resets_at_ms: "bigint", attribution_id: "bigint" },
  telemetry_v12_session_tools: { record_id: "bigint", tool_class_id: "bigint", count: "bigint" },
  telemetry_v12_domain_predecessors: { token_hash: "text", participant_id: "text", device_id: "text", previous_generation_id: "text", legacy_fingerprint: "text", input_revision: "integer", from_day: "date", through_day: "date", winners_json: "text", created_at: "timestamp with time zone", expires_at: "timestamp with time zone", consumed_at: "timestamp with time zone", days_json: "text" },
  telemetry_v12_domains: { id: "text", participant_id: "text", device_id: "text", predecessor_token_hash: "text", previous_generation_id: "text", manifest_digest: "text", legacy_fingerprint: "text", input_revision: "integer", from_day: "date", through_day: "date", days_json: "text", created_at: "timestamp with time zone" },
  telemetry_v12_domain_days: { generation_id: "text", observed_day: "date", manifest_id: "text", manifest_digest: "text" },
  telemetry_v12_domain_heads: { participant_id: "text", generation_id: "text", revision: "integer", updated_at: "timestamp with time zone" },
});

function fail(code) { throw Object.assign(new Error(code), { code }); }

function quoteIdentifier(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,62}$/u.test(value)) fail("CUTOVER_IDENTIFIER_INVALID");
  return `"${value}"`;
}

function targetTableName(sourceTable) {
  return TARGET_TABLES[sourceTable] ?? sourceTable;
}

export function assessCutoverSourceCoverage(tableNames) {
  if (!Array.isArray(tableNames) || tableNames.some(name => typeof name !== "string")) fail("CUTOVER_SOURCE_CATALOG_INVALID");
  const names = new Set(tableNames);
  const unknownV12 = tableNames.filter(name => /^(?:telemetry_v12_|accountless_v12_)/u.test(name) && !V12_TABLES.includes(name));
  if (unknownV12.length) fail("CUTOVER_V12_SOURCE_UNKNOWN_TABLE");
  const missingV1 = V1_TABLES.filter(name => !names.has(name));
  const missingV11 = V11_TABLES.filter(name => !names.has(name));
  const presentV12 = V12_TABLES.filter(name => names.has(name));
  const missingV12 = V12_TABLES.filter(name => !names.has(name));
  if (missingV1.length) fail("CUTOVER_V1_SOURCE_INCOMPLETE");
  if (missingV11.length) fail("CUTOVER_V11_SOURCE_INCOMPLETE");
  if (presentV12.length && missingV12.length) fail("CUTOVER_V12_SOURCE_PARTIAL");
  return Object.freeze({
    v1: "available",
    v11: "available",
    v12: presentV12.length ? "present-but-unsupported" : "unavailable-in-canonical-d1-migrations",
    v12TablesPresent: presentV12,
    v12TablesMissing: missingV12,
    fullFormatCoverage: presentV12.length === V12_TABLES.length,
  });
}

export function validateSyntheticSourceSchema(sourceDb) {
  if (!sourceDb || !SYNTHETIC_SOURCES.has(sourceDb)) fail("CUTOVER_LOCAL_SYNTHETIC_ONLY");
  assertSourceSchema(sourceDb);
  return true;
}

/**
 * Preflight only: the transfer has no importer for the accountless authority
 * family. Keep the D1 admission proof intact, validate that an observed v1.2
 * grant still has its exact source parents, then fail closed before connecting
 * to PostgreSQL. PG has no D1-equivalent v1.2 grant-admission trigger or
 * accountless participant-floor creation trigger, and global issuance state
 * is not part of the synthetic participant subset.
 */
export function assertAccountlessAuthorityTransferPreflight(sourceDb) {
  if (!sourceDb || !SYNTHETIC_SOURCES.has(sourceDb)) fail("CUTOVER_LOCAL_SYNTHETIC_ONLY");
  const counts = sourceDb.prepare(`SELECT
      (SELECT count(*) FROM accountless_enrollment_ledger) AS ledgers,
      (SELECT count(*) FROM participants WHERE owner_kind='accountless') AS participants,
      (SELECT count(*) FROM device_credentials WHERE authority_kind='accountless') AS devices,
      (SELECT count(*) FROM accountless_upload_owners) AS owners,
      (SELECT count(*) FROM accountless_v11_device_authorizations) AS v11_grants,
      (SELECT count(*) FROM accountless_v12_device_authorizations) AS v12_grants,
      (SELECT count(*) FROM telemetry_transport_participant_floors f
        JOIN participants p ON p.id=f.participant_id WHERE p.owner_kind='accountless') AS floors,
      (SELECT count(*) FROM accountless_enrollment_issuance WHERE singleton=1) AS issuance_rows,
      (SELECT daily_issued FROM accountless_enrollment_issuance WHERE singleton=1) AS daily_issued,
      (SELECT lifetime_issued FROM accountless_enrollment_issuance WHERE singleton=1) AS lifetime_issued,
      (SELECT last_issue_token FROM accountless_enrollment_issuance WHERE singleton=1) AS last_issue_token`).get();
  const parentRows = [counts.ledgers, counts.participants, counts.devices, counts.owners,
    counts.v11_grants, counts.v12_grants, counts.floors].reduce((sum, value) => sum + Number(value), 0);
  if (parentRows === 0) {
    // No parent rows are evidence of an empty accountless family only when its
    // global issuance singleton is also in the never-issued state. Otherwise
    // that state could be orphaned or lost from the subset being rehearsed.
    if (Number(counts.issuance_rows) !== 1
        || !Number.isSafeInteger(Number(counts.daily_issued))
        || Number(counts.daily_issued) !== 0
        || !Number.isSafeInteger(Number(counts.lifetime_issued))
        || Number(counts.lifetime_issued) !== 0
        || counts.last_issue_token !== "") {
      fail("CUTOVER_ACCOUNTLESS_ISSUANCE_STATE_INVALID");
    }
    return true;
  }
  if (Number(counts.v12_grants) === 0) fail("CUTOVER_ACCOUNTLESS_PARENT_FAMILY_UNQUALIFIED");

  const invalidChain = sourceDb.prepare(`SELECT 1
    FROM accountless_v12_device_authorizations a
    LEFT JOIN accountless_enrollment_ledger l ON l.device_id=a.enrollment_device_id
    LEFT JOIN participants p ON p.id=a.participant_id
    LEFT JOIN device_credentials d ON d.id=a.device_credential_id
    LEFT JOIN accountless_upload_owners o ON o.enrollment_device_id=a.enrollment_device_id
    LEFT JOIN accountless_v11_device_authorizations v11 ON v11.enrollment_device_id=a.enrollment_device_id
    LEFT JOIN telemetry_transport_participant_floors f ON f.participant_id=a.participant_id
    WHERE l.device_id IS NULL OR p.id IS NULL OR d.id IS NULL OR o.enrollment_device_id IS NULL
      OR v11.enrollment_device_id IS NULL OR f.participant_id IS NULL
      OR p.owner_kind <> 'accountless' OR p.state <> 'active' OR p.deletion_session_id IS NOT NULL
      OR p.access_token_id IS NOT NULL OR p.access_token_hash IS NOT NULL
      OR p.recovery_token_id IS NOT NULL OR p.recovery_token_hash IS NOT NULL
      OR p.consent_version IS NOT NULL OR p.consented_at IS NOT NULL
      OR p.identity_link_key IS NOT NULL OR p.identity_cooldown_digest IS NOT NULL
      OR d.participant_id <> p.id OR d.authority_kind <> 'accountless' OR d.state <> 'active'
      OR d.accountless_enrollment_device_id <> l.device_id OR d.id <> l.device_id
      OR d.paired_via_pairing_id IS NOT NULL OR d.secret_hash <> l.device_secret_hash
      OR d.social_verified_at IS NOT NULL
      OR l.state <> 'active' OR o.participant_id <> p.id OR o.device_credential_id <> d.id
      OR o.state <> 'active' OR v11.participant_id <> p.id OR v11.device_credential_id <> d.id
      OR v11.state <> 'active' OR a.participant_id <> p.id OR a.device_credential_id <> d.id
      OR a.state NOT IN ('active','revoked')
      OR a.expires_at <> l.expires_at OR a.expires_at <> o.expires_at
      OR a.expires_at <> d.expires_at OR a.expires_at <> v11.expires_at
      OR f.minimum_rank <> 11
      OR l.schema_version <> 'accountless-enrollment-v0.1'
      OR l.policy_version <> 'accountless-opt-out-v1'
      OR l.authorization_basis <> 'accountless-policy-v1'
      OR o.policy_version <> 'accountless-opt-out-v1'
      OR o.authorization_basis <> 'accountless-policy-v1'
      OR v11.telemetry_schema_version <> 'telemetry-contribution-v1.1'
      OR v11.field_dictionary_version <> 'telemetry-v1.1-registry-2026-08-31.1'
      OR v11.privacy_contract_version <> 'ongoing-privacy-safe-telemetry-v1.1'
      OR a.schema_version <> 'accountless-upload-owner-v1.2'
      OR a.policy_version <> 'accountless-telemetry-v1.2-policy-v1'
      OR a.authorization_basis <> 'accountless-policy-v1.2'
      OR a.telemetry_schema_version <> 'telemetry-contribution-v1.2'
      OR a.field_dictionary_version <> 'telemetry-v1.2-registry-2026-09-20.1'
      OR a.privacy_contract_version <> 'ongoing-privacy-safe-telemetry-v1.2'
    LIMIT 1`).get();
  if (invalidChain) fail("CUTOVER_ACCOUNTLESS_AUTHORITY_CHAIN_INVALID");

  const historicalGrant = sourceDb.prepare(`SELECT 1 FROM accountless_v12_device_authorizations
    WHERE state <> 'active' LIMIT 1`).get();
  if (historicalGrant) fail("CUTOVER_ACCOUNTLESS_AUTHORITY_HISTORY_UNQUALIFIED");

  if (Number(counts.issuance_rows) !== 1
      || !Number.isSafeInteger(Number(counts.lifetime_issued))
      || Number(counts.lifetime_issued) < Number(counts.ledgers)) {
    fail("CUTOVER_ACCOUNTLESS_ISSUANCE_STATE_INVALID");
  }
  // Even a source-valid, active chain cannot be copied safely as a subset:
  // importing the global issuance singleton/counter, participant floor and
  // matching PG admission/immutability guarantees needs a separate migration
  // rehearsal and a complete accountless-family transfer plan.
  fail("CUTOVER_ACCOUNTLESS_AUTHORITY_SCHEMA_PARITY_UNQUALIFIED");
}

/** Kept as a narrow compatibility name for existing rehearsal call sites. */
export function assertUnsupportedV12AuthorityRowsAbsent(sourceDb) {
  return assertAccountlessAuthorityTransferPreflight(sourceDb);
}

export function assertV12CutoverGate(coverage) {
  if (!coverage || coverage.v12 !== "available" || !coverage.fullFormatCoverage) {
    fail(coverage?.v12 === "present-but-unsupported" ? "CUTOVER_V12_NOT_SUPPORTED" : "CUTOVER_V12_SOURCE_UNAVAILABLE");
  }
  // The synthetic subset does not transfer authority, publication, retention,
  // analytics, or erasure state needed for a production cutover.
  fail("CUTOVER_V12_NOT_SUPPORTED");
}

function sqliteTables(database) {
  return database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
}

function sqliteInventoryTables(database) {
  return database.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence')
    ORDER BY name`).all().map(row => row.name);
}

function sourceSchemaObjects(database) {
  return database.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE type IN ('table','view','index','trigger') AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence')
    ORDER BY type, name`).all().map(row => ({
    type: row.type,
    name: row.name,
    table: row.tbl_name,
    definitionSha256: row.sql === null ? null : HASH(row.sql),
  }));
}

function classifyCutoverTable(table) {
  if (SOURCE_MIGRATION_LEDGER_TABLES.includes(table)) return "migration-bookkeeping";
  if (table === "sqlite_sequence") return "untransferred-sqlite-sequence-state";
  if (table === "_cf_KV") return "cloudflare-platform-internal-requires-disposition";
  if (FULL_TABLE_IMPORTS.has(table)) return "supported-synthetic-subset";
  if (table === "accountless_v12_device_authorizations") return "untransferred-accountless-v12-authority-parent-families";
  if (table === "pending_quarantine_objects") return "partial-object-reference-import";
  if (table === "deletion_tombstones" || table === "storage_erasure_jobs") return "untransferred-independent-erasure-restore-ledger";
  if (table.startsWith("_authority_")) return "untransferred-owner-restore-authority";
  if (table === "ingestion_analytics_separation") return "untransferred-ingestion-analytics-boundary-state";
  if (table.startsWith("storage_")) return "untransferred-storage-journal-or-revision-state";
  if (table.startsWith("typed_")) return "untransferred-typed-telemetry-schema-or-authority";
  if (table.startsWith("github_")) return "untransferred-release-distribution-state";
  if (table.startsWith("diagnostic_")) return "untransferred-diagnostic-or-audit-state";
  if (table.startsWith("analytics_")) return "untransferred-analytics-publication-or-owner-fence";
  if (IDENTITY_AUTHORITY_TABLES.has(table)) return "untransferred-identity-or-authority";
  if (table.startsWith("telemetry_v12_") || table.startsWith("accountless_v12_")) return "v1.2-runtime-or-publication";
  if (table.startsWith("telemetry_v11_")) return "untransferred-v1.1-publication-state";
  if (table.startsWith("telemetry_v1_")) return "untransferred-v1-admission-or-analytics-state";
  if (table.startsWith("community_")) return "untransferred-analytics-or-publication-state";
  if (table.startsWith("admin_")) return "untransferred-admin-or-audit-state";
  if (table.startsWith("telemetry_") || table === "contributions") return "untransferred-legacy-telemetry-state";
  if (table === "pending_quarantine_objects" || table === "quarantine_reconciliation_state") return "untransferred-object-reconciliation-state";
  if (/^(?:apple_signin|google_signin|sign_in_|sparkle_)/u.test(table)) return "untransferred-authentication-or-release-state";
  if (table === "retention_state" || table === "accountless_public_history_retention") return "untransferred-retention-state";
  if (table === "collection_controls") return "untransferred-collection-control-state";
  return "unclassified-source-table";
}

function inspectSourceFormats(tableNames) {
  const names = new Set(tableNames);
  const observe = expected => {
    const observed = expected.filter(name => names.has(name));
    return Object.freeze({
      observed: observed.length > 0,
      completeKnownTableSet: observed.length === expected.length,
      observedTables: Object.freeze(observed),
      missingKnownTables: Object.freeze(expected.filter(name => !names.has(name))),
    });
  };
  const observedV12Tables = tableNames.filter(name => /^(?:telemetry_v12_|accountless_v12_)/u.test(name));
  const knownV12 = new Set(V12_TABLES);
  const unknownV12Tables = observedV12Tables.filter(name => !knownV12.has(name));
  return Object.freeze({
    v1: observe(V1_TABLES),
    v11: observe(V11_TABLES),
    v12: Object.freeze({
      sourceObserved: observedV12Tables.length > 0,
      observedTableCount: observedV12Tables.length,
      observedTables: Object.freeze(observedV12Tables),
      missingKnownTables: Object.freeze(V12_TABLES.filter(name => !names.has(name))),
      unknownTables: Object.freeze(unknownV12Tables),
      canonicalD1MigrationSchemaPresent: true,
      sourceSchemaQualifiedForTransfer: false,
      syntheticTypedStorageSubsetMapped: true,
      transferMappingImplemented: false,
    }),
  });
}

/**
 * Inventory SQLite schema metadata only. This is safe to run against a local
 * D1 export: it never reads application row values and never claims that the
 * bounded synthetic importer covers production state.
 */
export function inventoryCutoverSource(database, { requireTelemetryFormats = true } = {}) {
  if (!database || typeof database.prepare !== "function") fail("CUTOVER_SOURCE_DATABASE_INVALID");
  const applicationTables = sqliteTables(database);
  const tables = sqliteInventoryTables(database);
  const schemaObjects = sourceSchemaObjects(database);
  const sourceFormatObservation = inspectSourceFormats(applicationTables);
  const schemaObjectsByType = schemaObjects.reduce((counts, item) => {
    counts[item.type] = (counts[item.type] ?? 0) + 1;
    return counts;
  }, {});
  const coverage = (() => {
    if (!requireTelemetryFormats) return { state: "inventory-only", formats: null };
    try {
      const formats = assessCutoverSourceCoverage(applicationTables);
      const state = formats.v12 === "unavailable-in-canonical-d1-migrations"
        ? "known-v1-v1.1-only"
        : "v1-v1.1-v1.2-source-schema-observed";
      return { state, formats };
    }
    catch (error) { return { state: "blocked", gateCode: typeof error?.code === "string" ? error.code : "CUTOVER_SOURCE_COVERAGE_UNKNOWN" }; }
  })();
  const tableCoverage = tables.map(table => Object.freeze({ table, transferState: classifyCutoverTable(table) }));
  const countsByTransferState = tableCoverage.reduce((counts, item) => {
    counts[item.transferState] = (counts[item.transferState] ?? 0) + 1;
    return counts;
  }, {});
  const migrationLedgerTable = SOURCE_MIGRATION_LEDGER_TABLES.find(table => tables.includes(table)) ?? null;
  let migrationNames = [];
  if (migrationLedgerTable) {
    try {
      migrationNames = database.prepare(`SELECT name FROM ${quoteIdentifier(migrationLedgerTable)} ORDER BY name`).all().map(row => row.name);
    } catch {
      // An unrecognized migration ledger is a blocker, not a reason to inspect
      // or print any other source content.
      coverage.state = "blocked";
      coverage.gateCode = "CUTOVER_MIGRATION_LEDGER_UNKNOWN";
    }
    if (!migrationNames.length && coverage.state !== "blocked") {
      coverage.state = "blocked";
      coverage.gateCode = "CUTOVER_MIGRATION_LEDGER_EMPTY";
    }
  } else {
    coverage.state = "blocked";
    coverage.gateCode = "CUTOVER_MIGRATION_LEDGER_MISSING";
  }
  const unsupported = tableCoverage.filter(item => !["migration-bookkeeping", "supported-synthetic-subset"].includes(item.transferState));
  const authorityGaps = tableCoverage.filter(item => item.transferState === "untransferred-identity-or-authority").map(item => item.table);
  const unclassifiedTables = tableCoverage.filter(item => item.transferState === "unclassified-source-table").map(item => item.table);
  const derivedSchemaObjectsNotTransferred = schemaObjects
    .filter(item => item.type !== "table")
    .map(item => Object.freeze({ type: item.type, name: item.name }));
  const blockers = [];
  if (coverage.state === "blocked") blockers.push(Object.freeze({ code: coverage.gateCode }));
  if (unsupported.length) blockers.push(Object.freeze({ code: "CUTOVER_SOURCE_TABLES_UNTRANSFERRED", count: unsupported.length }));
  if (unclassifiedTables.length) blockers.push(Object.freeze({ code: "CUTOVER_SOURCE_TABLES_UNCLASSIFIED", count: unclassifiedTables.length }));
  if (authorityGaps.length) blockers.push(Object.freeze({ code: "CUTOVER_IDENTITY_AUTHORITY_NOT_TRANSFERRED", count: authorityGaps.length }));
  if (derivedSchemaObjectsNotTransferred.length) blockers.push(Object.freeze({ code: "CUTOVER_SOURCE_VIEWS_INDEXES_AND_TRIGGERS_NOT_TRANSFERRED", count: derivedSchemaObjectsNotTransferred.length }));
  const v12Status = coverage.formats?.v12;
  if (requireTelemetryFormats && v12Status !== "available") blockers.push(Object.freeze({ code: v12Status === "present-but-unsupported" ? "CUTOVER_V12_NOT_SUPPORTED" : "CUTOVER_V12_SOURCE_UNAVAILABLE" }));
  blockers.push(Object.freeze({ code: "CUTOVER_R2_OBJECT_INVENTORY_AND_TRANSFER_MISSING" }));
  blockers.push(Object.freeze({ code: "CUTOVER_INDEPENDENT_ERASURE_RESTORE_LEDGER_NOT_TRANSFERRED" }));
  return Object.freeze({
    schemaVersion: "tibotattle-cutover-source-inventory-v1",
    contentFree: true,
    sourceTableCount: tables.length,
    sourceSchemaObjectCount: schemaObjects.length,
    sourceSchemaObjectsByType: Object.freeze(schemaObjectsByType),
    sourceViews: Object.freeze(schemaObjects.filter(item => item.type === "view").map(item => item.name)),
    sourceTriggers: Object.freeze(schemaObjects.filter(item => item.type === "trigger").map(item => item.name)),
    sourceIndexes: Object.freeze(schemaObjects.filter(item => item.type === "index").map(item => item.name)),
    derivedSchemaObjectsNotTransferred: Object.freeze(derivedSchemaObjectsNotTransferred),
    sourceSchemaTransferImplemented: false,
    sourceSchemaSha256: digestRows(schemaObjects),
    migrationLedger: Object.freeze({
      present: migrationLedgerTable !== null,
      table: migrationLedgerTable,
      migrationCount: migrationNames.length,
      latestMigration: migrationNames.at(-1) ?? null,
      sha256: migrationNames.length ? digestRows(migrationNames) : null,
    }),
    sourceCoverage: Object.freeze(coverage),
    observedSourceFormats: sourceFormatObservation,
    countsByTransferState: Object.freeze(countsByTransferState),
    tables: Object.freeze(tableCoverage),
    untransferredTables: Object.freeze(unsupported.map(item => item.table)),
    unclassifiedTables: Object.freeze(unclassifiedTables),
    identityAndAuthorityTablesNotTransferred: Object.freeze(authorityGaps),
    blockers: Object.freeze(blockers),
    objectCoverage: Object.freeze({
      pendingObjectReferenceTable: tables.includes("pending_quarantine_objects") ? "partial-selected-chunk-references-only" : "missing",
      reconciliationStateTransferred: false,
      r2ObjectMetadataInventoried: false,
      r2ObjectBodiesTransferred: false,
    }),
    independentLedger: Object.freeze({
      primaryD1EnrollmentLedgerTablePresent: tables.includes("accountless_enrollment_ledger"),
      separateErasureRestoreLedgerSourcePresent: false,
      targetImportImplemented: false,
    }),
    fullCutoverReady: blockers.length === 0,
  });
}

const DELETION_LEDGER_TABLES = Object.freeze([
  "deletion_tombstones", "identity_reenrollment_cooldowns", "storage_erasure_jobs",
]);

/**
 * Inventory the four production D1 roles together. Inputs are read-only SQLite
 * snapshots/exports and only catalog metadata is inspected. Missing or
 * duplicated stores are reported as blockers; names alone never qualify data
 * for transfer.
 */
export function inventoryCutoverSources(sources) {
  const entries = Array.isArray(sources)
    ? sources
    : sources && typeof sources === "object"
      ? Object.entries(sources).map(([role, database]) => ({ role, database }))
      : null;
  if (!entries || entries.some(entry => !entry || typeof entry.role !== "string" || !entry.database || typeof entry.database.prepare !== "function")) {
    fail("CUTOVER_SOURCE_SET_INVALID");
  }
  const roleCounts = entries.reduce((counts, entry) => {
    counts[entry.role] = (counts[entry.role] ?? 0) + 1;
    return counts;
  }, {});
  const missingRoles = REQUIRED_CUTOVER_SOURCE_ROLES.filter(role => !roleCounts[role]);
  const duplicateRoles = Object.keys(roleCounts).filter(role => roleCounts[role] > 1);
  const unexpectedRoles = Object.keys(roleCounts).filter(role => !REQUIRED_CUTOVER_SOURCE_ROLES.includes(role));
  const stores = entries.map(entry => {
    const inventory = inventoryCutoverSource(entry.database, { requireTelemetryFormats: false });
    return Object.freeze({ role: entry.role, ...inventory });
  });
  const tableLocations = new Map();
  for (const store of stores) {
    for (const item of store.tables) {
      if (SOURCE_INFRASTRUCTURE_TABLES.has(item.table)) continue;
      const locations = tableLocations.get(item.table) ?? [];
      locations.push(store.role);
      tableLocations.set(item.table, locations);
    }
  }
  const multiplyOwnedTables = [...tableLocations.entries()]
    .filter(([, roles]) => new Set(roles).size > 1)
    .map(([table, roles]) => Object.freeze({ table, roles: Object.freeze([...new Set(roles)].sort()) }));
  const allUserTables = [...new Set(stores.flatMap(store => store.tables
    .filter(item => !SOURCE_INFRASTRUCTURE_TABLES.has(item.table))
    .map(item => item.table)))].sort();
  const observedSourceFormats = inspectSourceFormats(allUserTables);
  const ledgerStore = stores.find(store => store.role === "deletionLedger");
  const ledgerTables = new Set(ledgerStore?.tables.map(item => item.table) ?? []);
  const missingDeletionLedgerTables = DELETION_LEDGER_TABLES.filter(table => !ledgerTables.has(table));
  const tableCoverageCounts = stores.reduce((counts, store) => {
    for (const [state, count] of Object.entries(store.countsByTransferState)) counts[state] = (counts[state] ?? 0) + count;
    return counts;
  }, {});
  const schemaObjectCoverageCounts = stores.reduce((counts, store) => {
    for (const [type, count] of Object.entries(store.sourceSchemaObjectsByType)) counts[type] = (counts[type] ?? 0) + count;
    return counts;
  }, {});
  const derivedSchemaObjectCount = stores.reduce((count, store) => count + store.derivedSchemaObjectsNotTransferred.length, 0);
  const blockers = [];
  if (missingRoles.length) blockers.push(Object.freeze({ code: "CUTOVER_SOURCE_ROLE_MISSING", roles: Object.freeze(missingRoles) }));
  if (duplicateRoles.length) blockers.push(Object.freeze({ code: "CUTOVER_SOURCE_ROLE_DUPLICATED", roles: Object.freeze(duplicateRoles) }));
  if (unexpectedRoles.length) blockers.push(Object.freeze({ code: "CUTOVER_SOURCE_ROLE_UNKNOWN", roles: Object.freeze(unexpectedRoles) }));
  if (multiplyOwnedTables.length) blockers.push(Object.freeze({ code: "CUTOVER_SOURCE_TABLE_OWNERSHIP_UNRESOLVED", count: multiplyOwnedTables.length }));
  if (stores.some(store => store.sourceCoverage.state === "blocked")) blockers.push(Object.freeze({ code: "CUTOVER_SOURCE_MIGRATION_HISTORY_UNQUALIFIED" }));
  if (observedSourceFormats.v12.sourceObserved) {
    blockers.push(Object.freeze({ code: "CUTOVER_V12_SOURCE_PRESENT_SCHEMA_AND_TRANSFER_UNQUALIFIED", tableCount: observedSourceFormats.v12.observedTableCount }));
  } else {
    blockers.push(Object.freeze({ code: "CUTOVER_V12_SOURCE_UNAVAILABLE" }));
  }
  if (!observedSourceFormats.v1.completeKnownTableSet || !observedSourceFormats.v11.completeKnownTableSet) {
    blockers.push(Object.freeze({ code: "CUTOVER_TELEMETRY_FORMAT_CATALOG_INCOMPLETE" }));
  }
  const unclassifiedCount = stores.reduce((count, store) => count + (store.countsByTransferState["unclassified-source-table"] ?? 0), 0);
  const untransferredTableCount = stores.reduce((count, store) => count + store.untransferredTables.length, 0);
  const identityAuthorityCount = stores.reduce((count, store) => count + store.identityAndAuthorityTablesNotTransferred.length, 0);
  const analyticsTableCount = tableCoverageCounts["untransferred-analytics-publication-or-owner-fence"] ?? 0;
  if (untransferredTableCount) blockers.push(Object.freeze({ code: "CUTOVER_SOURCE_TABLES_UNTRANSFERRED", count: untransferredTableCount }));
  if (unclassifiedCount) blockers.push(Object.freeze({ code: "CUTOVER_SOURCE_TABLES_UNCLASSIFIED", count: unclassifiedCount }));
  if (identityAuthorityCount) blockers.push(Object.freeze({ code: "CUTOVER_IDENTITY_AND_GRANTS_NOT_TRANSFERRED", count: identityAuthorityCount }));
  if (analyticsTableCount) blockers.push(Object.freeze({ code: "CUTOVER_ANALYTICS_STATE_NOT_TRANSFERRED", count: analyticsTableCount }));
  if (derivedSchemaObjectCount) blockers.push(Object.freeze({ code: "CUTOVER_SOURCE_VIEWS_INDEXES_AND_TRIGGERS_NOT_TRANSFERRED", count: derivedSchemaObjectCount }));
  if (missingDeletionLedgerTables.length) blockers.push(Object.freeze({ code: "CUTOVER_DELETION_LEDGER_SOURCE_INCOMPLETE", missingTables: Object.freeze(missingDeletionLedgerTables) }));
  blockers.push(Object.freeze({ code: "CUTOVER_D1_SOURCE_TABLE_TRANSFER_NOT_IMPLEMENTED" }));
  blockers.push(Object.freeze({ code: "CUTOVER_R2_OBJECT_INVENTORY_AND_TRANSFER_MISSING" }));
  blockers.push(Object.freeze({ code: "CUTOVER_INDEPENDENT_ERASURE_RESTORE_LEDGER_NOT_TRANSFERRED" }));
  return Object.freeze({
    schemaVersion: "tibotattle-cutover-four-source-inventory-v1",
    contentFree: true,
    requiredSourceRoles: REQUIRED_CUTOVER_SOURCE_ROLES,
    missingSourceRoles: Object.freeze(missingRoles),
    sourceRoleCounts: Object.freeze(roleCounts),
    sourceStores: Object.freeze(stores),
    sourceTableCoverageCounts: Object.freeze(tableCoverageCounts),
    sourceSchemaObjectCoverageCounts: Object.freeze(schemaObjectCoverageCounts),
    sourceSchemaTransferImplemented: false,
    multiplyOwnedTables: Object.freeze(multiplyOwnedTables),
    observedSourceFormats,
    deletionLedger: Object.freeze({
      sourcePresent: Boolean(ledgerStore),
      sourceTablesObserved: Object.freeze(ledgerStore?.tables.map(item => item.table) ?? []),
      requiredTablesPresent: missingDeletionLedgerTables.length === 0,
      missingTables: Object.freeze(missingDeletionLedgerTables),
      targetTransferImplemented: false,
    }),
    r2: Object.freeze({
      sourceInventoryProvided: false,
      objectMetadataTransferred: false,
      objectBodiesTransferred: false,
      objectCount: null,
      bytes: null,
    }),
    blockers: Object.freeze(blockers),
    fullCutoverReady: blockers.length === 0,
  });
}

function assertSourceSchema(database) {
  for (const [table, expected] of Object.entries(SOURCE_TABLES)) {
    const actual = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
    if (actual.length !== expected.length || actual.some((column, index) => {
      const name = expected[index];
      const expectedType = SOURCE_INTEGER_COLUMNS[table]?.has(name) ? "INTEGER"
        : SOURCE_REAL_COLUMNS[table]?.has(name) ? "REAL"
          : SOURCE_BLOB_COLUMNS[table]?.has(name) ? "BLOB" : "TEXT";
      return column.name !== name || column.type !== expectedType;
    })) fail("CUTOVER_SOURCE_SCHEMA_DRIFT");
  }
}

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function digestRows(rows) {
  return HASH(JSON.stringify(canonical(rows)));
}

function primaryOrder(table) {
  switch (table) {
    case "pending_objects": return ["contribution_id"];
    case "telemetry_v1_device_consents": return ["participant_id", "device_id"];
    case "telemetry_v1_chunks": return ["id"];
    case "telemetry_v1_records": return ["id"];
    case "telemetry_v11_device_consents": return ["participant_id", "device_id"];
    case "telemetry_v11_day_manifests": return ["id"];
    case "telemetry_v11_chunks": return ["id"];
    case "telemetry_v11_records": return ["chunk_id", "occurrence_id"];
    case "typed_telemetry_dictionary": return ["id"];
    case "telemetry_v12_runtime": return ["id"];
    case "telemetry_v12_device_capabilities": return ["participant_id", "device_id"];
    case "telemetry_v12_day_manifests": return ["id"];
    case "telemetry_v12_chunks": return ["id"];
    case "telemetry_v12_attributions": return ["id"];
    case "telemetry_v12_records": return ["id"];
    case "telemetry_v12_usage": return ["record_id"];
    case "telemetry_v12_quota": return ["record_id"];
    case "telemetry_v12_session_tools": return ["record_id", "tool_class_id"];
    case "telemetry_v12_domain_predecessors": return ["token_hash"];
    case "telemetry_v12_domains": return ["id"];
    case "telemetry_v12_domain_days": return ["generation_id", "observed_day"];
    case "telemetry_v12_domain_heads": return ["participant_id"];
    default: fail("CUTOVER_TABLE_UNSUPPORTED");
  }
}

function byteExpression(columns, tableAlias = null) {
  const prefix = tableAlias ? `${quoteIdentifier(tableAlias)}.` : "";
  return columns.map(column => `COALESCE(length(CAST(${prefix}${quoteIdentifier(column)} AS BLOB)),0)`).join("+");
}

function sourceTableQuery(table, afterKey = null, { metadataOnly = false } = {}) {
  const columns = SOURCE_TABLES[table];
  if (!columns) fail("CUTOVER_TABLE_UNSUPPORTED");
  const keys = primaryOrder(table);
  const predicate = afterKey ? `WHERE (${keys.map(quoteIdentifier).join(",")}) > (${keys.map(() => "?").join(",")})` : "";
  const selected = metadataOnly ? keys.map(quoteIdentifier).join(",") : columns.map(quoteIdentifier).join(",");
  return {
    sql: `SELECT ${selected}, (${byteExpression(columns)}) AS __source_bytes FROM ${quoteIdentifier(table)} ${predicate} ORDER BY ${keys.map(quoteIdentifier).join(",")}`,
    params: afterKey ?? [],
  };
}

function pendingObjectsQuery(afterKey = null, { metadataOnly = false } = {}) {
  const keys = primaryOrder("pending_objects");
  const predicate = afterKey ? `WHERE (c.contribution_id) > (?)` : "";
  const selection = metadataOnly
    ? `c.contribution_id AS ${quoteIdentifier("contribution_id")}`
    : `c.participant_id, c.device_id, c.contribution_id, p.r2_key AS object_key,
      c.object_kind, p.registered_at, p.reconciliation_state, p.reconciliation_lease_id,
      p.contribution_id AS __registered_contribution_id, p.r2_key AS __registered_object_key,
      p.object_kind AS __registered_object_kind`;
  const bytes = [
    "c.participant_id", "c.device_id", "c.contribution_id", "p.r2_key", "c.object_kind",
    "p.registered_at", "p.reconciliation_state", "p.reconciliation_lease_id",
  ].map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join("+");
  const sql = `WITH chunks AS (
    SELECT id AS contribution_id, participant_id, device_id, r2_key, 'telemetry_v1' AS object_kind
      FROM telemetry_v1_chunks
    UNION ALL
    SELECT id AS contribution_id, participant_id, device_id, r2_key, 'telemetry_v11' AS object_kind
      FROM telemetry_v11_chunks
    UNION ALL
    SELECT id AS contribution_id, participant_id, device_id, r2_key, 'telemetry_v12' AS object_kind
      FROM telemetry_v12_chunks
  )
  SELECT ${selection}, (${bytes}) AS __source_bytes
    FROM chunks c LEFT JOIN pending_quarantine_objects p ON p.contribution_id=c.contribution_id
    ${predicate} ORDER BY ${keys.map(key => `c.${quoteIdentifier(key)}`).join(",")}`;
  return { sql, params: afterKey ?? [] };
}

function mapSourceRow(table, row) {
  if (table !== "pending_objects") return row;
  if (row.__registered_contribution_id !== row.contribution_id
      || row.__registered_object_key === null || row.__registered_object_key !== row.object_key
      || row.__registered_object_kind !== "telemetry" || row.reconciliation_state !== "registered"
      || row.reconciliation_lease_id !== null) fail("CUTOVER_PENDING_OBJECT_INVALID");
  return {
    participant_id: row.participant_id,
    device_id: row.device_id,
    contribution_id: row.contribution_id,
    object_key: row.object_key,
    object_kind: row.object_kind,
    registered_at: row.registered_at,
    reconciliation_state: row.reconciliation_state,
    reconciliation_lease_id: row.reconciliation_lease_id,
  };
}

function sourceKey(table, row) {
  return primaryOrder(table).map(column => row[column]);
}

function readSourceBatch(database, table, afterKey = null) {
  const query = table === "pending_objects" ? pendingObjectsQuery(afterKey) : sourceTableQuery(table, afterKey);
  const statement = database.prepare(query.sql);
  const rows = [];
  let bytes = 0;
  for (const selected of statement.iterate(...query.params)) {
    const rowBytes = Number(selected.__source_bytes);
    if (!Number.isSafeInteger(rowBytes) || rowBytes < 0 || rowBytes > IMPORT_SOURCE_MAX_ROW_BYTES) fail("CUTOVER_SOURCE_ROW_BYTE_LIMIT");
    if (rows.length > 0 && (rows.length >= IMPORT_BATCH_MAX_ROWS || bytes + rowBytes > IMPORT_BATCH_MAX_BYTES)) break;
    if (rowBytes > IMPORT_BATCH_MAX_BYTES && rows.length > 0) break;
    bytes += rowBytes;
    const row = { ...selected };
    delete row.__source_bytes;
    rows.push(mapSourceRow(table, row));
    if (rows.length >= IMPORT_BATCH_MAX_ROWS || bytes >= IMPORT_BATCH_MAX_BYTES) break;
  }
  return { rows, bytes };
}

function assertSourceRowsBounded(database, table) {
  const query = table === "pending_objects" ? pendingObjectsQuery(null, { metadataOnly: true }) : sourceTableQuery(table, null, { metadataOnly: true });
  const result = database.prepare(`SELECT COALESCE(MAX(__source_bytes),0) AS max_bytes FROM (${query.sql}) AS source_rows`).get(...query.params);
  if (!Number.isSafeInteger(Number(result.max_bytes)) || Number(result.max_bytes) > IMPORT_SOURCE_MAX_ROW_BYTES) fail("CUTOVER_SOURCE_ROW_BYTE_LIMIT");
}

function rowValues(row, columns) { return columns.map(column => row[column]); }

function normalizedRow(row, columns, table) {
  const value = {};
  for (const column of columns) {
    const original = row[column];
    const type = TARGET_TYPES[table]?.[column];
    if (type === "date" && original !== null) {
      value[column] = original instanceof Date ? original.toISOString().slice(0, 10) : String(original).slice(0, 10);
    } else if (type === "bigint" && original !== null) {
      if (typeof original === "number" && !Number.isSafeInteger(original)) fail("CUTOVER_INTEGER_RANGE");
      try { value[column] = BigInt(original).toString(); } catch { fail("CUTOVER_INTEGER_INVALID"); }
    } else value[column] = canonical(original);
  }
  for (const column of ["record_json", "manifest_json", "legacy_record_json"]) {
    if (typeof value[column] === "string") {
      try { value[column] = canonical(JSON.parse(value[column])); } catch { /* Text JSON remains exact text. */ }
    }
  }
  return value;
}

function createRowsDigest() {
  const hash = createHash("sha256");
  hash.update("[");
  let count = 0;
  return {
    update(row) {
      if (count > 0) hash.update(",");
      hash.update(JSON.stringify(canonical(row)));
      count += 1;
    },
    digest() {
      hash.update("]");
      return hash.digest("hex");
    },
    get count() { return count; },
  };
}

function advancePrefixChain(previous, row) {
  return HASH(`${previous}\0${JSON.stringify(canonical(row))}`);
}

function sourceFinalRow(table, row) {
  return normalizedRow(row, TARGET_COLUMNS[table], table);
}

function sourceInsertRow(table, row) {
  if (table !== "telemetry_v11_day_manifests" && table !== "telemetry_v12_day_manifests") return row;
  return { ...row, state: "staged", ready_at: null };
}

function sourceNormalizedForInsert(table, row) {
  return normalizedRow(sourceInsertRow(table, row), TARGET_COLUMNS[table], table);
}

function sourceDescriptor(database, table) {
  assertSourceRowsBounded(database, table);
  const hash = createRowsDigest();
  let importPrefixChainSha256 = EMPTY_PREFIX_CHAIN;
  let sourceBytes = 0;
  let afterKey = null;
  for (;;) {
    const batch = readSourceBatch(database, table, afterKey);
    if (batch.rows.length === 0) break;
    sourceBytes += batch.bytes;
    if (!Number.isSafeInteger(sourceBytes)) fail("CUTOVER_SOURCE_BYTE_COUNT_RANGE");
    for (const row of batch.rows) {
      hash.update(sourceFinalRow(table, row));
      importPrefixChainSha256 = advancePrefixChain(importPrefixChainSha256, sourceNormalizedForInsert(table, row));
    }
    afterKey = sourceKey(table, batch.rows.at(-1));
  }
  return Object.freeze({ rowCount: hash.count, sourceBytes, sha256: hash.digest(), importPrefixChainSha256 });
}

function sourceDescriptorSet(database) {
  const descriptors = Object.fromEntries(IMPORT_ORDER.map(table => [table, sourceDescriptor(database, table)]));
  const schemaSha256 = digestRows(sourceSchemaObjects(database));
  const migrationNames = SOURCE_MIGRATION_LEDGER_TABLES
    .filter(table => sqliteTables(database).includes(table))
    .flatMap(table => database.prepare(`SELECT name FROM ${quoteIdentifier(table)} ORDER BY name`).all().map(row => `${table}:${row.name}`));
  const migrationHistorySha256 = digestRows(migrationNames);
  const fingerprintSha256 = HASH(JSON.stringify({ schemaSha256, migrationHistorySha256, descriptors }));
  return Object.freeze({ descriptors: Object.freeze(descriptors), schemaSha256, migrationHistorySha256, fingerprintSha256 });
}

function targetByteExpression(columns) {
  return columns.map(column => `COALESCE(octet_length(${quoteIdentifier(column)}::text),0)`).join("+");
}

function targetPagePredicates(table, afterKey, throughKey, firstParameter = 1) {
  const keys = primaryOrder(table);
  const tuple = `(${keys.map(quoteIdentifier).join(",")})`;
  const conditions = [];
  const values = [];
  let next = firstParameter;
  if (afterKey) {
    conditions.push(`${tuple} > (${keys.map(() => `$${next++}`).join(",")})`);
    values.push(...afterKey);
  }
  if (throughKey) {
    conditions.push(`${tuple} <= (${keys.map(() => `$${next++}`).join(",")})`);
    values.push(...throughKey);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", values, nextParameter: next };
}

async function targetBatch(client, schema, table, columns, afterKey = null, throughKey = null) {
  const targetTable = targetTableName(table);
  const keys = primaryOrder(table);
  const predicates = targetPagePredicates(table, afterKey, throughKey);
  const metadata = await client.query(`SELECT ${keys.map(quoteIdentifier).join(",")}, (${targetByteExpression(columns)}) AS __row_bytes
    FROM ${quoteIdentifier(schema)}.${quoteIdentifier(targetTable)} ${predicates.where}
    ORDER BY ${keys.map(quoteIdentifier).join(",")} LIMIT $${predicates.nextParameter}`, [...predicates.values, IMPORT_BATCH_MAX_ROWS]);
  const selectedKeys = [];
  let bytes = 0;
  for (const row of metadata.rows) {
    const rowBytes = Number(row.__row_bytes);
    if (!Number.isSafeInteger(rowBytes) || rowBytes < 0 || rowBytes > IMPORT_SOURCE_MAX_ROW_BYTES) fail("CUTOVER_TARGET_ROW_BYTE_LIMIT");
    if (selectedKeys.length > 0 && (selectedKeys.length >= IMPORT_BATCH_MAX_ROWS || bytes + rowBytes > IMPORT_BATCH_MAX_BYTES)) break;
    if (rowBytes > IMPORT_BATCH_MAX_BYTES && selectedKeys.length > 0) break;
    selectedKeys.push(keys.map(key => row[key]));
    bytes += rowBytes;
    if (bytes >= IMPORT_BATCH_MAX_BYTES) break;
  }
  if (selectedKeys.length === 0) return { rows: [], keys: [], bytes: 0 };
  const lastKey = selectedKeys.at(-1);
  const boundedPredicates = targetPagePredicates(table, afterKey, lastKey);
  const result = await client.query(`SELECT ${columns.map(quoteIdentifier).join(",")}
    FROM ${quoteIdentifier(schema)}.${quoteIdentifier(targetTable)} ${boundedPredicates.where}
    ORDER BY ${keys.map(quoteIdentifier).join(",")}`, boundedPredicates.values);
  if (result.rows.length !== selectedKeys.length) fail("CUTOVER_TARGET_PAGE_CHANGED");
  return { rows: result.rows.map(row => normalizedRow(row, columns, table)), keys: selectedKeys, bytes };
}

async function scanTargetTable(client, schema, table, { throughKey = null } = {}) {
  const columns = TARGET_COLUMNS[table];
  const hash = createRowsDigest();
  let prefixChainSha256 = EMPTY_PREFIX_CHAIN;
  let afterKey = null;
  let sourceBytes = 0;
  for (;;) {
    const batch = await targetBatch(client, schema, table, columns, afterKey, throughKey);
    if (batch.rows.length === 0) break;
    sourceBytes += batch.bytes;
    for (const row of batch.rows) {
      hash.update(row);
      prefixChainSha256 = advancePrefixChain(prefixChainSha256, row);
    }
    afterKey = batch.keys.at(-1);
    if (throughKey && JSON.stringify(canonical(afterKey)) === JSON.stringify(canonical(throughKey))) break;
  }
  return Object.freeze({ rowCount: hash.count, sourceBytes, sha256: hash.digest(), prefixChainSha256 });
}

function sourcePrefix(database, table, throughKey) {
  if (!Array.isArray(throughKey) || throughKey.length !== primaryOrder(table).length) fail("CUTOVER_CHECKPOINT_CURSOR_INVALID");
  const hash = createRowsDigest();
  let prefixChainSha256 = EMPTY_PREFIX_CHAIN;
  let afterKey = null;
  for (;;) {
    const batch = readSourceBatch(database, table, afterKey);
    if (batch.rows.length === 0) fail("CUTOVER_CHECKPOINT_CURSOR_MISSING");
    let found = false;
    for (const row of batch.rows) {
      const key = sourceKey(table, row);
      const normalized = sourceNormalizedForInsert(table, row);
      hash.update(normalized);
      prefixChainSha256 = advancePrefixChain(prefixChainSha256, normalized);
      if (JSON.stringify(canonical(key)) === JSON.stringify(canonical(throughKey))) {
        found = true;
        break;
      }
    }
    if (found) return Object.freeze({ rowCount: hash.count, prefixChainSha256 });
    afterKey = sourceKey(table, batch.rows.at(-1));
  }
}

function verifyDescriptor(label, expected, actual) {
  if (!expected || expected.rowCount !== actual.rowCount || expected.sha256 !== actual.sha256) fail(`CUTOVER_READBACK_MISMATCH_${label.toUpperCase()}`);
}

async function targetMustBeEmpty(client, schema) {
  for (const table of IMPORT_ORDER) {
    const result = await client.query(`SELECT count(*)::int AS n FROM ${quoteIdentifier(schema)}.${quoteIdentifier(targetTableName(table))}`);
    if (table === "telemetry_v12_runtime") {
      if (result.rows[0]?.n !== 1) fail("CUTOVER_TARGET_NOT_EMPTY");
      await assertV12RuntimeBootstrap(client, schema);
      continue;
    }
    if (result.rows[0]?.n !== 0) fail("CUTOVER_TARGET_NOT_EMPTY");
  }
}

async function assertV12RuntimeBootstrap(client, schema) {
  const s = quoteIdentifier(schema);
  const typed = await client.query(`SELECT id, schema_version, envelope_schema_version,
      field_dictionary_version, privacy_contract_version, state, policy_revision,
      max_day_chunks, max_chunk_records, max_day_bytes, changed_at
    FROM ${s}.telemetry_v12_typed_runtime`);
  const legacy = await client.query(`SELECT id, state, revision, changed_at FROM ${s}.telemetry_v12_runtime`);
  const epoch = "1970-01-01T00:00:00.000Z";
  const typedRow = typed.rows[0];
  const legacyRow = legacy.rows[0];
  if (typed.rowCount !== 1 || typedRow.id !== 1
      || typedRow.schema_version !== "telemetry-contribution-v1.2"
      || typedRow.envelope_schema_version !== "telemetry-envelope-v1.2"
      || typedRow.field_dictionary_version !== "telemetry-v1.2-registry-2026-09-20.1"
      || typedRow.privacy_contract_version !== "ongoing-privacy-safe-telemetry-v1.2"
      || typedRow.state !== "staged" || typedRow.policy_revision !== 1
      || typedRow.max_day_chunks !== 4096 || typedRow.max_chunk_records !== 200
      || typedRow.max_day_bytes !== 64_000_000
      || canonical(typedRow.changed_at) !== epoch
      || legacy.rowCount !== 1 || legacyRow.id !== 1 || legacyRow.state !== "staged"
      || legacyRow.revision !== 0 || canonical(legacyRow.changed_at) !== epoch) {
    fail("CUTOVER_TARGET_NOT_EMPTY");
  }
  return true;
}

async function validateTargetSchemas(client, schema) {
  for (const [table, expectedTypes] of Object.entries(TARGET_TYPES)) {
    const result = await client.query(`SELECT column_name, data_type, ordinal_position FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [schema, targetTableName(table)]);
    const expectedColumns = Object.keys(expectedTypes);
    if (result.rows.length !== expectedColumns.length || result.rows.some((row, index) => (
      row.column_name !== expectedColumns[index]
      || row.data_type !== expectedTypes[expectedColumns[index]]
      || Number(row.ordinal_position) !== index + 1
    ))) fail("CUTOVER_TARGET_SCHEMA_DRIFT");
  }
}

function sourceAuthorityScope(sourceDb) {
  const result = sourceDb.prepare(`SELECT participant_id, device_id FROM telemetry_v1_chunks
    UNION SELECT participant_id, device_id FROM telemetry_v11_chunks
    UNION SELECT participant_id, device_id FROM telemetry_v12_chunks LIMIT 2`).all();
  const participantIds = [...new Set(result.map(row => row.participant_id))];
  const deviceIds = [...new Set(result.map(row => row.device_id))];
  if (participantIds.length !== 1 || deviceIds.length !== 1) fail("CUTOVER_FIXTURE_SCOPE_INVALID");
  return Object.freeze({ participantId: participantIds[0], deviceId: deviceIds[0] });
}

async function targetPrerequisitesExist(client, schema, scope) {
  const participant = await client.query(`SELECT 1 FROM ${quoteIdentifier(schema)}.participants WHERE id=$1 AND state='active'`, [scope.participantId]);
  const device = await client.query(`SELECT 1 FROM ${quoteIdentifier(schema)}.device_credentials WHERE id=$1 AND participant_id=$2 AND state='active'`, [scope.deviceId, scope.participantId]);
  if (participant.rowCount !== 1 || device.rowCount !== 1) fail("CUTOVER_TARGET_PREREQUISITE_MISSING");
}

async function assertTransportFloorNotHigher(client, schema, sourceDb, participantId) {
  const source = sourceDb.prepare("SELECT minimum_rank FROM telemetry_transport_participant_floors WHERE participant_id=?").get(participantId);
  const target = await client.query(`SELECT minimum_rank FROM ${quoteIdentifier(schema)}.telemetry_transport_participant_floors WHERE participant_id=$1`, [participantId]);
  if (!source || target.rowCount !== 1) fail("CUTOVER_TARGET_PREREQUISITE_MISSING");
  if (target.rows[0].minimum_rank > source.minimum_rank) fail("CUTOVER_IMPORT_FAILED");
}

async function finalizeSyntheticTransportFloor(client, schema, sourceDb, participantId) {
  const source = sourceDb.prepare("SELECT minimum_rank, revision, changed_at FROM telemetry_transport_participant_floors WHERE participant_id=?").get(participantId);
  if (!source || !Number.isSafeInteger(source.minimum_rank) || !Number.isSafeInteger(source.revision)) fail("CUTOVER_SOURCE_FLOOR_MISSING");
  const s = quoteIdentifier(schema);
  const target = await client.query(`SELECT minimum_rank, revision FROM ${s}.telemetry_transport_participant_floors WHERE participant_id=$1 FOR UPDATE`, [participantId]);
  if (target.rowCount !== 1) fail("CUTOVER_TARGET_PREREQUISITE_MISSING");
  if (target.rows[0].minimum_rank !== source.minimum_rank || target.rows[0].revision !== source.revision) {
    await client.query(`UPDATE ${s}.telemetry_transport_participant_floors SET minimum_rank=$2, revision=$3, changed_at=$4 WHERE participant_id=$1`, [participantId, source.minimum_rank, source.revision, source.changed_at]);
  }
  const final = await client.query(`SELECT minimum_rank, revision, changed_at FROM ${s}.telemetry_transport_participant_floors WHERE participant_id=$1`, [participantId]);
  if (final.rows[0]?.minimum_rank !== source.minimum_rank || final.rows[0]?.revision !== source.revision
      || canonical(final.rows[0]?.changed_at) !== canonical(new Date(source.changed_at))) fail("CUTOVER_TARGET_FLOOR_MISMATCH");
}

async function writeRowsBatch(client, schema, rows, table) {
  const targetTable = targetTableName(table);
  const columns = TARGET_COLUMNS[table];
  if (!columns || rows.length === 0) return;
  if (table === "telemetry_v12_runtime") {
    if (rows.length !== 1 || rows[0].id !== 1) fail("CUTOVER_V12_RUNTIME_CARDINALITY");
    const row = rows[0];
    const s = quoteIdentifier(schema);
    const typed = await client.query(`UPDATE ${s}.telemetry_v12_typed_runtime SET
        schema_version=$2, envelope_schema_version=$3, field_dictionary_version=$4,
        privacy_contract_version=$5, state=$6, policy_revision=$7,
        max_day_chunks=$8, max_chunk_records=$9, max_day_bytes=$10, changed_at=$11
      WHERE id=$1`, [row.id, row.schema_version, row.envelope_schema_version,
      row.field_dictionary_version, row.privacy_contract_version, row.state,
      row.policy_revision, row.max_day_chunks, row.max_chunk_records,
      row.max_day_bytes, row.changed_at]);
    const legacy = await client.query(`UPDATE ${s}.telemetry_v12_runtime
      SET state=$2, revision=$3, changed_at=$4 WHERE id=$1`,
    [row.id, row.state, row.policy_revision, row.changed_at]);
    if (typed.rowCount !== 1 || legacy.rowCount !== 1) fail("CUTOVER_V12_RUNTIME_MIRROR_MISMATCH");
    return;
  }
  const params = [];
  const groups = rows.map(row => {
    const values = rowValues(row, columns);
    const markers = values.map(value => {
      params.push(value);
      return `$${params.length}`;
    });
    return `(${markers.join(",")})`;
  });
  await client.query(`INSERT INTO ${quoteIdentifier(schema)}.${quoteIdentifier(targetTable)} (${columns.map(quoteIdentifier).join(",")}) VALUES ${groups.join(",")}`, params);
}

async function advanceV1IdentitySequence(client, schema, sourceDb) {
  const maximum = Number(sourceDb.prepare("SELECT COALESCE(MAX(id),0) AS maximum FROM telemetry_v1_records").get().maximum);
  if (!Number.isSafeInteger(maximum) || maximum < 0) fail("CUTOVER_IDENTITY_VALUE_INVALID");
  if (maximum >= Number.MAX_SAFE_INTEGER) fail("CUTOVER_IDENTITY_SEQUENCE_EXHAUSTED");
  if (maximum > 0) {
    const nextValue = maximum + 1;
    await client.query(`ALTER TABLE ${quoteIdentifier(schema)}.telemetry_v1_records ALTER COLUMN id RESTART WITH ${nextValue}`);
  }
  return maximum;
}

function journalTable(schema, table) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

async function createResumeJournal(client, schema, fingerprintSha256, descriptors) {
  const runTable = journalTable(schema, REHEARSAL_RUN_TABLE);
  const runExists = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [`${schema}.${REHEARSAL_RUN_TABLE}`]);
  if (!runExists.rows[0]?.present) {
    await targetMustBeEmpty(client, schema);
    await client.query("BEGIN");
    try {
      await client.query(`CREATE TABLE ${runTable} (
        singleton integer PRIMARY KEY CHECK (singleton = 1),
        source_fingerprint_sha256 text NOT NULL,
        state text NOT NULL CHECK (state IN ('copying', 'complete'))
      )`);
      await client.query(`CREATE TABLE ${journalTable(schema, REHEARSAL_CHECKPOINT_TABLE)} (
        table_name text PRIMARY KEY,
        expected_count bigint NOT NULL,
        expected_source_bytes bigint NOT NULL,
        expected_sha256 text NOT NULL,
        expected_import_chain_sha256 text NOT NULL,
        last_key jsonb,
        imported_count bigint NOT NULL DEFAULT 0,
        prefix_chain_sha256 text NOT NULL,
        state text NOT NULL CHECK (state IN ('copying', 'copied'))
      )`);
      await client.query(`CREATE TABLE ${journalTable(schema, REHEARSAL_MANIFEST_TABLE)} (
        manifest_id text PRIMARY KEY,
        ready_at timestamp with time zone NOT NULL
      )`);
      await client.query(`INSERT INTO ${runTable}(singleton, source_fingerprint_sha256, state) VALUES (1, $1, 'copying')`, [fingerprintSha256]);
      const checkpointTable = journalTable(schema, REHEARSAL_CHECKPOINT_TABLE);
      for (const table of IMPORT_ORDER) {
        const expected = descriptors[table];
        await client.query(`INSERT INTO ${checkpointTable}
          (table_name, expected_count, expected_source_bytes, expected_sha256, expected_import_chain_sha256, prefix_chain_sha256, state)
          VALUES ($1,$2,$3,$4,$5,$6,'copying')`, [table, expected.rowCount, expected.sourceBytes, expected.sha256, expected.importPrefixChainSha256, EMPTY_PREFIX_CHAIN]);
      }
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Keep the original classification. */ }
      throw error;
    }
    return;
  }

  for (const table of [REHEARSAL_CHECKPOINT_TABLE, REHEARSAL_MANIFEST_TABLE]) {
    const exists = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [`${schema}.${table}`]);
    if (!exists.rows[0]?.present) fail("CUTOVER_CHECKPOINT_SCHEMA_INVALID");
  }
  const run = await client.query(`SELECT source_fingerprint_sha256, state FROM ${runTable} WHERE singleton=1`);
  if (run.rowCount !== 1) fail("CUTOVER_CHECKPOINT_SCHEMA_INVALID");
  if (run.rows[0].state === "complete") fail("CUTOVER_TARGET_NOT_EMPTY");
  if (run.rows[0].source_fingerprint_sha256 !== fingerprintSha256) fail("CUTOVER_SOURCE_FINGERPRINT_MISMATCH");
  const checkpointTable = journalTable(schema, REHEARSAL_CHECKPOINT_TABLE);
  for (const table of IMPORT_ORDER) {
    const expected = descriptors[table];
    const actual = await client.query(`SELECT expected_count, expected_source_bytes, expected_sha256,
      expected_import_chain_sha256 FROM ${checkpointTable} WHERE table_name=$1`, [table]);
    const row = actual.rows[0];
    if (actual.rowCount !== 1 || Number(row.expected_count) !== expected.rowCount
        || Number(row.expected_source_bytes) !== expected.sourceBytes
        || row.expected_sha256 !== expected.sha256
        || row.expected_import_chain_sha256 !== expected.importPrefixChainSha256) fail("CUTOVER_CHECKPOINT_SOURCE_MISMATCH");
  }
}

async function checkpointForTable(client, schema, table) {
  const result = await client.query(`SELECT last_key, imported_count, prefix_chain_sha256, state
    FROM ${journalTable(schema, REHEARSAL_CHECKPOINT_TABLE)} WHERE table_name=$1`, [table]);
  if (result.rowCount !== 1) fail("CUTOVER_CHECKPOINT_MISSING");
  const row = result.rows[0];
  return Object.freeze({ lastKey: row.last_key, importedCount: Number(row.imported_count), prefixChainSha256: row.prefix_chain_sha256, state: row.state });
}

async function verifyCheckpointPrefix(client, sourceDb, schema, table, checkpoint, descriptor) {
  const count = await client.query(`SELECT count(*)::text AS n FROM ${quoteIdentifier(schema)}.${quoteIdentifier(targetTableName(table))}`);
  const expectedTargetCount = table === "telemetry_v12_runtime"
    ? Math.max(checkpoint.importedCount, 1)
    : checkpoint.importedCount;
  if (Number(count.rows[0]?.n) !== expectedTargetCount) fail("CUTOVER_CHECKPOINT_TARGET_COUNT_MISMATCH");
  if (checkpoint.importedCount === 0) {
    if (checkpoint.lastKey !== null || checkpoint.prefixChainSha256 !== EMPTY_PREFIX_CHAIN) fail("CUTOVER_CHECKPOINT_STATE_INVALID");
    if (table === "telemetry_v12_runtime") await assertV12RuntimeBootstrap(client, schema);
    return;
  }
  if ((table === "telemetry_v11_day_manifests" || table === "telemetry_v12_day_manifests")
      && checkpoint.state === "copied" && checkpoint.importedCount === descriptor.rowCount) {
    const final = await scanTargetTable(client, schema, table);
    if (final.sha256 === descriptor.sha256 && final.rowCount === descriptor.rowCount) return;
  }
  const source = sourcePrefix(sourceDb, table, checkpoint.lastKey);
  const target = await scanTargetTable(client, schema, table, { throughKey: checkpoint.lastKey });
  if (source.rowCount !== checkpoint.importedCount || source.prefixChainSha256 !== checkpoint.prefixChainSha256
      || target.rowCount !== checkpoint.importedCount || target.prefixChainSha256 !== checkpoint.prefixChainSha256) fail("CUTOVER_CHECKPOINT_PREFIX_MISMATCH");
}

async function importTableBatches({ client, sourceDb, schema, table, descriptor, afterBatch, batchCounter }) {
  let checkpoint = await checkpointForTable(client, schema, table);
  await verifyCheckpointPrefix(client, sourceDb, schema, table, checkpoint, descriptor);
  if (checkpoint.state === "copied") {
    if (checkpoint.importedCount !== descriptor.rowCount || checkpoint.prefixChainSha256 !== descriptor.importPrefixChainSha256) fail("CUTOVER_CHECKPOINT_STATE_INVALID");
    return batchCounter.value;
  }
  let afterKey = checkpoint.lastKey;
  let importedCount = checkpoint.importedCount;
  let prefixChain = checkpoint.prefixChainSha256;
  const checkpointTable = journalTable(schema, REHEARSAL_CHECKPOINT_TABLE);
  for (;;) {
    const batch = readSourceBatch(sourceDb, table, afterKey);
    if (batch.rows.length === 0) break;
    const sourceRows = batch.rows.map(row => sourceInsertRow(table, row));
    const normalized = sourceRows.map(row => normalizedRow(row, TARGET_COLUMNS[table], table));
    let nextChain = prefixChain;
    for (const row of normalized) nextChain = advancePrefixChain(nextChain, row);
    const lastKey = sourceKey(table, batch.rows.at(-1));
    const nextCount = importedCount + sourceRows.length;
    if (!Number.isSafeInteger(nextCount) || nextCount > descriptor.rowCount) fail("CUTOVER_SOURCE_CHANGED_DURING_IMPORT");

    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL statement_timeout='30000ms'");
      await client.query("SET LOCAL lock_timeout='5000ms'");
      await writeRowsBatch(client, schema, sourceRows, table);
      if (table === "telemetry_v11_day_manifests" || table === "telemetry_v12_day_manifests") {
        for (const row of batch.rows) {
          if (row.state === "ready") await client.query(`INSERT INTO ${journalTable(schema, REHEARSAL_MANIFEST_TABLE)}(manifest_id, ready_at) VALUES ($1,$2)`, [row.id, row.ready_at]);
        }
      }
      await client.query(`UPDATE ${checkpointTable} SET last_key=$2::jsonb, imported_count=$3,
        prefix_chain_sha256=$4, state='copying' WHERE table_name=$1`, [table, JSON.stringify(lastKey), nextCount, nextChain]);
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Keep the original classification. */ }
      throw error;
    }
    importedCount = nextCount;
    prefixChain = nextChain;
    afterKey = lastKey;
    batchCounter.value += 1;
    if (afterBatch) await afterBatch(Object.freeze({ table, batchNumber: batchCounter.value, rowCount: sourceRows.length, sourceBytes: batch.bytes }));
  }
  if (importedCount !== descriptor.rowCount || prefixChain !== descriptor.importPrefixChainSha256) fail("CUTOVER_SOURCE_CHANGED_DURING_IMPORT");
  await client.query("BEGIN");
  try {
    await client.query(`UPDATE ${checkpointTable} SET state='copied' WHERE table_name=$1`, [table]);
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Keep the original classification. */ }
    throw error;
  }
  return batchCounter.value;
}

async function expectSqlFailureInSavepoint(client, savepoint, expectedCode, operation) {
  const safeName = quoteIdentifier(savepoint);
  await client.query(`SAVEPOINT ${safeName}`);
  let observedError = null;
  try { await operation(); } catch (error) { observedError = error; }
  await client.query(`ROLLBACK TO SAVEPOINT ${safeName}`);
  await client.query(`RELEASE SAVEPOINT ${safeName}`);
  if (!observedError) fail("CUTOVER_V12_NEGATIVE_PROBE_UNEXPECTED_SUCCESS");
  if (observedError.code !== expectedCode) fail("CUTOVER_V12_NEGATIVE_PROBE_UNEXPECTED_ERROR");
  return true;
}

async function proveV12StagedIntegrityGuards(client, schema, sourceDb) {
  const s = quoteIdentifier(schema);
  const wrongStreamChildRefused = await expectSqlFailureInSavepoint(
    client, "v12_wrong_stream_probe", "23514", () => client.query(`INSERT INTO ${s}.telemetry_v12_typed_quota
      (record_id, plan_type_id, plan_variant_id, limit_id, slot_id, used_percent,
        window_duration_minutes, resets_at_ms, attribution_id)
      VALUES (12001, 10, 11, 12, 13, 42.5, 300, 0, 1)`),
  );
  const brokenDictionaryReferenceRefused = await expectSqlFailureInSavepoint(
    client, "v12_dictionary_fk_probe", "23503", () => client.query(`INSERT INTO ${s}.telemetry_v12_typed_session_tools
      (record_id, tool_class_id, count) VALUES (12003, 999999, 1)`),
  );
  const manifestId = sourceDb.prepare("SELECT id FROM telemetry_v12_day_manifests ORDER BY id LIMIT 1").get()?.id;
  if (typeof manifestId !== "string") fail("CUTOVER_V12_SYNTHETIC_MANIFEST_MISSING");
  const incompleteReadyTransitionRefused = await expectSqlFailureInSavepoint(
    client, "v12_ready_integrity_probe", "23514", async () => {
      const removed = await client.query(`DELETE FROM ${s}.telemetry_v12_typed_session_tools
        WHERE record_id=12003 AND tool_class_id=14`);
      if (removed.rowCount !== 1) fail("CUTOVER_V12_SYNTHETIC_CHILD_MISSING");
      await client.query(`UPDATE ${s}.telemetry_v12_day_manifests
        SET state='ready', ready_at=clock_timestamp() WHERE id=$1`, [manifestId]);
    },
  );
  return Object.freeze({
    wrongStreamChildRefused,
    brokenDictionaryReferenceRefused,
    incompleteReadyTransitionRefused,
  });
}

async function prepareV12DomainPublication({ client, sourceDb, schema }) {
  const s = quoteIdentifier(schema);
  const checkpoint = await checkpointForTable(client, schema, "telemetry_v12_session_tools");
  if (checkpoint.state !== "copied") fail("CUTOVER_V12_DOMAIN_CHILDREN_INCOMPLETE");
  const domainRows = await client.query(`SELECT
      (SELECT count(*)::int FROM ${s}.telemetry_v12_domain_predecessors) AS predecessors,
      (SELECT count(*)::int FROM ${s}.telemetry_v12_domains) AS domains,
      (SELECT count(*)::int FROM ${s}.telemetry_v12_domain_days) AS days,
      (SELECT count(*)::int FROM ${s}.telemetry_v12_domain_heads) AS heads`);
  const noPublishedDays = Number(domainRows.rows[0]?.days) === 0;
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    const v12Integrity = noPublishedDays
      ? await proveV12StagedIntegrityGuards(client, schema, sourceDb)
      : null;
    const published = await client.query(`UPDATE ${s}.telemetry_v12_day_manifests AS manifest
        SET state='ready', ready_at=ready.ready_at
        FROM ${journalTable(schema, REHEARSAL_MANIFEST_TABLE)} AS ready
        WHERE manifest.id=ready.manifest_id AND manifest.state <> 'ready'`);
    const sourceReady = Number(sourceDb.prepare(`SELECT count(*) AS n FROM telemetry_v12_day_manifests WHERE state='ready'`).get()?.n);
    const targetReady = await client.query(`SELECT count(*)::int AS n FROM ${s}.telemetry_v12_day_manifests WHERE state='ready'`);
    if (Number(targetReady.rows[0]?.n) !== sourceReady || published.rowCount > sourceReady) {
      fail("CUTOVER_V12_DOMAIN_MANIFEST_PUBLICATION_MISMATCH");
    }
    await client.query("COMMIT");
    return Object.freeze({ v12Integrity, readyManifestCount: sourceReady });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve the original classification. */ }
    throw error;
  }
}

async function verifyV12ActiveHeadAuthority(client, schema, sourceDb) {
  const sourceHeadCount = Number(sourceDb.prepare("SELECT count(*) AS n FROM telemetry_v12_domain_heads").get()?.n);
  const sourceEligible = Number(sourceDb.prepare(`SELECT count(*) AS n
    FROM telemetry_v12_domain_heads h
    JOIN telemetry_v12_domains generation
      ON generation.id=h.generation_id AND generation.participant_id=h.participant_id
    JOIN telemetry_v12_active_authorizations auth
      ON auth.participant_id=generation.participant_id AND auth.device_id=generation.device_id
    WHERE h.revision >= 1
      AND (SELECT count(*) FROM telemetry_v12_domain_days day_row
            WHERE day_row.generation_id=generation.id)=json_array_length(generation.days_json)
      AND NOT EXISTS (
        SELECT 1 FROM telemetry_v12_domain_days day_row
        LEFT JOIN telemetry_v12_day_manifests manifest
          ON manifest.id=day_row.manifest_id
         AND manifest.manifest_digest=day_row.manifest_digest
         AND manifest.chunk_day=day_row.observed_day
         AND manifest.state='ready'
        WHERE day_row.generation_id=generation.id AND manifest.id IS NULL
      )`).get()?.n);
  const s = quoteIdentifier(schema);
  const result = await client.query(`SELECT count(*)::int AS eligible
    FROM ${s}.telemetry_v12_domain_heads h
    JOIN ${s}.telemetry_v12_domains generation
      ON generation.id=h.generation_id AND generation.participant_id=h.participant_id
    JOIN ${s}.telemetry_v12_typed_active_authorizations auth
      ON auth.participant_id=generation.participant_id AND auth.device_id=generation.device_id
    JOIN ${s}.participants participant
      ON participant.id=generation.participant_id AND participant.state='active'
    JOIN ${s}.device_credentials device
      ON device.id=generation.device_id AND device.participant_id=participant.id AND device.state='active'
    WHERE h.revision >= 1
      AND (SELECT count(*) FROM ${s}.telemetry_v12_domain_days day_row
            WHERE day_row.generation_id=generation.id)=jsonb_array_length(generation.days_json::jsonb)
      AND NOT EXISTS (
        SELECT 1 FROM ${s}.telemetry_v12_domain_days day_row
        LEFT JOIN ${s}.telemetry_v12_day_manifests manifest
          ON manifest.id=day_row.manifest_id
         AND manifest.manifest_digest=day_row.manifest_digest
         AND manifest.chunk_day=day_row.observed_day
         AND manifest.state='ready'
        WHERE day_row.generation_id=generation.id AND manifest.id IS NULL
      )`);
  const targetHeadCount = await client.query(`SELECT count(*)::int AS n FROM ${s}.telemetry_v12_domain_heads`);
  if (sourceHeadCount !== sourceEligible || sourceEligible !== Number(result.rows[0]?.eligible)
      || Number(targetHeadCount.rows[0]?.n) !== sourceHeadCount) {
    fail("CUTOVER_V12_ACTIVE_HEAD_AUTHORITY_MISMATCH");
  }
  return Object.freeze({ sourceHeadCount, targetHeadCount: Number(targetHeadCount.rows[0]?.n), eligibleHeadCount: Number(result.rows[0]?.eligible) });
}

async function verifyV12RuntimeMirror(client, schema, sourceDb) {
  const source = sourceDb.prepare(`SELECT id, state, policy_revision, changed_at
    FROM telemetry_v12_runtime WHERE id=1`).get();
  const target = await client.query(`SELECT id, state, revision, changed_at
    FROM ${quoteIdentifier(schema)}.telemetry_v12_runtime WHERE id=1`);
  if (!source || target.rowCount !== 1 || target.rows[0].id !== source.id
      || target.rows[0].state !== source.state
      || target.rows[0].revision !== source.policy_revision
      || canonical(target.rows[0].changed_at) !== canonical(new Date(source.changed_at))) {
    fail("CUTOVER_V12_RUNTIME_MIRROR_MISMATCH");
  }
  return true;
}

async function finalizeImport({ client, sourceDb, schema, descriptors, sourceFingerprintSha256, scope, v12Integrity }) {
  const s = quoteIdentifier(schema);
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    await client.query(`UPDATE ${s}.telemetry_v11_day_manifests AS manifest
      SET state='ready', ready_at=ready.ready_at
      FROM ${journalTable(schema, REHEARSAL_MANIFEST_TABLE)} AS ready
      WHERE manifest.id=ready.manifest_id`);
    await client.query(`UPDATE ${s}.telemetry_v12_day_manifests AS manifest
      SET state='ready', ready_at=ready.ready_at
      FROM ${journalTable(schema, REHEARSAL_MANIFEST_TABLE)} AS ready
      WHERE manifest.id=ready.manifest_id AND manifest.state <> 'ready'`);
    const maxV1RecordId = await advanceV1IdentitySequence(client, schema, sourceDb);
    await finalizeSyntheticTransportFloor(client, schema, sourceDb, scope.participantId);
    const v12ActiveHeadAuthority = await verifyV12ActiveHeadAuthority(client, schema, sourceDb);
    const v12RuntimeMirrorMatched = await verifyV12RuntimeMirror(client, schema, sourceDb);
    const actual = {};
    for (const table of IMPORT_ORDER) {
      actual[table] = await scanTargetTable(client, schema, table);
      verifyDescriptor(table, descriptors[table], actual[table]);
    }
    await client.query(`UPDATE ${journalTable(schema, REHEARSAL_RUN_TABLE)} SET state='complete'
      WHERE singleton=1 AND source_fingerprint_sha256=$1 AND state='copying'`, [sourceFingerprintSha256]);
    const completed = await client.query(`SELECT state FROM ${journalTable(schema, REHEARSAL_RUN_TABLE)} WHERE singleton=1`);
    if (completed.rows[0]?.state !== "complete") fail("CUTOVER_CHECKPOINT_COMPLETION_FAILED");
    await client.query("COMMIT");
    return Object.freeze({ maxV1RecordId, actual, v12Integrity, v12ActiveHeadAuthority, v12RuntimeMirrorMatched });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Keep the original classification. */ }
    throw error;
  }
}

/** Import the reviewed synthetic v1/v1.1 and typed v1.2 subset in journaled batches. */
async function importD1TelemetrySubset({ sourceDb, pool, schema = "cutover_rehearsal", requireV12 = false, afterBatch = null } = {}) {
  if (!sourceDb || !SYNTHETIC_SOURCES.has(sourceDb) || !pool || !AUTHORIZED_TARGET_POOLS.has(pool)) fail("CUTOVER_LOCAL_SYNTHETIC_ONLY");
  const targetContext = AUTHORIZED_TARGET_POOLS.get(pool);
  if (pool.options?.host !== targetContext.socket || pool.options?.database !== targetContext.database
      || !/^tcr_[0-9a-f]{12}$/u.test(targetContext.database)) fail("CUTOVER_LOCAL_TARGET_INVALID");
  await verifyLocalSocket(targetContext.socket);
  quoteIdentifier(schema);
  let snapshotOpen = false;
  let client;
  let readClient;
  try {
    sourceDb.exec("BEGIN IMMEDIATE");
    snapshotOpen = true;
    const sourceNames = sqliteTables(sourceDb);
    const coverage = assessCutoverSourceCoverage(sourceNames);
    if (requireV12) assertV12CutoverGate(coverage);
    validateSyntheticSourceSchema(sourceDb);
    assertUnsupportedV12AuthorityRowsAbsent(sourceDb);
    const source = sourceDescriptorSet(sourceDb);
    const scope = sourceAuthorityScope(sourceDb);
    client = await pool.connect();
    await validateTargetSchemas(client, schema);
    await targetPrerequisitesExist(client, schema, scope);
    await assertTransportFloorNotHigher(client, schema, sourceDb, scope.participantId);
    await createResumeJournal(client, schema, source.fingerprintSha256, source.descriptors);
    const batchCounter = { value: 0 };
    let v12Integrity = null;
    for (const table of IMPORT_ORDER) {
      if (table === "telemetry_v12_domain_predecessors") {
        const publication = await prepareV12DomainPublication({ client, sourceDb, schema });
        v12Integrity = publication.v12Integrity;
      }
      await importTableBatches({ client, sourceDb, schema, table, descriptor: source.descriptors[table], afterBatch, batchCounter });
    }
    const finalized = await finalizeImport({ client, sourceDb, schema, descriptors: source.descriptors, sourceFingerprintSha256: source.fingerprintSha256, scope, v12Integrity });
    sourceDb.exec("COMMIT");
    snapshotOpen = false;
    readClient = await pool.connect();
    client.release();
    client = null;
    const report = [];
    for (const table of IMPORT_ORDER) {
      const actual = await scanTargetTable(readClient, schema, table);
      verifyDescriptor(table, source.descriptors[table], actual);
      report.push(Object.freeze({ sourceTable: table === "pending_objects" ? "pending_quarantine_objects:selected-chunk-rows" : table,
        targetTable: targetTableName(table), rowCount: actual.rowCount,
        sourceSha256: source.descriptors[table].sha256, destinationSha256: actual.sha256 }));
    }
    readClient.release();
    readClient = null;
    const manifestStates = Object.fromEntries(sourceDb.prepare(`SELECT state, count(*) AS n FROM telemetry_v11_day_manifests GROUP BY state ORDER BY state`)
      .all().map(row => [row.state, Number(row.n)]));
    const sourceBytes = IMPORT_ORDER.reduce((total, table) => total + source.descriptors[table].sourceBytes, 0);
    if (!Number.isSafeInteger(sourceBytes)) fail("CUTOVER_SOURCE_BYTE_COUNT_RANGE");
    return Object.freeze({
      coverage,
      imported: Object.freeze(report),
      v11ManifestStates: Object.freeze(manifestStates),
      v12Integrity: finalized.v12Integrity,
      v12ActiveHeadAuthority: finalized.v12ActiveHeadAuthority,
      v12RuntimeMirrorMatched: finalized.v12RuntimeMirrorMatched,
      maxV1RecordId: finalized.maxV1RecordId,
      sourceRows: IMPORT_ORDER.reduce((total, table) => total + source.descriptors[table].rowCount, 0),
      sourceBytes,
      committedBatchCount: batchCounter.value,
    });
  } catch (error) {
    if (snapshotOpen) {
      try { sourceDb.exec("ROLLBACK"); } catch { /* The snapshot may already have closed. */ }
    }
    if (typeof error?.code === "string" && error.code.startsWith("CUTOVER_")) throw error;
    fail("CUTOVER_IMPORT_FAILED");
  } finally {
    if (readClient) readClient.release();
    if (client) client.release();
  }
}

function jsonRecord(value) { return JSON.stringify(value); }

/** Apply the real canonical D1 migration chain and seed content-free rows. */
export async function createSyntheticCanonicalD1({ extraV1Chunks = 0, v1RecordPaddingBytes = 0 } = {}) {
  if (!Number.isSafeInteger(extraV1Chunks) || extraV1Chunks < 0 || extraV1Chunks > 10
      || !Number.isSafeInteger(v1RecordPaddingBytes) || v1RecordPaddingBytes < 0 || v1RecordPaddingBytes > 100_000) fail("CUTOVER_SYNTHETIC_FIXTURE_OPTIONS_INVALID");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)");
  const files = (await readdir(D1_MIGRATIONS)).filter(name => /^\d{4}_[a-z0-9_-]+\.sql$/u.test(name)).sort();
  for (const name of files) {
    database.exec("BEGIN");
    try {
      database.exec(await readFile(join(D1_MIGRATIONS, name), "utf8"));
      database.prepare("INSERT INTO d1_migrations(name) VALUES (?)").run(name);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      database.close();
      throw error;
    }
  }
  database.exec("CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT");
  for (const directory of D1_STORAGE_MIGRATION_DIRECTORIES) {
    const storageFiles = (await readdir(join(WORKER_ROOT, directory)))
      .filter(name => /^\d{4}_[a-z0-9_-]+\.sql$/u.test(name)).sort();
    for (const name of storageFiles) {
      const sql = await readFile(join(WORKER_ROOT, directory, name), "utf8");
      database.exec("BEGIN");
      try {
        database.exec(sql);
        database.prepare("INSERT INTO d1_storage_migrations(name, sha256) VALUES (?, ?)")
          .run(`${directory}/${name}`, HASH(sql));
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        database.close();
        throw error;
      }
    }
  }
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const participant = "cutover-synthetic-participant";
  const device = "cutover-synthetic-device";
  const session = "cutover-synthetic-session";
  const pairing = "cutover-synthetic-pairing";
  const v1Id = "cutover-synthetic-v1-chunk";
  const v11Manifest = "00000000-0000-4000-8000-000000000011";
  const v11Chunk = `chunk:${"1".repeat(36)}`;
  const v1Auth = "cutover-synthetic-v1-upload";
  const v11Auth = "cutover-synthetic-v11-upload";
  const v1Envelope = HASH("synthetic-v1-envelope");
  const v11Envelope = HASH("synthetic-v11-envelope");
  const v1Digest = HASH("synthetic-v1-chunk");
  const v11Digest = HASH("synthetic-v11-chunk");
  const lease = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  database.prepare(`INSERT INTO participants(id, owner_kind, access_token_id, access_token_hash, recovery_token_id, recovery_token_hash, state, consent_version, consented_at, created_at) VALUES (?, 'social', ?, ?, ?, ?, 'active', ?, ?, ?)`)
    .run(participant, "cutover-synthetic-access-token", Buffer.alloc(32, 7), "cutover-synthetic-recovery-token", Buffer.alloc(32, 8), "ongoing-privacy-safe-telemetry-v1.0", now, now);
  database.prepare(`INSERT INTO web_sessions(id, participant_id, secret_hash, csrf_hash, scope, state, issued_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, 'personal', 'active', ?, ?, ?)`)
    .run(session, participant, Buffer.alloc(32, 1), Buffer.alloc(32, 2), now, expires, now);
  database.prepare(`INSERT INTO device_pairings(id, participant_id, issued_by_session_id, secret_hash, consent_version, state, issued_at, expires_at, transport_consent_version) VALUES (?, ?, ?, ?, ?, 'unused', ?, ?, ?)`)
    .run(pairing, participant, session, Buffer.alloc(32, 3), "ongoing-privacy-safe-telemetry-v1.0", now, expires, "ongoing-privacy-safe-telemetry-v1.0");
  database.prepare(`INSERT INTO device_credentials(id, participant_id, authority_kind, paired_via_pairing_id, secret_hash, state, issued_at, expires_at, last_used_at, social_verified_at) VALUES (?, ?, 'social', ?, ?, 'active', ?, ?, ?, ?)`)
    .run(device, participant, pairing, Buffer.alloc(32, 4), now, expires, now, now);
  database.prepare("UPDATE device_pairings SET state='consumed', consumed_at=?, claimed_device_id=? WHERE id=?").run(now, device, pairing);
  database.prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.0'").run();
  database.prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
  const consent1 = [participant, device, "telemetry-contribution-v1.0", "telemetry-v1.0-registry-2026-08-07.1", "ongoing-privacy-safe-telemetry-v1.0", now];
  database.prepare("INSERT INTO telemetry_v1_device_consents VALUES (?, ?, ?, ?, ?, ?)").run(...consent1);
  const v1Record = { schemaVersion: "usage-event-v1.0", eventId: "cutover-synthetic-event-v1", eventTime: now, sessionUuid: "cutover-synthetic-session-dimension", provider: "synthetic", modelId: "synthetic-model", components: { inputUncachedTokens: 2, inputCacheReadTokens: 0, inputCacheWriteTokens: 0, outputTextTokens: 1, outputReasoningTokens: 0, outputCombinedTokens: 1 } };
  const v1Key = `telemetry/${participant}/${v1Id}`;
  database.prepare("INSERT INTO pending_quarantine_objects(r2_key, contribution_id, object_kind, registered_at) VALUES (?, ?, 'telemetry', ?)").run(v1Key, v1Id, now);
  database.prepare(`INSERT INTO device_upload_authorizations(id, participant_id, issued_by_device_id, secret_hash, envelope_digest, body_bytes, content_type, state, issued_at, expires_at, consume_lease_expires_at) VALUES (?, ?, ?, ?, ?, 128, 'application/json', 'consuming', ?, ?, ?)`)
    .run(v1Auth, participant, device, Buffer.alloc(32, 5), v1Envelope, now, expires, lease);
  database.prepare(`INSERT INTO telemetry_v1_chunks(id, participant_id, device_id, stream, chunk_day, chunk_seq, revision, chunk_digest, envelope_digest, parser_version, record_count, accepted_record_count, r2_key, device_upload_authorization_id, created_at) VALUES (?, ?, ?, 'usage', ?, 0, 1, ?, ?, 'synthetic-cutover-v1', 1, 1, ?, ?, ?)`)
    .run(v1Id, participant, device, day, v1Digest, v1Envelope, v1Key, v1Auth, now);
  database.prepare(`INSERT INTO telemetry_v1_records(chunk_row_id, participant_id, device_id, stream, occurrence_id, observed_at, observed_day, provider, model_id, session_uuid, input_uncached_tokens, input_cache_read_tokens, input_cache_write_tokens, output_text_tokens, output_reasoning_tokens, output_combined_tokens, record_json) VALUES (?, ?, ?, 'usage', ?, ?, ?, 'synthetic', 'synthetic-model', ?, 2, 0, 0, 1, 0, 1, ?)`)
    .run(v1Id, participant, device, v1Record.eventId, now, day, v1Record.sessionUuid, jsonRecord(v1Record));
  const padding = "x".repeat(v1RecordPaddingBytes);
  const insertExtraV1Record = database.prepare(`INSERT INTO telemetry_v1_records
    (chunk_row_id, participant_id, device_id, stream, occurrence_id, observed_at, observed_day,
      provider, model_id, session_uuid, input_uncached_tokens, input_cache_read_tokens,
      input_cache_write_tokens, output_text_tokens, output_reasoning_tokens, output_combined_tokens, record_json)
    VALUES (?, ?, ?, 'usage', ?, ?, ?, 'synthetic', 'synthetic-model', ?, 2, 0, 0, 1, 0, 1, ?)`);
  for (let chunkIndex = 1; chunkIndex <= extraV1Chunks; chunkIndex += 1) {
    const chunkId = `cutover-synthetic-v1-chunk-${String(chunkIndex).padStart(4, "0")}`;
    const authorizationId = `cutover-synthetic-v1-upload-${String(chunkIndex).padStart(4, "0")}`;
    const envelopeDigest = HASH(`synthetic-v1-envelope-${chunkIndex}`);
    const chunkDigest = HASH(`synthetic-v1-chunk-${chunkIndex}`);
    const objectKey = `telemetry/${participant}/${chunkId}`;
    database.prepare(`INSERT INTO device_upload_authorizations
      (id, participant_id, issued_by_device_id, secret_hash, envelope_digest, body_bytes,
        content_type, state, issued_at, expires_at, consume_lease_expires_at)
      VALUES (?, ?, ?, ?, ?, 128, 'application/json', 'consuming', ?, ?, ?)`)
      .run(authorizationId, participant, device, Buffer.alloc(32, chunkIndex % 255), envelopeDigest, now, expires, lease);
    database.prepare(`INSERT INTO telemetry_v1_chunks
      (id, participant_id, device_id, stream, chunk_day, chunk_seq, revision, chunk_digest,
        envelope_digest, parser_version, record_count, accepted_record_count, r2_key,
        device_upload_authorization_id, created_at)
      VALUES (?, ?, ?, 'usage', ?, ?, 1, ?, ?, 'synthetic-cutover-v1', 200, 200, ?, ?, ?)`)
      .run(chunkId, participant, device, day, chunkIndex, chunkDigest, envelopeDigest, objectKey, authorizationId, now);
    database.prepare(`INSERT INTO pending_quarantine_objects(r2_key, contribution_id, object_kind, registered_at)
      VALUES (?, ?, 'telemetry', ?)`)
      .run(objectKey, chunkId, now);
    for (let recordIndex = 0; recordIndex < 200; recordIndex += 1) {
      const eventId = `cutover-synthetic-v1-extra-${chunkIndex}-${String(recordIndex).padStart(3, "0")}`;
      const record = { ...v1Record, eventId, padding };
      insertExtraV1Record.run(chunkId, participant, device, eventId, now, day, v1Record.sessionUuid, jsonRecord(record));
    }
  }
  const consent11 = [participant, device, "telemetry-contribution-v1.1", "telemetry-v1.1-registry-2026-08-31.1", "ongoing-privacy-safe-telemetry-v1.1", now];
  database.prepare("INSERT INTO telemetry_v11_device_consents VALUES (?, ?, ?, ?, ?, ?)").run(...consent11);
  const v11Record = { schemaVersion: "usage-event-v1.1", eventId: "cutover-synthetic-event-v11", eventTime: now, sessionUuid: "cutover-synthetic-session-dimension", provider: "synthetic", modelId: "synthetic-model", components: { inputUncachedTokens: 2, inputCacheReadTokens: 0, inputCacheWriteTokens: 0, outputTextTokens: 1, outputReasoningTokens: 0, outputCombinedTokens: 1 } };
  const manifestBody = { schemaVersion: "telemetry-contribution-v1.1", chunks: [{ chunkId: v11Chunk, chunkDigest: v11Digest, recordCount: 1 }] };
  const manifestJson = jsonRecord(manifestBody);
  const manifestDigest = HASH(manifestJson);
  database.prepare("INSERT INTO telemetry_v11_day_manifests(id, participant_id, device_id, chunk_day, manifest_digest, parser_version, manifest_json, expected_chunk_count, state, created_at) VALUES (?, ?, ?, ?, ?, 'synthetic-cutover-v11', ?, 1, 'staged', ?)")
    .run(v11Manifest, participant, device, day, manifestDigest, manifestJson, now);
  const v11Key = `telemetry/${participant}/${v11Chunk}`;
  database.prepare("INSERT INTO pending_quarantine_objects(r2_key, contribution_id, object_kind, registered_at) VALUES (?, ?, 'telemetry', ?)").run(v11Key, v11Chunk, now);
  database.prepare(`INSERT INTO device_upload_authorizations(id, participant_id, issued_by_device_id, secret_hash, envelope_digest, body_bytes, content_type, state, issued_at, expires_at, consume_lease_expires_at) VALUES (?, ?, ?, ?, ?, 128, 'application/json', 'consuming', ?, ?, ?)`)
    .run(v11Auth, participant, device, Buffer.alloc(32, 6), v11Envelope, now, expires, lease);
  database.prepare(`INSERT INTO telemetry_v11_chunks(id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq, chunk_id, chunk_digest, envelope_digest, parser_version, record_count, r2_key, device_upload_authorization_id, created_at) VALUES (?, ?, ?, ?, 'usage', ?, 0, ?, ?, ?, 'synthetic-cutover-v11', 1, ?, ?, ?)`)
    .run(v11Chunk, v11Manifest, participant, device, day, v11Chunk, v11Digest, v11Envelope, v11Key, v11Auth, now);
  database.prepare("INSERT INTO telemetry_v11_records(chunk_id, manifest_id, stream, occurrence_id, observed_at, record_json) VALUES (?, ?, 'usage', ?, ?, ?)")
    .run(v11Chunk, v11Manifest, v11Record.eventId, now, jsonRecord(v11Record));
  // The current source ready trigger requires typed-v11 record admissions and
  // owner proofs, which this v1.1 compatibility fixture intentionally does not
  // synthesize. Keep its manifest staged while still exercising bounded import
  // of its legacy chunk and record rows.
  database.prepare("INSERT INTO telemetry_v11_day_manifests(id, participant_id, device_id, chunk_day, manifest_digest, parser_version, manifest_json, expected_chunk_count, state, created_at) VALUES (?, ?, ?, ?, ?, 'synthetic-cutover-v11', ?, 0, 'staged', ?)")
    .run("00000000-0000-4000-8000-000000000012", participant, device, day, HASH("synthetic-empty-staged-manifest"), jsonRecord({ schemaVersion: "telemetry-contribution-v1.1", chunks: [] }), now);

  // Small, fully normalized v1.2 source fixture: one usage, quota, and session
  // record with their typed children. Wire payload JSON is not stored in D1.
  const v12Manifest = "00000000-0000-4000-8000-000000000013";
  const v12Rows = [
    { id: "chunk:" + "2".repeat(36), stream: "usage", recordId: 12001, occurrence: "synthetic-v12-usage-occurrence" },
    { id: "chunk:" + "3".repeat(36), stream: "quota", recordId: 12002, occurrence: "synthetic-v12-quota-occurrence" },
    { id: "chunk:" + "4".repeat(36), stream: "session", recordId: 12003, occurrence: "synthetic-v12-session-occurrence" },
  ].map((row, index) => ({
    ...row,
    authorizationId: `cutover-synthetic-v12-upload-${row.stream}`,
    envelopeDigest: HASH(`synthetic-v12-envelope-${row.stream}`),
    chunkDigest: HASH(`synthetic-v12-chunk-${row.stream}`),
    r2Key: `telemetry/${participant}/${row.id}`,
    chunkSeq: index,
  }));
  const v12ManifestJson = jsonRecord({
    schemaVersion: "telemetry-day-manifest-v1.2",
    day,
    chunks: v12Rows.map(row => ({ chunkId: row.id, chunkDigest: row.chunkDigest, recordCount: 1 })),
  });
  const v12ManifestDigest = HASH(v12ManifestJson);
  database.prepare("UPDATE telemetry_v12_runtime SET state='active', policy_revision=policy_revision+1, changed_at=? WHERE id=1").run(now);
  database.prepare(`INSERT INTO telemetry_v12_device_capabilities (
    participant_id, device_id, telemetry_schema_version, field_dictionary_version,
    privacy_contract_version, state, consented_at
  ) VALUES (?, ?, 'telemetry-contribution-v1.2', 'telemetry-v1.2-registry-2026-09-20.1',
    'ongoing-privacy-safe-telemetry-v1.2', 'accepted', ?)`)
    .run(participant, device, now);
  database.prepare(`INSERT INTO telemetry_v12_day_manifests (
    id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
    manifest_json, expected_chunk_count, state, created_at
  ) VALUES (?, ?, ?, ?, ?, 'synthetic-cutover-v12', ?, ?, 'staged', ?)`)
    .run(v12Manifest, participant, device, day, v12ManifestDigest, v12ManifestJson, v12Rows.length, now);
  const insertV12Authorization = database.prepare(`INSERT INTO device_upload_authorizations (
    id, participant_id, issued_by_device_id, secret_hash, envelope_digest, body_bytes,
    content_type, state, issued_at, expires_at, consume_lease_expires_at
  ) VALUES (?, ?, ?, ?, ?, 4096, 'application/json', 'consuming', ?, ?, ?)`);
  const insertV12Chunk = database.prepare(`INSERT INTO telemetry_v12_chunks (
    id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq, chunk_id,
    chunk_digest, envelope_digest, parser_version, record_count, r2_key,
    device_upload_authorization_id, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synthetic-cutover-v12', 1, ?, ?, ?)`);
  for (const row of v12Rows) {
    insertV12Authorization.run(row.authorizationId, participant, device, Buffer.alloc(32, 9),
      row.envelopeDigest, now, expires, lease);
    insertV12Chunk.run(row.id, v12Manifest, participant, device, row.stream, day, row.chunkSeq,
      row.id, row.chunkDigest, row.envelopeDigest, row.r2Key, row.authorizationId, now);
    database.prepare(`INSERT INTO pending_quarantine_objects(r2_key, contribution_id, object_kind, registered_at)
      VALUES (?, ?, 'telemetry', ?)`)
      .run(row.r2Key, row.id, now);
  }

  const dictionary = [
    "synthetic-v12-provider", "synthetic-v12-model", "synthetic-v12-speed",
    "synthetic-v12-tier", "synthetic-v12-surface", "synthetic-v12-billing",
    "synthetic-v12-reasoning", "synthetic-v12-agent", "synthetic-v12-outcome",
    "synthetic-v12-plan", "synthetic-v12-variant", "synthetic-v12-limit",
    "synthetic-v12-slot", "synthetic-v12-tool",
  ];
  const insertDictionary = database.prepare("INSERT INTO typed_telemetry_dictionary(id, value) VALUES (?, ?)");
  dictionary.forEach((value, index) => insertDictionary.run(index + 1, value));
  database.prepare(`INSERT INTO telemetry_v12_attributions
    (id, account_basis, account_track, plan_basis, plan_type_id, plan_era)
    VALUES (1, 0, ?, 0, 10, ?)`)
    .run(Buffer.alloc(0), Buffer.alloc(0));
  const dayEpoch = Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 86_400_000);
  const observedAtMs = Date.parse(`${day}T12:00:00.000Z`);
  const canonicalDigest = stream => Buffer.from(HASH(`synthetic-v12-canonical-${stream}`), "hex");
  const insertV12Record = database.prepare(`INSERT INTO telemetry_v12_records (
    id, chunk_id, manifest_id, stream, record_index, occurrence_id, observed_at_ms,
    observed_day, provider_id, canonical_digest
  ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 1, ?)`);
  v12Rows.forEach(row => insertV12Record.run(row.recordId, row.id, v12Manifest, row.stream,
    Buffer.from(row.occurrence), observedAtMs, dayEpoch, canonicalDigest(row.stream)));
  database.prepare(`INSERT INTO telemetry_v12_usage (
    record_id, session_id, model_id, speed_mode_id, api_service_tier_id, surface_id,
    billing_surface_id, reasoning_effort_id, agent_scope_id, outcome_id, attribution_id,
    total_input_context_tokens, input_uncached_tokens, input_cache_read_tokens,
    input_cache_write_tokens, output_text_tokens, output_reasoning_tokens, output_combined_tokens,
    boundary_flags, tie_order
  ) VALUES (12001, ?, 2, 3, 4, 5, 6, 7, 8, 9, 1, 100, 60, 40, 0, 25, 5, 30, 0, 0)`)
    .run(Buffer.from("synthetic-v12-session-id"));
  database.prepare(`INSERT INTO telemetry_v12_quota (
    record_id, plan_type_id, plan_variant_id, limit_id, slot_id, used_percent,
    window_duration_minutes, resets_at_ms, attribution_id
  ) VALUES (12002, 10, 11, 12, 13, 42.5, 300, ?, 1)`)
    .run(observedAtMs + 300 * 60_000);
  database.prepare("INSERT INTO telemetry_v12_session_tools(record_id, tool_class_id, count) VALUES (12003, 14, 2)").run();
  database.prepare("UPDATE telemetry_v12_day_manifests SET state='ready', ready_at=? WHERE id=?")
    .run(now, v12Manifest);
  const domainGeneration = "00000000-0000-4000-8000-000000000014";
  const domainTokenHash = HASH("synthetic-v12-domain-predecessor-token");
  const domainLegacyFingerprint = HASH("synthetic-v12-domain-legacy-fingerprint");
  const domainDigest = HASH("synthetic-v12-domain-generation");
  const domainDaysJson = jsonRecord([{
    day, manifestId: v12Manifest, manifestDigest: v12ManifestDigest,
  }]);
  const inputRevision = database.prepare(`SELECT revision FROM community_analytical_input_versions
    WHERE participant_id=?`).get(participant)?.revision;
  if (!Number.isSafeInteger(inputRevision) || inputRevision < 0) {
    database.close();
    fail("CUTOVER_V12_SYNTHETIC_INPUT_REVISION_MISSING");
  }
  database.prepare(`INSERT INTO telemetry_v12_domain_predecessors (
    token_hash, participant_id, device_id, previous_generation_id, legacy_fingerprint,
    input_revision, from_day, through_day, days_json, created_at, expires_at
  ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`)
    .run(domainTokenHash, participant, device, domainLegacyFingerprint, inputRevision,
      day, day, domainDaysJson, now, expires);
  database.prepare(`INSERT INTO telemetry_v12_domains (
    id, participant_id, device_id, predecessor_token_hash, previous_generation_id,
    manifest_digest, legacy_fingerprint, input_revision, from_day, through_day,
    days_json, created_at
  ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`)
    .run(domainGeneration, participant, device, domainTokenHash, domainDigest,
      domainLegacyFingerprint, inputRevision, day, day, domainDaysJson, now);
  database.prepare(`INSERT INTO telemetry_v12_domain_days (
    generation_id, observed_day, manifest_id, manifest_digest
  ) VALUES (?, ?, ?, ?)`).run(domainGeneration, day, v12Manifest, v12ManifestDigest);
  database.prepare(`INSERT INTO telemetry_v12_domain_heads (
    participant_id, generation_id, revision, updated_at
  ) VALUES (?, ?, 1, ?)`).run(participant, domainGeneration, now);
  database.prepare(`UPDATE telemetry_v12_domain_predecessors SET consumed_at=?
    WHERE token_hash=?`).run(now, domainTokenHash);
  const activeHead = database.prepare(`SELECT count(*) AS n
    FROM telemetry_v12_domain_heads h
    JOIN telemetry_v12_domains generation
      ON generation.id=h.generation_id AND generation.participant_id=h.participant_id
    JOIN telemetry_v12_domain_days day_row ON day_row.generation_id=generation.id
    JOIN telemetry_v12_day_manifests manifest
      ON manifest.id=day_row.manifest_id
     AND manifest.manifest_digest=day_row.manifest_digest
     AND manifest.chunk_day=day_row.observed_day AND manifest.state='ready'
    JOIN telemetry_v12_active_authorizations auth
      ON auth.participant_id=generation.participant_id AND auth.device_id=generation.device_id
    WHERE h.participant_id=? AND h.revision=1
      AND json_array_length(generation.days_json)=1`).get(participant)?.n;
  if (activeHead !== 1) {
    database.close();
    fail("CUTOVER_V12_SYNTHETIC_HEAD_INVALID");
  }
  SYNTHETIC_SOURCES.add(database);
  return database;
}

function safeSocketConfig() {
  const socket = process.env.PG_TEST_SOCKET;
  const port = Number(process.env.PG_TEST_PORT ?? "5432");
  if (typeof socket !== "string" || !socket.startsWith("/private/tmp/tibotattle-pg-") || !Number.isInteger(port) || port < 1 || port > 65535) fail("CUTOVER_LOCAL_POSTGRES_REQUIRED");
  return { socket, port };
}

async function verifyLocalSocket(socket) {
  let canonicalPath;
  let pathStat;
  try {
    pathStat = await lstat(socket);
    canonicalPath = await realpath(socket);
  } catch { fail("CUTOVER_LOCAL_SOCKET_UNAVAILABLE"); }
  const details = await stat(canonicalPath);
  if (pathStat.isSymbolicLink() || !canonicalPath.startsWith("/private/tmp/tibotattle-pg-")
      || !details.isDirectory() || (details.mode & 0o077) !== 0
      || typeof process.getuid === "function" && details.uid !== process.getuid()) fail("CUTOVER_LOCAL_SOCKET_UNSAFE");
  return canonicalPath;
}

async function seedTargetAuthority(pool, schema, { now, expires, participant, device, session, pairing, v1Auth, v11Auth, v1Id, v11Chunk, v1Envelope, v11Envelope, additionalV1Uploads = [], additionalV12Uploads = [], minimumRank = 1 }) {
  const s = quoteIdentifier(schema);
  await pool.query(`INSERT INTO ${s}.participants(id, owner_kind, access_token_id, access_token_hash, recovery_token_id, recovery_token_hash, state, consent_version, consented_at, created_at) VALUES ($1, 'social', $2, $3, $4, $5, 'active', $6, $7, $7)`, [participant, "cutover-synthetic-access-token", Buffer.alloc(32, 7), "cutover-synthetic-recovery-token", Buffer.alloc(32, 8), "ongoing-privacy-safe-telemetry-v1.0", now]);
  await pool.query(`INSERT INTO ${s}.web_sessions(id, participant_id, secret_hash, csrf_hash, scope, state, issued_at, expires_at, last_used_at) VALUES ($1,$2,$3,$4,'personal','active',$5,$6,$5)`, [session, participant, Buffer.alloc(32, 1), Buffer.alloc(32, 2), now, expires]);
  await pool.query(`INSERT INTO ${s}.device_pairings(id, participant_id, issued_by_session_id, secret_hash, consent_version, transport_consent_version, state, issued_at, expires_at) VALUES ($1,$2,$3,$4,$5,$5,'unused',$6,$7)`, [pairing, participant, session, Buffer.alloc(32, 3), "ongoing-privacy-safe-telemetry-v1.0", now, expires]);
  await pool.query(`INSERT INTO ${s}.device_credentials(id, participant_id, authority_kind, paired_via_pairing_id, secret_hash, state, issued_at, expires_at, last_used_at, social_verified_at) VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`, [device, participant, pairing, Buffer.alloc(32, 4), now, expires]);
  await pool.query(`UPDATE ${s}.device_pairings SET state='consumed', consumed_at=$2, claimed_device_id=$3 WHERE id=$1`, [pairing, now, device]);
  await pool.query(`INSERT INTO ${s}.telemetry_transport_participant_floors(participant_id, minimum_rank, revision, changed_at) VALUES ($1,$2,0,$3)`, [participant, minimumRank, now]);
  await pool.query(`UPDATE ${s}.telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'`);
  await pool.query(`UPDATE ${s}.telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.2'`);
  const uploadAuthorities = [[v1Auth, v1Id, v1Envelope, 5], [v11Auth, v11Chunk, v11Envelope, 6],
    ...additionalV1Uploads.map((row, index) => [row.authorizationId, row.contributionId, row.envelopeDigest, (index % 200) + 10])];
  for (const [id, contribution, envelope, fill] of uploadAuthorities) {
    await pool.query(`INSERT INTO ${s}.device_upload_authorizations(id, participant_id, issued_by_device_id, secret_hash, envelope_digest, body_bytes, content_type, state, issued_at, expires_at, consumed_at, consumed_contribution_id) VALUES ($1,$2,$3,$4,$5,128,'application/json','consumed',$6,$7,$6,$8)`, [id, participant, device, Buffer.alloc(32, fill), envelope, now, expires, contribution]);
  }
  for (const [index, row] of additionalV12Uploads.entries()) {
    await pool.query(`INSERT INTO ${s}.device_upload_authorizations(id, participant_id, issued_by_device_id,
      secret_hash, envelope_digest, body_bytes, content_type, state, issued_at, expires_at, consumed_at,
      consumed_contribution_id) VALUES ($1,$2,$3,$4,$5,4096,'application/json','consumed',$6,$7,$6,$8)`,
    [row.authorizationId, participant, device, Buffer.alloc(32, (index % 200) + 20), row.envelopeDigest, now, expires, row.contributionId]);
  }
}

async function proveV12RuntimeMirrorRollback(pool, schema, sourceDb) {
  const s = quoteIdentifier(schema);
  const triggerName = "cutover_rehearsal_fail_runtime_mirror";
  const functionName = "cutover_rehearsal_fail_runtime_mirror";
  let committedBatchCount = 0;
  try {
    await pool.query(`CREATE FUNCTION ${s}.${quoteIdentifier(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P0001'; END $$`);
    await pool.query(`CREATE TRIGGER ${quoteIdentifier(triggerName)} BEFORE UPDATE ON ${s}.telemetry_v12_runtime
      FOR EACH ROW EXECUTE FUNCTION ${s}.${quoteIdentifier(functionName)}()`);
    try {
      await importD1TelemetrySubset({ sourceDb, pool, schema,
        afterBatch: () => { committedBatchCount += 1; } });
      fail("CUTOVER_V12_RUNTIME_ROLLBACK_PROBE_UNEXPECTED_SUCCESS");
    } catch (error) {
      if (error?.code !== "CUTOVER_IMPORT_FAILED") throw error;
    }
    await assertV12RuntimeBootstrap(pool, schema);
    const checkpoint = await pool.query(`SELECT last_key, imported_count, prefix_chain_sha256, state
      FROM ${journalTable(schema, REHEARSAL_CHECKPOINT_TABLE)} WHERE table_name='telemetry_v12_runtime'`);
    if (checkpoint.rowCount !== 1 || checkpoint.rows[0].last_key !== null
        || Number(checkpoint.rows[0].imported_count) !== 0
        || checkpoint.rows[0].prefix_chain_sha256 !== EMPTY_PREFIX_CHAIN
        || checkpoint.rows[0].state !== "copying") {
      fail("CUTOVER_V12_RUNTIME_CHECKPOINT_ADVANCED_ON_FAILURE");
    }
    return Object.freeze({ committedBatchCount, updateAndCheckpointRolledBack: true });
  } finally {
    try {
      await pool.query(`DROP TRIGGER IF EXISTS ${quoteIdentifier(triggerName)} ON ${s}.telemetry_v12_runtime`);
      await pool.query(`DROP FUNCTION IF EXISTS ${s}.${quoteIdentifier(functionName)}()`);
    } catch { fail("CUTOVER_V12_RUNTIME_ROLLBACK_PROBE_CLEANUP_FAILED"); }
  }
}

async function proveResumableImport(pool, schema, sourceDb) {
  const s = quoteIdentifier(schema);
  const runtimeMirrorRollback = await proveV12RuntimeMirrorRollback(pool, schema, sourceDb);
  let firstBatch;
  let interruptOnce = true;
  let committedBatchCount = runtimeMirrorRollback.committedBatchCount;
  const observeBatch = summary => {
    committedBatchCount += 1;
    if (interruptOnce && summary.table === "telemetry_v12_records") {
      interruptOnce = false;
      firstBatch = summary;
      fail("CUTOVER_TEST_INTERRUPTED_AFTER_COMMIT");
    }
  };
  await pool.query(`CREATE FUNCTION ${s}.cutover_rehearsal_fail_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P0001'; END $$`);
  await pool.query(`CREATE TRIGGER cutover_rehearsal_fail_record BEFORE INSERT ON ${s}.telemetry_v12_typed_session_tools FOR EACH ROW EXECUTE FUNCTION ${s}.cutover_rehearsal_fail_record()`);
  try {
    try {
      await importD1TelemetrySubset({ sourceDb, pool, schema, afterBatch: observeBatch });
      fail("CUTOVER_RESUME_PROBE_UNEXPECTED_SUCCESS");
    } catch (error) {
      if (error?.code !== "CUTOVER_TEST_INTERRUPTED_AFTER_COMMIT") throw error;
    }
    if (!firstBatch) fail("CUTOVER_RESUME_PROBE_MISSING_BATCH");
    const committedCount = await pool.query(`SELECT count(*)::text AS n FROM ${s}.telemetry_v12_typed_records`);
    const committedCheckpoint = await pool.query(`SELECT imported_count, last_key FROM ${journalTable(schema, REHEARSAL_CHECKPOINT_TABLE)} WHERE table_name='telemetry_v12_records'`);
    if (Number(committedCount.rows[0]?.n) !== firstBatch.rowCount
        || Number(committedCheckpoint.rows[0]?.imported_count) !== firstBatch.rowCount
        || !Array.isArray(committedCheckpoint.rows[0]?.last_key)) fail("CUTOVER_CHECKPOINT_COMMIT_MISSING");

    try {
      await importD1TelemetrySubset({ sourceDb, pool, schema, afterBatch: observeBatch });
      fail("CUTOVER_BATCH_ROLLBACK_PROBE_UNEXPECTED_SUCCESS");
    } catch (error) {
      if (error?.code !== "CUTOVER_IMPORT_FAILED") throw error;
    }
  } finally {
    try {
      await pool.query(`DROP TRIGGER cutover_rehearsal_fail_record ON ${s}.telemetry_v12_typed_session_tools`);
      await pool.query(`DROP FUNCTION ${s}.cutover_rehearsal_fail_record()`);
    } catch { fail("CUTOVER_ROLLBACK_PROBE_CLEANUP_FAILED"); }
  }
  const failedTable = await pool.query(`SELECT imported_count FROM ${journalTable(schema, REHEARSAL_CHECKPOINT_TABLE)} WHERE table_name='telemetry_v12_session_tools'`);
  const failedRows = await pool.query(`SELECT count(*)::text AS n FROM ${s}.telemetry_v12_typed_session_tools`);
  if (Number(failedTable.rows[0]?.imported_count) !== 0 || Number(failedRows.rows[0]?.n) !== 0) fail("CUTOVER_BATCH_CHECKPOINT_NOT_ATOMIC");
  const result = await importD1TelemetrySubset({ sourceDb, pool, schema, afterBatch: observeBatch });
  return Object.freeze({ result, committedBatchCount, interruptedBatchRows: firstBatch.rowCount,
    interruptedSourceTable: firstBatch.table, rolledBackSourceTable: "telemetry_v12_session_tools",
    runtimeMirrorUpdateAndCheckpointRolledBack: runtimeMirrorRollback.updateAndCheckpointRolledBack });
}

async function proveRepeatRefusal(pool, schema, sourceDb, imported) {
  try {
    await importD1TelemetrySubset({ sourceDb, pool, schema });
    fail("CUTOVER_REPEAT_PROBE_UNEXPECTED_SUCCESS");
  } catch (error) {
    if (error?.code !== "CUTOVER_TARGET_NOT_EMPTY") throw error;
  }
  for (const item of imported) {
    const sourceTable = item.targetTable === "pending_objects" ? "pending_objects" : item.sourceTable;
    const actual = await scanTargetTable(pool, schema, sourceTable);
    if (actual.rowCount !== item.rowCount || actual.sha256 !== item.destinationSha256) fail("CUTOVER_REPEAT_CHANGED_TARGET");
  }
}

async function proveV1IdentitySequence(pool, schema, maximumImportedId) {
  if (maximumImportedId === 0) return false;
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SAVEPOINT cutover_identity_probe");
    const result = await client.query(`INSERT INTO ${quoteIdentifier(schema)}.telemetry_v1_records
      (chunk_row_id, participant_id, device_id, stream, occurrence_id, observed_at, observed_day, record_json)
      SELECT chunk_row_id, participant_id, device_id, stream, occurrence_id || '-identity-sequence-probe', observed_at, observed_day, record_json
      FROM ${quoteIdentifier(schema)}.telemetry_v1_records ORDER BY id LIMIT 1 RETURNING id`);
    let allocated;
    try { allocated = BigInt(result.rows[0]?.id); } catch { fail("CUTOVER_IDENTITY_SEQUENCE_NOT_ADVANCED"); }
    if (allocated <= BigInt(maximumImportedId)) fail("CUTOVER_IDENTITY_SEQUENCE_NOT_ADVANCED");
    await client.query("ROLLBACK TO SAVEPOINT cutover_identity_probe");
    await client.query("COMMIT");
    return true;
  } catch (error) {
    try { await client?.query("ROLLBACK"); } catch { /* Preserve the static probe failure. */ }
    if (error?.code?.startsWith("CUTOVER_")) throw error;
    fail("CUTOVER_IDENTITY_SEQUENCE_PROBE_FAILED");
  } finally {
    client?.release();
  }
}

async function proveV12RevokedCapabilityRefusal(pool, sourceDb, authority, now, expires) {
  const schema = "v12_revoked_guard";
  let schemaCreated = false;
  try {
    await pool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    schemaCreated = true;
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const additionalV1Uploads = sourceDb.prepare(`SELECT id AS "contributionId",
      device_upload_authorization_id AS "authorizationId", envelope_digest AS "envelopeDigest"
      FROM telemetry_v1_chunks WHERE id<>? ORDER BY id`).all(authority.v1Id);
    const additionalV12Uploads = sourceDb.prepare(`SELECT device_upload_authorization_id AS "authorizationId",
      id AS "contributionId", envelope_digest AS "envelopeDigest"
      FROM telemetry_v12_chunks ORDER BY id`).all();
    await seedTargetAuthority(pool, schema, { ...authority, now, expires, additionalV1Uploads, additionalV12Uploads });
    try {
      await importD1TelemetrySubset({
        sourceDb, pool, schema,
        afterBatch: async summary => {
          if (summary.table !== "telemetry_v12_device_capabilities") return;
          const revoked = await pool.query(`UPDATE ${quoteIdentifier(schema)}.telemetry_v12_device_capabilities
            SET state='revoked', revoked_at=$3 WHERE participant_id=$1 AND device_id=$2 AND state='accepted'`,
          [authority.participant, authority.device, now]);
          if (revoked.rowCount !== 1) fail("CUTOVER_V12_REVOKED_PROBE_CAPABILITY_MISSING");
        },
      });
      fail("CUTOVER_V12_REVOKED_IMPORT_UNEXPECTED_SUCCESS");
    } catch (error) {
      if (error?.code !== "CUTOVER_IMPORT_FAILED") throw error;
    }
    const rows = await pool.query(`SELECT count(*)::text AS n FROM ${quoteIdentifier(schema)}.telemetry_v12_typed_records`);
    const checkpointTable = journalTable(schema, REHEARSAL_CHECKPOINT_TABLE);
    const checkpoint = await pool.query(`SELECT imported_count, state FROM ${checkpointTable}
      WHERE table_name='telemetry_v12_records'`);
    const prerequisites = await pool.query(`SELECT table_name, expected_count, imported_count, state
      FROM ${checkpointTable} WHERE table_name=ANY($1::text[])`, [[
      "telemetry_v12_runtime", "telemetry_v12_device_capabilities",
      "typed_telemetry_dictionary", "telemetry_v12_day_manifests",
      "telemetry_v12_chunks", "telemetry_v12_attributions",
    ]]);
    if (Number(rows.rows[0]?.n) !== 0 || Number(checkpoint.rows[0]?.imported_count) !== 0
        || checkpoint.rows[0]?.state !== "copying") fail("CUTOVER_V12_REVOKED_PARTIAL_RECORD_IMPORT");
    if (prerequisites.rowCount !== 6 || prerequisites.rows.some(row => row.state !== "copied"
        || Number(row.imported_count) !== Number(row.expected_count))) fail("CUTOVER_V12_REVOKED_REFUSAL_NOT_AT_RECORD_GATE");
    return Object.freeze({ refused: true, failureSourceTable: "telemetry_v12_records" });
  } finally {
    if (schemaCreated) {
      try { await pool.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`); }
      catch { fail("CUTOVER_V12_REVOKED_PROBE_CLEANUP_FAILED"); }
    }
  }
}

async function proveHigherFloorRefusal(pool, sourceDb, authority, now, expires) {
  const schema = "higher_floor_guard";
  const sourceMinimumRank = sourceDb.prepare("SELECT minimum_rank FROM telemetry_transport_participant_floors WHERE participant_id=?").get(authority.participant)?.minimum_rank;
  if (!Number.isSafeInteger(sourceMinimumRank) || sourceMinimumRank >= Number.MAX_SAFE_INTEGER) fail("CUTOVER_SOURCE_FLOOR_MISSING");
  const higherRank = sourceMinimumRank + 1;
  let schemaCreated = false;
  try {
    await pool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    schemaCreated = true;
    await applyPostgresMigrations({ role: "primary", schema, pool });
    await seedTargetAuthority(pool, schema, { ...authority, now, expires, minimumRank: higherRank });
    try {
      await importD1TelemetrySubset({ sourceDb, pool, schema });
      fail("CUTOVER_HIGHER_FLOOR_PROBE_UNEXPECTED_SUCCESS");
    } catch (error) {
      if (error?.code !== "CUTOVER_IMPORT_FAILED") throw error;
    }
    for (const table of IMPORT_ORDER) {
      if (table === "telemetry_v12_runtime") {
        await assertV12RuntimeBootstrap(pool, schema);
        continue;
      }
      const result = await pool.query(`SELECT count(*)::int AS n FROM ${quoteIdentifier(schema)}.${quoteIdentifier(targetTableName(table))}`);
      if (result.rows[0]?.n !== 0) fail("CUTOVER_HIGHER_FLOOR_CHANGED_TARGET");
    }
    const floor = await pool.query(`SELECT minimum_rank, revision FROM ${quoteIdentifier(schema)}.telemetry_transport_participant_floors WHERE participant_id=$1`, [authority.participant]);
    if (floor.rows[0]?.minimum_rank !== higherRank || floor.rows[0]?.revision !== 0) fail("CUTOVER_HIGHER_FLOOR_CHANGED_TARGET");
  } finally {
    if (schemaCreated) {
      try { await pool.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`); } catch { fail("CUTOVER_HIGHER_FLOOR_PROBE_CLEANUP_FAILED"); }
    }
  }
}

export async function runLocalSyntheticPostgresCutoverRehearsal({ extraV1Chunks = 0, v1RecordPaddingBytes = 0 } = {}) {
  const socket = await verifyLocalSocket(safeSocketConfig().socket);
  const { port } = safeSocketConfig();
  const user = process.env.PG_TEST_USER || "postgres";
  const password = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
  const admin = new pg.Pool({ host: socket, port, user, password, database: "postgres", ssl: false, max: 2, connectionTimeoutMillis: 5000 });
  const token = randomBytes(6).toString("hex");
  const databaseName = `tcr_${token}`;
  const schema = "rehearsal";
  let targetPool;
  let sourceDb;
  let created = false;
  try {
    const locality = await admin.query("SELECT inet_server_addr() AS address");
    if (locality.rows[0]?.address !== null) fail("CUTOVER_POSTGRES_NOT_LOCAL_SOCKET");
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    targetPool = new pg.Pool({ host: socket, port, user, password, database: databaseName, ssl: false, max: 2, connectionTimeoutMillis: 5000 });
    AUTHORIZED_TARGET_POOLS.set(targetPool, Object.freeze({ socket, database: databaseName }));
    await targetPool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await applyPostgresMigrations({ role: "primary", schema, pool: targetPool });
    sourceDb = await createSyntheticCanonicalD1({ extraV1Chunks, v1RecordPaddingBytes });
    const sourceInventory = inventoryCutoverSource(sourceDb);
    const now = sourceDb.prepare("SELECT consented_at FROM telemetry_v1_device_consents LIMIT 1").get().consented_at;
    const expires = sourceDb.prepare("SELECT expires_at FROM device_credentials LIMIT 1").get().expires_at;
    const authority = {
      participant: "cutover-synthetic-participant", device: "cutover-synthetic-device",
      session: "cutover-synthetic-session", pairing: "cutover-synthetic-pairing",
      v1Auth: "cutover-synthetic-v1-upload", v11Auth: "cutover-synthetic-v11-upload",
      v1Id: "cutover-synthetic-v1-chunk", v11Chunk: `chunk:${"1".repeat(36)}`,
      v1Envelope: HASH("synthetic-v1-envelope"), v11Envelope: HASH("synthetic-v11-envelope"),
    };
    const additionalV1Uploads = sourceDb.prepare(`SELECT id AS "contributionId",
      device_upload_authorization_id AS "authorizationId", envelope_digest AS "envelopeDigest"
      FROM telemetry_v1_chunks WHERE id<>? ORDER BY id`).all(authority.v1Id);
    const additionalV12Uploads = sourceDb.prepare(`SELECT device_upload_authorization_id AS "authorizationId",
      id AS "contributionId", envelope_digest AS "envelopeDigest"
      FROM telemetry_v12_chunks ORDER BY id`).all();
    await seedTargetAuthority(targetPool, schema, { ...authority, now, expires, additionalV1Uploads, additionalV12Uploads });
    await proveHigherFloorRefusal(targetPool, sourceDb, authority, now, expires);
    const v12RevokedCapabilityProbe = await proveV12RevokedCapabilityRefusal(targetPool, sourceDb, authority, now, expires);
    const resumeProbe = await proveResumableImport(targetPool, schema, sourceDb);
    const result = resumeProbe.result;
    const identitySequenceAdvanced = await proveV1IdentitySequence(targetPool, schema, result.maxV1RecordId);
    await proveRepeatRefusal(targetPool, schema, sourceDb, result.imported);
    const v12TypedDigestRows = result.imported.filter(item => V12_TYPED_IMPORT_TABLES.includes(item.sourceTable));
    const v12MappedDigestRows = result.imported.filter(item => V12_MAPPED_IMPORT_TABLES.includes(item.sourceTable));
    const v12RuntimeDomainDigestRows = result.imported.filter(item => V12_RUNTIME_DOMAIN_IMPORT_TABLES.includes(item.sourceTable));
    const normalizedV12TypedSubsetReadBackMatched = v12TypedDigestRows.length === V12_TYPED_IMPORT_TABLES.length
      && v12TypedDigestRows.every(item => item.sourceSha256 === item.destinationSha256);
    const normalizedV12RuntimeDomainSubsetReadBackMatched = v12RuntimeDomainDigestRows.length === V12_RUNTIME_DOMAIN_IMPORT_TABLES.length
      && v12RuntimeDomainDigestRows.every(item => item.sourceSha256 === item.destinationSha256);
    const normalizedV12MappedSubsetReadBackMatched = v12MappedDigestRows.length === V12_MAPPED_IMPORT_TABLES.length
      && v12MappedDigestRows.every(item => item.sourceSha256 === item.destinationSha256);
    const sourceNames = sqliteTables(sourceDb);
    const importedSource = new Set(result.imported.map(item => item.sourceTable));
    return Object.freeze({
      schemaVersion: "tibotattle-postgres-cutover-rehearsal-v1",
      rehearsal: "synthetic-canonical-d1-to-local-postgres",
      contentFree: true,
      fullCutoverReady: false,
      ownerScope: "one synthetic social participant and one device",
      sourceInventory,
      sourceCoverage: result.coverage,
      imported: result.imported,
      fixtureEvidence: Object.freeze({
        v11ManifestStates: result.v11ManifestStates,
        totalImportedSourceRows: result.sourceRows,
        totalImportedSourceBytes: result.sourceBytes,
        committedBatchCount: resumeProbe.committedBatchCount,
        interruptedBatchRows: resumeProbe.interruptedBatchRows,
        interruptedSourceTable: resumeProbe.interruptedSourceTable,
        rolledBackSourceTable: resumeProbe.rolledBackSourceTable,
        revokedCapabilityFailureSourceTable: v12RevokedCapabilityProbe.failureSourceTable,
        v12RuntimeMirrorUpdateAndCheckpointRolledBack: resumeProbe.runtimeMirrorUpdateAndCheckpointRolledBack,
        v12MappedTableCount: v12MappedDigestRows.length,
        v12RuntimeDomainTableCount: v12RuntimeDomainDigestRows.length,
        v12ActiveHeadAuthority: result.v12ActiveHeadAuthority,
        batchMaximumRows: IMPORT_BATCH_MAX_ROWS,
        batchMaximumBytes: IMPORT_BATCH_MAX_BYTES,
        maximumSourceRowBytes: IMPORT_SOURCE_MAX_ROW_BYTES,
      }),
      notImported: sourceNames.filter(name => !SOURCE_MIGRATION_LEDGER_TABLES.includes(name) && !importedSource.has(name)).sort(),
      partiallyImportedTables: Object.freeze(["pending_quarantine_objects"]),
      storesNotImported: STORES_NOT_IMPORTED,
      checks: Object.freeze({
        canonicalD1MigrationsApplied: true,
        localUnixSocketOnly: true,
        targetStartedEmpty: true,
        boundedStreamingAndBatchWrites: true,
        batchInsertAndCheckpointAtomic: true,
        resumedAfterCommittedBatch: true,
        failedBatchAndCheckpointRolledBack: true,
        higherTransportFloorRefusedWithoutChange: true,
        v12RuntimeMirrorUpdateAndCheckpointRolledBack: resumeProbe.runtimeMirrorUpdateAndCheckpointRolledBack,
        v1IdentitySequenceAdvanced: identitySequenceAdvanced,
        persistedReadbackMatched: true,
        repeatRefusedWithoutChange: true,
        normalizedV12TypedSubsetReadBackMatched,
        normalizedV12RuntimeDomainSubsetReadBackMatched,
        normalizedV12MappedSubsetReadBackMatched,
        v12RuntimeMirrorMatched: result.v12RuntimeMirrorMatched,
        v12ActiveHeadAuthorityMatched: result.v12ActiveHeadAuthority.sourceHeadCount === result.v12ActiveHeadAuthority.eligibleHeadCount
          && result.v12ActiveHeadAuthority.targetHeadCount === result.v12ActiveHeadAuthority.sourceHeadCount,
        v12WrongStreamChildRefused: result.v12Integrity.wrongStreamChildRefused,
        v12BrokenDictionaryReferenceRefused: result.v12Integrity.brokenDictionaryReferenceRefused,
        v12IncompleteReadyTransitionRefused: result.v12Integrity.incompleteReadyTransitionRefused,
        v12RevokedAuthorityTransferRefused: v12RevokedCapabilityProbe.refused,
        productionImportNotApproved: true,
      }),
      note: "Synthetic partial-table rehearsal only. Checkpointed state is confined to this script-owned local rehearsal database; it is not a production transfer procedure. Identity parents were seeded synthetically. Accountless v1.2 authorization remains blocked because its enrollment-ledger and owner parents are not transferred. Identity, analytics, ledger, object families, source-schema objects, and unproven live source remain out of scope; full cutover remains blocked.",
    });
  } finally {
    let cleanupFailed = false;
    try { sourceDb?.close(); } catch { cleanupFailed = true; }
    try { await targetPool?.end(); } catch { cleanupFailed = true; }
    if (created && /^tcr_[0-9a-f]{12}$/u.test(databaseName)) {
      try { await admin.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`); } catch { cleanupFailed = true; }
    }
    try { await admin.end(); } catch { cleanupFailed = true; }
    if (cleanupFailed) fail("CUTOVER_DATABASE_CLEANUP_FAILED");
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  runLocalSyntheticPostgresCutoverRehearsal()
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => { process.stderr.write(`${error?.code ?? "CUTOVER_REHEARSAL_FAILED"}\n`); process.exitCode = 1; });
}
