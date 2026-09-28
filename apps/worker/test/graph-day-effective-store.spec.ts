import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/canonical-json';
import { sha256Hex } from '../src/crypto';
import {
  GRAPH_DAY_EFFECTIVE_DEVICE_ID, GRAPH_DAY_EFFECTIVE_MANIFEST_ID,
  graphDayEffectiveQuotaSupported, graphDayProjectionValueKey, readGraphDayProjection, readGraphDayEffectiveQuotaHeads,
  reduceGraphDayProjection, retireGraphDayProjectionPage, writeGraphDayProjection,
  type GraphDayProjectionKey, type GraphDayQuotaInput,
} from '../src/graph-day-projection';

const b = env as Env & { STORAGE_ANALYTICS_DB: D1Database; TEST_ANALYTICS_MIGRATIONS: D1Migration[] };
const target = () => b.STORAGE_ANALYTICS_DB;
const sourceId = 'synthetic-effective-day-store', sourceNamespace = 'synthetic-effective-day-namespace';
const ownerDigest = 'a'.repeat(64), manifestDigest = 'b'.repeat(64), day = '2026-09-10';
const dayMs = Date.parse(`${day}T00:00:00.000Z`);
const key = (overrides: Partial<GraphDayProjectionKey> = {}): GraphDayProjectionKey => ({
  sourceId, sourceNamespace, ownerDigest, day, manifestDigest, sourceLayout: 'effective',
  deviceId: GRAPH_DAY_EFFECTIVE_DEVICE_ID, manifestId: GRAPH_DAY_EFFECTIVE_MANIFEST_ID, ...overrides,
});
const legacy = (): GraphDayProjectionKey => key({ sourceLayout: 'typed-v11',
  deviceId: 'synthetic-device', manifestId: 'synthetic-manifest' });
function projection(count = 3, projectedDay = day) {
  const projectedDayMs = Date.parse(`${projectedDay}T00:00:00.000Z`);
  const rows: GraphDayQuotaInput[] = Array.from({ length: count }, (_, index) => {
    const observedAtMs = projectedDayMs + (index + 1) * 60_000;
    return { sourceRowId: index + 1, observedAtMs,
      anchor: { contextKey: 'openai_codex|codex', observedAtMs, planType: 'pro', planVariant: 'unknown',
        continuityId: null, conflicted: false, accountScopeId: null, planBasis: 'same_source_occurrence' },
      row: { occurrence_id: `occ-${index.toString().padStart(8, '0')}`,
        observed_at: new Date(observedAtMs).toISOString(), provider: 'openai_codex', account_scope_id: null,
        limit_id: 'codex', plan_type: 'pro', plan_variant: 'unknown', continuity_id: null,
        plan_basis: 'same_source_occurrence', slot: 'primary', used_percent: index % 2 === 0 ? 10 : 20,
        window_duration_minutes: 10080, resets_at: new Date(projectedDayMs + 7 * 86400000).toISOString() } };
  });
  return reduceGraphDayProjection(projectedDay, rows);
}
async function initialize(migrations = b.TEST_ANALYTICS_MIGRATIONS): Promise<void> {
  await applyD1Migrations(target(), migrations);
  await target().prepare('INSERT INTO analytics_runtime_sources(source_id,source_namespace,contract_version) VALUES(?,?,1)')
    .bind(sourceId, sourceNamespace).run();
  await target().prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,10,1,'active')")
    .bind(sourceId, ownerDigest).run();
}
beforeEach(async () => { await reset(); await initialize(); });

const metadata = { quotaRowsRead: 3, ownerRevision: 10 };
async function stored(): Promise<void> {
  await writeGraphDayProjection({ target: target(), key: key(), projection: projection(), effectiveQuota: metadata });
}
async function daily(revision: number, digest = manifestDigest, complete = 1,
  fingerprint = canonicalJson({ method: 'effective-daily-cursor-v2', dependencyDigest: digest,
    streams: { quota: null, session: null, usage: null } })): Promise<void> {
  await target().prepare(`INSERT INTO analytics_community_daily_owners
    (source_id,day,owner_digest,input_revision,owner_revision,source_format,method,progress_revision,
      next_index,fingerprint,complete,values_json) VALUES(?,?,?,1,?,'effective','synthetic',1,0,?,?,'{}')
    ON CONFLICT(source_id,day,owner_digest) DO UPDATE SET owner_revision=excluded.owner_revision,
      fingerprint=excluded.fingerprint,complete=excluded.complete`)
    .bind(sourceId, day, ownerDigest, revision, fingerprint, complete).run();
}
async function valuesCount(): Promise<number | null> {
  return target().prepare('SELECT COUNT(*) AS n FROM analytics_graph_day_values').first<number>('n');
}
const retire = (options: { limit?: number; acquisitionVersion?: string; nowMs?: number } = {}) =>
  retireGraphDayProjectionPage(target(), sourceId, { nowMs: dayMs, ...options });

