import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/canonical-json';
import { sha256Hex } from '../src/crypto';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { createModelBlockCheckpoint, createModelBlockSelection, modelBlockInputDays, modelBlockOutputDays,
  planHistoricalModelBlockRanges, MODEL_BLOCK_METHOD,
  validModelBlockCheckpoint, type ModelBlockCheckpoint, type ModelBlockIdentity } from '../src/analytics-model-block-contract';
import { reduceGraphDayProjection } from '../src/graph-day-projection';
import { modelBlockStoreSupported, modelBlockJobKey, ensureModelBlockJob, claimModelBlockJob,
  readModelBlockJob, saveModelBlockJob, releaseModelBlockJob, retireModelBlockJobs,
  prepareModelBlockAdmission, readRebasableModelBlockCheckpoint, retireObsoleteModelBlockPage,
  MODEL_BLOCK_MAX_STORED_JOBS } from '../src/storage-analytics-model-block';

const b = env as Env & { STORAGE_ANALYTICS_DB: D1Database; TEST_ANALYTICS_MIGRATIONS: D1Migration[] };
const target = () => b.STORAGE_ANALYTICS_DB, NOW = Date.parse('2026-09-28T12:00:00Z');
const identity = (patch: Partial<ModelBlockIdentity> = {}): ModelBlockIdentity => ({ version: 1, method: MODEL_BLOCK_METHOD,
  sourceId: 'synthetic-model-store', sourceNamespace: 'synthetic-model-namespace', ownerDigest: 'a'.repeat(64),
  ownerRevision: 1, authorityEpoch: 1, inputRevision: 1, authorityDigest: 'b'.repeat(64),
  outputFromDay: '2026-09-20', outputThroughDay: '2026-09-21', ...patch });
const scope = (id = identity(), db = target()) => ({ target: db, identity: id });
const initial = (id = identity()) => createModelBlockCheckpoint(id, modelBlockInputDays(id)
  .map(day => ({ day, digest: 'c'.repeat(64), hasQuota: false, hasUsage: false })));
const progressed = (id = identity()): ModelBlockCheckpoint => ({ ...initial(id), inputIndex: 1 });
const completed = (id = identity()): ModelBlockCheckpoint => ({ ...initial(id), phase: 'complete',
  inputIndex: modelBlockInputDays(id).length, outputs: modelBlockOutputDays(id).map(day => ({ day,
    fingerprint: 'd'.repeat(64), value: { status: 'not_testable', reason: 'supported_quota_track_unavailable' } })) });
function pendingCheckpoint(stream: 'quota' | 'usage' = 'usage'): ModelBlockCheckpoint {
  const day = modelBlockInputDays(identity())[0]!, at = Date.parse(`${day}T00:00:00Z`),
    empty = reduceGraphDayProjection(day, []), usageRows = stream === 'quota' ? 0 : 3;
  return { ...initial(), pending: { day, stream, after: { observedAtMs: at + 10, occurrenceId: 'occurrence:0002' },
    quota: { day, quotaRowsRead: 2, rows: [0, 1].map(index => ({ sourceRowId: index + 1,
      observedAtMs: at + 9 + index, anchor: null, row: null })) },
    usage: { projection: { ...empty, usage: { ...empty.usage, rowsRead: usageRows } },
      lastObservedAtMs: usageRows === 0 ? null : at + 10 } } };
}
const count = (table: string) => target().prepare(`SELECT COUNT(*) n FROM ${table}`).first<number>('n');
async function initialize(migrations = b.TEST_ANALYTICS_MIGRATIONS) {
  await applyD1Migrations(target(), migrations);
  const id = identity();
  await target().prepare('INSERT INTO analytics_runtime_sources(source_id,source_namespace,contract_version) VALUES(?,?,1)')
    .bind(id.sourceId, id.sourceNamespace).run();
  await target().prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')")
    .bind(id.sourceId, id.ownerDigest).run();
}
const ensure = (id = identity(), value = initial(id), db = target()) => ensureModelBlockJob({ ...scope(id, db), initial: value, now: NOW });
const claim = (now = NOW + 1, leaseMs = 60_000) => claimModelBlockJob({ ...scope(), now, leaseMs });
async function alterWithTrigger(trigger: string, mutate: () => Promise<unknown>) {
  const sql = await target().prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").bind(trigger).first<string>('sql');
  if (!sql) throw new Error('synthetic missing trigger');
  await target().prepare(`DROP TRIGGER ${trigger}`).run();
  try { await mutate(); } finally { await target().prepare(sql).run(); }
}
function interceptBatch(run: (db: D1Database, statements: D1PreparedStatement[]) => Promise<D1Result[]>): D1Database {
  return new Proxy(target(), { get(db, key) {
    if (key === 'batch') return (statements: D1PreparedStatement[]) => run(db, statements);
    const value = Reflect.get(db, key); return typeof value === 'function' ? value.bind(db) : value;
  } });
}
beforeEach(async () => { await reset(); await initialize(); });

