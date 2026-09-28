import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { identityDigest } from '../../../scripts/lib/release-operation.mjs';
import { assessSourceWriterInventory, parseSourceWriterInventoryArguments } from './production-source-writer-inventory.mjs';

const mainVersion = '11111111-1111-4111-8111-111111111111';
const analyticsVersion = '22222222-2222-4222-8222-222222222222';
const databaseId = '33333333-3333-4333-8333-333333333333';
const queueId = 'a'.repeat(32);
const settingsDigest = 'b'.repeat(64);
const consumerSettingsDigest = 'c'.repeat(64);
const sortedBy = (values, key) => [...values].sort((a, b) => {
  const left = key(a), right = key(b);
  return left < right ? -1 : left > right ? 1 : 0;
});

function makeSnapshot() {
  return {
    schema: 'cloudflare-source-writer-snapshot-v1',
    capturedAt: '2026-09-28T12:00:00.000Z',
    sourceProvenance: 'caller-supplied-unverified',
    workers: [
      {
        name: 'analytics-worker',
        activeVersions: [{ id: analyticsVersion, percentage: 100 }],
        bindings: [{ type: 'd1', name: 'ANALYTICS_DB', target: databaseId, role: 'read-write' }],
        crons: ['0 3 * * *'],
      },
      {
        name: 'main-worker',
        activeVersions: [{ id: mainVersion, percentage: 100 }],
        bindings: [
          { type: 'd1', name: 'USAGE_DB', target: databaseId, role: 'read-write' },
          { type: 'r2_bucket', name: 'QUARANTINE', target: 'synthetic-quarantine', role: 'writer', transferDisposition: 'separate-review' },
          { type: 'service', name: 'ANALYTICS', target: 'analytics-worker', role: 'invoke' },
          { type: 'queue', name: 'EVENTS', target: 'events', role: 'produce' },
          { type: 'assets', name: 'ASSETS', target: null, role: 'read' },
        ],
        crons: ['* * * * *'],
      },
    ],
    queues: [{
      id: queueId,
      name: 'events',
      settingsDigest,
      producers: [{ worker: 'main-worker', binding: 'EVENTS' }],
      consumers: [{ worker: 'analytics-worker', settingsDigest: consumerSettingsDigest }],
    }],
  };
}

function expectedGraph(snapshot = makeSnapshot()) {
  const graph = {
    workers: sortedBy(snapshot.workers.map(worker => ({
      ...worker,
      activeVersions: [...worker.activeVersions],
      bindings: sortedBy(worker.bindings, binding => `${binding.type}\0${binding.name}`),
      crons: [...worker.crons].sort(),
    })), worker => worker.name),
    queues: sortedBy(snapshot.queues.map(queue => ({
      ...queue,
      producers: sortedBy(queue.producers, producer => `${producer.worker}\0${producer.binding}`),
      consumers: sortedBy(queue.consumers, consumer => consumer.worker),
    })), queue => `${queue.id}\0${queue.name}`),
  };
  return {
    schema: 'cloudflare-source-writer-expected-graph-v1',
    graph,
    graphDigest: identityDigest(graph),
  };
}

