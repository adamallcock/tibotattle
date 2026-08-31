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
import {
  PREVIEW_PRODUCT_BRAND,
  PRODUCT_BRAND,
} from "../config/product-brand.js";
import {
  assertDeploymentEndpoints,
  DEPLOYMENT_ENDPOINTS,
} from "../config/deployment-endpoints.js";
import {
  assertReleaseChannelPublication,
  createReleaseChannelProvenance,
  INTERNAL_DOGFOOD_RELEASE_CHANNEL,
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
  MACOS_KEYCHAIN_MIGRATION_HELPER,
  assertMacOSKeychainMigrationManifest,
  buildMacOSAppForRelease,
  buildMacOSReleaseCandidate,
  validateMacOSPreviewApp,
} from "./build-macos-app.js";
import {
  compareAppleMacOSBundleVersionToPrevious,
  compareAppleMacOSBundleVersions,
  isAppleMacOSBundleVersion,
  isLegacyZeroFirstMacOSBundleVersion,
  LEGACY_STABLE_MACOS_BUNDLE_VERSION,
  parseAppleMacOSBundleVersion,
  resolveSignedMacOSBundleVersion,
} from "./macos-bundle-version.js";
import { RELEASE_VERSION } from "../config/release-manifest.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const BUILD_MANIFEST_SCHEMA = "usage-monitor-macos-app-build-v0.1";
const RELEASE_MANIFEST_SCHEMA = "usage-monitor-macos-release-v0.2";
const PUBLIC_RELEASE_SOURCE_REPOSITORY =
  "https://github.com/adamallcock/tibotattle";
const RELEASE_SOURCE_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const STABLE_RELEASE_SOURCE_TAG_PATTERN =
  /^v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/u;
const INTERNAL_DOGFOOD_SOURCE_TAG_PATTERN =
  /^tibotattle-internal-dogfood-((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))-rc([1-9][0-9]{0,3})-source-(20[0-9]{2})(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])$/u;
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
const SPARKLE_FRAMEWORK_PREFIX =
  "Contents/Frameworks/Sparkle.framework";
