import { createHash, randomUUID } from "node:crypto";

/**
 * The Electron settings record deliberately models Codex roots separately
 * from the scalar CODEX_HOME environment variable.  A root is a physical
 * activity source; it is not a new account or an upload identity.
 *
 * This module contains the pure, filesystem-free part of that model.  The
 * platform layer is responsible for choosing and checking a path.  Keeping
 * path checks here lexical means the same persisted record can be validated
 * on macOS and Windows without pretending that validation proves reachability.
 */

export const DESKTOP_CODEX_ROOT_MAX = 8;
export const MAX_CODEX_ACTIVITY_ROOTS = DESKTOP_CODEX_ROOT_MAX;
export const DESKTOP_CODEX_ROOT_KINDS = Object.freeze(["default", "custom"]);
export const DESKTOP_DEFAULT_CODEX_ROOT_ID =
  "00000000-0000-4000-8000-000000000001";
export const DEFAULT_CODEX_ACTIVITY_ROOT_ID = DESKTOP_DEFAULT_CODEX_ROOT_ID;
export const DESKTOP_CODEX_ROOT_MAX_PATH_BYTES = 4_096;

const ROOT_KEYS = Object.freeze(["rootId", "kind", "path", "enabled"]);
const ROOT_PATH_FREE_KEYS = Object.freeze(["rootId", "kind", "enabled"]);
const CONFIGURATION_KEYS = Object.freeze(["activityRoots", "primaryRootId"]);
// Root IDs are opaque to the renderer but still use one canonical UUID
// spelling at the persistence boundary. This avoids accepting paths, labels,
// or attacker-controlled structured-clone values as identities.
const ROOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertPlainRecord(value, label) {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object`);
  return value;
}

function hasExactKeys(value, expectedKeys) {
  return isPlainRecord(value)
    && Reflect.ownKeys(value).length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function assertExactKeys(value, expectedKeys, label) {
  assertPlainRecord(value, label);
  if (!hasExactKeys(value, expectedKeys)) {
    throw new TypeError(`${label} has unexpected keys`);
  }
  return value;
}

function freezeRoot(root) {
  return Object.freeze({
    rootId: root.rootId,
    kind: root.kind,
    path: root.path,
    enabled: root.enabled,
  });
}

function freezePathFreeRoot(root) {
  return Object.freeze({
    rootId: root.rootId,
    kind: root.kind,
    enabled: root.enabled,
  });
}

function freezeConfiguration(activityRoots, primaryRootId) {
  return Object.freeze({
    activityRoots: Object.freeze(activityRoots.map(freezeRoot)),
    primaryRootId,
  });
}

function freezePathFreeConfiguration(activityRoots, primaryRootId) {
  return Object.freeze({
    activityRoots: Object.freeze(activityRoots.map(freezePathFreeRoot)),
    primaryRootId,
  });
}

function utf8ByteLength(value) {
  try {
    if (typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function") {
      return Buffer.byteLength(value, "utf8");
    }
    return new TextEncoder().encode(value).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function assertRootId(value, label = "rootId") {
  if (typeof value !== "string" || !ROOT_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function looksLikeWindowsPath(value) {
  if (/^[A-Za-z]:[\\/]/u.test(value)) return true;
  // A UNC path must contain both a server and a share. Bare `\\` and
  // server-only spellings are not roots. Windows extended-length spellings
  // retain the same requirement while permitting a drive path or UNC path.
  if (/^\\\\(?![?.](?:[\\/]|$))[^\\/\0]+[\\/][^\\/\0]+(?:[\\/]|$)/u.test(value)) return true;
  if (/^\\\\\?\\[A-Za-z]:[\\/]/u.test(value)) return true;
  return /^\\\\\?\\UNC\\[^\\/\0]+[\\/][^\\/\0]+(?:[\\/]|$)/iu.test(value);
}

/**
 * Check an absolute path without using node:path.  The settings model is
 * loaded on one host and may be inspected by a test double for another host,
 * so host-native `isAbsolute` would reject valid Windows values on macOS.
 */
export function isAbsoluteCodexPath(value) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || utf8ByteLength(value) > DESKTOP_CODEX_ROOT_MAX_PATH_BYTES) {
    return false;
  }
  return value.startsWith("/") || looksLikeWindowsPath(value);
}

function normalizeTrailingSeparators(value) {
  if (value === "/"
      || /^[A-Za-z]:[\\/]$/u.test(value)
      || /^\\\\\?\\[A-Za-z]:[\\/]$/u.test(value)) {
    return value;
  }
  return value.replace(/[\\/]+$/u, "");
}

/**
 * Return the comparison spelling used for duplicate-path rejection.  Native
 * pickers are expected to provide canonical paths, but this still protects
 * against obvious slash/trailing-separator/case aliases before a picker is
 * involved.  POSIX paths retain case; Windows paths do not.
 */
export function normalizeCodexPathForComparison(value) {
  if (!isAbsoluteCodexPath(value)) throw new TypeError("path is invalid");
  const trimmed = normalizeTrailingSeparators(value);
  if (looksLikeWindowsPath(trimmed)) {
    return trimmed.replaceAll("/", "\\").toLowerCase();
  }
  return trimmed;
}

export function isValidCodexRootId(value) {
  return typeof value === "string" && ROOT_ID_PATTERN.test(value);
}

function validateRoot(value, { allowPathFree = false } = {}) {
  if (allowPathFree) {
    assertExactKeys(value, ROOT_PATH_FREE_KEYS, "activity root");
  } else {
    assertExactKeys(value, ROOT_KEYS, "activity root");
  }
  const rootId = assertRootId(value.rootId, "activity root.rootId");
  if (!DESKTOP_CODEX_ROOT_KINDS.includes(value.kind)) {
    throw new TypeError("activity root.kind is invalid");
  }
  if (value.enabled !== true) {
    throw new TypeError("activity root.enabled is invalid");
  }
  if (value.kind === "default") {
    if (rootId !== DESKTOP_DEFAULT_CODEX_ROOT_ID) {
      throw new TypeError("default activity root.rootId is invalid");
    }
    if (!allowPathFree && value.path !== null) {
      throw new TypeError("default activity root.path must be null");
    }
  } else {
    if (rootId === DESKTOP_DEFAULT_CODEX_ROOT_ID) {
      throw new TypeError("custom activity root.rootId is reserved");
    }
    if (!allowPathFree && !isAbsoluteCodexPath(value.path)) {
      throw new TypeError("custom activity root.path is invalid");
    }
  }
  return allowPathFree
    ? Object.freeze({ rootId, kind: value.kind, enabled: true })
    : freezeRoot({ rootId, kind: value.kind, path: value.path, enabled: true });
}

function assertConfigurationShape(value) {
  assertExactKeys(value, CONFIGURATION_KEYS, "codexHomes");
  if (!Array.isArray(value.activityRoots)
      || value.activityRoots.length < 1
      || value.activityRoots.length > DESKTOP_CODEX_ROOT_MAX) {
    throw new TypeError("codexHomes.activityRoots must contain one to eight roots");
  }
  assertRootId(value.primaryRootId, "codexHomes.primaryRootId");
}

/**
 * Validate and deeply freeze one persisted pathful root configuration.
 * Missing paths are intentionally valid here: reachability belongs to the
 * runtime and a detached root must remain configured for LKG/partial status.
 */
export function normalizeCodexHomes(value) {
  assertConfigurationShape(value);
  const roots = value.activityRoots.map((root) => validateRoot(root));
  const ids = new Set();
  const paths = new Set();
  let defaultCount = 0;
  for (const root of roots) {
    if (ids.has(root.rootId)) throw new TypeError("codexHomes root IDs must be unique");
    ids.add(root.rootId);
    if (root.kind === "default") {
      defaultCount += 1;
      if (defaultCount > 1) throw new TypeError("codexHomes allows one default root");
    } else {
      const pathKey = normalizeCodexPathForComparison(root.path);
      if (paths.has(pathKey)) throw new TypeError("codexHomes paths must be unique");
      paths.add(pathKey);
    }
  }
  if (!ids.has(value.primaryRootId)) {
    throw new TypeError("codexHomes.primaryRootId must identify a configured root");
  }
  return freezeConfiguration(roots, value.primaryRootId);
}

export const validateCodexHomes = normalizeCodexHomes;

/** Validate a path-free metadata projection. */
export function normalizePathFreeCodexHomes(value) {
  assertConfigurationShape(value);
  const roots = value.activityRoots.map((root) => validateRoot(root, { allowPathFree: true }));
  const ids = new Set();
  let defaultCount = 0;
  for (const root of roots) {
    if (ids.has(root.rootId)) throw new TypeError("codexHomes root IDs must be unique");
    ids.add(root.rootId);
    if (root.kind === "default") {
      defaultCount += 1;
      if (defaultCount > 1) throw new TypeError("codexHomes allows one default root");
    }
  }
  if (!ids.has(value.primaryRootId)) {
    throw new TypeError("codexHomes.primaryRootId must identify a configured root");
  }
  return freezePathFreeConfiguration(roots, value.primaryRootId);
}

export function projectCodexHomesPathFree(value) {
  const normalized = normalizeCodexHomes(value);
  return freezePathFreeConfiguration(normalized.activityRoots, normalized.primaryRootId);
}

export const pathFreeCodexHomesProjection = projectCodexHomesPathFree;

export function projectCodexHomesForSettings(value) {
  const normalized = normalizeCodexHomes(value);
  return freezeConfiguration(normalized.activityRoots, normalized.primaryRootId);
}

export const codexHomesSettingsProjection = projectCodexHomesForSettings;

export function createDefaultCodexHomes() {
  return freezeConfiguration([
    {
      rootId: DESKTOP_DEFAULT_CODEX_ROOT_ID,
      kind: "default",
      path: null,
      enabled: true,
    },
  ], DESKTOP_DEFAULT_CODEX_ROOT_ID);
}

export const defaultCodexHomes = createDefaultCodexHomes;

function idFactoryFrom(options) {
  const idFactory = options?.idFactory ?? randomUUID;
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
  return idFactory;
}

function deterministicLegacyRootId(path) {
  const digest = createHash("sha256")
    .update(normalizeCodexPathForComparison(path), "utf8")
    .digest("hex");
  // UUID v4/variant bits keep the public shape identical to random IDs while
  // making a legacy migration stable if its first persistence attempt fails.
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(12, 15)}-8${digest.slice(16, 19)}-${digest.slice(20, 32)}`;
}

