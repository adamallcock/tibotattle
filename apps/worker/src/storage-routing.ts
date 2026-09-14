import { ownerWriteFenceStatement } from './storage-routing-fence';
import { MAX_STORAGE_APPLICATION_STATEMENTS } from './storage-routing-batch-budget';
import { sha256Hex } from './crypto';

export const STORAGE_SHARD_OPERATING_CAP_BYTES = 9_000_000_000;
export const STORAGE_NEW_OWNER_CUTOFF_BYTES = 6_000_000_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const BINDING = /^[A-Z][A-Z0-9_]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;
export class StorageRoutingError extends Error {
  constructor(readonly code: 'ROUTE_NOT_FOUND' | 'ROUTE_NOT_ACTIVE' | 'ROUTE_STALE' | 'UNKNOWN_BINDING'
    | 'INVALID_ROUTING_INPUT' | 'CAPACITY_UNAVAILABLE' | 'MOVE_CONFLICT' | 'MOVE_PHASE_INVALID'
    | 'COPY_VERIFICATION_REQUIRED' | 'ISSUANCE_LIMIT_REACHED' | 'ENROLLMENT_CONFLICT'
    | 'ISSUANCE_UNINITIALIZED' | 'STORAGE_UNAVAILABLE') { super(code); this.name = 'StorageRoutingError'; }
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
    if (message.includes('STORAGE_ACCOUNTLESS_ISSUANCE_LIMIT')) fail('ISSUANCE_LIMIT_REACHED');
    if (message.includes('STORAGE_ACCOUNTLESS_ENROLLMENT_CONFLICT')) fail('ENROLLMENT_CONFLICT');
    if (message.includes('STORAGE_ACCOUNTLESS_ISSUANCE_UNINITIALIZED')) fail('ISSUANCE_UNINITIALIZED');
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
export interface OwnerStorageTarget {
  readonly ownerId: string;
  readonly shardId: string;
  readonly bindingName: string;
  readonly generations: readonly number[];
  readonly current: boolean;
}
export interface ActiveOwnerRouteSnapshot {
  readonly catalogEpoch: number;
  readonly routes: readonly OwnerStorageRoute[];
  readonly bounded: boolean;
  readonly nextAfterOwnerId: string | null;
}
export interface AccountlessIssuanceReservation {
  readonly reservationKey: string;
  readonly ownerId: string;
  readonly deviceDigest: string;
  readonly budgetDay: string;
  readonly reservedAt: number;
}
export interface AccountlessOwnerAllocation {
  readonly route: OwnerStorageRoute;
  readonly issuanceReservation: AccountlessIssuanceReservation;
}
interface RouteRow { owner_id: string; shard_id: string; route_generation: number;
  state: 'preparing' | 'active' | 'moving'; reservation_bytes: number; binding_name: string; shard_state: string; }
interface ShardRow { shard_id: string; binding_name: string; state: string; }
interface FenceRow { owner_id: string; shard_id: string; route_generation: number;
  state: 'active' | 'prepared' | 'fenced'; move_id: string | null; copy_digest: string | null; }
interface AccountlessIssuanceRow {
  reservation_key: string; owner_id: string; device_digest: string;
  budget_day: string; reserved_at: number;
}
interface HistoricalIssuanceStateRow {
  import_state: 'importing' | 'ready'; imported_count: number; import_revision: number;
  roster_digest: string | null; baseline_budget_day: string | null;
  baseline_daily_reserved: number | null; baseline_lifetime_reserved: number | null;
  baseline_digest: string | null; baseline_initialized_at: number | null;
}
export type StorageShardBindings = Readonly<Record<string, D1Database>>;
export type OwnerStorageStatementBuilder = (database: D1Database) =>
  D1PreparedStatement[] | Promise<D1PreparedStatement[]>;
export interface OwnerStorageRouter {
  resolve(ownerId: string): Promise<OwnerStorageRoute>;
  database(route: OwnerStorageRoute): Promise<D1Database>;
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
    async database(route) {
      identifier(route.ownerId);
      if (route.mode !== 'single' || route.shardId !== 'primary' || route.bindingName !== 'USAGE_MONITOR_DB' || route.generation !== 0) fail('ROUTE_STALE');
      return database;
    },
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
async function assertShardRoutingSchema(database: D1Database): Promise<void> {
  const rows = await storage(() => database.prepare(`SELECT name FROM sqlite_schema
    WHERE name IN ('storage_owner_fences','storage_route_write_checks',
      'storage_route_write_guard','storage_route_write_check_cleanup')
    ORDER BY name`).all<{name: string}>());
  if (rows.results.map((row) => row.name).join(',') !== [
    'storage_owner_fences',
    'storage_route_write_check_cleanup',
    'storage_route_write_checks',
    'storage_route_write_guard',
  ].join(',')) fail('STORAGE_UNAVAILABLE');
}
async function assertAccountlessIssuanceSchema(catalog: D1Database): Promise<void> {
  const rows = await storage(() => catalog.prepare(`SELECT name FROM sqlite_schema
    WHERE name IN ('storage_accountless_issuance_state',
      'storage_accountless_issuance_reservations',
      'storage_accountless_issuance_reserve',
      'storage_accountless_issuance_requires_baseline',
      'storage_accountless_issuance_device_conflict',
      'storage_accountless_issuance_reservation_immutable',
      'storage_accountless_issuance_reservation_no_delete',
      'storage_accountless_issuance_historical_conflict',
      'storage_accountless_historical_issuance_state',
      'storage_accountless_historical_issuance_reservations',
      'storage_accountless_historical_issuance_import_gate',
      'storage_accountless_historical_issuance_conflict',
      'storage_accountless_historical_issuance_current_conflict',
      'storage_accountless_historical_issuance_count',
      'storage_accountless_historical_issuance_state_transition',
      'storage_accountless_historical_issuance_state_no_delete',
      'storage_accountless_historical_issuance_finalize',
      'storage_accountless_historical_issuance_immutable',
      'storage_accountless_historical_issuance_no_delete')
    ORDER BY name`).all<{name: string}>());
  if (rows.results.map((row) => row.name).join(',') !== [
    'storage_accountless_historical_issuance_conflict',
    'storage_accountless_historical_issuance_count',
    'storage_accountless_historical_issuance_current_conflict',
    'storage_accountless_historical_issuance_finalize',
    'storage_accountless_historical_issuance_immutable',
    'storage_accountless_historical_issuance_import_gate',
    'storage_accountless_historical_issuance_no_delete',
    'storage_accountless_historical_issuance_reservations',
    'storage_accountless_historical_issuance_state',
    'storage_accountless_historical_issuance_state_no_delete',
    'storage_accountless_historical_issuance_state_transition',
    'storage_accountless_issuance_device_conflict',
    'storage_accountless_issuance_historical_conflict',
    'storage_accountless_issuance_requires_baseline',
    'storage_accountless_issuance_reservation_immutable',
    'storage_accountless_issuance_reservation_no_delete',
    'storage_accountless_issuance_reservations',
    'storage_accountless_issuance_reserve',
    'storage_accountless_issuance_state',
  ].join(',')) fail('STORAGE_UNAVAILABLE');
}
export interface AccountlessIssuanceBaseline {
  readonly budgetDay: string;
  readonly dailyReserved: number;
  readonly lifetimeReserved: number;
  readonly baselineDigest: string;
  readonly initializedAt: number;
}
export interface HistoricalAccountlessIssuanceReservation extends AccountlessIssuanceReservation {}
export interface HistoricalAccountlessIssuanceBaseline extends AccountlessIssuanceBaseline {
  readonly historicalRosterCount: number;
  readonly historicalRosterDigest: string;
}
function validateIssuanceBaseline(baseline: AccountlessIssuanceBaseline): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(baseline.budgetDay)
      || !Number.isSafeInteger(baseline.dailyReserved)
      || baseline.dailyReserved < 0 || baseline.dailyReserved > 1_000
      || !Number.isSafeInteger(baseline.lifetimeReserved)
      || baseline.lifetimeReserved < 0 || baseline.lifetimeReserved > 10_000
      || baseline.dailyReserved > baseline.lifetimeReserved
      || !DIGEST.test(baseline.baselineDigest)
      || !Number.isSafeInteger(baseline.initializedAt) || baseline.initializedAt < 0) {
    fail('INVALID_ROUTING_INPUT');
  }
}
function validateHistoricalReservation(input: HistoricalAccountlessIssuanceReservation): void {
  digest(input.reservationKey); identifier(input.ownerId); digest(input.deviceDigest);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.budgetDay)
      || !Number.isSafeInteger(input.reservedAt) || input.reservedAt < 0) {
    fail('INVALID_ROUTING_INPUT');
  }
}
/** Canonical content-free roster commitment for a trusted, bounded import manifest. */
export async function historicalAccountlessIssuanceRosterDigest(
  reservations: readonly HistoricalAccountlessIssuanceReservation[],
): Promise<string> {
  if (!Array.isArray(reservations) || reservations.length > 10_000) fail('INVALID_ROUTING_INPUT');
  const seenKeys = new Set<string>(); const seenOwners = new Set<string>(); const seenDevices = new Set<string>();
  const ordered = reservations.map((row) => {
    validateHistoricalReservation(row);
    if (seenKeys.has(row.reservationKey) || seenOwners.has(row.ownerId)
        || seenDevices.has(row.deviceDigest)) fail('INVALID_ROUTING_INPUT');
    seenKeys.add(row.reservationKey); seenOwners.add(row.ownerId); seenDevices.add(row.deviceDigest);
    return [row.reservationKey, row.ownerId, row.deviceDigest, row.budgetDay, row.reservedAt] as const;
  }).sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  return sha256Hex(`app-usagemonitor/storage-accountless-historical-issuance-roster/v1\0${JSON.stringify(ordered)}`);
}
function historicalRow(row: AccountlessIssuanceRow | null | undefined): HistoricalAccountlessIssuanceReservation {
  if (!row) fail('STORAGE_UNAVAILABLE');
  const value = Object.freeze({ reservationKey: row.reservation_key, ownerId: row.owner_id,
    deviceDigest: row.device_digest, budgetDay: row.budget_day, reservedAt: row.reserved_at });
  validateHistoricalReservation(value);
  return value;
}
function sameHistoricalReservation(
  row: AccountlessIssuanceRow | null | undefined,
  input: HistoricalAccountlessIssuanceReservation,
): boolean {
  return row?.reservation_key === input.reservationKey && row.owner_id === input.ownerId
    && row.device_digest === input.deviceDigest && row.budget_day === input.budgetDay
    && row.reserved_at === input.reservedAt;
}
/** Trusted private import seam. It creates the exact locator and immutable
 * historical reservation together, and never advances issuance counters. */
