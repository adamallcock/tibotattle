#!/usr/bin/env node

/**
 * Build and validate the platform-neutral evidence that accompanies a
 * release.  This module is deliberately offline: it reads supplied bytes,
 * verifies their local digests, and emits deterministic JSON/checksum files.
 * Signing, notarization, store submission, publishing, and network lookups
 * belong to the platform-specific release jobs that feed this contract.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  realpath,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  RELEASE_EVIDENCE_ARCHITECTURE_PATTERN,
  RELEASE_EVIDENCE_CHANNELS,
  RELEASE_EVIDENCE_COMMIT_PATTERN,
  RELEASE_EVIDENCE_DEFAULT_UPDATER_MECHANISMS,
  RELEASE_EVIDENCE_DISTRIBUTION_PATTERN,
  RELEASE_EVIDENCE_FORMAT_PATTERN,
  RELEASE_EVIDENCE_GITHUB_REPOSITORY_SLUG_PATTERN,
  RELEASE_EVIDENCE_INPUT_SCHEMA_VERSION,
  RELEASE_EVIDENCE_ALLOWED_PLATFORM_ASSURANCES,
  RELEASE_EVIDENCE_PLATFORM_ASSURANCES,
  RELEASE_EVIDENCE_PLATFORMS,
  RELEASE_EVIDENCE_PROVENANCE_MEDIA_TYPE_PATTERN,
  RELEASE_EVIDENCE_PROVENANCE_PREDICATE_PATTERN,
  RELEASE_EVIDENCE_SAFE_FILE_NAME_PATTERN,
  RELEASE_EVIDENCE_SCHEMA_VERSION,
  RELEASE_EVIDENCE_SHA256_PATTERN,
  RELEASE_EVIDENCE_SBOM_PREDICATE_PATTERN,
  RELEASE_EVIDENCE_SIGNER_DIGEST_PATTERN,
  RELEASE_EVIDENCE_SIGNER_WORKFLOW_PATTERN,
  RELEASE_EVIDENCE_STORE_PROVIDERS,
  RELEASE_EVIDENCE_TAG_PATTERN,
  RELEASE_EVIDENCE_VERSION_PATTERN,
  RELEASE_EVIDENCE_RUN_URL_PATTERN,
} from "../config/release-evidence.js";

export const RELEASE_EVIDENCE_SUMS_FILE_NAME = "SHA256SUMS";
export const RELEASE_EVIDENCE_MANIFEST_FILE_NAME = "release-manifest.json";
export const RELEASE_EVIDENCE_SPDX_FORMAT = "spdx-json";
export const RELEASE_EVIDENCE_SIGSTORE_FORMAT = "sigstore-bundle";

const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_FIELD_BYTES = 1024;

// Release bytes must not depend on the host locale/ICU version.  Relational
// string comparison gives a stable UTF-16 code-unit order on every runner.
function compareCodeUnits(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export class ReleaseEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseEvidenceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReleaseEvidenceError(code, message);
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertPlainObject(value, code, label) {
  assert(isPlainObject(value), code, `${label} must be an object`);
  return value;
}

function assertBoolean(value, code, label) {
  assert(typeof value === "boolean", code, `${label} must be boolean`);
  return value;
}

function assertSafeText(value, code, label, {
  pattern = null,
  maximumBytes = MAX_TEXT_FIELD_BYTES,
} = {}) {
  assert(typeof value === "string" && value.length > 0,
    code, `${label} must be a non-empty string`);
  assert(!value.includes("\0")
      && Buffer.byteLength(value, "utf8") <= maximumBytes,
  code, `${label} contains an invalid string`);
  if (pattern !== null) {
    assert(pattern.test(value), code, `${label} has an invalid value`);
  }
  return value;
}

function assertSha256(value, label) {
  return assertSafeText(value, "RELEASE_EVIDENCE_SHA256_INVALID", label, {
    pattern: RELEASE_EVIDENCE_SHA256_PATTERN,
    maximumBytes: 64,
  });
}

function assertSafeFileName(value, label) {
  assertSafeText(value, "RELEASE_EVIDENCE_UNSAFE_FILE_NAME", label, {
    pattern: RELEASE_EVIDENCE_SAFE_FILE_NAME_PATTERN,
    maximumBytes: 256,
  });
  assert(value !== "." && value !== ".."
      && !value.includes("/")
      && !value.includes("\\")
      && basename(value) === value,
  "RELEASE_EVIDENCE_UNSAFE_FILE_NAME",
  `${label} must be a simple release file name`);
  return value;
}

function assertVersion(value, label = "version") {
  return assertSafeText(value, "RELEASE_EVIDENCE_VERSION_INVALID", label, {
    pattern: RELEASE_EVIDENCE_VERSION_PATTERN,
    maximumBytes: 128,
  });
}

function assertTag(value, label = "tag") {
  return assertSafeText(value, "RELEASE_EVIDENCE_TAG_INVALID", label, {
    pattern: RELEASE_EVIDENCE_TAG_PATTERN,
    maximumBytes: 128,
  });
}

function assertCommit(value, label = "commit") {
  return assertSafeText(value, "RELEASE_EVIDENCE_COMMIT_INVALID", label, {
    pattern: RELEASE_EVIDENCE_COMMIT_PATTERN,
    maximumBytes: 64,
  });
}

function assertRepository(value, label = "repository") {
  assertSafeText(value, "RELEASE_EVIDENCE_REPOSITORY_INVALID", label, {
    maximumBytes: 512,
  });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("RELEASE_EVIDENCE_REPOSITORY_INVALID",
      `${label} must be a canonical HTTPS URL`);
  }
  assert(parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === ""
      && parsed.pathname.length > 1
      && !parsed.pathname.endsWith("/")
      && parsed.href === value,
  "RELEASE_EVIDENCE_REPOSITORY_INVALID",
  `${label} must be a canonical HTTPS repository URL`);
  return value;
}

function assertHttpsUrl(value, code, label, { maximumBytes = 2048 } = {}) {
  assertSafeText(value, code, label, { maximumBytes });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(code, `${label} must be a canonical HTTPS URL`);
  }
  assert(parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === ""
      && parsed.href === value,
  code, `${label} must be a canonical HTTPS URL`);
  return value;
}

function assertToken(value, pattern, code, label) {
  return assertSafeText(value, code, label, {
    pattern,
    maximumBytes: 64,
  });
}

function assertPlatform(value) {
  assert(RELEASE_EVIDENCE_PLATFORMS.includes(value),
    "RELEASE_EVIDENCE_PLATFORM_INVALID",
    `Unsupported release platform: ${String(value)}`);
  return value;
}

function assertChannel(value) {
  assert(RELEASE_EVIDENCE_CHANNELS.includes(value),
    "RELEASE_EVIDENCE_CHANNEL_INVALID",
    `Unsupported release channel: ${String(value)}`);
  return value;
}

function assertArchitecture(value) {
  return assertToken(
    value,
    RELEASE_EVIDENCE_ARCHITECTURE_PATTERN,
    "RELEASE_EVIDENCE_ARCHITECTURE_INVALID",
    "architecture",
  );
}

function assertFormat(value) {
  return assertToken(
    value,
    RELEASE_EVIDENCE_FORMAT_PATTERN,
    "RELEASE_EVIDENCE_FORMAT_INVALID",
    "format",
  );
}

function assertDistribution(value) {
  return assertToken(
    value,
    RELEASE_EVIDENCE_DISTRIBUTION_PATTERN,
    "RELEASE_EVIDENCE_DISTRIBUTION_INVALID",
    "distribution",
  );
}

function assertByteCount(value, label) {
  assert(Number.isSafeInteger(value) && value > 0,
    "RELEASE_EVIDENCE_BYTES_INVALID",
    `${label} must be a positive safe integer`);
  return value;
}

function assertCanonicalSubjectDigest(value, expected, label) {
  assertSha256(value, label);
  assert(value === expected, "RELEASE_EVIDENCE_SUBJECT_MISMATCH",
    `${label} must match the final artifact SHA-256`);
}

function pathWithin(parent, child) {
  const value = relative(resolve(parent), resolve(child));
  return value === ""
    || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

/**
 * JSON values are normalized recursively by key.  Arrays are intentionally
 * preserved as supplied because artifact ordering is canonicalized separately
 * by identity and other arrays (such as SPDX package lists) are meaningful.
 */
