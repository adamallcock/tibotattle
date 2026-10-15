// POSIX/Python archive boundary; invoked explicitly by the native Linux lane.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, link, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fingerprintLinuxFinalFile, LINUX_FINAL_ZIP_EXTRACTOR, reserveLinuxFinalDirectory,
  readLinuxFinalCandidateSourceFile, readLinuxFinalPackagedAuthorityFile } from '../scripts/qualify-electron-linux-installed-lifecycle.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('final-byte reads reject links, growth beyond bounds and aliases', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'linux-final-fingerprint-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'artifact'); await writeFile(file, 'abc');
  assert.equal((await fingerprintLinuxFinalFile(file)).sha256, hash('abc'));
  await assert.rejects(fingerprintLinuxFinalFile(file, 2));
  await symlink(file, join(root, 'alias')); await assert.rejects(fingerprintLinuxFinalFile(join(root, 'alias')));
  await link(file, join(root, 'hardlink')); await assert.rejects(fingerprintLinuxFinalFile(file));
});
test('ZIP extraction refuses unexpected, duplicate and symlink entries before writing any member', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'linux-final-zip-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const kind of ['valid', 'traversal', 'duplicate', 'symlink']) {
    const archive = join(root, `${kind}.zip`), output = join(root, kind); await mkdir(output);
    const create = spawnSync('python3', ['-c', `import sys,zipfile\np,k=sys.argv[1:]\nwith zipfile.ZipFile(p,'w') as z:\n z.writestr('artifact',b'abc')\n if k=='traversal': z.writestr('../outside',b'x')\n if k=='duplicate': z.writestr('artifact',b'x')\n if k=='symlink':\n  i=zipfile.ZipInfo('link');i.create_system=3;i.external_attr=0o120777<<16;z.writestr(i,'artifact')`, archive, kind], { stdio: 'ignore' });
    assert.equal(create.status, 0);
    const result = spawnSync('python3', ['-c', LINUX_FINAL_ZIP_EXTRACTOR, archive, output,
      JSON.stringify(kind === 'symlink' ? ['artifact', 'link'] : ['artifact'])], { stdio: 'ignore' });
    if (kind === 'valid') { assert.equal(result.status, 0); assert.equal(await readFile(join(output, 'artifact'), 'utf8'), 'abc'); }
    else { assert.notEqual(result.status, 0); await assert.rejects(readFile(join(output, 'artifact')), { code: 'ENOENT' }); }
  }
});

