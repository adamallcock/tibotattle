import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { defaultExportStateDirectory } from "./export-identity.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  createExportIdentityKeychainBackend,
} from "./export-identity-keychain.js";
import {
  assertWindowsFilesystemProductionSafe,
  assertWindowsProductionReadiness,
  createWindowsProductionCapabilityBackend,
  isWindowsFilesystemAdapter,
  isWindowsFilesystemIdentity,
} from "./platform/index.js";

const SECRET_BYTES = 32;
const MAXIMUM_STATE_BYTES = 512;
const STATE_SCHEMA_VERSION = "contribution-device-binding-v1";
const HASH_DOMAIN = "app-usagemonitor/device/v1\0";
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice;

const ERROR_CODES = new Set([
  "invalid_configuration",
  "origin_invalid",
  "origin_conflict",
  "device_id_invalid",
  "credential_locked",
  "credential_denied",
  "credential_unavailable",
  "credential_missing",
  "credential_conflict",
  "state_unavailable",
  "state_invalid",
  "operation_failed",
  "callback_result_invalid",
  "remote_revocation_required",
  "confirmation_invalid",
]);

const WINDOWS_PRODUCTION_BACKENDS = new WeakSet();
const WINDOWS_STATE_FILESYSTEM_ADAPTERS = new WeakMap();

export class ContributionDeviceCapabilityError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) throw new TypeError("Unknown contribution device capability error code");
    super("Contribution device capability operation failed");
    this.name = "ContributionDeviceCapabilityError";
    this.code = `contribution_device_${code}`;
  }
}

function fail(code) {
  throw new ContributionDeviceCapabilityError(code);
}

function assertBackend(backend) {
  let valid = false;
  try {
    valid = backend !== null && typeof backend === "object"
      && typeof backend.read === "function"
      && typeof backend.createIfMissing === "function"
      && typeof backend.deleteExact === "function";
  } catch {
    // Collapse hostile injected backends to one fixed configuration error.
  }
  if (!valid) fail("invalid_configuration");
  return backend;
}

function translateBackendFailure(error) {
  let code;
  try {
    code = error?.code;
  } catch {
    fail("credential_unavailable");
  }
  if (code === "export_identity_keychain_locked") fail("credential_locked");
  if (code === "export_identity_keychain_denied") fail("credential_denied");
  fail("credential_unavailable");
}

async function invokeBackend(backend, method, ...args) {
  try {
    return await backend[method](CAPABILITY, ...args);
  } catch (error) {
    if (error instanceof ContributionDeviceCapabilityError) throw error;
    translateBackendFailure(error);
  }
}

function copySecret(value) {
  if (!Buffer.isBuffer(value) || value.byteLength !== SECRET_BYTES) {
    if (Buffer.isBuffer(value)) value.fill(0);
    fail("credential_unavailable");
  }
  return Buffer.from(value);
}

function normalizeDeviceId(value) {
  if (typeof value !== "string" || !DEVICE_ID_PATTERN.test(value)) fail("device_id_invalid");
  return value;
}

function normalizeOrigin(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) fail("origin_invalid");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("origin_invalid");
  }
  const loopback = parsed.protocol === "http:"
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "localhost");
  if ((parsed.protocol !== "https:" && !loopback)
      || parsed.username !== "" || parsed.password !== ""
      || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== ""
      || parsed.origin === "null") {
    fail("origin_invalid");
  }
  return parsed.origin;
}

function canonicalState({ origin, deviceId, createdAt }) {
  return `${JSON.stringify({
    schemaVersion: STATE_SCHEMA_VERSION,
    origin,
    deviceId,
    createdAt,
  })}\n`;
}

function parseState(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1 || bytes.byteLength > MAXIMUM_STATE_BYTES) {
    fail("state_invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("state_invalid");
  }
  const keys = Object.keys(parsed ?? {}).sort().join("\0");
  const createdAtMs = Date.parse(parsed?.createdAt);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || keys !== "createdAt\0deviceId\0origin\0schemaVersion"
      || parsed.schemaVersion !== STATE_SCHEMA_VERSION
      || !Number.isFinite(createdAtMs)
      || new Date(createdAtMs).toISOString() !== parsed.createdAt) {
    fail("state_invalid");
  }
  const state = {
    origin: normalizeOrigin(parsed.origin),
    deviceId: normalizeDeviceId(parsed.deviceId),
    createdAt: parsed.createdAt,
  };
  if (canonicalState(state) !== bytes.toString("utf8")) fail("state_invalid");
  return Object.freeze(state);
}

