import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream, createWriteStream, fstat } from "node:fs";
import { lstat, mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { buildPostgresMigrationManifest, renderPostgresSearchPath } from "../cloud-run/postgres-migrations.mjs";
import {
  ACCOUNTLESS_RETENTION_D1_SOURCE_KIND,
  ACCOUNTLESS_RETENTION_D1_SOURCE_MIGRATIONS,
  verifyAccountlessRetentionD1ArtifactFiles,
  verifyAccountlessRetentionD1ArtifactBundle,
} from "./postgres-accountless-retention-artifact.mjs";

export const POSTGRES_ACCOUNTLESS_RETENTION_IMPORT_SCHEMA = "accountless-public-history-retention-import-v1";
export const POSTGRES_ACCOUNTLESS_RETENTION_IMPORT_DEFAULT_PAGE_SIZE = 200;
export const POSTGRES_ACCOUNTLESS_RETENTION_IMPORT_MAX_PAGE_SIZE = 500;
export const POSTGRES_ACCOUNTLESS_RETENTION_TARGET_SCHEMA_PREFIX = "accountless_retention_import_target_";

const SOURCE_KIND = "synthetic-retention-fixture-v1";
const LEGACY_MIGRATION_VERSION = 42;
const MIGRATION_VERSION = 43;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const SAFE_TRANSFER_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const SAFE_SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/u;
const TARGET_SCHEMA = /^accountless_retention_import_target_[a-f0-9]{8,}$/u;
const ACCOUNTLESS_RETENTION_TEMP_PREFIX = "tibotattle-retention-source-";
const ACCOUNTLESS_RETENTION_TEMP_OWNER_SCHEMA = "tibotattle-accountless-retention-temp-owner-v1";
const ACCOUNTLESS_RETENTION_TEMP_OWNER_FILE = "owner.json";
const ACCOUNTLESS_RETENTION_TEMP_ALLOWED_FILES = new Set([
  ACCOUNTLESS_RETENTION_TEMP_OWNER_FILE,
  "artifact.json",
  "participant-mappings.json",
  "artifact-pages.ndjson",
  "mapped-rows.ndjson",
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DEFAULT_TARGET_KEY_BUFFER_BYTES = 4 * 1_024 * 1_024;
const MIN_TARGET_KEY_BUFFER_BYTES = 1 * 1_024;
const TRUSTED_SOURCES = new WeakSet();
const SOURCE_INVALIDATION_CODES = new Set([
  "SOURCE_MIGRATION_RECEIPT_MISMATCH",
  "SOURCE_MARKER_INELIGIBLE",
  "SOURCE_AUTHORITY_REVISION_CHANGED",
  "SOURCE_SNAPSHOT_ABORTED",
  "SOURCE_SNAPSHOT_INVALIDATED",
]);

export const POSTGRES_ACCOUNTLESS_RETENTION_SOURCE_MIGRATIONS = Object.freeze([
  Object.freeze({
    role: "primary",
    version: 61,
    name: "0061_accountless_history_retention.sql",
    sha256: "0d6d9d23390770aab5c2cb9b1bbb27586ed72b9921a420468efb05ee225435d6",
  }),
  Object.freeze({
    role: "ingestion-isolation",
    version: 5,
    name: "0005_opt_out_retains_history.sql",
    sha256: "17e4d02f0fa738b1d6fb9389af1ee4a49a69e22837728568884bdb3212777747",
  }),
]);

export class PostgresAccountlessRetentionImportError extends Error {
  constructor(code) {
    super(code);
    this.name = "PostgresAccountlessRetentionImportError";
    this.code = code;
  }
}

function fail(code) {
  throw new PostgresAccountlessRetentionImportError(code);
}

function throwIfAborted(signal) {
  if (signal?.aborted) fail("ACCOUNTLESS_RETENTION_IMPORT_ABORTED");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function recoveryAmbiguous() {
  fail("ACCOUNTLESS_RETENTION_TEMP_RECOVERY_AMBIGUOUS");
}

function assertPrivateOwnedFile(info) {
  if (!info.isFile() || (info.mode & 0o077) !== 0
      || info.nlink !== 1
      || typeof process.getuid === "function" && info.uid !== process.getuid()) {
    recoveryAmbiguous();
  }
}

async function readTempOwner(directoryPath) {
  const ownerPath = join(directoryPath, ACCOUNTLESS_RETENTION_TEMP_OWNER_FILE);
  let info;
  try {
    info = await lstat(ownerPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    recoveryAmbiguous();
  }
  assertPrivateOwnedFile(info);
  if (info.size > 1_024) recoveryAmbiguous();
  let owner;
  try {
    owner = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch {
    recoveryAmbiguous();
  }
  const expectedKeys = ["schemaVersion", "directoryName", "pid", "runId", "createdAt"].sort();
  if (!owner || typeof owner !== "object" || Array.isArray(owner)
      || Object.keys(owner).sort().some((key, index) => key !== expectedKeys[index])
      || Object.keys(owner).length !== expectedKeys.length
      || owner.schemaVersion !== ACCOUNTLESS_RETENTION_TEMP_OWNER_SCHEMA
      || owner.directoryName !== basename(directoryPath)
      || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.pid > 0x7fffffff
      || typeof owner.runId !== "string" || !UUID_V4.test(owner.runId)
      || !Number.isSafeInteger(owner.createdAt) || owner.createdAt < 0) {
    recoveryAmbiguous();
  }
  const afterRead = await lstat(ownerPath).catch(() => recoveryAmbiguous());
  assertPrivateOwnedFile(afterRead);
  if (afterRead.dev !== info.dev || afterRead.ino !== info.ino || afterRead.size !== info.size
      || afterRead.mtimeMs !== info.mtimeMs || afterRead.ctimeMs !== info.ctimeMs) recoveryAmbiguous();
  return owner;
}

async function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    recoveryAmbiguous();
  }
}

async function assertKnownTempContents(directoryPath) {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    recoveryAmbiguous();
  }
  for (const entry of entries) {
    const known = ACCOUNTLESS_RETENTION_TEMP_ALLOWED_FILES.has(entry.name)
      || /^target-key-(?:run|merge)-\d+\.ndjson$/u.test(entry.name);
    if (!known || !entry.isFile()) recoveryAmbiguous();
    let info;
    try {
      info = await lstat(join(directoryPath, entry.name));
    } catch {
      recoveryAmbiguous();
    }
    assertPrivateOwnedFile(info);
  }
}

async function writeTempOwner(directoryPath) {
  const owner = {
    schemaVersion: ACCOUNTLESS_RETENTION_TEMP_OWNER_SCHEMA,
    directoryName: basename(directoryPath),
    pid: process.pid,
    runId: randomUUID(),
    createdAt: Date.now(),
  };
  let handle;
  try {
    handle = await open(join(directoryPath, ACCOUNTLESS_RETENTION_TEMP_OWNER_FILE), "wx", 0o600);
    await writeHandle(handle, JSON.stringify(owner));
    await handle.sync();
  } catch {
    fail("ACCOUNTLESS_RETENTION_TEMP_STORAGE_FAILED");
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Remove only private, journaled source-temp directories whose owner PID is gone. */
export async function cleanupStaleAccountlessRetentionTempDirs({ directory = tmpdir(), signal } = {}) {
  throwIfAborted(signal);
  let rootInfo;
  try {
    rootInfo = await lstat(directory);
  } catch {
    fail("ACCOUNTLESS_RETENTION_TEMP_RECOVERY_FAILED");
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
      || typeof process.getuid === "function" && rootInfo.uid !== process.getuid()) recoveryAmbiguous();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    fail("ACCOUNTLESS_RETENTION_TEMP_RECOVERY_FAILED");
  }
  let removed = 0;
  let active = 0;
  let unjournaledRecent = 0;
  for (const entry of entries) {
    throwIfAborted(signal);
    if (!entry.name.startsWith(ACCOUNTLESS_RETENTION_TEMP_PREFIX)) continue;
    const directoryPath = join(directory, entry.name);
    let info;
    try {
      info = await lstat(directoryPath);
    } catch {
      recoveryAmbiguous();
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
        || typeof process.getuid === "function" && info.uid !== process.getuid()) {
      recoveryAmbiguous();
    }
    const owner = await readTempOwner(directoryPath);
    if (owner === null) {
      if (Date.now() - info.mtimeMs < 60_000) {
        unjournaledRecent += 1;
        continue;
      }
      recoveryAmbiguous();
    }
    if (await processIsAlive(owner.pid)) {
      active += 1;
      continue;
    }
    await assertKnownTempContents(directoryPath);
    throwIfAborted(signal);
    const confirmedOwner = await readTempOwner(directoryPath);
    if (canonical(confirmedOwner) !== canonical(owner) || await processIsAlive(owner.pid)) {
      recoveryAmbiguous();
    }
    const confirmedDirectory = await lstat(directoryPath).catch(() => recoveryAmbiguous());
    if (!confirmedDirectory.isDirectory() || confirmedDirectory.isSymbolicLink()
        || confirmedDirectory.dev !== info.dev || confirmedDirectory.ino !== info.ino
        || confirmedDirectory.uid !== info.uid || (confirmedDirectory.mode & 0o077) !== 0) {
      recoveryAmbiguous();
    }
    try {
      await rm(directoryPath, { recursive: true, force: false });
    } catch {
      recoveryAmbiguous();
    }
    removed += 1;
  }
  return Object.freeze({ removed, active, unjournaledRecent });
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertExactKeys(value, expected) {
  if (!isRecord(value)) fail("ACCOUNTLESS_RETENTION_SOURCE_ROW_INVALID");
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    fail("ACCOUNTLESS_RETENTION_SOURCE_ROW_INVALID");
  }
}

function assertId(value) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail("ACCOUNTLESS_RETENTION_SOURCE_ROW_INVALID");
  return value;
}

function assertGeneration(value) {
  if (typeof value !== "string" || value.length !== 36 || !/^[A-Za-z0-9._:-]{36}$/u.test(value)) {
    fail("ACCOUNTLESS_RETENTION_SOURCE_ROW_INVALID");
  }
  return value;
}

function assertTimestamp(value) {
  if (typeof value !== "string"
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("ACCOUNTLESS_RETENTION_SOURCE_TIMESTAMP_INVALID");
  }
  return value;
}

function assertHash(value) {
  if (typeof value !== "string" || !SHA256.test(value)) fail("ACCOUNTLESS_RETENTION_SOURCE_ROW_INVALID");
  return value;
}

function same(left, right) {
  if (left !== right) fail("ACCOUNTLESS_RETENTION_SOURCE_AUTHORITY_MISMATCH");
}

function normalizeSourceRow(value) {
  const rootKeys = ["source", "target"];
  const sourceKeys = ["marker", "participant", "owner", "ledger", "device", "grant", "head", "domain"];
  assertExactKeys(value, rootKeys);
  assertExactKeys(value.source, sourceKeys);
  assertExactKeys(value.target, ["participantId", "enrollmentDeviceId", "deviceCredentialId", "generationId"]);
  assertExactKeys(value.source.marker, [
    "participantId", "enrollmentDeviceId", "deviceCredentialId", "generationId", "headRevision", "retainedAt",
  ]);
  assertExactKeys(value.source.participant, ["id", "ownerKind", "state"]);
  assertExactKeys(value.source.owner, [
    "participantId", "enrollmentDeviceId", "deviceCredentialId", "state", "revokedAt", "revocationReason",
    "policyVersion", "authorizationBasis", "expiresAt",
  ]);
  assertExactKeys(value.source.ledger, [
    "deviceId", "state", "revokedAt", "revocationReason", "schemaVersion", "policyVersion",
    "authorizationBasis", "expiresAt", "deviceSecretHash",
  ]);
  assertExactKeys(value.source.device, [
    "id", "participantId", "state", "authorityKind", "accountlessEnrollmentDeviceId", "pairedViaPairingId",
    "socialVerifiedAt", "revokedAt", "expiresAt", "secretHash",
  ]);
  assertExactKeys(value.source.grant, [
    "enrollmentDeviceId", "participantId", "deviceCredentialId", "state", "revokedAt", "revocationReason",
    "telemetrySchemaVersion", "fieldDictionaryVersion", "privacyContractVersion", "expiresAt",
  ]);
  assertExactKeys(value.source.head, ["participantId", "generationId", "revision"]);
  assertExactKeys(value.source.domain, ["id", "participantId", "deviceId"]);

  const source = value.source;
  const marker = source.marker;
  const result = {
    source: {
      marker: {
        participantId: assertId(marker.participantId),
        enrollmentDeviceId: assertId(marker.enrollmentDeviceId),
        deviceCredentialId: assertId(marker.deviceCredentialId),
        generationId: assertGeneration(marker.generationId),
        headRevision: marker.headRevision,
        retainedAt: assertTimestamp(marker.retainedAt),
      },
      participant: {
        id: assertId(source.participant.id),
        ownerKind: source.participant.ownerKind,
        state: source.participant.state,
      },
      owner: {
        participantId: assertId(source.owner.participantId),
        enrollmentDeviceId: assertId(source.owner.enrollmentDeviceId),
        deviceCredentialId: assertId(source.owner.deviceCredentialId),
        state: source.owner.state,
        revokedAt: assertTimestamp(source.owner.revokedAt),
        revocationReason: source.owner.revocationReason,
        policyVersion: source.owner.policyVersion,
        authorizationBasis: source.owner.authorizationBasis,
        expiresAt: assertTimestamp(source.owner.expiresAt),
      },
      ledger: {
        deviceId: assertId(source.ledger.deviceId),
        state: source.ledger.state,
        revokedAt: assertTimestamp(source.ledger.revokedAt),
        revocationReason: source.ledger.revocationReason,
        schemaVersion: source.ledger.schemaVersion,
        policyVersion: source.ledger.policyVersion,
        authorizationBasis: source.ledger.authorizationBasis,
        expiresAt: assertTimestamp(source.ledger.expiresAt),
        deviceSecretHash: assertHash(source.ledger.deviceSecretHash),
      },
      device: {
        id: assertId(source.device.id),
        participantId: assertId(source.device.participantId),
        state: source.device.state,
        authorityKind: source.device.authorityKind,
        accountlessEnrollmentDeviceId: assertId(source.device.accountlessEnrollmentDeviceId),
        pairedViaPairingId: source.device.pairedViaPairingId,
        socialVerifiedAt: source.device.socialVerifiedAt,
        revokedAt: assertTimestamp(source.device.revokedAt),
        expiresAt: assertTimestamp(source.device.expiresAt),
        secretHash: assertHash(source.device.secretHash),
      },
      grant: {
        enrollmentDeviceId: assertId(source.grant.enrollmentDeviceId),
        participantId: assertId(source.grant.participantId),
        deviceCredentialId: assertId(source.grant.deviceCredentialId),
        state: source.grant.state,
        revokedAt: assertTimestamp(source.grant.revokedAt),
        revocationReason: source.grant.revocationReason,
        telemetrySchemaVersion: source.grant.telemetrySchemaVersion,
        fieldDictionaryVersion: source.grant.fieldDictionaryVersion,
        privacyContractVersion: source.grant.privacyContractVersion,
        expiresAt: assertTimestamp(source.grant.expiresAt),
      },
      head: {
        participantId: assertId(source.head.participantId),
        generationId: assertGeneration(source.head.generationId),
        revision: source.head.revision,
      },
      domain: {
        id: assertGeneration(source.domain.id),
        participantId: assertId(source.domain.participantId),
        deviceId: assertId(source.domain.deviceId),
      },
    },
    target: {
      participantId: assertId(value.target.participantId),
      enrollmentDeviceId: assertId(value.target.enrollmentDeviceId),
      deviceCredentialId: assertId(value.target.deviceCredentialId),
      generationId: assertGeneration(value.target.generationId),
    },
  };

  const { marker: normalizedMarker, participant, owner, ledger, device, grant, head, domain } = result.source;
  if (!Number.isSafeInteger(normalizedMarker.headRevision) || normalizedMarker.headRevision < 1
      || !Number.isSafeInteger(head.revision) || head.revision < 1) {
    fail("ACCOUNTLESS_RETENTION_SOURCE_ROW_INVALID");
  }
  same(participant.id, normalizedMarker.participantId);
  same(participant.ownerKind, "accountless");
  same(participant.state, "active");
  same(owner.participantId, normalizedMarker.participantId);
  same(owner.enrollmentDeviceId, normalizedMarker.enrollmentDeviceId);
  same(owner.deviceCredentialId, normalizedMarker.deviceCredentialId);
  same(owner.state, "revoked");
  same(owner.revocationReason, "user_opt_out");
  same(owner.policyVersion, "accountless-opt-out-v1");
  same(owner.authorizationBasis, "accountless-policy-v1");
  same(owner.revokedAt, normalizedMarker.retainedAt);
  same(ledger.deviceId, normalizedMarker.enrollmentDeviceId);
  same(ledger.state, "revoked");
  same(ledger.revocationReason, "user_opt_out");
  same(ledger.schemaVersion, "accountless-enrollment-v0.1");
  same(ledger.policyVersion, "accountless-opt-out-v1");
  same(ledger.authorizationBasis, "accountless-policy-v1");
  same(ledger.revokedAt, normalizedMarker.retainedAt);
  same(device.id, normalizedMarker.deviceCredentialId);
  same(device.participantId, normalizedMarker.participantId);
  same(device.state, "revoked");
  same(device.authorityKind, "accountless");
  same(device.accountlessEnrollmentDeviceId, normalizedMarker.enrollmentDeviceId);
  same(device.pairedViaPairingId, null);
  same(device.socialVerifiedAt, null);
  same(device.revokedAt, normalizedMarker.retainedAt);
  same(device.secretHash, ledger.deviceSecretHash);
  same(grant.enrollmentDeviceId, normalizedMarker.enrollmentDeviceId);
  same(grant.participantId, normalizedMarker.participantId);
  same(grant.deviceCredentialId, normalizedMarker.deviceCredentialId);
  same(grant.state, "revoked");
  same(grant.revocationReason, "user_opt_out");
  same(grant.telemetrySchemaVersion, "telemetry-contribution-v1.1");
  same(grant.fieldDictionaryVersion, "telemetry-v1.1-registry-2026-08-31.1");
  same(grant.privacyContractVersion, "ongoing-privacy-safe-telemetry-v1.1");
  same(grant.revokedAt, normalizedMarker.retainedAt);
  same(head.participantId, normalizedMarker.participantId);
  same(head.generationId, normalizedMarker.generationId);
  same(head.revision, normalizedMarker.headRevision);
  same(domain.id, normalizedMarker.generationId);
  same(domain.participantId, normalizedMarker.participantId);
  same(domain.deviceId, normalizedMarker.deviceCredentialId);
  for (const expiresAt of [owner.expiresAt, ledger.expiresAt, device.expiresAt, grant.expiresAt]) {
    same(expiresAt, owner.expiresAt);
  }
  same(ledger.deviceSecretHash, device.secretHash);
  return deepFreeze(result);
}

function sourceRowDigest(row) {
  return sha256(canonical(row));
}

function sourceManifestDigest(rows) {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(canonical(row)).update("\n");
  return hash.digest("hex");
}

function snapshotDescriptor(rows) {
  const manifestSha256 = sourceManifestDigest(rows);
  const artifactSha256 = sha256(`synthetic-accountless-retention-fixture-v1\n${rows.length}\n${manifestSha256}`);
  return Object.freeze({
    kind: "synthetic-accountless-retention-fixture-v1",
    immutable: true,
    snapshotId: `synthetic-retention:${artifactSha256}`,
    fenceId: `synthetic-fence:${artifactSha256}`,
    artifactSha256,
    manifestSha256,
    rowCount: rows.length,
    migrationReceipts: POSTGRES_ACCOUNTLESS_RETENTION_SOURCE_MIGRATIONS,
  });
}

function createPagedSource({ snapshot, rows, verify }) {
  const frozenRows = deepFreeze([...rows]);
  const source = Object.freeze({
    snapshot,
    async verifySnapshot() {
      await verify();
      return snapshot;
    },
    async listPage({ after = null, limit } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > POSTGRES_ACCOUNTLESS_RETENTION_IMPORT_MAX_PAGE_SIZE
          || after !== null && (typeof after !== "string" || !SAFE_ID.test(after))) {
        fail("ACCOUNTLESS_RETENTION_PAGE_REQUEST_INVALID");
      }
      let low = 0;
      let high = frozenRows.length;
      if (after !== null) {
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (frozenRows[middle].source.marker.participantId <= after) low = middle + 1;
          else high = middle;
        }
      }
      return Object.freeze({ rows: Object.freeze(frozenRows.slice(low, low + limit)) });
    },
  });
  TRUSTED_SOURCES.add(source);
  return source;
}

/**
 * Synthetic-only source seam for local PG17 exercises. It is deliberately not
 * a D1 adapter or a source snapshot/fence implementation.
 */
export function createSyntheticAccountlessRetentionSource({ rows } = {}) {
  if (!Array.isArray(rows) || rows.length > Number.MAX_SAFE_INTEGER) {
    fail("ACCOUNTLESS_RETENTION_SYNTHETIC_SOURCE_INVALID");
  }
  const normalized = rows.map(normalizeSourceRow)
    .sort((left, right) => left.source.marker.participantId.localeCompare(right.source.marker.participantId));
  const sourceParticipants = new Set();
  const targetParticipants = new Set();
  const targetDevices = new Set();
  const targetCredentials = new Set();
  for (const row of normalized) {
    const sourceId = row.source.marker.participantId;
    if (sourceParticipants.has(sourceId) || targetParticipants.has(row.target.participantId)
        || targetDevices.has(row.target.enrollmentDeviceId)
        || targetCredentials.has(row.target.deviceCredentialId)) {
      fail("ACCOUNTLESS_RETENTION_SOURCE_MAPPING_INVALID");
    }
    sourceParticipants.add(sourceId);
    targetParticipants.add(row.target.participantId);
    targetDevices.add(row.target.enrollmentDeviceId);
    targetCredentials.add(row.target.deviceCredentialId);
  }
  const frozenRows = deepFreeze(normalized);
  const snapshot = snapshotDescriptor(frozenRows);
  return createPagedSource({
    snapshot,
    rows: frozenRows,
    async verify() {
      if (sourceManifestDigest(frozenRows) !== snapshot.manifestSha256) {
        fail("ACCOUNTLESS_RETENTION_SOURCE_CHANGED");
      }
    },
  });
}

/**
 * Turn a sealed D1 0063 artifact and an explicit target mapping into the
 * PostgreSQL importer's trusted source interface. Both artifact digests must be
 * supplied independently by the operator; their values are never logged.
 */
export function createD1AccountlessRetentionSource({
  artifact,
  participantMappings,
  expectedArtifactSha256,
  expectedMappingSha256,
} = {}) {
  let verified;
  try {
    verified = verifyAccountlessRetentionD1ArtifactBundle({
      artifact,
      participantMappings,
      expectedArtifactSha256,
      expectedMappingSha256,
    });
  } catch (error) {
    if (error && typeof error === "object" && typeof error.code === "string") fail(error.code);
    fail("ACCOUNTLESS_RETENTION_ARTIFACT_INVALID");
  }
  const rows = deepFreeze(verified.rows.map(normalizeSourceRow));
  if (rows.length !== verified.snapshot.rowCount) fail("ACCOUNTLESS_RETENTION_SOURCE_COUNT_MISMATCH");
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index - 1].source.marker.participantId >= rows[index].source.marker.participantId) {
      fail("ACCOUNTLESS_RETENTION_SOURCE_ORDER_INVALID");
    }
  }
  return createPagedSource({
    snapshot: verified.snapshot,
    rows,
    verify() {
      try {
        verified.verifyDigests();
      } catch (error) {
        if (error && typeof error === "object" && typeof error.code === "string") fail(error.code);
        fail("ACCOUNTLESS_RETENTION_SOURCE_CHANGED");
      }
    },
  });
}

