import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve, win32 } from "node:path";

import { isWindowsFilesystemAdapter } from "./windows-filesystem.js";

/**
 * The Windows Electron smoke lane is deliberately a separate mode from
 * production readiness.  It is allowed to exercise the real Windows native
 * boundary with disposable state, but it can never promote a selector or
 * issue a production credential/readiness claim.
 */
export const WINDOWS_QUALIFICATION_MODE_CONTRACT_VERSION =
  "windows-qualification-mode-v1";
export const WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VARIABLE =
  "USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION";
export const WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VALUE =
  "windows-electron-v1";
export const WINDOWS_QUALIFICATION_MODE_TEST_LANE_ENVIRONMENT_VARIABLE =
  "USAGE_MONITOR_TEST_LANE";
export const WINDOWS_QUALIFICATION_MODE_TEST_LANE =
  "windows-electron-smoke";
export const WINDOWS_QUALIFICATION_MODE_ACCOUNTING_SOURCE_MODE = "unified";
export const WINDOWS_QUALIFICATION_MODE_QUALIFICATION_ONLY = true;
export const WINDOWS_QUALIFICATION_MODE_PRODUCTION_SAFE = false;
export const WINDOWS_QUALIFICATION_RESOURCE_MANIFEST_FILE =
  "electron-runtime-manifest.json";
export const WINDOWS_QUALIFICATION_RESOURCE_MANIFEST_SCHEMA =
  "usage-monitor-electron-runtime-v0.1";
export const WINDOWS_QUALIFICATION_RESOURCE_AUTHORITY_CONTRACT =
  "windows-electron-resource-authority-v1";

// Electron-oriented aliases keep the names discoverable for callers that
// describe the mode by its artifact rather than by the platform boundary.
export const WINDOWS_ELECTRON_QUALIFICATION_MODE_CONTRACT_VERSION =
  WINDOWS_QUALIFICATION_MODE_CONTRACT_VERSION;
export const WINDOWS_ELECTRON_QUALIFICATION_ENVIRONMENT_VARIABLE =
  WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VARIABLE;
export const WINDOWS_ELECTRON_QUALIFICATION_ENVIRONMENT_VALUE =
  WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VALUE;
export const WINDOWS_ELECTRON_QUALIFICATION_TEST_LANE =
  WINDOWS_QUALIFICATION_MODE_TEST_LANE;

const MAXIMUM_WINDOWS_PATH_LENGTH = 32_767;
const CONTEXTS = new WeakSet();
const CONTEXT_BINDINGS = new WeakMap();
const ERRORS = new WeakSet();

const ERROR_CODES = new Set([
  "invalid_configuration",
  "invalid_environment",
  "unsupported_platform",
  "unsupported_architecture",
  "invalid_adapter",
  "invalid_root",
  "invalid_path",
  "path_escape",
  "forbidden_origin",
  "development_identity_forbidden",
  "accounting_mode",
  "resource_authority",
]);

const FORBIDDEN_ORIGIN_ENVIRONMENT_KEYS = Object.freeze([
  "USAGE_MONITOR_CENTRAL_ORIGIN",
  "USAGE_MONITOR_CENTRAL_SERVICE_ORIGIN",
  "USAGE_MONITOR_CONTRIBUTION_ORIGIN",
  "USAGE_MONITOR_CONTRIBUTION_SERVICE_ORIGIN",
  "USAGE_MONITOR_PARTICIPANT_CENTRAL_ORIGIN",
  "USAGE_MONITOR_PREVIEW_CENTRAL_ORIGIN",
]);

const FORBIDDEN_DEVELOPMENT_IDENTITY_ENVIRONMENT_KEYS = Object.freeze([
  "USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE",
  "USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY",
  "APP_USAGEMONITOR_EXPORT_SECRET",
]);

const RESERVED_WINDOWS_DEVICE_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

