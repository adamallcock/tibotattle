import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSignedStagingExecutionArguments, signedStagingChildEnvironment, signedStagingFixture, signedStagingNativeIntroScript, interpretSignedStagingNativeIntroResult, assertSignedStagingFreshProjection } from '../scripts/run-signed-electron-staging.mjs';
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

test('signed intake binds reviewed runner separately and ignores ambient downloader configuration', async () => {
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(new URL('../.github/workflows/electron-signed-staging.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes("runner==os.environ['GITHUB_SHA']"));
  assert.ok(workflow.includes("['/usr/bin/curl','--disable','--fail'"));
  assert.ok(workflow.includes("assert result.stdout=='200'"));
  assert.ok(workflow.includes('assert h.hexdigest()==digest'));
  assert.ok(workflow.includes("'runnerRevision':runner,'sourceRevision':revision"));
  assert.ok(workflow.includes('--source-revision "$SELECTED_SOURCE" --asar-sha256 "$SELECTED_ASAR"'));
  assert.equal(workflow.includes("'--location'"), false);
});


test('fresh-install is a separate explicit execution mode with the same immutable artifact contract', () => {
  assert.equal(parseSignedStagingExecutionArguments(['--execute-fresh-install', ...identity]).executionMode, 'fresh_install');
  assert.equal(parseSignedStagingExecutionArguments(['--execute-staging', ...identity]).executionMode, 'seeded_upload');
  assert.throws(() => parseSignedStagingExecutionArguments(['--execute-fresh-install', ...identity, '--skip-intro']));
});

test('native introduction targets one owned PID and only accepts the matching real controls', async () => {
  const { runInNewContext } = await import('node:vm');
  const { desktopFirstRunDialogCopy } = await import('../apps/electron/desktop-first-run.js');
  const copy = desktopFirstRunDialogCopy({ production: true, locale: 'en-US' });
  const clicks = [];
  let checked = 1;
  let message = copy.message;
  const elements = [
    { role: () => 'AXStaticText', value: () => message },
    ...copy.buttons.map((name) => ({ role: () => 'AXButton', name: () => name, click: () => clicks.push(name) })),
    { role: () => 'AXCheckBox', name: () => copy.checkboxLabel, value: () => checked,
      click: () => { clicks.push('clear_login'); checked = 0; } },
  ];
  const app = { uiElementsEnabled: () => true, applicationProcesses: { whose(query) {
    assert.equal(query.unixId, 12345);
    assert.deepEqual(Object.keys(query), ['unixId']);
    return () => [{ windows: () => [{ entireContents: () => elements }] }];
  } } };
  const execute = () => runInNewContext(signedStagingNativeIntroScript(12345) + '; run();', { Application(name) {
    assert.equal(name, 'System Events'); return app;
  } });
  assert.equal(execute(), 'continued');
  assert.deepEqual(clicks, ['clear_login', copy.buttons[0]]);
  clicks.length = 0; message = 'A different application dialog';
  assert.equal(execute(), 'waiting');
  assert.deepEqual(clicks, []);
  app.uiElementsEnabled = () => false;
  assert.equal(execute(), 'unavailable');
  assert.deepEqual(clicks, []);
  for (const pid of [0, -1, 1.5, '12345', '1; bad()']) assert.throws(() => signedStagingNativeIntroScript(pid));
});

test('fresh proof cannot substitute a saved user choice or a forged native result', () => {
  const receipt = { schemaVersion: 'tibotattle-desktop-first-run-v1', acknowledged: true };
  assert.equal(assertSignedStagingFreshProjection({ enabled: true, basis: 'default_on' }, receipt), true);
  assert.throws(() => assertSignedStagingFreshProjection({ enabled: true, basis: 'user_choice' }, receipt));
  assert.throws(() => assertSignedStagingFreshProjection({ enabled: false, basis: 'default_on' }, receipt));
  assert.throws(() => assertSignedStagingFreshProjection({ enabled: true, basis: 'default_on' }, null));
  assert.equal(interpretSignedStagingNativeIntroResult('continued'), true);
  assert.equal(interpretSignedStagingNativeIntroResult('waiting'), false);
  assert.throws(() => interpretSignedStagingNativeIntroResult('unavailable'), { stage: 'native_intro_automation_unavailable' });
  assert.throws(() => interpretSignedStagingNativeIntroResult('ok'), { stage: 'native_intro_unexpected' });
});


test('fresh-only receipt does not claim the seeded restart or upload journey', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../scripts/run-signed-electron-staging.mjs', import.meta.url), 'utf8');
  assert.match(source, /durableOptOut: false, controlledRestart: false/u);
  assert.equal((source.match(/proof\.controlledRestart = true/gu) ?? []).length, 1);
  assert.ok(source.indexOf("stage = 'credential_restart'") < source.indexOf('proof.controlledRestart = true'));
  assert.ok(source.indexOf('return proof;', source.indexOf('if (untouched) {')) < source.indexOf('proof.controlledRestart = true'));
});


test('unverified launch cleanup refuses surviving detached descendants without signaling them', async () => {
  const { stopOwnedMacSharingApp } = await import('../scripts/run-signed-electron-staging.mjs');
  const state = { pid: 1234, groupVerified: false, sessions: [], stopped: () => true,
    child: { kill() { assert.fail('must not signal a stopped or unverified process'); } } };
  await assert.rejects(stopOwnedMacSharingApp(state, { processTableImpl: () => [{ pid: 1235, group: 1234 }] }),
    { stage: 'unverified_group_remaining' });
  assert.equal(await stopOwnedMacSharingApp(state, { processTableImpl: () => [{ pid: 9999, group: 9999 }] }), true);
});
