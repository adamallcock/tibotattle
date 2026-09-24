import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  assertAccountlessAuthorityTransferPreflight,
  assessCutoverSourceCoverage,
  assertV12CutoverGate,
  createSyntheticCanonicalD1,
  inventoryCutoverSource,
  inventoryCutoverSources,
  runLocalSyntheticPostgresCutoverRehearsal,
  validateSyntheticSourceSchema,
} from "./postgres-cutover-rehearsal.mjs";

const v1Tables = ["telemetry_v1_device_consents", "telemetry_v1_chunks", "telemetry_v1_records"];
const v11Tables = ["telemetry_v11_device_consents", "telemetry_v11_day_manifests", "telemetry_v11_chunks", "telemetry_v11_records"];
const v12Tables = [
  "telemetry_v12_runtime", "telemetry_v12_device_capabilities", "telemetry_v12_day_manifests",
  "telemetry_v12_chunks", "telemetry_v12_records", "telemetry_v12_quota",
  "telemetry_v12_session_tools", "telemetry_v12_usage", "telemetry_v12_attributions",
  "telemetry_v12_domain_predecessors",
  "telemetry_v12_domains", "telemetry_v12_domain_days", "telemetry_v12_domain_heads",
  "accountless_v12_device_authorizations",
];

test("v1.2 inventory names track the current ingestion migration", async () => {
  const sql = await readFile(new URL("../ingestion-isolation-migrations/0008_telemetry_v12.sql", import.meta.url), "utf8");
  const created = [...sql.matchAll(/\bCREATE TABLE\s+(telemetry_v12_[a-z0-9_]+|accountless_v12_[a-z0-9_]+)/gu)]
    .map(match => match[1]).sort();
  assert.deepEqual(created, [...v12Tables].sort());
});

function createInventorySource(tables, migrationLedgerTable = "d1_migrations") {
  const database = new DatabaseSync(":memory:");
  assert.match(migrationLedgerTable, /^[a-z][a-z0-9_]{0,62}$/u);
  database.exec(`CREATE TABLE "${migrationLedgerTable}" (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)`);
  database.prepare(`INSERT INTO "${migrationLedgerTable}"(name) VALUES (?)`).run("0001_synthetic_inventory.sql");
  for (const table of tables) {
    assert.match(table, /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u);
    database.exec(`CREATE TABLE "${table}" (fixture_id TEXT)`);
  }
  return database;
}

test("source coverage is complete for v1/v1.1 and refuses v1.2 gaps", () => {
  const coverage = assessCutoverSourceCoverage([...v1Tables, ...v11Tables]);
  assert.equal(coverage.v1, "available");
  assert.equal(coverage.v11, "available");
  assert.equal(coverage.v12, "unavailable-in-canonical-d1-migrations");
  assert.deepEqual(coverage.v12TablesMissing, v12Tables);
  assert.throws(() => assertV12CutoverGate(coverage), error => error.code === "CUTOVER_V12_SOURCE_UNAVAILABLE");
  assert.throws(() => assessCutoverSourceCoverage([...v1Tables, ...v11Tables, v12Tables[0]]), error => error.code === "CUTOVER_V12_SOURCE_PARTIAL");
  assert.throws(() => assessCutoverSourceCoverage(v1Tables.slice(1).concat(v11Tables)), error => error.code === "CUTOVER_V1_SOURCE_INCOMPLETE");
  assert.throws(() => assessCutoverSourceCoverage([...v1Tables, ...v11Tables, "telemetry_v12_future_capability"]), error => error.code === "CUTOVER_V12_SOURCE_UNKNOWN_TABLE");
  assert.throws(() => assertV12CutoverGate(assessCutoverSourceCoverage([...v1Tables, ...v11Tables, ...v12Tables])), error => error.code === "CUTOVER_V12_NOT_SUPPORTED");
});

