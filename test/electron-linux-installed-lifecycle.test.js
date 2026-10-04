import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { productionElectronCandidatePlan } from '../scripts/package-electron-production.mjs';
import { LINUX_FINAL_SCHEMA, LINUX_FINAL_PREDECESSOR, validateLinuxFinalIntake, parseLinuxFinalIntake,
  validateLinuxFinalPackageRun, validateLinuxFinalPackageReceipt, validateLinuxFinalPair, linuxFinalArtifactName } from '../scripts/lib/linux-final-artifact-intake.mjs';
import { selectLinuxFinalFuseMount, linuxFinalSandboxStatus, linuxFinalFeedRequestPath, assertLinuxFinalProcessTreeGone, assertLinuxFinalChecksumRejection,
  linuxFinalTemporary, assertLinuxFinalOwnedPolicy } from '../scripts/smoke-electron-linux-final-lifecycle.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const revision = 'a'.repeat(40), runner = 'b'.repeat(40), packageRunner = 'c'.repeat(40);
function fixture() {
  const source = { ...productionElectronCandidatePlan({ target: 'linux-x64', sourceRevision: revision,
    buildNumber: '2026100301', hostPlatform: 'linux', hostArchitecture: 'x64' }),
    status: 'production_source_staged', stagedManifest: 'app/package.json', runtimeManifest: 'app/electron-runtime-manifest.json' };
  const sourceBytes = Buffer.from(JSON.stringify(source) + '\n');
  const intake = { schemaVersion: LINUX_FINAL_SCHEMA, runnerRevision: runner, sourceRevision: revision,
    packageRunId: '12345', packageRunnerRevision: packageRunner, version: '0.1.27', buildNumber: '2026100301',
    sourceCandidate: source, sourceCandidateSha256: hash(sourceBytes), packageReceiptSha256: 'd'.repeat(64),
    artifactSha256: 'e'.repeat(64), artifactBytes: 8192, asarSha256: 'f'.repeat(64), executableSha256: '1'.repeat(64) };
  const artifact = { file: 'TiboTattle-0.1.27-linux-x86_64.AppImage', bytes: 8192,
    sha256: intake.artifactSha256, sha512: Buffer.alloc(64, 1).toString('base64') };
  const receipt = { schemaVersion: 'tibotattle-linux-production-package-v1', workflowRunnerRevision: packageRunner,
    sourceRevision: revision, version: '0.1.27', buildNumber: '2026100301', target: 'linux-x64',
    sourceCandidateSha256: intake.sourceCandidateSha256, appUpdate: {}, artifact, manifest: {},
    signingRequired: false, published: false, nativeRuntimeQualification: 'separate_evidence_required' };
  const pair = { schemaVersion: 'tibotattle-linux-final-artifact-pair-v1', intake,
    predecessorManifestSha256: LINUX_FINAL_PREDECESSOR.manifestSha256,
    images: { current: { file: 'current.AppImage', ...Object.fromEntries(['version', 'sourceRevision', 'bytes', 'sha256'].map(k => [k, LINUX_FINAL_PREDECESSOR[k]])),
      sha512: artifact.sha512, asarSha256: '2'.repeat(64), executableSha256: '3'.repeat(64) },
      next: { ...artifact, file: 'next.AppImage', version: intake.version, sourceRevision: revision,
        asarSha256: intake.asarSha256, executableSha256: intake.executableSha256 } } };
  return { intake, receipt, sourceBytes, pair };
}
test('final-artifact intake binds an unchanged production source candidate and a distinct runner', () => {
  const { intake } = fixture(); assert.equal(validateLinuxFinalIntake(intake), intake);
  assert.deepEqual(parseLinuxFinalIntake(JSON.stringify(intake)), intake);
  assert.equal(linuxFinalArtifactName(intake), `electron-linux-production-package-${revision}-runner-${packageRunner}`);
  for (const alter of [
    v => { v.executable = '/arbitrary'; }, v => { v.sourceCandidate.rehearsal = true; },
    v => { v.sourceCandidate.version = '0.1.26'; }, v => { v.sourceCandidate.builderArguments.push('--publish', 'always'); },
    v => { v.sourceCandidate.builderEnvironment.TIBOTATTLE_ELECTRON_SOURCE_REVISION = runner; },
    v => { v.artifactBytes = 1024 ** 3 + 1; }, v => { v.artifactBytes = '8192'; },
    v => { v.packageRunId = '../../untrusted'; }, v => { v.version = '0.1.28'; },
    v => { v.buildNumber = '2026100302'; }, v => { v.asarSha256 = 'invalid'; },
  ]) { const changed = structuredClone(intake); alter(changed); assert.throws(() => validateLinuxFinalIntake(changed)); }
  assert.throws(() => parseLinuxFinalIntake(' '.repeat(65537)));
});
test('only the exact successful same-repository manual packaging workflow is admitted', () => {
  const { intake } = fixture();
  const run = { id: 12345, event: 'workflow_dispatch', path: '.github/workflows/electron-linux-production-package.yml',
    head_sha: packageRunner, status: 'completed', conclusion: 'success', repository: { full_name: 'adamallcock/tibotattle' } };
  validateLinuxFinalPackageRun(run, intake);
  for (const change of [{ event: 'pull_request' }, { path: '.github/workflows/untrusted.yml' },
    { head_sha: runner }, { conclusion: 'failure' }, { status: 'in_progress' }, { id: 12346 },
    { repository: { full_name: 'another/repo' } }]) assert.throws(() => validateLinuxFinalPackageRun({ ...run, ...change }, intake));
});
test('receipt and final pair cannot relabel prebuilt source or reuse another candidate hash', () => {
  const { intake, receipt, sourceBytes, pair } = fixture();
  validateLinuxFinalPackageReceipt(receipt, intake, sourceBytes); validateLinuxFinalPair(pair, runner);
  for (const change of [{ sourceRevision: runner }, { published: true }, { sourceCandidateSha256: '0'.repeat(64) },
    { target: 'darwin-x64' }, { artifact: { ...receipt.artifact, bytes: 8193 } }, { unknown: true }]) {
    assert.throws(() => validateLinuxFinalPackageReceipt({ ...receipt, ...change }, intake, sourceBytes));
  }
  assert.throws(() => validateLinuxFinalPackageReceipt(receipt, intake, Buffer.from(JSON.stringify(intake.sourceCandidate))));
  for (const alter of [p => { p.images.current.sha256 = intake.artifactSha256; }, p => { p.images.next.asarSha256 = '0'.repeat(64); },
    p => { p.images.next.file = '../next.AppImage'; }, p => { p.predecessorManifestSha256 = '0'.repeat(64); },
    p => { p.images.next.version = '0.1.28'; }, p => { p.images.current.executable = 'arbitrary'; }]) {
    const changed = structuredClone(pair); alter(changed); assert.throws(() => validateLinuxFinalPair(changed, runner));
  }
  assert.throws(() => validateLinuxFinalPair(pair, revision));
});
const nonce = 'a'.repeat(32), temporary = linuxFinalTemporary(nonce);
const mount = `${temporary}/.mount_TiboTa123456`;
function mounted() {
  return { temporary, executable: `${mount}/tibotattle`,
    mountinfo: `91 40 0:82 / ${mount} ro,nosuid,nodev,relatime - fuse.squashfuse squashfuse ro,user_id=1000,group_id=1000\n`,
    environment: { APPIMAGE: '/opt/tibotattle-updater-exec/TiboTattle.AppImage', APPDIR: mount } };
}
test('kernel FUSE mount plus image runtime identity is required; extracted paths are rejected', () => {
  assert.deepEqual(selectLinuxFinalFuseMount(mounted()), { mount, type: 'fuse.squashfuse' });
  for (const alter of [
    m => { m.executable = '/opt/tibotattle-updater-exec/tmp/appimage_extracted_abc/tibotattle'; },
    m => { m.executable = '/tmp/.mount_TiboTa123456/tibotattle'; },
    m => { m.mountinfo = m.mountinfo.replace('fuse.squashfuse', 'tmpfs'); },
    m => { m.mountinfo = m.mountinfo.replace('ro,nosuid', 'rw,nosuid'); },
    m => { m.mountinfo = m.mountinfo.replace('user_id=1000', 'user_id=0'); },
    m => { m.mountinfo += m.mountinfo; }, m => { m.environment.APPIMAGE_EXTRACT_AND_RUN = '1'; },
    m => { m.environment.APPIMAGE = '/tmp/other.AppImage'; }, m => { m.environment.APPDIR = '/tmp/other'; },
    m => { m.executable = `${mount}/../tibotattle`; },
    m => { m.temporary = linuxFinalTemporary('b'.repeat(32)); },
    m => { delete m.temporary; },
  ]) { const value = mounted(); alter(value); assert.throws(() => selectLinuxFinalFuseMount(value)); }
});
test('a native renderer must retain Chromium sandbox kernel controls', () => {
  const value = { commandLine: 'tibotattle\0--type=renderer\0', status: 'NoNewPrivs:\t1\nSeccomp:\t2\n' };
  assert.equal(linuxFinalSandboxStatus(value), true);
  for (const changed of [{ ...value, commandLine: `${value.commandLine}--no-sandbox\0` },
    { ...value, commandLine: `${value.commandLine}--disable-setuid-sandbox\0` },
    { ...value, status: 'NoNewPrivs:\t0\nSeccomp:\t2\n' }, { ...value, status: 'NoNewPrivs:\t1\nSeccomp:\t0\n' },
    { ...value, commandLine: 'tibotattle\0' }]) assert.equal(linuxFinalSandboxStatus(changed), false);
});
test('manual lifecycle lane preserves byte, network, sandbox, FUSE and publication boundaries', async () => {
  const workflow = await readFile(new URL('../.github/workflows/electron-linux-final-qualification.yml', import.meta.url), 'utf8');
  for (const required of ['workflow_dispatch:', 'fetch-depth: 0', 'persist-credentials: false', 'actions: read',
    '--preflight', '--acquire', '--prepare', 'test -c /dev/fuse', '--kill-after=90s 1260s',
    'run-electron-linux-final-lifecycle.mjs --execute', 'run-electron-linux-final-lifecycle.mjs --cleanup',
    'receipts/host-lifecycle.json', 'apparmor-comparison.json', 'if-no-files-found: error']) assert.ok(workflow.includes(required), required);
  assert.ok(workflow.indexOf('Install only locked verification dependencies') < workflow.indexOf('Admit exact source package'));
  assert.ok(workflow.indexOf('Admit exact source package') < workflow.indexOf('Download exact public predecessor'));
  assert.doesNotMatch(workflow, /build-linux-updater-rehearsal|electron-builder|--privileged|--no-sandbox|seccomp=unconfined|apparmor=unconfined|--(?:volume|mount)\b|permissions:\s*write-all|contents: write/u);
  const runtime = await readFile(new URL('../scripts/smoke-electron-linux-final-lifecycle.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(runtime, /APPIMAGE_EXTRACT_AND_RUN:\s*['"]1['"]|ignore-certificate-errors|NODE_TLS_REJECT_UNAUTHORIZED/u);
  const docker = await readFile(new URL('../containers/electron-linux-installed/Dockerfile', import.meta.url), 'utf8');
  assert.match(docker, /libfuse2 fuse openssl libnss3-tools procps/u); assert.match(docker, /USER node/u);
  assert.match(docker, /dbus-run-session/u);
});