export function stableStringify(value) {
  function normalize(current) {
    if (Array.isArray(current)) return current.map(normalize);
    if (isPlainObject(current)) {
      return Object.fromEntries(
        Object.keys(current)
          .sort(compareCodeUnits)
          .map((key) => [key, normalize(current[key])]),
      );
    }
    return current;
  }
  return JSON.stringify(normalize(value));
}

export function sha256Bytes(bytes) {
  assert(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array,
    "RELEASE_EVIDENCE_BYTES_INVALID", "Digest input must be byte data");
  return createHash("sha256").update(bytes).digest("hex");
}

async function regularFileInfo(path, label, maximumBytes = null) {
  const selected = resolve(path);
  let metadata;
  try {
    metadata = await lstat(selected);
  } catch (error) {
    fail("RELEASE_EVIDENCE_FILE_UNAVAILABLE",
      `${label} is missing or cannot be inspected: ${error.message}`);
  }
  assert(metadata.isFile() && !metadata.isSymbolicLink(),
    "RELEASE_EVIDENCE_SYMLINK_OR_NONFILE",
    `${label} must be a regular, non-symlink file`);
  // `lstat` above rejects the file itself being a symlink.  Do not compare
  // `realpath(selected)` with `selected`: macOS commonly exposes /var (and
  // temporary directories below it) through a system symlink, which is a
  // harmless parent-directory alias rather than a replaceable artifact.
  try {
    await realpath(selected);
  } catch (error) {
    fail("RELEASE_EVIDENCE_FILE_UNAVAILABLE",
      `${label} cannot be resolved: ${error.message}`);
  }
  assertByteCount(metadata.size, label);
  if (maximumBytes !== null) {
    assert(metadata.size <= maximumBytes, "RELEASE_EVIDENCE_FILE_TOO_LARGE",
      `${label} exceeds the metadata size limit`);
  }
  return Object.freeze({ path: selected, size: metadata.size });
}

async function digestRegularFile(path, label, maximumBytes = null) {
  const initial = await regularFileInfo(path, label, maximumBytes);
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(initial.path);
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on("error", rejectPromise);
    stream.on("end", resolvePromise);
  }).catch((error) => {
    fail("RELEASE_EVIDENCE_FILE_UNAVAILABLE",
      `${label} could not be read: ${error.message}`);
  });
  const final = await regularFileInfo(initial.path, label, maximumBytes);
  assert(bytes === final.size && final.size === initial.size,
    "RELEASE_EVIDENCE_FILE_CHANGED",
    `${label} changed while it was being hashed`);
  return Object.freeze({
    path: initial.path,
    bytes,
    sha256: hash.digest("hex"),
  });
}

async function readJsonFile(path, label) {
  const info = await regularFileInfo(path, label, MAX_METADATA_BYTES);
  let bytes;
  try {
    bytes = await readFile(info.path);
  } catch (error) {
    fail("RELEASE_EVIDENCE_FILE_UNAVAILABLE",
      `${label} could not be read: ${error.message}`);
  }
  assert(bytes.length === info.size, "RELEASE_EVIDENCE_FILE_CHANGED",
    `${label} changed while it was being read`);
  // Hash a second exact read and compare it with the buffer that will be
  // parsed.  This closes the same-size replacement window between the initial
  // read and JSON parsing without pretending this local helper is a signing
  // operation.
  const digest = await digestRegularFile(info.path, label, MAX_METADATA_BYTES);
  assert(digest.bytes === bytes.length && digest.sha256 === sha256Bytes(bytes),
    "RELEASE_EVIDENCE_FILE_CHANGED",
    `${label} changed while it was being parsed`);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("RELEASE_EVIDENCE_JSON_INVALID", `${label} is not valid JSON`);
  }
  return Object.freeze({
    bytes: info.size,
    sha256: digest.sha256,
    value: parsed,
  });
}

function resolveDescriptorPath(value, baseDir, label) {
  assertSafeText(value, "RELEASE_EVIDENCE_PATH_INVALID", label, {
    maximumBytes: 4096,
  });
  const selected = resolve(baseDir, value);
  // The path itself may be absolute when an external build staging directory
  // is supplied.  It is never serialized into the public manifest.
  assert(isAbsolute(value) || pathWithin(baseDir, selected),
    "RELEASE_EVIDENCE_UNSAFE_PATH",
    `${label} escapes the descriptor base directory`);
  assert(!selected.includes("\0"), "RELEASE_EVIDENCE_PATH_INVALID",
    `${label} contains an invalid path`);
  return selected;
}

function sourceObject({ version, tag, commit, repository }) {
  return {
    version,
    tag,
    commit,
    repository,
  };
}

function normalizeSource({ value, release, label }) {
  if (value === undefined) return sourceObject(release);
  const selected = assertPlainObject(
    value,
    "RELEASE_EVIDENCE_SOURCE_INVALID",
    label,
  );
  assertAllowedKeys(
    selected,
    ["version", "tag", "commit", "repository"],
    label,
    "RELEASE_EVIDENCE_SOURCE_INVALID",
  );
  const normalized = sourceObject({
    version: selected.version === undefined ? release.version : selected.version,
    tag: selected.tag === undefined ? release.tag : selected.tag,
    commit: selected.commit === undefined ? release.commit : selected.commit,
    repository: selected.repository === undefined
      ? release.repository
      : selected.repository,
  });
  assert(normalized.version === release.version,
    "RELEASE_EVIDENCE_VERSION_MISMATCH",
    `${label}.version does not match the release`);
  assert(normalized.tag === release.tag
      && normalized.commit === release.commit
      && normalized.repository === release.repository,
  "RELEASE_EVIDENCE_SOURCE_MISMATCH",
  `${label} does not identify the exact release source`);
  return normalized;
}

function validateReleaseIdentity(input) {
  assertPlainObject(input, "RELEASE_EVIDENCE_INPUT_INVALID", "release input");
  assertAllowedKeys(
    input,
    ["schemaVersion", "product", "version", "tag", "commit", "repository", "artifacts"],
    "release input",
    "RELEASE_EVIDENCE_INPUT_INVALID",
  );
  if (input.schemaVersion !== undefined) {
    assert(input.schemaVersion === RELEASE_EVIDENCE_INPUT_SCHEMA_VERSION
        || input.schemaVersion === RELEASE_EVIDENCE_SCHEMA_VERSION,
    "RELEASE_EVIDENCE_SCHEMA_INVALID",
    "release input has an unsupported schema version");
  }
  const product = assertPlainObject(
    input.product,
    "RELEASE_EVIDENCE_PRODUCT_INVALID",
    "product",
  );
  assertAllowedKeys(product, ["name"], "product", "RELEASE_EVIDENCE_PRODUCT_INVALID");
  assertSafeText(product.name, "RELEASE_EVIDENCE_PRODUCT_INVALID", "product.name");
  const release = {
    version: assertVersion(input.version),
    tag: assertTag(input.tag),
    commit: assertCommit(input.commit),
    repository: assertRepository(input.repository),
  };
  assert(release.tag === `v${release.version}`
      || release.tag.startsWith(`v${release.version}-`)
      || release.tag.startsWith(`v${release.version}+`),
  "RELEASE_EVIDENCE_VERSION_MISMATCH",
  "tag must identify the supplied version");
  return Object.freeze({
    product: Object.freeze({ name: product.name }),
    release: Object.freeze(release),
  });
}

function validateAssurances(value, platform, channel, label) {
  const assurances = assertPlainObject(
    value,
    "RELEASE_EVIDENCE_ASSURANCES_INVALID",
    label,
  );
  for (const [key, assurance] of Object.entries(assurances)) {
    assert(RELEASE_EVIDENCE_ALLOWED_PLATFORM_ASSURANCES[platform][channel].includes(key),
      "RELEASE_EVIDENCE_ASSURANCES_UNKNOWN",
      `${label}.${key} is not an allowed assurance for ${platform}/${channel}`);
    assert(typeof assurance === "boolean",
      "RELEASE_EVIDENCE_ASSURANCES_INVALID",
      `${label}.${key} must be boolean`);
  }
  for (const key of RELEASE_EVIDENCE_PLATFORM_ASSURANCES[platform][channel]) {
    assert(assurances[key] === true,
      "RELEASE_EVIDENCE_ASSURANCES_INCOMPLETE",
      `${label}.${key} must be true for ${platform}/${channel}`);
  }
  return assurances;
}

