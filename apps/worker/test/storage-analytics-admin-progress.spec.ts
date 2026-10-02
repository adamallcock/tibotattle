import { env, reset } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { readAdminMaintainedPipeline } from '../src/storage-analytics-admin-progress';
import { readStoragePipelineProgress } from '../src/storage-community-progress';
import { recordAnalyticsPipelineRuntime } from '../src/storage-analytics-runtime-controls';
import { admitAnalyticsPartitionWork, claimAnalyticsPartitionWork, recordAnalyticsPartitionWorkReason, releaseAnalyticsPartitionWork } from '../src/storage-analytics-partition-work';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { initializeSharedAnalyticsCorpusDatabases, type SharedAnalyticsCorpusMigrations } from './fixtures/shared-analytics-corpus';
const b = env as Env & SharedAnalyticsCorpusMigrations & { STORAGE_ANALYTICS_DB: D1Database };
const sourceId = 'synthetic-admin-progress', source = () => b.USAGE_MONITOR_DB, target = () => b.STORAGE_ANALYTICS_DB;
const bindings = () => ({ source: source(), target: target(), sourceId, sourceNamespace: sourceId });
beforeEach(async () => { await reset(); await initializeSharedAnalyticsCorpusDatabases(source(), target(), b, sourceId); });

it('reads actual queue populations and observed controls using bounded target metadata only', async () => {
 const now = Date.parse('2026-10-01T12:00:00.000Z');
 await admitAnalyticsPartitionWork(target(), Array.from({ length: 4 }, (_, n) => ({ sourceId, ownerDigest: null,
  stage: 'features' as const, lane: 'new' as const, partitionKey: `synthetic/${n}`, headKey: (n + 1).toString(16).padStart(64, '0'),
  inputRevision: 'a'.repeat(64), policyRevision: 'b'.repeat(64), day: n === 0 ? '2025-12-30' : '2026-10-01',
  stream: 'usage' as const, selectionMethod: 'effective-union-v1' as const, residentBytes: 4096, admissionQueries: 50 })), now - 1000);
 const leases = await claimAnalyticsPartitionWork(target(), { sourceId, limit: 4, nowMs: now - 900 });
 expect(leases).toHaveLength(4);
 await recordAnalyticsPartitionWorkReason(target(), leases[0]!, 'query_budget', now - 800);
 await releaseAnalyticsPartitionWork(target(), leases[0]!, 'deferred', now - 700);
 await recordAnalyticsPartitionWorkReason(target(), leases[1]!, 'synthetic_private_reason', now - 800);
 await releaseAnalyticsPartitionWork(target(), leases[1]!, 'refused', now - 700);
 await releaseAnalyticsPartitionWork(target(), leases[2]!, 'complete', now - 700);
 await recordAnalyticsPipelineRuntime(target(), sourceId, { role: 'analytics', method: 'maintained-analytics-v1',
  canonicalPipeline: true, sharedFeatures: true, modelBlocks: false, degree: 4, queryLimit: 950, observedMs: now });
 const sourceGuard = new Proxy(source(), { get(db, key) { if (key === 'prepare' || key === 'batch')
  return () => { throw new Error('admin must not read source history'); };
  const value = Reflect.get(db, key); return typeof value === 'function' ? value.bind(db) : value; } });
 const meter = createD1InvocationBudget(50);
 const progress = await readAdminMaintainedPipeline({ ...bindings(), source: sourceGuard, target: meter.wrap(target()) }, now);
 expect(meter.queriesUsed).toBe(13);
 const sourceMeter = createD1InvocationBudget(20), targetMeter = createD1InvocationBudget(30);
 const pipeline = await readStoragePipelineProgress({ ...bindings(), source: sourceMeter.wrap(source()), target: targetMeter.wrap(target()) }, now);
 expect(pipeline?.canonical).not.toBeNull();
 expect(sourceMeter.queriesUsed).toBe(4);
 expect(targetMeter.queriesUsed).toBe(19);
 expect(progress.queues!.features).toMatchObject({ ready: 1, leased: 1, complete: 1, refused: 1,
  detail: { fromDay: '2025-12-30', throughDay: '2026-10-01', completedLastHour: 1, completedLast6Hours: 1, retrying: 1,
   reasons: [{ code: 'evidence', jobs: 1 }, { code: 'query_budget', jobs: 1 }, { code: 'scheduled', jobs: 1 }] } });
 expect(progress.runtime).toEqual([{ role: 'analytics', method: 'maintained-analytics-v1', canonicalEnabled: true,
  sharedFeaturesEnabled: true, modelBlocksEnabled: false, degree: 4, maxQueries: 950, observedAt: new Date(now).toISOString() }]);
 expect(progress.stores.cache).toMatchObject({ retained: 0, complete: null, headMatched: null, inputEvents: 0, adjacencyPairs: 0 });
 expect(progress.publications.cache).toMatchObject({ retained: 0, latestPublishedAt: null, freshness: 'not_checked' });
 expect(JSON.stringify(progress)).not.toMatch(/synthetic_private_reason|owner_digest|claim_token|payload_json|synthetic-admin-progress/u);
 const later = await readAdminMaintainedPipeline(bindings(), now + 7 * 3_600_000);
 expect(later.queues!.features.detail).toMatchObject({ completedLastHour: 0, completedLast6Hours: 0, expiredLeases: 1 });
});

