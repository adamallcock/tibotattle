import { createHash } from "node:crypto";

export const ACCOUNTLESS_RETENTION_D1_ARTIFACT_SCHEMA = "tibotattle-accountless-retention-source-artifact-v1";
export const ACCOUNTLESS_RETENTION_D1_SOURCE_KIND = "cloudflare-d1-accountless-retention-snapshot-v1";

export const ACCOUNTLESS_RETENTION_D1_SOURCE_MIGRATIONS = Object.freeze([
  Object.freeze({
    role: "source-d1",
    version: 61,
    name: "0061_accountless_history_retention.sql",
    sha256: "0d6d9d23390770aab5c2cb9b1bbb27586ed72b9921a420468efb05ee225435d6",
  }),
  Object.freeze({
    role: "source-d1",
    version: 62,
    name: "0062_v1_acquisition_vocabulary.sql",
    sha256: "50efab3fcea61ea4a425c4a88c57364a35bd2095d8bb748acebf5bff228df66b",
  }),
  Object.freeze({
    role: "source-d1",
    version: 63,
    name: "0063_accountless_history_transfer_source.sql",
    sha256: "a94009e8624f9aa042073f39104dba8626a2785646db0c417d9728b75d618339",
  }),
]);

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/u;
const SAFE_GENERATION = /^[A-Za-z0-9._:-]{36}$/u;
const CANONICAL_UTC_MILLIS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u;
const BLOB_FIELDS = new Set(["ledger_device_secret_hash", "device_secret_hash"]);
const INTEGER_FIELDS = new Set(["marker_head_revision", "head_revision"]);

export const ACCOUNTLESS_RETENTION_D1_ROW_FIELDS = Object.freeze([
  "participant_id",
  "marker_enrollment_device_id",
  "marker_device_credential_id",
  "marker_generation_id",
  "marker_head_revision",
  "marker_retained_at",
  "participant_owner_kind",
  "participant_state",
  "owner_participant_id",
  "owner_enrollment_device_id",
  "owner_device_credential_id",
  "owner_policy_version",
  "owner_authorization_basis",
  "owner_expires_at",
  "owner_state",
  "owner_revoked_at",
  "owner_revocation_reason",
  "ledger_device_id",
  "ledger_device_secret_hash",
  "ledger_schema_version",
  "ledger_policy_version",
  "ledger_authorization_basis",
  "ledger_expires_at",
  "ledger_state",
  "ledger_revoked_at",
  "ledger_revocation_reason",
  "device_id",
  "device_participant_id",
  "device_authority_kind",
  "device_enrollment_device_id",
  "device_secret_hash",
  "device_paired_via_pairing_id",
  "device_social_verified_at",
  "device_expires_at",
  "device_state",
  "device_revoked_at",
  "grant_enrollment_device_id",
  "grant_participant_id",
  "grant_device_credential_id",
  "grant_telemetry_schema_version",
  "grant_field_dictionary_version",
  "grant_privacy_contract_version",
  "grant_expires_at",
  "grant_state",
  "grant_revoked_at",
  "grant_revocation_reason",
  "head_participant_id",
  "head_generation_id",
  "head_revision",
  "domain_id",
  "domain_participant_id",
  "domain_device_id",
]);

function artifactFailure(code) {
  throw Object.assign(new Error(code), { code });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) artifactFailure("ACCOUNTLESS_RETENTION_ARTIFACT_INVALID");
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    artifactFailure("ACCOUNTLESS_RETENTION_ARTIFACT_INVALID");
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    if (!isRecord(value)) artifactFailure("ACCOUNTLESS_RETENTION_ARTIFACT_INVALID");
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireHash(value, code = "ACCOUNTLESS_RETENTION_ARTIFACT_INVALID") {
  if (typeof value !== "string" || !SHA256.test(value)) artifactFailure(code);
  return value;
}

