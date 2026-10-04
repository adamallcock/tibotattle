#!/usr/bin/env node
// A mount-only comparison of exact prebuilt images. This never runs AppRun or
// Electron and never supplies installed-lifecycle or release qualification.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertContainerContract } from './smoke-electron-linux.mjs';
import { createLinuxStartupDiagnostics, validateLinuxStartupDiagnostic, classifyLinuxStartupFuseMount } from './lib/linux-startup-diagnostics.mjs';
import { acquireLinuxFinalArtifacts, prepareLinuxFinalArtifacts, fingerprintLinuxFinalFile } from './qualify-electron-linux-installed-lifecycle.mjs';
import { LINUX_FINAL_CONFIRMATION, LINUX_FINAL_INPUT, exactKeys, preflightLinuxFinalIntake, validateLinuxFinalPair } from './lib/linux-final-artifact-intake.mjs';

import { LINUX_APPARMOR_COMPARISON_CONFIRMATION, normalizeLinuxAppArmorMountTuple, prepareLinuxAppArmorProfiles,
  cleanupLinuxAppArmorProfiles, runLinuxAppArmorComparison } from './lib/linux-apparmor-mount-profile.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXEC = '/opt/tibotattle-updater-exec', IMAGE = `${EXEC}/TiboTattle.AppImage`;
const SCRIPT = 'scripts/diagnose-electron-linux-appimage-mount.mjs';
export const LINUX_MOUNT_DIAGNOSIS_SCHEMA = 'tibotattle-linux-appimage-mount-diagnosis-v2';
export const LINUX_MOUNT_DIAGNOSIS_CONFIRMATION = 'RUN_DISPOSABLE_LINUX_APPIMAGE_MOUNT_DIAGNOSIS';
const UNKNOWN = 'unavailable', ROLES = ['current', 'next'];
const PROBE_STAGES = ['default', 'baseline', 'candidate', 'negative'];
const ERRORS = new Set(['none', 'container_failed', 'probe_failed', 'cleanup_failed']);
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
const AUDIT_REASONS = new Set(['not_started', 'not_evaluated', 'observer_start_failed', ...READER_REASONS.values(),
  'profile_unavailable', 'probe_identity_unavailable', 'audit_window_incomplete', 'no_observed_mount_denial',
  'no_correlated_mount_denial', 'owned_target_source_unrecognized', 'owned_actor_not_correlated', 'match_ambiguous', 'owned_mount_denial']);
