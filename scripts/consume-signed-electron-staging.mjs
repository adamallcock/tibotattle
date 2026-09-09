#!/usr/bin/env node

/**
 * Verify a separately delivered signed staging app. Verification is the only
 * CLI operation: it never writes or launches. A future launcher must be a
 * separately reviewed boundary before it may call the exported preseed helper.
 *
 * This intentionally accepts an already extracted .app directory.  Artifact
 * transport and archive extraction are separate reviewed boundaries; this
 * command must never select an artifact from an ambient staging directory.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fileSystemConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
  createDesktopFirstRunReceiptBackend,
  validateDesktopFirstRunReceipt,
} from "../apps/electron/desktop-first-run.js";
import {
  macOSCredentialApplicationVerificationArguments,
} from "../apps/electron/desktop-macos-keychain.js";
import {
  assertAccountlessSignedStagingOperatingAccount,
  validateAccountlessSignedStagingRehearsalMetadata,
} from "../apps/electron/desktop-runtime.js";
import {
  createDesktopSharingBackend,
  createDesktopSharingCoordinator,
} from "../apps/electron/desktop-sharing.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);

const PREFIX = "ELECTRON_SIGNED_STAGING_CONSUMER_";
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const APPLICATION_NAME = "TiboTattle.app";
const EXECUTABLE_RELATIVE_PATH = ["Contents", "MacOS", "TiboTattle"];
const ASAR_RELATIVE_PATH = ["Contents", "Resources", "app.asar"];
const ACCOUNTLESS_SIGNED_STAGING_PROFILE_DIRECTORY =
  "TiboTattle Signed Staging Rehearsal";
const ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_DIRECTORY =
  "accountless-signed-staging-rehearsal-v1";
const DESKTOP_SETTINGS_DIRECTORY = "desktop-settings";
const MAXIMUM_ASAR_BYTES = 512 * 1024 * 1024;
const MAXIMUM_PACKAGE_JSON_BYTES = 128 * 1024;
const MAX_OPERATION_MS = 10_000;
const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
export const SIGNED_STAGING_CONSUMER_SCHEMA_VERSION =
  "tibotattle-signed-staging-consumer-v1";
export const SIGNED_STAGING_CONSUMER_STATUS = Object.freeze({
  artifactVerified: "signed_staging_artifact_verified",
  failed: "ELECTRON_SIGNED_STAGING_CONSUMER_FAILED",
});

const ERROR_CODES = Object.freeze({
  accountContextInvalid: `${PREFIX}ACCOUNT_CONTEXT_INVALID`,
  appInvalid: `${PREFIX}APP_INVALID`,
  archiveInvalid: `${PREFIX}ARCHIVE_INVALID`,
  artifactDigestInvalid: `${PREFIX}ARTIFACT_DIGEST_INVALID`,
  artifactInvalid: `${PREFIX}ARTIFACT_INVALID`,
  inputInvalid: `${PREFIX}INPUT_INVALID`,
  metadataInvalid: `${PREFIX}METADATA_INVALID`,
  optOutInvalid: `${PREFIX}OPT_OUT_INVALID`,
  profileNotFresh: `${PREFIX}PROFILE_NOT_FRESH`,
  profileUnsafe: `${PREFIX}PROFILE_UNSAFE`,
  signatureInvalid: `${PREFIX}SIGNATURE_INVALID`,
  targetInvalid: `${PREFIX}TARGET_INVALID`,
});

const FIRST_RUN_ACKNOWLEDGEMENT = Object.freeze({
  schemaVersion: DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
  acknowledged: true,
});

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function numericValue(value) {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) return null;
    return Number(value);
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function fileFingerprint(stats) {
  const size = numericValue(stats?.size);
  const dev = numericValue(stats?.dev);
  const ino = numericValue(stats?.ino);
  const mtimeMs = Number(stats?.mtimeMs);
  const ctimeMs = Number(stats?.ctimeMs);
  if (size === null || dev === null || ino === null
      || !Number.isFinite(mtimeMs) || !Number.isFinite(ctimeMs)) {
    return null;
  }
  return Object.freeze({ size, dev, ino, mtimeMs, ctimeMs });
}

function sameFingerprint(left, right) {
  return left !== null && right !== null
    && left.size === right.size
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function isDirectory(stats) {
  try {
    return stats?.isDirectory?.() === true && stats?.isSymbolicLink?.() !== true;
  } catch {
    return false;
  }
}

function isRegularFile(stats) {
  try {
    return stats?.isFile?.() === true && stats?.isSymbolicLink?.() !== true;
  } catch {
    return false;
  }
}

function privateOwnedDirectory(stats, expectedUid) {
  const mode = numericValue(stats?.mode);
  return isDirectory(stats)
    && numericValue(stats?.uid) === expectedUid
    && mode !== null
    && (mode & 0o777) === 0o700;
}

function ownedDirectory(stats, expectedUid) {
  return isDirectory(stats) && numericValue(stats?.uid) === expectedUid;
}

function ownedNonWritableArtifact(stats, expectedUid, type) {
  const matchesType = type === "directory" ? isDirectory(stats) : isRegularFile(stats);
  const mode = numericValue(stats?.mode);
  return matchesType
    && numericValue(stats?.uid) === expectedUid
    && mode !== null
    && (mode & 0o022) === 0;
}

function currentUid(getuid, code) {
  let uid;
  try { uid = getuid(); } catch { fail(code); }
  if (!Number.isSafeInteger(uid) || uid < 0) fail(code);
  return uid;
}

async function assertNoSymlinkPathComponents(path, code) {
  let current = resolve(path);
  while (true) {
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT") fail(code);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
      continue;
    }
    if (metadata.isSymbolicLink()) {
      // macOS exposes /var as a compatibility symlink to /private/var.
      if (process.platform === "darwin" && current === "/var"
          && await realpath(current).catch(() => null) === "/private/var") {
        current = dirname(current);
        continue;
      }
      fail(code);
    }
    if (!metadata.isDirectory() && current !== resolve(path)) fail(code);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function pathIsInside(parent, child) {
  const suffix = relative(resolve(parent), resolve(child));
  return suffix === ""
    || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

async function assertOwnedArtifactPath(path, expectedUid, type, root, code) {
  await assertNoSymlinkPathComponents(path, code);
  if (!pathIsInside(root, path)) fail(code);
  const metadata = await selectedLstat(path, code);
  if (!ownedNonWritableArtifact(metadata, expectedUid, type)) fail(code);
  return metadata;
}

async function selectedLstat(path, code) {
  try {
    return await lstat(path);
  } catch {
    fail(code);
  }
}

async function assertOwnedDirectory(path, expectedUid, {
  privateMode = false,
  code = ERROR_CODES.profileUnsafe,
} = {}) {
  const stats = await selectedLstat(path, code);
  if (privateMode ? !privateOwnedDirectory(stats, expectedUid) : !ownedDirectory(stats, expectedUid)) {
    fail(code);
  }
  return stats;
}

async function readRegularFileNoFollow(path, maximumBytes, code) {
  await assertNoSymlinkPathComponents(path, code);
  const before = await selectedLstat(path, code);
  const beforeFingerprint = fileFingerprint(before);
  if (!isRegularFile(before) || beforeFingerprint === null || beforeFingerprint.size > maximumBytes) {
    fail(code);
  }
  const noFollow = fileSystemConstants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow) || noFollow === 0) fail(code);
  let handle;
  try {
    handle = await open(path, fileSystemConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    const openedFingerprint = fileFingerprint(opened);
    if (!isRegularFile(opened)
        || openedFingerprint === null
        || openedFingerprint.size > maximumBytes
        || !sameFingerprint(beforeFingerprint, openedFingerprint)) {
      fail(code);
    }
    const bytes = await handle.readFile();
    if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)
        || bytes.byteLength !== openedFingerprint.size) {
      fail(code);
    }
    const after = await selectedLstat(path, code);
    if (!isRegularFile(after)
        || !sameFingerprint(openedFingerprint, fileFingerprint(after))) {
      fail(code);
    }
    return Buffer.from(bytes);
  } catch (error) {
    if (error?.code === code) throw error;
    fail(code);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertSignedStagingBundleLayout(appPath, expectedUid) {
  await assertOwnedArtifactPath(
    appPath,
    expectedUid,
    "directory",
    appPath,
    ERROR_CODES.appInvalid,
  );
  const contents = join(appPath, "Contents");
  const macOS = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  await assertOwnedArtifactPath(contents, expectedUid, "directory", appPath, ERROR_CODES.appInvalid);
  await assertOwnedArtifactPath(macOS, expectedUid, "directory", appPath, ERROR_CODES.appInvalid);
  await assertOwnedArtifactPath(resources, expectedUid, "directory", appPath, ERROR_CODES.appInvalid);
  const executable = join(appPath, ...EXECUTABLE_RELATIVE_PATH);
  const executableStats = await assertOwnedArtifactPath(
    executable,
    expectedUid,
    "file",
    appPath,
    ERROR_CODES.appInvalid,
  );
  const executableMode = numericValue(executableStats.mode);
  if (executableMode === null || (executableMode & 0o111) === 0) {
    fail(ERROR_CODES.appInvalid);
  }
  const archive = join(appPath, ...ASAR_RELATIVE_PATH);
  await assertOwnedArtifactPath(archive, expectedUid, "file", appPath, ERROR_CODES.artifactInvalid);
  return Object.freeze({ archive, executable });
}

function loadAsar() {
  try {
    const builderRequire = createRequire(require.resolve("electron-builder"));
    const loaded = builderRequire("@electron/asar");
    const asar = loaded?.default ?? loaded;
    if (typeof asar?.extractFile !== "function") fail(ERROR_CODES.archiveInvalid);
    return asar;
  } catch (error) {
    if (error?.code === ERROR_CODES.archiveInvalid) throw error;
    fail(ERROR_CODES.archiveInvalid);
  }
}

function archiveMemberPath(member, platform) {
  return platform === "win32" ? member.replaceAll("/", "\\") : member;
}

function readArchivePackageJson(asarPath, asar, platform) {
  let value;
  try {
    const bytes = asar.extractFile(asarPath, archiveMemberPath("package.json", platform));
    if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)
        || bytes.byteLength < 1
        || bytes.byteLength > MAXIMUM_PACKAGE_JSON_BYTES) {
      fail(ERROR_CODES.archiveInvalid);
    }
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    if (error?.code === ERROR_CODES.archiveInvalid) throw error;
    fail(ERROR_CODES.archiveInvalid);
  }
  if (!isPlainRecord(value)) fail(ERROR_CODES.metadataInvalid);
  return value;
}

function assertTarget(platform, architecture) {
  if (platform !== "darwin" || architecture !== "arm64") {
    fail(ERROR_CODES.targetInvalid);
  }
}

function assertAppBundlePath(appPath) {
  if (typeof appPath !== "string"
      || !isAbsolute(appPath)
      || basename(resolve(appPath)) !== APPLICATION_NAME) {
    fail(ERROR_CODES.inputInvalid);
  }
  return resolve(appPath);
}

function assertSourceRevision(sourceRevision) {
  if (typeof sourceRevision !== "string" || !SOURCE_REVISION_PATTERN.test(sourceRevision)) {
    fail(ERROR_CODES.inputInvalid);
  }
  return sourceRevision;
}

function assertSha256(asarSha256) {
  if (typeof asarSha256 !== "string" || !SHA256_PATTERN.test(asarSha256)) {
    fail(ERROR_CODES.inputInvalid);
  }
  return asarSha256;
}

function fixedConsumerReceipt({
  asarSha256,
  sourceRevision,
  status,
  execution,
} = {}) {
  return Object.freeze({
    schemaVersion: SIGNED_STAGING_CONSUMER_SCHEMA_VERSION,
    status,
    execution,
    signature: "verified",
    sourceRevision,
    asarSha256,
  });
}

async function verifyCodesign(appPath, {
  spawnProcess = spawn,
} = {}) {
  return new Promise((resolveVerification) => {
    let complete = false;
    let child;
    let timer;
    const finish = (value) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      resolveVerification(value === true);
    };
    try {
      child = spawnProcess("/usr/bin/codesign", macOSCredentialApplicationVerificationArguments(appPath), {
        env: { PATH: SAFE_PATH },
        stdio: "ignore",
      });
      child.once("error", () => finish(false));
      child.once("exit", (code, signal) => finish(code === 0 && signal === null));
      timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        finish(false);
      }, MAX_OPERATION_MS);
    } catch {
      finish(false);
    }
  });
}

async function inspectSignedStagingArtifactInternal({
  appPath,
  sourceRevision,
  asarSha256,
} = {}, {
  architecture = process.arch,
  asar = loadAsar(),
  getuid = typeof process.getuid === "function" ? process.getuid.bind(process) : undefined,
  platform = process.platform,
  verifySignature = verifyCodesign,
} = {}) {
  assertTarget(platform, architecture);
  if (typeof getuid !== "function") fail(ERROR_CODES.appInvalid);
  const selectedAppPath = assertAppBundlePath(appPath);
  const selectedSourceRevision = assertSourceRevision(sourceRevision);
  const selectedAsarSha256 = assertSha256(asarSha256);
  const expectedUid = currentUid(getuid, ERROR_CODES.appInvalid);
  const { archive, executable } = await assertSignedStagingBundleLayout(selectedAppPath, expectedUid);
  const archiveBytes = await readRegularFileNoFollow(
    archive,
    MAXIMUM_ASAR_BYTES,
    ERROR_CODES.artifactInvalid,
  );
  const observedSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  archiveBytes.fill(0);
  if (observedSha256 !== selectedAsarSha256) fail(ERROR_CODES.artifactDigestInvalid);
  let signatureVerified = false;
  try {
    signatureVerified = await verifySignature(selectedAppPath);
  } catch {
    signatureVerified = false;
  }
  if (signatureVerified !== true) fail(ERROR_CODES.signatureInvalid);

  await assertSignedStagingBundleLayout(selectedAppPath, expectedUid);
  const manifest = readArchivePackageJson(archive, asar, platform);
  // Authenticate the bytes again after archive extraction. This binds the
  // parsed marker to the same archive that passed the digest and codesign gate.
  await assertSignedStagingBundleLayout(selectedAppPath, expectedUid);
  const afterBytes = await readRegularFileNoFollow(
    archive,
    MAXIMUM_ASAR_BYTES,
    ERROR_CODES.artifactInvalid,
  );
  const afterSha256 = createHash("sha256").update(afterBytes).digest("hex");
  afterBytes.fill(0);
  if (afterSha256 !== selectedAsarSha256) fail(ERROR_CODES.artifactDigestInvalid);
  if (Object.hasOwn(manifest, "tibotattleDistribution")
      || Object.hasOwn(manifest, "tibotattleAccountlessHostedRehearsal")) {
    fail(ERROR_CODES.metadataInvalid);
  }
  let metadata;
  try {
    metadata = validateAccountlessSignedStagingRehearsalMetadata(
      manifest.tibotattleAccountlessSignedStagingRehearsal,
      { platform, architecture },
    );
  } catch {
    fail(ERROR_CODES.metadataInvalid);
  }
  if (metadata.sourceRevision !== selectedSourceRevision) fail(ERROR_CODES.metadataInvalid);
  return Object.freeze({
    appPath: selectedAppPath,
    archive,
    asarSha256: selectedAsarSha256,
    executable,
    metadata,
    sourceRevision: selectedSourceRevision,
  });
}

/** Verify the supplied signed app and return only content-free provenance. */
export async function inspectSignedStagingArtifact(options = {}, dependencies = {}) {
  const verified = await inspectSignedStagingArtifactInternal(options, dependencies);
  return fixedConsumerReceipt({
    asarSha256: verified.asarSha256,
    sourceRevision: verified.sourceRevision,
    status: SIGNED_STAGING_CONSUMER_STATUS.artifactVerified,
    execution: "dry",
  });
}