function legacyIdFactory(legacyPath, options) {
  if (options !== null
      && typeof options === "object"
      && Object.hasOwn(options, "idFactory")
      && options.idFactory !== undefined) {
    return idFactoryFrom(options);
  }
  return () => deterministicLegacyRootId(legacyPath);
}

function generatedRootId(configuration, idFactory) {
  let generated;
  try {
    generated = idFactory();
  } catch {
    throw new TypeError("idFactory failed");
  }
  assertRootId(generated, "generated rootId");
  if (generated === DESKTOP_DEFAULT_CODEX_ROOT_ID
      || configuration.activityRoots.some((root) => root.rootId === generated)) {
    throw new TypeError("generated rootId is already in use");
  }
  return generated;
}

function rootIndex(configuration, rootId) {
  assertRootId(rootId);
  const index = configuration.activityRoots.findIndex((root) => root.rootId === rootId);
  if (index < 0) throw new TypeError("rootId does not identify a configured root");
  return index;
}

function requireCustomPath(path) {
  if (!isAbsoluteCodexPath(path)) throw new TypeError("path is invalid");
  return path;
}

export function addCodexHomeToConfiguration(configuration, { path, idFactory } = {}) {
  const current = normalizeCodexHomes(configuration);
  if (current.activityRoots.length >= DESKTOP_CODEX_ROOT_MAX) {
    throw new TypeError("codexHomes already contains eight roots");
  }
  const selectedPath = requireCustomPath(path);
  const selectedKey = normalizeCodexPathForComparison(selectedPath);
  if (current.activityRoots.some((root) => root.kind === "custom"
      && normalizeCodexPathForComparison(root.path) === selectedKey)) {
    throw new TypeError("codexHomes paths must be unique");
  }
  const rootId = generatedRootId(current, idFactoryFrom({ idFactory }));
  return normalizeCodexHomes({
    activityRoots: [...current.activityRoots, {
      rootId,
      kind: "custom",
      path: selectedPath,
      enabled: true,
    }],
    primaryRootId: current.primaryRootId,
  });
}