async function fileFingerprint(path) {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile()) fail("ACCOUNTLESS_RETENTION_SOURCE_CHANGED");
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].join(":");
}

async function writeHandle(handle, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, null);
    if (result.bytesWritten <= 0) fail("ACCOUNTLESS_RETENTION_TEMP_FILE_WRITE_FAILED");
    offset += result.bytesWritten;
  }
}

async function stageRegularFile(sourcePath, destinationPath, signal) {
  throwIfAborted(signal);
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    fail("ACCOUNTLESS_RETENTION_INPUT_FILE_INVALID");
  }
  let before;
  let input;
  let destination;
  try {
    before = await lstat(sourcePath);
    if (!before.isFile() || before.isSymbolicLink()) fail("ACCOUNTLESS_RETENTION_INPUT_FILE_INVALID");
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    input = createReadStream(sourcePath, { flags: fsConstants.O_RDONLY | noFollow });
    const opened = await new Promise((resolve, reject) => {
      input.once("open", descriptor => fstat(descriptor, (error, info) => error ? reject(error) : resolve(info)));
      input.once("error", reject);
    });
    throwIfAborted(signal);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail("ACCOUNTLESS_RETENTION_INPUT_FILE_INVALID");
    }
    await pipeline(
      input,
      createWriteStream(destinationPath, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    throwIfAborted(signal);
    destination = await open(destinationPath, "r+");
    await destination.sync();
    await destination.chmod(0o400);
  } catch (error) {
    if (error instanceof PostgresAccountlessRetentionImportError) throw error;
    if (signal?.aborted) fail("ACCOUNTLESS_RETENTION_IMPORT_ABORTED");
    fail("ACCOUNTLESS_RETENTION_INPUT_FILE_INVALID");
  } finally {
    await destination?.close().catch(() => {});
    input?.destroy();
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function mergeKeyRuns(paths, outputPath, signal) {
  const readers = paths.map(path => {
    const input = createReadStream(path, { encoding: "utf8", highWaterMark: 32 * 1_024 });
    return { input, lines: createInterface({ input, crlfDelay: Infinity }), iterator: null };
  });
  for (const reader of readers) reader.iterator = reader.lines[Symbol.asyncIterator]();
  let output;
  try {
    throwIfAborted(signal);
    output = await open(outputPath, "wx", 0o600);
    const heads = await Promise.all(readers.map(reader => reader.iterator.next()));
    let prior = null;
    for (;;) {
      throwIfAborted(signal);
      let selected = -1;
      for (let index = 0; index < heads.length; index += 1) {
        if (heads[index].done) continue;
        if (selected < 0 || compareText(heads[index].value, heads[selected].value) < 0) selected = index;
      }
      if (selected < 0) break;
      const key = heads[selected].value;
      if (typeof key !== "string" || key.length === 0) fail("ACCOUNTLESS_RETENTION_TEMP_FILE_INVALID");
      if (key === prior) fail("ACCOUNTLESS_RETENTION_SOURCE_MAPPING_INVALID");
      await writeHandle(output, `${key}\n`);
      prior = key;
      heads[selected] = await readers[selected].iterator.next();
    }
    await output.sync();
  } finally {
    await output?.close().catch(() => {});
    for (const reader of readers) {
      reader.lines.close();
      reader.input.destroy();
      await reader.iterator.return?.().catch(() => {});
    }
  }
}

function createTargetKeySorter(directory, { signal, maxTargetKeyBufferBytes } = {}) {
  const MAX_BUFFER_BYTES = maxTargetKeyBufferBytes;
  const MERGE_FAN_IN = 16;
  let bufferedKeys = [];
  let bufferedBytes = 0;
  let runNumber = 0;
  const runLevels = [];

  async function addRun(path, level = 0) {
    runLevels[level] ??= [];
    runLevels[level].push(path);
    if (runLevels[level].length < MERGE_FAN_IN) return;
    const group = runLevels[level];
    runLevels[level] = [];
    const outputPath = join(directory, `target-key-merge-${runNumber++}.ndjson`);
    await mergeKeyRuns(group, outputPath, signal);
    for (const runPath of group) await rm(runPath, { force: true });
    await addRun(outputPath, level + 1);
  }

  async function flush() {
    throwIfAborted(signal);
    if (bufferedKeys.length === 0) return;
    bufferedKeys.sort(compareText);
    const runPath = join(directory, `target-key-run-${runNumber++}.ndjson`);
    let handle;
    try {
      handle = await open(runPath, "wx", 0o600);
      let prior = null;
      for (const key of bufferedKeys) {
        if (key === prior) fail("ACCOUNTLESS_RETENTION_SOURCE_MAPPING_INVALID");
        await writeHandle(handle, `${key}\n`);
        prior = key;
      }
      await handle.sync();
      bufferedKeys = [];
      bufferedBytes = 0;
      await addRun(runPath);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function addTarget(target) {
    throwIfAborted(signal);
    for (const [prefix, value] of [
      ["participant:", target.participantId],
      ["enrollment-device:", target.enrollmentDeviceId],
      ["device-credential:", target.deviceCredentialId],
    ]) {
      const key = `${prefix}${value}`;
      bufferedKeys.push(key);
      bufferedBytes += Buffer.byteLength(key) + 1;
      if (bufferedBytes >= MAX_BUFFER_BYTES) await flush();
    }
  }

  async function finish() {
    await flush();
    let runs = runLevels.flat();
    while (runs.length > 1) {
      const nextRuns = [];
      for (let start = 0; start < runs.length; start += MERGE_FAN_IN) {
        const group = runs.slice(start, start + MERGE_FAN_IN);
        if (group.length === 1) {
          nextRuns.push(group[0]);
          continue;
        }
        const outputPath = join(directory, `target-key-merge-${runNumber++}.ndjson`);
        await mergeKeyRuns(group, outputPath, signal);
        for (const path of group) await rm(path, { force: true });
        nextRuns.push(outputPath);
      }
      runs = nextRuns;
    }
    for (const path of runs) await rm(path, { force: true });
    runs = [];
  }

  return Object.freeze({ addTarget, finish });
}

async function* readMappedRowsFile(path, signal) {
  const input = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1_024 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      throwIfAborted(signal);
      if (line.length === 0) fail("ACCOUNTLESS_RETENTION_SOURCE_CHANGED");
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        fail("ACCOUNTLESS_RETENTION_SOURCE_CHANGED");
      }
      yield normalizeSourceRow(value);
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

/**
 * Build a trusted D1 source from sealed JSON files without materializing the
 * artifact, mappings, or complete mapped-row set in memory. Inputs are copied
 * to a private temporary directory, verified there, and removed by close().
 */
export async function createD1AccountlessRetentionFileSource({
  artifactPath,
  participantMappingsPath,
  expectedArtifactSha256,
  expectedMappingSha256,
  signal,
  maxTargetKeyBufferBytes = DEFAULT_TARGET_KEY_BUFFER_BYTES,
  temporaryRoot = tmpdir(),
} = {}) {
  throwIfAborted(signal);
  if (typeof expectedArtifactSha256 !== "string" || !SHA256.test(expectedArtifactSha256)) {
    fail("ACCOUNTLESS_RETENTION_ARTIFACT_CHECKSUM_REQUIRED");
  }
  if (typeof expectedMappingSha256 !== "string" || !SHA256.test(expectedMappingSha256)) {
    fail("ACCOUNTLESS_RETENTION_MAPPING_CHECKSUM_REQUIRED");
  }
  if (!Number.isSafeInteger(maxTargetKeyBufferBytes)
      || maxTargetKeyBufferBytes < MIN_TARGET_KEY_BUFFER_BYTES
      || maxTargetKeyBufferBytes > DEFAULT_TARGET_KEY_BUFFER_BYTES) {
    fail("ACCOUNTLESS_RETENTION_SORT_BUFFER_INVALID");
  }
  if (typeof temporaryRoot !== "string" || temporaryRoot.length === 0) {
    fail("ACCOUNTLESS_RETENTION_TEMP_RECOVERY_FAILED");
  }
  let directory;
  try {
    await cleanupStaleAccountlessRetentionTempDirs({ directory: temporaryRoot, signal });
    throwIfAborted(signal);
    directory = await mkdtemp(join(temporaryRoot, ACCOUNTLESS_RETENTION_TEMP_PREFIX));
    await writeTempOwner(directory);
    throwIfAborted(signal);
    const stagedArtifactPath = join(directory, "artifact.json");
    const stagedMappingsPath = join(directory, "participant-mappings.json");
    const pageSpoolPath = join(directory, "artifact-pages.ndjson");
    const mappedRowsPath = join(directory, "mapped-rows.ndjson");
    await stageRegularFile(artifactPath, stagedArtifactPath, signal);
    await stageRegularFile(participantMappingsPath, stagedMappingsPath, signal);

    const rowHandle = await open(mappedRowsPath, "wx", 0o600);
    const keySorter = createTargetKeySorter(directory, { signal, maxTargetKeyBufferBytes });
    let previousSourceId = null;
    let rowCount = 0;
    let snapshot;
    try {
      snapshot = await verifyAccountlessRetentionD1ArtifactFiles({
        artifactPath: stagedArtifactPath,
        participantMappingsPath: stagedMappingsPath,
        pageSpoolPath,
        expectedArtifactSha256,
        expectedMappingSha256,
        signal,
        async onMappedRow(value) {
          throwIfAborted(signal);
          const row = normalizeSourceRow(value);
          const sourceId = row.source.marker.participantId;
          if (previousSourceId !== null && sourceId <= previousSourceId) {
            fail("ACCOUNTLESS_RETENTION_SOURCE_ORDER_INVALID");
          }
          previousSourceId = sourceId;
          await keySorter.addTarget(row.target);
          await writeHandle(rowHandle, `${JSON.stringify(row)}\n`);
          rowCount += 1;
        },
      });
      if (rowCount !== snapshot.rowCount) fail("ACCOUNTLESS_RETENTION_SOURCE_COUNT_MISMATCH");
      await rowHandle.sync();
      await rowHandle.chmod(0o400);
      await keySorter.finish();
    } finally {
      await rowHandle.close().catch(() => {});
    }
    await rm(pageSpoolPath, { force: true });

    const fingerprints = new Map();
    for (const path of [stagedArtifactPath, stagedMappingsPath, mappedRowsPath]) {
      fingerprints.set(path, await fileFingerprint(path));
    }
    throwIfAborted(signal);
    let closed = false;
    let closePromise;
    let rowIterator;
    let iteratorAfter;
    let pendingRow = null;
    let ended = false;

    async function resetIterator(after) {
      await rowIterator?.return?.();
      rowIterator = readMappedRowsFile(mappedRowsPath, signal)[Symbol.asyncIterator]();
      iteratorAfter = after;
      pendingRow = null;
      ended = false;
      if (after === null) return;
      for (;;) {
        const next = await rowIterator.next();
        if (next.done) {
          ended = true;
          return;
        }
        if (next.value.source.marker.participantId > after) {
          pendingRow = next.value;
          return;
        }
      }
    }

    async function closeSource({ interrupted = false } = {}) {
      if (closePromise) return closePromise;
      closed = true;
      signal?.removeEventListener("abort", onAbort);
      closePromise = (async () => {
        if (interrupted) {
          await rm(directory, { recursive: true, force: true });
          void rowIterator?.return?.();
          return;
        }
        await rowIterator?.return?.();
        await rm(directory, { recursive: true, force: true });
      })();
      return closePromise;
    }

    const onAbort = () => { void closeSource({ interrupted: true }).catch(() => {}); };

    const source = Object.freeze({
      snapshot,
      async verifySnapshot() {
        throwIfAborted(signal);
        if (closed) fail("ACCOUNTLESS_RETENTION_SOURCE_CLOSED");
        try {
          for (const [path, expected] of fingerprints) {
            if (await fileFingerprint(path) !== expected) fail("ACCOUNTLESS_RETENTION_SOURCE_CHANGED");
          }
        } catch (error) {
          if (error instanceof PostgresAccountlessRetentionImportError) throw error;
          fail("ACCOUNTLESS_RETENTION_SOURCE_CHANGED");
        }
        return snapshot;
      },
      async listPage({ after = null, limit } = {}) {
        throwIfAborted(signal);
        if (closed) fail("ACCOUNTLESS_RETENTION_SOURCE_CLOSED");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > POSTGRES_ACCOUNTLESS_RETENTION_IMPORT_MAX_PAGE_SIZE
            || after !== null && (typeof after !== "string" || !SAFE_ID.test(after))) {
          fail("ACCOUNTLESS_RETENTION_PAGE_REQUEST_INVALID");
        }
        if (iteratorAfter !== after) await resetIterator(after);
        const rows = [];
        if (pendingRow !== null) {
          rows.push(pendingRow);
          pendingRow = null;
        }
        while (rows.length < limit && !ended) {
          throwIfAborted(signal);
          const next = await rowIterator.next();
          if (next.done) {
            ended = true;
            break;
          }
          rows.push(next.value);
        }
        if (rows.length > 0) iteratorAfter = rows.at(-1).source.marker.participantId;
        return Object.freeze({ rows: Object.freeze(rows) });
      },
      async close() {
        await closeSource();
      },
    });
    TRUSTED_SOURCES.add(source);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      await closeSource({ interrupted: true });
      fail("ACCOUNTLESS_RETENTION_IMPORT_ABORTED");
    }
    return source;
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    if (error instanceof PostgresAccountlessRetentionImportError) throw error;
    if (error && typeof error === "object" && typeof error.code === "string"
        && error.code.startsWith("ACCOUNTLESS_RETENTION_")) fail(error.code);
    fail("ACCOUNTLESS_RETENTION_TEMP_STORAGE_FAILED");
  }
}

function quoteSchema(schema) {
  if (typeof schema !== "string" || !SAFE_SCHEMA.test(schema)
      || !TARGET_SCHEMA.test(schema)) fail("ACCOUNTLESS_RETENTION_TARGET_SCHEMA_INVALID");
  return `"${schema}"`;
}

const IMPORT_TABLES = new Set([
  "_tibotattle_migration_history",
  "accountless_public_history_import_runs",
  "accountless_public_history_import_claims",
  "accountless_public_history_import_pages",
  "accountless_public_history_import_fence_receipts",
  "accountless_public_history_retention",
  "collection_controls",
]);

function table(schema, name) {
  if (!IMPORT_TABLES.has(name)) fail("ACCOUNTLESS_RETENTION_TABLE_INVALID");
  return `${quoteSchema(schema)}."${name}"`;
}

function targetTuple(row) {
  return {
    participantId: row.target.participantId,
    enrollmentDeviceId: row.target.enrollmentDeviceId,
    deviceCredentialId: row.target.deviceCredentialId,
    generationId: row.target.generationId,
    headRevision: row.source.marker.headRevision,
    retainedAt: row.source.marker.retainedAt,
  };
}

function pageDigest(rows) {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(sourceRowDigest(row)).update("\n");
  return hash.digest("hex");
}

function assertTrustedSource(source) {
  const snapshot = source?.snapshot;
  const isSynthetic = snapshot?.kind === "synthetic-accountless-retention-fixture-v1";
  const isD1Artifact = snapshot?.kind === ACCOUNTLESS_RETENTION_D1_SOURCE_KIND;
  const validSynthetic = !isSynthetic || (
    snapshot.snapshotId === `synthetic-retention:${snapshot.artifactSha256}`
    && snapshot.fenceId === `synthetic-fence:${snapshot.artifactSha256}`
  );
  const validD1Artifact = !isD1Artifact || (
    typeof snapshot.snapshotId === "string"
    && snapshot.snapshotId === `d1-accountless-retention:${snapshot.artifactSha256}`
    && typeof snapshot.fenceId === "string"
    && snapshot.fenceId.startsWith("d1-retention-fence:")
    && Number.isSafeInteger(snapshot.sourceRevision) && snapshot.sourceRevision >= 0
    && SHA256.test(snapshot.mappingSha256 ?? "")
    && snapshot.sourceFenceReconciled === false
  );
  const expectedReceipts = isD1Artifact
    ? canonical(ACCOUNTLESS_RETENTION_D1_SOURCE_MIGRATIONS)
    : canonical(POSTGRES_ACCOUNTLESS_RETENTION_SOURCE_MIGRATIONS);
  if (!source || !TRUSTED_SOURCES.has(source) || typeof source.listPage !== "function"
      || typeof source.verifySnapshot !== "function" || (!isSynthetic && !isD1Artifact)
      || snapshot.immutable !== true || !SHA256.test(snapshot.artifactSha256 ?? "")
      || !SHA256.test(snapshot.manifestSha256 ?? "") || !validSynthetic || !validD1Artifact
      || canonical(snapshot.migrationReceipts) !== expectedReceipts
      || !Number.isSafeInteger(snapshot.rowCount) || snapshot.rowCount < 0) {
    fail("ACCOUNTLESS_RETENTION_TRUSTED_SOURCE_REQUIRED");
  }
  return snapshot;
}

function validatePage(rows, after, pageSize, expectedRemaining) {
  if (!Array.isArray(rows) || rows.length > pageSize || rows.length > expectedRemaining) {
    fail("ACCOUNTLESS_RETENTION_SOURCE_PAGE_INVALID");
  }
  let previous = after;
  for (const row of rows) {
    const normalized = normalizeSourceRow(row);
    if (canonical(normalized) !== canonical(row)) fail("ACCOUNTLESS_RETENTION_SOURCE_PAGE_INVALID");
    const participantId = normalized.source.marker.participantId;
    if (previous !== null && participantId <= previous) fail("ACCOUNTLESS_RETENTION_SOURCE_ORDER_INVALID");
    previous = participantId;
  }
  return rows;
}

async function expectedTargetReceipts(pool, schema, { requireVersion43 = false } = {}) {
  let manifest;
  try {
    manifest = await buildPostgresMigrationManifest();
  } catch {
    fail("ACCOUNTLESS_RETENTION_TARGET_MIGRATION_MANIFEST_INVALID");
  }
  const entries = new Map([
    [LEGACY_MIGRATION_VERSION, manifest.roles.primary[LEGACY_MIGRATION_VERSION - 1]],
    [MIGRATION_VERSION, manifest.roles.primary[MIGRATION_VERSION - 1]],
  ]);
  const expectedNames = new Map([
    [LEGACY_MIGRATION_VERSION, "0042_accountless_history_retention_import.sql"],
    [MIGRATION_VERSION, "0043_accountless_history_d1_import.sql"],
  ]);
  for (const [version, entry] of entries) {
    if (entry && (entry.version !== version || entry.name !== expectedNames.get(version))) {
      fail("ACCOUNTLESS_RETENTION_TARGET_MIGRATION_REQUIRED");
    }
  }
  if (!entries.get(MIGRATION_VERSION)) fail("ACCOUNTLESS_RETENTION_TARGET_MIGRATION_REQUIRED");
  let result;
  try {
    result = await pool.query(`SELECT version,name,checksum_sha256
      FROM ${table(schema, "_tibotattle_migration_history")} WHERE version = ANY($1::int[])`,
    [[...entries.keys()]]);
  } catch {
    fail("ACCOUNTLESS_RETENTION_TARGET_MIGRATION_REQUIRED");
  }
  const receipts = new Map(result.rows.map(row => [Number(row.version), row]));
  if (receipts.size !== result.rowCount || result.rows.some(row => {
    const expected = entries.get(Number(row.version));
    return !expected || row.name !== expected.name || row.checksum_sha256 !== expected.sha256;
  })) {
    fail("ACCOUNTLESS_RETENTION_TARGET_MIGRATION_REQUIRED");
  }
  const latest = receipts.has(MIGRATION_VERSION) ? MIGRATION_VERSION : LEGACY_MIGRATION_VERSION;
  if (requireVersion43 && latest !== MIGRATION_VERSION) {
    fail("ACCOUNTLESS_RETENTION_D1_TARGET_MIGRATION_REQUIRED");
  }
  const preferred = entries.get(latest);
  if (!preferred || !receipts.has(latest)) fail("ACCOUNTLESS_RETENTION_TARGET_MIGRATION_REQUIRED");
  return Object.freeze({ entries, preferred, receipts });
}

async function validateTarget(pool, schema) {
  const quoted = quoteSchema(schema);
  let server;
  try {
    server = await pool.query("SELECT current_setting('server_version_num') AS version, inet_server_addr() AS address");
  } catch {
    fail("ACCOUNTLESS_RETENTION_TARGET_UNAVAILABLE");
  }
  const version = Number(server.rows?.[0]?.version);
  if (!Number.isSafeInteger(version) || Math.floor(version / 10_000) !== 17) {
    fail("ACCOUNTLESS_RETENTION_POSTGRES_17_REQUIRED");
  }
  if (server.rows[0]?.address !== null) fail("ACCOUNTLESS_RETENTION_LOCAL_SOCKET_REQUIRED");

  const required = [...IMPORT_TABLES];
  let relations;
  try {
    relations = await pool.query(`SELECT name,to_regclass($1 || '.' || quote_ident(name)) AS relation
      FROM unnest($2::text[]) AS names(name)`, [schema, required]);
  } catch {
    fail("ACCOUNTLESS_RETENTION_TARGET_SCHEMA_UNAVAILABLE");
  }
  const found = new Set(relations.rows.filter(row => row.relation !== null).map(row => row.name));
  if (required.some(name => !found.has(name))) fail("ACCOUNTLESS_RETENTION_TARGET_MIGRATION_REQUIRED");
  return { quoted };
}

async function acquireLock(pool, schema, transferId) {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [`${schema}:accountless-retention:${transferId}`]);
    if (result.rows?.[0]?.locked !== true) fail("ACCOUNTLESS_RETENTION_TRANSFER_BUSY");
    return client;
  } catch (error) {
    client?.release();
    if (error instanceof PostgresAccountlessRetentionImportError) throw error;
    fail("ACCOUNTLESS_RETENTION_TARGET_UNAVAILABLE");
  }
}