for (const [route, version, buildNumber] of [['v1', '0.1.27', '2026100301'], ['v2', '0.1.28', '2026100901']])
  test(`${version} runner admission proves ancestry and same-version source without implying execution`, async t => {
  const { preflightLinuxFinalIntake, LINUX_FINAL_SCHEMA_V3, LINUX_FINAL_SCHEMA_V4, LINUX_FINAL_CONFIRMATION } = await import('../scripts/lib/linux-final-artifact-intake.mjs');
  const { productionElectronCandidatePlan } = await import('../scripts/package-electron-production.mjs');
  const schemaVersion = route === 'v1' ? LINUX_FINAL_SCHEMA_V3 : LINUX_FINAL_SCHEMA_V4;
  const root = await mkdtemp(join(await realpath(tmpdir()), 'linux-final-ancestry-')); t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.equal(result.status, 0); return result.stdout.trim();
  };
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Synthetic fixture']); git(['config', 'user.email', 'synthetic@example.test']);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app-usagemonitor', type: 'module', version }) + '\n');
  git(['add', 'package.json']); git(['commit', '-m', 'Synthetic frozen application']); const sourceRevision = git(['rev-parse', 'HEAD']);
  await writeFile(join(root, 'runner'), 'qualification only'); git(['add', 'runner']); git(['commit', '-m', 'Synthetic qualification runner']);
  const runnerRevision = git(['rev-parse', 'HEAD']);
  const plan = productionElectronCandidatePlan({ target: 'linux-x64', sourceRevision,
    buildNumber, hostPlatform: 'linux', hostArchitecture: 'x64' });
  const sourceCandidate = { ...plan, version, builderEnvironment: { ...plan.builderEnvironment, TIBOTATTLE_ELECTRON_VERSION: version },
    status: 'production_source_staged',
    stagedManifest: 'app/package.json', runtimeManifest: 'app/electron-runtime-manifest.json' };
  const intake = { schemaVersion, sourceRevision, runnerRevision, sourceCandidate,
    packageRunId: '12345', packageRunnerRevision: sourceRevision, version, buildNumber,
    sourceCandidateSha256: 'a'.repeat(64), packageReceiptSha256: 'b'.repeat(64), artifactSha256: 'c'.repeat(64),
    artifactBytes: 8192, asarSha256: 'd'.repeat(64), executableSha256: 'e'.repeat(64),
    signedFeed: { file: 'latest-linux.yml', bytes: 3, sha256: hash('abc'), base64: Buffer.from('abc').toString('base64') } };
  const environment = { LINUX_FINAL_INTAKE: JSON.stringify(intake), GITHUB_SHA: runnerRevision, SELECTED_MODE: 'plan', SELECTED_CONFIRMATION: '' };
  assert.deepEqual(preflightLinuxFinalIntake(environment, { repositoryRoot: root }), intake);
  assert.throws(() => preflightLinuxFinalIntake({ ...environment, SELECTED_MODE: 'execute' }, { repositoryRoot: root }), /CONFIRMATION_INVALID/u);
  assert.deepEqual(preflightLinuxFinalIntake({ ...environment, SELECTED_MODE: 'execute', SELECTED_CONFIRMATION: LINUX_FINAL_CONFIRMATION }, { repositoryRoot: root }), intake);
  assert.throws(() => preflightLinuxFinalIntake({ ...environment, GITHUB_SHA: sourceRevision }, { repositoryRoot: root }), /CONFIRMATION_INVALID/u);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app-usagemonitor', type: 'module', version: version === '0.1.27' ? '0.1.28' : '0.1.27' }) + '\n');
  assert.throws(() => preflightLinuxFinalIntake(environment, { repositoryRoot: root }), /VERSION_INVALID/u);
  git(['restore', 'package.json']); git(['checkout', '--orphan', 'unrelated']); git(['add', 'package.json', 'runner']); git(['commit', '-m', 'Unrelated synthetic runner']);
  const unrelated = git(['rev-parse', 'HEAD']);
  assert.throws(() => preflightLinuxFinalIntake({ ...environment, GITHUB_SHA: unrelated,
    LINUX_FINAL_INTAKE: JSON.stringify({ ...intake, runnerRevision: unrelated }) }, { repositoryRoot: root }), /RUNNER_INVALID/u);
});

test('acquisition creates only a safe new owned directory and refuses reuse or parent aliases', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'linux-final-reservation-')); t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await reserveLinuxFinalDirectory(root), join(root, '.release-build/linux-final-qualification'));
  await assert.rejects(reserveLinuxFinalDirectory(root), { code: 'EEXIST' });
  const unsafe = join(root, 'other'); await mkdir(unsafe);
  await symlink(join(root, '.release-build'), join(unsafe, '.release-build'));
  await assert.rejects(reserveLinuxFinalDirectory(unsafe), /PATH_UNSAFE/u);
});

test('packaged authority reads only fixed files at the independently selected candidate commit', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'linux-final-authority-')); t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); assert.equal(result.status, 0); return result.stdout.trim(); };
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Synthetic fixture']); git(['config', 'user.email', 'synthetic@example.test']);
  await mkdir(join(root, 'config'));
  const file = 'config/electron-production-distribution.cjs';
  await writeFile(join(root, file), 'candidate authority\n'); git(['add', file]); git(['commit', '-m', 'Synthetic authority']);
  const sourceRevision = git(['rev-parse', 'HEAD']);
  await writeFile(join(root, file), 'different working authority\n');
  assert.deepEqual(readLinuxFinalCandidateSourceFile(sourceRevision, file, { root }), Buffer.from('candidate authority\n'));
  for (const [revision, selected] of [[sourceRevision, '../outside'], [sourceRevision, 'package.json'], ['HEAD', file],
    [[sourceRevision], file], [123, file], ['f'.repeat(40), file]]) {
    assert.throws(() => readLinuxFinalCandidateSourceFile(revision, selected, { root }), error => error.code === 'LINUX_FINAL_LIFECYCLE_SOURCE_AUTHORITY_INVALID'
      && error.message === error.code && error.cause === undefined);
  }
});