function sameIdentity(left, right) {
  if (isWindowsFilesystemIdentity(left) && isWindowsFilesystemIdentity(right)) {
    return left.volumeSerialNumber === right.volumeSerialNumber
      && left.fileId === right.fileId;
  }
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function assertOwnerOnlyDirectory(stats) {
  if (!stats.isDirectory() || stats.isSymbolicLink()
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o022) !== 0)) {
    fail("state_unavailable");
  }
}

function assertOwnerOnlyState(stats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || stats.size < 1 || stats.size > MAXIMUM_STATE_BYTES
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600)) {
    fail("state_invalid");
  }
}

function assertWindowsStateDirectory(metadata, expectedIdentity = null) {
  if (metadata?.isDirectory !== true
      || metadata.isRegularFile !== false
      || metadata.isReparsePoint !== false
      || metadata.ownerMatches !== true
      || metadata.nullDacl !== false
      || metadata.daclProtected !== true
      || metadata.broadAccess !== false
      || metadata.nonOwnerAllow !== false
      || metadata.unrecognizedAce !== false
      || metadata.finalPathResolved !== true
      || !isWindowsFilesystemIdentity(metadata.identity)
      || metadata.identity.linkCount !== 1
      || (expectedIdentity !== null && !sameIdentity(metadata.identity, expectedIdentity))) {
    fail("state_unavailable");
  }
  return metadata.identity;
}

function assertWindowsStateFile(metadata) {
  if (metadata?.isDirectory !== false
      || metadata.isRegularFile !== true
      || metadata.isReparsePoint !== false
      || metadata.ownerMatches !== true
      || metadata.nullDacl !== false
      || metadata.daclProtected !== true
      || metadata.broadAccess !== false
      || metadata.nonOwnerAllow !== false
      || metadata.unrecognizedAce !== false
      || metadata.finalPathResolved !== true
      || !isWindowsFilesystemIdentity(metadata.identity)
      || metadata.identity.linkCount !== 1) {
    fail("state_invalid");
  }
  return metadata.identity;
}

function windowsFilesystemNotFound(error) {
  return error?.code === "ENOENT"
    || error?.code === "WINDOWS_FILESYSTEM_NOT_FOUND";
}

function windowsFilesystemAlreadyExists(error) {
  return error?.code === "EEXIST"
    || error?.code === "WINDOWS_FILESYSTEM_ALREADY_EXISTS";
}

function resolveWindowsStateFilesystem(backend, explicitAdapter = null) {
  const mappedAdapter = WINDOWS_STATE_FILESYSTEM_ADAPTERS.get(backend) ?? null;
  const selected = explicitAdapter ?? mappedAdapter;
  if (selected === null) {
    if (process.platform === "win32" || WINDOWS_PRODUCTION_BACKENDS.has(backend)) {
      fail("invalid_configuration");
    }
    return null;
  }
  if (process.platform !== "win32" || !isWindowsFilesystemAdapter(selected)) {
    fail("invalid_configuration");
  }
  try {
    return assertWindowsFilesystemProductionSafe(selected);
  } catch {
    fail("invalid_configuration");
  }
}

