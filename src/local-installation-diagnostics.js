import { randomUUID } from "node:crypto";
import { constants, lstatSync, mkdirSync, realpathSync } from "node:fs";
import {
  lstat,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { defaultExportStateDirectory } from "./export-identity.js";
import {
  assertWindowsFilesystemProductionSafe,
  isWindowsFilesystemAdapter,
  isWindowsFilesystemIdentity,
  isWindowsQualificationModeContextFor,
} from "./platform/index.js";

export const LOCAL_ONBOARDING_SCHEMA_VERSION = "local-onboarding-v0.2";
export const MAXIMUM_OBSERVED_ROLLOUT_FILES = 100;
const DIRECTORY_STATUSES = new Set([
  "readable",
  "missing",
  "unreadable",
]);
const SOURCE_STATUSES = new Set([
  "ready",
  "codex_home_missing",
  "codex_home_unreadable",
  "session_directories_missing",
  "session_directories_unreadable",
  "no_rollout_files",
]);
function configurationError() {
  const error = new TypeError("Local installation configuration is invalid");
  error.code = "USAGE_MONITOR_LOCAL_INSTALLATION_INVALID";
  return error;
}

function resolveWindowsFilesystemAdapter(
  adapter,
  {
    windowsQualificationModeContext = null,
    stateRoot = null,
    resourceRoot = null,
  } = {},
) {
  const selected = adapter ?? null;
  // Keep the existing Node filesystem path available for portable and
  // development Windows runs. A supplied adapter is a privileged native
  // boundary and cannot be a virtual or copied object.
  if (selected === null) {
    if (windowsQualificationModeContext !== null) throw configurationError();
    return null;
  }
  if (process.platform !== "win32" || !isWindowsFilesystemAdapter(selected)) {
    throw configurationError();
  }
  try {
    // The packaged Windows Electron smoke lane deliberately loads the real
    // native adapter before it has production-safe claims.  Its child process
    // receives no parent context object, so the local companion reconstructs
    // this narrow capability from the exact, branded context created in this
    // process.  The context's weak identity binding still authenticates the
    // adapter and its resource manifest; copied or forged objects remain
    // indistinguishable from an absent capability.
    if (windowsQualificationModeContext !== null) {
      // Never validate a capability against roots read back from the
      // capability itself. Callers must provide the concrete roots for the
      // operation being authorized, otherwise an omitted argument could turn
      // this into a self-validating bearer object.
      if (typeof stateRoot !== "string" || typeof resourceRoot !== "string") {
        throw configurationError();
      }
      if (isWindowsQualificationModeContextFor({
        context: windowsQualificationModeContext,
        adapter: selected,
        stateRoot,
        resourceRoot,
      }) !== true) {
        throw configurationError();
      }
      return selected;
    }
    return assertWindowsFilesystemProductionSafe(selected);
  } catch {
    throw configurationError();
  }
}

function normalizedAbsolutePath(value) {
  if (typeof value !== "string"
      || value.length < 1
      || value.length > 4_096
      || value.includes("\0")
      || !isAbsolute(value)) {
    throw configurationError();
  }
  const selected = resolve(value);
  if (selected === parse(selected).root) throw configurationError();
  return selected;
}

export function assertLocalAbsolutePath(value) {
  return normalizedAbsolutePath(value);
}

function pathWithin(root, candidate, { allowRoot = false } = {}) {
  const child = relative(root, candidate);
  return (allowRoot && child === "")
    || (child !== ""
      && child !== ".."
      && !child.startsWith(`..${sep}`)
      && !isAbsolute(child));
}

function assertDirectory(
  path,
  {
    ownerOnly = false,
    windowsFilesystemAdapter = null,
    windowsQualificationModeContext = null,
    windowsQualificationStateRoot = null,
    windowsQualificationResourceRoot = null,
  } = {},
) {
  const windowsFilesystem = resolveWindowsFilesystemAdapter(
    windowsFilesystemAdapter,
    {
      windowsQualificationModeContext,
      stateRoot: windowsQualificationStateRoot,
      resourceRoot: windowsQualificationResourceRoot,
    },
  );
  if (windowsFilesystem) {
    let metadata;
    try {
      metadata = windowsFilesystem.inspectPath(path);
    } catch {
      throw configurationError();
    }
    const protectedDirectory = metadata !== null
      && typeof metadata === "object"
      && !Array.isArray(metadata)
      && metadata.isDirectory === true
      && metadata.isReparsePoint === false
      && metadata.finalPathResolved === true
      && isWindowsFilesystemIdentity(metadata.identity)
      && (!ownerOnly || (metadata.ownerMatches === true
        && metadata.daclProtected === true
        && metadata.nullDacl === false
        && metadata.broadAccess === false
        && metadata.nonOwnerAllow === false
        && metadata.unrecognizedAce === false));
    if (!protectedDirectory) {
      throw configurationError();
    }
    return metadata;
  }
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw configurationError();
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw configurationError();
  }
  if (ownerOnly
      && typeof process.getuid === "function"
      && typeof metadata.uid === "number"
      && metadata.uid !== process.getuid()) {
    throw configurationError();
  }
  if (ownerOnly
      && process.platform !== "win32"
      && (metadata.mode & 0o077) !== 0) {
    throw configurationError();
  }
  return metadata;
}

