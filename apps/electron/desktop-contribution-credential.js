import { timingSafeEqual } from "node:crypto";
import { createPosixDesktopSettingsBackend, createWindowsDesktopSettingsBackend } from "./desktop-settings-backends.js";

const FILE = "accountless-installation-credential-v1.json";
const SCHEMA = "accountless-encrypted-credential-v1";
const LIMIT = 4096;
const TEMPORARILY_UNAVAILABLE_MESSAGE = "safeStorage.decryptStringAsync is temporarily unavailable. Please try again.";
const failures = new WeakSet();
const unavailable = ({ retryable = false } = {}) => {
  const error = Object.assign(new Error("Installation credential unavailable"),
    { code: "contribution_device_credential_unavailable", retryable: retryable === true });
  failures.add(error);
  return error;
};
const knownFailure = (error) => error !== null && typeof error === "object" && failures.has(error);
const preserveFailure = (error) => knownFailure(error) ? error : unavailable();
const temporarySafeStorageFailure = (error) => {
  try { return error?.message === TEMPORARILY_UNAVAILABLE_MESSAGE; } catch { return false; }
};
const temporaryStorageFailure = (error) => {
  try { return error?.code === "desktop_settings_backend_unavailable"; } catch { return false; }
};
function validate(value) {
  if (!value || Object.keys(value).sort().join(",") !== "encrypted,schemaVersion"
      || value.schemaVersion !== SCHEMA
      || (value.encrypted !== null && (typeof value.encrypted !== "string"
        || !/^[A-Za-z0-9+/]{4,3072}={0,2}$/u.test(value.encrypted)))) throw unavailable();
  return value;
}
const codec = {
  encode(value) { validate(value); return { value, bytes: Buffer.from(`${JSON.stringify(value)}\n`) }; },
  decodeBytes(bytes) { return validate(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); },
  decodeValue: validate,
};

/**
 * Inspect only the old ciphertext record before a production macOS native
 * backend mints an accountless identity. This deliberately never calls
 * safeStorage, decrypts, rewrites, or deletes the record: an encrypted or
 * unreadable legacy file must remain an explicit recovery boundary.
 */
export function createDesktopContributionCredentialLegacyProbe({
  platform = process.platform,
  rootPath,
  storage,
} = {}) {
  if (platform !== "darwin") throw new TypeError("legacy credential probe is macOS-only");
  const selected = storage ?? createPosixDesktopSettingsBackend({
    platform,
    rootPath,
    filename: FILE,
    maximumBytes: LIMIT,
    codec,
  });
  if (!selected || typeof selected.load !== "function") {
    throw new TypeError("legacy credential probe storage is invalid");
  }
  return Object.freeze({
    async inspect() {
      let stored;
      try { stored = await selected.load(); }
      catch { return "unavailable"; }
      try {
        if (stored === null) return "absent";
        return validate(stored).encrypted === null ? "absent" : "present";
      } catch {
        return "unavailable";
      }
    },
  });
}

