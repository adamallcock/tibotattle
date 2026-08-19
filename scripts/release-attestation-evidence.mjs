#!/usr/bin/env node

/**
 * Local helpers for the release attestation composite action.
 *
 * The action itself deliberately remains declarative: GitHub's pinned
 * actions/attest invocation creates the attestations, while this module checks
 * the final local bytes and preserves the emitted bundles. It never signs,
 * uploads, or publishes; bundle bytes are supplied locally. The `gh`
 * verification command may still use its normal trusted-root/network path,
 * but the protected composite action installs and version-checks a pinned
 * official GitHub CLI archive before this module invokes it.
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  fstatSync,
  mkdtempSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { sha256Bytes, validateSpdxJson } from "./release-evidence.js";

const TRUSTED_TAG_PATTERN =
  /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u;
const TRUSTED_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const FULL_SHA_PATTERN = /^[a-f0-9]{40,64}$/u;
const SIGNER_DIGEST_PATTERN = /^[a-f0-9]{40}$/u;
const SIGNER_WORKFLOW_PATTERN =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+$/u;
const SIGNER_REF_PATTERN =
  /^(?:refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*|[A-Za-z0-9][A-Za-z0-9._/-]*)$/u;
const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
const SBOM_PREDICATE = "https://spdx.dev/Document/v2.3";
const SIGSTORE_BUNDLE_MEDIA_TYPE =
  "application/vnd.dev.sigstore.bundle.v0.3+json";
const MAX_SBOM_BYTES = 16 * 1024 * 1024;
const MAX_DESCRIPTOR_BYTES = 1 * 1024 * 1024;
const MAX_DESCRIPTOR_ARTIFACTS = 64;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const PINNED_GH_VERSION = "2.96.0";
const PINNED_GH_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const MAX_GH_ARCHIVE_BYTES = 128 * 1024 * 1024;
const GH_ARCHIVE_DOWNLOAD_TIMEOUT_MS = 120_000;
const GH_RELEASE_ARCHIVES = Object.freeze({
  "linux-x64": Object.freeze({
    archive: "gh_2.96.0_linux_amd64.tar.gz",
    sha256: "83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60",
    format: "tar.gz",
  }),
  "linux-arm64": Object.freeze({
    archive: "gh_2.96.0_linux_arm64.tar.gz",
    sha256: "06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909",
    format: "tar.gz",
  }),
  "darwin-x64": Object.freeze({
    archive: "gh_2.96.0_macOS_amd64.zip",
    sha256: "4bd449df9ad639391bc62b8032546f0fe9edcd8526e06682a4f88abd8c5d163c",
    format: "zip",
  }),
  "darwin-arm64": Object.freeze({
    archive: "gh_2.96.0_macOS_arm64.zip",
    sha256: "f23a0c37d963aacc3bed703ccbd59b41c5ca22101fab7f00eb2b7cad23aba463",
    format: "zip",
  }),
  "win32-x64": Object.freeze({
    archive: "gh_2.96.0_windows_amd64.zip",
    sha256: "c2d6acc935cd2f00e2144d7e036d5cd82e6b6bd5594e8c75aa75ef2a4ed6aac3",
    format: "zip",
  }),
  "win32-arm64": Object.freeze({
    archive: "gh_2.96.0_windows_arm64.zip",
    sha256: "c517e0b32c98a4ba90ac95af8d12cc3ac55781ab4ab72f9a91ce3de0541d2b09",
    format: "zip",
  }),
});

export { GH_RELEASE_ARCHIVES, PINNED_GH_OIDC_ISSUER, PINNED_GH_VERSION };

export class ReleaseAttestationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseAttestationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReleaseAttestationError(code, message);
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function sha256File(path) {
  const hash = createHash("sha256");
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    // Keep hashing bounded even for multi-gigabyte installers. A whole-file
    // read could duplicate a complete release artifact in RAM.
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } catch (error) {
    fail("RELEASE_ATTESTATION_FILE_UNAVAILABLE", `unable to hash ${path}: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return hash.digest("hex");
}

function assertNoSymlinkAncestors(path, label) {
  // Canonicalise the nearest existing ancestor.  This deliberately permits
  // host aliases such as macOS /var -> /private/var while ensuring later
  // generated outputs are resolved against the actual evidence directory.
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (samePath(parent, current)) break;
    current = parent;
  }
  try {
    assert(realpathSync(current).length > 0, "RELEASE_ATTESTATION_PATH_INVALID",
      `${label} has no canonical filesystem ancestor`);
  } catch (error) {
    if (error instanceof ReleaseAttestationError) throw error;
    fail("RELEASE_ATTESTATION_PATH_INVALID", `${label}: ${error.message}`);
  }
}

function samePath(left, right) {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function sameStagingName(left, right) {
  // GitHub's macOS and Windows runners normally use case-insensitive
  // volumes. Reject a case-only collision up front so the private staging
  // copy cannot depend on the runner's filesystem behavior.
  if (process.platform === "darwin" || process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function requiredString(value, label) {
  assert(typeof value === "string" && value.length > 0 && !value.includes("\0"),
    "RELEASE_ATTESTATION_INPUT_INVALID", `${label} is required`);
  return value;
}

function safeArtifactFileName(path) {
  const fileName = basename(path);
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,219}$/u.test(fileName),
    "RELEASE_ATTESTATION_FILE_NAME_INVALID",
    "artifact filename must be a simple release filename of at most 220 characters");
  return fileName;
}

function regularFile(value, label) {
  const selected = resolve(requiredString(value, label));
  assertNoSymlinkAncestors(selected, label);
  let metadata;
  try {
    metadata = lstatSync(selected);
  } catch (error) {
    fail("RELEASE_ATTESTATION_FILE_UNAVAILABLE", `${label}: ${error.message}`);
  }
  assert(metadata.isFile() && !metadata.isSymbolicLink(),
    "RELEASE_ATTESTATION_FILE_INVALID",
    `${label} must be a regular non-symlink file`);
  return realpathSync(selected);
}

function ensureDirectory(value) {
  const selected = resolve(requiredString(value, "evidence directory"));
  assertNoSymlinkAncestors(selected, "evidence directory");
  try {
    if (!existsSync(selected)) mkdirSync(selected, { recursive: true });
    const metadata = lstatSync(selected);
    assert(metadata.isDirectory() && !metadata.isSymbolicLink(),
      "RELEASE_ATTESTATION_DIRECTORY_INVALID",
      "evidence directory must be a regular directory, not a symlink");
  } catch (error) {
    if (error instanceof ReleaseAttestationError) throw error;
    fail("RELEASE_ATTESTATION_DIRECTORY_INVALID", error.message);
  }
  return realpathSync(selected);
}

function parseBoundedJson(path, label, maximumBytes) {
  let initial;
  let descriptor;
  let bytes;
  try {
    initial = lstatSync(path);
  } catch (error) {
    fail("RELEASE_ATTESTATION_FILE_UNAVAILABLE", `${label}: ${error.message}`);
  }
  assert(initial.isFile() && !initial.isSymbolicLink(),
    "RELEASE_ATTESTATION_FILE_INVALID", `${label} must be a regular file`);
  assert(initial.size > 0 && initial.size <= maximumBytes,
    "RELEASE_ATTESTATION_JSON_INVALID",
    `${label} must be non-empty and no larger than ${maximumBytes} bytes`);
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    const opened = fstatSync(descriptor);
    assert(opened.isFile()
        && opened.dev === initial.dev
        && opened.ino === initial.ino
        && opened.size === initial.size,
    "RELEASE_ATTESTATION_FILE_CHANGED",
    `${label} changed before it was opened`);
    assert(opened.size > 0 && opened.size <= maximumBytes,
      "RELEASE_ATTESTATION_JSON_INVALID",
      `${label} must be non-empty and no larger than ${maximumBytes} bytes`);
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      assert(count > 0, "RELEASE_ATTESTATION_FILE_CHANGED",
        `${label} changed while it was being read`);
      offset += count;
    }
    const overflow = Buffer.allocUnsafe(1);
    assert(readSync(descriptor, overflow, 0, 1, bytes.length) === 0,
      "RELEASE_ATTESTATION_FILE_CHANGED",
      `${label} grew while it was being read`);
    const final = fstatSync(descriptor);
    assert(final.dev === opened.dev && final.ino === opened.ino
        && final.size === opened.size
        && final.mtimeMs === opened.mtimeMs
        && final.ctimeMs === opened.ctimeMs,
    "RELEASE_ATTESTATION_FILE_CHANGED",
    `${label} changed while it was being read`);
  } catch (error) {
    if (error instanceof ReleaseAttestationError) throw error;
    fail("RELEASE_ATTESTATION_FILE_UNAVAILABLE", `${label}: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("RELEASE_ATTESTATION_JSON_INVALID", `${label} is not valid JSON`);
  }
}

function assertObject(value, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value),
    "RELEASE_ATTESTATION_DESCRIPTOR_INVALID", `${label} must be an object`);
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

function jsonEqual(left, right) {
  return JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right));
}

function certificateField(certificate, ...names) {
  // gh attestation verify --format json currently serializes sigstore-go's
  // certificate.Summary with lower-camel keys (including the historical
  // githubWorkflow* aliases). Keep the aliases narrow and fail closed when a
  // signer identity cannot be recovered from the certificate.
  for (const name of names) {
    if (certificate?.[name] !== undefined) return certificate[name];
  }
  return undefined;
}

function expectedSignerUri(signerWorkflow, signerRef) {
  const repository = signerWorkflow.split("/").slice(0, 2).join("/");
  const workflowPath = signerWorkflow.slice(repository.length + 1);
  return `https://github.com/${repository}/${workflowPath}@${signerRef}`;
}

function validateCertificateIdentity(certificate, {
  repository,
  sourceRef,
  sourceDigest,
  signerWorkflow,
  signerDigest,
  signerRef,
} = {}) {
  if (certificate === undefined || certificate === null) {
    return Object.freeze({ certificateBackedSignerVerified: false });
  }
  assertObject(certificate, "verification certificate");
  const signerUri = expectedSignerUri(signerWorkflow, signerRef);
  const expectedRepositoryUrl = `https://github.com/${repository}`;
  const expectedSignerRepository = signerWorkflow.split("/").slice(0, 2).join("/");
  const checks = [
    ["sourceRepositoryURI", expectedRepositoryUrl],
    ["sourceRepositoryUri", expectedRepositoryUrl],
    ["sourceRepositoryDigest", sourceDigest],
    ["sourceRepositoryRef", sourceRef],
    ["buildSignerURI", signerUri],
    ["buildSignerUri", signerUri],
    ["subjectAlternativeName", signerUri],
    ["githubWorkflowRepository", expectedSignerRepository],
    ["githubWorkflowRef", signerRef],
    ["githubWorkflowSHA", signerDigest],
    ["githubWorkflowSha", signerDigest],
    ["buildSignerDigest", signerDigest],
    ["buildSignerSha", signerDigest],
    ["issuer", PINNED_GH_OIDC_ISSUER],
    ["runnerEnvironment", "github-hosted"],
  ];
  let checked = 0;
  for (const [field, expected] of checks) {
    const value = certificateField(certificate, field);
    if (value === undefined) continue;
    assert(value === expected,
      "RELEASE_ATTESTATION_CERTIFICATE_MISMATCH",
      `verification certificate ${field} does not match trusted GitHub context`);
    checked += 1;
  }
  assert(checked > 0, "RELEASE_ATTESTATION_CERTIFICATE_INVALID",
    "verification certificate does not expose a trusted GitHub identity field");
  return Object.freeze({
    certificateBackedSignerVerified: true,
    signerUri,
    certificate,
  });
}

function statementSubjectDigest(statement, subjectPath, expectedDigest) {
  assert(Array.isArray(statement.subject) && statement.subject.length > 0,
    "RELEASE_ATTESTATION_STATEMENT_INVALID",
    "verified attestation statement must contain a subject");
  const expectedName = basename(subjectPath);
  const matches = statement.subject.filter((subject) => {
    if (subject === null || typeof subject !== "object" || Array.isArray(subject)) return false;
    if (subject.name !== expectedName) return false;
    return subject.digest?.sha256 === expectedDigest;
  });
  assert(matches.length === 1 && statement.subject.length === 1,
    "RELEASE_ATTESTATION_SUBJECT_MISMATCH",
    "verified attestation statement subject does not identify exactly the supplied bytes");
  return expectedDigest;
}

function extractTrustedBuilderId(statement, certificate) {
  // The predicate is workflow-controlled metadata. Prefer the certificate's
  // signed build signer identity; this keeps a user-authored predicate from
  // becoming a trusted manifest claim. The predicate is still structurally
  // checked by validateVerifiedAttestation below.
  const fromCertificate = certificateField(certificate,
    "buildSignerURI", "buildSignerUri", "subjectAlternativeName");
  assert(typeof fromCertificate === "string" && fromCertificate.length > 0,
    "RELEASE_ATTESTATION_CERTIFICATE_INVALID",
    "verified certificate does not identify a trusted builder");
  return fromCertificate;
}

function invocationMatchesRunUrl(value, runUrl) {
  if (typeof value !== "string") return false;
  if (value === runUrl) return true;
  const attemptMatch = value.match(/^(.*\/actions\/runs\/[1-9][0-9]*)\/attempts?\/([1-9][0-9]*)$/u);
  if (attemptMatch === null) return false;
  return `${attemptMatch[1]}/attempt/${attemptMatch[2]}` === runUrl
    || (attemptMatch[2] === "1" && attemptMatch[1] === runUrl);
}

function validateVerifiedAttestation({
  output,
  bundle,
  subjectPath,
  expectedSubjectSha256,
  predicateType,
  repository,
  sourceRef,
  sourceDigest,
  signerWorkflow,
  signerDigest,
  signerRef,
  runUrl,
}) {
  let parsed;
  try {
    const text = Buffer.isBuffer(output) ? output.toString("utf8") : output;
    parsed = JSON.parse(typeof text === "string" ? text : "");
  } catch {
    fail("RELEASE_ATTESTATION_VERIFICATION_OUTPUT_INVALID",
      "gh attestation verify returned malformed JSON");
  }
  assert(Array.isArray(parsed) && parsed.length === 1,
    "RELEASE_ATTESTATION_VERIFICATION_OUTPUT_INVALID",
    "gh attestation verify must return exactly one verified attestation");
  const entry = assertObject(parsed[0], "verified attestation result");
  const verificationResult = assertObject(entry.verificationResult,
    "verified attestation verificationResult");
  assert(Array.isArray(verificationResult.verifiedTimestamps)
      && verificationResult.verifiedTimestamps.length > 0,
  "RELEASE_ATTESTATION_VERIFICATION_TIMESTAMP_INVALID",
  "gh attestation verify must return at least one verified transparency timestamp");
  for (const timestamp of verificationResult.verifiedTimestamps) {
    assertObject(timestamp, "verified attestation timestamp");
    assert(Object.keys(timestamp).length > 0,
      "RELEASE_ATTESTATION_VERIFICATION_TIMESTAMP_INVALID",
      "verified attestation timestamps must not be empty objects");
  }
  const statement = assertObject(verificationResult.statement,
    "verified attestation statement");
  assert(statement.predicateType === predicateType,
    "RELEASE_ATTESTATION_PREDICATE_MISMATCH",
    "verified attestation predicate does not match the requested policy");
  statementSubjectDigest(statement, subjectPath, expectedSubjectSha256);
  const predicate = assertObject(statement.predicate, "verified attestation predicate");
  if (predicateType === PROVENANCE_PREDICATE) {
    assertObject(predicate.buildDefinition, "verified provenance buildDefinition");
    const runDetails = assertObject(predicate.runDetails,
      "verified provenance runDetails");
    assertObject(runDetails.builder, "verified provenance builder");
    assertObject(runDetails.metadata, "verified provenance metadata");
  } else {
    assert(predicate.spdxVersion === "SPDX-2.3",
      "RELEASE_ATTESTATION_PREDICATE_MISMATCH",
      "verified SBOM attestation predicate is not SPDX-2.3");
  }
  const signature = assertObject(verificationResult.signature,
    "verified attestation signature");
  const certificate = signature.certificate;
  const certificateIdentity = validateCertificateIdentity(certificate, {
    repository,
    sourceRef,
    sourceDigest,
    signerWorkflow,
    signerDigest,
    signerRef,
  });
  if (certificateIdentity.certificateBackedSignerVerified) {
    const runnerEnvironment = certificateField(certificate, "runnerEnvironment");
    if (runnerEnvironment !== undefined) {
      assert(runnerEnvironment === "github-hosted",
        "RELEASE_ATTESTATION_RUNNER_POLICY_MISMATCH",
        "verified certificate does not identify a GitHub-hosted runner");
    }
  }
  const invocationId = statement.predicate?.runDetails?.metadata?.invocationId;
  if (predicateType === PROVENANCE_PREDICATE) {
    assert(typeof invocationId === "string" && invocationId.length > 0,
      "RELEASE_ATTESTATION_RUN_MISMATCH",
      "verified provenance must identify the trusted GitHub run invocation");
    assert(invocationMatchesRunUrl(invocationId, runUrl),
      "RELEASE_ATTESTATION_RUN_MISMATCH",
      "verified provenance invocation does not identify the trusted GitHub run");
  }
  const attestation = assertObject(entry.attestation, "verified attestation bundle");
  assert(jsonEqual(attestation, bundle),
    "RELEASE_ATTESTATION_VERIFICATION_BUNDLE_MISMATCH",
    "gh verification output does not describe the supplied bundle bytes");
  assert(bundle.mediaType === SIGSTORE_BUNDLE_MEDIA_TYPE,
    "RELEASE_ATTESTATION_BUNDLE_INVALID",
    "verified attestation bundle must use Sigstore bundle v0.3 JSON");
  return Object.freeze({
    statement,
    predicateType: statement.predicateType,
    certificate: certificateIdentity.certificate,
    certificateBackedSignerVerified: certificateIdentity.certificateBackedSignerVerified,
    builderId: extractTrustedBuilderId(statement, certificate),
    runUrl,
    // SPDX attestations do not carry a trusted provenance invocation in their
    // user-controlled predicate. The run URL here is the protected finalizer
    // context used to perform verification, not a claim that the SBOM
    // certificate independently proves an originating workflow run.
    runBinding: predicateType === PROVENANCE_PREDICATE
      ? "provenance-invocation"
      : "verification-context-only",
    runnerPolicy: Object.freeze({
      denySelfHostedRunners: true,
      runnerEnvironment: certificateField(certificate, "runnerEnvironment") ?? "github-hosted",
    }),
  });
}

function descriptorPath(value, descriptorDirectory) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    return null;
  }
  return resolve(descriptorDirectory, value);
}

function descriptorName(value) {
  if (typeof value === "string" && value.length > 0) return basename(value);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const pathValue = value.path ?? value.file;
    if (typeof pathValue === "string" && pathValue.length > 0) return basename(pathValue);
    if (typeof value.fileName === "string") return value.fileName;
  }
  return null;
}

function assertDigest(value, expected, label) {
  if (value === undefined || value === null) return;
  assert(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value),
    "RELEASE_ATTESTATION_DESCRIPTOR_INVALID",
    `${label} must be a lowercase SHA-256`);
  assert(value === expected, "RELEASE_ATTESTATION_SUBJECT_MISMATCH",
    `${label} does not match the supplied bytes`);
}

function trustedRepositorySlug(repository, label = "trusted GitHub repository") {
  assert(typeof repository === "string" && TRUSTED_REPOSITORY_PATTERN.test(repository),
    "RELEASE_ATTESTATION_TRUST_CONTEXT_INVALID", `${label} must be owner/repository`);
  return repository;
}

function releaseRepositorySlug(repository) {
  let parsed;
  try {
    parsed = new URL(repository);
  } catch {
    fail("RELEASE_ATTESTATION_TRUST_CONTEXT_INVALID",
      "release descriptor repository must be a GitHub HTTPS URL");
  }
  assert(parsed.protocol === "https:" && parsed.hostname === "github.com"
      && parsed.username === "" && parsed.password === ""
      && parsed.search === "" && parsed.hash === ""
      && parsed.pathname.startsWith("/") && !parsed.pathname.endsWith("/"),
  "RELEASE_ATTESTATION_TRUST_CONTEXT_INVALID",
  "release descriptor repository must be a canonical GitHub HTTPS URL");
  return parsed.pathname.slice(1);
}

function trustedReleaseIdentity(descriptor, {
  trustedRepository,
  trustedRef,
  trustedSha,
} = {}) {
  const repository = trustedRepositorySlug(trustedRepository);
  assert(typeof trustedRef === "string" && /^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(trustedRef),
    "RELEASE_ATTESTATION_TRUST_CONTEXT_INVALID",
    "GitHub ref must be an exact refs/tags/<tag> value");
  const tag = trustedRef.slice("refs/tags/".length);
  assert(TRUSTED_TAG_PATTERN.test(tag), "RELEASE_ATTESTATION_TRUST_CONTEXT_INVALID",
    "GitHub tag must be an exact version tag");
  assert(typeof trustedSha === "string" && FULL_SHA_PATTERN.test(trustedSha),
    "RELEASE_ATTESTATION_TRUST_CONTEXT_INVALID",
    "GitHub SHA must be a full lowercase commit SHA");
  const descriptorRepository = releaseRepositorySlug(descriptor.repository);
  assert(descriptorRepository === repository
      && descriptor.repository === `https://github.com/${repository}`,
  "RELEASE_ATTESTATION_SOURCE_MISMATCH",
  "release descriptor repository does not match trusted github.repository");
  assert(descriptor.tag === tag,
  "RELEASE_ATTESTATION_SOURCE_MISMATCH",
  "release descriptor tag does not match trusted github.ref");
  assert(descriptor.version === tag.slice(1),
    "RELEASE_ATTESTATION_SOURCE_MISMATCH",
    "release descriptor version does not match the trusted release tag");
  assert(descriptor.commit === trustedSha,
    "RELEASE_ATTESTATION_SOURCE_MISMATCH",
    "release descriptor commit does not match trusted github.sha");
  return Object.freeze({ repository, tag, ref: trustedRef, commit: trustedSha });
}

function trustedSignerIdentity({
  trustedWorkflowRef,
  trustedWorkflowSha,
} = {}) {
  assert(typeof trustedWorkflowRef === "string" && trustedWorkflowRef.length > 0,
    "RELEASE_ATTESTATION_SIGNER_INVALID",
    "trusted job.workflow_ref/github.workflow_ref is required");
  const at = trustedWorkflowRef.lastIndexOf("@");
  const signerWorkflow = at > 0 ? trustedWorkflowRef.slice(0, at) : "";
  const signerRef = at > 0 ? trustedWorkflowRef.slice(at + 1) : "";
  assert(SIGNER_WORKFLOW_PATTERN.test(signerWorkflow)
      && SIGNER_REF_PATTERN.test(signerRef),
    "RELEASE_ATTESTATION_SIGNER_INVALID",
    "trusted workflow ref must identify a valid signer workflow and ref");
  assert(typeof trustedWorkflowSha === "string"
      && SIGNER_DIGEST_PATTERN.test(trustedWorkflowSha),
  "RELEASE_ATTESTATION_SIGNER_INVALID",
  "trusted job.workflow_sha/github.workflow_sha must be a full lowercase workflow SHA");
  return Object.freeze({
    signerWorkflow,
    signerDigest: trustedWorkflowSha,
    signerRef,
    signerRepository: signerWorkflow.split("/").slice(0, 2).join("/"),
  });
}

function trustedRunUrl({
  repository,
  trustedServerUrl = process.env.RELEASE_TRUSTED_SERVER_URL,
  trustedRunId = process.env.RELEASE_TRUSTED_RUN_ID,
  trustedRunAttempt = process.env.RELEASE_TRUSTED_RUN_ATTEMPT,
} = {}) {
  const server = trustedServerUrl ?? "https://github.com";
  assert(typeof server === "string" && server === "https://github.com",
    "RELEASE_ATTESTATION_TRUST_CONTEXT_INVALID",
    "trusted GitHub server URL must be https://github.com");
  const slug = trustedRepositorySlug(repository, "trusted run repository");
  assert(typeof trustedRunId === "string" && /^[1-9][0-9]*$/u.test(trustedRunId),
    "RELEASE_ATTESTATION_TRUST_CONTEXT_INVALID",
    "trusted GitHub run ID must be a positive integer");
  const attempt = trustedRunAttempt ?? "1";
  assert(typeof attempt === "string" && /^[1-9][0-9]*$/u.test(attempt),
    "RELEASE_ATTESTATION_TRUST_CONTEXT_INVALID",
    "trusted GitHub run attempt must be a positive integer");
  return `${server}/${slug}/actions/runs/${trustedRunId}`
    + (attempt === "1" ? "" : `/attempt/${attempt}`);
}

function assertTrustedRunUrl(value, repository) {
  const slug = trustedRepositorySlug(repository, "trusted run repository");
  const prefix = `https://github.com/${slug}/actions/runs/`;
  assert(typeof value === "string"
      && value.startsWith(prefix)
      && /^(?:[1-9][0-9]*)(?:\/attempt\/[1-9][0-9]*)?$/u.test(value.slice(prefix.length)),
  "RELEASE_ATTESTATION_TRUST_CONTEXT_INVALID",
  "trusted run URL must identify a GitHub Actions run in the trusted repository");
  return value;
}

function writeOutput(outputPath, name, value) {
  const selected = resolve(requiredString(outputPath, "GITHUB_OUTPUT"));
  assert(!value.includes("\r") && !value.includes("\n"),
    "RELEASE_ATTESTATION_OUTPUT_INVALID", `${name} contains a newline`);
  appendFileSync(selected, `${name}=${value}\n`, "utf8");
}

function writeOptionalOutput(outputPath, name, value) {
  if (outputPath === undefined || outputPath === null || outputPath === "") return;
  writeOutput(outputPath, name, value);
}

function ghPlatformKey(platform = process.platform, architecture = process.arch) {
  const normalizedArchitecture = architecture === "x64"
    ? "x64"
    : architecture === "arm64"
      ? "arm64"
      : null;
  assert(normalizedArchitecture !== null,
    "RELEASE_ATTESTATION_VERIFIER_PLATFORM_UNSUPPORTED",
    `GitHub CLI verifier does not support ${platform}/${architecture}`);
  const key = `${platform}-${normalizedArchitecture}`;
  assert(Object.prototype.hasOwnProperty.call(GH_RELEASE_ARCHIVES, key),
    "RELEASE_ATTESTATION_VERIFIER_PLATFORM_UNSUPPORTED",
    `GitHub CLI verifier does not support ${platform}/${architecture}`);
  return key;
}

function ghArchiveUrl(archive) {
  assert(typeof archive === "string" && /^[A-Za-z0-9._-]+\.(?:zip|tar\.gz)$/u.test(archive),
    "RELEASE_ATTESTATION_VERIFIER_ARCHIVE_INVALID",
    "GitHub CLI verifier archive name is invalid");
  return `https://github.com/cli/cli/releases/download/v${PINNED_GH_VERSION}/${archive}`;
}

function writeBufferFully(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset, null);
    assert(written > 0, "RELEASE_ATTESTATION_VERIFIER_DOWNLOAD_FAILED",
      "GitHub CLI verifier download made no progress");
    offset += written;
  }
}

async function downloadPinnedGhArchive({ url, destination, expectedSha256, fetcher = fetch }) {
  assert(url === ghArchiveUrl(basename(url)),
    "RELEASE_ATTESTATION_VERIFIER_ARCHIVE_INVALID",
    "GitHub CLI verifier URL must be the pinned official release archive");
  assert(/^[a-f0-9]{64}$/u.test(expectedSha256),
    "RELEASE_ATTESTATION_VERIFIER_ARCHIVE_INVALID",
    "GitHub CLI verifier archive SHA-256 is invalid");
  let response;
  try {
    response = await fetcher(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(GH_ARCHIVE_DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    fail("RELEASE_ATTESTATION_VERIFIER_DOWNLOAD_FAILED",
      `unable to download the pinned GitHub CLI verifier: ${error.message}`);
  }
  assert(response?.ok === true && response.body !== null,
    "RELEASE_ATTESTATION_VERIFIER_DOWNLOAD_FAILED",
    `pinned GitHub CLI verifier download failed with HTTP ${response?.status ?? "unknown"}`);
  const finalUrl = response.url ?? url;
  let finalUrlValue;
  try {
    finalUrlValue = new URL(finalUrl);
  } catch {
    fail("RELEASE_ATTESTATION_VERIFIER_DOWNLOAD_FAILED",
      "pinned GitHub CLI verifier response URL is invalid");
  }
  assert(finalUrlValue.protocol === "https:"
      && ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]
        .includes(finalUrlValue.hostname),
  "RELEASE_ATTESTATION_VERIFIER_DOWNLOAD_FAILED",
  "pinned GitHub CLI verifier redirected to an untrusted host");
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength !== null && declaredLength !== undefined && declaredLength !== "") {
    assert(/^[0-9]+$/u.test(declaredLength)
        && Number(declaredLength) <= MAX_GH_ARCHIVE_BYTES,
    "RELEASE_ATTESTATION_VERIFIER_DOWNLOAD_TOO_LARGE",
    `pinned GitHub CLI verifier archive exceeds ${MAX_GH_ARCHIVE_BYTES} bytes`);
  }
  let descriptor;
  let bytes = 0;
  const hash = createHash("sha256");
  try {
    descriptor = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    for await (const chunk of response.body) {
      const value = Buffer.from(chunk);
      bytes += value.length;
      assert(bytes <= MAX_GH_ARCHIVE_BYTES,
        "RELEASE_ATTESTATION_VERIFIER_DOWNLOAD_TOO_LARGE",
        `pinned GitHub CLI verifier archive exceeds ${MAX_GH_ARCHIVE_BYTES} bytes`);
      hash.update(value);
      writeBufferFully(descriptor, value);
    }
    assert(bytes > 0, "RELEASE_ATTESTATION_VERIFIER_DOWNLOAD_FAILED",
      "pinned GitHub CLI verifier archive is empty");
  } catch (error) {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } catch {
      // Preserve the original download failure.
    }
    descriptor = undefined;
    try {
      unlinkSync(destination);
    } catch {
      // Best-effort cleanup of our exclusive temporary destination.
    }
    if (error instanceof ReleaseAttestationError) throw error;
    fail("RELEASE_ATTESTATION_VERIFIER_DOWNLOAD_FAILED",
      `unable to save the pinned GitHub CLI verifier: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const sha256 = hash.digest("hex");
  if (sha256 !== expectedSha256) {
    try {
      unlinkSync(destination);
    } catch {
      // Preserve the hash mismatch even if the temporary file disappeared.
    }
    fail("RELEASE_ATTESTATION_VERIFIER_ARCHIVE_HASH_MISMATCH",
      "pinned GitHub CLI verifier archive SHA-256 does not match the official release digest");
  }
  return Object.freeze({ bytes, sha256 });
}

function extractPinnedGhArchive({ archivePath, destination, format }) {
  const command = format === "tar.gz"
    ? ["tar", ["-xzf", archivePath, "-C", destination]]
    : process.platform === "win32"
      ? ["powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
          archivePath,
          destination,
        ]]
      : ["unzip", ["-qq", archivePath, "-d", destination]];
  const result = spawnSync(command[0], command[1], { encoding: "utf8", windowsHide: true });
  assert(result?.error === undefined && result?.status === 0,
    "RELEASE_ATTESTATION_VERIFIER_EXTRACTION_FAILED",
    `unable to extract pinned GitHub CLI verifier archive: ${result?.stderr || result?.error?.message || "unknown error"}`);
}

function findPinnedGhBinary(root, expectedName = process.platform === "win32" ? "gh.exe" : "gh") {
  const matches = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const selected = join(directory, entry.name);
      const metadata = lstatSync(selected);
      assert(!metadata.isSymbolicLink(),
        "RELEASE_ATTESTATION_VERIFIER_EXTRACTION_FAILED",
        "pinned GitHub CLI verifier archive contains a symlink");
      if (metadata.isDirectory()) {
        visit(selected);
      } else if (metadata.isFile() && entry.name === expectedName) {
        matches.push(realpathSync(selected));
      }
    }
  };
  visit(root);
  assert(matches.length === 1,
    "RELEASE_ATTESTATION_VERIFIER_EXTRACTION_FAILED",
    `pinned GitHub CLI verifier archive must contain exactly one ${expectedName}`);
  return matches[0];
}

function parseGhVersion(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  const match = typeof text === "string" && text.match(/(?:^|\n)gh version ([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/u);
  assert(match !== null,
    "RELEASE_ATTESTATION_VERIFIER_VERSION_INVALID",
    "pinned GitHub CLI verifier did not report a parseable version");
  return match[1];
}

function assertPinnedGhVersion(result) {
  assert(result?.error === undefined && result?.status === 0,
    "RELEASE_ATTESTATION_VERIFIER_UNAVAILABLE",
    `pinned GitHub CLI verifier version check failed: ${result?.error?.message || result?.stderr || "unknown error"}`);
  const version = parseGhVersion(result.stdout);
  assert(version === PINNED_GH_VERSION,
    "RELEASE_ATTESTATION_VERIFIER_VERSION_MISMATCH",
    `GitHub CLI verifier must be exactly ${PINNED_GH_VERSION}, found ${version}`);
  return version;
}

function verifyGhVersion(verifierPath, runner) {
  let result;
  try {
    result = runner(verifierPath, ["--version"], { encoding: "utf8", windowsHide: true });
  } catch (error) {
    fail("RELEASE_ATTESTATION_VERIFIER_UNAVAILABLE",
      `pinned GitHub CLI verifier failed to start: ${error.message}`);
  }
  return assertPinnedGhVersion(result);
}

export async function installPinnedGhVerifier({
  outputPath = process.env.GITHUB_OUTPUT,
  temporaryRoot = tmpdir(),
  platform = process.platform,
  architecture = process.arch,
  fetcher = fetch,
  runner = spawnSync,
} = {}) {
  const key = ghPlatformKey(platform, architecture);
  const archive = GH_RELEASE_ARCHIVES[key];
  const workDirectory = mkdtempSync(join(resolve(temporaryRoot), "tibotattle-gh-verifier-"));
  const archivePath = join(workDirectory, archive.archive);
  const extractionDirectory = join(workDirectory, "extract");
  mkdirSync(extractionDirectory);
  const archiveUrl = ghArchiveUrl(archive.archive);
  const downloaded = await downloadPinnedGhArchive({
    url: archiveUrl,
    destination: archivePath,
    expectedSha256: archive.sha256,
    fetcher,
  });
  extractPinnedGhArchive({
    archivePath,
    destination: extractionDirectory,
    format: archive.format,
  });
  const verifierPath = findPinnedGhBinary(extractionDirectory,
    platform === "win32" ? "gh.exe" : "gh");
  if (platform !== "win32") chmodSync(verifierPath, 0o755);
  const verifierSha256 = sha256File(verifierPath);
  const verifierVersion = verifyGhVersion(verifierPath, runner);
  writeOutput(outputPath, "verifier-path", verifierPath);
  writeOutput(outputPath, "verifier-version", verifierVersion);
  writeOutput(outputPath, "verifier-sha256", verifierSha256);
  writeOutput(outputPath, "verifier-archive-sha256", downloaded.sha256);
  console.log(`release-attestation-verifier=gh@${verifierVersion}`);
  return Object.freeze({
    verifierPath,
    verifierVersion,
    verifierSha256,
    archive: archive.archive,
    archiveSha256: downloaded.sha256,
  });
}

function ensureEvidenceInterface(workspace) {
  const root = resolve(requiredString(workspace, "workspace"));
  const modulePath = resolve(root, "scripts", "release-evidence.js");
  assert(existsSync(modulePath), "RELEASE_ATTESTATION_EVIDENCE_INTERFACE_MISSING",
    `${modulePath} is required by the release attestation contract`);
  // Importing the module statically above is the actual interface call.  This
  // path check makes a checkout/action mismatch fail closed before attesting.
  assert(typeof sha256Bytes === "function",
    "RELEASE_ATTESTATION_EVIDENCE_INTERFACE_INVALID",
    "sha256Bytes export is required");
  return modulePath;
}

function stageFrozenFile(source, stagingDirectory, label) {
  const destination = join(stagingDirectory, basename(source));
  try {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    fail("RELEASE_ATTESTATION_STAGING_FAILED", `${label}: ${error.message}`);
  }
  regularFile(destination, `frozen ${label}`);
  return destination;
}

function copyBundleFile(source, destination, label) {
  let sourceDescriptor;
  let destinationDescriptor;
  let destinationCreated = false;
  try {
    sourceDescriptor = openSync(source, constants.O_RDONLY);
    destinationDescriptor = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    destinationCreated = true;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    let bytesRead;
    do {
      bytesRead = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      let written = 0;
      while (written < bytesRead) {
        const count = writeSync(
          destinationDescriptor,
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        assert(count > 0, "RELEASE_ATTESTATION_OUTPUT_WRITE_FAILED",
          `${label}: destination write made no progress`);
        written += count;
      }
      position += bytesRead;
    } while (bytesRead > 0);
  } catch (error) {
    if (destinationCreated) {
      try {
        closeSync(destinationDescriptor);
      } catch {
        // Preserve the original copy error.
      }
      destinationDescriptor = undefined;
      try {
        unlinkSync(destination);
      } catch {
        // Best-effort rollback; the caller reports the original failure.
      }
    }
    if (error instanceof ReleaseAttestationError) throw error;
    fail("RELEASE_ATTESTATION_OUTPUT_WRITE_FAILED", `${label}: ${error.message}`);
  } finally {
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
  }
  return lstatSync(destination);
}

function isWithin(parent, child) {
  const value = relative(resolve(parent), resolve(child));
  return value === ""
    || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function commonDirectory(paths) {
  const canonical = paths.map((path) => realpathSync(path));
  let candidate = dirname(canonical[0]);
  for (const selected of canonical.slice(1)) {
    while (!isWithin(candidate, selected)) {
      const parent = dirname(candidate);
      assert(parent !== candidate, "RELEASE_ATTESTATION_DESCRIPTOR_OUTPUT_INVALID",
        "release evidence inputs do not share a safe output root");
      candidate = parent;
    }
  }
  assert(candidate !== dirname(candidate), "RELEASE_ATTESTATION_DESCRIPTOR_OUTPUT_INVALID",
    "refusing to generate trusted release metadata at the filesystem root");
  return candidate;
}

function relativePath(baseDirectory, path, label) {
  const value = relative(baseDirectory, path);
  assert(value !== "" && !isAbsolute(value) && !value.startsWith(`..${sep}`)
      && value !== "..",
  "RELEASE_ATTESTATION_DESCRIPTOR_OUTPUT_INVALID",
  `${label} is outside the trusted descriptor output root`);
  return value;
}

function rebasePathCarrier(value, descriptorDirectory, baseDirectory, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of ["path", "file"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const absolute = descriptorPath(value[key], descriptorDirectory);
    assert(absolute !== null, "RELEASE_ATTESTATION_DESCRIPTOR_INVALID",
      `${label}.${key} must be a valid path`);
    value[key] = relativePath(baseDirectory, absolute, `${label}.${key}`);
  }
}

function rebaseDescriptorPaths(descriptor, descriptorDirectory, baseDirectory) {
  descriptor.artifacts.forEach((artifact, index) => {
    if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) return;
    const label = `release descriptor artifacts[${index}]`;
    rebasePathCarrier(artifact, descriptorDirectory, baseDirectory, label);
    rebasePathCarrier(artifact.sbom, descriptorDirectory, baseDirectory, `${label}.sbom`);
    rebasePathCarrier(artifact.sbom?.attestation, descriptorDirectory, baseDirectory,
      `${label}.sbom.attestation`);
    rebasePathCarrier(artifact.provenance, descriptorDirectory, baseDirectory,
      `${label}.provenance`);
    rebasePathCarrier(artifact.store?.receipt, descriptorDirectory, baseDirectory,
      `${label}.store.receipt`);
    rebasePathCarrier(artifact.updater?.metadata, descriptorDirectory, baseDirectory,
      `${label}.updater.metadata`);
  });
}

function writeExclusiveJson(path, value, label) {
  const selected = resolve(path);
  assertNoSymlinkAncestors(selected, label);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.from(text, "utf8");
  assert(bytes.length <= MAX_DESCRIPTOR_BYTES,
    "RELEASE_ATTESTATION_DESCRIPTOR_INVALID",
    `${label} exceeds the ${MAX_DESCRIPTOR_BYTES}-byte bound`);
  let descriptor;
  let created = false;
  try {
    descriptor = openSync(
      selected,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    created = true;
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      assert(written > 0, "RELEASE_ATTESTATION_DESCRIPTOR_OUTPUT_FAILED",
        `${label}: destination write made no progress`);
      offset += written;
    }
  } catch (error) {
    if (created) {
      try {
        unlinkSync(selected);
      } catch {
        // Preserve the original error and never remove a replacement path.
      }
    }
    fail(error?.code === "EEXIST"
      ? "RELEASE_ATTESTATION_DESCRIPTOR_OUTPUT_EXISTS"
      : "RELEASE_ATTESTATION_DESCRIPTOR_OUTPUT_FAILED",
    `${label}: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return Object.freeze({
    path: selected,
    bytes: bytes.length,
    identity: lstatSync(selected),
  });
}

function subjectMetadata({
  destination,
  bundle,
  bundleSha256,
  subjectSha256,
  verification,
  signer,
}) {
  // The manifest schema requires a runUrl for both attestation kinds. For
  // provenance this is the exact invocation bound above; for SPDX it is the
  // protected finalizer/verification context only. The SBOM certificate and
  // user-controlled SPDX predicate are never treated as proof of an
  // originating workflow run.
  return {
    mediaType: bundle.mediaType,
    predicateType: verification.predicateType,
    builderId: verification.builderId,
    path: destination,
    fileName: basename(destination),
    bytes: lstatSync(bundle.path).size,
    sha256: bundleSha256,
    subjectSha256,
    verificationStatus: "unverified",
    signerRepository: signer.signerRepository,
    signerWorkflow: signer.signerWorkflow,
    signerDigest: signer.signerDigest,
    runUrl: verification.runUrl,
    denySelfHostedRunners: verification.runnerPolicy.denySelfHostedRunners,
  };
}

function buildEnrichedDescriptor({
  descriptor,
  descriptorDirectory,
  selectedIndex,
  baseDirectory,
  artifactPath,
  sbomPath,
  artifactSha256,
  sbomSha256,
  provenanceDestination,
  sbomDestination,
  provenanceBundle,
  sbomBundle,
  provenanceBundleSha256,
  sbomBundleSha256,
  provenanceVerification,
  sbomVerification,
  source,
  signer,
}) {
  const enriched = JSON.parse(JSON.stringify(descriptor));
  rebaseDescriptorPaths(enriched, descriptorDirectory, baseDirectory);
  const selectedEnriched = enriched.artifacts[selectedIndex];
  assertObject(selectedEnriched, "release descriptor selected artifact");
  selectedEnriched.path = relativePath(baseDirectory, artifactPath, "artifact path");
  delete selectedEnriched.file;
  selectedEnriched.fileName = basename(artifactPath);
  selectedEnriched.bytes = lstatSync(artifactPath).size;
  selectedEnriched.sha256 = artifactSha256;
  selectedEnriched.source = { ...source };
  assertObject(selectedEnriched.sbom, "release descriptor artifact.sbom");
  selectedEnriched.sbom.path = relativePath(baseDirectory, sbomPath, "SBOM path");
  delete selectedEnriched.sbom.file;
  selectedEnriched.sbom.fileName = basename(sbomPath);
  selectedEnriched.sbom.bytes = lstatSync(sbomPath).size;
  selectedEnriched.sbom.sha256 = sbomSha256;
  selectedEnriched.sbom.subjectSha256 = artifactSha256;
  selectedEnriched.provenance = subjectMetadata({
    destination: relativePath(baseDirectory, provenanceDestination,
      "provenance bundle path"),
    bundle: provenanceBundle,
    bundleSha256: provenanceBundleSha256,
    subjectSha256: artifactSha256,
    verification: provenanceVerification,
    signer,
  });
  selectedEnriched.sbom.attestation = subjectMetadata({
    destination: relativePath(baseDirectory, sbomDestination, "SBOM bundle path"),
    bundle: sbomBundle,
    bundleSha256: sbomBundleSha256,
    subjectSha256: artifactSha256,
    verification: sbomVerification,
    signer,
  });
  return enriched;
}

function removeOwnedDestination({ path, identity }) {
  try {
    const current = lstatSync(path);
    // Do not unlink a path that was replaced after this invocation created it.
    if (sameIdentity(current, identity)) {
      unlinkSync(path);
    }
  } catch {
    // A missing destination is already rolled back. Preserve any other path
    // so a concurrent writer is never deleted as part of our cleanup.
  }
}

function sameIdentity(left, right) {
  const meaningful = left !== null && left !== undefined
    && right !== null && right !== undefined
    && !((left.dev === 0 || left.dev === 0n) && (left.ino === 0 || left.ino === 0n))
    && !((right.dev === 0 || right.dev === 0n) && (right.ino === 0 || right.ino === 0n));
  return meaningful && left.dev === right.dev && left.ino === right.ino;
}

function cleanupOwnedStagingDirectory(directory, ownedFiles = []) {
  let canonicalDirectory;
  let directoryIdentity;
  try {
    const selected = resolve(directory);
    const selectedMetadata = lstatSync(selected);
    if (!selectedMetadata.isDirectory() || selectedMetadata.isSymbolicLink()) return false;
    canonicalDirectory = realpathSync(selected);
    directoryIdentity = lstatSync(canonicalDirectory);
    if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink()) return false;
    const temporaryRoot = realpathSync(resolve(tmpdir()));
    const directoryRelative = relative(temporaryRoot, canonicalDirectory);
    if (directoryRelative === ""
        || directoryRelative === ".."
        || directoryRelative.startsWith(`..${sep}`)
        || isAbsolute(directoryRelative)
        || !basename(canonicalDirectory).startsWith("tibotattle-release-frozen-")) {
      return false;
    }
  } catch {
    return false;
  }

  // Only unlink the exact regular files this invocation created. A symlink
  // replacement is never followed, and a device/inode change leaves the
  // replacement intact for operator inspection.
  for (const owned of ownedFiles) {
    const selected = resolve(owned.path);
    try {
      const current = lstatSync(selected);
      if (current.isFile() && !current.isSymbolicLink() && sameIdentity(current, owned.identity)) {
        unlinkSync(selected);
      }
    } catch {
      // Missing or replaced paths are intentionally preserved.
    }
  }

  try {
    const currentDirectory = lstatSync(canonicalDirectory);
    if (!currentDirectory.isDirectory()
        || currentDirectory.isSymbolicLink()
        || !sameIdentity(currentDirectory, directoryIdentity)
        || readdirSync(canonicalDirectory).length !== 0) {
      return false;
    }
    rmdirSync(canonicalDirectory);
    return true;
  } catch {
    // A concurrent replacement, extra file, or already-removed directory is
    // not permission to remove anything else.
    return false;
  }
}

function rollbackOwnedBundleDestinations(destinations) {
  for (const destination of [...destinations].reverse()) {
    removeOwnedDestination(destination);
  }
}

function validateSpdx(sbom) {
  try {
    validateSpdxJson(sbom, "SPDX SBOM");
  } catch {
    fail(
      "RELEASE_ATTESTATION_SBOM_INVALID",
      "SPDX SBOM must satisfy the canonical SPDX-2.3 release contract",
    );
  }
}

function findDescriptorArtifact(descriptor, artifactPath, sbomPath, descriptorFilePath) {
  const descriptorDirectory = dirname(descriptorFilePath);
  const artifactName = basename(artifactPath);
  const sbomName = basename(sbomPath);
  const candidates = descriptor.artifacts.filter((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const artifactValue = entry.path ?? entry.file;
    const sbomValue = entry.sbom?.path ?? entry.sbom?.file;
    const artifactResolved = descriptorPath(artifactValue, descriptorDirectory);
    const sbomResolved = descriptorPath(sbomValue, descriptorDirectory);
    if (artifactResolved !== null && !samePath(artifactResolved, artifactPath)) return false;
    if (sbomResolved !== null && !samePath(sbomResolved, sbomPath)) return false;
    if (artifactResolved !== null || sbomResolved !== null) {
      const entryName = entry.fileName ?? descriptorName(artifactValue);
      const entrySbomName = entry.sbom?.fileName ?? descriptorName(entry.sbom);
      return (artifactResolved !== null || entryName === artifactName)
        && (sbomResolved !== null || entrySbomName === sbomName);
    }
    const entryName = entry.fileName ?? descriptorName(artifactValue);
    const entrySbomName = entry.sbom?.fileName ?? descriptorName(entry.sbom);
    return entryName === artifactName && entrySbomName === sbomName;
  });
  assert(candidates.length === 1, "RELEASE_ATTESTATION_DESCRIPTOR_MISMATCH",
    "descriptor must identify exactly one supplied artifact and SBOM");
  return candidates[0];
}

export function preflightReleaseAttestation({
  artifactPath,
  sbomPath,
  evidenceDirectory,
  releaseDescriptorPath,
  workspace = process.env.GITHUB_WORKSPACE || process.cwd(),
  trustedRepository = process.env.RELEASE_TRUSTED_REPOSITORY,
  trustedRef = process.env.RELEASE_TRUSTED_REF,
  trustedSha = process.env.RELEASE_TRUSTED_SHA,
  trustedWorkflowRef = process.env.RELEASE_TRUSTED_WORKFLOW_REF,
  trustedWorkflowSha = process.env.RELEASE_TRUSTED_WORKFLOW_SHA,
  trustedServerUrl = process.env.RELEASE_TRUSTED_SERVER_URL,
  trustedRunId = process.env.RELEASE_TRUSTED_RUN_ID,
  trustedRunAttempt = process.env.RELEASE_TRUSTED_RUN_ATTEMPT,
  outputPath = process.env.GITHUB_OUTPUT,
}) {
  const artifact = regularFile(artifactPath, "artifact");
  const sbom = regularFile(sbomPath, "SPDX SBOM");
  const descriptorPathValue = regularFile(releaseDescriptorPath, "release descriptor");
  assert(!samePath(artifact, sbom) && !samePath(artifact, descriptorPathValue)
      && !samePath(sbom, descriptorPathValue),
  "RELEASE_ATTESTATION_INPUT_INVALID",
  "artifact, SBOM, and descriptor must be distinct files");
  const evidence = ensureDirectory(evidenceDirectory);
  assert(!sameStagingName(basename(artifact), basename(sbom)),
    "RELEASE_ATTESTATION_STAGING_COLLISION",
    "artifact and SBOM must have distinct basenames for private frozen staging");
  assert(!samePath(evidence, artifact) && !samePath(evidence, sbom),
    "RELEASE_ATTESTATION_DIRECTORY_INVALID",
    "evidence directory must be separate from input files");

  const sbomMetadata = lstatSync(sbom);
  assert(sbomMetadata.size > 0 && sbomMetadata.size <= MAX_SBOM_BYTES,
    "RELEASE_ATTESTATION_SBOM_INVALID",
    `SPDX SBOM must be non-empty and no larger than ${MAX_SBOM_BYTES} bytes`);
  const artifactSha256 = sha256File(artifact);
  const sbomSha256 = sha256File(sbom);
  validateSpdx(parseBoundedJson(sbom, "SPDX SBOM", MAX_SBOM_BYTES));

  const descriptorMetadata = lstatSync(descriptorPathValue);
  assert(descriptorMetadata.size > 0 && descriptorMetadata.size <= MAX_DESCRIPTOR_BYTES,
    "RELEASE_ATTESTATION_DESCRIPTOR_INVALID",
    `release descriptor must be non-empty and no larger than ${MAX_DESCRIPTOR_BYTES} bytes`);
  const descriptor = assertObject(parseBoundedJson(
    descriptorPathValue,
    "release descriptor",
    MAX_DESCRIPTOR_BYTES,
  ),
    "release descriptor");
  assert(Array.isArray(descriptor.artifacts) && descriptor.artifacts.length > 0,
    "RELEASE_ATTESTATION_DESCRIPTOR_INVALID",
    "release descriptor must list artifacts");
  assert(descriptor.artifacts.length <= MAX_DESCRIPTOR_ARTIFACTS,
    "RELEASE_ATTESTATION_DESCRIPTOR_INVALID",
    `release descriptor must list no more than ${MAX_DESCRIPTOR_ARTIFACTS} artifacts`);
  for (const field of ["version", "tag", "commit", "repository"]) {
    assert(typeof descriptor[field] === "string" && descriptor[field].length > 0,
      "RELEASE_ATTESTATION_DESCRIPTOR_INVALID",
      `release descriptor.${field} is required`);
  }
  const source = trustedReleaseIdentity(descriptor, {
    trustedRepository,
    trustedRef,
    trustedSha,
  });
  const signer = trustedSignerIdentity({
    trustedWorkflowRef,
    trustedWorkflowSha,
  });
  const runUrl = assertTrustedRunUrl(trustedRunUrl({
    repository: source.repository,
    trustedServerUrl,
    trustedRunId,
    trustedRunAttempt,
  }), source.repository);
  const selected = findDescriptorArtifact(
    descriptor,
    artifact,
    sbom,
    descriptorPathValue,
  );
  assertDigest(selected.sha256, artifactSha256, "artifact.sha256");
  assertDigest(selected.sbom?.sha256, sbomSha256, "artifact.sbom.sha256");
  assertDigest(selected.sbom?.subjectSha256, artifactSha256,
    "artifact.sbom.subjectSha256");
  ensureEvidenceInterface(workspace);
  const descriptorSha256 = sha256File(descriptorPathValue);
  const stagingDirectory = mkdtempSync(join(tmpdir(), "tibotattle-release-frozen-"));
  const stagedFiles = [];
  try {
    const frozenArtifactPath = stageFrozenFile(artifact, stagingDirectory, "artifact");
    stagedFiles.push({ path: frozenArtifactPath, identity: lstatSync(frozenArtifactPath) });
    const frozenSbomPath = stageFrozenFile(sbom, stagingDirectory, "sbom");
    stagedFiles.push({ path: frozenSbomPath, identity: lstatSync(frozenSbomPath) });
    assert(sha256File(frozenArtifactPath) === artifactSha256
        && sha256File(frozenSbomPath) === sbomSha256
        && sha256File(artifact) === artifactSha256
        && sha256File(sbom) === sbomSha256,
    "RELEASE_ATTESTATION_SUBJECT_CHANGED",
    "artifact or SBOM changed while creating the frozen attestation copy");
    writeOutput(outputPath, "artifact-sha256", artifactSha256);
    writeOutput(outputPath, "sbom-sha256", sbomSha256);
    writeOutput(outputPath, "descriptor-sha256", descriptorSha256);
    writeOutput(outputPath, "frozen-artifact-path", frozenArtifactPath);
    writeOutput(outputPath, "frozen-sbom-path", frozenSbomPath);
    writeOutput(outputPath, "signer-workflow", signer.signerWorkflow);
    writeOutput(outputPath, "signer-digest", signer.signerDigest);
    writeOutput(outputPath, "trusted-run-url", runUrl);
    return Object.freeze({
      artifactPath: artifact,
      sbomPath: sbom,
      frozenArtifactPath,
      frozenSbomPath,
      stagingDirectory,
      stagingIdentity: Object.freeze({
        directory: lstatSync(stagingDirectory),
        artifact: lstatSync(frozenArtifactPath),
        sbom: lstatSync(frozenSbomPath),
      }),
      evidenceDirectory: evidence,
      releaseDescriptorPath: descriptorPathValue,
      artifactSha256,
      sbomSha256,
      descriptorSha256,
      source,
      signer,
      runUrl,
    });
  } catch (error) {
    cleanupOwnedStagingDirectory(stagingDirectory, stagedFiles);
    throw error;
  }
}

export function verifyAttestationBundle({
  subjectPath,
  bundlePath,
  repository,
  sourceRef,
  sourceDigest,
  signerWorkflow,
  signerDigest,
  signerRef,
  predicateType,
  trustedRunUrl: runUrl,
  verifierPath = process.env.RELEASE_ATTESTATION_GH_PATH,
  verifierSha256 = process.env.RELEASE_ATTESTATION_GH_SHA256,
  runner = spawnSync,
}) {
  // GitHub's current bundle-verification contract is:
  // gh attestation verify --bundle <path> <subject> --repo <owner/repo>
  // plus explicit source/signer/predicate constraints below. The bundle is
  // supplied locally (so no remote bundle fetch is needed), but trusted-root
  // resolution may still contact GitHub.
  const subject = regularFile(subjectPath, "attestation subject");
  const bundle = regularFile(bundlePath, "attestation bundle");
  const verifiedSourceRef = requiredString(sourceRef, "attestation source ref");
  assert(/^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(verifiedSourceRef)
      && TRUSTED_TAG_PATTERN.test(verifiedSourceRef.slice("refs/tags/".length)),
    "RELEASE_ATTESTATION_TRUST_CONTEXT_INVALID",
    "attestation source ref must be an exact version tag");
  const verifiedSourceDigest = requiredString(sourceDigest, "attestation source digest");
  assert(FULL_SHA_PATTERN.test(verifiedSourceDigest),
    "RELEASE_ATTESTATION_TRUST_CONTEXT_INVALID",
    "attestation source digest must be a full lowercase commit SHA");
  const verifiedSignerWorkflow = requiredString(
    signerWorkflow,
    "attestation signer workflow",
  );
  assert(SIGNER_WORKFLOW_PATTERN.test(verifiedSignerWorkflow),
    "RELEASE_ATTESTATION_SIGNER_INVALID",
    "attestation signer workflow must identify a repository workflow");
  const verifiedSignerDigest = requiredString(signerDigest, "attestation signer digest");
  assert(SIGNER_DIGEST_PATTERN.test(verifiedSignerDigest),
    "RELEASE_ATTESTATION_SIGNER_INVALID",
    "attestation signer digest must be a full lowercase workflow SHA");
  const verifiedSignerRef = requiredString(signerRef, "attestation signer ref");
  assert(SIGNER_REF_PATTERN.test(verifiedSignerRef),
    "RELEASE_ATTESTATION_SIGNER_INVALID",
    "attestation signer ref must be a valid GitHub ref");
  const verifiedPredicateType = requiredString(predicateType, "attestation predicate type");
  assert(verifiedPredicateType === PROVENANCE_PREDICATE
      || verifiedPredicateType === SBOM_PREDICATE,
    "RELEASE_ATTESTATION_PREDICATE_INVALID",
    "attestation predicate type must be SLSA provenance or SPDX 2.3");
  const expectedRunUrl = runUrl ?? trustedRunUrl({
    repository: trustedRepositorySlug(repository),
  });
  assertTrustedRunUrl(expectedRunUrl, repository);
  const expectedSubjectSha256 = sha256File(subject);
  const bundleValue = parseBoundedJson(bundle, "attestation bundle", MAX_BUNDLE_BYTES);
  assert(bundleValue.mediaType === SIGSTORE_BUNDLE_MEDIA_TYPE,
    "RELEASE_ATTESTATION_BUNDLE_INVALID",
    "attestation bundle must use Sigstore bundle v0.3 JSON");
  const configuredVerifierVersion = process.env.RELEASE_ATTESTATION_GH_VERSION;
  if (configuredVerifierVersion !== undefined) {
    assert(configuredVerifierVersion === PINNED_GH_VERSION,
      "RELEASE_ATTESTATION_VERIFIER_VERSION_MISMATCH",
      `configured GitHub CLI verifier must be exactly ${PINNED_GH_VERSION}`);
  }
  const selectedVerifierPath = regularFile(
    requiredString(verifierPath, "pinned GitHub CLI verifier path"),
    "pinned GitHub CLI verifier",
  );
  assert(typeof verifierSha256 === "string" && /^[a-f0-9]{64}$/u.test(verifierSha256),
    "RELEASE_ATTESTATION_VERIFIER_HASH_INVALID",
    "pinned GitHub CLI verifier SHA-256 is required");
  assert(sha256File(selectedVerifierPath) === verifierSha256,
    "RELEASE_ATTESTATION_VERIFIER_HASH_MISMATCH",
    "pinned GitHub CLI verifier bytes changed after installation");
  const verifierVersion = verifyGhVersion(selectedVerifierPath, runner);
  const args = [
    "attestation", "verify", subject,
    "--repo", trustedRepositorySlug(repository),
    "--bundle", bundle,
    "--source-ref", verifiedSourceRef,
    "--source-digest", verifiedSourceDigest,
    "--signer-workflow", verifiedSignerWorkflow,
    "--signer-digest", verifiedSignerDigest,
    "--predicate-type", verifiedPredicateType,
    "--cert-oidc-issuer", PINNED_GH_OIDC_ISSUER,
    "--deny-self-hosted-runners",
    "--format", "json",
  ];
  let result;
  try {
    result = runner(selectedVerifierPath, args, { encoding: "utf8", windowsHide: true });
  } catch (error) {
    fail("RELEASE_ATTESTATION_BUNDLE_UNVERIFIED",
      `gh attestation verify failed to start: ${error.message}`);
  }
  assert(result?.error === undefined && result?.status === 0,
    "RELEASE_ATTESTATION_BUNDLE_UNVERIFIED",
    `gh attestation verify rejected ${basename(bundle)}`);
  assert(sha256File(selectedVerifierPath) === verifierSha256,
    "RELEASE_ATTESTATION_VERIFIER_HASH_MISMATCH",
    "pinned GitHub CLI verifier bytes changed during verification");
  const verification = validateVerifiedAttestation({
    output: result.stdout,
    bundle: bundleValue,
    subjectPath: subject,
    expectedSubjectSha256,
    predicateType: verifiedPredicateType,
    repository: trustedRepositorySlug(repository),
    sourceRef: verifiedSourceRef,
    sourceDigest: verifiedSourceDigest,
    signerWorkflow: verifiedSignerWorkflow,
    signerDigest: verifiedSignerDigest,
    signerRef: verifiedSignerRef,
    runUrl: expectedRunUrl,
  });
  return Object.freeze({
    subjectPath: subject,
    bundlePath: bundle,
    args,
    verifierPath: selectedVerifierPath,
    verifierVersion,
    ...verification,
    bundle: Object.freeze({
      path: bundle,
      mediaType: bundleValue.mediaType,
    }),
  });
}

export function cleanupFrozenStaging(
  frozenArtifactPath,
  frozenSbomPath,
  expectedIdentity,
) {
  const directory = dirname(frozenArtifactPath);
  assert(samePath(directory, dirname(frozenSbomPath)),
    "RELEASE_ATTESTATION_STAGING_INVALID",
    "frozen artifact and SBOM must share a staging directory");
  let temporaryRoot;
  let canonicalDirectory;
  try {
    assert(expectedIdentity !== null && typeof expectedIdentity === "object",
      "RELEASE_ATTESTATION_STAGING_INVALID",
      "frozen staging cleanup requires the identity captured before verification");
    const requestedMetadata = lstatSync(resolve(directory));
    assert(requestedMetadata.isDirectory() && !requestedMetadata.isSymbolicLink()
        && sameIdentity(requestedMetadata, expectedIdentity.directory),
    "RELEASE_ATTESTATION_STAGING_INVALID",
    "refusing to remove a replaced frozen staging directory");
    // Node may expose macOS's /var alias while realpath returns /private/var;
    // canonicalize both sides before applying the deletion boundary.
    temporaryRoot = realpathSync(resolve(tmpdir()));
    canonicalDirectory = realpathSync(resolve(directory));
  } catch (error) {
    fail("RELEASE_ATTESTATION_STAGING_INVALID",
      `unable to canonicalize frozen staging directory: ${error.message}`);
  }
  const relativePath = relative(temporaryRoot, canonicalDirectory);
  assert(relativePath !== ""
      && relativePath !== ".."
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath)
      && basename(canonicalDirectory).startsWith("tibotattle-release-frozen-"),
  "RELEASE_ATTESTATION_STAGING_INVALID",
  "refusing to remove an untrusted frozen staging directory");
  const directoryMetadata = lstatSync(canonicalDirectory);
  assert(directoryMetadata.isDirectory() && !directoryMetadata.isSymbolicLink()
      && sameIdentity(directoryMetadata, expectedIdentity.directory),
    "RELEASE_ATTESTATION_STAGING_INVALID",
    "refusing to remove a replaced frozen staging directory");
  const ownedFiles = [
    [frozenArtifactPath, expectedIdentity.artifact],
    [frozenSbomPath, expectedIdentity.sbom],
  ].map(([path, expectedFileIdentity]) => {
    const metadata = lstatSync(path);
    assert(metadata.isFile() && !metadata.isSymbolicLink()
        && sameIdentity(metadata, expectedFileIdentity)
        && samePath(dirname(realpathSync(path)), canonicalDirectory),
    "RELEASE_ATTESTATION_STAGING_INVALID",
    "frozen staging inputs must be regular files within the staging directory");
    return { path, identity: metadata };
  });
  cleanupOwnedStagingDirectory(canonicalDirectory, ownedFiles);
}

export function collectReleaseAttestation({
  artifactPath,
  sbomPath,
  evidenceDirectory,
  frozenArtifactPath,
  frozenSbomPath,
  releaseDescriptorPath,
  expectedArtifactSha256,
  expectedSbomSha256,
  expectedDescriptorSha256,
  trustedRepository = process.env.RELEASE_TRUSTED_REPOSITORY,
  trustedRef = process.env.RELEASE_TRUSTED_REF,
  trustedSha = process.env.RELEASE_TRUSTED_SHA,
  trustedWorkflowRef = process.env.RELEASE_TRUSTED_WORKFLOW_REF,
  trustedWorkflowSha = process.env.RELEASE_TRUSTED_WORKFLOW_SHA,
  trustedServerUrl = process.env.RELEASE_TRUSTED_SERVER_URL,
  trustedRunId = process.env.RELEASE_TRUSTED_RUN_ID,
  trustedRunAttempt = process.env.RELEASE_TRUSTED_RUN_ATTEMPT,
  provenanceBundlePath,
  sbomBundlePath,
  verifyBundle = verifyAttestationBundle,
  copyBundle = copyBundleFile,
  cleanupStaging = true,
  outputPath = process.env.GITHUB_OUTPUT,
}) {
  const artifact = regularFile(artifactPath, "artifact");
  const sbom = regularFile(sbomPath, "SPDX SBOM");
  const frozenArtifact = regularFile(frozenArtifactPath, "frozen artifact");
  const frozenSbom = regularFile(frozenSbomPath, "frozen SPDX SBOM");
  const frozenDirectory = dirname(frozenArtifact);
  assert(samePath(frozenDirectory, dirname(frozenSbom)),
    "RELEASE_ATTESTATION_STAGING_INVALID",
    "frozen artifact and SBOM must share a staging directory");
  const frozenStagingIdentity = Object.freeze({
    directory: lstatSync(frozenDirectory),
    artifact: lstatSync(frozenArtifact),
    sbom: lstatSync(frozenSbom),
  });
  const evidence = ensureDirectory(evidenceDirectory);
  const actualArtifactSha256 = sha256File(artifact);
  const actualSbomSha256 = sha256File(sbom);
  const frozenArtifactSha256 = sha256File(frozenArtifact);
  const frozenSbomSha256 = sha256File(frozenSbom);
  assert(typeof expectedArtifactSha256 === "string"
      && /^[a-f0-9]{64}$/u.test(expectedArtifactSha256),
    "RELEASE_ATTESTATION_OUTPUT_INVALID",
    "expected artifact SHA-256 must be a lowercase SHA-256");
  assert(typeof expectedSbomSha256 === "string"
      && /^[a-f0-9]{64}$/u.test(expectedSbomSha256),
    "RELEASE_ATTESTATION_OUTPUT_INVALID",
    "expected SBOM SHA-256 must be a lowercase SHA-256");
  assert(actualArtifactSha256 === expectedArtifactSha256
      && actualSbomSha256 === expectedSbomSha256
      && frozenArtifactSha256 === expectedArtifactSha256
      && frozenSbomSha256 === expectedSbomSha256,
  "RELEASE_ATTESTATION_SUBJECT_CHANGED",
    "artifact, SBOM, or frozen attestation copy changed after preflight");

  const descriptorFile = regularFile(releaseDescriptorPath, "release descriptor");
  const descriptorMetadata = lstatSync(descriptorFile);
  assert(descriptorMetadata.size > 0 && descriptorMetadata.size <= MAX_DESCRIPTOR_BYTES,
    "RELEASE_ATTESTATION_DESCRIPTOR_INVALID",
    `release descriptor must be non-empty and no larger than ${MAX_DESCRIPTOR_BYTES} bytes`);
  const descriptor = assertObject(parseBoundedJson(
    descriptorFile,
    "release descriptor",
    MAX_DESCRIPTOR_BYTES,
  ),
    "release descriptor");
  assert(Array.isArray(descriptor.artifacts) && descriptor.artifacts.length > 0,
    "RELEASE_ATTESTATION_DESCRIPTOR_INVALID",
    "release descriptor must list artifacts");
  assert(descriptor.artifacts.length <= MAX_DESCRIPTOR_ARTIFACTS,
    "RELEASE_ATTESTATION_DESCRIPTOR_INVALID",
    `release descriptor must list no more than ${MAX_DESCRIPTOR_ARTIFACTS} artifacts`);
  const actualDescriptorSha256 = sha256File(descriptorFile);
  assert(typeof expectedDescriptorSha256 === "string"
      && /^[a-f0-9]{64}$/u.test(expectedDescriptorSha256)
      && actualDescriptorSha256 === expectedDescriptorSha256,
  "RELEASE_ATTESTATION_DESCRIPTOR_CHANGED",
  "release descriptor changed after preflight");
  const source = trustedReleaseIdentity(descriptor, {
    trustedRepository,
    trustedRef,
    trustedSha,
  });
  const signer = trustedSignerIdentity({
    trustedWorkflowRef,
    trustedWorkflowSha,
  });
  const runUrl = assertTrustedRunUrl(trustedRunUrl({
    repository: source.repository,
    trustedServerUrl,
    trustedRunId,
    trustedRunAttempt,
  }), source.repository);
  const selected = findDescriptorArtifact(
    descriptor,
    artifact,
    sbom,
    descriptorFile,
  );
  const selectedIndex = descriptor.artifacts.indexOf(selected);
  const frozenSbomDocument = parseBoundedJson(
    frozenSbom,
    "frozen SPDX SBOM",
    MAX_SBOM_BYTES,
  );
  validateSpdx(frozenSbomDocument);

  const provenanceSource = regularFile(provenanceBundlePath, "artifact provenance bundle");
  const sbomSource = regularFile(sbomBundlePath, "SBOM attestation bundle");
  const provenanceSourceSize = lstatSync(provenanceSource).size;
  const sbomSourceSize = lstatSync(sbomSource).size;
  assert(provenanceSourceSize > 0 && provenanceSourceSize <= MAX_BUNDLE_BYTES
      && sbomSourceSize > 0 && sbomSourceSize <= MAX_BUNDLE_BYTES,
    "RELEASE_ATTESTATION_BUNDLE_INVALID",
    `attestation bundles must be non-empty and no larger than ${MAX_BUNDLE_BYTES} bytes`);
  const expectedProvenanceBundleSha256 = sha256File(provenanceSource);
  const expectedSbomBundleSha256 = sha256File(sbomSource);
  const provenanceVerification = verifyBundle({
    subjectPath: frozenArtifact,
    bundlePath: provenanceSource,
    repository: source.repository,
    sourceRef: source.ref,
    sourceDigest: source.commit,
    signerWorkflow: signer.signerWorkflow,
    signerDigest: signer.signerDigest,
    signerRef: signer.signerRef,
    predicateType: PROVENANCE_PREDICATE,
    trustedRunUrl: runUrl,
  });
  const sbomVerification = verifyBundle({
    subjectPath: frozenArtifact,
    bundlePath: sbomSource,
    repository: source.repository,
    sourceRef: source.ref,
    sourceDigest: source.commit,
    signerWorkflow: signer.signerWorkflow,
    signerDigest: signer.signerDigest,
    signerRef: signer.signerRef,
    predicateType: SBOM_PREDICATE,
    trustedRunUrl: runUrl,
  });
  assert(jsonEqual(sbomVerification?.statement?.predicate, frozenSbomDocument),
    "RELEASE_ATTESTATION_SBOM_PREDICATE_MISMATCH",
    "verified SBOM attestation predicate does not match the exact frozen SPDX document");
  for (const [verification, sourcePath, label] of [
    [provenanceVerification, provenanceSource, "provenance verification"],
    [sbomVerification, sbomSource, "SBOM verification"],
  ]) {
    assertObject(verification, label);
    assertObject(verification.bundle, `${label}.bundle`);
    assert(samePath(resolve(verification.bundle.path), sourcePath),
      "RELEASE_ATTESTATION_VERIFICATION_BUNDLE_MISMATCH",
      `${label} did not verify the supplied bundle path`);
    assert(verification.certificateBackedSignerVerified === true,
      "RELEASE_ATTESTATION_CERTIFICATE_INVALID",
      `${label} did not expose a certificate-backed signer identity`);
    if (verification.predicateType === PROVENANCE_PREDICATE) {
      assert(verification.runBinding === "provenance-invocation"
          && verification.runUrl === runUrl,
      "RELEASE_ATTESTATION_RUN_MISMATCH",
      `${label} did not bind its exact invocation to the trusted GitHub run URL`);
    } else {
      assert(verification.runBinding === "verification-context-only"
          && verification.runUrl === runUrl,
      "RELEASE_ATTESTATION_RUN_MISMATCH",
      `${label} was not verified in the protected finalizer run context`);
    }
  }
  const verifierVersions = [provenanceVerification.verifierVersion, sbomVerification.verifierVersion]
    .filter((value) => value !== undefined);
  if (verifierVersions.length > 0) {
    assert(verifierVersions.every((value) => value === PINNED_GH_VERSION),
      "RELEASE_ATTESTATION_VERIFIER_VERSION_MISMATCH",
      `attestation verification must use GitHub CLI ${PINNED_GH_VERSION}`);
    assert(new Set(verifierVersions).size === 1,
      "RELEASE_ATTESTATION_VERIFIER_VERSION_MISMATCH",
      "artifact and SBOM attestations must use one verifier version");
    writeOptionalOutput(outputPath, "verifier-version", verifierVersions[0]);
    writeOptionalOutput(outputPath, "verifier-path",
      provenanceVerification.verifierPath ?? sbomVerification.verifierPath ?? "");
  }
  assert(sha256File(provenanceSource) === expectedProvenanceBundleSha256
      && sha256File(sbomSource) === expectedSbomBundleSha256,
  "RELEASE_ATTESTATION_BUNDLE_CHANGED",
  "attestation bundle changed after cryptographic verification");
  const artifactFileName = safeArtifactFileName(artifact);
  const provenanceDestination = resolve(
    evidence,
    `${artifactFileName}.provenance.bundle.json`,
  );
  const sbomDestination = resolve(
    evidence,
    `${artifactFileName}.sbom.bundle.json`,
  );
  for (const [destination, label] of [
    [provenanceDestination, "provenance bundle destination"],
    [sbomDestination, "SBOM bundle destination"],
  ]) {
    assertNoSymlinkAncestors(destination, label);
    assert(samePath(dirname(destination), evidence),
      "RELEASE_ATTESTATION_OUTPUT_INVALID", `${label} escaped evidence directory`);
    assert(!existsSync(destination), "RELEASE_ATTESTATION_OUTPUT_EXISTS",
      `${label} already exists`);
  }
  const createdDestinations = [];
  let provenanceSha256;
  let sbomBundleSha256;
  try {
    const provenanceIdentity = copyBundle(
      provenanceSource,
      provenanceDestination,
      "provenance bundle",
    );
    createdDestinations.push({
      path: provenanceDestination,
      identity: provenanceIdentity ?? lstatSync(provenanceDestination),
    });
    const sbomIdentity = copyBundle(
      sbomSource,
      sbomDestination,
      "SBOM attestation bundle",
    );
    createdDestinations.push({
      path: sbomDestination,
      identity: sbomIdentity ?? lstatSync(sbomDestination),
    });
    regularFile(provenanceDestination, "copied artifact provenance bundle");
    regularFile(sbomDestination, "copied SBOM attestation bundle");
    provenanceSha256 = sha256File(provenanceDestination);
    sbomBundleSha256 = sha256File(sbomDestination);
    assert(provenanceSha256 === expectedProvenanceBundleSha256
        && sbomBundleSha256 === expectedSbomBundleSha256,
    "RELEASE_ATTESTATION_BUNDLE_CHANGED",
    "copied attestation bundle does not match the cryptographically verified bundle");
  } catch (error) {
    rollbackOwnedBundleDestinations(createdDestinations);
    if (!(error instanceof ReleaseAttestationError)) {
      fail("RELEASE_ATTESTATION_OUTPUT_WRITE_FAILED", error.message);
    }
    throw error;
  }
  let baseDirectory;
  let enrichedOutput;
  try {
    const finalArtifactSha256 = sha256File(artifact);
    const finalFrozenArtifactSha256 = sha256File(frozenArtifact);
    const finalSbomSha256 = sha256File(sbom);
    const finalFrozenSbomSha256 = sha256File(frozenSbom);
    assert(finalArtifactSha256 === expectedArtifactSha256
        && finalFrozenArtifactSha256 === expectedArtifactSha256
        && finalSbomSha256 === expectedSbomSha256
        && finalFrozenSbomSha256 === expectedSbomSha256,
    "RELEASE_ATTESTATION_SUBJECT_CHANGED",
    "artifact or SBOM changed after cryptographic bundle verification");
    assert(sha256File(descriptorFile) === expectedDescriptorSha256,
      "RELEASE_ATTESTATION_DESCRIPTOR_CHANGED",
      "release descriptor changed after cryptographic bundle verification");
    baseDirectory = commonDirectory([
      artifact,
      sbom,
      descriptorFile,
      provenanceDestination,
      sbomDestination,
    ]);
    const provenanceBundle = {
      path: provenanceDestination,
      mediaType: provenanceVerification.bundle.mediaType,
    };
    const sbomBundle = {
      path: sbomDestination,
      mediaType: sbomVerification.bundle.mediaType,
    };
    assert(provenanceBundle.mediaType === SIGSTORE_BUNDLE_MEDIA_TYPE
        && sbomBundle.mediaType === SIGSTORE_BUNDLE_MEDIA_TYPE,
    "RELEASE_ATTESTATION_BUNDLE_INVALID",
    "verified bundles must expose the Sigstore v0.3 media type");
    const enrichedDescriptor = buildEnrichedDescriptor({
      descriptor,
      descriptorDirectory: dirname(descriptorFile),
      selectedIndex,
      baseDirectory,
      artifactPath: artifact,
      sbomPath: sbom,
      artifactSha256: expectedArtifactSha256,
      sbomSha256: expectedSbomSha256,
      provenanceDestination,
      sbomDestination,
      provenanceBundle,
      sbomBundle,
      provenanceBundleSha256: provenanceSha256,
      sbomBundleSha256,
      provenanceVerification,
      sbomVerification,
      source: {
        version: descriptor.version,
        tag: source.tag,
        commit: source.commit,
        repository: descriptor.repository,
      },
      signer,
    });
    const enrichedDescriptorPath = join(
      baseDirectory,
      `.trusted-release-evidence-${expectedArtifactSha256.slice(0, 16)}.json`,
    );
    enrichedOutput = writeExclusiveJson(
      enrichedDescriptorPath,
      enrichedDescriptor,
      "trusted release descriptor",
    );
    writeOptionalOutput(outputPath, "provenance-bundle-path", provenanceDestination);
    writeOptionalOutput(outputPath, "sbom-bundle-path", sbomDestination);
    writeOptionalOutput(outputPath, "provenance-bundle-sha256", provenanceSha256);
    writeOptionalOutput(outputPath, "sbom-bundle-sha256", sbomBundleSha256);
    writeOptionalOutput(outputPath, "enriched-release-descriptor-path", enrichedOutput.path);
    writeOptionalOutput(outputPath, "enriched-release-descriptor-base-dir", baseDirectory);
  } catch (error) {
    rollbackOwnedBundleDestinations(createdDestinations);
    if (enrichedOutput !== undefined) {
      removeOwnedDestination(enrichedOutput);
    }
    throw error;
  }
  if (cleanupStaging) {
    cleanupFrozenStaging(frozenArtifact, frozenSbom, frozenStagingIdentity);
  }
  return Object.freeze({
    provenanceBundlePath: provenanceDestination,
    sbomBundlePath: sbomDestination,
    provenanceBundleSha256: provenanceSha256,
    sbomBundleSha256,
    enrichedReleaseDescriptorPath: enrichedOutput.path,
    enrichedReleaseDescriptorBaseDir: baseDirectory,
    verifierVersion: verifierVersions[0] ?? null,
    verifierPath: provenanceVerification.verifierPath ?? sbomVerification.verifierPath ?? null,
  });
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  assert(command === "preflight" || command === "collect" || command === "install-verifier",
    "RELEASE_ATTESTATION_ARGUMENT_INVALID",
    "command must be preflight, collect, or install-verifier");
  const values = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    assert(/^--[a-z-]+$/u.test(key), "RELEASE_ATTESTATION_ARGUMENT_INVALID",
      `unknown argument: ${key}`);
    assert(index + 1 < rest.length && !rest[index + 1].startsWith("--"),
      "RELEASE_ATTESTATION_ARGUMENT_INVALID", `${key} requires a value`);
    assert(!values.has(key), "RELEASE_ATTESTATION_ARGUMENT_INVALID",
      `${key} was repeated`);
    values.set(key, rest[++index]);
  }
  return { command, values };
}

function option(values, name) {
  return values.get(`--${name}`) ?? process.env[name.replaceAll("-", "_").toUpperCase()];
}

export function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArguments(argv);
  if (command === "install-verifier") {
    assert(values.size === 0, "RELEASE_ATTESTATION_ARGUMENT_INVALID",
      "install-verifier does not accept arguments");
    return installPinnedGhVerifier();
  }
  const common = {
    artifactPath: option(values, "artifact-path"),
    sbomPath: option(values, "sbom-path"),
    evidenceDirectory: option(values, "evidence-directory"),
    releaseDescriptorPath: option(values, "release-descriptor-path"),
    frozenArtifactPath: option(values, "frozen-artifact-path"),
    frozenSbomPath: option(values, "frozen-sbom-path"),
    trustedRepository: process.env.RELEASE_TRUSTED_REPOSITORY,
    trustedRef: process.env.RELEASE_TRUSTED_REF,
    trustedSha: process.env.RELEASE_TRUSTED_SHA,
    trustedWorkflowRef: process.env.RELEASE_TRUSTED_WORKFLOW_REF,
    trustedWorkflowSha: process.env.RELEASE_TRUSTED_WORKFLOW_SHA,
    trustedServerUrl: process.env.RELEASE_TRUSTED_SERVER_URL,
    trustedRunId: process.env.RELEASE_TRUSTED_RUN_ID,
    trustedRunAttempt: process.env.RELEASE_TRUSTED_RUN_ATTEMPT,
    outputPath: process.env.GITHUB_OUTPUT,
  };
  if (command === "preflight") {
    return preflightReleaseAttestation({
      ...common,
      workspace: process.env.GITHUB_WORKSPACE || process.cwd(),
    });
  }
  return collectReleaseAttestation({
    ...common,
    expectedArtifactSha256: option(values, "expected-artifact-sha256"),
    expectedSbomSha256: option(values, "expected-sbom-sha256"),
    expectedDescriptorSha256: option(values, "expected-descriptor-sha256"),
    provenanceBundlePath: option(values, "provenance-bundle-path"),
    sbomBundlePath: option(values, "sbom-bundle-path"),
  });
}

if (process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  Promise.resolve()
    .then(() => main())
    .catch((error) => {
      console.error(`${error?.code ?? "RELEASE_ATTESTATION_FAILED"}: ${error.message}`);
      process.exitCode = 1;
    });
}