test("schema drift in the synthetic D1 source fails closed", async () => {
  const source = await createSyntheticCanonicalD1();
  try {
    assert.equal(validateSyntheticSourceSchema(source), true);
    source.exec("ALTER TABLE telemetry_v1_chunks ADD COLUMN unhandled_fixture_column TEXT");
    assert.throws(() => validateSyntheticSourceSchema(source), error => error.code === "CUTOVER_SOURCE_SCHEMA_DRIFT");
  } finally {
    source.close();
  }
});

test("content-free source inventory names every gap beyond the synthetic v1/v1.1/v1.2 subset", async () => {
  const source = await createSyntheticCanonicalD1();
  try {
    const inventory = inventoryCutoverSource(source);
    assert.equal(inventory.contentFree, true);
    assert.ok(inventory.sourceTableCount > 70);
    assert.ok(inventory.sourceSchemaObjectCount >= inventory.sourceTableCount);
    assert.match(inventory.sourceSchemaSha256, /^[a-f0-9]{64}$/u);
    assert.ok(inventory.migrationLedger.migrationCount > 40);
    assert.equal(inventory.sourceCoverage.state, "v1-v1.1-v1.2-source-schema-observed");
    assert.equal(inventory.sourceCoverage.formats.v12, "present-but-unsupported");
    assert.equal(inventory.countsByTransferState["supported-synthetic-subset"], 21);
    assert.ok(inventory.identityAndAuthorityTablesNotTransferred.includes("participants"));
    assert.ok(inventory.identityAndAuthorityTablesNotTransferred.includes("enrollment_grants"));
    assert.ok(inventory.identityAndAuthorityTablesNotTransferred.includes("accountless_enrollment_ledger"));
    assert.ok(inventory.untransferredTables.includes("telemetry_v1_chunk_admission_windows"));
    assert.ok(inventory.untransferredTables.includes("telemetry_v11_domains"));
    assert.deepEqual(inventory.objectCoverage, {
      pendingObjectReferenceTable: "partial-selected-chunk-references-only",
      reconciliationStateTransferred: false,
      r2ObjectMetadataInventoried: false,
      r2ObjectBodiesTransferred: false,
    });
    assert.equal(inventory.sourceSchemaTransferImplemented, false);
    assert.ok(inventory.blockers.some(item => item.code === "CUTOVER_SOURCE_VIEWS_INDEXES_AND_TRIGGERS_NOT_TRANSFERRED"));
    assert.ok(inventory.derivedSchemaObjectsNotTransferred.some(item => item.type === "view"));
    assert.deepEqual(inventory.independentLedger, {
      primaryD1EnrollmentLedgerTablePresent: true,
      separateErasureRestoreLedgerSourcePresent: false,
      targetImportImplemented: false,
    });
    assert.equal(inventory.fullCutoverReady, false);
    assert.ok(inventory.blockers.some(item => item.code === "CUTOVER_R2_OBJECT_INVENTORY_AND_TRANSFER_MISSING"));
    assert.ok(inventory.blockers.some(item => item.code === "CUTOVER_INDEPENDENT_ERASURE_RESTORE_LEDGER_NOT_TRANSFERRED"));
    assert.equal(JSON.stringify(inventory).includes("cutover-synthetic-event"), false);
  } finally {
    source.close();
  }
});

test("new source tables appear as unclassified blockers without reading their rows", async () => {
  const source = await createSyntheticCanonicalD1();
  try {
    source.exec("CREATE TABLE future_unreviewed_source(secret_value TEXT)");
    source.prepare("INSERT INTO future_unreviewed_source VALUES (?)").run("private-fixture-value");
    const inventory = inventoryCutoverSource(source);
    assert.ok(inventory.untransferredTables.includes("future_unreviewed_source"));
    assert.ok(inventory.unclassifiedTables.includes("future_unreviewed_source"));
    assert.ok(inventory.tables.some(item => item.table === "future_unreviewed_source" && item.transferState === "unclassified-source-table"));
    const printed = JSON.stringify(inventory);
    assert.equal(printed.includes("private-fixture-value"), false);
    assert.equal(printed.includes("secret_value"), false);
  } finally {
    source.close();
  }
});

