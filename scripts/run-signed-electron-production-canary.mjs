#!/usr/bin/env node
// Default: verify exact ordinary signed bytes and describe the pending canary.
// Execution requires explicit production approval; never exports a credential.
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, publicEncrypt, randomBytes, randomUUID, createCipheriv } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { macOSCredentialApplicationVerificationArguments } from '../apps/electron/desktop-macos-keychain.js';
import { validateProductionDistributionMetadata } from '../apps/electron/desktop-updater.js';
import { launchVerifiedMacSharingApp, stopOwnedMacSharingApp, signedStagingChildEnvironment, signedStagingFixture } from './run-signed-electron-staging.mjs';
import { waitFor } from './smoke-electron-macos.mjs';
import distributionPolicy from '../config/electron-production-distribution.cjs';

const ORIGIN = 'https://tibotattle.com';
const CONFIRMATION = 'RUN_ONE_SYNTHETIC_PRODUCTION_CANARY';
const SHA = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SCHEMA = 'tibotattle-production-canary-v1';
const require = createRequire(import.meta.url);
function fail(stage) { throw Object.assign(new Error('PRODUCTION_CANARY_REFUSED'), { canaryStage: stage }); }
const sha = (value) => createHash('sha256').update(value).digest('hex');

export function parseProductionCanaryArguments(argv) {
  const mode = argv[0];
  if (!['--plan', '--execute-production-canary'].includes(mode)) fail('arguments');
  const allowed = new Set(['--app', '--source-revision', '--build-number', '--archive-sha256', '--asar-sha256', '--cleanup-public-key', '--cleanup-public-key-sha256', '--confirm']);
  const values = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || Object.hasOwn(values, argv[i]) || typeof argv[i + 1] !== 'string' || argv[i + 1].startsWith('--')) fail('arguments');
    values[argv[i]] = argv[i + 1];
  }
  const required = ['--app', '--source-revision', '--build-number', '--archive-sha256', '--asar-sha256', '--cleanup-public-key', '--cleanup-public-key-sha256'];
  if (required.some((key) => !values[key]) || !/^[0-9a-f]{40}$/u.test(values['--source-revision'])
    || !/^[0-9]{10}$/u.test(values['--build-number']) || !SHA.test(values['--archive-sha256'])
    || !SHA.test(values['--asar-sha256']) || !SHA.test(values['--cleanup-public-key-sha256'])
    || !isAbsolute(values['--app']) || basename(values['--app']) !== 'TiboTattle.app'
    || !isAbsolute(values['--cleanup-public-key'])) fail('arguments');
  if (mode === '--plan' ? values['--confirm'] !== undefined : values['--confirm'] !== CONFIRMATION) fail('confirmation');
  return { execute: mode !== '--plan', appPath: resolve(values['--app']), sourceRevision: values['--source-revision'],
    buildNumber: values['--build-number'], archiveSha256: values['--archive-sha256'],
    asarSha256: values['--asar-sha256'], cleanupKeyPath: resolve(values['--cleanup-public-key']), cleanupKeySha256: values['--cleanup-public-key-sha256'] };
}

