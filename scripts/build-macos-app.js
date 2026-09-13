#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fileSystemConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDeploymentEndpoints,
  DEPLOYMENT_ENDPOINTS,
} from "../config/deployment-endpoints.js";
import {
  PREVIEW_PRODUCT_BRAND,
  PRODUCT_BRAND,
} from "../config/product-brand.js";
import {
  assertReleaseChannelConfiguration,
  resolveReleaseChannel,
  STABLE_RELEASE_CHANNEL,
} from "../config/release-channels.js";
import {
  SPARKLE_FRAMEWORK_LINKS,
  SPARKLE_FRAMEWORK_SHA256,
  SPARKLE_MACH_O_PATHS,
  SPARKLE_VERSION,
  normalizeMacOSUpdaterConfiguration,
  normalizeMacOSUpdaterMetadata,
} from "./macos-updater-core.js";
import {
  deriveEpochMacOSBundleVersion,
  isAppleMacOSBundleVersion,
} from "./macos-bundle-version.js";
import {
  readVerifiedTelemetryBrowserMirror,
} from "./generate-telemetry-browser-mirror.js";
import {
  RELEASE_VERSION,
  RELEASE_VERSION_PLACEHOLDER,
} from "../config/release-manifest.js";
import {
  RUNTIME_ACCOUNTING_FILES,
  RUNTIME_ALLOWED_GENERATED_FILES,
  RUNTIME_IDENTITY_CORE_FILES,
  RUNTIME_PINNED_PACKAGES,
  RUNTIME_QUOTA_ANALYSIS_FILES,
  RUNTIME_TELEMETRY_CONTRACT_FILES,
  RUNTIME_WEB_MODULE_ENTRYPOINTS,
  RUNTIME_WORKSPACE_PACKAGE_DEFINITIONS,
  assertAllowedFirstPartyPath as assertRuntimeAllowedFirstPartyPath,
  assertReviewedDirectory as assertRuntimeReviewedDirectory,
  assertWorkspaceRuntimePackageCaptures,
  captureWorkspaceRuntimePackages,
  collectRuntimeGraph,
  collectWebModuleGraph,
  pinnedPackage as pinRuntimePackage,
  pinnedPackageTreeDigest as runtimePinnedPackageTreeDigest,
  readRuntimePackageManifest as readNeutralRuntimePackageManifest,
  repositoryRelative as runtimeRepositoryRelative,
  resolveReviewedInput as resolveRuntimeReviewedInput,
  reviewedRelative as runtimeReviewedRelative,
  validateCapturedWorkspaceRuntimePackages as validateRuntimeCapturedWorkspaceRuntimePackages,
} from "./lib/runtime-closure.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const CAPTURED_UTF8_SOURCE_HELPER = fileURLToPath(
  new URL("./lib/captured-utf8-source.mjs", import.meta.url),
);
const RUNTIME_CLOSURE_HELPER = fileURLToPath(
  new URL("./lib/runtime-closure.mjs", import.meta.url),
);
const PRODUCT_BRAND_CONFIG = join(
  REPOSITORY_ROOT,
  "config",
  "product-brand.js",
);
const RELEASE_MANIFEST_CONFIG = join(
  REPOSITORY_ROOT,
  "config",
  "release-manifest.js",
);
const PACKAGE_MANIFEST = join(REPOSITORY_ROOT, "package.json");
const ENTRYPOINT = join(REPOSITORY_ROOT, "apps", "local", "server.js");
const MACOS_SOURCE_ROOT = join(REPOSITORY_ROOT, "apps", "macos");
const MACOS_RESOURCE_ROOT = join(MACOS_SOURCE_ROOT, "Resources");
const WEB_MODULE_ROOT = join(
  REPOSITORY_ROOT,
  "apps",
  "web",
  "public",
);
const PINNED_NODE_VERSION = "v26.2.0";
const PINNED_NODE_ARCHITECTURE = "arm64";
// These Intel file digests are from the official
// node-v26.2.0-darwin-x64.tar.xz archive, SHA-256
// 50e3fb7cda816f0ab8929551516530669d1c0449a3f6a8a044be82a57cc642a4.
// Verify the archive before extracting it; never execute an unverified input.
const PINNED_INTEL_NODE_SHA256 =
  "51ef33e35c9cd96192baba41dfb592a9568380a5b2190d64e63332c4bd807e0f";
const PINNED_INTEL_NODE_LICENSE_SHA256 =
  "148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5";
const MINIMUM_MACOS_VERSION = "14.0";
const PACKAGE_NAME = "app-usagemonitor";
const SHORT_VERSION = RELEASE_VERSION;
// Unsigned development and separately identified Preview builds use a
// deterministic first-component epoch. Signed stable-identity builds instead
// receive an explicit channel allocation from macos-release-core, so a preview
// can never advance or strand the stable Sparkle line.
export function deriveMacOSBundleVersion(releaseVersion = SHORT_VERSION) {
  const derived = deriveEpochMacOSBundleVersion(releaseVersion);
  if (derived === null) {
    fail(
      "Release version cannot be converted to the reviewed Apple-compatible macOS bundle-version epoch",
      "MACOS_BUNDLE_VERSION_DERIVATION_FAILED",
    );
  }
  return derived;
}
const BUNDLE_VERSION = deriveMacOSBundleVersion();
const LOOPBACK_HOST = "127.0.0.1";
const CENTRAL_ORIGIN_MODE_NONE = "not_configured";
const CENTRAL_ORIGIN_MODE_HTTPS = "production_https";
const CENTRAL_ORIGIN_MODE_LOOPBACK = "development_loopback";
const DISTRIBUTION_CHANNEL_DEVELOPMENT = "development";
const DISTRIBUTION_CHANNEL_PREVIEW = "preview_distribution";
const DISTRIBUTION_CHANNEL_PRODUCTION = "production";
const MACOS_BUILD_PROFILE_RELEASE = "release";
const MACOS_BUILD_PROFILE_TEST = "test";
const FIXED_EPOCH_SECONDS = 946_684_800;
const GIT_PATH = "/usr/bin/git";
const SET_FILE_PATH = "/usr/bin/SetFile";
const MACOS_TOOL_ENV = Object.freeze({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  TZ: "UTC",
});
const MAXIMUM_BUNDLE_BYTES = 512 * 1024 * 1024;
const MANIFEST_SCHEMA = "usage-monitor-macos-app-build-v0.1";
const CODESIGN_PATH = "/usr/bin/codesign";
// On APFS, this lets the large immutable runtime inputs share blocks until a
// later build step actually changes them. Node falls back to a regular copy on
// filesystems without clone support, so release output remains portable.
const COPY_FILE_MODE = fileSystemConstants.COPYFILE_FICLONE ?? 0;
const SPARKLE_FRAMEWORK_PREFIX =
  "Contents/Frameworks/Sparkle.framework";
const SIGNED_EXECUTABLE_PATH =
  `Contents/MacOS/${PRODUCT_BRAND.executableName}`;
export const MACOS_KEYCHAIN_MIGRATION_HELPER = Object.freeze({
  executable: "Contents/Helpers/TiboTattleKeychainMigration",
  signingIdentifier: "node",
});
export const MACOS_KEYCHAIN_MIGRATION_HELPER_SOURCES = Object.freeze([
  "apps/macos/Helpers/KeychainMigrationHelper.swift",
  "apps/macos/Sources/KeychainMigration.swift",
]);
// `NativeElectronHandoverHelper.swift` is built only by Electron's dedicated
// handover tool. The native app builder may encounter it in Helpers, but must
// neither compile nor include it in the Keychain helper's source closure.
const MACOS_REVIEWED_HELPER_ENTRYPOINTS = new Set([
  "KeychainMigrationHelper.swift",
  "NativeElectronHandoverHelper.swift",
]);
const CODE_RESOURCES_PATH = "Contents/_CodeSignature/CodeResources";
const NORMALIZED_MACH_O_PATHS = new Set([
  SIGNED_EXECUTABLE_PATH,
  "Contents/Resources/runtime/bin/node",
  MACOS_KEYCHAIN_MIGRATION_HELPER.executable,
  ...SPARKLE_MACH_O_PATHS.map(
    (path) => `${SPARKLE_FRAMEWORK_PREFIX}/${path}`,
  ),
]);
// Preview bundles built before the broker-only Keychain boundary carried this
// one native addon. It was part of the reviewed normalization set at build
// time, so a still-valid older Preview manifest must be checked using that
// same signature-independent representation before it can be replaced. Keep
// this separate from NORMALIZED_MACH_O_PATHS: new inventories are derived only
// from the current source/runtime graph and must never restore retired keytar.
const RETIRED_PREVIEW_NORMALIZED_MACH_O_PATHS = new Set([
  "Contents/Resources/app/node_modules/@github/keytar/prebuilds/darwin-arm64/keytar.node",
]);
const NO_COMPATIBILITY_NORMALIZED_MACH_O_PATHS = new Set();
const ICON_ASSET = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "Assets",
  "AppIcon.icns",
);
const ICON_PROVENANCE = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "Assets",
  "AppIcon.provenance.txt",
);
const DEFAULT_PREVIEW_STAGING_ROOT = join(
  REPOSITORY_ROOT,
  ".release-build",
  "macos-preview",
  "current",
);
const DEFAULT_PREVIEW_OUTPUT = join(
  DEFAULT_PREVIEW_STAGING_ROOT,
  PREVIEW_PRODUCT_BRAND.bundleName,
);
const DEFAULT_PREVIEW_FRAMEWORK = join(
  REPOSITORY_ROOT,
  ".release-deps",
  "Sparkle.framework",
);

// Validate the shared public/site/appcast manifest at the native build
// boundary. Stable channel resolution and preview defaults below must never
// silently outlive a malformed or drifted endpoint manifest.
assertDeploymentEndpoints();

export const MACOS_BUILD_PROFILES = Object.freeze({
  release: MACOS_BUILD_PROFILE_RELEASE,
  test: MACOS_BUILD_PROFILE_TEST,
});

// This capability never crosses the CLI or process environment. The release
// wrapper below also re-runs the source, continuity, credential, and candidate
// checks before it can use this capability.
const MACOS_RELEASE_BUILD_AUTHORIZATION = Symbol(
  "usage-monitor-release-build-authorization",
);

// Preview clients are intentionally separate from named external release
// channels. These compatibility defaults are public identifiers only: the
// central origin, signed-feed URL, and Ed25519 *public* key contain no release
// credential and cannot publish, sign, or install a production update. The
// defaults remain for the reviewed preview path, but are never consulted for
// an external channel (including internal-dogfood).
export const MACOS_PREVIEW_PUBLIC_CONFIGURATION = Object.freeze({
  centralOrigin: DEPLOYMENT_ENDPOINTS.public.origin,
  // Preview may exercise the public service, but it must never read stable's
  // appcast. This dedicated path can remain unpublished; a missing preview
  // feed is safer than silently offering a stable replacement.
  sparkleAppcastURL: DEPLOYMENT_ENDPOINTS.sparkle.previewAppcastURL,
  sparklePublicEdKey: "jhgPwmvWLMr7TGURJUoi6sXias7YP1F+hejZawKVTGw=",
});
const MACOS_PREVIEW_APPCAST_PATH = "/preview/appcast.xml";

export const MACOS_PREVIEW_DISTRIBUTION_CHANNEL =
  DISTRIBUTION_CHANNEL_PREVIEW;

function assertMacOSPreviewAppcastBoundary(value, architecture = "arm64") {
  const expectedPath = architecture === "x64"
    ? "/preview/intel/appcast.xml" : MACOS_PREVIEW_APPCAST_PATH;
  let selected;
  try {
    selected = new URL(value);
  } catch {
    fail(
      "Preview distribution requires the reviewed /preview/appcast.xml path",
      "MACOS_PREVIEW_FEED_PATH_INVALID",
    );
  }
  if (selected.pathname !== expectedPath) {
    fail(
      "Preview distribution requires the reviewed /preview/appcast.xml path",
      "MACOS_PREVIEW_FEED_PATH_INVALID",
    );
  }
  return value;
}

// Compatibility names retained for native callers and existing release tests.
// The declarations and algorithms live in the runtime-neutral module.
export const MACOS_WEB_MODULE_ENTRYPOINTS = RUNTIME_WEB_MODULE_ENTRYPOINTS;
export const MACOS_RUNTIME_STATIC_ASSETS = Object.freeze([
  "apps/macos/reset-local-keychain.js",
  "apps/web/public/index.html",
  "apps/web/public/styles.css",
  "apps/web/public/electron-tray-popup.html",
  "apps/web/public/electron-tray-popup.css",
  "apps/web/public/electron-settings.html",
  "apps/web/public/electron-settings.css",
  "apps/web/public/icon-panel-left.svg",
  "apps/web/public/icon-refresh-cw.svg",
  "apps/web/public/icon-settings.svg",
  "apps/web/public/codex-color.svg",
  "apps/web/public/model-performance.css",
  "apps/web/public/tibotattle-icon.png",
]);
export const MACOS_TELEMETRY_CONTRACT_RUNTIME_FILES =
  RUNTIME_TELEMETRY_CONTRACT_FILES;
export const MACOS_ACCOUNTING_RUNTIME_FILES = RUNTIME_ACCOUNTING_FILES;
export const MACOS_QUOTA_ANALYSIS_RUNTIME_FILES = RUNTIME_QUOTA_ANALYSIS_FILES;
export const MACOS_IDENTITY_CORE_RUNTIME_FILES = RUNTIME_IDENTITY_CORE_FILES;
const ALLOWED_GENERATED_RUNTIME_FILES = new Set(RUNTIME_ALLOWED_GENERATED_FILES);
const PINNED_PACKAGES = RUNTIME_PINNED_PACKAGES;
const MACOS_WORKSPACE_RUNTIME_PACKAGE_DEFINITIONS =
  RUNTIME_WORKSPACE_PACKAGE_DEFINITIONS;

const SWIFT_EXCLUDED_DIRECTORY_NAMES = new Set([
  ".build",
  ".release-build",
  ".swiftpm",
  "build",
  "deriveddata",
  "test",
  "tests",
]);
const SWIFT_INTENTIONALLY_EXCLUDED_TOP_LEVEL_DIRECTORY_NAMES = new Set([
  "assets",
  "examples",
]);
const SWIFT_PACKAGE_MANIFEST_PATTERN =
  /^Package(?:@swift-[0-9.]+)?\.swift$/u;

function fail(message, code = "MACOS_APP_BUILD_FAILED") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function rethrowMacOSRuntimeClosureError(error) {
  if (error?.code === "RUNTIME_CLOSURE_FAILED") {
    error.code = "MACOS_APP_BUILD_FAILED";
  }
  throw error;
}

function callMacOSRuntimeClosure(operation) {
  try {
    return operation();
  } catch (error) {
    return rethrowMacOSRuntimeClosureError(error);
  }
}

async function callMacOSRuntimeClosureAsync(operation) {
  try {
    return await operation();
  } catch (error) {
    return rethrowMacOSRuntimeClosureError(error);
  }
}

function repositoryRelative(...arguments_) {
  return callMacOSRuntimeClosure(() => runtimeRepositoryRelative(...arguments_));
}

function reviewedRelative(...arguments_) {
  return callMacOSRuntimeClosure(() => runtimeReviewedRelative(...arguments_));
}

function resolveReviewedInput(...arguments_) {
  return callMacOSRuntimeClosure(() => resolveRuntimeReviewedInput(...arguments_));
}

function assertAllowedFirstPartyPath(...arguments_) {
  return callMacOSRuntimeClosure(() =>
    assertRuntimeAllowedFirstPartyPath(...arguments_));
}

async function assertReviewedDirectory(...arguments_) {
  return callMacOSRuntimeClosureAsync(() =>
    assertRuntimeReviewedDirectory(...arguments_));
}

