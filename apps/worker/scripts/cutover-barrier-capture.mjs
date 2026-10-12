#!/usr/bin/env node
// Read-only production barrier evidence. Default is offline preflight; capture
// requires --execute --remote --owner-read-only. No credentials are sent.
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEPLOYMENT_ENDPOINTS } from '../../../config/deployment-endpoints.js';
import { readCloudflareWriterFenceReceipt } from './cloudflare-writer-fence.mjs';
import { CUTOVER_BARRIER_PROOF_SCHEMA, validateBarrierProof } from './cutover-source-fence.mjs';
import { assertOwnerDirectory, canonicalJson, sha256Hex } from './cutover-source-seal.mjs';

export const BARRIER_CAPTURE_LIMITS = Object.freeze({ responseBytes: 65_536, requestMs: 5_000, totalMs: 15_000 });
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA = /^[0-9a-f]{64}$/u;
function refuse(code) { const error = new Error(code); error.code = code; throw error; }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function instant(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) refuse('BARRIER_CAPTURE_CLOCK_INVALID');
  return value;
}
function assertFence(receipt, time) {
  const end = Date.parse(receipt?.window?.end);
  if (receipt?.productionWorker?.mode !== 'fenced' || !COMMIT.test(receipt.productionWorker.sourceCommit ?? '')
      || !Number.isFinite(end) || end > time || receipt.analytics?.fencedScriptInvocations !== 0
      || !Array.isArray(receipt.fencedScripts) || receipt.fencedScripts.some(item => !Array.isArray(item.crons)
        || item.crons.length !== 0 || (item.kind === 'queue-consumer' ? item.deliveryPaused !== true : item.deliveryPaused !== null))) {
    refuse('BARRIER_CAPTURE_FENCE_INVALID');
  }
}
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; refuse('BARRIER_CAPTURE_OUTPUT_UNSAFE'); }
  refuse('BARRIER_CAPTURE_OUTPUT_EXISTS');
}
async function atomicPrivateWrite(directory, path, bytes) {
  const temp = join(directory, `.barrier-${randomUUID()}.tmp`);
  let handle;
  try {
    await assertOwnerDirectory(directory);
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
    await handle.close(); handle = null;
    await assertOwnerDirectory(directory);
    // link is an atomic, no-replace publication on the same filesystem.
    await link(temp, path);
    await unlink(temp);
    const dirHandle = await open(directory, constants.O_RDONLY);
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  } catch (error) {
    if (error.code === 'EEXIST') refuse('BARRIER_CAPTURE_OUTPUT_EXISTS');
    if (String(error.code ?? '').startsWith('CUTOVER_')) refuse('BARRIER_CAPTURE_OUTPUT_UNSAFE');
    refuse('BARRIER_CAPTURE_OUTPUT_FAILED');
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
async function boundedGet(url, fetcher, remainingMs) {
  const controller = new AbortController();
  let timeout;
  const expired = new Promise((_, reject) => {
    timeout = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('BARRIER_CAPTURE_TIMEOUT'), { code: 'BARRIER_CAPTURE_TIMEOUT' })); },
      Math.min(BARRIER_CAPTURE_LIMITS.requestMs, remainingMs));
  });
  const operation = async () => {
    let response;
    try { response = await fetcher(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { accept: 'application/json' }, signal: controller.signal }); }
    catch { refuse('BARRIER_CAPTURE_HTTP_FAILED'); }
    if (!response || response.redirected || (response.url && response.url !== url)
        || ![200, 503].includes(response.status) || !response.body?.getReader) refuse('BARRIER_CAPTURE_HTTP_INVALID');
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > BARRIER_CAPTURE_LIMITS.responseBytes)) {
      controller.abort(); refuse('BARRIER_CAPTURE_RESPONSE_TOO_LARGE');
    }
    const reader = response.body.getReader();
    const chunks = []; let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) refuse('BARRIER_CAPTURE_HTTP_INVALID');
        length += chunk.value.length;
        if (length > BARRIER_CAPTURE_LIMITS.responseBytes) refuse('BARRIER_CAPTURE_RESPONSE_TOO_LARGE');
        chunks.push(Buffer.from(chunk.value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { refuse('BARRIER_CAPTURE_JSON_INVALID'); }
    if (!record(body)) refuse('BARRIER_CAPTURE_JSON_INVALID');
    const headers = Object.fromEntries(['cache-control', 'content-type', ...(response.status === 503 ? ['retry-after'] : [])]
      .map(name => [name, response.headers.get(name)]));
    return { method: 'GET', url, status: response.status, headers, body };
  };
  try { return await Promise.race([operation(), expired]); }
  finally { clearTimeout(timeout); controller.abort(); }
}

