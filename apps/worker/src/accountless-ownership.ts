import {
  TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
  telemetryV11RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import { timingSafeEqual } from "./crypto";
import { deviceHash, parseDeviceAuthorization } from "./device-auth";
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

export type AccountlessOwnershipMode = "disabled" | "enabled";

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

export interface AccountlessOwnershipResult {
  readonly status: 200 | 201;
  readonly response: AccountlessOwnershipResponse;
}

interface AccountlessLedgerRow {
  readonly device_id: string;
  readonly device_secret_hash: ArrayBuffer;
  readonly policy_version: string;
  readonly authorization_basis: string;
  readonly state: "active" | "revoked";
  readonly issued_at: string;
  readonly expires_at: string;
}

interface AccountlessOwnerRow {
  readonly enrollment_device_id: string;
  readonly participant_id: string;
  readonly device_credential_id: string;
  readonly owner_state: "active" | "revoked";
  readonly owner_expires_at: string;
  readonly authorization_state: "active" | "revoked";
  readonly authorization_expires_at: string;
  readonly device_state: "active" | "revoked";
  readonly device_expires_at: string;
  readonly participant_state: "active" | "deleting";
  readonly participant_owner_kind: "social" | "accountless";
  readonly device_authority_kind: "social" | "accountless";
  readonly enrollment_device_id_on_credential: string | null;
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

/** Disabled unless the deployment explicitly admits this authority lane. */
export function configuredAccountlessOwnershipMode(
  env: Env,
): AccountlessOwnershipMode {
  const configured = Reflect.get(env, "ACCOUNTLESS_OWNERSHIP_MODE");
  if (configured === undefined || configured === "disabled") return "disabled";
  if (configured === "enabled") return "enabled";
  throw new ApiError(503, "ACCOUNTLESS_OWNERSHIP_CONFIGURATION_INVALID");
}

export function assertAccountlessOwnershipEnabled(env: Env): void {
  if (configuredAccountlessOwnershipMode(env) !== "enabled") {
    throw new ApiError(503, "ACCOUNTLESS_OWNERSHIP_DISABLED");
  }
}

function hashBytes(value: ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function validFutureInstant(value: string, nowEpoch: number): boolean {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch)
    && new Date(epoch).toISOString() === value
    && epoch > nowEpoch;
}

async function readLedger(
  db: D1Database,
  deviceId: string,
): Promise<AccountlessLedgerRow | null> {
  try {
    return await db.prepare(`
      SELECT device_id, device_secret_hash, policy_version, authorization_basis,
             state, issued_at, expires_at
        FROM accountless_enrollment_ledger
       WHERE device_id = ?
    `).bind(deviceId).first<AccountlessLedgerRow>();
  } catch {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
}

async function currentLedgerForBearer(
  db: D1Database,
  authorizationHeader: string | null,
  nowEpoch: number,
): Promise<{ ledger: AccountlessLedgerRow; presentedHash: Uint8Array }> {
  const parsed = parseDeviceAuthorization(authorizationHeader);
  const presentedHash = await deviceHash(parsed.id, parsed.secret);
  const ledger = await readLedger(db, parsed.id);
  if (!ledger || !timingSafeEqual(
    presentedHash,
    ledger ? hashBytes(ledger.device_secret_hash) : new Uint8Array(32),
  )) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  if (ledger.policy_version !== ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION
      || ledger.authorization_basis !== ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  if (ledger.state === "revoked") {
    throw new ApiError(401, "ACCOUNTLESS_OWNERSHIP_REVOKED");
  }
  if (!validFutureInstant(ledger.expires_at, nowEpoch)) {
    throw new ApiError(410, "ACCOUNTLESS_OWNERSHIP_EXPIRED");
  }
  return { ledger, presentedHash };
}

async function readOwner(
  db: D1Database,
  deviceId: string,
): Promise<AccountlessOwnerRow | null> {
  try {
    return await db.prepare(`
      SELECT owner.enrollment_device_id, owner.participant_id,
             owner.device_credential_id, owner.state AS owner_state,
             owner.expires_at AS owner_expires_at,
             grant_row.state AS authorization_state,
             grant_row.expires_at AS authorization_expires_at,
             device.state AS device_state, device.expires_at AS device_expires_at,
             participant.state AS participant_state,
             participant.owner_kind AS participant_owner_kind,
             device.authority_kind AS device_authority_kind,
             device.accountless_enrollment_device_id
               AS enrollment_device_id_on_credential
        FROM accountless_upload_owners owner
        JOIN accountless_v11_device_authorizations grant_row
          ON grant_row.enrollment_device_id = owner.enrollment_device_id
        JOIN device_credentials device ON device.id = owner.device_credential_id
        JOIN participants participant ON participant.id = owner.participant_id
       WHERE owner.enrollment_device_id = ?
    `).bind(deviceId).first<AccountlessOwnerRow>();
  } catch {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
}

function validOwner(
  owner: AccountlessOwnerRow,
  ledger: AccountlessLedgerRow,
  nowEpoch: number,
): boolean {
  return owner.enrollment_device_id === ledger.device_id
    && owner.device_credential_id === ledger.device_id
    && owner.enrollment_device_id_on_credential === ledger.device_id
    && owner.owner_state === "active"
    && owner.authorization_state === "active"
    && owner.device_state === "active"
    && owner.participant_state === "active"
    && owner.participant_owner_kind === "accountless"
    && owner.device_authority_kind === "accountless"
    && owner.owner_expires_at === ledger.expires_at
    && owner.authorization_expires_at === ledger.expires_at
    && owner.device_expires_at === ledger.expires_at
    && validFutureInstant(owner.owner_expires_at, nowEpoch);
}

/**
 * Bind a ledger-authenticated installation to the existing participant/device
 * graph. The participant key is internal only; no social credential, pairing,
 * session, or consent record is created. A duplicate bearer retry is a stable
 * receipt, while a revoked or expired ledger can never recreate its owner.
 */
export async function createAccountlessUploadOwner(
  db: D1Database,
  authorizationHeader: string | null,
  request: AccountlessOwnershipRequest,
  nowEpoch = Date.now(),
): Promise<AccountlessOwnershipResult> {
  if (!db || typeof db.prepare !== "function") {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  // Keep the typed parameter materially checked for in-process callers too.
  parseAccountlessOwnershipRequest(request);
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) {
    throw new TypeError("nowEpoch must be a non-negative safe integer");
  }
  const { ledger, presentedHash } = await currentLedgerForBearer(
    db,
    authorizationHeader,
    nowEpoch,
  );
  const existing = await readOwner(db, ledger.device_id);
  if (existing !== null) {
    if (!validOwner(existing, ledger, nowEpoch)) {
      throw new ApiError(401, "ACCOUNTLESS_OWNERSHIP_REVOKED");
    }
    return {
      status: 200,
      response: accountlessOwnershipResponse(
        ledger.device_id,
        ledger.expires_at,
        "existing",
      ),
    };
  }

  const now = new Date(nowEpoch).toISOString();
  const participantId = `participant:${crypto.randomUUID()}`;
  const required = telemetryV11RequiredConsent();
  try {
    const results = await db.batch([
      db.prepare(`
        INSERT INTO participants (
          id, owner_kind, access_token_id, access_token_hash,
          recovery_token_id, recovery_token_hash, state, consent_version,
          consented_at, created_at, deletion_session_id, identity_link_key,
          identity_cooldown_digest
        )
        SELECT ?, 'accountless', NULL, NULL, NULL, NULL, 'active', NULL,
               NULL, ?, NULL, NULL, NULL
         WHERE EXISTS (
           SELECT 1 FROM accountless_enrollment_ledger ledger
            WHERE ledger.device_id = ?
              AND ledger.device_secret_hash = ?
              AND ledger.state = 'active' AND ledger.expires_at > ?
              AND ledger.policy_version = ? AND ledger.authorization_basis = ?
         )
      `).bind(
        participantId,
        now,
        ledger.device_id,
        presentedHash,
        now,
        ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
        ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
      ),
      db.prepare(`
        INSERT INTO device_credentials (
          id, participant_id, authority_kind, paired_via_pairing_id,
          accountless_enrollment_device_id, secret_hash, state, issued_at,
          expires_at, last_used_at, revoked_at, social_verified_at,
          credential_generation
        )
        SELECT ledger.device_id, ?, 'accountless', NULL, ledger.device_id,
               ledger.device_secret_hash, 'active', ?, ledger.expires_at, ?,
               NULL, NULL, 1
          FROM accountless_enrollment_ledger ledger
         WHERE ledger.device_id = ?
           AND ledger.device_secret_hash = ?
           AND ledger.state = 'active' AND ledger.expires_at > ?
           AND EXISTS (
             SELECT 1 FROM participants participant
              WHERE participant.id = ? AND participant.owner_kind = 'accountless'
                AND participant.state = 'active'
           )
      `).bind(
        participantId,
        now,
        now,
        ledger.device_id,
        presentedHash,
        now,
        participantId,
      ),
      db.prepare(`
        INSERT INTO accountless_upload_owners (
          enrollment_device_id, participant_id, device_credential_id,
          policy_version, authorization_basis, authorized_at, expires_at, state
        )
        SELECT ledger.device_id, ?, ledger.device_id, ?, ?, ?, ledger.expires_at,
               'active'
          FROM accountless_enrollment_ledger ledger
         WHERE ledger.device_id = ?
           AND ledger.device_secret_hash = ?
           AND ledger.state = 'active' AND ledger.expires_at > ?
      `).bind(
        participantId,
        ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
        ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
        now,
        ledger.device_id,
        presentedHash,
        now,
      ),
      db.prepare(`
        INSERT INTO accountless_v11_device_authorizations (
          enrollment_device_id, participant_id, device_credential_id,
          telemetry_schema_version, field_dictionary_version,
          privacy_contract_version, authorized_at, expires_at, state
        )
        SELECT ledger.device_id, ?, ledger.device_id, ?, ?, ?, ?, ledger.expires_at,
               'active'
          FROM accountless_enrollment_ledger ledger
         WHERE ledger.device_id = ?
           AND ledger.device_secret_hash = ?
           AND ledger.state = 'active' AND ledger.expires_at > ?
      `).bind(
        participantId,
        TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
        required.fieldDictionaryVersion,
        required.privacyContractVersion,
        now,
        ledger.device_id,
        presentedHash,
        now,
      ),
    ]);
    // D1's change count includes trigger work, so it cannot establish the
    // four-row graph's outcome. Read the bounded owner projection instead.
    // A successful local transaction must expose a fully valid graph before
    // we issue the one creation receipt.
    void results;
    const owner = await readOwner(db, ledger.device_id);
    if (owner !== null && validOwner(owner, ledger, nowEpoch)) {
      return {
        status: 201,
        response: accountlessOwnershipResponse(
          ledger.device_id,
          ledger.expires_at,
          "created",
        ),
      };
    }
  } catch {
    // A concurrent identical request may commit the same immutable owner
    // first. Resolve that one bounded replay; do not retry a creation write.
  }
  const raced = await readOwner(db, ledger.device_id);
  if (raced !== null && validOwner(raced, ledger, nowEpoch)) {
    return {
      status: 200,
      response: accountlessOwnershipResponse(
        ledger.device_id,
        ledger.expires_at,
        "existing",
      ),
    };
  }
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
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
