import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_BRAND } from "../config/product-brand.js";
import {
  assertDeploymentEndpoints,
  DEPLOYMENT_ENDPOINTS,
} from "../config/deployment-endpoints.js";
import {
  assertReleaseChannelPublication,
  createReleaseChannelProvenance,
  STABLE_RELEASE_CHANNEL,
  STABLE_SPARKLE_BOOTSTRAP_MODE,
  STABLE_SPARKLE_KEY_CONTINUITY_MODE,
  resolveReleaseChannel,
} from "../config/release-channels.js";
import {
  SPARKLE_FRAMEWORK_LINKS,
  SPARKLE_FRAMEWORK_SHA256,
  SPARKLE_MACH_O_PATHS,
  SPARKLE_VERSION,
  normalizeMacOSUpdaterConfiguration,
} from "./macos-updater-core.js";
import {
  buildMacOSAppForRelease,
  buildMacOSReleaseCandidate,
  validateMacOSPreviewApp,
} from "./build-macos-app.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const BUILD_MANIFEST_SCHEMA = "usage-monitor-macos-app-build-v0.1";
const RELEASE_MANIFEST_SCHEMA = "usage-monitor-macos-release-v0.2";
const STABLE_RELEASE_MANIFEST_MAX_BYTES = 1024 * 1024;
const PUBLIC_KEY_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const REPLACEMENT_CONTRACT_SCHEMA =
  "usage-monitor-macos-signed-replacement-v1";
const BUNDLE_IDENTIFIER = PRODUCT_BRAND.bundleIdentifier;
const APP_NAME = PRODUCT_BRAND.bundleName;
const APP_OPEN_SCHEME = PRODUCT_BRAND.appOpenScheme;
const FIXED_EPOCH_SECONDS = 946_684_800;
const DMG_DISTRIBUTIONS = Object.freeze({
  development: "development",
  preview: "preview",
  release: "release",
});
const BUILD_MANIFEST_PATH =
  "Contents/Resources/build-manifest.json";
const CODE_RESOURCES_PATH = "Contents/_CodeSignature/CodeResources";
const APPLE_STAPLED_TICKET_PATH = "Contents/CodeResources";
const EMBEDDED_PROFILE_PATH = "Contents/embedded.provisionprofile";
const NODE_ENTITLEMENTS = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "NodeRuntime.entitlements",
);
const APP_EXECUTABLE =
  `Contents/MacOS/${PRODUCT_BRAND.executableName}`;
const NODE_EXECUTABLE = "Contents/Resources/runtime/bin/node";
const KEYTAR_EXECUTABLE = [
  "Contents",
  "Resources",
  "app",
  "node_modules",
  "@github",
  "keytar",
  "prebuilds",
  "darwin-arm64",
  "keytar.node",
].join("/");
const SPARKLE_FRAMEWORK_PREFIX =
  "Contents/Frameworks/Sparkle.framework";
const BASE_NORMALIZED_MACH_O_PATHS = Object.freeze([
  APP_EXECUTABLE,
  NODE_EXECUTABLE,
  KEYTAR_EXECUTABLE,
]);
const SPARKLE_NORMALIZED_MACH_O_PATHS = Object.freeze(
  SPARKLE_MACH_O_PATHS.map(
    (path) => `${SPARKLE_FRAMEWORK_PREFIX}/${path}`,
  ),
);
const NORMALIZED_MACH_O_PATHS = new Set([
  ...BASE_NORMALIZED_MACH_O_PATHS,
  ...SPARKLE_NORMALIZED_MACH_O_PATHS,
]);
const REQUIRED_SIGNED_RELEASE_ASSURANCES = Object.freeze([
  "appNotarizationAccepted",
  "appTicketStapled",
  "candidateReproducedFromCheckedOutSource",
  "cleanProfileSmokePassed",
  "developerIDHardenedRuntime",
  "dmgGatekeeperAssessmentPassed",
  "dmgNotarizationAccepted",
  "dmgTicketStapled",
]);
const REQUIRED_NODE_RUNTIME_ENTITLEMENTS = Object.freeze([
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
]);
const LOGIN_ITEM_RELEASE_REHEARSAL_SCHEMA =
  "usage-monitor-macos-login-item-release-rehearsal-v1";
const REQUIRED_LOGIN_ITEM_REHEARSAL_CHECKS = Object.freeze([
  "firstRunConsentIsVisibleAndAffirmative",
  "settingsReconcileAfterSystemSettingsChange",
  "enableDisableAndPendingRemoval",
  "automaticLoginLaunch",
  "upgradeRetainsSingleMainAppLoginItem",
  "moveAndReinstallLeavesNoStaleDuplicate",
  "uninstallAndReinstallLeavesNoStaleDuplicate",
  "duplicateLaunchExplainsExistingApp",
  "windowCloseKeepsMenuBarAndQuitStopsApp",
  "noAgentDaemonOrBackgroundUpload",
]);
const LOGIN_ITEM_CONTRACT_OUTPUT =
  "USAGE_MONITOR_MACOS_LOGIN_ITEM_CONTRACT "
  + "fake=true register=affirmative-only unregister=explicit "
  + "status=enabled,not-registered,requires-approval,unavailable "
  + "outcomes=confirmed,requires-approval,not-confirmed,unavailable,failed "
  + "pending_removal=true real_service_calls=0 daemon=false";

assertDeploymentEndpoints();

function fail(message, code = "MACOS_RELEASE_FAILED") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function resolveOperationalReleaseChannel(channel = "stable") {
  if (typeof channel !== "string") {
    fail(
      "Release inspection must select a named release channel",
      "MACOS_RELEASE_CHANNEL_NAME_REQUIRED",
    );
  }
  return resolveReleaseChannel(channel);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function releaseGit(repositoryRoot, arguments_) {
  return spawnSync("/usr/bin/git", ["-C", repositoryRoot, ...arguments_], {
    encoding: "utf8",
    env: releaseEnvironment(),
    maxBuffer: 1024 * 1024,
  });
}

function requiredReleaseGitOutput(repositoryRoot, arguments_, code) {
  const result = releaseGit(repositoryRoot, arguments_);
  if (result.error || result.status !== 0) {
    fail("Unable to establish signed-release source provenance", code);
  }
  return String(result.stdout ?? "").trim();
}

/**
 * A notarized DMG must name an immutable source revision. Refuse a dirty,
 * lightweight-tagged, or untagged checkout instead of relying on the local
 * filename or a build digest that cannot identify the public source release.
 */
export function readMacOSReleaseSourceProvenance({
  repositoryRoot = REPOSITORY_ROOT,
} = {}) {
  const root = resolve(repositoryRoot);
  const status = releaseGit(
    root,
    ["status", "--porcelain=v1", "--untracked-files=all"],
  );
  if (status.error || status.status !== 0) {
    fail("Unable to establish signed-release source provenance", "MACOS_RELEASE_PROVENANCE_INVALID");
  }
  if (status.stdout?.trim() !== "") {
    fail(
      "A signed release requires a clean source checkout",
      "MACOS_RELEASE_SOURCE_DIRTY",
    );
  }
  const commit = requiredReleaseGitOutput(
    root,
    ["rev-parse", "HEAD"],
    "MACOS_RELEASE_PROVENANCE_INVALID",
  );
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
    fail("Release source commit is invalid", "MACOS_RELEASE_PROVENANCE_INVALID");
  }
  const tag = requiredReleaseGitOutput(
    root,
    ["describe", "--exact-match", "--tags", "HEAD"],
    "MACOS_RELEASE_TAG_REQUIRED",
  );
  if (!/^[0-9A-Za-z][0-9A-Za-z._/-]{0,127}$/u.test(tag)
      || tag.includes("..")
      || tag.startsWith("/")
      || tag.endsWith("/")) {
    fail("Release source tag is invalid", "MACOS_RELEASE_PROVENANCE_INVALID");
  }
  const objectType = requiredReleaseGitOutput(
    root,
    ["for-each-ref", "--format=%(objecttype)", `refs/tags/${tag}`],
    "MACOS_RELEASE_PROVENANCE_INVALID",
  );
  if (objectType !== "tag") {
    fail(
      "A signed release requires an annotated Git tag",
      "MACOS_RELEASE_TAG_REQUIRED",
    );
  }
  const taggedCommit = requiredReleaseGitOutput(
    root,
    ["rev-parse", `${tag}^{}`],
    "MACOS_RELEASE_PROVENANCE_INVALID",
  );
  if (taggedCommit !== commit) {
    fail(
      "Release tag does not identify HEAD",
      "MACOS_RELEASE_PROVENANCE_INVALID",
    );
  }
  return Object.freeze({ commit, tag });
}

/**
 * Node requires these two hardened-runtime exceptions to execute V8. Dynamic
 * library validation is unrelated, however, and would permit an avoidable
 * code-loading class. Keep the entitlement file minimal and fail release
 * signing if it changes.
 */
export async function validateNodeRuntimeEntitlements(
  entitlementsPath = NODE_ENTITLEMENTS,
) {
  let source;
  try {
    source = await readFile(entitlementsPath, "utf8");
  } catch {
    fail("Node runtime entitlements are unavailable", "MACOS_NODE_ENTITLEMENTS_INVALID");
  }
  const entries = [...source.matchAll(
    /<key>([^<]+)<\/key>\s*<(true|false)\/>/gu,
  )].map((match) => [match[1], match[2]]);
  if (entries.length !== REQUIRED_NODE_RUNTIME_ENTITLEMENTS.length
      || entries.some(([key, value]) => value !== "true"
        || !REQUIRED_NODE_RUNTIME_ENTITLEMENTS.includes(key))
      || REQUIRED_NODE_RUNTIME_ENTITLEMENTS.some((key) =>
        !entries.some(([candidate]) => candidate === key))) {
    fail(
      "Node runtime entitlements include an unsupported capability",
      "MACOS_NODE_ENTITLEMENTS_INVALID",
    );
  }
  return Object.freeze({ path: resolve(entitlementsPath) });
}

function sanitize(text, secrets = []) {
  let selected = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      selected = selected.replaceAll(secret, "[redacted]");
    }
  }
  return selected;
}

export function runMacOSReleaseCommand(command, arguments_, {
  env = undefined,
  input = undefined,
  secrets = [],
  timeout = 120_000,
  failureMessage = `${basename(command)} failed`,
} = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    env,
    input,
    maxBuffer: 8 * 1024 * 1024,
    timeout,
  });
  if (result.error || result.status !== 0) {
    const detail = sanitize(
      result.error?.message || result.stderr || result.stdout || "",
      secrets,
    ).trim();
    fail(
      detail ? `${failureMessage}: ${detail}` : failureMessage,
      "MACOS_RELEASE_COMMAND_FAILED",
    );
  }
  return Object.freeze({
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  });
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function regularPath(path, { directory = false } = {}) {
  const metadata = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") {
      fail(`Required release input is missing: ${basename(path)}`);
    }
    throw error;
  });
  if (metadata.isSymbolicLink()
      || (directory ? !metadata.isDirectory() : !metadata.isFile())) {
    fail(`Release input has the wrong type: ${basename(path)}`);
  }
  return metadata;
}