export async function importHistoricalAccountlessIssuanceReservation(
  catalog: D1Database,
  input: HistoricalAccountlessIssuanceReservation,
): Promise<HistoricalAccountlessIssuanceReservation> {
  validateHistoricalReservation(input);
  await assertAccountlessIssuanceSchema(catalog);
  const collisions = await storage(() => catalog.batch<AccountlessIssuanceRow>([
    catalog.prepare(`SELECT reservation_key,owner_id,device_digest,budget_day,reserved_at
      FROM storage_accountless_historical_issuance_reservations
      WHERE reservation_key=? OR owner_id=? OR device_digest=? LIMIT 2`)
      .bind(input.reservationKey, input.ownerId, input.deviceDigest),
    catalog.prepare(`SELECT reservation_key,owner_id,device_digest,budget_day,reserved_at
      FROM storage_accountless_issuance_reservations
      WHERE reservation_key=? OR owner_id=? OR device_digest=? LIMIT 1`)
      .bind(input.reservationKey, input.ownerId, input.deviceDigest),
  ]));
  const historical = collisions[0]?.results ?? [];
  if (historical.length === 1 && sameHistoricalReservation(historical[0], input)
      && (collisions[1]?.results.length ?? 0) === 0) {
    const locator = await storage(() => catalog.prepare(`SELECT owner_id FROM storage_capability_locators
      WHERE capability_hash=? LIMIT 1`).bind(input.reservationKey).first<{owner_id: string}>());
    if (locator?.owner_id !== input.ownerId) fail('STORAGE_UNAVAILABLE');
    return historicalRow(historical[0]);
  }
  if (historical.length > 0 || (collisions[1]?.results.length ?? 0) > 0) fail('ENROLLMENT_CONFLICT');
  await storage(() => catalog.batch([
    catalog.prepare(`INSERT INTO storage_capability_locators (capability_hash,owner_id,state)
      SELECT ?,?,'active' WHERE NOT EXISTS (SELECT 1 FROM storage_capability_locators
        WHERE capability_hash=? AND owner_id<>?)
      ON CONFLICT(capability_hash) DO NOTHING`)
      .bind(input.reservationKey, input.ownerId, input.reservationKey, input.ownerId),
    catalog.prepare(`INSERT INTO storage_accountless_historical_issuance_reservations
      (reservation_key,owner_id,device_digest,budget_day,reserved_at)
      SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM storage_capability_locators
        WHERE capability_hash=? AND owner_id=?)
      ON CONFLICT(reservation_key) DO NOTHING`)
      .bind(input.reservationKey, input.ownerId, input.deviceDigest, input.budgetDay,
        input.reservedAt, input.reservationKey, input.ownerId),
  ]));
  const results = await storage(() => catalog.batch<AccountlessIssuanceRow>([
    catalog.prepare(`SELECT reservation_key,owner_id,device_digest,budget_day,reserved_at
      FROM storage_accountless_historical_issuance_reservations
      WHERE reservation_key=? OR owner_id=? OR device_digest=? LIMIT 2`)
      .bind(input.reservationKey, input.ownerId, input.deviceDigest),
    catalog.prepare(`SELECT reservation_key,owner_id,device_digest,budget_day,reserved_at
      FROM storage_accountless_issuance_reservations
      WHERE reservation_key=? OR owner_id=? OR device_digest=? LIMIT 1`)
      .bind(input.reservationKey, input.ownerId, input.deviceDigest),
  ]));
  const admitted = results[0]?.results ?? [];
  if (admitted.length !== 1 || !sameHistoricalReservation(admitted[0], input)
      || (results[1]?.results.length ?? 0) !== 0) fail('ENROLLMENT_CONFLICT');
  const locator = await storage(() => catalog.prepare(`SELECT owner_id FROM storage_capability_locators
    WHERE capability_hash=? LIMIT 1`).bind(input.reservationKey).first<{owner_id: string}>());
  if (locator?.owner_id !== input.ownerId) fail('STORAGE_UNAVAILABLE');
  return historicalRow(admitted[0]);
}