async function safePath(path) {
  let cursor = resolve(path);
  while (true) {
    const metadata = await lstat(cursor);
    if (metadata.isSymbolicLink()) fail('unsafe_path');
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (await realpath(path) !== resolve(path)) fail('unsafe_path');
}
async function boundedFile(path, maximum, ownerOnly = false) {
  await safePath(path);
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum
      || before.uid !== process.getuid() || (ownerOnly && (before.mode & 0o077) !== 0)) fail('unsafe_file');
    const bytes = await file.readFile();
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size) fail('changed_file');
    return bytes;
  } finally { await file.close(); }
}
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fail('profile_not_fresh');
}
export function validateCanaryManifest(manifest, sourceRevision) {
  if (manifest?.name !== 'app-usagemonitor' || Object.keys(manifest).some((key) => key.startsWith('tibotattleAccountless'))
    || manifest?.tibotattleDistribution?.sourceRevision !== sourceRevision) fail('artifact_metadata');
  const metadata = validateProductionDistributionMetadata(manifest.tibotattleDistribution, { platform: 'darwin', architecture: 'arm64' });
  // Handover fixtures deliberately disable production enrollment/uploads.
  // Valid signatures and distribution metadata alone cannot qualify this journey.
  if (metadata.channel !== distributionPolicy.PRODUCTION_ELECTRON_CHANNEL
    || metadata.contributionPolicy !== distributionPolicy.PRODUCTION_ELECTRON_CONTRIBUTION_POLICY) fail('artifact_uploads_disabled');
  if (metadata.semanticVersion !== undefined && manifest.version !== metadata.semanticVersion) fail('artifact_metadata');
  return metadata;
}
export function validateCanaryHost({ platform, architecture, nodeVersion, environment, account }) {
  if (platform !== 'darwin' || architecture !== 'arm64' || nodeVersion !== 'v26.2.0'
    || environment.GITHUB_ACTIONS !== 'true' || environment.RUNNER_ENVIRONMENT !== 'github-hosted'
    || environment.RUNNER_OS !== 'macOS' || environment.RUNNER_ARCH !== 'ARM64'
    || account.uid !== 501 || account.username !== 'runner' || account.homedir !== '/Users/runner'
    || typeof environment.RUNNER_TEMP !== 'string' || !isAbsolute(environment.RUNNER_TEMP)) fail('disposable_account');
  return account.homedir;
}
export function sealCanaryCleanup(publicKey, payload) {
  if (!UUID.test(payload.deviceId) || payload.origin !== ORIGIN || !UUID.test(payload.operationId)
    || !/^[0-9a-f]{40}$/u.test(payload.sourceRevision) || !SHA.test(payload.asarSha256)) fail('cleanup_payload');
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 4096) fail('cleanup_key');
  const aes = randomBytes(32), iv = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify({ schemaVersion: 'production-canary-cleanup-target-v1',
    origin: ORIGIN, operationId: payload.operationId, deviceId: payload.deviceId,
    sourceRevision: payload.sourceRevision, asarSha256: payload.asarSha256 }));
  try {
    const cipher = createCipheriv('aes-256-gcm', aes, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { schemaVersion: 'production-canary-cleanup-envelope-v1',
      wrappedKey: publicEncrypt({ key, oaepHash: 'sha256' }, aes).toString('base64'),
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  } finally { aes.fill(0); plaintext.fill(0); }
}
export function acceptedDefaultOnSharing(value, after = null) {
  const stamp = typeof value?.lastAcceptedAt === 'string' ? Date.parse(value.lastAcceptedAt) : NaN;
  return value?.enabled === true && value.basis === 'default_on' && value.transportStatus === 'up_to_date'
    && Number.isFinite(stamp) && (after === null || (Number.isFinite(Date.parse(after)) && stamp > Date.parse(after)));
}
export async function refreshCanaryLocalUsage(active) {
  const dashboard = active.sessions[0];
  const read = () => dashboard.evaluate(`fetch('/api/local/refresh', {cache:'no-store',redirect:'error'}).then(r => {
    if (!r.ok) throw Error('refresh unavailable'); return r.json(); }).then(v => ({status:v.refresh.status,refreshId:v.refresh.refreshId}))`);
  await waitFor(() => dashboard.evaluate(`Boolean(document.querySelector('#refresh-button') && !document.querySelector('#refresh-button').disabled)`), 60000, 'ordinary refresh available');
  const before = await read();
  await dashboard.evaluate(`document.querySelector('#refresh-button').click()`);
  await waitFor(async () => { const value = await read();
    if (value.refreshId === before.refreshId) return false;
    if (['failed','cancelled'].includes(value.status)) fail('restart_local_refresh');
    return value.status === 'succeeded'; }, 6 * 60000, 'ordinary local refresh completed');
  return true;
}
export function validateCanaryReleaseIdentity(manifest, plist, { sourceRevision, buildNumber }) {
  const metadata = validateCanaryManifest(manifest, sourceRevision);
  if (manifest.version !== '0.1.22' || metadata.buildNumber !== buildNumber
      || plist.CFBundleIdentifier !== distributionPolicy.PRODUCTION_ELECTRON_APP_ID
      || plist.LSMinimumSystemVersion !== '14.0' || plist.CFBundleExecutable !== 'TiboTattle') fail('artifact_release_identity');
  distributionPolicy.assertProductionElectronMacOSBundleMetadata({target:'darwin-arm64',version:'0.1.22',buildNumber,
    bundleVersion:plist.CFBundleVersion,bundleShortVersion:plist.CFBundleShortVersionString});
  distributionPolicy.assertProductionElectronMacOSIncomingUpgradeMetadata({target:'darwin-arm64',publicEDKey:plist.SUPublicEDKey});
  return metadata;
}
async function verifyArtifact(options) {
  const keyBytes = await boundedFile(options.cleanupKeyPath, 16384);
  if (sha(keyBytes) !== options.cleanupKeySha256) fail('cleanup_key_digest');
  if (!keyBytes.toString('ascii').startsWith('-----BEGIN PUBLIC KEY-----\n')) fail('cleanup_key');
  const key = createPublicKey(keyBytes);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 4096) fail('cleanup_key');
  const asar = join(options.appPath, 'Contents', 'Resources', 'app.asar');
  await safePath(asar);
  const before = await lstat(asar);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 512 * 1024 * 1024) fail('artifact');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(asar)) hash.update(chunk);
  if (hash.digest('hex') !== options.asarSha256) fail('artifact_digest');
  const after = await lstat(asar);
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('artifact_changed');
  execFileSync('/usr/bin/codesign', macOSCredentialApplicationVerificationArguments(options.appPath), { timeout: 30000, stdio: 'ignore' });
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const loaded = builderRequire('@electron/asar');
  const api = loaded?.default ?? loaded;
  if (api.statFile(asar, 'package.json').size > 128 * 1024) fail('artifact_metadata');
  const manifest = JSON.parse(api.extractFile(asar, 'package.json').toString('utf8'));
  const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert','json','-o','-',join(options.appPath,'Contents/Info.plist')], {encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:30000}));
  const distribution = validateCanaryReleaseIdentity(manifest, plist, options);
  const architecture = execFileSync('/usr/bin/lipo', ['-archs',join(options.appPath,'Contents/MacOS/TiboTattle')], {encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:30000}).trim();
  if (architecture !== 'arm64') fail('artifact_architecture');
  execFileSync('/usr/bin/xcrun', ['stapler','validate',options.appPath], {timeout:30000,stdio:'ignore'});
  execFileSync('/usr/sbin/spctl', ['--assess','--type','execute',options.appPath], {timeout:30000,stdio:'ignore'});
  return { appPath: options.appPath, executable: join(options.appPath, 'Contents', 'MacOS', 'TiboTattle'), keyBytes, distribution, packageVersion: manifest.version };
}
async function readBinding(profile) {
  const path = join(profile, 'companion-state', 'accountless-device-binding-v1.json');
  const bytes = await boundedFile(path, 4096, true);
  const value = JSON.parse(bytes.toString('utf8'));
  if (Object.keys(value).sort().join('|') !== 'createdAt|deviceId|origin|schemaVersion'
    || value.schemaVersion !== 'contribution-device-binding-v1' || value.origin !== ORIGIN
    || !UUID.test(value.deviceId)) fail('binding');
  return { deviceId: value.deviceId, digest: sha(bytes) };
}

