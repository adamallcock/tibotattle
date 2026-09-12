PRAGMA foreign_keys = ON;

-- Accountless ownership needs nullable social-only participant columns.
-- D1 cannot ALTER DROP NOT NULL, so this migration snapshots every row in
-- the participant/device cascade, drops both roots with all triggers inert,
-- recreates the typed roots, and restores every pre-existing row by an
-- explicit column list before rebuilding the unchanged source objects.
PRAGMA defer_foreign_keys = true;

CREATE TABLE participants_0047_save AS SELECT id, access_token_id, access_token_hash, recovery_token_id, recovery_token_hash, state, consent_version, consented_at, created_at, deletion_session_id, identity_link_key, identity_cooldown_digest FROM participants;
CREATE TABLE attribution_enrollments_0047_save AS SELECT participant_id, namespace, created_at FROM attribution_enrollments;
CREATE TABLE community_aggregate_exclusions_0047_save AS SELECT exclusion_id, participant_id, scope, reason_code, state, effective_at, expires_at, created_at, created_by_digest, revoked_at, revoked_by_digest FROM community_aggregate_exclusions;
CREATE TABLE community_allowance_fit_cache_0047_save AS SELECT participant_id, cache_key, fits_json, computed_at, model_observations_json, input_fingerprint, source_method_version FROM community_allowance_fit_cache;
CREATE TABLE community_analytical_input_versions_0047_save AS SELECT participant_id, revision FROM community_analytical_input_versions;
CREATE TABLE community_model_composition_cache_0047_save AS SELECT participant_id, cache_key, composition_json, computed_at, input_fingerprint, source_method_version FROM community_model_composition_cache;
CREATE TABLE contributions_0047_save AS SELECT id, participant_id, envelope_digest, r2_key, envelope_schema_version, key_id, status, fixture_id, range_start, range_end, quota_window_minutes, quota_used_percent_before, quota_used_percent_after, quota_display_precision, model_id, subscription_speed, api_tier_assumption, input_uncached_tokens, input_cached_tokens, output_text_tokens, output_reasoning_tokens, web_search_calls, unknown_tool_units, estimated_api_cost_usd, priced_event_coverage_percent, unknown_billable_units, price_basis, created_at, upload_authorization_id, device_upload_authorization_id, quarantine_deleted_at FROM contributions;
CREATE TABLE device_credential_rotations_0047_save AS SELECT id, device_id, participant_id, prior_secret_hash, replacement_secret_hash, attempt_id, generation, rotated_at, retire_at, recovery_proof_hash FROM device_credential_rotations;
CREATE TABLE device_credentials_0047_save AS SELECT id, participant_id, paired_via_pairing_id, secret_hash, state, issued_at, expires_at, last_used_at, revoked_at, social_verified_at, credential_generation FROM device_credentials;
CREATE TABLE device_pairing_events_0047_save AS SELECT id, pairing_id, participant_id, kind, occurred_at FROM device_pairing_events;
CREATE TABLE device_pairings_0047_save AS SELECT id, participant_id, issued_by_session_id, secret_hash, consent_version, state, issued_at, expires_at, consumed_at, revoked_at, claimed_device_id, transport_consent_version FROM device_pairings;
CREATE TABLE device_upload_authorizations_0047_save AS SELECT id, participant_id, issued_by_device_id, secret_hash, envelope_digest, body_bytes, content_type, state, issued_at, expires_at, consumed_at, revoked_at, consume_lease_expires_at, consumed_contribution_id FROM device_upload_authorizations;
CREATE TABLE enrollment_grants_0047_save AS SELECT id, secret_hash, state, issued_at, expires_at, redeemed_at, redeemed_participant_id FROM enrollment_grants;
CREATE TABLE participant_community_eligibility_0047_save AS SELECT id, participant_id, grant_id, created_at FROM participant_community_eligibility;
CREATE TABLE recovery_retry_receipts_0047_save AS SELECT old_recovery_token_id, old_recovery_token_hash, recovery_attempt_hash, participant_id, derivation_nonce, replacement_recovery_token_id, replacement_session_id, issued_at, expires_at, replay_count FROM recovery_retry_receipts;
CREATE TABLE telemetry_contribution_admission_windows_0047_save AS SELECT participant_id, window_started_at, accepted_count, last_accepted_at FROM telemetry_contribution_admission_windows;
CREATE TABLE telemetry_contribution_occurrences_0047_save AS SELECT contribution_id, participant_id, record_kind, occurrence_id, dataset_id, account_track_id, policy_epoch FROM telemetry_contribution_occurrences;
CREATE TABLE telemetry_contributions_0047_save AS SELECT id, participant_id, plaintext_digest, envelope_digest, r2_key, status, schema_version, range_start, range_end, client_platform, provider_policy_epoch, estimated_api_cost_usd, priced_event_coverage_percent, unknown_model_event_count, unknown_billable_units, price_basis, declared_record_count, created_at, upload_authorization_id, server_cost_nanousd, server_priced_event_count, server_partially_priced_event_count, server_unpriced_event_count, server_pricing_method_version, server_price_registry_version, server_price_registry_sha256, transport_schema_version, dataset_id, dataset_part_index, dataset_part_count, dataset_completeness, dataset_range_start, dataset_range_end, device_upload_authorization_id, quarantine_deleted_at, accepted_record_count, server_price_basis, server_price_epoch_basis, server_price_event_time_start, server_price_event_time_end FROM telemetry_contributions;
CREATE TABLE telemetry_records_0047_save AS SELECT id, origin_contribution_id, participant_id, record_kind, occurrence_id, observed_at, provider, model_id, model_fingerprint, speed_mode, api_service_tier, surface, plan_type, plan_variant, limit_id, slot, used_percent, window_duration_minutes, resets_at, input_uncached_tokens, input_cache_read_tokens, input_cache_write_tokens, output_text_tokens, output_reasoning_tokens, output_combined_tokens, tool_units, estimated_api_cost_usd, pricing_coverage_percent, unknown_billable_units, record_json, billing_surface, total_input_context_tokens, reasoning_effort, agent_scope, server_cost_usd, server_cost_nanousd, server_pricing_coverage_percent, server_unknown_billable_units, server_pricing_status, server_pricing_method_version, server_price_registry_version, server_price_registry_sha256, server_price_card_ids, server_unpriced_reason_codes, server_price_epoch_basis, server_tier_basis, server_api_service_tier, account_track_id, dataset_id, policy_epoch, server_price_basis, server_price_event_time FROM telemetry_records;
CREATE TABLE telemetry_transport_floor_rollbacks_0047_save AS SELECT operation_id, participant_id, participant_digest, expected_revision, from_rank, to_rank, created_at FROM telemetry_transport_floor_rollbacks;
CREATE TABLE telemetry_transport_participant_floors_0047_save AS SELECT participant_id, minimum_rank, revision, changed_at FROM telemetry_transport_participant_floors;
CREATE TABLE telemetry_v11_chunks_0047_save AS SELECT id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq, chunk_id, chunk_digest, envelope_digest, parser_version, record_count, r2_key, device_upload_authorization_id, quarantine_deleted_at, created_at FROM telemetry_v11_chunks;
CREATE TABLE telemetry_v11_day_manifests_0047_save AS SELECT id, participant_id, device_id, chunk_day, manifest_digest, parser_version, manifest_json, expected_chunk_count, state, created_at, ready_at FROM telemetry_v11_day_manifests;
CREATE TABLE telemetry_v11_device_consents_0047_save AS SELECT participant_id, device_id, telemetry_schema_version, field_dictionary_version, privacy_contract_version, consented_at FROM telemetry_v11_device_consents;
CREATE TABLE telemetry_v11_domain_days_0047_save AS SELECT generation_id, observed_day, manifest_id FROM telemetry_v11_domain_days;
CREATE TABLE telemetry_v11_domain_heads_0047_save AS SELECT participant_id, generation_id, revision, updated_at FROM telemetry_v11_domain_heads;
CREATE TABLE telemetry_v11_domain_predecessors_0047_save AS SELECT token_hash, participant_id, device_id, previous_generation_id, legacy_fingerprint, input_revision, from_day, through_day, winners_json, created_at, expires_at, consumed_at FROM telemetry_v11_domain_predecessors;
CREATE TABLE telemetry_v11_domains_0047_save AS SELECT id, participant_id, device_id, predecessor_token_hash, previous_generation_id, manifest_digest, legacy_fingerprint, input_revision, from_day, through_day, days_json, created_at FROM telemetry_v11_domains;
CREATE TABLE telemetry_v11_records_0047_save AS SELECT chunk_id, manifest_id, stream, occurrence_id, observed_at, record_json, legacy_occurrence_id, legacy_record_json FROM telemetry_v11_records;
CREATE TABLE telemetry_v1_chunk_admission_windows_0047_save AS SELECT participant_id, device_id, window_day, accepted_count, last_accepted_at FROM telemetry_v1_chunk_admission_windows;
CREATE TABLE telemetry_v1_chunks_0047_save AS SELECT id, participant_id, device_id, stream, chunk_day, chunk_seq, revision, chunk_digest, envelope_digest, parser_version, record_count, accepted_record_count, r2_key, device_upload_authorization_id, superseded_at, quarantine_deleted_at, created_at FROM telemetry_v1_chunks;
CREATE TABLE telemetry_v1_device_consents_0047_save AS SELECT participant_id, device_id, telemetry_schema_version, field_dictionary_version, privacy_contract_version, consented_at FROM telemetry_v1_device_consents;
CREATE TABLE telemetry_v1_records_0047_save AS SELECT id, chunk_row_id, participant_id, device_id, stream, occurrence_id, observed_at, observed_day, provider, model_id, session_uuid, plan_type, plan_variant, limit_id, slot, used_percent, window_duration_minutes, resets_at, input_uncached_tokens, input_cache_read_tokens, input_cache_write_tokens, output_text_tokens, output_reasoning_tokens, output_combined_tokens, record_json FROM telemetry_v1_records;
CREATE TABLE upload_authorizations_0047_save AS SELECT id, participant_id, issued_by_session_id, secret_hash, envelope_digest, body_bytes, content_type, state, issued_at, expires_at, consumed_at, revoked_at, consume_lease_expires_at, consumed_contribution_id FROM upload_authorizations;
CREATE TABLE web_sessions_0047_save AS SELECT id, participant_id, secret_hash, csrf_hash, scope, state, issued_at, expires_at, last_used_at, revoked_at FROM web_sessions;

-- A parent DROP fires ON DELETE actions even with deferred foreign keys.
-- Remove every source trigger/view before that cascade so no historical
-- restore is re-admitted, mutated, or rejected by a current-time guard.
DROP TRIGGER IF EXISTS attribution_enrollment_created;
DROP TRIGGER IF EXISTS attribution_enrollment_immutable;
DROP TRIGGER IF EXISTS community_aggregate_exclusion_changed;
DROP TRIGGER IF EXISTS community_aggregate_exclusion_inserted;
DROP TRIGGER IF EXISTS community_aggregate_exclusion_no_delete;
DROP TRIGGER IF EXISTS community_allowance_input_mutated;
DROP TRIGGER IF EXISTS community_analytical_input_legacy_delete;
DROP TRIGGER IF EXISTS community_analytical_input_legacy_insert;
DROP TRIGGER IF EXISTS community_analytical_input_legacy_update;
DROP TRIGGER IF EXISTS community_analytical_input_participant_created;
DROP TRIGGER IF EXISTS community_analytical_input_participant_state;
DROP TRIGGER IF EXISTS community_analytical_input_v1_delete;
DROP TRIGGER IF EXISTS community_analytical_input_v1_insert;
DROP TRIGGER IF EXISTS community_analytical_input_v1_update;
DROP TRIGGER IF EXISTS community_daily_aggregate_participant_withdrawal;
DROP TRIGGER IF EXISTS community_daily_aggregates_immutable;
DROP TRIGGER IF EXISTS community_daily_aggregates_no_delete;
DROP TRIGGER IF EXISTS community_model_composition_day_withdrawal;
DROP TRIGGER IF EXISTS community_snapshot_contribution_deleting;
DROP TRIGGER IF EXISTS community_snapshot_contribution_direct_delete;
DROP TRIGGER IF EXISTS community_snapshot_participant_withdrawal;
DROP TRIGGER IF EXISTS community_snapshot_policy_changed;
DROP TRIGGER IF EXISTS community_snapshot_policy_no_delete;
DROP TRIGGER IF EXISTS community_weekly_snapshots_immutable;
DROP TRIGGER IF EXISTS community_weekly_snapshots_no_delete;
DROP TRIGGER IF EXISTS contributions_block_reconciling_quarantine;
DROP TRIGGER IF EXISTS contributions_clear_pending_quarantine;
DROP TRIGGER IF EXISTS contributions_consume_device_upload;
DROP TRIGGER IF EXISTS contributions_consume_session_upload;
DROP TRIGGER IF EXISTS contributions_require_active_participant;
DROP TRIGGER IF EXISTS contributions_require_consuming_upload;
DROP TRIGGER IF EXISTS device_credentials_require_active_pairing;
DROP TRIGGER IF EXISTS device_upload_authorizations_require_active_device;
DROP TRIGGER IF EXISTS participant_community_eligibility_requires_redeemed_grant;
DROP TRIGGER IF EXISTS participants_identity_reenrollment_cooldown_guard;
DROP TRIGGER IF EXISTS telemetry_contributions_block_reconciling_quarantine;
DROP TRIGGER IF EXISTS telemetry_contributions_clear_pending_quarantine;
DROP TRIGGER IF EXISTS telemetry_contributions_consume_device_upload;
DROP TRIGGER IF EXISTS telemetry_contributions_consume_session_upload;
DROP TRIGGER IF EXISTS telemetry_contributions_dataset_metadata_insert;
DROP TRIGGER IF EXISTS telemetry_contributions_dataset_metadata_update;
DROP TRIGGER IF EXISTS telemetry_contributions_enforce_admission_window;
DROP TRIGGER IF EXISTS telemetry_contributions_record_admission_window;
DROP TRIGGER IF EXISTS telemetry_contributions_require_active_participant;
DROP TRIGGER IF EXISTS telemetry_contributions_require_consuming_upload;
DROP TRIGGER IF EXISTS telemetry_transport_floor_created;
DROP TRIGGER IF EXISTS telemetry_transport_floor_no_implicit_downgrade;
DROP TRIGGER IF EXISTS telemetry_transport_floor_revision;
DROP TRIGGER IF EXISTS telemetry_transport_floor_successor_history_guard;
DROP TRIGGER IF EXISTS telemetry_transport_format_identity_immutable;
DROP TRIGGER IF EXISTS telemetry_transport_legacy_insert;
DROP TRIGGER IF EXISTS telemetry_transport_rollback_owner_only;
DROP TRIGGER IF EXISTS telemetry_transport_v1_insert;
DROP TRIGGER IF EXISTS telemetry_v11_active_day_delete_guard;
DROP TRIGGER IF EXISTS telemetry_v11_active_domain_delete_guard;
DROP TRIGGER IF EXISTS telemetry_v11_active_head_delete_guard;
DROP TRIGGER IF EXISTS telemetry_v11_active_record_delete_guard;
DROP TRIGGER IF EXISTS telemetry_v11_chunk_admission;
DROP TRIGGER IF EXISTS telemetry_v11_chunk_immutable;
DROP TRIGGER IF EXISTS telemetry_v11_chunks_enforce_admission;
DROP TRIGGER IF EXISTS telemetry_v11_chunks_record_admission;
DROP TRIGGER IF EXISTS telemetry_v11_consent_admission;
DROP TRIGGER IF EXISTS telemetry_v11_consent_floor;
DROP TRIGGER IF EXISTS telemetry_v11_consent_immutable;
DROP TRIGGER IF EXISTS telemetry_v11_domain_complete_before_insert;
DROP TRIGGER IF EXISTS telemetry_v11_domain_day_member;
DROP TRIGGER IF EXISTS telemetry_v11_domain_days_immutable;
DROP TRIGGER IF EXISTS telemetry_v11_domain_immutable;
DROP TRIGGER IF EXISTS telemetry_v11_head_insert_guard;
DROP TRIGGER IF EXISTS telemetry_v11_head_insert_publish;
DROP TRIGGER IF EXISTS telemetry_v11_head_update_guard;
DROP TRIGGER IF EXISTS telemetry_v11_head_update_publish;
DROP TRIGGER IF EXISTS telemetry_v11_manifest_admission;
DROP TRIGGER IF EXISTS telemetry_v11_manifest_immutable;
DROP TRIGGER IF EXISTS telemetry_v11_manifest_ready;
DROP TRIGGER IF EXISTS telemetry_v11_predecessor_immutable;
DROP TRIGGER IF EXISTS telemetry_v11_record_admission;
DROP TRIGGER IF EXISTS telemetry_v11_record_immutable;
DROP TRIGGER IF EXISTS telemetry_v1_chunks_consume_device_upload;
DROP TRIGGER IF EXISTS telemetry_v1_chunks_enforce_admission;
DROP TRIGGER IF EXISTS telemetry_v1_chunks_enqueue_daily_rebuild;
DROP TRIGGER IF EXISTS telemetry_v1_chunks_record_admission;
DROP TRIGGER IF EXISTS telemetry_v1_chunks_require_active_participant;
DROP TRIGGER IF EXISTS telemetry_v1_chunks_require_consuming_upload;
DROP TRIGGER IF EXISTS upload_authorizations_require_active_participant;
DROP TRIGGER IF EXISTS web_sessions_require_active_participant;
DROP VIEW IF EXISTS telemetry_analytical_chunks;
DROP VIEW IF EXISTS telemetry_analytical_records;
DROP VIEW IF EXISTS telemetry_v11_activatable_domains;
DROP VIEW IF EXISTS telemetry_v11_active_records;
DROP VIEW IF EXISTS telemetry_v11_current_predecessors;

