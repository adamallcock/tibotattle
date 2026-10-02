import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import {
  createD1AccountlessRetentionSource,
  createSyntheticAccountlessRetentionSource,
  invalidatePostgresAccountlessRetentionTransfer,
  POSTGRES_ACCOUNTLESS_RETENTION_SOURCE_MIGRATIONS,
  runPostgresAccountlessRetentionImport,
  PostgresAccountlessRetentionImportError,
} from "../scripts/postgres-accountless-retention-import.mjs";
import {
  ACCOUNTLESS_RETENTION_D1_ARTIFACT_SCHEMA,
  ACCOUNTLESS_RETENTION_D1_SOURCE_MIGRATIONS,
  accountlessRetentionD1ArtifactSha256,
  accountlessRetentionD1MappingSha256,
  accountlessRetentionD1RowSha256,
} from "../scripts/postgres-accountless-retention-artifact.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD ?? "synthetic-local-only";
const RETAINED_AT = "2026-09-25T12:00:00.123Z";
const EXPIRES_AT = "2027-09-25T12:00:00.123Z";

function uuid(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function sourceRow(index, { variant = "a", targetSuffix = "a" } = {}) {
  const sourceParticipantId = `source-participant-${variant}-${index}`;
  const sourceEnrollmentDeviceId = `source-enrollment-${variant}-${index}`;
  const sourceDeviceCredentialId = `source-credential-${variant}-${index}`;
  const sourceGenerationId = uuid(100 + index);
  const participantId = `target-participant-${targetSuffix}-${index}`;
  const enrollmentDeviceId = `target-enrollment-${targetSuffix}-${index}`;
  const deviceCredentialId = `target-credential-${targetSuffix}-${index}`;
  const generationId = uuid(200 + index);
  const secretHash = (index + 1).toString(16).padStart(2, "0").repeat(32);
  const marker = {
    participantId: sourceParticipantId,
    enrollmentDeviceId: sourceEnrollmentDeviceId,
    deviceCredentialId: sourceDeviceCredentialId,
    generationId: sourceGenerationId,
    headRevision: index + 3,
    retainedAt: RETAINED_AT,
  };
  return {
    source: {
      marker,
      participant: { id: sourceParticipantId, ownerKind: "accountless", state: "active" },
      owner: {
        participantId: sourceParticipantId,
        enrollmentDeviceId: sourceEnrollmentDeviceId,
        deviceCredentialId: sourceDeviceCredentialId,
        state: "revoked",
        revokedAt: RETAINED_AT,
        revocationReason: "user_opt_out",
        policyVersion: "accountless-opt-out-v1",
        authorizationBasis: "accountless-policy-v1",
        expiresAt: EXPIRES_AT,
      },
      ledger: {
        deviceId: sourceEnrollmentDeviceId,
        state: "revoked",
        revokedAt: RETAINED_AT,
        revocationReason: "user_opt_out",
        schemaVersion: "accountless-enrollment-v0.1",
        policyVersion: "accountless-opt-out-v1",
        authorizationBasis: "accountless-policy-v1",
        expiresAt: EXPIRES_AT,
        deviceSecretHash: secretHash,
      },
      device: {
        id: sourceDeviceCredentialId,
        participantId: sourceParticipantId,
        state: "revoked",
        authorityKind: "accountless",
        accountlessEnrollmentDeviceId: sourceEnrollmentDeviceId,
        pairedViaPairingId: null,
        socialVerifiedAt: null,
        revokedAt: RETAINED_AT,
        expiresAt: EXPIRES_AT,
        secretHash,
      },
      grant: {
        enrollmentDeviceId: sourceEnrollmentDeviceId,
        participantId: sourceParticipantId,
        deviceCredentialId: sourceDeviceCredentialId,
        state: "revoked",
        revokedAt: RETAINED_AT,
        revocationReason: "user_opt_out",
        telemetrySchemaVersion: "telemetry-contribution-v1.1",
        fieldDictionaryVersion: "telemetry-v1.1-registry-2026-08-31.1",
        privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.1",
        expiresAt: EXPIRES_AT,
      },
      head: { participantId: sourceParticipantId, generationId: sourceGenerationId, revision: index + 3 },
      domain: { id: sourceGenerationId, participantId: sourceParticipantId, deviceId: sourceDeviceCredentialId },
    },
    target: { participantId, enrollmentDeviceId, deviceCredentialId, generationId },
  };
}

function sourceRows({ count = 2, variant = "a", targetSuffix = "a" } = {}) {
  return Array.from({ length: count }, (_, index) => sourceRow(index + 1, { variant, targetSuffix }));
}

function flatD1Row(record) {
  const { marker, participant, owner, ledger, device, grant, head, domain } = record.source;
  return {
    participant_id: marker.participantId,
    marker_enrollment_device_id: marker.enrollmentDeviceId,
    marker_device_credential_id: marker.deviceCredentialId,
    marker_generation_id: marker.generationId,
    marker_head_revision: marker.headRevision,
    marker_retained_at: marker.retainedAt,
    participant_owner_kind: participant.ownerKind,
    participant_state: participant.state,
    owner_participant_id: owner.participantId,
    owner_enrollment_device_id: owner.enrollmentDeviceId,
    owner_device_credential_id: owner.deviceCredentialId,
    owner_policy_version: owner.policyVersion,
    owner_authorization_basis: owner.authorizationBasis,
    owner_expires_at: owner.expiresAt,
    owner_state: owner.state,
    owner_revoked_at: owner.revokedAt,
    owner_revocation_reason: owner.revocationReason,
    ledger_device_id: ledger.deviceId,
    ledger_device_secret_hash: ledger.deviceSecretHash,
    ledger_schema_version: ledger.schemaVersion,
    ledger_policy_version: ledger.policyVersion,
    ledger_authorization_basis: ledger.authorizationBasis,
    ledger_expires_at: ledger.expiresAt,
    ledger_state: ledger.state,
    ledger_revoked_at: ledger.revokedAt,
    ledger_revocation_reason: ledger.revocationReason,
    device_id: device.id,
    device_participant_id: device.participantId,
    device_authority_kind: device.authorityKind,
    device_enrollment_device_id: device.accountlessEnrollmentDeviceId,
    device_secret_hash: device.secretHash,
    device_paired_via_pairing_id: device.pairedViaPairingId,
    device_social_verified_at: device.socialVerifiedAt,
    device_expires_at: device.expiresAt,
    device_state: device.state,
    device_revoked_at: device.revokedAt,
    grant_enrollment_device_id: grant.enrollmentDeviceId,
    grant_participant_id: grant.participantId,
    grant_device_credential_id: grant.deviceCredentialId,
    grant_telemetry_schema_version: grant.telemetrySchemaVersion,
    grant_field_dictionary_version: grant.fieldDictionaryVersion,
    grant_privacy_contract_version: grant.privacyContractVersion,
    grant_expires_at: grant.expiresAt,
    grant_state: grant.state,
    grant_revoked_at: grant.revokedAt,
    grant_revocation_reason: grant.revocationReason,
    head_participant_id: head.participantId,
    head_generation_id: head.generationId,
    head_revision: head.revision,
    domain_id: domain.id,
    domain_participant_id: domain.participantId,
    domain_device_id: domain.deviceId,
  };
}

function d1ArtifactBundle(records) {
  const ordered = records.map(record => ({ row: flatD1Row(record), target: record.target }))
    .sort((left, right) => left.row.participant_id.localeCompare(right.row.participant_id));
  const runId = "sealed-local-retention-fixture";
  const sourceRevision = 8;
  let cursor = "";
  let manifestSha256 = createHash("sha256")
    .update(`tibotattle-accountless-retention-manifest-v1\n${runId}\n${sourceRevision}`).digest("hex");
  const pages = [];
  const mappings = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const { row, target } = ordered[index];
    const participantId = row.participant_id;
    const rowDigests = [{ participantId, sha256: accountlessRetentionD1RowSha256(row) }];
    const pageSha256 = createHash("sha256").update([
      "tibotattle-accountless-retention-page-v1", `${participantId}\0${rowDigests[0].sha256}`,
    ].join("\n")).digest("hex");
    const page = { pageNumber: index + 1, afterParticipantId: cursor, throughParticipantId: participantId,
      rowCount: 1, pageSha256, manifestSha256: "", rowDigests, rows: [row] };
    manifestSha256 = createHash("sha256").update([
      "tibotattle-accountless-retention-manifest-page-v1", manifestSha256, String(page.pageNumber),
      page.afterParticipantId, page.throughParticipantId, String(page.rowCount), page.pageSha256,
    ].join("\n")).digest("hex");
    page.manifestSha256 = manifestSha256;
    pages.push(page);
    mappings.push({ sourceParticipantId: participantId, target });
    cursor = participantId;
  }
  const artifact = {
    schemaVersion: ACCOUNTLESS_RETENTION_D1_ARTIFACT_SCHEMA,
    runId,
    state: "extracted",
    sourceRevision,
    authorityRevision: sourceRevision,
    latestMigrationName: "0063_accountless_history_transfer_source.sql",
    snapshotAt: RETAINED_AT,
    rowCount: ordered.length,
    pageCount: pages.length,
    migrationReceipts: ACCOUNTLESS_RETENTION_D1_SOURCE_MIGRATIONS.map(row => row.name),
    manifestSha256,
    pages,
  };
  return { artifact, participantMappings: mappings,
    expectedArtifactSha256: accountlessRetentionD1ArtifactSha256(artifact),
    expectedMappingSha256: accountlessRetentionD1MappingSha256(mappings) };
}

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65535);
  const link = await lstat(PG_TEST_SOCKET);
  const resolved = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(resolved);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: resolved, port: PG_TEST_PORT };
}