async function transaction(client, schema, callback, failureCode) {
  try {
    await client.query("BEGIN");
    await client.query(renderPostgresSearchPath(schema));
    const value = await callback();
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof PostgresAccountlessRetentionImportError) throw error;
    fail(failureCode);
  }
}

async function ensureRun({ client, schema, transferId, snapshot, pageSize, migration, migrations }) {
  return transaction(client, schema, async () => {
    const runs = table(schema, "accountless_public_history_import_runs");
    const existing = await client.query(`SELECT * FROM ${runs} WHERE transfer_id=$1 FOR UPDATE`, [transferId]);
    if (existing.rowCount === 1) {
      const run = existing.rows[0];
      let receipts;
      try { receipts = typeof run.source_migration_receipts === "string"
        ? JSON.parse(run.source_migration_receipts) : run.source_migration_receipts; }
      catch { fail("ACCOUNTLESS_RETENTION_TRANSFER_ID_CONFLICT"); }
      const version = Number(run.target_migration_version);
      const priorMigration = migrations.entries.get(version);
      const expectedSourceKind = snapshot.kind === ACCOUNTLESS_RETENTION_D1_SOURCE_KIND
        ? ACCOUNTLESS_RETENTION_D1_SOURCE_KIND : SOURCE_KIND;
      if (run.schema_version !== POSTGRES_ACCOUNTLESS_RETENTION_IMPORT_SCHEMA
          || run.source_kind !== expectedSourceKind || run.target_schema !== schema
          || run.source_snapshot_id !== snapshot.snapshotId || run.source_fence_id !== snapshot.fenceId
          || run.source_artifact_sha256 !== snapshot.artifactSha256
          || run.source_manifest_sha256 !== snapshot.manifestSha256
          || run.source_run_id !== (snapshot.kind === ACCOUNTLESS_RETENTION_D1_SOURCE_KIND ? snapshot.sourceRunId : null)
          || (run.source_revision === null ? null : Number(run.source_revision))
            !== (snapshot.kind === ACCOUNTLESS_RETENTION_D1_SOURCE_KIND ? snapshot.sourceRevision : null)
          || run.source_mapping_sha256 !== (snapshot.kind === ACCOUNTLESS_RETENTION_D1_SOURCE_KIND
            ? snapshot.mappingSha256 : null)
          || Number(run.source_row_count) !== snapshot.rowCount
          || canonical(receipts) !== canonical(snapshot.migrationReceipts)
          || !priorMigration || !migrations.receipts.has(version)
          || version === LEGACY_MIGRATION_VERSION && expectedSourceKind !== SOURCE_KIND
          || run.target_migration_sha256 !== priorMigration.sha256
          || Number(run.page_size) !== pageSize) {
        fail("ACCOUNTLESS_RETENTION_TRANSFER_ID_CONFLICT");
      }
      if (run.status === "aborted") fail("ACCOUNTLESS_RETENTION_TRANSFER_ABORTED");
      if (run.source_fence_state === "invalidated") fail("ACCOUNTLESS_RETENTION_SOURCE_FENCE_INVALIDATED");
      return run.status;
    }
    if (existing.rowCount !== 0) fail("ACCOUNTLESS_RETENTION_TRANSFER_ID_CONFLICT");
    const sourceKind = snapshot.kind === ACCOUNTLESS_RETENTION_D1_SOURCE_KIND
      ? ACCOUNTLESS_RETENTION_D1_SOURCE_KIND : SOURCE_KIND;
    const sourceFenceState = sourceKind === ACCOUNTLESS_RETENTION_D1_SOURCE_KIND ? "pending" : "not_required";
    await client.query(`INSERT INTO ${runs} (
      transfer_id,schema_version,source_kind,target_schema,source_snapshot_id,source_fence_id,
      source_artifact_sha256,source_manifest_sha256,source_row_count,source_migration_receipts,
      source_run_id,source_revision,source_mapping_sha256,source_fence_state,
      target_migration_version,target_migration_sha256,page_size,status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,'importing')`, [
      transferId, POSTGRES_ACCOUNTLESS_RETENTION_IMPORT_SCHEMA, sourceKind,
      schema, snapshot.snapshotId, snapshot.fenceId, snapshot.artifactSha256, snapshot.manifestSha256,
      snapshot.rowCount, JSON.stringify(snapshot.migrationReceipts),
      sourceKind === ACCOUNTLESS_RETENTION_D1_SOURCE_KIND ? snapshot.sourceRunId : null,
      sourceKind === ACCOUNTLESS_RETENTION_D1_SOURCE_KIND ? snapshot.sourceRevision : null,
      sourceKind === ACCOUNTLESS_RETENTION_D1_SOURCE_KIND ? snapshot.mappingSha256 : null,
      sourceFenceState, migration.version, migration.sha256, pageSize,
    ]);
    return "importing";
  }, "ACCOUNTLESS_RETENTION_PERMIT_WRITE_FAILED");
}

