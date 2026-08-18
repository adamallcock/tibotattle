import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";

import {
  deriveExportPseudonym,
  deriveExportPseudonymV2,
} from "@app-usagemonitor/identity-core";

const SECRET_BYTES = 32;
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LEGACY_RETIREMENT_CONTENT = "app-usagemonitor legacy secret retired v1\n";
const BACKEND_RETIREMENT_CONTENT = "app-usagemonitor owner file backend retired v1\n";
const ROTATION_CONFIRMATION_ERROR = "Participant secret rotation requires confirmRotation: true";

function resolveWindowsFilesystemAdapter(adapter) {
  const selected = adapter ?? null;
  if (process.platform === "win32"
      && (selected?.productionSafe !== true || selected?.pathWalkRaceSafe !== true)) {
    const error = new Error("Windows filesystem production policy is unavailable");
    error.code = "EXPORT_IDENTITY_WINDOWS_FILESYSTEM_POLICY_UNAVAILABLE";
    throw error;
  }
  return selected;
}

function isWindowsFilesystemNotFound(error) {
  return error?.code === "ENOENT" || error?.code === "WINDOWS_FILESYSTEM_NOT_FOUND";
}

function isWindowsFilesystemAlreadyExists(error) {
  return error?.code === "EEXIST" || error?.code === "WINDOWS_FILESYSTEM_ALREADY_EXISTS";
}

function sameWindowsFileIdentity(left, right) {
  return typeof left?.volumeSerialNumber === "string"
    && typeof left?.fileId === "string"
    && typeof right?.volumeSerialNumber === "string"
    && typeof right?.fileId === "string"
    && left.volumeSerialNumber === right.volumeSerialNumber
    && left.fileId === right.fileId;
}

export function defaultExportStateDirectory({
  platform = process.platform,
  homeDirectory = homedir(),
  environment = process.env,
} = {}) {
  const platformPath = platform === "win32" ? win32 : posix;
  if (platform === "darwin") {
    return platformPath.join(
      homeDirectory,
      "Library",
      "Application Support",
      "app-usagemonitor",
    );
  }
  if (platform === "win32") {
    return platformPath.join(
      environment.LOCALAPPDATA
        || platformPath.join(homeDirectory, "AppData", "Local"),
      "app-usagemonitor",
    );
  }
  return platformPath.join(
    environment.XDG_STATE_HOME
      || platformPath.join(homeDirectory, ".local", "state"),
    "app-usagemonitor",
  );
}

export function defaultExportSecretFile(options) {
  const platform = options?.platform ?? process.platform;
  const platformPath = platform === "win32" ? win32 : posix;
  return platformPath.join(
    defaultExportStateDirectory(options),
    "export-participant-secret",
  );
}

export function legacyWorkingDirectorySecretFile({ workingDirectory = process.cwd() } = {}) {
  return resolve(workingDirectory, ".usage-monitor", "export-participant-secret");
}

function decodeSecret(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const result = Buffer.from(value);
    if (result.byteLength !== SECRET_BYTES) throw new Error("Participant secret must contain exactly 32 bytes");
    return result;
  }
  if (typeof value !== "string") throw new Error("Participant secret must be a 32-byte base64url value");
  const normalized = value.trim();
  if (!BASE64URL_256_PATTERN.test(normalized)) throw new Error("Participant secret must be a 32-byte base64url value");
  const result = Buffer.from(normalized, "base64url");
  if (result.byteLength !== SECRET_BYTES) throw new Error("Participant secret must contain exactly 32 bytes");
  return result;
}

export function encodeParticipantSecret(secret) {
  return decodeSecret(secret).toString("base64url");
}

function assertOwnedRegularSecret(stats) {
  if (!stats.isFile()) throw new Error("Participant secret must be a regular file");
  if (stats.nlink !== 1) throw new Error("Participant secret must not be hard-linked");
  if (stats.size !== 44) throw new Error("Participant secret file must contain exactly 44 bytes");
  if (typeof process.getuid === "function" && typeof stats.uid === "number" && stats.uid !== process.getuid()) {
    throw new Error("Participant secret must be owned by the current user");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error("Participant secret permissions must be owner-only");
  }
}

async function readSecretFileWithIdentity(path, windowsFilesystemAdapter = null) {
  const windowsFilesystem = resolveWindowsFilesystemAdapter(windowsFilesystemAdapter);
  if (windowsFilesystem) {
    const observed = windowsFilesystem.readFile(path);
    if (observed.data.byteLength !== 44) {
      throw new Error("Participant secret file must contain exactly 44 bytes");
    }
    return {
      secret: decodeSecret(observed.data.toString("utf8").trim()),
      identity: observed.identity,
    };
  }
  const pathStats = await lstat(path);
  assertOwnedRegularSecret(pathStats);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stats = await handle.stat();
    assertOwnedRegularSecret(stats);
    if (typeof stats.dev === "number" && typeof stats.ino === "number"
        && (stats.dev !== pathStats.dev || stats.ino !== pathStats.ino)) {
      throw new Error("Participant secret changed while it was being opened");
    }
    return {
      secret: decodeSecret((await handle.readFile("utf8")).trim()),
      identity: { dev: stats.dev, ino: stats.ino },
    };
  } finally {
    await handle.close();
  }
}

async function readSecretFile(path, windowsFilesystemAdapter = null) {
  return (await readSecretFileWithIdentity(path, windowsFilesystemAdapter)).secret;
}

function isIncompleteConcurrentCreate(error) {
  return error instanceof Error && error.message === "Participant secret file must contain exactly 44 bytes";
}

async function readSecretFileEventually(path, windowsFilesystemAdapter = null) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await readSecretFileWithIdentity(path, windowsFilesystemAdapter);
    } catch (error) {
      if (!isIncompleteConcurrentCreate(error)) throw error;
      lastError = error;
      await new Promise((resolveRetry) => setTimeout(resolveRetry, Math.min(attempt, 5)));
    }
  }
  throw lastError;
}

function sameFileIdentity(left, right) {
  if (sameWindowsFileIdentity(left, right)) return true;
  return typeof left?.dev === "number" && typeof left?.ino === "number"
    && typeof right?.dev === "number" && typeof right?.ino === "number"
    && left.dev === right.dev && left.ino === right.ino;
}

