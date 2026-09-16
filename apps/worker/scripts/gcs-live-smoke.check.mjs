import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./gcs-live-smoke.mjs', import.meta.url));
const args = (file, bucket = 'tibotattle-gcs-test-synthetic', receipt = join(tmpdir(), `gcs-smoke-check-${process.pid}.json`)) => [
  '--bucket', bucket, '--access-token-file', file,
  '--expires-at', String(Math.floor(Date.now() / 1000) + 600),
  '--receipt-file', receipt,
];
function run(argv) {
  const result = spawnSync(process.execPath, [script, ...argv], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 16_384,
  });
  assert.equal(result.error, undefined);
  return result;
}
function refused(argv, code) {
  const result = run(argv);
  assert.equal(result.status, 1);
  const receipt = JSON.parse(result.stderr.trim());
  assert.equal(receipt.code, code);
  assert.deepEqual(receipt.attemptedKeys, []);
  assert.deepEqual(receipt.createdKeys, []);
}

test('help does not require credentials or cloud access', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /explicitly opt-in/u);
});
test('non-test buckets are refused before credentials are read', () => {
  refused(args('/does-not-exist', 'production-bucket'), 'INVALID_BUCKET');
});
test('duplicate resource arguments are refused', () => {
  refused([...args('/does-not-exist'), '--bucket', 'tibotattle-gcs-test-second'], 'DUPLICATE_ARGUMENT');
});
test('closed run IDs are validated before credentials or cloud access', () => {
  refused([...args('/does-not-exist'), '--run-id', 'Run_With_Open_Path'], 'INVALID_RUN_ID');
});
test('an existing receipt is never overwritten by a refused run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gcs-smoke-receipt-sentinel-'));
  try {
    const token = join(dir, 'synthetic-token');
    const receipt = join(dir, 'receipt.json');
    writeFileSync(token, 'synthetic-test-token', { mode: 0o600 });
    writeFileSync(receipt, '{"sentinel":true}\n', { mode: 0o600 });
    chmodSync(token, 0o600);
    chmodSync(receipt, 0o600);
    const before = readFileSync(receipt);
    const result = run(args(token, 'tibotattle-gcs-test-synthetic', receipt));
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr.trim()).code, 'RECEIPT_ALREADY_EXISTS');
    assert.deepEqual(readFileSync(receipt), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
for (const kind of ['permissions', 'symlink', 'hardlink']) {
  test(`credential ${kind} violations are refused before cloud access`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'gcs-smoke-refusal-'));
    try {
      const token = join(dir, 'synthetic-token');
      writeFileSync(token, 'synthetic-test-token', { mode: 0o600 });
      let selected = token;
      if (kind === 'permissions') chmodSync(token, 0o640);
      if (kind === 'symlink') { selected = join(dir, 'link'); symlinkSync(token, selected); }
      if (kind === 'hardlink') linkSync(token, join(dir, 'second-link'));
      refused(args(selected), kind === 'symlink' ? 'TOKEN_FILE_UNAVAILABLE' : 'TOKEN_FILE_PERMISSIONS');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