export const addCodexRoot = addCodexHomeToConfiguration;

export function editCodexHomeInConfiguration(configuration, { rootId, path } = {}) {
  const current = normalizeCodexHomes(configuration);
  const index = rootIndex(current, rootId);
  if (current.activityRoots[index].kind !== "custom") {
    throw new TypeError("the default activity root cannot be edited");
  }
  const selectedPath = requireCustomPath(path);
  const selectedKey = normalizeCodexPathForComparison(selectedPath);
  if (current.activityRoots.some((root, rootIndexValue) => rootIndexValue !== index
      && root.kind === "custom"
      && normalizeCodexPathForComparison(root.path) === selectedKey)) {
    throw new TypeError("codexHomes paths must be unique");
  }
  const activityRoots = current.activityRoots.map((root, rootIndexValue) => rootIndexValue === index
    ? { ...root, path: selectedPath }
    : root);
  return normalizeCodexHomes({ activityRoots, primaryRootId: current.primaryRootId });
}

export const editCodexRoot = editCodexHomeInConfiguration;

export function removeCodexHomeFromConfiguration(configuration, { rootId } = {}) {
  const current = normalizeCodexHomes(configuration);
  const index = rootIndex(current, rootId);
  if (current.activityRoots.length <= 1) {
    throw new TypeError("codexHomes must retain one root");
  }
  if (current.primaryRootId === rootId) {
    throw new TypeError("select another primary root before removing this root");
  }
  const activityRoots = current.activityRoots.filter((_root, rootIndexValue) => rootIndexValue !== index);
  return normalizeCodexHomes({ activityRoots, primaryRootId: current.primaryRootId });
}

