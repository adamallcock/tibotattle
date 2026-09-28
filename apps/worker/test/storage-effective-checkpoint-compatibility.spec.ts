import { env, reset, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS } from '../src/admin-community-allowance';
import { createV11QuotaAcquisitionCheckpoint } from '../src/quota-analysis-v11-reader';
import {
  STORAGE_GRAPH_EFFECTIVE_FITS_CHECKPOINT_METHOD,
  STORAGE_GRAPH_EFFECTIVE_MODEL_CHECKPOINT_METHOD,
  STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS,
  STORAGE_GRAPH_METHOD,
  storageGraphEffectiveCheckpointKey,
} from '../src/storage-community-graph';
import type { StorageEffectiveHistoryCheckpoint } from '../src/storage-effective-history';
import { retireStorageGraphPage } from '../src/storage-graph-retirement';
import {
  loadStorageHistoryCheckpoint,
  retireStorageHistoryCheckpoint,
  saveStorageHistoryCheckpoint,
  storageHistoryKeyDigest,
  type StorageHistoryKey,
} from '../src/storage-history-checkpoint';

const bindings = env as Env & { STORAGE_ANALYTICS_DB: D1Database; TEST_ANALYTICS_MIGRATIONS: D1Migration[] };
const target = () => bindings.STORAGE_ANALYTICS_DB;
const sourceId = 'synthetic-effective-checkpoint-compatibility';
const sourceNamespace = 'synthetic-effective-original';
const ownerDigest = 'a'.repeat(64);
const day = '2026-09-05';
const nowMs = Date.parse('2026-09-06T12:00:00.000Z');
const baseKey = (metric: 'fits' | 'model'): StorageHistoryKey => ({
  sourceId, sourceNamespace, ownerDigest, day, dependencyDigest: 'b'.repeat(64),
  method: metric === 'fits' ? STORAGE_GRAPH_EFFECTIVE_FITS_CHECKPOINT_METHOD
    : STORAGE_GRAPH_EFFECTIVE_MODEL_CHECKPOINT_METHOD,
});

beforeEach(async () => {
  await reset();
  await applyD1Migrations(target(), bindings.TEST_ANALYTICS_MIGRATIONS);
  await target().prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')")
    .bind(sourceId, ownerDigest).run();
});

function checkpoint(prepared: boolean): StorageEffectiveHistoryCheckpoint {
  const identity = {
    participantId: 'synthetic-effective-participant', inputFingerprint: 'c'.repeat(64),
    sourceMethodVersion: 'synthetic-effective-reader-1', observedAtCutoff: '2026-05-28T00:00:00.000Z',
    resetsAtCutoff: '2026-06-04T00:00:00.000Z', windowMinutes: 10080, maxQuotaRows: 60000,
  };
  const inputDay = '2026-05-29';
  const observedAtMs = Date.parse(`${inputDay}T12:00:00.000Z`);
  return {
    version: 1, source: 'effective', day, layout: `effective:${sourceNamespace}`, identity,
    phase: 'acquisition', acquisition: createV11QuotaAcquisitionCheckpoint(identity),
    effectiveCursor: {
      phase: 'plan', day: inputDay, after: { observedAtMs, occurrenceId: 'synthetic-row-1' },
      ordinal: 1, complete: false,
    },
    effectiveDays: { quota: [inputDay], usage: [] },
    ...(prepared ? {
      preparingQuota: {
        day: inputDay, quotaRowsRead: 1,
        rows: [{ sourceRowId: 1, observedAtMs, anchor: null, row: null }],
      },
    } : {}),
  };
}

async function save(key: StorageHistoryKey, prepared: boolean) {
  const saved = await saveStorageHistoryCheckpoint({
    target: target(), key, checkpoint: checkpoint(prepared), expectedHead: null,
  });
  expect(saved.status).toBe('saved');
  if (saved.status !== 'saved') throw new Error('synthetic checkpoint did not promote');
  return saved.headDigest;
}

async function read(key: StorageHistoryKey) {
  return loadStorageHistoryCheckpoint({ target: target(), key, maxParts: 32 });
}

async function drainRetirement(at = nowMs) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await retireStorageGraphPage(target(), sourceId, at)).state === 'idle') return;
  }
  throw new Error('synthetic retirement did not drain');
}

async function expectRetired(key: StorageHistoryKey) {
  const digest = await storageHistoryKeyDigest(key);
  expect(await target().prepare('SELECT generation,retired FROM analytics_history_checkpoint_heads WHERE key_digest=?')
    .bind(digest).first()).toEqual({ generation: null, retired: 1 });
  for (const table of ['analytics_history_checkpoint_stages', 'analytics_history_checkpoint_parts']) {
    expect(await target().prepare(`SELECT count(*) n FROM ${table} WHERE key_digest=?`).bind(digest).first('n')).toBe(0);
  }
  await expect(saveStorageHistoryCheckpoint({
    target: target(), key, checkpoint: checkpoint(true), expectedHead: null,
  })).rejects.toThrow('STORAGE_HISTORY_CHECKPOINT_UNAVAILABLE');
}

