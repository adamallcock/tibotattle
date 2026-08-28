#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

import {
  LINUX_SECRET_SERVICE_CAPABILITIES,
  createLinuxSecretServiceBackend,
} from "../src/platform/linux-secret-service.js";

const GNOME_KEYRING_DAEMON = "/usr/bin/gnome-keyring-daemon";
const GNOME_KEYRING_ARGUMENTS = Object.freeze([
  "--components=secrets",
  "--unlock",
]);
const CONTAINER_MARKER = "/usr/local/share/tibotattle/linux-secret-service-qualification-v1";
const CONTAINER_MARKER_TEXT = "tibotattle-linux-secret-service-qualification-v1\n";
const CONTAINER_ENVIRONMENT_FILE = "/.dockerenv";
const DISPOSABLE_HOME = "/home/node";
const DISPOSABLE_RUNTIME = "/run/user/1000";
const SECRET_BYTES = 32;
const DAEMON_TIMEOUT_MS = 10_000;
const DEFAULT_QUALIFICATION_DEADLINE_MS = 30_000;
const MAXIMUM_OPERATION_MS = 5_000;
const MINIMUM_QUALIFICATION_DEADLINE_MS = 10;
const CLI_HARD_DEADLINE_MS = 35_000;
const CAPABILITIES = Object.freeze([
  LINUX_SECRET_SERVICE_CAPABILITIES.exportIdentity,
  LINUX_SECRET_SERVICE_CAPABILITIES.accountObservation,
  LINUX_SECRET_SERVICE_CAPABILITIES.claudeSessionPseudonym,
  LINUX_SECRET_SERVICE_CAPABILITIES.contributionDevice,
]);
const RECEIPT_KEYS = new Set([
  "schemaVersion",
  "status",
  "scope",
  "platform",
  "architecture",
  "subject",
  "capabilities",
  "lifecycle",
  "cleanup",
  "leaseCrossProcessSafe",
  "crashRecoveryComplete",
]);
const ERROR_CODES = new Set([
  "unsupported_platform",
  "unsupported_architecture",
  "invalid_configuration",
  "isolation_required",
  "session_bus_required",
  "daemon_unavailable",
  "daemon_failed",
  "deadline_exceeded",
  "deadline_cleanup_unproven",
  "backend_unavailable",
  "binding_unverified",
  "store_not_empty",
  "random_source_failed",
  "lifecycle_failed",
  "cleanup_failed",
  "unexpected",
]);
const SAFE_DAEMON_ENVIRONMENT_KEYS = Object.freeze([
  "DBUS_SESSION_BUS_ADDRESS",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
]);

const trustedErrors = new WeakSet();

export class LinuxSecretServiceQualificationError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Linux Secret Service qualification error code");
    }
    super("Linux Secret Service qualification failed");
    this.name = "LinuxSecretServiceQualificationError";
    this.code = `linux_secret_service_qualification_${code}`;
    trustedErrors.add(this);
  }
}

export function isLinuxSecretServiceQualificationError(error) {
  return Boolean(error
    && trustedErrors.has(error)
    && Object.getPrototypeOf(error) === LinuxSecretServiceQualificationError.prototype);
}

function fail(code) {
  throw new LinuxSecretServiceQualificationError(code);
}

function qualificationEnvironment(environment) {
  let isolated;
  let sessionAddress;
  try {
    isolated = environment?.TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED;
    sessionAddress = environment?.DBUS_SESSION_BUS_ADDRESS;
  } catch {
    fail("invalid_configuration");
  }
  if (isolated !== "1") fail("isolation_required");
  if (typeof sessionAddress !== "string" || sessionAddress.trim().length === 0) {
    fail("session_bus_required");
  }
  return environment;
}

function decodeMountInfoPath(value) {
  const decoded = value.replace(/\\([0-7]{3})/gu, (_match, octal) => (
    String.fromCodePoint(Number.parseInt(octal, 8))
  ));
  if (decoded.includes("\\")) fail("isolation_required");
  return decoded;
}

