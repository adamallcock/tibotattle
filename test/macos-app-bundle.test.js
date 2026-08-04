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
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PRODUCT_BRAND,
  validateStateDirectoryName,
} from "../config/product-brand.js";
import { DEPLOYMENT_ENDPOINTS } from "../config/deployment-endpoints.js";
import {
  MACOS_RUNTIME_STATIC_ASSETS,
  MACOS_ACCOUNTING_RUNTIME_FILES,
  MACOS_IDENTITY_CORE_RUNTIME_FILES,
  MACOS_PREVIEW_DISTRIBUTION_CHANNEL,
  MACOS_TELEMETRY_CONTRACT_RUNTIME_FILES,
  MACOS_WEB_MODULE_ENTRYPOINTS,
  buildMacOSApp,
  collectMacOSLocalizationResources,
  collectMacOSRuntimeGraph,
  collectMacOSSwiftSources,
  collectMacOSWebModuleGraph,
  collectVerifiedMacOSWebModuleGraph,
  captureMacOSWorkspaceRuntimePackages,
  calculateMacOSSourceInputDigest,
  assertMacOSWebModuleInventory,
  assertMacOSWorkspaceRuntimePackageInventory,
  normalizeMacOSBundleVersion,
  normalizeMacOSCentralOrigin,
  parseMacOSBuildArguments,
  stageMacOSWebModules,
  stageMacOSWorkspaceRuntimePackages,
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
  developerIDSignMacOSApp,
  inspectMacOSApp,
  packageMacOSDMG,
  readMacOSReleaseSourceProvenance,
  readMacOSReleaseBuildConfiguration,
  readMacOSReleaseCredentials,
  submitToAppleNotary,
  validateNodeRuntimeEntitlements,
  validateMacOSSignedReplacementArtifacts,
  validateMacOSSignedReplacementPair,
  validateMacOSApplicationsLink,
  validateMacOSDMG,
} from "../scripts/macos-release-core.js";
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
const BUILD_SUPPORTED =
  process.platform === "darwin"
  && process.arch === "arm64"
  && process.version === "v26.2.0";

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
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`child timed out: ${stderr || stdout}`));
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
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

