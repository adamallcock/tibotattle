import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, sep } from "node:path";

const require = createRequire(import.meta.url);
const SECRET_BYTES = 32;
const STORED_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NATIVE_BINDING_SPECIFIER = "@github/keytar/prebuilds/darwin-arm64/keytar.node";

// The audited artifact exactly as published: this is the hash of the npm
// prebuild BEFORE any code signing. The Developer ID release pipeline
// re-signs keytar.node in place (hardened-runtime library validation demands
// a same-team signature), which rewrites the Mach-O, so a production install
// can never match these bytes. Signed derivatives are accepted through the
// designated-requirement verification below instead.
export const KEYTAR_DARWIN_ARM64_SHA256 = "855c21e1e702967230bd87f600d04c311b77f29150f3372d547e72882c58de6a";
// The two facts a signed derivative must prove, and nothing build-specific:
// the Apple Developer ID team that signs this product's releases, and the
// code identifier codesign derives for the keytar prebuild. Together they are
// the binding's designated requirement — stable across every properly signed
// build, unlike a CDHash or a byte digest of a signed binary.
export const KEYTAR_SIGNING_TEAM_IDENTIFIER = "43RTH622SB";
export const KEYTAR_SIGNING_CODE_IDENTIFIER = "keytar";
const CODESIGN_PATH = "/usr/bin/codesign";
const SECURITY_PATH = "/usr/bin/security";
// errSecItemNotFound surfaces from the security CLI as exit status 44.
const SECURITY_ITEM_NOT_FOUND_STATUS = 44;

export const EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES = Object.freeze({
  exportIdentity: Object.freeze({
    service: "app-usagemonitor.export-identity.v1",
    account: "installation",
  }),
  accountObservation: Object.freeze({
    service: "app-usagemonitor.account-observation.v1",
    account: "installation",
  }),
  claudeSessionPseudonym: Object.freeze({
    service: "app-usagemonitor.claude-session-pseudonym.v1",
    account: "installation",
  }),
  contributionDevice: Object.freeze({
    service: "app-usagemonitor.contribution-device.v1",
    account: "installation",
  }),
});

const ERROR_CODES = new Set([
  "unsupported_platform",
  "unsupported_architecture",
  "invalid_configuration",
  "binding_unavailable",
  "binding_integrity",
  "invalid_capability",
  "invalid_secret",
  "stored_value_invalid",
  "operation_failed",
  "locked",
  "denied",
  "readback_mismatch",
]);

export class ExportIdentityKeychainError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) throw new TypeError("Unknown export identity Keychain error code");
    super("macOS Keychain backend failed");
    this.name = "ExportIdentityKeychainError";
    this.code = `export_identity_keychain_${code}`;
  }
}

function fail(code) {
  throw new ExportIdentityKeychainError(code);
}

function validateBinding(binding) {
  let valid = false;
  try {
    valid = binding !== null && typeof binding === "object"
      && typeof binding.getPassword === "function"
      && typeof binding.setPassword === "function"
      && typeof binding.deletePassword === "function";
  } catch {
    // Treat hostile or broken binding property access as configuration failure.
  }
  if (!valid) fail("invalid_configuration");
  return binding;
}

/**
 * The exact requirement string a signed keytar binding must satisfy: Apple's
 * generic anchor, this product's Developer ID team, and the binding's own
 * code identifier. Deliberately nothing else — no version, no CDHash, no
 * certificate serial — so a Sparkle update signed by the same team keeps
 * passing while any other origin fails.
 */
export function keytarSignedBindingRequirement() {
  return "anchor apple generic"
    + ` and certificate leaf[subject.OU] = "${KEYTAR_SIGNING_TEAM_IDENTIFIER}"`
    + ` and identifier "${KEYTAR_SIGNING_CODE_IDENTIFIER}"`;
}

/**
 * The constructed codesign invocation, exported so a test can pin the exact
 * arguments without a signed binary: --verify validates the embedded
 * signature's page hashes, --strict keeps the validation modern, and
 * -R= makes codesign additionally test the designated requirement above.
 */
export function keytarSignedBindingVerificationArguments(bindingPath) {
  return Object.freeze([
    "--verify",
    "--strict",
    `-R=${keytarSignedBindingRequirement()}`,
    "--",
    bindingPath,
  ]);
}

