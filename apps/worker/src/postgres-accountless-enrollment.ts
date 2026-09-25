import {
  TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
  telemetryV11RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import {
  ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS,
  ACCOUNTLESS_ENROLLMENT_LIFETIME_ISSUANCE_CEILING,
  ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
  ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
  ACCOUNTLESS_ENROLLMENT_DAILY_ISSUANCE_BUDGET,
  type AccountlessEnrollmentRequest,
  type AccountlessEnrollmentResult,
} from "./accountless-enrollment";
import {
  ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  accountlessOwnershipResponse,
  parseAccountlessOwnershipRequest,
  type AccountlessOwnershipRequest,
  type AccountlessOwnershipResult,
} from "./accountless-ownership";
import {
  ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS,
  ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
  ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,
  parseTelemetryV12AccountlessAuthorizationRequest,
  type TelemetryV12AccountlessAuthorizationRequest,
} from "./telemetry-transport-policy";
import { deviceHash, parseDeviceAuthorization } from "./device-auth";
import { timingSafeEqual } from "./crypto";
import { ApiError } from "./errors";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";

export interface PostgresAccountlessOptions {
  readonly nowEpoch?: number;
  readonly schema?: PostgresSchemaConfig;
}

interface EnrollmentDbRow {
  device_id: string;
  device_secret_hash: Uint8Array;
  installation_principal_id: string;
  schema_version: string;
  policy_version: string;
  authorization_basis: string;
  state: "active" | "revoked";
  issued_at: Date | string;
  expires_at: Date | string;
  renewal_generation: number | string;
  renewed_at: Date | string | null;
  revoked_at: Date | string | null;
  revocation_reason: string | null;
}

interface NormalizedEnrollment extends EnrollmentDbRow {
  device_secret_hash: Uint8Array;
  issued_at: string;
  expires_at: string;
  renewal_generation: number;
  renewed_at: string | null;
  revoked_at: string | null;
}

interface OwnerDbRow {
  enrollment_device_id: string;
  participant_id: string;
  device_credential_id: string;
  owner_policy_version: string;
  owner_authorization_basis: string;
  owner_state: "active" | "revoked";
  owner_expires_at: Date | string;
  v11_state: "active" | "revoked";
  v11_schema_version: string;
  v11_dictionary_version: string;
  v11_privacy_version: string;
  v11_expires_at: Date | string;
  device_secret_hash: Uint8Array;
  device_state: "active" | "revoked";
  device_expires_at: Date | string;
  device_authority_kind: "social" | "accountless";
  device_enrollment_id: string | null;
  participant_state: "active" | "deleting";
  participant_owner_kind: "social" | "accountless";
}

const UUID_V4_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_V4 = new RegExp(`^${UUID_V4_SOURCE}$`, "u");
const INSTALLATION_PRINCIPAL_ID = new RegExp(`^accountless:${UUID_V4_SOURCE}$`, "u");
const PARTICIPANT_ID = new RegExp(`^participant:${UUID_V4_SOURCE}$`, "u");
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const REVOCATION_REASON = /^(?:user_opt_out|security_reset|operator_containment)$/u;

function unavailable(): ApiError {
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function safeError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

function schemaName(options: PostgresAccountlessOptions): string {
  const schema = createPostgresSchemaConfig(options.schema ?? {});
  return quotePostgresIdentifier(schema.primarySchema);
}

function table(schema: string, name: string): string {
  return `${schema}.${quotePostgresIdentifier(name)}`;
}

function validNow(nowEpoch: number): void {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0
      || !Number.isFinite(new Date(nowEpoch).getTime())) {
    throw new TypeError("nowEpoch must be a non-negative safe integer");
  }
}

function epoch(value: Date | string | null): number | null {
  if (value === null) return null;
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function canonicalInstant(value: Date | string | null): string | null {
  const valueEpoch = epoch(value);
  return valueEpoch === null ? null : new Date(valueEpoch).toISOString();
}

function bytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function normalizeEnrollmentRequest(
  value: AccountlessEnrollmentRequest,
): AccountlessEnrollmentRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const expectedKeys = [
    "authorizationBasis", "deviceId", "deviceSecretHash", "policyVersion", "schemaVersion",
  ];
  const keys = Object.keys(value).sort();
  const secretHash = bytes(value.deviceSecretHash);
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])
      || value.schemaVersion !== ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION
      || value.policyVersion !== ACCOUNTLESS_ENROLLMENT_POLICY_VERSION
      || value.authorizationBasis !== ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS
      || typeof value.deviceId !== "string" || !UUID_V4.test(value.deviceId)
      || secretHash === null || secretHash.byteLength !== 32) {
    throw new ApiError(400, "BODY_INVALID");
  }
  return Object.freeze({
    schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
    deviceId: value.deviceId,
    deviceSecretHash: Uint8Array.from(secretHash),
    policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  });
}

