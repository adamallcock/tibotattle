import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  assertWindowsQualificationResourceAuthority,
} from "../../src/platform/index.js";
import {
  KEYTAR_WIN32_X64_SHA256,
  loadAuditedWindowsCredentialBinding,
  runWindowsCredentialManagerProbe,
} from "../../src/platform/windows-credential-manager-probe.js";

export const WINDOWS_ELECTRON_QUALIFICATION_ENVIRONMENT_KEY =
  "USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION";
export const WINDOWS_ELECTRON_QUALIFICATION_MARKER = "windows-electron-v1";
export const WINDOWS_ELECTRON_TEST_LANE = "windows-electron-smoke";
export const WINDOWS_ELECTRON_QUALIFICATION_CONTRACT =
  "windows-electron-qualification-v1";
export const WINDOWS_ELECTRON_RUNTIME_MANIFEST_FILE =
  "electron-runtime-manifest.json";
export const WINDOWS_ELECTRON_RUNTIME_MANIFEST_SCHEMA =
  "usage-monitor-electron-runtime-v0.1";
export const WINDOWS_ELECTRON_BINDING_RELATIVE_PATH =
  "native/windows-filesystem/build/Release/windows_filesystem.node";
export const WINDOWS_ELECTRON_BINDING_MANIFEST_RELATIVE_PATH =
  `${WINDOWS_ELECTRON_BINDING_RELATIVE_PATH}.manifest.json`;
export const WINDOWS_ELECTRON_KEYTAR_RELATIVE_PATH =
  "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node";

const WINDOWS_BINDING_MANIFEST_SCHEMA =
  "windows-filesystem-binding-manifest-v1";
const WINDOWS_BINDING_PROVENANCE_CONTRACT = "windows-binding-provenance-v1";
const WINDOWS_BINDING_FILE = "windows_filesystem.node";
const WINDOWS_BINDING_PLATFORM = "win32";
const WINDOWS_BINDING_ARCHITECTURE = "x64";
const PRODUCT_NAME = "TiboTattle Dev";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAXIMUM_BINDING_BYTES = 64 * 1024 * 1024;
const MAXIMUM_MANIFEST_BYTES = 1 * 1024 * 1024;
const MAXIMUM_RUNTIME_PAYLOAD_BYTES = 512 * 1024 * 1024;
const RUNTIME_INVENTORY_KINDS = new Set([
  "companion_source",
  "electron_shell",
  "dashboard_asset",
  "workspace_dependency",
  "third_party_dependency",
  "windows_native_binding",
  "runtime_metadata",
]);
const ELECTRON_SHELL_IDENTITY_FILES = Object.freeze([
  "apps/electron/companion-supervisor.js",
  "apps/electron/desktop-lifecycle.js",
  "apps/electron/errors.js",
  "apps/electron/loopback-policy.js",
  "apps/electron/main.js",
  "apps/electron/platform-gate.js",
  "apps/electron/preload.cjs",
  "apps/electron/ready-line.js",
]);

// A qualification context is an authority-bearing object. A receipt-shaped
// copy, a JSON round trip, or a caller-created object must never be accepted
// by the platform gate. Keep the authority entirely in this module.
const QUALIFICATION_CONTEXTS = new WeakSet();
const QUALIFICATION_METADATA = new WeakMap();

function qualificationError(code) {
  const error = new Error("Windows Electron qualification is unavailable");
  error.code = `WINDOWS_ELECTRON_QUALIFICATION_${code}`;
  return error;
}

function fail(code) {
  throw qualificationError(code);
}

function bytes(value, label) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  fail(`${label.toUpperCase()}_INVALID`);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value.toString("utf8"));
  } catch {
    fail(`${label.toUpperCase()}_INVALID`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`${label.toUpperCase()}_INVALID`);
  }
  return parsed;
}

function exactAbsolutePath(value) {
  return typeof value === "string" && value.length > 0 && isAbsolute(value);
}

function comparePathBytes(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function exactObjectKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort(comparePathBytes))
      === JSON.stringify([...keys].sort(comparePathBytes));
}

