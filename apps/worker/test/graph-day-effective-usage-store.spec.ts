import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/canonical-json';
import {
  graphDayEffectiveQuotaSupported, graphDayEffectiveUsageSupported, graphDayProjectionValueKey,
  readGraphDayEffectiveQuotaHeads, readGraphDayEffectiveUsageHeads, readGraphDayProjection,
  reduceGraphDayProjection, retireGraphDayProjectionPage, writeGraphDayProjection,
  type GraphDayProjectionKey,
} from '../src/graph-day-projection';

const b = env as Env & { STORAGE_ANALYTICS_DB: D1Database; TEST_ANALYTICS_MIGRATIONS: D1Migration[] };
const target = () => b.STORAGE_ANALYTICS_DB;
const sourceId = 'synthetic-effective-usage-store', sourceNamespace = 'synthetic-effective-usage-namespace';
const ownerDigest = 'a'.repeat(64), day = '2026-09-10', manifestDigest = 'b'.repeat(64);
const key = (patch: Partial<GraphDayProjectionKey> = {}): GraphDayProjectionKey => ({ sourceId,
  sourceNamespace, ownerDigest, day, manifestDigest, sourceLayout: 'effective-usage',
  deviceId: 'effective-owner', manifestId: `effective-owner-usage-v1:${'e'.repeat(64)}`, ...patch });
const usageManifestId = `effective-owner-usage-v1:${'e'.repeat(64)}`;
const metadata = { ownerRevision: 10 };
function projection(projectedDay = day) {
  return reduceGraphDayProjection(projectedDay, [], { rowsRead: 2, events: [0, 1].map(index => ({
    sessionDigest: 'c'.repeat(64), observedAtMs: Date.parse(projectedDay) + 1000 + index,
    provider: 'openai_codex', accountScopeId: null, planBasis: null, planType: null, planEraId: null,
    kind: 'priced' as const, model: 'gpt-5', costNanousd: 1000,
  })) });
}
async function initialize(migrations = b.TEST_ANALYTICS_MIGRATIONS) {
  await applyD1Migrations(target(), migrations);
  await target().prepare('INSERT INTO analytics_runtime_sources(source_id,source_namespace,contract_version) VALUES(?,?,1)')
    .bind(sourceId, sourceNamespace).run();
  await target().prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,10,1,'active')")
    .bind(sourceId, ownerDigest).run();
}
beforeEach(async () => { await reset(); await initialize(); });
const store = (patch: Partial<GraphDayProjectionKey> = {}) => writeGraphDayProjection({ target: target(),
  key: key(patch), projection: projection(patch.day ?? day), effectiveUsage: metadata });
const headsInput = { sourceId, sourceNamespace, ownerDigest, fromDay: day, throughDay: day };
const retire = (nowMs = Date.parse(day)) => retireGraphDayProjectionPage(target(), sourceId, { nowMs });

describe('effective usage store forward migration', () => {
  it('refuses before 0029 and preserves existing legacy and effective quota bytes on upgrade', async () => {
    await reset(); await initialize(b.TEST_ANALYTICS_MIGRATIONS.filter(migration => migration.name < '0029_'));
    const legacy = key({ sourceLayout: 'typed-v11', deviceId: 'synthetic-device', manifestId: 'synthetic-manifest' });
    const quota = key({ sourceLayout: 'effective', manifestId: 'effective-owner-day' });
    const empty = reduceGraphDayProjection(day, []);
    await writeGraphDayProjection({ target: target(), key: legacy, projection: projection() });
    await writeGraphDayProjection({ target: target(), key: quota, projection: empty,
      effectiveQuota: { quotaRowsRead: 7, ownerRevision: 10 } });
    const values = (await target().prepare('SELECT * FROM analytics_graph_day_values ORDER BY value_key').all()).results;
    const pages = (await target().prepare('SELECT * FROM analytics_graph_day_pages ORDER BY value_key,part_index').all()).results;
    expect(await graphDayEffectiveQuotaSupported(target())).toBe(true);
    expect(await graphDayEffectiveUsageSupported(target())).toBe(false);
    await expect(store()).rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
    expect((await target().prepare('SELECT * FROM analytics_graph_day_pages ORDER BY value_key,part_index').all()).results).toEqual(pages);
    await applyD1Migrations(target(), b.TEST_ANALYTICS_MIGRATIONS);
    expect(await graphDayEffectiveUsageSupported(target())).toBe(true);
    expect(await graphDayEffectiveQuotaSupported(target())).toBe(true);
    expect((await target().prepare('SELECT * FROM analytics_graph_day_values ORDER BY value_key').all()).results).toEqual(values);
    expect((await target().prepare('SELECT * FROM analytics_graph_day_pages ORDER BY value_key,part_index').all()).results).toEqual(pages);
    expect((await readGraphDayProjection({ target: target(), key: legacy })).status).toBe('ready');
    expect(await readGraphDayProjection({ target: target(), key: quota })).toMatchObject({ status: 'ready',
      effectiveQuota: { quotaRowsRead: 7, ownerRevision: 10 } });
    await expect(target().prepare('UPDATE analytics_graph_day_values SET record_count=0').run()).rejects.toThrow('analytics_graph_day_value_conflict');
    await expect(target().prepare('DELETE FROM analytics_graph_day_pages').run()).rejects.toThrow('analytics_graph_day_page_retained');
  });

  it('requires the final usage marker without disabling the quota store', async () => {
    await target().prepare('DROP TRIGGER analytics_graph_day_effective_usage_contract').run();
    expect(await graphDayEffectiveUsageSupported(target())).toBe(false);
    expect(await graphDayEffectiveQuotaSupported(target())).toBe(true);
    await expect(store()).rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
    expect(await target().prepare('SELECT COUNT(*) AS n FROM analytics_graph_day_pages').first('n')).toBe(0);
  });
});

