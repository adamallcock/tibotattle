import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { productionElectronCandidatePlan } from '../scripts/package-electron-production.mjs';
import { LINUX_FINAL_SCHEMA, LINUX_FINAL_PREDECESSOR, validateLinuxFinalIntake, parseLinuxFinalIntake,
  validateLinuxFinalPackageRun, validateLinuxFinalPackageReceipt, validateLinuxFinalPair, linuxFinalArtifactName } from '../scripts/lib/linux-final-artifact-intake.mjs';
import { selectLinuxFinalFuseMount, linuxFinalSandboxStatus, linuxFinalFeedRequestPath, assertLinuxFinalProcessTreeGone, assertLinuxFinalChecksumRejection,
  linuxFinalTemporary, assertLinuxFinalOwnedPolicy, linuxFinalFailureDetails, runLinuxFinalNormalJourney,
  readLinuxFinalAppProcessIdentity, linuxFinalBrowserCommandLineMatches, readLinuxFinalKnownAppProcessIdentity,
  currentLinuxFinalApp, stopLinuxFinalOwnedApp, assertLinuxFinalRendererSandbox, linuxFinalProcessCommandLineFacts } from '../scripts/smoke-electron-linux-final-lifecycle.mjs';
import { runOneNormalApp } from '../scripts/smoke-electron-linux-packaged.mjs';
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
const installedImage = '/opt/tibotattle-updater-exec/TiboTattle.AppImage';
function mounted() {
  return { temporary, executable: `${mount}/tibotattle`,
    mountinfo: `91 40 0:82 / ${mount} ro,nosuid,nodev,relatime - fuse.squashfuse squashfuse ro,user_id=1000,group_id=1000\n`,
    environment: { APPIMAGE: '/opt/tibotattle-updater-exec/TiboTattle.AppImage', APPDIR: mount } };
}
const fuseRefusals = [
  ['FUSE_TEMPORARY_INVALID', m => { delete m.temporary; }],
  ['FUSE_TEMPORARY_INVALID', m => { m.temporary = '/unowned'; }],
  ['FUSE_IMAGE_PATH_INVALID', m => { m.image = '/unowned.AppImage'; }],
  ['FUSE_EXECUTABLE_PATH_INVALID', m => { m.executable = `${mount}/../tibotattle`; }],
  ['FUSE_EXECUTABLE_PATH_INVALID', m => { m.executable = `${mount}/other`; }],
  ['FUSE_MOUNT_LOCATION_INVALID', m => { m.executable = '/opt/tibotattle-updater-exec/tmp/appimage_extracted_abc/tibotattle'; }],
  ['FUSE_MOUNT_LOCATION_INVALID', m => { m.executable = '/tmp/.mount_TiboTa123456/tibotattle'; }],
  ['FUSE_MOUNT_LOCATION_INVALID', m => { m.temporary = linuxFinalTemporary('b'.repeat(32)); }],
  ['FUSE_MOUNT_MISSING', m => { m.mountinfo = ''; }],
  ['FUSE_MOUNT_AMBIGUOUS', m => { m.mountinfo += m.mountinfo; }],
  ['FUSE_MOUNT_TYPE_INVALID', m => { m.mountinfo = m.mountinfo.replace('fuse.squashfuse', 'tmpfs'); }],
  ['FUSE_MOUNT_SOURCE_INVALID', m => { m.mountinfo = m.mountinfo.replace('fuse.squashfuse squashfuse', 'fuse.squashfuse other'); }],
  ['FUSE_MOUNT_SOURCE_INVALID', m => { m.mountinfo = m.mountinfo.replace('fuse.squashfuse squashfuse', 'fuse.squashfuse TiboTattle.AppImage'); }],
  ['FUSE_MOUNT_SOURCE_INVALID', m => { m.mountinfo = m.mountinfo.replace('fuse.squashfuse squashfuse', 'fuse.TiboTattle.AppImage other'); }],
  ['FUSE_MOUNT_SOURCE_INVALID', m => { m.mountinfo = m.mountinfo.replace('fuse.squashfuse squashfuse', 'fuse.TiboTattle.AppImage squashfuse'); }],
  ['FUSE_MOUNT_SOURCE_INVALID', m => { m.mountinfo = m.mountinfo.replace('fuse.squashfuse squashfuse', 'fuse squashfuse'); }],
  ['FUSE_MOUNT_ROOT_INVALID', m => { m.mountinfo = m.mountinfo.replace('0:82 / ', '0:82 /subdir '); }],
  ['FUSE_MOUNT_READ_ONLY_REQUIRED', m => { m.mountinfo = m.mountinfo.replace('ro,nosuid', 'rw,nosuid'); }],
  ['FUSE_MOUNT_UID_INVALID', m => { m.mountinfo = m.mountinfo.replace('user_id=1000', 'user_id=0'); }],
  ['FUSE_APPIMAGE_ENV_MISMATCH', m => { m.environment.APPIMAGE = '/tmp/other.AppImage'; }],
  ['FUSE_APPIMAGE_ENV_MISMATCH', m => { m.environment.APPIMAGE = ''; }],
  ['FUSE_APPIMAGE_ENV_MISMATCH', m => { m.environment.APPIMAGE = null; }],
  ['FUSE_APPIMAGE_ENV_MISSING', m => { delete m.environment.APPIMAGE; }],
  ['FUSE_APPDIR_ENV_MISMATCH', m => { m.environment.APPDIR = '/tmp/other'; }],
  ['FUSE_APPDIR_ENV_MISMATCH', m => { m.environment.APPDIR = ''; }],
  ['FUSE_APPDIR_ENV_MISMATCH', m => { m.environment.APPDIR = null; }],
  ['FUSE_APPDIR_ENV_MISSING', m => { delete m.environment.APPDIR; }],
  ['FUSE_EXTRACTION_MODE_FORBIDDEN', m => { m.environment.APPIMAGE_EXTRACT_AND_RUN = '1'; }],
  ['FUSE_EXTRACTION_MODE_FORBIDDEN', m => { m.environment.APPIMAGE_EXTRACT_AND_RUN = ''; }],
];
test('kernel FUSE mount plus image runtime identity is required; extracted paths are rejected', () => {
  for (const [type, source] of [['fuse.squashfuse', 'squashfuse'], ['fuse.TiboTattle.AppImage', 'TiboTattle.AppImage'],
    ['fuse.TiboTattle.AppImage', '/opt/tibotattle-updater-exec/TiboTattle.AppImage'],
    ['fuse', 'TiboTattle.AppImage'], ['fuse', '/opt/tibotattle-updater-exec/TiboTattle.AppImage']]) {
    const value = mounted(); value.mountinfo = value.mountinfo.replace('fuse.squashfuse squashfuse', `${type} ${source}`);
    assert.deepEqual(selectLinuxFinalFuseMount(value), { mount, type });
  }
  for (const [code, alter] of fuseRefusals) {
    const value = mounted(); alter(value);
    assert.throws(() => selectLinuxFinalFuseMount(value), { code: `LINUX_FINAL_LIFECYCLE_${code}` });
  }
});
function appProcess(role = 'browser') {
  const value = mounted(), pid = 50, reads = [], hashes = [];
  value.mountinfo = value.mountinfo.replace('fuse.squashfuse squashfuse', 'fuse.TiboTattle.AppImage TiboTattle.AppImage');
  const expected = { executableSha256: 'a'.repeat(64), asarSha256: 'b'.repeat(64), sha256: 'd'.repeat(64) };
  const fields = Array(20).fill('0'); fields[0] = 'S'; fields[19] = '100';
  const environment = role === 'node'
    ? { TMPDIR: temporary, ELECTRON_RUN_AS_NODE: '1', USAGE_MONITOR_PARENT_PID: '49' }
    : value.environment;
  const files = {
    stat: `${pid} (tibotattle) ${fields.join(' ')}`,
    cmdline: `${value.executable}\0${role === 'node' ? `${mount}/resources/app.asar/apps/local/server.js\0`
      : role === 'chromium' ? '--type=renderer\0' : '--remote-debugging-port=12345\0'}`,
    status: 'Uid:\t1000\t1000\t1000\t1000\n',
    environ: Object.entries(environment).map(([key, item]) => `${key}=${item}\0`).join(''),
    mountinfo: value.mountinfo,
  };
  const io = {
    expectedArguments: ['--remote-debugging-port=12345'],
    read: async path => {
      assert.ok(path.startsWith(`/proc/${pid}/`)); const name = path.slice(`/proc/${pid}/`.length);
      reads.push(name); assert.ok(Object.hasOwn(files, name)); return files[name];
    },
    link: async path => { assert.equal(path, `/proc/${pid}/exe`); reads.push('exe'); return value.executable; },
    hash: async path => {
      hashes.push(path);
      assert.ok([value.executable, `${mount}/resources/app.asar`, installedImage].includes(path));
      return path === value.executable ? expected.executableSha256 : path === installedImage ? expected.sha256 : expected.asarSha256;
    },
  };
  return { value, pid, expected, environment, files, io, reads, hashes };
}

