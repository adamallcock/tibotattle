#!/usr/bin/env node
/**
 * Generate the canonical single-item Sparkle appcast for one signed release
 * artifact, producing EdDSA-signed BinaryDelta updates from locally retained
 * prior versions.
 *
 * This is signing-gate machinery: it runs where the operator already runs
 * Sparkle's offline `sign_update` today, and signs with exactly that key path
 * (the operator Keychain by default, or `--ed-key-file` exactly as
 * `sign_update` accepts it). It never generates a key, never uploads
 * anything, and never contacts the network. The publisher
 * (`publish-sparkle-update.js`) later validates and uploads whatever this
 * script emits.
 *
 * Retained-archive convention:
 *   <archive-root>/<channel>/<bundleVersion>/<AppName>.app
 *   <archive-root>/<channel>/<bundleVersion>/retained-archive.json
 *
 * Publishing version N generates deltas from up to the two most recent
 * retained versions older than N (Sparkle convention is 1-3). Two, because
 * update checks are automatic and most clients sit at N-1 when N ships, while
 * a second delta covers the common skipped-release case (a quick follow-up
 * release some clients never installed); anything older falls back to the
 * full DMG automatically, so deeper delta chains only add signing surface and
 * storage. A missing archive NEVER blocks a release: the script warns loudly
 * and emits a full-only appcast.
 *
 * IMPORTANT: stable delta publication remains policy-gated. While
 * config/sparkle-appcast-policy.js keeps `allowDeltaFrom: false` (matching
 * the owner-only Worker guard), this script emits full-only appcasts for the
 * stable channel and only retains the archive so the machinery is ready the
 * moment the reviewed policy and guard change lands.
 */
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPARKLE_TOOLS_DIRECTORY_NAME,
  inspectPinnedSparkleTools,
} from "./macos-updater-core.js";
import { CANONICAL_STABLE_APPCAST_POLICY } from "../config/sparkle-appcast-policy.js";
import { resolveReleaseChannel } from "../config/release-channels.js";
import { validateCandidateAppcastShape } from "./publish-sparkle-update.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");

export const RETAINED_ARCHIVE_SCHEMA =
  "tibotattle-sparkle-retained-archive-v1";
export const RETAINED_ARCHIVE_METADATA_FILE = "retained-archive.json";
export const DEFAULT_ARCHIVE_ROOT = join(REPOSITORY_ROOT, ".release-archive");
export const DEFAULT_SPARKLE_TOOLS = join(
  REPOSITORY_ROOT,
  ".release-deps",
  SPARKLE_TOOLS_DIRECTORY_NAME,
);
export const DEFAULT_MAX_DELTAS = 2;
export const FULL_ENCLOSURE_CONTENT_TYPE = "application/x-apple-diskimage";
export const DELTA_ENCLOSURE_CONTENT_TYPE = "application/octet-stream";

const BUNDLE_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,2}$/u;
const SAFE_DMG_FILE_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.dmg$/u;
const SAFE_DELTA_FILE_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.delta$/u;
const ED25519_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/u;
const ED25519_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/u;
const ED25519_SPKI_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);
const MAX_DMG_BYTES = 10 * 1024 * 1024 * 1024;
const TOOL_ENV = Object.freeze({
  HOME: process.env.HOME,
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
});
const SIGN_TIMEOUT_MS = 120_000;
const DELTA_TIMEOUT_MS = 900_000;
const PLIST_TIMEOUT_MS = 30_000;

