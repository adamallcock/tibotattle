import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { assertMacOSQualificationIdentity, deriveMacOSQualificationIdentity,
  parseMacOSQualificationEnvelope, preflightMacOSQualification } from '../scripts/lib/electron-macos-qualification-identity.mjs';

const sourceRevision = 'a'.repeat(40);
const identity = { version: '0.1.24', bundleVersion: '1031', buildNumber: '2026091501',
  sourceRevision, target: 'darwin-arm64' };
function receipt(selected = identity) {
  return {
    schemaVersion: 'tibotattle-electron-production-source-candidate-v1', status: 'production_source_staged',
    version: selected.version, buildNumber: selected.buildNumber, sourceRevision: selected.sourceRevision,
    target: selected.target, updateFeed: `https://updates.tibotattle.com/electron/stable/${selected.target}`,
    builderEnvironment: { TIBOTATTLE_ELECTRON_BUILD_NUMBER: selected.buildNumber,
      TIBOTATTLE_ELECTRON_SOURCE_REVISION: selected.sourceRevision, TIBOTATTLE_ELECTRON_TARGET: selected.target,
      TIBOTATTLE_ELECTRON_VERSION: selected.version },
  };
}
const context = selected => ({ sourceCandidate: receipt(selected), sourceRevision: selected.sourceRevision,
  target: selected.target, packageVersion: '0.1.24', sourceVersion: '0.1.24',
  resolveBundleVersion: (version, channel) => version === '0.1.24' && channel === 'stable' ? '1031' : null });

test('future successor derives from package version and reviewed allocation without production hardcoding', () => {
  for (const target of ['darwin-arm64', 'darwin-x64']) {
    const selected = { ...identity, target };
    assert.deepEqual(deriveMacOSQualificationIdentity(context(selected)), selected);
    assert.deepEqual(assertMacOSQualificationIdentity(selected, context(selected)), selected);
    assert.equal(Object.isFrozen(deriveMacOSQualificationIdentity(context(selected))), true);
  }
  assert.throws(() => deriveMacOSQualificationIdentity({ ...context(identity), resolveBundleVersion: () => null }),
    { reason: 'bundle_allocation' });
});

test('stale intake version, allocation, source, build and target fail against independent candidate identity', () => {
  for (const patch of [{ version: '0.1.23' }, { bundleVersion: '1030' }, { bundleVersion: '1031.0' },
    { sourceRevision: 'b'.repeat(40) }, { buildNumber: '2026091401' }, { target: 'darwin-x64' }]) {
    assert.throws(() => assertMacOSQualificationIdentity({ ...identity, ...patch }, context(identity)));
  }
  for (const patch of [{ version: '0.1.23' }, { sourceRevision: 'b'.repeat(40) },
    { buildNumber: '2026091401' }, { target: 'darwin-x64' }, { status: 'planned' },
    { schemaVersion: 'other' }, { rehearsal: null }, { packagingProfile: 'signed_staging' },
    { updateFeed: 'https://invalid.example' }]) {
    assert.throws(() => deriveMacOSQualificationIdentity({ ...context(identity),
      sourceCandidate: { ...receipt(), ...patch } }));
  }
  for (const value of [0, '0', '001', '1e3', '202609150100', null]) {
    const selected = { ...identity, buildNumber: value };
    assert.throws(() => deriveMacOSQualificationIdentity(context(selected)), { reason: 'build_number' });
  }
  for (const key of Object.keys(receipt().builderEnvironment)) {
    const selected = receipt(); selected.builderEnvironment[key] = 'stale';
    assert.throws(() => deriveMacOSQualificationIdentity({ ...context(identity), sourceCandidate: selected }),
      { reason: 'builder_identity' });
  }
  for (const key of Object.keys(identity)) {
    const missing = { ...identity }; delete missing[key];
    assert.throws(() => assertMacOSQualificationIdentity(missing, context(identity)), { reason: key });
  }
  for (const key of Object.keys(receipt())) {
    const missing = receipt(); delete missing[key];
    assert.throws(() => deriveMacOSQualificationIdentity({ ...context(identity), sourceCandidate: missing }));
  }
  const extra = receipt(); extra.builderEnvironment.UNRELATED_OVERRIDE = 'not allowed';
  assert.throws(() => deriveMacOSQualificationIdentity({ ...context(identity), sourceCandidate: extra }), { reason: 'builder_identity' });
  assert.throws(() => deriveMacOSQualificationIdentity({ ...context(identity), sourceVersion: '0.1.23' }), { reason: 'version' });
});