function assertRootOwnedMarker(path, expectedText = null) {
  let stats;
  try {
    stats = lstatSync(path);
    if (realpathSync(path) !== path
        || !stats.isFile()
        || stats.isSymbolicLink()
        || stats.uid !== 0
        || stats.nlink !== 1
        || (stats.mode & 0o022) !== 0
        || (expectedText !== null && readFileSync(path, "utf8") !== expectedText)) {
      fail("isolation_required");
    }
  } catch (error) {
    if (isLinuxSecretServiceQualificationError(error)) throw error;
    fail("isolation_required");
  }
}

function assertDisposableTmpfs(path) {
  let metadata;
  let mountInfo;
  let canonical;
  try {
    metadata = lstatSync(path);
    canonical = realpathSync(path);
    mountInfo = readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    fail("isolation_required");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (canonical !== path
      || !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || currentUid === null
      || metadata.uid !== currentUid
      || (metadata.mode & 0o777) !== 0o700) {
    fail("isolation_required");
  }
  const matches = [];
  for (const line of mountInfo.split("\n")) {
    if (line.length === 0) continue;
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || fields.length <= separator + 1) fail("isolation_required");
    if (decodeMountInfoPath(fields[4]) === path) matches.push(fields[separator + 1]);
  }
  if (matches.length !== 1 || matches[0] !== "tmpfs") fail("isolation_required");
}

/**
 * Prove this process is inside the reviewed qualification container and that
 * both credential-bearing user roots are distinct tmpfs mounts. An
 * environment marker alone is never accepted as isolation authority.
 */
function proveNativeQualificationIsolation(environment) {
  qualificationEnvironment(environment);
  let selected;
  try {
    selected = {
      home: environment.HOME,
      runtime: environment.XDG_RUNTIME_DIR,
      config: environment.XDG_CONFIG_HOME,
      cache: environment.XDG_CACHE_HOME,
      data: environment.XDG_DATA_HOME,
      temporary: environment.TMPDIR,
    };
  } catch {
    fail("invalid_configuration");
  }
  if (selected.home !== DISPOSABLE_HOME
      || selected.runtime !== DISPOSABLE_RUNTIME
      || selected.temporary !== DISPOSABLE_RUNTIME
      || selected.config !== posix.join(DISPOSABLE_HOME, ".config")
      || selected.cache !== posix.join(DISPOSABLE_HOME, ".cache")
      || selected.data !== posix.join(DISPOSABLE_HOME, ".local", "share")) {
    fail("isolation_required");
  }
  assertRootOwnedMarker(CONTAINER_ENVIRONMENT_FILE);
  assertRootOwnedMarker(CONTAINER_MARKER, CONTAINER_MARKER_TEXT);
  assertDisposableTmpfs(DISPOSABLE_HOME);
  assertDisposableTmpfs(DISPOSABLE_RUNTIME);
  return Object.freeze({ status: "isolated" });
}

function daemonEnvironment(environment) {
  const selected = Object.create(null);
  for (const key of SAFE_DAEMON_ENVIRONMENT_KEYS) {
    let value;
    try {
      value = environment[key];
    } catch {
      fail("invalid_configuration");
    }
    if (typeof value === "string" && value.length > 0) selected[key] = value;
  }
  return selected;
}

/**
 * Start and unlock only the Secret Service component inside the caller's
 * already-isolated D-Bus session. The empty disposable password is delivered
 * as one newline over stdin; daemon stdout/stderr are never observable.
 */