async function prepareStateDirectory(stateFile, windowsFilesystem = null) {
  if (typeof stateFile !== "string" || stateFile.length < 1 || stateFile.length > 4096) {
    fail("invalid_configuration");
  }
  const directory = dirname(stateFile);
  if (windowsFilesystem !== null) {
    try {
      const identity = windowsFilesystem.ensureDirectory(directory);
      const metadata = windowsFilesystem.inspectPath(directory);
      return {
        directory,
        identity: assertWindowsStateDirectory(metadata, identity),
        windowsFilesystem,
      };
    } catch (error) {
      if (error instanceof ContributionDeviceCapabilityError) throw error;
      fail("state_unavailable");
    }
  }
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const pathStats = await lstat(directory);
    assertOwnerOnlyDirectory(pathStats);
    const canonical = await realpath(directory);
    const canonicalStats = await lstat(canonical);
    assertOwnerOnlyDirectory(canonicalStats);
    if (!sameIdentity(pathStats, canonicalStats)) fail("state_unavailable");
    return canonical;
  } catch (error) {
    if (error instanceof ContributionDeviceCapabilityError) throw error;
    fail("state_unavailable");
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    await handle.sync();
  } catch {
    fail("state_unavailable");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function inspectState(stateFile, windowsFilesystem = null) {
  if (typeof stateFile !== "string" || stateFile.length < 1 || stateFile.length > 4096) {
    fail("invalid_configuration");
  }
  if (windowsFilesystem !== null) {
    const directory = dirname(stateFile);
    let directoryMetadata;
    try {
      directoryMetadata = windowsFilesystem.inspectPath(directory);
    } catch (error) {
      if (windowsFilesystemNotFound(error)) return null;
      fail("state_unavailable");
    }
    try {
      assertWindowsStateDirectory(directoryMetadata);
    } catch (error) {
      if (error instanceof ContributionDeviceCapabilityError) throw error;
      fail("state_unavailable");
    }
    const target = join(directory, basename(stateFile));
    let metadata;
    try {
      metadata = windowsFilesystem.inspectPath(target);
    } catch (error) {
      if (windowsFilesystemNotFound(error)) return null;
      fail("state_unavailable");
    }
    const identity = assertWindowsStateFile(metadata);
    let observed;
    try {
      observed = windowsFilesystem.readFile(target);
      if (!Buffer.isBuffer(observed?.data)
          || !isWindowsFilesystemIdentity(observed.identity)
          || observed.identity.linkCount !== 1
          || !sameIdentity(identity, observed.identity)) {
        fail("state_invalid");
      }
      return Object.freeze({
        state: parseState(observed.data),
        target,
        directory,
        identity,
        windowsFilesystem,
      });
    } catch (error) {
      if (error instanceof ContributionDeviceCapabilityError) throw error;
      fail("state_unavailable");
    } finally {
      observed?.data?.fill?.(0);
    }
  }
  let directory;
  try {
    directory = await realpath(dirname(stateFile));
    assertOwnerOnlyDirectory(await lstat(directory));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof ContributionDeviceCapabilityError) throw error;
    fail("state_unavailable");
  }
  const target = join(directory, basename(stateFile));
  let pathStats;
  try {
    pathStats = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("state_unavailable");
  }
  assertOwnerOnlyState(pathStats);
  let handle;
  let bytes = null;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    assertOwnerOnlyState(opened);
    if (!sameIdentity(pathStats, opened)) fail("state_invalid");
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameIdentity(opened, after) || after.nlink !== 1
        || after.size !== bytes.byteLength || after.mtimeMs !== opened.mtimeMs) {
      fail("state_invalid");
    }
    return Object.freeze({
      state: parseState(bytes),
      target,
      directory,
      identity: Object.freeze({ dev: opened.dev, ino: opened.ino }),
    });
  } catch (error) {
    if (error instanceof ContributionDeviceCapabilityError) throw error;
    fail("state_unavailable");
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => {});
  }
}

async function readState(stateFile, windowsFilesystem = null) {
  return (await inspectState(stateFile, windowsFilesystem))?.state ?? null;
}

