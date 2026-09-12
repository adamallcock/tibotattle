import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as runner from '../scripts/smoke-electron-macos-production-update.mjs';
const hash = (b, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(b).digest(encoding);
const fixture = (target = 'darwin-arm64') => ({ schemaVersion: 'tibotattle-production-electron-update-intake-v1',
  target, sourceRevision: 'a'.repeat(40), buildNumber: '2026091106', version: '0.1.21', bundleVersion: '1028',
  dmgSha256: 'b'.repeat(64), asarSha256: 'c'.repeat(64), zipSha256: 'd'.repeat(64), feedSha256: 'e'.repeat(64),
  predecessorAsarSha256: 'f'.repeat(64), directory: '/tmp/qualified-production-update' });
test('only exact confirmed execute can run an installed production update', () => {
  assert.deepEqual(runner.parseProductionUpdateArguments(['--plan', '--intake', '/tmp/input.json']), { execute: false, intakePath: '/tmp/input.json' });
  assert.equal(runner.parseProductionUpdateArguments(['--execute', '--intake', '/tmp/input.json', '--confirm', 'RUN_DISPOSABLE_PRODUCTION_ELECTRON_UPDATE']).execute, true);
  for (const args of [[], ['--execute', '--intake', '/tmp/input.json'], ['--plan', '--intake', 'relative'],
    ['--plan', '--intake', '/tmp/input.json', '--confirm', 'RUN_DISPOSABLE_PRODUCTION_ELECTRON_UPDATE'],
    ['--execute', '--intake', '/tmp/input.json', '--confirm', 'yes']]) assert.throws(() => runner.parseProductionUpdateArguments(args));
});
test('both targets bind immutable 020 and exact 021 identities to fixed stable transport', () => {
  for (const target of ['darwin-arm64', 'darwin-x64']) {
    const input = runner.validateProductionUpdateIntake(fixture(target));
    assert.equal(input.predecessorDmgSha256, runner.ELECTRON_020_DMG[target]);
    assert.equal(input.feedUrl, 'https://updates.tibotattle.com/electron/stable/' + target + '/latest-mac.yml');
    assert.equal(input.predecessorUrl, 'https://github.com/adamallcock/tibotattle/releases/download/v0.1.20/TiboTattle-0.1.20-mac-' + input.architecture + '.dmg');
    assert.equal(input.zipFileName, 'TiboTattle-0.1.21-mac-' + input.architecture + '.zip');
  }
  for (const key of Object.keys(fixture())) { const bad = fixture(); delete bad[key]; assert.throws(() => runner.validateProductionUpdateIntake(bad)); }
  for (const bad of [{ feedUrl: 'https://example.com' }, { feedScope: 'isolated_test_feed' }, { version: '0.1.22' },
    { bundleVersion: '2026091106' }, { sourceRevision: 'main' }, { buildNumber: 1028 }, { target: 'linux-x64' },
    { directory: 'relative' }, { predecessorAsarSha256: 'A'.repeat(64) }]) assert.throws(() => runner.validateProductionUpdateIntake({ ...fixture(), ...bad }));
});
test('live feed must bind both exact artifacts and cannot redirect the updater', () => {
  const zip = Buffer.from('signed ZIP'), dmg = Buffer.from('signed DMG');
  const input = runner.validateProductionUpdateIntake({ ...fixture(), zipSha256: hash(zip), dmgSha256: hash(dmg) });
  const manifest = { version: '0.1.21', files: [[input.zipFileName, zip], [input.dmgFileName, dmg]].map(([url, b]) => ({ url, size: b.length, sha512: hash(b, 'sha512', 'base64') })),
    path: input.zipFileName, sha512: hash(zip, 'sha512', 'base64') };
  assert.equal(runner.validateProductionMacUpdateFeed(input, manifest, zip, dmg), true);
  for (const change of [m => m.version = '0.1.20', m => m.path = '../candidate.zip', m => m.files[0].url = 'https://example.com/candidate.zip',
    m => m.files[0].size++, m => m.files[0].sha512 = m.files[1].sha512, m => m.sha512 = m.files[1].sha512,
    m => m.files.push(m.files[0]), m => m.packages = {}]) {
    const bad = structuredClone(manifest); change(bad); assert.throws(() => runner.validateProductionMacUpdateFeed(input, bad, zip, dmg));
  }
  assert.throws(() => runner.validateProductionMacUpdateFeed(input, manifest, Buffer.from('altered'), dmg));
});
test('plan reads intake only and makes no artifact, feed, process or signed-app acceptance claim', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'production-update-plan-')));
  try {
    const intakePath = join(directory, 'intake.json'); await writeFile(intakePath, JSON.stringify(fixture()), { mode: 0o600 });
    const result = await runner.runProductionUpdate({ execute: false, intakePath });
    assert.equal(result.status, 'planned');
    for (const key of ['productionFeedVerified', 'signedArtifactVerified', 'disposableAccountVerified', 'updaterRelaunchedCandidate', 'candidateCopiedByRunner', 'ownedProcessesStopped']) assert.equal(result[key], false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('runner leaves the signed application and production feed under their actual owners', async () => {
  const source = await readFile(new URL('../scripts/smoke-electron-macos-production-update.mjs', import.meta.url), 'utf8');
  assert.match(source, /copyPredecessor\(predecessorDmg/);
  assert.doesNotMatch(source, /copyPredecessor\(candidate|setFeedURL|--inspect|codesign[^\n]*--sign|process\.env\.[A-Z_]+\s*=/);
  assert.match(source, /assertExtractedSignedMacBundle\(candidateDmg, app/);
  assert.match(source, /verifySparkleTransitionCandidate\(input, app\)/);
  assert.match(source, /installUpdateAndRestart\(\)/);
  assert.match(source, /stopVerifiedMacTransitionProcesses/);
  assert.match(source, /assertSignedReplacementContinuity\(seeded, before/);
});

test('both workflow bodies parse as JavaScript and preserve fixed targets without shell interpolation', async () => {
  const workflow = await readFile(new URL('../.github/workflows/electron-macos-production-update.yml', import.meta.url), 'utf8');
  const scripts = [...workflow.matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)          NODE/g)].map(m => m[1].replace(/^          /gm, ''));
  assert.equal(scripts.length, 2);
  for (const script of scripts) {
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: script, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.match(script, /env\.SELECTED_TARGET/);
    assert.match(script, /env\.SELECTED_RUNNER !== env\.GITHUB_SHA/);
    assert.doesNotMatch(script, /\$\{\{/);
  }
  assert.match(workflow, /runs-on: macos-26-intel/);
  assert.match(workflow, /runs-on: macos-26\n/);
  assert.doesNotMatch(workflow, /contents: write|secrets\.|pull_request_target/);
});