test("observed production-only table families receive explicit fail-closed classifications", () => {
  const source = createInventorySource([
    "_authority_snapshot", "_authority_restore_pages", "_cf_KV",
    "accountless_telemetry_performance_authorizations", "ingestion_analytics_separation",
    "storage_source_state", "typed_telemetry_records", "typed_v11_record_proofs",
    "typed_v1_record_admissions", "github_release_snapshots", "diagnostic_error_events",
  ]);
  try {
    source.exec("CREATE TABLE analytics_sequence_fixture(id INTEGER PRIMARY KEY AUTOINCREMENT)");
    const inventory = inventoryCutoverSource(source, { requireTelemetryFormats: false });
    const states = new Map(inventory.tables.map(item => [item.table, item.transferState]));
    assert.equal(states.get("_authority_snapshot"), "untransferred-owner-restore-authority");
    assert.equal(states.get("_authority_restore_pages"), "untransferred-owner-restore-authority");
    assert.equal(states.get("_cf_KV"), "cloudflare-platform-internal-requires-disposition");
    assert.equal(states.get("sqlite_sequence"), "untransferred-sqlite-sequence-state");
    assert.equal(states.get("accountless_telemetry_performance_authorizations"), "untransferred-identity-or-authority");
    assert.equal(states.get("ingestion_analytics_separation"), "untransferred-ingestion-analytics-boundary-state");
    assert.equal(states.get("storage_source_state"), "untransferred-storage-journal-or-revision-state");
    assert.equal(states.get("typed_telemetry_records"), "untransferred-typed-telemetry-schema-or-authority");
    assert.equal(states.get("typed_v11_record_proofs"), "untransferred-typed-telemetry-schema-or-authority");
    assert.equal(states.get("typed_v1_record_admissions"), "untransferred-typed-telemetry-schema-or-authority");
    assert.equal(states.get("github_release_snapshots"), "untransferred-release-distribution-state");
    assert.equal(states.get("diagnostic_error_events"), "untransferred-diagnostic-or-audit-state");
    assert.deepEqual(inventory.unclassifiedTables, []);
    assert.equal(inventory.fullCutoverReady, false);
  } finally {
    source.close();
  }
});

test("views, indexes, and triggers appear as untransferred schema objects", () => {
  const source = createInventorySource(["schema_object_fixture"]);
  try {
    source.exec(`CREATE INDEX schema_object_fixture_idx ON schema_object_fixture(fixture_id);
      CREATE VIEW schema_object_fixture_view AS SELECT fixture_id FROM schema_object_fixture;
      CREATE TRIGGER schema_object_fixture_trigger AFTER INSERT ON schema_object_fixture
      BEGIN SELECT 1; END;`);
    const inventory = inventoryCutoverSource(source, { requireTelemetryFormats: false });
    assert.deepEqual(inventory.sourceSchemaObjectsByType, { table: 2, index: 1, view: 1, trigger: 1 });
    assert.deepEqual(inventory.derivedSchemaObjectsNotTransferred, [
      { type: "index", name: "schema_object_fixture_idx" },
      { type: "trigger", name: "schema_object_fixture_trigger" },
      { type: "view", name: "schema_object_fixture_view" },
    ]);
    assert.equal(inventory.sourceSchemaTransferImplemented, false);
    assert.ok(inventory.blockers.some(item => item.code === "CUTOVER_SOURCE_VIEWS_INDEXES_AND_TRIGGERS_NOT_TRANSFERRED"));
  } finally {
    source.close();
  }
});

