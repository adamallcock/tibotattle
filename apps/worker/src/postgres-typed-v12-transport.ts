import {
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
  DEVICE_CREDENTIAL_TTL_MILLISECONDS,
  MAX_REQUEST_BYTES,
  TELEMETRY_CONSENT_VERSION,
  UPLOAD_CONSUME_LEASE_MILLISECONDS,
} from "./constants";
import {
  DEFAULT_DEVICE_LIFECYCLE_POLICY,
  deviceHash,
  parseDeviceAuthorization,
  type DeviceLifecycleOptions,
  type DevicePrincipal,
  type DeviceUploadClaim,
} from "./device-auth";
import { ApiError } from "./errors";
import { sha256, timingSafeEqual } from "./crypto";
import {
  createPostgresSchemaConfig,
  withPostgresMutation,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";

export interface PostgresDeviceAuthenticationOptions extends DeviceLifecycleOptions {
  readonly schema?: PostgresSchemaConfig;
  /** Legacy capability negotiation is authorized by the original v1.1 grant.
   * All other callers retain the stricter typed-v1.2 accountless fence. */
  readonly accountlessAuthorizationVersion?: "v1.1" | "v1.2";
}

export interface PostgresDeviceUploadClaimOptions {
  readonly nowEpoch?: number;
  readonly schema?: PostgresSchemaConfig;
}

export interface PostgresDeviceUploadClaimRequest {
  readonly envelopeDigest: string;
  readonly bodyBytes: number;
  readonly contentType: string;
}

interface DeviceAuthorityRow {
  id: string;
  participant_id: string;
  authority_kind: "social" | "accountless";
  secret_hash: Uint8Array;
  state: "active" | "revoked";
  issued_at: string | Date;
  expires_at: string | Date;
  last_used_at: string | Date;
  social_verified_at: string | Date | null;
  credential_generation: number;
  accountless_enrollment_device_id: string | null;
  participant_state: "active" | "deleting";
  participant_owner_kind: "social" | "accountless";
  participant_consent_version: string | null;
}

interface AccountlessAuthorityRow {
  ledger_state: string;
  ledger_expires_at: string | Date;
  owner_state: string;
  owner_expires_at: string | Date;
  shared_authorization_state: string;
  shared_authorization_expires_at: string | Date;
  authorization_state: string | null;
  authorization_expires_at: string | Date | null;
  telemetry_schema_version: string | null;
  field_dictionary_version: string | null;
  privacy_contract_version: string | null;
  schema_version: string | null;
  policy_version: string | null;
  authorization_basis: string | null;
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
const CONSENT_VERSIONS = new Set([
  TELEMETRY_CONSENT_VERSION,
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
]);

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

function recentInstant(value: string | Date | null, nowEpoch: number, maximumAge: number): boolean {
  if (value === null) return false;
  const parsed = time(value);
  return Number.isFinite(parsed) && parsed <= nowEpoch && parsed > nowEpoch - maximumAge;
}

function lifecyclePolicy(options: DeviceLifecycleOptions): {
  idleMilliseconds: number;
  socialRecheckMaxAgeMilliseconds: number;
} {
  const idleMilliseconds = options.policy?.idleMilliseconds
    ?? DEFAULT_DEVICE_LIFECYCLE_POLICY.idleMilliseconds;
  const socialRecheckMaxAgeMilliseconds = options.policy?.socialRecheckMaxAgeMilliseconds
    ?? DEFAULT_DEVICE_LIFECYCLE_POLICY.socialRecheckMaxAgeMilliseconds;
  if (!Number.isSafeInteger(idleMilliseconds) || idleMilliseconds <= 0
      || !Number.isSafeInteger(socialRecheckMaxAgeMilliseconds)
      || socialRecheckMaxAgeMilliseconds <= 0) {
    throw new ApiError(500, "LIFECYCLE_BOUNDS_EXCEEDED");
  }
  return { idleMilliseconds, socialRecheckMaxAgeMilliseconds };
}

function safeError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

function backendError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

async function readAccountlessAuthority(
  client: PostgresClient,
  schema: string,
  participantId: string,
  deviceId: string,
  enrollmentDeviceId: string | null,
  deviceExpiresAt: string | Date,
  now: string,
  authorizationVersion: "v1.1" | "v1.2",
): Promise<boolean> {
  if (enrollmentDeviceId !== deviceId) return false;
  const typedAuthorizationSelect = authorizationVersion === "v1.2"
    ? `typed_authorization.state AS authorization_state,
       typed_authorization.expires_at AS authorization_expires_at,
       typed_authorization.telemetry_schema_version, typed_authorization.field_dictionary_version,
       typed_authorization.privacy_contract_version, typed_authorization.schema_version,
       typed_authorization.policy_version, typed_authorization.authorization_basis`
    : `NULL::text AS authorization_state, NULL::timestamptz AS authorization_expires_at,
       NULL::text AS telemetry_schema_version, NULL::text AS field_dictionary_version,
       NULL::text AS privacy_contract_version, NULL::text AS schema_version,
       NULL::text AS policy_version, NULL::text AS authorization_basis`;
  const typedAuthorizationJoin = authorizationVersion === "v1.2"
    ? `JOIN ${table(schema, "accountless_v12_device_authorizations")} typed_authorization
         ON typed_authorization.enrollment_device_id = ledger.device_id
        AND typed_authorization.participant_id = owner.participant_id
        AND typed_authorization.device_credential_id = owner.device_credential_id`
    : "";
  const typedAuthorizationLock = authorizationVersion === "v1.2"
    ? ", typed_authorization"
    : "";
  const typedAuthorizationPredicate = authorizationVersion === "v1.2"
    ? `AND typed_authorization.participant_id = $2
       AND typed_authorization.device_credential_id = $3`
    : "";
  const result = await client.query<AccountlessAuthorityRow>(
    `SELECT ledger.state AS ledger_state, ledger.expires_at AS ledger_expires_at,
            owner.state AS owner_state, owner.expires_at AS owner_expires_at,
            shared_authorization.state AS shared_authorization_state,
            shared_authorization.expires_at AS shared_authorization_expires_at,
            ${typedAuthorizationSelect}
       FROM ${table(schema, "accountless_enrollment_ledger")} ledger
       JOIN ${table(schema, "accountless_upload_owners")} owner
         ON owner.enrollment_device_id = ledger.device_id
       JOIN ${table(schema, "accountless_v11_device_authorizations")} shared_authorization
         ON shared_authorization.enrollment_device_id = ledger.device_id
        AND shared_authorization.participant_id = owner.participant_id
        AND shared_authorization.device_credential_id = owner.device_credential_id
       ${typedAuthorizationJoin}
      WHERE ledger.device_id = $1 AND owner.participant_id = $2
        AND owner.device_credential_id = $3
        AND shared_authorization.participant_id = $2
        AND shared_authorization.device_credential_id = $3
        ${typedAuthorizationPredicate}
      FOR SHARE OF ledger, owner, shared_authorization${typedAuthorizationLock}`,
    [deviceId, participantId, deviceId],
  );
  const row = result.rows[0];
  if (!row) return false;
  const expiresAt = time(row.ledger_expires_at);
  const deviceExpiry = time(deviceExpiresAt);
  return row.ledger_state === "active"
    && row.owner_state === "active"
    && row.shared_authorization_state === "active"
    && (authorizationVersion === "v1.1" || row.authorization_state === "active")
    && Number.isFinite(expiresAt)
    && expiresAt === deviceExpiry
    && expiresAt > Date.parse(now)
    && time(row.owner_expires_at) === expiresAt
    && time(row.shared_authorization_expires_at) === expiresAt
    && (authorizationVersion === "v1.1" || (
      row.authorization_state === "active"
      && row.authorization_expires_at !== null
      && time(row.authorization_expires_at) === expiresAt
      && row.telemetry_schema_version === "telemetry-contribution-v1.2"
      && row.field_dictionary_version === "telemetry-v1.2-registry-2026-09-20.1"
      && row.privacy_contract_version === "ongoing-privacy-safe-telemetry-v1.2"
      && row.schema_version === "accountless-upload-owner-v1.2"
      && row.policy_version === "accountless-telemetry-v1.2-policy-v1"
      && row.authorization_basis === "accountless-policy-v1.2"
    ));
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
 * Authenticate an upload-only device bearer against PostgreSQL. Social
 * credentials retain the same idle and social-recheck bounds as the Worker
 * path; accountless credentials additionally require the shared v1.1 device
 * transport authority and current v1.2 owner, enrollment, and schema
 * authorization rows. The v1.1 row remains the generic bearer/upload gate in
 * the Worker path; v1.2 adds separate schema authorization on top. This
 * function does not grant telemetry consent: the v1.2 admission adapter
 * rechecks that separately in its write transaction.
 */
export async function authenticatePostgresDevice(
  pool: PostgresPool,
  authorizationHeader: string | null,
  options: PostgresDeviceAuthenticationOptions = {},
): Promise<DevicePrincipal> {
  const parsed = parseDeviceAuthorization(authorizationHeader);
  const nowEpoch = options.nowEpoch ?? Date.now();
  const now = epochIso(nowEpoch);
  const policy = lifecyclePolicy(options);
  const schema = schemaName(options);
  let presentedHash: Uint8Array;
  try {
    presentedHash = await deviceHash(parsed.id, parsed.secret);
  } catch {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }

  try {
    return await withPostgresMutation(pool, async (client) => {
      const result = await client.query<DeviceAuthorityRow>(
        `SELECT device.id, device.participant_id, device.authority_kind, device.secret_hash,
                device.state, device.issued_at, device.expires_at, device.last_used_at,
                device.social_verified_at, device.credential_generation,
                device.accountless_enrollment_device_id,
                participant.state AS participant_state, participant.owner_kind AS participant_owner_kind,
                participant.consent_version AS participant_consent_version
           FROM ${table(schema, "device_credentials")} device
           JOIN ${table(schema, "participants")} participant ON participant.id = device.participant_id
          WHERE device.id = $1
          FOR UPDATE OF device, participant`,
        [parsed.id],
      );
      const row = result.rows[0];
      const storedHash = row?.secret_hash ?? new Uint8Array(32);
      const secretMatches = timingSafeEqual(presentedHash, storedHash);
      if (!secretMatches && row?.authority_kind === "social") {
        const rotations = await client.query<{ prior_secret_hash: Uint8Array }>(
          `SELECT prior_secret_hash FROM ${table(schema, "device_credential_rotations")}
            WHERE device_id = $1 AND retire_at > $2`,
          [row.id, now],
        );
        if (rotations.rows.some((rotation) => timingSafeEqual(presentedHash, rotation.prior_secret_hash))) {
          await client.query(
            `UPDATE ${table(schema, "device_credentials")}
                SET state='revoked', revoked_at=COALESCE(revoked_at,$2)
              WHERE id=$1 AND state='active'`,
            [row.id, now],
          );
          await client.query(
            `UPDATE ${table(schema, "device_upload_authorizations")}
                SET state='revoked', revoked_at=COALESCE(revoked_at,$2),
                    consume_lease_expires_at=NULL
              WHERE issued_by_device_id=$1 AND state IN ('unused','consuming')`,
            [row.id, now],
          );
        }
      }
      if (!secretMatches || !row
          || row.state !== "active" || row.participant_state !== "active"
          || row.participant_owner_kind !== row.authority_kind
          || time(row.expires_at) <= nowEpoch) {
        throw new ApiError(401, "DEVICE_AUTH_INVALID");
      }

      if (row.authority_kind === "accountless") {
        if (row.participant_consent_version !== null || row.social_verified_at !== null
            || !await readAccountlessAuthority(client, schema, row.participant_id, row.id,
              row.accountless_enrollment_device_id, row.expires_at, now,
              options.accountlessAuthorizationVersion ?? "v1.2")) {
          throw new ApiError(401, "DEVICE_AUTH_INVALID");
        }
        const updated = await client.query(
          `UPDATE ${table(schema, "device_credentials")}
              SET last_used_at = $2
            WHERE id = $1 AND state = 'active' AND secret_hash = $3 AND expires_at > $2
          RETURNING id`,
          [row.id, now, presentedHash],
        );
        if (updated.rowCount !== 1) throw new ApiError(401, "DEVICE_AUTH_INVALID");
        return Object.freeze({
          deviceId: row.id,
          participantId: row.participant_id,
          participantConsentVersion: null,
          expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
          credentialGeneration: row.credential_generation,
          socialVerifiedAt: null,
          authorityKind: "accountless",
        });
      }

      const socialVerifiedAt = row.social_verified_at ?? row.issued_at;
      if (row.authority_kind !== "social"
          || row.participant_consent_version === null
          || !CONSENT_VERSIONS.has(row.participant_consent_version)
          || !recentInstant(row.last_used_at, nowEpoch, policy.idleMilliseconds)
          || !recentInstant(socialVerifiedAt, nowEpoch, policy.socialRecheckMaxAgeMilliseconds)) {
        throw new ApiError(401, "DEVICE_AUTH_INVALID");
      }
      const renewedExpiry = new Date(Math.min(
        nowEpoch + DEVICE_CREDENTIAL_TTL_MILLISECONDS,
        time(socialVerifiedAt) + policy.socialRecheckMaxAgeMilliseconds,
      ));
      if (!Number.isFinite(renewedExpiry.getTime()) || renewedExpiry.getTime() <= nowEpoch) {
        throw new ApiError(401, "DEVICE_AUTH_INVALID");
      }
      const renewedExpiryIso = renewedExpiry.toISOString();
      const updated = await client.query(
        `UPDATE ${table(schema, "device_credentials")}
            SET last_used_at = $2, expires_at = $3
          WHERE id = $1 AND state = 'active' AND secret_hash = $4
            AND credential_generation = $5 AND expires_at > $2
            AND EXISTS (
              SELECT 1 FROM ${table(schema, "participants")} participant
               WHERE participant.id = device_credentials.participant_id
                 AND participant.state = 'active' AND participant.owner_kind = 'social'
                 AND participant.consent_version = $6
            )
          RETURNING id`,
        [row.id, now, renewedExpiryIso, presentedHash, row.credential_generation,
          row.participant_consent_version],
      );
      if (updated.rowCount !== 1) throw new ApiError(401, "DEVICE_AUTH_INVALID");
      return Object.freeze({
        deviceId: row.id,
        participantId: row.participant_id,
        participantConsentVersion: row.participant_consent_version,
        expiresAt: renewedExpiryIso,
        credentialGeneration: row.credential_generation,
        socialVerifiedAt: new Date(time(socialVerifiedAt)).toISOString(),
        authorityKind: "social",
      });
    }, {
      operation: "device.authenticate",
      preserveSafeError: safeError,
    });
  } catch (error) {
    backendError(error);
  }
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
          && !await readAccountlessAuthority(client, schema, row.participant_id,
            row.issued_by_device_id, row.accountless_enrollment_device_id,
            row.device_expires_at, now, "v1.2")) {
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