export function signedStagingProfilePathForHome(homeDirectory) {
  if (typeof homeDirectory !== "string" || !isAbsolute(homeDirectory)) {
    fail(ERROR_CODES.profileUnsafe);
  }
  const home = resolve(homeDirectory);
  return join(home, "Library", "Application Support", ACCOUNTLESS_SIGNED_STAGING_PROFILE_DIRECTORY);
}

/**
 * Match launchDesktopRuntime's signed-staging rehearsal resolver. The outer
 * profile is selected pre-ready by main.js; the runtime puts its sharing
 * preference under this fixed child before it attaches the scheduler channel.
 */
export function signedStagingRuntimeSettingsPathForProfile(profileRoot) {
  if (typeof profileRoot !== "string" || !isAbsolute(profileRoot)) {
    fail(ERROR_CODES.profileUnsafe);
  }
  return join(
    resolve(profileRoot),
    ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_DIRECTORY,
    DESKTOP_SETTINGS_DIRECTORY,
  );
}

async function assertAbsent(path, code) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail(code);
  }
  fail(code);
}

async function createNewPrivateDirectory(path, expectedUid, code) {
  try {
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
  } catch {
    fail(code);
  }
  await assertOwnedDirectory(path, expectedUid, { privateMode: true, code });
  let entries;
  try {
    entries = await readdir(path);
  } catch {
    fail(code);
  }
  if (entries.length !== 0) fail(code);
}

