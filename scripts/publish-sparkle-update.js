#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_BRAND } from "../config/product-brand.js";
import {
  assertReleaseChannelPublication,
  resolveReleaseChannel,
} from "../config/release-channels.js";
import { validateMacOSDMG } from "./macos-release-core.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const WRANGLER_PATH = join(
  REPOSITORY_ROOT,
  "apps",
  "worker",
  "node_modules",
  ".bin",
  "wrangler",
);

const STABLE_CHANNEL = resolveReleaseChannel("stable");
export const APPROVED_R2_BUCKET = STABLE_CHANNEL.sparkle.r2Bucket;
export const CANONICAL_UPDATE_ORIGIN = STABLE_CHANNEL.sparkle.origin;
export const CANONICAL_APPCAST_URL = STABLE_CHANNEL.sparkle.appcastURL;
export const RELEASE_MANIFEST_SCHEMA = "usage-monitor-macos-release-v0.2";
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const APPCAST_CACHE_CONTROL = "public, max-age=300, must-revalidate";

const REQUIRED_RELEASE_ASSURANCES = Object.freeze([
  "appNotarizationAccepted",
  "appTicketStapled",
  "candidateReproducedFromCheckedOutSource",
  "cleanProfileSmokePassed",
  "developerIDHardenedRuntime",
  "dmgGatekeeperAssessmentPassed",
  "dmgNotarizationAccepted",
  "dmgTicketStapled",
]);
const MAX_APPCAST_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_DMG_BYTES = 10 * 1024 * 1024 * 1024;
const PUBLIC_READBACK_TIMEOUT_MS = 30_000;
const BUNDLE_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,2}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ED25519_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/u;
const ED25519_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/u;
const SAFE_DMG_FILE_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.dmg$/u;
const ED25519_SPKI_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);
const SAFE_RELEASE_OBJECT_FILE_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:dmg|delta)$/u;

function fail(message, code = "SPARKLE_UPDATE_PUBLICATION_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function defaultPublicFetch(...arguments_) {
  if (typeof globalThis.fetch !== "function") {
    fail(
      "Public update read-back requires the Node fetch implementation",
      "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    );
  }
  return globalThis.fetch(...arguments_);
}

function requiredOption(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(`${label} is required`);
  }
  return value;
}