const BASE_NORMALIZED_MACH_O_PATHS = Object.freeze([
  APP_EXECUTABLE,
  NODE_EXECUTABLE,
  MACOS_KEYCHAIN_MIGRATION_HELPER.executable,
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
// This already-distributed DMG predates channel tags and embedded source seals.
// It is a previous-artifact exception, never a way to build/publish a candidate.
const LEGACY_DOGFOOD_PREVIOUS_RELEASE = Object.freeze({
  artifactSha256:
    "2b32964c8b3bc2912620dbbe078aaf4e2fd49f1725a4e94a62dff184cdc9f8c1",
  artifactBytes: 49_341_249,
  artifactFileName: "TiboTattle-0.1.16-macOS-arm64.dmg",
  bundleVersion: "1022",
  shortVersion: "0.1.16",
  sourceCommit: "5adaca5fdc8f981c391144e0d29b6f4c764f0f96",
  sourceTag: "v0.1.16",
  sourceSha256:
    "ff7f59ec074705f8ecb3d78810177a8e8a4795a1e58c2df24faa9b3e6e26fae7",
  payloadSha256:
    "a5740aac152d95b638989462584774c0e3039ecd7db511692bd8fe690d8d37c4",
  publicEdKeySha256:
    "77d5717947da768e7e96a1b1e6225d2cae4748a556f109f2a30444a5f41ff3d2",
  frameworkSha256:
    "2a43f8c41a29b195982354d7580036c178ed89e3b3e5dc0d8ab295290d91a0ac",
  keytar: Object.freeze({
    path: "Contents/Resources/app/node_modules/@github/keytar/prebuilds/darwin-arm64/keytar.node",
    bytes: 98_544,
    mode: "555",
    sha256:
      "dd24fba62f187f494e86ab5c4d499dcb8cb2c5bd7345079651297aecb9c6f049",
  }),
});
// The Symbol is transport only: a caller-controlled options Proxy can discover
// it. Authorization requires an opaque object in the module-private WeakSet.
const VERIFIED_LEGACY_DOGFOOD_PREVIOUS_ARTIFACT = Symbol(
  "verified legacy dogfood previous artifact",
);
const VERIFIED_LEGACY_DOGFOOD_CAPABILITIES = new WeakSet();
// This immutable rc2 was installed before the migration helper existed. Only
// the checksum-verified previous side of a replacement may omit that helper;
// every newly built/signable/public candidate must carry the current contract.
const PRE_MIGRATION_DOGFOOD_PREVIOUS_RELEASE = Object.freeze({
  artifactSha256:
    "125a15da9b0e260ec3797527d6b98e15aa1172e8b6fc8e7942d2a799cc2b29b0",
  artifactBytes: 49_574_961,
  artifactFileName: "TiboTattle-0.1.17-macOS-arm64.dmg",
  bundleVersion: "1023",
  shortVersion: "0.1.17",
  sourceCommit: "3d9055fc8e58c84f8ba71feb5deb58b52c532138",
  sourceTag: "tibotattle-internal-dogfood-0.1.17-rc2-source-20260831",
  sourceSha256:
    "d18945b354ed3431b49953c2fe756405ccb8b5d46cd866adcc96a640f2344275",
  payloadSha256:
    "dad884435aea0d1a471f1a7ff7cfbd908723c6cb26a95823ad600c8ccd1d1a7d",
  publicEdKeySha256:
    "77d5717947da768e7e96a1b1e6225d2cae4748a556f109f2a30444a5f41ff3d2",
  frameworkSha256:
    "2a43f8c41a29b195982354d7580036c178ed89e3b3e5dc0d8ab295290d91a0ac",
});
const VERIFIED_PRE_MIGRATION_PREVIOUS_ARTIFACT = Symbol(
  "verified pre-migration previous artifact",
);
const VERIFIED_PRE_MIGRATION_CAPABILITIES = new WeakSet();
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

function validateLegacyDogfoodPreviousCapability(capability) {
  if (capability === null) return false;
  if (!VERIFIED_LEGACY_DOGFOOD_CAPABILITIES.has(capability)) {
    fail(
      "Legacy dogfood source compatibility requires a verified previous-artifact capability",
      "MACOS_LEGACY_SOURCE_COMPATIBILITY_INVALID",
    );
  }
  return true;
}

function validatePreMigrationPreviousCapability(capability) {
  if (capability === null) return false;
  if (!VERIFIED_PRE_MIGRATION_CAPABILITIES.has(capability)) {
    fail(
      "Pre-migration helper compatibility requires a verified previous-artifact capability",
      "MACOS_KEYCHAIN_MIGRATION_COMPATIBILITY_INVALID",
    );
  }
  return true;
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

export function normalizePublicReleaseSourceOrigin(origin) {
  if (typeof origin !== "string" || origin.length === 0
      || origin.trim() !== origin || /[\s\0]/u.test(origin)
      || origin.includes("?") || origin.includes("#")) {
    return null;
  }
  if (origin.startsWith("https://")) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return null;
    }
    const authority = origin.slice("https://".length)
      .split(/[/?#]/u, 1)[0];
    const path = parsed.pathname.replace(/\/$/u, "");
    if (parsed.protocol !== "https:"
        || authority !== "github.com"
        || parsed.username
        || parsed.password
        || parsed.port
        || parsed.search
        || parsed.hash
        || path !== "/adamallcock/tibotattle"
          && path !== "/adamallcock/tibotattle.git") {
      return null;
    }
    return PUBLIC_RELEASE_SOURCE_REPOSITORY;
  }
  if (/^git@github\.com:/u.test(origin)) {
    const path = origin.slice("git@github.com:".length);
    if (/^adamallcock\/tibotattle(?:\.git)?$/u.test(path)) {
      return PUBLIC_RELEASE_SOURCE_REPOSITORY;
    }
    return null;
  }
  if (origin.startsWith("ssh://")) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return null;
    }
    const authority = origin.slice("ssh://".length)
      .split(/[/?#]/u, 1)[0];
    const path = parsed.pathname.replace(/^\//u, "").replace(/\/$/u, "");
    if (parsed.protocol !== "ssh:"
        || authority !== "git@github.com"
        || parsed.username !== "git"
        || parsed.password
        || parsed.port
        || parsed.search
        || parsed.hash
        || !/^adamallcock\/tibotattle(?:\.git)?$/u.test(path)) {
      return null;
    }
    return PUBLIC_RELEASE_SOURCE_REPOSITORY;
  }
  return null;
}

function validateMacOSReleaseSource(source, label = "Release source") {
  if (!source || typeof source !== "object" || Array.isArray(source)
      || Object.keys(source).sort().join(",") !== "commit,repository,tag"
      || source.repository !== PUBLIC_RELEASE_SOURCE_REPOSITORY
      || typeof source.tag !== "string"
      || !/^[0-9A-Za-z][0-9A-Za-z._/-]{0,127}$/u.test(source.tag)
      || source.tag.includes("..")
      || source.tag.startsWith("/")
      || source.tag.endsWith("/")
      || typeof source.commit !== "string"
      || !/^[0-9a-f]{40,64}$/u.test(source.commit)) {
    fail(
      `${label} is not a public TiboTattle source identity`,
      "MACOS_RELEASE_SOURCE_INVALID",
    );
  }
  return Object.freeze({
    repository: PUBLIC_RELEASE_SOURCE_REPOSITORY,
    tag: source.tag,
    commit: source.commit,
  });
}

function validateSealedMacOSReleaseSource(source, {
  channel,
  expectedVersion,
  label = "Release application source",
} = {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)
      || Object.keys(source).sort().join(",") !== "commit,tag"
      || typeof source.commit !== "string"
      || !/^[0-9a-f]{40,64}$/u.test(source.commit)
      || !isMacOSReleaseSourceTagForChannel(source.tag, {
        channel,
        expectedVersion,
      })) {
    fail(
      `${label} is not a sealed channel source identity`,
      "MACOS_RELEASE_SOURCE_INVALID",
    );
  }
  return Object.freeze({ commit: source.commit, tag: source.tag });
}

function isCalendarSourceDate(year, month, day) {
  const value = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return value.getUTCFullYear() === Number(year)
    && value.getUTCMonth() === Number(month) - 1
    && value.getUTCDate() === Number(day);
}

/**
 * Stable artifacts are bound to their canonical public version tag. Internal
 * dogfood artifacts use a separate immutable annotated source tag so a tested
 * candidate does not prematurely claim the final stable release tag.
 */
export function isMacOSReleaseSourceTagForChannel(tag, {
  channel = STABLE_RELEASE_CHANNEL,
  expectedVersion = null,
} = {}) {
  if (typeof tag !== "string"
      || (expectedVersion !== null
        && (typeof expectedVersion !== "string"
          || !RELEASE_SOURCE_VERSION_PATTERN.test(expectedVersion)))) {
    return false;
  }
  if (channel === STABLE_RELEASE_CHANNEL) {
    const match = STABLE_RELEASE_SOURCE_TAG_PATTERN.exec(tag);
    return match !== null
      && (expectedVersion === null || match[1] === expectedVersion);
  }
  if (channel === INTERNAL_DOGFOOD_RELEASE_CHANNEL) {
    const match = INTERNAL_DOGFOOD_SOURCE_TAG_PATTERN.exec(tag);
    return match !== null
      && (expectedVersion === null || match[1] === expectedVersion)
      && isCalendarSourceDate(match[3], match[4], match[5]);
  }
  return false;
}

/**
 * A notarized DMG must name an immutable source revision. Refuse a dirty,
 * lightweight-tagged, or untagged checkout instead of relying on the local
 * filename or a build digest that cannot identify the public source release.
 */
export function readMacOSReleaseSourceProvenance({
  repositoryRoot = REPOSITORY_ROOT,
  expectedVersion = RELEASE_VERSION,
  channel = STABLE_RELEASE_CHANNEL,
} = {}) {
  const releaseChannel = resolveOperationalReleaseChannel(channel);
  if (expectedVersion !== null
      && (typeof expectedVersion !== "string"
        || !RELEASE_SOURCE_VERSION_PATTERN.test(expectedVersion))) {
    fail(
      "Release source version is invalid",
      "MACOS_RELEASE_SOURCE_VERSION_MISMATCH",
    );
  }
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
  const originResult = releaseGit(
    root,
    ["config", "--get-all", "remote.origin.url"],
  );
  if (originResult.error || originResult.status !== 0) {
    fail(
      "A signed release requires the public TiboTattle origin",
      "MACOS_RELEASE_SOURCE_ORIGIN_REQUIRED",
    );
  }
  const origins = String(originResult.stdout ?? "")
    .split(/\r?\n/u)
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length !== 1
      || normalizePublicReleaseSourceOrigin(origins[0]) === null) {
    fail(
      "A signed release requires the exact public TiboTattle origin",
      "MACOS_RELEASE_SOURCE_ORIGIN_INVALID",
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
  const tagResult = releaseGit(root, ["tag", "--points-at", "HEAD"]);
  if (tagResult.error || tagResult.status !== 0) {
    fail(
      "Unable to establish signed-release source tags",
      "MACOS_RELEASE_PROVENANCE_INVALID",
    );
  }
  const tags = String(tagResult.stdout ?? "")
    .split(/\r?\n/u)
    .filter((tag) => tag.length > 0);
  if (tags.length === 0) {
    fail(
      "A signed release requires an annotated Git tag",
      "MACOS_RELEASE_TAG_REQUIRED",
    );
  }
  const matchingTags = tags.filter((tag) =>
    isMacOSReleaseSourceTagForChannel(tag, {
      channel: releaseChannel.name,
      expectedVersion,
    }));
  if (matchingTags.length === 0) {
    fail(
      `Release source tag does not match the ${releaseChannel.name} version policy`,
      "MACOS_RELEASE_SOURCE_VERSION_MISMATCH",
    );
  }
  if (matchingTags.length !== 1) {
    fail(
      `Release source has ambiguous ${releaseChannel.name} version tags`,
      "MACOS_RELEASE_PROVENANCE_INVALID",
    );
  }
  const [tag] = matchingTags;
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
  return validateMacOSReleaseSource({
    repository: PUBLIC_RELEASE_SOURCE_REPOSITORY,
    commit,
    tag,
  });
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

async function verifyMacOSBuildPayload(
  appPath,
  manifest,
  legacyDogfoodPreviousCapability = null,
  preMigrationPreviousCapability = null,
  legacyStablePrevious = false,
) {
  const legacyDogfoodPrevious = validateLegacyDogfoodPreviousCapability(
    legacyDogfoodPreviousCapability,
  );
  const preMigrationPrevious = validatePreMigrationPreviousCapability(
    preMigrationPreviousCapability,
  );
  const helperRequired = !legacyDogfoodPrevious
    && !preMigrationPrevious && !legacyStablePrevious;
  if (helperRequired) {
    assertMacOSKeychainMigrationManifest(manifest);
  } else if (manifest.runtime?.keychainMigrationHelper !== undefined
      || manifest.inputs?.keychainMigrationHelperSources !== undefined
      || (Array.isArray(manifest.payload?.files)
        && manifest.payload.files.some((entry) =>
          entry?.path === MACOS_KEYCHAIN_MIGRATION_HELPER.executable))) {
    fail(
      "Pre-migration previous artifact unexpectedly includes migration-helper state",
      "MACOS_KEYCHAIN_MIGRATION_COMPATIBILITY_INVALID",
    );
  }
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
    const legacyKeytar = legacyDogfoodPrevious
      && entry.path === LEGACY_DOGFOOD_PREVIOUS_RELEASE.keytar.path;
    const expectedNormalization = (NORMALIZED_MACH_O_PATHS.has(entry.path)
        || legacyKeytar)
      ? "mach_o_without_code_signature"
      : "raw";
    if (!Number.isSafeInteger(entry.bytes)
        || entry.bytes < 0
        || typeof entry.mode !== "string"
        || !/^[0-7]{3}$/u.test(entry.mode)
        || typeof entry.sha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(entry.sha256)
        || entry.normalization !== expectedNormalization
        || (legacyKeytar && ["bytes", "mode", "sha256"].some((key) =>
          entry[key] !== LEGACY_DOGFOOD_PREVIOUS_RELEASE.keytar[key]))
        || expected.has(entry.path)
        || [BUILD_MANIFEST_PATH, CODE_RESOURCES_PATH].includes(entry.path)) {
      fail(
        "Application build manifest contains an invalid payload entry",
        "MACOS_PAYLOAD_INTEGRITY_FAILED",
      );
    }
    expected.set(entry.path, entry);
  }
  const selectedBaseMachOPaths = BASE_NORMALIZED_MACH_O_PATHS.filter((path) =>
    helperRequired || path !== MACOS_KEYCHAIN_MIGRATION_HELPER.executable);
  const requiredMachOPaths = updaterEnabled
    ? [
      ...selectedBaseMachOPaths,
      ...SPARKLE_NORMALIZED_MACH_O_PATHS,
    ]
    : selectedBaseMachOPaths;
  for (const required of [
    ...requiredMachOPaths,
    ...(legacyDogfoodPrevious
      ? [LEGACY_DOGFOOD_PREVIOUS_RELEASE.keytar.path]
      : []),
  ]) {
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

function hasExpectedProductBrand(plist, legacyDogfoodPreviousCapability = null) {
  const legacyDogfoodPrevious = validateLegacyDogfoodPreviousCapability(
    legacyDogfoodPreviousCapability,
  );
  // The pinned old app used the same identity constants in code, before these
  // two fields were added to its plist. Do not exempt new candidates or accept
  // a partially specified/different identity on the historical artifact.
  const expectedKeychainIdentity = legacyDogfoodPrevious
    ? !Object.hasOwn(plist, "UsageMonitorKeychainNamespace")
      && !Object.hasOwn(plist, "UsageMonitorKeychainAccount")
    : plist.UsageMonitorKeychainNamespace === PRODUCT_BRAND.keychainNamespace
      && plist.UsageMonitorKeychainAccount === PRODUCT_BRAND.keychainAccount;
  return plist.CFBundleDisplayName === PRODUCT_BRAND.displayName
    && plist.CFBundleName === PRODUCT_BRAND.displayName
    && plist.UsageMonitorAppOpenHost === PRODUCT_BRAND.appOpenHost
    && plist.UsageMonitorAppOpenScheme === PRODUCT_BRAND.appOpenScheme
    && plist.UsageMonitorAppOpenURL === PRODUCT_BRAND.appOpenURL
    && plist.UsageMonitorBundleName === PRODUCT_BRAND.bundleName
    && plist.UsageMonitorStateDirectoryName
      === PRODUCT_BRAND.stateDirectoryName
    && expectedKeychainIdentity
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
  allowLegacyUnsealedSource = false,
  [VERIFIED_LEGACY_DOGFOOD_PREVIOUS_ARTIFACT]: legacyDogfoodPreviousCapability = null,
  [VERIFIED_PRE_MIGRATION_PREVIOUS_ARTIFACT]: preMigrationPreviousCapability = null,
  channel = "stable",
  requireExternalDistribution = false,
} = {}) {
  const legacyDogfoodPrevious = validateLegacyDogfoodPreviousCapability(
    legacyDogfoodPreviousCapability,
  );
  const preMigrationPrevious = validatePreMigrationPreviousCapability(
    preMigrationPreviousCapability,
  );
  if (typeof allowLegacyUnsealedSource !== "boolean"
      || ((allowLegacyUnsealedSource || legacyDogfoodPrevious || preMigrationPrevious)
        && !requireExternalDistribution)) {
    fail(
      "Legacy unsealed source compatibility requires external artifact validation",
      "MACOS_LEGACY_SOURCE_COMPATIBILITY_INVALID",
    );
  }
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
  const exactLegacyStablePrevious = allowLegacyUnsealedSource
    && channel === STABLE_RELEASE_CHANNEL
    && manifest.application?.bundleVersion === LEGACY_STABLE_MACOS_BUNDLE_VERSION
    && manifest.application?.shortVersion === LEGACY_STABLE_MACOS_BUNDLE_VERSION
    && manifest.release?.source === undefined;
  if (preMigrationPrevious
      && (channel !== INTERNAL_DOGFOOD_RELEASE_CHANNEL
        || manifest.application?.bundleVersion !== PRE_MIGRATION_DOGFOOD_PREVIOUS_RELEASE.bundleVersion
        || manifest.application?.shortVersion !== PRE_MIGRATION_DOGFOOD_PREVIOUS_RELEASE.shortVersion
        || manifest.release?.source?.commit !== PRE_MIGRATION_DOGFOOD_PREVIOUS_RELEASE.sourceCommit
        || manifest.release?.source?.tag !== PRE_MIGRATION_DOGFOOD_PREVIOUS_RELEASE.sourceTag
        || manifest.inputs?.sourceSha256 !== PRE_MIGRATION_DOGFOOD_PREVIOUS_RELEASE.sourceSha256
        || manifest.payload?.payloadSha256 !== PRE_MIGRATION_DOGFOOD_PREVIOUS_RELEASE.payloadSha256
        || manifest.release?.updater?.publicEdKeySha256
          !== PRE_MIGRATION_DOGFOOD_PREVIOUS_RELEASE.publicEdKeySha256
        || manifest.release?.updater?.frameworkSha256
          !== PRE_MIGRATION_DOGFOOD_PREVIOUS_RELEASE.frameworkSha256)) {
    fail(
      "Pre-migration helper compatibility does not match the exact previous build",
      "MACOS_KEYCHAIN_MIGRATION_COMPATIBILITY_INVALID",
    );
  }
  await verifyMacOSBuildPayload(
    selected,
    manifest,
    legacyDogfoodPreviousCapability,
    preMigrationPreviousCapability,
    exactLegacyStablePrevious,
  );
  const plistPath = join(selected, "Contents", "Info.plist");
  await regularPath(plistPath);
  const plist = parsePlist(plistPath);
  if (plist.CFBundleIdentifier !== BUNDLE_IDENTIFIER
      || plist.CFBundleExecutable !== PRODUCT_BRAND.executableName
      || !hasAppOpenScheme(plist)
      || !hasExpectedProductBrand(plist, legacyDogfoodPreviousCapability)) {
    fail("Application bundle metadata is incomplete");
  }
  await validateUpdaterBoundary(selected, plist, manifest, {
    required: requireExternalDistribution,
  });
  let sealedSource = null;
  for (const relativePath of [
    APP_EXECUTABLE,
    NODE_EXECUTABLE,
    ...(!legacyDogfoodPrevious && !preMigrationPrevious && !exactLegacyStablePrevious
      ? [MACOS_KEYCHAIN_MIGRATION_HELPER.executable]
      : []),
  ]) {
    await regularPath(join(selected, ...relativePath.split("/")));
  }
  if (requireExternalDistribution) {
    const releaseChannel = resolveOperationalReleaseChannel(channel);
    const exactLegacyUnsealedSource = allowLegacyUnsealedSource
      && releaseChannel.name === STABLE_RELEASE_CHANNEL
      && plist.CFBundleVersion === LEGACY_STABLE_MACOS_BUNDLE_VERSION
      && plist.CFBundleShortVersionString
        === LEGACY_STABLE_MACOS_BUNDLE_VERSION;
    if (allowLegacyUnsealedSource && !exactLegacyUnsealedSource) {
      fail(
        "Legacy unsealed source compatibility applies only to the exact 0.1.16 stable rollback artifact",
        "MACOS_LEGACY_SOURCE_COMPATIBILITY_INVALID",
      );
    }
    const exactLegacyDogfoodSource = legacyDogfoodPrevious
      && releaseChannel.name === INTERNAL_DOGFOOD_RELEASE_CHANNEL
      && plist.CFBundleVersion === LEGACY_DOGFOOD_PREVIOUS_RELEASE.bundleVersion
      && plist.CFBundleShortVersionString
        === LEGACY_DOGFOOD_PREVIOUS_RELEASE.shortVersion
      && manifest.application.bundleVersion
        === LEGACY_DOGFOOD_PREVIOUS_RELEASE.bundleVersion
      && manifest.application.shortVersion
        === LEGACY_DOGFOOD_PREVIOUS_RELEASE.shortVersion
      && manifest.inputs?.sourceSha256
        === LEGACY_DOGFOOD_PREVIOUS_RELEASE.sourceSha256
      && manifest.payload?.payloadSha256
        === LEGACY_DOGFOOD_PREVIOUS_RELEASE.payloadSha256
      && manifest.release?.source === undefined
      && manifest.release?.updater?.publicEdKeySha256
        === LEGACY_DOGFOOD_PREVIOUS_RELEASE.publicEdKeySha256
      && manifest.release?.updater?.frameworkSha256
        === LEGACY_DOGFOOD_PREVIOUS_RELEASE.frameworkSha256;
    if (legacyDogfoodPrevious && !exactLegacyDogfoodSource) {
      fail(
        "Legacy dogfood source compatibility does not match the exact previous build",
        "MACOS_LEGACY_SOURCE_COMPATIBILITY_INVALID",
      );
    }
    sealedSource = (exactLegacyUnsealedSource || exactLegacyDogfoodSource)
        && manifest.release?.source === undefined
      ? null
      : validateSealedMacOSReleaseSource(
        manifest.release?.source,
        {
          channel: releaseChannel.name,
          expectedVersion: plist.CFBundleShortVersionString,
        },
      );
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
    source: sealedSource,
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
  const bundleVersion = resolveSignedMacOSBundleVersion(
    RELEASE_VERSION,
    releaseChannel.name,
  );
  if (bundleVersion === null) {
    fail(
      `No signed macOS bundle version is allocated for ${releaseChannel.name} ${RELEASE_VERSION}`,
      "MACOS_SIGNED_BUNDLE_VERSION_UNPLANNED",
    );
  }
  const configuredBundleVersion = environment.USAGE_MONITOR_BUNDLE_VERSION;
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
  if (configuredBundleVersion !== undefined
      && configuredBundleVersion !== bundleVersion) {
    fail(
      `USAGE_MONITOR_BUNDLE_VERSION must equal the allocated ${releaseChannel.name} release value ${bundleVersion}`,
      "MACOS_BUNDLE_VERSION_MISMATCH",
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
  const parts = parseAppleMacOSBundleVersion(value);
  if (parts === null) {
    fail(
      "Replacement contract contains an invalid bundle version",
      "MACOS_REPLACEMENT_VERSION_INVALID",
    );
  }
  return parts;
}

export function compareMacOSBundleVersions(left, right) {
  const comparison = compareAppleMacOSBundleVersions(left, right);
  if (comparison === null) {
    macOSBundleVersionParts(left);
    macOSBundleVersionParts(right);
  }
  return comparison;
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

function validateSignedReleaseManifest(manifest, label, {
  allowLegacyStableMigrationSource = false,
  allowLegacyDogfoodPreviousSource = false,
  allowPreMigrationDogfoodPreviousSource = false,
} = {}) {
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
  const channelName = manifest.channel === undefined
    ? null
    : validateSignedReleaseChannel(manifest, label);
  const legacyDogfoodPreviousSource = allowLegacyDogfoodPreviousSource
    && isExactLegacyDogfoodPreviousRelease(manifest);
  if (manifest.artifact.sha256 === LEGACY_DOGFOOD_PREVIOUS_RELEASE.artifactSha256
      && !legacyDogfoodPreviousSource) {
    fail(
      "The historical dogfood artifact is allowed only as its exact previous release",
      "MACOS_LEGACY_SOURCE_COMPATIBILITY_INVALID",
    );
  }
  if (manifest.artifact.sha256 === PRE_MIGRATION_DOGFOOD_PREVIOUS_RELEASE.artifactSha256
      && (!allowPreMigrationDogfoodPreviousSource
        || !isExactPreMigrationDogfoodPreviousRelease(manifest))) {
    fail(
      "The pre-migration dogfood artifact is allowed only as its exact previous release",
      "MACOS_KEYCHAIN_MIGRATION_COMPATIBILITY_INVALID",
    );
  }
  const bundleVersion = manifest.application.bundleVersion;
  const legacyStableMigrationSource =
    allowLegacyStableMigrationSource
    && isLegacyZeroFirstMacOSBundleVersion(bundleVersion);
  if (manifest.source === undefined && !legacyStableMigrationSource) {
    fail(
      `${label} is missing required source provenance`,
      "MACOS_RELEASE_SOURCE_INVALID",
    );
  }
  if (manifest.source !== undefined) {
    validateMacOSReleaseSource(manifest.source, label);
    if (channelName !== null && !legacyDogfoodPreviousSource
        && !isMacOSReleaseSourceTagForChannel(manifest.source.tag, {
          channel: channelName,
          expectedVersion: manifest.application.shortVersion,
        })) {
      fail(
        `${label} source tag does not identify its channel and application version`,
        "MACOS_RELEASE_SOURCE_VERSION_MISMATCH",
      );
    }
  }
  if (legacyStableMigrationSource) {
    if (channelName !== STABLE_RELEASE_CHANNEL
        || manifest.application.shortVersion !== bundleVersion) {
      fail(
        `${label} legacy zero-first bundle version is allowed only for its exact stable marketing-version migration source`,
        "MACOS_REPLACEMENT_VERSION_INVALID",
      );
    }
  } else {
    macOSBundleVersionParts(bundleVersion);
  }
  return manifest;
}

function isExactLegacyDogfoodPreviousRelease(manifest) {
  const legacy = LEGACY_DOGFOOD_PREVIOUS_RELEASE;
  return manifest?.channel?.name === INTERNAL_DOGFOOD_RELEASE_CHANNEL
    && manifest.application?.bundleIdentifier === BUNDLE_IDENTIFIER
    && manifest.application?.bundleVersion === legacy.bundleVersion
    && manifest.application?.shortVersion === legacy.shortVersion
    && manifest.artifact?.sha256 === legacy.artifactSha256
    && manifest.artifact?.bytes === legacy.artifactBytes
    && manifest.artifact?.fileName === legacy.artifactFileName
    && manifest.source?.repository === PUBLIC_RELEASE_SOURCE_REPOSITORY
    && manifest.source?.commit === legacy.sourceCommit
    && manifest.source?.tag === legacy.sourceTag
    && manifest.build?.sourceSha256 === legacy.sourceSha256
    && manifest.build?.payloadSha256 === legacy.payloadSha256
    && manifest.updater?.appcastURL === manifest.channel.sparkle.appcastURL
    && manifest.updater?.publicEdKeySha256 === legacy.publicEdKeySha256
    && manifest.updater?.frameworkSha256 === legacy.frameworkSha256
    && manifest.updater?.verifyBeforeExtraction === true;
}

function isExactPreMigrationDogfoodPreviousRelease(manifest) {
  const previous = PRE_MIGRATION_DOGFOOD_PREVIOUS_RELEASE;
  return manifest?.channel?.name === INTERNAL_DOGFOOD_RELEASE_CHANNEL
    && manifest.application?.bundleIdentifier === BUNDLE_IDENTIFIER
    && manifest.application?.bundleVersion === previous.bundleVersion
    && manifest.application?.shortVersion === previous.shortVersion
    && manifest.artifact?.sha256 === previous.artifactSha256
    && manifest.artifact?.bytes === previous.artifactBytes
    && manifest.artifact?.fileName === previous.artifactFileName
    && manifest.source?.repository === PUBLIC_RELEASE_SOURCE_REPOSITORY
    && manifest.source?.commit === previous.sourceCommit
    && manifest.source?.tag === previous.sourceTag
    && manifest.build?.sourceSha256 === previous.sourceSha256
    && manifest.build?.payloadSha256 === previous.payloadSha256
    && manifest.updater?.appcastURL === manifest.channel.sparkle.appcastURL
    && manifest.updater?.publicEdKeySha256 === previous.publicEdKeySha256
    && manifest.updater?.frameworkSha256 === previous.frameworkSha256
    && manifest.updater?.verifyBeforeExtraction === true;
}

function compareCandidateToPreviousBundleVersion(candidate, previous) {
  const comparison = compareAppleMacOSBundleVersionToPrevious(
    candidate,
    previous,
  );
  if (comparison === null) {
    macOSBundleVersionParts(candidate);
    if (!isLegacyZeroFirstMacOSBundleVersion(previous)) {
      macOSBundleVersionParts(previous);
    }
    fail(
      "Previous release contains an invalid legacy bundle version",
      "MACOS_REPLACEMENT_VERSION_INVALID",
    );
  }
  return comparison;
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
  if (!isAppleMacOSBundleVersion(candidateBundleVersion)
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
      { allowLegacyStableMigrationSource: true },
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
  if (compareCandidateToPreviousBundleVersion(
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
    {
      allowLegacyStableMigrationSource: true,
      allowLegacyDogfoodPreviousSource: true,
      allowPreMigrationDogfoodPreviousSource: true,
    },
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
  if (compareCandidateToPreviousBundleVersion(
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
  {
    allowLegacyStableMigrationSource = false,
    allowLegacyDogfoodPreviousSource = false,
    allowPreMigrationDogfoodPreviousSource = false,
  } = {},
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
  validateSignedReleaseManifest(manifest, label, {
    allowLegacyStableMigrationSource,
    allowLegacyDogfoodPreviousSource,
    allowPreMigrationDogfoodPreviousSource,
  });
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
  const candidateChannelName = validateSignedReleaseChannel(
    candidate.manifest,
    "Public installer",
  );
  if (artifactPath !== null && resolve(artifactPath) !== candidate.artifact) {
    fail(
      "Public installer path does not match the release manifest artifact",
      "MACOS_RELEASE_ARTIFACT_PATH_MISMATCH",
    );
  }
  await validateArtifact(candidate.artifact, {
    allowLegacyUnsealedSource: false,
    channel: candidateChannelName,
    production: true,
  });
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
    {
      allowLegacyStableMigrationSource: true,
      allowLegacyDogfoodPreviousSource: true,
      allowPreMigrationDogfoodPreviousSource: true,
    },
  );
  const candidate = await readReplacementReleaseArtifact(
    candidateReleaseManifestPath,
    "Candidate release",
  );
  const contract = validateMacOSSignedReplacementPair({
    previousManifest: previous.manifest,
    candidateManifest: candidate.manifest,
  });
  const previousIsExactLegacyStable =
    previous.manifest.channel.name === STABLE_RELEASE_CHANNEL
    && previous.manifest.application.bundleVersion
      === LEGACY_STABLE_MACOS_BUNDLE_VERSION
    && previous.manifest.application.shortVersion
      === LEGACY_STABLE_MACOS_BUNDLE_VERSION;
  const previousArtifactCapability = isExactLegacyDogfoodPreviousRelease(
    previous.manifest,
  ) ? Object.freeze({}) : null;
  if (previousArtifactCapability !== null) {
    VERIFIED_LEGACY_DOGFOOD_CAPABILITIES.add(previousArtifactCapability);
  }
  const preMigrationPreviousCapability = isExactPreMigrationDogfoodPreviousRelease(
    previous.manifest,
  ) ? Object.freeze({}) : null;
  if (preMigrationPreviousCapability !== null) {
    VERIFIED_PRE_MIGRATION_CAPABILITIES.add(preMigrationPreviousCapability);
  }
  try {
    await validateArtifact(previous.artifact, {
      allowLegacyUnsealedSource: previousIsExactLegacyStable,
      ...(previousArtifactCapability !== null ? {
        [VERIFIED_LEGACY_DOGFOOD_PREVIOUS_ARTIFACT]: previousArtifactCapability,
      } : {}),
      ...(preMigrationPreviousCapability !== null ? {
        [VERIFIED_PRE_MIGRATION_PREVIOUS_ARTIFACT]: preMigrationPreviousCapability,
      } : {}),
      channel: previous.manifest.channel.name,
      production: true,
    });
  } finally {
    // Even an injected validator that captures the token cannot reuse it after
    // the previous-side await settles (including a failed native validation).
    if (previousArtifactCapability !== null) {
      VERIFIED_LEGACY_DOGFOOD_CAPABILITIES.delete(previousArtifactCapability);
    }
    if (preMigrationPreviousCapability !== null) {
      VERIFIED_PRE_MIGRATION_CAPABILITIES.delete(preMigrationPreviousCapability);
    }
  }
  await validateArtifact(candidate.artifact, {
    allowLegacyUnsealedSource: false,
    channel: candidate.manifest.channel.name,
    production: true,
  });
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

function keychainMigrationSignatureFailure() {
  fail(
    "Keychain migration helper does not preserve the approved legacy reader signing boundary",
    "MACOS_KEYCHAIN_MIGRATION_SIGNATURE_INVALID",
  );
}

function normalizedDesignatedRequirement(value) {
  return value.replace(/\/\*\s*exists\s*\*\//gu, "")
    .replace(/\s+/gu, " ").trim()
    // codesign renders this simple identifier without quotes on some versions.
    // Canonicalize only the reviewed leading Node token, not arbitrary clauses.
    .replace(/^identifier node(?= and )/u, 'identifier "node"');
}

function keychainMigrationCodeDescription(description, identifier) {
  if (typeof description !== "string" || description.length > 128 * 1024) {
    keychainMigrationSignatureFailure();
  }
  const identifiers = [...description.matchAll(/^Identifier=([^\r\n]+)$/gmu)];
  const requirements = [...description.matchAll(/^designated => ([^\r\n]+)$/gmu)];
  if (identifiers.length !== 1 || identifiers[0][1] !== identifier
      || requirements.length !== 1
      || !/flags=0x[0-9a-f]+\(runtime\)/iu.test(description)) {
    keychainMigrationSignatureFailure();
  }
  let trust;
  try {
    trust = parseMacOSDeveloperIDNativeTrust(description);
  } catch {
    keychainMigrationSignatureFailure();
  }
  return {
    ...trust,
    requirement: normalizedDesignatedRequirement(requirements[0][1]),
    rawRequirement: requirements[0][1],
  };
}

/**
 * Validate the exact default Developer ID requirement used by the legacy Node
 * reader, not merely membership in its Team. Inputs are captured code-sign
 * metadata only; the result never exposes identities or requirements.
 */
export function validateMacOSKeychainMigrationSignatureDescriptions({
  application,
  node,
  helper,
  helperEntitlements,
} = {}) {
  const appDescription = keychainMigrationCodeDescription(application, BUNDLE_IDENTIFIER);
  const nodeDescription = keychainMigrationCodeDescription(node, "node");
  const helperDescription = keychainMigrationCodeDescription(
    helper,
    MACOS_KEYCHAIN_MIGRATION_HELPER.signingIdentifier,
  );
  const expectedRequirement = `identifier "node" and anchor apple generic `
    + "and certificate 1[field.1.2.840.113635.100.6.2.6] "
    + "and certificate leaf[field.1.2.840.113635.100.6.1.13] "
    + `and certificate leaf[subject.OU] = "${appDescription.teamIdentifier}"`;
  const emptyEntitlements = typeof helperEntitlements?.stdout === "string"
    && helperEntitlements.stdout.length <= 128 * 1024
    && (helperEntitlements.stdout.trim() === ""
      || /^\s*(?:<\?xml[^?]*\?>\s*)?(?:<!DOCTYPE plist[^>]*>\s*)?<plist version="1\.0">\s*(?:<dict\s*\/>|<dict>\s*<\/dict>)\s*<\/plist>\s*$/u
        .test(helperEntitlements.stdout));
  if (nodeDescription.teamIdentifier !== appDescription.teamIdentifier
      || helperDescription.teamIdentifier !== appDescription.teamIdentifier
      || nodeDescription.developerIdAuthority !== appDescription.developerIdAuthority
      || helperDescription.developerIdAuthority !== appDescription.developerIdAuthority
      || nodeDescription.requirement !== expectedRequirement
      || helperDescription.requirement !== nodeDescription.requirement
      || !emptyEntitlements
      || typeof helperEntitlements?.stderr !== "string"
      || helperEntitlements.stderr.length > 128 * 1024
      || /^\s*(?:warning|error):/imu.test(helperEntitlements.stderr)) {
    keychainMigrationSignatureFailure();
  }
  return Object.freeze({
    legacyNodeDesignatedRequirementMatched: true,
    sameDeveloperIDTeam: true,
    helperHardenedRuntime: true,
    helperEntitlementsAbsent: true,
  });
}

export function verifyMacOSKeychainMigrationSignatures(appPath, {
  commandRunner = runMacOSReleaseCommand,
  secrets = [],
} = {}) {
  const selected = resolve(appPath);
  const inspect = (relativePath) => {
    const result = commandRunner("/usr/bin/codesign", [
      "-d", "-r-", "--verbose=4", join(selected, ...relativePath.split("/")),
    ], {
      env: releaseEnvironment(),
      failureMessage: "Keychain migration signing metadata is unavailable",
      secrets,
    });
    return `${result.stdout}${result.stderr}`;
  };
  // A code-sign diagnostic can contain an identity or requirement even when
  // codesign fails. Keep this boundary's errors content-free in every case.
  try {
    const application = inspect(APP_EXECUTABLE);
    const node = inspect(NODE_EXECUTABLE);
    const helper = inspect(MACOS_KEYCHAIN_MIGRATION_HELPER.executable);
    const helperPath = join(selected, ...MACOS_KEYCHAIN_MIGRATION_HELPER.executable.split("/"));
    const helperEntitlements = commandRunner("/usr/bin/codesign", [
      "--display", "--entitlements", "-", "--xml", helperPath,
    ], {
      env: releaseEnvironment(),
      failureMessage: "Keychain migration helper entitlement inspection failed",
      secrets,
    });
    const result = validateMacOSKeychainMigrationSignatureDescriptions({
      application, node, helper, helperEntitlements,
    });
    const requirement = keychainMigrationCodeDescription(node, "node").rawRequirement;
    for (const relativePath of [NODE_EXECUTABLE, MACOS_KEYCHAIN_MIGRATION_HELPER.executable]) {
      commandRunner("/usr/bin/codesign", [
        "--verify", "--strict", `-R=${requirement}`,
        join(selected, ...relativePath.split("/")),
      ], {
        env: releaseEnvironment(),
        failureMessage: "Keychain migration reader requirement verification failed",
        secrets: [...secrets, requirement],
      });
    }
    return result;
  } catch {
    keychainMigrationSignatureFailure();
  }
}

export async function developerIDSignMacOSApp(appPath, {
  channel = STABLE_RELEASE_CHANNEL,
  identity,
  commandRunner = runMacOSReleaseCommand,
} = {}) {
  if (typeof identity !== "string" || identity.length === 0) {
    fail("Developer ID identity is required", "MACOS_DEVELOPER_ID_REQUIRED");
  }
  const inspected = await inspectMacOSApp(appPath, {
    channel,
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
    identifier = null,
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
    if (identifier !== null) {
      arguments_.push("--identifier", identifier);
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
  await validateNodeRuntimeEntitlements();
  sign(NODE_EXECUTABLE, { entitlements: NODE_ENTITLEMENTS });
  // Preserve the legacy Node reader's exact designated identity, but none of
  // Node's JIT exceptions. The native helper accepts only authenticated local
  // migration requests; it is not a general Node/keytar credential backend.
  sign(MACOS_KEYCHAIN_MIGRATION_HELPER.executable, {
    identifier: MACOS_KEYCHAIN_MIGRATION_HELPER.signingIdentifier,
  });
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
  verifyMacOSKeychainMigrationSignatures(inspected.appPath, {
    commandRunner,
    secrets,
  });
  return inspected;
}

export async function developerIDSignMacOSDMG(path, {
  identity,
  commandRunner = runMacOSReleaseCommand,
} = {}) {
  if (typeof identity !== "string" || identity.length === 0) {
    fail("Developer ID identity is required", "MACOS_DEVELOPER_ID_REQUIRED");
  }
  const selected = resolve(path);
  if (!selected.endsWith(".dmg") || basename(selected).startsWith(".")) {
    fail("Developer ID signing requires a visible DMG file");
  }
  await regularPath(selected);
  const secrets = [identity];
  commandRunner("/usr/bin/codesign", [
    "--force",
    "--timestamp",
    "--sign",
    identity,
    selected,
  ], {
    env: releaseEnvironment(),
    failureMessage: "Developer ID DMG signing failed",
    secrets,
  });
  commandRunner("/usr/bin/codesign", [
    "--verify",
    "--strict",
    "--verbose=2",
    selected,
  ], {
    env: releaseEnvironment(),
    failureMessage: "Developer ID DMG signature verification failed",
    secrets,
  });
  return Object.freeze({ path: selected });
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
  const packagedProductBrand = distribution === DMG_DISTRIBUTIONS.preview
    ? PREVIEW_PRODUCT_BRAND
    : PRODUCT_BRAND;
  const stagedApp = join(staging, packagedProductBrand.bundleName);
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
      packagedProductBrand.displayName,
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

function parseMacOSDeveloperIDNativeTrust(signature) {
  const authorities = [
    ...signature.matchAll(
      /^Authority=(Developer ID Application: [^\r\n]+ \(([A-Z0-9]{10})\))$/gmu,
    ),
  ];
  const teamIdentifiers = [
    ...signature.matchAll(/^TeamIdentifier=([A-Z0-9]{10})$/gmu),
  ];
  if (authorities.length !== 1
      || teamIdentifiers.length !== 1
      || authorities[0][2] !== teamIdentifiers[0][1]) {
    fail(
      "Installed application Developer ID identity is incomplete or ambiguous",
      "MACOS_DEVELOPER_ID_SIGNATURE_INVALID",
    );
  }
  return Object.freeze({
    developerIdAuthority: authorities[0][1],
    teamIdentifier: teamIdentifiers[0][1],
  });
}

export async function validateInstalledMacOSApp(appPath, {
  allowLegacyUnsealedSource = false,
  [VERIFIED_LEGACY_DOGFOOD_PREVIOUS_ARTIFACT]: legacyDogfoodPreviousCapability = null,
  [VERIFIED_PRE_MIGRATION_PREVIOUS_ARTIFACT]: preMigrationPreviousCapability = null,
  channel = "stable",
  expectedBundleIdentifier = null,
  expectedBundleVersion = null,
  expectedShortVersion = null,
  production = true,
} = {}) {
  validateLegacyDogfoodPreviousCapability(legacyDogfoodPreviousCapability);
  validatePreMigrationPreviousCapability(preMigrationPreviousCapability);
  const inspected = await inspectMacOSApp(appPath, {
    allowLegacyUnsealedSource,
    [VERIFIED_LEGACY_DOGFOOD_PREVIOUS_ARTIFACT]: legacyDogfoodPreviousCapability,
    [VERIFIED_PRE_MIGRATION_PREVIOUS_ARTIFACT]: preMigrationPreviousCapability,
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
  let nativeTrust = null;
  if (production) {
    const description = runMacOSReleaseCommand("/usr/bin/codesign", [
      "-d",
      "--verbose=4",
      inspected.appPath,
    ], {
      failureMessage: "Installed application signature inspection failed",
    });
    const signature = `${description.stdout}${description.stderr}`;
    if (!/flags=0x[0-9a-f]+\(runtime\)/iu.test(signature)) {
      fail("Installed application is not Developer ID hardened");
    }
    nativeTrust = parseMacOSDeveloperIDNativeTrust(signature);
    if (inspected.buildManifest.runtime?.keychainMigrationHelper !== undefined) {
      verifyMacOSKeychainMigrationSignatures(inspected.appPath);
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
  const result = {
    bundleIdentifier: inspected.bundleIdentifier,
    production,
    shortVersion: inspected.shortVersion,
  };
  if (production) result.source = inspected.source;
  if (nativeTrust !== null) {
    result.developerIdAuthority = nativeTrust.developerIdAuthority;
    result.teamIdentifier = nativeTrust.teamIdentifier;
  }
  return Object.freeze(result);
}

export async function validateMacOSDMG(path, {
  allowLegacyUnsealedSource = false,
  [VERIFIED_LEGACY_DOGFOOD_PREVIOUS_ARTIFACT]: legacyDogfoodPreviousCapability = null,
  [VERIFIED_PRE_MIGRATION_PREVIOUS_ARTIFACT]: preMigrationPreviousCapability = null,
  channel = "stable",
  distribution = null,
  expectedBundleIdentifier = null,
  expectedBundleVersion = null,
  expectedShortVersion = null,
  production = true,
} = {}) {
  const legacyDogfoodPrevious = validateLegacyDogfoodPreviousCapability(
    legacyDogfoodPreviousCapability,
  );
  const preMigrationPrevious = validatePreMigrationPreviousCapability(
    preMigrationPreviousCapability,
  );
  const selectedDistribution = distribution ?? (
    production ? DMG_DISTRIBUTIONS.release : DMG_DISTRIBUTIONS.development
  );
  if (typeof allowLegacyUnsealedSource !== "boolean"
      || (allowLegacyUnsealedSource && !production)
      || !Object.values(DMG_DISTRIBUTIONS).includes(selectedDistribution)
      || production !== (selectedDistribution === DMG_DISTRIBUTIONS.release)) {
    fail(
      "DMG validation distribution does not match its production policy",
      "MACOS_DMG_DISTRIBUTION_INVALID",
    );
  }
  const expectedProductBrand = selectedDistribution
      === DMG_DISTRIBUTIONS.preview
    ? PREVIEW_PRODUCT_BRAND
    : PRODUCT_BRAND;
  const selected = resolve(path);
  const metadata = await regularPath(selected);
  if (legacyDogfoodPrevious
      && (!production || channel !== INTERNAL_DOGFOOD_RELEASE_CHANNEL
        || metadata.size !== LEGACY_DOGFOOD_PREVIOUS_RELEASE.artifactBytes
        || await sha256File(selected)
          !== LEGACY_DOGFOOD_PREVIOUS_RELEASE.artifactSha256)) {
    fail(
      "Legacy dogfood source compatibility requires the exact previous DMG bytes",
      "MACOS_LEGACY_SOURCE_COMPATIBILITY_INVALID",
    );
  }
  if (preMigrationPrevious
      && (!production || channel !== INTERNAL_DOGFOOD_RELEASE_CHANNEL
        || metadata.size !== PRE_MIGRATION_DOGFOOD_PREVIOUS_RELEASE.artifactBytes
        || await sha256File(selected)
          !== PRE_MIGRATION_DOGFOOD_PREVIOUS_RELEASE.artifactSha256)) {
    fail(
      "Pre-migration helper compatibility requires the exact previous DMG bytes",
      "MACOS_KEYCHAIN_MIGRATION_COMPATIBILITY_INVALID",
    );
  }
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
        || names[1] !== expectedProductBrand.bundleName) {
      fail(
        `DMG layout must contain only Applications and ${expectedProductBrand.bundleName}`,
      );
    }
    await validateMacOSApplicationsLink(
      join(attached.mountPoint, "Applications"),
    );
    const installedApp = join(
      isolatedRoot,
      "Applications",
      expectedProductBrand.bundleName,
    );
    await mkdir(dirname(installedApp), { recursive: true, mode: 0o755 });
    runMacOSReleaseCommand("/usr/bin/ditto", [
      "--noqtn",
      join(attached.mountPoint, expectedProductBrand.bundleName),
      installedApp,
    ], {
      failureMessage: "Mounted application copy failed",
    });
    if (selectedDistribution === DMG_DISTRIBUTIONS.preview) {
      const inspectedPreview = await validateMacOSPreviewApp(installedApp);
      if ((expectedBundleIdentifier !== null
          && inspectedPreview.bundleIdentifier !== expectedBundleIdentifier)
          || (expectedBundleVersion !== null
            && inspectedPreview.bundleVersion !== expectedBundleVersion)
          || (expectedShortVersion !== null
            && inspectedPreview.shortVersion !== expectedShortVersion)) {
        fail(
          "Installed preview metadata does not match the expected artifact",
          "MACOS_RELEASE_ARTIFACT_METADATA_MISMATCH",
        );
      }
      return Object.freeze({
        bundleIdentifier: inspectedPreview.bundleIdentifier,
        production: false,
        shortVersion: inspectedPreview.shortVersion,
      });
    }
    return await validateInstalledMacOSApp(installedApp, {
      allowLegacyUnsealedSource,
      [VERIFIED_LEGACY_DOGFOOD_PREVIOUS_ARTIFACT]: legacyDogfoodPreviousCapability,
      [VERIFIED_PRE_MIGRATION_PREVIOUS_ARTIFACT]: preMigrationPreviousCapability,
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
  // Bind the signed receipt to the exact public checkout that passed the
  // clean, annotated-tag gate. The source object is deliberately reduced to
  // a canonical public URL plus immutable tag/commit values; no local path or
  // raw Git remote is ever written to a customer-facing artifact.
  const credentials = readMacOSReleaseCredentials(environment);
  const inspectedCandidate = await inspectMacOSApp(appPath, {
    channel: releaseChannel.name,
    requireExternalDistribution: true,
  });
  const source = readMacOSReleaseSourceProvenance({
    channel: releaseChannel.name,
    expectedVersion: inspectedCandidate.shortVersion,
  });
  if (inspectedCandidate.source?.commit !== source.commit
      || inspectedCandidate.source?.tag !== source.tag) {
    fail(
      "Reviewed candidate is sealed to a different release source",
      "MACOS_RELEASE_CANDIDATE_SOURCE_MISMATCH",
    );
  }
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
          !== inspectedCandidate.buildManifest.payload?.totalBytes
        || inspected.source?.commit !== source.commit
        || inspected.source?.tag !== source.tag
        || inspected.source?.commit !== inspectedCandidate.source?.commit
        || inspected.source?.tag !== inspectedCandidate.source?.tag) {
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
      channel: releaseChannel.name,
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
    await developerIDSignMacOSDMG(stagedDMG, {
      identity: credentials.identity,
    });
    submitToAppleNotary(stagedDMG, {
      notaryProfile: credentials.notaryProfile,
    });
    stapleAndValidate(stagedDMG);
    const validatedDMG = await validateMacOSDMG(stagedDMG, {
      channel: releaseChannel.name,
      production: true,
    });
    if (validatedDMG.source?.commit !== source.commit
        || validatedDMG.source?.tag !== source.tag) {
      fail(
        "Packaged DMG is sealed to a different release source",
        "MACOS_RELEASE_ARTIFACT_SOURCE_MISMATCH",
      );
    }

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
      source,
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