function requireIdentifier(value, code = "ACCOUNTLESS_RETENTION_ARTIFACT_INVALID") {
  if (typeof value !== "string" || !SAFE_ID.test(value)) artifactFailure(code);
  return value;
}

function requireTimestamp(value) {
  if (typeof value !== "string" || !CANONICAL_UTC_MILLIS.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    artifactFailure("ACCOUNTLESS_RETENTION_ARTIFACT_INVALID");
  }
  return value;
}

function requireGeneration(value) {
  if (typeof value !== "string" || !SAFE_GENERATION.test(value)) {
    artifactFailure("ACCOUNTLESS_RETENTION_ARTIFACT_INVALID");
  }
  return value;
}

function normalizeD1Row(value) {
  exactKeys(value, ACCOUNTLESS_RETENTION_D1_ROW_FIELDS);
  const row = {};
  for (const field of ACCOUNTLESS_RETENTION_D1_ROW_FIELDS) {
    const cell = value[field];
    if (BLOB_FIELDS.has(field)) {
      if (typeof cell !== "string" || !/^[0-9a-f]{64}$/u.test(cell)) {
        artifactFailure("ACCOUNTLESS_RETENTION_ARTIFACT_INVALID");
      }
    } else if (INTEGER_FIELDS.has(field)) {
      if (!Number.isSafeInteger(cell) || cell < 0) artifactFailure("ACCOUNTLESS_RETENTION_ARTIFACT_INVALID");
    } else if (cell !== null && typeof cell !== "string") {
      artifactFailure("ACCOUNTLESS_RETENTION_ARTIFACT_INVALID");
    }
    row[field] = cell;
  }
  requireIdentifier(row.participant_id);
  requireIdentifier(row.marker_enrollment_device_id);
  requireIdentifier(row.marker_device_credential_id);
  requireGeneration(row.marker_generation_id);
  requireTimestamp(row.marker_retained_at);
  return Object.freeze(row);
}

/** Recompute the source module's typed-row digest from its JSON wire form. */
export function accountlessRetentionD1RowSha256(value) {
  const row = normalizeD1Row(value);
  const ordered = ACCOUNTLESS_RETENTION_D1_ROW_FIELDS.map(field => {
    const cell = row[field];
    if (cell === null) return [field, ["null", ""]];
    if (BLOB_FIELDS.has(field)) return [field, ["blob-hex", cell]];
    if (INTEGER_FIELDS.has(field)) return [field, ["integer", String(cell)]];
    return [field, ["text", cell]];
  });
  return sha256(`tibotattle-accountless-retention-row-v1\n${JSON.stringify(ordered)}`);
}

/** Digest the canonical artifact object (the separate expected SHA is the trust anchor). */
export function accountlessRetentionD1ArtifactSha256(artifact) {
  return sha256(canonical(artifact));
}

/** Digest a canonical, ordered explicit source-to-target mapping array. */
export function accountlessRetentionD1MappingSha256(mappings) {
  return sha256(canonical(mappings));
}

function pageDigest(rowDigests) {
  return sha256([
    "tibotattle-accountless-retention-page-v1",
    ...rowDigests.map(({ participantId, sha256: digest }) => `${participantId}\0${digest}`),
  ].join("\n"));
}

function manifestSeed(runId, sourceRevision) {
  return sha256(`tibotattle-accountless-retention-manifest-v1\n${runId}\n${sourceRevision}`);
}

function manifestStep(prior, page) {
  return sha256([
    "tibotattle-accountless-retention-manifest-page-v1",
    prior,
    String(page.pageNumber),
    page.afterParticipantId,
    page.throughParticipantId,
    String(page.rowCount),
    page.pageSha256,
  ].join("\n"));
}

function normalizeMapping(value) {
  exactKeys(value, ["sourceParticipantId", "target"]);
  exactKeys(value.target, ["participantId", "enrollmentDeviceId", "deviceCredentialId", "generationId"]);
  return Object.freeze({
    sourceParticipantId: requireIdentifier(value.sourceParticipantId),
    target: Object.freeze({
      participantId: requireIdentifier(value.target.participantId),
      enrollmentDeviceId: requireIdentifier(value.target.enrollmentDeviceId),
      deviceCredentialId: requireIdentifier(value.target.deviceCredentialId),
      generationId: requireGeneration(value.target.generationId),
    }),
  });
}