function packagedResourcePath(appPath, relativePath, { unpacked = false } = {}) {
  if (unpacked && appPath.toLowerCase().endsWith(".asar")) {
    return resolve(`${appPath}.unpacked`, ...relativePath.split("/"));
  }
  return resolve(appPath, ...relativePath.split("/"));
}

function rowForPath(manifest, relativePath) {
  if (!Array.isArray(manifest?.files)) fail("RUNTIME_MANIFEST_INVALID");
  const rows = manifest.files.filter((row) => row?.path === relativePath);
  if (rows.length !== 1) fail("RUNTIME_MANIFEST_BINDING_MISSING");
  const [row] = rows;
  if (!Number.isSafeInteger(row.bytes)
      || row.bytes <= 0
      || typeof row.kind !== "string"
      || !SHA256_PATTERN.test(row.sha256)) {
    fail("RUNTIME_MANIFEST_BINDING_INVALID");
  }
  return row;
}

function assertRuntimeManifestInventoryShape(manifest) {
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
      || manifest.schemaVersion !== WINDOWS_ELECTRON_RUNTIME_MANIFEST_SCHEMA
      || manifest.target !== WINDOWS_BINDING_PLATFORM
      || manifest.architecture !== WINDOWS_BINDING_ARCHITECTURE
      || manifest.entrypoint !== "apps/electron/main.js"
      || manifest.dashboardRoot !== "apps/web/public"
      || typeof manifest.releaseVersion !== "string"
      || manifest.releaseVersion.length === 0
      || !Array.isArray(manifest.files)
      || manifest.files.length === 0
      || !exactObjectKeys(manifest.payload, ["bytes", "sha256"])
      || !Number.isSafeInteger(manifest.payload.bytes)
      || manifest.payload.bytes < 0
      || manifest.payload.bytes > MAXIMUM_RUNTIME_PAYLOAD_BYTES
      || !SHA256_PATTERN.test(manifest.payload.sha256)) {
    fail("RUNTIME_MANIFEST_INVALID");
  }
  const seen = new Set();
  let previousPath = null;
  for (const row of manifest.files) {
    if (!exactObjectKeys(row, ["bytes", "kind", "path", "sha256"])
        || typeof row.path !== "string"
        || row.path.length === 0
        || row.path.includes("\\")
        || row.path.includes("\0")
        || row.path.startsWith("/")
        || /^[A-Za-z]:[\\/]/u.test(row.path)
        || row.path.split("/").some((part) =>
          part.length === 0 || part === "." || part === "..")
        || row.path === WINDOWS_ELECTRON_RUNTIME_MANIFEST_FILE
        || (previousPath !== null && comparePathBytes(previousPath, row.path) >= 0)
        || seen.has(row.path)
        || !Number.isSafeInteger(row.bytes)
        || row.bytes < 0
        || !RUNTIME_INVENTORY_KINDS.has(row.kind)
        || !SHA256_PATTERN.test(row.sha256)) {
      fail("RUNTIME_MANIFEST_INVALID");
    }
    previousPath = row.path;
    seen.add(row.path);
  }
  if (!ELECTRON_SHELL_IDENTITY_FILES.every((path) => seen.has(path))) {
    fail("RUNTIME_MANIFEST_INVALID");
  }
  return seen;
}

