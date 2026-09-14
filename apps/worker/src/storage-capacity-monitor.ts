import { invalidateStorageCapacityObservation, recordStorageCapacityObservation } from './storage-capacity';
import { STORAGE_NEW_OWNER_CUTOFF_BYTES, STORAGE_SHARD_OPERATING_CAP_BYTES } from './storage-routing';

const MAX_SHARDS = 32;
const CONCURRENCY = 2;
const OBSERVATION_TTL_MS = 120_000;
const SHARD_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const BINDING_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

interface ShardRow { shard_id: string; binding_name: string }
export interface StorageCapacityMonitorResult {
  readonly shards: number;
  readonly observed: number;
  readonly allocationCutoff: number;
  readonly overBudget: number;
  readonly unavailable: number;
}

function timestamp(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - OBSERVATION_TTL_MS) {
    throw new Error('STORAGE_CAPACITY_CLOCK_INVALID');
  }
  return value;
}

/** Measure catalog-listed ingestion shards only. This observer cannot qualify a
 * shard, enable allocation, release reservations or mutate ingestion records. */
export async function runStorageCapacityMonitor({ catalog, bindings, clock = Date.now }: {
  catalog: D1Database;
  bindings: Readonly<Record<string, D1Database | undefined>>;
  clock?: () => number;
}): Promise<StorageCapacityMonitorResult> {
  const startedAt = timestamp(clock);
  let rows: ShardRow[];
  try {
    const result = await catalog.prepare(`SELECT shard_id, binding_name
      FROM storage_shards WHERE state IN ('active', 'draining')
      ORDER BY shard_id LIMIT ?`).bind(MAX_SHARDS + 1).all<ShardRow>();
    if (!result.success || !Array.isArray(result.results)) throw new Error('catalog');
    rows = result.results;
    if (rows.length > MAX_SHARDS || rows.some(row => !SHARD_ID.test(row.shard_id)
        || !BINDING_NAME.test(row.binding_name))
        || new Set(rows.map(row => row.binding_name)).size !== rows.length) throw new Error('catalog');
  } catch {
    throw new Error('STORAGE_CAPACITY_CATALOG_UNAVAILABLE');
  }

  let next = 0;
  const totals = { shards: rows.length, observed: 0, allocationCutoff: 0, overBudget: 0, unavailable: 0 };
  async function observe(): Promise<void> {
    while (next < rows.length) {
      const row = rows[next++];
      if (!row) throw new Error('STORAGE_CAPACITY_CATALOG_UNAVAILABLE');
      try {
        const database = Object.hasOwn(bindings, row.binding_name) ? bindings[row.binding_name] : undefined;
        if (!database || database === catalog || typeof database.prepare !== 'function') throw new Error('binding');
        const measured = await database.prepare('SELECT 1 AS storage_capacity_observation').run();
        const bytes = measured.meta?.size_after;
        const observedAt = timestamp(clock);
        if (!measured.success || !Number.isSafeInteger(bytes) || bytes < 0 || observedAt < startedAt) {
          throw new Error('measurement');
        }
        await recordStorageCapacityObservation(catalog, {
          shardId: row.shard_id, observedBytes: bytes, observedAt,
          validUntil: observedAt + OBSERVATION_TTL_MS,
          pressureState: bytes >= STORAGE_SHARD_OPERATING_CAP_BYTES ? 'pressure' : 'normal',
        });
        totals.observed++;
        if (bytes >= STORAGE_NEW_OWNER_CUTOFF_BYTES) totals.allocationCutoff++;
        if (bytes >= STORAGE_SHARD_OPERATING_CAP_BYTES) totals.overBudget++;
      } catch {
        totals.unavailable++;
        // Keep the last actual bytes/time, but close allocation immediately.
        // Do not turn a failed probe into a fresh zero-sized observation.
        await invalidateStorageCapacityObservation(catalog, row.shard_id, startedAt);
      }
    }
  }
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, observe));
  if (outcomes.some(result => result.status === 'rejected')) {
    throw new Error('STORAGE_CAPACITY_CATALOG_UNAVAILABLE');
  }
  return Object.freeze(totals);
}
