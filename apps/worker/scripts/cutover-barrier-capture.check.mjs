import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureBarrierProof, parseBarrierCaptureArguments, BARRIER_CAPTURE_LIMITS } from './cutover-barrier-capture.mjs';
import { validateBarrierProof } from './cutover-source-fence.mjs';
import { writeFenceReceiptFixture } from '../postgres-test/fixtures/w2-seal/fence-fixtures.mjs';

const origin = 'https://tibotattle.com';
const sourceCommit = 'a'.repeat(40);
const requestId = '11111111-1111-4111-8111-111111111111';
const receipt = { productionWorker: { mode: 'fenced', sourceCommit },
  window: { end: '2026-10-04T00:00:00.000Z' }, analytics: { fencedScriptInvocations: 0 },
  fencedScripts: [{ kind: 'cron', crons: [], deliveryPaused: null }] };
const clone = value => structuredClone(value);
const health = () => ({ status: 'ok', mode: 'migration-mutation-barrier', maintenance: { state: 'fenced', storageQualified: false },
  deployment: { sourceCommit }, extra: 'synthetic-private-field-not-retained' });
const probe = () => ({ error: { code: 'MUTATION_BARRIER_ACTIVE', requestId, privateField: 'not-retained' } });
function response(body, status = 200, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      ...(status === 503 ? { 'retry-after': '300' } : {}), ...headers } });
}
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp('/private/tmp/barrier-capture-test-');
  await chmod(dir, 0o700); t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = []; let reads = 0;
  const args = { origin, fenceReceiptPath: join(dir, 'fence.json'), fenceReceiptSha256: 'b'.repeat(64), ownerDirectory: dir,
    execute: true, remote: true, ownerReadOnly: true, now: () => Date.parse('2026-10-04T00:01:00.000Z'),
    readFence: async () => { reads++; return clone(receipt); },
    fetcher: async (url, options) => { calls.push({ url, options }); return url.endsWith('/health') ? response(health()) : response(probe(), 503); }, ...overrides };
  return { dir, calls, args, reads: () => reads, run: extra => captureBarrierProof({ ...args, ...extra }) };
}
const refused = (promise, code) => assert.rejects(promise, error => error.code === code);

