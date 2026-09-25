import {
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
  DEVICE_CREDENTIAL_TTL_MILLISECONDS,
  MAX_REQUEST_BYTES,
  TELEMETRY_CONSENT_VERSION,
} from "./constants";
import {
  DEFAULT_DEVICE_LIFECYCLE_POLICY,
  deviceHash,
  parseDeviceAuthorization,
  type DeviceCredentialRotationResult,
  type DeviceLifecycleOptions,
} from "./device-auth";
import { timingSafeEqual } from "./crypto";
import { ApiError } from "./errors";
import { parseStrictJson } from "./strict-json";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";

export const POSTGRES_DEVICE_CREDENTIAL_RENEWAL_MAX_REQUEST_BYTES = MAX_REQUEST_BYTES;

export interface PostgresDeviceCredentialRenewalRequest {
  readonly nextDeviceSecretHash: string;
  readonly rotationAttemptId: string;
}

export interface PostgresDeviceCredentialRenewalOptions extends DeviceLifecycleOptions {
  readonly schema?: PostgresSchemaConfig;
}

interface DeviceRow {
  readonly id: string;
  readonly participant_id: string;
  readonly authority_kind: "social" | "accountless";
  readonly secret_hash: Uint8Array;
  readonly state: "active" | "revoked";
  readonly issued_at: Date | string;
  readonly expires_at: Date | string;
  readonly last_used_at: Date | string;
  readonly social_verified_at: Date | string | null;
  readonly credential_generation: number | string;
  readonly participant_state: "active" | "deleting";
  readonly participant_owner_kind: "social" | "accountless";
  readonly participant_consent_version: string | null;
}

interface RotationRow {
  readonly id: string;
  readonly prior_secret_hash: Uint8Array;
  readonly replacement_secret_hash: Uint8Array;
  readonly generation: number | string;
}

interface RotationReceiptRow extends RotationRow {
  readonly device_id: string;
  readonly attempt_id: string;
  readonly device_secret_hash: Uint8Array;
  readonly device_state: "active" | "revoked";
  readonly device_expires_at: Date | string;
  readonly device_generation: number | string;
}

type MutationResult =
  | { readonly kind: "rotated"; readonly receipt: DeviceCredentialRotationResult }
  | { readonly kind: "unauthorized" };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const CONSENT_VERSIONS = new Set([
  TELEMETRY_CONSENT_VERSION,
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
]);

function invalidBody(): ApiError {
  return new ApiError(400, "BODY_INVALID");
}

export function parsePostgresDeviceCredentialRenewalJson(
  raw: string,
): PostgresDeviceCredentialRenewalRequest {
  const value = parseStrictJson(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidBody();
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 2
      || typeof body.nextDeviceSecretHash !== "string"
      || typeof body.rotationAttemptId !== "string") {
    throw invalidBody();
  }
  return Object.freeze({
    nextDeviceSecretHash: body.nextDeviceSecretHash,
    rotationAttemptId: body.rotationAttemptId,
  });
}

function schemaName(options: PostgresDeviceCredentialRenewalOptions): string {
  return quotePostgresIdentifier(
    createPostgresSchemaConfig(options.schema ?? {}).primarySchema,
  );
}

function table(schema: string, name: string): string {
  return `${schema}.${quotePostgresIdentifier(name)}`;
}

function safeApiError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

function timestampEpoch(value: Date | string | null): number | null {
  if (value === null) return null;
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function validNow(nowEpoch: number): void {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0
      || !Number.isFinite(new Date(nowEpoch).getTime())) {
    throw new TypeError("nowEpoch must be a non-negative safe integer");
  }
}

function epochIso(epoch: number): string {
  const value = new Date(epoch);
  if (!Number.isFinite(value.getTime())) {
    throw new ApiError(500, "LIFECYCLE_BOUNDS_EXCEEDED");
  }
  return value.toISOString();
}

