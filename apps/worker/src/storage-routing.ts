import { ownerWriteFenceStatement } from './storage-routing-fence';
import { MAX_STORAGE_APPLICATION_STATEMENTS } from './storage-routing-batch-budget';

export const STORAGE_SHARD_OPERATING_CAP_BYTES = 9_000_000_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const BINDING = /^[A-Z][A-Z0-9_]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;
export class StorageRoutingError extends Error {
  constructor(readonly code: 'ROUTE_NOT_FOUND' | 'ROUTE_NOT_ACTIVE' | 'ROUTE_STALE' | 'UNKNOWN_BINDING'
    | 'INVALID_ROUTING_INPUT' | 'CAPACITY_UNAVAILABLE' | 'MOVE_CONFLICT' | 'MOVE_PHASE_INVALID'
    | 'COPY_VERIFICATION_REQUIRED' | 'STORAGE_UNAVAILABLE') { super(code); this.name = 'StorageRoutingError'; }
}
function fail(code: StorageRoutingError['code']): never { throw new StorageRoutingError(code); }
function identifier(value: string) { if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_ROUTING_INPUT'); }
function digest(value: string) { if (typeof value !== 'string' || !DIGEST.test(value)) fail('INVALID_ROUTING_INPUT'); }
function integer(value: number, min = 1, max = Number.MAX_SAFE_INTEGER - 1) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_ROUTING_INPUT');
}
function now(clock: () => number) { const value = clock(); integer(value, 0); return value; }
async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof StorageRoutingError) throw error;
    // Provider messages can contain SQL/identifiers; only closed codes cross this boundary.
    const message = error instanceof Error ? error.message : '';
    if (message.includes('STORAGE_CAPACITY_UNAVAILABLE')) fail('CAPACITY_UNAVAILABLE');
    if (message.includes('STORAGE_ROUTE_STALE')) fail('ROUTE_STALE');
    fail('STORAGE_UNAVAILABLE');
  }
}
export interface OwnerStorageRoute {
  readonly ownerId: string;
  readonly shardId: string;
  readonly bindingName: string;
  readonly generation: number;
  readonly mode: 'single' | 'catalog';
}
interface RouteRow { owner_id: string; shard_id: string; route_generation: number;
  state: 'preparing' | 'active' | 'moving'; reservation_bytes: number; binding_name: string; shard_state: string; }
interface ShardRow { shard_id: string; binding_name: string; state: string; }
interface FenceRow { owner_id: string; shard_id: string; route_generation: number;
  state: 'active' | 'prepared' | 'fenced'; move_id: string | null; copy_digest: string | null; }
export type StorageShardBindings = Readonly<Record<string, D1Database>>;
export type OwnerStorageStatementBuilder = (database: D1Database) =>
  D1PreparedStatement[] | Promise<D1PreparedStatement[]>;
export interface OwnerStorageRouter {
  resolve(ownerId: string): Promise<OwnerStorageRoute>;
  write<T = unknown>(route: OwnerStorageRoute, statements: OwnerStorageStatementBuilder): Promise<D1Result<T>[]>;
}
async function statementsFor(database: D1Database, build: OwnerStorageStatementBuilder) {
  const statements = await build(database);
  if (!Array.isArray(statements) || !statements.length || statements.length > MAX_STORAGE_APPLICATION_STATEMENTS) fail('INVALID_ROUTING_INPUT');
  return statements;
}
/** Compatibility adapter only: no new schema, capacity claims or move support.
 * Existing authentication remains mandatory; a route is never authorization. */
