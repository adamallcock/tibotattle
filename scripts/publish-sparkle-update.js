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
import { DEPLOYMENT_ENDPOINTS } from "../config/deployment-endpoints.js";
import { PRODUCT_BRAND } from "../config/product-brand.js";
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

export const APPROVED_R2_BUCKET = DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket;
export const CANONICAL_UPDATE_ORIGIN = DEPLOYMENT_ENDPOINTS.sparkle.origin;
export const CANONICAL_APPCAST_URL = DEPLOYMENT_ENDPOINTS.sparkle.appcastURL;
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

function fail(message, code = "SPARKLE_UPDATE_PUBLICATION_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
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

function validateReleaseManifest(manifest, dmg, sparklePublicKey) {
  if (manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA
      || manifest.application?.bundleIdentifier !== PRODUCT_BRAND.bundleIdentifier
      || typeof manifest.application?.bundleVersion !== "string"
      || !BUNDLE_VERSION_PATTERN.test(manifest.application.bundleVersion)
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
      || manifest.updater?.appcastURL !== CANONICAL_APPCAST_URL
      || REQUIRED_RELEASE_ASSURANCES.some(
        (key) => manifest.assurances?.[key] !== true,
      )) {
    fail("Release manifest is not a complete canonical signed-DMG release");
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

function validatePublishedDownloadURL(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("Appcast enclosure URL is invalid");
  }
  let selected;
  try {
    selected = new URL(value);
  } catch {
    fail("Appcast enclosure URL is invalid");
  }
  if (selected.origin !== CANONICAL_UPDATE_ORIGIN
      || selected.protocol !== "https:"
      || selected.username || selected.password
      || selected.search || selected.hash
      || !selected.pathname.startsWith("/releases/")
      || selected.href !== value) {
    fail("Appcast enclosure URL must be an exact immutable URL on the approved feed origin");
  }
  return selected.href;
}

function appcastEnclosures(text) {
  if (text.includes("<!DOCTYPE") || text.includes("<!ENTITY")) {
    fail("Appcast must not contain a document type or entity declaration");
  }
  const matches = [...text.matchAll(/<enclosure\b([^>]*)\/>/gu)];
  if (matches.length === 0) fail("Appcast must contain a self-closing enclosure");
  return matches.map((match) => {
    const attributes = parseEnclosureAttributes(match[1]);
    const url = validatePublishedDownloadURL(attributes.get("url"));
    const length = attributes.get("length");
    if (!/^(?:0|[1-9][0-9]*)$/u.test(length ?? "")) {
      fail("Appcast enclosure length is invalid");
    }
    validateAppcastSignature(attributes.get("sparkle:edSignature"));
    return Object.freeze({
      length: Number(length),
      signature: attributes.get("sparkle:edSignature"),
      url,
      version: attributes.get("sparkle:version"),
    });
  });
}

function immutableObjectKeys({ bundleVersion, fileName, sha256 }) {
  const prefix = `releases/${bundleVersion}/${sha256}`;
  return Object.freeze({
    artifact: `${prefix}/${fileName}`,
    manifest: `${prefix}/release-manifest.json`,
  });
}

function validateAppcast(text, {
  dmg,
  dmgBytes,
  manifest,
  objectKeys,
  sparklePublicKey,
}) {
  const enclosures = appcastEnclosures(text);
  if (enclosures.length !== 1) {
    fail(
      "Appcast must contain exactly one enclosure so every published signature is locally verified",
      "SPARKLE_UPDATE_UNVERIFIED_ENCLOSURES",
    );
  }
  const artifactURL = new URL(
    objectKeys.artifact,
    `${CANONICAL_UPDATE_ORIGIN}/`,
  ).href;
  const matching = enclosures.filter(
    (enclosure) => enclosure.url === artifactURL,
  );
  if (matching.length !== 1
      || matching[0].length !== dmg.size
      || matching[0].version !== manifest.bundleVersion) {
    fail("Appcast must contain exactly one signed enclosure for this manifest and DMG");
  }
  let signatureVerified = false;
  try {
    signatureVerified = verify(
      null,
      dmgBytes,
      sparklePublicKey.key,
      Buffer.from(matching[0].signature, "base64"),
    );
  } catch {
    signatureVerified = false;
  }
  if (!signatureVerified) {
    fail(
      "Appcast enclosure signature does not verify against the supplied DMG and public key",
      "SPARKLE_UPDATE_SIGNATURE_INVALID",
    );
  }
  return Object.freeze({ artifactURL, enclosure: matching[0] });
}

function normalizeBucket(bucket) {
  if (bucket !== APPROVED_R2_BUCKET) {
    fail(`--bucket must explicitly name the approved bucket ${APPROVED_R2_BUCKET}`);
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

async function remoteObjectExists({ bucket, key, runWrangler, temporaryRoot }) {
  const destination = join(
    temporaryRoot,
    createHash("sha256").update(key).digest("hex"),
  );
  const result = await runWrangler([
    "r2",
    "object",
    "get",
    wranglerObjectPath(bucket, key),
    "--file",
    destination,
    "--remote",
  ]);
  if (result?.status === 0) return true;
  if (resultWasNotFound(result ?? {})) return false;
  fail("Unable to establish the current R2 object state", "SPARKLE_UPDATE_WRANGLER_FAILED");
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
  dmgPath,
  publish = false,
  releaseManifestPath,
  replaceAppcast = false,
  sparklePublicEdKey,
  runWrangler = defaultRunWrangler,
  validateDMG = validateMacOSDMG,
} = {}) {
  if (typeof publish !== "boolean" || typeof replaceAppcast !== "boolean"
      || typeof runWrangler !== "function" || typeof validateDMG !== "function") {
    fail("Publisher options are invalid");
  }
  normalizeBucket(bucket);
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
  const manifest = validateReleaseManifest(
    readManifest(await readFile(releaseManifest.path, "utf8")),
    dmg,
    normalizedSparklePublicKey,
  );
  await validateDMG(dmg.path, { production: true });
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
    fileName: basename(dmg.path),
    sha256: observedDMGSha256,
  });
  const appcastUpdate = validateAppcast(
    await readFile(appcast.path, "utf8"),
    {
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
      key: "appcast.xml",
      path: appcast.path,
      url: CANONICAL_APPCAST_URL,
    }),
    artifact: Object.freeze({
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      contentType: "application/x-apple-diskimage",
      key: objectKeys.artifact,
      path: dmg.path,
      sha256: observedDMGSha256,
      url: appcastUpdate.artifactURL,
    }),
    bucket,
    manifest: Object.freeze({
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      contentType: "application/json; charset=utf-8",
      key: objectKeys.manifest,
      path: releaseManifest.path,
    }),
    published: publish,
  });
  if (!publish) return publication;

  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "tibotattle-r2-update-probe-"),
  );
  try {
    for (const object of [publication.artifact, publication.manifest]) {
      if (await remoteObjectExists({
        bucket,
        key: object.key,
        runWrangler,
        temporaryRoot,
      })) {
        fail("Refusing to overwrite an immutable R2 update object", "SPARKLE_UPDATE_OBJECT_EXISTS");
      }
    }
    const appcastExists = await remoteObjectExists({
      bucket,
      key: publication.appcast.key,
      runWrangler,
      temporaryRoot,
    });
    if (appcastExists && !replaceAppcast) {
      fail("Refusing to replace appcast.xml without --replace-appcast", "SPARKLE_UPDATE_APPCAST_REPLACE_REQUIRED");
    }
    for (const object of [publication.artifact, publication.manifest, publication.appcast]) {
      await putObject({
        bucket,
        key: object.key,
        path: object.path,
        contentType: object.contentType,
        cacheControl: object.cacheControl,
        runWrangler,
      });
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  return publication;
}

export function parseSparkleUpdatePublisherArguments(argv) {
  const options = {
    appcastPath: null,
    bucket: null,
    dmgPath: null,
    publish: false,
    releaseManifestPath: null,
    replaceAppcast: false,
    sparklePublicEdKey: null,
  };
  const flags = new Map([
    ["--appcast", "appcastPath"],
    ["--bucket", "bucket"],
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
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`publish-sparkle-update: ${error.message}`);
    process.exitCode = 1;
  });
}