describe('effective graph day store migration', () => {
  it('refuses effective staging before migration and preserves legacy keys, bytes and guards', async () => {
    await reset();
    await initialize(b.TEST_ANALYTICS_MIGRATIONS.filter(migration => migration.name < '0028_'));
    expect(await graphDayEffectiveQuotaSupported(target())).toBe(false);
    const value = projection(), oldKey = await graphDayProjectionValueKey(legacy());
    const prior = await writeGraphDayProjection({ target: target(), key: legacy(), projection: value });
    const priorRows = (await target().prepare('SELECT * FROM analytics_graph_day_values').all()).results;
    const priorPages = (await target().prepare('SELECT * FROM analytics_graph_day_pages ORDER BY part_index').all()).results;
    expect((await readGraphDayProjection({ target: target(), key: legacy() })).status).toBe('ready');
    await expect(writeGraphDayProjection({ target: target(), key: key(), projection: projection(1200),
      effectiveQuota: { quotaRowsRead: 1200, ownerRevision: 10 }, maxWrites: 2 }))
      .rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
    expect((await target().prepare('SELECT * FROM analytics_graph_day_pages ORDER BY part_index').all()).results)
      .toEqual(priorPages);
    // Retirement itself remains callable against the old schema.
    expect(await retireGraphDayProjectionPage(target(), 'another-source', { nowMs: dayMs })).toMatchObject({ state: 'idle' });
    await applyD1Migrations(target(), b.TEST_ANALYTICS_MIGRATIONS);
    expect(await graphDayEffectiveQuotaSupported(target())).toBe(true);
    const after = (await target().prepare('SELECT * FROM analytics_graph_day_values').all<Record<string, unknown>>()).results;
    expect(after.map(({ quota_rows_read, effective_owner_revision, ...row }) => {
      expect(quota_rows_read).toBeNull(); expect(effective_owner_revision).toBeNull(); return row;
    })).toEqual(priorRows);
    expect((await target().prepare('SELECT * FROM analytics_graph_day_pages ORDER BY part_index').all()).results)
      .toEqual(priorPages);
    expect(await graphDayProjectionValueKey(legacy())).toBe(oldKey);
    expect(await target().prepare('SELECT values_digest FROM analytics_graph_day_values').first('values_digest'))
      .toBe(await sha256Hex(canonicalJson(value)));
    expect(await writeGraphDayProjection({ target: target(), key: legacy(), projection: value })).toEqual(prior);
    await expect(target().prepare('UPDATE analytics_graph_day_values SET record_count=0').run())
      .rejects.toThrow('analytics_graph_day_value_conflict');
    await expect(target().prepare('DELETE FROM analytics_graph_day_pages').run())
      .rejects.toThrow('analytics_graph_day_page_retained');
  });

  it('requires both metadata columns and the final contract marker before effective staging', async () => {
    await target().prepare('DROP TRIGGER analytics_graph_day_effective_quota_contract').run();
    expect(await graphDayEffectiveQuotaSupported(target())).toBe(false);
    await expect(writeGraphDayProjection({ target: target(), key: key(), projection: projection(), effectiveQuota: metadata }))
      .rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
    expect(await target().prepare('SELECT COUNT(*) AS n FROM analytics_graph_day_pages').first('n')).toBe(0);
    expect((await writeGraphDayProjection({ target: target(), key: legacy(), projection: projection() })).status).toBe('stored');
  });
});