async function readPackage(...arguments_) {
  return callMacOSRuntimeClosureAsync(() =>
    readNeutralRuntimePackageManifest(...arguments_));
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeSealedMacOSReleaseSource(source, { required }) {
  if (!required) {
    if (source !== null) {
      fail(
        "Only external release builds may seal release source identity",
        "MACOS_RELEASE_SOURCE_FORBIDDEN",
      );
    }
    return null;
  }
  if (!source || typeof source !== "object" || Array.isArray(source)
      || Object.keys(source).sort().join(",") !== "commit,tag"
      || typeof source.commit !== "string"
      || !/^[0-9a-f]{40,64}$/u.test(source.commit)
      || typeof source.tag !== "string"
      || !/^[0-9A-Za-z][0-9A-Za-z._/-]{0,127}$/u.test(source.tag)
      || source.tag.includes("..")
      || source.tag.startsWith("/")
      || source.tag.endsWith("/")) {
    fail(
      "External release build source identity is invalid",
      "MACOS_RELEASE_SOURCE_INVALID",
    );
  }
  return Object.freeze({ commit: source.commit, tag: source.tag });
}

export function normalizeMacOSCentralOrigin(
  value,
  { allowLoopbackCentralOrigin = false } = {},
) {
  if (typeof allowLoopbackCentralOrigin !== "boolean") {
    fail("allowLoopbackCentralOrigin must be a boolean");
  }
  if (value === null || value === undefined || value === "") {
    if (allowLoopbackCentralOrigin) {
      fail("--allow-loopback-central-origin requires --central-origin");
    }
    return Object.freeze({
      configured: false,
      mode: CENTRAL_ORIGIN_MODE_NONE,
      origin: null,
    });
  }
  if (typeof value !== "string" || value.includes("\0")) {
    fail("Central origin must be an absolute HTTPS origin");
  }
  let selected;
  try {
    selected = new URL(value);
  } catch {
    fail("Central origin must be an absolute HTTPS origin");
  }
  if (selected.username || selected.password
      || selected.pathname !== "/" || selected.search || selected.hash) {
    fail("Central origin must not include credentials, a path, query, or fragment");
  }
  const hostname = selected.hostname.startsWith("[")
    ? selected.hostname.slice(1, -1)
    : selected.hostname;
  const loopback = hostname === LOOPBACK_HOST;
  if (selected.protocol === "http:"
      && loopback
      && selected.port !== ""
      && allowLoopbackCentralOrigin) {
    return Object.freeze({
      configured: true,
      mode: CENTRAL_ORIGIN_MODE_LOOPBACK,
      origin: selected.origin,
    });
  }
  if (selected.protocol === "https:"
      && !["127.0.0.1", "localhost", "[::1]"].includes(selected.hostname)
      && isIP(hostname) === 0
      && !allowLoopbackCentralOrigin) {
    return Object.freeze({
      configured: true,
      mode: CENTRAL_ORIGIN_MODE_HTTPS,
      origin: selected.origin,
    });
  }
  if (selected.protocol === "http:" && loopback) {
    fail(
      "Plain-HTTP loopback requires --allow-loopback-central-origin and an explicit port",
    );
  }
  fail("Central origin must be an HTTPS DNS origin and non-loopback");
}

function resolveOperationalReleaseChannel(channel = STABLE_RELEASE_CHANNEL, architecture = "arm64") {
  if (typeof channel !== "string") {
    fail(
      "External distribution must select a named release channel",
      "MACOS_RELEASE_CHANNEL_NAME_REQUIRED",
    );
  }
  return resolveReleaseChannel(channel, { architecture });
}

function normalizeMacOSReleaseChannelOrigin(channel) {
  const normalized = normalizeMacOSCentralOrigin(channel.serviceOrigin);
  if (normalized.mode !== CENTRAL_ORIGIN_MODE_HTTPS) {
    fail(
      `Release channel ${channel.name} must use a non-loopback HTTPS service origin`,
      "MACOS_RELEASE_CHANNEL_MISMATCH",
    );
  }
  return Object.freeze({
    ...normalized,
    mode: channel.serviceOriginMode,
  });
}

export function normalizeMacOSBundleVersion(value = BUNDLE_VERSION) {
  if (!isAppleMacOSBundleVersion(value)) {
    fail(
      "Bundle version must use an Apple-compatible positive 1-4 digit major and optional 1-2 digit minor and patch components",
    );
  }
  return value;
}

export function validateMacOSDistributionConfiguration({
  centralService,
  externalDistribution = false,
  previewDistribution = false,
  releaseChannel = STABLE_RELEASE_CHANNEL,
}) {
  if (typeof externalDistribution !== "boolean") {
    fail("externalDistribution must be a boolean");
  }
  if (typeof previewDistribution !== "boolean") {
    fail("previewDistribution must be a boolean");
  }
  if (externalDistribution && previewDistribution) {
    fail(
      "Production and preview distribution channels are mutually exclusive",
      "MACOS_DISTRIBUTION_CHANNEL_CONFLICT",
    );
  }
  if (!externalDistribution
      && (typeof releaseChannel !== "string"
        || releaseChannel !== STABLE_RELEASE_CHANNEL)) {
    fail(
      "A named external release channel requires --external-distribution",
      "MACOS_RELEASE_CHANNEL_EXTERNAL_REQUIRED",
    );
  }
  const selectedReleaseChannel = externalDistribution
    ? typeof releaseChannel === "string"
      ? resolveOperationalReleaseChannel(releaseChannel)
      : assertReleaseChannelConfiguration(releaseChannel)
    : null;
  if (selectedReleaseChannel && !selectedReleaseChannel.configured) {
    fail(
      `Release channel ${selectedReleaseChannel.name} has no reviewed dedicated endpoints yet`,
      "RELEASE_CHANNEL_NOT_CONFIGURED",
    );
  }
  const requiredHTTPSMode = selectedReleaseChannel?.serviceOriginMode
    ?? CENTRAL_ORIGIN_MODE_HTTPS;
  const httpsOriginConfigured = centralService?.configured
    && centralService.mode === requiredHTTPSMode
    && typeof centralService.origin === "string"
    && centralService.origin.length > 0;
  if ((externalDistribution || previewDistribution) && !httpsOriginConfigured) {
    const code = previewDistribution
      ? "MACOS_PREVIEW_ORIGIN_REQUIRED"
      : "MACOS_PRODUCTION_ORIGIN_REQUIRED";
    fail(
      previewDistribution
        ? "Preview distribution requires a fixed non-loopback HTTPS central origin"
        : "External distribution requires a fixed non-loopback HTTPS central origin",
      code,
    );
  }
  if (selectedReleaseChannel
      && (centralService.origin !== selectedReleaseChannel.serviceOrigin
        || centralService.mode !== selectedReleaseChannel.serviceOriginMode)) {
    fail(
      `External distribution must use the reviewed ${selectedReleaseChannel.name} service origin and mode`,
      "MACOS_DISTRIBUTION_ENDPOINTS_MISMATCH",
    );
  }
  const channel = previewDistribution
    ? DISTRIBUTION_CHANNEL_PREVIEW
    : externalDistribution
      ? selectedReleaseChannel.buildManifestChannel
      : DISTRIBUTION_CHANNEL_DEVELOPMENT;
  return Object.freeze({
    channel,
    externalDistribution,
    previewDistribution,
    productionOriginValidated:
      externalDistribution && httpsOriginConfigured,
    previewOriginValidated:
      previewDistribution && httpsOriginConfigured,
  });
}

async function sha256File(path) {
  const hash = createHash("sha256");
  const bytes = await readFile(path);
  hash.update(bytes);
  return hash.digest("hex");
}

export async function collectMacOSRuntimeGraph(entrypoint = ENTRYPOINT) {
  try {
    return await collectRuntimeGraph({
      entrypoint,
      repositoryRoot: REPOSITORY_ROOT,
      allowedGeneratedFiles: ALLOWED_GENERATED_RUNTIME_FILES,
      surface: "macOS app",
    });
  } catch (error) {
    if (error?.code === "RUNTIME_CLOSURE_FAILED") {
      error.code = "MACOS_APP_BUILD_FAILED";
    }
    throw error;
  }
}

export async function collectMacOSWebModuleGraph({
  allowedRoot = WEB_MODULE_ROOT,
  entrypoints = MACOS_WEB_MODULE_ENTRYPOINTS,
  repositoryRoot = REPOSITORY_ROOT,
  capturedModuleSources = new Map(),
} = {}) {
  try {
    return await collectWebModuleGraph({
      allowedRoot,
      entrypoints,
      repositoryRoot,
      capturedModuleSources,
      surface: "macOS",
    });
  } catch (error) {
    if (error?.code === "RUNTIME_CLOSURE_FAILED") {
      error.code = "MACOS_APP_BUILD_FAILED";
    }
    throw error;
  }
}

export async function collectVerifiedMacOSWebModuleGraph({
  readVerifiedBrowserMirror = readVerifiedTelemetryBrowserMirror,
  webModuleOptions,
} = {}) {
  if (typeof readVerifiedBrowserMirror !== "function") {
    fail("readVerifiedBrowserMirror must be a function when provided");
  }
  const selectedOptions = webModuleOptions ?? {};
  const selectedRoot = resolve(selectedOptions.repositoryRoot ?? REPOSITORY_ROOT);
  const mirrorPath = join(
    selectedRoot,
    "apps",
    "web",
    "public",
    "telemetry-shared.generated.js",
  );
  const mirror = await readVerifiedBrowserMirror({
    outputFile: mirrorPath,
  });
  return collectMacOSWebModuleGraph({
    ...selectedOptions,
    capturedModuleSources: new Map([
      [mirrorPath, mirror],
    ]),
  });
}

export async function collectMacOSSwiftSources({
  repositoryRoot = REPOSITORY_ROOT,
  sourceRoot = MACOS_SOURCE_ROOT,
} = {}) {
  const selectedRepositoryRoot = resolve(repositoryRoot);
  const selectedSourceRoot = resolve(sourceRoot);
  reviewedRelative(
    selectedRepositoryRoot,
    selectedSourceRoot,
    "macOS Swift source root",
  );
  await assertReviewedDirectory(
    selectedRepositoryRoot,
    selectedSourceRoot,
    "macOS Swift source root",
  );
  const files = [];
  async function containsSwiftProductionCandidate(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail(
          `Symbolic links are not allowed under an unreviewed macOS source tree: ${
            reviewedRelative(selectedRepositoryRoot, path, "macOS Swift source")
          }`,
        );
      }
      if (entry.isDirectory()) {
        if (SWIFT_EXCLUDED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
          continue;
        }
        if (await containsSwiftProductionCandidate(path)) return true;
        continue;
      }
      if (entry.isFile()
          && extname(entry.name).toLowerCase() === ".swift"
          && !SWIFT_PACKAGE_MANIFEST_PATTERN.test(entry.name)) {
        return true;
      }
    }
    return false;
  }
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail(
          `Symbolic links are not allowed under the macOS Swift source root: ${
            reviewedRelative(selectedRepositoryRoot, path, "macOS Swift source")
          }`,
        );
      }
      if (entry.isDirectory()) {
        const normalizedName = entry.name.toLowerCase();
        if (SWIFT_EXCLUDED_DIRECTORY_NAMES.has(normalizedName)) {
          continue;
        }
        if (directory === selectedSourceRoot && entry.name === "Helpers") {
          // The migration entrypoint has its own @main. Review its exact
          // closure, but never compile it into the foreground application.
          await collectMacOSKeychainMigrationHelperSources({
            repositoryRoot: selectedRepositoryRoot,
            sourceRoot: selectedSourceRoot,
          });
          continue;
        }
        if (directory === selectedSourceRoot && entry.name !== "Sources") {
          if (
            SWIFT_INTENTIONALLY_EXCLUDED_TOP_LEVEL_DIRECTORY_NAMES
              .has(normalizedName)
          ) {
            continue;
          }
          if (await containsSwiftProductionCandidate(path)) {
            fail(
              `Unreviewed top-level macOS directory contains Swift source candidates: ${
                reviewedRelative(
                  selectedRepositoryRoot,
                  path,
                  "macOS Swift source",
                )
              }`,
            );
          }
          continue;
        }
        if (entry.name.startsWith(".")) continue;
        await visit(path);
        continue;
      }
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".swift") {
        continue;
      }
      if (SWIFT_PACKAGE_MANIFEST_PATTERN.test(entry.name)) continue;
      const label = reviewedRelative(
        selectedRepositoryRoot,
        path,
        "macOS Swift source",
      );
      if (resolve(selectedRepositoryRoot) === REPOSITORY_ROOT) {
        assertAllowedFirstPartyPath(path);
      }
      files.push(path);
    }
  }
  await visit(selectedSourceRoot);
  files.sort((left, right) =>
    reviewedRelative(selectedRepositoryRoot, left, "macOS Swift source")
      .localeCompare(
        reviewedRelative(selectedRepositoryRoot, right, "macOS Swift source"),
      ));
  if (files.length === 0) {
    fail("No production macOS Swift sources were found");
  }
  return Object.freeze({
    files: Object.freeze(files),
    relativeFiles: Object.freeze(files.map((file) =>
      reviewedRelative(
        selectedRepositoryRoot,
        file,
        "macOS Swift source",
      ))),
  });
}

export async function collectMacOSKeychainMigrationHelperSources({
  repositoryRoot = REPOSITORY_ROOT,
  sourceRoot = MACOS_SOURCE_ROOT,
} = {}) {
  const selectedRepositoryRoot = resolve(repositoryRoot);
  const selectedSourceRoot = resolve(sourceRoot);
  const helpersRoot = join(selectedSourceRoot, "Helpers");
  await assertReviewedDirectory(
    selectedRepositoryRoot,
    helpersRoot,
    "macOS migration helper source root",
  );
  const entries = await readdir(helpersRoot, { withFileTypes: true });
  const hasKeychainEntrypoint = entries.some((entry) =>
    entry.name === "KeychainMigrationHelper.swift"
      && entry.isFile()
      && !entry.isSymbolicLink());
  if (!hasKeychainEntrypoint || entries.some((entry) =>
    !entry.isFile()
      || entry.isSymbolicLink()
      || !MACOS_REVIEWED_HELPER_ENTRYPOINTS.has(entry.name))) {
    fail("macOS helper source directory must contain only reviewed helper entrypoints");
  }
  const files = [];
  for (const relativeFile of MACOS_KEYCHAIN_MIGRATION_HELPER_SOURCES) {
    const file = join(
      selectedSourceRoot,
      ...relativeFile.slice("apps/macos/".length).split("/"),
    );
    reviewedRelative(selectedRepositoryRoot, file, "macOS migration helper source");
    await assertReviewedDirectory(
      selectedRepositoryRoot,
      dirname(file),
      "macOS migration helper source directory",
    );
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      fail("macOS migration helper source must be an unlinked regular file");
    }
    if (selectedRepositoryRoot === REPOSITORY_ROOT) {
      assertAllowedFirstPartyPath(file);
    }
    files.push(file);
  }
  return Object.freeze({
    files: Object.freeze(files),
    relativeFiles: Object.freeze(files.map((file) =>
      reviewedRelative(selectedRepositoryRoot, file, "macOS migration helper source"))),
  });
}

export function assertMacOSKeychainMigrationManifest(manifest) {
  const helper = manifest?.runtime?.keychainMigrationHelper;
  const helperSources = manifest?.inputs?.keychainMigrationHelperSources;
  const appSources = manifest?.inputs?.swiftSources;
  const files = manifest?.payload?.files;
  const rows = Array.isArray(files) ? files.filter((entry) =>
    entry?.path === MACOS_KEYCHAIN_MIGRATION_HELPER.executable) : [];
  if (stableJson(helper) !== stableJson(MACOS_KEYCHAIN_MIGRATION_HELPER)
      || stableJson(helperSources) !== stableJson(MACOS_KEYCHAIN_MIGRATION_HELPER_SOURCES)
      || !Array.isArray(appSources)
      || !appSources.includes("apps/macos/Sources/KeychainMigration.swift")
      || appSources.includes("apps/macos/Helpers/KeychainMigrationHelper.swift")
      || rows.length !== 1
      || rows[0].normalization !== "mach_o_without_code_signature"
      || rows[0].mode !== "555"
      || !Number.isSafeInteger(rows[0].bytes) || rows[0].bytes < 1
      || typeof rows[0].sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(rows[0].sha256)) {
    fail(
      "Application omits or changes the reviewed Keychain migration helper contract",
      "MACOS_KEYCHAIN_MIGRATION_ARTIFACT_INVALID",
    );
  }
}

const LOCALIZATION_RESOURCE_PATTERN =
  /^(?:[^/]+\.lproj\/[^/]+\.(?:strings|stringsdict)|localization\/manifest\.json)$/u;

/**
 * Collect the reviewed native localization inputs separately from the
 * JavaScript runtime graph. `.lproj` files are AppKit resources; the same
 * bytes are mirrored into the embedded dashboard's web root during staging.
 */
export async function collectMacOSLocalizationResources({
  repositoryRoot = REPOSITORY_ROOT,
  resourceRoot = MACOS_RESOURCE_ROOT,
} = {}) {
  const selectedRepositoryRoot = resolve(repositoryRoot);
  const selectedResourceRoot = resolve(resourceRoot);
  reviewedRelative(
    selectedRepositoryRoot,
    selectedResourceRoot,
    "macOS localization resource root",
  );
  await assertReviewedDirectory(
    selectedRepositoryRoot,
    selectedResourceRoot,
    "macOS localization resource root",
  );
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail(
          `Symbolic links are not allowed under the macOS localization resource root: ${
            reviewedRelative(
              selectedRepositoryRoot,
              path,
              "macOS localization resource",
            )
          }`,
        );
      }
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativeFile = reviewedRelative(
        selectedResourceRoot,
        path,
        "macOS localization resource",
      );
      if (!LOCALIZATION_RESOURCE_PATTERN.test(relativeFile)) {
        fail(
          `Unsupported macOS localization resource: ${
            reviewedRelative(
              selectedRepositoryRoot,
              path,
              "macOS localization resource",
            )
          }`,
        );
      }
      if (selectedRepositoryRoot === REPOSITORY_ROOT) {
        assertAllowedFirstPartyPath(path);
      }
      files.push(path);
    }
  }
  await visit(selectedResourceRoot);
  files.sort((left, right) =>
    reviewedRelative(selectedResourceRoot, left, "macOS localization resource")
      .localeCompare(
        reviewedRelative(selectedResourceRoot, right, "macOS localization resource"),
      ));
  if (files.length === 0) {
    fail("No macOS localization resources were found");
  }
  return Object.freeze({
    files: Object.freeze(files),
    relativeFiles: Object.freeze(files.map((file) =>
      reviewedRelative(
        selectedResourceRoot,
        file,
        "macOS localization resource",
      ))),
    root: selectedResourceRoot,
  });
}

async function copyRegularFile(source, destination, mode = 0o444) {
  const sourceMetadata = await lstat(source);
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
    fail(`Build input is not a regular file: ${basename(source)}`);
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await copyFile(source, destination, COPY_FILE_MODE);
  await chmod(destination, mode);
  await utimes(destination, FIXED_EPOCH_SECONDS, FIXED_EPOCH_SECONDS);
}

async function writeGeneratedFile(destination, value, mode = 0o444) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await writeFile(destination, value, { flag: "wx", mode });
  await chmod(destination, mode);
  await utimes(destination, FIXED_EPOCH_SECONDS, FIXED_EPOCH_SECONDS);
}

function expectedBundleLink(path) {
  const normalized = path.split(sep).join("/");
  const prefix = `${SPARKLE_FRAMEWORK_PREFIX}/`;
  if (!normalized.startsWith(prefix)) return null;
  return SPARKLE_FRAMEWORK_LINKS[normalized.slice(prefix.length)] ?? null;
}

