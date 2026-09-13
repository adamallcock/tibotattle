import { applyD1Migrations, env, reset } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configureStorageShardAllocation, recordStorageCapacityObservation } from '../src/storage-capacity';
import { runStorageCapacityMonitor } from '../src/storage-capacity-monitor';
import capacityWorker, { runStorageCapacitySchedule } from '../src/storage-capacity-worker';

interface Bindings extends Env { TEST_ROUTING_MIGRATIONS: D1Migration[] }
const fixture = () => env as Bindings;
function required(value: D1Database | undefined): D1Database {
  if (!value) throw new Error('SYNTHETIC_BINDING_MISSING');
  return value;
}
const catalog = () => required(fixture().STORAGE_ROUTING_DB);
const a = () => required(fixture().STORAGE_INGESTION_A);
const b = () => required(fixture().STORAGE_INGESTION_B);
const bindingMap = () => ({ STORAGE_INGESTION_A: a(), STORAGE_INGESTION_B: b() });
const NOW = 1_000_000;

async function observation(shardId: string) {
  return catalog().prepare('SELECT observed_bytes,observed_at,valid_until,pressure_state FROM storage_shard_capacity_observations WHERE shard_id=?')
    .bind(shardId).first();
}

/** Real D1 queries with a corrupted provider metadata reply injected afterwards. */
function withSize(database: D1Database, size: number): D1Database {
  return new Proxy(database, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => new Proxy(target.prepare(sql), {
        get(statement, property) {
          if (property === 'run') return async () => {
            const result = await statement.run();
            return { ...result, meta: { ...result.meta, size_after: size } };
          };
          const value = Reflect.get(statement, property);
          return typeof value === 'function' ? value.bind(statement) : value;
        },
      });
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(catalog(), fixture().TEST_ROUTING_MIGRATIONS);
  await catalog().batch([
    catalog().prepare("INSERT INTO storage_shards(shard_id,binding_name,state,reserved_bytes) VALUES('a','STORAGE_INGESTION_A','active',1234)"),
    catalog().prepare("INSERT INTO storage_shards(shard_id,binding_name,state) VALUES('b','STORAGE_INGESTION_B','active')"),
  ]);
  for (const shardId of ['a', 'b']) {
    await recordStorageCapacityObservation(catalog(), {
      shardId, observedBytes: 100, observedAt: NOW - 1_000,
      validUntil: NOW + 60_000, pressureState: 'normal',
    });
  }
  await configureStorageShardAllocation(catalog(), {
    shardId: 'a', allocationTier: 'spare', allocationEnabled: false, updatedAt: NOW - 1_000,
  });
  for (const database of [a(), b()]) {
    await database.prepare('CREATE TABLE synthetic_retained_rows (id INTEGER PRIMARY KEY, n INTEGER)').run();
    await database.prepare('INSERT INTO synthetic_retained_rows VALUES (1,42)').run();
  }
});