test("native launcher keeps the requested foreground-only lifecycle", async () => {
  const [source, semanticOpenTargetSource, menuBarStatusSource] = await Promise.all([
    readFile(SWIFT_SOURCE, "utf8"),
    readFile(SEMANTIC_OPEN_TARGET_SOURCE, "utf8"),
    readFile(MENU_BAR_STATUS_SOURCE, "utf8"),
  ]);
  const firstRunDisclosureSource = source.slice(
    source.indexOf("private func showFirstRunDisclosure"),
    source.indexOf("private func startCompanion"),
  );
  assert.match(source, /import AppKit/u);
  assert.match(source, /"USAGE_MONITOR_PORT": "0"/u);
  assert.match(source, /"USAGE_MONITOR_RESOURCE_ROOT"/u);
  assert.match(source, /"USAGE_MONITOR_STATE_ROOT"/u);
  assert.match(source, /"CODEX_HOME": codexHome\.path/u);
  assert.match(source, /"USAGE_MONITOR_CENTRAL_ORIGIN"/u);
  assert.match(source, /UsageMonitorCentralOriginMode/u);
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
  assert.match(source, /title: "Open Dashboard"/u);
  assert.match(source, /title: "Retry"/u);
  assert.match(source, /title: "Settings…"/u);
  assert.match(source, /title: "Data & Diagnostics…"/u);
  assert.match(source, /title: "Codex Folder…"/u);
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
  assert.match(source, /Copy Diagnostics/u);
  assert.match(source, /usage-monitor-macos-diagnostics-v1/u);
  assert.match(source, /UM_MACOS_COMPANION_START_TIMEOUT/u);
  assert.match(source, /companionStartupTimeoutSeconds/u);
  assert.match(source, /NSOpenPanel/u);
  assert.match(source, /launcher-settings-v1\.json/u);
  assert.match(source, /Default location \(~\/\.codex\)/u);
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
  assert.match(source, /--confirm-local-keychain-reset/u);
  assert.match(source, /Reset exactly two local Keychain capabilities now/iu);
  assert.match(source, /Hosted service: no registered device is revoked/iu);
  assert.match(source, /Secure erasure is not claimed/iu);
  assert.match(source, /Move Data to Trash/u);
  assert.match(
    source,
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
    /init\(semanticOpenTarget: SemanticOpenTarget\)[\s\S]*self\.semanticOpenTarget = semanticOpenTarget/u,
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
    /updates local \\\(BundledProduct\.monitoredAppDisplayName\) metadata while the app is open/iu,
  );
  assert.match(
    source,
    /Welcome to \\\(BundledProduct\.displayName\)/u,
  );
  assert.match(source, /addButton\(withTitle: "Get Started"\)/u);
  assert.match(source, /first-run-v1\.json/u);
  assert.match(source, /usage-monitor-first-run-v1/u);
  assert.match(source, /Community contribution is optional/iu);
  assert.match(source, /Community contribution is optional/iu);
  assert.doesNotMatch(source, /six-hour while-open contribution schedule/iu);
  assert.match(source, /Keep the app open while analysis runs/iu);
  assert.match(
    source,
    /guard !quitting, retryAllowed, firstRunAcknowledged,[\s\S]*let codexHomeConfiguration/u,
  );
  assert.match(
    source,
    /guard !quitting, retryAllowed, firstRunAcknowledged else \{ return \}/u,
  );
  assert.match(
    source,
    /retryButton\.isEnabled = retryAllowed && firstRunAcknowledged/u,
  );
  assert.match(source, /SPUStandardUpdaterController/u);
  assert.match(source, /startingUpdater:\s*false/u);
  assert.doesNotMatch(source, /startingUpdater:\s*true/u);
  assert.match(
    source,
    /firstRunAcknowledged = true[\s\S]*updater\.startAfterFirstRunDisclosure\(\)/u,
  );
  assert.match(
    source,
    /var firstRunUpdatesDisclosure: String[\s\S]*guard isAvailable else[\s\S]*development build does not include update checks/u,
  );
  assert.match(
    source,
    /if Self\.isPreviewDistribution[\s\S]*manual signed-update checks[\s\S]*does not check, download, or install updates automatically/u,
  );
  assert.match(
    source,
    /allowsAutomaticUpdateOptIn && automaticUpdatesEnabled[\s\S]*Signed app updates are checked automatically[\s\S]*Settings → General/u,
  );
  assert.equal(
    firstRunDisclosureSource.includes("\\(updater.firstRunUpdatesDisclosure)"),
    true,
  );
  assert.doesNotMatch(
    firstRunDisclosureSource,
    /Signed app updates are checked automatically/u,
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
  assert.match(source, /NSApp\.applicationIconImage/u);
  assert.doesNotMatch(source, /showAutomaticUpdateOptions/u);
  assert.doesNotMatch(source, /showLifecycleHelp/u);
  assert.match(source, /Updating local usage while the app is open/iu);
  assert.match(source, /Large histories may need several passes/iu);
  assert.match(source, /Nothing leaves this Mac/iu);
  assert.match(source, /private final class NativeDashboardChrome/u);
  assert.match(source, /private final class NativeDashboardReportPane/u);
  assert.match(source, /NSSplitView\(\)/u);
  assert.match(
    source,
    /reportPane = NativeDashboardReportPane\(webView: webView\)/u,
  );
  assert.match(source, /webView\.autoresizingMask = \[\.width, \.height\]/u);
  assert.match(source, /override func layout\(\) \{[\s\S]*?fitWebViewToBounds\(\)/u);
  assert.match(source, /webView\.frame = frame/u);
  assert.match(source, /private func loadWhenViewportIsReady\(\)/u);
  assert.match(source, /viewport\.width >= 120, viewport\.height >= 120/u);
  assert.match(source, /nativeDashboardChrome\?\.prepareReportViewport\(\)/u);
  assert.match(source, /document\.querySelector\('#main'\)\?\.innerText/u);
  assert.match(source, /split\.addArrangedSubview\(reportPane\)/u);
  assert.doesNotMatch(source, /split\.addArrangedSubview\(webView\)/u);
  assert.match(source, /configureBadge\(modeButton, symbol: "lock\.fill"\)/u);
  assert.match(source, /refreshLocalUsage\(automatic: true\)/u);
  assert.match(source, /nativeRefreshIntervalSeconds = 300/u);
  assert.match(source, /private func scheduleNativeRefresh\(\)/u);
  assert.match(source, /LocalCompanionEvidenceReader/u);
  assert.match(source, /LaunchAgent, or daemon/iu);
  assert.match(source, /title: "Quit"/u);
  assert.match(source, /title: "Settings…"[\s\S]*keyEquivalent: ","/u);
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
  assert.match(menuBarStatusSource, /NSApp\.applicationIconImage/u);
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
    2,
    "only isolated AppKit smoke modes may use accessory activation",
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
    "ServiceManagement",
    "SMAppService",
    "SMLoginItemSetEnabled",
    "URLSessionConfiguration.background",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
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
  assert.match(source, /configuration\.websiteDataStore = \.nonPersistent\(\)/u);
  assert.match(source, /WKUserScript\([\s\S]*injectionTime: \.atDocumentStart/u);
  assert.match(source, /document\.documentElement\.classList\.add\('native-dashboard'\)/u);
  assert.match(
    source,
    /func notifyHostedSignInReturn\(\) \{[\s\S]*?window\.dispatchEvent\(new Event\('tibotattle:hosted-sign-in-return'\)\)/u,
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
    "WKWebsiteDataStore.default()",
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
  assert.match(source, /title: "Open in Browser"/u);
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
  assert.match(source, /NSApp\.applicationIconImage/u);
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
  assert.match(source, /"Settings…"/u);
  assert.match(source, /configure\(aboutItem,/u);
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
  assert.match(source, /No verified Codex allowance observed yet/u);
  assert.match(source, /Allowance values and reset countdowns are hidden/u);
  assert.match(source, /func resetCountdown\(_ date: Date\?, now: Date = Date\(\)\) -> String\?/u);
  assert.match(source, /guard companionReachable, evidence == \.live else/u);

  // Only the normal Codex allowance track is projected with fixed
  // privacy-safe labels; a separate product can never become the title.
  assert.match(source, /private let weeklyWindowDurationMinutes = 10_080/u);
  assert.match(source, /private let codexPrimaryLimitId = "codex"/u);
  assert.match(source, /private let supportedCodexAllowanceWindowDurations: Set<Int>/u);
  assert.match(source, /let lanes = rows\.compactMap/u);
  assert.match(source, /guard Self\.isSupportedCodexAllowance\(/u);
  assert.match(source, /return "Five-hour allowance"/u);
  assert.match(source, /return "Seven-day allowance"/u);
  assert.match(source, /isPrimary: duration == weeklyWindowDurationMinutes/u);
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
  assert.match(source, /"Open \\\(productName\)"/u);
  assert.match(source, /openTiboTattleItem\.isEnabled = true/u);
  assert.match(source, /"Analyze Local Usage"/u);
  assert.match(source, /"Retry Local Analysis"/u);
  assert.match(source, /"Update Local Usage"/u);
  assert.match(source, /"Analyzing Local Usage…"/u);
  assert.match(source, /"Quit \\\(productName\)"/u);
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

test("targeted local Keychain reset removes only exact local capabilities and residue", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-keychain-reset-test-"),
  );
  const stateRoot = join(temporaryRoot, "state");
  const retained = join(stateRoot, "retained-cache.json");
  const deviceState = join(
    stateRoot,
    "contribution-device-binding-v1.json",
  );
  const exportResidue = join(stateRoot, "export-participant-secret");
  const stored = new Map([
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
  try {
    await mkdir(stateRoot, { mode: 0o700 });
    await writeFile(deviceState, "{}\n", { mode: 0o600 });
    await writeFile(exportResidue, `${"A".repeat(43)}\n`, {
      mode: 0o600,
    });
    await writeFile(retained, "{\"retained\":true}\n", { mode: 0o600 });

    const result = await resetLocalKeychainIdentityAndDevice({
      backend,
      stateRoot,
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
    assert.deepEqual(
      calls.filter(([method]) => method === "deleteExact"),
      [
        ["deleteExact", "app-usagemonitor.contribution-device.v1"],
        ["deleteExact", "app-usagemonitor.export-identity.v1"],
      ],
    );
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
      resetLocalKeychainIdentityAndDevice({ backend, stateRoot }),
      { code: "UM_MACOS_KEYCHAIN_RESET_STATE_UNSAFE" },
    );
    assert.equal(await readFile(unsafeTarget, "utf8"), "outside");
  } finally {
    for (const secret of stored.values()) secret.fill(0);
    for (const secret of partialStored.values()) secret.fill(0);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
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
  const production = normalizeMacOSCentralOrigin("https://usage.example");
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
    "runMacOSReleaseCommand(process.execPath",
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

test("preview CLI inputs are opt-in and development parsing ignores preview environment", () => {
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
  const defaultPreview = parseMacOSBuildArguments([
    "--preview-distribution",
  ], {});
  assert.equal(defaultPreview.centralOrigin, "https://tibotattle.com");
  assert.equal(
    defaultPreview.sparkleAppcastURL,
    "https://updates.tibotattle.com/appcast.xml",
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
  const releaseManifest = (bundleVersion, fileName, bytes) => ({
    schemaVersion: "usage-monitor-macos-release-v0.2",
    application: {
      bundleIdentifier: "com.usagemonitor.local",
      bundleVersion,
      shortVersion: "0.1.0",
    },
    artifact: {
      bytes: bytes.length,
      fileName,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    source: {
      commit: "a".repeat(40),
      tag: "v0.1.0",
    },
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
      publicEdKeySha256: createHash("sha256")
        .update(Buffer.alloc(32, 1))
        .digest("hex"),
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
  try {
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
    execFileSync("/usr/bin/git", ["tag", "-a", "v0.1.0", "-m", "release"], {
      cwd: temporaryRoot,
    });
    const provenance = readMacOSReleaseSourceProvenance({
      repositoryRoot: temporaryRoot,
    });
    assert.match(provenance.commit, /^[0-9a-f]{40}$/u);
    assert.equal(provenance.tag, "v0.1.0");

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
      "arm64-apple-macos13.0",
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
        UsageMonitorCentralOrigin: "https://usage.example",
        UsageMonitorCentralOriginMode: "production_https",
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
        SUFeedURL: "https://usage.example/appcast.xml",
        SUPublicEDKey: Buffer.alloc(32, 1).toString("base64"),
        SURequireSignedFeed: true,
        SUVerifyUpdateBeforeExtraction: true,
      }),
    );
    const payload = await testPayloadInventory(app, temporaryRoot);
    await writeFile(
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
            appcastURL: "https://usage.example/appcast.xml",
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
        payload,
      }),
    );

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
  const [graph, webModules, swiftSources] = await Promise.all([
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
    "@app-usagemonitor/telemetry-contract",
    "@github/keytar",
    "ajv",
    "runcost/browser",
  ]);
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
    "apps/web/public/community-view.js",
    "apps/web/public/data-client.js",
    "apps/web/public/install-cta.js",
    "apps/web/public/lib.js",
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
    "apps/macos/Sources/Localization.swift",
    "apps/macos/Sources/MenuBarStatus.swift",
    "apps/macos/Sources/QuotaNotifications.swift",
    "apps/macos/Sources/SemanticOpenTarget.swift",
    "apps/macos/UsageMonitorApp.swift",
  ]);
  const localizationResources = await collectMacOSLocalizationResources();
  assert.deepEqual(localizationResources.relativeFiles, [
    "en.lproj/Localizable.strings",
    "localization/manifest.json",
  ]);
  assert.deepEqual(runtimeAssets, [
    "apps/macos/reset-local-keychain.js",
    "apps/web/public/app.js",
    "apps/web/public/community-view.js",
    "apps/web/public/data-client.js",
    "apps/web/public/index.html",
    "apps/web/public/install-cta.js",
    "apps/web/public/lib.js",
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
      version: "0.1.0",
    },
    {
      inputDirectory: "packages/identity-core",
      name: "@app-usagemonitor/identity-core",
      root: join(temporaryRoot, "packages", "identity-core"),
      runtimeFiles: MACOS_IDENTITY_CORE_RUNTIME_FILES,
      version: "0.1.0",
    },
    {
      inputDirectory: "packages/telemetry-contract",
      name: "@app-usagemonitor/telemetry-contract",
      root: join(temporaryRoot, "packages", "telemetry-contract"),
      runtimeFiles: MACOS_TELEMETRY_CONTRACT_RUNTIME_FILES,
      version: "0.1.0",
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
    assert.equal(captures.length, 3);
    assert.equal(
      captures.reduce((total, capture) => total + capture.files.length, 0),
      MACOS_ACCOUNTING_RUNTIME_FILES.length
        + MACOS_IDENTITY_CORE_RUNTIME_FILES.length
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
    assert.equal(stagedRows.length, 18);
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
      version: "0.1.0",
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

test("reproducible ad-hoc-signed app passes orderly and launcher-SIGKILL watchdog smokes", {
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
    const first = await buildMacOSApp({ output: outputA });
    const second = await buildMacOSApp({ output: outputB });
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
          version: "0.1.0",
        },
        {
          name: "@app-usagemonitor/identity-core",
          version: "0.1.0",
        },
        {
          name: "@app-usagemonitor/telemetry-contract",
          version: "0.1.0",
        },
        { name: "@github/keytar", version: "7.10.6" },
        { name: "ajv", version: "8.20.0" },
        { name: "fast-deep-equal", version: "3.1.3" },
        { name: "fast-uri", version: "3.1.4" },
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
      "Contents/Resources/localization/manifest.json",
      "Contents/Resources/app/localization/en.lproj/Localizable.strings",
      "Contents/Resources/app/localization/manifest.json",
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
      /runtime=development_disabled/u,
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
      /^USAGE_MONITOR_MACOS_MENU_BAR_CONTRACT native_rows=true titles=true states=starting,unavailable shortcuts=cmd-r,cmd-comma,cmd-q dismissal=native,escape,same-app,deactivation$/mu,
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
      /^USAGE_MONITOR_MACOS_QUOTA_NOTIFICATION_CONTRACT opt_in=true fresh_only=true first_sample=false threshold=true reset_schedule_suppressed=true reset_identity_gate=true dedupe=true opt_out=true$/mu,
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
    assert.equal(plistJson.CFBundleIconFile, "AppIcon");
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
    assert.match(diagnostics.stdout, /^paths_included: false$/mu);
    assert.match(diagnostics.stdout, /^identifiers_included: false$/mu);
    assert.match(diagnostics.stdout, /^content_included: false$/mu);
    assert.equal(diagnostics.stdout.includes("/Users/"), false);

    const settingsHome = join(temporaryRoot, "settings-home");
    const settingsRoot = join(
      settingsHome,
      "Library",
      "Application Support",
      "Usage Monitor",
    );
    const customCodexHome = join(temporaryRoot, "custom-codex-home");
    await mkdir(settingsHome, { mode: 0o700 });
    await mkdir(customCodexHome, { mode: 0o700 });
    await mkdir(join(customCodexHome, "sessions"), { mode: 0o700 });
    const settingsSmoke = spawnSync(launcher, [
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
      settingsSmoke.status,
      0,
      settingsSmoke.stderr || settingsSmoke.stdout,
    );
    assert.equal(
      settingsSmoke.stdout,
      "USAGE_MONITOR_MACOS_CODEX_HOME_READY mode=custom persisted=true path_exposed=false\n",
    );
    const settingsFile = join(
      settingsRoot,
      "launcher-settings-v1.json",
    );
    assert.deepEqual(
      JSON.parse(await readFile(settingsFile, "utf8")),
      {
        codexHome: customCodexHome,
        schemaVersion: "usage-monitor-launcher-settings-v1",
      },
    );
    assert.equal((await stat(settingsFile)).mode & 0o777, 0o600);

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
      "UsageMonitor-0.0.1-macOS-arm64.dmg",
    );
    const packaged = await packageMacOSDMG({
      appPath: outputA,
      output: dmg,
    });
    assert.equal(packaged.output, dmg);
    assert.match(packaged.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(packaged.bytes > 0, true);
    assert.deepEqual(
      await validateMacOSDMG(dmg, { production: false }),
      {
        bundleIdentifier: "com.usagemonitor.local",
        production: false,
        shortVersion: "0.1.0",
      },
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

test("preview distribution builds retain the normal identity and reject production validation", {
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
    assert.equal(plist.UsageMonitorBuildChannel, MACOS_PREVIEW_DISTRIBUTION_CHANNEL);
    assert.equal(plist.UsageMonitorPreviewDistribution, true);
    assert.equal(plist.UsageMonitorCentralOriginMode, "production_https");
    assert.equal(plist.UsageMonitorUpdaterEnabled, true);
    assert.equal(plist.SUPublicEDKey, publicEdKey);
    assert.equal(plist.SUEnableAutomaticChecks, false);
    assert.equal(plist.SUAllowsAutomaticUpdates, false);
    assert.equal(plist.SUAutomaticallyUpdate, false);
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
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("signed app relays central readiness to an explicitly connected loopback lab", {
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
  assert.match(source, /MACOS_PREVIEW_OUTPUT_FORBIDDEN/u);
  assert.match(source, /--preview-distribution/u);
  assert.match(source, /--validate-preview/u);
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