function secretsEqual(left, right) {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

async function prepareSecretDirectory(path, windowsFilesystemAdapter = null) {
  const directory = dirname(path);
  const windowsFilesystem = resolveWindowsFilesystemAdapter(windowsFilesystemAdapter);
  if (windowsFilesystem) {
    windowsFilesystem.ensureDirectory(directory);
    return;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Participant secret directory must be a real directory");
  if (typeof process.getuid === "function" && typeof stats.uid === "number" && stats.uid !== process.getuid()) {
    throw new Error("Participant secret directory must be owned by the current user");
  }
  if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) {
    throw new Error("Participant secret directory must not be group- or world-writable");
  }
}

async function writeNewSecret(path, encoded, windowsFilesystemAdapter = null) {
  const windowsFilesystem = resolveWindowsFilesystemAdapter(windowsFilesystemAdapter);
  await prepareSecretDirectory(path, windowsFilesystem);
  if (windowsFilesystem) {
    windowsFilesystem.createFile(path, Buffer.from(`${encoded}\n`, "utf8"));
    return;
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    await handle.writeFile(`${encoded}\n`, "utf8");
    await handle.sync();
    const stats = await handle.stat();
    assertOwnedRegularSecret(stats);
  } finally {
    await handle.close();
  }
}

function retirementFileFor(path) {
  return `${path}.legacy-retired`;
}

export function participantSecretLegacyRetirementFile(secretFile = defaultExportSecretFile()) {
  return retirementFileFor(resolve(secretFile));
}

function backendRetirementFileFor(path) {
  return `${path}.backend-retired`;
}

export function participantSecretBackendRetirementFile(secretFile = defaultExportSecretFile()) {
  return backendRetirementFileFor(resolve(secretFile));
}

function assertOwnedRegularControlFile(stats, expectedSize) {
  if (!stats.isFile()) throw new Error("Participant secret control file must be a regular file");
  if (stats.nlink !== 1) throw new Error("Participant secret control file must not be hard-linked");
  if (stats.size !== expectedSize) throw new Error("Participant secret control file has invalid content");
  if (typeof process.getuid === "function" && typeof stats.uid === "number" && stats.uid !== process.getuid()) {
    throw new Error("Participant secret control file must be owned by the current user");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error("Participant secret control file permissions must be owner-only");
  }
}

async function readControlFileWithIdentity(path, expectedContent, windowsFilesystemAdapter = null) {
  const windowsFilesystem = resolveWindowsFilesystemAdapter(windowsFilesystemAdapter);
  if (windowsFilesystem) {
    const observed = windowsFilesystem.readFile(path);
    if (observed.data.byteLength !== Buffer.byteLength(expectedContent)
        || observed.data.toString("utf8") !== expectedContent) {
      throw new Error("Participant secret control file has invalid content");
    }
    return observed.identity;
  }
  const pathStats = await lstat(path);
  assertOwnedRegularControlFile(pathStats, Buffer.byteLength(expectedContent));
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stats = await handle.stat();
    assertOwnedRegularControlFile(stats, Buffer.byteLength(expectedContent));
    if (typeof stats.dev === "number" && typeof stats.ino === "number"
        && (stats.dev !== pathStats.dev || stats.ino !== pathStats.ino)) {
      throw new Error("Participant secret control file changed while it was being opened");
    }
    if ((await handle.readFile("utf8")) !== expectedContent) {
      throw new Error("Participant secret control file has invalid content");
    }
    return { dev: stats.dev, ino: stats.ino };
  } finally {
    await handle.close();
  }
}

async function readLegacyRetirementFile(path, windowsFilesystemAdapter = null) {
  return readControlFileWithIdentity(path, LEGACY_RETIREMENT_CONTENT, windowsFilesystemAdapter);
}

async function readBackendRetirementFile(path, windowsFilesystemAdapter = null) {
  return readControlFileWithIdentity(path, BACKEND_RETIREMENT_CONTENT, windowsFilesystemAdapter);
}

function isIncompleteConcurrentControlCreate(error) {
  return error instanceof Error && error.message === "Participant secret control file has invalid content";
}

async function readLegacyRetirementFileEventually(path, windowsFilesystemAdapter = null) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await readLegacyRetirementFile(path, windowsFilesystemAdapter);
    } catch (error) {
      if (!isIncompleteConcurrentControlCreate(error)) throw error;
      lastError = error;
      await new Promise((resolveRetry) => setTimeout(resolveRetry, Math.min(attempt, 5)));
    }
  }
  throw lastError;
}

async function syncDirectory(directory) {
  const directoryOnly = constants.O_DIRECTORY ?? 0;
  const handle = await open(directory, constants.O_RDONLY | directoryOnly);
  try {
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32" || !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code)) throw error;
  } finally {
    await handle.close();
  }
}

async function ensureLegacyRetired(path, windowsFilesystemAdapter = null) {
  try {
    await readLegacyRetirementFileEventually(path, windowsFilesystemAdapter);
    return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const windowsFilesystem = resolveWindowsFilesystemAdapter(windowsFilesystemAdapter);
  if (windowsFilesystem) {
    await prepareSecretDirectory(path, windowsFilesystem);
    try {
      windowsFilesystem.createFile(path, Buffer.from(LEGACY_RETIREMENT_CONTENT, "utf8"));
      return true;
    } catch (error) {
      if (!isWindowsFilesystemAlreadyExists(error)) throw error;
      await readLegacyRetirementFileEventually(path, windowsFilesystem);
      return false;
    }
  }
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    .catch(async (error) => {
      if (error.code !== "EEXIST") throw error;
      // Another creator exposes the O_EXCL inode before its write/sync has
      // completed. Wait for that bounded critical section, then validate it.
      await readLegacyRetirementFileEventually(path, windowsFilesystem);
      return null;
    });
  if (!handle) return false;
  try {
    await handle.writeFile(LEGACY_RETIREMENT_CONTENT, "utf8");
    await handle.sync();
    assertOwnedRegularControlFile(await handle.stat(), Buffer.byteLength(LEGACY_RETIREMENT_CONTENT));
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
  return true;
}

async function readBackendRetirementFileEventually(path, windowsFilesystemAdapter = null) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await readBackendRetirementFile(path, windowsFilesystemAdapter);
    } catch (error) {
      if (!isIncompleteConcurrentControlCreate(error)) throw error;
      lastError = error;
      await new Promise((resolveRetry) => setTimeout(resolveRetry, Math.min(attempt, 5)));
    }
  }
  throw lastError;
}

