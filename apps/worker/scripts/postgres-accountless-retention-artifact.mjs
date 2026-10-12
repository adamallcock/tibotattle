import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";

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
const MAX_ARTIFACT_PAGE_BYTES = 16 * 1_024 * 1_024;
const MAX_MAPPING_ENTRY_BYTES = 8 * 1_024;
const MAX_ARTIFACT_METADATA_VALUE_BYTES = 1 * 1_024 * 1_024;
const MAX_ARTIFACT_METADATA_BYTES = 2 * 1_024 * 1_024;
const MAX_ARTIFACT_TOP_LEVEL_KEYS = 12;

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

function streamFailure(code = "ACCOUNTLESS_RETENTION_ARTIFACT_INVALID") {
  artifactFailure(code);
}

function throwIfFileStreamAborted(signal) {
  if (signal?.aborted) streamFailure("ACCOUNTLESS_RETENTION_IMPORT_ABORTED");
}

function decodeJsonBytes(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    streamFailure();
  }
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    streamFailure();
  }
}

/** Detect duplicate object keys before JSON.parse applies last-key-wins semantics. */
function assertNoDuplicateJsonObjectKeys(text) {
  const stack = [];
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < text.length) {
        const current = text[index];
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') break;
        index += 1;
      }
      if (index >= text.length) streamFailure();
      const container = stack.at(-1);
      if (container?.kind === "object" && container.expectKey) {
        const key = parseJsonText(text.slice(start, index + 1));
        if (container.keys.has(key)) streamFailure();
        container.keys.add(key);
        container.expectKey = false;
      }
      index += 1;
      continue;
    }
    if (character === "{") {
      stack.push({ kind: "object", keys: new Set(), expectKey: true });
    } else if (character === "[") {
      stack.push({ kind: "array" });
    } else if (character === ",") {
      const container = stack.at(-1);
      if (container?.kind === "object") container.expectKey = true;
    } else if (character === "}" || character === "]") {
      stack.pop();
    }
    index += 1;
  }
}

class JsonFileReader {
  constructor(path, signal) {
    this.stream = createReadStream(path, { highWaterMark: 64 * 1_024 });
    this.iterator = this.stream[Symbol.asyncIterator]();
    this.signal = signal;
    this.chunk = Buffer.alloc(0);
    this.offset = 0;
    this.ended = false;
  }