test('the exact nonce and enforced profile retain FUSE privileges without granting them to the app', () => {
  const name = `tibotattle-mount-candidate-12345-${nonce}`;
  const input = { nonce, name, profileText: `${name} (enforce)\n`, facts: {
    appArmor: { profile: 'other', enforcement: 'enforce' }, seccomp: 'filter', noNewPrivileges: false,
    sysAdmin: { effective: false, permitted: false, bounding: true },
    fuseDevice: { characterDevice: true, readable: true, writable: true },
    fusermount: { present: true, regular: true, rootOwned: true, setuid: true, executable: true } } };
  assertLinuxFinalOwnedPolicy(input);
  for (const change of [v => { v.nonce = 'b'.repeat(32); }, v => { v.name = 'unconfined'; },
    v => { v.profileText = `${name} (complain)\n`; }, v => { v.profileText = `other (enforce)\n`; },
    v => { v.facts.seccomp = 'disabled'; }, v => { v.facts.noNewPrivileges = true; },
    v => { v.facts.sysAdmin.effective = true; }, v => { v.facts.sysAdmin.permitted = true; },
    v => { v.facts.sysAdmin.bounding = false; }, v => { v.facts.fusermount.setuid = false; },
    v => { v.facts.fusermount.rootOwned = false; }, v => { v.facts.fuseDevice.writable = false; }]) {
    const altered = structuredClone(input); change(altered); assert.throws(() => assertLinuxFinalOwnedPolicy(altered));
  }
  for (const bad of ['', null, '../other', 'a'.repeat(31), 'A'.repeat(32), `${nonce}/child`]) assert.throws(() => linuxFinalTemporary(bad));
});

