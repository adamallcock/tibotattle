import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";
import { isProxy } from "node:util/types";

export const LINUX_XDG_PATHS_CONTRACT_VERSION =
  "linux-xdg-paths-v1";
export const LINUX_XDG_APPLICATION_DIRECTORY = "app-usagemonitor";

const MAXIMUM_PATH_BYTES = 4096;
const XDG_ENVIRONMENT_KEYS = Object.freeze([
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
]);
const RESOLVED_ROOTS = new WeakSet();
const VALIDATED_ROOTS = new WeakSet();
const VALIDATION_OPTIONS = new WeakMap();
const VALIDATION_OPTION_KEYS = Object.freeze([
  "platform",
  "currentUid",
  "lstatPath",
  "openPath",
  "realpathPath",
]);
const ERROR_CODES = new Set([
  "configuration_invalid",
  "platform_invalid",
  "home_invalid",
  "config_root_invalid",
  "state_root_invalid",
  "cache_root_invalid",
  "runtime_root_invalid",
  "path_invalid",
  "uid_invalid",
  "directory_missing",
  "directory_type",
  "directory_owner",
  "directory_mode",
  "directory_alias",
  "directory_replaced",
  "ancestor_type",
  "ancestor_owner",
  "ancestor_mode",
  "roots_untrusted",
  "validation_untrusted",
]);

export class LinuxXdgError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) throw new TypeError("Unknown Linux XDG error code");
    super("Linux XDG platform boundary is unavailable");
    this.name = "LinuxXdgError";
    this.code = `linux_xdg_${code}`;
  }
}

function fail(code) {
  throw new LinuxXdgError(code);
}

function plainObject(value) {
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || isProxy(value)) {
    fail("configuration_invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("configuration_invalid");
  }
  return value;
}

function snapshotEnvironment(environment) {
  const source = plainObject(environment);
  const snapshot = {};
  try {
    for (const key of XDG_ENVIRONMENT_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor === undefined) continue;
      if (!Object.hasOwn(descriptor, "value")
          || (descriptor.value !== undefined
            && typeof descriptor.value !== "string")) {
        fail("configuration_invalid");
      }
      if (descriptor.value !== undefined) snapshot[key] = descriptor.value;
    }
  } catch (error) {
    if (error instanceof LinuxXdgError) throw error;
    fail("configuration_invalid");
  }
  return Object.freeze(snapshot);
}

function snapshotValidationOptions(options) {
  const source = plainObject(options);
  const allowed = new Set(VALIDATION_OPTION_KEYS);
  const ownKeys = Reflect.ownKeys(source);
  if (ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    fail("configuration_invalid");
  }
  const selected = {};
  for (const key of VALIDATION_OPTION_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined) continue;
    if (!Object.hasOwn(descriptor, "value")) fail("configuration_invalid");
    selected[key] = descriptor.value;
  }
  const value = Object.freeze({
    platform: selected.platform ?? process.platform,
    currentUid: selected.currentUid
      ?? (typeof process.getuid === "function" ? process.getuid() : null),
    lstatPath: selected.lstatPath ?? lstat,
    openPath: selected.openPath ?? open,
    realpathPath: selected.realpathPath ?? realpath,
  });
  if (value.platform !== "linux"
      || (value.currentUid !== null
        && (!Number.isSafeInteger(value.currentUid) || value.currentUid < 0))
      || typeof value.lstatPath !== "function"
      || typeof value.openPath !== "function"
      || typeof value.realpathPath !== "function") {
    fail("configuration_invalid");
  }
  return value;
}

function exactAbsolutePath(value, code) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > MAXIMUM_PATH_BYTES
      || !posix.isAbsolute(value)
      || posix.resolve(value) !== value
      || value === posix.parse(value).root) {
    fail(code);
  }
  return value;
}

function environmentRoot(environment, key, fallback, code) {
  const value = environment[key];
  if (value === undefined) return fallback;
  return exactAbsolutePath(value, code);
}