const RESOURCE_INVENTORY_KINDS = new Set([
  "companion_source",
  "electron_shell",
  "dashboard_asset",
  "workspace_dependency",
  "third_party_dependency",
  "windows_native_binding",
  "runtime_metadata",
]);
const REQUIRED_RESOURCE_PATHS = Object.freeze([
  "apps/electron/companion-supervisor.js",
  "apps/electron/desktop-lifecycle.js",
  "apps/electron/errors.js",
  "apps/electron/loopback-policy.js",
  "apps/electron/main.js",
  "apps/electron/platform-gate.js",
  "apps/electron/preload.js",
  "apps/electron/ready-line.js",
  "apps/electron/windows-qualification.js",
  "apps/local/server.js",
  "apps/web/public/index.html",
]);
const REQUIRED_RESOURCE_KINDS = Object.freeze({
  "apps/electron/companion-supervisor.js": "electron_shell",
  "apps/electron/desktop-lifecycle.js": "electron_shell",
  "apps/electron/errors.js": "electron_shell",
  "apps/electron/loopback-policy.js": "electron_shell",
  "apps/electron/main.js": "electron_shell",
  "apps/electron/platform-gate.js": "electron_shell",
  "apps/electron/preload.js": "electron_shell",
  "apps/electron/ready-line.js": "electron_shell",
  "apps/electron/windows-qualification.js": "electron_shell",
  "apps/local/server.js": "companion_source",
  "apps/web/public/index.html": "dashboard_asset",
});
const RESOURCE_BINDING_PATH =
  "native/windows-filesystem/build/Release/windows_filesystem.node";
const RESOURCE_BINDING_MANIFEST_PATH = `${RESOURCE_BINDING_PATH}.manifest.json`;
const RESOURCE_KEYTAR_PATH =
  "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node";
const RESOURCE_MAXIMUM_MANIFEST_BYTES = 1 * 1024 * 1024;
const RESOURCE_MAXIMUM_PAYLOAD_BYTES = 512 * 1024 * 1024;

export class WindowsQualificationModeError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Windows qualification mode error code");
    }
    super("Windows Electron qualification mode is unavailable");
    this.name = "WindowsQualificationModeError";
    this.code = `windows_qualification_mode_${code}`;
    ERRORS.add(this);
  }
}

export function isWindowsQualificationModeError(error) {
  try {
    return error instanceof WindowsQualificationModeError
      && ERRORS.has(error)
      && Object.getPrototypeOf(error) === WindowsQualificationModeError.prototype;
  } catch {
    return false;
  }
}

function fail(code) {
  throw new WindowsQualificationModeError(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  try {
    return Object.hasOwn(value, key);
  } catch {
    fail("invalid_configuration");
  }
}

function readOwn(value, key) {
  if (!hasOwn(value, key)) return undefined;
  try {
    return value[key];
  } catch {
    fail("invalid_configuration");
  }
}

function comparePathBytes(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactObjectKeys(value, keys) {
  return isRecord(value)
    && JSON.stringify(Object.keys(value).sort(comparePathBytes))
      === JSON.stringify([...keys].sort(comparePathBytes));
}

function safeResourceRelativePath(value) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\\")
      || value.includes("\0")
      || value.startsWith("/")
      || /^[A-Za-z]:[\\/]/u.test(value)) {
    fail("resource_authority");
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    fail("resource_authority");
  }
  return value;
}