test('the loopback feed accepts only the pinned updater cache-busting query', () => {
  assert.equal(linuxFinalFeedRequestPath('/electron/stable/linux-x64/latest-linux.yml?noCache=1j2abcd'), 'feed');
  assert.equal(linuxFinalFeedRequestPath('/electron/stable/linux-x64/next.AppImage'), 'image');
  for (const url of ['/electron/stable/linux-x64/latest-linux.yml?arbitrary=1', '/electron/stable/linux-x64/next.AppImage?noCache=a', '/other', '/electron/stable/linux-x64/latest-linux.yml?noCache=a&extra=1']) assert.equal(linuxFinalFeedRequestPath(url), null);
});

test('replacement refuses a surviving reparented predecessor companion by retained process identity', async () => {
  const original = [{ pid: 50, startTime: '100' }, { pid: 51, startTime: '101' }];
  const waiter = async predicate => { if (await predicate() !== true) throw new Error('TREE_STILL_ALIVE'); };
  await assert.rejects(assertLinuxFinalProcessTreeGone(original, {
    waiter, readAlive: async identity => identity.pid === 51,
  }), /TREE_STILL_ALIVE/u);
  await assertLinuxFinalProcessTreeGone(original, { waiter, readAlive: async () => false });
  await assert.rejects(assertLinuxFinalProcessTreeGone([{ pid: 50, startTime: '100' }, { pid: 50, startTime: '101' }], { waiter, readAlive: async () => false }), /PROCESS_IDENTITY_INVALID/u);
});

test('wrong-checksum observation requires a completed transfer, download failure and intact predecessor', () => {
  const value = { update: { status: 'error', error: 'download_failed', canInstall: false },
    installedSha256: 'a'.repeat(64), expectedSha256: 'a'.repeat(64), completedTransfers: 1 };
  assertLinuxFinalChecksumRejection(value);
  for (const change of [{ completedTransfers: 0 }, { installedSha256: 'b'.repeat(64) },
    { update: { ...value.update, canInstall: true } }, { update: { ...value.update, error: 'check_failed' } },
    { update: { ...value.update, status: 'downloaded' } }]) assert.throws(() => assertLinuxFinalChecksumRejection({ ...value, ...change }), /CHECKSUM_REFUSAL_UNPROVEN/u);
});