function assertionEnvironment(environment) {
  if (!isPlainRecord(environment)) fail(ERROR_CODES.accountContextInvalid);
  const requiredRunnerProfile = {
    GITHUB_ACTIONS: "true",
    RUNNER_ARCH: "ARM64",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "macOS",
  };
  if (Object.entries(requiredRunnerProfile).some(([key, value]) => environment[key] !== value)) {
    fail(ERROR_CODES.accountContextInvalid);
  }
  // The package marker, not a caller's inherited control plane, selects the
  // accountless route. Refuse an ambient authority marker before creating the
  // disposable profile; the child later receives an even smaller environment.
  if (Reflect.ownKeys(environment).some((key) => typeof key !== "string"
    || key === "NODE_OPTIONS"
    || key === "ELECTRON_RUN_AS_NODE"
    || key.startsWith("USAGE_MONITOR_"))) {
    fail(ERROR_CODES.accountContextInvalid);
  }
  return environment;
}

function operatingAccount({ getuid, getUserInfo }) {
  let uid;
  let information;
  try {
    uid = getuid();
    information = getUserInfo();
  } catch {
    fail(ERROR_CODES.accountContextInvalid);
  }
  if (!Number.isSafeInteger(uid)
      || uid < 0
      || !isPlainRecord(information)
      || information.uid !== uid
      || typeof information.homedir !== "string"
      || !isAbsolute(information.homedir)) {
    fail(ERROR_CODES.accountContextInvalid);
  }
  return Object.freeze({ uid, homeDirectory: resolve(information.homedir) });
}

