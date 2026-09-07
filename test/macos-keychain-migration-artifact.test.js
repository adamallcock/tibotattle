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
  STABLE_RELEASE_CHANNEL,
} from "../config/release-channels.js";
import {
  MACOS_KEYCHAIN_MIGRATION_HELPER,
  MACOS_KEYCHAIN_MIGRATION_HELPER_SOURCES,
  assertMacOSKeychainMigrationManifest,
  calculateMacOSSourceInputDigest,
  collectMacOSKeychainMigrationHelperSources,
  collectMacOSSwiftSources,
  normalizeMacOSBuildArchitecture,
} from "../scripts/build-macos-app.js";
import {
  createMacOSSignedReplacementContract,
  inspectMacOSApp,
  macOSReleaseManifestArchitecture,
  validateInstalledMacOSApp,
  validateMacOSDMG,
  validateMacOSKeychainMigrationSignatureDescriptions,
  validateMacOSSignedReleaseArtifact,
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

function legacyStablePreviousManifest() {
  // Public historical release metadata only; never read the real DMG or user state.
  const previous = preMigrationPreviousManifest();
  previous.application.bundleVersion = "0.1.16";
  previous.application.shortVersion = "0.1.16";
  previous.artifact = {
    bytes: 49_341_389,
    fileName: "TiboTattle-0.1.16-macOS-arm64.dmg",
    sha256: "5e3e60402ffa3c61d8279f5f759548a8b48084f1ae567eeb1b30156c7f30a9fe",
  };
  previous.build = {
    sourceSha256: "95de0721e5a29ab0988535a55935e516012e9230185bab79d1504b24fc59513a",
    payloadSha256: "23f41a17bc6f4fede452e53f61972999b7ea144e732cd59807d77aca2ada20e5",
  };
  previous.source.commit = "4f30508eff55c122e73025ad06d73b33cadbc508";
  previous.source.tag = "v0.1.16";
  previous.updater.publicEdKeySha256 =
    "ae8a8e00311a4cfc1e7e7f2eedcf7fa53d6bc197997c912a0b8f908e54a28fbf";
  previous.channel = createReleaseChannelProvenance(STABLE_RELEASE_CHANNEL, {
    publicEdKeySha256: previous.updater.publicEdKeySha256,
  });
  previous.updater.appcastURL = previous.channel.sparkle.appcastURL;
  return previous;
}

function stableReplacementCandidate() {
  const candidate = legacyStablePreviousManifest();
  candidate.application.bundleVersion = "1024";
  candidate.application.shortVersion = "0.1.17";
  candidate.artifact = { bytes: 128, fileName: "candidate.dmg", sha256: "c".repeat(64) };
  candidate.source.commit = "d".repeat(40);
  candidate.source.tag = "v0.1.17";
  return candidate;
}

test("historical stable compatibility pins every previous receipt field and rejects candidate use", async () => {
  const previous = legacyStablePreviousManifest();
  const candidate = stableReplacementCandidate();
  assert.equal(validateMacOSSignedReplacementPair({
    previousManifest: previous, candidateManifest: candidate,
  }).previousBundleVersion, "0.1.16");
  for (const [section, key, value] of [
    ["application", "bundleIdentifier", "com.example.other"],
    ["application", "bundleVersion", "1022"],
    ["application", "shortVersion", "0.1.15"],
    ["artifact", "bytes", previous.artifact.bytes - 1],
    ["artifact", "sha256", "e".repeat(64)],
    ["artifact", "fileName", "repacked.dmg"],
    ["source", "commit", "f".repeat(40)],
    ["source", "repository", "https://github.com/example/other"],
    ["source", "tag", "v0.1.15"],
    ["build", "sourceSha256", "a".repeat(64)],
    ["build", "payloadSha256", "b".repeat(64)],
    ["updater", "frameworkSha256", "c".repeat(64)],
    ["updater", "publicEdKeySha256", "d".repeat(64)],
    ["updater", "appcastURL", "https://updates.example/other.xml"],
    ["updater", "verifyBeforeExtraction", false],
    ...Object.keys(previous.assurances).map((key) => ["assurances", key, false]),
  ]) {
    const changed = structuredClone(previous);
    changed[section][key] = value;
    assert.throws(() => validateMacOSSignedReplacementPair({
      previousManifest: changed, candidateManifest: candidate,
    }), (error) => error.code?.startsWith("MACOS_"), `${section}.${key}`);
  }
  for (const key of ["source", "build"]) {
    const changed = structuredClone(previous);
    delete changed[key];
    assert.throws(() => validateMacOSSignedReplacementPair({
      previousManifest: changed, candidateManifest: candidate,
    }), { code: "MACOS_LEGACY_SOURCE_COMPATIBILITY_INVALID" });
  }
  assert.throws(() => validateMacOSSignedReplacementPair({
    previousManifest: candidate, candidateManifest: previous,
  }), { code: "MACOS_LEGACY_SOURCE_COMPATIBILITY_INVALID" });
  const root = await mkdtemp(join(await realpath(tmpdir()), "tibotattle-stable-previous-"));
  try {
    const path = join(root, "historical.json");
    await writeFile(path, JSON.stringify(previous));
    await assert.rejects(validateMacOSSignedReleaseArtifact({
      releaseManifestPath: path,
      validateArtifact() { assert.fail("historical stable must never reach the public installer"); },
    }), { code: "MACOS_LEGACY_SOURCE_COMPATIBILITY_INVALID" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the public legacy boolean and forged stable capability cannot bypass artifact authorization", async () => {
  for (const [validate, code] of [
    [inspectMacOSApp, "MACOS_LEGACY_SOURCE_COMPATIBILITY_INVALID"],
    [validateInstalledMacOSApp, "MACOS_LEGACY_SOURCE_COMPATIBILITY_INVALID"],
    [validateMacOSDMG, "MACOS_DMG_DISTRIBUTION_INVALID"],
  ]) {
    await assert.rejects(validate(null, {
      allowLegacyUnsealedSource: true, channel: STABLE_RELEASE_CHANNEL,
      requireExternalDistribution: true, production: true,
    }), { code }, "a bare boolean must fail before path resolution");
    const options = new Proxy({}, {
      get(target, key) {
        if (typeof key === "symbol"
            && key.description === "verified legacy stable previous artifact") return {};
        return target[key];
      },
    });
    await assert.rejects(validate(null, options), {
      code: "MACOS_LEGACY_SOURCE_COMPATIBILITY_INVALID",
    });
  }
});

function releaseSourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.equal(start >= 0 && end > start, true, startMarker);
  return source.slice(start, end).replace(/^export /u, "");
}

test("historical receipt artifact reading rejects changed DMG bytes and size before granting authority", async () => {
  const source = await readFile(join(REPOSITORY_ROOT, "scripts/macos-release-core.js"), "utf8");
  const readerSource = releaseSourceSection(source,
    "async function readReplacementReleaseArtifact(", "\n/**\n * Validate one exact public release artifact");
  const previous = legacyStablePreviousManifest();
  for (const [size, digest, accepted] of [
    [previous.artifact.bytes, previous.artifact.sha256, true],
    [previous.artifact.bytes - 1, previous.artifact.sha256, false],
    [previous.artifact.bytes, "0".repeat(64), false],
  ]) {
    const readArtifact = runInNewContext(`(${readerSource})`, {
      resolve, dirname, join,
      regularPath: async () => ({ size }),
      readFile: async () => JSON.stringify(previous),
      sha256File: async () => digest,
      validateSignedReleaseManifest(manifest) {
        validateMacOSSignedReplacementPair({
          previousManifest: manifest, candidateManifest: stableReplacementCandidate(),
        });
      },
      fail(message, code) { throw Object.assign(new Error(message), { code }); },
    });
    const reading = readArtifact("/synthetic/previous.json", "Previous release");
    if (accepted) assert.equal((await reading).manifest.artifact.sha256, previous.artifact.sha256);
    else await assert.rejects(reading, { code: "MACOS_REPLACEMENT_ARTIFACT_INVALID" });
  }
});

test("historical stable DMG validation rechecks exact bytes before native trust commands", async () => {
  const source = await readFile(join(REPOSITORY_ROOT, "scripts/macos-release-core.js"), "utf8");
  const dmgSource = releaseSourceSection(source,
    "export async function validateMacOSDMG(", "\nasync function writeAtomic(");
  const pin = releaseSourceSection(source,
    "const LEGACY_STABLE_PREVIOUS_RELEASE =", "// This immutable rc2");
  const capabilityValidator = releaseSourceSection(source,
    "function validateLegacyStablePreviousCapability(", "\nfunction resolveOperationalReleaseChannel(");
  const previous = legacyStablePreviousManifest();
  const nativeBoundary = new Error("synthetic native trust boundary");
  for (const [size, digest, channel, accepted] of [
    [previous.artifact.bytes, previous.artifact.sha256, STABLE_RELEASE_CHANNEL, true],
    [previous.artifact.bytes - 1, previous.artifact.sha256, STABLE_RELEASE_CHANNEL, false],
    [previous.artifact.bytes, "0".repeat(64), STABLE_RELEASE_CHANNEL, false],
    [previous.artifact.bytes, previous.artifact.sha256, INTERNAL_DOGFOOD_RELEASE_CHANNEL, false],
  ]) {
    const harness = runInNewContext(`${pin}\n${capabilityValidator}\n${dmgSource}\n`
      + "const token = Object.freeze({}); VERIFIED_LEGACY_STABLE_CAPABILITIES.add(token);"
      + "({ validateMacOSDMG, options: { [VERIFIED_LEGACY_STABLE_PREVIOUS_ARTIFACT]: token } })", {
      resolve, PRODUCT_BRAND, STABLE_RELEASE_CHANNEL, normalizeMacOSBuildArchitecture,
      VERIFIED_LEGACY_DOGFOOD_PREVIOUS_ARTIFACT: Symbol("synthetic dogfood"),
      VERIFIED_PRE_MIGRATION_PREVIOUS_ARTIFACT: Symbol("synthetic pre-migration"),
      validateLegacyDogfoodPreviousCapability: () => false,
      validatePreMigrationPreviousCapability: () => false,
      DMG_DISTRIBUTIONS: { release: "release", preview: "preview", development: "development" },
      regularPath: async () => ({ size }),
      sha256File: async () => digest,
      runMacOSReleaseCommand() { throw nativeBoundary; },
      fail(message, code) { throw Object.assign(new Error(message), { code }); },
    });
    const validation = harness.validateMacOSDMG("/synthetic/previous.dmg", {
      ...harness.options, channel, production: true,
    });
    await assert.rejects(validation, accepted ? (error) => error === nativeBoundary : {
      code: "MACOS_LEGACY_SOURCE_COMPATIBILITY_INVALID",
    });
  }
});

test("stable previous capabilities expire on success and failure before candidate validation", async () => {
  const source = await readFile(join(REPOSITORY_ROOT, "scripts/macos-release-core.js"), "utf8");
  const orchestration = releaseSourceSection(source,
    "export async function validateMacOSSignedReplacementArtifacts(", "\nfunction releaseEnvironment(");
  const pin = releaseSourceSection(source,
    "const LEGACY_STABLE_PREVIOUS_RELEASE =", "// This immutable rc2");
  const capabilityValidator = releaseSourceSection(source,
    "function validateLegacyStablePreviousCapability(", "\nfunction resolveOperationalReleaseChannel(");
  const isExact = releaseSourceSection(source,
    "function isExactLegacyStablePreviousRelease(", "\nfunction isExactPreMigrationDogfoodPreviousRelease(");
  const previous = { artifact: "/synthetic/previous.dmg", manifest: legacyStablePreviousManifest() };
  const candidate = { artifact: "/synthetic/candidate.dmg", manifest: stableReplacementCandidate() };
  for (const rejectPrevious of [false, true]) {
    const harness = runInNewContext(`${pin}\n${capabilityValidator}\n${isExact}\n${orchestration}\n`
      + "({ validateMacOSSignedReplacementArtifacts, validateLegacyStablePreviousCapability })", {
      STABLE_RELEASE_CHANNEL,
      BUNDLE_IDENTIFIER: PRODUCT_BRAND.bundleIdentifier,
      PUBLIC_RELEASE_SOURCE_REPOSITORY: previous.manifest.source.repository,
      isExactLegacyDogfoodPreviousRelease: () => false,
      isExactPreMigrationDogfoodPreviousRelease: () => false,
      validateMacOSSignedReplacementPair,
      macOSReleaseManifestArchitecture,
      readReplacementReleaseArtifact: async (path) => path === "previous" ? previous : candidate,
      fail(message, code) { throw Object.assign(new Error(message), { code }); },
    });
    let captured = null;
    const calls = [];
    const validation = harness.validateMacOSSignedReplacementArtifacts({
      previousReleaseManifestPath: "previous", candidateReleaseManifestPath: "candidate",
      async validateArtifact(path, options) {
        calls.push(path);
        if (path === previous.artifact) {
          const keys = Object.getOwnPropertySymbols(options);
          assert.equal(keys.length, 1);
          captured = options[keys[0]];
          assert.equal(harness.validateLegacyStablePreviousCapability(captured), true);
          assert.equal(options.allowLegacyUnsealedSource, true);
          if (rejectPrevious) throw new Error("synthetic native rejection");
        } else {
          assert.equal(Object.getOwnPropertySymbols(options).length, 0);
          assert.equal(options.allowLegacyUnsealedSource, false);
          assert.throws(() => harness.validateLegacyStablePreviousCapability(captured), {
            code: "MACOS_LEGACY_SOURCE_COMPATIBILITY_INVALID",
          });
        }
      },
    });
    if (rejectPrevious) await assert.rejects(validation, /synthetic native rejection/u);
    else await validation;
    assert.deepEqual(calls, rejectPrevious ? [previous.artifact] : [previous.artifact, candidate.artifact]);
    assert.throws(() => harness.validateLegacyStablePreviousCapability(captured), {
      code: "MACOS_LEGACY_SOURCE_COMPATIBILITY_INVALID",
    });
  }
});

test("historical stable inspection binds the app build digests before accepting legacy payload shape", async () => {
  const source = await readFile(join(REPOSITORY_ROOT, "scripts/macos-release-core.js"), "utf8");
  const inspectorSource = releaseSourceSection(source,
    "export async function inspectMacOSApp(", "\nexport function readMacOSReleaseCredentials(");
  const pin = releaseSourceSection(source,
    "const LEGACY_STABLE_PREVIOUS_RELEASE =", "// This immutable rc2");
  const capabilityValidator = releaseSourceSection(source,
    "function validateLegacyStablePreviousCapability(", "\nfunction resolveOperationalReleaseChannel(");
  const previous = legacyStablePreviousManifest();
  const manifest = {
    schemaVersion: "usage-monitor-macos-app-build-v0.1",
    application: previous.application,
    inputs: { sourceSha256: previous.build.sourceSha256 },
    payload: { payloadSha256: previous.build.payloadSha256 },
    release: { updater: previous.updater },
  };
  const payloadBoundary = new Error("synthetic payload verification boundary");
  for (const mutation of [
    null,
    (value) => { value.inputs.sourceSha256 = "a".repeat(64); },
    (value) => { value.payload.payloadSha256 = "b".repeat(64); },
    (value) => { value.application.bundleVersion = "1024"; },
    (value) => { value.application.shortVersion = "0.1.17"; },
    (value) => { value.release.source = { commit: previous.source.commit, tag: previous.source.tag }; },
    (value) => { value.release.updater.publicEdKeySha256 = "c".repeat(64); },
    (value) => { value.release.updater.frameworkSha256 = "d".repeat(64); },
  ]) {
    const changed = structuredClone(manifest);
    if (mutation) mutation(changed);
    const harness = runInNewContext(`${pin}\n${capabilityValidator}\n${inspectorSource}\n`
      + "const token = Object.freeze({}); VERIFIED_LEGACY_STABLE_CAPABILITIES.add(token);"
      + "({ inspectMacOSApp, options: { [VERIFIED_LEGACY_STABLE_PREVIOUS_ARTIFACT]: token } })", {
      resolve, join, normalizeMacOSBuildArchitecture, basename: (path) => path.split("/").at(-1),
      STABLE_RELEASE_CHANNEL,
      APP_NAME: PRODUCT_BRAND.bundleName,
      BUNDLE_IDENTIFIER: PRODUCT_BRAND.bundleIdentifier,
      BUILD_MANIFEST_PATH: "Contents/Resources/build-manifest.json",
      BUILD_MANIFEST_SCHEMA: "usage-monitor-macos-app-build-v0.1",
      VERIFIED_LEGACY_DOGFOOD_PREVIOUS_ARTIFACT: Symbol("synthetic dogfood"),
      VERIFIED_PRE_MIGRATION_PREVIOUS_ARTIFACT: Symbol("synthetic pre-migration"),
      validateLegacyDogfoodPreviousCapability: () => false,
      validatePreMigrationPreviousCapability: () => false,
      regularPath: async () => {},
      readFile: async () => JSON.stringify(changed),
      verifyMacOSBuildPayload() { throw payloadBoundary; },
      fail(message, code) { throw Object.assign(new Error(message), { code }); },
    });
    await assert.rejects(harness.inspectMacOSApp("/synthetic/TiboTattle.app", {
      ...harness.options, requireExternalDistribution: true,
    }), mutation === null ? (error) => error === payloadBoundary : {
      code: "MACOS_LEGACY_SOURCE_COMPATIBILITY_INVALID",
    });
  }
});

test("stable previous payload compatibility accepts only the exact normalized Keytar tuple", async () => {
  const source = await readFile(join(REPOSITORY_ROOT, "scripts/macos-release-core.js"), "utf8");
  const payloadSource = releaseSourceSection(source,
    "async function verifyMacOSBuildPayload(", "\nfunction parsePlist(");
  const pinSource = releaseSourceSection(source,
    "const LEGACY_STABLE_PREVIOUS_RELEASE =", "// This immutable rc2");
  const nativeInventoryReached = new Error("synthetic native inventory boundary");
  const token = Object.freeze({});
  const harness = runInNewContext(`${pinSource}\n${payloadSource}\n`
    + "({ verifyMacOSBuildPayload, keytar: LEGACY_STABLE_PREVIOUS_RELEASE.keytar })", {
    validateLegacyDogfoodPreviousCapability: () => false,
    validatePreMigrationPreviousCapability: () => false,
    validateLegacyStablePreviousCapability: (value) => value === token,
    assertMacOSKeychainMigrationManifest,
    MACOS_KEYCHAIN_MIGRATION_HELPER,
    BASE_NORMALIZED_MACH_O_PATHS: [MACOS_KEYCHAIN_MIGRATION_HELPER.executable],
    NORMALIZED_MACH_O_PATHS: new Set([MACOS_KEYCHAIN_MIGRATION_HELPER.executable]),
    BUILD_MANIFEST_PATH: "Contents/Resources/build-manifest.json",
    CODE_RESOURCES_PATH: "Contents/_CodeSignature/CodeResources",
    validateManifestPayloadPath() {},
    walkMacOSPayload() { throw nativeInventoryReached; },
    fail(message, code) { throw Object.assign(new Error(message), { code }); },
  });
  const manifest = {
    payload: {
      files: [{ ...harness.keytar, normalization: "mach_o_without_code_signature" }],
      links: [], totalBytes: harness.keytar.bytes, payloadSha256: "a".repeat(64),
    },
  };
  await assert.rejects(harness.verifyMacOSBuildPayload("/synthetic", manifest, null, null, token),
    (error) => error === nativeInventoryReached,
    "exact historical inventory must continue to unchanged filesystem/byte verification");
  for (const [key, value] of [
    ["bytes", harness.keytar.bytes - 1], ["mode", "755"], ["sha256", "b".repeat(64)],
    ["normalization", "raw"], ["path", "Contents/Resources/other.node"],
  ]) {
    const changed = structuredClone(manifest);
    changed.payload.files[0][key] = value;
    await assert.rejects(harness.verifyMacOSBuildPayload("/synthetic", changed, null, null, token), {
      code: "MACOS_PAYLOAD_INTEGRITY_FAILED",
    }, key);
  }
  const missing = structuredClone(manifest);
  missing.payload.files = [];
  await assert.rejects(harness.verifyMacOSBuildPayload("/synthetic", missing, null, null, token), {
    code: "MACOS_PAYLOAD_INTEGRITY_FAILED",
  });
  await assert.rejects(harness.verifyMacOSBuildPayload("/synthetic", manifest), ARTIFACT_ERROR,
    "without historical authority the current migration helper remains mandatory");
});

test("native helper compilation and inside-out signing exclude keytar and Node runtime exceptions", async () => {
  const [builder, release] = await Promise.all([
    readFile(join(REPOSITORY_ROOT, "scripts/build-macos-app.js"), "utf8"),
    readFile(join(REPOSITORY_ROOT, "scripts/macos-release-core.js"), "utf8"),
  ]);
  assert.match(builder, /keychainMigrationHelperSources,\s*\{ architecture, buildProfile, migrationHelper: true \}/u);
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
  const architectureStart = builder.indexOf("function machOArchitecture(");
  const architectureEnd = builder.indexOf("\n}\n", architectureStart) + 2;
  assert.equal(architectureStart >= 0 && architectureEnd > architectureStart, true);
  const architectureSource = builder.slice(architectureStart, architectureEnd);
  for (const buildProfile of ["release", "test"]) {
    for (const migrationHelper of [false, true]) {
      for (const [architecture, nativeArchitecture] of [["arm64", "arm64"], ["x64", "x86_64"]]) {
        const calls = [];
        const compile = runInNewContext(`${architectureSource}; (${compileSource})`, {
          PINNED_NODE_ARCHITECTURE: "arm64",
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
            if (command === "/usr/bin/file") return `Mach-O 64-bit executable ${nativeArchitecture}`;
            if (arguments_.includes("--show-sdk-path")) return "/synthetic/macos-sdk";
            if (arguments_.includes("--version")) return "synthetic Swift toolchain";
            return "";
          },
        });
        const destination = migrationHelper
          ? "/synthetic/TiboTattleKeychainMigration" : "/synthetic/TiboTattle";
        await compile(destination, { enabled: false }, {
          files: migrationHelper ? [ENTRYPOINT_SOURCE, SHARED_SOURCE] : [SHARED_SOURCE],
        }, { architecture, buildProfile, migrationHelper });
        const compileCalls = calls.filter(({ command, arguments_ }) =>
          command === "/usr/bin/xcrun" && arguments_.includes("swiftc")
          && !arguments_.includes("--version"));
        assert.equal(compileCalls.length, 1);
        const arguments_ = compileCalls[0].arguments_;
        assert.equal(arguments_[arguments_.indexOf("-target") + 1], `${nativeArchitecture}-apple-macos14.0`);
        assert.equal(arguments_.filter((value) => value === "-lbsm").length, 1);
        assert.equal(arguments_.includes("WebKit"), !migrationHelper);
        assert.equal(arguments_.includes("Security"), migrationHelper);
        assert.equal(arguments_[arguments_.indexOf("-o") + 1], destination);
        assert.equal(arguments_.includes(ENTRYPOINT_SOURCE), migrationHelper);
        assert.equal(calls.some(({ command }) => command.includes("codesign")), false);
      }
    }
  }
});
