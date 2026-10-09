import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm, realpath, mkdir, copyFile, readdir, lstat, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as runner from '../scripts/smoke-electron-macos-production-update.mjs';
import { createProductionDistributionMetadata } from '../apps/electron/desktop-updater.js';
import { seedSignedReplacementNativeState, readSignedReplacementState,
  assertSignedReplacementContinuity } from '../scripts/smoke-electron-macos-replacement.mjs';
import * as currentIndex from '../src/local-unified-index.js';
import { openLocalUnifiedIndex } from '../src/local-unified-index.js';
import { ingestLocalUnifiedIndexIncrement } from '../src/local-unified-index-ingest.js';
import { extractRolloutUsage, rolloutContentQuarantineReason } from '../src/local-unified-index-extract.js';
import { inspectLocalOnboarding } from '../src/local-installation-diagnostics.js';
import { localCodexLogScanner } from '../src/local-node-runtime.js';
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
test('launch substages survive through the existing failure field without emitting arbitrary diagnostics', () => {
  for (const stage of ['predecessor_baseline', 'controlled_restart']) {
    assert.equal(runner.productionUpdateFailureStage({ signedLaunchStage: 'dashboard_target', stage: '/private/path' }, stage),
      stage + '_dashboard_target');
    assert.equal(runner.productionUpdateFailureStage({ signedLaunchStage: '/private/path', stage: 'startup' }, stage), stage);
  }
  assert.equal(runner.productionUpdateFailureStage({ signedLaunchStage: 'dashboard_target' }, 'fixed_production_feed'), 'fixed_production_feed');
  assert.equal(runner.productionUpdateFailureStage({ updateStage: 'production_feed_digest' }, 'fixed_production_feed'), 'production_feed_digest');
  assert.equal(runner.productionUpdateFailureStage({ transitionStage: 'process_identity' }, 'successor_process_capture'), 'process_identity');
  for (const replacementStage of ['database_integrity', 'retained_state_changed', 'preferences_changed', 'opt_out_changed',
    'unsafe_path', 'unsafe_file', 'changed_file']) {
    assert.equal(runner.productionUpdateFailureStage({ replacementStage }, 'successor_continuity'),
      'successor_continuity_' + replacementStage);
  }
  assert.equal(runner.productionUpdateFailureStage({ replacementStage: '/private/secret', message: 'private row' }, 'successor_state_read'),
    'successor_state_read');
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

const fixtureIndexSource = `import { value } from './fixture-value.js';
export const openLocalUnifiedIndex = () => value;
export const createUnifiedIndexWriter = () => {};
export const outcomeOrdinal = () => 0;
export const reasoningEffortOrdinal = () => 0;
export const readLocalUnifiedIndexCompatibility = () => {};
export const moduleUrl = import.meta.url;
`;
async function predecessorArchiveFixture(t, { source = fixtureIndexSource,
  ingest = 'export const ingestLocalUnifiedIndexIncrement = () => "pinned ingestion";', link = false, unpacked = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'production-predecessor-api-')));
  const app = join(directory, 'TiboTattle.app'), archive = join(app, 'Contents', 'Resources', 'app.asar');
  const tree = join(directory, 'source');
  const req = createRequire(import.meta.url), loaded = createRequire(req.resolve('electron-builder'))('@electron/asar');
  const api = loaded.default ?? loaded;
  t.after(async () => { api.uncache(archive); await rm(directory, { recursive: true, force: true }); });
  await mkdir(dirname(archive), { recursive: true });
  await mkdir(join(tree, 'src'), { recursive: true });
  await writeFile(join(tree, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(join(tree, 'src', 'local-unified-index.js'), source);
  await writeFile(join(tree, 'src', 'local-unified-index-ingest.js'), ingest);
  await writeFile(join(tree, 'src', 'fixture-value.js'), 'export const value = "pinned predecessor";');
  if (link) await symlink('fixture-value.js', join(tree, 'src', 'fixture-link.js'));
  if (unpacked) await writeFile(join(tree, 'native.node'), 'unbound native bytes');
  await api.createPackageWithOptions(tree, archive, unpacked ? { unpack: '*.node' } : {});
  const input = { directory, predecessorAsarSha256: hash(await readFile(archive)) };
  return { directory, app, archive, input };
}
const scratchNames = async directory => (await readdir(directory)).filter(name => name.startsWith('predecessor-index-'));

test('predecessor API loads exact packed archive bytes with private permissions and removes owned scratch', async t => {
  const { directory, app, archive, input } = await predecessorArchiveFixture(t, { unpacked: true });
  const before = await readFile(archive);
  const result = await runner.withProductionUpdatePredecessorIndex(input, app, async index => {
    const module = fileURLToPath(index.moduleUrl), extracted = dirname(dirname(module));
    assert.equal(index.openLocalUnifiedIndex(), 'pinned predecessor');
    assert.equal((await lstat(module)).mode & 0o777, 0o600);
    assert.equal((await lstat(extracted)).mode & 0o777, 0o700);
    assert.equal((await lstat(dirname(extracted))).mode & 0o777, 0o700);
    assert.deepEqual(await readFile(join(dirname(extracted), 'predecessor.asar')), before);
    await assert.rejects(lstat(join(extracted, 'native.node')), { code: 'ENOENT' });
    assert.equal((await scratchNames(directory)).length, 1);
    return 'accepted';
  });
  assert.equal(result, 'accepted');
  assert.deepEqual(await readFile(archive), before);
  assert.deepEqual(await scratchNames(directory), []);
});

test('only v3 loads and requires the verified predecessor public ingestion API', async t => {
  const valid = await predecessorArchiveFixture(t);
  const result = await runner.withProductionUpdatePredecessorIndex({ ...valid.input,
    schemaVersion: 'tibotattle-production-electron-update-intake-v3' }, valid.app, (_index, ingest) => ingest());
  assert.equal(result, 'pinned ingestion');
  assert.deepEqual(await scratchNames(valid.directory), []);
  const missing = await predecessorArchiveFixture(t, { ingest: 'export const unrelated = true;' });
  await assert.rejects(runner.withProductionUpdatePredecessorIndex({ ...missing.input,
    schemaVersion: 'tibotattle-production-electron-update-intake-v3' }, missing.app, () => assert.fail('not admitted')),
  error => error.updateStage === 'predecessor_fixture_api');
  for (const schemaVersion of ['tibotattle-production-electron-update-intake-v1', 'tibotattle-production-electron-update-intake-v2']) {
    await runner.withProductionUpdatePredecessorIndex({ ...missing.input, schemaVersion }, missing.app, (_index, ingest) => assert.equal(ingest, null));
  }
  assert.deepEqual(await scratchNames(missing.directory), []);
});

test('retained-source fixture uses real ingestion and leaves one discoverable content-free zero-usage rollout', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'production-retained-fixture-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codexHome = join(directory, 'codex'), native = join(directory, 'native');
  await mkdir(codexHome, { mode: 0o700 });
  await mkdir(join(codexHome, 'sessions'), { mode: 0o700 });
  const passes = [];
  const seeded = await runner.seedProductionUpdateRetainedNativeState(native, codexHome, currentIndex, async options => {
    const result = await ingestLocalUnifiedIndexIncrement(options);
    passes.push(result);
    return result;
  });
  assert.equal(seeded.usageRows, 2);
  assert.equal(seeded.quotaRows, 2);
  assert.equal(seeded.tokensInUncached, 203);
  assert.deepEqual(passes.map(result => [result.generation.status, result.generation.discoveredSourceCount,
    result.generation.indexedSourceCount, result.generation.usageEvents, result.generation.quotaOccurrences]),
  [['complete', 2, 2, 2, 2], ['complete', 1, 2, 2, 2]]);
  const onboarding = await inspectLocalOnboarding({ codexHome, stateRoot: native });
  assert.equal(onboarding.status, 'ready');
  assert.equal(onboarding.source.rolloutFilesPresent, true);
  assert.equal(onboarding.source.rolloutFilesObserved, 1);
  const infos = await localCodexLogScanner.discoverCodexRolloutInfos({ codexHome, startAt: '1970-01-01T00:00:00.000Z' });
  assert.equal(infos.length, 1);
  const names = await readdir(join(codexHome, 'sessions'));
  assert.deepEqual(names, ['rollout-2026-08-01T00-00-00-22222222-2222-4222-8222-222222222222.jsonl']);
  const source = join(codexHome, 'sessions', names[0]), content = await readFile(source, 'utf8');
  assert.equal(content, JSON.stringify({ timestamp: '2026-08-01T00:00:00.000Z', type: 'session_meta',
    payload: { id: '22222222-2222-4222-8222-222222222222' } }) + '\n');
  assert.equal((await lstat(source)).mode & 0o777, 0o600);
  const events = [], boundaries = [], tools = [];
  const extracted = await extractRolloutUsage(source, { size: Buffer.byteLength(content),
    onEvent: event => events.push(event), onBoundary: event => boundaries.push(event), onTool: event => tools.push(event) });
  assert.equal(extracted.diagnostics.sessionMetaRecords, 1);
  assert.equal(rolloutContentQuarantineReason(extracted), null);
  assert.deepEqual({ events, boundaries, tools }, { events: [], boundaries: [], tools: [] });
  for (let pass = 0; pass < 2; pass += 1) {
    const result = await ingestLocalUnifiedIndexIncrement({ codexHome, indexFile: join(native, 'local-unified-index-v1.sqlite'),
      secretFile: join(native, 'local-unified-index-device-salt-v1'), contractVersion: 'telemetry-contribution-v0.1' });
    assert.equal(result.unchanged, true);
    assert.equal(result.insertedUsageEvents, 0);
    assert.deepEqual(await readSignedReplacementState(native), seeded);
  }
  await assert.rejects(runner.seedProductionUpdateRetainedNativeState(native, codexHome, currentIndex, ingestLocalUnifiedIndexIncrement), { code: 'EEXIST' });
  assert.equal(await readFile(source, 'utf8'), content);
  assert.deepEqual(await readSignedReplacementState(native), seeded);
});

test('retained-source fixture refuses unsafe directories and never retires a changed usage source', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'production-retained-refusal-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codexHome = join(directory, 'codex'), sessions = join(codexHome, 'sessions'), native = join(directory, 'native');
  await mkdir(codexHome, { mode: 0o700 }); await mkdir(sessions, { mode: 0o700 });
  await chmod(sessions, 0o755);
  await assert.rejects(runner.seedProductionUpdateRetainedNativeState(native, codexHome, currentIndex, ingestLocalUnifiedIndexIncrement),
    error => error.updateStage === 'predecessor_fixture_location');
  await assert.rejects(lstat(native), { code: 'ENOENT' });
  await chmod(sessions, 0o700);
  let changed;
  await assert.rejects(runner.seedProductionUpdateRetainedNativeState(native, codexHome, currentIndex, async options => {
    const result = await ingestLocalUnifiedIndexIncrement(options);
    changed = join(sessions, (await readdir(sessions)).find(name => name.includes('11111111')));
    await writeFile(changed, 'changed synthetic source\n');
    return result;
  }), error => error.updateStage === 'predecessor_fixture_source');
  assert.equal(await readFile(changed, 'utf8'), 'changed synthetic source\n');
});

