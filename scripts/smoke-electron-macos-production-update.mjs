#!/usr/bin/env node
// Post-activation acceptance only. No feed overrides, signing changes or candidate installation by this runner.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, lstat, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSparkleTransitionHost, captureMacTransitionProcesses, stopVerifiedMacTransitionProcesses,
  assertExtractedSignedMacBundle, verifySparkleTransitionCandidate, signedMacTransitionEnvironment,
  selectMacTransitionApplicationProcess, readMacTransitionProcesses, macTransitionProcessFingerprint,
  normalizeMacTransitionProcessStart } from './smoke-electron-macos-sparkle-transition.mjs';
import { launchVerifiedMacSharingApp, stopOwnedMacSharingApp } from './run-signed-electron-staging.mjs';
import { seedSignedReplacementNativeState, readSignedReplacementState,
  assertSignedReplacementContinuity } from './smoke-electron-macos-replacement.mjs';
import { parseWindowsUpdaterYaml } from './verify-electron-windows-update-artifacts.mjs';
import { validateProductionDistributionMetadata } from '../apps/electron/desktop-updater.js';
import { macOSCredentialApplicationVerificationArguments } from '../apps/electron/desktop-macos-keychain.js';
import { inspectNativeElectronHandoverCompletion } from '../apps/electron/desktop-native-migration.js';
import { compareAppleMacOSBundleVersions, resolveSignedMacOSBundleVersion } from './macos-bundle-version.js';
import { resolveMacOSProductionUpdatePredecessor } from './lib/electron-macos-qualification-identity.mjs';

export const ELECTRON_PRODUCTION_UPDATE_SCHEMA = 'tibotattle-signed-macos-production-update-v1';
export const ELECTRON_PRODUCTION_UPDATE_SCHEMA_V2 = 'tibotattle-signed-macos-production-update-v2';
export const ELECTRON_PRODUCTION_UPDATE_SCHEMA_V3 = 'tibotattle-signed-macos-production-update-v3';
const currentProductionUpdateRoute = input => ['tibotattle-production-electron-update-intake-v2',
  'tibotattle-production-electron-update-intake-v3'].includes(input.schemaVersion);