async function writeNewState(stateFile, content, windowsFilesystem = null) {
  if (windowsFilesystem !== null) {
    const directoryState = await prepareStateDirectory(stateFile, windowsFilesystem);
    const { directory } = directoryState;
    const target = join(directory, basename(stateFile));
    const bytes = Buffer.from(content, "utf8");
    let identity = null;
    try {
      identity = windowsFilesystem.createFile(target, bytes);
      const metadata = windowsFilesystem.inspectPath(target);
      const publishedIdentity = assertWindowsStateFile(metadata);
      if (!sameIdentity(identity, publishedIdentity)) fail("state_unavailable");
      const observed = windowsFilesystem.readFile(target);
      try {
        if (!Buffer.isBuffer(observed?.data)
            || !isWindowsFilesystemIdentity(observed.identity)
            || observed.identity.linkCount !== 1
            || !sameIdentity(identity, observed.identity)
            || !observed.data.equals(bytes)) {
          fail("state_unavailable");
        }
      } finally {
        observed?.data?.fill?.(0);
      }
      return Object.freeze({
        target,
        directory,
        identity,
        windowsFilesystem,
      });
    } catch (error) {
      if (identity !== null) {
        try {
          const current = windowsFilesystem.inspectPath(target);
          if (sameIdentity(current?.identity, identity)) {
            windowsFilesystem.deleteFile(target, identity);
          }
        } catch (cleanupError) {
          if (!windowsFilesystemNotFound(cleanupError)) fail("state_unavailable");
        }
      }
      if (windowsFilesystemAlreadyExists(error)) fail("credential_conflict");
      if (error instanceof ContributionDeviceCapabilityError) throw error;
      fail("state_unavailable");
    } finally {
      bytes.fill(0);
    }
  }
  const directory = await prepareStateDirectory(stateFile);
  const target = join(directory, basename(stateFile));
  let handle;
  let identity = null;
  try {
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    const written = await handle.stat();
    assertOwnerOnlyState(written);
    if (written.size !== Buffer.byteLength(content)) fail("state_unavailable");
    identity = Object.freeze({ dev: written.dev, ino: written.ino });
    await handle.close();
    handle = null;
    const published = await lstat(target);
    assertOwnerOnlyState(published);
    if (!sameIdentity(identity, published)) fail("state_unavailable");
    await syncDirectory(directory);
    return Object.freeze({ target, directory, identity });
  } catch (error) {
    await handle?.close().catch(() => {});
    if (identity !== null) {
      try {
        const current = await lstat(target);
        if (sameIdentity(current, identity)) {
          assertOwnerOnlyState(current);
          await unlink(target);
          await syncDirectory(directory);
        }
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") fail("state_unavailable");
      }
    }
    if (error?.code === "EEXIST") fail("credential_conflict");
    if (error instanceof ContributionDeviceCapabilityError) throw error;
    fail("state_unavailable");
  }
}

async function removeCreatedState(publication) {
  if (publication.windowsFilesystem !== undefined) {
    try {
      const current = publication.windowsFilesystem.inspectPath(publication.target);
      if (!sameIdentity(current?.identity, publication.identity)) return;
      assertWindowsStateFile(current);
      publication.windowsFilesystem.deleteFile(publication.target, publication.identity);
    } catch (error) {
      if (!windowsFilesystemNotFound(error)) fail("state_unavailable");
    }
    return;
  }
  try {
    const current = await lstat(publication.target);
    if (!sameIdentity(current, publication.identity)) return;
    assertOwnerOnlyState(current);
    await unlink(publication.target);
    await syncDirectory(publication.directory);
  } catch (error) {
    if (error?.code !== "ENOENT") fail("state_unavailable");
  }
}

async function removeInspectedState(inspection) {
  if (inspection.windowsFilesystem !== undefined) {
    try {
      const current = inspection.windowsFilesystem.inspectPath(inspection.target);
      assertWindowsStateFile(current);
      if (!sameIdentity(current.identity, inspection.identity)) fail("state_invalid");
      inspection.windowsFilesystem.deleteFile(inspection.target, inspection.identity);
    } catch (error) {
      if (windowsFilesystemNotFound(error)) fail("state_invalid");
      if (error instanceof ContributionDeviceCapabilityError) throw error;
      fail("state_unavailable");
    }
    return;
  }
  try {
    const current = await lstat(inspection.target);
    assertOwnerOnlyState(current);
    if (!sameIdentity(current, inspection.identity)) fail("state_invalid");
    await unlink(inspection.target);
    await syncDirectory(inspection.directory);
  } catch (error) {
    if (error?.code === "ENOENT") fail("state_invalid");
    if (error instanceof ContributionDeviceCapabilityError) throw error;
    fail("state_unavailable");
  }
}

function hashSecret(deviceId, secret) {
  const selectedId = normalizeDeviceId(deviceId);
  let copied = null;
  try {
    copied = copySecret(secret);
    return createHash("sha256")
      .update(HASH_DOMAIN)
      .update(selectedId)
      .update("\0")
      .update(copied)
      .digest("hex");
  } finally {
    copied?.fill(0);
  }
}

function publicResult(status, state, secret) {
  return Object.freeze({
    status,
    origin: state.origin,
    deviceId: state.deviceId,
    createdAt: state.createdAt,
    deviceSecretHash: hashSecret(state.deviceId, secret),
  });
}

function sameState(left, right) {
  return left?.origin === right?.origin
    && left?.deviceId === right?.deviceId
    && left?.createdAt === right?.createdAt;
}

export function defaultContributionDeviceStateFile(options) {
  return join(defaultExportStateDirectory(options), "contribution-device-binding-v1.json");
}

