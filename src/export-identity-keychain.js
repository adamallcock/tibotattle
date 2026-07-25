import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, sep } from "node:path";

const require = createRequire(import.meta.url);
const SECRET_BYTES = 32;
const STORED_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NATIVE_BINDING_SPECIFIER = "@github/keytar/prebuilds/darwin-arm64/keytar.node";

export const KEYTAR_DARWIN_ARM64_SHA256 = "855c21e1e702967230bd87f600d04c311b77f29150f3372d547e72882c58de6a";

export const EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES = Object.freeze({
  exportIdentity: Object.freeze({
    service: "app-usagemonitor.export-identity.v1",
    account: "installation",
  }),
  accountObservation: Object.freeze({
    service: "app-usagemonitor.account-observation.v1",
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
 * Load only the audited macOS arm64 prebuild. The package JavaScript loader is
 * deliberately bypassed so it cannot select a build artifact at runtime.
 */
export function loadExportIdentityKeychainBinding(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("invalid_configuration");
  const {
    platform = process.platform,
    architecture = process.arch,
    resolveBinding = (specifier) => require.resolve(specifier),
    readBinding = (path) => readFileSync(path),
    requireBinding = (path) => require(path),
  } = options;
  if (platform !== "darwin") fail("unsupported_platform");
  if (architecture !== "arm64") fail("unsupported_architecture");
  if (typeof resolveBinding !== "function" || typeof readBinding !== "function"
      || typeof requireBinding !== "function") fail("invalid_configuration");

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
  if (digest !== KEYTAR_DARWIN_ARM64_SHA256) fail("binding_integrity");

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
  fail("invalid_capability");
}

function copySecret(secret) {
  if (!Buffer.isBuffer(secret) || secret.byteLength !== SECRET_BYTES) fail("invalid_secret");
  return Buffer.from(secret);
}

function decodeStoredSecret(value, errorCode = "stored_value_invalid") {
  if (typeof value !== "string" || !STORED_SECRET_PATTERN.test(value)) fail(errorCode);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== SECRET_BYTES || decoded.toString("base64url") !== value) fail(errorCode);
  return decoded;
}

function sameSecret(left, right) {
  return timingSafeEqual(left, right);
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
    } catch {
      fail("operation_failed");
    }
  }

  async function readInternal(capability, invalidCode = "stored_value_invalid") {
    const pair = capabilityPair(capability);
    const stored = await invoke("getPassword", pair.service, pair.account);
    if (stored === null) return null;
    return decodeStoredSecret(stored, invalidCode);
  }

  async function read(capability) {
    const secret = await readInternal(capability);
    return secret === null ? null : Buffer.from(secret);
  }

  async function createIfMissing(capability, generatedSecret) {
    const pair = capabilityPair(capability);
    const generated = copySecret(generatedSecret);
    if (await readInternal(capability) !== null) return "existing";
    await invoke("setPassword", pair.service, pair.account, generated.toString("base64url"));
    const readback = await readInternal(capability, "readback_mismatch");
    if (readback === null || !sameSecret(readback, generated)) fail("readback_mismatch");
    return "created";
  }

  async function replaceExact(capability, expectedSecret, replacementSecret) {
    const pair = capabilityPair(capability);
    const expected = copySecret(expectedSecret);
    const replacement = copySecret(replacementSecret);
    const current = await readInternal(capability);
    if (current === null) return "missing";
    if (!sameSecret(current, expected)) return "conflict";
    await invoke("setPassword", pair.service, pair.account, replacement.toString("base64url"));
    const readback = await readInternal(capability, "readback_mismatch");
    if (readback === null || !sameSecret(readback, replacement)) fail("readback_mismatch");
    return "replaced";
  }

  async function deleteExact(capability, expectedSecret) {
    const pair = capabilityPair(capability);
    const expected = copySecret(expectedSecret);
    const current = await readInternal(capability);
    if (current === null) return "missing";
    if (!sameSecret(current, expected)) return "conflict";
    await invoke("deletePassword", pair.service, pair.account);
    if (await readInternal(capability, "readback_mismatch") !== null) fail("readback_mismatch");
    return "deleted";
  }

  return Object.freeze({ read, createIfMissing, replaceExact, deleteExact });
}
