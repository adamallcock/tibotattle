import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSignedStagingExecutionArguments, signedStagingChildEnvironment, signedStagingFixture, signedStagingNativeIntroScript, interpretSignedStagingNativeIntroResult, assertSignedStagingFreshProjection, waitForSignedStagingNativeIntro, signedStagingNativeIntroDiagnosticScript, sanitizeSignedStagingNativeIntroDiagnostic, observeSignedStagingProcess, sanitizeSignedStagingProcessDiagnostic } from '../scripts/run-signed-electron-staging.mjs';
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


test('fresh-install continues the real native-consent process through upload, restart and opt-out', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../scripts/run-signed-electron-staging.mjs', import.meta.url), 'utf8');
  const freshStart = source.indexOf('if (untouched) {');
  const automaticUpload = source.indexOf("stage = 'automatic_upload'", freshStart);
  const controlledRestart = source.indexOf("stage = 'credential_restart'", automaticUpload);
  const durableOptOut = source.indexOf('proof.durableOptOut = true', controlledRestart);
  assert.ok(freshStart >= 0);
  assert.ok(automaticUpload > freshStart);
  assert.ok(controlledRestart > automaticUpload);
  assert.ok(durableOptOut > controlledRestart);
  const freshBranch = source.slice(freshStart, automaticUpload);
  assert.match(freshBranch, /proof\.freshDefaultOnObserved = assertSignedStagingFreshProjection/u);
  assert.equal(freshBranch.includes('await stop(active)'), false);
  assert.equal(freshBranch.includes('return proof;'), false);
  assert.match(source.slice(automaticUpload, controlledRestart), /active \?\?= await launch\(verified, environment\)/u);
  assert.equal((source.match(/proof\.controlledRestart = true/gu) ?? []).length, 1);
  assert.ok(controlledRestart < source.indexOf('proof.controlledRestart = true', controlledRestart));
});


test('unverified launch cleanup refuses surviving detached descendants without signaling them', async () => {
  const { stopOwnedMacSharingApp } = await import('../scripts/run-signed-electron-staging.mjs');
  const state = { pid: 1234, groupVerified: false, sessions: [], stopped: () => true,
    child: { kill() { assert.fail('must not signal a stopped or unverified process'); } } };
  await assert.rejects(stopOwnedMacSharingApp(state, { processTableImpl: () => [{ pid: 1235, group: 1234 }] }),
    { stage: 'unverified_group_remaining' });
  assert.equal(await stopOwnedMacSharingApp(state, { processTableImpl: () => [{ pid: 9999, group: 9999 }] }), true);
});


test('native intro waiter preserves terminal refusals instead of swallowing their stage', async () => {
  for (const stage of ['native_intro_closed', 'native_intro_identity', 'native_intro_automation_unavailable']) {
    let calls = 0;
    const error = Object.assign(new Error('private details must not reach proof'), { stage });
    await assert.rejects(waitForSignedStagingNativeIntro(() => { calls++; throw error; },
      { now: () => 0, wait: () => assert.fail('terminal refusal must not retry') }), received => received === error);
    assert.equal(calls, 1);
  }
  for (const [result, stage] of [['unavailable', 'native_intro_automation_unavailable'], ['unexpected', 'native_intro_unexpected']]) {
    await assert.rejects(waitForSignedStagingNativeIntro(() => result,
      { now: () => 0, wait: () => assert.fail('terminal result must not retry') }), { stage });
  }
});

test('native intro waiter keeps the 60 second deadline and 100 ms cadence for waiting only', async () => {
  let time = 0, calls = 0;
  await assert.rejects(waitForSignedStagingNativeIntro(() => { calls++; return 'waiting'; }, {
    now: () => time, wait: async ms => { assert.equal(ms, 100); time += ms; },
  }), { stage: 'native_intro_timeout' });
  assert.equal(time, 60_000); assert.equal(calls, 600);
  time = 0; calls = 0;
  await waitForSignedStagingNativeIntro(() => ++calls === 3 ? 'continued' : 'waiting', {
    now: () => time, wait: async ms => { time += ms; },
  });
  assert.equal(calls, 3); assert.equal(time, 200);
});

