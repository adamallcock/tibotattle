-- Allocation uses an explicit, expiring observation. The legacy zero default on
-- storage_shards is not evidence that an empty database was measured.
CREATE TABLE storage_shard_capacity_observations (
  shard_id TEXT PRIMARY KEY NOT NULL REFERENCES storage_shards(shard_id),
  observed_bytes INTEGER NOT NULL CHECK (observed_bytes >= 0),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  valid_until INTEGER NOT NULL CHECK (valid_until >= observed_at),
  pressure_state TEXT NOT NULL CHECK (pressure_state IN ('normal', 'pressure')),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1)
) STRICT;

-- Qualification is an explicit operator decision, separate from measurement.
-- Recording a small database size can never make an unqualified shard ready.
CREATE TABLE storage_shard_allocation_policy (
  shard_id TEXT PRIMARY KEY NOT NULL REFERENCES storage_shards(shard_id),
  allocation_tier TEXT NOT NULL CHECK (allocation_tier IN ('active', 'spare')),
  allocation_enabled INTEGER NOT NULL CHECK (allocation_enabled IN (0, 1)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1)
) STRICT;

CREATE TRIGGER storage_shard_allocation_policy_identity_immutable
BEFORE UPDATE ON storage_shard_allocation_policy
WHEN NEW.shard_id <> OLD.shard_id OR NEW.schema_version <> OLD.schema_version BEGIN
  SELECT RAISE(ABORT, 'STORAGE_SHARD_ALLOCATION_POLICY_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER storage_capacity_observation_identity_immutable
BEFORE UPDATE ON storage_shard_capacity_observations
WHEN NEW.shard_id <> OLD.shard_id OR NEW.schema_version <> OLD.schema_version BEGIN
  SELECT RAISE(ABORT, 'STORAGE_CAPACITY_OBSERVATION_IDENTITY_IMMUTABLE');
END;

DROP TRIGGER storage_owner_reserve;
CREATE TRIGGER storage_owner_reserve BEFORE INSERT ON storage_owner_routes BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM storage_shards shard
      JOIN storage_shard_capacity_observations observation
        ON observation.shard_id = shard.shard_id
      JOIN storage_shard_allocation_policy policy
        ON policy.shard_id = shard.shard_id
     WHERE shard.shard_id = NEW.shard_id
       AND shard.state = 'active'
       AND observation.pressure_state = 'normal'
       AND policy.allocation_enabled = 1
       AND observation.observed_at <= NEW.updated_at
       AND observation.valid_until >= NEW.updated_at
       AND observation.observed_bytes < 6000000000
       AND observation.observed_bytes + shard.reserved_bytes
         + NEW.reservation_bytes <= shard.capacity_bytes
  ) THEN RAISE(ABORT, 'STORAGE_CAPACITY_UNAVAILABLE') END;
END;

DROP TRIGGER storage_move_reserve;
CREATE TRIGGER storage_move_reserve BEFORE INSERT ON storage_owner_moves BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM storage_owner_routes
     WHERE owner_id = NEW.owner_id
       AND shard_id = NEW.source_shard_id
       AND route_generation = NEW.source_generation
       AND state = 'active'
       AND reservation_bytes = NEW.reservation_bytes
  ) THEN RAISE(ABORT, 'STORAGE_ROUTE_STALE') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM storage_shards shard
      JOIN storage_shard_capacity_observations observation
        ON observation.shard_id = shard.shard_id
      JOIN storage_shard_allocation_policy policy
        ON policy.shard_id = shard.shard_id
     WHERE shard.shard_id = NEW.destination_shard_id
       AND shard.state = 'active'
       AND observation.pressure_state = 'normal'
       AND policy.allocation_enabled = 1
       AND observation.observed_at <= NEW.updated_at
       AND observation.valid_until >= NEW.updated_at
       AND observation.observed_bytes < 6000000000
       AND observation.observed_bytes + shard.reserved_bytes
         + NEW.reservation_bytes <= shard.capacity_bytes
  ) THEN RAISE(ABORT, 'STORAGE_CAPACITY_UNAVAILABLE') END;
END;
