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
  ExportIdentityKeychainError,
  createExportIdentityKeychainBackend,
  deleteExportIdentityKeychainItemByAttributes,
  exportIdentityKeychainItemPresenceByAttributes,
} from "./export-identity-keychain.js";
import {
  assertWindowsFilesystemProductionSafe,
  assertWindowsProductionReadiness,
  createWindowsProductionCapabilityBackend,
  isWindowsFilesystemAdapter,
} from "./platform/index.js";
import {
  contributionDeviceKeychainBrokerConfiguration,
  createContributionDeviceKeychainBrokerBinding,
} from "./contribution-device-keychain-broker.js";

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

// The contribution-device binding metadata is still written by the Node
// filesystem helpers below. Keep production Windows credential backends
// branded until that state path is moved onto the native filesystem adapter;
// this prevents a future readiness promotion from silently re-enabling the
// current POSIX-style state implementation on Windows.
const WINDOWS_PRODUCTION_BACKENDS = new WeakSet();

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

const APP_CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDeviceApp;

export const CONTRIBUTION_DEVICE_KEYCHAIN_PROMPT_SURFACES = Object.freeze([
  "pairing",
  "rotation",
  "none",
]);

/**
 * Where — if anywhere — this install can still meet a macOS Keychain dialog.
 *
 * The shipped guidance is correctly conditional ("If macOS asks…") but renders
 * to everyone and names `node`, a process a fresh brokered install will never
 * see: the app mints and reads its own item, so no dialog is reachable. This
 * is the signal that lets the dashboard show the guidance only where it can
 * apply. Neither input can prompt — the announcement is an environment read,
 * and the legacy probe is attribute-addressed, so it never decrypts.
 *
 * - `pairing`: no broker announcement (development, a standalone companion, or
 *   an app that could not create the channel). The companion still mints
 *   through the `security` CLI and reads it back, so today's copy is exact.
 * - `rotation`: brokered, but the credential is still the legacy `.v1` item.
 *   The dialog moved with the migration; it can only appear at the rotation
 *   that retires that item, never at pairing.
 * - `none`: brokered with no legacy item. No dialog exists to explain.
 *
 * An indeterminate probe answers `rotation`: conditional guidance that turns
 * out to be unnecessary costs one sentence, while withholding it from an
 * install that does raise a dialog is the harm this exists to prevent.
 */
export function contributionDeviceKeychainPromptSurface({
  environment = process.env,
  readBrokerConfiguration = contributionDeviceKeychainBrokerConfiguration,
  probeLegacyCredential = () =>
    exportIdentityKeychainItemPresenceByAttributes(CAPABILITY),
} = {}) {
  let announced = false;
  try {
    announced = readBrokerConfiguration(environment) !== null;
  } catch {
    // A malformed environment is the companion's own problem to report; for
    // guidance purposes it is simply an install with no usable broker.
    announced = false;
  }
  if (!announced) return "pairing";
  let presence;
  try {
    presence = probeLegacyCredential();
  } catch {
    presence = "unknown";
  }
  return presence === "missing" ? "none" : "rotation";
}

function assertBackendSecret(value) {
  if (!Buffer.isBuffer(value) || value.byteLength !== SECRET_BYTES) {
    throw new ExportIdentityKeychainError("invalid_secret");
  }
  return value;
}

/**
 * The app-brokered contribution-device backend: the signed TiboTattle.app is
 * the only process that touches the Keychain for the app-managed credential
 * generation, over the private broker channel it handed the companion at
 * spawn. The companion holds secrets in memory only. The legacy generation —
 * items minted companion-side through the `security` CLI (or keytar) under
 * the `.v1` service — keeps being read and exact-deleted through keytar
 * exactly as today, so existing installs are untouched until their next
 * credential rotation, which is the migration point: the replacement secret
 * is minted app-side and the legacy item is retired through the existing
 * attribute-addressed deletion path (never decrypted, never prompting).
 *
 * A broker that is configured but unreachable fails every operation with the
 * coded ExportIdentityKeychainError family, which the capability layer
 * reports as the same recoverable contribution_device_credential_* errors
 * the pairing path uses today. It never falls back to a companion-side mint:
 * that fallback would silently resurrect the first-pairing Keychain dialog.
 */