function applicationRoots(bases) {
  return Object.freeze({
    config: posix.join(bases.config, LINUX_XDG_APPLICATION_DIRECTORY),
    state: posix.join(bases.state, LINUX_XDG_APPLICATION_DIRECTORY),
    cache: posix.join(bases.cache, LINUX_XDG_APPLICATION_DIRECTORY),
    runtime: bases.runtime === null
      ? null
      : posix.join(bases.runtime, LINUX_XDG_APPLICATION_DIRECTORY),
  });
}

/**
 * Resolve the Linux XDG bases without reading or creating the filesystem.
 *
 * Relative, empty, accessor-backed, proxy-backed, or non-normalized overrides
 * fail closed instead of silently falling back to HOME. XDG_RUNTIME_DIR has no
 * invented fallback: a missing session runtime root is represented as null.
 */
export function resolveLinuxXdgRoots({
  platform = process.platform,
  homeDirectory = homedir(),
  environment = process.env,
} = {}) {
  if (platform !== "linux") fail("platform_invalid");
  const home = exactAbsolutePath(homeDirectory, "home_invalid");
  const snapshot = snapshotEnvironment(environment);
  const bases = Object.freeze({
    config: environmentRoot(
      snapshot,
      "XDG_CONFIG_HOME",
      posix.join(home, ".config"),
      "config_root_invalid",
    ),
    state: environmentRoot(
      snapshot,
      "XDG_STATE_HOME",
      posix.join(home, ".local", "state"),
      "state_root_invalid",
    ),
    cache: environmentRoot(
      snapshot,
      "XDG_CACHE_HOME",
      posix.join(home, ".cache"),
      "cache_root_invalid",
    ),
    runtime: snapshot.XDG_RUNTIME_DIR === undefined
      ? null
      : exactAbsolutePath(snapshot.XDG_RUNTIME_DIR, "runtime_root_invalid"),
  });
  const value = Object.freeze({
    contractVersion: LINUX_XDG_PATHS_CONTRACT_VERSION,
    platform: "linux",
    bases,
    application: applicationRoots(bases),
    autostartDirectory: posix.join(bases.config, "autostart"),
  });
  RESOLVED_ROOTS.add(value);
  return value;
}

function directoryChain(target) {
  const root = posix.parse(target).root;
  const relative = posix.relative(root, target);
  const components = relative === "" ? [] : relative.split("/");
  const chain = [root];
  for (const component of components) {
    chain.push(posix.join(chain.at(-1), component));
  }
  return chain;
}

function safeMode(stats, { target, ownerOnly }) {
  const mode = stats.mode & 0o7777;
  if (target) {
    if ((mode & 0o500) !== 0o500 || (mode & 0o022) !== 0) {
      fail("directory_mode");
    }
    if (ownerOnly && (mode & 0o077) !== 0) fail("directory_mode");
    return;
  }
  // Root-owned sticky directories such as /tmp are valid ancestors. Other
  // group/world-writable ancestors would allow a path component substitution.
  if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
    fail("ancestor_mode");
  }
}

function safeDirectory(stats, {
  target,
  ownerOnly,
  currentUid,
}) {
  if (!stats?.isDirectory?.() || stats?.isSymbolicLink?.()) {
    fail(target ? "directory_type" : "ancestor_type");
  }
  if (currentUid !== null) {
    if (target && stats.uid !== currentUid) fail("directory_owner");
    if (!target && stats.uid !== currentUid && stats.uid !== 0) {
      fail("ancestor_owner");
    }
  }
  safeMode(stats, { target, ownerOnly });
}

function sameDirectoryIdentity(left, right) {
  return left?.dev === right?.dev
    && left?.ino === right?.ino
    && left?.uid === right?.uid
    && (left?.mode & 0o7777) === (right?.mode & 0o7777);
}

/**
 * Open and revalidate one existing Linux-owned directory.
 *
 * The result intentionally contains only numeric identity metadata. Callers
 * already own the selected path and must not copy it into diagnostics.
 */
