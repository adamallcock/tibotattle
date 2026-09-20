import assert from 'node:assert/strict';
import test from 'node:test';
import * as zlib from 'node:zlib';
import { createSourceFileAccess } from '../src/platform/source-file-access.js';
import { readBoundedUtf8Lines } from '../src/platform/bounded-jsonl-reader.js';
import { compressedRolloutHandle } from '../src/platform/bounded-rollout-bytes.js';

function fixture(bytes) {
  const reads = [], live = new Set();
  let closed = 0;
  const native = {
    openSourceFile() { const lease = {}; live.add(lease); return lease; },
    statSourceFile(lease) {
      assert.ok(live.has(lease));
      return { dev: '0000000000000001', ino: '00000000000000000000000000000002',
        size: bytes.length, nlink: 1, uid: process.getuid?.(),
        mtimeMs: 1000, ctimeMs: 1000, birthtimeMs: 1000 };
    },
    readSourceFile(lease, position, length) {
      assert.ok(live.has(lease));
      assert.ok(length <= 65536);
      reads.push(length);
      return bytes.subarray(position, position + length);
    },
    closeSourceFile(lease) { assert.ok(live.delete(lease)); closed += 1; },
  };
  const access = createSourceFileAccess({ platform: 'win32', loadWindowsBinding: () => native });
  return { access, reads, live, get closed() { return closed; } };
}

test('source handle serves large Uint8Array reads and EOF through bounded native calls', async () => {
  const bytes = Buffer.alloc(300_000, 42), f = fixture(bytes);
  const handle = await f.access.open('synthetic.jsonl');
  try {
    const target = new Uint8Array(400_010);
    const result = await handle.read(target, 5, 400_000, 0);
    assert.equal(result.buffer, target);
    assert.equal(result.bytesRead, bytes.length);
    assert.deepEqual(Buffer.from(target.subarray(5, 300_005)), bytes);
    assert.equal(target[4], 0);
    assert.equal(target[300_005], 0);
    assert.equal(f.reads.length, 5);
    assert.equal((await f.access.namedStat('synthetic.jsonl', handle)).ino,
      '00000000000000000000000000000002');
    await assert.rejects(handle.read(target, 0, 1, Number.MAX_SAFE_INTEGER), /invalid_source_read/);
  } finally { await handle.close(); }
  await handle.close();
  assert.equal(f.closed, 1);
  await assert.rejects(handle.stat(), /source_file_closed/);
});

test('shared JSONL reader accepts source handles without an fd and leaves ownership to its caller', async () => {
  const long = 'x'.repeat(300_000);
  const f = fixture(Buffer.from(`first\n${long}\nlast\n`));
  const handle = await f.access.open('synthetic.jsonl');
  try {
    assert.equal(handle.fd, undefined);
    const lines = [];
    for await (const line of readBoundedUtf8Lines(handle)) lines.push(line);
    assert.deepEqual(lines, ['first', long, 'last']);
    assert.equal(f.live.size, 1);
    const controller = new AbortController();
    for await (const line of readBoundedUtf8Lines(handle, { signal: controller.signal })) {
      assert.equal(line, 'first');
      controller.abort();
      break;
    }
    assert.equal(f.live.size, 1);
    await assert.rejects(async () => {
      for await (const _ of readBoundedUtf8Lines(handle, { signal: controller.signal })) { /* no rows */ }
    }, { name: 'AbortError' });
    assert.equal(f.live.size, 1);
  } finally { await handle.close(); }
  assert.equal(f.closed, 1);
});

test('shared compressed reader consumes generic source handles and verifies the held source', {
  skip: typeof zlib.zstdCompressSync !== 'function' ? 'Runtime lacks Zstd' : false,
}, async () => {
  const f = fixture(zlib.zstdCompressSync(Buffer.from('first\nsecond\n')));
  const handle = await f.access.open('synthetic.jsonl.zst');
  try {
    const lines = [];
    for await (const line of readBoundedUtf8Lines(compressedRolloutHandle(handle))) lines.push(line);
    assert.deepEqual(lines, ['first', 'second']);
    assert.equal(f.live.size, 1);
  } finally { await handle.close(); }
});