function canonicalizeUnsignedArm64MachO(bytes, label) {
  if (bytes.length < 32
      || bytes.subarray(0, 4).toString("hex") !== "cffaedfe") {
    fail(
      `Expected a thin 64-bit Mach-O release payload: ${label}`,
      "MACOS_PAYLOAD_INTEGRITY_FAILED",
    );
  }
  const canonical = Buffer.from(bytes);
  const commandCount = canonical.readUInt32LE(16);
  const commandBytes = canonical.readUInt32LE(20);
  if (commandCount > 1_024
      || 32 + commandBytes > canonical.length) {
    fail(
      `Mach-O load commands are invalid: ${label}`,
      "MACOS_PAYLOAD_INTEGRITY_FAILED",
    );
  }
  let offset = 32;
  let linkEditFound = false;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > 32 + commandBytes) {
      fail(
        `Mach-O load commands are truncated: ${label}`,
        "MACOS_PAYLOAD_INTEGRITY_FAILED",
      );
    }
    const command = canonical.readUInt32LE(offset);
    const size = canonical.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > 32 + commandBytes) {
      fail(
        `Mach-O load command size is invalid: ${label}`,
        "MACOS_PAYLOAD_INTEGRITY_FAILED",
      );
    }
    if (command === 0x19 && size >= 72) {
      const segment = canonical.subarray(offset + 8, offset + 24)
        .toString("ascii")
        .replace(/\0.*$/u, "");
      if (segment === "__LINKEDIT") {
        if (linkEditFound) {
          fail(
            `Mach-O contains duplicate __LINKEDIT segments: ${label}`,
            "MACOS_PAYLOAD_INTEGRITY_FAILED",
          );
        }
        linkEditFound = true;
        canonical.writeBigUInt64LE(0n, offset + 32);
        canonical.writeBigUInt64LE(0n, offset + 48);
      }
    }
    offset += size;
  }
  if (!linkEditFound) {
    fail(
      `Mach-O has no __LINKEDIT segment: ${label}`,
      "MACOS_PAYLOAD_INTEGRITY_FAILED",
    );
  }
  return canonical;
}

