import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createProductionDistributionMetadata } from "../apps/electron/desktop-updater.js";
import { buildElectronApp } from "../scripts/build-electron-app.mjs";
import {
  ELECTRON_SHELL_RUNTIME_FILES,
  ELECTRON_UPDATER_RUNTIME_PACKAGE_PINS,
  assertStagedElectronShellModuleLinkage,
} from "../scripts/build-electron-runtime.mjs";
import {
  parseProductionCandidateArguments,
  productionElectronCandidatePlan,
} from "../scripts/package-electron-production.mjs";
import { RELEASE_VERSION } from "../config/release-manifest.js";

const require = createRequire(import.meta.url);
const POLICY = require("../config/electron-production-distribution.cjs");
const ELECTRON_BUILDER_REQUIRE = createRequire(require.resolve("electron-builder/package.json"));
const { AppInfo } = ELECTRON_BUILDER_REQUIRE("app-builder-lib/out/appInfo");
const semver = ELECTRON_BUILDER_REQUIRE("semver");
const BUILDER_CONFIG_PATH = resolve("apps/electron/electron-builder.production.config.cjs");
const DEVELOPMENT_BUILDER_CONFIG_PATH = resolve("apps/electron/electron-builder.config.cjs");
const PRODUCTION_SOURCE_WORKFLOW_PATH = resolve(
  ".github/workflows/electron-production-source-preparation.yml",
);
const SOURCE_REVISION = "a".repeat(40);
const BUILD_NUMBER = "20260906";
const REHEARSAL_CURRENT_VERSION = "0.1.19-native-to-electron-handover.1";
const REHEARSAL_NEXT_VERSION = "0.1.19-native-to-electron-handover.2";

async function withTemporaryDirectory(run) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-production-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function loadProductionBuilderConfig(target, {
  rehearsal = null,
  rehearsalCurrentVersion = REHEARSAL_CURRENT_VERSION,
  rehearsalNextVersion = REHEARSAL_NEXT_VERSION,
  buildNumber = BUILD_NUMBER,
} = {}) {
  const version = rehearsal === null
    ? RELEASE_VERSION
    : rehearsal === "current"
      ? rehearsalCurrentVersion
      : rehearsal === "next"
        ? rehearsalNextVersion
        : "invalid";
  const source = [
    `const config = require(${JSON.stringify(BUILDER_CONFIG_PATH)});`,
    "process.stdout.write(JSON.stringify(config));",
  ].join("\n");
  return JSON.parse(execFileSync(process.execPath, ["-e", source], {
    cwd: resolve("."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TIBOTATTLE_ELECTRON_BUILD_NUMBER: buildNumber,
      TIBOTATTLE_ELECTRON_SOURCE_REVISION: SOURCE_REVISION,
      TIBOTATTLE_ELECTRON_TARGET: target,
      TIBOTATTLE_ELECTRON_VERSION: version,
      ...(rehearsal === null ? {} : {
        TIBOTATTLE_ELECTRON_REHEARSAL_CANDIDATE: rehearsal,
        TIBOTATTLE_ELECTRON_REHEARSAL_CURRENT_VERSION: rehearsalCurrentVersion,
        TIBOTATTLE_ELECTRON_REHEARSAL_NEXT_VERSION: rehearsalNextVersion,
      }),
    },
  }));
}

function loadDevelopmentBuilderConfig(target) {
  const source = [
    `const config = require(${JSON.stringify(DEVELOPMENT_BUILDER_CONFIG_PATH)});`,
    "process.stdout.write(JSON.stringify(config));",
  ].join("\n");
  return JSON.parse(execFileSync(process.execPath, ["-e", source], {
    cwd: resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      TIBOTATTLE_ELECTRON_TARGET: target,
    },
  }));
}

function assertWindowsResourceVersion(version) {
  const components = version.split(".");
  assert.equal(components.length, 4);
  for (const component of components) {
    assert.match(component, /^(?:0|[1-9][0-9]*)$/u);
    assert.ok(Number(component) <= Number(POLICY.WINDOWS_FILE_VERSION_COMPONENT_LIMIT));
  }
}