describe('experimental model block migration and capability', () => {
  it('refuses pre-migration without writes, and preserves existing target state through upgrade', async () => {
    await reset(); await initialize(b.TEST_ANALYTICS_MIGRATIONS.filter(m => m.name < '0030_'));
    const owners = (await target().prepare('SELECT * FROM analytics_owner_state').all()).results;
    const runtime = (await target().prepare('SELECT * FROM analytics_runtime_sources').all()).results;
    expect(await modelBlockStoreSupported(target())).toBe(false);
    expect(await ensure()).toBe(false); expect(await claim()).toBeNull();
    expect(await readModelBlockJob(scope())).toBeNull();
    await applyD1Migrations(target(), b.TEST_ANALYTICS_MIGRATIONS);
    expect(await modelBlockStoreSupported(target())).toBe(true);
    expect((await target().prepare('SELECT * FROM analytics_owner_state').all()).results).toEqual(owners);
    expect((await target().prepare('SELECT * FROM analytics_runtime_sources').all()).results).toEqual(runtime);
    expect(await count('analytics_model_blocks')).toBe(0);
    expect(await count('analytics_model_block_parts')).toBe(0);
    expect((await target().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(await ensure()).toBe(true);
  });
  it('preserves a complete 0030 job, part and two-range policy across the 0031 upgrade', async () => {
    await reset(); await initialize(b.TEST_ANALYTICS_MIGRATIONS.filter(m => m.name < '0031_'));
    const dayMs = 86_400_000, todayIndex = Math.floor(NOW / dayMs / 32) * 32;
    const today = new Date(todayIndex * dayMs).toISOString().slice(0, 10);
    const now = todayIndex * dayMs + 12 * 3_600_000;
    const full = planHistoricalModelBlockRanges(today).filter(range => modelBlockOutputDays(identity(range)).length === 32);
    expect(full).toHaveLength(2);
    const id = identity(full[0]), key = await modelBlockJobKey(id), checkpoint = completed(id);
    const json = canonicalJson(checkpoint), bytes = new TextEncoder().encode(json).byteLength;
    expect(await modelBlockStoreSupported(target())).toBe(false);
    await target().prepare(`INSERT INTO analytics_model_block_policy
      (source_id,owner_digest,policy_revision,source_namespace,owner_revision,authority_epoch,input_revision,
        method,authority_digest,today_day,range0_from,range0_through,range1_from,range1_through,updated_ms)
      VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id.sourceId, id.ownerDigest, id.sourceNamespace, id.ownerRevision, id.authorityEpoch,
        id.inputRevision, id.method, id.authorityDigest, today, full[0]!.outputFromDay,
        full[0]!.outputThroughDay, full[1]!.outputFromDay, full[1]!.outputThroughDay, now).run();
    await target().prepare(`INSERT INTO analytics_model_blocks
      (job_key,identity_json,source_id,source_namespace,owner_digest,authority_epoch,admission_revision,updated_ms)
      VALUES(?,?,?,?,?,?,1,?)`).bind(key, canonicalJson(id), id.sourceId, id.sourceNamespace,
        id.ownerDigest, id.authorityEpoch, now).run();
    await target().prepare(`INSERT INTO analytics_model_block_parts
      (job_key,source_id,owner_digest,revision,part_index,payload,payload_bytes,payload_sha256,saved_ms)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(key, id.sourceId, id.ownerDigest, 1, 0, json, bytes,
        await sha256Hex(json), now).run();
    await target().prepare(`UPDATE analytics_model_blocks SET head_revision=1,state='complete',
      checkpoint_digest=?,checkpoint_bytes=?,part_count=1 WHERE job_key=?`)
      .bind(await sha256Hex(json), bytes, key).run();
    const before = (await target().prepare('SELECT * FROM analytics_model_blocks').all()).results;
    const partBefore = (await target().prepare('SELECT * FROM analytics_model_block_parts').all()).results;
    await applyD1Migrations(target(), b.TEST_ANALYTICS_MIGRATIONS);
    expect(await modelBlockStoreSupported(target())).toBe(true);
    expect((await target().prepare('SELECT * FROM analytics_model_blocks').all()).results).toEqual(before);
    expect((await target().prepare('SELECT * FROM analytics_model_block_parts').all()).results).toEqual(partBefore);
    expect((await target().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    const token = (await prepareModelBlockAdmission({ target: target(), identity: id,
      todayDay: today, now, assertSourceCurrent: async () => {} }))!;
    expect(token.revision).toBe(2);
    expect(await readModelBlockJob({ ...scope(id), historicalTodayDay: today,
      admission: token })).toEqual({ revision: 1, checkpoint });
  });
  it.each(['analytics_model_block_contract_v1', 'analytics_model_block_admission_v2',
    'analytics_model_block_policy_insert',
    'analytics_model_block_clipped_ranges_v1', 'analytics_model_block_clipped_ranges_update_v1',
    'analytics_model_block_parts_insert'])
    ('refuses a partial migration missing %s before staging payload', async trigger => {
      await target().prepare(`DROP TRIGGER ${trigger}`).run();
      expect(await modelBlockStoreSupported(target())).toBe(false); expect(await ensure()).toBe(false);
      expect(await count('analytics_model_blocks')).toBe(0); expect(await count('analytics_model_block_parts')).toBe(0);
    });
  it('binds the exact immutable identity and does not rewind an existing head', async () => {
    const id = identity();
    expect(await modelBlockJobKey(id)).toBe(await sha256Hex(canonicalJson(id)));
    expect(await modelBlockJobKey({ ...id, ownerRevision: 2 })).not.toBe(await modelBlockJobKey(id));
    await expect(modelBlockJobKey({ ...id, extra: true } as ModelBlockIdentity)).rejects.toThrow('MODEL_BLOCK_STORE_INVALID');
    expect(await ensure(identity({ sourceNamespace: 'wrong' }))).toBe(false);
    expect(await ensure(identity({ ownerDigest: 'e'.repeat(64) }))).toBe(false);
    await ensure(); const held = (await claim())!;
    expect(await saveModelBlockJob({ ...scope(), claim: held, checkpoint: progressed(), now: NOW + 2 })).toBe(true);
    expect(await ensure()).toBe(true);
    expect(await readModelBlockJob(scope())).toEqual({ revision: 2, checkpoint: progressed() });
    await expect(target().prepare("UPDATE analytics_model_blocks SET identity_json='{}'").run()).rejects.toThrow('analytics_model_block_ineligible');
    await expect(target().prepare('DELETE FROM analytics_model_block_parts').run()).rejects.toThrow('analytics_model_block_part_retained');
  });
});

describe('model block claims, atomic save and retry', () => {
  it('reads only an unleased committed older-revision checkpoint under current target authority', async () => {
    const old = identity(), newer = identity({ ownerRevision: 2, inputRevision: 2 });
    const partial: ModelBlockCheckpoint = { ...createModelBlockSelection(old),
      dependencies: initial(old).dependencies.slice(0, 16) };
    expect(await ensure(old, partial)).toBe(true);
    const held = await claim(NOW + 1, 100);
    expect(held).not.toBeNull();
    await target().prepare(`UPDATE analytics_owner_state SET revision=2
      WHERE source_id=? AND owner_digest=?`).bind(old.sourceId, old.ownerDigest).run();
    expect(await readRebasableModelBlockCheckpoint({ target: target(), identity: newer,
      now: NOW + 50 })).toBeNull();
    expect(await readRebasableModelBlockCheckpoint({ target: target(), identity: newer,
      now: NOW + 101 })).toEqual(partial);
    await target().prepare(`INSERT INTO analytics_storage_erasure_fences VALUES(?,?,?,?,?,?,?)`)
      .bind(old.sourceId, old.ownerDigest, 'd'.repeat(64), 1, 1, 1, 1).run();
    expect(await readRebasableModelBlockCheckpoint({ target: target(), identity: newer,
      now: NOW + 101 })).toBeNull();
  });
  it('extends an exact selection prefix and cannot reopen selection after acquisition', async () => {
    const empty = createModelBlockSelection(identity()); await ensure(identity(), empty);
    const held = (await claim())!, partial: ModelBlockCheckpoint = { ...empty, dependencies: initial().dependencies.slice(0, 16) };
    expect(await saveModelBlockJob({ ...scope(), claim: held, checkpoint: partial, now: NOW + 2 })).toBe(true);
    const next = (await claim(NOW + 3))!;
    for (const checkpoint of [empty, { ...partial, dependencies: partial.dependencies.map((row, index) =>
      index === 0 ? { ...row, digest: 'e'.repeat(64) } : row) }]) {
      expect(validModelBlockCheckpoint(checkpoint, identity())).toBe(true);
      await expect(saveModelBlockJob({ ...scope(), claim: next, checkpoint, now: NOW + 4 }))
        .rejects.toThrow('MODEL_BLOCK_STORE_INVALID');
    }
    expect(await saveModelBlockJob({ ...scope(), claim: next, checkpoint: initial(), now: NOW + 4 })).toBe(true);
    const acquired = (await claim(NOW + 5))!;
    const selecting: ModelBlockCheckpoint = { ...initial(), phase: 'select' };
    expect(validModelBlockCheckpoint(selecting, identity())).toBe(true);
    await expect(saveModelBlockJob({ ...scope(), claim: acquired, checkpoint: selecting, now: NOW + 6 }))
      .rejects.toThrow('MODEL_BLOCK_STORE_INVALID');
  });
  it.each(['emit', 'fallback', 'complete'] as const)('can finish selection and reach %s in the same invocation', async phase => {
    const selected: ModelBlockCheckpoint = { ...createModelBlockSelection(identity()), dependencies: initial().dependencies.slice(0, 16) };
    await ensure(identity(), selected); const held = (await claim())!;
    const checkpoint: ModelBlockCheckpoint = phase === 'complete' ? completed() : { ...initial(), phase,
      inputIndex: phase === 'emit' ? initial().dependencies.length : 0 };
    expect(await saveModelBlockJob({ ...scope(), claim: held, checkpoint, now: NOW + 2 })).toBe(true);
  });
  it('has one concurrent claimant, and expires precisely without letting an old token save or release', async () => {
    await ensure(); const attempts = await Promise.all([claim(NOW + 1, 100), claim(NOW + 1, 100)]);
    const held = attempts.find(value => value !== null)!;
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await claim(NOW + 100)).toBeNull();
    const next = (await claim(NOW + 101))!;
    expect(next.token).not.toBe(held.token); expect(next.revision).toBe(held.revision);
    expect(await saveModelBlockJob({ ...scope(), claim: held, checkpoint: progressed(), now: NOW + 102 })).toBe(false);
    expect(await releaseModelBlockJob({ ...scope(), claim: held, now: NOW + 102 })).toBe(false);
    expect(await saveModelBlockJob({ ...scope(), claim: next, checkpoint: progressed(), now: NOW + 102 })).toBe(true);
    expect(await count('analytics_model_block_parts')).toBe(1);
    expect(await readModelBlockJob(scope())).toEqual({ revision: 2, checkpoint: progressed() });
  });
  it('releases cancellation without saving and makes complete outputs readable but unclaimable', async () => {
    await ensure(); const held = (await claim())!;
    expect(await releaseModelBlockJob({ ...scope(), claim: held, now: NOW + 2 })).toBe(true);
    expect(await readModelBlockJob(scope())).toEqual({ revision: 1, checkpoint: initial() });
    const next = (await claim(NOW + 3))!;
    expect(await saveModelBlockJob({ ...scope(), claim: next, checkpoint: completed(), now: NOW + 4 })).toBe(true);
    expect(await readModelBlockJob(scope())).toEqual({ revision: 2, checkpoint: completed() });
    expect(await claim(NOW + 5)).toBeNull(); expect(await ensure()).toBe(true);
  });
  it('reconciles an ambiguous committed response and exactly replays the successor once', async () => {
    await ensure(); const held = (await claim())!; let lost = false;
    const flaky = interceptBatch(async (db, statements) => {
      const result = await db.batch(statements); if (!lost) { lost = true; throw new Error('synthetic response loss'); } return result;
    });
    expect(await saveModelBlockJob({ ...scope(identity(), flaky), claim: held, checkpoint: completed(), now: NOW + 2 })).toBe(true);
    expect(await saveModelBlockJob({ ...scope(), claim: held, checkpoint: completed(), now: NOW + 3 })).toBe(true);
    expect(await readModelBlockJob(scope())).toEqual({ revision: 2, checkpoint: completed() });
    expect(await count('analytics_model_block_parts')).toBe(1);
  });
  it('rolls back all staged parts when a batch fails and resumes from the retained head', async () => {
    await ensure(); const held = (await claim())!;
    const broken = interceptBatch(async (db, statements) => db.batch([statements[0]!,
      db.prepare("INSERT INTO analytics_model_block_parts(job_key) VALUES('synthetic-invalid')"), ...statements.slice(1)]));
    await expect(saveModelBlockJob({ ...scope(identity(), broken), claim: held, checkpoint: progressed(), now: NOW + 2 })).rejects.toThrow();
    expect(await readModelBlockJob(scope())).toEqual({ revision: 1, checkpoint: initial() });
    expect(await count('analytics_model_block_parts')).toBe(1);
    expect(await saveModelBlockJob({ ...scope(), claim: held, checkpoint: progressed(), now: NOW + 3 })).toBe(true);
  });
  it('refuses stale time, expired claims, dependency changes and output-prefix rewrites', async () => {
    await ensure(); const held = (await claim(NOW + 10, 5))!;
    expect(await saveModelBlockJob({ ...scope(), claim: held, checkpoint: progressed(), now: NOW + 9 })).toBe(false);
    expect(await saveModelBlockJob({ ...scope(), claim: held, checkpoint: progressed(), now: NOW + 15 })).toBe(false);
    await expect(saveModelBlockJob({ ...scope(), claim: held, checkpoint: { ...progressed(), dependencies:
      initial().dependencies.map((row, index) => index === 0 ? { ...row, digest: 'e'.repeat(64) } : row) }, now: NOW + 11 }))
      .rejects.toThrow('MODEL_BLOCK_STORE_INVALID');
    const next = (await claim(NOW + 15))!;
    const prefix: ModelBlockCheckpoint = { ...completed(), phase: 'emit', outputs: completed().outputs.slice(0, 1) };
    await saveModelBlockJob({ ...scope(), claim: next, checkpoint: prefix, now: NOW + 16 });
    const last = (await claim(NOW + 17))!;
    await expect(saveModelBlockJob({ ...scope(), claim: last, checkpoint: { ...completed(), outputs:
      completed().outputs.map((row, index) => index === 0 ? { ...row, fingerprint: 'e'.repeat(64) } : row) }, now: NOW + 18 }))
      .rejects.toThrow('MODEL_BLOCK_STORE_INVALID');
    await expect(claim(Number.NaN)).rejects.toThrow('MODEL_BLOCK_STORE_INVALID');
  });
  it('keeps fallback sticky until a complete output block is saved', async () => {
    const fallback: ModelBlockCheckpoint = { ...initial(), phase: 'fallback' };
    await ensure(identity(), fallback); const held = (await claim())!;
    for (const checkpoint of [initial(), { ...initial(), phase: 'emit' as const,
      inputIndex: initial().dependencies.length }]) {
      expect(validModelBlockCheckpoint(checkpoint, identity())).toBe(true);
      await expect(saveModelBlockJob({ ...scope(), claim: held, checkpoint, now: NOW + 2 }))
        .rejects.toThrow('MODEL_BLOCK_STORE_INVALID');
    }
    expect(await saveModelBlockJob({ ...scope(), claim: held, checkpoint: fallback, now: NOW + 2 })).toBe(true);
    const next = (await claim(NOW + 3))!;
    expect(await saveModelBlockJob({ ...scope(), claim: next, checkpoint: completed(), now: NOW + 4 })).toBe(true);
  });
  it('continues emission or falls back without reopening acquisition', async () => {
    const emitting: ModelBlockCheckpoint = { ...initial(), phase: 'emit', inputIndex: initial().dependencies.length };
    await ensure(identity(), emitting); const held = (await claim())!;
    await expect(saveModelBlockJob({ ...scope(), claim: held, checkpoint: { ...emitting, phase: 'acquire' }, now: NOW + 2 }))
      .rejects.toThrow('MODEL_BLOCK_STORE_INVALID');
    const prefix: ModelBlockCheckpoint = { ...emitting, outputs: completed().outputs.slice(0, 1) };
    expect(await saveModelBlockJob({ ...scope(), claim: held, checkpoint: prefix, now: NOW + 2 })).toBe(true);
    const next = (await claim(NOW + 3))!;
    expect(await saveModelBlockJob({ ...scope(), claim: next, checkpoint: { ...prefix, phase: 'fallback' }, now: NOW + 4 })).toBe(true);
  });
  it('rejects same-day pending rewinds and keeps exact retries and forward cursors admissible', async () => {
    const prior = pendingCheckpoint(), p = prior.pending!, at = p.after!.observedAtMs;
    await ensure(identity(), prior); const held = (await claim())!;
    const invalid: ModelBlockCheckpoint[] = [
      { ...prior, pending: null },
      { ...prior, pending: { ...p, stream: 'quota' } },
      { ...prior, pending: { ...p, quota: { ...p.quota, quotaRowsRead: 1, rows: p.quota.rows.slice(0, 1) } } },
      { ...prior, pending: { ...p, usage: { ...p.usage, projection: { ...p.usage.projection,
        usage: { ...p.usage.projection.usage, rowsRead: 2 } } } } },
      { ...prior, pending: { ...p, after: null } },
      { ...prior, pending: { ...p, after: { observedAtMs: at - 1, occurrenceId: 'occurrence:9999' },
        usage: { ...p.usage, lastObservedAtMs: at - 1 } } },
      { ...prior, pending: { ...p, after: { observedAtMs: at, occurrenceId: 'occurrence:0001' } } },
      { ...prior, pending: { ...p, usage: { ...p.usage, projection: { ...p.usage.projection,
        usage: { ...p.usage.projection.usage, rowsRead: 4 } } } } },
    ];
    for (const checkpoint of invalid) {
      expect(validModelBlockCheckpoint(checkpoint, identity())).toBe(true);
      await expect(saveModelBlockJob({ ...scope(), claim: held, checkpoint, now: NOW + 2 }))
        .rejects.toThrow('MODEL_BLOCK_STORE_INVALID');
    }
    expect(await readModelBlockJob(scope())).toEqual({ revision: 1, checkpoint: prior });
    expect(await count('analytics_model_block_parts')).toBe(1);
    expect(await saveModelBlockJob({ ...scope(), claim: held, checkpoint: prior, now: NOW + 2 })).toBe(true);
    const next = (await claim(NOW + 3))!;
    const forward: ModelBlockCheckpoint = { ...prior, pending: { ...p,
      after: { observedAtMs: at, occurrenceId: 'occurrence:0003' },
      usage: { ...p.usage, projection: { ...p.usage.projection,
        usage: { ...p.usage.projection.usage, rowsRead: 4 } } } } };
    expect(await saveModelBlockJob({ ...scope(), claim: next, checkpoint: forward, now: NOW + 4 })).toBe(true);
    const store = (await claim(NOW + 5))!;
    expect(await saveModelBlockJob({ ...scope(), claim: store, checkpoint: { ...forward,
      pending: { ...forward.pending!, stream: 'store', after: null } }, now: NOW + 6 })).toBe(true);
    const done = (await claim(NOW + 7))!;
    expect(await saveModelBlockJob({ ...scope(), claim: done, checkpoint: progressed(), now: NOW + 8 })).toBe(true);
  });
  it('allows a cursor reset only when advancing from quota to usage for the same day', async () => {
    const prior = pendingCheckpoint('quota'); await ensure(identity(), prior); const held = (await claim())!;
    const usage: ModelBlockCheckpoint = { ...prior, pending: { ...prior.pending!, stream: 'usage', after: null } };
    expect(await saveModelBlockJob({ ...scope(), claim: held, checkpoint: usage, now: NOW + 2 })).toBe(true);
    const next = (await claim(NOW + 3))!;
    await expect(saveModelBlockJob({ ...scope(), claim: next, checkpoint: prior, now: NOW + 4 }))
      .rejects.toThrow('MODEL_BLOCK_STORE_INVALID');
  });
  it('atomically frames a large compact pending day beyond 30 parts and deletes obsolete revisions', async () => {
    await ensure(); const held = (await claim())!, day = modelBlockInputDays(identity())[0]!;
    const at = Date.parse(`${day}T00:00:00Z`);
    const pending: ModelBlockCheckpoint = { ...initial(), pending: { day, stream: 'quota', after: null,
      quota: { day, quotaRowsRead: 12_800, rows: Array.from({ length: 12_800 }, (_, i) => ({ sourceRowId: i + 1,
        observedAtMs: at + i, anchor: { contextKey: 'openai_codex|codex', observedAtMs: at + i,
          planType: 'pro', planVariant: 'x'.repeat(64), continuityId: null, conflicted: false,
          accountScopeId: null, planBasis: null }, row: null })) },
      usage: { lastObservedAtMs: null, projection: reduceGraphDayProjection(day, []) } } };
    expect(validModelBlockCheckpoint(pending, identity())).toBe(true);
    let batchLength = 0;
    const measured = interceptBatch(async (db, statements) => { batchLength = statements.length; return db.batch(statements); });
    expect(await saveModelBlockJob({ ...scope(identity(), measured), claim: held, checkpoint: pending, now: NOW + 2 })).toBe(true);
    expect(batchLength).toBeGreaterThan(32); expect(batchLength).toBeLessThanOrEqual(83);
    expect(await readModelBlockJob(scope())).toEqual({ revision: 2, checkpoint: pending });
    const parts = await target().prepare('SELECT MAX(payload_bytes) largest,COUNT(DISTINCT revision) revisions FROM analytics_model_block_parts')
      .first<{ largest: number; revisions: number }>();
    expect(parts!.largest).toBeLessThanOrEqual(128 * 1024); expect(parts!.revisions).toBe(1);
    const next = (await claim(NOW + 3))!;
    expect(await saveModelBlockJob({ ...scope(), claim: next, checkpoint: progressed(), now: NOW + 4 })).toBe(true);
    expect(await count('analytics_model_block_parts')).toBe(1);
  }, 20_000);
});

describe('model block corruption and owner fences', () => {
  it.each(['missing', 'part-hash', 'head-hash', 'closed-checkpoint'])('fails closed on %s corruption', async kind => {
    await ensure();
    if (kind === 'missing') await alterWithTrigger('analytics_model_block_parts_retained', () =>
      target().prepare('DELETE FROM analytics_model_block_parts').run());
    if (kind === 'part-hash') await alterWithTrigger('analytics_model_block_parts_immutable', () =>
      target().prepare("UPDATE analytics_model_block_parts SET payload_sha256=?").bind('f'.repeat(64)).run());
    if (kind === 'head-hash') await alterWithTrigger('analytics_model_blocks_update', () =>
      target().prepare('UPDATE analytics_model_blocks SET checkpoint_digest=?').bind('f'.repeat(64)).run());
    if (kind === 'closed-checkpoint') {
      const json = canonicalJson({ ...initial(), privateField: true }), bytes = new TextEncoder().encode(json).length,
        digest = await sha256Hex(json);
      await alterWithTrigger('analytics_model_block_parts_immutable', () => target().prepare(
        'UPDATE analytics_model_block_parts SET payload=?,payload_bytes=?,payload_sha256=?').bind(json, bytes, digest).run());
      await alterWithTrigger('analytics_model_blocks_update', () => target().prepare(
        'UPDATE analytics_model_blocks SET checkpoint_bytes=?,checkpoint_digest=?').bind(bytes, digest).run());
    }
    expect(await modelBlockStoreSupported(target())).toBe(true);
    await expect(readModelBlockJob(scope())).rejects.toThrow('MODEL_BLOCK_STORE_CORRUPT');
    await expect(claim()).rejects.toThrow('MODEL_BLOCK_STORE_CORRUPT');
    expect(await target().prepare('SELECT claim_token FROM analytics_model_blocks').first('claim_token')).toBeNull();
  });
  it.each(['withdrawn', 'epoch', 'erased', 'deleted'])('physically removes both payload tables on %s', async change => {
    await ensure(); const held = (await claim())!, id = identity();
    expect(await saveModelBlockJob({ ...scope(), claim: held, checkpoint: completed(), now: NOW + 2 })).toBe(true);
    if (change === 'withdrawn') await target().prepare("UPDATE analytics_owner_state SET state='withdrawn'").run();
    if (change === 'epoch') await target().prepare('UPDATE analytics_owner_state SET authority_epoch=2').run();
    if (change === 'deleted') await target().prepare('DELETE FROM analytics_owner_state').run();
    if (change === 'erased') await target().prepare(`INSERT INTO analytics_storage_erasure_fences
      (source_id,owner_digest,terminal_event_digest,terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch)
      VALUES(?,?,?,1,2,2,2)`).bind(id.sourceId, id.ownerDigest, 'f'.repeat(64)).run();
    expect(await count('analytics_model_blocks')).toBe(0); expect(await count('analytics_model_block_parts')).toBe(0);
    expect(await readModelBlockJob(scope())).toBeNull(); expect(await ensure()).toBe(false);
    expect(await saveModelBlockJob({ ...scope(), claim: held, checkpoint: progressed(), now: NOW + 3 })).toBe(false);
  });
  it('keeps other owners and rejects a late batch after authority changes', async () => {
    await ensure(); const held = (await claim())!;
    const other = identity({ ownerDigest: 'e'.repeat(64) });
    await target().prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')").bind(other.sourceId, other.ownerDigest).run();
    await ensure(other);
    const raced = interceptBatch(async (db, statements) => {
      await db.prepare('UPDATE analytics_owner_state SET authority_epoch=2 WHERE owner_digest=?').bind(identity().ownerDigest).run();
      return db.batch(statements);
    });
    expect(await saveModelBlockJob({ ...scope(identity(), raced), claim: held, checkpoint: progressed(), now: NOW + 2 })).toBe(false);
    expect(await readModelBlockJob(scope(other))).toEqual({ revision: 1, checkpoint: initial(other) });
    expect(await count('analytics_model_blocks')).toBe(1); expect(await count('analytics_model_block_parts')).toBe(1);
  });
  it('cleans prepared payload if the registered source namespace changes', async () => {
    await ensure(identity(), completed());
    await target().prepare('DROP TRIGGER analytics_runtime_source_immutable').run();
    await target().prepare("UPDATE analytics_runtime_sources SET source_namespace='synthetic-successor'").run();
    expect(await count('analytics_model_blocks')).toBe(0); expect(await count('analytics_model_block_parts')).toBe(0);
    expect(await ensure()).toBe(false);
  });
});

describe('bounded model block admission and physical retirement', () => {
  it('admits scheduled full blocks while preserving explicit direct short runs', async () => {
    const scheduled = identity({ ...planHistoricalModelBlockRanges('2026-09-28')[0]! });
    const partial = identity();
    expect(await ensure(partial)).toBe(true);
    const admission = await prepareModelBlockAdmission({ target: target(), identity: scheduled,
      todayDay: '2026-09-28', now: NOW, assertSourceCurrent: async () => {} });
    expect(admission).toEqual({ revision: 1, todayDay: '2026-09-28' });
    expect(await ensureModelBlockJob({ ...scope(scheduled), initial: initial(scheduled), now: NOW,
      historicalTodayDay: '2026-09-28', admission: admission! })).toBe(true);
    expect(await ensureModelBlockJob({ ...scope(partial), initial: initial(partial), now: NOW,
      historicalTodayDay: '2026-09-28' })).toBe(false);
    expect(await readModelBlockJob(scope(partial))).toBeNull();
    const held = (await claimModelBlockJob({ ...scope(scheduled), now: NOW + 1,
      historicalTodayDay: '2026-09-28', admission: admission! }))!;
    expect(await saveModelBlockJob({ ...scope(scheduled), claim: held,
      checkpoint: progressed(scheduled), now: NOW + 2, historicalTodayDay: '2026-12-01',
      admission: admission! })).toBe(false);
    expect(await readModelBlockJob({ ...scope(scheduled), historicalTodayDay: '2026-09-28',
      admission: admission! })).toEqual({ revision: 1, checkpoint: initial(scheduled) });
  });

  it('revokes late ensure, save and cleanup after a newer source authority wins policy CAS', async () => {
    const range = planHistoricalModelBlockRanges('2026-09-28')[0]!;
    const old = identity({ ...range });
    const newer = identity({ ...range, authorityDigest: 'f'.repeat(64) });
    const first = (await prepareModelBlockAdmission({ target: target(), identity: old,
      todayDay: '2026-09-28', now: NOW, assertSourceCurrent: async () => {} }))!;
    expect(await ensureModelBlockJob({ ...scope(old), initial: initial(old), now: NOW,
      historicalTodayDay: first.todayDay, admission: first })).toBe(true);
    const held = (await claimModelBlockJob({ ...scope(old), now: NOW + 1,
      historicalTodayDay: first.todayDay, admission: first }))!;
    let releaseOldProof!: () => void;
    const oldProof = new Promise<void>(resolve => { releaseOldProof = resolve; });
    let sourceCheckStarted!: () => void;
    const enteredSourceCheck = new Promise<void>(resolve => { sourceCheckStarted = resolve; });
    const pendingOld = prepareModelBlockAdmission({ target: target(), identity: old,
      todayDay: '2026-09-28', now: NOW + 2,
      assertSourceCurrent: () => { sourceCheckStarted(); return oldProof; } });
    await enteredSourceCheck;
    const second = (await prepareModelBlockAdmission({ target: target(), identity: newer,
      todayDay: '2026-09-28', now: NOW + 3, assertSourceCurrent: async () => {} }))!;
    expect(second.revision).toBe(first.revision + 1);
    releaseOldProof();
    expect(await pendingOld).toBeNull();
    expect(await ensureModelBlockJob({ ...scope(old), initial: initial(old), now: NOW + 4,
      historicalTodayDay: first.todayDay, admission: first })).toBe(false);
    expect(await saveModelBlockJob({ ...scope(old), claim: held, checkpoint: progressed(old),
      now: NOW + 4, historicalTodayDay: first.todayDay, admission: first })).toBe(false);
    const staleCleanup = await retireModelBlockJobs({ target: target(), sourceId: old.sourceId,
      ownerDigest: old.ownerDigest, now: NOW + 60_002, todayDay: first.todayDay,
      currentIdentity: newer, admission: first });
    expect(staleCleanup.deletedJobs).toBe(0);
    const currentCleanup = await retireModelBlockJobs({ target: target(), sourceId: old.sourceId,
      ownerDigest: old.ownerDigest, now: NOW + 60_003, todayDay: second.todayDay,
      currentIdentity: newer, admission: second });
    expect(currentCleanup).toMatchObject({ deletedJobs: 1, cascadedParts: 1 });
    expect(await count('analytics_model_block_parts')).toBe(0);
    expect(await ensureModelBlockJob({ ...scope(newer), initial: initial(newer), now: NOW + 60_004,
      historicalTodayDay: second.todayDay, admission: second })).toBe(true);
  });

  it('advances the policy day without losing an eligible incomplete block', async () => {
    const range = planHistoricalModelBlockRanges('2026-09-28').find(value =>
      planHistoricalModelBlockRanges('2026-09-29').some(next =>
        next.outputFromDay === value.outputFromDay && next.outputThroughDay === value.outputThroughDay))!;
    const id = identity({ ...range });
    const first = (await prepareModelBlockAdmission({ target: target(), identity: id,
      todayDay: '2026-09-28', now: NOW, assertSourceCurrent: async () => {} }))!;
    expect(await ensureModelBlockJob({ ...scope(id), initial: initial(id), now: NOW,
      historicalTodayDay: first.todayDay, admission: first })).toBe(true);
    const nextDay = (await prepareModelBlockAdmission({ target: target(), identity: id,
      todayDay: '2026-09-29', now: NOW + 86_400_000, assertSourceCurrent: async () => {} }))!;
    expect(nextDay.revision).toBe(first.revision + 1);
    expect(await readModelBlockJob({ ...scope(id), historicalTodayDay: first.todayDay,
      admission: first })).toBeNull();
    expect(await readModelBlockJob({ ...scope(id), historicalTodayDay: nextDay.todayDay,
      admission: nextDay })).toEqual({ revision: 1, checkpoint: initial(id) });
    expect(await claimModelBlockJob({ ...scope(id), now: NOW + 86_400_001,
      historicalTodayDay: nextDay.todayDay, admission: nextDay })).not.toBeNull();
    expect(await prepareModelBlockAdmission({ target: target(), identity: id,
      todayDay: '2026-09-28', now: NOW, assertSourceCurrent: async () => {} })).toBeNull();
  });

  it('defers a three-to-four-range rollover behind an obsolete lease, then recovers', async () => {
    const dayMs = 86_400_000, base = Math.floor(NOW / dayMs / 32) * 32;
    const day = (index: number) => new Date(index * dayMs).toISOString().slice(0, 10);
    const today = day(base), tomorrow = day(base + 1), now = base * dayMs + 12 * 3_600_000;
    const before = planHistoricalModelBlockRanges(today), after = planHistoricalModelBlockRanges(tomorrow);
    expect(before).toHaveLength(3);
    expect(after).toHaveLength(4);
    const old = before.map(range => identity(range));
    const first = (await prepareModelBlockAdmission({ target: target(), identity: old[0]!,
      todayDay: today, now, assertSourceCurrent: async () => {} }))!;
    for (const id of old) expect(await ensureModelBlockJob({ ...scope(id), initial: initial(id),
      now, historicalTodayDay: today, admission: first })).toBe(true);
    const claimedAt = (base + 1) * dayMs - 5_000;
    const held = (await claimModelBlockJob({ ...scope(old[0]!), now: claimedAt, leaseMs: 30_000,
      historicalTodayDay: today, admission: first }))!;
    const next = (await prepareModelBlockAdmission({ target: target(), identity: identity(after[0]),
      todayDay: tomorrow, now: claimedAt + 10_000, assertSourceCurrent: async () => {} }))!;
    expect(next.revision).toBe(first.revision + 1);
    expect(await saveModelBlockJob({ ...scope(old[0]!), claim: held, checkpoint: progressed(old[0]!),
      now: claimedAt + 11_000, historicalTodayDay: today, admission: first })).toBe(false);
    expect(await ensureModelBlockJob({ ...scope(old[0]!), initial: initial(old[0]!),
      now: claimedAt + 11_000, historicalTodayDay: today, admission: first })).toBe(false);
    expect(await readModelBlockJob({ ...scope(old[0]!), historicalTodayDay: tomorrow,
      admission: next })).toBeNull();
    const retired = await retireModelBlockJobs({ target: target(), sourceId: old[0]!.sourceId,
      ownerDigest: old[0]!.ownerDigest, now: claimedAt + 12_000, todayDay: tomorrow,
      currentIdentity: identity(after[0]), admission: next });
    expect(retired).toMatchObject({ deletedJobs: 0, leasedJobs: 1 });
    const freshRight = identity(after[3]);
    expect(await ensureModelBlockJob({ ...scope(freshRight), initial: initial(freshRight),
      now: claimedAt + 13_000, historicalTodayDay: tomorrow, admission: next })).toBe(true);
    const freshLeft = identity(after[0]);
    expect(await ensureModelBlockJob({ ...scope(freshLeft), initial: initial(freshLeft),
      now: claimedAt + 14_000, historicalTodayDay: tomorrow, admission: next })).toBe(false);
    expect(await count('analytics_model_blocks')).toBe(MODEL_BLOCK_MAX_STORED_JOBS);
    const swept = await retireObsoleteModelBlockPage({ target: target(), sourceId: old[0]!.sourceId,
      todayDay: tomorrow, now: claimedAt + 31_000 });
    expect(swept).toMatchObject({ deletedJobs: 1, cascadedParts: 1 });
    expect(await ensureModelBlockJob({ ...scope(freshLeft), initial: initial(freshLeft),
      now: claimedAt + 32_000, historicalTodayDay: tomorrow, admission: next })).toBe(true);
    expect(await count('analytics_model_blocks')).toBe(MODEL_BLOCK_MAX_STORED_JOBS);
    expect(await count('analytics_model_block_parts')).toBe(MODEL_BLOCK_MAX_STORED_JOBS);
    for (const id of old.slice(1)) expect(await readModelBlockJob({ ...scope(id),
      historicalTodayDay: tomorrow, admission: next })).toEqual({ revision: 1, checkpoint: initial(id) });
  });

  it('physically clears the bounded policy on owner erasure', async () => {
    const id = identity({ ...planHistoricalModelBlockRanges('2026-09-28')[0]! });
    const token = (await prepareModelBlockAdmission({ target: target(), identity: id,
      todayDay: '2026-09-28', now: NOW, assertSourceCurrent: async () => {} }))!;
    expect(await ensureModelBlockJob({ ...scope(id), initial: initial(id), now: NOW,
      historicalTodayDay: token.todayDay, admission: token })).toBe(true);
    await target().prepare("UPDATE analytics_owner_state SET state='erased'").run();
    expect(await count('analytics_model_block_policy')).toBe(0);
    expect(await count('analytics_model_blocks')).toBe(0);
    expect(await count('analytics_model_block_parts')).toBe(0);
  });

  it('capacity cleanup narrows an existing policy and preserves an unexpired claim', async () => {
    const today = '2026-10-15', tomorrow = '2026-10-16';
    const old = identity({ ...planHistoricalModelBlockRanges(today)[0]! });
    const now = Date.parse(`${today}T12:00:00Z`);
    const token = (await prepareModelBlockAdmission({ target: target(), identity: old,
      todayDay: today, now, assertSourceCurrent: async () => {} }))!;
    expect(await ensureModelBlockJob({ ...scope(old), initial: initial(old), now,
      historicalTodayDay: today, admission: token })).toBe(true);
    const claimedAt = Date.parse(`${today}T23:59:55Z`);
    const held = (await claimModelBlockJob({ ...scope(old), now: claimedAt, leaseMs: 30_000,
      historicalTodayDay: today, admission: token }))!;
    const first = await retireObsoleteModelBlockPage({ target: target(), sourceId: old.sourceId,
      todayDay: tomorrow, now: claimedAt + 10_000 });
    expect(first).toMatchObject({ policiesAdvanced: 1, deletedJobs: 0 });
    expect(await count('analytics_model_blocks')).toBe(1);
    const policy = await target().prepare(`SELECT policy_revision,today_day,range0_from,range0_through,
      range1_from FROM analytics_model_block_policy`).first<Record<string, unknown>>();
    expect(policy).toMatchObject({ policy_revision: token.revision + 1, today_day: tomorrow,
      range0_from: '2026-09-08', range0_through: '2026-10-09', range1_from: null });
    expect(await saveModelBlockJob({ ...scope(old), claim: held, checkpoint: progressed(old),
      now: claimedAt + 11_000, historicalTodayDay: today, admission: token })).toBe(false);
    const second = await retireObsoleteModelBlockPage({ target: target(), sourceId: old.sourceId,
      todayDay: tomorrow, now: claimedAt + 31_000 });
    expect(second).toMatchObject({ policiesAdvanced: 0, scanned: 1, deletedJobs: 1, cascadedParts: 1 });
    expect(second.cascadedBytes).toBeGreaterThan(0);
    expect(await count('analytics_model_block_parts')).toBe(0);
  });

  it('capacity cleanup retires target-stale revisions without a policy but leaves direct old ranges alone', async () => {
    const stale = identity(); await ensure(stale);
    await target().prepare('UPDATE analytics_owner_state SET revision=2').run();
    const after = await retireObsoleteModelBlockPage({ target: target(), sourceId: stale.sourceId,
      todayDay: '2026-09-28', now: NOW });
    expect(after).toMatchObject({ policiesAdvanced: 0, scanned: 1, deletedJobs: 1, cascadedParts: 1 });
    expect(await count('analytics_model_block_parts')).toBe(0);
    const fresh = identity({ ownerRevision: 2, ...planHistoricalModelBlockRanges('2026-09-28')[0]! });
    expect(await ensure(fresh)).toBe(true);
    const later = await retireObsoleteModelBlockPage({ target: target(), sourceId: stale.sourceId,
      todayDay: '2026-12-10', now: Date.parse('2026-12-10T12:00:00Z') });
    expect(later.deletedJobs).toBe(0);
    expect(await count('analytics_model_blocks')).toBe(1);
  });
  it('pages by an indexed physical head cursor across many current owners', async () => {
    const jobs = Array.from({ length: 20 }, (_, index) => identity({
      ownerDigest: (index + 1).toString(16).padStart(64, '0') }));
    for (const id of jobs) {
      await target().prepare(`INSERT INTO analytics_owner_state
        (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')`)
        .bind(id.sourceId, id.ownerDigest).run();
      expect(await ensure(id)).toBe(true);
    }
    const unknown = jobs[2]!;
    await alterWithTrigger('analytics_model_blocks_update', async () => target().prepare(
      'UPDATE analytics_model_blocks SET identity_json=? WHERE job_key=?').bind(
        canonicalJson({ ...unknown, method: 'future-model-block-v2' }), await modelBlockJobKey(unknown)).run());
    const leased = jobs[17]!, stale = jobs[19]!;
    expect(await claimModelBlockJob({ ...scope(leased), now: NOW + 1, leaseMs: 100 })).not.toBeNull();
    for (const id of [leased, stale]) await target().prepare(`UPDATE analytics_owner_state SET revision=2
      WHERE source_id=? AND owner_digest=?`).bind(id.sourceId, id.ownerDigest).run();
    const plan = await target().prepare(`EXPLAIN QUERY PLAN SELECT h.rowid FROM analytics_model_blocks h
      INDEXED BY analytics_model_blocks_source_cursor WHERE h.source_id=? AND h.rowid>?
      ORDER BY h.rowid LIMIT 4`).bind(identity().sourceId, 0).all<{ detail: string }>();
    expect(plan.results.some(row => /SEARCH.*analytics_model_blocks_source_cursor/u.test(row.detail))).toBe(true);
    expect(plan.results.some(row => /TEMP B-TREE/u.test(row.detail))).toBe(false);
    const scanned: number[] = [];
    for (let index = 0; index < 5; index++) {
      const budget = createD1InvocationBudget(40);
      const page = await retireObsoleteModelBlockPage({ target: budget.wrap(target()), sourceId: identity().sourceId,
        todayDay: '2026-09-28', now: NOW + 2 });
      expect(budget.queriesUsed).toBeLessThanOrEqual(40);
      scanned.push(page.scanned);
      if (index < 4) expect(page.deletedJobs).toBe(0);
    }
    expect(scanned).toEqual([4, 4, 4, 4, 4]);
    expect(await target().prepare('SELECT COUNT(*) n FROM analytics_model_blocks WHERE job_key=?')
      .bind(await modelBlockJobKey(stale)).first<number>('n')).toBe(0);
    expect(await target().prepare('SELECT COUNT(*) n FROM analytics_model_blocks WHERE job_key=?')
      .bind(await modelBlockJobKey(leased)).first<number>('n')).toBe(1);
    for (let index = 0; index < 6; index++) await retireObsoleteModelBlockPage({ target: target(),
      sourceId: identity().sourceId, todayDay: '2026-09-28', now: NOW + 102 });
    expect(await target().prepare('SELECT COUNT(*) n FROM analytics_model_blocks WHERE job_key=?')
      .bind(await modelBlockJobKey(leased)).first<number>('n')).toBe(0);
    expect(await target().prepare('SELECT COUNT(*) n FROM analytics_model_blocks WHERE job_key=?')
      .bind(await modelBlockJobKey(unknown)).first<number>('n')).toBe(1);
    expect(await count('analytics_model_block_parts')).toBe(18);
    await expect(retireObsoleteModelBlockPage({ target: target(), sourceId: identity().sourceId,
      todayDay: '2026-09-29', now: NOW })).rejects.toThrow('MODEL_BLOCK_STORE_INVALID');
  });
  it('fences stale target owner revisions at ensure and save, then cascades the obsolete head', async () => {
    await ensure(); const held = (await claim())!;
    await target().prepare('UPDATE analytics_owner_state SET revision=2').run();
    expect(await ensure()).toBe(false);
    expect(await readModelBlockJob(scope())).toBeNull();
    expect(await saveModelBlockJob({ ...scope(), claim: held, checkpoint: progressed(), now: NOW + 2 })).toBe(false);
    const fresh = identity({ ownerRevision: 2 });
    const cleanup = await retireModelBlockJobs({ target: target(), sourceId: fresh.sourceId,
      ownerDigest: fresh.ownerDigest, now: NOW + 60_002, todayDay: '2026-09-28', currentIdentity: fresh });
    expect(cleanup).toMatchObject({ scanned: 1, deletedJobs: 1, cascadedParts: 1 });
    expect(cleanup.cascadedBytes).toBeGreaterThan(0);
    expect(await count('analytics_model_blocks')).toBe(0);
    expect(await count('analytics_model_block_parts')).toBe(0);
    expect(await ensure(fresh)).toBe(true);
  });

  it('counts obsolete leased parents at the four-job ceiling and cleans after expiry', async () => {
    const jobs = Array.from({ length: MODEL_BLOCK_MAX_STORED_JOBS + 1 }, (_, index) => identity({
      outputFromDay: `2026-09-${String(15 + index).padStart(2, '0')}`,
      outputThroughDay: `2026-09-${String(15 + index).padStart(2, '0')}` }));
    for (const id of jobs.slice(0, 4)) expect(await ensure(id)).toBe(true);
    expect(await ensure(jobs[4]!)).toBe(false);
    expect(await count('analytics_model_blocks')).toBe(4);
    const held = (await claimModelBlockJob({ ...scope(jobs[0]!), now: NOW + 1, leaseMs: 100 }))!;
    const fresh = identity({ authorityDigest: 'f'.repeat(64) });
    const first = await retireModelBlockJobs({ target: target(), sourceId: fresh.sourceId,
      ownerDigest: fresh.ownerDigest, now: NOW + 2, todayDay: '2026-09-28', currentIdentity: fresh });
    expect(first).toMatchObject({ scanned: 4, deletedJobs: 3, leasedJobs: 1, cascadedParts: 3 });
    expect(await count('analytics_model_blocks')).toBe(1);
    expect(await count('analytics_model_block_parts')).toBe(1);
    expect(await ensure(jobs[4]!)).toBe(true);
    expect(await saveModelBlockJob({ ...scope(jobs[0]!), claim: held,
      checkpoint: progressed(jobs[0]!), now: NOW + 3 })).toBe(true);
    const after = await retireModelBlockJobs({ target: target(), sourceId: fresh.sourceId,
      ownerDigest: fresh.ownerDigest, now: NOW + 103, todayDay: '2026-09-28', currentIdentity: fresh });
    expect(after.deletedJobs).toBe(2);
    expect(after.cascadedParts).toBe(2);
    expect(await count('analytics_model_block_parts')).toBe(0);
  });

  it('preserves eligible partial jobs and unfamiliar future methods', async () => {
    const id = identity({ outputFromDay: '2026-09-19', outputThroughDay: '2026-09-21' });
    await ensure(id);
    const unknown = identity({ outputFromDay: '2026-09-22', outputThroughDay: '2026-09-22' });
    await ensure(unknown);
    await alterWithTrigger('analytics_model_blocks_update', async () => target().prepare(
      'UPDATE analytics_model_blocks SET identity_json=? WHERE job_key=?').bind(
        canonicalJson({ ...unknown, method: 'future-model-block-v2' }), await modelBlockJobKey(unknown)).run());
    const kept = await retireModelBlockJobs({ target: target(), sourceId: id.sourceId,
      ownerDigest: id.ownerDigest, now: NOW + 1, todayDay: '2026-09-28', currentIdentity: id });
    expect(kept.deletedJobs).toBe(0);
    expect(await count('analytics_model_blocks')).toBe(2);
    const retired = await retireModelBlockJobs({ target: target(), sourceId: id.sourceId,
      ownerDigest: id.ownerDigest, now: NOW + 2, todayDay: '2026-09-28', currentIdentity: id,
      retiredMethods: ['future-model-block-v2'] });
    expect(retired.deletedJobs).toBe(1);
    expect(await count('analytics_model_blocks')).toBe(1);
  });

  it('retires a partial block only after its output range leaves the preview', async () => {
    const id = identity({ outputFromDay: '2026-09-19', outputThroughDay: '2026-09-21' });
    await ensure(id);
    const current = await retireModelBlockJobs({ target: target(), sourceId: id.sourceId,
      ownerDigest: id.ownerDigest, now: NOW + 1, todayDay: '2026-09-28', currentIdentity: id });
    expect(current.deletedJobs).toBe(0);
    const expired = await retireModelBlockJobs({ target: target(), sourceId: id.sourceId,
      ownerDigest: id.ownerDigest, now: NOW + 2, todayDay: '2026-12-01', currentIdentity: id });
    expect(expired).toMatchObject({ deletedJobs: 1, cascadedParts: 1 });
    expect(await count('analytics_model_block_parts')).toBe(0);
  });

  it('bounds cleanup to metadata selection and one parent deletion per job', async () => {
    const id = identity(); await ensure(id);
    const queries: string[] = [];
    const metered = new Proxy(target(), { get(db, key) {
      if (key === 'prepare') return (sql: string) => { queries.push(sql); return db.prepare(sql); };
      const value = Reflect.get(db, key); return typeof value === 'function' ? value.bind(db) : value;
    } });
    const result = await retireModelBlockJobs({ target: metered, sourceId: id.sourceId,
      ownerDigest: id.ownerDigest, now: NOW + 1, todayDay: '2026-09-28', currentIdentity: null });
    expect(result).toMatchObject({ scanned: 1, deletedJobs: 1, cascadedParts: 1 });
    expect(queries).toHaveLength(3); // schema proof, bounded metadata page, parent CAS
    expect(queries.filter(sql => sql.includes('DELETE FROM analytics_model_block_parts'))).toEqual([]);
    expect(queries.filter(sql => sql.includes('SELECT h.*,p.payload'))).toEqual([]);
    expect(await count('analytics_model_block_parts')).toBe(0);
  });

  it('loses the deletion CAS when a new claim wins after metadata selection', async () => {
    const id = identity(); await ensure(id);
    let raced = false;
    const racing = new Proxy(target(), { get(db, key) {
      if (key === 'prepare') return (sql: string) => {
        const statement = db.prepare(sql);
        if (!sql.includes('DELETE FROM analytics_model_blocks AS h')) return statement;
        return new Proxy(statement, { get(unbound, action) {
          if (action !== 'bind') return Reflect.get(unbound, action);
          return (...bindings: unknown[]) => {
            const bound = Reflect.apply(unbound.bind, unbound, bindings) as D1PreparedStatement;
            return new Proxy(bound, { get(prepared, operation) {
              if (operation === 'all') return async () => {
                raced = !!await claimModelBlockJob({ ...scope(id), now: NOW + 1, leaseMs: 100 });
                return prepared.all();
              };
              const value = Reflect.get(prepared, operation);
              return typeof value === 'function' ? value.bind(prepared) : value;
            } });
          };
        } });
      };
      const value = Reflect.get(db, key); return typeof value === 'function' ? value.bind(db) : value;
    } });
    const result = await retireModelBlockJobs({ target: racing, sourceId: id.sourceId,
      ownerDigest: id.ownerDigest, now: NOW + 1, todayDay: '2026-09-28', currentIdentity: null });
    expect(raced).toBe(true);
    expect(result).toMatchObject({ scanned: 1, deletedJobs: 0, cascadedParts: 0 });
    expect(await count('analytics_model_blocks')).toBe(1);
    expect(await count('analytics_model_block_parts')).toBe(1);
  });
});