export const removeCodexRoot = removeCodexHomeFromConfiguration;

export function setPrimaryCodexHomeInConfiguration(configuration, { rootId } = {}) {
  const current = normalizeCodexHomes(configuration);
  rootIndex(current, rootId);
  return normalizeCodexHomes({
    activityRoots: current.activityRoots,
    primaryRootId: rootId,
  });
}

export const setPrimaryCodexRoot = setPrimaryCodexHomeInConfiguration;

export function reorderCodexHomesConfiguration(configuration, { rootIds } = {}) {
  const current = normalizeCodexHomes(configuration);
  if (!Array.isArray(rootIds)
      || rootIds.length !== current.activityRoots.length
      || rootIds.some((rootId) => !isValidCodexRootId(rootId))) {
    throw new TypeError("rootIds must list every configured root exactly once");
  }
  const configured = new Set(current.activityRoots.map((root) => root.rootId));
  const requested = new Set(rootIds);
  if (requested.size !== rootIds.length
      || requested.size !== configured.size
      || [...requested].some((rootId) => !configured.has(rootId))) {
    throw new TypeError("rootIds must list every configured root exactly once");
  }
  const byId = new Map(current.activityRoots.map((root) => [root.rootId, root]));
  return normalizeCodexHomes({
    activityRoots: rootIds.map((rootId) => byId.get(rootId)),
    primaryRootId: current.primaryRootId,
  });
}

export const reorderCodexRoots = reorderCodexHomesConfiguration;

export function resetCodexHomesToDefault() {
  return createDefaultCodexHomes();
}

function legacyHomeToConfiguration(legacyHome, options = {}) {
  if (typeof legacyHome === "string") {
    requireCustomPath(legacyHome);
    const rootId = generatedRootId(
      createDefaultCodexHomes(),
      legacyIdFactory(legacyHome, options),
    );
    return normalizeCodexHomes({
      activityRoots: [{ rootId, kind: "custom", path: legacyHome, enabled: true }],
      primaryRootId: rootId,
    });
  }
  assertExactKeys(legacyHome, ["mode", "path"], "codexHome");
  if (legacyHome.mode === "default" && legacyHome.path === null) {
    return createDefaultCodexHomes();
  }
  if (legacyHome.mode !== "custom") throw new TypeError("codexHome.mode is invalid");
  requireCustomPath(legacyHome.path);
  const rootId = generatedRootId(
    createDefaultCodexHomes(),
    legacyIdFactory(legacyHome.path, options),
  );
  return normalizeCodexHomes({
    activityRoots: [{ rootId, kind: "custom", path: legacyHome.path, enabled: true }],
    primaryRootId: rootId,
  });
}

/** Migrate the original scalar/object codexHome value to one v2 root. */
export function migrateLegacyCodexHome(legacyHome, options = {}) {
  return legacyHomeToConfiguration(legacyHome, options);
}

export const migrateCodexHome = migrateLegacyCodexHome;

export function createSingletonCustomCodexHomes(path, options = {}) {
  return legacyHomeToConfiguration(path, options);
}