test("missing D1 migration history is an explicit source-inventory blocker", async () => {
  const source = await createSyntheticCanonicalD1();
  try {
    source.exec("DROP TABLE d1_migrations; DROP TABLE d1_storage_migrations");
    const inventory = inventoryCutoverSource(source);
    assert.equal(inventory.migrationLedger.present, false);
    assert.equal(inventory.sourceCoverage.state, "blocked");
    assert.equal(inventory.sourceCoverage.gateCode, "CUTOVER_MIGRATION_LEDGER_MISSING");
    assert.ok(inventory.blockers.some(item => item.code === "CUTOVER_MIGRATION_LEDGER_MISSING"));
    assert.equal(inventory.fullCutoverReady, false);
  } finally {
    source.close();
  }
});

test("the typed v1.2 subset mapping still blocks full-format cutover", async () => {
  const source = await createSyntheticCanonicalD1();
  try {
    const inventory = inventoryCutoverSource(source);
    assert.equal(inventory.sourceCoverage.state, "v1-v1.1-v1.2-source-schema-observed");
    assert.equal(inventory.sourceCoverage.formats.v12, "present-but-unsupported");
    assert.equal(inventory.sourceCoverage.formats.fullFormatCoverage, true);
    assert.equal(inventory.countsByTransferState["supported-synthetic-subset"], 21);
    assert.ok(inventory.untransferredTables.includes("accountless_v12_device_authorizations"));
    assert.equal(inventory.tables.find(item => item.table === "accountless_v12_device_authorizations")?.transferState,
      "untransferred-accountless-v12-authority-parent-families");
    assert.equal(inventory.fullCutoverReady, false);
    assert.throws(() => assertV12CutoverGate(inventory.sourceCoverage.formats), error => error.code === "CUTOVER_V12_NOT_SUPPORTED");
  } finally {
    source.close();
  }
});

function seedAccountlessV12Authority(source) {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const expires = new Date(nowMs + 30 * 24 * 60 * 60 * 1000).toISOString();
  const device = "00000000-0000-4000-8000-000000000012";
  const participant = "00000000-0000-4000-8000-000000000013";
  source.prepare(`UPDATE accountless_enrollment_issuance SET budget_day=?, daily_issued=1,
    lifetime_issued=1, last_issue_token='synthetic-accountless-issue', updated_at=?
    WHERE singleton=1`).run(now.slice(0, 10), now);
  source.prepare(`INSERT INTO accountless_enrollment_ledger (
    device_id, device_secret_hash, installation_principal_id, schema_version,
    policy_version, authorization_basis, state, issued_at, expires_at
  ) VALUES (?, ?, ?, 'accountless-enrollment-v0.1', 'accountless-opt-out-v1',
    'accountless-policy-v1', 'active', ?, ?)`).run(device, Buffer.alloc(32, 41),
    "synthetic-accountless-installation", now, expires);
  source.prepare(`INSERT INTO participants (
    id, owner_kind, access_token_id, access_token_hash, recovery_token_id,
    recovery_token_hash, state, consent_version, consented_at, created_at,
    deletion_session_id, identity_link_key, identity_cooldown_digest
  ) VALUES (?, 'accountless', NULL, NULL, NULL, NULL, 'active', NULL, NULL, ?, NULL, NULL, NULL)`)
    .run(participant, now);
  source.prepare(`INSERT INTO device_credentials (
    id, participant_id, authority_kind, paired_via_pairing_id,
    accountless_enrollment_device_id, secret_hash, state, issued_at, expires_at,
    last_used_at, revoked_at, social_verified_at, credential_generation
  ) VALUES (?, ?, 'accountless', NULL, ?, ?, 'active', ?, ?, ?, NULL, NULL, 1)`)
    .run(device, participant, device, Buffer.alloc(32, 41), now, expires, now);
  source.prepare(`INSERT INTO accountless_upload_owners (
    enrollment_device_id, participant_id, device_credential_id, policy_version,
    authorization_basis, authorized_at, expires_at, state
  ) VALUES (?, ?, ?, 'accountless-opt-out-v1', 'accountless-policy-v1', ?, ?, 'active')`)
    .run(device, participant, device, now, expires);
  source.prepare(`INSERT INTO accountless_v11_device_authorizations (
    enrollment_device_id, participant_id, device_credential_id,
    telemetry_schema_version, field_dictionary_version, privacy_contract_version,
    authorized_at, expires_at, state
  ) VALUES (?, ?, ?, 'telemetry-contribution-v1.1',
    'telemetry-v1.1-registry-2026-08-31.1', 'ongoing-privacy-safe-telemetry-v1.1',
    ?, ?, 'active')`).run(device, participant, device, now, expires);
  source.prepare(`INSERT INTO accountless_v12_device_authorizations (
    enrollment_device_id, participant_id, device_credential_id, schema_version,
    policy_version, authorization_basis, telemetry_schema_version,
    field_dictionary_version, privacy_contract_version, authorized_at, expires_at, state
  ) VALUES (?, ?, ?, 'accountless-upload-owner-v1.2',
    'accountless-telemetry-v1.2-policy-v1', 'accountless-policy-v1.2',
    'telemetry-contribution-v1.2', 'telemetry-v1.2-registry-2026-09-20.1',
    'ongoing-privacy-safe-telemetry-v1.2', ?, ?, 'active')`)
    .run(device, participant, device, now, expires);
  return { device, now, expires };
}

