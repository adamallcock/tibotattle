import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as runner from '../scripts/smoke-electron-macos-sparkle-transition.mjs';

const source = 'a'.repeat(40);
const nativeDigests = {
  'darwin-arm64': '2ea8eca02df7cc5210b6b6ce3d6e44016bffd9d081544a4efc6fa1afeeb0f1ae',
  'darwin-x64': '70630ba90e92a1cd8cb904e66e1aebe85b04e9d23a50bef7e4e41aca84c4d2f6',
};
const intake = (target = 'darwin-arm64', feedScope = 'isolated_test_feed') => ({
  schemaVersion: 'tibotattle-native-sparkle-test-intake-v1', sourceRevision: source,
  target, feedScope, version: '0.1.21', buildNumber: '2026091106', bundleVersion: '1028',
  dmgSha256: 'b'.repeat(64), asarSha256: 'c'.repeat(64), feedSha256: 'd'.repeat(64),
  nativeDmgSha256: nativeDigests[target], directory: '/Users/runner/work/_temp/native-sparkle-intake',
});
const host = (target = 'darwin-arm64') => ({
  target, platform: 'darwin', architecture: target === 'darwin-x64' ? 'x64' : 'arm64', nodeVersion: 'v26.2.0',
  environment: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS',
    RUNNER_ARCH: target === 'darwin-x64' ? 'X64' : 'ARM64', RUNNER_TEMP: '/Users/runner/work/_temp' },
  account: { uid: 501, username: 'runner', homedir: '/Users/runner' },
});

test('only an explicit confirmed execution can install into the disposable account', () => {
  assert.deepEqual(runner.parseSparkleTransitionArguments(['--plan', '--intake', '/tmp/intake.json']),
    { execute: false, intakePath: '/tmp/intake.json' });
  assert.deepEqual(runner.parseSparkleTransitionArguments(['--execute', '--intake', '/tmp/intake.json',
    '--confirm', 'RUN_DISPOSABLE_NATIVE_SPARKLE_TRANSITION']), { execute: true, intakePath: '/tmp/intake.json' });
  for (const args of [[], ['--execute', '--intake', '/tmp/intake.json'],
    ['--plan', '--intake', 'relative.json'], ['--plan', '--intake', '/tmp/intake.json', '--execute'],
    ['--execute', '--intake', '/tmp/intake.json', '--confirm', 'yes'],
    ['--execute', '--intake', '/tmp/intake.json', '--confirm', 'RUN_DISPOSABLE_NATIVE_SPARKLE_TRANSITION', '--force']]) {
    assert.throws(() => runner.parseSparkleTransitionArguments(args));
  }
});

test('both Mac architectures require matching hosted runner identity', () => {
  for (const target of Object.keys(nativeDigests)) {
    const value = host(target);
    assert.equal(runner.validateSparkleTransitionHost(value), '/Users/runner');
    for (const patch of [{ target: 'linux-x64' }, { platform: 'linux' },
      { architecture: target === 'darwin-x64' ? 'arm64' : 'x64' }, { nodeVersion: 'v26.3.0' },
      { account: { ...value.account, uid: 0 } }, { account: { ...value.account, username: 'adam' } },
      { account: { ...value.account, homedir: '/Users/adam' } },
      { environment: { ...value.environment, RUNNER_ENVIRONMENT: 'self-hosted', HOME: '/Users/runner' } },
      { environment: { ...value.environment, GITHUB_ACTIONS: 'false' } },
      { environment: { ...value.environment, RUNNER_OS: 'Linux' } },
      { environment: { ...value.environment, RUNNER_ARCH: target === 'darwin-x64' ? 'ARM64' : 'X64' } },
      { environment: { ...value.environment, RUNNER_TEMP: 'relative' } }]) {
      assert.throws(() => runner.validateSparkleTransitionHost({ ...value, ...patch }));
    }
  }
});

test('intake binds the architecture, exact native predecessor and closed feed scope', () => {
  for (const target of Object.keys(nativeDigests)) for (const scope of ['isolated_test_feed', 'production_feed']) {
    const value = intake(target, scope), result = runner.validateSparkleTransitionIntake(value);
    const prefix = target === 'darwin-x64' ? 'intel/' : '';
    const base = 'https://updates.tibotattle.com';
    assert.equal(result.nativeDmgSha256, nativeDigests[target]);
    assert.equal(result.feedUrl, scope === 'isolated_test_feed'
      ? `${base}/electron/test/native-sparkle/${source}/1028/${value.dmgSha256}/appcast.xml`
      : `${base}/${prefix}appcast.xml`);
    assert.equal(result.dmgFileName, target === 'darwin-x64'
      ? 'TiboTattle-0.1.21-macOS-x64.dmg' : 'TiboTattle-0.1.21-mac-arm64.dmg');
    assert.equal(result.appPath, value.directory + '/candidate/TiboTattle.app');
    for (const patch of [{ target: 'linux-x64' }, { feedScope: 'https://attacker.example/appcast.xml' },
      { sourceRevision: 'a'.repeat(39) }, { sourceRevision: '../source' }, { sourceRevision: [source] }, { version: '0.1.20' },
      { bundleVersion: '2026091106' }, { bundleVersion: '1026' }, { buildNumber: '0' }, { buildNumber: 2026091106 },
      { dmgSha256: 'B'.repeat(64) }, { asarSha256: '' }, { feedSha256: 'd'.repeat(63) },
      { dmgSha256: [value.dmgSha256] }, { asarSha256: [value.asarSha256] }, { feedSha256: [value.feedSha256] },
      { nativeDmgSha256: nativeDigests[target === 'darwin-x64' ? 'darwin-arm64' : 'darwin-x64'] },
      { directory: 'relative' }, { feedUrl: 'https://attacker.example/appcast.xml' }]) {
      assert.throws(() => runner.validateSparkleTransitionIntake({ ...value, ...patch }));
    }
    for (const key of Object.keys(value)) {
      const missing = { ...value }; delete missing[key];
      assert.throws(() => runner.validateSparkleTransitionIntake(missing), key);
    }
  }
});

