import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FENCE_GRAPHQL_QUERY_SHA256 } from '../../../scripts/cloudflare-writer-fence.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
export const captureProofInstant = minutes => new Date(Date.UTC(2026, 0, 1) + minutes * 60_000).toISOString();
const roles = ['ingestion', 'analytics', 'deletion-ledger', 'catchup-control'];
const productionWorker = { name: 'synthetic-production', deploymentId: 'synthetic-deployment', versionId: '11111111-1111-4111-8111-111111111111', mode: 'fenced', sourceCommit: 'f'.repeat(40) };

// Each fixture is a complete, private, reader-valid EP8v3 receipt ecosystem.
// All identifiers and bookmarks are synthetic and no provider is contacted.
export async function writeCaptureProofFixture({ lineageTag = 'synthetic', sourceCommit = 'f'.repeat(40), d1: suppliedD1, accountSha256: suppliedAccountSha256 } = {}) {
  const worker = { ...productionWorker, sourceCommit };
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'capture-proof-synthetic-'));
  const receipts = join(directory, 'receipts');
  await mkdir(receipts, { mode: 0o700 });
  async function save(name, value) {
    const bytes = `${JSON.stringify(value)}\n`;
    const sha256 = digest(bytes);
    const path = join(receipts, name.replace('{hash}', sha256));
    await writeFile(path, bytes, { mode: 0o600 });
    return { path, sha256, receipt: value };
  }
  const planSha256 = digest(`${lineageTag}-plan`);
  const fingerprintSha256 = digest(`${lineageTag}-fingerprint`);
  const accountSha256 = suppliedAccountSha256 ?? digest(`${lineageTag}-account`);
  const d1 = suppliedD1 ?? roles.map(label => ({ label, idSha256: digest(`synthetic-d1:${label}`), bookmark: `synthetic-bookmark-${label}` }));
  const r2 = { bucketSha256: digest('synthetic-bucket'), inventorySha256: digest('synthetic-inventory'), objects: 0, bytes: 0 };
  const fencedScripts = [{ name: 'synthetic-analytics', kind: 'cron', crons: [], deliveryPaused: null }];
  const plan = await save('plan-{hash}.json', { schema: 'cloudflare-writer-fence-plan-receipt-v1', planSha256, fingerprintSha256, quietWindowMinutes: 15,
    inventory: { accountSha256, planSha256, productionWorker: { name: worker.name }, dataResources: [...d1.map(({ label, idSha256 }) => ({ kind: 'd1', label, idSha256 })), { kind: 'r2', idSha256: r2.bucketSha256 }], fencedScripts } });
  const apply = await save(`apply-${plan.sha256}.json`, { schema: 'cloudflare-writer-fence-apply-v1', planSha256, planReceiptSha256: plan.sha256, appliedAtMs: Date.parse(captureProofInstant(0)), quietWindowMinutes: 15, fingerprintSha256, r2Baseline: r2 });
  const observation = await save('observation-{hash}.json', { schema: 'cloudflare-writer-fence-observation-v2', bookmarkMode: 'fixed-timestamp-literal', planSha256, planReceiptSha256: plan.sha256, applyReceiptSha256: apply.sha256, accountSha256, fingerprintSha256, startedAt: captureProofInstant(15), completedAt: captureProofInstant(15), bookmarkTimestamp: captureProofInstant(15), productionWorker: worker, d1, r2 });
  async function fence(endMinutes, overrides = {}) {
    return save('fence-{hash}.json', { schema: 'cloudflare-writer-fence-receipt-v3', planSha256, planReceiptSha256: plan.sha256, applyReceiptSha256: apply.sha256, accountSha256, observationSha256: observation.sha256, bookmarkMode: 'fixed-timestamp-literal', bookmarkTimestamp: captureProofInstant(endMinutes - 5), verifiedAt: captureProofInstant(endMinutes), productionWorker: worker, fencedScripts, window: { appliedAt: captureProofInstant(0), quietWindowMinutes: 15, start: captureProofInstant(15), end: captureProofInstant(endMinutes) }, d1, r2,
      analytics: { querySha256: FENCE_GRAPHQL_QUERY_SHA256, window: { start: captureProofInstant(15), end: captureProofInstant(endMinutes - 5), lagMinutes: 5 }, d1: roles.map(label => ({ label, rowsWritten: 0, writeQueries: 0 })), fencedScriptInvocations: 0 }, ...overrides });
  }
  const original = await fence(35);
  const successor = await fence(75);
  return { directory, original, successor, fence, save, release: () => save(`release-${plan.sha256}.json`, { schema: 'released' }), dispose: () => rm(directory, { recursive: true, force: true }) };
}