DROP TABLE participants;

CREATE TABLE participants (
  id TEXT PRIMARY KEY NOT NULL,
  owner_kind TEXT NOT NULL DEFAULT 'social'
    CHECK (owner_kind IN ('social', 'accountless')),
  access_token_id TEXT UNIQUE,
  access_token_hash BLOB,
  recovery_token_id TEXT UNIQUE,
  recovery_token_hash BLOB,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'deleting')),
  consent_version TEXT,
  consented_at TEXT,
  created_at TEXT NOT NULL,
  deletion_session_id TEXT,
  identity_link_key TEXT,
  identity_cooldown_digest TEXT
    CHECK (
      identity_cooldown_digest IS NULL
      OR (
        length(identity_cooldown_digest) = 64
        AND identity_cooldown_digest NOT GLOB '*[^0-9a-f]*'
      )
    )
) STRICT;

DROP TABLE device_credentials;

CREATE TABLE device_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  participant_id TEXT NOT NULL,
  authority_kind TEXT NOT NULL DEFAULT 'social'
    CHECK (authority_kind IN ('social', 'accountless')),
  paired_via_pairing_id TEXT UNIQUE,
  accountless_enrollment_device_id TEXT UNIQUE,
  secret_hash BLOB NOT NULL CHECK (length(secret_hash) = 32),
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'revoked')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  revoked_at TEXT,
  social_verified_at TEXT,
  credential_generation INTEGER NOT NULL DEFAULT 1
    CHECK (credential_generation >= 1),
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (paired_via_pairing_id) REFERENCES device_pairings(id) ON DELETE CASCADE,
  FOREIGN KEY (accountless_enrollment_device_id)
    REFERENCES accountless_enrollment_ledger(device_id) ON DELETE RESTRICT
) STRICT;

-- Some descendants are not ON DELETE CASCADE children of the two rebuilt
-- roots (for example append-only exclusions and analytical caches). Clear
-- every preserved source table before replaying its snapshot so those rows
-- are restored exactly once. The source triggers are gone and foreign keys
-- remain deferred for this rebuild.
DELETE FROM telemetry_v11_records;
DELETE FROM telemetry_v11_domain_days;
DELETE FROM telemetry_v11_domain_heads;
DELETE FROM telemetry_v11_domains;
DELETE FROM telemetry_v11_domain_predecessors;
DELETE FROM telemetry_v11_chunks;
DELETE FROM telemetry_v11_day_manifests;
DELETE FROM telemetry_v11_device_consents;
DELETE FROM telemetry_v1_records;
DELETE FROM telemetry_v1_chunks;
DELETE FROM telemetry_v1_chunk_admission_windows;
DELETE FROM telemetry_v1_device_consents;
DELETE FROM telemetry_records;
DELETE FROM telemetry_contribution_occurrences;
DELETE FROM telemetry_contributions;
DELETE FROM telemetry_contribution_admission_windows;
DELETE FROM contributions;
DELETE FROM device_upload_authorizations;
DELETE FROM upload_authorizations;
DELETE FROM device_credential_rotations;
DELETE FROM device_pairing_events;
DELETE FROM device_pairings;
DELETE FROM web_sessions;
DELETE FROM recovery_retry_receipts;
DELETE FROM participant_community_eligibility;
DELETE FROM enrollment_grants;
DELETE FROM attribution_enrollments;
DELETE FROM community_aggregate_exclusions;
DELETE FROM community_allowance_fit_cache;
DELETE FROM community_analytical_input_versions;
DELETE FROM community_model_composition_cache;
DELETE FROM telemetry_transport_floor_rollbacks;
DELETE FROM telemetry_transport_participant_floors;

INSERT INTO participants (id, access_token_id, access_token_hash, recovery_token_id, recovery_token_hash, state, consent_version, consented_at, created_at, deletion_session_id, identity_link_key, identity_cooldown_digest) SELECT id, access_token_id, access_token_hash, recovery_token_id, recovery_token_hash, state, consent_version, consented_at, created_at, deletion_session_id, identity_link_key, identity_cooldown_digest FROM participants_0047_save;
INSERT INTO attribution_enrollments (participant_id, namespace, created_at) SELECT participant_id, namespace, created_at FROM attribution_enrollments_0047_save;
INSERT INTO community_aggregate_exclusions (exclusion_id, participant_id, scope, reason_code, state, effective_at, expires_at, created_at, created_by_digest, revoked_at, revoked_by_digest) SELECT exclusion_id, participant_id, scope, reason_code, state, effective_at, expires_at, created_at, created_by_digest, revoked_at, revoked_by_digest FROM community_aggregate_exclusions_0047_save;
INSERT INTO community_allowance_fit_cache (participant_id, cache_key, fits_json, computed_at, model_observations_json, input_fingerprint, source_method_version) SELECT participant_id, cache_key, fits_json, computed_at, model_observations_json, input_fingerprint, source_method_version FROM community_allowance_fit_cache_0047_save;
INSERT INTO community_analytical_input_versions (participant_id, revision) SELECT participant_id, revision FROM community_analytical_input_versions_0047_save;
INSERT INTO community_model_composition_cache (participant_id, cache_key, composition_json, computed_at, input_fingerprint, source_method_version) SELECT participant_id, cache_key, composition_json, computed_at, input_fingerprint, source_method_version FROM community_model_composition_cache_0047_save;
INSERT INTO contributions (id, participant_id, envelope_digest, r2_key, envelope_schema_version, key_id, status, fixture_id, range_start, range_end, quota_window_minutes, quota_used_percent_before, quota_used_percent_after, quota_display_precision, model_id, subscription_speed, api_tier_assumption, input_uncached_tokens, input_cached_tokens, output_text_tokens, output_reasoning_tokens, web_search_calls, unknown_tool_units, estimated_api_cost_usd, priced_event_coverage_percent, unknown_billable_units, price_basis, created_at, upload_authorization_id, device_upload_authorization_id, quarantine_deleted_at) SELECT id, participant_id, envelope_digest, r2_key, envelope_schema_version, key_id, status, fixture_id, range_start, range_end, quota_window_minutes, quota_used_percent_before, quota_used_percent_after, quota_display_precision, model_id, subscription_speed, api_tier_assumption, input_uncached_tokens, input_cached_tokens, output_text_tokens, output_reasoning_tokens, web_search_calls, unknown_tool_units, estimated_api_cost_usd, priced_event_coverage_percent, unknown_billable_units, price_basis, created_at, upload_authorization_id, device_upload_authorization_id, quarantine_deleted_at FROM contributions_0047_save;
INSERT INTO device_credential_rotations (id, device_id, participant_id, prior_secret_hash, replacement_secret_hash, attempt_id, generation, rotated_at, retire_at, recovery_proof_hash) SELECT id, device_id, participant_id, prior_secret_hash, replacement_secret_hash, attempt_id, generation, rotated_at, retire_at, recovery_proof_hash FROM device_credential_rotations_0047_save;
INSERT INTO device_credentials (id, participant_id, paired_via_pairing_id, secret_hash, state, issued_at, expires_at, last_used_at, revoked_at, social_verified_at, credential_generation) SELECT id, participant_id, paired_via_pairing_id, secret_hash, state, issued_at, expires_at, last_used_at, revoked_at, social_verified_at, credential_generation FROM device_credentials_0047_save;
INSERT INTO device_pairing_events (id, pairing_id, participant_id, kind, occurred_at) SELECT id, pairing_id, participant_id, kind, occurred_at FROM device_pairing_events_0047_save;
INSERT INTO device_pairings (id, participant_id, issued_by_session_id, secret_hash, consent_version, state, issued_at, expires_at, consumed_at, revoked_at, claimed_device_id, transport_consent_version) SELECT id, participant_id, issued_by_session_id, secret_hash, consent_version, state, issued_at, expires_at, consumed_at, revoked_at, claimed_device_id, transport_consent_version FROM device_pairings_0047_save;
INSERT INTO device_upload_authorizations (id, participant_id, issued_by_device_id, secret_hash, envelope_digest, body_bytes, content_type, state, issued_at, expires_at, consumed_at, revoked_at, consume_lease_expires_at, consumed_contribution_id) SELECT id, participant_id, issued_by_device_id, secret_hash, envelope_digest, body_bytes, content_type, state, issued_at, expires_at, consumed_at, revoked_at, consume_lease_expires_at, consumed_contribution_id FROM device_upload_authorizations_0047_save;
INSERT INTO enrollment_grants (id, secret_hash, state, issued_at, expires_at, redeemed_at, redeemed_participant_id) SELECT id, secret_hash, state, issued_at, expires_at, redeemed_at, redeemed_participant_id FROM enrollment_grants_0047_save;
INSERT INTO participant_community_eligibility (id, participant_id, grant_id, created_at) SELECT id, participant_id, grant_id, created_at FROM participant_community_eligibility_0047_save;
INSERT INTO recovery_retry_receipts (old_recovery_token_id, old_recovery_token_hash, recovery_attempt_hash, participant_id, derivation_nonce, replacement_recovery_token_id, replacement_session_id, issued_at, expires_at, replay_count) SELECT old_recovery_token_id, old_recovery_token_hash, recovery_attempt_hash, participant_id, derivation_nonce, replacement_recovery_token_id, replacement_session_id, issued_at, expires_at, replay_count FROM recovery_retry_receipts_0047_save;
INSERT INTO telemetry_contribution_admission_windows (participant_id, window_started_at, accepted_count, last_accepted_at) SELECT participant_id, window_started_at, accepted_count, last_accepted_at FROM telemetry_contribution_admission_windows_0047_save;
INSERT INTO telemetry_contribution_occurrences (contribution_id, participant_id, record_kind, occurrence_id, dataset_id, account_track_id, policy_epoch) SELECT contribution_id, participant_id, record_kind, occurrence_id, dataset_id, account_track_id, policy_epoch FROM telemetry_contribution_occurrences_0047_save;
INSERT INTO telemetry_contributions (id, participant_id, plaintext_digest, envelope_digest, r2_key, status, schema_version, range_start, range_end, client_platform, provider_policy_epoch, estimated_api_cost_usd, priced_event_coverage_percent, unknown_model_event_count, unknown_billable_units, price_basis, declared_record_count, created_at, upload_authorization_id, server_cost_nanousd, server_priced_event_count, server_partially_priced_event_count, server_unpriced_event_count, server_pricing_method_version, server_price_registry_version, server_price_registry_sha256, transport_schema_version, dataset_id, dataset_part_index, dataset_part_count, dataset_completeness, dataset_range_start, dataset_range_end, device_upload_authorization_id, quarantine_deleted_at, accepted_record_count, server_price_basis, server_price_epoch_basis, server_price_event_time_start, server_price_event_time_end) SELECT id, participant_id, plaintext_digest, envelope_digest, r2_key, status, schema_version, range_start, range_end, client_platform, provider_policy_epoch, estimated_api_cost_usd, priced_event_coverage_percent, unknown_model_event_count, unknown_billable_units, price_basis, declared_record_count, created_at, upload_authorization_id, server_cost_nanousd, server_priced_event_count, server_partially_priced_event_count, server_unpriced_event_count, server_pricing_method_version, server_price_registry_version, server_price_registry_sha256, transport_schema_version, dataset_id, dataset_part_index, dataset_part_count, dataset_completeness, dataset_range_start, dataset_range_end, device_upload_authorization_id, quarantine_deleted_at, accepted_record_count, server_price_basis, server_price_epoch_basis, server_price_event_time_start, server_price_event_time_end FROM telemetry_contributions_0047_save;
INSERT INTO telemetry_records (id, origin_contribution_id, participant_id, record_kind, occurrence_id, observed_at, provider, model_id, model_fingerprint, speed_mode, api_service_tier, surface, plan_type, plan_variant, limit_id, slot, used_percent, window_duration_minutes, resets_at, input_uncached_tokens, input_cache_read_tokens, input_cache_write_tokens, output_text_tokens, output_reasoning_tokens, output_combined_tokens, tool_units, estimated_api_cost_usd, pricing_coverage_percent, unknown_billable_units, record_json, billing_surface, total_input_context_tokens, reasoning_effort, agent_scope, server_cost_usd, server_cost_nanousd, server_pricing_coverage_percent, server_unknown_billable_units, server_pricing_status, server_pricing_method_version, server_price_registry_version, server_price_registry_sha256, server_price_card_ids, server_unpriced_reason_codes, server_price_epoch_basis, server_tier_basis, server_api_service_tier, account_track_id, dataset_id, policy_epoch, server_price_basis, server_price_event_time) SELECT id, origin_contribution_id, participant_id, record_kind, occurrence_id, observed_at, provider, model_id, model_fingerprint, speed_mode, api_service_tier, surface, plan_type, plan_variant, limit_id, slot, used_percent, window_duration_minutes, resets_at, input_uncached_tokens, input_cache_read_tokens, input_cache_write_tokens, output_text_tokens, output_reasoning_tokens, output_combined_tokens, tool_units, estimated_api_cost_usd, pricing_coverage_percent, unknown_billable_units, record_json, billing_surface, total_input_context_tokens, reasoning_effort, agent_scope, server_cost_usd, server_cost_nanousd, server_pricing_coverage_percent, server_unknown_billable_units, server_pricing_status, server_pricing_method_version, server_price_registry_version, server_price_registry_sha256, server_price_card_ids, server_unpriced_reason_codes, server_price_epoch_basis, server_tier_basis, server_api_service_tier, account_track_id, dataset_id, policy_epoch, server_price_basis, server_price_event_time FROM telemetry_records_0047_save;
INSERT INTO telemetry_transport_floor_rollbacks (operation_id, participant_id, participant_digest, expected_revision, from_rank, to_rank, created_at) SELECT operation_id, participant_id, participant_digest, expected_revision, from_rank, to_rank, created_at FROM telemetry_transport_floor_rollbacks_0047_save;
INSERT INTO telemetry_transport_participant_floors (participant_id, minimum_rank, revision, changed_at) SELECT participant_id, minimum_rank, revision, changed_at FROM telemetry_transport_participant_floors_0047_save;
INSERT INTO telemetry_v11_chunks (id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq, chunk_id, chunk_digest, envelope_digest, parser_version, record_count, r2_key, device_upload_authorization_id, quarantine_deleted_at, created_at) SELECT id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq, chunk_id, chunk_digest, envelope_digest, parser_version, record_count, r2_key, device_upload_authorization_id, quarantine_deleted_at, created_at FROM telemetry_v11_chunks_0047_save;
INSERT INTO telemetry_v11_day_manifests (id, participant_id, device_id, chunk_day, manifest_digest, parser_version, manifest_json, expected_chunk_count, state, created_at, ready_at) SELECT id, participant_id, device_id, chunk_day, manifest_digest, parser_version, manifest_json, expected_chunk_count, state, created_at, ready_at FROM telemetry_v11_day_manifests_0047_save;
INSERT INTO telemetry_v11_device_consents (participant_id, device_id, telemetry_schema_version, field_dictionary_version, privacy_contract_version, consented_at) SELECT participant_id, device_id, telemetry_schema_version, field_dictionary_version, privacy_contract_version, consented_at FROM telemetry_v11_device_consents_0047_save;
INSERT INTO telemetry_v11_domain_days (generation_id, observed_day, manifest_id) SELECT generation_id, observed_day, manifest_id FROM telemetry_v11_domain_days_0047_save;
INSERT INTO telemetry_v11_domain_heads (participant_id, generation_id, revision, updated_at) SELECT participant_id, generation_id, revision, updated_at FROM telemetry_v11_domain_heads_0047_save;
INSERT INTO telemetry_v11_domain_predecessors (token_hash, participant_id, device_id, previous_generation_id, legacy_fingerprint, input_revision, from_day, through_day, winners_json, created_at, expires_at, consumed_at) SELECT token_hash, participant_id, device_id, previous_generation_id, legacy_fingerprint, input_revision, from_day, through_day, winners_json, created_at, expires_at, consumed_at FROM telemetry_v11_domain_predecessors_0047_save;
INSERT INTO telemetry_v11_domains (id, participant_id, device_id, predecessor_token_hash, previous_generation_id, manifest_digest, legacy_fingerprint, input_revision, from_day, through_day, days_json, created_at) SELECT id, participant_id, device_id, predecessor_token_hash, previous_generation_id, manifest_digest, legacy_fingerprint, input_revision, from_day, through_day, days_json, created_at FROM telemetry_v11_domains_0047_save;
INSERT INTO telemetry_v11_records (chunk_id, manifest_id, stream, occurrence_id, observed_at, record_json, legacy_occurrence_id, legacy_record_json) SELECT chunk_id, manifest_id, stream, occurrence_id, observed_at, record_json, legacy_occurrence_id, legacy_record_json FROM telemetry_v11_records_0047_save;
INSERT INTO telemetry_v1_chunk_admission_windows (participant_id, device_id, window_day, accepted_count, last_accepted_at) SELECT participant_id, device_id, window_day, accepted_count, last_accepted_at FROM telemetry_v1_chunk_admission_windows_0047_save;
INSERT INTO telemetry_v1_chunks (id, participant_id, device_id, stream, chunk_day, chunk_seq, revision, chunk_digest, envelope_digest, parser_version, record_count, accepted_record_count, r2_key, device_upload_authorization_id, superseded_at, quarantine_deleted_at, created_at) SELECT id, participant_id, device_id, stream, chunk_day, chunk_seq, revision, chunk_digest, envelope_digest, parser_version, record_count, accepted_record_count, r2_key, device_upload_authorization_id, superseded_at, quarantine_deleted_at, created_at FROM telemetry_v1_chunks_0047_save;
INSERT INTO telemetry_v1_device_consents (participant_id, device_id, telemetry_schema_version, field_dictionary_version, privacy_contract_version, consented_at) SELECT participant_id, device_id, telemetry_schema_version, field_dictionary_version, privacy_contract_version, consented_at FROM telemetry_v1_device_consents_0047_save;
INSERT INTO telemetry_v1_records (id, chunk_row_id, participant_id, device_id, stream, occurrence_id, observed_at, observed_day, provider, model_id, session_uuid, plan_type, plan_variant, limit_id, slot, used_percent, window_duration_minutes, resets_at, input_uncached_tokens, input_cache_read_tokens, input_cache_write_tokens, output_text_tokens, output_reasoning_tokens, output_combined_tokens, record_json) SELECT id, chunk_row_id, participant_id, device_id, stream, occurrence_id, observed_at, observed_day, provider, model_id, session_uuid, plan_type, plan_variant, limit_id, slot, used_percent, window_duration_minutes, resets_at, input_uncached_tokens, input_cache_read_tokens, input_cache_write_tokens, output_text_tokens, output_reasoning_tokens, output_combined_tokens, record_json FROM telemetry_v1_records_0047_save;
INSERT INTO upload_authorizations (id, participant_id, issued_by_session_id, secret_hash, envelope_digest, body_bytes, content_type, state, issued_at, expires_at, consumed_at, revoked_at, consume_lease_expires_at, consumed_contribution_id) SELECT id, participant_id, issued_by_session_id, secret_hash, envelope_digest, body_bytes, content_type, state, issued_at, expires_at, consumed_at, revoked_at, consume_lease_expires_at, consumed_contribution_id FROM upload_authorizations_0047_save;
INSERT INTO web_sessions (id, participant_id, secret_hash, csrf_hash, scope, state, issued_at, expires_at, last_used_at, revoked_at) SELECT id, participant_id, secret_hash, csrf_hash, scope, state, issued_at, expires_at, last_used_at, revoked_at FROM web_sessions_0047_save;

