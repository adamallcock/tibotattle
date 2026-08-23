import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  appendFile,
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
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PRODUCT_BRAND,
  validateStateDirectoryName,
} from "../config/product-brand.js";
import {
  RELEASE_MANIFEST,
  RELEASE_VERSION,
} from "../config/release-manifest.js";
import { DEPLOYMENT_ENDPOINTS } from "../config/deployment-endpoints.js";
import {
  INTERNAL_DOGFOOD_RELEASE_CHANNEL,
  INTERNAL_DOGFOOD_SERVICE_ORIGIN_MODE,
  RELEASE_CHANNELS_SCHEMA_VERSION,
  STABLE_RELEASE_CHANNEL,
  assertReleaseChannelConfiguration,
  createReleaseChannelProvenance,
  getReleaseChannel,
} from "../config/release-channels.js";
import {
  MACOS_RUNTIME_STATIC_ASSETS,
  MACOS_ACCOUNTING_RUNTIME_FILES,
  MACOS_BUILD_PROFILES,
  MACOS_IDENTITY_CORE_RUNTIME_FILES,
  MACOS_PREVIEW_DISTRIBUTION_CHANNEL,
  MACOS_QUOTA_ANALYSIS_RUNTIME_FILES,
  MACOS_TELEMETRY_CONTRACT_RUNTIME_FILES,
  MACOS_WEB_MODULE_ENTRYPOINTS,
  buildMacOSApp,
  buildMacOSAppForRelease,
  buildMacOSReleaseCandidate,
  collectMacOSLocalizationResources,
  collectMacOSRuntimeGraph,
  collectMacOSSwiftSources,
  collectMacOSWebModuleGraph,
  collectVerifiedMacOSWebModuleGraph,
  captureMacOSWorkspaceRuntimePackages,
  calculateMacOSSourceInputDigest,
  assertMacOSWebModuleInventory,
  assertMacOSWorkspaceRuntimePackageInventory,
  assertMacOSExternalBuildOutputIsFresh,
  normalizeMacOSBundleVersion,
  normalizeMacOSBuildProfile,
  normalizeMacOSCentralOrigin,
  parseMacOSBuildArguments,
  pinnedPackage,
  pinnedPackageTreeDigest,
  stageMacOSWebModules,
  stageMacOSWorkspaceRuntimePackages,
  installMacOSExternalBuildOutput,
  validateMacOSPreviewApp,
  validateMacOSPreviewOutputPath,
  validateMacOSDistributionConfiguration,
} from "../scripts/build-macos-app.js";
import {
  readVerifiedTelemetryBrowserMirror,
} from "../scripts/generate-telemetry-browser-mirror.js";
import {
  compareMacOSBundleVersions,
  createMacOSSignedReplacementContract,
  assertStableSparkleKeyContinuity,
  developerIDSignMacOSApp,
  developerIDSignMacOSDMG,
  inspectMacOSApp,
  packageMacOSDMG,
  prepareMacOSReleaseCandidate,
  readMacOSReleaseSourceProvenance,
  readMacOSReleaseBuildConfiguration,
  readMacOSReleaseCredentials,
  readStableReleaseManifest,
  submitToAppleNotary,
  validateNodeRuntimeEntitlements,
  validateMacOSSignedReplacementArtifacts,
  validateMacOSSignedReplacementPair,
  validateMacOSApplicationsLink,
  validateMacOSDMG,
  validateMacOSLoginItemReleaseRehearsal,
} from "../scripts/macos-release-core.js";
import {
  parseArguments as parseMacOSDMGArguments,
} from "../scripts/package-macos-dmg.js";
import {
  SPARKLE_FRAMEWORK_LINKS,
  SPARKLE_FRAMEWORK_SHA256,
  SPARKLE_MACH_O_PATHS,
  SPARKLE_VERSION,
  normalizeMacOSUpdaterConfiguration,
} from "../scripts/macos-updater-core.js";
import {
  resetLocalKeychainIdentityAndDevice,
} from "../apps/macos/reset-local-keychain.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  exportIdentityKeychainAttributeDeleteArguments,
  exportIdentityKeychainAttributeProbeArguments,
} from "../src/export-identity-keychain.js";
import {
  CONTRIBUTION_DEVICE_KEYCHAIN_BROKER_FD_ENV,
} from "../src/contribution-device-keychain-broker.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SWIFT_SOURCE = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "UsageMonitorApp.swift",
);
const SEMANTIC_OPEN_TARGET_SOURCE = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "Sources",
  "SemanticOpenTarget.swift",
);
const MENU_BAR_STATUS_SOURCE = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "Sources",
  "MenuBarStatus.swift",
);
const KEYCHAIN_BROKER_SOURCE = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "Sources",
  "KeychainBroker.swift",
);
const QUOTA_NOTIFICATIONS_SOURCE = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "Sources",
  "QuotaNotifications.swift",
);
const LOCALIZATION_SOURCE = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "Sources",
  "Localization.swift",
);
const BUILD_SCRIPT = join(
  REPOSITORY_ROOT,
  "scripts",
  "build-macos-app.js",
);
const RELEASE_CORE = join(
  REPOSITORY_ROOT,
  "scripts",
  "macos-release-core.js",
);
const MAC_APP_STORE_ENTITLEMENTS = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "MacAppStore.entitlements",
);
const MAC_APP_STORE_NODE_ENTITLEMENTS = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "MacAppStoreNodeRuntime.entitlements",
);
const BUILD_SUPPORTED =
  process.platform === "darwin"
  && process.arch === "arm64"
  && process.version === "v26.2.0";
const MACOS_TEST_LANES_ACTIVE = process.env.USAGE_MONITOR_TEST_LANES === "1";
const MACOS_TEST_SCOPE = MACOS_TEST_LANES_ACTIVE
  ? process.env.USAGE_MONITOR_MACOS_TEST_SCOPE ?? "all"
  : "all";
if (MACOS_TEST_LANES_ACTIVE
    && !new Set(["all", "source", "artifact"]).has(MACOS_TEST_SCOPE)) {
  throw new Error(
    "USAGE_MONITOR_MACOS_TEST_SCOPE must be one of all, source, or artifact",
  );
}

const SYNTHETIC_DOGFOOD_PUBLIC_KEY = Buffer.alloc(32, 7).toString("base64");
const SYNTHETIC_DOGFOOD_PUBLIC_KEY_SHA256 = createHash("sha256")
  .update(Buffer.from(SYNTHETIC_DOGFOOD_PUBLIC_KEY, "base64"))
  .digest("hex");

function syntheticDogfoodReleaseChannel() {
  return {
    schemaVersion: RELEASE_CHANNELS_SCHEMA_VERSION,
    name: INTERNAL_DOGFOOD_RELEASE_CHANNEL,
    configured: true,
    buildManifestChannel: INTERNAL_DOGFOOD_RELEASE_CHANNEL,
    serviceOriginMode: INTERNAL_DOGFOOD_SERVICE_ORIGIN_MODE,
    serviceOrigin: "https://dogfood.tibotattle.example",
    publicWebsiteOrigin: "https://dogfood.tibotattle.example",
    sparkle: {
      origin: "https://updates.dogfood.tibotattle.example",
      appcastURL:
        "https://updates.dogfood.tibotattle.example/internal-dogfood/appcast.xml",
      appcastObjectKey: "internal-dogfood/appcast.xml",
      r2Bucket: "tibotattle-dogfood-updates",
      objectPrefix: "internal-dogfood/releases",
      atomicGuardURL:
        "https://release.dogfood.tibotattle.example/api/v1/internal/release/appcast",
      publicEdKeySha256: SYNTHETIC_DOGFOOD_PUBLIC_KEY_SHA256,
    },
  };
}

function macOSArtifactTest(name, options, body) {
  return test(name, {
    ...options,
    skip: MACOS_TEST_SCOPE === "source"
      ? "excluded by the macOS source-only lane"
      : options.skip,
  }, body);
}

test("reviewed product brand owns the native bundle and semantic-open identity", () => {
  assert.equal(Object.isFrozen(PRODUCT_BRAND), true);
  assert.deepEqual(PRODUCT_BRAND, {
    displayName: "TiboTattle",
    bundleName: "TiboTattle.app",
    executableName: "TiboTattle",
    bundleIdentifier: "com.usagemonitor.local",
    appOpenScheme: "usagemonitor",
    appOpenHost: "open",
    appOpenURL: "usagemonitor://open",
    stateDirectoryName: "Usage Monitor",
    monitoredAppDisplayName: "Codex",
    monitoredAppBundleIdentifier: "com.openai.codex",
  });
  assert.equal(
    PRODUCT_BRAND.appOpenURL,
    `${PRODUCT_BRAND.appOpenScheme}://${PRODUCT_BRAND.appOpenHost}`,
  );
});

test("state directory branding rejects filesystem aliases", () => {
  assert.equal(validateStateDirectoryName("Quota Compass"), "Quota Compass");
  for (const unsafe of [".", "..", "nested/name", "volume:name", ""]) {
    assert.throws(
      () => validateStateDirectoryName(unsafe),
      /Invalid product-brand value: stateDirectoryName/u,
    );
  }
});

test("local-companion readiness stays machine-readable across rebrands", async () => {
  const [serverSource, swiftSource] = await Promise.all([
    readFile(join(REPOSITORY_ROOT, "apps", "local", "server.js"), "utf8"),
    readFile(SWIFT_SOURCE, "utf8"),
  ]);
  const protocolMarker = "USAGE_MONITOR_READY";
  assert.match(
    serverSource,
    /process\.stdout\.write\(`USAGE_MONITOR_READY http:\/\/\$\{app\.host\}:\$\{app\.port\}\/\\n`\)/u,
  );
  assert.equal(
    swiftSource.includes(
      '#"^USAGE_MONITOR_READY http://127\\.0\\.0\\.1:([0-9]{1,5})/$"#',
    ),
    true,
  );
  assert.equal(protocolMarker.includes(PRODUCT_BRAND.displayName), false);
  assert.equal(protocolMarker.includes("Quota Compass"), false);
  assert.doesNotMatch(serverSource, /Usage Monitor is available at/u);
  assert.doesNotMatch(swiftSource, /Usage Monitor is available at/u);
});

async function walk(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, path));
    else files.push({
      entry,
      path,
      relativePath: relative(root, path).split(sep).join("/"),
    });
  }
  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath));
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const NORMALIZED_TEST_CODE_PATHS = new Set([
  "Contents/MacOS/TiboTattle",
  "Contents/Resources/runtime/bin/node",
  "Contents/Resources/app/node_modules/@github/keytar/prebuilds/darwin-arm64/keytar.node",
  ...SPARKLE_MACH_O_PATHS.map(
    (path) => `Contents/Frameworks/Sparkle.framework/${path}`,
  ),
]);

function canonicalizeTestMachO(bytes) {
  assert.equal(
    bytes.subarray(0, 4).toString("hex"),
    "cffaedfe",
    "expected a thin arm64 Mach-O",
  );
  const canonical = Buffer.from(bytes);
  const commandCount = canonical.readUInt32LE(16);
  const commandBytes = canonical.readUInt32LE(20);
  let offset = 32;
  let linkEditFound = false;
  for (let index = 0; index < commandCount; index += 1) {
    assert.equal(offset + 8 <= 32 + commandBytes, true);
    const command = canonical.readUInt32LE(offset);
    const size = canonical.readUInt32LE(offset + 4);
    assert.equal(size >= 8 && offset + size <= 32 + commandBytes, true);
    if (command === 0x19 && size >= 72) {
      const segment = canonical.subarray(offset + 8, offset + 24)
        .toString("ascii")
        .replace(/\0.*$/u, "");
      if (segment === "__LINKEDIT") {
        assert.equal(linkEditFound, false);
        linkEditFound = true;
        canonical.writeBigUInt64LE(0n, offset + 32);
        canonical.writeBigUInt64LE(0n, offset + 48);
      }
    }
    offset += size;
  }
  assert.equal(linkEditFound, true);
  return canonical;
}

async function testPayloadBytes(path, relativePath, temporaryRoot) {
  if (!NORMALIZED_TEST_CODE_PATHS.has(relativePath)) {
    return readFile(path);
  }
  const normalizationRoot = await mkdtemp(
    join(temporaryRoot, ".normalized-macho-"),
  );
  const normalized = join(normalizationRoot, "payload");
  try {
    await copyFile(path, normalized);
    await chmod(normalized, 0o700);
    execFileSync("/usr/bin/codesign", [
      "--remove-signature",
      normalized,
    ], { stdio: "ignore" });
    return canonicalizeTestMachO(await readFile(normalized));
  } finally {
    await rm(normalizationRoot, { recursive: true, force: true });
  }
}

async function testPayloadInventory(app, temporaryRoot) {
  const walked = await walk(app);
  const files = walked.filter(({ relativePath, entry }) =>
    entry.isFile()
    && ![
      "Contents/Resources/build-manifest.json",
      "Contents/_CodeSignature/CodeResources",
    ].includes(relativePath));
  const aggregate = createHash("sha256");
  const inventory = [];
  let totalBytes = 0;
  for (const file of files) {
    const normalization = NORMALIZED_TEST_CODE_PATHS.has(file.relativePath)
      ? "mach_o_without_code_signature"
      : "raw";
    const bytes = await testPayloadBytes(
      file.path,
      file.relativePath,
      temporaryRoot,
    );
    const metadata = await lstat(file.path);
    const entry = {
      bytes: bytes.length,
      mode: (metadata.mode & 0o777).toString(8).padStart(3, "0"),
      normalization,
      path: file.relativePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    inventory.push(entry);
    totalBytes += bytes.length;
    aggregate.update(entry.path);
    aggregate.update("\0");
    aggregate.update(bytes);
    aggregate.update("\0");
  }
  const links = [];
  for (const link of walked.filter(({ entry }) =>
    entry.isSymbolicLink())) {
    const target = await readlink(link.path);
    links.push({ path: link.relativePath, target });
  }
  links.sort((left, right) => left.path.localeCompare(right.path));
  for (const link of links) {
    aggregate.update(link.path);
    aggregate.update("\0link\0");
    aggregate.update(link.target);
    aggregate.update("\0");
  }
  return {
    files: inventory,
    links,
    payloadSha256: aggregate.digest("hex"),
    totalBytes,
  };
}

function waitForOutputLine(child, pattern, timeoutMs = 20_000) {
  return new Promise((resolveLine, rejectLine) => {
    let output = "";
    let errorOutput = "";
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onErrorData);
      child.off("exit", onExit);
    };
    const onData = (chunk) => {
      output = `${output}${chunk}`.slice(-8_192);
      const lines = output.split("\n");
      for (const line of lines.slice(0, -1)) {
        const match = pattern.exec(line);
        if (match) {
          cleanup();
          resolveLine(match);
          return;
        }
      }
      output = lines.at(-1) ?? "";
    };
    const onErrorData = (chunk) => {
      errorOutput = `${errorOutput}${chunk}`.slice(-4_096);
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectLine(new Error(
        `watchdog launcher exited before readiness (${code ?? signal}): ${errorOutput}`,
      ));
    };
    const timeout = setTimeout(() => {
      cleanup();
      rejectLine(new Error(
        `watchdog launcher readiness timed out: ${errorOutput}`,
      ));
    }, timeoutMs);
    child.stdout.on("data", onData);
    child.stderr.on("data", onErrorData);
    child.once("exit", onExit);
  });
}

function processIsAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function processCommand(processId) {
  const result = spawnSync("/bin/ps", [
    "-p",
    String(processId),
    "-o",
    "command=",
  ], {
    encoding: "utf8",
    timeout: 2_000,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function isExpectedCompanionProcess(processId, entrypoint) {
  return processIsAlive(processId)
    && processCommand(processId)?.includes(entrypoint) === true;
}

async function waitForProcessExit(
  processId,
  entrypoint,
  timeoutMs = 12_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isExpectedCompanionProcess(processId, entrypoint)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return !isExpectedCompanionProcess(processId, entrypoint);
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function runCaptured(command, arguments_, options = {}, timeoutMs = 30_000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-16_384);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        rejectRun(new Error(`child timed out: ${stderr || stdout}`));
        return;
      }
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

function buildOutputValue(output, label) {
  const line = output.split("\n").find((candidate) =>
    candidate.startsWith(`${label}: `));
  assert.notEqual(line, undefined, `missing ${label} from macOS build output`);
  return line.slice(`${label}: `.length);
}

async function buildMacOSAppInIndependentProcess(output) {
  const result = await runCaptured(
    process.execPath,
    [BUILD_SCRIPT, "--output", output],
    { cwd: REPOSITORY_ROOT },
    120_000,
  );
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null, result.stderr || result.stdout);
  const totalBytes = Number(buildOutputValue(result.stdout, "Payload bytes"));
  assert.equal(Number.isSafeInteger(totalBytes), true);
  return Object.freeze({
    buildProfile: buildOutputValue(result.stdout, "Compiler profile"),
    output: buildOutputValue(result.stdout, "Output"),
    payloadSha256: buildOutputValue(result.stdout, "Payload SHA-256"),
    sourceSha256: buildOutputValue(result.stdout, "Source SHA-256"),
    totalBytes,
  });
}

test("native launcher keeps the requested foreground-only lifecycle", async () => {
  const [
    source,
    semanticOpenTargetSource,
    menuBarStatusSource,
    loginItemSource,
    localizationSource,
  ] = await Promise.all([
    readFile(SWIFT_SOURCE, "utf8"),
    readFile(SEMANTIC_OPEN_TARGET_SOURCE, "utf8"),
    readFile(MENU_BAR_STATUS_SOURCE, "utf8"),
    readFile(
      join(REPOSITORY_ROOT, "apps", "macos", "Sources", "LoginItemManager.swift"),
      "utf8",
    ),
    readFile(
      join(REPOSITORY_ROOT, "apps", "macos", "Sources", "Localization.swift"),
      "utf8",
    ),
  ]);
  const firstRunDisclosureSource = source.slice(
    source.indexOf("private func showFirstRunDisclosure"),
    source.indexOf("private func startCompanion"),
  );
  const companionProcessSource = source.slice(
    source.indexOf("private final class CompanionProcess"),
    source.indexOf("private struct LocalKeychainResetResult"),
  );
  assert.match(source, /import AppKit/u);
  assert.match(source, /"USAGE_MONITOR_PORT": "0"/u);
  assert.match(source, /"USAGE_MONITOR_RESOURCE_ROOT"/u);
  assert.match(source, /"USAGE_MONITOR_STATE_ROOT"/u);
  assert.match(
    source,
    /for root in configuration\.roots \{[\s\S]*?arguments\.append\("--codex-home"\)[\s\S]*?arguments\.append\(root\.url\.path\)[\s\S]*?arguments\.append\("--primary-codex-home"\)/u,
  );
  assert.match(
    companionProcessSource,
    /trailing: codexHomeLaunchArguments\(codexHomeConfiguration\)/u,
  );
  assert.match(
    companionProcessSource,
    /"CODEX_HOME": codexHomeConfiguration\.url\.path/u,
  );
  assert.doesNotMatch(
    companionProcessSource,
    /"CODEX_HOME"[^\n]*(?:joined|separator|delimiter)/iu,
  );
  assert.match(source, /"USAGE_MONITOR_CENTRAL_ORIGIN"/u);
  assert.match(source, /UsageMonitorCentralOriginMode/u);
  assert.match(source, /BundledProduct\.publicWebsiteOrigin/u);
  assert.match(
    source,
    /"USAGE_MONITOR_PARENT_PID": String\(getpid\(\)\)/u,
  );
  assert.match(
    source,
    /Application Support[\s\S]*BundledProduct\.stateDirectoryName/u,
  );
  assert.match(source, /O_DIRECTORY \| O_NOFOLLOW/u);
  assert.match(source, /fchmod\(descriptor, 0o700\)/u);
  assert.match(
    source,
    /title: TiboTattleLocalization\.string\(\.settingsOpenDashboard\)/u,
  );
  assert.match(source, /title: TiboTattleLocalization\.string\(\.launcherRetry\)/u);
  assert.match(source, /title: TiboTattleLocalization\.string\(\.menuSettings\)/u);
  assert.match(
    source,
    /title: TiboTattleLocalization\.string\(\.launcherDataDiagnostics\)/u,
  );
  assert.match(
    source,
    /title: TiboTattleLocalization\.string\(\.settingsAddCodexFolder\)/u,
  );
  assert.match(
    source,
    /title: TiboTattleLocalization\.format\([\s\S]*?\.menuAboutProduct[\s\S]*?BundledProduct\.displayName/u,
  );
  assert.doesNotMatch(
    source,
    /title: "Open \\\(BundledProduct\.monitoredAppDisplayName\)"/u,
  );
  assert.doesNotMatch(
    source,
    /withBundleIdentifier: BundledProduct\.monitoredAppBundleIdentifier/u,
  );
  assert.match(
    source,
    /TiboTattleLocalization\.string\(\.dialogCopyDiagnostics\)/u,
  );
  assert.match(source, /usage-monitor-macos-diagnostics-v1/u);
  assert.match(
    menuBarStatusSource,
    /path: "\/api\/local\/diagnostics\/contribution"/u,
  );
  assert.match(
    menuBarStatusSource,
    /local-contribution-diagnostics-v0\.1/u,
  );
  assert.match(source, /func readContributionDiagnostics\(/u);
  assert.match(source, /private struct ContributionDiagnosticsSnapshot/u);
  assert.match(source, /contribution_tokens_included: false/u);
  assert.match(source, /contribution_oauth_state_included: false/u);
  assert.match(source, /contribution_device_identifiers_included: false/u);
  assert.match(source, /contribution_content_included: false/u);
  assert.match(source, /UM_MACOS_COMPANION_START_TIMEOUT/u);
  assert.match(source, /companionStartupTimeoutSeconds/u);
  assert.match(source, /NSOpenPanel/u);
  assert.match(source, /launcher-settings-v1\.json/u);
  assert.match(source, /usage-monitor-launcher-settings-v2/u);
  assert.match(source, /usage-monitor-launcher-settings-v1/u);
  assert.match(source, /private let maximumCodexActivityRoots = 8/u);
  assert.match(source, /let activityRoots: \[LauncherActivityRoot\]/u);
  assert.match(source, /let primaryRootId: UUID/u);
  assert.match(
    source,
    /Set\(configuration\.roots\.map\(\\\.id\)\)\.count == configuration\.roots\.count/u,
  );
  assert.match(
    source,
    /Set\(object\.keys\) == \[[\s\S]*?"schemaVersion", "activityRoots", "primaryRootId"/u,
  );
  assert.match(
    source,
    /Set\(root\.keys\) == \["rootId", "path", "enabled"\]/u,
  );
  assert.match(
    source,
    /settings\.activityRoots\.allSatisfy\(\{ root in[\s\S]*?root\.enabled[\s\S]*?\.path == root\.path/u,
  );
  assert.match(
    source,
    /private func validatedUnavailablePersistedCodexHome[\s\S]*?finalStatus != 0, errno == ENOENT[\s\S]*?\(metadata\.st_mode & S_IFMT\) != S_IFLNK/u,
  );
  const configurationValidationSource = source.slice(
    source.indexOf("private func validatedCodexHomeConfiguration"),
    source.indexOf("private func writeCodexHomeConfiguration"),
  );
  assert.match(
    configurationValidationSource,
    /root\.id == defaultCodexActivityRootID[\s\S]*?root\.url\.path == defaultHome\.path/u,
  );
  assert.match(
    configurationValidationSource,
    /validatedCustomCodexHome\(root\.url\)[\s\S]*?validatedUnavailablePersistedCodexHome/u,
  );
  assert.doesNotMatch(
    configurationValidationSource,
    /validatedURL = defaultHome/u,
  );
  assert.match(
    source,
    /unavailableAllowedRootIDs: Set\(\s*settings\.activityRoots\.map\(\\\.rootId\)\s*\)/u,
  );
  assert.match(
    source,
    /private func removeCodexHome[\s\S]*?configuration\.primaryRootID != rootID/u,
  );
  assert.match(source, /--codex-home-settings-reload-smoke-test/u);
  assert.match(source, /--codex-home-reachability-smoke-test/u);
  assert.match(source, /--codex-home-restart-gate-smoke-test/u);
  assert.match(source, /--codex-home-quit-during-stop-smoke-test/u);
  assert.match(source, /settingsCodexFolderDefaultLocation/u);
  // A rejected Codex-home selection must answer as an alert at the
  // frontmost Settings window: the main window's failure surface sits
  // behind it, and the companion keeps running with the previous folder.
  const codexHomeSelectionSource = source.slice(
    source.indexOf("private func presentCodexHomeSelectionRejection"),
    source.indexOf("private func restartCompanionAfterCodexHomeChange"),
  );
  assert.match(codexHomeSelectionSource, /NSOpenPanel\(\)/u);
  assert.match(codexHomeSelectionSource, /launcherErrorInvalidCodexHome/u);
  assert.match(
    codexHomeSelectionSource,
    /let alert = NSAlert\(\)[\s\S]*?\.launcherFailureDetails[\s\S]*?launcherError\.failureCode,\s*launcherError\.recoverySuggestion/u,
  );
  assert.match(
    codexHomeSelectionSource,
    /beginSheetModal\(for: settingsWindow\)/u,
  );
  assert.match(codexHomeSelectionSource, /alert\.runModal\(\)/u);
  assert.match(
    codexHomeSelectionSource,
    /catch \{\s*presentCodexHomeSelectionRejection\(error\)\s*\}/u,
  );
  assert.doesNotMatch(codexHomeSelectionSource, /showFailure/u);
  assert.match(source, /func addCodexHomeFromSettings/u);
  assert.match(codexHomeSelectionSource, /func removeCodexHomeFromSettings/u);
  assert.match(codexHomeSelectionSource, /func setPrimaryCodexHomeFromSettings/u);
  assert.match(
    codexHomeSelectionSource,
    /removeCodexHomeFromSettings[\s\S]*?includingPrimary: false/u,
  );
  assert.match(
    localizationSource,
    /Removing this folder stops future reading but retains imported history/iu,
  );
  assert.match(
    localizationSource,
    /Add 1–8 folders only when you intend[\s\S]*cannot verify account equivalence/iu,
  );
  assert.match(
    source,
    /private func codexActivityRootReachability[\s\S]*?\.ready[\s\S]*?\.temporarilyUnavailable[\s\S]*?\.invalid/u,
  );
  assert.match(
    source,
    /settingsUseDefaultCodexHomeButton\?\.isEnabled = controlsEnabled/u,
  );
  assert.match(
    source,
    /private struct CodexHomeRestartGate[\s\S]*?case \.stopping:[\s\S]*?return \.none[\s\S]*?case \.starting:[\s\S]*?restartRequestedWhileStarting = true/u,
  );
  assert.match(
    source,
    /private func restartCompanionAfterCodexHomeChange[\s\S]*?codexHomeRestartGate\.requestRestart\(\)[\s\S]*?stopCurrentCompanionForCodexHomeRestart/u,
  );
  assert.match(source, /private var stoppingCompanion: CompanionProcess\?/u);
  assert.match(
    source,
    /private func stopCurrentCompanionForCodexHomeRestart[\s\S]*?stoppingCompanion = previous[\s\S]*?previous\.stop[\s\S]*?stoppingCompanion === previous[\s\S]*?stoppingCompanion = nil[\s\S]*?codexHomeRestartCompanionStopped/u,
  );
  assert.match(
    source,
    /private func codexHomeRestartCompanionStopped[\s\S]*?guard !quitting else \{ return \}/u,
  );
  const terminationSource = source.slice(
    source.indexOf("func applicationShouldTerminate"),
    source.indexOf("// Sign in with Apple"),
  );
  assert.match(
    terminationSource,
    /let ownedCompanion = companionToAwaitOnTermination\([\s\S]*?stopping: stoppingCompanion[\s\S]*?codexHomeRestartGate\.cancel\(\)[\s\S]*?ownedCompanion\.stop/u,
  );
  assert.match(
    terminationSource,
    /func applicationWillTerminate[\s\S]*?companionToAwaitOnTermination\([\s\S]*?stopping: stoppingCompanion[\s\S]*?ownedCompanion\.stop/u,
  );
  assert.doesNotMatch(source, /codexHomeButton|showCodexHomeOptions/u);
  // Settings may name every selected folder, tilde-abbreviated; Data &
  // Diagnostics keeps paths_included/identifiers_included false and never
  // renders either paths or stable local root IDs.
  assert.match(
    source,
    /\.settingsCodexFolderPrimarySelectedPath[\s\S]*?\(root\.url\.path as NSString\)\.abbreviatingWithTildeInPath/u,
  );
  const lifecycleDiagnosticsSource = source.slice(
    source.indexOf("private struct LifecycleDiagnostics"),
    source.indexOf("private func regularFile"),
  );
  assert.match(lifecycleDiagnosticsSource, /codexHomeMode: CodexHomeMode/u);
  assert.doesNotMatch(
    lifecycleDiagnosticsSource,
    /abbreviatingWithTildeInPath|url\.path|primaryRootID|activityRoots/u,
  );
  assert.match(
    source,
    /title: TiboTattleLocalization\.format\([\s\S]*?\.settingsAboutProduct[\s\S]*?BundledProduct\.displayName/u,
  );
  assert.match(source, /case companionAlreadyRunning/u);
  assert.match(source, /UM_MACOS_COMPANION_ALREADY_RUNNING/u);
  assert.match(source, /automatic_contribution_instance_active/u);
  assert.match(
    source,
    /anotherInstanceIsActive\s*\? LauncherError\.companionAlreadyRunning/u,
  );
  assert.match(source, /private var automaticCompanionRecoveryUsed = false/u);
  assert.match(
    source,
    /private func companionExited\([\s\S]*?!automaticCompanionRecoveryUsed[\s\S]*?automaticCompanionRecoveryUsed = true[\s\S]*?startCompanion\(\)[\s\S]*?return[\s\S]*?showFailure/u,
  );
  assert.match(
    source,
    /@objc private func retryCompanion\(\) \{[\s\S]*?automaticCompanionRecoveryUsed = false/u,
  );
  assert.match(source, /--confirm-local-keychain-reset/u);
  assert.match(
    source,
    /TiboTattleLocalization\.string\(\s*\.dialogResetCapabilities\s*\)/u,
  );
  assert.match(
    localizationSource,
    /Hosted service: no registered device is revoked/iu,
  );
  assert.match(localizationSource, /Secure erasure is not claimed/iu);
  assert.match(
    source,
    /TiboTattleLocalization\.string\(\.dialogMoveDataToTrash\)/u,
  );
  assert.match(
    localizationSource,
    /App state: local indexes[\s\S]*Keychain: pseudonymous identity[\s\S]*Hosted service: sent community data/iu,
  );
  assert.match(source, /requiredString\("UsageMonitorAppOpenScheme"\)/u);
  assert.match(source, /requiredString\("UsageMonitorAppOpenHost"\)/u);
  assert.match(source, /requiredString\("UsageMonitorAppOpenURL"\)/u);
  assert.match(
    source,
    /requiredDirectoryName\("UsageMonitorStateDirectoryName"\)/u,
  );
  assert.match(source, /value != "\."[\s\S]*value != "\.\."/u);
  assert.match(source, /!value\.contains\("\/"\)/u);
  assert.doesNotMatch(source, /appOpenScheme\s*=\s*"usagemonitor"/u);
  assert.doesNotMatch(source, /AppOpenLink/u);
  assert.match(
    source,
    /SemanticOpenTarget\(\s*scheme: BundledProduct\.appOpenScheme,\s*host: BundledProduct\.appOpenHost,\s*canonicalURL: BundledProduct\.appOpenURL\s*\)/u,
  );
  assert.match(
    source,
    /init\([\s\S]*semanticOpenTarget: SemanticOpenTarget[\s\S]*self\.semanticOpenTarget = semanticOpenTarget/u,
  );
  assert.match(
    source,
    /urls\.allSatisfy\(semanticOpenTarget\.accepts\)/u,
  );
  assert.match(
    source,
    /semanticOpenTarget\.accepts\(link\) \? 0 : 1/u,
  );
  assert.match(
    source,
    /Use only the exact \\\(semanticOpenTarget\.canonicalURL\) link\./u,
  );
  assert.match(
    semanticOpenTargetSource,
    /struct SemanticOpenTarget \{[\s\S]*let canonicalURL: String[\s\S]*private let scheme: String[\s\S]*private let host: String/u,
  );
  assert.match(
    semanticOpenTargetSource,
    /components\.scheme\?\.caseInsensitiveCompare\(scheme\)[\s\S]*components\.host\?\.caseInsensitiveCompare\(host\)/u,
  );
  assert.match(
    semanticOpenTargetSource,
    /percentEncodedPath\.isEmpty[\s\S]*percentEncodedPath == "\/"[\s\S]*components\.user == nil[\s\S]*components\.password == nil[\s\S]*components\.port == nil[\s\S]*components\.query == nil[\s\S]*components\.fragment == nil/u,
  );
  assert.doesNotMatch(semanticOpenTargetSource, /BundledProduct/u);
  assert.match(source, /--app-link-smoke-test/u);
  assert.match(
    source,
    /TiboTattleLocalization\.format\([\s\S]*?\.launcherWelcome[\s\S]*?BundledProduct\.displayName/u,
  );
  assert.match(
    source,
    /addButton\(\s*withTitle:\s*TiboTattleLocalization\.string\(\s*\.launcherGetStarted\s*\)\s*\)/u,
  );
  assert.match(
    firstRunDisclosureSource,
    /checkboxWithTitle:[\s\S]*\.settingsStartAtLogin/u,
  );
  assert.match(firstRunDisclosureSource, /startAtLogin\.state = \.on/u);
  assert.match(
    firstRunDisclosureSource,
    /guard alert\.runModal\(\) == \.alertFirstButtonReturn[\s\S]*?registerLoginItemForFirstRun/u,
  );
  assert.match(source, /first-run-v1\.json/u);
  assert.match(source, /usage-monitor-first-run-v1/u);
  assert.match(localizationSource, /Community contribution is optional/iu);
  assert.match(localizationSource, /Community contribution is optional/iu);
  assert.doesNotMatch(source, /six-hour while-open contribution schedule/iu);
  assert.match(localizationSource, /Keep the app open while analysis runs/iu);
  assert.match(
    source,
    /guard !quitting, retryAllowed, firstRunAcknowledged,[\s\S]*let codexHomeConfiguration/u,
  );
  assert.match(
    source,
    /guard !quitting, retryAllowed, firstRunAcknowledged,[\s\S]*?!codexHomeRestartGate\.isInFlight[\s\S]*?else \{ return \}/u,
  );
  assert.match(
    source,
    /retryButton\.isEnabled = retryAllowed && firstRunAcknowledged/u,
  );
  assert.match(source, /SPUStandardUpdaterController/u);
  assert.match(source, /startingUpdater:\s*false/u);
  assert.doesNotMatch(source, /startingUpdater:\s*true/u);
  assert.match(source, /private enum AppUpdaterState: Equatable/u);
  assert.match(
    source,
    /case unavailable[\s\S]*case unverified[\s\S]*case ready[\s\S]*case checking[\s\S]*case updateAvailable[\s\S]*case verifiedNoUpdate[\s\S]*case failed/u,
  );
  assert.match(source, /feedIsReachable = false/u);
  assert.match(source, /hasError: error != nil/u);
  assert.match(source, /hasBody: data\?\.isEmpty == false/u);
  assert.match(source, /request\.httpMethod = "GET"/u);
  assert.doesNotMatch(source, /request\.httpMethod = "HEAD"/u);
  assert.match(
    source,
    /static func feedResponseIsReachable\([\s\S]*200..<300/u,
  );
  assert.match(
    source,
    /guard Self\.feedResponseIsReachable\([\s\S]*showFeedFailureAlert/u,
  );
  assert.match(source, /alert\.addButton\(withTitle: TiboTattleLocalization\.string\(\.launcherRetry\)\)/u);
  assert.match(source, /alert\.addButton\(withTitle: TiboTattleLocalization\.string\(\.commonCancel\)\)/u);
  assert.match(source, /alert\.runModal\(\) == \.alertFirstButtonReturn[\s\S]*checkForUpdates\(nil\)/u);
  const updaterSummary = source.match(
    /var settingsSummary: String \{([\s\S]*?)\n    \}\n\n    private func setState/u,
  )?.[1];
  assert.ok(updaterSummary, "updater summary source should be present");
  const readySummary = updaterSummary.match(
    /case \.ready:([\s\S]*?)case \.checking:/u,
  )?.[1];
  assert.ok(readySummary, "ready updater summary source should be present");
  assert.match(readySummary, /settingsAutomaticUpdatesReachable/u);
  assert.doesNotMatch(
    readySummary,
    /settingsAutomaticUpdatesOn|settingsAutomaticUpdatesOff/u,
  );
  assert.match(source, /didFindValidUpdate[\s\S]*\.updateAvailable/u);
  assert.match(
    source,
    /func updaterDidNotFindUpdate\(_ updater: SPUUpdater, error: Error\) \{[\s\S]*?setState\(\.verifiedNoUpdate\)\s*\}/u,
  );
  assert.match(
    source,
    /func updaterDidNotFindUpdate\(_ updater: SPUUpdater\) \{\s*setState\(\.verifiedNoUpdate\)\s*\}/u,
  );
  assert.match(
    source,
    /stateForUpdaterAbort\([\s\S]*SUSparkleErrorDomain[\s\S]*Int\(SUError\.noUpdateError\.rawValue\):[\s\S]*return \.verifiedNoUpdate[\s\S]*Int\(SUError\.installationCanceledError\.rawValue\):[\s\S]*return \.ready[\s\S]*default:[\s\S]*return \.failed/u,
  );
  assert.match(
    source,
    /didAbortWithError[\s\S]*stateForUpdaterAbort\([\s\S]*errorDomain: updaterError\.domain[\s\S]*errorCode: updaterError\.code/u,
  );
  assert.match(source, /controller\.checkForUpdates\(sender\)/u);
  assert.match(source, /runtimeStateDescription/u);
  assert.match(
    source,
    /firstRunAcknowledged = true[\s\S]*updater\.startAfterFirstRunDisclosure\(\)/u,
  );
  assert.match(
    source,
    /var firstRunUpdatesDisclosure: String[\s\S]*guard isAvailable else[\s\S]*settingsUpdateDisclosureDevelopment/u,
  );
  assert.match(
    source,
    /if Self\.isPreviewDistribution[\s\S]*settingsUpdateDisclosurePreview/u,
  );
  assert.match(
    source,
    /allowsAutomaticUpdateOptIn && automaticUpdatesEnabled[\s\S]*settingsUpdateDisclosureAutomaticOn/u,
  );
  assert.equal(
    firstRunDisclosureSource.includes("updater.firstRunUpdatesDisclosure"),
    true,
  );
  assert.doesNotMatch(
    firstRunDisclosureSource,
    /settingsUpdateDisclosureAutomaticOn/u,
  );
  assert.match(source, /updater\.automaticallyDownloadsUpdates = enabled/u);
  assert.match(source, /NSSwitch\(\)/u);
  assert.match(
    source,
    /TiboTattleLocalization\.string\(\.settingsAutomaticUpdates\)/u,
  );
  assert.match(
    source,
    /TiboTattleLocalization\.string\(\.settingsLanguage\)/u,
  );
  assert.match(
    source,
    /TiboTattleLocalization\.string\(\.settingsLanguageSystem\)/u,
  );
  assert.match(
    source,
    /TiboTattleLocalization\.string\(\.settingsLanguageSummary\)/u,
  );
  assert.match(
    source,
    /settingsAboutAutomaticUpdatesDetailLabel\?\.stringValue\s*=\s*automaticUpdatesSettingsSummary\(\)/u,
  );
  assert.doesNotMatch(
    source,
    /settingsAutomaticUpdatesDetailLabel\?\.stringValue\s*=\s*updater\.automaticUpdatesPreferenceSummary/u,
  );
  assert.match(source, /private func settingsGroup\(/u);
  assert.match(source, /let group = NSBox\(\)/u);
  const settingsSource = source.slice(
    source.indexOf("private func showSettings(selecting index: Int)"),
    source.indexOf("    private func diagnosticText("),
  );
  assert.ok(settingsSource, "settings construction source should be present");
  const generalSettings = settingsSource.match(
    /let general = settingsPage\([\s\S]*?\n        \)\n(?=        let notifications)/u,
  )?.[0] ?? "";
  assert.ok(generalSettings, "general settings page wiring should be present");
  assert.match(
    generalSettings,
    /languageSection[\s\S]*sourceSection[\s\S]*refreshIntervalSection[\s\S]*startAtLoginSection/u,
  );
  assert.doesNotMatch(generalSettings, /quotaNotificationsSection/u);
  assert.doesNotMatch(
    generalSettings,
    /automaticUpdatesHeader|aboutAutomaticUpdatesDetail|checkForUpdates|launcherUpToDate/u,
  );
  const notificationSettings = settingsSource.match(
    /let notifications = settingsPage\([\s\S]*?views: \[quotaNotificationsSection\][\s\S]*?\n        \)/u,
  )?.[0] ?? "";
  assert.ok(
    notificationSettings,
    "notification settings should have a dedicated native page",
  );
  const aboutSettings = settingsSource.slice(
    settingsSource.indexOf("let about = settingsPage("),
  );
  assert.match(
    aboutSettings,
    /aboutProductSection[\s\S]*aboutUpdatesSection[\s\S]*projectLinks/u,
  );
  const aboutUpdates = settingsSource.slice(
    settingsSource.indexOf("let aboutUpdatesSection = settingsGroup("),
    settingsSource.indexOf("let aboutProductSection = settingsGroup("),
  );
  assert.match(
    aboutUpdates,
    /automaticUpdatesHeader[\s\S]*aboutAutomaticUpdatesDetail[\s\S]*checkForUpdates/u,
  );
  assert.match(
    settingsSource,
    /settingsControlColumn\(\[\s*settingsControlRow\(\[addSource, removeSource\]\),\s*settingsControlRow\(\[setPrimarySource, useDefaultSource\]\),\s*\]\)/u,
  );
  assert.match(settingsSource, /settingsControlRow\(\[openNotifications\]\)/u);
  assert.match(settingsSource, /settingsControlRow\(\[checkForUpdates\]\)/u);
  assert.match(
    settingsSource,
    /settingsControlColumn\(\[\s*openLoginItems,\s*refreshLoginItemStatus,\s*removePendingLoginItem,\s*\]\)/u,
  );
  for (const bare of [
    "addSource",
    "removeSource",
    "setPrimarySource",
    "useDefaultSource",
    "openLoginItems",
    "refreshLoginItemStatus",
    "removePendingLoginItem",
    "openNotifications",
    "checkForUpdates",
  ]) {
    assert.doesNotMatch(
      settingsSource,
      new RegExp(`\\n {16}${bare},\\n`, "u"),
      `${bare} must reach its card through a row, not as a bare control`,
    );
  }
  assert.match(settingsSource, /symbolName: "globe"/u);
  assert.match(settingsSource, /symbolName: "folder"/u);
  assert.match(settingsSource, /symbolName: "clock"/u);
  assert.match(source, /settingsOpenNotifications/u);
  assert.match(source, /x-apple\.systempreferences:com\.apple\.Notifications-Settings\.extension/u);
  assert.match(source, /case \.unverified:[\s\S]*?settingsCheckForUpdates/u);
  assert.match(source, /nativeEvidenceState = \.readFailed/u);
  assert.match(source, /nativeEvidenceState = \.lifecycleUnavailable/u);
  assert.doesNotMatch(source, /settingsNotificationsReset\)/u);
  assert.doesNotMatch(source, /toggleQuotaNotificationReset/u);
  assert.match(
    localizationSource,
    /Local usage refreshes while TiboTattle is open\. Raw logs stay on this Mac\./iu,
  );
  assert.match(
    localizationSource,
    /Start TiboTattle when you sign in\. Manage this in System Settings → Login Items\./iu,
  );
  assert.match(source, /NSApp\.applicationIconImage/u);
  assert.doesNotMatch(source, /showAutomaticUpdateOptions/u);
  assert.doesNotMatch(source, /showLifecycleHelp/u);
  assert.match(
    source,
    /TiboTattleLocalization\.string\(\s*\.launcherUpdatingLocalUsage\s*\)/u,
  );
  assert.match(localizationSource, /Updating local usage while the app is open/iu);
  assert.match(localizationSource, /Large histories may need several passes/iu);
  assert.match(localizationSource, /Nothing leaves this Mac/iu);
  assert.match(source, /private final class NativeDashboardChrome/u);
  const destinationSource = source.match(
    /private enum NativeDashboardDestination:[\s\S]*?\n\}\n\n\/\/\/ `NSSplitView`/u,
  )?.[0] ?? "";
  assert.ok(destinationSource, "native dashboard destination enum is present");
  assert.doesNotMatch(destinationSource, /case data\b/u);
  assert.doesNotMatch(source, /nativeDashboardDataPrivacy|nativeDashboard\.dataPrivacy/u);
  assert.match(destinationSource, /case community\b/u);
  assert.deepEqual(
    [...destinationSource.matchAll(/^\s*case (\w+)$/gmu)].map((match) => match[1]),
    ["overview", "weekly", "trends", "method", "community"],
  );
  assert.match(source, /private final class NativeDashboardReportPane/u);
  // The chrome is an NSSplitViewController with a real sidebar item, so the
  // split view is vended by AppKit rather than constructed here. That is what
  // gives the sidebar its system vibrancy, rounding and full-height behaviour;
  // the geometry it produces is asserted by the measured chrome smoke below.
  assert.match(source, /class NativeDashboardChrome: NSSplitViewController/u);
  assert.match(source, /NSSplitViewItem\(sidebarWithViewController:/u);
  assert.match(
    source,
    /reportPane = NativeDashboardReportPane\(webView: webView\)/u,
  );
  // The web view must NOT carry an autoresizing mask: the pane runs full
  // height so the sidebar can reach the title bar, and a mask fights the
  // safe-area inset applied on resize. That the web view still tracks its
  // pane is asserted by measurement in the chrome smoke rather than by the
  // presence of a mask.
  assert.match(source, /webView\.autoresizingMask = \[\]/u);
  assert.doesNotMatch(source, /webView\.autoresizingMask = \[\.width/u);
  assert.match(source, /override func layout\(\) \{[\s\S]*?fitWebViewToBounds\(\)/u);
  assert.match(source, /webView\.frame = frame/u);
  assert.match(source, /private func loadWhenViewportIsReady\(\)/u);
  assert.match(source, /viewport\.width >= 120, viewport\.height >= 120/u);
  assert.match(source, /nativeDashboardChrome\?\.prepareReportViewport\(\)/u);
  // `didFinish` only means that WebKit has loaded the document shell. The
  // dashboard then reads the local companion and renders asynchronously, so
  // the native host waits for the page-owned readiness contract instead of
  // sampling a transient DOM node that is legitimately empty during startup.
  assert.match(
    source,
    /private func awaitDashboardContent\([\s\S]*?webView\.evaluateJavaScript\(\s*"document\.documentElement\?\.dataset\.localDashboardReady === 'true';"\s*\) \{[\s\S]*?guard let self, self\.hasDashboardTarget else \{ return \}[\s\S]*?let localDashboardReady = \(value as\? NSNumber\)\?\.boolValue \?\? false[\s\S]*?if error == nil, localDashboardReady \{[\s\S]*?self\.onLoaded\(\)[\s\S]*?return/u,
  );
  assert.doesNotMatch(source, /document\.querySelector\('#main'\)\?\.innerText/u);
  assert.match(source, /addSplitViewItem\(reportItem\)/u);
  assert.doesNotMatch(source, /addSplitViewItem\(webView\)/u);
  assert.doesNotMatch(source, /split\.addArrangedSubview\(webView\)/u);
  assert.match(source, /newWindow\.toolbar = makeDashboardToolbar\(\)/u);
  assert.match(source, /newWindow\.toolbarStyle = \.unified/u);
  assert.match(source, /refreshLocalUsage\(automatic: true\)/u);
  assert.match(source, /static let defaultsKey = "tibotattle\.refresh-interval\.v1"/u);
  assert.match(source, /static let allowedSeconds = \[60, 5 \* 60, 15 \* 60, 30 \* 60\]/u);
  assert.match(source, /static func seconds\(in defaults: UserDefaults\) -> Int/u);
  assert.match(source, /static func setSeconds\(\s*_ value: Int, in defaults: UserDefaults\)/u);
  assert.match(source, /defaults\.set\(value, forKey: defaultsKey\)/u);
  assert.match(source, /NativeRefreshIntervalPreference\.seconds/u);
  assert.match(source, /private struct NativeForegroundRefreshSchedule/u);
  assert.match(source, /NativeForegroundRefreshScheduler\.schedule/u);
  assert.match(source, /enqueue\(now \+ \.seconds\(schedule\.intervalSeconds\), work\)/u);
  assert.match(source, /DispatchQueue\.main\.asyncAfter\(deadline: deadline, execute: work\)/u);
  assert.match(source, /setSeconds\(value, in: UserDefaults\.standard\)/u);
  assert.match(source, /--native-refresh-settings-contract-smoke-test/u);
  assert.doesNotMatch(source, /nativeRefreshIntervalSeconds/u);
  assert.match(source, /private func scheduleNativeRefresh\(\)/u);
  const refreshIntervalSelectionSource = source.match(
    /@objc private func selectRefreshInterval\(_ sender: NSPopUpButton\)[\s\S]*?(?=\n    @objc private func openNotificationSettings)/u,
  )?.[0] ?? "";
  assert.ok(
    refreshIntervalSelectionSource,
    "refresh interval picker action should be present",
  );
  assert.match(
    refreshIntervalSelectionSource,
    /NativeRefreshIntervalSelection\.apply\([\s\S]*?seconds: seconds[\s\S]*?dashboardAvailable: dashboardURL != nil[\s\S]*?refreshInFlight: nativeRefreshInFlight[\s\S]*?scheduleNativeRefresh\(\)/u,
  );
  assert.match(
    source,
    /private enum NativeRefreshIntervalSelection[\s\S]*?setSeconds\(seconds, in: defaults\)[\s\S]*?guard dashboardAvailable, !refreshInFlight else \{ return true \}[\s\S]*?reschedule\(\)/u,
  );
  assert.match(source, /stack\.centerXAnchor\.constraint\(equalTo: document\.centerXAnchor\)/u);
  assert.match(source, /static let columnWidth: CGFloat = 680/u);
  assert.match(
    source,
    /stack\.widthAnchor\.constraint\(\s*lessThanOrEqualToConstant: columnWidth\s*\)/u,
  );
  assert.match(source, /contentStack\.alignment = \.leading/u);
  assert.match(source, /view\.widthAnchor\.constraint\(equalTo: contentStack\.widthAnchor\)/u);
  assert.match(source, /stack\.alignment = \.leading/u);
  assert.match(source, /view\.widthAnchor\.constraint\(equalTo: stack\.widthAnchor\)/u);
  // Re-pinned 2026-08-20: the settings window used to be a literal
  // 760x620, which was shorter than a four-group General page - so the page
  // showed a scroller and clipped its last group, in every locale. The height
  // is now whatever the page's own cards measure at the width they are laid
  // out in, capped at the display, so a longer translation grows the window
  // instead of clipping. A literal content size is the defect, not a detail.
  assert.match(
    source,
    /controller\.preferredContentSize = contentSize\(for: stack\)/u,
  );
  assert.match(
    source,
    /static func contentSize\(for column: NSStackView\) -> NSSize[\s\S]*?naturalHeight\(\s*of: column,\s*at: columnWidth\s*\)[\s\S]*?maximumContentHeight/u,
  );
  assert.match(
    source,
    /static func naturalHeight\([\s\S]*?widthAnchor\.constraint\(equalToConstant: width\)[\s\S]*?layoutSubtreeIfNeeded\(\)[\s\S]*?fittingSize\.height/u,
  );
  assert.match(settingsSource, /newWindow\.setContentSize\(openingSize\)/u);
  assert.doesNotMatch(settingsSource, /setContentSize\(NSSize\(width: \d/u);
  // The pages are kept, not discarded, because a card's height moves with its
  // live text: a chosen folder path wraps, the pending-login-item row appears.
  // Every seam that writes into a card re-asks the window for its size.
  assert.match(source, /private func refitSettingsWindowToContent\(\)/u);
  for (const seam of [
    "updateSettingsCodexHomeSummary",
    "updateAutomaticUpdatesSettingsControl",
    "updateStartAtLoginSettingsControl",
    "updateQuotaNotificationSettingsControls",
  ]) {
    const seamSource = source.slice(
      source.indexOf(`private func ${seam}()`),
    ).split("\n    }\n")[0];
    assert.match(
      seamSource,
      /refitSettingsWindowToContent\(\)/u,
      `${seam} should refit the settings window to its content`,
    );
  }
  // Re-pinned 2026-08-20: a card stretches every direct child to the card
  // width so wrapping descriptions have a measure to wrap against, which turned
  // "Open Login Items Settings" into a full-width banner. A row or a leading
  // column is the seam that keeps the width for the card and the intrinsic size
  // for the control; a bare NSButton in a card is the defect.
  assert.match(source, /private func settingsControlRow\(/u);
  assert.match(source, /private func settingsControlColumn\(/u);
  assert.match(source, /nativeStatusRefreshButton\?\.contentTintColor/u);
  assert.match(source, /nativeToolbarStatusColor\(isRefreshing:/u);
  // Deliberately re-pinned 2026-08-08: the status pill dropped the system
  // tints (.systemYellow/.systemGreen never reached a bezelled title anyway)
  // for the web dashboard's state-pill palette — green #174f45 for fresh,
  // amber #815718 for running/indexing, rust #97402a for a failed refresh —
  // resolved per appearance and painted as a rounded fill behind a
  // borderless, tint-aware button.
  assert.match(source, /private struct NativeToolbarStatusColor/u);
  assert.match(source, /light: \(red: 23, green: 79, blue: 69, alpha: 1\)/u);
  assert.match(source, /light: \(red: 129, green: 87, blue: 24, alpha: 1\)/u);
  assert.match(source, /light: \(red: 151, green: 64, blue: 42, alpha: 1\)/u);
  // Deliberately re-pinned 2026-08-08: the pill dressing is an inert
  // borderless NSButton, not a plain NSView. On macOS 26 the toolbar wraps a
  // custom-view item in its own Liquid Glass platter (NSToolbarPlatterView
  // hosting an NSGlassEffectView, 11pt taller than the pill), which rendered
  // as the white halo the owner reported. AppKit only asks its own buttons
  // whether they want glass — a borderless button declines the platter
  // through public API; a plain NSView is misted over regardless. The pill
  // button stays pure dressing: empty title, no action, no key focus, no
  // accessibility element — the inner title button remains the control.
  assert.match(source, /private final class NativeToolbarStatusPill: NSButton/u);
  assert.match(
    source,
    /private final class NativeToolbarStatusPill: NSButton[\s\S]*?title = ""[\s\S]*?isBordered = false[\s\S]*?refusesFirstResponder = true[\s\S]*?setAccessibilityElement\(false\)[\s\S]*?wantsLayer = true/u,
  );
  assert.match(source, /button\.isBordered = false/u);
  assert.doesNotMatch(source, /\.systemYellow|\.systemGreen/u);
  // The colorway mirrors the title's own precedence: a running refresh,
  // then a terminal failure, then an incomplete index, then evidence.
  assert.match(
    source,
    /private func nativeToolbarStatusColor\([\s\S]*?if isRefreshing \{[\s\S]*?return \.busy[\s\S]*?if nativeRefreshFailure != nil \{[\s\S]*?return \.failed[\s\S]*?!coverage\.isComplete \{[\s\S]*?return \.busy[\s\S]*?case \.live:[\s\S]*?return \.fresh/u,
  );
  assert.match(source, /nativeStatusPill\?\.colorway = colorway/u);
  assert.match(source, /nativeDashboardFresh/u);
  assert.match(source, /nativeDashboardNeedsRefresh/u);
  assert.match(
    source,
    /tibotattle:locale-override[\s\S]*?requestAnimationFrame[\s\S]*?new Event\('resize'\)/u,
  );
  assert.match(source, /LocalCompanionEvidenceReader/u);
  assert.match(source, /firstRunLoginItemDisclosure/u);
  assert.match(source, /registerLoginItemForFirstRun/u);
  assert.match(source, /func applicationDidBecomeActive[\s\S]*?updateStartAtLoginSettingsControl\(\)/u);
  assert.match(source, /title: TiboTattleLocalization\.string\([\s\S]*?\.settingsRefreshLoginItemStatus/u);
  assert.match(source, /title: TiboTattleLocalization\.string\([\s\S]*?\.settingsRemovePendingLoginItem/u);
  assert.match(source, /@objc private func removePendingLoginItem\(\)[\s\S]*?\.unregister/u);
  assert.match(source, /loginItemOperationResult\([\s\S]*?showLoginItemOperationResult/u);
  assert.match(source, /windowShouldClose\(_ sender: NSWindow\)/u);
  assert.match(source, /sender\.orderOut\(nil\)[\s\S]*return false/u);
  assert.match(
    source,
    /private func quitApplication\(\) \{\s*NSApp\.terminate\(nil\)/u,
  );
  assert.match(loginItemSource, /import ServiceManagement/u);
  assert.match(loginItemSource, /SMAppService\.mainApp/u);
  assert.match(loginItemSource, /SMAppService\.openSystemSettingsLoginItems\(\)/u);
  assert.match(loginItemSource, /case \.notFound:/u);
  assert.match(loginItemSource, /struct LoginItemSettingsPresentation/u);
  assert.match(loginItemSource, /case \.requiresApproval:[\s\S]*?showsPendingRemoval: true/u);
  assert.match(loginItemSource, /case notConfirmed/u);
  assert.match(loginItemSource, /func reconciledLoginItemOperationResultAfterError/u);
  for (const forbidden of [
    "daemonService",
    "agentService",
    "SMLoginItemSetEnabled",
    "LaunchAgents",
    "LaunchDaemons",
  ]) {
    assert.equal(loginItemSource.includes(forbidden), false, forbidden);
  }
  assert.match(localizationSource, /LaunchAgent or daemon/iu);
  assert.doesNotMatch(localizationSource, /installs no login item/iu);
  assert.match(
    source,
    /title: TiboTattleLocalization\.format\([\s\S]*?\.menuQuitProduct[\s\S]*?BundledProduct\.displayName/u,
  );
  assert.match(
    source,
    /title: TiboTattleLocalization\.string\(\.menuSettings\)[\s\S]*keyEquivalent: ","/u,
  );
  // The menu-bar item is additive: the Dock icon and the regular activation
  // policy stay, and the window remains the primary surface.
  assert.match(source, /application\.setActivationPolicy\(\.regular\)/u);
  assert.match(source, /installMenuBarStatus\(\)/u);
  assert.match(source, /installApplicationMenu\(\)/u);
  assert.match(source, /Selector\(\("copy:"\)\)/u);
  assert.match(source, /Selector\(\("selectAll:"\)\)/u);
  assert.match(source, /window\?\.makeFirstResponder\(webView\)/u);
  assert.match(
    source,
    /MenuBarStatusController\(\s*productName: BundledProduct\.displayName/u,
  );
  assert.match(menuBarStatusSource, /private static let idlePollSeconds = 60/u);
  assert.match(menuBarStatusSource, /refreshStaleEvidenceIfNeeded\(\)/u);
  assert.match(menuBarStatusSource, /private static func makeBrandBirdTemplate\(\)/u);
  // The status item must render the TiboTattle mark derived from the
  // approved app icon. The SF Symbols bird is a GENERIC system bird and may
  // exist only as the emergency fallback — never as the preferred mark.
  assert.match(
    menuBarStatusSource,
    /private static func makeBrandBirdTemplate\(\) -> NSImage\? \{\s*if let asset = makeAssetBirdTemplate\(\) \{ return asset \}\s*return nativeBirdTemplate\(\)\s*\}/u,
    "brand bird template must prefer the app-icon mark over the SF Symbols bird",
  );
  assert.doesNotMatch(
    menuBarStatusSource,
    /if let native = nativeBirdTemplate\(\) \{ return native \}/u,
    "the generic SF Symbols bird must never be preferred over the brand mark",
  );
  assert.match(menuBarStatusSource, /NSApp\.applicationIconImage|application\.applicationIconImage/u);
  assert.match(menuBarStatusSource, /template\.isTemplate = true/u);
  assert.match(menuBarStatusSource, /systemSymbolName: "bird\.fill"/u);
  assert.match(menuBarStatusSource, /let glyphSize = NSSize\(width: 16, height: 16\)/u);
  assert.match(menuBarStatusSource, /private static func drawMeter\(/u);
  assert.doesNotMatch(menuBarStatusSource, /NSApp\.applicationIconImage\.copy\(\)/u);
  assert.doesNotMatch(menuBarStatusSource, /source\.size = NSSize\(width: 16, height: 16\)/u);
  // The menu bar has one primary app destination. It reuses the in-app
  // dashboard path and leaves the browser as the separate explicit control.
  assert.match(source, /openTiboTattle: \{ \[weak self\] in self\?\.openTiboTattle\(\) \}/u);
  assert.match(
    source,
    /private func openTiboTattle\(\) \{[\s\S]*?showMainWindow\(\)[\s\S]*?openDashboard\(\)/u,
  );
  assert.match(source, /quit: \{ \[weak self\] in self\?\.quitApplication\(\) \}/u);
  assert.match(source, /menuBarStatus\?\.companionReady\(dashboardURL: url\)/u);
  assert.match(source, /menuBarStatus\?\.companionStarting\(\)/u);
  assert.match(source, /menuBarStatus\?\.companionUnavailable\(/u);
  assert.match(
    source,
    /func applicationWillTerminate[\s\S]*menuBarStatus\?\.shutDown\(\)/u,
  );
  // The shipped app must never become a menu-bar-only surface. Accessory
  // activation is confined to the non-launching AppKit smoke modes.
  assert.match(
    source,
    /private enum MenuBarContractSmokeTest \{[\s\S]*?application\.setActivationPolicy\(\.accessory\)/u,
  );
  assert.equal(
    source.match(/setActivationPolicy\(\.accessory\)/gu)?.length,
    4,
    "only isolated AppKit smoke modes may use accessory activation",
  );
  // The fourth is the sidebar-recovery smoke, which builds real chrome in a
  // window it never brings forward.
  assert.match(
    source,
    /private enum NativeDashboardSidebarRecoverySmokeTest \{[\s\S]*?application\.setActivationPolicy\(\.accessory\)/u,
  );
  for (const forbidden of [
    "LSUIElement",
    "setActivationPolicy(.prohibited)",
    "MenuBarExtra",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.match(source, /child\.terminate\(\)/u);
  assert.match(source, /SIGKILL/u);
  assert.match(source, /--smoke-test/u);
  assert.match(source, /--central-smoke-test/u);
  assert.match(source, /--watchdog-smoke-test/u);
  assert.match(source, /URLSessionConfiguration\.ephemeral/u);
  for (const forbidden of [
    "LaunchAgents",
    "LaunchDaemons",
    "SMLoginItemSetEnabled",
    "URLSessionConfiguration.background",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("native update disclosure routes settings to About in every catalog", async () => {
  const expectations = [
    {
      about: "Settings → About",
      general: "Settings → General",
      locale: "en",
    },
    {
      about: "Configuración → Acerca de",
      general: "Configuración → General",
      locale: "es",
    },
    {
      about: "“设置”→“关于”",
      general: "“设置”→“通用”",
      locale: "zh-Hans",
    },
  ];
  for (const { about, general, locale } of expectations) {
    const catalog = await readFile(
      join(
        REPOSITORY_ROOT,
        "apps",
        "macos",
        "Resources",
        `${locale}.lproj`,
        "Localizable.strings",
      ),
      "utf8",
    );
    const disclosureLines = catalog
      .split(/\r?\n/u)
      .filter((line) => line.includes('"settings.updateDisclosureAutomatic'));
    assert.equal(disclosureLines.length, 2, locale);
    assert.equal(disclosureLines.every((line) => line.includes(about)), true, locale);
    assert.equal(disclosureLines.some((line) => line.includes(general)), false, locale);
  }
});

test("multi-root settings and retained-history warning ship in every native catalog", async () => {
  const expectations = [
    {
      locale: "en",
      retainedHistory: "retains imported history",
      sameAccount: "one Codex user/account",
      cannotVerify: "cannot verify account equivalence",
      settingsGeneral: "Settings → General",
    },
    {
      locale: "es",
      retainedHistory: "conserva el historial importado",
      sameAccount: "un mismo usuario o una misma cuenta de Codex",
      cannotVerify: "no puede verificar que las cuentas sean equivalentes",
      settingsGeneral: "Configuración → General",
    },
    {
      locale: "zh-Hans",
      retainedHistory: "保留已导入的历史记录",
      sameAccount: "同一个 Codex 用户/账户",
      cannotVerify: "无法验证账户是否相同",
      settingsGeneral: "“设置”→“通用”",
    },
  ];
  const requiredKeys = [
    "settings.addCodexFolder",
    "settings.removeCodexFolder",
    "settings.setPrimaryCodexFolder",
    "settings.codexFolderActivitySelectedPath",
    "settings.codexFolderPathWithStatus",
    "settings.codexFolderPrimarySelectedPath",
    "settings.codexFolderStatusInvalid",
    "settings.codexFolderStatusReady",
    "settings.codexFolderStatusTemporarilyUnavailable",
    "dialog.removeCodexFolderDescription",
    "dialog.resetCodexFoldersDescription",
    "dialog.setPrimaryCodexFolderDescription",
  ];
  for (const {
    locale,
    retainedHistory,
    sameAccount,
    cannotVerify,
    settingsGeneral,
  } of expectations) {
    const catalog = await readFile(
      join(
        REPOSITORY_ROOT,
        "apps",
        "macos",
        "Resources",
        `${locale}.lproj`,
        "Localizable.strings",
      ),
      "utf8",
    );
    for (const key of requiredKeys) {
      assert.match(
        catalog,
        new RegExp(`^"${key.replaceAll(".", "\\.")}" = ".+";$`, "mu"),
        `${locale}: ${key}`,
      );
    }
    const removalLine = catalog.split(/\r?\n/u).find((line) =>
      line.startsWith('"dialog.removeCodexFolderDescription"'));
    assert.notEqual(removalLine, undefined, locale);
    assert.equal(removalLine.includes(retainedHistory), true, locale);
    const intentLine = catalog.split(/\r?\n/u).find((line) =>
      line.startsWith('"settings.codexFolderSummary"'));
    assert.notEqual(intentLine, undefined, locale);
    assert.equal(intentLine.includes(sameAccount), true, locale);
    assert.equal(intentLine.includes(cannotVerify), true, locale);
    const recoveryLine = catalog.split(/\r?\n/u).find((line) =>
      line.startsWith('"launcher.recoveryChooseCodexHome"'));
    assert.notEqual(recoveryLine, undefined, locale);
    assert.equal(recoveryLine.includes(settingsGeneral), true, locale);
    assert.equal(recoveryLine.includes("Codex Source"), false, locale);
    assert.equal(recoveryLine.includes("Codex 来源"), false, locale);
    assert.equal(recoveryLine.includes("Origen de Codex"), false, locale);
  }
});

test("the in-app dashboard web view stays pinned to the loopback companion", async () => {
  const [source, buildSource] = await Promise.all([
    readFile(SWIFT_SOURCE, "utf8"),
    readFile(join(REPOSITORY_ROOT, "scripts", "build-macos-app.js"), "utf8"),
  ]);
  assert.match(source, /import WebKit/u);
  // WebKit is a system framework: the bundle gains no new binary and the
  // packaged app declares no new transport exception for it.
  assert.match(buildSource, /"-framework",\s*\n\s*"WebKit",/u);
  assert.match(
    buildSource,
    /"-framework",\s*\n\s*"ServiceManagement",/u,
  );
  assert.equal(buildSource.includes("NSAllowsArbitraryLoads"), false);
  assert.equal(buildSource.includes("NSExceptionDomains"), false);
  assert.match(
    buildSource,
    /<key>NSAppTransportSecurity<\/key>\s*\n\s*<dict>\s*\n\s*<key>NSAllowsLocalNetworking<\/key>\s*\n\s*<true\/>\s*\n\s*<\/dict>/u,
  );

  // Exactly one origin may load: the http loopback port this launcher started.
  assert.match(
    source,
    /private func isCompanionURL\(_ url: URL\) -> Bool \{[\s\S]*?url\.scheme\?\.lowercased\(\) == "http"[\s\S]*?url\.host == loopbackHost[\s\S]*?url\.port == allowedPort[\s\S]*?url\.user == nil[\s\S]*?url\.password == nil/u,
  );
  // Persistent by owner decision (sign-in-once durability, part 3): a valid
  // web session survives an app relaunch. The in-flight handoff lives in the
  // owner-only companion state root instead, while durable upload authority
  // remains the Keychain device credential.
  assert.match(source, /configuration\.websiteDataStore = \.default\(\)/u);
  assert.match(
    source,
    /static func clearPersistentWebsiteData[\s\S]*WKWebsiteDataStore\.allWebsiteDataTypes\(\)[\s\S]*modifiedSince: \.distantPast/u,
  );
  assert.match(
    source,
    /private func eraseLocalData\(\)[\s\S]*dashboardWebHost\?\.stop\(\)[\s\S]*trashItem[\s\S]*clearPersistentWebsiteData[\s\S]*startCompanion\(\)/u,
  );
  assert.match(source, /WKUserScript\([\s\S]*injectionTime: \.atDocumentStart/u);
  assert.match(source, /document\.documentElement\.classList\.add\('native-dashboard'\)/u);
  assert.match(
    source,
    /func notifyHostedSignInReturn\(\) \{[\s\S]*?window\.dispatchEvent\(new Event\('tibotattle:hosted-sign-in-return'\)\)/u,
  );
  // The shell takes the foreground refresh cadence away from the page, so it
  // owes the page a signal when a refresh finished. Without it the document
  // keeps rendering the snapshot it loaded with while the toolbar reports the
  // refresh complete, and the window asserts a freshness it does not have.
  assert.match(
    source,
    /func notifyLocalEvidenceUpdated\(\) \{[\s\S]*?window\.dispatchEvent\(new Event\('tibotattle:local-evidence-updated'\)\)/u,
  );
  assert.match(
    source,
    /private func finishNativeRefresh\(title: String, refreshEnabled: Bool\) \{[\s\S]*?dashboardWebHost\?\.notifyLocalEvidenceUpdated\(\)/u,
  );
  assert.match(
    source,
    /decisionHandler\(\.cancel\)\s*\n\s*openExternally\(url\)/u,
  );
  // A second window is never opened in-app; its target is handed straight to
  // the user's browser and this delegate returns nothing.
  assert.match(
    source,
    /createWebViewWith configuration: WKWebViewConfiguration,[\s\S]*?openExternally\(url\)\s*\n\s*\}\s*\n\s*return nil/u,
  );
  assert.match(
    source,
    /private func openExternalDashboardLink\(_ url: URL\) \{[\s\S]*?semanticOpenTarget\.accepts\(url\)[\s\S]*?NSApp\.activate\(ignoringOtherApps: true\)[\s\S]*?url\.scheme\?\.lowercased\(\) == "https"[\s\S]*?url\.user == nil,\s*\n\s*url\.password == nil/u,
  );
  assert.match(
    source,
    /func application\([\s\S]*?open urls: \[URL\][\s\S]*?if dashboardWebViewShowing \{[\s\S]*?dashboardWebHost\?\.notifyHostedSignInReturn\(\)[\s\S]*?return[\s\S]*?openDashboard\(\)/u,
  );
  assert.doesNotMatch(source, /Finish signing in in your browser/u);
  assert.match(source, /webView\.allowsBackForwardNavigationGestures = false/u);
  for (const forbidden of [
    "allowsLinkPreview = true",
    "javaScriptCanOpenWindowsAutomatically",
    "setValue(true, forKey: \"allowUniversalAccessFromFileURLs\"",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }

  // Controls the embedded view would otherwise silently kill: the file picker
  // for a reviewed contribution, the confirmation on a destructive action, and
  // the share-card download.
  assert.match(source, /runOpenPanelWith parameters: WKOpenPanelParameters/u);
  assert.match(
    source,
    /runJavaScriptConfirmPanelWithMessage message: String[\s\S]*?completionHandler\(alert\.runModal\(\) == \.alertFirstButtonReturn\)/u,
  );
  assert.match(source, /navigationAction\.shouldPerformDownload \{\s*\n\s*decisionHandler\(\.download\)/u);
  assert.match(source, /static func downloadsDestination\(for suggestedFilename: String\)/u);
  // A file that could not be saved must not tear down a working dashboard.
  assert.match(
    source,
    /func download\(_ download: WKDownload, didFailWithError error: Error, resumeData: Data\?\) \{[\s\S]*?onDownloadFailure\(\)/u,
  );
  // Tearing the view down loads a blank page; that must never be reported as
  // a dashboard that opened.
  assert.match(
    source,
    /func stop\(\) \{[\s\S]*?hasDashboardTarget = false/u,
  );
  assert.match(
    source,
    /func webView\(_ webView: WKWebView, didFinish navigation: WKNavigation!\) \{\s*\n\s*guard hasDashboardTarget else \{ return \}/u,
  );

  // A failed web view never becomes the only thing on screen: the status
  // stack and the native recovery controls return together.
  assert.match(
    source,
    /private func dashboardWebViewFailed\(code: String\) \{[\s\S]*?dashboardContainer\.isHidden = true\s*\n\s*statusStack\.isHidden = false/u,
  );
  assert.match(
    source,
    /private func dashboardWebViewFailed\(code: String\) \{[\s\S]*?retryButton\.isEnabled = retryAllowed && firstRunAcknowledged/u,
  );
  assert.match(
    source,
    /private func showFailure\(_ error: Error\) \{[\s\S]*?hideDashboardWebView\(\)/u,
  );
  assert.match(source, /actionRow\.isHidden = true/u);
  assert.match(source, /actionRow\.isHidden = false/u);
  assert.match(source, /layout\.addArrangedSubview\(actionRow\)/u);
  // The browser remains an explicit, separate choice rather than the default.
  assert.match(
    source,
    /title: TiboTattleLocalization\.string\(\.launcherOpenInBrowser\)/u,
  );
  assert.match(
    source,
    /@objc private func openDashboard\(\) \{[\s\S]*?showDashboardWebView\(dashboardURL\)/u,
  );
  assert.match(
    source,
    /@objc private func openDashboardInBrowser\(\) \{[\s\S]*?NSWorkspace\.shared\.open\(dashboardURL\)/u,
  );
  assert.match(source, /UM_MACOS_DASHBOARD_VIEW_UNAVAILABLE/u);
  assert.match(source, /UM_MACOS_DASHBOARD_DOWNLOAD_FAILED/u);
});

test("native dashboard launch gates its first refresh on the rendered page", async () => {
  const source = await readFile(SWIFT_SOURCE, "utf8");
  const section = (startNeedle, endNeedle) => {
    const start = source.indexOf(startNeedle);
    const end = source.indexOf(endNeedle, start + startNeedle.length);
    assert.ok(start >= 0 && end > start, `${startNeedle} section is present`);
    return source.slice(start, end);
  };

  const companionReady = section(
    "private func companionReady(",
    "private func companionExited(",
  );
  const dashboardLoaded = section(
    "private func dashboardWebViewLoaded()",
    "private func navigateNativeDashboard(",
  );
  const dashboardFailure = section(
    "private func dashboardWebViewFailed(code: String)",
    "private func hideDashboardWebView()",
  );
  const dashboardTeardown = section(
    "private func hideDashboardWebView()",
    "/// A link the embedded dashboard cannot load itself.",
  );
  const companionExit = section(
    "private func companionExited(",
    "private func showFailure(",
  );

  // The companion becoming reachable only arms the launch-only refresh. It
  // must not start collection while the page is still doing its first local
  // reads, or the collector can win the loopback race against first paint.
  assert.match(
    companionReady,
    /startupAutomaticRefreshPending = true[\s\S]*?openDashboard\(\)/u,
  );
  assert.doesNotMatch(
    companionReady,
    /refreshLocalUsage\(automatic: true\)/u,
  );

  // The page-host callback is the only consumer of that pending flag: clear
  // it before starting the refresh, so re-entrant callbacks cannot launch a
  // second startup pass.
  assert.match(
    dashboardLoaded,
    /if startupAutomaticRefreshPending \{\s*\n\s*startupAutomaticRefreshPending = false\s*\n\s*refreshLocalUsage\(automatic: true\)/u,
  );
  assert.equal(
    dashboardLoaded.indexOf("startupAutomaticRefreshPending = false")
      < dashboardLoaded.indexOf("refreshLocalUsage(automatic: true)"),
    true,
    "the launch-only refresh is consumed before collection starts",
  );

  // A page that never marks its result ready, a navigation failure, a
  // companion exit, or an explicit teardown all discard the pending work.
  assert.match(
    dashboardFailure,
    /cancelNativeRefreshSchedule\(\)[\s\S]*?startupAutomaticRefreshPending = false/u,
  );
  assert.match(
    dashboardTeardown,
    /cancelNativeRefreshSchedule\(\)[\s\S]*?startupAutomaticRefreshPending = false/u,
  );
  assert.match(companionExit, /startupAutomaticRefreshPending = false/u);
});

test("unified toolbar preserves the rich loopback report and single authority", async () => {
  const source = await readFile(SWIFT_SOURCE, "utf8");
  assert.match(
    source,
    /private final class AppDelegate: NSObject, NSApplicationDelegate,\s*NSWindowDelegate, NSToolbarDelegate/u,
  );
  // The standard AppKit window (and its traffic lights) remains; the toolbar
  // is a presentation layer on top of the existing embedded WebKit report.
  // Pin the DASHBOARD window's own style mask. The previous literal regex
  // also matched an unrelated window literal inside a smoke test, so it kept
  // passing while no longer describing the dashboard at all.
  // `.fullSizeContentView` is what lets the sidebar run behind the title bar.
  assert.match(source, /dashboardWindowStyleMask: NSWindow\.StyleMask = \[/u);
  assert.match(
    source,
    /dashboardWindowStyleMask: NSWindow\.StyleMask = \[[^\]]*\.fullSizeContentView/u,
  );
  assert.match(source, /styleMask: Self\.dashboardWindowStyleMask/u);
  assert.match(
    source,
    /newWindow\.toolbar = makeDashboardToolbar\(\)\s*\n\s*newWindow\.toolbarStyle = \.unified/u,
  );

  const chrome = source.match(
    /private final class NativeDashboardChrome: NSSplitViewController \{([\s\S]*?)\n\}\n\n@MainActor\nprivate final class AppDelegate/u,
  )?.[1];
  assert.ok(chrome, "native dashboard chrome should be present");
  // Removing the old in-content header prevents a second refresh/status row;
  // the existing sidebar and report stay in place beneath the toolbar.
  // The split controller owns pane geometry now, so there is no hand-written
  // top constraint. The genuine behaviour this block protects - no second
  // in-content refresh/status row - is asserted below and is unchanged.
  assert.match(chrome, /addSplitViewItem\(sidebarItem\)/u);
  assert.doesNotMatch(chrome, /\bheader\b/u);
  assert.doesNotMatch(chrome, /onRefresh/u);

  const toolbar = source.match(
    /private func makeDashboardToolbar\(\) -> NSToolbar \{([\s\S]*?)\n    \/\/\/ The dashboard runs inside a native AppKit shell/u,
  )?.[1];
  assert.ok(toolbar, "dashboard toolbar implementation should be present");
  assert.match(toolbar, /toolbarStatusRefreshIdentifier/u);
  assert.doesNotMatch(toolbar, /toolbarStatusIdentifier|toolbarRefreshIdentifier/u);
  assert.match(toolbar, /let button = NSButton\(/u);
  assert.match(toolbar, /action: #selector\(refreshDashboardFromToolbar\)/u);
  assert.match(toolbar, /nativeToolbarEvidenceTitle/u);
  assert.match(source, /nativeToolbarStatusColor\(isRefreshing:/u);
  assert.match(source, /case \.live:[\s\S]*?nativeDashboardFresh/u);
  assert.match(toolbar, /toolbarShareIdentifier/u);
  assert.match(toolbar, /toolbarSettingsIdentifier/u);
  assert.match(toolbar, /@objc private func refreshDashboardFromToolbar\(\) \{[\s\S]*?refreshLocalUsage\(automatic: false\)/u);
  assert.match(
    toolbar,
    /@objc private func showShareCardFromToolbar\(\) \{[\s\S]*?document\.getElementById\('share-panel'\)\?\.scrollIntoView/u,
  );
  // Toolbar actions must reuse the report and the already-running companion;
  // they may not become another parser, service, or native share process.
  assert.doesNotMatch(
    toolbar,
    /\b(?:CompanionProcess|Process|URLSession|NSSharingService)\b/u,
  );
});

test("toolbar pill narrates the real index build and terminal refresh failure", async () => {
  const source = await readFile(SWIFT_SOURCE, "utf8");
  // Deliberately re-pinned pill vocabulary: while the unified history index
  // is incomplete the idle pill says "Indexing <n> of <m>", and a refresh the
  // companion reports as failed says so. Both strings stay content-free -
  // fixed words plus locale-formatted counts, or a step name from the
  // companion's closed refresh-step vocabulary, never free-form text.
  assert.match(source, /return "Indexing \\\(indexed\) of \\\(total\)"/u);
  assert.match(source, /guard let step else \{ return "Refresh failed" \}/u);
  assert.match(source, /return "Refresh failed: \\\(step\)"/u);
  // Counts render with thousands separators and no abbreviation.
  assert.match(
    source,
    /private enum NativeToolbarStatusText \{[\s\S]*?decimalNumberFormatter\(\s*maximumFractionDigits: 0\s*\)/u,
  );
  // Failure identity first, then real indexing progress, outrank the
  // evidence prose; complete coverage plus a non-failed refresh restores
  // the existing "Fresh"/"Stale"/"Status" vocabulary untouched.
  assert.match(
    source,
    /private func nativeToolbarEvidenceTitle\(fallback: String\) -> String \{[\s\S]*?if let failure = nativeRefreshFailure \{[\s\S]*?if let coverage = nativeHistoryIndexingCoverage, !coverage\.isComplete \{[\s\S]*?switch nativeEvidenceState \{/u,
  );
  // The step vocabulary is closed on the client as well: an unrecognized
  // step renders as plain "Refresh failed".
  assert.match(
    source,
    /static let refreshFailureSteps: Set<String> = \[\s*"collector",\s*"accounting",\s*"archive_index",\s*"unified_index",\s*"assemble",\s*\]/u,
  );
  // Coverage is the companion's own overview payload: coverage.history
  // first, the pricing historyCoverage mirror second, and demo/synthetic
  // payloads never narrate indexing.
  assert.match(
    source,
    /\(root\["coverage"\] as\? \[String: Any\]\)\?\["history"\][\s\S]*?\(root\["pricing"\] as\? \[String: Any\]\)\?\["historyCoverage"\]/u,
  );
  assert.match(source, /\["demo", "synthetic"\]\.contains\(mode\)/u);
  // The failure receipt comes from /api/local/refresh, and only a "failed"
  // status may claim a failure.
  assert.match(
    source,
    /guard status == "failed" else \{ return \.notFailed \}/u,
  );
  // Both reads reuse the already-audited loopback reader rather than adding
  // a second session or network route.
  assert.match(source, /private extension LocalCompanionEvidenceReader \{/u);
  // A refresh terminal re-reads both facts before the pill claims a state.
  assert.match(
    source,
    /readNativeToolbarStatusFacts\(base: base\) \{ \[weak self\] in\s*\n\s*self\?\.finishNativeRefresh\(/u,
  );
  // While coverage is incomplete the idle pill re-reads it on a bounded
  // 30-second foreground cadence; a refresh start, coverage completion,
  // dashboard teardown, and quit all stop the poll, and it never becomes a
  // timer, helper, daemon, or background polling path.
  assert.match(source, /private static let indexingCoveragePollSeconds = 30/u);
  assert.match(
    source,
    /private func scheduleNativeIndexingCoveragePoll\(\) \{[\s\S]*?let coverage = nativeHistoryIndexingCoverage,\s*\n\s*!coverage\.isComplete/u,
  );
  assert.match(
    source,
    /cancelNativeRefreshSchedule\(\)\s*\n\s*cancelNativeIndexingCoveragePoll\(\)\s*\n\s*nativeRefreshInFlight = true/u,
  );
  assert.match(
    source,
    /func applicationWillTerminate\(_ notification: Notification\) \{[\s\S]*?cancelNativeIndexingCoveragePoll\(\)/u,
  );
});

test("dashboard sidebar resizes for real, wears the brand palette, and the titlebar carries the brand row", async () => {
  const source = await readFile(SWIFT_SOURCE, "utf8");
  // 1. The divider is a real control. AppKit applies a divider drag at
  // priority 490 (dragThatCannotResizeWindow); the previous .defaultHigh
  // (750) holding priority outranked the user's own drag, which is the
  // seam-that-lies the owner reported: a resize cursor over a divider that
  // refuses to move.
  assert.match(source, /static let sidebarMinimumThickness: CGFloat = 180/u);
  assert.match(source, /static let sidebarMaximumThickness: CGFloat = 320/u);
  assert.match(source, /static let sidebarRestingThickness: CGFloat = 216/u);
  assert.match(
    source,
    /private static let sidebarHoldingPriority = NSLayoutConstraint\.Priority\(260\)/u,
  );
  assert.match(
    source,
    /sidebarItem\.holdingPriority = Self\.sidebarHoldingPriority/u,
  );
  assert.doesNotMatch(source, /sidebarItem\.holdingPriority = \.defaultHigh/u);
  // The chosen width survives relaunch through the split view's own
  // autosave, and the designed 216pt opening width is seeded exactly once
  // so later launches never fight the user's chosen width.
  assert.match(source, /splitView\.autosaveName = Self\.splitAutosaveName/u);
  assert.match(source, /"com\.usagemonitor\.local\.dashboard-split\.v1"/u);
  assert.match(
    source,
    /override func viewDidAppear\(\) \{[\s\S]*?splitView\.setPosition\(Self\.sidebarRestingThickness, ofDividerAt: 0\)/u,
  );
  // The layout smoke asserts the same band the chrome enforces rather than
  // a drifting literal.
  assert.match(
    source,
    /NativeDashboardChrome\.sidebarMinimumThickness - 1/u,
  );
  // 1b. A collapsed sidebar must always be reopenable. The sidebar can be
  // collapsed by dragging its divider to the leading edge, the split view's
  // autosave persists that across relaunches, and a collapsed pane leaves no
  // divider to drag back — so builds through 0.1.16, which had neither a
  // toolbar item nor a menu command for it, stranded the window with no
  // navigation at all (owner-reported, 2026-08-22). Two independent ways back
  // are pinned here because the sidebar is the only navigation the packaged
  // app has: the web report hides its own sidebar in native mode.
  assert.match(source, /sidebarItem\.canCollapse = true/u);
  // The system toolbar toggle, in both the allowed and the default sets, so
  // it is present on a fresh install and cannot be customized away without
  // the menu command below still existing.
  const toolbarDefaults = source.match(
    /func toolbarDefaultItemIdentifiers\(\s*\n\s*_ toolbar: NSToolbar\s*\n\s*\) -> \[NSToolbarItem\.Identifier\] \{([\s\S]*?)\n    \}/u,
  )?.[1];
  assert.ok(toolbarDefaults, "the toolbar default identifiers are available");
  assert.match(toolbarDefaults, /\.toggleSidebar/u);
  const toolbarAllowed = source.match(
    /func toolbarAllowedItemIdentifiers\(\s*\n\s*_ toolbar: NSToolbar\s*\n\s*\) -> \[NSToolbarItem\.Identifier\] \{([\s\S]*?)\n    \}/u,
  )?.[1];
  assert.ok(toolbarAllowed, "the toolbar allowed identifiers are available");
  assert.match(toolbarAllowed, /\.toggleSidebar/u);
  // The standard macOS command and key equivalent, on the responder chain so
  // it reaches whichever dashboard window is key.
  assert.match(
    source,
    /action: #selector\(NSSplitViewController\.toggleSidebar\(_:\)\),\s*\n\s*keyEquivalent: "s"/u,
  );
  assert.match(
    source,
    /toggleSidebar\.keyEquivalentModifierMask = \[\.control, \.command\]/u,
  );
  // The one-time rescue must run BEFORE the seeding gate returns: every
  // already-installed user has the seeded marker set, and a stranded sidebar
  // is exactly the state those users are in, so a rescue behind that early
  // return would never execute for the people who need it.
  const viewDidAppear = source.match(
    /override func viewDidAppear\(\) \{([\s\S]*?)\n    \}/u,
  )?.[1];
  assert.ok(viewDidAppear, "the chrome's viewDidAppear is available");
  assert.ok(
    viewDidAppear.indexOf("rescueStrandedSidebar(defaults)")
      < viewDidAppear.indexOf("guard !defaults.bool(forKey: Self.splitSeededDefaultsKey)"),
    "the stranded-sidebar rescue must precede the seeding early return",
  );
  // The rescue fires once and then never fights a deliberate collapse.
  assert.match(
    source,
    /private func rescueStrandedSidebar\(_ defaults: UserDefaults\) \{\s*\n\s*guard !defaults\.bool\(forKey: Self\.sidebarRescuedDefaultsKey\) else \{\s*\n\s*return\s*\n\s*\}\s*\n\s*defaults\.set\(true, forKey: Self\.sidebarRescuedDefaultsKey\)/u,
  );
  // 2. The sidebar carries the web report's warm-paper palette over the
  // system material, and the selected row uses the brand's deep green
  // instead of the user's system accent. Both mirror the web tokens
  // --paper #f5f1e8 and --green #174f45 and resolve per appearance.
  assert.match(source, /private enum NativeBrandPalette/u);
  assert.match(
    source,
    /srgbRed: 245 \/ 255,\s*\n\s*green: 241 \/ 255,\s*\n\s*blue: 232 \/ 255/u,
  );
  assert.match(
    source,
    /srgbRed: 23 \/ 255,\s*\n\s*green: 79 \/ 255,\s*\n\s*blue: 69 \/ 255/u,
  );
  assert.match(source, /private final class NativeSidebarBrandWash: NSView/u);
  assert.match(source, /sidebar\.addSubview\(sidebarWash\)/u);
  assert.match(
    source,
    /override func updateLayer\(\) \{\s*\n\s*layer\?\.backgroundColor = NativeBrandPalette\.sidebarWash\.cgColor/u,
  );
  assert.match(
    source,
    /button\.contentTintColor = selected\s*\n\s*\? NativeBrandPalette\.accent/u,
  );
  // 3. The titlebar shows the brand row - the bundle's own icon beside the
  // wordmark in brand green - as a native accessory. The window keeps its
  // title for Mission Control, the window menu, and accessibility; only
  // the titlebar's text drawing is replaced, and nothing about the row is
  // a web view.
  assert.match(source, /newWindow\.titleVisibility = \.hidden/u);
  assert.match(
    source,
    /newWindow\.addTitlebarAccessoryViewController\(\s*\n\s*Self\.makeTitlebarBrandAccessory\(\)/u,
  );
  const accessory = source.match(
    /private static func makeTitlebarBrandAccessory\(\)[\s\S]*?\n    \}/u,
  )?.[0] ?? "";
  assert.ok(accessory, "titlebar brand accessory factory should be present");
  assert.match(accessory, /NSImageView\(image: NSApp\.applicationIconImage\)/u);
  assert.match(accessory, /wordmark\.textColor = NativeBrandPalette\.accent/u);
  assert.match(accessory, /accessory\.layoutAttribute = \.left/u);
  assert.doesNotMatch(accessory, /WKWebView|WebKit/u);
  // Deliberately re-pinned 2026-08-08: AppKit stretches a left accessory to
  // the full titlebar container (66pt on macOS 26) while the traffic lights
  // and toolbar controls centre on the toolbar row at its top, which sat the
  // brand a visible 7pt low. The row now rides in NativeTitlebarBrandRow,
  // which centres it on the close button's own measured axis.
  assert.match(
    accessory,
    /accessory\.view = NativeTitlebarBrandRow\(content: row\)/u,
  );
  const brandRow = source.match(
    /private final class NativeTitlebarBrandRow: NSView \{[\s\S]*?\n\}/u,
  )?.[0] ?? "";
  assert.ok(brandRow, "titlebar brand row container should be present");
  assert.match(
    brandRow,
    /window\?\.standardWindowButton\(\.closeButton\)/u,
  );
  assert.match(brandRow, /centerY = convert\(anchorInWindow, from: nil\)\.midY/u);
  assert.match(
    brandRow,
    /y: \(centerY - size\.height \/ 2\)\.rounded\(\)/u,
  );
});

test("menu-bar status item degrades honestly and never invents allowance evidence", async () => {
  const source = await readFile(MENU_BAR_STATUS_SOURCE, "utf8");
  assert.match(source, /import AppKit/u);
  // Variable-length item with the branded app mark, sized for the native
  // status bar rather than a generic system chart glyph.
  assert.match(
    source,
    /NSStatusBar\.system\.statusItem\(\s*withLength: NSStatusItem\.variableLength\s*\)/u,
  );
  assert.match(source, /private static func makeBrandBirdTemplate\(\)/u);
  // Regression guard (v0.1.4 shipped the generic SF Symbols bird): the brand
  // mark extracted from the approved app icon must be the preferred glyph,
  // and the extractor must fail to nil — the single fallback decision lives
  // in makeBrandBirdTemplate, never hidden inside the extractor.
  assert.match(
    source,
    /private static func makeBrandBirdTemplate\(\) -> NSImage\? \{\s*if let asset = makeAssetBirdTemplate\(\) \{ return asset \}\s*return nativeBirdTemplate\(\)\s*\}/u,
    "brand bird template must prefer the app-icon mark over the SF Symbols bird",
  );
  assert.doesNotMatch(
    source,
    /if let native = nativeBirdTemplate\(\) \{ return native \}/u,
    "the generic SF Symbols bird must never be preferred over the brand mark",
  );
  const assetExtractor = source.match(
    /private static func makeAssetBirdTemplate\(\)[\s\S]*?\n    \}/u,
  )?.[0] ?? "";
  assert.ok(assetExtractor, "asset bird extractor should be present");
  assert.doesNotMatch(
    assetExtractor,
    /nativeBirdTemplate\(\)/u,
    "extractor failure paths must return nil, not silently substitute the generic bird",
  );
  assert.match(
    assetExtractor,
    /alphaComponent/u,
    "extractor must gate on source alpha so shadow and corner pixels never speckle the mark",
  );
  assert.match(source, /NSApp\.applicationIconImage|application\.applicationIconImage/u);
  assert.match(source, /template\.isTemplate = true/u);
  assert.match(source, /systemSymbolName: "bird\.fill"/u);
  assert.match(source, /let glyphSize = NSSize\(width: 16, height: 16\)/u);
  assert.doesNotMatch(source, /NSApp\.applicationIconImage\.copy\(\)/u);
  assert.doesNotMatch(source, /source\.size = NSSize\(width: 16, height: 16\)/u);
  assert.match(source, /private static func statusGlyph\([\s\S]*?state: StatusGlyphState/u);
  assert.match(source, /private static func glyphState\(/u);
  assert.match(source, /private static func drawMeter\(/u);
  assert.match(source, /case live\(remainingPercent: Double\)/u);
  assert.match(source, /case \.stale|case \.analyzing|case \.unavailable/u);
  assert.doesNotMatch(source, /systemSymbolName: "chart\.bar\.fill"/u);
  assert.doesNotMatch(source, /url\(forResource: "AppIcon", withExtension: "icns"\)/u);
  assert.match(source, /setAccessibilityLabel\(/u);
  assert.match(source, /glyph\.accessibilityDescription = "\\\(productName\) status"/u);
  assert.match(source, /TiboTattleLocalization\.string\(\.menuSettings\)/u);
  assert.match(source, /configure\(\s*aboutItem,/u);
  assert.match(source, /#selector\(showAbout\)/u);

  // The compact title shows a number only for live evidence; stale, absent,
  // starting, failed, and analyzing states all collapse to a placeholder.
  assert.match(
    source,
    /guard phase == \.ready, evidence == \.live, let lane = primaryLane else \{\s*return unknownPlaceholder/u,
  );
  assert.match(source, /if phase == \.analyzing \{ return analyzingPlaceholder \}/u);
  assert.match(source, /private let analyzingPlaceholder = "…"/u);
  assert.match(source, /private let unknownPlaceholder = "–"/u);
  assert.match(
    source,
    /TiboTattleLocalization\.string\(\.menuBarNoVerifiedAllowance\)/u,
  );
  assert.match(
    source,
    /TiboTattleLocalization\.string\(\.menuBarLocalEvidenceStale\)/u,
  );
  assert.match(source, /func resetCountdown\(_ date: Date\?, now: Date = Date\(\)\) -> String\?/u);
  assert.match(source, /guard companionReachable, evidence == \.live else/u);

  // Only the normal Codex allowance track is projected with fixed
  // privacy-safe labels; a separate product can never become the title.
  assert.match(
    source,
    /private let weeklyWindowDurationMinutes\s*=\s*\n\s*CodexQuotaWindowDuration\.sevenDayMinutes/u,
  );
  assert.match(source, /private let codexPrimaryLimitId = "codex"/u);
  assert.match(
    source,
    /private let supportedCodexAllowanceWindowDurations\s*=\s*\n\s*1\.\.\.CodexQuotaWindowDuration\.maximumMinutes/u,
  );
  assert.match(source, /let candidates = rows\.compactMap/u);
  assert.match(source, /guard Self\.isSupportedCodexAllowance\(/u);
  assert.match(source, /let durationMinutes: Int/u);
  assert.match(
    source,
    /func weeklyWindowPosition\(_ lane: ObservedQuotaLane\) -> WeeklyWindowPosition\?/u,
  );
  assert.match(source, /lane\.durationMinutes == weeklyWindowDurationMinutes/u);
  assert.match(source, /let observedAt = lane\.observedAt/u);
  assert.match(
    source,
    /TiboTattleLocalization\.format\(\s*\.menuBarQuotaWeeklyPositionResets,/u,
  );
  assert.match(
    source,
    /return TiboTattleLocalization\.string\(\.menuBarFiveHourAllowance\)/u,
  );
  assert.match(
    source,
    /return TiboTattleLocalization\.string\(\.menuBarSevenDayAllowance\)/u,
  );
  assert.match(source, /left\.durationMinutes > right\.durationMinutes/u);
  assert.match(source, /left\.isExplicitPrimary != right\.isExplicitPrimary/u);
  assert.match(source, /return left\.stableKey < right\.stableKey/u);
  assert.match(source, /isPrimary: index == 0/u);
  assert.match(source, /TiboTattleLocalization\.quotaWindowLabel\(/u);
  assert.match(source, /let observedAt = lanes\.compactMap\(\\\.observedAt\)\.max\(\)/u);
  assert.doesNotMatch(source, /codex_bengalfox|Secondary observed allowance|Observed quota lane/u);
  assert.match(
    source,
    /guard overview\.freshnessStatus == "live" else \{ return \.stale \}/u,
  );

  // Menu contract: every information lane is a standard native text item.
  // This deliberately forbids custom NSMenuItem views: a source-level
  // assertion prevents the zero-frame regression from returning without a
  // real AppKit harness.
  assert.match(source, /menu\.autoenablesItems = false/u);
  assert.match(source, /allowanceItem\.isEnabled = false/u);
  assert.match(source, /evidenceItem\.isEnabled = false/u);
  assert.match(source, /allowanceItem\.title =/u);
  assert.match(source, /evidenceItem\.title = snapshot\.evidenceSummary/u);
  assert.doesNotMatch(source, /MenuBarSummaryView|MenuBarQuotaLaneView/u);
  assert.doesNotMatch(source, /\.view\s*=(?!=)/u);
  assert.doesNotMatch(source, /evidenceItem\.isHidden|allowanceItem\.isHidden/u);
  assert.match(
    source,
    /TiboTattleLocalization\.format\(\.menuBarOpenProduct, productName\)/u,
  );
  assert.match(source, /openTiboTattleItem\.isEnabled = true/u);
  assert.match(
    source,
    /TiboTattleLocalization\.string\(\.menuBarAnalyzeLocalUsage\)/u,
  );
  assert.match(
    source,
    /TiboTattleLocalization\.string\(\.menuBarRetryLocalAnalysis\)/u,
  );
  assert.match(
    source,
    /TiboTattleLocalization\.string\(\.menuBarUpdateLocalUsage\)/u,
  );
  assert.match(
    source,
    /TiboTattleLocalization\.string\(\.menuBarAnalyzingLocalUsage\)/u,
  );
  assert.match(
    source,
    /TiboTattleLocalization\.format\(\.menuQuitProduct, productName\)/u,
  );
  assert.match(source, /private var quotaLaneItems: \[NSMenuItem\] = \[\]/u);
  assert.match(source, /func renderQuotaLanes\(\)/u);
  assert.match(
    source,
    /let item = NSMenuItem\(\s*title: snapshot\.laneSummary\(lane\),\s*action: nil,\s*keyEquivalent: ""\s*\)/u,
  );
  assert.match(source, /item\.isEnabled = false/u);
  assert.match(source, /menu\.insertItem\(item, at: insertionIndex \+ offset\)/u);
  assert.doesNotMatch(source, /showWindowItem/u);
  assert.doesNotMatch(source, /openDashboardItem/u);
  assert.match(
    source,
    /analyzeItem\.isEnabled = snapshot\.phase == \.ready\s*\n\s*\|\| \(snapshot\.phase == \.unavailable && dashboardURL != nil\)/u,
  );

  // Keep the standard NSStatusItem menu lifecycle intact. Escape and app
  // deactivation both cancel native menu tracking, and every action clears
  // tracking before it can open another app surface.
  assert.match(source, /statusItem\.menu = menu/u);
  assert.match(
    source,
    /NSEvent\.addLocalMonitorForEvents\(matching: \.keyDown\)[\s\S]*?event\.keyCode == 53[\s\S]*?self\.dismissMenu\(\)/u,
  );
  assert.match(
    source,
    /NSEvent\.addLocalMonitorForEvents\([\s\S]*?\.leftMouseDown[\s\S]*?event\.window[\s\S]*?NSApp\.windows\.contains[\s\S]*?self\.dismissMenu\(\)/u,
  );
  assert.match(
    source,
    /NSApplication\.didResignActiveNotification[\s\S]*?self\?\.dismissMenu\(\)/u,
  );
  assert.match(source, /private func dismissMenu\(\) \{\s*menu\.cancelTracking\(\)/u);
  assert.match(
    source,
    /func shutDown\(\) \{[\s\S]*?dismissMenu\(\)[\s\S]*?removeInteractionMonitoring\(\)/u,
  );
  for (const action of [
    "openTiboTattle",
    "analyzeLocalUsage",
    "quit",
    "showSettings",
    "showAbout",
    "checkForUpdates",
  ]) {
    assert.match(
      source,
      new RegExp(`@objc private func ${action}\\(\\) \\{[\\s\\S]*?dismissMenu\\(\\)`, "u"),
      action,
    );
  }

  // Restart/failure/read errors clear numeric evidence before rendering. A
  // callback from an older URL or start cannot cross the generation boundary.
  assert.match(source, /private var companionGeneration: UInt64 = 0/u);
  assert.match(source, /private func invalidateObservedEvidence\(\) \{[\s\S]*?snapshot\.lanes = \[\][\s\S]*?snapshot\.observedAt = nil[\s\S]*?snapshot\.evidence = \.none/u);
  assert.match(source, /func companionStarting\(\) \{[\s\S]*?invalidateObservedEvidence\(\)/u);
  assert.match(source, /func companionUnavailable\(summary: String\?\) \{[\s\S]*?invalidateObservedEvidence\(\)/u);
  assert.match(source, /guard let overview else \{[\s\S]*?invalidateObservedEvidence\(\)[\s\S]*?snapshot\.phase = \.unavailable/u);
  assert.match(source, /self\.companionGeneration == generation/u);
  assert.match(source, /self\.dashboardURL == dashboardURL/u);

  // Cached titles are reconciled before tracking starts. Async reads may only
  // update existing rows while open; changed lane structure waits for close.
  assert.match(
    source,
    /func menuWillOpen\(_ menu: NSMenu\) \{[\s\S]*?render\(\)\s*\n\s*isMenuTracking = true\s*\n\s*pollNow\(\)/u,
  );
  assert.match(
    source,
    /func menuDidClose\(_ menu: NSMenu\) \{[\s\S]*?structuralRebuildPending[\s\S]*?render\(\)/u,
  );
  assert.match(source, /if isMenuTracking && structureChanged/u);
  assert.match(source, /structuralRebuildPending = true/u);
  assert.match(source, /deferredLaneTitle/u);
  assert.match(source, /private func expireCachedEvidenceIfNeeded\(\)/u);

  // The analyze item drives the companion's own refresh route with the exact
  // same-origin proof the dashboard button sends.
  assert.match(source, /"\/api\/local\/refresh"/u);
  assert.match(source, /"\/api\/local\/overview"/u);
  assert.match(source, /#"\{"reason":"user_request"\}"#/u);
  assert.match(source, /forHTTPHeaderField: "X-Usage-Monitor-Local"/u);
  assert.match(source, /forHTTPHeaderField: "Origin"/u);
  assert.match(source, /case 409:\s*\n\s*result = \.alreadyRunning/u);

  // Loopback only, ephemeral, size-capped, and bounded. A minute cadence
  // permits stale evidence to trigger one while-open refresh without a daemon.
  assert.match(source, /URLSessionConfiguration\.ephemeral/u);
  assert.match(source, /host == "127\.0\.0\.1" \|\| host == "localhost"/u);
  assert.match(source, /components\.scheme == "http"/u);
  assert.match(source, /maximumResponseBytes/u);
  assert.match(source, /idlePollSeconds = 60/u);
  assert.match(source, /func refreshStaleEvidenceIfNeeded\(\)/u);
  assert.match(source, /!snapshot\.lanes\.isEmpty/u);
  assert.match(source, /func menuWillOpen\(_ menu: NSMenu\)/u);
  for (const forbidden of [
    "URLSessionConfiguration.background",
    "https://",
    "Timer.scheduledTimer",
    "LaunchAgents",
    "SMAppService",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("native quota duration and reset scheduling stay bounded and provider-aware", async () => {
  const [menuSource, notificationSource, localizationSource] = await Promise.all([
    readFile(MENU_BAR_STATUS_SOURCE, "utf8"),
    readFile(QUOTA_NOTIFICATIONS_SOURCE, "utf8"),
    readFile(LOCALIZATION_SOURCE, "utf8"),
  ]);
  assert.match(
    localizationSource,
    /static let maximumMinutes = 525_600/u,
  );
  assert.match(
    localizationSource,
    /static func integer\(from value: Any\?\) -> Int\?/u,
  );
  assert.match(
    localizationSource,
    /return "Provider-reported .*englishUnit.*window"/u,
  );
  assert.match(
    menuSource,
    /CodexQuotaWindowDuration\.integer\(\s*\n\s*from: row\["durationMinutes"\]\s*\n\s*\)/u,
  );
  assert.match(
    notificationSource,
    /CodexQuotaWindowDuration\.integer\(\s*\n\s*from: rawWindow\["durationMinutes"\]\s*\n\s*\)/u,
  );
  assert.match(
    notificationSource,
    /CodexQuotaWindowDuration\.isValid\(window\.durationMinutes\)/u,
  );
  assert.match(
    notificationSource,
    /case "provider_reported_identity"[\s\S]*?validProviderResetIdentity/u,
  );
  assert.match(
    notificationSource,
    /let resetIsDue = observedAt >= previousResetAt/u,
  );
  assert.match(
    notificationSource,
    /Schedule-only fallback[\s\S]*?previous\.resetAt[\s\S]*?kind: \.reset/u,
  );
  assert.match(
    notificationSource,
    /A provider schedule change before the old due time is not a\n\s*\/\/ reset/u,
  );
  assert.doesNotMatch(
    menuSource + "\n" + localizationSource,
    /monthly\s+limit|plan\s+entitlement/iu,
  );
});

test("targeted local Keychain reset removes only exact local capabilities and residue", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-keychain-reset-test-"),
  );
  const stateRoot = join(temporaryRoot, "state");
  const retained = join(
    stateRoot,
    "private",
    "contribution-sync-v0.1.sqlite3",
  );
  const deviceState = join(
    stateRoot,
    "contribution-device-binding-v1.json",
  );
  const exportResidue = join(stateRoot, "export-participant-secret");
  const stored = new Map([
    // Both contribution-device storage generations: the app-minted broker
    // item and the companion-minted legacy item are one credential surface
    // and the reset must clear whichever exist. Only the legacy item is
    // reachable through the decrypting backend — the app-minted item's ACL
    // names the signed app alone, so this helper never reads it and the map
    // below deliberately offers no way to.
    [
      "app-usagemonitor.contribution-device.v1",
      Buffer.alloc(32, 0x31),
    ],
    [
      "app-usagemonitor.export-identity.v1",
      Buffer.alloc(32, 0x32),
    ],
    [
      "app-usagemonitor.account-observation.v1",
      Buffer.alloc(32, 0x33),
    ],
  ]);
  // The app-minted generation, addressed only by service and account. An
  // attribute delete never decrypts, so nothing here is a secret.
  const attributeItems = new Set([
    "app-usagemonitor.contribution-device.app.v1",
  ]);
  const partialStored = new Map([
    [
      "app-usagemonitor.contribution-device.v1",
      Buffer.alloc(32, 0x41),
    ],
    [
      "app-usagemonitor.export-identity.v1",
      Buffer.alloc(32, 0x42),
    ],
  ]);
  const calls = [];
  const backend = {
    async read(capability) {
      calls.push(["read", capability.service]);
      const value = stored.get(capability.service);
      return value ? Buffer.from(value) : null;
    },
    async deleteExact(capability, expected) {
      calls.push(["deleteExact", capability.service]);
      const current = stored.get(capability.service);
      if (!current || !current.equals(expected)) return "conflict";
      current.fill(0);
      stored.delete(capability.service);
      return "deleted";
    },
  };
  const attributeProbe = (capability) => {
    calls.push(["attributeProbe", capability.service]);
    return attributeItems.has(capability.service) ? "present" : "missing";
  };
  const attributeDelete = (capability) => {
    calls.push(["attributeDelete", capability.service]);
    return attributeItems.delete(capability.service) ? "deleted" : "missing";
  };
  try {
    await mkdir(stateRoot, { mode: 0o700 });
    await mkdir(join(stateRoot, "private"), { mode: 0o700 });
    await writeFile(deviceState, "{}\n", { mode: 0o600 });
    await writeFile(exportResidue, `${"A".repeat(43)}\n`, {
      mode: 0o600,
    });
    await writeFile(retained, "{\"retained\":true}\n", { mode: 0o600 });

    const result = await resetLocalKeychainIdentityAndDevice({
      backend,
      stateRoot,
      attributeProbe,
      attributeDelete,
    });
    assert.deepEqual(result, {
      schemaVersion: "usage-monitor-local-keychain-reset-v1",
      status: "reset",
      appState: {
        allAppStateErased: false,
        contributionDeviceBinding: "removed",
        exportIdentityFileResidue: "removed",
        otherAppStateRetained: true,
      },
      keychain: {
        contributionDevice: "removed",
        exportIdentity: "removed",
        secureErasureClaimed: false,
      },
      hosted: {
        dataDeleted: false,
        deviceRevoked: false,
      },
    });
    // The app-minted generation is cleared by attribute and the legacy one by
    // exact value. The helper must never decrypt the app generation: reading
    // it would require the very node trusted-application entry that
    // `designatedReaderAccess()` no longer mints, and a keytar read of an item
    // this process is not trusted for is precisely what raises a dialog.
    assert.deepEqual(
      calls.filter(([method]) => method === "attributeDelete"),
      [["attributeDelete", "app-usagemonitor.contribution-device.app.v1"]],
    );
    assert.deepEqual(
      calls.filter(([method]) => method === "deleteExact"),
      [
        ["deleteExact", "app-usagemonitor.contribution-device.v1"],
        ["deleteExact", "app-usagemonitor.export-identity.v1"],
      ],
    );
    assert.equal(
      calls.some(([method, service]) =>
        method === "read"
        && service === "app-usagemonitor.contribution-device.app.v1"),
      false,
      "the app-minted generation is never decrypted",
    );
    // Every attribute probe is a preflight: none may run after the first
    // mutation, so the read-only phase stays complete before anything changes.
    assert.equal(
      calls.findLast(([method]) => method === "attributeProbe") !== undefined
        && calls.indexOf(calls.findLast(([method]) =>
          method === "attributeProbe"))
          < calls.findIndex(([method]) =>
            method === "attributeDelete" || method === "deleteExact"),
      true,
      "attribute probes complete before any deletion",
    );
    assert.equal(attributeItems.size, 0);
    assert.equal(
      stored.has("app-usagemonitor.account-observation.v1"),
      true,
    );
    assert.equal(await readFile(retained, "utf8"), "{\"retained\":true}\n");
    await assert.rejects(lstat(deviceState), { code: "ENOENT" });
    await assert.rejects(lstat(exportResidue), { code: "ENOENT" });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(stateRoot), false);
    assert.equal(serialized.includes("app-usagemonitor."), false);

    await writeFile(deviceState, "{}\n", { mode: 0o600 });
    await writeFile(exportResidue, `${"B".repeat(43)}\n`, {
      mode: 0o600,
    });
    const partialDeletes = [];
    const partial = await resetLocalKeychainIdentityAndDevice({
      stateRoot,
      backend: {
        async read(capability) {
          const value = partialStored.get(capability.service);
          return value ? Buffer.from(value) : null;
        },
        async deleteExact(capability) {
          partialDeletes.push(capability.service);
          const error = new Error("must not escape");
          error.code = "export_identity_keychain_locked";
          throw error;
        },
      },
      // This install predates the app generation: the attribute leg is a
      // clean miss, and the locked legacy delete is what makes it partial.
      attributeProbe: () => "missing",
      attributeDelete: () => "missing",
    });
    assert.deepEqual(partial, {
      schemaVersion: "usage-monitor-local-keychain-reset-v1",
      status: "partial",
      failureCode: "UM_MACOS_KEYCHAIN_LOCKED",
      appState: {
        allAppStateErased: false,
        contributionDeviceBinding: "removed",
        exportIdentityFileResidue: "removed",
        otherAppStateRetained: true,
      },
      keychain: {
        contributionDevice: "unknown",
        exportIdentity: "retained",
        secureErasureClaimed: false,
      },
      hosted: {
        dataDeleted: false,
        deviceRevoked: false,
      },
    });
    assert.deepEqual(partialDeletes, [
      "app-usagemonitor.contribution-device.v1",
    ]);
    assert.equal(JSON.stringify(partial).includes("must not escape"), false);

    const unsafeTarget = join(temporaryRoot, "outside");
    await writeFile(unsafeTarget, "outside", { mode: 0o600 });
    await symlink(unsafeTarget, deviceState);
    await assert.rejects(
      resetLocalKeychainIdentityAndDevice({
        backend,
        stateRoot,
        attributeProbe,
        attributeDelete,
      }),
      { code: "UM_MACOS_KEYCHAIN_RESET_STATE_UNSAFE" },
    );
    assert.equal(await readFile(unsafeTarget, "utf8"), "outside");
  } finally {
    for (const secret of stored.values()) secret.fill(0);
    for (const secret of partialStored.values()) secret.fill(0);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("the app Keychain broker mints the contribution credential app-side over the spawn socketpair", async () => {
  const [source, brokerSource] = await Promise.all([
    readFile(SWIFT_SOURCE, "utf8"),
    readFile(KEYCHAIN_BROKER_SOURCE, "utf8"),
  ]);

  // The Swift storage generation and channel announcement stay in lockstep
  // with the companion-side broker client.
  const appCapability = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDeviceApp;
  assert.equal(
    brokerSource.includes(`static let service = "${appCapability.service}"`),
    true,
  );
  assert.equal(
    brokerSource.includes(`static let account = "${appCapability.account}"`),
    true,
  );
  assert.equal(
    brokerSource.includes(
      `static let environmentVariable = "${CONTRIBUTION_DEVICE_KEYCHAIN_BROKER_FD_ENV}"`,
    ),
    true,
  );

  // The channel is a kernel socketpair: close-on-exec on both raw ends, a
  // dead peer surfaces as a write error rather than SIGPIPE, and frames are
  // bounded so anything that is not this protocol fails the channel closed.
  assert.match(brokerSource, /socketpair\(AF_UNIX, SOCK_STREAM, 0, &endpoints\)/u);
  assert.match(brokerSource, /F_SETFD, FD_CLOEXEC/u);
  assert.match(brokerSource, /SO_NOSIGPIPE/u);
  assert.match(brokerSource, /maximumFrameBytes = 4_096/u);
  assert.match(brokerSource, /storedSecretPattern = "\^\[A-Za-z0-9_-\]\{43\}\$"/u);
  // Reads, Keychain operations, and teardown share one dispatch queue, and
  // only the read source's cancellation handler closes the descriptor — a
  // read can therefore never race the close.
  assert.match(
    brokerSource,
    /DispatchSource\.makeReadSource\(\s*fileDescriptor: descriptor,\s*queue: queue\s*\)/u,
  );
  assert.match(
    brokerSource,
    /source\.setCancelHandler \{\s*close\(descriptor\)\s*\}/u,
  );

  // Mint and read happen through SecItem in the login keychain; the
  // data-protection keychain is rejected until the app carries the
  // provisioning-profile entitlement it requires.
  assert.match(brokerSource, /SecItemAdd\(/u);
  assert.match(brokerSource, /SecItemCopyMatching\(/u);
  assert.match(brokerSource, /SecItemDelete\(/u);
  assert.doesNotMatch(brokerSource, /kSecUseDataProtectionKeychain/u);
  // Never SecItemUpdate: Apple's implementation answers an update that hits
  // errSecVerifyFailed by recreating the item with a DEFAULT access control
  // list (_ReplaceKeychainItem → SecKeychainItemCreateFromContent with
  // initialAccess = NULL), silently widening the app-only ACL to the system
  // default — a change nothing would observe, because this app keeps access
  // either way. Every ~25-day rotation takes the duplicate path, so the
  // replacement must be a delete followed by an add that carries the access
  // object again.
  assert.doesNotMatch(brokerSource, /SecItemUpdate\(/u);
  assert.match(
    brokerSource,
    /guard status == errSecDuplicateItem else \{\s*return Self\.failureCode\(status\)\s*\}/u,
  );
  assert.match(
    brokerSource,
    /let removal = SecItemDelete\(baseQuery\(\) as CFDictionary\)[\s\S]*?let replacement = SecItemAdd\(attributes as CFDictionary, nil\)/u,
  );

  // No SecItem call may raise a dialog. This queue serializes reads, Keychain
  // work, responses, and teardown, so a modal prompt would block the channel
  // until the companion's timeout poisoned its transport permanently — the
  // user answering correctly would find it already dead. Suppressed, those
  // states return errSecInteractionNotAllowed and take the existing locked
  // path instead.
  assert.match(
    brokerSource,
    /SecKeychainSetUserInteractionAllowed\(false\)\s*\n\s*defer \{ SecKeychainSetUserInteractionAllowed\(true\) \}/u,
  );
  // Every SecItem call site sits after the withoutUserInteraction that opens
  // its enclosing function, so none can be added outside the suppression.
  for (const call of ["SecItemCopyMatching(", "SecItemAdd(", "SecItemDelete("]) {
    let index = brokerSource.indexOf(call);
    assert.notEqual(index, -1, call);
    while (index !== -1) {
      const preceding = brokerSource.slice(0, index);
      assert.equal(
        preceding.lastIndexOf("withoutUserInteraction")
          > preceding.lastIndexOf("private func "),
        true,
        `${call} at ${index} is outside withoutUserInteraction`,
      );
      index = brokerSource.indexOf(call, index + call.length);
    }
  }
  // Items address only the app-managed service; the legacy `.v1` item is
  // structurally unreachable from app-side code.
  assert.match(brokerSource, /kSecAttrService as String: Self\.service/u);

  // Every fresh item trusts THIS APP AND NOTHING ELSE by designated
  // requirement, and a mint without that access object fails closed.
  //
  // This is the broker's whole confidentiality claim, so it is pinned
  // exactly. `runtime/bin/node` was in this list until 2026-08-20 for the
  // reset helper's keytar read, and while it was, the claim was false: node
  // is a world-executable general-purpose interpreter inside the bundle, so
  // ANY same-user process could run it, satisfy the designated requirement,
  // and read the credential silently. The reset helper now clears the
  // app-minted generation by attribute (never decrypting, so never consulting
  // an ACL), which is what allows exactly one entry here.
  assert.match(
    brokerSource,
    /SecTrustedApplicationCreateFromPath\(nil, &trustedSelf\)/u,
  );
  const accessSource = brokerSource.slice(
    brokerSource.indexOf("private func designatedReaderAccess"),
    brokerSource.indexOf("private func storeSecret"),
  );
  assert.notEqual(accessSource, "");
  // Exactly one trusted application is created, and the array handed to
  // SecAccessCreate holds exactly that one.
  assert.equal(
    accessSource.match(/SecTrustedApplicationCreateFromPath\(/gu)?.length,
    1,
  );
  assert.match(
    accessSource,
    /SecAccessCreate\(\s*Self\.service as CFString,\s*\[appTrust\] as CFArray,\s*&access\s*\)/u,
  );
  // Nothing in the broker may name a second reader: no node runtime path may
  // reach the access object, by any route.
  assert.doesNotMatch(brokerSource, /nodeRuntimePath/u);
  assert.doesNotMatch(brokerSource, /trustedReader/u);
  assert.match(brokerSource, /kSecAttrAccess as String/u);
  assert.match(
    brokerSource,
    /guard let access = designatedReaderAccess\(\) else \{\s*return "operation_failed"/u,
  );

  // Failure classification keeps the companion's locked/denied identities.
  assert.match(
    brokerSource,
    /case errSecInteractionNotAllowed:\s*return "locked"/u,
  );
  assert.match(
    brokerSource,
    /case errSecAuthFailed, errSecUserCanceled:\s*return "denied"/u,
  );

  // Spawn wiring: the companion's standard input is the broker endpoint, the
  // environment names only the descriptor, the parent drops its copy of the
  // child end after the spawn, and termination tears the broker down.
  assert.match(
    source,
    /child\.standardInput = broker\?\.childEndpoint \?\? FileHandle\.nullDevice/u,
  );
  assert.match(
    source,
    /let broker = try\? ContributionDeviceKeychainBroker\(\)/u,
  );
  assert.match(
    source,
    /if broker\?\.childEndpoint != nil \{\s*environment\[\s*ContributionDeviceKeychainBroker\.environmentVariable\s*\] = "0"/u,
  );
  assert.match(source, /broker\?\.closeChildEndpoint\(\)/u);
  const terminationSource = source.slice(
    source.indexOf("private func didTerminate"),
    source.indexOf("func stop(completion:"),
  );
  assert.match(terminationSource, /broker\?\.shutdown\(\)/u);

  // The one-shot reset helper runs without a broker: its standard input
  // stays the null device and its environment never announces a channel.
  const resetHelperSource = source.slice(
    source.indexOf("private func launchLocalKeychainResetHelper"),
    source.indexOf("private func finishLocalKeychainReset"),
  );
  assert.match(
    resetHelperSource,
    /child\.standardInput = FileHandle\.nullDevice/u,
  );
  assert.equal(
    resetHelperSource.includes(CONTRIBUTION_DEVICE_KEYCHAIN_BROKER_FD_ENV),
    false,
  );
});

test("the app-minted credential's only reader is the app, and the reset helper needs no ACL", async () => {
  // The load-bearing pair, pinned together because either half alone is a
  // trap. The app-only ACL is only safe while nothing outside the app needs
  // to decrypt the item; the reset helper is the only such candidate, and it
  // is a broker-less node process (pinned above: null stdin, no announcement).
  // If someone re-adds the app generation to the helper's decrypting list, its
  // keytar read would fail or prompt on every reset — so this test fails
  // instead, naming the fix.
  const [brokerSource, helperSource] = await Promise.all([
    readFile(KEYCHAIN_BROKER_SOURCE, "utf8"),
    readFile(
      new URL("../apps/macos/reset-local-keychain.js", import.meta.url),
      "utf8",
    ),
  ]);
  const appService =
    EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDeviceApp.service;
  const legacyService =
    EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice.service;

  // One trusted application on the app-minted item, and it is this app.
  const accessSource = brokerSource.slice(
    brokerSource.indexOf("private func designatedReaderAccess"),
    brokerSource.indexOf("private func storeSecret"),
  );
  assert.equal(
    accessSource.match(/SecTrustedApplicationCreateFromPath\(/gu)?.length,
    1,
  );
  assert.match(
    accessSource,
    /SecTrustedApplicationCreateFromPath\(nil, &trustedSelf\)/u,
  );
  assert.match(accessSource, /\[appTrust\] as CFArray/u);

  // The helper's target table: the app generation is attribute-addressed
  // only, the legacy generation keeps its decrypting read + exact delete.
  const targets = helperSource.match(
    /const TARGETS = Object\.freeze\(\[([\s\S]*?)\n\]\);/u,
  )?.[1];
  assert.ok(targets, "the reset helper's target table is available");
  const decrypting = targets.slice(
    targets.indexOf("capabilities: Object.freeze(["),
    targets.indexOf("attributeCapabilities: Object.freeze(["),
  );
  assert.equal(decrypting.includes("contributionDeviceApp"), false);
  assert.equal(decrypting.includes("contributionDevice,"), true);
  assert.match(
    targets,
    /attributeCapabilities: Object\.freeze\(\[\s*EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES\.contributionDeviceApp,\s*\]\)/u,
  );
  // The helper reaches the attribute-addressed platform operations, which are
  // the ones that never decrypt.
  assert.match(
    helperSource,
    /deleteExportIdentityKeychainItemByAttributes,\s*\n\s*exportIdentityKeychainItemPresenceByAttributes,/u,
  );
  assert.match(
    helperSource,
    /attributeProbe = exportIdentityKeychainItemPresenceByAttributes,\s*\n\s*attributeDelete = deleteExportIdentityKeychainItemByAttributes,/u,
  );

  // Those operations address the item by service and account and carry no
  // -w/-g, which is what makes them decryption-free — the property the whole
  // arrangement rests on (owner-verified live on a fresh account 2026-08-20:
  // the attribute delete of an app-minted item succeeds with no prompt).
  for (const [args, service] of [
    [
      exportIdentityKeychainAttributeDeleteArguments(
        EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDeviceApp,
      ),
      appService,
    ],
    [
      exportIdentityKeychainAttributeProbeArguments(
        EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDeviceApp,
      ),
      appService,
    ],
  ]) {
    assert.deepEqual(args.slice(1), ["-s", service, "-a", "installation"]);
    assert.equal(args.includes("-w"), false);
    assert.equal(args.includes("-g"), false);
  }
  assert.equal(
    exportIdentityKeychainAttributeDeleteArguments(
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice,
    )[2],
    legacyService,
  );
});

test("reviewed dogfood is configured with shared service and isolated updates", () => {
  const dogfood = getReleaseChannel(INTERNAL_DOGFOOD_RELEASE_CHANNEL);
  assert.equal(dogfood.configured, true);
  assert.equal(dogfood.serviceOriginMode, INTERNAL_DOGFOOD_SERVICE_ORIGIN_MODE);
  assert.equal(dogfood.serviceOrigin, DEPLOYMENT_ENDPOINTS.public.origin);
  assert.equal(dogfood.publicWebsiteOrigin, DEPLOYMENT_ENDPOINTS.public.origin);
  assert.equal(dogfood.sparkle.origin, "https://dogfood-updates.tibotattle.com");
  assert.equal(
    dogfood.sparkle.appcastURL,
    "https://dogfood-updates.tibotattle.com/internal-dogfood/appcast.xml",
  );
  assert.equal(dogfood.sparkle.r2Bucket, "tibotattle-dogfood-updates");
  assert.equal(dogfood.sparkle.objectPrefix, "internal-dogfood/releases");
  assert.match(dogfood.sparkle.publicEdKeySha256, /^[a-f0-9]{64}$/u);
  assert.equal(assertReleaseChannelConfiguration(dogfood), dogfood);
});

test("generic external builders reject env and CLI marker spoofing", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-stable-build-gate-"),
  );
  const output = join(temporaryRoot, "TiboTattle.app");
  try {
    assert.throws(
      () => parseMacOSBuildArguments([
        "--output",
        output,
        "--external-distribution",
        "--release-channel",
        STABLE_RELEASE_CHANNEL,
      ]),
      { code: "MACOS_EXTERNAL_BUILD_RELEASE_CORE_REQUIRED" },
    );
    const directBuild = spawnSync(
      process.execPath,
      [
        BUILD_SCRIPT,
        "--output",
        output,
        "--external-distribution",
        "--release-channel",
        STABLE_RELEASE_CHANNEL,
      ],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          USAGE_MONITOR_MACOS_RELEASE_GATE: "release-macos-app",
        },
      },
    );
    assert.equal(directBuild.status, 1, directBuild.stderr);
    assert.match(
      directBuild.stderr,
      /only available through the validated release-macos-app programmatic path/u,
    );
    await assert.rejects(
      buildMacOSApp({
        output,
        externalDistribution: true,
        releaseChannel: STABLE_RELEASE_CHANNEL,
      }),
      { code: "MACOS_EXTERNAL_BUILD_RELEASE_CORE_REQUIRED" },
    );
    assert.throws(
      () => parseMacOSBuildArguments([
        "--output",
        output,
        "--external-distribution",
        "--release-channel",
        STABLE_RELEASE_CHANNEL,
        "--release-gate",
        "release-macos-app",
      ]),
      { code: "MACOS_APP_BUILD_FAILED" },
    );
    assert.equal(typeof buildMacOSAppForRelease, "function");
    assert.equal(typeof buildMacOSReleaseCandidate, "function");
    assert.equal(typeof prepareMacOSReleaseCandidate, "function");
    await assert.rejects(
      buildMacOSAppForRelease({
        output,
        externalDistribution: true,
        releaseChannel: STABLE_RELEASE_CHANNEL,
      }),
      { code: "MACOS_EXTERNAL_BUILD_PREFLIGHT_REQUIRED" },
    );
    await assert.rejects(
      buildMacOSReleaseCandidate({
        output,
        externalDistribution: true,
        releaseChannel: STABLE_RELEASE_CHANNEL,
      }),
      { code: "MACOS_BUNDLE_VERSION_REQUIRED" },
    );
    await assert.rejects(lstat(output), { code: "ENOENT" });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("external app output is fresh-only and rejects a TOCTOU target", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-external-output-safety-"),
  );
  const stagedApp = join(temporaryRoot, "staged", "TiboTattle.app");
  const output = join(temporaryRoot, "output", "TiboTattle.app");
  const sentinel = join(output, "sentinel.txt");
  try {
    await mkdir(join(stagedApp, "Contents"), { recursive: true });
    await writeFile(join(stagedApp, "Contents", "marker.txt"), "staged");
    await assertMacOSExternalBuildOutputIsFresh(output);

    // Model a target appearing after the initial absence check. The no-
    // replace claim must fail without touching that target.
    await mkdir(output, { recursive: true });
    await writeFile(sentinel, "preserve", { mode: 0o600 });
    await assert.rejects(
      installMacOSExternalBuildOutput(stagedApp, output),
      { code: "MACOS_EXTERNAL_OUTPUT_REPLACEMENT_FORBIDDEN" },
    );
    assert.equal(await readFile(sentinel, "utf8"), "preserve");

    await rm(output, { recursive: true, force: false });
    await installMacOSExternalBuildOutput(stagedApp, output);
    assert.equal(
      await readFile(join(output, "Contents", "marker.txt"), "utf8"),
      "staged",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("release authorization is programmatic and does not apply to development or preview", async () => {
  const source = await readFile(RELEASE_CORE, "utf8");
  assert.match(
    source,
    /assertStableSparkleKeyContinuity\(/u,
  );
  assert.match(source, /buildMacOSAppForRelease/u);
  assert.doesNotMatch(source, /USAGE_MONITOR_MACOS_RELEASE_GATE/u);

  const development = parseMacOSBuildArguments([
    "--output",
    ".release-build/macos/TiboTattle.app",
  ]);
  assert.equal(development.externalDistribution, false);

  const preview = parseMacOSBuildArguments([
    "--preview-distribution",
  ], {
    USAGE_MONITOR_PREVIEW_CENTRAL_ORIGIN: "https://preview.usage.example",
    USAGE_MONITOR_PREVIEW_SPARKLE_APPCAST_URL:
      "https://updates.usage.example/appcast.xml",
    USAGE_MONITOR_PREVIEW_SPARKLE_PUBLIC_ED_KEY:
      Buffer.alloc(32, 4).toString("base64"),
  });
  assert.equal(preview.externalDistribution, false);

  assert.throws(
    () => parseMacOSBuildArguments([
      "--output",
      ".release-build/macos-production/TiboTattle.app",
      "--external-distribution",
      "--release-channel",
      STABLE_RELEASE_CHANNEL,
    ], {
      USAGE_MONITOR_MACOS_RELEASE_GATE: "release-macos-app",
    }),
    { code: "MACOS_EXTERNAL_BUILD_RELEASE_CORE_REQUIRED" },
  );
  assert.throws(
    () => parseMacOSBuildArguments([
      "--output",
      ".release-build/macos-production/TiboTattle.app",
      "--external-distribution",
      "--release-channel",
      STABLE_RELEASE_CHANNEL,
      "--release-gate",
      "release-macos-app",
    ]),
    { code: "MACOS_APP_BUILD_FAILED" },
  );
  assert.throws(() => parseMacOSBuildArguments([
    "--output",
    ".release-build/macos-production/TiboTattle.app",
    "--external-distribution",
    "--release-channel",
    STABLE_RELEASE_CHANNEL,
  ]), { code: "MACOS_EXTERNAL_BUILD_RELEASE_CORE_REQUIRED" });
});

test("generic DMG packaging requires an explicit visible non-release mode", () => {
  assert.throws(
    () => parseMacOSDMGArguments([
      "--app",
      ".release-build/macos/TiboTattle.app",
    ]),
    /one explicit non-release mode/u,
  );
  assert.deepEqual(
    parseMacOSDMGArguments([
      "--app",
      ".release-build/macos/TiboTattle.app",
      "--development",
    ]),
    {
      appPath: resolve(".release-build/macos/TiboTattle.app"),
      output: resolve(
        `.release-build/macos/TiboTattle-${RELEASE_VERSION}`
          + "-macOS-arm64-development.dmg",
      ),
      replace: false,
      distribution: "development",
    },
  );
  assert.deepEqual(
    parseMacOSDMGArguments([
      "--app",
      ".release-build/macos-preview/current/TiboTattle.app",
      "--preview",
    ]).distribution,
    "preview",
  );
  assert.throws(
    () => parseMacOSDMGArguments([
      "--app",
      ".release-build/macos/TiboTattle.app",
      "--development",
      "--preview",
    ]),
    /Unknown or repeated argument: --preview/u,
  );
});

test("direct DMG packaging cannot infer release semantics", async () => {
  await assert.rejects(
    packageMacOSDMG({
      appPath: ".release-build/macos/TiboTattle.app",
      output: ".release-build/macos/TiboTattle.dmg",
    }),
    { code: "MACOS_DMG_DISTRIBUTION_REQUIRED" },
  );
});

test("stable external bundle inputs remain bound to the reviewed production policy", async () => {
  const stable = normalizeMacOSCentralOrigin(DEPLOYMENT_ENDPOINTS.public.origin);
  assert.deepEqual(
    validateMacOSDistributionConfiguration({
      centralService: stable,
      externalDistribution: true,
      releaseChannel: STABLE_RELEASE_CHANNEL,
    }),
    {
      channel: "production",
      externalDistribution: true,
      previewDistribution: false,
      productionOriginValidated: true,
      previewOriginValidated: false,
    },
  );
  assert.deepEqual(
    readMacOSReleaseBuildConfiguration({
      USAGE_MONITOR_BUNDLE_VERSION: "42.7",
      USAGE_MONITOR_PRODUCTION_ORIGIN: DEPLOYMENT_ENDPOINTS.public.origin,
      USAGE_MONITOR_SPARKLE_APPCAST_URL:
        DEPLOYMENT_ENDPOINTS.sparkle.appcastURL,
      USAGE_MONITOR_SPARKLE_FRAMEWORK: "/tmp/Sparkle.framework",
      USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY:
        Buffer.alloc(32, 1).toString("base64"),
    }, STABLE_RELEASE_CHANNEL),
    {
      bundleVersion: "42.7",
      productionOrigin: DEPLOYMENT_ENDPOINTS.public.origin,
      provisioningProfile: null,
      sparkleAppcastURL: DEPLOYMENT_ENDPOINTS.sparkle.appcastURL,
      sparkleFramework: "/tmp/Sparkle.framework",
      sparklePublicEdKey: Buffer.alloc(32, 1).toString("base64"),
    },
  );
});

test("a separately configured synthetic dogfood policy models its mode and endpoints without network access", async () => {
  const dogfood = syntheticDogfoodReleaseChannel();
  assert.equal(assertReleaseChannelConfiguration(dogfood), dogfood);
  await assert.rejects(
    buildMacOSApp({
      output: join(tmpdir(), "usage-monitor-synthetic-dogfood.app"),
      externalDistribution: true,
      releaseChannel: dogfood,
    }),
    { code: "MACOS_RELEASE_CHANNEL_NAME_REQUIRED" },
  );
  assert.deepEqual(
    validateMacOSDistributionConfiguration({
      centralService: {
        configured: true,
        mode: INTERNAL_DOGFOOD_SERVICE_ORIGIN_MODE,
        origin: dogfood.serviceOrigin,
      },
      externalDistribution: true,
      releaseChannel: dogfood,
    }),
    {
      channel: INTERNAL_DOGFOOD_RELEASE_CHANNEL,
      externalDistribution: true,
      previewDistribution: false,
      productionOriginValidated: true,
      previewOriginValidated: false,
    },
  );
  assert.deepEqual(
    {
      channelName: dogfood.name,
      serviceOriginMode: dogfood.serviceOriginMode,
      serviceOrigin: dogfood.serviceOrigin,
      publicWebsiteOrigin: dogfood.publicWebsiteOrigin,
      sparkleAppcastURL: dogfood.sparkle.appcastURL,
      sparklePublicEdKeySha256: dogfood.sparkle.publicEdKeySha256,
    },
    {
      channelName: INTERNAL_DOGFOOD_RELEASE_CHANNEL,
      serviceOriginMode: INTERNAL_DOGFOOD_SERVICE_ORIGIN_MODE,
      serviceOrigin: "https://dogfood.tibotattle.example",
      publicWebsiteOrigin: "https://dogfood.tibotattle.example",
      sparkleAppcastURL:
        "https://updates.dogfood.tibotattle.example/internal-dogfood/appcast.xml",
      sparklePublicEdKeySha256: SYNTHETIC_DOGFOOD_PUBLIC_KEY_SHA256,
    },
  );
});

test("native central service accepts development, stable, and dogfood HTTPS modes", async () => {
  const source = await readFile(SWIFT_SOURCE, "utf8");
  assert.match(source, /case developmentLoopback = "development_loopback"/u);
  assert.match(source, /case productionHTTPS = "production_https"/u);
  assert.match(source, /case internalDogfoodHTTPS = "internal_dogfood_https"/u);
  assert.match(
    source,
    /case \.productionHTTPS, \.internalDogfoodHTTPS:/u,
  );
});

test("development and preview builds treat the release-channel policy as optional", async () => {
  const source = await readFile(BUILD_SCRIPT, "utf8");
  assert.match(
    source,
    /const selectedPublicEdKeySha256 =\s+selectedReleaseChannel\?\.sparkle\.publicEdKeySha256 \?\? null/u,
  );
  assert.match(source, /if \(selectedPublicEdKeySha256 !== null/u);
});

test("macOS release metadata validates versions, production mode, and Keychain references", async () => {
  assert.equal(normalizeMacOSBundleVersion(), "1");
  for (const value of ["1", "1.2", "1.2.3", "0.0.0", "123456789"]) {
    assert.equal(normalizeMacOSBundleVersion(value), value);
  }
  for (const value of ["", "01", "1.", "1.2.3.4", "-1", "1a"]) {
    assert.throws(
      () => normalizeMacOSBundleVersion(value),
      { code: "MACOS_APP_BUILD_FAILED" },
      value,
    );
  }
  const production = normalizeMacOSCentralOrigin(DEPLOYMENT_ENDPOINTS.public.origin);
  assert.deepEqual(
    validateMacOSDistributionConfiguration({
      centralService: production,
      externalDistribution: true,
    }),
    {
      channel: "production",
      externalDistribution: true,
      previewDistribution: false,
      productionOriginValidated: true,
      previewOriginValidated: false,
    },
  );
  assert.deepEqual(
    validateMacOSDistributionConfiguration({
      centralService: production,
      previewDistribution: true,
    }),
    {
      channel: MACOS_PREVIEW_DISTRIBUTION_CHANNEL,
      externalDistribution: false,
      previewDistribution: true,
      productionOriginValidated: false,
      previewOriginValidated: true,
    },
  );
  assert.throws(
    () => validateMacOSDistributionConfiguration({
      centralService: normalizeMacOSCentralOrigin(null),
      externalDistribution: true,
    }),
    { code: "MACOS_PRODUCTION_ORIGIN_REQUIRED" },
  );
  assert.throws(
    () => validateMacOSDistributionConfiguration({
      centralService: normalizeMacOSCentralOrigin(null),
      previewDistribution: true,
    }),
    { code: "MACOS_PREVIEW_ORIGIN_REQUIRED" },
  );
  assert.throws(
    () => validateMacOSDistributionConfiguration({
      centralService: normalizeMacOSCentralOrigin("http://127.0.0.1:8792", {
        allowLoopbackCentralOrigin: true,
      }),
      previewDistribution: true,
    }),
    { code: "MACOS_PREVIEW_ORIGIN_REQUIRED" },
  );
  assert.throws(
    () => validateMacOSDistributionConfiguration({
      centralService: production,
      externalDistribution: true,
      previewDistribution: true,
    }),
    { code: "MACOS_DISTRIBUTION_CHANNEL_CONFLICT" },
  );
  assert.equal(
    validateMacOSPreviewOutputPath(".release-build/macos-preview/current/TiboTattle.app")
      .endsWith("/.release-build/macos-preview/current/TiboTattle.app"),
    true,
  );
  assert.throws(
    () => validateMacOSPreviewOutputPath("/Applications/TiboTattle.app"),
    { code: "MACOS_PREVIEW_OUTPUT_FORBIDDEN" },
  );
  assert.throws(
    () => validateMacOSPreviewOutputPath(
      ".release-build/macos-preview/other/TiboTattle.app",
    ),
    { code: "MACOS_PREVIEW_OUTPUT_FORBIDDEN" },
  );
  for (const origin of [
    "https://10.0.0.1",
    "https://[::ffff:7f00:1]",
  ]) {
    assert.throws(
      () => normalizeMacOSCentralOrigin(origin),
      { code: "MACOS_APP_BUILD_FAILED" },
      origin,
    );
  }
  assert.deepEqual(
    readMacOSReleaseCredentials({
      USAGE_MONITOR_DEVELOPER_ID_APPLICATION:
        "Developer ID Application: Example Owner (A1B2C3D4E5)",
      USAGE_MONITOR_NOTARY_PROFILE: "usage-monitor-notary",
    }),
    {
      identity: "Developer ID Application: Example Owner (A1B2C3D4E5)",
      notaryProfile: "usage-monitor-notary",
    },
  );
  assert.throws(
    () => readMacOSReleaseCredentials({}),
    { code: "MACOS_DEVELOPER_ID_REQUIRED" },
  );
  assert.throws(
    () => readMacOSReleaseCredentials({
      USAGE_MONITOR_DEVELOPER_ID_APPLICATION:
        "Developer ID Application: Example Owner (A1B2C3D4E5)",
      USAGE_MONITOR_NOTARY_PROFILE: "not a safe profile",
    }),
    { code: "MACOS_NOTARY_PROFILE_REQUIRED" },
  );
  assert.deepEqual(
    readMacOSReleaseBuildConfiguration({
      USAGE_MONITOR_BUNDLE_VERSION: "42.7",
      USAGE_MONITOR_PRODUCTION_ORIGIN: DEPLOYMENT_ENDPOINTS.public.origin,
      USAGE_MONITOR_SPARKLE_APPCAST_URL:
        DEPLOYMENT_ENDPOINTS.sparkle.appcastURL,
      USAGE_MONITOR_SPARKLE_FRAMEWORK: "/tmp/Sparkle.framework",
      USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY:
        Buffer.alloc(32, 1).toString("base64"),
    }),
    {
      bundleVersion: "42.7",
      productionOrigin: DEPLOYMENT_ENDPOINTS.public.origin,
      // Absent when no provisioning profile is supplied. Restricted
      // entitlements are the only reason to embed one, and Developer ID
      // distribution does not grant any.
      provisioningProfile: null,
      sparkleAppcastURL: DEPLOYMENT_ENDPOINTS.sparkle.appcastURL,
      sparkleFramework: "/tmp/Sparkle.framework",
      sparklePublicEdKey: Buffer.alloc(32, 1).toString("base64"),
    },
  );
  assert.deepEqual(
    readMacOSReleaseBuildConfiguration({
      USAGE_MONITOR_BUNDLE_VERSION: "42.7",
      USAGE_MONITOR_PROVISIONING_PROFILE:
        "/tmp/embedded.provisionprofile",
      USAGE_MONITOR_SPARKLE_FRAMEWORK: "/tmp/Sparkle.framework",
      USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY:
        Buffer.alloc(32, 1).toString("base64"),
    }),
    {
      bundleVersion: "42.7",
      productionOrigin: DEPLOYMENT_ENDPOINTS.public.origin,
      // A supplied profile reaches the release as an exact path, because it
      // is copied into the bundle before signing so the signature seals it.
      provisioningProfile: "/tmp/embedded.provisionprofile",
      sparkleAppcastURL: DEPLOYMENT_ENDPOINTS.sparkle.appcastURL,
      sparkleFramework: "/tmp/Sparkle.framework",
      sparklePublicEdKey: Buffer.alloc(32, 1).toString("base64"),
    },
  );
  // A relative profile path is resolved against the working directory, so the
  // release embeds the same file whatever directory the build was invoked in.
  assert.equal(
    readMacOSReleaseBuildConfiguration({
      USAGE_MONITOR_BUNDLE_VERSION: "42.7",
      USAGE_MONITOR_PROVISIONING_PROFILE:
        "release/embedded.provisionprofile",
      USAGE_MONITOR_SPARKLE_FRAMEWORK: "/tmp/Sparkle.framework",
      USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY:
        Buffer.alloc(32, 1).toString("base64"),
    }).provisioningProfile,
    join(process.cwd(), "release", "embedded.provisionprofile"),
  );
  // An empty or NUL-bearing profile path is a misconfigured release rather
  // than an absent one, so it fails closed instead of silencing the profile.
  for (const unusable of ["", "release/embedded\0.provisionprofile"]) {
    assert.throws(
      () => readMacOSReleaseBuildConfiguration({
        USAGE_MONITOR_BUNDLE_VERSION: "42.7",
        USAGE_MONITOR_PROVISIONING_PROFILE: unusable,
        USAGE_MONITOR_SPARKLE_FRAMEWORK: "/tmp/Sparkle.framework",
        USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY:
          Buffer.alloc(32, 1).toString("base64"),
      }),
      { code: "MACOS_PROVISIONING_PROFILE_INVALID" },
    );
  }
  assert.throws(
    () => readMacOSReleaseBuildConfiguration({
      USAGE_MONITOR_BUNDLE_VERSION: "42.7",
      USAGE_MONITOR_PRODUCTION_ORIGIN: "http://usage.example",
      USAGE_MONITOR_SPARKLE_FRAMEWORK: "/tmp/Sparkle.framework",
      USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY:
        Buffer.alloc(32, 1).toString("base64"),
    }),
    { code: "MACOS_RELEASE_FAILED" },
  );
  assert.throws(
    () => readMacOSReleaseBuildConfiguration({
      USAGE_MONITOR_BUNDLE_VERSION: "candidate",
      USAGE_MONITOR_SPARKLE_FRAMEWORK: "/tmp/Sparkle.framework",
      USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY:
        Buffer.alloc(32, 1).toString("base64"),
    }),
    { code: "MACOS_BUNDLE_VERSION_REQUIRED" },
  );
  assert.throws(
    () => readMacOSReleaseBuildConfiguration({
      USAGE_MONITOR_BUNDLE_VERSION: "42.7",
      USAGE_MONITOR_PRODUCTION_ORIGIN: "https://usage.example",
      USAGE_MONITOR_SPARKLE_FRAMEWORK: "/tmp/Sparkle.framework",
      USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY:
        Buffer.alloc(32, 1).toString("base64"),
    }),
    { code: "MACOS_RELEASE_ENDPOINTS_MISMATCH" },
  );
  assert.throws(
    () => readMacOSReleaseBuildConfiguration({
      USAGE_MONITOR_BUNDLE_VERSION: "42.7",
      USAGE_MONITOR_SPARKLE_APPCAST_URL:
        "https://updates.example/appcast.xml",
      USAGE_MONITOR_SPARKLE_FRAMEWORK: "/tmp/Sparkle.framework",
      USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY:
        Buffer.alloc(32, 1).toString("base64"),
    }),
    { code: "MACOS_RELEASE_ENDPOINTS_MISMATCH" },
  );
  const releaseSource = await readFile(RELEASE_CORE, "utf8");
  const freshBuild = releaseSource.indexOf(
    "buildMacOSAppForRelease({",
  );
  const developerIDSigning = releaseSource.indexOf(
    "await developerIDSignMacOSApp(stagedApp",
  );
  assert.equal(freshBuild > 0, true);
  assert.equal(developerIDSigning > freshBuild, true);
  assert.match(
    releaseSource,
    /Reviewed candidate is not reproducible from the checked-out source/u,
  );
  assert.match(
    releaseSource,
    /USAGE_MONITOR_PRODUCTION_ORIGIN/u,
  );
  assert.match(releaseSource, /releaseChannel\.name/u);
  assert.match(
    releaseSource,
    /USAGE_MONITOR_BUNDLE_VERSION/u,
  );
  assert.deepEqual(
    await normalizeMacOSUpdaterConfiguration({
      externalDistribution: false,
    }),
    {
      appcastURL: null,
      automaticChecks: false,
      automaticUpdatesEnabledByDefault: false,
      allowsAutomaticUpdateOptIn: false,
      enabled: false,
      framework: null,
      publicEdKey: null,
      version: null,
    },
  );
  await assert.rejects(
    normalizeMacOSUpdaterConfiguration({
      appcastURL: "https://usage.example/appcast.xml",
      externalDistribution: false,
    }),
    { code: "MACOS_UPDATER_FORBIDDEN_IN_DEVELOPMENT" },
  );
});

test("preview CLI inputs are opt-in and development parsing ignores preview environment", async () => {
  const environment = {
    USAGE_MONITOR_PREVIEW_CENTRAL_ORIGIN: "https://preview.usage.example",
    USAGE_MONITOR_PREVIEW_SPARKLE_APPCAST_URL:
      "https://updates.usage.example/appcast.xml",
    USAGE_MONITOR_PREVIEW_SPARKLE_PUBLIC_ED_KEY:
      Buffer.alloc(32, 4).toString("base64"),
  };
  const development = parseMacOSBuildArguments([
    "--output",
    ".release-build/macos/TiboTattle.app",
  ], environment);
  assert.equal(development.previewDistribution, false);
  assert.equal(development.centralOrigin, null);
  assert.equal(development.sparkleFramework, null);
  assert.equal(development.sparkleAppcastURL, null);
  assert.equal(development.sparklePublicEdKey, null);
  assert.equal(development.buildProfile, MACOS_BUILD_PROFILES.release);

  const testBuild = parseMacOSBuildArguments([
    "--output",
    ".release-build/macos-test/TiboTattle.app",
    "--test-build",
  ], environment);
  assert.equal(testBuild.buildProfile, MACOS_BUILD_PROFILES.test);
  assert.equal(normalizeMacOSBuildProfile("release"), "release");
  assert.equal(normalizeMacOSBuildProfile("test"), "test");
  assert.throws(
    () => normalizeMacOSBuildProfile("profiling"),
    { code: "MACOS_BUILD_PROFILE_INVALID" },
  );

  const preview = parseMacOSBuildArguments([
    "--preview-distribution",
  ], environment);
  assert.equal(preview.previewDistribution, true);
  assert.equal(preview.centralOrigin, environment.USAGE_MONITOR_PREVIEW_CENTRAL_ORIGIN);
  assert.equal(
    preview.sparkleAppcastURL,
    environment.USAGE_MONITOR_PREVIEW_SPARKLE_APPCAST_URL,
  );
  assert.equal(
    preview.sparklePublicEdKey,
    environment.USAGE_MONITOR_PREVIEW_SPARKLE_PUBLIC_ED_KEY,
  );
  assert.equal(preview.sparkleFramework.endsWith(
    "/.release-deps/Sparkle.framework",
  ), true);
  assert.equal(preview.output.endsWith(
    "/.release-build/macos-preview/current/TiboTattle.app",
  ), true);
  assert.throws(
    () => parseMacOSBuildArguments([
      "--preview-distribution",
      "--release-channel",
      INTERNAL_DOGFOOD_RELEASE_CHANNEL,
    ], environment),
    { code: "MACOS_RELEASE_CHANNEL_EXTERNAL_REQUIRED" },
  );
  const defaultPreview = parseMacOSBuildArguments([
    "--preview-distribution",
  ], {});
  assert.equal(
    defaultPreview.centralOrigin,
    DEPLOYMENT_ENDPOINTS.public.origin,
  );
  assert.equal(
    defaultPreview.sparkleAppcastURL,
    DEPLOYMENT_ENDPOINTS.sparkle.appcastURL,
  );
  assert.equal(
    defaultPreview.sparklePublicEdKey,
    "jhgPwmvWLMr7TGURJUoi6sXias7YP1F+hejZawKVTGw=",
  );
  assert.deepEqual(
    parseMacOSBuildArguments([
      "--validate-preview",
      "--app",
      ".release-build/macos-preview/current/TiboTattle.app",
    ], environment),
    {
      appPath: resolve(
        ".release-build/macos-preview/current/TiboTattle.app",
      ),
      validatePreview: true,
    },
  );
  assert.throws(
    () => parseMacOSBuildArguments([
      "--preview-distribution",
    ], {
      ...environment,
      USAGE_MONITOR_PREVIEW_OUTPUT: ".release-build/other/TiboTattle.app",
    }),
    { code: "MACOS_PREVIEW_OUTPUT_FORBIDDEN" },
  );
  assert.throws(
    () => parseMacOSBuildArguments([
      "--preview-distribution",
      "--output",
      ".release-build/other/TiboTattle.app",
    ], environment),
    { code: "MACOS_PREVIEW_OUTPUT_FORBIDDEN" },
  );
  assert.throws(
    () => parseMacOSBuildArguments([
      "--replace-preview-output",
      "--output",
      ".release-build/macos/TiboTattle.app",
    ], environment),
    { code: "MACOS_APP_BUILD_FAILED" },
  );
  assert.throws(
    () => parseMacOSBuildArguments([
      "--output",
      ".release-build/macos-production/TiboTattle.app",
      "--external-distribution",
      "--test-build",
    ], environment),
    { code: "MACOS_TEST_BUILD_DISTRIBUTION_FORBIDDEN" },
  );
  assert.throws(
    () => parseMacOSBuildArguments([
      "--preview-distribution",
      "--test-build",
    ], environment),
    { code: "MACOS_TEST_BUILD_DISTRIBUTION_FORBIDDEN" },
  );
  assert.throws(
    () => parseMacOSBuildArguments([
      "--validate-preview",
      "--app",
      ".release-build/macos-preview/current/TiboTattle.app",
      "--test-build",
    ], environment),
    { code: "MACOS_PREVIEW_VALIDATION_ARGUMENTS_INVALID" },
  );
  await assert.rejects(
    buildMacOSApp({
      output: join(tmpdir(), "usage-monitor-test-profile-preview.app"),
      centralOrigin: DEPLOYMENT_ENDPOINTS.public.origin,
      previewDistribution: true,
      buildProfile: MACOS_BUILD_PROFILES.test,
    }),
    { code: "MACOS_TEST_BUILD_DISTRIBUTION_FORBIDDEN" },
  );
});

test("Login Item release rehearsal requires the installed signed-app lifecycle evidence", () => {
  const checks = {
    firstRunConsentIsVisibleAndAffirmative: true,
    settingsReconcileAfterSystemSettingsChange: true,
    enableDisableAndPendingRemoval: true,
    automaticLoginLaunch: true,
    upgradeRetainsSingleMainAppLoginItem: true,
    moveAndReinstallLeavesNoStaleDuplicate: true,
    uninstallAndReinstallLeavesNoStaleDuplicate: true,
    duplicateLaunchExplainsExistingApp: true,
    windowCloseKeepsMenuBarAndQuitStopsApp: true,
    noAgentDaemonOrBackgroundUpload: true,
  };
  const rehearsal = {
    schemaVersion: "usage-monitor-macos-login-item-release-rehearsal-v1",
    recordedOn: "2026-08-04",
    environment: {
      cleanDisposableProfile: true,
      installedInApplications: true,
    },
    application: {
      bundleIdentifier: "com.usagemonitor.local",
      bundleVersion: "17",
      shortVersion: "0.1.0",
    },
    checks,
  };
  const validated = validateMacOSLoginItemReleaseRehearsal(rehearsal, {
    bundleVersion: "17",
    shortVersion: "0.1.0",
  });
  assert.equal(validated.bundleIdentifier, "com.usagemonitor.local");
  assert.equal(validated.bundleVersion, "17");
  assert.equal(validated.requiredChecks.length, 10);
  assert.throws(
    () => validateMacOSLoginItemReleaseRehearsal({
      ...rehearsal,
      checks: {
        ...checks,
        automaticLoginLaunch: false,
      },
    }, {
      bundleVersion: "17",
      shortVersion: "0.1.0",
    }),
    { code: "MACOS_LOGIN_ITEM_REHEARSAL_INVALID" },
  );
  assert.throws(
    () => validateMacOSLoginItemReleaseRehearsal(rehearsal, {
      bundleVersion: "18",
      shortVersion: "0.1.0",
    }),
    { code: "MACOS_LOGIN_ITEM_REHEARSAL_INVALID" },
  );
  assert.throws(
    () => validateMacOSLoginItemReleaseRehearsal({
      ...rehearsal,
      recordedOn: "2026-02-30",
    }, {
      bundleVersion: "17",
      shortVersion: "0.1.0",
    }),
    { code: "MACOS_LOGIN_ITEM_REHEARSAL_INVALID" },
  );
});

test("Login Item release tooling validates only the fake seam and an Applications receipt", async () => {
  const [releaseSource, gateSource] = await Promise.all([
    readFile(RELEASE_CORE, "utf8"),
    readFile(
      join(
        REPOSITORY_ROOT,
        "scripts",
        "validate-macos-login-item-release.js",
      ),
      "utf8",
    ),
  ]);
  assert.match(
    releaseSource,
    /validateMacOSLoginItemContract\(inspected\.executablePath\)/u,
  );
  assert.match(
    releaseSource,
    /--login-item-contract-smoke-test/u,
  );
  assert.match(releaseSource, /real Login Items; the executable/u);
  assert.match(releaseSource, /fake ServiceManagement seam/u);
  assert.match(
    gateSource,
    /const REQUIRED_APPLICATION_PATH\s*=\s*`\/Applications\/\$\{PRODUCT_BRAND\.bundleName\}`/u,
  );
  assert.match(gateSource, /validateInstalledMacOSApp\(appPath, \{ production: true \}\)/u);
  assert.match(gateSource, /validateMacOSLoginItemReleaseRehearsal/u);
  assert.equal(gateSource.includes("register()"), false);
  assert.equal(gateSource.includes("unregister()"), false);
  const refusedDevelopmentPath = spawnSync(process.execPath, [
    join(
      REPOSITORY_ROOT,
      "scripts",
      "validate-macos-login-item-release.js",
    ),
    "--app",
    ".release-build/macos/TiboTattle.app",
    "--rehearsal",
    "/tmp/unused-login-item-rehearsal.json",
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(refusedDevelopmentPath.status, 1);
  assert.match(
    refusedDevelopmentPath.stderr,
    /must use \/Applications\/TiboTattle\.app/u,
  );
});

test("signed updater replacement contract validates upgrade and rollback artifacts", async () => {
  assert.equal(compareMacOSBundleVersions("1", "1.0.0"), 0);
  assert.equal(compareMacOSBundleVersions("1.2", "1.1.99"), 1);
  assert.equal(compareMacOSBundleVersions("2", "2.0.1"), -1);
  assert.throws(
    () => compareMacOSBundleVersions("candidate", "1"),
    { code: "MACOS_REPLACEMENT_VERSION_INVALID" },
  );

  const replacement = createMacOSSignedReplacementContract();
  assert.deepEqual(replacement, {
    schemaVersion: "usage-monitor-macos-signed-replacement-v1",
    delivery: "sparkle_signed_appcast_with_manual_dmg_fallback",
    updateChecksPerformedByApp: true,
    manualUpdateCheckAvailable: true,
    automaticUpdateOptInAvailable: true,
    automaticUpdatesEnabledByDefault: true,
    afterUserOptIn: {
      automaticDownload: true,
      installOnQuit: true,
    },
    installProcedure:
      "sparkle_automatic_install_on_quit_or_manual_dmg_replacement",
    downloadPolicy: "pinned_https_appcast_and_eddsa_signed_artifact",
    state: {
      root: "~/Library/Application Support/Usage Monitor",
      retainedAcrossReplacement: true,
      destructiveMigrationAllowed: false,
      preReplacementBackupRequiredForSchemaChanges: true,
    },
    keychainRetainedAcrossReplacement: true,
    hostedDataChangedByReplacement: false,
    rollback: {
      mode: "manual_previous_signed_notarized_dmg",
      previousReleaseManifestRequired: true,
      previousArtifactChecksumRequired: true,
      existingStateRehearsalRequired: true,
      restorePreReplacementStateIfIncompatible: true,
    },
  });

  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-replacement-test-"),
  );
  const previousBytes = Buffer.from("previous signed notarized DMG");
  const candidateBytes = Buffer.from("candidate signed notarized DMG");
  const assurances = {
    appNotarizationAccepted: true,
    appTicketStapled: true,
    candidateReproducedFromCheckedOutSource: true,
    cleanProfileSmokePassed: true,
    developerIDHardenedRuntime: true,
    dmgGatekeeperAssessmentPassed: true,
    dmgNotarizationAccepted: true,
    dmgTicketStapled: true,
  };
  const sparklePublicKeySha256 = createHash("sha256")
    .update(Buffer.alloc(32, 1))
    .digest("hex");
  const changedSparklePublicKeySha256 = createHash("sha256")
    .update(Buffer.alloc(32, 2))
    .digest("hex");
  const releaseManifest = (bundleVersion, fileName, bytes) => ({
    schemaVersion: "usage-monitor-macos-release-v0.2",
    application: {
      bundleIdentifier: "com.usagemonitor.local",
      bundleVersion,
      shortVersion: RELEASE_VERSION,
    },
    artifact: {
      bytes: bytes.length,
      fileName,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    channel: createReleaseChannelProvenance(STABLE_RELEASE_CHANNEL, {
      publicEdKeySha256: sparklePublicKeySha256,
    }),
    assurances: { ...assurances },
    updater: {
      appcastURL: "https://usage.example/appcast.xml",
      automaticChecks: true,
      automaticUpdateOptInAvailable: true,
      automaticUpdatesEnabledByDefault: true,
      afterUserOptIn: {
        automaticDownload: true,
        installOnQuit: true,
      },
      enabled: true,
      frameworkVersion: SPARKLE_VERSION,
      publicEdKeySha256: sparklePublicKeySha256,
      requiresSignedFeed: true,
    },
    replacement,
  });
  const previousManifest = releaseManifest(
    "10",
    "UsageMonitor-previous.dmg",
    previousBytes,
  );
  const candidateManifest = releaseManifest(
    "11",
    "UsageMonitor-candidate.dmg",
    candidateBytes,
  );
  const previousManifestPath = join(
    temporaryRoot,
    "UsageMonitor-previous.dmg.release.json",
  );
  const candidateManifestPath = join(
    temporaryRoot,
    "UsageMonitor-candidate.dmg.release.json",
  );
  const malformedPreviousManifestPath = join(
    temporaryRoot,
    "malformed-previous-stable.json",
  );
  try {
    assert.throws(
      () => assertStableSparkleKeyContinuity({
        candidateBundleVersion: candidateManifest.application.bundleVersion,
        candidatePublicEdKeySha256: sparklePublicKeySha256,
        channel: STABLE_RELEASE_CHANNEL,
      }),
      { code: "MACOS_STABLE_PREVIOUS_MANIFEST_REQUIRED" },
    );
    await assert.rejects(
      readStableReleaseManifest(join(temporaryRoot, "missing-stable.json")),
      { code: "MACOS_STABLE_PREVIOUS_MANIFEST_INVALID" },
    );
    await writeFile(malformedPreviousManifestPath, "not-json");
    await assert.rejects(
      readStableReleaseManifest(malformedPreviousManifestPath),
      { code: "MACOS_STABLE_PREVIOUS_MANIFEST_INVALID" },
    );
    assert.throws(
      () => assertStableSparkleKeyContinuity({
        candidateBundleVersion: candidateManifest.application.bundleVersion,
        candidatePublicEdKeySha256: changedSparklePublicKeySha256,
        channel: STABLE_RELEASE_CHANNEL,
        previousManifest,
      }),
      { code: "MACOS_STABLE_UPDATER_KEY_MISMATCH" },
    );
    assert.throws(
      () => assertStableSparkleKeyContinuity({
        candidateBundleVersion: previousManifest.application.bundleVersion,
        candidatePublicEdKeySha256: sparklePublicKeySha256,
        channel: STABLE_RELEASE_CHANNEL,
        previousManifest,
      }),
      { code: "MACOS_STABLE_VERSION_NOT_NEWER" },
    );
    assert.deepEqual(
      assertStableSparkleKeyContinuity({
        candidateBundleVersion: candidateManifest.application.bundleVersion,
        candidatePublicEdKeySha256: sparklePublicKeySha256,
        channel: STABLE_RELEASE_CHANNEL,
        previousManifest,
      }),
      {
        mode: "previous_manifest",
        policy: "previous_stable_manifest_required",
        previousBundleVersion: "10",
      },
    );
    assert.doesNotThrow(() => validateMacOSSignedReplacementPair({
      previousManifest: {
        ...previousManifest,
        source: {
          repository: "https://github.com/adamallcock/tibotattle",
          // The fixture manifests stamp shortVersion from the live
          // RELEASE_VERSION, so the matching tag must derive from it too or
          // every version bump breaks this pair for a hardcoded reason.
          tag: `v${RELEASE_VERSION}`,
          commit: "a".repeat(40),
        },
      },
      candidateManifest,
    }));
    assert.throws(
      () => validateMacOSSignedReplacementPair({
        previousManifest: {
          ...previousManifest,
          source: {
            repository: "https://github.com/adamallcock/tibotattle",
            tag: "v9.9.9",
            commit: "a".repeat(40),
          },
        },
        candidateManifest,
      }),
      { code: "MACOS_RELEASE_SOURCE_VERSION_MISMATCH" },
    );
    assert.throws(
      () => validateMacOSSignedReplacementPair({
        previousManifest: {
          ...previousManifest,
          source: {
            repository: "https://github.com/private/tibotattle",
            tag: `v${RELEASE_VERSION}`,
            commit: "b".repeat(40),
          },
        },
        candidateManifest,
      }),
      { code: "MACOS_RELEASE_SOURCE_INVALID" },
    );
    assert.deepEqual(
      assertStableSparkleKeyContinuity({
        candidateBundleVersion: "1",
        candidatePublicEdKeySha256: sparklePublicKeySha256,
        channel: STABLE_RELEASE_CHANNEL,
        stableBootstrap: true,
      }),
      {
        bootstrap: "explicit_owner_only",
        mode: "bootstrap",
        policy: "previous_stable_manifest_required",
      },
    );
    await writeFile(
      join(temporaryRoot, previousManifest.artifact.fileName),
      previousBytes,
    );
    await writeFile(
      join(temporaryRoot, candidateManifest.artifact.fileName),
      candidateBytes,
    );
    await writeFile(
      previousManifestPath,
      JSON.stringify(previousManifest),
    );
    await writeFile(
      candidateManifestPath,
      JSON.stringify(candidateManifest),
    );
    assert.deepEqual(
      validateMacOSSignedReplacementPair({
        previousManifest,
        candidateManifest,
      }),
      {
        bundleIdentifier: "com.usagemonitor.local",
        candidateBundleVersion: "11",
        previousBundleVersion: "10",
        updateMode: "sparkle_signed_appcast_with_manual_dmg_fallback",
        rollbackMode: "manual_previous_signed_notarized_dmg",
        automaticUpdaterPresent: true,
        hostedDataChanged: false,
      },
    );
    assert.equal(previousManifest.channel.name, STABLE_RELEASE_CHANNEL);
    assert.equal(candidateManifest.channel.name, STABLE_RELEASE_CHANNEL);
    assert.equal(
      previousManifest.channel.sparkle.publicEdKeySha256,
      previousManifest.updater.publicEdKeySha256,
    );
    assert.equal(
      candidateManifest.channel.sparkle.publicEdKeySha256,
      candidateManifest.updater.publicEdKeySha256,
    );
    const validatedArtifacts = [];
    const artifacts = await validateMacOSSignedReplacementArtifacts({
      previousReleaseManifestPath: previousManifestPath,
      candidateReleaseManifestPath: candidateManifestPath,
      async validateArtifact(path, options) {
        validatedArtifacts.push([path, options]);
      },
    });
    assert.equal(
      artifacts.previousArtifact,
      join(temporaryRoot, previousManifest.artifact.fileName),
    );
    assert.equal(
      artifacts.candidateArtifact,
      join(temporaryRoot, candidateManifest.artifact.fileName),
    );
    assert.deepEqual(validatedArtifacts, [
      [
        join(temporaryRoot, previousManifest.artifact.fileName),
        { production: true },
      ],
      [
        join(temporaryRoot, candidateManifest.artifact.fileName),
        { production: true },
      ],
    ]);
    const command = spawnSync(process.execPath, [
      join(REPOSITORY_ROOT, "scripts", "validate-macos-replacement.js"),
      "--help",
    ], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(command.status, 0, command.stderr || command.stdout);
    assert.match(
      command.stdout,
      /--previous RELEASE\.json --candidate RELEASE\.json/u,
    );

    assert.throws(
      () => validateMacOSSignedReplacementPair({
        previousManifest,
        candidateManifest: {
          ...candidateManifest,
          application: {
            ...candidateManifest.application,
            bundleVersion: "10",
          },
        },
      }),
      { code: "MACOS_REPLACEMENT_VERSION_NOT_NEWER" },
    );
    assert.throws(
      () => validateMacOSSignedReplacementPair({
        previousManifest,
        candidateManifest: {
          ...candidateManifest,
          assurances: {
            ...candidateManifest.assurances,
            dmgNotarizationAccepted: false,
          },
        },
      }),
      { code: "MACOS_REPLACEMENT_MANIFEST_INVALID" },
    );
    assert.throws(
      () => validateMacOSSignedReplacementPair({
        previousManifest,
        candidateManifest: {
          ...candidateManifest,
          channel: {
            ...candidateManifest.channel,
            sparkle: {
              ...candidateManifest.channel.sparkle,
              publicEdKeySha256: changedSparklePublicKeySha256,
            },
          },
          updater: {
            ...candidateManifest.updater,
            publicEdKeySha256: changedSparklePublicKeySha256,
          },
        },
      }),
      { code: "MACOS_REPLACEMENT_UPDATER_KEY_MISMATCH" },
      "a same-channel replacement with a changed Sparkle key must fail",
    );
    for (const [label, previous, candidate] of [
      [
        "previous",
        {
          ...previousManifest,
          channel: {
            ...previousManifest.channel,
            sparkle: {
              ...previousManifest.channel.sparkle,
              publicEdKeySha256: "c".repeat(64),
            },
          },
        },
        candidateManifest,
      ],
      [
        "candidate",
        previousManifest,
        {
          ...candidateManifest,
          channel: {
            ...candidateManifest.channel,
            sparkle: {
              ...candidateManifest.channel.sparkle,
              publicEdKeySha256: "c".repeat(64),
            },
          },
        },
      ],
    ]) {
      assert.throws(
        () => validateMacOSSignedReplacementPair({
          previousManifest: previous,
          candidateManifest: candidate,
        }),
        { code: "MACOS_RELEASE_UPDATER_KEY_MISMATCH" },
        `${label} mismatched channel fingerprint must fail closed`,
      );
    }
    for (const [label, publicEdKeySha256] of [
      ["absent", undefined],
      ["malformed", "not-a-sha256"],
    ]) {
      assert.throws(
        () => validateMacOSSignedReplacementPair({
          previousManifest,
          candidateManifest: {
            ...candidateManifest,
            channel: {
              ...candidateManifest.channel,
              sparkle: {
                ...candidateManifest.channel.sparkle,
                publicEdKeySha256,
              },
            },
          },
        }),
        { code: "MACOS_RELEASE_CHANNEL_MISMATCH" },
        `${label} channel fingerprint must fail closed`,
      );
    }
    for (const [label, publicEdKeySha256] of [
      ["absent", undefined],
      ["malformed", "not-a-sha256"],
    ]) {
      assert.throws(
        () => validateMacOSSignedReplacementPair({
          previousManifest,
          candidateManifest: {
            ...candidateManifest,
            updater: {
              ...candidateManifest.updater,
              publicEdKeySha256,
            },
          },
        }),
        { code: "MACOS_REPLACEMENT_MANIFEST_INVALID" },
        `${label} updater fingerprint must fail closed`,
      );
    }
    for (const [label, previous, candidate] of [
      [
        "previous",
        { ...previousManifest, channel: undefined },
        candidateManifest,
      ],
      [
        "candidate",
        previousManifest,
        { ...candidateManifest, channel: undefined },
      ],
    ]) {
      assert.throws(
        () => validateMacOSSignedReplacementPair({
          previousManifest: previous,
          candidateManifest: candidate,
        }),
        { code: "MACOS_RELEASE_CHANNEL_PROVENANCE_REQUIRED" },
        `${label} release channel provenance must be required`,
      );
    }
    assert.throws(
      () => validateMacOSSignedReplacementPair({
        previousManifest,
        candidateManifest: {
          ...candidateManifest,
          channel: {
            ...candidateManifest.channel,
            name: INTERNAL_DOGFOOD_RELEASE_CHANNEL,
          },
        },
      }),
      { code: "MACOS_RELEASE_CHANNEL_MISMATCH" },
    );
    assert.throws(
      () => validateMacOSSignedReplacementPair({
        previousManifest,
        candidateManifest: {
          ...candidateManifest,
          replacement: {
            ...replacement,
            automaticUpdatesEnabledByDefault: false,
          },
        },
      }),
      { code: "MACOS_REPLACEMENT_MANIFEST_INVALID" },
    );

    await writeFile(
      join(temporaryRoot, candidateManifest.artifact.fileName),
      Buffer.from("tampered"),
    );
    await assert.rejects(
      validateMacOSSignedReplacementArtifacts({
        previousReleaseManifestPath: previousManifestPath,
        candidateReleaseManifestPath: candidateManifestPath,
        async validateArtifact() {},
      }),
      { code: "MACOS_REPLACEMENT_ARTIFACT_INVALID" },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("signed macOS releases require a clean, annotated source tag and minimal Node entitlements", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-release-provenance-test-"),
  );
  try {
    execFileSync("/usr/bin/git", ["init", "--quiet"], { cwd: temporaryRoot });
    execFileSync("/usr/bin/git", ["config", "user.email", "test@example.invalid"], {
      cwd: temporaryRoot,
    });
    execFileSync("/usr/bin/git", ["config", "user.name", "Release provenance test"], {
      cwd: temporaryRoot,
    });
    await writeFile(join(temporaryRoot, "release-input.txt"), "release\n");
    execFileSync("/usr/bin/git", ["add", "release-input.txt"], { cwd: temporaryRoot });
    execFileSync("/usr/bin/git", ["commit", "--quiet", "-m", "release input"], {
      cwd: temporaryRoot,
    });
    execFileSync("/usr/bin/git", ["tag", "-a", RELEASE_MANIFEST.tag, "-m", "release"], {
      cwd: temporaryRoot,
    });
    execFileSync("/usr/bin/git", [
      "remote",
      "add",
      "origin",
      "https://github.com/adamallcock/tibotattle.git",
    ], { cwd: temporaryRoot });
    const provenance = readMacOSReleaseSourceProvenance({
      repositoryRoot: temporaryRoot,
    });
    assert.deepEqual(provenance, {
      repository: "https://github.com/adamallcock/tibotattle",
      commit: provenance.commit,
      tag: RELEASE_MANIFEST.tag,
    });
    assert.match(provenance.commit, /^[0-9a-f]{40}$/u);
    assert.equal(provenance.tag, RELEASE_MANIFEST.tag);
    assert.equal(
      readMacOSReleaseSourceProvenance({
        repositoryRoot: temporaryRoot,
        expectedVersion: RELEASE_MANIFEST.tag.slice(1),
      }).tag,
      RELEASE_MANIFEST.tag,
    );
    assert.throws(
      () => readMacOSReleaseSourceProvenance({
        repositoryRoot: temporaryRoot,
        expectedVersion: "9.9.9",
      }),
      { code: "MACOS_RELEASE_SOURCE_VERSION_MISMATCH" },
    );

    execFileSync("/usr/bin/git", [
      "remote",
      "set-url",
      "origin",
      "git@github.com:adamallcock/tibotattle.git",
    ], { cwd: temporaryRoot });
    assert.equal(
      readMacOSReleaseSourceProvenance({ repositoryRoot: temporaryRoot }).repository,
      "https://github.com/adamallcock/tibotattle",
    );
    execFileSync("/usr/bin/git", [
      "remote",
      "set-url",
      "origin",
      "ssh://git@github.com/adamallcock/tibotattle.git",
    ], { cwd: temporaryRoot });
    assert.equal(
      readMacOSReleaseSourceProvenance({ repositoryRoot: temporaryRoot }).repository,
      "https://github.com/adamallcock/tibotattle",
    );
    for (const origin of [
      "https://github.com/other-owner/tibotattle.git",
      "https://user:password@github.com/adamallcock/tibotattle.git",
      "https://github.com/adamallcock/tibotattle?ref=main",
    ]) {
      execFileSync("/usr/bin/git", ["remote", "set-url", "origin", origin], {
        cwd: temporaryRoot,
      });
      assert.throws(
        () => readMacOSReleaseSourceProvenance({ repositoryRoot: temporaryRoot }),
        { code: "MACOS_RELEASE_SOURCE_ORIGIN_INVALID" },
      );
    }
    execFileSync("/usr/bin/git", ["remote", "remove", "origin"], {
      cwd: temporaryRoot,
    });
    assert.throws(
      () => readMacOSReleaseSourceProvenance({ repositoryRoot: temporaryRoot }),
      { code: "MACOS_RELEASE_SOURCE_ORIGIN_REQUIRED" },
    );
    execFileSync("/usr/bin/git", [
      "remote",
      "add",
      "origin",
      "https://github.com/adamallcock/tibotattle.git",
    ], { cwd: temporaryRoot });

    await writeFile(join(temporaryRoot, "release-input.txt"), "dirty\n");
    assert.throws(
      () => readMacOSReleaseSourceProvenance({ repositoryRoot: temporaryRoot }),
      { code: "MACOS_RELEASE_SOURCE_DIRTY" },
    );

    const entitlements = await validateNodeRuntimeEntitlements();
    assert.match(entitlements.path, /NodeRuntime\.entitlements$/u);
    const entitlementSource = await readFile(entitlements.path, "utf8");
    assert.match(entitlementSource, /com\.apple\.security\.cs\.allow-jit/u);
    assert.match(
      entitlementSource,
      /com\.apple\.security\.cs\.allow-unsigned-executable-memory/u,
    );
    assert.doesNotMatch(
      entitlementSource,
      /com\.apple\.security\.cs\.disable-library-validation/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Mac App Store entitlement contracts stay minimal and distribution-specific", () => {
  const readEntitlements = (path) => JSON.parse(execFileSync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", path],
    { encoding: "utf8" },
  ));
  const application = readEntitlements(MAC_APP_STORE_ENTITLEMENTS);
  const nodeRuntime = readEntitlements(MAC_APP_STORE_NODE_ENTITLEMENTS);

  assert.deepEqual(application, {
    "com.apple.security.app-sandbox": true,
    "com.apple.security.files.bookmarks.app-scope": true,
    "com.apple.security.files.user-selected.read-only": true,
    "com.apple.security.network.client": true,
    "com.apple.security.network.server": true,
  });
  assert.deepEqual(nodeRuntime, {
    "com.apple.security.app-sandbox": true,
    "com.apple.security.inherit": true,
  });
  assert.equal(
    Object.keys(nodeRuntime).some((key) => key.startsWith("com.apple.security.cs.")),
    false,
    "the Store helper contract must not inherit Developer ID JIT exceptions",
  );
});

test("Developer ID and notary hooks are inside-out, hardened, and credential-minimized", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-signing-hook-test-"),
  );
  const app = join(temporaryRoot, "TiboTattle.app");
  const resources = join(app, "Contents", "Resources");
  const identity =
    "Developer ID Application: Example Owner (A1B2C3D4E5)";
  try {
    const syntheticMachOSource = join(temporaryRoot, "synthetic.c");
    const syntheticMachO = join(temporaryRoot, "synthetic-arm64");
    await writeFile(
      syntheticMachOSource,
      "int main(void) { return 0; }\n",
    );
    execFileSync("/usr/bin/xcrun", [
      "--sdk",
      "macosx",
      "clang",
      "-target",
      "arm64-apple-macos14.0",
      syntheticMachOSource,
      "-o",
      syntheticMachO,
    ], { stdio: "ignore" });
    execFileSync("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--timestamp=none",
      syntheticMachO,
    ], { stdio: "ignore" });
    for (const relativePath of [
      "Contents/MacOS/TiboTattle",
      "Contents/Resources/runtime/bin/node",
      "Contents/Resources/app/node_modules/@github/keytar/prebuilds/darwin-arm64/keytar.node",
      "Contents/Resources/AppIcon.icns",
      "Contents/Resources/licenses/app-icon-provenance.txt",
      `Contents/Resources/licenses/sparkle-${SPARKLE_VERSION}.txt`,
      ...SPARKLE_MACH_O_PATHS.map(
        (path) => `Contents/Frameworks/Sparkle.framework/${path}`,
      ),
    ]) {
      const path = join(app, ...relativePath.split("/"));
      await mkdir(dirname(path), { recursive: true });
      if (NORMALIZED_TEST_CODE_PATHS.has(relativePath)) {
        await copyFile(syntheticMachO, path);
        await chmod(path, 0o555);
      } else {
        await writeFile(path, relativePath);
      }
    }
    const frameworkRoot = join(
      app,
      "Contents",
      "Frameworks",
      "Sparkle.framework",
    );
    for (const [path, target] of Object.entries(
      SPARKLE_FRAMEWORK_LINKS,
    )) {
      const link = join(frameworkRoot, ...path.split("/"));
      await mkdir(dirname(link), { recursive: true });
      await symlink(target, link);
    }
    const codeResources = join(
      app,
      "Contents",
      "_CodeSignature",
      "CodeResources",
    );
    await mkdir(dirname(codeResources), { recursive: true });
    await writeFile(codeResources, "synthetic signature envelope");
    await writeFile(
      join(app, "Contents", "Info.plist"),
      JSON.stringify({
        CFBundleDisplayName: PRODUCT_BRAND.displayName,
        CFBundleExecutable: "TiboTattle",
        CFBundleIdentifier: "com.usagemonitor.local",
        CFBundleName: PRODUCT_BRAND.displayName,
        CFBundleShortVersionString: "0.0.1",
        CFBundleVersion: "1",
        CFBundleIconFile: "AppIcon",
        CFBundleURLTypes: [{
          CFBundleTypeRole: "Viewer",
          CFBundleURLName: "com.usagemonitor.local.open",
          CFBundleURLSchemes: ["usagemonitor"],
        }],
        UsageMonitorCentralOrigin: DEPLOYMENT_ENDPOINTS.public.origin,
        UsageMonitorCentralOriginMode: "production_https",
        UsageMonitorPublicWebsiteOrigin: DEPLOYMENT_ENDPOINTS.public.origin,
        UsageMonitorReleaseChannel: STABLE_RELEASE_CHANNEL,
        UsageMonitorAppOpenHost: PRODUCT_BRAND.appOpenHost,
        UsageMonitorAppOpenScheme: PRODUCT_BRAND.appOpenScheme,
        UsageMonitorAppOpenURL: PRODUCT_BRAND.appOpenURL,
        UsageMonitorBundleName: PRODUCT_BRAND.bundleName,
        UsageMonitorMonitoredAppBundleIdentifier:
          PRODUCT_BRAND.monitoredAppBundleIdentifier,
        UsageMonitorMonitoredAppDisplayName:
          PRODUCT_BRAND.monitoredAppDisplayName,
        UsageMonitorStateDirectoryName: PRODUCT_BRAND.stateDirectoryName,
        UsageMonitorUpdaterEnabled: true,
        UsageMonitorUpdaterFrameworkVersion: SPARKLE_VERSION,
        SUAllowsAutomaticUpdates: true,
        SUAutomaticallyUpdate: true,
        SUEnableAutomaticChecks: true,
        SUFeedURL: DEPLOYMENT_ENDPOINTS.sparkle.appcastURL,
        SUPublicEDKey: Buffer.alloc(32, 1).toString("base64"),
        SURequireSignedFeed: true,
        SUVerifyUpdateBeforeExtraction: true,
      }),
    );
    const writeBuildManifest = async () => await writeFile(
      join(resources, "build-manifest.json"),
      JSON.stringify({
        schemaVersion: "usage-monitor-macos-app-build-v0.1",
        application: {
          bundleIdentifier: "com.usagemonitor.local",
        },
        release: {
          appOpenHost: "open",
          appOpenScheme: "usagemonitor",
          appOpenURL: "usagemonitor://open",
          channel: "production",
          channelName: STABLE_RELEASE_CHANNEL,
          externalDistributionRequested: true,
          iconIncluded: true,
          iconSha256: createHash("sha256")
            .update("Contents/Resources/AppIcon.icns")
            .digest("hex"),
          productionOriginValidated: true,
          provenanceSha256: createHash("sha256")
            .update(
              "Contents/Resources/licenses/app-icon-provenance.txt",
            )
            .digest("hex"),
          requiresDeveloperIDAndNotarization: true,
          updater: {
            appcastURL: DEPLOYMENT_ENDPOINTS.sparkle.appcastURL,
            automaticChecks: true,
            automaticUpdateOptInAvailable: true,
            automaticUpdatesEnabledByDefault: true,
            afterUserOptIn: {
              automaticDownload: true,
              installOnQuit: true,
            },
            enabled: true,
            frameworkSha256: SPARKLE_FRAMEWORK_SHA256,
            frameworkVersion: SPARKLE_VERSION,
            publicEdKeySha256: createHash("sha256")
              .update(Buffer.alloc(32, 1))
              .digest("hex"),
            requiresSignedFeed: true,
            verifyBeforeExtraction: true,
          },
        },
        payload: await testPayloadInventory(app, temporaryRoot),
      }),
    );
    await writeBuildManifest();

    // The synthetic keytar.node staged above is not the audited npm
    // artifact, and Developer ID signing must refuse to sign it: the
    // runtime loader trusts a signed binding through its designated
    // requirement, so the byte audit has to happen here, before signing.
    await assert.rejects(
      developerIDSignMacOSApp(app, {
        commandRunner: (command) => {
          if (command === "/usr/bin/security") {
            return { stderr: "", stdout: `1) HASH "${identity}"\n` };
          }
          return { stderr: "", stdout: "" };
        },
        identity,
      }),
      { code: "MACOS_KEYTAR_BINDING_UNAUDITED" },
    );

    // With the audited bytes staged, signing proceeds — and additionally
    // proves the signed binding against the exact designated requirement
    // the runtime loader tests.
    const rootRequire = createRequire(join(REPOSITORY_ROOT, "package.json"));
    const keytarBindingPath = join(
      app,
      "Contents",
      "Resources",
      "app",
      "node_modules",
      "@github",
      "keytar",
      "prebuilds",
      "darwin-arm64",
      "keytar.node",
    );
    await chmod(keytarBindingPath, 0o700);
    await copyFile(
      rootRequire.resolve(
        "@github/keytar/prebuilds/darwin-arm64/keytar.node",
      ),
      keytarBindingPath,
    );
    await chmod(keytarBindingPath, 0o555);
    await writeBuildManifest();

    const calls = [];
    const runner = (command, arguments_, options = {}) => {
      calls.push({ arguments_, command, options });
      if (command === "/usr/bin/security") {
        return {
          stderr: "",
          stdout: `1) HASH "${identity}"\n`,
        };
      }
      if (command === "/usr/bin/codesign"
          && arguments_.includes("-d")) {
        return {
          stderr:
            "Authority=Developer ID Application: Example Owner (A1B2C3D4E5)\nflags=0x10000(runtime)\n",
          stdout: "",
        };
      }
      return { stderr: "", stdout: "" };
    };
    await developerIDSignMacOSApp(app, {
      commandRunner: runner,
      identity,
    });
    const signing = calls.filter(({ command, arguments_ }) =>
      command === "/usr/bin/codesign"
      && arguments_.includes("--sign"));
    assert.equal(signing.length, 9);
    assert.match(signing[0].arguments_.at(-1), /Installer\.xpc$/u);
    assert.match(signing[1].arguments_.at(-1), /Downloader\.xpc$/u);
    assert.equal(
      signing[1].arguments_.includes(
        "--preserve-metadata=entitlements",
      ),
      true,
    );
    assert.match(signing[2].arguments_.at(-1), /Versions\/B\/Autoupdate$/u);
    assert.match(signing[3].arguments_.at(-1), /Updater\.app$/u);
    assert.match(signing[4].arguments_.at(-1), /Sparkle\.framework$/u);
    assert.match(signing[5].arguments_.at(-1), /keytar\.node$/u);
    assert.match(signing[6].arguments_.at(-1), /runtime\/bin\/node$/u);
    assert.match(
      signing[6].arguments_[
        signing[6].arguments_.indexOf("--entitlements") + 1
      ],
      /NodeRuntime\.entitlements$/u,
    );
    assert.match(signing[7].arguments_.at(-1), /MacOS\/TiboTattle$/u);
    assert.equal(signing[8].arguments_.at(-1), app);
    for (const call of signing) {
      assert.equal(call.arguments_.includes("--options"), true);
      assert.equal(call.arguments_.includes("runtime"), true);
      assert.equal(call.arguments_.includes("--timestamp"), true);
      assert.equal(call.arguments_.includes("--deep"), false);
      assert.deepEqual(call.options.secrets, [identity]);
    }
    const verify = calls.find(({ command, arguments_ }) =>
      command === "/usr/bin/codesign"
      && arguments_.includes("--verify"));
    assert.equal(verify.arguments_.includes("--deep"), true);
    assert.equal(verify.arguments_.includes("--strict"), true);
    // The freshly signed binding is proven against the exact requirement
    // the runtime loader will test on every launch: same team, same
    // identifier, nothing build-specific.
    const requirementVerify = calls.find(({ command, arguments_ }) =>
      command === "/usr/bin/codesign"
      && arguments_.some((argument) =>
        typeof argument === "string" && argument.startsWith("-R=")));
    assert.deepEqual(requirementVerify.arguments_, [
      "--verify",
      "--strict",
      "-R=anchor apple generic"
        + ' and certificate leaf[subject.OU] = "43RTH622SB"'
        + ' and identifier "keytar"',
      "--",
      keytarBindingPath,
    ]);

    const dmg = join(temporaryRoot, "TiboTattle.dmg");
    await writeFile(dmg, "signed-DMG-fixture");
    const dmgCalls = [];
    assert.deepEqual(
      await developerIDSignMacOSDMG(dmg, {
        identity,
        commandRunner(command, arguments_, options) {
          dmgCalls.push({ arguments_, command, options });
          return { stderr: "", stdout: "" };
        },
      }),
      { path: dmg },
    );
    assert.deepEqual(dmgCalls.map(({ arguments_ }) => arguments_), [
      ["--force", "--timestamp", "--sign", identity, dmg],
      ["--verify", "--strict", "--verbose=2", dmg],
    ]);
    assert.deepEqual(dmgCalls[0].options.secrets, [identity]);

    const acceptedCalls = [];
    assert.deepEqual(
      submitToAppleNotary("/tmp/UsageMonitor.zip", {
        notaryProfile: "usage-monitor-notary",
        commandRunner(command, arguments_, options) {
          acceptedCalls.push({ arguments_, command, options });
          return {
            stderr: "",
            stdout: JSON.stringify({
              id: "not-recorded",
              status: "Accepted",
            }),
          };
        },
      }),
      { status: "Accepted" },
    );
    assert.deepEqual(
      acceptedCalls[0].arguments_.slice(0, 2),
      ["notarytool", "submit"],
    );
    assert.deepEqual(
      acceptedCalls[0].options.secrets,
      ["usage-monitor-notary"],
    );
    assert.throws(
      () => submitToAppleNotary("/tmp/UsageMonitor.zip", {
        notaryProfile: "usage-monitor-notary",
        commandRunner() {
          return {
            stderr: "",
            stdout: JSON.stringify({
              id: "not-recorded",
              status: "Invalid",
            }),
          };
        },
      }),
      { code: "MACOS_NOTARIZATION_REJECTED" },
    );

    const provenancePath = join(
      resources,
      "licenses",
      "app-icon-provenance.txt",
    );
    const originalProvenance = await readFile(provenancePath);
    await writeFile(
      provenancePath,
      Buffer.concat([originalProvenance, Buffer.from("\ntampered")]),
    );
    await assert.rejects(
      inspectMacOSApp(app, { requireExternalDistribution: true }),
      { code: "MACOS_PAYLOAD_INTEGRITY_FAILED" },
    );
    await writeFile(provenancePath, originalProvenance);
    await symlink(
      "/tmp",
      join(resources, "unexpected-payload-link"),
    );
    await assert.rejects(
      inspectMacOSApp(app, { requireExternalDistribution: true }),
      { code: "MACOS_PAYLOAD_INTEGRITY_FAILED" },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("DMG Applications link must point to the system Applications folder", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-applications-link-test-"),
  );
  try {
    const correct = join(temporaryRoot, "correct");
    const incorrect = join(temporaryRoot, "incorrect");
    await symlink("/Applications", correct);
    await symlink("/tmp", incorrect);
    await validateMacOSApplicationsLink(correct);
    await assert.rejects(
      validateMacOSApplicationsLink(incorrect),
      /must target \/Applications/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("macOS central origin policy is fixed, HTTPS-first, and explicit for loopback", () => {
  assert.deepEqual(normalizeMacOSCentralOrigin(null), {
    configured: false,
    mode: "not_configured",
    origin: null,
  });
  assert.deepEqual(
    normalizeMacOSCentralOrigin("https://usage.example"),
    {
      configured: true,
      mode: "production_https",
      origin: "https://usage.example",
    },
  );
  assert.deepEqual(
    normalizeMacOSCentralOrigin("http://127.0.0.1:8792", {
      allowLoopbackCentralOrigin: true,
    }),
    {
      configured: true,
      mode: "development_loopback",
      origin: "http://127.0.0.1:8792",
    },
  );
  for (const [origin, options] of [
    ["http://127.0.0.1:8792", {}],
    ["http://127.0.0.1", { allowLoopbackCentralOrigin: true }],
    ["http://localhost:8792", { allowLoopbackCentralOrigin: true }],
    ["https://127.0.0.1:8792", {}],
    ["https://usage.example/path", {}],
    ["https://usage.example?query=1", {}],
    ["https://user:secret@usage.example", {}],
    ["https://usage.example", { allowLoopbackCentralOrigin: true }],
  ]) {
    assert.throws(
      () => normalizeMacOSCentralOrigin(origin, options),
      { code: "MACOS_APP_BUILD_FAILED" },
      origin,
    );
  }
  assert.throws(
    () => normalizeMacOSCentralOrigin(null, {
      allowLoopbackCentralOrigin: true,
    }),
    { code: "MACOS_APP_BUILD_FAILED" },
  );
});

test("macOS runtime graph is closed over exact source and dependency allowlists", async () => {
  const [graph, concurrentGraph, webModules, swiftSources] = await Promise.all([
    collectMacOSRuntimeGraph(),
    // The reproducibility artifact test can build two independent bundles at
    // once, so the graph scanner must not share mutable RegExp cursor state.
    collectMacOSRuntimeGraph(),
    collectMacOSWebModuleGraph(),
    collectMacOSSwiftSources(),
  ]);
  const runtimeAssets = [
    ...MACOS_RUNTIME_STATIC_ASSETS,
    ...webModules.relativeFiles,
  ].sort();
  assert.equal(graph.relativeFiles[0], "apps/local/server.js");
  assert.deepEqual(graph.externalSpecifiers, [
    "@app-usagemonitor/accounting",
    "@app-usagemonitor/identity-core",
    "@app-usagemonitor/quota-analysis",
    "@app-usagemonitor/telemetry-contract",
    "@github/keytar",
    "ajv",
    "runcost/browser",
  ]);
  assert.deepEqual(concurrentGraph, graph);
  assert.equal(graph.builtins.includes("node:http"), true);
  assert.equal(graph.builtins.includes("node:sqlite"), true);
  assert.equal(graph.relativeFiles.includes("src/local-installation-diagnostics.js"), true);
  assert.equal(
    graph.relativeFiles.includes("src/platform/participant-identity.js"),
    true,
  );
  for (const ownedFile of [
    "src/application/local-contribution-preparation.js",
    "src/application/local-export-set-verification.js",
    "src/application/local-prepared-contribution.js",
    "src/export/compression.js",
    "src/export/set-schema.js",
    "src/export/set-verification.js",
    "src/platform/export-set-verification-storage.js",
    "src/platform/owner-only-prepared-contribution-storage.js",
    "src/prepared-contribution-compatibility-internal.js",
  ]) {
    assert.equal(graph.relativeFiles.includes(ownedFile), true, ownedFile);
  }
  assert.equal(
    MACOS_RUNTIME_STATIC_ASSETS.includes("apps/macos/reset-local-keychain.js"),
    true,
  );
  assert.deepEqual(MACOS_WEB_MODULE_ENTRYPOINTS, [
    "apps/web/public/app.js",
  ]);
  // The dashboard entry plus the modules it shares with the public community
  // entry. The community entry itself is website-only and is not bundled.
  assert.deepEqual(webModules.relativeFiles, [
    "apps/web/public/app.js",
    "apps/web/public/community-data.js",
    "apps/web/public/data-client.js",
    "apps/web/public/install-cta.js",
    "apps/web/public/lib.js",
    "apps/web/public/localization.js",
    "apps/web/public/navigation.js",
    "apps/web/public/telemetry-envelope.js",
    "apps/web/public/telemetry-shared.generated.js",
    "apps/web/public/ui-format.js",
  ]);
  assert.equal(
    webModules.relativeFiles.includes("apps/web/public/community.js"),
    false,
  );
  assert.deepEqual(swiftSources.relativeFiles, [
    "apps/macos/Sources/KeychainBroker.swift",
    "apps/macos/Sources/Localization.swift",
    "apps/macos/Sources/LoginItemManager.swift",
    "apps/macos/Sources/MenuBarStatus.swift",
    "apps/macos/Sources/QuotaNotifications.swift",
    "apps/macos/Sources/SemanticOpenTarget.swift",
    "apps/macos/UsageMonitorApp.swift",
  ]);
  const localizationResources = await collectMacOSLocalizationResources();
  assert.deepEqual(localizationResources.relativeFiles, [
    "en.lproj/Localizable.strings",
    "es.lproj/Localizable.strings",
    "localization/manifest.json",
    "zh-Hans.lproj/Localizable.strings",
  ]);
  assert.deepEqual(runtimeAssets, [
    "apps/macos/reset-local-keychain.js",
    "apps/web/public/app.js",
    "apps/web/public/community-data.js",
    "apps/web/public/data-client.js",
    "apps/web/public/index.html",
    "apps/web/public/install-cta.js",
    "apps/web/public/lib.js",
    "apps/web/public/localization.js",
    "apps/web/public/navigation.js",
    "apps/web/public/styles.css",
    "apps/web/public/telemetry-envelope.js",
    "apps/web/public/telemetry-shared.generated.js",
    "apps/web/public/tibotattle-icon.png",
    "apps/web/public/ui-format.js",
  ]);
  assert.deepEqual(
    graph.relativeFiles.filter((path) =>
      /^(?:contracts\/telemetry-v0\.1|generated\/telemetry-v0\.1|package\.json|schemas\/telemetry-v0\.1)/u
        .test(path)),
    [
      "contracts/telemetry-v0.1/consent-status.json",
      "contracts/telemetry-v0.1/contract-status.json",
      "generated/telemetry-v0.1-compatibility.json",
      "generated/telemetry-v0.1-field-dictionary.json",
      "package.json",
      "schemas/telemetry-v0.1/activity-marker.schema.json",
      "schemas/telemetry-v0.1/bundle.schema.json",
      "schemas/telemetry-v0.1/compatibility.schema.json",
      "schemas/telemetry-v0.1/privacy-receipt.schema.json",
      "schemas/telemetry-v0.1/quota-snapshot.schema.json",
      "schemas/telemetry-v0.1/usage-event.schema.json",
    ],
  );
  for (const path of [
    ...graph.relativeFiles,
    ...runtimeAssets,
  ]) {
    assert.doesNotMatch(
      path,
      /(?:^|\/)(?:\.git|\.usage-monitor|local-review|reports?|test)(?:\/|$)/u,
    );
  }
  assert.equal(graph.relativeFiles.some((path) => path.includes("r7-")), false);
  assert.equal(graph.relativeFiles.some((path) => path.includes("ccusage")), false);
});

test("macOS web module discovery follows a deterministic transitive relative closure", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-web-modules-"),
  );
  const publicRoot = join(temporaryRoot, "apps", "web", "public");
  try {
    await mkdir(join(publicRoot, "nested"), { recursive: true });
    await writeFile(
      join(publicRoot, "app.js"),
      [
        'import "./nested/child.js";',
        'import "./sibling.js";',
        "",
      ].join("\n"),
    );
    await writeFile(
      join(publicRoot, "nested", "child.js"),
      'export { value } from "../leaf.js";\n',
    );
    await writeFile(
      join(publicRoot, "sibling.js"),
      [
        "export const side = 1;",
        "export const prose = \"import('./not-a-dependency.js')\";",
        "",
      ].join("\n"),
    );
    await writeFile(join(publicRoot, "leaf.js"), "export const value = 2;\n");

    const options = {
      allowedRoot: publicRoot,
      entrypoints: ["apps/web/public/app.js"],
      repositoryRoot: temporaryRoot,
    };
    const first = await collectMacOSWebModuleGraph(options);
    const second = await collectMacOSWebModuleGraph(options);
    assert.deepEqual(first.relativeFiles, [
      "apps/web/public/app.js",
      "apps/web/public/leaf.js",
      "apps/web/public/nested/child.js",
      "apps/web/public/sibling.js",
    ]);
    assert.deepEqual(second.relativeFiles, first.relativeFiles);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("macOS web module discovery rejects unsafe and unbounded imports", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-web-import-rejection-"),
  );
  const publicRoot = join(temporaryRoot, "apps", "web", "public");
  try {
    await mkdir(publicRoot, { recursive: true });
    await writeFile(
      join(temporaryRoot, "apps", "web", "outside.js"),
      "export const escaped = true;\n",
    );
    const options = {
      allowedRoot: publicRoot,
      entrypoints: ["apps/web/public/app.js"],
      repositoryRoot: temporaryRoot,
    };
    for (const [source, expected] of [
      ['import "unreviewed-package";\n', /only local relative modules/u],
      ['import "https://cdn.example/module.js";\n', /only local relative modules/u],
      ['import "/absolute/module.js";\n', /only local relative modules/u],
      ['import "../outside.js";\n', /escaped its reviewed root/u],
      ['const deferred = import("./deferred.js");\n', /Dynamic import is not allowed/u],
      ['const deferred = import(modulePath);\n', /Dynamic import is not allowed/u],
      [
        'const deferred = import /* reviewed comment */ ("./deferred.js");\n',
        /Dynamic import is not allowed/u,
      ],
      ['import "./module.js?cache=1";\n', /Unsafe macOS web module import/u],
      ['import { value from "./invalid.js";\n', /not valid static ESM/u],
    ]) {
      await writeFile(join(publicRoot, "app.js"), source);
      await assert.rejects(
        collectMacOSWebModuleGraph(options),
        expected,
        source.trim(),
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("macOS packaging rejects a stale telemetry browser mirror before discovery", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-stale-browser-mirror-"),
  );
  const publicRoot = join(temporaryRoot, "apps", "web", "public");
  const staleMirror = join(publicRoot, "telemetry-shared.generated.js");
  try {
    await mkdir(publicRoot, { recursive: true });
    await writeFile(staleMirror, "// stale browser mirror\n");
    await assert.rejects(
      collectVerifiedMacOSWebModuleGraph({
        webModuleOptions: {
          allowedRoot: publicRoot,
          entrypoints: ["apps/web/public/telemetry-shared.generated.js"],
          repositoryRoot: temporaryRoot,
        },
      }),
      /is stale; regenerate it without --check/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("macOS web closure and source digest retain the verified mirror snapshot", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-captured-browser-mirror-"),
  );
  const publicRoot = join(temporaryRoot, "apps", "web", "public");
  const sourceMirror = join(
    REPOSITORY_ROOT,
    "apps",
    "web",
    "public",
    "telemetry-shared.generated.js",
  );
  const snapshot = await readVerifiedTelemetryBrowserMirror();
  try {
    await mkdir(publicRoot, { recursive: true });
    const temporaryMirror = join(publicRoot, "telemetry-shared.generated.js");
    await writeFile(temporaryMirror, snapshot.sourceText);
    await writeFile(
      join(publicRoot, "app.js"),
      'import "./telemetry-shared.generated.js";\n',
    );
    const webModules = await collectVerifiedMacOSWebModuleGraph({
      readVerifiedBrowserMirror: async () => {
        await writeFile(temporaryMirror, "// mutated after verification\n");
        return snapshot;
      },
      webModuleOptions: {
        allowedRoot: publicRoot,
        entrypoints: ["apps/web/public/app.js"],
        repositoryRoot: temporaryRoot,
      },
    });
    const capturedMirror = webModules.modules.find((module) =>
      module.relativeFile === "apps/web/public/telemetry-shared.generated.js");
    assert.equal(capturedMirror.sourceText, snapshot.sourceText);
    assert.equal(capturedMirror.sha256, snapshot.sha256);
    assert.equal(capturedMirror.byteLength, snapshot.byteLength);

    const stagedAppRoot = join(temporaryRoot, "staged-app");
    const stagedRows = await stageMacOSWebModules(stagedAppRoot, webModules);
    const stagedMirrorPath = join(
      stagedAppRoot,
      "apps",
      "web",
      "public",
      "telemetry-shared.generated.js",
    );
    const stagedMirrorBytes = await readFile(stagedMirrorPath);
    assert.equal(stagedMirrorBytes.toString("utf8"), snapshot.sourceText);
    assert.deepEqual(
      stagedRows.find(({ relativeFile }) =>
        relativeFile === "apps/web/public/telemetry-shared.generated.js"),
      {
        relativeFile: "apps/web/public/telemetry-shared.generated.js",
        byteLength: snapshot.byteLength,
        sha256: snapshot.sha256,
      },
    );
    const stagedInventory = await Promise.all(webModules.modules.map(
      async (module) => {
        const bytes = await readFile(join(
          stagedAppRoot,
          ...module.relativeFile.split("/"),
        ));
        return {
          path: `Contents/Resources/app/${module.relativeFile}`,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      },
    ));
    assert.equal(
      assertMacOSWebModuleInventory(stagedInventory, webModules),
      true,
    );

    const digest = await calculateMacOSSourceInputDigest({
      graph: { files: [] },
      runtimeAssets: ["apps/web/public/telemetry-shared.generated.js"],
      swiftSources: { files: [] },
      webModules: {
        modules: [Object.freeze({
          ...snapshot,
          file: sourceMirror,
          relativeFile: "apps/web/public/telemetry-shared.generated.js",
        })],
      },
      readSource: async (path) => {
        assert.notEqual(path, sourceMirror, "digest must not reread captured mirror");
        return readFile(path);
      },
    });
    assert.match(digest, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("macOS workspace package capture binds staged bytes, inventory, and digest across source mutation", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-captured-workspace-packages-"),
  );
  const packageDefinitions = [
    {
      inputDirectory: "packages/accounting",
      name: "@app-usagemonitor/accounting",
      root: join(temporaryRoot, "packages", "accounting"),
      runtimeFiles: MACOS_ACCOUNTING_RUNTIME_FILES,
      version: RELEASE_VERSION,
    },
    {
      inputDirectory: "packages/identity-core",
      name: "@app-usagemonitor/identity-core",
      root: join(temporaryRoot, "packages", "identity-core"),
      runtimeFiles: MACOS_IDENTITY_CORE_RUNTIME_FILES,
      version: RELEASE_VERSION,
    },
    {
      inputDirectory: "packages/telemetry-contract",
      name: "@app-usagemonitor/telemetry-contract",
      root: join(temporaryRoot, "packages", "telemetry-contract"),
      runtimeFiles: MACOS_TELEMETRY_CONTRACT_RUNTIME_FILES,
      version: RELEASE_VERSION,
    },
    {
      inputDirectory: "packages/quota-analysis",
      name: "@app-usagemonitor/quota-analysis",
      root: join(temporaryRoot, "packages", "quota-analysis"),
      runtimeFiles: MACOS_QUOTA_ANALYSIS_RUNTIME_FILES,
      version: RELEASE_VERSION,
    },
  ];
  try {
    for (const definition of packageDefinitions) {
      const sourceRoot = join(
        REPOSITORY_ROOT,
        ...definition.inputDirectory.split("/"),
      );
      for (const relativeFile of definition.runtimeFiles) {
        const destination = join(
          definition.root,
          ...relativeFile.split("/"),
        );
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(
          join(sourceRoot, ...relativeFile.split("/")),
          destination,
        );
      }
    }

    const captures = await captureMacOSWorkspaceRuntimePackages({
      packageDefinitions,
      resolvePackageEntrypoint: (name) => {
        const definition = packageDefinitions.find((candidate) =>
          candidate.name === name);
        assert.ok(definition, `unexpected workspace package ${name}`);
        return join(definition.root, "index.js");
      },
    });
    assert.equal(captures.length, 4);
    assert.equal(
      captures.reduce((total, capture) => total + capture.files.length, 0),
      MACOS_ACCOUNTING_RUNTIME_FILES.length
        + MACOS_IDENTITY_CORE_RUNTIME_FILES.length
        + MACOS_QUOTA_ANALYSIS_RUNTIME_FILES.length
        + MACOS_TELEMETRY_CONTRACT_RUNTIME_FILES.length,
    );
    assert.equal(Object.isFrozen(captures), true);
    assert.equal(captures.every((capture) =>
      Object.isFrozen(capture) && Object.isFrozen(capture.files)), true);

    const digestOptions = {
      graph: { files: [] },
      runtimeAssets: [],
      swiftSources: { files: [] },
      workspaceRuntimePackages: captures,
      readSource: async (path) => {
        assert.equal(
          path.startsWith(join(temporaryRoot, "packages")),
          false,
          "digest must not reread a captured workspace package",
        );
        return readFile(path);
      },
    };
    const capturedDigest = await calculateMacOSSourceInputDigest(digestOptions);
    const divergentCaptures = Object.freeze(captures.map((capture) =>
      Object.freeze({
        ...capture,
        files: Object.freeze(capture.files.map((file) => {
          if (file.inputPath !== "packages/accounting/src/cost-ledger.js") {
            return file;
          }
          const sourceText = `${file.sourceText} `;
          return Object.freeze({
            ...file,
            byteLength: Buffer.byteLength(sourceText, "utf8"),
            sha256: createHash("sha256")
              .update(sourceText, "utf8")
              .digest("hex"),
            sourceText,
          });
        })),
      })));
    assert.notEqual(
      await calculateMacOSSourceInputDigest({
        ...digestOptions,
        workspaceRuntimePackages: divergentCaptures,
      }),
      capturedDigest,
      "the source digest must include the captured workspace package bytes",
    );

    const mutations = [
      ["@app-usagemonitor/accounting", "src/cost-ledger.js"],
      ["@app-usagemonitor/identity-core", "src/pseudonym.js"],
      ["@app-usagemonitor/quota-analysis", "src/quota-windows.js"],
      ["@app-usagemonitor/telemetry-contract", "src/envelope.js"],
    ];
    for (const [name, relativeFile] of mutations) {
      const definition = packageDefinitions.find((candidate) =>
        candidate.name === name);
      await writeFile(
        join(definition.root, ...relativeFile.split("/")),
        `// physically mutated after capture: ${name}\n`,
      );
    }
    assert.equal(
      await calculateMacOSSourceInputDigest(digestOptions),
      capturedDigest,
      "the source digest must remain bound to the captured package bytes",
    );

    const stagedAppRoot = join(temporaryRoot, "staged-app");
    const stagedRows = await stageMacOSWorkspaceRuntimePackages(
      stagedAppRoot,
      captures,
    );
    assert.equal(
      stagedRows.length,
      captures.reduce((total, capture) => total + capture.files.length, 0),
    );
    const stagedInventory = [];
    for (const capture of captures) {
      for (const file of capture.files) {
        const stagedPath = join(
          stagedAppRoot,
          "node_modules",
          ...capture.name.split("/"),
          ...file.relativeFile.split("/"),
        );
        const stagedBytes = await readFile(stagedPath);
        assert.equal(
          stagedBytes.toString("utf8"),
          file.sourceText,
          `${file.inputPath} must be staged from its captured bytes`,
        );
        stagedInventory.push({
          path: [
            "Contents",
            "Resources",
            "app",
            "node_modules",
            ...capture.name.split("/"),
            ...file.relativeFile.split("/"),
          ].join("/"),
          bytes: stagedBytes.length,
          sha256: createHash("sha256").update(stagedBytes).digest("hex"),
        });
      }
    }
    assert.equal(
      assertMacOSWorkspaceRuntimePackageInventory(stagedInventory, captures),
      true,
    );
    const identityCoreProbe = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        "import { deriveExportPseudonym }",
        "from '@app-usagemonitor/identity-core';",
        "process.stdout.write(deriveExportPseudonym(",
        "new Uint8Array(32), 'participant', 'self'));",
      ].join(" "),
    ], {
      cwd: stagedAppRoot,
      encoding: "utf8",
    });
    assert.equal(
      identityCoreProbe.status,
      0,
      identityCoreProbe.stderr || identityCoreProbe.stdout,
    );
    assert.equal(
      identityCoreProbe.stdout,
      "participant:v1:18a0babfe92f99d0737d96bd43ed18e494e8930e216eeb12d620742284df3f7c",
    );
    for (const [corruptedIndex, corruptedRow] of stagedInventory.entries()) {
      const corruptedInventory = stagedInventory.map((row, index) => {
        if (index !== corruptedIndex) return row;
        const replacementPrefix = row.sha256.startsWith("0") ? "1" : "0";
        return {
          ...row,
          sha256: `${replacementPrefix}${row.sha256.slice(1)}`,
        };
      });
      assert.throws(
        () => assertMacOSWorkspaceRuntimePackageInventory(
          corruptedInventory,
          captures,
        ),
        /did not retain captured workspace package bytes/u,
        corruptedRow.path,
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("macOS identity-core capture rejects resolver mismatch and unsafe runtime files", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-identity-core-capture-guards-"),
  );
  const sourceRoot = join(REPOSITORY_ROOT, "packages", "identity-core");
  const makeDefinition = async (fixtureName) => {
    const root = join(temporaryRoot, fixtureName, "identity-core");
    for (const relativeFile of MACOS_IDENTITY_CORE_RUNTIME_FILES) {
      const destination = join(root, ...relativeFile.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(sourceRoot, ...relativeFile.split("/")), destination);
    }
    return {
      inputDirectory: "packages/identity-core",
      name: "@app-usagemonitor/identity-core",
      root,
      runtimeFiles: MACOS_IDENTITY_CORE_RUNTIME_FILES,
      version: RELEASE_VERSION,
    };
  };
  try {
    const resolverMismatch = await makeDefinition("resolver-mismatch");
    const otherEntrypoint = join(resolverMismatch.root, "other.js");
    await writeFile(otherEntrypoint, "export {};\n");
    await assert.rejects(
      captureMacOSWorkspaceRuntimePackages({
        packageDefinitions: [resolverMismatch],
        resolvePackageEntrypoint: () => otherEntrypoint,
      }),
      (error) => error?.message
        === "The @app-usagemonitor/identity-core workspace dependency resolved unexpectedly",
    );

    const missingRuntime = await makeDefinition("missing-runtime");
    await rm(join(missingRuntime.root, "src", "pseudonym.js"));
    await assert.rejects(
      captureMacOSWorkspaceRuntimePackages({
        packageDefinitions: [missingRuntime],
        resolvePackageEntrypoint: () => join(missingRuntime.root, "index.js"),
      }),
      (error) => error?.message
        === "macOS workspace package runtime source is not a stable regular UTF-8 file: src/pseudonym.js",
    );

    const symlinkRuntime = await makeDefinition("symlink-runtime");
    const symlinkPath = join(symlinkRuntime.root, "src", "pseudonym.js");
    const symlinkTarget = join(temporaryRoot, "symlink-target.js");
    await writeFile(symlinkTarget, "export {};\n");
    await rm(symlinkPath);
    await symlink(symlinkTarget, symlinkPath);
    await assert.rejects(
      captureMacOSWorkspaceRuntimePackages({
        packageDefinitions: [symlinkRuntime],
        resolvePackageEntrypoint: () => join(symlinkRuntime.root, "index.js"),
      }),
      (error) => error?.message
        === "macOS workspace package runtime source is not a stable regular UTF-8 file: src/pseudonym.js",
    );

    const swapToSymlink = await makeDefinition("swap-to-symlink");
    const swapToSymlinkPath = join(
      swapToSymlink.root,
      "src",
      "pseudonym.js",
    );
    const swapSymlinkTarget = join(temporaryRoot, "swap-target.js");
    await writeFile(swapSymlinkTarget, "export const swapped = true;\n");
    let symlinkFailpointCalls = 0;
    await assert.rejects(
      captureMacOSWorkspaceRuntimePackages({
        packageDefinitions: [swapToSymlink],
        resolvePackageEntrypoint: () => join(
          swapToSymlink.root,
          "index.js",
        ),
        async postOpenPreReadFailpoint() {
          assert.equal(arguments.length, 0);
          symlinkFailpointCalls += 1;
          if (symlinkFailpointCalls !== 3) return;
          await rename(
            swapToSymlinkPath,
            join(temporaryRoot, "displaced-before-symlink.js"),
          );
          await symlink(swapSymlinkTarget, swapToSymlinkPath);
        },
      }),
      (error) => error?.message
        === "macOS workspace package runtime source is not a stable regular UTF-8 file: src/pseudonym.js",
    );
    assert.equal(symlinkFailpointCalls, 3);

    const swapToFile = await makeDefinition("swap-to-file");
    const swapToFilePath = join(swapToFile.root, "src", "pseudonym.js");
    const swapFileTarget = join(temporaryRoot, "swap-file-target.js");
    await writeFile(swapFileTarget, "export const replaced = true;\n");
    let fileFailpointCalls = 0;
    await assert.rejects(
      captureMacOSWorkspaceRuntimePackages({
        packageDefinitions: [swapToFile],
        resolvePackageEntrypoint: () => join(swapToFile.root, "index.js"),
        async postOpenPreReadFailpoint() {
          assert.equal(arguments.length, 0);
          fileFailpointCalls += 1;
          if (fileFailpointCalls !== 3) return;
          await rename(
            swapToFilePath,
            join(temporaryRoot, "displaced-before-file.js"),
          );
          await copyFile(swapFileTarget, swapToFilePath);
        },
      }),
      (error) => error?.message
        === "macOS workspace package runtime source is not a stable regular UTF-8 file: src/pseudonym.js",
    );
    assert.equal(fileFailpointCalls, 3);

    const growAfterOpen = await makeDefinition("grow-after-open");
    const growAfterOpenPath = join(
      growAfterOpen.root,
      "src",
      "pseudonym.js",
    );
    let growFailpointCalls = 0;
    await assert.rejects(
      captureMacOSWorkspaceRuntimePackages({
        packageDefinitions: [growAfterOpen],
        resolvePackageEntrypoint: () => join(growAfterOpen.root, "index.js"),
        async postOpenPreReadFailpoint() {
          assert.equal(arguments.length, 0);
          growFailpointCalls += 1;
          if (growFailpointCalls === 3) {
            await appendFile(growAfterOpenPath, "// concurrent growth\n");
          }
        },
      }),
      (error) => error?.message
        === "macOS workspace package runtime source is not a stable regular UTF-8 file: src/pseudonym.js",
    );
    assert.equal(growFailpointCalls, 3);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("macOS Swift discovery is deterministic and excludes test and build trees", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-swift-sources-"),
  );
  const sourceRoot = join(temporaryRoot, "apps", "macos");
  try {
    for (const directory of [
      "Sources/Feature",
      "Examples",
      "Tests",
      "Build",
      ".build",
      "DerivedData",
    ]) {
      await mkdir(join(sourceRoot, directory), { recursive: true });
    }
    for (const [path, source] of [
      ["ZLegacy.swift", "struct ZLegacy {}\n"],
      ["Package.swift", "// swift-tools-version: 6.0\n"],
      ["Sources/App.swift", "struct App {}\n"],
      ["Sources/Feature/Model.swift", "struct Model {}\n"],
      ["Examples/Sample.swift", "struct Sample {}\n"],
      ["Tests/AppTests.swift", "struct AppTests {}\n"],
      ["Build/Generated.swift", "struct Generated {}\n"],
      [".build/Intermediate.swift", "struct Intermediate {}\n"],
      ["DerivedData/Output.swift", "struct Output {}\n"],
    ]) {
      await writeFile(join(sourceRoot, path), source);
    }
    const options = {
      repositoryRoot: temporaryRoot,
      sourceRoot,
    };
    const first = await collectMacOSSwiftSources(options);
    const second = await collectMacOSSwiftSources(options);
    assert.deepEqual(first.relativeFiles, [
      "apps/macos/Sources/App.swift",
      "apps/macos/Sources/Feature/Model.swift",
      "apps/macos/ZLegacy.swift",
    ]);
    assert.deepEqual(second.relativeFiles, first.relativeFiles);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("macOS Swift discovery rejects candidates in unknown top-level directories", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-unreviewed-swift-source-"),
  );
  const sourceRoot = join(temporaryRoot, "apps", "macos");
  try {
    await mkdir(join(sourceRoot, "FutureFeature", "Runtime"), {
      recursive: true,
    });
    await writeFile(
      join(sourceRoot, "UsageMonitorApp.swift"),
      "struct UsageMonitorApp {}\n",
    );
    await writeFile(
      join(sourceRoot, "FutureFeature", "README.md"),
      "No production source yet.\n",
    );
    const options = {
      repositoryRoot: temporaryRoot,
      sourceRoot,
    };
    assert.deepEqual(
      (await collectMacOSSwiftSources(options)).relativeFiles,
      ["apps/macos/UsageMonitorApp.swift"],
    );

    await writeFile(
      join(sourceRoot, "FutureFeature", "Runtime", "Coordinator.swift"),
      "struct Coordinator {}\n",
    );
    await assert.rejects(
      collectMacOSSwiftSources(options),
      /Unreviewed top-level macOS directory contains Swift source candidates/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

macOSArtifactTest("reproducible ad-hoc-signed app passes orderly and launcher-SIGKILL watchdog smokes", {
  skip: BUILD_SUPPORTED ? false : "requires pinned macOS arm64 Node v26.2.0 builder",
  // This creates and deeply verifies two complete signed app bundles. On a
  // loaded developer Mac, codesign and the framework inventory alone can take
  // longer than a minute; retain every assertion and give the artifact check
  // a realistic bounded budget instead of turning it into a flaky failure.
  timeout: 180_000,
}, async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-macos-test-"),
  );
  const outputA = join(temporaryRoot, "a", "TiboTattle.app");
  const outputB = join(temporaryRoot, "b", "TiboTattle.app");
  const smokeHome = join(temporaryRoot, "smoke-home");
  try {
    // Each child has its own Node event loop, output parent, and compiler
    // scratch tree. This makes Swift compilation and codesigning genuinely
    // concurrent rather than serialising them behind this process's spawnSync
    // calls. allSettled ensures cleanup waits for both children on failure.
    const attempts = await Promise.allSettled([
      buildMacOSAppInIndependentProcess(outputA),
      buildMacOSAppInIndependentProcess(outputB),
    ]);
    const failures = attempts.filter((attempt) => attempt.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(({ reason }) => reason),
        "independent reproducibility builds failed",
      );
    }
    const [first, second] = attempts.map(({ value }) => value);
    assert.equal(first.buildProfile, MACOS_BUILD_PROFILES.release);
    assert.equal(second.buildProfile, MACOS_BUILD_PROFILES.release);
    assert.equal(first.output, outputA);
    assert.equal(second.output, outputB);
    assert.equal(first.payloadSha256, second.payloadSha256);
    assert.equal(first.sourceSha256, second.sourceSha256);
    assert.equal(first.totalBytes, second.totalBytes);
    const bundleFiles = await walk(outputA);
    const secondBundleFiles = await walk(outputB);
    assert.deepEqual(
      bundleFiles.map(({ relativePath }) => relativePath),
      secondBundleFiles.map(({ relativePath }) => relativePath),
    );
    for (let index = 0; index < bundleFiles.length; index += 1) {
      assert.equal(
        await sha256File(bundleFiles[index].path),
        await sha256File(secondBundleFiles[index].path),
        bundleFiles[index].relativePath,
      );
    }
    assert.equal(
      bundleFiles.some(({ relativePath }) =>
        relativePath === "Contents/_CodeSignature/CodeResources"),
      true,
    );

    const manifestPath = join(
      outputA,
      "Contents",
      "Resources",
      "build-manifest.json",
    );
    const manifestText = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.schemaVersion, "usage-monitor-macos-app-build-v0.1");
    assert.equal(manifest.application.bundleIdentifier, "com.usagemonitor.local");
    assert.equal(manifest.application.signing, "ad_hoc_developer_bundle");
    assert.deepEqual(manifest.release, {
      appOpenHost: "open",
      appOpenScheme: "usagemonitor",
      appOpenURL: "usagemonitor://open",
      channel: "development",
      channelName: "development",
      externalDistributionRequested: false,
      iconIncluded: true,
      iconSha256: await sha256File(
        join(REPOSITORY_ROOT, "apps", "macos", "Assets", "AppIcon.icns"),
      ),
      productionOriginValidated: false,
      provenanceSha256: await sha256File(
        join(REPOSITORY_ROOT, "apps", "macos", "Assets", "AppIcon.provenance.txt"),
      ),
      previewDistributionRequested: false,
      previewOriginValidated: false,
      requiresDeveloperIDAndNotarization: false,
      updater: {
        appcastURL: null,
        automaticChecks: false,
        automaticUpdateOptInAvailable: false,
        automaticUpdatesEnabledByDefault: false,
        afterUserOptIn: {
          automaticDownload: false,
          installOnQuit: false,
        },
        enabled: false,
        frameworkSha256: null,
        frameworkVersion: null,
        publicEdKeySha256: null,
        requiresSignedFeed: false,
        verifyBeforeExtraction: false,
      },
    });
    assert.deepEqual(manifest.application.executable, {
      integrity: "strict_codesign",
      path: "Contents/MacOS/TiboTattle",
    });
    assert.equal(manifest.runtime.node.version, "26.2.0");
    assert.equal(manifest.runtime.node.architecture, "arm64");
    assert.deepEqual(manifest.runtime.centralService, {
      configured: false,
      mode: "not_configured",
    });
    assert.equal(manifest.runtime.stateRoot,
      "~/Library/Application Support/Usage Monitor");
    assert.equal(manifest.privacyBoundary.loopbackHost, "127.0.0.1");
    assert.equal(manifest.privacyBoundary.requestedPort, 0);
    assert.deepEqual(manifest.payload.links, []);
    assert.deepEqual(manifest.privacyBoundary, {
      backgroundUploadAdded: false,
      credentialsIncluded: false,
      generatedTreeIncluded: false,
      localReportsIncluded: false,
      localStateIncluded: false,
      loginItemAdded: false,
      loopbackHost: "127.0.0.1",
      requestedPort: 0,
    });
    assert.deepEqual(
      manifest.dependencies.map(({ name, version }) => ({ name, version })),
      [
        {
          name: "@app-usagemonitor/accounting",
          version: RELEASE_VERSION,
        },
        {
          name: "@app-usagemonitor/identity-core",
          version: RELEASE_VERSION,
        },
        {
          name: "@app-usagemonitor/quota-analysis",
          version: RELEASE_VERSION,
        },
        {
          name: "@app-usagemonitor/telemetry-contract",
          version: RELEASE_VERSION,
        },
        { name: "@github/keytar", version: "7.10.6" },
        { name: "ajv", version: "8.20.0" },
        { name: "fast-deep-equal", version: "3.1.3" },
        { name: "fast-uri", version: "3.1.5" },
        { name: "json-schema-traverse", version: "1.0.0" },
        { name: "require-from-string", version: "2.0.2" },
        { name: "runcost", version: "0.2.1" },
      ],
    );
    const bundledTelemetryContractPrefix =
      "Contents/Resources/app/node_modules/"
      + "@app-usagemonitor/telemetry-contract/";
    assert.deepEqual(
      bundleFiles
        .map(({ relativePath }) => relativePath)
        .filter((path) => path.startsWith(bundledTelemetryContractPrefix))
        .map((path) => path.slice(bundledTelemetryContractPrefix.length)),
      MACOS_TELEMETRY_CONTRACT_RUNTIME_FILES,
    );
    const bundledAccountingPrefix =
      "Contents/Resources/app/node_modules/"
      + "@app-usagemonitor/accounting/";
    assert.deepEqual(
      bundleFiles
        .map(({ relativePath }) => relativePath)
        .filter((path) => path.startsWith(bundledAccountingPrefix))
        .map((path) => path.slice(bundledAccountingPrefix.length)),
      MACOS_ACCOUNTING_RUNTIME_FILES,
    );
    const bundledIdentityCorePrefix =
      "Contents/Resources/app/node_modules/"
      + "@app-usagemonitor/identity-core/";
    assert.deepEqual(
      bundleFiles
        .map(({ relativePath }) => relativePath)
        .filter((path) => path.startsWith(bundledIdentityCorePrefix))
        .map((path) => path.slice(bundledIdentityCorePrefix.length)),
      MACOS_IDENTITY_CORE_RUNTIME_FILES,
    );
    const bundledQuotaAnalysisPrefix =
      "Contents/Resources/app/node_modules/"
      + "@app-usagemonitor/quota-analysis/";
    assert.deepEqual(
      bundleFiles
        .map(({ relativePath }) => relativePath)
        .filter((path) => path.startsWith(bundledQuotaAnalysisPrefix))
        .map((path) => path.slice(bundledQuotaAnalysisPrefix.length)),
      MACOS_QUOTA_ANALYSIS_RUNTIME_FILES,
    );
    const swiftSources = await collectMacOSSwiftSources();
    const localizationResources = await collectMacOSLocalizationResources();
    const sourceInputPaths = new Set([
      ...manifest.inputs.firstPartyFiles,
      ...manifest.inputs.localizationResources,
      ...manifest.inputs.staticAssets,
      ...MACOS_TELEMETRY_CONTRACT_RUNTIME_FILES.map(
        (path) => `packages/telemetry-contract/${path}`,
      ),
      ...MACOS_ACCOUNTING_RUNTIME_FILES.map(
        (path) => `packages/accounting/${path}`,
      ),
      ...MACOS_IDENTITY_CORE_RUNTIME_FILES.map(
        (path) => `packages/identity-core/${path}`,
      ),
      ...MACOS_QUOTA_ANALYSIS_RUNTIME_FILES.map(
        (path) => `packages/quota-analysis/${path}`,
      ),
      "config/product-brand.js",
      "scripts/build-macos-app.js",
      "scripts/lib/captured-utf8-source.mjs",
      "apps/macos/Assets/AppIcon.icns",
      "apps/macos/Assets/AppIcon.provenance.txt",
      ...swiftSources.relativeFiles,
    ]);
    assert.deepEqual(
      manifest.inputs.localizationResources,
      localizationResources.relativeFiles.map((path) =>
        `apps/macos/Resources/${path}`),
    );
    for (const relativePath of [
      "Contents/Resources/en.lproj/Localizable.strings",
      "Contents/Resources/es.lproj/Localizable.strings",
      "Contents/Resources/localization/manifest.json",
      "Contents/Resources/app/localization/en.lproj/Localizable.strings",
      "Contents/Resources/app/localization/es.lproj/Localizable.strings",
      "Contents/Resources/app/localization/manifest.json",
      "Contents/Resources/zh-Hans.lproj/Localizable.strings",
      "Contents/Resources/app/localization/zh-Hans.lproj/Localizable.strings",
    ]) {
      assert.equal(
        bundleFiles.some(({ relativePath: bundledPath }) =>
          bundledPath === relativePath),
        true,
        relativePath,
      );
    }
    const sourceInputHash = createHash("sha256");
    for (const path of [...sourceInputPaths].sort((left, right) =>
      left.localeCompare(right))) {
      sourceInputHash.update(path);
      sourceInputHash.update("\0");
      sourceInputHash.update(
        await readFile(join(REPOSITORY_ROOT, ...path.split("/"))),
      );
      sourceInputHash.update("\0");
    }
    assert.equal(
      manifest.inputs.sourceSha256,
      sourceInputHash.digest("hex"),
      "the source digest must cover the copied telemetry package bytes",
    );
    assert.equal(manifestText.includes("/Users/"), false);
    assert.equal(manifestText.includes("adamallcock"), false);

    const payloadHash = createHash("sha256");
    let payloadBytes = 0;
    for (const entry of manifest.payload.files) {
      assert.notEqual(
        entry.path,
        "Contents/Resources/build-manifest.json",
      );
      assert.notEqual(
        entry.path,
        "Contents/_CodeSignature/CodeResources",
      );
      const selected = join(outputA, ...entry.path.split("/"));
      const bytes = await testPayloadBytes(
        selected,
        entry.path,
        temporaryRoot,
      );
      const metadata = await stat(selected);
      assert.equal(
        entry.normalization,
        NORMALIZED_TEST_CODE_PATHS.has(entry.path)
          ? "mach_o_without_code_signature"
          : "raw",
      );
      assert.equal(bytes.length, entry.bytes, entry.path);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        entry.sha256,
        entry.path,
      );
      assert.equal(
        (metadata.mode & 0o777).toString(8).padStart(3, "0"),
        entry.mode,
        entry.path,
      );
      payloadBytes += bytes.length;
      payloadHash.update(entry.path);
      payloadHash.update("\0");
      payloadHash.update(bytes);
      payloadHash.update("\0");
    }
    assert.deepEqual(
      manifest.payload.files
        .filter(({ normalization }) =>
          normalization === "mach_o_without_code_signature")
        .map(({ path }) => path),
      [...NORMALIZED_TEST_CODE_PATHS]
        .filter((path) => manifest.payload.files.some(
          (entry) => entry.path === path,
        ))
        .sort((left, right) => left.localeCompare(right)),
    );
    assert.equal(payloadBytes, manifest.payload.totalBytes);
    assert.equal(payloadBytes, first.totalBytes);
    assert.equal(payloadHash.digest("hex"), manifest.payload.payloadSha256);
    assert.equal(manifest.payload.payloadSha256, first.payloadSha256);

    for (const { entry, relativePath } of bundleFiles) {
      assert.equal(entry.isSymbolicLink(), false, relativePath);
      assert.doesNotMatch(
        relativePath,
        /(?:^|\/)(?:\.git|\.usage-monitor|local-review|reports?|credentials?)(?:\/|$)|\.(?:db|jsonl|log|map|pem|sqlite3?|umx)$/iu,
      );
    }
    const developmentPlist = JSON.parse(execFileSync("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      join(outputA, "Contents", "Info.plist"),
    ], { encoding: "utf8" }));
    assert.equal(developmentPlist.UsageMonitorUpdaterEnabled, false);
    assert.equal(
      developmentPlist.UsageMonitorBuildChannel,
      "development",
    );
    assert.equal(
      developmentPlist.UsageMonitorReleaseChannel,
      "development",
    );
    assert.equal(developmentPlist.UsageMonitorPreviewDistribution, false);
    assert.equal(
      bundleFiles.some(({ relativePath }) =>
        relativePath.startsWith("Contents/Frameworks/")),
      false,
    );
    const updaterSmoke = spawnSync(
      join(outputA, "Contents", "MacOS", "TiboTattle"),
      ["--updater-contract-smoke-test"],
      { encoding: "utf8" },
    );
    assert.equal(
      updaterSmoke.status,
      0,
      updaterSmoke.stderr || updaterSmoke.stdout,
    );
    assert.match(
      updaterSmoke.stdout,
      /runtime=development_disabled state=unavailable_in_build/u,
    );
    const failedFeedSmoke = spawnSync(
      join(outputA, "Contents", "MacOS", "TiboTattle"),
      ["--updater-feed-contract-smoke-test", "404"],
      { encoding: "utf8" },
    );
    assert.equal(
      failedFeedSmoke.status,
      0,
      failedFeedSmoke.stderr || failedFeedSmoke.stdout,
    );
    assert.match(
      failedFeedSmoke.stdout,
      /^USAGE_MONITOR_MACOS_UPDATER_FEED_CONTRACT status=404 result=failed sparkle_check=false$/mu,
    );
    const loginItemSmoke = spawnSync(
      join(outputA, "Contents", "MacOS", "TiboTattle"),
      ["--login-item-contract-smoke-test"],
      { encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(
      loginItemSmoke.status,
      0,
      loginItemSmoke.stderr || loginItemSmoke.stdout,
    );
    assert.match(
      loginItemSmoke.stdout,
      /^USAGE_MONITOR_MACOS_LOGIN_ITEM_CONTRACT fake=true register=affirmative-only unregister=explicit status=enabled,not-registered,requires-approval,unavailable outcomes=confirmed,requires-approval,not-confirmed,unavailable,failed pending_removal=true real_service_calls=0 daemon=false$/mu,
    );
    const menuBarSmoke = spawnSync(
      join(outputA, "Contents", "MacOS", "TiboTattle"),
      ["--menu-bar-contract-smoke-test"],
      { encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(
      menuBarSmoke.status,
      0,
      menuBarSmoke.stderr || menuBarSmoke.stdout,
    );
    assert.match(
      menuBarSmoke.stdout,
      /^USAGE_MONITOR_MACOS_MENU_BAR_CONTRACT native_rows=true titles=true states=starting,unavailable shortcuts=cmd-r,cmd-comma,cmd-q dismissal=native,escape,same-app,deactivation weekly_position=fresh-only$/mu,
    );
    const quotaNotificationSmoke = spawnSync(
      join(outputA, "Contents", "MacOS", "TiboTattle"),
      ["--quota-notification-contract-smoke-test"],
      { encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(
      quotaNotificationSmoke.status,
      0,
      quotaNotificationSmoke.stderr || quotaNotificationSmoke.stdout,
    );
    assert.match(
      quotaNotificationSmoke.stdout,
      /^USAGE_MONITOR_MACOS_QUOTA_NOTIFICATION_CONTRACT opt_in=true fresh_only=true first_sample=false threshold=true reset_schedule_fallback=true reset_identity_dedupe=true dedupe=true opt_out=true$/mu,
    );
    const refreshSettingsSmoke = spawnSync(
      join(outputA, "Contents", "MacOS", "TiboTattle"),
      ["--native-refresh-settings-contract-smoke-test"],
      { encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(
      refreshSettingsSmoke.status,
      0,
      refreshSettingsSmoke.stderr || refreshSettingsSmoke.stdout,
    );
    assert.match(
      refreshSettingsSmoke.stdout,
      /^USAGE_MONITOR_MACOS_REFRESH_SETTINGS_CONTRACT default=300 persisted=900 reloaded=900 picker_action=true picker_persisted=true scheduler=300->900 invalid_ignored=true$/mu,
    );
    // The settings window is sized from what its pages measure. Source text
    // cannot show whether a page then fits, so this measures the real frames:
    // zero overflow at the page's own height, a scroller when the window is
    // deliberately shorter than the page, and controls at intrinsic width on
    // the card's leading edge instead of stretched into full-width banners.
    const settingsLayoutSmoke = spawnSync(
      join(outputA, "Contents", "MacOS", "TiboTattle"),
      ["--native-settings-layout-smoke-test"],
      { encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(
      settingsLayoutSmoke.status,
      0,
      settingsLayoutSmoke.stderr || settingsLayoutSmoke.stdout,
    );
    assert.match(
      settingsLayoutSmoke.stdout,
      /^USAGE_MONITOR_MACOS_SETTINGS_LAYOUT cards=4 column_width=680 leading_spread=0 width_spread=0 full_width=true page_height=\d+ page_overflow=0 short_page_overflow=0 scroller_when_short=true control_stretch=0 control_leading_spread=0 short_column_height=\d+ widest_card_gap=12 worst_card_stretch=0 packed_to_top=true$/mu,
    );
    const nativeDashboardLayoutSmoke = spawnSync(
      join(outputA, "Contents", "MacOS", "TiboTattle"),
      ["--native-dashboard-layout-smoke-test"],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(
      nativeDashboardLayoutSmoke.status,
      0,
      nativeDashboardLayoutSmoke.stderr || nativeDashboardLayoutSmoke.stdout,
    );
    assert.match(
      nativeDashboardLayoutSmoke.stdout,
      /^USAGE_MONITOR_MACOS_NATIVE_DASHBOARD_LAYOUT web_width=[6-9][0-9]{2,} web_height=[6-9][0-9]{2,}$/mu,
    );
    // A sidebar that cannot be reopened is a window with no navigation: the
    // rows live only here, because the web report hides its own sidebar in
    // native mode. Source text can show a toolbar item and a menu command
    // exist; only this proves the action reaches a live target, that the pane
    // returns at its enforced width, and that a sidebar stranded shut by an
    // older build reopens exactly once on upgrade.
    const sidebarRecoverySmoke = spawnSync(
      join(outputA, "Contents", "MacOS", "TiboTattle"),
      ["--native-dashboard-sidebar-recovery-smoke-test"],
      { encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(
      sidebarRecoverySmoke.status,
      0,
      sidebarRecoverySmoke.stderr || sidebarRecoverySmoke.stdout,
    );
    assert.match(
      sidebarRecoverySmoke.stdout,
      /^USAGE_MONITOR_MACOS_SIDEBAR_RECOVERY collapse=true responds=true menu_enabled=true reveal=true width=[12][0-9]{2} rescue_once=true respects_choice=true$/mu,
    );
    const generatedFiles = bundleFiles
      .map(({ relativePath }) => relativePath)
      .filter((path) => path.includes("/app/generated/"));
    assert.deepEqual(generatedFiles, [
      "Contents/Resources/app/generated/telemetry-v0.1-compatibility.json",
      "Contents/Resources/app/generated/telemetry-v0.1-field-dictionary.json",
    ]);
    const compatibilityInputs = bundleFiles
      .map(({ relativePath }) => relativePath)
      .filter((path) =>
        /^Contents\/Resources\/app\/(?:contracts\/telemetry-v0\.1|generated\/telemetry-v0\.1|package\.json|schemas\/telemetry-v0\.1)/u
          .test(path));
    assert.deepEqual(compatibilityInputs, [
      "Contents/Resources/app/contracts/telemetry-v0.1/consent-status.json",
      "Contents/Resources/app/contracts/telemetry-v0.1/contract-status.json",
      "Contents/Resources/app/generated/telemetry-v0.1-compatibility.json",
      "Contents/Resources/app/generated/telemetry-v0.1-field-dictionary.json",
      "Contents/Resources/app/package.json",
      "Contents/Resources/app/schemas/telemetry-v0.1/activity-marker.schema.json",
      "Contents/Resources/app/schemas/telemetry-v0.1/bundle.schema.json",
      "Contents/Resources/app/schemas/telemetry-v0.1/compatibility.schema.json",
      "Contents/Resources/app/schemas/telemetry-v0.1/privacy-receipt.schema.json",
      "Contents/Resources/app/schemas/telemetry-v0.1/quota-snapshot.schema.json",
      "Contents/Resources/app/schemas/telemetry-v0.1/usage-event.schema.json",
    ]);

    const node = join(outputA, manifest.runtime.node.executable);
    assert.equal(await sha256File(node), manifest.runtime.node.sha256);
    assert.equal(execFileSync(node, ["--version"], { encoding: "utf8" }).trim(),
      "v26.2.0");
    const sourcePackage = JSON.parse(
      await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"),
    );
    const bundledPackage = JSON.parse(
      await readFile(
        join(
          outputA,
          "Contents",
          "Resources",
          "app",
          "package.json",
        ),
        "utf8",
      ),
    );
    assert.equal(bundledPackage.name, sourcePackage.name);
    assert.equal(bundledPackage.version, sourcePackage.version);
    assert.equal(bundledPackage.type, sourcePackage.type);
    const telemetryContractProbe = spawnSync(node, [
      "--input-type=module",
      "--eval",
      [
        "import { TELEMETRY_SCHEMA_VERSION }",
        "from '@app-usagemonitor/telemetry-contract';",
        "process.stdout.write(TELEMETRY_SCHEMA_VERSION);",
      ].join(" "),
    ], {
      cwd: join(outputA, "Contents", "Resources", "app"),
      encoding: "utf8",
    });
    assert.equal(
      telemetryContractProbe.status,
      0,
      telemetryContractProbe.stderr || telemetryContractProbe.stdout,
    );
    assert.equal(
      telemetryContractProbe.stdout,
      "telemetry-contribution-v0.1",
    );
    const accountingProbe = spawnSync(node, [
      "--input-type=module",
      "--eval",
      [
        "import { LOCAL_API_PRICING_METHOD_VERSION }",
        "from '@app-usagemonitor/accounting';",
        "process.stdout.write(LOCAL_API_PRICING_METHOD_VERSION);",
      ].join(" "),
    ], {
      cwd: join(outputA, "Contents", "Resources", "app"),
      encoding: "utf8",
    });
    assert.equal(
      accountingProbe.status,
      0,
      accountingProbe.stderr || accountingProbe.stdout,
    );
    assert.equal(
      accountingProbe.stdout,
      "provider-neutral-api-price-equivalent-v0.2",
    );
    const identityCoreProbe = spawnSync(node, [
      "--input-type=module",
      "--eval",
      [
        "import { deriveExportPseudonym }",
        "from '@app-usagemonitor/identity-core';",
        "process.stdout.write(deriveExportPseudonym(",
        "new Uint8Array(32), 'participant', 'self'));",
      ].join(" "),
    ], {
      cwd: join(outputA, "Contents", "Resources", "app"),
      encoding: "utf8",
    });
    assert.equal(
      identityCoreProbe.status,
      0,
      identityCoreProbe.stderr || identityCoreProbe.stdout,
    );
    assert.equal(
      identityCoreProbe.stdout,
      "participant:v1:18a0babfe92f99d0737d96bd43ed18e494e8930e216eeb12d620742284df3f7c",
    );
    const compatibilityProbe = spawnSync(node, [
      "--input-type=module",
      "--eval",
      [
        "import { exportCompatibilityTuple }",
        "from './src/export-contract.js';",
        "process.stdout.write(JSON.stringify(exportCompatibilityTuple()));",
      ].join(" "),
    ], {
      cwd: join(outputA, "Contents", "Resources", "app"),
      encoding: "utf8",
    });
    assert.equal(
      compatibilityProbe.status,
      0,
      compatibilityProbe.stderr || compatibilityProbe.stdout,
    );
    assert.deepEqual(
      JSON.parse(compatibilityProbe.stdout),
      JSON.parse(
        await readFile(
          join(
            outputA,
            "Contents",
            "Resources",
            "app",
            "generated",
            "telemetry-v0.1-compatibility.json",
          ),
          "utf8",
        ),
      ),
    );
    const launcher = join(outputA, "Contents", "MacOS", "TiboTattle");
    assert.match(
      execFileSync("/usr/bin/file", ["-b", launcher], { encoding: "utf8" }),
      /Mach-O 64-bit executable arm64/u,
    );
    for (const appBundle of [outputA, outputB]) {
      const strictVerification = spawnSync("/usr/bin/codesign", [
        "--verify",
        "--deep",
        "--strict",
        appBundle,
      ], { encoding: "utf8" });
      assert.equal(
        strictVerification.status,
        0,
        strictVerification.stderr || strictVerification.stdout,
      );
    }
    for (const relativePath of [
      "Contents/Resources/app/node_modules/@github/keytar/prebuilds/darwin-arm64/keytar.node",
      "Contents/Resources/runtime/bin/node",
      "Contents/MacOS/TiboTattle",
    ]) {
      execFileSync("/usr/bin/codesign", [
        "--force",
        "--sign",
        "-",
        "--options",
        "runtime",
        "--timestamp=none",
        join(outputB, ...relativePath.split("/")),
      ], { stdio: "ignore" });
    }
    execFileSync("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--timestamp=none",
      outputB,
    ], { stdio: "ignore" });
    await inspectMacOSApp(outputB);
    const signatureDescription = spawnSync("/usr/bin/codesign", [
      "-dv",
      "--verbose=4",
      outputA,
    ], { encoding: "utf8" });
    assert.match(
      `${signatureDescription.stdout}${signatureDescription.stderr}`,
      /Signature=adhoc/u,
    );
    assert.match(
      `${signatureDescription.stdout}${signatureDescription.stderr}`,
      /Sealed Resources version=2/u,
    );
    const plistJson = JSON.parse(execFileSync("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      join(outputA, "Contents", "Info.plist"),
    ], { encoding: "utf8" }));
    assert.equal(plistJson.CFBundleDisplayName, PRODUCT_BRAND.displayName);
    assert.equal(plistJson.CFBundleExecutable, "TiboTattle");
    assert.equal(plistJson.CFBundleName, PRODUCT_BRAND.displayName);
    assert.deepEqual(plistJson.CFBundleURLTypes, [{
      CFBundleTypeRole: "Viewer",
      CFBundleURLName: "com.usagemonitor.local.open",
      CFBundleURLSchemes: ["usagemonitor"],
    }]);
    assert.equal(
      plistJson.UsageMonitorAppOpenHost,
      PRODUCT_BRAND.appOpenHost,
    );
    assert.equal(
      plistJson.UsageMonitorAppOpenScheme,
      PRODUCT_BRAND.appOpenScheme,
    );
    assert.equal(
      plistJson.UsageMonitorAppOpenURL,
      PRODUCT_BRAND.appOpenURL,
    );
    assert.equal(
      plistJson.UsageMonitorBundleName,
      PRODUCT_BRAND.bundleName,
    );
    assert.equal(
      plistJson.UsageMonitorStateDirectoryName,
      PRODUCT_BRAND.stateDirectoryName,
    );
    assert.equal(
      plistJson.UsageMonitorMonitoredAppDisplayName,
      PRODUCT_BRAND.monitoredAppDisplayName,
    );
    assert.equal(
      plistJson.UsageMonitorMonitoredAppBundleIdentifier,
      PRODUCT_BRAND.monitoredAppBundleIdentifier,
    );
    assert.equal(
      plistJson.UsageMonitorPublicWebsiteOrigin,
      DEPLOYMENT_ENDPOINTS.public.origin,
    );
    assert.equal(plistJson.CFBundleIconFile, "AppIcon");
    assert.equal(plistJson.UsageMonitorNodeRuntimeMode, "standard");
    assert.equal(Object.hasOwn(plistJson, "UsageMonitorCentralOrigin"), false);
    assert.equal(
      Object.hasOwn(plistJson, "UsageMonitorCentralOriginMode"),
      false,
    );
    assert.equal(plistJson.NSAppTransportSecurity.NSAllowsLocalNetworking, true);
    assert.equal(Object.hasOwn(plistJson.NSAppTransportSecurity,
      "NSAllowsArbitraryLoads"), false);

    for (const accepted of [
      "usagemonitor://open",
      "usagemonitor://open/",
      "USAGEMONITOR://OPEN",
    ]) {
      const link = spawnSync(launcher, [
        "--app-link-smoke-test",
        accepted,
      ], {
        cwd: temporaryRoot,
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.equal(link.status, 0, accepted);
    }
    for (const rejected of [
      "usagemonitor://open?next=https://example.com",
      "usagemonitor://open?",
      "usagemonitor://open#fragment",
      "usagemonitor://open#",
      "usagemonitor://other",
      "https://open",
      "usagemonitor://open:443",
      "usagemonitor://open/extra",
      "usagemonitor://open//",
      "usagemonitor://open/%2F",
      "usagemonitor://@open",
      "usagemonitor://user:secret@open",
    ]) {
      const link = spawnSync(launcher, [
        "--app-link-smoke-test",
        rejected,
      ], {
        cwd: temporaryRoot,
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.equal(link.status, 1, rejected);
    }

    const diagnostics = spawnSync(launcher, [
      "--diagnostics-smoke-test",
    ], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(
      diagnostics.status,
      0,
      diagnostics.stderr || diagnostics.stdout,
    );
    assert.match(
      diagnostics.stdout,
      /^schema: usage-monitor-macos-diagnostics-v1$/mu,
    );
    assert.match(
      diagnostics.stdout,
      /^failure_code: UM_MACOS_COMPANION_START_TIMEOUT$/mu,
    );
    assert.match(
      diagnostics.stdout,
      /^login_item_status: requires_approval$/mu,
    );
    assert.match(
      diagnostics.stdout,
      /^login_item_last_operation: register_requires_approval$/mu,
    );
    assert.match(
      diagnostics.stdout,
      /^login_item_service: main_app_only$/mu,
    );
    assert.match(diagnostics.stdout, /^paths_included: false$/mu);
    assert.match(diagnostics.stdout, /^identifiers_included: false$/mu);
    assert.match(diagnostics.stdout, /^content_included: false$/mu);
    assert.match(
      diagnostics.stdout,
      /^contribution_journey_phase: approved_connection_needed$/mu,
    );
    assert.match(
      diagnostics.stdout,
      /^contribution_preview_state: not_observed$/mu,
    );
    assert.match(
      diagnostics.stdout,
      /^contribution_queue_state: retry_wait$/mu,
    );
    assert.match(
      diagnostics.stdout,
      /^contribution_tokens_included: false$/mu,
    );
    assert.match(
      diagnostics.stdout,
      /^contribution_oauth_state_included: false$/mu,
    );
    assert.match(
      diagnostics.stdout,
      /^contribution_device_identifiers_included: false$/mu,
    );
    assert.match(
      diagnostics.stdout,
      /^contribution_content_included: false$/mu,
    );
    assert.match(
      diagnostics.stdout,
      /^contribution_diagnostic_reference_1: TT-7QF3K2 @ 2026-08-19T13:01:00\.000Z$/mu,
    );
    assert.equal(diagnostics.stdout.includes("MUST_NOT_APPEAR"), false);
    assert.equal(diagnostics.stdout.includes("/Users/"), false);

    const settingsHome = join(temporaryRoot, "settings-home");
    const settingsRoot = join(
      settingsHome,
      "Library",
      "Application Support",
      "Usage Monitor",
    );
    const customCodexHome = join(temporaryRoot, "custom-codex-home");
    const secondaryCodexHome = join(temporaryRoot, "secondary-codex-home");
    await mkdir(settingsHome, { mode: 0o700 });
    await mkdir(customCodexHome, { mode: 0o700 });
    await mkdir(join(customCodexHome, "sessions"), { mode: 0o700 });
    await mkdir(secondaryCodexHome, { mode: 0o700 });
    await mkdir(join(secondaryCodexHome, "sessions"), { mode: 0o700 });
    const settingsSmoke = spawnSync(launcher, [
      "--codex-home-settings-smoke-test",
      customCodexHome,
      secondaryCodexHome,
    ], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        HOME: settingsHome,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: tmpdir(),
      },
    });
    assert.equal(
      settingsSmoke.status,
      0,
      settingsSmoke.stderr || settingsSmoke.stdout,
    );
    assert.equal(
      settingsSmoke.stdout,
      "USAGE_MONITOR_MACOS_CODEX_HOME_READY roots=2 primary_stable=true primary_removal_refused=true add=true reset=true persisted=true argv=repeatable path_exposed=false\n",
    );
    const settingsFile = join(
      settingsRoot,
      "launcher-settings-v1.json",
    );
    const persistedSettings = JSON.parse(await readFile(settingsFile, "utf8"));
    assert.equal(
      persistedSettings.schemaVersion,
      "usage-monitor-launcher-settings-v2",
    );
    assert.deepEqual(
      persistedSettings.activityRoots.map(({ path }) => path),
      [customCodexHome, secondaryCodexHome],
    );
    assert.equal(persistedSettings.activityRoots.length, 2);
    assert.equal(
      persistedSettings.primaryRootId,
      persistedSettings.activityRoots[1].rootId,
    );
    assert.equal(
      persistedSettings.activityRoots.every(({ enabled }) => enabled === true),
      true,
    );
    for (const { rootId } of persistedSettings.activityRoots) {
      assert.match(
        rootId,
        /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/iu,
      );
    }
    assert.equal(new Set(
      persistedSettings.activityRoots.map(({ rootId }) => rootId),
    ).size, 2);
    assert.equal((await stat(settingsFile)).mode & 0o777, 0o600);

    const assertUnavailableRootReloads = async (
      unavailableRoot,
      primaryUnavailable,
    ) => {
      const parkedRoot = `${unavailableRoot}-temporarily-parked`;
      await rename(unavailableRoot, parkedRoot);
      try {
        const reload = spawnSync(launcher, [
          "--codex-home-settings-reload-smoke-test",
        ], {
          cwd: temporaryRoot,
          encoding: "utf8",
          timeout: 5_000,
          env: {
            HOME: settingsHome,
            LANG: "en_US.UTF-8",
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            TMPDIR: tmpdir(),
          },
        });
        assert.equal(reload.status, 0, reload.stderr || reload.stdout);
        assert.equal(
          reload.stdout,
          "USAGE_MONITOR_MACOS_CODEX_HOME_RELOAD_READY roots=2 unavailable=1 "
            + `primary_unavailable=${primaryUnavailable} `
            + "argv=retained path_exposed=false\n",
        );
        assert.equal(reload.stdout.includes(unavailableRoot), false);
      } finally {
        await rename(parkedRoot, unavailableRoot);
      }
    };
    await assertUnavailableRootReloads(customCodexHome, false);
    await assertUnavailableRootReloads(secondaryCodexHome, true);
    assert.deepEqual(
      JSON.parse(await readFile(settingsFile, "utf8")),
      persistedSettings,
    );

    const refusedDuplicate = spawnSync(launcher, [
      "--codex-home-settings-smoke-test",
      customCodexHome,
      customCodexHome,
    ], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        HOME: settingsHome,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: tmpdir(),
      },
    });
    assert.equal(refusedDuplicate.status, 1);
    assert.deepEqual(
      JSON.parse(await readFile(settingsFile, "utf8")),
      persistedSettings,
    );

    const excessCodexHomes = [customCodexHome, secondaryCodexHome];
    for (let index = 0; index < 7; index += 1) {
      const path = join(temporaryRoot, `excess-codex-home-${index}`);
      await mkdir(path, { mode: 0o700 });
      excessCodexHomes.push(path);
    }
    const refusedNinthRoot = spawnSync(launcher, [
      "--codex-home-settings-smoke-test",
      ...excessCodexHomes,
    ], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        HOME: settingsHome,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: tmpdir(),
      },
    });
    assert.equal(refusedNinthRoot.status, 1);
    assert.deepEqual(
      JSON.parse(await readFile(settingsFile, "utf8")),
      persistedSettings,
    );

    const aliasedCodexHome = join(temporaryRoot, "aliased-codex-home");
    await symlink(customCodexHome, aliasedCodexHome);
    const refusedAlias = spawnSync(launcher, [
      "--codex-home-settings-smoke-test",
      aliasedCodexHome,
    ], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        HOME: settingsHome,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: tmpdir(),
      },
    });
    assert.equal(refusedAlias.status, 1);
    assert.equal(
      refusedAlias.stderr,
      "macOS Codex home settings smoke failed\n",
    );
    const reachabilitySmoke = spawnSync(launcher, [
      "--codex-home-reachability-smoke-test",
      customCodexHome,
      join(temporaryRoot, "health-unavailable-codex-home"),
      aliasedCodexHome,
    ], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        HOME: settingsHome,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: tmpdir(),
      },
    });
    assert.equal(
      reachabilitySmoke.status,
      0,
      reachabilitySmoke.stderr || reachabilitySmoke.stdout,
    );
    assert.equal(
      reachabilitySmoke.stdout,
      "USAGE_MONITOR_MACOS_CODEX_HOME_REACHABILITY "
        + "ready=1 temporarily_unavailable=1 invalid=1 "
        + "native_only=true path_exposed=false\n",
    );
    assert.equal(reachabilitySmoke.stdout.includes(customCodexHome), false);
    assert.equal(reachabilitySmoke.stdout.includes(aliasedCodexHome), false);

    const restartGateSmoke = spawnSync(launcher, [
      "--codex-home-restart-gate-smoke-test",
    ], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        HOME: settingsHome,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: tmpdir(),
      },
    });
    assert.equal(
      restartGateSmoke.status,
      0,
      restartGateSmoke.stderr || restartGateSmoke.stdout,
    );
    assert.equal(
      restartGateSmoke.stdout,
      "USAGE_MONITOR_MACOS_CODEX_HOME_RESTART_GATE "
        + "coalesced=true serialized=true starts=2 "
        + "controls=disabled-until-terminal "
        + "quit_cancels_restart=true\n",
    );

    const quitDuringStopSmoke = spawnSync(launcher, [
      "--codex-home-quit-during-stop-smoke-test",
    ], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        HOME: settingsHome,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: tmpdir(),
      },
    });
    assert.equal(
      quitDuringStopSmoke.status,
      0,
      quitDuringStopSmoke.stderr || quitDuringStopSmoke.stdout,
    );
    assert.equal(
      quitDuringStopSmoke.stdout,
      "USAGE_MONITOR_MACOS_CODEX_HOME_QUIT_DURING_STOP "
        + "stopped=true requested=true active_nil=true "
        + "restart_cancelled=true path_exposed=false\n",
    );
    await writeFile(settingsFile, "", { mode: 0o600 });
    const repairedSettings = spawnSync(launcher, [
      "--codex-home-settings-smoke-test",
      customCodexHome,
    ], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        HOME: settingsHome,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: tmpdir(),
      },
    });
    assert.equal(
      repairedSettings.status,
      0,
      repairedSettings.stderr || repairedSettings.stdout,
    );
    assert.equal((await stat(settingsFile)).mode & 0o777, 0o600);
    const repairedSettingsDocument = JSON.parse(
      await readFile(settingsFile, "utf8"),
    );
    assert.equal(
      repairedSettingsDocument.schemaVersion,
      "usage-monitor-launcher-settings-v2",
    );
    assert.deepEqual(
      repairedSettingsDocument.activityRoots.map(({ path }) => path),
      [customCodexHome],
    );
    assert.equal(
      repairedSettingsDocument.primaryRootId,
      repairedSettingsDocument.activityRoots[0].rootId,
    );

    // The ownership predicate itself: a root-owned directory passes every
    // other validation step (canonical path, directory, world-readable), so
    // this refusal proves the st_uid == getuid() branch fires — the same
    // rejection the Settings-window alert reports for a dogfood pick.
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      const refusedForeignOwner = spawnSync(launcher, [
        "--codex-home-settings-smoke-test",
        "/usr/bin",
      ], {
        cwd: temporaryRoot,
        encoding: "utf8",
        timeout: 5_000,
        env: {
          HOME: settingsHome,
          LANG: "en_US.UTF-8",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          TMPDIR: tmpdir(),
        },
      });
      assert.equal(refusedForeignOwner.status, 1);
      assert.equal(
        refusedForeignOwner.stderr,
        "macOS Codex home settings smoke failed\n",
      );
      // A refused pick leaves the previously saved custom folder untouched;
      // the visible Settings summary re-reads exactly this file.
      assert.deepEqual(
        JSON.parse(await readFile(settingsFile, "utf8")),
        repairedSettingsDocument,
      );
    }

    const migrationHome = join(temporaryRoot, "legacy-settings-home");
    const migrationSettingsRoot = join(
      migrationHome,
      "Library",
      "Application Support",
      "Usage Monitor",
    );
    await mkdir(migrationSettingsRoot, { recursive: true, mode: 0o700 });
    await chmod(migrationSettingsRoot, 0o700);
    const migrationSettingsFile = join(
      migrationSettingsRoot,
      "launcher-settings-v1.json",
    );
    await writeFile(
      migrationSettingsFile,
      `${JSON.stringify({
        codexHome: customCodexHome,
        schemaVersion: "usage-monitor-launcher-settings-v1",
      })}\n`,
      { mode: 0o600 },
    );
    await chmod(migrationSettingsFile, 0o600);
    const migrationSmoke = spawnSync(launcher, [
      "--codex-home-settings-migration-smoke-test",
    ], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        HOME: migrationHome,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: tmpdir(),
      },
    });
    assert.equal(
      migrationSmoke.status,
      0,
      migrationSmoke.stderr || migrationSmoke.stdout,
    );
    assert.equal(
      migrationSmoke.stdout,
      "USAGE_MONITOR_MACOS_CODEX_HOME_MIGRATED roots=1 primary_stable=true owner_only=true path_exposed=false\n",
    );
    assert.equal(migrationSmoke.stdout.includes(customCodexHome), false);
    const migratedSettings = JSON.parse(
      await readFile(migrationSettingsFile, "utf8"),
    );
    assert.equal(
      migratedSettings.schemaVersion,
      "usage-monitor-launcher-settings-v2",
    );
    assert.deepEqual(
      migratedSettings.activityRoots.map(({ path }) => path),
      [customCodexHome],
    );
    assert.equal(
      migratedSettings.primaryRootId,
      migratedSettings.activityRoots[0].rootId,
    );
    assert.equal(migratedSettings.activityRoots[0].enabled, true);
    assert.equal((await stat(migrationSettingsFile)).mode & 0o777, 0o600);

    const unavailableMigrationHome = join(
      temporaryRoot,
      "legacy-unavailable-settings-home",
    );
    const unavailableMigrationSettingsRoot = join(
      unavailableMigrationHome,
      "Library",
      "Application Support",
      "Usage Monitor",
    );
    await mkdir(unavailableMigrationSettingsRoot, {
      recursive: true,
      mode: 0o700,
    });
    await chmod(unavailableMigrationSettingsRoot, 0o700);
    const unavailableMigrationSettingsFile = join(
      unavailableMigrationSettingsRoot,
      "launcher-settings-v1.json",
    );
    const unavailableLegacyCodexHome = join(
      temporaryRoot,
      "temporarily-unavailable-legacy-codex",
    );
    await writeFile(
      unavailableMigrationSettingsFile,
      `${JSON.stringify({
        codexHome: unavailableLegacyCodexHome,
        schemaVersion: "usage-monitor-launcher-settings-v1",
      })}\n`,
      { mode: 0o600 },
    );
    await chmod(unavailableMigrationSettingsFile, 0o600);
    const unavailableMigrationSmoke = spawnSync(launcher, [
      "--codex-home-settings-migration-smoke-test",
    ], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        HOME: unavailableMigrationHome,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: tmpdir(),
      },
    });
    assert.equal(
      unavailableMigrationSmoke.status,
      0,
      unavailableMigrationSmoke.stderr || unavailableMigrationSmoke.stdout,
    );
    assert.equal(
      unavailableMigrationSmoke.stdout,
      "USAGE_MONITOR_MACOS_CODEX_HOME_MIGRATED roots=1 primary_stable=true owner_only=true path_exposed=false\n",
    );
    const unavailableMigratedSettings = JSON.parse(
      await readFile(unavailableMigrationSettingsFile, "utf8"),
    );
    assert.equal(
      unavailableMigratedSettings.schemaVersion,
      "usage-monitor-launcher-settings-v2",
    );
    assert.deepEqual(
      unavailableMigratedSettings.activityRoots.map(({ path }) => path),
      [unavailableLegacyCodexHome],
    );
    assert.equal(
      unavailableMigratedSettings.primaryRootId,
      unavailableMigratedSettings.activityRoots[0].rootId,
    );
    assert.equal(
      (await stat(unavailableMigrationSettingsFile)).mode & 0o777,
      0o600,
    );

    const firstRunHome = join(temporaryRoot, "first-run-home");
    await mkdir(firstRunHome, { mode: 0o700 });
    const firstRunSmoke = spawnSync(launcher, [
      "--first-run-contract-smoke-test",
    ], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        HOME: firstRunHome,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: tmpdir(),
      },
    });
    assert.equal(
      firstRunSmoke.status,
      0,
      firstRunSmoke.stderr || firstRunSmoke.stdout,
    );
    assert.equal(
      firstRunSmoke.stdout,
      "USAGE_MONITOR_MACOS_FIRST_RUN_CONTRACT persisted=true owner_only=true upload=false\n",
    );
    const firstRunFile = join(
      firstRunHome,
      "Library",
      "Application Support",
      "Usage Monitor",
      "first-run-v1.json",
    );
    assert.deepEqual(
      JSON.parse(await readFile(firstRunFile, "utf8")),
      {
        acknowledged: true,
        schemaVersion: "usage-monitor-first-run-v1",
      },
    );
    assert.equal((await stat(firstRunFile)).mode & 0o777, 0o600);
    await chmod(firstRunFile, 0o644);
    const unsafeFirstRun = spawnSync(launcher, [
      "--first-run-contract-smoke-test",
    ], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        HOME: firstRunHome,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: tmpdir(),
      },
    });
    assert.equal(unsafeFirstRun.status, 1);
    assert.equal(
      unsafeFirstRun.stderr,
      "macOS first-run contract smoke failed\n",
    );

    const resetContract = spawnSync(launcher, [
      "--keychain-reset-contract-smoke-test",
    ], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(
      resetContract.status,
      0,
      resetContract.stderr || resetContract.stdout,
    );
    assert.equal(
      resetContract.stdout,
      "USAGE_MONITOR_MACOS_KEYCHAIN_RESET_CONTRACT targets=2 app_state=targeted hosted_mutation=false secure_erasure=false confirmations=2\n",
    );

    await mkdir(smokeHome, { recursive: true, mode: 0o700 });
    const smoke = spawnSync(launcher, ["--smoke-test"], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        HOME: smokeHome,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: tmpdir(),
        USER: "usage-monitor-smoke",
      },
    });
    assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
    assert.match(
      smoke.stdout,
      /^USAGE_MONITOR_MACOS_SMOKE_READY host=127\.0\.0\.1 port=[0-9]+ state=owner-only$/mu,
    );
    const jitlessHome = join(temporaryRoot, "jitless-smoke-home");
    await mkdir(jitlessHome, { recursive: true, mode: 0o700 });
    const jitlessSmoke = spawnSync(launcher, ["--jitless-smoke-test"], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        HOME: jitlessHome,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: tmpdir(),
        USER: "usage-monitor-jitless-smoke",
      },
    });
    assert.equal(
      jitlessSmoke.status,
      0,
      jitlessSmoke.stderr || jitlessSmoke.stdout,
    );
    assert.match(
      jitlessSmoke.stdout,
      /^USAGE_MONITOR_MACOS_JITLESS_SMOKE_READY host=127\.0\.0\.1 port=[0-9]+ state=owner-only$/mu,
    );
    const refusedInheritedOrigin = spawnSync(
      launcher,
      ["--central-smoke-test"],
      {
        cwd: temporaryRoot,
        encoding: "utf8",
        timeout: 5_000,
        env: {
          HOME: smokeHome,
          LANG: "en_US.UTF-8",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          TMPDIR: tmpdir(),
          USAGE_MONITOR_CENTRAL_ORIGIN: "http://127.0.0.1:1",
        },
      },
    );
    assert.equal(refusedInheritedOrigin.status, 1);
    assert.equal(
      refusedInheritedOrigin.stderr,
      "macOS smoke: central service not configured\n",
    );
    const stateRoot = join(
      smokeHome,
      "Library",
      "Application Support",
      "Usage Monitor",
    );
    const stateMetadata = await stat(stateRoot);
    assert.equal(stateMetadata.isDirectory(), true);
    assert.equal(stateMetadata.mode & 0o777, 0o700);
    assert.equal(stateMetadata.uid, process.getuid());
    await assert.rejects(
      lstat(join(smokeHome, "Library", "LaunchAgents")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      lstat(join(smokeHome, "Library", "LaunchDaemons")),
      { code: "ENOENT" },
    );

    const dmg = join(
      temporaryRoot,
      "dmg",
      `TiboTattle-${RELEASE_VERSION}-macOS-arm64-development.dmg`,
    );
    const packaged = await packageMacOSDMG({
      appPath: outputA,
      output: dmg,
      distribution: "development",
    });
    assert.equal(packaged.output, dmg);
    assert.equal(packaged.distribution, "development");
    assert.match(packaged.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(packaged.bytes > 0, true);
    assert.deepEqual(
      await validateMacOSDMG(dmg, { production: false }),
      {
        bundleIdentifier: "com.usagemonitor.local",
        production: false,
        shortVersion: RELEASE_VERSION,
      },
    );
    await assert.rejects(
      validateMacOSDMG(dmg, {
        expectedBundleVersion: "999",
        production: false,
      }),
      { code: "MACOS_RELEASE_ARTIFACT_METADATA_MISMATCH" },
    );

    const watchdogHome = join(temporaryRoot, "watchdog-home");
    await mkdir(watchdogHome, { recursive: true, mode: 0o700 });
    const watchdogLauncher = spawn(launcher, ["--watchdog-smoke-test"], {
      cwd: temporaryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: watchdogHome,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: tmpdir(),
      },
    });
    let watchdogChildProcessId = null;
    const bundledEntrypoint = join(
      outputA,
      "Contents",
      "Resources",
      "app",
      "apps",
      "local",
      "server.js",
    );
    try {
      const readiness = await waitForOutputLine(
        watchdogLauncher,
        /^USAGE_MONITOR_MACOS_WATCHDOG_READY launcher=([0-9]+) child=([0-9]+) host=127\.0\.0\.1 port=([0-9]+)$/u,
      );
      assert.equal(Number(readiness[1]), watchdogLauncher.pid);
      watchdogChildProcessId = Number(readiness[2]);
      assert.equal(Number.isSafeInteger(watchdogChildProcessId), true);
      assert.equal(watchdogChildProcessId > 1, true);
      assert.equal(
        isExpectedCompanionProcess(
          watchdogChildProcessId,
          bundledEntrypoint,
        ),
        true,
      );
      assert.equal(watchdogLauncher.kill("SIGKILL"), true);
      const launcherExit = await waitForChildExit(watchdogLauncher);
      assert.equal(launcherExit.code, null);
      assert.equal(launcherExit.signal, "SIGKILL");
      assert.equal(
        await waitForProcessExit(
          watchdogChildProcessId,
          bundledEntrypoint,
        ),
        true,
        `bundled Node child ${watchdogChildProcessId} survived launcher SIGKILL`,
      );
    } finally {
      if (watchdogLauncher.exitCode === null
          && watchdogLauncher.signalCode === null) {
        watchdogLauncher.kill("SIGKILL");
        await waitForChildExit(watchdogLauncher);
      }
      if (watchdogChildProcessId !== null
          && isExpectedCompanionProcess(
            watchdogChildProcessId,
            bundledEntrypoint,
          )) {
        process.kill(watchdogChildProcessId, "SIGKILL");
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

macOSArtifactTest("preview distribution builds retain the normal identity and reject production validation", {
  skip: BUILD_SUPPORTED ? false : "requires pinned macOS arm64 Node v26.2.0 builder",
  timeout: 120_000,
}, async (context) => {
  const preparedFramework = join(
    REPOSITORY_ROOT,
    ".release-deps",
    "Sparkle.framework",
  );
  try {
    await lstat(preparedFramework);
  } catch (error) {
    if (error.code === "ENOENT") {
      context.skip("pinned framework has not been prepared in this checkout");
      return;
    }
    throw error;
  }
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-macos-preview-test-"),
  );
  const output = join(temporaryRoot, "preview", "TiboTattle.app");
  const publicEdKey = Buffer.alloc(32, 9).toString("base64");
  try {
    const build = await buildMacOSApp({
      bundleVersion: "42",
      centralOrigin: "https://preview.usage.example",
      output,
      previewDistribution: true,
      previewStagingRoot: dirname(output),
      sparkleAppcastURL: "https://updates.usage.example/appcast.xml",
      sparkleFramework: preparedFramework,
      sparklePublicEdKey: publicEdKey,
    });
    assert.deepEqual(
      {
        channel: build.channel,
        centralServiceMode: build.centralServiceMode,
        externalDistributionRequested: build.externalDistributionRequested,
        updaterEnabled: build.updaterEnabled,
      },
      {
        channel: MACOS_PREVIEW_DISTRIBUTION_CHANNEL,
        centralServiceMode: "production_https",
        externalDistributionRequested: false,
        updaterEnabled: true,
      },
    );
    const manifest = JSON.parse(await readFile(join(
      output,
      "Contents",
      "Resources",
      "build-manifest.json",
    ), "utf8"));
    assert.equal(manifest.application.bundleIdentifier, PRODUCT_BRAND.bundleIdentifier);
    assert.equal(manifest.application.bundleVersion, "42");
    assert.equal(manifest.release.channel, MACOS_PREVIEW_DISTRIBUTION_CHANNEL);
    assert.equal(
      manifest.release.channelName,
      MACOS_PREVIEW_DISTRIBUTION_CHANNEL,
    );
    assert.equal(manifest.release.previewDistributionRequested, true);
    assert.equal(manifest.release.externalDistributionRequested, false);
    assert.equal(manifest.release.requiresDeveloperIDAndNotarization, false);
    assert.deepEqual(await validateMacOSPreviewApp(output), {
      appPath: resolve(output),
      bundleIdentifier: PRODUCT_BRAND.bundleIdentifier,
      bundleVersion: "42",
      channel: MACOS_PREVIEW_DISTRIBUTION_CHANNEL,
      updaterEnabled: true,
    });
    const previewDMG = join(
      temporaryRoot,
      "dmg",
      `TiboTattle-${RELEASE_VERSION}-macOS-arm64-preview.dmg`,
    );
    const packagedPreview = await packageMacOSDMG({
      appPath: output,
      output: previewDMG,
      distribution: "preview",
    });
    assert.equal(packagedPreview.distribution, "preview");
    assert.equal(packagedPreview.output, previewDMG);
    assert.equal(packagedPreview.bytes > 0, true);
    await assert.rejects(
      inspectMacOSApp(output, { requireExternalDistribution: true }),
      { code: "MACOS_UPDATER_CONFIGURATION_INVALID" },
    );
    const plist = JSON.parse(execFileSync("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      join(output, "Contents", "Info.plist"),
    ], { encoding: "utf8" }));
    assert.equal(plist.CFBundleIdentifier, PRODUCT_BRAND.bundleIdentifier);
    assert.equal(
      plist.UsageMonitorPublicWebsiteOrigin,
      DEPLOYMENT_ENDPOINTS.public.origin,
    );
    assert.equal(plist.UsageMonitorBuildChannel, MACOS_PREVIEW_DISTRIBUTION_CHANNEL);
    assert.equal(
      plist.UsageMonitorReleaseChannel,
      MACOS_PREVIEW_DISTRIBUTION_CHANNEL,
    );
    assert.equal(plist.UsageMonitorPreviewDistribution, true);
    assert.equal(plist.UsageMonitorCentralOriginMode, "production_https");
    assert.equal(plist.UsageMonitorUpdaterEnabled, true);
    assert.equal(plist.SUPublicEDKey, publicEdKey);
    assert.equal(plist.SUEnableAutomaticChecks, false);
    assert.equal(plist.SUAllowsAutomaticUpdates, false);
    assert.equal(plist.SUAutomaticallyUpdate, false);
    const updaterSmoke = spawnSync(
      join(output, "Contents", "MacOS", "TiboTattle"),
      ["--updater-contract-smoke-test"],
      { encoding: "utf8" },
    );
    assert.equal(
      updaterSmoke.status,
      0,
      updaterSmoke.stderr || updaterSmoke.stdout,
    );
    assert.match(
      updaterSmoke.stdout,
      /^USAGE_MONITOR_MACOS_UPDATER_CONTRACT runtime=sparkle_2_9_3_enabled state=feed_unverified$/mu,
    );
    const failedFeedSmoke = spawnSync(
      join(output, "Contents", "MacOS", "TiboTattle"),
      ["--updater-feed-contract-smoke-test", "404"],
      { encoding: "utf8" },
    );
    assert.equal(
      failedFeedSmoke.status,
      0,
      failedFeedSmoke.stderr || failedFeedSmoke.stdout,
    );
    assert.match(
      failedFeedSmoke.stdout,
      /^USAGE_MONITOR_MACOS_UPDATER_FEED_CONTRACT status=404 result=failed sparkle_check=false$/mu,
    );
    const reachableFeedSmoke = spawnSync(
      join(output, "Contents", "MacOS", "TiboTattle"),
      ["--updater-feed-contract-smoke-test", "200"],
      { encoding: "utf8" },
    );
    assert.equal(
      reachableFeedSmoke.status,
      0,
      reachableFeedSmoke.stderr || reachableFeedSmoke.stdout,
    );
    assert.match(
      reachableFeedSmoke.stdout,
      /^USAGE_MONITOR_MACOS_UPDATER_FEED_CONTRACT status=200 result=reachable sparkle_check=true$/mu,
    );
    await assert.rejects(
      buildMacOSApp({
        bundleVersion: "42",
        centralOrigin: "https://preview.usage.example",
        output,
        previewDistribution: true,
        previewStagingRoot: dirname(output),
        sparkleAppcastURL: "https://updates.usage.example/appcast.xml",
        sparkleFramework: preparedFramework,
        sparklePublicEdKey: publicEdKey,
      }),
      { code: "MACOS_PREVIEW_REPLACE_REQUIRED" },
    );
    const legacyManifestPath = join(
      output,
      "Contents",
      "Resources",
      "build-manifest.json",
    );
    await chmod(legacyManifestPath, 0o644);
    const legacyManifest = JSON.parse(await readFile(legacyManifestPath, "utf8"));
    delete legacyManifest.release.channelName;
    await writeFile(legacyManifestPath, JSON.stringify(legacyManifest));
    const legacyPlistPath = join(output, "Contents", "Info.plist");
    await chmod(legacyPlistPath, 0o644);
    const legacyPlist = await readFile(legacyPlistPath, "utf8");
    await writeFile(
      legacyPlistPath,
      legacyPlist.replace(
        /  <key>UsageMonitorReleaseChannel<\/key>\n  <string>preview_distribution<\/string>\n/u,
        "",
      ),
    );
    await buildMacOSApp({
      bundleVersion: "42",
      centralOrigin: "https://preview.usage.example",
      output,
      previewDistribution: true,
      previewStagingRoot: dirname(output),
      replacePreviewOutput: true,
      sparkleAppcastURL: "https://updates.usage.example/appcast.xml",
      sparkleFramework: preparedFramework,
      sparklePublicEdKey: publicEdKey,
    });
    assert.deepEqual(await validateMacOSPreviewApp(output), {
      appPath: resolve(output),
      bundleIdentifier: PRODUCT_BRAND.bundleIdentifier,
      bundleVersion: "42",
      channel: MACOS_PREVIEW_DISTRIBUTION_CHANNEL,
      updaterEnabled: true,
    });
    const retired = await readdir(join(dirname(output), "retired"));
    assert.equal(retired.length, 1);
    assert.match(retired[0], /^TiboTattle-legacy-preview-[a-f0-9]{16}\.app$/u);
    const archivedManifest = JSON.parse(await readFile(join(
      dirname(output),
      "retired",
      retired[0],
      "Contents",
      "Resources",
      "build-manifest.json",
    ), "utf8"));
    assert.equal(archivedManifest.release.channelName, undefined);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

macOSArtifactTest("signed app relays central readiness to an explicitly connected loopback lab", {
  skip: BUILD_SUPPORTED ? false : "requires pinned macOS arm64 Node v26.2.0 builder",
  timeout: 60_000,
}, async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-macos-central-test-"),
  );
  const output = join(temporaryRoot, "connected", "TiboTattle.app");
  const smokeHome = join(temporaryRoot, "smoke-home");
  const requests = [];
  const central = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === "GET" && request.url === "/api/ready") {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ status: "ready" }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: "NOT_FOUND" }));
  });
  try {
    await new Promise((resolveListen, rejectListen) => {
      central.once("error", rejectListen);
      central.listen(0, "127.0.0.1", resolveListen);
    });
    const address = central.address();
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const build = spawnSync(process.execPath, [
      BUILD_SCRIPT,
      "--output",
      output,
      "--central-origin",
      origin,
      "--allow-loopback-central-origin",
    ], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);
    assert.match(build.stdout, /^Central service: development_loopback$/mu);
    const manifestPath = join(
      output,
      "Contents",
      "Resources",
      "build-manifest.json",
    );
    const manifestText = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    assert.deepEqual(manifest.runtime.centralService, {
      configured: true,
      mode: "development_loopback",
    });
    assert.equal(manifestText.includes(origin), false);
    const plistJson = JSON.parse(execFileSync("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      join(output, "Contents", "Info.plist"),
    ], { encoding: "utf8" }));
    assert.equal(plistJson.UsageMonitorCentralOrigin, origin);
    assert.equal(
      plistJson.UsageMonitorCentralOriginMode,
      "development_loopback",
    );
    const verification = spawnSync("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      output,
    ], { encoding: "utf8" });
    assert.equal(
      verification.status,
      0,
      verification.stderr || verification.stdout,
    );

    await mkdir(smokeHome, { recursive: true, mode: 0o700 });
    const launcher = join(output, "Contents", "MacOS", "TiboTattle");
    const smoke = await runCaptured(
      launcher,
      ["--central-smoke-test"],
      {
        cwd: temporaryRoot,
        env: {
          HOME: smokeHome,
          LANG: "en_US.UTF-8",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          TMPDIR: tmpdir(),
          USAGE_MONITOR_CENTRAL_ORIGIN: "http://127.0.0.1:1",
        },
      },
    );
    assert.equal(smoke.code, 0, smoke.stderr || smoke.stdout);
    assert.equal(smoke.signal, null);
    assert.match(
      smoke.stdout,
      /^USAGE_MONITOR_MACOS_CENTRAL_SMOKE_READY host=127\.0\.0\.1 port=[0-9]+ central=development_loopback$/mu,
    );
    assert.deepEqual(requests, ["GET /api/ready"]);

    const productionOrigin = "https://usage-monitor.example";
    const productionBuild = spawnSync(process.execPath, [
      BUILD_SCRIPT,
      "--output",
      output,
      "--central-origin",
      productionOrigin,
    ], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(
      productionBuild.status,
      0,
      productionBuild.stderr || productionBuild.stdout,
    );
    assert.match(
      productionBuild.stdout,
      /^Central service: production_https$/mu,
    );
    const productionManifestText = await readFile(manifestPath, "utf8");
    const productionManifest = JSON.parse(productionManifestText);
    assert.deepEqual(productionManifest.runtime.centralService, {
      configured: true,
      mode: "production_https",
    });
    assert.equal(productionManifestText.includes(productionOrigin), false);
    const productionPlist = JSON.parse(execFileSync("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      join(output, "Contents", "Info.plist"),
    ], { encoding: "utf8" }));
    assert.equal(
      productionPlist.UsageMonitorCentralOrigin,
      productionOrigin,
    );
    assert.equal(
      productionPlist.UsageMonitorCentralOriginMode,
      "production_https",
    );
    const productionVerification = spawnSync("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      output,
    ], { encoding: "utf8" });
    assert.equal(
      productionVerification.status,
      0,
      productionVerification.stderr || productionVerification.stdout,
    );
  } finally {
    await new Promise((resolveClose) => central.close(() => resolveClose()));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("build script itself does not admit private output trees", async () => {
  const source = await readFile(BUILD_SCRIPT, "utf8");
  assert.match(source, /ALLOWED_GENERATED_RUNTIME_FILES/u);
  assert.match(source, /generatedTreeIncluded: false/u);
  assert.match(source, /credentialsIncluded: false/u);
  assert.match(source, /localReportsIncluded: false/u);
  assert.match(source, /localStateIncluded: false/u);
  assert.match(source, /loginItemAdded: false/u);
  assert.match(source, /backgroundUploadAdded: false/u);
  assert.match(source, /externalDistributionRequested/u);
  assert.match(source, /previewDistributionRequested/u);
  assert.match(source, /MACOS_PREVIEW_DISTRIBUTION_CHANNEL/u);
  assert.match(source, /UsageMonitorBuildChannel/u);
  assert.match(source, /UsageMonitorReleaseChannel/u);
  assert.match(source, /channelName/u);
  assert.match(source, /MACOS_PREVIEW_OUTPUT_FORBIDDEN/u);
  assert.match(source, /--preview-distribution/u);
  assert.match(source, /--validate-preview/u);
  assert.match(source, /COPYFILE_FICLONE/u);
  assert.match(source, /MACOS_BUILD_PROFILE_TEST/u);
  assert.match(source, /\["-Onone"\]/u);
  assert.match(source, /\["-O", "-whole-module-optimization"\]/u);
  assert.match(source, /MACOS_ICON_ASSET_REQUIRED/u);
  assert.match(source, /CFBundleURLSchemes/u);
  assert.match(source, /PRODUCT_BRAND\.appOpenScheme/u);
  assert.match(source, /PRODUCT_BRAND\.appOpenHost/u);
  assert.match(source, /PRODUCT_BRAND\.appOpenURL/u);
  assert.match(source, /const CODESIGN_PATH = "\/usr\/bin\/codesign"/u);
  assert.match(source, /result\.error\.code === "ENOENT"/u);
  assert.match(source, /is unavailable at \$\{command\}/u);
  assert.match(
    source,
    /"--verify",\s*"--deep",\s*"--strict"/u,
  );
  assert.doesNotMatch(source, /cp\s+-R|copy.*REPOSITORY_ROOT.*resources/iu);
  assert.equal(await realpath(REPOSITORY_ROOT), REPOSITORY_ROOT);
});

// csf_efb42178: pinnedPackage() previously authenticated external packages only
// by name and version, both attacker-retainable, then copied those installed
// bytes into the signed app. It now also verifies a reviewed deterministic
// file-tree digest of the installed package, rejecting tampered bytes before
// any copy or signing.
test("pinnedPackage authenticates external packages by reviewed file-tree digest, not just name and version", async (t) => {
  const rootRequire = createRequire(join(REPOSITORY_ROOT, "package.json"));

  // The real installed package passes and its digest is recorded for provenance.
  const realPackageJson = rootRequire.resolve("ajv/package.json");
  const accepted = await pinnedPackage("ajv", realPackageJson);
  assert.equal(accepted.name, "ajv");
  assert.equal(accepted.version, "8.20.0");
  assert.match(accepted.treeDigest, /^[0-9a-f]{64}$/u);
  // The recorded digest is exactly the reviewed pin and reproduces on a second
  // read, so it is a stable provenance value.
  assert.equal(
    accepted.treeDigest,
    await pinnedPackageTreeDigest(dirname(realPackageJson)),
  );

  // A tampered package that keeps the pinned name and version but changes its
  // bytes is rejected before copying — the version-only check would have
  // accepted it.
  const tamperedRoot = await mkdtemp(
    join(tmpdir(), "usage-monitor-pinned-package-"),
  );
  t.after(() => rm(tamperedRoot, { recursive: true, force: true }));
  await writeFile(
    join(tamperedRoot, "package.json"),
    `${JSON.stringify({ name: "ajv", version: "8.20.0" }, null, 2)}\n`,
  );
  await writeFile(
    join(tamperedRoot, "index.js"),
    "module.exports = function () { /* poisoned */ return true; };\n",
  );
  await assert.rejects(
    pinnedPackage("ajv", join(tamperedRoot, "package.json")),
    /tree digest mismatch/u,
  );

  // The digest is sensitive to any content change under the tree.
  const before = await pinnedPackageTreeDigest(tamperedRoot);
  await writeFile(join(tamperedRoot, "index.js"), "module.exports = 1;\n");
  const after = await pinnedPackageTreeDigest(tamperedRoot);
  assert.notEqual(before, after);
});