  async nextChunk() {
    throwIfFileStreamAborted(this.signal);
    while (!this.ended) {
      throwIfFileStreamAborted(this.signal);
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        this.chunk = Buffer.alloc(0);
        this.offset = 0;
        return false;
      }
      this.chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.offset = 0;
      if (this.chunk.length > 0) return true;
    }
    return false;
  }

  async ensureByte() {
    while (this.offset >= this.chunk.length && !this.ended) {
      if (!await this.nextChunk()) return false;
    }
    return this.offset < this.chunk.length;
  }

  async peekByte() {
    return await this.ensureByte() ? this.chunk[this.offset] : null;
  }

  async readByte() {
    if (!await this.ensureByte()) return null;
    return this.chunk[this.offset++];
  }

  async skipWhitespace() {
    for (;;) {
      if ((this.offset & 0xfff) === 0) throwIfFileStreamAborted(this.signal);
      const byte = await this.peekByte();
      if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return;
      this.offset += 1;
    }
  }

  async expectByte(expected) {
    await this.skipWhitespace();
    if (await this.readByte() !== expected) streamFailure();
  }

  async readRawValue(maximumBytes) {
    await this.skipWhitespace();
    if (!await this.ensureByte()) streamFailure();
    const first = this.chunk[this.offset];
    const parts = [];
    let total = 0;
    let start = this.offset;
    const appendChunkPart = () => {
      if (this.offset <= start) return;
      const part = this.chunk.subarray(start, this.offset);
      total += part.byteLength;
      if (total > maximumBytes) streamFailure("ACCOUNTLESS_RETENTION_ARTIFACT_VALUE_TOO_LARGE");
      parts.push(part);
    };
    const result = () => decodeJsonBytes(Buffer.concat(parts, total));

    if (first === 0x22) {
      this.offset += 1;
      let escaped = false;
      for (;;) {
        if ((this.offset & 0xfff) === 0) throwIfFileStreamAborted(this.signal);
        if (this.offset >= this.chunk.length) {
          appendChunkPart();
          if (!await this.nextChunk()) streamFailure();
          start = 0;
        }
        const byte = this.chunk[this.offset++];
        if (escaped) escaped = false;
        else if (byte === 0x5c) escaped = true;
        else if (byte === 0x22) {
          appendChunkPart();
          return result();
        }
        if (total + this.offset - start > maximumBytes) {
          streamFailure("ACCOUNTLESS_RETENTION_ARTIFACT_VALUE_TOO_LARGE");
        }
      }
    }

    if (first === 0x7b || first === 0x5b) {
      const stack = [first === 0x7b ? 0x7d : 0x5d];
      let inString = false;
      let escaped = false;
      this.offset += 1;
      for (;;) {
        if ((this.offset & 0xfff) === 0) throwIfFileStreamAborted(this.signal);
        if (this.offset >= this.chunk.length) {
          appendChunkPart();
          if (!await this.nextChunk()) streamFailure();
          start = 0;
        }
        const byte = this.chunk[this.offset++];
        if (inString) {
          if (escaped) escaped = false;
          else if (byte === 0x5c) escaped = true;
          else if (byte === 0x22) inString = false;
        } else if (byte === 0x22) inString = true;
        else if (byte === 0x7b) stack.push(0x7d);
        else if (byte === 0x5b) stack.push(0x5d);
        else if (byte === 0x7d || byte === 0x5d) {
          if (stack.pop() !== byte) streamFailure();
          if (stack.length === 0) {
            appendChunkPart();
            return result();
          }
        }
        if (total + this.offset - start > maximumBytes) {
          streamFailure("ACCOUNTLESS_RETENTION_ARTIFACT_VALUE_TOO_LARGE");
        }
      }
    }

    for (;;) {
      if ((this.offset & 0xfff) === 0) throwIfFileStreamAborted(this.signal);
      if (this.offset >= this.chunk.length && !this.ended) {
        appendChunkPart();
        if (!await this.nextChunk()) {
          if (total === 0) streamFailure();
          return result();
        }
        start = 0;
      }
      if (!await this.ensureByte()) {
        appendChunkPart();
        if (total === 0) streamFailure();
        return result();
      }
      const byte = this.chunk[this.offset];
      if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
          || byte === 0x2c || byte === 0x5d || byte === 0x7d) {
        appendChunkPart();
        if (total === 0) streamFailure();
        return result();
      }
      this.offset += 1;
      if (total + this.offset - start > maximumBytes) {
        streamFailure("ACCOUNTLESS_RETENTION_ARTIFACT_VALUE_TOO_LARGE");
      }
    }
  }

  async readArray(onItem, maximumItemBytes) {
    await this.expectByte(0x5b);
    await this.skipWhitespace();
    if (await this.peekByte() === 0x5d) {
      this.offset += 1;
      return 0;
    }
    let count = 0;
    for (;;) {
      throwIfFileStreamAborted(this.signal);
      const raw = await this.readRawValue(maximumItemBytes);
      if (raw[0] === "{") assertNoDuplicateJsonObjectKeys(raw);
      await onItem(parseJsonText(raw), raw);
      count += 1;
      await this.skipWhitespace();
      const delimiter = await this.readByte();
      if (delimiter === 0x5d) return count;
      if (delimiter !== 0x2c) streamFailure();
      await this.skipWhitespace();
    }
  }

  async expectEnd() {
    await this.skipWhitespace();
    if (await this.peekByte() !== null) streamFailure();
  }

  async close() {
    this.stream.destroy();
    await this.iterator.return?.().catch(() => undefined);
  }
}

async function* streamJsonArrayItems(path, maximumItemBytes, signal) {
  const reader = new JsonFileReader(path, signal);
  try {
    await reader.expectByte(0x5b);
    await reader.skipWhitespace();
    if (await reader.peekByte() === 0x5d) {
      reader.offset += 1;
      await reader.expectEnd();
      return;
    }
    for (;;) {
      const raw = await reader.readRawValue(maximumItemBytes);
      if (raw[0] === "{") assertNoDuplicateJsonObjectKeys(raw);
      yield parseJsonText(raw);
      await reader.skipWhitespace();
      const delimiter = await reader.readByte();
      if (delimiter === 0x5d) break;
      if (delimiter !== 0x2c) streamFailure();
      await reader.skipWhitespace();
    }
    await reader.expectEnd();
  } finally {
    await reader.close();
  }
}

