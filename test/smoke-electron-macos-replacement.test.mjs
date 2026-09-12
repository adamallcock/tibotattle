import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSignedReplacementArguments, seedSignedReplacementNativeState,
  readSignedReplacementState, assertSignedReplacementContinuity } from '../scripts/smoke-electron-macos-replacement.mjs';
import { validateCanaryHost } from '../scripts/run-signed-electron-production-canary.mjs';
import { openLocalUnifiedIndex } from '../src/local-unified-index.js';

const args = ['--app', '/tmp/TiboTattle.app', '--archive', '/tmp/reviewed.zip', '--archive-sha256', 'a'.repeat(64),
  '--source-revision', 'b'.repeat(40), '--asar-sha256', 'c'.repeat(64)];
const settings = { language: 'es', appearance: 'dark', refreshIntervalSeconds: 900, startAtLogin: false };
const sharing = { enabled: false, transportStatus: 'off', noticeDue: false, basis: 'legacy_preserved' };

test('execution requires exact explicit mode, confirmation, absolute paths and digests', () => {
  assert.equal(parseSignedReplacementArguments(['--plan', ...args]).execute, false);
  assert.equal(parseSignedReplacementArguments(['--execute', ...args, '--confirm', 'RUN_DISPOSABLE_SIGNED_REPLACEMENT']).execute, true);
  for (const invalid of [[], ['--execute', ...args], ['--plan', ...args, '--confirm', 'RUN_DISPOSABLE_SIGNED_REPLACEMENT'],
    ['--plan', ...args, '--app', '/tmp/other.app'], ['--plan', ...args, '--unknown', 'x'],
    ['--plan', ...args.slice(0, -1), 'no-digest'], ['--plan', '--app', 'TiboTattle.app', ...args.slice(2)]]) {
    assert.throws(() => parseSignedReplacementArguments(invalid));
  }
});

test('operator and self-hosted accounts are never eligible', () => {
  const host = { platform: 'darwin', architecture: 'arm64', nodeVersion: 'v26.2.0', environment: {
    GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64', RUNNER_TEMP: '/tmp/runner' },
  account: { uid: 501, username: 'runner', homedir: '/Users/runner' } };
  assert.equal(validateCanaryHost(host), '/Users/runner');
  assert.throws(() => validateCanaryHost({ ...host, account: { uid: 501, username: 'adam', homedir: '/Users/adam' } }));
  assert.throws(() => validateCanaryHost({ ...host, environment: { ...host.environment, RUNNER_ENVIRONMENT: 'self-hosted' } }));
});

test('signed replacement diagnostics recognize the closed secure-storage support-code family', async () => {
  const source = await readFile(new URL('../scripts/smoke-electron-macos-replacement.mjs', import.meta.url), 'utf8');
  assert.match(source, /content\.includes\('Support code: SECURE_STORAGE_'\)/u);
  assert.doesNotMatch(source, /content\.includes\('secure startup checks'\)/u);
});

test('real native SQLite fixture has retained usage/quota rows and continuity catches loss, mutation, salt or optout changes', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signed-replacement-unit-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = join(root, 'native');
  const before = await seedSignedReplacementNativeState(native, join(root, 'codex'));
  assert.equal(before.usageRows, 2);
  assert.equal(before.quotaRows, 2);
  assert.equal(before.tokensInUncached, 203);
  assert.equal(assertSignedReplacementContinuity(before, await readSignedReplacementState(native), settings, sharing), true);
  const database = openLocalUnifiedIndex(join(native, 'local-unified-index-v1.sqlite'), { readOnly: false });
  database.prepare('UPDATE usage_event SET tokens_in_uncached = tokens_in_uncached + 1').run();
  database.close();
  assert.throws(() => assertSignedReplacementContinuity(before, undefined, settings, sharing));
  assert.throws(() => assertSignedReplacementContinuity(before, { ...before, usageRows: 1 }, settings, sharing));
  assert.throws(() => assertSignedReplacementContinuity(before, { ...before, recordDigest: 'changed' }, settings, sharing));
  const altered = await readSignedReplacementState(native);
  assert.equal(altered.tokensInUncached, 205);
  assert.throws(() => assertSignedReplacementContinuity(before, altered, settings, sharing));
  for (const bad of [{ ...sharing, enabled: true }, { ...sharing, transportStatus: 'enrolling' },
    { ...sharing, noticeDue: true }, { ...sharing, basis: 'default_on' }]) {
    assert.throws(() => assertSignedReplacementContinuity(before, before, settings, bad));
  }
  assert.throws(() => assertSignedReplacementContinuity(before, before, { ...settings, appearance: 'system' }, sharing));
  await writeFile(join(native, 'local-unified-index-device-salt-v1'), Buffer.alloc(32, 42));
  assert.notEqual((await readSignedReplacementState(native)).saltDigest, before.saltDigest);
  const optout = JSON.parse(await readFile(join(native, 'private', 'automatic-contribution-v0.1.json'), 'utf8'));
  assert.equal(optout.enabled, false);
});
