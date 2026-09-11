#!/usr/bin/env node
// Real native Check for Updates -> signed Electron replacement, on a disposable hosted Mac.
// The runner never copies the candidate into Applications and never alters either signed bundle.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedSignedReplacementNativeState,
  readSignedReplacementState, assertSignedReplacementContinuity } from './smoke-electron-macos-replacement.mjs';
import { retireAutomaticContributionState } from '../src/automatic-contribution-retirement.js';
import { launchVerifiedMacSharingApp, stopOwnedMacSharingApp } from './run-signed-electron-staging.mjs';
import { validateSignedSparkleFeed } from './sparkle-signed-feed-validation.js';
import { inspectNativeElectronHandoverCompletion } from '../apps/electron/desktop-native-migration.js';
import { macOSCredentialApplicationVerificationArguments } from '../apps/electron/desktop-macos-keychain.js';
import { validateProductionDistributionMetadata } from '../apps/electron/desktop-updater.js';
import distributionPolicy from '../config/electron-production-distribution.cjs';

export const NATIVE_SPARKLE_TRANSITION_SCHEMA = 'tibotattle-signed-macos-sparkle-transition-v1';
export const NATIVE_018_DMG_SHA256 = '2ea8eca02df7cc5210b6b6ce3d6e44016bffd9d081544a4efc6fa1afeeb0f1ae';
export const NATIVE_018_INTEL_DMG_SHA256 = '70630ba90e92a1cd8cb904e66e1aebe85b04e9d23a50bef7e4e41aca84c4d2f6';
const require = createRequire(import.meta.url);
const CONFIRMATION = 'RUN_DISPOSABLE_NATIVE_SPARKLE_TRANSITION';
const SHA = /^[0-9a-f]{64}$/u;
const SOURCE = /^[0-9a-f]{40}$/u;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (stage) => { throw Object.assign(new Error('SIGNED_SPARKLE_TRANSITION_REFUSED'), { transitionStage: stage }); };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function parseSparkleTransitionArguments(argv) {
  const executing = argv[0] === '--execute';
  if (!['--plan', '--execute'].includes(argv[0]) || argv[1] !== '--intake'
    || !isAbsolute(argv[2] ?? '') || (executing
      ? argv.length !== 5 || argv[3] !== '--confirm' || argv[4] !== CONFIRMATION
      : argv.length !== 3)) fail('arguments');
  return { execute: executing, intakePath: resolve(argv[2]) };
}

export function validateSparkleTransitionIntake(value) {
  const keys = ['schemaVersion', 'target', 'feedScope', 'sourceRevision', 'version', 'buildNumber', 'bundleVersion',
    'dmgSha256', 'asarSha256', 'feedSha256', 'nativeDmgSha256', 'directory'];
  if (!value || Object.keys(value).sort().join('|') !== keys.sort().join('|')
    || value.schemaVersion !== 'tibotattle-native-sparkle-test-intake-v1'
    || !['darwin-arm64', 'darwin-x64'].includes(value.target)
    || !['isolated_test_feed', 'production_feed'].includes(value.feedScope)
    || typeof value.sourceRevision !== 'string' || !SOURCE.test(value.sourceRevision) || value.version !== '0.1.21'
    || value.bundleVersion !== '1028' || typeof value.buildNumber !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(value.buildNumber)
    || ![value.dmgSha256, value.asarSha256, value.feedSha256].every((v) => typeof v === 'string' && SHA.test(v))
    || value.nativeDmgSha256 !== (value.target === 'darwin-arm64' ? NATIVE_018_DMG_SHA256 : NATIVE_018_INTEL_DMG_SHA256)
    || !isAbsolute(value.directory ?? '')) fail('intake');
  const directory = resolve(value.directory);
  const architecture = value.target === 'darwin-arm64' ? 'arm64' : 'x64';
  const production = value.feedScope === 'production_feed';
  const prefix = production ? (architecture === 'arm64' ? 'releases' : 'intel/releases')
    : 'electron/test/native-sparkle/' + value.sourceRevision;
  const baseUrl = 'https://updates.tibotattle.com/' + prefix + '/' + value.bundleVersion + '/' + value.dmgSha256;
  return { ...value, directory, architecture, objectPrefix: prefix,
    feedUrl: production ? 'https://updates.tibotattle.com/' + (architecture === 'arm64' ? '' : 'intel/') + 'appcast.xml' : baseUrl + '/appcast.xml',
    dmgFileName: 'TiboTattle-' + value.version + (architecture === 'arm64' ? '-mac-arm64.dmg' : '-macOS-x64.dmg'),
    dmgPath: join(directory, 'candidate.dmg'), nativeDmgPath: join(directory, 'native.dmg'),
    feedPath: join(directory, 'appcast.xml'), appPath: join(directory, 'candidate', 'TiboTattle.app'),
    nativeAppPath: join(directory, 'native', 'TiboTattle.app') };
}