DROP TABLE participants_0047_save;
DROP TABLE attribution_enrollments_0047_save;
DROP TABLE community_aggregate_exclusions_0047_save;
DROP TABLE community_allowance_fit_cache_0047_save;
DROP TABLE community_analytical_input_versions_0047_save;
DROP TABLE community_model_composition_cache_0047_save;
DROP TABLE contributions_0047_save;
DROP TABLE device_credential_rotations_0047_save;
DROP TABLE device_credentials_0047_save;
DROP TABLE device_pairing_events_0047_save;
DROP TABLE device_pairings_0047_save;
DROP TABLE device_upload_authorizations_0047_save;
DROP TABLE enrollment_grants_0047_save;
DROP TABLE participant_community_eligibility_0047_save;
DROP TABLE recovery_retry_receipts_0047_save;
DROP TABLE telemetry_contribution_admission_windows_0047_save;
DROP TABLE telemetry_contribution_occurrences_0047_save;
DROP TABLE telemetry_contributions_0047_save;
DROP TABLE telemetry_records_0047_save;
DROP TABLE telemetry_transport_floor_rollbacks_0047_save;
DROP TABLE telemetry_transport_participant_floors_0047_save;
DROP TABLE telemetry_v11_chunks_0047_save;
DROP TABLE telemetry_v11_day_manifests_0047_save;
DROP TABLE telemetry_v11_device_consents_0047_save;
DROP TABLE telemetry_v11_domain_days_0047_save;
DROP TABLE telemetry_v11_domain_heads_0047_save;
DROP TABLE telemetry_v11_domain_predecessors_0047_save;
DROP TABLE telemetry_v11_domains_0047_save;
DROP TABLE telemetry_v11_records_0047_save;
DROP TABLE telemetry_v1_chunk_admission_windows_0047_save;
DROP TABLE telemetry_v1_chunks_0047_save;
DROP TABLE telemetry_v1_device_consents_0047_save;
DROP TABLE telemetry_v1_records_0047_save;
DROP TABLE upload_authorizations_0047_save;
DROP TABLE web_sessions_0047_save;

CREATE TABLE accountless_upload_owners (
  enrollment_device_id TEXT PRIMARY KEY NOT NULL
    REFERENCES accountless_enrollment_ledger(device_id) ON DELETE RESTRICT,
  participant_id TEXT NOT NULL UNIQUE
    REFERENCES participants(id) ON DELETE CASCADE,
  device_credential_id TEXT NOT NULL UNIQUE
    REFERENCES device_credentials(id) ON DELETE CASCADE,
  policy_version TEXT NOT NULL
    CHECK (policy_version = 'accountless-opt-out-v1'),
  authorization_basis TEXT NOT NULL
    CHECK (authorization_basis = 'accountless-policy-v1'),
  authorized_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'revoked')),
  revoked_at TEXT,
  revocation_reason TEXT
    CHECK (revocation_reason IS NULL OR revocation_reason IN (
      'user_opt_out', 'security_reset', 'operator_containment'
    )),
  CHECK (expires_at > authorized_at),
  CHECK (
    (state = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
  )
) STRICT;

CREATE TABLE accountless_v11_device_authorizations (
  enrollment_device_id TEXT PRIMARY KEY NOT NULL
    REFERENCES accountless_enrollment_ledger(device_id) ON DELETE RESTRICT,
  participant_id TEXT NOT NULL UNIQUE
    REFERENCES participants(id) ON DELETE CASCADE,
  device_credential_id TEXT NOT NULL UNIQUE
    REFERENCES device_credentials(id) ON DELETE CASCADE,
  telemetry_schema_version TEXT NOT NULL
    CHECK (telemetry_schema_version = 'telemetry-contribution-v1.1'),
  field_dictionary_version TEXT NOT NULL
    CHECK (field_dictionary_version = 'telemetry-v1.1-registry-2026-08-31.1'),
  privacy_contract_version TEXT NOT NULL
    CHECK (privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.1'),
  authorized_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'revoked')),
  revoked_at TEXT,
  revocation_reason TEXT
    CHECK (revocation_reason IS NULL OR revocation_reason IN (
      'user_opt_out', 'security_reset', 'operator_containment'
    )),
  CHECK (expires_at > authorized_at),
  CHECK (
    (state = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
  )
) STRICT;

CREATE INDEX device_credentials_participant_state
  ON device_credentials(participant_id, state, expires_at);
CREATE INDEX device_credentials_social_recheck
  ON device_credentials(participant_id, state, social_verified_at);
CREATE UNIQUE INDEX participants_identity_link_key
  ON participants (identity_link_key)
  WHERE identity_link_key IS NOT NULL;
CREATE INDEX accountless_upload_owners_active ON accountless_upload_owners(state, expires_at);
CREATE INDEX accountless_v11_device_authorizations_active ON accountless_v11_device_authorizations(state, expires_at);

CREATE VIEW telemetry_analytical_chunks AS
SELECT c.id, c.participant_id, c.device_id, c.chunk_day, c.stream, c.revision,
  c.chunk_digest, c.parser_version, c.accepted_record_count, c.created_at
FROM telemetry_v1_chunks c WHERE c.superseded_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM telemetry_v11_domain_heads h WHERE h.participant_id = c.participant_id)
UNION ALL
SELECT c.id, d.participant_id, d.device_id, c.chunk_day, c.stream, 1 AS revision,
  c.chunk_digest, c.parser_version, c.record_count AS accepted_record_count, c.created_at
FROM telemetry_v11_domain_heads h JOIN telemetry_v11_domains d ON d.id = h.generation_id
JOIN telemetry_v11_domain_days day_row ON day_row.generation_id = d.id
JOIN telemetry_v11_chunks c ON c.manifest_id = day_row.manifest_id;
CREATE VIEW telemetry_analytical_records AS
SELECT r.*, NULL AS generation_id FROM telemetry_v1_records r
WHERE NOT EXISTS (SELECT 1 FROM telemetry_v11_domain_heads h
  WHERE h.participant_id = r.participant_id)
UNION ALL SELECT * FROM telemetry_v11_active_records;
CREATE VIEW telemetry_v11_activatable_domains AS
SELECT d.* FROM telemetry_v11_domains d
JOIN telemetry_v11_current_predecessors x ON x.token_hash = d.predecessor_token_hash
WHERE (SELECT count(*) FROM telemetry_v11_domain_days day_row WHERE day_row.generation_id = d.id) = json_array_length(d.days_json);
CREATE VIEW telemetry_v11_active_records AS
SELECT r.rowid AS id, r.chunk_id AS chunk_row_id, d.participant_id, d.device_id,
  r.stream, r.occurrence_id, r.observed_at, day_row.observed_day,
  json_extract(r.record_json, '$.provider') AS provider,
  json_extract(r.record_json, '$.modelId') AS model_id,
  json_extract(r.record_json, '$.sessionUuid') AS session_uuid,
  json_extract(r.record_json, '$.planType') AS plan_type,
  json_extract(r.record_json, '$.planVariant') AS plan_variant,
  json_extract(r.record_json, '$.limitId') AS limit_id,
  json_extract(r.record_json, '$.slot') AS slot,
  json_extract(r.record_json, '$.usedPercent') AS used_percent,
  json_extract(r.record_json, '$.windowDurationMinutes') AS window_duration_minutes,
  json_extract(r.record_json, '$.resetsAt') AS resets_at,
  json_extract(r.record_json, '$.components.inputUncachedTokens') AS input_uncached_tokens,
  json_extract(r.record_json, '$.components.inputCacheReadTokens') AS input_cache_read_tokens,
  json_extract(r.record_json, '$.components.inputCacheWriteTokens') AS input_cache_write_tokens,
  json_extract(r.record_json, '$.components.outputTextTokens') AS output_text_tokens,
  json_extract(r.record_json, '$.components.outputReasoningTokens') AS output_reasoning_tokens,
  json_extract(r.record_json, '$.components.outputCombinedTokens') AS output_combined_tokens,
  r.record_json, d.id AS generation_id
