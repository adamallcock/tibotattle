import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveTelemetryOccurrence } from '../../vendor/analytics-d43c8f92/apps/worker/src/telemetry-usage-effective-reader';
import type { StorageCommunityAuthority, StorageCommunityOwner } from '../../vendor/analytics-d43c8f92/apps/worker/src/storage-community-authority';
import { createSharedAnalyticsInputCache } from '../../vendor/analytics-d43c8f92/apps/worker/src/analytics-shared-input';
import { v11UsageRecord } from './helpers/telemetry-v11';

// These tests inject source transitions at deterministic read boundaries.
// The benchmark separately exercises real migrations, admission and D1 reads.
const source = vi.hoisted(() => ({
  revision: 1, ownerRevision: 1, erased: false, reads: 0, digestsRead: 0,
  failDay: '', onRead: null as (() => void) | null,
  digests: new Map<string, string>(), rows: new Map<string, EffectiveTelemetryOccurrence[]>(),
}));
vi.mock('../../vendor/analytics-d43c8f92/apps/worker/src/storage-effective-history', async importOriginal => ({
  ...await importOriginal<typeof import('../../vendor/analytics-d43c8f92/apps/worker/src/storage-effective-history')>(),
  assertEffectiveHistoryOwner: async (_db: D1Database, owner: StorageCommunityOwner) => {
    if (source.erased || owner.ownerRevision !== source.ownerRevision) throw new Error('source owner changed');
  },
  createEffectiveHistoryDayDependencyReader: async () => ({
    readDigest: async (day: string) => { source.digestsRead++; return source.digests.get(day) ?? 'empty'; },
  }),
}));
vi.mock('../../vendor/analytics-d43c8f92/apps/worker/src/storage-community-authority', async importOriginal => ({
  ...await importOriginal<typeof import('../../vendor/analytics-d43c8f92/apps/worker/src/storage-community-authority')>(),
  captureStorageCommunityAuthority: async (): Promise<StorageCommunityAuthority> => ({
    sourceId: 'synthetic-shared-source', sourceNamespace: 'synthetic-shared-source',
    publicAuthorityEpoch: 1, policyRevision: 1, collectionRevision: 1, graphInvalidationEpoch: 1,
    sourceEpoch: source.revision, sequence: source.revision,
  }),
}));
vi.mock('../../vendor/analytics-d43c8f92/apps/worker/src/telemetry-usage-effective-reader', async importOriginal => ({
  ...await importOriginal<typeof import('../../vendor/analytics-d43c8f92/apps/worker/src/telemetry-usage-effective-reader')>(),
  readEffectiveTelemetryOwnerDays: async (_db: D1Database, input: { stream: string; fromDay: string; throughDay: string }) =>
    [...source.rows].filter(([key, rows]) => key.startsWith(`${input.stream}:`) && rows.length > 0)
      .map(([key]) => key.slice(input.stream.length + 1)).filter(day => day >= input.fromDay && day <= input.throughDay),
  readEffectiveTelemetryOwnerDayPage: async (_db: D1Database, input: { stream: string; day: string }) => {
    source.reads++;
    if (input.day === source.failDay) throw new Error('synthetic source interruption');
    source.onRead?.();
    return { rows: source.rows.get(`${input.stream}:${input.day}`) ?? [], next: null };
  },
}));

const first = '2026-09-01', second = '2026-09-02';
const owner: StorageCommunityOwner & { ownerDigest: string } = {
  ownerDigest: 'a'.repeat(64), participantId: 'synthetic-shared-owner', inputRevision: 1,
  ownerRevision: 1, authorityEpoch: 1, hasV1: true, hasV11: true, hasV12: true, hasLegacy: false,
};
const unexpectedDatabaseAccess = (): never => { throw new Error('unexpected unmocked database access'); };
const database: D1Database = { prepare: unexpectedDatabaseAccess, batch: unexpectedDatabaseAccess,
  exec: unexpectedDatabaseAccess, withSession: unexpectedDatabaseAccess, dump: unexpectedDatabaseAccess };
const cache = (options: { maxBytes?: number; maxRows?: number; maxDays?: number } = {}) =>
  createSharedAnalyticsInputCache({ source: database, sourceNamespace: 'synthetic-shared-source', ...options });
const request = () => ({ owner, fromDay: first, throughDay: second });

function setDay(day: string, index = 1) {
  const record = v11UsageRecord(day, 'b', { eventTime: `${day}T12:00:00.000Z`,
    eventId: `event:v2:${index.toString(16).padStart(64, '0')}` });
  source.rows.set(`usage:${day}`, [{ methodVersion: 'effective-telemetry-owner-day-v1', stream: 'usage',
    participantId: owner.participantId, ownerDigest: owner.ownerDigest, occurrenceId: record.eventId,
    eventTime: record.eventTime, eventTimeConflict: false, status: 'compatible', sourceCount: 1,
    sourceFormats: ['v1', 'v11', 'v12'], sourceRowIds: [], sourceRecordKeys: [], recordJson: JSON.stringify(record) }]);
  source.digests.set(day, `revision-${source.revision}-${index}`);
}