async function walkFiles(root, current = root, {
  allowPinnedSparkleLinks = false,
  links = [],
} = {}) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name))) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      const selected = relative(root, path);
      const target = await readlink(path);
      const expected = allowPinnedSparkleLinks
        ? expectedBundleLink(selected)
        : null;
      if (target !== expected) {
        fail(`The app bundle contains an unexpected symbolic link: ${selected}`);
      }
      const resolvedTarget = resolve(dirname(path), target);
      const fromRoot = relative(root, resolvedTarget);
      if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
        fail(`The app bundle contains an escaping symbolic link: ${selected}`);
      }
      links.push(Object.freeze({
        path: selected.split(sep).join("/"),
        target,
      }));
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await walkFiles(root, path, {
        allowPinnedSparkleLinks,
        links,
      }));
    }
    else if (entry.isFile()) files.push(path);
    else fail(`The app bundle contains an unsupported file: ${relative(root, path)}`);
  }
  return files;
}

function packageRuntimeFile(relativePath) {
  const first = relativePath.split("/")[0];
  if ([
    ".github",
    "benchmark",
    "benchmarks",
    "example",
    "examples",
    "spec",
    "test",
    "tests",
  ].includes(first)) return false;
  if (relativePath.endsWith(".map")
      || relativePath.endsWith(".d.ts")
      || /^readme/i.test(basename(relativePath))) return false;
  return true;
}

async function copyRuntimePackage({
  name,
  source,
  appRoot,
  include,
  stripSourceMapComments = false,
}) {
  const sourceRoot = await realpath(source);
  for (const file of await walkFiles(sourceRoot)) {
    const relativePath = relative(sourceRoot, file).split(sep).join("/");
    if (!include(relativePath)) continue;
    const destination = join(
      appRoot,
      "node_modules",
      ...name.split("/"),
      ...relativePath.split("/"),
    );
    if (stripSourceMapComments && relativePath.endsWith(".js")) {
      const transformed = (await readFile(file, "utf8")).replace(
        /^\s*\/\/# sourceMappingURL=.*$/gmu,
        "",
      );
      await writeGeneratedFile(destination, transformed);
    } else {
      await copyRegularFile(
        file,
        destination,
        /\.(?:node|so|dylib)$/u.test(relativePath) ? 0o555 : 0o444,
      );
    }
  }
}

export async function pinnedPackageTreeDigest(packageRoot) {
  try {
    return await runtimePinnedPackageTreeDigest(packageRoot);
  } catch (error) {
    if (error?.code === "RUNTIME_CLOSURE_FAILED") {
      error.code = "MACOS_APP_BUILD_FAILED";
    }
    throw error;
  }
}

export async function pinnedPackage(name, packagePath) {
  try {
    return await pinRuntimePackage(name, packagePath, {
      pinnedPackages: PINNED_PACKAGES,
    });
  } catch (error) {
    if (error?.code === "RUNTIME_CLOSURE_FAILED") {
      error.code = "MACOS_APP_BUILD_FAILED";
    }
    throw error;
  }
}

function validateCapturedWorkspaceRuntimePackages(packages) {
  try {
    return validateRuntimeCapturedWorkspaceRuntimePackages(packages, {
      surface: "macOS",
    });
  } catch (error) {
    if (error?.code === "RUNTIME_CLOSURE_FAILED") {
      error.code = "MACOS_APP_BUILD_FAILED";
    }
    throw error;
  }
}

function assertProductionWorkspaceRuntimePackageCaptures(packages) {
  try {
    return assertWorkspaceRuntimePackageCaptures(packages, {
      packageDefinitions: MACOS_WORKSPACE_RUNTIME_PACKAGE_DEFINITIONS,
      surface: "macOS",
    });
  } catch (error) {
    if (error?.code === "RUNTIME_CLOSURE_FAILED") {
      error.code = "MACOS_APP_BUILD_FAILED";
    }
    throw error;
  }
}

export async function captureMacOSWorkspaceRuntimePackages(options = {}) {
  try {
    return await captureWorkspaceRuntimePackages({
      ...options,
      packageDefinitions: options.packageDefinitions
        ?? MACOS_WORKSPACE_RUNTIME_PACKAGE_DEFINITIONS,
      repositoryRoot: options.repositoryRoot ?? REPOSITORY_ROOT,
      pinnedPackages: PINNED_PACKAGES,
      surface: "macOS",
    });
  } catch (error) {
    if (error?.code === "RUNTIME_CLOSURE_FAILED") {
      error.code = "MACOS_APP_BUILD_FAILED";
    }
    throw error;
  }
}

export async function stageMacOSWorkspaceRuntimePackages(appRoot, packages) {
  validateCapturedWorkspaceRuntimePackages(packages);
  const staged = [];
  for (const packageCapture of packages) {
    for (const file of packageCapture.files) {
      const relativePath = [
        "node_modules",
        ...packageCapture.name.split("/"),
        ...file.relativeFile.split("/"),
      ].join("/");
      const destination = resolveReviewedInput(
        appRoot,
        relativePath,
        "captured macOS workspace package file",
      );
      await writeGeneratedFile(destination, file.sourceText, 0o444);
      staged.push(Object.freeze({
        byteLength: file.byteLength,
        path: relativePath,
        sha256: file.sha256,
      }));
    }
  }
  return Object.freeze(staged);
}

export function assertMacOSWorkspaceRuntimePackageInventory(
  inventory,
  packages,
) {
  if (!Array.isArray(inventory)) {
    fail("macOS workspace package inventory is invalid");
  }
  validateCapturedWorkspaceRuntimePackages(packages);
  for (const packageCapture of packages) {
    for (const file of packageCapture.files) {
      const expectedPath = [
        "Contents",
        "Resources",
        "app",
        "node_modules",
        ...packageCapture.name.split("/"),
        ...file.relativeFile.split("/"),
      ].join("/");
      const rows = inventory.filter(({ path }) => path === expectedPath);
      if (rows.length !== 1
          || rows[0].bytes !== file.byteLength
          || rows[0].sha256 !== file.sha256) {
        fail(`macOS bundle did not retain captured workspace package bytes: ${file.inputPath}`);
      }
    }
  }
  return true;
}

async function copyRuntimeDependencies(appRoot, workspaceRuntimePackages) {
  assertProductionWorkspaceRuntimePackageCaptures(workspaceRuntimePackages);
  await stageMacOSWorkspaceRuntimePackages(appRoot, workspaceRuntimePackages);
  const rootRequire = createRequire(join(REPOSITORY_ROOT, "package.json"));

  const ajvPackage = rootRequire.resolve("ajv/package.json");
  const ajv = await pinnedPackage("ajv", ajvPackage);
  await copyRuntimePackage({
    name: "ajv",
    source: dirname(ajvPackage),
    appRoot,
    include: (path) =>
      path === "package.json"
      || path === "LICENSE"
      || (path.startsWith("dist/")
        && (path.endsWith(".js") || path.endsWith(".json"))),
    stripSourceMapComments: true,
  });

  const ajvRequire = createRequire(ajvPackage);
  const transitiveNames = [
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "require-from-string",
  ];
  const transitive = [];
  for (const name of transitiveNames) {
    const packagePath = ajvRequire.resolve(`${name}/package.json`);
    transitive.push(await pinnedPackage(name, packagePath));
    await copyRuntimePackage({
      name,
      source: dirname(packagePath),
      appRoot,
      include: packageRuntimeFile,
      stripSourceMapComments: true,
    });
  }

  const runcostRoot = dirname(rootRequire.resolve("runcost/browser"));
  const runcostPackage = join(runcostRoot, "package.json");
  const runcost = await pinnedPackage("runcost", runcostPackage);
  for (const relativePath of ["browser.js", "package.json"]) {
    await copyRegularFile(
      join(runcostRoot, relativePath),
      join(appRoot, "node_modules", "runcost", relativePath),
    );
  }

  return [
    ...workspaceRuntimePackages.map(({ license, name, version }) => ({
      license,
      name,
      version,
    })),
    ajv,
    ...transitive,
    runcost,
  ]
    .map((component) => Object.freeze(component))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function xmlString(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function infoPlist(centralService, {
  bundleVersion,
  distribution,
  iconIncluded,
  productBrand,
  publicWebsiteOrigin = DEPLOYMENT_ENDPOINTS.public.origin,
  releaseChannelName,
  updater,
}) {
  const publicWebsiteConfiguration = `  <key>UsageMonitorPublicWebsiteOrigin</key>
  <string>${xmlString(publicWebsiteOrigin)}</string>
`;
  const centralServiceConfiguration = centralService.configured
    ? `  <key>UsageMonitorCentralOrigin</key>
  <string>${xmlString(centralService.origin)}</string>
  <key>UsageMonitorCentralOriginMode</key>
  <string>${xmlString(centralService.mode)}</string>
`
    : "";
  const iconConfiguration = iconIncluded
    ? `  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
`
    : "";
  const updaterConfiguration = updater.enabled
    ? `  <key>SUEnableAutomaticChecks</key>
  <${updater.automaticChecks ? "true" : "false"}/>
  <key>SUAllowsAutomaticUpdates</key>
  <${updater.allowsAutomaticUpdateOptIn ? "true" : "false"}/>
  <key>SUAutomaticallyUpdate</key>
  <${updater.automaticUpdatesEnabledByDefault ? "true" : "false"}/>
  <key>SUFeedURL</key>
  <string>${xmlString(updater.appcastURL)}</string>
  <key>SUPublicEDKey</key>
  <string>${xmlString(updater.publicEdKey)}</string>
  <key>SURequireSignedFeed</key>
  <true/>
  <key>SUVerifyUpdateBeforeExtraction</key>
  <true/>
  <key>UsageMonitorUpdaterEnabled</key>
  <true/>
  <key>UsageMonitorUpdaterFrameworkVersion</key>
  <string>${SPARKLE_VERSION}</string>
`
    : `  <key>UsageMonitorUpdaterEnabled</key>
  <false/>
`;
  const distributionConfiguration = `  <key>UsageMonitorBuildChannel</key>
  <string>${xmlString(distribution.channel)}</string>
  <key>UsageMonitorReleaseChannel</key>
  <string>${xmlString(releaseChannelName)}</string>
  <key>UsageMonitorPreviewDistribution</key>
  <${distribution.previewDistribution ? "true" : "false"}/>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${xmlString(productBrand.displayName)}</string>
  <key>CFBundleExecutable</key>
  <string>${xmlString(productBrand.executableName)}</string>
  <key>CFBundleIdentifier</key>
  <string>${xmlString(productBrand.bundleIdentifier)}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${xmlString(productBrand.displayName)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${SHORT_VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${xmlString(bundleVersion)}</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeRole</key>
      <string>Viewer</string>
      <key>CFBundleURLName</key>
      <string>${xmlString(
        `${productBrand.bundleIdentifier}.${productBrand.appOpenHost}`,
      )}</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>${xmlString(productBrand.appOpenScheme)}</string>
      </array>
    </dict>
  </array>
  <key>UsageMonitorAppOpenHost</key>
  <string>${xmlString(productBrand.appOpenHost)}</string>
  <key>UsageMonitorAppOpenScheme</key>
  <string>${xmlString(productBrand.appOpenScheme)}</string>
  <key>UsageMonitorAppOpenURL</key>
  <string>${xmlString(productBrand.appOpenURL)}</string>
  <key>UsageMonitorBundleName</key>
  <string>${xmlString(productBrand.bundleName)}</string>
  <key>UsageMonitorMonitoredAppBundleIdentifier</key>
  <string>${xmlString(productBrand.monitoredAppBundleIdentifier)}</string>
  <key>UsageMonitorMonitoredAppDisplayName</key>
  <string>${xmlString(productBrand.monitoredAppDisplayName)}</string>
  <key>UsageMonitorNodeRuntimeMode</key>
  <string>standard</string>
  <key>UsageMonitorStateDirectoryName</key>
  <string>${xmlString(productBrand.stateDirectoryName)}</string>
  <key>UsageMonitorKeychainNamespace</key>
  <string>${xmlString(productBrand.keychainNamespace)}</string>
  <key>UsageMonitorKeychainAccount</key>
  <string>${xmlString(productBrand.keychainAccount)}</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.utilities</string>
  <key>LSMinimumSystemVersion</key>
  <string>${MINIMUM_MACOS_VERSION}</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
  <key>NSHighResolutionCapable</key>
  <true/>
${iconConfiguration}
${publicWebsiteConfiguration}
${centralServiceConfiguration}
${updaterConfiguration}
${distributionConfiguration}
</dict>
</plist>
`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      fail(`${basename(command)} is unavailable at ${command}`);
    }
    fail(`${basename(command)} could not be executed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `${basename(command)} failed: ${
        (result.stderr || result.stdout || "unknown failure").trim()
      }`,
    );
  }
  return result.stdout.trim();
}

function macOSFinderDate(timestampSeconds, label) {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    fail(`${label} must be a non-negative integer timestamp`);
  }
  const date = new Date(timestampSeconds * 1_000);
  if (!Number.isFinite(date.getTime())
      || date.getUTCFullYear() < 1904
      || date.getUTCFullYear() > 9999) {
    fail(`${label} is outside the supported macOS file-date range`);
  }
  const pad = (value) => String(value).padStart(2, "0");
  return [
    `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${date.getUTCFullYear()}`,
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`,
  ].join(" ");
}

/**
 * Read the source commit's timestamp for external builds. The commit is
 * already authenticated by the release-core preflight; reading it here keeps
 * Finder metadata tied to that same immutable source revision without adding
 * a wall-clock input or changing the public build manifest.
 */
export function readMacOSReleaseSourceTimestamp(source) {
  if (!source || typeof source !== "object"
      || typeof source.commit !== "string"
      || !/^[0-9a-f]{40,64}$/u.test(source.commit)) {
    fail(
      "Release source commit is required for Finder metadata",
      "MACOS_RELEASE_SOURCE_INVALID",
    );
  }
  const output = run(GIT_PATH, [
    "-C",
    REPOSITORY_ROOT,
    "show",
    "-s",
    "--format=%ct",
    `${source.commit}^{commit}`,
  ], { env: MACOS_TOOL_ENV });
  if (!/^\d+$/u.test(output)) {
    fail(
      "Release source commit timestamp is invalid",
      "MACOS_RELEASE_SOURCE_TIMESTAMP_INVALID",
    );
  }
  const timestampSeconds = Number(output);
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    fail(
      "Release source commit timestamp is outside the supported range",
      "MACOS_RELEASE_SOURCE_TIMESTAMP_INVALID",
    );
  }
  return timestampSeconds;
}

/**
 * Set only the outer bundle directory's Finder birth/modify dates. Payload
 * files retain the fixed normalization above; this filesystem metadata is not
 * part of the signed or inventoried payload bytes.
 */
export function setMacOSBundleFinderMetadata(path, {
  birthTimeSeconds,
  modificationTimeSeconds = birthTimeSeconds,
  commandRunner = run,
} = {}) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    fail("macOS bundle path is invalid for Finder metadata");
  }
  const birthDate = macOSFinderDate(birthTimeSeconds, "Finder birth time");
  const modificationDate = macOSFinderDate(
    modificationTimeSeconds,
    "Finder modification time",
  );
  commandRunner(SET_FILE_PATH, [
    "-d",
    birthDate,
    "-m",
    modificationDate,
    path,
  ], { env: MACOS_TOOL_ENV });
  return Object.freeze({
    birthTimeSeconds,
    modificationTimeSeconds,
  });
}

function assertBuildPlatform() {
  if (process.platform !== "darwin"
      || process.arch !== PINNED_NODE_ARCHITECTURE) {
    fail("The macOS app currently builds only on macOS arm64");
  }
  if (process.version !== PINNED_NODE_VERSION) {
    fail(
      `Build requires pinned Node ${PINNED_NODE_VERSION}; found ${process.version}`,
    );
  }
}

export function normalizeMacOSBuildArchitecture(value = PINNED_NODE_ARCHITECTURE) {
  if (value === "arm64" || value === "x64") return value;
  fail(
    "macOS target architecture must be arm64 or x64",
    "MACOS_BUILD_ARCHITECTURE_INVALID",
  );
}

function assertMacOSBuildArchitectureConfiguration({
  architecture = PINNED_NODE_ARCHITECTURE,
  nodeRuntime = null,
  externalDistribution = false,
  previewDistribution = false,
} = {}) {
  const selected = normalizeMacOSBuildArchitecture(architecture);
  if (selected === "arm64" && nodeRuntime !== null) {
    fail(
      "Apple Silicon builds must use the pinned builder's Node runtime",
      "MACOS_NODE_RUNTIME_OVERRIDE_FORBIDDEN",
    );
  }
  if (selected === "x64" && (typeof nodeRuntime !== "string"
      || nodeRuntime.length === 0 || nodeRuntime.includes("\0"))) {
    fail(
      "Intel builds require --node-runtime with the pinned official Intel Node executable",
      "MACOS_INTEL_NODE_RUNTIME_REQUIRED",
    );
  }
  return selected;
}

function machOArchitecture(architecture) {
  return architecture === "x64" ? "x86_64" : "arm64";
}

export function assertMacOSMachOArchitecture(bytes, architecture) {
  const selected = normalizeMacOSBuildArchitecture(architecture);
  const cpuType = selected === "x64" ? 0x01000007 : 0x0100000c;
  if (!Buffer.isBuffer(bytes) || bytes.length < 32
      || bytes.readUInt32LE(0) !== 0xfeedfacf
      || bytes.readUInt32LE(4) !== cpuType) {
    fail(
      "Bundle executable is not a thin Mach-O for the selected architecture",
      "MACOS_BUNDLE_ARCHITECTURE_MISMATCH",
    );
  }
}

