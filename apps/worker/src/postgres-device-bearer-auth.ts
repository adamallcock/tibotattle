/**
 * Shared PostgreSQL device-bearer authentication.
 *
 * This is the single reviewed PostgreSQL counterpart of the Worker's
 * `authenticateDevice` (device-auth.ts). Every GCP device-bearer route
 * authenticates through it so the following Worker semantics hold everywhere:
 *
 * - The header grammar is exactly `Device um_device_<uuidv4>.<43 base64url>`,
 *   parsed by the Worker's own parser; every deviation is the neutral
 *   `401 DEVICE_AUTH_INVALID`.
 * - A missing device row is compared against an all-zero hash so an unknown
 *   device, a wrong secret and a malformed header are indistinguishable.
 * - Social devices slide: success sets `last_used_at = now` and
 *   `expires_at = min(now + 30 d, socialVerified + 180 d)`, bounded by the
 *   idle window and the social-recheck cap.
 * - Accountless devices need the active v1.1 ledger, owner and
 *   `accountless_v11_device_authorizations` graph with equal expiry. The v1.2
 *   schema grant is required only when the caller asks for `'v1.2'`.
 * - A secret matching a live rotated-out secret of a social device revokes
 *   the device and its unused or consuming upload grants. The transaction
 *   callback RETURNS that outcome, so the revocation commits, and the neutral
 *   401 is raised only after the commit. Throwing inside the callback would
 *   roll the revocation back.
 */
import {
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
  DEVICE_CREDENTIAL_TTL_MILLISECONDS,
  TELEMETRY_CONSENT_VERSION,
} from "./constants";
import { timingSafeEqual } from "./crypto";
import {
  DEFAULT_DEVICE_LIFECYCLE_POLICY,
  deviceHash,
  parseDeviceAuthorization,
  type DeviceLifecycleOptions,
  type DevicePrincipal,
} from "./device-auth";
import { ApiError } from "./errors";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";

export type PostgresAccountlessAuthorizationVersion = "v1.1" | "v1.2";

export interface PostgresDeviceBearerAuthenticationOptions extends DeviceLifecycleOptions {
  readonly schema?: PostgresSchemaConfig;
  /**
   * Accountless authority required in addition to the bearer. `'v1.1'` (the
   * default) is the Worker's generic bearer gate: the base v1.1 lease graph.
   * `'v1.2'` additionally requires the current typed-v1.2 schema grant.
   */
  readonly accountlessAuthorizationVersion?: PostgresAccountlessAuthorizationVersion;
}

export type PostgresAccountlessV12GrantAuthenticationOptions = Omit<
  PostgresDeviceBearerAuthenticationOptions,
  "accountlessAuthorizationVersion"
>;

export interface PostgresAccountlessDeviceAuthorityRequest {
  readonly schema?: PostgresSchemaConfig;
  readonly participantId: string;
  readonly deviceId: string;
  readonly enrollmentDeviceId: string | null;
  readonly deviceExpiresAt: string | Date;
  readonly nowEpoch: number;
  readonly authorizationVersion: PostgresAccountlessAuthorizationVersion;
}

