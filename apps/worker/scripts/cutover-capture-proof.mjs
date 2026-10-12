// Prospective read-only capture proof. Drafts never qualify downstream artifacts.
import { readCloudflareWriterFenceReceipt } from './cloudflare-writer-fence.mjs';
import { canonicalJson, cutoverFail, sha256Hex } from './cutover-source-seal.mjs';

export const CAPTURE_DRAFT_SCHEMA = 'tibotattle-cutover-capture-draft-v1';
export const CAPTURE_PROOF_SCHEMA = 'tibotattle-cutover-capture-proof-v1';
const FIXED_FENCE = 'cloudflare-writer-fence-receipt-v3';
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SCRIPT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const OPAQUE = /^[A-Za-z0-9_.:-]{8,512}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const fail = () => cutoverFail('CUTOVER_CAPTURE_PROOF_INVALID');
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail();
}
function instant(value) {
  if (typeof value !== 'string' || !INSTANT.test(value)) fail();
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || new Date(ms).toISOString() !== value) fail();
  return ms;
}
function clock(now) {
  const value = now();
  const ms = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(ms)) fail();
  return new Date(ms).toISOString();
}
function lineage(receipt) {
  return { planSha256: receipt.planSha256, planReceiptSha256: receipt.planReceiptSha256,
    applyReceiptSha256: receipt.applyReceiptSha256, observationSha256: receipt.observationSha256,
    accountSha256: receipt.accountSha256, productionWorker: receipt.productionWorker,
    windowStart: receipt.window.start, fencedScripts: receipt.fencedScripts, r2: receipt.r2, d1: receipt.d1 };
}
export async function readCaptureAnchor({ fenceReceiptPath, fenceReceiptSha256 }) {
  let receipt;
  try { receipt = await readCloudflareWriterFenceReceipt(fenceReceiptPath, fenceReceiptSha256); }
  catch { cutoverFail("CUTOVER_FENCE_RECEIPT_INVALID"); }
  return Object.freeze({ fixed: receipt.schema === FIXED_FENCE, receipt, fenceReceiptSha256 });
}
function entries(anchor, sources) {
  if (!anchor?.fixed || !Array.isArray(sources) || sources.length === 0 || sources.length > 4) fail();
  const roles = new Set();
  return sources.map(item => {
    const pin = anchor.receipt.d1.find(entry => entry.label === item.fenceLabel);
    if (!pin || pin.idSha256 !== item.source?.databaseIdSha256 || roles.has(item.source.role)) fail();
    roles.add(item.source.role);
    return { role: item.source.role, label: pin.label, databaseIdSha256: pin.idSha256,
      bookmarkSha256: sha256Hex(pin.bookmark) };
  });
}
async function compare(anchor, sources, guarded, timestamp) {
  for (const item of sources) {
    const expected = anchor.receipt.d1.find(entry => entry.label === item.fenceLabel);
    if (await guarded.bookmark(item.source, { timestamp }) !== expected.bookmark)
      cutoverFail('CUTOVER_SOURCE_BOOKMARK_DRIFT', { role: item.source.role });
  }
}
export async function beginCapture({ anchor, sources, guarded, now = Date.now }) {
  const roles = entries(anchor, sources);
  const startedAt = clock(now);
  if (instant(startedAt) < instant(anchor.receipt.bookmarkTimestamp)) fail();
  await compare(anchor, sources, guarded, anchor.receipt.bookmarkTimestamp);
  await compare(anchor, sources, guarded, startedAt);
  return Object.freeze({ anchor, sources, guarded, roles, startedAt });
}
export async function finishCapture(context, { now = Date.now } = {}) {
  const endpointTimestamp = clock(now);
  if (instant(endpointTimestamp) < instant(context.startedAt)) fail();
  await compare(context.anchor, context.sources, context.guarded, endpointTimestamp);
  const completedAt = clock(now);
  if (instant(completedAt) < instant(endpointTimestamp)) fail();
  return Object.freeze({ startedAt: context.startedAt, endpointTimestamp, completedAt, roles: context.roles });
}
function validateCapture(capture, anchorLineage) {
  keys(capture, ['startedAt', 'endpointTimestamp', 'completedAt', 'roles']);
  const start = instant(capture.startedAt), endpoint = instant(capture.endpointTimestamp), end = instant(capture.completedAt);
  if (start > endpoint || endpoint > end || start < instant(anchorLineage.windowStart)
      || !Array.isArray(capture.roles) || capture.roles.length < 1 || capture.roles.length > 4) fail();
  const seen = new Set();
  for (const role of capture.roles) {
    keys(role, ['role', 'label', 'databaseIdSha256', 'bookmarkSha256']);
    const pin = anchorLineage.d1.find(item => item.label === role.label);
    if (!['ingestion', 'deletion-ledger', 'analytics', 'analytics-floor', 'analytics-bookmark'].includes(role.role) || !pin || role.databaseIdSha256 !== pin.idSha256
        || role.bookmarkSha256 !== sha256Hex(pin.bookmark) || seen.has(role.role)) fail();
    seen.add(role.role);
  }
}
function validateLineage(value) {
  keys(value, ['planSha256', 'planReceiptSha256', 'applyReceiptSha256', 'observationSha256', 'accountSha256',
    'productionWorker', 'windowStart', 'fencedScripts', 'r2', 'd1']);
  for (const key of ['planSha256', 'planReceiptSha256', 'applyReceiptSha256', 'observationSha256', 'accountSha256'])
    if (!SHA.test(value[key] ?? '')) fail();
  instant(value.windowStart);
  keys(value.productionWorker, ['name', 'deploymentId', 'versionId', 'mode', 'sourceCommit']);
  if (value.productionWorker.mode !== 'fenced' || !SCRIPT.test(value.productionWorker.name ?? '')
      || !OPAQUE.test(value.productionWorker.deploymentId ?? '') || !UUID.test(value.productionWorker.versionId ?? '')
      || !COMMIT.test(value.productionWorker.sourceCommit ?? '')) fail();
  keys(value.r2, ['bucketSha256', 'inventorySha256', 'objects', 'bytes']);
  if (!SHA.test(value.r2.bucketSha256 ?? '') || !SHA.test(value.r2.inventorySha256 ?? '')
      || !Number.isSafeInteger(value.r2.objects) || value.r2.objects < 0
      || !Number.isSafeInteger(value.r2.bytes) || value.r2.bytes < 0) fail();
  if (!Array.isArray(value.fencedScripts) || value.fencedScripts.length === 0 || value.fencedScripts.length > 64) fail();
  const scriptNames = new Set([value.productionWorker.name]);
  for (const item of value.fencedScripts) {
    keys(item, ['name', 'kind', 'crons', 'deliveryPaused']);
    if (!SCRIPT.test(item.name ?? '') || scriptNames.has(item.name) || !Array.isArray(item.crons) || item.crons.length !== 0
        || !(item.kind === 'cron' ? item.deliveryPaused === null : item.kind === 'queue-consumer' && item.deliveryPaused === true)) fail();
    scriptNames.add(item.name);
  }
  if (!Array.isArray(value.d1) || value.d1.length !== 4) fail();
  const labels = new Set();
  for (const item of value.d1) {
    keys(item, ['label', 'idSha256', 'bookmark']);
    if (!['ingestion', 'analytics', 'deletion-ledger', 'catchup-control'].includes(item.label)
        || labels.has(item.label) || !SHA.test(item.idSha256 ?? '') || typeof item.bookmark !== 'string'
        || !OPAQUE.test(item.bookmark)) fail();
    labels.add(item.label);
  }
}
export function createCaptureDraft({ kind, body, anchor, capture }) {
  if (!anchor?.fixed || typeof kind !== 'string' || !/^[a-z-]+$/.test(kind)) fail();
  const draft = { schema: CAPTURE_DRAFT_SCHEMA, kind, body, bodySha256: sha256Hex(canonicalJson(body)),
    originalFenceReceiptSha256: anchor.fenceReceiptSha256, lineage: lineage(anchor.receipt), capture };
  validateCaptureDraft(draft);
  return Object.freeze(draft);
}
export function validateCaptureDraft(draft) {
  keys(draft, ['schema', 'kind', 'body', 'bodySha256', 'originalFenceReceiptSha256', 'lineage', 'capture']);
  if (draft.schema !== CAPTURE_DRAFT_SCHEMA || !/^[a-z-]+$/.test(draft.kind ?? '')
      || !SHA.test(draft.originalFenceReceiptSha256 ?? '') || draft.bodySha256 !== sha256Hex(canonicalJson(draft.body))) fail();
  validateLineage(draft.lineage);
  validateCapture(draft.capture, draft.lineage);
  return draft;
}
export function validateCaptureProof(proof, body) {
  keys(proof, ['schema', 'kind', 'bodySha256', 'originalFenceReceiptSha256', 'successorFenceReceiptSha256',
    'lineage', 'capture', 'coverage']);
  if (proof.schema !== CAPTURE_PROOF_SCHEMA || !/^[a-z-]+$/.test(proof.kind ?? '')
      || !SHA.test(proof.originalFenceReceiptSha256 ?? '') || !SHA.test(proof.successorFenceReceiptSha256 ?? '')
      || proof.bodySha256 !== sha256Hex(canonicalJson(body))) fail();
  validateLineage(proof.lineage);
  validateCapture(proof.capture, proof.lineage);
  keys(proof.coverage, ['start', 'end']);
  if (instant(proof.coverage.start) !== instant(proof.lineage.windowStart)
      || instant(proof.coverage.start) > instant(proof.capture.startedAt)
      || instant(proof.coverage.end) < instant(proof.capture.completedAt)) fail();
  return proof;
}
export async function finalizeCaptureDraft({ draft, originalFenceReceiptPath, successorFenceReceiptPath,
  successorFenceReceiptSha256 }) {
  validateCaptureDraft(draft);
  const original = await readCaptureAnchor({ fenceReceiptPath: originalFenceReceiptPath,
    fenceReceiptSha256: draft.originalFenceReceiptSha256 });
  const successor = await readCaptureAnchor({ fenceReceiptPath: successorFenceReceiptPath,
    fenceReceiptSha256: successorFenceReceiptSha256 });
  if (!original.fixed || !successor.fixed
      || instant(draft.capture.startedAt) < instant(original.receipt.bookmarkTimestamp) || !equal(lineage(original.receipt), draft.lineage)
      || !equal(lineage(successor.receipt), draft.lineage)
      || instant(successor.receipt.analytics.window.start) > instant(draft.capture.startedAt)
      || instant(successor.receipt.bookmarkTimestamp) < instant(draft.capture.completedAt)) fail();
  const proof = { schema: CAPTURE_PROOF_SCHEMA, kind: draft.kind, bodySha256: draft.bodySha256,
    originalFenceReceiptSha256: draft.originalFenceReceiptSha256, successorFenceReceiptSha256,
    lineage: draft.lineage, capture: draft.capture, coverage: { ...successor.receipt.analytics.window } };
  delete proof.coverage.lagMinutes;
  validateCaptureProof(proof, draft.body);
  return Object.freeze({ body: draft.body, proof: Object.freeze(proof) });
}
export async function revalidateCaptureProof({ proof, body, originalFenceReceiptPath, successorFenceReceiptPath }) {
  validateCaptureProof(proof, body);
  const draft = { schema: CAPTURE_DRAFT_SCHEMA, kind: proof.kind, body, bodySha256: proof.bodySha256,
    originalFenceReceiptSha256: proof.originalFenceReceiptSha256, lineage: proof.lineage, capture: proof.capture };
  const result = await finalizeCaptureDraft({ draft, originalFenceReceiptPath, successorFenceReceiptPath,
    successorFenceReceiptSha256: proof.successorFenceReceiptSha256 });
  if (!equal(result.proof, proof)) fail();
  return proof;
}