export async function assertMacOSBundleArchitecture(appPath, {
  architecture = "arm64", updaterEnabled = false, helperRequired = true,
} = {}) {
  normalizeMacOSBuildArchitecture(architecture);
  const files = [
    SIGNED_EXECUTABLE_PATH,
    "Contents/Resources/runtime/bin/node",
    ...(helperRequired ? [MACOS_KEYCHAIN_MIGRATION_HELPER.executable] : []),
    ...(updaterEnabled ? SPARKLE_MACH_O_PATHS.map((path) =>
      `${SPARKLE_FRAMEWORK_PREFIX}/${path}`) : []),
  ];
  for (const path of files) {
    const file = await open(join(appPath, ...path.split("/")),
      fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) {
        fail("Bundle executable must be a regular file", "MACOS_BUNDLE_ARCHITECTURE_MISMATCH");
      }
      const header = Buffer.alloc(32);
      const { bytesRead } = await file.read(header, 0, 32, 0);
      assertMacOSMachOArchitecture(header.subarray(0, bytesRead), architecture);
    } finally {
      await file.close();
    }
  }
}

function previewStagingRootForArchitecture(architecture) {
  return architecture === "x64"
    ? join(REPOSITORY_ROOT, ".release-build", "macos-preview", "intel", "current")
    : DEFAULT_PREVIEW_STAGING_ROOT;
}

// Inspect input bytes without executing them. The copied runtime is checked
// again before a bounded version/architecture probe in the private build tree.
export async function validateMacOSNodeRuntimeInput({
  architecture = PINNED_NODE_ARCHITECTURE,
  nodeRuntime = null,
} = {}) {
  const selected = assertMacOSBuildArchitectureConfiguration({
    architecture,
    nodeRuntime,
  });
  let executable;
  let license;
  let executableSha256;
  let licenseSha256;
  try {
    const requested = resolve(nodeRuntime ?? process.execPath);
    executable = await realpath(requested);
    license = resolve(dirname(executable), "..", "LICENSE");
    for (const [path, maximumBytes] of [
      [executable, MAXIMUM_BUNDLE_BYTES], [license, 1024 * 1024],
    ]) {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()
          || metadata.nlink !== 1 || metadata.size > maximumBytes) {
        throw new Error("not a regular unlinked input");
      }
    }
    if (selected === "x64" && executable !== requested) {
      throw new Error("Intel runtime must not traverse a symbolic link");
    }
    [executableSha256, licenseSha256] = await Promise.all([
      sha256File(executable),
      sha256File(license),
    ]);
  } catch {
    fail(
      "Selected Node runtime and license must be readable regular files",
      "MACOS_NODE_RUNTIME_INPUT_INVALID",
    );
  }
  if (selected === "x64" && (executableSha256 !== PINNED_INTEL_NODE_SHA256
      || licenseSha256 !== PINNED_INTEL_NODE_LICENSE_SHA256)) {
    fail(
      "Intel Node runtime or license does not match the pinned official Node 26.2.0 bytes",
      "MACOS_NODE_RUNTIME_DIGEST_MISMATCH",
    );
  }
  return Object.freeze({
    architecture: selected,
    executable,
    executableSha256,
    license,
    licenseSha256,
  });
}

export function normalizeMacOSBuildProfile(value = MACOS_BUILD_PROFILE_RELEASE) {
  if (value === MACOS_BUILD_PROFILE_RELEASE
      || value === MACOS_BUILD_PROFILE_TEST) {
    return value;
  }
  fail(
    `Unsupported macOS build profile: ${value}`,
    "MACOS_BUILD_PROFILE_INVALID",
  );
}

function testCompilerModuleCachePath(sdk, toolchainVersion, architecture) {
  const cacheKey = createHash("sha256")
    .update([
      process.version,
      process.arch,
      architecture,
      sdk,
      toolchainVersion,
      MINIMUM_MACOS_VERSION,
      MACOS_BUILD_PROFILE_TEST,
    ].join("\0"))
    .digest("hex")
    .slice(0, 24);
  return join(
    tmpdir(),
    "app-usagemonitor-macos-test-swift-module-cache",
    cacheKey,
  );
}

async function prepareTestCompilerModuleCache(sdk, toolchainVersion, architecture) {
  const moduleCache = testCompilerModuleCachePath(sdk, toolchainVersion, architecture);
  await mkdir(moduleCache, { recursive: true, mode: 0o700 });
  const metadata = await lstat(moduleCache);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("Test compiler module cache is not a private regular directory");
  }
  await chmod(moduleCache, 0o700);
  return moduleCache;
}

function signApplicationBundle(appBundle) {
  run(CODESIGN_PATH, [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--timestamp=none",
    appBundle,
  ]);
  run(CODESIGN_PATH, [
    "--verify",
    "--deep",
    "--strict",
    appBundle,
  ]);
}

function preSignLauncherForInventory(appBundle) {
  run(CODESIGN_PATH, [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    join(appBundle, ...SIGNED_EXECUTABLE_PATH.split("/")),
  ]);
}

function preSignKeychainMigrationHelperForInventory(appBundle) {
  run(CODESIGN_PATH, [
    "--force",
    "--sign",
    "-",
    "--identifier",
    MACOS_KEYCHAIN_MIGRATION_HELPER.signingIdentifier,
    "--options",
    "runtime",
    "--timestamp=none",
    join(appBundle, ...MACOS_KEYCHAIN_MIGRATION_HELPER.executable.split("/")),
  ]);
}