FROM telemetry_v11_domain_heads h
JOIN participants p ON p.id = h.participant_id AND p.state = 'active'
JOIN telemetry_v11_domains d ON d.id = h.generation_id
JOIN telemetry_v11_domain_days day_row ON day_row.generation_id = d.id
JOIN telemetry_v11_records r ON r.manifest_id = day_row.manifest_id;
CREATE TRIGGER attribution_enrollment_created AFTER INSERT ON participants
BEGIN
  INSERT INTO attribution_enrollments (participant_id, namespace, created_at)
    VALUES (NEW.id, lower(hex(randomblob(32))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER attribution_enrollment_immutable BEFORE UPDATE ON attribution_enrollments
BEGIN SELECT RAISE(ABORT, 'attribution_enrollment_immutable'); END;
CREATE TRIGGER community_aggregate_exclusion_changed
AFTER UPDATE ON community_aggregate_exclusions
FOR EACH ROW
WHEN (
  OLD.participant_id IS NOT NEW.participant_id
  OR OLD.scope IS NOT NEW.scope
  OR OLD.reason_code IS NOT NEW.reason_code
  OR OLD.state IS NOT NEW.state
  OR OLD.effective_at IS NOT NEW.effective_at
  OR OLD.expires_at IS NOT NEW.expires_at
  OR OLD.revoked_at IS NOT NEW.revoked_at
  OR OLD.revoked_by_digest IS NOT NEW.revoked_by_digest
) AND EXISTS (
  SELECT 1 FROM participants p
   WHERE p.id = NEW.participant_id AND p.owner_kind = 'social'
)
BEGIN
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1;
  DELETE FROM community_snapshot_builders;
  INSERT INTO community_weekly_snapshot_rebuilds (
    week_start, week_end, ingestion_cutoff_at, requested_epoch, requested_at
  )
  SELECT week_start, week_end, ingestion_cutoff_at,
         (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         ),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM community_weekly_snapshots
   WHERE release_state IN ('published', 'suppressed')
  ON CONFLICT(week_start) DO UPDATE SET
    requested_epoch = excluded.requested_epoch,
    requested_at = excluded.requested_at;
  UPDATE community_weekly_snapshots
     SET release_state = 'withdrawn',
         withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         withdrawal_epoch = (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         )
   WHERE release_state IN ('published', 'suppressed');
END;
CREATE TRIGGER community_aggregate_exclusion_inserted
AFTER INSERT ON community_aggregate_exclusions
FOR EACH ROW
WHEN NEW.state = 'active' AND EXISTS (
  SELECT 1 FROM participants p
   WHERE p.id = NEW.participant_id AND p.owner_kind = 'social'
)
BEGIN
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1;
  DELETE FROM community_snapshot_builders;
  INSERT INTO community_weekly_snapshot_rebuilds (
    week_start, week_end, ingestion_cutoff_at, requested_epoch, requested_at
  )
  SELECT week_start, week_end, ingestion_cutoff_at,
         (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         ),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM community_weekly_snapshots
   WHERE release_state IN ('published', 'suppressed')
  ON CONFLICT(week_start) DO UPDATE SET
    requested_epoch = excluded.requested_epoch,
    requested_at = excluded.requested_at;
  UPDATE community_weekly_snapshots
     SET release_state = 'withdrawn',
         withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         withdrawal_epoch = (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         )
   WHERE release_state IN ('published', 'suppressed');
END;
CREATE TRIGGER community_aggregate_exclusion_no_delete
BEFORE DELETE ON community_aggregate_exclusions
BEGIN
  SELECT RAISE(ABORT, 'aggregate exclusion is append-only');
END;
CREATE TRIGGER community_allowance_input_mutated
AFTER UPDATE OF mutation_epoch ON community_snapshot_mutation_control
FOR EACH ROW WHEN OLD.mutation_epoch IS NOT NEW.mutation_epoch
BEGIN
  UPDATE community_allowance_publication_state
     SET publication_state = 'updating',
         changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE singleton = 1;
  DELETE FROM admin_community_allowance_preview_cache;
END;
CREATE TRIGGER community_analytical_input_legacy_delete
AFTER DELETE ON telemetry_contributions
FOR EACH ROW WHEN OLD.status = 'accepted'
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    SELECT id, 1 FROM participants WHERE id = OLD.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision = revision + 1;
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1 AND EXISTS (
     SELECT 1 FROM participants p
      WHERE p.id = OLD.participant_id AND p.owner_kind = 'social'
   );
END;
CREATE TRIGGER community_analytical_input_legacy_insert
AFTER INSERT ON telemetry_contributions
FOR EACH ROW WHEN NEW.status = 'accepted'
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    SELECT id, 1 FROM participants WHERE id = NEW.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision = revision + 1;
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1 AND EXISTS (
     SELECT 1 FROM participants p
      WHERE p.id = NEW.participant_id AND p.owner_kind = 'social'
   );
END;
CREATE TRIGGER community_analytical_input_legacy_update
AFTER UPDATE ON telemetry_contributions
FOR EACH ROW WHEN OLD.status = 'accepted' OR NEW.status = 'accepted'
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    SELECT id, 1 FROM participants WHERE id = NEW.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision = revision + 1;
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1 AND EXISTS (
     SELECT 1 FROM participants p
      WHERE p.id = NEW.participant_id AND p.owner_kind = 'social'
   );
END;
CREATE TRIGGER community_analytical_input_participant_created
AFTER INSERT ON participants
FOR EACH ROW
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    VALUES (NEW.id, 0);
END;
CREATE TRIGGER community_analytical_input_participant_state
AFTER UPDATE OF state ON participants
FOR EACH ROW WHEN OLD.state IS NOT NEW.state
BEGIN
  UPDATE community_analytical_input_versions SET revision = revision + 1
    WHERE participant_id = NEW.id;
END;
CREATE TRIGGER community_analytical_input_v1_delete
AFTER DELETE ON telemetry_v1_chunks
FOR EACH ROW WHEN OLD.superseded_at IS NULL
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    SELECT id, 1 FROM participants WHERE id = OLD.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision = revision + 1;
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1 AND EXISTS (
     SELECT 1 FROM participants p
      WHERE p.id = OLD.participant_id AND p.owner_kind = 'social'
   );
END;
CREATE TRIGGER community_analytical_input_v1_insert
AFTER INSERT ON telemetry_v1_chunks
FOR EACH ROW WHEN NEW.superseded_at IS NULL
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    SELECT id, 1 FROM participants WHERE id = NEW.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision = revision + 1;
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1 AND EXISTS (
     SELECT 1 FROM participants p
      WHERE p.id = NEW.participant_id AND p.owner_kind = 'social'
   );
END;
CREATE TRIGGER community_analytical_input_v1_update
AFTER UPDATE ON telemetry_v1_chunks
FOR EACH ROW WHEN OLD.superseded_at IS NULL OR NEW.superseded_at IS NULL
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    SELECT id, 1 FROM participants WHERE id = NEW.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision = revision + 1;
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1 AND EXISTS (
     SELECT 1 FROM participants p
      WHERE p.id = NEW.participant_id AND p.owner_kind = 'social'
   );
END;
CREATE TRIGGER community_daily_aggregate_participant_withdrawal
BEFORE UPDATE OF state ON participants
FOR EACH ROW
WHEN OLD.state = 'active' AND NEW.state = 'deleting'
  AND OLD.owner_kind = 'social'
BEGIN
  INSERT INTO community_daily_aggregate_rebuilds (
    day, requested_epoch, requested_at
  )
  SELECT day,
         (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         ),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM community_daily_aggregates
   WHERE release_state = 'published'
  ON CONFLICT(day) DO UPDATE SET
    requested_epoch = excluded.requested_epoch,
    requested_at = excluded.requested_at;
  UPDATE community_daily_aggregates
     SET release_state = 'withdrawn',
         withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE release_state = 'published';
END;
CREATE TRIGGER community_daily_aggregates_immutable
BEFORE UPDATE ON community_daily_aggregates
FOR EACH ROW
WHEN NEW.aggregate_id IS NOT OLD.aggregate_id
  OR NEW.day IS NOT OLD.day
  OR NEW.revision IS NOT OLD.revision
  OR NEW.source_mutation_epoch IS NOT OLD.source_mutation_epoch
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.payload_json IS NOT OLD.payload_json
  OR NEW.payload_sha256 IS NOT OLD.payload_sha256
  OR NEW.released_at IS NOT OLD.released_at
  OR OLD.release_state = 'withdrawn'
  OR NEW.release_state NOT IN ('withdrawn')
BEGIN
  SELECT RAISE(ABORT, 'published aggregate revision immutable');
END;
CREATE TRIGGER community_daily_aggregates_no_delete
BEFORE DELETE ON community_daily_aggregates
BEGIN
  SELECT RAISE(ABORT, 'published aggregate revision immutable');
END;
CREATE TRIGGER community_model_composition_day_withdrawal
BEFORE UPDATE OF state ON participants
FOR EACH ROW
WHEN OLD.state = 'active' AND NEW.state = 'deleting'
  AND OLD.owner_kind = 'social'
BEGIN
  DELETE FROM community_model_composition_days;
END;
CREATE TRIGGER community_snapshot_contribution_deleting
BEFORE UPDATE OF status ON telemetry_contributions
FOR EACH ROW
WHEN OLD.status = 'accepted' AND NEW.status = 'deleting'
  AND EXISTS (
    SELECT 1 FROM participants p
     WHERE p.id = OLD.participant_id AND p.owner_kind = 'social'
  )
BEGIN
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1;
  DELETE FROM community_snapshot_builders;
  INSERT INTO community_weekly_snapshot_rebuilds (
    week_start, week_end, ingestion_cutoff_at, requested_epoch, requested_at
  )
  SELECT week_start, week_end, ingestion_cutoff_at,
         (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         ),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM community_weekly_snapshots
   WHERE release_state IN ('published', 'suppressed')
  ON CONFLICT(week_start) DO UPDATE SET
    requested_epoch = excluded.requested_epoch,
    requested_at = excluded.requested_at;
  UPDATE community_weekly_snapshots
     SET release_state = 'withdrawn',
         withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         withdrawal_epoch = (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         )
   WHERE release_state IN ('published', 'suppressed');
END;
CREATE TRIGGER community_snapshot_contribution_direct_delete
BEFORE DELETE ON telemetry_contributions
FOR EACH ROW
WHEN OLD.status != 'deleting'
  AND EXISTS (
    SELECT 1 FROM participants
     WHERE id = OLD.participant_id AND state = 'active' AND owner_kind = 'social'
  )
BEGIN
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1;
  DELETE FROM community_snapshot_builders;
  INSERT INTO community_weekly_snapshot_rebuilds (
    week_start, week_end, ingestion_cutoff_at, requested_epoch, requested_at
  )
  SELECT week_start, week_end, ingestion_cutoff_at,
         (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         ),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM community_weekly_snapshots
   WHERE release_state IN ('published', 'suppressed')
  ON CONFLICT(week_start) DO UPDATE SET
    requested_epoch = excluded.requested_epoch,
    requested_at = excluded.requested_at;
  UPDATE community_weekly_snapshots
     SET release_state = 'withdrawn',
         withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         withdrawal_epoch = (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         )
   WHERE release_state IN ('published', 'suppressed');
END;
CREATE TRIGGER community_snapshot_participant_withdrawal
BEFORE UPDATE OF state ON participants
FOR EACH ROW
WHEN OLD.state = 'active' AND NEW.state = 'deleting'
  AND OLD.owner_kind = 'social'
BEGIN
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1;
  DELETE FROM community_snapshot_builders;
  INSERT INTO community_weekly_snapshot_rebuilds (
    week_start, week_end, ingestion_cutoff_at, requested_epoch, requested_at
  )
  SELECT week_start, week_end, ingestion_cutoff_at,
         (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         ),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM community_weekly_snapshots
   WHERE release_state IN ('published', 'suppressed')
  ON CONFLICT(week_start) DO UPDATE SET
    requested_epoch = excluded.requested_epoch,
    requested_at = excluded.requested_at;
  UPDATE community_weekly_snapshots
     SET release_state = 'withdrawn',
         withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         withdrawal_epoch = (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         )
   WHERE release_state IN ('published', 'suppressed');
END;
CREATE TRIGGER community_snapshot_policy_changed
AFTER UPDATE ON community_snapshot_policy
FOR EACH ROW
WHEN OLD.maturity_days IS NOT NEW.maturity_days
  OR OLD.minimum_accepted_collection_days IS NOT NEW.minimum_accepted_collection_days
  OR OLD.account_usage_events_cap IS NOT NEW.account_usage_events_cap
  OR OLD.account_token_components_cap IS NOT NEW.account_token_components_cap
  OR OLD.account_tool_units_cap IS NOT NEW.account_tool_units_cap
BEGIN
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1;
  DELETE FROM community_snapshot_builders;
  INSERT INTO community_weekly_snapshot_rebuilds (
    week_start, week_end, ingestion_cutoff_at, requested_epoch, requested_at
  )
  SELECT week_start, week_end, ingestion_cutoff_at,
         (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         ),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM community_weekly_snapshots
   WHERE release_state IN ('published', 'suppressed')
  ON CONFLICT(week_start) DO UPDATE SET
    requested_epoch = excluded.requested_epoch,
    requested_at = excluded.requested_at;
  UPDATE community_weekly_snapshots
     SET release_state = 'withdrawn',
         withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         withdrawal_epoch = (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         )
   WHERE release_state IN ('published', 'suppressed');
END;
CREATE TRIGGER community_snapshot_policy_no_delete
BEFORE DELETE ON community_snapshot_policy
BEGIN
  SELECT RAISE(ABORT, 'community snapshot policy immutable');
END;
CREATE TRIGGER community_weekly_snapshots_immutable
BEFORE UPDATE ON community_weekly_snapshots
FOR EACH ROW
WHEN NEW.snapshot_id IS NOT OLD.snapshot_id
  OR NEW.week_start IS NOT OLD.week_start
  OR NEW.week_end IS NOT OLD.week_end
  OR NEW.revision IS NOT OLD.revision
  OR NEW.source_mutation_epoch IS NOT OLD.source_mutation_epoch
  OR NEW.ingestion_cutoff_at IS NOT OLD.ingestion_cutoff_at
  OR NEW.released_at IS NOT OLD.released_at
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.payload_json IS NOT OLD.payload_json
  OR NEW.payload_sha256 IS NOT OLD.payload_sha256
  OR NEW.sealed_at IS NOT OLD.sealed_at
  OR OLD.release_state = 'withdrawn'
  OR NEW.release_state NOT IN ('withdrawn')
BEGIN
  SELECT RAISE(ABORT, 'sealed snapshot immutable');
END;
CREATE TRIGGER community_weekly_snapshots_no_delete
BEFORE DELETE ON community_weekly_snapshots
BEGIN
  SELECT RAISE(ABORT, 'sealed snapshot immutable');
END;
CREATE TRIGGER contributions_block_reconciling_quarantine
BEFORE INSERT ON contributions
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM pending_quarantine_objects
   WHERE r2_key = NEW.r2_key
     AND reconciliation_state = 'deleting'
)
BEGIN
  SELECT RAISE(ABORT, 'quarantine reconciliation in progress');
END;
CREATE TRIGGER contributions_clear_pending_quarantine
AFTER INSERT ON contributions
FOR EACH ROW
BEGIN
  DELETE FROM pending_quarantine_objects
   WHERE r2_key = NEW.r2_key
     AND contribution_id = NEW.id
     AND reconciliation_state = 'registered';
END;
CREATE TRIGGER contributions_consume_device_upload
AFTER INSERT ON contributions
FOR EACH ROW
WHEN NEW.device_upload_authorization_id IS NOT NULL
BEGIN
  UPDATE device_upload_authorizations
     SET state = 'consumed',
         consumed_at = NEW.created_at,
         consume_lease_expires_at = NULL,
         consumed_contribution_id = NEW.id
   WHERE id = NEW.device_upload_authorization_id
     AND participant_id = NEW.participant_id
     AND state = 'consuming';
END;
CREATE TRIGGER contributions_consume_session_upload
AFTER INSERT ON contributions
FOR EACH ROW
WHEN NEW.upload_authorization_id IS NOT NULL
BEGIN
  UPDATE upload_authorizations
     SET state = 'consumed',
         consumed_at = NEW.created_at,
         consume_lease_expires_at = NULL,
         consumed_contribution_id = NEW.id
   WHERE id = NEW.upload_authorization_id
     AND participant_id = NEW.participant_id
     AND state = 'consuming';
END;
CREATE TRIGGER contributions_require_active_participant
BEFORE INSERT ON contributions
FOR EACH ROW
WHEN (SELECT state FROM participants WHERE id = NEW.participant_id) IS NOT 'active'
BEGIN
  SELECT RAISE(ABORT, 'participant unavailable');
END;
CREATE TRIGGER contributions_require_consuming_upload
BEFORE INSERT ON contributions
FOR EACH ROW
WHEN NOT (
  (
    NEW.upload_authorization_id IS NOT NULL
    AND NEW.device_upload_authorization_id IS NULL
    AND EXISTS (
      SELECT 1 FROM upload_authorizations
       WHERE id = NEW.upload_authorization_id
         AND participant_id = NEW.participant_id
         AND state = 'consuming'
         AND consume_lease_expires_at >
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  )
  OR
  (
    NEW.upload_authorization_id IS NULL
    AND NEW.device_upload_authorization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM device_upload_authorizations
       WHERE id = NEW.device_upload_authorization_id
         AND participant_id = NEW.participant_id
         AND state = 'consuming'
         AND consume_lease_expires_at >
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'upload unavailable');
END;
CREATE TRIGGER device_upload_authorizations_require_active_device
BEFORE INSERT ON device_upload_authorizations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
    FROM device_credentials device
    JOIN participants participant ON participant.id = device.participant_id
   WHERE device.id = NEW.issued_by_device_id
     AND device.participant_id = NEW.participant_id
     AND device.state = 'active'
     AND device.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND participant.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'device unavailable');
END;
CREATE TRIGGER participant_community_eligibility_requires_redeemed_grant
BEFORE INSERT ON participant_community_eligibility
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM enrollment_grants
   WHERE id = NEW.grant_id
     AND state = 'redeemed'
     AND redeemed_participant_id = NEW.participant_id
)
BEGIN
  SELECT RAISE(ABORT, 'grant unavailable');
END;
CREATE TRIGGER participants_identity_reenrollment_cooldown_guard
BEFORE INSERT ON participants
WHEN NEW.identity_cooldown_digest IS NOT NULL
  AND EXISTS (
    SELECT 1
      FROM identity_reenrollment_cooldowns
     WHERE identity_cooldown_digest = NEW.identity_cooldown_digest
       AND retain_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
BEGIN
  SELECT RAISE(ABORT, 'identity reenrollment cooldown active');
END;
CREATE TRIGGER telemetry_contributions_block_reconciling_quarantine
BEFORE INSERT ON telemetry_contributions
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM pending_quarantine_objects
   WHERE r2_key = NEW.r2_key
     AND reconciliation_state = 'deleting'
)
BEGIN
  SELECT RAISE(ABORT, 'quarantine reconciliation in progress');
END;
CREATE TRIGGER telemetry_contributions_clear_pending_quarantine
AFTER INSERT ON telemetry_contributions
FOR EACH ROW
BEGIN
  DELETE FROM pending_quarantine_objects
   WHERE r2_key = NEW.r2_key
     AND contribution_id = NEW.id
     AND reconciliation_state = 'registered';
END;
CREATE TRIGGER telemetry_contributions_consume_device_upload
AFTER INSERT ON telemetry_contributions
FOR EACH ROW
WHEN NEW.device_upload_authorization_id IS NOT NULL
BEGIN
  UPDATE device_upload_authorizations
     SET state = 'consumed',
         consumed_at = NEW.created_at,
         consume_lease_expires_at = NULL,
         consumed_contribution_id = NEW.id
   WHERE id = NEW.device_upload_authorization_id
     AND participant_id = NEW.participant_id
     AND state = 'consuming';
END;
CREATE TRIGGER telemetry_contributions_consume_session_upload
AFTER INSERT ON telemetry_contributions
FOR EACH ROW
WHEN NEW.upload_authorization_id IS NOT NULL
BEGIN
  UPDATE upload_authorizations
     SET state = 'consumed',
         consumed_at = NEW.created_at,
         consume_lease_expires_at = NULL,
         consumed_contribution_id = NEW.id
   WHERE id = NEW.upload_authorization_id
     AND participant_id = NEW.participant_id
     AND state = 'consuming';
END;
CREATE TRIGGER telemetry_contributions_dataset_metadata_insert
BEFORE INSERT ON telemetry_contributions
FOR EACH ROW
WHEN
  (
    NEW.dataset_id IS NULL
    AND (
      NEW.dataset_part_index IS NOT NULL
      OR NEW.dataset_part_count IS NOT NULL
      OR NEW.dataset_completeness IS NOT NULL
      OR NEW.dataset_range_start IS NOT NULL
      OR NEW.dataset_range_end IS NOT NULL
    )
  )
  OR (
    NEW.dataset_id IS NOT NULL
    AND (
      NEW.dataset_part_index IS NULL
      OR NEW.dataset_part_count IS NULL
      OR NEW.dataset_completeness IS NULL
      OR NEW.dataset_range_start IS NULL
      OR NEW.dataset_range_end IS NULL
      OR NEW.dataset_part_index > NEW.dataset_part_count
      OR NEW.dataset_range_end < NEW.dataset_range_start
    )
  )
  OR (
    NEW.dataset_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM telemetry_contributions existing
       WHERE existing.participant_id = NEW.participant_id
         AND existing.dataset_id = NEW.dataset_id
         AND (
           existing.dataset_part_count != NEW.dataset_part_count
           OR existing.dataset_completeness != NEW.dataset_completeness
           OR existing.dataset_range_start != NEW.dataset_range_start
           OR existing.dataset_range_end != NEW.dataset_range_end
         )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid telemetry dataset metadata');
END;
CREATE TRIGGER telemetry_contributions_dataset_metadata_update
BEFORE UPDATE OF
  participant_id,
  dataset_id,
  dataset_part_index,
  dataset_part_count,
  dataset_completeness,
  dataset_range_start,
  dataset_range_end
ON telemetry_contributions
FOR EACH ROW
WHEN
  (
    NEW.dataset_id IS NULL
    AND (
      NEW.dataset_part_index IS NOT NULL
      OR NEW.dataset_part_count IS NOT NULL
      OR NEW.dataset_completeness IS NOT NULL
      OR NEW.dataset_range_start IS NOT NULL
      OR NEW.dataset_range_end IS NOT NULL
    )
  )
  OR (
    NEW.dataset_id IS NOT NULL
    AND (
      NEW.dataset_part_index IS NULL
      OR NEW.dataset_part_count IS NULL
      OR NEW.dataset_completeness IS NULL
      OR NEW.dataset_range_start IS NULL
      OR NEW.dataset_range_end IS NULL
      OR NEW.dataset_part_index > NEW.dataset_part_count
      OR NEW.dataset_range_end < NEW.dataset_range_start
    )
  )
  OR (
    NEW.dataset_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM telemetry_contributions existing
       WHERE existing.participant_id = NEW.participant_id
         AND existing.dataset_id = NEW.dataset_id
         AND existing.id != OLD.id
         AND (
           existing.dataset_part_count != NEW.dataset_part_count
           OR existing.dataset_completeness != NEW.dataset_completeness
           OR existing.dataset_range_start != NEW.dataset_range_start
           OR existing.dataset_range_end != NEW.dataset_range_end
         )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid telemetry dataset metadata');
END;
CREATE TRIGGER telemetry_contributions_enforce_admission_window
BEFORE INSERT ON telemetry_contributions
FOR EACH ROW
WHEN COALESCE((
  SELECT accepted_count
    FROM telemetry_contribution_admission_windows
   WHERE participant_id = NEW.participant_id
     AND window_started_at = strftime(
       '%Y-%m-%dT%H:%M:%fZ',
       (
         (
           CAST(strftime('%s', NEW.created_at) AS INTEGER) + 259200
         ) / 604800
       ) * 604800 - 259200,
       'unixepoch'
     )
), 0) >= 100
BEGIN
  SELECT RAISE(ABORT, 'contribution admission window exhausted');
END;
CREATE TRIGGER telemetry_contributions_record_admission_window
AFTER INSERT ON telemetry_contributions
FOR EACH ROW
BEGIN
  INSERT INTO telemetry_contribution_admission_windows (
    participant_id, window_started_at, accepted_count, last_accepted_at
  ) VALUES (
    NEW.participant_id,
    strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      (
        (
          CAST(strftime('%s', NEW.created_at) AS INTEGER) + 259200
        ) / 604800
      ) * 604800 - 259200,
      'unixepoch'
    ),
    1,
    NEW.created_at
  )
  ON CONFLICT (participant_id, window_started_at)
  DO UPDATE SET
    accepted_count = accepted_count + 1,
    last_accepted_at = excluded.last_accepted_at;
END;
CREATE TRIGGER telemetry_contributions_require_active_participant
BEFORE INSERT ON telemetry_contributions
FOR EACH ROW
WHEN (SELECT state FROM participants WHERE id = NEW.participant_id) IS NOT 'active'
BEGIN
  SELECT RAISE(ABORT, 'participant unavailable');
END;
CREATE TRIGGER telemetry_contributions_require_consuming_upload
BEFORE INSERT ON telemetry_contributions
FOR EACH ROW
WHEN NOT (
  (
    NEW.upload_authorization_id IS NOT NULL
    AND NEW.device_upload_authorization_id IS NULL
    AND EXISTS (
      SELECT 1 FROM upload_authorizations
       WHERE id = NEW.upload_authorization_id
         AND participant_id = NEW.participant_id
         AND state = 'consuming'
         AND consume_lease_expires_at >
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  )
  OR
  (
    NEW.upload_authorization_id IS NULL
    AND NEW.device_upload_authorization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM device_upload_authorizations
       WHERE id = NEW.device_upload_authorization_id
         AND participant_id = NEW.participant_id
         AND state = 'consuming'
         AND consume_lease_expires_at >
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'upload unavailable');
END;
CREATE TRIGGER telemetry_transport_floor_no_implicit_downgrade
BEFORE UPDATE OF minimum_rank ON telemetry_transport_participant_floors
WHEN NEW.minimum_rank < OLD.minimum_rank
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_transport_floor_rollbacks r
      JOIN admin_action_audit a ON a.operation_id = r.operation_id
     WHERE r.participant_id = OLD.participant_id AND r.expected_revision = OLD.revision
       AND r.from_rank = OLD.minimum_rank AND r.to_rank = NEW.minimum_rank
       AND a.outcome = 'started'
  ) THEN RAISE(ABORT, 'telemetry_transport_rollback_required') END);
END;
CREATE TRIGGER telemetry_transport_floor_revision
BEFORE UPDATE ON telemetry_transport_participant_floors
WHEN NEW.participant_id != OLD.participant_id OR NEW.revision != OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'telemetry_transport_floor_revision_conflict'); END;
CREATE TRIGGER telemetry_transport_floor_successor_history_guard
BEFORE UPDATE OF minimum_rank ON telemetry_transport_participant_floors
WHEN NEW.minimum_rank = 11 AND NEW.minimum_rank > OLD.minimum_rank
  AND EXISTS (SELECT 1 FROM telemetry_contributions legacy
    WHERE legacy.participant_id = NEW.participant_id AND legacy.status = 'accepted'
      AND legacy.transport_schema_version = 'telemetry-contribution-v0.2')
BEGIN SELECT RAISE(ABORT, 'telemetry_transport_blocked'); END;
CREATE TRIGGER telemetry_transport_format_identity_immutable
BEFORE UPDATE OF schema_version, format_rank ON telemetry_transport_formats
BEGIN SELECT RAISE(ABORT, 'telemetry_transport_identity_immutable'); END;
CREATE TRIGGER telemetry_transport_legacy_insert BEFORE INSERT ON telemetry_contributions
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_transport_formats f
      JOIN telemetry_transport_participant_floors p ON p.participant_id = NEW.participant_id
     WHERE f.schema_version = NEW.transport_schema_version
       AND f.lifecycle = 'accepted' AND f.format_rank >= p.minimum_rank
  ) THEN RAISE(ABORT, 'telemetry_transport_blocked') END);