test("closed production policy declares exactly four final targets with fixed HTTPS feeds", () => {
  assert.equal(POLICY.PRODUCTION_ELECTRON_APP_ID, "com.usagemonitor.local");
  assert.equal(POLICY.PRODUCTION_ELECTRON_CHANNEL, "stable");
  assert.equal(POLICY.PRODUCTION_ELECTRON_CONTRIBUTION_POLICY, "accountless-opt-out-v1");
  assert.deepEqual(POLICY.PRODUCTION_ELECTRON_MACOS_KEYCHAIN_ADAPTER_RESOURCE_RELATIVE_PATH,
    ["native", "macos-keychain.node"]);
  assert.deepEqual(Object.keys(POLICY.PRODUCTION_ELECTRON_TARGETS).sort(), [
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "win32-x64",
  ]);
  for (const [target, spec] of Object.entries(POLICY.PRODUCTION_ELECTRON_TARGETS)) {
    const feed = new URL(spec.feedURL);
    assert.equal(feed.protocol, "https:", target);
    assert.equal(feed.username, "", target);
    assert.equal(feed.password, "", target);
    assert.equal(feed.search, "", target);
    assert.equal(feed.hash, "", target);
    assert.equal(feed.pathname, `/electron/stable/${target}`, target);
  }
});

