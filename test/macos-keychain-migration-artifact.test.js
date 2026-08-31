import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { PRODUCT_BRAND } from "../config/product-brand.js";
import {
  createReleaseChannelProvenance,
  getReleaseChannel,
  INTERNAL_DOGFOOD_RELEASE_CHANNEL,
} from "../config/release-channels.js";
import {
  MACOS_KEYCHAIN_MIGRATION_HELPER,
  MACOS_KEYCHAIN_MIGRATION_HELPER_SOURCES,
  assertMacOSKeychainMigrationManifest,
  calculateMacOSSourceInputDigest,
  collectMacOSKeychainMigrationHelperSources,
  collectMacOSSwiftSources,
} from "../scripts/build-macos-app.js";
import {
  createMacOSSignedReplacementContract,
  inspectMacOSApp,
  validateMacOSKeychainMigrationSignatureDescriptions,
  validateMacOSSignedReplacementPair,
  verifyMacOSKeychainMigrationSignatures,
} from "../scripts/macos-release-core.js";
import { SPARKLE_FRAMEWORK_SHA256, SPARKLE_VERSION } from "../scripts/macos-updater-core.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_SOURCE = "apps/macos/Sources/KeychainMigration.swift";
const ENTRYPOINT_SOURCE = "apps/macos/Helpers/KeychainMigrationHelper.swift";
const SIGNATURE_ERROR = { code: "MACOS_KEYCHAIN_MIGRATION_SIGNATURE_INVALID" };
const ARTIFACT_ERROR = { code: "MACOS_KEYCHAIN_MIGRATION_ARTIFACT_INVALID" };
const TEAM = "A1B2C3D4E5";
const AUTHORITY = `Developer ID Application: Synthetic Owner (${TEAM})`;

function requirement(identifier, team = TEAM) {
  return `identifier "${identifier}" and anchor apple generic `
    + "and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ "
    + "and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ "
    + `and certificate leaf[subject.OU] = "${team}"`;
}

function signature(identifier) {
  return `Identifier=${identifier}\nAuthority=${AUTHORITY}\nTeamIdentifier=${TEAM}\n`
    + `flags=0x10000(runtime)\ndesignated => ${requirement(identifier)}\n`;
}

function signatureDescriptions() {
  return {
    application: signature(PRODUCT_BRAND.bundleIdentifier),
    node: signature("node"),
    helper: signature("node"),
    helperEntitlements: { stdout: "", stderr: "" },
  };
}

function buildManifest() {
  return {
    runtime: { keychainMigrationHelper: { ...MACOS_KEYCHAIN_MIGRATION_HELPER } },
    inputs: {
      swiftSources: [SHARED_SOURCE, "apps/macos/UsageMonitorApp.swift"],
      keychainMigrationHelperSources: [...MACOS_KEYCHAIN_MIGRATION_HELPER_SOURCES],
    },
    payload: {
      files: [{
        path: MACOS_KEYCHAIN_MIGRATION_HELPER.executable,
        mode: "555",
        normalization: "mach_o_without_code_signature",
        bytes: 128,
        sha256: "a".repeat(64),
      }],
    },
  };
}

async function helperSourceFixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "tibotattle-helper-inventory-"));
  for (const [relativePath, source] of [
    [SHARED_SOURCE, "struct MigrationProtocol {}\n"],
    [ENTRYPOINT_SOURCE, "@main struct MigrationHelper { static func main() {} }\n"],
    ["apps/macos/UsageMonitorApp.swift", "@main struct App { static func main() {} }\n"],
  ]) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
  }
  return { root, options: { repositoryRoot: root, sourceRoot: join(root, "apps/macos") } };
}