test('predecessor scratch is removed when baseline observation or API admission fails', async t => {
  const good = await predecessorArchiveFixture(t);
  const interrupted = new Error('synthetic baseline interruption');
  await assert.rejects(runner.withProductionUpdatePredecessorIndex(good.input, good.app, async () => { throw interrupted; }),
    error => error === interrupted);
  assert.deepEqual(await scratchNames(good.directory), []);
  const missing = await predecessorArchiveFixture(t, { source: 'export const openLocalUnifiedIndex = () => {};' });
  await assert.rejects(runner.withProductionUpdatePredecessorIndex(missing.input, missing.app, () => assert.fail('not admitted')),
    error => error.updateStage === 'predecessor_fixture_api');
  assert.deepEqual(await scratchNames(missing.directory), []);
  const compatibility = await predecessorArchiveFixture(t, {
    source: fixtureIndexSource.replace('export const readLocalUnifiedIndexCompatibility = () => {};\n', ''),
  });
  await assert.rejects(runner.withProductionUpdatePredecessorIndex({ ...compatibility.input,
    schemaVersion: 'tibotattle-production-electron-update-intake-v3' }, compatibility.app, () => assert.fail('not admitted')),
  error => error.updateStage === 'predecessor_fixture_api');
  assert.deepEqual(await scratchNames(compatibility.directory), []);
  const dependency = await predecessorArchiveFixture(t, { source: "import './absent.js';\n" + fixtureIndexSource });
  await assert.rejects(runner.withProductionUpdatePredecessorIndex(dependency.input, dependency.app, () => assert.fail('not admitted')),
    { code: 'ERR_MODULE_NOT_FOUND' });
  assert.deepEqual(await scratchNames(dependency.directory), []);
});

