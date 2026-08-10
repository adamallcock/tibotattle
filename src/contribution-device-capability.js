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

async function prepareStateDirectory(stateFile) {
  if (typeof stateFile !== "string" || stateFile.length < 1 || stateFile.length > 4096) {
    fail("invalid_configuration");
  }
  const directory = dirname(stateFile);
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

async function inspectState(stateFile) {
  if (typeof stateFile !== "string" || stateFile.length < 1 || stateFile.length > 4096) {
    fail("invalid_configuration");
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

async function readState(stateFile) {
  return (await inspectState(stateFile))?.state ?? null;
}

async function writeNewState(stateFile, content) {
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
} = {}) {
  if (platform !== "darwin" || architecture !== "arm64" || typeof createBackend !== "function") {
    fail("invalid_configuration");
  }
  try {
    return assertBackend(createBackend());
  } catch (error) {
    if (error instanceof ContributionDeviceCapabilityError) throw error;
    translateBackendFailure(error);
  }
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
} = {}) {
  const selected = assertBackend(backend);
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
  const currentInspection = await inspectState(stateFile);
  const legacyInspection = await inspectState(legacyStateFile);

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
    await writeNewState(stateFile, canonicalState(legacyState));
    const published = await inspectState(stateFile);
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
} = {}) {
  const selected = assertBackend(backend);
  const state = await readState(stateFile);
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
} = {}) {
  const selected = assertBackend(backend);
  const normalizedOrigin = normalizeOrigin(origin);
  if (typeof generateDeviceId !== "function" || typeof generateSecret !== "function"
      || typeof clock !== "function") {
    fail("invalid_configuration");
  }
  const existing = await readContributionDeviceCapability({
    backend: selected,
    stateFile,
    expectedOrigin: normalizedOrigin,
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
    publication = await writeNewState(stateFile, canonicalState(state));
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
} = {}) {
  const selected = assertBackend(backend);
  if (typeof operation !== "function") fail("invalid_configuration");
  const state = await readState(stateFile);
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
} = {}) {
  const selected = assertBackend(backend);
  if (remoteRevocationConfirmed !== true) fail("remote_revocation_required");
  const inspection = await inspectState(stateFile);
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
