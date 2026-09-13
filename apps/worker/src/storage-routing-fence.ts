/** Must be part of the SAME atomic D1 batch as the owner mutation, not a prior read. */
export function ownerWriteFenceStatement(database: D1Database, route: {
  ownerId: string; shardId: string; generation: number;
}): D1PreparedStatement {
  return database.prepare(`INSERT INTO storage_route_write_checks (owner_id, shard_id, route_generation)
    VALUES (?, ?, ?)`).bind(route.ownerId, route.shardId, route.generation);
}