function normalizeStore(value, platform, channel, label) {
  if (channel === "direct") {
    assert(value === undefined || value === null,
      "RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
      `${label} is not allowed on a direct artifact`);
    return null;
  }
  const store = assertPlainObject(value, "RELEASE_EVIDENCE_STORE_INVALID", label);
  assertAllowedKeys(
    store,
    ["provider", "listing"],
    label,
    "RELEASE_EVIDENCE_STORE_INVALID",
  );
  const provider = assertSafeText(
    store.provider,
    "RELEASE_EVIDENCE_STORE_INVALID",
    `${label}.provider`,
    { pattern: /^[a-z][a-z0-9-]{1,63}$/u, maximumBytes: 64 },
  );
  assert(RELEASE_EVIDENCE_STORE_PROVIDERS[platform].includes(provider),
    "RELEASE_EVIDENCE_STORE_INVALID",
    `${label}.provider is not valid for ${platform}`);
  const result = { provider };
  if (store.listing !== undefined) {
    result.listing = assertSafeText(
      store.listing,
      "RELEASE_EVIDENCE_STORE_INVALID",
      `${label}.listing`,
      { maximumBytes: 512 },
    );
  }
  return result;
}

function assertAllowedKeys(
  value,
  allowed,
  label,
  code = "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID",
) {
  for (const key of Object.keys(value)) {
    assert(allowed.includes(key), code,
      `${label}.${key} is not supported by the checked-in contract`);
  }
}

function normalizeNativeTrust({ value, platform, channel, store, label }) {
  const trust = assertPlainObject(
    value,
    "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID",
    label,
  );
  if (channel === "store") {
    assertAllowedKeys(trust, ["provider", "publisher", "listing"], label);
    const provider = assertSafeText(trust.provider,
      "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID", `${label}.provider`, {
        pattern: /^[a-z][a-z0-9-]{1,63}$/u,
        maximumBytes: 64,
      });
    assert(store?.provider === provider,
      "RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
      `${label}.provider must match the store distribution`);
    return {
      provider,
      publisher: assertSafeText(trust.publisher,
        "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID", `${label}.publisher`, {
          maximumBytes: 512,
        }),
      listing: assertSafeText(trust.listing,
        "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID", `${label}.listing`, {
          maximumBytes: 512,
        }),
    };
  }
  if (platform === "macos") {
    assertAllowedKeys(trust, ["signerIdentity", "teamId"], label);
    return {
      signerIdentity: assertSafeText(trust.signerIdentity,
        "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID", `${label}.signerIdentity`, {
          maximumBytes: 512,
        }),
      teamId: assertSafeText(trust.teamId,
        "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID", `${label}.teamId`, {
          pattern: /^[A-Z0-9]{10}$/u,
          maximumBytes: 10,
        }),
    };
  }
  if (platform === "windows") {
    assertAllowedKeys(trust, ["publisher", "certificateSha256", "timestampAuthority"], label);
    const result = {
      publisher: assertSafeText(trust.publisher,
        "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID", `${label}.publisher`, {
          maximumBytes: 512,
        }),
      certificateSha256: assertSha256(
        trust.certificateSha256,
        `${label}.certificateSha256`,
      ),
    };
    if (trust.timestampAuthority !== undefined) {
      result.timestampAuthority = assertSafeText(
        trust.timestampAuthority,
        "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID",
        `${label}.timestampAuthority`,
        { maximumBytes: 512 },
      );
    }
    return result;
  }
  assertAllowedKeys(trust, ["scheme", "keyFingerprint"], label);
  const scheme = assertToken(
    trust.scheme,
    /^[a-z][a-z0-9-]{1,63}$/u,
    "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID",
    `${label}.scheme`,
  );
  assert(["none", "appimage-detached", "apt-repository", "rpm-repository"].includes(scheme),
    "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID",
    `${label}.scheme is not supported for Linux direct artifacts`);
  if (scheme === "none") {
    assert(trust.keyFingerprint === undefined,
      "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID",
      `${label}.keyFingerprint is not valid when scheme is none`);
    return { scheme };
  }
  return {
    scheme,
    keyFingerprint: assertSafeText(
      trust.keyFingerprint,
      "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID",
      `${label}.keyFingerprint`,
      { pattern: /^[A-Fa-f0-9]{40,64}$/u, maximumBytes: 64 },
    ).toUpperCase(),
  };
}

function normalizeBuild(value, channel, label) {
  if (channel === "store" && (value === undefined || value === null)) return null;
  const build = assertPlainObject(
    value,
    "RELEASE_EVIDENCE_BUILD_INVALID",
    label,
  );
  assertAllowedKeys(
    build,
    ["sourceManifestSha256", "unsignedPayloadSha256"],
    label,
    "RELEASE_EVIDENCE_BUILD_INVALID",
  );
  return {
    sourceManifestSha256: assertSha256(
      build.sourceManifestSha256,
      `${label}.sourceManifestSha256`,
    ),
    unsignedPayloadSha256: assertSha256(
      build.unsignedPayloadSha256,
      `${label}.unsignedPayloadSha256`,
    ),
  };
}

function validateDistribution({
  value,
  channel,
  platform,
  store,
  source,
  fileName,
  downloadUrl,
  label,
}) {
  const distribution = assertDistribution(value);
  if (channel === "store") {
    assert(store !== null && distribution === store.provider,
      "RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
      `${label} must identify the supplied store provider`);
  } else {
    assert(!RELEASE_EVIDENCE_STORE_PROVIDERS[platform].includes(distribution),
      "RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
      `${label} cannot identify a store provider for a direct artifact`);
  }
  const selectedUrl = assertHttpsUrl(
    downloadUrl,
    "RELEASE_EVIDENCE_DOWNLOAD_URL_INVALID",
    "artifact.downloadUrl",
  );
  if (distribution === "github-release") {
    const repositoryUrl = new URL(source.repository);
    const expectedPath = `${repositoryUrl.pathname}/releases/download/`
      + `${encodeURIComponent(source.tag)}/${encodeURIComponent(fileName)}`;
    let actualPath;
    try {
      actualPath = new URL(selectedUrl).pathname;
    } catch {
      fail("RELEASE_EVIDENCE_DOWNLOAD_URL_INVALID",
        "artifact.downloadUrl must be a canonical HTTPS URL");
    }
    assert(new URL(selectedUrl).origin === repositoryUrl.origin
        && actualPath === expectedPath,
    "RELEASE_EVIDENCE_DOWNLOAD_URL_MISMATCH",
    "GitHub release downloadUrl must identify the exact tag and artifact file");
  }
  return distribution;
}

