import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { LINUX_MOUNT_DIAGNOSIS_SCHEMA, LINUX_MOUNT_DIAGNOSIS_CONFIRMATION, LINUX_MOUNT_KMSG_READER,
  normalizeLinuxMountPolicy, createLinuxMountErrorClassifier, selectLinuxMountProbeMount,
  validateLinuxMountDiagnosis, runLinuxMountSequence, linuxMountPreflightEnvironment,
  linuxMountContainerArguments, linuxMountCleanupArguments, linuxMountOwnedProcessGone, correlateLinuxMountAudit } from '../scripts/diagnose-electron-linux-appimage-mount.mjs';

const temporary = '/opt/tibotattle-updater-exec/tmp/' + 'a'.repeat(32);
const image = '/opt/tibotattle-updater-exec/TiboTattle.AppImage';
const target = `${temporary}/.mount_TiboTa123456`;
const mountinfo = `91 40 0:82 / ${target} ro,nosuid,nodev,relatime - fuse.squashfuse squashfuse ro,user_id=1000,group_id=1000\n`;
const status = 'NoNewPrivs:\t0\nSeccomp:\t2\nCapEff:\t0000000000000000\nCapPrm:\t0000000000000000\nCapBnd:\t0000000000200000\n';
const policy = () => normalizeLinuxMountPolicy({ status, appArmor: 'docker-default (enforce)\n' });
function probe() {
  return { environment: { ...policy(), fuseDevice: { characterDevice: true, readable: true, writable: true },
    fusermount: { present: true, regular: true, rootOwned: true, setuid: true, executable: true } },
  startup: { schemaVersion: 'tibotattle-linux-startup-diagnostic-v1',
    process: { state: 'exited', spawnErrno: null, exitCode: 127, signal: null, aliveBeforeCleanup: false },
    stderr: { fuseAccess: false, fuseMount: true, namespaceDenial: false, sandboxHelper: false,
      sandboxUnavailable: false, sharedLibrary: false, unknown: false, truncated: false },
    fuseMount: { state: 'not_sampled', type: null, uid: null, readOnly: null, nosuid: null, nodev: null, noexec: null } },
  mount: 'not_observed', launcherErrors: createLinuxMountErrorClassifier().finish(), cleanup: { childGone: true, mountGone: true } };
}
const pair = { intake: { runnerRevision: 'b'.repeat(40), sourceRevision: 'c'.repeat(40) },
  images: { current: { sha256: 'd'.repeat(64), bytes: 8192 }, next: { sha256: 'e'.repeat(64), bytes: 8193 } } };
function row(role, changes = {}) { return { role, artifactSha256: pair.images[role].sha256, artifactBytes: pair.images[role].bytes,
  probe: probe(), errorCode: 'none', appArmorMountDenial: 'unavailable', containerRemoved: true, observerStopped: true, ...changes }; }
function auditFixture() {
  return { profile: 'docker-default', temporary, start: 100, end: 200,
    observations: new Map([[77, { start: '123', ambiguous: false, first: 120, last: 180 }]]),
    audit: { ready: true, closed: true, complete: true, start: 90, end: 210, records: [
      { time: 150, message: `audit: type=1400 audit(1790000000.123:44): apparmor="DENIED" operation="mount" profile="docker-default" name="${target}/" pid=77 comm="fusermount" srcname="${image}" fstype="fuse" flags="rw, nosuid, nodev"` },
    ] } };
}

// The owning native lane already requires Python for exact artifact intake.
// Compile the exact embedded observer without running any of its host reads.
test('the exact embedded read-only observer compiles without executing it', () => {
  const result = spawnSync('python3', ['-c', "import sys; compile(sys.stdin.buffer.read(), '<mount-observer>', 'exec')"], {
    input: LINUX_MOUNT_KMSG_READER, stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000, maxBuffer: 4096,
  });
  assert.equal(result.status, 0); assert.equal(result.signal, null); assert.equal(result.error, undefined);
});