describe('effective quota metadata and immutable replay', () => {
  it('round-trips the count and reuses identical content after an unrelated owner revision', async () => {
    await stored();
    const result = await readGraphDayProjection({ target: target(), key: key() });
    expect(result).toMatchObject({ status: 'ready', effectiveQuota: metadata });
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(canonicalJson(result.projection)).toBe(canonicalJson(projection()));
    expect(await target().prepare('SELECT values_digest FROM analytics_graph_day_values').first('values_digest'))
      .toBe(await sha256Hex(canonicalJson({ projection: projection(), quotaRowsRead: 3 })));
    expect(await writeGraphDayProjection({ target: target(), key: key(), projection: projection(),
      effectiveQuota: { quotaRowsRead: 3, ownerRevision: 11 } })).toMatchObject({ status: 'stored', valueKey: result.valueKey });
    expect(await valuesCount()).toBe(1);
    expect(await target().prepare('SELECT effective_owner_revision FROM analytics_graph_day_values').first('effective_owner_revision'))
      .toBe(10);
    await expect(writeGraphDayProjection({ target: target(), key: key(), projection: projection(),
      effectiveQuota: { quotaRowsRead: 4, ownerRevision: 11 } })).rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
  });

  it('resumes staged effective payloads and detects a tampered count in a load cursor', async () => {
    const value = projection(1200), effectiveQuota = { quotaRowsRead: 1200, ownerRevision: 10 };
    let written = await writeGraphDayProjection({ target: target(), key: key(), projection: value, effectiveQuota, maxWrites: 2 });
    expect(written.status).toBe('staging');
    for (let attempt = 0; written.status === 'staging' && attempt < 16; attempt++) {
      written = await writeGraphDayProjection({ target: target(), key: key(), projection: value, effectiveQuota,
        maxWrites: 2, cursor: written.cursor });
    }
    expect(written.status).toBe('stored');
    const first = await readGraphDayProjection({ target: target(), key: key(), maxParts: 1 });
    expect(first.status).toBe('deferred');
    if (first.status !== 'deferred') throw new Error('expected deferred');
    first.cursor.effectiveQuota = { ...effectiveQuota, quotaRowsRead: 1199 };
    await expect(readGraphDayProjection({ target: target(), key: key(), cursor: first.cursor, maxParts: 32 }))
      .rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
    const intact = await readGraphDayProjection({ target: target(), key: key(), maxParts: 32 });
    expect(intact).toMatchObject({ status: 'ready', effectiveQuota });
    if (intact.status !== 'ready') throw new Error('expected ready');
    expect(canonicalJson(intact.projection)).toBe(canonicalJson(value));
  });

  it('keeps the layout constants and metadata vocabulary closed', async () => {
    for (const invalid of [undefined, { quotaRowsRead: -1, ownerRevision: 10 },
      { quotaRowsRead: 3, ownerRevision: 0 }, { quotaRowsRead: 3.5, ownerRevision: 10 },
      { quotaRowsRead: Number.MAX_SAFE_INTEGER + 1, ownerRevision: 10 },
      { quotaRowsRead: 3, ownerRevision: 10, extra: true }]) {
      await expect(writeGraphDayProjection({ target: target(), key: key(), projection: projection(), effectiveQuota: invalid }))
        .rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
    }
    await expect(writeGraphDayProjection({ target: target(), key: legacy(), projection: projection(), effectiveQuota: metadata }))
      .rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
    for (const bad of [key({ deviceId: 'synthetic-device' }), key({ manifestId: 'synthetic-manifest' }), key({ sourceNamespace: '' })]) {
      await expect(writeGraphDayProjection({ target: target(), key: bad, projection: projection(), effectiveQuota: metadata }))
        .rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
    }
    expect(await target().prepare('SELECT COUNT(*) AS n FROM analytics_graph_day_pages').first('n')).toBe(0);
  });

  it('enforces effective-only integer metadata in SQL independently of the writer', async () => {
    await stored();
    const original = await target().prepare('SELECT * FROM analytics_graph_day_values').first<Record<string, unknown>>();
    if (!original) throw new Error('expected stored row');
    await target().prepare('DELETE FROM analytics_graph_day_values').run();
    const columns = ['value_key', 'source_id', 'source_layout', 'source_namespace', 'owner_digest', 'device_id',
      'manifest_id', 'manifest_digest', 'day', 'acquisition_version', 'record_count', 'part_count',
      'values_digest', 'quota_rows_read', 'effective_owner_revision'];
    const insert = (overrides: Record<string, unknown>) => {
      const row = { ...original, ...overrides };
      return target().prepare(`INSERT INTO analytics_graph_day_values (${columns.join(',')})
        VALUES(${columns.map(() => '?').join(',')})`).bind(...columns.map(column => row[column])).run();
    };
    for (const invalid of [{ quota_rows_read: null }, { quota_rows_read: -1 }, { quota_rows_read: 0.5 },
      { quota_rows_read: Number.MAX_SAFE_INTEGER + 1 }, { effective_owner_revision: null },
      { effective_owner_revision: 0 }, { device_id: 'synthetic-device' },
      { manifest_id: 'synthetic-manifest' }, { source_layout: 'typed-v11' }]) {
      await expect(insert(invalid)).rejects.toThrow();
    }
    await insert({});
    expect(await valuesCount()).toBe(1);
  });
});