async function ensureBackendRetired(path, windowsFilesystemAdapter = null) {
  try {
    await readBackendRetirementFileEventually(path, windowsFilesystemAdapter);
    return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const windowsFilesystem = resolveWindowsFilesystemAdapter(windowsFilesystemAdapter);
  await prepareSecretDirectory(path, windowsFilesystem);
  if (windowsFilesystem) {
    try {
      windowsFilesystem.createFile(path, Buffer.from(BACKEND_RETIREMENT_CONTENT, "utf8"));
      return true;
    } catch (error) {
      if (!isWindowsFilesystemAlreadyExists(error)) throw error;
      await readBackendRetirementFileEventually(path, windowsFilesystem);
      return false;
    }
  }
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    .catch(async (error) => {
      if (error.code !== "EEXIST") throw error;
      await readBackendRetirementFileEventually(path, windowsFilesystem);
      return null;
    });
  if (!handle) return false;
  try {
    await handle.writeFile(BACKEND_RETIREMENT_CONTENT, "utf8");
    await handle.sync();
    assertOwnedRegularControlFile(await handle.stat(), Buffer.byteLength(BACKEND_RETIREMENT_CONTENT));
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
  return true;
}

async function readOptionalSecret(path, windowsFilesystemAdapter = null) {
  try {
    return { state: "present", ...(await readSecretFileEventually(path, windowsFilesystemAdapter)) };
  } catch (error) {
    if (isWindowsFilesystemNotFound(error)) return { state: "missing", secret: null, identity: null };
    throw error;
  }
}

async function readRetiredSecretResidue(path, windowsFilesystemAdapter = null) {
  try {
    return { state: "retired_retained", ...(await readSecretFileEventually(path, windowsFilesystemAdapter)) };
  } catch (error) {
    if (isWindowsFilesystemNotFound(error)) return { state: "retired_removed", secret: null, identity: null };
    try {
      await lstat(path);
      return { state: "retired_retained_unverified", secret: null, identity: null };
    } catch (statError) {
      if (statError.code === "ENOENT") return { state: "retired_removed", secret: null, identity: null };
      throw error;
    }
  }
}

async function retirementState(path, windowsFilesystemAdapter = null) {
  try {
    await readLegacyRetirementFileEventually(path, windowsFilesystemAdapter);
    return true;
  } catch (error) {
    if (isWindowsFilesystemNotFound(error)) return false;
    throw error;
  }
}

async function backendRetirementState(path, windowsFilesystemAdapter = null) {
  try {
    await readBackendRetirementFileEventually(path, windowsFilesystemAdapter);
    return true;
  } catch (error) {
    if (isWindowsFilesystemNotFound(error)) return false;
    throw error;
  }
}

function assertParticipantSecretBackend(backend, capability) {
  let valid = capability !== undefined && capability !== null;
  try {
    valid = valid && backend !== null && typeof backend === "object"
      && typeof backend.read === "function"
      && typeof backend.createIfMissing === "function"
      && typeof backend.replaceExact === "function"
      && typeof backend.deleteExact === "function"
      && typeof backend.describe === "function";
  } catch {
    valid = false;
  }
  if (!valid) {
    const error = new Error("Participant identity backend configuration is invalid");
    error.code = "EXPORT_IDENTITY_BACKEND_INVALID";
    throw error;
  }
}

function copyBackendSecret(secret) {
  if (!Buffer.isBuffer(secret) || secret.byteLength !== SECRET_BYTES) {
    if (Buffer.isBuffer(secret)) secret.fill(0);
    const error = new Error("Participant identity backend returned an invalid value");
    error.code = "EXPORT_IDENTITY_BACKEND_INVALID_VALUE";
    throw error;
  }
  return Buffer.from(secret);
}

const SAFE_INJECTED_BACKEND_ERROR_CODES = new Set([
  "export_identity_keychain_unsupported_platform",
  "export_identity_keychain_unsupported_architecture",
  "export_identity_keychain_invalid_configuration",
  "export_identity_keychain_binding_unavailable",
  "export_identity_keychain_binding_integrity",
  "export_identity_keychain_invalid_capability",
  "export_identity_keychain_invalid_secret",
  "export_identity_keychain_stored_value_invalid",
  "export_identity_keychain_operation_failed",
  "export_identity_keychain_locked",
  "export_identity_keychain_denied",
  "export_identity_keychain_readback_mismatch",
]);

async function invokeParticipantSecretBackend(backend, method, ...args) {
  try {
    return await backend[method](...args);
  } catch (upstream) {
    let upstreamCode;
    try {
      upstreamCode = upstream?.code;
    } catch {
      // Hostile errors are deliberately collapsed below.
    }
    const error = new Error("Participant identity backend operation failed");
    error.code = SAFE_INJECTED_BACKEND_ERROR_CODES.has(upstreamCode)
      ? upstreamCode
      : "EXPORT_IDENTITY_BACKEND_OPERATION_FAILED";
    throw error;
  }
}

async function readBackendSecret(backend, capability) {
  const value = await invokeParticipantSecretBackend(backend, "read", capability);
  try {
    return value === null ? null : copyBackendSecret(value);
  } finally {
    if (Buffer.isBuffer(value)) value.fill(0);
  }
}

async function describeBackend(backend, capability) {
  const description = await invokeParticipantSecretBackend(backend, "describe", capability);
  let backendName;
  let status;
  try {
    backendName = description?.backend;
    status = description?.status;
  } catch {
    // Hostile descriptions are rejected using the same fixed diagnostic.
  }
  if (!description || typeof description !== "object" || Array.isArray(description)
      || typeof backendName !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(backendName)
      || !["available", "locked", "denied", "unavailable"].includes(status)) {
    const error = new Error("Participant identity backend description is invalid");
    error.code = "EXPORT_IDENTITY_BACKEND_INVALID_DESCRIPTION";
    throw error;
  }
  return Object.freeze({ backend: backendName, status });
}

async function inspectBackendParticipantSecretInternal({
  participantSecretBackend,
  participantSecretCapability,
  secretFile,
  legacySecretFile = null,
  windowsFilesystemAdapter = null,
}) {
  assertParticipantSecretBackend(participantSecretBackend, participantSecretCapability);
  const path = resolve(secretFile);
  const legacyPath = legacySecretFile && resolve(legacySecretFile) !== path ? resolve(legacySecretFile) : null;
  const retirementPath = backendRetirementFileFor(path);
  const [backendDescription, backendSecret, retired, legacyRetired] = await Promise.all([
    describeBackend(participantSecretBackend, participantSecretCapability),
    readBackendSecret(participantSecretBackend, participantSecretCapability),
    backendRetirementState(retirementPath, windowsFilesystemAdapter),
    legacyPath ? retirementState(retirementFileFor(path), windowsFilesystemAdapter) : false,
  ]);
  const ownerFile = retired
    ? await readRetiredSecretResidue(path, windowsFilesystemAdapter)
    : await readOptionalSecret(path, windowsFilesystemAdapter);
  const legacyFile = retired || legacyRetired
    ? legacyPath
      ? await readRetiredSecretResidue(legacyPath, windowsFilesystemAdapter)
      : { state: "disabled", secret: null, identity: null }
    : legacyPath
      ? await readOptionalSecret(legacyPath, windowsFilesystemAdapter)
      : { state: "disabled", secret: null, identity: null };
  const presentSecrets = [
    backendSecret,
    ownerFile.state === "present" ? ownerFile.secret : null,
    legacyFile.state === "present" ? legacyFile.secret : null,
  ].filter((value) => value !== null);
  const conflict = presentSecrets.length > 1
    && presentSecrets.slice(1).some((secret) => !secretsEqual(presentSecrets[0], secret));
  const selectedFile = ownerFile.state === "present" ? ownerFile : legacyFile.state === "present" ? legacyFile : null;
  const selectedSecret = backendSecret ?? selectedFile?.secret ?? null;
  return {
    status: conflict ? "conflict" : selectedSecret ? "ready" : "missing",
    secret: conflict ? null : selectedSecret,
    source: conflict
      ? null
      : backendSecret !== null
        ? "secret_backend"
        : ownerFile.state === "present"
          ? "owner_only_file"
          : legacyFile.state === "present"
            ? "legacy_owner_only_file"
            : null,
    backend: backendDescription,
    backendState: backendSecret === null ? "missing" : "present",
    ownerFileState: ownerFile.state,
    ownerFileIdentity: ownerFile.identity,
    ownerFileRetired: retired,
    legacyState: legacyFile.state,
    legacyIdentity: legacyFile.identity,
    legacyRetired: retired || legacyRetired,
    conflict,
    wouldCreate: !conflict && selectedSecret === null,
    wouldMigrate: !conflict && backendSecret === null && selectedFile !== null,
    rotatable: !conflict && backendSecret !== null,
    path,
    legacyPath,
  };
}

async function inspectParticipantSecretInternal({
  environmentSecret = process.env.APP_USAGEMONITOR_EXPORT_SECRET,
  secretFile = defaultExportSecretFile(),
  legacySecretFile = secretFile === defaultExportSecretFile() ? legacyWorkingDirectorySecretFile() : null,
  windowsFilesystemAdapter = null,
} = {}) {
  const path = resolve(secretFile);
  const legacyPath = legacySecretFile && resolve(legacySecretFile) !== path ? resolve(legacySecretFile) : null;

  if (environmentSecret) {
    return {
      status: "ready",
      secret: decodeSecret(environmentSecret),
      source: "environment",
      canonicalState: "not_checked",
      legacyState: "not_checked",
      legacyRetired: false,
      conflict: false,
      wouldCreate: false,
      wouldMigrate: false,
      rotatable: false,
      path,
      legacyPath,
      canonicalIdentity: null,
    };
  }

  const canonical = await readOptionalSecret(path, windowsFilesystemAdapter);
  const retired = legacyPath ? await retirementState(retirementFileFor(path), windowsFilesystemAdapter) : false;
  const legacy = legacyPath && !retired
    ? await readOptionalSecret(legacyPath, windowsFilesystemAdapter)
    : { state: legacyPath && retired ? "retired" : "disabled", secret: null, identity: null };
  const conflict = canonical.state === "present" && legacy.state === "present"
    && !secretsEqual(canonical.secret, legacy.secret);

  if (conflict) {
    return {
      status: "conflict",
      secret: null,
      source: null,
      canonicalState: canonical.state,
      legacyState: legacy.state,
      legacyRetired: false,
      conflict: true,
      wouldCreate: false,
      wouldMigrate: false,
      rotatable: false,
      path,
      legacyPath,
      canonicalIdentity: canonical.identity,
    };
  }

  const selected = canonical.state === "present" ? canonical : legacy.state === "present" ? legacy : null;
  return {
    status: selected ? "ready" : "missing",
    secret: selected?.secret ?? null,
    source: canonical.state === "present" ? "owner_only_file" : legacy.state === "present" ? "legacy_owner_only_file" : null,
    canonicalState: canonical.state,
    legacyState: legacy.state,
    legacyRetired: retired,
    conflict: false,
    wouldCreate: !selected,
    wouldMigrate: canonical.state === "missing" && legacy.state === "present",
    rotatable: canonical.state === "present",
    path,
    legacyPath,
    canonicalIdentity: canonical.identity,
  };
}

/** Inspect identity state without creating, migrating, retiring, or rotating any file. */
export async function inspectParticipantSecret(options = {}) {
  const environmentSecret = Object.hasOwn(options, "environmentSecret")
    ? options.environmentSecret
    : process.env.APP_USAGEMONITOR_EXPORT_SECRET;
  const windowsFilesystemAdapter = environmentSecret
    ? null
    : resolveWindowsFilesystemAdapter(options.windowsFilesystemAdapter);
  const useBackend = options.participantSecretBackend !== undefined && options.participantSecretBackend !== null;
  const result = useBackend && !environmentSecret
    ? await inspectBackendParticipantSecretInternal({
      participantSecretBackend: options.participantSecretBackend,
      participantSecretCapability: options.participantSecretCapability,
      secretFile: options.secretFile ?? defaultExportSecretFile(),
      legacySecretFile: Object.hasOwn(options, "legacySecretFile")
        ? options.legacySecretFile
      : (options.secretFile ?? defaultExportSecretFile()) === defaultExportSecretFile()
          ? legacyWorkingDirectorySecretFile()
          : null,
      windowsFilesystemAdapter,
    })
    : await inspectParticipantSecretInternal({ ...options, windowsFilesystemAdapter });
  const {
    canonicalIdentity: _canonicalIdentity,
    ownerFileIdentity: _ownerFileIdentity,
    legacyIdentity: _legacyIdentity,
    secret: _secret,
    path: _path,
    legacyPath: _legacyPath,
    ...inspection
  } = result;
  return inspection;
}

function identityConflictError() {
  const error = new Error("Participant identity sources contain different secrets");
  error.code = "EXPORT_IDENTITY_CONFLICT";
  return error;
}

function backendMutationError(code) {
  const error = new Error("Participant identity backend transaction failed");
  error.code = code;
  return error;
}

async function revalidateBackendMigrationFiles(inspection, windowsFilesystemAdapter = null) {
  for (const [state, path, identity, expected] of [
    [inspection.ownerFileState, inspection.path, inspection.ownerFileIdentity, inspection.secret],
    [inspection.legacyState, inspection.legacyPath, inspection.legacyIdentity, inspection.secret],
  ]) {
    if (state !== "present") continue;
    const current = await readSecretFileWithIdentity(path, windowsFilesystemAdapter);
    if (!sameFileIdentity(identity, current.identity) || !secretsEqual(expected, current.secret)) {
      current.secret.fill(0);
      const error = new Error("Participant identity file changed during backend migration");
      error.code = "EXPORT_IDENTITY_MIGRATION_RACE";
      throw error;
    }
    current.secret.fill(0);
  }
}

function isRetiredResidueState(state) {
  return state === "present" || state === "retired_retained" || state === "retired_retained_unverified";
}

async function removeExactRetiredSecret(
  path,
  identity,
  expectedSecret,
  migrationHook,
  label,
  windowsFilesystemAdapter = null,
) {
  if (!path || !identity) return "retained_unverified";
  await migrationHook?.(`before-${label}-secret-removal`);
  let opened;
  try {
    opened = await readSecretFileWithIdentity(path, windowsFilesystemAdapter);
  } catch (error) {
    if (isWindowsFilesystemNotFound(error)) return "removed";
    return "retained_unverified";
  }
  try {
    if (!sameFileIdentity(identity, opened.identity) || !secretsEqual(expectedSecret, opened.secret)) {
      return "retained_changed";
    }
    const windowsFilesystem = resolveWindowsFilesystemAdapter(windowsFilesystemAdapter);
    if (windowsFilesystem) {
      try {
        windowsFilesystem.deleteFile(path, opened.identity);
        return "removed";
      } catch (error) {
        if (isWindowsFilesystemNotFound(error)) return "removed";
        if (error?.code === "WINDOWS_FILESYSTEM_IDENTITY_MISMATCH") return "retained_changed";
        return "retained_unverified";
      }
    }
    const current = await lstat(path).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current === null) return "removed";
    if (!sameFileIdentity(opened.identity, current)) return "retained_changed";
    await unlink(path);
    await syncDirectory(dirname(path));
    return "removed";
  } finally {
    opened.secret.fill(0);
  }
}

async function cleanupRetiredBackendFiles(
  inspection,
  expectedSecret,
  migrationHook = null,
  windowsFilesystemAdapter = null,
) {
  const states = {};
  for (const [label, state, path, identity] of [
    ["owner", inspection.ownerFileState, inspection.path, inspection.ownerFileIdentity],
    ["legacy", inspection.legacyState, inspection.legacyPath, inspection.legacyIdentity],
  ]) {
    if (!path || state === "disabled") {
      states[label] = "not_applicable";
    } else if (state === "missing" || state === "retired_removed") {
      states[label] = "already_absent";
    } else if (isRetiredResidueState(state)) {
      states[label] = await removeExactRetiredSecret(
        path,
        identity,
        expectedSecret,
        migrationHook,
        label,
        windowsFilesystemAdapter,
      );
    } else {
      states[label] = "retained_unverified";
    }
  }
  return {
    ownerFileCleanup: states.owner,
    legacyFileCleanup: states.legacy,
    secretFilesRemoved: [states.owner, states.legacy].filter((state) => state === "removed").length,
    secretFilesRetained: [states.owner, states.legacy].filter((state) => state.startsWith("retained_")).length,
  };
}

async function loadOrCreateBackendParticipantSecretUnderLease({
  participantSecretBackend,
  participantSecretCapability,
  secretFile,
  legacySecretFile,
  migrationHook = null,
  windowsFilesystemAdapter = null,
}) {
  const inspection = await inspectBackendParticipantSecretInternal({
    participantSecretBackend,
    participantSecretCapability,
    secretFile,
    legacySecretFile,
    windowsFilesystemAdapter,
  });
  if (inspection.conflict) throw identityConflictError();
  const retirementPath = backendRetirementFileFor(inspection.path);

  if (inspection.backendState === "present") {
    await revalidateBackendMigrationFiles(inspection, windowsFilesystemAdapter);
    await ensureBackendRetired(retirementPath, windowsFilesystemAdapter);
    if (inspection.legacyPath) await ensureLegacyRetired(retirementFileFor(inspection.path), windowsFilesystemAdapter);
    await migrationHook?.("after-retirement-before-cleanup");
    const cleanup = await cleanupRetiredBackendFiles(
      inspection,
      inspection.secret,
      migrationHook,
      windowsFilesystemAdapter,
    );
    return {
      secret: Buffer.from(inspection.secret),
      source: "secret_backend",
      backend: inspection.backend,
      created: false,
      migrated: isRetiredResidueState(inspection.ownerFileState) || isRetiredResidueState(inspection.legacyState),
      ...cleanup,
    };
  }

  const candidate = inspection.source === "owner_only_file" || inspection.source === "legacy_owner_only_file"
    ? Buffer.from(inspection.secret)
    : randomBytes(SECRET_BYTES);
  const outcome = await invokeParticipantSecretBackend(
    participantSecretBackend,
    "createIfMissing",
    participantSecretCapability,
    candidate,
  );
  if (outcome !== "created" && outcome !== "existing") {
    candidate.fill(0);
    throw backendMutationError("EXPORT_IDENTITY_BACKEND_CREATE_FAILED");
  }
  const persisted = await readBackendSecret(participantSecretBackend, participantSecretCapability);
  if (persisted === null) {
    candidate.fill(0);
    throw backendMutationError("EXPORT_IDENTITY_BACKEND_READBACK_FAILED");
  }
  if ((inspection.source === "owner_only_file" || inspection.source === "legacy_owner_only_file")
      && !secretsEqual(candidate, persisted)) {
    candidate.fill(0);
    persisted.fill(0);
    throw identityConflictError();
  }
  if (outcome === "created" && !secretsEqual(candidate, persisted)) {
    candidate.fill(0);
    persisted.fill(0);
    throw backendMutationError("EXPORT_IDENTITY_BACKEND_READBACK_FAILED");
  }
  await revalidateBackendMigrationFiles(inspection, windowsFilesystemAdapter);
  await ensureBackendRetired(retirementPath, windowsFilesystemAdapter);
  if (inspection.legacyPath) await ensureLegacyRetired(retirementFileFor(inspection.path), windowsFilesystemAdapter);
  await migrationHook?.("after-retirement-before-cleanup");
  const cleanup = await cleanupRetiredBackendFiles(
    inspection,
    persisted,
    migrationHook,
    windowsFilesystemAdapter,
  );
  const result = {
    secret: Buffer.from(persisted),
    source: "secret_backend",
    backend: inspection.backend,
    created: inspection.source === null && outcome === "created",
    migrated: inspection.source === "owner_only_file" || inspection.source === "legacy_owner_only_file",
    ...cleanup,
  };
  candidate.fill(0);
  persisted.fill(0);
  return result;
}

export async function loadOrCreateParticipantSecret({
  environmentSecret = process.env.APP_USAGEMONITOR_EXPORT_SECRET,
  secretFile = defaultExportSecretFile(),
  legacySecretFile = secretFile === defaultExportSecretFile() ? legacyWorkingDirectorySecretFile() : null,
  participantSecretBackend = null,
  participantSecretCapability = null,
  migrationHook = null,
  windowsFilesystemAdapter = null,
} = {}) {
  const windowsFilesystem = environmentSecret
    ? null
    : resolveWindowsFilesystemAdapter(windowsFilesystemAdapter);
  if (!environmentSecret && participantSecretBackend !== null) {
    assertParticipantSecretBackend(participantSecretBackend, participantSecretCapability);
    const path = resolve(secretFile);
    await prepareSecretDirectory(path, windowsFilesystem);
    const lockPath = `${path}.rotation-lock`;
    const lock = await acquireRotationLock(lockPath, windowsFilesystem);
    try {
      return await loadOrCreateBackendParticipantSecretUnderLease({
        participantSecretBackend,
        participantSecretCapability,
        secretFile: path,
        legacySecretFile,
        migrationHook,
        windowsFilesystemAdapter: windowsFilesystem,
      });
    } finally {
      await releaseRotationLock(lockPath, lock, windowsFilesystem);
    }
  }
  const inspection = await inspectParticipantSecretInternal({
    environmentSecret,
    secretFile,
    legacySecretFile,
    windowsFilesystemAdapter: windowsFilesystem,
  });
  if (inspection.source === "environment") return { secret: inspection.secret, source: "environment", created: false, migrated: false };
  if (inspection.conflict) throw identityConflictError();

  const path = resolve(secretFile);
  const legacyPath = legacySecretFile && resolve(legacySecretFile) !== path ? resolve(legacySecretFile) : null;
  const retirementPath = legacyPath ? retirementFileFor(path) : null;
  if (inspection.source === "owner_only_file") {
    if (retirementPath && !inspection.legacyRetired) {
      await ensureLegacyRetired(retirementPath, windowsFilesystem);
    }
    return { secret: inspection.secret, source: "owner_only_file", created: false, migrated: false };
  }

  if (inspection.source === "legacy_owner_only_file") {
    try {
      await writeNewSecret(path, encodeParticipantSecret(inspection.secret), windowsFilesystem);
    } catch (error) {
      if (!isWindowsFilesystemAlreadyExists(error)) throw error;
    }
    const canonicalSecret = (await readSecretFileEventually(path, windowsFilesystem)).secret;
    if (!secretsEqual(canonicalSecret, inspection.secret)) throw identityConflictError();
    await ensureLegacyRetired(retirementPath, windowsFilesystem);
    return { secret: canonicalSecret, source: "owner_only_file", created: false, migrated: true };
  }

  const secret = randomBytes(SECRET_BYTES);
  const encoded = encodeParticipantSecret(secret);
  try {
    await writeNewSecret(path, encoded, windowsFilesystem);
    if (retirementPath) await ensureLegacyRetired(retirementPath, windowsFilesystem);
    return { secret, source: "owner_only_file", created: true, migrated: false };
  } catch (error) {
    if (!isWindowsFilesystemAlreadyExists(error)) throw error;
    const concurrent = await inspectParticipantSecretInternal({
      environmentSecret: null,
      secretFile: path,
      legacySecretFile: legacyPath,
      windowsFilesystemAdapter: windowsFilesystem,
    });
    if (concurrent.conflict) throw identityConflictError();
    if (concurrent.source !== "owner_only_file") throw new Error("Participant secret was not available after concurrent creation");
    if (retirementPath && !concurrent.legacyRetired) {
      await ensureLegacyRetired(retirementPath, windowsFilesystem);
    }
    return { secret: concurrent.secret, source: "owner_only_file", created: false, migrated: false };
  }
}

async function acquireRotationLock(path, windowsFilesystemAdapter = null) {
  const windowsFilesystem = resolveWindowsFilesystemAdapter(windowsFilesystemAdapter);
  if (windowsFilesystem) {
    await prepareSecretDirectory(path, windowsFilesystem);
    try {
      const identity = windowsFilesystem.createFile(
        path,
        Buffer.from("app-usagemonitor identity operation lock v1\n", "utf8"),
      );
      return { handle: null, identity, windowsFilesystem };
    } catch (error) {
      if (isWindowsFilesystemAlreadyExists(error)) {
        const locked = new Error("A participant identity operation is already in progress");
        locked.code = "EXPORT_IDENTITY_ROTATION_LOCKED";
        throw locked;
      }
      throw error;
    }
  }
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      const locked = new Error("A participant identity operation is already in progress");
      locked.code = "EXPORT_IDENTITY_ROTATION_LOCKED";
      throw locked;
    }
    throw error;
  }
  try {
    await handle.writeFile("app-usagemonitor identity operation lock v1\n", "utf8");
    await handle.sync();
    const identity = await handle.stat();
    await syncDirectory(dirname(path));
    return { handle, identity: { dev: identity.dev, ino: identity.ino } };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(path).catch((cleanupError) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

/**
 * Hold the same exclusive lease used by rotation for the complete export
 * callback, preventing an export that starts before rotation from publishing
 * after rotation completes under the retired identity.
 */
export async function withParticipantSecretLease({
  environmentSecret = process.env.APP_USAGEMONITOR_EXPORT_SECRET,
  secretFile = defaultExportSecretFile(),
  legacySecretFile = secretFile === defaultExportSecretFile() ? legacyWorkingDirectorySecretFile() : null,
  participantSecretBackend = null,
  participantSecretCapability = null,
  windowsFilesystemAdapter = null,
} = {}, callback) {
  if (typeof callback !== "function") throw new TypeError("Participant identity lease requires a callback");
  if (environmentSecret) {
    const identity = await loadOrCreateParticipantSecret({ environmentSecret, secretFile, legacySecretFile });
    return callback(identity);
  }
  const windowsFilesystem = resolveWindowsFilesystemAdapter(windowsFilesystemAdapter);
  const path = resolve(secretFile);
  await prepareSecretDirectory(path, windowsFilesystem);
  const lockPath = `${path}.rotation-lock`;
  const lock = await acquireRotationLock(lockPath, windowsFilesystem);
  try {
    const identity = participantSecretBackend !== null
      ? await loadOrCreateBackendParticipantSecretUnderLease({
        participantSecretBackend,
        participantSecretCapability,
        secretFile: path,
        legacySecretFile,
        windowsFilesystemAdapter: windowsFilesystem,
      })
      : await loadOrCreateParticipantSecret({
        environmentSecret: null,
        secretFile: path,
        legacySecretFile,
        windowsFilesystemAdapter: windowsFilesystem,
      });
    return await callback(identity);
  } finally {
    await releaseRotationLock(lockPath, lock, windowsFilesystem);
  }
}

async function releaseRotationLock(path, lock, windowsFilesystemAdapter = null) {
  const lockLost = () => {
    const error = new Error("Participant identity operation lock was lost");
    error.code = "EXPORT_IDENTITY_ROTATION_LOCK_LOST";
    return error;
  };
  const windowsFilesystem = lock?.windowsFilesystem
    ?? resolveWindowsFilesystemAdapter(windowsFilesystemAdapter);
  if (windowsFilesystem) {
    try {
      windowsFilesystem.deleteFile(path, lock.identity);
    } catch (error) {
      if (isWindowsFilesystemNotFound(error)
          || error?.code === "WINDOWS_FILESYSTEM_IDENTITY_MISMATCH") {
        throw lockLost();
      }
      throw error;
    }
    return;
  }
  await lock.handle.close();
  try {
    const current = await lstat(path);
    if (!sameFileIdentity(lock.identity, current)) throw lockLost();
    await unlink(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if (error.code === "ENOENT") throw lockLost();
    throw error;
  }
}

async function rotationCheckpoint(rotationHook, failpoint, point) {
  if (rotationHook) await rotationHook(point);
  if (failpoint === point) {
    const error = new Error(`Participant secret rotation failpoint: ${point}`);
    error.code = "EXPORT_IDENTITY_ROTATION_FAILPOINT";
    throw error;
  }
}

async function rotateBackendParticipantSecret({
  participantSecretBackend,
  participantSecretCapability,
  secretFile,
  legacySecretFile,
  rotationHook,
  failpoint,
  windowsFilesystemAdapter = null,
}) {
  assertParticipantSecretBackend(participantSecretBackend, participantSecretCapability);
  const path = resolve(secretFile);
  const initial = await inspectBackendParticipantSecretInternal({
    participantSecretBackend,
    participantSecretCapability,
    secretFile: path,
    legacySecretFile,
    windowsFilesystemAdapter,
  });
  if (initial.conflict) throw identityConflictError();
  if (initial.backendState !== "present") {
    const error = new Error("A backend participant secret must exist before rotation");
    error.code = "EXPORT_IDENTITY_ROTATION_NOT_READY";
    throw error;
  }

  await prepareSecretDirectory(path, windowsFilesystemAdapter);
  const lockPath = `${path}.rotation-lock`;
  const lock = await acquireRotationLock(lockPath, windowsFilesystemAdapter);
  const expected = Buffer.from(initial.secret);
  let replacement = null;
  let readback = null;
  try {
    const current = await inspectBackendParticipantSecretInternal({
      participantSecretBackend,
      participantSecretCapability,
      secretFile: path,
      legacySecretFile,
      windowsFilesystemAdapter,
    });
    if (current.conflict) throw identityConflictError();
    if (current.backendState !== "present" || !secretsEqual(current.secret, expected)) {
      const error = new Error("Participant secret changed before rotation acquired its lock");
      error.code = "EXPORT_IDENTITY_ROTATION_RACE";
      throw error;
    }
    await revalidateBackendMigrationFiles(current, windowsFilesystemAdapter);
    await ensureBackendRetired(backendRetirementFileFor(path), windowsFilesystemAdapter);
    if (current.legacyPath) await ensureLegacyRetired(retirementFileFor(path), windowsFilesystemAdapter);
    const cleanup = await cleanupRetiredBackendFiles(
      current,
      current.secret,
      rotationHook,
      windowsFilesystemAdapter,
    );
    replacement = randomBytes(SECRET_BYTES);
    await rotationCheckpoint(rotationHook, failpoint, "before-backend-replace");
    const outcome = await invokeParticipantSecretBackend(
      participantSecretBackend,
      "replaceExact",
      participantSecretCapability,
      expected,
      replacement,
    );
    if (outcome !== "replaced") {
      const error = new Error("Participant secret changed during rotation");
      error.code = "EXPORT_IDENTITY_ROTATION_RACE";
      throw error;
    }
    await rotationCheckpoint(rotationHook, failpoint, "after-backend-replace");
    readback = await readBackendSecret(participantSecretBackend, participantSecretCapability);
    if (readback === null || !secretsEqual(readback, replacement)) {
      throw backendMutationError("EXPORT_IDENTITY_BACKEND_READBACK_FAILED");
    }
    return {
      secret: Buffer.from(readback),
      source: "secret_backend",
      backend: current.backend,
      rotated: true,
      pseudonymsChanged: true,
      ownerFileRetired: true,
      ...cleanup,
      secureErasure: false,
    };
  } finally {
    expected.fill(0);
    replacement?.fill(0);
    readback?.fill(0);
    await releaseRotationLock(lockPath, lock, windowsFilesystemAdapter);
  }
}

/**
 * Replace a canonical file-backed identity. The atomic replacement does not and
 * cannot promise secure erasure of old bytes from storage or existing handles.
 */
export async function rotateParticipantSecret({
  confirmRotation = false,
  environmentSecret = process.env.APP_USAGEMONITOR_EXPORT_SECRET,
  secretFile = defaultExportSecretFile(),
  legacySecretFile = secretFile === defaultExportSecretFile() ? legacyWorkingDirectorySecretFile() : null,
  participantSecretBackend = null,
  participantSecretCapability = null,
  rotationHook = null,
  failpoint = null,
  windowsFilesystemAdapter = null,
} = {}) {
  if (confirmRotation !== true) throw new Error(ROTATION_CONFIRMATION_ERROR);
  if (environmentSecret) {
    const error = new Error("Environment-provided participant secrets cannot be rotated by this function");
    error.code = "EXPORT_IDENTITY_ENVIRONMENT_ROTATION_REFUSED";
    throw error;
  }
  if (participantSecretBackend !== null) {
    return rotateBackendParticipantSecret({
      participantSecretBackend,
      participantSecretCapability,
      secretFile,
      legacySecretFile,
      rotationHook,
      failpoint,
      windowsFilesystemAdapter: resolveWindowsFilesystemAdapter(windowsFilesystemAdapter),
    });
  }

  const windowsFilesystem = resolveWindowsFilesystemAdapter(windowsFilesystemAdapter);
  if (windowsFilesystem) {
    const error = new Error("Windows participant identity rotation replacement is not yet available");
    error.code = "EXPORT_IDENTITY_WINDOWS_ROTATION_REPLACEMENT_UNAVAILABLE";
    throw error;
  }

  const path = resolve(secretFile);
  const legacyPath = legacySecretFile && resolve(legacySecretFile) !== path ? resolve(legacySecretFile) : null;
  const lockPath = `${path}.rotation-lock`;
  const initial = await inspectParticipantSecretInternal({ environmentSecret: null, secretFile: path, legacySecretFile: legacyPath });
  if (initial.conflict) throw identityConflictError();
  if (initial.source !== "owner_only_file") {
    const error = new Error("A canonical file-backed participant secret must exist before rotation");
    error.code = "EXPORT_IDENTITY_ROTATION_NOT_READY";
    throw error;
  }

  const lock = await acquireRotationLock(lockPath, windowsFilesystem);
  let stagedPath = null;
  const oldSecret = initial.secret;
  let lockedOldSecret = null;
  let verifiedOldSecret = null;
  let generatedSecret = null;
  try {
    const current = await inspectParticipantSecretInternal({ environmentSecret: null, secretFile: path, legacySecretFile: legacyPath });
    lockedOldSecret = current.secret;
    if (current.conflict) throw identityConflictError();
    if (current.source !== "owner_only_file" || !sameFileIdentity(initial.canonicalIdentity, current.canonicalIdentity)
        || !secretsEqual(initial.secret, current.secret)) {
      const error = new Error("Participant secret changed before rotation acquired its lock");
      error.code = "EXPORT_IDENTITY_ROTATION_RACE";
      throw error;
    }

    if (legacyPath && !current.legacyRetired) await ensureLegacyRetired(retirementFileFor(path));
    generatedSecret = randomBytes(SECRET_BYTES);
    stagedPath = `${path}.rotation-${process.pid}-${randomBytes(12).toString("hex")}.tmp`;
    await writeNewSecret(stagedPath, encodeParticipantSecret(generatedSecret));
    await rotationCheckpoint(rotationHook, failpoint, "after-stage-sync");

    const beforeRename = await readSecretFileWithIdentity(path);
    verifiedOldSecret = beforeRename.secret;
    if (!sameFileIdentity(current.canonicalIdentity, beforeRename.identity)
        || !secretsEqual(current.secret, beforeRename.secret)) {
      const error = new Error("Participant secret changed during rotation");
      error.code = "EXPORT_IDENTITY_ROTATION_RACE";
      throw error;
    }

    await rename(stagedPath, path);
    stagedPath = null;
    await rotationCheckpoint(rotationHook, failpoint, "after-rename");
    await syncDirectory(dirname(path));
    await rotationCheckpoint(rotationHook, failpoint, "after-directory-sync");

    const persisted = await readSecretFile(path);
    if (!secretsEqual(generatedSecret, persisted)) throw new Error("Rotated participant secret did not persist correctly");
    return {
      secret: persisted,
      source: "owner_only_file",
      rotated: true,
      legacyRetired: Boolean(legacyPath),
      secureErasure: false,
    };
  } finally {
    oldSecret.fill(0);
    lockedOldSecret?.fill(0);
    verifiedOldSecret?.fill(0);
    generatedSecret?.fill(0);
    try {
      if (stagedPath) {
        try {
          await unlink(stagedPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    } finally {
      await releaseRotationLock(lockPath, lock);
    }
  }
}

export { deriveExportPseudonym, deriveExportPseudonymV2 };

export function deriveParticipantId(secret) {
  return deriveExportPseudonym(secret, "participant", "self");
}

export function deriveSessionScopeId(secret, rawSessionSubject) {
  return deriveExportPseudonym(secret, "session", rawSessionSubject);
}

export function deriveEventId(secret, canonicalSubject) {
  return deriveExportPseudonym(secret, "event", canonicalSubject);
}

export function deriveEventOccurrenceId(secret, canonicalSourceLocator) {
  return deriveExportPseudonymV2(secret, "event", canonicalSourceLocator);
}

export function deriveSnapshotId(secret, canonicalSubject) {
  return deriveExportPseudonym(secret, "snapshot", canonicalSubject);
}

export function deriveSnapshotObservationId(secret, canonicalSourceLocator) {
  return deriveExportPseudonymV2(secret, "snapshot", canonicalSourceLocator);
}

export function deriveQuotaStateId(secret, canonicalProviderState) {
  return deriveExportPseudonym(secret, "quota-state", canonicalProviderState);
}

export function deriveMarkerId(secret, canonicalSubject) {
  return deriveExportPseudonym(secret, "marker", canonicalSubject);
}

export function deriveMarkerOccurrenceId(secret, rawMarkerId) {
  return deriveExportPseudonymV2(secret, "marker", rawMarkerId);
}

export function deriveAccountScopeId(secret, rawAccountScope) {
  if (rawAccountScope === null || rawAccountScope === undefined || rawAccountScope === "unattributed") return "unattributed";
  return deriveExportPseudonym(secret, "account", String(rawAccountScope));
}

export function deriveModelFingerprint(secret, rawModelId) {
  return deriveExportPseudonym(secret, "model", rawModelId);
}

export function randomBundleId() {
  return `bundle:v1:${randomBytes(SECRET_BYTES).toString("hex")}`;
}
