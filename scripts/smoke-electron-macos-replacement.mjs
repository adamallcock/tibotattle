#!/usr/bin/env node
// Ordinary signed-app launch against retained native state on a disposable Mac.
// Never runs on the operator's account or reads an existing user's history.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLocalUnifiedIndex, createUnifiedIndexWriter, outcomeOrdinal, reasoningEffortOrdinal } from '../src/local-unified-index.js';
import { macOSCredentialApplicationVerificationArguments } from '../apps/electron/desktop-macos-keychain.js';
import { validateCanaryManifest, validateCanaryHost } from './run-signed-electron-production-canary.mjs';
import { launchVerifiedMacSharingApp, stopOwnedMacSharingApp, signedStagingChildEnvironment } from './run-signed-electron-staging.mjs';
import { waitFor } from './smoke-electron-macos.mjs';
import { inspectNativeElectronHandoverCompletion } from '../apps/electron/desktop-native-migration.js';

const require = createRequire(import.meta.url);
const INDEX = 'local-unified-index-v1.sqlite';
const SALT = 'local-unified-index-device-salt-v1';
const CONFIRMATION = 'RUN_DISPOSABLE_SIGNED_REPLACEMENT';
const SHA = /^[0-9a-f]{64}$/u;
const EXPECTED = Object.freeze({ usageRows: 2, quotaRows: 2, tokensInUncached: 203,
  language: 'es', appearance: 'dark', refreshIntervalSeconds: 900, startAtLogin: false });
const fail = (stage) => { throw Object.assign(new Error('SIGNED_REPLACEMENT_REFUSED'), { replacementStage: stage }); };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function parseSignedReplacementArguments(argv) {
  if (!['--plan', '--execute'].includes(argv[0])) fail('arguments');
  const allowed = new Set(['--app', '--archive', '--archive-sha256', '--source-revision', '--asar-sha256', '--confirm']);
  const values = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || Object.hasOwn(values, argv[i]) || typeof argv[i + 1] !== 'string' || argv[i + 1].startsWith('--')) fail('arguments');
    values[argv[i]] = argv[i + 1];
  }
  if (!isAbsolute(values['--app'] ?? '') || basename(values['--app']) !== 'TiboTattle.app'
    || !isAbsolute(values['--archive'] ?? '') || !SHA.test(values['--archive-sha256'])
    || !SHA.test(values['--asar-sha256']) || !/^[0-9a-f]{40}$/u.test(values['--source-revision'])) fail('arguments');
  if (argv[0] === '--execute' ? values['--confirm'] !== CONFIRMATION : values['--confirm'] !== undefined) fail('confirmation');
  return { execute: argv[0] === '--execute', appPath: resolve(values['--app']), archivePath: resolve(values['--archive']),
    archiveSha256: values['--archive-sha256'], asarSha256: values['--asar-sha256'], sourceRevision: values['--source-revision'] };
}

async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  fail('preexisting_state');
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
async function fileHash(path, limit = 1024 ** 3) {
  await safePath(path);
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > limit) fail('unsafe_file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await lstat(path);
  if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('changed_file');
  return hash.digest('hex');
}
export async function verifySignedReplacementArtifact(options) {
  if (await fileHash(options.archivePath) !== options.archiveSha256) fail('archive_digest');
  const asar = join(options.appPath, 'Contents', 'Resources', 'app.asar');
  if (await fileHash(asar, 512 * 1024 ** 2) !== options.asarSha256) fail('asar_digest');
  execFileSync('/usr/bin/codesign', macOSCredentialApplicationVerificationArguments(options.appPath),
    { timeout: 30000, stdio: 'ignore' });
  execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', options.appPath], { timeout: 30000, stdio: 'ignore' });
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const loaded = builderRequire('@electron/asar');
  const api = loaded?.default ?? loaded;
  if (api.statFile(asar, 'package.json').size > 128 * 1024) fail('artifact_metadata');
  const manifest = JSON.parse(api.extractFile(asar, 'package.json').toString('utf8'));
  const distribution = validateCanaryManifest(manifest, options.sourceRevision);
  return { appPath: options.appPath, executable: join(options.appPath, 'Contents', 'MacOS', 'TiboTattle'), distribution };
}