END;
CREATE TRIGGER telemetry_transport_v1_insert BEFORE INSERT ON telemetry_v1_chunks
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_transport_formats f
      JOIN telemetry_transport_participant_floors p ON p.participant_id = NEW.participant_id
     WHERE f.schema_version = 'telemetry-contribution-v1.0'
       AND f.lifecycle = 'accepted' AND f.format_rank >= p.minimum_rank
  ) THEN RAISE(ABORT, 'telemetry_transport_blocked') END);
END;
CREATE TRIGGER telemetry_v11_active_day_delete_guard BEFORE DELETE ON telemetry_v11_domain_days
WHEN EXISTS (SELECT 1 FROM telemetry_v11_domain_heads h JOIN participants p ON p.id = h.participant_id
  WHERE h.generation_id = OLD.generation_id AND p.state = 'active')
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_active'); END;
CREATE TRIGGER telemetry_v11_active_domain_delete_guard BEFORE DELETE ON telemetry_v11_domains
WHEN EXISTS (SELECT 1 FROM telemetry_v11_domain_heads h JOIN participants p ON p.id = h.participant_id
  WHERE h.generation_id = OLD.id AND p.state = 'active')
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_active'); END;
CREATE TRIGGER telemetry_v11_active_head_delete_guard BEFORE DELETE ON telemetry_v11_domain_heads
WHEN EXISTS (SELECT 1 FROM participants p WHERE p.id = OLD.participant_id AND p.state = 'active')
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_active'); END;
CREATE TRIGGER telemetry_v11_active_record_delete_guard BEFORE DELETE ON telemetry_v11_records
WHEN EXISTS (SELECT 1 FROM telemetry_v11_domain_days day_row
  JOIN telemetry_v11_domain_heads h ON h.generation_id = day_row.generation_id
  JOIN participants p ON p.id = h.participant_id AND p.state = 'active'
  WHERE day_row.manifest_id = OLD.manifest_id)
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_active'); END;
CREATE TRIGGER telemetry_v11_chunk_immutable
BEFORE UPDATE OF id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq,
  chunk_id, chunk_digest, envelope_digest, parser_version, record_count, r2_key,
  device_upload_authorization_id, created_at ON telemetry_v11_chunks
