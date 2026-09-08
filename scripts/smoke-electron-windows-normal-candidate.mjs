#!/usr/bin/env node

/**
 * Candidate-only normal Windows Electron journey.
 *
 * This executes an exact unpacked stable-metadata candidate in a fresh hosted
 * runner profile. It is deliberately separate from the development NSIS
 * lifecycle proof: no installer is exercised here, and no qualification
 * marker, test lane, or private smoke IPC reaches the app. The candidate's
 * one temporary, app-scoped outbound firewall rule prevents hosted reach while
 * its loopback dashboard remains the rendered journey under test.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createWindowsFilesystemAdapter,
  createWindowsProtectedStateStore,
  isWindowsProtectedStateStoreError,
} from "../src/platform/index.js";
import {
  createDesktopFirstRunReceiptBackend,
  DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
  validateDesktopFirstRunReceipt,
} from "../apps/electron/desktop-first-run.js";
import {
  createDesktopSharingBackend,
  createDesktopSharingCoordinator,
} from "../apps/electron/desktop-sharing.js";
import { isDesktopSettingsBackendError } from "../apps/electron/desktop-settings-backends.js";
import { validateProductionDistributionMetadata } from "../apps/electron/desktop-updater.js";
import { DEPLOYMENT_ENDPOINTS } from "../config/deployment-endpoints.js";
import {
  buildWindowsNormalCandidateLaunchSpec,
  prepareWindowsDevelopmentProfile,
  WINDOWS_ELECTRON_BINDING_RELATIVE_PATH,
  WINDOWS_ELECTRON_KEYTAR_RELATIVE_PATH,
  WINDOWS_NORMAL_CANDIDATE_APP_NAME,
} from "./launch-electron-windows-development.mjs";
import { classifyAutomaticStartupRefreshReceipt } from "./smoke-electron-linux.mjs";
import {
  assertWindowsProcessTreeExited,
  buildWindowsExactExecutableProcessQueryArguments,
  buildWindowsOwnedProcessSnapshotQueryArguments,
  ownedWindowsProcessTree,
  parseWindowsProcessSnapshot,
  runWindowsNsisLifecycleProgram,
} from "./smoke-electron-windows-nsis-lifecycle.mjs";

const require = createRequire(import.meta.url);
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const PREFIX = "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_";
const TARGET = "win32-x64";
const RECEIPT_SCHEMA = "tibotattle-electron-windows-normal-candidate-smoke-v1";
const SOURCE_CANDIDATE_SCHEMA = "tibotattle-electron-production-source-candidate-v1";
const SOURCE_CANDIDATE_STAGE = ".release-build/electron-production/win32-x64/app";
const SOURCE_CANDIDATE_BUILDER = "apps/electron/electron-builder.production.config.cjs";
const FIRST_RUN_ACKNOWLEDGEMENT = validateDesktopFirstRunReceipt({
  schemaVersion: DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
  acknowledged: true,
});
const SYNTHETIC_CODEX_SESSION_FILE =
  "rollout-2026-09-08T00-00-00-70000000-0000-4000-8000-000000000001.jsonl";
const SYNTHETIC_CODEX_SESSION_ID = "70000000-0000-4000-8000-000000000001";
// This fixed source contains no user content, account identity, or real usage.
// Its filename and event shape are the smallest accepted by both Codex rollout
// discovery and the unified local-index refresh path.
const SYNTHETIC_CODEX_SESSION = `${[
  {
    timestamp: "2026-09-08T00:00:00.000Z",
    type: "session_meta",
    payload: { id: SYNTHETIC_CODEX_SESSION_ID },
  },
  {
    timestamp: "2026-09-08T00:00:01.000Z",
    type: "turn_context",
    payload: { model: "gpt-5.6-sol" },
  },
  {
    timestamp: "2026-09-08T00:01:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          cache_write_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 8,
          total_tokens: 120,
        },
        last_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          cache_write_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 8,
          total_tokens: 120,
        },
      },
    },
  },
].map((record) => JSON.stringify(record)).join("\n")}\n`;
const SOURCE_REVISION = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const FIREWALL_RULE_PREFIX = "tibotattle-normal-candidate-";
const FIREWALL_RULE_NAME = new RegExp(`^${FIREWALL_RULE_PREFIX}[0-9a-f-]{36}$`, "u");
const NORMAL_CANDIDATE_QUIT_REQUEST = Object.freeze({
  type: "tibotattle-electron-smoke-quit-v1",
});
const NORMAL_CANDIDATE_QUIT_ACCEPTED = "tibotattle-electron-smoke-quit-accepted-v1";
const MAXIMUM_JSON_BYTES = 1024 * 1024;
const MAXIMUM_PROGRAM_OUTPUT_BYTES = 1024;
const STARTUP_TIMEOUT_MS = 30_000;
const OPERATION_TIMEOUT_MS = 20_000;
const PROCESS_EXIT_TIMEOUT_MS = 15_000;
const POWERSHELL_TIMEOUT_MS = 20_000;
// Firewall setup/readback has an independent bounded preparation budget. The
// candidate remains ineligible to launch until this command verifies its rule.
export const WINDOWS_NORMAL_CANDIDATE_FIREWALL_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const PROTECTED_OPT_OUT_STAGES = new Set([
  "PROTECTED_OPT_OUT_ADAPTER_UNAVAILABLE",
  "PROTECTED_OPT_OUT_STORE_UNAVAILABLE",
  "PROTECTED_OPT_OUT_INITIAL_READ_UNAVAILABLE",
  "PROTECTED_OPT_OUT_FIRST_RUN_UNAVAILABLE",
  "PROTECTED_OPT_OUT_SHARING_UNAVAILABLE",
]);
const WINDOWS_FILESYSTEM_SEED_CAUSES = new Set([
  "WINDOWS_FILESYSTEM_BINDING_INTEGRITY_MISMATCH",
  "WINDOWS_FILESYSTEM_BINDING_UNAVAILABLE",
  "WINDOWS_FILESYSTEM_INVALID_BINDING",
  "WINDOWS_FILESYSTEM_INVALID_BINDING_BYTES",
  "WINDOWS_FILESYSTEM_INVALID_BINDING_PATH",
  "WINDOWS_FILESYSTEM_INVALID_CONFIGURATION",
  "WINDOWS_FILESYSTEM_INVALID_MANIFEST",
  "WINDOWS_FILESYSTEM_MANIFEST_BINDING_MISMATCH",
  "WINDOWS_FILESYSTEM_MANIFEST_UNAVAILABLE",
  "WINDOWS_FILESYSTEM_UNSUPPORTED_ARCHITECTURE",
  "WINDOWS_FILESYSTEM_UNSUPPORTED_PLATFORM",
]);
const WINDOWS_PROTECTED_STATE_SEED_CAUSES = new Set([
  "WINDOWS_PROTECTED_STATE_STORE_INVALID_ADAPTER",
  "WINDOWS_PROTECTED_STATE_STORE_INVALID_CONFIGURATION",
  "WINDOWS_PROTECTED_STATE_STORE_INVALID_IDENTITY",
  "WINDOWS_PROTECTED_STATE_STORE_INVALID_ROOT",
  "WINDOWS_PROTECTED_STATE_STORE_SECURITY_POLICY",
  "WINDOWS_PROTECTED_STATE_STORE_UNAVAILABLE",
]);
const DESKTOP_SETTINGS_SEED_CAUSES = new Set([
  "DESKTOP_SETTINGS_BACKEND_CORRUPT",
  "DESKTOP_SETTINGS_BACKEND_STORE_INVALID",
  "DESKTOP_SETTINGS_BACKEND_STORE_UNSAFE",
  "DESKTOP_SETTINGS_BACKEND_TOO_LARGE",
  "DESKTOP_SETTINGS_BACKEND_UNAVAILABLE",
  "DESKTOP_SETTINGS_BACKEND_WRITE_FAILED",
]);
const PROTECTED_OPT_OUT_CAUSES = new Set([
  ...WINDOWS_FILESYSTEM_SEED_CAUSES,
  ...WINDOWS_PROTECTED_STATE_SEED_CAUSES,
  ...DESKTOP_SETTINGS_SEED_CAUSES,
]);
const FAILURE_CODES = new Set([
  "ARGUMENT_INVALID",
  "WINDOWS_X64_REQUIRED",
  "DISPOSABLE_CI_REQUIRED",
  "RUNNER_TEMP_INVALID",
  "RECEIPT_INVALID",
  "SOURCE_CANDIDATE_INVALID",
  "PACKAGE_IDENTITY_INVALID",
  "PACKAGE_PATHS_INVALID",
  "PACKAGE_STAGED_MANIFEST_INVALID",
  "PACKAGE_ARCHIVE_MANIFEST_INVALID",
  "PACKAGE_METADATA_INVALID",
  "PACKAGE_NATIVE_MEMBERS_INVALID",
  "NATIVE_PAIR_INVALID",
  "ASAR_UNAVAILABLE",
  "PROFILE_INVALID",
  "PROFILE_NOT_ABSENT",
  "SYNTHETIC_FIXTURE_UNAVAILABLE",
  "PROTECTED_OPT_OUT_UNAVAILABLE",
  "FIREWALL_UNAVAILABLE",
  "FIREWALL_RULE_DIRTY",
  "FIREWALL_RULE_INVALID",
  "FIREWALL_CLEANUP_UNCONFIRMED",
  "APPLICATION_LAUNCH_UNAVAILABLE",
  "PROCESS_PROOF_UNAVAILABLE",
  "OWNED_PROCESS_REMAINS",
  "CDP_UNAVAILABLE",
  "DASHBOARD_UNAVAILABLE",
  "DASHBOARD_INVALID",
  "LOCAL_REFRESH_UNAVAILABLE",
  "LOCAL_STARTUP_REFRESH_UNAVAILABLE",
  "LOCAL_STARTUP_REFRESH_COMPLETION_UNAVAILABLE",
  "LOCAL_EXPLICIT_REFRESH_BUTTON_UNAVAILABLE",
  "LOCAL_EXPLICIT_REFRESH_REQUEST_UNOBSERVED",
  "LOCAL_EXPLICIT_REFRESH_ACCEPTANCE_UNAVAILABLE",
  "LOCAL_EXPLICIT_REFRESH_COMPLETION_UNAVAILABLE",
  "SETTINGS_UNAVAILABLE",
  "SETTINGS_PERSISTENCE_INVALID",
  "CLEAN_QUIT_INVALID",
  "PROFILE_CLEANUP_UNCONFIRMED",
  "UNEXPECTED",
]);

function protectedOptOutFailureCode(code) {
  if (typeof code !== "string") return false;
  for (const stage of PROTECTED_OPT_OUT_STAGES) {
    const prefix = `${stage}_`;
    if (code.startsWith(prefix) && PROTECTED_OPT_OUT_CAUSES.has(code.slice(prefix.length))) {
      return true;
    }
  }
  return false;
}

function knownFailureCode(code) {
  return FAILURE_CODES.has(code)
    || PROTECTED_OPT_OUT_STAGES.has(code)
    || protectedOptOutFailureCode(code);
}

function failure(code) {
  const selected = knownFailureCode(code) ? code : "UNEXPECTED";
  const error = new Error(`${PREFIX}${selected}`);
  error.code = error.message;
  return error;
}

function fail(code) {
  throw failure(code);
}

function fixedCode(error) {
  const value = String(error?.code ?? "");
  return knownFailureCode(value.replace(PREFIX, "")) ? value : `${PREFIX}UNEXPECTED`;
}

function exactWindowsPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
      || !win32.isAbsolute(value)) return null;
  try {
    return win32.resolve(value);
  } catch {
    return null;
  }
}

function sameWindowsPath(left, right) {
  const selectedLeft = exactWindowsPath(left);
  const selectedRight = exactWindowsPath(right);
  return selectedLeft !== null && selectedRight !== null
    && selectedLeft.toLowerCase() === selectedRight.toLowerCase();
}

function validRegularMetadata(value) {
  return value?.isFile?.() === true && value.isSymbolicLink?.() === false
    && value.nlink === 1 && Number.isSafeInteger(value.size) && value.size > 0;
}

async function regularFile(path, code = "PACKAGE_IDENTITY_INVALID") {
  try {
    const metadata = await lstat(path);
    if (!validRegularMetadata(metadata)) fail(code);
    return metadata;
  } catch (error) {
    if (String(error?.code ?? "").startsWith(PREFIX)) throw error;
    fail(code);
  }
}

async function regularDirectory(path, code = "PACKAGE_IDENTITY_INVALID") {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory?.() || metadata.isSymbolicLink?.()) fail(code);
    return metadata;
  } catch (error) {
    if (String(error?.code ?? "").startsWith(PREFIX)) throw error;
    fail(code);
  }
}

async function digestRegularFile(path, code = "PACKAGE_IDENTITY_INVALID") {
  const metadata = await regularFile(path, code);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    fail(code);
  }
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== metadata.size) fail(code);
  return Object.freeze({
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function valueAfter(argv, index) {
  const value = argv[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")
      || value.includes("\0")) {
    fail("ARGUMENT_INVALID");
  }
  return value;
}

/** Accept exactly one runner-only unpacked candidate invocation. */
export function parseWindowsNormalCandidateSmokeArguments(argv) {
  if (!Array.isArray(argv)) fail("ARGUMENT_INVALID");
  const fields = new Map([
    ["--app", "appPath"],
    ["--staged-app", "stagedAppPath"],
    ["--source-candidate", "sourceCandidatePath"],
    ["--source-revision", "sourceRevision"],
    ["--receipt", "receiptPath"],
  ]);
  const result = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || seen.has(field)) fail("ARGUMENT_INVALID");
    seen.add(field);
    result[field] = valueAfter(argv, index);
    index += 1;
  }
  if (seen.size !== fields.size || !SOURCE_REVISION.test(result.sourceRevision ?? "")) {
    fail("ARGUMENT_INVALID");
  }
  for (const field of ["appPath", "stagedAppPath", "sourceCandidatePath", "receiptPath"]) {
    const normalized = exactWindowsPath(result[field]);
    if (normalized === null) fail("ARGUMENT_INVALID");
    result[field] = normalized;
  }
  const candidateRoot = win32.dirname(result.sourceCandidatePath);
  if (!sameWindowsPath(result.appPath, win32.join(
    candidateRoot,
    "artifacts",
    "win-unpacked",
    WINDOWS_NORMAL_CANDIDATE_APP_NAME,
  )) || !sameWindowsPath(result.stagedAppPath, win32.join(candidateRoot, "app"))) {
    fail("ARGUMENT_INVALID");
  }
  return Object.freeze(result);
}

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceCandidateValid(value, sourceRevision) {
  return exactObject(value)
    && value.schemaVersion === SOURCE_CANDIDATE_SCHEMA
    && value.status === "production_source_staged"
    && value.target === TARGET
    && value.sourceRevision === sourceRevision
    && value.stagingDirectory === SOURCE_CANDIDATE_STAGE
    && value.builderConfiguration === SOURCE_CANDIDATE_BUILDER
    && value.updaterEnabled === true
    && value.signingRequired === true
    && value.signingPerformed === false
    && value.publishingPerformed === false
    && value.windowsRuntimeQualification === "required";
}