export async function runProductionCanary(options) {
  const proof = { schemaVersion: SCHEMA, status: 'failed', origin: ORIGIN,
    sourceRevision: options.sourceRevision, version:'0.1.22', buildNumber:options.buildNumber, archiveSha256:options.archiveSha256, asarSha256: options.asarSha256, cleanupKeySha256: options.cleanupKeySha256,
    operationId: randomUUID(), artifactVerified: false, untouchedProfile: false, nativeIntroContinued: false,
    controlledRestart: false, nativeCleanQuitQualified: false, automaticAcceptedUpload: false,
    restartBindingRetained: false, restartLocalRefresh: false, restartAcceptedUpload: false, durableOptOut: false, ownedProcessesStopped: false,
    hostedCleanup: 'not_started', cleanupHandoffWritten: false, productionReadiness: false,
    failureStage: null };
  let active, profile, evidenceRoot, verified, launched = false, handoff = false;
  let stage = 'artifact';
  try {
    verified = await verifyArtifact(options);
    proof.artifactVerified = true;
    proof.distribution = { channel: verified.distribution.channel, version: verified.packageVersion,
      target: verified.distribution.target };
    if (!options.execute) return { ...proof, status: 'prepared', hostedCleanup: 'required_after_execution' };
    stage = 'disposable_account';
    const account = userInfo();
    const home = validateCanaryHost({ platform: process.platform, architecture: process.arch,
      nodeVersion: process.version, environment: process.env, account });
    const temporaryRoot = await realpath(process.env.RUNNER_TEMP);
    const appRelative = relative(temporaryRoot, options.appPath);
    if (!appRelative || appRelative.startsWith('..' + sep) || appRelative === '..' || isAbsolute(appRelative)) fail('artifact_location');
    const appData = join(home, 'Library', 'Application Support');
    await safePath(appData);
    profile = join(appData, 'TiboTattle');
    const codex = join(home, '.codex');
    for (const path of [profile, codex, join(appData, 'app-usagemonitor'), join(appData, 'Usage Monitor')]) await absent(path);
    proof.untouchedProfile = true;
    evidenceRoot = join(temporaryRoot, 'production-canary-evidence');
    await mkdir(evidenceRoot, { mode: 0o700 });
    const sessions = join(codex, 'sessions');
    await mkdir(codex, { mode: 0o700 });
    await mkdir(sessions, { mode: 0o700 });
    await writeFile(join(sessions, 'rollout-signed-staging-synthetic.jsonl'), signedStagingFixture(), { mode: 0o600, flag: 'wx' });
    const temporary = join(evidenceRoot, 'temporary');
    await mkdir(temporary, { mode: 0o700 });
    const environment = signedStagingChildEnvironment(process.env, home, temporary);
    stage = 'first_launch'; launched = true;
    active = await launchVerifiedMacSharingApp(verified, environment, { untouched: true });
    proof.nativeIntroContinued = active.nativeIntroContinued === true;
    stage = 'accepted_upload';
    const accepted = await waitFor(async () => { const value = await active.readSharing();
      return acceptedDefaultOnSharing(value) ? value : null; }, 6 * 60000, 'automatic accepted upload');
    proof.automaticAcceptedUpload = true;
    const initial = await readBinding(profile);
    await writeFile(join(evidenceRoot, 'cleanup-target.encrypted.json'), JSON.stringify(sealCanaryCleanup(verified.keyBytes, {
      ...proof, deviceId: initial.deviceId })) + '\n', { mode: 0o600, flag: 'wx' });
    handoff = proof.cleanupHandoffWritten = true;
    proof.ownedProcessesStopped = await stopOwnedMacSharingApp(active); active = null;
    // A second tiny synthetic source requires a fresh ordinary scheduled acceptance;
    // a persisted up-to-date label alone cannot establish credential reuse.
    await writeFile(join(sessions, 'rollout-production-restart-synthetic.jsonl'),
      signedStagingFixture().replaceAll('signed-staging-synthetic','signed-production-restart-synthetic'), {mode:0o600,flag:'wx'});
    stage = 'restart_binding';
    proof.ownedProcessesStopped = false;
    active = await launchVerifiedMacSharingApp(verified, environment);
    proof.restartLocalRefresh = await refreshCanaryLocalUsage(active);
    proof.ownedProcessesStopped = await stopOwnedMacSharingApp(active); active = null;
    proof.ownedProcessesStopped = false;
    active = await launchVerifiedMacSharingApp(verified, environment);
    await waitFor(async () => acceptedDefaultOnSharing(await active.readSharing(), accepted.lastAcceptedAt), 6 * 60000, 'fresh authenticated restart acceptance');
    proof.restartAcceptedUpload = true;
    if ((await readBinding(profile)).digest !== initial.digest) fail('binding_changed');
    proof.restartBindingRetained = true;
    proof.controlledRestart = true;
    stage = 'durable_opt_out';
    await active.settings.evaluate('globalThis.tibotattleDesktop.setSharingEnabled(false)');
    await waitFor(async () => { const v = await active.readSharing(); return v?.enabled === false && v.transportStatus === 'off'; }, 10000, 'off');
    proof.ownedProcessesStopped = await stopOwnedMacSharingApp(active); active = null;
    proof.ownedProcessesStopped = false;
    active = await launchVerifiedMacSharingApp(verified, environment);
    for (let i = 0; i < 10; i++) {
      const v = await active.readSharing();
      if (v?.enabled !== false || v.transportStatus !== 'off' || v.lastAcceptedAt !== null) fail('opt_out_restart');
      await new Promise((done) => setTimeout(done, 1000));
    }
    proof.durableOptOut = true;
    proof.status = 'cleanup_required';
  } catch (error) {
    proof.failureStage = error?.canaryStage ?? stage;
    if (error?.ownedMacProcessesStopped === true) proof.ownedProcessesStopped = true;
  }
  finally {
    if (active) {
      try { await active.settings?.evaluate('globalThis.tibotattleDesktop.setSharingEnabled(false)'); } catch {}
      try { proof.ownedProcessesStopped = await stopOwnedMacSharingApp(active); } catch { proof.ownedProcessesStopped = false; }
    }
    if (launched) {
      proof.hostedCleanup = 'required';
      if (!handoff && profile && evidenceRoot && verified) {
        try {
          const binding = await readBinding(profile);
          await writeFile(join(evidenceRoot, 'cleanup-target.encrypted.json'), JSON.stringify(sealCanaryCleanup(verified.keyBytes, {
            ...proof, deviceId: binding.deviceId })) + '\n', { mode: 0o600, flag: 'wx' });
          proof.cleanupHandoffWritten = true;
        } catch { proof.hostedCleanup = 'target_unconfirmed'; }
      }
      if (!proof.ownedProcessesStopped) proof.status = 'failed';
    }
  }
  return proof;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const proof = await runProductionCanary(parseProductionCanaryArguments(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(proof) + '\n');
    if (proof.status !== 'prepared') process.exitCode = proof.status === 'cleanup_required' ? 2 : 1;
  } catch { process.stderr.write('PRODUCTION_CANARY_REFUSED\n'); process.exitCode = 1; }
}
