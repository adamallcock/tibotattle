import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { validateEmptyProfileIntake, parseEmptyProfileArguments, assertEmptyProfileSharing,
  emptyProfileSettingsScript, exerciseEmptyProfileSettings, runEmptyProfileSmoke, EMPTY_PROFILE_CONFIRMATION } from '../scripts/smoke-electron-macos-empty-profile.mjs';
const intake = { runnerRevision: 'e'.repeat(40), target: 'darwin-arm64' };
test('intake pins candidate bytes and rejects caller-selected source, paths, origins or extra fields', () => {
  const value = validateEmptyProfileIntake(intake);
  assert.equal(value.sourceRevision, '16a0d4dffad4b1213b28adaae139fc9ee6705837');
  assert.equal(value.buildNumber, '2026091108');
  assert.equal(value.bundleVersion, '1029');
  assert.match(value.url, /^https:\/\/updates\.tibotattle\.com\/electron\/test\/native-sparkle\//u);
  for (const field of ['sourceRevision', 'directory', 'url', 'dmgSha256', 'asarSha256']) assert.throws(() => validateEmptyProfileIntake({ ...intake, [field]: 'different' }));
  for (const target of [[], {}, null, 'darwin-ia32', 'toString']) assert.throws(() => validateEmptyProfileIntake({ ...intake, target }));
  for (const runnerRevision of [[], null, 'main', 'E'.repeat(40)]) assert.throws(() => validateEmptyProfileIntake({ ...intake, runnerRevision }));
  const intel = validateEmptyProfileIntake({ ...intake, target: 'darwin-x64' });
  assert.equal(intel.architecture, 'x64');
  assert.notEqual(intel.dmgSha256, value.dmgSha256);
  assert.match(intel.url, /TiboTattle-0\.1\.22-macOS-x64\.dmg$/u);
});
test('execution requires exact explicit confirmation; plan cannot smuggle arguments', () => {
  assert.deepEqual(parseEmptyProfileArguments(['--plan']), { execute: false });
  assert.deepEqual(parseEmptyProfileArguments(['--execute', '--confirm', EMPTY_PROFILE_CONFIRMATION]), { execute: true });
  for (const args of [[], ['--execute'], ['--execute', '--confirm', 'yes'], ['--plan', '--confirm', EMPTY_PROFILE_CONFIRMATION], ['--plan', '--intake', '/tmp/a']]) assert.throws(() => parseEmptyProfileArguments(args));
});
test('plan has no host, download, installation or sharing side effects and claims no qualification', async () => {
  const value = await runEmptyProfileSmoke({ intake });
  assert.equal(value.status, 'planned');
  for (const [key, flag] of Object.entries(value)) if (typeof flag === 'boolean') assert.equal(flag, false, key);
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
});