test("accountless v1.2 import preflight proves parent integrity then refuses the unqualified schema gap", async () => {
  const source = await createSyntheticCanonicalD1();
  try {
    assert.equal(assertAccountlessAuthorityTransferPreflight(source), true);
    const { device, now, expires } = seedAccountlessV12Authority(source);
    const floor = source.prepare(`SELECT minimum_rank FROM telemetry_transport_participant_floors
      WHERE participant_id='00000000-0000-4000-8000-000000000013'`).get();
    assert.equal(floor?.minimum_rank, 11);
    assert.throws(() => assertAccountlessAuthorityTransferPreflight(source),
      error => error.code === "CUTOVER_ACCOUNTLESS_AUTHORITY_SCHEMA_PARITY_UNQUALIFIED");

    source.exec("PRAGMA foreign_keys=OFF");
    source.prepare("DELETE FROM accountless_upload_owners WHERE enrollment_device_id=?").run(device);
    source.exec("PRAGMA foreign_keys=ON");
    assert.throws(() => assertAccountlessAuthorityTransferPreflight(source),
      error => error.code === "CUTOVER_ACCOUNTLESS_AUTHORITY_CHAIN_INVALID");

    source.prepare(`INSERT INTO accountless_upload_owners (
      enrollment_device_id, participant_id, device_credential_id, policy_version,
      authorization_basis, authorized_at, expires_at, state
    ) VALUES (?, '00000000-0000-4000-8000-000000000013', ?,
      'accountless-opt-out-v1', 'accountless-policy-v1', ?, ?, 'active')`)
      .run(device, device, now, expires);
    source.exec("DROP TRIGGER accountless_v12_authorization_immutable");
    source.prepare(`UPDATE accountless_v12_device_authorizations
      SET expires_at=? WHERE enrollment_device_id=?`).run(
      new Date(Date.parse(expires) + 1000).toISOString(), device);
    assert.throws(() => assertAccountlessAuthorityTransferPreflight(source),
      error => error.code === "CUTOVER_ACCOUNTLESS_AUTHORITY_CHAIN_INVALID");

    source.prepare("UPDATE accountless_v12_device_authorizations SET expires_at=? WHERE enrollment_device_id=?")
      .run(expires, device);
    source.prepare(`UPDATE accountless_v12_device_authorizations
      SET state='revoked', revoked_at=?, revocation_reason='security_reset'
      WHERE enrollment_device_id=?`).run(now, device);
    assert.throws(() => assertAccountlessAuthorityTransferPreflight(source),
      error => error.code === "CUTOVER_ACCOUNTLESS_AUTHORITY_HISTORY_UNQUALIFIED");

    source.prepare("DELETE FROM accountless_v12_device_authorizations WHERE enrollment_device_id=?").run(device);
    assert.throws(() => assertAccountlessAuthorityTransferPreflight(source),
      error => error.code === "CUTOVER_ACCOUNTLESS_PARENT_FAMILY_UNQUALIFIED");
  } finally {
    source.close();
  }
});