function interruptSecondMarkerInsert(pool) {
  let markerInsertCount = 0;
  return {
    query(...args) { return pool.query(...args); },
    async connect() {
      const client = await pool.connect();
      return {
        query(text, values) {
          if (typeof text === "string" && text.startsWith("INSERT INTO")
              && text.includes('"accountless_public_history_retention"')) {
            markerInsertCount += 1;
            if (markerInsertCount === 2) throw new Error("synthetic_page_interruption");
          }
          return client.query(text, values);
        },
        release(...args) { return client.release(...args); },
      };
    },
  };
}

async function seedTargetAuthority(pool, schema, record) {
  const target = `"${schema}"`;
  const source = record.source;
  const map = record.target;
  const retainedAt = source.marker.retainedAt;
  const expiresAt = source.owner.expiresAt;
  const secretHash = Buffer.from(source.ledger.deviceSecretHash, "hex");
  const tokenHash = createHash("sha256").update(`synthetic-token:${map.participantId}`).digest("hex");
  const digest = createHash("sha256").update(`synthetic-owner:${map.participantId}`).digest("hex");

  await pool.query(`INSERT INTO ${target}.participants(id,owner_kind,state,created_at)
    VALUES($1,'accountless','active',$2::timestamptz)`, [map.participantId, "2026-09-25T11:00:00.000Z"]);
  await pool.query(`INSERT INTO ${target}.accountless_enrollment_ledger(
    device_id,device_secret_hash,installation_principal_id,schema_version,policy_version,authorization_basis,
    state,issued_at,expires_at,revoked_at,revocation_reason
  ) VALUES($1,$2,$3,'accountless-enrollment-v0.1','accountless-opt-out-v1','accountless-policy-v1',
    'revoked',$4::timestamptz,$5::timestamptz,$6::timestamptz,'user_opt_out')`, [
    map.enrollmentDeviceId, secretHash, `synthetic-installation-${map.participantId}`,
    "2026-09-24T12:00:00.000Z", expiresAt, retainedAt,
  ]);
  await pool.query(`INSERT INTO ${target}.device_credentials(
    id,participant_id,authority_kind,paired_via_pairing_id,accountless_enrollment_device_id,
    secret_hash,state,issued_at,expires_at,last_used_at,revoked_at,social_verified_at
  ) VALUES($1,$2,'accountless',NULL,$3,$4,'revoked',$5::timestamptz,$6::timestamptz,$7::timestamptz,$7::timestamptz,NULL)`, [
    map.deviceCredentialId, map.participantId, map.enrollmentDeviceId, secretHash,
    "2026-09-24T12:00:00.000Z", expiresAt, retainedAt,
  ]);
  await pool.query(`INSERT INTO ${target}.accountless_upload_owners(
    enrollment_device_id,participant_id,device_credential_id,policy_version,authorization_basis,
    authorized_at,expires_at,state,revoked_at,revocation_reason
  ) VALUES($1,$2,$3,'accountless-opt-out-v1','accountless-policy-v1',$4::timestamptz,$5::timestamptz,
    'revoked',$6::timestamptz,'user_opt_out')`, [
    map.enrollmentDeviceId, map.participantId, map.deviceCredentialId,
    "2026-09-24T12:00:00.000Z", expiresAt, retainedAt,
  ]);
  await pool.query(`INSERT INTO ${target}.accountless_v11_device_authorizations(
    enrollment_device_id,participant_id,device_credential_id,telemetry_schema_version,
    field_dictionary_version,privacy_contract_version,authorized_at,expires_at,state,revoked_at,revocation_reason
  ) VALUES($1,$2,$3,'telemetry-contribution-v1.1','telemetry-v1.1-registry-2026-08-31.1',
    'ongoing-privacy-safe-telemetry-v1.1',$4::timestamptz,$5::timestamptz,'revoked',$6::timestamptz,'user_opt_out')`, [
    map.enrollmentDeviceId, map.participantId, map.deviceCredentialId,
    "2026-09-24T12:00:00.000Z", expiresAt, retainedAt,
  ]);
  await pool.query(`INSERT INTO ${target}.telemetry_v11_domain_predecessors(
    token_hash,participant_id,device_id,previous_generation_id,legacy_fingerprint,input_revision,
    from_day,through_day,winners_json,created_at,expires_at
  ) VALUES($1,$2,$3,NULL,$4,0,'2026-09-24','2026-09-25','[]',$5::timestamptz,$6::timestamptz)`, [
    tokenHash, map.participantId, map.deviceCredentialId, digest, "2026-09-24T12:00:00.000Z", expiresAt,
  ]);
  await pool.query(`INSERT INTO ${target}.telemetry_v11_domains(
    id,participant_id,device_id,predecessor_token_hash,previous_generation_id,manifest_digest,
    legacy_fingerprint,input_revision,from_day,through_day,days_json,created_at
  ) VALUES($1,$2,$3,$4,NULL,$5,$6,0,'2026-09-24','2026-09-25','[]',$7::timestamptz)`, [
    map.generationId, map.participantId, map.deviceCredentialId, tokenHash, digest, digest,
    "2026-09-24T12:00:00.000Z",
  ]);
  await pool.query(`INSERT INTO ${target}.telemetry_v11_domain_heads(participant_id,generation_id,revision,updated_at)
    VALUES($1,$2,$3,$4::timestamptz)`, [map.participantId, map.generationId, source.marker.headRevision, retainedAt]);
  await pool.query(`INSERT INTO ${target}.storage_v11_owner_links(
    participant_id,owner_digest,state,generation_id,head_revision,object_digest,manifest_digest
  ) VALUES($1,$2,'active',$3,$4,$5,$5)`, [
    map.participantId, digest, map.generationId, source.marker.headRevision, digest,
  ]);
}

