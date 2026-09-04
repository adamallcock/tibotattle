import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { PRODUCT_BRAND } from "../config/product-brand.js";
import {
  MACOS_KEYCHAIN_MIGRATION_HELPER,
  MACOS_KEYCHAIN_MIGRATION_HELPER_SOURCES,
  assertMacOSKeychainMigrationManifest,
  validateMacOSKeychainMigrationCompatibility,
  validateMacOSKeychainMigrationSource,
} from "../scripts/macos-keychain-migration-validation.js";
import {
  expectedMacOSPayloadNormalization,
  validateMacOSKeychainMigrationSignatureDescriptions,
  verifyMacOSKeychainMigrationSignatures,
} from "../scripts/macos-release-core.js";

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

test("version compatibility preserves historical readers without admitting helper omissions or downgrades", () => {
  assert.equal(validateMacOSKeychainMigrationCompatibility({
    application: { shortVersion: "0.1.16" },
  }, "0.1.16"), false);
  for (const version of ["0.1.17", "0.1.18", "0.2.0", "1.0.0"]) {
    const manifest = buildManifest();
    manifest.application = { shortVersion: version };
    assert.equal(validateMacOSKeychainMigrationCompatibility(manifest, version), true);
    assert.throws(() => validateMacOSKeychainMigrationCompatibility({
      application: { shortVersion: version },
    }, version), ARTIFACT_ERROR);
  }
  const manifest = buildManifest();
  manifest.application = { shortVersion: "0.1.17" };
  for (const [changed, plistVersion] of [
    [{ ...manifest, application: { shortVersion: "0.1.16" } }, "0.1.17"],
    [manifest, "0.1.16"],
    [{ application: {} }, "0.1.17"],
    [{ application: { shortVersion: "0.1.17" } }, null],
  ]) {
    assert.throws(() => validateMacOSKeychainMigrationCompatibility(changed, plistVersion),
      ARTIFACT_ERROR);
  }
  for (const version of ["", "0.1.17-rc1", "00.1.16", "99999999999999999999.0.0", null]) {
    assert.throws(() => validateMacOSKeychainMigrationCompatibility({
      application: { shortVersion: version },
    }), ARTIFACT_ERROR);
  }
  // A partially erased helper remains mandatory even if a version was downgraded.
  for (const erase of ["runtime", "inputs", "payload"]) {
    const changed = buildManifest();
    changed.application = { shortVersion: "0.1.16" };
    delete changed[erase];
    assert.throws(() => validateMacOSKeychainMigrationCompatibility(changed), ARTIFACT_ERROR);
  }
});

