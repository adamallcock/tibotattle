// Diagnostic-only projection: no stderr text, process identifiers or paths leave
// this module. It cannot decide whether the application qualifies.
import { open } from 'node:fs/promises';

export const LINUX_STARTUP_DIAGNOSTIC_SCHEMA = 'tibotattle-linux-startup-diagnostic-v1';
const ERRNOS = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'EAGAIN', 'ENOMEM', 'EPERM', 'ETXTBSY', 'UNKNOWN']);
const SIGNALS = new Set(['SIGABRT', 'SIGSEGV', 'SIGKILL', 'SIGTERM', 'SIGTRAP', 'SIGILL', 'SIGBUS', 'SIGHUP', 'SIGINT', 'OTHER']);
const STATES = new Set(['not_started', 'spawn_failed', 'running', 'exited', 'started_unknown']);
const STDERR_CLASSES = Object.freeze({
  fuseAccess: /(?:fuse:\s*(?:device not found|failed to open|failed to access)|fusermount3?:.*failed to open \/dev\/fuse|\/dev\/fuse: (?:permission denied|operation not permitted))/iu,
  fuseMount: /(?:fuse:\s*mount failed|fusermount3?:.*(?:mount failed|failed to mount)|cannot mount AppImage)/iu,
  namespaceDenial: /(?:failed to move to new namespace|failed to unshare.*(?:operation not permitted|permission denied)|namespace.*(?:operation not permitted|permission denied))/iu,
  sandboxHelper: /(?:SUID sandbox helper binary|setuid_sandbox_host|chrome-sandbox.*(?:not configured correctly|setuid|4755))/iu,
  sandboxUnavailable: /No usable sandbox!/u,
  sharedLibrary: /(?:error while loading shared libraries:|dlopen\(\).*libfuse|libfuse\.so\.2.*cannot open shared object file)/iu,
});
const STDERR_FIELDS = [...Object.keys(STDERR_CLASSES), 'unknown', 'truncated'];
const MOUNT_FIELDS = ['state', 'type', 'uid', 'readOnly', 'nosuid', 'nodev', 'noexec'];
const MOUNT_TYPES = new Set(['squashfuse', 'appimage', 'fuse']);
const emptyMount = state => ({ state, type: null, uid: null, readOnly: null, nosuid: null, nodev: null, noexec: null });
const closed = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function validateLinuxStartupMount(value) {
  if (!closed(value, MOUNT_FIELDS)) return null;
  if (value.state === 'observed') {
    if (!MOUNT_TYPES.has(value.type) || value.uid !== 1000
      || ['readOnly', 'nosuid', 'nodev', 'noexec'].some(key => typeof value[key] !== 'boolean')) return null;
    return Object.fromEntries(MOUNT_FIELDS.map(key => [key, value[key]]));
  }
  return ['not_sampled', 'unavailable', 'not_observed', 'ambiguous'].includes(value.state)
    && MOUNT_FIELDS.slice(1).every(key => value[key] === null) ? emptyMount(value.state) : null;
}
export function validateLinuxStartupDiagnostic(value) {
  if (!closed(value, ['schemaVersion', 'process', 'stderr', 'fuseMount']) || value.schemaVersion !== LINUX_STARTUP_DIAGNOSTIC_SCHEMA
    || !closed(value.process, ['state', 'spawnErrno', 'exitCode', 'signal', 'aliveBeforeCleanup'])
    || !STATES.has(value.process.state) || value.process.spawnErrno !== null && !ERRNOS.has(value.process.spawnErrno)
    || value.process.exitCode !== null && value.process.exitCode !== 'other'
      && (!Number.isInteger(value.process.exitCode) || value.process.exitCode < 0 || value.process.exitCode > 255)
    || value.process.signal !== null && !SIGNALS.has(value.process.signal)
    || value.process.aliveBeforeCleanup !== null && typeof value.process.aliveBeforeCleanup !== 'boolean'
    || !closed(value.stderr, STDERR_FIELDS) || STDERR_FIELDS.some(key => typeof value.stderr[key] !== 'boolean')) return null;
  const process = value.process;
  if (process.state === 'spawn_failed' ? process.spawnErrno === null || process.aliveBeforeCleanup !== false : process.spawnErrno !== null) return null;
  if (process.state === 'running' && (process.aliveBeforeCleanup !== true || process.exitCode !== null || process.signal !== null)
    || process.state === 'exited' && process.aliveBeforeCleanup !== false
    || process.state === 'not_started' && (process.aliveBeforeCleanup !== null || process.exitCode !== null || process.signal !== null)
    || process.state === 'started_unknown' && (process.aliveBeforeCleanup === true || process.exitCode !== null || process.signal !== null)) return null;
  const fuseMount = validateLinuxStartupMount(value.fuseMount);
  if (fuseMount === null) return null;
  return { schemaVersion: LINUX_STARTUP_DIAGNOSTIC_SCHEMA, process: { ...value.process },
    stderr: { ...value.stderr }, fuseMount };
}