test("native-to-Electron rehearsal accepts only an ordered macOS prerelease pair on its fixed feed", () => {
  const pair = POLICY.productionElectronNativeToElectronHandoverRehearsalPair({
    currentVersion: REHEARSAL_CURRENT_VERSION,
    nextVersion: REHEARSAL_NEXT_VERSION,
    minimumVersion: RELEASE_VERSION,
  });
  assert.deepEqual(pair, {
    currentVersion: REHEARSAL_CURRENT_VERSION,
    nextVersion: REHEARSAL_NEXT_VERSION,
  });
  assert.equal(semver.valid(REHEARSAL_CURRENT_VERSION), REHEARSAL_CURRENT_VERSION);
  assert.equal(semver.valid(REHEARSAL_NEXT_VERSION), REHEARSAL_NEXT_VERSION);
  assert.equal(semver.gt(REHEARSAL_NEXT_VERSION, REHEARSAL_CURRENT_VERSION), true);
  assert.equal(POLICY.productionElectronNativeToElectronHandoverRehearsalPair({
    currentVersion: REHEARSAL_NEXT_VERSION,
    nextVersion: REHEARSAL_CURRENT_VERSION,
    minimumVersion: RELEASE_VERSION,
  }), null);
  assert.equal(POLICY.productionElectronNativeToElectronHandoverRehearsalPair({
    currentVersion: "0.1.19-native-to-electron-handover.1",
    nextVersion: "0.1.20-native-to-electron-handover.2",
    minimumVersion: RELEASE_VERSION,
  }), null);
  assert.equal(POLICY.productionElectronNativeToElectronHandoverRehearsalPair({
    currentVersion: "0.1.18-native-to-electron-handover.1",
    nextVersion: "0.1.18-native-to-electron-handover.2",
    minimumVersion: RELEASE_VERSION,
  }), null);

  for (const [candidate, version] of Object.entries({
    current: REHEARSAL_CURRENT_VERSION,
    next: REHEARSAL_NEXT_VERSION,
  })) {
    const selected = POLICY.productionElectronDistributionForTarget({
      target: "darwin-arm64",
      rehearsal: candidate,
      rehearsalCurrentVersion: REHEARSAL_CURRENT_VERSION,
      rehearsalNextVersion: REHEARSAL_NEXT_VERSION,
      minimumRehearsalVersion: RELEASE_VERSION,
      feedURL: "https://untrusted.example.invalid/feed",
    });
    assert.equal(selected.semanticVersion, version, candidate);
    assert.equal(selected.channel,
      "native-to-electron-handover-rehearsal-v1", candidate);
    assert.equal(selected.contributionPolicy,
      "disabled-for-native-to-electron-handover-rehearsal-v1", candidate);
    assert.equal(selected.schemaVersion,
      "tibotattle-electron-handover-rehearsal-v1", candidate);
    assert.equal(selected.feedURL,
      "https://updates.tibotattle.com/electron/rehearsal/native-to-electron-handover-v1/darwin-arm64",
      candidate);
    assert.deepEqual(POLICY.productionElectronStagingPathSegments({
      target: "darwin-arm64",
      rehearsal: candidate,
      rehearsalCurrentVersion: REHEARSAL_CURRENT_VERSION,
      rehearsalNextVersion: REHEARSAL_NEXT_VERSION,
      minimumRehearsalVersion: RELEASE_VERSION,
    }), [
      "electron-production",
      "rehearsal",
      "native-to-electron-handover-v1",
      candidate,
      "darwin-arm64",
    ], candidate);
  }
  assert.equal(POLICY.productionElectronDistributionForTarget({
    target: "win32-x64",
    rehearsal: "current",
    rehearsalCurrentVersion: REHEARSAL_CURRENT_VERSION,
    rehearsalNextVersion: REHEARSAL_NEXT_VERSION,
    minimumRehearsalVersion: RELEASE_VERSION,
  }), null);
  const intel = POLICY.productionElectronDistributionForTarget({
    target: "darwin-x64",
    rehearsal: "current",
    rehearsalCurrentVersion: REHEARSAL_CURRENT_VERSION,
    rehearsalNextVersion: REHEARSAL_NEXT_VERSION,
    minimumRehearsalVersion: RELEASE_VERSION,
  });
  assert.equal(intel.semanticVersion, REHEARSAL_CURRENT_VERSION);
  assert.equal(intel.feedURL,
    "https://updates.tibotattle.com/electron/rehearsal/native-to-electron-handover-v1/darwin-x64");
  assert.deepEqual(POLICY.productionElectronStagingPathSegments({
    target: "darwin-x64",
    rehearsal: "current",
    rehearsalCurrentVersion: REHEARSAL_CURRENT_VERSION,
    rehearsalNextVersion: REHEARSAL_NEXT_VERSION,
    minimumRehearsalVersion: RELEASE_VERSION,
  }), [
    "electron-production",
    "rehearsal",
    "native-to-electron-handover-v1",
    "current",
    "darwin-x64",
  ]);
  assert.equal(POLICY.productionElectronMacOSBundleShortVersionForTarget({
    target: "darwin-arm64",
    version: REHEARSAL_CURRENT_VERSION,
  }), "0.1.19");
  assert.throws(() => POLICY.productionElectronMacOSBundleShortVersionForTarget({
    target: "darwin-arm64",
    version: "0.1.19-preview.1",
  }), /reviewed/u);
  assert.throws(() => POLICY.productionElectronBuildVersionForTarget({
    target: "darwin-arm64",
    version: "0.1.19-preview.1",
    buildNumber: "2026090701",
  }), /required/u);
});