test('mount diagnosis requires its own explicit confirmation without altering lifecycle admission', () => {
  const input = { SELECTED_MODE: 'execute', SELECTED_CONFIRMATION: LINUX_MOUNT_DIAGNOSIS_CONFIRMATION, LINUX_FINAL_INTAKE: 'unchanged' };
  assert.equal(linuxMountPreflightEnvironment(input).SELECTED_CONFIRMATION, 'RUN_DISPOSABLE_FINAL_LINUX_LIFECYCLE');
  assert.equal(input.SELECTED_CONFIRMATION, LINUX_MOUNT_DIAGNOSIS_CONFIRMATION);
  assert.equal(linuxMountPreflightEnvironment({ SELECTED_MODE: 'plan', SELECTED_CONFIRMATION: '' }).SELECTED_CONFIRMATION, '');
  for (const changed of [{ ...input, SELECTED_CONFIRMATION: 'RUN_DISPOSABLE_FINAL_LINUX_LIFECYCLE' },
    { ...input, SELECTED_MODE: 'arbitrary' }, { SELECTED_MODE: 'plan', SELECTED_CONFIRMATION: LINUX_MOUNT_DIAGNOSIS_CONFIRMATION }]) assert.throws(() => linuxMountPreflightEnvironment(changed));
});

test('actual capability bits and policy availability remain independent of requested Docker flags', () => {
  assert.deepEqual(policy(), { appArmor: { profile: 'docker_default', enforcement: 'enforce' }, seccomp: 'filter', noNewPrivileges: false,
    sysAdmin: { effective: false, permitted: false, bounding: true } });
  const unavailable = normalizeLinuxMountPolicy({ status: null, appArmor: null });
  assert.deepEqual(unavailable.sysAdmin, { effective: 'unavailable', permitted: 'unavailable', bounding: 'unavailable' });
  assert.equal(unavailable.noNewPrivileges, 'unavailable'); assert.equal(unavailable.seccomp, 'unavailable');
  const privateProfile = normalizeLinuxMountPolicy({ status: status.replace('Seccomp:\t2', 'Seccomp:\tconstructor'), appArmor: 'private-profile-marker (complain)\n' });
  assert.deepEqual(privateProfile.appArmor, { profile: 'other', enforcement: 'complain' });
  assert.equal(privateProfile.seccomp, 'unavailable'); assert.doesNotMatch(JSON.stringify(privateProfile), /private-profile-marker/u);
  assert.equal(normalizeLinuxMountPolicy({ status: `${status}CapEff:\t00200000\n`, appArmor: 'docker-default' }).sysAdmin.effective, 'unavailable');
  assert.equal(normalizeLinuxMountPolicy({ status, appArmor: 'docker-default' }).appArmor.enforcement, 'unavailable');
});

test('C-locale error classes span chunks but never retain private stderr or classify discarded text', () => {
  const classifier = createLinuxMountErrorClassifier(); classifier.feed('fusermount: mount failed: Operation not '); classifier.feed('permitted\nprivate-command-marker\n');
  const result = classifier.finish(); assert.equal(result.operationNotPermitted, true); assert.equal(result.unknown, true);
  assert.doesNotMatch(JSON.stringify(result), /private-command-marker|fusermount|Operation not/u);
  for (const text of ['x'.repeat(2047) + '😀Operation not permitted\n', 'x'.repeat(65536) + '\nPermission denied\n']) {
    const bounded = createLinuxMountErrorClassifier(); bounded.feed(text); const result = bounded.finish();
    assert.equal(result.operationNotPermitted, false); assert.equal(result.permissionDenied, false); assert.equal(result.truncated, true);
  }
});

