import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { classifyLinuxStartupFuseMount, createLinuxStartupDiagnostics,
  validateLinuxStartupDiagnostic, validateLinuxStartupMount } from '../scripts/lib/linux-startup-diagnostics.mjs';
import { linuxFinalFailureDetails } from '../scripts/smoke-electron-linux-final-lifecycle.mjs';
import { normalPackagedSmokeFailureStageCode, runOneNormalApp } from '../scripts/smoke-electron-linux-packaged.mjs';

const mountLine = '91 40 0:82 / /opt/tibotattle-updater-exec/tmp/.mount_TiboTa123456 ro,nosuid,nodev,relatime - fuse.squashfuse squashfuse ro,user_id=1000,group_id=1000\n';
const child = () => Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null });
const diagnostic = (process, options = {}) => createLinuxStartupDiagnostics({ child: process, readAlive: () => true, ...options });

test('startup state is frozen before cleanup and distinguishes zero exit, signal, running and unknown', async () => {
  for (const [code, signal, expected] of [[0, null, 'exited'], [1, null, 'exited'], [null, 'SIGABRT', 'exited'], [null, null, 'running']]) {
    const process = child(), collector = diagnostic(process);
    if (expected === 'exited') process.emit('exit', code, signal);
    const proof = await collector.stop();
    assert.equal(proof.process.state, expected);
    assert.equal(proof.process.exitCode, code); assert.equal(proof.process.signal, signal);
    assert.equal(proof.process.aliveBeforeCleanup, expected === 'running');
    process.signalCode = 'SIGTERM'; process.emit('exit', null, 'SIGTERM');
    assert.deepEqual(await collector.stop(), proof);
    assert.notEqual(proof.process.signal, 'SIGTERM', 'cleanup cannot become the recorded startup failure');
  }
  const unavailable = await diagnostic(child(), { readAlive: () => { throw new Error('/private/sentinel'); } }).stop();
  assert.deepEqual(unavailable.process, { state: 'started_unknown', spawnErrno: null, exitCode: null, signal: null, aliveBeforeCleanup: null });
  const absent = child(); absent.pid = undefined;
  assert.equal((await diagnostic(absent).stop()).process.state, 'not_started');
});

test('spawn failures retain only the fixed errno and never error messages or process identifiers', async () => {
  for (const [code, expected] of [['EACCES', 'EACCES'], ['ENOENT', 'ENOENT'], ['private-code', 'UNKNOWN']]) {
    const process = child(); process.pid = undefined;
    const collector = diagnostic(process);
    process.emit('error', Object.assign(new Error('/private/sentinel credential secret-value'), { code, path: '/private/sentinel' }));
    const proof = await collector.stop();
    assert.deepEqual(proof.process, { state: 'spawn_failed', spawnErrno: expected, exitCode: null, signal: null, aliveBeforeCleanup: false });
    assert.doesNotMatch(JSON.stringify(proof), /private|sentinel|secret-value|12345/u);
  }
});

test('bounded stderr indicators survive chunk boundaries without retaining diagnostic text', async () => {
  const collector = diagnostic(child());
  const input = [
    'fuse: failed to open /dev/fuse: Permission denied /private/sentinel',
    'fuse: mount failed: Operation not permitted /private/sentinel',
    'Failed to move to new namespace: Operation not permitted /private/sentinel',
    'The SUID sandbox helper binary was found, but is not configured correctly /private/sentinel',
    '/private/sentinel: error while loading shared libraries: libsecret.so: cannot open shared object file',
    'credential secret-value ordinary private output',
  ].join('\n');
  for (let index = 0; index < input.length; index += 7) collector.feed(Buffer.from(input.slice(index, index + 7)));
  const proof = await collector.stop();
  assert.deepEqual(proof.stderr, { fuseAccess: true, fuseMount: true, namespaceDenial: true,
    sandboxHelper: true, sandboxUnavailable: false, sharedLibrary: true, unknown: true, truncated: false });
  assert.doesNotMatch(JSON.stringify(proof), /private|sentinel|secret-value|Permission|libsecret/u);
});

test('only the pinned sandbox-refusal literal sets the closed capability indicator', async () => {
  const collector = diagnostic(child());
  for (const part of ['No usa', 'ble sand', 'box! /private/sentinel\n']) collector.feed(part);
  const proof = await collector.stop();
  assert.equal(proof.stderr.sandboxUnavailable, true);
  assert.equal(proof.stderr.sandboxHelper, false);
  assert.equal(proof.stderr.namespaceDenial, false);
  assert.doesNotMatch(JSON.stringify(proof), /No usable sandbox|private|sentinel/u);
  for (const text of ['Sandbox initialized /private/sentinel', 'No usable sandbox', 'sandbox unavailable']) {
    const ordinary = diagnostic(child()); ordinary.feed(text);
    assert.equal((await ordinary.stop()).stderr.sandboxUnavailable, false);
  }
});

test('oversized stderr cannot retain text or classify bytes after the capture budget', async () => {
  const collector = diagnostic(child());
  collector.feed('sentinel'.repeat(11000));
  collector.feed('\nThe SUID sandbox helper binary was found\nNo usable sandbox!\n');
  const proof = await collector.stop();
  assert.equal(proof.stderr.truncated, true); assert.equal(proof.stderr.unknown, true);
  assert.equal(proof.stderr.sandboxHelper, false);
  assert.equal(proof.stderr.sandboxUnavailable, false);
  assert.doesNotMatch(JSON.stringify(proof), /sentinel/u);
});