async function lastPage(client, schema, transferId) {
  const result = await client.query(`SELECT page_number,last_source_participant_id,cumulative_row_count
    FROM ${table(schema, "accountless_public_history_import_pages")}
    WHERE transfer_id=$1 ORDER BY page_number DESC LIMIT 1`, [transferId]);
  return result.rows?.[0] ?? null;
}

function multiInsert(columns, rowCount, relation) {
  const values = Array.from({ length: rowCount }, (_, rowIndex) =>
    `(${columns.map((_, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`).join(",")})`).join(",");
  return `INSERT INTO ${relation} (${columns.map(column => `"${column}"`).join(",")}) VALUES ${values}`;
}

function sourceRowValues(transferId, row) {
  const source = row.source;
  const marker = source.marker;
  return [
    transferId, marker.participantId, marker.enrollmentDeviceId, marker.deviceCredentialId,
    marker.generationId, row.target.participantId, row.target.enrollmentDeviceId,
    row.target.deviceCredentialId, row.target.generationId, marker.headRevision, marker.retainedAt,
    sourceRowDigest(row), source.owner.expiresAt, Buffer.from(source.ledger.deviceSecretHash, "hex"),
  ];
}

async function writePage({ client, schema, transferId, pageRows, pageNumber, cumulative }) {
  return transaction(client, schema, async () => {
    const runs = table(schema, "accountless_public_history_import_runs");
    const run = await client.query(`SELECT status,source_row_count,page_size FROM ${runs}
      WHERE transfer_id=$1 FOR UPDATE`, [transferId]);
    if (run.rowCount !== 1 || run.rows[0]?.status !== "importing") {
      fail("ACCOUNTLESS_RETENTION_PERMIT_CLOSED");
    }
    await client.query("SELECT set_config('tibotattle.accountless_history_import',$1,true)", [transferId]);
    const claimColumns = [
      "transfer_id", "source_participant_id", "source_enrollment_device_id", "source_device_credential_id",
      "source_generation_id", "target_participant_id", "target_enrollment_device_id", "target_device_credential_id",
      "target_generation_id", "head_revision", "retained_at", "source_row_sha256", "source_expires_at",
      "source_device_secret_hash",
    ];
    const claims = pageRows.flatMap(row => sourceRowValues(transferId, row));
    const insertedClaims = await client.query(multiInsert(claimColumns, pageRows.length,
      table(schema, "accountless_public_history_import_claims")), claims);
    if (insertedClaims.rowCount !== pageRows.length) fail("ACCOUNTLESS_RETENTION_PAGE_WRITE_FAILED");

    const markerColumns = ["participant_id", "enrollment_device_id", "device_credential_id", "generation_id", "head_revision", "retained_at"];
    const markerValues = pageRows.flatMap(row => {
      const target = targetTuple(row);
      return [target.participantId, target.enrollmentDeviceId, target.deviceCredentialId,
        target.generationId, target.headRevision, target.retainedAt];
    });
    const insertedMarkers = await client.query(multiInsert(markerColumns, pageRows.length,
      table(schema, "accountless_public_history_retention")), markerValues);
    if (insertedMarkers.rowCount !== pageRows.length) fail("ACCOUNTLESS_RETENTION_PAGE_WRITE_FAILED");

    await verifyTargetPage(client, schema, pageRows);
    await client.query(`INSERT INTO ${table(schema, "accountless_public_history_import_pages")} (
      transfer_id,page_number,first_source_participant_id,last_source_participant_id,row_count,
      cumulative_row_count,page_sha256
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [transferId, pageNumber,
      pageRows[0].source.marker.participantId, pageRows.at(-1).source.marker.participantId,
      pageRows.length, cumulative, pageDigest(pageRows)]);
  }, "ACCOUNTLESS_RETENTION_PAGE_WRITE_FAILED");
}