function normalizeSignerMetadata({ value, source, label }) {
  assertAllowedKeys(value, [
    "mediaType",
    "predicateType",
    "builderId",
    "fileName",
    "bytes",
    "sha256",
    "subjectSha256",
    "signerRepository",
    "signerWorkflow",
    "signerDigest",
    "runUrl",
    "denySelfHostedRunners",
    "path",
    "file",
  ], label, "RELEASE_EVIDENCE_PROVENANCE_INVALID");
  const signerWorkflow = assertSafeText(
    value.signerWorkflow,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.signerWorkflow`,
    { pattern: RELEASE_EVIDENCE_SIGNER_WORKFLOW_PATTERN, maximumBytes: 512 },
  );
  const repository = new URL(source.repository);
  assert(repository.hostname === "github.com",
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.signerWorkflow requires a GitHub repository source`);
  const repositorySlug = repository.pathname.slice(1);
  const signerRepository = assertSafeText(
    value.signerRepository === undefined ? repositorySlug : value.signerRepository,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.signerRepository`,
    {
      pattern: RELEASE_EVIDENCE_GITHUB_REPOSITORY_SLUG_PATTERN,
      maximumBytes: 256,
    },
  );
  assert(signerWorkflow.startsWith(`${signerRepository}/.github/workflows/`),
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.signerWorkflow must belong to signerRepository`);
  if (value.signerRepository === undefined) {
    assert(signerRepository === repositorySlug,
      "RELEASE_EVIDENCE_PROVENANCE_INVALID",
      `${label}.signerWorkflow must belong to the release repository unless signerRepository is explicit`);
  }
  const signerDigest = assertSafeText(
    value.signerDigest,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.signerDigest`,
    { pattern: RELEASE_EVIDENCE_SIGNER_DIGEST_PATTERN, maximumBytes: 40 },
  );
  const runUrl = assertHttpsUrl(
    value.runUrl,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.runUrl`,
    { maximumBytes: 512 },
  );
  const sourceRepositoryUrl = new URL(source.repository);
  const signerRepositoryUrl = new URL(`https://github.com/${signerRepository}`);
  const sourceRunPrefix = `${sourceRepositoryUrl.origin}${sourceRepositoryUrl.pathname}/actions/runs/`;
  const signerRunPrefix = `${signerRepositoryUrl.origin}${signerRepositoryUrl.pathname}/actions/runs/`;
  assert(runUrl.startsWith(sourceRunPrefix) || runUrl.startsWith(signerRunPrefix),
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.runUrl must belong to the release or signer repository`);
  const denySelfHostedRunners = assertBoolean(
    value.denySelfHostedRunners,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.denySelfHostedRunners`,
  );
  assert(denySelfHostedRunners === true,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.denySelfHostedRunners must be true`);
  return {
    signerRepository,
    signerWorkflow,
    signerDigest,
    runUrl,
    verificationInputs: {
      command: "gh attestation verify --bundle",
      bundleRequired: true,
      denySelfHostedRunners: true,
    },
  };
}

function normalizeAttestationMetadata({
  value,
  source,
  artifactDigest,
  file,
  label,
  kind = "provenance",
}) {
  const selected = assertPlainObject(
    value,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    label,
  );
  const mediaType = assertSafeText(
    selected.mediaType,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.mediaType`,
    { pattern: RELEASE_EVIDENCE_PROVENANCE_MEDIA_TYPE_PATTERN },
  );
  const predicateType = assertSafeText(
    selected.predicateType,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.predicateType`,
    {
      pattern: kind === "sbom"
        ? RELEASE_EVIDENCE_SBOM_PREDICATE_PATTERN
        : RELEASE_EVIDENCE_PROVENANCE_PREDICATE_PATTERN,
    },
  );
  assertCanonicalSubjectDigest(
    selected.subjectSha256 === undefined ? artifactDigest : selected.subjectSha256,
    artifactDigest,
    `${label}.subjectSha256`,
  );
  const signer = normalizeSignerMetadata({
    value: selected,
    source,
    label,
  });
  const builderId = assertSafeText(
    selected.builderId,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.builderId`,
    { maximumBytes: 2048 },
  );
  const fileName = assertSafeFileName(
    selected.fileName === undefined ? basename(file.path) : selected.fileName,
    `${label}.fileName`,
  );
  assert(fileName === basename(file.path),
    "RELEASE_EVIDENCE_FILE_NAME_MISMATCH",
    `${label}.fileName must match the supplied file name`);
  return {
    format: RELEASE_EVIDENCE_SIGSTORE_FORMAT,
    mediaType,
    predicateType,
    builderId,
    fileName,
    bytes: file.bytes,
    sha256: file.sha256,
    subjectSha256: artifactDigest,
    source: sourceObject(source),
    ...signer,
  };
}

function validateSpdxJson(value, label) {
  const sbom = assertPlainObject(value, "RELEASE_EVIDENCE_SBOM_INVALID", label);
  assert(typeof sbom.spdxVersion === "string"
      && /^SPDX-\d+\.\d+$/u.test(sbom.spdxVersion),
  "RELEASE_EVIDENCE_SBOM_INVALID",
  `${label}.spdxVersion must identify an SPDX JSON document`);
  assert(typeof sbom.SPDXID === "string" && sbom.SPDXID.startsWith("SPDXRef-"),
    "RELEASE_EVIDENCE_SBOM_INVALID", `${label}.SPDXID is required`);
  assert(typeof sbom.name === "string" && sbom.name.length > 0,
    "RELEASE_EVIDENCE_SBOM_INVALID", `${label}.name is required`);
  assert(typeof sbom.documentNamespace === "string"
      && sbom.documentNamespace.length > 0,
  "RELEASE_EVIDENCE_SBOM_INVALID",
  `${label}.documentNamespace is required`);
  assertPlainObject(sbom.creationInfo, "RELEASE_EVIDENCE_SBOM_INVALID",
    `${label}.creationInfo`);
  assert(Array.isArray(sbom.packages), "RELEASE_EVIDENCE_SBOM_INVALID",
    `${label}.packages must be an array`);
  return sbom;
}

function normalizeSbom({ value, source, artifactDigest, file, attestation }) {
  validateSpdxJson(value, "sbom");
  const selected = assertPlainObject(file, "RELEASE_EVIDENCE_SBOM_INVALID", "sbom file");
  assertCanonicalSubjectDigest(
    selected.subjectSha256 === undefined ? artifactDigest : selected.subjectSha256,
    artifactDigest,
    "sbom.subjectSha256",
  );
  const fileName = assertSafeFileName(
    file.fileName === undefined ? basename(file.path) : file.fileName,
    "sbom.fileName",
  );
  assert(fileName === basename(file.path),
    "RELEASE_EVIDENCE_FILE_NAME_MISMATCH",
    "sbom.fileName must match the supplied file name");
  return {
    format: RELEASE_EVIDENCE_SPDX_FORMAT,
    fileName,
    bytes: selected.bytes,
    sha256: selected.sha256,
    subjectSha256: artifactDigest,
    // Keep the source association explicit even though SPDX itself may carry
    // a different package/document namespace structure.
    source: sourceObject(source),
    attestation,
  };
}

function normalizeUpdater({ value, platform, channel, artifactDigest, baseDir }) {
  const updater = assertPlainObject(
    value,
    "RELEASE_EVIDENCE_UPDATER_INVALID",
    "updater",
  );
  assertAllowedKeys(
    updater,
    ["enabled", "mechanism", "metadata"],
    "updater",
    "RELEASE_EVIDENCE_UPDATER_INVALID",
  );
  const enabled = assertBoolean(
    updater.enabled,
    "RELEASE_EVIDENCE_UPDATER_INVALID",
    "updater.enabled",
  );
  const mechanism = assertToken(
    updater.mechanism,
    /^[a-z][a-z0-9-]{1,63}$/u,
    "RELEASE_EVIDENCE_UPDATER_INVALID",
    "updater.mechanism",
  );
  assert(RELEASE_EVIDENCE_DEFAULT_UPDATER_MECHANISMS[platform].includes(mechanism),
    "RELEASE_EVIDENCE_UPDATER_INVALID",
    `updater.mechanism ${mechanism} is not valid for ${platform}`);
  if (channel === "store") {
    assert(!enabled && mechanism === "store-managed",
      "RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
      "store artifacts must use the store-managed updater");
  } else {
    assert(mechanism !== "store-managed",
      "RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
      "direct artifacts cannot use the store-managed updater");
  }
  let metadata = null;
  if (enabled) {
    const descriptor = assertPlainObject(
      updater.metadata,
      "RELEASE_EVIDENCE_UPDATER_INVALID",
      "updater.metadata",
    );
    assertAllowedKeys(
      descriptor,
      ["path", "file", "fileName", "bytes", "sha256", "subjectSha256", "_digest"],
      "updater.metadata",
      "RELEASE_EVIDENCE_UPDATER_INVALID",
    );
    const metadataPath = descriptor.path === undefined
      ? descriptor.file
      : descriptor.path;
    const selectedPath = resolveDescriptorPath(
      metadataPath,
      baseDir,
      "updater.metadata.path",
    );
    const file = descriptor._digest ?? null;
    assert(file !== null, "RELEASE_EVIDENCE_UPDATER_INVALID",
      "updater.metadata must be supplied as a regular file");
    const fileName = assertSafeFileName(
        descriptor.fileName === undefined
          ? basename(selectedPath)
          : descriptor.fileName,
        "updater.metadata.fileName",
      );
    assert(fileName === basename(selectedPath),
      "RELEASE_EVIDENCE_FILE_NAME_MISMATCH",
      "updater.metadata.fileName must match the supplied file name");
    metadata = {
      fileName,
      bytes: file.bytes,
      sha256: file.sha256,
      subjectSha256: artifactDigest,
    };
    if (descriptor.bytes !== undefined) {
      assert(descriptor.bytes === file.bytes, "RELEASE_EVIDENCE_BYTES_MISMATCH",
        "updater metadata byte count does not match the supplied file");
    }
    if (descriptor.sha256 !== undefined) {
      assert(descriptor.sha256 === file.sha256, "RELEASE_EVIDENCE_HASH_MISMATCH",
        "updater metadata SHA-256 does not match the supplied file");
    }
    if (descriptor.subjectSha256 !== undefined) {
      assertCanonicalSubjectDigest(
        descriptor.subjectSha256,
        artifactDigest,
        "updater.metadata.subjectSha256",
      );
    }
  } else {
    assert(updater.metadata === undefined || updater.metadata === null,
      "RELEASE_EVIDENCE_UPDATER_INVALID",
      "disabled updater must not carry update metadata");
  }
  return { enabled, mechanism, metadata };
}