test('ordinary Node companion sharing the mounted executable is not mistaken for the AppImage browser', async () => {
  const node = appProcess('node');
  assert.equal(node.files.cmdline.split('\0').some(arg => arg.startsWith('--type=')), false);
  // The previous candidate path reached this strict FUSE check and aborted.
  assert.throws(() => selectLinuxFinalFuseMount({ ...node.value, environment: node.environment }), /FUSE_APPIMAGE_ENV_MISSING/u);
  assert.equal(await readLinuxFinalAppProcessIdentity(node.pid, node.expected, temporary, node.io), null);
  assert.ok(node.reads.includes('environ')); assert.ok(!node.reads.includes('mountinfo'));
  assert.deepEqual(node.hashes, []);
  const browser = appProcess();
  assert.deepEqual(await readLinuxFinalAppProcessIdentity(browser.pid, browser.expected, temporary, browser.io), {
    pid: browser.pid, startTime: '100', mount, executable: browser.value.executable,
  });
  assert.deepEqual(browser.hashes, [browser.value.executable, `${mount}/resources/app.asar`, installedImage]);
  assert.equal(browser.reads.filter(name => name === 'stat').length, 2);
  const chromium = appProcess('chromium');
  assert.equal(await readLinuxFinalAppProcessIdentity(chromium.pid, chromium.expected, temporary, chromium.io), null);
  assert.deepEqual(chromium.reads, ['stat', 'cmdline']); assert.deepEqual(chromium.hashes, []);
});

test('Node-mode markers can exclude a candidate but cannot qualify a browser or bypass an unsupported role', async () => {
  const node = appProcess(); node.files.environ += 'ELECTRON_RUN_AS_NODE=1\0';
  assert.equal(await readLinuxFinalAppProcessIdentity(node.pid, node.expected, temporary, node.io), null);
  assert.deepEqual(node.hashes, []);
  for (const mode of ['', '0', 'true', '2']) {
    const value = appProcess(); value.files.environ += `ELECTRON_RUN_AS_NODE=${mode}\0`;
    await assert.rejects(readLinuxFinalAppProcessIdentity(value.pid, value.expected, temporary, value.io), { code: 'LINUX_FINAL_LIFECYCLE_PROCESS_NODE_MODE_INVALID' });
    assert.deepEqual(value.hashes, []);
  }
});

test('real browser candidates still refuse wrong FUSE identity, extraction mode and credentials', async () => {
  for (const [code, alter] of [
    ['FUSE_APPIMAGE_ENV_MISMATCH', v => { v.files.environ = `APPIMAGE=\0APPDIR=${mount}\0`; }],
    ['FUSE_APPIMAGE_ENV_MISMATCH', v => { v.files.environ = `APPIMAGE=/tmp/other.AppImage\0APPDIR=${mount}\0`; }],
    ['FUSE_APPDIR_ENV_MISMATCH', v => { v.files.environ = 'APPIMAGE=/opt/tibotattle-updater-exec/TiboTattle.AppImage\0APPDIR=\0'; }],
    ['FUSE_APPDIR_ENV_MISMATCH', v => { v.files.environ = 'APPIMAGE=/opt/tibotattle-updater-exec/TiboTattle.AppImage\0APPDIR=/tmp/other\0'; }],
    ['FUSE_EXTRACTION_MODE_FORBIDDEN', v => { v.files.environ += 'APPIMAGE_EXTRACT_AND_RUN=1\0'; }],
    ['FUSE_MOUNT_TYPE_INVALID', v => { v.files.mountinfo = v.files.mountinfo.replace('fuse.TiboTattle.AppImage', 'tmpfs'); }],
    ['FUSE_MOUNT_UID_INVALID', v => { v.files.mountinfo = v.files.mountinfo.replace('user_id=1000', 'user_id=0'); }],
  ]) {
    const value = appProcess(); alter(value);
    await assert.rejects(readLinuxFinalAppProcessIdentity(value.pid, value.expected, temporary, value.io), { code: `LINUX_FINAL_LIFECYCLE_${code}` });
    assert.deepEqual(value.hashes, []);
  }
  const uid = appProcess(); uid.files.status = 'Uid:\t0\t0\t0\t0\n';
  await assert.rejects(readLinuxFinalAppProcessIdentity(uid.pid, uid.expected, temporary, uid.io), /PROCESS_UID_INVALID/u);
});

test('browser identity keeps all three pinned digests, stable process identity and loud file failures', async () => {
  for (const key of ['executableSha256', 'asarSha256']) {
    const value = appProcess(), expected = { ...value.expected, [key]: 'c'.repeat(64) };
    assert.equal(await readLinuxFinalAppProcessIdentity(value.pid, expected, temporary, value.io), null);
  }
  const installed = appProcess();
  await assert.rejects(readLinuxFinalAppProcessIdentity(installed.pid, { ...installed.expected, sha256: 'c'.repeat(64) }, temporary, installed.io), /INSTALLED_BYTES_INVALID/u);
  const changed = appProcess(); let statReads = 0;
  await assert.rejects(readLinuxFinalAppProcessIdentity(changed.pid, changed.expected, temporary, {
    ...changed.io, read: async path => {
      const value = await changed.io.read(path);
      return path.endsWith('/stat') && ++statReads > 1 ? value.replace(/100$/u, '101') : value;
    },
  }), /PROCESS_BYTES_CHANGED/u);
  const unsafe = appProcess(), failure = Object.assign(new Error('fixed'), { code: 'LINUX_FINAL_LIFECYCLE_FILE_UNSAFE' });
  await assert.rejects(readLinuxFinalAppProcessIdentity(unsafe.pid, unsafe.expected, temporary, {
    ...unsafe.io, hash: async () => { throw failure; },
  }), error => error === failure);
  const malformed = appProcess(); malformed.files.stat = malformed.files.stat.replace(/100$/u, 'invalid');
  await assert.rejects(readLinuxFinalAppProcessIdentity(malformed.pid, malformed.expected, temporary, malformed.io), /PROCESS_START_TIME_INVALID/u);
});

test('a native renderer must retain Chromium sandbox kernel controls', () => {
  const value = { executable: 'tibotattle', commandLine: 'tibotattle\0--type=renderer\0', status: 'NoNewPrivs:\t1\nSeccomp:\t2\n' };
  assert.equal(linuxFinalSandboxStatus(value), true);
  for (const changed of [{ ...value, commandLine: `${value.commandLine}--no-sandbox\0` },
    { ...value, commandLine: `${value.commandLine}--disable-setuid-sandbox\0` },
    { ...value, status: 'NoNewPrivs:\t0\nSeccomp:\t2\n' }, { ...value, status: 'NoNewPrivs:\t1\nSeccomp:\t0\n' },
    { ...value, commandLine: 'tibotattle\0' }]) assert.equal(linuxFinalSandboxStatus(changed), false);
});