test('exact supplied graph comparison emits separate capture and graph digests but never readiness', () => {
  const snapshot = makeSnapshot();
  const first = assessSourceWriterInventory({ snapshot, expectedGraph: expectedGraph(snapshot) });
  assert.equal(first.assessment, 'review_required_match');
  assert.match(first.snapshotCaptureDigest, /^[a-f0-9]{64}$/);
  assert.match(first.snapshotGraphDigest, /^[a-f0-9]{64}$/);
  assert.equal(first.expectedGraphDigest, first.snapshotGraphDigest);
  assert.equal(first.expectedGraphSelfDigestValid, true);
  assert.equal(first.sourceProvenance, 'caller-supplied-unverified');
  assert.equal(first.requestDrainProven, false);
  assert.equal(first.allWritersFenced, false);
  assert.equal(first.cutoverReady, false);
  const changedCapture = structuredClone(snapshot);
  changedCapture.capturedAt = '2026-09-28T12:01:00.000Z';
  const second = assessSourceWriterInventory({ snapshot: changedCapture, expectedGraph: expectedGraph(snapshot) });
  assert.equal(second.snapshotGraphDigest, first.snapshotGraphDigest);
  assert.notEqual(second.snapshotCaptureDigest, first.snapshotCaptureDigest);
  const reorderedKeys = structuredClone(snapshot);
  reorderedKeys.workers[1].bindings[1] = Object.fromEntries(Object.entries(reorderedKeys.workers[1].bindings[1]).reverse());
  const third = assessSourceWriterInventory({ snapshot: reorderedKeys, expectedGraph: expectedGraph(snapshot) });
  assert.equal(third.snapshotGraphDigest, first.snapshotGraphDigest);
  assert.equal(third.snapshotCaptureDigest, first.snapshotCaptureDigest);
  for (const privateValue of [mainVersion, databaseId, 'main-worker', 'synthetic-quarantine']) {
    assert.equal(JSON.stringify(first).includes(privateValue), false);
  }
});

test('any classified graph drift is a review-required mismatch, not a ready result', () => {
  const baselineSnapshot = makeSnapshot();
  const baseline = expectedGraph(baselineSnapshot);
  const drift = [
    snapshot => { snapshot.workers[1].activeVersions[0].id = '44444444-4444-4444-8444-444444444444'; },
    snapshot => { snapshot.workers[1].bindings[1].target = 'other-quarantine'; },
    snapshot => { snapshot.workers[1].bindings[1].transferDisposition = 'exclude'; },
    snapshot => { snapshot.workers[1].bindings[2].target = 'main-worker'; },
    snapshot => { snapshot.workers[1].crons.push('15 * * * *'); },
    snapshot => { snapshot.queues[0].settingsDigest = 'd'.repeat(64); },
    snapshot => {
      snapshot.workers[0].bindings.push({ type: 'queue', name: 'ANALYTICS_EVENTS', target: 'events', role: 'produce' });
      snapshot.queues[0].producers.push({ worker: 'analytics-worker', binding: 'ANALYTICS_EVENTS' });
    },
    snapshot => { snapshot.queues[0].consumers[0].settingsDigest = 'e'.repeat(64); },
    snapshot => { snapshot.workers.push({ name: 'new-worker', activeVersions: [{ id: '55555555-5555-4555-8555-555555555555', percentage: 100 }], bindings: [], crons: [] }); },
  ];
  for (const mutate of drift) {
    const snapshot = structuredClone(baselineSnapshot);
    mutate(snapshot);
    const result = assessSourceWriterInventory({ snapshot, expectedGraph: baseline });
    assert.equal(result.assessment, 'review_required_mismatch');
    assert.notEqual(result.snapshotGraphDigest, result.expectedGraphDigest);
    assert.equal(result.cutoverReady, false);
  }
});

test('unknown bindings, missing classifications, split traffic, and uncovered references fail closed', () => {
  const cases = [
    [snapshot => { snapshot['capturedAt,sourceProvenance'] = 'unexpected'; }, 'SOURCE_WRITER_INVENTORY_INPUT_INVALID'],
    [snapshot => { snapshot.workers[1].bindings.push({ type: 'future_binding', name: 'NEW', target: null, role: 'config' }); }, 'SOURCE_WRITER_INVENTORY_BINDING_TYPE_UNCLASSIFIED'],
    [snapshot => { delete snapshot.workers[1].bindings[0].role; }, 'SOURCE_WRITER_INVENTORY_INPUT_INVALID'],
    [snapshot => { snapshot.workers[1].bindings[1].transferDisposition = 'unknown'; }, 'SOURCE_WRITER_INVENTORY_R2_DISPOSITION_UNCLASSIFIED'],
    [snapshot => {
      snapshot.workers[1].activeVersions[0].percentage = 60;
      snapshot.workers[1].activeVersions.push({ id: '66666666-6666-4666-8666-666666666666', percentage: 40 });
    }, 'SOURCE_WRITER_INVENTORY_ACTIVE_VERSION_UNPROVEN'],
    [snapshot => { snapshot.queues[0].consumers[0].worker = 'missing-worker'; }, 'SOURCE_WRITER_INVENTORY_QUEUE_REFERENCE_UNCLASSIFIED'],
    [snapshot => { snapshot.workers[1].bindings[2].target = 'missing-service'; }, 'SOURCE_WRITER_INVENTORY_SERVICE_REFERENCE_UNCLASSIFIED'],
  ];
  for (const [mutate, code] of cases) {
    const snapshot = makeSnapshot();
    mutate(snapshot);
    assert.throws(() => assessSourceWriterInventory({ snapshot, expectedGraph: expectedGraph() }), { code });
  }
});