async function digestDescriptorFile(value, baseDir, label, maximumBytes) {
  const pathValue = value?.path === undefined ? value?.file : value?.path;
  const path = resolveDescriptorPath(pathValue, baseDir, `${label}.path`);
  const digest = await digestRegularFile(path, label, maximumBytes);
  if (value.bytes !== undefined) {
    assert(value.bytes === digest.bytes, "RELEASE_EVIDENCE_BYTES_MISMATCH",
      `${label}.bytes does not match the supplied file`);
  }
  if (value.sha256 !== undefined) {
    assert(value.sha256 === digest.sha256, "RELEASE_EVIDENCE_HASH_MISMATCH",
      `${label}.sha256 does not match the supplied file`);
  }
  return digest;
}

function artifactIdentity(artifact) {
  return [
    artifact.channel,
    artifact.platform,
    artifact.architecture,
    artifact.format,
    artifact.fileName,
  ].join("/");
}

function compareArtifactIdentity(left, right) {
  return compareCodeUnits(artifactIdentity(left), artifactIdentity(right));
}

async function normalizeArtifact(descriptor, release, baseDir) {
  const selected = assertPlainObject(
    descriptor,
    "RELEASE_EVIDENCE_ARTIFACT_INVALID",
    "artifact",
  );
  assertAllowedKeys(
    selected,
    [
      "platform",
      "channel",
      "architecture",
      "format",
      "version",
      "path",
      "file",
      "fileName",
      "bytes",
      "sha256",
      "source",
      "distribution",
      "downloadUrl",
      "nativeTrust",
      "build",
      "sbom",
      "provenance",
      "assurances",
      "platformAssurances",
      "store",
      "updater",
    ],
    "artifact",
    "RELEASE_EVIDENCE_ARTIFACT_INVALID",
  );
  const platform = assertPlatform(selected.platform);
  const channel = assertChannel(selected.channel);
  const architecture = assertArchitecture(selected.architecture);
  const format = assertFormat(selected.format);
  const artifactPath = resolveDescriptorPath(
    selected.path === undefined ? selected.file : selected.path,
    baseDir,
    "artifact.path",
  );
  const artifactFile = await digestRegularFile(
    artifactPath,
    "artifact",
    null,
  );
  const fileName = assertSafeFileName(
    selected.fileName === undefined ? basename(artifactPath) : selected.fileName,
    "artifact.fileName",
  );
  assert(fileName === basename(artifactPath),
    "RELEASE_EVIDENCE_FILE_NAME_MISMATCH",
    "artifact.fileName must match the supplied file name");
  if (selected.bytes !== undefined) {
    assert(selected.bytes === artifactFile.bytes, "RELEASE_EVIDENCE_BYTES_MISMATCH",
      "artifact.bytes does not match the supplied file");
  }
  if (selected.sha256 !== undefined) {
    assert(selected.sha256 === artifactFile.sha256, "RELEASE_EVIDENCE_HASH_MISMATCH",
      "artifact.sha256 does not match the supplied file");
  }
  const artifactVersion = selected.version === undefined
    ? release.version
    : selected.version;
  assertVersion(artifactVersion, "artifact.version");
  assert(artifactVersion === release.version,
    "RELEASE_EVIDENCE_VERSION_MISMATCH",
    "artifact.version does not match the release");
  const source = normalizeSource({
    value: selected.source,
    release,
    label: "artifact.source",
  });

  const sbomDescriptor = assertPlainObject(
    selected.sbom,
    "RELEASE_EVIDENCE_SBOM_INVALID",
    "artifact.sbom",
  );
  assertAllowedKeys(
    sbomDescriptor,
    ["path", "file", "fileName", "bytes", "sha256", "subjectSha256", "attestation"],
    "artifact.sbom",
    "RELEASE_EVIDENCE_SBOM_INVALID",
  );
  const sbomDigest = await digestDescriptorFile(
    sbomDescriptor,
    baseDir,
    "SBOM",
    MAX_METADATA_BYTES,
  );
  const sbomJson = await readJsonFile(sbomDigest.path, "SBOM");
  const sbomAttestationDescriptor = assertPlainObject(
    sbomDescriptor.attestation,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    "sbom.attestation",
  );
  const sbomAttestationDigest = await digestDescriptorFile(
    sbomAttestationDescriptor,
    baseDir,
    "SBOM attestation bundle",
    MAX_METADATA_BYTES,
  );
  const sbomAttestationJson = await readJsonFile(
    sbomAttestationDigest.path,
    "SBOM attestation bundle",
  );
  assertPlainObject(
    sbomAttestationJson.value,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    "SBOM attestation bundle",
  );
  const sbomAttestation = normalizeAttestationMetadata({
    value: {
      ...sbomAttestationDescriptor,
      fileName: sbomAttestationDescriptor.fileName,
      subjectSha256: sbomAttestationDescriptor.subjectSha256,
    },
    source,
    artifactDigest: artifactFile.sha256,
    file: sbomAttestationDigest,
    label: "sbom.attestation",
    kind: "sbom",
  });
  const sbom = normalizeSbom({
    value: sbomJson.value,
    source,
    artifactDigest: artifactFile.sha256,
    file: {
      ...sbomDigest,
      fileName: sbomDescriptor.fileName,
      subjectSha256: sbomDescriptor.subjectSha256,
    },
    attestation: sbomAttestation,
  });

  const provenanceDescriptor = assertPlainObject(
    selected.provenance,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    "artifact.provenance",
  );
  assertAllowedKeys(
    provenanceDescriptor,
    [
      "path",
      "file",
      "fileName",
      "bytes",
      "sha256",
      "subjectSha256",
      "mediaType",
      "predicateType",
      "builderId",
      "signerRepository",
      "signerWorkflow",
      "signerDigest",
      "runUrl",
      "denySelfHostedRunners",
    ],
    "artifact.provenance",
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
  );
  const provenanceDigest = await digestDescriptorFile(
    provenanceDescriptor,
    baseDir,
    "provenance bundle",
    MAX_METADATA_BYTES,
  );
  const provenanceJson = await readJsonFile(
    provenanceDigest.path,
    "provenance bundle",
  );
  assertPlainObject(
    provenanceJson.value,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    "provenance bundle",
  );
  const provenance = normalizeAttestationMetadata({
    value: {
      ...provenanceDescriptor,
      fileName: provenanceDescriptor.fileName,
      subjectSha256: provenanceDescriptor.subjectSha256,
    },
    source,
    artifactDigest: artifactFile.sha256,
    file: provenanceDigest,
    label: "provenance",
  });

  const updaterInput = selected.updater;
  assert(updaterInput !== undefined, "RELEASE_EVIDENCE_UPDATER_INVALID",
    "artifact.updater is required");
  let updaterDescriptor = updaterInput;
  if (isPlainObject(updaterInput)
      && updaterInput.enabled === true
      && isPlainObject(updaterInput.metadata)) {
    const metadataDigest = await digestDescriptorFile(
      updaterInput.metadata,
      baseDir,
      "updater metadata",
      MAX_METADATA_BYTES,
    );
    updaterDescriptor = {
      ...updaterInput,
      metadata: {
        ...updaterInput.metadata,
        _digest: metadataDigest,
      },
    };
  }
  const updater = normalizeUpdater({
    value: updaterDescriptor,
    platform,
    channel,
    artifactDigest: artifactFile.sha256,
    baseDir,
  });
  const assurances = validateAssurances(
    selected.assurances === undefined
      ? selected.platformAssurances
      : selected.assurances,
    platform,
    channel,
    "artifact.assurances",
  );
  const store = normalizeStore(
    selected.store,
    platform,
    channel,
    "artifact.store",
  );
  const nativeTrust = normalizeNativeTrust({
    value: selected.nativeTrust,
    platform,
    channel,
    store,
    label: "artifact.nativeTrust",
  });
  const build = normalizeBuild(selected.build, channel, "artifact.build");
  const distribution = validateDistribution({
    value: selected.distribution,
    channel,
    platform,
    store,
    source,
    fileName,
    downloadUrl: selected.downloadUrl,
    label: "artifact.distribution",
  });

  return {
    platform,
    channel,
    architecture,
    format,
    version: release.version,
    distribution,
    downloadUrl: selected.downloadUrl,
    fileName,
    bytes: artifactFile.bytes,
    sha256: artifactFile.sha256,
    source,
    nativeTrust,
    build,
    sbom,
    provenance,
    assurances,
    store,
    updater,
  };
}

