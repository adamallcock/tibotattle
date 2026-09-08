import { win32 } from "node:path";

import {
  createWindowsFilesystemAdapter,
  createWindowsQualificationModeContext,
} from "../../src/platform/index.js";
import {
  createQualifiedWindowsAccountObservationCredentialBackend,
  isWindowsAccountObservationCredentialError,
} from "../../src/platform/windows-account-observation-credential.js";

import {
  attachDesktopWindowsAccountObservationBroker,
} from "./desktop-windows-account-observation-broker.js";
import { shellError } from "./errors.js";
import {
  assertWindowsElectronQualificationContext,
  WINDOWS_ELECTRON_QUALIFICATION_MARKER,
  WINDOWS_ELECTRON_TEST_LANE,
} from "./windows-qualification.js";

// This handover is a closed packaged-smoke composition. It deliberately does
// not select a production credential route, expose a Credential Manager
// capability, or accept a caller-owned native binding.
export const WINDOWS_ACCOUNT_OBSERVATION_MAIN_COMPOSITION_STATUS = "qualification_only";
export const WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_ENVIRONMENT_KEY =
  "USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION";
export const WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_MARKER =
  "windows-account-observation-fd4-v1";

const PRODUCTION_OPTION_KEYS = Object.freeze([
  "environment",
  "qualificationContext",
]);
const TEST_OPTION_KEYS = Object.freeze([
  "architecture",
  "environment",
  "platform",
  "qualificationContext",
]);
const TEST_DEPENDENCY_KEYS = Object.freeze([
  "assertElectronQualificationContext",
  "attachBroker",
  "createAdapter",
  "createQualificationContext",
  "createQualifiedBackend",
  "isBackendError",
]);
const QUALIFICATION_PROFILE_PATHS = Object.freeze([
  Object.freeze(["TEMP", "tmp"]),
  Object.freeze(["TMP", "tmp"]),
  Object.freeze(["TMPDIR", "tmp"]),
  Object.freeze(["USERPROFILE", "home"]),
  Object.freeze(["HOME", "home"]),
  Object.freeze(["APPDATA", "appdata"]),
  Object.freeze(["LOCALAPPDATA", "localappdata"]),
  Object.freeze(["CODEX_HOME", "codex"]),
  Object.freeze(["CLAUDE_CONFIG_DIR", "claude"]),
  Object.freeze(["XDG_CONFIG_HOME", "config"]),
  Object.freeze(["XDG_DATA_HOME", "data"]),
  Object.freeze(["XDG_CACHE_HOME", "cache"]),
  Object.freeze(["XDG_RUNTIME_DIR", "runtime"]),
  Object.freeze(["USAGE_MONITOR_STATE_ROOT", "state"]),
]);

function fail() {
  throw shellError("electron_configuration_invalid");
}

function exactOptions(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  let actual;
  try {
    actual = Object.keys(value);
  } catch {
    fail();
  }
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail();
  return value;
}

function normalizeWindowsProfilePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail();
  const raw = value.replaceAll("/", "\\");
  if (!/^[A-Za-z]:\\/u.test(raw) || raw.startsWith("\\\\")) fail();
  const root = win32.parse(raw).root;
  const components = raw.slice(root.length).split("\\");
  if (components.some((component) => component === "." || component === "..")) fail();
  let normalized;
  try {
    normalized = win32.normalize(raw);
  } catch {
    fail();
  }
  if (!win32.isAbsolute(normalized)
      || !/^[A-Za-z]:\\/u.test(normalized)
      || normalized === win32.parse(normalized).root
      || normalized.endsWith("\\")) {
    fail();
  }
  return normalized;
}