test('native intro failure snapshot is read-only, PID-scoped and content-free', async () => {
  const { runInNewContext } = await import('node:vm');
  const { desktopFirstRunDialogCopy } = await import('../apps/electron/desktop-first-run.js');
  const copy = desktopFirstRunDialogCopy({ production: true, locale: 'en-US' });
  let message = copy.message;
  let controls = [
    { role: () => 'AXStaticText', value: () => message },
    ...copy.buttons.map(name => ({ role: () => 'AXButton', name: () => name })),
    { role: () => 'AXCheckBox', name: () => copy.checkboxLabel },
    { role: () => 'AXTextField', value: () => { throw Error('must not read credential fields'); } },
  ];
  let enabled = true, windows = [{ entireContents: () => controls }];
  const script = signedStagingNativeIntroDiagnosticScript(12345);
  const execute = () => JSON.parse(runInNewContext(script + '; run();', { Application(name) {
    assert.equal(name, 'System Events'); return { uiElementsEnabled: () => enabled,
      applicationProcesses: { whose(query) { assert.equal(query.unixId, 12345);
        assert.deepEqual(Object.keys(query), ['unixId']); return () => [{ windows: () => windows }]; } } };
  } }));
  const result = execute();
  assert.deepEqual(result, { status: 'observed', windowCount: 1, staticTextCount: 1, buttonCount: 2,
    checkboxCount: 1, introMessage: true, continueButton: true, quitButton: true, loginCheckbox: true,
    secureStorageRefusal: false, handoverRefusal: false, privacyRefusal: false });
  assert.deepEqual(sanitizeSignedStagingNativeIntroDiagnostic(result), result);
  assert.doesNotMatch(script, /\.click\(|keystroke|keyCode|setValue/u);
  message = 'TiboTattle could not complete its secure startup checks.';
  assert.equal(execute().secureStorageRefusal, true); assert.equal(execute().introMessage, false);
  const { DESKTOP_SECURE_STORAGE_FAILURE_REASONS, createDesktopSecureStorageDialog } =
    await import('../apps/electron/desktop-secure-storage-readiness.js');
  for (const reason of DESKTOP_SECURE_STORAGE_FAILURE_REASONS) {
    message = createDesktopSecureStorageDialog(reason).message;
    assert.equal(execute().secureStorageRefusal, true);
    assert.equal(execute().introMessage, false);
  }
  message = 'PRIVATE_SENTINEL /private/secret';
  assert.equal(JSON.stringify(execute()).includes('PRIVATE_SENTINEL'), false);
  enabled = false;
  assert.equal(execute().status, 'automation_unavailable'); assert.equal(execute().windowCount, null);
  enabled = true; windows = Array(4).fill(windows[0]);
  assert.equal(execute().status, 'overflow'); assert.equal(execute().buttonCount, null);
  windows = [{ entireContents: () => Array(501).fill(controls[0]) }];
  assert.equal(execute().status, 'overflow');
  for (const invalid of [{ ...result, rawText: 'PRIVATE_SENTINEL' }, { ...result, windowCount: 4 },
    { ...result, buttonCount: 1501 }, { ...result, checkboxCount: -1 }, { ...result, introMessage: 'true' },
    { ...result, status: 'automation_unavailable' }, null]) {
    assert.equal(sanitizeSignedStagingNativeIntroDiagnostic(invalid), null);
  }
});


test('direct-child stderr classifier handles split literals without exporting content', async () => {
  const { EventEmitter } = await import('node:events');
  for (const [literal, flag] of [['electron_shell_entry_failed', 'electronEntryFailure'], ['sandbox_apply:', 'sandboxApplyMessage'], ['sandbox_init() failed', 'sandboxInitializationMessage'],
    ['InitializeSandbox() failed', 'sandboxInitializationMessage'], ['SeatbeltExec:', 'seatbeltMessage'],
    ['Operation not permitted', 'operationNotPermitted'], ['Library not loaded:', 'dynamicLibraryMissing']]) {
    for (let split = 1; split < literal.length; split++) {
      const child = new EventEmitter(); child.stderr = new EventEmitter();
      const snapshot = observeSignedStagingProcess(child);
      child.stderr.emit('data', Buffer.from('PRIVATE_SENTINEL' + literal.slice(0, split)));
      child.stderr.emit('data', Buffer.from(literal.slice(split) + '/private/synthetic'));
      child.emit('exit', null, 'SIGABRT'); child.stderr.emit('end');
      const value = snapshot();
      assert.equal(value[flag], true); assert.equal(value.exitSignal, 'SIGABRT');
      assert.equal(value.stderrComplete, true); assert.equal(value.stderrTruncated, false);
      assert.equal(JSON.stringify(value).includes('PRIVATE_SENTINEL'), false);
      assert.equal(JSON.stringify(value).includes('/private/'), false);
    }
  }
});
test('stderr scan cap drains excess and distinguishes incomplete from truncated prefixes', async () => {
  const { EventEmitter } = await import('node:events');
  const child = new EventEmitter(); child.stderr = new EventEmitter();
  const snapshot = observeSignedStagingProcess(child);
  child.stderr.emit('data', Buffer.alloc(65536, 120));
  child.stderr.emit('data', Buffer.from('sandbox_apply: Operation not permitted PRIVATE_SENTINEL'));
  const value = snapshot();
  assert.equal(value.stderrBytesScanned, 65536); assert.equal(value.stderrTruncated, true);
  assert.equal(value.stderrComplete, false); assert.equal(value.sandboxApplyMessage, false);
  assert.equal(value.operationNotPermitted, false);
  for (let i = 0; i < 3; i++) child.stderr.emit('data', Buffer.alloc(65536));
  child.stderr.emit('end'); assert.deepEqual(snapshot(), value);
  const other = new EventEmitter(); other.stderr = new EventEmitter();
  const exact = observeSignedStagingProcess(other);
  other.stderr.emit('data', Buffer.alloc(65536)); other.stderr.emit('end');
  assert.equal(exact().stderrTruncated, false); assert.equal(exact().stderrComplete, true);
});
test('pre-cleanup failure snapshot cannot acquire a cleanup signal or unknown raw strings', async () => {
  const { EventEmitter } = await import('node:events');
  const child = new EventEmitter(); child.stderr = new EventEmitter();
  const snapshot = observeSignedStagingProcess(child), before = snapshot();
  child.emit('exit', null, 'SIGTERM'); child.stderr.emit('data', Buffer.from('sandbox_apply:'));
  assert.deepEqual(snapshot(), before); assert.equal(before.exited, false); assert.equal(before.exitSignal, null);
  for (const [code, signal] of [[0, null], [42, null], [null, 'SIGKILL'], [null, 'PRIVATE_SENTINEL'], [9999999, null]]) {
    const direct = new EventEmitter(); direct.stderr = new EventEmitter();
    const read = observeSignedStagingProcess(direct); direct.emit('exit', code, signal);
    const result = read(); assert.equal(result.exited, true);
    assert.equal(result.exitCode, Number.isInteger(code) && code >= 0 && code <= 255 ? code : null);
    assert.equal(result.unknownExitSignal, signal === 'PRIVATE_SENTINEL');
    assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
  }
  const failed = new EventEmitter(); failed.stderr = new EventEmitter();
  const read = observeSignedStagingProcess(failed); failed.emit('error', new Error('PRIVATE_SENTINEL'));
  assert.equal(read().spawnFailed, true); assert.equal(read().exited, false);
});
test('process diagnostic rejects unknown fields, unbounded values and contradictory states', async () => {
  const { EventEmitter } = await import('node:events');
  const child = new EventEmitter(); child.stderr = new EventEmitter();
  const value = observeSignedStagingProcess(child)();
  assert.deepEqual(sanitizeSignedStagingProcessDiagnostic(value), value);
  for (const extra of [{ raw: 'PRIVATE_SENTINEL' }, { [Symbol('private')]: true }, { exitCode: 256 }, { exitSignal: 'PRIVATE_SENTINEL' },
    { stderrBytesScanned: 65537 }, { stderrBytesScanned: -1 }, { stderrComplete: 'yes' },
    { stderrTruncated: true }, { exited: true, exitSignal: 'SIGABRT', unknownExitSignal: true },
    { exitCode: 0 }, { exited: true, exitCode: 0, exitSignal: 'SIGABRT' }]) {
    assert.equal(sanitizeSignedStagingProcessDiagnostic({ ...value, ...extra }), null);
  }
});

test('real stderr stream drains beyond scan cap and never stitches a literal across discarded bytes', async () => {
  const { EventEmitter, once } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const child = new EventEmitter(); child.stderr = new PassThrough();
  const read = observeSignedStagingProcess(child), ended = once(child.stderr, 'end');
  child.stderr.write(Buffer.alloc(65536 - 8, 120));
  child.stderr.write(Buffer.from('sandbox_')); child.stderr.write(Buffer.from('apply:'));
  child.stderr.end(Buffer.alloc(128 * 1024)); await ended;
  const result = read();
  assert.equal(result.stderrBytesScanned, 65536); assert.equal(result.stderrTruncated, true);
  assert.equal(result.stderrComplete, true); assert.equal(result.sandboxApplyMessage, false);
});