// Typed, content-free records exercise the real SQLite schema, not a file named .sqlite.
export async function seedSignedReplacementNativeState(nativeRoot, codexHome) {
  await mkdir(nativeRoot, { mode: 0o700 });
  await mkdir(join(nativeRoot, 'private'), { mode: 0o700 });
  const files = {
    [SALT]: Buffer.alloc(32, 19),
    'launcher-settings-v1.json': JSON.stringify({ schemaVersion: 'usage-monitor-launcher-settings-v1', codexHome }) + '\n',
    'first-run-v1.json': JSON.stringify({ schemaVersion: 'usage-monitor-first-run-v1', acknowledged: true }) + '\n',
    'private/automatic-contribution-v0.1.json': JSON.stringify({ schemaVersion: 'automatic-contribution-settings-v0.1', enabled: false }) + '\n',
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(nativeRoot, name), bytes, { mode: 0o600, flag: 'wx' });
  const database = openLocalUnifiedIndex(join(nativeRoot, INDEX), { create: true });
  const writer = createUnifiedIndexWriter(database, { contractVersion: 'telemetry-contribution-v0.1' });
  const accountScopeId = writer.internAccountScope({ status: 'unavailable', reason: 'missing_account', planType: null, scopeLocal: null });
  const modelId = writer.internModel('gpt-5.6-sol', 'recognized');
  const tierId = writer.internTier({ apiServiceTier: 'unknown', billingSurface: 'chatgpt_subscription', codexSpeedMode: 'standard', tierSource: 'rollout_thread_settings', providerTierRaw: 'default' });
  const surfaceId = writer.internSurface({ agentScope: 'root', surface: 'extension_or_ide', threadSource: 'rollout', lineageDisposition: 'standalone' });
  const sessionLocal = Buffer.alloc(32, 23);
  writer.recordSessionIdentity(sessionLocal, '11111111-1111-4111-8111-111111111111');
  for (let i = 1; i <= 2; i += 1) {
    const observedAtMs = Date.parse('2026-08-01T00:00:00Z') + i * 1000;
    const quotaObservationId = writer.internQuota({ observedAtMs, limitId: 'codex', slot: 'primary', planType: 'plus', usedPercent: 40 + i, resetsAtMs: Date.parse('2026-08-02T00:00:00Z'), durationMins: 300 });
    writer.writeUsageEvent({ eventKey: Buffer.alloc(32, i), observedAtMs, sessionLocal, accountScopeId, modelId, tierId, surfaceId, quotaObservationId,
      reasoningEffort: reasoningEffortOrdinal('medium'), outcome: outcomeOrdinal('unknown'),
      tokensInUncached: 100 + i, tokensInCacheRead: 200, tokensInCacheWrite: null, tokensInCacheWrite5m: null,
      tokensInCacheWrite1h: null, tokensOutText: 5, tokensOutReasoning: 2, tokensOutCombined: null, totalInputContext: null });
  }
  await writer.close({ integrityCheck: true, fsyncPath: null });
  await chmod(join(nativeRoot, INDEX), 0o600);
  return readSignedReplacementState(nativeRoot);
}