function sameWindowsProfilePath(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * The packaged launcher creates an exact disposable profile layout. Bind the
 * platform context to that authenticated layout only; never infer a broader
 * root from an arbitrary parent path or modify the Electron process env.
 */
function qualificationEnvironment(environment) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) fail();
  if (environment.GITHUB_ACTIONS !== "true"
      || environment.USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION
        !== WINDOWS_ELECTRON_QUALIFICATION_MARKER
      || environment.USAGE_MONITOR_TEST_LANE !== WINDOWS_ELECTRON_TEST_LANE
      || environment[WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_ENVIRONMENT_KEY]
        !== WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_MARKER) {
    fail();
  }
  if (!Object.hasOwn(environment, "TEMP")) fail();
  const temporaryPath = normalizeWindowsProfilePath(environment.TEMP);
  if (win32.basename(temporaryPath).toLowerCase() !== "tmp") fail();
  const profileRoot = win32.dirname(temporaryPath);
  if (profileRoot === win32.parse(profileRoot).root) fail();
  for (const [key, child] of QUALIFICATION_PROFILE_PATHS) {
    if (!Object.hasOwn(environment, key)) fail();
    const value = normalizeWindowsProfilePath(environment[key]);
    if (!sameWindowsProfilePath(value, win32.join(profileRoot, child))) fail();
  }
  return Object.freeze({
    ...environment,
    // `createWindowsQualificationModeContext` requires the entire disposable
    // profile beneath TEMP. The standard launcher owns tmp/state siblings;
    // this private copy is bound only after that exact sibling layout proves.
    TEMP: profileRoot,
  });
}

function createHandover({
  architecture,
  assertElectronQualificationContext: assertElectronContext,
  attachBroker,
  createAdapter,
  createQualificationContext,
  createQualifiedBackend,
  environment,
  isBackendError,
  platform,
  qualificationContext,
}) {
  if (platform !== "win32" || architecture !== "x64"
      || typeof assertElectronContext !== "function"
      || typeof attachBroker !== "function"
      || typeof createAdapter !== "function"
      || typeof createQualificationContext !== "function"
      || typeof createQualifiedBackend !== "function"
      || typeof isBackendError !== "function") {
    fail();
  }
  let windowsQualificationModeContext;
  let adapter;
  try {
    assertElectronContext({
      context: qualificationContext,
      platform,
      architecture,
    });
    const privateEnvironment = qualificationEnvironment(environment);
    if (typeof qualificationContext?.resourceRoot !== "string"
        || qualificationContext.resourceRoot.length === 0) {
      fail();
    }
    adapter = createAdapter({ platform, architecture });
    windowsQualificationModeContext = createQualificationContext({
      platform,
      architecture,
      adapter,
      environment: privateEnvironment,
      resourceRoot: qualificationContext.resourceRoot,
    });
  } catch {
    fail();
  }

  return Object.freeze({
    attachWindowsAccountObservationBroker(stream) {
      return attachBroker({
        stream,
        createBackend() {
          return createQualifiedBackend({
            adapter,
            resourceRoot: qualificationContext.resourceRoot,
            windowsQualificationModeContext,
          });
        },
        // The desktop broker converts only trusted fixed backend errors into
        // its protocol codes. All construction/stream detail remains local.
        isBackendError,
      });
    },
  });
}

/**
 * Construct the parent side of the real FD4 path for an authenticated,
 * disposable, packaged Windows qualification run. Native Credential Manager
 * work begins only when the supervisor actually attaches descriptor 4.
 */
export function createWindowsQualificationAccountObservationHandover(options = {}) {
  const source = exactOptions(options, PRODUCTION_OPTION_KEYS);
  return createHandover({
    architecture: process.arch,
    assertElectronQualificationContext: assertWindowsElectronQualificationContext,
    attachBroker: attachDesktopWindowsAccountObservationBroker,
    createAdapter: createWindowsFilesystemAdapter,
    createQualificationContext: createWindowsQualificationModeContext,
    createQualifiedBackend: createQualifiedWindowsAccountObservationCredentialBackend,
    environment: source.environment,
    isBackendError: isWindowsAccountObservationCredentialError,
    platform: process.platform,
    qualificationContext: source.qualificationContext,
  });
}

/** Explicit plain-Node dependency seam for this fixed qualification contract. */
export function createWindowsQualificationAccountObservationHandoverForTest(
  options = {},
  dependencies = {},
) {
  const source = exactOptions(options, TEST_OPTION_KEYS);
  const factories = exactOptions(dependencies, TEST_DEPENDENCY_KEYS);
  return createHandover({
    architecture: source.architecture,
    assertElectronQualificationContext: factories.assertElectronQualificationContext,
    attachBroker: factories.attachBroker,
    createAdapter: factories.createAdapter,
    createQualificationContext: factories.createQualificationContext,
    createQualifiedBackend: factories.createQualifiedBackend,
    environment: source.environment,
    isBackendError: factories.isBackendError,
    platform: source.platform,
    qualificationContext: source.qualificationContext,
  });
}
