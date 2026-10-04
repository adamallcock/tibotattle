import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeCaptureProofFixture as fixture, captureProofInstant as iso } from '../postgres-test/fixtures/w2-seal/capture-proof-fixtures.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
import test from 'node:test';
import { readCaptureAnchor, beginCapture, finishCapture, createCaptureDraft, validateCaptureDraft, finalizeCaptureDraft, validateCaptureProof, revalidateCaptureProof } from './cutover-capture-proof.mjs';
import { readCloudflareWriterFenceReceipt } from './cloudflare-writer-fence.mjs';

test('synthetic original and successor are accepted by the production EP8v3 reader', async () => {
  const world = await fixture();
  try {
    assert.deepEqual(await readCloudflareWriterFenceReceipt(world.original.path, world.original.sha256), world.original.receipt);
    assert.deepEqual(await readCloudflareWriterFenceReceipt(world.successor.path, world.successor.sha256), world.successor.receipt);
  } finally { await world.dispose(); }
});

async function captured(world, { start = 36, end = 40, completed = 41 } = {}) {
  const anchor = await readCaptureAnchor({ fenceReceiptPath: world.original.path, fenceReceiptSha256: world.original.sha256 });
  const calls = [];
  const sources = ['ingestion', 'deletion-ledger'].map(role => ({ fenceLabel: role, source: { role, databaseIdSha256: anchor.receipt.d1.find(item => item.label === role).idSha256 } }));
  const guarded = { bookmark: async (source, options) => {
    calls.push({ role: source.role, ...options });
    return anchor.receipt.d1.find(item => item.label === source.role).bookmark;
  } };
  const context = await beginCapture({ anchor, sources, guarded, now: () => Date.parse(iso(start)) });
  const times = [Date.parse(iso(end)), Date.parse(iso(completed))];
  const capture = await finishCapture(context, { now: () => times.shift() });
  const body = { schema: 'synthetic-capture-artifact-v1', count: 7 };
  const draft = createCaptureDraft({ kind: 'source-export', body, anchor, capture });
  return { anchor, sources, guarded, calls, draft, body, capture };
}
const finalize = (world, draft, successor = world.successor) => finalizeCaptureDraft({ draft, originalFenceReceiptPath: world.original.path, successorFenceReceiptPath: successor.path, successorFenceReceiptSha256: successor.sha256 });

test('capture compares original fixed timestamp, start and endpoint; later same-lineage fence qualifies complete interval', async () => {
  const world = await fixture();
  try {
    const { calls, draft, body } = await captured(world);
    assert.deepEqual(calls.map(call => call.timestamp), [iso(30), iso(30), iso(36), iso(36), iso(40), iso(40)]);
    assert.equal(validateCaptureDraft(draft), draft);
    const result = await finalize(world, draft);
    assert.deepEqual(result.body, body);
    assert.deepEqual(result.proof.coverage, { start: iso(15), end: iso(70) });
    assert.equal(validateCaptureProof(result.proof, body), result.proof);
    assert.deepEqual(await revalidateCaptureProof({ proof: result.proof, body, originalFenceReceiptPath: world.original.path, successorFenceReceiptPath: world.successor.path }), result.proof);
  } finally { await world.dispose(); }
});

test('finalization refuses successor whose lagged endpoint leaves a capture gap', async () => {
  const world = await fixture();
  try {
    const { draft } = await captured(world);
    await assert.rejects(finalize(world, draft, await world.fence(45)), { code: 'CUTOVER_CAPTURE_PROOF_INVALID' });
  } finally { await world.dispose(); }
});

for (const field of ['accountSha256', 'applyReceiptSha256', 'observationSha256', 'planSha256', 'planReceiptSha256']) {
  test(`finalization refuses draft from a different ${field} lineage`, async () => {
    const world = await fixture();
    try {
      const { draft } = await captured(world);
      const changed = structuredClone(draft);
      changed.lineage[field] = digest(`different-${field}`);
      await assert.rejects(finalize(world, changed), { code: 'CUTOVER_CAPTURE_PROOF_INVALID' });
    } finally { await world.dispose(); }
  });
}

test('finalization refuses source commit and database lineage substitutions', async () => {
  const world = await fixture();
  try {
    const { draft } = await captured(world);
    for (const mutate of [value => { value.lineage.productionWorker.sourceCommit = 'a'.repeat(40); }, value => { value.lineage.d1[1].idSha256 = digest('different-database'); }]) {
      const changed = structuredClone(draft);
      mutate(changed);
      await assert.rejects(finalize(world, changed), { code: 'CUTOVER_CAPTURE_PROOF_INVALID' });
    }
  } finally { await world.dispose(); }
});