test('source receipt is required, bounded, and stripped without creating qualification claims', () => {
  const envelope = { ...identity, sourceCandidate: receipt() };
  assert.deepEqual(parseMacOSQualificationEnvelope(JSON.stringify(envelope)), { identity, sourceCandidate: receipt() });
  for (const value of [null, '', '{', '[]', 'null', JSON.stringify(identity),
    JSON.stringify({ ...envelope, sourceCandidate: [] }), ' '.repeat(65537)]) {
    assert.throws(() => parseMacOSQualificationEnvelope(value));
  }
  assert.deepEqual(Object.keys(deriveMacOSQualificationIdentity(context(identity))).sort(),
    ['buildNumber', 'bundleVersion', 'sourceRevision', 'target', 'version']);
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'mac-release-admission-'));
  for (const path of ['scripts/lib/electron-macos-qualification-identity.mjs', 'scripts/macos-bundle-version.js',
    'config/electron-production-distribution.cjs', 'config/macos-bundle-version-plan.cjs']) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(new URL(`../${path}`, import.meta.url), join(root, path));
  }
  // A synthetic future allocation exists only in this disposable checkout.
  await writeFile(join(root, 'config/macos-bundle-version-plan.cjs'),
    'module.exports = { SIGNED_MACOS_BUNDLE_VERSION_PLAN: { "0.1.24": { stable: "1031" } } };\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app-usagemonitor', type: 'module', version: '0.1.24' }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' } }).trim();
  git(['init', '--quiet']); git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic future candidate']);
  const revision = git(['rev-parse', 'HEAD']);
  return { root, revision, git };
}

test('all six actual workflow admissions accept a synthetic future release and reject stale inputs before downloads', async t => {
  const fixture = await repository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  for (const [file, lane] of [['electron-macos-empty-profile.yml', 'empty-profile'],
    ['electron-macos-sparkle-transition.yml', 'sparkle'], ['electron-macos-production-update.yml', 'production-update']]) {
    const workflow = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    const admissions = [...workflow.matchAll(/node --input-type=module <<'ADMISSION'\n([\s\S]*?)          ADMISSION/gu)];
    assert.equal(admissions.length, 2, file);
    assert.equal((workflow.match(/fetch-depth: 0/gu) ?? []).length, 2, file);
    assert.equal((workflow.match(/steps\.qualification\.outputs\.identity/gu) ?? []).length, 2, file);
    for (const admission of admissions) {
      const remainder = workflow.slice(admission.index);
      assert.ok(remainder.indexOf('ADMISSION') < remainder.indexOf('      - name: Install '), file);
    }
    for (const [index, target] of ['darwin-arm64', 'darwin-x64'].entries()) {
      const selected = { ...identity, sourceRevision: fixture.revision, target };
      const hashes = { dmgSha256: 'b'.repeat(64), asarSha256: 'c'.repeat(64) };
      const intake = lane === 'sparkle' ? { version: selected.version, bundleVersion: selected.bundleVersion, buildNumber: selected.buildNumber }
        : lane === 'empty-profile' ? { ...selected, runnerRevision: fixture.revision, ...hashes }
          : { ...selected, schemaVersion: 'tibotattle-production-electron-update-intake-v1', ...hashes,
            zipSha256: 'd'.repeat(64), feedSha256: 'e'.repeat(64), predecessorAsarSha256: 'f'.repeat(64) };
      const inputName = lane === 'empty-profile' ? 'EMPTY_PROFILE_INTAKE' : 'SELECTED_IDENTITY';
      const output = join(fixture.root, `admission-${lane}-${target}.txt`);
      const env = { ...process.env, GITHUB_SHA: fixture.revision, GITHUB_OUTPUT: output,
        SELECTED_RUNNER: fixture.revision, SELECTED_SOURCE: fixture.revision, SELECTED_TARGET: target };
      const run = (patch = {}, envPatch = {}, sourceCandidate = receipt(selected)) => execFileSync(process.execPath,
        ['--input-type=module', '-'], { cwd: fixture.root, input: admissions[index][1].replace(/^          /gmu, ''),
          encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...env, [inputName]: JSON.stringify({ ...intake, ...patch, sourceCandidate }), ...envPatch } });
      run();
      assert.equal(await readFile(output, 'utf8'), `identity=${JSON.stringify(intake)}\n`);
      for (const patch of [{ version: '0.1.23' }, { bundleVersion: '1030' }, { buildNumber: '2026091401' },
        { privateUnknownField: 'must not be output' }, { buildNumber: undefined }]) assert.throws(() => run(patch));
      assert.throws(() => run({}, { GITHUB_SHA: 'f'.repeat(40) }));
      assert.throws(() => run({}, {}, receipt({ ...selected, sourceRevision: 'f'.repeat(40) })));
      assert.throws(() => run({}, {}, receipt({ ...selected, buildNumber: '2026091401' })));
      assert.equal(await readFile(output, 'utf8'), `identity=${JSON.stringify(intake)}\n`, 'refusals do not emit intake');
    }
  }
});