test('only one exact owned nonce-directory FUSE mount can be selected for cleanup', () => {
  assert.deepEqual(selectLinuxMountProbeMount(mountinfo, temporary), { state: 'observed', mount: target });
  assert.equal(selectLinuxMountProbeMount(mountinfo.replace(temporary, temporary.replace(/a/gu, 'b')), temporary).state, 'not_observed');
  for (const altered of [mountinfo + mountinfo, mountinfo.replace('fuse.squashfuse', 'tmpfs'), mountinfo.replace('user_id=1000', 'user_id=0'),
    mountinfo.replace('.mount_TiboTa123456', '.mount_TiboTa/../outside'), mountinfo.replace('squashfuse ro,', '/private/source ro,')]) {
    const result = selectLinuxMountProbeMount(altered, temporary); assert.equal(result.state, 'ambiguous'); assert.equal(result.mount, null);
  }
  assert.deepEqual(selectLinuxMountProbeMount('x'.repeat(262145), temporary), { state: 'unavailable', mount: null });
  assert.equal(selectLinuxMountProbeMount(mountinfo, '/tmp/unowned').state, 'unavailable');
});

test('an AppArmor positive requires an owned PID identity, bounded window, active profile and exact nonce/source', () => {
  assert.equal(correlateLinuxMountAudit(auditFixture()), true);
  for (const [fstype, source] of [['fuse.squashfuse', 'squashfuse'], ['fuse.TiboTattle.AppImage', 'TiboTattle.AppImage']]) {
    const input = auditFixture();
    input.audit.records[0].message = input.audit.records[0].message.replace('fstype="fuse"', `fstype="${fstype}"`).replace(`srcname="${image}"`, `srcname="${source}"`);
    assert.equal(correlateLinuxMountAudit(input), true);
  }
  for (const mutate of [
    v => { v.audit.ready = false; }, v => { v.audit.closed = false; }, v => { v.audit.complete = false; },
    v => { v.audit.records = []; }, v => { v.audit.start = 101; }, v => { v.audit.end = 199; },
    v => { v.audit.records[0].time = 99; }, v => { v.audit.records[0].time = 201; },
    v => { v.observations.clear(); }, v => { v.observations.get(77).first = 151; }, v => { v.observations.get(77).last = 149; },
    v => { v.observations.get(77).ambiguous = true; }, v => { delete v.observations.get(77).start; },
    v => { v.profile = null; }, v => { v.profile = 'another-profile'; },
    ...['pid=77 pid=77', 'pid="77"broken', 'pid=78'].map(text => v => { v.audit.records[0].message = v.audit.records[0].message.replace('pid=77', text); }),
    v => { v.audit.records[0].message = v.audit.records[0].message.replace('operation="mount"', 'operation="open"'); },
    v => { v.audit.records[0].message = v.audit.records[0].message.replace('fstype="fuse"', 'fstype="tmpfs"'); },
    v => { v.audit.records[0].message = v.audit.records[0].message.replace('srcname="' + image, 'srcname="/unrelated.AppImage'); },
    v => { v.audit.records[0].message = v.audit.records[0].message.replace(temporary, temporary.replace(/a/gu, 'b')); },
    v => { v.audit.records[0].message = v.audit.records[0].message.replace('.mount_TiboTa123456', '.mount_TiboTa\\040123456'); },
  ]) { const input = auditFixture(); mutate(input); assert.equal(correlateLinuxMountAudit(input), 'unavailable'); }
});