test('UI automation is PID-scoped, refuses ambiguous buttons, and returns fixed classifications', () => {
  for (const [pid, action] of [[0, 'check'], [1, 'check'], [3.5, 'check'], ['4;evil()', 'check'], [4, 'approve']]) {
    assert.throws(() => runner.sparkleTransitionUiScript(pid, action));
  }
  const code = runner.sparkleTransitionUiScript(321, 'check');
  let clicks = 0;
  const button = () => ({ name: () => 'Check for Updates…', role: () => 'AXButton', enabled: () => true,
    click: () => { clicks++; } });
  const evaluate = (buttons) => runInNewContext(code + '\nrun();', {
    Application(name) {
      assert.equal(name, 'System Events');
      return { applicationProcesses: { whose(filter) {
        assert.equal(filter.unixId, 321);
        return () => [{ windows: () => [{ entireContents: () => buttons }] }];
      } } };
    },
  });
  assert.equal(evaluate([button()]), 'clicked'); assert.equal(clicks, 1);
  assert.equal(evaluate([button(), button()]), 'ambiguous_target'); assert.equal(clicks, 1);
  assert.equal(evaluate([]), 'target_absent');
  assert.doesNotMatch(code, /keystroke|keyCode|System Settings|security authorizationdb/u);
});

test('the runner never installs the candidate directly or changes either signed bundle', async () => {
  const script = await readFile(new URL('../scripts/smoke-electron-macos-sparkle-transition.mjs', import.meta.url), 'utf8');
  assert.match(script, /command\('\/usr\/bin\/ditto', \[input\.nativeAppPath, installedApp\]/u);
  assert.doesNotMatch(script, /command\('\/usr\/bin\/ditto', \[input\.appPath, installedApp\]/u);
  assert.doesNotMatch(script, /codesign[^\n]*--sign|writeFile[^\n]*Info\.plist|cp[^\n]*candidate[^\n]*Applications/u);
  assert.match(script, /candidateCopiedByRunner: false/u);
  assert.match(script, /assertProductionElectronMacOSBundleMetadata/u);
  assert.match(script, /await verifyCandidate\(input, installedApp\)/u);
});

test('production proof refuses a user feed override instead of silently testing a different feed', async () => {
  const script = await readFile(new URL('../scripts/smoke-electron-macos-sparkle-transition.mjs', import.meta.url), 'utf8');
  const body = script.slice(script.indexOf("    if (input.feedScope === 'isolated_test_feed') {"),
    script.indexOf("    stage = 'native_launch';"));
  assert.ok(body.startsWith("    if (input.feedScope === 'isolated_test_feed') {"));
  const evaluate = (scope, previous) => {
    const writes = [], proof = { feedOverrideApplied: false };
    runInNewContext(body, {
      input: { feedScope: scope, feedUrl: 'https://updates.tibotattle.com/appcast.xml' }, proof,
      domain: 'com.usagemonitor.local', command: (...args) => writes.push(args),
      spawnSync: () => previous,
      fail: (stage) => { throw new Error(stage); },
    });
    return { writes, proof };
  };
  const production = evaluate('production_feed', { status: 1, stdout: '' });
  assert.equal(production.writes.length, 0); assert.equal(production.proof.feedOverrideApplied, false);
  const isolated = evaluate('isolated_test_feed', null);
  assert.equal(isolated.writes.length, 1); assert.equal(isolated.writes[0][1][2], 'SUFeedURL');
  assert.equal(isolated.proof.feedOverrideApplied, true);
  for (const previous of [{ status: 0, stdout: 'https://test.example/appcast.xml' },
    { status: 0, stdout: '' }, { status: 2, stdout: '' }, { status: 1, stdout: 'unexpected' },
    { error: new Error('failed'), status: null }]) {
    assert.throws(() => evaluate('production_feed', previous), /preexisting_feed_override/u);
  }
});

test('workflow download planning matches the runner for both architectures and scopes', async () => {
  const workflow = await readFile(new URL('../.github/workflows/electron-macos-sparkle-transition.yml', import.meta.url), 'utf8');
  const inputBlock = workflow.split('    inputs:\n')[1].split('\npermissions:')[0];
  assert.equal([...inputBlock.matchAll(/^      [a-z0-9_]+:$/gmu)].length, 10);
  assert.match(workflow, /runs-on: macos-26-intel/u);
  assert.match(workflow, /runs-on: macos-26\n/u);
  assert.match(workflow, /architecture: x64/u);
  assert.match(workflow, /architecture: arm64/u);
  assert.doesNotMatch(workflow, /runs-on:.*\$\{\{/u);
  for (const target of ['darwin-arm64', 'darwin-x64']) {
    assert.ok(workflow.includes("if: github.event_name == 'workflow_dispatch' && inputs.target == '" + target + "'"));
  }
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /^permissions:\n  contents: read/mu);
  assert.doesNotMatch(workflow, /secrets\.|pull_request_target|--location|curl[^\n]* -L/u);
  const pythonBlocks = workflow.split("          python3 - <<'PY'\n").slice(1)
    .map((block) => block.split('\n          PY')[0].split('\n').map((line) => line.slice(10)).join('\n'));
  assert.equal(pythonBlocks.length, 2);
  assert.equal(pythonBlocks[0], pythonBlocks[1], 'both static runner jobs must use identical intake validation');
  const python = pythonBlocks[0];
  execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: python });
  const planning = python.split('for name,url,digest,limit in files:')[0] + '\nprint(json.dumps(files))\n';
  for (const target of Object.keys(nativeDigests)) for (const scope of ['isolated_test_feed', 'production_feed']) {
    const root = await mkdtemp(join(tmpdir(), 'sparkle-download-plan-'));
    try {
      const value = intake(target, scope), normalized = runner.validateSparkleTransitionIntake(value);
      const files = JSON.parse(execFileSync('python3', ['-c', planning], { encoding: 'utf8', env: {
        ...process.env, SELECTED_SOURCE: source, SELECTED_RUNNER: source, GITHUB_SHA: source,
        SELECTED_BUILD: value.buildNumber, SELECTED_DMG: value.dmgSha256, SELECTED_ASAR: value.asarSha256,
        SELECTED_FEED: value.feedSha256, SELECTED_MODE: 'plan', SELECTED_CONFIRMATION: '',
        SELECTED_TARGET: target, SELECTED_FEED_SCOPE: scope, RUNNER_TEMP: root,
      } }));
      assert.equal(files[0][2], nativeDigests[target]);
      assert.equal(files[1][2], value.dmgSha256);
      assert.equal(files[2][1], normalized.feedUrl);
      assert.ok(files[1][1].endsWith('/' + normalized.dmgFileName));
      const prefix = target === 'darwin-x64' ? 'intel/' : '';
      const candidatePrefix = scope === 'production_feed'
        ? `https://updates.tibotattle.com/${prefix}releases/1028/${value.dmgSha256}/`
        : `https://updates.tibotattle.com/electron/test/native-sparkle/${source}/1028/${value.dmgSha256}/`;
      assert.equal(files[1][1], candidatePrefix + normalized.dmgFileName);
      assert.ok(files[0][1].startsWith(`https://updates.tibotattle.com/${prefix}releases/1026/${nativeDigests[target]}/`));
      // Exercise the actual extraction and JSON-writing block with only OS commands
      // substituted. This catches an architecture variable overwritten by a Path.
      const extraction = [
        'import pathlib,json,shutil',
        'root=pathlib.Path(' + JSON.stringify(root) + ')',
        'e=' + JSON.stringify({ SELECTED_DMG: value.dmgSha256, SELECTED_ASAR: value.asarSha256,
          SELECTED_FEED: value.feedSha256, SELECTED_BUILD: value.buildNumber }),
        'source=' + JSON.stringify(source), 'runner=source',
        'target=' + JSON.stringify(target), 'scope=' + JSON.stringify(scope),
        'native=' + JSON.stringify(nativeDigests[target]),
        "pathlib.Path('sparkle-transition-receipts').mkdir()",
        'class Commands:',
        '  DEVNULL=None',
        '  def run(self,args,**options):',
        "    if args[:2]==['/usr/bin/hdiutil','attach']:",
        "      (pathlib.Path(args[args.index('-mountpoint')+1])/'TiboTattle.app').mkdir()",
        "    elif args[0]=='/usr/bin/ditto': shutil.copytree(args[1],args[2])",
        "    elif args[:2]!=['/usr/bin/hdiutil','detach']: raise AssertionError('unexpected command')",
        'subprocess=Commands()',
        python.slice(python.indexOf("for name in ['native','candidate']:")),
      ].join('\n');
      execFileSync('python3', ['-c', extraction], { cwd: root, encoding: 'utf8' });
      const generated = JSON.parse(await readFile(join(root, 'intake.json'), 'utf8'));
      assert.equal(generated.target, target);
      assert.equal(runner.validateSparkleTransitionIntake(generated).target, target);
      const receipt = JSON.parse(await readFile(join(root, 'sparkle-transition-receipts', 'intake.json'), 'utf8'));
      assert.equal(receipt.target, target);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