async function normalizedMachOBytes(file) {
  const inspection = spawnSync("/usr/bin/codesign", ["-d", file], {
    encoding: "utf8",
    env: releaseEnvironment(),
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  if (inspection.error) {
    fail(
      `Mach-O signature inspection failed: ${inspection.error.message}`,
      "MACOS_PAYLOAD_INTEGRITY_FAILED",
    );
  }
  if (inspection.status !== 0) {
    fail(
      `Expected a signed Mach-O release payload: ${basename(file)}`,
      "MACOS_PAYLOAD_INTEGRITY_FAILED",
    );
  }

  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-macho-normalize-"),
  );
  const copy = join(temporaryRoot, basename(file));
  try {
    await copyFile(file, copy);
    await chmod(copy, 0o700);
    runMacOSReleaseCommand("/usr/bin/codesign", [
      "--remove-signature",
      copy,
    ], {
      env: releaseEnvironment(),
      failureMessage: "Mach-O signature normalization failed",
    });
    return canonicalizeUnsignedArm64MachO(
      await readFile(copy),
      basename(file),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function expectedSparkleLink(path) {
  const prefix = `${SPARKLE_FRAMEWORK_PREFIX}/`;
  if (!path.startsWith(prefix)) return null;
  return SPARKLE_FRAMEWORK_LINKS[path.slice(prefix.length)] ?? null;
}

async function walkMacOSPayload(root, current = root, {
  allowSparkleLinks = false,
  links = [],
} = {}) {
  const files = [];
  const directories = [];
  for (const entry of (await readdir(current, {
    withFileTypes: true,
  })).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name);
    const selected = relative(root, path).split(sep).join("/");
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      const target = await readlink(path);
      const expected = allowSparkleLinks
        ? expectedSparkleLink(selected)
        : null;
      if (target !== expected) {
        fail(
          `Application payload contains an unexpected symbolic link: ${selected}`,
          "MACOS_PAYLOAD_INTEGRITY_FAILED",
        );
      }
      const resolvedTarget = resolve(dirname(path), target);
      const selectedTarget = relative(root, resolvedTarget);
      if (selectedTarget === ".."
          || selectedTarget.startsWith(`..${sep}`)) {
        fail(
          `Application payload contains an escaping symbolic link: ${selected}`,
          "MACOS_PAYLOAD_INTEGRITY_FAILED",
        );
      }
      links.push(Object.freeze({ path: selected, target }));
      continue;
    }
    if (metadata.isDirectory()) {
      directories.push(selected);
      const nested = await walkMacOSPayload(root, path, {
        allowSparkleLinks,
        links,
      });
      directories.push(...nested.directories);
      files.push(...nested.files);
    } else if (metadata.isFile()) {
      files.push(selected);
    } else {
      fail(
        `Application payload contains an unsupported entry: ${selected}`,
        "MACOS_PAYLOAD_INTEGRITY_FAILED",
      );
    }
  }
  return { directories, files };
}

function validateManifestPayloadPath(path) {
  if (typeof path !== "string"
      || path.length === 0
      || path.startsWith("/")
      || path.includes("\\")
      || path.split("/").some((component) =>
        component === "" || component === "." || component === "..")
      || !path.startsWith("Contents/")) {
    fail(
      "Application build manifest contains an unsafe payload path",
      "MACOS_PAYLOAD_INTEGRITY_FAILED",
    );
  }
}

async function verifyMacOSBuildPayload(appPath, manifest) {
  const payload = manifest.payload;
  const updaterEnabled = manifest.release?.updater?.enabled === true;
  if (!payload
      || !Array.isArray(payload.files)
      || !Array.isArray(payload.links)
      || !Number.isSafeInteger(payload.totalBytes)
      || payload.totalBytes < 0
      || typeof payload.payloadSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(payload.payloadSha256)) {
    fail(
      "Application build manifest has an invalid payload inventory",
      "MACOS_PAYLOAD_INTEGRITY_FAILED",
    );
  }
  const expected = new Map();
  let previousPath = null;
  for (const entry of payload.files) {
    validateManifestPayloadPath(entry?.path);
    if (previousPath !== null
        && previousPath.localeCompare(entry.path) >= 0) {
      fail(
        "Application payload inventory is not strictly ordered",
        "MACOS_PAYLOAD_INTEGRITY_FAILED",
      );
    }
    previousPath = entry.path;
    const expectedNormalization = NORMALIZED_MACH_O_PATHS.has(entry.path)
      ? "mach_o_without_code_signature"
      : "raw";
    if (!Number.isSafeInteger(entry.bytes)
        || entry.bytes < 0
        || typeof entry.mode !== "string"
        || !/^[0-7]{3}$/u.test(entry.mode)
        || typeof entry.sha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(entry.sha256)
        || entry.normalization !== expectedNormalization
        || expected.has(entry.path)
        || [BUILD_MANIFEST_PATH, CODE_RESOURCES_PATH].includes(entry.path)) {
      fail(
        "Application build manifest contains an invalid payload entry",
        "MACOS_PAYLOAD_INTEGRITY_FAILED",
      );
    }
    expected.set(entry.path, entry);
  }
  const requiredMachOPaths = updaterEnabled
    ? [
      ...BASE_NORMALIZED_MACH_O_PATHS,
      ...SPARKLE_NORMALIZED_MACH_O_PATHS,
    ]
    : BASE_NORMALIZED_MACH_O_PATHS;
  for (const required of requiredMachOPaths) {
    if (!expected.has(required)) {
      fail(
        "Application payload inventory omits required signed code",
        "MACOS_PAYLOAD_INTEGRITY_FAILED",
      );
    }
  }

  const expectedLinks = updaterEnabled
    ? Object.entries(SPARKLE_FRAMEWORK_LINKS).map(([path, target]) => ({
      path: `${SPARKLE_FRAMEWORK_PREFIX}/${path}`,
      target,
    })).sort((left, right) => left.path.localeCompare(right.path))
    : [];
  const manifestLinks = payload.links.map((link) => ({
    path: link?.path,
    target: link?.target,
  }));
  if (JSON.stringify(manifestLinks) !== JSON.stringify(expectedLinks)) {
    fail(
      "Application payload has an invalid framework link inventory",
      "MACOS_PAYLOAD_INTEGRITY_FAILED",
    );
  }
  const observedLinks = [];
  const observed = await walkMacOSPayload(appPath, appPath, {
    allowSparkleLinks: updaterEnabled,
    links: observedLinks,
  });
  observedLinks.sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(observedLinks) !== JSON.stringify(expectedLinks)) {
    fail(
      "Application framework links do not match their complete inventory",
      "MACOS_PAYLOAD_INTEGRITY_FAILED",
    );
  }
  const allowedFiles = new Set([
    ...expected.keys(),
    BUILD_MANIFEST_PATH,
  ]);
  // `xcrun stapler staple` writes Apple's notarization ticket into the bundle
  // after signing, so it is absent before notarization and present after.
  // Accept it whenever it appears without ever requiring it: its authenticity
  // is proven separately by `stapler validate`, which the release and install
  // validations both run.
  const inventoriedFiles = observed.files
    .filter((path) => path !== APPLE_STAPLED_TICKET_PATH
      && path !== EMBEDDED_PROFILE_PATH
      && !path.split("/").includes("_CodeSignature"));
  if (inventoriedFiles.length !== allowedFiles.size
      || inventoriedFiles.some((path) => !allowedFiles.has(path))) {
    fail(
      "Application payload does not match its complete file inventory",
      "MACOS_PAYLOAD_INTEGRITY_FAILED",
    );
  }
  for (const required of allowedFiles) {
    if (!inventoriedFiles.includes(required)) {
      fail(
        "Application payload is missing an inventoried file",
        "MACOS_PAYLOAD_INTEGRITY_FAILED",
      );
    }
  }
  for (const directory of observed.directories) {
    // Signature directories hold no inventoried payload by design.
    if (directory.split("/").includes("_CodeSignature")) continue;
    if (![...allowedFiles].some((path) =>
      path.startsWith(`${directory}/`))
        && !observed.files.some((path) => path.startsWith(`${directory}/`))) {
      fail(
        "Application payload contains an unexpected empty directory",
        "MACOS_PAYLOAD_INTEGRITY_FAILED",
      );
    }
  }

  const aggregate = createHash("sha256");
  let totalBytes = 0;
  for (const entry of payload.files) {
    const path = join(appPath, ...entry.path.split("/"));
    const metadata = await regularPath(path);
    const actualMode = (metadata.mode & 0o777)
      .toString(8)
      .padStart(3, "0");
    if (actualMode !== entry.mode) {
      fail(
        `Application payload mode changed: ${entry.path}`,
        "MACOS_PAYLOAD_INTEGRITY_FAILED",
      );
    }
    const bytes = entry.normalization ===
        "mach_o_without_code_signature"
      ? await normalizedMachOBytes(path)
      : await readFile(path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== entry.bytes || digest !== entry.sha256) {
      fail(
        `Application payload content changed: ${entry.path}`,
        "MACOS_PAYLOAD_INTEGRITY_FAILED",
      );
    }
    totalBytes += bytes.length;
    aggregate.update(entry.path);
    aggregate.update("\0");
    aggregate.update(bytes);
    aggregate.update("\0");
  }
  for (const link of observedLinks) {
    aggregate.update(link.path);
    aggregate.update("\0link\0");
    aggregate.update(link.target);
    aggregate.update("\0");
  }
  if (totalBytes !== payload.totalBytes
      || aggregate.digest("hex") !== payload.payloadSha256) {
    fail(
      "Application payload aggregate does not match its build manifest",
      "MACOS_PAYLOAD_INTEGRITY_FAILED",
    );
  }
}

function parsePlist(path) {
  const result = runMacOSReleaseCommand("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    path,
  ], {
    failureMessage: "Info.plist validation failed",
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("Info.plist did not decode as a property list");
  }
}

function validateProductionOrigin(plist, {
  expectedMode = "production_https",
  channel = "stable",
} = {}) {
  if (plist.UsageMonitorCentralOriginMode !== expectedMode
      || typeof plist.UsageMonitorCentralOrigin !== "string") {
    fail(
      channel === "stable"
        ? "Release app is not sealed to a production HTTPS service"
        : `Release app is not sealed to the reviewed ${channel} HTTPS service`,
      channel === "stable"
        ? "MACOS_PRODUCTION_ORIGIN_REQUIRED"
        : "MACOS_RELEASE_CHANNEL_MISMATCH",
    );
  }
  let origin;
  try {
    origin = new URL(plist.UsageMonitorCentralOrigin);
  } catch {
    fail("Release app contains an invalid central origin");
  }
  if (origin.protocol !== "https:"
      || ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
      || origin.username
      || origin.password
      || origin.pathname !== "/"
      || origin.search
      || origin.hash
      || origin.origin !== plist.UsageMonitorCentralOrigin) {
    fail("Release app contains a non-production central origin");
  }
  return origin.origin;
}

function hasAppOpenScheme(plist) {
  return Array.isArray(plist.CFBundleURLTypes)
    && plist.CFBundleURLTypes.some((entry) =>
      entry?.CFBundleURLName
        === `${BUNDLE_IDENTIFIER}.${PRODUCT_BRAND.appOpenHost}`
      && Array.isArray(entry?.CFBundleURLSchemes)
      && entry.CFBundleURLSchemes.includes(APP_OPEN_SCHEME));
}

function hasExpectedProductBrand(plist) {
  return plist.CFBundleDisplayName === PRODUCT_BRAND.displayName
    && plist.CFBundleName === PRODUCT_BRAND.displayName
    && plist.UsageMonitorAppOpenHost === PRODUCT_BRAND.appOpenHost
    && plist.UsageMonitorAppOpenScheme === PRODUCT_BRAND.appOpenScheme
    && plist.UsageMonitorAppOpenURL === PRODUCT_BRAND.appOpenURL
    && plist.UsageMonitorBundleName === PRODUCT_BRAND.bundleName
    && plist.UsageMonitorStateDirectoryName
      === PRODUCT_BRAND.stateDirectoryName
    && plist.UsageMonitorMonitoredAppDisplayName
      === PRODUCT_BRAND.monitoredAppDisplayName
    && plist.UsageMonitorMonitoredAppBundleIdentifier
      === PRODUCT_BRAND.monitoredAppBundleIdentifier;
}

async function validateUpdaterBoundary(appPath, plist, manifest, {
  required,
}) {
  const updater = manifest.release?.updater;
  const frameworkPath = join(
    appPath,
    ...SPARKLE_FRAMEWORK_PREFIX.split("/"),
  );
  if (!required) {
    if (plist.UsageMonitorUpdaterEnabled !== false
        || updater?.enabled !== false
        || updater?.automaticChecks !== false
        || updater?.automaticUpdateOptInAvailable !== false
        || updater?.automaticUpdatesEnabledByDefault !== false
        || updater?.afterUserOptIn?.automaticDownload !== false
        || updater?.afterUserOptIn?.installOnQuit !== false) {
      fail(
        "Development application has an invalid updater boundary",
        "MACOS_UPDATER_FORBIDDEN_IN_DEVELOPMENT",
      );
    }
    try {
      await lstat(frameworkPath);
      fail(
        "Development application unexpectedly contains Sparkle.framework",
        "MACOS_UPDATER_FORBIDDEN_IN_DEVELOPMENT",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return;
  }
  if (plist.UsageMonitorUpdaterEnabled !== true
      || plist.UsageMonitorUpdaterFrameworkVersion !== SPARKLE_VERSION
      || plist.SUEnableAutomaticChecks !== true
      || plist.SUAllowsAutomaticUpdates !== true
      || plist.SUAutomaticallyUpdate !== true
      || plist.SURequireSignedFeed !== true
      || plist.SUVerifyUpdateBeforeExtraction !== true
      || typeof plist.SUFeedURL !== "string"
      || typeof plist.SUPublicEDKey !== "string"
      || updater?.enabled !== true
      || updater?.automaticChecks !== true
      || updater?.automaticUpdateOptInAvailable !== true
      || updater?.automaticUpdatesEnabledByDefault !== true
      || updater?.afterUserOptIn?.automaticDownload !== true
      || updater?.afterUserOptIn?.installOnQuit !== true
      || updater?.requiresSignedFeed !== true
      || updater?.verifyBeforeExtraction !== true
      || updater?.frameworkVersion !== SPARKLE_VERSION
      || updater?.frameworkSha256 !== SPARKLE_FRAMEWORK_SHA256
      || updater?.appcastURL !== plist.SUFeedURL
      || updater?.publicEdKeySha256 !== createHash("sha256")
        .update(Buffer.from(plist.SUPublicEDKey, "base64"))
        .digest("hex")) {
    fail(
      "Release application has an incomplete signed-updater boundary",
      "MACOS_UPDATER_CONFIGURATION_INVALID",
    );
  }
  const appcast = new URL(plist.SUFeedURL);
  if (appcast.protocol !== "https:"
      || appcast.username || appcast.password
      || appcast.search || appcast.hash
      || ["localhost", "127.0.0.1", "[::1]"].includes(appcast.hostname)
      || appcast.pathname === "/"
      || appcast.href !== plist.SUFeedURL
      || !/^[A-Za-z0-9+/]{43}=$/u.test(plist.SUPublicEDKey)
      || Buffer.from(plist.SUPublicEDKey, "base64").length !== 32) {
    fail(
      "Release application has unsafe updater metadata",
      "MACOS_UPDATER_CONFIGURATION_INVALID",
    );
  }
  await regularPath(frameworkPath, { directory: true });
  for (const relativePath of SPARKLE_MACH_O_PATHS) {
    await regularPath(join(
      frameworkPath,
      ...relativePath.split("/"),
    ));
  }
  await regularPath(join(
    appPath,
    "Contents",
    "Resources",
    "licenses",
    `sparkle-${SPARKLE_VERSION}.txt`,
  ));
}

export async function inspectMacOSApp(appPath, {
  channel = "stable",
  requireExternalDistribution = false,
} = {}) {
  const selected = resolve(appPath);
  if (basename(selected) !== APP_NAME) {
    fail(`Application bundle must be named ${APP_NAME}`);
  }
  await regularPath(selected, { directory: true });
  const manifestPath = join(
    selected,
    ...BUILD_MANIFEST_PATH.split("/"),
  );
  await regularPath(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    fail("Application build manifest is invalid");
  }
  if (manifest.schemaVersion !== BUILD_MANIFEST_SCHEMA
      || manifest.application?.bundleIdentifier !== BUNDLE_IDENTIFIER) {
    fail("Application build manifest has an unexpected identity");
  }
  await verifyMacOSBuildPayload(selected, manifest);
  const plistPath = join(selected, "Contents", "Info.plist");
  await regularPath(plistPath);
  const plist = parsePlist(plistPath);
  if (plist.CFBundleIdentifier !== BUNDLE_IDENTIFIER
      || plist.CFBundleExecutable !== PRODUCT_BRAND.executableName
      || !hasAppOpenScheme(plist)
      || !hasExpectedProductBrand(plist)) {
    fail("Application bundle metadata is incomplete");
  }
  await validateUpdaterBoundary(selected, plist, manifest, {
    required: requireExternalDistribution,
  });
  for (const relativePath of [
    APP_EXECUTABLE,
    NODE_EXECUTABLE,
    KEYTAR_EXECUTABLE,
  ]) {
    await regularPath(join(selected, ...relativePath.split("/")));
  }
  if (requireExternalDistribution) {
    const releaseChannel = resolveOperationalReleaseChannel(channel);
    const centralOrigin = validateProductionOrigin(plist, {
      channel: releaseChannel.name,
      expectedMode: releaseChannel.serviceOriginMode,
    });
    if (centralOrigin !== releaseChannel.serviceOrigin
        || plist.UsageMonitorPublicWebsiteOrigin
          !== releaseChannel.publicWebsiteOrigin
        || plist.SUFeedURL !== releaseChannel.sparkle.appcastURL) {
      fail(
        `Release app is not sealed to the reviewed ${releaseChannel.name} deployment endpoints`,
        "MACOS_RELEASE_ENDPOINTS_MISMATCH",
      );
    }
    if (manifest.release?.channel !== undefined
        && manifest.release.channel
          !== releaseChannel.buildManifestChannel) {
      fail(
        `Release app build manifest is not marked for channel ${releaseChannel.name}`,
        "MACOS_RELEASE_CHANNEL_MISMATCH",
      );
    }
    if (plist.UsageMonitorReleaseChannel !== releaseChannel.name
        || manifest.release?.channelName !== releaseChannel.name) {
      fail(
        `Release app does not expose the named ${releaseChannel.name} channel identity`,
        "MACOS_RELEASE_CHANNEL_MISMATCH",
      );
    }
    if (manifest.release?.externalDistributionRequested !== true
        || manifest.release?.productionOriginValidated !== true
        || manifest.release?.requiresDeveloperIDAndNotarization !== true
        || manifest.release?.appOpenScheme !== APP_OPEN_SCHEME
        || manifest.release?.appOpenHost !== PRODUCT_BRAND.appOpenHost
        || manifest.release?.appOpenURL !== PRODUCT_BRAND.appOpenURL
        || manifest.release?.iconIncluded !== true
        || typeof manifest.release?.iconSha256 !== "string"
        || typeof manifest.release?.provenanceSha256 !== "string") {
      fail(
        "Application was not built through the external-distribution gate",
        "MACOS_EXTERNAL_DISTRIBUTION_BUILD_REQUIRED",
      );
    }
    if (plist.CFBundleIconFile !== "AppIcon") {
      fail("Release application has no approved icon wiring");
    }
    const iconPath = join(
      selected,
      "Contents",
      "Resources",
      "AppIcon.icns",
    );
    const provenancePath = join(
      selected,
      "Contents",
      "Resources",
      "licenses",
      "app-icon-provenance.txt",
    );
    await regularPath(iconPath);
    await regularPath(provenancePath);
    if (await sha256File(iconPath) !== manifest.release.iconSha256
        || await sha256File(provenancePath)
          !== manifest.release.provenanceSha256) {
      fail("Release icon or provenance does not match its build manifest");
    }
  }
  return Object.freeze({
    appPath: selected,
    buildManifest: manifest,
    bundleIdentifier: plist.CFBundleIdentifier,
    bundleVersion: plist.CFBundleVersion,
    executablePath: join(selected, ...APP_EXECUTABLE.split("/")),
    plist,
    shortVersion: plist.CFBundleShortVersionString,
  });
}

export function readMacOSReleaseCredentials(environment = process.env) {
  const identity = environment.USAGE_MONITOR_DEVELOPER_ID_APPLICATION;
  const notaryProfile = environment.USAGE_MONITOR_NOTARY_PROFILE;
  if (typeof identity !== "string"
      || !/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/u.test(identity)) {
    fail(
      "USAGE_MONITOR_DEVELOPER_ID_APPLICATION must name an exact Developer ID Application identity",
      "MACOS_DEVELOPER_ID_REQUIRED",
    );
  }
  if (typeof notaryProfile !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(notaryProfile)) {
    fail(
      "USAGE_MONITOR_NOTARY_PROFILE must name a notarytool Keychain profile",
      "MACOS_NOTARY_PROFILE_REQUIRED",
    );
  }
  return Object.freeze({ identity, notaryProfile });
}

export function readMacOSReleaseBuildConfiguration(
  environment = process.env,
  channel = "stable",
) {
  const releaseChannel = resolveOperationalReleaseChannel(channel);
  const endpointSourceLabel = releaseChannel.name === "stable"
    ? "config/deployment-endpoints.js"
    : `the reviewed ${releaseChannel.name} channel`;
  const configuredProductionOrigin =
    environment.USAGE_MONITOR_PRODUCTION_ORIGIN;
  const bundleVersion = environment.USAGE_MONITOR_BUNDLE_VERSION;
  const sparkleFramework =
    environment.USAGE_MONITOR_SPARKLE_FRAMEWORK;
  const configuredSparkleAppcastURL =
    environment.USAGE_MONITOR_SPARKLE_APPCAST_URL;
  const sparklePublicEdKey =
    environment.USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY;
  const productionOrigin = releaseChannel.name === STABLE_RELEASE_CHANNEL
    ? DEPLOYMENT_ENDPOINTS.public.origin
    : releaseChannel.serviceOrigin;
  const sparkleAppcastURL = releaseChannel.name === STABLE_RELEASE_CHANNEL
    ? DEPLOYMENT_ENDPOINTS.sparkle.appcastURL
    : releaseChannel.sparkle.appcastURL;
  if (configuredProductionOrigin !== undefined) {
    if (typeof configuredProductionOrigin !== "string") {
      fail(
        "USAGE_MONITOR_PRODUCTION_ORIGIN must name the exact reviewed HTTPS origin",
        "MACOS_PRODUCTION_ORIGIN_REQUIRED",
      );
    }
    const normalizedConfiguredOrigin = validateProductionOrigin({
      UsageMonitorCentralOrigin: configuredProductionOrigin,
      UsageMonitorCentralOriginMode: releaseChannel.serviceOriginMode,
    }, {
      channel: releaseChannel.name,
      expectedMode: releaseChannel.serviceOriginMode,
    });
    if (normalizedConfiguredOrigin !== productionOrigin) {
      fail(
        `USAGE_MONITOR_PRODUCTION_ORIGIN must match ${endpointSourceLabel}`,
        "MACOS_RELEASE_ENDPOINTS_MISMATCH",
      );
    }
  }
  const normalizedOrigin = validateProductionOrigin({
    UsageMonitorCentralOrigin: productionOrigin,
    UsageMonitorCentralOriginMode: releaseChannel.serviceOriginMode,
  }, {
    channel: releaseChannel.name,
    expectedMode: releaseChannel.serviceOriginMode,
  });
  if (configuredSparkleAppcastURL !== undefined
      && configuredSparkleAppcastURL !== sparkleAppcastURL) {
    fail(
      `USAGE_MONITOR_SPARKLE_APPCAST_URL must match ${endpointSourceLabel}`,
      "MACOS_RELEASE_ENDPOINTS_MISMATCH",
    );
  }
  if (typeof bundleVersion !== "string"
      || !/^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,2}$/u
        .test(bundleVersion)) {
    fail(
      "USAGE_MONITOR_BUNDLE_VERSION must contain one to three non-negative decimal components",
      "MACOS_BUNDLE_VERSION_REQUIRED",
    );
  }
  const provisioningProfile = environment.USAGE_MONITOR_PROVISIONING_PROFILE;
  if (provisioningProfile !== undefined
      && (typeof provisioningProfile !== "string"
        || provisioningProfile.length === 0
        || provisioningProfile.includes("\0"))) {
    fail(
      "USAGE_MONITOR_PROVISIONING_PROFILE must name a readable provisioning profile",
      "MACOS_PROVISIONING_PROFILE_INVALID",
    );
  }
  if (typeof sparkleFramework !== "string"
      || sparkleFramework.length === 0
      || sparkleFramework.includes("\0")
      || typeof sparklePublicEdKey !== "string"
      || sparklePublicEdKey.length === 0) {
    fail(
      "Release updater framework and public Ed25519 key are required",
      "MACOS_UPDATER_REQUIRED_FOR_DISTRIBUTION",
    );
  }
  const publicKeyBytes = Buffer.from(sparklePublicEdKey, "base64");
  const publicKeySha256 = createHash("sha256")
    .update(publicKeyBytes)
    .digest("hex");
  if (releaseChannel.sparkle.publicEdKeySha256 !== null
      && releaseChannel.sparkle.publicEdKeySha256 !== publicKeySha256) {
    fail(
      `USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY does not match the reviewed ${releaseChannel.name} channel key`,
      "MACOS_RELEASE_CHANNEL_MISMATCH",
    );
  }
  return Object.freeze({
    bundleVersion,
    productionOrigin: normalizedOrigin,
    provisioningProfile: provisioningProfile
      ? resolve(provisioningProfile)
      : null,
    sparkleAppcastURL,
    sparkleFramework: resolve(sparkleFramework),
    sparklePublicEdKey,
  });
}

function macOSBundleVersionParts(value) {
  if (typeof value !== "string"
      || !/^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,2}$/u
        .test(value)) {
    fail(
      "Replacement contract contains an invalid bundle version",
      "MACOS_REPLACEMENT_VERSION_INVALID",
    );
  }
  return value.split(".").map(Number).concat([0, 0]).slice(0, 3);
}

export function compareMacOSBundleVersions(left, right) {
  const leftParts = macOSBundleVersionParts(left);
  const rightParts = macOSBundleVersionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

export function createMacOSSignedReplacementContract() {
  return Object.freeze({
    schemaVersion: REPLACEMENT_CONTRACT_SCHEMA,
    delivery: "sparkle_signed_appcast_with_manual_dmg_fallback",
    updateChecksPerformedByApp: true,
    manualUpdateCheckAvailable: true,
    automaticUpdateOptInAvailable: true,
    automaticUpdatesEnabledByDefault: true,
    afterUserOptIn: Object.freeze({
      automaticDownload: true,
      installOnQuit: true,
    }),
    installProcedure:
      "sparkle_automatic_install_on_quit_or_manual_dmg_replacement",
    downloadPolicy: "pinned_https_appcast_and_eddsa_signed_artifact",
    state: Object.freeze({
      root:
        `~/Library/Application Support/${PRODUCT_BRAND.stateDirectoryName}`,
      retainedAcrossReplacement: true,
      destructiveMigrationAllowed: false,
      preReplacementBackupRequiredForSchemaChanges: true,
    }),
    keychainRetainedAcrossReplacement: true,
    hostedDataChangedByReplacement: false,
    rollback: Object.freeze({
      mode: "manual_previous_signed_notarized_dmg",
      previousReleaseManifestRequired: true,
      previousArtifactChecksumRequired: true,
      existingStateRehearsalRequired: true,
      restorePreReplacementStateIfIncompatible: true,
    }),
  });
}

function validateSignedReleaseChannel(manifest, label) {
  const channel = manifest?.channel;
  if (channel === null || typeof channel !== "object"
      || Array.isArray(channel)
      || typeof channel.name !== "string") {
    fail(
      `${label} is missing required named channel provenance`,
      "MACOS_RELEASE_CHANNEL_PROVENANCE_REQUIRED",
    );
  }
  let channelName;
  try {
    channelName = assertReleaseChannelPublication(channel.name, channel).name;
  } catch {
    fail(
      `${label} has channel provenance that does not match its named policy`,
      "MACOS_RELEASE_CHANNEL_MISMATCH",
    );
  }
  // Stable has no configured static key; the sealed manifest is authoritative.
  if (channel.sparkle.publicEdKeySha256
      !== manifest.updater.publicEdKeySha256) {
    fail(
      `${label} channel provenance does not match its updater public-key fingerprint`,
      "MACOS_RELEASE_UPDATER_KEY_MISMATCH",
    );
  }
  return channelName;
}

function validateSignedReleaseManifest(manifest, label) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
      || manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA
      || manifest.application?.bundleIdentifier !== BUNDLE_IDENTIFIER
      || typeof manifest.application?.bundleVersion !== "string"
      || typeof manifest.application?.shortVersion !== "string"
      || !Number.isSafeInteger(manifest.artifact?.bytes)
      || manifest.artifact.bytes < 1
      || typeof manifest.artifact?.fileName !== "string"
      || manifest.artifact.fileName.startsWith(".")
      || basename(manifest.artifact.fileName) !== manifest.artifact.fileName
      || !manifest.artifact.fileName.endsWith(".dmg")
      || typeof manifest.artifact?.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(manifest.artifact.sha256)
      || typeof manifest.source?.commit !== "string"
      || !/^[0-9a-f]{40,64}$/u.test(manifest.source.commit)
      || typeof manifest.source?.tag !== "string"
      || !/^[0-9A-Za-z][0-9A-Za-z._/-]{0,127}$/u.test(manifest.source.tag)
      || manifest.source.tag.includes("..")
      || manifest.source.tag.startsWith("/")
      || manifest.source.tag.endsWith("/")
      || REQUIRED_SIGNED_RELEASE_ASSURANCES.some(
        (key) => manifest.assurances?.[key] !== true,
      )
      || manifest.updater?.enabled !== true
      || manifest.updater?.frameworkVersion !== SPARKLE_VERSION
      || manifest.updater?.automaticChecks !== true
      || manifest.updater?.automaticUpdateOptInAvailable !== true
      || manifest.updater?.automaticUpdatesEnabledByDefault !== true
      || manifest.updater?.afterUserOptIn?.automaticDownload !== true
      || manifest.updater?.afterUserOptIn?.installOnQuit !== true
      || manifest.updater?.requiresSignedFeed !== true
      || typeof manifest.updater?.appcastURL !== "string"
      || !manifest.updater.appcastURL.startsWith("https://")
      || typeof manifest.updater?.publicEdKeySha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(manifest.updater.publicEdKeySha256)
      || stableJson(manifest.replacement)
        !== stableJson(createMacOSSignedReplacementContract())) {
    fail(
      `${label} is not a complete signed replacement release manifest`,
      "MACOS_REPLACEMENT_MANIFEST_INVALID",
    );
  }
  if (manifest.channel !== undefined) {
    validateSignedReleaseChannel(manifest, label);
  }
  macOSBundleVersionParts(manifest.application.bundleVersion);
  return manifest;
}