test("production builder source config binds app identity, target-specific build versions, feed and artifacts", () => {
  for (const [target, spec] of Object.entries(POLICY.PRODUCTION_ELECTRON_TARGETS)) {
    const config = loadProductionBuilderConfig(target);
    assert.equal(config.appId, POLICY.PRODUCTION_ELECTRON_APP_ID, target);
    assert.equal(config.productName, "TiboTattle", target);
    assert.equal(config.buildNumber, BUILD_NUMBER, target);
    assert.equal(config.buildVersion, POLICY.productionElectronBuildVersionForTarget({
      target, version: RELEASE_VERSION, buildNumber: BUILD_NUMBER,
    }), target);
    assert.equal(config.extraMetadata.version, RELEASE_VERSION, target);
    assert.deepEqual(config.extraMetadata.tibotattleDistribution,
      createProductionDistributionMetadata({ buildNumber: BUILD_NUMBER, sourceRevision: SOURCE_REVISION, target }), target);
    assert.deepEqual(config.publish, [{ provider: "generic", url: spec.feedURL }], target);
    assert.equal(config.forceCodeSigning, true, target);
    assert.match(config.directories.app, new RegExp(`electron-production[\\\\/]${target}[\\\\/]app$`, "u"), target);
    assert.match(config.directories.output, new RegExp(`electron-production[\\\\/]${target}[\\\\/]artifacts$`, "u"), target);
    if (target.startsWith("darwin-")) {
      assert.equal(config.mac.bundleShortVersion, RELEASE_VERSION, target);
      assert.equal(config.mac.bundleVersion, config.buildVersion, target);
      assert.equal(config.mac.sign, "./scripts/electron-macos-sign-order.mjs", target);
      assert.deepEqual(config.mac.target, [
        { target: "dmg", arch: [spec.architecture] },
        { target: "zip", arch: [spec.architecture] },
      ], target);
      assert.deepEqual(config.extraFiles, [{
        from: config.extraFiles[0].from,
        to: "MacOS/TiboTattleNativeHandover",
      }], target);
      assert.match(config.extraFiles[0].from,
        new RegExp(`electron-production[\\\\/]${target}[\\\\/]native[\\\\/]TiboTattleNativeHandover$`, "u"), target);
      assert.deepEqual(config.extraResources, [{
        from: config.extraResources[0].from,
        to: "native/macos-keychain.node",
      }], target);
      assert.match(config.extraResources[0].from,
        new RegExp(`electron-production[\\\\/]${target}[\\\\/]native[\\\\/]macos-keychain\\.node$`, "u"), target);
    } else if (target === "win32-x64") {
      assert.deepEqual(config.win.target, [{ target: "nsis", arch: ["x64"] }]);
      assert.equal(config.win.verifyUpdateCodeSignature, true);
      assert.equal(config.extraMetadata.shortVersion, config.buildVersion);
      assert.equal(config.extraMetadata.shortVersionWindows, config.buildVersion);
      assertWindowsResourceVersion(config.buildVersion);
    } else {
      assert.deepEqual(config.linux.target, [{ target: "AppImage", arch: ["x64"] }]);
      assert.deepEqual(config.linux.executableArgs, []);
      assert.equal(Object.hasOwn(config.extraMetadata, "shortVersion"), false);
    }
  }
});

test("production macOS builder resolves the isolated signing-order hook before signing", async () => {
  const config = loadProductionBuilderConfig("darwin-arm64");
  const { resolveFunction } = ELECTRON_BUILDER_REQUIRE("app-builder-lib/out/util/resolve");
  const appBuilderRequire = createRequire(ELECTRON_BUILDER_REQUIRE.resolve("app-builder-lib/package.json"));
  const osxSignRequire = createRequire(appBuilderRequire.resolve("@electron/osx-sign/package.json"));
  assert.equal(ELECTRON_BUILDER_REQUIRE("./package.json").version, "26.15.7");
  assert.equal(appBuilderRequire("./package.json").version, "26.15.7");
  assert.equal(osxSignRequire("./package.json").version, "1.3.3");
  const hook = await resolveFunction("module", config.mac.sign, "sign", resolve("."));
  assert.equal(typeof hook, "function");
  await assert.rejects(
    () => hook({ app: "/synthetic/not-a-bundle" }),
    (error) => error?.code === "ELECTRON_MACOS_SIGN_ORDER_INPUT_INVALID",
  );
});