function stableMetadata(value, sourceRevision) {
  let metadata;
  try {
    metadata = validateProductionDistributionMetadata(value, {
      platform: "win32",
      architecture: "x64",
    });
  } catch {
    fail("PACKAGE_METADATA_INVALID");
  }
  if (metadata.target !== TARGET || metadata.channel !== "stable"
      || metadata.sourceRevision !== sourceRevision) {
    fail("PACKAGE_METADATA_INVALID");
  }
  return metadata;
}

/** Bind source-plan, staged app, and ASAR metadata to one stable candidate. */
export function validateWindowsNormalCandidateSmokeMetadata({
  sourceCandidate,
  stagedManifest,
  archiveManifest,
  sourceRevision,
} = {}) {
  if (!SOURCE_REVISION.test(sourceRevision ?? "")) fail("ARGUMENT_INVALID");
  if (!sourceCandidateValid(sourceCandidate, sourceRevision)) fail("SOURCE_CANDIDATE_INVALID");
  const staged = stableMetadata(stagedManifest?.tibotattleDistribution, sourceRevision);
  const archived = stableMetadata(archiveManifest?.tibotattleDistribution, sourceRevision);
  if (JSON.stringify(staged) !== JSON.stringify(archived)
      || stagedManifest?.version !== sourceCandidate.version
      || archiveManifest?.version !== sourceCandidate.version) {
    fail("PACKAGE_METADATA_INVALID");
  }
  return Object.freeze({ sourceRevision, target: TARGET, distribution: staged });
}

async function readSafeJson(path, code) {
  await regularFile(path, code);
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    fail(code);
  }
  if (Buffer.byteLength(text, "utf8") > MAXIMUM_JSON_BYTES) fail(code);
  try {
    const value = JSON.parse(text);
    if (!exactObject(value)) fail(code);
    return value;
  } catch (error) {
    if (String(error?.code ?? "").startsWith(PREFIX)) throw error;
    fail(code);
  }
}

function loadAsar() {
  try {
    const builderRequire = createRequire(require.resolve("electron-builder"));
    const asar = builderRequire("@electron/asar");
    const selected = asar.default ?? asar;
    if (typeof selected?.extractFile !== "function") fail("ASAR_UNAVAILABLE");
    return selected;
  } catch (error) {
    if (String(error?.code ?? "").startsWith(PREFIX)) throw error;
    fail("ASAR_UNAVAILABLE");
  }
}

/** Electron's ASAR reader indexes members with the packager host's separator. */
function archiveMemberPath(member, platform = process.platform) {
  return platform === "win32" ? member.replaceAll("/", win32.sep) : member;
}

function readArchiveFile(
  archivePath,
  member,
  asar = loadAsar(),
  code = "PACKAGE_IDENTITY_INVALID",
  platform = process.platform,
) {
  let bytes;
  try {
    bytes = asar.extractFile(archivePath, archiveMemberPath(member, platform));
  } catch {
    fail(code);
  }
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)
      || bytes.byteLength < 1 || bytes.byteLength > MAXIMUM_JSON_BYTES) {
    fail(code);
  }
  return Buffer.from(bytes);
}

function readArchiveJson(
  archivePath,
  member,
  asar = loadAsar(),
  code = "PACKAGE_IDENTITY_INVALID",
  platform = process.platform,
) {
  try {
    const value = JSON.parse(readArchiveFile(archivePath, member, asar, code, platform).toString("utf8"));
    if (!exactObject(value)) fail(code);
    return value;
  } catch (error) {
    if (String(error?.code ?? "").startsWith(PREFIX)) throw error;
    fail(code);
  }
}

function sameDigest(left, right) {
  return left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
}

