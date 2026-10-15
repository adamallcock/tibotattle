import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DESKTOP_STARTUP_DIAGNOSTIC_FILE, DESKTOP_STARTUP_DIAGNOSTIC_SCHEMA } from "../../apps/electron/desktop-startup-diagnostics.js";

const fail = (suffix) => { throw Object.assign(new Error(`LINUX_SUCCESSOR_${suffix}`), { code: `LINUX_SUCCESSOR_${suffix}` }); };
const uid = () => typeof process.getuid === "function" ? process.getuid() : fail("OWNER_UNAVAILABLE");
const stamp = (s) => [s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":");
const objectStamp = (s) => `${s.dev}:${s.ino}:${s.mode}:${s.uid}`;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const fields = ["schemaVersion", "recordedAt", "startedAt", "phase", "outcome", "code", "platform", "architecture", "version"].sort();
const phases = new Set(["bootstrap", "package_metadata", "profile_selection", "crash_capture", "runtime_qualification", "platform_gate", "runtime_paths", "credential_wiring", "app_ready", "native_handover", "installation_state", "first_run", "secure_storage", "runtime_services", "settings", "lifecycle", "updater", "ready"]);

export function sameLinuxProcessIdentity(a, b) {
  return Number.isSafeInteger(a?.pid) && a.pid > 0 && typeof a.startTime === "string" && /^\d+$/u.test(a.startTime)
    && typeof a.executable === "string" && a.executable.startsWith("/")
    && a.pid === b?.pid && a.startTime === b.startTime && a.executable === b.executable;
}
async function assertIdentity(identity, readIdentity) {
  try { if (typeof readIdentity !== "function" || !sameLinuxProcessIdentity(identity, await readIdentity(identity.pid))) fail("IDENTITY_CHANGED"); }
  catch { fail("IDENTITY_CHANGED"); }
}
async function ownedDirectory(path) {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(uid()) || (stat.mode & 0o7777n) !== 0o700n
      || await realpath(path) !== path) fail("DIAGNOSTIC_UNTRUSTED");
  return objectStamp(stat);
}
function parseRecord(bytes) {
  let record;
  try { record = JSON.parse(bytes.toString("utf8")); } catch { fail("DIAGNOSTIC_INVALID"); }
  if (!record || Array.isArray(record) || Object.keys(record).sort().join() !== fields.join()
      || record.schemaVersion !== DESKTOP_STARTUP_DIAGNOSTIC_SCHEMA || record.platform !== "linux" || record.architecture !== "x64"
      || typeof record.version !== "string" || !/^[A-Za-z0-9._+-]{1,80}$/u.test(record.version) || !phases.has(record.phase)
      || !["in_progress", "ready"].includes(record.outcome) || record.code !== null
      || (record.outcome === "ready") !== (record.phase === "ready")) fail("DIAGNOSTIC_INVALID");
  for (const key of ["startedAt", "recordedAt"]) {
    const value = Date.parse(record[key]);
    if (!Number.isFinite(value) || new Date(value).toISOString() !== record[key]) fail("DIAGNOSTIC_INVALID");
  }
  if (Date.parse(record.startedAt) > Date.parse(record.recordedAt)) fail("DIAGNOSTIC_INVALID");
  return record;
}
async function readStartup(userData, expectedDirectories = null) {
  if (typeof userData !== "string" || resolve(userData) !== userData) fail("DIAGNOSTIC_UNTRUSTED");
  const directory = join(userData, "startup-diagnostics");
  let handle;
  try {
    const directories = [await ownedDirectory(userData), await ownedDirectory(directory)];
    if (expectedDirectories && directories.join() !== expectedDirectories.join()) fail("DIAGNOSTIC_CHANGED");
    const path = join(directory, DESKTOP_STARTUP_DIAGNOSTIC_FILE);
    const before = await lstat(path, { bigint: true });
    const valid = (s) => s.isFile() && !s.isSymbolicLink() && s.uid === BigInt(uid()) && (s.mode & 0o7777n) === 0o600n && s.nlink === 1n && s.size > 0n && s.size <= 4096n;
    if (!valid(before)) fail("DIAGNOSTIC_UNTRUSTED");
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) fail("DIAGNOSTIC_CHANGED");
    const bytes = Buffer.alloc(4097);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    if (BigInt(size) !== before.size || stamp(await handle.stat({ bigint: true })) !== stamp(before) || stamp(await lstat(path, { bigint: true })) !== stamp(before)
        || await ownedDirectory(userData) !== directories[0] || await ownedDirectory(directory) !== directories[1]) fail("DIAGNOSTIC_CHANGED");
    const content = bytes.subarray(0, size).toString("utf8");
    return { directories, fileIdentity: `${before.dev}:${before.ino}`, content, record: parseRecord(bytes.subarray(0, size)) };
  } catch (error) {
    if (error.code?.startsWith("LINUX_SUCCESSOR_")) throw error;
    fail("DIAGNOSTIC_UNTRUSTED");
  } finally { await handle?.close().catch(() => {}); }
}