async function verifyTargetPage(client, schema, rows) {
  if (rows.length === 0) return;
  const expected = new Map(rows.map(row => [row.target.participantId, targetTuple(row)]));
  const result = await client.query(`SELECT participant_id,enrollment_device_id,device_credential_id,
      generation_id,head_revision,
      to_char(retained_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS retained_at,
      retained_at = date_trunc('milliseconds',retained_at) AS millisecond_exact
    FROM ${table(schema, "accountless_public_history_retention")}
    WHERE participant_id = ANY($1::text[]) ORDER BY participant_id`, [[...expected.keys()]]);
  if (result.rowCount !== expected.size) fail("ACCOUNTLESS_RETENTION_DESTINATION_MISMATCH");
  for (const raw of result.rows) {
    const target = expected.get(raw.participant_id);
    if (!target || raw.millisecond_exact !== true
        || raw.enrollment_device_id !== target.enrollmentDeviceId
        || raw.device_credential_id !== target.deviceCredentialId
        || raw.generation_id !== target.generationId
        || Number(raw.head_revision) !== target.headRevision
        || raw.retained_at !== target.retainedAt) {
      fail("ACCOUNTLESS_RETENTION_DESTINATION_MISMATCH");
    }
  }
}

async function verifyAllTargetRows({ source, client, schema, pageSize, signal }) {
  let after = null;
  let observed = 0;
  const digest = createHash("sha256");
  for (;;) {
    throwIfAborted(signal);
    const page = await source.listPage({ after, limit: pageSize });
    throwIfAborted(signal);
    const rows = validatePage(page?.rows, after, pageSize, source.snapshot.rowCount - observed);
    if (rows.length === 0) break;
    await verifyTargetPage(client, schema, rows);
    for (const row of rows) {
      throwIfAborted(signal);
      digest.update(canonical(targetTuple(row))).update("\n");
      after = row.source.marker.participantId;
      observed += 1;
    }
  }
  if (observed !== source.snapshot.rowCount) fail("ACCOUNTLESS_RETENTION_SOURCE_COUNT_MISMATCH");
  return digest.digest("hex");
}