function canonicalProspectivePath(path) {
  const suffix = [];
  let cursor = path;
  while (true) {
    try {
      lstatSync(cursor);
      return resolve(realpathSync(cursor), ...suffix);
    } catch (error) {
      if (error?.code !== "ENOENT") throw configurationError();
      const parent = dirname(cursor);
      if (parent === cursor) throw configurationError();
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function assertNoSymlinkBelow(root, candidate) {
  const child = relative(root, candidate);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`)) {
    throw configurationError();
  }
  let cursor = root;
  for (const component of child.split(sep)) {
    cursor = join(cursor, component);
    let metadata;
    try {
      metadata = lstatSync(cursor);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw configurationError();
    }
    if (metadata.isSymbolicLink()) throw configurationError();
  }
}

export function defaultLocalCompanionStateRoot({
  platform = process.platform,
  homeDirectory = homedir(),
  environment = process.env,
} = {}) {
  return defaultExportStateDirectory({
    platform,
    homeDirectory,
    environment,
  });
}

export function localCompanionStatePaths(stateRoot) {
  const selected = normalizedAbsolutePath(stateRoot);
  return Object.freeze({
    // One SQLite database owns collector records, cursors, dedupe state,
    // quota observations, the instance lock and replay-safe accounting. The
    // legacy JSON/JSONL files are discovered privately by the migration code
    // and removed only after its parity receipt is durable.
    collectorStateFile: join(selected, "local-collector-state-v1.sqlite"),
    // Dormant rollback-only state. Unified mode never reads or advances these
    // files, but their exact locations remain stable for one reversible
    // release so selecting legacy authority is explicit and diagnosable.
    legacyAnalysisIndexFile: join(
      selected,
      "local-analysis-index-v2.sqlite",
    ),
    legacyAnalysisIndexSecretFile: join(
      selected,
      "local-analysis-index-secret-v2",
    ),
    archiveAccountingIndexFile: join(
      selected,
      "local-archive-accounting-index-v1.sqlite",
    ),
    archiveAccountingIndexSecretFile: join(
      selected,
      "local-archive-accounting-index-v1-secret",
    ),
    // The unified local index: the one store the dashboard's full-history
    // periods and timelines read, advanced incrementally on refresh.
    unifiedIndexFile: join(selected, "local-unified-index-v1.sqlite"),
    unifiedIndexSecretFile: join(
      selected,
      "local-unified-index-device-salt-v1",
    ),
    // Claude Desktop plan quota is intentionally outside the Codex collector
    // database. Its source/account pseudonyms use a distinct owner-only key,
    // so neither product's local identity namespace can be joined to the
    // other by accident.
    claudeDesktopQuotaStateFile: join(
      selected,
      "claude-desktop-quota-state-v1.sqlite",
    ),
    claudeDesktopQuotaSecretFile: join(
      selected,
      "claude-desktop-quota-state-v1-secret",
    ),
    // Reserved, provider-isolated paths for the opt-in development shadow.
    // Merely resolving installation paths never creates these files; the
    // installed companion leaves shadow usage disabled until a reviewed
    // caller explicitly enables it.
    claudeDesktopShadowCanonicalFile: join(
      selected,
      "claude-desktop-shadow-canonical-v1.sqlite",
    ),
    claudeDesktopShadowLedgerFile: join(
      selected,
      "claude-desktop-shadow-ledger-v1.sqlite",
    ),
    claudeDesktopShadowStateFile: join(
      selected,
      "claude-desktop-shadow-state-v1.sqlite",
    ),
    claudeDesktopShadowSecretFile: join(
      selected,
      "claude-desktop-shadow-state-v1-secret",
    ),
    claudeDesktopPricingCacheFile: join(
      selected,
      "claude-desktop-pricing-cache-v1.sqlite",
    ),
    accountObservationLockFile: join(
      selected,
      "account-observation-operation.lock",
    ),
    activityMarkersFile: join(selected, "activity-markers-v0.1.jsonl"),
    contributionQueueFile: join(
      selected,
      "private",
      "contribution-sync-v0.1.sqlite3",
    ),
    automaticContributionSettingsFile: join(
      selected,
      "private",
      "automatic-contribution-v0.1.json",
    ),
    automaticContributionLockFile: join(
      selected,
      "private",
      "automatic-contribution-v0.1.lock",
    ),
    incrementalContributionSyncSettingsFile: join(
      selected,
      "private",
      "incremental-contribution-sync-v1.json",
    ),
    // The temporary OAuth result read-back capability must survive the native
    // companion's random loopback port changing across a relaunch. It contains
    // no proof or account data and expires after fifteen minutes, but it is
    // still kept beside the other owner-only contribution state.
    hostedSignInHandoffFile: join(
      selected,
      "private",
      "hosted-signin-handoff-v1.json",
    ),
    fastModePreferenceFile: join(
      selected,
      "private",
      "fast-mode-preference-v0.1.json",
    ),
    codexSpeedBaselineFile: join(
      selected,
      "private",
      "codex-speed-baseline-v0.1.json",
    ),
    preparedSpoolDirectory: join(
      selected,
      "local-contribution-prepared-v0.1",
    ),
    reviewArchiveDirectory: join(
      selected,
      "local-contribution-reviews-v0.1",
    ),
    exportParticipantSecretFile: join(
      selected,
      "export-participant-secret",
    ),
    contributionDeviceStateFile: join(
      selected,
      "contribution-device-binding-v1.json",
    ),
    contributionDeviceRenewalStateFile: join(
      selected,
      "contribution-device-renewal-v1.json",
    ),
  });
}

export function assertLocalStatePath(
  stateRoot,
  value,
  {
    windowsFilesystemAdapter = null,
    windowsQualificationModeContext = null,
    windowsQualificationResourceRoot = null,
  } = {},
) {
  const selectedRoot = normalizedAbsolutePath(stateRoot);
  const selected = normalizedAbsolutePath(value);
  const windowsFilesystem = resolveWindowsFilesystemAdapter(
    windowsFilesystemAdapter,
    {
      windowsQualificationModeContext,
      stateRoot: selectedRoot,
      resourceRoot: windowsQualificationResourceRoot,
    },
  );
  if (!pathWithin(selectedRoot, selected)) throw configurationError();
  if (windowsFilesystem) {
    // The native adapter owns reparse-point, hard-link, DACL, and final-handle
    // checks on Windows.  A not-yet-created child is intentionally checked
    // only lexically here; its eventual create/open must use the same adapter.
    assertDirectory(selectedRoot, {
      ownerOnly: true,
      windowsFilesystemAdapter: windowsFilesystem,
      windowsQualificationModeContext,
      windowsQualificationStateRoot: selectedRoot,
      windowsQualificationResourceRoot,
    });
    return selected;
  }
  assertNoSymlinkBelow(selectedRoot, selected);
  let canonicalRoot;
  let canonicalSelected;
  try {
    canonicalRoot = realpathSync(selectedRoot);
    canonicalSelected = canonicalProspectivePath(selected);
  } catch {
    throw configurationError();
  }
  if (!pathWithin(canonicalRoot, canonicalSelected)) {
    throw configurationError();
  }
  return selected;
}

export function assertLocalResourcePath(resourceRoot, value) {
  const selectedRoot = normalizedAbsolutePath(resourceRoot);
  const selected = normalizedAbsolutePath(value);
  if (!pathWithin(selectedRoot, selected, { allowRoot: true })) {
    throw configurationError();
  }
  return selected;
}

export function assertLocalResourceDirectory(resourceRoot, value) {
  const selectedRoot = normalizedAbsolutePath(resourceRoot);
  const selected = assertLocalResourcePath(selectedRoot, value);
  assertDirectory(selected);
  let canonicalRoot;
  let canonicalSelected;
  try {
    canonicalRoot = realpathSync(selectedRoot);
    canonicalSelected = realpathSync(selected);
  } catch {
    throw configurationError();
  }
  if (!pathWithin(canonicalRoot, canonicalSelected, { allowRoot: true })) {
    throw configurationError();
  }
  return selected;
}

export function prepareLocalInstallationRoots({
  resourceRoot,
  stateRoot,
  windowsFilesystemAdapter = null,
  windowsQualificationModeContext = null,
} = {}) {
  const selectedResourceRoot = normalizedAbsolutePath(resourceRoot);
  const selectedStateRoot = normalizedAbsolutePath(stateRoot);
  const windowsFilesystem = resolveWindowsFilesystemAdapter(
    windowsFilesystemAdapter,
    {
      windowsQualificationModeContext,
      stateRoot: selectedStateRoot,
      resourceRoot: selectedResourceRoot,
    },
  );
  if (pathWithin(selectedResourceRoot, selectedStateRoot, { allowRoot: true })
      || pathWithin(selectedStateRoot, selectedResourceRoot, { allowRoot: true })) {
    throw configurationError();
  }
  assertDirectory(selectedResourceRoot);
  let canonicalResourceRoot;
  let prospectiveStateRoot;
  try {
    canonicalResourceRoot = realpathSync(selectedResourceRoot);
    prospectiveStateRoot = windowsFilesystem
      ? selectedStateRoot
      : canonicalProspectivePath(selectedStateRoot);
  } catch {
    throw configurationError();
  }
  if (pathWithin(canonicalResourceRoot, prospectiveStateRoot, {
    allowRoot: true,
  }) || pathWithin(prospectiveStateRoot, canonicalResourceRoot, {
    allowRoot: true,
  })) {
    throw configurationError();
  }
  if (windowsFilesystem) {
    try {
      windowsFilesystem.ensureDirectory(selectedStateRoot);
    } catch {
      throw configurationError();
    }
    assertDirectory(selectedStateRoot, {
      ownerOnly: true,
      windowsFilesystemAdapter: windowsFilesystem,
      windowsQualificationModeContext,
      windowsQualificationStateRoot: selectedStateRoot,
      windowsQualificationResourceRoot: selectedResourceRoot,
    });
  } else {
    try {
      const created = mkdirSync(selectedStateRoot, {
        recursive: true,
        mode: 0o700,
      });
      if (created !== undefined) {
        assertDirectory(selectedStateRoot, { ownerOnly: true });
      }
    } catch {
      throw configurationError();
    }
    assertDirectory(selectedStateRoot, { ownerOnly: true });
  }
  if (!windowsFilesystem) {
    try {
      const canonicalStateRoot = realpathSync(selectedStateRoot);
      const finalCanonicalResourceRoot = realpathSync(selectedResourceRoot);
      if (pathWithin(canonicalStateRoot, finalCanonicalResourceRoot, {
        allowRoot: true,
      }) || pathWithin(finalCanonicalResourceRoot, canonicalStateRoot, {
        allowRoot: true,
      })) {
        throw configurationError();
      }
    } catch (error) {
      if (error?.code === "USAGE_MONITOR_LOCAL_INSTALLATION_INVALID") throw error;
      throw configurationError();
    }
  }
  const paths = localCompanionStatePaths(selectedStateRoot);
  for (const path of Object.values(paths)) {
    assertLocalStatePath(selectedStateRoot, path, {
      windowsFilesystemAdapter: windowsFilesystem,
      windowsQualificationModeContext,
      // The state path helper revalidates the exact state root for every
      // derived path. Keep the qualification capability scoped to this
      // installation rather than merely to the adapter object.
      windowsQualificationResourceRoot: selectedResourceRoot,
    });
  }
  return Object.freeze({
    resourceRoot: selectedResourceRoot,
    stateRoot: selectedStateRoot,
    paths,
  });
}

async function directoryStatus(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return "unreadable";
    }
    await readdir(path, { withFileTypes: true });
    return "readable";
  } catch (error) {
    return error?.code === "ENOENT" ? "missing" : "unreadable";
  }
}

async function countRolloutFiles(roots) {
  const pending = [...roots];
  let directoriesObserved = 0;
  let entriesObserved = 0;
  let rolloutFilesObserved = 0;
  while (pending.length > 0
      && directoriesObserved < 2_048
      && entriesObserved < 20_000
      && rolloutFilesObserved < MAXIMUM_OBSERVED_ROLLOUT_FILES) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    directoriesObserved += 1;
    for (const entry of entries) {
      entriesObserved += 1;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(join(directory, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        rolloutFilesObserved += 1;
        if (rolloutFilesObserved === MAXIMUM_OBSERVED_ROLLOUT_FILES) break;
      }
      if (entriesObserved === 20_000) break;
    }
  }
  return Object.freeze({
    rolloutFilesObserved,
    rolloutFilesObservedCapped:
      rolloutFilesObserved === MAXIMUM_OBSERVED_ROLLOUT_FILES,
  });
}

async function stateDirectoryWritable(
  stateRoot,
  windowsFilesystemAdapter = null,
  windowsQualificationModeContext = null,
  windowsQualificationResourceRoot = null,
) {
  const windowsFilesystem = resolveWindowsFilesystemAdapter(
    windowsFilesystemAdapter,
    {
      windowsQualificationModeContext,
      stateRoot,
      resourceRoot: windowsQualificationResourceRoot,
    },
  );
  if (windowsFilesystem) {
    let probe = null;
    let identity = null;
    try {
      assertDirectory(stateRoot, {
        ownerOnly: true,
        windowsFilesystemAdapter: windowsFilesystem,
        windowsQualificationModeContext,
        windowsQualificationStateRoot: stateRoot,
        windowsQualificationResourceRoot,
      });
      probe = join(stateRoot, `.onboarding-write-probe-${randomUUID()}`);
      identity = windowsFilesystem.createFile(
        probe,
        Buffer.from("app-usagemonitor onboarding write probe v1\n", "utf8"),
      );
      return true;
    } catch {
      return false;
    } finally {
      if (probe !== null && identity !== null) {
        try {
          windowsFilesystem.deleteFile(probe, identity);
        } catch {
          // The diagnostic is intentionally boolean and content-free.
        }
      }
    }
  }
  let handle = null;
  let probe = null;
  try {
    const metadata = await lstat(stateRoot);
    if (!metadata.isDirectory()
        || metadata.isSymbolicLink()
        || (typeof process.getuid === "function"
          && typeof metadata.uid === "number"
          && metadata.uid !== process.getuid())
        || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      return false;
    }
    probe = join(stateRoot, `.onboarding-write-probe-${randomUUID()}`);
    handle = await open(
      probe,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
    if (probe !== null) await unlink(probe).catch(() => {});
  }
}

export function projectLocalOnboarding(value) {
  const rawRolloutFilesObserved = Number.isSafeInteger(
    value?.source?.rolloutFilesObserved,
  ) && value.source.rolloutFilesObserved > 0
    ? value.source.rolloutFilesObserved
    : 0;
  const rolloutFilesObserved = Math.min(
    rawRolloutFilesObserved,
    MAXIMUM_OBSERVED_ROLLOUT_FILES,
  );
  const sessionsReadable = value?.source?.sessionsReadable === true;
  const archivedSessionsReadable =
    value?.source?.archivedSessionsReadable === true;
  const codexHomeStatus = DIRECTORY_STATUSES.has(
    value?.source?.codexHomeStatus,
  )
    ? value.source.codexHomeStatus
    : "unreadable";
  const sessionsStatus = DIRECTORY_STATUSES.has(
    value?.source?.sessionsStatus,
  )
    ? value.source.sessionsStatus
    : sessionsReadable
      ? "readable"
      : "unreadable";
  const archivedSessionsStatus = DIRECTORY_STATUSES.has(
    value?.source?.archivedSessionsStatus,
  )
    ? value.source.archivedSessionsStatus
    : archivedSessionsReadable
      ? "readable"
      : "unreadable";
  const rolloutFilesObservedCapped =
    rolloutFilesObserved === MAXIMUM_OBSERVED_ROLLOUT_FILES;
  const writable = value?.state?.writable === true;
  const explicitRefresh = value?.capabilities?.explicitRefresh === true;
  const customCodexHomeConfigured =
    value?.capabilities?.customCodexHomeConfigured === true;
  const projectedSourceStatus = SOURCE_STATUSES.has(value?.source?.status)
    ? value.source.status
    : null;
  let sourceStatus;
  if (projectedSourceStatus === "ready"
      && (sessionsReadable || archivedSessionsReadable)
      && rolloutFilesObserved > 0) {
    sourceStatus = "ready";
  } else if (projectedSourceStatus !== null
      && projectedSourceStatus !== "ready") {
    sourceStatus = projectedSourceStatus;
  } else if (codexHomeStatus === "missing") {
    sourceStatus = "codex_home_missing";
  } else if (codexHomeStatus !== "readable") {
    sourceStatus = "codex_home_unreadable";
  } else if (sessionsStatus === "missing"
      && archivedSessionsStatus === "missing") {
    sourceStatus = "session_directories_missing";
  } else if (!sessionsReadable && !archivedSessionsReadable) {
    sourceStatus = "session_directories_unreadable";
  } else if (rolloutFilesObserved === 0) {
    sourceStatus = "no_rollout_files";
  } else {
    sourceStatus = "ready";
  }
  const stateStatus = writable ? "ready" : "unwritable";
  const projection = {
    schemaVersion: LOCAL_ONBOARDING_SCHEMA_VERSION,
    status: sourceStatus === "ready"
        && writable
        && explicitRefresh
      ? "ready"
      : "needs_attention",
    source: {
      status: sourceStatus,
      sessionsReadable,
      archivedSessionsReadable,
      rolloutFilesPresent: rolloutFilesObserved > 0,
      rolloutFilesObserved,
      rolloutFilesObservedCapped,
    },
    state: {
      status: stateStatus,
      writable,
    },
    capabilities: {
      explicitRefresh,
      customCodexHomeConfigured,
      rawContentExposed: false,
      arbitraryPathAccess: false,
    },
  };
  return Object.freeze({
    ...projection,
    source: Object.freeze(projection.source),
    state: Object.freeze(projection.state),
    capabilities: Object.freeze(projection.capabilities),
  });
}

export async function inspectLocalOnboarding({
  codexHome,
  stateRoot,
  explicitRefresh = true,
  customCodexHomeConfigured = false,
  windowsFilesystemAdapter = null,
  windowsQualificationModeContext = null,
  resourceRoot = null,
} = {}) {
  const selectedCodexHome = normalizedAbsolutePath(codexHome);
  const selectedStateRoot = normalizedAbsolutePath(stateRoot);
  const windowsFilesystem = resolveWindowsFilesystemAdapter(
    windowsFilesystemAdapter,
    {
      windowsQualificationModeContext,
      stateRoot: selectedStateRoot,
      resourceRoot,
    },
  );
  const sessions = join(selectedCodexHome, "sessions");
  const archivedSessions = join(selectedCodexHome, "archived_sessions");
  const [
    codexHomeStatus,
    sessionsStatus,
    archivedSessionsStatus,
    writable,
  ] =
    await Promise.all([
      directoryStatus(selectedCodexHome),
      directoryStatus(sessions),
      directoryStatus(archivedSessions),
      stateDirectoryWritable(
        selectedStateRoot,
        windowsFilesystem,
        windowsQualificationModeContext,
        resourceRoot,
      ),
    ]);
  const sessionsReadable = sessionsStatus === "readable";
  const archivedSessionsReadable = archivedSessionsStatus === "readable";
  const {
    rolloutFilesObserved,
    rolloutFilesObservedCapped,
  } = await countRolloutFiles(
    [
      sessionsReadable ? sessions : null,
      archivedSessionsReadable ? archivedSessions : null,
    ].filter((value) => value !== null),
  );
  return projectLocalOnboarding({
    source: {
      codexHomeStatus,
      sessionsStatus,
      archivedSessionsStatus,
      sessionsReadable,
      archivedSessionsReadable,
      rolloutFilesObserved,
      rolloutFilesObservedCapped,
    },
    state: {
      writable,
    },
    capabilities: {
      explicitRefresh: explicitRefresh === true,
      customCodexHomeConfigured: customCodexHomeConfigured === true,
      rawContentExposed: false,
      arbitraryPathAccess: false,
    },
  });
}
