import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createSyntheticAccountlessRetentionSource,
  POSTGRES_ACCOUNTLESS_RETENTION_IMPORT_DEFAULT_PAGE_SIZE,
  POSTGRES_ACCOUNTLESS_RETENTION_IMPORT_MAX_PAGE_SIZE,
  POSTGRES_ACCOUNTLESS_RETENTION_SOURCE_MIGRATIONS,
  PostgresAccountlessRetentionImportError,
  runPostgresAccountlessRetentionImport,
} from "./postgres-accountless-retention-import.mjs";

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
    && error.code === "ACCOUNTLESS_RETENTION_SYNTHETIC_SOURCE_REQUIRED");

  const trusted = createSyntheticAccountlessRetentionSource({ rows: [one] });
  await assert.rejects(runPostgresAccountlessRetentionImport({ source: trusted, destinationPool: pool,
    targetSchema: "public", transferId: "synthetic-run" }), {
    code: "ACCOUNTLESS_RETENTION_TARGET_SCHEMA_INVALID",
  });
  await assert.rejects(runPostgresAccountlessRetentionImport({ source: trusted, destinationPool: pool,
    targetSchema: "accountless_retention_import_target_12345678", transferId: "synthetic-run", pageSize: 501 }), {
    code: "ACCOUNTLESS_RETENTION_PAGE_SIZE_INVALID",
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