BEGIN SELECT RAISE(ABORT, 'telemetry_chunk_immutable'); END;
CREATE TRIGGER telemetry_v11_chunks_enforce_admission BEFORE INSERT ON telemetry_v11_chunks
WHEN COALESCE((
  SELECT accepted_count FROM telemetry_v1_chunk_admission_windows
   WHERE participant_id = NEW.participant_id AND device_id = NEW.device_id
     AND window_day = substr(NEW.created_at, 1, 10)
), 0) >= (CASE WHEN (
  SELECT issued_at FROM device_credentials WHERE id = NEW.device_id
) > strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '-7 days') THEN 20000 ELSE 2000 END)
BEGIN SELECT RAISE(ABORT, 'chunk admission window exhausted'); END;
CREATE TRIGGER telemetry_v11_chunks_record_admission AFTER INSERT ON telemetry_v11_chunks
BEGIN
  INSERT INTO telemetry_v1_chunk_admission_windows (
    participant_id, device_id, window_day, accepted_count, last_accepted_at
  ) VALUES (NEW.participant_id, NEW.device_id, substr(NEW.created_at, 1, 10), 1, NEW.created_at)
  ON CONFLICT (participant_id, device_id, window_day) DO UPDATE SET
    accepted_count = accepted_count + 1, last_accepted_at = excluded.last_accepted_at;
  UPDATE device_upload_authorizations
     SET state = 'consumed', consumed_at = NEW.created_at,
         consume_lease_expires_at = NULL, consumed_contribution_id = NEW.id
   WHERE id = NEW.device_upload_authorization_id AND state = 'consuming';
END;
CREATE TRIGGER telemetry_v11_consent_floor AFTER INSERT ON telemetry_v11_device_consents
BEGIN
  UPDATE telemetry_transport_participant_floors
     SET minimum_rank = max(minimum_rank, 11), revision = revision + 1, changed_at = NEW.consented_at
   WHERE participant_id = NEW.participant_id;
END;
CREATE TRIGGER telemetry_v11_consent_immutable BEFORE UPDATE ON telemetry_v11_device_consents
BEGIN SELECT RAISE(ABORT, 'telemetry_consent_immutable'); END;
CREATE TRIGGER telemetry_v11_domain_complete_before_insert
BEFORE INSERT ON telemetry_v11_domains
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_v11_current_predecessors x
    WHERE x.token_hash = NEW.predecessor_token_hash AND x.participant_id = NEW.participant_id
      AND x.device_id = NEW.device_id AND x.previous_generation_id IS NEW.previous_generation_id
      AND x.legacy_fingerprint = NEW.legacy_fingerprint AND x.input_revision = NEW.input_revision
      AND x.from_day >= NEW.from_day AND x.through_day <= NEW.through_day
  ) THEN RAISE(ABORT, 'telemetry_domain_predecessor_changed') END);
  -- Journal-only bound before any record-level closure scan: at most 30,000
  -- chunks / 6,000,000 records, matching the legacy source-pin journal budget.
  SELECT (CASE WHEN (SELECT COALESCE(SUM(m.expected_chunk_count), 0)
    FROM json_each(NEW.days_json) e JOIN telemetry_v11_day_manifests m
      ON m.id = json_extract(e.value, '$.manifestId')) > 30000
    THEN RAISE(ABORT, 'telemetry_domain_range_too_large') END);
  SELECT (CASE WHEN json_array_length(NEW.days_json) NOT BETWEEN 1 AND 4096
    OR json_array_length(NEW.days_json) != CAST(julianday(NEW.through_day) - julianday(NEW.from_day) + 1 AS INTEGER)
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.days_json) e
      LEFT JOIN telemetry_v11_day_manifests m ON m.id = json_extract(e.value, '$.manifestId')
      WHERE json_extract(e.value, '$.day') IS NOT date(NEW.from_day, '+' || e.key || ' days')
        OR m.id IS NULL OR m.participant_id != NEW.participant_id OR m.device_id != NEW.device_id
        OR m.chunk_day != json_extract(e.value, '$.day') OR m.manifest_digest != json_extract(e.value, '$.manifestDigest')
        OR m.state != 'ready'
        OR m.expected_chunk_count != (SELECT count(*) FROM telemetry_v11_chunks c WHERE c.manifest_id = m.id)
        OR EXISTS (SELECT 1 FROM telemetry_v11_chunks c WHERE c.manifest_id = m.id
          AND c.record_count != (SELECT count(*) FROM telemetry_v11_records r WHERE r.chunk_id = c.id))
    ) THEN RAISE(ABORT, 'telemetry_domain_incomplete') END);
  SELECT (CASE WHEN EXISTS (
    SELECT r.stream, r.occurrence_id FROM json_each(NEW.days_json) e
    JOIN telemetry_v11_records r ON r.manifest_id = json_extract(e.value, '$.manifestId')
    GROUP BY r.stream, r.occurrence_id HAVING count(*) > 1
  ) THEN RAISE(ABORT, 'telemetry_domain_occurrence_conflict') END);
  -- Every legacy winning occurrence must survive with identical base semantics.
  -- A declared excluded count, equal row count, or same wire version is not proof.
  SELECT (CASE WHEN EXISTS (
    WITH candidate_days AS MATERIALIZED (
      SELECT json_extract(e.value, '$.day') AS day,
        json_extract(e.value, '$.manifestId') AS manifest_id FROM json_each(NEW.days_json) e
    ) SELECT 1 FROM telemetry_v1_records old_row
    JOIN telemetry_v11_domain_predecessors x ON x.token_hash = NEW.predecessor_token_hash
    LEFT JOIN candidate_days candidate ON candidate.day = old_row.observed_day
    WHERE old_row.participant_id = NEW.participant_id
      AND (old_row.participant_id, old_row.observed_day, old_row.device_id) IN (
        SELECT json_extract(w.value, '$[0]'), json_extract(w.value, '$[1]'), json_extract(w.value, '$[2]') FROM json_each(x.winners_json) w)
      AND (candidate.manifest_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM telemetry_v11_records new_row
        WHERE new_row.manifest_id = candidate.manifest_id
          AND new_row.stream = old_row.stream AND new_row.legacy_occurrence_id = old_row.occurrence_id
          AND new_row.legacy_record_json = old_row.record_json
      ))
  ) THEN RAISE(ABORT, 'telemetry_domain_compatibility_unproven') END);
  SELECT (CASE WHEN EXISTS (
    WITH candidate_days AS MATERIALIZED (
      SELECT json_extract(e.value, '$.day') AS day,
        json_extract(e.value, '$.manifestId') AS manifest_id FROM json_each(NEW.days_json) e
    ) SELECT 1 FROM telemetry_v11_domain_days previous_day
    JOIN telemetry_v11_records old_row ON old_row.manifest_id = previous_day.manifest_id
    LEFT JOIN candidate_days candidate ON candidate.day = previous_day.observed_day
    WHERE previous_day.generation_id = NEW.previous_generation_id AND (candidate.manifest_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM telemetry_v11_records new_row
      WHERE new_row.manifest_id = candidate.manifest_id
        AND new_row.stream = old_row.stream AND new_row.occurrence_id = old_row.occurrence_id
        AND json_remove(new_row.record_json, '$.accountPlanAttribution')
          = json_remove(old_row.record_json, '$.accountPlanAttribution')
    ))
  ) THEN RAISE(ABORT, 'telemetry_domain_compatibility_unproven') END);
  -- A domain head is participant-wide analytical authority, not a day-level
  -- overlay. Even disjoint v0.2 history would disappear at cutover without a
  -- reviewed semantic replacement proof. Preserve the old lane until then.
  SELECT (CASE WHEN EXISTS (SELECT 1 FROM telemetry_contributions legacy
    WHERE legacy.participant_id = NEW.participant_id AND legacy.status = 'accepted'
      AND legacy.transport_schema_version = 'telemetry-contribution-v0.2'
  ) THEN RAISE(ABORT, 'telemetry_domain_compatibility_unproven') END);
END;
CREATE TRIGGER telemetry_v11_domain_day_member BEFORE INSERT ON telemetry_v11_domain_days
WHEN NOT EXISTS (SELECT 1 FROM telemetry_v11_domains d, json_each(d.days_json) e
  WHERE d.id = NEW.generation_id AND json_extract(e.value, '$.day') = NEW.observed_day
    AND json_extract(e.value, '$.manifestId') = NEW.manifest_id)
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_incomplete'); END;
CREATE TRIGGER telemetry_v11_domain_days_immutable BEFORE UPDATE ON telemetry_v11_domain_days
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_immutable'); END;
CREATE TRIGGER telemetry_v11_domain_immutable BEFORE UPDATE ON telemetry_v11_domains
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_immutable'); END;
CREATE TRIGGER telemetry_v11_head_insert_guard BEFORE INSERT ON telemetry_v11_domain_heads
WHEN NEW.revision != 1 OR NOT EXISTS (SELECT 1 FROM telemetry_v11_activatable_domains d
  WHERE d.id = NEW.generation_id AND d.participant_id = NEW.participant_id)
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_predecessor_changed'); END;
CREATE TRIGGER telemetry_v11_head_insert_publish AFTER INSERT ON telemetry_v11_domain_heads
BEGIN
  UPDATE telemetry_v11_domain_predecessors SET consumed_at = NEW.updated_at
    WHERE token_hash = (SELECT predecessor_token_hash FROM telemetry_v11_domains WHERE id = NEW.generation_id);
  UPDATE community_analytical_input_versions SET revision = revision + 1 WHERE participant_id = NEW.participant_id;
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1 AND EXISTS (
     SELECT 1 FROM participants p
      WHERE p.id = NEW.participant_id AND p.owner_kind = 'social'
   );
  INSERT INTO community_daily_aggregate_rebuilds (day, requested_epoch, requested_at)
    SELECT observed_day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id = 1), NEW.updated_at
    FROM telemetry_v11_domain_days WHERE generation_id = NEW.generation_id
      AND EXISTS (
        SELECT 1 FROM participants p
         WHERE p.id = NEW.participant_id AND p.owner_kind = 'social'
      )
    ON CONFLICT(day) DO UPDATE SET requested_epoch = excluded.requested_epoch, requested_at = excluded.requested_at;
END;
CREATE TRIGGER telemetry_v11_head_update_guard BEFORE UPDATE ON telemetry_v11_domain_heads
WHEN NEW.participant_id != OLD.participant_id OR NEW.revision != OLD.revision + 1
  OR NOT EXISTS (SELECT 1 FROM telemetry_v11_activatable_domains d
    WHERE d.id = NEW.generation_id AND d.participant_id = NEW.participant_id AND d.previous_generation_id = OLD.generation_id)
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_predecessor_changed'); END;
CREATE TRIGGER telemetry_v11_head_update_publish AFTER UPDATE ON telemetry_v11_domain_heads
BEGIN
  UPDATE telemetry_v11_domain_predecessors SET consumed_at = NEW.updated_at
    WHERE token_hash = (SELECT predecessor_token_hash FROM telemetry_v11_domains WHERE id = NEW.generation_id);
  UPDATE community_analytical_input_versions SET revision = revision + 1 WHERE participant_id = NEW.participant_id;
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1 AND EXISTS (
     SELECT 1 FROM participants p
      WHERE p.id = NEW.participant_id AND p.owner_kind = 'social'
   );
  INSERT INTO community_daily_aggregate_rebuilds (day, requested_epoch, requested_at)
    SELECT observed_day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id = 1), NEW.updated_at
    FROM telemetry_v11_domain_days WHERE generation_id = NEW.generation_id
      AND EXISTS (
        SELECT 1 FROM participants p
         WHERE p.id = NEW.participant_id AND p.owner_kind = 'social'
      )
    ON CONFLICT(day) DO UPDATE SET requested_epoch = excluded.requested_epoch, requested_at = excluded.requested_at;
END;
CREATE TRIGGER telemetry_v11_manifest_immutable
BEFORE UPDATE OF id, participant_id, device_id, chunk_day, manifest_digest, parser_version, manifest_json, expected_chunk_count, created_at
ON telemetry_v11_day_manifests
BEGIN SELECT RAISE(ABORT, 'telemetry_manifest_immutable'); END;
CREATE TRIGGER telemetry_v11_manifest_ready BEFORE UPDATE OF state ON telemetry_v11_day_manifests
BEGIN
  SELECT (CASE WHEN OLD.state != 'staged' OR NEW.state != 'ready'
    OR NEW.expected_chunk_count != (SELECT count(*) FROM telemetry_v11_chunks WHERE manifest_id = NEW.id)
    OR EXISTS (
      SELECT 1 FROM telemetry_v11_chunks c WHERE c.manifest_id = NEW.id
        AND c.record_count != (SELECT count(*) FROM telemetry_v11_records r WHERE r.chunk_id = c.id)
    ) THEN RAISE(ABORT, 'telemetry_manifest_incomplete') END);
END;
CREATE TRIGGER telemetry_v11_predecessor_immutable
BEFORE UPDATE ON telemetry_v11_domain_predecessors
WHEN NEW.token_hash IS NOT OLD.token_hash OR NEW.participant_id IS NOT OLD.participant_id
  OR NEW.device_id IS NOT OLD.device_id OR NEW.previous_generation_id IS NOT OLD.previous_generation_id
  OR NEW.legacy_fingerprint IS NOT OLD.legacy_fingerprint OR NEW.input_revision IS NOT OLD.input_revision
  OR NEW.from_day IS NOT OLD.from_day OR NEW.through_day IS NOT OLD.through_day
  OR NEW.winners_json IS NOT OLD.winners_json OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_immutable'); END;
CREATE TRIGGER telemetry_v11_record_admission BEFORE INSERT ON telemetry_v11_records
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_v11_chunks c JOIN telemetry_v11_day_manifests m ON m.id = c.manifest_id
     WHERE c.id = NEW.chunk_id AND c.manifest_id = NEW.manifest_id
       AND c.stream = NEW.stream AND m.state = 'staged'
       AND substr(NEW.observed_at, 1, 10) = c.chunk_day
       AND (SELECT count(*) FROM telemetry_v11_records r WHERE r.chunk_id = c.id) < c.record_count
  ) THEN RAISE(ABORT, 'telemetry_record_staging_denied') END);
END;
CREATE TRIGGER telemetry_v11_record_immutable BEFORE UPDATE ON telemetry_v11_records
BEGIN SELECT RAISE(ABORT, 'telemetry_record_immutable'); END;
CREATE TRIGGER telemetry_v1_chunks_consume_device_upload
AFTER INSERT ON telemetry_v1_chunks
FOR EACH ROW
BEGIN
  UPDATE device_upload_authorizations
     SET state = 'consumed',
         consumed_at = NEW.created_at,
         consume_lease_expires_at = NULL,
         consumed_contribution_id = NEW.id
   WHERE id = NEW.device_upload_authorization_id
     AND participant_id = NEW.participant_id
     AND state = 'consuming';
END;
CREATE TRIGGER telemetry_v1_chunks_enforce_admission
BEFORE INSERT ON telemetry_v1_chunks
FOR EACH ROW
WHEN COALESCE((
  SELECT windows.accepted_count
    FROM telemetry_v1_chunk_admission_windows windows
   WHERE windows.participant_id = NEW.participant_id
     AND windows.device_id = NEW.device_id
     AND windows.window_day = substr(NEW.created_at, 1, 10)
), 0) >= CASE WHEN (
    SELECT device.issued_at FROM device_credentials device
     WHERE device.id = NEW.device_id
  ) > strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '-7 days')
  THEN 20000 ELSE 2000 END
BEGIN
  SELECT RAISE(ABORT, 'chunk admission window exhausted');