export async function readSignedReplacementState(root) {
  const database = openLocalUnifiedIndex(join(root, INDEX), { readOnly: true });
  let rows;
  try {
    if (database.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('database_integrity');
    const usage = database.prepare('SELECT * FROM usage_event ORDER BY event_key').all();
    const quota = database.prepare('SELECT * FROM quota_observation ORDER BY id').all();
    rows = { usageRows: usage.length, quotaRows: quota.length,
      tokensInUncached: usage.reduce((sum, row) => sum + Number(row.tokens_in_uncached), 0),
      recordDigest: digest(JSON.stringify({ usage, quota }, (_key, value) => typeof value === 'bigint' ? value.toString() : value)) };
  } finally { database.close(); }
  return { ...rows, saltDigest: await fileHash(join(root, SALT)),
    optOutDigest: await fileHash(join(root, 'private', 'automatic-contribution-v0.1.json')) };
}
export function assertSignedReplacementContinuity(before, after, settings, sharing) {
  for (const key of ['usageRows', 'quotaRows', 'tokensInUncached', 'recordDigest', 'saltDigest', 'optOutDigest']) {
    if (before[key] !== after[key]) fail('retained_state_changed');
  }
  for (const key of ['language', 'appearance', 'refreshIntervalSeconds', 'startAtLogin']) {
    if (settings?.[key] !== EXPECTED[key]) fail('preferences_changed');
  }
  if (sharing?.enabled !== false || sharing?.transportStatus !== 'off' || sharing?.noticeDue !== false
    || sharing?.basis !== 'legacy_preserved') fail('opt_out_changed');
  return true;
}

export async function runSignedReplacement(options) {
  const proof = { schemaVersion: 'tibotattle-signed-macos-replacement-v1', status: 'failed',
    sourceRevision: options.sourceRevision, archiveSha256: options.archiveSha256, asarSha256: options.asarSha256,
    signedArtifactVerified: false, disposableAccountVerified: false, nativeAppAbsent: false,
    ordinaryApplicationLocation: false, launchServices: true, migrationCompleted: false,
    retainedRowsPreserved: false, saltPreserved: false, preferencesPreserved: false,
    optOutPreserved: false, restartNoDuplicates: false, sourceUntouched: false,
    enrollmentBindingAbsent: false, ownedProcessesStopped: false, failureStage: null };
  let active;
  let diagnosticProfile;
  let stage = 'artifact';
  try {
    let verified = await verifySignedReplacementArtifact(options);
    proof.signedArtifactVerified = true;
    if (!options.execute) return { ...proof, status: 'prepared' };
    stage = 'disposable_account';
    const home = validateCanaryHost({ platform: process.platform, architecture: process.arch,
      nodeVersion: process.version, environment: process.env, account: userInfo() });
    const temporaryRoot = await realpath(process.env.RUNNER_TEMP);
    const appRelative = relative(temporaryRoot, options.appPath);
    if (!appRelative || appRelative.startsWith('..' + sep) || appRelative === '..' || isAbsolute(appRelative)) fail('artifact_location');
    proof.disposableAccountVerified = true;
    const appData = join(home, 'Library', 'Application Support');
    await safePath(appData);
    const nativeRoot = join(appData, 'Usage Monitor');
    const profile = join(appData, 'TiboTattle');
    diagnosticProfile = profile;
    const codex = join(home, '.codex');
    for (const path of [nativeRoot, profile, codex, join(appData, 'app-usagemonitor'),
      '/Applications/TiboTattle.app', join(home, 'Applications', 'TiboTattle.app'), join(appData, 'TiboTattle Native Handover')]) await absent(path);
    proof.nativeAppAbsent = true;
    stage = 'install';
    const applications = join(home, 'Applications');
    await mkdir(applications, { recursive: true, mode: 0o700 });
    await safePath(applications);
    const applicationsStat = await lstat(applications);
    if (!applicationsStat.isDirectory() || applicationsStat.uid !== process.getuid() || (applicationsStat.mode & 0o022) !== 0) fail('application_location');
    const installedApp = join(applications, 'TiboTattle.app');
    execFileSync('/usr/bin/ditto', [options.appPath, installedApp], { timeout: 120000, stdio: 'ignore' });
    verified = await verifySignedReplacementArtifact({ ...options, appPath: installedApp });
    proof.ordinaryApplicationLocation = true;
    stage = 'seed';
    await mkdir(codex, { mode: 0o700 });
    await mkdir(join(codex, 'sessions'), { mode: 0o700 });
    const before = await seedSignedReplacementNativeState(nativeRoot, codex);
    const sourceFiles = [INDEX, SALT, 'launcher-settings-v1.json', 'first-run-v1.json', 'private/automatic-contribution-v0.1.json'];
    const sourceFileHashes = await Promise.all(sourceFiles.map((name) => fileHash(join(nativeRoot, name))));
    if (before.usageRows !== EXPECTED.usageRows || before.quotaRows !== EXPECTED.quotaRows || before.tokensInUncached !== EXPECTED.tokensInUncached) fail('fixture');
    // Only the disposable runner's native preferences are written. No Keychain entry is created.
    const domain = verified.distribution.appId;
    for (const [key, kind, value] of [['tibotattle.language-preference.v1', '-string', 'es'],
      ['tibotattle.appearance.v1', '-string', 'dark'], ['tibotattle.refresh-interval.v1', '-int', '900']]) {
      execFileSync('/usr/bin/defaults', ['write', domain, key, kind, value], { timeout: 10000, stdio: 'ignore' });
    }
    const temporary = join(temporaryRoot, 'signed-replacement-runtime');
    await mkdir(temporary, { mode: 0o700 });
    const environment = signedStagingChildEnvironment(process.env, home, temporary);
    const settingsPath = join(profile, 'desktop-settings', 'desktop-settings-v1.json');
    const bindingPath = join(profile, 'companion-state', 'accountless-device-binding-v1.json');
    let initialSettings;
    for (let run = 0; run < 2; run += 1) {
      stage = run === 0 ? 'first_launch' : 'restart';
      active = await launchVerifiedMacSharingApp(verified, environment, { launchServices: true, onFailure: async ({ pid }) => {
        // Read only closed dialog classifications from our synthetic process.
        const script = `function run() {
          const matches = Application('System Events').applicationProcesses.whose({ unixId: ${pid} })();
          if (matches.length !== 1) return 'process_absent';
          const content = matches[0].windows().map(w => w.entireContents().map(e => { try { return String(e.value()); } catch { return ''; } }).join(' ')).join(' ');
          if (content.includes('could not finish transferring')) return 'migration_blocked';
          if (content.includes('secure startup checks')) return 'credential_preflight_blocked';
          if (content.includes('Keychain') || content.includes('keychain')) return 'keychain_dialog';
          return 'unclassified';
        }`;
        try {
          const result = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script],
            { encoding: 'utf8', timeout: 10000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          proof.dialogClassification = ['process_absent', 'migration_blocked', 'credential_preflight_blocked', 'keychain_dialog', 'unclassified'].includes(result) ? result : 'unavailable';
        } catch { proof.dialogClassification = 'unavailable'; }
      } });
      const sharing = await waitFor(async () => { const value = await active.readSharing(); return value?.available && value?.current ? value : null; }, 30000, 'retained opt out');
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
      const after = await readSignedReplacementState(join(profile, 'companion-state'));
      assertSignedReplacementContinuity(before, after, settings, sharing);
      if (!settings.codexHomes?.activityRoots?.some((root) => root.path === codex && root.enabled === true)) fail('codex_home_changed');
      if (run === 0) initialSettings = digest(JSON.stringify(settings));
      else if (digest(JSON.stringify(settings)) !== initialSettings) fail('restart_settings_changed');
      await absent(bindingPath);
      const completion = await inspectNativeElectronHandoverCompletion({ userDataRoot: profile });
      if (completion.status !== 'completed') fail('migration_incomplete');
      proof.migrationCompleted = true;
      await stopOwnedMacSharingApp(active); active = null;
      if (run === 0) {
        proof.retainedRowsPreserved = true; proof.saltPreserved = true;
        proof.preferencesPreserved = true; proof.optOutPreserved = true;
      } else proof.restartNoDuplicates = true;
    }
    stage = 'source_preservation';
    const sourceAfter = await readSignedReplacementState(nativeRoot);
    if (JSON.stringify(before) !== JSON.stringify(sourceAfter)) fail('source_changed');
    const finalSourceHashes = await Promise.all(sourceFiles.map((name) => fileHash(join(nativeRoot, name))));
    if (JSON.stringify(sourceFileHashes) !== JSON.stringify(finalSourceHashes)) fail('source_changed');
    proof.sourceUntouched = true;
    proof.enrollmentBindingAbsent = true;
    proof.ownedProcessesStopped = true;
    proof.status = 'passed';
  } catch (error) {
    proof.failureStage = error?.replacementStage ?? stage;
    if (['process_group', 'owned_debugger', 'dashboard_target', 'dashboard_ready', 'settings_target', 'settings_ready'].includes(error?.signedLaunchStage)) proof.launchStage = error.signedLaunchStage;
    if (error?.ownedMacProcessesStopped === true) proof.ownedProcessesStopped = true;
    if (diagnosticProfile) {
      proof.migrationInspection = (await inspectNativeElectronHandoverCompletion({ userDataRoot: diagnosticProfile }).catch(() => ({ status: 'unavailable' }))).status;
      try {
        const journal = JSON.parse(await readFile(join(diagnosticProfile, '.native-electron-handover-v1', 'journal-v1.json'), 'utf8'));
        if (['started', 'prepared', 'backed_up', 'staged', 'published_state', 'published', 'electron_login_owned', 'completed'].includes(journal.phase)) proof.journalPhase = journal.phase;
      } catch { proof.journalPhase = 'absent_or_unreadable'; }
    }
  } finally {
    if (active) {
      try { proof.ownedProcessesStopped = await stopOwnedMacSharingApp(active); }
      catch { proof.ownedProcessesStopped = false; proof.status = 'failed'; }
    }
  }
  return proof;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const proof = await runSignedReplacement(parseSignedReplacementArguments(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(proof) + '\n');
    if (!['passed', 'prepared'].includes(proof.status)) process.exitCode = 1;
  } catch { process.stderr.write('SIGNED_REPLACEMENT_REFUSED\n'); process.exitCode = 1; }
}