const ELECTRON_020 = resolveMacOSProductionUpdatePredecessor({ schemaVersion: 'tibotattle-production-electron-update-intake-v1' });
export const ELECTRON_020_SOURCE = ELECTRON_020.sourceRevision;
export const ELECTRON_020_DMG = ELECTRON_020.dmgSha256;
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
export function productionUpdateFailureStage(error, stage) {
  const launchStages = ['process_group', 'native_intro', 'owned_debugger', 'dashboard_target', 'dashboard_ready', 'settings_target', 'settings_ready'];
  if (['predecessor_baseline', 'controlled_restart'].includes(stage) && launchStages.includes(error?.signedLaunchStage)) {
    return stage + '_' + error.signedLaunchStage;
  }
  const replacementStages = ['database_integrity', 'retained_state_changed', 'preferences_changed', 'opt_out_changed',
    'unsafe_path', 'unsafe_file', 'changed_file'];
  if (replacementStages.includes(error?.replacementStage)) return stage + '_' + error.replacementStage;
  return error?.updateStage ?? error?.transitionStage ?? stage;
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
    || !Object.hasOwn(ELECTRON_020_DMG, value.target)
    || typeof value.bundleVersion !== 'string' || value.bundleVersion !== resolveSignedMacOSBundleVersion(value.version, 'stable')
    || compareAppleMacOSBundleVersions('1026', value.bundleVersion) !== -1
    || typeof value.sourceRevision !== 'string' || !/^[0-9a-f]{40}$/u.test(value.sourceRevision)
    || typeof value.buildNumber !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(value.buildNumber)
    || !['dmgSha256', 'asarSha256', 'zipSha256', 'feedSha256', 'predecessorAsarSha256'].every(k => typeof value[k] === 'string' && SHA.test(value[k]))
    || !isAbsolute(value.directory ?? '') || /[\0\r\n]/u.test(value.directory)) fail('intake');
  let predecessor;
  try { predecessor = resolveMacOSProductionUpdatePredecessor(value); } catch { fail('intake'); }
  if (predecessor.successorVersion && compareAppleMacOSBundleVersions(predecessor.bundleVersion, value.bundleVersion) !== -1) fail('intake');
  const architecture = value.target === 'darwin-arm64' ? 'arm64' : 'x64';
  const feedBase = 'https://updates.tibotattle.com/electron/stable/' + value.target;
  const file = version => 'TiboTattle-' + version + '-mac-' + architecture;
  return { ...value, architecture, directory: resolve(value.directory), feedBase,
    feedUrl: feedBase + '/latest-mac.yml', zipFileName: file(value.version) + '.zip',
    dmgFileName: file(value.version) + '.dmg', predecessorDmgSha256: predecessor.dmgSha256[value.target],
    predecessorUrl: 'https://github.com/adamallcock/tibotattle/releases/download/v' + predecessor.version + '/' + file(predecessor.version) + '.dmg',
    candidateUrl: 'https://github.com/adamallcock/tibotattle/releases/download/v' + value.version + '/' + file(value.version) + '.dmg' };
}
export function validateProductionMacUpdateFeed(input, manifest, zip, dmg) {
  const entries = manifest?.files;
  if (manifest?.version !== input.version || !Array.isArray(entries) || entries.length !== 2
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
async function absent(path, stage = 'preexisting_state') {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; } fail(stage);
}
async function bytes(path, limit = 1024 ** 3) {
  await safePath(path); const s = await lstat(path);
  if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid() || s.size < 1 || s.size > limit) fail('unsafe_file');
  return readFile(path);
}
// v3 seeds real predecessor ingestion provenance before any app launch. The
// retired usage source exercises retained history; the metadata-only source
// keeps ordinary local analysis available without adding usage or quota facts.
export async function seedProductionUpdateRetainedNativeState(nativeRoot, codexHome, index, ingest) {
  if (typeof ingest !== 'function') fail('predecessor_fixture_api');
  const sessions = join(codexHome, 'sessions');
  await safePath(sessions);
  for (const path of [codexHome, sessions]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('predecessor_fixture_location');
  }
  const preliminary = await seedSignedReplacementNativeState(nativeRoot, codexHome, index);
  const stamp = offset => new Date(Date.parse('2026-08-01T00:00:00Z') + offset * 1000).toISOString();
  const metadata = id => ({ timestamp: stamp(0), type: 'session_meta', payload: { id } });
  const source = join(sessions, 'rollout-2026-08-01T00-00-00-11111111-1111-4111-8111-111111111111.jsonl');
  const sentinel = join(sessions, 'rollout-2026-08-01T00-00-00-22222222-2222-4222-8222-222222222222.jsonl');
  const totals = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  const rows = [metadata('11111111-1111-4111-8111-111111111111'),
    { timestamp: stamp(0), type: 'turn_context', payload: { model: 'gpt-5.6-sol', effort: 'medium' } }];
  for (let i = 1; i <= 2; i += 1) {
    const usage = { input_tokens: 300 + i, cached_input_tokens: 200, cache_write_input_tokens: 0,
      output_tokens: 7, reasoning_output_tokens: 2, total_tokens: 307 + i };
    for (const key of Object.keys(totals)) totals[key] += usage[key];
    rows.push({ timestamp: stamp(i), type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: { ...totals }, last_token_usage: usage },
      rate_limits: { limit_id: 'codex', plan_type: 'plus', primary: { used_percent: 40 + i,
        window_minutes: 300, resets_at: Date.parse('2026-08-02T00:00:00Z') / 1000 } } } });
  }
  const sourceBytes = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(source, sourceBytes, { flag: 'wx', mode: 0o600 });
  const owned = await lstat(source);
  await writeFile(sentinel, JSON.stringify(metadata('22222222-2222-4222-8222-222222222222')) + '\n', { flag: 'wx', mode: 0o600 });
  const options = { codexHome, indexFile: join(nativeRoot, 'local-unified-index-v1.sqlite'),
    secretFile: join(nativeRoot, 'local-unified-index-device-salt-v1'), contractVersion: 'telemetry-contribution-v0.1' };
  const assertGeneration = (result, discoveredSourceCount) => {
    const generation = result?.generation;
    if (result?.status !== 'ingested' || generation?.status !== 'complete' || generation.blockReason !== null
      || generation.discoveredSourceCount !== discoveredSourceCount || generation.indexedSourceCount !== 2
      || generation.usageEvents !== 2 || generation.quotaOccurrences !== 2
      || !['discoveryComplete', 'diagnosticsComplete', 'usageProvenanceComplete', 'sourceOrderComplete',
        'quotaProvenanceComplete', 'toolProvenanceComplete'].every(key => generation[key] === true)) fail('predecessor_fixture_generation');
  };
  assertGeneration(await ingest(options), 2);
  const before = await readSignedReplacementState(nativeRoot, index);
  if (before.usageRows !== 2 || before.quotaRows !== 2 || before.tokensInUncached !== 203
    || before.saltDigest !== preliminary.saltDigest || before.optOutDigest !== preliminary.optOutDigest) fail('predecessor_fixture_state');
  const current = await lstat(source);
  if (current.ino !== owned.ino || current.dev !== owned.dev || hash(await bytes(source, 4096)) !== hash(sourceBytes)) fail('predecessor_fixture_source');
  await rm(source); // Only this freshly created, unchanged synthetic source.
  assertGeneration(await ingest(options), 1);
  const retained = await readSignedReplacementState(nativeRoot, index);
  if (Object.keys(before).some(key => retained[key] !== before[key])) fail('predecessor_fixture_state');
  return retained;
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
export function selectCurrentProductionUpdateSuccessor(rows, executable, predecessorPid, predecessorProcesses) {
  if (!(predecessorProcesses instanceof Map) || !predecessorProcesses.has(predecessorPid)
    || [...predecessorProcesses].some(([pid, fingerprint]) => !Number.isSafeInteger(pid) || pid < 2
      || typeof fingerprint !== 'string' || fingerprint.split('\n').length !== 2
      || macTransitionProcessFingerprint({ command: fingerprint.split('\n')[0], startedAt: fingerprint.split('\n')[1] }) !== fingerprint)) fail('predecessor_process_identity');
  // Wait for every captured predecessor identity, including an orphaned old
  // companion, to exit naturally. Cleanup is not an updater success observation.
  for (const row of rows) if (predecessorProcesses.has(row.pid)) {
    const startedAt = normalizeMacTransitionProcessStart(row.startedAt);
    if (startedAt === null || predecessorProcesses.get(row.pid).split('\n')[1] === startedAt) return null;
  }
  return selectProductionUpdateSuccessor(rows.filter(row => !predecessorProcesses.has(row.pid)), executable,
    predecessorPid, new Set(predecessorProcesses.keys()));
}
const productionUpdateProcesses = () => readMacTransitionProcesses();
export function requestProductionUpdateInstall({ appPath, predecessorPid, knownProcesses, currentRoute, install }, {
  readProcesses = productionUpdateProcesses,
} = {}) {
  let captured;
  try { captured = captureMacTransitionProcesses(appPath, predecessorPid, knownProcesses, { readProcesses }); }
  catch { fail('predecessor_process_identity'); }
  const main = captured.find(row => row.pid === predecessorPid);
  if (!main || main.command !== join(appPath, 'Contents', 'MacOS', 'TiboTattle')
    || macTransitionProcessFingerprint(main) !== knownProcesses.get(predecessorPid)) fail('predecessor_process_identity');
  // Detached from subsequent cleanup captures. Validate the entire snapshot
  // before Install, so an unresolved identity cannot initiate an update.
  const predecessorProcesses = currentRoute ? new Map(knownProcesses) : new Set(knownProcesses.keys());
  if (currentRoute) selectCurrentProductionUpdateSuccessor(captured, main.command, predecessorPid, predecessorProcesses);
  else selectProductionUpdateSuccessor(captured, main.command, predecessorPid, predecessorProcesses);
  const request = install();
  request.catch(() => {}); // The predecessor can exit before its CDP response.
  return predecessorProcesses;
}
// v3 only: the verified 026 reader can admit its exact live v11 while the
// successor migrates a staging clone. The runner never opens a writable handle.
export async function readProductionUpdateSuccessorState(stateRoot, predecessorIndex) {
  let database;
  try {
    database = predecessorIndex.openLocalUnifiedIndex(join(stateRoot, 'local-unified-index-v1.sqlite'), { readOnly: true });
  } catch (error) {
    if (error?.code !== 'local_unified_index_schema_newer') throw error;
    const compatibility = error.compatibility;
    if (compatibility?.accessMode !== 'read' || compatibility.supportedUserVersion !== 11
      || compatibility.databaseUserVersion !== 12 || compatibility.formatUserVersion !== 12
      || compatibility.minimumReaderUserVersion !== 12 || compatibility.minimumWriterUserVersion !== 12
      || compatibility.requiredUserVersion !== 12) fail('successor_state_schema');
    // Every current-schema read, shape or integrity failure is terminal.
    return readSignedReplacementState(stateRoot);
  }
  try {
    const compatibility = predecessorIndex.readLocalUnifiedIndexCompatibility(database);
    if (compatibility.applicationId !== 1431131465 || compatibility.userVersion !== 11
      || compatibility.formatUserVersion !== 11 || compatibility.minimumReaderUserVersion !== 11
      || compatibility.minimumWriterUserVersion !== 11 || compatibility.metadataPresent !== true
      || compatibility.metadataPartial !== false || compatibility.metadataMalformed !== false
      || database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value !== 'local-unified-index-v2') {
      fail('successor_state_schema');
    }
    if (database.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') fail('successor_state_database_integrity');
    return null;
  } finally { database.close(); }
}
export async function waitForProductionUpdateSuccessorState({ stateRoot, predecessorIndex, successorPid, successorFingerprint }, {
  readProcesses = productionUpdateProcesses, readState = readProductionUpdateSuccessorState,
  now = Date.now, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), onStage = () => {},
} = {}) {
  if (!Number.isSafeInteger(successorPid) || successorPid < 2 || typeof successorFingerprint !== 'string'
    || successorFingerprint.split('\n').length !== 2 || successorFingerprint.split('\n').some(part => !part)) {
    fail('successor_state_process_identity');
  }
  const identity = new Map([[successorPid, successorFingerprint]]), deadline = now() + 120000;
  const assertIdentity = async () => {
    onStage('successor_state_process_identity');
    const rows = (await readProcesses(identity)).filter(row => row.pid === successorPid);
    if (rows.length !== 1 || macTransitionProcessFingerprint(rows[0]) !== successorFingerprint) {
      fail('successor_state_process_identity');
    }
  };
  while (now() < deadline) {
    await assertIdentity();
    onStage('successor_state_read');
    const state = await readState(stateRoot, predecessorIndex);
    await assertIdentity();
    if (now() >= deadline) fail('successor_state_timeout');
    if (state !== null) return state;
    onStage('successor_state_readiness');
    await sleep(Math.max(0, Math.min(300, deadline - now())));
  }
  fail('successor_state_timeout');
}
export function refreshProductionUpdateArchiveIndex(appPath) {
  const loaded = createRequire(require.resolve('electron-builder'))('@electron/asar'), api = loaded?.default ?? loaded;
  // ASAR 3.4.1 caches headers by pathname. An in-place updater replaces this
  // archive after predecessor inspection; reread its actual signed header.
  if (typeof api.uncache !== 'function') fail('archive_cache_api');
  api.uncache(join(appPath, 'Contents', 'Resources', 'app.asar'));
}
// Call only after signed predecessor verification. Snapshot the same pinned ASAR
// before importing its public API; native/unpacked bytes are never sourced from
// beside the archive. If that API needs them, importing must fail closed.
export async function withProductionUpdatePredecessorIndex(input, appPath, useIndex) {
  if (!SHA.test(input.predecessorAsarSha256) || typeof useIndex !== 'function') fail('predecessor_fixture');
  await safePath(input.directory);
  const parent = await lstat(input.directory);
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o022)) fail('predecessor_fixture_location');
  const archiveBytes = await bytes(join(appPath, 'Contents', 'Resources', 'app.asar'), 512 * 1024 ** 2);
  if (hash(archiveBytes) !== input.predecessorAsarSha256) fail('predecessor_asar');
  const scratch = await mkdtemp(join(input.directory, 'predecessor-index-'));
  const owned = await lstat(scratch), archive = join(scratch, 'predecessor.asar'), extracted = join(scratch, 'app');
  const loaded = createRequire(require.resolve('electron-builder'))('@electron/asar'), api = loaded?.default ?? loaded;
  try {
    await writeFile(archive, archiveBytes, { flag: 'wx', mode: 0o600 });
    await mkdir(extracted, { mode: 0o700 });
    const entries = api.listPackage(archive);
    if (entries.length > 50000) fail('predecessor_fixture_archive');
    let total = 0;
    for (const entry of entries) {
      const name = entry.slice(1), parts = name.split('/');
      if (!entry.startsWith('/') || parts.some(part => !part || part === '.' || part === '..')
        || /[\\\0\r\n]/u.test(name)) fail('predecessor_fixture_archive');
      const item = api.statFile(archive, name, false);
      if (Object.hasOwn(item, 'link')) fail('predecessor_fixture_archive');
      if (item.unpacked) continue;
      const path = join(extracted, ...parts);
      if (Object.hasOwn(item, 'files')) await mkdir(path, { mode: 0o700 });
      else {
        if (!Number.isSafeInteger(item.size) || item.size < 0 || (total += item.size) > 512 * 1024 ** 2) fail('predecessor_fixture_archive');
        const content = api.extractFile(archive, name, false);
        if (content.length !== item.size) fail('predecessor_fixture_archive');
        await writeFile(path, content, { flag: 'wx', mode: 0o600 });
      }
    }
    const index = await import(pathToFileURL(join(extracted, 'src', 'local-unified-index.js')).href);
    const required = ['openLocalUnifiedIndex', 'createUnifiedIndexWriter', 'outcomeOrdinal', 'reasoningEffortOrdinal'];
    if (input.schemaVersion === 'tibotattle-production-electron-update-intake-v3') required.push('readLocalUnifiedIndexCompatibility');
    if (!required.every(name => typeof index[name] === 'function')) fail('predecessor_fixture_api');
    let ingest = null;
    if (input.schemaVersion === 'tibotattle-production-electron-update-intake-v3') {
      const source = await import(pathToFileURL(join(extracted, 'src', 'local-unified-index-ingest.js')).href);
      ingest = source.ingestLocalUnifiedIndexIncrement;
      if (typeof ingest !== 'function') fail('predecessor_fixture_api');
    }
    return await useIndex(index, ingest);
  } finally {
    api.uncache(archive);
    await safePath(scratch);
    const current = await lstat(scratch);
    if (!current.isDirectory() || current.ino !== owned.ino || current.dev !== owned.dev
      || current.uid !== process.getuid() || (current.mode & 0o077)) fail('predecessor_fixture_cleanup');
    await rm(scratch, { recursive: true });
  }
}
async function verifyPinnedPredecessor(input, appPath, predecessor) {
  const asar = join(appPath, 'Contents', 'Resources', 'app.asar');
  if (hash(await bytes(asar, 512 * 1024 ** 2)) !== input.predecessorAsarSha256) fail('predecessor_asar');
  command('/usr/bin/codesign', macOSCredentialApplicationVerificationArguments(appPath));
  command('/usr/sbin/spctl', ['--assess', '--type', 'execute', appPath]);
  const loaded = createRequire(require.resolve('electron-builder'))('@electron/asar'), api = loaded?.default ?? loaded;
  if (api.statFile(asar, 'package.json').size > 128 * 1024) fail('predecessor_metadata');
  const pkg = JSON.parse(api.extractFile(asar, 'package.json').toString('utf8'));
  const plist = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Contents', 'Info.plist')]));
  const distribution = validatePinnedPredecessorMetadata(input, pkg, plist, predecessor);
  const executable = join(appPath, 'Contents', 'MacOS', 'TiboTattle');
  if (command('/usr/bin/lipo', ['-archs', executable]) !== (input.architecture === 'arm64' ? 'arm64' : 'x86_64')) fail('predecessor_architecture');
  return { appPath, executable, distribution };
}
function validatePinnedPredecessorMetadata(input, pkg, plist, predecessor) {
  const distribution = validateProductionDistributionMetadata(pkg?.tibotattleDistribution, { platform: 'darwin', architecture: input.architecture });
  if (pkg.name !== 'app-usagemonitor' || pkg.version !== predecessor.version || distribution.sourceRevision !== predecessor.sourceRevision
    || distribution.buildNumber !== predecessor.buildNumber || distribution.target !== input.target || distribution.channel !== 'stable'
    || plist?.CFBundleIdentifier !== 'com.usagemonitor.local' || plist.CFBundleShortVersionString !== predecessor.version
    || plist.CFBundleVersion !== predecessor.bundleVersion) fail('predecessor_identity');
  return distribution;
}
// Retained public helper: the separate credential v1 lane still binds 0.1.20.
export async function verifyPredecessor(input, appPath) {
  return verifyPinnedPredecessor(input, appPath, ELECTRON_020);
}
export function validateProductionUpdatePredecessorMetadata(input, pkg, plist) {
  return validatePinnedPredecessorMetadata(input, pkg, plist, resolveMacOSProductionUpdatePredecessor(input));
}
export async function verifyProductionUpdatePredecessor(input, appPath) {
  return verifyPinnedPredecessor(input, appPath, resolveMacOSProductionUpdatePredecessor(input));
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
    if (currentProductionUpdateRoute(input)) {
      const predecessor = resolveMacOSProductionUpdatePredecessor(input);
      Object.assign(proof, { schemaVersion: input.schemaVersion === 'tibotattle-production-electron-update-intake-v3'
        ? ELECTRON_PRODUCTION_UPDATE_SCHEMA_V3 : ELECTRON_PRODUCTION_UPDATE_SCHEMA_V2, predecessorVersion: predecessor.version,
        predecessorBundleVersion: predecessor.bundleVersion, predecessorBuildNumber: predecessor.buildNumber,
        predecessorSourceRevision: predecessor.sourceRevision, predecessorProcessesExitedNaturally: false });
    }
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
    const verified = await verifyProductionUpdatePredecessor(input, app); proof.signedArtifactVerified = true;
    stage = 'predecessor_fixture';
    const { before, environment, stateRoot, settingsFile, sharing, predecessorIndex } = await withProductionUpdatePredecessorIndex(input, app, async (index, ingest) => {
      command('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app]);
      await mkdir(codex, { mode: 0o700 }); await mkdir(join(codex, 'sessions'), { mode: 0o700 });
      const seeded = input.schemaVersion === 'tibotattle-production-electron-update-intake-v3'
        ? await seedProductionUpdateRetainedNativeState(native, codex, index, ingest)
        : await seedSignedReplacementNativeState(native, codex, index);
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
      const before = await readSignedReplacementState(stateRoot, index);
      assertSignedReplacementContinuity(seeded, before, JSON.parse(await readFile(settingsFile)), sharing);
      await absent(join(stateRoot, 'accountless-device-binding-v1.json'));
      // The namespace's static dependencies remain loaded after owned scratch
      // removal; the v3 readiness probe uses only its read-only public API.
      return { before, environment, stateRoot, settingsFile, sharing, predecessorIndex: index };
    });
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
    const currentRoute = currentProductionUpdateRoute(input);
    const predecessorProcesses = requestProductionUpdateInstall({ appPath: app, predecessorPid: oldPid, knownProcesses, currentRoute,
      install: () => active.settings.evaluate('globalThis.tibotattleDesktop.installUpdateAndRestart()') });
    proof.installUpdateInvoked = true;
    stage = 'successor_process_poll';
    const successor = await until(() => {
      captureMacTransitionProcesses(app, oldPid, knownProcesses);
      const rows = productionUpdateProcesses(currentRoute ? predecessorProcesses : null);
      return (currentRoute ? selectCurrentProductionUpdateSuccessor : selectProductionUpdateSuccessor)(
        rows, verified.executable, oldPid, predecessorProcesses)?.pid ?? null;
    }, 180000, 'updater_relaunch');
    proof.successorPIDObserved = true; proof.successorWasPreexistingProcess = predecessorProcesses.has(successor);
    if (currentRoute) proof.predecessorProcessesExitedNaturally = true;
    stage = 'successor_archive_verification';
    input.candidateCodeDirectoryHash = await assertExtractedSignedMacBundle(candidateDmg, app, join(input.directory, 'successor-verification-mount'));
    stage = 'successor_signed_verification';
    refreshProductionUpdateArchiveIndex(app);
    await verifySparkleTransitionCandidate(input, app);
    stage = 'successor_process_capture';
    captureMacTransitionProcesses(app, successor, knownProcesses);
    const successorFingerprint = knownProcesses.get(successor);
    proof.updaterRelaunchedCandidate = true;
    stage = 'successor_session_detach';
    for (const session of active.sessions) { try { session.close(); } catch {} } active = null;
    // The updater-created launch must preserve state before any controlled restart.
    let successorState;
    if (input.schemaVersion === 'tibotattle-production-electron-update-intake-v3') {
      stage = 'successor_state_readiness';
      successorState = await waitForProductionUpdateSuccessorState({ stateRoot, predecessorIndex, successorPid: successor, successorFingerprint },
        { onStage: value => { stage = value; } });
    } else {
      stage = 'successor_state_read';
      successorState = await readSignedReplacementState(stateRoot);
    }
    stage = 'successor_settings_read';
    const successorSettings = JSON.parse(await readFile(settingsFile));
    stage = 'successor_continuity';
    assertSignedReplacementContinuity(before, successorState, successorSettings, sharing);
    stage = 'successor_binding_absence';
    await absent(join(stateRoot, 'accountless-device-binding-v1.json'), 'successor_binding_present');
    stage = 'successor_cleanup';
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
  } catch (error) {
    proof.failureStage = productionUpdateFailureStage(error, stage);
    proof.failureClassification = classifyProductionUpdateFailure(error);
    if (['predecessor_baseline', 'controlled_restart'].includes(stage) && error?.ownedMacProcessesStopped === true) {
      proof.ownedProcessesStopped = true;
    }
  }
  finally {
    if (active) { try { await stopOwnedMacSharingApp(active); } catch (error) { proof.status = 'failed'; proof.failureStage ??= 'cleanup'; proof.cleanupFailureClassification = classifyProductionUpdateFailure(error); } }
    if (app && input && knownProcesses.size) {
      try {
        proof.ownedProcessesStopped = await stopVerifiedMacTransitionProcesses({ appPath: app, knownProcesses,
          verifyApp: async path => {
            refreshProductionUpdateArchiveIndex(path);
            try { return await verifySparkleTransitionCandidate(input, path); }
            catch { return verifyProductionUpdatePredecessor(input, path); }
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