END;
CREATE TRIGGER telemetry_v1_chunks_enqueue_daily_rebuild
AFTER INSERT ON telemetry_v1_chunks
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM participants p
   WHERE p.id = NEW.participant_id AND p.owner_kind = 'social'
)
BEGIN
  INSERT INTO community_daily_aggregate_rebuilds (
    day, requested_epoch, requested_at
  ) VALUES (
    NEW.chunk_day,
    (
      SELECT mutation_epoch FROM community_snapshot_mutation_control
       WHERE singleton_id = 1
    ),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT(day) DO UPDATE SET
    requested_epoch = excluded.requested_epoch,
    requested_at = excluded.requested_at;
END;
CREATE TRIGGER telemetry_v1_chunks_record_admission
AFTER INSERT ON telemetry_v1_chunks
FOR EACH ROW
BEGIN
  INSERT INTO telemetry_v1_chunk_admission_windows (
    participant_id, device_id, window_day, accepted_count, last_accepted_at
  ) VALUES (
    NEW.participant_id,
    NEW.device_id,
    substr(NEW.created_at, 1, 10),
    1,
    NEW.created_at
  )
  ON CONFLICT (participant_id, device_id, window_day)
  DO UPDATE SET
    accepted_count = accepted_count + 1,
    last_accepted_at = excluded.last_accepted_at;
END;
CREATE TRIGGER telemetry_v1_chunks_require_active_participant
BEFORE INSERT ON telemetry_v1_chunks
FOR EACH ROW
WHEN (SELECT state FROM participants WHERE id = NEW.participant_id)
  IS NOT 'active'
BEGIN
  SELECT RAISE(ABORT, 'participant unavailable');
END;
CREATE TRIGGER telemetry_v1_chunks_require_consuming_upload
BEFORE INSERT ON telemetry_v1_chunks
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM device_upload_authorizations upload
   WHERE upload.id = NEW.device_upload_authorization_id
     AND upload.participant_id = NEW.participant_id
     AND upload.issued_by_device_id = NEW.device_id
     AND upload.state = 'consuming'
     AND upload.consume_lease_expires_at >
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND upload.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'upload unavailable');
END;
CREATE TRIGGER upload_authorizations_require_active_participant
BEFORE INSERT ON upload_authorizations
FOR EACH ROW
WHEN (SELECT state FROM participants WHERE id = NEW.participant_id) IS NOT 'active'
BEGIN
  SELECT RAISE(ABORT, 'participant unavailable');
END;
CREATE TRIGGER web_sessions_require_active_participant
BEFORE INSERT ON web_sessions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM participants
   WHERE id = NEW.participant_id
     AND (
       (state = 'active' AND NEW.scope = 'personal')
       OR (
         state = 'deleting'
         AND NEW.scope = 'deletion_only'
         AND deletion_session_id = NEW.id
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'participant unavailable');
END;

-- Accountless principals receive the existing private attribution namespace and
-- v1.1 floor, without inventing a social consent record.
CREATE TRIGGER telemetry_transport_floor_created AFTER INSERT ON participants
BEGIN
  INSERT INTO telemetry_transport_participant_floors (
    participant_id, minimum_rank, changed_at
  ) VALUES (
    NEW.id,
    CASE WHEN NEW.owner_kind = 'accountless' THEN 11 ELSE 1 END,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER participants_owner_shape_insert BEFORE INSERT ON participants
WHEN NOT (
  (NEW.owner_kind = 'social'
    AND NEW.access_token_id IS NOT NULL
    AND NEW.access_token_hash IS NOT NULL
    AND NEW.recovery_token_id IS NOT NULL
    AND NEW.recovery_token_hash IS NOT NULL
    AND NEW.consent_version IS NOT NULL
    AND NEW.consented_at IS NOT NULL)
  OR
  (NEW.owner_kind = 'accountless'
    AND NEW.access_token_id IS NULL
    AND NEW.access_token_hash IS NULL
    AND NEW.recovery_token_id IS NULL
    AND NEW.recovery_token_hash IS NULL
    AND NEW.consent_version IS NULL
    AND NEW.consented_at IS NULL
    AND (
      (NEW.state = 'active' AND NEW.deletion_session_id IS NULL)
      OR (NEW.state = 'deleting' AND NEW.deletion_session_id IS NOT NULL)
    )
    AND NEW.identity_link_key IS NULL
    AND NEW.identity_cooldown_digest IS NULL)
)
BEGIN SELECT RAISE(ABORT, 'participant owner shape invalid'); END;

CREATE TRIGGER participants_owner_shape_update
BEFORE UPDATE OF owner_kind, access_token_id, access_token_hash,
  recovery_token_id, recovery_token_hash, consent_version, consented_at,
  deletion_session_id, identity_link_key, identity_cooldown_digest ON participants
WHEN NOT (
  (NEW.owner_kind = 'social'
    AND NEW.access_token_id IS NOT NULL
    AND NEW.access_token_hash IS NOT NULL
    AND NEW.recovery_token_id IS NOT NULL
    AND NEW.recovery_token_hash IS NOT NULL
    AND NEW.consent_version IS NOT NULL
    AND NEW.consented_at IS NOT NULL)
  OR
  (NEW.owner_kind = 'accountless'
    AND NEW.access_token_id IS NULL
    AND NEW.access_token_hash IS NULL
    AND NEW.recovery_token_id IS NULL
    AND NEW.recovery_token_hash IS NULL
    AND NEW.consent_version IS NULL
    AND NEW.consented_at IS NULL
    AND (
      (NEW.state = 'active' AND NEW.deletion_session_id IS NULL)
      OR (NEW.state = 'deleting' AND NEW.deletion_session_id IS NOT NULL)
    )
    AND NEW.identity_link_key IS NULL
    AND NEW.identity_cooldown_digest IS NULL)
)
BEGIN SELECT RAISE(ABORT, 'participant owner shape invalid'); END;

CREATE TRIGGER accountless_participant_requires_ledger_revocation
BEFORE DELETE ON participants
WHEN OLD.owner_kind = 'accountless' AND EXISTS (
  SELECT 1 FROM accountless_upload_owners owner
    JOIN accountless_enrollment_ledger ledger
      ON ledger.device_id = owner.enrollment_device_id
   WHERE owner.participant_id = OLD.id
     AND owner.state = 'active' AND ledger.state = 'active'
)
BEGIN SELECT RAISE(ABORT, 'accountless ledger must be revoked first'); END;

-- Social credentials retain their existing active-pairing contract. Older
-- writers may omit social_verified_at; device authentication deliberately
-- uses issued_at in that case. Accountless credentials must never acquire a
-- social verification timestamp or borrow this fallback authority.
CREATE TRIGGER device_credentials_require_valid_authority
BEFORE INSERT ON device_credentials
WHEN NOT (
  (
    NEW.authority_kind = 'social'
    AND NEW.paired_via_pairing_id IS NOT NULL
    AND NEW.accountless_enrollment_device_id IS NULL
    AND EXISTS (
      SELECT 1 FROM device_pairings pairing
        JOIN participants participant ON participant.id = pairing.participant_id
       WHERE pairing.id = NEW.paired_via_pairing_id
         AND pairing.participant_id = NEW.participant_id
         AND pairing.state = 'unused'
         AND pairing.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         AND participant.state = 'active'
         AND participant.owner_kind = 'social'
    )
  )
  OR
  (
    NEW.authority_kind = 'accountless'
    AND NEW.paired_via_pairing_id IS NULL
    AND NEW.accountless_enrollment_device_id IS NOT NULL
    AND NEW.id = NEW.accountless_enrollment_device_id
    AND NEW.social_verified_at IS NULL
    AND NEW.state = 'active'
    AND EXISTS (
      SELECT 1 FROM participants participant
        JOIN accountless_enrollment_ledger ledger
          ON ledger.device_id = NEW.accountless_enrollment_device_id
       WHERE participant.id = NEW.participant_id
         AND participant.owner_kind = 'accountless'
         AND participant.state = 'active'
         AND ledger.state = 'active'
         AND ledger.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         AND ledger.expires_at = NEW.expires_at
         AND ledger.device_secret_hash = NEW.secret_hash
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'device authority unavailable'); END;

CREATE TRIGGER device_credentials_authority_shape_update
BEFORE UPDATE OF authority_kind, paired_via_pairing_id,
  accountless_enrollment_device_id, social_verified_at ON device_credentials
WHEN NOT (
  (NEW.authority_kind = 'social'
    AND NEW.paired_via_pairing_id IS NOT NULL
    AND NEW.accountless_enrollment_device_id IS NULL
    AND EXISTS (SELECT 1 FROM participants p WHERE p.id = NEW.participant_id
      AND p.owner_kind = 'social'))
  OR
  (NEW.authority_kind = 'accountless'
    AND NEW.paired_via_pairing_id IS NULL
    AND NEW.accountless_enrollment_device_id IS NOT NULL
    AND NEW.id = NEW.accountless_enrollment_device_id
    AND NEW.social_verified_at IS NULL
    AND EXISTS (SELECT 1 FROM participants p WHERE p.id = NEW.participant_id
      AND p.owner_kind = 'accountless'))
)
BEGIN SELECT RAISE(ABORT, 'device authority shape invalid'); END;

CREATE TRIGGER accountless_device_credential_nonrenewable
BEFORE UPDATE OF secret_hash, expires_at, issued_at, credential_generation,
  authority_kind, paired_via_pairing_id, accountless_enrollment_device_id
ON device_credentials
WHEN OLD.authority_kind = 'accountless'
BEGIN SELECT RAISE(ABORT, 'accountless device credential immutable'); END;

CREATE TRIGGER accountless_upload_owner_admission
BEFORE INSERT ON accountless_upload_owners
WHEN NOT EXISTS (
  SELECT 1 FROM accountless_enrollment_ledger ledger
    JOIN participants p ON p.id = NEW.participant_id
    JOIN device_credentials d ON d.id = NEW.device_credential_id
   WHERE ledger.device_id = NEW.enrollment_device_id
     AND ledger.state = 'active'
     AND ledger.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND ledger.expires_at = NEW.expires_at
     AND p.owner_kind = 'accountless' AND p.state = 'active'
     AND d.id = ledger.device_id
     AND d.participant_id = p.id AND d.authority_kind = 'accountless'
     AND d.accountless_enrollment_device_id = ledger.device_id
     AND d.state = 'active' AND d.expires_at = ledger.expires_at
)
BEGIN SELECT RAISE(ABORT, 'accountless owner unavailable'); END;

CREATE TRIGGER accountless_upload_owner_immutable
BEFORE UPDATE ON accountless_upload_owners
WHEN NEW.enrollment_device_id IS NOT OLD.enrollment_device_id
  OR NEW.participant_id IS NOT OLD.participant_id
  OR NEW.device_credential_id IS NOT OLD.device_credential_id
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.authorization_basis IS NOT OLD.authorization_basis
  OR NEW.authorized_at IS NOT OLD.authorized_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR OLD.state = 'revoked'
  OR (NEW.state = 'active' AND (NEW.revoked_at IS NOT NULL OR NEW.revocation_reason IS NOT NULL))
  OR (NEW.state = 'revoked' AND (NEW.revoked_at IS NULL OR NEW.revocation_reason IS NULL))
  OR (NEW.state = 'revoked' AND NOT EXISTS (
    SELECT 1 FROM accountless_enrollment_ledger ledger
     WHERE ledger.device_id = OLD.enrollment_device_id AND ledger.state = 'revoked'
  ))
BEGIN SELECT RAISE(ABORT, 'accountless owner immutable'); END;

CREATE TRIGGER accountless_v11_authorization_admission
BEFORE INSERT ON accountless_v11_device_authorizations
WHEN NOT EXISTS (
  SELECT 1 FROM accountless_upload_owners owner
    JOIN accountless_enrollment_ledger ledger
      ON ledger.device_id = owner.enrollment_device_id
    JOIN device_credentials d ON d.id = owner.device_credential_id
   WHERE owner.enrollment_device_id = NEW.enrollment_device_id
     AND owner.participant_id = NEW.participant_id
     AND owner.device_credential_id = NEW.device_credential_id
     AND owner.state = 'active' AND owner.expires_at = NEW.expires_at
     AND ledger.state = 'active' AND ledger.expires_at = NEW.expires_at
     AND d.authority_kind = 'accountless' AND d.state = 'active'
     AND d.accountless_enrollment_device_id = NEW.enrollment_device_id
     AND d.expires_at = NEW.expires_at
)
BEGIN SELECT RAISE(ABORT, 'accountless authorization unavailable'); END;

CREATE TRIGGER accountless_v11_authorization_immutable
BEFORE UPDATE ON accountless_v11_device_authorizations
WHEN NEW.enrollment_device_id IS NOT OLD.enrollment_device_id
  OR NEW.participant_id IS NOT OLD.participant_id
  OR NEW.device_credential_id IS NOT OLD.device_credential_id
  OR NEW.telemetry_schema_version IS NOT OLD.telemetry_schema_version
  OR NEW.field_dictionary_version IS NOT OLD.field_dictionary_version
  OR NEW.privacy_contract_version IS NOT OLD.privacy_contract_version
  OR NEW.authorized_at IS NOT OLD.authorized_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR OLD.state = 'revoked'
  OR (NEW.state = 'active' AND (NEW.revoked_at IS NOT NULL OR NEW.revocation_reason IS NOT NULL))
  OR (NEW.state = 'revoked' AND (NEW.revoked_at IS NULL OR NEW.revocation_reason IS NULL))
  OR (NEW.state = 'revoked' AND NOT EXISTS (
    SELECT 1 FROM accountless_enrollment_ledger ledger
     WHERE ledger.device_id = OLD.enrollment_device_id AND ledger.state = 'revoked'
  ))
BEGIN SELECT RAISE(ABORT, 'accountless authorization immutable'); END;

CREATE TRIGGER device_pairings_require_social_owner
BEFORE INSERT ON device_pairings
WHEN NOT EXISTS (SELECT 1 FROM participants p WHERE p.id = NEW.participant_id
  AND p.owner_kind = 'social')
BEGIN SELECT RAISE(ABORT, 'pairing unavailable'); END;

CREATE TRIGGER web_sessions_require_social_owner
BEFORE INSERT ON web_sessions
WHEN NOT EXISTS (SELECT 1 FROM participants p WHERE p.id = NEW.participant_id
  AND p.owner_kind = 'social')
BEGIN SELECT RAISE(ABORT, 'participant unavailable'); END;

CREATE TRIGGER upload_authorizations_require_social_owner
BEFORE INSERT ON upload_authorizations
WHEN NOT EXISTS (SELECT 1 FROM participants p WHERE p.id = NEW.participant_id
  AND p.owner_kind = 'social')
BEGIN SELECT RAISE(ABORT, 'participant unavailable'); END;

CREATE TRIGGER contributions_require_social_owner
BEFORE INSERT ON contributions
WHEN NOT EXISTS (SELECT 1 FROM participants p WHERE p.id = NEW.participant_id
  AND p.owner_kind = 'social')
BEGIN SELECT RAISE(ABORT, 'participant unavailable'); END;

CREATE TRIGGER telemetry_contributions_require_social_owner
BEFORE INSERT ON telemetry_contributions
WHEN NOT EXISTS (SELECT 1 FROM participants p WHERE p.id = NEW.participant_id
  AND p.owner_kind = 'social')
BEGIN SELECT RAISE(ABORT, 'participant unavailable'); END;

CREATE TRIGGER telemetry_v1_chunks_require_social_owner
BEFORE INSERT ON telemetry_v1_chunks
WHEN NOT EXISTS (SELECT 1 FROM participants p WHERE p.id = NEW.participant_id
  AND p.owner_kind = 'social')
BEGIN SELECT RAISE(ABORT, 'telemetry_transport_blocked'); END;

CREATE TRIGGER telemetry_v1_consent_requires_social_owner
BEFORE INSERT ON telemetry_v1_device_consents
WHEN NOT EXISTS (SELECT 1 FROM participants p WHERE p.id = NEW.participant_id
  AND p.owner_kind = 'social')
BEGIN SELECT RAISE(ABORT, 'telemetry_transport_blocked'); END;

CREATE TRIGGER participant_community_eligibility_requires_social_owner
BEFORE INSERT ON participant_community_eligibility
WHEN NOT EXISTS (SELECT 1 FROM participants p WHERE p.id = NEW.participant_id
  AND p.owner_kind = 'social')
BEGIN SELECT RAISE(ABORT, 'grant unavailable'); END;

CREATE TRIGGER accountless_device_upload_authorization_admission
BEFORE INSERT ON device_upload_authorizations
WHEN EXISTS (SELECT 1 FROM device_credentials d
  WHERE d.id = NEW.issued_by_device_id AND d.authority_kind = 'accountless')
 AND NOT EXISTS (
  SELECT 1 FROM device_credentials d
    JOIN participants p ON p.id = d.participant_id
    JOIN accountless_enrollment_ledger ledger
      ON ledger.device_id = d.accountless_enrollment_device_id
    JOIN accountless_upload_owners owner
      ON owner.enrollment_device_id = ledger.device_id
    JOIN accountless_v11_device_authorizations grant_row
      ON grant_row.enrollment_device_id = ledger.device_id
   WHERE d.id = NEW.issued_by_device_id
     AND d.participant_id = NEW.participant_id
     AND d.authority_kind = 'accountless' AND d.state = 'active'
     AND d.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND p.owner_kind = 'accountless' AND p.state = 'active'
     AND ledger.state = 'active' AND ledger.expires_at = d.expires_at
     AND ledger.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND owner.participant_id = p.id AND owner.device_credential_id = d.id
     AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
     AND grant_row.participant_id = p.id AND grant_row.device_credential_id = d.id
     AND grant_row.state = 'active' AND grant_row.expires_at = ledger.expires_at
 )
BEGIN SELECT RAISE(ABORT, 'accountless authority unavailable'); END;

CREATE TRIGGER accountless_device_upload_claim_admission
BEFORE UPDATE OF state ON device_upload_authorizations
WHEN NEW.state IN ('consuming', 'consumed')
 AND EXISTS (SELECT 1 FROM device_credentials d
  WHERE d.id = OLD.issued_by_device_id AND d.authority_kind = 'accountless')
 AND NOT EXISTS (
  SELECT 1 FROM device_credentials d
    JOIN participants p ON p.id = d.participant_id
    JOIN accountless_enrollment_ledger ledger
      ON ledger.device_id = d.accountless_enrollment_device_id
    JOIN accountless_upload_owners owner
      ON owner.enrollment_device_id = ledger.device_id
    JOIN accountless_v11_device_authorizations grant_row
      ON grant_row.enrollment_device_id = ledger.device_id
   WHERE d.id = OLD.issued_by_device_id
     AND d.participant_id = OLD.participant_id
     AND d.authority_kind = 'accountless' AND d.state = 'active'
     AND d.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND p.owner_kind = 'accountless' AND p.state = 'active'
     AND ledger.state = 'active' AND ledger.expires_at = d.expires_at
     AND ledger.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND owner.participant_id = p.id AND owner.device_credential_id = d.id
     AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
     AND grant_row.participant_id = p.id AND grant_row.device_credential_id = d.id
     AND grant_row.state = 'active' AND grant_row.expires_at = ledger.expires_at
 )
BEGIN SELECT RAISE(ABORT, 'accountless authority unavailable'); END;

CREATE TRIGGER telemetry_v11_consent_admission BEFORE INSERT ON telemetry_v11_device_consents
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM participants p JOIN device_credentials d ON d.participant_id = p.id
      JOIN attribution_enrollments e ON e.participant_id = p.id
      JOIN telemetry_transport_formats f ON f.schema_version = NEW.telemetry_schema_version
     WHERE p.id = NEW.participant_id AND p.state = 'active' AND p.owner_kind = 'social'
       AND d.id = NEW.device_id AND d.authority_kind = 'social' AND d.state = 'active'
       AND f.lifecycle = 'accepted'
       AND NOT EXISTS (SELECT 1 FROM telemetry_contributions legacy
         WHERE legacy.participant_id = NEW.participant_id AND legacy.status = 'accepted'
           AND legacy.transport_schema_version = 'telemetry-contribution-v0.2')
  ) THEN RAISE(ABORT, 'telemetry_transport_blocked') END);
END;

CREATE TRIGGER telemetry_v11_manifest_admission BEFORE INSERT ON telemetry_v11_day_manifests
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM device_credentials d
      JOIN participants p ON p.id = d.participant_id
      JOIN telemetry_transport_participant_floors f ON f.participant_id = p.id
      JOIN telemetry_transport_formats t ON t.schema_version = 'telemetry-contribution-v1.1'
     WHERE p.id = NEW.participant_id AND d.id = NEW.device_id
       AND d.state = 'active' AND d.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       AND p.state = 'active' AND t.lifecycle = 'accepted' AND t.format_rank >= f.minimum_rank
       AND (
      (p.owner_kind = 'social'
       AND d.authority_kind = 'social'
       AND EXISTS (SELECT 1 FROM telemetry_v11_device_consents c
         WHERE c.participant_id = p.id AND c.device_id = d.id))
      OR
      (p.owner_kind = 'accountless'
       AND d.authority_kind = 'accountless'
       AND EXISTS (
         SELECT 1 FROM accountless_enrollment_ledger ledger
           JOIN accountless_upload_owners owner
             ON owner.enrollment_device_id = ledger.device_id
           JOIN accountless_v11_device_authorizations grant_row
             ON grant_row.enrollment_device_id = ledger.device_id
          WHERE ledger.device_id = d.accountless_enrollment_device_id
            AND ledger.state = 'active' AND ledger.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND ledger.expires_at = d.expires_at
            AND owner.participant_id = p.id AND owner.device_credential_id = d.id
            AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
            AND grant_row.participant_id = p.id AND grant_row.device_credential_id = d.id
            AND grant_row.state = 'active' AND grant_row.expires_at = ledger.expires_at
       ))
    )
       AND NOT EXISTS (SELECT 1 FROM telemetry_contributions legacy
         WHERE legacy.participant_id = NEW.participant_id AND legacy.status = 'accepted'
           AND legacy.transport_schema_version = 'telemetry-contribution-v0.2')
  ) THEN RAISE(ABORT, 'telemetry_transport_blocked') END);
  SELECT (CASE WHEN NEW.expected_chunk_count != json_array_length(NEW.manifest_json, '$.chunks')
    OR NEW.state != 'staged' THEN RAISE(ABORT, 'telemetry_manifest_invalid') END);
  SELECT (CASE WHEN (SELECT count(*) FROM (
    SELECT 1 FROM telemetry_v11_day_manifests
     WHERE participant_id = NEW.participant_id AND device_id = NEW.device_id
       AND created_at >= substr(NEW.created_at, 1, 10) || 'T00:00:00.000Z'
     LIMIT 8192
  )) >= 8192 THEN RAISE(ABORT, 'telemetry_manifest_admission_exhausted') END);