async function readRegularInput(path, { label, maximumBytes }) {
  const selected = resolve(requiredOption(path, label));
  const metadata = await lstat(selected).catch((error) => {
    if (error.code === "ENOENT") fail(`${label} does not exist`);
    throw error;
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()
      || await realpath(selected) !== selected) {
    fail(`${label} must be a regular file outside symbolic links`);
  }
  if (metadata.size < 1 || metadata.size > maximumBytes) {
    fail(`${label} has an invalid size`);
  }
  return Object.freeze({ path: selected, size: metadata.size });
}

async function readFileWithSha256(path) {
  const bytes = await readFile(path);
  return Object.freeze({
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function normalizeSparklePublicKey(value) {
  if (typeof value !== "string"
      || !ED25519_PUBLIC_KEY_PATTERN.test(value)) {
    fail(
      "--sparkle-public-ed-key must be canonical base64 for 32 public-key bytes",
      "SPARKLE_UPDATE_PUBLIC_KEY_INVALID",
    );
  }
  const raw = Buffer.from(value, "base64");
  if (raw.length !== 32 || raw.toString("base64") !== value) {
    fail(
      "--sparkle-public-ed-key must be canonical base64 for 32 public-key bytes",
      "SPARKLE_UPDATE_PUBLIC_KEY_INVALID",
    );
  }
  let key;
  try {
    key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    fail(
      "--sparkle-public-ed-key could not be imported as an Ed25519 public key",
      "SPARKLE_UPDATE_PUBLIC_KEY_INVALID",
    );
  }
  return Object.freeze({
    encoded: value,
    key,
    sha256: createHash("sha256").update(raw).digest("hex"),
  });
}

function readManifest(text) {
  try {
    const selected = JSON.parse(text);
    if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
      fail("Release manifest must be a JSON object");
    }
    return selected;
  } catch (error) {
    if (error?.code) throw error;
    fail("Release manifest is not valid JSON");
  }
}

function validateReleaseManifest(
  manifest,
  dmg,
  sparklePublicKey,
  channel,
) {
  if (manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA
      || manifest.application?.bundleIdentifier !== PRODUCT_BRAND.bundleIdentifier
      || typeof manifest.application?.bundleVersion !== "string"
      || !BUNDLE_VERSION_PATTERN.test(manifest.application.bundleVersion)
      || typeof manifest.application?.shortVersion !== "string"
      || manifest.application.shortVersion.length === 0
      || typeof manifest.artifact?.fileName !== "string"
      || !SAFE_DMG_FILE_NAME_PATTERN.test(manifest.artifact.fileName)
      || manifest.artifact.fileName.includes("..")
      || basename(manifest.artifact.fileName) !== manifest.artifact.fileName
      || manifest.artifact.fileName !== basename(dmg.path)
      || !Number.isSafeInteger(manifest.artifact?.bytes)
      || manifest.artifact.bytes !== dmg.size
      || typeof manifest.artifact?.sha256 !== "string"
      || !SHA256_PATTERN.test(manifest.artifact.sha256)
      || manifest.updater?.enabled !== true
      || manifest.updater?.requiresSignedFeed !== true
      || manifest.updater?.appcastURL !== channel.sparkle.appcastURL
      || REQUIRED_RELEASE_ASSURANCES.some(
        (key) => manifest.assurances?.[key] !== true,
      )) {
    fail("Release manifest is not a complete canonical signed-DMG release");
  }
  try {
    assertReleaseChannelPublication(channel.name, manifest.channel);
  } catch {
    fail(
      `Release manifest channel provenance does not match ${channel.name}`,
      "SPARKLE_UPDATE_CHANNEL_MISMATCH",
    );
  }
  if (!SHA256_PATTERN.test(manifest.updater?.publicEdKeySha256 ?? "")) {
    fail(
      "Release manifest is missing the public Ed25519 key fingerprint",
      "SPARKLE_UPDATE_PUBLIC_KEY_MISMATCH",
    );
  }
  if (manifest.updater.publicEdKeySha256 !== sparklePublicKey.sha256) {
    fail(
      "Release manifest public Ed25519 key fingerprint does not match the supplied public key",
      "SPARKLE_UPDATE_PUBLIC_KEY_MISMATCH",
    );
  }
  return Object.freeze({
    artifactSha256: manifest.artifact.sha256,
    bundleVersion: manifest.application.bundleVersion,
    manifest,
  });
}

function parseEnclosureAttributes(source) {
  const attributes = new Map();
  const attributePattern = /\s+([A-Za-z_:][A-Za-z0-9:._-]*)\s*=\s*("[^"]*"|'[^']*')/gu;
  let match;
  while ((match = attributePattern.exec(source)) !== null) {
    const [, key, quotedValue] = match;
    if (attributes.has(key)) fail("Appcast enclosure has a duplicate attribute");
    attributes.set(key, quotedValue.slice(1, -1));
  }
  if (!/^\s*$/u.test(source.replace(attributePattern, ""))
      || [...attributes.values()].some(
    (value) => value.includes("&") || value.includes("<"),
  )) {
    fail("Appcast enclosure attributes must be simple quoted values");
  }
  return attributes;
}

function validateAppcastSignature(value) {
  if (typeof value !== "string"
      || !ED25519_SIGNATURE_PATTERN.test(value)
      || Buffer.from(value, "base64").length !== 64
      || Buffer.from(value, "base64").toString("base64") !== value) {
    fail("Appcast enclosure is missing a canonical Sparkle Ed25519 signature");
  }
}

function verifyEnclosureSignature({ bytes, enclosure, sparklePublicKey }) {
  let signatureVerified = false;
  try {
    signatureVerified = verify(
      null,
      bytes,
      sparklePublicKey.key,
      Buffer.from(enclosure.signature, "base64"),
    );
  } catch {
    signatureVerified = false;
  }
  if (!signatureVerified) {
    fail(
      "Appcast enclosure signature does not verify against its artifact and the supplied public key",
      "SPARKLE_UPDATE_SIGNATURE_INVALID",
    );
  }
}

function validatePublishedDownloadURL(value, channel) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("Appcast enclosure URL is invalid");
  }
  let selected;
  try {
    selected = new URL(value);
  } catch {
    fail("Appcast enclosure URL is invalid");
  }
  const objectPrefix = `${channel.sparkle.objectPrefix}/`;
  if (selected.origin !== channel.sparkle.origin
      || selected.protocol !== "https:"
      || selected.username || selected.password
      || selected.search || selected.hash
      || !selected.pathname.startsWith(`/${objectPrefix}`)
      || selected.href !== value) {
    fail(`Appcast enclosure URL must be an exact immutable URL on the ${channel.name} feed origin`);
  }
  return selected.href;
}

function parsePublishedObjectKey(value, channel) {
  let selected;
  try {
    selected = new URL(value);
  } catch {
    fail("Appcast enclosure URL is invalid");
  }
  const prefixSegments = channel.sparkle.objectPrefix.split("/");
  const segments = selected.pathname.slice(1).split("/");
  const versionIndex = prefixSegments.length;
  if (selected.origin !== channel.sparkle.origin
      || segments.length !== versionIndex + 3
      || segments.slice(0, versionIndex).join("/")
        !== channel.sparkle.objectPrefix
      || !BUNDLE_VERSION_PATTERN.test(segments[versionIndex] ?? "")
      || !SHA256_PATTERN.test(segments[versionIndex + 1] ?? "")
      || !SAFE_RELEASE_OBJECT_FILE_NAME_PATTERN.test(
        segments[versionIndex + 2] ?? "",
      )) {
    fail(
      "Appcast enclosure URL must name a content-addressed DMG or delta object",
      "SPARKLE_UPDATE_APPCAST_OBJECT_PATH_INVALID",
    );
  }
  return Object.freeze({
    bundleVersion: segments[versionIndex],
    fileName: segments[versionIndex + 2],
    key: segments.join("/"),
    sha256: segments[versionIndex + 1],
  });
}

function compareBundleVersions(left, right) {
  const leftParts = left.split(".").map(Number).concat([0, 0]).slice(0, 3);
  const rightParts = right.split(".").map(Number).concat([0, 0]).slice(0, 3);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

function appcastEnclosures(text, channel) {
  if (text.includes("<!DOCTYPE") || text.includes("<!ENTITY")) {
    fail("Appcast must not contain a document type or entity declaration");
  }
  const matches = [...text.matchAll(/<enclosure\b([^>]*)\/>/gu)];
  if (matches.length === 0) fail("Appcast must contain a self-closing enclosure");
  return matches.map((match) => {
    const attributes = parseEnclosureAttributes(match[1]);
    const url = validatePublishedDownloadURL(attributes.get("url"), channel);
    const object = parsePublishedObjectKey(url, channel);
    const length = attributes.get("length");
    const lengthNumber = Number(length);
    if (!/^(?:0|[1-9][0-9]*)$/u.test(length ?? "")
        || !Number.isSafeInteger(lengthNumber)
        || lengthNumber < 1
        || lengthNumber > MAX_DMG_BYTES) {
      fail("Appcast enclosure length is invalid");
    }
    validateAppcastSignature(attributes.get("sparkle:edSignature"));
    const version = attributes.get("sparkle:version");
    if (typeof version !== "string"
        || !BUNDLE_VERSION_PATTERN.test(version)
        || object.bundleVersion !== version) {
      fail(
        "Appcast enclosure version must match its immutable object path",
        "SPARKLE_UPDATE_APPCAST_VERSION_MISMATCH",
      );
    }
    const deltaFrom = attributes.get("sparkle:deltaFrom");
    if (deltaFrom !== undefined
        && (!BUNDLE_VERSION_PATTERN.test(deltaFrom)
          || compareBundleVersions(deltaFrom, version) >= 0)) {
      fail(
        "Appcast delta source must be an older bundle version",
        "SPARKLE_UPDATE_APPCAST_DELTA_INVALID",
      );
    }
    return Object.freeze({
      deltaFrom,
      length: lengthNumber,
      objectKey: object.key,
      objectSha256: object.sha256,
      signature: attributes.get("sparkle:edSignature"),
      url,
      version,
    });
  });
}

function immutableObjectKeys({ bundleVersion, fileName, sha256, channel }) {
  const prefix = `${channel.sparkle.objectPrefix}/${bundleVersion}/${sha256}`;
  return Object.freeze({
    artifact: `${prefix}/${fileName}`,
    manifest: `${prefix}/release-manifest.json`,
  });
}

function validateAppcast(text, {
  channel,
  dmg,
  dmgBytes,
  manifest,
  objectKeys,
  sparklePublicKey,
}) {
  const enclosures = appcastEnclosures(text, channel);
  const artifactURL = new URL(
    objectKeys.artifact,
    `${channel.sparkle.origin}/`,
  ).href;
  const matching = enclosures.filter(
    (enclosure) => enclosure.url === artifactURL,
  );
  if (matching.length !== 1
      || matching[0].length !== dmg.size
      || matching[0].version !== manifest.bundleVersion
      || matching[0].deltaFrom !== undefined) {
    if (matching.length === 1 && matching[0].deltaFrom !== undefined) {
      fail(
        "The publisher only accepts a full candidate DMG; new Sparkle delta publication is unsupported",
        "SPARKLE_UPDATE_DELTA_UNSUPPORTED",
      );
    }
    fail("Appcast must contain exactly one signed enclosure for this manifest and DMG");
  }
  verifyEnclosureSignature({
    bytes: dmgBytes,
    enclosure: matching[0],
    sparklePublicKey,
  });
  return Object.freeze({
    artifactURL,
    enclosure: matching[0],
    enclosures: Object.freeze(enclosures),
  });
}

function responseHeader(response, name) {
  const value = response?.headers?.get?.(name);
  return typeof value === "string" ? value.trim() : "";
}

function declaredResponseLength(response, label, { required = false } = {}) {
  const value = responseHeader(response, "content-length");
  if (value === "") {
    if (required) {
      fail(
        `${label} response is missing Content-Length`,
        "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
      );
    }
    return null;
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    fail(
      `${label} response has an invalid Content-Length: ${value}`,
      "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    );
  }
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || selected > MAX_DMG_BYTES) {
    fail(
      `${label} response has an unsafe Content-Length: ${value}`,
      "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    );
  }
  return selected;
}

function validatePublicResponse(response, {
  cacheControl = null,
  contentType = null,
  label,
} = {}) {
  const status = response?.status;
  if (status !== 200) {
    fail(
      `${label} returned HTTP ${String(status)}`,
      "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    );
  }
  if (contentType !== null) {
    const observed = responseHeader(response, "content-type")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (observed !== contentType) {
      fail(
        `${label} returned Content-Type ${observed || "<missing>"}; expected ${contentType}`,
        "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
      );
    }
  }
  if (cacheControl !== null
      && responseHeader(response, "cache-control") !== cacheControl) {
    fail(
      `${label} returned Cache-Control ${responseHeader(response, "cache-control") || "<missing>"}; expected ${cacheControl}`,
      "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    );
  }
}

async function fetchPublicResponse(fetchPublic, url, {
  label,
  method = "GET",
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    PUBLIC_READBACK_TIMEOUT_MS,
  );
  try {
    const response = await fetchPublic(url, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      method,
      redirect: "error",
      signal: controller.signal,
    });
    if (response?.url && response.url !== url) {
      fail(
        `${label} redirected away from the canonical URL`,
        "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
      );
    }
    return response;
  } catch (error) {
    if (error?.code === "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED") throw error;
    if (error?.name === "AbortError") {
      fail(
        `${label} timed out after ${PUBLIC_READBACK_TIMEOUT_MS} ms`,
        "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
      );
    }
    fail(
      `${label} request failed: ${error?.message || String(error)}`,
      "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBytes(response, {
  expectedBytes = null,
  label,
  maximumBytes,
} = {}) {
  const declared = declaredResponseLength(response, label, {
    required: expectedBytes !== null,
  });
  if (declared !== null && declared > maximumBytes) {
    fail(
      `${label} response exceeds the safe size limit`,
      "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    );
  }
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    fail(
      `${label} body read failed: ${error?.message || String(error)}`,
      "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    );
  }
  if (bytes.length < 1 || bytes.length > maximumBytes) {
    fail(
      `${label} response has an unsafe body size: ${bytes.length}`,
      "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    );
  }
  if (declared !== null && declared !== bytes.length) {
    fail(
      `${label} Content-Length ${declared} does not match body bytes ${bytes.length}`,
      "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    );
  }
  if (expectedBytes !== null && expectedBytes !== bytes.length) {
    fail(
      `${label} body bytes ${bytes.length} do not match expected ${expectedBytes}`,
      "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    );
  }
  return bytes;
}

async function readResponseDigest(response, {
  expectedBytes,
  expectedSha256,
  label,
} = {}) {
  const declared = declaredResponseLength(response, label, { required: true });
  if (declared !== expectedBytes) {
    fail(
      `${label} Content-Length ${declared} does not match expected ${expectedBytes}`,
      "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    );
  }
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = Buffer.from(chunk.value);
        bytes += value.length;
        if (bytes > MAX_DMG_BYTES) {
          fail(
            `${label} response exceeds the safe size limit`,
            "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
          );
        }
        hash.update(value);
      }
    } else {
      const value = Buffer.from(await response.arrayBuffer());
      bytes = value.length;
      if (bytes > MAX_DMG_BYTES) {
        fail(
          `${label} response exceeds the safe size limit`,
          "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
        );
      }
      hash.update(value);
    }
  } catch (error) {
    if (error?.code === "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED") throw error;
    fail(
      `${label} body read failed: ${error?.message || String(error)}`,
      "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    );
  }
  if (bytes !== expectedBytes) {
    fail(
      `${label} body bytes ${bytes} do not match expected ${expectedBytes}`,
      "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    );
  }
  const observedSha256 = hash.digest("hex");
  if (observedSha256 !== expectedSha256) {
    fail(
      `${label} SHA-256 ${observedSha256} does not match expected ${expectedSha256}`,
      "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    );
  }
  return observedSha256;
}

async function verifyPublicPublication({
  appcastBytes,
  appcastUpdate,
  channel,
  dmg,
  dmgBytes,
  fetchPublic,
  manifest,
  objectKeys,
  publication,
  sparklePublicKey,
}) {
  const publicAppcastResponse = await fetchPublicResponse(
    fetchPublic,
    publication.appcast.url,
    { label: "Public Sparkle appcast" },
  );
  validatePublicResponse(publicAppcastResponse, {
    cacheControl: APPCAST_CACHE_CONTROL,
    contentType: "application/xml",
    label: "Public Sparkle appcast",
  });
  const publicAppcastBytes = await readResponseBytes(publicAppcastResponse, {
    expectedBytes: appcastBytes.length,
    label: "Public Sparkle appcast",
    maximumBytes: MAX_APPCAST_BYTES,
  });
  const localAppcastSha256 = createHash("sha256")
    .update(appcastBytes)
    .digest("hex");
  const publicAppcastSha256 = createHash("sha256")
    .update(publicAppcastBytes)
    .digest("hex");
  if (publicAppcastSha256 !== localAppcastSha256) {
    fail(
      `Public Sparkle appcast SHA-256 ${publicAppcastSha256} does not match the uploaded ${localAppcastSha256}`,
      "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    );
  }
  const publicAppcastText = publicAppcastBytes.toString("utf8");
  const publicUpdate = validateAppcast(publicAppcastText, {
    channel,
    dmg,
    dmgBytes,
    manifest,
    objectKeys,
    sparklePublicKey,
  });
  if (publicUpdate.artifactURL !== appcastUpdate.artifactURL
      || publicUpdate.enclosure.length !== appcastUpdate.enclosure.length
      || publicUpdate.enclosure.version !== appcastUpdate.enclosure.version
      || publicUpdate.enclosure.signature !== appcastUpdate.enclosure.signature) {
    fail(
      "Public Sparkle appcast does not retain the validated update enclosure",
      "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    );
  }

  const enclosures = appcastEnclosures(publicAppcastText, channel);
  for (const enclosure of enclosures) {
    if (enclosure.url === publication.artifact.url) continue;
    const response = await fetchPublicResponse(fetchPublic, enclosure.url, {
      label: `Public Sparkle enclosure ${enclosure.url}`,
      method: "HEAD",
    });
    validatePublicResponse(response, {
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      label: `Public Sparkle enclosure ${enclosure.url}`,
    });
    const declared = declaredResponseLength(response, "Public Sparkle enclosure", {
      required: true,
    });
    if (declared !== enclosure.length) {
      fail(
        `Public Sparkle enclosure ${enclosure.url} Content-Length ${declared} does not match appcast ${enclosure.length}`,
        "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
      );
    }
  }

  const publicArtifactResponse = await fetchPublicResponse(
    fetchPublic,
    publication.artifact.url,
    { label: "Public Sparkle DMG" },
  );
  validatePublicResponse(publicArtifactResponse, {
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    contentType: "application/x-apple-diskimage",
    label: "Public Sparkle DMG",
  });
  await readResponseDigest(publicArtifactResponse, {
    expectedBytes: dmg.size,
    expectedSha256: publication.artifact.sha256,
    label: "Public Sparkle DMG",
  });
}

function normalizeBucket(bucket, channel) {
  if (bucket !== channel.sparkle.r2Bucket) {
    fail(
      `--bucket must explicitly name the approved bucket ${channel.sparkle.r2Bucket} for channel ${channel.name}`,
      "SPARKLE_UPDATE_BUCKET_MISMATCH",
    );
  }
  return bucket;
}

function wranglerObjectPath(bucket, key) {
  return `${bucket}/${key}`;
}

function resultWasNotFound(result) {
  return result.status !== 0
    && /(?:not found|does not exist|nosuchkey)/iu.test(
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
}

function defaultRunWrangler(arguments_) {
  const result = spawnSync(WRANGLER_PATH, arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    fail("Pinned local Wrangler is unavailable", "SPARKLE_UPDATE_WRANGLER_FAILED");
  }
  return Object.freeze({
    status: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  });
}

async function readRemoteObject({
  bucket,
  key,
  maximumBytes = MAX_DMG_BYTES,
  runWrangler,
  temporaryRoot,
}) {
  const destination = join(
    temporaryRoot,
    createHash("sha256").update(`read:${key}`).digest("hex"),
  );
  await rm(destination, { force: true });
  const result = await runWrangler([
    "r2",
    "object",
    "get",
    wranglerObjectPath(bucket, key),
    "--file",
    destination,
    "--remote",
  ]);
  if (result?.status !== 0) {
    if (resultWasNotFound(result ?? {})) return null;
    fail(
      `Unable to read R2 object ${key}`,
      "SPARKLE_UPDATE_WRANGLER_FAILED",
    );
  }
  let metadata;
  try {
    metadata = await lstat(destination);
  } catch (error) {
    fail(
      `R2 object ${key} could not be read: ${error.message}`,
      "SPARKLE_UPDATE_R2_OBJECT_INVALID",
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size < 1 || metadata.size > maximumBytes) {
    fail(
      `R2 object ${key} was not returned as a safe regular file`,
      "SPARKLE_UPDATE_R2_OBJECT_INVALID",
    );
  }
  let resolvedDestination;
  try {
    resolvedDestination = await realpath(destination);
  } catch (error) {
    fail(
      `R2 object ${key} could not be resolved: ${error.message}`,
      "SPARKLE_UPDATE_R2_OBJECT_INVALID",
    );
  }
  if (resolvedDestination !== destination) {
    fail(
      `R2 object ${key} was returned outside the probe directory`,
      "SPARKLE_UPDATE_R2_OBJECT_INVALID",
    );
  }
  let contents;
  try {
    contents = await readFileWithSha256(destination);
  } catch (error) {
    fail(
      `R2 object ${key} could not be read: ${error.message}`,
      "SPARKLE_UPDATE_R2_OBJECT_INVALID",
    );
  }
  if (contents.bytes.length !== metadata.size) {
    fail(
      `R2 object ${key} changed while it was being read`,
      "SPARKLE_UPDATE_R2_OBJECT_INVALID",
    );
  }
  return Object.freeze({
    bytes: metadata.size,
    content: contents.bytes,
    path: destination,
    sha256: contents.sha256,
  });
}

function verifyRetainedImmutableObject({
  candidate,
  object,
  remote,
}) {
  if (remote.bytes !== candidate.bytes.length
      || remote.sha256 !== candidate.sha256
      || !remote.content.equals(candidate.bytes)) {
    fail(
      `Existing immutable R2 object ${object.key} does not match the validated candidate bytes, SHA-256, and size`,
      "SPARKLE_UPDATE_IMMUTABLE_OBJECT_MISMATCH",
    );
  }
  return remote;
}

function assertAppcastStateUnchanged(expected, observed, key) {
  const unchanged = expected === null
    ? observed === null
    : observed !== null
      && observed.bytes === expected.bytes
      && observed.sha256 === expected.sha256
      && observed.content.equals(expected.content);
  if (!unchanged) {
    fail(
      `R2 appcast ${key} changed during publication preflight`,
      "SPARKLE_UPDATE_APPCAST_STATE_CHANGED",
    );
  }
}

function highestAppcastVersion(text, channel) {
  const enclosures = appcastEnclosures(text, channel);
  return enclosures.reduce(
    (highest, enclosure) => highest === null
      || compareBundleVersions(enclosure.version, highest) > 0
      ? enclosure.version
      : highest,
    null,
  );
}

async function validatePublishedEnclosureObjects({
  appcastUpdate,
  bucket,
  dmg,
  runWrangler,
  sparklePublicKey,
  temporaryRoot,
}) {
  const remoteObjects = new Map();
  for (const enclosure of appcastUpdate.enclosures) {
    if (enclosure.url === appcastUpdate.artifactURL) {
      continue;
    }
    if (!remoteObjects.has(enclosure.objectKey)) {
      remoteObjects.set(
        enclosure.objectKey,
        await readRemoteObject({
          bucket,
          key: enclosure.objectKey,
          runWrangler,
          temporaryRoot,
        }),
      );
    }
    const remote = remoteObjects.get(enclosure.objectKey);
    if (!remote) {
      fail(
        `Appcast enclosure object is unavailable: ${enclosure.url}`,
        "SPARKLE_UPDATE_APPCAST_OBJECT_MISSING",
      );
    }
    if (remote.bytes !== enclosure.length) {
      fail(
        `Appcast enclosure byte length does not match R2 object: ${enclosure.url} (advertised ${enclosure.length}, received ${remote.bytes})`,
        "SPARKLE_UPDATE_APPCAST_OBJECT_LENGTH_MISMATCH",
      );
    }
    if (remote.sha256 !== enclosure.objectSha256) {
      fail(
        `Appcast enclosure SHA-256 does not match R2 object: ${enclosure.url} (expected ${enclosure.objectSha256}, received ${remote.sha256})`,
        "SPARKLE_UPDATE_APPCAST_OBJECT_CHECKSUM_MISMATCH",
      );
    }
    verifyEnclosureSignature({
      bytes: remote.content,
      enclosure,
      sparklePublicKey,
    });
  }
  if (appcastUpdate.enclosure.length !== dmg.size) {
    fail(
      "Current appcast enclosure length does not match the candidate DMG",
      "SPARKLE_UPDATE_APPCAST_LENGTH_MISMATCH",
    );
  }
}

async function putObject({ bucket, key, path, contentType, cacheControl, runWrangler }) {
  const result = await runWrangler([
    "r2",
    "object",
    "put",
    wranglerObjectPath(bucket, key),
    "--file",
    path,
    "--content-type",
    contentType,
    "--cache-control",
    cacheControl,
    "--remote",
  ]);
  if (result?.status !== 0) {
    fail("Wrangler could not publish the validated update object", "SPARKLE_UPDATE_WRANGLER_FAILED");
  }
}

/**
 * Validate and, only when publish is explicitly true, publish one complete
 * Sparkle update. The publisher deliberately accepts no Sparkle private signing
 * key nor Cloudflare credentials; the operator performs signing separately and
 * supplies only the public verification key. Wrangler uses its own existing
 * local authentication.
 */
export async function publishSparkleUpdate({
  appcastPath,
  bucket,
  channel,
  dmgPath,
  publish = false,
  releaseManifestPath,
  replaceAppcast = false,
  sparklePublicEdKey,
  runWrangler = defaultRunWrangler,
  fetchPublic = defaultPublicFetch,
  validateDMG = validateMacOSDMG,
} = {}) {
  if (typeof publish !== "boolean" || typeof replaceAppcast !== "boolean"
      || typeof runWrangler !== "function"
      || typeof fetchPublic !== "function"
      || typeof validateDMG !== "function") {
    fail("Publisher options are invalid");
  }
  const releaseChannel = resolveReleaseChannel(channel);
  normalizeBucket(bucket, releaseChannel);
  const normalizedSparklePublicKey = normalizeSparklePublicKey(sparklePublicEdKey);
  const [dmg, appcast, releaseManifest] = await Promise.all([
    readRegularInput(dmgPath, { label: "--dmg", maximumBytes: MAX_DMG_BYTES }),
    readRegularInput(appcastPath, {
      label: "--appcast",
      maximumBytes: MAX_APPCAST_BYTES,
    }),
    readRegularInput(releaseManifestPath, {
      label: "--release-manifest",
      maximumBytes: MAX_MANIFEST_BYTES,
    }),
  ]);
  const releaseManifestWithSha256 = await readFileWithSha256(releaseManifest.path);
  if (releaseManifestWithSha256.bytes.length !== releaseManifest.size) {
    fail("Release manifest changed while it was being read");
  }
  const manifest = validateReleaseManifest(
    readManifest(releaseManifestWithSha256.bytes.toString("utf8")),
    dmg,
    normalizedSparklePublicKey,
    releaseChannel,
  );
  await validateDMG(dmg.path, {
    expectedBundleIdentifier: manifest.manifest.application.bundleIdentifier,
    expectedBundleVersion: manifest.bundleVersion,
    expectedShortVersion: manifest.manifest.application.shortVersion,
    channel: releaseChannel.name,
    production: true,
  });
  const dmgWithSha256 = await readFileWithSha256(dmg.path);
  if (dmgWithSha256.bytes.length !== dmg.size) {
    fail("DMG changed while it was being validated");
  }
  const observedDMGSha256 = dmgWithSha256.sha256;
  if (observedDMGSha256 !== manifest.artifactSha256) {
    fail("DMG does not match the release manifest SHA-256");
  }
  const objectKeys = immutableObjectKeys({
    bundleVersion: manifest.bundleVersion,
    channel: releaseChannel,
    fileName: basename(dmg.path),
    sha256: observedDMGSha256,
  });
  const appcastBytes = await readFile(appcast.path);
  if (appcastBytes.length !== appcast.size) {
    fail("Appcast changed while it was being read");
  }
  const appcastUpdate = validateAppcast(
    appcastBytes.toString("utf8"),
    {
      channel: releaseChannel,
      dmg,
      dmgBytes: dmgWithSha256.bytes,
      manifest,
      objectKeys,
      sparklePublicKey: normalizedSparklePublicKey,
    },
  );
  const publication = Object.freeze({
    appcast: Object.freeze({
      cacheControl: APPCAST_CACHE_CONTROL,
      contentType: "application/xml; charset=utf-8",
      key: releaseChannel.sparkle.appcastObjectKey,
      path: appcast.path,
      url: releaseChannel.sparkle.appcastURL,
    }),
    channel: releaseChannel.name,
    artifact: Object.freeze({
      bytes: dmg.size,
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      contentType: "application/x-apple-diskimage",
      key: objectKeys.artifact,
      path: dmg.path,
      sha256: observedDMGSha256,
      url: appcastUpdate.artifactURL,
    }),
    bucket,
    manifest: Object.freeze({
      bytes: releaseManifestWithSha256.bytes.length,
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      contentType: "application/json; charset=utf-8",
      key: objectKeys.manifest,
      path: releaseManifest.path,
      sha256: releaseManifestWithSha256.sha256,
    }),
    published: publish,
  });
  if (!publish) return publication;

  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "tibotattle-r2-update-probe-"),
  );
  try {
    const immutableObjects = [
      {
        candidate: dmgWithSha256,
        maximumBytes: MAX_DMG_BYTES,
        object: publication.artifact,
      },
      {
        candidate: releaseManifestWithSha256,
        maximumBytes: MAX_MANIFEST_BYTES,
        object: publication.manifest,
      },
    ];
    for (const immutableObject of immutableObjects) {
      const remote = await readRemoteObject({
        bucket,
        key: immutableObject.object.key,
        maximumBytes: immutableObject.maximumBytes,
        runWrangler,
        temporaryRoot,
      });
      if (remote !== null) {
        verifyRetainedImmutableObject({
          candidate: immutableObject.candidate,
          object: immutableObject.object,
          remote,
        });
      }
      immutableObject.remote = remote;
    }
    const currentAppcast = await readRemoteObject({
      bucket,
      key: publication.appcast.key,
      maximumBytes: MAX_APPCAST_BYTES,
      runWrangler,
      temporaryRoot,
    });
    if (currentAppcast !== null && !replaceAppcast) {
      fail("Refusing to replace appcast.xml without --replace-appcast", "SPARKLE_UPDATE_APPCAST_REPLACE_REQUIRED");
    }
    if (currentAppcast !== null) {
      const currentVersion = highestAppcastVersion(
        currentAppcast.content.toString("utf8"),
        releaseChannel,
      );
      if (currentVersion === null
          || compareBundleVersions(manifest.bundleVersion, currentVersion) <= 0) {
        fail(
          `Candidate bundle version ${manifest.bundleVersion} is not newer than the live appcast version ${currentVersion ?? "unknown"}`,
          "SPARKLE_UPDATE_VERSION_NOT_NEWER",
        );
      }
    }
    await validatePublishedEnclosureObjects({
      appcastUpdate,
      bucket,
      dmg,
      runWrangler,
      sparklePublicKey: normalizedSparklePublicKey,
      temporaryRoot,
    });
    for (const immutableObject of immutableObjects) {
      if (immutableObject.remote !== null) continue;
      await putObject({
        bucket,
        key: immutableObject.object.key,
        path: immutableObject.object.path,
        contentType: immutableObject.object.contentType,
        cacheControl: immutableObject.object.cacheControl,
        runWrangler,
      });
    }
    const appcastBeforeWrite = await readRemoteObject({
      bucket,
      key: publication.appcast.key,
      maximumBytes: MAX_APPCAST_BYTES,
      runWrangler,
      temporaryRoot,
    });
    assertAppcastStateUnchanged(
      currentAppcast,
      appcastBeforeWrite,
      publication.appcast.key,
    );
    await putObject({
      bucket,
      key: publication.appcast.key,
      path: publication.appcast.path,
      contentType: publication.appcast.contentType,
      cacheControl: publication.appcast.cacheControl,
      runWrangler,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  await verifyPublicPublication({
    appcastBytes,
    appcastUpdate,
    channel: releaseChannel,
    dmg,
    dmgBytes: dmgWithSha256.bytes,
    fetchPublic,
    manifest,
    objectKeys,
    publication,
    sparklePublicKey: normalizedSparklePublicKey,
  });
  return publication;
}

export function parseSparkleUpdatePublisherArguments(argv) {
  const options = {
    appcastPath: null,
    bucket: null,
    channel: null,
    dmgPath: null,
    publish: false,
    releaseManifestPath: null,
    replaceAppcast: false,
    sparklePublicEdKey: null,
  };
  const flags = new Map([
    ["--appcast", "appcastPath"],
    ["--bucket", "bucket"],
    ["--channel", "channel"],
    ["--dmg", "dmgPath"],
    ["--release-manifest", "releaseManifestPath"],
    ["--sparkle-public-ed-key", "sparklePublicEdKey"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (flags.has(argument)) {
      const key = flags.get(argument);
      if (options[key] !== null || index + 1 >= argv.length) {
        fail(`${argument} must be supplied exactly once with a value`);
      }
      options[key] = argv[++index];
    } else if (argument === "--publish" && !options.publish) {
      options.publish = true;
    } else if (argument === "--replace-appcast" && !options.replaceAppcast) {
      options.replaceAppcast = true;
    } else {
      fail(`Unknown or repeated argument: ${argument}`);
    }
  }
  for (const [flag, key] of flags) requiredOption(options[key], flag);
  resolveReleaseChannel(options.channel);
  if (options.replaceAppcast && !options.publish) {
    fail("--replace-appcast requires --publish");
  }
  return Object.freeze(options);
}

export async function main(argv) {
  const publication = await publishSparkleUpdate(
    parseSparkleUpdatePublisherArguments(argv),
  );
  console.log(`Validated signed DMG SHA-256: ${publication.artifact.sha256}`);
  console.log(`R2 artifact: ${publication.bucket}/${publication.artifact.key}`);
  console.log(`R2 manifest: ${publication.bucket}/${publication.manifest.key}`);
  console.log(`R2 appcast: ${publication.appcast.url}`);
  if (!publication.published) {
    console.log("Validation only; re-run with --publish to invoke Wrangler.");
  } else {
    console.log("Public read-back: canonical appcast and DMG verified.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`publish-sparkle-update: ${error.message}`);
    process.exitCode = 1;
  });
}