async function compileNativeExecutable(destination, updater, swiftSources, {
  architecture = PINNED_NODE_ARCHITECTURE,
  buildProfile = MACOS_BUILD_PROFILE_RELEASE,
  migrationHelper = false,
} = {}) {
  const selectedBuildProfile = normalizeMacOSBuildProfile(buildProfile);
  const sdk = run("/usr/bin/xcrun", [
    "--sdk",
    "macosx",
    "--show-sdk-path",
  ], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  const compilerScratch = await mkdtemp(join(
    dirname(destination),
    ".usage-monitor-swift-build-",
  ));
  const moduleCache = selectedBuildProfile === MACOS_BUILD_PROFILE_TEST
    ? await prepareTestCompilerModuleCache(
      sdk,
      run("/usr/bin/xcrun", ["--sdk", "macosx", "swiftc", "--version"], {
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      }),
      architecture,
    )
    : compilerScratch;
  const compileEnvironment = {
    CLANG_MODULE_CACHE_PATH: moduleCache,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SDKROOT: sdk,
    SOURCE_DATE_EPOCH: String(FIXED_EPOCH_SECONDS),
    SWIFT_MODULE_CACHE_PATH: moduleCache,
    TMPDIR: compilerScratch,
    ZERO_AR_DATE: "1",
  };
  const arguments_ = [
    "--sdk",
    "macosx",
    "swiftc",
    "-swift-version",
    "5",
    "-parse-as-library",
    ...(selectedBuildProfile === MACOS_BUILD_PROFILE_TEST
      ? ["-Onone"]
      : ["-O", "-whole-module-optimization"]),
    "-target",
    `${machOArchitecture(architecture)}-apple-macos${MINIMUM_MACOS_VERSION}`,
    "-sdk",
    sdk,
    "-module-name",
    migrationHelper
      ? "TiboTattleKeychainMigration"
      : `${PRODUCT_BRAND.executableName}Launcher`,
    "-module-cache-path",
    moduleCache,
    // Darwin exposes audit_token_to_pid/euid declarations, but their
    // implementations live in libbsm. Both peers authenticate the IPC audit
    // token, so both the launcher and helper must link this system library.
    "-lbsm",
    // The migration helper has no UI, updater, JIT, or separately bundled
    // runtime. Only the foreground launcher needs the system UI/lifecycle
    // frameworks. Both use Security through reviewed native APIs.
    ...(migrationHelper
      ? ["-framework", "Foundation", "-framework", "Security"]
      : [
        "-framework",
        "AppKit",
        "-framework",
        "Foundation",
        // Login-at-login registration uses the system ServiceManagement API.
        "-framework",
        "ServiceManagement",
        // Native alerts add no separately bundled networking dependency.
        "-framework",
        "UserNotifications",
        // The foreground dashboard remains pinned to the loopback companion.
        "-framework",
        "WebKit",
      ]),
  ];
  if (updater.enabled) {
    arguments_.push(
      "-F",
      dirname(updater.framework.path),
      "-framework",
      "Sparkle",
      "-Xlinker",
      "-rpath",
      "-Xlinker",
      "@executable_path/../Frameworks",
    );
  }
  arguments_.push(
    "-o",
    destination,
    ...swiftSources.files,
  );
  try {
    run("/usr/bin/xcrun", arguments_, { env: compileEnvironment });
  } finally {
    await rm(compilerScratch, { recursive: true, force: true });
  }
  await chmod(destination, 0o555);
  await utimes(destination, FIXED_EPOCH_SECONDS, FIXED_EPOCH_SECONDS);
  const fileDescription = run("/usr/bin/file", ["-b", destination]);
  if (!fileDescription.includes(`Mach-O 64-bit executable ${machOArchitecture(architecture)}`)) {
    fail("Native application code does not match the selected macOS architecture");
  }
}

async function copyPinnedSparkleFramework(contents, updater, architecture) {
  if (!updater.enabled) return null;
  const destination = join(contents, "Frameworks", "Sparkle.framework");
  for (const entry of updater.framework.entries) {
    const output = join(destination, ...entry.path.split("/"));
    await mkdir(dirname(output), { recursive: true, mode: 0o755 });
    if (entry.type === "link") {
      await symlink(entry.data, output);
      continue;
    }
    await copyRegularFile(
      join(updater.framework.path, ...entry.path.split("/")),
      output,
      Number.parseInt(entry.mode, 8),
    );
  }
  for (const relativePath of SPARKLE_MACH_O_PATHS) {
    const executable = join(destination, ...relativePath.split("/"));
    const replacement = `${executable}.${machOArchitecture(architecture)}`;
    run("/usr/bin/lipo", [
      executable,
      "-thin",
      machOArchitecture(architecture),
      "-output",
      replacement,
    ], {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    const metadata = await lstat(executable);
    await chmod(replacement, metadata.mode & 0o777);
    await utimes(replacement, FIXED_EPOCH_SECONDS, FIXED_EPOCH_SECONDS);
    await rm(executable);
    await rename(replacement, executable);
  }
  return destination;
}

async function copyPinnedNode(resourcesRoot, runtimeInput) {
  const destination = join(resourcesRoot, "runtime", "bin", "node");
  const licenseDestination = join(resourcesRoot, "licenses", "node-26.2.0.txt");
  await copyRegularFile(runtimeInput.executable, destination, 0o555);
  await copyRegularFile(
    runtimeInput.license,
    licenseDestination,
    0o444,
  );
  const [runtimeSha256, licenseSha256] = await Promise.all([
    sha256File(destination),
    sha256File(licenseDestination),
  ]);
  if (runtimeSha256 !== runtimeInput.executableSha256
      || licenseSha256 !== runtimeInput.licenseSha256) {
    fail("Selected Node input changed during staging", "MACOS_NODE_RUNTIME_INPUT_CHANGED");
  }
  const runtimeIdentity = run(destination, [
    "-p", "JSON.stringify([process.version, process.platform, process.arch])",
  ], {
    cwd: resourcesRoot,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  if (runtimeIdentity !== JSON.stringify([
    PINNED_NODE_VERSION, "darwin", runtimeInput.architecture,
  ])) {
    fail(
      "The selected Node executable does not match the pinned version and target architecture",
      "MACOS_NODE_RUNTIME_IDENTITY_MISMATCH",
    );
  }
  return Object.freeze({
    architecture: runtimeInput.architecture,
    executable: "Contents/Resources/runtime/bin/node",
    sha256: runtimeSha256,
    version: PINNED_NODE_VERSION.slice(1),
  });
}

async function copyFirstPartyRuntime(appRoot, graph, runtimeAssets, webModules) {
  const repositoryPackage = await readPackage(
    join(REPOSITORY_ROOT, "package.json"),
  );
  if (
    repositoryPackage.name !== PACKAGE_NAME
    || repositoryPackage.version !== SHORT_VERSION
    || repositoryPackage.type !== "module"
  ) {
    fail("Repository package identity does not match the macOS runtime contract");
  }
  for (const source of graph.files) {
    const selected = repositoryRelative(source);
    if (selected === "package.json") continue;
    await copyRegularFile(
      source,
      join(appRoot, ...selected.split("/")),
      0o444,
    );
  }
  await stageMacOSWebModules(appRoot, webModules);
  const webModuleFiles = new Set(
    webModules.modules.map(({ relativeFile }) => relativeFile),
  );
  for (const selected of runtimeAssets) {
    if (graph.relativeFiles.includes(selected) || webModuleFiles.has(selected)) {
      continue;
    }
    assertAllowedFirstPartyPath(join(REPOSITORY_ROOT, selected));
    const sourcePath = join(REPOSITORY_ROOT, ...selected.split("/"));
    const destinationPath = join(appRoot, ...selected.split("/"));
    if (selected === "apps/web/public/index.html") {
      const source = await readFile(sourcePath, "utf8");
      if (source.split(RELEASE_VERSION_PLACEHOLDER).length !== 2) {
        fail("Dashboard HTML must contain exactly one release-version placeholder");
      }
      await writeGeneratedFile(
        destinationPath,
        source.replace(RELEASE_VERSION_PLACEHOLDER, RELEASE_VERSION),
      );
    } else {
      await copyRegularFile(sourcePath, destinationPath, 0o444);
    }
  }
  await writeGeneratedFile(
    join(appRoot, "package.json"),
    stableJson({
      name: repositoryPackage.name,
      version: repositoryPackage.version,
      private: true,
      type: repositoryPackage.type,
      engines: { node: PINNED_NODE_VERSION },
    }),
  );
}

/**
 * Stage AppKit's `.lproj` resources at the bundle root and mirror them under
 * the loopback dashboard root. The mirror is deliberately derived from the
 * same reviewed files, so a future dashboard localizer cannot drift to a
 * second English catalog.
 */
export async function stageMacOSLocalizationResources(
  contents,
  appRoot,
  resources,
) {
  if (resources === null
      || typeof resources !== "object"
      || !Array.isArray(resources.files)
      || !Array.isArray(resources.relativeFiles)
      || resources.files.length !== resources.relativeFiles.length
      || typeof resources.root !== "string") {
    fail("macOS localization resource capture is invalid");
  }
  const staged = [];
  for (let index = 0; index < resources.files.length; index += 1) {
    const source = resources.files[index];
    const relativeFile = resources.relativeFiles[index];
    const expectedRelative = reviewedRelative(
      resources.root,
      source,
      "macOS localization resource",
    );
    if (expectedRelative !== relativeFile) {
      fail(`macOS localization resource capture is inconsistent: ${relativeFile}`);
    }
    const nativeDestination = join(
      contents,
      "Resources",
      ...relativeFile.split("/"),
    );
    const webRelativeFile = relativeFile.startsWith("localization/")
      ? relativeFile
      : join("localization", relativeFile).split(sep).join("/");
    const webDestination = join(
      appRoot,
      ...webRelativeFile.split("/"),
    );
    await copyRegularFile(source, nativeDestination);
    await copyRegularFile(source, webDestination);
    staged.push(Object.freeze({
      relativeFile,
      webRelativeFile,
    }));
  }
  return Object.freeze(staged);
}

/**
 * Stage the immutable source records retained by web-module discovery.
 *
 * Keeping this operation narrow and exported lets release tests prove that a
 * source-tree mutation after verification cannot change the bytes shipped in
 * the native application.
 */
export async function stageMacOSWebModules(appRoot, webModules) {
  if (webModules === null || typeof webModules !== "object"
      || !Array.isArray(webModules.modules)) {
    fail("Reviewed macOS web module graph is invalid");
  }
  const staged = [];
  const seen = new Set();
  for (const module of webModules.modules) {
    if (module === null || typeof module !== "object"
        || typeof module.relativeFile !== "string"
        || typeof module.sourceText !== "string"
        || typeof module.sha256 !== "string"
        || !Number.isSafeInteger(module.byteLength)
        || module.byteLength < 0) {
      fail("Captured macOS web module record is invalid");
    }
    const destination = resolveReviewedInput(
      appRoot,
      module.relativeFile,
      "captured macOS web module",
    );
    if (seen.has(module.relativeFile)) {
      fail(`Duplicate captured macOS web module: ${module.relativeFile}`);
    }
    seen.add(module.relativeFile);
    const sha256 = createHash("sha256")
      .update(module.sourceText, "utf8")
      .digest("hex");
    const byteLength = Buffer.byteLength(module.sourceText, "utf8");
    if (module.sha256 !== sha256 || module.byteLength !== byteLength) {
      fail(`Captured macOS web module record is inconsistent: ${module.relativeFile}`);
    }
    await writeGeneratedFile(destination, module.sourceText, 0o444);
    staged.push(Object.freeze({
      relativeFile: module.relativeFile,
      byteLength,
      sha256,
    }));
  }
  return Object.freeze(staged);
}

export function assertMacOSWebModuleInventory(inventory, webModules) {
  if (!Array.isArray(inventory)
      || webModules === null
      || typeof webModules !== "object"
      || !Array.isArray(webModules.modules)) {
    fail("macOS web module inventory inputs are invalid");
  }
  for (const module of webModules.modules) {
    const expectedPath = [
      "Contents",
      "Resources",
      "app",
      module.relativeFile,
    ].join("/");
    const rows = inventory.filter(({ path }) => path === expectedPath);
    if (rows.length !== 1
        || rows[0].bytes !== module.byteLength
        || rows[0].sha256 !== module.sha256) {
      fail(`macOS bundle did not retain captured web module bytes: ${module.relativeFile}`);
    }
  }
  return true;
}

async function copyLicenses(resourcesRoot, updater) {
  const rootRequire = createRequire(join(REPOSITORY_ROOT, "package.json"));
  const packageLicenses = [
    ["ajv", rootRequire.resolve("ajv/package.json")],
  ];
  const ajvRequire = createRequire(packageLicenses[0][1]);
  for (const name of [
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "require-from-string",
  ]) {
    packageLicenses.push([name, ajvRequire.resolve(`${name}/package.json`)]);
  }
  for (const [outputName, packagePath] of packageLicenses) {
    const root = dirname(packagePath);
    const candidates = (await readdir(root))
      .filter((name) => /^licen[sc]e(?:\.|$)/iu.test(name))
      .sort();
    if (candidates.length !== 1) {
      fail(`Expected one license file for ${outputName}`);
    }
    const version = (await readPackage(packagePath)).version;
    await copyRegularFile(
      join(root, candidates[0]),
      join(resourcesRoot, "licenses", `${outputName}-${version}.txt`),
    );
  }
  await copyRegularFile(
    join(REPOSITORY_ROOT, "third_party_licenses", "runcost-0.2.0.txt"),
    join(resourcesRoot, "licenses", "runcost-0.2.0.txt"),
  );
  if (updater.enabled) {
    await copyRegularFile(
      join(
        REPOSITORY_ROOT,
        "third_party_licenses",
        `sparkle-${SPARKLE_VERSION}.txt`,
      ),
      join(
        resourcesRoot,
        "licenses",
        `sparkle-${SPARKLE_VERSION}.txt`,
      ),
    );
  }
  await writeGeneratedFile(
    join(resourcesRoot, "licenses", "app-usagemonitor-private-poc.txt"),
    `${PRODUCT_BRAND.displayName} is a private proof of concept. No public source-code license is granted by this bundle.\n`,
  );
}

async function readOptionalRegularFile(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`Release asset must be a regular file: ${repositoryRelative(path)}`);
  }
  return Object.freeze({
    bytes: await readFile(path),
    path,
  });
}

async function loadIconAssets({ required }) {
  const icon = await readOptionalRegularFile(ICON_ASSET);
  const provenance = await readOptionalRegularFile(ICON_PROVENANCE);
  if (!icon && !provenance) {
    if (required) {
      fail(
        "External distribution requires approved AppIcon.icns and AppIcon.provenance.txt assets",
        "MACOS_ICON_ASSET_REQUIRED",
      );
    }
    return null;
  }
  if (!icon || !provenance) {
    fail(
      "AppIcon.icns and AppIcon.provenance.txt must be supplied together",
      "MACOS_ICON_PROVENANCE_REQUIRED",
    );
  }
  if (icon.bytes.length < 1_024 || icon.bytes.length > 10 * 1024 * 1024) {
    fail("AppIcon.icns has an implausible size");
  }
  const description = run("/usr/bin/file", ["-b", icon.path]);
  if (!/Apple Icon Image format|Mac OS X icon/iu.test(description)) {
    fail("AppIcon.icns is not a valid Apple icon container");
  }
  if (provenance.bytes.length > 64 * 1024) {
    fail("App icon provenance is too large");
  }
  const provenanceText = provenance.bytes.toString("utf8").trim();
  if (provenanceText.length < 40
      || /\b(?:todo|tbd|unknown|replace me|placeholder)\b/iu
        .test(provenanceText)
      || !/^Source:/mu.test(provenanceText)
      || !/^Rights:/mu.test(provenanceText)
      || !/^License:/mu.test(provenanceText)) {
    fail(
      "App icon provenance must record non-placeholder Source, Rights, and License fields",
      "MACOS_ICON_PROVENANCE_INVALID",
    );
  }
  return Object.freeze({
    icon,
    provenance,
    provenanceText: `${provenanceText}\n`,
  });
}

export async function calculateMacOSSourceInputDigest({
  graph,
  runtimeAssets,
  swiftSources,
  keychainMigrationHelperSources = null,
  localizationResources = null,
  iconAssets = null,
  updater = null,
  webModules = null,
  workspaceRuntimePackages = [],
  readSource = readFile,
} = {}) {
  if (typeof readSource !== "function") {
    fail("readSource must be a function when provided");
  }
  const localizationFiles = localizationResources?.files ?? [];
  if (!Array.isArray(localizationFiles)) {
    fail("macOS localization resource capture is invalid");
  }
  const inputs = new Set([
    ...graph.files,
    ...runtimeAssets.map((path) =>
      join(REPOSITORY_ROOT, ...path.split("/"))),
    PRODUCT_BRAND_CONFIG,
    RELEASE_MANIFEST_CONFIG,
    PACKAGE_MANIFEST,
    CAPTURED_UTF8_SOURCE_HELPER,
    RUNTIME_CLOSURE_HELPER,
    SCRIPT_FILE,
    ...swiftSources.files,
    ...(keychainMigrationHelperSources?.files ?? []),
    ...localizationFiles,
    ...(iconAssets
      ? [iconAssets.icon.path, iconAssets.provenance.path]
      : []),
  ]);
  const hash = createHash("sha256");
  const capturedWebModules = new Map((webModules?.modules ?? []).map(
    (module) => [module.file, module],
  ));
  if (workspaceRuntimePackages.length > 0) {
    validateCapturedWorkspaceRuntimePackages(workspaceRuntimePackages);
  }
  const sourceInputs = new Map();
  for (const file of inputs) {
    const inputPath = repositoryRelative(file);
    const captured = capturedWebModules.get(file);
    sourceInputs.set(inputPath, captured === undefined
      ? Object.freeze({ file })
      : Object.freeze({ sourceText: captured.sourceText }));
  }
  for (const packageCapture of workspaceRuntimePackages) {
    for (const file of packageCapture.files) {
      if (sourceInputs.has(file.inputPath)) {
        fail(`Duplicate macOS source input: ${file.inputPath}`);
      }
      sourceInputs.set(file.inputPath, Object.freeze({
        sourceText: file.sourceText,
      }));
    }
  }
  for (const [inputPath, input] of [...sourceInputs.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    hash.update(inputPath);
    hash.update("\0");
    if (typeof input.sourceText === "string") {
      hash.update(input.sourceText, "utf8");
    } else {
      hash.update(await readSource(input.file));
    }
    hash.update("\0");
  }
  if (updater?.enabled) {
    hash.update("sparkle-updater\0");
    hash.update(updater.version);
    hash.update("\0");
    hash.update(updater.framework.sha256);
    hash.update("\0");
    hash.update(updater.appcastURL);
    hash.update("\0");
    hash.update(updater.publicEdKey);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function canonicalizeUnsignedArm64MachO(bytes, label) {
  if (bytes.length < 32
      || bytes.subarray(0, 4).toString("hex") !== "cffaedfe") {
    fail(`Expected a thin 64-bit Mach-O release payload: ${label}`);
  }
  const canonical = Buffer.from(bytes);
  const commandCount = canonical.readUInt32LE(16);
  const commandBytes = canonical.readUInt32LE(20);
  if (commandCount > 1_024
      || 32 + commandBytes > canonical.length) {
    fail(`Mach-O load commands are invalid: ${label}`);
  }
  let offset = 32;
  let linkEditFound = false;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > 32 + commandBytes) {
      fail(`Mach-O load commands are truncated: ${label}`);
    }
    const command = canonical.readUInt32LE(offset);
    const size = canonical.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > 32 + commandBytes) {
      fail(`Mach-O load command size is invalid: ${label}`);
    }
    if (command === 0x19 && size >= 72) {
      const segment = canonical.subarray(offset + 8, offset + 24)
        .toString("ascii")
        .replace(/\0.*$/u, "");
      if (segment === "__LINKEDIT") {
        if (linkEditFound) {
          fail(`Mach-O contains duplicate __LINKEDIT segments: ${label}`);
        }
        linkEditFound = true;
        // Code-signature replacement changes only the rounded virtual size
        // (and may change the stored file size) of __LINKEDIT after the
        // signature blob is removed. The remaining bytes and file offset stay
        // inventoried, so zero only those two envelope-dependent fields.
        canonical.writeBigUInt64LE(0n, offset + 32);
        canonical.writeBigUInt64LE(0n, offset + 48);
      }
    }
    offset += size;
  }
  if (!linkEditFound) {
    fail(`Mach-O has no __LINKEDIT segment: ${label}`);
  }
  return canonical;
}

async function normalizedMachOBytes(file) {
  const inspection = spawnSync(CODESIGN_PATH, ["-d", file], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  if (inspection.error) {
    fail(`codesign could not inspect ${basename(file)}: ${
      inspection.error.message
    }`);
  }
  if (inspection.status !== 0) {
    fail(`Expected a signed Mach-O release payload: ${basename(file)}`);
  }

  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-macho-normalize-"),
  );
  const copy = join(temporaryRoot, basename(file));
  try {
    await copyFile(file, copy);
    await chmod(copy, 0o700);
    run(CODESIGN_PATH, ["--remove-signature", copy], {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    return canonicalizeUnsignedArm64MachO(
      await readFile(copy),
      basename(file),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function previewCompatibilityNormalizedMachOPaths(manifest) {
  const files = manifest?.payload?.files;
  if (!Array.isArray(files)) {
    return NO_COMPATIBILITY_NORMALIZED_MACH_O_PATHS;
  }
  const retiredEntries = files.filter((entry) =>
    RETIRED_PREVIEW_NORMALIZED_MACH_O_PATHS.has(entry?.path));
  if (retiredEntries.length === 0) {
    return NO_COMPATIBILITY_NORMALIZED_MACH_O_PATHS;
  }
  if (retiredEntries.length !== RETIRED_PREVIEW_NORMALIZED_MACH_O_PATHS.size
      || retiredEntries.some((entry) =>
        entry.normalization !== "mach_o_without_code_signature")) {
    fail(
      "Preview application uses an invalid retired Mach-O normalization",
      "MACOS_PAYLOAD_INTEGRITY_FAILED",
    );
  }
  return RETIRED_PREVIEW_NORMALIZED_MACH_O_PATHS;
}

async function bundleInventory(
  appBundle,
  manifestPath,
  updater,
  {
    compatibilityNormalizedMachOPaths =
      NO_COMPATIBILITY_NORMALIZED_MACH_O_PATHS,
  } = {},
) {
  const links = [];
  const files = (await walkFiles(appBundle, appBundle, {
    allowPinnedSparkleLinks: updater.enabled,
    links,
  }))
    .filter((path) => {
      if (path === manifestPath) return false;
      const relativePath = relative(appBundle, path).split(sep).join("/");
      // Code signatures are not payload. Developer ID release signing
      // re-signs every nested bundle, so recording signature bytes here
      // would make a correctly signed release fail its own inventory. The
      // signatures are proven instead by codesign --verify --deep --strict
      // and by notarization.
      return !relativePath.split("/").includes("_CodeSignature");
    })
    .sort((left, right) => relative(appBundle, left).localeCompare(
      relative(appBundle, right),
    ));
  const inventory = [];
  const aggregate = createHash("sha256");
  let totalBytes = 0;
  let portableBytes = 0;
  for (const file of files) {
    const path = relative(appBundle, file).split(sep).join("/");
    const metadata = await lstat(file);
    const normalization = NORMALIZED_MACH_O_PATHS.has(path)
        || compatibilityNormalizedMachOPaths.has(path)
      ? "mach_o_without_code_signature"
      : "raw";
    const bytes = normalization === "mach_o_without_code_signature"
      ? await normalizedMachOBytes(file)
      : await readFile(file);
    totalBytes += bytes.length;
    portableBytes += metadata.size;
    aggregate.update(path);
    aggregate.update("\0");
    aggregate.update(bytes);
    aggregate.update("\0");
    inventory.push({
      path,
      bytes: bytes.length,
      mode: (metadata.mode & 0o777).toString(8).padStart(3, "0"),
      normalization,
      sha256: sha256(bytes),
    });
  }
  const expectedLinks = updater.enabled
    ? Object.entries(SPARKLE_FRAMEWORK_LINKS).map(([path, target]) => ({
      path: `${SPARKLE_FRAMEWORK_PREFIX}/${path}`,
      target,
    })).sort((left, right) => left.path.localeCompare(right.path))
    : [];
  links.sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(links) !== JSON.stringify(expectedLinks)) {
    fail("The app bundle does not contain the exact pinned Sparkle link set");
  }
  for (const link of links) {
    aggregate.update(link.path);
    aggregate.update("\0link\0");
    aggregate.update(link.target);
    aggregate.update("\0");
  }
  if (portableBytes > MAXIMUM_BUNDLE_BYTES) {
    fail("The macOS app exceeds its maximum portable bundle size");
  }
  return Object.freeze({
    files: Object.freeze(inventory),
    links: Object.freeze(links),
    payloadSha256: aggregate.digest("hex"),
    totalBytes,
  });
}

async function privacyCheck(appBundle, updater) {
  const files = await walkFiles(appBundle, appBundle, {
    allowPinnedSparkleLinks: updater.enabled,
  });
  const forbiddenFilePatterns = [
    /(?:^|\/)\.git(?:\/|$)/u,
    /(?:^|\/)\.usage-monitor(?:\/|$)/u,
    /(?:^|\/)local-review(?:\/|$)/u,
    /(?:^|\/)(?:credentials?|quarantine|reports?|secrets?|uploads?)(?:\/|$)/iu,
    /\.(?:db|jsonl|log|pem|pfx|sqlite3?|umx)$/iu,
    /\.(?:d\.ts|map)$/iu,
  ];
  for (const file of files) {
    const selected = relative(appBundle, file).split(sep).join("/");
    if (forbiddenFilePatterns.some((pattern) => pattern.test(selected))) {
      fail(`Forbidden private or generated path in app bundle: ${selected}`);
    }
    const generatedMarker = "/app/generated/";
    if (selected.includes(generatedMarker)) {
      const runtimePath = selected.slice(
        selected.indexOf(generatedMarker) + "/app/".length,
      );
      if (!ALLOWED_GENERATED_RUNTIME_FILES.has(runtimePath)) {
        fail(`Unapproved generated file in app bundle: ${runtimePath}`);
      }
    }
    if (!selected.startsWith("Contents/Resources/app/")
        || !/\.(?:html|js|json|css)$/u.test(selected)) continue;
    const text = await readFile(file, "utf8");
    const prohibited = [
      /\/Users\/[^/\s"']+/u,
      /\/(?:private\/)?var\/folders\//u,
      /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    ];
    if (prohibited.some((pattern) => pattern.test(text))) {
      fail(`Private value pattern found in bundled first-party file: ${selected}`);
    }
  }
}

function readMacOSInfoPlist(path) {
  let parsed;
  try {
    parsed = JSON.parse(run("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      path,
    ]));
  } catch {
    fail(
      "Preview application Info.plist is invalid",
      "MACOS_PREVIEW_METADATA_INVALID",
    );
  }
  return parsed;
}

/**
 * Re-check the on-disk preview artifact without requiring release credentials.
 * The validator intentionally accepts only the preview marker and never
 * writes an application or attempts an install into /Applications.
 */
export async function validateMacOSPreviewApp(appPath, { architecture = "arm64" } = {}) {
  normalizeMacOSBuildArchitecture(architecture);
  if (typeof appPath !== "string"
      || appPath.length === 0
      || appPath.includes("\0")) {
    fail(
      "Preview application path must be a non-empty filesystem path",
      "MACOS_PREVIEW_VALIDATION_ARGUMENTS_INVALID",
    );
  }
  const selected = resolve(appPath);
  if (basename(selected) !== PREVIEW_PRODUCT_BRAND.bundleName) {
    fail(
      `Preview application must be named ${PREVIEW_PRODUCT_BRAND.bundleName}`,
      "MACOS_PREVIEW_METADATA_INVALID",
    );
  }
  const metadata = await lstat(selected).catch((error) => {
    if (error.code === "ENOENT") {
      fail("Preview application bundle is unavailable", "MACOS_PREVIEW_NOT_FOUND");
    }
    throw error;
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(
      "Preview application must be a real bundle directory",
      "MACOS_PREVIEW_METADATA_INVALID",
    );
  }
  const resources = join(selected, "Contents", "Resources");
  const manifestPath = join(resources, "build-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    fail(
      "Preview application build manifest is invalid",
      "MACOS_PREVIEW_METADATA_INVALID",
    );
  }
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA
      || manifest.application?.bundleIdentifier
        !== PREVIEW_PRODUCT_BRAND.bundleIdentifier
      || manifest.application?.name !== PREVIEW_PRODUCT_BRAND.displayName
      || manifest.runtime?.stateRoot
        !== `~/Library/Application Support/${PREVIEW_PRODUCT_BRAND.stateDirectoryName}`
      || manifest.runtime?.keychain?.namespace
        !== PREVIEW_PRODUCT_BRAND.keychainNamespace
      || manifest.runtime?.keychain?.account
        !== PREVIEW_PRODUCT_BRAND.keychainAccount) {
    fail(
      "Preview application build manifest has an unexpected identity",
      "MACOS_PREVIEW_METADATA_INVALID",
    );
  }
  // A still-signed older Preview may be inspected for replacement, but any
  // artifact declaring or carrying the new helper must have the complete
  // current contract. Current builders enforce this unconditionally.
  if (manifest.runtime?.keychainMigrationHelper !== undefined
      || manifest.inputs?.keychainMigrationHelperSources !== undefined
      || (Array.isArray(manifest.payload?.files)
        && manifest.payload.files.some((entry) =>
          entry?.path === MACOS_KEYCHAIN_MIGRATION_HELPER.executable))) {
    assertMacOSKeychainMigrationManifest(manifest);
  }
  const release = manifest.release;
  if (manifest.runtime?.node?.architecture !== architecture) {
    fail("Preview runtime architecture does not match the selected target", "MACOS_BUNDLE_ARCHITECTURE_MISMATCH");
  }
  if (release?.channel !== DISTRIBUTION_CHANNEL_PREVIEW
      || release.channelName !== DISTRIBUTION_CHANNEL_PREVIEW
      || release.appOpenScheme !== PREVIEW_PRODUCT_BRAND.appOpenScheme
      || release.appOpenHost !== PREVIEW_PRODUCT_BRAND.appOpenHost
      || release.appOpenURL !== PREVIEW_PRODUCT_BRAND.appOpenURL
      || release.previewDistributionRequested !== true
      || release.externalDistributionRequested !== false
      || release.previewOriginValidated !== true
      || release.productionOriginValidated !== false
      || release.requiresDeveloperIDAndNotarization !== false
      || release.iconIncluded !== true
      || manifest.application.signing !== "ad_hoc_developer_bundle") {
    fail(
      "Preview application is missing its non-production distribution boundary",
      "MACOS_PREVIEW_METADATA_INVALID",
    );
  }
  const plist = readMacOSInfoPlist(join(selected, "Contents", "Info.plist"));
  if (plist.CFBundleIdentifier !== PREVIEW_PRODUCT_BRAND.bundleIdentifier
      || plist.CFBundleDisplayName !== PREVIEW_PRODUCT_BRAND.displayName
      || plist.CFBundleName !== PREVIEW_PRODUCT_BRAND.displayName
      || plist.UsageMonitorBundleName !== PREVIEW_PRODUCT_BRAND.bundleName
      || plist.UsageMonitorAppOpenScheme
        !== PREVIEW_PRODUCT_BRAND.appOpenScheme
      || plist.UsageMonitorAppOpenHost !== PREVIEW_PRODUCT_BRAND.appOpenHost
      || plist.UsageMonitorAppOpenURL !== PREVIEW_PRODUCT_BRAND.appOpenURL
      || plist.UsageMonitorStateDirectoryName
        !== PREVIEW_PRODUCT_BRAND.stateDirectoryName
      || plist.UsageMonitorKeychainNamespace
        !== PREVIEW_PRODUCT_BRAND.keychainNamespace
      || plist.UsageMonitorKeychainAccount
        !== PREVIEW_PRODUCT_BRAND.keychainAccount
      || plist.UsageMonitorPublicWebsiteOrigin
        !== DEPLOYMENT_ENDPOINTS.public.origin
      || plist.UsageMonitorBuildChannel !== DISTRIBUTION_CHANNEL_PREVIEW
      || plist.UsageMonitorReleaseChannel !== DISTRIBUTION_CHANNEL_PREVIEW
      || plist.UsageMonitorPreviewDistribution !== true
      || plist.UsageMonitorCentralOriginMode !== CENTRAL_ORIGIN_MODE_HTTPS
      || plist.UsageMonitorUpdaterEnabled !== true
      || plist.UsageMonitorUpdaterFrameworkVersion !== SPARKLE_VERSION
      || plist.SUEnableAutomaticChecks !== false
      || plist.SUAllowsAutomaticUpdates !== false
      || plist.SUAutomaticallyUpdate !== false
      || plist.SURequireSignedFeed !== true
      || plist.SUVerifyUpdateBeforeExtraction !== true) {
    fail(
      "Preview application Info.plist has an incomplete distribution boundary",
      "MACOS_PREVIEW_METADATA_INVALID",
    );
  }
  const centralService = normalizeMacOSCentralOrigin(
    plist.UsageMonitorCentralOrigin,
  );
  if (centralService.mode !== CENTRAL_ORIGIN_MODE_HTTPS) {
    fail(
      "Preview application is not sealed to a non-loopback HTTPS central origin",
      "MACOS_PREVIEW_ORIGIN_REQUIRED",
    );
  }
  const manifestUpdater = release?.updater;
  if (manifestUpdater === null
      || typeof manifestUpdater !== "object"
      || Array.isArray(manifestUpdater)) {
    fail(
      "Preview application is missing its updater manifest",
      "MACOS_PREVIEW_METADATA_INVALID",
    );
  }
  const updaterMetadata = normalizeMacOSUpdaterMetadata({
    architecture,
    appcastURL: plist.SUFeedURL,
    publicEdKey: plist.SUPublicEDKey,
  });
  if (updaterMetadata.appcastURL === DEPLOYMENT_ENDPOINTS.sparkle.appcastURL) {
    fail(
      "Preview application cannot use the stable Sparkle appcast",
      "MACOS_PREVIEW_STABLE_FEED_FORBIDDEN",
    );
  }
  assertMacOSPreviewAppcastBoundary(updaterMetadata.appcastURL, architecture);
  await assertMacOSBundleArchitecture(selected, {
    architecture, updaterEnabled: true,
    helperRequired: manifest.runtime?.keychainMigrationHelper !== undefined,
  });
  const frameworkPath = join(
    selected,
    ...SPARKLE_FRAMEWORK_PREFIX.split("/"),
  );
  const frameworkMetadata = await lstat(frameworkPath).catch((error) => {
    if (error.code === "ENOENT") {
      fail(
        "Preview application is missing Sparkle.framework",
        "MACOS_UPDATER_CONFIGURATION_INVALID",
      );
    }
    throw error;
  });
  if (!frameworkMetadata.isDirectory() || frameworkMetadata.isSymbolicLink()) {
    fail(
      "Preview application Sparkle.framework must be a real directory",
      "MACOS_UPDATER_CONFIGURATION_INVALID",
    );
  }
  for (const [relativePath, target] of Object.entries(
    SPARKLE_FRAMEWORK_LINKS,
  )) {
    const linkPath = join(frameworkPath, ...relativePath.split("/"));
    const linkMetadata = await lstat(linkPath);
    if (!linkMetadata.isSymbolicLink() || await readlink(linkPath) !== target) {
      fail(
        `Preview application Sparkle.framework has an unexpected link: ${relativePath}`,
        "MACOS_UPDATER_CONFIGURATION_INVALID",
      );
    }
  }
  for (const relativePath of SPARKLE_MACH_O_PATHS) {
    const binaryPath = join(frameworkPath, ...relativePath.split("/"));
    const binaryMetadata = await lstat(binaryPath);
    if (!binaryMetadata.isFile() || binaryMetadata.isSymbolicLink()) {
      fail(
        `Preview application Sparkle.framework is missing ${relativePath}`,
        "MACOS_UPDATER_CONFIGURATION_INVALID",
      );
    }
  }
  const updater = Object.freeze({
    appcastURL: updaterMetadata.appcastURL,
    automaticChecks: false,
    automaticUpdatesEnabledByDefault: false,
    allowsAutomaticUpdateOptIn: false,
    enabled: true,
    framework: Object.freeze({
      sha256: manifestUpdater.frameworkSha256,
      version: SPARKLE_VERSION,
    }),
    publicEdKey: updaterMetadata.publicEdKey,
    version: SPARKLE_VERSION,
  });
  if (manifestUpdater.enabled !== true
      || manifestUpdater.automaticChecks !== updater.automaticChecks
      || manifestUpdater.automaticUpdateOptInAvailable
        !== updater.allowsAutomaticUpdateOptIn
      || manifestUpdater.automaticUpdatesEnabledByDefault
        !== updater.automaticUpdatesEnabledByDefault
      || manifestUpdater.afterUserOptIn?.automaticDownload
        !== updater.allowsAutomaticUpdateOptIn
      || manifestUpdater.afterUserOptIn?.installOnQuit
        !== updater.automaticUpdatesEnabledByDefault
      || manifestUpdater.frameworkVersion !== SPARKLE_VERSION
      || manifestUpdater.frameworkSha256 !== SPARKLE_FRAMEWORK_SHA256
      || manifestUpdater.appcastURL !== updater.appcastURL
      || manifestUpdater.publicEdKeySha256 !== sha256(
        Buffer.from(updater.publicEdKey, "base64"),
      )
      || manifestUpdater.requiresSignedFeed !== true
      || manifestUpdater.verifyBeforeExtraction !== true) {
    fail(
      "Preview application manifest does not match its verified updater inputs",
      "MACOS_PREVIEW_METADATA_INVALID",
    );
  }
  const iconPath = join(selected, "Contents", "Resources", "AppIcon.icns");
  const provenancePath = join(
    selected,
    "Contents",
    "Resources",
    "licenses",
    "app-icon-provenance.txt",
  );
  if (await sha256File(iconPath) !== release.iconSha256
      || await sha256File(provenancePath) !== release.provenanceSha256) {
    fail(
      "Preview application icon or provenance does not match its manifest",
      "MACOS_PREVIEW_METADATA_INVALID",
    );
  }
  await privacyCheck(selected, updater);
  const payload = await bundleInventory(selected, manifestPath, updater, {
    compatibilityNormalizedMachOPaths:
      previewCompatibilityNormalizedMachOPaths(manifest),
  });
  if (stableJson(payload) !== stableJson(manifest.payload)) {
    fail(
      "Preview application payload does not match its build manifest",
      "MACOS_PAYLOAD_INTEGRITY_FAILED",
    );
  }
  run(CODESIGN_PATH, ["--verify", "--deep", "--strict", selected]);
  if (plist.LSMinimumSystemVersion !== "14.0"
      || manifest.application.minimumMacOSVersion !== plist.LSMinimumSystemVersion) {
    fail("Preview minimum macOS version does not match its platform contract", "MACOS_MINIMUM_OS_MISMATCH");
  }
  return Object.freeze({
    appPath: selected,
    architecture,
    minimumMacos: plist.LSMinimumSystemVersion,
    bundleIdentifier: plist.CFBundleIdentifier,
    bundleVersion: plist.CFBundleVersion,
    channel: DISTRIBUTION_CHANNEL_PREVIEW,
    shortVersion: plist.CFBundleShortVersionString,
    updaterEnabled: true,
  });
}

async function verifyExistingBuildTarget(output, productBrand = PRODUCT_BRAND) {
  let metadata;
  try {
    metadata = await lstat(output);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("Refusing to replace a non-directory macOS app target");
  }
  const manifestPath = join(
    output,
    "Contents",
    "Resources",
    "build-manifest.json",
  );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    fail(
      `Refusing to replace an app without a valid ${productBrand.displayName} build marker`,
    );
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA
      || manifest.application?.bundleIdentifier
        !== productBrand.bundleIdentifier) {
    fail("Refusing to replace an app with an unexpected build marker");
  }
  return true;
}

/**
 * A preview produced before named release channels were introduced has the
 * same preview boundary as a current bundle except for the two newly required
 * channel fields.  Replacing it must not turn into an opaque manual cleanup
 * task, but neither may it cause an arbitrary or partially-built bundle to be
 * discarded.  This deliberately recognizes only that exact legacy shape.
 */
async function readReplaceableLegacyPreviewManifest(output) {
  const manifestPath = join(
    output,
    "Contents",
    "Resources",
    "build-manifest.json",
  );
  const plistPath = join(output, "Contents", "Info.plist");
  try {
    const [manifestMetadata, plistMetadata] = await Promise.all([
      lstat(manifestPath),
      lstat(plistPath),
    ]);
    if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()
        || !plistMetadata.isFile() || plistMetadata.isSymbolicLink()) {
      return null;
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const plist = readMacOSInfoPlist(plistPath);
    const release = manifest?.release;
    const updater = release?.updater;
    const legacyManifestBoundary = manifest?.schemaVersion === MANIFEST_SCHEMA
      && manifest.application?.bundleIdentifier
        === PREVIEW_PRODUCT_BRAND.bundleIdentifier
      && manifest.application?.signing === "ad_hoc_developer_bundle"
      && release?.channel === DISTRIBUTION_CHANNEL_PREVIEW
      && release.channelName === undefined
      && release.previewDistributionRequested === true
      && release.externalDistributionRequested === false
      && release.previewOriginValidated === true
      && release.productionOriginValidated === false
      && release.requiresDeveloperIDAndNotarization === false
      && release.iconIncluded === true
      && updater?.enabled === true
      && updater.automaticChecks === false
      && updater.automaticUpdateOptInAvailable === false
      && updater.automaticUpdatesEnabledByDefault === false
      && updater.requiresSignedFeed === true
      && updater.verifyBeforeExtraction === true;
    const legacyPlistBoundary = plist.CFBundleIdentifier
        === PREVIEW_PRODUCT_BRAND.bundleIdentifier
      && plist.CFBundleDisplayName === PREVIEW_PRODUCT_BRAND.displayName
      && plist.CFBundleName === PREVIEW_PRODUCT_BRAND.displayName
      && plist.UsageMonitorBundleName === PREVIEW_PRODUCT_BRAND.bundleName
      && plist.UsageMonitorBuildChannel === DISTRIBUTION_CHANNEL_PREVIEW
      && plist.UsageMonitorReleaseChannel === undefined
      && plist.UsageMonitorPreviewDistribution === true
      && plist.UsageMonitorCentralOriginMode === CENTRAL_ORIGIN_MODE_HTTPS
      && plist.UsageMonitorUpdaterEnabled === true
      && plist.UsageMonitorUpdaterFrameworkVersion === SPARKLE_VERSION
      && plist.SUEnableAutomaticChecks === false
      && plist.SUAllowsAutomaticUpdates === false
      && plist.SUAutomaticallyUpdate === false
      && plist.SURequireSignedFeed === true
      && plist.SUVerifyUpdateBeforeExtraction === true;
    return legacyManifestBoundary && legacyPlistBoundary ? manifest : null;
  } catch {
    return null;
  }
}

async function archiveLegacyPreviewApp(output, manifest) {
  const retiredRoot = join(dirname(output), "retired");
  await mkdir(retiredRoot, { recursive: true, mode: 0o755 });
  if (await realpath(retiredRoot) !== retiredRoot) {
    fail(
      "Preview legacy archive directory must not traverse a symbolic link",
      "MACOS_PREVIEW_METADATA_INVALID",
    );
  }
  const fingerprint = sha256(Buffer.from(stableJson({
    application: manifest.application,
    release: manifest.release,
  }), "utf8")).slice(0, 16);
  const archivePath = join(
    retiredRoot,
    `${PREVIEW_PRODUCT_BRAND.displayName}-legacy-preview-${fingerprint}.app`,
  );
  try {
    await rename(output, archivePath);
  } catch (error) {
    if (error.code === "EEXIST") {
      fail(
        "Refusing to overwrite an archived legacy preview application",
        "MACOS_PREVIEW_METADATA_INVALID",
      );
    }
    throw error;
  }
  return archivePath;
}

export async function assertMacOSExternalBuildOutputIsFresh(output) {
  try {
    await lstat(output);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  fail(
    "External distribution builds require a fresh output app bundle",
    "MACOS_EXTERNAL_OUTPUT_REPLACEMENT_FORBIDDEN",
  );
}

export async function installMacOSExternalBuildOutput(stagedApp, output, {
  finderMetadata = null,
} = {}) {
  // Validate and apply Finder metadata while the bundle is still isolated.
  // If SetFile is unavailable or rejects the staged bundle, no final output
  // path has been claimed yet.
  if (finderMetadata !== null) {
    setMacOSBundleFinderMetadata(stagedApp, finderMetadata);
  }
  try {
    // Claim the final bundle path without replacement. If an output appears
    // after the pre-build check, mkdir fails and the existing target remains.
    await mkdir(output, { mode: 0o755 });
  } catch (error) {
    if (error.code === "EEXIST") {
      fail(
        "External distribution builds require a fresh output app bundle",
        "MACOS_EXTERNAL_OUTPUT_REPLACEMENT_FORBIDDEN",
      );
    }
    throw error;
  }
  try {
    // mkdir above claims the path; set its root metadata before moving any
    // payload entries so a metadata failure cannot expose a final bundle.
    if (finderMetadata !== null) {
      setMacOSBundleFinderMetadata(output, finderMetadata);
    }
    for (const entry of await readdir(stagedApp)) {
      await rename(join(stagedApp, entry), join(output, entry));
    }
    if (finderMetadata !== null) {
      // Moving entries updates the claimed directory's mtime. Restore only
      // that root field after the move; the source-bound SetFile preflight
      // above already established the Finder birth date before installation.
      const modificationTimeSeconds = finderMetadata.modificationTimeSeconds
        ?? finderMetadata.birthTimeSeconds;
      await utimes(
        output,
        modificationTimeSeconds,
        modificationTimeSeconds,
      );
    }
  } catch (error) {
    try {
      await rm(output, { recursive: true, force: false });
    } catch (cleanupError) {
      error.message = `${error.message}; failed to remove incomplete external output: ${cleanupError.message}`;
    }
    throw error;
  }
}

export function validateMacOSPreviewOutputPath(
  output,
  { stagingRoot = DEFAULT_PREVIEW_STAGING_ROOT } = {},
) {
  if (typeof output !== "string"
      || output.length === 0
      || output.includes("\0")) {
    fail(
      "Preview output must be a non-empty filesystem path",
      "MACOS_PREVIEW_OUTPUT_INVALID",
    );
  }
  const selected = resolve(output);
  if (typeof stagingRoot !== "string"
      || stagingRoot.length === 0
      || stagingRoot.includes("\0")) {
    fail(
      "Preview staging root must be a non-empty filesystem path",
      "MACOS_PREVIEW_OUTPUT_INVALID",
    );
  }
  const selectedStagingRoot = resolve(stagingRoot);
  if (selected !== join(
    selectedStagingRoot,
    PREVIEW_PRODUCT_BRAND.bundleName,
  )) {
    fail(
      "Preview builds must use the reviewed staging bundle path",
      "MACOS_PREVIEW_OUTPUT_FORBIDDEN",
    );
  }
  return selected;
}

async function prepareOutput(output, {
  channel,
  previewStagingRoot,
  productBrand,
}) {
  if (basename(output) !== productBrand.bundleName) {
    fail(
      `Output must end with the exact bundle name ${productBrand.bundleName}`,
    );
  }
  const parent = dirname(output);
  await mkdir(parent, { recursive: true, mode: 0o755 });
  const resolvedParent = await realpath(parent);
  if (resolvedParent !== parent) {
    fail("Output parent must not traverse a symbolic link");
  }
  if (channel === DISTRIBUTION_CHANNEL_PREVIEW
      && resolvedParent !== resolve(previewStagingRoot)) {
    fail(
      "Preview output parent must be the reviewed staging root",
      "MACOS_PREVIEW_OUTPUT_FORBIDDEN",
    );
  }
  return parent;
}

export function parseMacOSBuildArguments(argv, environment = process.env) {
  let output = null;
  let architecture = PINNED_NODE_ARCHITECTURE;
  let architectureSeen = false;
  let nodeRuntime = null;
  let centralOrigin = null;
  let centralOriginSeen = false;
  let allowLoopbackCentralOrigin = false;
  let externalDistribution = false;
  let previewDistribution = false;
  let releaseChannel = STABLE_RELEASE_CHANNEL;
  let releaseChannelSeen = false;
  let replacePreviewOutput = false;
  let bundleVersion = BUNDLE_VERSION;
  let bundleVersionSeen = false;
  let sparkleFramework = null;
  let sparkleAppcastURL = null;
  let sparklePublicEdKey = null;
  let validatePreview = false;
  let appPath = null;
  let testBuild = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      if (output !== null || index + 1 >= argv.length) {
        fail("--output must be provided exactly once with a value");
      }
      output = resolve(argv[++index] ?? "");
    } else if (argument === "--architecture") {
      if (architectureSeen || index + 1 >= argv.length) {
        fail("--architecture must be provided at most once with a value");
      }
      architectureSeen = true;
      architecture = normalizeMacOSBuildArchitecture(argv[++index]);
    } else if (argument === "--node-runtime") {
      if (nodeRuntime !== null || index + 1 >= argv.length) {
        fail("--node-runtime must be provided at most once with a value");
      }
      nodeRuntime = argv[++index];
      if (nodeRuntime.length === 0 || nodeRuntime.startsWith("--")
          || nodeRuntime.includes("\0")) {
        fail("--node-runtime requires a file path", "MACOS_NODE_RUNTIME_INPUT_INVALID");
      }
      nodeRuntime = resolve(nodeRuntime);
    } else if (argument === "--central-origin") {
      if (centralOriginSeen || index + 1 >= argv.length) {
        fail("--central-origin must be provided at most once with a value");
      }
      centralOriginSeen = true;
      centralOrigin = argv[++index];
    } else if (argument === "--allow-loopback-central-origin") {
      if (allowLoopbackCentralOrigin) {
        fail("--allow-loopback-central-origin must be provided at most once");
      }
      allowLoopbackCentralOrigin = true;
    } else if (argument === "--external-distribution") {
      if (externalDistribution) {
        fail("--external-distribution must be provided at most once");
      }
      externalDistribution = true;
    } else if (argument === "--preview-distribution") {
      if (previewDistribution) {
        fail("--preview-distribution must be provided at most once");
      }
      previewDistribution = true;
    } else if (argument === "--release-channel") {
      if (releaseChannelSeen || index + 1 >= argv.length) {
        fail("--release-channel must be provided at most once with a value");
      }
      releaseChannelSeen = true;
      releaseChannel = argv[++index];
    } else if (argument === "--replace-preview-output") {
      if (replacePreviewOutput) {
        fail("--replace-preview-output must be provided at most once");
      }
      replacePreviewOutput = true;
    } else if (argument === "--validate-preview") {
      if (validatePreview) {
        fail("--validate-preview must be provided at most once");
      }
      validatePreview = true;
    } else if (argument === "--test-build") {
      if (testBuild) {
        fail("--test-build must be provided at most once");
      }
      testBuild = true;
    } else if (argument === "--app") {
      if (appPath !== null || index + 1 >= argv.length) {
        fail("--app must be provided at most once with a value");
      }
      appPath = resolve(argv[++index] ?? "");
    } else if (argument === "--bundle-version") {
      if (bundleVersionSeen || index + 1 >= argv.length) {
        fail("--bundle-version must be provided at most once with a value");
      }
      bundleVersionSeen = true;
      bundleVersion = normalizeMacOSBundleVersion(argv[++index]);
    } else if (argument === "--sparkle-framework") {
      if (sparkleFramework !== null || index + 1 >= argv.length) {
        fail("--sparkle-framework must be provided at most once with a value");
      }
      sparkleFramework = resolve(argv[++index] ?? "");
    } else if (argument === "--sparkle-appcast-url") {
      if (sparkleAppcastURL !== null || index + 1 >= argv.length) {
        fail("--sparkle-appcast-url must be provided at most once with a value");
      }
      sparkleAppcastURL = argv[++index];
    } else if (argument === "--sparkle-public-ed-key") {
      if (sparklePublicEdKey !== null || index + 1 >= argv.length) {
        fail("--sparkle-public-ed-key must be provided at most once with a value");
      }
      sparklePublicEdKey = argv[++index];
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  if (validatePreview) {
    if (appPath === null
        || output !== null
        || nodeRuntime !== null
        || centralOriginSeen
        || allowLoopbackCentralOrigin
        || externalDistribution
        || previewDistribution
        || releaseChannelSeen
        || replacePreviewOutput
        || testBuild
        || bundleVersionSeen
        || sparkleFramework !== null
        || sparkleAppcastURL !== null
        || sparklePublicEdKey !== null) {
      fail(
        "--validate-preview requires exactly --app <path>",
        "MACOS_PREVIEW_VALIDATION_ARGUMENTS_INVALID",
      );
    }
    return { appPath, validatePreview, ...(architectureSeen ? { architecture } : {}) };
  }
  assertMacOSBuildArchitectureConfiguration({
    architecture, nodeRuntime, externalDistribution, previewDistribution,
  });
  if (appPath !== null) {
    fail("--app is only valid with --validate-preview");
  }
  if (replacePreviewOutput && !previewDistribution) {
    fail("--replace-preview-output requires --preview-distribution");
  }
  if (testBuild && (externalDistribution || previewDistribution)) {
    fail(
      "--test-build cannot create a distributable app",
      "MACOS_TEST_BUILD_DISTRIBUTION_FORBIDDEN",
    );
  }
  if (!externalDistribution && releaseChannel !== STABLE_RELEASE_CHANNEL) {
    fail(
      "A named external release channel requires --external-distribution",
      "MACOS_RELEASE_CHANNEL_EXTERNAL_REQUIRED",
    );
  }
  if (externalDistribution) {
    resolveOperationalReleaseChannel(releaseChannel, architecture);
    fail(
      "External distribution is only available through the validated release-macos-app programmatic path",
      "MACOS_EXTERNAL_BUILD_RELEASE_CORE_REQUIRED",
    );
  }
  if (previewDistribution) {
    const environmentOutput = environment.USAGE_MONITOR_PREVIEW_OUTPUT;
    if (output !== null || environmentOutput !== undefined) {
      fail(
        "Preview distribution always builds into its reviewed staging path",
        "MACOS_PREVIEW_OUTPUT_FORBIDDEN",
      );
    }
    output = join(previewStagingRootForArchitecture(architecture), PREVIEW_PRODUCT_BRAND.bundleName);
    centralOrigin = centralOrigin
      ?? environment.USAGE_MONITOR_PREVIEW_CENTRAL_ORIGIN
      ?? MACOS_PREVIEW_PUBLIC_CONFIGURATION.centralOrigin;
    const environmentFramework =
      environment.USAGE_MONITOR_PREVIEW_SPARKLE_FRAMEWORK;
    sparkleFramework = sparkleFramework
      ?? resolve(environmentFramework ?? DEFAULT_PREVIEW_FRAMEWORK);
    sparkleAppcastURL = sparkleAppcastURL
      ?? environment.USAGE_MONITOR_PREVIEW_SPARKLE_APPCAST_URL
      ?? (architecture === "x64"
        ? new URL("/preview/intel/appcast.xml", MACOS_PREVIEW_PUBLIC_CONFIGURATION.sparkleAppcastURL).href
        : MACOS_PREVIEW_PUBLIC_CONFIGURATION.sparkleAppcastURL);
    sparklePublicEdKey = sparklePublicEdKey
      ?? environment.USAGE_MONITOR_PREVIEW_SPARKLE_PUBLIC_ED_KEY
      ?? MACOS_PREVIEW_PUBLIC_CONFIGURATION.sparklePublicEdKey;
    if (sparkleAppcastURL === DEPLOYMENT_ENDPOINTS.sparkle.appcastURL) {
      fail(
        "Preview distribution cannot use the stable Sparkle appcast",
        "MACOS_PREVIEW_STABLE_FEED_FORBIDDEN",
      );
    }
    assertMacOSPreviewAppcastBoundary(sparkleAppcastURL, architecture);
  }
  if (!output) fail("--output is required");
  return {
    output,
    architecture,
    nodeRuntime,
    centralOrigin,
    allowLoopbackCentralOrigin,
    externalDistribution,
    previewDistribution,
    releaseChannel,
    replacePreviewOutput,
    bundleVersion,
    sparkleFramework,
    sparkleAppcastURL,
    sparklePublicEdKey,
    buildProfile: testBuild
      ? MACOS_BUILD_PROFILE_TEST
      : MACOS_BUILD_PROFILE_RELEASE,
  };
}

async function buildApplication(stageApp, centralService, {
  architecture,
  runtimeInput,
  bundleVersion,
  buildProfile,
  distribution,
  iconAssets,
  productBrand,
  publicWebsiteOrigin,
  releaseSource,
  releaseChannelName,
  updater,
}) {
  const contents = join(stageApp, "Contents");
  const executables = join(contents, "MacOS");
  const helpers = join(contents, "Helpers");
  const resources = join(contents, "Resources");
  const appRoot = join(resources, "app");
  await mkdir(executables, { recursive: true, mode: 0o755 });
  await mkdir(helpers, { recursive: true, mode: 0o755 });
  await mkdir(appRoot, { recursive: true, mode: 0o755 });

  const [
    graph,
    webModules,
    swiftSources,
    keychainMigrationHelperSources,
    localizationResources,
    workspaceRuntimePackages,
  ] = await Promise.all([
    collectMacOSRuntimeGraph(),
    collectVerifiedMacOSWebModuleGraph(),
    collectMacOSSwiftSources(),
    collectMacOSKeychainMigrationHelperSources(),
    collectMacOSLocalizationResources(),
    captureMacOSWorkspaceRuntimePackages(),
  ]);
  const runtimeAssets = Object.freeze([
    ...MACOS_RUNTIME_STATIC_ASSETS,
    ...webModules.relativeFiles,
  ].sort());
  await writeGeneratedFile(
    join(contents, "Info.plist"),
    infoPlist(centralService, {
      bundleVersion,
      distribution,
      iconIncluded: iconAssets !== null,
      productBrand,
      publicWebsiteOrigin,
      releaseChannelName,
      updater,
    }),
  );
  await writeGeneratedFile(join(contents, "PkgInfo"), "APPL????");
  await compileNativeExecutable(
    join(executables, productBrand.executableName),
    updater,
    swiftSources,
    { architecture, buildProfile },
  );
  await compileNativeExecutable(
    join(stageApp, ...MACOS_KEYCHAIN_MIGRATION_HELPER.executable.split("/")),
    { enabled: false },
    keychainMigrationHelperSources,
    { architecture, buildProfile, migrationHelper: true },
  );
  await copyPinnedSparkleFramework(contents, updater, architecture);
  const node = await copyPinnedNode(resources, runtimeInput);
  await assertMacOSBundleArchitecture(stageApp, { architecture, updaterEnabled: updater.enabled });
  await stageMacOSLocalizationResources(contents, appRoot, localizationResources);
  await copyFirstPartyRuntime(appRoot, graph, runtimeAssets, webModules);
  const dependencies = await copyRuntimeDependencies(
    appRoot,
    workspaceRuntimePackages,
  );
  await copyLicenses(resources, updater);
  if (iconAssets) {
    await copyRegularFile(
      iconAssets.icon.path,
      join(resources, "AppIcon.icns"),
    );
    await writeGeneratedFile(
      join(resources, "licenses", "app-icon-provenance.txt"),
      iconAssets.provenanceText,
    );
  }
  // Record a signature-independent digest for the launcher. Pre-signing makes
  // `codesign --remove-signature` canonical both here and after the outer app
  // signature is regenerated for Developer ID distribution.
  preSignKeychainMigrationHelperForInventory(stageApp);
  if (updater.enabled) {
    signApplicationBundle(stageApp);
  } else {
    preSignLauncherForInventory(stageApp);
  }
  await privacyCheck(stageApp, updater);

  const manifestPath = join(resources, "build-manifest.json");
  const inventory = await bundleInventory(stageApp, manifestPath, updater);
  assertMacOSWebModuleInventory(inventory.files, webModules);
  assertMacOSWorkspaceRuntimePackageInventory(
    inventory.files,
    workspaceRuntimePackages,
  );
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    application: {
      bundleIdentifier: productBrand.bundleIdentifier,
      bundleVersion,
      executable: {
        integrity: "strict_codesign",
        path: SIGNED_EXECUTABLE_PATH,
      },
      minimumMacOSVersion: MINIMUM_MACOS_VERSION,
      name: productBrand.displayName,
      shortVersion: SHORT_VERSION,
      signing: "ad_hoc_developer_bundle",
    },
    release: {
      appOpenHost: productBrand.appOpenHost,
      appOpenScheme: productBrand.appOpenScheme,
      appOpenURL: productBrand.appOpenURL,
      channel: distribution.channel,
      channelName: releaseChannelName,
      externalDistributionRequested: distribution.externalDistribution,
      iconIncluded: iconAssets !== null,
      iconSha256: iconAssets ? sha256(iconAssets.icon.bytes) : null,
      provenanceSha256: iconAssets
        ? sha256(Buffer.from(iconAssets.provenanceText, "utf8"))
        : null,
      productionOriginValidated: distribution.productionOriginValidated,
      previewDistributionRequested: distribution.previewDistribution,
      previewOriginValidated: distribution.previewOriginValidated,
      requiresDeveloperIDAndNotarization:
        distribution.externalDistribution,
      ...(releaseSource === null ? {} : { source: releaseSource }),
      updater: {
        appcastURL: updater.appcastURL,
        automaticChecks: updater.automaticChecks,
        automaticUpdateOptInAvailable: updater.allowsAutomaticUpdateOptIn,
        automaticUpdatesEnabledByDefault:
          updater.automaticUpdatesEnabledByDefault,
        afterUserOptIn: {
          automaticDownload: updater.allowsAutomaticUpdateOptIn,
          installOnQuit: updater.automaticUpdatesEnabledByDefault,
        },
        enabled: updater.enabled,
        frameworkSha256: updater.framework?.sha256 ?? null,
        frameworkVersion: updater.version,
        publicEdKeySha256: updater.enabled
          ? sha256(Buffer.from(updater.publicEdKey, "base64"))
          : null,
        requiresSignedFeed: updater.enabled,
        verifyBeforeExtraction: updater.enabled,
      },
    },
    runtime: {
      centralService: {
        configured: centralService.configured,
        mode: centralService.mode,
      },
      entrypoint: "Contents/Resources/app/apps/local/server.js",
      keychain: {
        account: productBrand.keychainAccount,
        namespace: productBrand.keychainNamespace,
      },
      keychainMigrationHelper: MACOS_KEYCHAIN_MIGRATION_HELPER,
      node,
      stateRoot:
        `~/Library/Application Support/${productBrand.stateDirectoryName}`,
      resourceRoot: "Contents/Resources/app",
    },
    privacyBoundary: {
      backgroundUploadAdded: false,
      credentialsIncluded: false,
      generatedTreeIncluded: false,
      loginItemAdded: false,
      localReportsIncluded: false,
      localStateIncluded: false,
      loopbackHost: LOOPBACK_HOST,
      requestedPort: 0,
    },
    inputs: {
      sourceSha256: await calculateMacOSSourceInputDigest({
        graph,
        runtimeAssets,
        swiftSources,
        keychainMigrationHelperSources,
        localizationResources,
        iconAssets,
        updater,
        webModules,
        workspaceRuntimePackages,
      }),
      firstPartyFiles: graph.relativeFiles,
      swiftSources: swiftSources.relativeFiles,
      keychainMigrationHelperSources: keychainMigrationHelperSources.relativeFiles,
      localizationResources: localizationResources.relativeFiles.map((path) =>
        `apps/macos/Resources/${path}`),
      staticAssets: runtimeAssets,
      generatedRuntimeContracts: [...ALLOWED_GENERATED_RUNTIME_FILES].sort(),
      builtins: graph.builtins,
      externalSpecifiers: graph.externalSpecifiers,
    },
    dependencies,
    payload: inventory,
  };
  assertMacOSKeychainMigrationManifest(manifest);
  const serialized = stableJson(manifest);
  // The reviewed central origin is a deliberately configured public value and
  // may legitimately contain the account name of its host (a workers.dev
  // subdomain does). Scan everything else strictly: build paths, home
  // directories, and any other appearance of the owner identifier still fail.
  let scanned = serialized;
  for (const reviewedPublicUrl of [
    centralService.origin,
    publicWebsiteOrigin,
    updater?.appcastURL,
  ]) {
    if (typeof reviewedPublicUrl === "string" && reviewedPublicUrl.length > 0) {
      scanned = scanned.replaceAll(reviewedPublicUrl, "");
    }
  }
  if (scanned.includes(REPOSITORY_ROOT)
      || scanned.includes("/Users/")
      || scanned.includes("adamallcock")) {
    fail("Build manifest exposed a local source path or owner identifier");
  }
  await writeGeneratedFile(manifestPath, serialized);
  await privacyCheck(stageApp, updater);
  return manifest;
}

/// The export compatibility manifest pins the exact implementation identity
/// (including packageVersion) that produced it, and the export schema enforces
/// that pin with a const. A version bump without `npm run telemetry:generate`
/// (plus the schema const moving in the same change) ships an app whose export
/// paths throw at runtime, so the build refuses a stale manifest outright.
async function assertCurrentExportCompatibilityManifest() {
  const manifestPath = join(
    REPOSITORY_ROOT,
    "generated",
    "telemetry-v0.1-compatibility.json",
  );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    fail(
      "Export compatibility manifest is missing or unreadable; run npm run telemetry:generate",
      "MACOS_EXPORT_COMPATIBILITY_MANIFEST_UNREADABLE",
    );
  }
  const manifestVersion = manifest?.implementation?.packageVersion;
  if (manifestVersion !== RELEASE_VERSION) {
    fail(
      `Export compatibility manifest declares packageVersion ${manifestVersion ?? "unknown"} but the release version is ${RELEASE_VERSION}; bump the packageVersion const in schemas/telemetry-v0.1/compatibility.schema.json and run npm run telemetry:generate`,
      "MACOS_EXPORT_COMPATIBILITY_MANIFEST_STALE",
    );
  }
}

export async function buildMacOSApp({
  output,
  architecture = PINNED_NODE_ARCHITECTURE,
  nodeRuntime = null,
  centralOrigin = null,
  allowLoopbackCentralOrigin = false,
  externalDistribution = false,
  previewDistribution = false,
  releaseChannel = STABLE_RELEASE_CHANNEL,
  replacePreviewOutput = false,
  previewStagingRoot = null,
  bundleVersion = BUNDLE_VERSION,
  buildProfile = MACOS_BUILD_PROFILE_RELEASE,
  sparkleFramework = null,
  sparkleAppcastURL = null,
  sparklePublicEdKey = null,
  releaseSource = null,
  releaseAuthorization = null,
}) {
  const selectedArchitecture = assertMacOSBuildArchitectureConfiguration({
    architecture, nodeRuntime, externalDistribution, previewDistribution,
  });
  previewStagingRoot ??= previewStagingRootForArchitecture(selectedArchitecture);
  const selectedBuildProfile = normalizeMacOSBuildProfile(buildProfile);
  await assertCurrentExportCompatibilityManifest();
  if (externalDistribution && previewDistribution) {
    fail(
      "Production and preview distribution channels are mutually exclusive",
      "MACOS_DISTRIBUTION_CHANNEL_CONFLICT",
    );
  }
  if (!externalDistribution
      && (typeof releaseChannel !== "string"
        || releaseChannel !== STABLE_RELEASE_CHANNEL)) {
    fail(
      "A named external release channel requires --external-distribution",
      "MACOS_RELEASE_CHANNEL_EXTERNAL_REQUIRED",
    );
  }
  const selectedReleaseChannel = externalDistribution
    ? resolveOperationalReleaseChannel(releaseChannel, selectedArchitecture)
    : null;
  if (externalDistribution
      && releaseAuthorization !== MACOS_RELEASE_BUILD_AUTHORIZATION) {
    fail(
      "External distribution is only available through the validated release-macos-app programmatic path",
      "MACOS_EXTERNAL_BUILD_RELEASE_CORE_REQUIRED",
    );
  }
  const sealedReleaseSource = normalizeSealedMacOSReleaseSource(
    releaseSource,
    { required: externalDistribution },
  );
  if (externalDistribution && centralOrigin !== null) {
    const configuredCentralService = normalizeMacOSCentralOrigin(
      centralOrigin,
      { allowLoopbackCentralOrigin },
    );
    if (configuredCentralService.origin
        !== selectedReleaseChannel.serviceOrigin) {
      fail(
        `External distribution must use the reviewed ${selectedReleaseChannel.name} service origin`,
        "MACOS_DISTRIBUTION_ENDPOINTS_MISMATCH",
      );
    }
  }
  if (externalDistribution
      && sparkleAppcastURL !== null
      && sparkleAppcastURL
        !== selectedReleaseChannel.sparkle.appcastURL) {
    fail(
      `External distribution must use the reviewed ${selectedReleaseChannel.name} appcast URL`,
      "MACOS_DISTRIBUTION_ENDPOINTS_MISMATCH",
    );
  }
  const centralService = selectedReleaseChannel
    ? normalizeMacOSReleaseChannelOrigin(selectedReleaseChannel)
    : normalizeMacOSCentralOrigin(centralOrigin, {
      allowLoopbackCentralOrigin,
    });
  const selectedBundleVersion = normalizeMacOSBundleVersion(bundleVersion);
  const distribution = validateMacOSDistributionConfiguration({
    centralService,
    externalDistribution,
    previewDistribution,
    releaseChannel: selectedReleaseChannel ?? releaseChannel,
  });
  const productBrand = distribution.previewDistribution
    ? PREVIEW_PRODUCT_BRAND
    : PRODUCT_BRAND;
  const releaseChannelName = selectedReleaseChannel?.name
    ?? distribution.channel;
  if (selectedBuildProfile === MACOS_BUILD_PROFILE_TEST
      && (distribution.externalDistribution || distribution.previewDistribution)) {
    fail(
      "Test compiler profile cannot create a distributable app",
      "MACOS_TEST_BUILD_DISTRIBUTION_FORBIDDEN",
    );
  }
  if (distribution.previewDistribution
      && sparkleAppcastURL === DEPLOYMENT_ENDPOINTS.sparkle.appcastURL) {
    fail(
      "Preview distribution cannot use the stable Sparkle appcast",
      "MACOS_PREVIEW_STABLE_FEED_FORBIDDEN",
    );
  }
  if (distribution.previewDistribution) {
    assertMacOSPreviewAppcastBoundary(sparkleAppcastURL, selectedArchitecture);
  }
  const updater = await normalizeMacOSUpdaterConfiguration({
    architecture: selectedArchitecture,
    appcastURL: selectedReleaseChannel?.sparkle.appcastURL
      ?? sparkleAppcastURL,
    externalDistribution: distribution.externalDistribution,
    previewDistribution: distribution.previewDistribution,
    frameworkPath: sparkleFramework,
    publicEdKey: sparklePublicEdKey,
  });
  if (distribution.previewDistribution
      && updater.appcastURL === DEPLOYMENT_ENDPOINTS.sparkle.appcastURL) {
    fail(
      "Preview distribution cannot use the stable Sparkle appcast",
      "MACOS_PREVIEW_STABLE_FEED_FORBIDDEN",
    );
  }
  if (distribution.previewDistribution) {
    assertMacOSPreviewAppcastBoundary(updater.appcastURL, selectedArchitecture);
  }
  const selectedPublicEdKeySha256 =
    selectedReleaseChannel?.sparkle.publicEdKeySha256 ?? null;
  if (selectedPublicEdKeySha256 !== null
      && selectedPublicEdKeySha256
        !== sha256(Buffer.from(updater.publicEdKey, "base64"))) {
    fail(
      `Sparkle public key does not match the reviewed ${selectedReleaseChannel.name} channel key`,
      "MACOS_RELEASE_CHANNEL_MISMATCH",
    );
  }
  const selectedOutput = distribution.previewDistribution
    ? validateMacOSPreviewOutputPath(output, {
      stagingRoot: previewStagingRoot,
    })
    : resolve(output);
  assertBuildPlatform();
  const runtimeInput = await validateMacOSNodeRuntimeInput({
    architecture: selectedArchitecture,
    nodeRuntime,
  });
  const releaseFinderTimestamp = externalDistribution
    ? readMacOSReleaseSourceTimestamp(sealedReleaseSource)
    : null;
  const iconAssets = await loadIconAssets({
    required: distribution.externalDistribution || distribution.previewDistribution,
  });
  const outputParent = await prepareOutput(selectedOutput, {
    channel: distribution.channel,
    previewStagingRoot,
    productBrand,
  });
  if (externalDistribution) {
    await assertMacOSExternalBuildOutputIsFresh(selectedOutput);
  }
  const temporaryRoot = await mkdtemp(
    join(outputParent, ".usage-monitor-macos-build-"),
  );
  const stagedApp = join(temporaryRoot, productBrand.bundleName);
  try {
    const manifest = await buildApplication(stagedApp, centralService, {
      architecture: selectedArchitecture,
      runtimeInput,
      bundleVersion: selectedBundleVersion,
      buildProfile: selectedBuildProfile,
      distribution,
      iconAssets,
      productBrand,
      publicWebsiteOrigin: selectedReleaseChannel?.publicWebsiteOrigin
        ?? DEPLOYMENT_ENDPOINTS.public.origin,
      releaseSource: sealedReleaseSource,
      releaseChannelName,
      updater,
    });
    signApplicationBundle(stagedApp);
    if (externalDistribution) {
      await installMacOSExternalBuildOutput(stagedApp, selectedOutput, {
        finderMetadata: {
          birthTimeSeconds: releaseFinderTimestamp,
        },
      });
    } else {
      let legacyPreviewArchive = null;
      if (await verifyExistingBuildTarget(selectedOutput, productBrand)) {
        if (distribution.previewDistribution) {
          if (replacePreviewOutput !== true) {
            fail(
              "Preview staging bundle already exists; rerun with --replace-preview-output after validation",
              "MACOS_PREVIEW_REPLACE_REQUIRED",
            );
          }
          try {
            await validateMacOSPreviewApp(selectedOutput, { architecture: selectedArchitecture });
          } catch (error) {
            const legacyManifest = await readReplaceableLegacyPreviewManifest(
              selectedOutput,
            );
            if (legacyManifest === null) throw error;
            legacyPreviewArchive = await archiveLegacyPreviewApp(
              selectedOutput,
              legacyManifest,
            );
          }
        }
        if (legacyPreviewArchive === null) {
          await rm(selectedOutput, { recursive: true, force: false });
        }
      }
      try {
        await rename(stagedApp, selectedOutput);
      } catch (error) {
        if (legacyPreviewArchive !== null) {
          try {
            await rename(legacyPreviewArchive, selectedOutput);
          } catch (restoreError) {
            error.message = `${error.message}; the legacy preview remains preserved at ${legacyPreviewArchive} because restoration failed: ${restoreError.message}`;
          }
        }
        throw error;
      }
    }
    return Object.freeze({
      bundleIdentifier: manifest.application.bundleIdentifier,
      bundleName: productBrand.bundleName,
      output: selectedOutput,
      payloadSha256: manifest.payload.payloadSha256,
      totalBytes: manifest.payload.totalBytes,
      sourceSha256: manifest.inputs.sourceSha256,
      centralServiceMode: manifest.runtime.centralService.mode,
      channel: manifest.release.channel,
      externalDistributionRequested:
        manifest.release.externalDistributionRequested,
      updaterEnabled: manifest.release.updater.enabled,
      buildProfile: selectedBuildProfile,
      architecture: manifest.runtime.node.architecture,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * Re-run the release-core gates before allowing this module to create an
 * external-distribution bundle. The builder is also imported directly by
 * focused tooling and tests, so the release boundary cannot rely on the
 * caller having already performed the checks.
 */
async function readMacOSReleaseBuildPreflight({
  architecture = PINNED_NODE_ARCHITECTURE,
  nodeRuntime = null,
  environment = process.env,
  previousStableManifestPath = null,
  stableBootstrap = false,
  releaseChannel = STABLE_RELEASE_CHANNEL,
  bundleVersion,
  centralOrigin,
  sparkleFramework,
  sparkleAppcastURL,
  sparklePublicEdKey,
}) {
  // Validate explicit target/runtime selection before release preflights.
  assertMacOSBuildArchitectureConfiguration({
    architecture, nodeRuntime, externalDistribution: true,
  });
  const releaseCore = await import("./macos-release-core.js");
  const buildConfiguration = releaseCore.readMacOSReleaseBuildConfiguration(
    environment,
    releaseChannel,
    { architecture },
  );
  const updater = await normalizeMacOSUpdaterConfiguration({
    architecture,
    appcastURL: buildConfiguration.sparkleAppcastURL,
    externalDistribution: true,
    frameworkPath: buildConfiguration.sparkleFramework,
    publicEdKey: buildConfiguration.sparklePublicEdKey,
  });
  const previousStableManifest = previousStableManifestPath === null
    ? null
    : await releaseCore.readStableReleaseManifest(previousStableManifestPath);
  releaseCore.assertStableSparkleKeyContinuity({
    architecture,
    candidateBundleVersion: buildConfiguration.bundleVersion,
    candidatePublicEdKeySha256: sha256(
      Buffer.from(updater.publicEdKey, "base64"),
    ),
    channel: releaseChannel,
    previousManifest: previousStableManifest,
    stableBootstrap,
  });
  const source = releaseCore.readMacOSReleaseSourceProvenance({
    channel: releaseChannel,
    expectedVersion: SHORT_VERSION,
  });
  releaseCore.readMacOSReleaseCredentials(environment);
  if (centralOrigin !== buildConfiguration.productionOrigin
      || bundleVersion !== buildConfiguration.bundleVersion
      || sparkleFramework !== updater.framework.path
      || sparkleAppcastURL !== updater.appcastURL
      || sparklePublicEdKey !== updater.publicEdKey) {
    fail(
      "External distribution build options do not match the release-core preflight",
      "MACOS_EXTERNAL_BUILD_PREFLIGHT_MISMATCH",
    );
  }
  return Object.freeze({
    buildConfiguration,
    releaseCore,
    source: Object.freeze({ commit: source.commit, tag: source.tag }),
    updater,
  });
}

async function assertMacOSReleaseBuildPreflight(options) {
  const { candidateAppPath, releaseChannel = STABLE_RELEASE_CHANNEL } = options;
  if (typeof candidateAppPath !== "string"
      || candidateAppPath.length === 0
      || candidateAppPath.includes("\0")) {
    fail(
      "External distribution requires a release-core candidate preflight",
      "MACOS_EXTERNAL_BUILD_PREFLIGHT_REQUIRED",
    );
  }
  const preflight =
    await readMacOSReleaseBuildPreflight(options);
  const { buildConfiguration, releaseCore, source, updater } = preflight;
  const inspectedCandidate = await releaseCore.inspectMacOSApp(
    candidateAppPath,
    {
      channel: releaseChannel,
      architecture: options.architecture ?? "arm64",
      requireExternalDistribution: true,
    },
  );
  if (inspectedCandidate.plist.UsageMonitorCentralOrigin
        !== buildConfiguration.productionOrigin
      || inspectedCandidate.bundleVersion !== buildConfiguration.bundleVersion
      || inspectedCandidate.plist.SUFeedURL !== updater.appcastURL
      || inspectedCandidate.plist.SUPublicEDKey !== updater.publicEdKey
      || JSON.stringify(inspectedCandidate.buildManifest.release?.source)
        !== JSON.stringify(source)) {
    fail(
      "External distribution build options do not match the release-core preflight",
      "MACOS_EXTERNAL_BUILD_PREFLIGHT_MISMATCH",
    );
  }
  return preflight;
}

/**
 * Create the first reviewable external-distribution candidate from a clean,
 * annotated source revision. This path performs the same release-core input,
 * credential, updater-key, and continuity checks as the reproducibility build,
 * but intentionally has no existing candidate to inspect yet.
 */
export async function buildMacOSReleaseCandidate(options) {
  const preflight = await readMacOSReleaseBuildPreflight(options);
  return buildMacOSApp({
    ...options,
    releaseSource: preflight.source,
    releaseAuthorization: MACOS_RELEASE_BUILD_AUTHORIZATION,
  });
}

/**
 * Build an external-distribution candidate only after release-core has
 * revalidated source provenance, continuity, credentials, and the reviewed
 * candidate. The authorization remains module-private; the explicit
 * candidate preflight prevents a direct import from skipping those gates.
 */
export async function buildMacOSAppForRelease(options) {
  const preflight = await assertMacOSReleaseBuildPreflight(options);
  return buildMacOSApp({
    ...options,
    releaseSource: preflight.source,
    releaseAuthorization: MACOS_RELEASE_BUILD_AUTHORIZATION,
  });
}

async function main(argv) {
  const {
    appPath,
    output,
    architecture,
    nodeRuntime,
    centralOrigin,
    allowLoopbackCentralOrigin,
    externalDistribution,
    previewDistribution,
    releaseChannel,
    replacePreviewOutput,
    bundleVersion,
    buildProfile,
    sparkleFramework,
    sparkleAppcastURL,
    sparklePublicEdKey,
    validatePreview,
  } = parseMacOSBuildArguments(argv);
  if (validatePreview) {
    const result = await validateMacOSPreviewApp(appPath, { architecture });
    console.log("Preview validation: passed");
    console.log(`Bundle: ${result.bundleIdentifier}`);
    console.log(`Bundle version: ${result.bundleVersion}`);
    console.log(`Channel: ${result.channel}`);
    console.log(`Updater: ${result.updaterEnabled ? "Sparkle 2.9.3" : "disabled"}`);
    return;
  }
  const result = await buildMacOSApp({
    output,
    architecture,
    nodeRuntime,
    centralOrigin,
    allowLoopbackCentralOrigin,
    externalDistribution,
    previewDistribution,
    releaseChannel,
    replacePreviewOutput,
    bundleVersion,
    buildProfile,
    sparkleFramework,
    sparkleAppcastURL,
    sparklePublicEdKey,
  });
  console.log(`${result.bundleName}: built`);
  console.log(`Bundle identifier: ${result.bundleIdentifier}`);
  console.log(`Output: ${result.output}`);
  console.log(`Payload SHA-256: ${result.payloadSha256}`);
  console.log(`Source SHA-256: ${result.sourceSha256}`);
  console.log(`Payload bytes: ${result.totalBytes}`);
  console.log(`Compiler profile: ${result.buildProfile}`);
  console.log(`Target architecture: ${result.architecture}`);
  console.log(`Channel: ${result.channel}`);
  console.log(`Central service: ${result.centralServiceMode}`);
  console.log(
    `External distribution requested: ${result.externalDistributionRequested}`,
  );
  console.log(`Updater: ${result.updaterEnabled ? "Sparkle 2.9.3" : "disabled"}`);
  console.log("Signing: ad hoc only (not Developer ID; not notarized)");
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`build-macos-app: ${error.message}`);
    process.exitCode = 1;
  });
}