describe('effective usage cache identity and replay', () => {
  it('selects only the current price contract under the same day dependency', async () => {
    await store();
    const olderManifestId = `effective-owner-usage-v1:${'f'.repeat(64)}`;
    await store({ manifestId: olderManifestId });
    const heads = await readGraphDayEffectiveUsageHeads({ target: target(), ...headsInput, manifestId: usageManifestId });
    expect(heads).toHaveLength(1);
    expect(heads![0]!.key.manifestId).toBe(usageManifestId);
    expect(await graphDayProjectionValueKey(key({ manifestId: olderManifestId })))
      .not.toBe(await graphDayProjectionValueKey(key()));
    expect(await target().prepare('SELECT COUNT(*) AS n FROM analytics_graph_day_values').first('n')).toBe(2);
  });

  it('isolates quota heads, validates payload cursors, and replays after unrelated owner revision', async () => {
    const first = await store();
    const quota = key({ sourceLayout: 'effective', manifestId: 'effective-owner-day' });
    await writeGraphDayProjection({ target: target(), key: quota, projection: reduceGraphDayProjection(day, []),
      effectiveQuota: { quotaRowsRead: 0, ownerRevision: 10 } });
    expect(await graphDayProjectionValueKey(key())).not.toBe(await graphDayProjectionValueKey(quota));
    const usageHeads = await readGraphDayEffectiveUsageHeads({ target: target(), ...headsInput, manifestId: usageManifestId });
    const quotaHeads = await readGraphDayEffectiveQuotaHeads({ target: target(), ...headsInput });
    expect(usageHeads).toHaveLength(1); expect(quotaHeads).toHaveLength(1);
    expect(usageHeads![0]!.key.sourceLayout).toBe('effective-usage');
    expect(quotaHeads![0]!.key.sourceLayout).toBe('effective');
    const result = await readGraphDayProjection({ target: target(), key: key(), cursor: usageHeads![0]!.cursor });
    expect(result).toMatchObject({ status: 'ready', projection: projection(), effectiveUsage: metadata });
    await expect(readGraphDayProjection({ target: target(), key: quota, cursor: usageHeads![0]!.cursor }))
      .rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
    expect(await writeGraphDayProjection({ target: target(), key: key(), projection: projection(),
      effectiveUsage: { ownerRevision: 11 } })).toEqual(first);
    expect(await target().prepare("SELECT quota_rows_read FROM analytics_graph_day_values WHERE source_layout='effective-usage'").first('quota_rows_read')).toBeNull();
    expect(await readGraphDayProjection({ target: target(), key: key() })).toMatchObject({ status: 'ready', effectiveUsage: metadata });
  });

  it('refuses wrong metadata or quota-bearing usage projections before staging', async () => {
    for (const bad of [{ ownerRevision: 0 }, { ownerRevision: 1.5 }, { ownerRevision: 10, extra: true }]) {
      await expect(writeGraphDayProjection({ target: target(), key: key(), projection: projection(), effectiveUsage: bad }))
        .rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
    }
    await expect(writeGraphDayProjection({ target: target(), key: key(), projection: projection() })).rejects.toThrow();
    await expect(writeGraphDayProjection({ target: target(), key: key({ sourceLayout: 'effective', manifestId: 'effective-owner-day' }),
      projection: projection(), effectiveUsage: metadata, effectiveQuota: { quotaRowsRead: 0, ownerRevision: 10 } })).rejects.toThrow();
    const badProjection = { ...projection(), planAnchors: { anchors: [{ contextKey: 'openai_codex|codex',
      observedAtMs: Date.parse(day), planType: 'pro' as const, planVariant: 'unknown', continuityId: null,
      conflicted: false, accountScopeId: null, planBasis: 'same_source_occurrence' as const }] } };
    await expect(writeGraphDayProjection({ target: target(), key: key(), projection: badProjection, effectiveUsage: metadata }))
      .rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
    expect(await target().prepare('SELECT COUNT(*) AS n FROM analytics_graph_day_pages').first('n')).toBe(0);
  });

  it('recovers interrupted framing and refuses mutation of a published summary', async () => {
    const first = await writeGraphDayProjection({ target: target(), key: key(), projection: projection(),
      effectiveUsage: metadata, maxWrites: 2 });
    expect(first.status).toBe('staging');
    expect(await readGraphDayProjection({ target: target(), key: key() })).toMatchObject({ status: 'absent' });
    expect((await store()).status).toBe('stored');
    const changed = { ...projection(), usage: { ...projection().usage, rowsRead: 3 } };
    await expect(writeGraphDayProjection({ target: target(), key: key(), projection: changed, effectiveUsage: metadata }))
      .rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
  });

  it('enforces closed usage metadata in SQL independently of the writer', async () => {
    await store();
    const original = await target().prepare('SELECT * FROM analytics_graph_day_values').first<Record<string, unknown>>();
    if (!original) throw new Error('expected stored row');
    await target().prepare('DELETE FROM analytics_graph_day_values').run();
    const columns = Object.keys(original);
    const insert = (overrides: Record<string, unknown>) => {
      const row = { ...original, ...overrides };
      return target().prepare(`INSERT INTO analytics_graph_day_values (${columns.join(',')})
        VALUES(${columns.map(() => '?').join(',')})`).bind(...columns.map(column => row[column])).run();
    };
    for (const invalid of [{ quota_rows_read: 0 }, { effective_owner_revision: null },
      { effective_owner_revision: 0 }, { effective_owner_revision: 1.5 }, { device_id: 'synthetic-device' },
      { manifest_id: 'effective-owner-day' }, { manifest_id: `effective-owner-usage-v1:${'G'.repeat(64)}` }]) {
      await expect(insert(invalid)).rejects.toThrow();
    }
    await insert({});
    expect(await readGraphDayProjection({ target: target(), key: key() })).toMatchObject({ status: 'ready' });
  });
});