interface DeviceAuthorityRow {
  id: string;
  participant_id: string;
  authority_kind: string;
  secret_hash: Uint8Array;
  state: string;
  issued_at: string | Date;
  expires_at: string | Date;
  last_used_at: string | Date;
  social_verified_at: string | Date | null;
  credential_generation: number;
  accountless_enrollment_device_id: string | null;
  participant_state: string;
  participant_owner_kind: string;
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

type BearerOutcome =
  | { readonly kind: "principal"; readonly device: DevicePrincipal }
  | { readonly kind: "reuse_revoked" }
  | { readonly kind: "invalid" };

const INVALID: BearerOutcome = Object.freeze({ kind: "invalid" });
const REUSE_REVOKED: BearerOutcome = Object.freeze({ kind: "reuse_revoked" });
const CONSENT_VERSIONS: ReadonlySet<string> = new Set([
  TELEMETRY_CONSENT_VERSION,
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
]);

function unauthorized(): ApiError {
  return new ApiError(401, "DEVICE_AUTH_INVALID");
}

function primarySchema(schema: PostgresSchemaConfig | undefined): string {
  return quotePostgresIdentifier(createPostgresSchemaConfig(schema ?? {}).primarySchema);
}

function table(schema: string, name: string): string {
  return `${schema}.${quotePostgresIdentifier(name)}`;
}

function time(value: string | Date | null): number {
  if (value === null) return Number.NaN;
  const epoch = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(epoch) ? epoch : Number.NaN;
}

function isoInstant(value: string | Date | null): string | null {
  const epoch = time(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function epochIso(epoch: number): string {
  const value = new Date(epoch);
  if (!Number.isSafeInteger(epoch) || !Number.isFinite(value.getTime())) {
    throw new ApiError(500, "LIFECYCLE_BOUNDS_EXCEEDED");
  }
  return value.toISOString();
}

/** Worker `recentInstant`: not in the future and strictly inside the window. */
function recentInstant(value: string | Date | null, nowEpoch: number, maximumAge: number): boolean {
  const epoch = time(value);
  return Number.isFinite(epoch) && epoch <= nowEpoch && epoch > nowEpoch - maximumAge;
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

function accountlessAuthorizationVersion(value: unknown): PostgresAccountlessAuthorizationVersion {
  if (value === undefined) return "v1.1";
  if (value === "v1.1" || value === "v1.2") return value;
  throw new TypeError("invalid accountless authorization version");
}

function safeError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

function backendError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

async function accountlessAuthorityHolds(
  client: PostgresClient,
  schema: string,
  request: Omit<PostgresAccountlessDeviceAuthorityRequest, "schema">,
): Promise<boolean> {
  const { participantId, deviceId, authorizationVersion } = request;
  if (request.enrollmentDeviceId !== deviceId) return false;
  const typed = authorizationVersion === "v1.2";
  const typedAuthorizationSelect = typed
    ? `typed_authorization.state AS authorization_state,
       typed_authorization.expires_at AS authorization_expires_at,
       typed_authorization.telemetry_schema_version, typed_authorization.field_dictionary_version,
       typed_authorization.privacy_contract_version, typed_authorization.schema_version,
       typed_authorization.policy_version, typed_authorization.authorization_basis`
    : `NULL::text AS authorization_state, NULL::timestamptz AS authorization_expires_at,
       NULL::text AS telemetry_schema_version, NULL::text AS field_dictionary_version,
       NULL::text AS privacy_contract_version, NULL::text AS schema_version,
       NULL::text AS policy_version, NULL::text AS authorization_basis`;
  const typedAuthorizationJoin = typed
    ? `JOIN ${table(schema, "accountless_v12_device_authorizations")} typed_authorization
         ON typed_authorization.enrollment_device_id = ledger.device_id
        AND typed_authorization.participant_id = owner.participant_id
        AND typed_authorization.device_credential_id = owner.device_credential_id`
    : "";
  const typedAuthorizationLock = typed ? ", typed_authorization" : "";
  const typedAuthorizationPredicate = typed
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
  const baseGraphHolds = row.ledger_state === "active"
    && row.owner_state === "active"
    && row.shared_authorization_state === "active"
    && Number.isFinite(expiresAt)
    && expiresAt === time(request.deviceExpiresAt)
    && expiresAt > request.nowEpoch
    && time(row.owner_expires_at) === expiresAt
    && time(row.shared_authorization_expires_at) === expiresAt;
  if (!baseGraphHolds || !typed) return baseGraphHolds;
  return row.authorization_state === "active"
    && time(row.authorization_expires_at) === expiresAt
    && row.telemetry_schema_version === "telemetry-contribution-v1.2"
    && row.field_dictionary_version === "telemetry-v1.2-registry-2026-09-20.1"
    && row.privacy_contract_version === "ongoing-privacy-safe-telemetry-v1.2"
    && row.schema_version === "accountless-upload-owner-v1.2"
    && row.policy_version === "accountless-telemetry-v1.2-policy-v1"
    && row.authorization_basis === "accountless-policy-v1.2";
}

/**
 * Check the accountless owner graph for a device inside the caller's mutation
 * transaction. It takes FOR SHARE locks on the ledger, owner and grant rows, so
 * it must run in the same transaction as the write it fences.
 */
export function readPostgresAccountlessDeviceAuthority(
  client: PostgresClient,
  request: PostgresAccountlessDeviceAuthorityRequest,
): Promise<boolean> {
  return accountlessAuthorityHolds(client, primarySchema(request.schema), {
    participantId: request.participantId,
    deviceId: request.deviceId,
    enrollmentDeviceId: request.enrollmentDeviceId,
    deviceExpiresAt: request.deviceExpiresAt,
    nowEpoch: request.nowEpoch,
    authorizationVersion: accountlessAuthorizationVersion(request.authorizationVersion),
  });
}

/**
 * Revoke a social device and its pending upload grants when the presented
 * secret matches a live rotated-out secret. Every live prior hash is compared,
 * so the comparison count does not depend on which one matched.
 */
async function revokeReusedSocialCredential(
  client: PostgresClient,
  schema: string,
  deviceId: string,
  presentedHash: Uint8Array,
  now: string,
): Promise<boolean> {
  const rotations = await client.query<{ prior_secret_hash: Uint8Array }>(
    `SELECT prior_secret_hash FROM ${table(schema, "device_credential_rotations")}
      WHERE device_id = $1 AND retire_at > $2`,
    [deviceId, now],
  );
  let reused = false;
  for (const rotation of rotations.rows) {
    reused = timingSafeEqual(presentedHash, rotation.prior_secret_hash) || reused;
  }
  if (!reused) return false;
  await client.query(
    `UPDATE ${table(schema, "device_credentials")}
        SET state = 'revoked', revoked_at = COALESCE(revoked_at, $2)
      WHERE id = $1 AND state = 'active'`,
    [deviceId, now],
  );
  await client.query(
    `UPDATE ${table(schema, "device_upload_authorizations")}
        SET state = 'revoked', revoked_at = COALESCE(revoked_at, $2),
            consume_lease_expires_at = NULL
      WHERE issued_by_device_id = $1 AND state IN ('unused', 'consuming')`,
    [deviceId, now],
  );
  return true;
}

/**
 * Authenticate a device bearer against PostgreSQL with the Worker's exact
 * `authenticateDevice` semantics. Returns the same principal shape. Every
 * authentication failure is the neutral `401 DEVICE_AUTH_INVALID`, raised only
 * after any credential-reuse revocation has committed; storage failures are
 * `503 BACKEND_STORAGE_UNAVAILABLE`.
 */
export async function authenticatePostgresDeviceBearer(
  pool: PostgresPool,
  authorizationHeader: string | null,
  options: PostgresDeviceBearerAuthenticationOptions = {},
): Promise<DevicePrincipal> {
  const policy = lifecyclePolicy(options);
  const nowEpoch = options.nowEpoch ?? Date.now();
  const now = epochIso(nowEpoch);
  const authorizationVersion = accountlessAuthorizationVersion(
    options.accountlessAuthorizationVersion,
  );
  const schema = primarySchema(options.schema);
  const parsed = parseDeviceAuthorization(authorizationHeader);
  let presentedHash: Uint8Array;
  try {
    presentedHash = await deviceHash(parsed.id, parsed.secret);
  } catch {
    throw unauthorized();
  }

  let outcome: BearerOutcome;
  try {
    outcome = await withPostgresMutation(pool, async (client): Promise<BearerOutcome> => {
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
      const secretMatches = timingSafeEqual(presentedHash, row?.secret_hash ?? new Uint8Array(32));
      if (!row) return INVALID;
      if (!secretMatches) {
        // A rotated-out social secret signals credential theft. The revocation
        // is returned, not thrown, so it survives the neutral 401.
        if (row.authority_kind === "social"
            && await revokeReusedSocialCredential(client, schema, row.id, presentedHash, now)) {
          return REUSE_REVOKED;
        }
        return INVALID;
      }
      if (row.state !== "active" || row.participant_state !== "active"
          || row.participant_owner_kind !== row.authority_kind
          || !(time(row.expires_at) > nowEpoch)) {
        return INVALID;
      }

      if (row.authority_kind === "accountless") {
        const expiresAt = isoInstant(row.expires_at);
        if (expiresAt === null
            || row.participant_consent_version !== null || row.social_verified_at !== null
            || !await accountlessAuthorityHolds(client, schema, {
              participantId: row.participant_id,
              deviceId: row.id,
              enrollmentDeviceId: row.accountless_enrollment_device_id,
              deviceExpiresAt: row.expires_at,
              nowEpoch,
              authorizationVersion,
            })) {
          return INVALID;
        }
        const used = await client.query(
          `UPDATE ${table(schema, "device_credentials")}
              SET last_used_at = $2
            WHERE id = $1 AND state = 'active' AND authority_kind = 'accountless'
              AND secret_hash = $3 AND expires_at > $2
          RETURNING id`,
          [row.id, now, presentedHash],
        );
        if (used.rowCount !== 1) return INVALID;
        return {
          kind: "principal",
          device: Object.freeze({
            deviceId: row.id,
            participantId: row.participant_id,
            participantConsentVersion: null,
            expiresAt,
            credentialGeneration: row.credential_generation,
            socialVerifiedAt: null,
            authorityKind: "accountless",
          }),
        };
      }

      if (row.authority_kind !== "social") return INVALID;
      const socialVerifiedAt = isoInstant(row.social_verified_at ?? row.issued_at);
      if (socialVerifiedAt === null
          || row.participant_consent_version === null
          || !CONSENT_VERSIONS.has(row.participant_consent_version)
          || !recentInstant(row.last_used_at, nowEpoch, policy.idleMilliseconds)
          || !recentInstant(socialVerifiedAt, nowEpoch, policy.socialRecheckMaxAgeMilliseconds)) {
        return INVALID;
      }
      // Successful use slides the bearer, bounded by the idle window above and
      // never past the social-account recheck deadline.
      const renewedExpiryEpoch = Math.min(
        nowEpoch + DEVICE_CREDENTIAL_TTL_MILLISECONDS,
        time(socialVerifiedAt) + policy.socialRecheckMaxAgeMilliseconds,
      );
      if (!Number.isSafeInteger(renewedExpiryEpoch) || renewedExpiryEpoch <= nowEpoch) {
        return INVALID;
      }
      const renewedExpiry = epochIso(renewedExpiryEpoch);
      const used = await client.query(
        `UPDATE ${table(schema, "device_credentials")}
            SET last_used_at = $2, expires_at = $3
          WHERE id = $1 AND state = 'active' AND authority_kind = 'social'
            AND secret_hash = $4 AND credential_generation = $5 AND expires_at > $2
            AND EXISTS (
              SELECT 1 FROM ${table(schema, "participants")} participant
               WHERE participant.id = device_credentials.participant_id
                 AND participant.state = 'active' AND participant.owner_kind = 'social'
                 AND participant.consent_version = $6
            )
          RETURNING id`,
        [row.id, now, renewedExpiry, presentedHash, row.credential_generation,
          row.participant_consent_version],
      );
      if (used.rowCount !== 1) return INVALID;
      return {
        kind: "principal",
        device: Object.freeze({
          deviceId: row.id,
          participantId: row.participant_id,
          participantConsentVersion: row.participant_consent_version,
          expiresAt: renewedExpiry,
          credentialGeneration: row.credential_generation,
          socialVerifiedAt,
          authorityKind: "social",
        }),
      };
    }, {
      operation: "device.authenticate",
      preserveSafeError: safeError,
    });
  } catch (error) {
    backendError(error);
  }
  // Raised only after COMMIT, so a reuse revocation is durable.
  if (outcome.kind !== "principal") throw unauthorized();
  return outcome.device;
}

/**
 * Authenticate the bearer for `POST /api/v1/accountless/telemetry-v1.2-authorization`.
 * Like the Worker route, it authenticates against the base v1.1 graph (the
 * v1.2 grant is what is being requested), bumps `last_used_at`, and maps every
 * failure - revoked, expired, unknown, or a non-accountless authority - to the
 * neutral `401 DEVICE_AUTH_INVALID`, never an ownership-specific code. A social
 * bearer is authenticated (and slides) exactly as the Worker's shared
 * `authenticateDevice` does before the route rejects it.
 */
export async function authenticatePostgresAccountlessForV12Grant(
  pool: PostgresPool,
  authorizationHeader: string | null,
  options: PostgresAccountlessV12GrantAuthenticationOptions = {},
): Promise<DevicePrincipal> {
  const principal = await authenticatePostgresDeviceBearer(pool, authorizationHeader, {
    ...options,
    accountlessAuthorizationVersion: "v1.1",
  });
  if (principal.authorityKind !== "accountless") throw unauthorized();
  return principal;
}
