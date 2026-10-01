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

test("the legacy path is implementation-free and current historical validation confines keytar to predecessor receipts", async () => {
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

  const releaseSource = await readFile(
    resolve(REPOSITORY_ROOT, "scripts/macos-release-core.js"),
    "utf8",
  );
  const currentNormalization = releaseSource.slice(
    releaseSource.indexOf("const BASE_NORMALIZED_MACH_O_PATHS"),
    releaseSource.indexOf("const NORMALIZED_MACH_O_PATHS"),
  );
  assert.doesNotMatch(currentNormalization, /@github\/keytar|keytar\.node/u);
  assert.match(releaseSource, /LEGACY_STABLE_PREVIOUS_RELEASE/u);
  assert.match(releaseSource, /Contents\/Resources\/app\/node_modules\/@github\/keytar\/prebuilds\/darwin-arm64\/keytar\.node/u);
});