test('Chromium child roles are excluded in NUL argv and the exact executable-prefixed title form', async () => {
  for (const separator of ['\0', ' ']) {
    for (const role of ['renderer', 'zygote', 'gpu-process', 'utility']) {
      const value = appProcess(); value.files.environ = '';
      value.files.cmdline = [value.value.executable, `--type=${role}`, '--lang=en-US'].join(separator) + '\0';
      assert.equal(await readLinuxFinalAppProcessIdentity(value.pid, value.expected, temporary, value.io), null);
      assert.ok(!value.reads.includes('mountinfo')); assert.deepEqual(value.hashes, []);
    }
    // Even an empty, unknown or repeated role can never fall through to browser
    // admission. Preserve the base NUL exclusion and refuse malformed titles.
    for (const [roles, reason] of [[['--type='], 'PROCESS_ROLE_EMPTY'], [['--type=unknown'], 'PROCESS_ROLE_UNKNOWN'],
      [['--type=renderer', '--type=utility'], 'PROCESS_ROLE_MULTIPLE']]) {
      const value = appProcess();
      value.files.cmdline = [value.value.executable, ...roles].join(separator) + '\0';
      if (separator === '\0') {
        assert.equal(await readLinuxFinalAppProcessIdentity(value.pid, value.expected, temporary, value.io), null);
      } else {
        await assert.rejects(readLinuxFinalAppProcessIdentity(value.pid, value.expected, temporary, value.io), { code: `LINUX_FINAL_LIFECYCLE_${reason}` });
      }
      assert.deepEqual(value.hashes, []);
    }
  }
});

function commandLineRefusals(executable) {
  return [
    ['PROCESS_COMMAND_LINE_TOO_LONG', `${executable}\0${'x'.repeat(65536)}\0`],
    ['PROCESS_COMMAND_LINE_TERMINATOR_MISSING', `${executable}\0--flag`],
    ['PROCESS_ARGV_ZERO_MISMATCH', `${executable}-other\0--flag\0`],
    ['PROCESS_ARGV_EMPTY_FIELD', `${executable}\0\0`],
    ['PROCESS_ARGV_WHITESPACE', `${executable}\0--flag=two words\0`],
    ['PROCESS_TITLE_PREFIX_MISMATCH', `${executable}-other --flag\0`],
    ['PROCESS_TITLE_SPACING_INVALID', `${executable} \0`],
    ['PROCESS_TITLE_SPACING_INVALID', `${executable}  --flag\0`],
    ['PROCESS_TITLE_SPACING_INVALID', `${executable} --flag \0`],
    ['PROCESS_TITLE_SPACING_INVALID', `${executable} --flag\tvalue\0`],
    ['PROCESS_ROLE_MULTIPLE', `${executable} --type=renderer --type=utility\0`],
    ['PROCESS_ROLE_EMPTY', `${executable} --type=\0`],
    ['PROCESS_ROLE_UNKNOWN', `${executable} --type=synthetic-unknown\0`],
    ['PROCESS_ROLE_BARE', `${executable} --type\0`],
  ];
}

test('one command parser preserves facts or null while observing only the first fixed refusal', () => {
  const executable = `${mount}/tibotattle`, refusals = commandLineRefusals(executable)
    .map(([reason, commandLine]) => [reason, { commandLine, executable }]);
  for (const commandLine of [null, undefined, 1]) refusals.push(['PROCESS_COMMAND_LINE_TYPE_INVALID', { commandLine, executable }]);
  for (const invalidExecutable of [null, undefined, '', `${mount}/two words`, `${executable}\0`]) {
    refusals.push(['PROCESS_EXECUTABLE_FORM_INVALID', { commandLine: `${executable}\0`, executable: invalidExecutable }]);
  }
  // Multiple simultaneous failures keep the original first-predicate order.
  refusals.push(['PROCESS_COMMAND_LINE_TYPE_INVALID', { commandLine: null, executable: null }],
    ['PROCESS_COMMAND_LINE_TOO_LONG', { commandLine: 'x'.repeat(65537), executable: null }],
    ['PROCESS_COMMAND_LINE_TERMINATOR_MISSING', { commandLine: '', executable: null }],
    ['PROCESS_ARGV_ZERO_MISMATCH', { commandLine: `other\0\0`, executable }],
    ['PROCESS_ARGV_WHITESPACE', { commandLine: `${executable}\0two words\0\0`, executable }],
    ['PROCESS_ROLE_MULTIPLE', { commandLine: `${executable} --type= --type=unknown --type\0`, executable }],
    ['PROCESS_ROLE_UNKNOWN', { commandLine: `${executable} --type=unknown --type\0`, executable }]);
  for (const [reason, value] of refusals) {
    const observed = [];
    assert.equal(linuxFinalProcessCommandLineFacts(value), null);
    assert.equal(linuxFinalProcessCommandLineFacts(value, code => observed.push(code)), null);
    assert.deepEqual(observed, [reason]);
    assert.equal(linuxFinalSandboxStatus({ ...value, status: 'NoNewPrivs:\t1\nSeccomp:\t2\n' }), false);
  }
  for (const separator of ['\0', ' ']) {
    for (const role of [null, 'renderer', 'zygote', 'gpu-process', 'utility']) {
      for (const flag of [null, '--no-sandbox', '--disable-setuid-sandbox=1']) {
        const args = [...(role ? [`--type=${role}`] : []), ...(flag ? [flag] : [])];
        const value = { executable, commandLine: [executable, ...args].join(separator) + '\0' }, observed = [];
        const facts = { role, sandboxBypass: flag !== null };
        assert.deepEqual(linuxFinalProcessCommandLineFacts(value), facts);
        assert.deepEqual(linuxFinalProcessCommandLineFacts(value, code => observed.push(code)), facts);
        assert.deepEqual(observed, []);
      }
    }
  }
});

test('identity parser refusals retain exact closed causes through real smoke cleanup without extra process reads', async () => {
  for (const [reason, commandLine] of commandLineRefusals(`${mount}/tibotattle`)) {
    const value = appProcess(); value.files.cmdline = commandLine;
    await assertIdentityCause(() => readLinuxFinalAppProcessIdentity(value.pid, value.expected, temporary, value.io), reason);
    assert.deepEqual(value.reads, ['stat', 'cmdline', 'exe', 'status', 'environ']);
    assert.deepEqual(value.hashes, []);
  }
  const malformedExecutable = appProcess();
  malformedExecutable.value.executable = `${temporary}/.mount_two words/tibotattle`;
  await assertIdentityCause(() => readLinuxFinalAppProcessIdentity(malformedExecutable.pid, malformedExecutable.expected, temporary,
    malformedExecutable.io), 'PROCESS_EXECUTABLE_FORM_INVALID');
  assert.deepEqual(malformedExecutable.hashes, []);
  for (const mode of ['', '0', 'false', 'invalid']) {
    const value = appProcess(); value.files.environ += `ELECTRON_RUN_AS_NODE=${mode}\0`;
    await assertIdentityCause(() => readLinuxFinalAppProcessIdentity(value.pid, value.expected, temporary, value.io), 'PROCESS_NODE_MODE_INVALID');
    assert.deepEqual(value.reads, ['stat', 'cmdline', 'exe', 'status', 'environ']);
    assert.deepEqual(value.hashes, []);
  }
});