test("empty accountless parent tables require an intact never-issued singleton", async () => {
  const source = await createSyntheticCanonicalD1();
  try {
    assert.equal(assertAccountlessAuthorityTransferPreflight(source), true);

    source.exec("UPDATE accountless_enrollment_issuance SET lifetime_issued=1 WHERE singleton=1");
    assert.throws(() => assertAccountlessAuthorityTransferPreflight(source),
      error => error.code === "CUTOVER_ACCOUNTLESS_ISSUANCE_STATE_INVALID");

    source.exec("UPDATE accountless_enrollment_issuance SET lifetime_issued=0, daily_issued=1 WHERE singleton=1");
    assert.throws(() => assertAccountlessAuthorityTransferPreflight(source),
      error => error.code === "CUTOVER_ACCOUNTLESS_ISSUANCE_STATE_INVALID");

    source.exec("UPDATE accountless_enrollment_issuance SET daily_issued=0, last_issue_token='synthetic-orphaned-issuance' WHERE singleton=1");
    assert.throws(() => assertAccountlessAuthorityTransferPreflight(source),
      error => error.code === "CUTOVER_ACCOUNTLESS_ISSUANCE_STATE_INVALID");

    source.exec("DELETE FROM accountless_enrollment_issuance WHERE singleton=1");
    assert.throws(() => assertAccountlessAuthorityTransferPreflight(source),
      error => error.code === "CUTOVER_ACCOUNTLESS_ISSUANCE_STATE_INVALID");
  } finally {
    source.close();
  }
});

test("four-source inventory keeps v1.2, analytics fences, and the erasure ledger in scope", () => {
  const primary = createInventorySource(["participants", "device_credentials", "enrollment_grants"]);
  const ingestion = createInventorySource([...v1Tables, ...v11Tables, ...v12Tables, "telemetry_v1_chunk_admission_windows"], "d1_storage_migrations");
  const analytics = createInventorySource([
    "analytics_owner_state", "analytics_source_cursors", "analytics_storage_erasure_fences",
    "analytics_storage_erasure_receipts", "analytics_community_daily_publications",
  ], "d1_storage_migrations");
  const deletionLedger = createInventorySource(["deletion_tombstones", "identity_reenrollment_cooldowns", "storage_erasure_jobs"]);
  try {
    analytics.exec("CREATE VIEW analytics_fixture_publication AS SELECT 'synthetic' AS state");
    const inventory = inventoryCutoverSources({ primary, ingestion, analytics, deletionLedger });
    assert.equal(inventory.contentFree, true);
    assert.deepEqual(inventory.missingSourceRoles, []);
    assert.equal(inventory.observedSourceFormats.v12.sourceObserved, true);
    assert.equal(inventory.observedSourceFormats.v12.observedTableCount, v12Tables.length);
    assert.equal(inventory.observedSourceFormats.v12.canonicalD1MigrationSchemaPresent, true);
    assert.equal(inventory.observedSourceFormats.v12.sourceSchemaQualifiedForTransfer, false);
    assert.equal(inventory.observedSourceFormats.v12.syntheticTypedStorageSubsetMapped, true);
    assert.equal(inventory.observedSourceFormats.v12.transferMappingImplemented, false);
    assert.equal(inventory.sourceTableCoverageCounts["untransferred-analytics-publication-or-owner-fence"], 5);
    assert.equal(inventory.sourceStores.find(store => store.role === "analytics")?.migrationLedger.table, "d1_storage_migrations");
    assert.equal(inventory.sourceStores.find(store => store.role === "analytics")?.migrationLedger.present, true);
    assert.equal(inventory.sourceStores.find(store => store.role === "ingestion")?.migrationLedger.table, "d1_storage_migrations");
    assert.equal(inventory.sourceSchemaObjectCoverageCounts.view, 1);
    assert.equal(inventory.sourceSchemaTransferImplemented, false);
    assert.ok(inventory.blockers.some(item => item.code === "CUTOVER_SOURCE_VIEWS_INDEXES_AND_TRIGGERS_NOT_TRANSFERRED" && item.count === 1));
    assert.equal(inventory.deletionLedger.sourcePresent, true);
    assert.equal(inventory.deletionLedger.requiredTablesPresent, true);
    assert.equal(inventory.deletionLedger.targetTransferImplemented, false);
    assert.ok(inventory.blockers.some(item => item.code === "CUTOVER_V12_SOURCE_PRESENT_SCHEMA_AND_TRANSFER_UNQUALIFIED"));
    assert.ok(inventory.blockers.some(item => item.code === "CUTOVER_R2_OBJECT_INVENTORY_AND_TRANSFER_MISSING"));
    assert.equal(inventory.fullCutoverReady, false);
    assert.equal(JSON.stringify(inventory).includes("fixture_id"), false);
  } finally {
    primary.close();
    ingestion.close();
    analytics.close();
    deletionLedger.close();
  }
});