async function completeRun({ client, schema, transferId, targetManifestSha256 }) {
  return transaction(client, schema, async () => {
    const result = await client.query(`UPDATE ${table(schema, "accountless_public_history_import_runs")}
      SET status='complete',target_manifest_sha256=$2,completed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE transfer_id=$1 AND status='importing' RETURNING status`, [transferId, targetManifestSha256]);
    if (result.rowCount !== 1 || result.rows[0]?.status !== "complete") {
      fail("ACCOUNTLESS_RETENTION_COMPLETION_REFUSED");
    }
  }, "ACCOUNTLESS_RETENTION_COMPLETION_REFUSED");
}

async function readRun(client, schema, transferId) {
    const result = await client.query(`SELECT status,target_manifest_sha256,source_fence_state
    FROM ${table(schema, "accountless_public_history_import_runs")} WHERE transfer_id=$1`, [transferId]);
  if (result.rowCount !== 1) fail("ACCOUNTLESS_RETENTION_PERMIT_UNAVAILABLE");
  return result.rows[0];
}

async function abortEmptyRun(client, schema, transferId) {
  try {
    await transaction(client, schema, async () => {
      await client.query(`UPDATE ${table(schema, "accountless_public_history_import_runs")}
        SET status='aborted',aborted_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE transfer_id=$1 AND status='importing'
          AND NOT EXISTS (SELECT 1 FROM ${table(schema, "accountless_public_history_import_pages")} page WHERE page.transfer_id=$1)
          AND NOT EXISTS (SELECT 1 FROM ${table(schema, "accountless_public_history_import_claims")} claim WHERE claim.transfer_id=$1)`,
      [transferId]);
    }, "ACCOUNTLESS_RETENTION_ABORT_FAILED");
  } catch {
    // The open permit is the safe outcome if its empty state cannot be proved.
  }
}