function assertDisabledProjection({ authorization, inspection, selection }) {
  if (selection?.enabled !== false
      || authorization?.available !== true
      || authorization?.current !== true
      || authorization?.enabled !== false
      || inspection?.enabled !== false
      || inspection?.transportStatus !== "off") {
    fail(ERROR_CODES.optOutInvalid);
  }
}

async function readDisabledProjection(shareBackend, createCoordinator, destinationOrigin) {
  let coordinator;
  try {
    coordinator = createCoordinator({
      backend: shareBackend,
      installationState: "fresh",
      destinationOrigin,
    });
    await coordinator.initialize();
    const authorization = await coordinator.readAuthorization();
    const inspection = await coordinator.inspect();
    assertDisabledProjection({ authorization, inspection, selection: { enabled: false } });
  } catch (error) {
    if (error?.code === ERROR_CODES.optOutInvalid) throw error;
    fail(ERROR_CODES.optOutInvalid);
  } finally {
    try { coordinator?.dispose(); } catch {}
  }
}

/**
 * Create only a new signed-staging profile and write the two reviewed records
 * that prevent both the first-run dialog and accountless transport before the
 * first Electron process is started. An existing profile is always refused.
 * If a write fails after directory creation, the partial profile is preserved
 * and later calls fail closed; this helper never deletes or repairs it.
 */