export function createSingleIngestionShardRouter({ database }: { database: D1Database }): OwnerStorageRouter {
  return {
    async resolve(ownerId) { identifier(ownerId); return Object.freeze({ ownerId, shardId: 'primary',
      bindingName: 'USAGE_MONITOR_DB', generation: 0, mode: 'single' as const }); },
    async write<T>(route: OwnerStorageRoute, build: OwnerStorageStatementBuilder) {
      identifier(route.ownerId);
      if (route.mode !== 'single' || route.shardId !== 'primary' || route.bindingName !== 'USAGE_MONITOR_DB' || route.generation !== 0) fail('ROUTE_STALE');
      return database.batch<T>(await statementsFor(database, build));
    },
  };
}
function binding(bindings: StorageShardBindings, name: string): D1Database {
  if (!BINDING.test(name) || !Object.hasOwn(bindings, name) || !bindings[name]) fail('UNKNOWN_BINDING');
  return bindings[name];
}
async function readRoute(catalog: D1Database, ownerId: string): Promise<RouteRow | null> {
  identifier(ownerId);
  return storage(() => catalog.prepare(`SELECT r.owner_id, r.shard_id, r.route_generation, r.state,
    r.reservation_bytes, s.binding_name, s.state AS shard_state FROM storage_owner_routes r
    JOIN storage_shards s ON s.shard_id = r.shard_id WHERE r.owner_id = ? LIMIT 1`).bind(ownerId).first<RouteRow>());
}
async function readShard(catalog: D1Database, shardId: string) {
  identifier(shardId); const shard = await storage(() => catalog.prepare('SELECT shard_id, binding_name, state FROM storage_shards WHERE shard_id = ? LIMIT 1').bind(shardId).first<ShardRow>());
  if (!shard) fail('UNKNOWN_BINDING'); return shard;
}
async function readFence(database: D1Database, ownerId: string) {
  return storage(() => database.prepare('SELECT owner_id, shard_id, route_generation, state, move_id, copy_digest FROM storage_owner_fences WHERE owner_id = ? LIMIT 1').bind(ownerId).first<FenceRow>());
}
function matches(route: OwnerStorageRoute, row: RouteRow) {
  return route.mode === 'catalog' && row.state === 'active' && row.shard_state !== 'offline'
    && route.ownerId === row.owner_id && route.shardId === row.shard_id
    && route.bindingName === row.binding_name && route.generation === row.route_generation;
}
function activeRoute(row: RouteRow | null, bindings: StorageShardBindings): OwnerStorageRoute {
  if (!row) fail('ROUTE_NOT_FOUND');
  if (row.state !== 'active' || row.shard_state === 'offline') fail('ROUTE_NOT_ACTIVE');
  binding(bindings, row.binding_name);
  return Object.freeze({ ownerId: row.owner_id, shardId: row.shard_id, bindingName: row.binding_name,
    generation: row.route_generation, mode: 'catalog' as const });
}
export function createCatalogStorageRouter({ catalog, bindings, clock }: {
  catalog: D1Database; bindings: StorageShardBindings; clock: () => number;
}) {
  return {
    async resolve(ownerId: string) { return activeRoute(await readRoute(catalog, ownerId), bindings); },
    /** Caller supplies an explicit admitted shard. Capacity failure never redirects elsewhere. */
    async ensureOwner(ownerId: string, shardId: string, reservationBytes: number) {
      identifier(ownerId); integer(reservationBytes, 1, STORAGE_SHARD_OPERATING_CAP_BYTES);
      const shard = await readShard(catalog, shardId); const database = binding(bindings, shard.binding_name);
      let row = await readRoute(catalog, ownerId);
      if (!row) {
        await storage(() => catalog.prepare(`INSERT INTO storage_owner_routes
          (owner_id, shard_id, route_generation, state, reservation_bytes, updated_at)
          SELECT ?, ?, 1, 'preparing', ?, ? WHERE NOT EXISTS
          (SELECT 1 FROM storage_owner_routes WHERE owner_id = ?)`)
          .bind(ownerId, shardId, reservationBytes, now(clock), ownerId).run());
        row = await readRoute(catalog, ownerId);
      }
      if (!row || row.shard_id !== shardId || row.reservation_bytes !== reservationBytes) fail('ROUTE_STALE');
      if (row.state === 'preparing') {
        // This is a separate database operation. A failure leaves the catalog preparing;
        // exact repeated enrollment resumes it, with its original reservation retained.
        await storage(() => database.prepare(`INSERT INTO storage_owner_fences
          (owner_id, shard_id, route_generation, state) VALUES (?, ?, ?, 'active') ON CONFLICT(owner_id) DO NOTHING`)
          .bind(ownerId, shardId, row.route_generation).run());
        const fence = await readFence(database, ownerId);
        if (!fence || fence.state !== 'active' || fence.shard_id !== shardId || fence.route_generation !== row.route_generation || fence.move_id !== null) fail('ROUTE_STALE');
        await storage(() => catalog.prepare(`UPDATE storage_owner_routes SET state = 'active', updated_at = ?
          WHERE owner_id = ? AND shard_id = ? AND route_generation = ? AND state = 'preparing'`)
          .bind(now(clock), ownerId, shardId, row.route_generation).run());
      }
      return activeRoute(await readRoute(catalog, ownerId), bindings);
    },
    /** A hash locator narrows an authentication lookup; it grants no authority. */
    async locateCapability(capabilityHash: string): Promise<OwnerStorageRoute | null> {
      digest(capabilityHash);
      const locator = await storage(() => catalog.prepare(`SELECT owner_id FROM storage_capability_locators
        WHERE capability_hash = ? AND state = 'active' LIMIT 1`).bind(capabilityHash).first<{owner_id: string}>());
      return locator ? activeRoute(await readRoute(catalog, locator.owner_id), bindings) : null;
    },
    async write<T = unknown>(route: OwnerStorageRoute, build: OwnerStorageStatementBuilder): Promise<D1Result<T>[]> {
      // Keep the checked identity fixed across asynchronous preparation.
      const expected = Object.freeze({...route});
      identifier(expected.ownerId); integer(expected.generation);
      const row = await readRoute(catalog, expected.ownerId);
      if (!row || !matches(expected, row)) fail('ROUTE_STALE');
      const database = binding(bindings, row.binding_name);
      // Catalog read alone cannot fence a racing move. The source-local guard
      // precedes every mutation inside D1's same-database atomic batch.
      const statements = await storage(() => statementsFor(database, build));
      const result = await storage(() => database.batch<T>([ownerWriteFenceStatement(database, expected), ...statements]));
      return result.slice(1);
    },
  };
}