export function validateSparkleTransitionHost({ target, platform, architecture, nodeVersion, environment, account }) {
  const expected = target === 'darwin-arm64' ? 'arm64' : target === 'darwin-x64' ? 'x64' : null;
  if (!expected || platform !== 'darwin' || architecture !== expected || nodeVersion !== 'v26.2.0'
    || environment.GITHUB_ACTIONS !== 'true' || environment.RUNNER_ENVIRONMENT !== 'github-hosted'
    || environment.RUNNER_OS !== 'macOS' || environment.RUNNER_ARCH !== (expected === 'arm64' ? 'ARM64' : 'X64')
    || account.uid !== 501 || account.username !== 'runner' || account.homedir !== '/Users/runner'
    || !isAbsolute(environment.RUNNER_TEMP ?? '')) fail('disposable_account');
  return account.homedir;
}

export function signedMacTransitionEnvironment({ target, home, temporaryDirectory }) {
  const selectedHome = validateSparkleTransitionHost({ target, platform: process.platform, architecture: process.arch,
    nodeVersion: process.version, environment: process.env, account: userInfo() });
  if (home !== selectedHome || !isAbsolute(temporaryDirectory ?? '')) fail('runtime_environment');
  const child = relative(resolve(process.env.RUNNER_TEMP), resolve(temporaryDirectory));
  if (!child || child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) fail('runtime_environment');
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: temporaryDirectory, LANG: 'en_US.UTF-8',
    GITHUB_ACTIONS: 'true', RUNNER_ARCH: target === 'darwin-arm64' ? 'ARM64' : 'X64',
    RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS' };
}

async function safePath(path) {
  let cursor = resolve(path);
  while (true) {
    if ((await lstat(cursor)).isSymbolicLink()) fail('unsafe_path');
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (await realpath(path) !== resolve(path)) fail('unsafe_path');
}
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fail('preexisting_state');
}
async function fileHash(path, maximum = 1024 ** 3) {
  await safePath(path);
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid()
    || before.size < 1 || before.size > maximum) fail('unsafe_file');
  const digest = createHash('sha256');
  for await (const part of createReadStream(path)) digest.update(part);
  const after = await lstat(path);
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs) fail('changed_file');
  return digest.digest('hex');
}
function command(file, args, timeout = 30000) {
  return execFileSync(file, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
function plist(app) {
  return JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')]));
}
function processes() {
  return command('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,comm=']).split('\n').map((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!m) fail('process_inventory');
    return { pid: +m[1], parent: +m[2], group: +m[3], command: m[4] };
  });
}
function appProcess(executable) {
  const found = processes().filter((row) => row.command === executable);
  if (found.length > 1) fail('multiple_owned_apps');
  return found[0] ?? null;
}
async function until(check, timeout, stage) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await sleep(500); }
  fail(stage);
}

