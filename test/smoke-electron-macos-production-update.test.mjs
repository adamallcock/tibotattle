import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm, realpath, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as runner from '../scripts/smoke-electron-macos-production-update.mjs';
import { createProductionDistributionMetadata } from '../apps/electron/desktop-updater.js';
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
test('both targets bind immutable 020 and explicit allocated successors to fixed stable transport', () => {
  for (const target of ['darwin-arm64', 'darwin-x64']) for (const [version, bundleVersion] of [['0.1.22', '1029'], ['0.1.23', '1030']]) {
    const input = runner.validateProductionUpdateIntake({ ...fixture(target), version, bundleVersion });
    assert.equal(input.predecessorDmgSha256, runner.ELECTRON_020_DMG[target]);
    assert.equal(input.feedUrl, 'https://updates.tibotattle.com/electron/stable/' + target + '/latest-mac.yml');
    assert.equal(input.predecessorUrl, 'https://github.com/adamallcock/tibotattle/releases/download/v0.1.20/TiboTattle-0.1.20-mac-' + input.architecture + '.dmg');
    assert.equal(input.zipFileName, 'TiboTattle-' + version + '-mac-' + input.architecture + '.zip');
    assert.equal(input.candidateUrl, 'https://github.com/adamallcock/tibotattle/releases/download/v' + version + '/TiboTattle-' + version + '-mac-' + input.architecture + '.dmg');
  }
  for (const key of Object.keys(fixture())) { const bad = fixture(); delete bad[key]; assert.throws(() => runner.validateProductionUpdateIntake(bad)); }
  for (const bad of [{ feedUrl: 'https://example.com' }, { feedScope: 'isolated_test_feed' }, { version: '0.1.21' }, { version: '0.1.23' },
    { bundleVersion: '2026091106' }, { sourceRevision: 'main' }, { buildNumber: 1029 }, { target: 'linux-x64' },
    { directory: 'relative' }, { predecessorAsarSha256: 'A'.repeat(64) }, { version: '9999.99.99', bundleVersion: '9999' },
    { version: '0.1.23', bundleVersion: '1030.0' }, { version: '0.1.18', bundleVersion: '1026' },
    { version: '0.1.17', bundleVersion: '1024' }, { version: ['0.1.23'], bundleVersion: '1030' },
    { version: '0.1.23', bundleVersion: 1030 }]) assert.throws(() => runner.validateProductionUpdateIntake({ ...fixture(), ...bad }));
});
const currentFixture = (target = 'darwin-arm64') => ({ ...fixture(target),
  schemaVersion: 'tibotattle-production-electron-update-intake-v2', version: '0.1.27',
  buildNumber: '2026100301', bundleVersion: '1035' });
const replacementFixture = (target = 'darwin-arm64') => ({ ...fixture(target),
  schemaVersion: 'tibotattle-production-electron-update-intake-v3', version: '0.1.28',
  buildNumber: '2026100901', bundleVersion: '1036' });
test('v3 binds the replacement identity to unchanged 026 predecessor bytes without widening v2', () => {
  for (const target of ['darwin-arm64', 'darwin-x64']) {
    const old = runner.validateProductionUpdateIntake(currentFixture(target));
    const input = runner.validateProductionUpdateIntake(replacementFixture(target));
    assert.equal(input.predecessorDmgSha256, old.predecessorDmgSha256);
    assert.equal(input.predecessorUrl, old.predecessorUrl);
    assert.equal(input.feedUrl, old.feedUrl);
    assert.equal(input.candidateUrl, 'https://github.com/adamallcock/tibotattle/releases/download/v0.1.28/TiboTattle-0.1.28-mac-' + input.architecture + '.dmg');
    for (const patch of [{ schemaVersion: currentFixture().schemaVersion }, { schemaVersion: 'toString' },
      { schemaVersion: 'tibotattle-production-electron-update-intake-v4' }, { version: '0.1.27', bundleVersion: '1035' },
      { version: '0.1.29', bundleVersion: '1037' }, { bundleVersion: '1035' }, { buildNumber: '2026100301' },
      { buildNumber: '2026100902' }, { feedUrl: 'https://example.invalid/feed.yml' }, { predecessorVersion: '0.1.27' }]) {
      assert.throws(() => runner.validateProductionUpdateIntake({ ...replacementFixture(target), ...patch }));
    }
  }
});