test("synthetic source rejects non-opt-out, non-v1.1, and lossy timestamp evidence", () => {
  const base = sourceRows({ count: 1 })[0];
  assert.equal(createSyntheticAccountlessRetentionSource({ rows: [base] }).snapshot.rowCount, 1);
  for (const mutate of [
    row => { row.source.owner.revocationReason = "security_reset"; },
    row => { row.source.grant.telemetrySchemaVersion = "telemetry-contribution-v1.2"; },
    row => { row.source.owner.revokedAt = "2026-09-25T12:00:00.123456Z"; },
    row => { row.source.head.revision += 1; },
    row => { row.source.device.secretHash = "f".repeat(64); },
  ]) {
    const invalid = structuredClone(base);
    mutate(invalid);
    assert.throws(() => createSyntheticAccountlessRetentionSource({ rows: [invalid] }),
      error => error instanceof PostgresAccountlessRetentionImportError);
  }
  assert.equal(POSTGRES_ACCOUNTLESS_RETENTION_SOURCE_MIGRATIONS.length, 2);
});

test("PG17 imports the verified D1 artifact through explicit mappings under migration 43", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const socket = await localSocket();
  const suffix = randomBytes(6).toString("hex");
  const schema = `accountless_retention_import_target_${suffix}`;
  const quoted = `"${schema}"`;
  const transferId = `d1-retention-${suffix}`;
  const records = sourceRows({ count: 2 });
  const bundle = d1ArtifactBundle(records);
  const source = createD1AccountlessRetentionSource(bundle);
  const pool = new pg.Pool({ ...socket, user: PG_TEST_USER, password: PG_TEST_PASSWORD,
    database: PG_TEST_DATABASE, application_name: "pg-accountless-retention-d1-test", ssl: false,
    max: 3, connectionTimeoutMillis: 5_000 });
  let schemaCreated = false;
  try {
    const locality = await pool.query("SELECT inet_server_addr() AS address, version() AS version");
    assert.equal(locality.rows[0]?.address, null);
    assert.ok(String(locality.rows[0]?.version ?? "").startsWith("PostgreSQL 17."));
    await pool.query(`CREATE SCHEMA ${quoted}`); schemaCreated = true;
    const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
    assert.equal(applied.applied, 65);
    // The 0042/0043 permit needs 'degraded' with enrollment and publication off;
    // primary 0050 (D1 0009) makes 'degraded' a real mix and closes reason_code,
    // so processing stays on and the reason is the D1 'maintenance'.
    await pool.query(`UPDATE ${quoted}.collection_controls SET revision=revision+1,
      control_state='degraded', enrollment_enabled=false, upload_registration_enabled=false,
      processing_enabled=true, publication_enabled=false, reason_code='maintenance',
      updated_at=clock_timestamp() WHERE singleton=1`);
    for (const row of records) await seedTargetAuthority(pool, schema, row);

    const result = await runPostgresAccountlessRetentionImport({ source, destinationPool: pool,
      targetSchema: schema, transferId, pageSize: 1 });
    assert.deepEqual({ status: result.status, rows: result.rows, pages: result.pages,
      pagesWritten: result.pagesWritten, syntheticOnly: result.syntheticOnly,
      sourceFenceReconciled: result.sourceFenceReconciled, cutoverAuthorized: result.cutoverAuthorized,
      controlsRemainDegraded: result.controlsRemainDegraded,
      enrollmentRemainsDisabled: result.enrollmentRemainsDisabled,
      publicationRemainsDisabled: result.publicationRemainsDisabled }, {
      status: "d1_accountless_retention_import_complete", rows: 2, pages: 2, pagesWritten: 2,
      syntheticOnly: false, sourceFenceReconciled: false, cutoverAuthorized: false,
      controlsRemainDegraded: true, enrollmentRemainsDisabled: true, publicationRemainsDisabled: true,
    });
    const permit = await pool.query(`SELECT source_kind,target_migration_version,
      source_artifact_sha256,source_manifest_sha256,source_migration_receipts,status,source_fence_state,
      source_run_id,source_revision,source_mapping_sha256
      FROM ${quoted}.accountless_public_history_import_runs WHERE transfer_id=$1`, [transferId]);
    assert.equal(permit.rowCount, 1);
    assert.equal(permit.rows[0]?.source_kind, "cloudflare-d1-accountless-retention-snapshot-v1");
    assert.equal(permit.rows[0]?.target_migration_version, 43);
    assert.equal(permit.rows[0]?.source_artifact_sha256, bundle.expectedArtifactSha256);
    assert.equal(permit.rows[0]?.status, "complete");
    assert.equal(permit.rows[0]?.source_fence_state, "pending");
    assert.equal(permit.rows[0]?.source_run_id, bundle.artifact.runId);
    assert.equal(Number(permit.rows[0]?.source_revision), bundle.artifact.sourceRevision);
    assert.equal(permit.rows[0]?.source_mapping_sha256, bundle.expectedMappingSha256);
    assert.deepEqual(permit.rows[0]?.source_migration_receipts, ACCOUNTLESS_RETENTION_D1_SOURCE_MIGRATIONS);

    const replay = await runPostgresAccountlessRetentionImport({ source, destinationPool: pool,
      targetSchema: schema, transferId, pageSize: 1 });
    assert.equal(replay.replayed, true);
    assert.equal(replay.pagesWritten, 0);

    await assert.rejects(invalidatePostgresAccountlessRetentionTransfer({
      sourceVerifier: async snapshot => ({ state: "extracted", sourceRevision: snapshot.sourceRevision }),
      destinationPool: pool, targetSchema: schema, transferId,
    }), error => error instanceof PostgresAccountlessRetentionImportError
      && error.code === "ACCOUNTLESS_RETENTION_SOURCE_STILL_ELIGIBLE");
    await assert.rejects(invalidatePostgresAccountlessRetentionTransfer({
      sourceVerifier: async () => { throw new Error("synthetic_revalidation_read_failure"); },
      destinationPool: pool, targetSchema: schema, transferId,
    }), error => error instanceof PostgresAccountlessRetentionImportError
      && error.code === "ACCOUNTLESS_RETENTION_SOURCE_REVALIDATION_FAILED");
    const invalidated = await invalidatePostgresAccountlessRetentionTransfer({
      sourceVerifier: async () => { throw Object.assign(new Error("private detail"), {
        code: "SOURCE_MARKER_INELIGIBLE",
      }); },
      destinationPool: pool, targetSchema: schema, transferId,
    });
    assert.equal(invalidated.status, "source_fence_invalidated");
    assert.equal(invalidated.invalidationCode, "SOURCE_MARKER_INELIGIBLE");
    assert.equal(invalidated.markersDeleted, false);
    assert.equal(invalidated.replayAllowed, false);
    assert.match(invalidated.proofSha256, /^[0-9a-f]{64}$/u);
    const fenceState = await pool.query(`SELECT source_fence_state,
        (SELECT count(*)::int FROM ${quoted}.accountless_public_history_import_fence_receipts
          WHERE transfer_id=$1) AS receipts,
        (SELECT invalidation_code FROM ${quoted}.accountless_public_history_import_fence_receipts
          WHERE transfer_id=$1) AS invalidation_code,
        (SELECT count(*)::int FROM ${quoted}.accountless_public_history_retention) AS markers
      FROM ${quoted}.accountless_public_history_import_runs WHERE transfer_id=$1`, [transferId]);
    assert.deepEqual(fenceState.rows[0], {
      source_fence_state: "invalidated", receipts: 1,
      invalidation_code: "SOURCE_MARKER_INELIGIBLE", markers: 2,
    });
    const idempotentInvalidation = await invalidatePostgresAccountlessRetentionTransfer({
      sourceVerifier: async () => { throw new Error("already-invalidated transfer must not recheck"); },
      destinationPool: pool, targetSchema: schema, transferId,
    });
    assert.equal(idempotentInvalidation.proofSha256, invalidated.proofSha256);
    await assert.rejects(pool.query(`UPDATE ${quoted}.collection_controls SET revision=revision+1,
      control_state='operational',publication_enabled=true,updated_at=clock_timestamp() WHERE singleton=1`));
    await assert.rejects(runPostgresAccountlessRetentionImport({ source, destinationPool: pool,
      targetSchema: schema, transferId, pageSize: 1 }), error => error instanceof PostgresAccountlessRetentionImportError
      && error.code === "ACCOUNTLESS_RETENTION_SOURCE_FENCE_INVALIDATED");

    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${quoted}.accountless_public_history_retention`))
      .rows[0]?.count, 2);

    bundle.artifact.pages[0].rows[0].participant_state = "inactive";
    await assert.rejects(runPostgresAccountlessRetentionImport({ source, destinationPool: pool,
      targetSchema: schema, transferId, pageSize: 1 }), error => error instanceof PostgresAccountlessRetentionImportError
      && error.code === "ACCOUNTLESS_RETENTION_SOURCE_CHANGED");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${quoted}.accountless_public_history_retention`))
      .rows[0]?.count, 2, "a locally changed source file is refused and cannot alter the imported marker set");
  } finally {
    if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await pool.end();
  }
});

