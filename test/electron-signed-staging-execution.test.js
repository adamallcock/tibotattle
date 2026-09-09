import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSignedStagingExecutionArguments, signedStagingChildEnvironment, signedStagingFixture } from '../scripts/run-signed-electron-staging.mjs';
const identity = ['--app', '/tmp/reviewed/TiboTattle.app', '--source-revision', 'a'.repeat(40), '--asar-sha256', 'b'.repeat(64)];
test('execution requires an explicit staging mutation mode and exact artifact inputs', () => {
  assert.throws(() => parseSignedStagingExecutionArguments(identity));
  assert.equal(parseSignedStagingExecutionArguments(['--execute-staging', ...identity]).sourceRevision, 'a'.repeat(40));
  for (const extra of [['--origin', 'https://other.test'], ['--home', '/tmp/other'], ['--skip-signature'], ['--execute-staging']]) {
    assert.throws(() => parseSignedStagingExecutionArguments(['--execute-staging', ...identity, ...extra]));
  }
});
test('child control plane is minimal and cannot inherit alternate credentials or destinations', () => {
  const parent = { GITHUB_ACTIONS: 'true', RUNNER_ARCH: 'ARM64', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS',
    NODE_OPTIONS: '--require=bad', USAGE_MONITOR_ACCOUNTLESS_ORIGIN: 'https://bad.test', ELECTRON_RUN_AS_NODE: '1', SECRET: 'not-forwarded' };
  const result = signedStagingChildEnvironment(parent, '/Users/runner', '/Users/runner/private');
  assert.deepEqual(Object.keys(result).sort(), ['GITHUB_ACTIONS', 'HOME', 'LANG', 'PATH', 'RUNNER_ARCH', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'TMPDIR']);
  assert.equal(result.HOME, '/Users/runner');
  assert.throws(() => signedStagingChildEnvironment({ ...parent, RUNNER_ARCH: 'X64' }, '/Users/runner', '/tmp/private'));
});
test('synthetic rehearsal uses only content-free source records with increasing usage and quota', () => {
  const records = signedStagingFixture(Date.parse('2026-09-09T12:00:00Z')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 4);
  const events = records.filter((row) => row.type === 'event_msg');
  assert.deepEqual(events.map((row) => row.payload.info.total_token_usage.total_tokens), [124, 248]);
  assert.deepEqual(events.map((row) => row.payload.rate_limits.primary.used_percent), [20, 21]);
  assert.equal(JSON.stringify(records).includes('prompt'), false);
  assert.equal(JSON.stringify(records).includes('response'), false);
});
