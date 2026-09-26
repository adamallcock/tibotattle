import {
  MAX_REQUEST_BYTES,
  UPLOAD_CONSUME_LEASE_MILLISECONDS,
} from "./constants";
import {
  type DevicePrincipal,
  type DeviceUploadClaim,
} from "./device-auth";
import { ApiError } from "./errors";
import { sha256, timingSafeEqual } from "./crypto";
import {
  createPostgresSchemaConfig,
  withPostgresMutation,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";
import {
  authenticatePostgresDeviceBearer,
  readPostgresAccountlessDeviceAuthority,
  type PostgresDeviceBearerAuthenticationOptions,
} from "./postgres-device-bearer-auth";

/**
 * Options for the legacy private-host authenticator. Unlike the shared
 * bearer helper, an omitted `accountlessAuthorizationVersion` keeps the
 * stricter typed-v1.2 accountless fence; capability negotiation passes
 * `'v1.1'` explicitly.
 */
export type PostgresDeviceAuthenticationOptions = PostgresDeviceBearerAuthenticationOptions;

export interface PostgresDeviceUploadClaimOptions {
  readonly nowEpoch?: number;
  readonly schema?: PostgresSchemaConfig;
}

export interface PostgresDeviceUploadClaimRequest {
  readonly envelopeDigest: string;
  readonly bodyBytes: number;
  readonly contentType: string;
}

interface UploadAuthorizationRow {
  id: string;
  participant_id: string;
  issued_by_device_id: string;
  secret_hash: Uint8Array;
  envelope_digest: string;
  body_bytes: number;
  content_type: string;
  state: "unused" | "consuming" | "consumed" | "revoked";
  expires_at: string | Date;
  participant_state: "active" | "deleting";
  participant_owner_kind: "social" | "accountless";
  device_authority_kind: "social" | "accountless";
  device_state: "active" | "revoked";
  device_expires_at: string | Date;
  accountless_enrollment_device_id: string | null;
}

interface UploadAbandonmentRow {
  state: "unused" | "consuming" | "consumed" | "revoked";
  consumed_contribution_id: string | null;
}

interface UploadReferenceRow {
  referenced: boolean;
}

interface PostgresTypedV12TransportRuntime {
  readonly schema?: PostgresSchemaConfig;
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PARTICIPANT_ID = /^[A-Za-z0-9._:-]{1,256}$/u;

function schemaName(options: PostgresTypedV12TransportRuntime): string {
  return `"${createPostgresSchemaConfig(options.schema ?? {}).primarySchema}"`;
}

function table(schema: string, name: string): string {
  return `${schema}."${name}"`;
}

function time(value: string | Date): number {
  const epoch = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(epoch) ? epoch : Number.NaN;
}

function epochIso(epoch: number): string {
  const value = new Date(epoch);
  if (!Number.isSafeInteger(epoch) || !Number.isFinite(value.getTime())) {
    throw new ApiError(500, "LIFECYCLE_BOUNDS_EXCEEDED");
  }
  return value.toISOString();
}

function safeError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

function backendError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function uploadSecret(header: string | null): { id: string; secret: string } {
  if (!header?.startsWith("Upload ")) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  const match = /^um_device_upload_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u
    .exec(header.slice(7));
  if (!match?.[1] || !match[2]) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  return { id: match[1], secret: match[2] };
}

async function deviceUploadHash(id: string, secret: string): Promise<Uint8Array> {
  return sha256(`app-usagemonitor/device-upload/v1\0${id}\0${secret}`);
}

/**
 * Authenticate a device bearer for the private test host. It delegates to the
 * shared `authenticatePostgresDeviceBearer`, so credential-reuse revocation
 * commits before the neutral 401. For backward compatibility an omitted
 * `accountlessAuthorizationVersion` still means `'v1.2'`: accountless devices
 * must also hold the current typed-v1.2 grant unless the caller asks for the
 * Worker's base v1.1 gate. This function does not grant telemetry consent: the
 * v1.2 admission adapter rechecks that separately in its write transaction.
 */
export async function authenticatePostgresDevice(
  pool: PostgresPool,
  authorizationHeader: string | null,
  options: PostgresDeviceAuthenticationOptions = {},
): Promise<DevicePrincipal> {
  return authenticatePostgresDeviceBearer(pool, authorizationHeader, {
    ...options,
    accountlessAuthorizationVersion: options.accountlessAuthorizationVersion ?? "v1.2",
  });
}

/**
 * Claim a device upload grant once. The header is purpose-bound, the envelope
 * digest, byte length, and content type must exactly match the minted grant,
 * and current device/owner authority is checked in the same transaction that
 * advances `unused` to `consuming`. Accountless claims require both the shared
 * v1.1 bearer/upload authorization used by the generic Worker transport gate
 * and the additional v1.2 schema authorization checked by v1.2 admission.
 */
export async function claimPostgresDeviceUploadAuthorization(
  pool: PostgresPool,
  authorizationHeader: string | null,
  request: PostgresDeviceUploadClaimRequest,
  options: PostgresDeviceUploadClaimOptions = {},
): Promise<DeviceUploadClaim> {
  const parsed = uploadSecret(authorizationHeader);
  const nowEpoch = options.nowEpoch ?? Date.now();
  const now = epochIso(nowEpoch);
  if (!SHA256_HEX.test(request.envelopeDigest)
      || !Number.isSafeInteger(request.bodyBytes) || request.bodyBytes < 1
      || request.bodyBytes > MAX_REQUEST_BYTES
      || request.contentType !== "application/json") {
    throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  }
  const presentedHash = await deviceUploadHash(parsed.id, parsed.secret);
  const leaseExpiresAt = new Date(nowEpoch + UPLOAD_CONSUME_LEASE_MILLISECONDS);
  if (!Number.isFinite(leaseExpiresAt.getTime())) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  const schema = schemaName(options);

  try {
    return await withPostgresMutation(pool, async (client) => {
      const result = await client.query<UploadAuthorizationRow>(
        `SELECT upload.id, upload.participant_id, upload.issued_by_device_id, upload.secret_hash,
                upload.envelope_digest, upload.body_bytes, upload.content_type, upload.state,
                upload.expires_at, participant.state AS participant_state,
                participant.owner_kind AS participant_owner_kind,
                device.authority_kind AS device_authority_kind, device.state AS device_state,
                device.expires_at AS device_expires_at,
                device.accountless_enrollment_device_id
           FROM ${table(schema, "device_upload_authorizations")} upload
           JOIN ${table(schema, "participants")} participant ON participant.id = upload.participant_id
           JOIN ${table(schema, "device_credentials")} device
             ON device.id = upload.issued_by_device_id AND device.participant_id = upload.participant_id
          WHERE upload.id = $1
          FOR UPDATE OF upload, participant, device`,
        [parsed.id],
      );
      const row = result.rows[0];
      const storedHash = row?.secret_hash ?? new Uint8Array(32);
      const secretMatches = timingSafeEqual(presentedHash, storedHash);
      if (!secretMatches || !row
          || row.state !== "unused" || row.participant_state !== "active"
          || row.device_state !== "active"
          || row.participant_owner_kind !== row.device_authority_kind
          || time(row.expires_at) <= nowEpoch || time(row.device_expires_at) <= nowEpoch
          || row.envelope_digest !== request.envelopeDigest
          || row.body_bytes !== request.bodyBytes
          || row.content_type !== request.contentType) {
        throw new ApiError(401, "UPLOAD_AUTH_INVALID");
      }
      if (row.device_authority_kind === "accountless"
          && !await readPostgresAccountlessDeviceAuthority(client, {
            schema: options.schema,
            participantId: row.participant_id,
            deviceId: row.issued_by_device_id,
            enrollmentDeviceId: row.accountless_enrollment_device_id,
            deviceExpiresAt: row.device_expires_at,
            nowEpoch,
            authorizationVersion: "v1.2",
          })) {
        throw new ApiError(401, "UPLOAD_AUTH_INVALID");
      }
      const updated = await client.query(
        `UPDATE ${table(schema, "device_upload_authorizations")}
            SET state = 'consuming', consume_lease_expires_at = $2
          WHERE id = $1 AND state = 'unused' AND expires_at > $3
          RETURNING id`,
        [row.id, leaseExpiresAt.toISOString(), now],
      );
      if (updated.rowCount !== 1) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
      return Object.freeze({
        authorizationId: row.id,
        participantId: row.participant_id,
        authorizationKind: "device",
      });
    }, {
      operation: "device_upload.claim",
      preserveSafeError: safeError,
    });
  } catch (error) {
    backendError(error);
  }
}

export interface PostgresDeviceUploadAbandonmentResult {
  /** False means consumption or a durable source reference won the race. */
  readonly abandoned: boolean;
}

/**
 * Terminally revoke a claimed device upload after its caller has confirmed
 * that the external write failed. Callers must pass the receipt returned by
 * `claimPostgresDeviceUploadAuthorization` and the same authenticated device
 * principal; raw upload bearer values are neither accepted nor stored here.
 *
 * The grant row lock serializes abandonment with chunk persistence. A source
 * reference check plus a guarded state transition protects already committed
 * contributions and makes duplicate abandonment harmless.
 */
export async function abandonPostgresDeviceUploadAuthorization(
  pool: PostgresPool,
  claim: DeviceUploadClaim,
  principal: DevicePrincipal,
  options: PostgresDeviceUploadClaimOptions = {},
): Promise<PostgresDeviceUploadAbandonmentResult> {
  if (claim.authorizationKind !== "device"
      || !UUID_V4.test(claim.authorizationId)
      || !PARTICIPANT_ID.test(claim.participantId)
      || claim.participantId !== principal.participantId
      || !UUID_V4.test(principal.deviceId)) {
    throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  }
  const now = epochIso(options.nowEpoch ?? Date.now());
  const schema = schemaName(options);
  const authorizationId = claim.authorizationId;
  const participantId = principal.participantId;
  const deviceId = principal.deviceId;
  const referencePredicate = `
    EXISTS (
      SELECT 1 FROM ${table(schema, "telemetry_contributions")}
       WHERE device_upload_authorization_id = $1
    ) OR EXISTS (
      SELECT 1 FROM ${table(schema, "telemetry_v1_chunks")}
       WHERE device_upload_authorization_id = $1
    ) OR EXISTS (
      SELECT 1 FROM ${table(schema, "telemetry_v11_chunks")}
       WHERE device_upload_authorization_id = $1
    ) OR EXISTS (
      SELECT 1 FROM ${table(schema, "telemetry_v12_chunks")}
       WHERE device_upload_authorization_id = $1
    )`;

  try {
    return await withPostgresMutation(pool, async (client) => {
      const result = await client.query<UploadAbandonmentRow>(
        `SELECT state, consumed_contribution_id
           FROM ${table(schema, "device_upload_authorizations")}
          WHERE id = $1 AND participant_id = $2 AND issued_by_device_id = $3
          FOR UPDATE`,
        [authorizationId, participantId, deviceId],
      );
      const grant = result.rows[0];
      if (!grant) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
      if (grant.state === "consumed" || grant.consumed_contribution_id !== null) {
        return Object.freeze({ abandoned: false });
      }

      const references = await client.query<UploadReferenceRow>(
        `SELECT ${referencePredicate} AS referenced`,
        [authorizationId],
      );
      const referenced = references.rows[0]?.referenced;
      if (typeof referenced !== "boolean") {
        throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      }
      if (referenced) return Object.freeze({ abandoned: false });
      if (grant.state === "revoked") return Object.freeze({ abandoned: true });
      if (grant.state !== "consuming") return Object.freeze({ abandoned: false });

      const updated = await client.query<{ id: string }>(
        `UPDATE ${table(schema, "device_upload_authorizations")}
            SET state = 'revoked', revoked_at = COALESCE(revoked_at, $4),
                consume_lease_expires_at = NULL
          WHERE id = $1 AND participant_id = $2 AND issued_by_device_id = $3
            AND state = 'consuming' AND consumed_contribution_id IS NULL
            AND NOT (${referencePredicate})
          RETURNING id`,
        [authorizationId, participantId, deviceId, now],
      );
      return Object.freeze({ abandoned: updated.rowCount === 1 });
    }, {
      operation: "device_upload.abandon",
      preserveSafeError: safeError,
    });
  } catch (error) {
    backendError(error);
  }
}
