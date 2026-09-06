import { ApiError } from "./errors";
import { parseStrictJson } from "./strict-json";

/**
 * This policy authorization is intentionally distinct from the historical
 * social-consent records.  The v1.1 dictionary still fixes the permitted
 * content, while these constants identify the owner-bound authorization that
 * may later admit it through the existing transport.
 */
export const ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION =
  "accountless-upload-owner-v0.1";
export const ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION =
  "accountless-opt-out-v1";
export const ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS =
  "accountless-policy-v1";
export const ACCOUNTLESS_UPLOAD_OWNER_SCOPE = "upload_registration";
export const ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION =
  "telemetry-contribution-v1.1";
export const ACCOUNTLESS_UPLOAD_OWNER_MAX_REQUEST_BYTES = 512;

export type AccountlessOwnershipMode = "disabled" | "synthetic-local";

export interface AccountlessOwnershipRequest {
  readonly schemaVersion: typeof ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION;
  readonly policyVersion: typeof ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION;
  readonly authorizationBasis:
    typeof ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS;
  readonly telemetrySchemaVersion:
    typeof ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION;
}

export interface AccountlessOwnershipResponse {
  readonly schemaVersion: typeof ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION;
  readonly state: "created" | "existing";
  readonly deviceId: string;
  readonly expiresAt: string;
  readonly policyVersion: typeof ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION;
  readonly authorizationBasis:
    typeof ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS;
  readonly scope: typeof ACCOUNTLESS_UPLOAD_OWNER_SCOPE;
  readonly telemetrySchemaVersion:
    typeof ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION;
}

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function failBody(): never {
  throw new ApiError(400, "BODY_INVALID");
}

/** Closed request parser; callers must perform bounded body reading first. */
export function parseAccountlessOwnershipRequest(
  value: unknown,
): AccountlessOwnershipRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return failBody();
  }
  const object = value as Record<string, unknown>;
  const expected = [
    "authorizationBasis",
    "policyVersion",
    "schemaVersion",
    "telemetrySchemaVersion",
  ];
  const keys = Object.keys(object).sort();
  if (keys.length !== expected.length
      || keys.some((key, index) => key !== expected[index])
      || object.schemaVersion !== ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION
      || object.policyVersion !== ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION
      || object.authorizationBasis !== ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS
      || object.telemetrySchemaVersion
        !== ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION) {
    return failBody();
  }
  return Object.freeze({
    schemaVersion: ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
    policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
    telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
  });
}

/** Duplicate-key-free companion for isolated parser tests and future routes. */
export function parseAccountlessOwnershipJson(
  raw: string,
): AccountlessOwnershipRequest {
  return parseAccountlessOwnershipRequest(parseStrictJson(raw));
}

/**
 * Disabled unless a local test expressly supplies the synthetic-only value.
 * This avoids adding a generated Worker binding or a deployable default while
 * local protocol qualification is the only approved surface.
 */
export function configuredAccountlessOwnershipMode(
  env: Env,
): AccountlessOwnershipMode {
  const configured = Reflect.get(env, "ACCOUNTLESS_OWNERSHIP_MODE");
  if (configured === undefined || configured === "disabled") return "disabled";
  if (configured === "synthetic-local") return "synthetic-local";
  throw new ApiError(503, "ACCOUNTLESS_OWNERSHIP_CONFIGURATION_INVALID");
}

/**
 * A Worker endpoint must independently enforce the same laboratory boundary
 * as the desktop client.  No deployed hostname or HTTPS origin can satisfy
 * this predicate, even if someone accidentally sets the mode binding.
 */
export function assertAccountlessOwnershipLaboratory(
  env: Env,
  requestUrl: URL,
): void {
  if (configuredAccountlessOwnershipMode(env) !== "synthetic-local") {
    throw new ApiError(503, "ACCOUNTLESS_OWNERSHIP_DISABLED");
  }
  if (Reflect.get(env, "ENVIRONMENT") !== "synthetic-development"
      || requestUrl.protocol !== "http:"
      || requestUrl.hostname !== "127.0.0.1"
      || requestUrl.port.length === 0
      || requestUrl.username.length !== 0
      || requestUrl.password.length !== 0) {
    throw new ApiError(503, "ACCOUNTLESS_OWNERSHIP_DISABLED");
  }
}

/** Build the closed receipt without exposing an internal owner or secret. */
export function accountlessOwnershipResponse(
  deviceId: string,
  expiresAt: string,
  state: AccountlessOwnershipResponse["state"],
): AccountlessOwnershipResponse {
  const expiryEpoch = Date.parse(expiresAt);
  if (!UUID_V4_PATTERN.test(deviceId)
      || !Number.isFinite(expiryEpoch)
      || new Date(expiryEpoch).toISOString() !== expiresAt) {
    throw new TypeError("accountless ownership response invalid");
  }
  return Object.freeze({
    schemaVersion: ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
    state,
    deviceId,
    expiresAt,
    policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
    scope: ACCOUNTLESS_UPLOAD_OWNER_SCOPE,
    telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
  });
}