export function createProductionContributionDeviceBackend({
  platform = process.platform,
  architecture = process.arch,
  createBackend = createExportIdentityKeychainBackend,
  // The reader whose designated requirement the durable ACL binds to is this
  // very companion process — the packaged Node runtime that calls keytar.
  // process.execPath is its absolute on-disk path, and its codesign-derived
  // identifier + team are stable across signed updates, so a mint bound to it
  // survives a Sparkle re-sign that the default ACL would deny.
  readerPath = process.execPath,
  windowsReadiness = null,
  createWindowsBackend = null,
  windowsFilesystemAdapter = null,
} = {}) {
  if (platform === "win32") {
    if (architecture !== "x64"
        || typeof createWindowsBackend !== "function"
        || !isWindowsFilesystemAdapter(windowsFilesystemAdapter)) {
      fail("invalid_configuration");
    }
    try {
      assertWindowsFilesystemProductionSafe(windowsFilesystemAdapter);
      assertWindowsProductionReadiness({
        platform,
        architecture,
        readiness: windowsReadiness,
      });
      const windowsBackend = createWindowsBackend({ platform, architecture });
      const selected = createWindowsProductionCapabilityBackend({
        backend: windowsBackend,
        capability: CAPABILITY,
        readiness: windowsReadiness,
      });
      WINDOWS_PRODUCTION_BACKENDS.add(selected);
      WINDOWS_STATE_FILESYSTEM_ADAPTERS.set(selected, windowsFilesystemAdapter);
      return selected;
    } catch {
      fail("invalid_configuration");
    }
  }
  if (platform !== "darwin" || architecture !== "arm64" || typeof createBackend !== "function") {
    fail("invalid_configuration");
  }
  try {
    return assertBackend(createBackend({
      durableAccess: { platform, readerPath },
    }));
  } catch (error) {
    if (error instanceof ContributionDeviceCapabilityError) throw error;
    translateBackendFailure(error);
  }
}

function assertStateFilesystemBoundary(backend, windowsFilesystemAdapter = null) {
  return resolveWindowsStateFilesystem(backend, windowsFilesystemAdapter);
}

// The macOS product state root was renamed after the contribution credential
// shipped. Keep the Keychain secret in place and move only its public binding
// metadata, lazily, when a contribution operation actually needs it. This
// avoids a launch-time Keychain prompt and preserves a fail-closed boundary if
// either file was replaced, made world-readable, or points at another service.
export async function migrateLegacyContributionDeviceCapability({
  backend,
  legacyStateFile,
  stateFile = defaultContributionDeviceStateFile(),
  expectedOrigin = null,
  windowsFilesystemAdapter = null,
} = {}) {
  const selected = assertBackend(backend);
  const windowsFilesystem = assertStateFilesystemBoundary(selected, windowsFilesystemAdapter);
  if (typeof legacyStateFile !== "string" || legacyStateFile.length < 1
      || legacyStateFile.length > 4096
      || typeof stateFile !== "string" || stateFile.length < 1
      || stateFile.length > 4096
      || resolve(legacyStateFile) === resolve(stateFile)) {
    fail("invalid_configuration");
  }
  const normalizedExpectedOrigin = expectedOrigin === null
    ? null
    : normalizeOrigin(expectedOrigin);
  const currentInspection = await inspectState(stateFile, windowsFilesystem);
  const legacyInspection = await inspectState(legacyStateFile, windowsFilesystem);

  if (legacyInspection === null) {
    if (currentInspection !== null && normalizedExpectedOrigin !== null
        && currentInspection.state.origin !== normalizedExpectedOrigin) {
      fail("origin_conflict");
    }
    return Object.freeze({
      status: currentInspection === null ? "missing" : "not_needed",
    });
  }
  const legacyState = legacyInspection.state;
  if (normalizedExpectedOrigin !== null
      && legacyState.origin !== normalizedExpectedOrigin) {
    fail("origin_conflict");
  }

  // A previous attempt may have durably published the new file and then been
  // interrupted before deleting the old one. Exact public metadata equality
  // is enough to finish that cleanup without touching Keychain again.
  if (currentInspection !== null) {
    if (normalizedExpectedOrigin !== null
        && currentInspection.state.origin !== normalizedExpectedOrigin) {
      fail("origin_conflict");
    }
    if (!sameState(currentInspection.state, legacyState)) {
      fail("credential_conflict");
    }
    await removeInspectedState(legacyInspection);
    return Object.freeze({
      status: "already_migrated",
      origin: currentInspection.state.origin,
      deviceId: currentInspection.state.deviceId,
      createdAt: currentInspection.state.createdAt,
    });
  }

  let stored = null;
  try {
    stored = await invokeBackend(selected, "read");
    if (stored === null) fail("credential_missing");
    // Validate the secret before publishing the state file. publicResult also
    // returns only the stable domain-separated hash, never the secret itself.
    const result = publicResult("migrated", legacyState, stored);
    await writeNewState(stateFile, canonicalState(legacyState), windowsFilesystem);
    const published = await inspectState(stateFile, windowsFilesystem);
    if (published === null || !sameState(published.state, legacyState)) {
      fail("state_invalid");
    }
    // If this unlink is interrupted, the exact-state branch above completes
    // cleanup on the next contribution operation.
    await removeInspectedState(legacyInspection);
    return result;
  } finally {
    if (Buffer.isBuffer(stored)) stored.fill(0);
  }
}