function validateCanonicalAttestation(value, {
  label,
  release,
  artifactDigest,
  kind = "provenance",
}) {
  const attestation = assertPlainObject(
    value,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    label,
  );
  assertAllowedKeys(attestation, [
    "format",
    "mediaType",
    "predicateType",
    "builderId",
    "signerRepository",
    "signerWorkflow",
    "signerDigest",
    "runUrl",
    "verificationInputs",
    "fileName",
    "bytes",
    "sha256",
    "subjectSha256",
    "source",
  ], label, "RELEASE_EVIDENCE_PROVENANCE_INVALID");
  assert(attestation.format === RELEASE_EVIDENCE_SIGSTORE_FORMAT,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.format is invalid`);
  assertSafeFileName(attestation.fileName, `${label}.fileName`);
  assertByteCount(attestation.bytes, `${label}.bytes`);
  assertSha256(attestation.sha256, `${label}.sha256`);
  assertSafeText(attestation.mediaType, "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.mediaType`, { pattern: RELEASE_EVIDENCE_PROVENANCE_MEDIA_TYPE_PATTERN });
  assertSafeText(attestation.predicateType, "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.predicateType`, {
      pattern: kind === "sbom"
        ? RELEASE_EVIDENCE_SBOM_PREDICATE_PATTERN
        : RELEASE_EVIDENCE_PROVENANCE_PREDICATE_PATTERN,
    });
  assertSafeText(attestation.builderId, "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.builderId`, { maximumBytes: 2048 });
  assertCanonicalSubjectDigest(attestation.subjectSha256, artifactDigest,
    `${label}.subjectSha256`);
  const signerWorkflow = assertSafeText(
    attestation.signerWorkflow,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.signerWorkflow`,
    { pattern: RELEASE_EVIDENCE_SIGNER_WORKFLOW_PATTERN, maximumBytes: 512 },
  );
  const repositoryUrl = new URL(release.repository);
  assert(repositoryUrl.hostname === "github.com",
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.signerWorkflow requires a GitHub repository source`);
  const signerRepository = assertSafeText(
    attestation.signerRepository,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.signerRepository`,
    {
      pattern: RELEASE_EVIDENCE_GITHUB_REPOSITORY_SLUG_PATTERN,
      maximumBytes: 256,
    },
  );
  assert(signerWorkflow.startsWith(`${signerRepository}/.github/workflows/`),
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.signerWorkflow must belong to signerRepository`);
  assertSafeText(attestation.signerDigest,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.signerDigest`, {
      pattern: RELEASE_EVIDENCE_SIGNER_DIGEST_PATTERN,
      maximumBytes: 40,
    });
  const runUrl = assertHttpsUrl(
    attestation.runUrl,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.runUrl`,
    { maximumBytes: 512 },
  );
  const sourceRunPrefix = `${repositoryUrl.origin}${repositoryUrl.pathname}/actions/runs/`;
  const signerRepositoryUrl = new URL(`https://github.com/${signerRepository}`);
  const signerRunPrefix = `${signerRepositoryUrl.origin}${signerRepositoryUrl.pathname}/actions/runs/`;
  assert(runUrl.startsWith(sourceRunPrefix) || runUrl.startsWith(signerRunPrefix),
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.runUrl must belong to the release or signer repository`);
  const verificationInputs = assertPlainObject(
    attestation.verificationInputs,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.verificationInputs`,
  );
  assertAllowedKeys(
    verificationInputs,
    ["command", "bundleRequired", "denySelfHostedRunners"],
    `${label}.verificationInputs`,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
  );
  assert(verificationInputs.command === "gh attestation verify --bundle"
      && verificationInputs.bundleRequired === true
      && verificationInputs.denySelfHostedRunners === true,
  "RELEASE_EVIDENCE_PROVENANCE_INVALID",
  `${label}.verificationInputs must require offline gh bundle verification`);
  const source = assertPlainObject(attestation.source,
    "RELEASE_EVIDENCE_SOURCE_INVALID", `${label}.source`);
  assertAllowedKeys(
    source,
    ["version", "tag", "commit", "repository"],
    `${label}.source`,
    "RELEASE_EVIDENCE_SOURCE_INVALID",
  );
  assert(source.version === release.version
      && source.tag === release.tag
      && source.commit === release.commit
      && source.repository === release.repository,
  "RELEASE_EVIDENCE_SOURCE_MISMATCH",
  `${label}.source does not identify the exact release source`);
  return attestation;
}