test('final authority reads actual ASAR bytes through the pinned builder dependency', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'linux-final-asar-')); t.after(() => rm(root, { recursive: true, force: true }));
  const require = createRequire(import.meta.url), imported = createRequire(require.resolve('electron-builder'))('@electron/asar');
  const archive = imported.default ?? imported, source = join(root, 'source'), destination = join(root, 'app.asar');
  await mkdir(join(source, 'config'), { recursive: true });
  const file = 'config/electron-production-distribution.cjs', bytes = Buffer.from('synthetic packaged authority\n');
  await writeFile(join(source, file), bytes); await archive.createPackage(source, destination);
  assert.deepEqual(readLinuxFinalPackagedAuthorityFile(destination, file), bytes);
  assert.throws(() => readLinuxFinalPackagedAuthorityFile(destination, '../outside'), /ASAR_IDENTITY_INVALID/u);
  assert.throws(() => readLinuxFinalPackagedAuthorityFile(destination, 'apps/electron/main.js'), /ASAR_IDENTITY_INVALID/u);
});

for (const [kind, description] of [
  ['file_link', 'a final-entry link'],
  ['directory_link', 'an ancestor directory link'],
  ['unpacked', 'an unpacked authority entry'],
  ['oversized', 'an authority entry above the one MiB bound'],
  ['empty', 'an empty authority entry'],
]) test(`final authority rejects ${description} in an actual ASAR without exposing its path`, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'linux-final-unsafe-asar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const require = createRequire(import.meta.url), imported = createRequire(require.resolve('electron-builder'))('@electron/asar');
  const archive = imported.default ?? imported, source = join(root, 'source'), destination = join(root, 'app.asar');
  const file = 'config/electron-production-distribution.cjs';
  const bytes = kind === 'oversized' ? Buffer.alloc(1024 ** 2 + 1, 37)
    : kind === 'empty' ? Buffer.alloc(0) : Buffer.from('synthetic packaged authority\n');
  await mkdir(source);
  if (kind === 'directory_link') {
    await mkdir(join(source, 'authority-config'));
    await writeFile(join(source, 'authority-config/electron-production-distribution.cjs'), bytes);
    await symlink('authority-config', join(source, 'config'));
  } else {
    await mkdir(join(source, 'config'));
    if (kind === 'file_link') {
      await writeFile(join(source, 'authority.cjs'), bytes);
      await symlink('../authority.cjs', join(source, file));
    } else await writeFile(join(source, file), bytes);
  }
  await archive.createPackageWithOptions(source, destination, kind === 'unpacked' ? { unpack: '*.cjs' } : {});
  // Inspect without following links so each fixture proves the intended unsafe
  // archive shape instead of accidentally testing an absent file.
  const entry = archive.statFile(destination, kind === 'directory_link' ? 'config' : file, false);
  if (kind === 'file_link' || kind === 'directory_link') assert.equal(typeof entry.link, 'string');
  else if (kind === 'unpacked') assert.equal(entry.unpacked, true);
  else assert.equal(entry.size, bytes.length);
  assert.throws(() => readLinuxFinalPackagedAuthorityFile(destination, file), error => {
    assert.equal(error.code, 'LINUX_FINAL_LIFECYCLE_ASAR_IDENTITY_INVALID');
    assert.equal(error.message, error.code);
    assert.deepEqual(Object.keys(error), ['code']);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(Object.hasOwn(error, 'path'), false);
    assert.equal(JSON.stringify(error).includes(root), false);
    return true;
  });
});
