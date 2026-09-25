/**
 * Bounded PostgreSQL port of the D1 stale device-lifecycle maintenance pass.
 * Each family is claimed and updated in one small transaction. Every category
 * is resumable: revoked rows are excluded on replay and expired history rows
 * are deleted only when their canonical timestamp is past its cutoff.
 */
import {
  DEFAULT_DEVICE_LIFECYCLE_POLICY,
  type DeviceLifecycleMaintenanceResult,
  type DeviceLifecyclePolicy,
} from "./device-auth";
import {
  createPostgresSchemaConfig,
  PostgresStorageError,
  quotePostgresIdentifier,
  withPostgresMutation,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";

export interface PostgresDeviceLifecycleOptions {
  readonly schema?: PostgresSchemaOptions;
  readonly nowEpoch?: number;
  readonly policy?: Partial<DeviceLifecyclePolicy>;
}

export interface PostgresDeviceLifecycleReceipt extends DeviceLifecycleMaintenanceResult {
  readonly complete: boolean;
}

interface ChangedRow { readonly changed: number; }
interface PendingRow { readonly pending: boolean; }

function invalidOptions(): never {
  throw new PostgresStorageError("invalid", "maintenance.device_lifecycle.options");
}

function lifecyclePolicy(overrides: Partial<DeviceLifecyclePolicy> | undefined): DeviceLifecyclePolicy {
  const policy = { ...DEFAULT_DEVICE_LIFECYCLE_POLICY, ...(overrides ?? {}) };
  const values = [
    policy.idleMilliseconds,
    policy.socialRecheckMaxAgeMilliseconds,
    policy.activeDeviceLimit,
    policy.pairingIssueWindowMilliseconds,
    policy.pairingIssueLimit,
    policy.pairingClaimWindowMilliseconds,
    policy.pairingClaimLimit,
    policy.rotationHistoryMilliseconds,
    policy.maintenanceBatchSize,
  ];
  if (!values.every((value) => Number.isSafeInteger(value) && value > 0)) {
    return invalidOptions();
  }
  return policy;
}

function nowMilliseconds(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 9_999_999_999_999) {
    return invalidOptions();
  }
  return Number(value);
}

function changedCount(rows: readonly ChangedRow[], maximum: number, operation: string): number {
  if (!Array.isArray(rows) || rows.length > maximum
      || rows.some((row) => row?.changed !== 1)) {
    throw new PostgresStorageError("unavailable", `${operation}.result`);
  }
  return rows.length;
}

interface LifecyclePage {
  readonly operation: string;
  readonly updateSql: string;
  readonly pendingSql: string;
  readonly values: readonly unknown[];
  readonly pendingValues: readonly unknown[];
  readonly batchSize: number;
}

async function runPage(pool: PostgresPool, page: LifecyclePage): Promise<{
  readonly changed: number;
  readonly complete: boolean;
}> {
  return withPostgresMutation(pool, async (client) => {
    const result = await client.query<ChangedRow>(page.updateSql, [...page.values]);
    const changed = changedCount(result.rows, page.batchSize, page.operation);
    const readback = await client.query<PendingRow>(page.pendingSql, [...page.pendingValues]);
    const pending = readback.rows[0]?.pending;
    if (typeof pending !== "boolean" || readback.rows.length !== 1) {
      throw new PostgresStorageError("unavailable", `${page.operation}.readback`);
    }
    return Object.freeze({ changed, complete: !pending });
  }, { operation: page.operation });
}

/**
 * Revokes expired/idle credentials and authorizations, then removes only the
 * bounded rotation and pairing-event history whose retention cutoffs elapsed.
 * Accountless credentials keep the D1 rule: expiry alone does not revoke them.
 */