test('expected graph must be structurally valid and self-digest-consistent; self-digest is not authorization', () => {
  const snapshot = makeSnapshot();
  const baseline = expectedGraph(snapshot);
  baseline.graphDigest = 'f'.repeat(64);
  let digestError;
  try { assessSourceWriterInventory({ snapshot, expectedGraph: baseline }); } catch (error) { digestError = error; }
  assert.equal(digestError?.code, 'SOURCE_WRITER_INVENTORY_EXPECTED_GRAPH_DIGEST_MISMATCH');
  for (const privateValue of [mainVersion, databaseId, 'main-worker', 'synthetic-quarantine']) {
    assert.equal(digestError.message.includes(privateValue), false);
  }
  const invalid = expectedGraph(snapshot);
  invalid.graph.queues[0].settingsDigest = 'not-a-digest';
  invalid.graphDigest = identityDigest(invalid.graph);
  assert.throws(() => assessSourceWriterInventory({ snapshot, expectedGraph: invalid }), {
    code: 'SOURCE_WRITER_INVENTORY_QUEUE_METADATA_INVALID',
  });
});

test('CLI requires separate snapshot and expected graph inputs; no naked expected digest option exists', () => {
  assert.deepEqual(parseSourceWriterInventoryArguments(['--snapshot', '/private/snapshot.json', '--expected-graph', '/private/expected.json']), {
    snapshotPath: '/private/snapshot.json', expectedGraphPath: '/private/expected.json',
  });
  assert.throws(() => parseSourceWriterInventoryArguments(['--snapshot', '/private/snapshot.json', '--expected-digest', 'a'.repeat(64)]), {
    code: 'SOURCE_WRITER_INVENTORY_ARGUMENTS_INVALID',
  });
});

test('CLI reads private supplied files and emits only review-status digests', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'source-writer-inventory-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshotPath = join(directory, 'snapshot.json');
  const expectedPath = join(directory, 'expected.json');
  const snapshot = makeSnapshot();
  await writeFile(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
  await writeFile(expectedPath, JSON.stringify(expectedGraph(snapshot)), { mode: 0o600 });
  const scriptPath = fileURLToPath(new URL('./production-source-writer-inventory.mjs', import.meta.url));
  const matched = spawnSync(process.execPath, [scriptPath, '--snapshot', snapshotPath, '--expected-graph', expectedPath], { encoding: 'utf8' });
  assert.equal(matched.status, 0);
  const result = JSON.parse(matched.stdout);
  assert.equal(result.assessment, 'review_required_match');
  for (const privateValue of [mainVersion, databaseId, 'main-worker', 'synthetic-quarantine']) {
    assert.equal(matched.stdout.includes(privateValue), false);
  }
  snapshot.workers[1].crons.push('15 * * * *');
  await writeFile(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
  const mismatch = spawnSync(process.execPath, [scriptPath, '--snapshot', snapshotPath, '--expected-graph', expectedPath], { encoding: 'utf8' });
  assert.equal(mismatch.status, 2);
  assert.equal(JSON.parse(mismatch.stdout).assessment, 'review_required_mismatch');
  for (const privateValue of [mainVersion, databaseId, 'main-worker', 'synthetic-quarantine']) {
    assert.equal(mismatch.stdout.includes(privateValue), false);
  }
});
