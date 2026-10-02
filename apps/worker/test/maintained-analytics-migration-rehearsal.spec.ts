import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { analyticsFeatureControls } from '../src/analytics-feature-controls';
import { canonicalJson } from '../src/canonical-json';
import { normalizeNativeEffectiveOccurrence } from '../src/canonical-analytics-facts';
import { materializeCanonicalPage } from '../src/storage-canonical-analytics-facts';
import { readEffectiveUsageOwnerDayPage } from '../src/telemetry-usage-effective-reader';
import { sha256Hex } from '../src/crypto';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { D1_PROVIDER_SCHEMA_PREDICATE } from '../src/d1-provider-schema';
import { runCanonicalAnalyticsWorkPass } from '../src/storage-analytics-canonical-runtime';
import { advanceAnalyticsWorkEffects } from '../src/storage-analytics-work-effects';
import { analyticsPartitionWorkAvailable } from '../src/storage-analytics-partition-work';
import { runStorageAnalyticsPass } from '../src/storage-analytics-runtime';
import { captureStorageGraphScope, computeStorageGraphResult } from '../src/storage-community-graph';
import { publishStorageCommunityModelDay, publishStorageCommunityGraphPreview, readPublishedStorageCommunityGraph }
  from '../src/storage-community-graph-publication';
import { readStorageCommunityOwnerPage } from '../src/storage-community-authority';
import { advanceStorageCommunityDaily, readPublishedStorageCommunityDaily } from '../src/storage-community-daily';
import { effectiveSelectiveSchemaAvailable } from '../src/storage-effective-selective-dependencies';
import { readMaintainedAnalyticsErasureInventory, requireMaintainedSourceErasureProof }
  from '../src/storage-erasure-artifacts';
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus,
  type SharedAnalyticsCorpusMigrations } from './fixtures/shared-analytics-corpus';