test('live transport bytes produce the existing validated proof with safe GETs and private atomic output', async t => {
  const f = await fixture(t); const result = await f.run();
  assert.equal(result.code, 'BARRIER_CAPTURED'); assert.equal(f.reads(), 2);
  assert.deepEqual(f.calls.map(x => x.url), [`${origin}/api/health`, `${origin}/api/ready`]);
  for (const { options } of f.calls) {
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, { accept: 'application/json' });
  }
  const bytes = await readFile(join(f.dir, 'barrier-proof.json')); const proof = JSON.parse(bytes);
  assert.equal(validateBarrierProof(proof).sourceCommit, sourceCommit);
  assert.equal(proof.observedAt, '2026-10-04T00:01:00.000Z');
  assert.equal(bytes.includes('not-retained'), false);
  const stat = await lstat(join(f.dir, 'barrier-proof.json'));
  assert.equal(stat.mode & 0o777, 0o400); assert.equal(stat.nlink, 1);
  assert.deepEqual(await readdir(f.dir), ['barrier-proof.json']);
  await refused(f.run(), 'BARRIER_CAPTURE_OUTPUT_EXISTS');
  assert.equal(f.calls.length, 2);
});
test('offline preflight reads only the fence and never requests HTTP or creates output', async t => {
  const f = await fixture(t); const result = await f.run({ execute: false, remote: false, ownerReadOnly: false });
  assert.equal(result.executed, false); assert.equal(f.calls.length, 0); assert.equal(f.reads(), 1);
  assert.deepEqual(await readdir(f.dir), []);
});
test('origin and authorization switches fail before any request', async t => {
  const f = await fixture(t);
  for (const extra of [{ origin: 'http://tibotattle.com' }, { origin: `${origin}/` }, { origin: 'https://tibotattle.com.evil.invalid' },
    { origin: 'https://user@tibotattle.com' }, { origin: `${origin}?token=private` }, { remote: false }, { ownerReadOnly: false },
    { execute: false }, { fenceReceiptPath: 'relative' }, { fenceReceiptSha256: 'bad' }]) {
    await refused(f.run(extra), 'BARRIER_CAPTURE_ARGUMENT_INVALID');
  }
  assert.equal(f.calls.length, 0);
});
test('source, response shape, barrier headers and probe result refusals leave no proof', async t => {
  for (const variant of ['source', 'not-fenced', 'status', 'cache', 'retry', 'request-id', 'json', 'utf8', 'redirect']) {
    const f = await fixture(t);
    await refused(f.run({ fetcher: async url => {
      if (url.endsWith('/health')) {
        if (variant === 'source') return response({ ...health(), deployment: { sourceCommit: 'c'.repeat(40) } });
        if (variant === 'not-fenced') return response({ ...health(), mode: 'worker' });
        if (variant === 'status') return response(health(), 201);
        if (variant === 'cache') return response(health(), 200, { 'cache-control': 'public' });
        if (variant === 'json') return response('not-json');
        if (variant === 'utf8') return new Response(new Uint8Array([0xff]), { status: 200 });
        if (variant === 'redirect') return { ...response(health()), redirected: true };
        return response(health());
      }
      return variant === 'retry' ? response(probe(), 503, { 'retry-after': '60' }) :
        variant === 'request-id' ? response({ error: { code: 'MUTATION_BARRIER_ACTIVE', requestId: 'bad' } }, 503) : response(probe(), 503);
    } }), variant === 'source' ? 'BARRIER_CAPTURE_SOURCE_MISMATCH' :
      ['status', 'redirect'].includes(variant) ? 'BARRIER_CAPTURE_HTTP_INVALID' :
        ['json', 'utf8'].includes(variant) ? 'BARRIER_CAPTURE_JSON_INVALID' : 'BARRIER_CAPTURE_PROOF_INVALID');
    assert.deepEqual(await readdir(f.dir), []);
  }
});
test('declared and streaming response caps fail closed', async t => {
  for (const declared of [true, false]) {
    const f = await fixture(t);
    await refused(f.run({ fetcher: async () => response('x'.repeat(BARRIER_CAPTURE_LIMITS.responseBytes + 1), 200,
      declared ? { 'content-length': String(BARRIER_CAPTURE_LIMITS.responseBytes + 1) } : {}) }), 'BARRIER_CAPTURE_RESPONSE_TOO_LARGE');
    assert.deepEqual(await readdir(f.dir), []);
  }
});
test('header and stalled body reads have deadlines even when a transport ignores abort', async t => {
  const f = await fixture(t);
  await refused(f.run({ fetcher: async () => new Promise(() => {}) }), 'BARRIER_CAPTURE_TIMEOUT');
  const g = await fixture(t);
  await refused(g.run({ fetcher: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }),
    { headers: { 'content-type': 'application/json' } }) }), 'BARRIER_CAPTURE_TIMEOUT');
  assert.deepEqual(await readdir(f.dir), []); assert.deepEqual(await readdir(g.dir), []);
});
test('fence future time, released reader and changed fence refuse without publication', async t => {
  const f = await fixture(t);
  await refused(f.run({ readFence: async () => ({ ...clone(receipt), window: { end: '2026-10-04T00:02:00.000Z' } }) }), 'BARRIER_CAPTURE_FENCE_INVALID');
  await assert.rejects(f.run({ readFence: async () => { throw Object.assign(new Error('redacted'), { code: 'FENCE_RELEASED' }); } }), /redacted/);
  let reads = 0;
  await refused(f.run({ readFence: async () => ({ ...clone(receipt), ...(reads++ ? { changed: true } : {}) }) }), 'BARRIER_CAPTURE_FENCE_CHANGED');
  assert.deepEqual(await readdir(f.dir), []);
});
test('real EP8 reader binds the receipt hash and refuses release before any HTTP', async t => {
  for (const released of [false, true]) {
    const f = await fixture(t);
    const pin = await writeFenceReceiptFixture({ directory: f.dir, sourceCommit, released,
      appliedAtMs: Date.parse('2026-10-03T23:00:00.000Z') });
    const args = { ...f.args, fenceReceiptPath: pin.path, fenceReceiptSha256: released ? pin.sha256 : '0'.repeat(64) };
    delete args.readFence;
    await assert.rejects(captureBarrierProof(args));
    assert.equal(f.calls.length, 0);
    assert.equal((await readdir(f.dir)).includes('barrier-proof.json'), false);
  }
});
test('unsafe directories and preexisting/symlink destinations never publish', async t => {
  const f = await fixture(t); await chmod(f.dir, 0o755);
  await assert.rejects(f.run(), error => error.code === 'CUTOVER_OWNER_DIRECTORY_UNSAFE');
  await chmod(f.dir, 0o700);
  const target = join(f.dir, 'owned'); await writeFile(target, 'unchanged', { mode: 0o600 });
  await symlink(target, join(f.dir, 'barrier-proof.json'));
  await refused(f.run(), 'BARRIER_CAPTURE_OUTPUT_EXISTS'); assert.equal(await readFile(target, 'utf8'), 'unchanged');
  const link = join(f.dir, 'linked-dir'); await symlink(f.dir, link);
  await assert.rejects(f.run({ ownerDirectory: link }), error => error.code === 'CUTOVER_OWNER_DIRECTORY_UNSAFE');
});
test('concurrent capture publication has exactly one winner without clobber', async t => {
  const f = await fixture(t); const results = await Promise.allSettled([f.run(), f.run()]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.code, 'BARRIER_CAPTURE_OUTPUT_EXISTS');
  assert.deepEqual(await readdir(f.dir), ['barrier-proof.json']);
  validateBarrierProof(JSON.parse(await readFile(join(f.dir, 'barrier-proof.json'))));
});
test('strict CLI parsing rejects unknown, duplicate, missing and value-shaped switches', () => {
  for (const argv of [[], ['wrong'], ['capture', '--unknown'], ['capture', '--execute', '--execute'], ['capture', '--origin'],
    ['capture', '--execute', 'false'], ['capture', '--origin', '--remote']]) {
    assert.throws(() => parseBarrierCaptureArguments(argv), error => error.code === 'BARRIER_CAPTURE_ARGUMENT_INVALID');
  }
  assert.deepEqual(parseBarrierCaptureArguments(['capture', '--origin', origin, '--execute', '--remote', '--owner-read-only']),
    { origin, execute: true, remote: true, ownerReadOnly: true });
});
