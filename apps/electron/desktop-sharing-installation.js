import { lstat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Installation classification is deliberately a metadata-only launch input.
 * It does not read, create, or repair any state. The policy controller owns the
 * contents of an accountless-sharing record after this conservative check.
 */
export const DESKTOP_SHARING_INSTALLATION_STATES = Object.freeze({
  FRESH: "fresh",
  EXISTING_UNSELECTED: "existing_unselected",
  EXISTING: "existing",
  UNKNOWN: "unknown",
});

const ABSENT = "absent";
const PRESENT = "present";
const UNKNOWN = DESKTOP_SHARING_INSTALLATION_STATES.UNKNOWN;

const PROFILE_MARKERS = Object.freeze([
  Object.freeze({ relativePath: "desktop-settings/desktop-first-run-v1.json", sharing: false }),
  Object.freeze({ relativePath: "desktop-settings/desktop-settings-v1.json", sharing: false }),
  Object.freeze({ relativePath: "desktop-settings/accountless-sharing-v1.json", sharing: true }),
]);

const STATE_MARKERS = Object.freeze([
  Object.freeze({ relativePath: "local-unified-index-v1.sqlite", sharing: false }),
  Object.freeze({ relativePath: "local-collector-state-v1.sqlite", sharing: false }),
  Object.freeze({ relativePath: "private/automatic-contribution-v0.1.json", sharing: true }),
  Object.freeze({ relativePath: "private/incremental-contribution-sync-v1.json", sharing: true }),
]);

function isNonEmptyPath(value) {
  return typeof value === "string" && value.length > 0;
}

function currentUid() {
  if (typeof process.getuid !== "function") return null;
  try {
    return process.getuid();
  } catch {
    return null;
  }
}

function hasForeignOwner(metadata, uid) {
  try {
    if (!Object.hasOwn(metadata, "uid")) return false;
    if (!Number.isSafeInteger(metadata.uid)) return true;
    return uid !== null && metadata.uid !== uid;
  } catch {
    return true;
  }
}

function isSymbolicLink(metadata) {
  try {
    if (typeof metadata.isSymbolicLink !== "function") return false;
    return metadata.isSymbolicLink() === true;
  } catch {
    return true;
  }
}

async function inspectFile(path, inspectPath, uid) {
  let metadata;
  try {
    metadata = await inspectPath(path);
  } catch (error) {
    return error?.code === "ENOENT" ? ABSENT : UNKNOWN;
  }

  if (metadata === null || typeof metadata !== "object") return UNKNOWN;
  if (isSymbolicLink(metadata) || hasForeignOwner(metadata, uid)) return UNKNOWN;

  let file;
  try {
    if (typeof metadata.isFile !== "function") return UNKNOWN;
    file = metadata.isFile();
  } catch {
    return UNKNOWN;
  }
  return file === true ? PRESENT : UNKNOWN;
}

async function inspectDirectory(path, inspectPath, uid) {
  let metadata;
  try {
    metadata = await inspectPath(path);
  } catch (error) {
    return error?.code === "ENOENT" ? ABSENT : UNKNOWN;
  }

  if (metadata === null || typeof metadata !== "object") return UNKNOWN;
  if (isSymbolicLink(metadata) || hasForeignOwner(metadata, uid)) return UNKNOWN;

  let directory;
  try {
    if (typeof metadata.isDirectory !== "function") return UNKNOWN;
    directory = metadata.isDirectory();
  } catch {
    return UNKNOWN;
  }
  return directory === true ? PRESENT : UNKNOWN;
}

async function inspectMarkers(root, markers, inspectPath, uid) {
  const result = { managed: false, sharing: false };
  for (const marker of markers) {
    const status = await inspectFile(join(root, marker.relativePath), inspectPath, uid);
    if (status === UNKNOWN) return UNKNOWN;
    if (status !== PRESENT) continue;
    result.managed = true;
    result.sharing ||= marker.sharing;
  }
  return result;
}

function emptyMarkers() {
  return { managed: false, sharing: false };
}

function mergeMarkers(...groups) {
  return groups.reduce((result, group) => ({
    managed: result.managed || group.managed,
    sharing: result.sharing || group.sharing,
  }), emptyMarkers());
}

async function inspectProfileRoot(root, inspectPath, uid) {
  const rootStatus = await inspectDirectory(root, inspectPath, uid);
  if (rootStatus === UNKNOWN) return UNKNOWN;
  if (rootStatus === ABSENT) return emptyMarkers();

  const settingsPath = join(root, "desktop-settings");
  const settingsStatus = await inspectDirectory(settingsPath, inspectPath, uid);
  if (settingsStatus === UNKNOWN) return UNKNOWN;
  if (settingsStatus === ABSENT) return emptyMarkers();
  return inspectMarkers(root, PROFILE_MARKERS, inspectPath, uid);
}

async function inspectStateRoot(root, inspectPath, uid) {
  const rootStatus = await inspectDirectory(root, inspectPath, uid);
  if (rootStatus === UNKNOWN) return UNKNOWN;
  if (rootStatus === ABSENT) {
    return { rootStatus, markers: emptyMarkers() };
  }

  const topLevel = await inspectMarkers(root, STATE_MARKERS.slice(0, 2), inspectPath, uid);
  if (topLevel === UNKNOWN) return UNKNOWN;
  const privatePath = join(root, "private");
  const privateStatus = await inspectDirectory(privatePath, inspectPath, uid);
  if (privateStatus === UNKNOWN) return UNKNOWN;
  const privateMarkers = privateStatus === PRESENT
    ? await inspectMarkers(root, STATE_MARKERS.slice(2), inspectPath, uid)
    : emptyMarkers();
  if (privateMarkers === UNKNOWN) return UNKNOWN;
  return {
    rootStatus,
    markers: mergeMarkers(topLevel, privateMarkers),
  };
}

/**
 * Classify a desktop installation without trusting state contents.
 *
 * `profileRoot` may be an empty directory created by Electron, so root
 * existence alone never makes the current installation existing. A supplied
 * legacy state root is different: its existence is itself evidence that the
 * installation may have prior state and therefore prevents a `fresh` result.
 * A complete uninstall that removes every marker can still look fresh; this
 * classifier cannot recover history that the filesystem no longer contains.
 */
export async function classifyDesktopSharingInstallation({
  profileRoot,
  stateRoot,
  legacyStateRoots = [],
  inspectPath = lstat,
} = {}) {
  if (!isNonEmptyPath(profileRoot)
    || !isNonEmptyPath(stateRoot)
    || !Array.isArray(legacyStateRoots)
    || legacyStateRoots.some((root) => !isNonEmptyPath(root))
    || typeof inspectPath !== "function") {
    return UNKNOWN;
  }

  const uid = currentUid();
  const profile = await inspectProfileRoot(profileRoot, inspectPath, uid);
  if (profile === UNKNOWN) return UNKNOWN;
  const state = await inspectStateRoot(stateRoot, inspectPath, uid);
  if (state === UNKNOWN) return UNKNOWN;

  let managed = profile.managed || state.markers.managed;
  let sharing = profile.sharing || state.markers.sharing;

  for (const legacyRoot of legacyStateRoots) {
    const legacyState = await inspectStateRoot(legacyRoot, inspectPath, uid);
    if (legacyState === UNKNOWN) return UNKNOWN;
    if (legacyState.rootStatus === ABSENT) continue;

    // An empty legacy root is still prior managed state. Probe only the
    // reviewed marker names beneath it; never discover or enumerate files.
    managed = true;
    sharing ||= legacyState.markers.sharing;
  }

  if (sharing) return DESKTOP_SHARING_INSTALLATION_STATES.EXISTING;
  if (managed) return DESKTOP_SHARING_INSTALLATION_STATES.EXISTING_UNSELECTED;
  return DESKTOP_SHARING_INSTALLATION_STATES.FRESH;
}
