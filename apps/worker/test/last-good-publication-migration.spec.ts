import { env, reset, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

/** Forward-only 0018: last-good publication containment. Populated rehearsal
 * with content-free synthetic digests; no telemetry or identities. */
interface Bindings extends Env { STORAGE_ANALYTICS_DB: D1Database; TEST_ANALYTICS_MIGRATIONS: D1Migration[] }
const b = env as Bindings, db = () => b.STORAGE_ANALYTICS_DB;
const before = () => b.TEST_ANALYTICS_MIGRATIONS.filter(m => m.name < '0018');
const migration = () => b.TEST_ANALYTICS_MIGRATIONS.filter(m => m.name.startsWith('0018'));
const sourceId = 'synthetic-migration-source', erased = 'a'.repeat(64), retained = 'b'.repeat(64), digest = 'c'.repeat(64);
const today = new Date().toISOString().slice(0, 10);
const days = Array.from({ length: 4 }, (_, i) => new Date(Date.parse(today) - i * 86_400_000).toISOString().slice(0, 10));
const [contaminated, provenEmpty, unprovable, later] = days as [string, string, string, string];
const authority = (publicAuthorityEpoch: number) => JSON.stringify({ sourceId, sourceNamespace: 'synthetic', publicAuthorityEpoch,
  policyRevision: 1, collectionRevision: 1, graphInvalidationEpoch: 1, sourceEpoch: 1, sequence: 1 });
const values = (usage: number) => JSON.stringify({ counts: { usage, quota: 0, session: 0 } });
async function count(table: string, where = '1=1'): Promise<number> {
  return Number(await db().prepare(`SELECT count(*) n FROM ${table} WHERE ${where}`).first('n'));
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), before());
  await db().prepare("INSERT INTO analytics_runtime_sources(source_id,source_namespace,contract_version) VALUES(?,'synthetic',1)").bind(sourceId).run();
  await db().batch([
    // Retained fold rows: the erased owner contributed records on one day,
    // an empty fold on another, and its row for a third day was already retired.
    db().prepare('INSERT INTO analytics_community_daily_owners VALUES(?,?,?,1,1,?,?,1,0,NULL,1,?)').bind(sourceId, contaminated, erased, 'v1', 'm', values(3)),
    db().prepare('INSERT INTO analytics_community_daily_owners VALUES(?,?,?,1,1,?,?,1,0,NULL,1,?)').bind(sourceId, provenEmpty, erased, 'v1', 'm', values(0)),
    db().prepare('INSERT INTO analytics_community_daily_owners VALUES(?,?,?,1,1,?,?,1,0,NULL,1,?)').bind(sourceId, provenEmpty, retained, 'v1', 'm', values(2)),
    db().prepare('INSERT INTO analytics_community_daily_owners VALUES(?,?,?,1,1,?,?,1,0,NULL,1,?)').bind(sourceId, unprovable, retained, 'v1', 'm', values(2)),
    db().prepare('INSERT INTO analytics_community_daily_owners VALUES(?,?,?,1,1,?,?,1,0,NULL,1,?)').bind(sourceId, later, retained, 'v1', 'm', values(1)),
    // Publications pinned before the terminal (epoch 5) and one after it (epoch 12).
    db().prepare('INSERT INTO analytics_community_daily_publications VALUES(?,?,1,?,?,?,?,?)').bind(sourceId, contaminated, digest, authority(5), '{}', digest, new Date().toISOString()),
    db().prepare('INSERT INTO analytics_community_daily_publications VALUES(?,?,1,?,?,?,?,?)').bind(sourceId, provenEmpty, digest, authority(5), '{}', digest, new Date().toISOString()),
    db().prepare('INSERT INTO analytics_community_daily_publications VALUES(?,?,1,?,?,?,?,?)').bind(sourceId, unprovable, digest, authority(5), '{}', digest, new Date().toISOString()),
    db().prepare('INSERT INTO analytics_community_daily_publications VALUES(?,?,1,?,?,?,?,?)').bind(sourceId, later, digest, authority(12), '{}', digest, new Date().toISOString()),
    // The prioritized erasure fence for the erased owner at public epoch 9.
    db().prepare('INSERT INTO analytics_storage_erasure_fences VALUES(?,?,?,7,3,4,9)').bind(sourceId, erased, digest),
  ]);
});

describe('0018 last-good publication containment', () => {
  it('backfills the watermark and exact containment, retiring only contaminated or unprovable old publications', async () => {
    expect(await count('analytics_community_daily_publications')).toBe(4);
    await applyD1Migrations(db(), migration());
    expect(await db().prepare('SELECT terminal_public_authority_epoch e,terminal_sequence s FROM analytics_community_terminal_watermarks WHERE source_id=?')
      .bind(sourceId).first()).toEqual({ e: 9, s: 7 });
    expect((await db().prepare('SELECT day,owner_digest,terminal_public_authority_epoch e FROM analytics_community_daily_containment WHERE source_id=?')
      .bind(sourceId).all()).results).toEqual([{ day: contaminated, owner_digest: erased, e: 9 }]);
    // Contaminated (records folded) and unprovable (fold row already retired)
    // are retired; the proven-empty day and the post-terminal day stay.
    expect((await db().prepare('SELECT day FROM analytics_community_daily_publications WHERE source_id=? ORDER BY day').bind(sourceId).all())
      .results.map(row => row.day)).toEqual([...[provenEmpty, later].sort()]);
    // Heads survive so the retired days rebuild through the ordinary selector.
    expect(await count('analytics_community_daily_heads', `source_id='${sourceId}'`)).toBe(4);
    await expect(db().prepare('DELETE FROM analytics_community_daily_containment').run()).rejects.toThrow('analytics_daily_containment_retained');
    await expect(db().prepare('UPDATE analytics_community_terminal_watermarks SET terminal_public_authority_epoch=1').run())
      .rejects.toThrow('analytics_terminal_watermark_regression');
  });
  it('captures containment transactionally with a later fence and never for an empty fold', async () => {
    await applyD1Migrations(db(), migration());
    await db().batch([
      db().prepare('INSERT INTO analytics_community_daily_owners VALUES(?,?,?,1,1,?,?,1,0,NULL,1,?)').bind(sourceId, later, 'd'.repeat(64), 'v11', 'm', values(0)),
      db().prepare('INSERT INTO analytics_community_daily_owners VALUES(?,?,?,1,1,?,?,1,0,NULL,1,?)').bind(sourceId, unprovable, 'd'.repeat(64), 'v11', 'm', values(4)),
      db().prepare('INSERT INTO analytics_storage_erasure_fences VALUES(?,?,?,11,4,5,14)').bind(sourceId, 'd'.repeat(64), 'e'.repeat(64)),
    ]);
    expect(await db().prepare('SELECT terminal_public_authority_epoch e FROM analytics_community_terminal_watermarks WHERE source_id=?')
      .bind(sourceId).first('e')).toBe(14);
    expect((await db().prepare('SELECT day,terminal_public_authority_epoch e FROM analytics_community_daily_containment WHERE source_id=? AND owner_digest=?')
      .bind(sourceId, 'd'.repeat(64)).all()).results).toEqual([{ day: unprovable, e: 14 }]);
  });
});