function assertRuntimeManifest(manifest, bindingBytes, bindingDigest, sidecarBytes) {
  assertRuntimeManifestInventoryShape(manifest);
  if (manifest.schemaVersion !== WINDOWS_ELECTRON_RUNTIME_MANIFEST_SCHEMA
      || manifest.target !== WINDOWS_BINDING_PLATFORM
      || manifest.architecture !== WINDOWS_BINDING_ARCHITECTURE
      || manifest.entrypoint !== "apps/electron/main.js"
      || manifest.dashboardRoot !== "apps/web/public"
      || manifest.windowsBinding?.included !== true
      || manifest.windowsBinding?.status !== "included_unverified"
      || manifest.windowsBinding?.verified !== false
      || manifest.windowsBinding?.binding?.path !== WINDOWS_ELECTRON_BINDING_RELATIVE_PATH
      || manifest.windowsBinding?.manifest?.path
        !== WINDOWS_ELECTRON_BINDING_MANIFEST_RELATIVE_PATH
      || manifest.windowsBinding?.binding?.bytes !== bindingBytes.byteLength
      || manifest.windowsBinding?.binding?.sha256 !== bindingDigest) {
    fail("RUNTIME_MANIFEST_INVALID");
  }
  const bindingRow = rowForPath(manifest, WINDOWS_ELECTRON_BINDING_RELATIVE_PATH);
  if (bindingRow.bytes !== bindingBytes.byteLength
      || bindingRow.sha256 !== bindingDigest) {
    fail("RUNTIME_MANIFEST_BINDING_MISMATCH");
  }
  const sidecarRow = rowForPath(
    manifest,
    WINDOWS_ELECTRON_BINDING_MANIFEST_RELATIVE_PATH,
  );
  if (sidecarRow.bytes !== sidecarBytes.byteLength
      || sidecarRow.sha256 !== digest(sidecarBytes)) {
    fail("RUNTIME_MANIFEST_MANIFEST_MISMATCH");
  }
  return Object.freeze({ bindingRow, sidecarRow });
}

function isUnpackedRuntimePath(relativePath) {
  return relativePath === WINDOWS_ELECTRON_BINDING_RELATIVE_PATH
    || relativePath === WINDOWS_ELECTRON_KEYTAR_RELATIVE_PATH;
}