test('only exact pinned broker title forms get the unsupported diagnostic and none becomes an admitted browser', async () => {
  const exact = ['broker', 'renderer-broker', 'zygote-broker', 'gpu-process-broker', 'utility-broker'];
  const near = ['brokers', 'Renderer-broker', 'gpu-process-brokers', 'renderer-broker-extra', 'utility-broker=1', 'broker-broker', 'synthetic-broker'];
  for (const role of [...exact, ...near]) {
    const reason = exact.includes(role) ? 'PROCESS_ROLE_SANDBOX_BROKER_UNSUPPORTED' : 'PROCESS_ROLE_UNKNOWN';
    for (const separator of ['\0', ' ']) {
      const value = appProcess(), observed = [];
      value.files.cmdline = [value.value.executable, `--type=${role}`].join(separator) + '\0';
      const parsed = { commandLine: value.files.cmdline, executable: value.value.executable };
      assert.equal(linuxFinalProcessCommandLineFacts(parsed), null);
      assert.equal(linuxFinalProcessCommandLineFacts(parsed, code => observed.push(code)), null);
      assert.deepEqual(observed, [reason]);
      assert.equal(linuxFinalSandboxStatus({ ...parsed, status: 'NoNewPrivs:\t1\nSeccomp:\t2\n' }), false);
      if (separator === '\0') {
        // Preserve the existing early NUL child exclusion, even for unknown roles.
        assert.equal(await readLinuxFinalAppProcessIdentity(value.pid, value.expected, temporary, value.io), null);
        assert.deepEqual(value.reads, ['stat', 'cmdline']);
      } else {
        await assertIdentityCause(() => readLinuxFinalAppProcessIdentity(value.pid, value.expected, temporary, value.io), reason);
        assert.deepEqual(value.reads, ['stat', 'cmdline', 'exe', 'status', 'environ']);
      }
      assert.deepEqual(value.hashes, []);
    }
  }
});

test('both exact browser command forms bind absent environment to image-named FUSE and all three byte identities', async () => {
  for (const separator of ['\0', ' ']) {
    for (const absent of [[], ['APPIMAGE'], ['APPDIR'], ['APPIMAGE', 'APPDIR']]) {
      const value = appProcess();
      value.files.cmdline = [value.value.executable, ...value.io.expectedArguments].join(separator) + '\0';
      const environment = { ...value.environment };
      for (const key of absent) delete environment[key];
      value.files.environ = Object.entries(environment).map(([name, item]) => `${name}=${item}\0`).join('');
      assert.equal((await readLinuxFinalAppProcessIdentity(value.pid, value.expected, temporary, value.io)).pid, value.pid);
      assert.deepEqual(value.hashes, [value.value.executable, `${mount}/resources/app.asar`, installedImage]);
    }
    for (const [key, mismatch] of [['APPIMAGE', 'FUSE_APPIMAGE_ENV_MISMATCH'], ['APPDIR', 'FUSE_APPDIR_ENV_MISMATCH']]) {
      for (const observed of ['', '/synthetic/wrong']) {
        const value = appProcess();
        value.files.cmdline = [value.value.executable, ...value.io.expectedArguments].join(separator) + '\0';
        // A defined mismatch is refused even when the other entry is absent.
        value.files.environ = `${key}=${observed}\0`;
        await assert.rejects(readLinuxFinalAppProcessIdentity(value.pid, value.expected, temporary, value.io), {
          code: `LINUX_FINAL_LIFECYCLE_${mismatch}`,
        });
        assert.deepEqual(value.hashes, []);
      }
    }
  }
});

test('browser launch proof compares complete canonical argv without tokenization, trimming or prefix matching', () => {
  const executable = `${mount}/tibotattle`;
  const expectedArguments = ['--user-data-dir=/synthetic/profile', '--remote-debugging-port=12345',
    '--remote-debugging-address=127.0.0.1', '--disable-gpu'];
  const matches = commandLine => linuxFinalBrowserCommandLineMatches({ commandLine, executable, expectedArguments });
  for (const separator of ['\0', ' ']) {
    const command = args => [executable, ...args].join(separator) + '\0';
    assert.equal(matches(command(expectedArguments)), true);
    for (const args of [[], expectedArguments.slice(1), expectedArguments.slice(0, -1), [...expectedArguments].reverse(),
      [...expectedArguments, '--extra'], expectedArguments.map(arg => arg.replace('12345', '12346')),
      [...expectedArguments, '--no-sandbox'], [...expectedArguments, '--disable-setuid-sandbox=1'],
      [...expectedArguments, '--type=renderer']]) assert.equal(matches(command(args)), false);
  }
  const title = [executable, ...expectedArguments].join(' ') + '\0';
  for (const commandLine of ['', null, title.slice(0, -1), `${title}\0`, ` ${title}`, title.replace(' ', '  '),
    title.replace(' ', '\t'), `${executable} ${expectedArguments.join(' ')} \0`,
    title.replace(executable, `${executable}-other`), `${executable}\0${expectedArguments.join(' ')}\0`,
    title.replace(executable, `${executable} (deleted)`)]) assert.equal(matches(commandLine), false);
  for (const expected of [undefined, null, {}, [''], ['a b'], ['a\tb'], ['a\0b'], ['a\u0007b'],
    ['x'.repeat(4097)], Array(9).fill('--disable-gpu'), ['--type='], ['--type=renderer'], ['--no-sandbox'], ['--disable-setuid-sandbox=1']]) {
    assert.throws(() => linuxFinalBrowserCommandLineMatches({ commandLine: title, executable, expectedArguments: expected }), /PROCESS_LAUNCH_ARGUMENTS_INVALID/u);
  }
});

test('missing environment never turns a generic mount, unknown launch or wrong byte identity into a browser', async () => {
  for (const separator of ['\0', ' ']) {
    for (const [code, alter] of [
      ['PROCESS_LAUNCH_ARGUMENTS_INVALID', v => { v.io.expectedArguments = undefined; }],
      ['PROCESS_LAUNCH_ARGUMENTS_INVALID', v => { v.files.cmdline = [v.value.executable, '--remote-debugging-port=12346'].join(separator) + '\0'; }],
      ['PROCESS_LAUNCH_ARGUMENTS_INVALID', v => { v.files.cmdline = [v.value.executable, ...v.io.expectedArguments, '--no-sandbox'].join(separator) + '\0'; }],
      ['FUSE_MOUNT_SOURCE_INVALID', v => { v.files.mountinfo = v.files.mountinfo.replace('fuse.TiboTattle.AppImage TiboTattle.AppImage', 'fuse.squashfuse squashfuse'); }],
      ['FUSE_MOUNT_SOURCE_INVALID', v => { v.files.mountinfo = v.files.mountinfo.replace('TiboTattle.AppImage ro,user', 'other.AppImage ro,user'); }],
      ['FUSE_MOUNT_READ_ONLY_REQUIRED', v => { v.files.mountinfo = v.files.mountinfo.replace(' ro,nosuid', ' rw,nosuid'); }],
      ['FUSE_MOUNT_UID_INVALID', v => { v.files.mountinfo = v.files.mountinfo.replace('user_id=1000', 'user_id=0'); }],
      ['FUSE_MOUNT_AMBIGUOUS', v => { v.files.mountinfo += v.files.mountinfo; }],
      ['PROCESS_UID_INVALID', v => { v.files.status = 'Uid:\t1000\t0\t1000\t1000\n'; }],
      ['FUSE_EXTRACTION_MODE_FORBIDDEN', v => { v.files.environ = 'APPIMAGE_EXTRACT_AND_RUN=\0'; }],
    ]) {
      const value = appProcess(); value.files.environ = '';
      value.files.cmdline = [value.value.executable, ...value.io.expectedArguments].join(separator) + '\0';
      alter(value);
      await assert.rejects(readLinuxFinalAppProcessIdentity(value.pid, value.expected, temporary, value.io), { code: `LINUX_FINAL_LIFECYCLE_${code}` });
      assert.deepEqual(value.hashes, []);
    }
    for (const key of ['executableSha256', 'asarSha256', 'sha256']) {
      const value = appProcess(); value.files.environ = '';
      value.files.cmdline = [value.value.executable, ...value.io.expectedArguments].join(separator) + '\0';
      const pending = readLinuxFinalAppProcessIdentity(value.pid, { ...value.expected, [key]: 'c'.repeat(64) }, temporary, value.io);
      if (key === 'sha256') await assert.rejects(pending, /INSTALLED_BYTES_INVALID/u);
      else assert.equal(await pending, null);
    }
    const unstable = appProcess(); unstable.files.environ = ''; let reads = 0;
    unstable.files.cmdline = [unstable.value.executable, ...unstable.io.expectedArguments].join(separator) + '\0';
    await assert.rejects(readLinuxFinalAppProcessIdentity(unstable.pid, unstable.expected, temporary, {
      ...unstable.io, read: async path => {
        const value = await unstable.io.read(path);
        return path.endsWith('/stat') && ++reads > 1 ? value.replace(/100$/u, '101') : value;
      },
    }), /PROCESS_BYTES_CHANGED/u);
    for (const path of [`${temporary}/appimage_extracted_example/tibotattle`, '/tmp/.mount_other/tibotattle']) {
      const unowned = appProcess(); unowned.files.environ = '';
      unowned.files.cmdline = [path, ...unowned.io.expectedArguments].join(separator) + '\0';
      assert.equal(await readLinuxFinalAppProcessIdentity(unowned.pid, unowned.expected, temporary, { ...unowned.io, link: async () => path }), null);
      assert.deepEqual(unowned.hashes, []);
    }
  }
});