test('predecessor extraction refuses digest drift, linked paths, archive links and writable scratch parents', async t => {
  const fixture = await predecessorArchiveFixture(t);
  const callback = () => assert.fail('unsafe predecessor must never be imported');
  await assert.rejects(runner.withProductionUpdatePredecessorIndex({ ...fixture.input, predecessorAsarSha256: '0'.repeat(64) }, fixture.app, callback),
    error => error.updateStage === 'predecessor_asar');
  assert.deepEqual(await scratchNames(fixture.directory), []);
  const linked = join(fixture.directory, 'linked'); await symlink(fixture.directory, linked);
  await assert.rejects(runner.withProductionUpdatePredecessorIndex({ ...fixture.input, directory: linked }, fixture.app, callback),
    error => error.updateStage === 'unsafe_path');
  await chmod(fixture.directory, 0o777);
  try {
    await assert.rejects(runner.withProductionUpdatePredecessorIndex(fixture.input, fixture.app, callback),
      error => error.updateStage === 'predecessor_fixture_location');
  } finally { await chmod(fixture.directory, 0o700); }
  const archiveLink = await predecessorArchiveFixture(t, { link: true });
  await assert.rejects(runner.withProductionUpdatePredecessorIndex(archiveLink.input, archiveLink.app, callback),
    error => error.updateStage === 'predecessor_fixture_archive');
  assert.deepEqual(await scratchNames(archiveLink.directory), []);
});

