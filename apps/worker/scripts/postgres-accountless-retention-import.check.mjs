import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createD1AccountlessRetentionSource,
  createD1AccountlessRetentionFileSource,
  createSyntheticAccountlessRetentionSource,
  cleanupStaleAccountlessRetentionTempDirs,
  invalidatePostgresAccountlessRetentionTransfer,
  POSTGRES_ACCOUNTLESS_RETENTION_IMPORT_DEFAULT_PAGE_SIZE,
  POSTGRES_ACCOUNTLESS_RETENTION_IMPORT_MAX_PAGE_SIZE,
  POSTGRES_ACCOUNTLESS_RETENTION_SOURCE_MIGRATIONS,
  PostgresAccountlessRetentionImportError,
  runPostgresAccountlessRetentionImport,
} from "./postgres-accountless-retention-import.mjs";
import {
  ACCOUNTLESS_RETENTION_D1_ARTIFACT_SCHEMA,
  ACCOUNTLESS_RETENTION_D1_SOURCE_MIGRATIONS,
  accountlessRetentionD1ArtifactSha256,
  accountlessRetentionD1MappingSha256,
  accountlessRetentionD1RowSha256,
} from "./postgres-accountless-retention-artifact.mjs";

const WORKER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validRow(participantId, targetParticipantId, generationId, targetGenerationId) {
  const retainedAt = "2026-09-25T12:00:00.123Z";
  const expiresAt = "2027-09-25T12:00:00.123Z";
  const enrollmentDeviceId = `source-enrollment-${participantId}`;
  const deviceCredentialId = `source-credential-${participantId}`;
  const secretHash = "ab".repeat(32);
  return {
    source: {
      marker: { participantId, enrollmentDeviceId, deviceCredentialId, generationId, headRevision: 3, retainedAt },
      participant: { id: participantId, ownerKind: "accountless", state: "active" },
      owner: { participantId, enrollmentDeviceId, deviceCredentialId, state: "revoked", revokedAt: retainedAt,
        revocationReason: "user_opt_out", policyVersion: "accountless-opt-out-v1",
        authorizationBasis: "accountless-policy-v1", expiresAt },
      ledger: { deviceId: enrollmentDeviceId, state: "revoked", revokedAt: retainedAt,
        revocationReason: "user_opt_out", schemaVersion: "accountless-enrollment-v0.1",
        policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1",
        expiresAt, deviceSecretHash: secretHash },
      device: { id: deviceCredentialId, participantId, state: "revoked", authorityKind: "accountless",
        accountlessEnrollmentDeviceId: enrollmentDeviceId, pairedViaPairingId: null, socialVerifiedAt: null,
        revokedAt: retainedAt, expiresAt, secretHash },
      grant: { enrollmentDeviceId, participantId, deviceCredentialId, state: "revoked", revokedAt: retainedAt,
        revocationReason: "user_opt_out", telemetrySchemaVersion: "telemetry-contribution-v1.1",
        fieldDictionaryVersion: "telemetry-v1.1-registry-2026-08-31.1",
        privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.1", expiresAt },
      head: { participantId, generationId, revision: 3 },
      domain: { id: generationId, participantId, deviceId: deviceCredentialId },
    },
    target: { participantId: targetParticipantId, enrollmentDeviceId: `target-enrollment-${participantId}`,
      deviceCredentialId: `target-credential-${participantId}`, generationId: targetGenerationId },
  };
}

const one = validRow("source-owner-a", "target-owner-a", "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222");
const two = validRow("source-owner-b", "target-owner-b", "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444");

function flatD1Row(row) {
  const { marker, participant, owner, ledger, device, grant, head, domain } = row.source;
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

function d1ArtifactBundle(rows) {
  const ordered = rows.map(row => ({ row: flatD1Row(row), target: row.target }))
    .sort((left, right) => left.row.participant_id.localeCompare(right.row.participant_id));
  const runId = "sealed-local-retention-fixture";
  const sourceRevision = 8;
  let cursor = "";
  let manifestSha256 = digest(Buffer.from(`tibotattle-accountless-retention-manifest-v1\n${runId}\n${sourceRevision}`));
  const pages = [];
  const mappings = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const { row, target } = ordered[index];
    const participantId = row.participant_id;
    const rowDigests = [{ participantId, sha256: accountlessRetentionD1RowSha256(row) }];
    const pageSha256 = digest(Buffer.from([
      "tibotattle-accountless-retention-page-v1",
      `${participantId}\0${rowDigests[0].sha256}`,
    ].join("\n")));
    const page = {
      pageNumber: index + 1,
      afterParticipantId: cursor,
      throughParticipantId: participantId,
      rowCount: 1,
      pageSha256,
      manifestSha256: "",
      rowDigests,
      rows: [row],
    };
    manifestSha256 = digest(Buffer.from([
      "tibotattle-accountless-retention-manifest-page-v1",
      manifestSha256,
      String(page.pageNumber),
      page.afterParticipantId,
      page.throughParticipantId,
      String(page.rowCount),
      page.pageSha256,
    ].join("\n")));
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
    snapshotAt: "2026-09-25T12:00:00.123Z",
    rowCount: ordered.length,
    pageCount: pages.length,
    migrationReceipts: ACCOUNTLESS_RETENTION_D1_SOURCE_MIGRATIONS.map(row => row.name),
    manifestSha256,
    pages,
  };
  return {
    artifact,
    mappings,
    participantMappings: mappings,
    expectedArtifactSha256: accountlessRetentionD1ArtifactSha256(artifact),
    expectedMappingSha256: accountlessRetentionD1MappingSha256(mappings),
  };
}

test("sealed D1 artifact bridge verifies the source fence, row/page chain, and explicit mapping", async () => {
  const bundle = d1ArtifactBundle([two, one]);
  const source = createD1AccountlessRetentionSource(bundle);
  assert.equal(source.snapshot.kind, "cloudflare-d1-accountless-retention-snapshot-v1");
  assert.equal(source.snapshot.sourceRevision, 8);
  assert.equal(source.snapshot.sourceFenceReconciled, false);
  assert.equal(source.snapshot.rowCount, 2);
  assert.equal(source.snapshot.migrationReceipts.length, 3);
  await source.verifySnapshot();
  const firstPage = await source.listPage({ after: null, limit: 1 });
  assert.equal(firstPage.rows[0].source.marker.participantId, "source-owner-a");
  assert.equal(firstPage.rows[0].target.participantId, "target-owner-a");
  assert.equal((await source.listPage({ after: "source-owner-a", limit: 1 })).rows[0].target.participantId,
    "target-owner-b");

  const remapped = structuredClone(bundle.mappings);
  remapped[0].target.participantId = "target-owner-remapped";
  const remappedSource = createD1AccountlessRetentionSource({ ...bundle, participantMappings: remapped,
    expectedMappingSha256: accountlessRetentionD1MappingSha256(remapped) });
  assert.notEqual(remappedSource.snapshot.fenceId, source.snapshot.fenceId,
    "the transfer fence binds the explicit target mapping digest");
  assert.throws(() => createD1AccountlessRetentionSource({ ...bundle, expectedArtifactSha256: "0".repeat(64) }), {
    code: "ACCOUNTLESS_RETENTION_ARTIFACT_CHECKSUM_MISMATCH",
  });
  assert.throws(() => createD1AccountlessRetentionSource({ ...bundle, participantMappings: bundle.mappings.slice(1),
    expectedMappingSha256: accountlessRetentionD1MappingSha256(bundle.mappings.slice(1)) }), {
    code: "ACCOUNTLESS_RETENTION_SOURCE_MAPPING_INCOMPLETE",
  });
  const changed = structuredClone(bundle.artifact);
  changed.authorityRevision += 1;
  assert.throws(() => createD1AccountlessRetentionSource({ ...bundle, artifact: changed,
    expectedArtifactSha256: accountlessRetentionD1ArtifactSha256(changed) }), {
    code: "ACCOUNTLESS_RETENTION_SOURCE_FENCE_INVALID",
  });
});

async function writeD1BundleFiles(bundle) {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-retention-check-"));
  const artifactPath = join(directory, "artifact.json");
  const participantMappingsPath = join(directory, "participant-mappings.json");
  await writeFile(artifactPath, JSON.stringify(bundle.artifact));
  await writeFile(participantMappingsPath, JSON.stringify(bundle.mappings));
  return { directory, artifactPath, participantMappingsPath };
}

function fileSourceOptions(files, bundle, overrides = {}) {
  return {
    artifactPath: files.artifactPath,
    participantMappingsPath: files.participantMappingsPath,
    expectedArtifactSha256: bundle.expectedArtifactSha256,
    expectedMappingSha256: bundle.expectedMappingSha256,
    temporaryRoot: files.directory,
    ...overrides,
  };
}

async function createOwnedTempFixture(root, { pid = process.pid, withMappedRows = false } = {}) {
  const directoryPath = await mkdtemp(join(root, "tibotattle-retention-source-"));
  const owner = {
    schemaVersion: "tibotattle-accountless-retention-temp-owner-v1",
    directoryName: basename(directoryPath),
    pid,
    runId: randomUUID(),
    createdAt: Date.now(),
  };
  await writeFile(join(directoryPath, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
  if (withMappedRows) await writeFile(join(directoryPath, "mapped-rows.ndjson"), "{}\n", { mode: 0o600 });
  return directoryPath;
}

test("file-backed D1 source preserves the exact fence and streams bounded keyset pages", async () => {
  const bundle = d1ArtifactBundle([two, one]);
  const files = await writeD1BundleFiles(bundle);
  let source;
  try {
    await assert.rejects(createD1AccountlessRetentionFileSource({
      ...fileSourceOptions(files, bundle, { expectedArtifactSha256: "0".repeat(64) }),
    }), { code: "ACCOUNTLESS_RETENTION_ARTIFACT_CHECKSUM_MISMATCH" });
    source = await createD1AccountlessRetentionFileSource(fileSourceOptions(files, bundle));
    const objectSource = createD1AccountlessRetentionSource(bundle);
    assert.deepEqual(source.snapshot, objectSource.snapshot);
    assert.equal((await source.verifySnapshot()).fenceId, objectSource.snapshot.fenceId);
    const first = await source.listPage({ after: null, limit: 1 });
    assert.deepEqual(first, await objectSource.listPage({ after: null, limit: 1 }));
    const second = await source.listPage({ after: "source-owner-a", limit: 1 });
    assert.deepEqual(second, await objectSource.listPage({ after: "source-owner-a", limit: 1 }));
    assert.deepEqual(await source.listPage({ after: "source-owner-b", limit: 1 }), { rows: [] });

    await writeFile(files.artifactPath, "changed after the private verified copy was staged");
    assert.equal((await source.verifySnapshot()).artifactSha256, bundle.expectedArtifactSha256);
    assert.equal((await source.listPage({ after: null, limit: 2 })).rows.length, 2);
  } finally {
    await source?.close();
    await rm(files.directory, { recursive: true, force: true });
  }
});

test("file-backed D1 source has no total-row cap and rejects duplicate target identities", async () => {
  const rows = Array.from({ length: 601 }, (_, index) => {
    const suffix = String(index).padStart(8, "0");
    return validRow(`source-owner-${suffix}`, `target-owner-${suffix}`,
      `${suffix}-1111-4111-8111-111111111111`, `${suffix}-2222-4222-8222-222222222222`);
  });
  const bundle = d1ArtifactBundle(rows);
  const files = await writeD1BundleFiles(bundle);
  let source;
  try {
    source = await createD1AccountlessRetentionFileSource({
      ...fileSourceOptions(files, bundle),
    });
    assert.equal(source.snapshot.rowCount, 601);
    const first = await source.listPage({ after: null, limit: 500 });
    const second = await source.listPage({ after: first.rows.at(-1).source.marker.participantId, limit: 500 });
    assert.equal(first.rows.length, 500);
    assert.equal(second.rows.length, 101);
    assert.equal(second.rows.at(-1).source.marker.participantId, "source-owner-00000600");
    assert.deepEqual(await source.listPage({ after: "source-owner-00000600", limit: 500 }), { rows: [] });
  } finally {
    await source?.close();
    await rm(files.directory, { recursive: true, force: true });
  }

  const duplicateMappings = structuredClone(bundle.mappings);
  duplicateMappings.at(-1).target.participantId = duplicateMappings[0].target.participantId;
  const invalid = { ...bundle, mappings: duplicateMappings,
    expectedMappingSha256: accountlessRetentionD1MappingSha256(duplicateMappings) };
  const invalidFiles = await writeD1BundleFiles(invalid);
  try {
    await assert.rejects(createD1AccountlessRetentionFileSource({
      ...fileSourceOptions(invalidFiles, invalid, { maxTargetKeyBufferBytes: 1_024 }),
    }), { code: "ACCOUNTLESS_RETENTION_SOURCE_MAPPING_INVALID" });
  } finally {
    await rm(invalidFiles.directory, { recursive: true, force: true });
  }
});

test("file-backed D1 source verifies and pages an empty sealed snapshot", async () => {
  const bundle = d1ArtifactBundle([]);
  const files = await writeD1BundleFiles(bundle);
  let source;
  try {
    source = await createD1AccountlessRetentionFileSource({
      ...fileSourceOptions(files, bundle),
    });
    assert.equal(source.snapshot.rowCount, 0);
    await source.verifySnapshot();
    assert.deepEqual(await source.listPage({ after: null, limit: 200 }), { rows: [] });
  } finally {
    await source?.close();
    await rm(files.directory, { recursive: true, force: true });
  }
});

test("file-backed D1 source rejects excessive aggregate metadata before accumulating it", async () => {
  const base = d1ArtifactBundle([one]);
  const excessiveKeys = structuredClone(base.artifact);
  excessiveKeys.operatorNote = "unexpected";
  const keyBundle = { ...base, artifact: excessiveKeys,
    expectedArtifactSha256: accountlessRetentionD1ArtifactSha256(excessiveKeys) };
  const keyFiles = await writeD1BundleFiles(keyBundle);
  try {
    await assert.rejects(createD1AccountlessRetentionFileSource(fileSourceOptions(keyFiles, keyBundle)), {
      code: "ACCOUNTLESS_RETENTION_ARTIFACT_METADATA_TOO_LARGE",
    });
  } finally {
    await rm(keyFiles.directory, { recursive: true, force: true });
  }

  const excessiveBytes = structuredClone(base.artifact);
  excessiveBytes.latestMigrationName = "m".repeat(750_000);
  excessiveBytes.snapshotAt = "s".repeat(750_000);
  excessiveBytes.migrationReceipts = ["a".repeat(300_000), "b".repeat(300_000), "c".repeat(300_000)];
  const byteBundle = { ...base, artifact: excessiveBytes,
    expectedArtifactSha256: accountlessRetentionD1ArtifactSha256(excessiveBytes) };
  const byteFiles = await writeD1BundleFiles(byteBundle);
  try {
    await assert.rejects(createD1AccountlessRetentionFileSource(fileSourceOptions(byteFiles, byteBundle)), {
      code: "ACCOUNTLESS_RETENTION_ARTIFACT_METADATA_TOO_LARGE",
    });
  } finally {
    await rm(byteFiles.directory, { recursive: true, force: true });
  }
});

test("file-backed D1 source abort removes private staged files", async () => {
  const bundle = d1ArtifactBundle([one]);
  const files = await writeD1BundleFiles(bundle);
  const controller = new AbortController();
  let source;
  try {
    source = await createD1AccountlessRetentionFileSource(fileSourceOptions(files, bundle, {
      signal: controller.signal,
    }));
    const sourceTempDirs = () => readdir(files.directory)
      .then(entries => entries.filter(entry => entry.startsWith("tibotattle-retention-source-")));
    assert.equal((await sourceTempDirs()).length, 1);
    controller.abort();
    await assert.rejects(source.listPage({ after: null, limit: 10 }), {
      code: "ACCOUNTLESS_RETENTION_IMPORT_ABORTED",
    });
    await source.close();
    assert.deepEqual(await sourceTempDirs(), []);
  } finally {
    await source?.close();
    await rm(files.directory, { recursive: true, force: true });
  }
});

test("temp recovery removes only dead, journaled private runs and fails closed on ambiguity", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-retention-recovery-check-"));
  try {
    let deadPid;
    for (const candidate of [2_147_483_647, 2_000_000_000, 1_000_000_000]) {
      try { process.kill(candidate, 0); } catch (error) {
        if (error?.code === "ESRCH") { deadPid = candidate; break; }
        if (error?.code !== "EPERM") throw error;
      }
    }
    assert.ok(deadPid, "test host must expose an ESRCH PID for the stale-run fixture");
    const stale = await createOwnedTempFixture(root, { pid: deadPid, withMappedRows: true });
    const active = await createOwnedTempFixture(root, { pid: process.pid });
    assert.deepEqual(await cleanupStaleAccountlessRetentionTempDirs({ directory: root }), {
      removed: 1, active: 1, unjournaledRecent: 0,
    });
    await assert.rejects(lstat(stale), { code: "ENOENT" });
    assert.equal((await lstat(active)).isDirectory(), true);

    const ambiguous = await mkdtemp(join(root, "tibotattle-retention-source-"));
    const old = new Date(Date.now() - 120_000);
    await utimes(ambiguous, old, old);
    await assert.rejects(cleanupStaleAccountlessRetentionTempDirs({ directory: root }), {
      code: "ACCOUNTLESS_RETENTION_TEMP_RECOVERY_AMBIGUOUS",
    });
    assert.equal((await lstat(ambiguous)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic retention fixture pins exact D1 opt-out migration receipts", async () => {
  assert.equal(POSTGRES_ACCOUNTLESS_RETENTION_SOURCE_MIGRATIONS.length, 2);
  for (const receipt of POSTGRES_ACCOUNTLESS_RETENTION_SOURCE_MIGRATIONS) {
    const path = receipt.role === "primary"
      ? join(WORKER_ROOT, "migrations", receipt.name)
      : join(WORKER_ROOT, "ingestion-isolation-migrations", receipt.name);
    assert.equal(digest(await readFile(path)), receipt.sha256);
  }
});

test("synthetic source is explicit, sorted, and keyset paged within the hard bound", async () => {
  const source = createSyntheticAccountlessRetentionSource({ rows: [two, one] });
  assert.equal(source.snapshot.rowCount, 2);
  assert.equal(source.snapshot.kind, "synthetic-accountless-retention-fixture-v1");
  assert.equal(source.snapshot.immutable, true);
  assert.equal((await source.verifySnapshot()).manifestSha256, source.snapshot.manifestSha256);
  assert.deepEqual((await source.listPage({ after: null, limit: 1 })).rows.map(row => row.source.marker.participantId),
    ["source-owner-a"]);
  assert.deepEqual((await source.listPage({ after: "source-owner-a", limit: 1 })).rows
    .map(row => row.source.marker.participantId), ["source-owner-b"]);
  assert.deepEqual((await source.listPage({ after: "source-owner-b", limit: 1 })).rows, []);
  assert.equal(POSTGRES_ACCOUNTLESS_RETENTION_IMPORT_DEFAULT_PAGE_SIZE, 200);
  assert.equal(POSTGRES_ACCOUNTLESS_RETENTION_IMPORT_MAX_PAGE_SIZE, 500);
  await assert.rejects(source.listPage({ after: null, limit: 501 }), {
    code: "ACCOUNTLESS_RETENTION_PAGE_REQUEST_INVALID",
  });
});

test("retention importer refuses forged sources and broad/unbounded targets before any database call", async () => {
  let databaseCalls = 0;
  const pool = {
    async connect() { databaseCalls += 1; throw new Error("unexpected database access"); },
    async query() { databaseCalls += 1; throw new Error("unexpected database access"); },
  };
  const forged = {
    snapshot: { kind: "synthetic-accountless-retention-fixture-v1", immutable: true,
      artifactSha256: "a".repeat(64), manifestSha256: "b".repeat(64),
      snapshotId: `synthetic-retention:${"a".repeat(64)}`, fenceId: `synthetic-fence:${"a".repeat(64)}`,
      rowCount: 0, migrationReceipts: [] },
    async verifySnapshot() { return this.snapshot; },
    async listPage() { return { rows: [] }; },
  };
  await assert.rejects(runPostgresAccountlessRetentionImport({ source: forged, destinationPool: pool,
    targetSchema: "accountless_retention_import_target_12345678", transferId: "synthetic-run" }),
  error => error instanceof PostgresAccountlessRetentionImportError
    && error.code === "ACCOUNTLESS_RETENTION_TRUSTED_SOURCE_REQUIRED");

  const trusted = createSyntheticAccountlessRetentionSource({ rows: [one] });
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(runPostgresAccountlessRetentionImport({ source: trusted, destinationPool: pool,
    targetSchema: "accountless_retention_import_target_12345678", transferId: "synthetic-run",
    signal: cancelled.signal }), { code: "ACCOUNTLESS_RETENTION_IMPORT_ABORTED" });
  await assert.rejects(runPostgresAccountlessRetentionImport({ source: trusted, destinationPool: pool,
    targetSchema: "public", transferId: "synthetic-run" }), {
    code: "ACCOUNTLESS_RETENTION_TARGET_SCHEMA_INVALID",
  });
  await assert.rejects(runPostgresAccountlessRetentionImport({ source: trusted, destinationPool: pool,
    targetSchema: "accountless_retention_import_target_12345678", transferId: "synthetic-run", pageSize: 501 }), {
    code: "ACCOUNTLESS_RETENTION_PAGE_SIZE_INVALID",
  });
  await assert.rejects(invalidatePostgresAccountlessRetentionTransfer({ destinationPool: pool,
    targetSchema: "accountless_retention_import_target_12345678", transferId: "synthetic-run" }), {
    code: "ACCOUNTLESS_RETENTION_SOURCE_REVALIDATION_REQUIRED",
  });
  assert.equal(databaseCalls, 0);
});

test("source mapping is one-to-one and rejects any v1.2 or terminal/partial authority row", () => {
  assert.throws(() => createSyntheticAccountlessRetentionSource({ rows: [one, { ...two,
    target: { ...two.target, participantId: one.target.participantId } }] }), {
    code: "ACCOUNTLESS_RETENTION_SOURCE_MAPPING_INVALID",
  });
  const v12 = structuredClone(one);
  v12.source.grant.telemetrySchemaVersion = "telemetry-contribution-v1.2";
  assert.throws(() => createSyntheticAccountlessRetentionSource({ rows: [v12] }), {
    code: "ACCOUNTLESS_RETENTION_SOURCE_AUTHORITY_MISMATCH",
  });
  const terminal = structuredClone(one);
  terminal.source.owner.revocationReason = "security_reset";
  assert.throws(() => createSyntheticAccountlessRetentionSource({ rows: [terminal] }), {
    code: "ACCOUNTLESS_RETENTION_SOURCE_AUTHORITY_MISMATCH",
  });
});
