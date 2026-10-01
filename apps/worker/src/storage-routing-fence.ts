/** Install on an ingestion shard, NOT automatically on the routing catalog. */
export const STORAGE_ROUTING_FENCE_SCHEMA_SQL = `
CREATE TABLE storage_owner_fences (
  owner_id TEXT PRIMARY KEY NOT NULL,
  shard_id TEXT NOT NULL,
  route_generation INTEGER NOT NULL CHECK (route_generation BETWEEN 1 AND 9007199254740990),
  state TEXT NOT NULL CHECK (state IN ('active', 'fenced', 'prepared')),
  move_id TEXT,
  copy_digest TEXT,
  CHECK ((state = 'fenced' OR state = 'prepared') = (move_id IS NOT NULL)
    OR (state = 'active' AND move_id IS NOT NULL)),
  CHECK (copy_digest IS NULL OR (length(copy_digest) = 64 AND copy_digest NOT GLOB '*[^0-9a-f]*'))
) STRICT;
CREATE TABLE storage_route_write_checks (owner_id TEXT NOT NULL, shard_id TEXT NOT NULL, route_generation INTEGER NOT NULL) STRICT;
CREATE TRIGGER storage_route_write_guard BEFORE INSERT ON storage_route_write_checks BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM storage_owner_fences WHERE owner_id = NEW.owner_id
    AND shard_id = NEW.shard_id AND route_generation = NEW.route_generation AND state = 'active')
    THEN RAISE(ABORT, 'STORAGE_ROUTE_STALE') END;
END;
CREATE TRIGGER storage_route_write_check_cleanup AFTER INSERT ON storage_route_write_checks BEGIN
  DELETE FROM storage_route_write_checks WHERE owner_id = NEW.owner_id AND shard_id = NEW.shard_id AND route_generation = NEW.route_generation;
END;
CREATE TRIGGER storage_owner_fence_transition BEFORE UPDATE ON storage_owner_fences BEGIN
  SELECT CASE WHEN NEW.owner_id <> OLD.owner_id OR NEW.shard_id <> OLD.shard_id
    OR NEW.route_generation <> OLD.route_generation
    OR NOT ((OLD.state = 'active' AND NEW.state = 'fenced' AND NEW.move_id IS NOT NULL AND NEW.copy_digest IS OLD.copy_digest)
      OR (OLD.state = 'prepared' AND NEW.state = 'active' AND NEW.move_id = OLD.move_id AND NEW.copy_digest = OLD.copy_digest))
    THEN RAISE(ABORT, 'STORAGE_FENCE_TRANSITION_INVALID') END;
END;`;

/** Must be part of the SAME atomic D1 batch as the owner mutation, not a prior read. */
export function ownerWriteFenceStatement(database: D1Database, route: {
  ownerId: string; shardId: string; generation: number;
}): D1PreparedStatement {
  return database.prepare(`INSERT INTO storage_route_write_checks (owner_id, shard_id, route_generation)
    VALUES (?, ?, ?)`).bind(route.ownerId, route.shardId, route.generation);
}