function normalizeEnrollment(row: EnrollmentDbRow | undefined): NormalizedEnrollment | null {
  if (!row) return null;
  const secretHash = bytes(row.device_secret_hash);
  const issuedAt = canonicalInstant(row.issued_at);
  const expiresAt = canonicalInstant(row.expires_at);
  const renewedAt = canonicalInstant(row.renewed_at);
  const revokedAt = canonicalInstant(row.revoked_at);
  const generation = Number(row.renewal_generation);
  if (typeof row.device_id !== "string" || !UUID_V4.test(row.device_id)
      || secretHash === null || secretHash.byteLength !== 32
      || typeof row.installation_principal_id !== "string"
      || !INSTALLATION_PRINCIPAL_ID.test(row.installation_principal_id)
      || row.schema_version !== ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION
      || row.policy_version !== ACCOUNTLESS_ENROLLMENT_POLICY_VERSION
      || row.authorization_basis !== ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS
      || (row.state !== "active" && row.state !== "revoked")
      || issuedAt === null || expiresAt === null
      || !Number.isSafeInteger(generation) || generation < 0 || generation > 2_147_483_647
      || (generation === 0 && renewedAt !== null)
      || (generation > 0 && (renewedAt === null || epoch(renewedAt) === null
        || epoch(renewedAt)! < epoch(issuedAt)!))
      || epoch(expiresAt) !== (generation === 0 ? epoch(issuedAt)! : epoch(renewedAt)!)
        + ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS
      || (row.state === "active" && (revokedAt !== null || row.revocation_reason !== null))
      || (row.state === "revoked" && (revokedAt === null
        || !REVOCATION_REASON.test(row.revocation_reason ?? "")))) {
    return null;
  }
  return {
    ...row,
    device_secret_hash: secretHash,
    issued_at: issuedAt,
    expires_at: expiresAt,
    renewal_generation: generation,
    renewed_at: renewedAt,
    revoked_at: revokedAt,
  };
}

