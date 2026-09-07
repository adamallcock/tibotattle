import {
  ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS,
  ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
} from "./accountless-enrollment";
import {
  ACCOUNTLESS_UPLOAD_OWNER_SCOPE,
  ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
} from "./accountless-ownership";
import { timingSafeEqual } from "./crypto";
import { deviceHash, parseDeviceAuthorization } from "./device-auth";
import { ApiError } from "./errors";
import { parseStrictJson } from "./strict-json";

/**
 * Renewal is deliberately a separate, bearer-authenticated operation.  An
 * enrollment replay still expires normally, while this closed action may
 * extend only the already-existing accountless authority graph.
 */
export const ACCOUNTLESS_RENEWAL_SCHEMA_VERSION = "accountless-renewal-v0.1";
export const ACCOUNTLESS_RENEWAL_SCOPE = "upload_registration";
export const ACCOUNTLESS_RENEWAL_MAX_REQUEST_BYTES = 512;
export const ACCOUNTLESS_RENEWAL_WINDOW_MILLISECONDS =
  7 * 24 * 60 * 60 * 1000;
export const ACCOUNTLESS_RENEWAL_GENERATION_MAXIMUM = 2_147_483_647;

export interface AccountlessRenewalRequest {
  readonly schemaVersion: typeof ACCOUNTLESS_RENEWAL_SCHEMA_VERSION;
  readonly policyVersion: typeof ACCOUNTLESS_ENROLLMENT_POLICY_VERSION;
  readonly authorizationBasis:
    typeof ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS;
  readonly telemetrySchemaVersion:
    typeof ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION;
}

export interface AccountlessRenewalResponse {
  readonly schemaVersion: typeof ACCOUNTLESS_RENEWAL_SCHEMA_VERSION;
  readonly state: "existing" | "renewed";
  readonly deviceId: string;
  readonly expiresAt: string;
  readonly renewalGeneration: number;
  readonly policyVersion: typeof ACCOUNTLESS_ENROLLMENT_POLICY_VERSION;
  readonly authorizationBasis:
    typeof ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS;
  readonly scope: typeof ACCOUNTLESS_RENEWAL_SCOPE;
  readonly telemetrySchemaVersion:
    typeof ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION;
}

interface AccountlessRenewalLedgerRow {
  readonly device_id: string;
  readonly device_secret_hash: ArrayBuffer;
  readonly policy_version: string;
  readonly authorization_basis: string;
  readonly state: "active" | "revoked";
  readonly issued_at: string;
  readonly expires_at: string;
  readonly renewal_generation: number;
  readonly renewed_at: string | null;
}

interface AccountlessRenewalGraphRow {
  readonly participant_id: string;
  readonly participant_state: string;
  readonly participant_owner_kind: string;
  readonly access_token_id: string | null;
  readonly access_token_hash: ArrayBuffer | null;
  readonly recovery_token_id: string | null;
  readonly recovery_token_hash: ArrayBuffer | null;
  readonly consent_version: string | null;
  readonly consented_at: string | null;
  readonly device_id: string;
  readonly device_participant_id: string;
  readonly device_authority_kind: string;
  readonly device_enrollment_device_id: string | null;
  readonly device_secret_hash: ArrayBuffer;
  readonly device_state: string;
  readonly device_expires_at: string;
  readonly device_social_verified_at: string | null;
  readonly owner_enrollment_device_id: string;
  readonly owner_participant_id: string;
  readonly owner_device_credential_id: string;
  readonly owner_policy_version: string;
  readonly owner_authorization_basis: string;
  readonly owner_state: string;
  readonly owner_expires_at: string;
  readonly authorization_enrollment_device_id: string;
  readonly authorization_participant_id: string;
  readonly authorization_device_credential_id: string;
  readonly authorization_telemetry_schema_version: string;
  readonly authorization_state: string;
  readonly authorization_expires_at: string;
}

function failBody(): never {
  throw new ApiError(400, "BODY_INVALID");
}