test("rehearsal builder config binds semantic updater versions to numeric macOS plist fields", () => {
  const macPackagerSource = readFileSync(
    ELECTRON_BUILDER_REQUIRE.resolve("app-builder-lib/out/macPackager"),
    "utf8",
  );
  assert.match(macPackagerSource,
    /CFBundleShortVersionString\s*=\s*activeOpts\.bundleShortVersion\s*\|\|\s*appInfo\.version/u);
  assert.match(macPackagerSource,
    /CFBundleVersion\s*=\s*activeOpts\.bundleVersion\s*\|\|\s*appInfo\.buildVersion/u);

  for (const [candidate, version, buildNumber] of [
    ["current", REHEARSAL_CURRENT_VERSION, "2026090701"],
    ["next", REHEARSAL_NEXT_VERSION, "2026090702"],
  ]) {
    const config = loadProductionBuilderConfig("darwin-arm64", {
      rehearsal: candidate,
      buildNumber,
    });
    const metadata = createProductionDistributionMetadata({
      buildNumber,
      rehearsal: candidate,
      rehearsalCurrentVersion: REHEARSAL_CURRENT_VERSION,
      rehearsalNextVersion: REHEARSAL_NEXT_VERSION,
      sourceRevision: SOURCE_REVISION,
      target: "darwin-arm64",
    });
    assert.equal(config.extraMetadata.version, version, candidate);
    assert.deepEqual(config.extraMetadata.tibotattleDistribution, metadata, candidate);
    assert.equal(config.mac.bundleShortVersion, "0.1.19", candidate);
    assert.equal(config.mac.bundleVersion, buildNumber, candidate);
    assert.equal(config.buildVersion, buildNumber, candidate);
    assert.deepEqual(config.publish, [{
      provider: "generic",
      url: "https://updates.tibotattle.com/electron/rehearsal/native-to-electron-handover-v1/darwin-arm64",
    }], candidate);
    assert.match(config.directories.app,
      new RegExp(`electron-production[\\\\/]rehearsal[\\\\/]native-to-electron-handover-v1[\\\\/]${candidate}[\\\\/]darwin-arm64[\\\\/]app$`, "u"),
      candidate);
    const appInfo = new AppInfo({
      config: { buildNumber: config.buildNumber, buildVersion: config.buildVersion },
      metadata: { ...config.extraMetadata },
    });
    assert.equal(appInfo.version, version, candidate);
    assert.equal(semver.prerelease(appInfo.version)?.at(-1), candidate === "current" ? 1 : 2,
      candidate);
  }
  assert.throws(() => loadProductionBuilderConfig("win32-x64", { rehearsal: "current" }), /invalid/u);
  assert.throws(() => loadProductionBuilderConfig("darwin-arm64", {
    rehearsal: "current",
    rehearsalCurrentVersion: "0.1.19-preview.1",
  }), /invalid/u);
});

test("development builder retains the adapter contract but excludes the production native resource", () => {
  for (const target of ["darwin-arm64", "darwin-x64"]) {
    const config = loadDevelopmentBuilderConfig(target);
    const filter = config.files[0].filter;
    assert.ok(filter.includes("native/macos-keychain/contract.js"), target);
    assert.equal(filter.includes("native/macos-keychain.node"), false, target);
    assert.equal(Object.hasOwn(config, "extraResources"), false, target);
  }
});

test("Windows candidate mapping is lossless, ordered, and accepted by the pinned builder resource path", () => {
  const candidates = ["1", "65535", "65536", BUILD_NUMBER, "9999999999"];
  let previous = -1n;
  for (const candidate of candidates) {
    const mapped = POLICY.productionElectronWindowsFileVersion(candidate);
    assertWindowsResourceVersion(mapped);
    const restored = mapped.split(".").reduce(
      (value, component) => value * 65_536n + BigInt(component),
      0n,
    );
    assert.equal(restored, BigInt(candidate));
    assert.ok(restored > previous);
    previous = restored;
  }
  assert.equal(POLICY.productionElectronWindowsFileVersion(BUILD_NUMBER), "0.0.309.10282");
  assert.equal(POLICY.productionElectronBuildVersionForTarget({
    target: "darwin-arm64", version: RELEASE_VERSION, buildNumber: BUILD_NUMBER,
  }), BUILD_NUMBER);

  const config = loadProductionBuilderConfig("win32-x64");
  const appInfo = new AppInfo({
    config: { buildNumber: config.buildNumber, buildVersion: config.buildVersion },
    metadata: { ...config.extraMetadata },
  });
  assert.equal(appInfo.buildVersion, config.buildVersion);
  assert.equal(appInfo.shortVersion, config.buildVersion);
  assert.equal(appInfo.shortVersionWindows, config.buildVersion);
  const winPackagerSource = readFileSync(
    ELECTRON_BUILDER_REQUIRE.resolve("app-builder-lib/out/winPackager"),
    "utf8",
  );
  assert.match(winPackagerSource,
    /fileVersion:\s*appInfo\.shortVersion\s*\|\|\s*appInfo\.buildVersion/u);
  assert.match(winPackagerSource,
    /productVersion:\s*appInfo\.shortVersionWindows\s*\|\|\s*appInfo\.getVersionInWeirdWindowsForm\(\)/u);
});

