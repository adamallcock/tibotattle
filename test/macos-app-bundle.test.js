import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
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
import {
  MACOS_RUNTIME_ASSETS,
  buildMacOSApp,
  collectMacOSRuntimeGraph,
  normalizeMacOSBundleVersion,
  normalizeMacOSCentralOrigin,
  validateMacOSDistributionConfiguration,
} from "../scripts/build-macos-app.js";
import {
  compareMacOSBundleVersions,
  createMacOSSignedReplacementContract,
  developerIDSignMacOSApp,
  inspectMacOSApp,
  packageMacOSDMG,
  readMacOSReleaseBuildConfiguration,
  readMacOSReleaseCredentials,
  submitToAppleNotary,
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
    displayName: "Usage Monitor",
    bundleName: "Usage Monitor.app",
    executableName: "UsageMonitor",
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
  "Contents/MacOS/UsageMonitor",
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
  const source = await readFile(SWIFT_SOURCE, "utf8");
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
  assert.match(source, /title: "Data & Diagnostics…"/u);
  assert.match(source, /title: "Codex Source…"/u);
  assert.match(source, /title: "Version & Updates…"/u);
  assert.match(
    source,
    /title: "Open \\\(BundledProduct\.monitoredAppDisplayName\)"/u,
  );
  assert.match(
    source,
    /withBundleIdentifier: BundledProduct\.monitoredAppBundleIdentifier/u,
  );
  assert.match(source, /https:\/\/learn\.chatgpt\.com\/docs\/app/u);
  assert.match(source, /Copy Diagnostics/u);
  assert.match(source, /usage-monitor-macos-diagnostics-v1/u);
  assert.match(source, /UM_MACOS_COMPANION_START_TIMEOUT/u);
  assert.match(source, /companionStartupTimeoutSeconds/u);
  assert.match(source, /NSOpenPanel/u);
  assert.match(source, /launcher-settings-v1\.json/u);
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
  assert.match(source, /AppOpenLink\.accepts/u);
  assert.match(source, /--app-link-smoke-test/u);
  assert.match(
    source,
    /No Codex metadata is scanned until you open the dashboard and ask/iu,
  );
  assert.match(
    source,
    /Welcome to \\\(BundledProduct\.displayName\)/u,
  );
  assert.match(source, /addButton\(withTitle: "Get Started"\)/u);
  assert.match(source, /first-run-v1\.json/u);
  assert.match(source, /usage-monitor-first-run-v1/u);
  assert.match(source, /Community contribution is optional/iu);
  assert.match(source, /six-hour while-open contribution schedule/iu);
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
  assert.match(source, /updater\.automaticallyDownloadsUpdates = enabled/u);
  assert.match(source, /withTitle: "Automatic Updates…"/u);
  assert.match(source, /Turn On Automatic Updates/u);
  assert.match(source, /Turn Off Automatic Updates/u);
  assert.match(source, /install them when you quit the app/iu);
  assert.match(source, /This development build contains no updater framework/iu);
  assert.match(source, /move \\\(BundledProduct\.bundleName\) to Trash/iu);
  assert.match(source, /explicit bounded scan/iu);
  assert.match(source, /Large histories may need several passes/iu);
  assert.match(source, /Nothing leaves this Mac/iu);
  assert.match(source, /title: "Quit"/u);
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
      externalDistribution: true,
      productionOriginValidated: true,
    },
  );
  assert.throws(
    () => validateMacOSDistributionConfiguration({
      centralService: normalizeMacOSCentralOrigin(null),
      externalDistribution: true,
    }),
    { code: "MACOS_PRODUCTION_ORIGIN_REQUIRED" },
  );
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
      USAGE_MONITOR_PRODUCTION_ORIGIN: "https://usage.example",
      USAGE_MONITOR_SPARKLE_APPCAST_URL:
        "https://usage.example/appcast.xml",
      USAGE_MONITOR_SPARKLE_FRAMEWORK: "/tmp/Sparkle.framework",
      USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY:
        Buffer.alloc(32, 1).toString("base64"),
    }),
    {
      bundleVersion: "42.7",
      productionOrigin: "https://usage.example",
      sparkleAppcastURL: "https://usage.example/appcast.xml",
      sparkleFramework: "/tmp/Sparkle.framework",
      sparklePublicEdKey: Buffer.alloc(32, 1).toString("base64"),
    },
  );
  assert.throws(
    () => readMacOSReleaseBuildConfiguration({
      USAGE_MONITOR_BUNDLE_VERSION: "42.7",
      USAGE_MONITOR_PRODUCTION_ORIGIN: "http://usage.example",
      USAGE_MONITOR_SPARKLE_APPCAST_URL:
        "https://usage.example/appcast.xml",
      USAGE_MONITOR_SPARKLE_FRAMEWORK: "/tmp/Sparkle.framework",
      USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY:
        Buffer.alloc(32, 1).toString("base64"),
    }),
    { code: "MACOS_RELEASE_FAILED" },
  );
  assert.throws(
    () => readMacOSReleaseBuildConfiguration({
      USAGE_MONITOR_BUNDLE_VERSION: "candidate",
      USAGE_MONITOR_PRODUCTION_ORIGIN: "https://usage.example",
      USAGE_MONITOR_SPARKLE_APPCAST_URL:
        "https://usage.example/appcast.xml",
      USAGE_MONITOR_SPARKLE_FRAMEWORK: "/tmp/Sparkle.framework",
      USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY:
        Buffer.alloc(32, 1).toString("base64"),
    }),
    { code: "MACOS_BUNDLE_VERSION_REQUIRED" },
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
    automaticUpdatesEnabledByDefault: false,
    afterUserOptIn: {
      automaticDownload: true,
      installOnQuit: true,
    },
    installProcedure:
      "sparkle_user_choice_or_opted_in_install_on_quit_or_manual_dmg_replacement",
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
      shortVersion: "0.0.1",
    },
    artifact: {
      bytes: bytes.length,
      fileName,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    assurances: { ...assurances },
    updater: {
      appcastURL: "https://usage.example/appcast.xml",
      automaticChecks: true,
      automaticUpdateOptInAvailable: true,
      automaticUpdatesEnabledByDefault: false,
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
            automaticUpdatesEnabledByDefault: true,
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

test("Developer ID and notary hooks are inside-out, hardened, and credential-minimized", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-signing-hook-test-"),
  );
  const app = join(temporaryRoot, "Usage Monitor.app");
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
      "Contents/MacOS/UsageMonitor",
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
        CFBundleExecutable: "UsageMonitor",
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
        SUAutomaticallyUpdate: false,
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
            automaticUpdatesEnabledByDefault: false,
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
    assert.match(signing[7].arguments_.at(-1), /MacOS\/UsageMonitor$/u);
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
  const graph = await collectMacOSRuntimeGraph();
  assert.equal(graph.relativeFiles[0], "apps/local/server.js");
  assert.deepEqual(graph.externalSpecifiers, [
    "@github/keytar",
    "ajv",
    "runcost/browser",
  ]);
  assert.equal(graph.builtins.includes("node:http"), true);
  assert.equal(graph.builtins.includes("node:sqlite"), true);
  assert.equal(graph.relativeFiles.includes("src/local-installation-diagnostics.js"), true);
  assert.equal(
    MACOS_RUNTIME_ASSETS.includes("apps/macos/reset-local-keychain.js"),
    true,
  );
  assert.deepEqual(
    graph.relativeFiles.filter((path) => path.startsWith("generated/")),
    [
      "generated/telemetry-v0.1-compatibility.json",
      "generated/telemetry-v0.1-field-dictionary.json",
    ],
  );
  for (const path of [
    ...graph.relativeFiles,
    ...MACOS_RUNTIME_ASSETS,
  ]) {
    assert.doesNotMatch(
      path,
      /(?:^|\/)(?:\.git|\.usage-monitor|local-review|reports?|test)(?:\/|$)/u,
    );
  }
  assert.equal(graph.relativeFiles.some((path) => path.includes("r7-")), false);
  assert.equal(graph.relativeFiles.some((path) => path.includes("ccusage")), false);
});