test('serial exact-byte comparison stops before the second image when owned container cleanup is unproven', async () => {
  const order = [];
  const result = await runLinuxMountSequence(pair, async (role, expected) => { order.push(role); assert.equal(expected, pair.images[role]); return row(role); });
  assert.deepEqual(order, ['current', 'next']); assert.equal(result.qualifiesRelease, false); assert.equal(result.schemaVersion, LINUX_MOUNT_DIAGNOSIS_SCHEMA);
  const stopped = [];
  const partial = await runLinuxMountSequence(pair, async role => { stopped.push(role); return row(role, { containerRemoved: false, errorCode: 'cleanup_failed' }); });
  assert.deepEqual(stopped, ['current']); assert.equal(partial.cases.length, 1);
  const observer = await runLinuxMountSequence(pair, async role => row(role, { observerStopped: false, errorCode: 'cleanup_failed' }));
  assert.equal(observer.cases.length, 1);
  await assert.rejects(runLinuxMountSequence(pair, async role => row(role, { artifactSha256: 'f'.repeat(64) })), /REFUSED/u);
  for (const mutate of [
    v => { v.qualifiesRelease = true; }, v => { v.schemaVersion = 'tibotattle-linux-final-lifecycle-v1'; },
    v => { v.cases[0].probe.environment.appArmor.profile = 'private-profile-marker'; },
    v => { v.cases[0].probe.environment.pid = 77; }, v => { v.cases[0].probe.mount = target; },
    v => { v.cases[0].probe.launcherErrors.raw = 'private-stderr-marker'; }, v => { v.cases[0].probe.startup.process.pid = 77; },
    v => { v.cases[0].appArmorMountDenial = 'possibly'; }, v => { v.cases[0].containerRemoved = false; }, v => { v.cases[0].observerStopped = false; },
  ]) { const changed = structuredClone(result); mutate(changed); assert.equal(validateLinuxMountDiagnosis(changed), null); }
  assert.doesNotMatch(JSON.stringify(result), /private-profile-marker|private-stderr-marker|\.mount_|\/opt\/|"pid"|"start"|comm|nonce/u);
});

test('post-removal ownership proof distinguishes missing or replaced identity from unreadable proc evidence', async () => {
  const identity = { pid: 77, start: '123' };
  const stat = start => `77 (probe) ${['S', '1', ...Array(17).fill('0'), start].join(' ')}`;
  assert.equal(await linuxMountOwnedProcessGone(identity, { read: async () => stat('123') }), false);
  assert.equal(await linuxMountOwnedProcessGone(identity, { read: async () => stat('124') }), true);
  assert.equal(await linuxMountOwnedProcessGone(identity, { read: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } }), true);
  for (const code of ['EACCES', 'EPERM', 'EIO']) assert.equal(await linuxMountOwnedProcessGone(identity, {
    read: async () => { throw Object.assign(new Error('private-proc-detail'), { code }); },
  }), 'unavailable');
  assert.equal(await linuxMountOwnedProcessGone(identity, { read: async () => 'malformed private-proc-detail' }), 'unavailable');
  let read = false;
  assert.equal(await linuxMountOwnedProcessGone(null, { read: async () => { read = true; return ''; } }), 'unavailable');
  assert.equal(read, false);
});

test('interruption cleanup requires the recorded created ID and all exact ownership labels', () => {
  const owner = { role: 'current', run: '12345', runner: 'b'.repeat(40) }, markerId = 'f'.repeat(64);
  const inspected = { id: markerId, name: '/tibotattle-mount-diagnosis-current-12345', labels: {
    'io.tibotattle.mount-diagnosis.run': owner.run, 'io.tibotattle.mount-diagnosis.runner': owner.runner,
    'io.tibotattle.mount-diagnosis.role': owner.role } };
  assert.deepEqual(linuxMountCleanupArguments({ markerId, inspected }, owner), ['rm', '--force', markerId]);
  for (const mutate of [v => { v.id = 'e'.repeat(64); }, v => { v.name = '/pre-existing'; }, v => { v.labels = {}; },
    v => { v.labels['io.tibotattle.mount-diagnosis.run'] = '12346'; }, v => { v.labels['io.tibotattle.mount-diagnosis.runner'] = 'c'.repeat(40); },
    v => { v.labels['io.tibotattle.mount-diagnosis.role'] = 'next'; }]) {
    const changed = structuredClone(inspected); mutate(changed);
    assert.throws(() => linuxMountCleanupArguments({ markerId, inspected: changed }, owner), /REFUSED/u);
  }
  assert.throws(() => linuxMountCleanupArguments({ markerId: null, inspected }, owner), /REFUSED/u);
});