/**
 * Read the explicit previous stable manifest used by the Sparkle key
 * continuity gate. This is intentionally separate from replacement artifact
 * loading: continuity requires the reviewed manifest, but does not need to
 * touch the previous DMG or any signing material.
 */
export async function readStableReleaseManifest(manifestPath) {
  if (typeof manifestPath !== "string"
      || manifestPath.length === 0
      || manifestPath.includes("\0")) {
    fail(
      "An explicit previous stable release manifest is required",
      "MACOS_STABLE_PREVIOUS_MANIFEST_REQUIRED",
    );
  }
  const selected = resolve(manifestPath);
  let metadata;
  try {
    metadata = await lstat(selected);
  } catch {
    fail(
      "The previous stable release manifest is unavailable",
      "MACOS_STABLE_PREVIOUS_MANIFEST_INVALID",
    );
  }
  if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.size < 1
      || metadata.size > STABLE_RELEASE_MANIFEST_MAX_BYTES) {
    fail(
      "The previous stable release manifest is invalid",
      "MACOS_STABLE_PREVIOUS_MANIFEST_INVALID",
    );
  }
  let bytes;
  try {
    bytes = await readFile(selected);
  } catch {
    fail(
      "The previous stable release manifest is unreadable",
      "MACOS_STABLE_PREVIOUS_MANIFEST_INVALID",
    );
  }
  if (bytes.length !== metadata.size) {
    fail(
      "The previous stable release manifest changed while it was being read",
      "MACOS_STABLE_PREVIOUS_MANIFEST_INVALID",
    );
  }
  try {
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error("not an object");
    }
    return manifest;
  } catch {
    fail(
      "The previous stable release manifest is not valid JSON",
      "MACOS_STABLE_PREVIOUS_MANIFEST_INVALID",
    );
  }
}