function assertResourceInventory(manifest) {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail("resource_authority");
  }
  const seen = new Set();
  let previousPath = null;
  let payloadBytes = 0;
  const payloadHash = createHash("sha256");
  for (const row of manifest.files) {
    if (!exactObjectKeys(row, ["bytes", "kind", "path", "sha256"])) {
      fail("resource_authority");
    }
    const path = safeResourceRelativePath(row.path);
    if (path === WINDOWS_QUALIFICATION_RESOURCE_MANIFEST_FILE
        || (previousPath !== null && comparePathBytes(previousPath, path) >= 0)
        || seen.has(path)
        || !Number.isSafeInteger(row.bytes)
        || row.bytes < 0
        || !RESOURCE_INVENTORY_KINDS.has(row.kind)
        || !/^[0-9a-f]{64}$/u.test(row.sha256)) {
      fail("resource_authority");
    }
    previousPath = path;
    seen.add(path);
    payloadBytes += row.bytes;
    if (payloadBytes > RESOURCE_MAXIMUM_PAYLOAD_BYTES) {
      fail("resource_authority");
    }
    payloadHash.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0${row.kind}\0`);
  }
  if (!exactObjectKeys(manifest.payload, ["bytes", "sha256"])
      || manifest.payload.bytes !== payloadBytes
      || manifest.payload.sha256 !== payloadHash.digest("hex")) {
    fail("resource_authority");
  }
  for (const required of REQUIRED_RESOURCE_PATHS) {
    if (!seen.has(required)) fail("resource_authority");
    const row = manifest.files.find((candidate) => candidate.path === required);
    if (row?.kind !== REQUIRED_RESOURCE_KINDS[required]) fail("resource_authority");
  }
  return seen;
}

function assertResourceManifestShape(manifest) {
  if (!exactObjectKeys(manifest, [
    "architecture",
    "dashboardRoot",
    "entrypoint",
    "files",
    "payload",
    "releaseVersion",
    "schemaVersion",
    "target",
    "windowsBinding",
  ])
      || manifest.schemaVersion !== WINDOWS_QUALIFICATION_RESOURCE_MANIFEST_SCHEMA
      || manifest.target !== "win32"
      || manifest.architecture !== "x64"
      || manifest.entrypoint !== "apps/electron/main.js"
      || manifest.dashboardRoot !== "apps/web/public"
      || typeof manifest.releaseVersion !== "string"
      || manifest.releaseVersion.length === 0) {
    fail("resource_authority");
  }
  const windowsBinding = manifest.windowsBinding;
  if (!exactObjectKeys(windowsBinding, [
    "binding",
    "included",
    "manifest",
    "status",
    "verified",
  ])
      || windowsBinding.included !== true
      || windowsBinding.status !== "included_unverified"
      || windowsBinding.verified !== false
      || !exactObjectKeys(windowsBinding.binding, ["bytes", "path", "sha256"])
      || !exactObjectKeys(windowsBinding.manifest, ["path"])
      || windowsBinding.binding.path !== RESOURCE_BINDING_PATH
      || windowsBinding.manifest.path !== RESOURCE_BINDING_MANIFEST_PATH
      || !Number.isSafeInteger(windowsBinding.binding.bytes)
      || windowsBinding.binding.bytes <= 0
      || !/^[0-9a-f]{64}$/u.test(windowsBinding.binding.sha256)) {
    fail("resource_authority");
  }
  const inventory = assertResourceInventory(manifest);
  const bindingRow = manifest.files.find((row) => row.path === RESOURCE_BINDING_PATH);
  const bindingManifestRow = manifest.files.find((row) =>
    row.path === RESOURCE_BINDING_MANIFEST_PATH);
  const keytarRow = manifest.files.find((row) => row.path === RESOURCE_KEYTAR_PATH);
  if (!inventory.has(RESOURCE_BINDING_PATH)
      || !inventory.has(RESOURCE_BINDING_MANIFEST_PATH)
      || !inventory.has(RESOURCE_KEYTAR_PATH)
      || bindingRow?.kind !== "windows_native_binding"
      || bindingManifestRow?.kind !== "windows_native_binding"
      || keytarRow?.kind !== "third_party_dependency"
      || manifest.windowsBinding.binding.bytes !== bindingRow?.bytes
      || manifest.windowsBinding.binding.sha256 !== bindingRow?.sha256) {
    fail("resource_authority");
  }
  return manifest;
}

function hostResourceRoot(value) {
  if (typeof value !== "string"
      || value.length === 0
      || value.length > 4096
      || value.includes("\0")
      || !isAbsolute(value)) {
    fail("resource_authority");
  }
  const selected = resolve(value);
  if (!isAbsolute(selected) || selected === selected.slice(0, 1)) {
    fail("resource_authority");
  }
  return selected;
}

function sameResourceRoot(left, right) {
  try {
    const normalizedLeft = resolve(left);
    const normalizedRight = resolve(right);
    return process.platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  } catch {
    return false;
  }
}

/**
 * Authenticate the resource tree that a Windows Electron child is about to
 * serve.  This is intentionally a package-bound development proof rather
 * than a production signature: the manifest is canonical and self-consistent
 * and the Windows binding is explicitly `included_unverified`.  A production
 * selector must continue to use the separate signed/readiness attestation.
 */
export function assertWindowsQualificationResourceAuthority({
  resourceRoot,
  platform = "win32",
  architecture = "x64",
} = {}) {
  if (platform !== "win32") fail("resource_authority");
  if (architecture !== "x64") fail("resource_authority");
  const root = hostResourceRoot(resourceRoot);
  const manifestPath = resolve(root, WINDOWS_QUALIFICATION_RESOURCE_MANIFEST_FILE);
  let bytes;
  try {
    bytes = readFileSync(manifestPath);
  } catch {
    fail("resource_authority");
  }
  if (!Buffer.isBuffer(bytes)
      || bytes.byteLength === 0
      || bytes.byteLength > RESOURCE_MAXIMUM_MANIFEST_BYTES) {
    fail("resource_authority");
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("resource_authority");
  }
  assertResourceManifestShape(manifest);
  return Object.freeze({
    contractVersion: WINDOWS_QUALIFICATION_RESOURCE_AUTHORITY_CONTRACT,
    resourceRoot: root,
    manifestPath,
    manifestSha256: sha256(bytes),
    manifest,
  });
}

function assertEnvironment(environment) {
  if (!isRecord(environment)) fail("invalid_environment");

  const marker = readOwn(
    environment,
    WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VARIABLE,
  );
  const testLane = readOwn(
    environment,
    WINDOWS_QUALIFICATION_MODE_TEST_LANE_ENVIRONMENT_VARIABLE,
  );
  const accountingSourceMode = readOwn(
    environment,
    "USAGE_MONITOR_ACCOUNTING_SOURCE_MODE",
  );
  const temporaryRoot = readOwn(environment, "TEMP");
  if (marker !== WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VALUE
      || testLane !== WINDOWS_QUALIFICATION_MODE_TEST_LANE
      || accountingSourceMode !== WINDOWS_QUALIFICATION_MODE_ACCOUNTING_SOURCE_MODE
      || typeof temporaryRoot !== "string") {
    fail("invalid_environment");
  }

  for (const key of FORBIDDEN_ORIGIN_ENVIRONMENT_KEYS) {
    const value = readOwn(environment, key);
    if (value !== undefined && value !== null) fail("forbidden_origin");
  }
  for (const key of FORBIDDEN_DEVELOPMENT_IDENTITY_ENVIRONMENT_KEYS) {
    const value = readOwn(environment, key);
    if (value !== undefined && value !== null) {
      fail("development_identity_forbidden");
    }
  }

  return Object.freeze({
    temporaryRoot,
    accountingSourceMode,
  });
}

function invalidWindowsPathComponent(component) {
  if (component.length === 0
      || component === "."
      || component === ".."
      || component.endsWith(".")
      || component.endsWith(" ")
      || /[<>:"|?*]/u.test(component)) {
    return true;
  }
  return RESERVED_WINDOWS_DEVICE_NAMES.has(
    component.split(".", 1)[0].toUpperCase(),
  );
}

/**
 * Normalize a Windows path without resolving it against the host platform.
 * This is important for portable contract tests on macOS and Linux: a
 * logical win32 context must still use Windows drive/path semantics.
 */
function normalizeWindowsAbsolutePath(value, code = "invalid_path") {
  if (typeof value !== "string"
      || value.length < 4
      || value.length > MAXIMUM_WINDOWS_PATH_LENGTH
      || value.includes("\0")) {
    fail(code);
  }

  const raw = value.replaceAll("/", "\\");
  // The native Windows adapter deliberately uses local drive paths.  Reject
  // UNC, device, and relative paths before normalization so no alternate
  // namespace becomes a qualification trust boundary.
  if (!/^[A-Za-z]:\\/u.test(raw) || raw.startsWith("\\\\")) {
    fail(code);
  }
  const rawComponents = raw.slice(3).split("\\");
  if (rawComponents.some((component) => component === "." || component === "..")) {
    fail(code === "invalid_root" ? "invalid_root" : "path_escape");
  }

  let normalized;
  try {
    normalized = win32.normalize(raw);
  } catch {
    fail(code);
  }
  if (!win32.isAbsolute(normalized) || !/^[A-Za-z]:\\/u.test(normalized)) {
    fail(code);
  }
  const parsed = win32.parse(normalized);
  const withoutRoot = normalized.slice(parsed.root.length);
  const components = withoutRoot.split("\\");
  if (components.some(invalidWindowsPathComponent)) fail(code);

  if (normalized.length > parsed.root.length && normalized.endsWith("\\")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function sameWindowsPath(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function isStrictWindowsDescendant(path, root) {
  const prefix = root.endsWith("\\") ? root : `${root}\\`;
  return path.length > root.length
    && path.toLowerCase().startsWith(prefix.toLowerCase());
}

function validatePathUnderRoot(value, root, label) {
  const normalized = normalizeWindowsAbsolutePath(value);
  if (!isStrictWindowsDescendant(normalized, root)) fail("path_escape");
  return Object.freeze({ label, value: normalized });
}

function assertNoReparsePathComponents(adapter, paths) {
  const inspected = new Set();
  for (const path of paths) {
    const parsed = win32.parse(path);
    let current = parsed.root;
    const components = path.slice(parsed.root.length).split("\\").filter(Boolean);
    for (const component of components) {
      current = win32.join(current, component);
      const key = current.toLowerCase();
      if (inspected.has(key)) continue;
      inspected.add(key);
      let metadata;
      try {
        metadata = adapter.inspectPath(current);
      } catch {
        fail("path_escape");
      }
      if (metadata?.isDirectory !== true
          || metadata?.isRegularFile !== false
          || metadata?.isReparsePoint !== false
          || metadata?.finalPathResolved !== true) {
        fail("path_escape");
      }
    }
  }
}

function validateAdapter(adapter) {
  let valid = false;
  try {
    valid = isWindowsFilesystemAdapter(adapter)
      && adapter.productionSafe === false
      && adapter.pathWalkRaceSafe === false
      && adapter.sqliteStateLeaseSafe === false
      && adapter.preparedArtifactSafe === false
      && adapter.companionInstanceMutexSafe === false;
  } catch {
    valid = false;
  }
  if (!valid) fail("invalid_adapter");
  return adapter;
}

function selectValue({
  options,
  nested,
  names,
  environment,
  environmentNames,
  equivalent = (left, right) => left === right,
}) {
  const candidates = [];
  for (const name of names) {
    const value = readOwn(options, name);
    if (value !== undefined) candidates.push(value);
  }
  if (nested !== undefined) {
    for (const name of names) {
      const value = readOwn(nested, name);
      if (value !== undefined) candidates.push(value);
    }
  }
  for (const name of environmentNames) {
    const value = readOwn(environment, name);
    if (value !== undefined) candidates.push(value);
  }
  if (candidates.length === 0) return undefined;
  const selected = candidates[0];
  if (candidates.some((candidate) => !equivalent(candidate, selected))) {
    fail("invalid_configuration");
  }
  return selected;
}

function rejectForbiddenOption(options, nested, names, code) {
  for (const name of names) {
    const values = [readOwn(options, name)];
    if (nested !== undefined) values.push(readOwn(nested, name));
    if (values.some((value) => value !== undefined && value !== null)) fail(code);
  }
}

function validateOptions(options) {
  if (!isRecord(options)) fail("invalid_configuration");

  const nested = readOwn(options, "paths");
  if (nested !== undefined && !isRecord(nested)) fail("invalid_configuration");

  const configuredEnvironment = readOwn(options, "environment");
  const aliasedEnvironment = readOwn(options, "env");
  if (configuredEnvironment !== undefined
      && aliasedEnvironment !== undefined
      && configuredEnvironment !== aliasedEnvironment) {
    fail("invalid_configuration");
  }
  const environment = configuredEnvironment
    ?? aliasedEnvironment
    ?? process.env;
  const environmentFacts = assertEnvironment(environment);

  const platform = readOwn(options, "platform") ?? process.platform;
  const architecture = readOwn(options, "architecture") ?? process.arch;
  if (platform !== "win32") fail("unsupported_platform");
  if (architecture !== "x64") fail("unsupported_architecture");

  const adapter = readOwn(options, "adapter");
  validateAdapter(adapter);

  const marker = readOwn(options, "qualificationMarker");
  if (marker !== undefined
      && marker !== WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VALUE) {
    fail("invalid_environment");
  }
  const testLane = readOwn(options, "testLane");
  if (testLane !== undefined && testLane !== WINDOWS_QUALIFICATION_MODE_TEST_LANE) {
    fail("invalid_environment");
  }
  const configuredAccountingSourceMode = readOwn(
    options,
    "accountingSourceMode",
  );
  const aliasedAccountingMode = readOwn(options, "accountingMode");
  if (configuredAccountingSourceMode !== undefined
      && aliasedAccountingMode !== undefined
      && configuredAccountingSourceMode !== aliasedAccountingMode) {
    fail("invalid_configuration");
  }
  const accountingSourceMode = configuredAccountingSourceMode
    ?? aliasedAccountingMode;
  if (accountingSourceMode !== undefined
      && accountingSourceMode !== WINDOWS_QUALIFICATION_MODE_ACCOUNTING_SOURCE_MODE) {
    fail("accounting_mode");
  }

  const configuredResourceRoot = readOwn(options, "resourceRoot");
  const environmentResourceRoot = readOwn(
    environment,
    "USAGE_MONITOR_RESOURCE_ROOT",
  );
  if (configuredResourceRoot !== undefined
      && environmentResourceRoot !== undefined
      && (typeof configuredResourceRoot !== "string"
        || typeof environmentResourceRoot !== "string"
        || !sameResourceRoot(configuredResourceRoot, environmentResourceRoot))) {
    fail("resource_authority");
  }
  const resourceRoot = configuredResourceRoot ?? environmentResourceRoot;
  const resourceAuthority = assertWindowsQualificationResourceAuthority({
    resourceRoot,
    platform,
    architecture,
  });

  rejectForbiddenOption(
    options,
    nested,
    [
      "centralOrigin",
      "centralServiceOrigin",
      "participantCentralOrigin",
      "contributionOrigin",
      "contributionServiceOrigin",
      "contributionServiceEndpoint",
    ],
    "forbidden_origin",
  );
  rejectForbiddenOption(
    options,
    nested,
    [
      "developmentExportSecretFile",
      "developmentIdentityOptIn",
      "environmentExportSecret",
      "exportSecret",
      "developmentExportIdentity",
    ],
    "development_identity_forbidden",
  );

  const root = normalizeWindowsAbsolutePath(environmentFacts.temporaryRoot, "invalid_root");
  const explicitRoot = selectValue({
    options,
    nested,
    names: ["tempRoot", "temporaryRoot", "disposableRoot"],
    environment,
    environmentNames: [],
    equivalent: (left, right) => sameWindowsPath(
      normalizeWindowsAbsolutePath(left, "invalid_root"),
      normalizeWindowsAbsolutePath(right, "invalid_root"),
    ),
  });
  if (explicitRoot !== undefined
      && !sameWindowsPath(
        normalizeWindowsAbsolutePath(explicitRoot, "invalid_root"),
        root,
      )) {
    fail("invalid_root");
  }

  const homeValue = selectValue({
    options,
    nested,
    names: ["homeDirectory", "homeDir", "home"],
    environment,
    environmentNames: ["HOME", "USERPROFILE"],
    equivalent: (left, right) => sameWindowsPath(
      normalizeWindowsAbsolutePath(left),
      normalizeWindowsAbsolutePath(right),
    ),
  });
  const homeDirectory = homeValue === undefined
    ? undefined
    : normalizeWindowsAbsolutePath(homeValue);
  if (homeDirectory === undefined) fail("invalid_path");

  const codexValue = selectValue({
    options,
    nested,
    names: ["codexHome", "codexHomeDirectory"],
    environment,
    environmentNames: ["CODEX_HOME"],
    equivalent: (left, right) => sameWindowsPath(
      normalizeWindowsAbsolutePath(left),
      normalizeWindowsAbsolutePath(right),
    ),
  }) ?? `${homeDirectory}\\.codex`;
  const claudeValue = selectValue({
    options,
    nested,
    names: ["claudeConfigDirectory", "claudeConfigDir", "claudeHome"],
    environment,
    environmentNames: ["CLAUDE_CONFIG_DIR"],
    equivalent: (left, right) => sameWindowsPath(
      normalizeWindowsAbsolutePath(left),
      normalizeWindowsAbsolutePath(right),
    ),
  }) ?? `${homeDirectory}\\.claude`;
  const stateValue = selectValue({
    options,
    nested,
    names: ["stateRoot", "stateDirectory", "statePath"],
    environment,
    environmentNames: ["USAGE_MONITOR_STATE_ROOT"],
    equivalent: (left, right) => sameWindowsPath(
      normalizeWindowsAbsolutePath(left),
      normalizeWindowsAbsolutePath(right),
    ),
  });
  if (stateValue === undefined) fail("invalid_path");

  const paths = Object.freeze({
    stateRoot: validatePathUnderRoot(stateValue, root, "stateRoot").value,
    codexHome: validatePathUnderRoot(codexValue, root, "codexHome").value,
    claudeConfigDirectory: validatePathUnderRoot(
      claudeValue,
      root,
      "claudeConfigDirectory",
    ).value,
    homeDirectory: validatePathUnderRoot(homeDirectory, root, "homeDirectory").value,
  });
  // Lexical containment is insufficient on Windows because any existing path
  // component may be a junction or another reparse point. Inspect every
  // component through the reviewed native adapter before granting the
  // disposable qualification capability. This is a point-in-time development
  // check only; production remains closed until a handle-bound path walk is
  // qualified as race-safe.
  assertNoReparsePathComponents(adapter, [
    root,
    paths.homeDirectory,
    paths.codexHome,
    paths.claudeConfigDirectory,
    paths.stateRoot,
  ]);

  return Object.freeze({
    platform,
    architecture,
    adapter,
    accountingSourceMode: WINDOWS_QUALIFICATION_MODE_ACCOUNTING_SOURCE_MODE,
    disposableRoot: root,
    resourceAuthority,
    paths,
  });
}

/**
 * Create a branded, qualification-only Windows Electron context.
 *
 * `adapter` must be the exact object returned by
 * `createWindowsFilesystemAdapter({ platform: "win32", architecture: "x64" })`.
 * The adapter is intentionally required to remain non-production-safe: this
 * context is for exercising the native boundary with disposable state, not
 * for selecting production credentials or readiness.
 */
export function createWindowsQualificationModeContext(options = {}) {
  const configuration = validateOptions(options);
  const {
    platform,
    architecture,
    adapter,
    accountingSourceMode,
    disposableRoot,
    resourceAuthority,
    paths,
  } = configuration;
  const context = Object.freeze({
    contractVersion: WINDOWS_QUALIFICATION_MODE_CONTRACT_VERSION,
    platform,
    architecture,
    qualificationOnly: WINDOWS_QUALIFICATION_MODE_QUALIFICATION_ONLY,
    productionSafe: WINDOWS_QUALIFICATION_MODE_PRODUCTION_SAFE,
    accountingSourceMode,
    testLane: WINDOWS_QUALIFICATION_MODE_TEST_LANE,
    disposableRoot,
    tempRoot: disposableRoot,
    resourceRoot: resourceAuthority.resourceRoot,
    resourceManifestSha256: resourceAuthority.manifestSha256,
    stateRoot: paths.stateRoot,
    codexHome: paths.codexHome,
    claudeConfigDirectory: paths.claudeConfigDirectory,
    claudeHome: paths.claudeConfigDirectory,
    homeDirectory: paths.homeDirectory,
  });
  CONTEXTS.add(context);
  CONTEXT_BINDINGS.set(context, Object.freeze({
    adapter,
    stateRoot: paths.stateRoot,
    resourceRoot: resourceAuthority.resourceRoot,
    resourceManifestSha256: resourceAuthority.manifestSha256,
  }));
  return context;
}

export function isWindowsQualificationModeContext(context) {
  try {
    return context !== null
      && typeof context === "object"
      && CONTEXTS.has(context);
  } catch {
    return false;
  }
}

export function isWindowsQualificationModeContextFor({
  context,
  adapter,
  stateRoot,
  resourceRoot,
} = {}) {
  if (!isWindowsQualificationModeContext(context)) return false;
  try {
    const binding = CONTEXT_BINDINGS.get(context);
    if (!binding || binding.adapter !== adapter) return false;
    const normalized = normalizeWindowsAbsolutePath(stateRoot);
    if (!sameWindowsPath(binding.stateRoot, normalized)) return false;
    const authority = assertWindowsQualificationResourceAuthority({
      resourceRoot,
      platform: "win32",
      architecture: "x64",
    });
    return sameResourceRoot(binding.resourceRoot, authority.resourceRoot)
      && binding.resourceManifestSha256 === authority.manifestSha256;
  } catch {
    return false;
  }
}