export async function prepareSignedStagingDisposableProfile({
  initialSharing = "off",
  metadata,
  environment = { ...process.env },
  getuid = typeof process.getuid === "function" ? process.getuid.bind(process) : undefined,
  getUserInfo = () => ({ ...userInfo() }),
  platform = process.platform,
  architecture = process.arch,
} = {}, {
  assertOperatingAccount = assertAccountlessSignedStagingOperatingAccount,
  createFirstRunBackend = createDesktopFirstRunReceiptBackend,
  createSharingBackend = createDesktopSharingBackend,
  createSharingCoordinator = createDesktopSharingCoordinator,
} = {}) {
  assertTarget(platform, architecture);
  if (!["off", "fresh"].includes(initialSharing)) fail(ERROR_CODES.inputInvalid);
  if (typeof getuid !== "function" || typeof getUserInfo !== "function") {
    fail(ERROR_CODES.accountContextInvalid);
  }
  let validatedMetadata;
  try {
    validatedMetadata = validateAccountlessSignedStagingRehearsalMetadata(metadata, {
      platform,
      architecture,
    });
    // This is deliberately before any profile lstat/mkdir or adapter access.
    assertOperatingAccount({
      metadata: validatedMetadata,
      environment: assertionEnvironment(environment),
      getuid,
      getUserInfo,
      platform,
      architecture,
    });
  } catch {
    fail(ERROR_CODES.accountContextInvalid);
  }
  const account = operatingAccount({ getuid, getUserInfo });
  const profileRoot = signedStagingProfilePathForHome(account.homeDirectory);
  const appData = join(account.homeDirectory, "Library", "Application Support");
  await assertNoSymlinkPathComponents(appData, ERROR_CODES.profileUnsafe);
  await assertOwnedDirectory(appData, account.uid, { code: ERROR_CODES.profileUnsafe });
  await assertAbsent(profileRoot, ERROR_CODES.profileNotFresh);
  await createNewPrivateDirectory(profileRoot, account.uid, ERROR_CODES.profileNotFresh);
  const runtimeProfileRoot = join(
    profileRoot,
    ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_DIRECTORY,
  );
  await assertAbsent(runtimeProfileRoot, ERROR_CODES.profileNotFresh);
  await createNewPrivateDirectory(runtimeProfileRoot, account.uid, ERROR_CODES.profileNotFresh);
  const settingsRoot = signedStagingRuntimeSettingsPathForProfile(profileRoot);
  await assertAbsent(settingsRoot, ERROR_CODES.profileNotFresh);
  await createNewPrivateDirectory(settingsRoot, account.uid, ERROR_CODES.profileNotFresh);

  let firstRunBackend;
  let shareBackend;
  try {
    firstRunBackend = createFirstRunBackend({ platform: "darwin", rootPath: settingsRoot });
    shareBackend = createSharingBackend({ platform: "darwin", rootPath: settingsRoot });
    await firstRunBackend.save(FIRST_RUN_ACKNOWLEDGEMENT);
    const firstRun = validateDesktopFirstRunReceipt(await firstRunBackend.load());
    if (firstRun.acknowledged !== true) fail(ERROR_CODES.optOutInvalid);
    const coordinator = createSharingCoordinator({
      backend: shareBackend,
      installationState: "fresh",
      destinationOrigin: validatedMetadata.origin,
    });
    try {
      const initialized = await coordinator.initialize();
      if (initialSharing === "off") {
        const selection = await coordinator.setEnabled(false);
        const authorization = await coordinator.readAuthorization();
        const inspection = await coordinator.inspect();
        assertDisabledProjection({ authorization, inspection, selection });
      } else if (initialized.enabled !== true || initialized.current !== true
          || initialized.basis !== "default_on") {
        fail(ERROR_CODES.optOutInvalid);
      }
    } finally {
      coordinator.dispose();
    }
  } catch (error) {
    if (error?.code === ERROR_CODES.optOutInvalid) throw error;
    fail(ERROR_CODES.optOutInvalid);
  }
  return Object.freeze({
    firstRunBackend,
    profileRoot,
    runtimeProfileRoot,
    settingsRoot,
    shareBackend,
    destinationOrigin: validatedMetadata.origin,
  });
}

