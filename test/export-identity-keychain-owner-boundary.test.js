import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as legacy from "../src/export-identity-keychain.js";
import * as platform from "../src/platform/export-identity-keychain.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const EXPECTED_EXPORTS = Object.freeze([
  "CONTRIBUTION_DEVICE_READER_CODE_IDENTIFIER",
  "CONTRIBUTION_DEVICE_READER_TEAM_IDENTIFIER",
  "EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES",
  "ExportIdentityKeychainError",
  "KEYTAR_DARWIN_ARM64_SHA256",
  "KEYTAR_SIGNING_CODE_IDENTIFIER",
  "KEYTAR_SIGNING_TEAM_IDENTIFIER",
  "MACOS_APP_KEYCHAIN_CAPABILITIES",
  "contributionDeviceDurableAddArguments",
  "contributionDeviceReaderRequirement",
  "contributionDeviceReaderRequirementVerificationArguments",
  "createExportIdentityKeychainBackend",
  "deleteExportIdentityKeychainItemByAttributes",
  "exportIdentityKeychainAttributeDeleteArguments",
  "exportIdentityKeychainAttributeProbeArguments",
  "exportIdentityKeychainCapabilitiesForEnvironment",
  "exportIdentityKeychainItemPresenceByAttributes",
  "keytarSignedBindingRequirement",
  "keytarSignedBindingVerificationArguments",
  "loadExportIdentityKeychainBinding",
]);

test("legacy Keychain exports are exact identities of the platform owner", () => {
  assert.deepEqual(Object.keys(platform).sort(), [...EXPECTED_EXPORTS].sort());
  assert.deepEqual(Object.keys(legacy).sort(), [...EXPECTED_EXPORTS].sort());
  for (const name of EXPECTED_EXPORTS) {
    assert.equal(legacy[name], platform[name], name);
  }
});

test("the legacy path is implementation-free and macOS packaging excludes keytar", async () => {
  const legacySource = await readFile(
    resolve(REPOSITORY_ROOT, "src/export-identity-keychain.js"),
    "utf8",
  );
  assert.match(
    legacySource,
    /from "\.\/platform\/index\.js";/u,
  );
  assert.doesNotMatch(
    legacySource,
    /\b(?:class|const|function|let|var)\b|node:|@github\/keytar/u,
  );

  const buildSource = await readFile(
    resolve(REPOSITORY_ROOT, "scripts/build-macos-app.js"),
    "utf8",
  );
  assert.doesNotMatch(
    buildSource,
    /DYNAMIC_EXTERNAL_BY_FILE|"@github\/keytar": "7\.10\.6"/u,
  );
  const currentNormalizationStart = buildSource.indexOf(
    "const NORMALIZED_MACH_O_PATHS",
  );
  const retiredCompatibilityStart = buildSource.indexOf(
    "const RETIRED_PREVIEW_NORMALIZED_MACH_O_PATHS",
  );
  const noCompatibilityStart = buildSource.indexOf(
    "const NO_COMPATIBILITY_NORMALIZED_MACH_O_PATHS",
  );
  assert.notEqual(currentNormalizationStart, -1);
  assert.notEqual(retiredCompatibilityStart, -1);
  assert.notEqual(noCompatibilityStart, -1);
  assert.ok(retiredCompatibilityStart > currentNormalizationStart);
  assert.ok(noCompatibilityStart > retiredCompatibilityStart);
  const currentNormalizationSource = buildSource.slice(
    currentNormalizationStart,
    retiredCompatibilityStart,
  );
  assert.doesNotMatch(currentNormalizationSource, /@github\/keytar|keytar\.node/u);
  const retiredCompatibilitySource = buildSource.slice(
    retiredCompatibilityStart,
    noCompatibilityStart,
  );
  assert.match(
    retiredCompatibilitySource,
    /Contents\/Resources\/app\/node_modules\/@github\/keytar\/prebuilds\/darwin-arm64\/keytar\.node/u,
  );
  assert.equal(buildSource.match(/keytar\.node/gu)?.length, 1);
  assert.doesNotMatch(
    buildSource.slice(
      buildSource.indexOf("const EXPECTED_EXTERNAL_SPECIFIERS"),
      buildSource.indexOf("const WORKSPACE_RUNTIME_PACKAGE_EXTERNALS"),
    ),
    /@github\/keytar/u,
  );
});