async function digestArchiveMember(
  archivePath,
  member,
  { asar = loadAsar(), code = "PACKAGE_IDENTITY_INVALID", platform = process.platform } = {},
) {
  const bytes = readArchiveFile(archivePath, member, asar, code, platform);
  return Object.freeze({
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

async function validateNativePair({
  stagedAppPath,
  asarPath,
  unpackedPath,
  asar = loadAsar(),
  digest = digestRegularFile,
  failureCode = "PACKAGE_NATIVE_MEMBERS_INVALID",
  platform = process.platform,
} = {}) {
  const relativeBinding = WINDOWS_ELECTRON_BINDING_RELATIVE_PATH;
  const relativeManifest = `${relativeBinding}.manifest.json`;
  const relativeKeytar = WINDOWS_ELECTRON_KEYTAR_RELATIVE_PATH;
  const [stagedBinding, packagedBinding, stagedKeytar, packagedKeytar, stagedManifest, archivedManifest] =
    await Promise.all([
      digest(join(stagedAppPath, ...relativeBinding.split("/")), failureCode),
      digest(join(unpackedPath, ...relativeBinding.split("/")), failureCode),
      digest(join(stagedAppPath, ...relativeKeytar.split("/")), failureCode),
      digest(join(unpackedPath, ...relativeKeytar.split("/")), failureCode),
      digest(join(stagedAppPath, ...relativeManifest.split("/")), failureCode),
      digestArchiveMember(asarPath, relativeManifest, { asar, code: failureCode, platform }),
    ]);
  if (!sameDigest(stagedBinding, packagedBinding)
      || !sameDigest(stagedKeytar, packagedKeytar)
      || !sameDigest(stagedManifest, archivedManifest)) {
    fail(failureCode);
  }
  return Object.freeze({
    windowsFilesystemSha256: packagedBinding.sha256,
    keytarSha256: packagedKeytar.sha256,
  });
}

async function verifyWindowsNormalCandidateSmokePackagePaths({
  appPath,
  stagedAppPath,
  resourcesPath,
  asarPath,
  unpackedPath,
} = {}) {
  await Promise.all([
    regularFile(appPath, "PACKAGE_PATHS_INVALID"),
    regularDirectory(stagedAppPath, "PACKAGE_PATHS_INVALID"),
    regularDirectory(resourcesPath, "PACKAGE_PATHS_INVALID"),
    regularFile(asarPath, "PACKAGE_PATHS_INVALID"),
    regularDirectory(unpackedPath, "PACKAGE_PATHS_INVALID"),
  ]);
}

/** Verify the exact staged app, unpacked executable, stable metadata, and native pair. */
export async function verifyWindowsNormalCandidateSmokePackage(options = {}, {
  platform = process.platform,
  architecture = process.arch,
  readJsonFile = readSafeJson,
  digest = digestRegularFile,
  asar = loadAsar(),
  validateNative = validateNativePair,
  verifyPaths = verifyWindowsNormalCandidateSmokePackagePaths,
} = {}) {
  if (platform !== "win32" || architecture !== "x64"
      || !exactWindowsPath(options.appPath) || !exactWindowsPath(options.stagedAppPath)
      || !exactWindowsPath(options.sourceCandidatePath)
      || !SOURCE_REVISION.test(options.sourceRevision ?? "")) {
    fail("ARGUMENT_INVALID");
  }
  const appPath = options.appPath;
  if (win32.basename(appPath).toLowerCase() !== WINDOWS_NORMAL_CANDIDATE_APP_NAME.toLowerCase()) {
    fail("PACKAGE_IDENTITY_INVALID");
  }
  const resourcesPath = win32.join(win32.dirname(appPath), "resources");
  const asarPath = win32.join(resourcesPath, "app.asar");
  const unpackedPath = `${asarPath}.unpacked`;
  await verifyPaths({
    appPath,
    stagedAppPath: options.stagedAppPath,
    resourcesPath,
    asarPath,
    unpackedPath,
  });
  const sourceCandidate = await readJsonFile(options.sourceCandidatePath, "SOURCE_CANDIDATE_INVALID");
  const stagedManifest = await readJsonFile(
    win32.join(options.stagedAppPath, "package.json"),
    "PACKAGE_STAGED_MANIFEST_INVALID",
  );
  const [executable, artifact] = await Promise.all([
    digest(appPath, "PACKAGE_PATHS_INVALID"),
    digest(asarPath, "PACKAGE_PATHS_INVALID"),
  ]);
  const archiveManifest = readArchiveJson(
    asarPath,
    "package.json",
    asar,
    "PACKAGE_ARCHIVE_MANIFEST_INVALID",
    platform,
  );
  const metadata = validateWindowsNormalCandidateSmokeMetadata({
    sourceCandidate, stagedManifest, archiveManifest, sourceRevision: options.sourceRevision,
  });
  const native = await validateNative({
    stagedAppPath: options.stagedAppPath,
    asarPath,
    unpackedPath,
    asar,
    digest,
    failureCode: "PACKAGE_NATIVE_MEMBERS_INVALID",
    platform,
  });
  return Object.freeze({
    sourceRevision: metadata.sourceRevision,
    target: metadata.target,
    artifactSha256: artifact.sha256,
    executableSha256: executable.sha256,
    native,
  });
}

async function pathAbsent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    fail("PROFILE_INVALID");
  }
}

function createStagedWindowsAdapter(stagedAppPath, {
  createAdapter = createWindowsFilesystemAdapter,
} = {}) {
  const bindingPath = win32.join(stagedAppPath, ...WINDOWS_ELECTRON_BINDING_RELATIVE_PATH.split("/"));
  const adapter = createAdapter({
    platform: "win32",
    architecture: "x64",
    bindingPath,
    resolveBinding: (path) => path,
    requireBinding: (path) => require(path),
    readManifest: (path) => readFileSync(path, "utf8"),
    readBindingBytes: (path) => readFileSync(path),
  });
  if (adapter === null || typeof adapter !== "object" || adapter.productionSafe !== false) {
    fail("PROTECTED_OPT_OUT_UNAVAILABLE");
  }
  return adapter;
}

function sharingCoordinator(backend, {
  createCoordinator = createDesktopSharingCoordinator,
} = {}) {
  try {
    return createCoordinator({
      backend,
      installationState: "fresh",
      destinationOrigin: DEPLOYMENT_ENDPOINTS.public.origin,
    });
  } catch {
    fail("PROTECTED_OPT_OUT_UNAVAILABLE");
  }
}

function protectedOptOutCause(error) {
  let code = "";
  try { code = typeof error?.code === "string" ? error.code : ""; }
  catch { return null; }
  if (WINDOWS_FILESYSTEM_SEED_CAUSES.has(code)) return code;
  if (isWindowsProtectedStateStoreError(error)) {
    const normalized = code.toUpperCase();
    return WINDOWS_PROTECTED_STATE_SEED_CAUSES.has(normalized) ? normalized : null;
  }
  if (isDesktopSettingsBackendError(error)) {
    const normalized = code.toUpperCase();
    return DESKTOP_SETTINGS_SEED_CAUSES.has(normalized) ? normalized : null;
  }
  return null;
}

async function protectedOptOutStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    const code = String(error?.code ?? "");
    if (code.startsWith(PREFIX) && code !== `${PREFIX}PROTECTED_OPT_OUT_UNAVAILABLE`) {
      throw error;
    }
    const cause = protectedOptOutCause(error);
    fail(cause === null ? stage : `${stage}_${cause}`);
  }
}

/**
 * Supply the normal candidate's fresh, owned Codex root with one content-free
 * rollout-shaped source. The dashboard refuses a refresh until its ordinary
 * onboarding preflight sees a readable JSONL source, so an empty profile
 * would only exercise that preflight rather than the local refresh journey.
 */
export async function seedWindowsNormalCandidateCodexFixture({ profile } = {}, {
  createDirectory = mkdir,
  metadata = lstat,
  writeFixture = writeFile,
} = {}) {
  const codexHome = exactWindowsPath(profile?.codex);
  if (codexHome === null || typeof createDirectory !== "function"
      || typeof metadata !== "function" || typeof writeFixture !== "function") {
    fail("PROFILE_INVALID");
  }
  const sessions = win32.join(codexHome, "sessions");
  const fixture = win32.join(sessions, SYNTHETIC_CODEX_SESSION_FILE);
  try {
    await createDirectory(sessions, { recursive: true, mode: 0o700 });
    const directory = await metadata(sessions);
    if (!directory?.isDirectory?.() || directory.isSymbolicLink?.()) {
      fail("SYNTHETIC_FIXTURE_UNAVAILABLE");
    }
    await writeFixture(fixture, SYNTHETIC_CODEX_SESSION, {
      mode: 0o600,
      flag: "wx",
    });
    const file = await metadata(fixture);
    if (!file?.isFile?.() || file.isSymbolicLink?.() || file.nlink !== 1
        || file.size !== Buffer.byteLength(SYNTHETIC_CODEX_SESSION)) {
      fail("SYNTHETIC_FIXTURE_UNAVAILABLE");
    }
  } catch (error) {
    if (String(error?.code ?? "").startsWith(PREFIX)) throw error;
    fail("SYNTHETIC_FIXTURE_UNAVAILABLE");
  }
  return Object.freeze({ codexHome, fixture, sessions });
}