/**
 * Stable has no statically configured Sparkle key, so every non-bootstrap
 * release must carry an explicit, structurally valid prior stable manifest.
 * Missing prior state never silently turns into bootstrap mode.
 */
export function assertStableSparkleKeyContinuity({
  channel,
  candidateBundleVersion,
  candidatePublicEdKeySha256,
  previousManifest = null,
  stableBootstrap = false,
} = {}) {
  if (typeof stableBootstrap !== "boolean") {
    fail(
      "Stable Sparkle bootstrap mode must be an explicit boolean",
      "MACOS_STABLE_BOOTSTRAP_INVALID",
    );
  }
  if (channel !== STABLE_RELEASE_CHANNEL) {
    if (stableBootstrap || previousManifest !== null) {
      fail(
        "Stable Sparkle continuity options are only valid for the stable channel",
        "MACOS_STABLE_CONTINUITY_CHANNEL_INVALID",
      );
    }
    return Object.freeze({ mode: "not_required" });
  }
  if (typeof candidateBundleVersion !== "string"
      || !/^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,2}$/u
        .test(candidateBundleVersion)
      || typeof candidatePublicEdKeySha256 !== "string"
      || !PUBLIC_KEY_FINGERPRINT_PATTERN.test(candidatePublicEdKeySha256)) {
    fail(
      "Stable Sparkle continuity candidate metadata is invalid",
      "MACOS_STABLE_CONTINUITY_CANDIDATE_INVALID",
    );
  }
  if (stableBootstrap) {
    if (previousManifest !== null) {
      fail(
        "Stable bootstrap cannot be combined with a previous stable manifest",
        "MACOS_STABLE_BOOTSTRAP_INVALID",
      );
    }
    return Object.freeze({
      bootstrap: STABLE_SPARKLE_BOOTSTRAP_MODE,
      mode: "bootstrap",
      policy: STABLE_SPARKLE_KEY_CONTINUITY_MODE,
    });
  }
  if (previousManifest === null
      || previousManifest === undefined) {
    fail(
      "A previous stable release manifest is required; use explicit bootstrap only for the first publication",
      "MACOS_STABLE_PREVIOUS_MANIFEST_REQUIRED",
    );
  }

  let previous;
  try {
    previous = validateSignedReleaseManifest(
      previousManifest,
      "Previous stable release",
    );
    const previousChannel = validateSignedReleaseChannel(
      previous,
      "Previous stable release",
    );
    if (previousChannel !== STABLE_RELEASE_CHANNEL) {
      throw new Error("not stable");
    }
  } catch {
    fail(
      "The previous stable release manifest is malformed or not a stable release",
      "MACOS_STABLE_PREVIOUS_MANIFEST_INVALID",
    );
  }
  if (compareMacOSBundleVersions(
    candidateBundleVersion,
    previous.application.bundleVersion,
  ) <= 0) {
    fail(
      "Stable candidate bundle version must be newer than the previous stable release",
      "MACOS_STABLE_VERSION_NOT_NEWER",
    );
  }
  if (candidatePublicEdKeySha256
      !== previous.updater.publicEdKeySha256) {
    fail(
      "Stable Sparkle public-key continuity does not match the previous stable release",
      "MACOS_STABLE_UPDATER_KEY_MISMATCH",
    );
  }
  return Object.freeze({
    mode: "previous_manifest",
    previousBundleVersion: previous.application.bundleVersion,
    policy: STABLE_SPARKLE_KEY_CONTINUITY_MODE,
  });
}

export function validateMacOSSignedReplacementPair({
  previousManifest,
  candidateManifest,
} = {}) {
  const previous = validateSignedReleaseManifest(
    previousManifest,
    "Previous release",
  );
  const candidate = validateSignedReleaseManifest(
    candidateManifest,
    "Candidate release",
  );
  const previousChannelName = validateSignedReleaseChannel(
    previous,
    "Previous release",
  );
  const candidateChannelName = validateSignedReleaseChannel(
    candidate,
    "Candidate release",
  );
  if (candidateChannelName !== previousChannelName) {
    fail(
      "Replacement and rollback manifests must use the same named release channel",
      "MACOS_RELEASE_CHANNEL_MISMATCH",
    );
  }
  if (candidate.updater.publicEdKeySha256
        !== previous.updater.publicEdKeySha256) {
    fail(
      "Replacement and rollback manifests must use the same Sparkle public key",
      "MACOS_REPLACEMENT_UPDATER_KEY_MISMATCH",
    );
  }
  if (candidate.application.bundleIdentifier
        !== previous.application.bundleIdentifier) {
    fail(
      "Replacement bundle identifiers do not match",
      "MACOS_REPLACEMENT_BUNDLE_MISMATCH",
    );
  }
  if (compareMacOSBundleVersions(
    candidate.application.bundleVersion,
    previous.application.bundleVersion,
  ) <= 0) {
    fail(
      "Candidate bundle version must be newer than the rollback release",
      "MACOS_REPLACEMENT_VERSION_NOT_NEWER",
    );
  }
  if (candidate.artifact.sha256 === previous.artifact.sha256) {
    fail(
      "Replacement and rollback artifacts must be distinct",
      "MACOS_REPLACEMENT_ARTIFACT_CONFLICT",
    );
  }
  return Object.freeze({
    bundleIdentifier: candidate.application.bundleIdentifier,
    candidateBundleVersion: candidate.application.bundleVersion,
    previousBundleVersion: previous.application.bundleVersion,
    updateMode: "sparkle_signed_appcast_with_manual_dmg_fallback",
    rollbackMode: "manual_previous_signed_notarized_dmg",
    automaticUpdaterPresent: true,
    hostedDataChanged: false,
  });
}

async function readReplacementReleaseArtifact(
  manifestPath,
  label,
) {
  const selectedManifest = resolve(manifestPath);
  await regularPath(selectedManifest);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(selectedManifest, "utf8"));
  } catch {
    fail(
      `${label} release manifest is unreadable`,
      "MACOS_REPLACEMENT_MANIFEST_INVALID",
    );
  }
  validateSignedReleaseManifest(manifest, label);
  const artifact = join(dirname(selectedManifest), manifest.artifact.fileName);
  const metadata = await regularPath(artifact);
  if (metadata.size !== manifest.artifact.bytes
      || await sha256File(artifact) !== manifest.artifact.sha256) {
    fail(
      `${label} artifact does not match its release manifest`,
      "MACOS_REPLACEMENT_ARTIFACT_INVALID",
    );
  }
  return Object.freeze({ artifact, manifest });
}

/**
 * Validate one exact public release artifact through the same manifest and
 * platform gates used by signed replacement releases. Public-site packaging
 * needs a single candidate, not a previous/candidate replacement pair, so
 * keep the established single-manifest reader private and expose only this
 * narrow, artifact-bound operation.
 */
export async function validateMacOSSignedReleaseArtifact({
  releaseManifestPath,
  artifactPath = null,
  validateArtifact = validateMacOSDMG,
} = {}) {
  if (typeof releaseManifestPath !== "string"
      || (artifactPath !== null && typeof artifactPath !== "string")
      || typeof validateArtifact !== "function") {
    fail(
      "A macOS release manifest and artifact validator are required",
      "MACOS_RELEASE_EVIDENCE_INVALID",
    );
  }
  const candidate = await readReplacementReleaseArtifact(
    releaseManifestPath,
    "Public installer",
  );
  if (artifactPath !== null && resolve(artifactPath) !== candidate.artifact) {
    fail(
      "Public installer path does not match the release manifest artifact",
      "MACOS_RELEASE_ARTIFACT_PATH_MISMATCH",
    );
  }
  await validateArtifact(candidate.artifact, { production: true });
  return Object.freeze({
    artifact: Object.freeze({
      path: candidate.artifact,
      bytes: candidate.manifest.artifact.bytes,
      sha256: candidate.manifest.artifact.sha256,
    }),
    manifest: candidate.manifest,
  });
}