function receiptResult({ rows, pages, pagesWritten, replayed, sourceKind }) {
  const syntheticOnly = sourceKind === SOURCE_KIND;
  return Object.freeze({
    status: syntheticOnly
      ? "synthetic_accountless_retention_import_complete"
      : "d1_accountless_retention_import_complete",
    rows,
    pages,
    pagesWritten,
    replayed,
    syntheticOnly,
    cutoverAuthorized: false,
    sourceFenceReconciled: false,
    controlsRemainDegraded: true,
    enrollmentRemainsDisabled: true,
    publicationRemainsDisabled: true,
    cursorAdvanced: false,
  });
}

/**
 * Import content-free markers from a local synthetic fixture or an independently
 * checksummed D1 0063 artifact plus explicit participant mapping. The artifact
 * proves its sealed source revision at extraction time; fresh live source-fence
 * reconciliation remains a separate cutover gate.
 */
export async function runPostgresAccountlessRetentionImport({
  source,
  destinationPool,
  targetSchema,
  transferId,
  pageSize = POSTGRES_ACCOUNTLESS_RETENTION_IMPORT_DEFAULT_PAGE_SIZE,
  signal,
} = {}) {
  throwIfAborted(signal);
  const snapshot = assertTrustedSource(source);
  const sourceKind = snapshot.kind === ACCOUNTLESS_RETENTION_D1_SOURCE_KIND
    ? ACCOUNTLESS_RETENTION_D1_SOURCE_KIND : SOURCE_KIND;
  quoteSchema(targetSchema);
  if (!SAFE_TRANSFER_ID.test(transferId ?? "")) fail("ACCOUNTLESS_RETENTION_TRANSFER_ID_INVALID");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > POSTGRES_ACCOUNTLESS_RETENTION_IMPORT_MAX_PAGE_SIZE) {
    fail("ACCOUNTLESS_RETENTION_PAGE_SIZE_INVALID");
  }
  if (!destinationPool || typeof destinationPool.connect !== "function"
      || typeof destinationPool.query !== "function") fail("ACCOUNTLESS_RETENTION_TARGET_UNAVAILABLE");

  let client;
  let runCreated = false;
  try {
    throwIfAborted(signal);
    await source.verifySnapshot();
    throwIfAborted(signal);
    await validateTarget(destinationPool, targetSchema);
    throwIfAborted(signal);
    const migrations = await expectedTargetReceipts(destinationPool, targetSchema, {
      requireVersion43: sourceKind === ACCOUNTLESS_RETENTION_D1_SOURCE_KIND,
    });
    throwIfAborted(signal);
    const migration = migrations.preferred;
    client = await acquireLock(destinationPool, targetSchema, transferId);
    const status = await ensureRun({ client, schema: targetSchema, transferId, snapshot, pageSize, migration, migrations });
    runCreated = true;
    throwIfAborted(signal);
    if (status === "complete") {
      throwIfAborted(signal);
      const actual = await verifyAllTargetRows({ source, client, schema: targetSchema, pageSize, signal });
      const run = await readRun(client, targetSchema, transferId);
      if (actual !== run.target_manifest_sha256) fail("ACCOUNTLESS_RETENTION_REPLAY_MISMATCH");
      await source.verifySnapshot();
      const checkpoint = await lastPage(client, targetSchema, transferId);
      const pages = checkpoint === null ? 0 : Number(checkpoint.page_number);
      if (!Number.isSafeInteger(pages) || pages !== Math.ceil(snapshot.rowCount / pageSize)) {
        fail("ACCOUNTLESS_RETENTION_CHECKPOINT_INVALID");
      }
      return receiptResult({ rows: snapshot.rowCount, pages, pagesWritten: 0, replayed: true, sourceKind });
    }

    const previous = await lastPage(client, targetSchema, transferId);
    let after = previous?.last_source_participant_id ?? null;
    let cumulative = previous === null ? 0 : Number(previous.cumulative_row_count);
    let pageNumber = previous === null ? 0 : Number(previous.page_number);
    if (!Number.isSafeInteger(cumulative) || !Number.isSafeInteger(pageNumber)
        || cumulative < 0 || pageNumber < 0 || cumulative > snapshot.rowCount) {
      fail("ACCOUNTLESS_RETENTION_CHECKPOINT_INVALID");
    }
    const startPages = pageNumber;
    while (cumulative < snapshot.rowCount) {
      throwIfAborted(signal);
      await source.verifySnapshot();
      const page = await source.listPage({ after, limit: pageSize });
      throwIfAborted(signal);
      const rows = validatePage(page?.rows, after, pageSize, snapshot.rowCount - cumulative);
      await source.verifySnapshot();
      if (rows.length === 0) fail("ACCOUNTLESS_RETENTION_SOURCE_COUNT_MISMATCH");
      cumulative += rows.length;
      pageNumber += 1;
      await writePage({ client, schema: targetSchema, transferId, pageRows: rows, pageNumber, cumulative });
      throwIfAborted(signal);
      after = rows.at(-1).source.marker.participantId;
    }
    throwIfAborted(signal);
    const exhausted = await source.listPage({ after, limit: pageSize });
    throwIfAborted(signal);
    if (validatePage(exhausted?.rows, after, pageSize, 0).length !== 0) {
      fail("ACCOUNTLESS_RETENTION_SOURCE_COUNT_MISMATCH");
    }
    await source.verifySnapshot();
    const targetManifestSha256 = await verifyAllTargetRows({ source, client, schema: targetSchema, pageSize, signal });
    await source.verifySnapshot();
    throwIfAborted(signal);
    await completeRun({ client, schema: targetSchema, transferId, targetManifestSha256 });
    return receiptResult({ rows: snapshot.rowCount, pages: pageNumber,
      pagesWritten: pageNumber - startPages, replayed: false, sourceKind });
  } catch (error) {
    if (runCreated && client) await abortEmptyRun(client, targetSchema, transferId);
    if (error instanceof PostgresAccountlessRetentionImportError) throw error;
    fail("ACCOUNTLESS_RETENTION_IMPORT_FAILED");
  } finally {
    if (client) {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [`${targetSchema}:accountless-retention:${transferId}`]).catch(() => {});
      client.release();
    }
  }
}