test("migration helper source inventory is closed and its @main never enters the launcher", async () => {
  const { root, options } = await helperSourceFixture();
  try {
    const first = await collectMacOSKeychainMigrationHelperSources(options);
    assert.deepEqual(first.relativeFiles, [ENTRYPOINT_SOURCE, SHARED_SOURCE]);
    assert.deepEqual(await collectMacOSKeychainMigrationHelperSources(options), first);
    assert.deepEqual((await collectMacOSSwiftSources(options)).relativeFiles, [
      SHARED_SOURCE, "apps/macos/UsageMonitorApp.swift",
    ]);
    await writeFile(join(options.sourceRoot, "Helpers/Extra.swift"), "struct Unreviewed {}\n");
    await assert.rejects(collectMacOSKeychainMigrationHelperSources(options),
      /only its reviewed entrypoint/u);
    await assert.rejects(collectMacOSSwiftSources(options), /only its reviewed entrypoint/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration helper discovery refuses missing and symlinked inputs", async () => {
  const { root, options } = await helperSourceFixture();
  try {
    const entrypoint = join(root, ENTRYPOINT_SOURCE);
    await rm(entrypoint);
    await assert.rejects(collectMacOSKeychainMigrationHelperSources(options),
      /only its reviewed entrypoint/u);
    await symlink(join(root, SHARED_SOURCE), entrypoint);
    await assert.rejects(collectMacOSKeychainMigrationHelperSources(options),
      /only its reviewed entrypoint/u);
    await rm(entrypoint);
    await writeFile(entrypoint, "@main struct MigrationHelper { static func main() {} }\n");
    await rm(join(root, SHARED_SOURCE));
    await assert.rejects(collectMacOSKeychainMigrationHelperSources(options), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the reviewed helper entrypoint and shared protocol bytes affect source reproducibility", async () => {
  const sharedFile = join(REPOSITORY_ROOT, SHARED_SOURCE);
  const entrypointFile = join(REPOSITORY_ROOT, ENTRYPOINT_SOURCE);
  const capturedSources = new Map([
    [sharedFile, "struct SharedV1 {}\n"],
    [entrypointFile, "@main struct HelperV1 {}\n"],
  ]);
  const options = {
    graph: { files: [] },
    runtimeAssets: [],
    swiftSources: { files: [sharedFile] },
    keychainMigrationHelperSources: { files: [entrypointFile, sharedFile] },
    readSource: async (file) => Buffer.from(capturedSources.get(file) ?? "synthetic build input\n"),
  };
  const initial = await calculateMacOSSourceInputDigest(options);
  capturedSources.set(entrypointFile, "@main struct ChangedHelper {}\n");
  assert.notEqual(await calculateMacOSSourceInputDigest(options), initial);
  capturedSources.set(entrypointFile, "@main struct HelperV1 {}\n");
  assert.equal(await calculateMacOSSourceInputDigest(options), initial);
  capturedSources.set(sharedFile, "struct ChangedSharedProtocol {}\n");
  assert.notEqual(await calculateMacOSSourceInputDigest(options), initial);
});

test("new artifact contracts require the exact helper identity, sources, mode and normalization", () => {
  assert.doesNotThrow(() => assertMacOSKeychainMigrationManifest(buildManifest()));
  const mutations = [
    (manifest) => { delete manifest.runtime.keychainMigrationHelper; },
    (manifest) => { manifest.runtime.keychainMigrationHelper.signingIdentifier = "TiboTattle"; },
    (manifest) => { manifest.runtime.keychainMigrationHelper.extraCapability = true; },
    (manifest) => { manifest.inputs.keychainMigrationHelperSources.pop(); },
    (manifest) => { manifest.inputs.keychainMigrationHelperSources.push("apps/macos/Helpers/Other.swift"); },
    (manifest) => { manifest.inputs.swiftSources.push(ENTRYPOINT_SOURCE); },
    (manifest) => { manifest.inputs.swiftSources = ["apps/macos/UsageMonitorApp.swift"]; },
    (manifest) => { manifest.payload.files = []; },
    (manifest) => { manifest.payload.files = {}; },
    (manifest) => { manifest.payload.files.push({ ...manifest.payload.files[0] }); },
    (manifest) => { manifest.payload.files[0].path = "Contents/Helpers/Other"; },
    (manifest) => { manifest.payload.files[0].normalization = "raw"; },
    (manifest) => { manifest.payload.files[0].mode = "755"; },
    (manifest) => { manifest.payload.files[0].bytes = 0; },
    (manifest) => { manifest.payload.files[0].sha256 = "invalid"; },
  ];
  for (const mutate of mutations) {
    const changed = buildManifest();
    mutate(changed);
    assert.throws(() => assertMacOSKeychainMigrationManifest(changed), ARTIFACT_ERROR);
  }
});

test("legacy reader compatibility requires the exact Node designated requirement and no entitlements", () => {
  assert.deepEqual(validateMacOSKeychainMigrationSignatureDescriptions(signatureDescriptions()), {
    legacyNodeDesignatedRequirementMatched: true,
    sameDeveloperIDTeam: true,
    helperHardenedRuntime: true,
    helperEntitlementsAbsent: true,
  });
  const emptyDictionary = signatureDescriptions();
  emptyDictionary.helperEntitlements.stdout =
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>';
  assert.doesNotThrow(() => validateMacOSKeychainMigrationSignatureDescriptions(emptyDictionary));
  // Real codesign output can use bare `node`; mixed renderings are equivalent.
  for (const bareTargets of [["node"], ["helper"], ["node", "helper"]]) {
    const equivalent = signatureDescriptions();
    for (const target of bareTargets) {
      equivalent[target] = equivalent[target].replace('identifier "node"', "identifier node");
    }
    assert.doesNotThrow(() => validateMacOSKeychainMigrationSignatureDescriptions(equivalent));
  }
  const mutations = [
    (input) => { input.helper = signature("TiboTattleKeychainMigration"); },
    (input) => { input.node = signature("different-node"); },
    (input) => { input.helper = input.helper.replaceAll(TEAM, "Z9Y8X7W6V5"); },
    (input) => { input.helper = input.helper.replace("Synthetic Owner", "Different Owner"); },
    (input) => { input.helper = input.helper.replace("(runtime)", "(adhoc)"); },
    (input) => { input.helper = input.helper.replace(requirement("node"), `certificate leaf[subject.OU] = "${TEAM}"`); },
    (input) => { input.helper = input.helper.replace(requirement("node"), `cdhash H"${"a".repeat(40)}"`); },
    (input) => { input.helper = input.helper.replace(requirement("node"), `${requirement("node")} or true`); },
    (input) => { input.helper = input.helper.replace('identifier "node"', "identifier node-other"); },
    (input) => { input.node = input.node.replace('identifier "node"', "identifier node2"); },
    (input) => { input.helper = input.helper.replace('identifier "node"', "identifier node").replace("anchor apple generic", "anchor trusted"); },
    (input) => { input.helper = input.helper.replace(requirement("node"), `${requirement("node").replace('identifier "node"', "identifier node")} or true`); },
    (input) => { input.helper = input.helper.replace('identifier "node"', "identifier node").replace("1.2.840.113635.100.6.1.13", "1.2.840.113635.100.6.1.1"); },
    (input) => {
      input.helper = input.helper.replace(requirement("node"), "anchor apple generic");
      input.node = input.node.replace(requirement("node"), "anchor apple generic");
    },
    (input) => { input.helper += "Identifier=node\n"; },
    (input) => { input.helper += `designated => ${requirement("node")}\n`; },
    (input) => { input.helperEntitlements = undefined; },
    (input) => { input.helperEntitlements.stdout = " ".repeat(128 * 1024 + 1); },
    (input) => { input.helperEntitlements.stdout = '<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>'; },
    (input) => { input.helperEntitlements.stdout = '<plist version="1.0"><dict><key>unreviewed.entitlement</key><false/></dict></plist>'; },
    (input) => { input.helperEntitlements.stderr = "warning: binary contains an invalid entitlements blob.\n"; },
  ];
  for (const mutate of mutations) {
    const changed = signatureDescriptions();
    mutate(changed);
    assert.throws(() => validateMacOSKeychainMigrationSignatureDescriptions(changed), SIGNATURE_ERROR);
  }
});

test("helper signature verification performs read-only requirement checks and reports no private metadata", () => {
  const calls = [];
  const commandRunner = (command, arguments_, options) => {
    calls.push({ command, arguments_, options });
    if (arguments_.includes("--entitlements")) return { stdout: "", stderr: "" };
    if (arguments_.includes("-d")) {
      return {
        stdout: "",
        stderr: signature(arguments_.at(-1).endsWith("/MacOS/TiboTattle")
          ? PRODUCT_BRAND.bundleIdentifier : "node"),
      };
    }
    return { stdout: "", stderr: "" };
  };
  const proof = verifyMacOSKeychainMigrationSignatures("/synthetic/TiboTattle.app", { commandRunner });
  assert.equal(proof.legacyNodeDesignatedRequirementMatched, true);
  assert.equal(calls.length, 6);
  assert.equal(calls.every(({ command, arguments_ }) =>
    command === "/usr/bin/codesign" && !arguments_.includes("--sign")), true);
  const verifications = calls.filter(({ arguments_ }) => arguments_.includes("--verify"));
  assert.equal(verifications.length, 2);
  for (const { arguments_, options } of verifications) {
    assert.equal(arguments_.includes("--strict"), true);
    assert.equal(arguments_.includes(`-R=${requirement("node")}`), true);
    assert.deepEqual(options.secrets, [requirement("node")]);
  }
  assert.equal(JSON.stringify(proof).includes(TEAM), false);
  assert.equal(JSON.stringify(proof).includes("/synthetic"), false);
  assert.throws(() => verifyMacOSKeychainMigrationSignatures("/synthetic/TiboTattle.app", {
    commandRunner() { throw new Error(`private identity ${AUTHORITY}; requirement ${requirement("node")}`); },
  }), (error) => error.code === SIGNATURE_ERROR.code
    && !error.message.includes(AUTHORITY) && !error.message.includes(requirement("node")));
});

function preMigrationPreviousManifest() {
  const channel = getReleaseChannel(INTERNAL_DOGFOOD_RELEASE_CHANNEL);
  return {
    schemaVersion: "usage-monitor-macos-release-v0.2",
    application: {
      bundleIdentifier: PRODUCT_BRAND.bundleIdentifier,
      bundleVersion: "1023",
      shortVersion: "0.1.17",
    },
    artifact: {
      bytes: 49_574_961,
      fileName: "TiboTattle-0.1.17-macOS-arm64.dmg",
      sha256: "125a15da9b0e260ec3797527d6b98e15aa1172e8b6fc8e7942d2a799cc2b29b0",
    },
    build: {
      sourceSha256: "d18945b354ed3431b49953c2fe756405ccb8b5d46cd866adcc96a640f2344275",
      payloadSha256: "dad884435aea0d1a471f1a7ff7cfbd908723c6cb26a95823ad600c8ccd1d1a7d",
    },
    source: {
      repository: "https://github.com/adamallcock/tibotattle",
      commit: "3d9055fc8e58c84f8ba71feb5deb58b52c532138",
      tag: "tibotattle-internal-dogfood-0.1.17-rc2-source-20260831",
    },
    channel: createReleaseChannelProvenance(INTERNAL_DOGFOOD_RELEASE_CHANNEL, {
      publicEdKeySha256: channel.sparkle.publicEdKeySha256,
    }),
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
    updater: {
      appcastURL: channel.sparkle.appcastURL,
      automaticChecks: true,
      automaticUpdateOptInAvailable: true,
      automaticUpdatesEnabledByDefault: true,
      afterUserOptIn: { automaticDownload: true, installOnQuit: true },
      enabled: true,
      frameworkVersion: SPARKLE_VERSION,
      frameworkSha256: SPARKLE_FRAMEWORK_SHA256,
      publicEdKeySha256: channel.sparkle.publicEdKeySha256,
      requiresSignedFeed: true,
      verifyBeforeExtraction: true,
    },
    replacement: createMacOSSignedReplacementContract(),
  };
}

test("immutable pre-migration rc2 compatibility is an exact previous-only receipt contract", () => {
  const previous = preMigrationPreviousManifest();
  const candidate = structuredClone(previous);
  candidate.application.bundleVersion = "1023.1";
  candidate.artifact.sha256 = "b".repeat(64);
  candidate.source.commit = "c".repeat(40);
  candidate.source.tag = "tibotattle-internal-dogfood-0.1.17-rc3-source-20260831";
  const replacement = validateMacOSSignedReplacementPair({
    previousManifest: previous, candidateManifest: candidate,
  });
  assert.equal(replacement.previousBundleVersion, "1023");
  assert.equal(replacement.candidateBundleVersion, "1023.1");
  const reusedBuild = structuredClone(candidate);
  reusedBuild.application.bundleVersion = "1023";
  assert.throws(() => validateMacOSSignedReplacementPair({
    previousManifest: previous, candidateManifest: reusedBuild,
  }), { code: "MACOS_REPLACEMENT_VERSION_NOT_NEWER" });
  for (const path of [
    ["source", "commit"], ["source", "tag"], ["build", "sourceSha256"],
    ["build", "payloadSha256"], ["updater", "frameworkSha256"],
  ]) {
    const changed = structuredClone(previous);
    changed[path[0]][path[1]] = "changed";
    assert.throws(() => validateMacOSSignedReplacementPair({
      previousManifest: changed, candidateManifest: candidate,
    }), { code: "MACOS_KEYCHAIN_MIGRATION_COMPATIBILITY_INVALID" });
  }
  const earlier = structuredClone(candidate);
  earlier.application.bundleVersion = "1022";
  assert.throws(() => validateMacOSSignedReplacementPair({
    previousManifest: earlier, candidateManifest: previous,
  }), { code: "MACOS_KEYCHAIN_MIGRATION_COMPATIBILITY_INVALID" });
});

test("callers cannot forge the previous-only helper compatibility capability", async () => {
  const forged = new Proxy({ requireExternalDistribution: true }, {
    get(target, key) {
      if (typeof key === "symbol" && key.description === "verified pre-migration previous artifact") {
        return Object.freeze({});
      }
      return target[key];
    },
  });
  await assert.rejects(inspectMacOSApp("/synthetic/TiboTattle.app", forged), {
    code: "MACOS_KEYCHAIN_MIGRATION_COMPATIBILITY_INVALID",
  });
});

test("native helper compilation and inside-out signing exclude keytar and Node runtime exceptions", async () => {
  const [builder, release] = await Promise.all([
    readFile(join(REPOSITORY_ROOT, "scripts/build-macos-app.js"), "utf8"),
    readFile(join(REPOSITORY_ROOT, "scripts/macos-release-core.js"), "utf8"),
  ]);
  assert.match(builder, /keychainMigrationHelperSources,\s*\{ buildProfile, migrationHelper: true \}/u);
  assert.match(builder, /\? \["-framework", "Foundation", "-framework", "Security"\]/u);
  const nodeSign = release.indexOf("sign(NODE_EXECUTABLE, { entitlements: NODE_ENTITLEMENTS })");
  const helperSign = release.indexOf("sign(MACOS_KEYCHAIN_MIGRATION_HELPER.executable, {");
  const launcherSign = release.indexOf("sign(APP_EXECUTABLE)");
  const appSign = release.indexOf('sign("")');
  assert.equal(nodeSign > 0 && nodeSign < helperSign && helperSign < launcherSign && launcherSign < appSign, true);
  assert.match(release.slice(helperSign, release.indexOf("});", helperSign)),
    /identifier: MACOS_KEYCHAIN_MIGRATION_HELPER.signingIdentifier/u);
  assert.doesNotMatch(release.slice(helperSign, release.indexOf("});", helperSign)),
    /entitlements|preserveEntitlements/u);
});

test("both actual native compile invocations link audit-token symbols through libbsm", async () => {
  const builder = await readFile(join(REPOSITORY_ROOT, "scripts/build-macos-app.js"), "utf8");
  const start = builder.indexOf("async function compileNativeExecutable(");
  const end = builder.indexOf("\nasync function copyPinnedSparkleFramework", start);
  assert.equal(start >= 0 && end > start, true);
  const compileSource = builder.slice(start, end);
  for (const buildProfile of ["release", "test"]) {
    for (const migrationHelper of [false, true]) {
      const calls = [];
      const compile = runInNewContext(`(${compileSource})`, {
        MACOS_BUILD_PROFILE_RELEASE: "release",
        MACOS_BUILD_PROFILE_TEST: "test",
        MINIMUM_MACOS_VERSION: "14.0",
        FIXED_EPOCH_SECONDS: 946_684_800,
        PRODUCT_BRAND,
        normalizeMacOSBuildProfile: (value) => value,
        dirname,
        join,
        mkdtemp: async () => "/synthetic/compiler-scratch",
        prepareTestCompilerModuleCache: async () => "/synthetic/module-cache",
        chmod: async () => {},
        utimes: async () => {},
        rm: async () => {},
        fail: (message) => { throw new Error(message); },
        run(command, arguments_) {
          calls.push({ command, arguments_: Array.from(arguments_) });
          if (command === "/usr/bin/file") return "Mach-O 64-bit executable arm64";
          if (arguments_.includes("--show-sdk-path")) return "/synthetic/macos-sdk";
          if (arguments_.includes("--version")) return "synthetic Swift toolchain";
          return "";
        },
      });
      const destination = migrationHelper
        ? "/synthetic/TiboTattleKeychainMigration" : "/synthetic/TiboTattle";
      await compile(destination, { enabled: false }, {
        files: migrationHelper ? [ENTRYPOINT_SOURCE, SHARED_SOURCE] : [SHARED_SOURCE],
      }, { buildProfile, migrationHelper });
      const compileCalls = calls.filter(({ command, arguments_ }) =>
        command === "/usr/bin/xcrun" && arguments_.includes("swiftc")
        && !arguments_.includes("--version"));
      assert.equal(compileCalls.length, 1);
      const arguments_ = compileCalls[0].arguments_;
      assert.equal(arguments_.filter((value) => value === "-lbsm").length, 1);
      assert.equal(arguments_.includes("WebKit"), !migrationHelper);
      assert.equal(arguments_.includes("Security"), migrationHelper);
      assert.equal(arguments_[arguments_.indexOf("-o") + 1], destination);
      assert.equal(arguments_.includes(ENTRYPOINT_SOURCE), migrationHelper);
      assert.equal(calls.some(({ command }) => command.includes("codesign")), false);
    }
  }
});