function mappedRow(row, target) {
  return {
    source: {
      marker: {
        participantId: row.participant_id,
        enrollmentDeviceId: row.marker_enrollment_device_id,
        deviceCredentialId: row.marker_device_credential_id,
        generationId: row.marker_generation_id,
        headRevision: row.marker_head_revision,
        retainedAt: row.marker_retained_at,
      },
      participant: {
        id: row.participant_id,
        ownerKind: row.participant_owner_kind,
        state: row.participant_state,
      },
      owner: {
        participantId: row.owner_participant_id,
        enrollmentDeviceId: row.owner_enrollment_device_id,
        deviceCredentialId: row.owner_device_credential_id,
        state: row.owner_state,
        revokedAt: row.owner_revoked_at,
        revocationReason: row.owner_revocation_reason,
        policyVersion: row.owner_policy_version,
        authorizationBasis: row.owner_authorization_basis,
        expiresAt: row.owner_expires_at,
      },
      ledger: {
        deviceId: row.ledger_device_id,
        state: row.ledger_state,
        revokedAt: row.ledger_revoked_at,
        revocationReason: row.ledger_revocation_reason,
        schemaVersion: row.ledger_schema_version,
        policyVersion: row.ledger_policy_version,
        authorizationBasis: row.ledger_authorization_basis,
        expiresAt: row.ledger_expires_at,
        deviceSecretHash: row.ledger_device_secret_hash,
      },
      device: {
        id: row.device_id,
        participantId: row.device_participant_id,
        state: row.device_state,
        authorityKind: row.device_authority_kind,
        accountlessEnrollmentDeviceId: row.device_enrollment_device_id,
        pairedViaPairingId: row.device_paired_via_pairing_id,
        socialVerifiedAt: row.device_social_verified_at,
        revokedAt: row.device_revoked_at,
        expiresAt: row.device_expires_at,
        secretHash: row.device_secret_hash,
      },
      grant: {
        enrollmentDeviceId: row.grant_enrollment_device_id,
        participantId: row.grant_participant_id,
        deviceCredentialId: row.grant_device_credential_id,
        state: row.grant_state,
        revokedAt: row.grant_revoked_at,
        revocationReason: row.grant_revocation_reason,
        telemetrySchemaVersion: row.grant_telemetry_schema_version,
        fieldDictionaryVersion: row.grant_field_dictionary_version,
        privacyContractVersion: row.grant_privacy_contract_version,
        expiresAt: row.grant_expires_at,
      },
      head: {
        participantId: row.head_participant_id,
        generationId: row.head_generation_id,
        revision: row.head_revision,
      },
      domain: {
        id: row.domain_id,
        participantId: row.domain_participant_id,
        deviceId: row.domain_device_id,
      },
    },
    target: {
      participantId: target.participantId,
      enrollmentDeviceId: target.enrollmentDeviceId,
      deviceCredentialId: target.deviceCredentialId,
      generationId: target.generationId,
    },
  };
}

function canonicalMigrationNames(value) {
  if (!Array.isArray(value) || value.length !== ACCOUNTLESS_RETENTION_D1_SOURCE_MIGRATIONS.length
      || value.some((name, index) => name !== ACCOUNTLESS_RETENTION_D1_SOURCE_MIGRATIONS[index]?.name)) {
    artifactFailure("ACCOUNTLESS_RETENTION_SOURCE_MIGRATION_MISMATCH");
  }
  return ACCOUNTLESS_RETENTION_D1_SOURCE_MIGRATIONS;
}

