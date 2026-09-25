import { deviceHash, parseDeviceAuthorization } from "./device-auth";
import { timingSafeEqual } from "./crypto";
import { ApiError } from "./errors";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";

interface DisconnectDeviceRow {
  readonly id: string;
  readonly secret_hash: Uint8Array;
  readonly state: "active" | "revoked";
  readonly authority_kind: "social" | "accountless";
  readonly accountless_enrollment_device_id: string | null;
}

interface PriorCredentialRow {
  readonly prior_secret_hash: Uint8Array;
}

export interface PostgresDeviceDisconnectOptions {
  readonly nowEpoch?: number;
  readonly schema?: PostgresSchemaOptions;
}

type DisconnectOutcome =
  | { readonly kind: "disconnected"; readonly deviceId: string }
  | { readonly kind: "accountless_publication_gap" }
  | { readonly kind: "invalid" };

function table(schema: string, name: string): string {
  return `${schema}.${quotePostgresIdentifier(name)}`;
}

function safeError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

function backendError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

/**
 * Revoke the social device represented by its bearer, independent of upload
 * controls and device expiry. Replays with the same valid credential succeed
 * and pending upload grants are revoked in the same transaction. Accountless
 * opt-out is refused before mutation until the PG public-source withdrawal
 * path can match the Worker's publication triggers.
 */
export async function disconnectPostgresAuthenticatedDevice(
  pool: PostgresPool,
  authorizationHeader: string | null,
  options: PostgresDeviceDisconnectOptions = {},
): Promise<{ readonly deviceId: string; readonly revoked: true }> {
  const parsed = parseDeviceAuthorization(authorizationHeader);
  const nowEpoch = options.nowEpoch ?? Date.now();
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0
      || !Number.isFinite(new Date(nowEpoch).getTime())) {
    throw new ApiError(500, "LIFECYCLE_BOUNDS_EXCEEDED");
  }
  const now = new Date(nowEpoch).toISOString();
  const schema = quotePostgresIdentifier(
    createPostgresSchemaConfig(options.schema ?? {}).primarySchema,
  );
  const presentedHash = await deviceHash(parsed.id, parsed.secret);

  let outcome: DisconnectOutcome;
  try {
    outcome = await withPostgresMutation(pool, async (client) => {
      const selected = await client.query<DisconnectDeviceRow>(
        `SELECT id, secret_hash, state, authority_kind,
                accountless_enrollment_device_id
           FROM ${table(schema, "device_credentials")}
          WHERE id = $1
          FOR UPDATE`,
        [parsed.id],
      );
      const row = selected.rows[0];
      const secretMatches = timingSafeEqual(
        presentedHash,
        row?.secret_hash ?? new Uint8Array(32),
      );
      if (!row || !secretMatches) {
        if (row?.authority_kind === "accountless") {
          // The D1 reuse path can revoke accountless publication authority as
          // a side effect. Until PostgreSQL has that withdrawal contract, a
          // recognized prior accountless secret must stop before any write.
          if (row.accountless_enrollment_device_id !== row.id) {
            return Object.freeze({ kind: "invalid" as const });
          }
          const rotations = await client.query<PriorCredentialRow>(
            `SELECT prior_secret_hash
               FROM ${table(schema, "device_credential_rotations")}
              WHERE device_id = $1 AND retire_at > $2::timestamptz`,
            [row.id, now],
          );
          if (rotations.rows.some((rotation) =>
            timingSafeEqual(presentedHash, rotation.prior_secret_hash))) {
            return Object.freeze({ kind: "accountless_publication_gap" as const });
          }
        } else if (row?.authority_kind === "social") {
          // Match D1 credential reuse: a known prior social secret revokes
          // the current device lineage, then receives the same neutral
          // invalid-bearer response as every other bad secret.
          const rotations = await client.query<PriorCredentialRow>(
            `SELECT prior_secret_hash
               FROM ${table(schema, "device_credential_rotations")}
              WHERE device_id = $1 AND retire_at > $2::timestamptz`,
            [row.id, now],
          );
          if (rotations.rows.some((rotation) =>
            timingSafeEqual(presentedHash, rotation.prior_secret_hash))) {
            await client.query(
              `UPDATE ${table(schema, "device_credentials")}
                  SET state = 'revoked', revoked_at = COALESCE(revoked_at, $2::timestamptz)
                WHERE id = $1 AND state = 'active'`,
              [row.id, now],
            );
            await client.query(
              `UPDATE ${table(schema, "device_upload_authorizations")}
                  SET state = 'revoked', revoked_at = COALESCE(revoked_at, $2::timestamptz),
                      consume_lease_expires_at = NULL
                WHERE issued_by_device_id = $1
                  AND state IN ('unused', 'consuming')`,
              [row.id, now],
            );
          }
        }
        return Object.freeze({ kind: "invalid" as const });
      }

      if (row.authority_kind === "accountless") {
        if (row.accountless_enrollment_device_id !== row.id) {
          return Object.freeze({ kind: "invalid" as const });
        }
        return Object.freeze({ kind: "accountless_publication_gap" as const });
      }
      if (row.authority_kind !== "social") {
        return Object.freeze({ kind: "invalid" as const });
      }

      await client.query(
        `UPDATE ${table(schema, "device_credentials")}
            SET state = 'revoked', revoked_at = COALESCE(revoked_at, $2::timestamptz)
          WHERE id = $1 AND state = 'active'`,
        [row.id, now],
      );
      await client.query(
        `UPDATE ${table(schema, "device_upload_authorizations")}
            SET state = 'revoked', revoked_at = COALESCE(revoked_at, $2::timestamptz),
                consume_lease_expires_at = NULL
          WHERE issued_by_device_id = $1
            AND state IN ('unused', 'consuming')`,
        [row.id, now],
      );
      return Object.freeze({ kind: "disconnected" as const, deviceId: row.id });
    }, {
      operation: "device.disconnect",
      statementTimeoutMilliseconds: 10_000,
      lockTimeoutMilliseconds: 1_000,
      preserveSafeError: safeError,
    });
  } catch (error) {
    backendError(error);
  } finally {
    presentedHash.fill(0);
  }

  if (outcome.kind === "invalid") throw new ApiError(401, "DEVICE_AUTH_INVALID");
  if (outcome.kind === "accountless_publication_gap") {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  return Object.freeze({ deviceId: outcome.deviceId, revoked: true });
}