test('closed role contracts reject duplicate roles, unknown labels and mismatched database or bookmark hashes', async () => {
  const world = await fixture();
  try {
    const { draft } = await captured(world);
    for (const mutate of [
      value => { value.capture.roles.push(structuredClone(value.capture.roles[0])); },
      value => { value.capture.roles[0].label = 'unknown'; },
      value => { value.capture.roles[0].databaseIdSha256 = digest('other-database'); },
      value => { value.capture.roles[0].bookmarkSha256 = digest('other-bookmark'); },
      value => { value.capture.roles[0].unexpected = true; },
    ]) {
      const changed = structuredClone(draft);
      mutate(changed);
      assert.throws(() => validateCaptureDraft(changed), { code: 'CUTOVER_CAPTURE_PROOF_INVALID' });
    }
  } finally { await world.dispose(); }
});

test('body changes, receipt pin changes and draft-as-proof misuse fail closed', async () => {
  const world = await fixture();
  try {
    const { draft, body } = await captured(world);
    const changed = structuredClone(draft);
    changed.body.count++;
    assert.throws(() => validateCaptureDraft(changed), { code: 'CUTOVER_CAPTURE_PROOF_INVALID' });
    assert.throws(() => validateCaptureProof(draft, body), { code: 'CUTOVER_CAPTURE_PROOF_INVALID' });
    const result = await finalize(world, draft);
    assert.throws(() => validateCaptureProof(result.proof, { ...body, count: 8 }), { code: 'CUTOVER_CAPTURE_PROOF_INVALID' });
    await assert.rejects(finalizeCaptureDraft({ draft, originalFenceReceiptPath: world.original.path, successorFenceReceiptPath: world.successor.path, successorFenceReceiptSha256: digest('wrong-pin') }), { code: 'CUTOVER_FENCE_RECEIPT_INVALID' });
  } finally { await world.dispose(); }
});

test('capture rejects timestamp regression and bookmark drift before artifact qualification', async () => {
  const world = await fixture();
  try {
    const { anchor, sources, guarded } = await captured(world);
    await assert.rejects(beginCapture({ anchor, sources, guarded, now: () => Date.parse(iso(29)) }), { code: 'CUTOVER_CAPTURE_PROOF_INVALID' });
    await assert.rejects(beginCapture({ anchor, sources, guarded: { bookmark: async () => 'synthetic-drift' }, now: () => Date.parse(iso(36)) }), { code: 'CUTOVER_SOURCE_BOOKMARK_DRIFT' });
    const context = await beginCapture({ anchor, sources, guarded, now: () => Date.parse(iso(36)) });
    await assert.rejects(finishCapture(context, { now: () => Date.parse(iso(35)) }), { code: 'CUTOVER_CAPTURE_PROOF_INVALID' });
  } finally { await world.dispose(); }
});

test('reader-valid successor from another account/apply/observation lineage cannot finalize a capture', async () => {
  const world = await fixture();
  const other = await fixture({ lineageTag: 'other-synthetic-account' });
  try {
    await readCloudflareWriterFenceReceipt(other.successor.path, other.successor.sha256);
    const { draft } = await captured(world);
    await assert.rejects(finalize(world, draft, other.successor), { code: 'CUTOVER_CAPTURE_PROOF_INVALID' });
  } finally { await world.dispose(); await other.dispose(); }
});

test('reader-valid successor from another deployment source cannot finalize a capture', async () => {
  const world = await fixture();
  const other = await fixture({ sourceCommit: 'a'.repeat(40) });
  try {
    await readCloudflareWriterFenceReceipt(other.successor.path, other.successor.sha256);
    const { draft } = await captured(world);
    await assert.rejects(finalize(world, draft, other.successor), { code: 'CUTOVER_CAPTURE_PROOF_INVALID' });
  } finally { await world.dispose(); await other.dispose(); }
});

test('release after qualification revokes proof at consumer revalidation', async () => {
  const world = await fixture();
  try {
    const { draft, body } = await captured(world);
    const { proof } = await finalize(world, draft);
    await world.release();
    await assert.rejects(revalidateCaptureProof({ proof, body, originalFenceReceiptPath: world.original.path, successorFenceReceiptPath: world.successor.path }), { code: 'CUTOVER_FENCE_RECEIPT_INVALID' });
  } finally { await world.dispose(); }
});