it('keeps missing schemas and unreadable queue detail unknown without losing independent populations', async () => {
 const selective = new Proxy(target(), { get(db, key) {
  if (key === 'prepare') return (sql: string) => {
   if (sql.includes('analytics_canonical_cache_days') || sql.includes('analytics_canonical_cache_publications')
    || sql.includes('FROM analytics_partition_work WHERE')) throw new Error('synthetic missing metadata');
   return db.prepare(sql);
  };
  const value = Reflect.get(db, key); return typeof value === 'function' ? value.bind(db) : value;
 } });
 const partial = await readAdminMaintainedPipeline({ ...bindings(), target: selective }, Date.now());
 expect(partial.stores.cache).toBeNull();
 expect(partial.publications.cache).toBeNull();
 expect(partial.queues!.features).toEqual({ ready: 0, leased: 0, complete: 0, refused: 0, detail: null });
 expect(partial.stores.features!.retained).toBe(0);
 expect(partial.runtime).toEqual([]);
 await target().prepare('DROP TRIGGER analytics_partition_counts_insert').run();
 expect((await readAdminMaintainedPipeline(bindings(), Date.now())).queues).toBeNull();
});


it('keeps exact compact populations when detailed job metadata exceeds its bound', async () => {
 await target().prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<10001)
 INSERT INTO analytics_partition_work(work_key,head_key,source_id,owner_digest,partition_key,input_revision,policy_revision,
 stage,lane,day,stream,selection_method,resident_bytes,admission_queries,ready_ms,created_ms,updated_ms)
 SELECT printf('%064x',n),printf('%064x',n),?,NULL,'synthetic/'||n,printf('%064x',n),printf('%064x',n),
 'features','new','2026-10-01','usage','effective-union-v1',4096,50,1,1,1 FROM seq`).bind(sourceId).run();
 const meter = createD1InvocationBudget(50);
 const result = await readAdminMaintainedPipeline({ ...bindings(), target: meter.wrap(target()) }, Date.now());
 expect(meter.queriesUsed).toBe(13);
 expect(result.queues!.features).toEqual({ ready: 10001, leased: 0, complete: 0, refused: 0, detail: null });
 await target().prepare('DELETE FROM analytics_partition_work WHERE source_id=?').bind(sourceId).run();
 await target().prepare("UPDATE analytics_partition_work_counts SET jobs=1 WHERE source_id=? AND stage='features' AND state='ready'").bind(sourceId).run();
 expect((await readAdminMaintainedPipeline(bindings(), Date.now())).queues).toBeNull();
});