test("helper source seals bind the exact channel and version with no legacy opt-out", () => {
  const source = { commit: "a".repeat(40), tag: "v0.1.17" };
  const options = { channel: "stable", shortVersion: "0.1.17" };
  assert.deepEqual(validateMacOSKeychainMigrationSource(source, options), source);
  for (const changed of [
    undefined, null, {}, { ...source, commit: "invalid" },
    { ...source, repository: "unreviewed" }, { ...source, tag: "v0.1.16" },
    { ...source, tag: "v0.1.17-rc1" },
  ]) {
    assert.throws(() => validateMacOSKeychainMigrationSource(changed, options),
      { code: "MACOS_RELEASE_SOURCE_INVALID" });
  }
  assert.throws(() => validateMacOSKeychainMigrationSource(source, {
    ...options, shortVersion: "0.1.16",
  }), { code: "MACOS_RELEASE_SOURCE_INVALID" });
  const dogfood = { ...source, tag: "tibotattle-internal-dogfood-0.1.17-rc2-source-20260831" };
  assert.deepEqual(validateMacOSKeychainMigrationSource(dogfood, {
    ...options, channel: "internal-dogfood",
  }), dogfood);
  for (const tag of [dogfood.tag, dogfood.tag.replace("20260831", "20260230")]) {
    assert.throws(() => validateMacOSKeychainMigrationSource({ ...source, tag }, options),
      { code: "MACOS_RELEASE_SOURCE_INVALID" });
  }
  assert.throws(() => validateMacOSKeychainMigrationSource({
    ...dogfood, tag: dogfood.tag.replace("20260831", "20260230"),
  }, { ...options, channel: "internal-dogfood" }), { code: "MACOS_RELEASE_SOURCE_INVALID" });
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

test("helper inventory remains byte-bound and complete after normalization compatibility", async () => {
  const source = await readFile(new URL("../scripts/macos-release-core.js", import.meta.url), "utf8");
  const start = source.indexOf("async function verifyMacOSBuildPayload(");
  const end = source.indexOf("\nfunction parsePlist(", start);
  assert.ok(start > 0 && end > start);
  const helperPath = MACOS_KEYCHAIN_MIGRATION_HELPER.executable;
  const basePaths = ["Contents/MacOS/TiboTattle", "Contents/Resources/runtime/bin/node"];
  const manifestPath = "Contents/Resources/build-manifest.json";
  const legacyPath = "Contents/Resources/app/node_modules/@github/keytar/prebuilds/darwin-arm64/keytar.node";
  const bytes = new Map([helperPath, ...basePaths].map((path) => [path, Buffer.from(path)]));
  const manifest = buildManifest();
  manifest.application = { shortVersion: "0.1.17" };
  const aggregate = createHash("sha256");
  manifest.payload.files = [...bytes].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => {
    aggregate.update(path).update("\0").update(content).update("\0");
    return { path, bytes: content.length, mode: "555",
      normalization: expectedMacOSPayloadNormalization(path),
      sha256: createHash("sha256").update(content).digest("hex") };
  });
  manifest.payload.links = [];
  manifest.payload.totalBytes = [...bytes.values()].reduce((sum, content) => sum + content.length, 0);
  manifest.payload.payloadSha256 = aggregate.digest("hex");
  let observedFiles = [...bytes.keys(), manifestPath];
  let helperMode = 0o555;
  const normalizedPaths = [];
  const verifier = runInNewContext(source.slice(start, end) + "\nverifyMacOSBuildPayload", {
    validateMacOSKeychainMigrationCompatibility, expectedMacOSPayloadNormalization,
    MACOS_KEYCHAIN_MIGRATION_HELPER, BASE_NORMALIZED_MACH_O_PATHS: basePaths,
    LEGACY_NORMALIZED_MACH_O_PATHS: [legacyPath], SPARKLE_NORMALIZED_MACH_O_PATHS: [],
    BUILD_MANIFEST_PATH: manifestPath, CODE_RESOURCES_PATH: "Contents/_CodeSignature/CodeResources",
    APPLE_STAPLED_TICKET_PATH: "Contents/CodeResources",
    EMBEDDED_PROFILE_PATH: "Contents/embedded.provisionprofile",
    validateManifestPayloadPath() {}, createHash, join,
    fail(message, code) { throw Object.assign(new Error(message), { code }); },
    async walkMacOSPayload() { return { files: observedFiles, directories: [] }; },
    async regularPath(path) { return { mode: path.endsWith(helperPath) ? helperMode : 0o555 }; },
    async normalizedMachOBytes(path) {
      normalizedPaths.push(path);
      return bytes.get(path.slice("/synthetic/".length));
    },
    async readFile() { assert.fail("Every fixture executable must use reviewed normalization"); },
  });
  await verifier("/synthetic", manifest);
  assert.ok(normalizedPaths.includes(join("/synthetic", helperPath)));
  const originalHelper = bytes.get(helperPath);
  bytes.set(helperPath, Buffer.from("altered helper"));
  await assert.rejects(verifier("/synthetic", manifest), { code: "MACOS_PAYLOAD_INTEGRITY_FAILED" });
  bytes.set(helperPath, originalHelper);
  helperMode = 0o755;
  await assert.rejects(verifier("/synthetic", manifest), { code: "MACOS_PAYLOAD_INTEGRITY_FAILED" });
  helperMode = 0o555;
  observedFiles = observedFiles.filter((path) => path !== helperPath);
  await assert.rejects(verifier("/synthetic", manifest), { code: "MACOS_PAYLOAD_INTEGRITY_FAILED" });
  observedFiles = [...bytes.keys(), manifestPath, "Contents/Helpers/Unreviewed"];
  await assert.rejects(verifier("/synthetic", manifest), { code: "MACOS_PAYLOAD_INTEGRITY_FAILED" });
  observedFiles = [...bytes.keys(), manifestPath];
  manifest.payload.payloadSha256 = "b".repeat(64);
  await assert.rejects(verifier("/synthetic", manifest), { code: "MACOS_PAYLOAD_INTEGRITY_FAILED" });
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