/** Parse the duplicate-key-free, closed renewal request after bounded reading. */
export function parseAccountlessRenewalRequest(
  value: unknown,
): AccountlessRenewalRequest {
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
      || object.schemaVersion !== ACCOUNTLESS_RENEWAL_SCHEMA_VERSION
      || object.policyVersion !== ACCOUNTLESS_ENROLLMENT_POLICY_VERSION
      || object.authorizationBasis !== ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS
      || object.telemetrySchemaVersion
        !== ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION) {
    return failBody();
  }
  return Object.freeze({
    schemaVersion: ACCOUNTLESS_RENEWAL_SCHEMA_VERSION,
    policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
    telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
  });
}

export function parseAccountlessRenewalJson(raw: string): AccountlessRenewalRequest {
  return parseAccountlessRenewalRequest(parseStrictJson(raw));
}

function hashBytes(value: ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function canonicalEpoch(value: string): number | null {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value
    ? epoch
    : null;
}

function validNow(nowEpoch: number): void {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) {
    throw new TypeError("nowEpoch must be a non-negative safe integer");
  }
}

function validRenewalGeneration(value: number): boolean {
  return Number.isSafeInteger(value)
    && value >= 0
    && value <= ACCOUNTLESS_RENEWAL_GENERATION_MAXIMUM;
}

function leaseExpiryEpoch(row: AccountlessRenewalLedgerRow): number | null {
  if (!validRenewalGeneration(row.renewal_generation)) return null;
  const issuedEpoch = canonicalEpoch(row.issued_at);
  const expiryEpoch = canonicalEpoch(row.expires_at);
  if (issuedEpoch === null || expiryEpoch === null) return null;
  if (row.renewal_generation === 0) {
    if (row.renewed_at !== null
        || expiryEpoch !== issuedEpoch + ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS) {
      return null;
    }
    return expiryEpoch;
  }
  if (row.renewed_at === null) return null;
  const renewedEpoch = canonicalEpoch(row.renewed_at);
  if (renewedEpoch === null
      || renewedEpoch < issuedEpoch
      || expiryEpoch !== renewedEpoch + ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS) {
    return null;
  }
  return expiryEpoch;
}