const successorPid = 200, successorCommand = '/synthetic/TiboTattle.app/Contents/MacOS/TiboTattle';
const successorStartedAt = 'Mon Oct 12 01:02:03 2026';
const successorFingerprint = successorCommand + '\n' + successorStartedAt;
const successorProcess = () => [{ pid: successorPid, command: successorCommand, startedAt: successorStartedAt }];
const predecessorCompatibility = { applicationId: 1431131465, userVersion: 11, formatUserVersion: 11,
  minimumReaderUserVersion: 11, minimumWriterUserVersion: 11, metadataPresent: true,
  metadataPartial: false, metadataMalformed: false };
function newerStateError(patch = {}) {
  return Object.assign(new Error('local_unified_index_schema_newer'), { code: 'local_unified_index_schema_newer',
    compatibility: { accessMode: 'read', supportedUserVersion: 11, databaseUserVersion: 12, formatUserVersion: 12,
      minimumReaderUserVersion: 12, minimumWriterUserVersion: 12, requiredUserVersion: 12, ...patch } });
}
function predecessorProbe({ compatibility = predecessorCompatibility, schema = 'local-unified-index-v2', integrity = 'ok' } = {}) {
  const observations = { opens: [], closes: 0 };
  return { observations,
    openLocalUnifiedIndex(_path, options) {
      observations.opens.push(options);
      return { close() { observations.closes++; }, prepare(sql) {
        if (sql === "SELECT value FROM meta WHERE key = 'schema_version'") return { get: () => ({ value: schema }) };
        assert.equal(sql, 'PRAGMA quick_check');
        return { get: () => ({ quick_check: integrity }) };
      } };
    },
    readLocalUnifiedIndexCompatibility() { return compatibility; },
  };
}
async function successorStateFixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'production-successor-state-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateRoot = join(directory, 'synthetic-state');
  const before = await seedSignedReplacementNativeState(stateRoot, join(directory, 'synthetic-codex'));
  return { stateRoot, before, database: join(stateRoot, 'local-unified-index-v1.sqlite') };
}

