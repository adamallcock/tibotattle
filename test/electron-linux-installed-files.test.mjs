// POSIX/Python archive boundary; invoked explicitly by the native Linux lane.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, link, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fingerprintLinuxFinalFile, LINUX_FINAL_ZIP_EXTRACTOR, reserveLinuxFinalDirectory } from '../scripts/qualify-electron-linux-installed-lifecycle.mjs';
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

test('runner admission proves ancestry and same-version source while plan mode cannot imply execution', async t => {
  const { preflightLinuxFinalIntake, LINUX_FINAL_SCHEMA, LINUX_FINAL_CONFIRMATION } = await import('../scripts/lib/linux-final-artifact-intake.mjs');
  const { productionElectronCandidatePlan } = await import('../scripts/package-electron-production.mjs');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'linux-final-ancestry-')); t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.equal(result.status, 0); return result.stdout.trim();
  };
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Synthetic fixture']); git(['config', 'user.email', 'synthetic@example.test']);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app-usagemonitor', type: 'module', version: '0.1.27' }) + '\n');
  git(['add', 'package.json']); git(['commit', '-m', 'Synthetic frozen application']); const sourceRevision = git(['rev-parse', 'HEAD']);
  await writeFile(join(root, 'runner'), 'qualification only'); git(['add', 'runner']); git(['commit', '-m', 'Synthetic qualification runner']);
  const runnerRevision = git(['rev-parse', 'HEAD']);
  const sourceCandidate = { ...productionElectronCandidatePlan({ target: 'linux-x64', sourceRevision,
    buildNumber: '2026100301', hostPlatform: 'linux', hostArchitecture: 'x64' }), status: 'production_source_staged',
    stagedManifest: 'app/package.json', runtimeManifest: 'app/electron-runtime-manifest.json' };
  const intake = { schemaVersion: LINUX_FINAL_SCHEMA, sourceRevision, runnerRevision, sourceCandidate,
    packageRunId: '12345', packageRunnerRevision: sourceRevision, version: '0.1.27', buildNumber: '2026100301',
    sourceCandidateSha256: 'a'.repeat(64), packageReceiptSha256: 'b'.repeat(64), artifactSha256: 'c'.repeat(64),
    artifactBytes: 8192, asarSha256: 'd'.repeat(64), executableSha256: 'e'.repeat(64) };
  const environment = { LINUX_FINAL_INTAKE: JSON.stringify(intake), GITHUB_SHA: runnerRevision, SELECTED_MODE: 'plan', SELECTED_CONFIRMATION: '' };
  assert.deepEqual(preflightLinuxFinalIntake(environment, { repositoryRoot: root }), intake);
  assert.throws(() => preflightLinuxFinalIntake({ ...environment, SELECTED_MODE: 'execute' }, { repositoryRoot: root }), /CONFIRMATION_INVALID/u);
  assert.deepEqual(preflightLinuxFinalIntake({ ...environment, SELECTED_MODE: 'execute', SELECTED_CONFIRMATION: LINUX_FINAL_CONFIRMATION }, { repositoryRoot: root }), intake);
  assert.throws(() => preflightLinuxFinalIntake({ ...environment, GITHUB_SHA: sourceRevision }, { repositoryRoot: root }), /CONFIRMATION_INVALID/u);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app-usagemonitor', type: 'module', version: '0.1.28' }) + '\n');
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