END;

CREATE TRIGGER telemetry_v11_chunk_admission BEFORE INSERT ON telemetry_v11_chunks
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_v11_day_manifests m
      JOIN telemetry_transport_formats t ON t.schema_version = 'telemetry-contribution-v1.1'
      JOIN telemetry_transport_participant_floors f ON f.participant_id = m.participant_id
      JOIN participants p ON p.id = m.participant_id
      JOIN device_credentials d ON d.id = m.device_id AND d.participant_id = m.participant_id
      JOIN device_upload_authorizations a ON a.id = NEW.device_upload_authorization_id
      JOIN json_each(m.manifest_json, '$.chunks') expected
     WHERE m.id = NEW.manifest_id AND m.participant_id = NEW.participant_id
       AND m.device_id = NEW.device_id AND m.chunk_day = NEW.chunk_day
       AND m.parser_version = NEW.parser_version AND m.state = 'staged'
       AND d.state = 'active' AND d.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       AND p.state = 'active' AND t.lifecycle = 'accepted' AND t.format_rank >= f.minimum_rank
       AND (
      (p.owner_kind = 'social'
       AND d.authority_kind = 'social'
       AND EXISTS (SELECT 1 FROM telemetry_v11_device_consents c
         WHERE c.participant_id = p.id AND c.device_id = d.id))
      OR
      (p.owner_kind = 'accountless'
       AND d.authority_kind = 'accountless'
       AND EXISTS (
         SELECT 1 FROM accountless_enrollment_ledger ledger
           JOIN accountless_upload_owners owner
             ON owner.enrollment_device_id = ledger.device_id
           JOIN accountless_v11_device_authorizations grant_row
             ON grant_row.enrollment_device_id = ledger.device_id
          WHERE ledger.device_id = d.accountless_enrollment_device_id
            AND ledger.state = 'active' AND ledger.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND ledger.expires_at = d.expires_at
            AND owner.participant_id = p.id AND owner.device_credential_id = d.id
            AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
            AND grant_row.participant_id = p.id AND grant_row.device_credential_id = d.id
            AND grant_row.state = 'active' AND grant_row.expires_at = ledger.expires_at
       ))
    )
       AND NOT EXISTS (SELECT 1 FROM telemetry_contributions legacy
         WHERE legacy.participant_id = NEW.participant_id AND legacy.status = 'accepted'
           AND legacy.transport_schema_version = 'telemetry-contribution-v0.2')
       AND a.participant_id = NEW.participant_id AND a.issued_by_device_id = NEW.device_id
       AND a.state = 'consuming' AND a.envelope_digest = NEW.envelope_digest
       AND a.consume_lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       AND a.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       AND json_extract(expected.value, '$.chunkId') = NEW.chunk_id
       AND json_extract(expected.value, '$.chunkDigest') = NEW.chunk_digest
       AND json_extract(expected.value, '$.recordCount') = NEW.record_count
  ) THEN RAISE(ABORT, 'telemetry_chunk_staging_denied') END);
END;

CREATE TRIGGER telemetry_v11_predecessor_authority
BEFORE INSERT ON telemetry_v11_domain_predecessors
WHEN NOT EXISTS (
  SELECT 1 FROM device_credentials d
    JOIN participants p ON p.id = d.participant_id
    JOIN telemetry_transport_participant_floors f ON f.participant_id = p.id
    JOIN telemetry_transport_formats t ON t.schema_version = 'telemetry-contribution-v1.1'
   WHERE p.id = NEW.participant_id AND d.id = NEW.device_id
     AND p.state = 'active' AND d.state = 'active'
     AND d.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND t.lifecycle = 'accepted' AND t.format_rank >= f.minimum_rank
     AND (
      (p.owner_kind = 'social'
       AND d.authority_kind = 'social'
       AND EXISTS (SELECT 1 FROM telemetry_v11_device_consents c
         WHERE c.participant_id = p.id AND c.device_id = d.id))
      OR
      (p.owner_kind = 'accountless'
       AND d.authority_kind = 'accountless'
       AND EXISTS (
         SELECT 1 FROM accountless_enrollment_ledger ledger
           JOIN accountless_upload_owners owner
             ON owner.enrollment_device_id = ledger.device_id
           JOIN accountless_v11_device_authorizations grant_row
             ON grant_row.enrollment_device_id = ledger.device_id
          WHERE ledger.device_id = d.accountless_enrollment_device_id
            AND ledger.state = 'active' AND ledger.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND ledger.expires_at = d.expires_at
            AND owner.participant_id = p.id AND owner.device_credential_id = d.id
            AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
            AND grant_row.participant_id = p.id AND grant_row.device_credential_id = d.id
            AND grant_row.state = 'active' AND grant_row.expires_at = ledger.expires_at
       ))
    )
)
BEGIN SELECT RAISE(ABORT, 'telemetry_transport_blocked'); END;

CREATE VIEW telemetry_v11_current_predecessors AS
SELECT x.* FROM telemetry_v11_domain_predecessors x
JOIN participants p ON p.id = x.participant_id AND p.state = 'active'
JOIN device_credentials c ON c.id = x.device_id AND c.participant_id = x.participant_id
  AND c.state = 'active' AND c.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
JOIN telemetry_transport_participant_floors floor_row ON floor_row.participant_id = x.participant_id
  AND floor_row.minimum_rank <= 11
JOIN telemetry_transport_formats format_row ON format_row.schema_version = 'telemetry-contribution-v1.1'
  AND format_row.lifecycle = 'accepted'
LEFT JOIN telemetry_v11_device_consents social_grant
  ON social_grant.participant_id = x.participant_id AND social_grant.device_id = x.device_id
LEFT JOIN accountless_enrollment_ledger ledger
  ON ledger.device_id = c.accountless_enrollment_device_id
LEFT JOIN accountless_upload_owners owner
  ON owner.enrollment_device_id = ledger.device_id
LEFT JOIN accountless_v11_device_authorizations accountless_grant
  ON accountless_grant.enrollment_device_id = ledger.device_id
JOIN community_analytical_input_versions v ON v.participant_id = x.participant_id
  AND v.revision = x.input_revision
LEFT JOIN telemetry_v11_domain_heads h ON h.participant_id = x.participant_id
WHERE x.consumed_at IS NULL AND x.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  AND x.previous_generation_id IS h.generation_id
  AND (
    (p.owner_kind = 'social' AND c.authority_kind = 'social' AND social_grant.device_id IS NOT NULL)
    OR
    (p.owner_kind = 'accountless' AND c.authority_kind = 'accountless'
      AND ledger.state = 'active' AND ledger.expires_at = c.expires_at
      AND ledger.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND owner.participant_id = p.id AND owner.device_credential_id = c.id
      AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
      AND accountless_grant.participant_id = p.id AND accountless_grant.device_credential_id = c.id
      AND accountless_grant.state = 'active' AND accountless_grant.expires_at = ledger.expires_at)
  );

CREATE TRIGGER telemetry_transport_rollback_owner_only
BEFORE INSERT ON telemetry_transport_floor_rollbacks
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM admin_action_audit a
      JOIN telemetry_transport_participant_floors f ON f.participant_id = NEW.participant_id
      JOIN participants p ON p.id = f.participant_id
     WHERE a.operation_id = NEW.operation_id AND a.action = 'run_maintenance'
       AND a.outcome = 'started' AND p.state = 'active' AND p.owner_kind = 'social'
       AND json_extract(a.details_json, '$.operation') = 'telemetry_transport_rollback'
       AND json_extract(a.details_json, '$.participantDigest') = NEW.participant_digest
       AND json_extract(a.details_json, '$.expectedRevision') = NEW.expected_revision
       AND json_extract(a.details_json, '$.fromRank') = NEW.from_rank
       AND json_extract(a.details_json, '$.toRank') = NEW.to_rank
       AND f.revision = NEW.expected_revision AND f.minimum_rank = NEW.from_rank
  ) THEN RAISE(ABORT, 'telemetry_transport_rollback_denied') END);
END;
