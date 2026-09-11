import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { validateEmptyProfileIntake, parseEmptyProfileArguments, assertEmptyProfileSharing,
  emptyProfileSettingsScript, runEmptyProfileSmoke, EMPTY_PROFILE_CONFIRMATION } from '../scripts/smoke-electron-macos-empty-profile.mjs';
const intake = { runnerRevision: 'e'.repeat(40), target: 'darwin-arm64' };
test('intake pins candidate bytes and rejects caller-selected source, paths, origins or extra fields', () => {
  const value = validateEmptyProfileIntake(intake);
  assert.equal(value.sourceRevision, 'a651ea130dd1460e4443a037c4434f57b911fec4');
  assert.equal(value.buildNumber, '2026091107');
  assert.equal(value.bundleVersion, '1028');
  assert.match(value.url, /^https:\/\/updates\.tibotattle\.com\/electron\/test\/native-sparkle\//u);
  for (const field of ['sourceRevision', 'directory', 'url', 'dmgSha256', 'asarSha256']) assert.throws(() => validateEmptyProfileIntake({ ...intake, [field]: 'different' }));
  for (const target of [[], {}, null, 'darwin-ia32', 'toString']) assert.throws(() => validateEmptyProfileIntake({ ...intake, target }));
  for (const runnerRevision of [[], null, 'main', 'E'.repeat(40)]) assert.throws(() => validateEmptyProfileIntake({ ...intake, runnerRevision }));
  const intel = validateEmptyProfileIntake({ ...intake, target: 'darwin-x64' });
  assert.equal(intel.architecture, 'x64');
  assert.notEqual(intel.dmgSha256, value.dmgSha256);
  assert.match(intel.url, /TiboTattle-0\.1\.21-macOS-x64\.dmg$/u);
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
test('settings interaction executes existing tab handler and verifies its effect', () => {
  for (const tab of ['about', 'general', 'data']) {
    const panel = { hidden: true };
    let selected = 'false', clicks = 0;
    const button = { disabled: false, click() { clicks++; selected = 'true'; panel.hidden = false; }, getAttribute() { return selected; } };
    const document = { getElementById(id) { return id === `settings-tab-${tab}` ? button : panel; } };
    assert.equal(vm.runInNewContext(emptyProfileSettingsScript(tab), { document }), true);
    assert.equal(clicks, 1);
    button.click = () => {}; panel.hidden = true;
    assert.equal(vm.runInNewContext(emptyProfileSettingsScript(tab), { document }), false);
  }
  assert.throws(() => emptyProfileSettingsScript("data');process.exit()"));
});
test('manual workflow has static architecture hosts and no native fixtures or publication', async () => {
  const workflow = await readFile(new URL('../.github/workflows/electron-macos-empty-profile.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/u);
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