test('the updater successor admits only its known empty argument vector with complete image proof', async () => {
  const value = appProcess(); value.files.environ = '';
  value.io.expectedArguments = []; value.files.cmdline = `${value.value.executable}\0`;
  const identity = await readLinuxFinalAppProcessIdentity(value.pid, value.expected, temporary, value.io);
  assert.equal(identity.pid, value.pid);
  assert.deepEqual(value.hashes, [value.value.executable, `${mount}/resources/app.asar`, installedImage]);
  for (const commandLine of [`${value.value.executable}\0--remote-debugging-port=12345\0`,
    `${value.value.executable} --remote-debugging-port=12345\0`]) {
    value.files.cmdline = commandLine; value.hashes.length = 0;
    await assert.rejects(readLinuxFinalAppProcessIdentity(value.pid, value.expected, temporary, value.io), /PROCESS_LAUNCH_ARGUMENTS_INVALID/u);
    assert.deepEqual(value.hashes, []);
  }
});

function ownedLaunchVectors() {
  return [
    ['--user-data-dir=/synthetic/fresh', '--remote-debugging-port=12345', '--remote-debugging-address=127.0.0.1', '--disable-gpu'],
    ['--remote-debugging-port=12346', '--remote-debugging-address=127.0.0.1', '--disable-gpu'],
    [],
    ['--user-data-dir=/synthetic/upgrade', '--remote-debugging-port=12347', '--remote-debugging-address=127.0.0.1', '--disable-gpu'],
  ];
}
const oneProcessPoll = async predicate => { const value = await predicate(); if (!value) throw new Error('SYNTHETIC_TIMEOUT'); return value; };

test('all four retained launches are discoverable while each lifecycle stage requires its own unique browser', async () => {
  const vectors = ownedLaunchVectors();
  for (const separator of ['\0', ' ']) {
    for (const [index, args] of vectors.entries()) {
      const value = appProcess(); value.files.environ = '';
      value.files.cmdline = [value.value.executable, ...args].join(separator) + '\0';
      const found = await readLinuxFinalKnownAppProcessIdentity(value.pid, value.expected, temporary, vectors, value.io);
      assert.equal(found.argumentIndex, index); assert.equal(found.identity.pid, value.pid);
      const find = async (expected, actualTemporary, actualVectors) => {
        assert.equal(expected, value.expected); assert.equal(actualTemporary, temporary); assert.equal(actualVectors, vectors);
        return [found];
      };
      assert.equal(await currentLinuxFinalApp(value.expected, temporary, args, vectors, { find, waiter: oneProcessPoll }), found.identity);
      await assert.rejects(currentLinuxFinalApp(value.expected, temporary, vectors[(index + 1) % 4], vectors, { find, waiter: oneProcessPoll }), /SYNTHETIC_TIMEOUT/u);
      await assert.rejects(currentLinuxFinalApp(value.expected, temporary, args, vectors, {
        find: async () => [found, { identity: { ...found.identity, pid: 52 }, argumentIndex: (index + 1) % 4 }], waiter: oneProcessPoll,
      }), /MULTIPLE_APPS/u);
    }
  }
  const unknown = appProcess(); unknown.files.cmdline = `${unknown.value.executable}\0--arbitrary\0`;
  await assert.rejects(readLinuxFinalKnownAppProcessIdentity(unknown.pid, unknown.expected, temporary, vectors, unknown.io), /PROCESS_LAUNCH_ARGUMENTS_INVALID/u);
  const mismatch = appProcess(); mismatch.files.cmdline = [mismatch.value.executable, ...vectors[3]].join(' ') + '\0';
  mismatch.files.environ = 'APPIMAGE=/synthetic/wrong\0';
  await assert.rejects(readLinuxFinalKnownAppProcessIdentity(mismatch.pid, mismatch.expected, temporary, vectors, mismatch.io), /FUSE_APPIMAGE_ENV_MISMATCH/u);
  const node = appProcess('node');
  assert.equal(await readLinuxFinalKnownAppProcessIdentity(node.pid, node.expected, temporary, vectors, node.io), null);
  for (const invalid of [[], [...vectors, []], [null]]) {
    await assert.rejects(readLinuxFinalKnownAppProcessIdentity(node.pid, node.expected, temporary, invalid, node.io), /PROCESS_LAUNCH_ARGUMENTS_INVALID/u);
  }
});

test('owned shutdown signals authenticated browsers and proves every captured companion gone before mount cleanup', async () => {
  const vectors = ownedLaunchVectors();
  for (const args of vectors) {
    const value = appProcess(); value.files.environ = '';
    value.files.cmdline = [value.value.executable, ...args].join(' ') + '\0';
    const { identity } = await readLinuxFinalKnownAppProcessIdentity(value.pid, value.expected, temporary, vectors, value.io);
    const tree = [identity, { pid: 51, startTime: '101' }], events = [];
    let exited = false;
    await stopLinuxFinalOwnedApp(identity, temporary, {
      readDescendants: async browser => { assert.equal(browser, identity); events.push('capture_tree'); return tree; },
      readAlive: async browser => { assert.equal(browser, identity); events.push('stable_identity'); return true; },
      signal: (pid, signal) => { assert.equal(pid, identity.pid); assert.equal(signal, 'SIGUSR2'); events.push('signal'); exited = true; },
      waitForTreeGone: async captured => {
        assert.equal(captured, tree); events.push('tree_gone');
        await assertLinuxFinalProcessTreeGone(captured, { waiter: oneProcessPoll, readAlive: async child => {
          assert.ok(tree.includes(child)); return !exited;
        } });
      },
      waitForMountsGone: async path => { assert.equal(path, temporary); events.push('mounts_gone'); },
    });
    assert.deepEqual(events, ['capture_tree', 'stable_identity', 'signal', 'tree_gone', 'mounts_gone']);
  }
  const identity = { pid: 50, startTime: '100' }, tree = [identity, { pid: 51, startTime: '101' }];
  const events = [];
  await assert.rejects(stopLinuxFinalOwnedApp(identity, temporary, {
    readDescendants: async () => tree, readAlive: async () => true,
    signal: () => { events.push('signal'); },
    waitForTreeGone: captured => assertLinuxFinalProcessTreeGone(captured, {
      waiter: oneProcessPoll, readAlive: async child => child.pid === 51,
    }),
    waitForMountsGone: async () => { events.push('mounts_gone'); },
  }), /SYNTHETIC_TIMEOUT/u);
  assert.deepEqual(events, ['signal']); // A reparented Node companion still blocks cleanup.
  await stopLinuxFinalOwnedApp(identity, temporary, {
    readDescendants: async () => tree, readAlive: async () => false,
    signal: () => assert.fail('A reused or exited PID must never be signalled'),
    waitForTreeGone: captured => assertLinuxFinalProcessTreeGone(captured, { waiter: oneProcessPoll, readAlive: async () => false }),
    waitForMountsGone: async () => {},
  });
});