async function streamJsonObjectArrayMember(path, arrayKey, pageSpoolPath, signal) {
  const reader = new JsonFileReader(path, signal);
  const metadata = Object.create(null);
  const keys = new Set();
  let foundArray = false;
  let pageWriter;
  let metadataBytes = 0;
  try {
    pageWriter = await open(pageSpoolPath, "wx", 0o600);
    await reader.expectByte(0x7b);
    await reader.skipWhitespace();
    if (await reader.peekByte() === 0x7d) reader.offset += 1;
    else {
      for (;;) {
        throwIfFileStreamAborted(signal);
        const keyText = await reader.readRawValue(1_024);
        if (keyText[0] !== '"') streamFailure();
        const key = parseJsonText(keyText);
        if (typeof key !== "string" || keys.has(key)) streamFailure();
        if (keys.size >= MAX_ARTIFACT_TOP_LEVEL_KEYS) {
          streamFailure("ACCOUNTLESS_RETENTION_ARTIFACT_METADATA_TOO_LARGE");
        }
        keys.add(key);
        await reader.expectByte(0x3a);
        if (key === arrayKey) {
          if (foundArray) streamFailure();
          foundArray = true;
          await reader.readArray(async (_page, rawPage) => {
            if (rawPage[0] !== "{") streamFailure("ACCOUNTLESS_RETENTION_SOURCE_PAGE_INVALID");
            assertNoDuplicateJsonObjectKeys(rawPage);
            const page = parseJsonText(rawPage);
            const line = Buffer.from(`${canonical(page)}\n`);
            let offset = 0;
            while (offset < line.length) {
              const written = await pageWriter.write(line, offset, line.length - offset);
              if (written.bytesWritten <= 0) streamFailure();
              offset += written.bytesWritten;
            }
          }, MAX_ARTIFACT_PAGE_BYTES);
        } else {
          const rawValue = await reader.readRawValue(MAX_ARTIFACT_METADATA_VALUE_BYTES);
          metadataBytes += Buffer.byteLength(keyText) + Buffer.byteLength(rawValue);
          if (metadataBytes > MAX_ARTIFACT_METADATA_BYTES) {
            streamFailure("ACCOUNTLESS_RETENTION_ARTIFACT_METADATA_TOO_LARGE");
          }
          metadata[key] = parseJsonText(rawValue);
        }
        await reader.skipWhitespace();
        const delimiter = await reader.readByte();
        if (delimiter === 0x7d) break;
        if (delimiter !== 0x2c) streamFailure();
        await reader.skipWhitespace();
      }
    }
    await reader.expectEnd();
    if (!foundArray) streamFailure("ACCOUNTLESS_RETENTION_SOURCE_PAGE_INVALID");
    await pageWriter.sync();
  } finally {
    await pageWriter?.close();
    await reader.close();
  }
  return { metadata, keys };
}

async function streamCanonicalArtifactDigest(metadata, pageSpoolPath, signal) {
  const hash = createHash("sha256");
  hash.update("{");
  const keys = [...new Set([...Object.keys(metadata), "pages"])].sort();
  let first = true;
  for (const key of keys) {
    throwIfFileStreamAborted(signal);
    if (!first) hash.update(",");
    first = false;
    hash.update(`${JSON.stringify(key)}:`);
    if (key !== "pages") {
      hash.update(canonical(metadata[key]));
      continue;
    }
    hash.update("[");
    let firstPage = true;
    const input = createReadStream(pageSpoolPath, { encoding: "utf8", highWaterMark: 64 * 1_024 });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        throwIfFileStreamAborted(signal);
        if (!firstPage) hash.update(",");
        firstPage = false;
        hash.update(line);
      }
    } finally {
      lines.close();
      input.destroy();
    }
    hash.update("]");
  }
  hash.update("}");
  return hash.digest("hex");
}

