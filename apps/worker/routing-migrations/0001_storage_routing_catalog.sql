-- Control-plane metadata only. Shard-local fences are installed separately.
CREATE TABLE storage_shards (
  shard_id TEXT PRIMARY KEY NOT NULL,
  binding_name TEXT UNIQUE NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'draining', 'offline')),
  observed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (observed_bytes >= 0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  capacity_bytes INTEGER NOT NULL DEFAULT 9000000000 CHECK (capacity_bytes BETWEEN 1 AND 9000000000),
  CHECK (observed_bytes + reserved_bytes <= capacity_bytes OR state <> 'active')
) STRICT;
CREATE TABLE storage_owner_routes (
  owner_id TEXT PRIMARY KEY NOT NULL,
  shard_id TEXT NOT NULL REFERENCES storage_shards(shard_id),
  route_generation INTEGER NOT NULL CHECK (route_generation BETWEEN 1 AND 9007199254740990),
  state TEXT NOT NULL CHECK (state IN ('preparing', 'active', 'moving')),
  reservation_bytes INTEGER NOT NULL CHECK (reservation_bytes BETWEEN 1 AND 9000000000),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;
CREATE TABLE storage_capability_locators (
  capability_hash TEXT PRIMARY KEY NOT NULL CHECK (length(capability_hash) = 64 AND capability_hash NOT GLOB '*[^0-9a-f]*'),
  owner_id TEXT NOT NULL REFERENCES storage_owner_routes(owner_id),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked'))
) STRICT;
CREATE TABLE storage_owner_moves (
  move_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES storage_owner_routes(owner_id),
  source_shard_id TEXT NOT NULL REFERENCES storage_shards(shard_id),
  destination_shard_id TEXT NOT NULL REFERENCES storage_shards(shard_id),
  source_generation INTEGER NOT NULL CHECK (source_generation BETWEEN 1 AND 9007199254740989),
  destination_generation INTEGER NOT NULL CHECK (destination_generation = source_generation + 1),
  reservation_bytes INTEGER NOT NULL CHECK (reservation_bytes BETWEEN 1 AND 9000000000),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'source_fenced', 'copied', 'committed')),
  copy_digest TEXT CHECK (copy_digest IS NULL OR (length(copy_digest) = 64 AND copy_digest NOT GLOB '*[^0-9a-f]*')),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  CHECK (source_shard_id <> destination_shard_id),
  CHECK ((state IN ('prepared', 'source_fenced') AND copy_digest IS NULL)
    OR (state IN ('copied', 'committed') AND copy_digest IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX storage_owner_move_inflight ON storage_owner_moves(owner_id) WHERE state <> 'committed';
CREATE TRIGGER storage_owner_reserve BEFORE INSERT ON storage_owner_routes BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM storage_shards WHERE shard_id = NEW.shard_id
    AND state = 'active' AND observed_bytes + reserved_bytes + NEW.reservation_bytes <= capacity_bytes)
    THEN RAISE(ABORT, 'STORAGE_CAPACITY_UNAVAILABLE') END;
END;
CREATE TRIGGER storage_owner_reserved AFTER INSERT ON storage_owner_routes BEGIN
  UPDATE storage_shards SET reserved_bytes = reserved_bytes + NEW.reservation_bytes WHERE shard_id = NEW.shard_id;
END;
CREATE TRIGGER storage_move_reserve BEFORE INSERT ON storage_owner_moves BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM storage_owner_routes WHERE owner_id = NEW.owner_id
    AND shard_id = NEW.source_shard_id AND route_generation = NEW.source_generation AND state = 'active'
    AND reservation_bytes = NEW.reservation_bytes)
    THEN RAISE(ABORT, 'STORAGE_ROUTE_STALE') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM storage_shards WHERE shard_id = NEW.destination_shard_id
    AND state = 'active' AND observed_bytes + reserved_bytes + NEW.reservation_bytes <= capacity_bytes)
    THEN RAISE(ABORT, 'STORAGE_CAPACITY_UNAVAILABLE') END;
