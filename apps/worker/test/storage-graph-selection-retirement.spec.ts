import { env, reset, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS } from '../src/admin-community-allowance';
import { canonicalJson } from '../src/canonical-json';
import { sha256Hex } from '../src/crypto';
import { modelHistoryWindow } from '../src/model-history-window';
import { retireStorageGraphPage } from '../src/storage-graph-retirement';

const bindings = env as Env & { STORAGE_ANALYTICS_DB: D1Database; TEST_ANALYTICS_MIGRATIONS: D1Migration[] };
const target = () => bindings.STORAGE_ANALYTICS_DB;
const sourceId = 'synthetic-selection-retirement';
const otherSourceId = 'synthetic-selection-retirement-other';
const ownerDigest = 'a'.repeat(64), otherOwnerDigest = 'd'.repeat(64);
const nowMs = Date.parse('2026-09-28T12:00:00.000Z');
const dayAt = (offset: number) => new Date(Date.parse('2026-09-28T00:00:00.000Z') + offset * 86_400_000)
  .toISOString().slice(0, 10);
const oldest = dayAt(-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS - 1));
const expiredDay = dayAt(-ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS);

beforeEach(async () => {
  await reset();
  await applyD1Migrations(target(), bindings.TEST_ANALYTICS_MIGRATIONS);
  for (const source of [sourceId, otherSourceId]) {
    await target().prepare('INSERT INTO analytics_runtime_sources VALUES(?,?,1)')
      .bind(source, 'synthetic-selection-origin').run();
    for (const owner of [ownerDigest, otherOwnerDigest]) await target().prepare(
      "INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')").bind(source, owner).run();
  }
});

async function insertSelection(input: {
  day: string; source?: string; owner?: string; metric?: 'fits' | 'model';
  state?: 'pending' | 'claimed' | 'complete'; expiresMs?: number;
}) {
  const source = input.source ?? sourceId, owner = input.owner ?? ownerDigest;
  const metric = input.metric ?? 'model', state = input.state ?? 'pending';
  const envelope = canonicalJson({ version: 2, source: 'effective', sourceId: source,
    sourceNamespace: 'synthetic-selection-origin', ownerDigest: owner, day: input.day, metric,
    fixedNow: modelHistoryWindow(input.day).fixedNow, dependencyDigest: 'b'.repeat(64),
    checkpointDependencyDigest: 'c'.repeat(64), targetAuthorityEpoch: 1,
    participantId: 'participant:synthetic-selection-retirement', ownerRevision: 1 });
  await target().prepare(`INSERT INTO analytics_community_graph_work_selection
    (source_id,owner_digest,day,metric,authority_epoch,selection_revision,state,envelope_json,envelope_sha256,
      claim_token,claim_expires_ms,created_ms,updated_ms) VALUES(?,?,?,?,1,1,?,?,?,?,?,?,?)`)
    .bind(source, owner, input.day, metric, state, envelope, await sha256Hex(envelope),
      state === 'claimed' ? 'synthetic-retirement-claim' : null,
      state === 'claimed' ? input.expiresMs ?? nowMs + 60_000 : null, nowMs - 1_000, nowMs - 1_000).run();
}

async function count(source = sourceId, owner?: string) {
  return target().prepare(`SELECT count(*) n FROM analytics_community_graph_work_selection
    WHERE source_id=? AND (? IS NULL OR owner_digest=?)`).bind(source, owner ?? null, owner ?? null).first<number>('n');
}

async function receipt(owner = ownerDigest) {
  return target().prepare(`SELECT terminal_revision FROM analytics_graph_erasure_receipts
    WHERE source_id=? AND owner_digest=?`).bind(sourceId, owner).first<number>('terminal_revision');
}