export interface OwnerMove {
  move_id: string; owner_id: string; source_shard_id: string; destination_shard_id: string;
  source_generation: number; destination_generation: number; reservation_bytes: number;
  state: 'prepared' | 'source_fenced' | 'copied' | 'committed'; copy_digest: string | null;
}
/** Trusted operational boundary, not a request DTO or a `verified:true` flag.
 * The verifier must compare exact typed retained owner rows in both shards and
 * return their digest; it must not change routing/fences. No copy/delete is
 * hidden here. Operators retain source bytes until separately approved cleanup. */
export type VerifyOwnerCopy = (input: Readonly<{ move: Readonly<OwnerMove>;
  source: D1Database; destination: D1Database }>) => Promise<string>;
export function createOwnerMoveCoordinator({ catalog, bindings, clock, verifyDestinationCopy }: {
  catalog: D1Database; bindings: StorageShardBindings; clock: () => number;
  verifyDestinationCopy: VerifyOwnerCopy;
}) {
  async function move(id: string) {
    identifier(id); const value = await storage(() => catalog.prepare(`SELECT move_id, owner_id, source_shard_id,
      destination_shard_id, source_generation, destination_generation, reservation_bytes, state, copy_digest
      FROM storage_owner_moves WHERE move_id = ? LIMIT 1`).bind(id).first<OwnerMove>());
    if (!value) fail('MOVE_CONFLICT'); return value;
  }
  async function endpoints(m: OwnerMove) {
    const source = binding(bindings, (await readShard(catalog, m.source_shard_id)).binding_name);
    const destination = binding(bindings, (await readShard(catalog, m.destination_shard_id)).binding_name);
    if (source === destination) fail('MOVE_CONFLICT');
    return { source, destination };
  }
  async function sourceFenced(m: OwnerMove, database: D1Database) {
    const f = await readFence(database, m.owner_id);
    if (!f || f.state !== 'fenced' || f.move_id !== m.move_id || f.shard_id !== m.source_shard_id || f.route_generation !== m.source_generation) fail('ROUTE_STALE');
  }
  async function copied(m: OwnerMove, database: D1Database) {
    const f = await readFence(database, m.owner_id);
    if (!f || !['prepared', 'active'].includes(f.state) || f.move_id !== m.move_id
      || f.shard_id !== m.destination_shard_id || f.route_generation !== m.destination_generation
      || !m.copy_digest || f.copy_digest !== m.copy_digest) fail('COPY_VERIFICATION_REQUIRED');
    return f;
  }
  return {
    async begin(moveId: string, route: OwnerStorageRoute, destinationShardId: string): Promise<OwnerMove> {
      identifier(moveId); identifier(destinationShardId); identifier(route.ownerId); integer(route.generation, 1, Number.MAX_SAFE_INTEGER - 2);
      if (route.shardId === destinationShardId) fail('MOVE_CONFLICT');
      // A repeat is allowed only for the same immutable move identity.
      const existing = await storage(() => catalog.prepare('SELECT move_id FROM storage_owner_moves WHERE move_id = ? LIMIT 1').bind(moveId).first());
      if (existing) { const m = await move(moveId); if (m.owner_id !== route.ownerId || m.source_shard_id !== route.shardId
        || m.source_generation !== route.generation || m.destination_shard_id !== destinationShardId) fail('MOVE_CONFLICT'); return m; }
      const current = await readRoute(catalog, route.ownerId);
      if (!current || !matches(route, current)) fail('ROUTE_STALE');
      const sourceDatabase = binding(bindings, current.binding_name);
      const sourceFence = await readFence(sourceDatabase, route.ownerId);
      if (!sourceFence || sourceFence.state !== 'active' || sourceFence.shard_id !== route.shardId
        || sourceFence.route_generation !== route.generation) fail('ROUTE_STALE');
      const dest = await readShard(catalog, destinationShardId);
      if (sourceDatabase === binding(bindings, dest.binding_name)) fail('MOVE_CONFLICT');
      await storage(() => catalog.prepare(`INSERT INTO storage_owner_moves
        (move_id, owner_id, source_shard_id, destination_shard_id, source_generation, destination_generation,
         reservation_bytes, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?)`)
        .bind(moveId, route.ownerId, route.shardId, destinationShardId, route.generation,
          route.generation + 1, current.reservation_bytes, now(clock)).run());
      return move(moveId);
    },
    async fenceSource(id: string): Promise<OwnerMove> {
      const m = await move(id); const { source } = await endpoints(m);
      if (m.state !== 'prepared') { await sourceFenced(m, source); return m; }
      await storage(() => source.prepare(`UPDATE storage_owner_fences SET state = 'fenced', move_id = ?
        WHERE owner_id = ? AND shard_id = ? AND route_generation = ? AND state = 'active'`)
        .bind(id, m.owner_id, m.source_shard_id, m.source_generation).run());
      await sourceFenced(m, source);
      await storage(() => catalog.prepare(`UPDATE storage_owner_moves SET state = 'source_fenced', updated_at = ?
        WHERE move_id = ? AND state = 'prepared'`).bind(now(clock), id).run());
      return move(id);
    },
    async verifyCopied(id: string): Promise<OwnerMove> {
      const m = await move(id); const { source, destination } = await endpoints(m);
      await sourceFenced(m, source);
      if (m.state === 'copied' || m.state === 'committed') { await copied(m, destination); return m; }
      if (m.state !== 'source_fenced') fail('MOVE_PHASE_INVALID');
      if (typeof verifyDestinationCopy !== 'function') fail('COPY_VERIFICATION_REQUIRED');
      let proof: string;
      try { proof = await verifyDestinationCopy({ move: Object.freeze({ ...m }), source, destination }); }
      catch { fail('COPY_VERIFICATION_REQUIRED'); }
      if (!DIGEST.test(proof)) fail('COPY_VERIFICATION_REQUIRED');
      await sourceFenced(m, source);
      await storage(() => destination.prepare(`INSERT INTO storage_owner_fences
        (owner_id, shard_id, route_generation, state, move_id, copy_digest)
        VALUES (?, ?, ?, 'prepared', ?, ?) ON CONFLICT(owner_id) DO NOTHING`)
        .bind(m.owner_id, m.destination_shard_id, m.destination_generation, m.move_id, proof).run());
      if ((await copied({ ...m, copy_digest: proof }, destination)).state !== 'prepared') fail('COPY_VERIFICATION_REQUIRED');
      await storage(() => catalog.prepare(`UPDATE storage_owner_moves SET state = 'copied', copy_digest = ?, updated_at = ?
        WHERE move_id = ? AND state = 'source_fenced'`).bind(proof, now(clock), id).run());
      return move(id);
    },
    async commit(id: string): Promise<OwnerMove> {
      const m = await move(id); const { source, destination } = await endpoints(m);
      await sourceFenced(m, source); const destinationFence = await copied(m, destination);
      if (m.state === 'committed') return m;
      if (destinationFence.state !== 'prepared') fail('COPY_VERIFICATION_REQUIRED');
      if (m.state !== 'copied') fail('MOVE_PHASE_INVALID');
      await storage(() => catalog.batch([
        catalog.prepare(`UPDATE storage_owner_moves SET state = 'committed', updated_at = ? WHERE move_id = ? AND state = 'copied'
          AND EXISTS (SELECT 1 FROM storage_owner_routes WHERE owner_id = ? AND state = 'moving' AND shard_id = ? AND route_generation = ?)`)
          .bind(now(clock), id, m.owner_id, m.source_shard_id, m.source_generation),
        catalog.prepare(`UPDATE storage_owner_routes SET shard_id = ?, route_generation = ?, state = 'active', updated_at = ?
          WHERE owner_id = ? AND state = 'moving' AND shard_id = ? AND route_generation = ?
          AND EXISTS (SELECT 1 FROM storage_owner_moves WHERE move_id = ? AND state = 'committed')`)
          .bind(m.destination_shard_id, m.destination_generation, now(clock), m.owner_id, m.source_shard_id, m.source_generation, id),
      ]));
      const result = await move(id); if (result.state !== 'committed') fail('ROUTE_STALE'); return result;
    },
    async activateDestination(id: string): Promise<OwnerStorageRoute> {
      const m = await move(id); if (m.state !== 'committed') fail('MOVE_PHASE_INVALID');
      const { source, destination } = await endpoints(m); await sourceFenced(m, source); await copied(m, destination);
      const route = activeRoute(await readRoute(catalog, m.owner_id), bindings);
      if (route.shardId !== m.destination_shard_id || route.generation !== m.destination_generation) fail('ROUTE_STALE');
      await storage(() => destination.prepare(`UPDATE storage_owner_fences SET state = 'active'
        WHERE owner_id = ? AND shard_id = ? AND route_generation = ? AND move_id = ? AND copy_digest = ? AND state = 'prepared'`)
        .bind(m.owner_id, m.destination_shard_id, m.destination_generation, id, m.copy_digest).run());
      const f = await copied(m, destination); if (f.state !== 'active') fail('ROUTE_STALE'); return route;
    },
  };
}