export function preseedSignedStagingDisposableOptOut(options = {}, dependencies = {}) {
  return prepareSignedStagingDisposableProfile({ ...options, initialSharing: "off" }, dependencies);
}

/** Private launch inputs; never serialize the returned paths or metadata. */
export async function verifySignedStagingLaunchInputs(options = {}) {
  const verified = await inspectSignedStagingArtifactInternal(options);
  assertAccountlessSignedStagingOperatingAccount({ metadata: verified.metadata });
  return verified;
}

/** Re-read the exact persisted records written by the preseed helper. */
export async function verifySignedStagingDisposableOptOut(seed, {
  createSharingCoordinator = createDesktopSharingCoordinator,
} = {}) {
  if (!seed?.firstRunBackend || !seed?.shareBackend) fail(ERROR_CODES.optOutInvalid);
  try {
    const firstRun = validateDesktopFirstRunReceipt(await seed.firstRunBackend.load());
    if (firstRun.acknowledged !== true) fail(ERROR_CODES.optOutInvalid);
    await readDisabledProjection(
      seed.shareBackend,
      createSharingCoordinator,
      seed.destinationOrigin,
    );
    return true;
  } catch (error) {
    if (error?.code === ERROR_CODES.optOutInvalid) throw error;
    fail(ERROR_CODES.optOutInvalid);
  }
}

