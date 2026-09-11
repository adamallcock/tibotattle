#!/usr/bin/env node
// Post-activation acceptance only. No feed overrides, signing changes or candidate installation by this runner.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, lstat, readFile, writeFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSparkleTransitionHost, captureMacTransitionProcesses, stopVerifiedMacTransitionProcesses,
  assertExtractedSignedMacBundle, verifySparkleTransitionCandidate, signedMacTransitionEnvironment,
  selectMacTransitionApplicationProcess } from './smoke-electron-macos-sparkle-transition.mjs';
import { launchVerifiedMacSharingApp, stopOwnedMacSharingApp } from './run-signed-electron-staging.mjs';
import { seedSignedReplacementNativeState, readSignedReplacementState,
  assertSignedReplacementContinuity } from './smoke-electron-macos-replacement.mjs';
import { parseWindowsUpdaterYaml } from './verify-electron-windows-update-artifacts.mjs';
import { validateProductionDistributionMetadata } from '../apps/electron/desktop-updater.js';
import { macOSCredentialApplicationVerificationArguments } from '../apps/electron/desktop-macos-keychain.js';
import { inspectNativeElectronHandoverCompletion } from '../apps/electron/desktop-native-migration.js';

export const ELECTRON_PRODUCTION_UPDATE_SCHEMA = 'tibotattle-signed-macos-production-update-v1';
export const ELECTRON_020_SOURCE = 'f518126a05a6d165b9617f6417a87219d7047273';
export const ELECTRON_020_DMG = Object.freeze({
  'darwin-arm64': '50a1b89aff696ef3323ab48284aa820af7aad504397fbe88831c29ace2479f30',
  'darwin-x64': 'a63ec06036ddbc5a0e70dc59c6520a8ad5baa8c7a3a0fc4d3713a7f1f1523ecd',
});
const require = createRequire(import.meta.url), SHA = /^[0-9a-f]{64}$/u;
const fail = stage => { throw Object.assign(new Error('SIGNED_PRODUCTION_UPDATE_REFUSED'), { updateStage: stage }); };
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
export function classifyProductionUpdateFailure(error) {
  // Only fixed machine classifications; never emit commands, paths or stderr.
  const code = ['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'EEXIST', 'ENOSPC', 'EIO'].includes(error?.code) ? error.code : null;
  const exitCode = Number.isInteger(error?.status) && error.status >= 0 && error.status <= 255 ? error.status : null;
  const signal = ['SIGTERM', 'SIGKILL', 'SIGABRT'].includes(error?.signal) ? error.signal : null;
  return { code, exitCode, signal, kind: code ? 'system_error' : exitCode !== null ? 'command_exit' : signal ? 'command_signal' : 'unclassified' };
}

const command = (file, args, timeout = 30000) => execFileSync(file, args,
  { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 ** 2, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
export function parseProductionUpdateArguments(argv) {
  const execute = argv[0] === '--execute';
  if (!['--plan', '--execute'].includes(argv[0]) || argv[1] !== '--intake' || !isAbsolute(argv[2] ?? '')
    || (execute ? argv.length !== 5 || argv[3] !== '--confirm' || argv[4] !== 'RUN_DISPOSABLE_PRODUCTION_ELECTRON_UPDATE'
      : argv.length !== 3)) fail('arguments');
  return { execute, intakePath: resolve(argv[2]) };
}
export function validateProductionUpdateIntake(value) {
  const keys = ['schemaVersion', 'target', 'sourceRevision', 'buildNumber', 'version', 'bundleVersion',
    'dmgSha256', 'asarSha256', 'zipSha256', 'feedSha256', 'predecessorAsarSha256', 'directory'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== keys.sort().join('|')
    || value.schemaVersion !== 'tibotattle-production-electron-update-intake-v1'
    || !Object.hasOwn(ELECTRON_020_DMG, value.target) || value.version !== '0.1.21' || value.bundleVersion !== '1028'
    || typeof value.sourceRevision !== 'string' || !/^[0-9a-f]{40}$/u.test(value.sourceRevision)
    || typeof value.buildNumber !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(value.buildNumber)
    || !['dmgSha256', 'asarSha256', 'zipSha256', 'feedSha256', 'predecessorAsarSha256'].every(k => typeof value[k] === 'string' && SHA.test(value[k]))
    || !isAbsolute(value.directory ?? '') || /[\0\r\n]/u.test(value.directory)) fail('intake');
  const architecture = value.target === 'darwin-arm64' ? 'arm64' : 'x64';
  const feedBase = 'https://updates.tibotattle.com/electron/stable/' + value.target;
  const file = version => 'TiboTattle-' + version + '-mac-' + architecture;
  return { ...value, architecture, directory: resolve(value.directory), feedBase,
    feedUrl: feedBase + '/latest-mac.yml', zipFileName: file(value.version) + '.zip',
    dmgFileName: file(value.version) + '.dmg', predecessorDmgSha256: ELECTRON_020_DMG[value.target],
    predecessorUrl: 'https://github.com/adamallcock/tibotattle/releases/download/v0.1.20/' + file('0.1.20') + '.dmg',
    candidateUrl: 'https://github.com/adamallcock/tibotattle/releases/download/v0.1.21/' + file(value.version) + '.dmg' };
}
export function validateProductionMacUpdateFeed(input, manifest, zip, dmg) {
  const entries = manifest?.files;
  if (manifest?.version !== '0.1.21' || !Array.isArray(entries) || entries.length !== 2
    || manifest.path !== input.zipFileName || Object.hasOwn(manifest, 'packages')) fail('feed_identity');
  for (const [name, bytes] of [[input.zipFileName, zip], [input.dmgFileName, dmg]]) {
    const selected = entries.filter(entry => entry.url === name);
    if (selected.length !== 1 || selected[0].size !== bytes.length
      || selected[0].sha512 !== hash(bytes, 'sha512', 'base64')) fail('feed_artifact');
  }
  if (manifest.sha512 !== hash(zip, 'sha512', 'base64') || hash(zip) !== input.zipSha256
    || hash(dmg) !== input.dmgSha256) fail('feed_artifact');
  return true;
}
async function safePath(path) {
  for (let p = resolve(path);;) {
    if ((await lstat(p)).isSymbolicLink()) fail('unsafe_path');
    const parent = dirname(p); if (parent === p) break; p = parent;
  }
  if (await realpath(path) !== resolve(path)) fail('unsafe_path');
}
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; } fail('preexisting_state');
}
async function bytes(path, limit = 1024 ** 3) {
  await safePath(path); const s = await lstat(path);
  if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid() || s.size < 1 || s.size > limit) fail('unsafe_file');
  return readFile(path);
}
async function fetchBytes(url, limit, github = false) {
  let selected = new URL(url);
  for (let redirect = 0; redirect < 4; redirect++) {
    if (selected.protocol !== 'https:' || selected.username || selected.password
      || !(github ? ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(selected.hostname)
        : selected.origin === 'https://updates.tibotattle.com')) fail('download_url');
    const response = await fetch(selected, { redirect: 'manual', signal: AbortSignal.timeout(120000) });
    if ([301, 302, 303, 307, 308].includes(response.status) && github) {
      selected = new URL(response.headers.get('location'), selected); await response.body?.cancel(); continue;
    }
    if (!response.ok || +response.headers.get('content-length') > limit) fail('download');
    const chunks = []; let length = 0;
    for await (const chunk of response.body) { length += chunk.length; if (length > limit) fail('download_size'); chunks.push(chunk); }
    if (!length) fail('download_empty'); return Buffer.concat(chunks);
  }
  fail('download_redirect');
}
async function until(check, timeout, stage) {
  const deadline = Date.now() + timeout;
  do { const result = await check(); if (result) return result; await new Promise(r => setTimeout(r, 300)); } while (Date.now() < deadline);
  fail(stage);
}
export function selectProductionUpdateSuccessor(rows, executable, predecessorPid, predecessorProcesses) {
  if (!Number.isSafeInteger(predecessorPid) || predecessorPid < 2 || !(predecessorProcesses instanceof Set)
    || !predecessorProcesses.has(predecessorPid)) fail('predecessor_process_identity');
  // The old Node companion may outlive its parent and become a root itself.
  // A PID already present before Install is never the updater-created successor.
  if (rows.some(row => row.pid === predecessorPid)) return null;
  return selectMacTransitionApplicationProcess(rows.filter(row => !predecessorProcesses.has(row.pid)), executable);
}
function productionUpdateProcesses() {
  return command('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,comm=']).split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) fail('process_inventory');
    return { pid: +match[1], parent: +match[2], group: +match[3], command: match[4] };
  });
}
async function verifyPredecessor(input, appPath) {
  const asar = join(appPath, 'Contents', 'Resources', 'app.asar');
  if (hash(await bytes(asar, 512 * 1024 ** 2)) !== input.predecessorAsarSha256) fail('predecessor_asar');
  command('/usr/bin/codesign', macOSCredentialApplicationVerificationArguments(appPath));
  command('/usr/sbin/spctl', ['--assess', '--type', 'execute', appPath]);
  const loaded = createRequire(require.resolve('electron-builder'))('@electron/asar'), api = loaded?.default ?? loaded;
  if (api.statFile(asar, 'package.json').size > 128 * 1024) fail('predecessor_metadata');
  const pkg = JSON.parse(api.extractFile(asar, 'package.json').toString('utf8'));
  const distribution = validateProductionDistributionMetadata(pkg.tibotattleDistribution, { platform: 'darwin', architecture: input.architecture });
  const plist = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Contents', 'Info.plist')]));
  if (pkg.name !== 'app-usagemonitor' || pkg.version !== '0.1.20' || distribution.sourceRevision !== ELECTRON_020_SOURCE
    || distribution.buildNumber !== '2026091104' || distribution.target !== input.target || distribution.channel !== 'stable'
    || plist.CFBundleIdentifier !== 'com.usagemonitor.local' || plist.CFBundleShortVersionString !== '0.1.20'
    || plist.CFBundleVersion !== '2026091104') fail('predecessor_identity');
  const executable = join(appPath, 'Contents', 'MacOS', 'TiboTattle');
  if (command('/usr/bin/lipo', ['-archs', executable]) !== (input.architecture === 'arm64' ? 'arm64' : 'x86_64')) fail('predecessor_architecture');
  return { appPath, executable, distribution };
}
async function copyPredecessor(dmg, app, mount) {
  await mkdir(mount, { mode: 0o700 });
  command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg], 90000);
  try { command('/usr/bin/ditto', [join(mount, 'TiboTattle.app'), app], 120000); }
  finally { command('/usr/bin/hdiutil', ['detach', mount], 90000); }
}
export async function runProductionUpdate(options) {
  const proof = { schemaVersion: ELECTRON_PRODUCTION_UPDATE_SCHEMA, status: 'failed', predecessorVersion: '0.1.20',
    predecessorBundleVersion: '2026091104', feedScope: 'production_feed', feedOverrideApplied: false,
    productionFeedVerified: false, signedArtifactVerified: false, disposableAccountVerified: false,
    checkForUpdatesInvoked: false, updateDiscoveredAutomatically: false, downloadUpdateInvoked: false, installUpdateInvoked: false,
    updaterRelaunchedCandidate: false, candidateCopiedByRunner: false, retainedRowsPreserved: false,
    preferencesPreserved: false, saltPreserved: false, optOutPreserved: false, restartNoDuplicates: false,
    ownedProcessesStopped: false, existingCredentialFixture: false, failureStage: null, failureClassification: null,
    successorPIDObserved: false, successorWasPreexistingProcess: null, cleanupFailureClassification: null };
  let input, app, active, stage = 'intake'; const knownProcesses = new Map();
  try {
    input = validateProductionUpdateIntake(JSON.parse(await bytes(options.intakePath, 16384)));
    for (const key of ['target', 'sourceRevision', 'version', 'buildNumber', 'bundleVersion', 'dmgSha256', 'asarSha256',
      'zipSha256', 'feedSha256', 'predecessorAsarSha256', 'predecessorDmgSha256']) proof[key] = input[key];
    if (!options.execute) return { ...proof, status: 'planned' };
    const home = validateSparkleTransitionHost({ target: input.target, platform: process.platform, architecture: process.arch,
      nodeVersion: process.version, environment: process.env, account: userInfo() });
    const root = await realpath(process.env.RUNNER_TEMP), child = relative(root, input.directory);
    if (!child || child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) fail('intake_location');
    await safePath(input.directory); proof.disposableAccountVerified = true;
    stage = 'fixed_production_feed';
    const feed = await fetchBytes(input.feedUrl, 65536);
    if (hash(feed) !== input.feedSha256) fail('production_feed_digest');
    const zip = await fetchBytes(input.feedBase + '/' + input.zipFileName, 1024 ** 3);
    const candidate = await fetchBytes(input.candidateUrl, 1024 ** 3, true);
    validateProductionMacUpdateFeed(input, parseWindowsUpdaterYaml(feed), zip, candidate);
    const predecessor = await fetchBytes(input.predecessorUrl, 1024 ** 3, true);
    if (hash(predecessor) !== input.predecessorDmgSha256) fail('predecessor_digest');
    const predecessorDmg = join(input.directory, 'predecessor.dmg'), candidateDmg = join(input.directory, 'candidate.dmg');
    await writeFile(predecessorDmg, predecessor, { flag: 'wx', mode: 0o600 });
    await writeFile(candidateDmg, candidate, { flag: 'wx', mode: 0o600 });
    proof.productionFeedVerified = true;
    const support = join(home, 'Library', 'Application Support'), native = join(support, 'Usage Monitor');
    const profile = join(support, 'TiboTattle'), codex = join(home, '.codex'), applications = join(home, 'Applications');
    app = join(applications, 'TiboTattle.app');
    stage = 'fresh_host';
    for (const path of [native, profile, codex, app, '/Applications/TiboTattle.app', join(support, 'TiboTattle Native Handover'),
      join(support, 'app-usagemonitor')]) await absent(path);
    if (/\/TiboTattle[^/]*\.app\//u.test(command('/bin/ps', ['-axo', 'comm=']))) fail('preexisting_process');
    await mkdir(applications, { recursive: true, mode: 0o700 }); await safePath(applications);
    const folder = await lstat(applications);
    if (folder.uid !== process.getuid() || (folder.mode & 0o022)) fail('application_location');
    await copyPredecessor(predecessorDmg, app, join(input.directory, 'install-mount'));
    await assertExtractedSignedMacBundle(predecessorDmg, app, join(input.directory, 'predecessor-verification-mount'));
    const verified = await verifyPredecessor(input, app); proof.signedArtifactVerified = true;
    command('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app]);
    await mkdir(codex, { mode: 0o700 }); await mkdir(join(codex, 'sessions'), { mode: 0o700 });
    const seeded = await seedSignedReplacementNativeState(native, codex);
    for (const [key, kind, value] of [['tibotattle.language-preference.v1', '-string', 'es'],
      ['tibotattle.appearance.v1', '-string', 'dark'], ['tibotattle.refresh-interval.v1', '-int', '900']]) {
      command('/usr/bin/defaults', ['write', 'com.usagemonitor.local', key, kind, value]);
    }
    const temporary = join(input.directory, 'runtime'); await mkdir(temporary, { mode: 0o700 });
    const environment = signedMacTransitionEnvironment({ target: input.target, home, temporaryDirectory: temporary });
    stage = 'predecessor_baseline';
    active = await launchVerifiedMacSharingApp(verified, environment, { launchServices: true });
    captureMacTransitionProcesses(app, active.pid, knownProcesses);
    await until(async () => (await inspectNativeElectronHandoverCompletion({ userDataRoot: profile })).status === 'completed', 120000, 'predecessor_migration');
    const stateRoot = join(profile, 'companion-state'), settingsFile = join(profile, 'desktop-settings', 'desktop-settings-v1.json');
    const sharing = await until(async () => { const value = await active.readSharing(); return value?.available && value?.current ? value : null; }, 30000, 'sharing');
    const before = await readSignedReplacementState(stateRoot);
    assertSignedReplacementContinuity(seeded, before, JSON.parse(await readFile(settingsFile)), sharing);
    await absent(join(stateRoot, 'accountless-device-binding-v1.json'));
    // Invoke the ordinary Settings APIs; only the signed main process owns the updater/feed.
    stage = 'check_update';
    const ready = await until(async () => {
      const value = (await active.settings.evaluate('globalThis.tibotattleDesktop.getSettings()'))?.about?.update;
      return value?.canCheck || value?.canInstall ? value : null;
    }, 180000, 'check_ready');
    if (ready.canInstall) proof.updateDiscoveredAutomatically = true;
    else {
      await active.settings.evaluate('void globalThis.tibotattleDesktop.checkForUpdates().catch(() => {}); true');
      proof.checkForUpdatesInvoked = true;
    }
    await until(async () => {
      const value = await active.settings.evaluate('globalThis.tibotattleDesktop.getSettings()');
      if (value?.about?.update?.status === 'error') fail('updater_error');
      return value?.about?.update?.canDownload || value?.about?.update?.canInstall;
    }, 90000, 'update_offer');
    let snapshot = await active.settings.evaluate('globalThis.tibotattleDesktop.getSettings()');
    if (!snapshot.about.update.canInstall) {
      await active.settings.evaluate('void globalThis.tibotattleDesktop.downloadUpdate().catch(() => {}); true'); proof.downloadUpdateInvoked = true;
    }
    await until(async () => (await active.settings.evaluate('globalThis.tibotattleDesktop.getSettings()'))?.about?.update?.canInstall,
      180000, 'update_download');
    // A changed production feed invalidates this exact-candidate acceptance before installation.
    if (hash(await fetchBytes(input.feedUrl, 65536)) !== input.feedSha256) fail('production_feed_changed');
    stage = 'install_update'; const oldPid = active.pid;
    captureMacTransitionProcesses(app, oldPid, knownProcesses);
    const predecessorProcesses = new Set(knownProcesses.keys());
    // The call can lose its CDP response when the updater exits the predecessor.
    const request = active.settings.evaluate('globalThis.tibotattleDesktop.installUpdateAndRestart()');
    proof.installUpdateInvoked = true; request.catch(() => {});
    stage = 'successor_process_poll';
    const successor = await until(() => {
      captureMacTransitionProcesses(app, oldPid, knownProcesses);
      return selectProductionUpdateSuccessor(productionUpdateProcesses(), verified.executable, oldPid, predecessorProcesses)?.pid ?? null;
    }, 180000, 'updater_relaunch');
    proof.successorPIDObserved = true; proof.successorWasPreexistingProcess = predecessorProcesses.has(successor);
    stage = 'successor_archive_verification';
    input.candidateCodeDirectoryHash = await assertExtractedSignedMacBundle(candidateDmg, app, join(input.directory, 'successor-verification-mount'));
    stage = 'successor_signed_verification';
    await verifySparkleTransitionCandidate(input, app);
    stage = 'successor_process_capture';
    captureMacTransitionProcesses(app, successor, knownProcesses);
    proof.updaterRelaunchedCandidate = true;
    for (const session of active.sessions) { try { session.close(); } catch {} } active = null;
    // The updater-created launch must preserve state before any controlled restart.
    assertSignedReplacementContinuity(before, await readSignedReplacementState(stateRoot), JSON.parse(await readFile(settingsFile)), sharing);
    await absent(join(stateRoot, 'accountless-device-binding-v1.json'));
    await stopVerifiedMacTransitionProcesses({ appPath: app, knownProcesses, verifyApp: path => verifySparkleTransitionCandidate(input, path) });
    stage = 'controlled_restart';
    active = await launchVerifiedMacSharingApp(await verifySparkleTransitionCandidate(input, app), environment, { launchServices: true });
    captureMacTransitionProcesses(app, active.pid, knownProcesses);
    const afterSharing = await until(async () => { const value = await active.readSharing(); return value?.available && value?.current ? value : null; }, 30000, 'sharing_after');
    assertSignedReplacementContinuity(before, await readSignedReplacementState(stateRoot), JSON.parse(await readFile(settingsFile)), afterSharing);
    await absent(join(stateRoot, 'accountless-device-binding-v1.json'));
    await stopOwnedMacSharingApp(active); active = null;
    Object.assign(proof, { retainedRowsPreserved: true, saltPreserved: true, preferencesPreserved: true,
      optOutPreserved: true, restartNoDuplicates: true, status: 'passed' });
  } catch (error) { proof.failureStage = error?.updateStage ?? error?.transitionStage ?? stage; proof.failureClassification = classifyProductionUpdateFailure(error); }
  finally {
    if (active) { try { await stopOwnedMacSharingApp(active); } catch (error) { proof.status = 'failed'; proof.failureStage ??= 'cleanup'; proof.cleanupFailureClassification = classifyProductionUpdateFailure(error); } }
    if (app && input && knownProcesses.size) {
      try {
        proof.ownedProcessesStopped = await stopVerifiedMacTransitionProcesses({ appPath: app, knownProcesses,
          verifyApp: async path => {
            try { return await verifySparkleTransitionCandidate(input, path); }
            catch { return verifyPredecessor(input, path); }
          } });
      } catch (error) { proof.ownedProcessesStopped = false; proof.status = 'failed'; proof.failureStage ??= 'cleanup'; proof.cleanupFailureClassification = classifyProductionUpdateFailure(error); }
    }
  }
  return proof;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runProductionUpdate(parseProductionUpdateArguments(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = ['planned', 'passed'].includes(result.status) ? 0 : 1;
  } catch { process.stdout.write(JSON.stringify({ schemaVersion: ELECTRON_PRODUCTION_UPDATE_SCHEMA, status: 'failed', failureStage: 'arguments' }) + '\n'); process.exitCode = 1; }
}
