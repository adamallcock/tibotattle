import {
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
  MAX_REQUEST_BYTES,
  TELEMETRY_CONSENT_VERSION,
  UPLOAD_AUTHORIZATION_TTL_MILLISECONDS,
} from "./constants";
import type { DevicePrincipal } from "./device-auth";
import { randomSecret, sha256 } from "./crypto";
import { ApiError } from "./errors";
import {
  createPostgresSchemaConfig,
  withPostgresMutation,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";

export interface PostgresUploadAuthorizationOptions {
  readonly nowEpoch?: number;
  readonly schema?: PostgresSchemaConfig;
}

export interface PostgresUploadAuthorizationRequest {
  readonly envelopeDigest: string;
  readonly bodyBytes: number;
}

interface DeviceAuthorizationRow {
  id: string;
  participant_id: string;
  authority_kind: "social" | "accountless";
  state: "active" | "revoked";
  expires_at: string | Date;
  accountless_enrollment_device_id: string | null;
  participant_state: "active" | "deleting";
  participant_owner_kind: "social" | "accountless";
  participant_consent_version: string | null;
}

interface AccountlessUploadAuthorityRow {
  ledger_state: string;
  ledger_expires_at: string | Date;
  owner_state: string;
  owner_expires_at: string | Date;
  authorization_state: string;
  authorization_expires_at: string | Date;
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const SOCIAL_CONSENT_VERSIONS = new Set([
  TELEMETRY_CONSENT_VERSION,
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
]);

function schemaName(options: PostgresUploadAuthorizationOptions): string {
  return `"${createPostgresSchemaConfig(options.schema ?? {}).primarySchema}"`;
}

function table(schema: string, name: string): string {
  return `${schema}."${name}"`;
}

function time(value: string | Date): number {
  const epoch = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(epoch) ? epoch : Number.NaN;
}

function safeError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

function backendError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function validatePrincipal(principal: DevicePrincipal, nowEpoch: number): void {
  const principalExpiry = typeof principal?.expiresAt === "string"
    ? Date.parse(principal.expiresAt) : Number.NaN;
  if (principal === null || typeof principal !== "object"
      || typeof principal.deviceId !== "string" || principal.deviceId.length < 1
      || typeof principal.participantId !== "string" || principal.participantId.length < 1
      || !Number.isFinite(principalExpiry)
      || (principal.authorityKind === "accountless" && principalExpiry <= nowEpoch)
      || (principal.authorityKind !== "social" && principal.authorityKind !== "accountless")
      || (principal.authorityKind === "social"
        && (typeof principal.participantConsentVersion !== "string"
          || !SOCIAL_CONSENT_VERSIONS.has(principal.participantConsentVersion)))
      || (principal.authorityKind === "accountless"
        && principal.participantConsentVersion !== null)) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
}

function validateRequest(request: PostgresUploadAuthorizationRequest): void {
  if (request === null || typeof request !== "object"
      || !SHA256_HEX.test(request.envelopeDigest)
      || !Number.isSafeInteger(request.bodyBytes)
      || request.bodyBytes <= 0 || request.bodyBytes > MAX_REQUEST_BYTES) {
    throw new ApiError(400, "BODY_INVALID");
  }
}

async function assertAccountlessUploadAuthority(
  client: PostgresClient,
  schema: string,
  device: DevicePrincipal,
  deviceExpiresAt: string | Date,
  nowEpoch: number,
): Promise<void> {
  const result = await client.query<AccountlessUploadAuthorityRow>(
    `SELECT ledger.state AS ledger_state, ledger.expires_at AS ledger_expires_at,
            owner.state AS owner_state, owner.expires_at AS owner_expires_at,
            grant_row.state AS authorization_state,
            grant_row.expires_at AS authorization_expires_at
       FROM ${table(schema, "accountless_enrollment_ledger")} ledger
       JOIN ${table(schema, "accountless_upload_owners")} owner
         ON owner.enrollment_device_id = ledger.device_id
       JOIN ${table(schema, "accountless_v11_device_authorizations")} grant_row
         ON grant_row.enrollment_device_id = ledger.device_id
        AND grant_row.participant_id = owner.participant_id
        AND grant_row.device_credential_id = owner.device_credential_id
      WHERE ledger.device_id = $1 AND owner.participant_id = $2
        AND owner.device_credential_id = $1
        AND grant_row.participant_id = $2 AND grant_row.device_credential_id = $1
      FOR SHARE OF ledger, owner, grant_row`,
    [device.deviceId, device.participantId],
  );
  const row = result.rows[0];
  const deviceExpiry = time(deviceExpiresAt);
  if (!row || row.ledger_state !== "active" || row.owner_state !== "active"
      || row.authorization_state !== "active"
      || !Number.isFinite(deviceExpiry) || deviceExpiry <= nowEpoch
      || time(row.ledger_expires_at) !== deviceExpiry
      || time(row.owner_expires_at) !== deviceExpiry
      || time(row.authorization_expires_at) !== deviceExpiry) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
}

/**
 * Mint a purpose-bound, five-minute upload credential in PostgreSQL.
 *
 * This mirrors the D1 storage operation: callers must already have enforced
 * collection control, request policy, deletion-ledger tombstones, rate and
 * ingress budgets, device authentication, and the requested telemetry-format
 * authorization. The method rechecks current primary-schema device and
 * participant authority transactionally before inserting the one-use grant.
 * Accountless issuance retains the shared v1.1 grant required by the generic
 * Worker transport; a v1.2 caller must also run the separate typed-v1.2
 * admission check before issuing.
 */
export async function createPostgresDeviceUploadAuthorization(
  pool: PostgresPool,
  device: DevicePrincipal,
  request: PostgresUploadAuthorizationRequest,
  options: PostgresUploadAuthorizationOptions = {},
): Promise<{ uploadAuthorization: string; expiresAt: string }> {
  const nowEpoch = options.nowEpoch ?? Date.now();
  const now = new Date(nowEpoch);
  if (!Number.isSafeInteger(nowEpoch) || !Number.isFinite(now.getTime())) {
    throw new ApiError(500, "LIFECYCLE_BOUNDS_EXCEEDED");
  }
  validatePrincipal(device, nowEpoch);
  validateRequest(request);

  const expiresEpoch = device.authorityKind === "accountless"
    ? Math.min(nowEpoch + UPLOAD_AUTHORIZATION_TTL_MILLISECONDS, Date.parse(device.expiresAt))
    : nowEpoch + UPLOAD_AUTHORIZATION_TTL_MILLISECONDS;
  const expires = new Date(expiresEpoch);
  if (!Number.isFinite(expires.getTime()) || expiresEpoch <= nowEpoch) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }

  const id = crypto.randomUUID();
  const secret = randomSecret(32);
  const secretHash = await sha256(`app-usagemonitor/device-upload/v1\0${id}\0${secret}`);
  const schema = schemaName(options);
  const issuedAt = now.toISOString();
  const expiresAt = expires.toISOString();

  try {
    return await withPostgresMutation(pool, async (client) => {
      const result = await client.query<DeviceAuthorizationRow>(
        `SELECT device.id, device.participant_id, device.authority_kind, device.state,
                device.expires_at, device.accountless_enrollment_device_id,
                participant.state AS participant_state,
                participant.owner_kind AS participant_owner_kind,
                participant.consent_version AS participant_consent_version
           FROM ${table(schema, "device_credentials")} device
           JOIN ${table(schema, "participants")} participant
             ON participant.id = device.participant_id
          WHERE device.id = $1 AND device.participant_id = $2
          FOR UPDATE OF device, participant`,
        [device.deviceId, device.participantId],
      );
      const row = result.rows[0];
      const deviceExpiry = row ? time(row.expires_at) : Number.NaN;
      if (!row || row.state !== "active" || row.participant_state !== "active"
          || row.authority_kind !== device.authorityKind
          || row.participant_owner_kind !== device.authorityKind
          || !Number.isFinite(deviceExpiry) || deviceExpiry <= nowEpoch
          || (device.authorityKind === "social"
            && (row.participant_consent_version !== device.participantConsentVersion
              || row.participant_consent_version === null))
          || (device.authorityKind === "accountless"
            && (row.participant_consent_version !== null
              || row.accountless_enrollment_device_id !== device.deviceId))) {
        throw new ApiError(401, "DEVICE_AUTH_INVALID");
      }
      if (device.authorityKind === "accountless") {
        await assertAccountlessUploadAuthority(client, schema, device, row.expires_at, nowEpoch);
      }
      const inserted = await client.query(
        `INSERT INTO ${table(schema, "device_upload_authorizations")} (
           id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
           body_bytes, content_type, state, issued_at, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'application/json','unused',$7,$8)
         RETURNING id`,
        [id, row.participant_id, row.id, secretHash, request.envelopeDigest,
          request.bodyBytes, issuedAt, expiresAt],
      );
      if (inserted.rowCount !== 1) throw new ApiError(401, "DEVICE_AUTH_INVALID");
      return Object.freeze({
        uploadAuthorization: `um_device_upload_${id}.${secret}`,
        expiresAt,
      });
    }, {
      operation: "device_upload.issue",
      preserveSafeError: safeError,
    });
  } catch (error) {
    backendError(error);
  }
}