test('mixed-width stderr cannot cross the per-line byte cap and acquire a late classification', async () => {
  const collector = diagnostic(child());
  collector.feed('a'.repeat(2047) + '😀The SUID sandbox helper binary was found No usable sandbox!\n');
  const proof = await collector.stop();
  assert.equal(proof.stderr.truncated, true); assert.equal(proof.stderr.unknown, true);
  assert.equal(proof.stderr.sandboxHelper, false);
  assert.equal(proof.stderr.sandboxUnavailable, false);
});

test('mount diagnostics require the owned private FUSE source and retain fixed options only', () => {
  const proof = classifyLinuxStartupFuseMount(mountLine);
  assert.deepEqual(proof, { state: 'observed', type: 'squashfuse', uid: 1000,
    readOnly: true, nosuid: true, nodev: true, noexec: false });
  assert.equal(classifyLinuxStartupFuseMount(mountLine.replace('ro,nosuid,nodev', 'ro,nosuid,nodev,noexec')).noexec, true);
  for (const text of [mountLine.replace('/tmp/.mount_', '/tmp/other_'), mountLine.replace('user_id=1000', 'user_id=0'),
    mountLine.replace('fuse.squashfuse', 'tmpfs'), mountLine.replace('squashfuse ro,', '/private/sentinel ro,')]) {
    assert.equal(classifyLinuxStartupFuseMount(text).state, 'not_observed');
  }
  assert.equal(classifyLinuxStartupFuseMount(mountLine + mountLine).state, 'ambiguous');
  assert.equal(classifyLinuxStartupFuseMount('x'.repeat(256 * 1024 + 1)).state, 'unavailable');
  assert.equal(validateLinuxStartupMount({ ...proof, path: '/private/sentinel' }), null);
  assert.doesNotMatch(JSON.stringify(proof), /opt|mount_Tibo|123456/u);
});

test('observed mount evidence survives fast unmount and diagnostic I/O failure stays unavailable', async () => {
  let tick, sampled = 0;
  const collector = diagnostic(child(), { sampleMount: async () => classifyLinuxStartupFuseMount(sampled++ === 0 ? mountLine : ''),
    schedule: callback => { tick = callback; return 1; }, cancel: () => {} });
  await new Promise(setImmediate); tick(); await new Promise(setImmediate);
  assert.equal((await collector.stop()).fuseMount.state, 'observed');
  const unavailable = diagnostic(child(), { sampleMount: async () => { throw new Error('/private/sentinel'); },
    schedule: () => { throw new Error('/private/timer'); } });
  assert.equal((await unavailable.stop()).fuseMount.state, 'unavailable');
  const timeout = diagnostic(child(), { sampleMount: () => new Promise(() => {}), schedule: () => 1, cancel: () => {} });
  assert.equal((await timeout.stop()).fuseMount.state, 'unavailable');
});

test('outer failure receipt preserves the closed smoke startup code and rejects open diagnostic fields', async () => {
  const proof = await diagnostic(child()).stop();
  let captured;
  await assert.rejects(runOneNormalApp({ sourceRevision: 'a'.repeat(40) }, {
    appPath: '/synthetic/unlaunched', environment: {}, service: 'available',
    run: async options => { options.onFailureStage('startup'); throw new Error('/private/sentinel'); },
  }), error => { captured = error; return true; });
  const code = `ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_${normalPackagedSmokeFailureStageCode('startup')}`;
  assert.equal(captured.code, code);
  assert.deepEqual(linuxFinalFailureDetails(captured.code, proof), { errorCode: code, startupDiagnostic: proof });
  assert.deepEqual(linuxFinalFailureDetails(normalPackagedSmokeFailureStageCode('startup'), null),
    { errorCode: 'LINUX_FINAL_LIFECYCLE_RUNTIME_FAILED' });
  for (const invalid of [{ ...proof, path: '/private/sentinel' },
    { ...proof, process: { ...proof.process, pid: 12345 } },
    { ...proof, process: { ...proof.process, signal: '/private/sentinel' } },
    { ...proof, stderr: { ...proof.stderr, unknown: '/private/sentinel' } },
    { ...proof, fuseMount: { ...proof.fuseMount, mount: '/private/sentinel' } }]) {
    assert.equal(validateLinuxStartupDiagnostic(invalid), null);
    assert.deepEqual(linuxFinalFailureDetails('/private/sentinel', invalid), { errorCode: 'LINUX_FINAL_LIFECYCLE_RUNTIME_FAILED' });
  }
  assert.deepEqual(linuxFinalFailureDetails(null, null), { errorCode: 'LINUX_FINAL_LIFECYCLE_RUNTIME_FAILED' });
});

test('startup capture precedes cleanup and success remains outside the diagnostic receipt path', async () => {
  const smoke = await readFile(new URL('../scripts/smoke-electron-linux.mjs', import.meta.url), 'utf8');
  const capture = smoke.indexOf('onStartupDiagnostic(await startupDiagnostics.stop())');
  const cleanup = smoke.indexOf('if (!childHasExited(child)) await terminateLinuxSmokeChild(child)', capture);
  assert.ok(capture > 0 && cleanup > capture);
  assert.match(smoke, /if \(failureStage === "startup" && onStartupDiagnostic !== null\)/u);
  assert.match(smoke, /onStartupDiagnostic = null/u);
  const final = await readFile(new URL('../scripts/smoke-electron-linux-final-lifecycle.mjs', import.meta.url), 'utf8');
  assert.match(final, /run: options => runSmoke\(\{ \.\.\.options, sampleStartupMount: sampleLinuxStartupFuseMount/u);
  const launch = final.slice(final.indexOf('child = spawn(IMAGE'), final.indexOf("child.on('error'"));
  assert.doesNotMatch(launch, /--no-sandbox|--disable-setuid-sandbox/u);
  assert.match(final, /!args\.includes\('--no-sandbox'\)/u);
  assert.doesNotMatch(final, /APPIMAGE_EXTRACT_AND_RUN:\s*['"]1['"]/u);
});