test("local synthetic import resumes normalized v1.2 rows and reports remaining transfer gaps", async () => {
  const report = await runLocalSyntheticPostgresCutoverRehearsal({ extraV1Chunks: 6, v1RecordPaddingBytes: 65_000 });
  assert.equal(report.contentFree, true);
  assert.equal(report.fullCutoverReady, false);
  assert.equal(report.sourceInventory.fullCutoverReady, false);
  assert.ok(report.sourceInventory.identityAndAuthorityTablesNotTransferred.includes("participants"));
  assert.equal(report.sourceCoverage.v12, "present-but-unsupported");
  assert.equal(report.fixtureEvidence.batchMaximumRows, 256);
  assert.equal(report.fixtureEvidence.batchMaximumBytes, 4 * 1024 * 1024);
  assert.equal(report.fixtureEvidence.maximumSourceRowBytes, 8 * 1024 * 1024);
  assert.equal(report.fixtureEvidence.totalImportedSourceBytes > 64 * 1024 * 1024, true);
  assert.ok(report.fixtureEvidence.committedBatchCount > 2);
  assert.ok(report.fixtureEvidence.interruptedBatchRows > 0);
  assert.equal(report.fixtureEvidence.interruptedSourceTable, "telemetry_v12_records");
  assert.equal(report.fixtureEvidence.rolledBackSourceTable, "telemetry_v12_session_tools");
  assert.equal(report.fixtureEvidence.revokedCapabilityFailureSourceTable, "telemetry_v12_records");
  assert.equal(report.fixtureEvidence.v12RuntimeMirrorUpdateAndCheckpointRolledBack, true);
  assert.equal(report.fixtureEvidence.v12MappedTableCount, 14);
  assert.equal(report.fixtureEvidence.v12RuntimeDomainTableCount, 6);
  assert.deepEqual(report.fixtureEvidence.v12ActiveHeadAuthority, {
    sourceHeadCount: 1, targetHeadCount: 1, eligibleHeadCount: 1,
  });
  assert.deepEqual(report.fixtureEvidence.v11ManifestStates, { staged: 2 });
  assert.deepEqual(report.imported.map(item => item.targetTable), [
    "pending_objects", "telemetry_v1_device_consents", "telemetry_v11_device_consents",
    "telemetry_v11_day_manifests", "telemetry_v1_chunks", "telemetry_v1_records",
    "telemetry_v11_chunks", "telemetry_v11_records",
    "telemetry_v12_typed_runtime", "telemetry_v12_device_capabilities", "typed_telemetry_dictionary",
    "telemetry_v12_day_manifests", "telemetry_v12_chunks", "telemetry_v12_typed_attributions",
    "telemetry_v12_typed_records", "telemetry_v12_typed_usage", "telemetry_v12_typed_quota",
    "telemetry_v12_typed_session_tools", "telemetry_v12_domain_predecessors",
    "telemetry_v12_domains", "telemetry_v12_domain_days", "telemetry_v12_domain_heads",
  ]);
  assert.equal(report.imported.find(item => item.targetTable === "telemetry_v1_records").rowCount, 1201);
  assert.equal(report.imported.find(item => item.targetTable === "telemetry_v1_chunks").rowCount, 7);
  assert.equal(report.imported.find(item => item.targetTable === "pending_objects").rowCount, 11);
  assert.equal(report.imported.find(item => item.targetTable === "telemetry_v11_records").rowCount, 1);
  const expectedV12Counts = {
    typed_telemetry_dictionary: 14,
    telemetry_v12_typed_runtime: 1,
    telemetry_v12_device_capabilities: 1,
    telemetry_v12_day_manifests: 1,
    telemetry_v12_chunks: 3,
    telemetry_v12_typed_attributions: 1,
    telemetry_v12_typed_records: 3,
    telemetry_v12_typed_usage: 1,
    telemetry_v12_typed_quota: 1,
    telemetry_v12_typed_session_tools: 1,
    telemetry_v12_domain_predecessors: 1,
    telemetry_v12_domains: 1,
    telemetry_v12_domain_days: 1,
    telemetry_v12_domain_heads: 1,
  };
  for (const [table, count] of Object.entries(expectedV12Counts)) {
    const entry = report.imported.find(item => item.targetTable === table);
    assert.equal(entry?.rowCount, count, `expected ${table} count`);
    assert.match(entry?.sourceSha256 ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(entry?.destinationSha256, entry?.sourceSha256, `expected ${table} source/destination digest equality`);
  }
  assert.ok(report.imported.every(item => item.sourceSha256 === item.destinationSha256));
  assert.deepEqual(report.partiallyImportedTables, ["pending_quarantine_objects"]);
  assert.ok(report.notImported.includes("participants"));
  assert.ok(report.notImported.includes("telemetry_v11_domains"));
  assert.ok(report.notImported.includes("accountless_v12_device_authorizations"));
  assert.ok(report.sourceInventory.untransferredTables.includes("accountless_v12_device_authorizations"));
  assert.deepEqual(v12Tables.filter(table => report.sourceInventory.untransferredTables.includes(table)), [
    "accountless_v12_device_authorizations",
  ]);
  assert.ok(report.storesNotImported.includes("ledger_database"));
  assert.deepEqual(report.checks, {
    canonicalD1MigrationsApplied: true,
    localUnixSocketOnly: true,
    targetStartedEmpty: true,
    boundedStreamingAndBatchWrites: true,
    batchInsertAndCheckpointAtomic: true,
    resumedAfterCommittedBatch: true,
    failedBatchAndCheckpointRolledBack: true,
    higherTransportFloorRefusedWithoutChange: true,
    v1IdentitySequenceAdvanced: true,
    persistedReadbackMatched: true,
    repeatRefusedWithoutChange: true,
    v12RuntimeMirrorUpdateAndCheckpointRolledBack: true,
    normalizedV12TypedSubsetReadBackMatched: true,
    normalizedV12RuntimeDomainSubsetReadBackMatched: true,
    normalizedV12MappedSubsetReadBackMatched: true,
    v12RuntimeMirrorMatched: true,
    v12ActiveHeadAuthorityMatched: true,
    v12WrongStreamChildRefused: true,
    v12BrokenDictionaryReferenceRefused: true,
    v12IncompleteReadyTransitionRefused: true,
    v12RevokedAuthorityTransferRefused: true,
    productionImportNotApproved: true,
  });
  const printed = JSON.stringify(report);
  assert.equal(printed.includes("cutover-synthetic-event"), false);
  assert.equal(printed.includes("cutover-synthetic-participant"), false);
  assert.equal(printed.includes("cutover-synthetic-v1-chunk"), false);
  assert.equal(printed.includes("sourceFingerprint"), false);
});