test('only exact predecessor v11 with intact compatibility metadata is pending, through read-only handles', async () => {
  const predecessor = predecessorProbe();
  assert.equal(await runner.readProductionUpdateSuccessorState('/synthetic/state', predecessor), null);
  assert.deepEqual(predecessor.observations, { opens: [{ readOnly: true }], closes: 1 });
  for (const patch of [{ applicationId: 0 }, { userVersion: 10 }, { userVersion: 12 }, { formatUserVersion: 10 },
    { minimumReaderUserVersion: 10 }, { minimumWriterUserVersion: 12 }, { metadataPresent: false },
    { metadataPartial: true }, { metadataMalformed: true }]) {
    const bad = predecessorProbe({ compatibility: { ...predecessorCompatibility, ...patch } });
    await assert.rejects(runner.readProductionUpdateSuccessorState('/synthetic/state', bad),
      error => error.updateStage === 'successor_state_schema');
    assert.equal(bad.observations.closes, 1);
  }
  await assert.rejects(runner.readProductionUpdateSuccessorState('/synthetic/state', predecessorProbe({ schema: 'unknown' })),
    error => error.updateStage === 'successor_state_schema');
  await assert.rejects(runner.readProductionUpdateSuccessorState('/synthetic/state', predecessorProbe({ integrity: 'private corruption detail' })),
    error => error.message === 'SIGNED_PRODUCTION_UPDATE_REFUSED' && error.updateStage === 'successor_state_database_integrity');
});

test('successor readiness waits for v11 pending admission then returns real current state without writing', async t => {
  const { stateRoot, before, database } = await successorStateFixture(t), bytesBefore = await readFile(database);
  const pending = predecessorProbe();
  let elapsed = 0, probes = 0, identityChecks = 0;
  const stages = [];
  const predecessorIndex = { ...pending, openLocalUnifiedIndex(path, options) {
    if (++probes < 3) return pending.openLocalUnifiedIndex(path, options);
    assert.deepEqual(options, { readOnly: true }); throw newerStateError();
  } };
  const state = await runner.waitForProductionUpdateSuccessorState({ stateRoot, predecessorIndex, successorPid, successorFingerprint }, {
    now: () => elapsed, sleep: async milliseconds => { elapsed += milliseconds; assert.deepEqual(await readFile(database), bytesBefore); },
    readProcesses: identity => { identityChecks++; assert.equal(identity.get(successorPid), successorFingerprint); return successorProcess(); },
    onStage: stage => stages.push(stage),
  });
  assert.deepEqual(state, before);
  assert.equal(probes, 3);
  assert.equal(identityChecks, 6);
  assert.equal(elapsed, 600);
  assert.equal(stages.filter(stage => stage === 'successor_state_readiness').length, 2);
  assert.deepEqual(await readFile(database), bytesBefore);
});

test('endless v11 remains pending until the fixed timeout and never becomes acceptance', async () => {
  let elapsed = 0, probes = 0;
  await assert.rejects(runner.waitForProductionUpdateSuccessorState({ stateRoot: '/synthetic/state', successorPid, successorFingerprint }, {
    now: () => elapsed, sleep: async milliseconds => { elapsed += milliseconds; }, readProcesses: successorProcess,
    readState: async () => { probes++; return null; },
  }), error => error.message === 'SIGNED_PRODUCTION_UPDATE_REFUSED' && error.updateStage === 'successor_state_timeout');
  assert.equal(elapsed, 120000);
  assert.equal(probes, 400);
});

