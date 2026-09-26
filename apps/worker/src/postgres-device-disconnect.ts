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

interface AccountlessLedgerRow {
  readonly state: "active" | "revoked";
}

interface AccountlessHeadRow {
  readonly participant_id: string;
  readonly enrollment_device_id: string;
  readonly device_credential_id: string;
  readonly generation_id: string;
  readonly head_revision: number;
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
 * The accountless v1.2 active public-source proof of D1 isolation 0011 and
 * PostgreSQL migration 0045, for `owner` (device `$1`): an active lease graph
 * proved by the separate successor grant, an accepted v1.2 head whose domain
 * belongs to this device, and no v1.1 domain for it.
 */
function retainableV12Head(schema: string): string {
  return `SELECT owner.participant_id, owner.enrollment_device_id,
                 owner.device_credential_id, head.generation_id,
                 head.revision AS head_revision
            FROM ${table(schema, "accountless_upload_owners")} owner
            JOIN ${table(schema, "participants")} participant
              ON participant.id = owner.participant_id
            JOIN ${table(schema, "accountless_enrollment_ledger")} ledger
              ON ledger.device_id = owner.enrollment_device_id
            JOIN ${table(schema, "device_credentials")} device
              ON device.id = owner.device_credential_id
            JOIN ${table(schema, "accountless_v12_device_authorizations")} successor
              ON successor.enrollment_device_id = owner.enrollment_device_id
             AND successor.participant_id = owner.participant_id
             AND successor.device_credential_id = owner.device_credential_id
            JOIN ${table(schema, "telemetry_v12_domain_heads")} head
              ON head.participant_id = owner.participant_id
            JOIN ${table(schema, "telemetry_v12_domains")} domain
              ON domain.id = head.generation_id
             AND domain.participant_id = owner.participant_id
             AND domain.device_id = owner.device_credential_id
           WHERE owner.enrollment_device_id = $1
             AND owner.device_credential_id = $1
             AND owner.state = 'active' AND owner.revoked_at IS NULL
             AND owner.revocation_reason IS NULL
             AND participant.owner_kind = 'accountless' AND participant.state = 'active'
             AND ledger.state = 'active' AND ledger.revoked_at IS NULL
             AND ledger.revocation_reason IS NULL
             AND device.state = 'active' AND device.revoked_at IS NULL
             AND successor.state = 'active' AND successor.revoked_at IS NULL
             AND successor.revocation_reason IS NULL
             AND device.participant_id = participant.id
             AND device.authority_kind = 'accountless'
             AND device.id = ledger.device_id
             AND device.accountless_enrollment_device_id = ledger.device_id
             AND device.paired_via_pairing_id IS NULL
             AND device.social_verified_at IS NULL
             AND device.secret_hash = ledger.device_secret_hash
             AND ledger.schema_version = 'accountless-enrollment-v0.1'
             AND ledger.policy_version = 'accountless-opt-out-v1'
             AND ledger.authorization_basis = 'accountless-policy-v1'
             AND owner.policy_version = ledger.policy_version
             AND owner.authorization_basis = ledger.authorization_basis
             AND successor.schema_version = 'accountless-upload-owner-v1.2'
             AND successor.policy_version = 'accountless-telemetry-v1.2-policy-v1'
             AND successor.authorization_basis = 'accountless-policy-v1.2'
             AND successor.telemetry_schema_version = 'telemetry-contribution-v1.2'
             AND successor.field_dictionary_version = 'telemetry-v1.2-registry-2026-09-20.1'
             AND successor.privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.2'
             AND owner.expires_at = ledger.expires_at
             AND device.expires_at = ledger.expires_at
             AND successor.expires_at = ledger.expires_at
             AND NOT EXISTS (
               SELECT 1 FROM ${table(schema, "telemetry_v11_domains")} legacy_domain
                WHERE legacy_domain.participant_id = owner.participant_id
                  AND legacy_domain.device_id = owner.device_credential_id
             )`;
}

/**
 * Revoke the device represented by its bearer, independent of upload controls
 * and device expiry. Replays with the same valid credential succeed and
 * pending upload grants are revoked in the same transaction. Accountless
 * opt-out pins an exact accepted v1.1 head before revoking upload authority,
 * or, for a device with no v1.1 domain, its eligible accepted v1.2 head (D1
 * isolation 0011 parity); it revokes the v1.2 successor grant with the rest
 * of the lease graph. It does not append an owner-withdrawn event or alter
 * publication membership.
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
        const ledger = await client.query<AccountlessLedgerRow>(
          `SELECT state
             FROM ${table(schema, "accountless_enrollment_ledger")}
            WHERE device_id = $1 AND device_secret_hash = $2
            FOR UPDATE`,
          [row.id, row.secret_hash],
        );
        const ledgerRow = ledger.rows[0];
        if (ledgerRow === undefined) {
          throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
        }

        const retained = await client.query<{ readonly present: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM ${table(schema, "accountless_public_history_retention")}
              WHERE enrollment_device_id = $1
           ) AS present`,
          [row.id],
        );
        if (retained.rows.length !== 1 || typeof retained.rows[0]?.present !== "boolean") {
          throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
        }

        if (ledgerRow.state === "revoked") {
          // An opt-out committed before the v1.2 grant was part of this
          // transaction left that grant active. Revoke it with the ledger's
          // own instant and reason, as the D1 revocation batch does on replay.
          await client.query(
            `UPDATE ${table(schema, "accountless_v12_device_authorizations")} successor
                SET state = 'revoked', revoked_at = ledger.revoked_at,
                    revocation_reason = ledger.revocation_reason
               FROM ${table(schema, "accountless_enrollment_ledger")} ledger
              WHERE successor.enrollment_device_id = $1 AND successor.state = 'active'
                AND ledger.device_id = successor.enrollment_device_id
                AND ledger.state = 'revoked'`,
            [row.id],
          );
          const replay = await client.query<{ readonly complete: boolean }>(
            `SELECT (
               device.state = 'revoked'
               AND ledger.state = 'revoked'
               AND NOT EXISTS (
                 SELECT 1 FROM ${table(schema, "accountless_upload_owners")} owner
                  WHERE owner.enrollment_device_id = $1 AND owner.state = 'active'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM ${table(schema, "accountless_v11_device_authorizations")} grant_row
                  WHERE grant_row.enrollment_device_id = $1 AND grant_row.state = 'active'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM ${table(schema, "accountless_v12_device_authorizations")} successor
                  WHERE successor.enrollment_device_id = $1 AND successor.state = 'active'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM ${table(schema, "device_upload_authorizations")} upload
                  WHERE upload.issued_by_device_id = $1
                    AND upload.state IN ('unused', 'consuming')
               )
               AND (
                 (
                   NOT EXISTS (
                     SELECT 1 FROM ${table(schema, "accountless_public_history_retention")} marker
                      WHERE marker.enrollment_device_id = $1
                   )
                   AND NOT EXISTS (
                     SELECT 1
                       FROM ${table(schema, "accountless_upload_owners")} owner
                       JOIN ${table(schema, "telemetry_v11_domain_heads")} head
                         ON head.participant_id = owner.participant_id
                       JOIN ${table(schema, "telemetry_v11_domains")} domain
                         ON domain.id = head.generation_id
                        AND domain.participant_id = owner.participant_id
                        AND domain.device_id = owner.device_credential_id
                      WHERE owner.enrollment_device_id = $1
                        AND owner.device_credential_id = $1
                        AND owner.state = 'active'
                        AND owner.revoked_at IS NULL
                        AND owner.revocation_reason IS NULL
                   )
                 )
                 OR EXISTS (
                   SELECT 1
                     FROM ${table(schema, "accountless_public_history_retention")} marker
                     JOIN ${table(schema, "participants")} participant
                       ON participant.id = marker.participant_id
                     JOIN ${table(schema, "accountless_upload_owners")} owner
                       ON owner.participant_id = marker.participant_id
                      AND owner.enrollment_device_id = marker.enrollment_device_id
                      AND owner.device_credential_id = marker.device_credential_id
                     JOIN ${table(schema, "accountless_enrollment_ledger")} retained_ledger
                       ON retained_ledger.device_id = marker.enrollment_device_id
                     JOIN ${table(schema, "device_credentials")} retained_device
                       ON retained_device.id = marker.device_credential_id
                      AND retained_device.participant_id = marker.participant_id
                     JOIN ${table(schema, "accountless_v11_device_authorizations")} grant_row
                       ON grant_row.enrollment_device_id = marker.enrollment_device_id
                      AND grant_row.participant_id = marker.participant_id
                      AND grant_row.device_credential_id = marker.device_credential_id
                     JOIN ${table(schema, "telemetry_v11_domain_heads")} head
                       ON head.participant_id = marker.participant_id
                      AND head.generation_id = marker.generation_id
                      AND head.revision = marker.head_revision
                     JOIN ${table(schema, "telemetry_v11_domains")} domain
                       ON domain.id = marker.generation_id
                      AND domain.participant_id = marker.participant_id
                      AND domain.device_id = marker.device_credential_id
                    WHERE marker.enrollment_device_id = $1
                      AND marker.device_credential_id = $1
                      AND participant.owner_kind = 'accountless'
                      AND participant.state = 'active'
                      AND retained_ledger.state = 'revoked'
                      AND retained_ledger.revocation_reason = 'user_opt_out'
                      AND owner.state = 'revoked' AND owner.revocation_reason = 'user_opt_out'
                      AND grant_row.state = 'revoked'
                      AND grant_row.revocation_reason = 'user_opt_out'
                      AND retained_device.state = 'revoked'
                      AND retained_device.authority_kind = 'accountless'
                      AND retained_ledger.revoked_at = marker.retained_at
                      AND owner.revoked_at = marker.retained_at
                      AND grant_row.revoked_at = marker.retained_at
                      AND retained_device.revoked_at = marker.retained_at
                 )
                 OR EXISTS (
                   SELECT 1
                     FROM ${table(schema, "accountless_public_history_retention")} marker
                     JOIN ${table(schema, "participants")} participant
                       ON participant.id = marker.participant_id
                     JOIN ${table(schema, "accountless_upload_owners")} owner
                       ON owner.participant_id = marker.participant_id
                      AND owner.enrollment_device_id = marker.enrollment_device_id
                      AND owner.device_credential_id = marker.device_credential_id
                     JOIN ${table(schema, "accountless_enrollment_ledger")} retained_ledger
                       ON retained_ledger.device_id = marker.enrollment_device_id
                     JOIN ${table(schema, "device_credentials")} retained_device
                       ON retained_device.id = marker.device_credential_id
                      AND retained_device.participant_id = marker.participant_id
                     JOIN ${table(schema, "accountless_v12_device_authorizations")} successor
                       ON successor.enrollment_device_id = marker.enrollment_device_id
                      AND successor.participant_id = marker.participant_id
                      AND successor.device_credential_id = marker.device_credential_id
                     JOIN ${table(schema, "telemetry_v12_domain_heads")} head
                       ON head.participant_id = marker.participant_id
                      AND head.generation_id = marker.generation_id
                      AND head.revision = marker.head_revision
                     JOIN ${table(schema, "telemetry_v12_domains")} domain
                       ON domain.id = marker.generation_id
                      AND domain.participant_id = marker.participant_id
                      AND domain.device_id = marker.device_credential_id
                    WHERE marker.enrollment_device_id = $1
                      AND marker.device_credential_id = $1
                      AND participant.owner_kind = 'accountless'
                      AND participant.state = 'active'
                      AND retained_ledger.state = 'revoked'
                      AND retained_ledger.revocation_reason = 'user_opt_out'
                      AND owner.state = 'revoked' AND owner.revocation_reason = 'user_opt_out'
                      AND successor.state = 'revoked'
                      AND successor.revocation_reason = 'user_opt_out'
                      AND retained_device.state = 'revoked'
                      AND retained_device.authority_kind = 'accountless'
                      AND retained_ledger.revoked_at = marker.retained_at
                      AND owner.revoked_at = marker.retained_at
                      AND successor.revoked_at = marker.retained_at
                      AND retained_device.revoked_at = marker.retained_at
                      AND NOT EXISTS (
                        SELECT 1 FROM ${table(schema, "telemetry_v11_domains")} legacy_domain
                         WHERE legacy_domain.participant_id = marker.participant_id
                           AND legacy_domain.device_id = marker.device_credential_id
                      )
                 )
               )
             ) AS complete
               FROM ${table(schema, "device_credentials")} device
               JOIN ${table(schema, "accountless_enrollment_ledger")} ledger
                 ON ledger.device_id = device.id
              WHERE device.id = $1`,
            [row.id],
          );
          if (replay.rows.length !== 1 || replay.rows[0]?.complete !== true) {
            throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
          }
          return Object.freeze({ kind: "disconnected" as const, deviceId: row.id });
        }

        if (retained.rows[0].present) {
          throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
        }

        const currentHead = await client.query<AccountlessHeadRow>(
          `SELECT owner.participant_id, owner.enrollment_device_id,
                  owner.device_credential_id, head.generation_id,
                  head.revision AS head_revision
             FROM ${table(schema, "accountless_upload_owners")} owner
             JOIN ${table(schema, "telemetry_v11_domain_heads")} head
               ON head.participant_id = owner.participant_id
            WHERE owner.enrollment_device_id = $1
              AND owner.device_credential_id = $1
              AND owner.state = 'active'
              AND owner.revoked_at IS NULL
              AND owner.revocation_reason IS NULL
            FOR UPDATE OF owner, head`,
          [row.id],
        );
        if (currentHead.rows.length > 1) {
          throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
        }
        let head = currentHead.rows[0];
        if (head === undefined) {
          // Without a v1.1 head, an eligible accepted v1.2 head is retained on
          // the same prospective terms. As in D1, an ineligible device still
          // disconnects, without a marker, rather than failing.
          const successorHead = await client.query<AccountlessHeadRow>(
            `${retainableV12Head(schema)}
             FOR UPDATE OF owner, head`,
            [row.id],
          );
          if (successorHead.rows.length > 1) {
            throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
          }
          head = successorHead.rows[0];
        }
        if (head !== undefined) {
          const marker = await client.query(
            `INSERT INTO ${table(schema, "accountless_public_history_retention")} (
               participant_id, enrollment_device_id, device_credential_id,
               generation_id, head_revision, retained_at
             ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
             RETURNING participant_id`,
            [head.participant_id, head.enrollment_device_id, head.device_credential_id,
              head.generation_id, head.head_revision, now],
          );
          if (marker.rows.length !== 1) {
            throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
          }
        }

        await client.query(
          `UPDATE ${table(schema, "accountless_enrollment_ledger")}
              SET state = 'revoked', revoked_at = $2::timestamptz,
                  revocation_reason = 'user_opt_out'
            WHERE device_id = $1 AND state = 'active'`,
          [row.id, now],
        );
        await client.query(
          `UPDATE ${table(schema, "accountless_upload_owners")}
              SET state = 'revoked', revoked_at = $2::timestamptz,
                  revocation_reason = 'user_opt_out'
            WHERE enrollment_device_id = $1 AND state = 'active'
              AND EXISTS (
                SELECT 1 FROM ${table(schema, "accountless_enrollment_ledger")} ledger
                 WHERE ledger.device_id = $1 AND ledger.state = 'revoked'
              )`,
          [row.id, now],
        );
        await client.query(
          `UPDATE ${table(schema, "accountless_v11_device_authorizations")}
              SET state = 'revoked', revoked_at = $2::timestamptz,
                  revocation_reason = 'user_opt_out'
            WHERE enrollment_device_id = $1 AND state = 'active'
              AND EXISTS (
                SELECT 1 FROM ${table(schema, "accountless_enrollment_ledger")} ledger
                 WHERE ledger.device_id = $1 AND ledger.state = 'revoked'
              )`,
          [row.id, now],
        );
        // The v1.2 successor grant is revoked with the same instant and
        // reason, which is what its retained readers recognise.
        await client.query(
          `UPDATE ${table(schema, "accountless_v12_device_authorizations")}
              SET state = 'revoked', revoked_at = $2::timestamptz,
                  revocation_reason = 'user_opt_out'
            WHERE enrollment_device_id = $1 AND state = 'active'
              AND EXISTS (
                SELECT 1 FROM ${table(schema, "accountless_enrollment_ledger")} ledger
                 WHERE ledger.device_id = $1 AND ledger.state = 'revoked'
              )`,
          [row.id, now],
        );
        await client.query(
          `UPDATE ${table(schema, "device_credentials")}
              SET state = 'revoked', revoked_at = COALESCE(revoked_at, $2::timestamptz)
            WHERE accountless_enrollment_device_id = $1
              AND authority_kind = 'accountless' AND state = 'active'`,
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
