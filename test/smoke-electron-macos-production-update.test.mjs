import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm, realpath, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as runner from '../scripts/smoke-electron-macos-production-update.mjs';
const hash = (b, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(b).digest(encoding);
const fixture = (target = 'darwin-arm64') => ({ schemaVersion: 'tibotattle-production-electron-update-intake-v1',
  target, sourceRevision: 'a'.repeat(40), buildNumber: '2026091106', version: '0.1.22', bundleVersion: '1029',
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
    assert.equal(input.zipFileName, 'TiboTattle-0.1.22-mac-' + input.architecture + '.zip');
  }
  for (const key of Object.keys(fixture())) { const bad = fixture(); delete bad[key]; assert.throws(() => runner.validateProductionUpdateIntake(bad)); }
  for (const bad of [{ feedUrl: 'https://example.com' }, { feedScope: 'isolated_test_feed' }, { version: '0.1.21' }, { version: '0.1.23' },
    { bundleVersion: '2026091106' }, { sourceRevision: 'main' }, { buildNumber: 1029 }, { target: 'linux-x64' },
    { directory: 'relative' }, { predecessorAsarSha256: 'A'.repeat(64) }]) assert.throws(() => runner.validateProductionUpdateIntake({ ...fixture(), ...bad }));
});
test('live feed must bind both exact artifacts and cannot redirect the updater', () => {
  const zip = Buffer.from('signed ZIP'), dmg = Buffer.from('signed DMG');
  const input = runner.validateProductionUpdateIntake({ ...fixture(), zipSha256: hash(zip), dmgSha256: hash(dmg) });
  const manifest = { version: '0.1.22', files: [[input.zipFileName, zip], [input.dmgFileName, dmg]].map(([url, b]) => ({ url, size: b.length, sha512: hash(b, 'sha512', 'base64') })),
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
  assert.match(workflow, /acceptance_x64:[\s\S]*?runs-on: macos-15-intel\n/);
  assert.doesNotMatch(workflow, /runs-on: macos-26-intel/);
  assert.match(workflow, /runs-on: macos-26\n/);
  assert.doesNotMatch(workflow, /contents: write|secrets\.|pull_request_target/);
});

test('failure classification emits fixed content-free fields and preserves command versus file failures', () => {
  assert.deepEqual(runner.classifyProductionUpdateFailure({code:'ENOENT',message:'/private/path',stderr:'secret'}),
    {code:'ENOENT',exitCode:null,signal:null,kind:'system_error'});
  assert.deepEqual(runner.classifyProductionUpdateFailure({status:1,cmd:'private command'}),
    {code:null,exitCode:1,signal:null,kind:'command_exit'});
  assert.deepEqual(runner.classifyProductionUpdateFailure({signal:'SIGKILL'}),
    {code:null,exitCode:null,signal:'SIGKILL',kind:'command_signal'});
  assert.deepEqual(runner.classifyProductionUpdateFailure({code:'/secret',status:'1',signal:'private'}),
    {code:null,exitCode:null,signal:null,kind:'unclassified'});
});

test('updater successor excludes an orphaned old companion but keeps new main and descendant semantics', () => {
  const executable = '/qualified/TiboTattle.app/Contents/MacOS/TiboTattle';
  const row = (pid, parent, command = executable) => ({pid, parent, group:pid, command});
  const old = new Set([100, 101]);
  assert.equal(runner.selectProductionUpdateSuccessor([row(100,1), row(101,100)], executable, 100, old), null);
  // This was incorrectly accepted as a new main solely because PID101 != PID100.
  assert.equal(runner.selectProductionUpdateSuccessor([row(101,1)], executable, 100, old), null);
  const successor = runner.selectProductionUpdateSuccessor([row(101,1),row(200,1),row(201,200)], executable,100,old);
  assert.equal(successor.pid,200);
  // No successor is admitted while the old main remains alive.
  assert.equal(runner.selectProductionUpdateSuccessor([row(100,1),row(200,1)],executable,100,old),null);
  // Unknown independent roots remain ambiguous; they are not ignored for a green result.
  assert.throws(() => runner.selectProductionUpdateSuccessor([row(101,1),row(200,1),row(300,1)],executable,100,old));
  assert.throws(() => runner.selectProductionUpdateSuccessor([row(200,1)],executable,100,new Set()));
});

test('replacement verification refreshes the real ASAR path cache after an updater swaps bytes', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'production-asar-replacement-')));
  const app = join(directory, 'TiboTattle.app'), resource = join(app, 'Contents', 'Resources');
  const archive = join(resource, 'app.asar');
  const req = createRequire(import.meta.url), loaded = createRequire(req.resolve('electron-builder'))('@electron/asar');
  const api = loaded.default ?? loaded;
  try {
    await mkdir(resource, { recursive: true });
    for (const [version, padding] of [['0.1.20', 'old'], ['0.1.22', 'new'.repeat(200)]]) {
      const source = join(directory, version); await mkdir(source);
      await writeFile(join(source, 'a.txt'), padding);
      await writeFile(join(source, 'package.json'), JSON.stringify({name:'app-usagemonitor',version}));
      await api.createPackage(source, join(directory, version + '.asar'));
    }
    await copyFile(join(directory, '0.1.20.asar'), archive);
    assert.equal(JSON.parse(api.extractFile(archive,'package.json').toString()).version, '0.1.20');
    await copyFile(join(directory, '0.1.22.asar'), archive);
    // Cached offsets refer to the predecessor, although the entire file was replaced.
    assert.throws(() => JSON.parse(api.extractFile(archive,'package.json').toString()));
    const signedBytesBefore = hash(await readFile(archive));
    runner.refreshProductionUpdateArchiveIndex(app);
    assert.equal(JSON.parse(api.extractFile(archive,'package.json').toString()).version, '0.1.22');
    assert.equal(hash(await readFile(archive)), signedBytesBefore);
  } finally { api.uncache(archive); await rm(directory, { recursive:true, force:true }); }
});