/** Baseline remains private to this invocation; only fixed proof labels are exported. */
export async function captureLinuxStartupBaseline({ userData }) {
  return readStartup(userData);
}

/** The journal proves a new dedicated-profile generation, not which PID wrote it or API health. */
export async function waitForLinuxSuccessorStartup({ identity, readIdentity, userData, baseline, version, notBefore,
  timeoutMs = 60_000, now = Date.now, sleep = pause }) {
  if (!baseline?.fileIdentity || !baseline.directories || !Number.isSafeInteger(notBefore)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || notBefore > now()) fail("DIAGNOSTIC_INVALID");
  const deadline = now() + timeoutMs;
  do {
    await assertIdentity(identity, readIdentity);
    const current = await readStartup(userData, baseline.directories);
    await assertIdentity(identity, readIdentity);
    if (current.fileIdentity !== baseline.fileIdentity) {
      const record = current.record;
      if (record.version !== version || Date.parse(record.startedAt) < notBefore || Date.parse(record.recordedAt) > now()
          || current.content === baseline.content) fail("DIAGNOSTIC_STALE");
      if (record.outcome === "ready") return { outcome: "ready", attribution: "dedicated_profile_generation" };
    } else if (current.content !== baseline.content) fail("DIAGNOSTIC_CHANGED");
    if (now() >= deadline) break;
    await sleep(Math.min(100, deadline - now()));
  } while (now() <= deadline);
  fail("DIAGNOSTIC_TIMEOUT");
}

async function boundedProcRead(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1); let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, null);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    if (size === bytes.length) fail("CDP_UNTRUSTED");
    return bytes.subarray(0, size).toString("utf8");
  } finally { await handle.close(); }
}
async function listeners(port, read) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) fail("CDP_UNTRUSTED");
  const selected = [];
  for (const family of ["tcp", "tcp6"]) {
    const rows = (await read(`/proc/net/${family}`)).trim().split("\n");
    if (rows.length > 8193 || !rows[0]?.includes("local_address")) fail("CDP_UNTRUSTED");
    for (const row of rows.slice(1)) {
      const columns = row.trim().split(/\s+/u);
      if (columns.length < 10 || !/^[0-9A-F]+:[0-9A-F]{4}$/iu.test(columns[1]) || !/^[0-9A-F]{2}$/iu.test(columns[3])) fail("CDP_UNTRUSTED");
      const [address, hexPort] = columns[1].split(":");
      if (Number.parseInt(hexPort, 16) === port && columns[3].toUpperCase() === "0A") selected.push({ family, address, owner: columns[7], inode: columns[9] });
    }
  }
  return selected;
}
export async function assertLinuxCdpPortUnused({ port, read = boundedProcRead }) {
  try { if ((await listeners(port, read)).length !== 0) fail("CDP_PREEXISTING"); return true; }
  catch (error) { if (error.code?.startsWith("LINUX_SUCCESSOR_")) throw error; fail("CDP_UNTRUSTED"); }
}