function sameHistoricalBaseline(row: HistoricalIssuanceStateRow,
  baseline: HistoricalAccountlessIssuanceBaseline): boolean {
  return row.import_state === 'ready'
    && row.imported_count === baseline.historicalRosterCount
    && row.import_revision === baseline.historicalRosterCount
    && row.roster_digest === baseline.historicalRosterDigest
    && row.baseline_budget_day === baseline.budgetDay
    && row.baseline_daily_reserved === baseline.dailyReserved
    && row.baseline_lifetime_reserved === baseline.lifetimeReserved
    && row.baseline_digest === baseline.baselineDigest
    && row.baseline_initialized_at === baseline.initializedAt;
}
async function readHistoricalState(catalog: D1Database): Promise<HistoricalIssuanceStateRow> {
  const row = await storage(() => catalog.prepare(`SELECT import_state,imported_count,import_revision,
    roster_digest,baseline_budget_day,baseline_daily_reserved,baseline_lifetime_reserved,
    baseline_digest,baseline_initialized_at FROM storage_accountless_historical_issuance_state
    WHERE singleton_id=1`).first<HistoricalIssuanceStateRow>());
  if (!row) fail('STORAGE_UNAVAILABLE');
  return row;
}
/** Trusted one-way activation seam. Aggregate counters and the retained roster
 * are independent manifest facts; neither is inferred from the other. */