export async function readContributionDeviceCapability({
  backend,
  stateFile = defaultContributionDeviceStateFile(),
  expectedOrigin = null,
  windowsFilesystemAdapter = null,
} = {}) {
  const selected = assertBackend(backend);
  const windowsFilesystem = assertStateFilesystemBoundary(selected, windowsFilesystemAdapter);
  const state = await readState(stateFile, windowsFilesystem);
  let stored = null;
  try {
    stored = await invokeBackend(selected, "read");
    if (state === null && stored === null) return null;
    if (state === null) fail("credential_conflict");
    if (stored === null) fail("credential_missing");
    if (expectedOrigin !== null && state.origin !== normalizeOrigin(expectedOrigin)) fail("origin_conflict");
    return publicResult("available", state, stored);
  } finally {
    if (Buffer.isBuffer(stored)) stored.fill(0);
  }
}

export async function ensureContributionDeviceCapability({
  backend,
  origin,
  stateFile = defaultContributionDeviceStateFile(),
  generateDeviceId = randomUUID,
  generateSecret = () => randomBytes(SECRET_BYTES),
  clock = () => Date.now(),
  windowsFilesystemAdapter = null,
} = {}) {
  const selected = assertBackend(backend);
  const windowsFilesystem = assertStateFilesystemBoundary(selected, windowsFilesystemAdapter);
  const normalizedOrigin = normalizeOrigin(origin);
  if (typeof generateDeviceId !== "function" || typeof generateSecret !== "function"
      || typeof clock !== "function") {
    fail("invalid_configuration");
  }
  const existing = await readContributionDeviceCapability({
    backend: selected,
    stateFile,
    expectedOrigin: normalizedOrigin,
    windowsFilesystemAdapter: windowsFilesystem,
  });
  if (existing !== null) return Object.freeze({ ...existing, status: "existing" });

  let generatedValue = null;
  let generated = null;
  let readback = null;
  let publication = null;
  let stored = false;
  try {
    let generatedDeviceId;
    let now;
    try {
      generatedDeviceId = generateDeviceId();
      now = clock();
    } catch {
      fail("invalid_configuration");
    }
    const deviceId = normalizeDeviceId(generatedDeviceId);
    if (!Number.isFinite(now)) fail("invalid_configuration");
    let createdAt;
    try {
      createdAt = new Date(now).toISOString();
    } catch {
      fail("invalid_configuration");
    }
    const state = Object.freeze({
      origin: normalizedOrigin,
      deviceId,
      createdAt,
    });
    if (Date.parse(state.createdAt) !== now) fail("invalid_configuration");
    try {
      generatedValue = generateSecret();
    } catch {
      fail("credential_unavailable");
    }
    generated = copySecret(generatedValue);
    publication = await writeNewState(stateFile, canonicalState(state), windowsFilesystem);
    const outcome = await invokeBackend(selected, "createIfMissing", generated);
    if (outcome !== "created") fail("credential_conflict");
    stored = true;
    readback = await invokeBackend(selected, "read");
    if (readback === null || !Buffer.isBuffer(readback) || readback.byteLength !== SECRET_BYTES
        || !timingSafeEqual(readback, generated)) {
      fail("credential_unavailable");
    }
    return publicResult("created", state, readback);
  } finally {
    if (Buffer.isBuffer(generatedValue)) generatedValue.fill(0);
    generated?.fill(0);
    if (Buffer.isBuffer(readback)) readback.fill(0);
    if (publication !== null && !stored) await removeCreatedState(publication);
  }
}