export function startLinuxSecretServiceDaemon({
  environment = process.env,
  spawn = spawnSync,
  isolationProbe = proveNativeQualificationIsolation,
} = {}) {
  qualificationEnvironment(environment);
  if (typeof spawn !== "function" || typeof isolationProbe !== "function") {
    fail("invalid_configuration");
  }
  try {
    if (isolationProbe(environment)?.status !== "isolated") {
      fail("isolation_required");
    }
  } catch (error) {
    if (isLinuxSecretServiceQualificationError(error)) throw error;
    fail("isolation_required");
  }
  const password = Buffer.from("\n", "utf8");
  let outcome;
  try {
    outcome = spawn(GNOME_KEYRING_DAEMON, [...GNOME_KEYRING_ARGUMENTS], {
      env: daemonEnvironment(environment),
      input: password,
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: DAEMON_TIMEOUT_MS,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
  } catch {
    fail("daemon_failed");
  } finally {
    password.fill(0);
  }
  let status;
  let errorCode;
  try {
    status = outcome?.status;
    errorCode = outcome?.error?.code;
  } catch {
    fail("daemon_failed");
  }
  if (errorCode === "ENOENT") fail("daemon_unavailable");
  if (status !== 0) fail("daemon_failed");
  return Object.freeze({ status: "started" });
}

function qualificationDeadline(durationMs) {
  if (!Number.isSafeInteger(durationMs)
      || durationMs < MINIMUM_QUALIFICATION_DEADLINE_MS
      || durationMs > DEFAULT_QUALIFICATION_DEADLINE_MS) {
    fail("invalid_configuration");
  }
  return Date.now() + durationMs;
}

async function withQualificationDeadline(deadline, callback) {
  const remaining = Math.min(MAXIMUM_OPERATION_MS, deadline - Date.now());
  if (remaining <= 0) fail("deadline_exceeded");
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(callback),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new LinuxSecretServiceQualificationError("deadline_exceeded")),
          remaining,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function defaultCreateBackend({ platform, architecture }) {
  return createLinuxSecretServiceBackend({ platform, architecture });
}

function validateBackend(backend) {
  let valid = false;
  try {
    valid = backend !== null && typeof backend === "object"
      && typeof backend.read === "function"
      && typeof backend.createIfMissing === "function"
      && typeof backend.replaceExact === "function"
      && typeof backend.deleteExact === "function"
      && typeof backend.withOperationLease === "function"
      && typeof backend.close === "function"
      && typeof backend.bindingProvenanceVerified === "boolean"
      && typeof backend.crossProcessSafe === "boolean"
      && backend.crashRecoveryComplete === false
      && backend.productionSafe === false;
  } catch {
    valid = false;
  }
  if (!valid) fail("backend_unavailable");
  return backend;
}

async function randomSecret(randomSource, deadline) {
  let source = null;
  try {
    source = await withQualificationDeadline(
      deadline,
      () => randomSource(SECRET_BYTES),
    );
    if (!Buffer.isBuffer(source) || source.byteLength !== SECRET_BYTES) {
      fail("random_source_failed");
    }
    return Buffer.from(source);
  } catch (error) {
    if (isLinuxSecretServiceQualificationError(error)) throw error;
    fail("random_source_failed");
  } finally {
    try {
      source?.fill(0);
    } catch {
      // The fixed random-source failure remains authoritative.
    }
  }
}

async function withMutationLease(backend, capability, operation, callback, deadline) {
  return withQualificationDeadline(
    deadline,
    () => backend.withOperationLease(capability, { operation }, callback),
  );
}

async function readExact(backend, capability, expected, deadline) {
  let observed = null;
  try {
    observed = await withQualificationDeadline(deadline, () => backend.read(capability));
    if (!Buffer.isBuffer(observed)
        || observed.byteLength !== SECRET_BYTES
        || !timingSafeEqual(observed, expected)) {
      fail("lifecycle_failed");
    }
  } finally {
    observed?.fill(0);
  }
}

async function confirmAbsent(backend, capability, deadline) {
  let observed = null;
  try {
    observed = await withQualificationDeadline(deadline, () => backend.read(capability));
    if (observed !== null) fail("lifecycle_failed");
  } finally {
    observed?.fill(0);
  }
}

function rememberOwned(owned, capability, secret) {
  const previous = owned.get(capability);
  previous?.fill(0);
  owned.set(capability, Buffer.from(secret));
}

function forgetOwned(owned, capability) {
  const previous = owned.get(capability);
  previous?.fill(0);
  owned.delete(capability);
}

async function qualifyCapability(
  backend,
  capability,
  original,
  replacement,
  owned,
  deadline,
) {
  const created = await withMutationLease(backend, capability, "create", (lease) => (
    backend.createIfMissing(capability, original, lease)
  ), deadline);
  if (created !== "created") fail("lifecycle_failed");
  rememberOwned(owned, capability, original);
  await readExact(backend, capability, original, deadline);

  const replaced = await withMutationLease(backend, capability, "replace", (lease) => (
    backend.replaceExact(capability, original, replacement, lease)
  ), deadline);
  if (replaced !== "replaced") fail("lifecycle_failed");
  rememberOwned(owned, capability, replacement);
  await readExact(backend, capability, replacement, deadline);

  const deleted = await withMutationLease(backend, capability, "delete", (lease) => (
    backend.deleteExact(capability, replacement, lease)
  ), deadline);
  if (deleted !== "deleted") fail("lifecycle_failed");
  forgetOwned(owned, capability);
  await confirmAbsent(backend, capability, deadline);
}

/**
 * Delete only an exact value this run previously established as helper-owned,
 * then prove final absence. A preexisting or conflicting value is never used
 * as deletion authority, even when the isolation marker is present.
 */
async function cleanupCapability(backend, capability, owned, deadline) {
  const expected = owned.get(capability) ?? null;
  if (expected !== null) {
    try {
      const deleted = await withMutationLease(backend, capability, "delete", (lease) => (
        backend.deleteExact(capability, expected, lease)
      ), deadline);
      if (deleted !== "deleted" && deleted !== "missing") fail("cleanup_failed");
      forgetOwned(owned, capability);
    } catch (error) {
      if (isLinuxSecretServiceQualificationError(error)
          && error.code === "linux_secret_service_qualification_cleanup_failed") {
        throw error;
      }
      fail("cleanup_failed");
    }
  }
  let remaining = null;
  try {
    remaining = await withQualificationDeadline(
      deadline,
      () => backend.read(capability),
    );
    if (remaining !== null) fail("cleanup_failed");
  } catch (error) {
    if (isLinuxSecretServiceQualificationError(error)) throw error;
    fail("cleanup_failed");
  } finally {
    remaining?.fill(0);
  }
}

function qualificationReceipt(subject, backend) {
  const receipt = Object.freeze({
    schemaVersion: "linux-credential-qualification-v1",
    status: "passed",
    scope: "development_only",
    platform: "linux",
    architecture: "x64",
    subject,
    capabilities: CAPABILITIES.length,
    lifecycle: "round_trip_absence_confirmed",
    cleanup: "confirmed",
    leaseCrossProcessSafe: backend.crossProcessSafe,
    crashRecoveryComplete: backend.crashRecoveryComplete,
  });
  if (Object.keys(receipt).some((key) => !RECEIPT_KEYS.has(key))) {
    fail("invalid_configuration");
  }
  return receipt;
}

export async function runLinuxSecretServiceQualification(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  let platform;
  let architecture;
  let environment;
  let backend;
  let createBackend;
  let randomSource;
  let startDaemon;
  let deadlineMs;
  try {
    ({
      platform = process.platform,
      architecture = process.arch,
      environment = process.env,
      backend = undefined,
      createBackend = defaultCreateBackend,
      randomSource = randomBytes,
      startDaemon = startLinuxSecretServiceDaemon,
      deadlineMs = DEFAULT_QUALIFICATION_DEADLINE_MS,
    } = options);
  } catch {
    fail("invalid_configuration");
  }
  if (platform !== "linux") fail("unsupported_platform");
  if (architecture !== "x64") fail("unsupported_architecture");
  qualificationEnvironment(environment);
  if (typeof createBackend !== "function"
      || typeof randomSource !== "function"
      || typeof startDaemon !== "function") {
    fail("invalid_configuration");
  }
  const deadline = qualificationDeadline(deadlineMs);
  const nativeSubject = platform === process.platform
    && architecture === process.arch
    && environment === process.env
    && backend === undefined
    && createBackend === defaultCreateBackend
    && randomSource === randomBytes
    && startDaemon === startLinuxSecretServiceDaemon
    && deadlineMs === DEFAULT_QUALIFICATION_DEADLINE_MS;
  const usesNativeBackend = backend === undefined
    && createBackend === defaultCreateBackend;
  if (usesNativeBackend) proveNativeQualificationIsolation(environment);

  try {
    const daemonResult = await withQualificationDeadline(
      deadline,
      () => startDaemon({ environment }),
    );
    if (daemonResult?.status !== "started") fail("daemon_failed");
  } catch (error) {
    if (isLinuxSecretServiceQualificationError(error)) throw error;
    fail("daemon_failed");
  }

  let selectedBackend = backend;
  if (selectedBackend === undefined) {
    try {
      selectedBackend = await withQualificationDeadline(
        deadline,
        () => createBackend({ platform, architecture }),
      );
    } catch {
      fail("backend_unavailable");
    }
  }
  selectedBackend = validateBackend(selectedBackend);
  if (nativeSubject && selectedBackend.bindingProvenanceVerified !== true) {
    try {
      selectedBackend.close();
    } catch {
      // The binding gate below remains authoritative.
    }
    fail("binding_unverified");
  }

  let storeNotEmpty = false;
  let preflightFailed = false;
  let preflightError = null;
  for (const capability of CAPABILITIES) {
    let observed = null;
    try {
      observed = await withQualificationDeadline(
        deadline,
        () => selectedBackend.read(capability),
      );
      if (observed !== null) storeNotEmpty = true;
    } catch (error) {
      if (isLinuxSecretServiceQualificationError(error)
          && error.code === "linux_secret_service_qualification_deadline_exceeded") {
        preflightError = error;
        break;
      }
      preflightFailed = true;
    } finally {
      observed?.fill(0);
    }
  }
  if (storeNotEmpty || preflightFailed || preflightError !== null) {
    let closeFailed = false;
    try {
      selectedBackend.close();
    } catch {
      closeFailed = true;
    }
    if (closeFailed) fail("cleanup_failed");
    if (preflightError !== null) throw preflightError;
    fail(storeNotEmpty ? "store_not_empty" : "lifecycle_failed");
  }

  const secrets = [];
  const owned = new Map();
  let operationError = null;
  let cleanupFailed = false;
  try {
    for (const capability of CAPABILITIES) {
      const original = await randomSecret(randomSource, deadline);
      const replacement = await randomSecret(randomSource, deadline);
      secrets.push(original, replacement);
      if (timingSafeEqual(original, replacement)) fail("random_source_failed");
      await qualifyCapability(
        selectedBackend,
        capability,
        original,
        replacement,
        owned,
        deadline,
      );
    }
  } catch (error) {
    operationError = isLinuxSecretServiceQualificationError(error)
      ? error
      : new LinuxSecretServiceQualificationError("lifecycle_failed");
  } finally {
    for (const capability of CAPABILITIES) {
      try {
        await cleanupCapability(selectedBackend, capability, owned, deadline);
      } catch {
        cleanupFailed = true;
      }
    }
    for (const secret of secrets) secret.fill(0);
    for (const secret of owned.values()) secret.fill(0);
    owned.clear();
    try {
      selectedBackend.close();
    } catch {
      cleanupFailed = true;
    }
  }

  if (cleanupFailed
      && operationError?.code
        === "linux_secret_service_qualification_deadline_exceeded") {
    fail("deadline_cleanup_unproven");
  }
  if (cleanupFailed) fail("cleanup_failed");
  if (operationError !== null) throw operationError;
  return qualificationReceipt(
    nativeSubject ? "pinned_native_binding" : "injected_test",
    selectedBackend,
  );
}

function cliErrorCode(error) {
  if (isLinuxSecretServiceQualificationError(error)) {
    let code;
    try {
      code = error.code;
    } catch {
      return "LINUX_SECRET_SERVICE_QUALIFICATION_UNEXPECTED";
    }
    const prefix = "linux_secret_service_qualification_";
    const suffix = typeof code === "string" && code.startsWith(prefix)
      ? code.slice(prefix.length)
      : "unexpected";
    if (ERROR_CODES.has(suffix)) {
      return `${prefix}${suffix}`.toUpperCase();
    }
  }
  return "LINUX_SECRET_SERVICE_QUALIFICATION_UNEXPECTED";
}

function isMainModule() {
  const argument = process.argv[1];
  if (typeof argument !== "string" || argument.length === 0) return false;
  try {
    return import.meta.url === pathToFileURL(argument).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const hardDeadline = setTimeout(() => {
    process.stderr.write("LINUX_SECRET_SERVICE_QUALIFICATION_DEADLINE_EXCEEDED\n");
    process.exit(1);
  }, CLI_HARD_DEADLINE_MS);
  try {
    const receipt = await runLinuxSecretServiceQualification();
    process.stdout.write(`${JSON.stringify(receipt)}\n`, () => {
      clearTimeout(hardDeadline);
      process.exit(0);
    });
  } catch (error) {
    process.stderr.write(`${cliErrorCode(error)}\n`, () => {
      clearTimeout(hardDeadline);
      process.exit(1);
    });
  }
}
