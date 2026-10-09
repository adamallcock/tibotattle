#!/usr/bin/env node
// A mount-only CLI for exact prebuilt images. Its shared comparison adapters
// support a separately owned lifecycle callback; diagnostic receipts never
// supply installed-lifecycle or release qualification.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertContainerContract, isLinuxSandboxEnvironmentClean } from './smoke-electron-linux.mjs';
import { createLinuxStartupDiagnostics, validateLinuxStartupDiagnostic, classifyLinuxStartupFuseMount } from './lib/linux-startup-diagnostics.mjs';
import { acquireLinuxFinalArtifacts, prepareLinuxFinalArtifacts, fingerprintLinuxFinalFile } from './qualify-electron-linux-installed-lifecycle.mjs';
import { LINUX_FINAL_CONFIRMATION, LINUX_FINAL_INPUT, exactKeys, preflightLinuxFinalIntake, validateLinuxFinalPair } from './lib/linux-final-artifact-intake.mjs';

import { LINUX_APPARMOR_COMPARISON_CONFIRMATION, normalizeLinuxAppArmorMountTuple, prepareLinuxAppArmorProfiles,
  cleanupLinuxAppArmorProfiles, runLinuxAppArmorComparison } from './lib/linux-apparmor-mount-profile.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXEC = '/opt/tibotattle-updater-exec', IMAGE = `${EXEC}/TiboTattle.AppImage`;
const SCRIPT = 'scripts/diagnose-electron-linux-appimage-mount.mjs';
export const LINUX_MOUNT_DIAGNOSIS_SCHEMA = 'tibotattle-linux-appimage-mount-diagnosis-v5';
export const LINUX_MOUNT_DIAGNOSIS_CONFIRMATION = 'RUN_DISPOSABLE_LINUX_APPIMAGE_MOUNT_DIAGNOSIS';
const UNKNOWN = 'unavailable', ROLES = ['current', 'next'];
const PROBE_STAGES = ['default', 'baseline', 'candidate', 'negative'];
const ERRORS = new Set(['none', 'container_failed', 'launcher_gate_failed', 'probe_failed', 'cleanup_failed']);
const ERROR_PATTERNS = Object.freeze({
  permissionDenied: /Permission denied/iu, operationNotPermitted: /Operation not permitted/iu,
  missingDevice: /(?:device not found|No such device)/iu, missingFile: /No such file or directory/iu,
  notImplemented: /Function not implemented/iu, invalidArgument: /Invalid argument/iu,
  busy: /Device or resource busy/iu, ioError: /Input\/output error/iu,
});
// Recognize these upstream C-locale templates only; this does not identify the
// runtime embedded in either AppImage. No captured text is retained.
// https://github.com/libfuse/libfuse/blob/d04687923194d906fe5ad82dcd546c9807bf15b6/lib/mount.c
// https://github.com/libfuse/libfuse/blob/d04687923194d906fe5ad82dcd546c9807bf15b6/util/fusermount.c
// https://github.com/AppImage/AppImageKit/blob/8bbf694455d00f48d835f56afaa1dabcd9178ba6/src/runtime.c
// The AppImageKit source is a template reference, not embedded-byte proof.
const FAILURE_STAGES = Object.freeze({
  directFuseMount: /^fuse: mount failed: ([^\r\n]+)$/u,
  fusermountExec: /^fuse: failed to exec fusermount: ([^\r\n]+)$/u,
  fusermountMount: /^fusermount: mount failed: ([^\r\n]+)$/u,
  runtimeMountDirectoryOpen: /^open dir error: ([^\r\n]+)$/u,
});
const STAGE_ERRNOS = new Map([['Permission denied', 'EACCES'], ['Operation not permitted', 'EPERM'], ['No such file or directory', 'ENOENT']]);
const STAGE_VALUES = new Set(['not_observed', 'EACCES', 'EPERM', 'ENOENT', 'other', 'ambiguous']);
const READER_REASONS = new Set(['none', 'kmsg_open_denied', 'kmsg_open_unavailable', 'reader_timeout', 'reader_failed', 'stream_incomplete']);
export const LINUX_ACTOR_TRACE_REASONS = new Set(['none', 'not_started', 'tracefs_unavailable', 'trace_layout_unavailable',
  'trace_instance_setup_unavailable', 'trace_initial_controls_unavailable', 'trace_cpu_layout_unavailable',
  'trace_buffer_layout_unavailable', 'trace_options_unavailable', 'trace_clock_unavailable',
  'trace_fork_format_unavailable', 'trace_fork_filter_unavailable', 'trace_fork_trigger_unavailable', 'trace_fork_enable_write_unavailable', 'trace_fork_enable_readback_unavailable',
  'trace_exec_format_unavailable', 'trace_exec_filter_unavailable', 'trace_exec_trigger_unavailable', 'trace_exec_enable_write_unavailable', 'trace_exec_enable_readback_unavailable',
  'trace_exit_format_unavailable', 'trace_exit_filter_unavailable', 'trace_exit_trigger_unavailable', 'trace_exit_enable_write_unavailable', 'trace_exit_enable_readback_unavailable',
  'trace_pid_filter_unavailable', 'trace_pipe_unavailable', 'trace_gate_recheck_unavailable', 'trace_start_unavailable',
  'trace_limits_exceeded', 'gate_identity_unavailable', 'trace_stream_incomplete', 'trace_graph_ambiguous', 'trace_cleanup_failed', 'reader_failed', 'reader_timeout']);
const AUDIT_REASONS = new Set(['not_started', 'not_evaluated', 'observer_start_failed', ...READER_REASONS.values(),
  ...LINUX_ACTOR_TRACE_REASONS, 'launcher_gate_failed', 'profile_unavailable', 'probe_identity_unavailable', 'probe_cleanup_unproven', 'audit_window_incomplete', 'no_observed_mount_denial',
  'no_correlated_mount_denial', 'owned_target_source_unrecognized', 'owned_actor_not_correlated', 'match_ambiguous', 'owned_mount_denial']);
AUDIT_REASONS.delete('none');
const booleanOrUnknown = value => typeof value === 'boolean' || value === UNKNOWN;
const fail = () => { throw new Error('LINUX_MOUNT_DIAGNOSIS_REFUSED'); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function boundedRead(path, maximum = 65536) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = Buffer.alloc(maximum + 1); let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break; length += result.bytesRead;
    }
    if (length > maximum) fail();
    return bytes.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}