describe('effective checkpoint format keys shared with older workers', () => {
  it.each(['fits', 'model'] as const)('isolates the %s checkpoint format without changing its recognized method', async metric => {
    const original = Object.freeze(baseKey(metric));
    expect(await storageGraphEffectiveCheckpointKey(original)).toEqual(original);
    expect(await storageGraphEffectiveCheckpointKey(original, false)).toEqual(original);
    expect(await storageGraphEffectiveCheckpointKey(original, false, 2)).toEqual(original);
    expect(await storageGraphEffectiveCheckpointKey(original, false, 3)).toEqual(original);
    const previous = await storageGraphEffectiveCheckpointKey(original, true, 2);
    const prepared = await storageGraphEffectiveCheckpointKey(original, true);
    expect(prepared).toEqual({ ...original, dependencyDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    // Pin both durable namespaces: v2 remains available for adoption/rollback,
    // while only v3 may hold preparation started in a later acquisition phase.
    expect(previous).toEqual({ ...original, dependencyDigest: '879d09906bdb08f12308f489840f82c83b61c72da6983c2cb2abcc660917eab4' });
    expect(prepared.dependencyDigest).toBe('bf2a2695d3f1dbffda73105d80b5c11b0f45f76c4a91a0784d09628fd3ccdeb4');
    expect(await storageGraphEffectiveCheckpointKey(original, true, 3)).toEqual(prepared);
    expect(await storageGraphEffectiveCheckpointKey(original, true)).toEqual(prepared);
    const changedDependency = await storageGraphEffectiveCheckpointKey({ ...original, dependencyDigest: 'd'.repeat(64) }, true);
    expect(changedDependency.dependencyDigest).not.toBe(prepared.dependencyDigest);
    expect(new Set(await Promise.all([original, previous, prepared].map(storageHistoryKeyDigest))).size).toBe(3);
    expect(STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS).toContain(prepared.method);
    // This is the same seven-method registry the pre-cache retirement caller
    // understands, so no registration or cleanup-policy expansion enables it.
    expect(STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS).toHaveLength(7);
    expect(STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS.some(method => method.includes(':quota-days-'))).toBe(false);
  });

  it.each(['fits', 'model'] as const)('preserves the %s prepared key through old-method cleanup and a matching old-format result', async metric => {
    const original = baseKey(metric);
    const previous = await storageGraphEffectiveCheckpointKey(original, true, 2);
    const prepared = await storageGraphEffectiveCheckpointKey(original, true);
    const abandoned = { ...original, method: `${original.method}:quota-days-1` };
    expect(await retireStorageHistoryCheckpoint({ target: target(), key: abandoned, expectedHead: null }))
      .toEqual({ status: 'retired' });
    const oldHead = await save(original, false);
    const previousHead = await save(previous, true);
    const preparedHead = await save(prepared, true);
    await drainRetirement();
    expect(await read(original)).toMatchObject({ status: 'ready', headDigest: oldHead, checkpoint: checkpoint(false) });
    expect(await read(previous)).toMatchObject({ status: 'ready', headDigest: previousHead, checkpoint: checkpoint(true) });
    expect(await read(prepared)).toMatchObject({ status: 'ready', headDigest: preparedHead, checkpoint: checkpoint(true) });
    await expectRetired(abandoned);

    // Even if an older result exactly matches the old storage dependency, its
    // cleanup can retire only that key. The new format keeps its own digest.
    await target().prepare('INSERT INTO analytics_community_graph_results VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(sourceId, ownerDigest, metric, day, STORAGE_GRAPH_METHOD, original.dependencyDigest,
        1, 'e'.repeat(64), '{}', 'f'.repeat(64), '{}', nowMs, 'effective').run();
    await drainRetirement();
    await expectRetired(original);
    expect(await read(previous)).toMatchObject({ status: 'ready', headDigest: previousHead, checkpoint: checkpoint(true) });
    expect(await read(prepared)).toMatchObject({ status: 'ready', headDigest: preparedHead, checkpoint: checkpoint(true) });
    await expectRetired(abandoned);
    expect(await target().prepare('SELECT count(*) n FROM analytics_community_graph_results').first('n')).toBe(1);
  });

  it.each(['owner-state', 'terminal-fence'] as const)('erases both prepared metrics behind the %s authority', async authority => {
    const keys = await Promise.all((['fits', 'model'] as const).flatMap(metric => [
      Promise.resolve(baseKey(metric)),
      storageGraphEffectiveCheckpointKey(baseKey(metric), true, 2),
      storageGraphEffectiveCheckpointKey(baseKey(metric), true),
    ]));
    for (const key of keys) await save(key, true);
    if (authority === 'owner-state') {
      await target().prepare("UPDATE analytics_owner_state SET state='erased',revision=2,authority_epoch=2 WHERE source_id=? AND owner_digest=?")
        .bind(sourceId, ownerDigest).run();
    } else {
      await target().prepare('INSERT INTO analytics_storage_erasure_fences VALUES(?,?,?,1,2,2,2)')
        .bind(sourceId, ownerDigest, 'd'.repeat(64)).run();
    }
    await drainRetirement();
    for (const key of keys) await expectRetired(key);
    expect(await target().prepare('SELECT terminal_revision FROM analytics_graph_erasure_receipts WHERE source_id=? AND owner_digest=?')
      .bind(sourceId, ownerDigest).first('terminal_revision')).toBe(2);
  });

  it('keeps both prepared formats through their final retained UTC day and retires them at the next boundary', async () => {
    const keys = await Promise.all(([2, 3] as const).map(format => storageGraphEffectiveCheckpointKey(baseKey('model'), true, format)));
    const heads = [];
    for (const key of keys) heads.push(await save(key, true));
    const finalDay = Date.parse(`${day}T00:00:00.000Z`) + (ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS - 1) * 86_400_000;
    await drainRetirement(finalDay + 86_400_000 - 1);
    for (const [index, key] of keys.entries()) expect(await read(key)).toMatchObject({ status: 'ready', headDigest: heads[index] });
    await drainRetirement(finalDay + 86_400_000);
    for (const key of keys) await expectRetired(key);
  });
});