describe('effective usage cache retirement', () => {
  it('keeps lagging daily identities and retires only fresh changed dependencies', async () => {
    await store(); expect(await retire()).toMatchObject({ state: 'idle' });
    for (const revision of [9, 10]) {
      await target().prepare(`INSERT INTO analytics_community_daily_owners
        (source_id,day,owner_digest,input_revision,owner_revision,source_format,method,progress_revision,
         next_index,fingerprint,complete,values_json) VALUES(?,?,?,1,?,'effective','synthetic',1,0,?,1,'{}')
        ON CONFLICT(source_id,day,owner_digest) DO UPDATE SET owner_revision=excluded.owner_revision`)
        .bind(sourceId, day, ownerDigest, revision, canonicalJson({ method: 'effective-daily-cursor-v2',
          dependencyDigest: 'd'.repeat(64), streams: { quota: null, session: null, usage: null } })).run();
      expect(await retire()).toMatchObject(revision === 9 ? { state: 'idle' } : { state: 'retiring', values: 1 });
    }
    expect(await target().prepare('SELECT COUNT(*) AS n FROM analytics_graph_day_pages').first('n')).toBe(0);
  });

  it('retires days outside the window while preserving the boundary day', async () => {
    for (const preparedDay of ['2026-04-10', '2026-04-11']) await store({ day: preparedDay });
    expect(await retire(Date.parse('2026-09-27T23:59:59.999Z'))).toMatchObject({ values: 1 });
    expect(await target().prepare('SELECT day FROM analytics_graph_day_values').first('day')).toBe('2026-04-11');
  });
});