test("production source candidate requires an explicit numeric build number and remains non-publishing", () => {
  const options = parseProductionCandidateArguments([
    "--target", "darwin-arm64",
    "--source-revision", SOURCE_REVISION,
    "--build-number", BUILD_NUMBER,
  ]);
  const plan = productionElectronCandidatePlan(options);
  assert.equal(plan.buildNumber, BUILD_NUMBER);
  assert.equal(plan.version, RELEASE_VERSION);
  assert.deepEqual(plan.builderArguments, ["--mac", "dmg", "zip", "--arm64", "--publish", "never"]);
  assert.deepEqual(plan.nativeHandoverHelper, {
    architecture: "arm64",
    packagedPath: "Contents/MacOS/TiboTattleNativeHandover",
    signed: false,
    sourcePath: ".release-build/electron-production/darwin-arm64/native/TiboTattleNativeHandover",
  });
  assert.deepEqual(plan.nativeMacOSKeychainAdapter, {
    architecture: "arm64",
    packagedPath: "Contents/Resources/native/macos-keychain.node",
    signed: false,
    sourcePath: ".release-build/electron-production/darwin-arm64/native/macos-keychain.node",
  });
  assert.equal(plan.signingPerformed, false);
  assert.equal(plan.publishingPerformed, false);
  assert.throws(() => parseProductionCandidateArguments([
    "--target", "darwin-arm64", "--source-revision", SOURCE_REVISION, "--build-number", "0",
  ]), (error) => error?.code === "ELECTRON_PRODUCTION_ARGUMENT_INVALID");
  assert.throws(() => parseProductionCandidateArguments([
    "--target", "darwin-arm64", "--source-revision", SOURCE_REVISION,
  ]), (error) => error?.code === "ELECTRON_PRODUCTION_ARGUMENT_INVALID");
  assert.throws(() => parseProductionCandidateArguments([
    "--target", "darwin-arm64", "--source-revision", SOURCE_REVISION,
    "--build-number", "10000000000",
  ]), (error) => error?.code === "ELECTRON_PRODUCTION_ARGUMENT_INVALID");
});