test('renderer title parsing cannot hide sandbox bypass flags or ambiguous child roles', () => {
  const executable = `${mount}/tibotattle`, status = 'NoNewPrivs:\t1\nSeccomp:\t2\n';
  for (const separator of ['\0', ' ']) {
    const command = args => [executable, ...args].join(separator) + '\0';
    assert.equal(linuxFinalSandboxStatus({ commandLine: command(['--type=renderer']), executable, status }), true);
    for (const flags of [['--no-sandbox'], ['--no-sandbox=1'], ['--disable-setuid-sandbox'], ['--disable-setuid-sandbox=1'],
      ['--type=utility'], ['--type='], ['--type'], ['--type=unknown']]) {
      assert.equal(linuxFinalSandboxStatus({ commandLine: command(['--type=renderer', ...flags]), executable, status }), false);
    }
    for (const altered of ['NoNewPrivs:\t0\nSeccomp:\t2\n', 'NoNewPrivs:\t1\nSeccomp:\t0\n']) {
      assert.equal(linuxFinalSandboxStatus({ commandLine: command(['--type=renderer']), executable, status: altered }), false);
    }
  }
  for (const commandLine of [`${executable} --type=renderer`, `${executable}  --type=renderer\0`,
    `${executable}\t--type=renderer\0`, `${executable} --type=renderer \0`, `${executable} --type=renderer\0\0`,
    `/synthetic/other --type=renderer\0`, `${executable}\0--type=renderer --no-sandbox\0`]) {
    assert.equal(linuxFinalSandboxStatus({ commandLine, executable, status }), false);
  }
});
function rendererProbe(children = [{}]) {
  const browser = { pid: 50, startTime: '100', executable: `${mount}/tibotattle` }, events = [];
  const renderer = { pid: 51, startTime: '101', executable: browser.executable,
    commandLine: `${browser.executable}\0--type=renderer\0`, status: 'NoNewPrivs:\t1\nSeccomp:\t2\n' };
  const rows = [ { ...browser, commandLine: `${browser.executable}\0--remote-debugging-port=12345\0`, status: 'NoNewPrivs:\t0\nSeccomp:\t2\n' },
    ...children.map((value, index) => ({ ...renderer, pid: 51 + index, ...value })) ];
  const lookup = path => { const [, pid, field] = /^\/proc\/(\d+)\/(status|cmdline|exe)$/u.exec(path); return { row: rows.find(value => value.pid === Number(pid)), field }; };
  const options = {
    readDescendants: async identity => { assert.equal(identity, browser); events.push('descendants'); return rows; },
    read: async path => {
      const { row, field } = lookup(path); events.push(field);
      const value = row[field === 'cmdline' ? 'commandLine' : field]; if (value instanceof Error) throw value; return value;
    },
    link: async path => { const { row } = lookup(path); events.push('exe'); if (row.executable instanceof Error) throw row.executable; return row.executable; },
    waiter: async (predicate, timeout) => {
      assert.equal(timeout, 10000);
      if (await predicate() !== true) throw Object.assign(new Error('private synthetic timeout'), { code: 'LINUX_REAL_APPIMAGE_TIMEOUT' });
    },
  };
  return { browser, rows, options, events };
}
async function expectRendererObservation(value, code) {
  await assert.rejects(assertLinuxFinalRendererSandbox(value.browser, value.options), error => {
    const expected = `LINUX_FINAL_LIFECYCLE_RENDERER_SANDBOX_OBSERVED_${code}`;
    assert.equal(error.code, expected); assert.equal(error.message, expected);
    assert.deepEqual(Object.keys(error), ['code']);
    assert.doesNotMatch(JSON.stringify(error), /private|synthetic|\/proc\//u);
    return true;
  });
}

test('renderer diagnostics preserve success while distinguishing each denied, vanished and unavailable proc read', async () => {
  const success = rendererProbe(); await assertLinuxFinalRendererSandbox(success.browser, success.options);
  for (const [field, stage] of [['status', 'STATUS'], ['commandLine', 'COMMAND_LINE'], ['executable', 'TITLE_RENDERER_EXECUTABLE']]) {
    for (const [errno, outcome] of [['ENOENT', 'VANISHED'], ['ESRCH', 'VANISHED'], ['EACCES', 'DENIED'], ['EPERM', 'DENIED'], ['EIO', 'UNAVAILABLE'], ['PRIVATE_UNKNOWN', 'UNAVAILABLE']]) {
      const failure = Object.assign(new Error('private synthetic detail'), { code: errno, path: '/synthetic/private', pid: 999 });
      await expectRendererObservation(rendererProbe([{ [field]: failure }]), `${stage}_READ_${outcome}`);
    }
  }
  const noTitle = rendererProbe([{ commandLine: 'unrecognized\0', executable: Object.assign(new Error('private'), { code: 'EACCES' }) }]);
  await expectRendererObservation(noTitle, 'EXECUTABLE_READ_DENIED');
});

test('renderer diagnostics distinguish absent candidates, unreadable title, unrelated executable and title-only mismatch', async () => {
  const exe = `${mount}/tibotattle`;
  for (const [children, code] of [
    [[], 'NO_DESCENDANTS'],
    [[{ commandLine: `${exe}\0--type=utility\0` }], 'ROLE_UNOBSERVED'],
    [[{ commandLine: `${exe}  --type=renderer\0` }], 'COMMAND_LINE_INVALID'],
    [[{ commandLine: 'unknown-title\0' }], 'COMMAND_LINE_INVALID'],
    [[{ commandLine: '/synthetic/other\0', executable: '/synthetic/other' }], 'UNRELATED_EXECUTABLE'],
    [[{ executable: '/synthetic/other' }], 'TITLE_RENDERER_EXECUTABLE_MISMATCH'],
  ]) await expectRendererObservation(rendererProbe(children), code);
});

test('renderer-specific observations separate bypass flags, explicitly refused kernel controls and unknown status', async () => {
  const exe = `${mount}/tibotattle`;
  for (const separator of ['\0', ' ']) {
    const commandLine = [exe, '--type=renderer'].join(separator) + '\0';
    for (const [change, code] of [
      [{ commandLine: [exe, '--type=renderer', '--no-sandbox'].join(separator) + '\0' }, 'BYPASS_FLAGS_PRESENT'],
      [{ commandLine: [exe, '--type=renderer', '--disable-setuid-sandbox=1'].join(separator) + '\0' }, 'BYPASS_FLAGS_PRESENT'],
      [{ status: 'NoNewPrivs:\t0\nSeccomp:\t2\n' }, 'NO_NEW_PRIVS_DISABLED'],
      [{ status: 'Seccomp:\t2\n' }, 'NO_NEW_PRIVS_UNKNOWN'],
      [{ status: 'NoNewPrivs:\tinvalid\nSeccomp:\t2\n' }, 'NO_NEW_PRIVS_UNKNOWN'],
      [{ status: 'NoNewPrivs:\t0\nNoNewPrivs:\t0\nSeccomp:\t2\n' }, 'NO_NEW_PRIVS_UNKNOWN'],
      [{ status: 'NoNewPrivs:\t1\nSeccomp:\t0\n' }, 'SECCOMP_NOT_FILTERING'],
      [{ status: 'NoNewPrivs:\t1\nSeccomp:\t1\n' }, 'SECCOMP_NOT_FILTERING'],
      [{ status: 'NoNewPrivs:\t1\n' }, 'SECCOMP_UNKNOWN'],
      [{ status: 'NoNewPrivs:\t1\nSeccomp:\tinvalid\n' }, 'SECCOMP_UNKNOWN'],
      [{ status: 'NoNewPrivs:\t1\nSeccomp:\t0\nSeccomp:\t1\n' }, 'SECCOMP_UNKNOWN'],
    ]) await expectRendererObservation(rendererProbe([{ commandLine, ...change }]), code);
  }
});

test('renderer observation priority keeps complete child witnesses without combining facts or hiding later success', async () => {
  const exe = `${mount}/tibotattle`, denied = Object.assign(new Error('private'), { code: 'EACCES' });
  const blocked = { executable: denied };
  for (const children of [[blocked, { commandLine: `${exe}\0--type=utility\0` }, { commandLine: 'unknown-title\0' }],
    [{ commandLine: 'unknown-title\0' }, blocked]]) {
    await expectRendererObservation(rendererProbe(children), 'TITLE_RENDERER_EXECUTABLE_READ_DENIED');
  }
  await expectRendererObservation(rendererProbe([blocked, { status: 'NoNewPrivs:\t0\nSeccomp:\t2\n' }]), 'NO_NEW_PRIVS_DISABLED');
  await expectRendererObservation(rendererProbe([blocked, { executable: '/synthetic/other' }]), 'TITLE_RENDERER_EXECUTABLE_MIXED');
  await expectRendererObservation(rendererProbe([{ status: 'NoNewPrivs:\t0\nSeccomp:\t2\n' },
    { status: 'NoNewPrivs:\t1\nSeccomp:\t0\n' }]), 'SECCOMP_NOT_FILTERING');
  // No child's complete role/exe/control chain passes; facts cannot be combined.
  await expectRendererObservation(rendererProbe([{ commandLine: `${exe}\0--type=utility\0` },
    { status: 'NoNewPrivs:\t0\nSeccomp:\t2\n' }]), 'NO_NEW_PRIVS_DISABLED');
  await expectRendererObservation(rendererProbe([{ status: 'NoNewPrivs:\t0\nSeccomp:\t2\n' },
    { status: 'Seccomp:\t2\n' }]), 'NO_NEW_PRIVS_MIXED');
  const succeeds = rendererProbe([blocked, {}]);
  await assertLinuxFinalRendererSandbox(succeeds.browser, succeeds.options);
  const later = rendererProbe([blocked]); let polls = 0;
  later.options.waiter = async (predicate, timeout) => {
    assert.equal(timeout, 10000); assert.equal(await predicate(), false); polls++;
    later.rows[1].executable = exe;
    assert.equal(await predicate(), true); polls++;
  };
  await assertLinuxFinalRendererSandbox(later.browser, later.options); assert.equal(polls, 2);
});

test('renderer enumeration, timeout and hook diagnostics expose only their exact closed observation contract', async () => {
  for (const [underlying, expected] of [['LINUX_FINAL_LIFECYCLE_PROCESS_TREE_UNBOUNDED', 'TREE_UNBOUNDED'], ['PRIVATE_UNKNOWN', 'ENUMERATION_FAILED']]) {
    const value = rendererProbe(); value.options.readDescendants = async () => { throw Object.assign(new Error('private'), { code: underlying }); };
    await assert.rejects(assertLinuxFinalRendererSandbox(value.browser, value.options), { code: `LINUX_FINAL_LIFECYCLE_RENDERER_${expected}` });
  }
  const denied = rendererProbe([{ executable: Object.assign(new Error('private'), { code: 'EACCES' }) }]);
  const journey = normalJourney();
  journey.options.assertSandbox = () => assertLinuxFinalRendererSandbox(denied.browser, denied.options);
  await assert.rejects(runLinuxFinalNormalJourney(journey.options), error => {
    const code = 'LINUX_FINAL_LIFECYCLE_NORMAL_RENDERER_SANDBOX_OBSERVED_TITLE_RENDERER_EXECUTABLE_READ_DENIED';
    assert.equal(error.code, code); assert.equal(error.message, code);
    assert.match(code, /^LINUX_FINAL_LIFECYCLE_[A-Z_]{1,100}$/u);
    assert.deepEqual(Object.keys(error), ['code']);
    assert.deepEqual(linuxFinalFailureDetails(error.code, null), { errorCode: code });
    return true;
  });
  assert.deepEqual(journey.events, ['identity', 'cleanup']);
  for (const code of ['PRIVATE_UNKNOWN', 'LINUX_FINAL_LIFECYCLE_RENDERER_SANDBOX_OBSERVED_PRIVATE_UNKNOWN']) {
    const probe = rendererProbe(); probe.options.waiter = async () => { throw Object.assign(new Error('private'), { code }); };
    const value = normalJourney(); value.options.assertSandbox = () => assertLinuxFinalRendererSandbox(probe.browser, probe.options);
    await assert.rejects(runLinuxFinalNormalJourney(value.options), { code: 'LINUX_FINAL_LIFECYCLE_NORMAL_RENDERER_SANDBOX_FAILED' });
    assert.deepEqual(value.events, ['identity', 'cleanup']);
  }
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

function normalJourney({ failureAt = null, smokeFailure = null, preserveState = true } = {}) {
  const events = [], identity = Object.freeze({ pid: 50, startTime: '100' });
  const context = Object.freeze({ cdp: {}, dashboardOrigin: 'http://127.0.0.1:12345', fixture: {} });
  const action = name => {
    events.push(name);
    if (failureAt === name) throw Object.assign(new Error('synthetic detail must remain private'), { code: 'PRIVATE_SYNTHETIC_DETAIL' });
  };
  const run = beforeQuit => runOneNormalApp({ sourceRevision: revision, artifactSha256: 'a'.repeat(64) }, {
    appPath: '/synthetic/TiboTattle.AppImage', environment: {}, service: 'available', beforeQuit,
    run: async options => {
      let stage = 'renderer_late_network';
      try {
        if (smokeFailure === 'network') throw new Error('synthetic network refusal');
        await options.beforeQuit(context);
        stage = 'quit_cleanup';
        if (smokeFailure === 'cleanup') throw new Error('synthetic cleanup refusal');
        return { status: 'passed' };
      } catch (error) { options.onFailureStage(stage); throw error; }
      finally { events.push('cleanup'); }
    },
  });
  return { events, identity, context, run, options: {
    run,
    readIdentity: async () => { action('identity'); return identity; },
    assertSandbox: async value => { assert.equal(value, identity); action('sandbox'); },
    preferences: async value => { assert.equal(value, context); action('preferences'); },
    noUpdate: async (value, browser) => { assert.equal(value, context); assert.equal(browser, identity); action('no_update'); },
    preserveState: preserveState ? async () => { action('state'); } : null,
  } };
}

test('final lifecycle reports the actual hook substep after shared smoke cleanup instead of its stale network stage', async () => {
  const original = normalJourney();
  await assert.rejects(original.run(async () => { throw new Error('synthetic identity refusal'); }), {
    code: 'ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SOURCE_SMOKE_RENDERER_LATE_NETWORK_FAILED',
  });
  assert.deepEqual(original.events, ['cleanup']);
  const steps = ['identity', 'sandbox', 'preferences', 'no_update', 'state'];
  const codes = ['NORMAL_APP_IDENTITY_FAILED', 'NORMAL_RENDERER_SANDBOX_FAILED', 'NORMAL_PREFERENCES_FAILED',
    'NORMAL_NO_UPDATE_FAILED', 'NORMAL_LOCAL_STATE_FAILED'];
  for (const [index, failureAt] of steps.entries()) {
    const value = normalJourney({ failureAt });
    await assert.rejects(runLinuxFinalNormalJourney(value.options), error => {
      const errorCode = `LINUX_FINAL_LIFECYCLE_${codes[index]}`;
      assert.equal(error.code, errorCode); assert.equal(error.message, errorCode);
      assert.deepEqual(linuxFinalFailureDetails(error.code, null), { errorCode });
      assert.doesNotMatch(JSON.stringify(error), /synthetic detail|PRIVATE_SYNTHETIC_DETAIL/u);
      assert.deepEqual(value.events, [...steps.slice(0, index + 1), 'cleanup']);
      return true;
    });
  }
});

test('both final normal journeys retain identity, sandbox, preferences and no-update checks before clean completion', async () => {
  for (const preserveState of [false, true]) {
    const value = normalJourney({ preserveState });
    assert.equal(await runLinuxFinalNormalJourney(value.options), value.identity);
    assert.deepEqual(value.events, ['identity', 'sandbox', 'preferences', 'no_update', ...(preserveState ? ['state'] : []), 'cleanup']);
  }
});

test('final hook diagnostics do not relabel genuine network or subsequent cleanup failures', async () => {
  for (const [smokeFailure, code, expected] of [
    ['network', 'RENDERER_LATE_NETWORK', ['cleanup']],
    ['cleanup', 'QUIT_CLEANUP', ['identity', 'sandbox', 'preferences', 'no_update', 'state', 'cleanup']],
  ]) {
    const value = normalJourney({ smokeFailure });
    await assert.rejects(runLinuxFinalNormalJourney(value.options), {
      code: `ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SOURCE_SMOKE_${code}_FAILED`,
    });
    assert.deepEqual(value.events, expected);
  }
});

test('final normal journey refuses omitted, swallowed, repeated or invalid hooks', async () => {
  const omitted = normalJourney();
  await assert.rejects(runLinuxFinalNormalJourney({ ...omitted.options, run: async () => {} }), /NORMAL_HOOK_UNPROVEN/u);
  assert.deepEqual(omitted.events, []);
  const swallowed = normalJourney({ failureAt: 'sandbox' });
  await assert.rejects(runLinuxFinalNormalJourney({ ...swallowed.options, run: async hook => {
    try { await hook(swallowed.context); } catch { /* Simulate a faulty adapter. */ }
  } }), /NORMAL_RENDERER_SANDBOX_FAILED/u);
  assert.deepEqual(swallowed.events, ['identity', 'sandbox']);
  const repeated = normalJourney();
  await assert.rejects(runLinuxFinalNormalJourney({ ...repeated.options, run: async hook => {
    await hook(repeated.context); await hook(repeated.context);
  } }), /NORMAL_HOOK_INVALID/u);
  assert.deepEqual(repeated.events, ['identity', 'sandbox', 'preferences', 'no_update', 'state']);
  for (const key of ['run', 'readIdentity', 'assertSandbox', 'preferences', 'noUpdate', 'preserveState']) {
    await assert.rejects(runLinuxFinalNormalJourney({ ...normalJourney().options, [key]: 'invalid' }), /NORMAL_HOOK_INVALID/u);
  }
});

async function assertIdentityCause(action, reason) {
  const value = normalJourney(), readIdentity = value.options.readIdentity;
  value.options.readIdentity = async () => { await readIdentity(); return action(); };
  await assert.rejects(runLinuxFinalNormalJourney(value.options), error => {
    const errorCode = `LINUX_FINAL_LIFECYCLE_NORMAL_APP_IDENTITY_${reason}`;
    assert.equal(error.code, errorCode); assert.equal(error.message, errorCode);
    // This is the established failed-receipt errorCode bound, not a new schema.
    assert.match(errorCode, /^LINUX_FINAL_LIFECYCLE_[A-Z_]{1,100}$/u);
    assert.deepEqual(Object.keys(error), ['code']);
    assert.deepEqual(linuxFinalFailureDetails(error.code, null), { errorCode });
    assert.doesNotMatch(JSON.stringify(error), /synthetic detail|PRIVATE_SYNTHETIC_DETAIL/u);
    assert.deepEqual(value.events, ['identity', 'cleanup']);
    return true;
  });
}

test('every FUSE predicate remains a distinct closed identity cause through the real packaged error mapper', async () => {
  for (const [code, alter] of fuseRefusals) {
    const value = mounted(); alter(value);
    await assertIdentityCause(() => selectLinuxFinalFuseMount(value), code);
  }
});

test('process role, UID, start-time and safe-file failures keep only fixed identity causes after cleanup', async () => {
  for (const [code, alter] of [
    ['PROCESS_NODE_MODE_INVALID', v => { v.files.environ += 'ELECTRON_RUN_AS_NODE=invalid\0'; }],
    ['PROCESS_LAUNCH_ARGUMENTS_INVALID', v => { v.io.expectedArguments = []; }],
    ['INSTALLED_BYTES_INVALID', v => { v.io.hash = async path => path === installedImage ? 'c'.repeat(64) : path === v.value.executable ? v.expected.executableSha256 : v.expected.asarSha256; }],
    ['PROCESS_UID_INVALID', v => { v.files.status = 'Uid:\t0\t0\t0\t0\n'; }],
    ['PROCESS_START_TIME_INVALID', v => { v.files.stat = v.files.stat.replace(/100$/u, 'invalid'); }],
  ]) {
    const value = appProcess(); alter(value);
    await assertIdentityCause(() => readLinuxFinalAppProcessIdentity(value.pid, value.expected, temporary, value.io), code);
  }
  const changed = appProcess(); let statReads = 0;
  await assertIdentityCause(() => readLinuxFinalAppProcessIdentity(changed.pid, changed.expected, temporary, {
    ...changed.io, read: async path => {
      const value = await changed.io.read(path);
      return path.endsWith('/stat') && ++statReads > 1 ? value.replace(/100$/u, '101') : value;
    },
  }), 'PROCESS_BYTES_CHANGED');
  for (const code of ['FILE_UNSAFE', 'FILE_CHANGED']) {
    const value = appProcess();
    await assertIdentityCause(() => readLinuxFinalAppProcessIdentity(value.pid, value.expected, temporary, {
      ...value.io, hash: async () => {
        throw Object.assign(new Error('synthetic detail must remain private'), {
          code: `LINUX_FINAL_LIFECYCLE_${code}`, path: 'PRIVATE_SYNTHETIC_DETAIL',
        });
      },
    }), code);
  }
  for (const [code, reason] of [['LINUX_FINAL_LIFECYCLE_MULTIPLE_APPS', 'MULTIPLE_APPS'],
    ['LINUX_REAL_APPIMAGE_TIMEOUT', 'TIMEOUT']]) {
    await assertIdentityCause(() => { throw Object.assign(new Error('synthetic detail'), { code }); }, reason);
  }
});

test('identity diagnostics refuse unknown, private or oversized codes and do not cross hook boundaries', async () => {
  for (const code of [undefined, null, 1, 'PRIVATE_SYNTHETIC_DETAIL', 'LINUX_FINAL_LIFECYCLE_PRIVATE_SYNTHETIC_DETAIL',
    'LINUX_FINAL_LIFECYCLE_FILE_UNSAFE_PRIVATE_SYNTHETIC_DETAIL', 'LINUX_FINAL_LIFECYCLE_PROCESS_ROLE_UNKNOWN_PRIVATE_SYNTHETIC_DETAIL',
    `LINUX_FINAL_LIFECYCLE_${'A'.repeat(101)}`]) {
    await assertIdentityCause(() => { throw Object.assign(new Error('synthetic detail'), { code }); }, 'FAILED');
  }
  const value = normalJourney();
  value.options.assertSandbox = async () => {
    throw Object.assign(new Error('synthetic detail'), { code: 'LINUX_FINAL_LIFECYCLE_FILE_UNSAFE' });
  };
  await assert.rejects(runLinuxFinalNormalJourney(value.options), { code: 'LINUX_FINAL_LIFECYCLE_NORMAL_RENDERER_SANDBOX_FAILED' });
  assert.deepEqual(value.events, ['identity', 'cleanup']);
});