/** Seed only the fixed acknowledgement and durable contribution opt-out. */
export async function prepareWindowsNormalCandidateProfile({
  profile,
  stagedAppPath,
} = {}, {
  createAdapter = createStagedWindowsAdapter,
  createStore = createWindowsProtectedStateStore,
  createReceiptBackend = createDesktopFirstRunReceiptBackend,
  createSharingBackend = createDesktopSharingBackend,
  createCoordinator = createDesktopSharingCoordinator,
} = {}) {
  if (!profile || typeof profile !== "object" || !exactWindowsPath(profile.userData)
      || !exactWindowsPath(stagedAppPath)) {
    fail("PROFILE_INVALID");
  }
  const settingsRoot = win32.join(profile.userData, "desktop-settings");
  if (!await pathAbsent(settingsRoot)) fail("PROFILE_NOT_ABSENT");
  let adapter;
  let store;
  let receiptBackend;
  let shareBackend;
  try {
    adapter = await protectedOptOutStage("PROTECTED_OPT_OUT_ADAPTER_UNAVAILABLE", () =>
      createAdapter(stagedAppPath));
    ({ store, receiptBackend, shareBackend } = await protectedOptOutStage(
      "PROTECTED_OPT_OUT_STORE_UNAVAILABLE",
      () => {
        const selectedStore = createStore({ adapter, rootPath: settingsRoot });
        return {
          store: selectedStore,
          receiptBackend: createReceiptBackend({
            platform: "win32",
            windowsProtectedStateStore: selectedStore,
          }),
          shareBackend: createSharingBackend({
            platform: "win32",
            rootPath: settingsRoot,
            windowsProtectedStateStore: selectedStore,
          }),
        };
      },
    ));
    const initialReceipt = await protectedOptOutStage(
      "PROTECTED_OPT_OUT_INITIAL_READ_UNAVAILABLE",
      () => receiptBackend.load(),
    );
    const initialSharing = await protectedOptOutStage(
      "PROTECTED_OPT_OUT_INITIAL_READ_UNAVAILABLE",
      () => shareBackend.load(),
    );
    if (initialReceipt !== null || initialSharing !== null) {
      fail("PROFILE_NOT_ABSENT");
    }
    await protectedOptOutStage(
      "PROTECTED_OPT_OUT_FIRST_RUN_UNAVAILABLE",
      () => receiptBackend.save(FIRST_RUN_ACKNOWLEDGEMENT),
    );
    const receipt = await protectedOptOutStage(
      "PROTECTED_OPT_OUT_FIRST_RUN_UNAVAILABLE",
      async () => validateDesktopFirstRunReceipt(await receiptBackend.load()),
    );
    if (receipt.acknowledged !== true) fail("PROTECTED_OPT_OUT_UNAVAILABLE");
    const coordinator = await protectedOptOutStage(
      "PROTECTED_OPT_OUT_SHARING_UNAVAILABLE",
      () => sharingCoordinator(shareBackend, { createCoordinator }),
    );
    try {
      const { selection, authorization, inspection } = await protectedOptOutStage(
        "PROTECTED_OPT_OUT_SHARING_UNAVAILABLE",
        async () => {
          await coordinator.initialize();
          return {
            selection: await coordinator.setEnabled(false),
            authorization: await coordinator.readAuthorization(),
            inspection: await coordinator.inspect(),
          };
        },
      );
      // readAuthorization intentionally returns the raw policy projection. Its
      // `current` result binds the durable record to this fixed destination;
      // inspect exposes Electron's transport-state projection separately.
      if (selection?.enabled !== false || authorization?.available !== true
          || authorization?.current !== true || authorization?.enabled !== false
          || inspection?.enabled !== false || inspection?.transportStatus !== "off") {
        fail("PROTECTED_OPT_OUT_UNAVAILABLE");
      }
    } finally {
      coordinator.dispose();
    }
  } catch (error) {
    if (String(error?.code ?? "").startsWith(PREFIX)) throw error;
    fail("PROTECTED_OPT_OUT_UNAVAILABLE");
  }
  return Object.freeze({
    adapter,
    settingsRoot,
    store,
    shareBackend,
  });
}

/** Re-read the fixed durable opt-out after the second ordinary app launch. */
export async function verifyWindowsNormalCandidateOptOut(seed, {
  createCoordinator = createDesktopSharingCoordinator,
} = {}) {
  if (!seed?.shareBackend || typeof createCoordinator !== "function") {
    fail("PROTECTED_OPT_OUT_UNAVAILABLE");
  }
  const coordinator = sharingCoordinator(seed.shareBackend, { createCoordinator });
  try {
    await coordinator.initialize();
    const authorization = await coordinator.readAuthorization();
    const inspection = await coordinator.inspect();
    if (authorization?.available !== true || authorization?.current !== true
        || authorization?.enabled !== false || inspection?.enabled !== false
        || inspection?.transportStatus !== "off") {
      fail("PROTECTED_OPT_OUT_UNAVAILABLE");
    }
    return true;
  } catch (error) {
    if (String(error?.code ?? "").startsWith(PREFIX)) throw error;
    fail("PROTECTED_OPT_OUT_UNAVAILABLE");
  } finally {
    coordinator.dispose();
  }
}

function systemPowerShell(environment) {
  const root = exactWindowsPath(environment?.SystemRoot);
  if (root === null) fail("FIREWALL_UNAVAILABLE");
  return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function fixedPowerShellEnvironment(environment, values = {}) {
  const selected = {};
  for (const key of [
    "PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "OS",
    "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432", "NUMBER_OF_PROCESSORS",
    "ProgramData", "ProgramFiles", "ProgramW6432", "CommonProgramFiles", "CommonProgramW6432",
  ]) {
    const value = environment?.[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) selected[key] = value;
  }
  if (!exactWindowsPath(selected.SystemRoot)) fail("FIREWALL_UNAVAILABLE");
  selected.PSModulePath = win32.join(
    selected.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules",
  );
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
      fail("FIREWALL_UNAVAILABLE");
    }
    selected[key] = value;
  }
  return selected;
}

async function runFixedPowerShell(command, args, {
  environment,
  values,
  spawnProgram = spawn,
  timeoutMs = POWERSHELL_TIMEOUT_MS,
} = {}) {
  if (!exactWindowsPath(command) || !Array.isArray(args)
      || args.some((value) => typeof value !== "string" || value.includes("\0"))
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || typeof spawnProgram !== "function") {
    fail("FIREWALL_UNAVAILABLE");
  }
  return new Promise((resolveRun) => {
    let child;
    try {
      child = spawnProgram(command, args, {
        cwd: win32.dirname(command),
        env: fixedPowerShellEnvironment(environment, values),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolveRun(Object.freeze({ settled: true, timedOut: false, exitCode: null, output: "" }));
      return;
    }
    let output = "";
    let overflow = false;
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => {
      if (overflow) return;
      output += chunk;
      if (output.length > MAXIMUM_PROGRAM_OUTPUT_BYTES) {
        output = "";
        overflow = true;
      }
    });
    let settled = false;
    const finish = (exitCode, timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(Object.freeze({
        settled: !timedOut,
        timedOut,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        output: overflow ? "" : output,
      }));
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* bounded fixed result below */ }
      finish(null, true);
    }, timeoutMs);
    child.once?.("error", () => finish(null, false));
    child.once?.("close", (code) => finish(code, false));
  });
}

const EXPECTED_APP_ENVIRONMENT = "USAGE_MONITOR_WINDOWS_NORMAL_CANDIDATE_APP";
const FIREWALL_NAME_ENVIRONMENT = "USAGE_MONITOR_WINDOWS_NORMAL_CANDIDATE_FIREWALL_RULE";

function expectedAppPrelude() {
  return `$expectedRaw=[Environment]::GetEnvironmentVariable('${EXPECTED_APP_ENVIRONMENT}','Process');if($expectedRaw -isnot [string] -or [string]::IsNullOrWhiteSpace($expectedRaw) -or -not [System.IO.Path]::IsPathRooted($expectedRaw)){throw 'candidate'};$expected=[System.IO.Path]::GetFullPath($expectedRaw);`;
}

function firewallRulePrelude() {
  return `${expectedAppPrelude()}$name=[Environment]::GetEnvironmentVariable('${FIREWALL_NAME_ENVIRONMENT}','Process');if($name -isnot [string] -or $name -notmatch '^${FIREWALL_RULE_PREFIX}[0-9a-f-]{36}$'){throw 'rule'};`;
}

// NetSecurity cmdlets use a CIM-backed provider. Use the public firewall COM
// policy surface directly so the temporary candidate block does not depend on
// that provider's startup path.
function firewallPolicyPrelude() {
  return `$policy=New-Object -ComObject HNetCfg.FwPolicy2;$rules=$policy.Rules;`;
}

function firewallRuleMatches() {
  return `$ownedRules=@();foreach($candidate in $rules){if([string]::Equals([string]$candidate.Name,$name,[System.StringComparison]::Ordinal)){$ownedRules+=,$candidate}};`;
}

function firewallRuleOwnershipAssertion() {
  return `${firewallRuleMatches()}if($ownedRules.Count -ne 1){throw 'rule'};$rule=$ownedRules[0];$program=[string]$rule.ApplicationName;if(-not [string]::Equals([string]$rule.Name,$name,[System.StringComparison]::Ordinal) -or [int]$rule.Direction -ne 2 -or [int]$rule.Action -ne 0 -or $rule.Enabled -ne $true -or [int64]$rule.Profiles -ne 2147483647 -or [int]$rule.Protocol -ne 256 -or [string]::IsNullOrWhiteSpace($program) -or -not [string]::Equals([System.IO.Path]::GetFullPath($program),$expected,[System.StringComparison]::OrdinalIgnoreCase)){throw 'rule'};`;
}

