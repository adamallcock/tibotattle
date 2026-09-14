-- A move reserves destination headroom before writing its private pre-copy.
-- The ordinary route remains active until the pre-copy is complete.  The
-- existing storage_owner_moves journal owns the later fenced transition.
CREATE TABLE storage_owner_move_preparations (
  move_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES storage_owner_routes(owner_id),
  source_shard_id TEXT NOT NULL REFERENCES storage_shards(shard_id),
  destination_shard_id TEXT NOT NULL REFERENCES storage_shards(shard_id),
  source_generation INTEGER NOT NULL CHECK(source_generation BETWEEN 1 AND 9007199254740989),
  destination_generation INTEGER NOT NULL CHECK(destination_generation=source_generation+1),
  reservation_bytes INTEGER NOT NULL CHECK(reservation_bytes BETWEEN 1 AND 9000000000),
  source_namespace TEXT NOT NULL CHECK(length(source_namespace) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN('copying','ready','fencing','finalizing','verified','committed','abandoning','abandoned')),
  precopy_after_source_row_id INTEGER NOT NULL DEFAULT 0 CHECK(precopy_after_source_row_id>=0),
  precopy_high_water INTEGER NOT NULL CHECK(precopy_high_water>=0),
  final_high_water INTEGER CHECK(final_high_water IS NULL OR final_high_water>=precopy_high_water),
  materialized_after_source_row_id INTEGER NOT NULL DEFAULT 0 CHECK(materialized_after_source_row_id>=0),
  verify_after_source_row_id INTEGER NOT NULL DEFAULT 0 CHECK(verify_after_source_row_id>=0),
  verify_chain_digest TEXT CHECK(verify_chain_digest IS NULL OR (length(verify_chain_digest)=64 AND verify_chain_digest NOT GLOB '*[^0-9a-f]*')),
  authority_digest TEXT CHECK(authority_digest IS NULL OR (length(authority_digest)=64 AND authority_digest NOT GLOB '*[^0-9a-f]*')),
  copy_digest TEXT CHECK(copy_digest IS NULL OR (length(copy_digest)=64 AND copy_digest NOT GLOB '*[^0-9a-f]*')),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  CHECK(source_shard_id<>destination_shard_id),
  CHECK((state IN('copying','ready','fencing','finalizing','abandoning') AND copy_digest IS NULL)
    OR (state IN('verified','committed') AND copy_digest IS NOT NULL)
    OR state='abandoned')
) STRICT;

CREATE UNIQUE INDEX storage_owner_move_preparation_inflight
 ON storage_owner_move_preparations(owner_id) WHERE state NOT IN('committed','abandoned');

CREATE TRIGGER storage_owner_move_preparation_reserve BEFORE INSERT ON storage_owner_move_preparations BEGIN
 SELECT (CASE WHEN NEW.state<>'copying' OR NEW.precopy_after_source_row_id<>0
   OR NEW.final_high_water IS NOT NULL OR NEW.materialized_after_source_row_id<>0
   OR NEW.verify_after_source_row_id<>0 OR NEW.verify_chain_digest IS NOT NULL
   OR NEW.authority_digest IS NOT NULL OR NEW.copy_digest IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM storage_owner_routes route
     WHERE route.owner_id=NEW.owner_id AND route.shard_id=NEW.source_shard_id
       AND route.route_generation=NEW.source_generation AND route.state='active'
       AND route.reservation_bytes=NEW.reservation_bytes)
  THEN RAISE(ABORT,'STORAGE_ROUTE_STALE') END);
 SELECT (CASE WHEN NOT EXISTS(
   SELECT 1 FROM storage_shards shard
   JOIN storage_shard_capacity_observations observation USING(shard_id)
   JOIN storage_shard_allocation_policy policy USING(shard_id)
   JOIN storage_shard_runtime_readiness readiness
     ON readiness.readiness_digest=policy.qualification_digest
    AND readiness.shard_id=shard.shard_id AND readiness.binding_name=shard.binding_name
   WHERE shard.shard_id=NEW.destination_shard_id AND shard.state='active'
    AND readiness.state='active' AND readiness.contract_version=1
    AND observation.pressure_state='normal' AND policy.allocation_enabled=1
    AND observation.observed_at<=NEW.updated_at AND observation.valid_until>=NEW.updated_at
    AND observation.observed_bytes<6000000000
    AND observation.observed_bytes+shard.reserved_bytes+NEW.reservation_bytes<=shard.capacity_bytes)
  THEN RAISE(ABORT,'STORAGE_CAPACITY_UNAVAILABLE') END);