function assertVerificationOnlyOptions(executeDisposableOptOut, acknowledgement) {
  if (executeDisposableOptOut !== false || acknowledgement !== undefined) {
    fail(ERROR_CODES.inputInvalid);
  }
}

/**
 * Verify the supplied signed app only. Launching is deliberately unavailable
 * until a separately reviewed macOS process-ownership boundary exists.
 */
export async function runSignedStagingConsumer({
  acknowledgement,
  executeDisposableOptOut = false,
  ...artifactOptions
} = {}, dependencies = {}) {
  assertVerificationOnlyOptions(executeDisposableOptOut, acknowledgement);
  const verified = await inspectSignedStagingArtifactInternal(artifactOptions, dependencies);
  return fixedConsumerReceipt({
    asarSha256: verified.asarSha256,
    sourceRevision: verified.sourceRevision,
    status: SIGNED_STAGING_CONSUMER_STATUS.artifactVerified,
    execution: "dry",
  });
}

export function parseSignedStagingConsumerArguments(argv) {
  if (!Array.isArray(argv)) fail(ERROR_CODES.inputInvalid);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--app", "--source-revision", "--asar-sha256"].includes(argument)
        || values.has(argument)
        || index + 1 >= argv.length) {
      fail(ERROR_CODES.inputInvalid);
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0) fail(ERROR_CODES.inputInvalid);
    values.set(argument, value);
    index += 1;
  }
  const appPath = values.get("--app");
  const sourceRevision = values.get("--source-revision");
  const asarSha256 = values.get("--asar-sha256");
  if (values.size !== 3 || !appPath || !sourceRevision || !asarSha256) {
    fail(ERROR_CODES.inputInvalid);
  }
  return Object.freeze({
    appPath: assertAppBundlePath(appPath),
    sourceRevision: assertSourceRevision(sourceRevision),
    asarSha256: assertSha256(asarSha256),
  });
}

async function main(argv) {
  const receipt = await runSignedStagingConsumer(parseSignedStagingConsumerArguments(argv));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write(`${SIGNED_STAGING_CONSUMER_STATUS.failed}\n`);
    process.exitCode = 1;
  });
}