function aliasesSecret(result, secret) {
  if (result instanceof ArrayBuffer) return result === secret.buffer;
  if (!ArrayBuffer.isView(result)) return false;
  if (result.buffer !== secret.buffer) return false;
  const resultStart = result.byteOffset;
  const resultEnd = resultStart + result.byteLength;
  const secretStart = secret.byteOffset;
  const secretEnd = secretStart + secret.byteLength;
  return resultStart < secretEnd && resultEnd > secretStart;
}

/**
 * Lease the device secret to one awaited in-memory operation. The temporary
 * Buffer is zeroized before this function settles and must never be returned by
 * the callback. Callers remain responsible for ensuring their operation does
 * not log or persist the secret.
 */
export async function withContributionDeviceSecret({
  backend,
  stateFile = defaultContributionDeviceStateFile(),
  expectedOrigin = null,
  operation,
  windowsFilesystemAdapter = null,
} = {}) {
  const selected = assertBackend(backend);
  const windowsFilesystem = assertStateFilesystemBoundary(selected, windowsFilesystemAdapter);
  if (typeof operation !== "function") fail("invalid_configuration");
  const state = await readState(stateFile, windowsFilesystem);
  let stored = null;
  let temporary = null;
  try {
    stored = await invokeBackend(selected, "read");
    if (state === null && stored === null) fail("credential_missing");
    if (state === null) fail("credential_conflict");
    if (stored === null) fail("credential_missing");
    if (expectedOrigin !== null && state.origin !== normalizeOrigin(expectedOrigin)) fail("origin_conflict");
    temporary = copySecret(stored);
    let result;
    try {
      result = await operation(temporary, Object.freeze({
        origin: state.origin,
        deviceId: state.deviceId,
        createdAt: state.createdAt,
      }));
    } catch {
      fail("operation_failed");
    }
    if (aliasesSecret(result, temporary)) fail("callback_result_invalid");
    return result;
  } finally {
    temporary?.fill(0);
    if (Buffer.isBuffer(stored)) stored.fill(0);
  }
}

/**
 * Silently rotate this Mac's device-upload secret in place — the local half of
 * the sign-in-once auto-renewal (docs/design/2026-08-11-sign-in-once-durability
 * section 2). A fresh 32-byte secret is generated locally, its
 * domain-separated hash is handed to `performRemoteRotation` (the caller's
 * network call to the renew route), and only after the service confirms the
 * rotation committed is the Keychain value replaced compare-and-swap. No user
 * sign-in is involved: the existing secret authenticates the renewal.
 *
 * Ordering guarantees the credential is never left invalid by a benign failure:
 * if the remote rotation does not commit, the service still holds the old
 * secret and the untouched Keychain value stays valid; the next pass retries.
 * The one residual hazard is a failure strictly between the service commit and
 * the local swap (a wedged Keychain, or a crash in that window) — the service
 * would then hold the new secret while the Keychain holds the old, and the next
 * device auth is revoked, degrading to exactly today's re-pair. That window is a
 * single keytar update wide and only reachable ~monthly, so it is accepted
 * rather than guarded by persisting the new secret to disk.
 */