function validateCanonicalArtifact(artifact, release, index) {
  const label = `artifacts[${index}]`;
  assertPlainObject(artifact, "RELEASE_EVIDENCE_ARTIFACT_INVALID", label);
  assertAllowedKeys(artifact, [
    "platform",
    "channel",
    "architecture",
    "format",
    "version",
    "distribution",
    "downloadUrl",
    "fileName",
    "bytes",
    "sha256",
    "source",
    "nativeTrust",
    "build",
    "sbom",
    "provenance",
    "assurances",
    "store",
    "updater",
  ], label, "RELEASE_EVIDENCE_ARTIFACT_INVALID");
  const platform = assertPlatform(artifact.platform);
  const channel = assertChannel(artifact.channel);
  assertArchitecture(artifact.architecture);
  assertFormat(artifact.format);
  assertVersion(artifact.version, `${label}.version`);
  assert(artifact.version === release.version, "RELEASE_EVIDENCE_VERSION_MISMATCH",
    `${label}.version does not match the release`);
  assertSafeFileName(artifact.fileName, `${label}.fileName`);
  assertByteCount(artifact.bytes, `${label}.bytes`);
  assertSha256(artifact.sha256, `${label}.sha256`);
  const source = assertPlainObject(artifact.source, "RELEASE_EVIDENCE_SOURCE_INVALID",
    `${label}.source`);
  assertAllowedKeys(
    source,
    ["version", "tag", "commit", "repository"],
    `${label}.source`,
    "RELEASE_EVIDENCE_SOURCE_INVALID",
  );
  assert(source.version === release.version
      && source.tag === release.tag
      && source.commit === release.commit
      && source.repository === release.repository,
  "RELEASE_EVIDENCE_SOURCE_MISMATCH",
  `${label}.source does not identify the exact release source`);
  assertDistribution(artifact.distribution);
  const downloadUrl = assertHttpsUrl(
    artifact.downloadUrl,
    "RELEASE_EVIDENCE_DOWNLOAD_URL_INVALID",
    `${label}.downloadUrl`,
  );
  const sbom = assertPlainObject(artifact.sbom, "RELEASE_EVIDENCE_SBOM_INVALID",
    `${label}.sbom`);
  assertAllowedKeys(
    sbom,
    ["format", "fileName", "bytes", "sha256", "subjectSha256", "source", "attestation"],
    `${label}.sbom`,
    "RELEASE_EVIDENCE_SBOM_INVALID",
  );
  assert(sbom.format === RELEASE_EVIDENCE_SPDX_FORMAT,
    "RELEASE_EVIDENCE_SBOM_INVALID", `${label}.sbom.format must be SPDX JSON`);
  assertSafeFileName(sbom.fileName, `${label}.sbom.fileName`);
  assertByteCount(sbom.bytes, `${label}.sbom.bytes`);
  assertSha256(sbom.sha256, `${label}.sbom.sha256`);
  assertCanonicalSubjectDigest(sbom.subjectSha256, artifact.sha256,
    `${label}.sbom.subjectSha256`);
  const sbomSource = assertPlainObject(sbom.source,
    "RELEASE_EVIDENCE_SOURCE_INVALID", `${label}.sbom.source`);
  assertAllowedKeys(
    sbomSource,
    ["version", "tag", "commit", "repository"],
    `${label}.sbom.source`,
    "RELEASE_EVIDENCE_SOURCE_INVALID",
  );
  assert(sbomSource.version === release.version
      && sbomSource.tag === release.tag
      && sbomSource.commit === release.commit
      && sbomSource.repository === release.repository,
  "RELEASE_EVIDENCE_SOURCE_MISMATCH",
  `${label}.sbom.source does not identify the exact release source`);
  validateCanonicalAttestation(sbom.attestation, {
    label: `${label}.sbom.attestation`,
    release,
    artifactDigest: artifact.sha256,
    kind: "sbom",
  });
  const provenance = validateCanonicalAttestation(artifact.provenance, {
    label: `${label}.provenance`,
    release,
    artifactDigest: artifact.sha256,
  });
  validateAssurances(artifact.assurances, platform, channel,
    `${label}.assurances`);
  if (channel === "direct") {
    assert(artifact.store === null,
      "RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
      `${label}.store must be null for a direct artifact`);
  } else {
    normalizeStore(artifact.store, platform, channel, `${label}.store`);
  }
  normalizeNativeTrust({
    value: artifact.nativeTrust,
    platform,
    channel,
    store: artifact.store,
    label: `${label}.nativeTrust`,
  });
  normalizeBuild(artifact.build, channel, `${label}.build`);
  validateDistribution({
    value: artifact.distribution,
    channel,
    platform,
    store: artifact.store,
    source: release,
    fileName: artifact.fileName,
    downloadUrl,
    label: `${label}.distribution`,
  });
  const updater = assertPlainObject(artifact.updater,
    "RELEASE_EVIDENCE_UPDATER_INVALID", `${label}.updater`);
  const enabled = assertBoolean(updater.enabled,
    "RELEASE_EVIDENCE_UPDATER_INVALID", `${label}.updater.enabled`);
  const mechanism = assertToken(
    updater.mechanism,
    /^[a-z][a-z0-9-]{1,63}$/u,
    "RELEASE_EVIDENCE_UPDATER_INVALID",
    `${label}.updater.mechanism`,
  );
  assert(RELEASE_EVIDENCE_DEFAULT_UPDATER_MECHANISMS[platform].includes(mechanism),
    "RELEASE_EVIDENCE_UPDATER_INVALID",
    `${label}.updater.mechanism is invalid for ${platform}`);
  if (channel === "store") {
    assert(enabled === false && mechanism === "store-managed",
      "RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
      `${label}.updater must be store-managed`);
  } else {
    assert(mechanism !== "store-managed",
      "RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
      `${label}.updater cannot be store-managed`);
  }
  if (enabled) {
    const metadata = assertPlainObject(updater.metadata,
      "RELEASE_EVIDENCE_UPDATER_INVALID", `${label}.updater.metadata`);
    assertAllowedKeys(
      metadata,
      ["fileName", "bytes", "sha256", "subjectSha256"],
      `${label}.updater.metadata`,
      "RELEASE_EVIDENCE_UPDATER_INVALID",
    );
    assertSafeFileName(metadata.fileName, `${label}.updater.metadata.fileName`);
    assertByteCount(metadata.bytes, `${label}.updater.metadata.bytes`);
    assertSha256(metadata.sha256, `${label}.updater.metadata.sha256`);
    assertCanonicalSubjectDigest(metadata.subjectSha256, artifact.sha256,
      `${label}.updater.metadata.subjectSha256`);
  } else {
    assert(updater.metadata === null,
      "RELEASE_EVIDENCE_UPDATER_INVALID",
      `${label}.updater.metadata must be null when disabled`);
  }
  return artifactIdentity(artifact);
}

function validateCanonicalManifest(manifest) {
  assertPlainObject(manifest, "RELEASE_EVIDENCE_MANIFEST_INVALID", "manifest");
  assertAllowedKeys(
    manifest,
    ["schemaVersion", "product", "version", "tag", "commit", "repository", "artifacts"],
    "manifest",
    "RELEASE_EVIDENCE_MANIFEST_INVALID",
  );
  assert(manifest.schemaVersion === RELEASE_EVIDENCE_SCHEMA_VERSION,
    "RELEASE_EVIDENCE_SCHEMA_INVALID", "manifest schema version is invalid");
  const product = assertPlainObject(manifest.product,
    "RELEASE_EVIDENCE_PRODUCT_INVALID", "manifest.product");
  assertAllowedKeys(
    product,
    ["name"],
    "manifest.product",
    "RELEASE_EVIDENCE_PRODUCT_INVALID",
  );
  assertSafeText(product.name, "RELEASE_EVIDENCE_PRODUCT_INVALID", "manifest.product.name");
  const release = {
    version: assertVersion(manifest.version, "manifest.version"),
    tag: assertTag(manifest.tag, "manifest.tag"),
    commit: assertCommit(manifest.commit, "manifest.commit"),
    repository: assertRepository(manifest.repository, "manifest.repository"),
  };
  assert(release.tag === `v${release.version}`
      || release.tag.startsWith(`v${release.version}-`)
      || release.tag.startsWith(`v${release.version}+`),
  "RELEASE_EVIDENCE_VERSION_MISMATCH",
  "manifest.tag must identify manifest.version");
  assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0,
    "RELEASE_EVIDENCE_ARTIFACT_INVALID",
    "manifest.artifacts must contain supplied artifacts");
  const identities = new Set();
  const names = new Set([RELEASE_EVIDENCE_MANIFEST_FILE_NAME]);
  let previous = "";
  for (let index = 0; index < manifest.artifacts.length; index += 1) {
    const identity = validateCanonicalArtifact(manifest.artifacts[index], release, index);
    assert(!identities.has(identity), "RELEASE_EVIDENCE_DUPLICATE_ARTIFACT",
      `duplicate artifact identity: ${identity}`);
    identities.add(identity);
    const artifact = manifest.artifacts[index];
    for (const fileName of [
      artifact.fileName,
      artifact.sbom.fileName,
      artifact.sbom.attestation.fileName,
      artifact.provenance.fileName,
      ...(artifact.updater.enabled ? [artifact.updater.metadata.fileName] : []),
    ]) {
      assert(!names.has(fileName), "RELEASE_EVIDENCE_DUPLICATE_FILE_NAME",
        `duplicate release evidence file name: ${fileName}`);
      names.add(fileName);
    }
    assert(compareCodeUnits(identity, previous) >= 0,
      "RELEASE_EVIDENCE_ORDER_INVALID",
      "manifest.artifacts must be sorted by canonical identity");
    previous = identity;
  }
  return Object.freeze({ release, product, identities, names });
}

async function verifyManifestFiles(manifest, artifactRoot) {
  const root = resolve(artifactRoot);
  for (const artifact of manifest.artifacts) {
    const files = [
      [artifact.fileName, `${artifact.fileName} artifact`, null],
      [artifact.sbom.fileName, `${artifact.fileName} SPDX SBOM`, artifact.sbom],
      [
        artifact.sbom.attestation.fileName,
        `${artifact.fileName} SPDX SBOM attestation`,
        artifact.sbom.attestation,
      ],
      [artifact.provenance.fileName, `${artifact.fileName} provenance`, artifact.provenance],
    ];
    if (artifact.updater.enabled) {
      files.push([
        artifact.updater.metadata.fileName,
        `${artifact.fileName} updater metadata`,
        artifact.updater.metadata,
      ]);
    }
    const seenNames = new Set();
    for (const [fileName, label, expected] of files) {
      assertSafeFileName(fileName, `${label}.fileName`);
      assert(!seenNames.has(fileName), "RELEASE_EVIDENCE_DUPLICATE_FILE_NAME",
        `${label} reuses a file name`);
      seenNames.add(fileName);
      const path = resolve(root, fileName);
      assert(pathWithin(root, path), "RELEASE_EVIDENCE_UNSAFE_PATH",
        `${label} escapes the artifact root`);
      const digest = await digestRegularFile(path, label, null);
      if (expected !== null) {
        assert(digest.bytes === expected.bytes, "RELEASE_EVIDENCE_BYTES_MISMATCH",
          `${label} byte count does not match the manifest`);
        assert(digest.sha256 === expected.sha256, "RELEASE_EVIDENCE_HASH_MISMATCH",
          `${label} SHA-256 does not match the manifest`);
      } else {
        assert(digest.bytes === artifact.bytes && digest.sha256 === artifact.sha256,
          "RELEASE_EVIDENCE_HASH_MISMATCH",
          `${label} does not match the manifest`);
      }
    }
  }
  return true;
}