export function createAppBrokeredContributionDeviceBackend({
  transport,
  createBrokerBinding = createContributionDeviceKeychainBrokerBinding,
  createBackend = createExportIdentityKeychainBackend,
  // Legacy keytar access is built lazily: a fresh install whose reads are all
  // answered by the broker must not depend on the native binding loading, and
  // brokered mode never mints legacy items, so no durable-ACL configuration
  // is passed here.
  createLegacyBackend = () => createExportIdentityKeychainBackend(),
  // The legacy fall-through is the only thing that would make a brokered
  // install construct keytar, and constructing that native binding is what
  // took sign-in down on 2026-08-10. An attribute-addressed probe answers
  // "is there a legacy item at all" without decrypting anything, so it needs
  // neither the binding nor the item's access control list and cannot prompt.
  probeLegacyCredential = () =>
    exportIdentityKeychainItemPresenceByAttributes(CAPABILITY),
  sweepLegacyCredential = () =>
    deleteExportIdentityKeychainItemByAttributes(CAPABILITY),
} = {}) {
  if (typeof createBrokerBinding !== "function"
      || typeof createBackend !== "function"
      || typeof createLegacyBackend !== "function"
      || typeof probeLegacyCredential !== "function"
      || typeof sweepLegacyCredential !== "function") {
    fail("invalid_configuration");
  }
  let modernBackend;
  try {
    modernBackend = assertBackend(createBackend({
      binding: createBrokerBinding({ transport }),
    }));
  } catch (error) {
    if (error instanceof ContributionDeviceCapabilityError) throw error;
    fail("invalid_configuration");
  }
  let legacyBackendInstance = null;
  const legacyBackend = () => {
    if (legacyBackendInstance === null) {
      legacyBackendInstance = legacyBackendInstanceOf();
    }
    return legacyBackendInstance;
  };
  function legacyBackendInstanceOf() {
    const built = createLegacyBackend();
    let valid = false;
    try {
      valid = built !== null && typeof built === "object"
        && typeof built.read === "function"
        && typeof built.createIfMissing === "function"
        && typeof built.replaceExact === "function"
        && typeof built.deleteExact === "function";
    } catch {
      // Collapse hostile injected backends to one fixed configuration error.
    }
    if (!valid) throw new ExportIdentityKeychainError("invalid_configuration");
    return built;
  }
  // Only a definite "missing" skips the legacy generation. An indeterminate
  // probe keeps the exact fall-through this backend had before it existed, so
  // an install whose legacy item cannot be probed is never mistaken for a
  // fresh one and silently pushed into a re-pair. Nothing in brokered mode
  // ever writes a legacy item, so one answer holds for the process lifetime.
  let legacyPresence = null;
  function legacyBackendIfPresent() {
    if (legacyPresence === null) {
      try {
        legacyPresence = probeLegacyCredential();
      } catch {
        legacyPresence = "unknown";
      }
      if (legacyPresence !== "present" && legacyPresence !== "missing") {
        legacyPresence = "unknown";
      }
    }
    return legacyPresence === "missing" ? null : legacyBackend();
  }
  function assertContributionCapability(capability) {
    if (capability !== CAPABILITY) {
      throw new ExportIdentityKeychainError("invalid_capability");
    }
  }
  async function modernSecretPresent() {
    let stored = null;
    try {
      stored = await modernBackend.read(APP_CAPABILITY);
      return stored !== null;
    } finally {
      stored?.fill(0);
    }
  }
  async function retireLegacyItem() {
    // Attribute-addressed and therefore promptless; a failure leaves a stale
    // legacy item that every read already shadows, and the next rotation,
    // disconnect, or credential reset retries the removal.
    try {
      await sweepLegacyCredential();
    } catch {
      // deliberately ignored
    }
  }

  async function read(capability) {
    assertContributionCapability(capability);
    const modern = await modernBackend.read(APP_CAPABILITY);
    if (modern !== null) return modern;
    return legacyBackendIfPresent()?.read(CAPABILITY) ?? null;
  }

  async function createIfMissing(capability, generatedSecret) {
    assertContributionCapability(capability);
    assertBackendSecret(generatedSecret);
    if (await modernSecretPresent()) return "existing";
    const legacyStore = legacyBackendIfPresent();
    let legacy = null;
    try {
      legacy = legacyStore === null ? null : await legacyStore.read(CAPABILITY);
      if (legacy !== null) return "existing";
    } finally {
      legacy?.fill(0);
    }
    // Fresh credentials are minted exclusively by the app: SecItemAdd by the
    // signed app raises no dialog at mint and none at read-back, because the
    // creating app is the item's partition holder and ACL trustee.
    return modernBackend.createIfMissing(APP_CAPABILITY, generatedSecret);
  }

  async function replaceExact(capability, expectedSecret, replacementSecret) {
    assertContributionCapability(capability);
    assertBackendSecret(expectedSecret);
    assertBackendSecret(replacementSecret);
    if (await modernSecretPresent()) {
      const outcome = await modernBackend.replaceExact(
        APP_CAPABILITY,
        expectedSecret,
        replacementSecret,
      );
      if (outcome === "replaced") await retireLegacyItem();
      return outcome;
    }
    // Migration point (design note 2026-08-19, option 3): the credential
    // still lives in the legacy generation, and the caller — the silent
    // ~25-day rotation — already holds the service-committed replacement.
    // Mint the replacement app-side first, then retire the legacy item, so a
    // crash between the two steps leaves the valid new credential readable
    // (reads prefer the app generation) rather than no credential at all.
    const legacyStore = legacyBackendIfPresent();
    if (legacyStore === null) return "missing";
    let legacy = null;
    let matches = false;
    try {
      legacy = await legacyStore.read(CAPABILITY);
      if (legacy === null) return "missing";
      matches = legacy.byteLength === expectedSecret.byteLength
        && timingSafeEqual(legacy, expectedSecret);
    } finally {
      legacy?.fill(0);
    }
    if (!matches) return "conflict";
    const created = await modernBackend.createIfMissing(
      APP_CAPABILITY,
      replacementSecret,
    );
    if (created !== "created") {
      // A concurrent writer minted an app-generation credential between the
      // presence probe and this mint; nothing can prove whose secret is
      // stored, so fail closed instead of reporting a replace that may not
      // have happened.
      throw new ExportIdentityKeychainError("operation_failed");
    }
    await retireLegacyItem();
    return "replaced";
  }

  async function deleteExact(capability, expectedSecret) {
    assertContributionCapability(capability);
    assertBackendSecret(expectedSecret);
    if (await modernSecretPresent()) {
      const outcome = await modernBackend.deleteExact(
        APP_CAPABILITY,
        expectedSecret,
      );
      if (outcome === "deleted") await retireLegacyItem();
      return outcome;
    }
    const legacyStore = legacyBackendIfPresent();
    if (legacyStore === null) return "missing";
    return legacyStore.deleteExact(CAPABILITY, expectedSecret);
  }

  async function describe(capability) {
    assertContributionCapability(capability);
    return Object.freeze({ backend: "macos_keychain", status: "available" });
  }

  return Object.freeze({ read, createIfMissing, replaceExact, deleteExact, describe });
}

function assertStateFilesystemBoundary(backend) {
  try {
    if (WINDOWS_PRODUCTION_BACKENDS.has(backend)) fail("invalid_configuration");
  } catch (error) {
    if (error instanceof ContributionDeviceCapabilityError) throw error;
    fail("invalid_configuration");
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
  assertStateFilesystemBoundary(selected);
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
  assertStateFilesystemBoundary(selected);
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
  assertStateFilesystemBoundary(selected);
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
  assertStateFilesystemBoundary(selected);
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
} = {}) {
  const selected = assertBackend(backend);
  assertStateFilesystemBoundary(selected);
  if (typeof performRemoteRotation !== "function"
      || typeof generateSecret !== "function") {
    fail("invalid_configuration");
  }
  const state = await readState(stateFile);
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
} = {}) {
  const selected = assertBackend(backend);
  assertStateFilesystemBoundary(selected);
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