/**
 * Verify the sealed D1 artifact and separate mapping JSON files incrementally.
 * Pages are limited to the existing 500-row contract and then one page at a
 * time; no total-row-count cap or whole-artifact array is created.
 */
export async function verifyAccountlessRetentionD1ArtifactFiles({
  artifactPath,
  participantMappingsPath,
  pageSpoolPath,
  expectedArtifactSha256,
  expectedMappingSha256,
  onMappedRow,
  signal,
} = {}) {
  throwIfFileStreamAborted(signal);
  requireHash(expectedArtifactSha256, "ACCOUNTLESS_RETENTION_ARTIFACT_CHECKSUM_REQUIRED");
  requireHash(expectedMappingSha256, "ACCOUNTLESS_RETENTION_MAPPING_CHECKSUM_REQUIRED");
  if (typeof artifactPath !== "string" || typeof participantMappingsPath !== "string"
      || typeof pageSpoolPath !== "string" || typeof onMappedRow !== "function") {
    streamFailure();
  }
  const { metadata, keys } = await streamJsonObjectArrayMember(
    artifactPath,
    "pages",
    pageSpoolPath,
    signal,
  );
  const artifactKeys = [...keys, "pages"];
  exactKeys(Object.fromEntries(artifactKeys.map(key => [key, null])), [
    "schemaVersion", "runId", "state", "sourceRevision", "authorityRevision", "latestMigrationName",
    "snapshotAt", "rowCount", "pageCount", "migrationReceipts", "manifestSha256", "pages",
  ]);
  const artifact = { ...metadata, pages: null };
  if (artifact.schemaVersion !== ACCOUNTLESS_RETENTION_D1_ARTIFACT_SCHEMA
      || typeof artifact.runId !== "string" || !SAFE_RUN_ID.test(artifact.runId)
      || artifact.state !== "extracted"
      || !Number.isSafeInteger(artifact.sourceRevision) || artifact.sourceRevision < 0
      || artifact.authorityRevision !== artifact.sourceRevision
      || artifact.latestMigrationName !== "0063_accountless_history_transfer_source.sql"
      || !Number.isSafeInteger(artifact.rowCount) || artifact.rowCount < 0
      || !Number.isSafeInteger(artifact.pageCount) || artifact.pageCount < 0) {
    streamFailure("ACCOUNTLESS_RETENTION_SOURCE_FENCE_INVALID");
  }
  requireTimestamp(artifact.snapshotAt);
  requireHash(artifact.manifestSha256);
  const artifactSha256 = await streamCanonicalArtifactDigest(metadata, pageSpoolPath, signal);
  if (artifactSha256 !== expectedArtifactSha256) {
    streamFailure("ACCOUNTLESS_RETENTION_ARTIFACT_CHECKSUM_MISMATCH");
  }
  const migrationReceipts = canonicalMigrationNames(artifact.migrationReceipts);

  const mappingSha = createHash("sha256");
  mappingSha.update("[");
  let mappedCount = 0;
  async function* mappings() {
    let first = true;
    for await (const rawMapping of streamJsonArrayItems(participantMappingsPath, MAX_MAPPING_ENTRY_BYTES, signal)) {
      throwIfFileStreamAborted(signal);
      const mapping = normalizeMapping(rawMapping);
      if (!first) mappingSha.update(",");
      first = false;
      mappingSha.update(canonical(mapping));
      mappedCount += 1;
      yield mapping;
    }
    mappingSha.update("]");
    if (mappingSha.digest("hex") !== expectedMappingSha256) {
      streamFailure("ACCOUNTLESS_RETENTION_MAPPING_CHECKSUM_MISMATCH");
    }
  }

  const mappingSource = mappings();
  const nextMapping = mappingSource[Symbol.asyncIterator]();
  let pageCount = 0;
  let seenRows = 0;
  let cursor = "";
  let manifest = manifestSeed(artifact.runId, artifact.sourceRevision);
  const pageInput = createReadStream(pageSpoolPath, { encoding: "utf8", highWaterMark: 64 * 1_024 });
  const pageLines = createInterface({ input: pageInput, crlfDelay: Infinity });
  let pagesVerified = false;
  try {
    for await (const line of pageLines) {
      throwIfFileStreamAborted(signal);
      if (line.length === 0) streamFailure("ACCOUNTLESS_RETENTION_SOURCE_PAGE_INVALID");
      const page = parseJsonText(line);
      exactKeys(page, ["pageNumber", "afterParticipantId", "throughParticipantId", "rowCount", "pageSha256",
        "manifestSha256", "rowDigests", "rows"]);
      pageCount += 1;
      if (page.pageNumber !== pageCount || page.afterParticipantId !== cursor
          || !Number.isSafeInteger(page.rowCount) || page.rowCount < 1 || page.rowCount > 500
          || !Array.isArray(page.rows) || page.rows.length !== page.rowCount
          || !Array.isArray(page.rowDigests) || page.rowDigests.length !== page.rowCount) {
        streamFailure("ACCOUNTLESS_RETENTION_SOURCE_PAGE_INVALID");
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
          streamFailure("ACCOUNTLESS_RETENTION_SOURCE_ROW_CHECKSUM_MISMATCH");
        }
        if (rowIndex > 0 && participantId <= normalizedRows[rowIndex - 1].participant_id) {
          streamFailure("ACCOUNTLESS_RETENTION_SOURCE_ORDER_INVALID");
        }
        return Object.freeze({ participantId, sha256: digest });
      });
      if (page.throughParticipantId !== rowDigests.at(-1)?.participantId
          || rowDigests[0]?.participantId <= cursor
          || page.pageSha256 !== pageDigest(rowDigests)) {
        streamFailure("ACCOUNTLESS_RETENTION_SOURCE_PAGE_CHECKSUM_MISMATCH");
      }
      manifest = manifestStep(manifest, page);
      if (manifest !== page.manifestSha256) {
        streamFailure("ACCOUNTLESS_RETENTION_SOURCE_MANIFEST_MISMATCH");
      }

      for (const row of normalizedRows) {
        const next = await nextMapping.next();
        if (next.done) streamFailure("ACCOUNTLESS_RETENTION_SOURCE_MAPPING_INCOMPLETE");
        const mapping = next.value;
        if (mapping.sourceParticipantId !== row.participant_id) {
          streamFailure("ACCOUNTLESS_RETENTION_SOURCE_MAPPING_INVALID");
        }
        await onMappedRow(mappedRow(row, mapping.target));
      }
      cursor = page.throughParticipantId;
      seenRows += page.rowCount;
    }
    pagesVerified = true;
  } finally {
    pageLines.close();
    pageInput.destroy();
    if (!pagesVerified) await mappingSource.return?.();
  }
  try {
    const extraMapping = await nextMapping.next();
    if (!extraMapping.done || mappedCount !== artifact.rowCount) {
      streamFailure("ACCOUNTLESS_RETENTION_SOURCE_MAPPING_INCOMPLETE");
    }
  } finally {
    await mappingSource.return?.();
  }
  if (seenRows !== artifact.rowCount || pageCount !== artifact.pageCount
      || manifest !== artifact.manifestSha256
      || artifact.rowCount === 0 && artifact.pageCount !== 0
      || artifact.rowCount > 0 && artifact.pageCount === 0) {
    streamFailure("ACCOUNTLESS_RETENTION_SOURCE_COUNT_MISMATCH");
  }
  const fenceDigest = sha256([
    "tibotattle-accountless-retention-d1-fence-v1",
    artifact.runId,
    String(artifact.sourceRevision),
    artifact.manifestSha256,
    artifactSha256,
    expectedMappingSha256,
  ].join("\n"));
  return Object.freeze({
    kind: ACCOUNTLESS_RETENTION_D1_SOURCE_KIND,
    immutable: true,
    snapshotId: `d1-accountless-retention:${artifactSha256}`,
    fenceId: `d1-retention-fence:${fenceDigest}`,
    artifactSha256,
    manifestSha256: artifact.manifestSha256,
    rowCount: artifact.rowCount,
    sourceRevision: artifact.sourceRevision,
    sourceRunId: artifact.runId,
    mappingSha256: expectedMappingSha256,
    migrationReceipts,
    sourceFenceReconciled: false,
  });
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