describe('effective prepared day retirement', () => {
  it('preserves an absent or lagging daily identity and retires only a current changed dependency', async () => {
    await stored();
    expect(await retire()).toMatchObject({ state: 'idle' });
    await daily(9, 'c'.repeat(64));
    expect(await retire()).toMatchObject({ state: 'idle' });
    await daily(10, 'c'.repeat(64), 0);
    expect(await retire()).toMatchObject({ state: 'idle' });
    await daily(11, manifestDigest);
    expect(await retire()).toMatchObject({ state: 'idle' });
    await daily(11, 'c'.repeat(64));
    expect(await retire()).toMatchObject({ state: 'retiring', values: 1 });
    expect(await valuesCount()).toBe(0);
    expect(await target().prepare('SELECT COUNT(*) AS n FROM analytics_graph_day_pages').first('n')).toBe(0);
  });

  it('does not treat a malformed or open daily fingerprint as invalidation evidence', async () => {
    await stored();
    const valid = { method: 'effective-daily-cursor-v2', dependencyDigest: 'c'.repeat(64),
      streams: { quota: null, session: null, usage: null } };
    for (const fingerprint of ['not-json', '{}', canonicalJson({ ...valid, extra: 1 }),
      canonicalJson({ ...valid, dependencyDigest: 'c' }), canonicalJson({ ...valid, streams: {} }),
      canonicalJson({ ...valid, method: 'effective-daily-cursor-v1' })]) {
      await daily(11, 'c'.repeat(64), 1, fingerprint);
      expect(await retire()).toMatchObject({ state: 'idle' });
    }
  });

  it.each(['namespace', 'kernel', 'erasure'] as const)('retires effective payload after %s invalidation', async reason => {
    if (reason === 'namespace') {
      await writeGraphDayProjection({ target: target(), key: key({ sourceNamespace: 'synthetic-other-namespace' }),
        projection: projection(), effectiveQuota: metadata });
    } else await stored();
    if (reason === 'erasure') {
      await target().prepare(`INSERT INTO analytics_storage_erasure_fences
        (source_id,owner_digest,terminal_event_digest,terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch)
        VALUES(?,?,?,11,11,2,2)`).bind(sourceId, ownerDigest, 'd'.repeat(64)).run();
    }
    expect(await retire(reason === 'kernel' ? { acquisitionVersion: 'graph-day-projection-v2' } : {}))
      .toMatchObject({ state: 'retiring', values: 1 });
    expect(await valuesCount()).toBe(0);
    if (reason === 'erasure') await expect(stored()).rejects.toThrow('storage_owner_erased');
  });

  it('retires effective days strictly outside the oldest reachable input at the UTC boundary', async () => {
    for (const preparedDay of ['2026-04-10', '2026-04-11', '2026-04-12']) {
      await writeGraphDayProjection({ target: target(), key: key({ day: preparedDay }),
        projection: projection(3, preparedDay), effectiveQuota: metadata });
    }
    const days = async () => (await target().prepare('SELECT day FROM analytics_graph_day_values ORDER BY day')
      .all<{ day: string }>()).results.map(row => row.day);
    expect(await retire({ nowMs: Date.parse('2026-09-27T23:59:59.999Z') }))
      .toMatchObject({ state: 'retiring', values: 1 });
    expect(await days()).toEqual(['2026-04-11', '2026-04-12']);
    expect(await retire({ nowMs: Date.parse('2026-09-28T00:00:00.000Z') }))
      .toMatchObject({ state: 'retiring', values: 1 });
    expect(await days()).toEqual(['2026-04-12']);
    expect(await retire({ nowMs: Date.parse('2026-09-28T23:59:59.999Z') })).toMatchObject({ state: 'idle' });
  });

  it('deletes expired values before bounded orphan pages and preserves source and daily state', async () => {
    const expiredDay = '2026-04-10';
    await writeGraphDayProjection({ target: target(), key: key({ day: expiredDay }),
      projection: projection(1200, expiredDay), effectiveQuota: { quotaRowsRead: 1200, ownerRevision: 10 } });
    await daily(10);
    await target().prepare('UPDATE analytics_community_daily_owners SET day=?').bind(expiredDay).run();
    const pages = async () => target().prepare('SELECT COUNT(*) AS n FROM analytics_graph_day_pages').first<number>('n');
    const before = await pages();
    expect(before).toBeGreaterThan(1);
    const options = { nowMs: Date.parse('2026-09-27T12:00:00.000Z'), limit: 1 };
    expect(await retire(options)).toMatchObject({ state: 'retiring', values: 1, pages: 1 });
    expect(await valuesCount()).toBe(0);
    expect(await pages()).toBe(before! - 1);
    for (let remaining = before! - 1; remaining > 0; remaining--) {
      expect(await retire(options)).toMatchObject({ state: 'retiring', values: 0, pages: 1 });
    }
    expect(await retire(options)).toMatchObject({ state: 'idle' });
    expect(await target().prepare('SELECT COUNT(*) AS n FROM analytics_community_daily_owners').first('n')).toBe(1);
    expect(await target().prepare('SELECT day FROM analytics_community_daily_owners').first('day')).toBe(expiredDay);
    expect(await target().prepare('SELECT COUNT(*) AS n FROM analytics_owner_state').first('n')).toBe(1);
    expect(await target().prepare('SELECT COUNT(*) AS n FROM analytics_runtime_sources').first('n')).toBe(1);
  });

  it('preserves old legacy prepared days whose delivered manifest remains valid', async () => {
    const oldKey = { ...legacy(), day: '2026-04-10' }, registry = 'c'.repeat(64);
    const values = canonicalJson({ counts: { quota: 0, session: 0, usage: 1 }, day: oldKey.day,
      pricingMethodVersion: 'synthetic-pricing', registrySha256: registry, schemaVersion: 'synthetic-values-v1' });
    await target().prepare(`INSERT INTO analytics_v11_reusable_values
      (value_key,source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,day,
        schema_version,pricing_method,registry_sha256,record_count,values_digest,values_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(await sha256Hex(`synthetic-legacy-retention:${oldKey.day}`), sourceId, oldKey.sourceLayout, sourceNamespace,
        ownerDigest, oldKey.deviceId, oldKey.manifestId, oldKey.manifestDigest, oldKey.day, 'synthetic-values-v1',
        'synthetic-pricing', registry, 1, await sha256Hex(values), values).run();
    await writeGraphDayProjection({ target: target(), key: oldKey, projection: projection(3, oldKey.day) });
    expect(await retire({ nowMs: Date.parse('2026-09-27T12:00:00.000Z') })).toMatchObject({ state: 'idle' });
    expect((await readGraphDayProjection({ target: target(), key: oldKey })).status).toBe('ready');
  });

  it('refuses an invalid retirement clock before changing stored values or pages', async () => {
    await stored();
    const before = (await target().prepare('SELECT * FROM analytics_graph_day_pages').all()).results;
    for (const nowMs of [NaN, Infinity, -Infinity, 8.64e15 + 1]) {
      await expect(retire({ nowMs })).rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
      expect(await valuesCount()).toBe(1);
      expect((await target().prepare('SELECT * FROM analytics_graph_day_pages').all()).results).toEqual(before);
    }
  });
});

describe('bounded effective quota manifest windows', () => {
  const request = () => ({ target: target(), sourceId, sourceNamespace, ownerDigest, fromDay: day, throughDay: day });
  const rowsTarget = (rows: unknown[]): D1Database => ({ prepare: () => ({ bind: () => ({
    all: async () => ({ success: true, results: rows }),
  }) }) }) as unknown as D1Database;
  async function headRow(): Promise<Record<string, unknown>> {
    const row = await target().prepare(`SELECT g.*,
      (SELECT SUM(entry_count) FROM analytics_graph_day_pages p
        WHERE p.value_key=g.value_key AND component='fitFragments') AS fit_fragment_count,
      (SELECT SUM(length(CAST(payload_json AS BLOB))) FROM analytics_graph_day_pages p
        WHERE p.value_key=g.value_key) AS payload_bytes
      FROM analytics_graph_day_values g`).first<Record<string, unknown>>();
    if (!row) throw new Error('expected stored head');
    return row;
  }

  it('matches ordinary reads using one head statement and no second manifest read', async () => {
    await stored();
    const ordinary = await readGraphDayProjection({ target: target(), key: key() });
    const statements: string[] = [];
    const observed = new Proxy(target(), { get(database, name) {
      if (name === 'prepare') return (sql: string) => { statements.push(sql); return database.prepare(sql); };
      const member = Reflect.get(database, name);
      return typeof member === 'function' ? member.bind(database) : member;
    } });
    const heads = await readGraphDayEffectiveQuotaHeads({ ...request(), target: observed });
    expect(heads).toHaveLength(1); expect(statements).toHaveLength(1);
    const head = heads![0]!;
    expect(head).toMatchObject({ key: key(), fitFragmentCount: projection().fitFragments.fragments.length,
      cursor: { loaded: 0, components: {}, effectiveQuota: metadata } });
    expect(head.payloadBytes).toBe((await headRow()).payload_bytes);
    const result = await readGraphDayProjection({ target: observed, key: head.key, cursor: head.cursor, maxParts: 32 });
    expect(result).toEqual(ordinary);
    expect(statements).toHaveLength(2);
    expect(statements[1]).toContain('FROM analytics_graph_day_pages');
  });

  it('keeps owner, namespace, source layout and day scope separate', async () => {
    await stored();
    await writeGraphDayProjection({ target: target(), key: legacy(), projection: projection() });
    for (const other of [key({ ownerDigest: 'c'.repeat(64) }), key({ sourceNamespace: 'synthetic-other-namespace' }),
      key({ day: '2026-09-11' })]) {
      await writeGraphDayProjection({ target: target(), key: other,
        projection: reduceGraphDayProjection(other.day, []), effectiveQuota: { quotaRowsRead: 0, ownerRevision: 10 } });
    }
    const heads = await readGraphDayEffectiveQuotaHeads(request());
    expect(heads).toHaveLength(1); expect(heads![0]!.key).toEqual(key());
    expect(await readGraphDayEffectiveQuotaHeads({ ...request(), sourceId: 'synthetic-another-source' })).toEqual([]);
  });

  it('validates every head identity, digest, count and metadata field before exposing a cursor', async () => {
    await stored();
    const original = await headRow();
    for (const corrupt of [{ source_id: 'synthetic-other-source' }, { source_namespace: 'synthetic-other-namespace' },
      { owner_digest: 'c'.repeat(64) }, { source_layout: 'typed-v11' }, { day: '2026-09-11' },
      { device_id: 'synthetic-device' }, { manifest_id: 'synthetic-manifest' },
      { manifest_digest: 'c'.repeat(64) }, { value_key: 'c'.repeat(64) }, { values_digest: 'not-a-digest' },
      { acquisition_version: 'graph-day-projection-v2' }, { part_count: 0 }, { part_count: 4097 },
      { record_count: -1 }, { quota_rows_read: null }, { effective_owner_revision: 0 },
      { fit_fragment_count: -1 }, { fit_fragment_count: Number.MAX_SAFE_INTEGER }, { payload_bytes: 0 }]) {
      await expect(readGraphDayEffectiveQuotaHeads({ ...request(), target: rowsTarget([{ ...original, ...corrupt }]) }))
        .rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
    }
    const head = (await readGraphDayEffectiveQuotaHeads(request()))![0]!;
    head.cursor.digest = 'c'.repeat(64);
    await expect(readGraphDayProjection({ target: target(), key: head.key, cursor: head.cursor, maxParts: 32 }))
      .rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
  });

  it('declines overflowing head windows instead of silently truncating coverage', async () => {
    await stored();
    await writeGraphDayProjection({ target: target(), key: key({ manifestDigest: 'c'.repeat(64) }),
      projection: projection(), effectiveQuota: metadata });
    expect(await readGraphDayEffectiveQuotaHeads({ ...request(), limit: 1 })).toBeUndefined();
    expect(await readGraphDayEffectiveQuotaHeads({ ...request(), limit: 2 })).toHaveLength(2);
    const row = await headRow();
    expect(await readGraphDayEffectiveQuotaHeads({ ...request(), target: rowsTarget(Array(1025).fill(row)) }))
      .toBeUndefined();
    await expect(readGraphDayEffectiveQuotaHeads({ ...request(), limit: 1025 }))
      .rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
    await expect(readGraphDayEffectiveQuotaHeads({ ...request(), throughDay: '2026-09-09' }))
      .rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
  });
});