/** Run the operational import from sealed artifact and mapping files. */
export async function runPostgresAccountlessRetentionImportFromFiles({
  artifactPath,
  participantMappingsPath,
  expectedArtifactSha256,
  expectedMappingSha256,
  signal,
  maxTargetKeyBufferBytes = DEFAULT_TARGET_KEY_BUFFER_BYTES,
  temporaryRoot = tmpdir(),
  ...importOptions
} = {}) {
  const source = await createD1AccountlessRetentionFileSource({
    artifactPath,
    participantMappingsPath,
    expectedArtifactSha256,
    expectedMappingSha256,
    signal,
    maxTargetKeyBufferBytes,
    temporaryRoot,
  });
  try {
    return await runPostgresAccountlessRetentionImport({ ...importOptions, source, signal });
  } finally {
    await source.close();
  }
}

/**
 * Mark a completed D1-artifact transfer ineligible after a fresh source-side
 * recheck fails closed. The callback must query the live D1 0063 source and
 * return its checked state/revision; an offline artifact is never sufficient.
 * This appends a terminal receipt and deliberately leaves imported markers in
 * place. A transient/read failure is not converted into invalidation.
 */
export async function invalidatePostgresAccountlessRetentionTransfer({
  sourceVerifier,
  destinationPool,
  targetSchema,
  transferId,
} = {}) {
  quoteSchema(targetSchema);
  if (!SAFE_TRANSFER_ID.test(transferId ?? "")) fail("ACCOUNTLESS_RETENTION_TRANSFER_ID_INVALID");
  if (typeof sourceVerifier !== "function") fail("ACCOUNTLESS_RETENTION_SOURCE_REVALIDATION_REQUIRED");
  if (!destinationPool || typeof destinationPool.connect !== "function"
      || typeof destinationPool.query !== "function") fail("ACCOUNTLESS_RETENTION_TARGET_UNAVAILABLE");

  let client;
  try {
    await validateTarget(destinationPool, targetSchema);
    await expectedTargetReceipts(destinationPool, targetSchema, { requireVersion43: true });
    client = await acquireLock(destinationPool, targetSchema, transferId);
    const runs = table(targetSchema, "accountless_public_history_import_runs");
    const existing = await client.query(`SELECT source_kind,status,source_fence_state,source_run_id,
        source_revision,source_artifact_sha256,source_manifest_sha256,source_mapping_sha256
      FROM ${runs} WHERE transfer_id=$1`, [transferId]);
    if (existing.rowCount !== 1) fail("ACCOUNTLESS_RETENTION_PERMIT_UNAVAILABLE");
    const run = existing.rows[0];
    if (run.source_kind !== ACCOUNTLESS_RETENTION_D1_SOURCE_KIND || run.status !== "complete") {
      fail("ACCOUNTLESS_RETENTION_SOURCE_REVALIDATION_NOT_APPLICABLE");
    }
    if (run.source_fence_state === "invalidated") {
      const prior = await client.query(`SELECT invalidation_code,proof_sha256 FROM ${table(targetSchema,
        "accountless_public_history_import_fence_receipts")} WHERE transfer_id=$1`, [transferId]);
      if (prior.rowCount !== 1) fail("ACCOUNTLESS_RETENTION_SOURCE_FENCE_RECEIPT_INVALID");
      return Object.freeze({ status: "source_fence_invalidated", invalidationCode: prior.rows[0].invalidation_code,
        proofSha256: prior.rows[0].proof_sha256, markersDeleted: false, replayAllowed: false });
    }
    if (run.source_fence_state !== "pending") fail("ACCOUNTLESS_RETENTION_SOURCE_FENCE_STATE_INVALID");

    let invalidationCode = null;
    try {
      const checked = await sourceVerifier(Object.freeze({
        runId: run.source_run_id,
        sourceRevision: Number(run.source_revision),
        artifactSha256: run.source_artifact_sha256,
        manifestSha256: run.source_manifest_sha256,
        mappingSha256: run.source_mapping_sha256,
      }));
      if (!checked || !["sealed", "extracted"].includes(checked.state)
          || !Number.isSafeInteger(checked.sourceRevision) || checked.sourceRevision < 0) {
        fail("ACCOUNTLESS_RETENTION_SOURCE_REVALIDATION_INVALID");
      }
      if (checked.state !== "extracted") invalidationCode = "SOURCE_SNAPSHOT_INVALIDATED";
      else if (checked.sourceRevision !== Number(run.source_revision)) {
        invalidationCode = "SOURCE_AUTHORITY_REVISION_CHANGED";
      }
    } catch (error) {
      if (error instanceof PostgresAccountlessRetentionImportError) throw error;
      const code = error && typeof error === "object" ? error.code : null;
      if (!SOURCE_INVALIDATION_CODES.has(code)) fail("ACCOUNTLESS_RETENTION_SOURCE_REVALIDATION_FAILED");
      invalidationCode = code;
    }
    if (invalidationCode === null) fail("ACCOUNTLESS_RETENTION_SOURCE_STILL_ELIGIBLE");

    const checkedAt = new Date().toISOString();
    const proof = {
      schemaVersion: "tibotattle-accountless-retention-source-invalidation-v1",
      transferId,
      sourceRunId: run.source_run_id,
      sourceRevision: Number(run.source_revision),
      artifactSha256: run.source_artifact_sha256,
      manifestSha256: run.source_manifest_sha256,
      mappingSha256: run.source_mapping_sha256,
      invalidationCode,
      checkedAt,
    };
    const proofSha256 = sha256(canonical(proof));
    await transaction(client, targetSchema, async () => {
      const locked = await client.query(`SELECT status,source_kind,source_fence_state,source_run_id,
          source_revision,source_artifact_sha256,source_manifest_sha256,source_mapping_sha256
        FROM ${runs} WHERE transfer_id=$1 FOR UPDATE`, [transferId]);
      const current = locked.rows?.[0];
      if (locked.rowCount !== 1 || current.status !== "complete"
          || current.source_kind !== ACCOUNTLESS_RETENTION_D1_SOURCE_KIND
          || current.source_fence_state !== "pending"
          || current.source_run_id !== run.source_run_id
          || Number(current.source_revision) !== Number(run.source_revision)
          || current.source_artifact_sha256 !== run.source_artifact_sha256
          || current.source_manifest_sha256 !== run.source_manifest_sha256
          || current.source_mapping_sha256 !== run.source_mapping_sha256) {
        fail("ACCOUNTLESS_RETENTION_SOURCE_FENCE_STATE_INVALID");
      }
      await client.query("SELECT set_config('tibotattle.accountless_history_fence_invalidate',$1,true)",
        [`${transferId}\ninvalidated\n${proofSha256}`]);
      const receipts = table(targetSchema, "accountless_public_history_import_fence_receipts");
      const inserted = await client.query(`INSERT INTO ${receipts} (
        transfer_id,sequence,result_state,source_run_id,source_revision,
        source_artifact_sha256,source_mapping_sha256,invalidation_code,proof_sha256,checked_at
      ) VALUES ($1,1,'invalidated',$2,$3,$4,$5,$6,$7,$8::timestamptz) RETURNING proof_sha256`, [
        transferId, run.source_run_id, Number(run.source_revision), run.source_artifact_sha256,
        run.source_mapping_sha256, invalidationCode, proofSha256, checkedAt,
      ]);
      if (inserted.rowCount !== 1 || inserted.rows[0]?.proof_sha256 !== proofSha256) {
        fail("ACCOUNTLESS_RETENTION_SOURCE_FENCE_RECEIPT_INVALID");
      }
      const updated = await client.query(`UPDATE ${runs}
        SET source_fence_state='invalidated',updated_at=clock_timestamp()
        WHERE transfer_id=$1 AND status='complete' AND source_fence_state='pending' RETURNING transfer_id`,
      [transferId]);
      if (updated.rowCount !== 1) fail("ACCOUNTLESS_RETENTION_SOURCE_FENCE_STATE_INVALID");
    }, "ACCOUNTLESS_RETENTION_SOURCE_FENCE_INVALIDATION_FAILED");
    return Object.freeze({ status: "source_fence_invalidated", invalidationCode, proofSha256,
      markersDeleted: false, replayAllowed: false });
  } finally {
    if (client) {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [`${targetSchema}:accountless-retention:${transferId}`]).catch(() => {});
      client.release();
    }
  }
}