test('v2 binds only the immutable 026 predecessor and 027 successor on both architectures', () => {
  const expected = { 'darwin-arm64': '7b5f66d91c9f1b8c1537505da860c67177d2b489ee6fb90d445d97c7e46cc9ec',
    'darwin-x64': '3806a1ce2650350b69faff759287c08a5f146acfb9c26e3b3b04abb5cf8896c3' };
  for (const target of Object.keys(expected)) {
    const input = runner.validateProductionUpdateIntake(currentFixture(target));
    assert.equal(input.predecessorDmgSha256, expected[target]);
    assert.equal(input.predecessorUrl, 'https://github.com/adamallcock/tibotattle/releases/download/v0.1.26/TiboTattle-0.1.26-mac-' + input.architecture + '.dmg');
    assert.equal(input.candidateUrl, 'https://github.com/adamallcock/tibotattle/releases/download/v0.1.27/TiboTattle-0.1.27-mac-' + input.architecture + '.dmg');
    assert.equal(input.feedUrl, 'https://updates.tibotattle.com/electron/stable/' + target + '/latest-mac.yml');
    const historical = runner.validateProductionUpdateIntake({ ...currentFixture(target), schemaVersion: fixture().schemaVersion });
    assert.equal(historical.predecessorDmgSha256, runner.ELECTRON_020_DMG[target]);
    assert.match(historical.predecessorUrl, /download\/v0\.1\.20\/TiboTattle-0\.1\.20-/u);
  }
  for (const key of Object.keys(currentFixture())) {
    const bad = currentFixture(); delete bad[key]; assert.throws(() => runner.validateProductionUpdateIntake(bad));
  }
  for (const patch of [{ schemaVersion: 'tibotattle-production-electron-update-intake-v3' }, { schemaVersion: 'toString' },
    { version: '0.1.26', bundleVersion: '1034' }, { version: '0.1.28', bundleVersion: '1036' }, { bundleVersion: '1034' },
    { predecessorVersion: '0.1.20' }, { predecessorDmgSha256: runner.ELECTRON_020_DMG['darwin-arm64'] },
    { predecessorUrl: 'https://example.invalid/old.dmg' }, { feedUrl: 'https://example.invalid/feed.yml' },
    { feedScope: 'isolated_test_feed' }, { target: 'linux-x64' }, { predecessorAsarSha256: 'F'.repeat(64) }]) {
    assert.throws(() => runner.validateProductionUpdateIntake({ ...currentFixture(), ...patch }));
  }
});
test('predecessor metadata refuses mixed source, build, bundle, architecture and historical version identities', () => {
  for (const target of ['darwin-arm64', 'darwin-x64']) for (const make of [fixture, currentFixture, replacementFixture]) {
    const legacy = make === fixture;
    const input = runner.validateProductionUpdateIntake(make(target));
    const predecessor = legacy ? { version: '0.1.20', sourceRevision: runner.ELECTRON_020_SOURCE,
      buildNumber: '2026091104', bundleVersion: '2026091104' }
      : { version: '0.1.26', sourceRevision: 'acfc385c95b49b8e1040cedfa857659b49a61d8d', buildNumber: '2026092701', bundleVersion: '1034' };
    const pkg = { name: 'app-usagemonitor', version: predecessor.version,
      tibotattleDistribution: createProductionDistributionMetadata({ ...predecessor, target }) };
    const plist = { CFBundleIdentifier: 'com.usagemonitor.local', CFBundleShortVersionString: predecessor.version,
      CFBundleVersion: predecessor.bundleVersion };
    assert.deepEqual(runner.validateProductionUpdatePredecessorMetadata(input, pkg, plist), pkg.tibotattleDistribution);
    for (const change of [p => p.name = 'unrelated-app', p => p.version = legacy ? '0.1.26' : '0.1.20',
      p => p.tibotattleDistribution.sourceRevision = 'b'.repeat(40), p => p.tibotattleDistribution.buildNumber = '2026091106',
      p => p.tibotattleDistribution.target = target === 'darwin-arm64' ? 'darwin-x64' : 'darwin-arm64',
      p => p.tibotattleDistribution.channel = 'preview', p => p.tibotattleDistribution.updateFeed = 'https://example.invalid']) {
      const bad = structuredClone(pkg); change(bad);
      assert.throws(() => runner.validateProductionUpdatePredecessorMetadata(input, bad, plist));
    }
    for (const patch of [{ CFBundleIdentifier: 'unrelated-app' }, { CFBundleShortVersionString: '0.1.22' },
      { CFBundleVersion: legacy ? '1034' : '2026092701' }]) {
      assert.throws(() => runner.validateProductionUpdatePredecessorMetadata(input, pkg, { ...plist, ...patch }));
    }
    assert.throws(() => runner.validateProductionUpdatePredecessorMetadata(
      runner.validateProductionUpdateIntake(legacy ? currentFixture(target) : fixture(target)), pkg, plist));
  }
});
test('live feed must bind both exact artifacts and cannot redirect the updater', () => {
  for (const [version, bundleVersion] of [['0.1.22', '1029'], ['0.1.23', '1030'], ['0.1.27', '1035'], ['0.1.28', '1036']]) {
    const zip = Buffer.from('signed ZIP'), dmg = Buffer.from('signed DMG');
    const input = runner.validateProductionUpdateIntake({ ...(version === '0.1.28' ? replacementFixture() : version === '0.1.27' ? currentFixture() : fixture()), version, bundleVersion, zipSha256: hash(zip), dmgSha256: hash(dmg) });
    const manifest = { version, files: [[input.zipFileName, zip], [input.dmgFileName, dmg]].map(([url, b]) => ({ url, size: b.length, sha512: hash(b, 'sha512', 'base64') })),
      path: input.zipFileName, sha512: hash(zip, 'sha512', 'base64') };
    assert.equal(runner.validateProductionMacUpdateFeed(input, manifest, zip, dmg), true);
    for (const change of [m => m.version = version === '0.1.23' ? '0.1.22' : '0.1.23', m => m.path = '../candidate.zip', m => m.files[0].url = 'https://example.com/candidate.zip',
      m => m.files[0].size++, m => m.files[0].sha512 = m.files[1].sha512, m => m.sha512 = m.files[1].sha512,
      m => m.files.push(m.files[0]), m => m.packages = {}]) {
      const bad = structuredClone(manifest); change(bad); assert.throws(() => runner.validateProductionMacUpdateFeed(input, bad, zip, dmg));
    }
    assert.throws(() => runner.validateProductionMacUpdateFeed(input, manifest, Buffer.from('altered'), dmg));
  }
});
test('plan reads intake only and makes no artifact, feed, process or signed-app acceptance claim', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'production-update-plan-')));
  try {
    const identity = { ...fixture(), version: '0.1.23', bundleVersion: '1030', buildNumber: '2026091301' };
    const intakePath = join(directory, 'intake.json'); await writeFile(intakePath, JSON.stringify(identity), { mode: 0o600 });
    const result = await runner.runProductionUpdate({ execute: false, intakePath });
    assert.equal(result.status, 'planned');
    for (const key of ['sourceRevision', 'version', 'bundleVersion', 'buildNumber']) assert.equal(result[key], identity[key]);
    for (const key of ['productionFeedVerified', 'signedArtifactVerified', 'disposableAccountVerified', 'updaterRelaunchedCandidate', 'candidateCopiedByRunner', 'ownedProcessesStopped']) assert.equal(result[key], false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
for (const [make, schema] of [[currentFixture, runner.ELECTRON_PRODUCTION_UPDATE_SCHEMA_V2],
  [replacementFixture, runner.ELECTRON_PRODUCTION_UPDATE_SCHEMA_V3]]) test(`${schema} plan retains unqualified native and credential assertions`, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'production-update-plan-v2-')));
  try {
    for (const target of ['darwin-arm64', 'darwin-x64']) {
      const identity = make(target), intakePath = join(directory, target + '.json');
      await writeFile(intakePath, JSON.stringify(identity), { mode: 0o600 });
      const result = await runner.runProductionUpdate({ execute: false, intakePath });
      assert.equal(result.status, 'planned');
      assert.equal(result.schemaVersion, schema);
      for (const key of ['version', 'buildNumber', 'bundleVersion', 'sourceRevision']) assert.equal(result[key], identity[key]);
      assert.equal(result.predecessorVersion, '0.1.26');
      assert.equal(result.predecessorSourceRevision, 'acfc385c95b49b8e1040cedfa857659b49a61d8d');
      assert.equal(result.predecessorBuildNumber, '2026092701');
      assert.equal(result.predecessorBundleVersion, '1034');
      assert.equal(result.predecessorProcessesExitedNaturally, false);
      for (const key of ['productionFeedVerified', 'signedArtifactVerified', 'disposableAccountVerified',
        'updaterRelaunchedCandidate', 'candidateCopiedByRunner', 'ownedProcessesStopped', 'existingCredentialFixture', 'feedOverrideApplied']) {
        assert.equal(result[key], false, key);
      }
    }
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

test('v2 requires every old process identity to exit before successor acceptance', () => {
  const executable = '/qualified/TiboTattle.app/Contents/MacOS/TiboTattle', helper = '/qualified/companion';
  const startedAt = 'Sun Oct 4 02:00:00 2026';
  const row = (pid, parent, command = executable, start = startedAt) => ({ pid, parent, group: pid, command, startedAt: start });
  const old = new Map([[100, executable + '\n' + startedAt], [101, helper + '\n' + startedAt]]);
  const select = rows => runner.selectCurrentProductionUpdateSuccessor(rows, executable, 100, old);
  assert.equal(select([row(100, 1), row(200, 1)]), null, 'old main still alive');
  assert.equal(select([row(101, 1, helper), row(200, 1)]), null, 'orphaned old companion still alive');
  assert.equal(select([row(101, 1, '/qualified/exec-replacement'), row(200, 1)]), null,
    'exec does not retire the same PID and start-time identity');
  assert.equal(select([row(101, 1, helper, null), row(200, 1)]), null, 'unknown start time is not proof of exit');
  assert.equal(select([row(200, 1), row(201, 200)]).pid, 200);
  assert.equal(select([row(101, 1, helper, 'Sun Oct 4 03:00:00 2026'), row(200, 1)]).pid, 200,
    'reused PID with a different start time is not the captured predecessor');
  assert.equal(select([row(100, 1, executable, 'Sun Oct 4 03:00:00 2026')]), null,
    'a previously captured PID never becomes the accepted successor');
  assert.throws(() => select([row(200, 1), row(300, 1)]), 'independent new roots remain ambiguous');
  for (const processes of [new Set([100]), new Map(), new Map([[100, null]]), new Map([[100, executable + '\n']])]) {
    assert.throws(() => runner.selectCurrentProductionUpdateSuccessor([row(200, 1)], executable, 100, processes));
  }
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