END;

CREATE TRIGGER storage_owner_move_preparation_reserved AFTER INSERT ON storage_owner_move_preparations BEGIN
 UPDATE storage_shards SET reserved_bytes=reserved_bytes+NEW.reservation_bytes
  WHERE shard_id=NEW.destination_shard_id;
END;

CREATE TRIGGER storage_owner_move_preparation_transition BEFORE UPDATE ON storage_owner_move_preparations BEGIN
 SELECT (CASE WHEN NEW.move_id<>OLD.move_id OR NEW.owner_id<>OLD.owner_id
   OR NEW.source_shard_id<>OLD.source_shard_id OR NEW.destination_shard_id<>OLD.destination_shard_id
   OR NEW.source_generation<>OLD.source_generation OR NEW.destination_generation<>OLD.destination_generation
   OR NEW.reservation_bytes<>OLD.reservation_bytes OR NEW.source_namespace<>OLD.source_namespace
   OR NEW.precopy_after_source_row_id<OLD.precopy_after_source_row_id
   OR NEW.materialized_after_source_row_id<OLD.materialized_after_source_row_id
   OR NEW.verify_after_source_row_id<OLD.verify_after_source_row_id
   OR NOT ((OLD.state='copying' AND NEW.state IN('copying','ready') AND NEW.final_high_water IS NULL
      AND NEW.verify_chain_digest IS NULL AND NEW.authority_digest IS NULL AND NEW.copy_digest IS NULL)
    OR (OLD.state='ready' AND NEW.state='fencing' AND NEW.final_high_water IS NULL
      AND NEW.verify_chain_digest IS NULL AND NEW.authority_digest IS NULL AND NEW.copy_digest IS NULL)
    OR (OLD.state='fencing' AND NEW.state='ready' AND NEW.final_high_water IS NULL
      AND NEW.verify_chain_digest IS NULL AND NEW.authority_digest IS NULL AND NEW.copy_digest IS NULL)
    OR (OLD.state='fencing' AND NEW.state='fencing' AND NEW.final_high_water IS NULL
      AND NEW.verify_chain_digest IS NULL AND NEW.authority_digest IS NULL AND NEW.copy_digest IS NULL)
    OR (OLD.state='fencing' AND NEW.state='finalizing' AND NEW.final_high_water IS NOT NULL
      AND NEW.verify_chain_digest IS NULL AND NEW.authority_digest IS NULL AND NEW.copy_digest IS NULL)
    OR (OLD.state='finalizing' AND NEW.state='finalizing' AND NEW.final_high_water=OLD.final_high_water AND NEW.copy_digest IS NULL)
    OR (OLD.state='finalizing' AND NEW.state='verified' AND NEW.final_high_water=OLD.final_high_water
      AND NEW.materialized_after_source_row_id=NEW.final_high_water
      AND NEW.verify_after_source_row_id=NEW.final_high_water AND NEW.verify_chain_digest IS NOT NULL
      AND NEW.authority_digest IS NOT NULL AND NEW.copy_digest IS NOT NULL)
    OR (OLD.state='verified' AND NEW.state='committed' AND NEW.final_high_water=OLD.final_high_water
      AND NEW.copy_digest=OLD.copy_digest AND NEW.verify_chain_digest=OLD.verify_chain_digest
      AND NEW.authority_digest=OLD.authority_digest)
    OR (OLD.state IN('copying','ready') AND NEW.state='abandoning'
      AND NEW.final_high_water IS NULL AND NEW.verify_chain_digest IS NULL
      AND NEW.authority_digest IS NULL AND NEW.copy_digest IS NULL)
    OR (OLD.state='abandoning' AND NEW.state IN('abandoning','abandoned')
      AND NEW.final_high_water IS NULL AND NEW.verify_chain_digest IS NULL
      AND NEW.authority_digest IS NULL AND NEW.copy_digest IS NULL)
    OR (OLD.state=NEW.state AND OLD.state IN('committed','abandoned')
      AND NEW.final_high_water IS OLD.final_high_water AND NEW.copy_digest IS OLD.copy_digest))
  THEN RAISE(ABORT,'STORAGE_MOVE_PREPARATION_INVALID') END);
