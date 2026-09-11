#!/usr/bin/env node
// Separate clean-install evidence: no predecessor, fixtures, or upload success claims.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { assertExtractedSignedMacBundle, verifySparkleTransitionCandidate,
  validateSparkleTransitionHost, signedMacTransitionEnvironment } from './smoke-electron-macos-sparkle-transition.mjs';
import { launchVerifiedMacSharingApp, stopOwnedMacSharingApp,
  assertSignedStagingFreshProjection } from './run-signed-electron-staging.mjs';

export const EMPTY_PROFILE_CONFIRMATION = 'RUN_DISPOSABLE_EMPTY_PROFILE';
const SOURCE = 'a651ea130dd1460e4443a037c4434f57b911fec4';
const CANDIDATES = Object.freeze({
  'darwin-arm64': Object.freeze({ architecture: 'arm64',
    dmgSha256: '0afab510adf250775e1401307b547cee1a7955e1d7ec8dce9852cc4ca143c7e2',
    asarSha256: '11d053d35ae6e971adc27b3a30a8bb94592e09f5f1466cfb5d9c008634950175', filename: 'TiboTattle-0.1.21-mac-arm64.dmg' }),
  'darwin-x64': Object.freeze({ architecture: 'x64',
    dmgSha256: '50960e1aac65eb2673a7634a18bf123b604680f2a526822a0ccccc1d3b0b52e4',
    asarSha256: '8222cd3119e42b24d87adaee6d1a264514517504a12e2b7d728fb53ac81722e1', filename: 'TiboTattle-0.1.21-macOS-x64.dmg' }),
});
function fail(stage) { const error = new Error('Empty-profile qualification failed'); error.emptyProfileStage = stage; throw error; }
export function validateEmptyProfileIntake(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'runnerRevision,target'
    || typeof input.runnerRevision !== 'string' || !/^[a-f0-9]{40}$/u.test(input.runnerRevision)
    || typeof input.target !== 'string' || !Object.hasOwn(CANDIDATES, input.target)) fail('intake');
  const candidate = CANDIDATES[input.target];
  return Object.freeze({ ...input, ...candidate, sourceRevision: SOURCE, version: '0.1.21', buildNumber: '2026091107', bundleVersion: '1028',
    url: `https://updates.tibotattle.com/electron/test/native-sparkle/${SOURCE}/1028/${candidate.dmgSha256}/${candidate.filename}` });
}
export function parseEmptyProfileArguments(args) {
  if (!Array.isArray(args) || ![1, 3].includes(args.length) || !['--plan', '--execute'].includes(args[0])) fail('arguments');
  const execute = args[0] === '--execute';
  if (execute ? args.length !== 3 || args[1] !== '--confirm' || args[2] !== EMPTY_PROFILE_CONFIRMATION : args.length !== 1) fail('confirmation');
  return { execute };
}
export function assertEmptyProfileSharing(value, { optedOut = false } = {}) {
  if (value?.available !== true || value.current !== true || value.enabled !== !optedOut
    || (!optedOut && value.basis !== 'default_on')
    || (optedOut && value.transportStatus !== 'off') || value.lastAcceptedAt !== null) fail(optedOut ? 'opt_out' : 'fresh_projection');
  return true;
}
export function emptyProfileSettingsScript(tab, operation = 'selected') {
  if (!['general', 'data', 'about'].includes(tab) || !['ready', 'click', 'selected'].includes(operation)) fail('settings_tab');
  return `(() => { const button = document.getElementById('settings-tab-${tab}');
    const panel = document.getElementById('settings-panel-${tab}');
    if (document.readyState !== 'complete' || !button || !panel || button.disabled) return false;
    ${operation === 'ready' ? "return true;" : operation === 'click' ? "button.click(); return true;"
      : "return button.getAttribute('aria-selected') === 'true' && panel.hidden === false;"}
  })()`;
}
export async function exerciseEmptyProfileSettings(settings, { now = Date.now, wait = delay } = {}) {
  const until = async (expression, stage) => {
    const deadline = now() + 10000;
    do {
      if (await settings.evaluate(expression) === true) return;
      await wait(100);
    } while (now() < deadline);
    fail(stage);
  };
  for (const tab of ['about', 'general', 'data']) {
    // Preload exists before the deferred Settings module has installed its handlers.
    // Complete document readiness precedes the one actual click; polling never clicks.
    await until(emptyProfileSettingsScript(tab, 'ready'), 'settings_ready');
    if (await settings.evaluate(emptyProfileSettingsScript(tab, 'click')) !== true) fail('settings_click');
    await until(emptyProfileSettingsScript(tab, 'selected'), 'settings_effect');
  }
  return true;
}
async function absent(path) { try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; } fail('profile_not_empty'); }
async function safeDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o022)) fail('unsafe_directory');
  if (path !== '/Users/runner' && path.startsWith('/Users/runner/')) await safeDirectory(dirname(path));
}
function command(executable, args, timeout = 90000) {
  return execFileSync(executable, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
async function smallJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > 4096) fail('first_run_receipt');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function sharingReady(active) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await active.readSharing();
    if (value?.available === true && value.current === true) return value;
    await delay(250);
  }
  fail('sharing_unavailable');
}
export async function runEmptyProfileSmoke({ intake, execute = false }) {
  const proof = { schemaVersion: 'tibotattle-signed-macos-empty-profile-v1', status: 'failed',
    disposableAccountVerified: false, emptyProfileVerified: false, signedArtifactVerified: false,
    nativeIntroContinued: false, freshDefaultSharingObserved: false, settingsTabsInteractive: false,
    controlledRestart: false, defaultSharingPreserved: false, persistentOptOut: false,
    codexHomeAbsentThroughout: false, ownedProcessesStopped: false, nativeCleanQuitQualified: false,
    usageUploadQualified: false, credentialPersistenceQualified: false, failureStage: null };
  let active, stage = 'intake';
  try {
    const input = validateEmptyProfileIntake(intake);
    Object.assign(proof, { target: input.target, sourceRevision: input.sourceRevision, runnerRevision: input.runnerRevision,
      version: input.version, buildNumber: input.buildNumber, dmgSha256: input.dmgSha256, asarSha256: input.asarSha256 });
    if (!execute) return { ...proof, status: 'planned' };
    stage = 'host';
    const home = validateSparkleTransitionHost({ target: input.target, platform: process.platform,
      architecture: process.arch, nodeVersion: process.version, environment: process.env, account: userInfo() });
    if (process.env.GITHUB_SHA !== input.runnerRevision) fail('runner_revision');
    proof.disposableAccountVerified = true;
    const appData = join(home, 'Library', 'Application Support');
    const profile = join(appData, 'TiboTattle'), codex = join(home, '.codex');
    const installed = join(home, 'Applications', 'TiboTattle.app');
    stage = 'empty_profile';
    for (const path of [codex, join(home, '.claude'), profile, installed, '/Applications/TiboTattle.app',
      join(appData, 'Usage Monitor'), join(appData, 'TiboTattle Native Handover'), join(appData, 'app-usagemonitor'),
      join(home, 'Library', 'Preferences', 'com.usagemonitor.local.plist')]) await absent(path);
    proof.emptyProfileVerified = true;
    const directory = join(process.env.RUNNER_TEMP, 'tibotattle-empty-profile');
    await mkdir(directory, { mode: 0o700 }); await safeDirectory(directory);
    const environment = signedMacTransitionEnvironment({ target: input.target, home, temporaryDirectory: directory });
    stage = 'artifact';
    const dmg = join(directory, 'candidate.dmg');
    const response = command('/usr/bin/curl', ['--disable', '--fail', '--silent', '--show-error', '--proto', '=https',
      '--max-time', '180', '--max-filesize', String(1024 ** 3), '--output', dmg, '--write-out', '%{http_code}', input.url], 190000);
    if (response !== '200') fail('download');
    const bytes = await readFile(dmg);
    if (bytes.length === 0 || bytes.length > 1024 ** 3 || createHash('sha256').update(bytes).digest('hex') !== input.dmgSha256) fail('dmg_digest');
    const mount = join(directory, 'mount'); await mkdir(mount, { mode: 0o700 });
    await mkdir(dirname(installed), { recursive: true, mode: 0o700 }); await safeDirectory(dirname(installed));
    command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg]);
    try { command('/usr/bin/ditto', [join(mount, 'TiboTattle.app'), installed], 120000); }
    finally { command('/usr/bin/hdiutil', ['detach', mount]); }
    const candidateCodeDirectoryHash = await assertExtractedSignedMacBundle(dmg, installed, join(directory, 'verification-mount'));
    const verified = await verifySparkleTransitionCandidate({ ...input, candidateCodeDirectoryHash }, installed);
    proof.signedArtifactVerified = true;
    stage = 'first_launch';
    active = await launchVerifiedMacSharingApp(verified, environment, { untouched: true });
    proof.nativeIntroContinued = active.nativeIntroContinued === true;
    const sharing = await sharingReady(active);
    assertEmptyProfileSharing(sharing);
    assertSignedStagingFreshProjection(sharing, await smallJson(join(profile, 'desktop-settings', 'desktop-first-run-v1.json')));
    proof.freshDefaultSharingObserved = true;
    stage = 'settings';
    await exerciseEmptyProfileSettings(active.settings);
    proof.settingsTabsInteractive = true;
    await absent(codex);
    await stopOwnedMacSharingApp(active); active = null;
    stage = 'default_restart';
    active = await launchVerifiedMacSharingApp(verified, environment);
    assertEmptyProfileSharing(await sharingReady(active));
    proof.controlledRestart = true; proof.defaultSharingPreserved = true;
    stage = 'opt_out';
    await active.settings.evaluate('globalThis.tibotattleDesktop.setSharingEnabled(false)');
    assertEmptyProfileSharing(await sharingReady(active), { optedOut: true });
    await absent(codex);
    await stopOwnedMacSharingApp(active); active = null;
    stage = 'opt_out_restart';
    active = await launchVerifiedMacSharingApp(verified, environment);
    assertEmptyProfileSharing(await sharingReady(active), { optedOut: true });
    await absent(codex);
    proof.persistentOptOut = true; proof.codexHomeAbsentThroughout = true;
    await stopOwnedMacSharingApp(active); active = null;
    proof.ownedProcessesStopped = true; proof.status = 'passed';
  } catch (error) {
    proof.failureStage = error.emptyProfileStage ?? stage;
    if (error.ownedMacProcessesStopped === true) proof.ownedProcessesStopped = true;
  } finally {
    if (active) { try { proof.ownedProcessesStopped = await stopOwnedMacSharingApp(active); } catch { proof.ownedProcessesStopped = false; proof.status = 'failed'; } }
  }
  return proof;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let proof;
  try { proof = await runEmptyProfileSmoke({ ...parseEmptyProfileArguments(process.argv.slice(2)), intake: JSON.parse(process.env.EMPTY_PROFILE_INTAKE ?? '{}') }); }
  catch { proof = { schemaVersion: 'tibotattle-signed-macos-empty-profile-v1', status: 'failed', failureStage: 'arguments' }; }
  process.stdout.write(JSON.stringify(proof) + '\n');
  if (proof.status === 'failed') process.exitCode = 1;
}