export async function validateLinuxOwnedDirectory(path, {
  platform = process.platform,
  currentUid = typeof process.getuid === "function" ? process.getuid() : null,
  ownerOnly = false,
  lstatPath = lstat,
  openPath = open,
  realpathPath = realpath,
} = {}) {
  if (platform !== "linux") fail("platform_invalid");
  const selected = exactAbsolutePath(path, "path_invalid");
  if (currentUid !== null
      && (!Number.isSafeInteger(currentUid) || currentUid < 0)) {
    fail("uid_invalid");
  }

  const chain = directoryChain(selected);
  let before;
  try {
    for (const component of chain) {
      const stats = await lstatPath(component);
      const target = component === selected;
      safeDirectory(stats, { target, ownerOnly, currentUid });
      if (target) before = stats;
    }
  } catch (error) {
    if (error instanceof LinuxXdgError) throw error;
    fail("directory_missing");
  }

  let canonical;
  try {
    canonical = await realpathPath(selected);
  } catch {
    fail("directory_missing");
  }
  if (canonical !== selected) fail("directory_alias");

  let handle;
  try {
    handle = await openPath(
      selected,
      constants.O_RDONLY
        | (constants.O_DIRECTORY ?? 0)
        | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    safeDirectory(opened, { target: true, ownerOnly, currentUid });
    if (!sameDirectoryIdentity(before, opened)) fail("directory_replaced");
    const after = await lstatPath(selected);
    safeDirectory(after, { target: true, ownerOnly, currentUid });
    if (!sameDirectoryIdentity(opened, after)) fail("directory_replaced");
    return Object.freeze({
      device: opened.dev,
      inode: opened.ino,
      uid: opened.uid,
      mode: opened.mode & 0o7777,
    });
  } catch (error) {
    if (error instanceof LinuxXdgError) throw error;
    fail("directory_replaced");
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Validate every application-owned XDG root before later composition uses it.
 * Runtime state remains explicitly unavailable when the session does not
 * provide XDG_RUNTIME_DIR; no persistent-directory fallback is synthesized.
 */
export async function validateLinuxXdgRoots(roots, options = {}) {
  if (!RESOLVED_ROOTS.has(roots)) fail("roots_untrusted");
  const validationOptions = snapshotValidationOptions(options);
  const identities = {};
  for (const kind of ["config", "state", "cache"]) {
    identities[kind] = await validateLinuxOwnedDirectory(
      roots.application[kind],
      { ...validationOptions, ownerOnly: true },
    );
  }
  if (roots.application.runtime !== null) {
    identities.runtime = await validateLinuxOwnedDirectory(
      roots.application.runtime,
      { ...validationOptions, ownerOnly: true },
    );
  } else {
    identities.runtime = null;
  }
  const validation = Object.freeze({
    contractVersion: LINUX_XDG_PATHS_CONTRACT_VERSION,
    platform: "linux",
    roots,
    identities: Object.freeze(identities),
    runtimeAvailable: roots.application.runtime !== null,
  });
  VALIDATED_ROOTS.add(validation);
  VALIDATION_OPTIONS.set(validation, validationOptions);
  return validation;
}

/**
 * Re-open every selected root and compare it with the identity originally
 * authorized by validateLinuxXdgRoots(). A branded validation is provenance,
 * not a permanent filesystem capability: dormant composition must revalidate
 * it at the point where paths are derived.
 */
export async function revalidateLinuxXdgRoots(value) {
  if (!VALIDATED_ROOTS.has(value)) fail("validation_untrusted");
  const options = VALIDATION_OPTIONS.get(value);
  if (options === undefined) fail("validation_untrusted");
  for (const kind of ["config", "state", "cache", "runtime"]) {
    const expected = value.identities[kind];
    const selectedPath = value.roots.application[kind];
    if (expected === null && selectedPath === null) continue;
    if (expected === null || selectedPath === null) fail("directory_replaced");
    const observed = await validateLinuxOwnedDirectory(selectedPath, {
      ...options,
      ownerOnly: true,
    });
    if (observed.device !== expected.device
        || observed.inode !== expected.inode
        || observed.uid !== expected.uid
        || observed.mode !== expected.mode) {
      fail("directory_replaced");
    }
  }
  return value;
}

export function assertValidatedLinuxXdgRoots(value) {
  if (!VALIDATED_ROOTS.has(value)) fail("validation_untrusted");
  return value;
}