/**
 * Validate a generated manifest.  With `artifactRoot`, all final artifacts
 * and metadata files are re-hashed locally.  Without it this remains a useful
 * structural/policy check for a checked-in or downloaded manifest.
 */
export async function validateReleaseEvidenceManifest(
  manifest,
  { artifactRoot = null, manifestPath = null } = {},
) {
  validateCanonicalManifest(manifest);
  if (artifactRoot !== null) await verifyManifestFiles(manifest, artifactRoot);
  if (manifestPath !== null) {
    const digest = await digestRegularFile(
      manifestPath,
      "release-manifest.json",
      MAX_METADATA_BYTES,
    );
    const expected = Buffer.from(`${stableStringify(manifest)}\n`, "utf8");
    assert(digest.bytes === expected.length && digest.sha256 === sha256Bytes(expected),
      "RELEASE_EVIDENCE_MANIFEST_HASH_MISMATCH",
      "release-manifest.json bytes do not match its canonical JSON");
  }
  return manifest;
}

export function buildSha256Sums(
  manifest,
  { manifestFileName = RELEASE_EVIDENCE_MANIFEST_FILE_NAME } = {},
) {
  validateCanonicalManifest(manifest);
  assertSafeFileName(manifestFileName, "manifestFileName");
  assert(manifestFileName === RELEASE_EVIDENCE_MANIFEST_FILE_NAME,
    "RELEASE_EVIDENCE_MANIFEST_FILE_NAME_INVALID",
    `manifestFileName must be ${RELEASE_EVIDENCE_MANIFEST_FILE_NAME}`);
  const rows = [];
  rows.push({
    fileName: manifestFileName,
    sha256: sha256Bytes(Buffer.from(`${stableStringify(manifest)}\n`, "utf8")),
  });
  for (const artifact of manifest.artifacts) {
    rows.push({ fileName: artifact.fileName, sha256: artifact.sha256 });
    rows.push({ fileName: artifact.sbom.fileName, sha256: artifact.sbom.sha256 });
    rows.push({
      fileName: artifact.sbom.attestation.fileName,
      sha256: artifact.sbom.attestation.sha256,
    });
    rows.push({
      fileName: artifact.provenance.fileName,
      sha256: artifact.provenance.sha256,
    });
    if (artifact.updater.enabled) {
      rows.push({
        fileName: artifact.updater.metadata.fileName,
        sha256: artifact.updater.metadata.sha256,
      });
    }
  }
  rows.sort((left, right) => compareCodeUnits(left.fileName, right.fileName));
  const names = new Set();
  for (const row of rows) {
    assert(!names.has(row.fileName), "RELEASE_EVIDENCE_DUPLICATE_FILE_NAME",
      `duplicate SHA256SUMS file name: ${row.fileName}`);
    names.add(row.fileName);
  }
  return `${rows.map(({ sha256, fileName }) => `${sha256}  ${fileName}`).join("\n")}\n`;
}

/**
 * Generate the canonical manifest from a descriptor and local supplied
 * files.  `baseDir` is used only to resolve descriptor paths and never leaks
 * into the returned manifest.
 */
export async function generateReleaseEvidence({
  descriptor,
  baseDir = process.cwd(),
}) {
  const input = typeof descriptor === "string"
    ? (await readJsonFile(descriptor, "release descriptor")).value
    : descriptor;
  const identity = validateReleaseIdentity(input);
  assert(Array.isArray(input.artifacts) && input.artifacts.length > 0,
    "RELEASE_EVIDENCE_ARTIFACT_INVALID",
    "release input must supply at least one artifact");
  const artifacts = [];
  const identities = new Set();
  const fileNames = new Set();
  for (const descriptorArtifact of input.artifacts) {
    const artifact = await normalizeArtifact(
      descriptorArtifact,
      identity.release,
      resolve(baseDir),
    );
    const identityKey = artifactIdentity(artifact);
    assert(!identities.has(identityKey), "RELEASE_EVIDENCE_DUPLICATE_ARTIFACT",
      `duplicate artifact identity: ${identityKey}`);
    assert(!fileNames.has(artifact.fileName), "RELEASE_EVIDENCE_DUPLICATE_FILE_NAME",
      `duplicate artifact file name: ${artifact.fileName}`);
    identities.add(identityKey);
    fileNames.add(artifact.fileName);
    artifacts.push(artifact);
  }
  artifacts.sort(compareArtifactIdentity);
  const manifest = {
    schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
    product: identity.product,
    version: identity.release.version,
    tag: identity.release.tag,
    commit: identity.release.commit,
    repository: identity.release.repository,
    artifacts,
  };
  await validateReleaseEvidenceManifest(manifest);
  return manifest;
}

export async function writeReleaseEvidenceFiles({
  manifest,
  manifestPath,
  sumsPath = join(dirname(resolve(manifestPath)), RELEASE_EVIDENCE_SUMS_FILE_NAME),
  replace = false,
}) {
  await validateReleaseEvidenceManifest(manifest);
  const selectedManifestPath = resolve(manifestPath);
  const selectedSumsPath = resolve(sumsPath);
  assert(dirname(selectedManifestPath) === dirname(selectedSumsPath),
    "RELEASE_EVIDENCE_OUTPUT_DIR_MISMATCH",
    "manifest and SHA256SUMS must be written to the same directory");
  await mkdir(dirname(selectedManifestPath), { recursive: true });
  await mkdir(dirname(selectedSumsPath), { recursive: true });
  assert(basename(selectedManifestPath) === RELEASE_EVIDENCE_MANIFEST_FILE_NAME,
    "RELEASE_EVIDENCE_MANIFEST_FILE_NAME_INVALID",
    `manifestPath must end in ${RELEASE_EVIDENCE_MANIFEST_FILE_NAME}`);
  if (!replace) {
    for (const path of [selectedManifestPath, selectedSumsPath]) {
      try {
        await lstat(path);
        fail("RELEASE_EVIDENCE_OUTPUT_EXISTS", `${path} already exists`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  const manifestText = `${stableStringify(manifest)}\n`;
  const sumsText = buildSha256Sums(manifest);
  const suffix = `.tmp-${process.pid}`;
  const manifestTempPath = `${selectedManifestPath}${suffix}`;
  const sumsTempPath = `${selectedSumsPath}${suffix}`;
  const manifestBackupPath = `${selectedManifestPath}.bak${suffix}`;
  const sumsBackupPath = `${selectedSumsPath}.bak${suffix}`;
  let manifestBackup = false;
  let sumsBackup = false;
  let manifestInstalled = false;
  let sumsInstalled = false;
  try {
    await writeFile(manifestTempPath, manifestText, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await writeFile(sumsTempPath, sumsText, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    if (replace) {
      try {
        await rename(selectedManifestPath, manifestBackupPath);
        manifestBackup = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      try {
        await rename(selectedSumsPath, sumsBackupPath);
        sumsBackup = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    await rename(manifestTempPath, selectedManifestPath);
    manifestInstalled = true;
    await rename(sumsTempPath, selectedSumsPath);
    sumsInstalled = true;
  } catch (error) {
    if (manifestInstalled) await unlink(selectedManifestPath).catch(() => {});
    if (sumsInstalled) await unlink(selectedSumsPath).catch(() => {});
    if (manifestBackup) await rename(manifestBackupPath, selectedManifestPath).catch(() => {});
    if (sumsBackup) await rename(sumsBackupPath, selectedSumsPath).catch(() => {});
    await unlink(manifestTempPath).catch(() => {});
    await unlink(sumsTempPath).catch(() => {});
    throw error;
  }
  if (manifestBackup) await unlink(manifestBackupPath);
  if (sumsBackup) await unlink(sumsBackupPath);
  return Object.freeze({
    manifestPath: selectedManifestPath,
    sumsPath: selectedSumsPath,
    manifestText,
    sumsText,
  });
}