test("rehearsal plans prepare two isolated source candidates without allocating a stable release", () => {
  const createPlan = (candidate, buildNumber) => productionElectronCandidatePlan(
    parseProductionCandidateArguments([
      "--target", "darwin-arm64",
      "--source-revision", SOURCE_REVISION,
      "--build-number", buildNumber,
      "--rehearsal-candidate", candidate,
      "--rehearsal-current-version", REHEARSAL_CURRENT_VERSION,
      "--rehearsal-next-version", REHEARSAL_NEXT_VERSION,
    ]),
  );
  const current = createPlan("current", "2026090701");
  const next = createPlan("next", "2026090702");
  for (const [candidate, plan, version, buildNumber] of [
    ["current", current, REHEARSAL_CURRENT_VERSION, "2026090701"],
    ["next", next, REHEARSAL_NEXT_VERSION, "2026090702"],
  ]) {
    assert.equal(plan.version, version, candidate);
    assert.equal(plan.updateFeed,
      "https://updates.tibotattle.com/electron/rehearsal/native-to-electron-handover-v1/darwin-arm64",
      candidate);
    assert.equal(plan.stagingDirectory,
      `.release-build/electron-production/rehearsal/native-to-electron-handover-v1/${candidate}/darwin-arm64/app`,
      candidate);
    assert.equal(plan.artifactDirectory,
      `.release-build/electron-production/rehearsal/native-to-electron-handover-v1/${candidate}/darwin-arm64/artifacts`,
      candidate);
    assert.deepEqual(plan.rehearsal, {
      candidate,
      currentVersion: REHEARSAL_CURRENT_VERSION,
      id: "native-to-electron-handover-v1",
      nextVersion: REHEARSAL_NEXT_VERSION,
      releaseStatus: "not_released",
      hostedUploads: "disabled",
    }, candidate);
    assert.deepEqual(plan.builderEnvironment, {
      TIBOTATTLE_ELECTRON_BUILD_NUMBER: buildNumber,
      TIBOTATTLE_ELECTRON_SOURCE_REVISION: SOURCE_REVISION,
      TIBOTATTLE_ELECTRON_TARGET: "darwin-arm64",
      TIBOTATTLE_ELECTRON_VERSION: version,
      TIBOTATTLE_ELECTRON_REHEARSAL_CANDIDATE: candidate,
      TIBOTATTLE_ELECTRON_REHEARSAL_CURRENT_VERSION: REHEARSAL_CURRENT_VERSION,
      TIBOTATTLE_ELECTRON_REHEARSAL_NEXT_VERSION: REHEARSAL_NEXT_VERSION,
    }, candidate);
    assert.equal(plan.signingPerformed, false, candidate);
    assert.equal(plan.publishingPerformed, false, candidate);
    assert.deepEqual(plan.builderArguments,
      ["--mac", "dmg", "zip", "--arm64", "--publish", "never"], candidate);
  }
  assert.notEqual(current.stagingDirectory, next.stagingDirectory);
  assert.notEqual(current.artifactDirectory, next.artifactDirectory);
  assert.throws(() => parseProductionCandidateArguments([
    "--target", "darwin-arm64",
    "--source-revision", SOURCE_REVISION,
    "--build-number", "2026090701",
    "--rehearsal-candidate", "current",
  ]), (error) => error?.code === "ELECTRON_PRODUCTION_ARGUMENT_INVALID");
  assert.throws(() => parseProductionCandidateArguments([
    "--target", "win32-x64",
    "--source-revision", SOURCE_REVISION,
    "--build-number", "2026090701",
    "--rehearsal-candidate", "current",
    "--rehearsal-current-version", REHEARSAL_CURRENT_VERSION,
    "--rehearsal-next-version", REHEARSAL_NEXT_VERSION,
  ]), (error) => error?.code === "ELECTRON_PRODUCTION_ARGUMENT_INVALID");
});

test("production source plans reserve a thin adapter for both macOS architectures only", () => {
  for (const [target, spec] of Object.entries(POLICY.PRODUCTION_ELECTRON_TARGETS)) {
    const plan = productionElectronCandidatePlan({
      target,
      sourceRevision: SOURCE_REVISION,
      buildNumber: BUILD_NUMBER,
    });
    if (spec.platform === "darwin") {
      assert.deepEqual(plan.nativeMacOSKeychainAdapter, {
        architecture: spec.architecture,
        packagedPath: "Contents/Resources/native/macos-keychain.node",
        signed: false,
        sourcePath: `.release-build/electron-production/${target}/native/macos-keychain.node`,
      }, target);
    } else {
      assert.equal(plan.nativeMacOSKeychainAdapter, null, target);
    }
  }
});

test("manual production source workflow has no default candidate or finalization command", async () => {
  const workflow = await readFile(PRODUCTION_SOURCE_WORKFLOW_PATH, "utf8");
  assert.match(workflow, /^on:\n  workflow_dispatch:\n    inputs:\n      build_number:/mu);
  assert.match(workflow, /build_number:\n(?:.*\n){0,3}\s+required: true\n(?:.*\n){0,2}\s+type: string/mu);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|schedule):/mu);
  assert.doesNotMatch(workflow, /^\s+default:/mu);
  assert.doesNotMatch(workflow, /\belectron-builder\b/u);
  assert.doesNotMatch(workflow, /--publish\b/u);
  assert.equal((workflow.match(/test\/electron-macos-keychain-adapter\.test\.js/gu) ?? []).length, 2);
  for (const target of Object.keys(POLICY.PRODUCTION_ELECTRON_TARGETS)) {
    assert.match(workflow, new RegExp(`--target ${target}`, "u"), target);
    assert.match(workflow,
      new RegExp(`electron-production-source-${target}-\\$\\{\\{ github\\.sha \\}\\}`, "u"), target);
  }
});

