// Read-only contract backport from published app source aa660b24.
// This website release branch does not build or activate the native helper.
export const MACOS_KEYCHAIN_MIGRATION_HELPER = Object.freeze({
  executable: "Contents/Helpers/TiboTattleKeychainMigration",
  signingIdentifier: "node",
});
export const MACOS_KEYCHAIN_MIGRATION_HELPER_SOURCES = Object.freeze([
  "apps/macos/Helpers/KeychainMigrationHelper.swift",
  "apps/macos/Sources/KeychainMigration.swift",
]);

function fail() {
  throw Object.assign(new Error(
    "Application omits or changes the reviewed Keychain migration helper contract",
  ), { code: "MACOS_KEYCHAIN_MIGRATION_ARTIFACT_INVALID" });
}

function stableJson(value) {
  const stable = (entry) => {
    if (Array.isArray(entry)) return entry.map(stable);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, stable(entry[key])]));
  };
  return JSON.stringify(stable(value));
}

export function assertMacOSKeychainMigrationManifest(manifest) {
  const helper = manifest?.runtime?.keychainMigrationHelper;
  const helperSources = manifest?.inputs?.keychainMigrationHelperSources;
  const appSources = manifest?.inputs?.swiftSources;
  const files = manifest?.payload?.files;
  const rows = Array.isArray(files) ? files.filter((entry) =>
    entry?.path === MACOS_KEYCHAIN_MIGRATION_HELPER.executable) : [];
  if (stableJson(helper) !== stableJson(MACOS_KEYCHAIN_MIGRATION_HELPER)
      || stableJson(helperSources) !== stableJson(MACOS_KEYCHAIN_MIGRATION_HELPER_SOURCES)
      || !Array.isArray(appSources)
      || !appSources.includes("apps/macos/Sources/KeychainMigration.swift")
      || appSources.includes("apps/macos/Helpers/KeychainMigrationHelper.swift")
      || rows.length !== 1
      || rows[0].normalization !== "mach_o_without_code_signature"
      || rows[0].mode !== "555"
      || !Number.isSafeInteger(rows[0].bytes) || rows[0].bytes < 1
      || typeof rows[0].sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(rows[0].sha256)) fail();
}

function requiresMigrationHelper(version) {
  if (typeof version !== "string"
      || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(version)) fail();
  const [major, minor, patch] = version.split(".").map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) fail();
  return major > 0 || minor > 1 || (minor === 1 && patch >= 17);
}

export function validateMacOSKeychainMigrationSource(source, { channel, shortVersion }) {
  const stableTag = /^v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/u;
  const dogfoodTag = /^tibotattle-internal-dogfood-((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))-rc([1-9][0-9]{0,3})-source-(20[0-9]{2})(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])$/u;
  const match = typeof source?.tag !== "string" ? null
    : channel === "stable" ? stableTag.exec(source.tag)
      : channel === "internal-dogfood" ? dogfoodTag.exec(source.tag) : null;
  const date = match?.[3] === undefined ? null
    : new Date(Date.UTC(Number(match[3]), Number(match[4]) - 1, Number(match[5])));
  if (!source || typeof source !== "object" || Array.isArray(source)
      || Object.keys(source).sort().join(",") !== "commit,tag"
      || typeof source.commit !== "string"
      || !/^[0-9a-f]{40,64}$/u.test(source.commit)
      || match === null || match[1] !== shortVersion
      || (date !== null && (date.getUTCFullYear() !== Number(match[3])
        || date.getUTCMonth() !== Number(match[4]) - 1
        || date.getUTCDate() !== Number(match[5])))) {
    throw Object.assign(new Error("Release application source is not a sealed channel source identity"),
      { code: "MACOS_RELEASE_SOURCE_INVALID" });
  }
  return Object.freeze({ commit: source.commit, tag: source.tag });
}

// Use both build-manifest and signed-plist versions: omitting or downgrading
// one field must never turn a current installer into a pre-helper artifact.
export function validateMacOSKeychainMigrationCompatibility(manifest, shortVersion = null) {
  const manifestVersion = manifest?.application?.shortVersion;
  if (manifestVersion !== undefined && shortVersion !== null
      && manifestVersion !== shortVersion) fail();
  const manifestRequiresHelper = manifestVersion !== undefined
    && requiresMigrationHelper(manifestVersion);
  const plistRequiresHelper = shortVersion !== null && requiresMigrationHelper(shortVersion);
  const currentVersion = manifestRequiresHelper || plistRequiresHelper;
  const helperPresent = manifest?.runtime?.keychainMigrationHelper !== undefined
    || manifest?.inputs?.keychainMigrationHelperSources !== undefined
    || (Array.isArray(manifest?.payload?.files) && manifest.payload.files.some(
      (entry) => entry?.path === MACOS_KEYCHAIN_MIGRATION_HELPER.executable,
    ));
  if (currentVersion || helperPresent) {
    assertMacOSKeychainMigrationManifest(manifest);
    return true;
  }
  return false;
}
