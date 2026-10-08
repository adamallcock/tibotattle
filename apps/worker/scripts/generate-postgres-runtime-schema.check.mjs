import test from "node:test";
import assert from "node:assert/strict";
import { buildPostgresMigrationManifest } from "./postgres-migrations.mjs";
import {
  generatePostgresRuntimeSchema,
  renderPostgresRuntimeSchema,
} from "./generate-postgres-runtime-schema.mjs";

test("Worker migration receipt source is generated exactly from canonical SQL", async () => {
  const result = await generatePostgresRuntimeSchema();
  assert.equal(result.changed, false);
  const manifest = await buildPostgresMigrationManifest();
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0018_admin_analytics_caches.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0024_scheduler_source_cutoff.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0025_typed_v12_normalized.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0026_v12_domain_days_and_input_revision.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0027_typed_v12_published_delete_guard.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0028_typed_v12_ready_integrity_guard.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0029_legacy_source_membership.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0030_legacy_typed_telemetry.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0037_community_daily_publications.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0038_analytics_event_tuple_versions.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0039_analytics_applied_projection_v1.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0040_historical_transport_headers.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0041_accountless_history_retention.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0042_accountless_history_retention_import.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0043_accountless_history_d1_import.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0044_accountless_import_claim_erasure.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0045_accountless_v12_history_retention.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0046_owner_journal_authority.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0031_typed_legacy_source_family_receipts.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0032_analytics_publication_fences.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0033_legacy_admission_proofs.sql"',
    ),
    true,
  );
  for (const migration of [
    '"0034_usage_correction_history.sql"',
    '"0035_v12_ready_manifest_retention.sql"',
    '"0036_streamed_publication_proofs.sql"',
  ]) {
    assert.equal(renderPostgresRuntimeSchema(manifest).includes(migration), true);
  }
  // Wave-1 promotion (claude/gcp-fastpath-base): primary 0047-0058 moved
  // from staged-migrations/ unchanged, then the fast path promoted primary
  // 0059 (analytics_v2) the same way, the wave-2 integration promoted
  // W2-SEAL's 0063, LEAD-SIMP added the append-only residue 0064, and the
  // C-SIMP-RECON integration promoted C-IPR's interim public read as 0065, and
  // the D-PT4X integration promoted community_aggregate_exclusions as 0066 and
  // pending_object_transfer_holds as 0067, and the D-OPS4 follow-up merge
  // promoted the ready_at index as 0068, and the K-CORE-A merge promoted the
  // analytics_v2 run stamps as 0069, so the runtime receipt fences the whole
  // promoted primary chain.
  for (const migration of [
    '"0047_host_diagnostic_errors.sql"',
    '"0048_rate_limit_buckets_unlogged.sql"',
    '"0049_lifecycle_readiness_state.sql"',
    '"0050_admin_audit_and_collection_controls.sql"',
    '"0051_transport_floor_parity.sql"',
    '"0052_typed_telemetry_live_allocators.sql"',
    '"0053_community_publication_authority.sql"',
    '"0054_signin_handoff_claim_shape.sql"',
    '"0055_v12_owner_bridge.sql"',
    '"0056_production_transfer_control.sql"',
    '"0057_upload_path_analytics_retirement.sql"',
    '"0058_owner_journal_emitter_head_precheck.sql"',
    '"0059_analytics_v2.sql"',
    '"0060_telemetry_v11_live_admission.sql"',
    '"0061_legacy_contribution_admission.sql"',
    '"0062_telemetry_contribution_trigger_search_path.sql"',
    '"0063_enrollment_grants_erased_redeemer.sql"',
    '"0064_append_only_residue.sql"',
    '"0065_interim_public_read.sql"',
    '"0066_community_aggregate_exclusions.sql"',
    '"0067_pending_object_transfer_holds.sql"',
    '"0068_v12_ready_manifest_ready_at_index.sql"',
    '"0069_analytics_v2_run_stamps.sql"',
    '"0070_catalog_manifest_store.sql"',
    '"0071_analytics_v2_revision_floor.sql"',
    '"0072_analytics_v2_price_cards.sql"',
    '"0073_analytics_v2_owner_sets.sql"',
    '"0075_github_distribution_manifest_visibility.sql"',
    '"0076_classification_correction_links.sql"',
  ]) {
    assert.equal(renderPostgresRuntimeSchema(manifest).includes(migration), true);
  }
  assert.equal(manifest.schemaVersion, "tibotattle-postgres-migration-manifest-v2");
  assert.deepEqual(Object.keys(manifest.roles), ["primary"]);
  assert.equal(manifest.roles.primary.length, 76);
  // No frozen ledger fragment reaches the Worker receipt.
  const rendered = renderPostgresRuntimeSchema(manifest);
  for (const ledgerOnly of [
    '"0002_tombstones_cooldowns.sql"',
    '"0006_erasure_ledger_transfer_receipts.sql"',
    '"0007_production_transfer_control.sql"',
    "ledger",
  ]) {
    assert.equal(rendered.includes(ledgerOnly), false, ledgerOnly);
  }
});

test("the renderer refuses a v1 or dual-role manifest", async () => {
  const manifest = await buildPostgresMigrationManifest();
  for (const stale of [
    { ...manifest, schemaVersion: "tibotattle-postgres-migration-manifest-v1" },
    { ...manifest, roles: { ...manifest.roles, ledger: [] } },
    { ...manifest, roles: { ledger: manifest.roles.primary } },
    { ...manifest, roles: {} },
  ]) {
    assert.throws(() => renderPostgresRuntimeSchema(stale), /invalid PostgreSQL migration manifest/u);
  }
});