const b = env as Env & SharedAnalyticsCorpusMigrations & { STORAGE_ANALYTICS_DB: D1Database };
const source = b.USAGE_MONITOR_DB, target = b.STORAGE_ANALYTICS_DB;
const sourceId = 'synthetic-maintained-migration';
const bindings = { source, target, sourceId, sourceNamespace: sourceId };
const pendingAnalytics = () => b.TEST_ANALYTICS_MIGRATIONS.filter(m => m.name >= '0034_' && m.name < '0049_');
const pendingSource = () => b.TEST_INGESTION_ISOLATION_MIGRATIONS.filter(m => m.name >= '0014_' && m.name < '0017_');
const identifier = (value: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error('SYNTHETIC_IDENTIFIER_INVALID');
  return '"' + value + '"';
};
function stableValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, member]) => [key, stableValue(member)]));
  return value;
}
interface TableSnapshot { name: string; columns: string[]; rows: number; digest: string }
async function rowsDigest(database: D1Database, name: string, columns: readonly string[]) {
  const rows = (await database.prepare(`SELECT ${columns.map(identifier).join(',')} FROM ${identifier(name)}`).all()).results;
  return { rows: rows.length, digest: await sha256Hex(canonicalJson(rows.map(row => canonicalJson(stableValue(row))).sort())) };
}
/** Only hashes and counts reach assertion diagnostics; never synthetic credential material. */
async function snapshot(database: D1Database, omitLedger = false): Promise<TableSnapshot[]> {
  const names = (await database.prepare(`SELECT s.name FROM sqlite_schema s WHERE s.type='table' AND s.name NOT GLOB 'sqlite_*'
    AND NOT (${D1_PROVIDER_SCHEMA_PREDICATE}) ORDER BY s.name`)
    .all<{ name: string }>()).results.map(row => row.name).filter(name => !omitLedger || name !== 'd1_migrations');
  const result: TableSnapshot[] = [];
  for (const name of names) {
    const columns = (await database.prepare(`PRAGMA table_info(${identifier(name)})`).all<{ name: string }>()).results.map(row => row.name);
    result.push({ name, columns, ...await rowsDigest(database, name, columns) });
  }
  return result;
}
async function assertRetained(database: D1Database, expected: readonly TableSnapshot[]) {
  for (const row of expected) expect(await rowsDigest(database, row.name, row.columns), row.name)
    .toEqual({ rows: row.rows, digest: row.digest });
}
async function schemaDigest(database: D1Database) {
  return sha256Hex(canonicalJson((await database.prepare(
    `SELECT s.type,s.name,s.tbl_name,s.sql FROM sqlite_schema s WHERE s.name NOT GLOB 'sqlite_*'
      AND NOT (${D1_PROVIDER_SCHEMA_PREDICATE}) ORDER BY s.type,s.name`).all()).results));
}
async function integrity(database: D1Database) {
  expect((await database.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  // Check each application table separately: this D1 runtime rejects the source-wide
  // quick_check with SQLITE_NOMEM even on the small synthetic corpus.
  const names = (await database.prepare(`SELECT s.name FROM sqlite_schema s WHERE s.type='table'
    AND s.name NOT GLOB 'sqlite_*' AND NOT (${D1_PROVIDER_SCHEMA_PREDICATE}) ORDER BY s.name`)
    .all<{ name: string }>()).results;
  for (const { name } of names) expect((await database.prepare(`PRAGMA quick_check(${identifier(name)})`).all()).results, name)
    .toEqual([{ quick_check: 'ok' }]);
}
async function setup(analyticsBefore = '0034_', sourceBefore = '0014_') {
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source, target, {
    ...b, TEST_ANALYTICS_MIGRATIONS: b.TEST_ANALYTICS_MIGRATIONS.filter(m => m.name < analyticsBefore),
    TEST_INGESTION_ISOLATION_MIGRATIONS: b.TEST_INGESTION_ISOLATION_MIGRATIONS.filter(m => m.name < sourceBefore),
  }, sourceId);
}
async function canonicalPass() {
  const invocation = createD1InvocationBudget(950);
  const result = await runCanonicalAnalyticsWorkPass({ ...bindings, invocation, now: Date.now,
    deadlineMs: Date.now() + 55_000, maxWaves: 1 });
  expect(invocation.queriesUsed).toBeLessThanOrEqual(950);
  return result;
}
async function publishNative(day: string, sharedFeatures = false) {
  for (let attempt = 0; attempt < 32; attempt++) {
    const result = await advanceStorageCommunityDaily({ ...bindings, day, sharedFeatures, maxOwners: 4 });
    if (result.state === 'published' || result.state === 'unchanged') return;
  }
  throw new Error('SYNTHETIC_NATIVE_PUBLICATION_INCOMPLETE');
}
async function publishNativeGraphs(day: string) {
  const owners = await readStorageCommunityOwnerPage(source);
  expect(owners.length).toBeGreaterThan(0);
  for (const owner of owners) for (const metric of ['fits', 'model'] as const) {
    const date = metric === 'fits' ? new Date().toISOString().slice(0, 10) : day;
    let complete = false;
    for (let turn = 0; turn < 16 && !complete; turn++) {
      const invocation = createD1InvocationBudget(950);
      const metered = { ...bindings, source: invocation.wrap(source), target: invocation.wrap(target) };
      const scope = await captureStorageGraphScope(metered.source, { owner, day: date, metric,
        sourceId, sourceNamespace: sourceId });
      const result = await computeStorageGraphResult(metered, scope, {
        maxQueries: invocation.remainingQueries, deadlineMs: Date.now() + 55_000, sharedFeatures: false, canonicalPipeline: false });
      expect(invocation.queriesUsed).toBeLessThanOrEqual(950);
      complete = result.state === 'complete';
    }
    expect(complete).toBe(true);
  }
  expect(await publishStorageCommunityModelDay(bindings, { day })).toMatchObject({ state: 'published' });
  expect(await publishStorageCommunityGraphPreview(bindings)).toMatchObject({ state: 'published' });
  expect(await readPublishedStorageCommunityGraph(bindings)).not.toBeNull();
}
async function ledger(database: D1Database) {
  return (await database.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map(row => row.name);
}
function withBatch(database: D1Database, batch: D1Database['batch']): D1Database {
  return new Proxy(database, { get(value, property) {
    if (property === 'batch') return batch;
    if (property === 'constructor') return value.constructor;
    const member: unknown = Reflect.get(value, property);
    return typeof member === 'function' ? member.bind(value) : member;
  } });
}

it('upgrades populated 0033/0013 predecessors without changing accepted native output, delivery receipts or authority', async () => {
  await setup();
  expect(pendingAnalytics().map(m => m.name.slice(0, 4))).toEqual(
    ['0034', '0035', '0036', '0037', '0038', '0039', '0040', '0041', '0042', '0043', '0044', '0045', '0046', '0047', '0048']);
  expect(pendingSource().map(m => m.name.slice(0, 4))).toEqual(['0014', '0015', '0016']);
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await seedSharedAnalyticsCorpus({ ...bindings, anchorDay: day, calendarDays: 14, graphDays: 2,
    targetAuthority: 'ordered-delivery' });
  let delivered = false;
  for (let turn = 0; turn < 64 && !delivered; turn++) {
    const progress = await runStorageAnalyticsPass({ ...bindings, publishCommunity: false,
      maxSteps: 32, maxQueries: 950, deadlineMs: Date.now() + 55_000 });
    delivered = progress.state === 'idle' && progress.reason === 'complete';
  }
  expect(delivered).toBe(true);
  expect(await target.prepare('SELECT count(*) n FROM analytics_applied_events').first<number>('n')).toBeGreaterThan(0);
  await publishNative(day);
  await publishNativeGraphs(day);
  const graphPublished = await readPublishedStorageCommunityGraph(bindings);
  const readPublic = () => readPublishedStorageCommunityDaily({ ...bindings, fromDay: day, throughDay: day });
  const published = await readPublic();
  expect(published.rows).toHaveLength(1);
  const sourceBefore = await snapshot(source, true), targetBefore = await snapshot(target, true);
  expect(sourceBefore.filter(row => row.rows).length).toBeGreaterThan(15);
  expect(targetBefore.filter(row => row.rows).length).toBeGreaterThan(5);
  const sourceLedger = await ledger(source), targetLedger = await ledger(target);
  expect(await canonicalPass()).toMatchObject({ state: 'unavailable', reason: 'migration_required', admitted: 0, claimed: 0 });
  await assertRetained(source, sourceBefore); await assertRetained(target, targetBefore);
  // Source schema first. Until all queue/graph capabilities are present, new work remains refused.
  for (const migration of pendingSource()) await applyD1Migrations(source, [migration]);
  for (const migration of pendingAnalytics()) {
    await applyD1Migrations(target, [migration]);
    if (migration.name < '0047_') {
      expect(await canonicalPass()).toMatchObject({ state: 'unavailable', reason: 'migration_required', admitted: 0, claimed: 0 });
    }
    await assertRetained(source, sourceBefore); await assertRetained(target, targetBefore);
    expect(await readPublic()).toEqual(published);
    expect(await readPublishedStorageCommunityGraph(bindings)).toEqual(graphPublished);
    await integrity(target);
  }
  expect(await ledger(source)).toEqual([...sourceLedger, ...pendingSource().map(m => m.name)]);
  expect(await ledger(target)).toEqual([...targetLedger, ...pendingAnalytics().map(m => m.name)]);
  expect(await analyticsPartitionWorkAvailable(target)).toBe(true);
  expect(await effectiveSelectiveSchemaAvailable(source)).toBe(true);
  await readMaintainedAnalyticsErasureInventory(target); await requireMaintainedSourceErasureProof(source, true);
  await integrity(source);
  const upgradedSource = await snapshot(source), upgradedTarget = await snapshot(target);
  await applyD1Migrations(source, pendingSource()); await applyD1Migrations(target, pendingAnalytics());
  expect(await snapshot(source)).toEqual(upgradedSource); expect(await snapshot(target)).toEqual(upgradedTarget);
  // Roll serving controls forward to disabled. Preserve the upgraded schema and use the native writer.
  const disabled = analyticsFeatureControls({ STORAGE_ANALYTICS_CANONICAL_PIPELINE: 'disabled',
    STORAGE_ANALYTICS_SHARED_FEATURES: 'disabled', STORAGE_ANALYTICS_MODEL_BLOCKS: 'disabled' });
  expect(disabled).toEqual({ canonicalPipeline: false, sharedFeatures: false, modelBlocks: false });
  const maintainedTables = upgradedTarget.filter(row => row.name.startsWith('analytics_canonical_') || row.name.startsWith('analytics_partition_'));
  await publishNative(day, disabled.sharedFeatures);
  expect(await publishStorageCommunityModelDay(bindings, { day })).toMatchObject({ state: 'unchanged' });
  expect(await publishStorageCommunityGraphPreview(bindings)).toMatchObject({ state: 'unchanged' });
  expect(await readPublic()).toEqual(published);
  expect(await readPublishedStorageCommunityGraph(bindings)).toEqual(graphPublished);
  await assertRetained(target, maintainedTables);
  expect(await ledger(target)).toEqual([...targetLedger, ...pendingAnalytics().map(m => m.name)]);
  console.log(JSON.stringify({ event: 'maintained_migration_rehearsal', sourcePending: pendingSource().length,
    analyticsPending: pendingAnalytics().length, sourcePredecessorTables: sourceBefore.length,
    sourcePopulatedTables: sourceBefore.filter(row => row.rows).length, sourceRows: sourceBefore.reduce((sum, row) => sum + row.rows, 0),
    analyticsPredecessorTables: targetBefore.length, analyticsPopulatedTables: targetBefore.filter(row => row.rows).length,
    analyticsRows: targetBefore.reduce((sum, row) => sum + row.rows, 0), publishedRows: published.rows.length }));
}, 120_000);

it('rolls back late migration batch failure and retries exact pending SQL without a schema downgrade', async () => {
  await setup();
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const corpus = await seedSharedAnalyticsCorpus({ ...bindings, anchorDay: day, calendarDays: 14, graphDays: 2 });
  await publishNative(day);
  // Every failed transaction starts with accepted predecessor rows. Add actual
  // native-derived canonical facts before the final trigger/empty-outcome migrations.
  for (const [database, migrations] of [[source, pendingSource()], [target, pendingAnalytics()]] as const) {
    for (const migration of migrations) {
      const before = await snapshot(database), beforeSchema = await schemaDigest(database), beforeLedger = await ledger(database);
      await expect(applyD1Migrations(database, [{ ...migration,
        queries: [...migration.queries, 'INSERT INTO synthetic_missing_migration_target VALUES(1)'] }])).rejects.toThrow();
      expect(await schemaDigest(database)).toBe(beforeSchema);
      expect(await snapshot(database)).toEqual(before);
      expect(await ledger(database)).toEqual(beforeLedger);
      await applyD1Migrations(database, [migration]);
      expect(await ledger(database)).toEqual([...beforeLedger, migration.name]);
      await integrity(database);
      if (database === target && migration.name.startsWith('0044_')) {
        const owner = corpus.owner, scope = { sourceNamespace: sourceId, ownerDigest: owner.ownerDigest,
          selectionMethod: 'effective-union-v1' as const };
        const native = await readEffectiveUsageOwnerDayPage(source, { sourceNamespace: sourceId,
          ownerDigest: owner.ownerDigest, ownerRevision: owner.ownerRevision, authorityEpoch: owner.authorityEpoch,
          day: corpus.correctionDay, limit: 200 });
        expect(native.rows.length).toBeGreaterThan(0);
        const facts = await Promise.all(native.rows.map((row, index) => normalizeNativeEffectiveOccurrence(scope, row, index)));
        await materializeCanonicalPage({ db: target, sourceId, scope, ownerRevision: owner.ownerRevision,
          authorityEpoch: owner.authorityEpoch, pageKey: await sha256Hex('synthetic-migration-native-page'),
          sourceRevision: await sha256Hex('synthetic-migration-native-proof'), stillCurrent: async () => true,
          load: async () => facts.map(fact => ({ occurrenceKey: fact.occurrenceKey, stream: 'usage' as const, expectedRevision: null, fact })) });
        expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_facts').first<number>('n')).toBe(facts.length);
      }
    }
  }
}, 120_000);

it('reconciles committed migration response loss from the existing ledger before retry', async () => {
  await setup();
  const migration = pendingAnalytics()[0]!;
  let calls = 0;
  const lostResponse = withBatch(target, (async statements => {
    calls++;
    await target.batch(statements);
    throw new Error('SYNTHETIC_MIGRATION_RESPONSE_LOST');
  }) as D1Database['batch']);
  await expect(applyD1Migrations(lostResponse, [migration])).rejects.toThrow('SYNTHETIC_MIGRATION_RESPONSE_LOST');
  expect(calls).toBe(1);
  expect((await ledger(target)).filter(name => name === migration.name)).toHaveLength(1);
  const committed = await snapshot(target), committedSchema = await schemaDigest(target);
  await applyD1Migrations(lostResponse, [migration]);
  expect(calls).toBe(1);
  expect(await snapshot(target)).toEqual(committed); expect(await schemaDigest(target)).toBe(committedSchema);
  await integrity(target);
});

it('refuses source predecessor capabilities before creating target work or acknowledging an absence', async () => {
  await setup('0049_', '0014_');
  const sourceBefore = await snapshot(source), targetBefore = await snapshot(target);
  expect(await canonicalPass()).toMatchObject({ state: 'unavailable', reason: 'source_migration_required', admitted: 0, claimed: 0 });
  expect(await snapshot(source)).toEqual(sourceBefore); expect(await snapshot(target)).toEqual(targetBefore);
});

it('refuses a partial latest empty-outcome contract before any absence proof or ACK', async () => {
  await setup('0046_', '0017_');
  const sourceBefore = await snapshot(source), targetBefore = await snapshot(target);
  const meter = createD1InvocationBudget(950);
  expect(await advanceAnalyticsWorkEffects({ ...bindings, meter, now: Date.now, deadlineMs: Date.now() + 55_000 }))
    .toMatchObject({ state: 'unavailable', rangesAdmitted: 0, rangesAcknowledged: 0, daysAdmitted: 0, globalOwners: 0 });
  expect(await snapshot(source)).toEqual(sourceBefore); expect(await snapshot(target)).toEqual(targetBefore);
});

it('refuses a missing graph safety trigger and withholds physical absence proof for missing replay guards', async () => {
  await setup('0049_', '0017_');
  await target.prepare('DROP TRIGGER analytics_partition_graph_input_sealed').run();
  const sourceBefore = await snapshot(source), targetBefore = await snapshot(target);
  expect(await canonicalPass()).toMatchObject({ state: 'unavailable', reason: 'migration_required', admitted: 0, claimed: 0 });
  expect(await snapshot(source)).toEqual(sourceBefore); expect(await snapshot(target)).toEqual(targetBefore);
  await target.prepare('DROP TRIGGER analytics_canonical_erasure_replay').run();
  await expect(readMaintainedAnalyticsErasureInventory(target)).rejects.toMatchObject({ code: 'BACKEND_STORAGE_UNAVAILABLE' });
  await source.prepare('DROP TRIGGER storage_effective_selective_bootstrap_owner_erase').run();
  await expect(requireMaintainedSourceErasureProof(source, true)).rejects.toMatchObject({ code: 'BACKEND_STORAGE_UNAVAILABLE' });
});

it('refuses composed runtime activation while the latest empty-outcome migration is missing', async () => {
  await setup('0046_', '0017_');
  const sourceBefore = await snapshot(source), targetBefore = await snapshot(target);
  expect(await canonicalPass()).toMatchObject({ state: 'unavailable', reason: 'migration_required', admitted: 0, claimed: 0 });
  expect(await snapshot(source)).toEqual(sourceBefore); expect(await snapshot(target)).toEqual(targetBefore);
});

it('refuses activation before the 0047 cleanup cadence migration without touching accepted state', async () => {
  await setup('0047_', '0017_');
  const sourceBefore = await snapshot(source), targetBefore = await snapshot(target);
  expect(await canonicalPass()).toMatchObject({ state: 'unavailable', reason: 'migration_required', admitted: 0, claimed: 0 });
  expect(await snapshot(source)).toEqual(sourceBefore); expect(await snapshot(target)).toEqual(targetBefore);
});
