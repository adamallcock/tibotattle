import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { validateEmptyProfileIntake, parseEmptyProfileArguments, assertEmptyProfileSharing,
  emptyProfileSettingsScript, exerciseEmptyProfileSettings, runEmptyProfileSmoke, EMPTY_PROFILE_CONFIRMATION } from '../scripts/smoke-electron-macos-empty-profile.mjs';
const intake = { runnerRevision: 'e'.repeat(40), target: 'darwin-arm64', sourceRevision: 'a'.repeat(40),
  version: '0.1.23', bundleVersion: '1030', buildNumber: '2026091401', dmgSha256: 'b'.repeat(64), asarSha256: 'c'.repeat(64) };
const historicalIntake = target => ({ runnerRevision: 'e'.repeat(40), target,
  sourceRevision: 'a651ea130dd1460e4443a037c4434f57b911fec4', version: '0.1.21', buildNumber: '2026091107', bundleVersion: '1028',
  ...(target === 'darwin-arm64' ? {
    dmgSha256: '0afab510adf250775e1401307b547cee1a7955e1d7ec8dce9852cc4ca143c7e2',
    asarSha256: '11d053d35ae6e971adc27b3a30a8bb94592e09f5f1466cfb5d9c008634950175',
  } : {
    dmgSha256: '50960e1aac65eb2673a7634a18bf123b604680f2a526822a0ccccc1d3b0b52e4',
    asarSha256: '8222cd3119e42b24d87adaee6d1a264514517504a12e2b7d728fb53ac81722e1',
  }) });