export async function rotateContributionDeviceCredential({
  backend,
  stateFile = defaultContributionDeviceStateFile(),
  expectedOrigin = null,
  performRemoteRotation,
  generateSecret = () => randomBytes(SECRET_BYTES),
  windowsFilesystemAdapter = null,
} = {}) {
  const selected = assertBackend(backend);
  const windowsFilesystem = assertStateFilesystemBoundary(selected, windowsFilesystemAdapter);
  if (typeof performRemoteRotation !== "function"
      || typeof generateSecret !== "function") {
    fail("invalid_configuration");
  }
  const state = await readState(stateFile, windowsFilesystem);
  let oldStored = null;
  let oldSecret = null;
  let newValue = null;
  let newSecret = null;
  let readback = null;
  try {
    oldStored = await invokeBackend(selected, "read");
    if (state === null && oldStored === null) fail("credential_missing");
    if (state === null) fail("credential_conflict");
    if (oldStored === null) fail("credential_missing");
    if (expectedOrigin !== null
        && state.origin !== normalizeOrigin(expectedOrigin)) {
      fail("origin_conflict");
    }
    oldSecret = copySecret(oldStored);
    try {
      newValue = generateSecret();
    } catch {
      fail("credential_unavailable");
    }
    newSecret = copySecret(newValue);
    // A rotation to the same secret is rejected by the service and would be a
    // no-op locally; a working generator makes this astronomically unlikely.
    if (timingSafeEqual(oldSecret, newSecret)) fail("credential_conflict");
    const nextDeviceSecretHash = hashSecret(state.deviceId, newSecret);
    let remote;
    try {
      remote = await performRemoteRotation(Object.freeze({
        origin: state.origin,
        deviceId: state.deviceId,
        currentSecret: oldSecret,
        nextDeviceSecretHash,
      }));
    } catch (error) {
      if (error instanceof ContributionDeviceCapabilityError) throw error;
      fail("operation_failed");
    }
    if (!remote || typeof remote !== "object" || Array.isArray(remote)
        || remote.committed !== true
        || typeof remote.expiresAt !== "string"
        || !Number.isFinite(Date.parse(remote.expiresAt))) {
      // Not committed: the service still holds the old secret. Leave the
      // Keychain value untouched and valid; the caller retries next pass.
      fail("operation_failed");
    }
    const outcome = await invokeBackend(
      selected,
      "replaceExact",
      oldSecret,
      newSecret,
    );
    if (outcome === "conflict") fail("credential_conflict");
    if (outcome === "missing") fail("credential_missing");
    if (outcome !== "replaced") fail("credential_unavailable");
    readback = await invokeBackend(selected, "read");
    if (readback === null || !Buffer.isBuffer(readback)
        || readback.byteLength !== SECRET_BYTES
        || !timingSafeEqual(readback, newSecret)) {
      fail("credential_unavailable");
    }
    return Object.freeze({
      status: "renewed",
      origin: state.origin,
      deviceId: state.deviceId,
      expiresAt: new Date(remote.expiresAt).toISOString(),
    });
  } finally {
    if (Buffer.isBuffer(oldStored)) oldStored.fill(0);
    oldSecret?.fill(0);
    if (Buffer.isBuffer(newValue)) newValue.fill(0);
    newSecret?.fill(0);
    if (Buffer.isBuffer(readback)) readback.fill(0);
  }
}

/**
 * Remove the local device binding only after the caller has confirmed that the
 * remote device was revoked. A failed or unattempted remote operation must pass
 * false and therefore cannot delete the local credential.
 */
export async function removeContributionDeviceCapability({
  backend,
  stateFile = defaultContributionDeviceStateFile(),
  expectedOrigin = null,
  confirmDeviceId,
  remoteRevocationConfirmed = false,
  windowsFilesystemAdapter = null,
} = {}) {
  const selected = assertBackend(backend);
  const windowsFilesystem = assertStateFilesystemBoundary(selected, windowsFilesystemAdapter);
  if (remoteRevocationConfirmed !== true) fail("remote_revocation_required");
  const inspection = await inspectState(stateFile, windowsFilesystem);
  let stored = null;
  let expected = null;
  try {
    stored = await invokeBackend(selected, "read");
    if (inspection === null && stored === null) return Object.freeze({ status: "missing" });
    if (inspection === null) fail("credential_conflict");
    const { state } = inspection;
    if (confirmDeviceId !== state.deviceId) fail("confirmation_invalid");
    if (expectedOrigin !== null && state.origin !== normalizeOrigin(expectedOrigin)) fail("origin_conflict");
    let credential = "already_missing";
    if (stored !== null) {
      expected = copySecret(stored);
      const outcome = await invokeBackend(selected, "deleteExact", expected);
      if (outcome === "conflict") fail("credential_conflict");
      if (outcome !== "deleted" && outcome !== "missing") fail("credential_unavailable");
      credential = outcome === "deleted" ? "deleted" : "already_missing";
    }
    await removeInspectedState(inspection);
    return Object.freeze({
      status: "removed",
      deviceId: state.deviceId,
      credential,
      secureErasure: false,
    });
  } finally {
    expected?.fill(0);
    if (Buffer.isBuffer(stored)) stored.fill(0);
  }
}
