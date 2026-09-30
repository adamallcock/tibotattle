import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { createHash } from 'node:crypto';
import { syntheticD1Binding, closeSyntheticD1Bindings, SYNTHETIC_D1_WORKER } from './d1-storage-local-d1.mjs';
import { LAB_DDL, continuityBucket, planLabPlacement, validateLabPlan, targetSegments,
  initializeLabDatabase, inspectLabDatabase, advanceLabSeed, lookupLabSegment,
  boundedLabPool } from './analytics-shard-lab-core.mjs';

const digest = n => createHash('sha256').update(String(n)).digest('hex');
const groups = Array.from({ length: 8 }, (_, i) => ({ group: i + 1,
  bucket: continuityBucket('synthetic-shard-test', digest(i)), records: 17 + i * 3 }));
async function fixture(t, input = groups, count = 4) {
  const mf = new Miniflare({ host: '127.0.0.1', cf: false, modules: true,
    // Match the installed laboratory runtime; remote D1 is a separate gate.
    script: SYNTHETIC_D1_WORKER, compatibilityDate: '2026-07-26',
    d1Databases: { TARGET: 'synthetic-shard-target' } });
  t.after(async () => { await closeSyntheticD1Bindings(mf); await mf.dispose(); });
  return { db: syntheticD1Binding(mf, 'TARGET'), plan: planLabPlacement(input, count) };
}
async function drain(db, plan, target) {
  await initializeLabDatabase(db, plan, target);
  for (let i = 0; i < 200; i++) if ((await advanceLabSeed(db, plan, target, 11)).state === 'ready') return;
  assert.fail('bounded synthetic seed did not finish');
}
test('same continuity scope keeps its virtual bucket across target counts', () => {
  const bucket = continuityBucket('synthetic-shard-test', digest(1));
  for (const count of [1, 3, 4]) {
    const plan = planLabPlacement(groups, count);
    assert.equal(plan.segments.find(s => s.group === 2).bucket, bucket);
    assert.equal(plan.loads.reduce((a, b) => a + b, 0), plan.totalRows);
    assert.deepEqual(planLabPlacement([...groups].reverse(), count), plan);
    validateLabPlan(plan);
  }
});
test('colliding buckets stay together and empty buckets have spread placement', () => {
  const plan = planLabPlacement([{ bucket: 5, group: 1, records: 90 },
    { bucket: 5, group: 2, records: 80 }, { bucket: 4, group: 3, records: 75 }], 4);
  assert.equal(plan.segments[0].target, plan.segments[1].target);
  assert.equal(Math.max(...plan.loads), 170);
  assert.deepEqual(new Set(plan.placement.slice(10, 30)), new Set([0, 1, 2, 3]));
});
test('scope validation refuses missing or ambiguous identifier inputs', () => {
  for (const namespace of ['', '../secret', 'x\n', null]) assert.throws(() => continuityBucket(namespace, digest(1)));
  for (const scope of ['', 'x', 'a'.repeat(63), 'A'.repeat(64), null]) assert.throws(() => continuityBucket('test', scope));
  assert.notEqual(continuityBucket('a', digest(1)), continuityBucket('b', digest(1)));
});
test('closed placement input rejects unrelated fields, duplicates and resource overflow', () => {
  for (const value of [[], [{ ...groups[0], privatePayload: 'must-not-be-accepted' }],
    [groups[0], groups[0]], [{ ...groups[0], records: 0 }],
    [{ ...groups[0], records: 10_000_001 }], [{ ...groups[0], bucket: 256 }]])
    assert.throws(() => planLabPlacement(value, 4));
  for (const count of [0, 2, 5, '4']) assert.throws(() => planLabPlacement(groups, count));
});
test('manifest drift, real data substitution and inconsistent loads refuse', () => {
  const valid = planLabPlacement(groups, 4);
  for (const change of [p => p.dataKind = 'production', p => p.method = 'other',
    p => p.totalRows++, p => p.loads[0]++, p => p.segments[1].from++,
    p => p.segments[1].group = p.segments[0].group, p => p.placement[0] = 4,
    p => p.unreviewed = true]) {
    const plan = structuredClone(valid); change(plan); assert.throws(() => validateLabPlan(plan));
  }
  for (const target of [-2, 4, '0']) assert.throws(() => targetSegments(valid, target));
});
test('native D1 installs the index before loading, resumes and proves exact lookup parity', async t => {
  const { db, plan } = await fixture(t);
  const initial = await initializeLabDatabase(db, plan, -1);
  assert.equal(initial.records, 0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM shard_lab_records').first()).n, 0);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='shard_lab_owner_occurrence'").first()).n, 1);
  await advanceLabSeed(db, plan, -1, 11);
  const after = await inspectLabDatabase(db, plan, -1);
  assert.equal(after.records, 11);
  // A fresh driver resumes from native durable state, not a JavaScript cursor.
  await drain(db, structuredClone(plan), -1);
  const complete = await inspectLabDatabase(db, plan, -1);
  assert.equal(complete.records, plan.totalRows); assert.equal(complete.state, 'ready');
  assert.equal((await advanceLabSeed(db, plan, -1)).writes, false);
  for (const segment of plan.segments) await lookupLabSegment(db, segment);
});
test('lost seed response reconciles an applied batch without a second insert', async t => {
  const { db, plan } = await fixture(t);
  await initializeLabDatabase(db, plan, -1);
  let calls = 0;
  const lost = { ...db, batch: async statements => { calls++; await db.batch(statements); throw Error('synthetic-lost-response'); } };
  const outcome = await advanceLabSeed(lost, plan, -1, 11);
  assert.equal(calls, 1); assert.equal(outcome.reconciled, true);
  assert.equal(outcome.measurementComplete, false);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM shard_lab_records').first()).n, 11);
  assert.equal((await inspectLabDatabase(db, plan, -1)).step, 1);
  await drain(db, plan, -1);
});
test('lost initialization response reconciles complete native DDL', async t => {
  const { db, plan } = await fixture(t); let calls = 0;
  const lost = { ...db, batch: async statements => { calls++; await db.batch(statements); throw Error('synthetic-lost-init-response'); } };
  assert.equal((await initializeLabDatabase(lost, plan, 0)).records, 0);
  assert.equal(calls, 1);
});
test('unapplied write stops without retry, and a later explicit resume works', async t => {
  const { db, plan } = await fixture(t); await initializeLabDatabase(db, plan, 0);
  let calls = 0;
  const lost = { ...db, batch: async () => { calls++; throw Error('synthetic-before-write'); } };
  await assert.rejects(advanceLabSeed(lost, plan, 0), /WRITE_NOT_APPLIED/);
  assert.equal(calls, 1); assert.equal((await inspectLabDatabase(db, plan, 0)).records, 0);
  await drain(db, plan, 0);
});
test('native batch failure rolls back both seed and checkpoint', async t => {
  const { db, plan } = await fixture(t); await initializeLabDatabase(db, plan, 0);
  const broken = { ...db, batch: statements => db.batch([
    ...statements.slice(0, 2), db.prepare('INSERT INTO shard_lab_guard VALUES(0)'), ...statements.slice(2),
  ]) };
  await assert.rejects(advanceLabSeed(broken, plan, 0), /WRITE_NOT_APPLIED/);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM shard_lab_records').first()).n, 0);
  assert.equal((await inspectLabDatabase(db, plan, 0)).step, 0);
});
test('unrelated target schema and changed routing prevent mutation', async t => {
  const { db, plan } = await fixture(t);
  await db.prepare('CREATE TABLE unrelated(value TEXT)').run();
  await assert.rejects(initializeLabDatabase(db, plan, -1), /SCHEMA_DRIFT/);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name<>'_cf_METADATA'").first()).n, 1);
});
test('sealed data corruption refuses completion and invalid measurements stay invalid', async t => {
  const { db, plan } = await fixture(t, [{ group: 1, bucket: 0, records: 7 }], 1);
  await initializeLabDatabase(db, plan, -1); await advanceLabSeed(db, plan, -1);
  await db.prepare('DELETE FROM shard_lab_records WHERE id=2').run();
  await assert.rejects(advanceLabSeed(db, plan, -1), /SEED_PARITY_FAILED/);
  await assert.rejects(lookupLabSegment(db, plan.segments[0]), /LOOKUP_PARITY_FAILED/);
});
test('bounded pool preserves result order, caps active jobs and drains failures', async () => {
  for (const concurrency of [1, 2, 4]) {
    let active = 0, maximum = 0;
    const out = await boundedLabPool([0, 1, 2, 3, 4, 5], concurrency, async n => {
      active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 2)); active--; return n * 2;
    });
    assert.deepEqual(out, [0, 2, 4, 6, 8, 10]); assert(maximum <= concurrency); assert.equal(active, 0);
  }
  let active = 0;
  await assert.rejects(boundedLabPool([0, 1, 2, 3, 4], 4, async n => {
    active++; await new Promise(r => setTimeout(r, 2)); active--;
    if (n === 1) throw Error('synthetic-job-failure'); return n;
  }), /synthetic-job-failure/);
  assert.equal(active, 0);
  await assert.rejects(boundedLabPool([], 3, async () => {}), /CONCURRENCY_INVALID/);
});