test('diagnostic Docker security arguments match the existing lifecycle and keep its container source closure', async () => {
  const normal = await readFile(new URL('../.github/workflows/electron-linux-final-qualification.yml', import.meta.url), 'utf8');
  const words = normal.slice(normal.indexOf('timeout 900s docker run'), normal.indexOf('> .release-build')).replace(/\\\n/gu, '').split(/\s+/u);
  const diagnostic = linuxMountContainerArguments({ name: 'tibotattle-mount-diagnosis-current-12345', role: 'current', nonce: 'a'.repeat(32), runnerRevision: 'b'.repeat(40) });
  const select = args => args.flatMap((word, index) => /^(?:--init|--platform=|--cap-add=|--shm-size=)/u.test(word) ? [word]
    : ['--device', '--network', '--add-host', '--tmpfs'].includes(word) ? [`${word} ${args[index + 1]}`]
      : word === '--env' && !args[index + 1].startsWith('TIBOTATTLE_MOUNT_PROBE_') ? [`--env ${args[index + 1]}`] : []).sort();
  assert.deepEqual(select(diagnostic), select(words));
  assert.doesNotMatch(diagnostic.join(' '), /--privileged|--security-opt|--user\b|--entrypoint|--volume|--mount\b|--no-sandbox|unconfined/u);
  assert.deepEqual(diagnostic.slice(-3), ['node', 'scripts/diagnose-electron-linux-appimage-mount.mjs', '--inside']);
  const dockerfile = await readFile(new URL('../containers/electron-linux-installed/Dockerfile', import.meta.url), 'utf8');
  const ignore = await readFile(new URL('../containers/electron-linux-installed/Dockerfile.dockerignore', import.meta.url), 'utf8');
  assert.match(dockerfile, /^COPY scripts \.\/scripts$/mu); assert.match(ignore, /^!scripts\/\*\*$/mu);
  assert.match(dockerfile, /^USER node$/mu); assert.match(dockerfile, /CMD \["node", "scripts\/smoke-electron-linux-final-lifecycle\.mjs"\]/u);
  const source = await readFile(new URL('../scripts/diagnose-electron-linux-appimage-mount.mjs', import.meta.url), 'utf8');
  assert.match(source, /spawn\(IMAGE, \['--appimage-mount'\]/u);
  assert.match(source, /LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C'/u);
  assert.doesNotMatch(source, /--appimage-extract|--no-sandbox|--disable-setuid-sandbox|apparmor=unconfined|seccomp=unconfined/u);
  assert.match(source, /'--cidfile'/u);
  assert.match(source, /const stopped = await waitUntil\(\(\) => exited, 35000\)/u);
  assert.match(source, /copyFile\(source, IMAGE, constants\.COPYFILE_EXCL\)/u);
  assert.match(source, /installed\.sha256 !== expected\.sha256 \|\| installed\.bytes !== expected\.bytes/u);
  assert.match(LINUX_MOUNT_KMSG_READER, /os\.O_RDONLY \| os\.O_NONBLOCK/u);
  assert.match(LINUX_MOUNT_KMSG_READER, /os\.lseek\(fd, 0, os\.SEEK_END\)/u);
  assert.match(LINUX_MOUNT_KMSG_READER, /sequence != last \+ 1: complete = False/u);
  assert.match(LINUX_MOUNT_KMSG_READER, /used > 262144/u);
  assert.match(LINUX_MOUNT_KMSG_READER, /priority >> 3 == 0/u);
  const workflow = await readFile(new URL('../.github/workflows/electron-linux-appimage-mount-diagnosis.yml', import.meta.url), 'utf8');
  for (const required of ['workflow_dispatch:', 'group: electron-linux-final-qualification', 'persist-credentials: false', 'actions: read',
    LINUX_MOUNT_DIAGNOSIS_CONFIRMATION, 'timeout 180s', 'mount-diagnosis.json', '--test-concurrency=1', 'test/tool-inventory.test.js', 'test/release-workflow-policy.test.js', '--cleanup']) assert.ok(workflow.includes(required), required);
  assert.doesNotMatch(workflow, /contents: write|permissions:\s*write-all|--privileged|--no-sandbox|unconfined|mount-diagnosis-\*|receipts\/\*\.json/u);
});
