import { AsyncLocalStorage } from "node:async_hooks";
import { posix, win32 } from "node:path";

import {
  createWindowsSqliteStateSession,
} from "./windows-sqlite-state-session.js";
import {
  isWindowsFilesystemAdapter,
} from "./windows-filesystem.js";

// The collector has a deliberately small platform seam.  The ordinary
// macOS/Linux path continues to construct DatabaseSync itself; a Windows
// caller must enter this boundary before any state operation can open a
// database.  AsyncLocalStorage keeps the boundary scoped to one refresh and
// avoids a mutable process-global adapter that concurrent refreshes could
// accidentally cross.
export const LOCAL_COLLECTOR_STATE_SESSION_BOUNDARY_CONTRACT_VERSION =
  "local-collector-state-session-boundary-v1";

const BOUNDARIES = new AsyncLocalStorage();

function unavailable() {
  const error = new Error("local_collector_state_unavailable");
  error.code = "local_collector_state_unavailable";
  return error;
}

function validBoundaryPlatform(value) {
  return value === "win32" || value === "darwin" || value === "linux";
}

function validateBoundary({
  platform,
  architecture,
  windowsFilesystemAdapter,
  windowsSqliteStateSessionFactory,
  simulation,
}) {
  if (!validBoundaryPlatform(platform)
      || typeof architecture !== "string"
      || architecture.length < 1
      || typeof simulation !== "boolean") {
    throw new TypeError("Local collector state session boundary is invalid");
  }
  if (windowsSqliteStateSessionFactory !== null
      && typeof windowsSqliteStateSessionFactory !== "function") {
    throw new TypeError("windowsSqliteStateSessionFactory must be a function or null");
  }
  if (platform !== "win32") return;
  if (windowsFilesystemAdapter === null
      || typeof windowsFilesystemAdapter !== "object"
      || Array.isArray(windowsFilesystemAdapter)) {
    throw unavailable();
  }
  // The simulation flag is test/qualification plumbing only.  A real Windows
  // process cannot use it, and a production boundary still requires the
  // authenticated branded adapter plus the positively-qualified lease bit.
  if (simulation) {
    if (process.platform === "win32") throw unavailable();
    if (windowsSqliteStateSessionFactory === null) throw unavailable();
    return;
  }
  if (process.platform !== "win32"
      || process.arch !== "x64"
      || !isWindowsFilesystemAdapter(windowsFilesystemAdapter)
      || windowsFilesystemAdapter.sqliteStateLeaseSafe !== true) {
    throw unavailable();
  }
  if (windowsSqliteStateSessionFactory !== null) throw unavailable();
}

/**
 * Run collector state work inside one explicit platform boundary.
 *
 * On macOS/Linux this is a no-op context and existing callers retain their
 * current Node SQLite behaviour.  On Windows the context is mandatory; the
 * state module refuses to open a raw DatabaseSync connection without it.
 */
export function withLocalCollectorStateSessionBoundary({
  platform = process.platform,
  architecture = process.arch,
  windowsFilesystemAdapter = null,
  windowsSqliteStateSessionFactory = null,
  simulation = false,
} = {}, callback) {
  if (typeof callback !== "function") {
    throw new TypeError("Local collector state session boundary callback is invalid");
  }
  validateBoundary({
    platform,
    architecture,
    windowsFilesystemAdapter,
    windowsSqliteStateSessionFactory,
    simulation,
  });
  const context = Object.freeze({
    contractVersion: LOCAL_COLLECTOR_STATE_SESSION_BOUNDARY_CONTRACT_VERSION,
    platform,
    architecture,
    windowsFilesystemAdapter,
    windowsSqliteStateSessionFactory,
    simulation,
  });
  return BOUNDARIES.run(context, callback);
}

export function currentLocalCollectorStateSessionBoundary() {
  return BOUNDARIES.getStore() ?? null;
}

export function isLocalCollectorStateWindowsBoundaryActive() {
  const context = currentLocalCollectorStateSessionBoundary();
  return context?.platform === "win32";
}

function assertSessionShape(session, { rootPath, databaseName, platform }) {
  const pathModule = platform === "win32" ? win32 : posix;
  if (session === null
      || typeof session !== "object"
      || typeof session.rootPath !== "string"
      || typeof session.databaseName !== "string"
      || pathModule.normalize(session.rootPath).toLowerCase()
        !== pathModule.normalize(rootPath).toLowerCase()
      || pathModule.normalize(session.databaseName).toLowerCase()
        !== pathModule.normalize(databaseName).toLowerCase()
      || session.database === null
      || typeof session.database !== "object"
      || typeof session.database.exec !== "function"
      || typeof session.database.prepare !== "function"
      || typeof session.close !== "function") {
    throw unavailable();
  }
  return session;
}

/**
 * Open the collector's protected Windows session for one state file.
 *
 * The default factory is the audited Windows session module.  A caller may
 * inject a factory only for a qualification double on a non-Windows host;
 * the normal Windows path cannot inject a replacement constructor.
 */
export function openLocalCollectorStateSessionBoundary({
  stateFile,
  readOnly = false,
  create = false,
} = {}) {
  const context = currentLocalCollectorStateSessionBoundary();
  if (context?.platform !== "win32"
      || typeof stateFile !== "string"
      || stateFile.length < 1
      || typeof readOnly !== "boolean"
      || typeof create !== "boolean") {
    throw unavailable();
  }
  const factory = context.windowsSqliteStateSessionFactory
    ?? ((options) => createWindowsSqliteStateSession(options));
  const pathModule = context.platform === "win32" ? win32 : posix;
  const selectedStateFile = pathModule.normalize(stateFile.replaceAll("/", "\\"));
  const rootPath = pathModule.dirname(selectedStateFile);
  const databaseName = pathModule.basename(selectedStateFile);
  let session;
  try {
    session = factory({
      platform: "win32",
      architecture: context.architecture,
      adapter: context.windowsFilesystemAdapter,
      rootPath,
      databaseName,
      readOnly,
      create,
    });
  } catch {
    throw unavailable();
  }
  return assertSessionShape(session, {
    rootPath,
    databaseName,
    platform: context.platform,
  });
}
