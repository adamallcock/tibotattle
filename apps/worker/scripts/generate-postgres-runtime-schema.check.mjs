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
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0034_usage_correction_history.sql"',
      '"0035_v12_ready_manifest_retention.sql"',
    ),
    true,
  );
  assert.equal(
    renderPostgresRuntimeSchema(manifest).includes(
      '"0006_erasure_ledger_transfer_receipts.sql"',
    ),
    true,
  );
});
