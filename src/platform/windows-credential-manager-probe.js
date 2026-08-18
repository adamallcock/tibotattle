import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, sep } from "node:path";

const require = createRequire(import.meta.url);
const BINDING_SPECIFIER = "@github/keytar/prebuilds/win32-x64/keytar.node";
export const KEYTAR_WIN32_X64_SHA256 =
  "b82625e7c713fd20b5cb57993e073076c87660652202893fad39d874d77169fc";

function qualificationError(code) {
  const error = new Error("Windows Credential Manager qualification failed");
  error.code = `WINDOWS_CREDENTIAL_MANAGER_${code}`;
  return error;
}

export function loadAuditedWindowsCredentialBinding({
  platform = process.platform,
  architecture = process.arch,
  resolveBinding = (specifier) => require.resolve(specifier),
  readBinding = (path) => readFileSync(path),
  requireBinding = (path) => require(path),
} = {}) {
  if (platform !== "win32") throw qualificationError("UNSUPPORTED_PLATFORM");
  if (architecture !== "x64") throw qualificationError("UNSUPPORTED_ARCHITECTURE");
  let bindingPath;
  let bytes;
  try {
    bindingPath = resolveBinding(BINDING_SPECIFIER);
    const suffix = ["prebuilds", "win32-x64", "keytar.node"].join(sep);
    if (!isAbsolute(bindingPath) || !bindingPath.endsWith(`${sep}${suffix}`)) {
      throw qualificationError("INVALID_BINDING_PATH");
    }
    bytes = readBinding(bindingPath);
  } catch (error) {
    if (error?.code?.startsWith("WINDOWS_CREDENTIAL_MANAGER_")) throw error;
    throw qualificationError("BINDING_UNAVAILABLE");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== KEYTAR_WIN32_X64_SHA256) {
    throw qualificationError("BINDING_INTEGRITY");
  }
  let binding;
  try {
    binding = requireBinding(bindingPath);
  } catch {
    throw qualificationError("BINDING_UNAVAILABLE");
  }
  for (const method of ["getPassword", "setPassword", "deletePassword"]) {
    if (typeof binding?.[method] !== "function") {
      throw qualificationError("INVALID_BINDING");
    }
  }
  return binding;
}

export async function runWindowsCredentialManagerProbe({
  binding = loadAuditedWindowsCredentialBinding(),
  identifier = randomUUID(),
  secret = randomBytes(32).toString("base64url"),
} = {}) {
  if (!/^[0-9a-f-]{36}$/iu.test(identifier)
      || !/^[A-Za-z0-9_-]{43}$/u.test(secret)) {
    throw qualificationError("INVALID_CONFIGURATION");
  }
  const service = `app-usagemonitor.windows-qualification.${identifier}`;
  const account = "disposable-probe";
  let operationError = null;
  let deleted = false;
  try {
    await binding.setPassword(service, account, secret);
    const observed = await binding.getPassword(service, account);
    const expectedBytes = Buffer.from(secret);
    const observedBytes = typeof observed === "string" ? Buffer.from(observed) : null;
    if (observedBytes === null
        || observedBytes.byteLength !== expectedBytes.byteLength
        || !timingSafeEqual(observedBytes, expectedBytes)) {
      throw qualificationError("ROUND_TRIP");
    }
  } catch (error) {
    operationError = error?.code?.startsWith("WINDOWS_CREDENTIAL_MANAGER_")
      ? error
      : qualificationError("OPERATION_FAILED");
  }
  try {
    deleted = await binding.deletePassword(service, account);
  } catch {
    throw qualificationError("CLEANUP_FAILED");
  }
  let remaining;
  try {
    remaining = await binding.getPassword(service, account);
  } catch {
    throw qualificationError("CLEANUP_FAILED");
  }
  if (remaining !== null || (operationError === null && !deleted)) {
    throw qualificationError("CLEANUP_FAILED");
  }
  if (operationError !== null) throw operationError;
  return Object.freeze({
    status: "passed",
    platform: "win32",
    architecture: "x64",
    bindingSha256: KEYTAR_WIN32_X64_SHA256,
    cleanup: "confirmed",
  });
}
