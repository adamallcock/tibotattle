import { DEPLOYMENT_ENDPOINTS } from "../../config/deployment-endpoints.js";

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

// A local caller must inject `laboratory: true` and a canonical IPv4 loopback
// origin. The separately gated rehearsal lane has exactly one reviewed hosted
// destination; it is never inferred from caller input.
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

/** Destination selection never grants upload authority. The caller still needs
 * a current protected preference, installation credential and server grant.
 * Production and rehearsal are explicit and restricted to reviewed origins. */
export function accountlessTransportOrigin({
  laboratory = false,
  rehearsal = false,
  production = false,
  origin,
} = {}) {
  if ([laboratory, rehearsal, production].some((value) => typeof value !== "boolean")
      || [laboratory, rehearsal, production].filter(Boolean).length !== 1) return null;
  if (laboratory) return accountlessLocalLaboratoryOrigin(true, origin);
  if (rehearsal) {
    return origin === DEPLOYMENT_ENDPOINTS.staging.origin ? origin : null;
  }
  return production && origin === DEPLOYMENT_ENDPOINTS.public.origin ? origin : null;
}