export function createDesktopContributionCredentialBackend({
  safeStorage, platform = process.platform, rootPath, windowsProtectedStateStore, storage,
} = {}) {
  const selected = storage ?? (platform === "win32"
    ? createWindowsDesktopSettingsBackend({ platform, rootPath, windowsProtectedStateStore, childName: FILE, maximumBytes: LIMIT, codec })
    : createPosixDesktopSettingsBackend({ platform, rootPath, filename: FILE, maximumBytes: LIMIT, codec }));
  let queue = Promise.resolve();
  const serialize = (operation) => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => {});
    return next;
  };
  const ready = async () => {
    // No synchronous crypto, plaintext fallback, or silent alternate store.
    if (!safeStorage || typeof safeStorage.isAsyncEncryptionAvailable !== "function"
        || typeof safeStorage.encryptStringAsync !== "function"
        || typeof safeStorage.decryptStringAsync !== "function"
        || (platform === "linux" && !new Set(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"])
          .has(safeStorage.getSelectedStorageBackend?.()))) throw unavailable();
    let available;
    try { available = await safeStorage.isAsyncEncryptionAvailable(); }
    catch { throw unavailable(); }
    // Electron's async provider can be temporarily unavailable after readiness.
    // There is no credential access until a later bounded pass rechecks it.
    if (available !== true) throw unavailable({ retryable: true });
  };
  const load = async () => {
    try { return await selected.load(); }
    catch (error) { throw unavailable({ retryable: temporaryStorageFailure(error) }); }
  };
  const save = async (value) => {
    try { await selected.save(value); }
    catch (error) { throw unavailable({ retryable: temporaryStorageFailure(error) }); }
  };
  const credential = (value) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) throw unavailable();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length !== 32) {
      bytes.fill(0);
      throw unavailable();
    }
    return bytes;
  };
  const decrypt = async (value) => {
    let encrypted = null;
    try {
      encrypted = Buffer.from(value, "base64");
      const decrypted = await safeStorage.decryptStringAsync(encrypted);
      if (!decrypted || typeof decrypted.result !== "string"
          || typeof decrypted.shouldReEncrypt !== "boolean") throw unavailable();
      // Validate before any rewrite so malformed plaintext is never published.
      credential(decrypted.result).fill(0);
      return decrypted;
    } catch (error) {
      if (knownFailure(error)) throw error;
      throw unavailable({ retryable: temporarySafeStorageFailure(error) });
    } finally {
      encrypted?.fill(0);
    }
  };
  const encrypt = async (value) => {
    let encrypted;
    try { encrypted = await safeStorage.encryptStringAsync(value); }
    catch (error) { throw unavailable({ retryable: temporarySafeStorageFailure(error) }); }
    if (!Buffer.isBuffer(encrypted) || encrypted.length < 4 || encrypted.length > 2304) {
      encrypted?.fill?.(0);
      throw unavailable();
    }
    return encrypted;
  };
  const read = async ({ allowReencrypt = true } = {}) => {
    await ready();
    const stored = await load();
    if (stored === null || validate(stored).encrypted === null) return null;
    const decrypted = await decrypt(stored.encrypted);
    if (!decrypted.shouldReEncrypt) return credential(decrypted.result);
    // Chromium's Encryptor contract requires a fresh Encrypt call when this
    // flag is set. Persist it through the atomic desktop settings backend, then
    // prove the published ciphertext still decrypts to the same installation key.
    if (!allowReencrypt) throw unavailable();
    const expected = credential(decrypted.result);
    let encrypted = null;
    let candidate = null;
    let observed = null;
    let returned = false;
    try {
      encrypted = await encrypt(decrypted.result);
      const candidateDecrypted = await decrypt(encrypted.toString("base64"));
      if (candidateDecrypted.shouldReEncrypt) throw unavailable();
      candidate = credential(candidateDecrypted.result);
      if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
        throw unavailable();
      }
      await save({ schemaVersion: SCHEMA, encrypted: encrypted.toString("base64") });
      observed = await read({ allowReencrypt: false });
      if (observed === null || observed.length !== expected.length
          || !timingSafeEqual(observed, expected)) throw unavailable();
      returned = true;
      return observed;
    } finally {
      expected.fill(0);
      candidate?.fill(0);
      encrypted?.fill(0);
      if (!returned) observed?.fill(0);
    }
  };
  const secret = (value) => { if (!Buffer.isBuffer(value) || value.length !== 32) throw unavailable(); };
  return Object.freeze({
    read: () => serialize(async () => { try { return await read(); } catch (error) { throw preserveFailure(error); } }),
    createIfMissing: (value) => serialize(async () => {
      secret(value);
      let existing;
      try {
        existing = await read();
        if (existing !== null) return "existing";
        const encrypted = await encrypt(value.toString("base64url"));
        try { await save({ schemaVersion: SCHEMA, encrypted: encrypted.toString("base64") }); }
        finally { encrypted.fill(0); }
        const observed = await read();
        try { if (observed === null || !timingSafeEqual(observed, value)) throw unavailable(); }
        finally { observed?.fill(0); }
        return "created";
      } catch (error) { throw preserveFailure(error); }
      finally { existing?.fill(0); }
    }),
    deleteExact: (value) => serialize(async () => {
      secret(value);
      let existing;
      try {
        existing = await read();
        if (existing === null) return "missing";
        if (!timingSafeEqual(existing, value)) return "mismatch";
        await save({ schemaVersion: SCHEMA, encrypted: null });
        return "deleted";
      } catch (error) { throw preserveFailure(error); }
      finally { existing?.fill(0); }
    }),
  });
}
