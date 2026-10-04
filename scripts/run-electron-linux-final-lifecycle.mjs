#!/usr/bin/env node
// Host ownership and evidence for one same-job comparison followed by the
// ordinary lifecycle under its exact still-loaded candidate profile.
import { spawn, spawnSync } from 'node:child_process';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { fingerprintLinuxFinalFile } from './qualify-electron-linux-installed-lifecycle.mjs';
import { cleanupLinuxMountDiagnosis, runLinuxNativeAppArmorComparison } from './diagnose-electron-linux-appimage-mount.mjs';
import { validateLinuxStartupDiagnostic } from './lib/linux-startup-diagnostics.mjs';
import { LINUX_FINAL_INPUT, exactKeys, preflightLinuxFinalIntake, validateLinuxFinalPair,
  linuxFinalFailure as fail, sha256 } from './lib/linux-final-artifact-intake.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = join(ROOT, LINUX_FINAL_INPUT), RECEIPTS = join(INPUT, 'receipts');
const OWNER = join(INPUT, '.final-lifecycle-owner.json'), CID = join(INPUT, '.final-lifecycle.container');
const IMAGE = 'tibotattle-electron-linux-installed:test';
const digest = value => /^[a-f0-9]{64}$/u.test(value ?? '');
const validRun = value => /^[1-9][0-9]{0,14}$/u.test(value ?? '');
const validRevision = value => /^[a-f0-9]{40}$/u.test(value ?? '');
const labels = { run: 'io.tibotattle.final-lifecycle.run', runner: 'io.tibotattle.final-lifecycle.runner' };
const lifecycleFlags = ['cleanInstallSmokePassed', 'localRefreshAndCredentialAccess', 'chromiumRendererSandboxVerified',
  'cleanUninstallPreservedLocalState', 'mismatchedFeedChecksumRefusedWithoutReplacement',
  'replacementAndAutomaticRestartVerified', 'coldRestartSettingsAndOptOutVerified',
  'credentialAndSourceStatePreserved', 'noUpdateVerified', 'ownedUninstallAndAppCleanupVerified', 'artifactIntegrityVerified'];
const lifecycleStages = new Set(['loopback_tls', 'fresh_final_install', 'public_predecessor_install', 'checksum_refusal',
  'settings_download', 'settings_install', 'automatic_restart', 'cold_restart_no_update', 'owned_uninstall']);

function ownerValid(value) {
  return exactKeys(value, ['run', 'runner', 'nonce', 'profile', 'profileSha256', 'profileNameSha256'])
    && validRun(value.run) && validRevision(value.runner) && /^[a-f0-9]{32}$/u.test(value.nonce ?? '')
    && value.profile === `tibotattle-mount-candidate-${value.run}-${value.nonce}`
    && digest(value.profileSha256) && value.profileNameSha256 === sha256(value.profile);
}
export function linuxFinalHostContainerArguments(owner) {
  if (!ownerValid(owner)) fail('HOST_OWNER_INVALID');
  return ['create', '--init', '--platform=linux/amd64', '--name', `tibotattle-final-linux-qualification-${owner.run}`,
    '--cidfile', CID, '--label', `${labels.run}=${owner.run}`, '--label', `${labels.runner}=${owner.runner}`,
    '--security-opt', `apparmor=${owner.profile}`,
    '--cap-add=SYS_ADMIN', '--device', '/dev/fuse', '--network', 'none',
    '--add-host', 'updates.tibotattle.com:127.0.0.1', '--shm-size=512m',
    '--tmpfs', '/home/node:rw,noexec,nosuid,size=256m,uid=1000,gid=1000,mode=0700',
    '--tmpfs', '/run/user/1000:rw,noexec,nosuid,size=256m,uid=1000,gid=1000,mode=0700',
    '--tmpfs', '/opt/tibotattle-updater-exec:rw,exec,nosuid,size=768m,uid=1000,gid=1000,mode=0700',
    '--env', 'HOME=/home/node', '--env', 'TMPDIR=/run/user/1000', '--env', 'XDG_RUNTIME_DIR=/run/user/1000',
    '--env', 'XDG_CONFIG_HOME=/home/node/.config', '--env', 'XDG_CACHE_HOME=/home/node/.cache',
    '--env', 'XDG_DATA_HOME=/home/node/.local/share', '--env', 'TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED=1',
    '--env', 'USAGE_MONITOR_LINUX_IMAGE_PLATFORM=linux/amd64', '--env', 'USAGE_MONITOR_LINUX_NETWORK_BOUNDARY=network-none',
    '--env', `TIBOTATTLE_LINUX_FINAL_NONCE=${owner.nonce}`, '--env', `TIBOTATTLE_LINUX_FINAL_PROFILE=${owner.profile}`, IMAGE];
}
export function linuxFinalHostCleanupArguments({ id, inspected }, owner) {
  if (!ownerValid(owner) || !digest(id) || !exactKeys(inspected, ['id', 'name', 'labels', 'profile'])
    || inspected.id !== id || inspected.name !== `/tibotattle-final-linux-qualification-${owner.run}`
    || inspected.profile !== owner.profile || !exactKeys(inspected.labels, [...Object.values(labels), 'org.opencontainers.image.revision'])
    || inspected.labels[labels.run] !== owner.run || inspected.labels[labels.runner] !== owner.runner
    || inspected.labels['org.opencontainers.image.revision'] !== owner.runner) fail('HOST_OWNER_INVALID');
  return ['rm', '--force', id];
}