describe('isolated shard capacity monitor', () => {
  it('records actual D1 bytes without touching source records, reservations or readiness', async () => {
    const actual = await a().prepare('SELECT 1').run();
    expect(await runStorageCapacityMonitor({ catalog: catalog(), bindings: bindingMap(), clock: () => NOW }))
      .toEqual({ shards: 2, observed: 2, allocationCutoff: 0, overBudget: 0, unavailable: 0 });
    expect(await observation('a')).toEqual({
      observed_bytes: actual.meta.size_after, observed_at: NOW,
      valid_until: NOW + 120_000, pressure_state: 'normal',
    });
    expect(await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='a'").first('reserved_bytes')).toBe(1234);
    expect(await catalog().prepare("SELECT allocation_enabled FROM storage_shard_allocation_policy WHERE shard_id='a'").first('allocation_enabled')).toBe(0);
    expect(await a().prepare('SELECT n FROM synthetic_retained_rows WHERE id=1').first('n')).toBe(42);
  });

  it('invalidates unavailable-shard allocation immediately while other shards still advance', async () => {
    const result = await runStorageCapacityMonitor({ catalog: catalog(), bindings: { STORAGE_INGESTION_B: b() }, clock: () => NOW });
    expect(result).toMatchObject({ observed: 1, unavailable: 1 });
    expect(await observation('a')).toEqual({ observed_bytes: 100, observed_at: NOW - 1_000, valid_until: NOW, pressure_state: 'pressure' });
    expect((await observation('b'))?.observed_at).toBe(NOW);
  });

  it('does not replace an unavailable provider size with zero', async () => {
    const result = await runStorageCapacityMonitor({ catalog: catalog(), bindings: { ...bindingMap(), STORAGE_INGESTION_A: withSize(a(), -1) }, clock: () => NOW });
    expect(result).toMatchObject({ observed: 1, unavailable: 1 });
    expect(await observation('a')).toMatchObject({ observed_bytes: 100, observed_at: NOW - 1_000, pressure_state: 'pressure' });
  });

  it('retains an over-budget observation and closes allocation instead of rolling it back', async () => {
    const result = await runStorageCapacityMonitor({ catalog: catalog(), bindings: { ...bindingMap(), STORAGE_INGESTION_A: withSize(a(), 9_000_000_000) }, clock: () => NOW });
    expect(result).toMatchObject({ observed: 2, allocationCutoff: 1, overBudget: 1, unavailable: 0 });
    expect(await observation('a')).toMatchObject({ observed_bytes: 9_000_000_000, pressure_state: 'pressure' });
    expect(await catalog().prepare("SELECT state FROM storage_shards WHERE shard_id='a'").first('state')).toBe('draining');
    expect(await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='a'").first('reserved_bytes')).toBe(1234);
  });

  it('closes allocation when the clock rolls backwards during measurement', async () => {
    let calls = 0;
    const result = await runStorageCapacityMonitor({ catalog: catalog(), bindings: bindingMap(), clock: () => calls++ === 0 ? NOW : NOW - 1 });
    expect(result).toMatchObject({ observed: 0, unavailable: 2 });
    expect(await observation('a')).toMatchObject({ observed_at: NOW - 1_000, pressure_state: 'pressure' });
  });

  it('refuses a missing catalog schema with a content-free error', async () => {
    await expect(runStorageCapacityMonitor({ catalog: a(), bindings: bindingMap(), clock: () => NOW }))
      .rejects.toThrow('STORAGE_CAPACITY_CATALOG_UNAVAILABLE');
  });

  it('never queries the catalog as an ingestion binding', async () => {
    const result = await runStorageCapacityMonitor({ catalog: catalog(), bindings: { ...bindingMap(), STORAGE_INGESTION_A: catalog() }, clock: () => NOW });
    expect(result).toMatchObject({ unavailable: 1, observed: 1 });
  });

  it('keeps the scheduler disabled by default and its HTTP surface closed', async () => {
    await expect(runStorageCapacitySchedule({})).resolves.toBeUndefined();
    await expect(runStorageCapacitySchedule({ STORAGE_CAPACITY_MODE: 'disabled' })).resolves.toBeUndefined();
    expect(capacityWorker.fetch().status).toBe(404);
    await expect(runStorageCapacitySchedule({ STORAGE_CAPACITY_MODE: 'invalid' })).rejects.toThrow('STORAGE_CAPACITY_CONFIGURATION_INVALID');
  });

  it('runs the actual scheduled entrypoint with only capacity-role bindings', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runStorageCapacitySchedule({ STORAGE_CAPACITY_MODE: 'enabled', STORAGE_ROUTING_DB: catalog(), ...bindingMap() });
      expect((await observation('a'))?.observed_bytes).toBeGreaterThan(100);
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'storage_capacity_schedule', shards: 2, observed: 2, allocationCutoff: 0, overBudget: 0, unavailable: 0 }));
    } finally { log.mockRestore(); }
  });
});