function fail(message, code = "SPARKLE_APPCAST_GENERATION_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function warn(lines) {
  for (const line of Array.isArray(lines) ? lines : [lines]) {
    console.error(`WARNING: ${line}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function runTool(path, toolArguments, { label, timeout }) {
  const result = spawnSync(path, toolArguments, {
    encoding: "utf8",
    env: TOOL_ENV,
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
  if (result.error || result.status !== 0) {
    fail(
      `${label} failed: ${
        result.error?.message
        || result.stderr?.trim()
        || result.stdout?.trim()
        || `exit status ${result.status}`
      }`,
      "SPARKLE_APPCAST_TOOL_FAILED",
    );
  }
  return result.stdout ?? "";
}

function normalizeSignature(value, label) {
  const selected = (value ?? "").trim();
  if (!ED25519_SIGNATURE_PATTERN.test(selected)
      || Buffer.from(selected, "base64").length !== 64
      || Buffer.from(selected, "base64").toString("base64") !== selected) {
    fail(
      `${label} did not produce a canonical Sparkle Ed25519 signature`,
      "SPARKLE_APPCAST_SIGNATURE_INVALID",
    );
  }
  return selected;
}

function signArtifact(signUpdatePath, artifactPath, edKeyFile) {
  const toolArguments = edKeyFile === null
    ? ["-p", artifactPath]
    : ["--ed-key-file", edKeyFile, "-p", artifactPath];
  return normalizeSignature(
    runTool(signUpdatePath, toolArguments, {
      label: `sign_update for ${basename(artifactPath)}`,
      timeout: SIGN_TIMEOUT_MS,
    }),
    `sign_update for ${basename(artifactPath)}`,
  );
}

function importPublicEdKey(value) {
  if (value === null) return null;
  if (!ED25519_PUBLIC_KEY_PATTERN.test(value)
      || Buffer.from(value, "base64").length !== 32
      || Buffer.from(value, "base64").toString("base64") !== value) {
    fail("--sparkle-public-ed-key must be canonical base64 for 32 bytes");
  }
  try {
    return createPublicKey({
      key: Buffer.concat([
        ED25519_SPKI_PREFIX,
        Buffer.from(value, "base64"),
      ]),
      format: "der",
      type: "spki",
    });
  } catch {
    fail("--sparkle-public-ed-key could not be imported as an Ed25519 key");
  }
}

function assertLocalSignature({ bytes, signature, publicKey, label }) {
  if (publicKey === null) return;
  let verified = false;
  try {
    verified = verify(null, bytes, publicKey, Buffer.from(signature, "base64"));
  } catch {
    verified = false;
  }
  if (!verified) {
    fail(
      `${label} signature does not verify against --sparkle-public-ed-key; the signing key and configured public key disagree`,
      "SPARKLE_APPCAST_SIGNATURE_INVALID",
    );
  }
}

async function assertRealDirectory(path, label) {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink()
      || !metadata.isDirectory() || await realpath(path) !== path) {
    fail(`${label} must be an existing real directory: ${path}`);
  }
}

async function readRegularFile(path, label) {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null) fail(`${label} does not exist: ${path}`);
  if (!metadata.isFile() || metadata.isSymbolicLink()
      || await realpath(path) !== path) {
    fail(`${label} must be a regular file outside symbolic links: ${path}`);
  }
  if (metadata.size < 1 || metadata.size > MAX_DMG_BYTES) {
    fail(`${label} has an invalid size`);
  }
  const bytes = await readFile(path);
  if (bytes.length !== metadata.size) {
    fail(`${label} changed while it was being read`);
  }
  return Object.freeze({ bytes, path, sha256: sha256(bytes), size: bytes.length });
}

export async function readAppBundleVersion(appPath) {
  const plistPath = join(appPath, "Contents", "Info.plist");
  await readRegularFile(plistPath, "App bundle Info.plist").catch(() => {
    fail(`App bundle is missing a regular Contents/Info.plist: ${appPath}`);
  });
  const output = runTool("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    plistPath,
  ], { label: "plutil", timeout: PLIST_TIMEOUT_MS });
  let plist;
  try {
    plist = JSON.parse(output);
  } catch {
    fail(`App bundle Info.plist is not readable: ${plistPath}`);
  }
  if (typeof plist?.CFBundleVersion !== "string"
      || !BUNDLE_VERSION_PATTERN.test(plist.CFBundleVersion)) {
    fail(`App bundle Info.plist has an invalid CFBundleVersion: ${plistPath}`);
  }
  return plist.CFBundleVersion;
}

async function digestTree(root, current = root, hash = createHash("sha256")) {
  const entries = (await readdir(current, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    const relative = path.slice(root.length + 1);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      hash.update(`link\0${relative}\0${await readlink(path)}\0`);
    } else if (metadata.isDirectory()) {
      hash.update(`dir\0${relative}\0`);
      await digestTree(root, path, hash);
    } else if (metadata.isFile()) {
      hash.update(`file\0${relative}\0`);
      hash.update(await readFile(path));
      hash.update("\0");
    } else {
      fail(`Unsupported entry inside app tree: ${path}`);
    }
  }
  return current === root ? hash.digest("hex") : null;
}

async function assertDeltaApplies({
  binaryDeltaPath,
  candidateAppPath,
  deltaPath,
  priorAppPath,
}) {
  const probeRoot = join(
    dirname(deltaPath),
    `.delta-apply-probe-${basename(deltaPath)}`,
  );
  await rm(probeRoot, { recursive: true, force: true });
  const applied = join(probeRoot, basename(candidateAppPath));
  await mkdir(probeRoot, { recursive: true });
  try {
    runTool(binaryDeltaPath, [
      "apply",
      priorAppPath,
      applied,
      deltaPath,
    ], { label: `BinaryDelta apply for ${basename(deltaPath)}`, timeout: DELTA_TIMEOUT_MS });
    const [appliedDigest, candidateDigest] = [
      await digestTree(applied),
      await digestTree(candidateAppPath),
    ];
    if (appliedDigest !== candidateDigest) {
      fail(
        `BinaryDelta apply for ${basename(deltaPath)} did not reproduce the candidate app tree`,
        "SPARKLE_APPCAST_DELTA_APPLY_MISMATCH",
      );
    }
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

async function readRetainedVersion(channelDirectory, name) {
  const versionDirectory = join(channelDirectory, name);
  const metadataPath = join(versionDirectory, RETAINED_ARCHIVE_METADATA_FILE);
  const metadataFile = await readRegularFile(
    metadataPath,
    "Retained archive metadata",
  ).catch(() => null);
  if (metadataFile === null) {
    fail(
      `Retained archive entry is missing ${RETAINED_ARCHIVE_METADATA_FILE}: ${versionDirectory}; repair or delete the entry`,
      "SPARKLE_APPCAST_RETAINED_ARCHIVE_INVALID",
    );
  }
  let metadata;
  try {
    metadata = JSON.parse(metadataFile.bytes.toString("utf8"));
  } catch {
    metadata = null;
  }
  if (metadata?.schemaVersion !== RETAINED_ARCHIVE_SCHEMA
      || metadata.bundleVersion !== name
      || typeof metadata.appName !== "string"
      || basename(metadata.appName) !== metadata.appName
      || !metadata.appName.endsWith(".app")) {
    fail(
      `Retained archive metadata is invalid: ${metadataPath}; repair or delete the entry`,
      "SPARKLE_APPCAST_RETAINED_ARCHIVE_INVALID",
    );
  }
  const appPath = join(versionDirectory, metadata.appName);
  await assertRealDirectory(appPath, "Retained archive app").catch(() => {
    fail(
      `Retained archive app tree is missing: ${appPath}; repair or delete the entry`,
      "SPARKLE_APPCAST_RETAINED_ARCHIVE_INVALID",
    );
  });
  return Object.freeze({
    appPath,
    bundleVersion: name,
    directory: versionDirectory,
    metadata,
  });
}

export async function discoverRetainedVersions({
  archiveRoot,
  channelName,
  candidateBundleVersion,
  maxDeltas,
}) {
  const channelDirectory = join(archiveRoot, channelName);
  const entries = await readdir(channelDirectory, { withFileTypes: true })
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (entries === null) {
    return Object.freeze({ available: false, priors: Object.freeze([]) });
  }
  const versions = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() || !BUNDLE_VERSION_PATTERN.test(entry.name)) {
      fail(
        `Retained archive contains an unexpected entry: ${join(channelDirectory, entry.name)}; repair or delete it`,
        "SPARKLE_APPCAST_RETAINED_ARCHIVE_INVALID",
      );
    }
    versions.push(await readRetainedVersion(channelDirectory, entry.name));
  }
  const priors = versions
    .filter((version) => compareBundleVersions(
      version.bundleVersion,
      candidateBundleVersion,
    ) < 0)
    .sort((left, right) => compareBundleVersions(
      right.bundleVersion,
      left.bundleVersion,
    ))
    .slice(0, maxDeltas);
  return Object.freeze({
    available: true,
    priors: Object.freeze(priors),
    retainedCount: versions.length,
  });
}

export async function retainCandidateArchive({
  appPath,
  archiveRoot,
  bundleVersion,
  channelName,
  dmg,
  maxRetained,
  shortVersion,
}) {
  const channelDirectory = join(archiveRoot, channelName);
  const versionDirectory = join(channelDirectory, bundleVersion);
  const stagingDirectory = join(
    channelDirectory,
    `.staging-${bundleVersion}-${process.pid}`,
  );
  const appName = basename(appPath);
  await mkdir(channelDirectory, { recursive: true });
  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true });
  await cp(appPath, join(stagingDirectory, appName), {
    errorOnExist: true,
    force: false,
    recursive: true,
    verbatimSymlinks: true,
  });
  await writeFile(
    join(stagingDirectory, RETAINED_ARCHIVE_METADATA_FILE),
    `${JSON.stringify({
      schemaVersion: RETAINED_ARCHIVE_SCHEMA,
      appName,
      bundleVersion,
      channel: channelName,
      dmg: { bytes: dmg.size, fileName: basename(dmg.path), sha256: dmg.sha256 },
      retainedAt: new Date().toISOString(),
      shortVersion: shortVersion ?? null,
    }, null, 2)}\n`,
  );
  await rm(versionDirectory, { recursive: true, force: true });
  await rename(stagingDirectory, versionDirectory);

  const entries = (await readdir(channelDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()
      && !entry.name.startsWith(".")
      && BUNDLE_VERSION_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => compareBundleVersions(right, left));
  const pruned = entries.slice(maxRetained);
  for (const name of pruned) {
    await rm(join(channelDirectory, name), { recursive: true, force: true });
  }
  return Object.freeze({ path: versionDirectory, pruned: Object.freeze(pruned) });
}

function enclosureURL(channel, bundleVersion, digest, fileName) {
  return `${channel.sparkle.origin}/${channel.sparkle.objectPrefix}/${bundleVersion}/${digest}/${fileName}`;
}

export function renderSparkleAppcast({
  bundleVersion,
  deltas,
  full,
  shortVersion = null,
}) {
  const shortVersionElement = shortVersion === null
    ? ""
    : `<sparkle:shortVersionString>${shortVersion}</sparkle:shortVersionString>\n`;
  const deltasBlock = deltas.length === 0
    ? ""
    : `<sparkle:deltas>\n${deltas.map((delta) =>
      `<enclosure url="${delta.url}" sparkle:deltaFrom="${delta.deltaFrom}" length="${delta.size}" type="${DELTA_ENCLOSURE_CONTENT_TYPE}" sparkle:edSignature="${delta.signature}" />`).join("\n")}\n</sparkle:deltas>\n`;
  // The Worker's atomic appcast guard (sparkle-appcast-guard.ts) accepts
  // ONLY the elements rss > channel > item > enclosure — no version/title
  // child elements, no text content — and the enclosure must carry exactly
  // url, length, sparkle:version, sparkle:edSignature (no type attribute).
  // Sparkle reads the version from the enclosure attribute, so the one
  // reviewed minimal shape serves both the updater and the guard. Discovered
  // on the first real stable publication (2026-08-10): the previous
  // element-style emission was refused 422 CANDIDATE_INVALID. NOTE: the
  // delta block below still emits a <sparkle:deltas> wrapper the guard would
  // refuse; stable-channel deltas are disabled by the reviewed policy, and
  // enabling them requires extending the guard's parser first.
  void shortVersionElement;
  return `<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0"><channel><item>
<enclosure url="${full.url}" length="${full.size}" sparkle:version="${bundleVersion}" sparkle:edSignature="${full.signature}" />
${deltasBlock}</item></channel></rss>
`;
}

export function parseGenerateSparkleAppcastArguments(argv) {
  const options = {
    appPath: null,
    archiveRoot: null,
    bundleVersion: null,
    channel: null,
    dmgPath: null,
    edKeyFile: null,
    maxDeltas: null,
    output: null,
    replace: false,
    shortVersion: null,
    skipApplyCheck: false,
    skipRetain: false,
    sparklePublicEdKey: null,
    sparkleTools: null,
  };
  const flags = new Map([
    ["--app", "appPath"],
    ["--archive-root", "archiveRoot"],
    ["--bundle-version", "bundleVersion"],
    ["--channel", "channel"],
    ["--dmg", "dmgPath"],
    ["--ed-key-file", "edKeyFile"],
    ["--max-deltas", "maxDeltas"],
    ["--output", "output"],
    ["--short-version", "shortVersion"],
    ["--sparkle-public-ed-key", "sparklePublicEdKey"],
    ["--sparkle-tools", "sparkleTools"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (flags.has(argument)) {
      const key = flags.get(argument);
      if (options[key] !== null || index + 1 >= argv.length) {
        fail(`${argument} must be supplied exactly once with a value`);
      }
      options[key] = argv[++index];
    } else if (argument === "--replace" && !options.replace) {
      options.replace = true;
    } else if (argument === "--skip-apply-check" && !options.skipApplyCheck) {
      options.skipApplyCheck = true;
    } else if (argument === "--skip-retain" && !options.skipRetain) {
      options.skipRetain = true;
    } else {
      fail(`Unknown or repeated argument: ${argument}`);
    }
  }
  for (const [flag, key] of [
    ["--app", "appPath"],
    ["--bundle-version", "bundleVersion"],
    ["--channel", "channel"],
    ["--dmg", "dmgPath"],
  ]) {
    if (typeof options[key] !== "string" || options[key].length === 0) {
      fail(`${flag} is required`);
    }
  }
  if (!BUNDLE_VERSION_PATTERN.test(options.bundleVersion)) {
    fail("--bundle-version must contain one to three decimal components");
  }
  if (options.shortVersion !== null
      && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(options.shortVersion)) {
    fail("--short-version must be a short safe version string");
  }
  if (options.maxDeltas === null) {
    options.maxDeltas = DEFAULT_MAX_DELTAS;
  } else {
    if (!/^[1-3]$/u.test(options.maxDeltas)) {
      fail("--max-deltas must be 1, 2, or 3");
    }
    options.maxDeltas = Number(options.maxDeltas);
  }
  return Object.freeze({
    ...options,
    appPath: resolve(options.appPath),
    archiveRoot: resolve(options.archiveRoot ?? DEFAULT_ARCHIVE_ROOT),
    dmgPath: resolve(options.dmgPath),
    edKeyFile: options.edKeyFile === null ? null : resolve(options.edKeyFile),
    output: options.output === null
      ? join(dirname(resolve(options.dmgPath)), "appcast.xml")
      : resolve(options.output),
    sparkleTools: resolve(options.sparkleTools ?? DEFAULT_SPARKLE_TOOLS),
  });
}

export async function generateSparkleAppcast(options) {
  const channel = resolveReleaseChannel(options.channel);
  const publicKey = importPublicEdKey(options.sparklePublicEdKey);
  await assertRealDirectory(options.appPath, "--app");
  if (!basename(options.appPath).endsWith(".app")) {
    fail("--app must point at an .app bundle directory");
  }
  const dmg = await readRegularFile(options.dmgPath, "--dmg");
  const dmgFileName = basename(dmg.path);
  if (!SAFE_DMG_FILE_NAME_PATTERN.test(dmgFileName)) {
    fail(`--dmg has an unsafe file name: ${dmgFileName}`);
  }
  const appBundleVersion = await readAppBundleVersion(options.appPath);
  if (appBundleVersion !== options.bundleVersion) {
    fail(
      `--bundle-version ${options.bundleVersion} does not match the app bundle CFBundleVersion ${appBundleVersion}`,
    );
  }
  const existingOutput = await lstat(options.output).catch(() => null);
  if (existingOutput !== null && !options.replace) {
    fail(`Refusing to overwrite ${options.output} without --replace`);
  }
  const tools = await inspectPinnedSparkleTools(options.sparkleTools);
  const toolPath = (name) => tools.tools.find(
    (tool) => tool.name === name,
  ).path;

  // Sign the full DMG through the exact operator key path used today.
  const fullSignature = signArtifact(
    toolPath("sign_update"),
    dmg.path,
    options.edKeyFile,
  );
  assertLocalSignature({
    bytes: dmg.bytes,
    label: "Full DMG",
    publicKey,
    signature: fullSignature,
  });
  const full = Object.freeze({
    fileName: dmgFileName,
    sha256: dmg.sha256,
    signature: fullSignature,
    size: dmg.size,
    url: enclosureURL(channel, options.bundleVersion, dmg.sha256, dmgFileName),
  });

  const deltasAllowedByPolicy = channel.name !== "stable"
    || CANONICAL_STABLE_APPCAST_POLICY.allowDeltaFrom === true;
  let deltas = [];
  let archiveState = null;
  if (!deltasAllowedByPolicy) {
    warn([
      `Sparkle delta publication is disabled for the ${channel.name} channel by the reviewed canonical appcast policy (allowDeltaFrom: false in config/sparkle-appcast-policy.js).`,
      "Emitting a FULL-ONLY appcast. The archive is still retained so deltas start flowing the moment the reviewed policy and Worker guard change lands.",
    ]);
  } else {
    archiveState = await discoverRetainedVersions({
      archiveRoot: options.archiveRoot,
      candidateBundleVersion: options.bundleVersion,
      channelName: channel.name,
      maxDeltas: options.maxDeltas,
    });
    if (!archiveState.available || archiveState.priors.length === 0) {
      warn([
        `No retained prior archive found under ${join(options.archiveRoot, channel.name)}.`,
        "Emitting a FULL-ONLY appcast: every client will download the complete DMG for this update.",
        "This is expected for the first release of a channel and never blocks a release.",
        "To restore deltas for the next release, keep the archive this run retains (or re-seed it from the previous release's app bundle).",
      ]);
    }
    const deltaBaseName = dmgFileName.slice(0, -".dmg".length);
    for (const prior of archiveState.priors ?? []) {
      const deltaFileName =
        `${deltaBaseName}-from-${prior.bundleVersion}.delta`;
      if (!SAFE_DELTA_FILE_NAME_PATTERN.test(deltaFileName)) {
        fail(`Generated delta file name is unsafe: ${deltaFileName}`);
      }
      const deltaPath = join(dirname(dmg.path), deltaFileName);
      await rm(deltaPath, { force: true });
      runTool(toolPath("BinaryDelta"), [
        "create",
        prior.appPath,
        options.appPath,
        deltaPath,
      ], { label: `BinaryDelta create ${deltaFileName}`, timeout: DELTA_TIMEOUT_MS });
      if (!options.skipApplyCheck) {
        await assertDeltaApplies({
          binaryDeltaPath: toolPath("BinaryDelta"),
          candidateAppPath: options.appPath,
          deltaPath,
          priorAppPath: prior.appPath,
        });
      }
      const deltaFile = await readRegularFile(deltaPath, "Generated delta");
      const deltaSignature = signArtifact(
        toolPath("sign_update"),
        deltaPath,
        options.edKeyFile,
      );
      assertLocalSignature({
        bytes: deltaFile.bytes,
        label: `Delta from ${prior.bundleVersion}`,
        publicKey,
        signature: deltaSignature,
      });
      deltas.push(Object.freeze({
        deltaFrom: prior.bundleVersion,
        fileName: deltaFileName,
        path: deltaPath,
        sha256: deltaFile.sha256,
        signature: deltaSignature,
        size: deltaFile.size,
        url: enclosureURL(
          channel,
          options.bundleVersion,
          deltaFile.sha256,
          deltaFileName,
        ),
      }));
    }
  }
  deltas = Object.freeze(deltas);

  const appcast = renderSparkleAppcast({
    bundleVersion: options.bundleVersion,
    deltas,
    full,
    shortVersion: options.shortVersion,
  });
  // Self-check with the exact validation the publisher applies, so a
  // generated appcast can never be shaped in a way the publisher rejects.
  validateCandidateAppcastShape(appcast, channel.name);
  await writeFile(options.output, appcast);

  let retained = null;
  if (!options.skipRetain) {
    retained = await retainCandidateArchive({
      appPath: options.appPath,
      archiveRoot: options.archiveRoot,
      bundleVersion: options.bundleVersion,
      channelName: channel.name,
      dmg,
      maxRetained: options.maxDeltas + 1,
      shortVersion: options.shortVersion,
    });
  }

  return Object.freeze({
    appcastPath: options.output,
    channel: channel.name,
    deltas,
    full,
    retained,
  });
}

export async function main(argv) {
  const options = parseGenerateSparkleAppcastArguments(argv);
  const result = await generateSparkleAppcast(options);
  console.log(`Sparkle appcast generated: ${result.appcastPath}`);
  console.log(`Channel: ${result.channel}`);
  console.log(
    `Full DMG: ${result.full.fileName} (${result.full.size} bytes)`,
  );
  for (const delta of result.deltas) {
    const percent = ((delta.size / result.full.size) * 100).toFixed(1);
    console.log(
      `Delta from ${delta.deltaFrom}: ${delta.fileName} (${delta.size} bytes, ${percent}% of the full DMG)`,
    );
  }
  if (result.deltas.length === 0) {
    console.log("Deltas: none (full-only appcast)");
  }
  if (result.retained !== null) {
    console.log(`Retained archive: ${result.retained.path}`);
    for (const pruned of result.retained.pruned) {
      console.log(`Pruned retained archive version: ${pruned}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`generate-sparkle-appcast: ${error.message}`);
    process.exitCode = 1;
  });
}