export async function validateMacOSSignedReplacementArtifacts({
  previousReleaseManifestPath,
  candidateReleaseManifestPath,
  validateArtifact = validateMacOSDMG,
} = {}) {
  if (typeof previousReleaseManifestPath !== "string"
      || typeof candidateReleaseManifestPath !== "string"
      || typeof validateArtifact !== "function") {
    fail(
      "Previous and candidate release manifests are required",
      "MACOS_REPLACEMENT_MANIFEST_INVALID",
    );
  }
  const previous = await readReplacementReleaseArtifact(
    previousReleaseManifestPath,
    "Previous release",
  );
  const candidate = await readReplacementReleaseArtifact(
    candidateReleaseManifestPath,
    "Candidate release",
  );
  const contract = validateMacOSSignedReplacementPair({
    previousManifest: previous.manifest,
    candidateManifest: candidate.manifest,
  });
  await validateArtifact(previous.artifact, { production: true });
  await validateArtifact(candidate.artifact, { production: true });
  return Object.freeze({
    ...contract,
    previousArtifact: previous.artifact,
    candidateArtifact: candidate.artifact,
  });
}

function releaseEnvironment() {
  const environment = {
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SOURCE_DATE_EPOCH: String(FIXED_EPOCH_SECONDS),
    ZERO_AR_DATE: "1",
  };
  if (process.env.TMPDIR) environment.TMPDIR = process.env.TMPDIR;
  return environment;
}

export async function developerIDSignMacOSApp(appPath, {
  identity,
  commandRunner = runMacOSReleaseCommand,
} = {}) {
  if (typeof identity !== "string" || identity.length === 0) {
    fail("Developer ID identity is required", "MACOS_DEVELOPER_ID_REQUIRED");
  }
  const inspected = await inspectMacOSApp(appPath, {
    requireExternalDistribution: true,
  });
  const secrets = [identity];
  commandRunner("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    inspected.appPath,
  ], {
    env: releaseEnvironment(),
    failureMessage: "Release candidate build signature verification failed",
    secrets,
  });
  const identityProbe = commandRunner("/usr/bin/security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
  ], {
    env: releaseEnvironment(),
    failureMessage: "Code-signing identity lookup failed",
    secrets,
  });
  if (!identityProbe.stdout.includes(`"${identity}"`)) {
    fail(
      "The requested Developer ID Application identity is not available in Keychain",
      "MACOS_DEVELOPER_ID_UNAVAILABLE",
    );
  }
  const sign = (relativePath, {
    entitlements = null,
    preserveEntitlements = false,
  } = {}) => {
    const arguments_ = [
      "--force",
      "--sign",
      identity,
      "--options",
      "runtime",
      "--timestamp",
    ];
    if (entitlements) {
      arguments_.push("--entitlements", entitlements);
    }
    if (preserveEntitlements) {
      arguments_.push("--preserve-metadata=entitlements");
    }
    arguments_.push(join(inspected.appPath, ...relativePath.split("/")));
    commandRunner("/usr/bin/codesign", arguments_, {
      env: releaseEnvironment(),
      failureMessage: `Developer ID signing failed for ${basename(relativePath)}`,
      secrets,
    });
  };
  sign(`${SPARKLE_FRAMEWORK_PREFIX}/Versions/B/XPCServices/Installer.xpc`);
  sign(`${SPARKLE_FRAMEWORK_PREFIX}/Versions/B/XPCServices/Downloader.xpc`, {
    preserveEntitlements: true,
  });
  sign(`${SPARKLE_FRAMEWORK_PREFIX}/Versions/B/Autoupdate`);
  sign(`${SPARKLE_FRAMEWORK_PREFIX}/Versions/B/Updater.app`);
  sign(SPARKLE_FRAMEWORK_PREFIX);
  sign(KEYTAR_EXECUTABLE);
  await validateNodeRuntimeEntitlements();
  sign(NODE_EXECUTABLE, { entitlements: NODE_ENTITLEMENTS });
  // The app bundle carries no entitlements of its own. Sign in with Apple is
  // a restricted entitlement that a Developer ID provisioning profile does
  // not grant (verified 2026-08-01 against two freshly generated profiles for
  // this App ID); a build signed with it is terminated by the kernel at
  // launch. Apple sign-in is a hosted browser flow against the contribution
  // service instead, so nothing here needs it.
  sign(APP_EXECUTABLE);
  sign("");
  commandRunner("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    inspected.appPath,
  ], {
    env: releaseEnvironment(),
    failureMessage: "Developer ID signature verification failed",
    secrets,
  });
  const description = commandRunner("/usr/bin/codesign", [
    "-d",
    "--verbose=4",
    inspected.appPath,
  ], {
    env: releaseEnvironment(),
    failureMessage: "Developer ID signature inspection failed",
    secrets,
  });
  const signature = `${description.stdout}${description.stderr}`;
  if (!signature.includes("Authority=Developer ID Application:")
      || !/flags=0x[0-9a-f]+\(runtime\)/iu.test(signature)) {
    fail("Signed application is missing Developer ID hardened runtime");
  }
  return inspected;
}

async function inspectMacOSDMGInput(
  appPath,
  distribution,
  channel = STABLE_RELEASE_CHANNEL,
) {
  if (distribution === DMG_DISTRIBUTIONS.release) {
    return inspectMacOSApp(appPath, {
      channel,
      requireExternalDistribution: true,
    });
  }
  if (distribution === DMG_DISTRIBUTIONS.development) {
    const inspected = await inspectMacOSApp(appPath);
    const release = inspected.buildManifest.release;
    if (release?.channel !== "development"
        || release.channelName !== "development"
        || release.externalDistributionRequested !== false
        || release.previewDistributionRequested !== false
        || release.productionOriginValidated !== false
        || release.previewOriginValidated !== false
        || release.requiresDeveloperIDAndNotarization !== false
        || release.updater?.enabled !== false) {
      fail(
        "Development DMGs require an updater-disabled development application",
        "MACOS_DEVELOPMENT_DMG_INPUT_INVALID",
      );
    }
    return inspected;
  }
  if (distribution === DMG_DISTRIBUTIONS.preview) {
    await validateMacOSPreviewApp(appPath);
    const selected = resolve(appPath);
    const manifest = JSON.parse(await readFile(join(
      selected,
      ...BUILD_MANIFEST_PATH.split("/"),
    ), "utf8"));
    const plist = parsePlist(join(selected, "Contents", "Info.plist"));
    return Object.freeze({
      appPath: selected,
      buildManifest: manifest,
      shortVersion: plist.CFBundleShortVersionString,
    });
  }
  fail(
    "DMG distribution must be development, preview, or release",
    "MACOS_DMG_DISTRIBUTION_INVALID",
  );
}

function validateNonReleaseDMGName(path, distribution) {
  if (distribution === DMG_DISTRIBUTIONS.release) return;
  const suffix = `-${distribution}.dmg`;
  if (!basename(path).endsWith(suffix)) {
    fail(
      `Non-release ${distribution} DMGs must use a -${distribution}.dmg filename`,
      "MACOS_NON_RELEASE_DMG_NAME_REQUIRED",
    );
  }
}

export async function packageMacOSDMG({
  appPath,
  output,
  replace = false,
  distribution,
  channel = STABLE_RELEASE_CHANNEL,
}) {
  if (!Object.values(DMG_DISTRIBUTIONS).includes(distribution)) {
    fail(
      "DMG packaging requires an explicit development, preview, or release distribution",
      "MACOS_DMG_DISTRIBUTION_REQUIRED",
    );
  }
  const inspected = await inspectMacOSDMGInput(appPath, distribution, channel);
  const selectedOutput = resolve(output);
  if (basename(selectedOutput).startsWith(".")
      || !selectedOutput.endsWith(".dmg")) {
    fail("DMG output must be a visible .dmg file");
  }
  validateNonReleaseDMGName(selectedOutput, distribution);
  const outputParent = dirname(selectedOutput);
  await mkdir(outputParent, { recursive: true, mode: 0o755 });
  if (await realpath(outputParent) !== outputParent) {
    fail("DMG output parent must not traverse a symbolic link");
  }
  let existing = null;
  try {
    existing = await lstat(selectedOutput);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing && (!replace || !existing.isFile()
      || existing.isSymbolicLink())) {
    fail("Refusing to replace the existing DMG without --replace");
  }
  const temporaryRoot = await mkdtemp(
    join(outputParent, ".usage-monitor-dmg-"),
  );
  const staging = join(temporaryRoot, "volume");
  const stagedApp = join(staging, APP_NAME);
  const temporaryDMG = join(
    temporaryRoot,
    `${PRODUCT_BRAND.executableName}.dmg`,
  );
  try {
    await mkdir(staging, { recursive: true, mode: 0o755 });
    runMacOSReleaseCommand("/usr/bin/ditto", [
      "--noqtn",
      inspected.appPath,
      stagedApp,
    ], {
      env: releaseEnvironment(),
      failureMessage: "Application staging failed",
    });
    const pending = [stagedApp];
    while (pending.length > 0) {
      const current = pending.pop();
      const metadata = await lstat(current);
      if (metadata.isDirectory()) {
        for (const name of (await readdir(current)).sort()) {
          pending.push(join(current, name));
        }
      }
      if (!metadata.isSymbolicLink()) {
        await utimes(current, FIXED_EPOCH_SECONDS, FIXED_EPOCH_SECONDS);
      }
    }
    await symlink("/Applications", join(staging, "Applications"));
    runMacOSReleaseCommand("/usr/bin/hdiutil", [
      "create",
      "-ov",
      "-srcfolder",
      staging,
      "-volname",
      PRODUCT_BRAND.displayName,
      "-fs",
      "HFS+",
      "-format",
      "UDZO",
      "-imagekey",
      "zlib-level=9",
      "-nospotlight",
      "-noanyowners",
      temporaryDMG,
    ], {
      env: releaseEnvironment(),
      failureMessage: "DMG creation failed",
      timeout: 300_000,
    });
    runMacOSReleaseCommand("/usr/bin/hdiutil", [
      "verify",
      temporaryDMG,
    ], {
      env: releaseEnvironment(),
      failureMessage: "DMG verification failed",
      timeout: 300_000,
    });
    if (existing) await rm(selectedOutput, { force: false });
    await rename(temporaryDMG, selectedOutput);
    await chmod(selectedOutput, 0o444);
    return Object.freeze({
      bytes: (await stat(selectedOutput)).size,
      output: selectedOutput,
      sha256: await sha256File(selectedOutput),
      distribution,
      shortVersion: inspected.shortVersion,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function submitToAppleNotary(path, {
  notaryProfile,
  commandRunner = runMacOSReleaseCommand,
}) {
  const result = commandRunner("/usr/bin/xcrun", [
    "notarytool",
    "submit",
    path,
    "--keychain-profile",
    notaryProfile,
    "--wait",
    "--output-format",
    "json",
  ], {
    env: releaseEnvironment(),
    failureMessage: "Apple notarization submission failed",
    secrets: [notaryProfile],
    timeout: 30 * 60_000,
  });
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    fail("Apple notarization returned an unreadable response");
  }
  if (response.status !== "Accepted") {
    fail(
      "Apple notarization did not accept the artifact",
      "MACOS_NOTARIZATION_REJECTED",
    );
  }
  return Object.freeze({ status: "Accepted" });
}

export function stapleAndValidate(path, {
  commandRunner = runMacOSReleaseCommand,
} = {}) {
  for (const action of ["staple", "validate"]) {
    commandRunner("/usr/bin/xcrun", [
      "stapler",
      action,
      path,
    ], {
      env: releaseEnvironment(),
      failureMessage: `Apple ticket ${action} failed`,
      timeout: 300_000,
    });
  }
}

function attachDMG(path) {
  const attached = runMacOSReleaseCommand("/usr/bin/hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-plist",
    path,
  ], {
    env: releaseEnvironment(),
    failureMessage: "DMG mount failed",
    timeout: 300_000,
  });
  const converted = runMacOSReleaseCommand("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    "-",
  ], {
    input: attached.stdout,
    failureMessage: "DMG mount response was invalid",
  });
  let response;
  try {
    response = JSON.parse(converted.stdout);
  } catch {
    fail("DMG mount response was not JSON");
  }
  const entities = response["system-entities"];
  const selected = Array.isArray(entities)
    ? entities.find((entry) => typeof entry["mount-point"] === "string")
    : null;
  if (!selected) fail("DMG did not expose a mounted volume");
  return Object.freeze({
    device: selected["dev-entry"],
    mountPoint: selected["mount-point"],
  });
}

function detachDMG(attached) {
  runMacOSReleaseCommand("/usr/bin/hdiutil", [
    "detach",
    attached.device ?? attached.mountPoint,
  ], {
    env: releaseEnvironment(),
    failureMessage: "DMG detach failed",
    timeout: 300_000,
  });
}

export async function validateMacOSApplicationsLink(path) {
  const metadata = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") {
      fail("DMG Applications link is missing");
    }
    throw error;
  });
  if (!metadata.isSymbolicLink()
      || await readlink(path) !== "/Applications") {
    fail("DMG Applications link must target /Applications");
  }
}