export async function captureBarrierProof({ origin, fenceReceiptPath, fenceReceiptSha256, ownerDirectory,
  execute = false, remote = false, ownerReadOnly = false, fetcher = globalThis.fetch, now = Date.now,
  readFence = readCloudflareWriterFenceReceipt } = {}) {
  if (origin !== DEPLOYMENT_ENDPOINTS.public.origin || !isAbsolute(fenceReceiptPath ?? '')
      || !SHA.test(fenceReceiptSha256 ?? '') || typeof execute !== 'boolean' || typeof remote !== 'boolean'
      || typeof ownerReadOnly !== 'boolean' || (execute ? !remote || !ownerReadOnly : remote || ownerReadOnly)) {
    refuse('BARRIER_CAPTURE_ARGUMENT_INVALID');
  }
  const directory = await assertOwnerDirectory(ownerDirectory);
  const output = join(directory, 'barrier-proof.json');
  await absent(output);
  const start = instant(now);
  const receipt = await readFence(resolve(fenceReceiptPath), fenceReceiptSha256);
  assertFence(receipt, start);
  if (!execute) return { executed: false, code: 'BARRIER_CAPTURE_PREFLIGHT', sourceCommit: receipt.productionWorker.sourceCommit };
  const remaining = () => { const duration = instant(now) - start;
    if (duration < 0 || duration >= BARRIER_CAPTURE_LIMITS.totalMs) refuse('BARRIER_CAPTURE_TIMEOUT');
    return BARRIER_CAPTURE_LIMITS.totalMs - duration; };
  const health = await boundedGet(`${origin}/api/health`, fetcher, remaining());
  // Persist only the closed, content-free health fields consumed by PT-2.
  health.body = { status: health.body.status, mode: health.body.mode,
    maintenance: { state: health.body.maintenance?.state, storageQualified: health.body.maintenance?.storageQualified },
    deployment: { sourceCommit: health.body.deployment?.sourceCommit } };
  const probe = await boundedGet(`${origin}/api/ready`, fetcher, remaining());
  probe.body = { error: { code: probe.body.error?.code, requestId: probe.body.error?.requestId } };
  remaining();
  const end = instant(now);
  const proof = { schema: CUTOVER_BARRIER_PROOF_SCHEMA, observedAt: new Date(end).toISOString(), health, probe };
  let accepted;
  try { accepted = validateBarrierProof(proof); } catch { refuse('BARRIER_CAPTURE_PROOF_INVALID'); }
  if (accepted.sourceCommit !== receipt.productionWorker.sourceCommit) refuse('BARRIER_CAPTURE_SOURCE_MISMATCH');
  const after = await readFence(resolve(fenceReceiptPath), fenceReceiptSha256);
  assertFence(after, instant(now));
  if (canonicalJson(after) !== canonicalJson(receipt)) refuse('BARRIER_CAPTURE_FENCE_CHANGED');
  remaining();
  const bytes = Buffer.from(`${canonicalJson(proof)}\n`);
  await atomicPrivateWrite(directory, output, bytes);
  return { executed: true, code: 'BARRIER_CAPTURED', sha256: sha256Hex(bytes), bytes: bytes.length,
    observedAt: proof.observedAt, sourceCommit: accepted.sourceCommit };
}

export function parseBarrierCaptureArguments(argv) {
  if (argv[0] !== 'capture') refuse('BARRIER_CAPTURE_ARGUMENT_INVALID');
  const value = {}; const seen = new Set();
  const flags = { '--origin': 'origin', '--fence-receipt': 'fenceReceiptPath', '--fence-sha256': 'fenceReceiptSha256',
    '--owner-dir': 'ownerDirectory', '--execute': 'execute', '--remote': 'remote', '--owner-read-only': 'ownerReadOnly' };
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (!Object.hasOwn(flags, flag) || seen.has(flag)) refuse('BARRIER_CAPTURE_ARGUMENT_INVALID');
    seen.add(flag);
    if (['--execute', '--remote', '--owner-read-only'].includes(flag)) value[flags[flag]] = true;
    else { const input = argv[++index]; if (!input || input.startsWith('--')) refuse('BARRIER_CAPTURE_ARGUMENT_INVALID'); value[flags[flag]] = input; }
  }
  return value;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await captureBarrierProof(parseBarrierCaptureArguments(process.argv.slice(2))))); }
  catch (error) { console.error(JSON.stringify({ ok: false, code: /^BARRIER_CAPTURE_[A-Z_]+$/u.test(error.code ?? '')
    ? error.code : 'BARRIER_CAPTURE_REFUSED' })); process.exitCode = 1; }
}