END;

CREATE TRIGGER storage_owner_move_preparation_abandoned AFTER UPDATE OF state ON storage_owner_move_preparations
WHEN NEW.state='abandoned' AND OLD.state='abandoning' BEGIN
 UPDATE storage_shards SET reserved_bytes=reserved_bytes-NEW.reservation_bytes
  WHERE shard_id=NEW.destination_shard_id AND reserved_bytes>=NEW.reservation_bytes;
END;

CREATE TRIGGER storage_owner_move_preparation_no_delete BEFORE DELETE ON storage_owner_move_preparations BEGIN
 SELECT RAISE(ABORT,'STORAGE_MOVE_PREPARATION_HISTORY_REQUIRED');
END;

-- A final move reuses the exact pre-copy reservation.  Direct legacy callers
-- retain the prior reservation behavior.
DROP TRIGGER storage_move_reserve;
CREATE TRIGGER storage_move_reserve BEFORE INSERT ON storage_owner_moves BEGIN
 SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM storage_owner_routes WHERE owner_id=NEW.owner_id
   AND shard_id=NEW.source_shard_id AND route_generation=NEW.source_generation
   AND state='active' AND reservation_bytes=NEW.reservation_bytes)
  THEN RAISE(ABORT,'STORAGE_ROUTE_STALE') END);
 SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM storage_owner_move_preparations p
    WHERE p.move_id=NEW.move_id AND p.owner_id=NEW.owner_id
     AND p.source_shard_id=NEW.source_shard_id AND p.destination_shard_id=NEW.destination_shard_id
     AND p.source_generation=NEW.source_generation AND p.destination_generation=NEW.destination_generation
     AND p.reservation_bytes=NEW.reservation_bytes AND p.state IN('fencing','finalizing'))
   AND NOT EXISTS(SELECT 1 FROM storage_shards shard
    JOIN storage_shard_capacity_observations observation USING(shard_id)
    JOIN storage_shard_allocation_policy policy USING(shard_id)
    JOIN storage_shard_runtime_readiness readiness
      ON readiness.readiness_digest=policy.qualification_digest
     AND readiness.shard_id=shard.shard_id AND readiness.binding_name=shard.binding_name
    WHERE shard.shard_id=NEW.destination_shard_id AND shard.state='active'
     AND readiness.state='active' AND readiness.contract_version=1
     AND observation.pressure_state='normal' AND policy.allocation_enabled=1
     AND observation.observed_at<=NEW.updated_at AND observation.valid_until>=NEW.updated_at
     AND observation.observed_bytes<6000000000
     AND observation.observed_bytes+shard.reserved_bytes+NEW.reservation_bytes<=shard.capacity_bytes)
  THEN RAISE(ABORT,'STORAGE_CAPACITY_UNAVAILABLE') END);
END;

DROP TRIGGER storage_move_reserved;
CREATE TRIGGER storage_move_reserved AFTER INSERT ON storage_owner_moves BEGIN
 UPDATE storage_shards SET reserved_bytes=reserved_bytes+NEW.reservation_bytes
  WHERE shard_id=NEW.destination_shard_id
   AND NOT EXISTS(SELECT 1 FROM storage_owner_move_preparations WHERE move_id=NEW.move_id);
 UPDATE storage_owner_routes SET state='moving',updated_at=NEW.updated_at WHERE owner_id=NEW.owner_id;
END;
