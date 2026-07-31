import {
  MAX_PREPARED_CONTRIBUTION_BATCHES,
  PREPARED_CONTRIBUTION_LIMITS,
  PREPARED_CONTRIBUTION_SET_MANIFEST,
  PreparedContributionSetError,
  isPreparedContributionBasename,
  preparedContributionRecordCounts,
  validatePreparedContributionFileEntry,
  validatePreparedContributionManifest,
  validatePreparedTelemetryContributionV01,
} from "../contribution/index.js";
import { stableJson } from "../export/index.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();

function createError(code) {
  return new PreparedContributionSetError(code);
}

function fail(code) {
  throw createError(code);
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function decodeCanonical(bytes, code) {
  let text;
  let value;
  try {
    text = UTF8_DECODER.decode(bytes);
    if (!sameBytes(UTF8_ENCODER.encode(text), bytes)) fail(code);
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof PreparedContributionSetError) throw error;
    fail(code);
  }
  if (stableJson(value) !== text) fail(code);
  return value;
}

function contentBytes(content) {
  try {
    if (typeof content === "string") return UTF8_ENCODER.encode(content);
    if (content instanceof Uint8Array) return new Uint8Array(content);
  } catch {
    // Collapse hostile typed-array access below.
  }
  fail("publication_invalid");
}

function requireStorage(storage) {
  if (storage === null || typeof storage !== "object" || Array.isArray(storage)) {
    throw new TypeError("prepared contribution storage must be an object");
  }
  const required = [
    "canonicalDirectory",
    "publishManifest",
    "publishOwnerOnlyFile",
    "readDirectoryEntries",
    "readOwnerOnlyFile",
  ];
  const captured = {};
  for (const name of required) {
    let value;
    try {
      value = storage[name];
    } catch {
      throw new TypeError(`prepared contribution storage ${name} is invalid`);
    }
    captured[name] = requireFunction(
      value,
      `prepared contribution storage ${name}`,
    );
  }
  return Object.freeze(captured);
}