test('dead, replaced or unidentifiable successor processes fail before another state observation', async () => {
  for (const replacement of [[], [{ pid: successorPid, command: successorCommand, startedAt: 'different start' }],
    [{ pid: successorPid, command: '/synthetic/replaced-process', startedAt: successorStartedAt }],
    [{ pid: successorPid, command: successorCommand, startedAt: null }]]) {
    let probes = 0, identities = 0;
    await assert.rejects(runner.waitForProductionUpdateSuccessorState({ stateRoot: '/synthetic/state', successorPid, successorFingerprint }, {
      readProcesses: () => ++identities === 1 ? successorProcess() : replacement,
      readState: async () => { probes++; return null; }, sleep: async () => assert.fail('must not wait after identity loss'),
    }), error => error.updateStage === 'successor_state_process_identity');
    assert.equal(probes, 1);
  }
  let reads = 0;
  await assert.rejects(runner.waitForProductionUpdateSuccessorState({ stateRoot: '/synthetic/state', successorPid, successorFingerprint }, {
    readProcesses: () => [], readState: async () => { reads++; return {}; },
  }), error => error.updateStage === 'successor_state_process_identity');
  assert.equal(reads, 0);
  let readyChecks = 0;
  await assert.rejects(runner.waitForProductionUpdateSuccessorState({ stateRoot: '/synthetic/state', successorPid, successorFingerprint }, {
    readProcesses: () => ++readyChecks === 1 ? successorProcess() : [], readState: async () => ({ usageRows: 2 }),
  }), error => error.updateStage === 'successor_state_process_identity');
});

test('malformed current v12 and unknown errors fail immediately without waiting or mutating state', async t => {
  const { stateRoot, database } = await successorStateFixture(t);
  const corrupt = openLocalUnifiedIndex(database, { readOnly: false });
  corrupt.prepare("UPDATE meta SET value = 'unknown' WHERE key = 'schema_version'").run(); corrupt.close();
  const bytesBefore = await readFile(database);
  let probes = 0;
  await assert.rejects(runner.waitForProductionUpdateSuccessorState({ stateRoot, successorPid, successorFingerprint,
    predecessorIndex: { openLocalUnifiedIndex() { probes++; throw newerStateError(); } } }, {
    readProcesses: successorProcess, sleep: async () => assert.fail('current schema errors are terminal'),
  }), error => error.code === 'local_unified_index_schema_invalid');
  assert.equal(probes, 1);
  assert.deepEqual(await readFile(database), bytesBefore);
  for (const error of [newerStateError({ databaseUserVersion: 13 }), newerStateError({ minimumReaderUserVersion: 13 }),
    Object.assign(new Error('private diagnostic'), { code: 'local_unified_index_schema_invalid' })]) {
    await assert.rejects(runner.readProductionUpdateSuccessorState(stateRoot, { openLocalUnifiedIndex() { throw error; } }),
      failure => failure.updateStage === 'successor_state_schema' || failure === error);
  }
});

test('current v12 continuity failures remain fatal after readiness succeeds', async t => {
  const { stateRoot, before, database } = await successorStateFixture(t);
  const writer = openLocalUnifiedIndex(database, { readOnly: false });
  writer.prepare('UPDATE usage_event SET tokens_in_uncached = tokens_in_uncached + 1').run(); writer.close();
  const after = await runner.readProductionUpdateSuccessorState(stateRoot, { openLocalUnifiedIndex() { throw newerStateError(); } });
  assert.deepEqual(after, await readSignedReplacementState(stateRoot));
  assert.throws(() => assertSignedReplacementContinuity(before, after,
    { language: 'es', appearance: 'dark', refreshIntervalSeconds: 900, startAtLogin: false },
    { enabled: false, transportStatus: 'off', noticeDue: false, basis: 'legacy_preserved' }),
  error => runner.productionUpdateFailureStage(error, 'successor_continuity') === 'successor_continuity_retained_state_changed');
});