// Targets only the already identity-checked synthetic process. No global keystrokes or prompt approval.
export function sparkleTransitionUiScript(pid, action) {
  if (!Number.isSafeInteger(pid) || pid < 2 || !['about', 'check', 'install', 'relaunch', 'quit', 'inspect'].includes(action)) fail('ui_arguments');
  return [
    'function run() {',
    'const matches = Application("System Events").applicationProcesses.whose({unixId:' + pid + '})();',
    'if (matches.length !== 1) return "process_absent";',
    'const p = matches[0];',
    'const action = ' + JSON.stringify(action) + ';',
    'function label(e) { try { return String(e.name()); } catch (_) { try { return String(e.title()); } catch (_) { return ""; } } }',
    'function press(e) { e.click(); return "clicked"; }',
    'if (action === "about" || action === "quit") {',
    '  p.frontmost = true;',
    '  const bars = p.menuBars(); if (bars.length < 1) return "menu_absent";',
    '  const items = bars[0].menuBarItems().filter(e => label(e) === "TiboTattle");',
    '  if (items.length !== 1) return "menu_absent"; items[0].click();',
    '  const menus = items[0].menus(); if (menus.length !== 1) return "menu_absent";',
    '  const names = action === "about" ? ["About TiboTattle","Acerca de TiboTattle"] : ["Quit TiboTattle","Salir de TiboTattle"];',
    '  const targets = menus[0].menuItems().filter(e => names.includes(label(e)));',
    '  return targets.length === 1 ? press(targets[0]) : "target_absent";',
    '}',
    'let elements = []; for (const w of p.windows()) elements = elements.concat(w.entireContents());',
    'const labels = {check:["Check for Updates…","Buscar actualizaciones…"],',
    '  install:["Install Update","Instalar actualización"], relaunch:["Install and Relaunch","Instalar y volver a abrir"]};',
    'if (action !== "inspect") {',
    '  const targets = elements.filter(e => { try { return e.role() === "AXButton" && labels[action].includes(label(e)) && e.enabled(); } catch (_) { return false; } });',
    '  if (targets.length === 1) return press(targets[0]);',
    '  if (targets.length > 1) return "ambiguous_target";',
    '}',
    'const text = elements.map(e => {try{return String(e.value());}catch(_){return "";}}).join(" ");',
    'if (/improperly signed|could not be validated/i.test(text)) return "signature_error";',
    'if (/up.to.date|versión más reciente/i.test(text)) return "no_update";',
    'if (/Keychain|keychain|llavero/.test(text)) return "keychain_dialog";',
    'return "target_absent";',
    '}',
  ].join('\n');
}
function ui(executable, pid, action) {
  const current = appProcess(executable);
  if (!current || current.pid !== pid) return 'process_absent';
  const result = command('/usr/bin/osascript', ['-l', 'JavaScript', '-e', sparkleTransitionUiScript(pid, action)], 10000);
  const allowed = ['clicked', 'process_absent', 'menu_absent', 'target_absent', 'ambiguous_target',
    'signature_error', 'no_update', 'keychain_dialog'];
  if (!allowed.includes(result)) fail('ui_result');
  if (['ambiguous_target', 'signature_error', 'no_update', 'keychain_dialog'].includes(result)) fail(result);
  return result;
}
function processFingerprint(row) {
  try { return row.command + '\n' + command('/bin/ps', ['-p', String(row.pid), '-o', 'lstart=']); }
  catch { return null; }
}
export function captureMacTransitionProcesses(appPath, verifiedPid, registry) {
  const rows = processes(), executable = join(appPath, 'Contents', 'MacOS', 'TiboTattle');
  if (verifiedPid !== null) {
    const main = rows.find((row) => row.pid === verifiedPid && row.command === executable);
    if (main) registry.set(main.pid, processFingerprint(main));
  }
  const owned = new Set(rows.filter((row) => registry.has(row.pid)
    && registry.get(row.pid) !== null && registry.get(row.pid) === processFingerprint(row)).map((row) => row.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (!owned.has(row.pid) && owned.has(row.parent)) {
      registry.set(row.pid, processFingerprint(row)); owned.add(row.pid); changed = true;
    }
  }
}
export async function stopVerifiedMacTransitionProcesses({ appPath, knownProcesses, verifyApp }) {
  const executable = join(appPath, 'Contents', 'MacOS', 'TiboTattle');
  const current = appProcess(executable);
  if (current) {
    // A Sparkle-created successor is admitted only after checking its actual signed bytes.
    await verifyApp(appPath);
    captureMacTransitionProcesses(appPath, current.pid, knownProcesses);
    try { ui(executable, current.pid, 'quit'); } catch { /* Controlled owned-process cleanup follows. */ }
  } else captureMacTransitionProcesses(appPath, null, knownProcesses);
  const remaining = () => processes().filter((row) => knownProcesses.has(row.pid)
    && knownProcesses.get(row.pid) !== null && knownProcesses.get(row.pid) === processFingerprint(row));
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const row of remaining()) {
      try { process.kill(row.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    try { await until(() => remaining().length === 0, 10000, 'owned_processes_remaining'); break; }
    catch { if (signal === 'SIGKILL') fail('owned_processes_remaining'); }
  }
  // Never equate the vanished predecessor PID with a stopped replacement/helper.
  if (appProcess(executable) || processes().some((row) => row.command.startsWith(appPath + '/')
    || /\/(?:TiboTattle[^/]*\.app|Sparkle\.framework)\//u.test(row.command))) fail('untracked_transition_process');
  return true;
}

function codeDirectoryHash(app) {
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', app],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 16384 });
  const matched = /^CDHash=([0-9a-f]{40,64})$/mu.exec(result.stderr ?? '');
  if (result.status !== 0 || result.error || !matched) fail('code_directory');
  return matched[1];
}
export async function assertExtractedSignedMacBundle(dmgPath, appPath, mount) {
  await mkdir(mount, { mode: 0o700 });
  command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmgPath], 90000);
  try {
    const archived = join(mount, 'TiboTattle.app');
    command('/usr/bin/codesign', macOSCredentialApplicationVerificationArguments(archived));
    const digest = codeDirectoryHash(archived);
    if (digest !== codeDirectoryHash(appPath)) fail('extracted_archive_mismatch');
    return digest;
  } finally { command('/usr/bin/hdiutil', ['detach', mount], 90000); }
}
async function verifyInputs(input) {
  if (await fileHash(input.nativeDmgPath) !== input.nativeDmgSha256
    || await fileHash(input.dmgPath) !== input.dmgSha256
    || await fileHash(input.feedPath, 1024 * 1024) !== input.feedSha256) fail('artifact_digest');
  const native = plist(input.nativeAppPath);
  if (native.CFBundleIdentifier !== 'com.usagemonitor.local' || native.CFBundleShortVersionString !== '0.1.18'
    || native.CFBundleVersion !== '1026' || native.SURequireSignedFeed !== true
    || typeof native.SUPublicEDKey !== 'string'
    || native.SUFeedURL !== 'https://updates.tibotattle.com/' + (input.architecture === 'arm64' ? '' : 'intel/') + 'appcast.xml') fail('native_identity');
  command('/usr/bin/codesign', macOSCredentialApplicationVerificationArguments(input.nativeAppPath));
  command('/usr/sbin/spctl', ['--assess', '--type', 'execute', input.nativeAppPath]);
  input.nativeCodeDirectoryHash = await assertExtractedSignedMacBundle(input.nativeDmgPath, input.nativeAppPath,
    join(input.directory, 'predecessor-verification-mount'));
  input.candidateCodeDirectoryHash = await assertExtractedSignedMacBundle(input.dmgPath, input.appPath,
    join(input.directory, 'candidate-verification-mount'));
  const verified = await verifyCandidate(input, input.appPath);
  const feed = validateSignedSparkleFeed({ architecture: input.architecture, appcastBytes: await readFile(input.feedPath),
    dmg: { bytes: await readFile(input.dmgPath), fileName: input.dmgFileName, sha256: input.dmgSha256 },
    objectPrefix: input.objectPrefix, updateOrigin: 'https://updates.tibotattle.com', publicEdKey: native.SUPublicEDKey });
  if (feed.bundleVersion !== input.bundleVersion || feed.shortVersion !== input.version
    || feed.minimumSystemVersion !== '14.0') fail('feed_identity');
  // Fresh read binds the URL the native updater will actually request.
  const response = await fetch(input.feedUrl, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1024 * 1024
    || hash(Buffer.from(await response.arrayBuffer())) !== input.feedSha256) fail('live_test_feed');
  return verified;
}
export async function verifySparkleTransitionCandidate(input, appPath) {
  const asar = join(appPath, 'Contents', 'Resources', 'app.asar');
  if (await fileHash(asar, 512 * 1024 ** 2) !== input.asarSha256) fail('asar_digest');
  command('/usr/bin/codesign', macOSCredentialApplicationVerificationArguments(appPath));
  command('/usr/sbin/spctl', ['--assess', '--type', 'execute', appPath]);
  if (input.candidateCodeDirectoryHash && codeDirectoryHash(appPath) !== input.candidateCodeDirectoryHash) fail('candidate_archive_mismatch');
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const loaded = builderRequire('@electron/asar'), api = loaded?.default ?? loaded;
  if (api.statFile(asar, 'package.json').size > 128 * 1024) fail('package_metadata');
  const manifest = JSON.parse(api.extractFile(asar, 'package.json').toString('utf8'));
  const distribution = validateProductionDistributionMetadata(manifest.tibotattleDistribution,
    { platform: 'darwin', architecture: input.architecture });
  if (manifest.name !== 'app-usagemonitor' || manifest.version !== input.version
    || distribution.sourceRevision !== input.sourceRevision || distribution.target !== input.target
    || distribution.channel !== distributionPolicy.PRODUCTION_ELECTRON_CHANNEL
    || distribution.contributionPolicy !== distributionPolicy.PRODUCTION_ELECTRON_CONTRIBUTION_POLICY
    || Object.keys(manifest).some((k) => k.startsWith('tibotattleAccountless'))) fail('distribution');
  const verified = { appPath, executable: join(appPath, 'Contents', 'MacOS', 'TiboTattle'), distribution };
  if (command('/usr/bin/lipo', ['-archs', verified.executable]) !== (input.architecture === 'arm64' ? 'arm64' : 'x86_64')) fail('architecture');
  const value = plist(appPath);
  distributionPolicy.assertProductionElectronMacOSBundleMetadata({ target: input.target,
    version: input.version, buildNumber: input.buildNumber, bundleVersion: value.CFBundleVersion,
    bundleShortVersion: value.CFBundleShortVersionString });
  if (value.CFBundleIdentifier !== 'com.usagemonitor.local' || value.LSMinimumSystemVersion !== '14.0'
    || verified.distribution.buildNumber !== input.buildNumber) fail('candidate_identity');
  return verified;
}
const verifyCandidate = verifySparkleTransitionCandidate;

export async function seedNativeSparkleTransitionState(nativeRoot, codexHome) {
  await seedSignedReplacementNativeState(nativeRoot, codexHome);
  // A running native 0.1.18 has already retired the older scheduler settings.
  // Preserve that disabled intent in its real schema before measuring continuity.
  const retired = await retireAutomaticContributionState({
    settingsFile: join(nativeRoot, 'private', 'automatic-contribution-v0.1.json'),
    now: () => new Date('2026-09-01T00:00:00.000Z'),
  });
  if (retired.priorState !== 'disabled' || retired.networkActivity !== false) fail('fixture_opt_out');
  return readSignedReplacementState(nativeRoot);
}

export async function runSparkleTransition(options) {
  const proof = { schemaVersion: NATIVE_SPARKLE_TRANSITION_SCHEMA, status: 'failed', nativeVersion: '0.1.18',
    nativeSparkleUpdateCompleted: false, productionFeedVerified: false,
    signedArtifactVerified: false, disposableAccountVerified: false, checkForUpdatesClicked: false,
    installUpdateClicked: false, updaterRelaunchedCandidate: false, candidateCopiedByRunner: false,
    migrationCompleted: false, retainedRowsPreserved: false, saltPreserved: false,
    preferencesPreserved: false, optOutPreserved: false, restartNoDuplicates: false,
    sourceUntouched: false, ownedProcessesStopped: false, existingCredentialFixture: false, failureStage: null };
  let active, installedExecutable, ownedPid, installedApp, selectedInput, stage = 'intake';
  const knownProcesses = new Map();
  try {
    await fileHash(options.intakePath, 16384);
    const input = validateSparkleTransitionIntake(JSON.parse(await readFile(options.intakePath, 'utf8')));
    selectedInput = input;
    let home;
    if (options.execute) home = validateSparkleTransitionHost({ target: input.target, platform: process.platform,
      architecture: process.arch, nodeVersion: process.version, environment: process.env, account: userInfo() });
    Object.assign(proof, { target: input.target, sourceRevision: input.sourceRevision, dmgSha256: input.dmgSha256,
      asarSha256: input.asarSha256, feedSha256: input.feedSha256, version: input.version, bundleVersion: input.bundleVersion,
      buildNumber: input.buildNumber, nativeDmgSha256: input.nativeDmgSha256, feedScope: input.feedScope, feedOverrideApplied: false });
    if (options.execute) {
      const temporaryRoot = await realpath(process.env.RUNNER_TEMP);
      const child = relative(temporaryRoot, input.directory);
      if (!child || child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) fail('intake_location');
      proof.disposableAccountVerified = true;
    }
    stage = 'artifact';
    await verifyInputs(input);
    proof.signedArtifactVerified = true;
    if (!options.execute) return { ...proof, status: 'prepared' };
    const appData = join(home, 'Library', 'Application Support'), nativeRoot = join(appData, 'Usage Monitor');
    const profile = join(appData, 'TiboTattle'), codex = join(home, '.codex');
    const applications = join(home, 'Applications'); installedApp = join(applications, 'TiboTattle.app');
    stage = 'fresh_host';
    for (const path of [nativeRoot, profile, codex, installedApp, '/Applications/TiboTattle.app',
      join(appData, 'TiboTattle Native Handover'), join(appData, 'app-usagemonitor')]) await absent(path);
    if (processes().some((p) => /\/(?:TiboTattle[^/]*\.app|Sparkle\.framework)\//u.test(p.command))) fail('preexisting_process');
    await mkdir(applications, { recursive: true, mode: 0o700 });
    await safePath(applications);
    const parent = await lstat(applications);
    if (parent.uid !== process.getuid() || (parent.mode & 0o022) !== 0) fail('application_location');
    // Only the verified predecessor is copied. Sparkle alone must place the candidate here.
    command('/usr/bin/ditto', [input.nativeAppPath, installedApp], 120000);
    command('/usr/bin/codesign', macOSCredentialApplicationVerificationArguments(installedApp));
    command('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', installedApp]);
    await mkdir(codex, { mode: 0o700 }); await mkdir(join(codex, 'sessions'), { mode: 0o700 });
    const seeded = await seedNativeSparkleTransitionState(nativeRoot, codex);
    const domain = 'com.usagemonitor.local';
    for (const [key, kind, value] of [['tibotattle.language-preference.v1', '-string', 'es'],
      ['tibotattle.appearance.v1', '-string', 'dark'], ['tibotattle.refresh-interval.v1', '-int', '900'],
      ['SUEnableAutomaticChecks', '-bool', 'false'],
      ['SUAutomaticallyUpdate', '-bool', 'false']]) command('/usr/bin/defaults', ['write', domain, key, kind, value]);
    if (input.feedScope === 'isolated_test_feed') {
      command('/usr/bin/defaults', ['write', domain, 'SUFeedURL', '-string', input.feedUrl]);
      proof.feedOverrideApplied = true;
    } else {
      const prior = spawnSync('/usr/bin/defaults', ['read', domain, 'SUFeedURL'], { encoding: 'utf8', timeout: 10000, maxBuffer: 16384 });
      if (prior.error || prior.status !== 1 || prior.stdout?.trim()) fail('preexisting_feed_override');
    }
    stage = 'native_launch';
    installedExecutable = join(installedApp, 'Contents', 'MacOS', 'TiboTattle');
    command('/usr/bin/open', ['-n', installedApp]);
    const original = await until(() => appProcess(installedExecutable), 60000, 'native_process');
    ownedPid = original.pid;
    captureMacTransitionProcesses(installedApp, ownedPid, knownProcesses);
    await until(() => ui(installedExecutable, ownedPid, 'about') === 'clicked', 60000, 'about_menu');
    stage = 'check_for_updates';
    await until(() => ui(installedExecutable, ownedPid, 'check') === 'clicked', 60000, 'check_button');
    proof.checkForUpdatesClicked = true;
    // Let the native startup collector settle before measuring retained rows.
    stage = 'update_offer';
    await until(() => {
      captureMacTransitionProcesses(installedApp, ownedPid, knownProcesses);
      return ui(installedExecutable, ownedPid, 'install') === 'clicked';
    }, 90000, 'update_offer');
    proof.installUpdateClicked = true;
    const before = await readSignedReplacementState(nativeRoot);
    if (JSON.stringify(seeded) !== JSON.stringify(before)) fail('native_seed_changed');
    // Native shutdown can checkpoint SQLite; compare records and hash the other files.
    const sourceFiles = ['local-unified-index-device-salt-v1',
      'launcher-settings-v1.json', 'first-run-v1.json', 'private/automatic-contribution-v0.1.json'];
    const sourceHashes = await Promise.all(sourceFiles.map((name) => fileHash(join(nativeRoot, name))));
    stage = 'sparkle_install';
    await until(() => {
      captureMacTransitionProcesses(installedApp, original.pid, knownProcesses);
      const current = appProcess(installedExecutable);
      if (current && current.pid !== original.pid) return current;
      if (current) ui(installedExecutable, original.pid, 'relaunch');
      return null;
    }, 180000, 'sparkle_relaunch');
    const relaunched = appProcess(installedExecutable);
    if (!relaunched || relaunched.pid === original.pid) fail('candidate_not_relaunched');
    ownedPid = relaunched.pid;
    await verifyCandidate(input, installedApp);
    captureMacTransitionProcesses(installedApp, ownedPid, knownProcesses);
    proof.updaterRelaunchedCandidate = true;
    stage = 'first_migration';
    await until(async () => (await inspectNativeElectronHandoverCompletion({ userDataRoot: profile })).status === 'completed', 120000, 'migration_incomplete');
    // Observe the first updater-created launch before a separately recorded controlled restart.
    const settingsPath = join(profile, 'desktop-settings', 'desktop-settings-v1.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    const after = await readSignedReplacementState(join(profile, 'companion-state'));
    for (const key of ['usageRows', 'quotaRows', 'tokensInUncached', 'recordDigest', 'saltDigest', 'optOutDigest']) {
      if (before[key] !== after[key]) fail('first_launch_continuity');
    }
    if (settings.language !== 'es' || settings.appearance !== 'dark' || settings.refreshIntervalSeconds !== 900) fail('first_launch_preferences');
    await absent(join(profile, 'companion-state', 'accountless-device-binding-v1.json'));
    proof.migrationCompleted = true; proof.nativeSparkleUpdateCompleted = true;
    await stopVerifiedMacTransitionProcesses({ appPath: installedApp, knownProcesses,
      verifyApp: (path) => verifyCandidate(input, path) }); ownedPid = null;
    const temporary = join(input.directory, 'runtime'); await mkdir(temporary, { mode: 0o700 });
    const environment = signedMacTransitionEnvironment({ target: input.target, home, temporaryDirectory: temporary });
    const verified = await verifyCandidate(input, installedApp);
    for (let iteration = 0; iteration < 2; iteration += 1) {
      stage = 'electron_restart';
      active = await launchVerifiedMacSharingApp(verified, environment, { launchServices: true });
      const sharing = await until(async () => {
        const value = await active.readSharing(); return value?.available && value?.current ? value : null;
      }, 30000, 'sharing_state');
      assertSignedReplacementContinuity(before, await readSignedReplacementState(join(profile, 'companion-state')),
        JSON.parse(await readFile(settingsPath, 'utf8')), sharing);
      await absent(join(profile, 'companion-state', 'accountless-device-binding-v1.json'));
      await stopOwnedMacSharingApp(active); active = null;
    }
    proof.retainedRowsPreserved = true; proof.saltPreserved = true; proof.preferencesPreserved = true;
    proof.optOutPreserved = true; proof.restartNoDuplicates = true;
    if (JSON.stringify(before) !== JSON.stringify(await readSignedReplacementState(nativeRoot))) fail('native_records_changed');
    if (JSON.stringify(sourceHashes) !== JSON.stringify(await Promise.all(sourceFiles.map((name) => fileHash(join(nativeRoot, name)))))) fail('native_source_changed');
    proof.sourceUntouched = true; proof.ownedProcessesStopped = true;
    proof.productionFeedVerified = input.feedScope === 'production_feed'; proof.status = 'passed';
  } catch (error) { proof.failureStage = error?.transitionStage ?? stage; }
  finally {
    if (active) {
      try { proof.ownedProcessesStopped = await stopOwnedMacSharingApp(active); }
      catch { proof.ownedProcessesStopped = false; proof.status = 'failed'; }
    }
    if (installedApp && selectedInput && knownProcesses.size) {
      try {
        proof.ownedProcessesStopped = await stopVerifiedMacTransitionProcesses({ appPath: installedApp, knownProcesses,
          verifyApp: async (path) => {
            if (plist(path).CFBundleShortVersionString === '0.1.18') {
              command('/usr/bin/codesign', macOSCredentialApplicationVerificationArguments(path));
              if (codeDirectoryHash(path) !== selectedInput.nativeCodeDirectoryHash) fail('native_cleanup_identity');
            } else await verifyCandidate(selectedInput, path);
          } });
      }
      catch { proof.ownedProcessesStopped = false; proof.status = 'failed'; }
    }
  }
  return proof;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const proof = await runSparkleTransition(parseSparkleTransitionArguments(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(proof) + '\n');
    if (!['passed', 'prepared'].includes(proof.status)) process.exitCode = 1;
  } catch { process.stderr.write('SIGNED_SPARKLE_TRANSITION_REFUSED\n'); process.exitCode = 1; }
}