export async function purgePostgresStaleDeviceLifecycleRows(
  pool: PostgresPool,
  options: PostgresDeviceLifecycleOptions = {},
): Promise<PostgresDeviceLifecycleReceipt> {
  if (!pool || typeof pool.connect !== "function" || !options || typeof options !== "object") {
    return invalidOptions();
  }
  const policy = lifecyclePolicy(options.policy);
  const nowEpoch = nowMilliseconds(options.nowEpoch ?? Date.now());
  const isoAt = (epoch: number): string => {
    const date = new Date(epoch);
    if (!Number.isFinite(date.getTime())) return invalidOptions();
    return date.toISOString();
  };
  const now = isoAt(nowEpoch);
  const idleCutoff = isoAt(nowEpoch - policy.idleMilliseconds);
  const eventCutoff = isoAt(nowEpoch - Math.max(
    policy.pairingIssueWindowMilliseconds,
    policy.pairingClaimWindowMilliseconds,
  ));
  const schemaConfig = createPostgresSchemaConfig(options.schema ?? {});
  const schema = quotePostgresIdentifier(schemaConfig.primarySchema);
  const batchSize = policy.maintenanceBatchSize;

  const pairings = await runPage(pool, {
    operation: "maintenance.device_lifecycle.pairings",
    batchSize,
    values: [now, batchSize],
    pendingValues: [now],
    updateSql: `WITH candidates AS (
       SELECT pairing.id
         FROM ${schema}."device_pairings" AS pairing
        WHERE pairing.state = 'unused'
          AND (pairing.expires_at <= $1::timestamptz
            OR EXISTS (
              SELECT 1 FROM ${schema}."participants" AS participant
               WHERE participant.id = pairing.participant_id
                 AND participant.state <> 'active'
            ))
        ORDER BY pairing.expires_at, pairing.id
        LIMIT $2
        FOR UPDATE OF pairing SKIP LOCKED
     )
     UPDATE ${schema}."device_pairings" AS pairing
        SET state = 'revoked', revoked_at = COALESCE(pairing.revoked_at, $1::timestamptz)
       FROM candidates
      WHERE pairing.id = candidates.id
     RETURNING 1 AS changed`,
    pendingSql: `SELECT EXISTS (
       SELECT 1 FROM ${schema}."device_pairings" AS pairing
        WHERE pairing.state = 'unused'
          AND (pairing.expires_at <= $1::timestamptz
            OR EXISTS (
              SELECT 1 FROM ${schema}."participants" AS participant
               WHERE participant.id = pairing.participant_id
                 AND participant.state <> 'active'
            ))
     ) AS pending`,
  });

  const devices = await runPage(pool, {
    operation: "maintenance.device_lifecycle.devices",
    batchSize,
    values: [now, idleCutoff, batchSize],
    pendingValues: [now, idleCutoff],
    updateSql: `WITH candidates AS (
       SELECT device.id
         FROM ${schema}."device_credentials" AS device
        WHERE device.state = 'active'
          AND ((device.authority_kind = 'social'
              AND (device.expires_at <= $1::timestamptz
                OR device.last_used_at <= $2::timestamptz))
            OR EXISTS (
              SELECT 1 FROM ${schema}."participants" AS participant
               WHERE participant.id = device.participant_id
                 AND participant.state <> 'active'
            ))
        ORDER BY device.id
        LIMIT $3
        FOR UPDATE OF device SKIP LOCKED
     )
     UPDATE ${schema}."device_credentials" AS device
        SET state = 'revoked', revoked_at = COALESCE(device.revoked_at, $1::timestamptz)
       FROM candidates
      WHERE device.id = candidates.id
     RETURNING 1 AS changed`,
    pendingSql: `SELECT EXISTS (
       SELECT 1 FROM ${schema}."device_credentials" AS device
        WHERE device.state = 'active'
          AND ((device.authority_kind = 'social'
              AND (device.expires_at <= $1::timestamptz
                OR device.last_used_at <= $2::timestamptz))
            OR EXISTS (
              SELECT 1 FROM ${schema}."participants" AS participant
               WHERE participant.id = device.participant_id
                 AND participant.state <> 'active'
            ))
     ) AS pending`,
  });

  const uploads = await runPage(pool, {
    operation: "maintenance.device_lifecycle.uploads",
    batchSize,
    values: [now, batchSize],
    pendingValues: [now],
    updateSql: `WITH candidates AS (
       SELECT upload.id
         FROM ${schema}."device_upload_authorizations" AS upload
         LEFT JOIN ${schema}."device_credentials" AS device
           ON device.id = upload.issued_by_device_id
        WHERE upload.state IN ('unused', 'consuming')
          AND (upload.expires_at <= $1::timestamptz
            OR device.id IS NULL
            OR device.state <> 'active'
            OR device.expires_at <= $1::timestamptz
            OR EXISTS (
              SELECT 1 FROM ${schema}."participants" AS participant
               WHERE participant.id = upload.participant_id
                 AND participant.state <> 'active'
            ))
        ORDER BY upload.expires_at, upload.id
        LIMIT $2
        FOR UPDATE OF upload SKIP LOCKED
     )
     UPDATE ${schema}."device_upload_authorizations" AS upload
        SET state = 'revoked', revoked_at = COALESCE(upload.revoked_at, $1::timestamptz),
            consume_lease_expires_at = NULL
       FROM candidates
      WHERE upload.id = candidates.id
     RETURNING 1 AS changed`,
    pendingSql: `SELECT EXISTS (
       SELECT 1
         FROM ${schema}."device_upload_authorizations" AS upload
         LEFT JOIN ${schema}."device_credentials" AS device
           ON device.id = upload.issued_by_device_id
        WHERE upload.state IN ('unused', 'consuming')
          AND (upload.expires_at <= $1::timestamptz
            OR device.id IS NULL
            OR device.state <> 'active'
            OR device.expires_at <= $1::timestamptz
            OR EXISTS (
              SELECT 1 FROM ${schema}."participants" AS participant
               WHERE participant.id = upload.participant_id
                 AND participant.state <> 'active'
            ))
     ) AS pending`,
  });

  const rotations = await runPage(pool, {
    operation: "maintenance.device_lifecycle.rotations",
    batchSize,
    values: [now, batchSize],
    pendingValues: [now],
    updateSql: `WITH candidates AS (
       SELECT rotation.id
         FROM ${schema}."device_credential_rotations" AS rotation
        WHERE rotation.retire_at <= $1::timestamptz
        ORDER BY rotation.retire_at, rotation.id
        LIMIT $2
        FOR UPDATE OF rotation SKIP LOCKED
     )
     DELETE FROM ${schema}."device_credential_rotations" AS rotation
      USING candidates
      WHERE rotation.id = candidates.id
     RETURNING 1 AS changed`,
    pendingSql: `SELECT EXISTS (
       SELECT 1 FROM ${schema}."device_credential_rotations" AS rotation
        WHERE rotation.retire_at <= $1::timestamptz
     ) AS pending`,
  });

  const events = await runPage(pool, {
    operation: "maintenance.device_lifecycle.events",
    batchSize,
    values: [eventCutoff, batchSize],
    pendingValues: [eventCutoff],
    updateSql: `WITH candidates AS (
       SELECT event.id
         FROM ${schema}."device_pairing_events" AS event
        WHERE event.occurred_at <= $1::timestamptz
        ORDER BY event.occurred_at, event.id
        LIMIT $2
        FOR UPDATE OF event SKIP LOCKED
     )
     DELETE FROM ${schema}."device_pairing_events" AS event
      USING candidates
      WHERE event.id = candidates.id
     RETURNING 1 AS changed`,
    pendingSql: `SELECT EXISTS (
       SELECT 1 FROM ${schema}."device_pairing_events" AS event
        WHERE event.occurred_at <= $1::timestamptz
     ) AS pending`,
  });

  return Object.freeze({
    pairingsRevoked: pairings.changed,
    devicesRevoked: devices.changed,
    uploadsRevoked: uploads.changed,
    rotationsPurged: rotations.changed,
    pairingEventsPurged: events.changed,
    complete: pairings.complete && devices.complete && uploads.complete
      && rotations.complete && events.complete,
  });
}