test("PG17 synthetic permit imports exact v1.1 retained markers in bounded replay-safe pages", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const socket = await localSocket();
  const suffix = randomBytes(6).toString("hex");
  const schema = `accountless_retention_import_target_${suffix}`;
  const quoted = `"${schema}"`;
  const transferId = `synthetic-retention-${suffix}`;
  const rows = sourceRows({ count: 2 });
  const source = createSyntheticAccountlessRetentionSource({ rows });
  const pool = new pg.Pool({
    ...socket,
    user: PG_TEST_USER,
    password: PG_TEST_PASSWORD,
    database: PG_TEST_DATABASE,
    application_name: "pg-accountless-retention-import-test",
    ssl: false,
    max: 3,
    connectionTimeoutMillis: 5_000,
  });
  let schemaCreated = false;
  try {
    const locality = await pool.query("SELECT inet_server_addr() AS address, version() AS version");
    assert.equal(locality.rows[0]?.address, null);
    assert.ok(String(locality.rows[0]?.version ?? "").startsWith("PostgreSQL 17."));
    await pool.query(`CREATE SCHEMA ${quoted}`);
    schemaCreated = true;
    const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
    assert.equal(applied.applied, 65);
    // The 0042/0043 permit needs 'degraded' with enrollment and publication off;
    // primary 0050 (D1 0009) makes 'degraded' a real mix and closes reason_code,
    // so processing stays on and the reason is the D1 'maintenance'.
    await pool.query(`UPDATE ${quoted}.collection_controls SET revision=revision+1,
      control_state='degraded', enrollment_enabled=false, upload_registration_enabled=false,
      processing_enabled=true, publication_enabled=false, reason_code='maintenance',
      updated_at=clock_timestamp() WHERE singleton=1`);
    for (const row of rows) await seedTargetAuthority(pool, schema, row);

    await assert.rejects(pool.query(`INSERT INTO ${quoted}.accountless_public_history_retention(
      participant_id,enrollment_device_id,device_credential_id,generation_id,head_revision,retained_at
    ) VALUES($1,$2,$3,$4,$5,$6::timestamptz)`, [
      rows[0].target.participantId, rows[0].target.enrollmentDeviceId, rows[0].target.deviceCredentialId,
      rows[0].target.generationId, rows[0].source.marker.headRevision, rows[0].source.marker.retainedAt,
    ]));
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${quoted}.accountless_public_history_retention`)).rows[0]?.count, 0,
      "the revoked-row marker still rejects direct inserts without the import permit");

    await assert.rejects(runPostgresAccountlessRetentionImport({
      source, destinationPool: interruptSecondMarkerInsert(pool), targetSchema: schema,
      transferId, pageSize: 1,
    }), error => error instanceof PostgresAccountlessRetentionImportError
      && error.code === "ACCOUNTLESS_RETENTION_PAGE_WRITE_FAILED");
    const interruptedState = await pool.query(`SELECT run.status,
        (SELECT count(*)::int FROM ${quoted}.accountless_public_history_retention) AS markers,
        (SELECT count(*)::int FROM ${quoted}.accountless_public_history_import_pages WHERE transfer_id=$1) AS pages,
        controls.control_state,controls.enrollment_enabled,controls.publication_enabled
      FROM ${quoted}.accountless_public_history_import_runs run
      JOIN ${quoted}.collection_controls controls ON controls.singleton=1 WHERE run.transfer_id=$1`, [transferId]);
    assert.deepEqual(interruptedState.rows[0], {
      status: "importing", markers: 1, pages: 1, control_state: "degraded",
      enrollment_enabled: false, publication_enabled: false,
    });
    await assert.rejects(pool.query(`UPDATE ${quoted}.collection_controls SET revision=revision+1,
      control_state='operational',publication_enabled=true,updated_at=clock_timestamp() WHERE singleton=1`));

    const completed = await runPostgresAccountlessRetentionImport({
      source, destinationPool: pool, targetSchema: schema, transferId, pageSize: 1,
    });
    assert.equal(completed.status, "synthetic_accountless_retention_import_complete");
    assert.equal(completed.rows, 2);
    assert.equal(completed.pages, 2, "the receipt reports the total committed page count");
    assert.equal(completed.pagesWritten, 1, "resume writes only the uncommitted second page");
    assert.equal(completed.replayed, false);
    assert.equal(completed.syntheticOnly, true);
    assert.equal(completed.cutoverAuthorized, false);
    assert.equal(completed.sourceFenceReconciled, false);
    assert.equal(completed.cursorAdvanced, false);
    assert.equal(completed.controlsRemainDegraded, true);
    assert.equal(completed.enrollmentRemainsDisabled, true);
    assert.equal(completed.publicationRemainsDisabled, true);

    const counts = await pool.query(`SELECT
      (SELECT count(*)::int FROM ${quoted}.accountless_public_history_retention) AS markers,
      (SELECT count(*)::int FROM ${quoted}.accountless_public_history_import_claims WHERE consumed_at IS NOT NULL) AS consumed,
      (SELECT count(*)::int FROM ${quoted}.accountless_public_history_import_pages WHERE transfer_id=$1) AS pages,
      (SELECT status FROM ${quoted}.accountless_public_history_import_runs WHERE transfer_id=$1) AS status,
      (SELECT control_state FROM ${quoted}.collection_controls WHERE singleton=1) AS control_state,
      (SELECT enrollment_enabled FROM ${quoted}.collection_controls WHERE singleton=1) AS enrollment_enabled,
      (SELECT publication_enabled FROM ${quoted}.collection_controls WHERE singleton=1) AS publication_enabled`, [transferId]);
    assert.deepEqual(counts.rows[0], {
      markers: 2, consumed: 2, pages: 2, status: "complete", control_state: "degraded",
      enrollment_enabled: false, publication_enabled: false,
    });

    const replay = await runPostgresAccountlessRetentionImport({
      source, destinationPool: pool, targetSchema: schema, transferId, pageSize: 1,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.pages, 2);
    assert.equal(replay.pagesWritten, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${quoted}.accountless_public_history_retention`)).rows[0]?.count, 2);

    const changedSource = createSyntheticAccountlessRetentionSource({ rows: sourceRows({ count: 2, variant: "changed" }) });
    await assert.rejects(runPostgresAccountlessRetentionImport({
      source: changedSource, destinationPool: pool, targetSchema: schema, transferId, pageSize: 1,
    }), error => error instanceof PostgresAccountlessRetentionImportError
      && error.code === "ACCOUNTLESS_RETENTION_TRANSFER_ID_CONFLICT");

    const terminalParticipant = rows[0].target.participantId;
    await pool.query(`DELETE FROM ${quoted}.accountless_public_history_retention WHERE participant_id=$1`, [terminalParticipant]);
    const link = await pool.query(`SELECT state FROM ${quoted}.storage_v11_owner_links WHERE participant_id=$1`, [terminalParticipant]);
    assert.equal(link.rows[0]?.state, "withdrawn", "retention deletion withdraws membership as terminal containment");
    await assert.rejects(runPostgresAccountlessRetentionImport({
      source, destinationPool: pool, targetSchema: schema, transferId, pageSize: 1,
    }), error => error instanceof PostgresAccountlessRetentionImportError
      && error.code === "ACCOUNTLESS_RETENTION_DESTINATION_MISMATCH");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${quoted}.accountless_public_history_retention WHERE participant_id=$1`,
      [terminalParticipant])).rows[0]?.count, 0, "a completed replay cannot resurrect a terminally removed marker");
  } finally {
    if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await pool.end();
  }
});