/** Validate the sealed D1 JSON artifact and a separate complete mapping file. */
export function verifyAccountlessRetentionD1ArtifactBundle({
  artifact,
  participantMappings,
  expectedArtifactSha256,
  expectedMappingSha256,
} = {}) {
  requireHash(expectedArtifactSha256, "ACCOUNTLESS_RETENTION_ARTIFACT_CHECKSUM_REQUIRED");
  requireHash(expectedMappingSha256, "ACCOUNTLESS_RETENTION_MAPPING_CHECKSUM_REQUIRED");
  exactKeys(artifact, [
    "schemaVersion", "runId", "state", "sourceRevision", "authorityRevision", "latestMigrationName",
    "snapshotAt", "rowCount", "pageCount", "migrationReceipts", "manifestSha256", "pages",
  ]);
  if (artifact.schemaVersion !== ACCOUNTLESS_RETENTION_D1_ARTIFACT_SCHEMA
      || typeof artifact.runId !== "string" || !SAFE_RUN_ID.test(artifact.runId)
      || artifact.state !== "extracted"
      || !Number.isSafeInteger(artifact.sourceRevision) || artifact.sourceRevision < 0
      || artifact.authorityRevision !== artifact.sourceRevision
      || artifact.latestMigrationName !== "0063_accountless_history_transfer_source.sql"
      || !Number.isSafeInteger(artifact.rowCount) || artifact.rowCount < 0
      || !Number.isSafeInteger(artifact.pageCount) || artifact.pageCount < 0
      || !Array.isArray(artifact.pages)
      || artifact.pages.length !== artifact.pageCount) {
    artifactFailure("ACCOUNTLESS_RETENTION_SOURCE_FENCE_INVALID");
  }
  requireTimestamp(artifact.snapshotAt);
  requireHash(artifact.manifestSha256);
  const artifactSha256 = accountlessRetentionD1ArtifactSha256(artifact);
  if (artifactSha256 !== expectedArtifactSha256) artifactFailure("ACCOUNTLESS_RETENTION_ARTIFACT_CHECKSUM_MISMATCH");
  const migrationReceipts = canonicalMigrationNames(artifact.migrationReceipts);

  let cursor = "";
  let seenRows = 0;
  let manifest = manifestSeed(artifact.runId, artifact.sourceRevision);
  const flatRows = [];
  for (let index = 0; index < artifact.pages.length; index += 1) {
    const page = artifact.pages[index];
    exactKeys(page, ["pageNumber", "afterParticipantId", "throughParticipantId", "rowCount", "pageSha256", "manifestSha256", "rowDigests", "rows"]);
    if (page.pageNumber !== index + 1 || page.afterParticipantId !== cursor
        || !Number.isSafeInteger(page.rowCount) || page.rowCount < 1 || page.rowCount > 500
        || !Array.isArray(page.rows) || page.rows.length !== page.rowCount
        || !Array.isArray(page.rowDigests) || page.rowDigests.length !== page.rowCount) {
      artifactFailure("ACCOUNTLESS_RETENTION_SOURCE_PAGE_INVALID");
    }
    requireHash(page.pageSha256);
    requireHash(page.manifestSha256);
    const normalizedRows = page.rows.map(normalizeD1Row);
    const rowDigests = page.rowDigests.map((entry, rowIndex) => {
      exactKeys(entry, ["participantId", "sha256"]);
      const participantId = requireIdentifier(entry.participantId);
      const digest = requireHash(entry.sha256);
      const row = normalizedRows[rowIndex];
      if (!row || participantId !== row.participant_id || digest !== accountlessRetentionD1RowSha256(row)) {
        artifactFailure("ACCOUNTLESS_RETENTION_SOURCE_ROW_CHECKSUM_MISMATCH");
      }
      if (rowIndex > 0 && participantId <= normalizedRows[rowIndex - 1].participant_id) {
        artifactFailure("ACCOUNTLESS_RETENTION_SOURCE_ORDER_INVALID");
      }
      return Object.freeze({ participantId, sha256: digest });
    });
    if (page.throughParticipantId !== rowDigests.at(-1)?.participantId
        || rowDigests[0]?.participantId <= cursor
        || page.pageSha256 !== pageDigest(rowDigests)) {
      artifactFailure("ACCOUNTLESS_RETENTION_SOURCE_PAGE_CHECKSUM_MISMATCH");
    }
    manifest = manifestStep(manifest, page);
    if (manifest !== page.manifestSha256) artifactFailure("ACCOUNTLESS_RETENTION_SOURCE_MANIFEST_MISMATCH");
    flatRows.push(...normalizedRows);
    cursor = page.throughParticipantId;
    seenRows += page.rowCount;
  }
  if (seenRows !== artifact.rowCount || manifest !== artifact.manifestSha256
      || artifact.rowCount === 0 && artifact.pageCount !== 0
      || artifact.rowCount > 0 && artifact.pageCount === 0) {
    artifactFailure("ACCOUNTLESS_RETENTION_SOURCE_COUNT_MISMATCH");
  }

  if (!Array.isArray(participantMappings) || participantMappings.length !== flatRows.length) {
    artifactFailure("ACCOUNTLESS_RETENTION_SOURCE_MAPPING_INCOMPLETE");
  }
  const mappings = participantMappings.map(normalizeMapping);
  const mappingSha256 = accountlessRetentionD1MappingSha256(mappings);
  if (mappingSha256 !== expectedMappingSha256) artifactFailure("ACCOUNTLESS_RETENTION_MAPPING_CHECKSUM_MISMATCH");
  const sourceIds = new Set();
  const targetParticipants = new Set();
  const targetDevices = new Set();
  const targetCredentials = new Set();
  const mappedRows = flatRows.map((row, index) => {
    const mapping = mappings[index];
    if (!mapping || mapping.sourceParticipantId !== row.participant_id
        || sourceIds.has(mapping.sourceParticipantId)
        || targetParticipants.has(mapping.target.participantId)
        || targetDevices.has(mapping.target.enrollmentDeviceId)
        || targetCredentials.has(mapping.target.deviceCredentialId)) {
      artifactFailure("ACCOUNTLESS_RETENTION_SOURCE_MAPPING_INVALID");
    }
    sourceIds.add(mapping.sourceParticipantId);
    targetParticipants.add(mapping.target.participantId);
    targetDevices.add(mapping.target.enrollmentDeviceId);
    targetCredentials.add(mapping.target.deviceCredentialId);
    return mappedRow(row, mapping.target);
  });

  const fenceDigest = sha256([
    "tibotattle-accountless-retention-d1-fence-v1",
    artifact.runId,
    String(artifact.sourceRevision),
    artifact.manifestSha256,
    artifactSha256,
    mappingSha256,
  ].join("\n"));
  const snapshot = Object.freeze({
    kind: ACCOUNTLESS_RETENTION_D1_SOURCE_KIND,
    immutable: true,
    snapshotId: `d1-accountless-retention:${artifactSha256}`,
    fenceId: `d1-retention-fence:${fenceDigest}`,
    artifactSha256,
    manifestSha256: artifact.manifestSha256,
    rowCount: artifact.rowCount,
    sourceRevision: artifact.sourceRevision,
    sourceRunId: artifact.runId,
    mappingSha256,
    migrationReceipts,
    sourceFenceReconciled: false,
  });
  return Object.freeze({
    snapshot,
    rows: Object.freeze(mappedRows.map(row => {
      if (row && typeof row === "object") {
        for (const value of Object.values(row)) {
          if (value && typeof value === "object") Object.freeze(value);
        }
        Object.freeze(row);
      }
      return row;
    })),
    verifyDigests() {
      if (accountlessRetentionD1ArtifactSha256(artifact) !== artifactSha256
          || accountlessRetentionD1MappingSha256(mappings) !== mappingSha256) {
        artifactFailure("ACCOUNTLESS_RETENTION_SOURCE_CHANGED");
      }
    },
  });
}
