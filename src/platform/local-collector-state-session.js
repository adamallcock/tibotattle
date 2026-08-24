import { AsyncLocalStorage } from "node:async_hooks";
import { posix, resolve, win32 } from "node:path";

import {
  createWindowsSqliteStateSession,
} from "./windows-sqlite-state-session.js";
import {
  isWindowsFilesystemAdapter,
} from "./windows-filesystem.js";
import {
  isWindowsQualificationModeContextFor,
} from "./windows-qualification-mode.js";

// The collector has a deliberately small platform seam.  The ordinary
// macOS/Linux path continues to construct DatabaseSync itself; a Windows
// caller must enter this boundary before any state operation can open a
// database.  AsyncLocalStorage keeps the boundary scoped to one refresh and
// avoids a mutable process-global adapter that concurrent refreshes could
// accidentally cross.
export const LOCAL_COLLECTOR_STATE_SESSION_BOUNDARY_CONTRACT_VERSION =
  "local-collector-state-session-boundary-v1";

const BOUNDARIES = new AsyncLocalStorage();
const WINDOWS_QUALIFICATION_SESSION_FACTORY_BINDINGS = new WeakMap();
const WINDOWS_QUALIFICATION_SESSION_FACTORIES = new WeakSet();
const WINDOWS_QUALIFICATION_SESSION_BINDINGS = new WeakMap();

function unavailable() {
  const error = new Error("local_collector_state_unavailable");
  error.code = "local_collector_state_unavailable";
  return error;
}

function normalizedQualificationStateRoot(value) {
  if (typeof value !== "string" || value.length < 1) return null;
  try {
    return win32.normalize(value.replaceAll("/", "\\"));
  } catch {
    return null;
  }
}

function normalizedQualificationResourceRoot(value) {
  if (typeof value !== "string" || value.length < 1) return null;
  try {
    return resolve(value);
  } catch {
    return null;
  }
}