test('a descendant qualification runner admits an unchanged frozen candidate at the same package version', async t => {
  const fixture = await repository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const frozenPackage = fixture.git(['show', `${fixture.revision}:package.json`]);
  await writeFile(join(fixture.root, 'qualification-review.txt'), 'Synthetic qualification tooling follow-up only.\n');
  fixture.git(['add', 'qualification-review.txt']);
  fixture.git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic descendant qualification runner']);
  const runnerRevision = fixture.git(['rev-parse', 'HEAD']);
  assert.notEqual(runnerRevision, fixture.revision);
  assert.equal(fixture.git(['show', `${runnerRevision}:package.json`]), frozenPackage);
  for (const target of ['darwin-arm64', 'darwin-x64']) {
    const selected = { ...identity, sourceRevision: fixture.revision, target };
    const frozenReceipt = JSON.stringify(receipt(selected));
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync } from 'node:fs';
      import { preflightMacOSQualification } from './scripts/lib/electron-macos-qualification-identity.mjs';
      const input = JSON.parse(readFileSync(0, 'utf8'));
      process.stdout.write(JSON.stringify({ identity: preflightMacOSQualification(input), sourceCandidate: input.sourceCandidate }));
    `], { cwd: fixture.root, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      input: JSON.stringify({ identity: selected, sourceCandidate: JSON.parse(frozenReceipt),
        runnerRevision, sourceRevision: fixture.revision, target }) });
    const admitted = JSON.parse(result);
    assert.deepEqual(admitted.identity, selected);
    assert.equal(JSON.stringify(admitted.sourceCandidate), frozenReceipt);
    assert.equal(fixture.git(['show', `${fixture.revision}:package.json`]), frozenPackage);
  }
});

test('runner identity, unavailable source and changed manifests fail closed in a real repository', async t => {
  const fixture = await repository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const options = { identity, sourceCandidate: receipt(), repositoryRoot: fixture.root,
    runnerRevision: fixture.revision, sourceRevision, target: identity.target };
  assert.throws(() => preflightMacOSQualification({ ...options, runnerRevision: sourceRevision }), { reason: 'runner_revision' });
  assert.throws(() => preflightMacOSQualification(options), { reason: 'source_checkout' });
  await writeFile(join(fixture.root, 'package.json'), JSON.stringify({ name: 'app-usagemonitor', type: 'module', version: '0.1.23' }));
  assert.throws(() => preflightMacOSQualification({ ...options, sourceRevision: fixture.revision }), { reason: 'package_manifest' });
  fixture.git(['add', 'package.json']);
  fixture.git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic older source package']);
  const older = fixture.git(['rev-parse', 'HEAD']);
  await writeFile(join(fixture.root, 'package.json'), JSON.stringify({ name: 'app-usagemonitor', type: 'module', version: '0.1.24' }));
  fixture.git(['add', 'package.json']);
  fixture.git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic current runner']);
  const selected = { ...identity, sourceRevision: older };
  assert.throws(() => preflightMacOSQualification({ ...options, identity: selected, sourceCandidate: receipt(selected),
    runnerRevision: fixture.git(['rev-parse', 'HEAD']), sourceRevision: older }), { reason: 'version' });
});