END;
CREATE TRIGGER storage_move_reserved AFTER INSERT ON storage_owner_moves BEGIN
  UPDATE storage_shards SET reserved_bytes = reserved_bytes + NEW.reservation_bytes WHERE shard_id = NEW.destination_shard_id;
  UPDATE storage_owner_routes SET state = 'moving', updated_at = NEW.updated_at WHERE owner_id = NEW.owner_id;
END;
-- Generations are routing metadata, never telemetry source sequence numbers.
CREATE TRIGGER storage_route_transition BEFORE UPDATE ON storage_owner_routes BEGIN
  SELECT CASE WHEN NEW.owner_id <> OLD.owner_id OR NEW.reservation_bytes <> OLD.reservation_bytes
    OR NOT ((OLD.state = 'preparing' AND NEW.state = 'active' AND NEW.shard_id = OLD.shard_id AND NEW.route_generation = OLD.route_generation)
      OR (OLD.state = 'active' AND NEW.state = 'moving' AND NEW.shard_id = OLD.shard_id AND NEW.route_generation = OLD.route_generation)
      OR (OLD.state = 'moving' AND NEW.state = 'active' AND NEW.route_generation = OLD.route_generation + 1
        AND EXISTS (SELECT 1 FROM storage_owner_moves WHERE owner_id = OLD.owner_id AND state = 'committed'
          AND source_shard_id = OLD.shard_id AND destination_shard_id = NEW.shard_id AND destination_generation = NEW.route_generation)))
    THEN RAISE(ABORT, 'STORAGE_ROUTE_TRANSITION_INVALID') END;
END;
CREATE TRIGGER storage_move_transition BEFORE UPDATE ON storage_owner_moves BEGIN
  SELECT CASE WHEN NEW.move_id <> OLD.move_id OR NEW.owner_id <> OLD.owner_id
    OR NEW.source_shard_id <> OLD.source_shard_id OR NEW.destination_shard_id <> OLD.destination_shard_id
    OR NEW.source_generation <> OLD.source_generation OR NEW.destination_generation <> OLD.destination_generation
    OR NEW.reservation_bytes <> OLD.reservation_bytes
    OR NOT ((OLD.state = 'prepared' AND NEW.state = 'source_fenced')
      OR (OLD.state = 'source_fenced' AND NEW.state = 'copied')
      OR (OLD.state = 'copied' AND NEW.state = 'committed' AND NEW.copy_digest = OLD.copy_digest))
    THEN RAISE(ABORT, 'STORAGE_MOVE_TRANSITION_INVALID') END;
END;
-- Capacity remains reserved on the source until separately measured/reconciled:
-- a route switch is not proof that retained source bytes were erased.

CREATE TRIGGER storage_shard_identity_immutable BEFORE UPDATE ON storage_shards
WHEN NEW.shard_id <> OLD.shard_id OR NEW.binding_name <> OLD.binding_name BEGIN
  SELECT RAISE(ABORT, 'STORAGE_SHARD_IDENTITY_IMMUTABLE');
END;
CREATE TRIGGER storage_owner_route_no_delete BEFORE DELETE ON storage_owner_routes BEGIN
  SELECT RAISE(ABORT, 'STORAGE_ROUTE_HISTORY_REQUIRED');
END;
CREATE TRIGGER storage_owner_move_no_delete BEFORE DELETE ON storage_owner_moves BEGIN
  SELECT RAISE(ABORT, 'STORAGE_MOVE_HISTORY_REQUIRED');
END;
CREATE INDEX storage_capability_owner ON storage_capability_locators(owner_id, state, capability_hash);
CREATE TRIGGER storage_capability_locator_transition BEFORE UPDATE ON storage_capability_locators BEGIN
  SELECT CASE WHEN NEW.capability_hash <> OLD.capability_hash OR NEW.owner_id <> OLD.owner_id
    OR OLD.state <> 'active' OR NEW.state <> 'revoked'
    THEN RAISE(ABORT, 'STORAGE_CAPABILITY_LOCATOR_IMMUTABLE') END;
END;