AUDIT_REASONS.delete('none');
const booleanOrUnknown = value => typeof value === 'boolean' || value === UNKNOWN;
const fail = () => { throw new Error('LINUX_MOUNT_DIAGNOSIS_REFUSED'); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const monotonic = () => Number(process.hrtime.bigint() / 1000n);
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
async function runtimeFacts() {
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
    if (!exactKeys(row, ['role', 'artifactSha256', 'artifactBytes', 'probe', 'errorCode', 'appArmorMountDenial', 'appArmorAuditReason', 'containerRemoved', 'observerStopped'])
      || row.role !== ROLES[index] || !/^[a-f0-9]{64}$/u.test(row.artifactSha256 ?? '')
      || !Number.isSafeInteger(row.artifactBytes) || row.artifactBytes < 4096 || row.artifactBytes > 1024 ** 3
      || row.probe !== null && !validProbe(row.probe) || !ERRORS.has(row.errorCode)
      || ![true, UNKNOWN].includes(row.appArmorMountDenial) || !AUDIT_REASONS.has(row.appArmorAuditReason)
      || (row.appArmorMountDenial === true) !== (row.appArmorAuditReason === 'owned_mount_denial') || typeof row.containerRemoved !== 'boolean' || typeof row.observerStopped !== 'boolean'
      || row.errorCode === 'none' && (row.probe === null || !row.containerRemoved || !row.observerStopped)
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
    || process.env.ELECTRON_DISABLE_SANDBOX !== '0' || process.env.APPIMAGE_EXTRACT_AND_RUN !== undefined
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
  const environment = await runtimeFacts();
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  let input = '', go = false, invalidInput = false;
  process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { if (invalidInput) return; input += chunk; if (input.length > 16) { input = ''; invalidInput = true; } go = input === 'go\n'; });
  send({ kind: 'ready' });
  if (!await waitUntil(() => go || invalidInput, 10000) || invalidInput) fail();
  const child = spawn(IMAGE, ['--appimage-mount'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TMPDIR: temporary, LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' } });
  const sampleMount = process.env.TIBOTATTLE_MOUNT_PROBE_COMPARISON === '1'
    ? async () => projectLinuxMountProbeFacts(await optionalRead('/proc/self/mountinfo', 262144), temporary) : null;
  const startup = createLinuxStartupDiagnostics({ child, sampleMount }), errors = createLinuxMountErrorClassifier();
  child.stdout.resume(); child.stderr.on('data', chunk => { startup.feed(chunk); errors.feed(chunk); });
  send({ kind: 'child', pid: child.pid ?? null });
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

// /dev/kmsg is opened read-only at its current end; no historical kernel log is
// collected. Sequence gaps, continuation records, overflow and access failures
// all make the stream incomplete. Raw kernel records stay in this private pipe.
export const LINUX_MOUNT_KMSG_READER = String.raw`
import errno, json, os, re, select, sys, time
fd = None
start = time.monotonic_ns() // 1000
complete = True
reader_reason = 'none'
last = None
used = 0
profile = None
observations = {}
probe = None
pending = ''
def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)
def incomplete(reason):
    global complete, reader_reason
    complete = False
    if reader_reason == 'none': reader_reason = reason
def read(path, limit=16384):
    with open(path, 'r', encoding='utf-8') as handle:
        value = handle.read(limit + 1)
    if len(value) > limit: raise ValueError('bound')
    return value
def identity(pid):
    fields = read('/proc/' + str(pid) + '/stat', 4096).rsplit(')', 1)[1].split()
    return fields[19], int(fields[1])
def sample():
    if probe is None or not group or not namespace or not profile: return
    try:
        pids = read('/sys/fs/cgroup' + group + '/cgroup.procs').splitlines()
        if len(pids) > 128 or any(not re.fullmatch(r'[1-9][0-9]*', pid) for pid in pids): return
        snapshot = {}
        for rawpid in pids:
            try:
                pid = int(rawpid)
                before = identity(pid)
                status = read('/proc/' + rawpid + '/status')
                ns = os.readlink('/proc/' + rawpid + '/ns/pid')
                actor_profile = read('/proc/' + rawpid + '/attr/current', 256)
                nspid = re.findall(r'^NSpid:\s+([0-9\t ]+)$', status, re.M)
                if before != identity(pid) or ns != namespace or actor_profile != raw_profile or read('/proc/' + rawpid + '/cgroup', 4096) != cgroup or len(nspid) != 1: continue
                snapshot[pid] = (before[0], before[1], int(nspid[0].split()[-1]))
            except Exception: continue
        roots = [pid for pid, data in snapshot.items() if data[2] == probe]
        if len(roots) != 1: return
        now = time.monotonic_ns() // 1000
        for pid, data in snapshot.items():
            ancestor = pid
            owned = False
            for depth in range(32):
                if ancestor == roots[0]:
                    owned = True
                    break
                if ancestor not in snapshot: break
                ancestor = snapshot[ancestor][1]
            if not owned: continue
            prior = observations.get(pid)
            if len(observations) >= 128 and prior is None: continue
            ambiguous = prior is not None and (prior['ambiguous'] or prior['start'] != data[0])
            observations[pid] = {'pid': pid, 'start': data[0], 'ambiguous': ambiguous,
                'first': prior['first'] if prior and not ambiguous else now, 'last': now}
    except Exception: pass
try:
    init = sys.argv[1]
    if not re.fullmatch(r'[1-9][0-9]*', init): raise ValueError('identity')
    group = namespace = None
    try:
        cgroup = read('/proc/' + init + '/cgroup', 4096)
        match = re.fullmatch(r'0::(/[A-Za-z0-9/_.:-]+)\n', cgroup)
        if match and '..' not in match[1].split('/'): group = match[1]
        namespace = os.readlink('/proc/' + init + '/ns/pid')
        raw_profile = read('/proc/' + init + '/attr/current', 256)
        match = re.fullmatch(r'([^\n()]+) \(enforce\)\n?', raw_profile)
        if match: profile = match[1]
    except Exception: pass
    try:
        fd = os.open('/dev/kmsg', os.O_RDONLY | os.O_NONBLOCK)
    except OSError as error:
        incomplete('kmsg_open_denied' if error.errno in (errno.EACCES, errno.EPERM) else 'kmsg_open_unavailable')
        raise
    os.lseek(fd, 0, os.SEEK_END)
    start = time.monotonic_ns() // 1000
    emit({'kind': 'ready', 'start': start})
    stopping = False
    while time.monotonic_ns() // 1000 - start < 30000000:
        ready, _, _ = select.select([fd, sys.stdin], [], [], 0.05)
        if sys.stdin in ready:
            chunk = os.read(sys.stdin.fileno(), 256).decode('ascii', 'strict')
            if not chunk: stopping = True
            pending += chunk
            if len(pending) > 256: raise ValueError('input bound')
            while '\n' in pending:
                line, pending = pending.split('\n', 1)
                if line == 'stop': stopping = True
                elif re.fullmatch(r'probe [1-9][0-9]*', line) and probe is None: probe = int(line.split()[1])
                else: raise ValueError('input')
        sample()
        while True:
            try: record = os.read(fd, 65536)
            except BlockingIOError: break
            except OSError as error:
                incomplete('stream_incomplete' if error.errno == errno.EPIPE else 'reader_failed')
                stopping = True
                break
            used += len(record)
            if not record or used > 262144:
                incomplete('stream_incomplete')
                stopping = True
                break
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
        if stopping: break
    else: incomplete('reader_timeout')
except Exception:
    incomplete('reader_failed')
finally:
    if fd is not None: os.close(fd)
    emit({'kind': 'closed', 'start': start, 'end': time.monotonic_ns() // 1000,
        'complete': complete, 'readerReason': reader_reason, 'profile': profile, 'observations': list(observations.values())})
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
function beginKernelObserver(initPid) {
  if (!Number.isSafeInteger(initPid) || initPid < 1) fail();
  // A root-owned timeout bounds and reaps the read-only observer even if its
  // controller is interrupted. Docker itself remains unprivileged here.
  const child = spawn('sudo', ['-n', 'timeout', '--signal=TERM', '--kill-after=2s', '32s',
    'python3', '-u', '-c', LINUX_MOUNT_KMSG_READER, String(initPid)], { shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  const state = { ready: false, closed: false, complete: false, start: 0, end: 0, records: [], profile: null, observations: [], readerReason: 'none' };
  let exited = false, exitCode = null, spawnFailed = false;
  child.on('error', () => { spawnFailed = true; }); child.on('close', code => { exited = true; exitCode = code; });
  child.stdin.on('error', () => {});
  const valid = collectLines(child.stdout, row => {
    if (row.kind === 'ready' && exactKeys(row, ['kind', 'start']) && Number.isSafeInteger(row.start) && !state.ready) { state.ready = true; state.start = row.start; }
    else if (row.kind === 'entry' && exactKeys(row, ['kind', 'time', 'message']) && Number.isSafeInteger(row.time) && typeof row.message === 'string' && row.message.length <= 65536) state.records.push(row);
    else if (row.kind === 'closed' && exactKeys(row, ['kind', 'start', 'end', 'complete', 'readerReason', 'profile', 'observations'])
      && Number.isSafeInteger(row.start) && Number.isSafeInteger(row.end) && typeof row.complete === 'boolean' && READER_REASONS.has(row.readerReason)
      && (row.profile === null || typeof row.profile === 'string' && row.profile.length <= 256)
      && Array.isArray(row.observations) && row.observations.length <= 128 && row.observations.every(item =>
        exactKeys(item, ['pid', 'start', 'ambiguous', 'first', 'last']) && Number.isSafeInteger(item.pid) && item.pid > 0
        && /^[0-9]+$/u.test(item.start ?? '') && typeof item.ambiguous === 'boolean' && Number.isSafeInteger(item.first) && Number.isSafeInteger(item.last))) Object.assign(state, row, { closed: true });
    else fail();
  });
  return { state, setProbe(pid) { if (Number.isSafeInteger(pid) && pid > 0) child.stdin.write(`probe ${pid}\n`); }, async stop() {
    child.stdin.end('stop\n');
    // A JSON footer is evidence, not proof the privileged observer has exited.
    const stopped = await waitUntil(() => exited, 35000);
    const reason = linuxMountAuditReaderReason({ ...state, spawnFailed, stopped, exitCode, valid: valid() });
    state.complete = stopped && exitCode === 0 && state.ready && state.closed && state.complete && valid() && reason === 'none';
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

export function correlateLinuxMountAudit({ audit, profile, observations, temporary, start, end, collectTuple = false }) {
  const unavailable = reason => ({ denial: UNKNOWN, reason, ...(collectTuple ? { tuple: null } : {}) });
  if (!audit?.ready || !audit.closed || !audit.complete || audit.reason !== 'none') return unavailable(
    ['observer_start_failed', ...READER_REASONS].includes(audit?.reason) && audit.reason !== 'none' ? audit.reason : 'reader_failed');
  if (!profile) return unavailable('profile_unavailable');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || audit.start > start || audit.end < end || start >= end
    || !new RegExp(`^${EXEC}/tmp/[a-f0-9]{32}$`, 'u').test(temporary)) return unavailable('audit_window_incomplete');
  if (!(observations instanceof Map) || !observations.size) return unavailable('probe_identity_unavailable');
  let recordObserved = false, actorUncorrelated = false, sourceUnrecognized = false, ambiguous = false;
  let matched = false, tuple = null, tupleAmbiguous = false;
  for (const record of audit.records) {
    if (record.time < start || record.time > end) continue;
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
    const owned = observations.get(Number(fields.pid));
    if (!(owned && owned.ambiguous === false && /^[0-9]+$/u.test(owned.start ?? '')
      && Number.isSafeInteger(owned.first) && Number.isSafeInteger(owned.last)
      && owned.first <= record.time && owned.last >= record.time)) { actorUncorrelated = true; continue; }
    if (!(fields.fstype === 'fuse.squashfuse' && fields.srcname === 'squashfuse'
      || ['fuse.TiboTattle.AppImage', 'fuse'].includes(fields.fstype) && [IMAGE, 'TiboTattle.AppImage'].includes(fields.srcname))) { sourceUnrecognized = true; continue; }
    if (!collectTuple) return { denial: true, reason: 'owned_mount_denial' };
    const next = normalizeLinuxAppArmorMountTuple(fields);
    if (next === null || matched && JSON.stringify(next) !== JSON.stringify(tuple)) tupleAmbiguous = true;
    matched = true; tuple = next;
  }
  if (matched) return { denial: true, reason: 'owned_mount_denial', tuple: tupleAmbiguous || sourceUnrecognized ? null : tuple };
  // Sampling cannot prove all fork/exit events or that audit generation was
  // enabled. Even a complete read window with no match is not negative proof.
  return unavailable(sourceUnrecognized ? 'owned_target_source_unrecognized' : actorUncorrelated ? 'owned_actor_not_correlated'
    : ambiguous ? 'match_ambiguous' : recordObserved ? 'no_correlated_mount_denial' : 'no_observed_mount_denial');
}
async function runHostProbe(role, expected, { stage = 'default', nonce = randomBytes(16).toString('hex'), profile = null } = {}) {
  const run = process.env.GITHUB_RUN_ID;
  if (!/^[1-9][0-9]{0,14}$/u.test(run ?? '')) fail();
  const name = `tibotattle-mount-diagnosis-${caseSuffix(stage, role)}-${run}`, temporary = `${EXEC}/tmp/${nonce}`;
  const row = { role, artifactSha256: expected.sha256, artifactBytes: expected.bytes, probe: null, errorCode: 'container_failed', appArmorMountDenial: UNKNOWN, appArmorAuditReason: 'not_started', containerRemoved: false, observerStopped: true };
  let id = null, child = null, audit = null, initIdentity = null, initPid = null, tuple = null, profileApplied = false;
  try {
    if (command('docker', ['ps', '-aq', '--filter', `name=^/${name}$`])) fail();
    id = command('docker', linuxMountContainerArguments({ name, role, nonce, runnerRevision: process.env.GITHUB_SHA, stage, profile }));
    if (!/^[a-f0-9]{64}$/u.test(id)) fail();
    child = spawn('docker', ['start', '--attach', '--interactive', id], { cwd: ROOT, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    let ready = false, result = null, childSeen = false, exited = false;
    child.on('error', () => { exited = true; }); child.on('close', () => { exited = true; });
    const valid = collectLines(child.stdout, value => {
      if (exactKeys(value, ['kind']) && value.kind === 'ready' && !ready) ready = true;
      else if (exactKeys(value, ['kind', 'pid']) && value.kind === 'child' && !childSeen && (value.pid === null || Number.isSafeInteger(value.pid) && value.pid > 0)) { childSeen = true; if (value.pid !== null) audit?.setProbe(value.pid); }
      else if (exactKeys(value, ['kind', 'probe']) && value.kind === 'result' && result === null && validProbe(value.probe)) result = value.probe;
      else fail();
    }, 65536);
    if (!await waitUntil(() => ready || exited, 10000) || !ready || !valid()) fail();
    const configuredProfile = stage === 'default' ? null : command('docker', ['inspect', '--format', '{{.AppArmorProfile}}', id]);
    initPid = Number(command('docker', ['inspect', '--format', '{{.State.Pid}}', id]));
    if (!Number.isSafeInteger(initPid) || initPid < 1) fail();
    initIdentity = statIdentity(await optionalRead(`/proc/${initPid}/stat`, 4096));
    if (initIdentity === null) fail();
    audit = beginKernelObserver(initPid); row.observerStopped = false; row.appArmorAuditReason = 'not_evaluated'; await waitUntil(() => audit.state.ready || audit.state.closed, 2000);
    const start = monotonic(); child.stdin.on('error', () => {}); child.stdin.write('go\n');
    await waitUntil(() => result !== null || exited, 18000);
    const end = monotonic(), kernel = await audit.stop(); row.observerStopped = kernel.stopped; audit = null;
    const attribution = correlateLinuxMountAudit({ audit: kernel, profile: kernel.profile, observations: new Map(kernel.observations.map(item => [item.pid, item])), temporary, start, end, collectTuple: stage !== 'default' });
    profileApplied = stage !== 'default' && configuredProfile === profile && kernel.profile === profile;
    tuple = profileApplied ? attribution.tuple ?? null : null;
    row.appArmorMountDenial = attribution.denial; row.appArmorAuditReason = attribution.reason;
    if (result === null || !valid()) { row.errorCode = 'probe_failed'; }
    else { row.probe = result; row.errorCode = 'none'; }
  } catch { /* Only the closed row leaves this process. */ }
  finally {
    if (audit) row.observerStopped = (await audit.stop()).stopped;
    if (id && /^[a-f0-9]{64}$/u.test(id)) {
      try {
        command('docker', ['rm', '--force', id]);
        const absent = command('docker', ['ps', '-aq', '--filter', `id=${id}`]) === '';
        const gone = await linuxMountOwnedProcessGone(initIdentity ? { pid: initPid, start: initIdentity.start } : null);
        row.containerRemoved = absent && gone === true;
      } catch { /* Next case is refused unless removal is verified. */ }
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
async function cleanupRecordedContainers() {
  const run = process.env.GITHUB_RUN_ID, runner = process.env.GITHUB_SHA;
  if (!/^[1-9][0-9]{0,14}$/u.test(run ?? '') || !/^[a-f0-9]{40}$/u.test(runner ?? '')) fail();
  for (const stage of PROBE_STAGES) for (const role of ROLES) {
    const marker = join(ROOT, LINUX_FINAL_INPUT, `.mount-diagnosis-${caseSuffix(stage, role)}.container`);
    let stat;
    try { stat = await lstat(marker); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail();
    const id = (await fingerprintLinuxFinalFile(marker, 256, true)).contents.toString('utf8').trim();
    if (!/^[a-f0-9]{64}$/u.test(id)) fail();
    if (!command('docker', ['ps', '-aq', '--filter', `id=${id}`])) continue;
    const inspected = JSON.parse(command('docker', ['inspect', '--format',
      '{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Config.Labels}}}', id]));
    command('docker', linuxMountCleanupArguments({ markerId: id, inspected }, { role, run, runner, stage }));
    if (command('docker', ['ps', '-aq', '--filter', `id=${id}`])) fail();
  }
  if (!await cleanupLinuxAppArmorProfiles({ directory: join(ROOT, LINUX_FINAL_INPUT), run, runner, containersGone: true })) fail();
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...rest] = process.argv.slice(2);
    if (rest.length || !['--preflight', '--acquire', '--prepare', '--execute', '--inside', '--cleanup'].includes(mode)) fail();
    if (mode === '--cleanup') { await cleanupRecordedContainers(); process.stdout.write('Owned diagnostic container cleanup complete.\n'); }
    else if (mode === '--inside') await runInside();
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
        const nonce = randomBytes(16).toString('hex'), outsideNonce = randomBytes(16).toString('hex');
        let receipt;
        try {
          receipt = comparison ? await runLinuxAppArmorComparison(pair, {
            prepareProfiles: () => prepareLinuxAppArmorProfiles({ root: ROOT, directory, run: process.env.GITHUB_RUN_ID, runner: intake.runnerRevision, nonce }),
            runProbe: (stage, role, expected, profile) => runHostProbe(role, expected, { stage, profile, nonce: stage === 'negative' ? outsideNonce : nonce }),
            validateRow: row => validateLinuxMountDiagnosis({ schemaVersion: LINUX_MOUNT_DIAGNOSIS_SCHEMA, purpose: 'diagnostic_only', qualifiesRelease: false,
              runnerRevision: intake.runnerRevision, sourceRevision: intake.sourceRevision, cases: [{ ...row, role: 'current' }] }) !== null,
            interrupted: () => interrupted,
          }) : await runLinuxMountSequence(pair, runHostProbe);
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