describe('bounded graph selection retirement', () => {
  it('drains at most 32 old selections per page and isolates the source', async () => {
    for (let index = 0; index < 65; index++) await insertSelection({ day: dayAt(-ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS - index) });
    await insertSelection({ day: expiredDay, source: otherSourceId });
    expect(await retireStorageGraphPage(target(), sourceId, nowMs)).toEqual({ state: 'retiring', deleted: 32 });
    expect(await count()).toBe(33);
    expect(await count(otherSourceId)).toBe(1);
    expect(await retireStorageGraphPage(target(), sourceId, nowMs)).toEqual({ state: 'retiring', deleted: 32 });
    expect(await count()).toBe(1);
    expect(await retireStorageGraphPage(target(), sourceId, nowMs)).toEqual({ state: 'retiring', deleted: 1 });
    expect(await retireStorageGraphPage(target(), sourceId, nowMs)).toEqual({ state: 'idle', deleted: 0 });
    expect(await count(otherSourceId)).toBe(1);
  });

  it('retains the horizon boundary and recent pending or expired work', async () => {
    await insertSelection({ day: expiredDay });
    await insertSelection({ day: expiredDay, metric: 'fits', state: 'complete' });
    await insertSelection({ day: oldest });
    await insertSelection({ day: oldest, metric: 'fits', state: 'claimed', expiresMs: nowMs - 1 });
    await insertSelection({ day: dayAt(0), state: 'pending' });
    await insertSelection({ day: dayAt(0), metric: 'fits', state: 'claimed', expiresMs: nowMs - 1 });
    expect(await retireStorageGraphPage(target(), sourceId, nowMs)).toEqual({ state: 'retiring', deleted: 2 });
    expect((await target().prepare(`SELECT day,metric,state FROM analytics_community_graph_work_selection
      WHERE source_id=? ORDER BY day,metric`).bind(sourceId).all()).results).toEqual([
      { day: oldest, metric: 'fits', state: 'claimed' },
      { day: oldest, metric: 'model', state: 'pending' },
      { day: dayAt(0), metric: 'fits', state: 'claimed' },
      { day: dayAt(0), metric: 'model', state: 'pending' },
    ]);
    expect(await retireStorageGraphPage(target(), sourceId, nowMs)).toEqual({ state: 'idle', deleted: 0 });
  });

  it('preserves a live old claim until the exact lease expiry', async () => {
    await insertSelection({ day: expiredDay, state: 'claimed', expiresMs: nowMs + 1 });
    await insertSelection({ day: expiredDay, metric: 'fits', state: 'claimed', expiresMs: nowMs });
    expect(await retireStorageGraphPage(target(), sourceId, nowMs)).toEqual({ state: 'retiring', deleted: 1 });
    expect(await count()).toBe(1);
    expect(await target().prepare(`SELECT metric,claim_expires_ms FROM analytics_community_graph_work_selection
      WHERE source_id=?`).bind(sourceId).first()).toEqual({ metric: 'model', claim_expires_ms: nowMs + 1 });
    expect(await retireStorageGraphPage(target(), sourceId, nowMs + 1)).toEqual({ state: 'retiring', deleted: 1 });
    expect(await count()).toBe(0);
  });

  it('resumes bounded erasure cleanup when an older caller left selections after a receipt', async () => {
    // Ordered analytics delivery may still report the owner active when the
    // independent erasure fence and its first receipt have already committed.
    await target().prepare('INSERT INTO analytics_storage_erasure_fences VALUES(?,?,?,1,2,2,2)')
      .bind(sourceId, ownerDigest, 'e'.repeat(64)).run();
    expect(await retireStorageGraphPage(target(), sourceId, nowMs)).toEqual({ state: 'retiring', deleted: 0 });
    expect(await receipt()).toBe(2);
    for (let index = 0; index < 33; index++) await insertSelection({
      day: dayAt(-index), state: 'claimed', expiresMs: nowMs + 60_000,
    });
    await insertSelection({ day: dayAt(0), source: otherSourceId });
    expect(await retireStorageGraphPage(target(), sourceId, nowMs)).toEqual({ state: 'retiring', deleted: 32 });
    expect(await count()).toBe(1);
    expect(await receipt()).toBe(2);
    expect(await retireStorageGraphPage(target(), sourceId, nowMs)).toEqual({ state: 'retiring', deleted: 1 });
    expect(await count()).toBe(0);
    expect(await count(otherSourceId)).toBe(1);
    expect(await receipt()).toBe(2);
    expect(await retireStorageGraphPage(target(), sourceId, nowMs)).toEqual({ state: 'idle', deleted: 0 });
  });

  it.each(['owner-state', 'terminal-fence'] as const)(
    'drains an erased owner behind %s without certifying remaining selections', async authority => {
      if (authority === 'owner-state') {
        await target().prepare(`UPDATE analytics_owner_state SET state='erased',revision=2,authority_epoch=2
          WHERE source_id=?`).bind(sourceId).run();
      } else {
        for (const owner of [ownerDigest, otherOwnerDigest]) await target().prepare(
          'INSERT INTO analytics_storage_erasure_fences VALUES(?,?,?,1,2,2,2)')
          .bind(sourceId, owner, 'e'.repeat(64)).run();
      }
      // Model metadata restored or written late by the prior caller after the
      // one-time erasure trigger. This deliberately uses the existing schema
      // directly; current selection admission must refuse the erased owner.
      for (let index = 0; index < 65; index++) await insertSelection({
        day: dayAt(-index), state: 'claimed', expiresMs: nowMs + 60_000,
      });
      await insertSelection({ day: dayAt(0), owner: otherOwnerDigest });
      await insertSelection({ day: dayAt(0), source: otherSourceId });
      for (const remaining of [33, 1]) {
        expect(await retireStorageGraphPage(target(), sourceId, nowMs)).toEqual({ state: 'retiring', deleted: 32 });
        expect(await count(sourceId, ownerDigest)).toBe(remaining);
        expect(await receipt()).toBeNull();
        expect(await count(sourceId, otherOwnerDigest)).toBe(1);
      }
      expect(await retireStorageGraphPage(target(), sourceId, nowMs)).toEqual({ state: 'retiring', deleted: 1 });
      expect(await receipt()).toBe(2);
      expect(await count(sourceId, otherOwnerDigest)).toBe(1);
      expect(await receipt(otherOwnerDigest)).toBeNull();
      expect(await retireStorageGraphPage(target(), sourceId, nowMs)).toEqual({ state: 'retiring', deleted: 1 });
      expect(await receipt(otherOwnerDigest)).toBe(2);
      expect(await count()).toBe(0);
      expect(await count(otherSourceId)).toBe(1);
      expect(await retireStorageGraphPage(target(), sourceId, nowMs)).toEqual({ state: 'idle', deleted: 0 });
    });
});