export async function finalizeAccountlessIssuanceBaseline(
  catalog: D1Database,
  baseline: HistoricalAccountlessIssuanceBaseline,
): Promise<void> {
  validateIssuanceBaseline(baseline);
  integer(baseline.historicalRosterCount, 0, 10_000);
  digest(baseline.historicalRosterDigest);
  await assertAccountlessIssuanceSchema(catalog);
  const initial = await readHistoricalState(catalog);
  if (initial.import_state === 'ready') {
    if (!sameHistoricalBaseline(initial, baseline)) fail('STORAGE_UNAVAILABLE');
    return;
  }
  if (initial.imported_count !== baseline.historicalRosterCount
      || initial.import_revision !== baseline.historicalRosterCount) fail('STORAGE_UNAVAILABLE');
  const roster: HistoricalAccountlessIssuanceReservation[] = [];
  let cursor = '';
  for (let page = 0; page < 41; page += 1) {
    const result = await storage(() => catalog.prepare(`SELECT reservation_key,owner_id,device_digest,
      budget_day,reserved_at FROM storage_accountless_historical_issuance_reservations
      WHERE reservation_key>? ORDER BY reservation_key LIMIT 250`).bind(cursor).all<AccountlessIssuanceRow>());
    for (const row of result.results) roster.push(historicalRow(row));
    if (result.results.length < 250) break;
    cursor = result.results.at(-1)!.reservation_key;
    if (page === 40) fail('STORAGE_UNAVAILABLE');
  }
  const stable = await readHistoricalState(catalog);
  if (stable.import_state !== 'importing' || stable.imported_count !== initial.imported_count
      || stable.import_revision !== initial.import_revision || roster.length !== initial.imported_count
      || await historicalAccountlessIssuanceRosterDigest(roster) !== baseline.historicalRosterDigest) {
    fail('STORAGE_UNAVAILABLE');
  }
  const retained = await storage(() => catalog.prepare(`SELECT COUNT(*) AS total_reserved,
    COALESCE(SUM(CASE WHEN budget_day=? THEN 1 ELSE 0 END),0) AS day_reserved FROM (
      SELECT budget_day FROM storage_accountless_historical_issuance_reservations
      UNION ALL SELECT budget_day FROM storage_accountless_issuance_reservations
    )`).bind(baseline.budgetDay).first<{total_reserved: number; day_reserved: number}>());
  if (!retained || !Number.isSafeInteger(retained.total_reserved)
      || !Number.isSafeInteger(retained.day_reserved)
      || retained.total_reserved < 0 || retained.day_reserved < 0
      || baseline.lifetimeReserved < retained.total_reserved
      || baseline.dailyReserved < retained.day_reserved) fail('STORAGE_UNAVAILABLE');
  const updated = await storage(() => catalog.prepare(`UPDATE storage_accountless_historical_issuance_state
    SET import_state='ready',roster_digest=?,baseline_budget_day=?,baseline_daily_reserved=?,
      baseline_lifetime_reserved=?,baseline_digest=?,baseline_initialized_at=?,updated_at=?
    WHERE singleton_id=1 AND import_state='importing' AND imported_count=? AND import_revision=?
    RETURNING import_state,imported_count,import_revision,roster_digest,baseline_budget_day,
      baseline_daily_reserved,baseline_lifetime_reserved,baseline_digest,baseline_initialized_at`)
    .bind(baseline.historicalRosterDigest, baseline.budgetDay, baseline.dailyReserved,
      baseline.lifetimeReserved, baseline.baselineDigest, baseline.initializedAt,
      baseline.initializedAt, initial.imported_count, initial.import_revision)
    .first<HistoricalIssuanceStateRow>());
  if (!updated || !sameHistoricalBaseline(updated, baseline)) fail('STORAGE_UNAVAILABLE');
}

/** Compatibility helper for fresh synthetic catalogs with an empty historical roster. */
export async function initializeAccountlessIssuanceBaseline(
  catalog: D1Database,
  baseline: AccountlessIssuanceBaseline,
): Promise<void> {
  await finalizeAccountlessIssuanceBaseline(catalog, {
    ...baseline,
    historicalRosterCount: 0,
    historicalRosterDigest: await historicalAccountlessIssuanceRosterDigest([]),
  });
}