/** Admit only the established runtime schema, preserving its original bytes.
 * Host/comparison closure is separate; it cannot fill missing runtime flags. */
export function validateLinuxFinalLifecycleReceipt(value, pair) {
  const required = { schemaVersion: 'tibotattle-linux-final-installed-lifecycle-v1',
    sourceRevision: pair.intake.sourceRevision, workflowRunnerRevision: pair.intake.runnerRevision,
    sourceCandidateSha256: pair.intake.sourceCandidateSha256, packageReceiptSha256: pair.intake.packageReceiptSha256,
    packageRunId: pair.intake.packageRunId, version: pair.intake.version, buildNumber: pair.intake.buildNumber,
    target: 'linux-x64', images: { current: pair.images.current.sha256, next: pair.images.next.sha256 },
    runtime: 'native_x64_Xvfb_FUSE_ordinary_AppImage_launcher', physicalDesktop: 'not_qualified',
    network: 'loopback_only_network_none', feed: 'fixed_production_URL_simulated_locally',
    credentialScope: 'disposable_Secret_Service', rebuilt: false, published: false };
  const optional = [...lifecycleFlags, 'publicPredecessorUpdate', 'updateInitiation', 'feedRequests', 'imageRequests',
    'status', 'stage', 'errorCode', 'startupDiagnostic'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(required, key) && !optional.includes(key))
    || !Object.entries(required).every(([key, expected]) => isDeepStrictEqual(value[key], expected))
    || !['passed', 'failed'].includes(value.status)
    || lifecycleFlags.some(key => Object.hasOwn(value, key) && typeof value[key] !== 'boolean')) return null;
  if (Object.hasOwn(value, 'publicPredecessorUpdate') && value.publicPredecessorUpdate !== 'exact_published_0.1.26_to_final_0.1.27') return null;
  if (Object.hasOwn(value, 'updateInitiation') && (!exactKeys(value.updateInitiation, ['check', 'download'])
    || !Object.values(value.updateInitiation).every(item => ['automatic', 'settings_button'].includes(item)))) return null;
  if (['feedRequests', 'imageRequests'].some(key => Object.hasOwn(value, key)
    && (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 10000))) return null;
  if (Object.hasOwn(value, 'startupDiagnostic') && validateLinuxStartupDiagnostic(value.startupDiagnostic) === null) return null;
  if (value.status === 'passed') {
    if (!lifecycleFlags.every(key => value[key] === true) || !value.updateInitiation
      || value.publicPredecessorUpdate !== 'exact_published_0.1.26_to_final_0.1.27'
      || !(value.feedRequests >= 1) || !(value.imageRequests >= 2)
      || ['stage', 'errorCode', 'startupDiagnostic'].some(key => Object.hasOwn(value, key))) return null;
  } else if (!lifecycleStages.has(value.stage)
    || !/^(?:LINUX_FINAL_LIFECYCLE|ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE)_[A-Z_]{1,100}$/u.test(value.errorCode ?? '')) return null;
  return value;
}
function command(args, maximum = 131072) {
  const result = spawnSync('docker', args, { cwd: ROOT, shell: false, encoding: 'utf8',
    timeout: 20000, maxBuffer: maximum, stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error || result.signal || result.status !== 0) fail('HOST_CONTAINER_FAILED');
  return result.stdout.trim();
}
async function writeNew(path, bytes) {
  const parent = dirname(path), stat = await lstat(parent);
  if (await realpath(parent) !== parent || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail('HOST_PATH_INVALID');
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return { bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) };
}
const writeJSON = (path, value) => writeNew(path, `${JSON.stringify(value, null, 2)}\n`);
async function privateJSON(path, maximum) {
  const stat = await lstat(path);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail('HOST_OWNER_INVALID');
  return JSON.parse((await fingerprintLinuxFinalFile(path, maximum, true)).contents);
}
async function cleanupFinalContainer() {
  const run = process.env.GITHUB_RUN_ID, runner = process.env.GITHUB_SHA;
  if (!validRun(run) || !validRevision(runner)) fail('HOST_OWNER_INVALID');
  let owner;
  try { owner = await privateJSON(OWNER, 2048); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (command(['ps', '-aq', '--filter', `name=^/tibotattle-final-linux-qualification-${run}$`])) fail('HOST_OWNER_INVALID');
    return true;
  }
  if (!ownerValid(owner) || owner.run !== run || owner.runner !== runner) fail('HOST_OWNER_INVALID');
  let id;
  try {
    const stat = await lstat(CID);
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail('HOST_OWNER_INVALID');
    id = (await fingerprintLinuxFinalFile(CID, 256, true)).contents.toString('utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (command(['ps', '-aq', '--filter', `name=^/tibotattle-final-linux-qualification-${run}$`])) fail('HOST_OWNER_INVALID');
    return true;
  }
  if (!digest(id)) fail('HOST_OWNER_INVALID');
  if (!command(['ps', '-aq', '--filter', `id=${id}`])) return true;
  const inspected = JSON.parse(command(['inspect', '--format',
    '{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Config.Labels}},"profile":{{json .AppArmorProfile}}}', id]));
  command(linuxFinalHostCleanupArguments({ id, inspected }, owner));
  if (command(['ps', '-aq', '--filter', `id=${id}`])) fail('HOST_CLEANUP_FAILED');
  return true;
}
async function collectContainer(id, interrupted) {
  const child = spawn('docker', ['start', '--attach', id], { cwd: ROOT, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise(resolveResult => {
    const chunks = []; let size = 0, stopped = false, reason = null, resolved = false, kill = null;
    const finish = (status, signal = null) => {
      if (resolved) return; resolved = true; clearTimeout(timeout); clearInterval(cancellation); clearTimeout(kill);
      resolveResult({ status, signal, reason, contents: Buffer.concat(chunks) });
    };
    const stop = why => {
      if (stopped) return; stopped = true; reason = why; child.kill('SIGTERM');
      // This is only the captured Docker client. Container removal is bound by
      // recorded ID, profile, name and labels in the caller's finally block.
      kill = setTimeout(() => { child.kill('SIGKILL'); finish(null, 'SIGKILL'); }, 2000);
      kill.unref();
    };
    const timeout = setTimeout(() => stop('timeout'), 900000);
    const cancellation = setInterval(() => { if (interrupted()) stop('interrupted'); }, 100);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 131072) { stop('output_limit'); return; }
      chunks.push(chunk);
    });
    child.once('error', () => { reason = 'spawn_failed'; finish(null); });
    child.once('close', finish);
  });
}
async function runFinalContainer(pair, checkpoint, interrupted) {
  const owner = { run: process.env.GITHUB_RUN_ID, runner: pair.intake.runnerRevision, nonce: checkpoint.nonce,
    profile: checkpoint.name, profileSha256: checkpoint.profileSha256, profileNameSha256: checkpoint.profileNameSha256 };
  const result = { passed: false, containerRemoved: false, original: null, errorCode: 'container_failed' };
  try {
    if (interrupted()) { result.errorCode = 'interrupted'; return result; }
    if (!ownerValid(owner) || command(['ps', '-aq', '--filter', `name=^/tibotattle-final-linux-qualification-${owner.run}$`])) fail('HOST_OWNER_INVALID');
    await writeJSON(OWNER, owner);
    const id = command(linuxFinalHostContainerArguments(owner), 256);
    if (!digest(id) || (await fingerprintLinuxFinalFile(CID, 256, true)).contents.toString('utf8').trim() !== id) fail('HOST_OWNER_INVALID');
    const inspected = JSON.parse(command(['inspect', '--format',
      '{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Config.Labels}},"profile":{{json .AppArmorProfile}}}', id]));
    linuxFinalHostCleanupArguments({ id, inspected }, owner); // Admission only; no removal here.
    const output = await collectContainer(id, interrupted);
    if (output.reason !== null) { result.errorCode = output.reason === 'interrupted' ? 'interrupted' : 'container_failed'; return result; }
    const receipt = validateLinuxFinalLifecycleReceipt(JSON.parse(output.contents.toString('utf8')), pair);
    if (receipt === null) { result.errorCode = 'receipt_invalid'; return result; }
    result.original = await writeNew(join(RECEIPTS, 'installed-lifecycle.json'), output.contents);
    result.passed = output.status === 0 && output.signal === null && receipt.status === 'passed';
    result.errorCode = result.passed ? 'none' : 'lifecycle_failed';
  } catch { /* Closed result only; native output and operational identities stay private. */ }
  finally {
    try { result.containerRemoved = await cleanupFinalContainer(); } catch { result.containerRemoved = false; }
    if (!result.containerRemoved) { result.passed = false; result.errorCode = 'cleanup_failed'; }
  }
  return result;
}

/** Exported pure orchestration boundary for failure-ordering tests. Adapters
 * own native execution and retention; only its successful exact closure allows
 * the helper to remove the still-loaded profile. */
export async function runLinuxFinalHostSequence(pair, { compare, lifecycle, interrupted = () => false }) {
  let execution = null, checkpoint = null;
  const comparison = await compare(pair, { interrupted, onCandidateVerified: async candidate => {
    if (checkpoint !== null) fail('HOST_HANDOFF_INVALID');
    checkpoint = candidate;
    execution = await lifecycle(pair, candidate, interrupted);
    if (!exactKeys(execution, ['passed', 'containerRemoved', 'original', 'errorCode'])
      || typeof execution.passed !== 'boolean' || typeof execution.containerRemoved !== 'boolean'
      || !['none', 'container_failed', 'receipt_invalid', 'interrupted', 'lifecycle_failed', 'cleanup_failed'].includes(execution.errorCode)
      || execution.original !== null && (!exactKeys(execution.original, ['bytes', 'sha256'])
        || !Number.isSafeInteger(execution.original.bytes) || execution.original.bytes < 1
        || execution.original.bytes > 131072 || !digest(execution.original.sha256))) fail('HOST_HANDOFF_INVALID');
    return { containerRemoved: execution.containerRemoved };
  } });
  const passed = comparison?.outcome === 'compared' && comparison.profilesRemoved === true
    && execution?.passed === true && execution.containerRemoved === true && execution.errorCode === 'none'
    && execution.original !== null && checkpoint !== null && !interrupted();
  return { comparison, execution, checkpoint, passed };
}
async function execute() {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.version !== 'v26.2.0') fail('NATIVE_HOST_REQUIRED');
  const intake = preflightLinuxFinalIntake(process.env, { repositoryRoot: ROOT });
  if (process.env.SELECTED_MODE !== 'execute' || !validRun(process.env.GITHUB_RUN_ID)) fail('CONFIRMATION_INVALID');
  const pairFile = await fingerprintLinuxFinalFile(join(INPUT, 'pair.json'), 131072, true);
  const pair = validateLinuxFinalPair(JSON.parse(pairFile.contents), intake.runnerRevision);
  if (!isDeepStrictEqual(pair.intake, intake)) fail('INPUT_CHANGED');
  await mkdir(RECEIPTS, { mode: 0o700 });
  let interrupted = false;
  const cancel = () => { interrupted = true; };
  process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
  const host = { schemaVersion: 'tibotattle-linux-final-host-v1', runId: process.env.GITHUB_RUN_ID,
    runnerRevision: intake.runnerRevision, sourceRevision: intake.sourceRevision,
    pair: { bytes: pairFile.bytes, sha256: pairFile.sha256 }, comparison: null, lifecycle: null,
    profileSha256: null, profileNameSha256: null, comparisonPassed: false, lifecyclePassed: false,
    containerRemoved: false, profilesRemoved: false, interrupted: false, status: 'failed', errorCode: 'host_failure' };
  try {
    const result = await runLinuxFinalHostSequence(pair, { compare: runLinuxNativeAppArmorComparison,
      lifecycle: runFinalContainer, interrupted: () => interrupted });
    host.comparison = await writeJSON(join(INPUT, 'apparmor-comparison.json'), result.comparison);
    host.lifecycle = result.execution?.original ?? null;
    host.profileSha256 = result.checkpoint?.profileSha256 ?? null;
    host.profileNameSha256 = result.checkpoint?.profileNameSha256 ?? null;
    host.comparisonPassed = result.comparison.outcome === 'compared' && result.comparison.profilesRemoved === true;
    host.lifecyclePassed = result.execution?.passed === true;
    host.errorCode = result.passed ? 'none' : !host.comparisonPassed ? 'comparison_failed' : 'lifecycle_failed';
  } catch { /* Recovery and the closed host failure below remain mandatory. */ }
  finally {
    try { host.containerRemoved = await cleanupFinalContainer(); } catch { /* Not proven. */ }
    try {
      await cleanupLinuxMountDiagnosis({ removeProfiles: host.containerRemoved });
      host.profilesRemoved = host.containerRemoved;
    } catch { /* Not proven. */ }
    host.interrupted = interrupted;
    process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
  }
  if (!host.containerRemoved || !host.profilesRemoved) host.errorCode = 'cleanup_failed';
  else if (host.interrupted) host.errorCode = 'interrupted';
  host.status = host.errorCode === 'none' && host.comparisonPassed && host.lifecyclePassed ? 'passed' : 'failed';
  await writeJSON(join(RECEIPTS, 'host-lifecycle.json'), host);
  if (host.status !== 'passed') fail('HOST_QUALIFICATION_FAILED');
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || !['--execute', '--cleanup'].includes(process.argv[2])) fail('ARGUMENT_INVALID');
    process.umask(0o077);
    if (process.argv[2] === '--execute') await execute();
    else {
      const gone = await cleanupFinalContainer();
      await cleanupLinuxMountDiagnosis({ removeProfiles: gone });
      if (!gone) fail('HOST_CLEANUP_FAILED');
    }
    process.stdout.write('Owned Linux lifecycle operation complete; release publication remains separate.\n');
  } catch { process.stderr.write('LINUX_FINAL_LIFECYCLE_HOST_REFUSED\n'); process.exitCode = 1; }
}