/**
 * Exercise only the compiled fake ServiceManagement seam. This never creates,
 * changes, or queries the caller's real Login Items; the executable recognizes
 * the contract argument before it constructs the production adapter.
 */
export function validateMacOSLoginItemContract(executablePath, {
  environment = releaseEnvironment(),
} = {}) {
  const smoke = runMacOSReleaseCommand(executablePath, [
    "--login-item-contract-smoke-test",
  ], {
    env: environment,
    failureMessage: "Packaged Login Item contract smoke failed",
    timeout: 5_000,
  });
  if (smoke.stdout.trim() !== LOGIN_ITEM_CONTRACT_OUTPUT) {
    fail(
      "Packaged Login Item contract smoke reported an unexpected result",
      "MACOS_LOGIN_ITEM_CONTRACT_INVALID",
    );
  }
  return Object.freeze({
    fakeServiceManagement: true,
    realServiceCalls: 0,
    daemon: false,
  });
}

function isValidRehearsalDate(value) {
  if (typeof value !== "string"
      || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

function isSafeRehearsalString(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && !value.includes("\0");
}

/**
 * Validate a privacy-safe human rehearsal receipt. The receipt makes the
 * non-automatable lifecycle checks (real sign-in, replacement, move, and
 * uninstall) explicit without allowing release tooling to mutate a person's
 * Login Items database itself.
 */
export function validateMacOSLoginItemReleaseRehearsal(receipt, {
  bundleIdentifier = BUNDLE_IDENTIFIER,
  bundleVersion,
  shortVersion,
} = {}) {
  const recordedOn = receipt?.recordedOn;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
      || receipt.schemaVersion !== LOGIN_ITEM_RELEASE_REHEARSAL_SCHEMA
      || !isValidRehearsalDate(recordedOn)
      || receipt.environment?.cleanDisposableProfile !== true
      || receipt.environment?.installedInApplications !== true
      || receipt.application?.bundleIdentifier !== bundleIdentifier
      || !isSafeRehearsalString(receipt.application?.bundleVersion)
      || !isSafeRehearsalString(receipt.application?.shortVersion)
      || (bundleVersion !== undefined
        && receipt.application.bundleVersion !== bundleVersion)
      || (shortVersion !== undefined
        && receipt.application.shortVersion !== shortVersion)
      || REQUIRED_LOGIN_ITEM_REHEARSAL_CHECKS.some(
        (key) => receipt.checks?.[key] !== true,
      )) {
    fail(
      "Login Item release rehearsal receipt is incomplete or does not match the installed app",
      "MACOS_LOGIN_ITEM_REHEARSAL_INVALID",
    );
  }
  return Object.freeze({
    bundleIdentifier: receipt.application.bundleIdentifier,
    bundleVersion: receipt.application.bundleVersion,
    recordedOn,
    requiredChecks: [...REQUIRED_LOGIN_ITEM_REHEARSAL_CHECKS],
  });
}

export async function validateInstalledMacOSApp(appPath, {
  channel = "stable",
  expectedBundleIdentifier = null,
  expectedBundleVersion = null,
  expectedShortVersion = null,
  production = true,
} = {}) {
  const inspected = await inspectMacOSApp(appPath, {
    channel,
    requireExternalDistribution: production,
  });
  if ((expectedBundleIdentifier !== null
      && inspected.bundleIdentifier !== expectedBundleIdentifier)
      || (expectedBundleVersion !== null
        && inspected.bundleVersion !== expectedBundleVersion)
      || (expectedShortVersion !== null
        && inspected.shortVersion !== expectedShortVersion)) {
    fail(
      "Installed application metadata does not match its release manifest",
      "MACOS_RELEASE_ARTIFACT_METADATA_MISMATCH",
    );
  }
  runMacOSReleaseCommand("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    inspected.appPath,
  ], {
    failureMessage: "Installed application signature verification failed",
  });
  if (production) {
    const description = runMacOSReleaseCommand("/usr/bin/codesign", [
      "-d",
      "--verbose=4",
      inspected.appPath,
    ], {
      failureMessage: "Installed application signature inspection failed",
    });
    const signature = `${description.stdout}${description.stderr}`;
    if (!signature.includes("Authority=Developer ID Application:")
        || !/flags=0x[0-9a-f]+\(runtime\)/iu.test(signature)) {
      fail("Installed application is not Developer ID hardened");
    }
    runMacOSReleaseCommand("/usr/bin/xcrun", [
      "stapler",
      "validate",
      inspected.appPath,
    ], {
      failureMessage: "Installed application has no valid stapled ticket",
      timeout: 300_000,
    });
    runMacOSReleaseCommand("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "execute",
      "--verbose=2",
      inspected.appPath,
    ], {
      failureMessage: "Gatekeeper rejected the installed application",
    });
  }
  // This uses a fake manager by contract. The production ServiceManagement
  // adapter is not constructed and the operator's real Login Item remains
  // untouched during every build, signing, DMG, and validation run.
  validateMacOSLoginItemContract(inspected.executablePath);
  const isolatedRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-clean-install-"),
  );
  const isolatedHome = join(isolatedRoot, "home");
  try {
    await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
    const smoke = runMacOSReleaseCommand(
      inspected.executablePath,
      ["--smoke-test"],
      {
        env: {
          HOME: isolatedHome,
          LANG: "en_US.UTF-8",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          TMPDIR: tmpdir(),
        },
        failureMessage: "Clean-profile application smoke failed",
        timeout: 30_000,
      },
    );
    if (!/^USAGE_MONITOR_MACOS_SMOKE_READY /mu.test(smoke.stdout)) {
      fail("Clean-profile application smoke did not report readiness");
    }
    for (const path of [
      join(isolatedHome, "Library", "LaunchAgents"),
      join(isolatedHome, "Library", "LaunchDaemons"),
    ]) {
      try {
        await lstat(path);
        fail("Application created an unexpected background-service directory");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
  return Object.freeze({
    bundleIdentifier: inspected.bundleIdentifier,
    production,
    shortVersion: inspected.shortVersion,
  });
}

export async function validateMacOSDMG(path, {
  channel = "stable",
  expectedBundleIdentifier = null,
  expectedBundleVersion = null,
  expectedShortVersion = null,
  production = true,
} = {}) {
  const selected = resolve(path);
  await regularPath(selected);
  runMacOSReleaseCommand("/usr/bin/hdiutil", ["verify", selected], {
    failureMessage: "DMG verification failed",
    timeout: 300_000,
  });
  if (production) {
    runMacOSReleaseCommand("/usr/bin/xcrun", [
      "stapler",
      "validate",
      selected,
    ], {
      failureMessage: "DMG has no valid stapled ticket",
      timeout: 300_000,
    });
    runMacOSReleaseCommand("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=2",
      selected,
    ], {
      failureMessage: "Gatekeeper rejected the DMG",
    });
  }
  const attached = attachDMG(selected);
  const isolatedRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-mounted-install-"),
  );
  try {
    const names = (await readdir(attached.mountPoint)).sort();
    if (names.length !== 2
        || names[0] !== "Applications"
        || names[1] !== APP_NAME) {
      fail(
        `DMG layout must contain only Applications and ${APP_NAME}`,
      );
    }
    await validateMacOSApplicationsLink(
      join(attached.mountPoint, "Applications"),
    );
    const installedApp = join(isolatedRoot, "Applications", APP_NAME);
    await mkdir(dirname(installedApp), { recursive: true, mode: 0o755 });
    runMacOSReleaseCommand("/usr/bin/ditto", [
      "--noqtn",
      join(attached.mountPoint, APP_NAME),
      installedApp,
    ], {
      failureMessage: "Mounted application copy failed",
    });
    return await validateInstalledMacOSApp(installedApp, {
      channel,
      expectedBundleIdentifier,
      expectedBundleVersion,
      expectedShortVersion,
      production,
    });
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
    detachDMG(attached);
  }
}

async function writeAtomic(path, content, { replace }) {
  let existing = null;
  try {
    existing = await lstat(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing && (!replace || !existing.isFile()
      || existing.isSymbolicLink())) {
    fail("Refusing to replace an existing release artifact without --replace");
  }
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content, { mode: 0o444, flag: "wx" });
  if (existing) await rm(path, { force: false });
  await rename(temporary, path);
}