async function optionalRead(path, maximum) { try { return await boundedRead(path, maximum); } catch { return null; } }
function uniqueStatus(text, key) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n').filter(line => line.startsWith(`${key}:`));
  return lines.length === 1 ? lines[0].slice(key.length + 1).trim() : null;
}
export function normalizeLinuxMountPolicy({ status, appArmor }) {
  const raw = typeof appArmor === 'string' && appArmor.length <= 256 ? appArmor.trim() : '';
  const profile = /^([^\n()]+) \((enforce|complain)\)$/u.exec(raw);
  const cap = key => {
    const value = uniqueStatus(status, key);
    return /^[a-f0-9]{1,16}$/iu.test(value ?? '') ? Boolean(BigInt(`0x${value}`) & (1n << 21n)) : UNKNOWN;
  };
  const seccomp = uniqueStatus(status, 'Seccomp'), nnp = uniqueStatus(status, 'NoNewPrivs');
  return {
    appArmor: { profile: raw === 'unconfined' ? 'unconfined' : profile ? profile[1] === 'docker-default' ? 'docker_default' : 'other' : UNKNOWN,
      enforcement: raw === 'unconfined' ? 'unconfined' : profile?.[2] ?? UNKNOWN },
    seccomp: ['0', '1', '2'].includes(seccomp) ? ['disabled', 'strict', 'filter'][Number(seccomp)] : UNKNOWN,
    noNewPrivileges: nnp === '1' ? true : nnp === '0' ? false : UNKNOWN,
    sysAdmin: { effective: cap('CapEff'), permitted: cap('CapPrm'), bounding: cap('CapBnd') },
  };
}
export function createLinuxMountErrorClassifier() {
  const flags = Object.fromEntries([...Object.keys(ERROR_PATTERNS), 'unknown', 'truncated'].map(key => [key, false]));
  const stages = Object.fromEntries(Object.keys(FAILURE_STAGES).map(key => [key, 'not_observed']));
  let used = 0, pending = '', length = 0, discard = false;
  const line = text => {
    if (!text.trim()) return;
    for (const [stage, pattern] of Object.entries(FAILURE_STAGES)) {
      const match = pattern.exec(text);
      if (match === null) continue;
      const errno = STAGE_ERRNOS.get(match[1]) ?? 'other';
      stages[stage] = stages[stage] === 'not_observed' || stages[stage] === errno ? errno : 'ambiguous';
    }
    let matched = false;
    for (const [key, pattern] of Object.entries(ERROR_PATTERNS)) if (pattern.test(text)) { flags[key] = true; matched = true; }
    if (!matched) flags.unknown = true;
  };
  return { feed(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk).slice(0, 65537));
    const count = Math.min(bytes.length, 65536 - used);
    if (count !== bytes.length) flags.truncated = true;
    used += count;
    for (const char of bytes.subarray(0, count).toString('utf8')) {
      if (char === '\n') { if (!discard) line(pending); pending = ''; length = 0; discard = false; }
      else if (!discard) {
        const size = Buffer.byteLength(char);
        if (length + size > 2048) { pending = ''; length = 0; discard = true; flags.unknown = true; flags.truncated = true; }
        else { pending += char; length += size; }
      }
    }
    // Do not classify a line whose unseen suffix was cut by the total budget.
    if (bytes.length > count && pending.length) { pending = ''; length = 0; discard = true; flags.unknown = true; }
  }, finish() { if (!discard) line(pending); pending = ''; return { ...flags, stages: { ...stages } }; } };
}
export function selectLinuxMountProbeMount(text, temporary) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 262144
    || !new RegExp(`^${EXEC}/tmp/[a-f0-9]{32}$`, 'u').test(temporary)) return { state: UNKNOWN, mount: null };
  const rows = text.split('\n').filter(line => line.split(' ')[4]?.startsWith(`${temporary}/`));
  if (!rows.length) return { state: 'not_observed', mount: null };
  if (rows.length !== 1) return { state: 'ambiguous', mount: null };
  const [left, right, extra] = rows[0].split(' - '), fields = left.split(' '), after = right?.split(' ');
  const target = fields[4];
  if (extra !== undefined || fields[3] !== '/' || !after || !/^\.mount_[A-Za-z0-9._-]+$/u.test(target.slice(temporary.length + 1))
    || !(after[0] === 'fuse.squashfuse' && after[1] === 'squashfuse'
      || ['fuse.TiboTattle.AppImage', 'fuse'].includes(after[0]) && [IMAGE, 'TiboTattle.AppImage'].includes(after[1]))
    || !after[2]?.split(',').includes('user_id=1000')) return { state: 'ambiguous', mount: null };
  return { state: 'observed', mount: target };
}
export function projectLinuxMountProbeFacts(text, temporary) {
  const selected = selectLinuxMountProbeMount(text, temporary);
  if (selected.state !== 'observed') return { ...classifyLinuxStartupFuseMount(''), state: selected.state };
  const line = text.split('\n').find(value => value.split(' ')[4] === selected.mount);
  return classifyLinuxStartupFuseMount(line.replace(`${temporary}/`, `${EXEC}/tmp/`));
}
async function mountFacts(temporary) { return selectLinuxMountProbeMount(await optionalRead('/proc/self/mountinfo', 262144), temporary); }
export async function sampleLinuxMountProbeFacts(temporary) {
  if (!new RegExp(`^${EXEC}/tmp/[a-f0-9]{32}$`, 'u').test(temporary ?? '')) fail();
  return projectLinuxMountProbeFacts(await optionalRead('/proc/self/mountinfo', 262144), temporary);
}
export async function readLinuxMountRuntimeFacts() {
  const policy = normalizeLinuxMountPolicy({ status: await optionalRead('/proc/self/status'), appArmor: await optionalRead('/proc/self/attr/current', 256) });
  const can = async (path, mode) => { try { await access(path, mode); return true; } catch (error) { return ['EACCES', 'EPERM', 'ENOENT'].includes(error.code) ? false : UNKNOWN; } };
  let device = UNKNOWN, helper = { present: UNKNOWN, regular: UNKNOWN, rootOwned: UNKNOWN, setuid: UNKNOWN, executable: UNKNOWN };
  try { device = (await lstat('/dev/fuse')).isCharacterDevice(); } catch (error) { if (error.code === 'ENOENT') device = false; }
  try {
    const path = await realpath('/usr/bin/fusermount'), stat = await lstat(path);
    helper = { present: true, regular: stat.isFile(), rootOwned: stat.uid === 0,
      setuid: Boolean(stat.mode & 0o4000), executable: await can(path, constants.X_OK) };
  } catch (error) { if (error.code === 'ENOENT') helper.present = false; }
  return { ...policy, fuseDevice: { characterDevice: device, readable: await can('/dev/fuse', constants.R_OK), writable: await can('/dev/fuse', constants.W_OK) }, fusermount: helper };
}
function validFacts(value) {
  return exactKeys(value, ['appArmor', 'seccomp', 'noNewPrivileges', 'sysAdmin', 'fuseDevice', 'fusermount'])
    && exactKeys(value.appArmor, ['profile', 'enforcement'])
    && ['docker_default', 'unconfined', 'other', UNKNOWN].includes(value.appArmor.profile)
    && ['enforce', 'complain', 'unconfined', UNKNOWN].includes(value.appArmor.enforcement)
    && ['disabled', 'strict', 'filter', UNKNOWN].includes(value.seccomp) && booleanOrUnknown(value.noNewPrivileges)
    && [['sysAdmin', ['effective', 'permitted', 'bounding']], ['fuseDevice', ['characterDevice', 'readable', 'writable']],
      ['fusermount', ['present', 'regular', 'rootOwned', 'setuid', 'executable']]].every(([key, fields]) =>
      exactKeys(value[key], fields) && fields.every(field => booleanOrUnknown(value[key][field])));
}
function validProbe(value) {
  return exactKeys(value, ['environment', 'startup', 'mount', 'launcherErrors', 'cleanup']) && validFacts(value.environment)
    && validateLinuxStartupDiagnostic(value.startup) !== null && ['observed', 'not_observed', 'ambiguous', UNKNOWN].includes(value.mount)
    && exactKeys(value.launcherErrors, [...Object.keys(ERROR_PATTERNS), 'unknown', 'truncated', 'stages'])
    && [...Object.keys(ERROR_PATTERNS), 'unknown', 'truncated'].every(key => typeof value.launcherErrors[key] === 'boolean')
    && exactKeys(value.launcherErrors.stages, Object.keys(FAILURE_STAGES))
    && Object.values(value.launcherErrors.stages).every(item => STAGE_VALUES.has(item))
    && exactKeys(value.cleanup, ['childGone', 'mountGone']) && Object.values(value.cleanup).every(booleanOrUnknown);
}
export function validateLinuxMountDiagnosis(value) {
  if (!exactKeys(value, ['schemaVersion', 'purpose', 'qualifiesRelease', 'runnerRevision', 'sourceRevision', 'cases'])
    || value.schemaVersion !== LINUX_MOUNT_DIAGNOSIS_SCHEMA || value.purpose !== 'diagnostic_only' || value.qualifiesRelease !== false
    || !['runnerRevision', 'sourceRevision'].every(key => /^[a-f0-9]{40}$/u.test(value[key] ?? ''))
    || !Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > 2) return null;
  for (const [index, row] of value.cases.entries()) {
    if (!exactKeys(row, ['role', 'artifactSha256', 'artifactBytes', 'probe', 'errorCode', 'appArmorMountDenial', 'appArmorAuditReason', 'containerRemoved', 'observerStopped', 'actorTrace'])
      || row.role !== ROLES[index] || !/^[a-f0-9]{64}$/u.test(row.artifactSha256 ?? '')
      || !Number.isSafeInteger(row.artifactBytes) || row.artifactBytes < 4096 || row.artifactBytes > 1024 ** 3
      || row.probe !== null && !validProbe(row.probe) || !ERRORS.has(row.errorCode)
      || !exactKeys(row.actorTrace, ['complete', 'reason', 'instanceRemoved']) || typeof row.actorTrace.complete !== 'boolean'
      || !LINUX_ACTOR_TRACE_REASONS.has(row.actorTrace.reason) || typeof row.actorTrace.instanceRemoved !== 'boolean'
      || row.actorTrace.complete !== (row.actorTrace.reason === 'none') || row.observerStopped && !row.actorTrace.instanceRemoved
      || ![true, UNKNOWN].includes(row.appArmorMountDenial) || !AUDIT_REASONS.has(row.appArmorAuditReason)
      || (row.appArmorMountDenial === true) !== (row.appArmorAuditReason === 'owned_mount_denial')
      || row.appArmorMountDenial === true && (!row.actorTrace.complete || !row.containerRemoved || !row.observerStopped) || typeof row.containerRemoved !== 'boolean' || typeof row.observerStopped !== 'boolean'
      || row.errorCode === 'none' && (row.probe === null || !row.containerRemoved || !row.observerStopped || !row.actorTrace.complete)
      || index > 0 && (!value.cases[index - 1].containerRemoved || !value.cases[index - 1].observerStopped)) return null;
  }
  return value;
}
export async function runLinuxMountSequence(pair, runProbe) {
  const cases = [];
  for (const role of ROLES) {
    const row = await runProbe(role, pair.images[role]);
    if (row.role !== role || row.artifactSha256 !== pair.images[role].sha256 || row.artifactBytes !== pair.images[role].bytes) fail();
    cases.push(row);
    if (cases.at(-1).containerRemoved !== true || cases.at(-1).observerStopped !== true) break;
  }
  const receipt = { schemaVersion: LINUX_MOUNT_DIAGNOSIS_SCHEMA, purpose: 'diagnostic_only', qualifiesRelease: false,
    runnerRevision: pair.intake.runnerRevision, sourceRevision: pair.intake.sourceRevision, cases };
  if (validateLinuxMountDiagnosis(receipt) === null) fail();
  return receipt;
}
export function linuxMountPreflightEnvironment(environment) {
  const policy = environment.SELECTED_POLICY ?? 'default';
  const confirmation = policy === 'apparmor-comparison' ? LINUX_APPARMOR_COMPARISON_CONFIRMATION : LINUX_MOUNT_DIAGNOSIS_CONFIRMATION;
  if (!['default', 'apparmor-comparison'].includes(policy) || !['plan', 'execute'].includes(environment.SELECTED_MODE)
    || environment.SELECTED_CONFIRMATION !== (environment.SELECTED_MODE === 'execute' ? confirmation : '')) fail();
  return { ...environment, SELECTED_CONFIRMATION: environment.SELECTED_MODE === 'execute' ? LINUX_FINAL_CONFIRMATION : '' };
}
function command(executable, args, maximum = 131072, timeout = 20000) {
  const result = spawnSync(executable, args, { cwd: ROOT, shell: false, encoding: 'utf8', timeout, maxBuffer: maximum, stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error || result.signal || result.status !== 0) fail();
  return result.stdout.trim();
}
function caseSuffix(stage, role) { return `${stage === 'default' ? '' : `${stage}-`}${role}`; }
export function linuxMountContainerArguments({ name, role, nonce, runnerRevision, stage = 'default', profile = null }) {
  const run = name?.split('-').at(-1);
  if (!PROBE_STAGES.includes(stage) || !ROLES.includes(role) || !/^[1-9][0-9]{0,14}$/u.test(run ?? '')
    || name !== `tibotattle-mount-diagnosis-${caseSuffix(stage, role)}-${run}` || !/^[a-f0-9]{32}$/u.test(nonce)
    || !/^[a-f0-9]{40}$/u.test(runnerRevision ?? '') || (stage === 'default' ? profile !== null
      : !new RegExp(`^tibotattle-mount-${stage === 'baseline' ? 'baseline' : 'candidate'}-${run}-[a-f0-9]{32}$`, 'u').test(profile ?? ''))) fail();
  return ['create', '--interactive', '--init', '--platform=linux/amd64', '--name', name,
    '--cidfile', join(ROOT, LINUX_FINAL_INPUT, `.mount-diagnosis-${caseSuffix(stage, role)}.container`),
    ...(stage === 'default' ? [] : ['--security-opt', `apparmor=${profile}`, '--label', `io.tibotattle.mount-diagnosis.stage=${stage}`,
      '--env', 'TIBOTATTLE_MOUNT_PROBE_COMPARISON=1']),
    '--label', `io.tibotattle.mount-diagnosis.run=${name.split('-').at(-1)}`,
    '--label', `io.tibotattle.mount-diagnosis.runner=${runnerRevision}`, '--label', `io.tibotattle.mount-diagnosis.role=${role}`,
    '--cap-add=SYS_ADMIN', '--device', '/dev/fuse', '--network', 'none', '--add-host', 'updates.tibotattle.com:127.0.0.1', '--shm-size=512m',
    '--tmpfs', '/home/node:rw,noexec,nosuid,size=256m,uid=1000,gid=1000,mode=0700',
    '--tmpfs', '/run/user/1000:rw,noexec,nosuid,size=256m,uid=1000,gid=1000,mode=0700',
    '--tmpfs', `${EXEC}:rw,exec,nosuid,size=768m,uid=1000,gid=1000,mode=0700`,
    '--env', 'HOME=/home/node', '--env', 'TMPDIR=/run/user/1000', '--env', 'XDG_RUNTIME_DIR=/run/user/1000',
    '--env', 'XDG_CONFIG_HOME=/home/node/.config', '--env', 'XDG_CACHE_HOME=/home/node/.cache', '--env', 'XDG_DATA_HOME=/home/node/.local/share',
    '--env', 'TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED=1', '--env', 'USAGE_MONITOR_LINUX_IMAGE_PLATFORM=linux/amd64',
    '--env', 'USAGE_MONITOR_LINUX_NETWORK_BOUNDARY=network-none', '--env', `TIBOTATTLE_MOUNT_PROBE_ROLE=${role}`,
    '--env', `TIBOTATTLE_MOUNT_PROBE_NONCE=${nonce}`, 'tibotattle-electron-linux-installed:test', 'node', SCRIPT, '--inside'];
}
async function waitUntil(predicate, timeout) {
  const deadline = Date.now() + timeout;
  do { if (await predicate()) return true; await pause(50); } while (Date.now() < deadline);
  return false;
}
async function runInside() {
  const contract = assertContainerContract(), role = process.env.TIBOTATTLE_MOUNT_PROBE_ROLE, nonce = process.env.TIBOTATTLE_MOUNT_PROBE_NONCE;
  if (process.arch !== 'x64' || process.getuid() !== 1000 || process.version !== 'v26.2.0'
    || !isLinuxSandboxEnvironmentClean(process.env) || process.env.APPIMAGE_EXTRACT_AND_RUN !== undefined
    || !ROLES.includes(role) || !/^[a-f0-9]{32}$/u.test(nonce ?? '')) fail();
  const execution = await lstat(EXEC);
  if (!execution.isDirectory() || execution.isSymbolicLink() || execution.uid !== 1000
    || (execution.mode & 0o777) !== 0o700 || (await readdir(EXEC)).length) fail();
  const directory = join(ROOT, LINUX_FINAL_INPUT);
  const pair = validateLinuxFinalPair(JSON.parse((await fingerprintLinuxFinalFile(join(directory, 'pair.json'), 131072, true)).contents), contract.sourceRevision);
  const source = join(directory, pair.images[role].file), expected = pair.images[role];
  const identity = await fingerprintLinuxFinalFile(source);
  if (identity.sha256 !== expected.sha256 || identity.bytes !== expected.bytes) fail();
  await copyFile(source, IMAGE, constants.COPYFILE_EXCL); await chmod(IMAGE, 0o700);
  const installed = await fingerprintLinuxFinalFile(IMAGE);
  if (installed.sha256 !== expected.sha256 || installed.bytes !== expected.bytes) fail();
  await mkdir(`${EXEC}/tmp`, { mode: 0o700 });
  const temporary = `${EXEC}/tmp/${nonce}`; await mkdir(temporary, { mode: 0o700 });
  const environment = await readLinuxMountRuntimeFacts();
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  let input = '', go = false, invalidInput = false;
  process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { if (invalidInput) return; input += chunk; if (input.length > 16) { input = ''; invalidInput = true; } go = input === 'go\n'; });
  // The gate replaces itself with the unchanged image after host-side tracing is
  // armed. It does not use ptrace or change credentials, capabilities or NNP.
  const child = spawn(process.execPath, [SCRIPT, '--gate'], { cwd: ROOT, shell: false, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, TMPDIR: temporary, LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' } });
  let gateReady = false, gateExited = false;
  child.once('close', () => { gateExited = true; }); child.once('error', () => { gateExited = true; });
  const gateValid = collectLines(child.stdio[3], value => {
    if (gateReady || !exactKeys(value, ['kind', 'pid']) || value.kind !== 'gate' || value.pid !== child.pid) fail();
    gateReady = true;
  }, 256);
  if (!await waitUntil(async () => gateExited || gateReady && /\) T /u.test(await optionalRead(`/proc/${child.pid}/stat`, 4096)), 5000)
    || gateExited || !gateValid()) { child.kill('SIGKILL'); send({ kind: 'gate_failed' }); fail(); }
  send({ kind: 'ready', pid: child.pid });
  if (!await waitUntil(() => go || invalidInput || gateExited, 10000) || invalidInput || gateExited) {
    child.kill('SIGKILL'); send({ kind: 'gate_failed' }); fail();
  }
  const sampleMount = process.env.TIBOTATTLE_MOUNT_PROBE_COMPARISON === '1'
    ? async () => projectLinuxMountProbeFacts(await optionalRead('/proc/self/mountinfo', 262144), temporary) : null;
  const startup = createLinuxStartupDiagnostics({ child, sampleMount }), errors = createLinuxMountErrorClassifier();
  child.stdout.resume(); child.stderr.on('data', chunk => { startup.feed(chunk); errors.feed(chunk); });
  child.stdin.on('error', () => {}); child.stdin.end('release\n'); child.kill('SIGCONT');
  let selected = { state: 'not_observed', mount: null }, exited = false;
  child.once('close', () => { exited = true; });
  await waitUntil(async () => { selected = await mountFacts(temporary); return selected.state !== 'not_observed' || exited; }, 8000);
  if (selected.state === 'observed') await pause(250);
  const observed = await startup.stop();
  // Stop only the ChildProcess we created. If its helper leaves a verified owned
  // FUSE mount, unmount exactly that target; the host container removal is final.
  if (!exited) child.kill('SIGTERM');
  if (!await waitUntil(() => exited, 2000)) { child.kill('SIGKILL'); await waitUntil(() => exited, 2000); }
  const residual = await mountFacts(temporary);
  if (residual.state === 'observed') {
    try { command('/usr/bin/fusermount', ['-u', '--', residual.mount], 4096, 1000); } catch { /* Closed cleanup evidence below. */ }
  }
  const gone = await waitUntil(async () => (await mountFacts(temporary)).state === 'not_observed', 2000);
  const probe = { environment, startup: observed, mount: selected.state, launcherErrors: errors.finish(), cleanup: { childGone: exited, mountGone: gone } };
  if (!validProbe(probe)) fail();
  send({ kind: 'result', probe }); process.stdin.destroy();
}

export function linuxAppImageGateArguments(environment) {
  const nonce = environment.TIBOTATTLE_MOUNT_PROBE_NONCE;
  if (!/^[a-f0-9]{32}$/u.test(nonce ?? '') || environment.TMPDIR !== `${EXEC}/tmp/${nonce}`
    || !['LC_ALL', 'LANG', 'LANGUAGE'].every(key => environment[key] === 'C')
    || environment.APPIMAGE_EXTRACT_AND_RUN !== undefined || !isLinuxSandboxEnvironmentClean(environment)) fail();
  return [IMAGE, '--appimage-mount'];
}
function runGate() {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.version !== 'v26.2.0'
    || process.getuid() !== 1000 || typeof process.execve !== 'function') fail();
  const args = linuxAppImageGateArguments(process.env);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    input += chunk;
    if (input.length > 8 || !'release\n'.startsWith(input)) process.exit(1);
    if (input !== 'release\n') return;
    process.stdin.pause();
    // Restore the original launcher's /dev/null stdin before exec.
    closeSync(0); if (openSync('/dev/null', 'r') !== 0) process.exit(1);
    process.execve(IMAGE, args, process.env);
    process.exit(1);
  });
  process.stdin.on('end', () => process.exit(1));
  setTimeout(() => process.exit(1), 10000);
  writeSync(3, `${JSON.stringify({ kind: 'gate', pid: process.pid })}\n`); closeSync(3);
  process.kill(process.pid, 'SIGSTOP');
}
// Birth ordinals below are kernel-event identities, never /proc start ticks.
// Audit delivery time is deliberately absent from this actor graph.
export function buildLinuxAppImageActorGraph({ rootPid, events, complete, reason = 'none', priorPids = new Set() }) {
  const unavailable = reason => ({ complete: false, reason, actors: new Map() });
  if (complete !== true || reason !== 'none') return unavailable(LINUX_ACTOR_TRACE_REASONS.has(reason) && reason !== 'none' ? reason : 'trace_stream_incomplete');
  const pid = value => Number.isSafeInteger(value) && value > 0;
  if (!pid(rootPid) || !Array.isArray(events) || events.length > 4096 || !(priorPids instanceof Set)
    || priorPids.size > 640 || [...priorPids].some(value => !pid(value))) return unavailable('trace_limits_exceeded');
  const actors = new Map([[rootPid, { pid: rootPid, birth: 0, parent: null, depth: 0, appImage: false, alive: true }]]);
  let rootExec = false;
  for (const [index, event] of events.entries()) {
    if (!pid(event?.pid)) return unavailable('trace_graph_ambiguous');
    if (event.type === 'fork' && exactKeys(event, ['type', 'pid', 'parent']) && pid(event.parent)) {
      const parent = actors.get(event.parent);
      if (!parent?.alive || actors.has(event.pid)) return unavailable('trace_graph_ambiguous');
      if (actors.size >= 128 || parent.depth >= 32) return unavailable('trace_limits_exceeded');
      actors.set(event.pid, { pid: event.pid, birth: index + 1, parent: parent.pid, depth: parent.depth + 1, appImage: parent.appImage, alive: true });
    } else if (event.type === 'exec' && exactKeys(event, ['type', 'pid', 'oldPid', 'image']) && pid(event.oldPid) && typeof event.image === 'boolean') {
      const actor = actors.get(event.pid);
      if (!actor?.alive || event.oldPid !== event.pid) return unavailable('trace_graph_ambiguous');
      if (!rootExec && (event.pid !== rootPid || !event.image)) return unavailable('trace_graph_ambiguous');
      if (event.pid === rootPid && !rootExec) { rootExec = true; actor.appImage = true; }
    } else if (event.type === 'exit' && exactKeys(event, ['type', 'pid'])) {
      const actor = actors.get(event.pid);
      if (!actor?.alive) return unavailable('trace_graph_ambiguous');
      actor.alive = false;
    } else return unavailable('trace_graph_ambiguous');
  }
  if (!rootExec || [...actors.values()].some(actor => actor.alive) || [...actors.keys()].some(pid => priorPids.has(pid))) return unavailable('trace_graph_ambiguous');
  if (actors.size + priorPids.size > 640) return unavailable('trace_limits_exceeded');
  return { complete: true, reason: 'none', actors };
}