async function readLedger(
  db: D1Database,
  deviceId: string,
): Promise<AccountlessRenewalLedgerRow | null> {
  try {
    return await db.prepare(`
      SELECT device_id, device_secret_hash, policy_version, authorization_basis,
             state, issued_at, expires_at, renewal_generation, renewed_at
        FROM accountless_enrollment_ledger
       WHERE device_id = ?
    `).bind(deviceId).first<AccountlessRenewalLedgerRow>();
  } catch {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
}

async function readGraph(
  db: D1Database,
  deviceId: string,
): Promise<AccountlessRenewalGraphRow | null> {
  try {
    return await db.prepare(`
      SELECT
        participant.id AS participant_id,
        participant.state AS participant_state,
        participant.owner_kind AS participant_owner_kind,
        participant.access_token_id,
        participant.access_token_hash,
        participant.recovery_token_id,
        participant.recovery_token_hash,
        participant.consent_version,
        participant.consented_at,
        device.id AS device_id,
        device.participant_id AS device_participant_id,
        device.authority_kind AS device_authority_kind,
        device.accountless_enrollment_device_id AS device_enrollment_device_id,
        device.secret_hash AS device_secret_hash,
        device.state AS device_state,
        device.expires_at AS device_expires_at,
        device.social_verified_at AS device_social_verified_at,
        owner.enrollment_device_id AS owner_enrollment_device_id,
        owner.participant_id AS owner_participant_id,
        owner.device_credential_id AS owner_device_credential_id,
        owner.policy_version AS owner_policy_version,
        owner.authorization_basis AS owner_authorization_basis,
        owner.state AS owner_state,
        owner.expires_at AS owner_expires_at,
        grant_row.enrollment_device_id AS authorization_enrollment_device_id,
        grant_row.participant_id AS authorization_participant_id,
        grant_row.device_credential_id AS authorization_device_credential_id,
        grant_row.telemetry_schema_version AS authorization_telemetry_schema_version,
        grant_row.state AS authorization_state,
        grant_row.expires_at AS authorization_expires_at
      FROM accountless_upload_owners owner
      JOIN participants participant ON participant.id = owner.participant_id
      JOIN device_credentials device ON device.id = owner.device_credential_id
      JOIN accountless_v11_device_authorizations grant_row
        ON grant_row.enrollment_device_id = owner.enrollment_device_id
       AND grant_row.participant_id = owner.participant_id
       AND grant_row.device_credential_id = owner.device_credential_id
     WHERE owner.enrollment_device_id = ?
    `).bind(deviceId).first<AccountlessRenewalGraphRow>();
  } catch {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
}

function validGraph(
  ledger: AccountlessRenewalLedgerRow,
  graph: AccountlessRenewalGraphRow | null,
): graph is AccountlessRenewalGraphRow {
  return graph !== null
    && graph.participant_state === "active"
    && graph.participant_owner_kind === "accountless"
    && graph.access_token_id === null
    && graph.access_token_hash === null
    && graph.recovery_token_id === null
    && graph.recovery_token_hash === null
    && graph.consent_version === null
    && graph.consented_at === null
    && graph.device_id === ledger.device_id
    && graph.device_participant_id === graph.participant_id
    && graph.device_authority_kind === "accountless"
    && graph.device_enrollment_device_id === ledger.device_id
    && timingSafeEqual(hashBytes(graph.device_secret_hash), hashBytes(ledger.device_secret_hash))
    && graph.device_state === "active"
    && graph.device_social_verified_at === null
    && graph.owner_enrollment_device_id === ledger.device_id
    && graph.owner_participant_id === graph.participant_id
    && graph.owner_device_credential_id === ledger.device_id
    && graph.owner_policy_version === ledger.policy_version
    && graph.owner_authorization_basis === ledger.authorization_basis
    && graph.owner_state === "active"
    && graph.authorization_enrollment_device_id === ledger.device_id
    && graph.authorization_participant_id === graph.participant_id
    && graph.authorization_device_credential_id === ledger.device_id
    && graph.authorization_telemetry_schema_version
      === ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION
    && graph.authorization_state === "active"
    && graph.device_expires_at === ledger.expires_at
    && graph.owner_expires_at === ledger.expires_at
    && graph.authorization_expires_at === ledger.expires_at;
}

function renewalResponse(
  ledger: AccountlessRenewalLedgerRow,
  state: AccountlessRenewalResponse["state"],
): AccountlessRenewalResponse {
  return Object.freeze({
    schemaVersion: ACCOUNTLESS_RENEWAL_SCHEMA_VERSION,
    state,
    deviceId: ledger.device_id,
    expiresAt: ledger.expires_at,
    renewalGeneration: ledger.renewal_generation,
    policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
    scope: ACCOUNTLESS_RENEWAL_SCOPE,
    telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
  });
}

async function authenticatedRenewableGraph(
  db: D1Database,
  authorizationHeader: string | null,
): Promise<{
  readonly ledger: AccountlessRenewalLedgerRow;
  readonly presentedHash: Uint8Array;
  readonly graph: AccountlessRenewalGraphRow;
}> {
  const parsed = parseDeviceAuthorization(authorizationHeader);
  const presentedHash = await deviceHash(parsed.id, parsed.secret);
  const ledger = await readLedger(db, parsed.id);
  if (!ledger || !timingSafeEqual(
    presentedHash,
    ledger ? hashBytes(ledger.device_secret_hash) : new Uint8Array(32),
  )) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  if (ledger.policy_version !== ACCOUNTLESS_ENROLLMENT_POLICY_VERSION
      || ledger.authorization_basis !== ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS
      || leaseExpiryEpoch(ledger) === null) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  if (ledger.state === "revoked") {
    throw new ApiError(401, "ACCOUNTLESS_OWNERSHIP_REVOKED");
  }
  const graph = await readGraph(db, ledger.device_id);
  if (!validGraph(ledger, graph)) {
    // A ledger-only enrollment is intentionally not renewable: a renewal
    // cannot be a back door for creating or repairing an owner graph.
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  return { ledger, presentedHash, graph };
}

/**
 * Extend only an exact, active accountless owner graph. A replay of the
 * original enrollment remains finite; this explicit bearer action is what
 * makes the installation key durable across a legitimate offline interval.
 */
export async function renewAccountlessUploadOwner(
  db: D1Database,
  authorizationHeader: string | null,
  request: AccountlessRenewalRequest,
  nowEpoch = Date.now(),
): Promise<AccountlessRenewalResponse> {
  if (!db || typeof db.prepare !== "function") {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  parseAccountlessRenewalRequest(request);
  validNow(nowEpoch);

  const { ledger, presentedHash, graph } = await authenticatedRenewableGraph(
    db,
    authorizationHeader,
  );
  const expiryEpoch = leaseExpiryEpoch(ledger);
  if (expiryEpoch === null) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  if (expiryEpoch > nowEpoch
      && expiryEpoch - nowEpoch > ACCOUNTLESS_RENEWAL_WINDOW_MILLISECONDS) {
    return renewalResponse(ledger, "existing");
  }
  if (ledger.renewal_generation >= ACCOUNTLESS_RENEWAL_GENERATION_MAXIMUM) {
    throw new ApiError(409, "LIFECYCLE_BOUNDS_EXCEEDED");
  }

  const renewedAt = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(
    nowEpoch + ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS,
  ).toISOString();
  const nextGeneration = ledger.renewal_generation + 1;
  try {
    const results = await db.batch([
      db.prepare(`
        UPDATE accountless_enrollment_ledger
           SET expires_at = ?, renewed_at = ?, renewal_generation = ?
         WHERE device_id = ?
           AND device_secret_hash = ?
           AND policy_version = ? AND authorization_basis = ?
           AND state = 'active'
           AND expires_at = ?
           AND renewal_generation = ?
           AND renewed_at IS ?
           AND EXISTS (
             SELECT 1
               FROM accountless_upload_owners owner
               JOIN participants participant ON participant.id = owner.participant_id
               JOIN device_credentials device ON device.id = owner.device_credential_id
               JOIN accountless_v11_device_authorizations grant_row
                 ON grant_row.enrollment_device_id = owner.enrollment_device_id
                AND grant_row.participant_id = owner.participant_id
                AND grant_row.device_credential_id = owner.device_credential_id
              WHERE owner.enrollment_device_id = accountless_enrollment_ledger.device_id
                AND participant.owner_kind = 'accountless' AND participant.state = 'active'
                AND participant.access_token_id IS NULL AND participant.access_token_hash IS NULL
                AND participant.recovery_token_id IS NULL AND participant.recovery_token_hash IS NULL
                AND participant.consent_version IS NULL AND participant.consented_at IS NULL
                AND device.id = accountless_enrollment_ledger.device_id
                AND device.participant_id = participant.id
                AND device.authority_kind = 'accountless'
                AND device.accountless_enrollment_device_id = accountless_enrollment_ledger.device_id
                AND device.secret_hash = accountless_enrollment_ledger.device_secret_hash
                AND device.state = 'active' AND device.social_verified_at IS NULL
                AND device.expires_at = accountless_enrollment_ledger.expires_at
                AND owner.device_credential_id = device.id
                AND owner.policy_version = accountless_enrollment_ledger.policy_version
                AND owner.authorization_basis = accountless_enrollment_ledger.authorization_basis
                AND owner.state = 'active' AND owner.expires_at = accountless_enrollment_ledger.expires_at
                AND grant_row.state = 'active'
                AND grant_row.expires_at = accountless_enrollment_ledger.expires_at
           )
         RETURNING device_id, renewal_generation, renewed_at, expires_at
      `).bind(
        expiresAt,
        renewedAt,
        nextGeneration,
        ledger.device_id,
        presentedHash,
        ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
        ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
        ledger.expires_at,
        ledger.renewal_generation,
        ledger.renewed_at,
      ),
      db.prepare(`
        UPDATE device_credentials
           SET expires_at = ?
         WHERE id = ? AND participant_id = ?
           AND authority_kind = 'accountless'
           AND accountless_enrollment_device_id = ?
           AND state = 'active' AND social_verified_at IS NULL
           AND secret_hash = ? AND expires_at = ?
           AND EXISTS (
             SELECT 1 FROM accountless_enrollment_ledger ledger
              WHERE ledger.device_id = device_credentials.accountless_enrollment_device_id
                AND ledger.state = 'active'
                AND ledger.expires_at = ? AND ledger.renewal_generation = ?
                AND ledger.renewed_at = ?
           )
      `).bind(
        expiresAt,
        ledger.device_id,
        graph.participant_id,
        ledger.device_id,
        presentedHash,
        ledger.expires_at,
        expiresAt,
        nextGeneration,
        renewedAt,
      ),
      db.prepare(`
        UPDATE accountless_upload_owners
           SET expires_at = ?
         WHERE enrollment_device_id = ? AND participant_id = ?
           AND device_credential_id = ? AND state = 'active'
           AND policy_version = ? AND authorization_basis = ?
           AND expires_at = ?
           AND EXISTS (
             SELECT 1
               FROM accountless_enrollment_ledger ledger
               JOIN device_credentials device ON device.id = accountless_upload_owners.device_credential_id
              WHERE ledger.device_id = accountless_upload_owners.enrollment_device_id
                AND ledger.state = 'active' AND ledger.expires_at = ?
                AND ledger.renewal_generation = ? AND ledger.renewed_at = ?
                AND device.state = 'active' AND device.expires_at = ledger.expires_at
           )
      `).bind(
        expiresAt,
        ledger.device_id,
        graph.participant_id,
        ledger.device_id,
        ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
        ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
        ledger.expires_at,
        expiresAt,
        nextGeneration,
        renewedAt,
      ),
      db.prepare(`
        UPDATE accountless_v11_device_authorizations
           SET expires_at = ?
         WHERE enrollment_device_id = ? AND participant_id = ?
           AND device_credential_id = ? AND state = 'active'
           AND telemetry_schema_version = ? AND expires_at = ?
           AND EXISTS (
             SELECT 1
               FROM accountless_enrollment_ledger ledger
               JOIN device_credentials device
                 ON device.id = accountless_v11_device_authorizations.device_credential_id
               JOIN accountless_upload_owners owner
                 ON owner.enrollment_device_id = ledger.device_id
                AND owner.participant_id = accountless_v11_device_authorizations.participant_id
                AND owner.device_credential_id = device.id
              WHERE ledger.device_id = accountless_v11_device_authorizations.enrollment_device_id
                AND ledger.state = 'active' AND ledger.expires_at = ?
                AND ledger.renewal_generation = ? AND ledger.renewed_at = ?
                AND device.state = 'active' AND device.expires_at = ledger.expires_at
                AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
           )
      `).bind(
        expiresAt,
        ledger.device_id,
        graph.participant_id,
        ledger.device_id,
        ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
        ledger.expires_at,
        expiresAt,
        nextGeneration,
        renewedAt,
      ),
    ]);
    // RETURNING identifies the exact fenced ledger row without relying on D1
    // change counts, which can include trigger work. Exact graph/generation
    // readback remains the authority for issuing its renewal receipt. A
    // contender that lost the compare-and-swap falls through to a stable
    // existing receipt below.
    const transitioned = results[0]?.results[0];
    if (results[0]?.results.length === 1
        && typeof transitioned === "object" && transitioned !== null
        && Reflect.get(transitioned, "device_id") === ledger.device_id
        && Reflect.get(transitioned, "renewal_generation") === nextGeneration
        && Reflect.get(transitioned, "renewed_at") === renewedAt
        && Reflect.get(transitioned, "expires_at") === expiresAt) {
      const renewed = await readLedger(db, ledger.device_id);
      if (renewed !== null
          && renewed.renewal_generation === nextGeneration
          && renewed.renewed_at === renewedAt
          && renewed.expires_at === expiresAt
          && leaseExpiryEpoch(renewed) !== null
          && validGraph(renewed, await readGraph(db, renewed.device_id))) {
        return renewalResponse(renewed, "renewed");
      }
    }
  } catch {
    // A concurrent identical request can commit the same next lease first.
    // Resolve that one bounded state rather than retrying a mutation loop.
  }

  const replay = await authenticatedRenewableGraph(db, authorizationHeader);
  const replayExpiry = leaseExpiryEpoch(replay.ledger);
  if (replay.ledger.renewal_generation > ledger.renewal_generation
      && replayExpiry !== null && replayExpiry > nowEpoch) {
    return renewalResponse(replay.ledger, "existing");
  }
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}