/** Observe only the private launch directory and the fixed image's known FUSE
 * sources. 'not_observed' is a sampled absence, never proof no mount occurred. */
export function classifyLinuxStartupFuseMount(text) {
  if (typeof text !== 'string' || text.length > 256 * 1024) return emptyMount('unavailable');
  const matches = [];
  for (const line of text.split('\n')) {
    const [before, after, extra] = line.split(' - ');
    if (!after || extra !== undefined) continue;
    const fields = before.split(' '), filesystem = after.split(' ');
    if (!/^\/opt\/tibotattle-updater-exec\/tmp\/\.mount_[A-Za-z0-9._-]+$/u.test(fields[4] ?? '') || fields[3] !== '/') continue;
    const type = filesystem[0] === 'fuse.squashfuse' && filesystem[1] === 'squashfuse' ? 'squashfuse'
      : ['fuse.TiboTattle.AppImage', 'fuse'].includes(filesystem[0])
        && ['/opt/tibotattle-updater-exec/TiboTattle.AppImage', 'TiboTattle.AppImage'].includes(filesystem[1])
        ? filesystem[0] === 'fuse' ? 'fuse' : 'appimage' : null;
    const options = (fields[5] ?? '').split(','), superOptions = (filesystem[2] ?? '').split(',');
    if (type === null || !superOptions.includes('user_id=1000')) continue;
    matches.push({ state: 'observed', type, uid: 1000, readOnly: options.includes('ro'),
      nosuid: options.includes('nosuid'), nodev: options.includes('nodev'), noexec: options.includes('noexec') });
  }
  return matches.length === 1 ? matches[0] : emptyMount(matches.length ? 'ambiguous' : 'not_observed');
}
export async function sampleLinuxStartupFuseMount() {
  const handle = await open('/proc/self/mountinfo', 'r');
  try {
    const bytes = Buffer.alloc(256 * 1024 + 1); let count = 0;
    while (count < bytes.length) {
      const next = await handle.read(bytes, count, bytes.length - count, count);
      if (next.bytesRead === 0) break;
      count += next.bytesRead;
    }
    return count > 256 * 1024 ? emptyMount('unavailable') : classifyLinuxStartupFuseMount(bytes.subarray(0, count).toString('utf8'));
  } finally { await handle.close(); }
}
function childAlive(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) return null;
  try { process.kill(child.pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
}

export function createLinuxStartupDiagnostics({ child, sampleMount = null, readAlive = childAlive,
  schedule = setInterval, cancel = clearInterval } = {}) {
  const stderr = Object.fromEntries(STDERR_FIELDS.map(key => [key, false]));
  let pending = '', pendingBytes = 0, discarding = false, consumed = 0, spawnErrno = null, exitObserved = false;
  let exitCode = null, signal = null, fuseMount = emptyMount('not_sampled');
  let interval, inFlight = null, stopped = false, result = null;
  const onError = error => { spawnErrno = ERRNOS.has(error?.code) ? error.code : 'UNKNOWN'; };
  const onExit = (code, observedSignal) => { exitObserved = true; exitCode = code; signal = observedSignal; };
  child.on('error', onError); child.on('exit', onExit);
  function line(text) {
    if (!text.trim()) return;
    let classified = false;
    for (const [key, pattern] of Object.entries(STDERR_CLASSES)) {
      if (pattern.test(text)) { stderr[key] = true; classified = true; }
    }
    if (!classified) stderr.unknown = true;
  }
  function feed(chunk) {
    if (stopped) return;
    if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') { stderr.unknown = true; return; }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.slice(0, 64 * 1024 + 1));
    const remaining = Math.max(0, 64 * 1024 - consumed);
    if (bytes.length > remaining) stderr.truncated = true;
    const text = bytes.subarray(0, remaining).toString('utf8'); consumed += Math.min(bytes.length, remaining);
    for (const character of text) {
      if (character === '\n') { if (!discarding) line(pending); pending = ''; pendingBytes = 0; discarding = false; }
      else if (!discarding) {
        const size = Buffer.byteLength(character);
        if (pendingBytes + size > 2048) { pending = ''; pendingBytes = 0; discarding = true; stderr.unknown = true; stderr.truncated = true; }
        else { pending += character; pendingBytes += size; }
      }
    }
  }
  async function sample() {
    let timeout;
    try {
      const value = await Promise.race([Promise.resolve().then(sampleMount), new Promise(resolve => {
        timeout = setTimeout(() => resolve(emptyMount('unavailable')), 250);
      })]);
      const next = validateLinuxStartupMount(value) ?? emptyMount('unavailable');
      if (fuseMount.state === 'ambiguous') return;
      if (next.state === 'ambiguous' || fuseMount.state !== 'observed') fuseMount = next;
      else if (next.state === 'observed' && JSON.stringify(next) !== JSON.stringify(fuseMount)) fuseMount = emptyMount('ambiguous');
    } catch { if (fuseMount.state === 'not_sampled') fuseMount = emptyMount('unavailable'); }
    finally { clearTimeout(timeout); }
  }
  if (sampleMount !== null) {
    inFlight = sample().finally(() => { inFlight = null; });
    try {
      interval = schedule(() => {
        if (stopped || inFlight !== null) return;
        inFlight = sample().finally(() => { inFlight = null; });
      }, 200);
      interval?.unref?.();
    } catch { /* A diagnostic timer cannot change qualification. */ }
  }
  return Object.freeze({ feed,
    async stop() {
      if (stopped) return result;
      stopped = true;
      try { if (interval !== undefined) cancel(interval); } catch { /* Diagnostic only. */ }
      child.removeListener('error', onError); child.removeListener('exit', onExit);
      if (!discarding) line(pending); pending = '';
      const code = child.exitCode ?? exitCode, observedSignal = child.signalCode ?? signal;
      const exited = exitObserved || code !== null || observedSignal !== null;
      let alive = null;
      if (exited || spawnErrno !== null) alive = false;
      else if (Number.isSafeInteger(child.pid) && child.pid > 0) {
        try { alive = readAlive(child); } catch { /* Unavailable stays explicit. */ }
      }
      const process = { state: spawnErrno !== null ? 'spawn_failed' : exited ? 'exited'
        : Number.isSafeInteger(child.pid) && child.pid > 0 ? alive === true ? 'running' : 'started_unknown' : 'not_started',
      spawnErrno, exitCode: code === null ? null : Number.isInteger(code) && code >= 0 && code <= 255 ? code : 'other',
      signal: observedSignal === null ? null : SIGNALS.has(observedSignal) ? observedSignal : 'OTHER',
      aliveBeforeCleanup: typeof alive === 'boolean' ? alive : null };
      await inFlight;
      result = validateLinuxStartupDiagnostic({ schemaVersion: LINUX_STARTUP_DIAGNOSTIC_SCHEMA, process, stderr, fuseMount });
      return result;
    },
  });
}