async function assertRuntimeInventoryBytes({ appPath, manifest }) {
  const payloadHash = createHash("sha256");
  let payloadBytes = 0;
  for (const row of manifest.files) {
    const path = packagedResourcePath(
      appPath,
      row.path,
      { unpacked: isUnpackedRuntimePath(row.path) },
    );
    let fileBytes;
    try {
      fileBytes = await readFile(path);
    } catch {
      fail("RUNTIME_INVENTORY_MISSING");
    }
    const selected = bytes(fileBytes, "runtime_inventory");
    if (selected.byteLength !== row.bytes || digest(selected) !== row.sha256) {
      fail("RUNTIME_INVENTORY_MISMATCH");
    }
    payloadBytes += selected.byteLength;
    payloadHash.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0${row.kind}\0`);
  }
  if (payloadBytes !== manifest.payload.bytes
      || payloadHash.digest("hex") !== manifest.payload.sha256) {
    fail("RUNTIME_PAYLOAD_MISMATCH");
  }
}

function assertBindingManifest(manifest, bindingBytes, bindingDigest) {
  if (manifest.schemaVersion !== WINDOWS_BINDING_MANIFEST_SCHEMA
      || manifest.bindingFile !== WINDOWS_BINDING_FILE
      || manifest.platform !== WINDOWS_BINDING_PLATFORM
      || manifest.architecture !== WINDOWS_BINDING_ARCHITECTURE
      || manifest.bytes !== bindingBytes.byteLength
      || manifest.sha256 !== bindingDigest
      || !SHA256_PATTERN.test(manifest.sha256)
      || manifest.contractVersion !== "windows-filesystem-v1"
      || manifest.securityContractVersion !== "windows-filesystem-security-v1"
      || manifest.bindingProvenance?.contractVersion
        !== WINDOWS_BINDING_PROVENANCE_CONTRACT
      || manifest.bindingProvenance?.status !== "unqualified"
      || manifest.bindingProvenance?.source !== "unsigned-development-binding") {
    fail("BINDING_MANIFEST_MISMATCH");
  }
}

function assertKeytarRow(manifest, keytarBytes) {
  const row = rowForPath(manifest, WINDOWS_ELECTRON_KEYTAR_RELATIVE_PATH);
  if (row.bytes !== keytarBytes.byteLength || row.sha256 !== digest(keytarBytes)) {
    fail("KEYTAR_MANIFEST_MISMATCH");
  }
  return row;
}

function validEnvironment(environment) {
  return environment !== null
    && typeof environment === "object"
    && !Array.isArray(environment);
}

function requestedQualification(environment) {
  return validEnvironment(environment)
    && environment[WINDOWS_ELECTRON_QUALIFICATION_ENVIRONMENT_KEY]
      === WINDOWS_ELECTRON_QUALIFICATION_MARKER
    && environment.USAGE_MONITOR_TEST_LANE === WINDOWS_ELECTRON_TEST_LANE;
}

/**
 * Read and authenticate the exact packaged Windows development artifact.
 *
 * The default entrypoint supplies only the real Electron app object and reads
 * the package with the real filesystem reader.  There is deliberately no
 * public filesystem-reader seam: package bytes and authority must come from
 * the app's own packaged resource root.
 */
export async function createWindowsElectronQualificationContext({
  app,
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  if (!requestedQualification(environment)
      || platform !== WINDOWS_BINDING_PLATFORM
      || architecture !== WINDOWS_BINDING_ARCHITECTURE
      || app?.isPackaged !== true
      || typeof app?.getAppPath !== "function"
      || typeof app?.getName !== "function") {
    return null;
  }
  let appName;
  try {
    appName = app.getName();
  } catch {
    return null;
  }
  if (appName !== PRODUCT_NAME) return null;
  let rawAppPath;
  try {
    rawAppPath = app.getAppPath();
  } catch {
    fail("APP_PATH_INVALID");
  }
  if (!exactAbsolutePath(rawAppPath)) fail("APP_PATH_INVALID");
  const appPath = resolve(rawAppPath);
  let resourceAuthority;
  try {
    resourceAuthority = assertWindowsQualificationResourceAuthority({
      resourceRoot: appPath,
      platform,
      architecture,
    });
  } catch {
    fail("RESOURCE_AUTHORITY_INVALID");
  }
  const bindingPath = packagedResourcePath(
    appPath,
    WINDOWS_ELECTRON_BINDING_RELATIVE_PATH,
    { unpacked: true },
  );
  const bindingManifestPath = packagedResourcePath(
    appPath,
    WINDOWS_ELECTRON_BINDING_MANIFEST_RELATIVE_PATH,
  );
  const keytarBindingPath = packagedResourcePath(
    appPath,
    WINDOWS_ELECTRON_KEYTAR_RELATIVE_PATH,
    { unpacked: true },
  );

  let bindingBytes;
  let bindingManifestBytes;
  let keytarBytes;
  try {
    [bindingBytes, bindingManifestBytes, keytarBytes] = await Promise.all([
      readFile(bindingPath),
      readFile(bindingManifestPath),
      readFile(keytarBindingPath),
    ]);
  } catch {
    fail("PACKAGE_INPUT_MISSING");
  }
  bindingBytes = bytes(bindingBytes, "binding");
  bindingManifestBytes = bytes(bindingManifestBytes, "binding_manifest");
  keytarBytes = bytes(keytarBytes, "keytar");
  if (bindingBytes.byteLength <= 0 || bindingBytes.byteLength > MAXIMUM_BINDING_BYTES
      || bindingManifestBytes.byteLength <= 0
      || bindingManifestBytes.byteLength > MAXIMUM_MANIFEST_BYTES) {
    fail("PACKAGE_INPUT_SIZE");
  }
  const runtimeManifest = resourceAuthority.manifest;
  const bindingManifest = parseJson(bindingManifestBytes, "binding_manifest");
  const bindingDigest = digest(bindingBytes);
  assertRuntimeManifest(
    runtimeManifest,
    bindingBytes,
    bindingDigest,
    bindingManifestBytes,
  );
  assertBindingManifest(bindingManifest, bindingBytes, bindingDigest);
  const keytarRow = assertKeytarRow(runtimeManifest, keytarBytes);
  if (digest(keytarBytes) !== KEYTAR_WIN32_X64_SHA256) {
    fail("KEYTAR_INTEGRITY");
  }
  await assertRuntimeInventoryBytes({ appPath, manifest: runtimeManifest });

  const context = Object.freeze({
    contractVersion: WINDOWS_ELECTRON_QUALIFICATION_CONTRACT,
    marker: WINDOWS_ELECTRON_QUALIFICATION_MARKER,
    lane: WINDOWS_ELECTRON_TEST_LANE,
    productName: PRODUCT_NAME,
    platform: WINDOWS_BINDING_PLATFORM,
    architecture: WINDOWS_BINDING_ARCHITECTURE,
    runtimeManifestSchema: WINDOWS_ELECTRON_RUNTIME_MANIFEST_SCHEMA,
    runtimeTarget: WINDOWS_BINDING_PLATFORM,
    runtimeArchitecture: WINDOWS_BINDING_ARCHITECTURE,
    resourceRoot: resourceAuthority.resourceRoot,
    resourceManifestSha256: resourceAuthority.manifestSha256,
    windowsBinding: Object.freeze({
      included: true,
      status: "included_unverified",
      verified: false,
    }),
    windowsProductionReady: false,
    windowsQualificationOnly: true,
  });
  QUALIFICATION_CONTEXTS.add(context);
  QUALIFICATION_METADATA.set(context, Object.freeze({
    appPath,
    resourceManifestSha256: resourceAuthority.manifestSha256,
    bindingPath,
    bindingManifestPath,
    bindingBytes,
    bindingSha256: bindingDigest,
    keytarBindingPath,
    keytarBytes,
    keytarSha256: keytarRow.sha256,
  }));
  return context;
}

export function isWindowsElectronQualificationContext(value) {
  return QUALIFICATION_CONTEXTS.has(value);
}

export function assertWindowsElectronQualificationContext({
  context = null,
  platform,
  architecture,
} = {}) {
  if (!QUALIFICATION_CONTEXTS.has(context)) fail("CONTEXT_UNAUTHENTIC");
  const metadata = QUALIFICATION_METADATA.get(context);
  let valid = false;
  try {
    valid = metadata !== undefined
      && context.contractVersion === WINDOWS_ELECTRON_QUALIFICATION_CONTRACT
      && context.marker === WINDOWS_ELECTRON_QUALIFICATION_MARKER
      && context.lane === WINDOWS_ELECTRON_TEST_LANE
      && context.productName === PRODUCT_NAME
      && context.platform === WINDOWS_BINDING_PLATFORM
      && context.architecture === WINDOWS_BINDING_ARCHITECTURE
      && context.runtimeManifestSchema === WINDOWS_ELECTRON_RUNTIME_MANIFEST_SCHEMA
      && context.runtimeTarget === WINDOWS_BINDING_PLATFORM
      && context.runtimeArchitecture === WINDOWS_BINDING_ARCHITECTURE
      && exactAbsolutePath(context.resourceRoot)
      && context.resourceRoot === metadata.appPath
      && context.resourceManifestSha256 === metadata.resourceManifestSha256
      && context.windowsBinding?.included === true
      && context.windowsBinding?.status === "included_unverified"
      && context.windowsBinding?.verified === false
      && context.windowsProductionReady === false
      && context.windowsQualificationOnly === true
      && exactAbsolutePath(metadata.appPath)
      && exactAbsolutePath(metadata.bindingPath)
      && exactAbsolutePath(metadata.bindingManifestPath)
      && exactAbsolutePath(metadata.keytarBindingPath)
      && metadata.bindingBytes?.byteLength > 0
      && metadata.bindingSha256 === digest(metadata.bindingBytes)
      && metadata.keytarBytes?.byteLength > 0
      && metadata.keytarSha256 === digest(metadata.keytarBytes);
  } catch {
    valid = false;
  }
  if (!valid
      || (platform !== undefined && platform !== WINDOWS_BINDING_PLATFORM)
      || (architecture !== undefined && architecture !== WINDOWS_BINDING_ARCHITECTURE)) {
    fail("CONTEXT_INVALID");
  }
  return context;
}

function metadataFor(context) {
  assertWindowsElectronQualificationContext({ context });
  return QUALIFICATION_METADATA.get(context);
}

/** Load only the fixed packaged keytar binding associated with this context. */
export function loadWindowsElectronQualificationCredentialBinding(context) {
  const metadata = metadataFor(context);
  const binding = loadAuditedWindowsCredentialBinding({
    platform: "win32",
    architecture: "x64",
    resolveBinding: () => metadata.keytarBindingPath,
    readBinding: (path) => readFileSync(path),
  });
  // Keep the package hash check explicit at this boundary as well as in the
  // existing audited loader. This prevents a test seam from silently changing
  // the artifact selected by a real qualification context.
  if (metadata.keytarSha256 !== KEYTAR_WIN32_X64_SHA256) {
    fail("KEYTAR_INTEGRITY");
  }
  return binding;
}

export function validateWindowsElectronQualificationRunId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail("RUN_ID_INVALID");
  }
  return value.toLowerCase();
}

function syntheticSecret(runId) {
  return createHash("sha256")
    .update(`tibotattle-windows-electron-qualification-v1:${runId}`)
    .digest("base64url");
}

function qualificationCredentialTuple(runId) {
  return Object.freeze({
    service: `app-usagemonitor.windows-qualification.${runId}`,
    account: "disposable-probe",
    secret: syntheticSecret(runId),
  });
}

/**
 * Exercise the disposable Credential Manager namespace used by the packaged
 * smoke. The tuple is intentionally private; callers receive only a fixed
 * result and no service, account, secret, or filesystem value.
 */
async function runCredentialCommandWithBinding({ context, command, runId, binding }) {
  metadataFor(context);
  if (binding === null || typeof binding !== "object") fail("CREDENTIAL_BINDING_INVALID");
  if (!new Set(["create-v1", "read-v1", "delete-v1"]).has(command)) {
    fail("CREDENTIAL_COMMAND_INVALID");
  }
  const tuple = qualificationCredentialTuple(
    validateWindowsElectronQualificationRunId(runId),
  );
  try {
    if (command === "create-v1") {
      await binding.setPassword(tuple.service, tuple.account, tuple.secret);
      const observed = await binding.getPassword(tuple.service, tuple.account);
      if (typeof observed !== "string"
          || !timingSafeEqual(Buffer.from(observed), Buffer.from(tuple.secret))) {
        fail("CREDENTIAL_CREATE_FAILED");
      }
    } else if (command === "read-v1") {
      const observed = await binding.getPassword(tuple.service, tuple.account);
      if (typeof observed !== "string"
          || !timingSafeEqual(Buffer.from(observed), Buffer.from(tuple.secret))) {
        fail("CREDENTIAL_READ_FAILED");
      }
    } else {
      const deleted = await binding.deletePassword(tuple.service, tuple.account);
      const remaining = await binding.getPassword(tuple.service, tuple.account);
      if (remaining !== null || deleted !== true) fail("CREDENTIAL_DELETE_FAILED");
    }
  } catch (error) {
    if (error?.code?.startsWith("WINDOWS_ELECTRON_QUALIFICATION_")) throw error;
    fail(`CREDENTIAL_${command.slice(0, -3).toUpperCase()}_FAILED`);
  }
  return Object.freeze({
    status: "passed",
    command,
    cleanup: command === "delete-v1" ? "confirmed" : "pending",
  });
}

/**
 * Run a credential command against the exact packaged keytar binding. This is
 * the only command path used by the Electron process; no binding injection is
 * accepted at this production-facing boundary.
 */
export async function runWindowsElectronQualificationCredentialCommand({
  context,
  command,
  runId,
} = {}) {
  return runCredentialCommandWithBinding({
    context,
    command,
    runId,
    binding: loadWindowsElectronQualificationCredentialBinding(context),
  });
}

/** Dependency-injected seam for plain-Node contract tests only. */
export async function runWindowsElectronQualificationCredentialCommandForTest({
  context,
  command,
  runId,
  binding,
} = {}) {
  return runCredentialCommandWithBinding({ context, command, runId, binding });
}

/** Run the existing random-namespace probe against the exact packaged keytar. */
export async function runWindowsElectronQualificationCredentialProbe(context) {
  const binding = loadWindowsElectronQualificationCredentialBinding(context);
  return runWindowsCredentialManagerProbe({ binding });
}

export const WINDOWS_ELECTRON_PRODUCT_NAME = PRODUCT_NAME;