function lifecyclePolicy(options: PostgresDeviceCredentialRenewalOptions) {
  const policy = {
    ...DEFAULT_DEVICE_LIFECYCLE_POLICY,
    ...options.policy,
  };
  for (const value of [
    policy.idleMilliseconds,
    policy.socialRecheckMaxAgeMilliseconds,
    policy.rotationHistoryMilliseconds,
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ApiError(500, "LIFECYCLE_BOUNDS_EXCEEDED");
    }
  }
  return policy;
}

function bytesFromHex(value: string): Uint8Array {
  if (!SHA256_HEX.test(value)) throw invalidBody();
  const result = new Uint8Array(32);
  for (let index = 0; index < result.byteLength; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function errorUnauthorized(): ApiError {
  return new ApiError(401, "DEVICE_AUTH_INVALID");
}

function rotationReceipt(
  deviceId: string,
  expiresAt: Date | string,
  generation: number | string,
): DeviceCredentialRotationResult | null {
  const expiryEpoch = timestampEpoch(expiresAt);
  const credentialGeneration = Number(generation);
  if (expiryEpoch === null || !Number.isSafeInteger(credentialGeneration)
      || credentialGeneration < 2) return null;
  return {
    deviceId,
    state: "active",
    scope: "upload_registration",
    expiresAt: new Date(expiryEpoch).toISOString(),
    credentialGeneration,
    commit: true,
  };
}

async function readCommittedAttempt(
  pool: PostgresPool,
  primary: string,
  deviceId: string,
  attemptId: string,
  priorHash: Uint8Array,
  replacementHash: Uint8Array,
): Promise<DeviceCredentialRotationResult | null> {
  return withPostgresRead(pool, async (client) => {
    const result = await client.query<RotationReceiptRow>(
      `SELECT rotation.id, rotation.prior_secret_hash,
              rotation.replacement_secret_hash, rotation.generation,
              rotation.device_id, rotation.attempt_id,
              device.secret_hash AS device_secret_hash,
              device.state AS device_state,
              device.expires_at AS device_expires_at,
              device.credential_generation AS device_generation
         FROM ${table(primary, "device_credential_rotations")} rotation
         JOIN ${table(primary, "device_credentials")} device
           ON device.id = rotation.device_id
        WHERE rotation.device_id = $1 AND rotation.attempt_id = $2`,
      [deviceId, attemptId],
    );
    const row = result.rows[0];
    if (!row || row.device_state !== "active"
        || !timingSafeEqual(priorHash, row.prior_secret_hash)
        || !timingSafeEqual(replacementHash, row.replacement_secret_hash)
        || !timingSafeEqual(replacementHash, row.device_secret_hash)
        || Number(row.generation) !== Number(row.device_generation)) {
      return null;
    }
    return rotationReceipt(deviceId, row.device_expires_at, row.device_generation);
  }, { operation: "device.credential_renewal.read_receipt" });
}

async function revokeForReuse(
  client: PostgresClient,
  primary: string,
  deviceId: string,
  nowIso: string,
  presentedHash: Uint8Array,
): Promise<boolean> {
  const prior = await client.query<{ prior_secret_hash: Uint8Array }>(
    `SELECT prior_secret_hash
       FROM ${table(primary, "device_credential_rotations")}
      WHERE device_id = $1 AND retire_at > $2::timestamptz`,
    [deviceId, nowIso],
  );
  const reused = prior.rows.some((row) => timingSafeEqual(
    presentedHash,
    row.prior_secret_hash,
  ));
  if (!reused) return false;
  await client.query(
    `UPDATE ${table(primary, "device_credentials")}
        SET state = 'revoked', revoked_at = COALESCE(revoked_at, $2::timestamptz)
      WHERE id = $1 AND state = 'active'`,
    [deviceId, nowIso],
  );
  await client.query(
    `UPDATE ${table(primary, "device_upload_authorizations")}
        SET state = 'revoked', revoked_at = COALESCE(revoked_at, $2::timestamptz),
            consume_lease_expires_at = NULL
      WHERE issued_by_device_id = $1 AND state IN ('unused', 'consuming')`,
    [deviceId, nowIso],
  );
  return true;
}

/**
 * Rotate a social device's upload-only bearer in place. Device and participant
 * row locks fence concurrent calls; attempt ids make a committed rotation
 * replayable if the client lost the response.
 */
export async function renewPostgresDeviceCredential(
  pool: PostgresPool,
  authorizationHeader: string | null,
  request: PostgresDeviceCredentialRenewalRequest,
  options: PostgresDeviceCredentialRenewalOptions = {},
): Promise<DeviceCredentialRotationResult> {
  const policy = lifecyclePolicy(options);
  const nowEpoch = options.nowEpoch ?? Date.now();
  validNow(nowEpoch);
  const nowIso = new Date(nowEpoch).toISOString();
  if (!request || typeof request.nextDeviceSecretHash !== "string"
      || !SHA256_HEX.test(request.nextDeviceSecretHash)
      || typeof request.rotationAttemptId !== "string"
      || !UUID_V4.test(request.rotationAttemptId)) {
    throw invalidBody();
  }
  const replacementHash = bytesFromHex(request.nextDeviceSecretHash);
  if (replacementHash.every((value) => value === 0)) throw invalidBody();

  const parsed = parseDeviceAuthorization(authorizationHeader);
  const presentedHash = await deviceHash(parsed.id, parsed.secret);
  if (timingSafeEqual(replacementHash, presentedHash)) throw invalidBody();
  const primary = schemaName(options);

  let result: MutationResult;
  try {
    result = await withPostgresMutation(pool, async (client): Promise<MutationResult> => {
      const currentResult = await client.query<DeviceRow>(
        `SELECT device.id, device.participant_id, device.authority_kind,
                device.secret_hash, device.state, device.issued_at,
                device.expires_at, device.last_used_at, device.social_verified_at,
                device.credential_generation, participant.state AS participant_state,
                participant.owner_kind AS participant_owner_kind,
                participant.consent_version AS participant_consent_version
           FROM ${table(primary, "device_credentials")} device
           JOIN ${table(primary, "participants")} participant
             ON participant.id = device.participant_id
          WHERE device.id = $1
          FOR UPDATE OF device, participant`,
        [parsed.id],
      );
      const current = currentResult.rows[0];
      if (!current) return { kind: "unauthorized" };

      const attemptResult = await client.query<RotationRow>(
        `SELECT id, prior_secret_hash, replacement_secret_hash, generation
           FROM ${table(primary, "device_credential_rotations")}
          WHERE device_id = $1 AND attempt_id = $2`,
        [parsed.id, request.rotationAttemptId],
      );
      const existingAttempt = attemptResult.rows[0];
      if (existingAttempt) {
        const matchingAttempt = timingSafeEqual(
          replacementHash,
          existingAttempt.replacement_secret_hash,
        ) && timingSafeEqual(presentedHash, existingAttempt.prior_secret_hash);
        if (!matchingAttempt) return { kind: "unauthorized" };
        if (current.state === "active"
            && timingSafeEqual(replacementHash, current.secret_hash)) {
          const receipt = rotationReceipt(
            current.id,
            current.expires_at,
            current.credential_generation,
          );
          return receipt === null
            ? { kind: "unauthorized" }
            : { kind: "rotated", receipt };
        }
        await revokeForReuse(client, primary, parsed.id, nowIso, presentedHash);
        return { kind: "unauthorized" };
      }

      const currentSecretMatches = timingSafeEqual(presentedHash, current.secret_hash);
      if (!currentSecretMatches && current.authority_kind === "social") {
        await revokeForReuse(client, primary, parsed.id, nowIso, presentedHash);
        return { kind: "unauthorized" };
      }
      const socialVerifiedAt = current.social_verified_at ?? current.issued_at;
      const socialVerifiedEpoch = timestampEpoch(socialVerifiedAt);
      const expiryEpoch = timestampEpoch(current.expires_at);
      const lastUsedEpoch = timestampEpoch(current.last_used_at);
      const consentAllowed = current.participant_consent_version !== null
        && CONSENT_VERSIONS.has(current.participant_consent_version);
      const generation = Number(current.credential_generation);
      if (!currentSecretMatches
          || current.authority_kind !== "social"
          || current.state !== "active"
          || current.participant_state !== "active"
          || current.participant_owner_kind !== "social"
          || !consentAllowed
          || expiryEpoch === null || expiryEpoch <= nowEpoch
          || lastUsedEpoch === null
          || lastUsedEpoch > nowEpoch
          || lastUsedEpoch <= nowEpoch - policy.idleMilliseconds
          || socialVerifiedEpoch === null
          || socialVerifiedEpoch > nowEpoch
          || socialVerifiedEpoch <= nowEpoch - policy.socialRecheckMaxAgeMilliseconds
          || !Number.isSafeInteger(generation) || generation < 1) {
        return { kind: "unauthorized" };
      }
      if (generation >= 2_147_483_647) {
        throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      }

      const expiresEpoch = Math.min(
        nowEpoch + DEVICE_CREDENTIAL_TTL_MILLISECONDS,
        socialVerifiedEpoch + policy.socialRecheckMaxAgeMilliseconds,
      );
      if (!Number.isSafeInteger(expiresEpoch) || expiresEpoch <= nowEpoch) {
        return { kind: "unauthorized" };
      }
      const expiresAt = epochIso(expiresEpoch);
      const nextGeneration = generation + 1;
      const retireAt = epochIso(Math.max(
        nowEpoch + policy.rotationHistoryMilliseconds,
        expiresEpoch,
      ));

      await client.query(
        `INSERT INTO ${table(primary, "device_credential_rotations")} (
           id, device_id, participant_id, prior_secret_hash,
           replacement_secret_hash, attempt_id, generation, rotated_at, retire_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)`,
        [crypto.randomUUID(), current.id, current.participant_id, presentedHash,
          replacementHash, request.rotationAttemptId, nextGeneration, nowIso, retireAt],
      );
      const updated = await client.query(
        `UPDATE ${table(primary, "device_credentials")}
            SET secret_hash = $1, expires_at = $2::timestamptz,
                last_used_at = $3::timestamptz, credential_generation = $4
          WHERE id = $5 AND state = 'active' AND authority_kind = 'social'
            AND secret_hash = $6 AND credential_generation = $7
            AND EXISTS (
              SELECT 1 FROM ${table(primary, "participants")} participant
               WHERE participant.id = $8 AND participant.state = 'active'
                 AND participant.owner_kind = 'social'
                 AND participant.consent_version = $9
            )`,
        [replacementHash, expiresAt, nowIso, nextGeneration,
          current.id, presentedHash, generation, current.participant_id,
          current.participant_consent_version],
      );
      if (updated.rowCount !== 1) {
        throw new ApiError(401, "DEVICE_AUTH_INVALID");
      }
      return {
        kind: "rotated",
        receipt: {
          deviceId: current.id,
          state: "active",
          scope: "upload_registration",
          expiresAt,
          credentialGeneration: nextGeneration,
          commit: true,
        },
      };
    }, {
      operation: "device.credential_renewal",
      preserveSafeError: safeApiError,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    try {
      const recovered = await readCommittedAttempt(
        pool, primary, parsed.id, request.rotationAttemptId,
        presentedHash, replacementHash,
      );
      if (recovered !== null) return recovered;
    } catch {
      // A failed readback cannot resolve whether the mutation committed.
    }
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }

  if (result.kind === "unauthorized") throw errorUnauthorized();
  return result.receipt;
}