function defaultRunVerificationCommand(command, commandArguments) {
  const outcome = spawnSync(command, commandArguments, {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return { status: outcome.status };
}

/**
 * Load only trusted bytes at the audited prebuild path: either the exact
 * audited npm artifact (development installs, byte-pinned), or a signed
 * derivative of it that macOS proves was signed by this product's Developer
 * ID team with the binding's own identifier. The Developer ID release
 * pipeline verifies the audited bytes immediately before signing, so the
 * signed acceptance chains back to the same audit. The package JavaScript
 * loader is deliberately bypassed so it cannot select a build artifact at
 * runtime.
 */
export function loadExportIdentityKeychainBinding(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("invalid_configuration");
  const {
    platform = process.platform,
    architecture = process.arch,
    resolveBinding = (specifier) => require.resolve(specifier),
    readBinding = (path) => readFileSync(path),
    requireBinding = (path) => require(path),
    runVerificationCommand = defaultRunVerificationCommand,
  } = options;
  if (platform !== "darwin") fail("unsupported_platform");
  if (architecture !== "arm64") fail("unsupported_architecture");
  if (typeof resolveBinding !== "function" || typeof readBinding !== "function"
      || typeof requireBinding !== "function"
      || typeof runVerificationCommand !== "function") fail("invalid_configuration");

  let bindingPath;
  let bindingBytes;
  try {
    bindingPath = resolveBinding(NATIVE_BINDING_SPECIFIER);
    const requiredSuffix = ["prebuilds", "darwin-arm64", "keytar.node"].join(sep);
    if (typeof bindingPath !== "string" || !isAbsolute(bindingPath)
        || !bindingPath.endsWith(`${sep}${requiredSuffix}`)) fail("invalid_configuration");
    bindingBytes = readBinding(bindingPath);
  } catch (error) {
    if (error instanceof ExportIdentityKeychainError) throw error;
    fail("binding_unavailable");
  }

  if (!Buffer.isBuffer(bindingBytes) && !(bindingBytes instanceof Uint8Array)) {
    fail("invalid_configuration");
  }
  const digest = createHash("sha256").update(bindingBytes).digest("hex");
  if (digest !== KEYTAR_DARWIN_ARM64_SHA256) {
    // Not the audited bytes. Signing rewrites the Mach-O, so this is the
    // expected state of every Developer ID build (observed live 2026-08-10:
    // the byte pin alone turned the first signed Sparkle update into a total
    // Keychain outage). Accept the file only if macOS proves it carries a
    // valid signature satisfying the designated requirement; anything else
    // stays failed closed.
    let verified = false;
    try {
      const outcome = runVerificationCommand(
        CODESIGN_PATH,
        keytarSignedBindingVerificationArguments(bindingPath),
      );
      verified = outcome !== null && typeof outcome === "object"
        && outcome.status === 0;
    } catch {
      // Verification failures are content-free: fall through to fail closed.
    }
    if (!verified) fail("binding_integrity");
  }

  try {
    return validateBinding(requireBinding(bindingPath));
  } catch (error) {
    if (error instanceof ExportIdentityKeychainError) throw error;
    fail("binding_unavailable");
  }
}

function capabilityPair(capability) {
  if (capability === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity) {
    return EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity;
  }
  if (capability === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation) {
    return EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation;
  }
  if (capability === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym) {
    return EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym;
  }
  if (capability === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice) {
    return EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice;
  }
  fail("invalid_capability");
}

function copySecret(secret) {
  if (!Buffer.isBuffer(secret) || secret.byteLength !== SECRET_BYTES) fail("invalid_secret");
  return Buffer.from(secret);
}

function decodeStoredSecret(value, errorCode = "stored_value_invalid") {
  if (typeof value !== "string" || !STORED_SECRET_PATTERN.test(value)) fail(errorCode);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== SECRET_BYTES || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    fail(errorCode);
  }
  return decoded;
}

function sameSecret(left, right) {
  return timingSafeEqual(left, right);
}

const LOCKED_ERROR_CODES = new Set([
  "ERR_KEYCHAIN_LOCKED",
  "KEYCHAIN_LOCKED",
  "errSecInteractionNotAllowed",
  -25308,
]);
const DENIED_ERROR_CODES = new Set([
  "ERR_KEYCHAIN_DENIED",
  "KEYCHAIN_DENIED",
  "errSecAuthFailed",
  "errSecUserCanceled",
  -25293,
  -128,
]);
const LOCKED_ERROR_MESSAGES = new Set([
  "User interaction is not allowed.",
]);
const DENIED_ERROR_MESSAGES = new Set([
  "The user name or passphrase you entered is not correct.",
  "User canceled the operation.",
]);

function nativeFailureCode(error) {
  let code;
  let message;
  try {
    code = error?.code;
    message = error?.message;
  } catch {
    return "operation_failed";
  }
  if (LOCKED_ERROR_CODES.has(code)) return "locked";
  if (DENIED_ERROR_CODES.has(code)) return "denied";
  // The audited keytar native binding exposes Security.framework failures as
  // message-only Napi errors. Match only exact platform strings; never include
  // an upstream message in the public error.
  if (LOCKED_ERROR_MESSAGES.has(message)) return "locked";
  if (DENIED_ERROR_MESSAGES.has(message)) return "denied";
  return "operation_failed";
}

/**
 * This adapter intentionally does not claim compare-and-swap semantics.
 * Callers must hold the app's installation/export-identity lease around every
 * create, replace, or delete transaction.
 */
export function createExportIdentityKeychainBackend(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("invalid_configuration");
  const {
    binding = undefined,
    loadBinding = loadExportIdentityKeychainBinding,
  } = options;
  if (typeof loadBinding !== "function") fail("invalid_configuration");
  let selectedBinding = binding;
  if (selectedBinding === undefined) {
    try {
      selectedBinding = loadBinding();
    } catch (error) {
      if (error instanceof ExportIdentityKeychainError) throw error;
      fail("binding_unavailable");
    }
  }
  const nativeBinding = validateBinding(selectedBinding);

  async function invoke(method, ...args) {
    try {
      return await nativeBinding[method](...args);
    } catch (error) {
      fail(nativeFailureCode(error));
    }
  }

  async function describe(capability) {
    capabilityPair(capability);
    return Object.freeze({ backend: "macos_keychain", status: "available" });
  }

  async function readInternal(capability, invalidCode = "stored_value_invalid") {
    const pair = capabilityPair(capability);
    const stored = await invoke("getPassword", pair.service, pair.account);
    if (stored === null) return null;
    return decodeStoredSecret(stored, invalidCode);
  }

  async function read(capability) {
    let secret = null;
    try {
      secret = await readInternal(capability);
      return secret === null ? null : Buffer.from(secret);
    } finally {
      secret?.fill(0);
    }
  }

  async function createIfMissing(capability, generatedSecret) {
    const pair = capabilityPair(capability);
    let generated = null;
    let existing = null;
    let readback = null;
    try {
      generated = copySecret(generatedSecret);
      existing = await readInternal(capability);
      if (existing !== null) return "existing";
      await invoke("setPassword", pair.service, pair.account, generated.toString("base64url"));
      readback = await readInternal(capability, "readback_mismatch");
      if (readback === null || !sameSecret(readback, generated)) fail("readback_mismatch");
      return "created";
    } finally {
      generated?.fill(0);
      existing?.fill(0);
      readback?.fill(0);
    }
  }

  async function replaceExact(capability, expectedSecret, replacementSecret) {
    const pair = capabilityPair(capability);
    let expected = null;
    let replacement = null;
    let current = null;
    let readback = null;
    try {
      expected = copySecret(expectedSecret);
      replacement = copySecret(replacementSecret);
      current = await readInternal(capability);
      if (current === null) return "missing";
      if (!sameSecret(current, expected)) return "conflict";
      await invoke("setPassword", pair.service, pair.account, replacement.toString("base64url"));
      readback = await readInternal(capability, "readback_mismatch");
      if (readback === null || !sameSecret(readback, replacement)) fail("readback_mismatch");
      return "replaced";
    } finally {
      expected?.fill(0);
      replacement?.fill(0);
      current?.fill(0);
      readback?.fill(0);
    }
  }

  async function deleteExact(capability, expectedSecret) {
    const pair = capabilityPair(capability);
    let expected = null;
    let current = null;
    let readback = null;
    try {
      expected = copySecret(expectedSecret);
      current = await readInternal(capability);
      if (current === null) return "missing";
      if (!sameSecret(current, expected)) return "conflict";
      await invoke("deletePassword", pair.service, pair.account);
      readback = await readInternal(capability, "readback_mismatch");
      if (readback !== null) fail("readback_mismatch");
      return "deleted";
    } finally {
      expected?.fill(0);
      current?.fill(0);
      readback?.fill(0);
    }
  }

  return Object.freeze({ read, createIfMissing, replaceExact, deleteExact, describe });
}

/**
 * The constructed security invocation for an attribute-addressed delete,
 * exported so a test can pin the exact arguments. Deleting by service and
 * account never decrypts the item, so it needs neither the native binding
 * nor the item's access control list — it works in exactly the states where
 * a read cannot (verified live 2026-08-10 against a credential the updated
 * app could no longer read).
 */
export function exportIdentityKeychainAttributeDeleteArguments(capability) {
  const pair = capabilityPair(capability);
  return Object.freeze([
    "delete-generic-password",
    "-s",
    pair.service,
    "-a",
    pair.account,
  ]);
}

function defaultRunAttributeDeleteCommand(command, commandArguments) {
  // The security CLI prints the deleted item's attributes on success; they
  // are discarded unread so nothing about the item can enter an error, a
  // log, or a caller.
  const outcome = spawnSync(command, commandArguments, {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return { status: outcome.status };
}

/**
 * Delete a capability's Keychain item by its fixed attributes, without ever
 * reading the secret. This is the repair path for a credential the ordinary
 * backend cannot read — a broken access control list, or a native binding
 * that cannot even load — and must therefore depend on neither.
 */
export function deleteExportIdentityKeychainItemByAttributes(
  capability,
  options = {},
) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  const {
    platform = process.platform,
    runCommand = defaultRunAttributeDeleteCommand,
  } = options;
  const commandArguments =
    exportIdentityKeychainAttributeDeleteArguments(capability);
  if (platform !== "darwin") fail("unsupported_platform");
  if (typeof runCommand !== "function") fail("invalid_configuration");
  let outcome;
  try {
    outcome = runCommand(SECURITY_PATH, commandArguments);
  } catch {
    fail("operation_failed");
  }
  const status = outcome !== null && typeof outcome === "object"
    ? outcome.status
    : undefined;
  if (status === 0) return "deleted";
  if (status === SECURITY_ITEM_NOT_FOUND_STATUS) return "missing";
  fail("operation_failed");
}