test('explicit successor and historical identities derive only exact architecture-specific test URLs', () => {
  for (const target of ['darwin-arm64', 'darwin-x64']) {
    for (const selected of [{ ...intake, target }, historicalIntake(target)]) {
      const value = validateEmptyProfileIntake(selected);
      const architecture = target === 'darwin-arm64' ? 'arm64' : 'x64';
      assert.equal(value.architecture, architecture);
      for (const key of Object.keys(selected)) assert.equal(value[key], selected[key], key);
      const filename = `TiboTattle-${selected.version}-${architecture === 'arm64' ? 'mac-arm64' : 'macOS-x64'}.dmg`;
      assert.equal(value.filename, filename);
      assert.equal(value.url, `https://updates.tibotattle.com/electron/test/native-sparkle/${selected.sourceRevision}/${selected.bundleVersion}/${selected.dmgSha256}/${filename}`);
      assert.equal(Object.isFrozen(value), true);
    }
  }
});
test('intake rejects missing identities, invalid source/hashes, mismatched allocations and transport overrides', () => {
  for (const key of Object.keys(intake)) {
    const missing = { ...intake }; delete missing[key];
    assert.throws(() => validateEmptyProfileIntake(missing), { emptyProfileStage: 'intake' });
  }
  for (const field of ['directory', 'url', 'filename', 'architecture', 'feedScope']) {
    assert.throws(() => validateEmptyProfileIntake({ ...intake, [field]: 'different' }), { emptyProfileStage: 'intake' });
  }
  for (const target of [[], {}, null, 'darwin-ia32', 'toString']) assert.throws(() => validateEmptyProfileIntake({ ...intake, target }));
  for (const field of ['runnerRevision', 'sourceRevision']) for (const value of [[], null, 'main', 'E'.repeat(40), 'e'.repeat(39)]) {
    assert.throws(() => validateEmptyProfileIntake({ ...intake, [field]: value }), { emptyProfileStage: 'intake' });
  }
  for (const field of ['dmgSha256', 'asarSha256']) for (const value of [[], null, 'E'.repeat(64), 'e'.repeat(63), '../artifact']) {
    assert.throws(() => validateEmptyProfileIntake({ ...intake, [field]: value }), { emptyProfileStage: 'intake' });
  }
  for (const changed of [{ version: '0.1.21' }, { version: '0.1.22' }, { bundleVersion: '1029' },
    { version: '0.1.24', bundleVersion: '1031' }, { version: '0.1.18', bundleVersion: '1026' },
    { version: ['0.1.23'] }, { bundleVersion: 1030 }, { bundleVersion: '1030.0' },
    { buildNumber: 2026091401 }, { buildNumber: '0' }, { buildNumber: '202609140100' }]) {
    assert.throws(() => validateEmptyProfileIntake({ ...intake, ...changed }), { emptyProfileStage: 'intake' });
  }
});
test('execution requires exact explicit confirmation; plan cannot smuggle arguments', () => {
  assert.deepEqual(parseEmptyProfileArguments(['--plan']), { execute: false });
  assert.deepEqual(parseEmptyProfileArguments(['--execute', '--confirm', EMPTY_PROFILE_CONFIRMATION]), { execute: true });
  for (const args of [[], ['--execute'], ['--execute', '--confirm', 'yes'], ['--plan', '--confirm', EMPTY_PROFILE_CONFIRMATION], ['--plan', '--intake', '/tmp/a']]) assert.throws(() => parseEmptyProfileArguments(args));
});
test('plan has no host, download, installation or sharing side effects and claims no qualification', async () => {
  for (const target of ['darwin-arm64', 'darwin-x64']) for (const selected of [{ ...intake, target }, historicalIntake(target)]) {
    const value = await runEmptyProfileSmoke({ intake: selected });
    assert.equal(value.status, 'planned');
    for (const key of Object.keys(selected)) assert.equal(value[key], selected[key], key);
    for (const [key, flag] of Object.entries(value)) if (typeof flag === 'boolean') assert.equal(flag, false, key);
  }
  assert.equal((await runEmptyProfileSmoke({ intake: { ...intake, bundleVersion: '1029' } })).status, 'failed');
});
test('fresh projection refuses stale, unavailable, implicit prior choice or accepted payload', () => {
  const value = { available: true, current: true, enabled: true, basis: 'default_on', lastAcceptedAt: null };
  assert.equal(assertEmptyProfileSharing(value), true);
  for (const change of [{ available: false }, { current: false }, { enabled: false }, { basis: 'explicit_on' }, { lastAcceptedAt: '2026-09-11T00:00:00Z' }]) assert.throws(() => assertEmptyProfileSharing({ ...value, ...change }));
  assert.equal(assertEmptyProfileSharing({ ...value, enabled: false, transportStatus: 'off' }, { optedOut: true }), true);
  assert.throws(() => assertEmptyProfileSharing({ ...value, enabled: false, transportStatus: 'uploading' }, { optedOut: true }));
});
test('settings waits for deferred module readiness, clicks once, and polls the real tab effect', async () => {
  let time = 0;
  const clicks = { about: 0, general: 0, data: 0 }, panels = {}, buttons = {};
  for (const tab of Object.keys(clicks)) {
    panels[tab] = { hidden: true };
    buttons[tab] = { disabled: false, selected: 'false',
      click() { assert.ok(time >= 200); clicks[tab]++; this.applyAt = time + 200; },
      getAttribute() { return this.selected; } };
  }
  const document = { readyState: 'loading', getElementById(id) {
    const tab = id.split('-').at(-1); return id.startsWith('settings-tab-') ? buttons[tab] : panels[tab];
  } };
  const settings = { evaluate: async expression => vm.runInNewContext(expression, { document }) };
  const wait = async milliseconds => {
    time += milliseconds;
    if (time >= 200) document.readyState = 'complete';
    for (const tab of Object.keys(clicks)) if (buttons[tab].applyAt <= time) {
      buttons[tab].selected = 'true'; panels[tab].hidden = false;
    }
  };
  assert.equal(await exerciseEmptyProfileSettings(settings, { now: () => time, wait }), true);
  assert.deepEqual(clicks, { about: 1, general: 1, data: 1 });
  assert.ok(time >= 800);
  assert.throws(() => emptyProfileSettingsScript("data');process.exit()"));
  assert.throws(() => emptyProfileSettingsScript('about', 'mutate'));
});
test('missing readiness or a broken tab effect fails within the budget without retrying clicks', async () => {
  for (const ready of [false, true]) {
    let time = 0, clicks = 0;
    const button = { disabled: false, click() { clicks++; }, getAttribute() { return 'false'; } };
    const panel = { hidden: true };
    const document = { readyState: ready ? 'complete' : 'loading',
      getElementById(id) { return id.startsWith('settings-tab-') ? button : panel; } };
    const settings = { evaluate: async expression => vm.runInNewContext(expression, { document }) };
    await assert.rejects(exerciseEmptyProfileSettings(settings, {
      now: () => time, wait: async milliseconds => { time += milliseconds; },
    }), error => error.emptyProfileStage === (ready ? 'settings_effect' : 'settings_ready'));
    assert.equal(time, 10000); assert.equal(clicks, ready ? 1 : 0);
  }
});
test('manual workflow has static architecture hosts and no native fixtures or publication', async () => {
  const workflow = await readFile(new URL('../.github/workflows/electron-macos-empty-profile.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /registration:\n    if: github\.event_name == 'push'/u);
  assert.equal((workflow.match(/if: github\.event_name == 'workflow_dispatch' && inputs\.target/g) ?? []).length, 2);
  assert.match(workflow, /runs-on: macos-26\n/u);
  assert.match(workflow, /runs-on: macos-15-intel\n/u);
  assert.doesNotMatch(workflow, /pull_request_target|contents: write|id-token: write|runs-on: \$\{\{|macos-26-intel/u);
  assert.match(workflow, /default: plan/u);
  const script = await readFile(new URL('../scripts/smoke-electron-macos-empty-profile.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /seedNativeSparkleTransitionState|signedStagingFixture|prepareSignedStagingDisposableProfile|writeFile\(/u);
  assert.match(script, /untouched: true/u);
  assert.match(script, /usageUploadQualified: false/u);
  assert.match(script, /setSharingEnabled\(false\)/u);
  assert.match(script, /assertExtractedSignedMacBundle\(dmg, installed,/u);
  assert.match(script, /verifySparkleTransitionCandidate\(\{ \.\.\.input, candidateCodeDirectoryHash \}, installed\)/u);
});
test('both workflow intake bodies bind the selected target and runner before any app execution', async () => {
  const workflow = await readFile(new URL('../.github/workflows/electron-macos-empty-profile.yml', import.meta.url), 'utf8');
  const scripts = [...workflow.matchAll(/node --input-type=module - <<'JS'\n([\s\S]*?)          JS/gu)]
    .map(match => match[1].replace(/^          /gmu, ''));
  assert.equal(scripts.length, 2);
  for (const [index, target] of ['darwin-arm64', 'darwin-x64'].entries()) {
    const script = scripts[index];
    for (const selected of [{ ...intake, target }, historicalIntake(target)]) {
      const env = { PATH: process.env.PATH, EMPTY_PROFILE_INTAKE: JSON.stringify(selected), SELECTED_TARGET: target,
        GITHUB_SHA: selected.runnerRevision, SELECTED_MODE: 'plan', SELECTED_CONFIRMATION: '' };
      const run = changed => execFileSync(process.execPath, ['--input-type=module', '-'],
        { input: script, env: { ...env, ...changed }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
      run({});
      run({ SELECTED_MODE: 'execute', SELECTED_CONFIRMATION: EMPTY_PROFILE_CONFIRMATION });
      for (const changed of [{ GITHUB_SHA: 'f'.repeat(40) },
        { SELECTED_TARGET: target === 'darwin-arm64' ? 'darwin-x64' : 'darwin-arm64' },
        { SELECTED_MODE: 'execute' }, { SELECTED_CONFIRMATION: EMPTY_PROFILE_CONFIRMATION },
        { EMPTY_PROFILE_INTAKE: JSON.stringify({ ...selected, sourceRevision: 'main' }) },
        { EMPTY_PROFILE_INTAKE: JSON.stringify({ ...selected, dmgSha256: 'wrong' }) },
        { EMPTY_PROFILE_INTAKE: JSON.stringify({ ...selected, bundleVersion: '1026' }) }]) assert.throws(() => run(changed));
    }
  }
});