async function assertAccountlessIssuanceReady(catalog: D1Database): Promise<void> {
  const row = await storage(() => catalog.prepare(`SELECT 1 AS ready
    FROM storage_accountless_issuance_state issuance
    JOIN storage_accountless_historical_issuance_state history
      ON history.singleton_id=issuance.singleton_id
    WHERE issuance.singleton_id=1 AND issuance.initialization_state='ready'
      AND history.import_state='ready'`).first<{ready: number}>());
  if (row?.ready !== 1) fail('ISSUANCE_UNINITIALIZED');
}
async function readIssuanceReservations(catalog: D1Database,
  reservationKey: string, deviceDigest: string): Promise<AccountlessIssuanceRow[]> {
  const result = await storage(() => catalog.prepare(`SELECT reservation_key,owner_id,device_digest,
    budget_day,reserved_at FROM storage_accountless_issuance_reservations
    WHERE reservation_key=? OR device_digest=?
    UNION ALL
    SELECT reservation_key,owner_id,device_digest,budget_day,reserved_at
      FROM storage_accountless_historical_issuance_reservations
      WHERE reservation_key=? OR device_digest=? LIMIT 3`)
    .bind(reservationKey, deviceDigest, reservationKey, deviceDigest).all<AccountlessIssuanceRow>());
  if (result.results.length > 1) fail('ENROLLMENT_CONFLICT');
  return result.results;
}
function utcDay(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 10);
}
function issuanceReservation(row: AccountlessIssuanceRow | null,
  reservationKey: string, deviceDigest: string,
  ownerId: string): AccountlessIssuanceReservation {
  if (row && row.reservation_key === reservationKey && row.owner_id === ownerId
      && row.device_digest !== deviceDigest) {
    fail('ENROLLMENT_CONFLICT');
  }
  if (!row || row.reservation_key !== reservationKey || row.owner_id !== ownerId
      || row.device_digest !== deviceDigest
      || !/^\d{4}-\d{2}-\d{2}$/u.test(row.budget_day)
      || !Number.isSafeInteger(row.reserved_at) || row.reserved_at < 0) {
    fail('STORAGE_UNAVAILABLE');
  }
  return Object.freeze({ reservationKey: row.reservation_key, ownerId: row.owner_id,
    deviceDigest: row.device_digest,
    budgetDay: row.budget_day, reservedAt: row.reserved_at });
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
    async database(route: OwnerStorageRoute) {
      const row = await readRoute(catalog, route.ownerId);
      if (!row || !matches(route, row)) fail('ROUTE_STALE');
      return binding(bindings, row.binding_name);
    },
    /** Exact retained physical targets from catalog history. This is used by
     * owner-authorized erasure/copy orchestration; it never scans bindings. */
    async ownerTargets(route: OwnerStorageRoute): Promise<OwnerStorageTarget[]> {
      const current = await readRoute(catalog, route.ownerId);
      if (!current || !matches(route, current)) fail('ROUTE_STALE');
      const results = await storage(() => catalog.batch<{
        shard_id: string; binding_name: string; route_generation: number;
      }>([
        catalog.prepare(`SELECT r.shard_id,s.binding_name,r.route_generation
          FROM storage_owner_routes r JOIN storage_shards s USING (shard_id)
          WHERE r.owner_id=? LIMIT 1`).bind(route.ownerId),
        catalog.prepare(`SELECT target.shard_id,s.binding_name,target.route_generation
          FROM (
            SELECT source_shard_id AS shard_id,source_generation AS route_generation
              FROM storage_owner_moves WHERE owner_id=?
            UNION
            SELECT destination_shard_id AS shard_id,destination_generation AS route_generation
              FROM storage_owner_moves WHERE owner_id=?
          ) target JOIN storage_shards s USING (shard_id)
          ORDER BY target.route_generation,target.shard_id LIMIT 65`)
          .bind(route.ownerId, route.ownerId),
      ]));
      const rows = [...(results[0]?.results ?? []), ...(results[1]?.results ?? [])];
      if (rows.length > 65) fail('STORAGE_UNAVAILABLE');
      const grouped = new Map<string, {
        shardId: string; bindingName: string; generations: number[]; current: boolean;
      }>();
      for (const row of rows) {
        identifier(row.shard_id);
        if (!BINDING.test(row.binding_name)) fail('STORAGE_UNAVAILABLE');
        integer(row.route_generation);
        binding(bindings, row.binding_name);
        const target = grouped.get(row.binding_name) ?? {
          shardId: row.shard_id, bindingName: row.binding_name,
          generations: [], current: false,
        };
        if (target.shardId !== row.shard_id) fail('STORAGE_UNAVAILABLE');
        if (!target.generations.includes(row.route_generation)) {
          target.generations.push(row.route_generation);
        }
        target.current ||= row.shard_id === route.shardId
          && row.route_generation === route.generation;
        grouped.set(row.binding_name, target);
      }
      if (grouped.size < 1 || grouped.size > 16
          || ![...grouped.values()].some((target) => target.current)) {
        fail('STORAGE_UNAVAILABLE');
      }
      return [...grouped.values()]
        .sort((left, right) => left.bindingName.localeCompare(right.bindingName))
        .map((target) => Object.freeze({
          ownerId: route.ownerId,
          shardId: target.shardId,
          bindingName: target.bindingName,
          generations: Object.freeze([...target.generations].sort((a, b) => a - b)),
          current: target.current,
        }));
    },
    /**
     * Atomically choose capacity, reserve one route, and bind its capability
     * locator. A raced duplicate rolls back the losing proposed owner rather
     * than leaving an unlocatable allocation behind.
     */
    async ensureCapabilityOwner(capabilityHash: string, deviceDigest: string,
      proposedOwnerId: string,
      reservationBytes: number): Promise<AccountlessOwnerAllocation> {
      digest(capabilityHash); digest(deviceDigest); identifier(proposedOwnerId);
      integer(reservationBytes, 1, STORAGE_SHARD_OPERATING_CAP_BYTES);
      await assertAccountlessIssuanceSchema(catalog);
      await assertAccountlessIssuanceReady(catalog);
      const existingReservations = await readIssuanceReservations(
        catalog, capabilityHash, deviceDigest,
      );
      let existingReservation = existingReservations[0] ?? null;
      if (existingReservation && (existingReservation.reservation_key !== capabilityHash
          || existingReservation.device_digest !== deviceDigest)) fail('ENROLLMENT_CONFLICT');
      const located = await storage(() => catalog.prepare(`SELECT owner_id, state
        FROM storage_capability_locators WHERE capability_hash = ? LIMIT 1`)
        .bind(capabilityHash).first<{owner_id: string; state: 'active' | 'revoked'}>());
      if (located && !existingReservation) {
        const racedReservations = await readIssuanceReservations(catalog, capabilityHash, deviceDigest);
        existingReservation = racedReservations[0] ?? null;
        if (existingReservation && (existingReservation.reservation_key !== capabilityHash
            || existingReservation.device_digest !== deviceDigest)) fail('ENROLLMENT_CONFLICT');
      }
      if (existingReservation && (!located || located.owner_id !== existingReservation.owner_id)) {
        fail('STORAGE_UNAVAILABLE');
      }
      let ownerId = existingReservation?.owner_id ?? located?.owner_id ?? proposedOwnerId;
      if (located?.state === 'revoked') fail('ROUTE_NOT_FOUND');
      if (!located && !existingReservation) {
        try {
          const stamp = now(clock);
          const candidate = await storage(() => catalog.prepare(`SELECT shard.shard_id,shard.binding_name
            FROM storage_shards shard
            JOIN storage_shard_capacity_observations observation USING (shard_id)
            JOIN storage_shard_allocation_policy policy USING (shard_id)
            JOIN storage_shard_runtime_readiness readiness
              ON readiness.readiness_digest=policy.qualification_digest
             AND readiness.shard_id=shard.shard_id
             AND readiness.binding_name=shard.binding_name
            WHERE shard.state='active' AND observation.pressure_state='normal'
              AND policy.allocation_enabled=1 AND readiness.state='active'
              AND readiness.contract_version=1 AND observation.valid_until>=?
              AND observation.observed_bytes<?
              AND observation.observed_bytes+shard.reserved_bytes+?<=shard.capacity_bytes
            ORDER BY CASE policy.allocation_tier WHEN 'active' THEN 0 ELSE 1 END,
              observation.observed_bytes+shard.reserved_bytes,shard.shard_id
            LIMIT 1`).bind(stamp, STORAGE_NEW_OWNER_CUTOFF_BYTES, reservationBytes)
            .first<{shard_id: string;binding_name: string}>());
          if (!candidate) fail('CAPACITY_UNAVAILABLE');
          identifier(candidate.shard_id);
          await assertShardRoutingSchema(binding(bindings, candidate.binding_name));
          const reservationStamp = now(clock);
          const results = await storage(() => catalog.batch([
            catalog.prepare(`INSERT INTO storage_owner_routes
              (owner_id, shard_id, route_generation, state, reservation_bytes, updated_at)
              SELECT ?, ?, 1, 'preparing', ?, ?
               WHERE NOT EXISTS (SELECT 1 FROM storage_accountless_issuance_reservations
                 WHERE reservation_key = ?)`)
              .bind(proposedOwnerId, candidate.shard_id, reservationBytes, reservationStamp,
                capabilityHash),
            catalog.prepare(`INSERT INTO storage_capability_locators
              (capability_hash, owner_id, state)
              SELECT ?, ?, 'active'
               WHERE EXISTS (SELECT 1 FROM storage_owner_routes WHERE owner_id = ?)
              ON CONFLICT(capability_hash) DO NOTHING`)
              .bind(capabilityHash, proposedOwnerId, proposedOwnerId),
            catalog.prepare(`INSERT INTO storage_accountless_issuance_reservations
              (reservation_key,owner_id,device_digest,budget_day,reserved_at)
              SELECT ?,?,?,?,?
               WHERE EXISTS (SELECT 1 FROM storage_capability_locators
                 WHERE capability_hash=? AND owner_id=? AND state='active')
              ON CONFLICT(reservation_key) DO NOTHING`)
              .bind(capabilityHash, proposedOwnerId, deviceDigest,
                utcDay(reservationStamp), reservationStamp,
                capabilityHash, proposedOwnerId),
          ]));
          void results;
          const created = await storage(() => catalog.prepare(`SELECT owner_id, state
            FROM storage_capability_locators WHERE capability_hash = ? LIMIT 1`)
            .bind(capabilityHash).first<{owner_id: string; state: 'active' | 'revoked'}>());
          if (!created || created.state !== 'active') fail('CAPACITY_UNAVAILABLE');
          ownerId = created.owner_id;
        } catch (error) {
          if (error instanceof StorageRoutingError
              && error.code !== 'STORAGE_UNAVAILABLE') throw error;
          // A competing request may have committed the exact capability. It
          // is safe to converge only through that catalog identity.
          const winner = await storage(() => catalog.prepare(`SELECT owner_id, state
            FROM storage_capability_locators WHERE capability_hash = ? LIMIT 1`)
            .bind(capabilityHash).first<{owner_id: string; state: 'active' | 'revoked'}>());
          if (!winner || winner.state !== 'active') fail('STORAGE_UNAVAILABLE');
          ownerId = winner.owner_id;
        }
      }
      if (!existingReservation) {
        const reservationStamp = now(clock);
        await storage(() => catalog.prepare(`INSERT INTO storage_accountless_issuance_reservations
          (reservation_key,owner_id,device_digest,budget_day,reserved_at)
          SELECT ?,?,?,?,? WHERE EXISTS (
            SELECT 1 FROM storage_capability_locators
             WHERE capability_hash=? AND owner_id=? AND state='active'
          ) ON CONFLICT(reservation_key) DO NOTHING`)
          .bind(capabilityHash, ownerId, deviceDigest,
            utcDay(reservationStamp), reservationStamp,
            capabilityHash, ownerId).run());
      }
      const admittedRows = await readIssuanceReservations(catalog, capabilityHash, deviceDigest);
      const admitted = admittedRows[0] ?? null;
      const row = await readRoute(catalog, ownerId);
      if (!row) fail('STORAGE_UNAVAILABLE');
      const route = await this.ensureOwner(ownerId, row.shard_id, row.reservation_bytes);
      return Object.freeze({ route,
        issuanceReservation: issuanceReservation(admitted, capabilityHash, deviceDigest, ownerId) });
    },
    /** Caller supplies an explicit admitted shard. Capacity failure never redirects elsewhere. */
    async ensureOwner(ownerId: string, shardId: string, reservationBytes: number) {
      identifier(ownerId); integer(reservationBytes, 1, STORAGE_SHARD_OPERATING_CAP_BYTES);
      const shard = await readShard(catalog, shardId); const database = binding(bindings, shard.binding_name);
      let row = await readRoute(catalog, ownerId);
      if (!row) {
        await assertShardRoutingSchema(database);
        const observedAt = now(clock);
        const eligible = await storage(() => catalog.prepare(`SELECT 1 AS eligible
          FROM storage_shards shard
          JOIN storage_shard_capacity_observations observation USING (shard_id)
          JOIN storage_shard_allocation_policy policy USING (shard_id)
          JOIN storage_shard_runtime_readiness readiness
            ON readiness.readiness_digest=policy.qualification_digest
           AND readiness.shard_id=shard.shard_id
           AND readiness.binding_name=shard.binding_name
          WHERE shard.shard_id = ? AND shard.state = 'active'
            AND policy.allocation_enabled = 1
            AND readiness.state='active' AND readiness.contract_version=1
            AND observation.pressure_state = 'normal'
            AND observation.valid_until >= ?
            AND observation.observed_bytes < ?
            AND observation.observed_bytes + shard.reserved_bytes + ? <= shard.capacity_bytes
          LIMIT 1`).bind(shardId, observedAt, STORAGE_NEW_OWNER_CUTOFF_BYTES, reservationBytes).first());
        if (!eligible) fail('CAPACITY_UNAVAILABLE');
        const reservationStamp = now(clock);
        await storage(() => catalog.prepare(`INSERT INTO storage_owner_routes
          (owner_id, shard_id, route_generation, state, reservation_bytes, updated_at)
          SELECT ?, ?, 1, 'preparing', ?, ? WHERE NOT EXISTS
          (SELECT 1 FROM storage_owner_routes WHERE owner_id = ?)`)
          .bind(ownerId, shardId, reservationBytes, reservationStamp, ownerId).run());
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
    async registerCapability(capabilityHash: string, route: OwnerStorageRoute): Promise<void> {
      digest(capabilityHash);
      const row = await readRoute(catalog, route.ownerId);
      if (!row || !matches(route, row)) fail('ROUTE_STALE');
      await storage(() => catalog.prepare(`INSERT INTO storage_capability_locators
        (capability_hash, owner_id, state) VALUES (?, ?, 'active')
        ON CONFLICT (capability_hash) DO NOTHING`).bind(capabilityHash, route.ownerId).run());
      const locator = await storage(() => catalog.prepare(`SELECT owner_id, state
        FROM storage_capability_locators WHERE capability_hash = ? LIMIT 1`)
        .bind(capabilityHash).first<{owner_id: string; state: 'active' | 'revoked'}>());
      if (!locator || locator.owner_id !== route.ownerId || locator.state !== 'active') fail('ROUTE_STALE');
    },
    async registerParticipantOwner(participantDigest: string, deletionDigest: string,
      route: OwnerStorageRoute): Promise<void> {
      digest(participantDigest); digest(deletionDigest);
      const row = await readRoute(catalog, route.ownerId);
      if (!row || !matches(route, row)) fail('ROUTE_STALE');
      const createdAt = now(clock);
      await storage(() => catalog.batch([
        catalog.prepare(`INSERT INTO storage_participant_owner_locators
          (participant_digest,owner_id,created_at) VALUES (?,?,?)
          ON CONFLICT(participant_digest) DO NOTHING`)
          .bind(participantDigest, route.ownerId, createdAt),
        catalog.prepare(`INSERT INTO storage_participant_deletion_replay_locators
          (participant_digest,owner_id,created_at) VALUES (?,?,?)
          ON CONFLICT(participant_digest) DO NOTHING`)
          .bind(deletionDigest, route.ownerId, createdAt),
      ]));
      const locators = await storage(() => catalog.batch<{owner_id:string}>([
        catalog.prepare(`SELECT owner_id FROM storage_participant_owner_locators
          WHERE participant_digest=? LIMIT 1`).bind(participantDigest),
        catalog.prepare(`SELECT owner_id FROM storage_participant_deletion_replay_locators
          WHERE participant_digest=? LIMIT 1`).bind(deletionDigest),
      ]));
      if (locators.length !== 2
          || locators.some(result => result.results[0]?.owner_id !== route.ownerId)) fail('ROUTE_STALE');
    },
    async locateParticipantOwner(participantDigest: string): Promise<OwnerStorageRoute | null> {
      digest(participantDigest);
      const locator = await storage(() => catalog.prepare(`SELECT owner_id
        FROM storage_participant_owner_locators
        WHERE participant_digest=? LIMIT 1`).bind(participantDigest)
        .first<{owner_id: string}>());
      return locator ? activeRoute(await readRoute(catalog, locator.owner_id), bindings) : null;
    },
    async locateParticipantDeletionOwner(participantDigest: string): Promise<OwnerStorageRoute | null> {
      digest(participantDigest);
      const locator = await storage(() => catalog.prepare(`SELECT owner_id
        FROM storage_participant_deletion_replay_locators
        WHERE participant_digest=? LIMIT 1`).bind(participantDigest)
        .first<{owner_id: string}>());
      return locator ? activeRoute(await readRoute(catalog, locator.owner_id), bindings) : null;
    },
    async revokeCapability(capabilityHash: string, route: OwnerStorageRoute): Promise<void> {
      digest(capabilityHash);
      await storage(() => catalog.prepare(`UPDATE storage_capability_locators SET state = 'revoked'
        WHERE capability_hash = ? AND owner_id = ? AND state = 'active'`)
        .bind(capabilityHash, route.ownerId).run());
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

/** Stable, bounded catalog page for trusted publication orchestration. */
export async function captureActiveOwnerRouteSnapshot({
  catalog, bindings, afterOwnerId = "", limit = 100,
}: {
  catalog: D1Database; bindings: StorageShardBindings;
  afterOwnerId?: string; limit?: number;
}): Promise<ActiveOwnerRouteSnapshot> {
  if (afterOwnerId !== "") identifier(afterOwnerId);
  integer(limit, 1, 500);
  const results = await storage(() => catalog.batch<{
    catalog_epoch?: number; owner_id?: string; shard_id?: string;
    binding_name?: string; route_generation?: number;
  }>([
    catalog.prepare(`SELECT catalog_epoch FROM storage_routing_state
      WHERE singleton_id=1`),
    catalog.prepare(`SELECT r.owner_id,r.shard_id,s.binding_name,r.route_generation
      FROM storage_owner_routes r JOIN storage_shards s USING (shard_id)
      WHERE r.state='active' AND s.state<>'offline' AND r.owner_id>?
      ORDER BY r.owner_id LIMIT ?`).bind(afterOwnerId, limit + 1),
    catalog.prepare(`SELECT catalog_epoch FROM storage_routing_state
      WHERE singleton_id=1`),
  ]));
  const before = results[0]?.results[0]?.catalog_epoch;
  const after = results[2]?.results[0]?.catalog_epoch;
  if (!Number.isSafeInteger(before) || before !== after) fail('STORAGE_UNAVAILABLE');
  const rows = results[1]?.results ?? [];
  const bounded = rows.length > limit;
  const page = rows.slice(0, limit);
  const routes = page.map((row) => {
    if (typeof row.owner_id !== 'string' || typeof row.shard_id !== 'string'
        || typeof row.binding_name !== 'string' || !Number.isSafeInteger(row.route_generation)) {
      fail('STORAGE_UNAVAILABLE');
    }
    identifier(row.owner_id); identifier(row.shard_id); integer(row.route_generation!);
    binding(bindings, row.binding_name);
    return Object.freeze({ ownerId: row.owner_id, shardId: row.shard_id,
      bindingName: row.binding_name, generation: row.route_generation!, mode: 'catalog' as const });
  });
  return Object.freeze({ catalogEpoch: before!, routes: Object.freeze(routes), bounded,
    nextAfterOwnerId: bounded ? routes.at(-1)?.ownerId ?? null : null });
}

export async function assertStorageCatalogEpoch(
  catalog: D1Database,
  expectedEpoch: number,
): Promise<void> {
  integer(expectedEpoch, 0, Number.MAX_SAFE_INTEGER - 1);
  const row = await storage(() => catalog.prepare(`SELECT catalog_epoch
    FROM storage_routing_state WHERE singleton_id=1`).first<{catalog_epoch: number}>());
  if (!row || row.catalog_epoch !== expectedEpoch) fail('ROUTE_STALE');
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
