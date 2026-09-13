import {
  STORAGE_NEW_OWNER_CUTOFF_BYTES,
  STORAGE_SHARD_OPERATING_CAP_BYTES,
  StorageRoutingError,
} from "./storage-routing";

const SHARD_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;

export interface StorageCapacityObservation {
  readonly shardId: string;
  readonly observedBytes: number;
  readonly observedAt: number;
  readonly validUntil: number;
  readonly pressureState: "normal" | "pressure";
}

function validInteger(value: number, maximum = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

/** Trusted control-plane input. HTTP request bodies never call this function. */
export async function recordStorageCapacityObservation(
  catalog: D1Database,
  observation: StorageCapacityObservation,
): Promise<void> {
  if (!catalog || typeof catalog.prepare !== "function"
      || !SHARD_ID.test(observation.shardId)
      || !validInteger(observation.observedBytes)
      || !validInteger(observation.observedAt)
      || !validInteger(observation.validUntil)
      || observation.validUntil < observation.observedAt
      || !["normal", "pressure"].includes(observation.pressureState)) {
    throw new StorageRoutingError("INVALID_ROUTING_INPUT");
  }
  try {
    await catalog.batch([
      catalog.prepare(`
        INSERT INTO storage_shard_capacity_observations (
          shard_id, observed_bytes, observed_at, valid_until,
          pressure_state
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (shard_id) DO UPDATE SET
          observed_bytes = CASE
            WHEN excluded.observed_at = storage_shard_capacity_observations.observed_at
              THEN MAX(excluded.observed_bytes, storage_shard_capacity_observations.observed_bytes)
            ELSE excluded.observed_bytes END,
          observed_at = excluded.observed_at,
          valid_until = CASE
            WHEN excluded.observed_at = storage_shard_capacity_observations.observed_at
              THEN MIN(excluded.valid_until, storage_shard_capacity_observations.valid_until)
            ELSE excluded.valid_until END,
          pressure_state = CASE
            WHEN excluded.observed_at = storage_shard_capacity_observations.observed_at
              AND (excluded.pressure_state = 'pressure'
                OR storage_shard_capacity_observations.pressure_state = 'pressure')
              THEN 'pressure'
            ELSE excluded.pressure_state END
        WHERE excluded.observed_at >= storage_shard_capacity_observations.observed_at
      `).bind(
        observation.shardId,
        observation.observedBytes,
        observation.observedAt,
        observation.validUntil,
        observation.pressureState,
      ),
      catalog.prepare(`
        UPDATE storage_shards
           SET state = CASE
                 WHEN state = 'active' AND (
                   SELECT observed_bytes FROM storage_shard_capacity_observations
                    WHERE shard_id = storage_shards.shard_id
                 ) + reserved_bytes > capacity_bytes
                   THEN 'draining'
                 ELSE state
               END,
               observed_bytes = (
                 SELECT observed_bytes FROM storage_shard_capacity_observations
                  WHERE shard_id = storage_shards.shard_id
               )
         WHERE shard_id = ?
           AND EXISTS (SELECT 1 FROM storage_shard_capacity_observations
             WHERE shard_id = storage_shards.shard_id)
      `).bind(
        observation.shardId,
      ),
    ]);
  } catch (error) {
    if (error instanceof StorageRoutingError) throw error;
    throw new StorageRoutingError("STORAGE_UNAVAILABLE");
  }
}

export async function configureStorageShardAllocation(
  catalog: D1Database,
  policy: Readonly<{
    shardId: string;
    allocationTier: "active" | "spare";
    allocationEnabled: boolean;
    updatedAt: number;
  }>,
): Promise<void> {
  if (!catalog || typeof catalog.prepare !== "function"
      || !SHARD_ID.test(policy.shardId)
      || !["active", "spare"].includes(policy.allocationTier)
      || typeof policy.allocationEnabled !== "boolean"
      || !validInteger(policy.updatedAt)) {
    throw new StorageRoutingError("INVALID_ROUTING_INPUT");
  }
  try {
    await catalog.prepare(`INSERT INTO storage_shard_allocation_policy
      (shard_id, allocation_tier, allocation_enabled, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (shard_id) DO UPDATE SET
        allocation_tier = excluded.allocation_tier,
        allocation_enabled = excluded.allocation_enabled,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at >= storage_shard_allocation_policy.updated_at`)
      .bind(policy.shardId, policy.allocationTier,
        policy.allocationEnabled ? 1 : 0, policy.updatedAt).run();
  } catch {
    throw new StorageRoutingError("STORAGE_UNAVAILABLE");
  }
}

/** Preserve the last measured bytes while immediately closing allocation. */
export async function invalidateStorageCapacityObservation(
  catalog: D1Database,
  shardId: string,
  nowEpoch: number,
): Promise<void> {
  if (!catalog || typeof catalog.prepare !== "function"
      || !SHARD_ID.test(shardId) || !validInteger(nowEpoch)) {
    throw new StorageRoutingError("INVALID_ROUTING_INPUT");
  }
  try {
    await catalog.prepare(`UPDATE storage_shard_capacity_observations
      SET pressure_state = 'pressure',
          valid_until = MAX(observed_at, MIN(valid_until, ?))
      WHERE shard_id = ?`).bind(nowEpoch, shardId).run();
  } catch {
    throw new StorageRoutingError("STORAGE_UNAVAILABLE");
  }
}

export function storageCapacityPolicy(): Readonly<{
  newOwnerCutoffBytes: number;
  operatingCapBytes: number;
}> {
  return Object.freeze({
    newOwnerCutoffBytes: STORAGE_NEW_OWNER_CUTOFF_BYTES,
    operatingCapBytes: STORAGE_SHARD_OPERATING_CAP_BYTES,
  });
}
