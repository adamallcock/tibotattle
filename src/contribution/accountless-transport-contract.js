// The accountless installation policy is a transport authorization, not a
// consent event. These identifiers are deliberately separate from the legacy
// consent dictionary, and both sides must reject a version they do not know.
export const ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION =
  "accountless-upload-owner-v0.1";
export const ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION = "accountless-opt-out-v1";
export const ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS =
  "accountless-policy-v1";
export const ACCOUNTLESS_UPLOAD_OWNER_SCOPE = "upload_registration";
export const ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION =
  "telemetry-contribution-v1.1";

// These server outcomes mean the enrollment ledger or the derived ownership
// grant can no longer authorize the installation. They are deliberately
// distinct from a malformed request or policy-contract mismatch: callers
// must stop scheduling with this credential rather than retrying it or
// presenting the result as an ordinary upload authorization rejection.
const ACCOUNTLESS_DEVICE_UNAVAILABLE_CODES = new Set([
  "ACCOUNTLESS_ENROLLMENT_EXPIRED",
  "ACCOUNTLESS_ENROLLMENT_REVOKED",
  "ACCOUNTLESS_OWNERSHIP_EXPIRED",
  "ACCOUNTLESS_OWNERSHIP_REVOKED",
]);

export function accountlessDeviceUnavailableCode(value) {
  return typeof value === "string"
    && ACCOUNTLESS_DEVICE_UNAVAILABLE_CODES.has(value);
}

// The approved implementation surface is synthetic local qualification only.
// A caller must inject `laboratory: true` and a canonical IPv4 loopback origin;
// no production destination is accepted through the accountless transport.
export function accountlessLocalLaboratoryOrigin(laboratory, origin) {
  if (laboratory !== true || typeof origin !== "string") return null;
  let parsed;
  try { parsed = new URL(origin); } catch { return null; }
  const port = Number(parsed.port);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1"
      || !Number.isSafeInteger(port) || port < 1 || port > 65_535
      || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash
      || parsed.origin !== origin) return null;
  return parsed.origin;
}