beforeEach(() => {
  Object.assign(source, { revision: 1, ownerRevision: 1, erased: false, reads: 0,
    digestsRead: 0, failDay: '', onRead: null });
  source.rows.clear(); source.digests.clear();
});

describe('bounded shared acquisition and reuse', () => {
  it('keeps unchanged days immutable and reads no history on an unchanged replay', async () => {
    setDay(first);
    const store = cache(), cold = await store.load(request());
    expect(cold.metrics).toMatchObject({ preparedDays: 2, reusedDays: 0, sourceRows: 1 });
    const noop = await store.load(request());
    expect(noop.metrics).toMatchObject({ preparedDays: 0, reusedDays: 2, dependencyDays: 0, sourceRows: 0, sourcePages: 0 });
    expect(noop.days[0]).toBe(cold.days[0]);
    expect(Object.isFrozen(noop.days[0]!.usageRows)).toBe(true);
    await noop.assertCurrent();
  });

  it('rechecks empty-day dependencies and replaces both sides of a moved occurrence', async () => {
    setDay(first);
    const store = cache(), cold = await store.load(request());
    source.revision++;
    source.rows.delete(`usage:${first}`); source.digests.set(first, 'empty'); setDay(second);
    const moved = await store.load(request());
    expect(moved.metrics).toMatchObject({ preparedDays: 2, reusedDays: 0, dependencyDays: 2, sourceRows: 1 });
    expect(moved.days.map(day => day.daily.counts.usage)).toEqual([0, 1]);
    expect(cold.days.map(day => day.daily.counts.usage)).toEqual([1, 0]);
    await expect(cold.assertCurrent()).rejects.toThrow('SHARED_ANALYTICS_CHANGED');
  });

  it('prepares only the changed day after another source mutation', async () => {
    setDay(first); setDay(second, 2);
    const store = cache(), cold = await store.load(request());
    source.revision++; setDay(first, 3);
    const changed = await store.load(request());
    expect(changed.metrics).toMatchObject({ preparedDays: 1, reusedDays: 1, sourceRows: 1, dependencyDays: 2 });
    expect(changed.days[1]).toBe(cold.days[1]);
  });

  it('pins adjacent model dates from a complete cached dependency vector without source scans', async () => {
    setDay(first);
    const store = cache(), snapshot = await store.load({ owner, fromDay: '2026-05-23', throughDay: second });
    const reads = source.reads, dependencies = source.digestsRead;
    const earlier = await snapshot.pinForDate(first), later = await snapshot.pinForDate(second);
    expect(earlier).toMatchObject({ source: 'v1.1', fromDay: '2026-05-24', throughDay: first });
    expect(later.fingerprint).not.toBe(earlier.fingerprint);
    expect(await snapshot.pinForDate(first)).toEqual(earlier);
    expect([source.reads, source.digestsRead]).toEqual([reads, dependencies]);
    await expect(snapshot.pinForDate('2026-09-03')).rejects.toThrow('SHARED_ANALYTICS_INVALID');
  });

  it('discards a partially prepared successor after a read failure or a mid-read mutation', async () => {
    setDay(first); setDay(second, 2); source.failDay = second;
    const store = cache();
    await expect(store.load(request())).rejects.toThrow('synthetic source interruption');
    expect(store.retainedDays).toBe(0);
    source.failDay = ''; source.onRead = () => { source.revision++; };
    await expect(store.load(request())).rejects.toThrow('SHARED_ANALYTICS_CHANGED');
    expect(store.retainedBytes).toBe(0);
    source.onRead = null;
    expect((await store.load(request())).metrics.preparedDays).toBe(2);
  });

  it('fences erasure even when the day cache was warm', async () => {
    setDay(first);
    const store = cache(), ready = await store.load(request());
    source.erased = true;
    await expect(ready.assertCurrent()).rejects.toThrow('source owner changed');
    await expect(store.load(request())).rejects.toThrow('source owner changed');
    expect(store.retainedBytes).toBe(0);
  });

  it('rejects invalid ranges, overlapping loads, bounded capacity and cancellation', async () => {
    expect(() => cache({ maxRows: 0 })).toThrow('SHARED_ANALYTICS_INVALID');
    await expect(cache().load({ ...request(), fromDay: '2026-02-30' })).rejects.toThrow('SHARED_ANALYTICS_INVALID');
    await expect(cache({ maxDays: 1 }).load(request())).rejects.toThrow('SHARED_ANALYTICS_LIMIT');
    const store = cache(), pending = store.load(request());
    await expect(store.load(request())).rejects.toThrow('SHARED_ANALYTICS_BUSY');
    expect(() => store.clear()).toThrow('SHARED_ANALYTICS_BUSY');
    await pending;
    const controller = new AbortController(); controller.abort();
    await expect(store.load({ ...request(), signal: controller.signal })).rejects.toThrow();
    await expect(store.load({ ...request(), deadlineMs: 0 })).rejects.toThrow('SHARED_ANALYTICS_DEADLINE');
    setDay(first); setDay(second, 2);
    for (const constrained of [cache({ maxRows: 1 }), cache({ maxBytes: 1 })]) {
      await expect(constrained.load(request())).rejects.toThrow('SHARED_ANALYTICS_LIMIT');
      expect(constrained.retainedBytes).toBe(0);
    }
  });
});