async function readEnrollment(
  pool: PostgresPool,
  schema: string,
  deviceId: string,
): Promise<NormalizedEnrollment | null> {
  try {
    return await withPostgresRead(pool, async (client) => {
      const result = await client.query<EnrollmentDbRow>(
        `SELECT device_id, device_secret_hash, installation_principal_id,
                schema_version, policy_version, authorization_basis, state,
                issued_at, expires_at, renewal_generation, renewed_at,
                revoked_at, revocation_reason
           FROM ${table(schema, "accountless_enrollment_ledger")}
          WHERE device_id = $1`,
        [deviceId],
      );
      if (result.rows.length > 1) throw unavailable();
      const row = normalizeEnrollment(result.rows[0]);
      if (result.rows.length === 1 && row === null) throw unavailable();
      return row;
    }, { operation: "accountless.enrollment.read", preserveSafeError: safeError });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
}

function assertEnrollmentContract(
  row: NormalizedEnrollment,
  request: AccountlessEnrollmentRequest,
): void {
  if (row.schema_version !== request.schemaVersion
      || row.policy_version !== request.policyVersion
      || row.authorization_basis !== request.authorizationBasis
      || !timingSafeEqual(row.device_secret_hash, request.deviceSecretHash)) {
    throw new ApiError(409, "ACCOUNTLESS_ENROLLMENT_CONFLICT");
  }
}

function replayEnrollment(
  row: NormalizedEnrollment,
  request: AccountlessEnrollmentRequest,
  nowEpoch: number,
): AccountlessEnrollmentResult {
  assertEnrollmentContract(row, request);
  if (row.state === "revoked") throw new ApiError(401, "ACCOUNTLESS_ENROLLMENT_REVOKED");
  if (Date.parse(row.expires_at) <= nowEpoch) {
    throw new ApiError(410, "ACCOUNTLESS_ENROLLMENT_EXPIRED");
  }
  return {
    status: 200,
    response: Object.freeze({
      schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
      state: "existing",
      deviceId: row.device_id,
      expiresAt: row.expires_at,
      policyVersion: row.policy_version as typeof ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
      authorizationBasis: row.authorization_basis as typeof ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
      scope: "enrollment_only",
    }),
  };
}

class EnrollmentReplayRace extends Error {}

/** Issue or replay one enrollment-only authority row using one PG transaction. */
export async function enrollPostgresAccountlessDevice(
  pool: PostgresPool,
  request: AccountlessEnrollmentRequest,
  options: PostgresAccountlessOptions = {},
): Promise<AccountlessEnrollmentResult> {
  const nowEpoch = options.nowEpoch ?? Date.now();
  validNow(nowEpoch);
  const parsed = normalizeEnrollmentRequest(request);
  const schema = schemaName(options);
  const existing = await readEnrollment(pool, schema, parsed.deviceId);
  if (existing) return replayEnrollment(existing, parsed, nowEpoch);

  const now = new Date(nowEpoch);
  const issuedAt = now.toISOString();
  const expiresAt = new Date(nowEpoch + ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS).toISOString();
  const day = issuedAt.slice(0, 10);
  const issueToken = `accountless:${crypto.randomUUID()}`;
  let raced = false;
  try {
    await withPostgresMutation(pool, async (client) => {
      const issuance = await client.query<{
        budget_day: string | Date;
        daily_issued: number;
        lifetime_issued: number;
      }>(
        `SELECT budget_day, daily_issued, lifetime_issued
           FROM ${table(schema, "accountless_enrollment_issuance")}
          WHERE singleton = 1 FOR UPDATE`,
      );
      const state = issuance.rows[0];
      const budgetDay = state?.budget_day instanceof Date
        ? state.budget_day.toISOString().slice(0, 10) : state?.budget_day;
      if (!state || typeof budgetDay !== "string" || !UTC_DAY.test(budgetDay)
          || !Number.isSafeInteger(state.daily_issued) || state.daily_issued < 0
          || state.daily_issued > ACCOUNTLESS_ENROLLMENT_DAILY_ISSUANCE_BUDGET
          || !Number.isSafeInteger(state.lifetime_issued) || state.lifetime_issued < 0
          || state.lifetime_issued > ACCOUNTLESS_ENROLLMENT_LIFETIME_ISSUANCE_CEILING) {
        throw unavailable();
      }
      if (state.lifetime_issued >= ACCOUNTLESS_ENROLLMENT_LIFETIME_ISSUANCE_CEILING
          || budgetDay > day
          || (budgetDay === day
            && state.daily_issued >= ACCOUNTLESS_ENROLLMENT_DAILY_ISSUANCE_BUDGET)) {
        throw new ApiError(429, "ACCOUNTLESS_ENROLLMENT_LIMIT_REACHED", {
          responseHeaders: { "retry-after": "86400" },
        });
      }
      const updated = await client.query(
        `UPDATE ${table(schema, "accountless_enrollment_issuance")}
            SET budget_day = $1::date,
                daily_issued = CASE WHEN budget_day = $1::date THEN daily_issued + 1 ELSE 1 END,
                lifetime_issued = lifetime_issued + 1,
                last_issue_token = $2,
                updated_at = $3::timestamptz
          WHERE singleton = 1 AND lifetime_issued < $4
            AND budget_day <= $1::date
            AND (budget_day <> $1::date OR daily_issued < $5)
          RETURNING singleton`,
        [day, issueToken, issuedAt, ACCOUNTLESS_ENROLLMENT_LIFETIME_ISSUANCE_CEILING,
          ACCOUNTLESS_ENROLLMENT_DAILY_ISSUANCE_BUDGET],
      );
      if (updated.rowCount !== 1) throw unavailable();
      const inserted = await client.query(
        `INSERT INTO ${table(schema, "accountless_enrollment_ledger")} (
           device_id, device_secret_hash, installation_principal_id,
           schema_version, policy_version, authorization_basis, state,
           issued_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7::timestamptz, $8::timestamptz)
         ON CONFLICT (device_id) DO NOTHING
         RETURNING device_id`,
        [parsed.deviceId, Uint8Array.from(parsed.deviceSecretHash), issueToken,
          parsed.schemaVersion, parsed.policyVersion, parsed.authorizationBasis,
          issuedAt, expiresAt],
      );
      if (inserted.rowCount !== 1) throw new EnrollmentReplayRace();
    }, {
      operation: "accountless.enrollment.issue",
      preserveSafeError: (error) => error instanceof EnrollmentReplayRace ? error : safeError(error),
    });
  } catch (error) {
    if (error instanceof EnrollmentReplayRace) raced = true;
    else if (error instanceof ApiError) throw error;
    else throw unavailable();
  }
  const inserted = await readEnrollment(pool, schema, parsed.deviceId);
  if (!inserted) throw unavailable();
  const replay = replayEnrollment(inserted, parsed, nowEpoch);
  return raced ? replay : {
    status: 201,
    response: Object.freeze({ ...replay.response, state: "enrolled" }),
  };
}

function normalizeOwner(row: OwnerDbRow | undefined): OwnerDbRow | null {
  if (!row) return null;
  const hash = bytes(row.device_secret_hash);
  const ownerExpiry = canonicalInstant(row.owner_expires_at);
  const v11Expiry = canonicalInstant(row.v11_expires_at);
  const deviceExpiry = canonicalInstant(row.device_expires_at);
  if (typeof row.enrollment_device_id !== "string" || !UUID_V4.test(row.enrollment_device_id)
      || typeof row.participant_id !== "string" || !PARTICIPANT_ID.test(row.participant_id)
      || row.device_credential_id !== row.enrollment_device_id
      || row.owner_policy_version !== ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION
      || row.owner_authorization_basis !== ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS
      || row.owner_state !== "active" && row.owner_state !== "revoked"
      || ownerExpiry === null || row.v11_state !== "active" && row.v11_state !== "revoked"
      || row.v11_schema_version !== TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION
      || row.v11_dictionary_version !== telemetryV11RequiredConsent().fieldDictionaryVersion
      || row.v11_privacy_version !== telemetryV11RequiredConsent().privacyContractVersion
      || v11Expiry === null || hash === null || hash.byteLength !== 32
      || row.device_state !== "active" && row.device_state !== "revoked"
      || deviceExpiry === null || row.device_authority_kind !== "accountless"
      || row.device_enrollment_id !== row.enrollment_device_id
      || row.participant_state !== "active" && row.participant_state !== "deleting"
      || row.participant_owner_kind !== "accountless"
      || Date.parse(ownerExpiry) !== Date.parse(v11Expiry)
      || Date.parse(ownerExpiry) !== Date.parse(deviceExpiry)) {
    return null;
  }
  return { ...row, device_secret_hash: hash, owner_expires_at: ownerExpiry,
    v11_expires_at: v11Expiry, device_expires_at: deviceExpiry };
}

async function readOwner(
  pool: PostgresPool,
  schema: string,
  deviceId: string,
): Promise<OwnerDbRow | null> {
  try {
    return await withPostgresRead(pool, async (client) => {
      const result = await client.query<OwnerDbRow>(
        `SELECT owner.enrollment_device_id, owner.participant_id,
                owner.device_credential_id,
                owner.policy_version AS owner_policy_version,
                owner.authorization_basis AS owner_authorization_basis,
                owner.state AS owner_state, owner.expires_at AS owner_expires_at,
                grant_row.state AS v11_state,
                grant_row.telemetry_schema_version AS v11_schema_version,
                grant_row.field_dictionary_version AS v11_dictionary_version,
                grant_row.privacy_contract_version AS v11_privacy_version,
                grant_row.expires_at AS v11_expires_at,
                device.secret_hash AS device_secret_hash, device.state AS device_state,
                device.expires_at AS device_expires_at,
                device.authority_kind AS device_authority_kind,
                device.accountless_enrollment_device_id AS device_enrollment_id,
                participant.state AS participant_state,
                participant.owner_kind AS participant_owner_kind
           FROM ${table(schema, "accountless_upload_owners")} owner
           JOIN ${table(schema, "accountless_v11_device_authorizations")} grant_row
             ON grant_row.enrollment_device_id = owner.enrollment_device_id
           JOIN ${table(schema, "device_credentials")} device
             ON device.id = owner.device_credential_id
           JOIN ${table(schema, "participants")} participant
             ON participant.id = owner.participant_id
          WHERE owner.enrollment_device_id = $1`,
        [deviceId],
      );
      if (result.rows.length > 1) throw unavailable();
      const row = normalizeOwner(result.rows[0]);
      if (result.rows.length === 1 && row === null) throw unavailable();
      return row;
    }, { operation: "accountless.owner.read", preserveSafeError: safeError });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
}

function assertValidOwner(
  owner: OwnerDbRow,
  ledger: NormalizedEnrollment,
  presentedHash: Uint8Array,
  nowEpoch: number,
): void {
  const ownerExpiresAt = epoch(owner.owner_expires_at);
  const ledgerExpiresAt = epoch(ledger.expires_at);
  if (!timingSafeEqual(owner.device_secret_hash, ledger.device_secret_hash)
      || !timingSafeEqual(owner.device_secret_hash, presentedHash)) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  if (owner.enrollment_device_id !== ledger.device_id
      || owner.participant_state !== "active"
      || owner.owner_state !== "active" || owner.v11_state !== "active"
      || owner.device_state !== "active"
      || ownerExpiresAt === null || ownerExpiresAt !== ledgerExpiresAt
      || ownerExpiresAt <= nowEpoch) {
    throw new ApiError(401, "ACCOUNTLESS_OWNERSHIP_REVOKED");
  }
}

async function authenticatedEnrollment(
  pool: PostgresPool,
  schema: string,
  authorizationHeader: string | null,
  nowEpoch: number,
): Promise<{ ledger: NormalizedEnrollment; presentedHash: Uint8Array }> {
  const parsed = parseDeviceAuthorization(authorizationHeader);
  const presentedHash = await deviceHash(parsed.id, parsed.secret);
  const ledger = await readEnrollment(pool, schema, parsed.id);
  if (!ledger || !timingSafeEqual(presentedHash, ledger.device_secret_hash)) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  if (ledger.policy_version !== ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION
      || ledger.authorization_basis !== ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS
      || ledger.state === "revoked") {
    throw new ApiError(401, "ACCOUNTLESS_OWNERSHIP_REVOKED");
  }
  if (Date.parse(ledger.expires_at) <= nowEpoch) {
    throw new ApiError(410, "ACCOUNTLESS_OWNERSHIP_EXPIRED");
  }
  return { ledger, presentedHash };
}

/** Authenticate an active v1.1 accountless owner before its separate v1.2 grant exists. */
export async function authenticatePostgresAccountlessOwnerForV12Grant(
  pool: PostgresPool,
  authorizationHeader: string | null,
  options: PostgresAccountlessOptions = {},
): Promise<{ readonly participantId: string; readonly deviceId: string }> {
  const nowEpoch = options.nowEpoch ?? Date.now();
  validNow(nowEpoch);
  const schema = schemaName(options);
  const authenticated = await authenticatedEnrollment(pool, schema, authorizationHeader, nowEpoch);
  const owner = await readOwner(pool, schema, authenticated.ledger.device_id);
  if (!owner) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  assertValidOwner(owner, authenticated.ledger, authenticated.presentedHash, nowEpoch);
  return Object.freeze({ participantId: owner.participant_id, deviceId: owner.device_credential_id });
}

/** Bind the enrollment bearer to the participant/device owner graph atomically. */
export async function createPostgresAccountlessUploadOwner(
  pool: PostgresPool,
  authorizationHeader: string | null,
  request: AccountlessOwnershipRequest,
  options: PostgresAccountlessOptions = {},
): Promise<AccountlessOwnershipResult> {
  const nowEpoch = options.nowEpoch ?? Date.now();
  validNow(nowEpoch);
  const parsed = parseAccountlessOwnershipRequest(request);
  const schema = schemaName(options);
  const authenticated = await authenticatedEnrollment(pool, schema, authorizationHeader, nowEpoch);
  const existing = await readOwner(pool, schema, authenticated.ledger.device_id);
  if (existing) {
    assertValidOwner(existing, authenticated.ledger, authenticated.presentedHash, nowEpoch);
    return { status: 200, response: accountlessOwnershipResponse(
      authenticated.ledger.device_id, authenticated.ledger.expires_at, "existing",
    ) };
  }

  const now = new Date(nowEpoch).toISOString();
  const participantId = `participant:${crypto.randomUUID()}`;
  const consent = telemetryV11RequiredConsent();
  let created = false;
  try {
    await withPostgresMutation(pool, async (client) => {
      const locked = await client.query<EnrollmentDbRow>(
        `SELECT device_id, device_secret_hash, installation_principal_id,
                schema_version, policy_version, authorization_basis, state,
                issued_at, expires_at, renewal_generation, renewed_at,
                revoked_at, revocation_reason
           FROM ${table(schema, "accountless_enrollment_ledger")}
          WHERE device_id = $1 FOR UPDATE`,
        [authenticated.ledger.device_id],
      );
      const ledger = normalizeEnrollment(locked.rows[0]);
      if (!ledger) throw new ApiError(401, "DEVICE_AUTH_INVALID");
      if (!timingSafeEqual(ledger.device_secret_hash, authenticated.presentedHash)) {
        throw new ApiError(401, "DEVICE_AUTH_INVALID");
      }
      if (ledger.state !== "active") throw new ApiError(401, "ACCOUNTLESS_OWNERSHIP_REVOKED");
      if (Date.parse(ledger.expires_at) <= nowEpoch) {
        throw new ApiError(410, "ACCOUNTLESS_OWNERSHIP_EXPIRED");
      }
      const current = await client.query<OwnerDbRow>(
        `SELECT owner.enrollment_device_id, owner.participant_id,
                owner.device_credential_id,
                owner.policy_version AS owner_policy_version,
                owner.authorization_basis AS owner_authorization_basis,
                owner.state AS owner_state, owner.expires_at AS owner_expires_at,
                grant_row.state AS v11_state,
                grant_row.telemetry_schema_version AS v11_schema_version,
                grant_row.field_dictionary_version AS v11_dictionary_version,
                grant_row.privacy_contract_version AS v11_privacy_version,
                grant_row.expires_at AS v11_expires_at,
                device.secret_hash AS device_secret_hash, device.state AS device_state,
                device.expires_at AS device_expires_at,
                device.authority_kind AS device_authority_kind,
                device.accountless_enrollment_device_id AS device_enrollment_id,
                participant.state AS participant_state,
                participant.owner_kind AS participant_owner_kind
           FROM ${table(schema, "accountless_upload_owners")} owner
           JOIN ${table(schema, "accountless_v11_device_authorizations")} grant_row
             ON grant_row.enrollment_device_id = owner.enrollment_device_id
           JOIN ${table(schema, "device_credentials")} device
             ON device.id = owner.device_credential_id
           JOIN ${table(schema, "participants")} participant
             ON participant.id = owner.participant_id
          WHERE owner.enrollment_device_id = $1`,
        [ledger.device_id],
      );
      if (current.rows.length > 0) {
        const owner = normalizeOwner(current.rows[0]);
        if (!owner) throw unavailable();
        assertValidOwner(owner, ledger, authenticated.presentedHash, nowEpoch);
        return;
      }

      const participant = await client.query(
        `INSERT INTO ${table(schema, "participants")}
           (id, owner_kind, state, consent_version, consented_at, created_at)
         VALUES ($1, 'accountless', 'active', NULL, NULL, $2::timestamptz)
         RETURNING id`,
        [participantId, now],
      );
      const device = await client.query(
        `INSERT INTO ${table(schema, "device_credentials")} (
           id, participant_id, authority_kind, paired_via_pairing_id,
           accountless_enrollment_device_id, secret_hash, state, issued_at,
           expires_at, last_used_at, revoked_at, social_verified_at,
           credential_generation
         ) VALUES ($1, $2, 'accountless', NULL, $1, $3, 'active', $4::timestamptz,
                   $5::timestamptz, $4::timestamptz, NULL, NULL, 1)
         RETURNING id`,
        [ledger.device_id, participantId, Uint8Array.from(authenticated.presentedHash),
          now, ledger.expires_at],
      );
      const owner = await client.query(
        `INSERT INTO ${table(schema, "accountless_upload_owners")} (
           enrollment_device_id, participant_id, device_credential_id,
           policy_version, authorization_basis, authorized_at, expires_at, state
         ) VALUES ($1, $2, $1, $3, $4, $5::timestamptz, $6::timestamptz, 'active')
         RETURNING enrollment_device_id`,
        [ledger.device_id, participantId, ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
          ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS, now, ledger.expires_at],
      );
      const v11 = await client.query(
        `INSERT INTO ${table(schema, "accountless_v11_device_authorizations")} (
           enrollment_device_id, participant_id, device_credential_id,
           telemetry_schema_version, field_dictionary_version,
           privacy_contract_version, authorized_at, expires_at, state
         ) VALUES ($1, $2, $1, $3, $4, $5, $6::timestamptz, $7::timestamptz, 'active')
         RETURNING enrollment_device_id`,
        [ledger.device_id, participantId, TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
          consent.fieldDictionaryVersion, consent.privacyContractVersion, now, ledger.expires_at],
      );
      if (participant.rowCount !== 1 || device.rowCount !== 1
          || owner.rowCount !== 1 || v11.rowCount !== 1) {
        throw unavailable();
      }
      created = true;
    }, { operation: "accountless.owner.create", preserveSafeError: safeError });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }

  const result = await readOwner(pool, schema, authenticated.ledger.device_id);
  if (!result) throw unavailable();
  assertValidOwner(result, authenticated.ledger, authenticated.presentedHash, nowEpoch);
  return { status: created ? 201 : 200, response: accountlessOwnershipResponse(
    authenticated.ledger.device_id, authenticated.ledger.expires_at,
    created ? "created" : "existing",
  ) };
}

interface V12OwnerRow {
  enrollment_device_id: string;
  participant_id: string;
  device_credential_id: string;
  owner_expires_at: Date | string;
}

interface V12GrantDbRow {
  enrollment_device_id: string;
  participant_id: string;
  device_credential_id: string;
  schema_version: string;
  policy_version: string;
  authorization_basis: string;
  telemetry_schema_version: string;
  field_dictionary_version: string;
  privacy_contract_version: string;
  authorized_at: Date | string;
  expires_at: Date | string;
  state: "active" | "revoked";
  revoked_at: Date | string | null;
  revocation_reason: string | null;
}

function validV12Grant(
  row: V12GrantDbRow | undefined,
  owner: V12OwnerRow,
  nowEpoch: number,
): boolean {
  if (!row) return false;
  const authorizedAt = epoch(row.authorized_at);
  const expiresAt = epoch(row.expires_at);
  const revokedAt = epoch(row.revoked_at);
  return row.enrollment_device_id === owner.enrollment_device_id
    && row.participant_id === owner.participant_id
    && row.device_credential_id === owner.device_credential_id
    && row.schema_version === ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION
    && row.policy_version === ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION
    && row.authorization_basis === ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS
    && row.telemetry_schema_version === TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION
    && row.field_dictionary_version === TELEMETRY_V12_FIELD_DICTIONARY_VERSION
    && row.privacy_contract_version === TELEMETRY_V12_PRIVACY_CONTRACT_VERSION
    && authorizedAt !== null && authorizedAt <= nowEpoch
    && expiresAt !== null && expiresAt === epoch(owner.owner_expires_at)
    && ((row.state === "active" && revokedAt === null && row.revocation_reason === null)
      || (row.state === "revoked" && revokedAt !== null
        && REVOCATION_REASON.test(row.revocation_reason ?? "")));
}

/** Grant v1.2 only to an active accountless owner and never reactivate a revoked grant. */
export async function grantPostgresTelemetryV12AccountlessAuthorization(
  pool: PostgresPool,
  principal: { readonly participantId: string; readonly deviceId: string },
  request: TelemetryV12AccountlessAuthorizationRequest,
  options: PostgresAccountlessOptions = {},
): Promise<void> {
  const nowEpoch = options.nowEpoch ?? Date.now();
  validNow(nowEpoch);
  const parsed = parseTelemetryV12AccountlessAuthorizationRequest(request);
  const schema = schemaName(options);
  try {
    await withPostgresMutation(pool, async (client) => {
      const authority = await client.query<V12OwnerRow>(
        `SELECT owner.enrollment_device_id, owner.participant_id,
                owner.device_credential_id, owner.expires_at AS owner_expires_at
           FROM ${table(schema, "accountless_upload_owners")} owner
           JOIN ${table(schema, "accountless_enrollment_ledger")} ledger
             ON ledger.device_id = owner.enrollment_device_id
           JOIN ${table(schema, "participants")} participant
             ON participant.id = owner.participant_id
           JOIN ${table(schema, "device_credentials")} device
             ON device.id = owner.device_credential_id
           JOIN ${table(schema, "telemetry_v12_runtime")} legacy_runtime ON legacy_runtime.id = 1
           JOIN ${table(schema, "telemetry_v12_typed_runtime")} runtime ON runtime.id = 1
          WHERE owner.participant_id = $1 AND owner.device_credential_id = $2
            AND owner.state = 'active' AND owner.expires_at > $3::timestamptz
            AND ledger.state = 'active' AND ledger.expires_at = owner.expires_at
            AND participant.state = 'active' AND participant.owner_kind = 'accountless'
            AND device.state = 'active' AND device.authority_kind = 'accountless'
            AND device.accountless_enrollment_device_id = owner.enrollment_device_id
            AND device.expires_at = owner.expires_at
            AND legacy_runtime.state = 'active'
            AND runtime.state = 'active'
            AND runtime.schema_version = $4
            AND runtime.field_dictionary_version = $5
            AND runtime.privacy_contract_version = $6
          FOR SHARE OF owner, ledger, participant, device, legacy_runtime, runtime`,
        [principal.participantId, principal.deviceId, new Date(nowEpoch).toISOString(),
          parsed.telemetrySchemaVersion, TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
          TELEMETRY_V12_PRIVACY_CONTRACT_VERSION],
      );
      const owner = authority.rows[0];
      if (!owner || authority.rows.length !== 1) {
        throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
      }
      const now = new Date(nowEpoch).toISOString();
      const inserted = await client.query(
        `INSERT INTO ${table(schema, "accountless_v12_device_authorizations")} (
           enrollment_device_id, participant_id, device_credential_id,
           schema_version, policy_version, authorization_basis,
           telemetry_schema_version, field_dictionary_version,
           privacy_contract_version, authorized_at, expires_at, state
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                   $10::timestamptz, $11::timestamptz, 'active')
         ON CONFLICT (enrollment_device_id) DO NOTHING
         RETURNING enrollment_device_id`,
        [owner.enrollment_device_id, owner.participant_id, owner.device_credential_id,
          parsed.schemaVersion, parsed.policyVersion, parsed.authorizationBasis,
          parsed.telemetrySchemaVersion, TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
          TELEMETRY_V12_PRIVACY_CONTRACT_VERSION, now, owner.owner_expires_at],
      );
      if (inserted.rowCount === 1) return;

      const existing = await client.query<V12GrantDbRow>(
        `SELECT enrollment_device_id, participant_id, device_credential_id,
                schema_version, policy_version, authorization_basis,
                telemetry_schema_version, field_dictionary_version,
                privacy_contract_version, authorized_at, expires_at, state,
                revoked_at, revocation_reason
           FROM ${table(schema, "accountless_v12_device_authorizations")}
          WHERE enrollment_device_id = $1 FOR UPDATE`,
        [owner.enrollment_device_id],
      );
      const existingGrant = existing.rows[0];
      if (existing.rowCount !== 1 || !validV12Grant(existingGrant, owner, nowEpoch)
          || existingGrant?.state !== "active") {
        throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
      }
    }, { operation: "accountless.v12.authorization", preserveSafeError: safeError });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
}