/** Build a fixed PowerShell command that creates and reads back one app-scoped outbound block. */
export function buildWindowsNormalCandidateFirewallCreateArguments() {
  const script = `$ErrorActionPreference='Stop';${firewallRulePrelude()}${firewallPolicyPrelude()}${firewallRuleMatches()}if($ownedRules.Count -ne 0){throw 'dirty'};$rule=New-Object -ComObject HNetCfg.FWRule;$rule.Name=$name;$rule.Description=$name;$rule.ApplicationName=$expected;$rule.Direction=2;$rule.Action=0;$rule.Protocol=256;$rule.Profiles=2147483647;$rule.Enabled=$true;$rules.Add($rule);${firewallRuleOwnershipAssertion()}[Console]::Out.Write('verified')`;
  return Object.freeze(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
}

/** Build a fixed PowerShell command that removes and rechecks only this runner's firewall rule. */
export function buildWindowsNormalCandidateFirewallRemoveArguments() {
  const script = `$ErrorActionPreference='Stop';${firewallRulePrelude()}${firewallPolicyPrelude()}${firewallRuleOwnershipAssertion()}$rules.Remove($name);${firewallRuleMatches()}if($ownedRules.Count -ne 0){throw 'rule'};[Console]::Out.Write('removed')`;
  return Object.freeze(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
}

function validPowerShellSuccess(value, expected) {
  return value?.settled === true && value.timedOut === false && value.exitCode === 0
    && value.output === expected;
}

export async function installOutboundFirewallBlock({
  appPath,
  environment,
  name = `${FIREWALL_RULE_PREFIX}${randomUUID()}`,
  runProgram = runFixedPowerShell,
} = {}) {
  if (!exactWindowsPath(appPath) || !FIREWALL_RULE_NAME.test(name) || typeof runProgram !== "function") {
    fail("FIREWALL_UNAVAILABLE");
  }
  const result = await runProgram(systemPowerShell(environment), buildWindowsNormalCandidateFirewallCreateArguments(), {
    environment,
    values: { [EXPECTED_APP_ENVIRONMENT]: appPath, [FIREWALL_NAME_ENVIRONMENT]: name },
    timeoutMs: WINDOWS_NORMAL_CANDIDATE_FIREWALL_TIMEOUT_MS,
  });
  if (validPowerShellSuccess(result, "verified")) return name;
  if (result?.settled === true && result?.timedOut === false && result?.exitCode !== 0) {
    fail("FIREWALL_RULE_INVALID");
  }
  fail("FIREWALL_UNAVAILABLE");
}

export async function removeOutboundFirewallBlock({ appPath, environment, name, runProgram = runFixedPowerShell } = {}) {
  if (!exactWindowsPath(appPath) || !FIREWALL_RULE_NAME.test(name) || typeof runProgram !== "function") {
    return false;
  }
  try {
    const result = await runProgram(systemPowerShell(environment), buildWindowsNormalCandidateFirewallRemoveArguments(), {
      environment,
      values: { [EXPECTED_APP_ENVIRONMENT]: appPath, [FIREWALL_NAME_ENVIRONMENT]: name },
      timeoutMs: WINDOWS_NORMAL_CANDIDATE_FIREWALL_TIMEOUT_MS,
    });
    return validPowerShellSuccess(result, "removed");
  } catch {
    return false;
  }
}

/**
 * Reuse the reviewed Toolhelp snapshot/query path from the NSIS lifecycle
 * runner. WMI/CIM hangs in hosted Windows cleanup, so this runner never uses
 * either API. The query output contains only PID, parent PID, and creation
 * metadata; exact executable paths remain inside the fixed child process.
 */
async function readNormalCandidateExactProcesses({
  appPath,
  environment,
  runProgram = runWindowsNsisLifecycleProgram,
} = {}) {
  if (!exactWindowsPath(appPath) || typeof runProgram !== "function") {
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
  let result;
  try {
    result = await runProgram(
      systemPowerShell(environment),
      buildWindowsExactExecutableProcessQueryArguments(appPath, {
        executableName: WINDOWS_NORMAL_CANDIDATE_APP_NAME,
      }),
      {
        timeoutMs: POWERSHELL_TIMEOUT_MS,
        captureOutput: true,
        environment,
        fixedProbePath: appPath,
        fixedPowerShellUtilityModules: true,
      },
    );
    if (result?.settled !== true || result?.timedOut !== false || result?.exitCode !== 0) {
      fail("PROCESS_PROOF_UNAVAILABLE");
    }
    return parseWindowsProcessSnapshot(result.stdout);
  } catch (error) {
    if (String(error?.code ?? "").startsWith(PREFIX)) throw error;
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
}

async function readNormalCandidateProcessSnapshot({
  rootProcessId = null,
  retainedProcessIds = null,
  environment,
  runProgram = runWindowsNsisLifecycleProgram,
} = {}) {
  if (typeof runProgram !== "function") fail("PROCESS_PROOF_UNAVAILABLE");
  let result;
  try {
    result = await runProgram(
      systemPowerShell(environment),
      buildWindowsOwnedProcessSnapshotQueryArguments({ rootProcessId, retainedProcessIds }),
      {
        timeoutMs: POWERSHELL_TIMEOUT_MS,
        captureOutput: true,
        environment,
        fixedPowerShellUtilityModules: true,
      },
    );
    if (result?.settled !== true || result?.timedOut !== false || result?.exitCode !== 0) {
      fail("PROCESS_PROOF_UNAVAILABLE");
    }
    return parseWindowsProcessSnapshot(result.stdout);
  } catch (error) {
    if (String(error?.code ?? "").startsWith(PREFIX)) throw error;
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
}

async function assertCandidateProcessProof({
  appPath,
  rootPid,
  environment,
  runProgram = runWindowsNsisLifecycleProgram,
} = {}) {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) fail("PROCESS_PROOF_UNAVAILABLE");
  const [exactProcesses, snapshot] = await Promise.all([
    readNormalCandidateExactProcesses({ appPath, environment, runProgram }),
    readNormalCandidateProcessSnapshot({ rootProcessId: rootPid, environment, runProgram }),
  ]);
  const tracked = ownedWindowsProcessTree(snapshot, rootPid);
  const root = exactProcesses.filter((entry) => entry.pid === rootPid);
  if (root.length !== 1 || tracked.length < 2
      || !tracked.some((entry) => entry.pid !== rootPid
        && exactProcesses.some((exact) => exact.pid === entry.pid && exact.creation === entry.creation))) {
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
  return tracked;
}

async function assertCandidateProcessAbsence({
  appPath,
  environment,
  tracked = null,
  runProgram = runWindowsNsisLifecycleProgram,
} = {}) {
  try {
    if (tracked !== null) {
      const snapshot = await readNormalCandidateProcessSnapshot({
        rootProcessId: null,
        retainedProcessIds: tracked.map(({ pid }) => pid),
        environment,
        runProgram,
      });
      assertWindowsProcessTreeExited(tracked, snapshot);
    }
    if ((await readNormalCandidateExactProcesses({ appPath, environment, runProgram })).length !== 0) {
      fail("OWNED_PROCESS_REMAINS");
    }
    return true;
  } catch (error) {
    if (String(error?.code ?? "").startsWith(PREFIX)) throw error;
    fail("OWNED_PROCESS_REMAINS");
  }
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function waitFor(operation, timeoutMs, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const value = await operation();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch {
      // The caller converts a bounded missing condition to its own fixed code.
    }
    if (Date.now() >= deadline) return null;
    await wait(intervalMs);
  }
}

async function freeLoopbackPort({ createLoopbackServer = createServer } = {}) {
  const server = createLoopbackServer();
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const port = server.address()?.port;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) fail("CDP_UNAVAILABLE");
    return port;
  } catch (error) {
    if (String(error?.code ?? "").startsWith(PREFIX)) throw error;
    fail("CDP_UNAVAILABLE");
  } finally {
    await new Promise((resolveClose) => server.close(() => resolveClose())).catch(() => {});
  }
}

export async function jsonFetch(url, {
  fetchImpl = fetch,
  timeoutMs = OPERATION_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("loopback response unavailable");
  }
  const controller = new AbortController();
  let timer = null;
  const timeout = new Promise((_, rejectTimeout) => {
    timer = setTimeout(() => {
      controller.abort();
      rejectTimeout(new Error("loopback response unavailable"));
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(url, { signal: controller.signal, redirect: "error" }),
      timeout,
    ]);
    if (!response?.ok || response.redirected === true || typeof response.json !== "function") {
      throw new Error("loopback response unavailable");
    }
    return await Promise.race([response.json(), timeout]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function exactLoopbackOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1"
      && Number.isSafeInteger(port) && port >= 1 && port <= 65_535
      && parsed.origin === value
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function exactLoopbackRootPage(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return exactLoopbackOrigin(parsed.origin) !== null
      && parsed.pathname === "/" && parsed.search === "" && parsed.hash === ""
      && parsed.username === "" && parsed.password === "" && parsed.href === value
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function exactDebuggerWebSocket(value, port) {
  if (typeof value !== "string" || !Number.isSafeInteger(port)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "ws:" && parsed.hostname === "127.0.0.1"
      && parsed.port === String(port) && /^\/devtools\/page\/[^/]+$/u.test(parsed.pathname)
      && parsed.search === "" && parsed.hash === "" && parsed.username === ""
      && parsed.password === "";
  } catch {
    return false;
  }
}

/** Select only the exact loopback dashboard page exposed by this CDP endpoint. */
export function selectWindowsNormalCandidateDashboardTarget(targets, debugPort) {
  if (!Array.isArray(targets) || !Number.isSafeInteger(debugPort)) return undefined;
  return targets.find((target) => {
    if (target?.type !== "page" || typeof target.url !== "string") return false;
    const page = exactLoopbackRootPage(target.url);
    return page !== null && exactDebuggerWebSocket(target.webSocketDebuggerUrl, debugPort);
  });
}

/** Select only the Settings page from the exact already-bound dashboard origin. */
export function selectWindowsNormalCandidateSettingsTarget(targets, dashboardOrigin, debugPort) {
  const dashboard = exactLoopbackOrigin(dashboardOrigin);
  if (!Array.isArray(targets) || dashboard === null || !Number.isSafeInteger(debugPort)) return undefined;
  return targets.find((target) => {
    if (target?.type !== "page" || typeof target.url !== "string") return false;
    try {
      const page = new URL(target.url);
      return page.protocol === "http:" && page.hostname === "127.0.0.1"
        && page.origin === dashboard.origin && page.pathname === "/electron-settings.html"
        && page.search === "" && page.hash === "" && page.username === "" && page.password === ""
        && exactDebuggerWebSocket(target.webSocketDebuggerUrl, debugPort);
    } catch {
      return false;
    }
  });
}

async function connectCdp(target, {
  WebSocketConstructor = WebSocket,
} = {}) {
  const socket = new WebSocketConstructor(target.webSocketDebuggerUrl);
  await Promise.race([
    new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener("open", resolveOpen, { once: true });
      socket.addEventListener("error", () => rejectOpen(new Error("CDP websocket unavailable")), { once: true });
    }),
    wait(OPERATION_TIMEOUT_MS).then(() => Promise.reject(new Error("CDP timeout"))),
  ]);
  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();
  const onMessage = (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (!Number.isInteger(message.id)) {
      for (const handler of handlers.get(message.method) ?? []) handler(message.params ?? {});
      return;
    }
    const pendingRequest = pending.get(message.id);
    if (!pendingRequest) return;
    pending.delete(message.id);
    if (message.error) pendingRequest.reject(new Error("CDP request unavailable"));
    else pendingRequest.resolve(message.result ?? {});
  };
  socket.addEventListener("message", onMessage);
  const request = (method, params = {}) => {
    const id = nextId++;
    const response = new Promise((resolveRequest, rejectRequest) => {
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch (error) { pending.delete(id); throw error; }
    return Promise.race([
      response,
      wait(OPERATION_TIMEOUT_MS).then(() => Promise.reject(new Error("CDP timeout"))),
    ]);
  };
  return Object.freeze({
    request,
    async evaluate(expression) {
      const value = await request("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (value.exceptionDetails) throw new Error("renderer unavailable");
      return value.result?.value;
    },
    on(method, handler) {
      if (typeof method !== "string" || typeof handler !== "function") throw new TypeError("invalid CDP handler");
      const registered = handlers.get(method) ?? new Set();
      registered.add(handler);
      handlers.set(method, registered);
      return () => {
        registered.delete(handler);
        if (registered.size === 0) handlers.delete(method);
      };
    },
    close() {
      try { socket.close(); } catch { /* best-effort local DevTools cleanup */ }
      for (const pendingRequest of pending.values()) pendingRequest.reject(new Error("CDP closed"));
      pending.clear();
      handlers.clear();
    },
  });
}

function localNetworkObserver(cdp, dashboardOrigin) {
  let invalid = false;
  let refreshes = 0;
  const inspect = (url, method = null) => {
    if (typeof url !== "string" || url.length === 0 || url.length > 2048) {
      invalid = true;
      return;
    }
    let parsed;
    try { parsed = new URL(url); } catch { invalid = true; return; }
    if ((parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "ws:" || parsed.protocol === "wss:")
        && parsed.origin !== dashboardOrigin) {
      invalid = true;
    }
    if (method === "POST" && parsed.origin === dashboardOrigin && parsed.pathname === "/api/local/refresh") {
      refreshes += 1;
    }
  };
  const removeRequest = cdp.on("Network.requestWillBeSent", ({ request } = {}) => inspect(request?.url, request?.method));
  const removeSocket = cdp.on("Network.webSocketCreated", ({ url } = {}) => inspect(url));
  return Object.freeze({
    resetRefreshes() { refreshes = 0; },
    refreshCount() { return refreshes; },
    refreshObserved() { return refreshes > 0; },
    valid() { return !invalid; },
    dispose() { removeRequest(); removeSocket(); },
  });
}

/**
 * The normal candidate has one inherited-IPC capability: request the same
 * desktop-lifecycle.quit path as the tray. It accepts no credential, status,
 * storage, or renderer messages and is never exposed to a preload bridge.
 */
export function createWindowsNormalCandidateQuitProtocol(child, {
  timeoutMs = PROCESS_EXIT_TIMEOUT_MS,
} = {}) {
  if (!child || child.connected !== true || typeof child.send !== "function"
      || typeof child.on !== "function" || typeof child.off !== "function"
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    fail("CLEAN_QUIT_INVALID");
  }
  let active = true;
  let pending = null;
  const clean = () => {
    if (!active) return;
    active = false;
    child.off("message", onMessage);
    child.off("disconnect", onDisconnect);
    child.off("error", onError);
  };
  const rejectPending = () => {
    if (pending === null) return;
    clearTimeout(pending.timer);
    const current = pending;
    pending = null;
    current.reject(failure("CLEAN_QUIT_INVALID"));
  };
  const onMessage = (message) => {
    if (pending === null || message === null || typeof message !== "object"
        || Array.isArray(message) || Reflect.ownKeys(message).length !== 1
        || message.type !== NORMAL_CANDIDATE_QUIT_ACCEPTED) return;
    clearTimeout(pending.timer);
    const current = pending;
    pending = null;
    current.resolve(true);
  };
  const onDisconnect = () => rejectPending();
  const onError = () => rejectPending();
  child.on("message", onMessage);
  child.on("disconnect", onDisconnect);
  child.on("error", onError);
  return Object.freeze({
    requestQuit() {
      if (!active || pending !== null || child.connected !== true) fail("CLEAN_QUIT_INVALID");
      return new Promise((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          if (pending === null) return;
          pending = null;
          rejectRequest(failure("CLEAN_QUIT_INVALID"));
        }, timeoutMs);
        pending = { resolve: resolveRequest, reject: rejectRequest, timer };
        try {
          child.send(NORMAL_CANDIDATE_QUIT_REQUEST, (error) => {
            if (error) rejectPending();
          });
        } catch {
          rejectPending();
        }
      });
    },
    close() {
      rejectPending();
      clean();
    },
  });
}

function waitForChildExit(child, timeoutMs = PROCESS_EXIT_TIMEOUT_MS) {
  if (child?.exitCode !== null || child?.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const onExit = () => { clearTimeout(timer); resolveExit(true); };
    const timer = setTimeout(() => {
      child?.off?.("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    child?.once?.("exit", onExit);
  });
}

async function stopOwnedCandidate(child, {
  environment,
  spawnProgram = spawn,
} = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) return false;
  const root = exactWindowsPath(environment?.SystemRoot);
  if (root === null) return false;
  try {
    const killer = spawnProgram(win32.join(root, "System32", "taskkill.exe"), [
      "/PID", String(child.pid), "/T", "/F",
    ], {
      cwd: root,
      env: fixedPowerShellEnvironment(environment),
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once?.("error", () => {});
  } catch {
    return false;
  }
  return waitForChildExit(child, CLEANUP_TIMEOUT_MS);
}

async function connectDashboard({ port, fetchImpl, WebSocketConstructor }) {
  const endpoint = `http://127.0.0.1:${port}`;
  const version = await waitFor(
    () => jsonFetch(`${endpoint}/json/version`, { fetchImpl }),
    STARTUP_TIMEOUT_MS,
  );
  if (!exactObject(version)) fail("CDP_UNAVAILABLE");
  const target = await waitFor(async () => {
    const targets = await jsonFetch(`${endpoint}/json`, { fetchImpl });
    return selectWindowsNormalCandidateDashboardTarget(targets, port);
  }, STARTUP_TIMEOUT_MS);
  if (!target) fail("DASHBOARD_UNAVAILABLE");
  let cdp;
  try { cdp = await connectCdp(target, { WebSocketConstructor }); }
  catch { fail("CDP_UNAVAILABLE"); }
  return Object.freeze({ cdp, endpoint, target });
}

async function assertDashboard({ cdp, target, fetchImpl }) {
  const dashboard = exactLoopbackRootPage(target.url);
  if (dashboard === null) fail("DASHBOARD_INVALID");
  const observer = localNetworkObserver(cdp, dashboard.origin);
  try {
    await cdp.request("Page.enable");
    await cdp.request("Network.enable");
    const ready = await waitFor(async () => {
      const value = await cdp.evaluate(`(() => ({
        ready: document.documentElement?.dataset?.localDashboardReady === "true",
        title: document.title,
        heading: document.querySelector("#overview-title")?.textContent?.trim() ?? "",
        location: location.href,
      }))()`);
      return value?.ready === true && value.title === "TiboTattle" && typeof value.heading === "string"
        && value.heading.length > 0 && value.location === dashboard.href ? value : null;
    }, STARTUP_TIMEOUT_MS);
    if (ready === null) fail("DASHBOARD_UNAVAILABLE");
    const health = await jsonFetch(new URL("/api/local/health", dashboard), { fetchImpl });
    if (health?.status !== "ready") fail("DASHBOARD_UNAVAILABLE");
    const refreshEndpoint = new URL("/api/local/refresh", dashboard);
    // Ordinary Electron runs one launch-time refresh and holds manual Refresh
    // disabled while it is active. The observer is attached before dashboard
    // readiness, so require its exact one local POST instead of clicking a
    // second operation into that intentional busy state.
    const accepted = await waitFor(async () => {
      if (observer.refreshCount() > 1) fail("DASHBOARD_INVALID");
      const decision = classifyAutomaticStartupRefreshReceipt({
        phase: "acceptance",
        requestCount: observer.refreshCount(),
        refresh: (await jsonFetch(refreshEndpoint, { fetchImpl }))?.refresh,
        previousRefreshId: null,
      });
      return decision.status === "accepted" ? decision : null;
    }, STARTUP_TIMEOUT_MS);
    if (accepted === null) fail("LOCAL_STARTUP_REFRESH_UNAVAILABLE");
    const terminal = await waitFor(async () => {
      if (observer.refreshCount() > 1) fail("DASHBOARD_INVALID");
      const decision = classifyAutomaticStartupRefreshReceipt({
        phase: "completion",
        requestCount: observer.refreshCount(),
        refresh: (await jsonFetch(refreshEndpoint, { fetchImpl }))?.refresh,
        expectedRefreshId: accepted.refreshId,
      });
      return decision.status === "completed" ? decision : null;
    }, STARTUP_TIMEOUT_MS);
    if (terminal === null) fail("LOCAL_STARTUP_REFRESH_COMPLETION_UNAVAILABLE");
    // The startup pass is terminal now, so ordinary user interaction must be
    // restored. Reset the observer only after preserving that proof: the next
    // one local POST is the user-requested detailed refresh, not a duplicate
    // startup operation.
    observer.resetRefreshes();
    const clicked = await waitFor(() => cdp.evaluate(`(() => {
      const button = document.querySelector("#refresh-button");
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`), OPERATION_TIMEOUT_MS);
    if (clicked !== true) fail("LOCAL_EXPLICIT_REFRESH_BUTTON_UNAVAILABLE");
    if (await waitFor(() => observer.refreshObserved(), OPERATION_TIMEOUT_MS) !== true) {
      fail("LOCAL_EXPLICIT_REFRESH_REQUEST_UNOBSERVED");
    }
    const explicitAccepted = await waitFor(async () => {
      if (observer.refreshCount() > 1) fail("DASHBOARD_INVALID");
      const decision = classifyAutomaticStartupRefreshReceipt({
        phase: "acceptance",
        requestCount: observer.refreshCount(),
        refresh: (await jsonFetch(refreshEndpoint, { fetchImpl }))?.refresh,
        previousRefreshId: accepted.refreshId,
      });
      return decision.status === "accepted" ? decision : null;
    }, STARTUP_TIMEOUT_MS);
    if (explicitAccepted === null) fail("LOCAL_EXPLICIT_REFRESH_ACCEPTANCE_UNAVAILABLE");
    const explicitTerminal = await waitFor(async () => {
      if (observer.refreshCount() > 1) fail("DASHBOARD_INVALID");
      const decision = classifyAutomaticStartupRefreshReceipt({
        phase: "completion",
        requestCount: observer.refreshCount(),
        refresh: (await jsonFetch(refreshEndpoint, { fetchImpl }))?.refresh,
        expectedRefreshId: explicitAccepted.refreshId,
      });
      return decision.status === "completed" ? decision : null;
    }, STARTUP_TIMEOUT_MS);
    if (explicitTerminal === null) fail("LOCAL_EXPLICIT_REFRESH_COMPLETION_UNAVAILABLE");
    if (!observer.valid()) fail("DASHBOARD_INVALID");
    return Object.freeze({
      dashboardOrigin: dashboard.origin,
      observer,
      refreshTerminalStatus: explicitTerminal.terminalStatus,
    });
  } catch (error) {
    observer.dispose();
    if (String(error?.code ?? "").startsWith(PREFIX)) throw error;
    fail("DASHBOARD_UNAVAILABLE");
  }
}

async function assertRenderedSharingOptOut(cdp) {
  let retained = false;
  try {
    retained = await cdp.evaluate(`(async () => {
      const preference = await globalThis.tibotattleDesktop?.getSharingPreference?.();
      return preference?.enabled === false && preference?.transportStatus === "off";
    })()`);
  } catch {
    retained = false;
  }
  if (retained !== true) fail("PROTECTED_OPT_OUT_UNAVAILABLE");
  return true;
}

async function findSettingsTarget(endpoint, dashboardOrigin, port, fetchImpl) {
  return waitFor(async () => selectWindowsNormalCandidateSettingsTarget(
    await jsonFetch(`${endpoint}/json`, { fetchImpl }),
    dashboardOrigin,
    port,
  ), STARTUP_TIMEOUT_MS);
}

async function openSettings({ dashboardCdp, endpoint, dashboardOrigin, port, fetchImpl, WebSocketConstructor }) {
  const opened = await dashboardCdp.evaluate(`(() => {
    const button = document.querySelector("#electron-settings-button");
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (opened !== true) fail("SETTINGS_UNAVAILABLE");
  const target = await findSettingsTarget(endpoint, dashboardOrigin, port, fetchImpl);
  if (!target) fail("SETTINGS_UNAVAILABLE");
  try {
    const cdp = await connectCdp(target, { WebSocketConstructor });
    await cdp.request("Page.enable");
    return cdp;
  } catch {
    fail("SETTINGS_UNAVAILABLE");
  }
}

async function readSettingsRefreshInterval(cdp) {
  return cdp.evaluate(`(async () => {
    const snapshot = await globalThis.tibotattleDesktop?.getSettings?.();
    const value = snapshot?.settings?.refreshIntervalSeconds ?? snapshot?.refreshIntervalSeconds;
    return Number.isSafeInteger(value) ? value : null;
  })()`).catch(() => null);
}

async function waitForSettingsReady(cdp) {
  const ready = await waitFor(async () => {
    const value = await cdp.evaluate(`(() => ({
      title: document.title,
      bridge: document.querySelector("#settings-bridge-status")?.classList.contains("is-ready") === true,
      refresh: document.querySelector("#settings-refresh-interval"),
    }))()`);
    return value?.title === "TiboTattle Settings" && value.bridge === true && value.refresh ? true : null;
  }, STARTUP_TIMEOUT_MS);
  if (ready !== true) fail("SETTINGS_UNAVAILABLE");
}

/**
 * Use the same tab a person uses before operating the data controls. The
 * refresh selector begins inside a hidden panel, so a synthetic change event
 * on the inactive control would not prove the rendered settings journey.
 */
async function activateSettingsDataPanel(cdp) {
  const active = await waitFor(async () => cdp.evaluate(`(() => {
    const tab = document.querySelector("#settings-tab-data");
    const panel = document.querySelector("#settings-panel-data");
    const select = document.querySelector("#settings-refresh-interval");
    if (!tab || !panel || !select) return false;
    if (tab.getAttribute("aria-selected") !== "true" || panel.hidden) tab.click();
    const style = globalThis.getComputedStyle?.(panel);
    return tab.getAttribute("aria-selected") === "true"
      && panel.hidden === false
      && panel.getClientRects().length > 0
      && style?.display !== "none"
      && style?.visibility !== "hidden"
      && select.disabled === false;
  })()`).catch(() => false), STARTUP_TIMEOUT_MS);
  if (active !== true) fail("SETTINGS_UNAVAILABLE");
}

async function setSettingsRefreshInterval(cdp, seconds) {
  const changed = await cdp.evaluate(`(() => {
    const tab = document.querySelector("#settings-tab-data");
    const panel = document.querySelector("#settings-panel-data");
    const select = document.querySelector("#settings-refresh-interval");
    const style = panel ? globalThis.getComputedStyle?.(panel) : null;
    if (!tab || !panel || !select || tab.getAttribute("aria-selected") !== "true"
        || panel.hidden || panel.getClientRects().length === 0 || style?.display === "none"
        || style?.visibility === "hidden" || select.disabled) return false;
    select.value = ${JSON.stringify(String(seconds))};
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return select.value === ${JSON.stringify(String(seconds))};
  })()`);
  if (changed !== true) fail("SETTINGS_UNAVAILABLE");
  if (await waitFor(async () => (await readSettingsRefreshInterval(cdp)) === seconds, OPERATION_TIMEOUT_MS) !== true) {
    fail("SETTINGS_UNAVAILABLE");
  }
}

async function assertFirstSettingsPersistence(input) {
  const settings = await openSettings(input);
  try {
    await waitForSettingsReady(settings);
    await activateSettingsDataPanel(settings);
    if (await readSettingsRefreshInterval(settings) !== 300) fail("SETTINGS_PERSISTENCE_INVALID");
    await setSettingsRefreshInterval(settings, 900);
    return true;
  } finally {
    settings.close();
  }
}

async function assertSecondSettingsPersistence(input) {
  const settings = await openSettings(input);
  try {
    await waitForSettingsReady(settings);
    await activateSettingsDataPanel(settings);
    if (await readSettingsRefreshInterval(settings) !== 900) fail("SETTINGS_PERSISTENCE_INVALID");
    return true;
  } finally {
    settings.close();
  }
}

async function closeCandidate(child, quitProtocol) {
  try { await quitProtocol.requestQuit(); }
  catch { fail("CLEAN_QUIT_INVALID"); }
  if (!await waitForChildExit(child) || child.signalCode !== null || child.exitCode !== 0) {
    fail("CLEAN_QUIT_INVALID");
  }
  return true;
}

async function launchAndRenderCandidate({
  appPath,
  profile,
  environment,
  changeSettings,
  candidateState = null,
  spawnApplication = spawn,
  fetchImpl = fetch,
  WebSocketConstructor = WebSocket,
  freePort = freeLoopbackPort,
  processProof = assertCandidateProcessProof,
  processAbsence = assertCandidateProcessAbsence,
  stopChild = stopOwnedCandidate,
  processRunProgram = runWindowsNsisLifecycleProgram,
  createQuitProtocol = createWindowsNormalCandidateQuitProtocol,
} = {}) {
  const port = await freePort();
  const spec = buildWindowsNormalCandidateLaunchSpec({
    appPath,
    profile,
    remoteDebuggingPort: port,
    environment,
  });
  let child = null;
  let cdp = null;
  let observer = null;
  let quitProtocol = null;
  let clean = false;
  let tracked = null;
  if (candidateState !== null && (typeof candidateState !== "object" || Array.isArray(candidateState))) {
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
  try {
    try {
      child = spawnApplication(spec.command, spec.args, {
        ...spec.options,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      child.once?.("error", () => {});
    } catch {
      fail("APPLICATION_LAUNCH_UNAVAILABLE");
    }
    if (!Number.isSafeInteger(child?.pid) || child.pid < 1) fail("APPLICATION_LAUNCH_UNAVAILABLE");
    if (candidateState !== null) candidateState.quiescent = false;
    quitProtocol = createQuitProtocol(child);
    const connected = await connectDashboard({ port, fetchImpl, WebSocketConstructor });
    cdp = connected.cdp;
    const dashboard = await assertDashboard({ cdp, target: connected.target, fetchImpl });
    observer = dashboard.observer;
    const sharingOptOutRetained = await assertRenderedSharingOptOut(cdp);
    tracked = await processProof({
      appPath,
      rootPid: child.pid,
      environment,
      runProgram: processRunProgram,
    });
    if (candidateState !== null) candidateState.tracked = tracked;
    const input = {
      dashboardCdp: cdp,
      endpoint: connected.endpoint,
      dashboardOrigin: dashboard.dashboardOrigin,
      port,
      fetchImpl,
      WebSocketConstructor,
    };
    if (changeSettings) await assertFirstSettingsPersistence(input);
    else await assertSecondSettingsPersistence(input);
    if (!observer.valid()) fail("DASHBOARD_INVALID");
    await closeCandidate(child, quitProtocol);
    await processAbsence({
      appPath,
      environment,
      tracked,
      runProgram: processRunProgram,
    });
    if (candidateState !== null) candidateState.quiescent = true;
    clean = true;
    return Object.freeze({
      dashboardRendered: true,
      localRefreshObserved: true,
      localRefreshTerminal: dashboard.refreshTerminalStatus,
      sharingOptOutRetained,
      settingsPersisted: true,
      cleanQuit: true,
    });
  } finally {
    observer?.dispose?.();
    cdp?.close?.();
    quitProtocol?.close?.();
    if (!clean) {
      let stopped = false;
      try { stopped = await stopChild(child, { environment, spawnProgram: spawnApplication }); }
      catch { stopped = false; }
      if (stopped) {
        try {
          await processAbsence({
            appPath,
            environment,
            tracked,
            runProgram: processRunProgram,
          });
          if (candidateState !== null) candidateState.quiescent = true;
        } catch {
          // The outer teardown retains the firewall rule and profile below.
        }
      }
      if (candidateState === null || candidateState.quiescent !== true) {
        fail("OWNED_PROCESS_REMAINS");
      }
    }
  }
}

async function createOwnedRoot(runnerTemp) {
  const base = exactWindowsPath(runnerTemp);
  if (base === null) fail("RUNNER_TEMP_INVALID");
  await regularDirectory(base, "RUNNER_TEMP_INVALID");
  let root;
  try {
    root = await mkdtemp(win32.join(base, "tibotattle-windows-normal-candidate-"));
  } catch {
    fail("RUNNER_TEMP_INVALID");
  }
  if (!sameWindowsPath(win32.dirname(root), base)) fail("RUNNER_TEMP_INVALID");
  await regularDirectory(root, "RUNNER_TEMP_INVALID");
  return root;
}

async function ensureWindowsNormalCandidateReceiptParent(receiptPath) {
  const selected = exactWindowsPath(receiptPath);
  const parent = selected === null ? null : win32.dirname(selected);
  const staging = parent === null ? null : win32.dirname(parent);
  if (selected === null
      || win32.basename(selected) !== "normal-candidate-smoke.json"
      || win32.basename(parent) !== "electron-windows-normal-candidate"
      || win32.basename(staging) !== ".release-build") {
    fail("RECEIPT_INVALID");
  }
  const parsed = win32.parse(parent);
  const parts = win32.relative(parsed.root, parent).split("\\").filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = win32.join(current, part);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory?.() || metadata.isSymbolicLink?.()) fail("RECEIPT_INVALID");
    } catch (error) {
      if (String(error?.code ?? "") !== "ENOENT") {
        if (String(error?.code ?? "").startsWith(PREFIX)) throw error;
        fail("RECEIPT_INVALID");
      }
      try { await mkdir(current, { mode: 0o700 }); }
      catch { fail("RECEIPT_INVALID"); }
      try {
        const metadata = await lstat(current);
        if (!metadata.isDirectory?.() || metadata.isSymbolicLink?.()) fail("RECEIPT_INVALID");
      } catch (error) {
        if (String(error?.code ?? "").startsWith(PREFIX)) throw error;
        fail("RECEIPT_INVALID");
      }
    }
  }
  return parent;
}

function candidateReceipt({ sourceRevision, identity = null, journey = null, errorCode = null, cleanup = {} } = {}) {
  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA,
    status: errorCode === null ? "passed" : "failed",
    scope: "candidate_only",
    target: TARGET,
    sourceRevision,
    artifactSha256: identity?.artifactSha256 ?? null,
    executableSha256: identity?.executableSha256 ?? null,
    packageArtifactVerified: identity !== null,
    packagedElectronExecutionVerified: journey !== null,
    dashboardRendered: journey?.dashboardRendered === true,
    localRefreshObserved: journey?.localRefreshObserved === true,
    localRefreshTerminal: ["succeeded", "degraded"].includes(journey?.localRefreshTerminal)
      ? journey.localRefreshTerminal
      : null,
    settingsPersistedAcrossRestart: journey?.settingsPersisted === true,
    durableContributionOptOutRetained: journey?.optOutRetained === true,
    loopbackJourneyVerified: journey?.loopbackJourneyVerified === true,
    outboundFirewallRuleVerified: cleanup.firewallInstalled === true,
    outboundFirewallRuleRemoved: cleanup.firewallRemoved === true,
    ownedProfileRemoved: cleanup.profileRemoved === true,
    errorCode,
    productionReady: false,
  });
}

function assertHost({ platform, architecture, environment }) {
  if (platform !== "win32" || architecture !== "x64") fail("WINDOWS_X64_REQUIRED");
  if (environment?.GITHUB_ACTIONS !== "true") fail("DISPOSABLE_CI_REQUIRED");
  return true;
}

/** Execute the normal unpacked journey on a fresh hosted Windows runner account only. */
export async function runWindowsNormalCandidateSmoke(options, {
  platform = process.platform,
  architecture = process.arch,
  environment = process.env,
  verifyPackage = verifyWindowsNormalCandidateSmokePackage,
  createRoot = createOwnedRoot,
  prepareProfile = prepareWindowsDevelopmentProfile,
  seedCodexFixture = seedWindowsNormalCandidateCodexFixture,
  seedProfile = prepareWindowsNormalCandidateProfile,
  launchJourney = launchAndRenderCandidate,
  verifyOptOut = verifyWindowsNormalCandidateOptOut,
  installFirewall = installOutboundFirewallBlock,
  removeFirewall = removeOutboundFirewallBlock,
  assertProcessAbsence = assertCandidateProcessAbsence,
  ensureReceiptParent = ensureWindowsNormalCandidateReceiptParent,
  reserveReceipt = (path) => open(path, "wx", 0o600),
  removeProfile = (path) => rm(path, { recursive: true, force: false }),
} = {}) {
  assertHost({ platform, architecture, environment });
  if (!options || typeof verifyPackage !== "function" || typeof createRoot !== "function"
      || typeof prepareProfile !== "function" || typeof seedCodexFixture !== "function"
      || typeof seedProfile !== "function"
      || typeof launchJourney !== "function" || typeof verifyOptOut !== "function"
      || typeof installFirewall !== "function" || typeof removeFirewall !== "function"
      || typeof assertProcessAbsence !== "function" || typeof ensureReceiptParent !== "function"
      || typeof reserveReceipt !== "function" || typeof removeProfile !== "function") {
    fail("ARGUMENT_INVALID");
  }
  let receiptHandle;
  try {
    await ensureReceiptParent(options.receiptPath);
    receiptHandle = await reserveReceipt(options.receiptPath);
  }
  catch { fail("RECEIPT_INVALID"); }
  let identity = null;
  let root = null;
  let firewallName = null;
  let journey = null;
  let errorCode = null;
  const cleanup = { firewallInstalled: false, firewallRemoved: false, profileRemoved: false };
  const candidateState = { quiescent: false, tracked: null };
  try {
    identity = await verifyPackage(options);
    root = await createRoot(environment.RUNNER_TEMP);
    const profile = await prepareProfile({ appPath: options.appPath, profilePath: win32.join(root, "profile") });
    await seedCodexFixture({ profile });
    const seed = await seedProfile({ profile, stagedAppPath: options.stagedAppPath });
    await assertProcessAbsence({ appPath: options.appPath, environment });
    candidateState.quiescent = true;
    firewallName = await installFirewall({ appPath: options.appPath, environment });
    cleanup.firewallInstalled = true;
    const first = await launchJourney({
      appPath: options.appPath,
      profile,
      environment,
      changeSettings: true,
      candidateState,
    });
    const second = await launchJourney({
      appPath: options.appPath,
      profile,
      environment,
      changeSettings: false,
      candidateState,
    });
    if (first?.dashboardRendered !== true || first?.localRefreshObserved !== true
        || first?.settingsPersisted !== true || first?.cleanQuit !== true
        || !["succeeded", "degraded"].includes(first?.localRefreshTerminal)
        || first?.sharingOptOutRetained !== true || second?.dashboardRendered !== true
        || second?.sharingOptOutRetained !== true || second?.settingsPersisted !== true
        || second?.cleanQuit !== true || candidateState.quiescent !== true) {
      fail("DASHBOARD_INVALID");
    }
    const optOutRetained = await verifyOptOut(seed);
    if (optOutRetained !== true) fail("PROTECTED_OPT_OUT_UNAVAILABLE");
    journey = Object.freeze({
      dashboardRendered: first.dashboardRendered === true && second.dashboardRendered === true,
      localRefreshObserved: first.localRefreshObserved === true,
      localRefreshTerminal: first.localRefreshTerminal,
      settingsPersisted: first.settingsPersisted === true && second.settingsPersisted === true,
      optOutRetained: optOutRetained === true
        && first.sharingOptOutRetained === true && second.sharingOptOutRetained === true,
      loopbackJourneyVerified: first.cleanQuit === true && second.cleanQuit === true,
    });
  } catch (error) {
    errorCode = fixedCode(error);
  } finally {
    if (firewallName !== null && candidateState.quiescent === true) {
      cleanup.firewallRemoved = await removeFirewall({
        appPath: options.appPath,
        environment,
        name: firewallName,
      });
      if (!cleanup.firewallRemoved && errorCode === null) errorCode = `${PREFIX}FIREWALL_CLEANUP_UNCONFIRMED`;
    }
    if (firewallName !== null && candidateState.quiescent !== true) {
      errorCode = `${PREFIX}OWNED_PROCESS_REMAINS`;
    }
    if (root !== null && cleanup.firewallRemoved) {
      try {
        await removeProfile(root);
        cleanup.profileRemoved = true;
      } catch {
        if (errorCode === null) errorCode = `${PREFIX}PROFILE_CLEANUP_UNCONFIRMED`;
      }
    }
    const receipt = candidateReceipt({
      sourceRevision: options?.sourceRevision ?? null,
      identity,
      journey,
      errorCode,
      cleanup,
    });
    try {
      await receiptHandle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
      await receiptHandle.sync();
    } finally {
      await receiptHandle.close();
    }
  }
  if (errorCode !== null) throw Object.assign(new Error(errorCode), { code: errorCode });
  return Object.freeze({ status: "passed", ...identity });
}

if (resolve(process.argv[1] ?? "") === SCRIPT_FILE) {
  try {
    process.stdout.write(`${JSON.stringify(await runWindowsNormalCandidateSmoke(
      parseWindowsNormalCandidateSmokeArguments(process.argv.slice(2)),
    ))}\n`);
  } catch (error) {
    process.stderr.write(`${fixedCode(error)}\n`);
    process.exitCode = 1;
  }
}