test("reproducible ad-hoc-signed app passes orderly and launcher-SIGKILL watchdog smokes", {
  skip: BUILD_SUPPORTED ? false : "requires pinned macOS arm64 Node v26.2.0 builder",
  timeout: 60_000,
}, async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-macos-test-"),
  );
  const outputA = join(temporaryRoot, "a", "Usage Monitor.app");
  const outputB = join(temporaryRoot, "b", "Usage Monitor.app");
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
      externalDistributionRequested: false,
      iconIncluded: false,
      iconSha256: null,
      productionOriginValidated: false,
      provenanceSha256: null,
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
      path: "Contents/MacOS/UsageMonitor",
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
        { name: "@github/keytar", version: "7.10.6" },
        { name: "ajv", version: "8.20.0" },
        { name: "fast-deep-equal", version: "3.1.3" },
        { name: "fast-uri", version: "3.1.4" },
        { name: "json-schema-traverse", version: "1.0.0" },
        { name: "require-from-string", version: "2.0.2" },
        { name: "runcost", version: "0.2.0" },
      ],
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
      bundleFiles.some(({ relativePath }) =>
        relativePath.startsWith("Contents/Frameworks/")),
      false,
    );
    const updaterSmoke = spawnSync(
      join(outputA, "Contents", "MacOS", "UsageMonitor"),
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
    const generatedFiles = bundleFiles
      .map(({ relativePath }) => relativePath)
      .filter((path) => path.includes("/app/generated/"));
    assert.deepEqual(generatedFiles, [
      "Contents/Resources/app/generated/telemetry-v0.1-compatibility.json",
      "Contents/Resources/app/generated/telemetry-v0.1-field-dictionary.json",
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
    const launcher = join(outputA, "Contents", "MacOS", "UsageMonitor");
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
      "Contents/MacOS/UsageMonitor",
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
    assert.equal(plistJson.CFBundleExecutable, "UsageMonitor");
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
    assert.equal(Object.hasOwn(plistJson, "CFBundleIconFile"), false);
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
      "usagemonitor://open#fragment",
      "usagemonitor://other",
      "https://open",
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
        shortVersion: "0.0.1",
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

test("signed app relays central readiness to an explicitly connected loopback lab", {
  skip: BUILD_SUPPORTED ? false : "requires pinned macOS arm64 Node v26.2.0 builder",
  timeout: 60_000,
}, async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-macos-central-test-"),
  );
  const output = join(temporaryRoot, "connected", "Usage Monitor.app");
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
    const launcher = join(output, "Contents", "MacOS", "UsageMonitor");
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