test("production staging carries the exact app metadata and updater closure while development cannot activate it", async () => {
  await withTemporaryDirectory(async (root) => {
    const metadata = createProductionDistributionMetadata({
      buildNumber: BUILD_NUMBER,
      sourceRevision: SOURCE_REVISION,
      target: "darwin-arm64",
    });
    const production = await buildElectronApp({
      output: join(root, "production"),
      target: "darwin-arm64",
      packagingProfile: "production",
      distributionMetadata: metadata,
    });
    const development = await buildElectronApp({
      output: join(root, "development"),
      target: "darwin-arm64",
    });
    const productionPackage = JSON.parse(await readFile(join(production.output, "package.json"), "utf8"));
    const developmentPackage = JSON.parse(await readFile(join(development.output, "package.json"), "utf8"));
    assert.deepEqual(productionPackage.tibotattleDistribution, metadata);
    assert.equal(Object.hasOwn(developmentPackage, "tibotattleDistribution"), false);
    for (const name of Object.keys(ELECTRON_UPDATER_RUNTIME_PACKAGE_PINS)) {
      const segments = name.split("/");
      const packagePath = join("node_modules", ...segments, "package.json");
      assert.ok(production.manifest.files.some(({ path }) => path === packagePath), packagePath);
      assert.ok(development.manifest.files.some(({ path }) => path === packagePath), packagePath);
    }
    for (const file of ELECTRON_SHELL_RUNTIME_FILES) {
      assert.ok(production.manifest.files.some(({ path }) => path === file), file);
      assert.ok(development.manifest.files.some(({ path }) => path === file), file);
    }
    const closure = await assertStagedElectronShellModuleLinkage(production.output);
    assert.ok(closure.includes("apps/electron/desktop-updater.js"));
    const developmentClosure = await assertStagedElectronShellModuleLinkage(development.output);
    assert.ok(developmentClosure.includes("apps/electron/desktop-macos-keychain.js"));
  });
});

test("rehearsal source staging binds each updater semantic version to its runtime manifest", async () => {
  await withTemporaryDirectory(async (root) => {
    const staged = [];
    const metadataByCandidate = new Map();
    for (const [candidate, version, buildNumber] of [
      ["current", REHEARSAL_CURRENT_VERSION, "2026090701"],
      ["next", REHEARSAL_NEXT_VERSION, "2026090702"],
    ]) {
      const metadata = createProductionDistributionMetadata({
        buildNumber,
        rehearsal: candidate,
        rehearsalCurrentVersion: REHEARSAL_CURRENT_VERSION,
        rehearsalNextVersion: REHEARSAL_NEXT_VERSION,
        sourceRevision: SOURCE_REVISION,
        target: "darwin-arm64",
      });
      metadataByCandidate.set(candidate, metadata);
      const result = await buildElectronApp({
        output: join(root, candidate, "app"),
        target: "darwin-arm64",
        packagingProfile: "production",
        packageVersion: version,
        distributionMetadata: metadata,
      });
      const packageJson = JSON.parse(await readFile(join(result.output, "package.json"), "utf8"));
      const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
      assert.equal(packageJson.version, version, candidate);
      assert.deepEqual(packageJson.tibotattleDistribution, metadata, candidate);
      assert.equal(manifest.releaseVersion, version, candidate);
      assert.equal(manifest.target, "darwin", candidate);
      assert.equal(manifest.architecture, "arm64", candidate);
      staged.push(result.output);
    }
    assert.notEqual(staged[0], staged[1]);
    await buildElectronApp({
      output: staged[0],
      replace: true,
      target: "darwin-arm64",
      packagingProfile: "production",
      packageVersion: REHEARSAL_CURRENT_VERSION,
      distributionMetadata: metadataByCandidate.get("current"),
    });
    await assert.rejects(
      () => buildElectronApp({
        output: staged[0],
        replace: true,
        target: "darwin-arm64",
        packagingProfile: "production",
        packageVersion: REHEARSAL_NEXT_VERSION,
        distributionMetadata: metadataByCandidate.get("next"),
      }),
      (error) => error?.code === "ELECTRON_RUNTIME_EXISTING_OUTPUT_INVALID",
    );
  });
});