/** No request is sent until the exact selected process owns the sole IPv4 loopback listener. */
export async function assertLinuxCdpEndpointOwned({ identity, readIdentity, port, binding = {}, read = boundedProcRead, list = readdir, link = readlink }) {
  try {
    await assertIdentity(identity, readIdentity);
    const rows = await listeners(port, read);
    if (rows.length === 0) fail(binding.socketIdentity === undefined ? "CDP_NOT_READY" : "CDP_UNTRUSTED");
    const socket = rows[0];
    if (rows.length !== 1 || socket.family !== "tcp" || socket.address !== "0100007F" || socket.owner !== String(uid()) || !/^[1-9]\d*$/u.test(socket.inode)) fail("CDP_UNTRUSTED");
    const socketIdentity = `${identity.pid}:${identity.startTime}:${port}:${socket.inode}`;
    if (binding.socketIdentity !== undefined && binding.socketIdentity !== socketIdentity) fail("CDP_UNTRUSTED");
    const owned = async () => {
      const fds = await list(`/proc/${identity.pid}/fd`);
      if (fds.length > 4096 || fds.some((fd) => !/^\d+$/u.test(fd))) fail("CDP_UNTRUSTED");
      let matches = 0;
      for (const fd of fds) {
        let target;
        try { target = await link(`/proc/${identity.pid}/fd/${fd}`); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (target === `socket:[${socket.inode}]`) matches++;
      }
      return matches === 1;
    };
    if (!await owned() || JSON.stringify(await listeners(port, read)) !== JSON.stringify(rows) || !await owned()) fail("CDP_UNTRUSTED");
    await assertIdentity(identity, readIdentity);
    // Identity readers may hash large artifacts. Reobserve the listener after
    // that await, and arbitrate concurrent first admissions before publishing.
    if (JSON.stringify(await listeners(port, read)) !== JSON.stringify(rows) || !await owned()
        || (binding.socketIdentity !== undefined && binding.socketIdentity !== socketIdentity)) fail("CDP_UNTRUSTED");
    binding.socketIdentity = socketIdentity;
    return true;
  } catch (error) { if (error.code?.startsWith("LINUX_SUCCESSOR_")) throw error; fail("CDP_UNTRUSTED"); }
}

/** Chromium can expose one space-joined process title instead of NUL argv.
 * This parser only excludes child roles and checks renderer sandbox flags;
 * it never admits a browser without the separate exact launch and artifact proof. */
export function linuxProcessCommandLineFacts({ commandLine, executable }, observeRefusal = null) {
  const refuse = code => { observeRefusal?.(code); return null; };
  if (typeof commandLine !== 'string') return refuse('PROCESS_COMMAND_LINE_TYPE_INVALID');
  if (commandLine.length > 65536) return refuse('PROCESS_COMMAND_LINE_TOO_LONG');
  if (!commandLine.endsWith('\0')) return refuse('PROCESS_COMMAND_LINE_TERMINATOR_MISSING');
  if (typeof executable !== 'string' || executable.length === 0 || /[\s\0]/u.test(executable)) return refuse('PROCESS_EXECUTABLE_FORM_INVALID');
  const fields = commandLine.slice(0, -1).split('\0');
  let encodedArguments, boundary;
  if (fields.length > 1 || fields[0] === executable) {
    if (fields[0] !== executable) return refuse('PROCESS_ARGV_ZERO_MISMATCH');
    const invalidField = fields.find(field => field.length === 0 || /\s/u.test(field));
    if (invalidField !== undefined) return refuse(invalidField.length === 0 ? 'PROCESS_ARGV_EMPTY_FIELD' : 'PROCESS_ARGV_WHITESPACE');
    encodedArguments = fields.slice(1).join('\0'); boundary = '\\0';
  } else {
    if (!fields[0].startsWith(`${executable} `)) return refuse('PROCESS_TITLE_PREFIX_MISMATCH');
    encodedArguments = fields[0].slice(executable.length + 1); boundary = ' ';
    if (encodedArguments.length === 0 || /[^\S ]/u.test(encodedArguments)
      || encodedArguments.startsWith(' ') || encodedArguments.endsWith(' ') || encodedArguments.includes('  ')) return refuse('PROCESS_TITLE_SPACING_INVALID');
  }
  const roles = [...encodedArguments.matchAll(new RegExp(`(?:^|${boundary})--type=([^${boundary}]*)(?=${boundary}|$)`, 'gu'))];
  if (roles.length > 1) return refuse('PROCESS_ROLE_MULTIPLE');
  // Chromium 150 sandbox_linux.cc rewrites forked broker titles to these
  // exact child roles. They may exclude a browser candidate only after the
  // complete grammar below; they never satisfy the exact renderer predicate.
  if (roles.length === 1 && !['renderer', 'zygote', 'gpu-process', 'utility',
    'broker', 'renderer-broker', 'zygote-broker', 'gpu-process-broker', 'utility-broker'].includes(roles[0][1])) {
    if (roles[0][1] === '') return refuse('PROCESS_ROLE_EMPTY');
    return refuse('PROCESS_ROLE_UNKNOWN');
  }
  if (new RegExp(`(?:^|${boundary})--type(?=${boundary}|$)`, 'u').test(encodedArguments)) return refuse('PROCESS_ROLE_BARE');
  const sandboxBypass = new RegExp(`(?:^|${boundary})--(?:no-sandbox|disable-setuid-sandbox)(?:=|${boundary}|$)`, 'u').test(encodedArguments);
  return { role: roles[0]?.[1] ?? null, sandboxBypass };
}