async function assertReplaceableReleaseTarget(path, {
  label,
  replace,
}) {
  let metadata = null;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (metadata && (!replace || !metadata.isFile()
      || metadata.isSymbolicLink())) {
    fail(`Refusing to replace an existing ${label} without --replace`);
  }
  return metadata !== null;
}

/**
 * Build the unsigned review candidate that anchors the release packager's
 * reproducibility check. The generic builder remains unable to authorize an
 * external bundle; this owner path derives every endpoint and updater input
 * from the named release channel, then revalidates source provenance,
 * credentials, and key continuity inside the builder before writing output.
 */
export async function prepareMacOSReleaseCandidate({
  channel,
  output,
  environment = process.env,
  previousStableManifestPath = null,
  stableBootstrap = false,
}) {
  const releaseChannel = resolveReleaseChannel(channel);
  if (releaseChannel.name !== STABLE_RELEASE_CHANNEL
      && (previousStableManifestPath !== null || stableBootstrap)) {
    fail(
      "Stable Sparkle continuity options are only valid for the stable channel",
      "MACOS_STABLE_CONTINUITY_CHANNEL_INVALID",
    );
  }
  const buildConfiguration = readMacOSReleaseBuildConfiguration(
    environment,
    releaseChannel.name,
  );
  const updaterConfiguration = await normalizeMacOSUpdaterConfiguration({
    appcastURL: buildConfiguration.sparkleAppcastURL,
    externalDistribution: true,
    frameworkPath: buildConfiguration.sparkleFramework,
    publicEdKey: buildConfiguration.sparklePublicEdKey,
  });
  return buildMacOSReleaseCandidate({
    output: resolve(output),
    centralOrigin: buildConfiguration.productionOrigin,
    externalDistribution: true,
    environment,
    previousStableManifestPath,
    stableBootstrap,
    releaseChannel: releaseChannel.name,
    bundleVersion: buildConfiguration.bundleVersion,
    sparkleFramework: updaterConfiguration.framework.path,
    sparkleAppcastURL: updaterConfiguration.appcastURL,
    sparklePublicEdKey: updaterConfiguration.publicEdKey,
  });
}

export async function releaseMacOSApp({
  appPath,
  channel,
  output,
  environment = process.env,
  previousStableManifestPath = null,
  replace = false,
  stableBootstrap = false,
}) {
  const releaseChannel = resolveReleaseChannel(channel);
  if (previousStableManifestPath !== null
      && (typeof previousStableManifestPath !== "string"
        || previousStableManifestPath.length === 0
        || previousStableManifestPath.includes("\0"))) {
    fail(
      "Previous stable manifest path is invalid",
      "MACOS_STABLE_PREVIOUS_MANIFEST_INVALID",
    );
  }
  if (releaseChannel.name !== STABLE_RELEASE_CHANNEL
      && (previousStableManifestPath !== null || stableBootstrap)) {
    fail(
      "Stable Sparkle continuity options are only valid for the stable channel",
      "MACOS_STABLE_CONTINUITY_CHANNEL_INVALID",
    );
  }
  const buildConfiguration =
    readMacOSReleaseBuildConfiguration(environment, releaseChannel.name);
  const updaterConfiguration = await normalizeMacOSUpdaterConfiguration({
    appcastURL: buildConfiguration.sparkleAppcastURL,
    externalDistribution: true,
    frameworkPath: buildConfiguration.sparkleFramework,
    publicEdKey: buildConfiguration.sparklePublicEdKey,
  });
  const previousStableManifest = previousStableManifestPath === null
    ? null
    : await readStableReleaseManifest(previousStableManifestPath);
  assertStableSparkleKeyContinuity({
    candidateBundleVersion: buildConfiguration.bundleVersion,
    candidatePublicEdKeySha256: createHash("sha256")
      .update(Buffer.from(updaterConfiguration.publicEdKey, "base64"))
      .digest("hex"),
    channel: releaseChannel.name,
    previousManifest: previousStableManifest,
    stableBootstrap,
  });
  const sourceProvenance = readMacOSReleaseSourceProvenance();
  const credentials = readMacOSReleaseCredentials(environment);
  const inspectedCandidate = await inspectMacOSApp(appPath, {
    channel: releaseChannel.name,
    requireExternalDistribution: true,
  });
  if (inspectedCandidate.plist.UsageMonitorCentralOrigin
        !== buildConfiguration.productionOrigin
      || inspectedCandidate.bundleVersion
        !== buildConfiguration.bundleVersion
      || inspectedCandidate.plist.SUFeedURL
        !== updaterConfiguration.appcastURL
      || inspectedCandidate.plist.SUPublicEDKey
        !== updaterConfiguration.publicEdKey) {
    fail(
      `Release candidate does not match the explicitly approved ${releaseChannel.name} origin and bundle version`,
      "MACOS_RELEASE_CONFIGURATION_MISMATCH",
    );
  }
  const selectedOutput = resolve(output);
  if (basename(selectedOutput).startsWith(".")
      || !selectedOutput.endsWith(".dmg")) {
    fail("Release output must be a visible .dmg file");
  }
  const releaseManifestPath = `${selectedOutput}.release.json`;
  const outputParent = dirname(selectedOutput);
  await mkdir(outputParent, { recursive: true, mode: 0o755 });
  if (await realpath(outputParent) !== outputParent) {
    fail("Release output parent must not traverse a symbolic link");
  }
  await assertReplaceableReleaseTarget(selectedOutput, {
    label: "DMG",
    replace,
  });
  await assertReplaceableReleaseTarget(releaseManifestPath, {
    label: "release manifest",
    replace,
  });
  const temporaryRoot = await mkdtemp(
    join(outputParent, ".usage-monitor-release-"),
  );
  const stagedApp = join(temporaryRoot, APP_NAME);
  const submissionZip = join(
    temporaryRoot,
    `${PRODUCT_BRAND.executableName}.zip`,
  );
  const stagedDMG = join(
    temporaryRoot,
    `${PRODUCT_BRAND.executableName}.dmg`,
  );
  try {
    await buildMacOSAppForRelease({
      output: stagedApp,
      centralOrigin: buildConfiguration.productionOrigin,
      externalDistribution: true,
      candidateAppPath: appPath,
      environment,
      previousStableManifestPath,
      stableBootstrap,
      releaseChannel: releaseChannel.name,
      bundleVersion: buildConfiguration.bundleVersion,
      sparkleFramework: updaterConfiguration.framework.path,
      sparkleAppcastURL: updaterConfiguration.appcastURL,
      sparklePublicEdKey: updaterConfiguration.publicEdKey,
    });
    const inspected = await inspectMacOSApp(stagedApp, {
      channel: releaseChannel.name,
      requireExternalDistribution: true,
    });
    if (inspected.buildManifest.inputs?.sourceSha256
          !== inspectedCandidate.buildManifest.inputs?.sourceSha256
        || inspected.buildManifest.payload?.payloadSha256
          !== inspectedCandidate.buildManifest.payload?.payloadSha256
        || inspected.buildManifest.payload?.totalBytes
          !== inspectedCandidate.buildManifest.payload?.totalBytes) {
      fail(
        "Reviewed candidate is not reproducible from the checked-out source and approved release inputs",
        "MACOS_RELEASE_CANDIDATE_NOT_REPRODUCIBLE",
      );
    }
    // Optional: a Developer ID provisioning profile, when one is supplied,
    // is an Apple-issued public artifact embedded before signing so the final
    // signature seals it. This bundle requests no restricted entitlement, so
    // the profile is not required for the app to launch.
    if (buildConfiguration.provisioningProfile) {
      await copyFile(
        buildConfiguration.provisioningProfile,
        join(stagedApp, ...EMBEDDED_PROFILE_PATH.split("/")),
      );
    }
    await developerIDSignMacOSApp(stagedApp, {
      identity: credentials.identity,
    });
    runMacOSReleaseCommand("/usr/bin/ditto", [
      "-c",
      "-k",
      "--keepParent",
      stagedApp,
      submissionZip,
    ], {
      env: releaseEnvironment(),
      failureMessage: "Notarization archive creation failed",
    });
    submitToAppleNotary(submissionZip, {
      notaryProfile: credentials.notaryProfile,
    });
    stapleAndValidate(stagedApp);
    await validateInstalledMacOSApp(stagedApp, {
      channel: releaseChannel.name,
      production: true,
    });
    await packageMacOSDMG({
      appPath: stagedApp,
      output: stagedDMG,
      replace: false,
      distribution: "release",
      channel: releaseChannel.name,
    });
    await chmod(stagedDMG, 0o644);
    submitToAppleNotary(stagedDMG, {
      notaryProfile: credentials.notaryProfile,
    });
    stapleAndValidate(stagedDMG);
    await validateMacOSDMG(stagedDMG, {
      channel: releaseChannel.name,
      production: true,
    });

    const outputExists = await assertReplaceableReleaseTarget(
      selectedOutput,
      { label: "DMG", replace },
    );
    await assertReplaceableReleaseTarget(releaseManifestPath, {
      label: "release manifest",
      replace,
    });
    if (outputExists) await rm(selectedOutput, { force: false });
    await rename(stagedDMG, selectedOutput);
    await chmod(selectedOutput, 0o444);

    const releaseManifest = {
      schemaVersion: RELEASE_MANIFEST_SCHEMA,
      application: {
        bundleIdentifier: inspected.bundleIdentifier,
        bundleVersion: inspected.bundleVersion,
        shortVersion: inspected.shortVersion,
      },
      artifact: {
        bytes: (await stat(selectedOutput)).size,
        fileName: basename(selectedOutput),
        sha256: await sha256File(selectedOutput),
      },
      assurances: {
        appNotarizationAccepted: true,
        appTicketStapled: true,
        candidateReproducedFromCheckedOutSource: true,
        cleanProfileSmokePassed: true,
        developerIDHardenedRuntime: true,
        dmgGatekeeperAssessmentPassed: true,
        dmgNotarizationAccepted: true,
        dmgTicketStapled: true,
      },
      build: {
        payloadSha256:
          inspected.buildManifest.payload.payloadSha256,
        sourceSha256:
          inspected.buildManifest.inputs.sourceSha256,
      },
      channel: createReleaseChannelProvenance(releaseChannel.name, {
        publicEdKeySha256:
          inspected.buildManifest.release.updater.publicEdKeySha256,
      }),
      source: sourceProvenance,
      privacy: {
        credentialsRecorded: false,
        identityRecorded: false,
        notaryProfileRecorded: false,
      },
      updater: {
        ...inspected.buildManifest.release.updater,
      },
      replacement: createMacOSSignedReplacementContract(),
    };
    await writeAtomic(
      releaseManifestPath,
      stableJson(releaseManifest),
      { replace },
    );
    return Object.freeze({
      channel: releaseChannel.name,
      output: selectedOutput,
      releaseManifest: releaseManifestPath,
      sha256: releaseManifest.artifact.sha256,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