function sameQualificationStateRoot(left, right) {
  const normalizedLeft = normalizedQualificationStateRoot(left);
  const normalizedRight = normalizedQualificationStateRoot(right);
  return normalizedLeft !== null
    && normalizedRight !== null
    && normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

function sameQualificationResourceRoot(left, right) {
  const normalizedLeft = normalizedQualificationResourceRoot(left);
  const normalizedRight = normalizedQualificationResourceRoot(right);
  return normalizedLeft !== null
    && normalizedRight !== null
    && normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

function qualificationStateFilePath(session) {
  if (session === null || typeof session !== "object") return null;
  try {
    if (typeof session.rootPath !== "string"
        || typeof session.databaseName !== "string") return null;
    return win32.join(
      normalizedQualificationStateRoot(session.rootPath),
      session.databaseName,
    );
  } catch {
    return null;
  }
}

function qualificationPathForRoot(path, root) {
  const selected = normalizedQualificationStateRoot(path);
  const selectedRoot = normalizedQualificationStateRoot(root);
  if (selected === null || selectedRoot === null) return false;
  const prefix = selectedRoot.endsWith("\\") ? selectedRoot : `${selectedRoot}\\`;
  return selected.toLowerCase() === selectedRoot.toLowerCase()
    || selected.toLowerCase().startsWith(prefix.toLowerCase());
}

function isWindowsQualificationSessionFactoryFor({
  factory,
  context,
  adapter,
  stateRoot,
  resourceRoot,
} = {}) {
  if (typeof factory !== "function"
      || !WINDOWS_QUALIFICATION_SESSION_FACTORIES.has(factory)) {
    return false;
  }
  try {
    const binding = WINDOWS_QUALIFICATION_SESSION_FACTORY_BINDINGS.get(factory);
    return binding !== undefined
      && binding.context === context
      && binding.adapter === adapter
      && sameQualificationStateRoot(binding.stateRoot, stateRoot)
      && sameQualificationResourceRoot(binding.resourceRoot, resourceRoot)
      && isWindowsQualificationModeContextFor({
        context,
        adapter,
        stateRoot,
        resourceRoot,
      });
  } catch {
    return false;
  }
}

/**
 * Return true only for the exact session object issued by the qualification
 * factory, bound to the exact context/adapter/roots and requested file.
 *
 * The public session fields intentionally remain production-unqualified. The
 * WeakMap is the private capability that lets the disposable qualification
 * lane exercise the same native path without turning a copied object or a
 * direct `createWindowsSqliteStateSession` call into authorization.
 */
export function isWindowsQualificationStateSessionFor({
  session,
  context,
  adapter,
  stateFile = null,
  stateRoot = null,
  resourceRoot = null,
} = {}) {
  try {
    const binding = WINDOWS_QUALIFICATION_SESSION_BINDINGS.get(session);
    if (binding === undefined
        || binding.context !== context
        || binding.adapter !== adapter
        || !sameQualificationStateRoot(binding.stateRoot, stateRoot)
        || !sameQualificationResourceRoot(binding.resourceRoot, resourceRoot)
        || !isWindowsQualificationModeContextFor({
          context,
          adapter,
          stateRoot,
          resourceRoot,
        })) {
      return false;
    }
    const expectedPath = qualificationStateFilePath(session);
    if (expectedPath === null || !qualificationPathForRoot(expectedPath, stateRoot)) {
      return false;
    }
    return stateFile !== null
      && sameQualificationStateRoot(expectedPath, stateFile);
  } catch {
    return false;
  }
}

/**
 * Construct the only collector SQLite session factory accepted by the
 * Windows qualification boundary.
 *
 * The returned function is capability-like: its reviewed adapter, branded
 * qualification context, and installation roots are captured privately and
 * cannot be replaced through call options.  A portable host may bind or
 * explicitly supply a DatabaseSync-compatible factory for a contract double.
 * Native Windows must always use the imported reviewed constructor directly.
 */
export function createWindowsQualificationStateSessionFactory({
  platform = "win32",
  architecture = "x64",
  windowsFilesystemAdapter,
  windowsQualificationModeContext,
  stateRoot,
  resourceRoot,
  databaseFactory = null,
} = {}) {
  if (platform !== "win32"
      || architecture !== "x64"
      || !isWindowsFilesystemAdapter(windowsFilesystemAdapter)
      || !isWindowsQualificationModeContextFor({
        context: windowsQualificationModeContext,
        adapter: windowsFilesystemAdapter,
        stateRoot,
        resourceRoot,
      })
      || windowsQualificationModeContext?.qualificationOnly !== true
      || windowsQualificationModeContext?.productionSafe !== false
      || windowsFilesystemAdapter.productionSafe !== false
      || windowsFilesystemAdapter.sqliteStateLeaseSafe !== false
      || normalizedQualificationStateRoot(stateRoot) === null
      || normalizedQualificationResourceRoot(resourceRoot) === null) {
    throw unavailable();
  }
  if (databaseFactory !== null && typeof databaseFactory !== "function") {
    throw new TypeError("databaseFactory must be a function or null");
  }
  if (process.platform === "win32" && databaseFactory !== null) {
    // A native qualification process must never replace the reviewed
    // constructor's DatabaseSync path with an arbitrary injected backend.
    throw unavailable();
  }

  const binding = Object.freeze({
    platform,
    architecture,
    adapter: windowsFilesystemAdapter,
    context: windowsQualificationModeContext,
    stateRoot: normalizedQualificationStateRoot(stateRoot),
    resourceRoot: normalizedQualificationResourceRoot(resourceRoot),
    databaseFactory,
  });
  const factory = (options = {}) => {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw unavailable();
    }
    const {
      databaseFactory: requestedDatabaseFactory,
      platform: requestedPlatform,
      architecture: requestedArchitecture,
      adapter: requestedAdapter,
      windowsQualificationModeContext: requestedContext,
      windowsQualificationResourceRoot: requestedResourceRoot,
      ...sessionOptions
    } = options;
    if ((requestedPlatform !== undefined && requestedPlatform !== binding.platform)
        || (requestedArchitecture !== undefined
          && requestedArchitecture !== binding.architecture)
        || (requestedAdapter !== undefined && requestedAdapter !== binding.adapter)
        || (requestedContext !== undefined
          && requestedContext !== binding.context)
        || (requestedResourceRoot !== undefined
          && !sameQualificationResourceRoot(
            requestedResourceRoot,
            binding.resourceRoot,
          ))) {
      throw unavailable();
    }
    let selectedDatabaseFactory = binding.databaseFactory;
    if (requestedDatabaseFactory !== undefined) {
      if (requestedDatabaseFactory !== null
          && typeof requestedDatabaseFactory !== "function") {
        throw new TypeError("databaseFactory must be a function or null");
      }
      if (process.platform === "win32"
          && requestedDatabaseFactory !== null) {
        throw unavailable();
      }
      if (binding.databaseFactory !== null
          && requestedDatabaseFactory !== binding.databaseFactory) {
        throw unavailable();
      }
      selectedDatabaseFactory = requestedDatabaseFactory;
    }
    const session = createWindowsSqliteStateSession({
      ...sessionOptions,
      platform: binding.platform,
      architecture: binding.architecture,
      adapter: binding.adapter,
      windowsQualificationModeContext: binding.context,
      windowsQualificationResourceRoot: binding.resourceRoot,
      ...(selectedDatabaseFactory === null
        ? {}
        : { databaseFactory: selectedDatabaseFactory }),
    });
    WINDOWS_QUALIFICATION_SESSION_BINDINGS.set(session, Object.freeze({
      context: binding.context,
      adapter: binding.adapter,
      stateRoot: binding.stateRoot,
      resourceRoot: binding.resourceRoot,
    }));
    return session;
  };
  WINDOWS_QUALIFICATION_SESSION_FACTORY_BINDINGS.set(factory, binding);
  WINDOWS_QUALIFICATION_SESSION_FACTORIES.add(factory);
  return factory;
}

function validBoundaryPlatform(value) {
  return value === "win32" || value === "darwin" || value === "linux";
}

function validateBoundary({
  platform,
  architecture,
  windowsFilesystemAdapter,
  windowsSqliteStateSessionFactory,
  windowsQualificationModeContext,
  stateRoot,
  resourceRoot,
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
  if (windowsQualificationModeContext !== null
      && (typeof windowsQualificationModeContext !== "object"
        || Array.isArray(windowsQualificationModeContext))) {
    throw unavailable();
  }
  if (platform !== "win32") return;
  if (windowsFilesystemAdapter === null
      || typeof windowsFilesystemAdapter !== "object"
      || Array.isArray(windowsFilesystemAdapter)) {
    throw unavailable();
  }
  if (windowsQualificationModeContext !== null) {
    // The native qualification lane is intentionally the only exception to
    // the production lease/readiness gate.  It still requires the exact
    // branded context, adapter, factory, and installation roots.  A copied
    // context, a path mismatch, or a production-safe-looking adapter is not
    // an authorization.
    if (!isWindowsQualificationModeContextFor({
      context: windowsQualificationModeContext,
      adapter: windowsFilesystemAdapter,
      stateRoot,
      resourceRoot,
    })
        || windowsQualificationModeContext.qualificationOnly !== true
        || windowsQualificationModeContext.productionSafe !== false
        || !isWindowsFilesystemAdapter(windowsFilesystemAdapter)
        || windowsFilesystemAdapter.productionSafe !== false
        || windowsFilesystemAdapter.sqliteStateLeaseSafe !== false
        || !isWindowsQualificationSessionFactoryFor({
          factory: windowsSqliteStateSessionFactory,
          context: windowsQualificationModeContext,
          adapter: windowsFilesystemAdapter,
          stateRoot,
          resourceRoot,
        })) {
      throw unavailable();
    }
    if (process.platform === "win32"
        && (process.arch !== "x64" || architecture !== "x64")) {
      throw unavailable();
    }
    // `simulation` is allowed only for non-Windows contract tests.  A native
    // process must use the real reviewed session factory and adapter.
    if (simulation && process.platform === "win32") throw unavailable();
    return;
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
  windowsQualificationModeContext = null,
  stateRoot = null,
  resourceRoot = null,
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
    windowsQualificationModeContext,
    stateRoot,
    resourceRoot,
    simulation,
  });
  const context = Object.freeze({
    contractVersion: LOCAL_COLLECTOR_STATE_SESSION_BOUNDARY_CONTRACT_VERSION,
    platform,
    architecture,
    windowsFilesystemAdapter,
    windowsSqliteStateSessionFactory,
    windowsQualificationModeContext,
    stateRoot,
    resourceRoot,
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
  if (context.windowsQualificationModeContext !== null) {
    const stateRoot = pathModule.normalize(context.stateRoot.replaceAll("/", "\\"));
    const statePrefix = stateRoot.endsWith("\\") ? stateRoot : `${stateRoot}\\`;
    if (!selectedStateFile.toLowerCase().startsWith(statePrefix.toLowerCase())) {
      throw unavailable();
    }
  }
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
      windowsQualificationModeContext:
        context.windowsQualificationModeContext,
      windowsQualificationResourceRoot:
        context.resourceRoot,
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