// /dev/kmsg is opened read-only at its current end; no historical kernel log is
// collected. Sequence gaps, continuation records, overflow and access failures
// all make the stream incomplete. Raw kernel records stay in this private pipe.
export const LINUX_MOUNT_KMSG_READER = String.raw`
import errno, json, os, re, select, signal, stat, sys, time
fd = trace_fd = instance_fd = None
instance = instance_identity = None
start = time.monotonic_ns() // 1000
complete = trace_complete = True
reader_reason = trace_reason = 'none'
last = None
used = events = 0
profile = None
root_pid = None
exit_format = None
trace_pending = b''
removed = True
armed = False
stopping = False
params = None

def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)
def incomplete(reason, trace=False):
    global complete, reader_reason, trace_complete, trace_reason
    if trace:
        trace_complete = False
        if trace_reason == 'none': trace_reason = reason
    else:
        complete = False
        if reader_reason == 'none': reader_reason = reason
def read(path, limit=16384):
    with open(path, 'r', encoding='utf-8') as handle: value = handle.read(limit + 1)
    if len(value.encode('utf-8')) > limit: raise ValueError()
    return value
def identity(pid):
    fields = read('/proc/' + str(pid) + '/stat', 4096).rsplit(')', 1)[1].split()
    if not re.fullmatch(r'[0-9]+', fields[19]): raise ValueError()
    return {'start': fields[19], 'parent': int(fields[1]), 'state': fields[0]}
def gone(pid, ticks):
    try: return identity(pid)['start'] != ticks
    except FileNotFoundError: return True
    except Exception: return False

def arguments():
    value = json.loads(sys.argv[2])
    if set(value) != {'directory', 'run', 'runner', 'role', 'stage', 'container', 'uid', 'initPid', 'initStart', 'probe'}: raise ValueError()
    if not re.fullmatch(r'[1-9][0-9]{0,14}', value['run']) or not re.fullmatch(r'[a-f0-9]{40}', value['runner']): raise ValueError()
    if value['role'] not in ('current', 'next') or value['stage'] not in ('default', 'baseline', 'candidate', 'negative'): raise ValueError()
    if not re.fullmatch(r'[a-f0-9]{64}', value['container']) or type(value['uid']) is not int or value['uid'] < 1: raise ValueError()
    directory = value['directory']
    info = os.lstat(directory)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != value['uid'] or info.st_mode & 0o022 or os.path.realpath(directory) != directory: raise ValueError()
    if sys.argv[1] == 'observe':
        if any(type(value[key]) is not int or value[key] < 1 for key in ('initPid', 'probe')) or not re.fullmatch(r'[0-9]+', value['initStart']): raise ValueError()
    elif sys.argv[1] != 'cleanup': raise ValueError()
    return value

def journal_path(intent=False):
    suffix = (params['stage'] + '-' if params['stage'] != 'default' else '') + params['role']
    return params['directory'] + '/.mount-trace-' + suffix + ('.intent.json' if intent else '.json')
def trace_root():
    choices = {'/sys/kernel/tracing': 'tracing', '/sys/kernel/debug/tracing': 'debug'}
    found = []
    for line in read('/proc/self/mountinfo', 262144).splitlines():
        before, after = line.split(' - ', 1)
        target = before.split()[4]
        if after.split()[0] == 'tracefs' and target in choices and os.path.realpath(target) == target: found.append(target)
    if len(found) != 1: raise ValueError()
    return found[0], choices[found[0]]
def cpus():
    values = set()
    for part in read('/sys/devices/system/cpu/online', 128).strip().split(','):
        if not re.fullmatch(r'[0-9]+(?:-[0-9]+)?', part): raise ValueError()
        ends = [int(value) for value in part.split('-')]
        if ends[-1] < ends[0] or ends[-1] > 4095 or ends[-1] - ends[0] > 7: raise ValueError()
        values.update(range(ends[0], ends[-1] + 1))
    if not values or len(values) > 8: raise ValueError()
    return values

def control(name, value):
    handle = os.open(name, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, dir_fd=instance_fd)
    try:
        data = value.encode('ascii')
        if os.write(handle, data) != len(data): raise ValueError()
    finally: os.close(handle)
def local_read(name, limit=16384):
    handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=instance_fd)
    try:
        data = os.read(handle, limit + 1)
        if len(data) > limit: raise ValueError()
        return data.decode('utf-8', 'strict')
    finally: os.close(handle)
def configure_trace_buffer():
    # x64 Linux v6.14: 4 KiB subbuffers carry 4080 bytes after the 16-byte
    # header. A 63 KiB request uses 16 data-ring pages (64 KiB), readback 63.
    # A 64 KiB request instead rounds up to 17 pages/readback 67.
    # https://github.com/torvalds/linux/blob/v6.14/kernel/trace/ring_buffer.c
    if os.sysconf('SC_PAGE_SIZE') != 4096 or local_read('buffer_subbuf_size_kb').strip() != '4': raise ValueError()
    control('buffer_size_kb', '63\n')
    total = local_read('buffer_total_size_kb').strip()
    if local_read('buffer_subbuf_size_kb').strip() != '4' or local_read('buffer_size_kb').strip() != '63': raise ValueError()
    if not re.fullmatch(r'[1-9][0-9]*', total) or int(total) > 512: raise ValueError()

def configure_trace_events():
    global setup_reason, exit_format
    exit_format = None
    # Exact upstream print templates only; select the runtime parser from the
    # live instance format, not a guessed kernel version. The extra boolean is
    # discarded and never proves thread-group or container cleanup.
    # https://github.com/torvalds/linux/blob/v6.14/include/trace/events/sched.h
    # https://github.com/torvalds/linux/blob/v6.17/include/trace/events/sched.h
    legacy = 'comm=%s pid=%d prio=%d'
    formats = {'fork': ('comm=%s pid=%d child_comm=%s child_pid=%d',),
        'exec': ('filename=%s pid=%d old_pid=%d',), 'exit': (legacy, legacy + ' group_dead=%s')}
    selected = None
    for kind, expected in formats.items():
        prefix = 'events/sched/sched_process_' + kind + '/'
        setup_reason = 'trace_' + kind + '_format_unavailable'
        lines = [line for line in local_read(prefix + 'format').splitlines() if line.startswith('print fmt:')]
        match = re.fullmatch(r'print fmt: "([^"\r\n]*)", [^\r\n]+', lines[0]) if len(lines) == 1 else None
        if not match or match[1] not in expected: raise ValueError()
        if kind == 'exit': selected = 'legacy' if match[1] == legacy else 'group_dead'
        setup_reason = 'trace_' + kind + '_filter_unavailable'
        if local_read(prefix + 'filter').strip() != 'none': raise ValueError()
        setup_reason = 'trace_' + kind + '_trigger_unavailable'
        if any(line.strip() and not line.startswith('#') for line in local_read(prefix + 'trigger').splitlines()): raise ValueError()
        setup_reason = 'trace_' + kind + '_enable_write_unavailable'
        control(prefix + 'enable', '1\n')
        setup_reason = 'trace_' + kind + '_enable_readback_unavailable'
        if local_read(prefix + 'enable').strip() != '1': raise ValueError()
    exit_format = selected

def no_loss(cpu_set, drained=False):
    if cpus() != cpu_set: return False
    for cpu in cpu_set:
        fields = {}
        for line in local_read('per_cpu/cpu' + str(cpu) + '/stats', 4096).splitlines():
            key, value = line.split(':', 1)
            if key.strip() in fields: return False
            fields[key.strip()] = value.strip()
        if drained and fields.get('entries') != '0': return False
        for key in ('overrun', 'commit overrun', 'dropped events'):
            if fields.get(key) != '0': return False
    return True

def verify_gate():
    init = str(params['initPid'])
    if identity(init)['start'] != params['initStart']: raise ValueError()
    cgroup = read('/proc/' + init + '/cgroup', 4096)
    group = re.fullmatch(r'0::(/[A-Za-z0-9/_.:-]+)\n', cgroup)
    if not group or '..' in group[1].split('/'): raise ValueError()
    namespace = os.readlink('/proc/' + init + '/ns/pid')
    raw_profile = read('/proc/' + init + '/attr/current', 256)
    name = re.fullmatch(r'([^\n()]+) \(enforce\)\n?', raw_profile)
    if not name: raise ValueError()
    candidates = read('/sys/fs/cgroup' + group[1] + '/cgroup.procs', 16384).splitlines()
    if len(candidates) > 128 or str(params['initPid']) not in candidates: raise ValueError()
    roots = []
    for raw in candidates:
        if not re.fullmatch(r'[1-9][0-9]*', raw): raise ValueError()
        try:
            before = identity(raw)
            status = read('/proc/' + raw + '/status')
            nspid = re.findall(r'^NSpid:\s+([0-9\t ]+)$', status, re.M)
            if len(nspid) != 1 or int(nspid[0].split()[-1]) != params['probe']: continue
            if before != identity(raw) or before['state'] != 'T' or os.readlink('/proc/' + raw + '/ns/pid') != namespace: raise ValueError()
            if read('/proc/' + raw + '/cgroup', 4096) != cgroup or read('/proc/' + raw + '/attr/current', 256) != raw_profile: raise ValueError()
            if re.findall(r'^Tgid:\s+([0-9]+)$', status, re.M) != [raw]: raise ValueError()
            if re.findall(r'^Uid:\s+([0-9\t ]+)$', status, re.M)[0].split() != ['1000'] * 4: raise ValueError()
            parent = before['parent']
            for depth in range(32):
                if parent == params['initPid']: break
                if str(parent) not in candidates: raise ValueError()
                parent = identity(parent)['parent']
            else: raise ValueError()
            roots.append((int(raw), before['start']))
        except (FileNotFoundError, ProcessLookupError): pass
    if len(roots) != 1 or identity(init)['start'] != params['initStart']: raise ValueError()
    return roots[0], name[1]

def journal(root, root_kind, intent=False):
    value = {key: params[key] for key in ('run', 'runner', 'role', 'stage', 'container')}
    value.update({'schema': 'tibotattle-owned-actor-trace-intent-v1' if intent else 'tibotattle-owned-actor-trace-v1', 'rootKind': root_kind, 'instance': os.path.basename(instance),
        'device': None if intent else str(instance_identity.st_dev), 'inode': None if intent else str(instance_identity.st_ino),
        'observerPid': os.getpid(), 'observerStart': identity(os.getpid())['start'],
        'initPid': params['initPid'], 'initStart': params['initStart']})
    handle = os.open(journal_path(intent), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        data = json.dumps(value, separators=(',', ':')).encode('ascii')
        if os.write(handle, data) != len(data): raise ValueError()
        os.fsync(handle)
    finally: os.close(handle)
def owned_journal(intent=False):
    path = journal_path(intent)
    handle = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(handle)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_nlink != 1 or before.st_mode & 0o077 or before.st_size > 4096: raise ValueError()
        data = os.read(handle, 4097)
        if len(data) != before.st_size: raise ValueError()
        for current in (os.fstat(handle), os.lstat(path)):
            if any(getattr(current, key) != getattr(before, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')): raise ValueError()
    finally: os.close(handle)
    value = json.loads(data)
    if set(value) != {'run', 'runner', 'role', 'stage', 'container', 'schema', 'rootKind', 'instance', 'device', 'inode', 'observerPid', 'observerStart', 'initPid', 'initStart'}: raise ValueError()
    schema = 'tibotattle-owned-actor-trace-intent-v1' if intent else 'tibotattle-owned-actor-trace-v1'
    if value['schema'] != schema or any(value[key] != params[key] for key in ('run', 'runner', 'role', 'stage', 'container')): raise ValueError()
    if not re.fullmatch('tibotattle-' + params['run'] + '-[a-f0-9]{32}', value['instance']): raise ValueError()
    if any(type(value[key]) is not int or value[key] < 1 for key in ('observerPid', 'initPid')): raise ValueError()
    if any(not re.fullmatch(r'[0-9]+', value[key]) for key in ('observerStart', 'initStart')): raise ValueError()
    if intent:
        if value['device'] is not None or value['inode'] is not None: raise ValueError()
    elif any(not re.fullmatch(r'[0-9]+', value[key]) for key in ('device', 'inode')): raise ValueError()
    return value

def cleanup_record():
    global instance_fd
    intent = False
    try: value = owned_journal()
    except FileNotFoundError:
        try: value = owned_journal(True); intent = True
        except FileNotFoundError: return True
    if not gone(value['observerPid'], value['observerStart']) or not gone(value['initPid'], value['initStart']): return False
    root, root_kind = trace_root()
    if root_kind != value['rootKind']: return False
    path = root + '/instances/' + value['instance']
    try: info = os.lstat(path)
    except FileNotFoundError: return True
    if intent: return False
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or str(info.st_dev) != value['device'] or str(info.st_ino) != value['inode'] or os.path.realpath(path) != path: return False
    instance_fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(instance_fd)
        if (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_uid) != (info.st_dev, info.st_ino, info.st_mode, info.st_uid): return False
        control('tracing_on', '0\n')
        if local_read('tracing_on').strip() != '0': return False
        control('events/enable', '0\n')
        control('options/event-fork', '0\n')
    finally: os.close(instance_fd); instance_fd = None
    current = os.lstat(path)
    if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino): return False
    os.rmdir(path)
    return not os.path.lexists(path)

def trace_line(line, cpu_set):
    global events
    match = re.fullmatch(r'\s*.*-([0-9]+)\s+\[([0-9]+)\]\s+[A-Za-z0-9.]+\s+[0-9]+\.[0-9]+:\s+sched_process_(fork|exec|exit):\s+(.*)', line)
    if not match or int(match[2]) not in cpu_set: raise ValueError()
    common = int(match[1]); kind = match[3]; body = match[4]
    if kind == 'fork':
        value = re.fullmatch(r'comm=.{0,16} pid=([0-9]+) child_comm=.{0,16} child_pid=([0-9]+)', body)
        if not value or common != int(value[1]): raise ValueError()
        event = {'type': 'fork', 'parent': int(value[1]), 'pid': int(value[2])}
    elif kind == 'exec':
        value = re.fullmatch(r'filename=(.{1,4096}) pid=([0-9]+) old_pid=([0-9]+)', body)
        if not value or common != int(value[2]): raise ValueError()
        event = {'type': 'exec', 'pid': int(value[2]), 'oldPid': int(value[3]), 'image': value[1] == '/opt/tibotattle-updater-exec/TiboTattle.AppImage'}
    else:
        if exit_format == 'legacy': pattern = r'comm=.{0,16} pid=([0-9]+) prio=-?[0-9]+'
        elif exit_format == 'group_dead': pattern = r'comm=.{0,16} pid=([0-9]+) prio=-?[0-9]+ group_dead=(?:true|false)'
        else: raise ValueError()
        value = re.fullmatch(pattern, body)
        if not value or common != int(value[1]): raise ValueError()
        event = {'type': 'exit', 'pid': int(value[1])}
    events += 1
    if events > 4096: raise OverflowError()
    emit({'kind': 'actor', 'event': event})

def drain_trace(cpu_set, allow_eof=False):
    global used, trace_pending
    while True:
        try: data = os.read(trace_fd, 65536)
        except BlockingIOError: return
        if not data:
            if allow_eof: return
            raise ValueError()
        used += len(data)
        if used > 262144: raise OverflowError()
        trace_pending += data
        while b'\n' in trace_pending:
            line, trace_pending = trace_pending.split(b'\n', 1)
            if len(line) > 8192: raise OverflowError()
            trace_line(line.decode('utf-8', 'strict'), cpu_set)
        if len(trace_pending) > 8192: raise OverflowError()
def drain_kmsg():
    global used, last
    while True:
        try: record = os.read(fd, 65536)
        except BlockingIOError: return
        except OSError as error:
            incomplete('stream_incomplete' if error.errno == errno.EPIPE else 'reader_failed')
            return
        used += len(record)
        if not record or used > 262144: raise OverflowError()
        try:
            header, message = record.decode('utf-8', 'strict').split(';', 1)
            priority, sequence, timestamp, flags = header.split(',')
            priority, sequence, timestamp = int(priority), int(sequence), int(timestamp)
            if last is not None and sequence != last + 1: incomplete('stream_incomplete')
            last = sequence
            if flags != '-' or message.count('\n') != 1 or not message.endswith('\n'): incomplete('stream_incomplete')
            if priority >> 3 == 0 and 'apparmor="DENIED"' in message and 'operation="mount"' in message:
                emit({'kind': 'entry', 'time': timestamp, 'message': message.rstrip('\n')})
        except Exception: incomplete('stream_incomplete')

def stop_signal(*unused):
    global stopping
    stopping = True
signal.signal(signal.SIGTERM, stop_signal)
signal.signal(signal.SIGINT, stop_signal)
try:
    params = arguments()
    if sys.argv[1] == 'cleanup':
        try: result = cleanup_record()
        except Exception: result = False
        emit({'removed': result})
        sys.exit(0)
    try: root, root_kind = trace_root()
    except Exception: incomplete('tracefs_unavailable', True); raise
    try: (root_pid, root_start), profile = verify_gate()
    except Exception: incomplete('gate_identity_unavailable', True); raise
    try:
        fd = os.open('/dev/kmsg', os.O_RDONLY | os.O_NONBLOCK)
    except OSError as error:
        incomplete('kmsg_open_denied' if error.errno in (errno.EACCES, errno.EPERM) else 'kmsg_open_unavailable')
        raise
    os.lseek(fd, 0, os.SEEK_END)
    start = time.monotonic_ns() // 1000
    setup_reason = 'trace_instance_setup_unavailable'
    try:
        for intent in (False, True):
            try: os.lstat(journal_path(intent)); removed = False; raise ValueError()
            except FileNotFoundError: pass
        import secrets
        instance = root + '/instances/tibotattle-' + params['run'] + '-' + secrets.token_hex(16)
        journal(root, root_kind, True); removed = False
        os.mkdir(instance, 0o700)
        instance_identity = os.lstat(instance)
        if not stat.S_ISDIR(instance_identity.st_mode) or instance_identity.st_uid != 0 or os.path.realpath(instance) != instance: raise ValueError()
        journal(root, root_kind)
        instance_fd = os.open(instance, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        opened = os.fstat(instance_fd)
        if (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_uid) != (instance_identity.st_dev, instance_identity.st_ino, instance_identity.st_mode, instance_identity.st_uid): raise ValueError()
        setup_reason = 'trace_initial_controls_unavailable'
        control('tracing_on', '0\n')
        if local_read('tracing_on').strip() != '0' or local_read('current_tracer').strip() != 'nop' or local_read('events/enable').strip() != '0': raise ValueError()
        if local_read('set_event_pid').strip() or local_read('set_event_notrace_pid').strip(): raise ValueError()
        setup_reason = 'trace_cpu_layout_unavailable'
        cpu_set = cpus()
        listed = {int(name[3:]) for name in os.listdir(instance + '/per_cpu') if re.fullmatch(r'cpu[0-9]+', name)}
        if listed != cpu_set: raise ValueError()
        setup_reason = 'trace_buffer_layout_unavailable'
        configure_trace_buffer()
        setup_reason = 'trace_options_unavailable'
        control('options/overwrite', '0\n'); control('options/event-fork', '1\n')
        if local_read('options/overwrite').strip() != '0' or local_read('options/event-fork').strip() != '1' or local_read('options/context-info').strip() != '1': raise ValueError()
        setup_reason = 'trace_clock_unavailable'
        if 'mono' not in local_read('trace_clock').replace('[', '').replace(']', '').split(): raise ValueError()
        control('trace_clock', 'mono\n')
        if '[mono]' not in local_read('trace_clock').split(): raise ValueError()
        configure_trace_events()
        setup_reason = 'trace_pid_filter_unavailable'
        control('set_event_pid', str(root_pid) + '\n')
        if local_read('set_event_pid').split() != [str(root_pid)] or not no_loss(cpu_set): raise ValueError()
        setup_reason = 'trace_pipe_unavailable'
        trace_fd = os.open('trace_pipe', os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=instance_fd)
        setup_reason = 'trace_gate_recheck_unavailable'
        if verify_gate() != ((root_pid, root_start), profile): raise ValueError()
        setup_reason = 'trace_start_unavailable'
        control('tracing_on', '1\n')
        if local_read('tracing_on').strip() != '1': raise ValueError()
        armed = True
    except Exception: incomplete(setup_reason, True); raise
    emit({'kind': 'ready', 'start': start, 'rootPid': root_pid})
    pending = ''
    while time.monotonic_ns() // 1000 - start < 30000000:
        ready, _, _ = select.select([fd, trace_fd, sys.stdin], [], [], 0.025)
        if sys.stdin in ready:
            chunk = os.read(sys.stdin.fileno(), 256).decode('ascii', 'strict')
            if not chunk: stopping = True
            pending += chunk
            if len(pending) > 256: raise ValueError()
            while '\n' in pending:
                line, pending = pending.split('\n', 1)
                if line == 'stop': stopping = True
                else: raise ValueError()
        try: drain_trace(cpu_set)
        except OverflowError: incomplete('trace_limits_exceeded', True); break
        except Exception: incomplete('trace_stream_incomplete', True); break
        drain_kmsg()
        if cpus() != cpu_set: incomplete('trace_stream_incomplete', True); break
        if stopping: break
    else: incomplete('reader_timeout'); incomplete('reader_timeout', True)
except SystemExit: raise
except OverflowError: incomplete('stream_incomplete'); incomplete('trace_limits_exceeded', True)
except Exception: incomplete('reader_failed'); incomplete('reader_failed', True)
finally:
    if params is not None and sys.argv[1] == 'observe':
        try:
            if instance_fd is not None:
                control('tracing_on', '0\n')
                if local_read('tracing_on').strip() != '0': raise ValueError()
                if armed:
                    drain_trace(cpu_set, True); drain_kmsg()
                    if trace_pending or not no_loss(cpu_set, True): incomplete('trace_stream_incomplete', True)
                control('events/enable', '0\n'); control('options/event-fork', '0\n')
        except Exception: incomplete('trace_stream_incomplete', True)
        if trace_fd is not None: os.close(trace_fd)
        if fd is not None: os.close(fd)
        if instance_fd is not None: os.close(instance_fd)
        if instance_identity is not None:
            try:
                info = os.lstat(instance)
                if (info.st_dev, info.st_ino) != (instance_identity.st_dev, instance_identity.st_ino) or os.path.realpath(instance) != instance: raise ValueError()
                if armed and not gone(params['initPid'], params['initStart']): raise ValueError()
                os.rmdir(instance); removed = not os.path.lexists(instance)
            except Exception: removed = False
        if not removed: incomplete('trace_cleanup_failed', True)
        emit({'kind': 'closed', 'start': start, 'end': time.monotonic_ns() // 1000,
            'complete': complete, 'readerReason': reader_reason, 'profile': profile,
            'traceComplete': trace_complete and armed, 'traceReason': trace_reason if armed or trace_reason != 'none' else 'reader_failed', 'traceRemoved': removed})
`;
function collectLines(stream, callback, maximum = 262144) {
  let pending = '', size = 0, valid = true;
  stream.setEncoding('utf8'); stream.on('data', chunk => {
    size += Buffer.byteLength(chunk);
    if (size > maximum) { valid = false; pending = ''; return; }
    pending += chunk;
    let index;
    while ((index = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, index); pending = pending.slice(index + 1);
      try { callback(JSON.parse(line)); } catch { valid = false; }
    }
  });
  return () => valid && pending === '';
}
export function linuxMountAuditReaderReason({ spawnFailed, stopped, exitCode, valid, ready, closed, complete, readerReason }) {
  if (spawnFailed) return 'observer_start_failed';
  if (!stopped || exitCode === 124) return 'reader_timeout';
  if (!valid) return 'reader_failed';
  if (!closed) return ready ? 'reader_failed' : 'observer_start_failed';
  if (exitCode !== 0 || !READER_REASONS.has(readerReason)) return 'reader_failed';
  if (readerReason !== 'none') return readerReason;
  return ready && complete ? 'none' : 'reader_failed';
}
function traceContext({ role, stage, id, initPid = null, initStart = null, probe = null }) {
  return { directory: join(ROOT, LINUX_FINAL_INPUT), run: process.env.GITHUB_RUN_ID, runner: process.env.GITHUB_SHA,
    role, stage, container: id, uid: process.getuid(), initPid, initStart, probe };
}
function cleanupActorTrace(context) {
  const result = JSON.parse(command('sudo', ['-n', 'timeout', '--signal=TERM', '--kill-after=2s', '10s',
    'python3', '-u', '-c', LINUX_MOUNT_KMSG_READER, 'cleanup', JSON.stringify(context)], 4096, 15000));
  return exactKeys(result, ['removed']) && result.removed === true;
}
function beginKernelObserver(context) {
  // A root-owned deadline bounds the private observer; Docker stays unprivileged.
  const child = spawn('sudo', ['-n', 'timeout', '--signal=TERM', '--kill-after=2s', '32s',
    'python3', '-u', '-c', LINUX_MOUNT_KMSG_READER, 'observe', JSON.stringify(context)], { shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  const state = { ready: false, closed: false, complete: false, start: 0, end: 0, records: [], profile: null,
    rootPid: null, events: [], traceComplete: false, traceReason: 'not_started', traceRemoved: false, readerReason: 'none' };
  let exited = false, exitCode = null, spawnFailed = false;
  child.on('error', () => { spawnFailed = true; }); child.on('close', code => { exited = true; exitCode = code; });
  child.stdin.on('error', () => {});
  const valid = collectLines(child.stdout, row => {
    if (row.kind === 'ready' && exactKeys(row, ['kind', 'start', 'rootPid']) && Number.isSafeInteger(row.start)
      && Number.isSafeInteger(row.rootPid) && row.rootPid > 0 && !state.ready && !state.closed) Object.assign(state, row, { ready: true });
    else if (row.kind === 'actor' && exactKeys(row, ['kind', 'event']) && state.ready && !state.closed && state.events.length < 4096) state.events.push(row.event);
    else if (row.kind === 'entry' && exactKeys(row, ['kind', 'time', 'message']) && !state.closed
      && Number.isSafeInteger(row.time) && typeof row.message === 'string' && row.message.length <= 65536) state.records.push(row);
    else if (row.kind === 'closed' && !state.closed && exactKeys(row, ['kind', 'start', 'end', 'complete', 'readerReason', 'profile', 'traceComplete', 'traceReason', 'traceRemoved'])
      && Number.isSafeInteger(row.start) && Number.isSafeInteger(row.end) && typeof row.complete === 'boolean' && READER_REASONS.has(row.readerReason)
      && (row.profile === null || typeof row.profile === 'string' && row.profile.length <= 256)
      && typeof row.traceComplete === 'boolean' && LINUX_ACTOR_TRACE_REASONS.has(row.traceReason) && typeof row.traceRemoved === 'boolean') Object.assign(state, row, { closed: true });
    else fail();
  });
  return { state, async stop() {
    child.stdin.end('stop\n');
    const stopped = await waitUntil(() => exited, 35000);
    const reason = linuxMountAuditReaderReason({ ...state, spawnFailed, stopped, exitCode, valid: valid() });
    state.complete = stopped && exitCode === 0 && state.ready && state.closed && state.complete && valid() && reason === 'none';
    state.traceComplete = stopped && exitCode === 0 && state.ready && state.closed && state.traceComplete && valid() && state.traceReason === 'none';
    if (!state.traceComplete && state.traceReason === 'none') state.traceReason = 'trace_stream_incomplete';
    return { ...state, stopped, reason };
  } };
}
function statIdentity(text) {
  const fields = text?.slice(text.lastIndexOf(')') + 2).trim().split(' ');
  return fields && /^[0-9]+$/u.test(fields[19] ?? '') && /^[0-9]+$/u.test(fields[1] ?? '')
    ? { start: fields[19], parent: Number(fields[1]) } : null;
}

export async function linuxMountOwnedProcessGone(identity, { read = boundedRead } = {}) {
  if (!Number.isSafeInteger(identity?.pid) || identity.pid < 1 || !/^[0-9]+$/u.test(identity.start ?? '')) return UNKNOWN;
  try {
    const current = statIdentity(await read(`/proc/${identity.pid}/stat`, 4096));
    return current === null ? UNKNOWN : current.start !== identity.start;
  } catch (error) { return error.code === 'ENOENT' ? true : UNKNOWN; }
}

export function correlateLinuxMountAudit({ audit, profile, graph, temporary, containerRemoved, collectTuple = false }) {
  const unavailable = reason => ({ denial: UNKNOWN, reason, ...(collectTuple ? { tuple: null } : {}) });
  if (audit?.ready !== true || audit.closed !== true || audit.complete !== true || audit.reason !== 'none') return unavailable(
    ['observer_start_failed', ...READER_REASONS].includes(audit?.reason) && audit.reason !== 'none' ? audit.reason : 'reader_failed');
  if (!profile) return unavailable('profile_unavailable');
  if (containerRemoved !== true) return unavailable('probe_cleanup_unproven');
  if (!Number.isSafeInteger(audit.start) || !Number.isSafeInteger(audit.end) || audit.start >= audit.end
    || !new RegExp(`^${EXEC}/tmp/[a-f0-9]{32}$`, 'u').test(temporary)) return unavailable('audit_window_incomplete');
  if (graph?.complete !== true || graph.reason !== 'none' || !(graph.actors instanceof Map) || !graph.actors.size) return unavailable(
    LINUX_ACTOR_TRACE_REASONS.has(graph?.reason) && graph.reason !== 'none' ? graph.reason : 'probe_identity_unavailable');
  let recordObserved = false, actorUncorrelated = false, sourceUnrecognized = false, ambiguous = false;
  let matched = false, tuple = null, tupleAmbiguous = false;
  for (const record of audit.records) {
    if (!Number.isSafeInteger(record.time) || record.time < 0) { ambiguous = true; continue; }
    recordObserved = true;
    if (typeof record.message !== 'string' || record.message.includes('\\')) { ambiguous = true; continue; }
    const prefix = /^(?:audit: )?type=1400 audit\([0-9.]+:[0-9]+\): /u.exec(record.message);
    if (!prefix) { ambiguous = true; continue; }
    const body = record.message.slice(prefix[0].length), fields = {};
    const expression = /([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"\\\n]*)"|([^\s"\\=]+))(?: |$)/uy;
    let offset = 0, malformed = false;
    while (offset < body.length) {
      expression.lastIndex = offset;
      const match = expression.exec(body);
      if (!match || Object.hasOwn(fields, match[1])) { malformed = true; break; }
      fields[match[1]] = match[2] ?? match[3]; offset = expression.lastIndex;
    }
    if (malformed) { ambiguous = true; continue; }
    if (fields.apparmor !== 'DENIED' || fields.operation !== 'mount' || fields.profile !== profile
      || !fields.name?.startsWith(`${temporary}/`) || !/^\.mount_[A-Za-z0-9._-]+\/?$/u.test(fields.name.slice(temporary.length + 1))
      || !/^[1-9][0-9]*$/u.test(fields.pid ?? '')) continue;
    // LSM audit reports a global TGID; a unique traced global task lifetime
    // binds its owned thread group, not the exact calling thread. Container
    // closure above is still required after the leader's sched exit event.
    const owned = graph.actors.get(Number(fields.pid));
    if (!(owned && owned.pid === Number(fields.pid) && owned.appImage === true && owned.alive === false && Number.isSafeInteger(owned.birth) && owned.birth >= 0)) { actorUncorrelated = true; continue; }
    if (!(fields.fstype === 'fuse.squashfuse' && fields.srcname === 'squashfuse'
      || ['fuse.TiboTattle.AppImage', 'fuse'].includes(fields.fstype) && [IMAGE, 'TiboTattle.AppImage'].includes(fields.srcname))) { sourceUnrecognized = true; continue; }
    if (!collectTuple) return { denial: true, reason: 'owned_mount_denial' };
    const next = normalizeLinuxAppArmorMountTuple(fields);
    if (next === null || matched && JSON.stringify(next) !== JSON.stringify(tuple)) tupleAmbiguous = true;
    matched = true; tuple = next;
  }
  if (matched) return { denial: true, reason: 'owned_mount_denial', tuple: tupleAmbiguous || sourceUnrecognized ? null : tuple };
  // The seek-to-end, complete reader bounds capture, including delayed audit.
  // kmsg delivery uses a different clock: never compare it with Python monotonic
  // boundaries or kernel task birth/lifetime events.
  // A complete read window still does not prove audit generation was enabled.
  return unavailable(sourceUnrecognized ? 'owned_target_source_unrecognized' : actorUncorrelated ? 'owned_actor_not_correlated'
    : ambiguous ? 'match_ambiguous' : recordObserved ? 'no_correlated_mount_denial' : 'no_observed_mount_denial');
}
// A reused PID across serial cases cannot establish which delayed audit record
// it owns. Keep this bounded set only in memory; no operational identities leak.
const priorActorPids = new Set();
async function runHostProbe(role, expected, { stage = 'default', nonce = randomBytes(16).toString('hex'), profile = null } = {}) {
  const run = process.env.GITHUB_RUN_ID;
  if (!/^[1-9][0-9]{0,14}$/u.test(run ?? '')) fail();
  const name = `tibotattle-mount-diagnosis-${caseSuffix(stage, role)}-${run}`, temporary = `${EXEC}/tmp/${nonce}`;
  const row = { role, artifactSha256: expected.sha256, artifactBytes: expected.bytes, probe: null, errorCode: 'container_failed',
    appArmorMountDenial: UNKNOWN, appArmorAuditReason: 'not_started', containerRemoved: false, observerStopped: true,
    actorTrace: { complete: false, reason: 'not_started', instanceRemoved: true } };
  let id = null, child = null, audit = null, kernel = null, context = null, initIdentity = null, initPid = null, tuple = null, profileApplied = false, configuredProfile = null;
  try {
    if (command('docker', ['ps', '-aq', '--filter', `name=^/${name}$`])) fail();
    id = command('docker', linuxMountContainerArguments({ name, role, nonce, runnerRevision: process.env.GITHUB_SHA, stage, profile }));
    if (!/^[a-f0-9]{64}$/u.test(id)) fail();
    child = spawn('docker', ['start', '--attach', '--interactive', id], { cwd: ROOT, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    let ready = false, result = null, namespacePid = null, gateFailed = false, exited = false;
    child.on('error', () => { exited = true; }); child.on('close', () => { exited = true; });
    const valid = collectLines(child.stdout, value => {
      if (exactKeys(value, ['kind', 'pid']) && value.kind === 'ready' && !ready && Number.isSafeInteger(value.pid) && value.pid > 0) { ready = true; namespacePid = value.pid; }
      else if (exactKeys(value, ['kind']) && value.kind === 'gate_failed' && !gateFailed) gateFailed = true;
      else if (exactKeys(value, ['kind', 'probe']) && value.kind === 'result' && result === null && validProbe(value.probe)) result = value.probe;
      else fail();
    }, 65536);
    if (!await waitUntil(() => ready || exited || gateFailed, 10000) || !ready || !valid() || gateFailed) fail();
    configuredProfile = stage === 'default' ? null : command('docker', ['inspect', '--format', '{{.AppArmorProfile}}', id]);
    initPid = Number(command('docker', ['inspect', '--format', '{{.State.Pid}}', id]));
    if (!Number.isSafeInteger(initPid) || initPid < 1) fail();
    initIdentity = statIdentity(await optionalRead(`/proc/${initPid}/stat`, 4096));
    if (initIdentity === null) fail();
    context = traceContext({ role, stage, id, initPid, initStart: initIdentity.start, probe: namespacePid });
    audit = beginKernelObserver(context); row.observerStopped = false; row.appArmorAuditReason = 'not_evaluated';
    if (!await waitUntil(() => audit.state.ready || audit.state.closed, 5000) || !audit.state.ready || audit.state.closed) fail();
    child.stdin.on('error', () => {}); child.stdin.write('go\n');
    await waitUntil(() => result !== null || exited || gateFailed, 18000);
    if (gateFailed) { row.errorCode = 'launcher_gate_failed'; row.appArmorAuditReason = 'launcher_gate_failed'; }
    else if (result === null || !valid()) row.errorCode = 'probe_failed';
    else { row.probe = result; row.errorCode = 'none'; }
  } catch { /* Only the closed row leaves this process. */ }
  finally {
    // The owned container/processes stop before disabling/draining the instance.
    if (id && /^[a-f0-9]{64}$/u.test(id)) {
      try {
        command('docker', ['rm', '--force', id]);
        const absent = command('docker', ['ps', '-aq', '--filter', `id=${id}`]) === '';
        const gone = await linuxMountOwnedProcessGone(initIdentity ? { pid: initPid, start: initIdentity.start } : null);
        row.containerRemoved = absent && gone === true;
      } catch { /* Next case is refused unless removal is verified. */ }
    }
    if (audit) {
      kernel = await audit.stop();
      if (kernel.stopped && !kernel.traceRemoved && row.containerRemoved) {
        try { kernel.traceRemoved = cleanupActorTrace(context); } catch { /* Exact journal only. */ }
      }
      row.observerStopped = kernel.stopped && kernel.traceRemoved;
      const graph = buildLinuxAppImageActorGraph({ rootPid: kernel.rootPid, events: kernel.events, complete: kernel.traceComplete, reason: kernel.traceReason, priorPids: priorActorPids });
      for (const pid of graph.actors.keys()) priorActorPids.add(pid);
      row.actorTrace = { complete: graph.complete, reason: graph.reason, instanceRemoved: kernel.traceRemoved };
      const attribution = correlateLinuxMountAudit({ audit: kernel, profile: kernel.profile, graph, temporary, containerRemoved: row.containerRemoved, collectTuple: stage !== 'default' });
      profileApplied = stage !== 'default' && configuredProfile === profile && kernel.profile === profile;
      tuple = profileApplied ? attribution.tuple ?? null : null;
      row.appArmorMountDenial = attribution.denial; row.appArmorAuditReason = attribution.reason;
      if (!graph.complete && row.errorCode === 'none') row.errorCode = 'probe_failed';
    }
    child?.kill('SIGTERM');
    if (!row.containerRemoved || !row.observerStopped) row.errorCode = 'cleanup_failed';
  }
  return stage === 'default' ? row : { row, tuple, profileApplied };
}
export function linuxMountCleanupArguments({ markerId, inspected }, { role, run, runner, stage = 'default' }) {
  if (!PROBE_STAGES.includes(stage) || !ROLES.includes(role) || !/^[1-9][0-9]{0,14}$/u.test(run ?? '') || !/^[a-f0-9]{40}$/u.test(runner ?? '')
    || !/^[a-f0-9]{64}$/u.test(markerId ?? '') || !exactKeys(inspected, ['id', 'name', 'labels'])
    || inspected.id !== markerId || inspected.name !== `/tibotattle-mount-diagnosis-${caseSuffix(stage, role)}-${run}`
    || inspected.labels?.['io.tibotattle.mount-diagnosis.run'] !== run
    || inspected.labels?.['io.tibotattle.mount-diagnosis.runner'] !== runner
    || inspected.labels?.['io.tibotattle.mount-diagnosis.role'] !== role
    || stage !== 'default' && inspected.labels?.['io.tibotattle.mount-diagnosis.stage'] !== stage) fail();
  return ['rm', '--force', markerId];
}
export async function cleanupLinuxMountDiagnosis({ removeProfiles = true } = {}) {
  if (typeof removeProfiles !== 'boolean') fail();
  const run = process.env.GITHUB_RUN_ID, runner = process.env.GITHUB_SHA;
  if (!/^[1-9][0-9]{0,14}$/u.test(run ?? '') || !/^[a-f0-9]{40}$/u.test(runner ?? '')) fail();
  for (const stage of PROBE_STAGES) for (const role of ROLES) {
    const marker = join(ROOT, LINUX_FINAL_INPUT, `.mount-diagnosis-${caseSuffix(stage, role)}.container`);
    let stat;
    try { stat = await lstat(marker); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Without the container marker no trace ownership may be inferred.
      for (const ending of ['.json', '.intent.json']) {
        try { await lstat(join(ROOT, LINUX_FINAL_INPUT, `.mount-trace-${caseSuffix(stage, role)}${ending}`)); fail(); }
        catch (traceError) { if (traceError.code !== 'ENOENT') throw traceError; }
      }
      continue;
    }
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail();
    const id = (await fingerprintLinuxFinalFile(marker, 256, true)).contents.toString('utf8').trim();
    if (!/^[a-f0-9]{64}$/u.test(id)) fail();
    if (!command('docker', ['ps', '-aq', '--filter', `id=${id}`])) {
      if (!cleanupActorTrace(traceContext({ role, stage, id }))) fail();
      continue;
    }
    const inspected = JSON.parse(command('docker', ['inspect', '--format',
      '{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Config.Labels}}}', id]));
    command('docker', linuxMountCleanupArguments({ markerId: id, inspected }, { role, run, runner, stage }));
    if (command('docker', ['ps', '-aq', '--filter', `id=${id}`])) fail();
    if (!cleanupActorTrace(traceContext({ role, stage, id }))) fail();
  }
  if (removeProfiles && !await cleanupLinuxAppArmorProfiles({ directory: join(ROOT, LINUX_FINAL_INPUT), run, runner, containersGone: true })) fail();
}
/** Native adapters are shared with the host lifecycle wrapper. The diagnostic
 * CLI supplies no callback and remains mount-only; the comparison receipt never
 * becomes lifecycle or release qualification. */
export async function runLinuxNativeAppArmorComparison(pair, { interrupted = () => false, onCandidateVerified = null } = {}) {
  validateLinuxFinalPair(pair, process.env.GITHUB_SHA);
  if (typeof interrupted !== 'function' || onCandidateVerified !== null && typeof onCandidateVerified !== 'function') fail();
  const nonce = randomBytes(16).toString('hex'), outsideNonce = randomBytes(16).toString('hex');
  if (nonce === outsideNonce) fail();
  const directory = join(ROOT, LINUX_FINAL_INPUT), intake = pair.intake;
  return runLinuxAppArmorComparison(pair, {
    prepareProfiles: () => prepareLinuxAppArmorProfiles({ root: ROOT, directory, run: process.env.GITHUB_RUN_ID, runner: intake.runnerRevision, nonce }),
    runProbe: (stage, role, expected, profile) => runHostProbe(role, expected, { stage, profile, nonce: stage === 'negative' ? outsideNonce : nonce }),
    validateRow: row => validateLinuxMountDiagnosis({ schemaVersion: LINUX_MOUNT_DIAGNOSIS_SCHEMA, purpose: 'diagnostic_only', qualifiesRelease: false,
      runnerRevision: intake.runnerRevision, sourceRevision: intake.sourceRevision, cases: [{ ...row, role: 'current' }] }) !== null,
    interrupted, onCandidateVerified,
  });
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...rest] = process.argv.slice(2);
    if (rest.length || !['--preflight', '--acquire', '--prepare', '--execute', '--inside', '--gate', '--cleanup'].includes(mode)) fail();
    if (mode === '--cleanup') { await cleanupLinuxMountDiagnosis(); process.stdout.write('Owned diagnostic container cleanup complete.\n'); }
    else if (mode === '--inside') await runInside();
    else if (mode === '--gate') runGate();
    else {
      const intake = preflightLinuxFinalIntake(linuxMountPreflightEnvironment(process.env), { repositoryRoot: ROOT });
      if (mode !== '--preflight' && process.env.SELECTED_MODE !== 'execute') fail();
      if (mode === '--execute') {
        process.umask(0o077);
        const directory = join(ROOT, LINUX_FINAL_INPUT);
        const pair = validateLinuxFinalPair(JSON.parse((await fingerprintLinuxFinalFile(join(directory, 'pair.json'), 131072, true)).contents), intake.runnerRevision);
        const comparison = process.env.SELECTED_POLICY === 'apparmor-comparison';
        let interrupted = false;
        const cancel = () => { interrupted = true; };
        if (comparison) { process.on('SIGTERM', cancel); process.on('SIGINT', cancel); }
        let receipt;
        try {
          receipt = comparison ? await runLinuxNativeAppArmorComparison(pair, { interrupted: () => interrupted })
            : await runLinuxMountSequence(pair, runHostProbe);
        } finally { if (comparison) { process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel); } }
        const handle = await open(join(directory, comparison ? 'apparmor-comparison.json' : 'mount-diagnosis.json'), 'wx', 0o600);
        try { await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
        process.stdout.write('Linux mount-only diagnostic retained; lifecycle qualification remains separate.\n');
        if (comparison ? receipt.outcome !== 'compared' : receipt.cases.length !== 2 || receipt.cases.some(row => row.errorCode !== 'none')) process.exitCode = 1;
      } else {
        if (mode === '--acquire') await acquireLinuxFinalArtifacts(intake);
        if (mode === '--prepare') await prepareLinuxFinalArtifacts(intake);
        process.stdout.write('Linux mount-only diagnostic intake accepted.\n');
      }
    }
  } catch { process.stderr.write('LINUX_MOUNT_DIAGNOSIS_REFUSED\n'); process.exitCode = 1; }
}