export function createLocalPreparedContributionContext({
  storage,
  sha256Hex,
} = {}) {
  const ports = requireStorage(storage);
  const digestBytes = requireFunction(sha256Hex, "sha256Hex");

  async function inspectContribution(directory, entry) {
    const bytes = await ports.readOwnerOnlyFile({
      directory,
      name: entry.basename,
      maximumBytes: PREPARED_CONTRIBUTION_LIMITS.maximumContributionBytes,
      createError,
    });
    try {
      const digest = digestBytes(bytes);
      if (entry.bytes !== bytes.byteLength || entry.sha256 !== digest) {
        fail("file_digest");
      }
      const value = decodeCanonical(bytes, "file_schema");
      validatePreparedTelemetryContributionV01(value);
      const counts = preparedContributionRecordCounts(value);
      if (stableJson(counts) !== stableJson(entry.recordCounts)) {
        fail("file_metadata");
      }
      return {
        basename: entry.basename,
        sha256: digest,
        bytes: bytes.byteLength,
        recordCounts: counts,
      };
    } finally {
      bytes.fill(0);
    }
  }

  async function loadVerifiedPreparedContribution({
    directory,
    entry,
  } = {}) {
    const root = await ports.canonicalDirectory(directory, { createError });
    validatePreparedContributionFileEntry(entry);
    const bytes = await ports.readOwnerOnlyFile({
      directory: root,
      name: entry.basename,
      maximumBytes: PREPARED_CONTRIBUTION_LIMITS.maximumContributionBytes,
      createError,
    });
    try {
      const digest = digestBytes(bytes);
      if (entry.bytes !== bytes.byteLength || entry.sha256 !== digest) {
        fail("file_digest");
      }
      const payload = decodeCanonical(bytes, "file_schema");
      validatePreparedTelemetryContributionV01(payload);
      if (stableJson(preparedContributionRecordCounts(payload))
          !== stableJson(entry.recordCounts)) {
        fail("file_metadata");
      }
      return structuredClone(payload);
    } finally {
      bytes.fill(0);
    }
  }

  async function verifyPreparedContributionFiles({
    directory,
    files,
  } = {}) {
    const root = await ports.canonicalDirectory(directory, { createError });
    if (!Array.isArray(files) || files.length < 1
        || files.length > MAX_PREPARED_CONTRIBUTION_BATCHES) {
      fail("manifest_invalid");
    }
    const inspected = [];
    for (const [index, file] of files.entries()) {
      const entry = {
        basename: file?.basename,
        sha256: file?.sha256,
        bytes: file?.bytes,
        recordCounts: file?.recordCounts,
      };
      validatePreparedContributionFileEntry(entry, {
        expectedIndex: index + 1,
      });
      inspected.push(await inspectContribution(root, entry));
    }
    return inspected;
  }

  async function verifyPreparedContributionSet({
    directory,
    builderVersion,
  } = {}) {
    if (typeof builderVersion !== "string" || builderVersion.length < 1) {
      fail("manifest_invalid");
    }
    const root = await ports.canonicalDirectory(directory, { createError });
    const manifestBytes = await ports.readOwnerOnlyFile({
      directory: root,
      name: PREPARED_CONTRIBUTION_SET_MANIFEST,
      maximumBytes: PREPARED_CONTRIBUTION_LIMITS.maximumManifestBytes,
      createError,
      missingCode: "manifest_missing",
      changedCode: "manifest_changed",
    });
    let manifest;
    try {
      manifest = validatePreparedContributionManifest(
        decodeCanonical(manifestBytes, "manifest_invalid"),
        builderVersion,
      );
    } finally {
      manifestBytes.fill(0);
    }
    const allowed = new Set([
      PREPARED_CONTRIBUTION_SET_MANIFEST,
      ...manifest.files.map((entry) => entry.basename),
    ]);
    const entries = await ports.readDirectoryEntries({
      directory: root,
      maximumEntries: MAX_PREPARED_CONTRIBUTION_BATCHES + 1,
      createError,
    });
    if (entries.length !== allowed.size
        || entries.some((entry) => !allowed.has(entry))) {
      fail("manifest_unexpected_entry");
    }
    const inspected = await verifyPreparedContributionFiles({
      directory: root,
      files: manifest.files,
    });
    if (stableJson(inspected) !== stableJson(manifest.files)) {
      fail("file_metadata");
    }
    return structuredClone(manifest);
  }

  async function publishPreparedContributionFile({
    directory,
    name,
    content,
    failpoint = async () => {},
  } = {}) {
    if (!isPreparedContributionBasename(name)
        || typeof failpoint !== "function") {
      fail("publication_invalid");
    }
    const bytes = contentBytes(content);
    try {
      if (bytes.byteLength < 1
          || bytes.byteLength
            > PREPARED_CONTRIBUTION_LIMITS.maximumContributionBytes) {
        fail("publication_invalid");
      }
      const digest = digestBytes(bytes);
      const published = await ports.publishOwnerOnlyFile({
        directory,
        name,
        content: bytes,
        maximumBytes: PREPARED_CONTRIBUTION_LIMITS.maximumContributionBytes,
        createError,
        failpoint,
      });
      return {
        basename: published.basename,
        sha256: digest,
        bytes: published.bytes,
      };
    } finally {
      bytes.fill(0);
    }
  }

  async function publishPreparedContributionManifest({
    directory,
    manifest,
    builderVersion,
    failpoint = async () => {},
  } = {}) {
    validatePreparedContributionManifest(manifest, builderVersion);
    if (typeof failpoint !== "function") fail("publication_invalid");
    const content = stableJson(manifest);
    const bytes = UTF8_ENCODER.encode(content);
    try {
      const digest = digestBytes(bytes);
      const published = await ports.publishManifest({
        directory,
        manifestBasename: PREPARED_CONTRIBUTION_SET_MANIFEST,
        content: bytes,
        maximumBytes: PREPARED_CONTRIBUTION_LIMITS.maximumManifestBytes,
        createError,
        failpoint,
      });
      return {
        basename: PREPARED_CONTRIBUTION_SET_MANIFEST,
        sha256: digest,
        bytes: published.bytes,
      };
    } finally {
      bytes.fill(0);
    }
  }

  return Object.freeze({
    loadVerifiedPreparedContribution,
    publishPreparedContributionFile,
    publishPreparedContributionManifest,
    verifyPreparedContributionFiles,
    verifyPreparedContributionSet,
  });
}
